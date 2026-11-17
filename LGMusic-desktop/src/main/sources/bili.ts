/**
 * 哔哩哔哩音源适配器。
 * 逻辑忠实还原自青听 v1.0.3 桌面端主进程（含分 P 展开、buvid 匿名指纹、播放地址解析）。
 */

export const BILI_SOURCE = 'bili'
export const BILI_LEVEL = 'bili192'
const BILI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
const SEARCH_PAGE_SIZE = 30
const DETAIL_CONCURRENCY = 4
const SESSION_CACHE_MIN = 5

class BiliHttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'BiliHttpError'
    this.status = status
  }
}

interface BuvidPair {
  buvid3: string
  buvid4: string
  updatedAt: number
}

let buvid: BuvidPair | null = null
/** 搜索游标缓存：key → 会话 */
const searchSessions = new Map<string, unknown>()

/** 清空搜索游标缓存 */
export function clearSearchSessions(): void {
  searchSessions.clear()
}

function formEncode(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v ?? ''))}`)
    .join('&')
}

async function biliFetch(url: string, init: RequestInit = {}, timeoutMs = 12000): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    const text = await res.text()
    if (!res.ok) throw new BiliHttpError(res.status, `哔哩哔哩请求失败（HTTP ${res.status}）`)
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('哔哩哔哩返回了无法解析的数据')
    }
  } finally {
    clearTimeout(timer)
  }
}

function httpsPic(url: unknown): string {
  const raw = String(url || '').trim()
  if (!raw) return ''
  if (raw.startsWith('//')) return `https:${raw}`
  return raw.replace(/^http:\/\//i, 'https://')
}

/** HTML 实体与 <em> 标签清理 */
function cleanText(input: unknown): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&quot;': '"',
    '&#39;': "'",
    '&lt;': '<',
    '&gt;': '>',
    '&nbsp;': ' '
  }
  return String(input || '')
    .replace(/<em[^>]*>/gi, '')
    .replace(/<\/em>/gi, '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&(amp|quot|#39|lt|gt|nbsp);/g, (m) => entities[m] || m)
    .trim()
}

function durationToSeconds(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value))
  const parts = String(value || '')
    .split(':')
    .map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return 0
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

function secondsToClock(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function trackKey(bvid: string, cid: string): string {
  return `bili:${String(bvid || '').trim()}:${String(cid || '').trim()}`
}

/** "bili:BVxxxx[:cid]" → { bvid, cid? } */
function parseBiliId(id: string): { bvid: string; cid?: string } {
  const m = String(id || '')
    .trim()
    .match(/^bili:(BV[0-9A-Za-z]+):?(\d+)?$/i)
  if (!m) throw new Error('哔哩哔哩歌曲 ID 无效')
  return { bvid: m[1], cid: m[2] || undefined }
}

/** 匿名设备标识 buvid3/buvid4（spi 接口） */
async function fetchBuvid(force = false): Promise<BuvidPair> {
  if (!force && buvid) return buvid
  const res = await biliFetch('https://api.bilibili.com/x/frontend/finger/spi', {
    headers: { 'User-Agent': BILI_UA }
  })
  const data = res?.data as Record<string, unknown> | undefined
  const b3 = String(data?.b_3 || '').trim()
  const b4 = String(data?.b_4 || '').trim()
  if (!b3 || !b4) throw new Error('无法获取哔哩哔哩匿名设备标识')
  buvid = { buvid3: b3, buvid4: b4, updatedAt: Date.now() }
  return buvid
}

async function buvidCookie(force = false): Promise<string> {
  const pair = await fetchBuvid(force)
  return `buvid3=${pair.buvid3}; buvid4=${pair.buvid4}`
}

function biliBaseHeaders(): Record<string, string> {
  return {
    'User-Agent': BILI_UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  }
}

interface BiliView {
  bvid: string
  cid?: string
  title: string
  pages?: Array<{ cid: string; part: string; duration?: number }>
  duration?: number
  owner?: { name?: string }
  pic?: string
}

/** 视频详情（web-interface/view） */
async function fetchView(bvid: string): Promise<BiliView> {
  const res = await biliFetch(`https://api.bilibili.com/x/web-interface/view?${formEncode({ bvid })}`, {
    headers: { ...biliBaseHeaders(), Referer: `https://www.bilibili.com/video/${bvid}` }
  })
  if (res?.code !== 0 || !res.data) throw new Error(String(res?.message || '无法获取哔哩哔哩视频详情'))
  return res.data as BiliView
}

/** 并发映射（保持顺序） */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

interface TrackOut {
  rid: string
  id: string
  musicId: string
  source: string
  name: string
  title: string
  artist: string
  singer: string
  album: string
  pic: string
  cover: string
  duration: string
  durationSeconds: number
  bvid: string
  cid: string
  levels: string[]
  quality: Array<{ size: string; quality: string; level: string }>
}

function buildTrack(item: Record<string, unknown> | null, view: BiliView | null, page: Record<string, unknown> | null): TrackOut {
  const bvid = String(item?.bvid || view?.bvid || '').trim()
  const cid = String(page?.cid || item?.cid || view?.cid || '').trim()
  const rawTitle = cleanText(item?.title || view?.title || '未知视频')
  const part = cleanText(page?.part || '')
  const name =
    Array.isArray(view?.pages) && view!.pages!.length > 1 && part ? `${part} · ${rawTitle}` : rawTitle
  const seconds = Number(page?.duration ?? item?.duration ?? view?.duration ?? 0)
  const artist = cleanText(item?.author || item?.owner?.name || view?.owner?.name || '未知UP主')
  const pic = httpsPic(item?.pic || view?.pic)
  return {
    rid: trackKey(bvid, cid),
    id: trackKey(bvid, cid),
    musicId: trackKey(bvid, cid),
    source: BILI_SOURCE,
    name,
    title: name,
    artist,
    singer: artist,
    album: '哔哩哔哩',
    pic,
    cover: pic,
    duration: secondsToClock(durationToSeconds(seconds)),
    durationSeconds: durationToSeconds(seconds),
    bvid,
    cid,
    levels: [BILI_LEVEL],
    quality: [{ size: '', quality: '高品质音质', level: BILI_LEVEL }]
  }
}

async function doSearch(keyword: string, page: number, refresh: boolean): Promise<Record<string, unknown>> {
  const cookie = await buvidCookie(refresh)
  const query = formEncode({
    context: '',
    page: Math.max(1, page),
    order: '',
    page_size: SEARCH_PAGE_SIZE,
    keyword,
    duration: '',
    tids_1: '',
    tids_2: '',
    __refresh__: true,
    _extra: '',
    highlight: 1,
    single_column: 0,
    platform: 'pc',
    from_source: '',
    search_type: 'video',
    dynamic_offset: 0
  })
  return biliFetch(`https://api.bilibili.com/x/web-interface/search/type?${query}`, {
    headers: {
      ...biliBaseHeaders(),
      Origin: 'https://search.bilibili.com',
      Referer: 'https://search.bilibili.com/',
      'Sec-Fetch-Site': 'same-site',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      Cookie: cookie
    }
  })
}

interface PendingGroup {
  item: Record<string, unknown>
  detail: Record<string, unknown> | BiliView
  pages: Array<Record<string, unknown>>
  nextPageIndex: number
}

interface SearchSession {
  tracks: TrackOut[]
  seenTrackIds: Set<string>
  pendingGroups: PendingGroup[]
  nextRemotePage: number
  remoteTotalPages: number
  hasMoreRemote: boolean
  lastAccessedAt: number
  lock: Promise<void>
}

function newSession(): SearchSession {
  return {
    tracks: [],
    seenTrackIds: new Set<string>(),
    pendingGroups: [],
    nextRemotePage: 1,
    remoteTotalPages: 0,
    hasMoreRemote: true,
    lastAccessedAt: Date.now(),
    lock: Promise.resolve()
  }
}

/** LRU 淘汰旧会话 */
function evictSessions(): void {
  if (searchSessions.size <= SESSION_CACHE_MIN) return
  const entries = [...searchSessions.entries()].sort(
    (a, b) => (a[1] as SearchSession).lastAccessedAt - (b[1] as SearchSession).lastAccessedAt
  )
  for (const [key] of entries.slice(0, searchSessions.size - SESSION_CACHE_MIN)) {
    searchSessions.delete(key)
  }
}

async function searchWithRetry(keyword: string, page: number): Promise<Record<string, unknown>> {
  let res: Record<string, unknown>
  try {
    res = await doSearch(keyword, page, false)
  } catch (err) {
    if (err instanceof BiliHttpError && err.status === 412) {
      buvid = null
      res = await doSearch(keyword, page, true)
    } else {
      throw err
    }
  }
  if (res?.code !== 0) throw new Error(String(res?.message || '哔哩哔哩搜索失败'))
  return res
}

async function hydrateDetails(
  items: Array<Record<string, unknown>>,
  expandMultiPart: boolean
): Promise<Array<PendingGroup | null>> {
  if (!expandMultiPart) {
    return items.map((item) =>
      String(item?.bvid || '').trim() ? { item, detail: item, pages: [], nextPageIndex: 0 } : null
    )
  }
  return mapLimited(items, DETAIL_CONCURRENCY, async (item) => {
    const bvid = String(item?.bvid || '').trim()
    if (!bvid) return null
    try {
      const view = await fetchView(bvid)
      return {
        item,
        detail: view as unknown as Record<string, unknown>,
        pages: (Array.isArray(view.pages) ? view.pages : []) as Array<Record<string, unknown>>,
        nextPageIndex: 0
      }
    } catch {
      return { item, detail: item, pages: [], nextPageIndex: 0 }
    }
  })
}

function pushTrack(session: SearchSession, track: TrackOut): void {
  const key = String(track?.rid || track?.id || '').trim()
  if (!key || session.seenTrackIds.has(key)) return
  session.seenTrackIds.add(key)
  session.tracks.push(track)
}

/** 就绪 pending 组顺序吐出曲目（多分 P 逐个展开） */
function drainPending(session: SearchSession, want: number, expandMultiPart: boolean): void {
  while (session.tracks.length < want && session.pendingGroups.length > 0) {
    const group = session.pendingGroups[0]
    const pages = expandMultiPart && group.pages.length > 0 ? group.pages : [group.pages[0]]
    const page = pages[group.nextPageIndex]
    pushTrack(session, buildTrack(group.item, group.detail as BiliView, page ?? null))
    group.nextPageIndex += 1
    if (group.nextPageIndex >= pages.length) session.pendingGroups.shift()
  }
}

async function fillSession(
  session: SearchSession,
  keyword: string,
  want: number,
  expandMultiPart: boolean
): Promise<void> {
  while (session.tracks.length < want) {
    drainPending(session, want, expandMultiPart)
    if (session.tracks.length >= want || !session.hasMoreRemote) break
    const res = await searchWithRetry(keyword, session.nextRemotePage)
    const data = res?.data as Record<string, unknown> | undefined
    const items = Array.isArray(data?.result) ? (data.result as Array<Record<string, unknown>>) : []
    const pageNo = Math.max(1, Number(data?.page || session.nextRemotePage))
    const numPages = Math.max(0, Number(data?.numPages || 0))
    session.remoteTotalPages = numPages
    session.nextRemotePage = pageNo + 1
    session.hasMoreRemote = items.length > 0 && (numPages > 0 ? pageNo < numPages : items.length >= SEARCH_PAGE_SIZE)
    const groups = await hydrateDetails(items, expandMultiPart)
    session.pendingGroups.push(...(groups.filter((g): g is PendingGroup => !!g)))
    if (items.length === 0) break
  }
  drainPending(session, want, expandMultiPart)
}

async function withSessionLock<T>(session: SearchSession, fn: () => Promise<T>): Promise<T> {
  const prev = session.lock
  let release: () => void = () => undefined
  session.lock = new Promise<void>((resolve) => {
    release = () => resolve()
  })
  await prev
  try {
    return await fn()
  } finally {
    release()
  }
}

/** B 站聚合搜索（分页游标在主进程内续拉） */
export async function biliSearch(
  keyword: string,
  page = 0,
  pageSize = 20,
  expandMultiPart = false
): Promise<{ data: TrackOut[]; page: number; total: number; totalPages: number; hasMore: boolean }> {
  const kw = String(keyword || '').trim()
  const pageIndex = Math.max(0, Number(page) || 0)
  if (!kw) return { data: [], page: pageIndex, hasMore: false }
  const size = Math.max(1, Math.min(50, Number(pageSize) || 20))
  const sessionKey = `${kw.toLocaleLowerCase()}:multiPart=${expandMultiPart ? 1 : 0}:limit=${size}`
  if (pageIndex === 0) searchSessions.set(sessionKey, newSession())
  const session = (searchSessions.get(sessionKey) as SearchSession | undefined) || newSession()
  searchSessions.set(sessionKey, session)
  session.lastAccessedAt = Date.now()
  evictSessions()
  return withSessionLock(session, async () => {
    const start = pageIndex * size
    const end = start + size
    await fillSession(session, kw, end, expandMultiPart)
    session.lastAccessedAt = Date.now()
    return {
      data: session.tracks.slice(start, end),
      page: pageIndex,
      total: session.tracks.length,
      totalPages: session.remoteTotalPages,
      hasMore: session.tracks.length > end || session.pendingGroups.length > 0 || session.hasMoreRemote
    }
  })
}

function collectUrls(data: Record<string, unknown>): string[] {
  return [
    data?.baseUrl,
    data?.base_url,
    ...(Array.isArray(data?.backupUrl) ? data.backupUrl : []),
    ...(Array.isArray(data?.backup_url) ? data.backup_url : [])
  ]
    .map((u) => String(u || '').trim())
    .filter(Boolean)
}

interface BiliResolveResult {
  code: number
  msg: string
  data: {
    rid: string
    url: string
    backupUrls: string[]
    headers: Record<string, string>
    playbackHeaders: Record<string, string>
    mimeType: string
    format: string
    level: string
    name: string
    artist: string
    album: string
    pic: string
    duration: number
    lrc: string
    bvid: string
    cid: string
  }
}

/** B 站播放地址解析（dash audio，优先 30280 高品质） */
export async function biliResolve(trackId: string): Promise<BiliResolveResult> {
  const parsed = parseBiliId(trackId)
  const view = await fetchView(parsed.bvid)
  const pages = Array.isArray(view?.pages) ? view.pages : []
  const page = parsed.cid ? pages.find((p) => String(p.cid) === parsed.cid) : pages[0]
  const cid = String(parsed.cid || page?.cid || view?.cid || '').trim()
  if (!cid) throw new Error('无法获取哔哩哔哩分 P 标识')
  const cookie = await buvidCookie()
  const referer = `https://www.bilibili.com/video/${parsed.bvid}`
  const res = await biliFetch(`https://api.bilibili.com/x/player/playurl?${formEncode({ bvid: parsed.bvid, cid, fnval: 16 })}`, {
    headers: { ...biliBaseHeaders(), Referer: referer, Cookie: cookie }
  })
  if (res?.code !== 0 || !res.data) throw new Error(String(res?.message || '无法获取哔哩哔哩播放地址'))
  const data = res.data as Record<string, unknown>
  const dash = data.dash as Record<string, unknown> | undefined
  const audioList = Array.isArray(dash?.audio)
    ? [...(dash!.audio as Array<Record<string, unknown>>)]
    : []
  audioList.sort((a, b) => Number(b?.bandwidth || 0) - Number(a?.bandwidth || 0))
  const audio = audioList.find((a) => Number(a?.id) === 30280) || audioList[0]
  const urls = collectUrls(audio || {})
  const fallbackUrl = String(
    ((data.durl as Array<Record<string, unknown>> | undefined)?.[0] as Record<string, unknown> | undefined)?.url || ''
  ).trim()
  const url = urls[0] || fallbackUrl
  if (!url) throw new Error('哔哩哔哩没有返回可用音频地址')
  const part = cleanText(page?.part || '')
  const title = cleanText(view?.title || '哔哩哔哩音频')
  const name = pages.length > 1 && part ? `${part} · ${title}` : title
  const artist = cleanText(view?.owner?.name || '未知UP主')
  const pic = httpsPic(view?.pic)
  const headers = { Referer: referer, 'User-Agent': BILI_UA, Accept: '*/*' }
  return {
    code: 200,
    msg: '成功',
    data: {
      rid: trackKey(parsed.bvid, cid),
      url,
      backupUrls: urls.slice(1),
      headers,
      playbackHeaders: headers,
      mimeType: String(audio?.mimeType || 'audio/mp4'),
      format: 'm4a',
      level: BILI_LEVEL,
      name,
      artist,
      album: '哔哩哔哩',
      pic,
      duration: Number(page?.duration || view?.duration || 0),
      lrc: '',
      bvid: parsed.bvid,
      cid
    }
  }
}
