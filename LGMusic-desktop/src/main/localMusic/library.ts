/**
 * 本地音乐库（目录扫描 + taglib 元数据 + 封面缓存）。
 * 逻辑忠实还原自青听 v1.0.3 桌面端主进程（Wo 类 + 音频元数据函数）。
 */
import fs from 'node:fs'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { app, type WebContents } from 'electron'

const AUDIO_EXTENSIONS = new Set([
  '.aac',
  '.aiff',
  '.ape',
  '.flac',
  '.m4a',
  '.mp3',
  '.mp4',
  '.oga',
  '.ogg',
  '.opus',
  '.wav',
  '.wma',
  '.wv'
])
const SCAN_TICK_MS = 80
const COVER_CACHE_MAX = 120
const COVER_MAX_BYTES = 6 * 1024 * 1024

const AUDIO_EXT_RE = /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/

function isAudioFile(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

/** win32 大小写不敏感路径键 */
function pathKey(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/** 父目录包含判断（win32 大小写不敏感） */
function isPathInside(parent: string, child: string): boolean {
  const a = path.resolve(parent)
  const b = path.resolve(child)
  if (process.platform === 'win32') {
    const lower = (v: string) => v.toLowerCase()
    return lower(b).startsWith(lower(a) + path.sep) || lower(a) === lower(b)
  }
  return b.startsWith(a + path.sep) || a === b
}

/** taglib 读取音频元数据（会 dispose） */
function readAudioMeta(
  filePath: string
): { title: string; artist: string; album: string; duration: number; hasCover: boolean; lyric: string } | null {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const taglib = require('node-taglib-sharp') as {
    File: {
      createFromPath: (p: string) => {
        tag: {
          title: string
          performers: string[] | string
          album: string
          pictures?: Array<{ data: { toByteArray: () => Uint8Array } }>
          lyrics?: string
        }
        properties: { durationMilliseconds?: number; duration?: { totalSeconds?: number } }
        dispose?: () => void
      }
    }
  }
  let file: ReturnType<typeof taglib.File.createFromPath> | null = null
  try {
    file = taglib.File.createFromPath(filePath)
    const tag = file.tag
    const props = file.properties
    const durationMs = Number(
      props.durationMilliseconds ?? Number(props.duration?.totalSeconds || 0) * 1000
    )
    const lyric = String(tag.lyrics || '').replace(/^\uFEFF/, '').trim()
    return {
      title: String(tag.title || '').trim(),
      artist: Array.isArray(tag.performers) ? tag.performers.join(' / ').trim() : String(tag.performers || '').trim(),
      album: String(tag.album || '').trim(),
      duration: Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : 0,
      hasCover: Array.isArray(tag.pictures) && tag.pictures.length > 0,
      lyric
    }
  } finally {
    try {
      file?.dispose?.()
    } catch {
      /* dispose 失败可忽略 */
    }
  }
}

export interface LocalAudioMetaResult {
  success: boolean
  lyric: string
  title: string
  artist: string
  album: string
  lyricSource: 'embedded' | 'sidecar' | 'none'
  message?: string
}

/** 读本地音频元数据 + 歌词（内嵌优先，同名 .lrc 兜底） */
export function readLocalAudioMetadata(rawPath: unknown): LocalAudioMetaResult {
  const fail = (message: string): LocalAudioMetaResult => ({
    success: false,
    lyric: '',
    title: '',
    artist: '',
    album: '',
    lyricSource: 'none',
    message
  })
  if (typeof rawPath !== 'string' || !path.isAbsolute(rawPath)) return fail('无效的本地音频路径')
  const filePath = path.normalize(rawPath)
  try {
    if (!fs.statSync(filePath).isFile()) return fail('本地音频不存在')
  } catch {
    return fail('本地音频不存在')
  }
  if (!AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return fail('不支持读取该音频格式')
  let meta: ReturnType<typeof readAudioMeta> | null = null
  let metaError: unknown
  try {
    meta = readAudioMeta(filePath)
  } catch (err) {
    metaError = err
  }
  const embedded = meta?.lyric || ''
  const embeddedValid = AUDIO_EXT_RE.test(embedded)
  const sidecar = embeddedValid ? '' : findSidecarLyric(filePath)
  const lyric = embeddedValid ? embedded : sidecar
  const lyricSource = embeddedValid ? 'embedded' : sidecar ? 'sidecar' : 'none'
  return {
    success: true,
    lyric,
    title: meta?.title || '',
    artist: meta?.artist || '',
    album: meta?.album || '',
    lyricSource,
    ...(lyric ? {} : { message: metaError instanceof Error ? metaError.message : '未找到内嵌或同名歌词' })
  }
}

/** 同名 .lrc 兜底（≤6MB，BOM/编码自动判定） */
function findSidecarLyric(audioPath: string): string {
  const dir = path.dirname(audioPath)
  const base = path.basename(audioPath, path.extname(audioPath)).toLowerCase()
  let candidates: string[] = []
  try {
    candidates = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          path.extname(entry.name).toLowerCase() === '.lrc' &&
          path.basename(entry.name, path.extname(entry.name)).toLowerCase() === base
      )
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return ''
  }
  for (const name of candidates) {
    const file = path.join(dir, name)
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue
      const buf = fs.readFileSync(file)
      const text = decodeText(buf)
      if (AUDIO_EXT_RE.test(text)) return text
    } catch {
      /* 单个候选失败继续 */
    }
  }
  return ''
}

function decodeText(buf: Buffer): string {
  if (buf[0] === 255 && buf[1] === 254) return buf.toString('utf16le').replace(/^\uFEFF/, '').trim()
  if (buf[0] === 254 && buf[1] === 255) {
    return Buffer.from(buf).swap16().toString('utf16le').replace(/^\uFEFF/, '').trim()
  }
  return buf.toString('utf8')
}

// ---------------------------------------------------------------------------
// 本地音乐库
// ---------------------------------------------------------------------------

export interface LocalSong {
  id: string
  path: string
  url: string
  name: string
  artist: string
  album: string
  duration: number
  durationText: string
  format: string
  size: number
  modifiedAt: number
  hasCover: boolean
}

interface LocalStore {
  version: number
  directories: string[]
  songs: LocalSong[]
}

interface ScanProgress {
  phase: 'idle' | 'scanning' | 'completed' | 'error'
  processed: number
  total: number
  added: number
  updated: number
  reused: number
  message?: string
}

const emptyProgress = (): ScanProgress => ({ phase: 'idle', processed: 0, total: 0, added: 0, updated: 0, reused: 0 })

function songIdOf(filePath: string): string {
  return createHash('sha1').update(filePath).digest('hex').slice(0, 20)
}

function secondsToClock(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 「filename - artist - name.mp3」拆分 */
function parseFileName(filePath: string): { name: string; artist: string } {
  const base = path.basename(filePath, path.extname(filePath))
  const parts = base.split(' - ')
  if (parts.length > 1) {
    return { artist: parts[0].trim(), name: parts.slice(1).join(' - ').trim() }
  }
  return { name: base.trim(), artist: '' }
}

function normalizeSong(input: unknown): LocalSong | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  const songPath = String(raw.path ?? '').trim()
  if (!songPath || !path.isAbsolute(songPath)) return null
  const duration = Number(raw.duration)
  return {
    id: String(raw.id ?? songIdOf(songPath)),
    path: songPath,
    url: String(raw.url ?? pathToFileURL(songPath).href),
    name: String(raw.name ?? ''),
    artist: String(raw.artist ?? ''),
    album: String(raw.album ?? ''),
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    durationText: String(raw.durationText ?? ''),
    format: String(raw.format ?? ''),
    size: Number(raw.size) || 0,
    modifiedAt: Number(raw.modifiedAt) || 0,
    hasCover: raw.hasCover === true
  }
}

export class LocalMusicLibrary {
  private store: LocalStore | null = null
  private scanning = false
  private progress: ScanProgress = emptyProgress()
  private coverCache = new Map<string, { mtimeMs: number; dataUrl: string }>()
  private userDataPath = ''

  bindUserData(userDataPath: string): void {
    this.userDataPath = userDataPath
  }

  private getStorePath(): string {
    const base = this.userDataPath || app.getPath('userData')
    const dir = path.join(base, 'data')
    fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, 'local-music-library.json')
  }

  private loadStore(): LocalStore {
    if (this.store) return this.store
    const file = this.getStorePath()
    let raw: Record<string, unknown> = {}
    try {
      if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err) {
      console.warn('[local-music] 读取索引失败', err)
    }
    const directories = [
      ...new Set(
        (Array.isArray(raw.directories) ? (raw.directories as unknown[]) : [])
          .filter((d) => typeof d === 'string' && path.isAbsolute(d))
          .map((d) => path.normalize(d as string))
      )
    ]
    const songs = (Array.isArray(raw.songs) ? (raw.songs as unknown[]) : [])
      .map((s) => normalizeSong(s))
      .filter((s): s is LocalSong => !!s)
    this.store = { version: 1, directories, songs }
    return this.store
  }

  private saveStore(): void {
    const store = this.loadStore()
    fs.writeFileSync(this.getStorePath(), JSON.stringify(store, null, 2), 'utf8')
  }

  private sendProgress(webContents: WebContents | null, progress: ScanProgress): void {
    if (!webContents || webContents.isDestroyed()) return
    webContents.send('local-music-scan-progress', progress)
  }

  getState(): {
    directories: string[]
    songs: LocalSong[]
    scanning: boolean
    progress: ScanProgress
  } {
    const store = this.loadStore()
    return {
      directories: [...store.directories],
      songs: store.songs.map((s) => ({ ...s })),
      scanning: this.scanning,
      progress: { ...this.progress }
    }
  }

  addDirectories(inputs: unknown[]): ReturnType<LocalMusicLibrary['getState']> {
    const store = this.loadStore()
    const map = new Map(store.directories.map((d) => [pathKey(d), d]))
    for (const input of inputs) {
      if (typeof input !== 'string' || !path.isAbsolute(input)) continue
      try {
        if (!fs.statSync(input).isDirectory()) continue
      } catch {
        continue
      }
      const normalized = path.normalize(input)
      map.set(pathKey(normalized), normalized)
    }
    store.directories = [...map.values()]
    this.saveStore()
    return this.getState()
  }

  removeDirectory(input: unknown): ReturnType<LocalMusicLibrary['getState']> {
    const store = this.loadStore()
    const key = pathKey(String(input ?? ''))
    store.directories = store.directories.filter((d) => pathKey(d) !== key)
    store.songs = store.songs.filter((song) => store.directories.some((dir) => isPathInside(dir, song.path)))
    this.saveStore()
    return this.getState()
  }

  clear(): ReturnType<LocalMusicLibrary['getState']> {
    const store = this.loadStore()
    store.directories = []
    store.songs = []
    this.coverCache.clear()
    this.saveStore()
    return this.getState()
  }

  async scan(webContents: WebContents | null): Promise<ReturnType<LocalMusicLibrary['getState']>> {
    if (this.scanning) return this.getState()
    const store = this.loadStore()
    this.scanning = true
    this.progress = { ...emptyProgress(), phase: 'scanning' }
    this.sendProgress(webContents, this.progress)
    try {
      const validDirs: string[] = []
      for (const dir of store.directories) {
        try {
          if (fs.statSync(dir).isDirectory()) validDirs.push(dir)
        } catch {
          /* 目录失效剔除 */
        }
      }
      store.directories = validDirs
      if (validDirs.length === 0) {
        store.songs = []
        this.saveStore()
        this.progress = { ...emptyProgress(), phase: 'completed' }
        this.sendProgress(webContents, this.progress)
        this.scanning = false
        return this.getState()
      }
      const files = await this.collectAudioFiles(validDirs)
      const existing = new Map(store.songs.map((s) => [pathKey(s.path), s]))
      const merged: LocalSong[] = []
      let processed = 0
      let added = 0
      let updated = 0
      let reused = 0
      let lastTick = 0
      this.progress = { ...this.progress, total: files.length }
      this.sendProgress(webContents, this.progress)
      for (const file of files) {
        let stat: fs.Stats
        try {
          stat = await fsp.stat(file)
        } catch {
          processed += 1
          continue
        }
        if (!stat.isFile() || stat.size <= 0) {
          processed += 1
          continue
        }
        const modifiedAt = Math.floor(stat.mtimeMs)
        const prev = existing.get(pathKey(file))
        if (prev && prev.size === stat.size && prev.modifiedAt === modifiedAt) {
          merged.push(prev)
          reused += 1
        } else {
          let meta: ReturnType<typeof readAudioMeta> | null = null
          try {
            meta = readAudioMeta(file)
          } catch {
            /* 读失败用旧数据/文件名 */
          }
          const parsed = parseFileName(file)
          const duration = Number(meta?.duration || prev?.duration || 0)
          merged.push(
            normalizeSong({
              id: songIdOf(file),
              path: file,
              url: pathToFileURL(file).href,
              name: meta?.title || prev?.name || parsed.name,
              artist: meta?.artist || prev?.artist || parsed.artist || '未知艺术家',
              album: meta?.album || prev?.album || '',
              duration,
              durationText: secondsToClock(duration),
              format: path.extname(file).slice(1).toUpperCase(),
              size: stat.size,
              modifiedAt,
              hasCover: (meta?.hasCover ?? prev?.hasCover) === true
            })!
          )
          if (prev) updated += 1
          else added += 1
        }
        processed += 1
        const now = Date.now()
        if (now - lastTick >= SCAN_TICK_MS) {
          lastTick = now
          this.progress = {
            phase: 'scanning',
            processed,
            total: files.length,
            added,
            updated,
            reused
          }
          this.sendProgress(webContents, this.progress)
        }
        if (processed % 8 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
      }
      merged.sort((a, b) => {
        const artistCompare = a.artist.localeCompare(b.artist, 'zh-CN', { numeric: true, sensitivity: 'base' })
        return artistCompare !== 0 ? artistCompare : a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
      })
      store.songs = merged
      this.saveStore()
      this.progress = { phase: 'completed', processed, total: files.length, added, updated, reused }
      this.sendProgress(webContents, this.progress)
      this.scanning = false
      return this.getState()
    } catch (err) {
      const message = err instanceof Error ? err.message : '扫描本地音乐失败'
      this.progress = { ...this.progress, phase: 'error', message }
      this.sendProgress(webContents, this.progress)
      this.scanning = false
      return this.getState()
    } finally {
      this.scanning = false
    }
  }

  getCover(songId: string): string {
    const song = this.loadStore().songs.find((s) => s.id === songId)
    if (!song || !song.hasCover) return ''
    const cached = this.coverCache.get(song.id)
    if (cached && cached.mtimeMs === song.modifiedAt) return cached.dataUrl
    let dataUrl = ''
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const taglib = require('node-taglib-sharp') as {
      File: {
        createFromPath: (p: string) => {
          tag?: { pictures?: Array<{ data: { toByteArray: () => Uint8Array }; mimeType?: string }> }
          dispose?: () => void
        }
      }
    }
    let file: ReturnType<typeof taglib.File.createFromPath> | null = null
    try {
      file = taglib.File.createFromPath(song.path)
      const picture = file?.tag?.pictures?.[0]
      if (picture?.data) {
        const bytes = Buffer.from(picture.data.toByteArray())
        if (bytes.length > 0 && bytes.length <= COVER_MAX_BYTES) {
          dataUrl = `data:${picture.mimeType || 'image/jpeg'};base64,${bytes.toString('base64')}`
        }
      }
    } catch {
      dataUrl = ''
    } finally {
      try {
        file?.dispose?.()
      } catch {
        /* dispose 失败可忽略 */
      }
    }
    this.coverCache.set(song.id, { mtimeMs: song.modifiedAt, dataUrl })
    if (this.coverCache.size > COVER_CACHE_MAX) {
      const firstKey = this.coverCache.keys().next().value
      if (typeof firstKey === 'string') this.coverCache.delete(firstKey)
    }
    return dataUrl
  }

  private async collectAudioFiles(dirs: string[]): Promise<string[]> {
    const found = new Map<string, string>()
    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[] = []
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name === '.Trash' || entry.name === '@eaDir') continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
          continue
        }
        if (entry.isFile() && isAudioFile(full)) found.set(pathKey(full), full)
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    for (const dir of dirs) await walk(dir)
    return [...found.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
  }
}

export const localMusicLibrary = new LocalMusicLibrary()
