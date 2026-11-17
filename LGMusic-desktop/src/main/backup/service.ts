/**
 * 歌单/收藏备份（JSON 文本备份 + 自动备份调度 + 导入恢复）。
 * 逻辑忠实还原自青听 v1.0.3 桌面端主进程（ro 类）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { app } from 'electron'
import { favoriteLibrary } from '../favorite/library'
import { playlistLibrary, normalizePlaylistId, trackFingerprint } from '../playlist/library'
import type { PlaylistTrack } from '../playlist/library'

export class BackupError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'BackupError'
    this.code = code
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const strClip = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max)

const BACKUP_SETTINGS_VERSION = 1
const SCOPES = ['custom', 'platform', 'favorites'] as const
type BackupScope = (typeof SCOPES)[number]
const PLATFORM_FIELDS: Array<[string, string]> = [
  ['wyPlaylists', 'wy'],
  ['kwPlaylists', 'kw'],
  ['qqPlaylists', 'tx'],
  ['kgPlaylists', 'kg']
]
const DOC_KEYS = ['playlists', ...PLATFORM_FIELDS.map(([key]) => key), 'favoriteSongs']
const DAY_MS = 24 * 60 * 60 * 1000
const AUTO_BACKUP_KEEP = 10
const BACKUP_FILE_MAX_BYTES = 64 * 1024 * 1024

/** 渠道键反归一（tx → qq，展示用） */
function displaySource(value: unknown, fallback?: string): string {
  const raw = String(value ?? '').trim().toLowerCase()
  const fixed = raw === 'tx' ? 'qq' : raw
  return fixed || fallback || 'wy'
}

function validId(value: unknown): string | undefined {
  return normalizePlaylistId(value) || undefined
}

function hashId(input: string): string {
  return trackFingerprint(input)
}

function urlOrNull(value: unknown): string | undefined {
  const raw = String(value ?? '').trim()
  return raw && /^https?:\/\//i.test(raw) ? raw : undefined
}

function durationNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const s = value > 10000 ? value / 1000 : value
    return s > 0 ? Math.floor(s) : undefined
  }
  const raw = String(value ?? '').trim()
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  const s = n > 10000 ? n / 1000 : n
  return s > 0 ? Math.floor(s) : undefined
}

function cleanScopes(input: unknown, fallback: BackupScope[] = []): BackupScope[] {
  const list = Array.isArray(input) ? input : fallback
  return [...new Set(list.filter((s): s is BackupScope => SCOPES.includes(s as BackupScope)))]
}

function cleanIntervalDays(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(90, Math.max(1, Math.floor(n))) : 3
}

function cleanScope(value: unknown): Record<BackupScope, boolean> {
  const raw = isObj(value) ? value : {}
  return {
    custom: raw.custom === true,
    platform: raw.platform === true,
    favorites: raw.favorites === true
  }
}

function timestampLabel(date: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function inferTypeFromName(fileName: string): 'manual' | 'automatic' | 'version' | 'import-safety' {
  const base = path.basename(fileName)
  if (base.startsWith('自动备份-')) return 'automatic'
  if (base.startsWith('手动备份-')) return 'manual'
  if (base.startsWith('版本备份-')) return 'version'
  return 'import-safety'
}

function isValidBackupFileName(fileName: string): boolean {
  const base = fileName.toLowerCase()
  if (!base.endsWith('.txt')) return false
  if (fileName.includes('.tmp-')) return false
  return /^(自动备份|手动备份|版本备份|导入前备份)-\d{8}-\d{6}\.txt$/.test(fileName)
}

interface BackupSettings {
  autoBackupEnabled: boolean
  intervalDays: number
  path: string
  scope: Record<BackupScope, boolean>
}

interface AutoStatus {
  lastCheckAt?: number
  lastBackupAt?: number
  lastFingerprint?: string
  lastPath?: string
  lastError?: string
}

export interface BackupDocument {
  backupMetadata?: {
    formatVersion?: number
    type?: string
    createdAt?: string
    appVersion?: string
    includedScopes?: string[]
    [key: string]: unknown
  }
  playlists?: Array<Record<string, unknown>>
  wyPlaylists?: Array<Record<string, unknown>>
  kwPlaylists?: Array<Record<string, unknown>>
  qqPlaylists?: Array<Record<string, unknown>>
  kgPlaylists?: Array<Record<string, unknown>>
  favoriteSongs?: Array<Record<string, unknown>>
  [key: string]: unknown
}

export class BackupService {
  private allowedExternalPaths = new Map<string, number>()
  private automaticPromise: Promise<Record<string, unknown>> | null = null
  private songDownloadPathProvider: (() => string | null | undefined) | null = null
  private userDataPath = ''

  bindUserData(userDataPath: string): void {
    this.userDataPath = userDataPath
  }

  private get dataDir(): string {
    const base = this.userDataPath || app.getPath('userData')
    const dir = path.join(base, 'data')
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  private get settingsFilePath(): string {
    return path.join(this.dataDir, 'backup-settings-v1.json')
  }

  private get legacyDefaultBackupPath(): string {
    return path.join(app.getPath('downloads'), '甘露音乐', '歌单数据备份')
  }

  private get defaultBackupPath(): string {
    try {
      const downloadDir = this.songDownloadPathProvider?.()
      if (downloadDir?.trim()) return path.resolve(downloadDir)
    } catch (err) {
      console.warn('[backup] 读取歌曲下载目录失败，使用系统下载目录', err)
    }
    return path.resolve(app.getPath('downloads'))
  }

  setSongDownloadPathProvider(provider: (() => string | null | undefined) | null): void {
    this.songDownloadPathProvider = provider
  }

  private defaultSettings(): { version: number; settings: BackupSettings; autoStatus: AutoStatus } {
    return {
      version: BACKUP_SETTINGS_VERSION,
      settings: {
        autoBackupEnabled: false,
        intervalDays: 3,
        path: this.defaultBackupPath,
        scope: { custom: true, platform: true, favorites: true }
      },
      autoStatus: {}
    }
  }

  private readSettingsFile(): { version: number; settings: BackupSettings; autoStatus: AutoStatus } {
    try {
      if (!fs.existsSync(this.settingsFilePath)) return this.defaultSettings()
      const json = JSON.parse(fs.readFileSync(this.settingsFilePath, 'utf-8'))
      if (!isObj(json)) return this.defaultSettings()
      const settings = isObj(json.settings) ? json.settings : {}
      const autoStatus = isObj(json.autoStatus) ? json.autoStatus : {}
      return {
        version: BACKUP_SETTINGS_VERSION,
        settings: {
          autoBackupEnabled: settings.autoBackupEnabled === true,
          intervalDays: cleanIntervalDays(settings.intervalDays),
          path: this.normalizeStoredBackupPath(settings.path),
          scope: cleanScope(settings.scope)
        },
        autoStatus: {
          lastCheckAt: typeof autoStatus.lastCheckAt === 'number' ? autoStatus.lastCheckAt : undefined,
          lastBackupAt: typeof autoStatus.lastBackupAt === 'number' ? autoStatus.lastBackupAt : undefined,
          lastFingerprint: typeof autoStatus.lastFingerprint === 'string' ? autoStatus.lastFingerprint : undefined,
          lastPath: typeof autoStatus.lastPath === 'string' ? autoStatus.lastPath : undefined,
          lastError: typeof autoStatus.lastError === 'string' ? autoStatus.lastError : undefined
        }
      }
    } catch (err) {
      console.warn('[backup] 读取备份设置失败，使用默认设置', err)
      return this.defaultSettings()
    }
  }

  private normalizeStoredBackupPath(value: unknown): string {
    const raw = strClip(value, 4096)
    if (!raw) return this.defaultBackupPath
    const resolved = path.resolve(raw)
    const legacy = path.resolve(this.legacyDefaultBackupPath)
    const same = process.platform === 'win32'
      ? resolved.toLowerCase() === legacy.toLowerCase()
      : resolved === legacy
    return same ? this.defaultBackupPath : raw
  }

  private writeSettingsFile(data: { version: number; settings: BackupSettings; autoStatus: AutoStatus }): void {
    const file = this.settingsFilePath
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify({ ...data, version: BACKUP_SETTINGS_VERSION }, null, 2), 'utf-8')
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
      throw new BackupError(
        'BACKUP_SETTINGS_WRITE_FAILED',
        `保存备份设置失败：${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  getSettings(): BackupSettings {
    return clone(this.readSettingsFile().settings)
  }

  getAutoStatus(): AutoStatus {
    return clone(this.readSettingsFile().autoStatus)
  }

  getDefaultBackupPath(): string {
    return this.defaultBackupPath
  }

  getDataSummary(): Record<string, number> {
    const playlists = playlistLibrary.getSnapshot().playlists.filter((p) => !p.deletedAt)
    const custom = playlists.filter((p) => p.type === 'custom')
    const imported = playlists.filter((p) => p.type === 'imported')
    return {
      customPlaylistCount: custom.length,
      customSongCount: custom.reduce((acc, p) => acc + p.tracks.length, 0),
      importedPlaylistCount: imported.length,
      importedSongCount: imported.reduce((acc, p) => acc + p.tracks.length, 0),
      favoriteCount: favoriteLibrary.getSnapshot().favorites.length
    }
  }

  getStatus(): Record<string, unknown> {
    const data = this.readSettingsFile()
    let fileCount = 0
    try {
      fileCount = this.listFiles().length
    } catch {
      /* 列表失败按 0 计 */
    }
    return {
      settings: clone(data.settings),
      autoStatus: clone(data.autoStatus),
      summary: this.getDataSummary(),
      fileCount
    }
  }

  async setSettings(patch: Partial<BackupSettings>): Promise<Record<string, unknown>> {
    const data = this.readSettingsFile()
    const wasEnabled = data.settings.autoBackupEnabled
    const scope = patch.scope === undefined ? data.settings.scope : cleanScope(patch.scope)
    if (!SCOPES.some((key) => scope[key])) {
      throw new BackupError('BACKUP_SCOPE_EMPTY', '至少选择一个备份范围')
    }
    data.settings = {
      autoBackupEnabled: patch.autoBackupEnabled ?? data.settings.autoBackupEnabled,
      intervalDays: patch.intervalDays === undefined ? data.settings.intervalDays : cleanIntervalDays(patch.intervalDays),
      path: patch.path === undefined ? data.settings.path : strClip(patch.path, 4096) || this.defaultBackupPath,
      scope
    }
    this.writeSettingsFile(data)
    if (!wasEnabled && data.settings.autoBackupEnabled) {
      await this.runAutomaticBackup({ force: true, trigger: 'settings' })
    }
    return this.getStatus()
  }

  async chooseImportPath(target: string): Promise<Record<string, unknown>> {
    const resolved = path.resolve(target)
    this.allowedExternalPaths.set(resolved, Date.now() + 10 * 60 * 1000)
    return this.inspectFile(resolved)
  }

  private toBackupSong(track: PlaylistTrack): Record<string, unknown> {
    return {
      rid: track.trackId,
      id: track.trackId,
      name: track.name,
      title: track.name,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
      source: displaySource(track.source),
      isLocal: track.source === 'local',
      fileSize: track.fileSize,
      fileFingerprint: track.fileFingerprint,
      metadataFingerprint: track.metadataFingerprint,
      localUri: track.localUri,
      localPath: track.localPath,
      localPicture: track.localPicture,
      url: track.localUri,
      path: track.localPath,
      picture: track.localPicture,
      pic: track.localPicture || track.coverUrl,
      addedAt: track.addedAt
    }
  }

  private collectPayload(scope: Record<BackupScope, boolean>): Record<string, unknown> {
    const playlists = playlistLibrary.getSnapshot().playlists
    const custom = scope.custom
      ? playlists
          .filter((p) => p.type === 'custom' && !p.deletedAt)
          .map((p) => ({
            name: p.name,
            image: p.coverUrl ?? null,
            songCount: p.tracks.length,
            songs: p.tracks.map((t) => this.toBackupSong(t)),
            syncId: p.id,
            syncRevision: p.revision
          }))
      : []
    const imported = scope.platform ? playlists.filter((p) => p.type === 'imported' && !p.deletedAt) : []
    const platformList = (source: string) =>
      imported
        .filter((p) => displaySource(p.source) === source)
        .map((p) => ({
          name: p.name,
          pic: p.coverUrl ?? '',
          originalId: p.externalId,
          total: p.tracks.length,
          songList: p.tracks.map((t) => this.toBackupSong(t)),
          syncId: p.id,
          syncRevision: p.revision
        }))
    const favorites = scope.favorites
      ? favoriteLibrary.getSnapshot().favorites.map((f) => ({
          rid: f.rid,
          name: f.name,
          artist: f.artist,
          album: f.album,
          pic: f.pic,
          duration: f.duration,
          source: displaySource(f.source),
          favoritedAt: f.favoritedAt
        }))
      : []
    return {
      playlists: custom,
      wyPlaylists: platformList('wy'),
      kwPlaylists: platformList('kw'),
      qqPlaylists: platformList('qq'),
      kgPlaylists: platformList('kg'),
      favoriteSongs: favorites
    }
  }

  private fingerprint(payload: unknown, scopes: string[]): string {
    return createHash('sha256').update(JSON.stringify({ includedScopes: scopes, payload })).digest('hex')
  }

  private writeBackupFile(dir: string, fileName: string, document: unknown): string {
    const resolved = path.resolve(dir)
    fs.mkdirSync(resolved, { recursive: true })
    const target = path.join(resolved, fileName)
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
    try {
      fs.writeFileSync(tmp, JSON.stringify(document), 'utf-8')
      try {
        fs.renameSync(tmp, target)
      } catch {
        fs.copyFileSync(tmp, target)
        fs.rmSync(tmp, { force: true })
      }
      return target
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* 清理失败可忽略 */
      }
      throw new BackupError('BACKUP_WRITE_FAILED', `写入备份文件失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async createBackup(input: {
    type: 'manual' | 'automatic' | 'version'
    scopes: BackupScope[]
    now?: Date
    fileName?: string
    fingerprint?: string
  }): Promise<{ path: string; type: string; createdAt: string; includedScopes: BackupScope[] }> {
    const settings = this.getSettings()
    const scopes = cleanScopes(input.scopes, cleanScopes(Object.keys(settings.scope)))
    if (!scopes.length) throw new BackupError('BACKUP_SCOPE_EMPTY', '至少选择一个备份范围')
    const scopeMap = {
      custom: scopes.includes('custom'),
      platform: scopes.includes('platform'),
      favorites: scopes.includes('favorites')
    }
    const now = input.now ?? new Date()
    const payload = this.collectPayload(scopeMap)
    const prefix = input.type === 'automatic' ? '自动备份-' : input.type === 'manual' ? '手动备份-' : '版本备份-'
    const document = {
      backupMetadata: {
        formatVersion: 3,
        type: input.type,
        createdAt: now.toISOString(),
        appVersion: app.getVersion(),
        includedScopes: scopes
      },
      ...payload
    }
    const fileName = input.fileName || `${prefix}${timestampLabel(now)}.txt`
    return {
      path: this.writeBackupFile(settings.path, fileName, document),
      type: input.type,
      createdAt: document.backupMetadata.createdAt as string,
      includedScopes: scopes
    }
  }

  listFiles(target = this.getSettings().path): Array<{ name: string; path: string; size: number; modifiedAt: number; type: string }> {
    const resolved = path.resolve(target)
    if (!fs.existsSync(resolved)) return []
    return fs
      .readdirSync(resolved, { withFileTypes: true })
      .filter((entry) => {
        if (!entry.isFile()) return false
        const name = entry.name.toLowerCase()
        if (!name.endsWith('.txt') || entry.name.includes('.tmp-') || !isValidBackupFileName(entry.name)) return false
        try {
          this.readDocument(path.join(resolved, entry.name))
          return true
        } catch {
          return false
        }
      })
      .map((entry) => {
        const file = path.join(resolved, entry.name)
        const stat = fs.statSync(file)
        return {
          name: entry.name,
          path: file,
          size: stat.size,
          modifiedAt: stat.mtimeMs,
          type: inferTypeFromName(entry.name)
        }
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt || b.name.localeCompare(a.name))
  }

  private isInsideDirectory(target: string, parent: string): boolean {
    const rel = path.relative(path.resolve(parent), path.resolve(target))
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
  }

  private canInspect(target: string): boolean {
    if (this.isInsideDirectory(target, this.getSettings().path)) return true
    const allowed = this.allowedExternalPaths.get(path.resolve(target))
    if (allowed && allowed > Date.now()) return true
    if (allowed) this.allowedExternalPaths.delete(path.resolve(target))
    return false
  }

  readDocument(target: string): { path: string; name: string; document: BackupDocument; summary: Record<string, unknown> } {
    const resolved = path.resolve(target)
    if (!resolved.toLowerCase().endsWith('.txt')) {
      throw new BackupError('BACKUP_FILE_TYPE_INVALID', '只能读取 .txt 备份文件')
    }
    if (!fs.existsSync(resolved)) throw new BackupError('BACKUP_FILE_NOT_FOUND', '备份文件不存在')
    if (fs.statSync(resolved).size > BACKUP_FILE_MAX_BYTES) {
      throw new BackupError('BACKUP_FILE_TOO_LARGE', '备份文件超过 64 MB，无法导入')
    }
    let json: unknown
    try {
      json = JSON.parse(fs.readFileSync(resolved, 'utf-8'))
    } catch {
      throw new BackupError('BACKUP_FILE_INVALID_JSON', '备份文件不是有效的 JSON')
    }
    const document = this.validateDocument(json)
    return {
      path: resolved,
      name: path.basename(resolved),
      document,
      summary: this.summarizeDocument(document, resolved)
    }
  }

  inspectFile(target: string): Record<string, unknown> {
    if (!this.canInspect(target)) {
      throw new BackupError('BACKUP_PATH_FORBIDDEN', '请从备份目录或文件选择器中打开备份')
    }
    const result = this.readDocument(target)
    return { path: result.path, name: result.name, summary: result.summary }
  }

  deleteFile(target: string): void {
    const resolved = path.resolve(target)
    const settings = this.getSettings()
    if (
      !this.isInsideDirectory(resolved, settings.path) ||
      path.extname(resolved).toLowerCase() !== '.txt' ||
      path.basename(resolved).includes('.tmp-')
    ) {
      throw new BackupError('BACKUP_DELETE_FORBIDDEN', '只能删除当前备份目录内的有效备份文件')
    }
    if (!fs.existsSync(resolved)) throw new BackupError('BACKUP_FILE_NOT_FOUND', '备份文件不存在')
    fs.rmSync(resolved)
    const data = this.readSettingsFile()
    if (data.autoStatus.lastPath && path.resolve(data.autoStatus.lastPath) === resolved) {
      data.autoStatus = {}
      this.writeSettingsFile(data)
    }
  }

  runAutomaticBackup(input: { force?: boolean; trigger?: string; now?: number }): Promise<Record<string, unknown>> {
    return this.automaticPromise
      ? this.automaticPromise
      : (this.automaticPromise = this.performAutomaticBackup(input).finally(() => {
          this.automaticPromise = null
        }))
  }

  private async performAutomaticBackup(input: { force?: boolean; trigger?: string; now?: number }): Promise<Record<string, unknown>> {
    const data = this.readSettingsFile()
    if (!data.settings.autoBackupEnabled) return this.getStatus()
    const now = input.now ?? Date.now()
    if (!input.force && data.autoStatus.lastCheckAt && now - data.autoStatus.lastCheckAt < data.settings.intervalDays * DAY_MS) {
      return this.getStatus()
    }
    const scopes = cleanScopes(Object.keys(data.settings.scope))
    const payload = this.collectPayload(data.settings.scope)
    const fingerprint = this.fingerprint(payload, scopes)
    if (!input.force && data.autoStatus.lastFingerprint === fingerprint) {
      data.autoStatus = { ...data.autoStatus, lastCheckAt: now, lastError: undefined }
      this.writeSettingsFile(data)
      return this.getStatus()
    }
    try {
      const result = await this.createBackup({
        type: 'automatic',
        scopes,
        now: new Date(now),
        fingerprint
      })
      this.pruneAutomaticBackups()
      data.autoStatus = {
        lastCheckAt: now,
        lastBackupAt: now,
        lastFingerprint,
        lastPath: result.path
      }
      this.writeSettingsFile(data)
      console.log(`[backup] ${input.trigger} 自动备份完成: ${result.path}`)
    } catch (err) {
      data.autoStatus = {
        ...data.autoStatus,
        lastCheckAt: now,
        lastError: err instanceof Error ? err.message : String(err)
      }
      this.writeSettingsFile(data)
      throw err
    }
    return this.getStatus()
  }

  private pruneAutomaticBackups(): void {
    this.listFiles()
      .filter((file) => file.name.startsWith('自动备份-'))
      .slice(AUTO_BACKUP_KEEP)
      .forEach((file) => {
        try {
          fs.rmSync(file.path, { force: true })
        } catch (err) {
          console.warn('[backup] 清理旧自动备份失败', file.path, err)
        }
      })
  }

  async importBackup(target: string, scopesInput: unknown): Promise<Record<string, unknown>> {
    if (!this.canInspect(target)) {
      throw new BackupError('BACKUP_PATH_FORBIDDEN', '请从备份目录或文件选择器中打开备份')
    }
    const result = this.readDocument(target)
    const available = new Set(result.summary.availableScopes as string[])
    const scopes = cleanScopes(scopesInput).filter((s) => available.has(s))
    if (!scopes.length) throw new BackupError('BACKUP_IMPORT_SCOPE_EMPTY', '请至少选择一个可导入的数据范围')
    const now = new Date()
    const safety = await this.createBackup({
      type: 'automatic',
      scopes: [...SCOPES],
      fileName: `导入前备份-${timestampLabel(now)}.txt`,
      now
    })
    const playlistState = playlistLibrary.captureRestoreState()
    const favoriteState = favoriteLibrary.captureRestoreState()
    try {
      if (scopes.includes('custom') || scopes.includes('platform')) {
        const playlists: unknown[] = []
        const types: Array<'custom' | 'imported'> = []
        if (scopes.includes('custom')) {
          playlists.push(...this.convertCustomPlaylists(result.document))
          types.push('custom')
        }
        if (scopes.includes('platform')) {
          playlists.push(...this.convertPlatformPlaylists(result.document))
          types.push('imported')
        }
        playlistLibrary.replaceActiveFromBackup(playlists, types)
      }
      if (scopes.includes('favorites')) {
        const favorites = Array.isArray(result.document.favoriteSongs) ? result.document.favoriteSongs : []
        favoriteLibrary.replaceActiveFromBackup(favorites)
      }
    } catch (err) {
      playlistLibrary.restoreState(playlistState as never)
      favoriteLibrary.restoreState(favoriteState as never)
      throw err
    }
    return {
      summary: result.summary,
      appliedScopes: scopes,
      safetyBackupPath: safety.path
    }
  }

  private validateDocument(json: unknown): BackupDocument {
    if (!isObj(json)) throw new BackupError('BACKUP_DOCUMENT_INVALID', '备份文件必须是 JSON 对象')
    if (!DOC_KEYS.some((key) => Array.isArray(json[key]))) {
      throw new BackupError('BACKUP_DOCUMENT_INVALID', '未找到有效的歌单备份数据')
    }
    this.validateCustomPlaylists(json.playlists)
    PLATFORM_FIELDS.forEach(([key]) => {
      if (json[key] !== undefined && !Array.isArray(json[key])) {
        throw new BackupError('BACKUP_DOCUMENT_INVALID', `${key} 数据格式错误`)
      }
    })
    if (json.favoriteSongs !== undefined && !Array.isArray(json.favoriteSongs)) {
      throw new BackupError('BACKUP_DOCUMENT_INVALID', 'favoriteSongs 数据格式错误')
    }
    if (json.backupMetadata !== undefined && !isObj(json.backupMetadata)) {
      throw new BackupError('BACKUP_DOCUMENT_INVALID', '备份元数据格式错误')
    }
    if (isObj(json.backupMetadata)) {
      const meta = json.backupMetadata as Record<string, unknown>
      const version = meta.formatVersion
      if (version !== undefined && version !== 1 && version !== 2 && version !== 3) {
        throw new BackupError('BACKUP_VERSION_UNSUPPORTED', `暂不支持该备份格式版本：${String(version)}`)
      }
      if (version === 2 || version === 3) {
        DOC_KEYS.forEach((key) => {
          if (!Array.isArray(json[key])) {
            throw new BackupError('BACKUP_DOCUMENT_INVALID', `新格式备份缺少 ${key} 数据`)
          }
        })
      }
      if (version === 3) {
        const scopes = cleanScopes(meta.includedScopes)
        if (!Array.isArray(meta.includedScopes) || !scopes.length) {
          throw new BackupError('BACKUP_DOCUMENT_INVALID', '版本 3 备份缺少有效的 includedScopes 数据')
        }
      }
    }
    return json as BackupDocument
  }

  private validateCustomPlaylists(input: unknown): void {
    if (input === undefined) return
    if (!Array.isArray(input)) throw new BackupError('BACKUP_DOCUMENT_INVALID', 'playlists 数据格式错误')
    const seen = new Set<string>()
    input.forEach((item, index) => {
      if (!isObj(item) || !strClip(item.name, 120)) {
        throw new BackupError('BACKUP_DOCUMENT_INVALID', `自建歌单数据格式错误（第 ${index + 1} 项）`)
      }
      const name = strClip(item.name, 120)
      if (seen.has(name)) {
        throw new BackupError('BACKUP_DOCUMENT_INVALID', `备份中存在重复歌单：${name}`)
      }
      seen.add(name)
      if (item.songs !== undefined && !Array.isArray(item.songs)) {
        throw new BackupError('BACKUP_DOCUMENT_INVALID', `歌单“${name}”的歌曲数据格式错误`)
      }
    })
  }

  private inferScopes(document: BackupDocument, version: number | undefined): BackupScope[] {
    if (version === 3 && isObj(document.backupMetadata)) {
      return cleanScopes((document.backupMetadata as Record<string, unknown>).includedScopes)
    }
    if (version === 2) return [...SCOPES]
    const scopes: BackupScope[] = []
    if (Array.isArray(document.playlists)) scopes.push('custom')
    if (PLATFORM_FIELDS.some(([key]) => Array.isArray(document[key]))) scopes.push('platform')
    return scopes
  }

  private summarizeDocument(document: BackupDocument, filePath: string): Record<string, unknown> {
    const meta = isObj(document.backupMetadata) ? document.backupMetadata : {}
    const version = typeof meta.formatVersion === 'number' ? meta.formatVersion : undefined
    const scopes = this.inferScopes(document, version)
    const scopeSet = new Set(scopes)
    const customPlaylists =
      scopeSet.has('custom') && Array.isArray(document.playlists)
        ? (document.playlists as Array<Record<string, unknown>>).filter(isObj)
        : []
    const importedCounts: Record<string, number> = {
      wy: scopeSet.has('platform') && Array.isArray(document.wyPlaylists) ? document.wyPlaylists.length : 0,
      kw: scopeSet.has('platform') && Array.isArray(document.kwPlaylists) ? document.kwPlaylists.length : 0,
      qq: scopeSet.has('platform') && Array.isArray(document.qqPlaylists) ? document.qqPlaylists.length : 0,
      kg: scopeSet.has('platform') && Array.isArray(document.kgPlaylists) ? document.kgPlaylists.length : 0
    }
    const favoriteCount =
      scopeSet.has('favorites') && Array.isArray(document.favoriteSongs)
        ? (document.favoriteSongs as unknown[]).filter(isObj).length
        : 0
    return {
      type: meta.type === 'manual' || meta.type === 'automatic' || meta.type === 'version' ? meta.type : inferTypeFromName(path.basename(filePath)),
      createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : undefined,
      appVersion: typeof meta.appVersion === 'string' ? meta.appVersion : undefined,
      formatVersion: version,
      customPlaylistCount: customPlaylists.length,
      customSongCount: customPlaylists.reduce(
        (acc, p) => acc + (Array.isArray(p.songs) ? p.songs.length : 0),
        0
      ),
      importedPlaylistCounts: importedCounts,
      importedPlaylistCount: importedCounts.wy + importedCounts.kw + importedCounts.qq + importedCounts.kg,
      favoriteCount,
      isLegacy: version === undefined,
      includedScopes: scopes,
      availableScopes: scopes
    }
  }

  private convertTrack(
    item: unknown,
    playlistSeed: string,
    fallbackSource: string,
    sortOrder: number
  ): PlaylistTrack | null {
    if (!isObj(item)) return null
    const source = displaySource(item.source, fallbackSource)
    const trackId = strClip(item.rid ?? item.trackId ?? item.id ?? item.musicId ?? item.songId, 512)
    const name = strClip(item.name ?? item.title, 255)
    if (!trackId || !name) return null
    return {
      id: validId(item.syncTrackId) || hashId(`track:${playlistSeed}:${source}:${trackId}`),
      source,
      trackId,
      name,
      artist: strClip(item.artist, 255) || '未知艺术家',
      album: strClip(item.album, 255) || undefined,
      coverUrl: urlOrNull(item.pic ?? item.cover ?? item.picture ?? item.coverUrl),
      duration: durationNumber(item.duration),
      fileSize:
        typeof item.fileSize === 'number' ? item.fileSize : typeof item.size === 'number' ? item.size : undefined,
      fileFingerprint: strClip(item.fileFingerprint, 64) || undefined,
      metadataFingerprint: strClip(item.metadataFingerprint, 64) || undefined,
      sortOrder,
      localUri: strClip(item.localUri ?? item.url, 2048) || undefined,
      localPath: strClip(item.localPath ?? item.path, 2048) || undefined,
      localPicture: strClip(item.localPicture ?? item.picture ?? item.pic, 2048) || undefined,
      addedAt: typeof item.addedAt === 'string' && item.addedAt ? item.addedAt : undefined,
      localData: item.isLocal === true && isObj(item) ? clone(item) : undefined
    }
  }

  private convertCustomPlaylists(document: BackupDocument): Array<Record<string, unknown>> {
    if (!Array.isArray(document.playlists)) return []
    const seen = new Set<string>()
    return document.playlists.flatMap((item, index) => {
      if (!isObj(item)) return []
      const name = strClip(item.name, 120)
      if (!name || seen.has(name)) return []
      seen.add(name)
      const id = validId(item.syncId) || hashId(`custom:${name}`)
      const tracks = (Array.isArray(item.songs) ? item.songs : [])
        .map((song, order) => this.convertTrack(song, id, 'wy', order))
        .filter((t): t is PlaylistTrack => !!t)
      return [
        {
          id,
          name,
          type: 'custom',
          coverUrl: urlOrNull(item.image ?? item.pic) ?? tracks.find((t) => t.coverUrl)?.coverUrl,
          sortOrder: index,
          revision: 0,
          tracks,
          deletedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ]
    })
  }

  private convertPlatformPlaylists(document: BackupDocument): Array<Record<string, unknown>> {
    const now = new Date().toISOString()
    let sortOrder = 0
    return PLATFORM_FIELDS.flatMap(([key, source]) =>
      Array.isArray(document[key])
        ? (document[key] as Array<Record<string, unknown>>).flatMap((item) => {
            if (!isObj(item)) return []
            const name = strClip(item.name, 120)
            if (!name) return []
            const externalId = strClip(item.originalId ?? item.externalId ?? item.id ?? name, 512)
            const id = validId(item.syncId) || hashId(`imported:${source}:${externalId}`)
            const rawTracks = Array.isArray(item.songList) ? item.songList : Array.isArray(item.songs) ? item.songs : []
            const tracks = rawTracks
              .map((song, order) => this.convertTrack(song, id, source, order))
              .filter((t): t is PlaylistTrack => !!t)
            return [
              {
                id,
                name,
                type: 'imported',
                source,
                externalId,
                coverUrl: urlOrNull(item.pic ?? item.image ?? item.coverUrl) ?? tracks.find((t) => t.coverUrl)?.coverUrl,
                sortOrder: sortOrder++,
                revision: 0,
                tracks,
                deletedAt: null,
                createdAt: now,
                updatedAt: now
              }
            ]
          })
        : []
    )
  }
}

export const backupService = new BackupService()
