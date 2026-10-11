/**
 * 官方渠道云解析客户端（钥匙模型）· 移动版
 *
 * 与桌面端同构：导入「星雨音乐官方音源（青听渠道）」JSON（`{name?,interface?,gateway?,lines:[...]}`）后，
 * 构造内置 6 渠道解析 api 挂进 `global.lx.apis`，虚拟源 id = `user_api_qingcloud`。
 * - 5 渠道（wy/kw/qq(=tx)/kg/mg）走青听渠道网关 `POST {gateway.resolve}`（缺省 musicserver.haitangw.cc）
 * - bili（星宝）走 B 站公开 `x/player/playurl`（非 WBI，客户端直连；青听渠道网关无 bili 线路）
 */
import { fetchData } from '@/core/init/userApi/request'

export const QINGCLOUD_API_ID = 'user_api_qingcloud'

/** 渠道音源 id → 我们的 OnlineSource（青听原生 `qq` = 我们的 `tx`） */
const QING_TO_LOCAL: Record<string, LX.OnlineSource> = {
  wy: 'wy',
  kw: 'kw',
  qq: 'tx',
  tx: 'tx',
  kg: 'kg',
  mg: 'mg',
  bili: 'bili',
}

const LOCAL_TO_QING: Record<string, string> = {
  wy: 'wy',
  kw: 'kw',
  tx: 'qq',
  kg: 'kg',
  mg: 'mg',
  bili: 'bili',
}

/** 官方渠道音质档 → 洛雪 LX.Quality */
const TIER_TO_QUALITY: Record<string, LX.Quality> = {
  standard: '128k',
  exhigh: '320k',
  lossless: 'flac',
  hires: 'flac24bit',
  sky: 'flac24bit',
  jyeffect: 'flac24bit',
  jymaster: 'flac24bit',
  atmos: 'flac',
  atmos_plus: 'flac24bit',
  clear: 'flac',
  bili192: '192k',
}

const QUALITY_TO_TIER: Record<string, string> = {
  '128k': 'standard',
  '192k': 'bili192',
  '320k': 'exhigh',
  flac: 'lossless',
  flac24bit: 'hires',
  ape: 'lossless',
  wav: 'hires',
}

export interface QingLine {
  id: string
  name: string
  levels: string[]
  enabled: boolean
  quality?: string
}

/** 青听渠道网关（由 B 型 JSON 的 `gateway` 字段携带；缺省回落默认端点） */
export interface QingGateway {
  resolve: string
  timeout: number
}

export const DEFAULT_GATEWAY: QingGateway = {
  resolve: 'https://musicserver.haitangw.cc/v1/music/resolve-url',
  timeout: 12_000,
}

export interface QingValidation {
  ok: boolean
  error?: string
  /** 归一化后的本地渠道配置（只保留可用渠道） */
  lines: Record<string, Array<{ name: string, levels: string[] }>>
  /** 各渠道可选 LX.Quality（用于 qualityList） */
  qualityList: LX.QualityList
  /** 网关（配置缺失/非法时回落默认端点） */
  gateway: QingGateway
}

/** 校验并归一化官方渠道 JSON；与桌面端同款约束（lines 必为数组、每项需 id/name/levels）。 */
export const validateQingLines = (raw: unknown): QingValidation => {
  const result: QingValidation = { ok: false, lines: {}, qualityList: {}, gateway: { ...DEFAULT_GATEWAY } }
  let data: any = raw
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch (e: any) {
      result.error = 'JSON 解析失败：' + e.message
      return result
    }
  }
  const gw = data?.gateway
  if (gw && typeof gw === 'object') {
    const gwObj = gw as { resolve?: unknown, timeout?: unknown }
    if (typeof gwObj.resolve === 'string' && /^https?:\/\//.test(gwObj.resolve)) result.gateway.resolve = gwObj.resolve.trim()
    if (typeof gwObj.timeout === 'number' && gwObj.timeout >= 3000 && gwObj.timeout <= 60000) result.gateway.timeout = gwObj.timeout
  }
  const lines = Array.isArray(data?.lines) ? data.lines : (Array.isArray(data) ? data : null)
  if (!lines) {
    result.error = '配置格式不正确，请检查 lines 数组及字段'
    return result
  }
  if (!lines.length) {
    result.error = '请至少保留一个可用音源线路'
    return result
  }
  const qualityList: LX.QualityList = {}
  for (const line of lines) {
    const qingId = String(line?.id ?? '')
    const mappedId = QING_TO_LOCAL[qingId]
    if (!mappedId) continue
    if (!Array.isArray(line.levels) || !line.levels.length) continue
    if (line.enabled === false) continue
    result.lines[mappedId] = result.lines[mappedId] ?? []
    result.lines[mappedId].push({
      name: String(line.name ?? qingId),
      levels: line.levels.map((l: unknown) => String(l)),
    })
    const qSet: LX.Quality[] = []
    for (const tier of line.levels) {
      const q = TIER_TO_QUALITY[String(tier)]
      if (q && !qSet.includes(q)) qSet.push(q)
    }
    if (qSet.length) {
      qualityList[mappedId] = (qualityList[mappedId] ?? []).concat(qSet).filter((v, i, a) => a.indexOf(v) === i)
    }
  }
  if (!Object.keys(result.lines).length) {
    result.error = '配置格式不正确，请检查 lines 数组及字段'
    return result
  }
  result.qualityList = qualityList
  result.ok = true
  return result
}

/* ---------------- 客户端请求 ---------------- */

const urlCache = new Map<string, { url: string, expiresAt: number }>()
const getCacheKey = (source: string, rid: string, tier: string) => `${source}|${rid}|${tier}`

const postJson = async(url: string, data: unknown, timeout: number) => {
  const req = fetchData(url, {
    method: 'post',
    headers: { 'Content-Type': 'application/json' },
    body: data,
    timeout,
  })
  return req.request.then(({ body, statusCode }: any) => {
    let parsed = body
    if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed) } catch {} }
    if (statusCode && statusCode >= 400) throw new Error('网关请求失败（HTTP ' + statusCode + '）')
    return parsed
  })
}

const resolveCloud = async(qingSource: string, rid: string, tier: string, gateway: QingGateway): Promise<{ url: string, type: LX.Quality }> => {
  const key = getCacheKey(qingSource, rid, tier)
  const cached = urlCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return { url: cached.url, type: TIER_TO_QUALITY[tier] ?? '128k' }
  const body = await postJson(gateway.resolve, { source: qingSource, rid, level: tier }, gateway.timeout)
  const data = body?.data ?? body
  if (body?.code != 0 || !data?.url) {
    throw new Error(String(body?.msg || body?.message || '未返回播放地址'))
  }
  urlCache.set(key, { url: data.url, expiresAt: Date.now() + 45_000 })
  return { url: data.url, type: TIER_TO_QUALITY[tier] ?? '128k' }
}

/** bili：B 站公开 playurl（非 WBI），按 bvid/cid 取音频 */
const resolveBili = async(bvid: string, cid: string, tier: string): Promise<{ url: string, type: LX.Quality }> => {
  const key = getCacheKey('bili', bvid, tier)
  const cached = urlCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return { url: cached.url, type: TIER_TO_QUALITY[tier] ?? '192k' }
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Referer: 'https://www.bilibili.com/',
  }
  const getJson = async(url: string, h: Record<string, string>) => {
    const req = fetchData(url, { method: 'get', headers: h, timeout: 12_000 })
    const { body, statusCode }: any = await req.request
    let parsed = body
    if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed) } catch {} }
    if (statusCode && statusCode >= 400) throw new Error('哔哩请求失败（HTTP ' + statusCode + '）')
    return parsed
  }
  let cidOf = cid
  if (!cidOf) {
    const view = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' })
    cidOf = String(view?.data?.cid ?? '')
  }
  const body = await getJson(`https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cidOf)}&fnver=0&fnval=16&fourk=0&qn=0`, headers)
  if (body?.code !== 0 || !body?.data?.dash?.audio?.length) {
    throw new Error('哔哩未返回播放地址（可能被风控或无音频流）')
  }
  const audios: any[] = body.data.dash.audio
  const pick = tier === 'hires' || tier === 'lossless'
    ? audios.find((a: any) => a.id >= 30280) ?? audios[0]
    : audios.find((a: any) => a.id === 30216 || a.id === 8002) ?? audios[0]
  const urlFinal = (pick.baseUrl || pick.base_url || pick.url) + (pick.extra ? `?${pick.extra}` : '')
  urlCache.set(key, { url: urlFinal, expiresAt: Date.now() + 45_000 })
  return { url: urlFinal, type: TIER_TO_QUALITY[tier] ?? '192k' }
}

export type QingCloudApis = Record<string, {
  getMusicUrl: (songInfo: LX.Music.MusicInfo, type: LX.Quality) => { canceleFn: () => void, promise: Promise<{ url: string, type: LX.Quality }> }
  getLyric: (songInfo: LX.Music.MusicInfo) => { canceleFn: () => void, promise: Promise<LX.Music.LyricInfo> }
  getPic: (songInfo: LX.Music.MusicInfo) => { canceleFn: () => void, promise: Promise<string> }
}>

/** 按导入的渠道配置构造 userApi 形态的 apis（与桌面端同构）。 */
export const buildQingCloudApis = (lines: QingValidation['lines'], gateway: QingGateway = DEFAULT_GATEWAY): QingCloudApis => {
  const apis: QingCloudApis = {}
  const emptyLyric: LX.Music.LyricInfo = { lyric: '', tlyric: null, rlyric: null, lxlyric: null }
  for (const source of Object.keys(lines) as LX.OnlineSource[]) {
    const qingSource = LOCAL_TO_QING[source]
    const isBili = source === 'bili'
    const pickTier = (quality: LX.Quality): string => {
      const avail = (lines[source] ?? []).flatMap(l => l.levels)
      const want = QUALITY_TO_TIER[quality]
      return avail.includes(want) ? want : (avail[0] ?? (isBili ? 'bili192' : 'standard'))
    }

    apis[source] = {
      getMusicUrl(songInfo: LX.Music.MusicInfo, type: LX.Quality) {
        const rid = String(songInfo.id ?? '')
        const tier = pickTier(type)
        let abort: () => void = () => {}
        const task = (async() => {
          if (isBili) {
            return resolveBili(rid, String((songInfo as { cid?: unknown })?.cid ?? ''), tier)
          }
          return resolveCloud(qingSource, rid, tier, gateway)
        })()
        const promise: Promise<{ url: string, type: LX.Quality }> = task.then(res => res)
        abort = () => { /* fetchData 的 abort 句柄未逐请求透传，best-effort */ }
        return { canceleFn: abort, promise }
      },
      getLyric() {
        return {
          canceleFn: () => {},
          promise: Promise.resolve({ ...emptyLyric }),
        }
      },
      getPic() {
        return {
          canceleFn: () => {},
          promise: Promise.reject(new Error('该渠道暂不支持封面解析')),
        }
      },
    }
  }
  return apis
}
