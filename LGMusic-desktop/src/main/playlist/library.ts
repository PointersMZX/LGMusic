/**
 * 歌单库（本地 JSON 存储 + 账户隔离 + 同步变更队列）与外部歌单导入链路。
 * 逻辑忠实还原自青听 v1.0.3 桌面端主进程（Ai 类 + 导入区）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { app } from 'electron'

export class PlaylistLibraryError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PlaylistLibraryError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const nowIso = (): string => new Date().toISOString()

const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** 时间 + 随机的 26 位 ID（Crockford 变体字母表） */
export function newPlaylistId(): string {
  let ts = Date.now()
  let tsPart = ''
  for (let i = 0; i < 10; i += 1) {
    tsPart = ID_ALPHABET[ts % ID_ALPHABET.length] + tsPart
    ts = Math.floor(ts / ID_ALPHABET.length)
  }
  let randPart = ''
  for (let i = 0; i < 16; i += 1) {
    randPart += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]
  }
  return `${tsPart}${randPart}`.slice(0, 26)
}

export function trackFingerprint(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 26).toUpperCase()
}

/** 归一化 ID（兼容 O/I/L/U 混淆） */
export function normalizePlaylistId(value: unknown): string {
  const raw = String(value ?? '').trim().toUpperCase()
  if (ULID_RE.test(raw)) return raw
  if (!/^[0-9A-Z]{26}$/.test(raw)) return ''
  const fixed = raw.replace(/[IL]/g, '1').replace(/O/g, '0').replace(/U/g, 'V')
  return ULID_RE.test(fixed) ? fixed : ''
}

/** 渠道键统一（qq → tx） */
export function normalizeSource(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase()
  return raw === 'qq' || raw === 'tx' ? 'tx' : raw || 'wy'
}

export function validatePlaylistName(value: unknown): string {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ')
  if (!name) throw new PlaylistLibraryError('PLAYLIST_NAME_EMPTY', '歌单名称不能为空')
  if (name.length > 60) throw new PlaylistLibraryError('PLAYLIST_NAME_TOO_LONG', '歌单名称不能超过 60 个字符')
  return name
}

const cloneSafe = (v: unknown): Record<string, unknown> | undefined => {
  if (isObj(v)) {
    try {
      return clone(v)
    } catch {
      return undefined
    }
  }
  return undefined
}

const strSlice = (v: unknown, max: number): string | undefined => String(v ?? '').trim().slice(0, max) || undefined
const sizeOrUndef = (v: unknown): number | undefined => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
}

/** 时长（秒/毫秒/「X分X秒」/「mm:ss」）→ 秒 */
function durationToSeconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const s = value > 10000 ? value / 1000 : value
    return s > 0 ? Math.floor(s) : undefined
  }
  const raw = String(value ?? '').trim()
  if (!raw) return undefined
  const cn = raw.match(/(\d+)\s*分\s*(\d+)\s*秒/)
  if (cn) {
    const s = Number(cn[1]) * 60 + Number(cn[2])
    return s > 0 ? s : undefined
  }
  const hm = raw.match(/^(\d{1,3}):(\d{1,2})$/)
  if (hm) {
    const s = Number(hm[1]) * 60 + Number(hm[2])
    return s > 0 ? s : undefined
  }
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  const s = n > 10000 ? n / 1000 : n
  return s > 0 ? Math.floor(s) : undefined
}

const durationOf = (v: unknown, fallback?: Record<string, unknown>): number | undefined =>
  durationToSeconds(v) ?? durationToSeconds(fallback?.durationLabel)

/** 跨歌单回填缺失时长 */
function backfillDurations(groups: Playlist[][]): boolean {
  const known = new Map<string, number>()
  for (const group of groups) {
    for (const playlist of group) {
      for (const track of playlist.tracks) {
        if (!track.duration || track.duration <= 0) continue
        const key = `${track.source}:${track.trackId}`
        known.set(key, Math.max(known.get(key) ?? 0, track.duration))
      }
    }
  }
  let changed = false
  for (const group of groups) {
    for (const playlist of group) {
      for (const track of playlist.tracks) {
        if (track.duration && track.duration > 0) continue
        const sec = known.get(`${track.source}:${track.trackId}`)
        if (sec) {
          track.duration = sec
          changed = true
        }
      }
    }
  }
  return changed
}

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

export interface PlaylistTrack {
  id: string
  source: string
  trackId: string
  name: string
  artist: string
  album?: string
  coverUrl?: string
  duration?: number
  fileSize?: number
  fileFingerprint?: string
  metadataFingerprint?: string
  sortOrder: number
  localUri?: string
  localPath?: string
  localPicture?: string
  addedAt?: string
  localData?: Record<string, unknown>
}

export interface Playlist {
  id: string
  name: string
  type: 'custom' | 'imported'
  source?: string
  externalId?: string
  coverUrl?: string
  sortOrder: number
  revision: number
  tracks: PlaylistTrack[]
  deletedAt: string | null
  createdAt?: string
  updatedAt?: string
}

interface AccountStore {
  hasSnapshot: boolean
  playlists: Playlist[]
  queue: Array<Record<string, unknown>>
  cursor: number
  lastSuccessfulAt: string | null
}

interface Library {
  version: number
  activeUserId?: string
  guest: { playlists: Playlist[] }
  accounts: Record<string, AccountStore>
}

/** 原始输入 → 歌单曲目（失败返回 null） */
function trackFromInput(input: unknown, playlistIdSeed: string, sortOrder: number): PlaylistTrack | null {
  if (!isObj(input)) return null
  const source = normalizeSource(input.source)
  const trackId = String(input.trackId ?? '').trim()
  const name = String(input.name ?? '').trim()
  if (!trackId || !name) return null
  const localData = cloneSafe(input.localData)
  return {
    id: normalizePlaylistId(input.id) || trackFingerprint(`track:${playlistIdSeed}:${source}:${trackId}`),
    source,
    trackId,
    name,
    artist: String(input.artist ?? '').trim(),
    album: String(input.album ?? '').trim() || undefined,
    coverUrl: String(input.coverUrl ?? '').trim() || undefined,
    duration: durationOf(input.duration, localData),
    fileSize: sizeOrUndef(input.fileSize),
    fileFingerprint: strSlice(input.fileFingerprint, 64),
    metadataFingerprint: strSlice(input.metadataFingerprint, 64),
    sortOrder,
    localUri: strSlice(input.localUri, 2048),
    localPath: strSlice(input.localPath, 2048),
    localPicture: strSlice(input.localPicture, 2048),
    addedAt: typeof input.addedAt === 'string' && input.addedAt ? input.addedAt : undefined,
    localData
  }
}

/** 原始输入 → 歌单（校验/清洗） */
function playlistFromInput(input: unknown): Playlist | null {
  if (!isObj(input)) return null
  const id = normalizePlaylistId(input.id)
  const name = String(input.name ?? '').trim()
  const type = input.type
  if (!ULID_RE.test(id) || !name || (type !== 'custom' && type !== 'imported')) return null
  const rawTracks = Array.isArray(input.tracks) ? input.tracks : []
  const seen = new Set<string>()
  const tracks = rawTracks
    .map((t, i) => trackFromInput(t, id, i))
    .filter((t): t is PlaylistTrack => !!t && !seen.has(t.id) && (seen.add(t.id), true))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((t, i) => ({ ...t, sortOrder: i }))
  const revision = Number(input.revision)
  const sortOrder = Number(input.sortOrder)
  return {
    id,
    name,
    type: type as 'custom' | 'imported',
    source: String(input.source ?? '').trim() ? normalizeSource(input.source) : undefined,
    externalId: String(input.externalId ?? '').trim() || undefined,
    coverUrl: String(input.coverUrl ?? '').trim() || undefined,
    sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
    revision: Number.isFinite(revision) && revision >= 0 ? revision : 0,
    tracks,
    deletedAt: typeof input.deletedAt === 'string' && input.deletedAt ? input.deletedAt : null,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : undefined,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : undefined
  }
}

function emptyLibrary(): Library {
  return { version: 1, guest: { playlists: [] }, accounts: {} }
}

/** 歌单元数据是否变化（不含曲目） */
function metaChanged(a: Playlist, b: Playlist): boolean {
  return (
    a.name !== b.name ||
    a.type !== b.type ||
    a.source !== b.source ||
    a.externalId !== b.externalId ||
    a.coverUrl !== b.coverUrl ||
    a.sortOrder !== b.sortOrder
  )
}

/** 序列化歌单（快照形态） */
function playlistSnapshot(playlist: Playlist): Record<string, unknown> {
  return {
    id: playlist.id,
    name: playlist.name,
    type: playlist.type,
    source: playlist.source ?? null,
    externalId: playlist.externalId ?? null,
    coverUrl: playlist.coverUrl ?? null,
    sortOrder: playlist.sortOrder,
    deletedAt: playlist.deletedAt ?? null,
    tracks: playlist.tracks.map((t) => ({ ...trackSnapshot(t), sortOrder: t.sortOrder }))
  }
}

function trackSnapshot(t: PlaylistTrack): Record<string, unknown> {
  return {
    id: t.id,
    source: t.source,
    trackId: t.trackId,
    name: t.name,
    artist: t.artist,
    album: t.album ?? null,
    coverUrl: t.coverUrl ?? null,
    duration: t.duration ?? null,
    fileSize: t.fileSize ?? null,
    fileFingerprint: t.fileFingerprint ?? null,
    metadataFingerprint: t.metadataFingerprint ?? null,
    localUri: t.localUri ?? null,
    localPath: t.localPath ?? null,
    localPicture: t.localPicture ?? null,
    addedAt: t.addedAt ?? null,
    localData: t.localData ?? null
  }
}

const LIB_VERSION = 1
const NAME_MAX = 60
const TRACK_BATCH_MAX = 2000
const TRACK_TOTAL_MAX = 20000
const EXTERNAL_ID_MAX = 512

// ---------------------------------------------------------------------------
// 歌单库
// ---------------------------------------------------------------------------

export class PlaylistLibrary {
  private library: Library | null = null
  private activeUserId: string | null = null
  private recoveryWarning = ''
  private localChangeListener: (() => void) | null = null
  private userDataPath = ''

  bindUserData(userDataPath: string): void {
    this.userDataPath = userDataPath
  }

  private get filePath(): string {
    const base = this.userDataPath || app.getPath('userData')
    const dir = path.join(base, 'data')
    fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, 'playlist-library-v1.json')
  }

  private ensureLoaded(): Library {
    if (this.library) return this.library
    const file = this.filePath
    if (!fs.existsSync(file)) {
      this.library = emptyLibrary()
      return this.library
    }
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (!isObj(json)) throw new Error('歌单库根节点格式错误')
      const guest = (isObj(json.guest) && Array.isArray(json.guest.playlists) ? json.guest.playlists : [])
        .map((p) => playlistFromInput(p))
        .filter((p): p is Playlist => !!p)
      const accounts: Record<string, AccountStore> = {}
      if (isObj(json.accounts)) {
        for (const [userId, store] of Object.entries(json.accounts)) {
          if (!userId || !isObj(store)) continue
          const playlists = Array.isArray(store.playlists)
            ? (store.playlists.map((p) => playlistFromInput(p)).filter((p): p is Playlist => !!p))
            : []
          accounts[userId] = {
            hasSnapshot: store.hasSnapshot === true,
            playlists,
            queue: Array.isArray(store.queue) ? store.queue : [],
            cursor: Number.isFinite(Number(store.cursor)) && Number(store.cursor) >= 0 ? Math.floor(Number(store.cursor)) : 0,
            lastSuccessfulAt: typeof store.lastSuccessfulAt === 'string' ? store.lastSuccessfulAt : null
          }
        }
      }
      const library: Library = {
        version: LIB_VERSION,
        activeUserId: typeof json.activeUserId === 'string' && json.activeUserId ? json.activeUserId : undefined,
        guest: { playlists: guest },
        accounts
      }
      const backfilled = backfillDurations([
        library.guest.playlists,
        ...Object.values(library.accounts).map((a) => a.playlists)
      ])
      this.library = library
      this.activeUserId = library.activeUserId ?? null
      if (backfilled) {
        try {
          this.writeLibrary()
        } catch (err) {
          console.warn('[playlist-library] 回填歌曲时长保存失败', err)
        }
      }
      return library
    } catch (err) {
      this.backupCorruptedFile(file)
      this.library = emptyLibrary()
      this.activeUserId = null
      this.recoveryWarning = '歌单库文件损坏，已保留损坏副本并创建新的空歌单库'
      console.error('[playlist-library] 歌单库恢复失败', err)
      try {
        this.writeLibrary()
      } catch (err2) {
        console.error('[playlist-library] 写入恢复后的空歌单库失败', err2)
      }
      return this.library
    }
  }

  private backupCorruptedFile(file: string): void {
    try {
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`)
    } catch (err) {
      console.error('[playlist-library] 备份损坏文件失败', err)
    }
  }

  private writeLibrary(): void {
    const file = this.filePath
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    const json = JSON.stringify(this.ensureLoaded(), null, 2)
    try {
      fs.writeFileSync(tmp, json, 'utf-8')
      try {
        fs.renameSync(tmp, file)
      } catch {
        fs.copyFileSync(tmp, file)
        fs.rmSync(tmp, { force: true })
      }
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* 清理失败可忽略 */
      }
      throw new PlaylistLibraryError(
        'PLAYLIST_STORAGE_WRITE_FAILED',
        `保存歌单失败：${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  setActiveUser(userId: string | null): boolean {
    const library = this.ensureLoaded()
    const id = userId?.trim() || null
    if (id && !library.accounts[id]) {
      library.accounts[id] = { hasSnapshot: false, playlists: [], queue: [], cursor: 0, lastSuccessfulAt: null }
    }
    if (this.activeUserId === id) return false
    this.activeUserId = id
    if (id) library.activeUserId = id
    else delete library.activeUserId
    this.writeLibrary()
    return true
  }

  setLocalChangeListener(listener: (() => void) | null): void {
    this.localChangeListener = listener
  }

  getActiveUserId(): string | null {
    this.ensureLoaded()
    return this.activeUserId
  }

  getGuestPlaylists(): Playlist[] {
    return clone(this.ensureLoaded().guest.playlists)
  }

  getAccountSyncData(userId: string): AccountStore {
    const account = this.getOrCreateAccount(userId)
    return {
      hasSnapshot: account.hasSnapshot,
      playlists: clone(account.playlists),
      queue: clone(account.queue),
      cursor: account.cursor,
      lastSuccessfulAt: account.lastSuccessfulAt ?? null
    }
  }

  updateAccountSyncState(
    userId: string,
    patch: {
      hasSnapshot?: boolean
      playlists?: Playlist[]
      queue?: Array<Record<string, unknown>>
      cursor?: number
      lastSuccessfulAt?: string
    }
  ): void {
    const account = this.getOrCreateAccount(userId)
    const library = this.ensureLoaded()
    if (patch.hasSnapshot !== undefined) account.hasSnapshot = patch.hasSnapshot
    if (patch.playlists) {
      account.playlists = patch.playlists
        .map((p) => playlistFromInput(p))
        .filter((p): p is Playlist => !!p)
        .sort((a, b) => a.sortOrder - b.sortOrder)
      const others = Object.entries(library.accounts)
        .filter(([id]) => id !== userId)
        .map(([, store]) => store.playlists)
      backfillDurations([account.playlists, library.guest.playlists, ...others])
      account.hasSnapshot = true
    }
    if (patch.queue) account.queue = clone(patch.queue)
    if (patch.cursor !== undefined) {
      account.cursor = Number.isFinite(patch.cursor) && patch.cursor >= 0 ? Math.floor(patch.cursor) : 0
    }
    if (patch.lastSuccessfulAt !== undefined) account.lastSuccessfulAt = patch.lastSuccessfulAt
    this.writeLibrary()
  }

  enqueueGuestPlaylistImport(userId: string, playlists: Playlist[]): void {
    const account = this.getOrCreateAccount(userId)
    let queue = clone(account.queue)
    const prepared = playlists.map((p) => ({ ...clone(p), revision: 0, deletedAt: null }))
    prepared.forEach((playlist) => {
      queue = this.replacePlaylistMutation(queue, {
        queueVersion: 2,
        origin: 'guest-import',
        clientMutationId: newPlaylistId(),
        operation: 'UPSERT_PLAYLIST',
        playlistId: playlist.id,
        playlist,
        createdAt: Date.now()
      })
    })
    account.queue = queue
    if (account.playlists.length === 0 && prepared.length > 0) {
      account.playlists = clone(prepared)
      account.hasSnapshot = true
    }
    this.writeLibrary()
  }

  captureRestoreState(): Record<string, unknown> {
    const library = this.ensureLoaded()
    const userId = this.activeUserId
    if (!userId) {
      return { activeUserId: null, guestPlaylists: clone(library.guest.playlists) }
    }
    const account = this.getOrCreateAccount(userId)
    return {
      activeUserId: userId,
      account: clone({
        hasSnapshot: account.hasSnapshot,
        playlists: account.playlists,
        queue: account.queue,
        cursor: account.cursor,
        lastSuccessfulAt: account.lastSuccessfulAt ?? null
      })
    }
  }

  restoreState(state: {
    activeUserId: string | null
    guestPlaylists?: Playlist[]
    account?: Partial<AccountStore> | null
  }): void {
    const library = this.ensureLoaded()
    if (!state.activeUserId) {
      library.guest.playlists = clone(state.guestPlaylists ?? [])
      this.activeUserId = null
      delete library.activeUserId
      this.writeLibrary()
      return
    }
    const account = this.getOrCreateAccount(state.activeUserId)
    account.hasSnapshot = state.account?.hasSnapshot ?? false
    account.playlists = clone((state.account?.playlists as Playlist[] | undefined) ?? [])
    account.queue = clone((state.account?.queue as Array<Record<string, unknown>> | undefined) ?? [])
    account.cursor = state.account?.cursor ?? 0
    account.lastSuccessfulAt = state.account?.lastSuccessfulAt ?? null
    this.activeUserId = state.activeUserId
    library.activeUserId = state.activeUserId
    this.writeLibrary()
  }

  getSnapshot(): {
    identity: { kind: 'account' | 'guest'; userId: string | null }
    playlists: Playlist[]
    recoveryWarning?: string
  } {
    const library = this.ensureLoaded()
    const userId = this.activeUserId
    const playlists = this.getActivePlaylists()
      .filter((p) => !p.deletedAt)
      .sort(
        (a, b) =>
          a.sortOrder !== b.sortOrder
            ? a.sortOrder - b.sortOrder
            : String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
      )
    return {
      identity: {
        kind: userId && library.accounts[userId] ? 'account' : 'guest',
        userId
      },
      playlists: clone(playlists),
      recoveryWarning: this.recoveryWarning || undefined
    }
  }

  createPlaylist(nameInput: unknown): Playlist {
    const name = validatePlaylistName(nameInput)
    const playlists = this.getActivePlaylists()
    const before = clone(playlists)
    const id = this.createUniquePlaylistId(playlists)
    const now = nowIso()
    const playlist: Playlist = {
      id,
      name,
      type: 'custom',
      sortOrder: this.nextPlaylistSortOrder(playlists),
      revision: 0,
      tracks: [],
      deletedAt: null,
      createdAt: now,
      updatedAt: now
    }
    playlists.push(playlist)
    this.commitLocalPlaylistChanges(before, playlists)
    this.writeActiveLibrary()
    return clone(playlist)
  }

  renamePlaylist(playlistId: string, nameInput: unknown): Playlist {
    const playlist = this.getEditableCustomPlaylist(playlistId)
    const before = clone(playlist)
    playlist.name = validatePlaylistName(nameInput)
    this.touchPlaylist(playlist)
    this.commitLocalPlaylistChanges([before], [playlist])
    this.writeActiveLibrary()
    return clone(playlist)
  }

  deletePlaylist(playlistId: string): ReturnType<PlaylistLibrary['getSnapshot']> {
    const playlist = this.getActivePlaylist(playlistId)
    const before = clone(playlist)
    playlist.deletedAt = nowIso()
    this.touchPlaylist(playlist)
    this.commitExplicitDeletion(before)
    this.writeActiveLibrary()
    return this.getSnapshot()
  }

  upsertImportedPlaylist(input: {
    source: unknown
    externalId: unknown
    name: unknown
    coverUrl?: unknown
    tracks: unknown[]
  }): { playlist: Playlist; updated: boolean } {
    const source = normalizeSource(input.source)
    const externalId = String(input.externalId ?? '').trim()
    if (!externalId || externalId.length > EXTERNAL_ID_MAX) {
      throw new PlaylistLibraryError('PLAYLIST_EXTERNAL_ID_INVALID', '歌单外部 ID 无效')
    }
    const name = validatePlaylistName(input.name)
    if (!Array.isArray(input.tracks)) {
      throw new PlaylistLibraryError('PLAYLIST_TRACKS_INVALID', '导入歌单的歌曲数据格式错误')
    }
    if (input.tracks.length > TRACK_TOTAL_MAX) {
      throw new PlaylistLibraryError('PLAYLIST_TRACKS_TOO_MANY', `单个歌单最多支持 ${TRACK_TOTAL_MAX} 首歌曲`)
    }
    const playlists = this.getActivePlaylists()
    const id = trackFingerprint(`imported:${source}:${externalId}`)
    const existing = playlists.find((p) => p.id === id)
    if (existing && existing.type !== 'imported') {
      throw new PlaylistLibraryError('PLAYLIST_ID_CONFLICT', '歌单 ID 冲突，请稍后重试')
    }
    const now = nowIso()
    const before = existing ? clone(existing) : undefined
    const known = new Map<string, PlaylistTrack>(
      (existing?.tracks ?? []).map((t) => [`${t.source}:${t.trackId}`, t])
    )
    const seen = new Set<string>()
    const tracks: PlaylistTrack[] = []
    for (const item of input.tracks) {
      if (!isObj(item)) continue
      const trackId = String(item.trackId ?? '').trim()
      const trackName = String(item.name ?? '').trim()
      const key = `${source}:${trackId}`
      if (!trackId || !trackName || seen.has(key)) continue
      const localData = cloneSafe(item.localData)
      const prev = known.get(key)
      tracks.push({
        id: trackFingerprint(`track:${id}:${source}:${trackId}`),
        source,
        trackId,
        name: trackName,
        artist: String(item.artist ?? '').trim(),
        album: String(item.album ?? '').trim() || undefined,
        coverUrl: String(item.coverUrl ?? '').trim() || undefined,
        duration: durationOf(item.duration, localData) ?? prev?.duration,
        sortOrder: tracks.length,
        addedAt: prev?.addedAt ?? now,
        localData
      })
      seen.add(key)
    }
    if (!tracks.length) {
      throw new PlaylistLibraryError('PLAYLIST_TRACKS_EMPTY', '未获取到歌单歌曲，请检查链接或歌单是否为空')
    }
    const playlist: Playlist =
      existing ??
      {
        id,
        name,
        type: 'imported',
        source,
        externalId,
        coverUrl: String(input.coverUrl ?? '').trim() || undefined,
        sortOrder: this.nextPlaylistSortOrder(playlists),
        revision: 0,
        tracks: [],
        deletedAt: null,
        createdAt: now,
        updatedAt: now
      }
    playlist.name = name
    playlist.source = source
    playlist.externalId = externalId
    playlist.coverUrl = String(input.coverUrl ?? '').trim() || undefined
    playlist.tracks = tracks
    playlist.deletedAt = null
    playlist.revision += 1
    playlist.updatedAt = now
    if (!existing) playlists.push(playlist)
    this.commitLocalPlaylistChanges(before ? [before] : [], [playlist])
    this.writeActiveLibrary()
    return { playlist: clone(playlist), updated: !!existing }
  }

  getImportedPlaylist(playlistId: string): Playlist {
    const playlist = this.getActivePlaylist(playlistId)
    if (playlist.type !== 'imported') {
      throw new PlaylistLibraryError('PLAYLIST_NOT_IMPORTED', '当前歌单不是导入歌单')
    }
    return clone(playlist)
  }

  addTracks(playlistId: string, tracks: unknown[]): { playlist: Playlist; addedCount: number; skippedCount: number } {
    const playlist = this.getEditableCustomPlaylist(playlistId)
    const before = clone(playlist)
    if (!Array.isArray(tracks)) throw new PlaylistLibraryError('PLAYLIST_TRACKS_INVALID', '歌曲数据格式错误')
    if (tracks.length > TRACK_BATCH_MAX) {
      throw new PlaylistLibraryError('PLAYLIST_TRACKS_TOO_MANY', `单次最多添加 ${TRACK_BATCH_MAX} 首歌曲`)
    }
    const existingKeys = new Set(playlist.tracks.map((t) => `${t.source}:${t.trackId}`))
    let added = 0
    let skipped = 0
    let durationFixed = false
    for (const item of tracks) {
      if (!isObj(item)) {
        skipped += 1
        continue
      }
      const source = normalizeSource(item.source)
      const trackId = String(item.trackId ?? '').trim()
      const name = String(item.name ?? '').trim()
      const key = `${source}:${trackId}`
      if (!trackId || !name) {
        skipped += 1
        continue
      }
      const localData = cloneSafe(item.localData)
      const duration = durationOf(item.duration, localData)
      if (existingKeys.has(key)) {
        const prev = playlist.tracks.find((t) => `${t.source}:${t.trackId}` === key)
        if (prev && (!prev.duration || prev.duration <= 0) && duration) {
          prev.duration = duration
          durationFixed = true
        }
        skipped += 1
        continue
      }
      playlist.tracks.push({
        id: trackFingerprint(`track:${playlist.id}:${source}:${trackId}`),
        source,
        trackId,
        name,
        artist: String(item.artist ?? '').trim(),
        album: String(item.album ?? '').trim() || undefined,
        coverUrl: String(item.coverUrl ?? '').trim() || undefined,
        duration,
        sortOrder: playlist.tracks.length,
        addedAt: nowIso(),
        localData
      })
      existingKeys.add(key)
      added += 1
    }
    if (added > 0 || durationFixed) {
      this.reindexTracks(playlist)
      this.touchPlaylist(playlist)
      this.commitLocalPlaylistChanges([before], [playlist])
      this.writeActiveLibrary()
    }
    return { playlist: clone(playlist), addedCount: added, skippedCount: skipped }
  }

  removeTracks(playlistId: string, trackIds: unknown[]): Playlist {
    const playlist = this.getEditableCustomPlaylist(playlistId)
    const before = clone(playlist)
    if (!Array.isArray(trackIds)) {
      throw new PlaylistLibraryError('PLAYLIST_TRACK_IDS_INVALID', '待移除歌曲数据格式错误')
    }
    const removeSet = new Set(trackIds.map((id) => String(id ?? '').trim()).filter(Boolean))
    if (!removeSet.size) return clone(playlist)
    const kept = playlist.tracks.filter((t) => !removeSet.has(t.id))
    if (kept.length === playlist.tracks.length) return clone(playlist)
    playlist.tracks = kept
    this.reindexTracks(playlist)
    this.touchPlaylist(playlist)
    this.commitLocalPlaylistChanges([before], [playlist])
    this.writeActiveLibrary()
    return clone(playlist)
  }

  reorderTracks(playlistId: string, orderedIds: unknown[]): Playlist {
    const playlist = this.getEditableCustomPlaylist(playlistId)
    const before = clone(playlist)
    if (!Array.isArray(orderedIds)) {
      throw new PlaylistLibraryError('PLAYLIST_TRACK_ORDER_INVALID', '歌曲顺序数据格式错误')
    }
    const ids = orderedIds.map((id) => String(id ?? '').trim())
    const currentIds = new Set(playlist.tracks.map((t) => t.id))
    const unique = new Set(ids)
    if (ids.length !== playlist.tracks.length || unique.size !== ids.length || ids.some((id) => !currentIds.has(id))) {
      throw new PlaylistLibraryError('PLAYLIST_TRACK_ORDER_INVALID', '歌曲顺序与当前歌单不一致，请刷新后重试')
    }
    const byId = new Map(playlist.tracks.map((t) => [t.id, t]))
    playlist.tracks = ids.map((id) => byId.get(id)!)
    this.reindexTracks(playlist)
    this.touchPlaylist(playlist)
    this.commitLocalPlaylistChanges([before], [playlist])
    this.writeActiveLibrary()
    return clone(playlist)
  }

  /** 备份整库恢复：按类型分组替换活动歌单（保留既有 ID/revision） */
  replaceActiveFromBackup(
    incoming: unknown[],
    types: Array<'custom' | 'imported'> = ['custom', 'imported']
  ): { identity: { kind: 'account' | 'guest'; userId: string | null }; playlists: Playlist[]; recoveryWarning?: string } {
    const library = this.ensureLoaded()
    const existingAll = clone(this.getActivePlaylists())
    const typeSet = new Set(types)
    const prepared = incoming
      .map((p) => playlistFromInput(p))
      .filter((p): p is Playlist => !!p)
      .filter((p) => typeSet.has(p.type))
      .sort((a, b) => a.sortOrder - b.sortOrder)
    const reusedIds = new Set<string>()
    const idMap = new Map<string, Playlist>()
    const mapped = prepared.map((playlist) => {
      const prev =
        existingAll.find((p) => p.id === playlist.id && !reusedIds.has(p.id)) ??
        (playlist.type === 'custom'
          ? existingAll.find((p) => p.type === 'custom' && p.name === playlist.name && !reusedIds.has(p.id))
          : existingAll.find(
              (p) => p.type === 'imported' && p.source === playlist.source && p.externalId === playlist.externalId && !reusedIds.has(p.id)
            ))
      if (!prev) return { ...playlist, revision: 0, deletedAt: null }
      reusedIds.add(prev.id)
      const merged: Playlist = {
        ...playlist,
        id: prev.id,
        revision: prev.revision,
        createdAt: playlist.createdAt ?? prev.createdAt,
        updatedAt: playlist.updatedAt ?? prev.updatedAt,
        deletedAt: null
      }
      idMap.set(merged.id, prev)
      return merged
    })
    const byType: Record<string, Playlist[]> = {
      custom: mapped.filter((p) => p.type === 'custom'),
      imported: mapped.filter((p) => p.type === 'imported')
    }
    const emittedTypes = new Set<string>()
    const orderedExisting = [...existingAll].sort(
      (a, b) =>
        a.sortOrder !== b.sortOrder
          ? a.sortOrder - b.sortOrder
          : String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
    )
    const merged: Playlist[] = []
    orderedExisting.forEach((p) => {
      if (!typeSet.has(p.type)) {
        merged.push(p)
        return
      }
      if (!emittedTypes.has(p.type)) {
        emittedTypes.add(p.type)
        merged.push(...byType[p.type])
      }
    })
    types.forEach((type) => {
      if (!emittedTypes.has(type) && byType[type].length) merged.push(...byType[type])
    })
    // 组间插值重排 sortOrder
    for (let i = 0; i < merged.length; ) {
      if (!typeSet.has(merged[i].type)) {
        i += 1
        continue
      }
      const start = i
      while (i < merged.length && typeSet.has(merged[i].type)) i += 1
      const prevOrder = start > 0 ? merged[start - 1].sortOrder : undefined
      const nextOrder = i < merged.length ? merged[i].sortOrder : undefined
      const count = i - start
      for (let k = 0; k < count; k += 1) {
        const order =
          prevOrder !== undefined && nextOrder !== undefined
            ? prevOrder + ((nextOrder - prevOrder) * (k + 1)) / (count + 1)
            : prevOrder !== undefined
              ? prevOrder + k + 1
              : nextOrder !== undefined
                ? nextOrder - count + k
                : k
        merged[start + k] = { ...merged[start + k], sortOrder: order }
      }
    }
    const mappedIds = new Set(mapped.map((p) => p.id))
    if (this.activeUserId) {
      const account = this.getOrCreateAccount(this.activeUserId)
      let queue = clone(account.queue)
      existingAll.forEach((prev) => {
        if (prev.deletedAt || !typeSet.has(prev.type) || mappedIds.has(prev.id)) return
        queue = this.replacePlaylistMutation(queue, {
          queueVersion: 2,
          origin: 'account-operation',
          clientMutationId: newPlaylistId(),
          operation: 'DELETE_PLAYLIST',
          playlistId: prev.id,
          expectedRevision: this.expectedRevision(queue, prev.id, prev),
          createdAt: Date.now()
        })
      })
      mapped.forEach((playlist) => {
        const prev = idMap.get(playlist.id)
        const unchanged = prev && JSON.stringify(playlistSnapshot(prev)) === JSON.stringify(playlistSnapshot(playlist))
        if (unchanged) return
        queue = this.replacePlaylistMutation(queue, {
          queueVersion: 2,
          origin: 'guest-import',
          clientMutationId: newPlaylistId(),
          operation: 'UPSERT_PLAYLIST',
          playlistId: playlist.id,
          expectedRevision: this.expectedRevision(queue, playlist.id, prev),
          playlist: clone(playlist),
          createdAt: Date.now()
        })
      })
      account.playlists = clone(merged)
      account.queue = queue
      account.hasSnapshot = true
    } else {
      library.guest.playlists = clone(merged)
    }
    this.writeLibrary()
    const playlists = merged
      .filter((p) => !p.deletedAt)
      .sort(
        (a, b) =>
          a.sortOrder !== b.sortOrder
            ? a.sortOrder - b.sortOrder
            : String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
      )
    return {
      identity: {
        kind: this.activeUserId ? 'account' : 'guest',
        userId: this.activeUserId
      },
      playlists: clone(playlists),
      recoveryWarning: this.recoveryWarning || undefined
    }
  }

  private getActivePlaylists(): Playlist[] {
    const library = this.ensureLoaded()
    return this.activeUserId ? this.getOrCreateAccount(this.activeUserId).playlists : library.guest.playlists
  }

  private writeActiveLibrary(): void {
    const library = this.ensureLoaded()
    if (this.activeUserId) {
      const account = library.accounts[this.activeUserId]
      if (account) account.hasSnapshot = true
    }
    this.writeLibrary()
  }

  private getEditableCustomPlaylist(playlistId: string): Playlist {
    const playlist = this.getActivePlaylist(playlistId)
    if (playlist.type !== 'custom') {
      throw new PlaylistLibraryError('PLAYLIST_NOT_EDITABLE', '当前阶段只支持编辑自建歌单')
    }
    return playlist
  }

  private getActivePlaylist(playlistId: string): Playlist {
    const id = String(playlistId ?? '').trim()
    const playlist = this.getActivePlaylists().find((p) => p.id === id && !p.deletedAt)
    if (!playlist) throw new PlaylistLibraryError('PLAYLIST_NOT_FOUND', '歌单不存在或已被删除')
    return playlist
  }

  private createUniquePlaylistId(playlists: Playlist[]): string {
    const used = new Set(playlists.map((p) => p.id))
    for (let i = 0; i < 32; i += 1) {
      const id = newPlaylistId()
      if (!used.has(id)) return id
    }
    throw new PlaylistLibraryError('PLAYLIST_ID_EXHAUSTED', '生成歌单 ID 失败')
  }

  private nextPlaylistSortOrder(playlists: Playlist[]): number {
    return playlists.reduce((max, p) => Math.max(max, p.sortOrder), -1) + 1
  }

  private reindexTracks(playlist: Playlist): void {
    playlist.tracks.forEach((t, i) => {
      t.sortOrder = i
    })
  }

  private touchPlaylist(playlist: Playlist): void {
    playlist.revision += 1
    playlist.updatedAt = nowIso()
  }

  private getOrCreateAccount(userId: string): AccountStore {
    const library = this.ensureLoaded()
    if (!library.accounts[userId]) {
      library.accounts[userId] = { hasSnapshot: false, playlists: [], queue: [], cursor: 0, lastSuccessfulAt: null }
    }
    return library.accounts[userId]
  }

  private commitLocalPlaylistChanges(beforeList: Playlist[], afterList: Playlist[]): void {
    const userId = this.activeUserId
    if (!userId) return
    const account = this.getOrCreateAccount(userId)
    const beforeById = new Map(beforeList.map((p) => [p.id, p]))
    let queue = clone(account.queue)
    afterList.forEach((playlist) => {
      if (playlist.deletedAt) return
      const before = beforeById.get(playlist.id)
      if (before && JSON.stringify(playlistSnapshot(before)) === JSON.stringify(playlistSnapshot(playlist))) return
      const mutation = this.createPlaylistMutation(before, playlist)
      if (mutation) queue = this.mergePlaylistMutation(queue, mutation, playlist)
    })
    account.queue = queue
    this.localChangeListener?.()
  }

  private commitExplicitDeletion(before: Playlist): void {
    const userId = this.activeUserId
    if (!userId) return
    const account = this.getOrCreateAccount(userId)
    const queue = clone(account.queue)
    account.queue = this.replacePlaylistMutation(queue, {
      queueVersion: 2,
      origin: 'account-operation',
      clientMutationId: newPlaylistId(),
      operation: 'DELETE_PLAYLIST',
      playlistId: before.id,
      expectedRevision: this.expectedRevision(queue, before.id, before),
      createdAt: Date.now()
    })
    this.localChangeListener?.()
  }

  /** 前后差异 → 最小同步操作（UPSERT/ADD/REMOVE/REPLACE/REORDER/DELETE） */
  private createPlaylistMutation(before: Playlist | undefined, after: Playlist): Record<string, unknown> | null {
    const base = {
      queueVersion: 2,
      origin: 'account-operation',
      clientMutationId: newPlaylistId(),
      playlistId: after.id,
      createdAt: Date.now()
    }
    if (after.deletedAt) {
      return {
        ...base,
        operation: 'DELETE_PLAYLIST',
        expectedRevision: before && before.revision > 0 ? before.revision : undefined
      }
    }
    if (!before || metaChanged(before, after)) {
      return {
        ...base,
        operation: 'UPSERT_PLAYLIST',
        expectedRevision: before && before.revision > 0 ? before.revision : undefined,
        playlist: clone(after)
      }
    }
    const beforeTracks = new Map(before.tracks.map((t) => [t.id, t]))
    const afterTracks = new Map(after.tracks.map((t) => [t.id, t]))
    const added = after.tracks.filter((t) => !beforeTracks.has(t.id))
    const removed = before.tracks.filter((t) => !afterTracks.has(t.id))
    const modified = after.tracks.some((t) => {
      const prev = beforeTracks.get(t.id)
      return prev && JSON.stringify(trackSnapshot(prev)) !== JSON.stringify(trackSnapshot(t))
    })
    const beforeOrder = before.tracks.map((t) => t.id).join('|')
    const afterOrder = after.tracks.map((t) => t.id).join('|')
    const playlistMeta = { ...clone(after), tracks: [] }
    const expectedRevision = before.revision > 0 ? before.revision : undefined
    if (modified || (added.length > 0 && removed.length > 0)) {
      return { ...base, operation: 'REPLACE_TRACKS', expectedRevision, playlist: playlistMeta, tracks: clone(after.tracks) }
    }
    if (added.length > 0) {
      return { ...base, operation: 'ADD_TRACKS', expectedRevision, playlist: playlistMeta, tracks: clone(added) }
    }
    if (removed.length > 0) {
      return {
        ...base,
        operation: 'REMOVE_TRACKS',
        expectedRevision,
        playlist: playlistMeta,
        trackIds: removed.map((t) => t.id),
        orderedTrackIds: after.tracks.map((t) => t.id)
      }
    }
    if (beforeOrder !== afterOrder) {
      return { ...base, operation: 'REORDER_TRACKS', expectedRevision, playlist: playlistMeta, orderedTrackIds: after.tracks.map((t) => t.id) }
    }
    return null
  }

  private mergePlaylistMutation(
    queue: Array<Record<string, unknown>>,
    mutation: Record<string, unknown>,
    playlist: Playlist
  ): Array<Record<string, unknown>> {
    const existing = queue.find((m) => m.playlistId === mutation.playlistId)
    if (!existing) return this.replacePlaylistMutation(queue, mutation)
    if (mutation.operation === 'DELETE_PLAYLIST') {
      return this.replacePlaylistMutation(queue, {
        ...mutation,
        expectedRevision: existing.expectedRevision ?? mutation.expectedRevision
      })
    }
    if (existing.operation === 'UPSERT_PLAYLIST' || mutation.operation === 'UPSERT_PLAYLIST') {
      return this.replacePlaylistMutation(queue, {
        ...mutation,
        origin: existing.origin,
        clientMutationId: newPlaylistId(),
        operation: 'UPSERT_PLAYLIST',
        expectedRevision: existing.expectedRevision,
        playlist: clone(playlist),
        createdAt: Date.now()
      })
    }
    if (existing.operation === 'ADD_TRACKS' && mutation.operation === 'ADD_TRACKS') {
      const tracks = new Map<string, Record<string, unknown>>(
        [...((existing.tracks as Array<Record<string, unknown>>) ?? []), ...((mutation.tracks as Array<Record<string, unknown>>) ?? [])].map(
          (t) => [t.id as string, t]
        )
      )
      return this.replacePlaylistMutation(queue, {
        ...mutation,
        expectedRevision: existing.expectedRevision,
        tracks: [...tracks.values()]
      })
    }
    if (existing.operation === 'REMOVE_TRACKS' && mutation.operation === 'REMOVE_TRACKS') {
      return this.replacePlaylistMutation(queue, {
        ...mutation,
        expectedRevision: existing.expectedRevision,
        trackIds: [...new Set([...((existing.trackIds as string[]) ?? []), ...((mutation.trackIds as string[]) ?? [])])]
      })
    }
    if (existing.operation === 'REORDER_TRACKS' && mutation.operation === 'REORDER_TRACKS') {
      return this.replacePlaylistMutation(queue, {
        ...mutation,
        expectedRevision: existing.expectedRevision
      })
    }
    return this.replacePlaylistMutation(queue, {
      queueVersion: 2,
      origin: existing.origin,
      clientMutationId: newPlaylistId(),
      operation: 'REPLACE_TRACKS',
      playlistId: playlist.id,
      expectedRevision: existing.expectedRevision,
      playlist: { ...clone(playlist), tracks: [] },
      tracks: clone(playlist.tracks),
      createdAt: Date.now()
    })
  }

  private expectedRevision(queue: Array<Record<string, unknown>>, playlistId: string, playlist?: Playlist): number | undefined {
    const pending = queue.find((m) => m.playlistId === playlistId)
    return (pending?.expectedRevision as number | undefined) ?? (playlist && playlist.revision > 0 ? playlist.revision : undefined)
  }

  private replacePlaylistMutation(queue: Array<Record<string, unknown>>, mutation: Record<string, unknown>): Array<Record<string, unknown>> {
    return [...queue.filter((m) => m.playlistId !== mutation.playlistId), mutation]
  }
}

export const playlistLibrary = new PlaylistLibrary()

/** 歌单错误 → 错误信息对象 */
export function playlistErrorInfo(err: unknown): { code: string; message: string } {
  return err instanceof PlaylistLibraryError
    ? { code: err.code, message: err.message }
    : err && typeof err === 'object' && typeof (err as Record<string, unknown>).code === 'string'
      ? { code: (err as Record<string, unknown>).code as string, message: err instanceof Error ? err.message : '歌单操作失败，请稍后重试' }
      : { code: 'PLAYLIST_OPERATION_FAILED', message: err instanceof Error ? err.message : '歌单操作失败，请稍后重试' }
}
