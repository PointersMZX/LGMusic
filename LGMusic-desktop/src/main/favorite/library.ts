/**
 * 收藏库（本地 JSON 存储 + 账户隔离 + 同步变更队列）。
 * 逻辑忠实还原自青听 v1.0.3 桌面端主进程（ji 类 + Favorite 规范化区）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { app } from 'electron'

export class FavoriteLibraryError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'FavoriteLibraryError'
    this.code = code
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const clip = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max)
const clipOrUndef = (v: unknown, max: number): string | undefined => clip(v, max) || undefined
const urlOrUndef = (v: unknown): string | undefined =>
  typeof v === 'string' && /^https?:\/\//i.test(v) ? v : undefined

export const SOURCE_IDS = new Set(['wy', 'kw', 'qq', 'tx', 'kg', 'mg', 'bili', 'local'])
const SOURCE_ALIAS = new Set(['wy', 'kw', 'tx', 'kg', 'mg', 'bili', 'local'])

export function normalizeSourceRaw(value: unknown): string {
  const raw = clip(value, 16).toLowerCase()
  return raw === 'qq' ? 'tx' : raw || 'unknown'
}

export function toLegacySource(value: unknown): 'wy' | 'kw' | 'tx' | 'kg' | 'mg' | 'bili' | 'local' | null {
  const raw = normalizeSourceRaw(value)
  return raw === 'tx' ? 'qq' : SOURCE_ALIAS.has(raw) ? (raw as 'wy' | 'kw' | 'tx' | 'kg' | 'mg' | 'bili' | 'local') : null
}

export function favoriteIdOf(source: string, trackId: string): string {
  return createHash('sha256').update(`favorite:${source}:${trackId}`).digest('hex').slice(0, 26).toUpperCase()
}

function parseDuration(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const s = value > 10000 ? value / 1000 : value
    return Math.max(0, Math.round(s))
  }
  const raw = String(value ?? '').trim()
  if (!raw) return undefined
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw)
    return Math.max(0, Math.round(n > 10000 ? n / 1000 : n))
  }
  const parts = raw.split(':').map(Number)
  if (!parts.some((n) => !Number.isFinite(n))) return parts.reduce((acc, n) => acc * 60 + n, 0)
  return undefined
}

/** 秒 → 「mm:ss」展示 */
function durationLabel(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function timestampOf(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) return n
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return fallback
}

export interface Favorite {
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
  localUri?: string
  localPath?: string
  localPicture?: string
  favoritedAt: number
  revision: number
  deletedAt: string | null
  createdAt?: string
  updatedAt?: string
}

/** 原始曲目 → 收藏记录（非法返回 null） */
export function favoriteFromInput(
  input: unknown,
  now: number,
  existing?: Record<string, unknown>
): Favorite | null {
  if (!isObj(input)) return null
  const source = normalizeSourceRaw(input.source)
  const isLocal = source === 'local'
  const trackId = clip(
    (isLocal && (input.fileFingerprint || input.metadataFingerprint || input.localPath || input.path || input.localUri)) ||
      input.rid,
    128
  )
  if (!SOURCE_ALIAS.has(source) || !trackId || !clip(input.name, 255)) return null
  return {
    id: favoriteIdOf(source, trackId),
    source,
    trackId,
    name: clip(input.name, 255) || '未知歌曲',
    artist: clip(input.artist, 255) || '未知艺术家',
    album: clip(input.album, 255) || undefined,
    coverUrl: urlOrUndef(input.pic),
    duration: parseDuration(input.duration),
    fileSize: typeof input.fileSize === 'number' && Number.isFinite(input.fileSize) && input.fileSize >= 0 ? Math.floor(input.fileSize) : undefined,
    fileFingerprint: (isLocal && clip(input.fileFingerprint, 64)) || undefined,
    metadataFingerprint: (isLocal && clip(input.metadataFingerprint, 64)) || undefined,
    localUri:
      (isLocal &&
        clip(input.localUri || (/^(?:file|content):/i.test(input.pic || '') ? input.pic : ''), 2048)) ||
      undefined,
    localPath: (isLocal && clip(input.localPath || input.path, 2048)) || undefined,
    localPicture: (isLocal && clip(input.localPicture || (/^file:/i.test(input.pic || '') ? input.pic : ''), 2048)) || undefined,
    favoritedAt: typeof input.favoritedAt === 'number' && Number.isFinite(input.favoritedAt) && input.favoritedAt > 0 ? input.favoritedAt : (existing?.favoritedAt as number | undefined) ?? now,
    revision: (existing?.revision as number | undefined) ?? 0,
    deletedAt: null,
    createdAt: existing?.createdAt as string | undefined,
    updatedAt: existing?.updatedAt as string | undefined
  }
}

/** 收藏记录 → 旧缓存曲目形态 */
export function favoriteToLegacyTrack(favorite: Favorite): Record<string, unknown> | null {
  const source = toLegacySource(favorite.source)
  return !source || !favorite.trackId
    ? null
    : {
        rid: favorite.trackId,
        name: favorite.name || '未知歌曲',
        artist: favorite.artist || '未知艺术家',
        album: favorite.album,
        pic: favorite.localPicture || favorite.coverUrl,
        duration: durationLabel(favorite.duration),
        source,
        isLocal: source === 'local',
        localPath: source === 'local' ? favorite.localPath : undefined,
        path: source === 'local' ? favorite.localPath : undefined,
        localUri: source === 'local' ? favorite.localUri : undefined,
        localPicture: source === 'local' ? favorite.localPicture : undefined,
        fileSize: source === 'local' ? favorite.fileSize : undefined,
        fileFingerprint: source === 'local' ? favorite.fileFingerprint : undefined,
        metadataFingerprint: source === 'local' ? favorite.metadataFingerprint : undefined,
        favoritedAt: favorite.favoritedAt
      }
}

/** 服务端收藏记录规范化 */
export function normalizeFavorite(input: unknown, now = Date.now()): Favorite | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const raw = input as Record<string, unknown>
  const source = normalizeSourceRaw(raw.source)
  const trackId = clip(raw.trackId, 128)
  const id = clip(raw.id, 26)
  if (!source || source === 'unknown' || !trackId || !id) return null
  const revision = Number(raw.revision)
  const duration = Number(raw.duration)
  const fileSize = Number(raw.fileSize)
  return {
    id,
    source,
    trackId,
    name: clip(raw.name, 255) || '未知歌曲',
    artist: clip(raw.artist, 255) || '未知艺术家',
    album: clip(raw.album, 255) || undefined,
    coverUrl: urlOrUndef(raw.coverUrl),
    duration: Number.isFinite(duration) && duration >= 0 ? Math.floor(duration) : undefined,
    fileSize: Number.isFinite(fileSize) && fileSize >= 0 ? Math.floor(fileSize) : undefined,
    fileFingerprint: clip(raw.fileFingerprint, 64) || undefined,
    metadataFingerprint: clip(raw.metadataFingerprint, 64) || undefined,
    localUri: clip(raw.localUri, 2048) || undefined,
    localPath: clip(raw.localPath, 2048) || undefined,
    localPicture: clip(raw.localPicture, 2048) || undefined,
    favoritedAt: timestampOf(raw.favoritedAt, now),
    revision: Number.isFinite(revision) && revision >= 0 ? Math.floor(revision) : 0,
    deletedAt: typeof raw.deletedAt === 'string' && raw.deletedAt ? raw.deletedAt : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : undefined,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined
  }
}

/** 收藏 → 服务端 payload */
export function favoriteToPayload(favorite: Favorite): Record<string, unknown> {
  return {
    id: favorite.id.slice(0, 26),
    source: clip(favorite.source, 16) || 'unknown',
    trackId: clip(favorite.trackId, 128) || favorite.id,
    name: clip(favorite.name, 255) || '未知歌曲',
    artist: clip(favorite.artist, 255) || '未知艺术家',
    album: favorite.album,
    coverUrl: favorite.coverUrl,
    duration: favorite.duration,
    fileSize: favorite.fileSize,
    fileFingerprint: favorite.fileFingerprint,
    metadataFingerprint: favorite.metadataFingerprint,
    localUri: favorite.localUri,
    localPath: favorite.localPath,
    localPicture: favorite.localPicture,
    favoritedAt: new Date(favorite.favoritedAt).toISOString()
  }
}

/** 列表清洗（去重/规范化） */
export function cleanFavorites(input: unknown): Favorite[] {
  const list = Array.isArray(input) ? input : []
  return list
    .map((item) => normalizeFavorite(item))
    .filter((f): f is Favorite => !!f)
}

const cloneFavorites = (favorites: Favorite[]): Favorite[] => clone(favorites)

function newMutationId(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let ts = Date.now()
  let tsPart = ''
  for (let i = 0; i < 10; i += 1) {
    tsPart = alphabet[ts % alphabet.length] + tsPart
    ts = Math.floor(ts / alphabet.length)
  }
  let randPart = ''
  for (let i = 0; i < 16; i += 1) {
    randPart += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return `${tsPart}${randPart}`.slice(0, 26)
}

/** 收藏是否实质变化（需要推送） */
function favoriteChanged(before: Favorite | undefined, after: Favorite): boolean {
  if (!before) return true
  const a = favoriteToPayload(before)
  const b = favoriteToPayload(after)
  delete (a as Record<string, unknown>).revision
  delete (b as Record<string, unknown>).revision
  return JSON.stringify(a) !== JSON.stringify(b)
}

interface FavoriteAccount {
  hasSnapshot: boolean
  favorites: Favorite[]
  queue: Array<Record<string, unknown>>
  cursor: number
  lastSuccessfulAt: string | null
}

interface FavoriteLibraryStore {
  version: number
  activeUserId?: string
  guest: { favorites: Favorite[] }
  accounts: Record<string, FavoriteAccount>
}

const emptyAccount = (): FavoriteAccount => ({
  hasSnapshot: false,
  favorites: [],
  queue: [],
  cursor: 0,
  lastSuccessfulAt: null
})

const emptyStore = (favorites: Favorite[] = []): FavoriteLibraryStore => ({
  version: 1,
  guest: { favorites },
  accounts: {}
})

export class FavoriteLibrary {
  private library: FavoriteLibraryStore | null = null
  private activeUserId: string | null = null
  private recoveryWarning = ''
  private localChangeListener: (() => void) | null = null
  private userDataPath = ''

  bindUserData(userDataPath: string): void {
    this.userDataPath = userDataPath
  }

  private get dataDirectory(): string {
    const base = this.userDataPath || app.getPath('userData')
    const dir = path.join(base, 'data')
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  private get filePath(): string {
    return path.join(this.dataDirectory, 'favorite-library-v1.json')
  }

  private get legacyCachePath(): string {
    return path.join(this.dataDirectory, 'favoriteSongs.json')
  }

  private loadLegacyGuestFavorites(): Favorite[] {
    try {
      if (!fs.existsSync(this.legacyCachePath)) return []
      const list = JSON.parse(fs.readFileSync(this.legacyCachePath, 'utf-8'))
      if (!Array.isArray(list)) return []
      const now = Date.now()
      return list
        .map((item, index) => {
          if (!isObj(item)) return null
          return favoriteFromInput(
            {
              rid: item.rid,
              name: item.name,
              artist: item.artist,
              album: item.album,
              pic: item.pic,
              duration: item.duration,
              source: item.source,
              favoritedAt: item.favoritedAt
            },
            now - index * 1000
          )
        })
        .filter((f): f is Favorite => !!f)
    } catch (err) {
      console.warn('[favorite-library] 读取旧收藏缓存失败:', err)
      return []
    }
  }

  private ensureLoaded(): FavoriteLibraryStore {
    if (this.library) return this.library
    const file = this.filePath
    if (!fs.existsSync(file)) {
      this.library = emptyStore(this.loadLegacyGuestFavorites())
      this.writeLibrary()
      return this.library
    }
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (!isObj(json)) throw new Error('收藏库根节点格式错误')
      const guest = cleanFavorites(isObj(json.guest) ? json.guest.favorites : [])
      const accounts: Record<string, FavoriteAccount> = {}
      if (isObj(json.accounts)) {
        Object.entries(json.accounts).forEach(([userId, store]) => {
          if (!userId || !isObj(store)) return
          accounts[userId] = {
            hasSnapshot: store.hasSnapshot === true,
            favorites: cleanFavorites(store.favorites),
            queue: Array.isArray(store.queue) ? clone(store.queue) : [],
            cursor: Number.isFinite(Number(store.cursor)) && Number(store.cursor) >= 0 ? Math.floor(Number(store.cursor)) : 0,
            lastSuccessfulAt: typeof store.lastSuccessfulAt === 'string' ? store.lastSuccessfulAt : null
          }
        })
      }
      this.library = {
        version: 1,
        activeUserId: typeof json.activeUserId === 'string' && json.activeUserId ? json.activeUserId : undefined,
        guest: { favorites: guest },
        accounts
      }
      this.activeUserId = this.library.activeUserId ?? null
      return this.library
    } catch (err) {
      this.backupCorruptedFile(file)
      this.library = emptyStore(this.loadLegacyGuestFavorites())
      this.activeUserId = null
      this.recoveryWarning = '收藏库文件损坏，已保留损坏副本并恢复可读取的本机收藏'
      console.error('[favorite-library] 收藏库恢复失败', err)
      this.writeLibrary()
      return this.library
    }
  }

  private backupCorruptedFile(file: string): void {
    try {
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`)
    } catch (err) {
      console.error('[favorite-library] 备份损坏收藏库失败', err)
    }
  }

  private writeJsonAtomically(file: string, data: unknown): void {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
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
      throw new FavoriteLibraryError(
        'FAVORITE_STORAGE_WRITE_FAILED',
        `保存收藏失败：${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private writeLibrary(): void {
    this.writeJsonAtomically(this.filePath, this.ensureLoaded())
  }

  private writeLegacyCache(favorites: Favorite[]): void {
    const tracks = favorites.filter((f) => !f.deletedAt).map(favoriteToLegacyTrack).filter((t): t is Record<string, unknown> => !!t)
    this.writeJsonAtomically(this.legacyCachePath, tracks)
  }

  setLocalChangeListener(listener: (() => void) | null): void {
    this.localChangeListener = listener
  }

  setActiveUser(userId: string | null): boolean {
    const library = this.ensureLoaded()
    const id = userId?.trim() || null
    if (id && !library.accounts[id]) library.accounts[id] = emptyAccount()
    if (this.activeUserId === id) return false
    this.activeUserId = id
    if (id) library.activeUserId = id
    else delete library.activeUserId
    this.writeLibrary()
    return true
  }

  getActiveUserId(): string | null {
    this.ensureLoaded()
    return this.activeUserId
  }

  ensureAccountInitialized(userId: string): void {
    const library = this.ensureLoaded()
    const account = this.getOrCreateAccount(userId)
    if (!account.hasSnapshot) {
      account.favorites = cloneFavorites(library.guest.favorites)
      account.hasSnapshot = true
      this.writeLibrary()
    }
  }

  getGuestFavorites(): Favorite[] {
    return cloneFavorites(this.ensureLoaded().guest.favorites)
  }

  getActiveFavorites(): Favorite[] {
    const library = this.ensureLoaded()
    return this.activeUserId
      ? cloneFavorites(this.getOrCreateAccount(this.activeUserId).favorites)
      : cloneFavorites(library.guest.favorites)
  }

  getAccountSyncData(userId: string): FavoriteAccount {
    const account = this.getOrCreateAccount(userId)
    return {
      hasSnapshot: account.hasSnapshot,
      favorites: cloneFavorites(account.favorites),
      queue: clone(account.queue),
      cursor: account.cursor,
      lastSuccessfulAt: account.lastSuccessfulAt ?? null
    }
  }

  updateAccountSyncState(
    userId: string,
    patch: {
      hasSnapshot?: boolean
      favorites?: unknown[]
      queue?: Array<Record<string, unknown>>
      cursor?: number
      lastSuccessfulAt?: string
    }
  ): void {
    const account = this.getOrCreateAccount(userId)
    if (patch.hasSnapshot !== undefined) account.hasSnapshot = patch.hasSnapshot
    if (patch.favorites) {
      account.favorites = cleanFavorites(patch.favorites)
      account.hasSnapshot = true
    }
    if (patch.queue) account.queue = clone(patch.queue)
    if (patch.cursor !== undefined) {
      account.cursor = Number.isFinite(patch.cursor) && patch.cursor >= 0 ? Math.floor(patch.cursor) : 0
    }
    if (patch.lastSuccessfulAt !== undefined) account.lastSuccessfulAt = patch.lastSuccessfulAt
    this.writeLibrary()
  }

  replaceActiveFavorites(favorites: unknown[]): void {
    const library = this.ensureLoaded()
    const cleaned = cleanFavorites(favorites)
    if (this.activeUserId) {
      const account = this.getOrCreateAccount(this.activeUserId)
      account.favorites = cleaned
      account.hasSnapshot = true
    } else {
      library.guest.favorites = cleaned
    }
    this.writeLibrary()
    this.writeLegacyCache(cleaned)
  }

  captureRestoreState(): Record<string, unknown> {
    const library = this.ensureLoaded()
    const userId = this.activeUserId
    if (!userId) {
      return { activeUserId: null, guestFavorites: cloneFavorites(library.guest.favorites) }
    }
    const account = this.getOrCreateAccount(userId)
    return {
      activeUserId: userId,
      account: clone({
        hasSnapshot: account.hasSnapshot,
        favorites: account.favorites,
        queue: account.queue,
        cursor: account.cursor,
        lastSuccessfulAt: account.lastSuccessfulAt ?? null
      })
    }
  }

  restoreState(state: {
    activeUserId: string | null
    guestFavorites?: unknown[]
    account?: Partial<FavoriteAccount> | null
  }): void {
    const library = this.ensureLoaded()
    if (!state.activeUserId) {
      library.guest.favorites = cleanFavorites(state.guestFavorites ?? [])
      this.activeUserId = null
      delete library.activeUserId
      this.writeLegacyCache(library.guest.favorites)
      this.writeLibrary()
      return
    }
    const account = this.getOrCreateAccount(state.activeUserId)
    account.hasSnapshot = state.account?.hasSnapshot ?? false
    account.favorites = cleanFavorites((state.account?.favorites as unknown[] | undefined) ?? [])
    account.queue = clone((state.account?.queue as Array<Record<string, unknown>> | undefined) ?? [])
    account.cursor = state.account?.cursor ?? 0
    account.lastSuccessfulAt = state.account?.lastSuccessfulAt ?? null
    this.activeUserId = state.activeUserId
    library.activeUserId = state.activeUserId
    this.writeLegacyCache(account.favorites)
    this.writeLibrary()
  }

  /** 备份整库恢复（旧缓存曲目列表） */
  replaceActiveFromBackup(input: unknown[]): {
    identity: { kind: 'account' | 'guest'; userId: string | null }
    favorites: Array<Record<string, unknown>>
    recoveryWarning?: string
  } {
    const library = this.ensureLoaded()
    const active = this.getActiveFavorites()
    const byKey = new Map<string, Favorite>(active.map((f) => [favoriteIdOf(f.source, f.trackId), f]))
    const now = Date.now()
    const seen = new Set<string>()
    const merged: Favorite[] = []
    input.forEach((item, index) => {
      if (!isObj(item)) return
      if (String(item.rid ?? '').trim() === '') return
      const prev = byKey.get(favoriteIdOf(normalizeSourceRaw(item.source), String(item.rid)))
      const favorite = favoriteFromInput(item, now - index * 1000, prev as unknown as Record<string, unknown> | undefined)
      if (!favorite || seen.has(favorite.id)) return
      seen.add(favorite.id)
      merged.push(favorite)
    })
    merged.sort((a, b) => b.favoritedAt - a.favoritedAt)
    if (this.activeUserId) {
      const account = this.getOrCreateAccount(this.activeUserId)
      const keptIds = new Set(merged.map((f) => f.id))
      let queue = clone(account.queue)
      merged.forEach((favorite) => {
        const prev = byKey.get(favoriteIdOf(favorite.source, favorite.trackId))
        if (favoriteChanged(prev, favorite)) {
          queue = this.replaceMutation(queue, {
            queueVersion: 1,
            origin: 'import',
            clientMutationId: newMutationId(),
            operation: 'UPSERT_FAVORITE',
            favoriteId: favorite.id,
            expectedRevision: prev && prev.revision > 0 ? prev.revision : undefined,
            favorite: { ...cloneFavorites([favorite])[0], revision: 0 },
            createdAt: Date.now()
          })
        }
      })
      active.forEach((favorite) => {
        if (keptIds.has(favorite.id)) return
        queue = this.replaceMutation(queue, {
          queueVersion: 1,
          origin: 'account-operation',
          clientMutationId: newMutationId(),
          operation: 'DELETE_FAVORITE',
          favoriteId: favorite.id,
          expectedRevision: favorite.revision > 0 ? favorite.revision : undefined,
          createdAt: Date.now()
        })
      })
      account.favorites = cloneFavorites(merged)
      account.queue = queue
      account.hasSnapshot = true
    } else {
      library.guest.favorites = cloneFavorites(merged)
    }
    this.writeLegacyCache(merged)
    this.writeLibrary()
    return {
      identity: {
        kind: this.activeUserId ? 'account' : 'guest',
        userId: this.activeUserId
      },
      favorites: merged.map(favoriteToLegacyTrack).filter((t): t is Record<string, unknown> => !!t),
      recoveryWarning: this.recoveryWarning || undefined
    }
  }

  /** 用外部曲目列表重建收藏（本机为准） */
  recordLocalFavorites(input: unknown[]): Record<string, unknown> {
    const library = this.ensureLoaded()
    const items = Array.isArray(input) ? input : []
    const active = this.getActiveFavorites()
    const byId = new Map(active.map((f) => [f.id, f]))
    const byKey = new Map(active.map((f) => [favoriteIdOf(f.source, f.trackId), f]))
    const now = Date.now()
    const collected = new Map<string, Favorite>()
    items.forEach((item, index) => {
      if (!isObj(item)) return
      const trackId = String(item.rid ?? '').trim()
      if (!trackId) return
      const source = String(item.source ?? 'wy')
      const prev = byKey.get(favoriteIdOf(normalizeSourceRaw(source), trackId))
      const favorite = favoriteFromInput(item, now - index * 1000, prev as unknown as Record<string, unknown> | undefined)
      if (favorite && !collected.has(favorite.id)) collected.set(favorite.id, favorite)
    })
    const merged = [...collected.values()].sort((a, b) => b.favoritedAt - a.favoritedAt)
    if (this.activeUserId) {
      const account = this.getOrCreateAccount(this.activeUserId)
      let queue = clone(account.queue)
      merged.forEach((favorite) => {
        const prev = byId.get(favorite.id)
        if (favoriteChanged(prev, favorite)) {
          queue = this.replaceMutation(queue, {
            queueVersion: 1,
            origin: 'account-operation',
            clientMutationId: newMutationId(),
            operation: 'UPSERT_FAVORITE',
            favoriteId: favorite.id,
            expectedRevision: prev && prev.revision > 0 ? prev.revision : undefined,
            favorite,
            createdAt: Date.now()
          })
        }
      })
      byId.forEach((favorite) => {
        if (collected.has(favorite.id)) return
        queue = this.replaceMutation(queue, {
          queueVersion: 1,
          origin: 'account-operation',
          clientMutationId: newMutationId(),
          operation: 'DELETE_FAVORITE',
          favoriteId: favorite.id,
          expectedRevision: favorite.revision > 0 ? favorite.revision : undefined,
          createdAt: Date.now()
        })
      })
      account.favorites = merged
      account.queue = queue
      account.hasSnapshot = true
      this.writeLibrary()
      this.writeLegacyCache(merged)
      this.localChangeListener?.()
    } else {
      library.guest.favorites = merged
      this.writeLibrary()
      this.writeLegacyCache(merged)
    }
    return this.getSnapshot()
  }

  /** 首次上传队列（登录后初始化本地收藏推送） */
  enqueueInitialUploads(userId: string, favorites: unknown[]): Array<Record<string, unknown>> {
    const account = this.getOrCreateAccount(userId)
    let queue = clone(account.queue)
    const cleaned = cleanFavorites(favorites)
    cleaned.forEach((favorite) => {
      queue = this.replaceMutation(queue, {
        queueVersion: 1,
        origin: 'import',
        clientMutationId: newMutationId(),
        operation: 'UPSERT_FAVORITE',
        favoriteId: favorite.id,
        favorite: { ...cloneFavorites([favorite])[0], revision: 0 },
        createdAt: Date.now()
      })
    })
    account.favorites = cloneFavorites(cleaned)
    account.queue = queue
    account.hasSnapshot = true
    this.writeLibrary()
    this.writeLegacyCache(cleaned)
    return queue
  }

  getSnapshot(): {
    identity: { kind: 'account' | 'guest'; userId: string | null }
    favorites: Array<Record<string, unknown>>
    recoveryWarning?: string
  } {
    const library = this.ensureLoaded()
    const userId = this.activeUserId
    return {
      identity: {
        kind: userId && library.accounts[userId] ? 'account' : 'guest',
        userId
      },
      favorites: this.getActiveFavorites().map(favoriteToLegacyTrack).filter((t): t is Record<string, unknown> => !!t),
      recoveryWarning: this.recoveryWarning || undefined
    }
  }

  private getOrCreateAccount(userId: string): FavoriteAccount {
    const library = this.ensureLoaded()
    if (!library.accounts[userId]) library.accounts[userId] = emptyAccount()
    return library.accounts[userId]
  }

  private replaceMutation(queue: Array<Record<string, unknown>>, mutation: Record<string, unknown>): Array<Record<string, unknown>> {
    const existing = queue.find((m) => m.favoriteId === mutation.favoriteId)
    return [
      ...queue.filter((m) => m.favoriteId !== mutation.favoriteId),
      { ...mutation, expectedRevision: existing?.expectedRevision ?? mutation.expectedRevision }
    ]
  }
}

export const favoriteLibrary = new FavoriteLibrary()

/** 收藏错误 → 错误信息对象 */
export function favoriteErrorInfo(err: unknown): { code: string; message: string } {
  return err instanceof FavoriteLibraryError
    ? { code: err.code, message: err.message }
    : err && typeof err === 'object' && typeof (err as Record<string, unknown>).code === 'string'
      ? {
          code: (err as Record<string, unknown>).code as string,
          message: err instanceof Error ? err.message : '收藏操作失败，请稍后重试'
        }
      : { code: 'FAVORITE_OPERATION_FAILED', message: err instanceof Error ? err.message : '收藏操作失败，请稍后重试' }
}
