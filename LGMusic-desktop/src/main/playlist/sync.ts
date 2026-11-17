/**
 * 歌单云同步引擎（变更队列 + 冲突处理 + 本地/云端互推）。
 * 逻辑忠实还原自青听 v1.0.3 桌面端主进程（zi 类）。
 */
import type { AccountClient } from '../account/client'
import type { PlaylistLibrary, Playlist } from './library'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

const DEBOUNCE_MS = 1500
const MAX_SYNC_ROUNDS = 1000

export class PlaylistSyncError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PlaylistSyncError'
    this.code = code
  }
}

export interface PlaylistSyncState {
  phase: 'idle' | 'initializing' | 'syncing' | 'success' | 'error'
  pendingMutationCount: number
  lastSuccessfulAt: string | null
  message?: string
  completedAt?: number
}

interface SyncMutation {
  queueVersion: number
  origin: string
  clientMutationId: string
  operation: string
  playlistId: string
  expectedRevision?: number
  playlist?: Record<string, unknown>
  tracks?: Array<Record<string, unknown>>
  trackIds?: string[]
  orderedTrackIds?: string[]
  createdAt?: number
}

export class PlaylistSyncEngine {
  private library: PlaylistLibrary
  private account: AccountClient
  private userId: string | null = null
  private enabled = false
  private autoSyncEnabled = true
  private generation = 0
  private debounceTimer: NodeJS.Timeout | null = null
  private syncing = false
  private syncRequested = false
  private syncState: PlaylistSyncState = {
    phase: 'idle',
    pendingMutationCount: 0,
    lastSuccessfulAt: null
  }
  private remotePlaylistCount: number | null = null
  private remoteTrackCount: number | null = null
  private stateListeners = new Set<(state: PlaylistSyncState) => void>()
  private libraryChangedListener: (() => void) | null = null
  private guestImportPromptHandler: ((count: number) => Promise<boolean>) | null = null

  constructor(library: PlaylistLibrary, account: AccountClient) {
    this.library = library
    this.account = account
  }

  setLibraryChangedListener(listener: (() => void) | null): void {
    this.libraryChangedListener = listener
  }

  setGuestImportPromptHandler(handler: ((count: number) => Promise<boolean>) | null): void {
    this.guestImportPromptHandler = handler
  }

  subscribeState(listener: (state: PlaylistSyncState) => void): () => void {
    this.stateListeners.add(listener)
    listener(this.getState())
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  getState(): PlaylistSyncState {
    const pending = this.getPendingMutationCount()
    return { ...this.syncState, pendingMutationCount: pending }
  }

  async getStatus(): Promise<Record<string, unknown>> {
    const userId = this.library.getActiveUserId()
    const snapshot = this.library.getSnapshot()
    const syncData = userId ? this.library.getAccountSyncData(userId) : null
    let remoteStatus: Record<string, unknown> | null = null
    if (userId && this.enabled) {
      try {
        remoteStatus = (await this.account.getPlaylistStatus()) as Record<string, unknown>
        this.remotePlaylistCount = remoteStatus.playlistCount as number
        this.remoteTrackCount = remoteStatus.trackCount as number
      } catch (err) {
        console.warn('[playlist-sync] 获取云端歌单状态失败:', err)
      }
    }
    const customCount = snapshot.playlists.filter((p) => p.type === 'custom').length
    const importedCount = snapshot.playlists.filter((p) => p.type === 'imported').length
    const lastSuccessfulAt =
      remoteStatus?.lastSyncedAt ?? syncData?.lastSuccessfulAt ?? this.syncState.lastSuccessfulAt ?? null
    return {
      state: { ...this.getState(), lastSuccessfulAt },
      localPlaylistCount: snapshot.playlists.length,
      localCustomPlaylistCount: customCount,
      localImportedPlaylistCount: importedCount,
      localTrackCount: snapshot.playlists.reduce((acc, p) => acc + p.tracks.length, 0),
      pendingMutationCount: syncData?.queue.length ?? 0,
      remotePlaylistCount: remoteStatus?.playlistCount ?? this.remotePlaylistCount,
      remoteTrackCount: remoteStatus?.trackCount ?? this.remoteTrackCount,
      lastSuccessfulAt
    }
  }

  activate(userId: string, options: { enabled?: boolean; autoSyncEnabled?: boolean } = {}): void {
    const id = userId.trim()
    if (!id) {
      this.stop()
      return
    }
    const enabled = options.enabled !== false
    const autoSync = options.autoSyncEnabled !== false
    if (this.userId === id && this.enabled === enabled && this.autoSyncEnabled === autoSync) return
    const resumeAuto = this.userId === id && this.enabled === enabled && !this.autoSyncEnabled && autoSync
    this.stop(false)
    this.userId = id
    this.enabled = enabled
    this.autoSyncEnabled = autoSync
    const generation = this.generation
    this.setSyncState({ phase: enabled ? 'initializing' : 'idle' })
    if (!enabled) {
      this.setSyncState({ phase: 'idle' })
      return
    }
    if (!autoSync && !resumeAuto) {
      this.setSyncState({ phase: 'idle' })
      return
    }
    this.initialize(id, generation).catch((err) => {
      if (this.userId !== id || this.generation !== generation) return
      this.setSyncError(err)
      console.warn('[playlist-sync] 初始化失败，保留本地队列等待重试:', err)
    })
  }

  stop(clearState = true): void {
    this.generation += 1
    this.clearDebounceTimer()
    this.userId = null
    this.enabled = false
    this.autoSyncEnabled = true
    this.syncing = false
    this.syncRequested = false
    this.remotePlaylistCount = null
    this.remoteTrackCount = null
    if (clearState) this.setSyncState({ phase: 'idle', lastSuccessfulAt: null })
  }

  notifyLocalChange(): void {
    const userId = this.userId
    const pending = this.getPendingMutationCount()
    this.publishState({ pendingMutationCount: pending })
    if (!userId || !this.enabled || !this.autoSyncEnabled || this.library.getActiveUserId() !== userId) return
    this.clearDebounceTimer()
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.syncNow('local-change').catch((err) => {
        console.warn('[playlist-sync] 本地变化同步失败:', err)
      })
    }, DEBOUNCE_MS)
  }

  resumeAfterNetworkRecovery(): void {
    const userId = this.userId
    if (!userId || !this.enabled || !this.autoSyncEnabled) return
    if (this.syncing) {
      this.syncRequested = true
      return
    }
    const generation = this.generation
    this.mergeRemoteSnapshot(userId, generation)
      .then(() => {
        if (this.userId === userId && this.generation === generation) return this.syncNow('follow-up')
      })
      .catch((err) => {
        if (this.userId === userId && this.generation === generation) this.setSyncError(err)
      })
  }

  async retry(): Promise<Record<string, unknown>> {
    const userId = this.requireActiveUser()
    const generation = this.generation
    this.setSyncState({ phase: 'initializing' })
    try {
      await this.mergeRemoteSnapshot(userId, generation)
      if (this.userId !== userId || this.generation !== generation) {
        throw new PlaylistSyncError('PLAYLIST_SYNC_IDENTITY_CHANGED', '账号已切换，当前同步已取消')
      }
      await this.syncNow('manual-retry')
      return this.getStatus()
    } catch (err) {
      this.setSyncError(err)
      throw err
    }
  }

  async pushLocalToCloud(): Promise<Record<string, unknown>> {
    return this.runOverwrite(async (userId) => {
      const playlists = this.library.getSnapshot().playlists
      const result = (await this.account.overwritePlaylists(playlists as unknown as Array<Record<string, unknown>>)) as Record<string, unknown>
      if (this.userId !== userId || this.library.getActiveUserId() !== userId) {
        throw new PlaylistSyncError('PLAYLIST_SYNC_IDENTITY_CHANGED', '账号已切换，当前同步已取消')
      }
      this.library.updateAccountSyncState(userId, {
        playlists: result.playlists as Playlist[],
        queue: [],
        cursor: result.cursor as number
      })
      this.remotePlaylistCount = (result.playlists as unknown[]).length
      this.remoteTrackCount = (result.playlists as Playlist[]).reduce((acc, p) => acc + p.tracks.length, 0)
      this.emitLibraryChanged()
      return this.getStatus()
    })
  }

  async pullCloudToLocal(): Promise<Record<string, unknown>> {
    return this.runOverwrite(async (userId) => {
      const snapshot = (await this.account.getPlaylistSnapshot()) as Record<string, unknown>
      if (this.userId !== userId || this.library.getActiveUserId() !== userId) {
        throw new PlaylistSyncError('PLAYLIST_SYNC_IDENTITY_CHANGED', '账号已切换，当前同步已取消')
      }
      this.library.updateAccountSyncState(userId, {
        playlists: snapshot.playlists as Playlist[],
        queue: [],
        cursor: snapshot.cursor as number
      })
      this.remotePlaylistCount = (snapshot.playlists as unknown[]).length
      this.remoteTrackCount = (snapshot.playlists as Playlist[]).reduce((acc, p) => acc + p.tracks.length, 0)
      this.emitLibraryChanged()
      return this.getStatus()
    })
  }

  private async initialize(userId: string, generation: number): Promise<void> {
    if (!this.autoSyncEnabled) {
      this.setSyncState({ phase: 'idle' })
      return
    }
    await this.mergeRemoteSnapshot(userId, generation)
    if (this.userId !== userId || this.generation !== generation) return
    await this.syncNow('login')
  }

  private async runOverwrite(fn: (userId: string) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const userId = this.requireActiveUser()
    if (this.syncing) throw new PlaylistSyncError('PLAYLIST_SYNC_BUSY', '同步正在进行中，请稍后再试')
    this.syncing = true
    this.setSyncState({ phase: 'syncing' })
    try {
      const result = await fn(userId)
      this.setSyncSuccess()
      return result
    } catch (err) {
      this.setSyncError(err)
      throw err
    } finally {
      this.syncing = false
      this.syncRequested = false
    }
  }

  private requireActiveUser(): string {
    if (!this.userId || !this.enabled) {
      throw new PlaylistSyncError('PLAYLIST_SYNC_UNAVAILABLE', '请先登录并开启云端同步')
    }
    if (this.library.getActiveUserId() !== this.userId) {
      throw new PlaylistSyncError('PLAYLIST_SYNC_IDENTITY_CHANGED', '账号已切换，请重新打开云同步设置')
    }
    return this.userId
  }

  private async mergeRemoteSnapshot(userId: string, generation: number): Promise<void> {
    const snapshot = (await this.account.getPlaylistSnapshot()) as {
      playlists: Playlist[]
      cursor: number
    }
    if (this.userId !== userId || this.generation !== generation) return
    let syncData = this.library.getAccountSyncData(userId)
    const guestPlaylists = this.library.getGuestPlaylists()
    if (snapshot.playlists.length === 0 && guestPlaylists.length > 0 && syncData.queue.length === 0) {
      const confirmed = await this.confirmGuestPlaylistImport(guestPlaylists.length)
      if (this.userId !== userId || this.generation !== generation) return
      if (confirmed) this.library.enqueueGuestPlaylistImport(userId, guestPlaylists)
      syncData = this.library.getAccountSyncData(userId)
    }
    const before = this.library.getSnapshot().playlists
    const merged = this.applyPendingMutations(snapshot.playlists, syncData.queue)
    this.library.updateAccountSyncState(userId, { playlists: merged, cursor: snapshot.cursor })
    this.remotePlaylistCount = snapshot.playlists.length
    this.remoteTrackCount = snapshot.playlists.reduce((acc, p) => acc + p.tracks.length, 0)
    this.emitLibraryChanged(before)
  }

  private applyPendingMutations(playlists: Playlist[], queue: Array<Record<string, unknown>>): Playlist[] {
    return queue.reduce(
      (acc, mutation) =>
        this.applyPlaylistOperation(acc, mutation.operation as string, mutation.playlistId as string, {
          playlist: mutation.playlist,
          tracks: mutation.tracks,
          trackIds: mutation.trackIds,
          orderedTrackIds: mutation.orderedTrackIds
        }),
      clone(playlists)
    )
  }

  private async syncNow(trigger: 'login' | 'manual-retry' | 'local-change' | 'follow-up'): Promise<void> {
    const userId = this.userId
    if (!userId || (!this.autoSyncEnabled && trigger !== 'manual-retry')) return
    if (this.syncing) {
      this.syncRequested = true
      return
    }
    this.syncing = true
    const generation = this.generation
    if ((trigger === 'login' || trigger === 'manual-retry') && this.syncState.phase !== 'initializing') {
      this.setSyncState({ phase: 'syncing' })
    }
    let succeeded = false
    let round = 0
    const conflictIds = new Set<string>()
    try {
      do {
        if (round >= MAX_SYNC_ROUNDS) {
          throw new PlaylistSyncError('PLAYLIST_SYNC_RETRY_LIMIT', '同步冲突未能自动解决，请稍后重试')
        }
        round += 1
        this.syncRequested = false
        if (this.userId !== userId || this.generation !== generation || this.library.getActiveUserId() !== userId) return
        const syncData = this.library.getAccountSyncData(userId)
        const result = (await this.account.syncPlaylists(syncData.cursor, syncData.queue)) as Record<string, unknown>
        if (this.userId !== userId || this.generation !== generation || this.library.getActiveUserId() !== userId) return
        const afterSync = this.library.getAccountSyncData(userId)
        const acceptedMutationIds = (result.acceptedMutationIds as string[]) || []
        const remoteChanges = (result.remoteChanges as Array<Record<string, unknown>>) || []
        const conflicts = (result.conflicts as Array<Record<string, unknown>>) || []
        if (
          afterSync.queue.length === 0 &&
          acceptedMutationIds.length === 0 &&
          remoteChanges.length === 0 &&
          conflicts.length === 0 &&
          result.cursor === syncData.cursor
        ) {
          continue
        }
        const acceptedSet = new Set(acceptedMutationIds)
        const conflictByPlaylist = new Map<string, Record<string, unknown>>(
          conflicts.map((c) => [c.playlistId as string, c])
        )
        const sentIds = new Set(syncData.queue.slice(0, 100).map((m) => m.clientMutationId as string))
        let queue = afterSync.queue.filter((m) => {
          const mutation = m as SyncMutation
          if (acceptedSet.has(mutation.clientMutationId)) return false
          const conflict = conflictByPlaylist.get(mutation.playlistId)
          return !sentIds.has(mutation.clientMutationId) || !conflict
            ? true
            : conflict.reason === 'REVISION_MISMATCH' ||
              conflict.reason === 'APPLY_FAILED' ||
              (conflict.reason === 'PLAYLIST_DELETED' && mutation.origin === 'guest-import')
        })
        const acceptedRevisions = (result.acceptedRevisions as Record<string, number>) ?? {}
        let playlists = afterSync.playlists.map((p) => ({
          ...p,
          revision: acceptedRevisions[p.id] ?? p.revision
        }))
        queue = queue.map((m) => {
          const mutation = m as SyncMutation
          const revision = acceptedRevisions[mutation.playlistId]
          if (revision !== undefined && mutation.expectedRevision !== undefined) {
            return { ...mutation, expectedRevision: revision }
          }
          const conflict = conflictByPlaylist.get(mutation.playlistId)
          const conflictRevision = conflict?.playlist
            ? (conflict.playlist as Record<string, unknown>).revision
            : undefined
          return conflict?.reason === 'REVISION_MISMATCH' && conflictRevision !== undefined
            ? { ...mutation, expectedRevision: conflictRevision }
            : mutation
        })
        const pendingIds = new Set(queue.map((m) => (m as SyncMutation).playlistId))
        let merged = this.applyRemoteChanges(playlists, remoteChanges, pendingIds)
        conflicts.forEach((conflict) => {
          if (conflict.reason === 'PLAYLIST_NOT_FOUND' || conflict.reason === 'PLAYLIST_DELETED') {
            merged = merged.filter((p) => p.id !== conflict.playlistId)
            return
          }
          if (conflict.playlist && !pendingIds.has(conflict.playlistId as string)) {
            merged = this.upsertSnapshot(merged, clone(conflict.playlist) as unknown as Playlist)
          }
        })
        ;((result.resolvedDeletedPlaylistIds as string[]) ?? []).forEach((id) => {
          if (!pendingIds.has(id)) merged = merged.filter((p) => p.id !== id)
        })
        ;((result.resolvedPlaylists as Playlist[]) ?? []).forEach((playlist) => {
          if (!pendingIds.has(playlist.id)) merged = this.upsertSnapshot(merged, clone(playlist))
        })
        this.library.updateAccountSyncState(userId, {
          playlists: merged,
          queue: queue as Array<Record<string, unknown>>,
          cursor: result.cursor as number
        })
        this.remotePlaylistCount = merged.length
        this.remoteTrackCount = merged.reduce((acc, p) => acc + p.tracks.length, 0)
        this.emitLibraryChanged(afterSync.playlists)
        if (conflicts.length > 0) {
          const counts = conflicts.reduce((acc, c) => {
            acc[c.reason as string] = ((acc[c.reason as string] as number) ?? 0) + 1
            return acc
          }, {} as Record<string, number>)
          console.warn('[playlist-sync] 同步冲突:', counts)
        }
        const hardConflictIds = new Set(
          conflicts
            .filter(
              (c) =>
                c.reason === 'APPLY_FAILED' ||
                (c.reason === 'PLAYLIST_DELETED' &&
                  queue.some(
                    (m) => (m as SyncMutation).playlistId === c.playlistId && (m as SyncMutation).origin === 'guest-import'
                  ))
            )
            .map((c) => c.playlistId as string)
        )
        hardConflictIds.forEach((id) => conflictIds.add(id))
        ;[...conflictIds].forEach((id) => {
          if (!queue.some((m) => (m as SyncMutation).playlistId === id)) conflictIds.delete(id)
        })
        if (queue.some((m) => !hardConflictIds.has((m as SyncMutation).playlistId))) {
          this.syncRequested = true
        }
      } while (this.syncRequested && this.userId === userId)
      succeeded = true
    } catch (err) {
      this.setSyncError(err)
      console.warn('[playlist-sync] 请求失败，将在下次启动或手动同步时重试:', err)
      if (trigger === 'manual-retry') throw err
    } finally {
      this.syncing = false
      if (succeeded && this.userId === userId) {
        if (conflictIds.size > 0) {
          this.setSyncError(
            new PlaylistSyncError(
              'PLAYLIST_SYNC_CONFLICT',
              `${conflictIds.size} 项歌单变更暂时无法同步，数据已保留在本机，可稍后重试`
            )
          )
        } else {
          this.setSyncSuccess()
        }
      }
      if (this.syncRequested && this.userId === userId) {
        this.syncNow('follow-up').catch((err) => {
          console.warn('[playlist-sync] 连续同步失败:', err)
        })
      }
    }
  }

  private applyRemoteChanges(
    playlists: Playlist[],
    changes: Array<Record<string, unknown>>,
    pendingIds: Set<string>
  ): Playlist[] {
    let current = playlists
    changes.forEach((change) => {
      if (pendingIds.has(change.playlistId as string)) return
      current = this.applyPlaylistOperation(
        current,
        change.operation as string,
        change.playlistId as string,
        change.payload as Record<string, unknown> | undefined
      )
    })
    return current
  }

  private applyPlaylistOperation(
    playlists: Playlist[],
    operation: string,
    playlistId: string,
    payload?: Record<string, unknown>
  ): Playlist[] {
    if (operation === 'DELETE_PLAYLIST') return playlists.filter((p) => p.id !== playlistId)
    if (!payload) return playlists
    if ('id' in payload && 'name' in payload && 'type' in payload && 'tracks' in payload) {
      return this.upsertSnapshot(playlists, clone(payload) as unknown as Playlist)
    }
    const existing = playlists.find((p) => p.id === playlistId)
    const meta = payload.playlist as Record<string, unknown> | undefined
    if (operation === 'UPSERT_PLAYLIST' && meta) {
      return this.upsertSnapshot(playlists, clone(meta) as unknown as Playlist)
    }
    if (!existing && !meta) return playlists
    const target: Playlist = existing
      ? ({ ...existing, ...(meta ?? {}), tracks: clone(existing.tracks) } as Playlist)
      : ({ ...(meta as unknown as Playlist), tracks: [] } as Playlist)
    let tracks = target.tracks
    if (operation === 'ADD_TRACKS') {
      const byId = new Map(tracks.map((t) => [t.id, t]))
      ;((payload.tracks as Playlist['tracks']) ?? []).forEach((t) => {
        byId.set(t.id, clone(t))
      })
      tracks = [...byId.values()].sort((a, b) => a.sortOrder - b.sortOrder)
    } else if (operation === 'REMOVE_TRACKS') {
      const removed = new Set((payload.trackIds as string[]) ?? [])
      tracks = tracks.filter((t) => !removed.has(t.id))
    } else if (operation === 'REPLACE_TRACKS') {
      tracks = clone((payload.tracks as Playlist['tracks']) ?? [])
    }
    if (operation === 'REORDER_TRACKS' || operation === 'REMOVE_TRACKS') {
      const orderIndex = new Map(
        ((payload.orderedTrackIds as string[]) ?? []).map((id, index) => [id, index])
      )
      tracks = tracks
        .map((t) => ({ ...t, sortOrder: orderIndex.get(t.id) ?? t.sortOrder }))
        .sort((a, b) => a.sortOrder - b.sortOrder)
    }
    return this.upsertSnapshot(playlists, { ...target, tracks } as Playlist)
  }

  private upsertSnapshot(playlists: Playlist[], playlist: Playlist): Playlist[] {
    return [...playlists.filter((p) => p.id !== playlist.id), clone(playlist)]
  }

  private confirmGuestPlaylistImport(count: number): Promise<boolean> {
    return this.guestImportPromptHandler ? this.guestImportPromptHandler(count) : Promise.resolve(false)
  }

  private setSyncState(patch: Partial<PlaylistSyncState>): void {
    this.syncState = { ...this.syncState, ...patch, pendingMutationCount: this.getPendingMutationCount() }
    this.publishState()
  }

  private publishState(patch: Partial<PlaylistSyncState> = {}): void {
    this.syncState = { ...this.syncState, ...patch, pendingMutationCount: this.getPendingMutationCount() }
    const state = this.getState()
    this.stateListeners.forEach((listener) => listener(state))
  }

  private setSyncError(err: unknown): void {
    this.setSyncState({
      phase: 'error',
      message: err instanceof Error ? err.message : '账号歌单同步失败'
    })
  }

  private setSyncSuccess(): void {
    const completedAt = Date.now()
    const lastSuccessfulAt = new Date(completedAt).toISOString()
    const userId = this.userId
    if (userId && this.library.getActiveUserId() === userId) {
      this.library.updateAccountSyncState(userId, { lastSuccessfulAt })
    }
    this.setSyncState({ phase: 'success', completedAt, lastSuccessfulAt, message: undefined })
  }

  private getPendingMutationCount(): number {
    const userId = this.userId ?? this.library.getActiveUserId()
    if (!userId) return 0
    try {
      return this.library.getAccountSyncData(userId).queue.length
    } catch {
      return 0
    }
  }

  private emitLibraryChanged(before?: Playlist[]): void {
    if (before && JSON.stringify(before) === JSON.stringify(this.library.getSnapshot().playlists)) return
    this.libraryChangedListener?.()
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }
}
