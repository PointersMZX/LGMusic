/**
 * 音源层共享类型与底层工具。
 * 逻辑忠实还原自青听 v1.0.3 桌面端主进程。
 */
import http from 'node:http'
import https from 'node:https'
import { createHash } from 'node:crypto'

export type SourceId = 'wy' | 'kw' | 'qq' | 'tx' | 'kg' | 'mg' | 'bili' | 'local'

/** 曲目通用形态（各源适配器统一输出） */
export interface Track {
  rid: string
  name: string
  artist: string
  album?: string
  pic?: string
  /** 展示时长，秒或「X分X秒」字符串 */
  duration?: number | string
  hash?: string
  sqHash?: string
  source?: string
  [key: string]: unknown
}

export interface PlaylistSummary {
  name: string
  img: string
  userName: string
  uPic: string
  id: string | number
  musicList: Track[]
  totalCount?: number
  total?: number
  hasMore?: boolean
  desc?: string
  tags?: string[]
  playCount?: number | string
  resolvedId?: string
}

export interface PlaylistResult {
  code: number
  msg: string
  data: PlaylistSummary | null
}

/** 秒数/毫秒数/「X分X秒」/「mm:ss」统一转秒 */
export function normalizeDuration(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const s = value > 10000 ? value / 1000 : value
    return s > 0 ? Math.floor(s) : 0
  }
  const raw = String(value ?? '').trim()
  if (!raw) return 0
  const cn = raw.match(/(\d+)\s*分\s*(\d+)\s*秒/)
  if (cn) return Number(cn[1]) * 60 + Number(cn[2])
  const hm = raw.match(/^(\d{1,3}):(\d{1,2})$/)
  if (hm) return Number(hm[1]) * 60 + Number(hm[2])
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 0
  const s = n > 10000 ? n / 1000 : n
  return Math.floor(s)
}

/** 秒 → 展示时长字符串 */
export function secondsLabel(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}分${s}秒`
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36'

/** 原始 http(s) GET，返回文本（青听原版走 node 网络栈） */
export function httpGetText(url: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'User-Agent': DEFAULT_UA, ...headers }
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve(body))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

/** 原始 http(s) POST，返回文本 */
export function httpPostText(
  url: string,
  body: string,
  headers: Record<string, string> = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'User-Agent': DEFAULT_UA,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          ...headers
        }
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => resolve(data))
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

export const md5Hex = (input: string): string => createHash('md5').update(input).digest('hex')

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** 酷狗/酷我侧 URL 查询串追加 */
export function appendQuery(url: string, params: Record<string, unknown>): string {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    search.append(k, String(v))
  })
  return url + (url.includes('?') ? '&' : '?') + search.toString()
}

/** 酷狗网关请求签名（排序拼接 + 盐 MD5） */
export function kgSignature(params: Record<string, unknown>, body: string | null = null, saltAlt = false): string {
  const salt = saltAlt ? 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA' : 'OIlwieks28dk2k092lksi2UIkp'
  const sorted = Object.keys(params)
    .sort()
    .map((key) => {
      const value = params[key]
      return key + '=' + (Array.isArray(value) ? JSON.stringify(value) : String(value))
    })
    .join('')
  return md5Hex(salt + sorted + (body !== null ? body : '') + salt)
}
