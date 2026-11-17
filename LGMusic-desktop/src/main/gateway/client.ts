/**
 * 音乐网关客户端（播放地址解析 + 网关券）。
 * 逻辑忠实还原自青听 v1.0.3 桌面端主进程（Lo 类）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'

import {
  GATEWAY_SERVERS,
  KW_DECRYPT_RESOLVER_URL,
  gatewayHeaders
} from './sign'

export class FetchTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FetchTimeoutError'
  }
}

export class GatewayServiceError extends Error {
  code: string
  traceId?: string
  httpStatus?: number
  retryAfter?: number
  constructor(message: string, opts: { code: string; traceId?: string; httpStatus?: number; retryAfter?: number }) {
    super(message)
    this.name = 'GatewayServiceError'
    this.code = opts.code
    this.traceId = opts.traceId
    this.httpStatus = opts.httpStatus
    this.retryAfter = opts.retryAfter
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const strOrUndef = (v: unknown): string | undefined => (typeof v !== 'string' ? undefined : v.trim() || undefined)
const strMap = (v: unknown): Record<string, string> | undefined => {
  if (!isObj(v)) return undefined
  const entries = Object.entries(v).flatMap(([k, val]) =>
    typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean' ? [] : [[k, String(val)]]
  )
  return entries.length ? Object.fromEntries(entries) : undefined
}
const parseExpiry = (v: unknown): number | undefined => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n < 1e12 ? n * 1000 : n
}

export interface ResolveResult {
  url: string
  backupUrls?: string[]
  headers?: Record<string, string>
  playbackHeaders?: Record<string, string>
  mimeType?: string
  format?: string
  resultFormat?: string
  needDecrypt?: boolean
  finalEkey?: string
  playbackMode?: string
  level: string
  expiresAt?: number
  traceId: string
}

const REQUEST_TIMEOUT_MS = 12000
const RESOLVE_TTL_MS = 45000
const TICKET_REQUEST_TIMEOUT_MS = 8000
const TICKET_RETRY_DELAY_MS = 30 * 60 * 1000
const TICKET_DISABLED_RETRY_MS = 60 * 60 * 1000
const TICKET_GRACE_SECONDS = 24 * 60 * 60
const TICKET_REFRESH_MARGIN_MS = 30 * 60 * 1000

function newRequestId(): string {
  return `qmpc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, message: string): Promise<Response> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    throw timedOut ? new FetchTimeoutError(message) : (err as Error)
  } finally {
    clearTimeout(timer)
  }
}

function parseJsonPayload(text: string, res: Response): Record<string, unknown> {
  try {
    const json = JSON.parse(text)
    if (!isObj(json)) throw new Error('invalid payload')
    return json
  } catch {
    const status = res?.status || 0
    throw new GatewayServiceError('解析服务返回了无效数据', {
      code: status >= 500 ? `GATEWAY_HTTP_${status}` : 'INVALID_GATEWAY_RESPONSE',
      ...(status ? { httpStatus: status } : {})
    })
  }
}

function errorMessageOf(payload: Record<string, unknown>): string {
  const direct = strOrUndef(payload.message)
  if (direct) return direct
  const inner = payload.message
  if (isObj(inner)) {
    const nested = strOrUndef(inner.message)
    if (nested) return nested
  }
  const error = payload.error
  if (isObj(error)) {
    const nested = strOrUndef(error.message)
    if (nested) return nested
  }
  return '播放地址解析失败'
}

function serviceErrorOf(payload: Record<string, unknown>, res: Response, traceId: string): GatewayServiceError {
  const rawCode = payload.code
  const code =
    (typeof rawCode === 'string' && rawCode.trim()) ||
    (typeof rawCode === 'number' && rawCode !== 0 ? String(rawCode) : '') ||
    (res.ok ? 'GATEWAY_REQUEST_FAILED' : `GATEWAY_HTTP_${res.status}`)
  const retryAfterBody = Number(payload.retry_after || 0)
  const retryAfterHeader = Number(res.headers.get('retry-after') || 0)
  const retryAfter =
    Number.isFinite(retryAfterBody) && retryAfterBody > 0
      ? Math.trunc(retryAfterBody)
      : Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? Math.trunc(retryAfterHeader)
        : undefined
  return new GatewayServiceError(errorMessageOf(payload), {
    code,
    traceId: strOrUndef(payload.traceId) || strOrUndef(res.headers.get('x-trace-id')) || traceId,
    httpStatus: res.status,
    retryAfter
  })
}

export interface GatewayIdentityProvider {
  getAppVersion(): string
  getDeviceId(): string
  getAccessTokenForGateway(): Promise<string>
}

interface TicketData {
  ticket: string
  expiresAt: number
  refreshAt: number
  graceSeconds: number
  deviceId: string
}

interface ResolveCacheEntry {
  expiresAt: number
  value: ResolveResult
}

export class MusicGatewayClient {
  private identity: GatewayIdentityProvider
  private resolveCache = new Map<string, ResolveCacheEntry>()
  private ticket: TicketData | null = null
  private ticketLoaded = false
  private ticketPending: Promise<void> | null = null
  private ticketTimer: NodeJS.Timeout | null = null
  private nextTicketAttemptAt = 0

  constructor(identity: GatewayIdentityProvider) {
    this.identity = identity
  }

  private ticketPath(): string {
    return path.join(process.cwd(), '.ticket-local') // 由 app 提供 userData；见 bindPaths
  }

  /** 由主进程注入 userData 路径 */
  private userDataPath: string = ''
  bindUserData(userDataPath: string): void {
    this.userDataPath = userDataPath
  }

  private resolveTicketPath(): string {
    return this.userDataPath
      ? path.join(this.userDataPath, 'account', 'gateway-ticket.bin')
      : this.ticketPath()
  }

  startTicketRefresh(): void {
    this.ensureTicket()
    if (this.ticketTimer) clearInterval(this.ticketTimer)
    this.ticketTimer = setInterval(() => {
      this.ensureTicket()
    }, TICKET_REFRESH_MARGIN_MS)
    this.ticketTimer.unref?.()
  }

  dispose(): void {
    if (this.ticketTimer) {
      clearInterval(this.ticketTimer)
      this.ticketTimer = null
    }
  }

  async resolve(input: { source?: string; rid?: string; level?: string; force?: boolean }): Promise<ResolveResult> {
    const source = String(input?.source || 'wy').trim().toLowerCase()
    const rid = String(input?.rid || '').trim()
    const level = String(input?.level || 'standard').trim() || 'standard'
    if (!rid) throw new GatewayServiceError('歌曲 ID 为空', { code: 'EMPTY_TRACK_ID' })
    const cacheKey = `${source}|${rid}|${level}`
    const cached = this.resolveCache.get(cacheKey)
    if (!input?.force && cached && cached.expiresAt > Date.now()) return cached.value
    if (cached) this.resolveCache.delete(cacheKey)
    let result: ResolveResult
    if (source === 'kw') {
      try {
        result = await this.resolveFromGateway(source, rid, level)
      } catch (err) {
        if (!this.shouldFallbackToLocalDecrypt(err)) throw err
        console.warn('[音乐网关] 正式网关不可用，回退酷我本地解密线路:', {
          code: err instanceof GatewayServiceError ? err.code : 'UNKNOWN'
        })
        result = await this.resolveFromKwDecryptLine(rid, level)
      }
    } else {
      result = await this.resolveFromGateway(source, rid, level)
    }
    const now = Date.now()
    const expiresAt =
      result.expiresAt && result.expiresAt > now ? Math.min(result.expiresAt, now + RESOLVE_TTL_MS) : now + RESOLVE_TTL_MS
    this.resolveCache.set(cacheKey, { expiresAt, value: result })
    return result
  }

  clearCache(): void {
    this.resolveCache.clear()
  }

  private async resolveFromGateway(source: string, rid: string, level: string): Promise<ResolveResult> {
    const body = JSON.stringify({ source, rid, level })
    const appVersion = this.identity.getAppVersion()
    const deviceId = this.identity.getDeviceId()
    let lastError: unknown = null
    for (const server of GATEWAY_SERVERS) {
      const url = `${server}/music/resolve-url`
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const ticket = this.getTicketForRequest()
          if (!ticket) this.ensureTicket()
          const requestId = newRequestId()
          const res = await fetchWithTimeout(
            url,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'X-Request-Id': requestId,
                ...gatewayHeaders('POST', url, body, {
                  appVersion,
                  deviceId,
                  ticket
                })
              },
              body
            },
            REQUEST_TIMEOUT_MS,
            '播放地址解析超时'
          )
          const payload = parseJsonPayload(await res.text(), res)
          const traceId = strOrUndef(payload.traceId) || res.headers.get('x-trace-id') || requestId
          const okCode = payload.code === 0 || payload.code === '0'
          if (!res.ok || !okCode) {
            const err = serviceErrorOf(payload, res, traceId)
            if (err.code === 'APP_UPGRADE_REQUIRED' && attempt === 0) {
              this.clearTicket()
              await this.ensureTicket(true)
              continue
            }
            throw err
          }
          if (!isObj(payload.data)) {
            throw new GatewayServiceError('解析服务未返回播放数据', {
              code: 'INVALID_GATEWAY_RESPONSE',
              traceId,
              httpStatus: res.status
            })
          }
          return this.toResolveResult(payload.data, level, traceId)
        } catch (err) {
          lastError = err
          if (this.shouldTryNextGatewayLine(err)) break
          throw err
        }
      }
    }
    if (lastError instanceof GatewayServiceError) throw lastError
    if (lastError instanceof FetchTimeoutError) {
      throw new GatewayServiceError(lastError.message, { code: 'GATEWAY_TIMEOUT' })
    }
    throw new GatewayServiceError('无法连接播放地址解析服务', { code: 'NETWORK_UNREACHABLE' })
  }

  private async resolveFromKwDecryptLine(rid: string, level: string): Promise<ResolveResult> {
    if (!KW_DECRYPT_RESOLVER_URL) {
      throw new GatewayServiceError('酷我本地解密线路未配置', { code: 'LOCAL_DECRYPT_UNAVAILABLE' })
    }
    const query = new URLSearchParams({ id: rid, level, type: 'json', mode: 'local' })
    const requestId = newRequestId()
    const url = `${KW_DECRYPT_RESOLVER_URL}/kwurl?${query.toString()}`
    try {
      const res = await fetchWithTimeout(
        url,
        { method: 'GET', headers: { Accept: 'application/json', 'X-Request-Id': requestId } },
        REQUEST_TIMEOUT_MS,
        '本地解密线路超时'
      )
      const payload = parseJsonPayload(await res.text(), res)
      const okCode = payload.code === 0 || payload.code === 200 || payload.code === '0' || payload.code === '200'
      if (!res.ok || !okCode || !isObj(payload.data)) {
        throw new GatewayServiceError(
          strOrUndef(payload.msg) || strOrUndef(payload.message) || '酷我本地解密线路解析失败',
          { code: 'LOCAL_DECRYPT_FAILED', traceId: requestId, httpStatus: res.status }
        )
      }
      return this.toResolveResult(payload.data, level, requestId)
    } catch (err) {
      if (err instanceof GatewayServiceError) throw err
      if (err instanceof FetchTimeoutError) {
        throw new GatewayServiceError(err.message, { code: 'LOCAL_DECRYPT_TIMEOUT', traceId: requestId })
      }
      throw new GatewayServiceError('无法连接酷我本地解密线路', {
        code: 'LOCAL_DECRYPT_UNREACHABLE',
        traceId: requestId
      })
    }
  }

  private toResolveResult(data: Record<string, unknown>, fallbackLevel: string, traceId: string): ResolveResult {
    const url = strOrUndef(data.url)
    if (!url) {
      throw new GatewayServiceError('播放地址解析失败', { code: 'INVALID_GATEWAY_RESPONSE', traceId })
    }
    const headers = strMap(data.headers)
    const playbackHeaders = strMap(data.playbackHeaders) || headers
    const needDecrypt = data.need_decrypt === true
    const finalEkey = strOrUndef(data.final_ekey)
    if (needDecrypt && !finalEkey) {
      throw new GatewayServiceError('播放地址需要本地解密，但解析服务未返回解密密钥', {
        code: 'MISSING_FINAL_EKEY',
        traceId
      })
    }
    const expiresAt = parseExpiry(data.expiresAt)
    return {
      url,
      ...(Array.isArray(data.backupUrls) ? { backupUrls: (data.backupUrls as unknown[]).map(String) } : {}),
      ...(headers ? { headers } : {}),
      ...(playbackHeaders ? { playbackHeaders } : {}),
      ...(strOrUndef(data.mimeType) ? { mimeType: strOrUndef(data.mimeType) } : {}),
      ...(strOrUndef(data.format) ? { format: strOrUndef(data.format) } : {}),
      ...(strOrUndef(data.result_format) ? { resultFormat: strOrUndef(data.result_format) } : {}),
      ...(needDecrypt ? { needDecrypt: true } : {}),
      ...(finalEkey ? { finalEkey } : {}),
      ...(strOrUndef(data.playback_mode) ? { playbackMode: strOrUndef(data.playback_mode) } : {}),
      level: strOrUndef(data.level) || fallbackLevel,
      ...(expiresAt ? { expiresAt } : {}),
      traceId
    }
  }

  private shouldTryNextGatewayLine(err: unknown): boolean {
    if (err instanceof FetchTimeoutError) return true
    if (!(err instanceof GatewayServiceError)) return false
    if ((err.httpStatus || 0) >= 500) return true
    return (
      err.code === 'NETWORK_UNREACHABLE' ||
      err.code === 'GATEWAY_TIMEOUT' ||
      err.code === 'UPSTREAM_TIMEOUT' ||
      err.code === 'UPSTREAM_NETWORK_ERROR' ||
      err.code === 'UPSTREAM_HTTP_5XX' ||
      err.code === 'UPSTREAM_HTTP_ERROR' ||
      err.code === 'UPSTREAM_INTERNAL_ERROR' ||
      err.code === 'UPSTREAM_UNAVAILABLE' ||
      err.code === 'INVALID_GATEWAY_RESPONSE'
    )
  }

  private shouldFallbackToLocalDecrypt(err: unknown): boolean {
    if (err instanceof FetchTimeoutError) return true
    if (!(err instanceof GatewayServiceError)) return false
    if ((err.httpStatus || 0) >= 500) return true
    return (
      err.code === 'NETWORK_UNREACHABLE' ||
      err.code === 'GATEWAY_TIMEOUT' ||
      err.code === 'UPSTREAM_TIMEOUT' ||
      err.code === 'UPSTREAM_NETWORK_ERROR' ||
      err.code === 'UPSTREAM_HTTP_5XX' ||
      err.code === 'UPSTREAM_HTTP_ERROR' ||
      err.code === 'UPSTREAM_INTERNAL_ERROR' ||
      err.code === 'UPSTREAM_UNAVAILABLE' ||
      err.code === 'CONFIG_UNAVAILABLE' ||
      err.code === 'INVALID_GATEWAY_RESPONSE' ||
      err.code === 'MISSING_FINAL_EKEY'
    )
  }

  toErrorInfo(err: unknown): { code: string; message: string; traceId?: string; httpStatus?: number; retryAfter?: number } {
    if (err instanceof GatewayServiceError) {
      return {
        code: err.code,
        message: err.message,
        ...(err.traceId ? { traceId: err.traceId } : {}),
        ...(err.httpStatus ? { httpStatus: err.httpStatus } : {}),
        ...(err.retryAfter ? { retryAfter: err.retryAfter } : {})
      }
    }
    if (err instanceof FetchTimeoutError) {
      return { code: 'NETWORK_TIMEOUT', message: err.message }
    }
    return {
      code: 'GATEWAY_INTERNAL_ERROR',
      message: err instanceof Error ? err.message : '播放地址解析失败'
    }
  }

  async ensureTicket(force = false): Promise<void> {
    if (force) {
      this.clearTicket()
      this.nextTicketAttemptAt = 0
    }
    if (!this.isTicketFresh() && !(force === false && Date.now() < this.nextTicketAttemptAt)) {
      if (!this.ticketPending) {
        this.ticketPending = this.requestTicket().finally(() => {
          this.ticketPending = null
        })
      }
      return this.ticketPending
    }
  }

  private async requestTicket(): Promise<void> {
    const appVersion = this.identity.getAppVersion()
    const deviceId = this.identity.getDeviceId()
    const accessToken = await this.identity.getAccessTokenForGateway()
    const body = JSON.stringify({ deviceId, appVersion, platform: process.platform })
    let lastError: unknown = null
    for (const server of GATEWAY_SERVERS) {
      const url = `${server}/gateway/ticket`
      try {
        const res = await fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              ...gatewayHeaders('POST', url, body, { appVersion, deviceId, accessToken })
            },
            body
          },
          TICKET_REQUEST_TIMEOUT_MS,
          '领取网关券超时'
        )
        const payload = parseJsonPayload(await res.text(), res)
        const ticket = strOrUndef(payload.ticket)
        const expiresAt = Number(payload.expiresAt)
        if (!res.ok || !ticket || !Number.isFinite(expiresAt) || expiresAt <= 0) {
          const code = strOrUndef(payload.code) || ''
          this.nextTicketAttemptAt = Date.now() + (code === 'TICKET_DISABLED' ? TICKET_DISABLED_RETRY_MS : TICKET_RETRY_DELAY_MS)
          lastError = new Error(strOrUndef(payload.message) || '网关券领取失败')
          continue
        }
        const graceSeconds = Number(payload.graceSeconds)
        const now = Date.now()
        this.saveTicket({
          ticket,
          expiresAt,
          refreshAt: Math.max(expiresAt - TICKET_REFRESH_MARGIN_MS, now + TICKET_REFRESH_MARGIN_MS),
          graceSeconds: Number.isFinite(graceSeconds) && graceSeconds > 0 ? graceSeconds : TICKET_GRACE_SECONDS,
          deviceId
        })
        this.nextTicketAttemptAt = 0
        return
      } catch (err) {
        lastError = err
      }
    }
    this.nextTicketAttemptAt = this.nextTicketAttemptAt || Date.now() + TICKET_RETRY_DELAY_MS
    console.warn('[网关券] 领取失败，继续使用请求签名:', {
      message: lastError instanceof Error ? lastError.message : String(lastError)
    })
  }

  private isTicketFresh(): boolean {
    const t = this.readTicket()
    return t.ticket !== '' && t.refreshAt > 0 && Date.now() < t.refreshAt
  }

  getTicketForRequest(): string {
    const t = this.readTicket()
    if (t.ticket === '' || t.expiresAt <= 0) return ''
    if (t.deviceId && t.deviceId !== this.identity.getDeviceId()) {
      this.clearTicket()
      return ''
    }
    return Date.now() <= t.expiresAt + t.graceSeconds * 1000 ? t.ticket : ''
  }

  private readTicket(): TicketData {
    if (this.ticketLoaded) {
      return (
        this.ticket || { ticket: '', expiresAt: 0, refreshAt: 0, graceSeconds: TICKET_GRACE_SECONDS, deviceId: '' }
      )
    }
    this.ticketLoaded = true
    try {
      const file = this.resolveTicketPath()
      if (!fs.existsSync(file)) return this.emptyTicket()
      const buf = fs.readFileSync(file)
      const raw = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8')
      const json = JSON.parse(raw)
      if (typeof json.ticket !== 'string' || !Number.isFinite(Number(json.expiresAt)) || !Number.isFinite(Number(json.refreshAt))) {
        return this.emptyTicket()
      }
      this.ticket = {
        ticket: json.ticket,
        expiresAt: Number(json.expiresAt),
        refreshAt: Number(json.refreshAt),
        graceSeconds: Number.isFinite(Number(json.graceSeconds)) && Number(json.graceSeconds) > 0 ? Number(json.graceSeconds) : TICKET_GRACE_SECONDS,
        deviceId: typeof json.deviceId === 'string' ? json.deviceId : ''
      }
      return this.ticket
    } catch {
      return this.emptyTicket()
    }
  }

  private saveTicket(data: TicketData): void {
    this.ticket = data
    this.ticketLoaded = true
    try {
      const file = this.resolveTicketPath()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const json = JSON.stringify(data)
      const encrypted = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, 'utf8')
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, encrypted)
      fs.renameSync(tmp, file)
    } catch (err) {
      console.warn('[网关券] 保存本地缓存失败:', err)
    }
  }

  private clearTicket(): void {
    this.ticket = null
    this.ticketLoaded = true
    try {
      fs.rmSync(this.resolveTicketPath(), { force: true })
    } catch (err) {
      console.warn('[网关券] 清理本地缓存失败:', err)
    }
  }

  private emptyTicket(): TicketData {
    return { ticket: '', expiresAt: 0, refreshAt: 0, graceSeconds: TICKET_GRACE_SECONDS, deviceId: '' }
  }
}
