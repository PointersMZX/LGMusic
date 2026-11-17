/**
 * 自有网关请求签名。
 * 逻辑忠实还原自青听 v1.0.3 桌面端主进程。
 */
import { createHash, createHmac, randomBytes } from 'node:crypto'

export const GATEWAY_APP_ID = String(
  process.env.QING_GATEWAY_APP_ID || 'qingmusic-desktop'
).trim()

export const GATEWAY_SIGN_SECRET = String(
  process.env.QING_GATEWAY_SIGN_SECRET || 'qm-gw-7c1f4e9a2b8d5360e1a7c4f9b2d8036c'
).trim()

/** 网关双域名（主备） */
export const GATEWAY_SERVERS = [
  'https://musicserver.haitangw.cc/v1',
  'https://qt.haitangw.net/v1'
]

/** 酷我本地解密线路（裸 IP resolver，env 可覆盖） */
export const KW_DECRYPT_RESOLVER_URL = String(
  process.env.QING_KW_DECRYPT_RESOLVER_URL || process.env.VITE_KW_DECRYPT_RESOLVER_URL || 'http://175.27.166.236:8938'
)
  .trim()
  .replace(/\/+$/, '')

export function bodySha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

export function nonce(): string {
  return randomBytes(16).toString('hex')
}

/** 请求路径提取（仅 pathname） */
export function requestPath(url: string): string {
  try {
    return new URL(url).pathname || '/'
  } catch {
    return '/'
  }
}

export interface GatewayIdentity {
  appVersion: string
  deviceId: string
  ticket?: string
  accessToken?: string
}

/** X-Qing-* 签名头（HMAC-SHA256 over [appId, ts, nonce, method, path, bodyHash]） */
export function gatewayHeaders(
  method: string,
  url: string,
  body: string,
  identity: GatewayIdentity
): Record<string, string> {
  const ts = String(Date.now())
  const n = nonce()
  const payload = [
    GATEWAY_APP_ID,
    ts,
    n,
    String(method).toUpperCase(),
    requestPath(url),
    bodySha256(body)
  ].join('\n')
  const sign = createHmac('sha256', GATEWAY_SIGN_SECRET).update(payload, 'utf8').digest('hex')
  const auth = identity.ticket
    ? `Bearer ${identity.ticket}`
    : identity.accessToken
      ? `Bearer ${identity.accessToken}`
      : ''
  return {
    'X-Qing-App-Id': GATEWAY_APP_ID,
    'X-Qing-App-Version': identity.appVersion,
    'X-Qing-Device-Id': identity.deviceId,
    'X-Qing-Ts': ts,
    'X-Qing-Nonce': n,
    'X-Qing-Sign': sign,
    ...(auth ? { Authorization: auth } : {})
  }
}
