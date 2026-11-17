/**
 * QMC 本地解密流代理（127.0.0.1 随机端口 /qmc/<会话>）。
 * 逻辑忠实还原自青听 v1.0.3 桌面端主进程（wo 类）。
 */
import http from 'node:http'
import https from 'node:https'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createQmcDecoder, type QmcStreamDecoder } from './stream'

const SESSION_TTL_MS = 2 * 60 * 60 * 1000
const UPSTREAM_TIMEOUT_MS = 25000
const UPSTREAM_MAX_REDIRECTS = 5

interface QmcSession {
  id: string
  sourceUrl: URL
  headers?: Record<string, string>
  decoder: QmcStreamDecoder
  mimeType: string
  expiresAt: number
  totalBytes?: number
}

function normalizeExpiry(value: unknown): number {
  const now = Date.now()
  if (!value || !Number.isFinite(Number(value))) return now + SESSION_TTL_MS
  const ms = Number(value) < 1e12 ? Number(value) * 1000 : Number(value)
  return Math.max(now + 60000, ms)
}

function cleanHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([k, v]) => k.trim() && v !== undefined)
      .map(([k, v]) => [k.trim(), String(v)])
  )
}

const MIME_BY_FORMAT: Record<string, string> = {
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  wav: 'audio/wav'
}

function pickMime(resultFormat: unknown, fallback: unknown): string {
  const format = String(resultFormat || '')
    .toLowerCase()
    .replace(/^\./, '')
  if (MIME_BY_FORMAT[format]) return MIME_BY_FORMAT[format]
  const mime = String(fallback || '').trim()
  return mime && mime !== 'application/octet-stream' ? mime : 'audio/flac'
}

function firstNumber(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  const n = Number(raw)
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined
}

function parseContentRange(value: unknown): { start: number; end: number; total?: number } | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(raw || ''))
  if (!m) return undefined
  const start = Number(m[1])
  const end = Number(m[2])
  const total = m[3] === '*' ? undefined : Number(m[3])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return undefined
  if (total !== undefined && !Number.isSafeInteger(total)) return undefined
  return { start, end, total }
}

function parseRange(header: unknown, total: number): { start: number; end: number; partial: boolean } | null {
  const raw = Array.isArray(header) ? header[0] : header
  if (!raw) return { start: 0, end: total - 1, partial: false }
  const text = String(raw).trim()
  if (text.includes(',')) return null
  const m = /^bytes=(\d*)-(\d*)$/i.exec(text)
  if (!m || !m[1] && !m[2]) return null
  if (!m[1]) {
    const suffix = Number(m[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    return { start: Math.max(0, total - suffix), end: total - 1, partial: true }
  }
  const start = Number(m[1])
  const end = m[2] ? Number(m[2]) : total - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= total || end < start) return null
  return { start, end: Math.min(end, total - 1), partial: true }
}

/** 上游请求（带重定向跟随，最多 5 跳） */
async function upstreamRequest(
  url: URL,
  method: string,
  headers: Record<string, string>
): Promise<IncomingMessage> {
  let target = url
  for (let hop = 0; hop <= UPSTREAM_MAX_REDIRECTS; hop += 1) {
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const mod = target.protocol === 'https:' ? https : http
      const req = mod.request(target, { method, headers }, (r) => resolve(r))
      req.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
        req.destroy(new Error('QMC 上游请求超时'))
      })
      req.on('error', reject)
      req.end()
    })
    const status = res.statusCode || 0
    if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
      res.resume()
      target = new URL(res.headers.location, target)
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new Error('QMC 上游重定向协议不受支持')
      }
      continue
    }
    return res
  }
  throw new Error('QMC 上游重定向次数过多')
}

export class QmcProxyServer {
  private server: http.Server | null = null
  private origin = ''
  private startPromise: Promise<void> | null = null
  private cleanupTimer: NodeJS.Timeout | null = null
  private sessions = new Map<string, QmcSession>()

  async createSession(input: {
    url?: string
    finalEkey?: string
    headers?: Record<string, string>
    mimeType?: string
    resultFormat?: string
    expiresAt?: number
  }): Promise<{ url: string; expiresAt: number }> {
    const raw = String(input?.url || '').trim()
    const sourceUrl = new URL(raw)
    if (sourceUrl.protocol !== 'http:' && sourceUrl.protocol !== 'https:') {
      throw new Error('QMC 播放地址必须使用 HTTP(S)')
    }
    const ekey = String(input?.finalEkey || '').trim()
    if (!ekey) throw new Error('QMC 播放缺少解密密钥')
    await this.ensureStarted()
    const id = randomBytes(24).toString('hex')
    const expiresAt = normalizeExpiry(input.expiresAt)
    this.sessions.set(id, {
      id,
      sourceUrl,
      headers: cleanHeaders(input.headers),
      decoder: createQmcDecoder(ekey),
      mimeType: pickMime(input.resultFormat, input.mimeType),
      expiresAt
    })
    return { url: `${this.origin}/qmc/${id}`, expiresAt }
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    this.sessions.clear()
    this.server?.close()
    this.server = null
    this.origin = ''
    this.startPromise = null
  }

  private ensureStarted(): Promise<void> {
    if (this.origin) return Promise.resolve()
    if (this.startPromise) return this.startPromise
    this.startPromise = new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => this.respondError(res, err))
      })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (!addr || typeof addr === 'string') {
          server.close()
          reject(new Error('无法启动 QMC 本地播放服务'))
          return
        }
        this.server = server
        this.origin = `http://127.0.0.1:${addr.port}`
        this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), 60000)
        this.cleanupTimer.unref()
        resolve()
      })
    }).catch((err) => {
      this.startPromise = null
      throw err
    })
    return this.startPromise
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now()
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id)
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const match = /^\/qmc\/([a-f0-9]{48})$/.exec(url.pathname)
    if (!match) {
      this.respondError(res, new Error('QMC 播放会话不存在'), 404)
      return
    }
    const session = this.sessions.get(match[1])
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(match[1])
      this.respondError(res, new Error('QMC 播放会话已过期'), 410)
      return
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, this.commonHeaders(session))
      res.end()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD, OPTIONS')
      this.respondError(res, new Error('请求方法不受支持'), 405)
      return
    }
    const total = await this.resolveTotalBytes(session)
    const range = parseRange(req.headers.range, total)
    if (!range) {
      res.writeHead(416, {
        ...this.commonHeaders(session),
        'Content-Range': `bytes */${total}`
      })
      res.end()
      return
    }
    const headers: Record<string, string> = {
      ...this.commonHeaders(session),
      'Content-Length': String(range.end - range.start + 1),
      ...(range.partial ? { 'Content-Range': `bytes ${range.start}-${range.end}/${total}` } : {})
    }
    if (req.method === 'HEAD') {
      res.writeHead(range.partial ? 206 : 200, headers)
      res.end()
      return
    }
    await this.streamDecryptedRange(session, range, res, headers)
  }

  private commonHeaders(session: QmcSession): Record<string, string> {
    return {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store, max-age=0',
      'Content-Type': session.mimeType,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range',
      'X-Content-Type-Options': 'nosniff'
    }
  }

  private async resolveTotalBytes(session: QmcSession): Promise<number> {
    if (session.totalBytes) return session.totalBytes
    const head = await upstreamRequest(session.sourceUrl, 'HEAD', this.upstreamHeaders(session))
    const contentLength = firstNumber(head.headers['content-length'])
    head.resume()
    if (contentLength && contentLength > 0) {
      session.totalBytes = contentLength
      return contentLength
    }
    const probe = await upstreamRequest(session.sourceUrl, 'GET', this.upstreamHeaders(session, 'bytes=0-0'))
    const contentRange = parseContentRange(probe.headers['content-range'])
    const probeLength = firstNumber(probe.headers['content-length'])
    probe.resume()
    const total = contentRange?.total || probeLength
    if (!total || total <= 0) throw new Error('无法获取 QMC 加密音频长度')
    session.totalBytes = total
    return total
  }

  private upstreamHeaders(session: QmcSession, range?: string): Record<string, string> {
    const excluded = new Set(['host', 'connection', 'content-length', 'range', 'accept-encoding'])
    const headers = Object.fromEntries(
      Object.entries(session.headers || {}).filter(([key]) => !excluded.has(key.toLowerCase()))
    )
    headers['Accept-Encoding'] = 'identity'
    if (range) headers.Range = range
    return headers
  }

  private async streamDecryptedRange(
    session: QmcSession,
    range: { start: number; end: number; partial: boolean },
    res: ServerResponse,
    headers: Record<string, string>
  ): Promise<void> {
    const upstream = await upstreamRequest(
      session.sourceUrl,
      'GET',
      this.upstreamHeaders(session, `bytes=${range.start}-${range.end}`)
    )
    const status = upstream.statusCode || 0
    if (status !== 200 && status !== 206) {
      upstream.resume()
      throw new Error(`QMC 上游返回异常状态: ${status}`)
    }
    const contentRange = parseContentRange(upstream.headers['content-range'])
    const upstreamStart = status === 206 ? contentRange?.start ?? range.start : 0
    if (upstreamStart > range.start) {
      upstream.destroy()
      throw new Error('QMC 上游返回的范围无效')
    }
    let skip = range.start - upstreamStart
    let position = upstreamStart
    let remaining = range.end - range.start + 1
    const wanted = remaining
    let closed = false
    res.writeHead(range.partial ? 206 : 200, headers)
    const finish = (): void => {
      if (closed) return
      closed = true
      if (!res.writableEnded) res.end()
    }
    const fail = (err: unknown): void => {
      if (closed) return
      closed = true
      upstream.destroy()
      if (!res.writableEnded) res.destroy(err instanceof Error ? err : new Error(String(err)))
    }
    res.once('close', () => {
      if (!closed) {
        closed = true
        upstream.destroy()
      }
    })
    upstream.on('data', (chunk: Buffer) => {
      if (closed || remaining <= 0) return
      let data = chunk
      if (skip > 0) {
        const cut = Math.min(skip, data.length)
        data = data.subarray(cut)
        skip -= cut
        position += cut
      }
      if (data.length === 0) return
      const take = Math.min(data.length, remaining)
      let decrypted: Buffer
      try {
        decrypted = session.decoder.decrypt(data.subarray(0, take), position)
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)))
        return
      }
      position += take
      remaining -= take
      if (!res.write(decrypted)) {
        upstream.pause()
        res.once('drain', () => upstream.resume())
      }
      if (remaining === 0) {
        upstream.destroy()
        finish()
      }
    })
    upstream.once('end', () => {
      if (remaining === 0) finish()
      else {
        fail(
          new Error(`QMC 上游数据不足: 期望 ${wanted} 字节，缺少 ${remaining} 字节`)
        )
      }
    })
    upstream.once('error', (err) => fail(err))
  }

  private respondError(res: ServerResponse, err: unknown, status = 502): void {
    if (res.headersSent) {
      res.destroy(err instanceof Error ? err : undefined)
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    res.end(JSON.stringify({ error: message }))
  }
}

export const qmcProxy = new QmcProxyServer()
