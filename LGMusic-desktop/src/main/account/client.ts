/**
 * 账号客户端（注册/登录/改密/找回/换绑/资料/头像背景/云同步 API）。
 * 逻辑忠实还原自青听 v1.0.3 桌面端主进程（mi 类），品牌字样已替换。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { app, dialog, safeStorage, type BrowserWindow } from 'electron'

const SERVERS = ['https://musicserver.haitangw.cc/v1', 'https://qt.haitangw.net/v1']
const REQUEST_TIMEOUT_MS = 15000
const SESSION_VERSION = 1
const IMAGE_MAX_BYTES = 10 * 1024 * 1024

export class AccountApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'AccountApiError'
    this.status = status
    this.code = code
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const genderOf = (v: unknown): 'male' | 'female' | 'unknown' => (v === 'male' || v === 'female' ? v : 'unknown')
const trimSlice = (v: unknown, max: number): string | undefined => {
  const s = (v as string | undefined)?.trim().slice(0, max)
  return s || undefined
}
const urlOrNull = (v: unknown): string | null =>
  typeof v === 'string' && /^https?:\/\//i.test(v) ? v : null

interface AccountUser {
  id: string
  account: string
  email: string | null
  emailVerified: boolean
  nickname: string
  gender: 'male' | 'female' | 'unknown'
  avatarUrl: string | null
  backgroundUrl: string | null
  bio: string | null
  showAccount: boolean
  showListeningAge: boolean
  showBio: boolean
  showBackground: boolean
  cloudSyncEnabled: boolean
  cloudSyncAutoEnabled: boolean
  createdAt: string
  updatedAt: string
  [key: string]: unknown
}

/** 服务端用户资料规范化 */
export function normalizeUser(e: unknown): AccountUser {
  if (!isObj(e) || typeof e.id !== 'string') {
    throw new AccountApiError(0, 'INVALID_RESPONSE', '账号服务返回的用户资料异常')
  }
  return {
    id: e.id,
    account: String(e.account || ''),
    email: typeof e.email === 'string' ? e.email : null,
    emailVerified: e.emailVerified === true,
    nickname: String(e.nickname || e.account || '甘露用户'),
    gender: genderOf(e.gender),
    avatarUrl: typeof e.avatarUrl === 'string' ? e.avatarUrl : null,
    backgroundUrl: typeof e.backgroundUrl === 'string' ? e.backgroundUrl : null,
    bio: typeof e.bio === 'string' ? e.bio : null,
    showAccount: e.showAccount !== false,
    showListeningAge: e.showListeningAge !== false,
    showBio: e.showBio !== false,
    showBackground: e.showBackground !== false,
    cloudSyncEnabled: e.cloudSyncEnabled !== false,
    cloudSyncAutoEnabled: e.cloudSyncAutoEnabled !== false,
    createdAt: typeof e.createdAt === 'string' ? e.createdAt : new Date().toISOString(),
    updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : new Date().toISOString()
  }
}

/** 登录响应解包 */
function parseAuthResponse(e: unknown): { accessToken: string; refreshToken: string; refreshTokenExpiresAt: string; user: AccountUser } {
  if (
    !isObj(e) ||
    typeof e.accessToken !== 'string' ||
    typeof e.refreshToken !== 'string' ||
    typeof e.refreshTokenExpiresAt !== 'string'
  ) {
    throw new AccountApiError(0, 'INVALID_RESPONSE', '账号服务返回的登录信息异常')
  }
  return {
    accessToken: e.accessToken,
    refreshToken: e.refreshToken,
    refreshTokenExpiresAt: e.refreshTokenExpiresAt,
    user: normalizeUser(e.user)
  }
}

function errorMessageOf(payload: unknown, fallback: string): string {
  if (!isObj(payload)) return fallback
  const raw = payload.message
  if (Array.isArray(raw) && raw.length > 0) return String(raw[0])
  if (typeof raw === 'string' && raw.trim()) return raw
  return fallback
}

export function isSessionInvalidError(err: unknown): boolean {
  return (
    err instanceof AccountApiError &&
    (err.status === 401 ||
      err.code === 'REFRESH_TOKEN_INVALID' ||
      err.code === 'REFRESH_TOKEN_REUSED' ||
      err.code === 'SESSION_EXPIRED')
  )
}

function mimeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
}

export interface AccountState {
  status: 'authenticated' | 'guest'
  user: AccountUser | null
  persistenceAvailable: boolean
  restoreError?: string
}

interface SessionData {
  version: number
  refreshToken: string
  refreshTokenExpiresAt: string
  user: AccountUser
}

export class AccountClient {
  private userDataPath = ''
  private session: SessionData | null = null
  private accessToken = ''
  private sessionLoaded = false
  private refreshPromise: Promise<AccountUser> | null = null
  private restorePromise: Promise<AccountState> | null = null
  private persistenceAvailable = true
  private deviceInfoCache: { id: string; name: string } | null = null

  /** 由主进程注入 userData 路径 */
  bindUserData(userDataPath: string): void {
    this.userDataPath = userDataPath
  }

  private accountDirectory(): string {
    const base = this.userDataPath || app.getPath('userData')
    return path.join(base, 'account')
  }

  private sessionPath(): string {
    return path.join(this.accountDirectory(), 'session.bin')
  }

  private ensureAccountDirectory(): void {
    fs.mkdirSync(this.accountDirectory(), { recursive: true })
  }

  async getState(): Promise<AccountState> {
    return this.restorePromise
      ? this.restorePromise
      : (this.restorePromise = this.restoreState().finally(() => {
          this.restorePromise = null
        }))
  }

  async sendRegisterEmailCode(email: string): Promise<unknown> {
    return this.requestJson('/auth/register/email/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim() })
    })
  }

  async register(input: {
    account: string
    password: string
    email: string
    emailCode: string
    nickname?: string
    gender?: string
  }): Promise<AccountState> {
    const device = this.getDeviceInfo()
    const auth = parseAuthResponse(
      await this.requestJson(
        '/auth/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            account: input.account.trim(),
            password: input.password,
            email: input.email.trim(),
            emailCode: input.emailCode.trim(),
            nickname: input.nickname?.trim() || input.account.trim(),
            gender: input.gender || 'unknown',
            deviceId: device.id,
            deviceName: device.name
          })
        },
        false
      )
    )
    await this.saveAuthResponse(auth)
    return this.toAccountState()
  }

  async login(input: { account: string; password: string }): Promise<AccountState> {
    const device = this.getDeviceInfo()
    const auth = parseAuthResponse(
      await this.requestJson(
        '/auth/login',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            account: input.account.trim(),
            password: input.password,
            deviceId: device.id,
            deviceName: device.name
          })
        },
        false
      )
    )
    await this.saveAuthResponse(auth)
    return this.toAccountState()
  }

  async sendPasswordResetEmailCode(email: string): Promise<unknown> {
    return this.requestJson(
      '/auth/password-reset/code',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() })
      },
      false
    )
  }

  async resetPassword(input: { account?: string; email: string; emailCode: string; newPassword: string }): Promise<unknown> {
    return this.requestJson(
      '/auth/password-reset',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account: input.account?.trim(),
          email: input.email.trim(),
          emailCode: input.emailCode.trim(),
          newPassword: input.newPassword
        })
      },
      false
    )
  }

  async changePassword(input: { newPassword: string; confirmPassword: string }): Promise<unknown> {
    await this.authorizedRequest('/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword: input.newPassword, confirmPassword: input.confirmPassword })
    })
  }

  async logout(): Promise<AccountState> {
    await this.ensureSessionLoaded()
    const refreshToken = this.session?.refreshToken
    await this.clearSession()
    if (refreshToken) {
      await this.requestJson(
        '/auth/logout',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken })
        },
        false
      ).catch((err) => {
        console.warn('[账号] 通知服务端退出失败，本地会话已清理:', err)
      })
    }
    return this.toAccountState()
  }

  async updateProfile(patch: Record<string, unknown>): Promise<unknown> {
    const user = await this.authorizedRequest('/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...patch,
        nickname: (patch.nickname as string | undefined)?.trim(),
        bio: (patch.bio as string | undefined)?.trim()
      })
    })
    await this.updateCachedUser(user)
    return user
  }

  async sendBindingEmailCode(email: string): Promise<unknown> {
    return this.authorizedRequest('/me/email/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim() })
    })
  }

  async bindEmail(email: string, code: string): Promise<unknown> {
    const user = await this.authorizedRequest('/me/email/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), code: code.trim() })
    })
    await this.updateCachedUser(user)
    return user
  }

  async selectAndUploadMedia(kind: 'avatar' | 'background', parentWindow?: BrowserWindow | null): Promise<unknown | null> {
    const options = {
      title: kind === 'avatar' ? '选择头像' : '选择个人背景',
      properties: ['openFile' as const],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
    }
    const result = parentWindow
      ? await dialog.showOpenDialog(parentWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    if (fs.statSync(filePath).size > IMAGE_MAX_BYTES) {
      throw new AccountApiError(0, 'IMAGE_TOO_LARGE', '图片不能超过 10 MB')
    }
    const bytes = fs.readFileSync(filePath)
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeForFile(filePath) }), path.basename(filePath))
    const user = await this.authorizedRequest(kind === 'avatar' ? '/me/avatar' : '/me/background', {
      method: 'PUT',
      body: form
    })
    await this.updateCachedUser(user)
    return user
  }

  async removeMedia(kind: 'avatar' | 'background'): Promise<unknown> {
    const user = await this.authorizedRequest(kind === 'avatar' ? '/me/avatar' : '/me/background', { method: 'DELETE' })
    await this.updateCachedUser(user)
    return user
  }

  getDeviceIdentity(): { id: string; name: string } {
    return { ...this.getDeviceInfo() }
  }

  /** 领网关券时可选附带账号 access token（未登录返回空串） */
  async getAccessTokenForGateway(): Promise<string> {
    await this.ensureSessionLoaded()
    if (!this.session) return ''
    if (!this.accessToken) {
      try {
        await this.refreshSession()
      } catch {
        return ''
      }
    }
    return this.accessToken
  }

  async getPlaylistSnapshot(): Promise<unknown> {
    return this.authorizedRequest('/library/playlists/snapshot', { method: 'GET' })
  }

  async syncPlaylists(cursor: number, changes: Array<Record<string, unknown>>): Promise<unknown> {
    const device = this.getDeviceInfo()
    return this.authorizedRequest('/library/playlists/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: device.id,
        deviceName: device.name,
        cursor: Math.max(0, Math.floor(cursor)),
        changes: changes.slice(0, 100).map((c) => ({
          clientMutationId: c.clientMutationId,
          origin: c.origin,
          operation: c.operation,
          playlistId: c.playlistId,
          expectedRevision: c.expectedRevision,
          playlist: c.playlist,
          tracks: c.tracks,
          trackIds: c.trackIds,
          orderedTrackIds: c.orderedTrackIds
        }))
      })
    })
  }

  async overwritePlaylists(playlists: Array<Record<string, unknown>>): Promise<unknown> {
    const device = this.getDeviceInfo()
    return this.authorizedRequest('/library/playlists/overwrite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: device.id,
        deviceName: device.name,
        playlists: playlists.slice(0, 1000)
      })
    })
  }

  async getPlaylistStatus(): Promise<unknown> {
    return this.authorizedRequest('/library/playlists/status', { method: 'GET' })
  }

  async getFavoriteSnapshot(): Promise<unknown> {
    return this.authorizedRequest('/library/favorites/snapshot', { method: 'GET' })
  }

  async syncFavorites(cursor: number, changes: Array<Record<string, unknown>>): Promise<unknown> {
    const device = this.getDeviceInfo()
    return this.authorizedRequest('/library/favorites/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: device.id,
        deviceName: device.name,
        cursor: Math.max(0, Math.floor(cursor)),
        changes: changes.slice(0, 100)
      })
    })
  }

  async overwriteFavorites(favorites: Array<Record<string, unknown>>): Promise<unknown> {
    const device = this.getDeviceInfo()
    return this.authorizedRequest('/library/favorites/overwrite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: device.id,
        deviceName: device.name,
        favorites: favorites.slice(0, 5000)
      })
    })
  }

  private async restoreState(): Promise<AccountState> {
    await this.ensureSessionLoaded()
    if (!this.session) return this.toAccountState()
    if (!this.accessToken) {
      try {
        await this.refreshSession()
      } catch (err) {
        if (isSessionInvalidError(err)) await this.clearSession()
        return {
          ...this.toAccountState(),
          restoreError: err instanceof Error ? err.message : '恢复登录状态失败'
        }
      }
    }
    return this.toAccountState()
  }

  private async ensureSessionLoaded(): Promise<void> {
    if (this.sessionLoaded) return
    this.sessionLoaded = true
    this.persistenceAvailable = safeStorage.isEncryptionAvailable()
    if (!this.persistenceAvailable) return
    try {
      const buf = fs.readFileSync(this.sessionPath())
      const raw = safeStorage.decryptString(buf)
      const json = JSON.parse(raw)
      if (json.version !== SESSION_VERSION || typeof json.refreshToken !== 'string' || typeof json.refreshTokenExpiresAt !== 'string') {
        this.clearStoredSessionFile()
        return
      }
      this.session = {
        version: SESSION_VERSION,
        refreshToken: json.refreshToken,
        refreshTokenExpiresAt: json.refreshTokenExpiresAt,
        user: normalizeUser(json.user)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[账号] 读取加密会话失败，将按未登录状态继续:', err)
        this.clearStoredSessionFile()
      }
    }
  }

  private async saveAuthResponse(auth: { accessToken: string; refreshToken: string; refreshTokenExpiresAt: string; user: AccountUser }): Promise<void> {
    this.session = {
      version: SESSION_VERSION,
      refreshToken: auth.refreshToken,
      refreshTokenExpiresAt: auth.refreshTokenExpiresAt,
      user: auth.user
    }
    this.accessToken = auth.accessToken
    this.sessionLoaded = true
    this.persistSession()
  }

  private async updateCachedUser(user: unknown): Promise<void> {
    if (this.session) {
      this.session = { ...this.session, user: normalizeUser(user) }
      this.persistSession()
    }
  }

  private persistSession(): void {
    if (!this.session || !safeStorage.isEncryptionAvailable()) {
      this.persistenceAvailable = safeStorage.isEncryptionAvailable()
      return
    }
    this.persistenceAvailable = true
    this.ensureAccountDirectory()
    const encrypted = safeStorage.encryptString(JSON.stringify(this.session))
    const file = this.sessionPath()
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, encrypted)
    fs.renameSync(tmp, file)
  }

  private async clearSession(): Promise<void> {
    this.session = null
    this.accessToken = ''
    this.sessionLoaded = true
    this.clearStoredSessionFile()
  }

  private clearStoredSessionFile(): void {
    try {
      fs.rmSync(this.sessionPath(), { force: true })
    } catch (err) {
      console.warn('[账号] 清理本地会话文件失败:', err)
    }
  }

  private async refreshSession(): Promise<AccountUser> {
    return this.refreshPromise
      ? this.refreshPromise
      : (this.refreshPromise = this.performRefresh().finally(() => {
          this.refreshPromise = null
        }))
  }

  private async performRefresh(): Promise<AccountUser> {
    await this.ensureSessionLoaded()
    if (!this.session?.refreshToken) {
      throw new AccountApiError(401, 'SESSION_EXPIRED', '登录状态已失效，请重新登录')
    }
    try {
      const auth = parseAuthResponse(
        await this.requestJson(
          '/auth/refresh',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: this.session.refreshToken, deviceId: this.getDeviceInfo().id })
          },
          false
        )
      )
      await this.saveAuthResponse(auth)
      return auth.user
    } catch (err) {
      if (isSessionInvalidError(err)) await this.clearSession()
      throw err
    }
  }

  private async authorizedRequest(path: string, init: RequestInit = {}): Promise<unknown> {
    await this.ensureSessionLoaded()
    if (!this.session) throw new AccountApiError(401, 'SESSION_EXPIRED', '请先登录')
    if (!this.accessToken) await this.refreshSession()
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${this.accessToken}`)
    const res = await this.fetchWithFallback(path, { ...init, headers })
    if (res.status === 401) {
      await this.refreshSession()
      const retryHeaders = new Headers(init.headers)
      retryHeaders.set('Authorization', `Bearer ${this.accessToken}`)
      return this.parseResponse(await this.fetchWithFallback(path, { ...init, headers: retryHeaders }))
    }
    return this.parseResponse(res)
  }

  private async requestJson(path: string, init: RequestInit, authorized: boolean): Promise<unknown> {
    return authorized
      ? this.authorizedRequest(path, init)
      : this.parseResponse(await this.fetchWithFallback(path, init))
  }

  private async fetchWithFallback(path: string, init: RequestInit): Promise<Response> {
    let lastError: unknown = null
    for (const server of SERVERS) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        return await fetch(`${server}${path}`, { ...init, signal: controller.signal })
      } catch (err) {
        lastError = err
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError instanceof Error && lastError.name === 'AbortError'
      ? new AccountApiError(0, 'REQUEST_TIMEOUT', '账号服务器响应超时')
      : new AccountApiError(0, 'NETWORK_ERROR', '无法连接账号服务器，请检查网络')
  }

  private async parseResponse(res: Response): Promise<unknown> {
    const text = await res.text()
    let payload: unknown = null
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = null
      }
    }
    if (!res.ok) {
      const code = isObj(payload) && typeof payload.code === 'string' ? payload.code : `HTTP_${res.status}`
      throw new AccountApiError(res.status, code, errorMessageOf(payload, '账号请求失败，请稍后重试'))
    }
    return payload
  }

  private toAccountState(): AccountState {
    return {
      status: this.session ? 'authenticated' : 'guest',
      user: this.session?.user || null,
      persistenceAvailable: this.persistenceAvailable
    }
  }

  private getDeviceInfo(): { id: string; name: string } {
    if (this.deviceInfoCache) return this.deviceInfoCache
    this.ensureAccountDirectory()
    const file = path.join(this.accountDirectory(), 'device.json')
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (typeof json.id === 'string' && json.id.length >= 8 && typeof json.name === 'string') {
        this.deviceInfoCache = { id: json.id, name: json.name }
        return this.deviceInfoCache
      }
    } catch {
      /* 生成新设备档案 */
    }
    const host = os.hostname().trim().slice(0, 80) || 'PC'
    const info = { id: randomUUID(), name: `LGMusic Desktop (${host})` }
    fs.writeFileSync(file, JSON.stringify(info, null, 2))
    this.deviceInfoCache = info
    return info
  }
}

export const accountClient = new AccountClient()

/** 账号错误 → 错误信息对象 */
export function accountErrorInfo(err: unknown): { code: string; message: string; status: number } {
  return err instanceof AccountApiError
    ? { code: err.code, message: err.message, status: err.status }
    : { code: 'ACCOUNT_UNKNOWN_ERROR', message: err instanceof Error ? err.message : '账号操作失败，请稍后重试', status: 0 }
}
