import { app, dialog, safeStorage, session, ipcMain, shell, nativeImage, Tray, Menu, BrowserWindow } from "electron";
import fs from "node:fs";
import path, { join } from "node:path";
import { Stream } from "node:stream";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import { randomUUID, createHmac, randomBytes, createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import fsp from "node:fs/promises";
import { pathToFileURL } from "node:url";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
const SERVERS = ["https://musicserver.haitangw.cc/v1", "https://qt.haitangw.net/v1"];
const REQUEST_TIMEOUT_MS$1 = 15e3;
const SESSION_VERSION = 1;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
class AccountApiError extends Error {
  status;
  code;
  constructor(status, code, message) {
    super(message);
    this.name = "AccountApiError";
    this.status = status;
    this.code = code;
  }
}
const isObj$5 = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const genderOf = (v) => v === "male" || v === "female" ? v : "unknown";
function normalizeUser(e) {
  if (!isObj$5(e) || typeof e.id !== "string") {
    throw new AccountApiError(0, "INVALID_RESPONSE", "账号服务返回的用户资料异常");
  }
  return {
    id: e.id,
    account: String(e.account || ""),
    email: typeof e.email === "string" ? e.email : null,
    emailVerified: e.emailVerified === true,
    nickname: String(e.nickname || e.account || "甘露用户"),
    gender: genderOf(e.gender),
    avatarUrl: typeof e.avatarUrl === "string" ? e.avatarUrl : null,
    backgroundUrl: typeof e.backgroundUrl === "string" ? e.backgroundUrl : null,
    bio: typeof e.bio === "string" ? e.bio : null,
    showAccount: e.showAccount !== false,
    showListeningAge: e.showListeningAge !== false,
    showBio: e.showBio !== false,
    showBackground: e.showBackground !== false,
    cloudSyncEnabled: e.cloudSyncEnabled !== false,
    cloudSyncAutoEnabled: e.cloudSyncAutoEnabled !== false,
    createdAt: typeof e.createdAt === "string" ? e.createdAt : (/* @__PURE__ */ new Date()).toISOString(),
    updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : (/* @__PURE__ */ new Date()).toISOString()
  };
}
function parseAuthResponse(e) {
  if (!isObj$5(e) || typeof e.accessToken !== "string" || typeof e.refreshToken !== "string" || typeof e.refreshTokenExpiresAt !== "string") {
    throw new AccountApiError(0, "INVALID_RESPONSE", "账号服务返回的登录信息异常");
  }
  return {
    accessToken: e.accessToken,
    refreshToken: e.refreshToken,
    refreshTokenExpiresAt: e.refreshTokenExpiresAt,
    user: normalizeUser(e.user)
  };
}
function errorMessageOf$1(payload, fallback) {
  if (!isObj$5(payload)) return fallback;
  const raw = payload.message;
  if (Array.isArray(raw) && raw.length > 0) return String(raw[0]);
  if (typeof raw === "string" && raw.trim()) return raw;
  return fallback;
}
function isSessionInvalidError(err) {
  return err instanceof AccountApiError && (err.status === 401 || err.code === "REFRESH_TOKEN_INVALID" || err.code === "REFRESH_TOKEN_REUSED" || err.code === "SESSION_EXPIRED");
}
function mimeForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
}
class AccountClient {
  userDataPath = "";
  session = null;
  accessToken = "";
  sessionLoaded = false;
  refreshPromise = null;
  restorePromise = null;
  persistenceAvailable = true;
  deviceInfoCache = null;
  /** 由主进程注入 userData 路径 */
  bindUserData(userDataPath) {
    this.userDataPath = userDataPath;
  }
  accountDirectory() {
    const base = this.userDataPath || app.getPath("userData");
    return path.join(base, "account");
  }
  sessionPath() {
    return path.join(this.accountDirectory(), "session.bin");
  }
  ensureAccountDirectory() {
    fs.mkdirSync(this.accountDirectory(), { recursive: true });
  }
  async getState() {
    return this.restorePromise ? this.restorePromise : this.restorePromise = this.restoreState().finally(() => {
      this.restorePromise = null;
    });
  }
  async sendRegisterEmailCode(email) {
    return this.requestJson("/auth/register/email/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim() })
    });
  }
  async register(input) {
    const device = this.getDeviceInfo();
    const auth = parseAuthResponse(
      await this.requestJson(
        "/auth/register",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            account: input.account.trim(),
            password: input.password,
            email: input.email.trim(),
            emailCode: input.emailCode.trim(),
            nickname: input.nickname?.trim() || input.account.trim(),
            gender: input.gender || "unknown",
            deviceId: device.id,
            deviceName: device.name
          })
        },
        false
      )
    );
    await this.saveAuthResponse(auth);
    return this.toAccountState();
  }
  async login(input) {
    const device = this.getDeviceInfo();
    const auth = parseAuthResponse(
      await this.requestJson(
        "/auth/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            account: input.account.trim(),
            password: input.password,
            deviceId: device.id,
            deviceName: device.name
          })
        },
        false
      )
    );
    await this.saveAuthResponse(auth);
    return this.toAccountState();
  }
  async sendPasswordResetEmailCode(email) {
    return this.requestJson(
      "/auth/password-reset/code",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() })
      },
      false
    );
  }
  async resetPassword(input) {
    return this.requestJson(
      "/auth/password-reset",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account: input.account?.trim(),
          email: input.email.trim(),
          emailCode: input.emailCode.trim(),
          newPassword: input.newPassword
        })
      },
      false
    );
  }
  async changePassword(input) {
    await this.authorizedRequest("/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword: input.newPassword, confirmPassword: input.confirmPassword })
    });
  }
  async logout() {
    await this.ensureSessionLoaded();
    const refreshToken = this.session?.refreshToken;
    await this.clearSession();
    if (refreshToken) {
      await this.requestJson(
        "/auth/logout",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken })
        },
        false
      ).catch((err) => {
        console.warn("[账号] 通知服务端退出失败，本地会话已清理:", err);
      });
    }
    return this.toAccountState();
  }
  async updateProfile(patch) {
    const user = await this.authorizedRequest("/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...patch,
        nickname: patch.nickname?.trim(),
        bio: patch.bio?.trim()
      })
    });
    await this.updateCachedUser(user);
    return user;
  }
  async sendBindingEmailCode(email) {
    return this.authorizedRequest("/me/email/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim() })
    });
  }
  async bindEmail(email, code) {
    const user = await this.authorizedRequest("/me/email/bind", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), code: code.trim() })
    });
    await this.updateCachedUser(user);
    return user;
  }
  async selectAndUploadMedia(kind, parentWindow) {
    const options = {
      title: kind === "avatar" ? "选择头像" : "选择个人背景",
      properties: ["openFile"],
      filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "webp"] }]
    };
    const result = parentWindow ? await dialog.showOpenDialog(parentWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    if (fs.statSync(filePath).size > IMAGE_MAX_BYTES) {
      throw new AccountApiError(0, "IMAGE_TOO_LARGE", "图片不能超过 10 MB");
    }
    const bytes = fs.readFileSync(filePath);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeForFile(filePath) }), path.basename(filePath));
    const user = await this.authorizedRequest(kind === "avatar" ? "/me/avatar" : "/me/background", {
      method: "PUT",
      body: form
    });
    await this.updateCachedUser(user);
    return user;
  }
  async removeMedia(kind) {
    const user = await this.authorizedRequest(kind === "avatar" ? "/me/avatar" : "/me/background", { method: "DELETE" });
    await this.updateCachedUser(user);
    return user;
  }
  getDeviceIdentity() {
    return { ...this.getDeviceInfo() };
  }
  /** 领网关券时可选附带账号 access token（未登录返回空串） */
  async getAccessTokenForGateway() {
    await this.ensureSessionLoaded();
    if (!this.session) return "";
    if (!this.accessToken) {
      try {
        await this.refreshSession();
      } catch {
        return "";
      }
    }
    return this.accessToken;
  }
  async getPlaylistSnapshot() {
    return this.authorizedRequest("/library/playlists/snapshot", { method: "GET" });
  }
  async syncPlaylists(cursor, changes) {
    const device = this.getDeviceInfo();
    return this.authorizedRequest("/library/playlists/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    });
  }
  async overwritePlaylists(playlists) {
    const device = this.getDeviceInfo();
    return this.authorizedRequest("/library/playlists/overwrite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: device.id,
        deviceName: device.name,
        playlists: playlists.slice(0, 1e3)
      })
    });
  }
  async getPlaylistStatus() {
    return this.authorizedRequest("/library/playlists/status", { method: "GET" });
  }
  async getFavoriteSnapshot() {
    return this.authorizedRequest("/library/favorites/snapshot", { method: "GET" });
  }
  async syncFavorites(cursor, changes) {
    const device = this.getDeviceInfo();
    return this.authorizedRequest("/library/favorites/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: device.id,
        deviceName: device.name,
        cursor: Math.max(0, Math.floor(cursor)),
        changes: changes.slice(0, 100)
      })
    });
  }
  async overwriteFavorites(favorites) {
    const device = this.getDeviceInfo();
    return this.authorizedRequest("/library/favorites/overwrite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: device.id,
        deviceName: device.name,
        favorites: favorites.slice(0, 5e3)
      })
    });
  }
  async restoreState() {
    await this.ensureSessionLoaded();
    if (!this.session) return this.toAccountState();
    if (!this.accessToken) {
      try {
        await this.refreshSession();
      } catch (err) {
        if (isSessionInvalidError(err)) await this.clearSession();
        return {
          ...this.toAccountState(),
          restoreError: err instanceof Error ? err.message : "恢复登录状态失败"
        };
      }
    }
    return this.toAccountState();
  }
  async ensureSessionLoaded() {
    if (this.sessionLoaded) return;
    this.sessionLoaded = true;
    this.persistenceAvailable = safeStorage.isEncryptionAvailable();
    if (!this.persistenceAvailable) return;
    try {
      const buf = fs.readFileSync(this.sessionPath());
      const raw = safeStorage.decryptString(buf);
      const json = JSON.parse(raw);
      if (json.version !== SESSION_VERSION || typeof json.refreshToken !== "string" || typeof json.refreshTokenExpiresAt !== "string") {
        this.clearStoredSessionFile();
        return;
      }
      this.session = {
        version: SESSION_VERSION,
        refreshToken: json.refreshToken,
        refreshTokenExpiresAt: json.refreshTokenExpiresAt,
        user: normalizeUser(json.user)
      };
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.warn("[账号] 读取加密会话失败，将按未登录状态继续:", err);
        this.clearStoredSessionFile();
      }
    }
  }
  async saveAuthResponse(auth) {
    this.session = {
      version: SESSION_VERSION,
      refreshToken: auth.refreshToken,
      refreshTokenExpiresAt: auth.refreshTokenExpiresAt,
      user: auth.user
    };
    this.accessToken = auth.accessToken;
    this.sessionLoaded = true;
    this.persistSession();
  }
  async updateCachedUser(user) {
    if (this.session) {
      this.session = { ...this.session, user: normalizeUser(user) };
      this.persistSession();
    }
  }
  persistSession() {
    if (!this.session || !safeStorage.isEncryptionAvailable()) {
      this.persistenceAvailable = safeStorage.isEncryptionAvailable();
      return;
    }
    this.persistenceAvailable = true;
    this.ensureAccountDirectory();
    const encrypted = safeStorage.encryptString(JSON.stringify(this.session));
    const file = this.sessionPath();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, encrypted);
    fs.renameSync(tmp, file);
  }
  async clearSession() {
    this.session = null;
    this.accessToken = "";
    this.sessionLoaded = true;
    this.clearStoredSessionFile();
  }
  clearStoredSessionFile() {
    try {
      fs.rmSync(this.sessionPath(), { force: true });
    } catch (err) {
      console.warn("[账号] 清理本地会话文件失败:", err);
    }
  }
  async refreshSession() {
    return this.refreshPromise ? this.refreshPromise : this.refreshPromise = this.performRefresh().finally(() => {
      this.refreshPromise = null;
    });
  }
  async performRefresh() {
    await this.ensureSessionLoaded();
    if (!this.session?.refreshToken) {
      throw new AccountApiError(401, "SESSION_EXPIRED", "登录状态已失效，请重新登录");
    }
    try {
      const auth = parseAuthResponse(
        await this.requestJson(
          "/auth/refresh",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refreshToken: this.session.refreshToken, deviceId: this.getDeviceInfo().id })
          },
          false
        )
      );
      await this.saveAuthResponse(auth);
      return auth.user;
    } catch (err) {
      if (isSessionInvalidError(err)) await this.clearSession();
      throw err;
    }
  }
  async authorizedRequest(path2, init = {}) {
    await this.ensureSessionLoaded();
    if (!this.session) throw new AccountApiError(401, "SESSION_EXPIRED", "请先登录");
    if (!this.accessToken) await this.refreshSession();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.accessToken}`);
    const res = await this.fetchWithFallback(path2, { ...init, headers });
    if (res.status === 401) {
      await this.refreshSession();
      const retryHeaders = new Headers(init.headers);
      retryHeaders.set("Authorization", `Bearer ${this.accessToken}`);
      return this.parseResponse(await this.fetchWithFallback(path2, { ...init, headers: retryHeaders }));
    }
    return this.parseResponse(res);
  }
  async requestJson(path2, init, authorized) {
    return authorized ? this.authorizedRequest(path2, init) : this.parseResponse(await this.fetchWithFallback(path2, init));
  }
  async fetchWithFallback(path2, init) {
    let lastError = null;
    for (const server of SERVERS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS$1);
      try {
        return await fetch(`${server}${path2}`, { ...init, signal: controller.signal });
      } catch (err) {
        lastError = err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error && lastError.name === "AbortError" ? new AccountApiError(0, "REQUEST_TIMEOUT", "账号服务器响应超时") : new AccountApiError(0, "NETWORK_ERROR", "无法连接账号服务器，请检查网络");
  }
  async parseResponse(res) {
    const text = await res.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!res.ok) {
      const code = isObj$5(payload) && typeof payload.code === "string" ? payload.code : `HTTP_${res.status}`;
      throw new AccountApiError(res.status, code, errorMessageOf$1(payload, "账号请求失败，请稍后重试"));
    }
    return payload;
  }
  toAccountState() {
    return {
      status: this.session ? "authenticated" : "guest",
      user: this.session?.user || null,
      persistenceAvailable: this.persistenceAvailable
    };
  }
  getDeviceInfo() {
    if (this.deviceInfoCache) return this.deviceInfoCache;
    this.ensureAccountDirectory();
    const file = path.join(this.accountDirectory(), "device.json");
    try {
      const json = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof json.id === "string" && json.id.length >= 8 && typeof json.name === "string") {
        this.deviceInfoCache = { id: json.id, name: json.name };
        return this.deviceInfoCache;
      }
    } catch {
    }
    const host = os.hostname().trim().slice(0, 80) || "PC";
    const info = { id: randomUUID(), name: `LGMusic Desktop (${host})` };
    fs.writeFileSync(file, JSON.stringify(info, null, 2));
    this.deviceInfoCache = info;
    return info;
  }
}
const accountClient = new AccountClient();
function accountErrorInfo(err) {
  return err instanceof AccountApiError ? { code: err.code, message: err.message, status: err.status } : { code: "ACCOUNT_UNKNOWN_ERROR", message: err instanceof Error ? err.message : "账号操作失败，请稍后重试", status: 0 };
}
const GATEWAY_APP_ID = String(
  process.env.QING_GATEWAY_APP_ID || "qingmusic-desktop"
).trim();
const GATEWAY_SIGN_SECRET = String(
  process.env.QING_GATEWAY_SIGN_SECRET || "qm-gw-7c1f4e9a2b8d5360e1a7c4f9b2d8036c"
).trim();
const GATEWAY_SERVERS = [
  "https://musicserver.haitangw.cc/v1",
  "https://qt.haitangw.net/v1"
];
const KW_DECRYPT_RESOLVER_URL = String(
  process.env.QING_KW_DECRYPT_RESOLVER_URL || process.env.VITE_KW_DECRYPT_RESOLVER_URL || "http://175.27.166.236:8938"
).trim().replace(/\/+$/, "");
function bodySha256(body) {
  return createHash("sha256").update(body, "utf8").digest("hex");
}
function nonce() {
  return randomBytes(16).toString("hex");
}
function requestPath(url) {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return "/";
  }
}
function gatewayHeaders(method, url, body, identity) {
  const ts = String(Date.now());
  const n = nonce();
  const payload = [
    GATEWAY_APP_ID,
    ts,
    n,
    String(method).toUpperCase(),
    requestPath(url),
    bodySha256(body)
  ].join("\n");
  const sign = createHmac("sha256", GATEWAY_SIGN_SECRET).update(payload, "utf8").digest("hex");
  const auth = identity.ticket ? `Bearer ${identity.ticket}` : identity.accessToken ? `Bearer ${identity.accessToken}` : "";
  return {
    "X-Qing-App-Id": GATEWAY_APP_ID,
    "X-Qing-App-Version": identity.appVersion,
    "X-Qing-Device-Id": identity.deviceId,
    "X-Qing-Ts": ts,
    "X-Qing-Nonce": n,
    "X-Qing-Sign": sign,
    ...auth ? { Authorization: auth } : {}
  };
}
class FetchTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "FetchTimeoutError";
  }
}
class GatewayServiceError extends Error {
  code;
  traceId;
  httpStatus;
  retryAfter;
  constructor(message, opts) {
    super(message);
    this.name = "GatewayServiceError";
    this.code = opts.code;
    this.traceId = opts.traceId;
    this.httpStatus = opts.httpStatus;
    this.retryAfter = opts.retryAfter;
  }
}
const isObj$4 = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const strOrUndef = (v) => typeof v !== "string" ? void 0 : v.trim() || void 0;
const strMap = (v) => {
  if (!isObj$4(v)) return void 0;
  const entries = Object.entries(v).flatMap(
    ([k, val]) => typeof val !== "string" && typeof val !== "number" && typeof val !== "boolean" ? [] : [[k, String(val)]]
  );
  return entries.length ? Object.fromEntries(entries) : void 0;
};
const parseExpiry = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return void 0;
  return n < 1e12 ? n * 1e3 : n;
};
const REQUEST_TIMEOUT_MS = 12e3;
const RESOLVE_TTL_MS = 45e3;
const TICKET_REQUEST_TIMEOUT_MS = 8e3;
const TICKET_RETRY_DELAY_MS = 30 * 60 * 1e3;
const TICKET_DISABLED_RETRY_MS = 60 * 60 * 1e3;
const TICKET_GRACE_SECONDS = 24 * 60 * 60;
const TICKET_REFRESH_MARGIN_MS = 30 * 60 * 1e3;
function newRequestId() {
  return `qmpc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
async function fetchWithTimeout(url, init, timeoutMs, message) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    throw timedOut ? new FetchTimeoutError(message) : err;
  } finally {
    clearTimeout(timer);
  }
}
function parseJsonPayload(text, res) {
  try {
    const json = JSON.parse(text);
    if (!isObj$4(json)) throw new Error("invalid payload");
    return json;
  } catch {
    const status = res?.status || 0;
    throw new GatewayServiceError("解析服务返回了无效数据", {
      code: status >= 500 ? `GATEWAY_HTTP_${status}` : "INVALID_GATEWAY_RESPONSE",
      ...status ? { httpStatus: status } : {}
    });
  }
}
function errorMessageOf(payload) {
  const direct = strOrUndef(payload.message);
  if (direct) return direct;
  const inner = payload.message;
  if (isObj$4(inner)) {
    const nested = strOrUndef(inner.message);
    if (nested) return nested;
  }
  const error = payload.error;
  if (isObj$4(error)) {
    const nested = strOrUndef(error.message);
    if (nested) return nested;
  }
  return "播放地址解析失败";
}
function serviceErrorOf(payload, res, traceId) {
  const rawCode = payload.code;
  const code = typeof rawCode === "string" && rawCode.trim() || (typeof rawCode === "number" && rawCode !== 0 ? String(rawCode) : "") || (res.ok ? "GATEWAY_REQUEST_FAILED" : `GATEWAY_HTTP_${res.status}`);
  const retryAfterBody = Number(payload.retry_after || 0);
  const retryAfterHeader = Number(res.headers.get("retry-after") || 0);
  const retryAfter = Number.isFinite(retryAfterBody) && retryAfterBody > 0 ? Math.trunc(retryAfterBody) : Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? Math.trunc(retryAfterHeader) : void 0;
  return new GatewayServiceError(errorMessageOf(payload), {
    code,
    traceId: strOrUndef(payload.traceId) || strOrUndef(res.headers.get("x-trace-id")) || traceId,
    httpStatus: res.status,
    retryAfter
  });
}
class MusicGatewayClient {
  identity;
  resolveCache = /* @__PURE__ */ new Map();
  ticket = null;
  ticketLoaded = false;
  ticketPending = null;
  ticketTimer = null;
  nextTicketAttemptAt = 0;
  constructor(identity) {
    this.identity = identity;
  }
  ticketPath() {
    return path.join(process.cwd(), ".ticket-local");
  }
  /** 由主进程注入 userData 路径 */
  userDataPath = "";
  bindUserData(userDataPath) {
    this.userDataPath = userDataPath;
  }
  resolveTicketPath() {
    return this.userDataPath ? path.join(this.userDataPath, "account", "gateway-ticket.bin") : this.ticketPath();
  }
  startTicketRefresh() {
    this.ensureTicket();
    if (this.ticketTimer) clearInterval(this.ticketTimer);
    this.ticketTimer = setInterval(() => {
      this.ensureTicket();
    }, TICKET_REFRESH_MARGIN_MS);
    this.ticketTimer.unref?.();
  }
  dispose() {
    if (this.ticketTimer) {
      clearInterval(this.ticketTimer);
      this.ticketTimer = null;
    }
  }
  async resolve(input) {
    const source = String(input?.source || "wy").trim().toLowerCase();
    const rid = String(input?.rid || "").trim();
    const level = String(input?.level || "standard").trim() || "standard";
    if (!rid) throw new GatewayServiceError("歌曲 ID 为空", { code: "EMPTY_TRACK_ID" });
    const cacheKey = `${source}|${rid}|${level}`;
    const cached = this.resolveCache.get(cacheKey);
    if (!input?.force && cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached) this.resolveCache.delete(cacheKey);
    let result;
    if (source === "kw") {
      try {
        result = await this.resolveFromGateway(source, rid, level);
      } catch (err) {
        if (!this.shouldFallbackToLocalDecrypt(err)) throw err;
        console.warn("[音乐网关] 正式网关不可用，回退酷我本地解密线路:", {
          code: err instanceof GatewayServiceError ? err.code : "UNKNOWN"
        });
        result = await this.resolveFromKwDecryptLine(rid, level);
      }
    } else {
      result = await this.resolveFromGateway(source, rid, level);
    }
    const now = Date.now();
    const expiresAt = result.expiresAt && result.expiresAt > now ? Math.min(result.expiresAt, now + RESOLVE_TTL_MS) : now + RESOLVE_TTL_MS;
    this.resolveCache.set(cacheKey, { expiresAt, value: result });
    return result;
  }
  clearCache() {
    this.resolveCache.clear();
  }
  async resolveFromGateway(source, rid, level) {
    const body = JSON.stringify({ source, rid, level });
    const appVersion = this.identity.getAppVersion();
    const deviceId = this.identity.getDeviceId();
    let lastError = null;
    for (const server of GATEWAY_SERVERS) {
      const url = `${server}/music/resolve-url`;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const ticket = this.getTicketForRequest();
          if (!ticket) this.ensureTicket();
          const requestId = newRequestId();
          const res = await fetchWithTimeout(
            url,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                "X-Request-Id": requestId,
                ...gatewayHeaders("POST", url, body, {
                  appVersion,
                  deviceId,
                  ticket
                })
              },
              body
            },
            REQUEST_TIMEOUT_MS,
            "播放地址解析超时"
          );
          const payload = parseJsonPayload(await res.text(), res);
          const traceId = strOrUndef(payload.traceId) || res.headers.get("x-trace-id") || requestId;
          const okCode = payload.code === 0 || payload.code === "0";
          if (!res.ok || !okCode) {
            const err = serviceErrorOf(payload, res, traceId);
            if (err.code === "APP_UPGRADE_REQUIRED" && attempt === 0) {
              this.clearTicket();
              await this.ensureTicket(true);
              continue;
            }
            throw err;
          }
          if (!isObj$4(payload.data)) {
            throw new GatewayServiceError("解析服务未返回播放数据", {
              code: "INVALID_GATEWAY_RESPONSE",
              traceId,
              httpStatus: res.status
            });
          }
          return this.toResolveResult(payload.data, level, traceId);
        } catch (err) {
          lastError = err;
          if (this.shouldTryNextGatewayLine(err)) break;
          throw err;
        }
      }
    }
    if (lastError instanceof GatewayServiceError) throw lastError;
    if (lastError instanceof FetchTimeoutError) {
      throw new GatewayServiceError(lastError.message, { code: "GATEWAY_TIMEOUT" });
    }
    throw new GatewayServiceError("无法连接播放地址解析服务", { code: "NETWORK_UNREACHABLE" });
  }
  async resolveFromKwDecryptLine(rid, level) {
    if (!KW_DECRYPT_RESOLVER_URL) {
      throw new GatewayServiceError("酷我本地解密线路未配置", { code: "LOCAL_DECRYPT_UNAVAILABLE" });
    }
    const query = new URLSearchParams({ id: rid, level, type: "json", mode: "local" });
    const requestId = newRequestId();
    const url = `${KW_DECRYPT_RESOLVER_URL}/kwurl?${query.toString()}`;
    try {
      const res = await fetchWithTimeout(
        url,
        { method: "GET", headers: { Accept: "application/json", "X-Request-Id": requestId } },
        REQUEST_TIMEOUT_MS,
        "本地解密线路超时"
      );
      const payload = parseJsonPayload(await res.text(), res);
      const okCode = payload.code === 0 || payload.code === 200 || payload.code === "0" || payload.code === "200";
      if (!res.ok || !okCode || !isObj$4(payload.data)) {
        throw new GatewayServiceError(
          strOrUndef(payload.msg) || strOrUndef(payload.message) || "酷我本地解密线路解析失败",
          { code: "LOCAL_DECRYPT_FAILED", traceId: requestId, httpStatus: res.status }
        );
      }
      return this.toResolveResult(payload.data, level, requestId);
    } catch (err) {
      if (err instanceof GatewayServiceError) throw err;
      if (err instanceof FetchTimeoutError) {
        throw new GatewayServiceError(err.message, { code: "LOCAL_DECRYPT_TIMEOUT", traceId: requestId });
      }
      throw new GatewayServiceError("无法连接酷我本地解密线路", {
        code: "LOCAL_DECRYPT_UNREACHABLE",
        traceId: requestId
      });
    }
  }
  toResolveResult(data, fallbackLevel, traceId) {
    const url = strOrUndef(data.url);
    if (!url) {
      throw new GatewayServiceError("播放地址解析失败", { code: "INVALID_GATEWAY_RESPONSE", traceId });
    }
    const headers = strMap(data.headers);
    const playbackHeaders2 = strMap(data.playbackHeaders) || headers;
    const needDecrypt = data.need_decrypt === true;
    const finalEkey = strOrUndef(data.final_ekey);
    if (needDecrypt && !finalEkey) {
      throw new GatewayServiceError("播放地址需要本地解密，但解析服务未返回解密密钥", {
        code: "MISSING_FINAL_EKEY",
        traceId
      });
    }
    const expiresAt = parseExpiry(data.expiresAt);
    return {
      url,
      ...Array.isArray(data.backupUrls) ? { backupUrls: data.backupUrls.map(String) } : {},
      ...headers ? { headers } : {},
      ...playbackHeaders2 ? { playbackHeaders: playbackHeaders2 } : {},
      ...strOrUndef(data.mimeType) ? { mimeType: strOrUndef(data.mimeType) } : {},
      ...strOrUndef(data.format) ? { format: strOrUndef(data.format) } : {},
      ...strOrUndef(data.result_format) ? { resultFormat: strOrUndef(data.result_format) } : {},
      ...needDecrypt ? { needDecrypt: true } : {},
      ...finalEkey ? { finalEkey } : {},
      ...strOrUndef(data.playback_mode) ? { playbackMode: strOrUndef(data.playback_mode) } : {},
      level: strOrUndef(data.level) || fallbackLevel,
      ...expiresAt ? { expiresAt } : {},
      traceId
    };
  }
  shouldTryNextGatewayLine(err) {
    if (err instanceof FetchTimeoutError) return true;
    if (!(err instanceof GatewayServiceError)) return false;
    if ((err.httpStatus || 0) >= 500) return true;
    return err.code === "NETWORK_UNREACHABLE" || err.code === "GATEWAY_TIMEOUT" || err.code === "UPSTREAM_TIMEOUT" || err.code === "UPSTREAM_NETWORK_ERROR" || err.code === "UPSTREAM_HTTP_5XX" || err.code === "UPSTREAM_HTTP_ERROR" || err.code === "UPSTREAM_INTERNAL_ERROR" || err.code === "UPSTREAM_UNAVAILABLE" || err.code === "INVALID_GATEWAY_RESPONSE";
  }
  shouldFallbackToLocalDecrypt(err) {
    if (err instanceof FetchTimeoutError) return true;
    if (!(err instanceof GatewayServiceError)) return false;
    if ((err.httpStatus || 0) >= 500) return true;
    return err.code === "NETWORK_UNREACHABLE" || err.code === "GATEWAY_TIMEOUT" || err.code === "UPSTREAM_TIMEOUT" || err.code === "UPSTREAM_NETWORK_ERROR" || err.code === "UPSTREAM_HTTP_5XX" || err.code === "UPSTREAM_HTTP_ERROR" || err.code === "UPSTREAM_INTERNAL_ERROR" || err.code === "UPSTREAM_UNAVAILABLE" || err.code === "CONFIG_UNAVAILABLE" || err.code === "INVALID_GATEWAY_RESPONSE" || err.code === "MISSING_FINAL_EKEY";
  }
  toErrorInfo(err) {
    if (err instanceof GatewayServiceError) {
      return {
        code: err.code,
        message: err.message,
        ...err.traceId ? { traceId: err.traceId } : {},
        ...err.httpStatus ? { httpStatus: err.httpStatus } : {},
        ...err.retryAfter ? { retryAfter: err.retryAfter } : {}
      };
    }
    if (err instanceof FetchTimeoutError) {
      return { code: "NETWORK_TIMEOUT", message: err.message };
    }
    return {
      code: "GATEWAY_INTERNAL_ERROR",
      message: err instanceof Error ? err.message : "播放地址解析失败"
    };
  }
  async ensureTicket(force = false) {
    if (force) {
      this.clearTicket();
      this.nextTicketAttemptAt = 0;
    }
    if (!this.isTicketFresh() && !(force === false && Date.now() < this.nextTicketAttemptAt)) {
      if (!this.ticketPending) {
        this.ticketPending = this.requestTicket().finally(() => {
          this.ticketPending = null;
        });
      }
      return this.ticketPending;
    }
  }
  async requestTicket() {
    const appVersion = this.identity.getAppVersion();
    const deviceId = this.identity.getDeviceId();
    const accessToken = await this.identity.getAccessTokenForGateway();
    const body = JSON.stringify({ deviceId, appVersion, platform: process.platform });
    let lastError = null;
    for (const server of GATEWAY_SERVERS) {
      const url = `${server}/gateway/ticket`;
      try {
        const res = await fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              ...gatewayHeaders("POST", url, body, { appVersion, deviceId, accessToken })
            },
            body
          },
          TICKET_REQUEST_TIMEOUT_MS,
          "领取网关券超时"
        );
        const payload = parseJsonPayload(await res.text(), res);
        const ticket = strOrUndef(payload.ticket);
        const expiresAt = Number(payload.expiresAt);
        if (!res.ok || !ticket || !Number.isFinite(expiresAt) || expiresAt <= 0) {
          const code = strOrUndef(payload.code) || "";
          this.nextTicketAttemptAt = Date.now() + (code === "TICKET_DISABLED" ? TICKET_DISABLED_RETRY_MS : TICKET_RETRY_DELAY_MS);
          lastError = new Error(strOrUndef(payload.message) || "网关券领取失败");
          continue;
        }
        const graceSeconds = Number(payload.graceSeconds);
        const now = Date.now();
        this.saveTicket({
          ticket,
          expiresAt,
          refreshAt: Math.max(expiresAt - TICKET_REFRESH_MARGIN_MS, now + TICKET_REFRESH_MARGIN_MS),
          graceSeconds: Number.isFinite(graceSeconds) && graceSeconds > 0 ? graceSeconds : TICKET_GRACE_SECONDS,
          deviceId
        });
        this.nextTicketAttemptAt = 0;
        return;
      } catch (err) {
        lastError = err;
      }
    }
    this.nextTicketAttemptAt = this.nextTicketAttemptAt || Date.now() + TICKET_RETRY_DELAY_MS;
    console.warn("[网关券] 领取失败，继续使用请求签名:", {
      message: lastError instanceof Error ? lastError.message : String(lastError)
    });
  }
  isTicketFresh() {
    const t = this.readTicket();
    return t.ticket !== "" && t.refreshAt > 0 && Date.now() < t.refreshAt;
  }
  getTicketForRequest() {
    const t = this.readTicket();
    if (t.ticket === "" || t.expiresAt <= 0) return "";
    if (t.deviceId && t.deviceId !== this.identity.getDeviceId()) {
      this.clearTicket();
      return "";
    }
    return Date.now() <= t.expiresAt + t.graceSeconds * 1e3 ? t.ticket : "";
  }
  readTicket() {
    if (this.ticketLoaded) {
      return this.ticket || { ticket: "", expiresAt: 0, refreshAt: 0, graceSeconds: TICKET_GRACE_SECONDS, deviceId: "" };
    }
    this.ticketLoaded = true;
    try {
      const file = this.resolveTicketPath();
      if (!fs.existsSync(file)) return this.emptyTicket();
      const buf = fs.readFileSync(file);
      const raw = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString("utf8");
      const json = JSON.parse(raw);
      if (typeof json.ticket !== "string" || !Number.isFinite(Number(json.expiresAt)) || !Number.isFinite(Number(json.refreshAt))) {
        return this.emptyTicket();
      }
      this.ticket = {
        ticket: json.ticket,
        expiresAt: Number(json.expiresAt),
        refreshAt: Number(json.refreshAt),
        graceSeconds: Number.isFinite(Number(json.graceSeconds)) && Number(json.graceSeconds) > 0 ? Number(json.graceSeconds) : TICKET_GRACE_SECONDS,
        deviceId: typeof json.deviceId === "string" ? json.deviceId : ""
      };
      return this.ticket;
    } catch {
      return this.emptyTicket();
    }
  }
  saveTicket(data) {
    this.ticket = data;
    this.ticketLoaded = true;
    try {
      const file = this.resolveTicketPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const json = JSON.stringify(data);
      const encrypted = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, "utf8");
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, encrypted);
      fs.renameSync(tmp, file);
    } catch (err) {
      console.warn("[网关券] 保存本地缓存失败:", err);
    }
  }
  clearTicket() {
    this.ticket = null;
    this.ticketLoaded = true;
    try {
      fs.rmSync(this.resolveTicketPath(), { force: true });
    } catch (err) {
      console.warn("[网关券] 清理本地缓存失败:", err);
    }
  }
  emptyTicket() {
    return { ticket: "", expiresAt: 0, refreshAt: 0, graceSeconds: TICKET_GRACE_SECONDS, deviceId: "" };
  }
}
const TEA_DELTA = 2654435769;
const TEA_ROUNDS = 16;
const QMC_KEY_SIZE = 528;
function readU32(buf, offset) {
  return (buf[offset] << 24 | buf[offset + 1] << 16 | buf[offset + 2] << 8 | buf[offset + 3]) >>> 0;
}
function writeU32(buf, offset, value) {
  buf[offset] = value >>> 24 & 255;
  buf[offset + 1] = value >>> 16 & 255;
  buf[offset + 2] = value >>> 8 & 255;
  buf[offset + 3] = value & 255;
}
function teaDecryptBlock(block, key) {
  let y = readU32(block, 0);
  let z = readU32(block, 4);
  const k0 = readU32(key, 0);
  const k1 = readU32(key, 4);
  const k2 = readU32(key, 8);
  const k3 = readU32(key, 12);
  let sum = Math.imul(TEA_DELTA, TEA_ROUNDS) >>> 0;
  for (let i = 0; i < TEA_ROUNDS; i += 1) {
    z = z - (((y << 4) + k2 ^ y + sum ^ (y >>> 5) + k3) >>> 0) >>> 0;
    y = y - (((z << 4) + k0 ^ z + sum ^ (z >>> 5) + k1) >>> 0) >>> 0;
    sum = sum - TEA_DELTA >>> 0;
  }
  const out = Buffer.allocUnsafe(8);
  writeU32(out, 0, y);
  writeU32(out, 4, z);
  return out;
}
function teaUnpack(cipher, key) {
  if (cipher.length < 16 || cipher.length % 8 !== 0) throw new Error("QMC 密钥密文长度无效");
  let prevPlain = Buffer.alloc(8);
  let prevCipher = Buffer.alloc(8);
  const plain = Buffer.alloc(cipher.length);
  for (let off = 0; off < cipher.length; off += 8) {
    const chunk = cipher.subarray(off, off + 8);
    const xored = Buffer.allocUnsafe(8);
    for (let i = 0; i < xored.length; i += 1) xored[i] = chunk[i] ^ prevCipher[i];
    const decrypted = teaDecryptBlock(xored, key);
    for (let i = 0; i < decrypted.length; i += 1) plain[off + i] = decrypted[i] ^ prevPlain[i];
    prevPlain = Buffer.from(chunk);
    prevCipher = Buffer.from(decrypted);
  }
  const skip = (plain[0] & 7) + 3;
  const end = plain.length - 7;
  if (skip >= end) throw new Error("QMC 密钥填充长度无效");
  for (let i = end; i < plain.length; i += 1) {
    if (plain[i] !== 0) throw new Error("QMC 密钥尾部校验失败");
  }
  return plain.subarray(skip, end);
}
function seedKey() {
  const seed = Buffer.alloc(8);
  for (let i = 0; i < seed.length; i += 1) {
    seed[i] = Math.trunc(Math.abs(Math.tan(106 + i * 0.1)) * 100) & 255;
  }
  return seed;
}
function unpackEkey(encoded) {
  const cleaned = String(encoded || "").trim().replace(/\s+/g, "");
  if (!cleaned || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    throw new Error("QMC 解密密钥为空或格式无效");
  }
  const padded = cleaned + "=".repeat((4 - cleaned.length % 4) % 4);
  const cipher = Buffer.from(padded, "base64");
  if (cipher.length !== QMC_KEY_SIZE) {
    throw new Error(`QMC 解密密钥长度异常: ${cipher.length}`);
  }
  const seed = seedKey();
  const teaKey = Buffer.alloc(16);
  for (let i = 0; i < teaKey.length; i += 2) {
    teaKey[i] = seed[i / 2];
    teaKey[i + 1] = cipher[i / 2];
  }
  const body = teaUnpack(cipher.subarray(8), new Uint32Array(teaKey.buffer, teaKey.byteOffset, 4));
  return Buffer.concat([cipher.subarray(0, 8), body]);
}
const RC4_HEAD_SIZE = 128;
const RC4_SEGMENT_SIZE = 5120;
class QmcStreamDecoder {
  key;
  keySize;
  initialSbox;
  keyHash;
  constructor(encodedEkey) {
    this.key = unpackEkey(encodedEkey);
    this.keySize = this.key.length;
    this.initialSbox = this.createInitialSbox();
    this.keyHash = this.createKeyHash();
  }
  /** 原地解密一段数据（offset 为密文流内绝对偏移） */
  decrypt(data, offset) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("QMC 解密偏移量无效");
    const buf = Buffer.from(data);
    if (buf.length === 0) return buf;
    if (this.keySize <= 300) this.decryptMapMode(buf, offset);
    else this.decryptRc4Mode(buf, offset);
    return buf;
  }
  createInitialSbox() {
    const sbox = Buffer.alloc(this.keySize);
    for (let i = 0; i < sbox.length; i += 1) sbox[i] = i & 255;
    let j = 0;
    for (let i = 0; i < sbox.length; i += 1) {
      j = (sbox[i] + j + this.key[i % this.keySize]) % this.keySize;
      const tmp = sbox[i];
      sbox[i] = sbox[j];
      sbox[j] = tmp;
    }
    return sbox;
  }
  createKeyHash() {
    let hash = 1;
    for (const byte of this.key) {
      if (byte === 0) continue;
      const next = Math.imul(hash, byte) >>> 0;
      if (next === 0 || next <= hash) break;
      hash = next;
    }
    return hash;
  }
  getSegmentKey(segmentIndex, seedByte) {
    const factor = (segmentIndex + 1) * seedByte;
    return factor ? Math.trunc(this.keyHash / factor * 100 | 0) : 0;
  }
  /** keySize ≤ 300：map 模式（平方散列 + 位旋转 XOR） */
  decryptMapMode(buf, offset) {
    for (let i = 0; i < buf.length; i += 1) {
      let pos = offset + i;
      if (pos > 32767) pos %= 32767;
      const idx = Number((BigInt(pos) * BigInt(pos) + 71214n) % BigInt(this.keySize));
      const shift = ((idx & 7) + 4) % 8;
      const keyByte = this.key[idx];
      buf[i] ^= (keyByte << shift | keyByte >>> shift) & 255;
    }
  }
  /** keySize > 300：RC4 模式（头部区 + 分段 RC4） */
  decryptRc4Mode(buf, offset) {
    let pos = offset;
    let out = 0;
    let remaining = buf.length;
    if (pos < RC4_HEAD_SIZE) {
      const headLen = Math.min(remaining, RC4_HEAD_SIZE - pos);
      for (let i = 0; i < headLen; i += 1) {
        const keyByte = this.key[pos % this.keySize];
        buf[out + i] ^= this.key[this.getSegmentKey(pos, keyByte) % this.keySize];
        pos += 1;
      }
      out += headLen;
      remaining -= headLen;
    }
    if (remaining > 0 && pos % RC4_SEGMENT_SIZE !== 0) {
      const len = Math.min(RC4_SEGMENT_SIZE - pos % RC4_SEGMENT_SIZE, remaining);
      this.decryptSegment(pos, buf.subarray(out, out + len));
      out += len;
      remaining -= len;
      pos += len;
    }
    while (remaining > RC4_SEGMENT_SIZE) {
      this.decryptSegment(pos, buf.subarray(out, out + RC4_SEGMENT_SIZE));
      out += RC4_SEGMENT_SIZE;
      remaining -= RC4_SEGMENT_SIZE;
      pos += RC4_SEGMENT_SIZE;
    }
    if (remaining > 0) this.decryptSegment(pos, buf.subarray(out, out + remaining));
  }
  /** 单段 RC4 解密（5120 字节一段，段内共享 S 盒游标） */
  decryptSegment(offset, buf) {
    if (buf.length === 0) return;
    const segmentIdx = Math.floor(offset / RC4_SEGMENT_SIZE) & 511;
    const sbox = Buffer.from(this.initialSbox);
    const skip = (this.getSegmentKey(Math.floor(offset / RC4_SEGMENT_SIZE), this.key[segmentIdx]) & 511) + offset % RC4_SEGMENT_SIZE;
    let i = 0;
    let j = 0;
    for (let n = 0; n < skip; n += 1) {
      i = (i + 1) % this.keySize;
      j = (sbox[i] + j) % this.keySize;
      const tmp = sbox[i];
      sbox[i] = sbox[j];
      sbox[j] = tmp;
    }
    for (let n = 0; n < buf.length; n += 1) {
      i = (i + 1) % this.keySize;
      j = (sbox[i] + j) % this.keySize;
      const tmp = sbox[i];
      sbox[i] = sbox[j];
      sbox[j] = tmp;
      buf[n] ^= sbox[(sbox[i] + sbox[j]) % this.keySize];
    }
  }
}
function createQmcDecoder(encodedEkey) {
  return new QmcStreamDecoder(encodedEkey);
}
const SESSION_TTL_MS = 2 * 60 * 60 * 1e3;
const UPSTREAM_TIMEOUT_MS = 25e3;
const UPSTREAM_MAX_REDIRECTS = 5;
function normalizeExpiry(value) {
  const now = Date.now();
  if (!value || !Number.isFinite(Number(value))) return now + SESSION_TTL_MS;
  const ms = Number(value) < 1e12 ? Number(value) * 1e3 : Number(value);
  return Math.max(now + 6e4, ms);
}
function cleanHeaders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
  return Object.fromEntries(
    Object.entries(value).filter(([k, v]) => k.trim() && v !== void 0).map(([k, v]) => [k.trim(), String(v)])
  );
}
const MIME_BY_FORMAT = {
  flac: "audio/flac",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  wav: "audio/wav"
};
function pickMime(resultFormat, fallback) {
  const format = String(resultFormat || "").toLowerCase().replace(/^\./, "");
  if (MIME_BY_FORMAT[format]) return MIME_BY_FORMAT[format];
  const mime = String(fallback || "").trim();
  return mime && mime !== "application/octet-stream" ? mime : "audio/flac";
}
function firstNumber(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : void 0;
}
function parseContentRange(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(raw || ""));
  if (!m) return void 0;
  const start = Number(m[1]);
  const end = Number(m[2]);
  const total = m[3] === "*" ? void 0 : Number(m[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return void 0;
  if (total !== void 0 && !Number.isSafeInteger(total)) return void 0;
  return { start, end, total };
}
function parseRange(header, total) {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return { start: 0, end: total - 1, partial: false };
  const text = String(raw).trim();
  if (text.includes(",")) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(text);
  if (!m || !m[1] && !m[2]) return null;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, total - suffix), end: total - 1, partial: true };
  }
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : total - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= total || end < start) return null;
  return { start, end: Math.min(end, total - 1), partial: true };
}
async function upstreamRequest(url, method, headers) {
  let target = url;
  for (let hop = 0; hop <= UPSTREAM_MAX_REDIRECTS; hop += 1) {
    const res = await new Promise((resolve, reject) => {
      const mod = target.protocol === "https:" ? https : http;
      const req = mod.request(target, { method, headers }, (r) => resolve(r));
      req.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
        req.destroy(new Error("QMC 上游请求超时"));
      });
      req.on("error", reject);
      req.end();
    });
    const status = res.statusCode || 0;
    if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
      res.resume();
      target = new URL(res.headers.location, target);
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        throw new Error("QMC 上游重定向协议不受支持");
      }
      continue;
    }
    return res;
  }
  throw new Error("QMC 上游重定向次数过多");
}
class QmcProxyServer {
  server = null;
  origin = "";
  startPromise = null;
  cleanupTimer = null;
  sessions = /* @__PURE__ */ new Map();
  async createSession(input) {
    const raw = String(input?.url || "").trim();
    const sourceUrl = new URL(raw);
    if (sourceUrl.protocol !== "http:" && sourceUrl.protocol !== "https:") {
      throw new Error("QMC 播放地址必须使用 HTTP(S)");
    }
    const ekey = String(input?.finalEkey || "").trim();
    if (!ekey) throw new Error("QMC 播放缺少解密密钥");
    await this.ensureStarted();
    const id = randomBytes(24).toString("hex");
    const expiresAt = normalizeExpiry(input.expiresAt);
    this.sessions.set(id, {
      id,
      sourceUrl,
      headers: cleanHeaders(input.headers),
      decoder: createQmcDecoder(ekey),
      mimeType: pickMime(input.resultFormat, input.mimeType),
      expiresAt
    });
    return { url: `${this.origin}/qmc/${id}`, expiresAt };
  }
  dispose() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
    this.server?.close();
    this.server = null;
    this.origin = "";
    this.startPromise = null;
  }
  ensureStarted() {
    if (this.origin) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => this.respondError(res, err));
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          server.close();
          reject(new Error("无法启动 QMC 本地播放服务"));
          return;
        }
        this.server = server;
        this.origin = `http://127.0.0.1:${addr.port}`;
        this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), 6e4);
        this.cleanupTimer.unref();
        resolve();
      });
    }).catch((err) => {
      this.startPromise = null;
      throw err;
    });
    return this.startPromise;
  }
  cleanupExpiredSessions() {
    const now = Date.now();
    for (const [id, session2] of this.sessions) {
      if (session2.expiresAt <= now) this.sessions.delete(id);
    }
  }
  async handleRequest(req, res) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const match = /^\/qmc\/([a-f0-9]{48})$/.exec(url.pathname);
    if (!match) {
      this.respondError(res, new Error("QMC 播放会话不存在"), 404);
      return;
    }
    const session2 = this.sessions.get(match[1]);
    if (!session2 || session2.expiresAt <= Date.now()) {
      this.sessions.delete(match[1]);
      this.respondError(res, new Error("QMC 播放会话已过期"), 410);
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, this.commonHeaders(session2));
      res.end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD, OPTIONS");
      this.respondError(res, new Error("请求方法不受支持"), 405);
      return;
    }
    const total = await this.resolveTotalBytes(session2);
    const range = parseRange(req.headers.range, total);
    if (!range) {
      res.writeHead(416, {
        ...this.commonHeaders(session2),
        "Content-Range": `bytes */${total}`
      });
      res.end();
      return;
    }
    const headers = {
      ...this.commonHeaders(session2),
      "Content-Length": String(range.end - range.start + 1),
      ...range.partial ? { "Content-Range": `bytes ${range.start}-${range.end}/${total}` } : {}
    };
    if (req.method === "HEAD") {
      res.writeHead(range.partial ? 206 : 200, headers);
      res.end();
      return;
    }
    await this.streamDecryptedRange(session2, range, res, headers);
  }
  commonHeaders(session2) {
    return {
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Type": session2.mimeType,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Range",
      "X-Content-Type-Options": "nosniff"
    };
  }
  async resolveTotalBytes(session2) {
    if (session2.totalBytes) return session2.totalBytes;
    const head = await upstreamRequest(session2.sourceUrl, "HEAD", this.upstreamHeaders(session2));
    const contentLength = firstNumber(head.headers["content-length"]);
    head.resume();
    if (contentLength && contentLength > 0) {
      session2.totalBytes = contentLength;
      return contentLength;
    }
    const probe = await upstreamRequest(session2.sourceUrl, "GET", this.upstreamHeaders(session2, "bytes=0-0"));
    const contentRange = parseContentRange(probe.headers["content-range"]);
    const probeLength = firstNumber(probe.headers["content-length"]);
    probe.resume();
    const total = contentRange?.total || probeLength;
    if (!total || total <= 0) throw new Error("无法获取 QMC 加密音频长度");
    session2.totalBytes = total;
    return total;
  }
  upstreamHeaders(session2, range) {
    const excluded = /* @__PURE__ */ new Set(["host", "connection", "content-length", "range", "accept-encoding"]);
    const headers = Object.fromEntries(
      Object.entries(session2.headers || {}).filter(([key]) => !excluded.has(key.toLowerCase()))
    );
    headers["Accept-Encoding"] = "identity";
    if (range) headers.Range = range;
    return headers;
  }
  async streamDecryptedRange(session2, range, res, headers) {
    const upstream = await upstreamRequest(
      session2.sourceUrl,
      "GET",
      this.upstreamHeaders(session2, `bytes=${range.start}-${range.end}`)
    );
    const status = upstream.statusCode || 0;
    if (status !== 200 && status !== 206) {
      upstream.resume();
      throw new Error(`QMC 上游返回异常状态: ${status}`);
    }
    const contentRange = parseContentRange(upstream.headers["content-range"]);
    const upstreamStart = status === 206 ? contentRange?.start ?? range.start : 0;
    if (upstreamStart > range.start) {
      upstream.destroy();
      throw new Error("QMC 上游返回的范围无效");
    }
    let skip = range.start - upstreamStart;
    let position = upstreamStart;
    let remaining = range.end - range.start + 1;
    const wanted = remaining;
    let closed = false;
    res.writeHead(range.partial ? 206 : 200, headers);
    const finish = () => {
      if (closed) return;
      closed = true;
      if (!res.writableEnded) res.end();
    };
    const fail = (err) => {
      if (closed) return;
      closed = true;
      upstream.destroy();
      if (!res.writableEnded) res.destroy(err instanceof Error ? err : new Error(String(err)));
    };
    res.once("close", () => {
      if (!closed) {
        closed = true;
        upstream.destroy();
      }
    });
    upstream.on("data", (chunk) => {
      if (closed || remaining <= 0) return;
      let data = chunk;
      if (skip > 0) {
        const cut = Math.min(skip, data.length);
        data = data.subarray(cut);
        skip -= cut;
        position += cut;
      }
      if (data.length === 0) return;
      const take = Math.min(data.length, remaining);
      let decrypted;
      try {
        decrypted = session2.decoder.decrypt(data.subarray(0, take), position);
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      position += take;
      remaining -= take;
      if (!res.write(decrypted)) {
        upstream.pause();
        res.once("drain", () => upstream.resume());
      }
      if (remaining === 0) {
        upstream.destroy();
        finish();
      }
    });
    upstream.once("end", () => {
      if (remaining === 0) finish();
      else {
        fail(
          new Error(`QMC 上游数据不足: 期望 ${wanted} 字节，缺少 ${remaining} 字节`)
        );
      }
    });
    upstream.once("error", (err) => fail(err));
  }
  respondError(res, err, status = 502) {
    if (res.headersSent) {
      res.destroy(err instanceof Error ? err : void 0);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(JSON.stringify({ error: message }));
  }
}
const qmcProxy = new QmcProxyServer();
class PlaylistLibraryError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "PlaylistLibraryError";
    this.code = code;
  }
}
const isObj$3 = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const clone$4 = (v) => JSON.parse(JSON.stringify(v));
const nowIso = () => (/* @__PURE__ */ new Date()).toISOString();
const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
function newPlaylistId() {
  let ts = Date.now();
  let tsPart = "";
  for (let i = 0; i < 10; i += 1) {
    tsPart = ID_ALPHABET[ts % ID_ALPHABET.length] + tsPart;
    ts = Math.floor(ts / ID_ALPHABET.length);
  }
  let randPart = "";
  for (let i = 0; i < 16; i += 1) {
    randPart += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return `${tsPart}${randPart}`.slice(0, 26);
}
function trackFingerprint(input) {
  return createHash("sha256").update(input).digest("hex").slice(0, 26).toUpperCase();
}
function normalizePlaylistId(value) {
  const raw = String(value ?? "").trim().toUpperCase();
  if (ULID_RE.test(raw)) return raw;
  if (!/^[0-9A-Z]{26}$/.test(raw)) return "";
  const fixed = raw.replace(/[IL]/g, "1").replace(/O/g, "0").replace(/U/g, "V");
  return ULID_RE.test(fixed) ? fixed : "";
}
function normalizeSource(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "qq" || raw === "tx" ? "tx" : raw || "wy";
}
function validatePlaylistName(value) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!name) throw new PlaylistLibraryError("PLAYLIST_NAME_EMPTY", "歌单名称不能为空");
  if (name.length > 60) throw new PlaylistLibraryError("PLAYLIST_NAME_TOO_LONG", "歌单名称不能超过 60 个字符");
  return name;
}
const cloneSafe = (v) => {
  if (isObj$3(v)) {
    try {
      return clone$4(v);
    } catch {
      return void 0;
    }
  }
  return void 0;
};
const strSlice = (v, max) => String(v ?? "").trim().slice(0, max) || void 0;
const sizeOrUndef = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : void 0;
};
function durationToSeconds$2(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const s2 = value > 1e4 ? value / 1e3 : value;
    return s2 > 0 ? Math.floor(s2) : void 0;
  }
  const raw = String(value ?? "").trim();
  if (!raw) return void 0;
  const cn = raw.match(/(\d+)\s*分\s*(\d+)\s*秒/);
  if (cn) {
    const s2 = Number(cn[1]) * 60 + Number(cn[2]);
    return s2 > 0 ? s2 : void 0;
  }
  const hm = raw.match(/^(\d{1,3}):(\d{1,2})$/);
  if (hm) {
    const s2 = Number(hm[1]) * 60 + Number(hm[2]);
    return s2 > 0 ? s2 : void 0;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return void 0;
  const s = n > 1e4 ? n / 1e3 : n;
  return s > 0 ? Math.floor(s) : void 0;
}
const durationOf = (v, fallback) => durationToSeconds$2(v) ?? durationToSeconds$2(fallback?.durationLabel);
function backfillDurations(groups) {
  const known = /* @__PURE__ */ new Map();
  for (const group of groups) {
    for (const playlist of group) {
      for (const track of playlist.tracks) {
        if (!track.duration || track.duration <= 0) continue;
        const key = `${track.source}:${track.trackId}`;
        known.set(key, Math.max(known.get(key) ?? 0, track.duration));
      }
    }
  }
  let changed = false;
  for (const group of groups) {
    for (const playlist of group) {
      for (const track of playlist.tracks) {
        if (track.duration && track.duration > 0) continue;
        const sec = known.get(`${track.source}:${track.trackId}`);
        if (sec) {
          track.duration = sec;
          changed = true;
        }
      }
    }
  }
  return changed;
}
function trackFromInput(input, playlistIdSeed, sortOrder) {
  if (!isObj$3(input)) return null;
  const source = normalizeSource(input.source);
  const trackId = String(input.trackId ?? "").trim();
  const name = String(input.name ?? "").trim();
  if (!trackId || !name) return null;
  const localData = cloneSafe(input.localData);
  return {
    id: normalizePlaylistId(input.id) || trackFingerprint(`track:${playlistIdSeed}:${source}:${trackId}`),
    source,
    trackId,
    name,
    artist: String(input.artist ?? "").trim(),
    album: String(input.album ?? "").trim() || void 0,
    coverUrl: String(input.coverUrl ?? "").trim() || void 0,
    duration: durationOf(input.duration, localData),
    fileSize: sizeOrUndef(input.fileSize),
    fileFingerprint: strSlice(input.fileFingerprint, 64),
    metadataFingerprint: strSlice(input.metadataFingerprint, 64),
    sortOrder,
    localUri: strSlice(input.localUri, 2048),
    localPath: strSlice(input.localPath, 2048),
    localPicture: strSlice(input.localPicture, 2048),
    addedAt: typeof input.addedAt === "string" && input.addedAt ? input.addedAt : void 0,
    localData
  };
}
function playlistFromInput(input) {
  if (!isObj$3(input)) return null;
  const id = normalizePlaylistId(input.id);
  const name = String(input.name ?? "").trim();
  const type = input.type;
  if (!ULID_RE.test(id) || !name || type !== "custom" && type !== "imported") return null;
  const rawTracks = Array.isArray(input.tracks) ? input.tracks : [];
  const seen = /* @__PURE__ */ new Set();
  const tracks = rawTracks.map((t, i) => trackFromInput(t, id, i)).filter((t) => !!t && !seen.has(t.id) && (seen.add(t.id), true)).sort((a, b) => a.sortOrder - b.sortOrder).map((t, i) => ({ ...t, sortOrder: i }));
  const revision = Number(input.revision);
  const sortOrder = Number(input.sortOrder);
  return {
    id,
    name,
    type,
    source: String(input.source ?? "").trim() ? normalizeSource(input.source) : void 0,
    externalId: String(input.externalId ?? "").trim() || void 0,
    coverUrl: String(input.coverUrl ?? "").trim() || void 0,
    sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
    revision: Number.isFinite(revision) && revision >= 0 ? revision : 0,
    tracks,
    deletedAt: typeof input.deletedAt === "string" && input.deletedAt ? input.deletedAt : null,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : void 0,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : void 0
  };
}
function emptyLibrary() {
  return { version: 1, guest: { playlists: [] }, accounts: {} };
}
function metaChanged(a, b) {
  return a.name !== b.name || a.type !== b.type || a.source !== b.source || a.externalId !== b.externalId || a.coverUrl !== b.coverUrl || a.sortOrder !== b.sortOrder;
}
function playlistSnapshot(playlist) {
  return {
    id: playlist.id,
    name: playlist.name,
    type: playlist.type,
    source: playlist.source ?? null,
    externalId: playlist.externalId ?? null,
    coverUrl: playlist.coverUrl ?? null,
    sortOrder: playlist.sortOrder,
    deletedAt: playlist.deletedAt ?? null,
    tracks: playlist.tracks.map((t) => ({ ...trackSnapshot(t), sortOrder: t.sortOrder }))
  };
}
function trackSnapshot(t) {
  return {
    id: t.id,
    source: t.source,
    trackId: t.trackId,
    name: t.name,
    artist: t.artist,
    album: t.album ?? null,
    coverUrl: t.coverUrl ?? null,
    duration: t.duration ?? null,
    fileSize: t.fileSize ?? null,
    fileFingerprint: t.fileFingerprint ?? null,
    metadataFingerprint: t.metadataFingerprint ?? null,
    localUri: t.localUri ?? null,
    localPath: t.localPath ?? null,
    localPicture: t.localPicture ?? null,
    addedAt: t.addedAt ?? null,
    localData: t.localData ?? null
  };
}
const LIB_VERSION = 1;
const TRACK_BATCH_MAX = 2e3;
const TRACK_TOTAL_MAX = 2e4;
const EXTERNAL_ID_MAX = 512;
class PlaylistLibrary {
  library = null;
  activeUserId = null;
  recoveryWarning = "";
  localChangeListener = null;
  userDataPath = "";
  bindUserData(userDataPath) {
    this.userDataPath = userDataPath;
  }
  get filePath() {
    const base = this.userDataPath || app.getPath("userData");
    const dir = path.join(base, "data");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, "playlist-library-v1.json");
  }
  ensureLoaded() {
    if (this.library) return this.library;
    const file = this.filePath;
    if (!fs.existsSync(file)) {
      this.library = emptyLibrary();
      return this.library;
    }
    try {
      const json = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (!isObj$3(json)) throw new Error("歌单库根节点格式错误");
      const guest = (isObj$3(json.guest) && Array.isArray(json.guest.playlists) ? json.guest.playlists : []).map((p) => playlistFromInput(p)).filter((p) => !!p);
      const accounts = {};
      if (isObj$3(json.accounts)) {
        for (const [userId, store] of Object.entries(json.accounts)) {
          if (!userId || !isObj$3(store)) continue;
          const playlists = Array.isArray(store.playlists) ? store.playlists.map((p) => playlistFromInput(p)).filter((p) => !!p) : [];
          accounts[userId] = {
            hasSnapshot: store.hasSnapshot === true,
            playlists,
            queue: Array.isArray(store.queue) ? store.queue : [],
            cursor: Number.isFinite(Number(store.cursor)) && Number(store.cursor) >= 0 ? Math.floor(Number(store.cursor)) : 0,
            lastSuccessfulAt: typeof store.lastSuccessfulAt === "string" ? store.lastSuccessfulAt : null
          };
        }
      }
      const library = {
        version: LIB_VERSION,
        activeUserId: typeof json.activeUserId === "string" && json.activeUserId ? json.activeUserId : void 0,
        guest: { playlists: guest },
        accounts
      };
      const backfilled = backfillDurations([
        library.guest.playlists,
        ...Object.values(library.accounts).map((a) => a.playlists)
      ]);
      this.library = library;
      this.activeUserId = library.activeUserId ?? null;
      if (backfilled) {
        try {
          this.writeLibrary();
        } catch (err) {
          console.warn("[playlist-library] 回填歌曲时长保存失败", err);
        }
      }
      return library;
    } catch (err) {
      this.backupCorruptedFile(file);
      this.library = emptyLibrary();
      this.activeUserId = null;
      this.recoveryWarning = "歌单库文件损坏，已保留损坏副本并创建新的空歌单库";
      console.error("[playlist-library] 歌单库恢复失败", err);
      try {
        this.writeLibrary();
      } catch (err2) {
        console.error("[playlist-library] 写入恢复后的空歌单库失败", err2);
      }
      return this.library;
    }
  }
  backupCorruptedFile(file) {
    try {
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
    } catch (err) {
      console.error("[playlist-library] 备份损坏文件失败", err);
    }
  }
  writeLibrary() {
    const file = this.filePath;
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const json = JSON.stringify(this.ensureLoaded(), null, 2);
    try {
      fs.writeFileSync(tmp, json, "utf-8");
      try {
        fs.renameSync(tmp, file);
      } catch {
        fs.copyFileSync(tmp, file);
        fs.rmSync(tmp, { force: true });
      }
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
      }
      throw new PlaylistLibraryError(
        "PLAYLIST_STORAGE_WRITE_FAILED",
        `保存歌单失败：${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  setActiveUser(userId) {
    const library = this.ensureLoaded();
    const id = userId?.trim() || null;
    if (id && !library.accounts[id]) {
      library.accounts[id] = { hasSnapshot: false, playlists: [], queue: [], cursor: 0, lastSuccessfulAt: null };
    }
    if (this.activeUserId === id) return false;
    this.activeUserId = id;
    if (id) library.activeUserId = id;
    else delete library.activeUserId;
    this.writeLibrary();
    return true;
  }
  setLocalChangeListener(listener) {
    this.localChangeListener = listener;
  }
  getActiveUserId() {
    this.ensureLoaded();
    return this.activeUserId;
  }
  getGuestPlaylists() {
    return clone$4(this.ensureLoaded().guest.playlists);
  }
  getAccountSyncData(userId) {
    const account = this.getOrCreateAccount(userId);
    return {
      hasSnapshot: account.hasSnapshot,
      playlists: clone$4(account.playlists),
      queue: clone$4(account.queue),
      cursor: account.cursor,
      lastSuccessfulAt: account.lastSuccessfulAt ?? null
    };
  }
  updateAccountSyncState(userId, patch) {
    const account = this.getOrCreateAccount(userId);
    const library = this.ensureLoaded();
    if (patch.hasSnapshot !== void 0) account.hasSnapshot = patch.hasSnapshot;
    if (patch.playlists) {
      account.playlists = patch.playlists.map((p) => playlistFromInput(p)).filter((p) => !!p).sort((a, b) => a.sortOrder - b.sortOrder);
      const others = Object.entries(library.accounts).filter(([id]) => id !== userId).map(([, store]) => store.playlists);
      backfillDurations([account.playlists, library.guest.playlists, ...others]);
      account.hasSnapshot = true;
    }
    if (patch.queue) account.queue = clone$4(patch.queue);
    if (patch.cursor !== void 0) {
      account.cursor = Number.isFinite(patch.cursor) && patch.cursor >= 0 ? Math.floor(patch.cursor) : 0;
    }
    if (patch.lastSuccessfulAt !== void 0) account.lastSuccessfulAt = patch.lastSuccessfulAt;
    this.writeLibrary();
  }
  enqueueGuestPlaylistImport(userId, playlists) {
    const account = this.getOrCreateAccount(userId);
    let queue = clone$4(account.queue);
    const prepared = playlists.map((p) => ({ ...clone$4(p), revision: 0, deletedAt: null }));
    prepared.forEach((playlist) => {
      queue = this.replacePlaylistMutation(queue, {
        queueVersion: 2,
        origin: "guest-import",
        clientMutationId: newPlaylistId(),
        operation: "UPSERT_PLAYLIST",
        playlistId: playlist.id,
        playlist,
        createdAt: Date.now()
      });
    });
    account.queue = queue;
    if (account.playlists.length === 0 && prepared.length > 0) {
      account.playlists = clone$4(prepared);
      account.hasSnapshot = true;
    }
    this.writeLibrary();
  }
  captureRestoreState() {
    const library = this.ensureLoaded();
    const userId = this.activeUserId;
    if (!userId) {
      return { activeUserId: null, guestPlaylists: clone$4(library.guest.playlists) };
    }
    const account = this.getOrCreateAccount(userId);
    return {
      activeUserId: userId,
      account: clone$4({
        hasSnapshot: account.hasSnapshot,
        playlists: account.playlists,
        queue: account.queue,
        cursor: account.cursor,
        lastSuccessfulAt: account.lastSuccessfulAt ?? null
      })
    };
  }
  restoreState(state) {
    const library = this.ensureLoaded();
    if (!state.activeUserId) {
      library.guest.playlists = clone$4(state.guestPlaylists ?? []);
      this.activeUserId = null;
      delete library.activeUserId;
      this.writeLibrary();
      return;
    }
    const account = this.getOrCreateAccount(state.activeUserId);
    account.hasSnapshot = state.account?.hasSnapshot ?? false;
    account.playlists = clone$4(state.account?.playlists ?? []);
    account.queue = clone$4(state.account?.queue ?? []);
    account.cursor = state.account?.cursor ?? 0;
    account.lastSuccessfulAt = state.account?.lastSuccessfulAt ?? null;
    this.activeUserId = state.activeUserId;
    library.activeUserId = state.activeUserId;
    this.writeLibrary();
  }
  getSnapshot() {
    const library = this.ensureLoaded();
    const userId = this.activeUserId;
    const playlists = this.getActivePlaylists().filter((p) => !p.deletedAt).sort(
      (a, b) => a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
    );
    return {
      identity: {
        kind: userId && library.accounts[userId] ? "account" : "guest",
        userId
      },
      playlists: clone$4(playlists),
      recoveryWarning: this.recoveryWarning || void 0
    };
  }
  createPlaylist(nameInput) {
    const name = validatePlaylistName(nameInput);
    const playlists = this.getActivePlaylists();
    const before = clone$4(playlists);
    const id = this.createUniquePlaylistId(playlists);
    const now = nowIso();
    const playlist = {
      id,
      name,
      type: "custom",
      sortOrder: this.nextPlaylistSortOrder(playlists),
      revision: 0,
      tracks: [],
      deletedAt: null,
      createdAt: now,
      updatedAt: now
    };
    playlists.push(playlist);
    this.commitLocalPlaylistChanges(before, playlists);
    this.writeActiveLibrary();
    return clone$4(playlist);
  }
  renamePlaylist(playlistId, nameInput) {
    const playlist = this.getEditableCustomPlaylist(playlistId);
    const before = clone$4(playlist);
    playlist.name = validatePlaylistName(nameInput);
    this.touchPlaylist(playlist);
    this.commitLocalPlaylistChanges([before], [playlist]);
    this.writeActiveLibrary();
    return clone$4(playlist);
  }
  deletePlaylist(playlistId) {
    const playlist = this.getActivePlaylist(playlistId);
    const before = clone$4(playlist);
    playlist.deletedAt = nowIso();
    this.touchPlaylist(playlist);
    this.commitExplicitDeletion(before);
    this.writeActiveLibrary();
    return this.getSnapshot();
  }
  upsertImportedPlaylist(input) {
    const source = normalizeSource(input.source);
    const externalId = String(input.externalId ?? "").trim();
    if (!externalId || externalId.length > EXTERNAL_ID_MAX) {
      throw new PlaylistLibraryError("PLAYLIST_EXTERNAL_ID_INVALID", "歌单外部 ID 无效");
    }
    const name = validatePlaylistName(input.name);
    if (!Array.isArray(input.tracks)) {
      throw new PlaylistLibraryError("PLAYLIST_TRACKS_INVALID", "导入歌单的歌曲数据格式错误");
    }
    if (input.tracks.length > TRACK_TOTAL_MAX) {
      throw new PlaylistLibraryError("PLAYLIST_TRACKS_TOO_MANY", `单个歌单最多支持 ${TRACK_TOTAL_MAX} 首歌曲`);
    }
    const playlists = this.getActivePlaylists();
    const id = trackFingerprint(`imported:${source}:${externalId}`);
    const existing = playlists.find((p) => p.id === id);
    if (existing && existing.type !== "imported") {
      throw new PlaylistLibraryError("PLAYLIST_ID_CONFLICT", "歌单 ID 冲突，请稍后重试");
    }
    const now = nowIso();
    const before = existing ? clone$4(existing) : void 0;
    const known = new Map(
      (existing?.tracks ?? []).map((t) => [`${t.source}:${t.trackId}`, t])
    );
    const seen = /* @__PURE__ */ new Set();
    const tracks = [];
    for (const item of input.tracks) {
      if (!isObj$3(item)) continue;
      const trackId = String(item.trackId ?? "").trim();
      const trackName = String(item.name ?? "").trim();
      const key = `${source}:${trackId}`;
      if (!trackId || !trackName || seen.has(key)) continue;
      const localData = cloneSafe(item.localData);
      const prev = known.get(key);
      tracks.push({
        id: trackFingerprint(`track:${id}:${source}:${trackId}`),
        source,
        trackId,
        name: trackName,
        artist: String(item.artist ?? "").trim(),
        album: String(item.album ?? "").trim() || void 0,
        coverUrl: String(item.coverUrl ?? "").trim() || void 0,
        duration: durationOf(item.duration, localData) ?? prev?.duration,
        sortOrder: tracks.length,
        addedAt: prev?.addedAt ?? now,
        localData
      });
      seen.add(key);
    }
    if (!tracks.length) {
      throw new PlaylistLibraryError("PLAYLIST_TRACKS_EMPTY", "未获取到歌单歌曲，请检查链接或歌单是否为空");
    }
    const playlist = existing ?? {
      id,
      name,
      type: "imported",
      source,
      externalId,
      coverUrl: String(input.coverUrl ?? "").trim() || void 0,
      sortOrder: this.nextPlaylistSortOrder(playlists),
      revision: 0,
      tracks: [],
      deletedAt: null,
      createdAt: now,
      updatedAt: now
    };
    playlist.name = name;
    playlist.source = source;
    playlist.externalId = externalId;
    playlist.coverUrl = String(input.coverUrl ?? "").trim() || void 0;
    playlist.tracks = tracks;
    playlist.deletedAt = null;
    playlist.revision += 1;
    playlist.updatedAt = now;
    if (!existing) playlists.push(playlist);
    this.commitLocalPlaylistChanges(before ? [before] : [], [playlist]);
    this.writeActiveLibrary();
    return { playlist: clone$4(playlist), updated: !!existing };
  }
  getImportedPlaylist(playlistId) {
    const playlist = this.getActivePlaylist(playlistId);
    if (playlist.type !== "imported") {
      throw new PlaylistLibraryError("PLAYLIST_NOT_IMPORTED", "当前歌单不是导入歌单");
    }
    return clone$4(playlist);
  }
  addTracks(playlistId, tracks) {
    const playlist = this.getEditableCustomPlaylist(playlistId);
    const before = clone$4(playlist);
    if (!Array.isArray(tracks)) throw new PlaylistLibraryError("PLAYLIST_TRACKS_INVALID", "歌曲数据格式错误");
    if (tracks.length > TRACK_BATCH_MAX) {
      throw new PlaylistLibraryError("PLAYLIST_TRACKS_TOO_MANY", `单次最多添加 ${TRACK_BATCH_MAX} 首歌曲`);
    }
    const existingKeys = new Set(playlist.tracks.map((t) => `${t.source}:${t.trackId}`));
    let added = 0;
    let skipped = 0;
    let durationFixed = false;
    for (const item of tracks) {
      if (!isObj$3(item)) {
        skipped += 1;
        continue;
      }
      const source = normalizeSource(item.source);
      const trackId = String(item.trackId ?? "").trim();
      const name = String(item.name ?? "").trim();
      const key = `${source}:${trackId}`;
      if (!trackId || !name) {
        skipped += 1;
        continue;
      }
      const localData = cloneSafe(item.localData);
      const duration = durationOf(item.duration, localData);
      if (existingKeys.has(key)) {
        const prev = playlist.tracks.find((t) => `${t.source}:${t.trackId}` === key);
        if (prev && (!prev.duration || prev.duration <= 0) && duration) {
          prev.duration = duration;
          durationFixed = true;
        }
        skipped += 1;
        continue;
      }
      playlist.tracks.push({
        id: trackFingerprint(`track:${playlist.id}:${source}:${trackId}`),
        source,
        trackId,
        name,
        artist: String(item.artist ?? "").trim(),
        album: String(item.album ?? "").trim() || void 0,
        coverUrl: String(item.coverUrl ?? "").trim() || void 0,
        duration,
        sortOrder: playlist.tracks.length,
        addedAt: nowIso(),
        localData
      });
      existingKeys.add(key);
      added += 1;
    }
    if (added > 0 || durationFixed) {
      this.reindexTracks(playlist);
      this.touchPlaylist(playlist);
      this.commitLocalPlaylistChanges([before], [playlist]);
      this.writeActiveLibrary();
    }
    return { playlist: clone$4(playlist), addedCount: added, skippedCount: skipped };
  }
  removeTracks(playlistId, trackIds) {
    const playlist = this.getEditableCustomPlaylist(playlistId);
    const before = clone$4(playlist);
    if (!Array.isArray(trackIds)) {
      throw new PlaylistLibraryError("PLAYLIST_TRACK_IDS_INVALID", "待移除歌曲数据格式错误");
    }
    const removeSet = new Set(trackIds.map((id) => String(id ?? "").trim()).filter(Boolean));
    if (!removeSet.size) return clone$4(playlist);
    const kept = playlist.tracks.filter((t) => !removeSet.has(t.id));
    if (kept.length === playlist.tracks.length) return clone$4(playlist);
    playlist.tracks = kept;
    this.reindexTracks(playlist);
    this.touchPlaylist(playlist);
    this.commitLocalPlaylistChanges([before], [playlist]);
    this.writeActiveLibrary();
    return clone$4(playlist);
  }
  reorderTracks(playlistId, orderedIds) {
    const playlist = this.getEditableCustomPlaylist(playlistId);
    const before = clone$4(playlist);
    if (!Array.isArray(orderedIds)) {
      throw new PlaylistLibraryError("PLAYLIST_TRACK_ORDER_INVALID", "歌曲顺序数据格式错误");
    }
    const ids = orderedIds.map((id) => String(id ?? "").trim());
    const currentIds = new Set(playlist.tracks.map((t) => t.id));
    const unique = new Set(ids);
    if (ids.length !== playlist.tracks.length || unique.size !== ids.length || ids.some((id) => !currentIds.has(id))) {
      throw new PlaylistLibraryError("PLAYLIST_TRACK_ORDER_INVALID", "歌曲顺序与当前歌单不一致，请刷新后重试");
    }
    const byId = new Map(playlist.tracks.map((t) => [t.id, t]));
    playlist.tracks = ids.map((id) => byId.get(id));
    this.reindexTracks(playlist);
    this.touchPlaylist(playlist);
    this.commitLocalPlaylistChanges([before], [playlist]);
    this.writeActiveLibrary();
    return clone$4(playlist);
  }
  /** 备份整库恢复：按类型分组替换活动歌单（保留既有 ID/revision） */
  replaceActiveFromBackup(incoming, types = ["custom", "imported"]) {
    const library = this.ensureLoaded();
    const existingAll = clone$4(this.getActivePlaylists());
    const typeSet = new Set(types);
    const prepared = incoming.map((p) => playlistFromInput(p)).filter((p) => !!p).filter((p) => typeSet.has(p.type)).sort((a, b) => a.sortOrder - b.sortOrder);
    const reusedIds = /* @__PURE__ */ new Set();
    const idMap = /* @__PURE__ */ new Map();
    const mapped = prepared.map((playlist) => {
      const prev = existingAll.find((p) => p.id === playlist.id && !reusedIds.has(p.id)) ?? (playlist.type === "custom" ? existingAll.find((p) => p.type === "custom" && p.name === playlist.name && !reusedIds.has(p.id)) : existingAll.find(
        (p) => p.type === "imported" && p.source === playlist.source && p.externalId === playlist.externalId && !reusedIds.has(p.id)
      ));
      if (!prev) return { ...playlist, revision: 0, deletedAt: null };
      reusedIds.add(prev.id);
      const merged2 = {
        ...playlist,
        id: prev.id,
        revision: prev.revision,
        createdAt: playlist.createdAt ?? prev.createdAt,
        updatedAt: playlist.updatedAt ?? prev.updatedAt,
        deletedAt: null
      };
      idMap.set(merged2.id, prev);
      return merged2;
    });
    const byType = {
      custom: mapped.filter((p) => p.type === "custom"),
      imported: mapped.filter((p) => p.type === "imported")
    };
    const emittedTypes = /* @__PURE__ */ new Set();
    const orderedExisting = [...existingAll].sort(
      (a, b) => a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
    );
    const merged = [];
    orderedExisting.forEach((p) => {
      if (!typeSet.has(p.type)) {
        merged.push(p);
        return;
      }
      if (!emittedTypes.has(p.type)) {
        emittedTypes.add(p.type);
        merged.push(...byType[p.type]);
      }
    });
    types.forEach((type) => {
      if (!emittedTypes.has(type) && byType[type].length) merged.push(...byType[type]);
    });
    for (let i = 0; i < merged.length; ) {
      if (!typeSet.has(merged[i].type)) {
        i += 1;
        continue;
      }
      const start = i;
      while (i < merged.length && typeSet.has(merged[i].type)) i += 1;
      const prevOrder = start > 0 ? merged[start - 1].sortOrder : void 0;
      const nextOrder = i < merged.length ? merged[i].sortOrder : void 0;
      const count = i - start;
      for (let k = 0; k < count; k += 1) {
        const order = prevOrder !== void 0 && nextOrder !== void 0 ? prevOrder + (nextOrder - prevOrder) * (k + 1) / (count + 1) : prevOrder !== void 0 ? prevOrder + k + 1 : nextOrder !== void 0 ? nextOrder - count + k : k;
        merged[start + k] = { ...merged[start + k], sortOrder: order };
      }
    }
    const mappedIds = new Set(mapped.map((p) => p.id));
    if (this.activeUserId) {
      const account = this.getOrCreateAccount(this.activeUserId);
      let queue = clone$4(account.queue);
      existingAll.forEach((prev) => {
        if (prev.deletedAt || !typeSet.has(prev.type) || mappedIds.has(prev.id)) return;
        queue = this.replacePlaylistMutation(queue, {
          queueVersion: 2,
          origin: "account-operation",
          clientMutationId: newPlaylistId(),
          operation: "DELETE_PLAYLIST",
          playlistId: prev.id,
          expectedRevision: this.expectedRevision(queue, prev.id, prev),
          createdAt: Date.now()
        });
      });
      mapped.forEach((playlist) => {
        const prev = idMap.get(playlist.id);
        const unchanged = prev && JSON.stringify(playlistSnapshot(prev)) === JSON.stringify(playlistSnapshot(playlist));
        if (unchanged) return;
        queue = this.replacePlaylistMutation(queue, {
          queueVersion: 2,
          origin: "guest-import",
          clientMutationId: newPlaylistId(),
          operation: "UPSERT_PLAYLIST",
          playlistId: playlist.id,
          expectedRevision: this.expectedRevision(queue, playlist.id, prev),
          playlist: clone$4(playlist),
          createdAt: Date.now()
        });
      });
      account.playlists = clone$4(merged);
      account.queue = queue;
      account.hasSnapshot = true;
    } else {
      library.guest.playlists = clone$4(merged);
    }
    this.writeLibrary();
    const playlists = merged.filter((p) => !p.deletedAt).sort(
      (a, b) => a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
    );
    return {
      identity: {
        kind: this.activeUserId ? "account" : "guest",
        userId: this.activeUserId
      },
      playlists: clone$4(playlists),
      recoveryWarning: this.recoveryWarning || void 0
    };
  }
  getActivePlaylists() {
    const library = this.ensureLoaded();
    return this.activeUserId ? this.getOrCreateAccount(this.activeUserId).playlists : library.guest.playlists;
  }
  writeActiveLibrary() {
    const library = this.ensureLoaded();
    if (this.activeUserId) {
      const account = library.accounts[this.activeUserId];
      if (account) account.hasSnapshot = true;
    }
    this.writeLibrary();
  }
  getEditableCustomPlaylist(playlistId) {
    const playlist = this.getActivePlaylist(playlistId);
    if (playlist.type !== "custom") {
      throw new PlaylistLibraryError("PLAYLIST_NOT_EDITABLE", "当前阶段只支持编辑自建歌单");
    }
    return playlist;
  }
  getActivePlaylist(playlistId) {
    const id = String(playlistId ?? "").trim();
    const playlist = this.getActivePlaylists().find((p) => p.id === id && !p.deletedAt);
    if (!playlist) throw new PlaylistLibraryError("PLAYLIST_NOT_FOUND", "歌单不存在或已被删除");
    return playlist;
  }
  createUniquePlaylistId(playlists) {
    const used = new Set(playlists.map((p) => p.id));
    for (let i = 0; i < 32; i += 1) {
      const id = newPlaylistId();
      if (!used.has(id)) return id;
    }
    throw new PlaylistLibraryError("PLAYLIST_ID_EXHAUSTED", "生成歌单 ID 失败");
  }
  nextPlaylistSortOrder(playlists) {
    return playlists.reduce((max, p) => Math.max(max, p.sortOrder), -1) + 1;
  }
  reindexTracks(playlist) {
    playlist.tracks.forEach((t, i) => {
      t.sortOrder = i;
    });
  }
  touchPlaylist(playlist) {
    playlist.revision += 1;
    playlist.updatedAt = nowIso();
  }
  getOrCreateAccount(userId) {
    const library = this.ensureLoaded();
    if (!library.accounts[userId]) {
      library.accounts[userId] = { hasSnapshot: false, playlists: [], queue: [], cursor: 0, lastSuccessfulAt: null };
    }
    return library.accounts[userId];
  }
  commitLocalPlaylistChanges(beforeList, afterList) {
    const userId = this.activeUserId;
    if (!userId) return;
    const account = this.getOrCreateAccount(userId);
    const beforeById = new Map(beforeList.map((p) => [p.id, p]));
    let queue = clone$4(account.queue);
    afterList.forEach((playlist) => {
      if (playlist.deletedAt) return;
      const before = beforeById.get(playlist.id);
      if (before && JSON.stringify(playlistSnapshot(before)) === JSON.stringify(playlistSnapshot(playlist))) return;
      const mutation = this.createPlaylistMutation(before, playlist);
      if (mutation) queue = this.mergePlaylistMutation(queue, mutation, playlist);
    });
    account.queue = queue;
    this.localChangeListener?.();
  }
  commitExplicitDeletion(before) {
    const userId = this.activeUserId;
    if (!userId) return;
    const account = this.getOrCreateAccount(userId);
    const queue = clone$4(account.queue);
    account.queue = this.replacePlaylistMutation(queue, {
      queueVersion: 2,
      origin: "account-operation",
      clientMutationId: newPlaylistId(),
      operation: "DELETE_PLAYLIST",
      playlistId: before.id,
      expectedRevision: this.expectedRevision(queue, before.id, before),
      createdAt: Date.now()
    });
    this.localChangeListener?.();
  }
  /** 前后差异 → 最小同步操作（UPSERT/ADD/REMOVE/REPLACE/REORDER/DELETE） */
  createPlaylistMutation(before, after) {
    const base = {
      queueVersion: 2,
      origin: "account-operation",
      clientMutationId: newPlaylistId(),
      playlistId: after.id,
      createdAt: Date.now()
    };
    if (after.deletedAt) {
      return {
        ...base,
        operation: "DELETE_PLAYLIST",
        expectedRevision: before && before.revision > 0 ? before.revision : void 0
      };
    }
    if (!before || metaChanged(before, after)) {
      return {
        ...base,
        operation: "UPSERT_PLAYLIST",
        expectedRevision: before && before.revision > 0 ? before.revision : void 0,
        playlist: clone$4(after)
      };
    }
    const beforeTracks = new Map(before.tracks.map((t) => [t.id, t]));
    const afterTracks = new Map(after.tracks.map((t) => [t.id, t]));
    const added = after.tracks.filter((t) => !beforeTracks.has(t.id));
    const removed = before.tracks.filter((t) => !afterTracks.has(t.id));
    const modified = after.tracks.some((t) => {
      const prev = beforeTracks.get(t.id);
      return prev && JSON.stringify(trackSnapshot(prev)) !== JSON.stringify(trackSnapshot(t));
    });
    const beforeOrder = before.tracks.map((t) => t.id).join("|");
    const afterOrder = after.tracks.map((t) => t.id).join("|");
    const playlistMeta = { ...clone$4(after), tracks: [] };
    const expectedRevision = before.revision > 0 ? before.revision : void 0;
    if (modified || added.length > 0 && removed.length > 0) {
      return { ...base, operation: "REPLACE_TRACKS", expectedRevision, playlist: playlistMeta, tracks: clone$4(after.tracks) };
    }
    if (added.length > 0) {
      return { ...base, operation: "ADD_TRACKS", expectedRevision, playlist: playlistMeta, tracks: clone$4(added) };
    }
    if (removed.length > 0) {
      return {
        ...base,
        operation: "REMOVE_TRACKS",
        expectedRevision,
        playlist: playlistMeta,
        trackIds: removed.map((t) => t.id),
        orderedTrackIds: after.tracks.map((t) => t.id)
      };
    }
    if (beforeOrder !== afterOrder) {
      return { ...base, operation: "REORDER_TRACKS", expectedRevision, playlist: playlistMeta, orderedTrackIds: after.tracks.map((t) => t.id) };
    }
    return null;
  }
  mergePlaylistMutation(queue, mutation, playlist) {
    const existing = queue.find((m) => m.playlistId === mutation.playlistId);
    if (!existing) return this.replacePlaylistMutation(queue, mutation);
    if (mutation.operation === "DELETE_PLAYLIST") {
      return this.replacePlaylistMutation(queue, {
        ...mutation,
        expectedRevision: existing.expectedRevision ?? mutation.expectedRevision
      });
    }
    if (existing.operation === "UPSERT_PLAYLIST" || mutation.operation === "UPSERT_PLAYLIST") {
      return this.replacePlaylistMutation(queue, {
        ...mutation,
        origin: existing.origin,
        clientMutationId: newPlaylistId(),
        operation: "UPSERT_PLAYLIST",
        expectedRevision: existing.expectedRevision,
        playlist: clone$4(playlist),
        createdAt: Date.now()
      });
    }
    if (existing.operation === "ADD_TRACKS" && mutation.operation === "ADD_TRACKS") {
      const tracks = new Map(
        [...existing.tracks ?? [], ...mutation.tracks ?? []].map(
          (t) => [t.id, t]
        )
      );
      return this.replacePlaylistMutation(queue, {
        ...mutation,
        expectedRevision: existing.expectedRevision,
        tracks: [...tracks.values()]
      });
    }
    if (existing.operation === "REMOVE_TRACKS" && mutation.operation === "REMOVE_TRACKS") {
      return this.replacePlaylistMutation(queue, {
        ...mutation,
        expectedRevision: existing.expectedRevision,
        trackIds: [.../* @__PURE__ */ new Set([...existing.trackIds ?? [], ...mutation.trackIds ?? []])]
      });
    }
    if (existing.operation === "REORDER_TRACKS" && mutation.operation === "REORDER_TRACKS") {
      return this.replacePlaylistMutation(queue, {
        ...mutation,
        expectedRevision: existing.expectedRevision
      });
    }
    return this.replacePlaylistMutation(queue, {
      queueVersion: 2,
      origin: existing.origin,
      clientMutationId: newPlaylistId(),
      operation: "REPLACE_TRACKS",
      playlistId: playlist.id,
      expectedRevision: existing.expectedRevision,
      playlist: { ...clone$4(playlist), tracks: [] },
      tracks: clone$4(playlist.tracks),
      createdAt: Date.now()
    });
  }
  expectedRevision(queue, playlistId, playlist) {
    const pending = queue.find((m) => m.playlistId === playlistId);
    return pending?.expectedRevision ?? (playlist && playlist.revision > 0 ? playlist.revision : void 0);
  }
  replacePlaylistMutation(queue, mutation) {
    return [...queue.filter((m) => m.playlistId !== mutation.playlistId), mutation];
  }
}
const playlistLibrary = new PlaylistLibrary();
function playlistErrorInfo(err) {
  return err instanceof PlaylistLibraryError ? { code: err.code, message: err.message } : err && typeof err === "object" && typeof err.code === "string" ? { code: err.code, message: err instanceof Error ? err.message : "歌单操作失败，请稍后重试" } : { code: "PLAYLIST_OPERATION_FAILED", message: err instanceof Error ? err.message : "歌单操作失败，请稍后重试" };
}
function normalizeDuration(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const s2 = value > 1e4 ? value / 1e3 : value;
    return s2 > 0 ? Math.floor(s2) : 0;
  }
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const cn = raw.match(/(\d+)\s*分\s*(\d+)\s*秒/);
  if (cn) return Number(cn[1]) * 60 + Number(cn[2]);
  const hm = raw.match(/^(\d{1,3}):(\d{1,2})$/);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const s = n > 1e4 ? n / 1e3 : n;
  return Math.floor(s);
}
function secondsLabel(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}分${s}秒`;
}
const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36";
function httpGetText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        headers: { "User-Agent": DEFAULT_UA, ...headers }
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => body += chunk);
        res.on("end", () => resolve(body));
      }
    );
    req.on("error", reject);
    req.end();
  });
}
function httpPostText(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "User-Agent": DEFAULT_UA,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          ...headers
        }
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
const md5Hex = (input) => createHash("md5").update(input).digest("hex");
function appendQuery(url, params) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    search.append(k, String(v));
  });
  return url + (url.includes("?") ? "&" : "?") + search.toString();
}
function kgSignature(params, body = null, saltAlt = false) {
  const salt = saltAlt ? "LnT6xpN3khm36zse0QzvmgTZ3waWdRSA" : "OIlwieks28dk2k092lksi2UIkp";
  const sorted = Object.keys(params).sort().map((key) => {
    const value = params[key];
    return key + "=" + (Array.isArray(value) ? JSON.stringify(value) : String(value));
  }).join("");
  return md5Hex(salt + sorted + (body !== null ? body : "") + salt);
}
const WY_COOKIE = "EVNSM=1.0.0; osver=14; MUSIC_U=; NMCID=oyapoh.1707738771510.01.4; versioncode=1000022; URS_APPID=E26D3B65474AEE2FC2586DCAE42BCF0CBEA421D4CB53C42A74EBEF035ACE98E0B6F0E44087D61EFC06BE92279CD6EEC6; buildver=231106171719; resolution=3040x1440; sDeviceId=bnVsbAljNjowOTpiMzphYzo4NDowNgk4NzNjZWYxNGQxYjY4MWI5CWY1ZjVhNTIxOGFjNDA3ZmY%3D; os=magicos; channel=netease; screenType=other; deviceId=bnVsbAljNjowOTpiMzphYzo4NDowNgk4NzNjZWYxNGQxYjY4MWI5CWY1ZjVhNTIxOGFjNDA3ZmY%3D; appver=1.0.22; NMDI=Q1NKTQkBDACdyBclTqtsEuV2ecI7AAAAKyV%2B9xWzSJenvmG2RFU9D82gQoo96WkqNFpO59px3PrvpN5DF0cFPRJ3BXMIBMdBOcxhjUoyxI898tU%3D; ntes_kaola_ad=1; language=zh-CN; mobilename=22041211AC; __csrf=b383e0976daab42a166a9544f90a1dc3; NMTID=00O3nhQ8Br3egFvnEAIjk_hf0yT9jsAAAGNnSmw4w; packageType=release";
const WY_UA = "NeteaseMusic/1.0.22.231106171719(1000022);Dalvik/2.1.0 (Linux; U; Android 14; 22041211AC Build/UP1A.231005.007)";
const WY_LEVELS = [
  ["standard", [0, 128e3]],
  ["exhigh", [1, 32e4]],
  ["lossless", [2, 999e3]],
  ["hires", [3, 4096]],
  ["sky", [4, 262144]],
  ["jyeffect", [5, 131072]],
  ["jymaster", [6, 65536]]
];
async function wySongDetail(id, level = "standard") {
  try {
    const c = JSON.stringify([{ id: parseInt(String(id)) }]);
    const url = `http://interface3.music.163.com/api/v3/song/detail?c=${encodeURIComponent(c)}`;
    const text = await httpGetText(url, { Cookie: WY_COOKIE, "User-Agent": WY_UA });
    const json = JSON.parse(text);
    if (!json.songs || json.songs.length === 0) return null;
    const song = json.songs[0];
    const artists = song.ar || [];
    const artist = artists.map((a) => a.name).filter(Boolean).join(" & ");
    const albumName = song.al ? song.al.name : "";
    const pic = song.al ? song.al.picUrl : "";
    const sec = Math.floor((song.dt || 0) / 1e3);
    const duration = secondsLabel(sec);
    const privilege = (json.privileges || [])[0] || {};
    const maxbr = privilege.maxbr || 0;
    const flag = privilege.flag || 0;
    let outLevel = "standard";
    const target = WY_LEVELS.find(([name]) => name === level);
    const targetIndex = target ? target[1][0] : 0;
    for (const [name, [idx, threshold]] of WY_LEVELS) {
      if (idx < 3 ? maxbr >= threshold : (flag & threshold) !== 0) outLevel = name;
      if (idx === targetIndex) break;
    }
    return {
      rid: parseInt(String(id)),
      name: song.name,
      artist,
      album: albumName,
      duration,
      pic,
      level: outLevel,
      url: `http://music.163.com/song/media/outer/url?id=${id}.mp3`
    };
  } catch (err) {
    console.error("wySongDetail error:", err);
    return null;
  }
}
async function wyPlaylist(playlistId, count = 30) {
  const url = `https://music.163.com/api/v6/playlist/detail?s=0&id=${playlistId}&n=${count}&t=0`;
  const cookie = "MUSIC_U=0007A978925988D5B41C4380BDB8E91BD23886F476867BD39EE7B653E5AB8D53878F75577D3D2D30CFD7F016C07B332F84C15E1AF67FAE750CAAFC6A9A26CBF575AD7790F08BC96B4B9291DE806051F18A4A9A332C9946AE6913E1216BCE7B3FACA1F88B37F08179530E4DEB6AF404720C764CF9F9CC7A95622BF775606CC4ABD4B0771C1A846B8BC21017C51C55FC66F6A68855DE7F758CF1BCE0BE43304A52C506ECC5EF324DF6BAE825863D1195D235C6BAF083C31EEC9F26350498FA9431748B44E116C7817DA7F603B56F384441F6CC83E8A9E5BF52B3399A44A29A1D00315C3F0F2428C747E766C5ABEB5B86D0D8F0AA51704418EB52E09201BB016B9DE438DEBF43244805F95B6D3D038345C6E07F1A2CCAC5D71EA487BBB1E2CC61A1D1D6C6661C0C0F52D358B9152ECAF8813BBBF7A3318176CA086732652BEFD8F53E2C287DC0F2EA8BCA1937DEB7E7BBD18BECA04CD2E30FC83E17C1D6D8A70E4176D0D189A78FF084445B75631E6821018A6C0F40DA9FD3C75029530F10EA77E3FB92F153C6E9547B6F5F81905CA3CCC050C600BC2F2E25B7578341AA96B2447B8E92E2EEB13E3CC7C879ACC0A2449787AF;os=pc;appver=8.9.70;";
  const fakeIp = Array(4).fill(0).map(() => Math.floor(Math.random() * 256)).join(".");
  const headers = {
    Cookie: cookie,
    "X-FORWARDED-FOR": fakeIp,
    "CLIENT-IP": fakeIp
  };
  try {
    const text = await httpGetText(url, headers);
    const json = JSON.parse(text);
    if (!json.playlist) {
      return { code: 500, msg: "获取歌单失败: 歌单为空", data: null };
    }
    const playlist = json.playlist;
    let tracks = playlist.tracks || [];
    const trackIds = Array.isArray(playlist.trackIds) ? playlist.trackIds : [];
    if (trackIds.length > tracks.length) {
      const ids = trackIds.map((t) => Number(t?.id)).filter((n) => Number.isFinite(n) && n > 0);
      const filled = [];
      const batch = 200;
      for (let i = 0; i < ids.length; i += batch) {
        const slice = ids.slice(i, i + batch);
        try {
          const detail = JSON.parse(
            await httpGetText(`https://music.163.com/api/song/detail?ids=${encodeURIComponent(JSON.stringify(slice))}`, headers)
          );
          if (Array.isArray(detail.songs)) filled.push(...detail.songs);
        } catch (err) {
          console.warn("[网易云歌单] 补全歌曲详情失败", err);
        }
      }
      if (filled.length > tracks.length) tracks = filled;
    }
    const musicList = tracks.map((song) => {
      const alia = song.alia || [];
      const alias = alia.length > 0 ? alia.join("-") : "";
      const name = alias ? `${song.name} - (${alias})` : String(song.name);
      const al = song.al || song.album || {};
      const ar = song.ar || song.artists || [];
      const pic = al.picUrl ? String(al.picUrl).replace(/^http:\/\//, "https://") : "";
      const artist = Array.isArray(ar) ? ar.map((a) => a?.name).filter(Boolean).join(" & ") : "";
      return {
        rid: String(song.id),
        name,
        artist,
        pic,
        album: String(al.name || ""),
        duration: normalizeDuration(song.dt || song.duration)
      };
    });
    const totalCount = Number(playlist.trackCount ?? trackIds.length ?? musicList.length) || musicList.length;
    return {
      code: 200,
      msg: "获取歌单成功",
      data: {
        name: String(playlist.name || ""),
        img: playlist.coverImgUrl ? String(playlist.coverImgUrl).replace(/^http:\/\//, "https://") : "",
        userName: playlist.creator ? String(playlist.creator.nickname || "") : "",
        uPic: playlist.creator?.avatarUrl ? String(playlist.creator.avatarUrl).replace(/^http:\/\//, "https://") : "",
        id: playlistId,
        musicList,
        totalCount,
        hasMore: musicList.length < totalCount,
        desc: playlist.description,
        playCount: playlist.playCount
      }
    };
  } catch (err) {
    console.error("getWyPlaylist error:", err);
    return { code: 500, msg: "获取歌单失败: " + String(err), data: null };
  }
}
const KW_UA = "Mozilla/5.0 (Windows NT 6.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/37.0.2062.120 Safari/537.36";
const KW_BR_MAP = {
  standard: "128kmp3",
  exhigh: "320kmp3",
  lossless: "2000kflac",
  aac: "24kaac",
  wma: "96kwma",
  ape: "1000kape"
};
async function kwConvertUrl(rid, level = "standard") {
  const br = KW_BR_MAP[level] || "320kmp3";
  const text = await httpGetText(
    `http://mobi.kuwo.cn/mobi.s?f=web&user=0&source=kwplayercar_ar_6.0.0.9_B_jiakong_vh.apk&type=convert_url_with_sign&br=${br}&sig=0&rid=${rid}`,
    { "User-Agent": KW_UA }
  );
  let url = String(JSON.parse(text)?.data?.url || "");
  if (url) {
    url = url.replace(/\?.*/, "");
    url = url.replace("http:", "https:");
    url = url.replace(/(?<=https:\/\/)(.*?)(?=\.sycdn)/, "$1");
    url = url.replace(".sycdn", "-sycdn");
  }
  return url;
}
async function kwSongDetail(rid) {
  try {
    const pay = await httpGetText(`http://musicpay.kuwo.cn/music.pay?op=query&action=play&ids=${rid}`, {
      "User-Agent": KW_UA,
      "x-forwarded-for": "1.0.1.114",
      "x-real-ip": "1.0.1.114"
    });
    const song = (JSON.parse(pay)?.songs || [])[0] || {};
    const url = await kwConvertUrl(rid);
    const sec = Number(song.duration || 0);
    const duration = secondsLabel(sec);
    const picText = await httpGetText(
      `http://artistpicserver.kuwo.cn/pic.web?corp=kuwo&type=rid_pic&pictype=url&content=list&size=800&rid=${rid}`
    );
    const pic = picText.replace("http://", "https://").replace("kwcdn.kuwo.cn", "kuwo.cn");
    const lyricText = await httpGetText(`https://wapi.kuwo.cn/openapi/v1/www/lyric/getlyric?musicId=${rid}&httpsStatus=1`);
    let lrc = "";
    try {
      const lines = JSON.parse(lyricText)?.data?.lrclist || [];
      for (const line of lines) {
        const t = parseFloat(line.time);
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60);
        const ms = Math.round((t - Math.floor(t)) * 1e3);
        lrc += `[${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}]${line.lineLyric}
`;
      }
    } catch (err) {
      console.error("Kw lrc parse error", err);
    }
    return {
      rid,
      name: String(song.name || ""),
      artist: String(song.artist || ""),
      album: String(song.album || ""),
      pic,
      duration,
      url,
      lrc
    };
  } catch (err) {
    console.error("getKwSongDetail error", err);
    return null;
  }
}
async function kwPlaylist(playlistId, page = 1, pageSize = 30) {
  const url = `https://m.kuwo.cn/newh5app/wapi/api/www/playlist/playListInfo?pid=${playlistId}&pn=${page}&rn=${pageSize}`;
  try {
    const json = JSON.parse(await httpGetText(url));
    const list = json.data?.musicList;
    if (!list) return { code: 500, msg: "获取歌单失败", data: null };
    const musicList = list.map((item) => {
      const ridMatch = String(item.rid).match(/[\d]+/);
      const rid = ridMatch ? ridMatch[0] : item.rid;
      const pic = item.pic ? String(item.pic).replace("http://", "https://") : "";
      return {
        rid,
        name: item.name,
        artist: item.artist,
        pic,
        album: item.album,
        duration: normalizeDuration(item.duration || item.songTimeMinutes)
      };
    });
    const d = json.data;
    const img = d.img ? String(d.img).replace("http://", "https://").replace("kwcdn.kuwo.cn", "kuwo.cn") : "";
    return {
      code: 200,
      msg: "获取歌单成功",
      data: {
        name: String(d.name || ""),
        img,
        userName: String(d.userName || ""),
        uPic: d.uPic ? String(d.uPic).replace("http://", "https://") : "",
        total: d.total,
        totalCount: Number(d.total) || musicList.length,
        tag: d.tag,
        id: playlistId,
        musicList,
        desc: d.info
      }
    };
  } catch (err) {
    console.error("getKwPlaylist error:", err);
    return { code: 500, msg: "获取歌单失败: " + String(err), data: null };
  }
}
const QQ_HEADERS = { Referer: "https://y.qq.com/", Origin: "https://y.qq.com" };
async function qqSongDetail(songMid) {
  try {
    const payload = JSON.stringify({
      comm: {
        ct: 11,
        cv: "1003006",
        v: "1003006",
        QIMEI36: "c2cff9d0d3310d40ea444083100014717907",
        QIMEI: "c2cff9d0d3310d40ea444083100014717907",
        os_ver: "12",
        phonetype: "Redmi K30 Pro",
        devicelevel: "31",
        tmeAppID: "qqmusiclight",
        nettype: "NETWORK_WIFI"
      },
      req: {
        module: "music.trackInfo.UniformRuleCtrl",
        method: "CgiGetTrackInfo",
        param: { mids: [songMid], types: [0] }
      }
    });
    const text = await httpPostText("http://u.y.qq.com/cgi-bin/musicu.fcg", payload, {
      Referer: "https://y.qq.com/",
      "Content-Type": "application/x-www-form-urlencoded"
    });
    const data = JSON.parse(text)?.req?.data;
    const track = (data?.tracks || [])[0];
    if (!track) return null;
    const album = track.album || {};
    const sec = Number(track.interval || 0);
    const albumMid = String(album.mid || "");
    const pic = albumMid ? `http://y.qq.com/music/photo_new/T002R800x800M000${albumMid}.jpg` : "";
    return {
      rid: songMid,
      name: String(track.title || ""),
      artist: (track.singer || []).map((s) => s.name).join(" & "),
      album: String(album.name || ""),
      pic,
      duration: `${Math.floor(sec / 60)}分${sec % 60}秒`
    };
  } catch (err) {
    console.error("getQqSongDetail error:", err);
    return null;
  }
}
async function qqPlaylistSquare(categoryId, page = 1, pageSize = 30) {
  const id = String(categoryId || "10000000").trim();
  const pageNum = Math.max(1, Number(page) || 1);
  const size = Math.min(50, Math.max(1, Number(pageSize) || 30));
  const payload = {
    comm: { cv: 1602, ct: 20 },
    playlist: id === "10000000" ? {
      method: "get_playlist_by_tag",
      param: { id: 1e7, sin: size * (pageNum - 1), size, order: 5, cur_page: pageNum },
      module: "playlist.PlayListPlazaServer"
    } : {
      method: "get_category_content",
      param: {
        titleid: Number(id),
        caller: "0",
        category_id: Number(id),
        size,
        page: pageNum - 1,
        use_page: 1
      },
      module: "playlist.PlayListCategoryServer"
    }
  };
  const url = `https://u.y.qq.com/cgi-bin/musicu.fcg?loginUin=0&hostUin=0&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=wk_v15.json&needNewCode=0&data=${encodeURIComponent(JSON.stringify(payload))}`;
  try {
    const json = JSON.parse(await httpGetText(url, QQ_HEADERS));
    if (json?.code !== 0 || json?.playlist?.code !== 0) {
      return { code: 500, msg: String(json?.playlist?.msg || "获取QQ歌单广场失败"), data: null };
    }
    const data = json.playlist?.data || {};
    const raw = Array.isArray(data.v_playlist) ? data.v_playlist : Array.isArray(data.content?.v_item) ? data.content.v_item : [];
    const musicList = raw.map((item) => {
      const basic = item.basic || item;
      return {
        rid: String(item.tid ?? basic.tid ?? ""),
        name: String(item.title ?? basic.title ?? ""),
        pic: String(
          item.cover_url_medium ?? item.cover_url_big ?? basic.cover?.medium_url ?? basic.cover?.default_url ?? ""
        ).replace(/^http:/, "https:"),
        PlayCnt: item.access_num ?? basic.play_cnt ?? 0,
        total: item.song_ids?.length ?? basic.song_cnt ?? 0,
        uname: String(
          item.creator_info?.nick ?? basic.creator?.nick ?? ""
        ),
        desc: String(item.desc ?? basic.desc ?? "")
      };
    }).filter((t) => t.rid && t.name);
    return {
      code: 200,
      msg: "获取QQ歌单成功",
      data: {
        name: "",
        img: "",
        userName: "",
        uPic: "",
        id,
        musicList,
        total: Number(data.total ?? data.content?.total_cnt) || musicList.length
      }
    };
  } catch (err) {
    console.error("getQqPlaylistSquare error:", err);
    return { code: 500, msg: "获取QQ歌单广场失败: " + String(err), data: null };
  }
}
async function qqPlaylist(playlistId) {
  const url = `https://c.y.qq.com/v8/fcg-bin/fcg_v8_playlist_cp.fcg?id=${playlistId}&format=json&newsong=1&platform=jqspaframe.json`;
  try {
    const json = JSON.parse(await httpGetText(url, { referer: `https://y.qq.com/n/yqq/playlist/${playlistId}.html`, origin: "https://y.qq.com" }));
    if (!json.data || !json.data.cdlist || json.data.cdlist.length === 0) {
      return { code: 500, msg: "获取歌单失败或歌单为空", data: null };
    }
    const disc = json.data.cdlist[0];
    const musicList = disc.songlist.map((song) => {
      const album = song.album || {};
      const albumMid = String(album.mid || "");
      const pic = albumMid ? `https://y.qq.com/music/photo_new/T002R300x300M000${albumMid}.jpg?max_age=2592000` : "";
      let artist = "Unknown";
      if (song.singer && Array.isArray(song.singer)) {
        artist = song.singer.map((s) => s.name).join(" & ");
      }
      return {
        rid: String(song.mid),
        name: String(song.name),
        artist,
        pic,
        album: String(album.name || ""),
        duration: normalizeDuration(song.interval || song.duration)
      };
    });
    return {
      code: 200,
      msg: "获取歌单成功",
      data: {
        name: String(disc.dissname || ""),
        img: disc.logo ? String(disc.logo).replace("http://", "https://") : "",
        userName: String(disc.nickname || ""),
        uPic: disc.headurl ? String(disc.headurl).replace("http://", "https://") : "",
        id: playlistId,
        musicList,
        totalCount: Number(disc.songnum ?? disc.songlist?.length ?? musicList.length) || musicList.length,
        desc: String(disc.desc || ""),
        tags: Array.isArray(disc.tags) ? disc.tags.map((t) => t.name || "") : []
      }
    };
  } catch (err) {
    console.error("getQqPlaylist error:", err);
    return { code: 500, msg: "获取歌单失败: " + String(err), data: null };
  }
}
const KG_CATEGORY_ENDPOINTS = {
  "album-search": "https://msearch.kugou.com/api/v3/search/album",
  "artist-search": "https://msearch.kugou.com/api/v3/search/singer",
  "playlist-search": "https://msearch.kugou.com/api/v3/search/special",
  "album-detail": "http://mobilecdn.kugou.com/api/v3/album/song",
  "artist-detail": "http://mobilecdnbj.kugou.com/api/v3/singer/song"
};
async function kgCategoryRequest(action, params) {
  const endpoint = KG_CATEGORY_ENDPOINTS[action];
  if (!endpoint) throw new Error("不支持的酷狗分类请求");
  const query = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12e3);
  try {
    const res = await fetch(`${endpoint}?${query}`, {
      signal: controller.signal,
      headers: {
        Accept: "application/json,text/plain,*/*",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/106.0.0.0 Safari/537.36"
      }
    });
    if (!res.ok) throw new Error(`酷狗分类接口请求失败（${res.status}）`);
    const text = (await res.text()).replace(/^\s*<!--KG_TAG_RES_START-->/, "").replace(/<!--KG_TAG_RES_END-->\s*$/, "").trim();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("酷狗分类接口返回了无效数据");
    }
  } catch (err) {
    throw err instanceof DOMException && err.name === "AbortError" ? new Error("酷狗分类请求超时") : err;
  } finally {
    clearTimeout(timer);
  }
}
async function kgGatewayRequest(req, method = "GET") {
  try {
    const dfid = "-" + Date.now() + Math.floor(Math.random() * 1e5);
    const mid = md5Hex(dfid);
    const uuid = md5Hex(dfid + mid);
    const clienttime = Math.floor(Date.now() / 1e3);
    const userid = 111111;
    const token = md5Hex("11111111111111111111" + clienttime);
    const base = {
      dfid,
      mid,
      uuid,
      appid: 1005,
      clientver: 12429,
      userid,
      clienttime,
      token
    };
    const params = { ...base, ...req.params };
    const body = req.data ? JSON.stringify(req.data) : null;
    if (!params.signature) {
      ;
      params.signature = kgSignature(params, body, false);
    }
    let url = "https://gateway.kugou.com" + req.url;
    const headers = {
      "X-Fixed-IP": "121.12.162.142",
      "X-Router": req.headers?.["x-router"] || "pubsongscdn.kugou.com",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    };
    if (method === "GET") url = appendQuery(url, params);
    const text = await httpGetText(url, headers);
    try {
      return { status: 200, body: JSON.parse(text) };
    } catch {
      return { status: 200, body: text };
    }
  } catch (err) {
    console.error("Kg request failed:", err);
    return { status: 500, body: null };
  }
}
async function kgSearchSpecial(keyword, page = 1, pagesize = 10) {
  return kgGatewayRequest(
    {
      url: "/v1/search/special",
      params: {
        keyword,
        platform: "WebFilter",
        page,
        pagesize,
        iscorrection: 1,
        area_code: 1
      },
      headers: { "x-router": "complexsearch.kugou.com" }
    },
    "GET"
  );
}
async function kgPlaylistContent(req) {
  return kgGatewayRequest(
    {
      url: "/v2/get_other_list_file",
      params: {
        type: 1,
        module: "CloudMusic",
        page: req.page,
        pagesize: req.pagesize,
        global_collection_id: req.id,
        specialid: 0,
        need_sort: 1,
        area_code: 1
      },
      headers: { "x-router": "pubsongscdn.kugou.com" }
    },
    "GET"
  );
}
async function kgSongDetail(hash) {
  try {
    const text = await httpGetText(
      `https://wwwapi.kugou.com/yy/index.php?r=play/getdata&hash=${hash}&dfid=1&mid=1&platid=4`,
      {
        Cookie: "kg_mid=1; kg_dfid=1",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36"
      }
    );
    const json = JSON.parse(text);
    if (json.status === 1 && json.data && (json.data.play_url || json.data.play_backup_url)) {
      const d = json.data;
      const sec = Math.floor((d.timelength || 0) / 1e3);
      let pic = d.img || "";
      if (pic) {
        pic = pic.replace(/http:\/\/|\/\{size\}/g, (m) => m === "http://" ? "https://" : "/480").replace("{size}", "480");
      }
      return {
        rid: hash,
        name: d.song_name || "",
        artist: d.author_name || "",
        album: d.album_name || "",
        pic,
        duration: `${Math.floor(sec / 60)}分${sec % 60}秒`,
        url: d.play_url || d.play_backup_url,
        lrc: d.lyrics
      };
    }
    const fallback = JSON.parse(await httpGetText(`https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${hash}`));
    if (fallback.url) {
      const sec = fallback.timeLength ? Math.floor(fallback.timeLength) : 0;
      let pic = fallback.imgUrl || fallback.albumImgUrl || "";
      pic = pic.replace("{size}", "480");
      return {
        rid: hash,
        name: fallback.songName,
        artist: fallback.singerName,
        album: fallback.albumName || "",
        pic,
        duration: `${Math.floor(sec / 60)}分${sec % 60}秒`,
        url: fallback.url,
        lrc: ""
      };
    }
    return null;
  } catch (err) {
    console.error("getKgSongDetail error:", err);
    return null;
  }
}
const KG_PAGE_SIZE = 300;
const KG_MAX_PAGES = 50;
const KG_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "zh-CN,zh;q=0.9"
};
function normalizeCover$1(input, size = "150") {
  if (typeof input !== "string" || !input.trim()) return "";
  return input.replace(/^http:\/\//, "https://").replace(/\/\{size\}/g, `/${size}`).replace("{size}", size);
}
function itemHash(item) {
  return String(
    item?.hash || item?.HASH || item?.audio_info?.hash || item?.rid || ""
  ).trim();
}
function itemsFingerprint(items) {
  return items.map((item, i) => itemHash(item) || String(item?.filename || item?.name || item?.songname || i)).join("|");
}
async function kgPostJson(url, data) {
  const text = await httpPostText(url, JSON.stringify(data), { ...KG_HEADERS, "Content-Type": "application/json" });
  return JSON.parse(text);
}
async function kucodeCommand(data) {
  return kgPostJson("http://t.kugou.com/command/", {
    appid: 1001,
    clientver: 9020,
    mid: "21511157a05844bd085308bc76ef3343",
    clienttime: 640612895,
    key: "36164c4015e704673c588ee202b9ecb8",
    data
  });
}
function collectionIdOf(info) {
  const i = info;
  return String(i?.global_collection_id || i?.copy_gcid || "") || (i?.id && i?.userid ? `collection_${i.id}_${i.userid}_${i.id}_${i.collect_type || 0}` : "");
}
async function fetchKucodeSongs(info) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (let page = 1; page <= KG_MAX_PAGES; page++) {
    let res;
    try {
      res = await kgPostJson("http://www2.kugou.kugou.com/apps/kucodeAndShare/app/", {
        appid: 1001,
        clientver: 10112,
        mid: "70a02aad1ce4648e7dca77f2afa7b182",
        clienttime: 722219501,
        key: "381d7062030e8a5a94cfbe50bfe65433",
        data: {
          id: info?.id,
          type: 3,
          userid: info?.userid,
          collect_type: info?.collect_type,
          page,
          pagesize: KG_PAGE_SIZE
        }
      });
    } catch (err) {
      console.warn("[酷狗歌单] 酷狗码内容接口失败:", err);
      break;
    }
    const list = res?.status === 1 && Array.isArray(res.data) ? res.data : [];
    if (list.length === 0) break;
    const fp = itemsFingerprint(list);
    if (fp && seen.has(fp)) break;
    seen.add(fp);
    out.push(...list);
    if (list.length < KG_PAGE_SIZE) break;
  }
  return out;
}
async function fetchCollectionSongs(collectionId) {
  if (!collectionId) return [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (let page = 1; page <= KG_MAX_PAGES; page++) {
    const res = await kgPlaylistContent({ id: collectionId, page, pagesize: KG_PAGE_SIZE });
    if (res?.status !== 200) break;
    const body = res.body;
    const list = Array.isArray(body?.data?.info) ? body.data.info : [];
    if (list.length === 0) break;
    const fp = itemsFingerprint(list);
    if (fp && seen.has(fp)) break;
    seen.add(fp);
    out.push(...list);
    if (list.length < KG_PAGE_SIZE) break;
  }
  return out;
}
function normalizeKgItem(item) {
  const i = item;
  const hash = itemHash(i);
  if (!hash) return null;
  const audioInfo = i?.audio_info;
  const rawName = String(i?.name || i?.filename || i?.songname || audioInfo?.songname || "").replace(/\.mp3$/i, "").trim();
  const parts = rawName.split(" - ");
  const artist = String(i?.singername || i?.singer || i?.author_name || audioInfo?.author_name || "未知艺术家") || (parts.length > 1 ? parts[0]?.trim() : "");
  const songName = parts.length > 1 ? parts.slice(1).join(" - ").trim() : String(i?.songname || audioInfo?.songname || rawName || "未知歌曲");
  return {
    rid: hash,
    name: songName,
    artist: artist || "未知艺术家",
    pic: normalizeCover$1(
      i?.info?.image || i?.image || i?.album_sizable_cover || i?.cover || i?.img || i?.pic,
      "150"
    ),
    album: String(i?.albumname || i?.album_name || i?.album_info?.albumName || i?.albumName || ""),
    duration: normalizeDuration(i?.timelength || i?.duration || i?.time || audioInfo?.timelength),
    hash,
    sqHash: String(i?.sqhash || i?.sq_hash || audioInfo?.sqhash || "").trim(),
    source: "kg"
  };
}
async function resolveKugouCode(code) {
  try {
    const cmd = await kucodeCommand(code);
    if (cmd?.status !== 1) return null;
    const info = cmd?.data;
    if (!info?.id) return null;
    const collectionId = collectionIdOf(info);
    const [shareSongs, legacySongs] = await Promise.all([fetchKucodeSongs(info), fetchCollectionSongs(collectionId)]);
    const songs = (legacySongs.length > shareSongs.length ? legacySongs : shareSongs).map((it) => normalizeKgItem(it)).filter((t) => !!t);
    const expected = Math.max(Number(info?.count) || 0, 0);
    console.log("[酷狗歌单] PC 酷狗码解析完成:", {
      code,
      collectionId,
      expectedCount: expected,
      shareCount: shareSongs.length,
      legacyCount: legacySongs.length,
      finalCount: songs.length
    });
    const cover = normalizeCover$1(info?.img || info?.cover || info?.imgurl, "150");
    return {
      code: 200,
      msg: "获取歌单成功",
      data: {
        name: String(info?.name || info?.specialname || info?.title || ""),
        img: cover,
        userName: String(info?.username || info?.nickname || info?.user_name || ""),
        uPic: normalizeCover$1(info?.user_pic || info?.headurl, "150"),
        desc: String(info?.intro || info?.description || info?.desc || ""),
        playCount: String(info?.play_count || info?.playcount || ""),
        id: code,
        resolvedId: collectionId,
        totalCount: expected || songs.length,
        musicList: songs,
        hasMore: false
      }
    };
  } catch (err) {
    console.warn("[酷狗歌单] 酷狗码精确解析失败，回退旧链路:", err);
    return null;
  }
}
async function kgPlaylist(playlistId, page = 1, nameHint) {
  try {
    const rawId = String(playlistId || "").trim();
    const isCollection = /^collection_\d+_\d+_\d+(?:_\d+)?$/.test(rawId);
    const isCode = /^\d{4,}$/.test(rawId);
    if (!isCollection && !isCode) {
      return {
        code: 500,
        msg: "酷狗仅支持输入酷狗码（纯数字），不支持粘贴歌单链接",
        data: { name: "", img: "", userName: "", uPic: "", id: rawId, musicList: [] }
      };
    }
    console.log("开始解析酷狗歌单ID:", rawId, "name=", nameHint || "");
    let listId = rawId;
    let meta = null;
    if ((page || 1) === 1 && !String(rawId || "").includes("collection")) {
      const precise = await resolveKugouCode(rawId);
      if (precise) return precise;
      if (!(typeof nameHint === "string" && nameHint.trim())) {
        return {
          code: 500,
          msg: "酷狗码无效或已失效，请检查后重新输入",
          data: { name: "", img: "", userName: "", uPic: "", id: rawId, musicList: [] }
        };
      }
    }
    if (typeof playlistId === "string" && /^collection_\d+_\d+_\d+(_\d+)?$/.test(playlistId.trim())) {
      listId = playlistId.trim();
      try {
        const search = await kgSearchSpecial(listId);
        const lists = search?.body?.data;
        const arr = Array.isArray(lists?.lists) ? lists.lists : [];
        if (arr.length > 0 && arr[0]?.gid) meta = arr[0];
      } catch {
      }
    } else {
      const hint = typeof nameHint === "string" && nameHint.trim() ? nameHint.trim() : playlistId;
      const search = await kgSearchSpecial(hint);
      const body = search?.body?.data;
      const arr = Array.isArray(body?.lists) ? body.lists : [];
      if (arr.length > 0) {
        let hit = null;
        if (typeof nameHint === "string" && nameHint.trim()) {
          hit = arr.find((n) => n.specialname === nameHint.trim()) || null;
        }
        if (!hit && /^\d+$/.test(playlistId.trim())) {
          hit = arr.find((n) => String(n.specialid) === playlistId.trim()) || null;
        }
        if (hit?.gid) {
          listId = String(hit.gid);
          meta = hit;
        }
      }
    }
    if (typeof listId !== "string" || !/^collection_\d+_\d+_\d+(_\d+)?$/.test(listId.trim())) {
      return {
        code: 500,
        msg: "无法解析酷狗歌单，请确认酷狗码有效且歌单未设为私密",
        data: {
          name: meta ? String(meta.specialname || "") : "",
          img: "",
          userName: "",
          uPic: "",
          id: rawId,
          musicList: []
        }
      };
    }
    const collected = [];
    let pages = 0;
    let curPage = page || 1;
    let hasMore = false;
    while (pages < KG_MAX_PAGES) {
      const res = await kgPlaylistContent({ id: listId, page: curPage, pagesize: KG_PAGE_SIZE });
      if (res?.status !== 200) {
        console.error("获取歌单内容请求失败", res);
        break;
      }
      const body = res.body;
      const info = body?.data?.info;
      const list = Array.isArray(info) ? info : [];
      collected.push(...list);
      pages++;
      const full = list.length >= KG_PAGE_SIZE;
      hasMore = full;
      if (!full || (page || 1) > 1) break;
      curPage++;
    }
    const musicList = collected.map((item) => {
      const i = item;
      const audioInfo = i.audio_info;
      const rawName = String(i.name || i.filename || "");
      const parts = rawName.split(" - ");
      const artist = parts.length > 1 ? parts[0] : "未知艺术家";
      const song = parts.length > 1 ? parts.slice(1).join(" - ") : rawName;
      let pic = i.cover || i.img || i.image || i.info?.image || "";
      if (pic) {
        pic = pic.replace(/http:\/\/|\/\{size\}/g, (m) => m === "http://" ? "https://" : "/150").replace("{size}", "150");
      }
      return {
        rid: String(i.hash),
        name: song || "未知歌曲",
        artist,
        pic,
        album: String(i.album_name || i.albumname || ""),
        duration: normalizeDuration(i.timelength || i.duration || i.time || audioInfo?.timelength),
        hash: String(i.hash),
        sqHash: String(i.sqhash || i.sq_hash || audioInfo?.sqhash || "").trim(),
        source: "kg"
      };
    }).filter((t) => t.rid);
    let name = "";
    let img = "";
    let userName = "";
    let uPic = "";
    let desc = "";
    let playCount = "";
    if (meta) {
      name = String(meta.specialname || meta.special_name || meta.name || meta.title || "");
      img = String(meta.img || meta.cover || meta.pic || "");
      if (img) img = img.replace("http://", "https://").replace("{size}", "150").replace("/{size}", "/150");
      userName = String(meta.username || meta.user_name || meta.nickname || "");
      uPic = String(meta.user_avatar || meta.user_pic || meta.headurl || meta.active_url || meta.avatar || "");
      if (uPic) uPic = uPic.replace("http://", "https://");
      desc = String(meta.intro || meta.description || meta.desc || "");
      playCount = String(meta.play_count || meta.play_amt || meta.playcount || "");
    }
    return {
      code: 200,
      msg: "获取歌单成功",
      data: {
        name,
        img,
        userName,
        uPic,
        desc,
        playCount,
        id: rawId,
        resolvedId: listId,
        totalCount: musicList.length,
        musicList,
        hasMore
      }
    };
  } catch (err) {
    console.error("getKgPlaylist Critical Error:", err);
    return {
      code: 500,
      msg: "解析歌单异常: " + String(err),
      data: { name: "", img: "", userName: "", uPic: "", id: playlistId, musicList: [] }
    };
  }
}
const SOURCE_LABELS = {
  wy: "网易云音乐",
  kw: "酷我音乐",
  qq: "QQ 音乐",
  kg: "酷狗音乐"
};
const PAGE_SIZE = 100;
const KW_MAX_PAGES = 200;
const WY_PAGE_LIMIT = 1e3;
const SHORT_LINK_MAX_HOPS = 6;
const SHORT_LINK_TIMEOUT_MS = 1e4;
const isObj$2 = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const strTrim = (v) => typeof v === "string" ? v.trim() : "";
const strOrNumber = (v) => typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
function normalizeCover(value) {
  return strTrim(value).replace(/^http:\/\//i, "https://").replace(/\/\{size\}/gi, "/400").replace(/\{size\}/gi, "400");
}
function firstUrlIn(text) {
  const m = text.match(/https?:\/\/[^\s"'<>]+/i);
  return m?.[0] ?? text;
}
const SOURCE_HOSTS = {
  wy: ["music.163.com", "163cn.tv"],
  kw: ["kuwo.cn", "kw.cn"],
  qq: ["y.qq.com", "qq.cn", "sqq.com"]
};
const hostMatches = (host, domain) => host === domain || host.endsWith(`.${domain}`);
function assertSourceUrl(source, url) {
  if (!/^https?:\/\//i.test(url)) return;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error("歌单链接格式不正确");
  }
  if (!SOURCE_HOSTS[source].some((domain) => hostMatches(host, domain))) {
    throw new Error(`链接不是${SOURCE_LABELS[source]}歌单，请粘贴对应平台的歌单链接`);
  }
}
const pureDigits = (value) => /^\d{4,}$/.test(value) ? value : "";
function isShortLinkHost(source, url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (source === "wy") return host === "163cn.tv";
    if (source === "qq") {
      return host === "y.qq.com" || host.endsWith(".y.qq.com") || host === "qq.cn" || host.endsWith(".qq.cn") || host === "sqq.com" || host.endsWith(".sqq.com");
    }
  } catch {
    return false;
  }
  return false;
}
async function followShortLink(url) {
  let target = url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHORT_LINK_TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= SHORT_LINK_MAX_HOPS; hop += 1) {
      const res = await fetch(target, {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36"
        },
        signal: controller.signal
      });
      res.body?.cancel().catch(() => void 0);
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        target = new URL(location, target).toString();
        continue;
      }
      return res.url || target;
    }
  } catch (err) {
    throw err instanceof Error && err.name === "AbortError" ? new Error("短链解析超时，请检查网络后重试") : new Error(`短链解析失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
  throw new Error("短链跳转次数过多，请使用完整歌单链接或歌单 ID");
}
async function resolveLink(source, input) {
  const raw = String(input ?? "").trim();
  if (!raw) return input;
  const url = firstUrlIn(raw);
  try {
    assertSourceUrl(source === "kg" ? "kw" : source, url);
    return url;
  } catch (err) {
    if (source !== "wy" && source !== "qq") throw err;
    if (!isShortLinkHost(source, url)) throw err;
  }
  try {
    const resolved = await followShortLink(url);
    assertSourceUrl(source, resolved);
    return resolved;
  } catch (err) {
    try {
      assertSourceUrl(source, url);
      return url;
    } catch {
      throw err;
    }
  }
}
function assertImportSource(source) {
  const raw = String(source ?? "").trim().toLowerCase();
  if (raw === "wy" || raw === "kw" || raw === "qq" || raw === "kg") return raw;
  throw new Error("请选择有效的歌单来源平台");
}
function extractFirstId(url, patterns) {
  for (const pattern of patterns) {
    const m = url.match(pattern);
    if (m?.[1]) return m[1];
  }
  return "";
}
function parsePlaylistInput(source, input) {
  const kind = assertImportSource(source);
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("请输入歌单链接或 ID");
  const url = firstUrlIn(raw);
  if (kind === "wy") {
    assertSourceUrl("wy", url);
    const id = extractFirstId(url, [/[?&#]id=(\d+)/i, /\/playlist\/(\d+)/i, /playlist_detail\/(\d+)/i]) || pureDigits(raw);
    if (!id) throw new Error("未识别到网易云音乐歌单 ID");
    return { externalId: id, requestId: id };
  }
  if (kind === "kw") {
    assertSourceUrl("kw", url);
    const id = extractFirstId(url, [/[?&#](?:pid|id)=(\d+)/i, /playlist_detail\/(\d+)/i, /\/playlist\/(\d+)/i]) || pureDigits(raw);
    if (!id) throw new Error("未识别到酷我音乐歌单 ID");
    return { externalId: id, requestId: id };
  }
  if (kind === "qq") {
    assertSourceUrl("qq", url);
    const id = extractFirstId(url, [/[?&#](?:id|disstid)=(\d+)/i, /\/playlist\/(\d+)/i, /\/taoge\/(\d+)/i]) || pureDigits(raw);
    if (!id) throw new Error("未识别到 QQ 音乐歌单 ID");
    return { externalId: id, requestId: id };
  }
  const codeMatch = raw.match(/^(?:酷狗码|小狗码)\s*[:：]?\s*(\d{4,})$/i);
  if (codeMatch?.[1]) return { externalId: codeMatch[1], requestId: codeMatch[1] };
  if (pureDigits(raw)) return { externalId: pureDigits(raw), requestId: pureDigits(raw) };
  const collectionMatch = raw.match(/^(collection_\d+_\d+_\d+(?:_\d+)?)$/i);
  if (collectionMatch) return { externalId: collectionMatch[1], requestId: collectionMatch[1] };
  throw /^https?:\/\//i.test(url) ? new Error("酷狗仅支持输入酷狗码（纯数字），不支持粘贴歌单链接") : new Error("请输入有效的酷狗码（纯数字）");
}
function durationToSeconds$1(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const s2 = value > 1e4 ? value / 1e3 : value;
    return s2 > 0 ? Math.floor(s2) : void 0;
  }
  const raw = strTrim(value);
  if (!raw) return void 0;
  const cn = raw.match(/(\d+)\s*分\s*(\d+)\s*秒/);
  if (cn) {
    const s2 = Number(cn[1]) * 60 + Number(cn[2]);
    return s2 > 0 ? s2 : void 0;
  }
  const hm = raw.match(/^(\d{1,3}):(\d{1,2})$/);
  if (hm) {
    const s2 = Number(hm[1]) * 60 + Number(hm[2]);
    return s2 > 0 ? s2 : void 0;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return void 0;
  const s = n > 1e4 ? n / 1e3 : n;
  return s > 0 ? Math.floor(s) : void 0;
}
function trackFromFetched(item, source) {
  if (!isObj$2(item)) return null;
  const hash = strTrim(item.hash);
  const trackId = strOrNumber(item.rid) || strOrNumber(item.id) || hash;
  const name = strTrim(item.name);
  if (!trackId || !name) return null;
  const sqHash = strTrim(item.sqHash);
  const duration = durationToSeconds$1(
    item.duration || item.songTimeMinutes || item.timelength || item.interval || item.timeLength || item.durationSeconds
  );
  const localData = {};
  if (hash) localData.hash = hash;
  if (sqHash) localData.sqHash = sqHash;
  if (duration !== void 0) {
    localData.durationLabel = typeof item.duration === "string" && item.duration.trim() ? item.duration.trim() : `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, "0")}`;
  }
  return {
    id: "",
    source: source === "qq" ? "tx" : source,
    trackId,
    name,
    artist: strTrim(item.artist),
    album: strTrim(item.album) || void 0,
    coverUrl: normalizeCover(item.pic ?? item.coverUrl) || void 0,
    duration,
    localData: Object.keys(localData).length ? localData : void 0
  };
}
function assertPlaylistResult(result, source) {
  if (!isObj$2(result) || Number(result.code) !== 200) {
    throw new Error(strTrim(isObj$2(result) ? result.msg : "") || `获取${SOURCE_LABELS[source]}歌单失败`);
  }
  if (!isObj$2(result.data)) throw new Error(`${SOURCE_LABELS[source]}歌单数据格式错误`);
  return result.data;
}
async function fetchWy(id) {
  return assertPlaylistResult(await wyPlaylist(id, WY_PAGE_LIMIT), "wy");
}
async function fetchKw(id) {
  const collected = [];
  let first = null;
  let total = 0;
  for (let page = 1; page <= KW_MAX_PAGES; page += 1) {
    const data = assertPlaylistResult(await kwPlaylist(id, page, PAGE_SIZE), "kw");
    first = first ?? data;
    const list = Array.isArray(data.musicList) ? data.musicList : [];
    collected.push(...list);
    total = Math.max(total, Number(data.totalCount ?? data.total) || collected.length);
    if (list.length < PAGE_SIZE || collected.length >= total) break;
  }
  if (!first) throw new Error("获取酷我音乐歌单失败");
  return { ...first, musicList: collected, totalCount: total || collected.length };
}
async function fetchQq(id) {
  return assertPlaylistResult(await qqPlaylist(id), "qq");
}
async function fetchKg(id) {
  return assertPlaylistResult(await kgPlaylist(id, 1), "kg");
}
async function fetchPlaylist(source, id) {
  if (source === "wy") return fetchWy(id);
  if (source === "kw") return fetchKw(id);
  if (source === "qq") return fetchQq(id);
  return fetchKg(id);
}
async function importPlaylist(input) {
  const source = assertImportSource(input.source);
  const resolved = await resolveLink(source, input.input);
  const parsed = parsePlaylistInput(source, resolved);
  const data = await fetchPlaylist(source, parsed.requestId);
  const externalId = parsed.externalId;
  const tracks = (Array.isArray(data.musicList) ? data.musicList : []).map((item) => trackFromFetched(item, source)).filter((t) => !!t);
  if (!tracks.length) {
    throw new Error(`未获取到${SOURCE_LABELS[source]}歌单歌曲，请检查歌单是否为空或链接是否有效`);
  }
  const fallbackName = `${SOURCE_LABELS[source]}歌单 ${externalId}`;
  const firstCover = tracks.find((t) => t.coverUrl)?.coverUrl;
  return playlistLibrary.upsertImportedPlaylist({
    source: source === "qq" ? "tx" : source,
    externalId,
    name: strTrim(data.name) || fallbackName,
    coverUrl: normalizeCover(data.img) || firstCover,
    tracks
  });
}
async function refreshImportedPlaylist(playlistId) {
  const playlist = playlistLibrary.getImportedPlaylist(playlistId);
  const source = playlist.source === "tx" ? "qq" : playlist.source;
  if (!source || !["wy", "kw", "qq", "kg"].includes(source)) {
    throw new Error("当前歌单缺少可刷新的平台来源");
  }
  if (!playlist.externalId) throw new Error("当前歌单缺少平台歌单 ID");
  return (await importPlaylist({ source, input: playlist.externalId })).playlist;
}
const clone$3 = (v) => JSON.parse(JSON.stringify(v));
const DEBOUNCE_MS$1 = 1500;
const MAX_SYNC_ROUNDS$1 = 1e3;
class PlaylistSyncError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "PlaylistSyncError";
    this.code = code;
  }
}
class PlaylistSyncEngine {
  library;
  account;
  userId = null;
  enabled = false;
  autoSyncEnabled = true;
  generation = 0;
  debounceTimer = null;
  syncing = false;
  syncRequested = false;
  syncState = {
    phase: "idle",
    pendingMutationCount: 0,
    lastSuccessfulAt: null
  };
  remotePlaylistCount = null;
  remoteTrackCount = null;
  stateListeners = /* @__PURE__ */ new Set();
  libraryChangedListener = null;
  guestImportPromptHandler = null;
  constructor(library, account) {
    this.library = library;
    this.account = account;
  }
  setLibraryChangedListener(listener) {
    this.libraryChangedListener = listener;
  }
  setGuestImportPromptHandler(handler) {
    this.guestImportPromptHandler = handler;
  }
  subscribeState(listener) {
    this.stateListeners.add(listener);
    listener(this.getState());
    return () => {
      this.stateListeners.delete(listener);
    };
  }
  getState() {
    const pending = this.getPendingMutationCount();
    return { ...this.syncState, pendingMutationCount: pending };
  }
  async getStatus() {
    const userId = this.library.getActiveUserId();
    const snapshot = this.library.getSnapshot();
    const syncData = userId ? this.library.getAccountSyncData(userId) : null;
    let remoteStatus = null;
    if (userId && this.enabled) {
      try {
        remoteStatus = await this.account.getPlaylistStatus();
        this.remotePlaylistCount = remoteStatus.playlistCount;
        this.remoteTrackCount = remoteStatus.trackCount;
      } catch (err) {
        console.warn("[playlist-sync] 获取云端歌单状态失败:", err);
      }
    }
    const customCount = snapshot.playlists.filter((p) => p.type === "custom").length;
    const importedCount = snapshot.playlists.filter((p) => p.type === "imported").length;
    const lastSuccessfulAt = remoteStatus?.lastSyncedAt ?? syncData?.lastSuccessfulAt ?? this.syncState.lastSuccessfulAt ?? null;
    return {
      state: { ...this.getState(), lastSuccessfulAt },
      localPlaylistCount: snapshot.playlists.length,
      localCustomPlaylistCount: customCount,
      localImportedPlaylistCount: importedCount,
      localTrackCount: snapshot.playlists.reduce((acc, p) => acc + p.tracks.length, 0),
      pendingMutationCount: syncData?.queue.length ?? 0,
      remotePlaylistCount: remoteStatus?.playlistCount ?? this.remotePlaylistCount,
      remoteTrackCount: remoteStatus?.trackCount ?? this.remoteTrackCount,
      lastSuccessfulAt
    };
  }
  activate(userId, options = {}) {
    const id = userId.trim();
    if (!id) {
      this.stop();
      return;
    }
    const enabled = options.enabled !== false;
    const autoSync = options.autoSyncEnabled !== false;
    if (this.userId === id && this.enabled === enabled && this.autoSyncEnabled === autoSync) return;
    const resumeAuto = this.userId === id && this.enabled === enabled && !this.autoSyncEnabled && autoSync;
    this.stop(false);
    this.userId = id;
    this.enabled = enabled;
    this.autoSyncEnabled = autoSync;
    const generation = this.generation;
    this.setSyncState({ phase: enabled ? "initializing" : "idle" });
    if (!enabled) {
      this.setSyncState({ phase: "idle" });
      return;
    }
    if (!autoSync && !resumeAuto) {
      this.setSyncState({ phase: "idle" });
      return;
    }
    this.initialize(id, generation).catch((err) => {
      if (this.userId !== id || this.generation !== generation) return;
      this.setSyncError(err);
      console.warn("[playlist-sync] 初始化失败，保留本地队列等待重试:", err);
    });
  }
  stop(clearState = true) {
    this.generation += 1;
    this.clearDebounceTimer();
    this.userId = null;
    this.enabled = false;
    this.autoSyncEnabled = true;
    this.syncing = false;
    this.syncRequested = false;
    this.remotePlaylistCount = null;
    this.remoteTrackCount = null;
    if (clearState) this.setSyncState({ phase: "idle", lastSuccessfulAt: null });
  }
  notifyLocalChange() {
    const userId = this.userId;
    const pending = this.getPendingMutationCount();
    this.publishState({ pendingMutationCount: pending });
    if (!userId || !this.enabled || !this.autoSyncEnabled || this.library.getActiveUserId() !== userId) return;
    this.clearDebounceTimer();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.syncNow("local-change").catch((err) => {
        console.warn("[playlist-sync] 本地变化同步失败:", err);
      });
    }, DEBOUNCE_MS$1);
  }
  resumeAfterNetworkRecovery() {
    const userId = this.userId;
    if (!userId || !this.enabled || !this.autoSyncEnabled) return;
    if (this.syncing) {
      this.syncRequested = true;
      return;
    }
    const generation = this.generation;
    this.mergeRemoteSnapshot(userId, generation).then(() => {
      if (this.userId === userId && this.generation === generation) return this.syncNow("follow-up");
    }).catch((err) => {
      if (this.userId === userId && this.generation === generation) this.setSyncError(err);
    });
  }
  async retry() {
    const userId = this.requireActiveUser();
    const generation = this.generation;
    this.setSyncState({ phase: "initializing" });
    try {
      await this.mergeRemoteSnapshot(userId, generation);
      if (this.userId !== userId || this.generation !== generation) {
        throw new PlaylistSyncError("PLAYLIST_SYNC_IDENTITY_CHANGED", "账号已切换，当前同步已取消");
      }
      await this.syncNow("manual-retry");
      return this.getStatus();
    } catch (err) {
      this.setSyncError(err);
      throw err;
    }
  }
  async pushLocalToCloud() {
    return this.runOverwrite(async (userId) => {
      const playlists = this.library.getSnapshot().playlists;
      const result = await this.account.overwritePlaylists(playlists);
      if (this.userId !== userId || this.library.getActiveUserId() !== userId) {
        throw new PlaylistSyncError("PLAYLIST_SYNC_IDENTITY_CHANGED", "账号已切换，当前同步已取消");
      }
      this.library.updateAccountSyncState(userId, {
        playlists: result.playlists,
        queue: [],
        cursor: result.cursor
      });
      this.remotePlaylistCount = result.playlists.length;
      this.remoteTrackCount = result.playlists.reduce((acc, p) => acc + p.tracks.length, 0);
      this.emitLibraryChanged();
      return this.getStatus();
    });
  }
  async pullCloudToLocal() {
    return this.runOverwrite(async (userId) => {
      const snapshot = await this.account.getPlaylistSnapshot();
      if (this.userId !== userId || this.library.getActiveUserId() !== userId) {
        throw new PlaylistSyncError("PLAYLIST_SYNC_IDENTITY_CHANGED", "账号已切换，当前同步已取消");
      }
      this.library.updateAccountSyncState(userId, {
        playlists: snapshot.playlists,
        queue: [],
        cursor: snapshot.cursor
      });
      this.remotePlaylistCount = snapshot.playlists.length;
      this.remoteTrackCount = snapshot.playlists.reduce((acc, p) => acc + p.tracks.length, 0);
      this.emitLibraryChanged();
      return this.getStatus();
    });
  }
  async initialize(userId, generation) {
    if (!this.autoSyncEnabled) {
      this.setSyncState({ phase: "idle" });
      return;
    }
    await this.mergeRemoteSnapshot(userId, generation);
    if (this.userId !== userId || this.generation !== generation) return;
    await this.syncNow("login");
  }
  async runOverwrite(fn) {
    const userId = this.requireActiveUser();
    if (this.syncing) throw new PlaylistSyncError("PLAYLIST_SYNC_BUSY", "同步正在进行中，请稍后再试");
    this.syncing = true;
    this.setSyncState({ phase: "syncing" });
    try {
      const result = await fn(userId);
      this.setSyncSuccess();
      return result;
    } catch (err) {
      this.setSyncError(err);
      throw err;
    } finally {
      this.syncing = false;
      this.syncRequested = false;
    }
  }
  requireActiveUser() {
    if (!this.userId || !this.enabled) {
      throw new PlaylistSyncError("PLAYLIST_SYNC_UNAVAILABLE", "请先登录并开启云端同步");
    }
    if (this.library.getActiveUserId() !== this.userId) {
      throw new PlaylistSyncError("PLAYLIST_SYNC_IDENTITY_CHANGED", "账号已切换，请重新打开云同步设置");
    }
    return this.userId;
  }
  async mergeRemoteSnapshot(userId, generation) {
    const snapshot = await this.account.getPlaylistSnapshot();
    if (this.userId !== userId || this.generation !== generation) return;
    let syncData = this.library.getAccountSyncData(userId);
    const guestPlaylists = this.library.getGuestPlaylists();
    if (snapshot.playlists.length === 0 && guestPlaylists.length > 0 && syncData.queue.length === 0) {
      const confirmed = await this.confirmGuestPlaylistImport(guestPlaylists.length);
      if (this.userId !== userId || this.generation !== generation) return;
      if (confirmed) this.library.enqueueGuestPlaylistImport(userId, guestPlaylists);
      syncData = this.library.getAccountSyncData(userId);
    }
    const before = this.library.getSnapshot().playlists;
    const merged = this.applyPendingMutations(snapshot.playlists, syncData.queue);
    this.library.updateAccountSyncState(userId, { playlists: merged, cursor: snapshot.cursor });
    this.remotePlaylistCount = snapshot.playlists.length;
    this.remoteTrackCount = snapshot.playlists.reduce((acc, p) => acc + p.tracks.length, 0);
    this.emitLibraryChanged(before);
  }
  applyPendingMutations(playlists, queue) {
    return queue.reduce(
      (acc, mutation) => this.applyPlaylistOperation(acc, mutation.operation, mutation.playlistId, {
        playlist: mutation.playlist,
        tracks: mutation.tracks,
        trackIds: mutation.trackIds,
        orderedTrackIds: mutation.orderedTrackIds
      }),
      clone$3(playlists)
    );
  }
  async syncNow(trigger) {
    const userId = this.userId;
    if (!userId || !this.autoSyncEnabled && trigger !== "manual-retry") return;
    if (this.syncing) {
      this.syncRequested = true;
      return;
    }
    this.syncing = true;
    const generation = this.generation;
    if ((trigger === "login" || trigger === "manual-retry") && this.syncState.phase !== "initializing") {
      this.setSyncState({ phase: "syncing" });
    }
    let succeeded = false;
    let round = 0;
    const conflictIds = /* @__PURE__ */ new Set();
    try {
      do {
        if (round >= MAX_SYNC_ROUNDS$1) {
          throw new PlaylistSyncError("PLAYLIST_SYNC_RETRY_LIMIT", "同步冲突未能自动解决，请稍后重试");
        }
        round += 1;
        this.syncRequested = false;
        if (this.userId !== userId || this.generation !== generation || this.library.getActiveUserId() !== userId) return;
        const syncData = this.library.getAccountSyncData(userId);
        const result = await this.account.syncPlaylists(syncData.cursor, syncData.queue);
        if (this.userId !== userId || this.generation !== generation || this.library.getActiveUserId() !== userId) return;
        const afterSync = this.library.getAccountSyncData(userId);
        const acceptedMutationIds = result.acceptedMutationIds || [];
        const remoteChanges = result.remoteChanges || [];
        const conflicts = result.conflicts || [];
        if (afterSync.queue.length === 0 && acceptedMutationIds.length === 0 && remoteChanges.length === 0 && conflicts.length === 0 && result.cursor === syncData.cursor) {
          continue;
        }
        const acceptedSet = new Set(acceptedMutationIds);
        const conflictByPlaylist = new Map(
          conflicts.map((c) => [c.playlistId, c])
        );
        const sentIds = new Set(syncData.queue.slice(0, 100).map((m) => m.clientMutationId));
        let queue = afterSync.queue.filter((m) => {
          const mutation = m;
          if (acceptedSet.has(mutation.clientMutationId)) return false;
          const conflict = conflictByPlaylist.get(mutation.playlistId);
          return !sentIds.has(mutation.clientMutationId) || !conflict ? true : conflict.reason === "REVISION_MISMATCH" || conflict.reason === "APPLY_FAILED" || conflict.reason === "PLAYLIST_DELETED" && mutation.origin === "guest-import";
        });
        const acceptedRevisions = result.acceptedRevisions ?? {};
        let playlists = afterSync.playlists.map((p) => ({
          ...p,
          revision: acceptedRevisions[p.id] ?? p.revision
        }));
        queue = queue.map((m) => {
          const mutation = m;
          const revision = acceptedRevisions[mutation.playlistId];
          if (revision !== void 0 && mutation.expectedRevision !== void 0) {
            return { ...mutation, expectedRevision: revision };
          }
          const conflict = conflictByPlaylist.get(mutation.playlistId);
          const conflictRevision = conflict?.playlist ? conflict.playlist.revision : void 0;
          return conflict?.reason === "REVISION_MISMATCH" && conflictRevision !== void 0 ? { ...mutation, expectedRevision: conflictRevision } : mutation;
        });
        const pendingIds = new Set(queue.map((m) => m.playlistId));
        let merged = this.applyRemoteChanges(playlists, remoteChanges, pendingIds);
        conflicts.forEach((conflict) => {
          if (conflict.reason === "PLAYLIST_NOT_FOUND" || conflict.reason === "PLAYLIST_DELETED") {
            merged = merged.filter((p) => p.id !== conflict.playlistId);
            return;
          }
          if (conflict.playlist && !pendingIds.has(conflict.playlistId)) {
            merged = this.upsertSnapshot(merged, clone$3(conflict.playlist));
          }
        });
        (result.resolvedDeletedPlaylistIds ?? []).forEach((id) => {
          if (!pendingIds.has(id)) merged = merged.filter((p) => p.id !== id);
        });
        (result.resolvedPlaylists ?? []).forEach((playlist) => {
          if (!pendingIds.has(playlist.id)) merged = this.upsertSnapshot(merged, clone$3(playlist));
        });
        this.library.updateAccountSyncState(userId, {
          playlists: merged,
          queue,
          cursor: result.cursor
        });
        this.remotePlaylistCount = merged.length;
        this.remoteTrackCount = merged.reduce((acc, p) => acc + p.tracks.length, 0);
        this.emitLibraryChanged(afterSync.playlists);
        if (conflicts.length > 0) {
          const counts = conflicts.reduce((acc, c) => {
            acc[c.reason] = (acc[c.reason] ?? 0) + 1;
            return acc;
          }, {});
          console.warn("[playlist-sync] 同步冲突:", counts);
        }
        const hardConflictIds = new Set(
          conflicts.filter(
            (c) => c.reason === "APPLY_FAILED" || c.reason === "PLAYLIST_DELETED" && queue.some(
              (m) => m.playlistId === c.playlistId && m.origin === "guest-import"
            )
          ).map((c) => c.playlistId)
        );
        hardConflictIds.forEach((id) => conflictIds.add(id));
        [...conflictIds].forEach((id) => {
          if (!queue.some((m) => m.playlistId === id)) conflictIds.delete(id);
        });
        if (queue.some((m) => !hardConflictIds.has(m.playlistId))) {
          this.syncRequested = true;
        }
      } while (this.syncRequested && this.userId === userId);
      succeeded = true;
    } catch (err) {
      this.setSyncError(err);
      console.warn("[playlist-sync] 请求失败，将在下次启动或手动同步时重试:", err);
      if (trigger === "manual-retry") throw err;
    } finally {
      this.syncing = false;
      if (succeeded && this.userId === userId) {
        if (conflictIds.size > 0) {
          this.setSyncError(
            new PlaylistSyncError(
              "PLAYLIST_SYNC_CONFLICT",
              `${conflictIds.size} 项歌单变更暂时无法同步，数据已保留在本机，可稍后重试`
            )
          );
        } else {
          this.setSyncSuccess();
        }
      }
      if (this.syncRequested && this.userId === userId) {
        this.syncNow("follow-up").catch((err) => {
          console.warn("[playlist-sync] 连续同步失败:", err);
        });
      }
    }
  }
  applyRemoteChanges(playlists, changes, pendingIds) {
    let current = playlists;
    changes.forEach((change) => {
      if (pendingIds.has(change.playlistId)) return;
      current = this.applyPlaylistOperation(
        current,
        change.operation,
        change.playlistId,
        change.payload
      );
    });
    return current;
  }
  applyPlaylistOperation(playlists, operation, playlistId, payload) {
    if (operation === "DELETE_PLAYLIST") return playlists.filter((p) => p.id !== playlistId);
    if (!payload) return playlists;
    if ("id" in payload && "name" in payload && "type" in payload && "tracks" in payload) {
      return this.upsertSnapshot(playlists, clone$3(payload));
    }
    const existing = playlists.find((p) => p.id === playlistId);
    const meta = payload.playlist;
    if (operation === "UPSERT_PLAYLIST" && meta) {
      return this.upsertSnapshot(playlists, clone$3(meta));
    }
    if (!existing && !meta) return playlists;
    const target = existing ? { ...existing, ...meta ?? {}, tracks: clone$3(existing.tracks) } : { ...meta, tracks: [] };
    let tracks = target.tracks;
    if (operation === "ADD_TRACKS") {
      const byId = new Map(tracks.map((t) => [t.id, t]));
      (payload.tracks ?? []).forEach((t) => {
        byId.set(t.id, clone$3(t));
      });
      tracks = [...byId.values()].sort((a, b) => a.sortOrder - b.sortOrder);
    } else if (operation === "REMOVE_TRACKS") {
      const removed = new Set(payload.trackIds ?? []);
      tracks = tracks.filter((t) => !removed.has(t.id));
    } else if (operation === "REPLACE_TRACKS") {
      tracks = clone$3(payload.tracks ?? []);
    }
    if (operation === "REORDER_TRACKS" || operation === "REMOVE_TRACKS") {
      const orderIndex = new Map(
        (payload.orderedTrackIds ?? []).map((id, index) => [id, index])
      );
      tracks = tracks.map((t) => ({ ...t, sortOrder: orderIndex.get(t.id) ?? t.sortOrder })).sort((a, b) => a.sortOrder - b.sortOrder);
    }
    return this.upsertSnapshot(playlists, { ...target, tracks });
  }
  upsertSnapshot(playlists, playlist) {
    return [...playlists.filter((p) => p.id !== playlist.id), clone$3(playlist)];
  }
  confirmGuestPlaylistImport(count) {
    return this.guestImportPromptHandler ? this.guestImportPromptHandler(count) : Promise.resolve(false);
  }
  setSyncState(patch) {
    this.syncState = { ...this.syncState, ...patch, pendingMutationCount: this.getPendingMutationCount() };
    this.publishState();
  }
  publishState(patch = {}) {
    this.syncState = { ...this.syncState, ...patch, pendingMutationCount: this.getPendingMutationCount() };
    const state = this.getState();
    this.stateListeners.forEach((listener) => listener(state));
  }
  setSyncError(err) {
    this.setSyncState({
      phase: "error",
      message: err instanceof Error ? err.message : "账号歌单同步失败"
    });
  }
  setSyncSuccess() {
    const completedAt = Date.now();
    const lastSuccessfulAt = new Date(completedAt).toISOString();
    const userId = this.userId;
    if (userId && this.library.getActiveUserId() === userId) {
      this.library.updateAccountSyncState(userId, { lastSuccessfulAt });
    }
    this.setSyncState({ phase: "success", completedAt, lastSuccessfulAt, message: void 0 });
  }
  getPendingMutationCount() {
    const userId = this.userId ?? this.library.getActiveUserId();
    if (!userId) return 0;
    try {
      return this.library.getAccountSyncData(userId).queue.length;
    } catch {
      return 0;
    }
  }
  emitLibraryChanged(before) {
    if (before && JSON.stringify(before) === JSON.stringify(this.library.getSnapshot().playlists)) return;
    this.libraryChangedListener?.();
  }
  clearDebounceTimer() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
class FavoriteLibraryError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "FavoriteLibraryError";
    this.code = code;
  }
}
const isObj$1 = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const clone$2 = (v) => JSON.parse(JSON.stringify(v));
const clip = (v, max) => String(v ?? "").trim().slice(0, max);
const urlOrUndef = (v) => typeof v === "string" && /^https?:\/\//i.test(v) ? v : void 0;
const SOURCE_ALIAS = /* @__PURE__ */ new Set(["wy", "kw", "tx", "kg", "mg", "bili", "local"]);
function normalizeSourceRaw(value) {
  const raw = clip(value, 16).toLowerCase();
  return raw === "qq" ? "tx" : raw || "unknown";
}
function toLegacySource(value) {
  const raw = normalizeSourceRaw(value);
  return raw === "tx" ? "qq" : SOURCE_ALIAS.has(raw) ? raw : null;
}
function favoriteIdOf(source, trackId) {
  return createHash("sha256").update(`favorite:${source}:${trackId}`).digest("hex").slice(0, 26).toUpperCase();
}
function parseDuration(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const s = value > 1e4 ? value / 1e3 : value;
    return Math.max(0, Math.round(s));
  }
  const raw = String(value ?? "").trim();
  if (!raw) return void 0;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    return Math.max(0, Math.round(n > 1e4 ? n / 1e3 : n));
  }
  const parts = raw.split(":").map(Number);
  if (!parts.some((n) => !Number.isFinite(n))) return parts.reduce((acc, n) => acc * 60 + n, 0);
  return void 0;
}
function durationLabel(seconds) {
  if (seconds === void 0 || !Number.isFinite(seconds) || seconds < 0) return void 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function timestampOf(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}
function favoriteFromInput(input, now, existing) {
  if (!isObj$1(input)) return null;
  const source = normalizeSourceRaw(input.source);
  const isLocal = source === "local";
  const trackId = clip(
    isLocal && (input.fileFingerprint || input.metadataFingerprint || input.localPath || input.path || input.localUri) || input.rid,
    128
  );
  if (!SOURCE_ALIAS.has(source) || !trackId || !clip(input.name, 255)) return null;
  return {
    id: favoriteIdOf(source, trackId),
    source,
    trackId,
    name: clip(input.name, 255) || "未知歌曲",
    artist: clip(input.artist, 255) || "未知艺术家",
    album: clip(input.album, 255) || void 0,
    coverUrl: urlOrUndef(input.pic),
    duration: parseDuration(input.duration),
    fileSize: typeof input.fileSize === "number" && Number.isFinite(input.fileSize) && input.fileSize >= 0 ? Math.floor(input.fileSize) : void 0,
    fileFingerprint: isLocal && clip(input.fileFingerprint, 64) || void 0,
    metadataFingerprint: isLocal && clip(input.metadataFingerprint, 64) || void 0,
    localUri: isLocal && clip(input.localUri || (/^(?:file|content):/i.test(input.pic || "") ? input.pic : ""), 2048) || void 0,
    localPath: isLocal && clip(input.localPath || input.path, 2048) || void 0,
    localPicture: isLocal && clip(input.localPicture || (/^file:/i.test(input.pic || "") ? input.pic : ""), 2048) || void 0,
    favoritedAt: typeof input.favoritedAt === "number" && Number.isFinite(input.favoritedAt) && input.favoritedAt > 0 ? input.favoritedAt : existing?.favoritedAt ?? now,
    revision: existing?.revision ?? 0,
    deletedAt: null,
    createdAt: existing?.createdAt,
    updatedAt: existing?.updatedAt
  };
}
function favoriteToLegacyTrack(favorite) {
  const source = toLegacySource(favorite.source);
  return !source || !favorite.trackId ? null : {
    rid: favorite.trackId,
    name: favorite.name || "未知歌曲",
    artist: favorite.artist || "未知艺术家",
    album: favorite.album,
    pic: favorite.localPicture || favorite.coverUrl,
    duration: durationLabel(favorite.duration),
    source,
    isLocal: source === "local",
    localPath: source === "local" ? favorite.localPath : void 0,
    path: source === "local" ? favorite.localPath : void 0,
    localUri: source === "local" ? favorite.localUri : void 0,
    localPicture: source === "local" ? favorite.localPicture : void 0,
    fileSize: source === "local" ? favorite.fileSize : void 0,
    fileFingerprint: source === "local" ? favorite.fileFingerprint : void 0,
    metadataFingerprint: source === "local" ? favorite.metadataFingerprint : void 0,
    favoritedAt: favorite.favoritedAt
  };
}
function normalizeFavorite(input, now = Date.now()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input;
  const source = normalizeSourceRaw(raw.source);
  const trackId = clip(raw.trackId, 128);
  const id = clip(raw.id, 26);
  if (source === "unknown" || !trackId || !id) return null;
  const revision = Number(raw.revision);
  const duration = Number(raw.duration);
  const fileSize = Number(raw.fileSize);
  return {
    id,
    source,
    trackId,
    name: clip(raw.name, 255) || "未知歌曲",
    artist: clip(raw.artist, 255) || "未知艺术家",
    album: clip(raw.album, 255) || void 0,
    coverUrl: urlOrUndef(raw.coverUrl),
    duration: Number.isFinite(duration) && duration >= 0 ? Math.floor(duration) : void 0,
    fileSize: Number.isFinite(fileSize) && fileSize >= 0 ? Math.floor(fileSize) : void 0,
    fileFingerprint: clip(raw.fileFingerprint, 64) || void 0,
    metadataFingerprint: clip(raw.metadataFingerprint, 64) || void 0,
    localUri: clip(raw.localUri, 2048) || void 0,
    localPath: clip(raw.localPath, 2048) || void 0,
    localPicture: clip(raw.localPicture, 2048) || void 0,
    favoritedAt: timestampOf(raw.favoritedAt, now),
    revision: Number.isFinite(revision) && revision >= 0 ? Math.floor(revision) : 0,
    deletedAt: typeof raw.deletedAt === "string" && raw.deletedAt ? raw.deletedAt : null,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : void 0,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : void 0
  };
}
function favoriteToPayload(favorite) {
  return {
    id: favorite.id.slice(0, 26),
    source: clip(favorite.source, 16) || "unknown",
    trackId: clip(favorite.trackId, 128) || favorite.id,
    name: clip(favorite.name, 255) || "未知歌曲",
    artist: clip(favorite.artist, 255) || "未知艺术家",
    album: favorite.album,
    coverUrl: favorite.coverUrl,
    duration: favorite.duration,
    fileSize: favorite.fileSize,
    fileFingerprint: favorite.fileFingerprint,
    metadataFingerprint: favorite.metadataFingerprint,
    localUri: favorite.localUri,
    localPath: favorite.localPath,
    localPicture: favorite.localPicture,
    favoritedAt: new Date(favorite.favoritedAt).toISOString()
  };
}
function cleanFavorites(input) {
  const list = Array.isArray(input) ? input : [];
  return list.map((item) => normalizeFavorite(item)).filter((f) => !!f);
}
const cloneFavorites = (favorites) => clone$2(favorites);
function newMutationId() {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let ts = Date.now();
  let tsPart = "";
  for (let i = 0; i < 10; i += 1) {
    tsPart = alphabet[ts % alphabet.length] + tsPart;
    ts = Math.floor(ts / alphabet.length);
  }
  let randPart = "";
  for (let i = 0; i < 16; i += 1) {
    randPart += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `${tsPart}${randPart}`.slice(0, 26);
}
function favoriteChanged(before, after) {
  if (!before) return true;
  const a = favoriteToPayload(before);
  const b = favoriteToPayload(after);
  delete a.revision;
  delete b.revision;
  return JSON.stringify(a) !== JSON.stringify(b);
}
const emptyAccount = () => ({
  hasSnapshot: false,
  favorites: [],
  queue: [],
  cursor: 0,
  lastSuccessfulAt: null
});
const emptyStore = (favorites = []) => ({
  version: 1,
  guest: { favorites },
  accounts: {}
});
class FavoriteLibrary {
  library = null;
  activeUserId = null;
  recoveryWarning = "";
  localChangeListener = null;
  userDataPath = "";
  bindUserData(userDataPath) {
    this.userDataPath = userDataPath;
  }
  get dataDirectory() {
    const base = this.userDataPath || app.getPath("userData");
    const dir = path.join(base, "data");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  get filePath() {
    return path.join(this.dataDirectory, "favorite-library-v1.json");
  }
  get legacyCachePath() {
    return path.join(this.dataDirectory, "favoriteSongs.json");
  }
  loadLegacyGuestFavorites() {
    try {
      if (!fs.existsSync(this.legacyCachePath)) return [];
      const list = JSON.parse(fs.readFileSync(this.legacyCachePath, "utf-8"));
      if (!Array.isArray(list)) return [];
      const now = Date.now();
      return list.map((item, index) => {
        if (!isObj$1(item)) return null;
        return favoriteFromInput(
          {
            rid: item.rid,
            name: item.name,
            artist: item.artist,
            album: item.album,
            pic: item.pic,
            duration: item.duration,
            source: item.source,
            favoritedAt: item.favoritedAt
          },
          now - index * 1e3
        );
      }).filter((f) => !!f);
    } catch (err) {
      console.warn("[favorite-library] 读取旧收藏缓存失败:", err);
      return [];
    }
  }
  ensureLoaded() {
    if (this.library) return this.library;
    const file = this.filePath;
    if (!fs.existsSync(file)) {
      this.library = emptyStore(this.loadLegacyGuestFavorites());
      this.writeLibrary();
      return this.library;
    }
    try {
      const json = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (!isObj$1(json)) throw new Error("收藏库根节点格式错误");
      const guest = cleanFavorites(isObj$1(json.guest) ? json.guest.favorites : []);
      const accounts = {};
      if (isObj$1(json.accounts)) {
        Object.entries(json.accounts).forEach(([userId, store]) => {
          if (!userId || !isObj$1(store)) return;
          accounts[userId] = {
            hasSnapshot: store.hasSnapshot === true,
            favorites: cleanFavorites(store.favorites),
            queue: Array.isArray(store.queue) ? clone$2(store.queue) : [],
            cursor: Number.isFinite(Number(store.cursor)) && Number(store.cursor) >= 0 ? Math.floor(Number(store.cursor)) : 0,
            lastSuccessfulAt: typeof store.lastSuccessfulAt === "string" ? store.lastSuccessfulAt : null
          };
        });
      }
      this.library = {
        version: 1,
        activeUserId: typeof json.activeUserId === "string" && json.activeUserId ? json.activeUserId : void 0,
        guest: { favorites: guest },
        accounts
      };
      this.activeUserId = this.library.activeUserId ?? null;
      return this.library;
    } catch (err) {
      this.backupCorruptedFile(file);
      this.library = emptyStore(this.loadLegacyGuestFavorites());
      this.activeUserId = null;
      this.recoveryWarning = "收藏库文件损坏，已保留损坏副本并恢复可读取的本机收藏";
      console.error("[favorite-library] 收藏库恢复失败", err);
      this.writeLibrary();
      return this.library;
    }
  }
  backupCorruptedFile(file) {
    try {
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
    } catch (err) {
      console.error("[favorite-library] 备份损坏收藏库失败", err);
    }
  }
  writeJsonAtomically(file, data) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
      try {
        fs.renameSync(tmp, file);
      } catch {
        fs.copyFileSync(tmp, file);
        fs.rmSync(tmp, { force: true });
      }
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
      }
      throw new FavoriteLibraryError(
        "FAVORITE_STORAGE_WRITE_FAILED",
        `保存收藏失败：${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  writeLibrary() {
    this.writeJsonAtomically(this.filePath, this.ensureLoaded());
  }
  writeLegacyCache(favorites) {
    const tracks = favorites.filter((f) => !f.deletedAt).map(favoriteToLegacyTrack).filter((t) => !!t);
    this.writeJsonAtomically(this.legacyCachePath, tracks);
  }
  setLocalChangeListener(listener) {
    this.localChangeListener = listener;
  }
  setActiveUser(userId) {
    const library = this.ensureLoaded();
    const id = userId?.trim() || null;
    if (id && !library.accounts[id]) library.accounts[id] = emptyAccount();
    if (this.activeUserId === id) return false;
    this.activeUserId = id;
    if (id) library.activeUserId = id;
    else delete library.activeUserId;
    this.writeLibrary();
    return true;
  }
  getActiveUserId() {
    this.ensureLoaded();
    return this.activeUserId;
  }
  ensureAccountInitialized(userId) {
    const library = this.ensureLoaded();
    const account = this.getOrCreateAccount(userId);
    if (!account.hasSnapshot) {
      account.favorites = cloneFavorites(library.guest.favorites);
      account.hasSnapshot = true;
      this.writeLibrary();
    }
  }
  getGuestFavorites() {
    return cloneFavorites(this.ensureLoaded().guest.favorites);
  }
  getActiveFavorites() {
    const library = this.ensureLoaded();
    return this.activeUserId ? cloneFavorites(this.getOrCreateAccount(this.activeUserId).favorites) : cloneFavorites(library.guest.favorites);
  }
  getAccountSyncData(userId) {
    const account = this.getOrCreateAccount(userId);
    return {
      hasSnapshot: account.hasSnapshot,
      favorites: cloneFavorites(account.favorites),
      queue: clone$2(account.queue),
      cursor: account.cursor,
      lastSuccessfulAt: account.lastSuccessfulAt ?? null
    };
  }
  updateAccountSyncState(userId, patch) {
    const account = this.getOrCreateAccount(userId);
    if (patch.hasSnapshot !== void 0) account.hasSnapshot = patch.hasSnapshot;
    if (patch.favorites) {
      account.favorites = cleanFavorites(patch.favorites);
      account.hasSnapshot = true;
    }
    if (patch.queue) account.queue = clone$2(patch.queue);
    if (patch.cursor !== void 0) {
      account.cursor = Number.isFinite(patch.cursor) && patch.cursor >= 0 ? Math.floor(patch.cursor) : 0;
    }
    if (patch.lastSuccessfulAt !== void 0) account.lastSuccessfulAt = patch.lastSuccessfulAt;
    this.writeLibrary();
  }
  replaceActiveFavorites(favorites) {
    const library = this.ensureLoaded();
    const cleaned = cleanFavorites(favorites);
    if (this.activeUserId) {
      const account = this.getOrCreateAccount(this.activeUserId);
      account.favorites = cleaned;
      account.hasSnapshot = true;
    } else {
      library.guest.favorites = cleaned;
    }
    this.writeLibrary();
    this.writeLegacyCache(cleaned);
  }
  captureRestoreState() {
    const library = this.ensureLoaded();
    const userId = this.activeUserId;
    if (!userId) {
      return { activeUserId: null, guestFavorites: cloneFavorites(library.guest.favorites) };
    }
    const account = this.getOrCreateAccount(userId);
    return {
      activeUserId: userId,
      account: clone$2({
        hasSnapshot: account.hasSnapshot,
        favorites: account.favorites,
        queue: account.queue,
        cursor: account.cursor,
        lastSuccessfulAt: account.lastSuccessfulAt ?? null
      })
    };
  }
  restoreState(state) {
    const library = this.ensureLoaded();
    if (!state.activeUserId) {
      library.guest.favorites = cleanFavorites(state.guestFavorites ?? []);
      this.activeUserId = null;
      delete library.activeUserId;
      this.writeLegacyCache(library.guest.favorites);
      this.writeLibrary();
      return;
    }
    const account = this.getOrCreateAccount(state.activeUserId);
    account.hasSnapshot = state.account?.hasSnapshot ?? false;
    account.favorites = cleanFavorites(state.account?.favorites ?? []);
    account.queue = clone$2(state.account?.queue ?? []);
    account.cursor = state.account?.cursor ?? 0;
    account.lastSuccessfulAt = state.account?.lastSuccessfulAt ?? null;
    this.activeUserId = state.activeUserId;
    library.activeUserId = state.activeUserId;
    this.writeLegacyCache(account.favorites);
    this.writeLibrary();
  }
  /** 备份整库恢复（旧缓存曲目列表） */
  replaceActiveFromBackup(input) {
    const library = this.ensureLoaded();
    const active = this.getActiveFavorites();
    const byKey = new Map(active.map((f) => [favoriteIdOf(f.source, f.trackId), f]));
    const now = Date.now();
    const seen = /* @__PURE__ */ new Set();
    const merged = [];
    input.forEach((item, index) => {
      if (!isObj$1(item)) return;
      if (String(item.rid ?? "").trim() === "") return;
      const prev = byKey.get(favoriteIdOf(normalizeSourceRaw(item.source), String(item.rid)));
      const favorite = favoriteFromInput(item, now - index * 1e3, prev);
      if (!favorite || seen.has(favorite.id)) return;
      seen.add(favorite.id);
      merged.push(favorite);
    });
    merged.sort((a, b) => b.favoritedAt - a.favoritedAt);
    if (this.activeUserId) {
      const account = this.getOrCreateAccount(this.activeUserId);
      const keptIds = new Set(merged.map((f) => f.id));
      let queue = clone$2(account.queue);
      merged.forEach((favorite) => {
        const prev = byKey.get(favoriteIdOf(favorite.source, favorite.trackId));
        if (favoriteChanged(prev, favorite)) {
          queue = this.replaceMutation(queue, {
            queueVersion: 1,
            origin: "import",
            clientMutationId: newMutationId(),
            operation: "UPSERT_FAVORITE",
            favoriteId: favorite.id,
            expectedRevision: prev && prev.revision > 0 ? prev.revision : void 0,
            favorite: { ...cloneFavorites([favorite])[0], revision: 0 },
            createdAt: Date.now()
          });
        }
      });
      active.forEach((favorite) => {
        if (keptIds.has(favorite.id)) return;
        queue = this.replaceMutation(queue, {
          queueVersion: 1,
          origin: "account-operation",
          clientMutationId: newMutationId(),
          operation: "DELETE_FAVORITE",
          favoriteId: favorite.id,
          expectedRevision: favorite.revision > 0 ? favorite.revision : void 0,
          createdAt: Date.now()
        });
      });
      account.favorites = cloneFavorites(merged);
      account.queue = queue;
      account.hasSnapshot = true;
    } else {
      library.guest.favorites = cloneFavorites(merged);
    }
    this.writeLegacyCache(merged);
    this.writeLibrary();
    return {
      identity: {
        kind: this.activeUserId ? "account" : "guest",
        userId: this.activeUserId
      },
      favorites: merged.map(favoriteToLegacyTrack).filter((t) => !!t),
      recoveryWarning: this.recoveryWarning || void 0
    };
  }
  /** 用外部曲目列表重建收藏（本机为准） */
  recordLocalFavorites(input) {
    const library = this.ensureLoaded();
    const items = Array.isArray(input) ? input : [];
    const active = this.getActiveFavorites();
    const byId = new Map(active.map((f) => [f.id, f]));
    const byKey = new Map(active.map((f) => [favoriteIdOf(f.source, f.trackId), f]));
    const now = Date.now();
    const collected = /* @__PURE__ */ new Map();
    items.forEach((item, index) => {
      if (!isObj$1(item)) return;
      const trackId = String(item.rid ?? "").trim();
      if (!trackId) return;
      const source = String(item.source ?? "wy");
      const prev = byKey.get(favoriteIdOf(normalizeSourceRaw(source), trackId));
      const favorite = favoriteFromInput(item, now - index * 1e3, prev);
      if (favorite && !collected.has(favorite.id)) collected.set(favorite.id, favorite);
    });
    const merged = [...collected.values()].sort((a, b) => b.favoritedAt - a.favoritedAt);
    if (this.activeUserId) {
      const account = this.getOrCreateAccount(this.activeUserId);
      let queue = clone$2(account.queue);
      merged.forEach((favorite) => {
        const prev = byId.get(favorite.id);
        if (favoriteChanged(prev, favorite)) {
          queue = this.replaceMutation(queue, {
            queueVersion: 1,
            origin: "account-operation",
            clientMutationId: newMutationId(),
            operation: "UPSERT_FAVORITE",
            favoriteId: favorite.id,
            expectedRevision: prev && prev.revision > 0 ? prev.revision : void 0,
            favorite,
            createdAt: Date.now()
          });
        }
      });
      byId.forEach((favorite) => {
        if (collected.has(favorite.id)) return;
        queue = this.replaceMutation(queue, {
          queueVersion: 1,
          origin: "account-operation",
          clientMutationId: newMutationId(),
          operation: "DELETE_FAVORITE",
          favoriteId: favorite.id,
          expectedRevision: favorite.revision > 0 ? favorite.revision : void 0,
          createdAt: Date.now()
        });
      });
      account.favorites = merged;
      account.queue = queue;
      account.hasSnapshot = true;
      this.writeLibrary();
      this.writeLegacyCache(merged);
      this.localChangeListener?.();
    } else {
      library.guest.favorites = merged;
      this.writeLibrary();
      this.writeLegacyCache(merged);
    }
    return this.getSnapshot();
  }
  /** 首次上传队列（登录后初始化本地收藏推送） */
  enqueueInitialUploads(userId, favorites) {
    const account = this.getOrCreateAccount(userId);
    let queue = clone$2(account.queue);
    const cleaned = cleanFavorites(favorites);
    cleaned.forEach((favorite) => {
      queue = this.replaceMutation(queue, {
        queueVersion: 1,
        origin: "import",
        clientMutationId: newMutationId(),
        operation: "UPSERT_FAVORITE",
        favoriteId: favorite.id,
        favorite: { ...cloneFavorites([favorite])[0], revision: 0 },
        createdAt: Date.now()
      });
    });
    account.favorites = cloneFavorites(cleaned);
    account.queue = queue;
    account.hasSnapshot = true;
    this.writeLibrary();
    this.writeLegacyCache(cleaned);
    return queue;
  }
  getSnapshot() {
    const library = this.ensureLoaded();
    const userId = this.activeUserId;
    return {
      identity: {
        kind: userId && library.accounts[userId] ? "account" : "guest",
        userId
      },
      favorites: this.getActiveFavorites().map(favoriteToLegacyTrack).filter((t) => !!t),
      recoveryWarning: this.recoveryWarning || void 0
    };
  }
  getOrCreateAccount(userId) {
    const library = this.ensureLoaded();
    if (!library.accounts[userId]) library.accounts[userId] = emptyAccount();
    return library.accounts[userId];
  }
  replaceMutation(queue, mutation) {
    const existing = queue.find((m) => m.favoriteId === mutation.favoriteId);
    return [
      ...queue.filter((m) => m.favoriteId !== mutation.favoriteId),
      { ...mutation, expectedRevision: existing?.expectedRevision ?? mutation.expectedRevision }
    ];
  }
}
const favoriteLibrary = new FavoriteLibrary();
function favoriteErrorInfo(err) {
  return err instanceof FavoriteLibraryError ? { code: err.code, message: err.message } : err && typeof err === "object" && typeof err.code === "string" ? {
    code: err.code,
    message: err instanceof Error ? err.message : "收藏操作失败，请稍后重试"
  } : { code: "FAVORITE_OPERATION_FAILED", message: err instanceof Error ? err.message : "收藏操作失败，请稍后重试" };
}
const clone$1 = (v) => JSON.parse(JSON.stringify(v));
const DEBOUNCE_MS = 1500;
const MAX_SYNC_ROUNDS = 1e3;
const SYNC_BATCH_MAX = 100;
class FavoriteSyncError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "FavoriteSyncError";
    this.code = code;
  }
}
class FavoriteSyncEngine {
  account;
  userId = null;
  enabled = false;
  autoSyncEnabled = true;
  generation = 0;
  debounceTimer = null;
  syncing = false;
  syncRequested = false;
  syncState = {
    phase: "idle",
    pendingMutationCount: 0,
    lastSuccessfulAt: null,
    remoteFavoriteCount: null
  };
  remoteFavoriteCount = null;
  stateListeners = /* @__PURE__ */ new Set();
  libraryChangedListener = null;
  constructor(account) {
    this.account = account;
  }
  setLibraryChangedListener(listener) {
    this.libraryChangedListener = listener;
  }
  subscribeState(listener) {
    this.stateListeners.add(listener);
    listener(this.getState());
    return () => {
      this.stateListeners.delete(listener);
    };
  }
  getState() {
    const pending = this.getPendingMutationCount();
    return { ...this.syncState, pendingMutationCount: pending };
  }
  async getStatus() {
    const userId = favoriteLibrary.getActiveUserId();
    const snapshot = favoriteLibrary.getSnapshot();
    const syncData = userId ? favoriteLibrary.getAccountSyncData(userId) : null;
    const lastSuccessfulAt = syncData?.lastSuccessfulAt ?? this.syncState.lastSuccessfulAt ?? null;
    return {
      state: { ...this.getState(), lastSuccessfulAt },
      localFavoriteCount: snapshot.favorites.length,
      pendingMutationCount: syncData?.queue.length ?? 0,
      remoteFavoriteCount: this.remoteFavoriteCount,
      lastSuccessfulAt
    };
  }
  activate(userId, options = {}) {
    const id = userId.trim();
    if (!id) {
      this.stop();
      return;
    }
    const enabled = options.enabled !== false;
    const autoSync = options.autoSyncEnabled !== false;
    if (this.userId === id && this.enabled === enabled && this.autoSyncEnabled === autoSync) return;
    const resumeAuto = this.userId === id && this.enabled === enabled && !this.autoSyncEnabled && autoSync;
    this.stop(false);
    this.userId = id;
    this.enabled = enabled;
    this.autoSyncEnabled = autoSync;
    const generation = this.generation;
    this.setSyncState({ phase: enabled ? "initializing" : "idle" });
    if (!enabled || !autoSync && !resumeAuto) {
      this.setSyncState({ phase: "idle" });
      return;
    }
    this.initialize(id, generation).catch((err) => {
      if (this.userId !== id || this.generation !== generation) return;
      this.setSyncError(err);
      console.warn("[favorite-sync] 初始化失败，保留本地队列等待重试:", err);
    });
  }
  stop(clearState = true) {
    this.generation += 1;
    this.clearDebounceTimer();
    this.userId = null;
    this.enabled = false;
    this.autoSyncEnabled = true;
    this.syncing = false;
    this.syncRequested = false;
    this.remoteFavoriteCount = null;
    if (clearState) this.setSyncState({ phase: "idle", lastSuccessfulAt: null });
  }
  notifyLocalChange() {
    const userId = this.userId;
    const pending = this.getPendingMutationCount();
    this.publishState({ pendingMutationCount: pending });
    if (!userId || !this.enabled || !this.autoSyncEnabled || favoriteLibrary.getActiveUserId() !== userId) return;
    this.clearDebounceTimer();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.syncNow("local-change").catch((err) => {
        console.warn("[favorite-sync] 本地变化同步失败:", err);
      });
    }, DEBOUNCE_MS);
  }
  resumeAfterNetworkRecovery() {
    const userId = this.userId;
    if (!userId || !this.enabled || !this.autoSyncEnabled) return;
    if (this.syncing) {
      this.syncRequested = true;
      return;
    }
    const generation = this.generation;
    this.mergeRemoteSnapshot(userId, generation).then(() => {
      if (this.userId === userId && this.generation === generation) return this.syncNow("follow-up");
    }).catch((err) => {
      if (this.userId === userId && this.generation === generation) this.setSyncError(err);
    });
  }
  async retry() {
    const userId = this.requireActiveUser();
    const generation = this.generation;
    this.setSyncState({ phase: "initializing" });
    try {
      await this.mergeRemoteSnapshot(userId, generation);
      if (this.userId !== userId || this.generation !== generation) {
        throw new FavoriteSyncError("FAVORITE_SYNC_IDENTITY_CHANGED", "账号已切换，当前同步已取消");
      }
      await this.syncNow("manual-retry");
      return this.getStatus();
    } catch (err) {
      this.setSyncError(err);
      throw err;
    }
  }
  async pushLocalToCloud() {
    return this.runOverwrite(async (userId) => {
      const favorites = favoriteLibrary.getActiveFavorites().map(favoriteToPayload);
      const result = await this.account.overwriteFavorites(favorites);
      if (this.userId !== userId || favoriteLibrary.getActiveUserId() !== userId) {
        throw new FavoriteSyncError("FAVORITE_SYNC_IDENTITY_CHANGED", "账号已切换，当前同步已取消");
      }
      favoriteLibrary.updateAccountSyncState(userId, {
        favorites: result.favorites,
        queue: [],
        cursor: result.cursor
      });
      this.remoteFavoriteCount = result.favorites.length;
      this.emitLibraryChanged();
      return this.getStatus();
    });
  }
  async pullCloudToLocal() {
    return this.runOverwrite(async (userId) => {
      const snapshot = await this.account.getFavoriteSnapshot();
      if (this.userId !== userId || favoriteLibrary.getActiveUserId() !== userId) {
        throw new FavoriteSyncError("FAVORITE_SYNC_IDENTITY_CHANGED", "账号已切换，当前同步已取消");
      }
      favoriteLibrary.replaceActiveFavorites(snapshot.favorites);
      favoriteLibrary.updateAccountSyncState(userId, {
        favorites: snapshot.favorites,
        queue: [],
        cursor: snapshot.cursor
      });
      this.remoteFavoriteCount = snapshot.favorites.length;
      this.emitLibraryChanged();
      return this.getStatus();
    });
  }
  async initialize(userId, generation) {
    if (!this.autoSyncEnabled) {
      this.setSyncState({ phase: "idle" });
      return;
    }
    favoriteLibrary.ensureAccountInitialized(userId);
    await this.mergeRemoteSnapshot(userId, generation);
    if (this.userId !== userId || this.generation !== generation) return;
    await this.syncNow("login");
  }
  async runOverwrite(fn) {
    const userId = this.requireActiveUser();
    if (this.syncing) throw new FavoriteSyncError("FAVORITE_SYNC_BUSY", "同步正在进行中，请稍后再试");
    this.syncing = true;
    this.setSyncState({ phase: "syncing" });
    try {
      const result = await fn(userId);
      this.setSyncSuccess();
      return result;
    } catch (err) {
      this.setSyncError(err);
      throw err;
    } finally {
      this.syncing = false;
      this.syncRequested = false;
    }
  }
  requireActiveUser() {
    if (!this.userId || !this.enabled) {
      throw new FavoriteSyncError("FAVORITE_SYNC_UNAVAILABLE", "请先登录并开启云端同步");
    }
    if (favoriteLibrary.getActiveUserId() !== this.userId) {
      throw new FavoriteSyncError("FAVORITE_SYNC_IDENTITY_CHANGED", "账号已切换，请重新打开云同步设置");
    }
    return this.userId;
  }
  async mergeRemoteSnapshot(userId, generation) {
    const snapshot = await this.account.getFavoriteSnapshot();
    if (this.userId !== userId || this.generation !== generation) return;
    const syncData = favoriteLibrary.getAccountSyncData(userId);
    const before = favoriteLibrary.getSnapshot().favorites;
    const merged = this.applyPendingMutations(snapshot.favorites, syncData.queue);
    favoriteLibrary.replaceActiveFavorites(merged);
    favoriteLibrary.updateAccountSyncState(userId, {
      favorites: merged,
      cursor: snapshot.cursor
    });
    this.remoteFavoriteCount = merged.length;
    this.emitLibraryChanged(before);
  }
  applyPendingMutations(favorites, queue) {
    let current = clone$1(favorites).map((f) => normalizeFavorite(f)).filter((f) => !!f);
    for (const mutation of queue) {
      const m = mutation;
      if (m.operation === "DELETE_FAVORITE") {
        current = current.filter((f) => f.id !== m.favoriteId);
        continue;
      }
      const favorite = m.favorite ? normalizeFavorite(m.favorite) : null;
      if (!favorite) continue;
      current = this.upsert(current, favorite);
    }
    return current;
  }
  async syncNow(trigger) {
    const userId = this.userId;
    if (!userId || !this.autoSyncEnabled && trigger !== "manual-retry") return;
    if (this.syncing) {
      this.syncRequested = true;
      return;
    }
    this.syncing = true;
    const generation = this.generation;
    if ((trigger === "login" || trigger === "manual-retry") && this.syncState.phase !== "initializing") {
      this.setSyncState({ phase: "syncing" });
    }
    let succeeded = false;
    let round = 0;
    const conflictIds = /* @__PURE__ */ new Set();
    try {
      do {
        if (round >= MAX_SYNC_ROUNDS) {
          throw new FavoriteSyncError("FAVORITE_SYNC_RETRY_LIMIT", "同步冲突未能自动解决，请稍后重试");
        }
        round += 1;
        this.syncRequested = false;
        if (this.userId !== userId || this.generation !== generation || favoriteLibrary.getActiveUserId() !== userId) return;
        const syncData = favoriteLibrary.getAccountSyncData(userId);
        const result = await this.account.syncFavorites(syncData.cursor, syncData.queue);
        if (this.userId !== userId || this.generation !== generation || favoriteLibrary.getActiveUserId() !== userId) return;
        const acceptedMutationIds = result.acceptedMutationIds || [];
        const remoteChanges = result.remoteChanges || [];
        const conflicts = result.conflicts || [];
        const afterSync = favoriteLibrary.getAccountSyncData(userId);
        if (afterSync.queue.length === 0 && acceptedMutationIds.length === 0 && remoteChanges.length === 0 && conflicts.length === 0 && result.cursor === syncData.cursor) {
          continue;
        }
        const acceptedSet = new Set(acceptedMutationIds);
        const conflictById = new Map(
          conflicts.map((c) => [c.favoriteId, c])
        );
        const sentIds = new Set(syncData.queue.slice(0, SYNC_BATCH_MAX).map((m) => m.clientMutationId));
        let queue = afterSync.queue.filter((m) => {
          const mutation = m;
          if (acceptedSet.has(mutation.clientMutationId)) return false;
          const conflict = conflictById.get(mutation.favoriteId);
          return !sentIds.has(mutation.clientMutationId) || !conflict ? true : conflict.reason === "REVISION_MISMATCH" || conflict.reason === "APPLY_FAILED" || conflict.reason === "FAVORITE_DELETED" && mutation.origin === "import";
        });
        const acceptedRevisions = result.acceptedRevisions ?? {};
        let favorites = afterSync.favorites.map((f) => ({
          ...f,
          revision: acceptedRevisions[f.id] ?? f.revision
        }));
        queue = queue.map((m) => {
          const mutation = m;
          const revision = acceptedRevisions[mutation.favoriteId];
          if (revision !== void 0 && mutation.expectedRevision !== void 0) {
            return { ...mutation, expectedRevision: revision };
          }
          const conflict = conflictById.get(mutation.favoriteId);
          const conflictRevision = conflict?.favorite ? conflict.favorite.revision : void 0;
          return conflict?.reason === "REVISION_MISMATCH" && conflictRevision !== void 0 ? { ...mutation, expectedRevision: conflictRevision } : mutation;
        });
        const pendingIds = new Set(queue.map((m) => m.favoriteId));
        let merged = this.applyRemoteChanges(favorites, remoteChanges, pendingIds);
        conflicts.forEach((conflict) => {
          if (conflict.reason === "FAVORITE_NOT_FOUND" || conflict.reason === "FAVORITE_DELETED") {
            merged = merged.filter((f) => f.id !== conflict.favoriteId);
            return;
          }
          if (conflict.favorite && !pendingIds.has(conflict.favoriteId)) {
            const favorite = normalizeFavorite(conflict.favorite);
            if (favorite) merged = this.upsert(merged, favorite);
          }
        });
        (result.resolvedDeletedFavoriteIds ?? []).forEach((id) => {
          if (!pendingIds.has(id)) merged = merged.filter((f) => f.id !== id);
        });
        (result.resolvedFavorites ?? []).forEach((item) => {
          const favorite = normalizeFavorite(item);
          if (favorite && !pendingIds.has(favorite.id)) merged = this.upsert(merged, favorite);
        });
        favoriteLibrary.replaceActiveFavorites(merged);
        favoriteLibrary.updateAccountSyncState(userId, {
          favorites: merged,
          queue,
          cursor: result.cursor
        });
        this.remoteFavoriteCount = merged.length;
        this.emitLibraryChanged(afterSync.favorites.map((f) => favoriteToPayload(f)));
        if (conflicts.length > 0) {
          const counts = conflicts.reduce((acc, c) => {
            acc[c.reason] = (acc[c.reason] ?? 0) + 1;
            return acc;
          }, {});
          console.warn("[favorite-sync] 同步冲突:", counts);
        }
        const hardConflictIds = new Set(
          conflicts.filter((c) => c.reason === "APPLY_FAILED").map((c) => c.favoriteId)
        );
        hardConflictIds.forEach((id) => conflictIds.add(id));
        [...conflictIds].forEach((id) => {
          if (!queue.some((m) => m.favoriteId === id)) conflictIds.delete(id);
        });
        if (queue.some((m) => !hardConflictIds.has(m.favoriteId))) {
          this.syncRequested = true;
        }
      } while (this.syncRequested && this.userId === userId);
      succeeded = true;
    } catch (err) {
      this.setSyncError(err);
      console.warn("[favorite-sync] 请求失败，将在下次启动或手动同步时重试:", err);
      if (trigger === "manual-retry") throw err;
    } finally {
      this.syncing = false;
      if (succeeded && this.userId === userId) {
        if (conflictIds.size > 0) {
          this.setSyncError(
            new FavoriteSyncError(
              "FAVORITE_SYNC_CONFLICT",
              `${conflictIds.size} 项收藏变更暂时无法同步，数据已保留在本机，可稍后重试`
            )
          );
        } else {
          this.setSyncSuccess();
        }
      }
      if (this.syncRequested && this.userId === userId) {
        this.syncNow("follow-up").catch((err) => {
          console.warn("[favorite-sync] 连续同步失败:", err);
        });
      }
    }
  }
  applyRemoteChanges(favorites, changes, pendingIds) {
    let current = favorites;
    changes.forEach((change) => {
      if (pendingIds.has(change.favoriteId)) return;
      const favorite = normalizeFavorite(change.payload ?? change);
      if (change.operation === "DELETE_FAVORITE") {
        current = current.filter((f) => f.id !== change.favoriteId);
        return;
      }
      if (favorite) current = this.upsert(current, favorite);
    });
    return current;
  }
  upsert(favorites, favorite) {
    return [...favorites.filter((f) => f.id !== favorite.id), clone$1(favorite)];
  }
  setSyncState(patch) {
    this.syncState = { ...this.syncState, ...patch, pendingMutationCount: this.getPendingMutationCount() };
    this.publishState();
  }
  publishState(patch = {}) {
    this.syncState = { ...this.syncState, ...patch, pendingMutationCount: this.getPendingMutationCount() };
    const state = this.getState();
    this.stateListeners.forEach((listener) => listener(state));
  }
  setSyncError(err) {
    this.setSyncState({
      phase: "error",
      message: err instanceof Error ? err.message : "账号收藏同步失败"
    });
  }
  setSyncSuccess() {
    const completedAt = Date.now();
    const lastSuccessfulAt = new Date(completedAt).toISOString();
    const userId = this.userId;
    if (userId && favoriteLibrary.getActiveUserId() === userId) {
      favoriteLibrary.updateAccountSyncState(userId, { lastSuccessfulAt });
    }
    this.setSyncState({ phase: "success", completedAt, lastSuccessfulAt, message: void 0 });
  }
  getPendingMutationCount() {
    const userId = this.userId ?? favoriteLibrary.getActiveUserId();
    if (!userId) return 0;
    try {
      return favoriteLibrary.getAccountSyncData(userId).queue.length;
    } catch {
      return 0;
    }
  }
  emitLibraryChanged(before) {
    if (before && JSON.stringify(before) === JSON.stringify(favoriteLibrary.getSnapshot().favorites)) return;
    this.libraryChangedListener?.();
  }
  clearDebounceTimer() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
class BackupError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "BackupError";
    this.code = code;
  }
}
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const strClip = (v, max) => String(v ?? "").trim().slice(0, max);
const BACKUP_SETTINGS_VERSION = 1;
const SCOPES = ["custom", "platform", "favorites"];
const PLATFORM_FIELDS = [
  ["wyPlaylists", "wy"],
  ["kwPlaylists", "kw"],
  ["qqPlaylists", "tx"],
  ["kgPlaylists", "kg"]
];
const DOC_KEYS = ["playlists", ...PLATFORM_FIELDS.map(([key]) => key), "favoriteSongs"];
const DAY_MS = 24 * 60 * 60 * 1e3;
const AUTO_BACKUP_KEEP = 10;
const BACKUP_FILE_MAX_BYTES = 64 * 1024 * 1024;
function displaySource(value, fallback) {
  const raw = String(value ?? "").trim().toLowerCase();
  const fixed = raw === "tx" ? "qq" : raw;
  return fixed || fallback || "wy";
}
function validId(value) {
  return normalizePlaylistId(value) || void 0;
}
function hashId(input) {
  return trackFingerprint(input);
}
function urlOrNull(value) {
  const raw = String(value ?? "").trim();
  return raw && /^https?:\/\//i.test(raw) ? raw : void 0;
}
function durationNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const s2 = value > 1e4 ? value / 1e3 : value;
    return s2 > 0 ? Math.floor(s2) : void 0;
  }
  const raw = String(value ?? "").trim();
  if (!raw) return void 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return void 0;
  const s = n > 1e4 ? n / 1e3 : n;
  return s > 0 ? Math.floor(s) : void 0;
}
function cleanScopes(input, fallback = []) {
  const list = Array.isArray(input) ? input : fallback;
  return [...new Set(list.filter((s) => SCOPES.includes(s)))];
}
function cleanIntervalDays(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(90, Math.max(1, Math.floor(n))) : 3;
}
function cleanScope(value) {
  const raw = isObj(value) ? value : {};
  return {
    custom: raw.custom === true,
    platform: raw.platform === true,
    favorites: raw.favorites === true
  };
}
function timestampLabel(date) {
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
function inferTypeFromName(fileName) {
  const base = path.basename(fileName);
  if (base.startsWith("自动备份-")) return "automatic";
  if (base.startsWith("手动备份-")) return "manual";
  if (base.startsWith("版本备份-")) return "version";
  return "import-safety";
}
function isValidBackupFileName(fileName) {
  const base = fileName.toLowerCase();
  if (!base.endsWith(".txt")) return false;
  if (fileName.includes(".tmp-")) return false;
  return /^(自动备份|手动备份|版本备份|导入前备份)-\d{8}-\d{6}\.txt$/.test(fileName);
}
class BackupService {
  allowedExternalPaths = /* @__PURE__ */ new Map();
  automaticPromise = null;
  songDownloadPathProvider = null;
  userDataPath = "";
  bindUserData(userDataPath) {
    this.userDataPath = userDataPath;
  }
  get dataDir() {
    const base = this.userDataPath || app.getPath("userData");
    const dir = path.join(base, "data");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  get settingsFilePath() {
    return path.join(this.dataDir, "backup-settings-v1.json");
  }
  get legacyDefaultBackupPath() {
    return path.join(app.getPath("downloads"), "甘露音乐", "歌单数据备份");
  }
  get defaultBackupPath() {
    try {
      const downloadDir = this.songDownloadPathProvider?.();
      if (downloadDir?.trim()) return path.resolve(downloadDir);
    } catch (err) {
      console.warn("[backup] 读取歌曲下载目录失败，使用系统下载目录", err);
    }
    return path.resolve(app.getPath("downloads"));
  }
  setSongDownloadPathProvider(provider) {
    this.songDownloadPathProvider = provider;
  }
  defaultSettings() {
    return {
      version: BACKUP_SETTINGS_VERSION,
      settings: {
        autoBackupEnabled: false,
        intervalDays: 3,
        path: this.defaultBackupPath,
        scope: { custom: true, platform: true, favorites: true }
      },
      autoStatus: {}
    };
  }
  readSettingsFile() {
    try {
      if (!fs.existsSync(this.settingsFilePath)) return this.defaultSettings();
      const json = JSON.parse(fs.readFileSync(this.settingsFilePath, "utf-8"));
      if (!isObj(json)) return this.defaultSettings();
      const settings = isObj(json.settings) ? json.settings : {};
      const autoStatus = isObj(json.autoStatus) ? json.autoStatus : {};
      return {
        version: BACKUP_SETTINGS_VERSION,
        settings: {
          autoBackupEnabled: settings.autoBackupEnabled === true,
          intervalDays: cleanIntervalDays(settings.intervalDays),
          path: this.normalizeStoredBackupPath(settings.path),
          scope: cleanScope(settings.scope)
        },
        autoStatus: {
          lastCheckAt: typeof autoStatus.lastCheckAt === "number" ? autoStatus.lastCheckAt : void 0,
          lastBackupAt: typeof autoStatus.lastBackupAt === "number" ? autoStatus.lastBackupAt : void 0,
          lastFingerprint: typeof autoStatus.lastFingerprint === "string" ? autoStatus.lastFingerprint : void 0,
          lastPath: typeof autoStatus.lastPath === "string" ? autoStatus.lastPath : void 0,
          lastError: typeof autoStatus.lastError === "string" ? autoStatus.lastError : void 0
        }
      };
    } catch (err) {
      console.warn("[backup] 读取备份设置失败，使用默认设置", err);
      return this.defaultSettings();
    }
  }
  normalizeStoredBackupPath(value) {
    const raw = strClip(value, 4096);
    if (!raw) return this.defaultBackupPath;
    const resolved = path.resolve(raw);
    const legacy = path.resolve(this.legacyDefaultBackupPath);
    const same = process.platform === "win32" ? resolved.toLowerCase() === legacy.toLowerCase() : resolved === legacy;
    return same ? this.defaultBackupPath : raw;
  }
  writeSettingsFile(data) {
    const file = this.settingsFilePath;
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ ...data, version: BACKUP_SETTINGS_VERSION }, null, 2), "utf-8");
      try {
        fs.renameSync(tmp, file);
      } catch {
        fs.copyFileSync(tmp, file);
        fs.rmSync(tmp, { force: true });
      }
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
      }
      throw new BackupError(
        "BACKUP_SETTINGS_WRITE_FAILED",
        `保存备份设置失败：${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  getSettings() {
    return clone(this.readSettingsFile().settings);
  }
  getAutoStatus() {
    return clone(this.readSettingsFile().autoStatus);
  }
  getDefaultBackupPath() {
    return this.defaultBackupPath;
  }
  getDataSummary() {
    const playlists = playlistLibrary.getSnapshot().playlists.filter((p) => !p.deletedAt);
    const custom = playlists.filter((p) => p.type === "custom");
    const imported = playlists.filter((p) => p.type === "imported");
    return {
      customPlaylistCount: custom.length,
      customSongCount: custom.reduce((acc, p) => acc + p.tracks.length, 0),
      importedPlaylistCount: imported.length,
      importedSongCount: imported.reduce((acc, p) => acc + p.tracks.length, 0),
      favoriteCount: favoriteLibrary.getSnapshot().favorites.length
    };
  }
  getStatus() {
    const data = this.readSettingsFile();
    let fileCount = 0;
    try {
      fileCount = this.listFiles().length;
    } catch {
    }
    return {
      settings: clone(data.settings),
      autoStatus: clone(data.autoStatus),
      summary: this.getDataSummary(),
      fileCount
    };
  }
  async setSettings(patch) {
    const data = this.readSettingsFile();
    const wasEnabled = data.settings.autoBackupEnabled;
    const scope = patch.scope === void 0 ? data.settings.scope : cleanScope(patch.scope);
    if (!SCOPES.some((key) => scope[key])) {
      throw new BackupError("BACKUP_SCOPE_EMPTY", "至少选择一个备份范围");
    }
    data.settings = {
      autoBackupEnabled: patch.autoBackupEnabled ?? data.settings.autoBackupEnabled,
      intervalDays: patch.intervalDays === void 0 ? data.settings.intervalDays : cleanIntervalDays(patch.intervalDays),
      path: patch.path === void 0 ? data.settings.path : strClip(patch.path, 4096) || this.defaultBackupPath,
      scope
    };
    this.writeSettingsFile(data);
    if (!wasEnabled && data.settings.autoBackupEnabled) {
      await this.runAutomaticBackup({ force: true, trigger: "settings" });
    }
    return this.getStatus();
  }
  async chooseImportPath(target) {
    const resolved = path.resolve(target);
    this.allowedExternalPaths.set(resolved, Date.now() + 10 * 60 * 1e3);
    return this.inspectFile(resolved);
  }
  toBackupSong(track) {
    return {
      rid: track.trackId,
      id: track.trackId,
      name: track.name,
      title: track.name,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
      source: displaySource(track.source),
      isLocal: track.source === "local",
      fileSize: track.fileSize,
      fileFingerprint: track.fileFingerprint,
      metadataFingerprint: track.metadataFingerprint,
      localUri: track.localUri,
      localPath: track.localPath,
      localPicture: track.localPicture,
      url: track.localUri,
      path: track.localPath,
      picture: track.localPicture,
      pic: track.localPicture || track.coverUrl,
      addedAt: track.addedAt
    };
  }
  collectPayload(scope) {
    const playlists = playlistLibrary.getSnapshot().playlists;
    const custom = scope.custom ? playlists.filter((p) => p.type === "custom" && !p.deletedAt).map((p) => ({
      name: p.name,
      image: p.coverUrl ?? null,
      songCount: p.tracks.length,
      songs: p.tracks.map((t) => this.toBackupSong(t)),
      syncId: p.id,
      syncRevision: p.revision
    })) : [];
    const imported = scope.platform ? playlists.filter((p) => p.type === "imported" && !p.deletedAt) : [];
    const platformList = (source) => imported.filter((p) => displaySource(p.source) === source).map((p) => ({
      name: p.name,
      pic: p.coverUrl ?? "",
      originalId: p.externalId,
      total: p.tracks.length,
      songList: p.tracks.map((t) => this.toBackupSong(t)),
      syncId: p.id,
      syncRevision: p.revision
    }));
    const favorites = scope.favorites ? favoriteLibrary.getSnapshot().favorites.map((f) => ({
      rid: f.rid,
      name: f.name,
      artist: f.artist,
      album: f.album,
      pic: f.pic,
      duration: f.duration,
      source: displaySource(f.source),
      favoritedAt: f.favoritedAt
    })) : [];
    return {
      playlists: custom,
      wyPlaylists: platformList("wy"),
      kwPlaylists: platformList("kw"),
      qqPlaylists: platformList("qq"),
      kgPlaylists: platformList("kg"),
      favoriteSongs: favorites
    };
  }
  fingerprint(payload, scopes) {
    return createHash("sha256").update(JSON.stringify({ includedScopes: scopes, payload })).digest("hex");
  }
  writeBackupFile(dir, fileName, document) {
    const resolved = path.resolve(dir);
    fs.mkdirSync(resolved, { recursive: true });
    const target = path.join(resolved, fileName);
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(document), "utf-8");
      try {
        fs.renameSync(tmp, target);
      } catch {
        fs.copyFileSync(tmp, target);
        fs.rmSync(tmp, { force: true });
      }
      return target;
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
      }
      throw new BackupError("BACKUP_WRITE_FAILED", `写入备份文件失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  async createBackup(input) {
    const settings = this.getSettings();
    const scopes = cleanScopes(input.scopes, cleanScopes(Object.keys(settings.scope)));
    if (!scopes.length) throw new BackupError("BACKUP_SCOPE_EMPTY", "至少选择一个备份范围");
    const scopeMap = {
      custom: scopes.includes("custom"),
      platform: scopes.includes("platform"),
      favorites: scopes.includes("favorites")
    };
    const now = input.now ?? /* @__PURE__ */ new Date();
    const payload = this.collectPayload(scopeMap);
    const prefix = input.type === "automatic" ? "自动备份-" : input.type === "manual" ? "手动备份-" : "版本备份-";
    const document = {
      backupMetadata: {
        formatVersion: 3,
        type: input.type,
        createdAt: now.toISOString(),
        appVersion: app.getVersion(),
        includedScopes: scopes
      },
      ...payload
    };
    const fileName = input.fileName || `${prefix}${timestampLabel(now)}.txt`;
    return {
      path: this.writeBackupFile(settings.path, fileName, document),
      type: input.type,
      createdAt: document.backupMetadata.createdAt,
      includedScopes: scopes
    };
  }
  listFiles(target = this.getSettings().path) {
    const resolved = path.resolve(target);
    if (!fs.existsSync(resolved)) return [];
    return fs.readdirSync(resolved, { withFileTypes: true }).filter((entry) => {
      if (!entry.isFile()) return false;
      const name = entry.name.toLowerCase();
      if (!name.endsWith(".txt") || entry.name.includes(".tmp-") || !isValidBackupFileName(entry.name)) return false;
      try {
        this.readDocument(path.join(resolved, entry.name));
        return true;
      } catch {
        return false;
      }
    }).map((entry) => {
      const file = path.join(resolved, entry.name);
      const stat = fs.statSync(file);
      return {
        name: entry.name,
        path: file,
        size: stat.size,
        modifiedAt: stat.mtimeMs,
        type: inferTypeFromName(entry.name)
      };
    }).sort((a, b) => b.modifiedAt - a.modifiedAt || b.name.localeCompare(a.name));
  }
  isInsideDirectory(target, parent) {
    const rel = path.relative(path.resolve(parent), path.resolve(target));
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  }
  canInspect(target) {
    if (this.isInsideDirectory(target, this.getSettings().path)) return true;
    const allowed = this.allowedExternalPaths.get(path.resolve(target));
    if (allowed && allowed > Date.now()) return true;
    if (allowed) this.allowedExternalPaths.delete(path.resolve(target));
    return false;
  }
  readDocument(target) {
    const resolved = path.resolve(target);
    if (!resolved.toLowerCase().endsWith(".txt")) {
      throw new BackupError("BACKUP_FILE_TYPE_INVALID", "只能读取 .txt 备份文件");
    }
    if (!fs.existsSync(resolved)) throw new BackupError("BACKUP_FILE_NOT_FOUND", "备份文件不存在");
    if (fs.statSync(resolved).size > BACKUP_FILE_MAX_BYTES) {
      throw new BackupError("BACKUP_FILE_TOO_LARGE", "备份文件超过 64 MB，无法导入");
    }
    let json;
    try {
      json = JSON.parse(fs.readFileSync(resolved, "utf-8"));
    } catch {
      throw new BackupError("BACKUP_FILE_INVALID_JSON", "备份文件不是有效的 JSON");
    }
    const document = this.validateDocument(json);
    return {
      path: resolved,
      name: path.basename(resolved),
      document,
      summary: this.summarizeDocument(document, resolved)
    };
  }
  inspectFile(target) {
    if (!this.canInspect(target)) {
      throw new BackupError("BACKUP_PATH_FORBIDDEN", "请从备份目录或文件选择器中打开备份");
    }
    const result = this.readDocument(target);
    return { path: result.path, name: result.name, summary: result.summary };
  }
  deleteFile(target) {
    const resolved = path.resolve(target);
    const settings = this.getSettings();
    if (!this.isInsideDirectory(resolved, settings.path) || path.extname(resolved).toLowerCase() !== ".txt" || path.basename(resolved).includes(".tmp-")) {
      throw new BackupError("BACKUP_DELETE_FORBIDDEN", "只能删除当前备份目录内的有效备份文件");
    }
    if (!fs.existsSync(resolved)) throw new BackupError("BACKUP_FILE_NOT_FOUND", "备份文件不存在");
    fs.rmSync(resolved);
    const data = this.readSettingsFile();
    if (data.autoStatus.lastPath && path.resolve(data.autoStatus.lastPath) === resolved) {
      data.autoStatus = {};
      this.writeSettingsFile(data);
    }
  }
  runAutomaticBackup(input) {
    return this.automaticPromise ? this.automaticPromise : this.automaticPromise = this.performAutomaticBackup(input).finally(() => {
      this.automaticPromise = null;
    });
  }
  async performAutomaticBackup(input) {
    const data = this.readSettingsFile();
    if (!data.settings.autoBackupEnabled) return this.getStatus();
    const now = input.now ?? Date.now();
    if (!input.force && data.autoStatus.lastCheckAt && now - data.autoStatus.lastCheckAt < data.settings.intervalDays * DAY_MS) {
      return this.getStatus();
    }
    const scopes = cleanScopes(Object.keys(data.settings.scope));
    const payload = this.collectPayload(data.settings.scope);
    const fingerprint = this.fingerprint(payload, scopes);
    if (!input.force && data.autoStatus.lastFingerprint === fingerprint) {
      data.autoStatus = { ...data.autoStatus, lastCheckAt: now, lastError: void 0 };
      this.writeSettingsFile(data);
      return this.getStatus();
    }
    try {
      const result = await this.createBackup({
        type: "automatic",
        scopes,
        now: new Date(now),
        fingerprint
      });
      this.pruneAutomaticBackups();
      data.autoStatus = {
        lastCheckAt: now,
        lastBackupAt: now,
        lastFingerprint,
        lastPath: result.path
      };
      this.writeSettingsFile(data);
      console.log(`[backup] ${input.trigger} 自动备份完成: ${result.path}`);
    } catch (err) {
      data.autoStatus = {
        ...data.autoStatus,
        lastCheckAt: now,
        lastError: err instanceof Error ? err.message : String(err)
      };
      this.writeSettingsFile(data);
      throw err;
    }
    return this.getStatus();
  }
  pruneAutomaticBackups() {
    this.listFiles().filter((file) => file.name.startsWith("自动备份-")).slice(AUTO_BACKUP_KEEP).forEach((file) => {
      try {
        fs.rmSync(file.path, { force: true });
      } catch (err) {
        console.warn("[backup] 清理旧自动备份失败", file.path, err);
      }
    });
  }
  async importBackup(target, scopesInput) {
    if (!this.canInspect(target)) {
      throw new BackupError("BACKUP_PATH_FORBIDDEN", "请从备份目录或文件选择器中打开备份");
    }
    const result = this.readDocument(target);
    const available = new Set(result.summary.availableScopes);
    const scopes = cleanScopes(scopesInput).filter((s) => available.has(s));
    if (!scopes.length) throw new BackupError("BACKUP_IMPORT_SCOPE_EMPTY", "请至少选择一个可导入的数据范围");
    const now = /* @__PURE__ */ new Date();
    const safety = await this.createBackup({
      type: "automatic",
      scopes: [...SCOPES],
      fileName: `导入前备份-${timestampLabel(now)}.txt`,
      now
    });
    const playlistState = playlistLibrary.captureRestoreState();
    const favoriteState = favoriteLibrary.captureRestoreState();
    try {
      if (scopes.includes("custom") || scopes.includes("platform")) {
        const playlists = [];
        const types = [];
        if (scopes.includes("custom")) {
          playlists.push(...this.convertCustomPlaylists(result.document));
          types.push("custom");
        }
        if (scopes.includes("platform")) {
          playlists.push(...this.convertPlatformPlaylists(result.document));
          types.push("imported");
        }
        playlistLibrary.replaceActiveFromBackup(playlists, types);
      }
      if (scopes.includes("favorites")) {
        const favorites = Array.isArray(result.document.favoriteSongs) ? result.document.favoriteSongs : [];
        favoriteLibrary.replaceActiveFromBackup(favorites);
      }
    } catch (err) {
      playlistLibrary.restoreState(playlistState);
      favoriteLibrary.restoreState(favoriteState);
      throw err;
    }
    return {
      summary: result.summary,
      appliedScopes: scopes,
      safetyBackupPath: safety.path
    };
  }
  validateDocument(json) {
    if (!isObj(json)) throw new BackupError("BACKUP_DOCUMENT_INVALID", "备份文件必须是 JSON 对象");
    if (!DOC_KEYS.some((key) => Array.isArray(json[key]))) {
      throw new BackupError("BACKUP_DOCUMENT_INVALID", "未找到有效的歌单备份数据");
    }
    this.validateCustomPlaylists(json.playlists);
    PLATFORM_FIELDS.forEach(([key]) => {
      if (json[key] !== void 0 && !Array.isArray(json[key])) {
        throw new BackupError("BACKUP_DOCUMENT_INVALID", `${key} 数据格式错误`);
      }
    });
    if (json.favoriteSongs !== void 0 && !Array.isArray(json.favoriteSongs)) {
      throw new BackupError("BACKUP_DOCUMENT_INVALID", "favoriteSongs 数据格式错误");
    }
    if (json.backupMetadata !== void 0 && !isObj(json.backupMetadata)) {
      throw new BackupError("BACKUP_DOCUMENT_INVALID", "备份元数据格式错误");
    }
    if (isObj(json.backupMetadata)) {
      const meta = json.backupMetadata;
      const version = meta.formatVersion;
      if (version !== void 0 && version !== 1 && version !== 2 && version !== 3) {
        throw new BackupError("BACKUP_VERSION_UNSUPPORTED", `暂不支持该备份格式版本：${String(version)}`);
      }
      if (version === 2 || version === 3) {
        DOC_KEYS.forEach((key) => {
          if (!Array.isArray(json[key])) {
            throw new BackupError("BACKUP_DOCUMENT_INVALID", `新格式备份缺少 ${key} 数据`);
          }
        });
      }
      if (version === 3) {
        const scopes = cleanScopes(meta.includedScopes);
        if (!Array.isArray(meta.includedScopes) || !scopes.length) {
          throw new BackupError("BACKUP_DOCUMENT_INVALID", "版本 3 备份缺少有效的 includedScopes 数据");
        }
      }
    }
    return json;
  }
  validateCustomPlaylists(input) {
    if (input === void 0) return;
    if (!Array.isArray(input)) throw new BackupError("BACKUP_DOCUMENT_INVALID", "playlists 数据格式错误");
    const seen = /* @__PURE__ */ new Set();
    input.forEach((item, index) => {
      if (!isObj(item) || !strClip(item.name, 120)) {
        throw new BackupError("BACKUP_DOCUMENT_INVALID", `自建歌单数据格式错误（第 ${index + 1} 项）`);
      }
      const name = strClip(item.name, 120);
      if (seen.has(name)) {
        throw new BackupError("BACKUP_DOCUMENT_INVALID", `备份中存在重复歌单：${name}`);
      }
      seen.add(name);
      if (item.songs !== void 0 && !Array.isArray(item.songs)) {
        throw new BackupError("BACKUP_DOCUMENT_INVALID", `歌单“${name}”的歌曲数据格式错误`);
      }
    });
  }
  inferScopes(document, version) {
    if (version === 3 && isObj(document.backupMetadata)) {
      return cleanScopes(document.backupMetadata.includedScopes);
    }
    if (version === 2) return [...SCOPES];
    const scopes = [];
    if (Array.isArray(document.playlists)) scopes.push("custom");
    if (PLATFORM_FIELDS.some(([key]) => Array.isArray(document[key]))) scopes.push("platform");
    return scopes;
  }
  summarizeDocument(document, filePath) {
    const meta = isObj(document.backupMetadata) ? document.backupMetadata : {};
    const version = typeof meta.formatVersion === "number" ? meta.formatVersion : void 0;
    const scopes = this.inferScopes(document, version);
    const scopeSet = new Set(scopes);
    const customPlaylists = scopeSet.has("custom") && Array.isArray(document.playlists) ? document.playlists.filter(isObj) : [];
    const importedCounts = {
      wy: scopeSet.has("platform") && Array.isArray(document.wyPlaylists) ? document.wyPlaylists.length : 0,
      kw: scopeSet.has("platform") && Array.isArray(document.kwPlaylists) ? document.kwPlaylists.length : 0,
      qq: scopeSet.has("platform") && Array.isArray(document.qqPlaylists) ? document.qqPlaylists.length : 0,
      kg: scopeSet.has("platform") && Array.isArray(document.kgPlaylists) ? document.kgPlaylists.length : 0
    };
    const favoriteCount = scopeSet.has("favorites") && Array.isArray(document.favoriteSongs) ? document.favoriteSongs.filter(isObj).length : 0;
    return {
      type: meta.type === "manual" || meta.type === "automatic" || meta.type === "version" ? meta.type : inferTypeFromName(path.basename(filePath)),
      createdAt: typeof meta.createdAt === "string" ? meta.createdAt : void 0,
      appVersion: typeof meta.appVersion === "string" ? meta.appVersion : void 0,
      formatVersion: version,
      customPlaylistCount: customPlaylists.length,
      customSongCount: customPlaylists.reduce(
        (acc, p) => acc + (Array.isArray(p.songs) ? p.songs.length : 0),
        0
      ),
      importedPlaylistCounts: importedCounts,
      importedPlaylistCount: importedCounts.wy + importedCounts.kw + importedCounts.qq + importedCounts.kg,
      favoriteCount,
      isLegacy: version === void 0,
      includedScopes: scopes,
      availableScopes: scopes
    };
  }
  convertTrack(item, playlistSeed, fallbackSource, sortOrder) {
    if (!isObj(item)) return null;
    const source = displaySource(item.source, fallbackSource);
    const trackId = strClip(item.rid ?? item.trackId ?? item.id ?? item.musicId ?? item.songId, 512);
    const name = strClip(item.name ?? item.title, 255);
    if (!trackId || !name) return null;
    return {
      id: validId(item.syncTrackId) || hashId(`track:${playlistSeed}:${source}:${trackId}`),
      source,
      trackId,
      name,
      artist: strClip(item.artist, 255) || "未知艺术家",
      album: strClip(item.album, 255) || void 0,
      coverUrl: urlOrNull(item.pic ?? item.cover ?? item.picture ?? item.coverUrl),
      duration: durationNumber(item.duration),
      fileSize: typeof item.fileSize === "number" ? item.fileSize : typeof item.size === "number" ? item.size : void 0,
      fileFingerprint: strClip(item.fileFingerprint, 64) || void 0,
      metadataFingerprint: strClip(item.metadataFingerprint, 64) || void 0,
      sortOrder,
      localUri: strClip(item.localUri ?? item.url, 2048) || void 0,
      localPath: strClip(item.localPath ?? item.path, 2048) || void 0,
      localPicture: strClip(item.localPicture ?? item.picture ?? item.pic, 2048) || void 0,
      addedAt: typeof item.addedAt === "string" && item.addedAt ? item.addedAt : void 0,
      localData: item.isLocal === true && isObj(item) ? clone(item) : void 0
    };
  }
  convertCustomPlaylists(document) {
    if (!Array.isArray(document.playlists)) return [];
    const seen = /* @__PURE__ */ new Set();
    return document.playlists.flatMap((item, index) => {
      if (!isObj(item)) return [];
      const name = strClip(item.name, 120);
      if (!name || seen.has(name)) return [];
      seen.add(name);
      const id = validId(item.syncId) || hashId(`custom:${name}`);
      const tracks = (Array.isArray(item.songs) ? item.songs : []).map((song, order) => this.convertTrack(song, id, "wy", order)).filter((t) => !!t);
      return [
        {
          id,
          name,
          type: "custom",
          coverUrl: urlOrNull(item.image ?? item.pic) ?? tracks.find((t) => t.coverUrl)?.coverUrl,
          sortOrder: index,
          revision: 0,
          tracks,
          deletedAt: null,
          createdAt: (/* @__PURE__ */ new Date()).toISOString(),
          updatedAt: (/* @__PURE__ */ new Date()).toISOString()
        }
      ];
    });
  }
  convertPlatformPlaylists(document) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    let sortOrder = 0;
    return PLATFORM_FIELDS.flatMap(
      ([key, source]) => Array.isArray(document[key]) ? document[key].flatMap((item) => {
        if (!isObj(item)) return [];
        const name = strClip(item.name, 120);
        if (!name) return [];
        const externalId = strClip(item.originalId ?? item.externalId ?? item.id ?? name, 512);
        const id = validId(item.syncId) || hashId(`imported:${source}:${externalId}`);
        const rawTracks = Array.isArray(item.songList) ? item.songList : Array.isArray(item.songs) ? item.songs : [];
        const tracks = rawTracks.map((song, order) => this.convertTrack(song, id, source, order)).filter((t) => !!t);
        return [
          {
            id,
            name,
            type: "imported",
            source,
            externalId,
            coverUrl: urlOrNull(item.pic ?? item.image ?? item.coverUrl) ?? tracks.find((t) => t.coverUrl)?.coverUrl,
            sortOrder: sortOrder++,
            revision: 0,
            tracks,
            deletedAt: null,
            createdAt: now,
            updatedAt: now
          }
        ];
      }) : []
    );
  }
}
const backupService = new BackupService();
const AUDIO_EXTENSIONS = /* @__PURE__ */ new Set([
  ".aac",
  ".aiff",
  ".ape",
  ".flac",
  ".m4a",
  ".mp3",
  ".mp4",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".wma",
  ".wv"
]);
const SCAN_TICK_MS = 80;
const COVER_CACHE_MAX = 120;
const COVER_MAX_BYTES = 6 * 1024 * 1024;
const AUDIO_EXT_RE = /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/;
function isAudioFile(filePath) {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
function pathKey(p) {
  return process.platform === "win32" ? p.toLowerCase() : p;
}
function isPathInside(parent, child) {
  const a = path.resolve(parent);
  const b = path.resolve(child);
  if (process.platform === "win32") {
    const lower = (v) => v.toLowerCase();
    return lower(b).startsWith(lower(a) + path.sep) || lower(a) === lower(b);
  }
  return b.startsWith(a + path.sep) || a === b;
}
function readAudioMeta(filePath) {
  const taglib = require2("node-taglib-sharp");
  let file = null;
  try {
    file = taglib.File.createFromPath(filePath);
    const tag = file.tag;
    const props = file.properties;
    const durationMs = Number(
      props.durationMilliseconds ?? Number(props.duration?.totalSeconds || 0) * 1e3
    );
    const lyric = String(tag.lyrics || "").replace(/^\uFEFF/, "").trim();
    return {
      title: String(tag.title || "").trim(),
      artist: Array.isArray(tag.performers) ? tag.performers.join(" / ").trim() : String(tag.performers || "").trim(),
      album: String(tag.album || "").trim(),
      duration: Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1e3 : 0,
      hasCover: Array.isArray(tag.pictures) && tag.pictures.length > 0,
      lyric
    };
  } finally {
    try {
      file?.dispose?.();
    } catch {
    }
  }
}
function readLocalAudioMetadata(rawPath) {
  const fail = (message) => ({
    success: false,
    lyric: "",
    title: "",
    artist: "",
    album: "",
    lyricSource: "none",
    message
  });
  if (typeof rawPath !== "string" || !path.isAbsolute(rawPath)) return fail("无效的本地音频路径");
  const filePath = path.normalize(rawPath);
  try {
    if (!fs.statSync(filePath).isFile()) return fail("本地音频不存在");
  } catch {
    return fail("本地音频不存在");
  }
  if (!AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return fail("不支持读取该音频格式");
  let meta = null;
  let metaError;
  try {
    meta = readAudioMeta(filePath);
  } catch (err) {
    metaError = err;
  }
  const embedded = meta?.lyric || "";
  const embeddedValid = AUDIO_EXT_RE.test(embedded);
  const sidecar = embeddedValid ? "" : findSidecarLyric(filePath);
  const lyric = embeddedValid ? embedded : sidecar;
  const lyricSource = embeddedValid ? "embedded" : sidecar ? "sidecar" : "none";
  return {
    success: true,
    lyric,
    title: meta?.title || "",
    artist: meta?.artist || "",
    album: meta?.album || "",
    lyricSource,
    ...lyric ? {} : { message: metaError instanceof Error ? metaError.message : "未找到内嵌或同名歌词" }
  };
}
function findSidecarLyric(audioPath) {
  const dir = path.dirname(audioPath);
  const base = path.basename(audioPath, path.extname(audioPath)).toLowerCase();
  let candidates = [];
  try {
    candidates = fs.readdirSync(dir, { withFileTypes: true }).filter(
      (entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".lrc" && path.basename(entry.name, path.extname(entry.name)).toLowerCase() === base
    ).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
  } catch {
    return "";
  }
  for (const name of candidates) {
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
      const buf = fs.readFileSync(file);
      const text = decodeText(buf);
      if (AUDIO_EXT_RE.test(text)) return text;
    } catch {
    }
  }
  return "";
}
function decodeText(buf) {
  if (buf[0] === 255 && buf[1] === 254) return buf.toString("utf16le").replace(/^\uFEFF/, "").trim();
  if (buf[0] === 254 && buf[1] === 255) {
    return Buffer.from(buf).swap16().toString("utf16le").replace(/^\uFEFF/, "").trim();
  }
  return buf.toString("utf8");
}
const emptyProgress = () => ({ phase: "idle", processed: 0, total: 0, added: 0, updated: 0, reused: 0 });
function songIdOf(filePath) {
  return createHash("sha1").update(filePath).digest("hex").slice(0, 20);
}
function secondsToClock$1(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function parseFileName(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const parts = base.split(" - ");
  if (parts.length > 1) {
    return { artist: parts[0].trim(), name: parts.slice(1).join(" - ").trim() };
  }
  return { name: base.trim(), artist: "" };
}
function normalizeSong(input) {
  if (!input || typeof input !== "object") return null;
  const raw = input;
  const songPath = String(raw.path ?? "").trim();
  if (!songPath || !path.isAbsolute(songPath)) return null;
  const duration = Number(raw.duration);
  return {
    id: String(raw.id ?? songIdOf(songPath)),
    path: songPath,
    url: String(raw.url ?? pathToFileURL(songPath).href),
    name: String(raw.name ?? ""),
    artist: String(raw.artist ?? ""),
    album: String(raw.album ?? ""),
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    durationText: String(raw.durationText ?? ""),
    format: String(raw.format ?? ""),
    size: Number(raw.size) || 0,
    modifiedAt: Number(raw.modifiedAt) || 0,
    hasCover: raw.hasCover === true
  };
}
class LocalMusicLibrary {
  store = null;
  scanning = false;
  progress = emptyProgress();
  coverCache = /* @__PURE__ */ new Map();
  userDataPath = "";
  bindUserData(userDataPath) {
    this.userDataPath = userDataPath;
  }
  getStorePath() {
    const base = this.userDataPath || app.getPath("userData");
    const dir = path.join(base, "data");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, "local-music-library.json");
  }
  loadStore() {
    if (this.store) return this.store;
    const file = this.getStorePath();
    let raw = {};
    try {
      if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      console.warn("[local-music] 读取索引失败", err);
    }
    const directories = [
      ...new Set(
        (Array.isArray(raw.directories) ? raw.directories : []).filter((d) => typeof d === "string" && path.isAbsolute(d)).map((d) => path.normalize(d))
      )
    ];
    const songs = (Array.isArray(raw.songs) ? raw.songs : []).map((s) => normalizeSong(s)).filter((s) => !!s);
    this.store = { version: 1, directories, songs };
    return this.store;
  }
  saveStore() {
    const store = this.loadStore();
    fs.writeFileSync(this.getStorePath(), JSON.stringify(store, null, 2), "utf8");
  }
  sendProgress(webContents, progress) {
    if (!webContents || webContents.isDestroyed()) return;
    webContents.send("local-music-scan-progress", progress);
  }
  getState() {
    const store = this.loadStore();
    return {
      directories: [...store.directories],
      songs: store.songs.map((s) => ({ ...s })),
      scanning: this.scanning,
      progress: { ...this.progress }
    };
  }
  addDirectories(inputs) {
    const store = this.loadStore();
    const map = new Map(store.directories.map((d) => [pathKey(d), d]));
    for (const input of inputs) {
      if (typeof input !== "string" || !path.isAbsolute(input)) continue;
      try {
        if (!fs.statSync(input).isDirectory()) continue;
      } catch {
        continue;
      }
      const normalized = path.normalize(input);
      map.set(pathKey(normalized), normalized);
    }
    store.directories = [...map.values()];
    this.saveStore();
    return this.getState();
  }
  removeDirectory(input) {
    const store = this.loadStore();
    const key = pathKey(String(input ?? ""));
    store.directories = store.directories.filter((d) => pathKey(d) !== key);
    store.songs = store.songs.filter((song) => store.directories.some((dir) => isPathInside(dir, song.path)));
    this.saveStore();
    return this.getState();
  }
  clear() {
    const store = this.loadStore();
    store.directories = [];
    store.songs = [];
    this.coverCache.clear();
    this.saveStore();
    return this.getState();
  }
  async scan(webContents) {
    if (this.scanning) return this.getState();
    const store = this.loadStore();
    this.scanning = true;
    this.progress = { ...emptyProgress(), phase: "scanning" };
    this.sendProgress(webContents, this.progress);
    try {
      const validDirs = [];
      for (const dir of store.directories) {
        try {
          if (fs.statSync(dir).isDirectory()) validDirs.push(dir);
        } catch {
        }
      }
      store.directories = validDirs;
      if (validDirs.length === 0) {
        store.songs = [];
        this.saveStore();
        this.progress = { ...emptyProgress(), phase: "completed" };
        this.sendProgress(webContents, this.progress);
        this.scanning = false;
        return this.getState();
      }
      const files = await this.collectAudioFiles(validDirs);
      const existing = new Map(store.songs.map((s) => [pathKey(s.path), s]));
      const merged = [];
      let processed = 0;
      let added = 0;
      let updated = 0;
      let reused = 0;
      let lastTick = 0;
      this.progress = { ...this.progress, total: files.length };
      this.sendProgress(webContents, this.progress);
      for (const file of files) {
        let stat;
        try {
          stat = await fsp.stat(file);
        } catch {
          processed += 1;
          continue;
        }
        if (!stat.isFile() || stat.size <= 0) {
          processed += 1;
          continue;
        }
        const modifiedAt = Math.floor(stat.mtimeMs);
        const prev = existing.get(pathKey(file));
        if (prev && prev.size === stat.size && prev.modifiedAt === modifiedAt) {
          merged.push(prev);
          reused += 1;
        } else {
          let meta = null;
          try {
            meta = readAudioMeta(file);
          } catch {
          }
          const parsed = parseFileName(file);
          const duration = Number(meta?.duration || prev?.duration || 0);
          merged.push(
            normalizeSong({
              id: songIdOf(file),
              path: file,
              url: pathToFileURL(file).href,
              name: meta?.title || prev?.name || parsed.name,
              artist: meta?.artist || prev?.artist || parsed.artist || "未知艺术家",
              album: meta?.album || prev?.album || "",
              duration,
              durationText: secondsToClock$1(duration),
              format: path.extname(file).slice(1).toUpperCase(),
              size: stat.size,
              modifiedAt,
              hasCover: (meta?.hasCover ?? prev?.hasCover) === true
            })
          );
          if (prev) updated += 1;
          else added += 1;
        }
        processed += 1;
        const now = Date.now();
        if (now - lastTick >= SCAN_TICK_MS) {
          lastTick = now;
          this.progress = {
            phase: "scanning",
            processed,
            total: files.length,
            added,
            updated,
            reused
          };
          this.sendProgress(webContents, this.progress);
        }
        if (processed % 8 === 0) await new Promise((resolve) => setImmediate(resolve));
      }
      merged.sort((a, b) => {
        const artistCompare = a.artist.localeCompare(b.artist, "zh-CN", { numeric: true, sensitivity: "base" });
        return artistCompare !== 0 ? artistCompare : a.name.localeCompare(b.name, "zh-CN", { numeric: true, sensitivity: "base" });
      });
      store.songs = merged;
      this.saveStore();
      this.progress = { phase: "completed", processed, total: files.length, added, updated, reused };
      this.sendProgress(webContents, this.progress);
      this.scanning = false;
      return this.getState();
    } catch (err) {
      const message = err instanceof Error ? err.message : "扫描本地音乐失败";
      this.progress = { ...this.progress, phase: "error", message };
      this.sendProgress(webContents, this.progress);
      this.scanning = false;
      return this.getState();
    } finally {
      this.scanning = false;
    }
  }
  getCover(songId) {
    const song = this.loadStore().songs.find((s) => s.id === songId);
    if (!song || !song.hasCover) return "";
    const cached = this.coverCache.get(song.id);
    if (cached && cached.mtimeMs === song.modifiedAt) return cached.dataUrl;
    let dataUrl = "";
    const taglib = require2("node-taglib-sharp");
    let file = null;
    try {
      file = taglib.File.createFromPath(song.path);
      const picture = file?.tag?.pictures?.[0];
      if (picture?.data) {
        const bytes = Buffer.from(picture.data.toByteArray());
        if (bytes.length > 0 && bytes.length <= COVER_MAX_BYTES) {
          dataUrl = `data:${picture.mimeType || "image/jpeg"};base64,${bytes.toString("base64")}`;
        }
      }
    } catch {
      dataUrl = "";
    } finally {
      try {
        file?.dispose?.();
      } catch {
      }
    }
    this.coverCache.set(song.id, { mtimeMs: song.modifiedAt, dataUrl });
    if (this.coverCache.size > COVER_CACHE_MAX) {
      const firstKey = this.coverCache.keys().next().value;
      if (typeof firstKey === "string") this.coverCache.delete(firstKey);
    }
    return dataUrl;
  }
  async collectAudioFiles(dirs) {
    const found = /* @__PURE__ */ new Map();
    const walk = async (dir) => {
      let entries = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === ".Trash" || entry.name === "@eaDir") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (entry.isFile() && isAudioFile(full)) found.set(pathKey(full), full);
      }
      await new Promise((resolve) => setImmediate(resolve));
    };
    for (const dir of dirs) await walk(dir);
    return [...found.values()].sort((a, b) => a.localeCompare(b, void 0, { numeric: true, sensitivity: "base" }));
  }
}
const localMusicLibrary = new LocalMusicLibrary();
const BILI_SOURCE = "bili";
const BILI_LEVEL = "bili192";
const BILI_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const SEARCH_PAGE_SIZE = 30;
const DETAIL_CONCURRENCY = 4;
const SESSION_CACHE_MIN = 5;
class BiliHttpError extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.name = "BiliHttpError";
    this.status = status;
  }
}
let buvid = null;
const searchSessions = /* @__PURE__ */ new Map();
function clearSearchSessions() {
  searchSessions.clear();
}
function formEncode(obj) {
  return Object.entries(obj).filter(([, v]) => v !== void 0).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v ?? ""))}`).join("&");
}
async function biliFetch(url, init = {}, timeoutMs = 12e3) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new BiliHttpError(res.status, `哔哩哔哩请求失败（HTTP ${res.status}）`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("哔哩哔哩返回了无法解析的数据");
    }
  } finally {
    clearTimeout(timer);
  }
}
function httpsPic(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (raw.startsWith("//")) return `https:${raw}`;
  return raw.replace(/^http:\/\//i, "https://");
}
function cleanText(input) {
  const entities = {
    "&amp;": "&",
    "&quot;": '"',
    "&#39;": "'",
    "&lt;": "<",
    "&gt;": ">",
    "&nbsp;": " "
  };
  return String(input || "").replace(/<em[^>]*>/gi, "").replace(/<\/em>/gi, "").replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))).replace(/&(amp|quot|#39|lt|gt|nbsp);/g, (m) => entities[m] || m).trim();
}
function durationToSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const parts = String(value || "").split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
function secondsToClock(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor(sec % 3600 / 60);
  const s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function trackKey(bvid, cid) {
  return `bili:${String(bvid || "").trim()}:${String(cid || "").trim()}`;
}
function parseBiliId(id) {
  const m = String(id || "").trim().match(/^bili:(BV[0-9A-Za-z]+):?(\d+)?$/i);
  if (!m) throw new Error("哔哩哔哩歌曲 ID 无效");
  return { bvid: m[1], cid: m[2] || void 0 };
}
async function fetchBuvid(force = false) {
  if (!force && buvid) return buvid;
  const res = await biliFetch("https://api.bilibili.com/x/frontend/finger/spi", {
    headers: { "User-Agent": BILI_UA }
  });
  const data = res?.data;
  const b3 = String(data?.b_3 || "").trim();
  const b4 = String(data?.b_4 || "").trim();
  if (!b3 || !b4) throw new Error("无法获取哔哩哔哩匿名设备标识");
  buvid = { buvid3: b3, buvid4: b4, updatedAt: Date.now() };
  return buvid;
}
async function buvidCookie(force = false) {
  const pair = await fetchBuvid(force);
  return `buvid3=${pair.buvid3}; buvid4=${pair.buvid4}`;
}
function biliBaseHeaders() {
  return {
    "User-Agent": BILI_UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
  };
}
async function fetchView(bvid) {
  const res = await biliFetch(`https://api.bilibili.com/x/web-interface/view?${formEncode({ bvid })}`, {
    headers: { ...biliBaseHeaders(), Referer: `https://www.bilibili.com/video/${bvid}` }
  });
  if (res?.code !== 0 || !res.data) throw new Error(String(res?.message || "无法获取哔哩哔哩视频详情"));
  return res.data;
}
async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
function buildTrack(item, view, page) {
  const bvid = String(item?.bvid || view?.bvid || "").trim();
  const cid = String(page?.cid || item?.cid || view?.cid || "").trim();
  const rawTitle = cleanText(item?.title || view?.title || "未知视频");
  const part = cleanText(page?.part || "");
  const name = Array.isArray(view?.pages) && view.pages.length > 1 && part ? `${part} · ${rawTitle}` : rawTitle;
  const seconds = Number(page?.duration ?? item?.duration ?? view?.duration ?? 0);
  const artist = cleanText(item?.author || item?.owner?.name || view?.owner?.name || "未知UP主");
  const pic = httpsPic(item?.pic || view?.pic);
  return {
    rid: trackKey(bvid, cid),
    id: trackKey(bvid, cid),
    musicId: trackKey(bvid, cid),
    source: BILI_SOURCE,
    name,
    title: name,
    artist,
    singer: artist,
    album: "哔哩哔哩",
    pic,
    cover: pic,
    duration: secondsToClock(durationToSeconds(seconds)),
    durationSeconds: durationToSeconds(seconds),
    bvid,
    cid,
    levels: [BILI_LEVEL],
    quality: [{ size: "", quality: "高品质音质", level: BILI_LEVEL }]
  };
}
async function doSearch(keyword, page, refresh) {
  const cookie = await buvidCookie(refresh);
  const query = formEncode({
    context: "",
    page: Math.max(1, page),
    order: "",
    page_size: SEARCH_PAGE_SIZE,
    keyword,
    duration: "",
    tids_1: "",
    tids_2: "",
    __refresh__: true,
    _extra: "",
    highlight: 1,
    single_column: 0,
    platform: "pc",
    from_source: "",
    search_type: "video",
    dynamic_offset: 0
  });
  return biliFetch(`https://api.bilibili.com/x/web-interface/search/type?${query}`, {
    headers: {
      ...biliBaseHeaders(),
      Origin: "https://search.bilibili.com",
      Referer: "https://search.bilibili.com/",
      "Sec-Fetch-Site": "same-site",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      Cookie: cookie
    }
  });
}
function newSession() {
  return {
    tracks: [],
    seenTrackIds: /* @__PURE__ */ new Set(),
    pendingGroups: [],
    nextRemotePage: 1,
    remoteTotalPages: 0,
    hasMoreRemote: true,
    lastAccessedAt: Date.now(),
    lock: Promise.resolve()
  };
}
function evictSessions() {
  if (searchSessions.size <= SESSION_CACHE_MIN) return;
  const entries = [...searchSessions.entries()].sort(
    (a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt
  );
  for (const [key] of entries.slice(0, searchSessions.size - SESSION_CACHE_MIN)) {
    searchSessions.delete(key);
  }
}
async function searchWithRetry(keyword, page) {
  let res;
  try {
    res = await doSearch(keyword, page, false);
  } catch (err) {
    if (err instanceof BiliHttpError && err.status === 412) {
      buvid = null;
      res = await doSearch(keyword, page, true);
    } else {
      throw err;
    }
  }
  if (res?.code !== 0) throw new Error(String(res?.message || "哔哩哔哩搜索失败"));
  return res;
}
async function hydrateDetails(items, expandMultiPart) {
  if (!expandMultiPart) {
    return items.map(
      (item) => String(item?.bvid || "").trim() ? { item, detail: item, pages: [], nextPageIndex: 0 } : null
    );
  }
  return mapLimited(items, DETAIL_CONCURRENCY, async (item) => {
    const bvid = String(item?.bvid || "").trim();
    if (!bvid) return null;
    try {
      const view = await fetchView(bvid);
      return {
        item,
        detail: view,
        pages: Array.isArray(view.pages) ? view.pages : [],
        nextPageIndex: 0
      };
    } catch {
      return { item, detail: item, pages: [], nextPageIndex: 0 };
    }
  });
}
function pushTrack(session2, track) {
  const key = String(track?.rid || track?.id || "").trim();
  if (!key || session2.seenTrackIds.has(key)) return;
  session2.seenTrackIds.add(key);
  session2.tracks.push(track);
}
function drainPending(session2, want, expandMultiPart) {
  while (session2.tracks.length < want && session2.pendingGroups.length > 0) {
    const group = session2.pendingGroups[0];
    const pages = expandMultiPart && group.pages.length > 0 ? group.pages : [group.pages[0]];
    const page = pages[group.nextPageIndex];
    pushTrack(session2, buildTrack(group.item, group.detail, page ?? null));
    group.nextPageIndex += 1;
    if (group.nextPageIndex >= pages.length) session2.pendingGroups.shift();
  }
}
async function fillSession(session2, keyword, want, expandMultiPart) {
  while (session2.tracks.length < want) {
    drainPending(session2, want, expandMultiPart);
    if (session2.tracks.length >= want || !session2.hasMoreRemote) break;
    const res = await searchWithRetry(keyword, session2.nextRemotePage);
    const data = res?.data;
    const items = Array.isArray(data?.result) ? data.result : [];
    const pageNo = Math.max(1, Number(data?.page || session2.nextRemotePage));
    const numPages = Math.max(0, Number(data?.numPages || 0));
    session2.remoteTotalPages = numPages;
    session2.nextRemotePage = pageNo + 1;
    session2.hasMoreRemote = items.length > 0 && (numPages > 0 ? pageNo < numPages : items.length >= SEARCH_PAGE_SIZE);
    const groups = await hydrateDetails(items, expandMultiPart);
    session2.pendingGroups.push(...groups.filter((g) => !!g));
    if (items.length === 0) break;
  }
  drainPending(session2, want, expandMultiPart);
}
async function withSessionLock(session2, fn) {
  const prev = session2.lock;
  let release = () => void 0;
  session2.lock = new Promise((resolve) => {
    release = () => resolve();
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}
async function biliSearch(keyword, page = 0, pageSize = 20, expandMultiPart = false) {
  const kw = String(keyword || "").trim();
  const pageIndex = Math.max(0, Number(page) || 0);
  if (!kw) return { data: [], page: pageIndex, hasMore: false };
  const size = Math.max(1, Math.min(50, Number(pageSize) || 20));
  const sessionKey = `${kw.toLocaleLowerCase()}:multiPart=${expandMultiPart ? 1 : 0}:limit=${size}`;
  if (pageIndex === 0) searchSessions.set(sessionKey, newSession());
  const session2 = searchSessions.get(sessionKey) || newSession();
  searchSessions.set(sessionKey, session2);
  session2.lastAccessedAt = Date.now();
  evictSessions();
  return withSessionLock(session2, async () => {
    const start = pageIndex * size;
    const end = start + size;
    await fillSession(session2, kw, end, expandMultiPart);
    session2.lastAccessedAt = Date.now();
    return {
      data: session2.tracks.slice(start, end),
      page: pageIndex,
      total: session2.tracks.length,
      totalPages: session2.remoteTotalPages,
      hasMore: session2.tracks.length > end || session2.pendingGroups.length > 0 || session2.hasMoreRemote
    };
  });
}
function collectUrls(data) {
  return [
    data?.baseUrl,
    data?.base_url,
    ...Array.isArray(data?.backupUrl) ? data.backupUrl : [],
    ...Array.isArray(data?.backup_url) ? data.backup_url : []
  ].map((u) => String(u || "").trim()).filter(Boolean);
}
async function biliResolve(trackId) {
  const parsed = parseBiliId(trackId);
  const view = await fetchView(parsed.bvid);
  const pages = Array.isArray(view?.pages) ? view.pages : [];
  const page = parsed.cid ? pages.find((p) => String(p.cid) === parsed.cid) : pages[0];
  const cid = String(parsed.cid || page?.cid || view?.cid || "").trim();
  if (!cid) throw new Error("无法获取哔哩哔哩分 P 标识");
  const cookie = await buvidCookie();
  const referer = `https://www.bilibili.com/video/${parsed.bvid}`;
  const res = await biliFetch(`https://api.bilibili.com/x/player/playurl?${formEncode({ bvid: parsed.bvid, cid, fnval: 16 })}`, {
    headers: { ...biliBaseHeaders(), Referer: referer, Cookie: cookie }
  });
  if (res?.code !== 0 || !res.data) throw new Error(String(res?.message || "无法获取哔哩哔哩播放地址"));
  const data = res.data;
  const dash = data.dash;
  const audioList = Array.isArray(dash?.audio) ? [...dash.audio] : [];
  audioList.sort((a, b) => Number(b?.bandwidth || 0) - Number(a?.bandwidth || 0));
  const audio = audioList.find((a) => Number(a?.id) === 30280) || audioList[0];
  const urls = collectUrls(audio || {});
  const fallbackUrl = String(
    data.durl?.[0]?.url || ""
  ).trim();
  const url = urls[0] || fallbackUrl;
  if (!url) throw new Error("哔哩哔哩没有返回可用音频地址");
  const part = cleanText(page?.part || "");
  const title = cleanText(view?.title || "哔哩哔哩音频");
  const name = pages.length > 1 && part ? `${part} · ${title}` : title;
  const artist = cleanText(view?.owner?.name || "未知UP主");
  const pic = httpsPic(view?.pic);
  const headers = { Referer: referer, "User-Agent": BILI_UA, Accept: "*/*" };
  return {
    code: 200,
    msg: "成功",
    data: {
      rid: trackKey(parsed.bvid, cid),
      url,
      backupUrls: urls.slice(1),
      headers,
      playbackHeaders: headers,
      mimeType: String(audio?.mimeType || "audio/mp4"),
      format: "m4a",
      level: BILI_LEVEL,
      name,
      artist,
      album: "哔哩哔哩",
      pic,
      duration: Number(page?.duration || view?.duration || 0),
      lrc: "",
      bvid: parsed.bvid,
      cid
    }
  };
}
function mgSign(timestamp, keyword) {
  const deviceId = "963B7AA0D21511ED807EE5846EC87D20";
  const raw = keyword + "6cdc72a439cef99a3418d2a78aa28c73yyapp2d16148780a1dcc7408e06336b98cfd50" + deviceId + timestamp;
  return { sign: createHash("md5").update(raw).digest("hex"), deviceId };
}
async function mgSearch(name, page = 0, limit = 30) {
  const keyword = String(name || "").trim();
  if (!keyword) return { code: 400, msg: "请提供搜索关键词", data: [] };
  const pageNo = (page ?? 0) + 1;
  const pageSize = limit ?? 30;
  const timestamp = String(Date.now());
  const { sign, deviceId } = mgSign(timestamp, keyword);
  const searchSwitch = encodeURIComponent(
    '{"song":1,"album":0,"singer":0,"tagSong":1,"mvSong":0,"bestShow":1,"songlist":0,"lyricSong":0}'
  );
  const url = `https://jadeite.migu.cn/music_search/v3/search/searchAll?` + new URLSearchParams({
    isCorrect: "0",
    isCopyright: "1",
    searchSwitch,
    pageSize: String(pageSize),
    text: keyword,
    pageNo: String(pageNo),
    sort: "0",
    sid: "USS"
  }).toString();
  try {
    const res = await fetch(url, {
      headers: {
        uiVersion: "A_music_3.6.1",
        deviceId,
        timestamp,
        sign,
        channel: "0146921",
        "User-Agent": "Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30"
      },
      signal: AbortSignal.timeout(1e4)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`请求失败，状态码: ${res.status}`);
    return JSON.parse(text);
  } catch (err) {
    throw err instanceof Error && err.name === "TimeoutError" ? new Error("请求超时") : err;
  }
}
async function mgLyric(contentId) {
  try {
    const detail = await httpGetText(
      `https://c.musicapp.migu.cn/MIGUM3.0/resource/song/by-contentids/v2.0?contentId=${contentId}`,
      {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36 Edg/113.0.1774.42",
        Referer: "http://music.migu.cn/",
        Connection: "Keep-Alive"
      }
    );
    const json = JSON.parse(detail);
    if (!json.data || json.data.length === 0) {
      console.log("未找到咪咕歌曲信息");
      return "";
    }
    const song = json.data[0];
    const albumId = song.albumId;
    if (!albumId) return "";
    const resource = JSON.parse(
      await httpGetText(
        `https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do?needSimple=01&resourceId=${albumId}&resourceType=2003`
      )
    );
    if (!resource.resource || resource.resource.length === 0 || !resource.resource[0].songItems) return "";
    const items = resource.resource[0].songItems;
    let hit = null;
    for (const item of items) {
      if (item.contentId == contentId || item.copyrightId == contentId || item.contentId == song.contentId || item.copyrightId == song.copyrightId) {
        hit = item;
        break;
      }
    }
    if (!hit || !hit.lrcUrl) {
      hit = items.find((it) => it.lrcUrl) || null;
      if (!hit) return "";
    }
    return hit.lrcUrl ? await httpGetText(hit.lrcUrl) : "";
  } catch (err) {
    console.error("getMgLyric error:", err);
    return "";
  }
}
function decodeBase64Text(input) {
  return Buffer.from(input, "base64").toString("utf8");
}
function parseLrcLine(line) {
  const m = line.match(/^\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\](.*)$/);
  if (!m) return null;
  const time = Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(`0.${m[3]}`) : 0);
  return { time, line: m[4] };
}
function normalizeLrcLine(line) {
  return line.replace(/\s+$/, "");
}
function mergeLrcWithTranslation(original, translation) {
  const transRows = [];
  for (const line of translation.split(/\r?\n/)) {
    const parsed = parseLrcLine(line);
    if (parsed) transRows.push([parsed.time, parsed.line]);
  }
  let out = "";
  for (const line of original.split(/\r?\n/)) {
    const parsed = parseLrcLine(line);
    if (!parsed) continue;
    out += normalizeLrcLine(line) + "\n";
    const hit = transRows.find(([t]) => t === parsed.time);
    if (hit) out += hit[1] + "\n";
  }
  return out;
}
async function qqLyric(songMid) {
  const mid = String(songMid ?? "").trim();
  if (!mid) return { code: 400, msg: "songMid 为空" };
  const payload = JSON.stringify({
    comm: { ct: 11, cv: 0 },
    req: {
      module: "music.musichallSong.PlayLyricInfo",
      method: "GetPlayLyricInfo",
      param: {
        format: "json",
        crypt: 0,
        ct: 11,
        cv: 0,
        interval: 0,
        lrc_t: 0,
        trans: 1,
        trans_t: 0,
        type: -1,
        songMID: mid
      }
    }
  });
  const postOnce = async (secure) => {
    const http2 = await (secure ? import("node:https") : import("node:http"));
    return new Promise((resolve, reject) => {
      const req = http2.default.request(
        {
          hostname: "u.y.qq.com",
          port: secure ? 443 : 80,
          path: "/cgi-bin/musicu.fcg",
          method: "POST",
          headers: {
            Host: "u.y.qq.com",
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            Referer: "https://y.qq.com/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36 Edg/113.0.1774.42"
          }
        },
        (res) => {
          let data2 = "";
          res.on("data", (chunk) => data2 += chunk);
          res.on("end", () => resolve(data2));
        }
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.write(payload);
      req.end();
    });
  };
  let raw;
  try {
    raw = await postOnce(false);
  } catch (err) {
    console.warn("[Main] QQ歌词 http 失败，回退 https:", err);
    try {
      raw = await postOnce(true);
    } catch (err2) {
      console.error("[Main] qq lyric request error", err2);
      return { code: 500, msg: "请求失败" };
    }
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    console.error("[Main] qq lyric parse error", err);
    return { code: 500, msg: "解析失败" };
  }
  const data = json?.req?.data;
  const lyricB64 = data?.lyric ? decodeBase64Text(String(data.lyric)) : "";
  const transB64 = data?.trans ? decodeBase64Text(String(data.trans)) : "";
  return {
    code: 0,
    lyric: mergeLrcWithTranslation(lyricB64, transB64),
    raw_lyric: lyricB64,
    raw_trans: transB64,
    source: "qq"
  };
}
async function wyLyricPlain(id) {
  console.log(`[Main] 收到歌词请求: ${id}`);
  try {
    const text = await httpGetText(
      `http://interface3.music.163.com/api/song/lyric?id=${id}&os=Linux&lv=-1&kv=-1&tv=-1`,
      {
        "User-Agent": "NeteaseMusic/1.0.22.231106171719(1000022);Dalvik/2.1.0 (Linux; U; Android 14; 22041211AC Build/UP1A.231005.007)"
      }
    );
    console.log(`[Main] 歌词请求成功，长度: ${text.length}`);
    return JSON.parse(text);
  } catch (err) {
    console.error("[Main] wy lyric parse error", err);
    return { code: 500, msg: "解析失败" };
  }
}
async function kwLyric(musicId) {
  console.log("[Main] 收到获取酷我歌词请求:", musicId);
  try {
    const text = await httpGetText(
      `https://wapi.kuwo.cn/openapi/v1/www/lyric/getlyric?musicId=${musicId}&httpsStatus=1`,
      {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36 Edg/113.0.1774.42"
      }
    );
    console.log("[Main] 酷我歌词请求成功");
    return JSON.parse(text);
  } catch (err) {
    console.error("[Main] kw lyric parse error", err);
    return { code: 500, msg: "解析失败" };
  }
}
async function kgLyric(hash) {
  const h = String(hash ?? "").trim();
  if (!h) return { code: 400, msg: "hash 为空" };
  try {
    const now = Date.now();
    const signRaw = `NVPh5oo715z5DIWAeQlhMDsWXXQV4hwtclienttime=${now}clientver=20000dfid=-hash=${h}keyword=mid=${now}srcappid=2919timelength=0NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt`;
    const signature = createHash("md5").update(signRaw).digest("hex");
    const url = `https://m3ws.kugou.com/api/v1/krc/get_lyrics?clienttime=${now}&clientver=20000&dfid=-&hash=${encodeURIComponent(h)}&keyword=&mid=${now}&srcappid=2919&timelength=0&signature=${signature}`;
    const text = await httpGetText(url, {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36 Edg/113.0.1774.42",
      Referer: "https://www.kugou.com/"
    });
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      console.error("[Main] kg lyric parse error", err);
      return { code: 500, msg: "解析失败" };
    }
    const data = json?.data;
    if (!data) return { code: 500, msg: "返回数据为空" };
    const lrc = String(data.lrc ?? "").replace(/\r/g, "");
    let trans = null;
    const landata = data.landata;
    if (Array.isArray(landata)) {
      for (const item of landata) {
        if (item?.type === 1 || item?.type === "1") {
          trans = String(item.content ?? "");
          break;
        }
      }
    }
    return {
      code: 200,
      lyric: mergeLrcWithTranslation(lrc, trans ?? ""),
      raw_lrc: lrc,
      raw_trans: trans ?? ""
    };
  } catch (err) {
    console.error("[Main] kg lyric request error", err);
    return { code: 500, msg: "请求失败" };
  }
}
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const RENDERER_DIST = app.isPackaged ? join(app.getAppPath(), "dist") : join(process.env.APP_ROOT || path.dirname(__dirname, ".."), "dist");
process.env.APP_ROOT = process.env.APP_ROOT || path.join(__dirname, "..");
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, "public") : RENDERER_DIST;
let mainWindow = null;
let tray = null;
let lyricWindow = null;
let closingToQuit = false;
let forceQuit = false;
const playbackHeaders = /* @__PURE__ */ new Map();
const downloadTasks = /* @__PURE__ */ new Map();
const downloadLastTs = /* @__PURE__ */ new Map();
const downloadLastProgress = /* @__PURE__ */ new Map();
const DOWNLOAD_START_TIMEOUT_MS = 3e4;
const DOWNLOAD_INACTIVITY_TIMEOUT_MS = 6e4;
let downloadPath = null;
const appConfigFile = () => {
  const dir = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "app-config.json");
};
const loadDownloadPath = () => {
  try {
    const file = appConfigFile();
    if (fs.existsSync(file)) {
      const json = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (json.downloadPath) downloadPath = json.downloadPath;
    }
  } catch (err) {
    console.error("加载配置文件失败:", err);
  }
};
const saveDownloadPath = () => {
  try {
    if (!downloadPath) return;
    const file = appConfigFile();
    let json = {};
    if (fs.existsSync(file)) {
      try {
        json = JSON.parse(fs.readFileSync(file, "utf-8"));
      } catch {
      }
    }
    json.downloadPath = downloadPath;
    fs.writeFileSync(file, JSON.stringify(json, null, 2));
  } catch (err) {
    console.error("保存配置文件失败:", err);
  }
};
const currentDownloadPath = () => downloadPath || app.getPath("downloads");
const gateway = new MusicGatewayClient({
  getAppVersion: () => app.getVersion(),
  getDeviceId: () => accountClient.getDeviceIdentity().id,
  getAccessTokenForGateway: () => accountClient.getAccessTokenForGateway()
});
const playlistSync = new PlaylistSyncEngine(playlistLibrary, accountClient);
const favoriteSync = new FavoriteSyncEngine(accountClient);
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#101014",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.on("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    if (forceQuit || closingToQuit) return;
    event.preventDefault();
    closingToQuit = false;
    mainWindow?.webContents.send("app-close-requested");
  });
  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url);
    return { action: "deny" };
  });
  if (VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}
function hideToTray() {
  mainWindow?.hide();
}
function ensureTray() {
  if (tray) {
    tray.focus();
    return;
  }
  const iconPath = join(process.env.VITE_PUBLIC || RENDERER_DIST, "icon.png");
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("甘露音乐");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "显示主窗口",
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        }
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          forceQuit = true;
          app.quit();
        }
      }
    ])
  );
  tray.on("double-click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}
function createLyricWindow() {
  if (lyricWindow) {
    lyricWindow.focus();
    return;
  }
  const { screen } = require2("electron");
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  lyricWindow = new BrowserWindow({
    width: 800,
    height: 200,
    x: Math.floor((width - 800) / 2),
    y: Math.floor(height * 0.7),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  lyricWindow.setBackgroundColor("#00000000");
  if (VITE_DEV_SERVER_URL) {
    void lyricWindow.loadURL(`${VITE_DEV_SERVER_URL}/desktop-lyric.html`);
  } else {
    void lyricWindow.loadFile(join(RENDERER_DIST, "desktop-lyric.html"));
  }
  lyricWindow.webContents.on("did-finish-load", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("lyric-window-opened");
  });
  lyricWindow.on("closed", () => {
    lyricWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("lyric-window-closed");
  });
}
function closeLyricWindow() {
  lyricWindow?.close();
  lyricWindow = null;
}
function cancelDownload(url, message, item) {
  const task = downloadTasks.get(url);
  if (!task || task.settled) return;
  task.settled = true;
  if (task.startTimer) clearTimeout(task.startTimer);
  if (task.inactivityTimer) clearTimeout(task.inactivityTimer);
  downloadTasks.delete(url);
  downloadLastTs.delete(url);
  downloadLastProgress.delete(url);
  try {
    if (item && item.getState() === "progressing") item.cancel();
  } catch (err) {
    console.warn("取消失败下载任务时出错:", err);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("download-error", {
      id: url,
      error: message,
      name: task.params.name,
      artist: task.params.artist,
      album: task.params.album,
      cover: task.params.cover,
      quality: task.params.quality,
      source: task.params.source,
      mediaType: task.params.mediaType || "audio"
    });
  }
  task.reject(new Error(message));
}
function sanitizeFileName(input, fallback) {
  return (String(input || "").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[. ]+$/g, "").trim() || fallback).slice(0, 120);
}
const AUDIO_EXTS = /* @__PURE__ */ new Set(["mp3", "flac", "m4a", "aac", "ogg", "wav"]);
const VIDEO_EXTS = /* @__PURE__ */ new Set(["mp4", "webm", "mkv", "mov", "m4v"]);
function startDownload(input) {
  return new Promise((resolve, reject) => {
    const url = String(input?.url || "");
    try {
      if (!input || !input.url) {
        reject(new Error("下载链接不能为空"));
        return;
      }
      const mediaType = String(input.mediaType || "audio");
      if (!input.name || mediaType === "audio" && !input.artist) {
        reject(new Error(mediaType === "mv" ? "MV 信息不完整" : "歌曲信息不完整"));
        return;
      }
      const extRaw = String(input.format || "").toLowerCase().replace(/^\./, "");
      if (mediaType === "mv" && extRaw === "m3u8") {
        reject(new Error("暂不支持下载 M3U8 分片视频"));
        return;
      }
      const task = { params: input, resolve, reject, lastBytes: 0, settled: false };
      downloadTasks.set(url, task);
      task.startTimer = setTimeout(() => {
        cancelDownload(url, "下载启动超时，下载地址可能已失效或服务器无响应");
      }, DOWNLOAD_START_TIMEOUT_MS);
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log("开始下载任务:", input.name, url);
        const headers = input.headers && typeof input.headers === "object" && !Array.isArray(input.headers) ? Object.fromEntries(
          Object.entries(input.headers).filter(([key, value]) => key.trim() && value !== void 0 && value !== null).map(([key, value]) => [key, String(value)])
        ) : void 0;
        if (headers && Object.keys(headers).length > 0) {
          mainWindow.webContents.downloadURL(url, { headers });
        } else {
          mainWindow.webContents.downloadURL(url);
        }
        mainWindow.webContents.send("download-started", {
          id: url,
          name: input.name || "未知歌曲",
          artist: input.artist || "未知艺术家",
          album: input.album || "",
          cover: input.cover || "",
          quality: input.quality || "exhigh",
          source: input.source || "",
          mediaType
        });
      } else {
        cancelDownload(url, "窗口不存在");
      }
    } catch (err) {
      cancelDownload(url, err instanceof Error ? err.message : String(err));
    }
  });
}
function setupDownloadListener() {
  session.defaultSession.on("will-download", (_event, item) => {
    const requestedUrl = item.getURL();
    const urls = /* @__PURE__ */ new Set([item.getURL(), ...item.getURLChain()]);
    let matchedUrl = "";
    for (const candidate of urls) {
      if (downloadTasks.has(candidate)) {
        matchedUrl = candidate;
        break;
      }
    }
    console.log("will-download 事件触发，URL:", requestedUrl, "任务:", matchedUrl || "未匹配");
    const task = matchedUrl ? downloadTasks.get(matchedUrl) : void 0;
    if (!task || !task.params) {
      console.log("未找到下载任务，取消下载:", requestedUrl);
      item.cancel();
      return;
    }
    console.log("找到下载任务:", task.params.name);
    if (task.startTimer) {
      clearTimeout(task.startTimer);
      task.startTimer = void 0;
    }
    const armInactivity = () => {
      if (task.inactivityTimer) clearTimeout(task.inactivityTimer);
      task.inactivityTimer = setTimeout(() => {
        cancelDownload(matchedUrl, "下载长时间没有进度，服务器可能无响应或下载地址已失效", item);
      }, DOWNLOAD_INACTIVITY_TIMEOUT_MS);
    };
    armInactivity();
    const params = task.params;
    const mediaType = String(params.mediaType || "audio");
    if (!params.name || mediaType === "audio" && !params.artist) {
      cancelDownload(matchedUrl, mediaType === "mv" ? "MV 信息不完整" : "歌曲信息不完整", item);
      return;
    }
    const targetDir = currentDownloadPath();
    let ext = String(params.format || "").toLowerCase().replace(/^\./, "");
    if (!ext) {
      try {
        ext = path.extname(new URL(String(params.url)).pathname).slice(1).toLowerCase();
      } catch {
        ext = "";
      }
    }
    const ext2 = mediaType === "mv" ? `.${VIDEO_EXTS.has(ext) ? ext : "mp4"}` : AUDIO_EXTS.has(ext) ? `.${ext}` : params.quality === "lossless" ? ".flac" : ".mp3";
    const name = sanitizeFileName(params.name, mediaType === "mv" ? "未知MV" : "未知歌曲");
    const artist = sanitizeFileName(params.artist, "未知艺术家");
    const quality = sanitizeFileName(params.quality, "默认画质");
    const fileName = mediaType === "mv" ? `${name} - ${artist} - ${quality}${ext2}` : `${name} - ${artist}${ext2}`;
    const savePath = path.join(targetDir, fileName);
    try {
      if (fs.existsSync(savePath)) {
        fs.unlinkSync(savePath);
        console.log("删除已存在文件，准备覆盖:", savePath);
      }
    } catch (err) {
      console.error("删除已有同名文件失败:", err);
    }
    item.setSavePath(savePath);
    item.on("updated", (_e, state) => {
      if (task.settled) return;
      if (state === "interrupted") {
        cancelDownload(matchedUrl, "网络连接中断，下载失败", item);
        return;
      }
      if (state !== "progressing" || !mainWindow || mainWindow.isDestroyed()) return;
      const received = item.getReceivedBytes();
      const total = item.getTotalBytes();
      if (received > task.lastBytes) {
        task.lastBytes = received;
        armInactivity();
      }
      let progress;
      if (total > 0) progress = received / total;
      else progress = Math.min(0.99, received / (received + 5 * 1024 * 1024));
      const percent = Math.round((received > 0 ? progress : 0.01) * 100);
      const now = Date.now();
      const lastTs = downloadLastTs.get(matchedUrl) ?? 0;
      const lastPercent = downloadLastProgress.get(matchedUrl) ?? -1;
      const throttled = now - lastTs < 100;
      const tinyDelta = Math.abs(percent - lastPercent) < 1;
      if (throttled && tinyDelta && percent !== 100 || percent === 0) return;
      downloadLastTs.set(matchedUrl, now);
      downloadLastProgress.set(matchedUrl, percent);
      mainWindow.webContents.send("download-progress", {
        id: matchedUrl,
        progress: percent,
        received,
        total: total || 0
      });
    });
    item.on("done", (_e, state) => {
      if (task.inactivityTimer) clearTimeout(task.inactivityTimer);
      downloadLastTs.delete(matchedUrl);
      downloadLastProgress.delete(matchedUrl);
      console.log("下载完成，状态:", state);
      if (task.settled) {
        downloadTasks.delete(matchedUrl);
        return;
      }
      task.settled = true;
      if (state === "completed") {
        const savedPath = item.getSavePath();
        console.log("文件保存路径:", savedPath);
        if (!fs.existsSync(savedPath)) {
          console.error("文件不存在:", savedPath);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("download-error", {
              id: matchedUrl,
              error: "下载的文件不存在",
              name: params.name,
              artist: params.artist,
              album: params.album,
              cover: params.cover,
              quality: params.quality,
              source: params.source,
              mediaType
            });
          }
          task.reject(new Error("下载的文件不存在"));
          downloadTasks.delete(matchedUrl);
          return;
        }
        let size = 0;
        try {
          size = fs.statSync(savedPath).size;
          console.log("文件大小:", size);
        } catch (err) {
          console.error("获取文件大小失败:", err);
        }
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            const info = {
              id: matchedUrl,
              filePath: savedPath,
              name: params.name || "未知歌曲",
              artist: params.artist || "未知艺术家",
              album: params.album || "",
              cover: params.cover || "",
              size,
              downloadTime: (/* @__PURE__ */ new Date()).toISOString().split("T")[0],
              quality: params.quality || "exhigh",
              source: params.source || "",
              mediaType
            };
            mainWindow.webContents.send("download-complete", info);
            console.log("已发送下载完成事件:", info.name);
          }
        } catch (err) {
          console.error("发送下载完成事件失败:", err);
        }
        try {
          task.resolve({ success: true, filePath: savedPath, id: matchedUrl });
          console.log("下载任务完成");
        } catch (err) {
          console.error("解析 Promise 失败:", err);
        }
      } else {
        console.error("下载失败，状态:", state);
        const message = state === "cancelled" ? "下载已取消" : "下载中断，请检查网络后重试";
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("download-error", {
            id: matchedUrl,
            error: message,
            name: params.name,
            artist: params.artist,
            album: params.album,
            cover: params.cover,
            quality: params.quality,
            source: params.source,
            mediaType
          });
        }
        task.reject(new Error(message));
      }
      downloadTasks.delete(matchedUrl);
    });
  });
}
function wrapHandler(fn) {
  return fn().then(
    (data) => data,
    (err) => ({ ok: false, error: err })
  );
}
function registerIpcHandlers() {
  ipcMain.on("app-close-action", (_e, action) => {
    closingToQuit = false;
    if (action === "quit") {
      forceQuit = true;
      app.quit();
    } else if (action === "tray") {
      hideToTray();
    }
  });
  ipcMain.on("window-control", (_e, action) => {
    if (!mainWindow) return;
    switch (action) {
      case "minimize":
        mainWindow.minimize();
        break;
      case "maximize":
        mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
        break;
      case "close":
        mainWindow.close();
        break;
      case "tray":
        hideToTray();
        break;
      case "fullscreen":
        mainWindow.setFullScreen(true);
        break;
      case "fullscreen-exit":
        mainWindow.setFullScreen(false);
        break;
    }
  });
  ipcMain.on("lyric-window-control", (_e, action) => {
    switch (action) {
      case "open":
        createLyricWindow();
        break;
      case "close":
        closeLyricWindow();
        break;
      case "toggle":
        lyricWindow ? closeLyricWindow() : createLyricWindow();
        break;
    }
  });
  ipcMain.on("update-desktop-lyric", (_e, payload) => {
    if (lyricWindow && !lyricWindow.isDestroyed()) lyricWindow.webContents.send("lyric-update", payload);
  });
  ipcMain.on("update-desktop-lyric-settings", (_e, payload) => {
    if (lyricWindow && !lyricWindow.isDestroyed()) lyricWindow.webContents.send("desktop-lyric-settings-update", payload);
  });
  ipcMain.on("player-control", (_e, action, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("player-control-from-lyric", action, payload);
    }
  });
  ipcMain.handle("search-bili", async (_e, input) => {
    const keyword = String(input?.name || "").trim();
    if (!keyword) return { code: 400, msg: "请提供搜索关键词", data: [], hasMore: false };
    try {
      return {
        code: 200,
        msg: "成功",
        ...await biliSearch(keyword, input?.page ?? 0, input?.limit ?? 20, input?.expandMultiPart === true)
      };
    } catch (err) {
      return { code: 500, msg: err instanceof Error ? err.message : "哔哩哔哩搜索失败", data: [], hasMore: false };
    }
  });
  ipcMain.handle("get-song-detail-bili", async (_e, trackId) => biliResolve(trackId));
  ipcMain.handle("clear-bili-search-sessions", () => {
    clearSearchSessions();
    return true;
  });
  ipcMain.handle("search-kw", async (_e, input) => {
    const keyword = String(input?.name || "").trim();
    if (!keyword) return { code: 400, msg: "请提供搜索关键词", data: [] };
    const page = input.page ?? 0;
    const limit = input.limit ?? 30;
    const url = "http://search.kuwo.cn/r.s?" + new URLSearchParams({
      client: "kt",
      all: keyword,
      pn: String(page),
      rn: String(limit),
      uid: "794762570",
      ver: "kwplayer_ar_9.2.2.1",
      vipver: "1",
      show_copyright_off: "1",
      newver: "1",
      ft: "music",
      cluster: "0",
      strategy: "2012",
      encoding: "utf8",
      rformat: "json",
      vermerge: "1",
      mobi: "1",
      issubtitle: "1"
    }).toString();
    try {
      return JSON.parse(await httpGetText(url, { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }));
    } catch (err) {
      throw err instanceof Error && err.message === "请求超时" ? err : err;
    }
  });
  ipcMain.handle("search-wy", async (_e, input) => {
    const keyword = String(input?.name || "").trim();
    if (!keyword) return { code: 400, msg: "请提供搜索关键词", data: [] };
    const page = input.page ?? 0;
    const limit = input.limit ?? 30;
    const { createHash: createHash2, createCipheriv } = await import("node:crypto");
    const secret = "e82ckenh8dichen8";
    const payload = JSON.stringify({
      s: keyword,
      type: 1,
      limit,
      total: page === 0,
      offset: page * limit
    });
    const digest = createHash2("md5").update(`nobody/api/cloudsearch/pcuse${payload}md5forencrypt`).digest("hex");
    const message = `/api/cloudsearch/pc-36cd479b6b5-${payload}-36cd479b6b5-${digest}`;
    const cipher = createCipheriv("aes-128-ecb", Buffer.from(secret), null);
    const sign = (cipher.update(message, "utf8", "hex") + cipher.final("hex")).toUpperCase();
    const body = new URLSearchParams({ params: sign }).toString();
    return new Promise((resolve, reject) => {
      const http2 = require2("node:http");
      const req = http2.request(
        {
          hostname: "interface.music.163.com",
          port: 80,
          path: "/eapi/batch",
          method: "POST",
          headers: {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36",
            Origin: "https://music.163.com",
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(body)
          },
          timeout: 1e4
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => data += chunk);
          res.on("end", () => {
            if (res.statusCode && res.statusCode !== 200) {
              reject(new Error(`请求失败，状态码: ${res.statusCode}`));
              return;
            }
            try {
              let json = JSON.parse(data);
              if (typeof json === "string") json = JSON.parse(json);
              if (Array.isArray(json) && json[0] && json[0].code !== void 0) json = json[0];
              resolve(json);
            } catch {
              reject(new Error("响应解析失败"));
            }
          });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("请求超时"));
      });
      req.write(body);
      req.end();
    });
  });
  ipcMain.handle("search-qq", async (_e, input) => {
    const keyword = String(input?.name || "").trim();
    if (!keyword) return { code: 400, msg: "请提供搜索关键词", data: [] };
    const page = (input.page ?? 0) + 1;
    const limit = input.limit ?? 30;
    const payload = JSON.stringify({
      comm: {
        ct: "11",
        cv: "14090508",
        v: "14090508",
        tmeAppID: "qqmusic",
        phonetype: "EBG-AN10",
        deviceScore: "553.47",
        devicelevel: "50",
        newdevicelevel: "20",
        rom: "HuaWei/EMOTION/EmotionUI_14.2.0",
        os_ver: "12",
        OpenUDID: "0",
        OpenUDID2: "0",
        QIMEI36: "0",
        udid: "0",
        chid: "0",
        aid: "0",
        oaid: "0",
        taid: "0",
        tid: "0",
        wid: "0",
        uid: "0",
        sid: "0",
        modeSwitch: "6",
        teenMode: "0",
        ui_mode: "2",
        nettype: "1020",
        v4ip: ""
      },
      req: {
        module: "music.search.SearchCgiService",
        method: "DoSearchForQQMusicMobile",
        param: {
          search_type: 0,
          query: keyword,
          page_num: page,
          num_per_page: limit,
          highlight: 0,
          nqc_flag: 0,
          multi_zhida: 0,
          cat: 2,
          grp: 1,
          sin: 0,
          sem: 0
        }
      }
    });
    try {
      const res = await fetch("https://u.y.qq.com/cgi-bin/musicu.fcg", {
        method: "POST",
        headers: { "User-Agent": "QQMusic 14090508(android 12)", "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(1e4)
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`请求失败，状态码: ${res.status}`);
      return JSON.parse(text);
    } catch (err) {
      throw err instanceof Error && err.name === "TimeoutError" ? new Error("请求超时") : err;
    }
  });
  ipcMain.handle("search-kg", async (_e, input) => {
    const keyword = String(input?.name || "").trim();
    if (!keyword) return { code: 400, msg: "请提供搜索关键词", data: [] };
    const page = (input.page ?? 0) + 1;
    const limit = input.limit ?? 30;
    const url = "https://songsearch.kugou.com/song_search_v2?" + new URLSearchParams({
      keyword,
      page: String(page),
      pagesize: String(limit),
      userid: "0",
      clientver: "",
      platform: "WebFilter",
      filter: "2",
      iscorrection: "1",
      privilege_filter: "0",
      area_code: "1"
    }).toString();
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(1e4)
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`请求失败，状态码: ${res.status}`);
      return JSON.parse(text);
    } catch (err) {
      throw err instanceof Error && err.name === "TimeoutError" ? new Error("请求超时") : err;
    }
  });
  ipcMain.handle("search-mg", async (_e, input) => {
    const keyword = String(input?.name || "").trim();
    if (!keyword) return { code: 400, msg: "请提供搜索关键词", data: [] };
    return mgSearch(keyword, input.page ?? 0, input.limit ?? 30);
  });
  ipcMain.handle("get-kg-catalog", (_e, input) => kgCategoryRequest(input));
  ipcMain.handle("get-lyric-qq", (_e, songMid) => qqLyric(songMid));
  ipcMain.handle("get-lyric-wy", (_e, id) => wyLyricPlain(id));
  ipcMain.handle("get-lyric-kw", (_e, id) => kwLyric(id));
  ipcMain.handle("get-lyric-kg", (_e, hash) => kgLyric(hash));
  ipcMain.handle("get-lyric-mg", async (_e, id) => {
    console.log("[Main] 收到获取咪咕歌词请求:", id);
    try {
      return { code: 200, lyric: await mgLyric(id) };
    } catch (err) {
      console.error("get-lyric-mg error:", err);
      return { code: 500, msg: "Internal Server Error" };
    }
  });
  ipcMain.handle("get-quality-sizes", async (_e, input) => {
    const aliasMap = { tx: "qq" };
    const sourceRaw = String(input?.source || "").trim().toLowerCase();
    const source = aliasMap[sourceRaw] || sourceRaw;
    const songId = String(input?.songId ?? "").trim();
    if (!songId) return { success: false, message: "缺少歌曲 ID" };
    const encoded = encodeURIComponent(songId);
    const endpoint = {
      wy: `https://music.haitangw.cc/wy/getwy_quality_size.php?id=${encoded}`,
      kg: `https://music.haitangw.cc/kgqq/get_qualitysize.php/?id=${encoded}&platform=kg`,
      qq: `https://music.haitangw.cc/kgqq/get_qualitysize.php/?id=${encoded}&platform=qq`,
      kw: `https://music.haitangw.cc/kw/getkw_quality_size.php?id=${encoded}`
    }[source];
    if (!endpoint) return { success: false, message: "当前线路不支持查询音质大小" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8e3);
    try {
      const res = await fetch(endpoint, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const raw = Array.isArray(json?.qualities) ? json.qualities : Array.isArray(json?.data?.qualities) ? json.data.qualities : [];
      const qualities = raw.map((item) => {
        const level = String(item?.level || "").trim().toLowerCase();
        const size = String(item?.size || "").trim();
        const sizeBytes = Number(item?.size_bytes);
        return {
          level,
          size,
          ...Number.isFinite(sizeBytes) && sizeBytes > 0 ? { size_bytes: sizeBytes } : {},
          ...item?.quality ? { quality: String(item.quality) } : {},
          ...item?.format ? { format: String(item.format) } : {},
          ...item?.bitrate ? { bitrate: String(item.bitrate) } : {},
          ...item?.available === false ? { available: false } : {}
        };
      }).filter((item) => !!item.level);
      return qualities.length ? { success: true, qualities } : { success: false, message: String(json?.msg || json?.message || "暂无音质大小数据") };
    } catch (err) {
      console.error(`[Main] 获取 ${source} 音质大小失败:`, err);
      return {
        success: false,
        message: err instanceof Error && err.name === "AbortError" ? "音质大小获取超时" : "获取音质大小失败"
      };
    } finally {
      clearTimeout(timer);
    }
  });
  ipcMain.handle("get-wy-playlist", async (_e, input) => wyPlaylist(input.id, input.limit));
  ipcMain.handle("get-song-detail-wy", async (_e, input) => wySongDetail(input));
  ipcMain.handle("get-kw-playlist", async (_e, input) => kwPlaylist(input.id, input.page, input.limit));
  ipcMain.handle("get-song-detail-kw", async (_e, input) => kwSongDetail(input));
  ipcMain.handle("get-qq-playlist-square", async (_e, input) => qqPlaylistSquare(input.category, input.page, input.limit));
  ipcMain.handle("get-qq-playlist", async (_e, input) => qqPlaylist(input.id));
  ipcMain.handle("get-song-detail-qq", async (_e, input) => qqSongDetail(input));
  ipcMain.handle("get-kg-playlist", async (_e, input) => kgPlaylist(input.id, input.page, input.name));
  ipcMain.handle("get-song-detail-kg", async (_e, input) => kgSongDetail(input));
  ipcMain.handle("playlist-get-snapshot", () => wrapHandler(async () => playlistLibrary.getSnapshot()));
  ipcMain.handle("playlist-create", (_e, input) => wrapHandler(async () => playlistLibrary.createPlaylist(input?.name)));
  ipcMain.handle("playlist-rename", (_e, input) => wrapHandler(async () => playlistLibrary.renamePlaylist(input?.playlistId, input?.name)));
  ipcMain.handle("playlist-delete", (_e, input) => wrapHandler(async () => playlistLibrary.deletePlaylist(input)));
  ipcMain.handle("playlist-add-tracks", (_e, input) => wrapHandler(async () => playlistLibrary.addTracks(input?.playlistId, input?.tracks)));
  ipcMain.handle("playlist-remove-tracks", (_e, input) => wrapHandler(async () => playlistLibrary.removeTracks(input?.playlistId, input?.trackIds)));
  ipcMain.handle("playlist-reorder-tracks", (_e, input) => wrapHandler(async () => playlistLibrary.reorderTracks(input?.playlistId, input?.orderedTrackIds)));
  ipcMain.handle("playlist-import", (_e, input) => wrapHandler(async () => importPlaylist(input)));
  ipcMain.handle("playlist-refresh-import", (_e, input) => wrapHandler(async () => refreshImportedPlaylist(input)));
  ipcMain.handle("playlist-search", async (_e, input) => {
    try {
      const source = String(input?.source || "").toLowerCase();
      if (source === "qq") return qqPlaylistSquare(input?.keyword || input?.category || "10000000", input?.page ?? 1, input?.limit ?? 30);
      return { code: 400, msg: "暂不支持该来源歌单搜索", data: [] };
    } catch (err) {
      return { code: 500, msg: err instanceof Error ? err.message : String(err), data: [] };
    }
  });
  ipcMain.handle("playlist-sync-get-status", () => wrapHandler(async () => playlistSync.getStatus()));
  ipcMain.handle("playlist-sync-now", () => wrapHandler(async () => playlistSync.retry()));
  ipcMain.handle("playlist-sync-push", () => wrapHandler(async () => playlistSync.pushLocalToCloud()));
  ipcMain.handle("playlist-sync-pull", () => wrapHandler(async () => playlistSync.pullCloudToLocal()));
  ipcMain.on("playlist-sync-online", (_e, payload) => {
    playlistSync.activate(payload?.userId || "", {
      enabled: payload?.enabled,
      autoSyncEnabled: payload?.autoSyncEnabled
    });
  });
  ipcMain.handle("favorite-get-snapshot", () => wrapHandler(async () => favoriteLibrary.getSnapshot()));
  ipcMain.handle("favorite-record-local", (_e, input) => wrapHandler(async () => favoriteLibrary.recordLocalFavorites(input)));
  ipcMain.handle("favorite-sync-get-status", () => wrapHandler(async () => favoriteSync.getStatus()));
  ipcMain.handle("favorite-sync-now", () => wrapHandler(async () => favoriteSync.retry()));
  ipcMain.handle("favorite-sync-push", () => wrapHandler(async () => favoriteSync.pushLocalToCloud()));
  ipcMain.handle("favorite-sync-pull", () => wrapHandler(async () => favoriteSync.pullCloudToLocal()));
  ipcMain.on("favorite-sync-online", (_e, payload) => {
    favoriteSync.activate(payload?.userId || "", {
      enabled: payload?.enabled,
      autoSyncEnabled: payload?.autoSyncEnabled
    });
  });
  ipcMain.handle("backup-get-status", () => wrapHandler(async () => backupService.getStatus()));
  ipcMain.handle("backup-set-settings", (_e, input) => wrapHandler(async () => backupService.setSettings(input)));
  ipcMain.handle("backup-create", (_e, input) => wrapHandler(async () => backupService.createBackup(input)));
  ipcMain.handle("backup-list-files", () => wrapHandler(async () => backupService.listFiles()));
  ipcMain.handle("backup-delete-file", (_e, input) => wrapHandler(async () => backupService.deleteFile(input)));
  ipcMain.handle("backup-inspect-file", (_e, input) => wrapHandler(async () => backupService.inspectFile(input)));
  ipcMain.handle("backup-choose-directory", async () => {
    const result = await dialog.showOpenDialog(mainWindow || void 0, {
      title: "选择备份目录",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths?.length) return { success: false };
    await backupService.setSettings({ path: result.filePaths[0] });
    return { success: true, path: result.filePaths[0] };
  });
  ipcMain.handle("backup-choose-import-file", async (_e, input) => {
    const result = await dialog.showOpenDialog(mainWindow || void 0, {
      title: "选择备份文件",
      properties: ["openFile"],
      filters: [{ name: "备份文件", extensions: ["txt"] }]
    });
    if (result.canceled || !result.filePaths?.length) return { success: false };
    return backupService.chooseImportPath(result.filePaths[0]);
  });
  ipcMain.handle("backup-import", (_e, input) => wrapHandler(async () => backupService.importBackup(input?.path, input?.scopes)));
  ipcMain.handle(
    "backup-run-automatic",
    (_e, input) => wrapHandler(async () => backupService.runAutomaticBackup({ force: input?.force === true, trigger: "manual" }))
  );
  ipcMain.handle("backup-open-directory", () => {
    shell.openPath(backupService.getSettings().path);
  });
  ipcMain.handle("account-get-state", () => wrapHandler(async () => accountClient.getState()));
  ipcMain.handle("account-send-register-email-code", (_e, input) => wrapHandler(async () => accountClient.sendRegisterEmailCode(input)));
  ipcMain.handle("account-register", (_e, input) => wrapHandler(async () => accountClient.register(input)));
  ipcMain.handle("account-login", (_e, input) => wrapHandler(async () => accountClient.login(input)));
  ipcMain.handle("account-send-password-reset-code", (_e, input) => wrapHandler(async () => accountClient.sendPasswordResetEmailCode(input)));
  ipcMain.handle("account-reset-password", (_e, input) => wrapHandler(async () => accountClient.resetPassword(input)));
  ipcMain.handle("account-change-password", (_e, input) => wrapHandler(async () => accountClient.changePassword(input)));
  ipcMain.handle("account-logout", () => wrapHandler(async () => accountClient.logout()));
  ipcMain.handle("account-update-profile", (_e, input) => wrapHandler(async () => accountClient.updateProfile(input)));
  ipcMain.handle("account-send-binding-email-code", (_e, input) => wrapHandler(async () => accountClient.sendBindingEmailCode(input)));
  ipcMain.handle("account-bind-email", (_e, email, code) => wrapHandler(async () => accountClient.bindEmail(email, code)));
  ipcMain.handle("account-upload-avatar", () => wrapHandler(async () => accountClient.selectAndUploadMedia("avatar", mainWindow)));
  ipcMain.handle("account-upload-background", () => wrapHandler(async () => accountClient.selectAndUploadMedia("background", mainWindow)));
  ipcMain.handle("account-remove-avatar", () => wrapHandler(async () => accountClient.removeMedia("avatar")));
  ipcMain.handle("account-remove-background", () => wrapHandler(async () => accountClient.removeMedia("background")));
  ipcMain.handle("music-gateway-resolve", (_e, input) => gateway.resolve(input));
  ipcMain.handle("music-gateway-clear-cache", () => gateway.clearCache());
  ipcMain.handle("local-music-get-state", () => localMusicLibrary.getState());
  ipcMain.handle("local-music-choose-directories", async () => {
    const result = await dialog.showOpenDialog(mainWindow || void 0, {
      title: "选择音乐目录",
      properties: ["openDirectory", "multiSelections"]
    });
    if (result.canceled || !result.filePaths?.length) return localMusicLibrary.getState();
    return localMusicLibrary.addDirectories(result.filePaths);
  });
  ipcMain.handle("local-music-remove-directory", (_e, input) => localMusicLibrary.removeDirectory(input));
  ipcMain.handle("local-music-clear", () => localMusicLibrary.clear());
  ipcMain.handle("local-music-scan", () => localMusicLibrary.scan(mainWindow?.webContents ?? null));
  ipcMain.handle("local-music-get-cover", (_e, input) => localMusicLibrary.getCover(input));
  ipcMain.handle("read-local-audio-metadata", (_e, input) => readLocalAudioMetadata(input));
  ipcMain.handle("download-music", (_e, input) => startDownload({ ...input, mediaType: "audio" }));
  ipcMain.handle("download-mv", (_e, input) => startDownload({ ...input, mediaType: "mv" }));
  ipcMain.handle("download-lyrics", (_e, input) => {
    try {
      const lyrics = String(input?.lyrics || "");
      if (!lyrics.trim()) return { success: false, message: "歌词内容为空" };
      const name = sanitizeFileName(input?.name, "未知歌曲");
      const artist = sanitizeFileName(input?.artist, "");
      const fileName = artist ? `${name} - ${artist}.lrc` : `${name}.lrc`;
      const dir = currentDownloadPath();
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, fileName);
      fs.writeFileSync(filePath, lyrics, "utf8");
      return { success: true, filePath };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "歌词下载失败" };
    }
  });
  ipcMain.handle("get-download-path", () => currentDownloadPath());
  ipcMain.handle("set-download-path", async () => {
    const result = await dialog.showOpenDialog(mainWindow || void 0, {
      title: "选择下载保存位置",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths?.length) return { success: false };
    const previous = currentDownloadPath();
    downloadPath = result.filePaths[0];
    saveDownloadPath();
    if (previous === downloadPath) {
      try {
        await backupService.setSettings({ path: downloadPath });
      } catch (err) {
        console.warn("[backup] 同步歌曲下载目录失败", err);
      }
    }
    return { success: true, path: downloadPath };
  });
  ipcMain.handle("open-download-directory", () => {
    shell.openPath(currentDownloadPath());
  });
  ipcMain.handle("open-local-file", async (_e, input) => {
    if (!input || typeof input !== "string" || !path.isAbsolute(input)) return { success: false, message: "无效的本地文件路径" };
    if (!fs.existsSync(input)) return { success: false, message: "本地文件不存在" };
    const err = await shell.openPath(input);
    return { success: !err, message: err };
  });
  ipcMain.handle("open-external", async (_e, input) => {
    if (!input || typeof input !== "string") return { success: false, message: "无效的链接" };
    try {
      await shell.openExternal(input);
      return { success: true };
    } catch (err) {
      console.error("打开外部链接失败:", err);
      return { success: false, message: String(err) };
    }
  });
  ipcMain.handle("register-playback-headers", (_e, input) => {
    if (!input?.url || !input.headers || Object.keys(input.headers).length === 0) return false;
    const parsed = new URL(String(input.url));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("仅支持为 HTTP(S) 播放地址注册请求头");
    }
    const expiresRaw = Number(input.expiresAt);
    const expiresAt = Number.isFinite(expiresRaw) && expiresRaw > 0 ? expiresRaw < 1e12 ? expiresRaw * 1e3 : expiresRaw : Date.now() + 24 * 60 * 60 * 1e3;
    playbackHeaders.set(String(input.url), { headers: input.headers, expiresAt });
    return true;
  });
  ipcMain.handle("create-qmc-playback-session", (_e, input) => qmcProxy.createSession(input));
  const dataFile = (name) => {
    const dir = path.join(app.getPath("userData"), "data");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, name);
  };
  ipcMain.handle("write-data", async (_e, name, value) => {
    try {
      fs.writeFileSync(dataFile(`${name}.json`), JSON.stringify(value, null, 2));
      return { success: true };
    } catch (err) {
      console.error(`写入数据失败 ${name}:`, err);
      return { success: false, error: String(err) };
    }
  });
  ipcMain.handle("read-data", async (_e, name) => {
    try {
      const file = dataFile(`${name}.json`);
      if (fs.existsSync(file)) {
        return { success: true, data: JSON.parse(fs.readFileSync(file, "utf-8")) };
      }
      return { success: true, data: null };
    } catch (err) {
      console.error(`读取数据失败 ${name}:`, err);
      return { success: false, error: String(err) };
    }
  });
  ipcMain.handle("download-update", async (_e, input) => {
    const url = String(input?.url || "").trim();
    let filePath = "";
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { success: false, message: "在线更新仅支持 HTTP(S) 地址" };
      }
      const fallbackName = process.platform === "win32" ? "LGMusic-Update.exe" : process.platform === "darwin" ? "LGMusic-Update.dmg" : "LGMusic-Update.AppImage";
      const baseName = typeof input?.fileName === "string" && input.fileName.trim() ? input.fileName.trim() : decodeURIComponent(path.basename(parsed.pathname));
      const fileName = path.basename(baseName || fallbackName).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/^\.+/, "");
      const ext = path.extname(fileName).toLowerCase();
      if (!(/* @__PURE__ */ new Set([".exe", ".msi", ".dmg", ".pkg", ".appimage"])).has(ext)) {
        return { success: false, message: "更新包格式不受支持，请配置 exe、msi、dmg、pkg 或 AppImage" };
      }
      const dir = path.join(app.getPath("temp"), "LGMusic-updates");
      await fs.promises.mkdir(dir, { recursive: true });
      filePath = path.join(dir, fileName);
      await fs.promises.rm(filePath, { force: true });
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok || !res.body) {
        return { success: false, message: `更新包下载失败（HTTP ${res.status}）` };
      }
      const total = Number(res.headers.get("content-length") || 0);
      let received = 0;
      let lastTick = 0;
      const stream = Stream.Readable.fromWeb(res.body);
      stream.on("data", (chunk) => {
        received += chunk.length;
        const now = Date.now();
        const progress = total > 0 ? Math.min(100, Math.round(received / total * 100)) : null;
        if (now - lastTick >= 150 || progress === 100) {
          lastTick = now;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("update-download-progress", { progress, received, total });
          }
        }
      });
      await pipeline(stream, fs.createWriteStream(filePath));
      const openError = await shell.openPath(filePath);
      return openError ? { success: false, filePath, message: openError } : { success: true, filePath };
    } catch (err) {
      if (filePath) await fs.promises.rm(filePath, { force: true }).catch(() => void 0);
      console.error("在线更新下载失败:", err);
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  });
}
const refreshAccountBindings = async () => {
  try {
    const state = await accountClient.getState();
    const userId = state.status === "authenticated" ? state.user?.id ?? null : null;
    const playlistChanged = playlistLibrary.setActiveUser(userId);
    favoriteLibrary.setActiveUser(userId);
    if (userId) {
      playlistSync.activate(userId, {
        enabled: state.user?.cloudSyncEnabled === true,
        autoSyncEnabled: state.user?.cloudSyncAutoEnabled !== false
      });
      favoriteSync.activate(userId, {
        enabled: state.user?.cloudSyncEnabled === true,
        autoSyncEnabled: state.user?.cloudSyncAutoEnabled !== false
      });
    } else {
      playlistSync.stop();
      favoriteSync.stop();
    }
    if (playlistChanged) {
      mainWindow?.webContents.send("playlist-library-changed");
      mainWindow?.webContents.send("favorite-library-changed");
    }
  } catch (err) {
    console.warn("[playlist-library] 获取账号状态失败，使用游客歌单库", err);
    const changed = playlistLibrary.setActiveUser(null);
    favoriteLibrary.setActiveUser(null);
    playlistSync.stop();
    favoriteSync.stop();
    if (changed) {
      mainWindow?.webContents.send("playlist-library-changed");
      mainWindow?.webContents.send("favorite-library-changed");
    }
  }
};
app.whenReady().then(() => {
  const userData = app.getPath("userData");
  accountClient.bindUserData(userData);
  gateway.bindUserData(userData);
  playlistLibrary.bindUserData(userData);
  favoriteLibrary.bindUserData(userData);
  backupService.bindUserData(userData);
  localMusicLibrary.bindUserData(userData);
  backupService.setSongDownloadPathProvider(() => downloadPath);
  playlistLibrary.setLocalChangeListener(() => playlistSync.notifyLocalChange());
  favoriteLibrary.setLocalChangeListener(() => favoriteSync.notifyLocalChange());
  loadDownloadPath();
  setupDownloadListener();
  registerIpcHandlers();
  gateway.startTicketRefresh();
  ensureTray();
  createMainWindow();
  app.on("browser-window-focus", () => {
  });
  setTimeout(() => {
    void refreshAccountBindings();
  }, 800);
});
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => {
  forceQuit = true;
  gateway.dispose();
  qmcProxy.dispose();
});
export {
  GATEWAY_SERVERS,
  accountErrorInfo,
  favoriteErrorInfo,
  playlistErrorInfo
};
