/**
 * 收藏云同步引擎（变更队列 + 冲突处理 + 本地/云端互推）。
 * 结构与歌单云同步一致，忠实还原自青听 v1.0.3 桌面端主进程（Yi 类）。
 */
import type { AccountClient } from '../account/client'
import { favoriteLibrary, favoriteToPayload, normalizeFavorite, type Favorite } from './library'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

const DEBOUNCE_MS = 1500
const MAX_SYNC_ROUNDS = 1000
const SYNC_BATCH_MAX = 100

export class FavoriteSyncError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'FavoriteSyncError'
    this.code = code
  }
}

export interface FavoriteSyncState {
  phase: 'idle' | 'initializing' | 'syncing' | 'success' | 'error'
  pendingMutationCount: number
  lastSuccessfulAt: string | null
  message?: string
  completedAt?: number
  remoteFavoriteCount?: number | null
}

interface FavoriteMutation {
  queueVersion: number
  origin: string
  clientMutationId: string
  operation: 'UPSERT_FAVORITE' | 'DELETE_FAVORITE'
  favoriteId: string
  expectedRevision?: number
  favorite?: Record<string, unknown>
  createdAt?: number
}

export class FavoriteSyncEngine {
  private account: AccountClient
  private userId: string | null = null
  private enabled = false
  private autoSyncEnabled = true
  private generation = 0
  private debounceTimer: NodeJS.Timeout | null = null
  private syncing = false
  private syncRequested = false
  private syncState: FavoriteSyncState = {
    phase: 'idle',
    pendingMutationCount: 0,
    lastSuccessfulAt: null,
    remoteFavoriteCount: null
  }
  private remoteFavoriteCount: number | null = null
  private stateListeners = new Set<(state: FavoriteSyncState) => void>()
  private libraryChangedListener: (() => void) | null = null

  constructor(account: AccountClient) {
    this.account = account
  }

  setLibraryChangedListener(listener: (() => void) | null): void {
    this.libraryChangedListener = listener
  }

  subscribeState(listener: (state: FavoriteSyncState) => void): () => void {
    this.stateListeners.add(listener)
    listener(this.getState())
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  getState(): FavoriteSyncState {
    const pending = this.getPendingMutationCount()
    return { ...this.syncState, pendingMutationCount: pending }
  }

  async getStatus(): Promise<Record<string, unknown>> {
    const userId = favoriteLibrary.getActiveUserId()
    const snapshot = favoriteLibrary.getSnapshot()
    const syncData = userId ? favoriteLibrary.getAccountSyncData(userId) : null
    const lastSuccessfulAt = syncData?.lastSuccessfulAt ?? this.syncState.lastSuccessfulAt ?? null
    return {
      state: { ...this.getState(), lastSuccessfulAt },
      localFavoriteCount: snapshot.favorites.length,
      pendingMutationCount: syncData?.queue.length ?? 0,
      remoteFavoriteCount: this.remoteFavoriteCount,
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
    if (!enabled || (!autoSync && !resumeAuto)) {
      this.setSyncState({ phase: 'idle' })
      return
    }
    this.initialize(id, generation).catch((err) => {
      if (this.userId !== id || this.generation !== generation) return
      this.setSyncError(err)
      console.warn('[favorite-sync] 初始化失败，保留本地队列等待重试:', err)
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
    this.remoteFavoriteCount = null
    if (clearState) this.setSyncState({ phase: 'idle', lastSuccessfulAt: null })
  }

  notifyLocalChange(): void {
    const userId = this.userId
    const pending = this.getPendingMutationCount()
    this.publishState({ pendingMutationCount: pending })
    if (!userId || !this.enabled || !this.autoSyncEnabled || favoriteLibrary.getActiveUserId() !== userId) return
    this.clearDebounceTimer()
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.syncNow('local-change').catch((err) => {
        console.warn('[favorite-sync] 本地变化同步失败:', err)
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
        throw new FavoriteSyncError('FAVORITE_SYNC_IDENTITY_CHANGED', '账号已切换，当前同步已取消')
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
      const favorites = favoriteLibrary.getActiveFavorites().map(favoriteToPayload)
      const result = (await this.account.overwriteFavorites(favorites)) as Record<string, unknown>
      if (this.userId !== userId || favoriteLibrary.getActiveUserId() !== userId) {
        throw new FavoriteSyncError('FAVORITE_SYNC_IDENTITY_CHANGED', '账号已切换，当前同步已取消')
      }
      favoriteLibrary.updateAccountSyncState(userId, {
        favorites: result.favorites as unknown[],
        queue: [],
        cursor: result.cursor as number
      })
      this.remoteFavoriteCount = (result.favorites as unknown[]).length
      this.emitLibraryChanged()
      return this.getStatus()
    })
  }

  async pullCloudToLocal(): Promise<Record<string, unknown>> {
    return this.runOverwrite(async (userId) => {
      const snapshot = (await this.account.getFavoriteSnapshot()) as Record<string, unknown>
      if (this.userId !== userId || favoriteLibrary.getActiveUserId() !== userId) {
        throw new FavoriteSyncError('FAVORITE_SYNC_IDENTITY_CHANGED', '账号已切换，当前同步已取消')
      }
      favoriteLibrary.replaceActiveFavorites(snapshot.favorites as unknown[])
      favoriteLibrary.updateAccountSyncState(userId, {
        favorites: snapshot.favorites as unknown[],
        queue: [],
        cursor: snapshot.cursor as number
      })
      this.remoteFavoriteCount = (snapshot.favorites as unknown[]).length
      this.emitLibraryChanged()
      return this.getStatus()
    })
  }

  private async initialize(userId: string, generation: number): Promise<void> {
    if (!this.autoSyncEnabled) {
      this.setSyncState({ phase: 'idle' })
      return
    }
    favoriteLibrary.ensureAccountInitialized(userId)
    await this.mergeRemoteSnapshot(userId, generation)
    if (this.userId !== userId || this.generation !== generation) return
    await this.syncNow('login')
  }

  private async runOverwrite(fn: (userId: string) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const userId = this.requireActiveUser()
    if (this.syncing) throw new FavoriteSyncError('FAVORITE_SYNC_BUSY', '同步正在进行中，请稍后再试')
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
      throw new FavoriteSyncError('FAVORITE_SYNC_UNAVAILABLE', '请先登录并开启云端同步')
    }
    if (favoriteLibrary.getActiveUserId() !== this.userId) {
      throw new FavoriteSyncError('FAVORITE_SYNC_IDENTITY_CHANGED', '账号已切换，请重新打开云同步设置')
    }
    return this.userId
  }

  private async mergeRemoteSnapshot(userId: string, generation: number): Promise<void> {
    const snapshot = (await this.account.getFavoriteSnapshot()) as {
      cursor: number
      favorites: unknown[]
    }
    if (this.userId !== userId || this.generation !== generation) return
    const syncData = favoriteLibrary.getAccountSyncData(userId)
    const before = favoriteLibrary.getSnapshot().favorites
    const merged = this.applyPendingMutations(snapshot.favorites, syncData.queue)
    favoriteLibrary.replaceActiveFavorites(merged)
    favoriteLibrary.updateAccountSyncState(userId, {
      favorites: merged,
      cursor: snapshot.cursor
    })
    this.remoteFavoriteCount = merged.length
    this.emitLibraryChanged(before)
  }

  private applyPendingMutations(favorites: unknown[], queue: Array<Record<string, unknown>>): Favorite[] {
    let current = (clone(favorites) as unknown[]).map((f) => normalizeFavorite(f)).filter((f): f is Favorite => !!f)
    for (const mutation of queue) {
      const m = mutation as FavoriteMutation
      if (m.operation === 'DELETE_FAVORITE') {
        current = current.filter((f) => f.id !== m.favoriteId)
        continue
      }
      const favorite = m.favorite ? normalizeFavorite(m.favorite) : null
      if (!favorite) continue
      current = this.upsert(current, favorite)
    }
    return current
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
          throw new FavoriteSyncError('FAVORITE_SYNC_RETRY_LIMIT', '同步冲突未能自动解决，请稍后重试')
        }
        round += 1
        this.syncRequested = false
        if (this.userId !== userId || this.generation !== generation || favoriteLibrary.getActiveUserId() !== userId) return
        const syncData = favoriteLibrary.getAccountSyncData(userId)
        const result = (await this.account.syncFavorites(syncData.cursor, syncData.queue)) as Record<string, unknown>
        if (this.userId !== userId || this.generation !== generation || favoriteLibrary.getActiveUserId() !== userId) return
        const acceptedMutationIds = (result.acceptedMutationIds as string[]) || []
        const remoteChanges = (result.remoteChanges as Array<Record<string, unknown>>) || []
        const conflicts = (result.conflicts as Array<Record<string, unknown>>) || []
        const afterSync = favoriteLibrary.getAccountSyncData(userId)
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
        const conflictById = new Map<string, Record<string, unknown>>(
          conflicts.map((c) => [c.favoriteId as string, c])
        )
        const sentIds = new Set(syncData.queue.slice(0, SYNC_BATCH_MAX).map((m) => m.clientMutationId as string))
        let queue = afterSync.queue.filter((m) => {
          const mutation = m as FavoriteMutation
          if (acceptedSet.has(mutation.clientMutationId)) return false
          const conflict = conflictById.get(mutation.favoriteId)
          return !sentIds.has(mutation.clientMutationId) || !conflict
            ? true
            : conflict.reason === 'REVISION_MISMATCH' ||
              conflict.reason === 'APPLY_FAILED' ||
              (conflict.reason === 'FAVORITE_DELETED' && mutation.origin === 'import')
        })
        const acceptedRevisions = (result.acceptedRevisions as Record<string, number>) ?? {}
        let favorites = afterSync.favorites.map((f) => ({
          ...f,
          revision: acceptedRevisions[f.id] ?? f.revision
        }))
        queue = queue.map((m) => {
          const mutation = m as FavoriteMutation
          const revision = acceptedRevisions[mutation.favoriteId]
          if (revision !== undefined && mutation.expectedRevision !== undefined) {
            return { ...mutation, expectedRevision: revision }
          }
          const conflict = conflictById.get(mutation.favoriteId)
          const conflictRevision = conflict?.favorite
            ? (conflict.favorite as Record<string, unknown>).revision
            : undefined
          return conflict?.reason === 'REVISION_MISMATCH' && conflictRevision !== undefined
            ? { ...mutation, expectedRevision: conflictRevision }
            : mutation
        })
        const pendingIds = new Set(queue.map((m) => (m as FavoriteMutation).favoriteId))
        let merged = this.applyRemoteChanges(favorites, remoteChanges, pendingIds)
        conflicts.forEach((conflict) => {
          if (conflict.reason === 'FAVORITE_NOT_FOUND' || conflict.reason === 'FAVORITE_DELETED') {
            merged = merged.filter((f) => f.id !== conflict.favoriteId)
            return
          }
          if (conflict.favorite && !pendingIds.has(conflict.favoriteId as string)) {
            const favorite = normalizeFavorite(conflict.favorite)
            if (favorite) merged = this.upsert(merged, favorite)
          }
        })
        ;((result.resolvedDeletedFavoriteIds as string[]) ?? []).forEach((id) => {
          if (!pendingIds.has(id)) merged = merged.filter((f) => f.id !== id)
        })
        ;((result.resolvedFavorites as unknown[]) ?? []).forEach((item) => {
          const favorite = normalizeFavorite(item)
          if (favorite && !pendingIds.has(favorite.id)) merged = this.upsert(merged, favorite)
        })
        favoriteLibrary.replaceActiveFavorites(merged)
        favoriteLibrary.updateAccountSyncState(userId, {
          favorites: merged,
          queue: queue as Array<Record<string, unknown>>,
          cursor: result.cursor as number
        })
        this.remoteFavoriteCount = merged.length
        this.emitLibraryChanged(afterSync.favorites.map((f) => favoriteToPayload(f as Favorite)))
        if (conflicts.length > 0) {
          const counts = conflicts.reduce((acc, c) => {
            acc[c.reason as string] = ((acc[c.reason as string] as number) ?? 0) + 1
            return acc
          }, {} as Record<string, number>)
          console.warn('[favorite-sync] 同步冲突:', counts)
        }
        const hardConflictIds = new Set(
          conflicts
            .filter((c) => c.reason === 'APPLY_FAILED')
            .map((c) => c.favoriteId as string)
        )
        hardConflictIds.forEach((id) => conflictIds.add(id))
        ;[...conflictIds].forEach((id) => {
          if (!queue.some((m) => (m as FavoriteMutation).favoriteId === id)) conflictIds.delete(id)
        })
        if (queue.some((m) => !hardConflictIds.has((m as FavoriteMutation).favoriteId))) {
          this.syncRequested = true
        }
      } while (this.syncRequested && this.userId === userId)
      succeeded = true
    } catch (err) {
      this.setSyncError(err)
      console.warn('[favorite-sync] 请求失败，将在下次启动或手动同步时重试:', err)
      if (trigger === 'manual-retry') throw err
    } finally {
      this.syncing = false
      if (succeeded && this.userId === userId) {
        if (conflictIds.size > 0) {
          this.setSyncError(
            new FavoriteSyncError(
              'FAVORITE_SYNC_CONFLICT',
              `${conflictIds.size} 项收藏变更暂时无法同步，数据已保留在本机，可稍后重试`
            )
          )
        } else {
          this.setSyncSuccess()
        }
      }
      if (this.syncRequested && this.userId === userId) {
        this.syncNow('follow-up').catch((err) => {
          console.warn('[favorite-sync] 连续同步失败:', err)
        })
      }
    }
  }

  private applyRemoteChanges(
    favorites: Favorite[],
    changes: Array<Record<string, unknown>>,
    pendingIds: Set<string>
  ): Favorite[] {
    let current = favorites
    changes.forEach((change) => {
      if (pendingIds.has(change.favoriteId as string)) return
      const favorite = normalizeFavorite(change.payload ?? change)
      if (change.operation === 'DELETE_FAVORITE') {
        current = current.filter((f) => f.id !== change.favoriteId)
        return
      }
      if (favorite) current = this.upsert(current, favorite)
    })
    return current
  }

  private upsert(favorites: Favorite[], favorite: Favorite): Favorite[] {
    return [...favorites.filter((f) => f.id !== favorite.id), clone(favorite)]
  }

  private setSyncState(patch: Partial<FavoriteSyncState>): void {
    this.syncState = { ...this.syncState, ...patch, pendingMutationCount: this.getPendingMutationCount() }
    this.publishState()
  }

  private publishState(patch: Partial<FavoriteSyncState> = {}): void {
    this.syncState = { ...this.syncState, ...patch, pendingMutationCount: this.getPendingMutationCount() }
    const state = this.getState()
    this.stateListeners.forEach((listener) => listener(state))
  }

  private setSyncError(err: unknown): void {
    this.setSyncState({
      phase: 'error',
      message: err instanceof Error ? err.message : '账号收藏同步失败'
    })
  }

  private setSyncSuccess(): void {
    const completedAt = Date.now()
    const lastSuccessfulAt = new Date(completedAt).toISOString()
    const userId = this.userId
    if (userId && favoriteLibrary.getActiveUserId() === userId) {
      favoriteLibrary.updateAccountSyncState(userId, { lastSuccessfulAt })
    }
    this.setSyncState({ phase: 'success', completedAt, lastSuccessfulAt, message: undefined })
  }

  private getPendingMutationCount(): number {
    const userId = this.userId ?? favoriteLibrary.getActiveUserId()
    if (!userId) return 0
    try {
      return favoriteLibrary.getAccountSyncData(userId).queue.length
    } catch {
      return 0
    }
  }

  private emitLibraryChanged(before?: unknown[]): void {
    if (before && JSON.stringify(before) === JSON.stringify(favoriteLibrary.getSnapshot().favorites)) return
    this.libraryChangedListener?.()
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }
}
