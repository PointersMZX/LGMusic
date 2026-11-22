/** 主进程 API 封装（与 preload electronAPI 对应） */

type AnyRecord = Record<string, any>

interface ElectronAPI {
  send: (channel: string, data?: unknown) => void
  invoke: (channel: string, data?: unknown) => Promise<AnyRecord>
  on: (channel: string, listener: (...args: unknown[]) => void) => void
  off: (channel: string, listener: (...args: unknown[]) => void) => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export const api = window.electronAPI

export interface UnifiedTrack {
  rid: string
  name: string
  artist: string
  album?: string
  pic?: string
  duration?: number | string
  hash?: string
  sqHash?: string
  source: string
  raw?: AnyRecord
}

/** 各源搜索结果 → 统一曲目列表 */
export function normalizeSearchResult(source: string, res: AnyRecord): { tracks: UnifiedTrack[]; total?: number } {
  if (!res) return { tracks: [] }
  if (source === 'kw') {
    const list = res.abslist || res.list || []
    const tracks: UnifiedTrack[] = list.map((it: AnyRecord) => ({
      rid: String(it.RID ?? it.rid ?? it.MUSICRID?.replace(/^MUSIC_/, '') ?? ''),
      name: String(it.SONGNAME ?? it.NAME ?? '').replace(/<em>|<\/em>/g, ''),
      artist: String(it.ARTIST ?? '').replace(/<em>|<\/em>/g, ''),
      album: it.ALBUM ? String(it.ALBUM).replace(/<em>|<\/em>/g, '') : undefined,
      pic: it.hts_MVPIC || it.web_albumpic_short || it.ALUMPIC,
      duration: Number(it.DURATION) || undefined,
      source: 'kw',
      raw: it
    }))
    return { tracks: tracks.filter((t) => t.rid), total: Number(res.TOTAL) || undefined }
  }
  if (source === 'wy') {
    const songs = res.result?.songs || res.songs || []
    const tracks: UnifiedTrack[] = songs.map((it: AnyRecord) => ({
      rid: String(it.id),
      name: String(it.name),
      artist: Array.isArray(it.ar) ? it.ar.map((a: AnyRecord) => a.name).join(' & ') : String(it.artists?.[0]?.name ?? ''),
      album: it.album?.name ?? it.al?.name,
      pic: it.album?.picUrl ?? it.al?.picUrl,
      duration: Number(it.duration || it.dt || 0) > 10000 ? Math.floor(Number(it.duration || it.dt) / 1000) : Number(it.duration || it.dt) || undefined,
      source: 'wy',
      raw: it
    }))
    return { tracks, total: res.result?.songCount }
  }
  if (source === 'qq') {
    const list = res.data?.song?.list || res.req?.data?.body?.song?.list || []
    const tracks: UnifiedTrack[] = list.map((it: AnyRecord) => ({
      rid: String(it.mid),
      name: String(it.name || it.title || ''),
      artist: Array.isArray(it.singer) ? it.singer.map((s: AnyRecord) => s.name).join(' & ') : '',
      album: it.album?.name,
      pic: it.album?.mid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${it.album.mid}.jpg` : undefined,
      duration: Number(it.interval) || undefined,
      source: 'qq',
      raw: it
    }))
    return { tracks }
  }
  if (source === 'kg') {
    const list = res.data?.lists || res.data?.info || []
    const tracks: UnifiedTrack[] = list.map((it: AnyRecord) => {
      const fileName = String(it.filename || it.name || '')
      const parts = fileName.split(' - ')
      return {
        rid: String(it.hash || it.HASH || ''),
        name: parts.length > 1 ? parts.slice(1).join(' - ') : fileName,
        artist: parts.length > 1 ? parts[0] : String(it.singername || ''),
        album: it.album_name ?? it.albumname,
        pic: (it.cover || it.img || it.image || '').replace('{size}', '480').replace('/{size}', '/480'),
        duration: Number(it.duration || it.timelength || 0) > 10000 ? Math.floor(Number(it.duration || it.timelength) / 1000) : Number(it.duration) || undefined,
        hash: String(it.hash || ''),
        sqHash: String(it.sqhash || it.sq_hash || ''),
        source: 'kg',
        raw: it
      }
    })
    return { tracks: tracks.filter((t) => t.rid), total: res.data?.total }
  }
  if (source === 'mg') {
    const list = res.data?.songData || res.data?.songResultData || []
    const tracks: UnifiedTrack[] = list.map((it: AnyRecord) => ({
      rid: String(it.contentId || it.copyrightId || ''),
      name: String(it.songName || it.name || ''),
      artist: Array.isArray(it.singers) ? it.singers.map((s: AnyRecord) => s.name).join(' & ') : String(it.singerName || ''),
      album: it.album,
      pic: it.albumImg || it.img,
      duration: Number(it.duration) || undefined,
      source: 'mg',
      raw: it
    }))
    return { tracks: tracks.filter((t) => t.rid) }
  }
  if (source === 'bili') {
    const list = res.data || []
    const tracks: UnifiedTrack[] = list.map((it: AnyRecord) => ({
      rid: String(it.rid || it.id || ''),
      name: String(it.name || it.title || ''),
      artist: String(it.artist || it.singer || ''),
      album: '哔哩哔哩',
      pic: it.pic || it.cover,
      duration: it.durationSeconds || it.duration,
      source: 'bili',
      raw: it
    }))
    return { tracks, total: res.total }
  }
  return { tracks: [] }
}

/** 搜索（按源分发） */
export async function searchSource(source: string, keyword: string, page = 0, limit = 30): Promise<{ tracks: UnifiedTrack[]; total?: number }> {
  const handlerMap: Record<string, string> = {
    kw: 'search-kw',
    wy: 'search-wy',
    qq: 'search-qq',
    kg: 'search-kg',
    mg: 'search-mg',
    bili: 'search-bili'
  }
  const channel = handlerMap[source]
  if (!channel) return { tracks: [] }
  const res = await api.invoke(channel, { name: keyword, page, limit })
  return normalizeSearchResult(source, res)
}

export interface ResolveResult {
  url: string
  backupUrls?: string[]
  headers?: Record<string, string>
  playbackHeaders?: Record<string, string>
  mimeType?: string
  needDecrypt?: boolean
  level: string
  [key: string]: unknown
}

export async function resolveTrack(track: UnifiedTrack, level = 'standard'): Promise<ResolveResult> {
  // 外置化：播放地址解析改走音源插件 getMediaSource（不再用青听内置网关）
  const res = await pluginResolve(track, level)
  return res as ResolveResult
}

export function extractPlaybackUrl(res: ResolveResult): string {
  return res?.url || ''
}

// ---------------------------------------------------------------------------
// 音源插件运行时（本体不内置音源，搜索/播放由用户导入的音源脚本提供）
// ---------------------------------------------------------------------------

export interface PluginSourceMeta {
  fileName: string
  name: string
  importedAt: number
}

export async function pluginList(): Promise<PluginSourceMeta[]> {
  return ((await api.invoke('plugin-list').catch(() => [])) || []) as PluginSourceMeta[]
}

export async function pluginLoad(fileName: string): Promise<string> {
  return String(await api.invoke('plugin-load', fileName))
}

export async function pluginLoaded(): Promise<string | null> {
  const v = await api.invoke('plugin-loaded').catch(() => null)
  return v == null ? null : String(v)
}

export async function pluginCall(action: string, payload: Record<string, string>): Promise<AnyRecord> {
  return (await api.invoke('plugin-call', { action, payload })) as AnyRecord
}

/** 插件搜索结果 → UnifiedTrack[] */
function normalizePluginTracks(items: AnyRecord[], source: string): UnifiedTrack[] {
  return items
    .map((item) => {
      const musicItem = (item.musicItem ?? item) as AnyRecord
      const rid = String(musicItem.id ?? musicItem.rid ?? '')
      const name = String(musicItem.title ?? musicItem.name ?? '')
      const artist = String(
        (musicItem.artist as AnyRecord)?.name ?? musicItem.artist ?? musicItem.singer ?? ''
      )
      return {
        rid,
        name,
        artist,
        album: (musicItem.album as AnyRecord)?.name as string | undefined,
        pic:
          ((musicItem.cover ?? musicItem.artwork ?? musicItem.img) as string | undefined) ||
          ((musicItem.album as AnyRecord)?.cover as string | undefined),
        duration: Number(musicItem.duration) || undefined,
        source,
        raw: musicItem
      } as UnifiedTrack
    })
    .filter((t) => t.rid || t.name)
}

/** 通过当前加载的音源插件搜索 */
export async function pluginSearch(
  keyword: string,
  page = 1
): Promise<{ tracks: UnifiedTrack[]; total?: number }> {
  const source = (await pluginLoaded()) || ''
  const res = await pluginCall('searchMusic', {
    query: keyword,
    page: String(page),
    type: 'music'
  })
  const result = (res.result ?? res) as AnyRecord
  const list = (result.data as AnyRecord[]) || []
  return { tracks: normalizePluginTracks(list, source) }
}

/** 通过音源插件解析播放地址（getMediaSource） */
export async function pluginResolve(
  track: UnifiedTrack,
  level = 'standard'
): Promise<ResolveResult> {
  const musicItem = track.raw ?? {
    id: track.rid,
    title: track.name,
    artist: track.artist,
    album: track.album ?? '',
    cover: track.pic ?? '',
    duration: track.duration ?? 0
  }
  const res = await pluginCall('getMediaSource', {
    musicItem: JSON.stringify(musicItem),
    quality: level
  })
  const result = (res.result ?? res) as AnyRecord
  const url = String(result.url ?? '')
  if (!url) throw new Error(String(result.errorMessage || '音源未返回播放地址'))
  const headers: Record<string, string> = {}
  const resultHeaders = (result.headers ?? {}) as Record<string, unknown>
  Object.keys(resultHeaders).forEach((k) => {
    headers[k] = String(resultHeaders[k])
  })
  const userAgent = result.userAgent as string | undefined
  if (userAgent) headers['User-Agent'] = userAgent
  return {
    url,
    headers,
    playbackHeaders: Object.keys(headers).length > 0 ? headers : undefined,
    level: String(result.quality || level)
  } as ResolveResult
}
