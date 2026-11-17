/**
 * 外部歌单导入（链接/ID 解析 + 分页拉取 + 入库）。
 * 逻辑忠实还原自青听 v1.0.3 桌面端主进程（导入区）。
 */
import { playlistLibrary } from './library'
import type { PlaylistTrack } from './library'
import { wyPlaylist } from '../sources/wy'
import { kwPlaylist } from '../sources/kw'
import { qqPlaylist } from '../sources/qq'
import { kgPlaylist } from '../sources/kg'
import { httpGetText } from '../sources/types'

type ImportSource = 'wy' | 'kw' | 'qq' | 'kg'

const SOURCE_LABELS: Record<ImportSource, string> = {
  wy: '网易云音乐',
  kw: '酷我音乐',
  qq: 'QQ 音乐',
  kg: '酷狗音乐'
}

const PAGE_SIZE = 100
const KW_MAX_PAGES = 200
const WY_PAGE_LIMIT = 1000
const SHORT_LINK_MAX_HOPS = 6
const SHORT_LINK_TIMEOUT_MS = 10000

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const strTrim = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const strOrNumber = (v: unknown): string =>
  typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : ''

/** 封面 URL 规范化（https + 尺寸 400） */
function normalizeCover(value: unknown): string {
  return strTrim(value)
    .replace(/^http:\/\//i, 'https://')
    .replace(/\/\{size\}/gi, '/400')
    .replace(/\{size\}/gi, '400')
}

/** 从混合文本中提取第一个 URL */
function firstUrlIn(text: string): string {
  const m = text.match(/https?:\/\/[^\s"'<>]+/i)
  return m?.[0] ?? text
}

const SOURCE_HOSTS: Record<'wy' | 'kw' | 'qq', string[]> = {
  wy: ['music.163.com', '163cn.tv'],
  kw: ['kuwo.cn', 'kw.cn'],
  qq: ['y.qq.com', 'qq.cn', 'sqq.com']
}

const hostMatches = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`)

function assertSourceUrl(source: 'wy' | 'kw' | 'qq', url: string): void {
  if (!/^https?:\/\//i.test(url)) return
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    throw new Error('歌单链接格式不正确')
  }
  if (!SOURCE_HOSTS[source].some((domain) => hostMatches(host, domain))) {
    throw new Error(`链接不是${SOURCE_LABELS[source]}歌单，请粘贴对应平台的歌单链接`)
  }
}

const pureDigits = (value: string): string => (/^\d{4,}$/.test(value) ? value : '')

/** 短链域名判定（163cn.tv / 移动端 QQ 链接） */
function isShortLinkHost(source: 'wy' | 'qq', url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (source === 'wy') return host === '163cn.tv'
    if (source === 'qq') {
      return (
        host === 'y.qq.com' ||
        host.endsWith('.y.qq.com') ||
        host === 'qq.cn' ||
        host.endsWith('.qq.cn') ||
        host === 'sqq.com' ||
        host.endsWith('.sqq.com')
      )
    }
  } catch {
    return false
  }
  return false
}

/** 短链跟随（手动 redirect，最多 6 跳） */
async function followShortLink(url: string): Promise<string> {
  let target = url
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SHORT_LINK_TIMEOUT_MS)
  try {
    for (let hop = 0; hop <= SHORT_LINK_MAX_HOPS; hop += 1) {
      const res = await fetch(target, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36'
        },
        signal: controller.signal
      })
      res.body?.cancel().catch(() => undefined)
      const location = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && location) {
        target = new URL(location, target).toString()
        continue
      }
      return res.url || target
    }
  } catch (err) {
    throw err instanceof Error && err.name === 'AbortError'
      ? new Error('短链解析超时，请检查网络后重试')
      : new Error(`短链解析失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
  }
  throw new Error('短链跳转次数过多，请使用完整歌单链接或歌单 ID')
}

/** 短链归一（支持 163cn.tv / QQ 移动链） */
async function resolveLink(source: ImportSource, input: string): Promise<string> {
  const raw = String(input ?? '').trim()
  if (!raw) return input
  const url = firstUrlIn(raw)
  try {
    assertSourceUrl(source === 'kg' ? 'kw' : source, url)
    return url
  } catch (err) {
    if (source !== 'wy' && source !== 'qq') throw err
    if (!isShortLinkHost(source, url)) throw err
  }
  try {
    const resolved = await followShortLink(url)
    assertSourceUrl(source, resolved)
    return resolved
  } catch (err) {
    try {
      assertSourceUrl(source, url)
      return url
    } catch {
      throw err
    }
  }
}

export function assertImportSource(source: unknown): ImportSource {
  const raw = String(source ?? '').trim().toLowerCase()
  if (raw === 'wy' || raw === 'kw' || raw === 'qq' || raw === 'kg') return raw
  throw new Error('请选择有效的歌单来源平台')
}

function extractFirstId(url: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const m = url.match(pattern)
    if (m?.[1]) return m[1]
  }
  return ''
}

/** 歌单链接/ID → { externalId, requestId } */
export function parsePlaylistInput(source: unknown, input: string): { externalId: string; requestId: string } {
  const kind = assertImportSource(source)
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('请输入歌单链接或 ID')
  const url = firstUrlIn(raw)
  if (kind === 'wy') {
    assertSourceUrl('wy', url)
    const id =
      extractFirstId(url, [/[?&#]id=(\d+)/i, /\/playlist\/(\d+)/i, /playlist_detail\/(\d+)/i]) || pureDigits(raw)
    if (!id) throw new Error('未识别到网易云音乐歌单 ID')
    return { externalId: id, requestId: id }
  }
  if (kind === 'kw') {
    assertSourceUrl('kw', url)
    const id =
      extractFirstId(url, [/[?&#](?:pid|id)=(\d+)/i, /playlist_detail\/(\d+)/i, /\/playlist\/(\d+)/i]) || pureDigits(raw)
    if (!id) throw new Error('未识别到酷我音乐歌单 ID')
    return { externalId: id, requestId: id }
  }
  if (kind === 'qq') {
    assertSourceUrl('qq', url)
    const id =
      extractFirstId(url, [/[?&#](?:id|disstid)=(\d+)/i, /\/playlist\/(\d+)/i, /\/taoge\/(\d+)/i]) || pureDigits(raw)
    if (!id) throw new Error('未识别到 QQ 音乐歌单 ID')
    return { externalId: id, requestId: id }
  }
  // 酷狗：仅酷狗码（纯数字）
  const codeMatch = raw.match(/^(?:酷狗码|小狗码)\s*[:：]?\s*(\d{4,})$/i)
  if (codeMatch?.[1]) return { externalId: codeMatch[1], requestId: codeMatch[1] }
  if (pureDigits(raw)) return { externalId: pureDigits(raw), requestId: pureDigits(raw) }
  const collectionMatch = raw.match(/^(collection_\d+_\d+_\d+(?:_\d+)?)$/i)
  if (collectionMatch) return { externalId: collectionMatch[1], requestId: collectionMatch[1] }
  throw /^https?:\/\//i.test(url)
    ? new Error('酷狗仅支持输入酷狗码（纯数字），不支持粘贴歌单链接')
    : new Error('请输入有效的酷狗码（纯数字）')
}

function durationToSeconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const s = value > 10000 ? value / 1000 : value
    return s > 0 ? Math.floor(s) : undefined
  }
  const raw = strTrim(value)
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

/** 拉取结果条目 → 歌单曲目 */
function trackFromFetched(item: unknown, source: ImportSource): PlaylistTrack | null {
  if (!isObj(item)) return null
  const hash = strTrim(item.hash)
  const trackId = strOrNumber(item.rid) || strOrNumber(item.id) || hash
  const name = strTrim(item.name)
  if (!trackId || !name) return null
  const sqHash = strTrim(item.sqHash)
  const duration = durationToSeconds(
    item.duration || item.songTimeMinutes || item.timelength || item.interval || item.timeLength || item.durationSeconds
  )
  const localData: Record<string, unknown> = {}
  if (hash) localData.hash = hash
  if (sqHash) localData.sqHash = sqHash
  if (duration !== undefined) {
    localData.durationLabel =
      typeof item.duration === 'string' && item.duration.trim()
        ? item.duration.trim()
        : `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`
  }
  return {
    id: '',
    source: source === 'qq' ? 'tx' : source,
    trackId,
    name,
    artist: strTrim(item.artist),
    album: strTrim(item.album) || undefined,
    coverUrl: normalizeCover(item.pic ?? item.coverUrl) || undefined,
    duration,
    localData: Object.keys(localData).length ? localData : undefined
  }
}

function assertPlaylistResult(result: unknown, source: ImportSource): Record<string, unknown> {
  if (!isObj(result) || Number(result.code) !== 200) {
    throw new Error(strTrim(isObj(result) ? result.msg : '') || `获取${SOURCE_LABELS[source]}歌单失败`)
  }
  if (!isObj(result.data)) throw new Error(`${SOURCE_LABELS[source]}歌单数据格式错误`)
  return result.data
}

async function fetchWy(id: string): Promise<Record<string, unknown>> {
  return assertPlaylistResult(await wyPlaylist(id, WY_PAGE_LIMIT), 'wy')
}

async function fetchKw(id: string): Promise<Record<string, unknown>> {
  const collected: Array<Record<string, unknown>> = []
  let first: Record<string, unknown> | null = null
  let total = 0
  for (let page = 1; page <= KW_MAX_PAGES; page += 1) {
    const data = assertPlaylistResult(await kwPlaylist(id, page, PAGE_SIZE), 'kw')
    first = first ?? data
    const list = Array.isArray(data.musicList) ? (data.musicList as Array<Record<string, unknown>>) : []
    collected.push(...list)
    total = Math.max(total, Number(data.totalCount ?? data.total) || collected.length)
    if (list.length < PAGE_SIZE || collected.length >= total) break
  }
  if (!first) throw new Error('获取酷我音乐歌单失败')
  return { ...first, musicList: collected, totalCount: total || collected.length }
}

async function fetchQq(id: string): Promise<Record<string, unknown>> {
  return assertPlaylistResult(await qqPlaylist(id), 'qq')
}

async function fetchKg(id: string): Promise<Record<string, unknown>> {
  return assertPlaylistResult(await kgPlaylist(id, 1), 'kg')
}

async function fetchPlaylist(source: ImportSource, id: string): Promise<Record<string, unknown>> {
  if (source === 'wy') return fetchWy(id)
  if (source === 'kw') return fetchKw(id)
  if (source === 'qq') return fetchQq(id)
  return fetchKg(id)
}

/** 导入外部歌单（解析 → 拉取 → 入库为 imported 歌单） */
export async function importPlaylist(input: { source: unknown; input: string }): Promise<Record<string, unknown>> {
  const source = assertImportSource(input.source)
  const resolved = await resolveLink(source, input.input)
  const parsed = parsePlaylistInput(source, resolved)
  const data = await fetchPlaylist(source, parsed.requestId)
  const externalId = parsed.externalId
  const tracks = (Array.isArray(data.musicList) ? (data.musicList as Array<Record<string, unknown>>) : [])
    .map((item) => trackFromFetched(item, source))
    .filter((t): t is PlaylistTrack => !!t)
  if (!tracks.length) {
    throw new Error(`未获取到${SOURCE_LABELS[source]}歌单歌曲，请检查歌单是否为空或链接是否有效`)
  }
  const fallbackName = `${SOURCE_LABELS[source]}歌单 ${externalId}`
  const firstCover = tracks.find((t) => t.coverUrl)?.coverUrl
  return playlistLibrary.upsertImportedPlaylist({
    source: source === 'qq' ? 'tx' : source,
    externalId,
    name: strTrim(data.name) || fallbackName,
    coverUrl: normalizeCover(data.img) || firstCover,
    tracks
  }) as unknown as Record<string, unknown>
}

/** 刷新已导入歌单 */
export async function refreshImportedPlaylist(playlistId: string): Promise<Record<string, unknown>> {
  const playlist = playlistLibrary.getImportedPlaylist(playlistId)
  const source = playlist.source === 'tx' ? 'qq' : (playlist.source as ImportSource | undefined)
  if (!source || !['wy', 'kw', 'qq', 'kg'].includes(source)) {
    throw new Error('当前歌单缺少可刷新的平台来源')
  }
  if (!playlist.externalId) throw new Error('当前歌单缺少平台歌单 ID')
  return (await importPlaylist({ source, input: playlist.externalId })).playlist as Record<string, unknown>
}
