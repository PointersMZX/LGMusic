import { app, dialog, safeStorage, BrowserWindow, session, ipcMain, shell, nativeImage, Tray, Menu } from "electron";
import fs from "node:fs";
import path, { join as join$1 } from "node:path";
import { Stream } from "node:stream";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import { randomUUID, createHmac, randomBytes, createHash, createCipheriv, publicEncrypt, constants } from "node:crypto";
import http from "node:http";
import https from "node:https";
import fsp from "node:fs/promises";
import { pathToFileURL, URL as URL$1 } from "node:url";
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import vm from "node:vm";
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
const WY_COOKIE$1 = "EVNSM=1.0.0; osver=14; MUSIC_U=; NMCID=oyapoh.1707738771510.01.4; versioncode=1000022; URS_APPID=E26D3B65474AEE2FC2586DCAE42BCF0CBEA421D4CB53C42A74EBEF035ACE98E0B6F0E44087D61EFC06BE92279CD6EEC6; buildver=231106171719; resolution=3040x1440; sDeviceId=bnVsbAljNjowOTpiMzphYzo4NDowNgk4NzNjZWYxNGQxYjY4MWI5CWY1ZjVhNTIxOGFjNDA3ZmY%3D; os=magicos; channel=netease; screenType=other; deviceId=bnVsbAljNjowOTpiMzphYzo4NDowNgk4NzNjZWYxNGQxYjY4MWI5CWY1ZjVhNTIxOGFjNDA3ZmY%3D; appver=1.0.22; NMDI=Q1NKTQkBDACdyBclTqtsEuV2ecI7AAAAKyV%2B9xWzSJenvmG2RFU9D82gQoo96WkqNFpO59px3PrvpN5DF0cFPRJ3BXMIBMdBOcxhjUoyxI898tU%3D; ntes_kaola_ad=1; language=zh-CN; mobilename=22041211AC; __csrf=b383e0976daab42a166a9544f90a1dc3; NMTID=00O3nhQ8Br3egFvnEAIjk_hf0yT9jsAAAGNnSmw4w; packageType=release";
const WY_UA$1 = "NeteaseMusic/1.0.22.231106171719(1000022);Dalvik/2.1.0 (Linux; U; Android 14; 22041211AC Build/UP1A.231005.007)";
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
    const text = await httpGetText(url, { Cookie: WY_COOKIE$1, "User-Agent": WY_UA$1 });
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
function wyEapiEncrypt(path2, data) {
  const secret = "e82ckenh8dichen8";
  const digest = createHash("md5").update(`nobody${path2}use${data}md5forencrypt`).digest("hex");
  const message = `${path2}-36cd479b6b5-${data}-36cd479b6b5-${digest}`;
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(secret), null);
  return cipher.update(message, "utf8", "hex") + cipher.final("hex");
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
const WY_HOST = "interface3.music.163.com";
const WY_UA = "Mozilla/5.0 (Linux; Android 12; 22041211AC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.79 Mobile Safari/537.36";
const WY_COOKIE = "appver=1.0.22; os=android; channel=netease; MUSIC_U=; NMTID=00O3nhQ8Br3egFvnEAIjk_hf0yT9jsAAAGNnSmw4w; __csrf=b383e0976daab42a166a9544f90a1dc3";
function eapiPost(eapiPath, apiPath, payload) {
  const sign = wyEapiEncrypt(apiPath, JSON.stringify(payload));
  const body = `params=${encodeURIComponent(sign)}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: WY_HOST,
        port: 80,
        path: `/eapi${eapiPath}`,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          Cookie: WY_COOKIE,
          "User-Agent": WY_UA,
          Referer: "https://music.163.com/"
        }
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => data += chunk ?? "");
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error("MV 接口返回异常"));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
async function wyMvList(page = 1, limit = 24) {
  try {
    const offset = (page - 1) * limit;
    const res = await eapiPost("/mv/all", "/api/mv/all", {
      limit,
      offset,
      area: "",
      order: "hot",
      type: "全部"
    });
    if (res.code !== 200) return { code: res.code, msg: res.msg, mvs: [] };
    const list = Array.isArray(res.data) ? res.data : [];
    const mvs = list.map((it) => ({
      id: Number(it.id || 0),
      name: String(it.name || ""),
      artist: String(it.artistName || it.artists?.[0]?.name || ""),
      pic: String(it.cover || it.picUrl || ""),
      playCount: Number(it.playCount || 0),
      duration: Number(it.duration || 0) / 1e3
    }));
    return { code: 200, mvs };
  } catch (err) {
    return { code: 500, msg: "获取 MV 列表失败: " + String(err), mvs: [] };
  }
}
const WEPAPI_SECRET = "0CoJUm6Qyw8W8jud";
const WEPAPI_PUBLIC_KEY = "010001";
const WEPAPI_MODULUS = "00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424f8138fe5dfc7f1b0a3c9e0d3d9f6b5c4f3d8e6a4b2c1d0f9e8";
function weapiAes(text, key) {
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(key, "utf8"), Buffer.from("0102030405060708", "utf8"));
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return enc.toString("base64");
}
function weapiRsa(text) {
  const key = {
    kty: "RSA",
    n: Buffer.from(WEPAPI_MODULUS, "hex"),
    e: Buffer.from(WEPAPI_PUBLIC_KEY, "hex")
  };
  const enc = publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(text, "utf8"));
  return enc.toString("hex");
}
function weapiEncrypt(data) {
  const text = JSON.stringify(data);
  const randomKey = randomBytes(8).toString("hex").slice(0, 16);
  const params = weapiAes(weapiAes(text, randomKey), WEPAPI_SECRET);
  const encSecKey = weapiRsa(randomKey);
  return { params, encSecKey };
}
function weapiPost(weapiPath, payload) {
  const { params, encSecKey } = weapiEncrypt({ ...payload, csrf_token: "" });
  const body = `params=${encodeURIComponent(params)}&encSecKey=${encodeURIComponent(encSecKey)}`;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "music.163.com",
        port: 443,
        path: `/weapi${weapiPath}`,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          Cookie: WY_COOKIE,
          "User-Agent": WY_UA,
          Referer: "https://music.163.com/"
        }
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => data += chunk ?? "");
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error("MV 播放接口返回异常"));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
async function wyMvUrl(mvid) {
  try {
    const res = await weapiPost("/song/enhance/play/mv", { ids: [mvid] });
    if (res.code !== 200) return "";
    const list = res.data || [];
    return String(list[0]?.url || "");
  } catch {
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
const DEFAULTS = {
  defaultQuality: "standard",
  downloadDir: "",
  desktopLyric: {
    fontSize: 26,
    color: "#29c586",
    shadow: true,
    twoLine: false
  }
};
const configPath = () => join(app.getPath("userData"), "config.json");
let cache = null;
function getConfig() {
  if (cache) return cache;
  try {
    if (existsSync(configPath())) {
      const parsed = JSON.parse(readFileSync(configPath(), "utf-8"));
      cache = {
        ...DEFAULTS,
        ...parsed,
        desktopLyric: { ...DEFAULTS.desktopLyric, ...parsed.desktopLyric || {} }
      };
      return cache;
    }
  } catch {
  }
  cache = { ...DEFAULTS };
  return cache;
}
function setConfig(patch) {
  const merged = {
    ...getConfig(),
    ...patch,
    desktopLyric: { ...getConfig().desktopLyric, ...patch.desktopLyric || {} }
  };
  cache = merged;
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(merged, null, 2), "utf-8");
  return merged;
}
const sourcesDir$1 = () => join(app.getPath("userData"), "sources");
const indexPath = () => join(sourcesDir$1(), "index.json");
function ensureDir() {
  if (!existsSync(sourcesDir$1())) mkdirSync(sourcesDir$1(), { recursive: true });
}
function readIndex() {
  ensureDir();
  try {
    if (existsSync(indexPath())) return JSON.parse(readFileSync(indexPath(), "utf-8"));
  } catch {
  }
  return [];
}
function writeIndex(list) {
  ensureDir();
  writeFileSync(indexPath(), JSON.stringify(list, null, 2), "utf-8");
}
function probeMeta(fileName, content) {
  let name = fileName.replace(/\.(js|json)$/i, "");
  let type = "unknown";
  let version = "";
  if (/musicfree|getMediaSource/i.test(content)) {
    type = "musicfree";
    const m = content.match(/platform\s*:\s*['"]([^'"]+)['"]/);
    if (m) name = m[1];
    const v = content.match(/version\s*:\s*['"]([^'"]+)['"]/);
    if (v) version = v[1];
  } else if (/lx_setup|globalThis\.lx|__lx/i.test(content)) {
    type = "lx";
    const m = content.match(/音源名[：:]\s*([^\n]+)/);
    if (m) name = m[1].trim();
  } else {
    try {
      const json = JSON.parse(content);
      if (json.name) name = String(json.name);
      type = "json-config";
    } catch {
      type = "unknown";
    }
  }
  return { name, type, version };
}
function listSources() {
  return readIndex();
}
function importSourceDialog(parent) {
  const win = parent ?? BrowserWindow.getAllWindows()[0];
  const result = dialog.showOpenDialogSync(win, {
    title: "导入音源配置",
    filters: [{ name: "音源配置", extensions: ["js", "json"] }],
    properties: ["openFile", "multiSelections"]
  });
  if (!result || result.length === 0) return Promise.resolve(null);
  ensureDir();
  const list = readIndex();
  const added = [];
  for (const filePath of result) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const baseName = filePath.split(/[\\/]/).pop();
      const meta = probeMeta(baseName, content);
      const target = join(sourcesDir$1(), baseName);
      writeFileSync(target, content, "utf-8");
      const entry = {
        fileName: baseName,
        name: meta.name,
        type: meta.type,
        version: meta.version,
        importedAt: Date.now()
      };
      const existing = list.findIndex((x) => x.fileName === baseName);
      if (existing >= 0) list[existing] = entry;
      else list.push(entry);
      added.push(entry);
    } catch {
    }
  }
  writeIndex(list);
  return Promise.resolve(added);
}
function deleteSource(fileName) {
  const list = readIndex().filter((x) => x.fileName !== fileName);
  try {
    const target = join(sourcesDir$1(), fileName);
    if (existsSync(target)) unlinkSync(target);
  } catch {
  }
  writeIndex(list);
  return list;
}
const depsSource = '/* 由 scripts/build-musicfree-dependencies.js 自动生成，请勿手动修改。 */\nvar __musicfreeDependencies=(()=>{var rf=(e=>typeof require!="undefined"?require:typeof Proxy!="undefined"?new Proxy(e,{get:(t,r)=>(typeof require!="undefined"?require:t)[r]}):e)(function(e){if(typeof require!="undefined")return require.apply(this,arguments);throw Error(\'Dynamic require of "\'+e+\'" is not supported\')});var R=(e,t)=>()=>(t||e((t={exports:{}}).exports,t),t.exports);var af=R(uf=>{"use strict";Object.defineProperty(uf,"__esModule",{value:!0})});var Qi=R(bu=>{"use strict";var Fa=bu&&bu.__assign||function(){return Fa=Object.assign||function(e){for(var t,r=1,u=arguments.length;r<u;r++){t=arguments[r];for(var a in t)Object.prototype.hasOwnProperty.call(t,a)&&(e[a]=t[a])}return e},Fa.apply(this,arguments)};Object.defineProperty(bu,"__esModule",{value:!0});bu.flatten=void 0;var fE={xml:!1,decodeEntities:!0};bu.default=fE;var nf={_useHtmlParser2:!0,xmlMode:!0};function lE(e){return e!=null&&e.xml?typeof e.xml=="boolean"?nf:Fa(Fa({},nf),e.xml):e!=null?e:void 0}bu.flatten=lE});var qu=R(we=>{"use strict";Object.defineProperty(we,"__esModule",{value:!0});we.Doctype=we.CDATA=we.Tag=we.Style=we.Script=we.Comment=we.Directive=we.Text=we.Root=we.isTag=we.ElementType=void 0;var Nt;(function(e){e.Root="root",e.Text="text",e.Directive="directive",e.Comment="comment",e.Script="script",e.Style="style",e.Tag="tag",e.CDATA="cdata",e.Doctype="doctype"})(Nt=we.ElementType||(we.ElementType={}));function dE(e){return e.type===Nt.Tag||e.type===Nt.Script||e.type===Nt.Style}we.isTag=dE;we.Root=Nt.Root;we.Text=Nt.Text;we.Directive=Nt.Directive;we.Comment=Nt.Comment;we.Script=Nt.Script;we.Style=Nt.Style;we.Tag=Nt.Tag;we.CDATA=Nt.CDATA;we.Doctype=Nt.Doctype});var Zi=R(be=>{"use strict";var Ur=be&&be.__extends||function(){var e=function(t,r){return e=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(u,a){u.__proto__=a}||function(u,a){for(var n in a)Object.prototype.hasOwnProperty.call(a,n)&&(u[n]=a[n])},e(t,r)};return function(t,r){if(typeof r!="function"&&r!==null)throw new TypeError("Class extends value "+String(r)+" is not a constructor or null");e(t,r);function u(){this.constructor=t}t.prototype=r===null?Object.create(r):(u.prototype=r.prototype,new u)}}(),w0=be&&be.__assign||function(){return w0=Object.assign||function(e){for(var t,r=1,u=arguments.length;r<u;r++){t=arguments[r];for(var a in t)Object.prototype.hasOwnProperty.call(t,a)&&(e[a]=t[a])}return e},w0.apply(this,arguments)};Object.defineProperty(be,"__esModule",{value:!0});be.cloneNode=be.hasChildren=be.isDocument=be.isDirective=be.isComment=be.isText=be.isCDATA=be.isTag=be.Element=be.Document=be.CDATA=be.NodeWithChildren=be.ProcessingInstruction=be.Comment=be.Text=be.DataNode=be.Node=void 0;var gt=qu(),Ki=function(){function e(){this.parent=null,this.prev=null,this.next=null,this.startIndex=null,this.endIndex=null}return Object.defineProperty(e.prototype,"parentNode",{get:function(){return this.parent},set:function(t){this.parent=t},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"previousSibling",{get:function(){return this.prev},set:function(t){this.prev=t},enumerable:!1,configurable:!0}),Object.defineProperty(e.prototype,"nextSibling",{get:function(){return this.next},set:function(t){this.next=t},enumerable:!1,configurable:!0}),e.prototype.cloneNode=function(t){return t===void 0&&(t=!1),$i(this,t)},e}();be.Node=Ki;var ka=function(e){Ur(t,e);function t(r){var u=e.call(this)||this;return u.data=r,u}return Object.defineProperty(t.prototype,"nodeValue",{get:function(){return this.data},set:function(r){this.data=r},enumerable:!1,configurable:!0}),t}(Ki);be.DataNode=ka;var sf=function(e){Ur(t,e);function t(){var r=e!==null&&e.apply(this,arguments)||this;return r.type=gt.ElementType.Text,r}return Object.defineProperty(t.prototype,"nodeType",{get:function(){return 3},enumerable:!1,configurable:!0}),t}(ka);be.Text=sf;var of=function(e){Ur(t,e);function t(){var r=e!==null&&e.apply(this,arguments)||this;return r.type=gt.ElementType.Comment,r}return Object.defineProperty(t.prototype,"nodeType",{get:function(){return 8},enumerable:!1,configurable:!0}),t}(ka);be.Comment=of;var cf=function(e){Ur(t,e);function t(r,u){var a=e.call(this,u)||this;return a.name=r,a.type=gt.ElementType.Directive,a}return Object.defineProperty(t.prototype,"nodeType",{get:function(){return 1},enumerable:!1,configurable:!0}),t}(ka);be.ProcessingInstruction=cf;var Ha=function(e){Ur(t,e);function t(r){var u=e.call(this)||this;return u.children=r,u}return Object.defineProperty(t.prototype,"firstChild",{get:function(){var r;return(r=this.children[0])!==null&&r!==void 0?r:null},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"lastChild",{get:function(){return this.children.length>0?this.children[this.children.length-1]:null},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"childNodes",{get:function(){return this.children},set:function(r){this.children=r},enumerable:!1,configurable:!0}),t}(Ki);be.NodeWithChildren=Ha;var ff=function(e){Ur(t,e);function t(){var r=e!==null&&e.apply(this,arguments)||this;return r.type=gt.ElementType.CDATA,r}return Object.defineProperty(t.prototype,"nodeType",{get:function(){return 4},enumerable:!1,configurable:!0}),t}(Ha);be.CDATA=ff;var lf=function(e){Ur(t,e);function t(){var r=e!==null&&e.apply(this,arguments)||this;return r.type=gt.ElementType.Root,r}return Object.defineProperty(t.prototype,"nodeType",{get:function(){return 9},enumerable:!1,configurable:!0}),t}(Ha);be.Document=lf;var df=function(e){Ur(t,e);function t(r,u,a,n){a===void 0&&(a=[]),n===void 0&&(n=r==="script"?gt.ElementType.Script:r==="style"?gt.ElementType.Style:gt.ElementType.Tag);var s=e.call(this,a)||this;return s.name=r,s.attribs=u,s.type=n,s}return Object.defineProperty(t.prototype,"nodeType",{get:function(){return 1},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"tagName",{get:function(){return this.name},set:function(r){this.name=r},enumerable:!1,configurable:!0}),Object.defineProperty(t.prototype,"attributes",{get:function(){var r=this;return Object.keys(this.attribs).map(function(u){var a,n;return{name:u,value:r.attribs[u],namespace:(a=r["x-attribsNamespace"])===null||a===void 0?void 0:a[u],prefix:(n=r["x-attribsPrefix"])===null||n===void 0?void 0:n[u]}})},enumerable:!1,configurable:!0}),t}(Ha);be.Element=df;function hf(e){return(0,gt.isTag)(e)}be.isTag=hf;function pf(e){return e.type===gt.ElementType.CDATA}be.isCDATA=pf;function bf(e){return e.type===gt.ElementType.Text}be.isText=bf;function _f(e){return e.type===gt.ElementType.Comment}be.isComment=_f;function Ef(e){return e.type===gt.ElementType.Directive}be.isDirective=Ef;function Tf(e){return e.type===gt.ElementType.Root}be.isDocument=Tf;function hE(e){return Object.prototype.hasOwnProperty.call(e,"children")}be.hasChildren=hE;function $i(e,t){t===void 0&&(t=!1);var r;if(bf(e))r=new sf(e.data);else if(_f(e))r=new of(e.data);else if(hf(e)){var u=t?Xi(e.children):[],a=new df(e.name,w0({},e.attribs),u);u.forEach(function(c){return c.parent=a}),e.namespace!=null&&(a.namespace=e.namespace),e["x-attribsNamespace"]&&(a["x-attribsNamespace"]=w0({},e["x-attribsNamespace"])),e["x-attribsPrefix"]&&(a["x-attribsPrefix"]=w0({},e["x-attribsPrefix"])),r=a}else if(pf(e)){var u=t?Xi(e.children):[],n=new ff(u);u.forEach(function(o){return o.parent=n}),r=n}else if(Tf(e)){var u=t?Xi(e.children):[],s=new lf(u);u.forEach(function(o){return o.parent=s}),e["x-mode"]&&(s["x-mode"]=e["x-mode"]),r=s}else if(Ef(e)){var i=new cf(e.name,e.data);e["x-name"]!=null&&(i["x-name"]=e["x-name"],i["x-publicId"]=e["x-publicId"],i["x-systemId"]=e["x-systemId"]),r=i}else throw new Error("Not implemented yet: ".concat(e.type));return r.startIndex=e.startIndex,r.endIndex=e.endIndex,e.sourceCodeLocation!=null&&(r.sourceCodeLocation=e.sourceCodeLocation),r}be.cloneNode=$i;function Xi(e){for(var t=e.map(function(u){return $i(u,!0)}),r=1;r<t.length;r++)t[r].prev=t[r-1],t[r-1].next=t[r];return t}});var st=R(ur=>{"use strict";var pE=ur&&ur.__createBinding||(Object.create?function(e,t,r,u){u===void 0&&(u=r);var a=Object.getOwnPropertyDescriptor(t,r);(!a||("get"in a?!t.__esModule:a.writable||a.configurable))&&(a={enumerable:!0,get:function(){return t[r]}}),Object.defineProperty(e,u,a)}:function(e,t,r,u){u===void 0&&(u=r),e[u]=t[r]}),bE=ur&&ur.__exportStar||function(e,t){for(var r in e)r!=="default"&&!Object.prototype.hasOwnProperty.call(t,r)&&pE(t,e,r)};Object.defineProperty(ur,"__esModule",{value:!0});ur.DomHandler=void 0;var Ji=qu(),Gr=Zi();bE(Zi(),ur);var xf={withStartIndices:!1,withEndIndices:!1,xmlMode:!1},Af=function(){function e(t,r,u){this.dom=[],this.root=new Gr.Document(this.dom),this.done=!1,this.tagStack=[this.root],this.lastNode=null,this.parser=null,typeof r=="function"&&(u=r,r=xf),typeof t=="object"&&(r=t,t=void 0),this.callback=t!=null?t:null,this.options=r!=null?r:xf,this.elementCB=u!=null?u:null}return e.prototype.onparserinit=function(t){this.parser=t},e.prototype.onreset=function(){this.dom=[],this.root=new Gr.Document(this.dom),this.done=!1,this.tagStack=[this.root],this.lastNode=null,this.parser=null},e.prototype.onend=function(){this.done||(this.done=!0,this.parser=null,this.handleCallback(null))},e.prototype.onerror=function(t){this.handleCallback(t)},e.prototype.onclosetag=function(){this.lastNode=null;var t=this.tagStack.pop();this.options.withEndIndices&&(t.endIndex=this.parser.endIndex),this.elementCB&&this.elementCB(t)},e.prototype.onopentag=function(t,r){var u=this.options.xmlMode?Ji.ElementType.Tag:void 0,a=new Gr.Element(t,r,void 0,u);this.addNode(a),this.tagStack.push(a)},e.prototype.ontext=function(t){var r=this.lastNode;if(r&&r.type===Ji.ElementType.Text)r.data+=t,this.options.withEndIndices&&(r.endIndex=this.parser.endIndex);else{var u=new Gr.Text(t);this.addNode(u),this.lastNode=u}},e.prototype.oncomment=function(t){if(this.lastNode&&this.lastNode.type===Ji.ElementType.Comment){this.lastNode.data+=t;return}var r=new Gr.Comment(t);this.addNode(r),this.lastNode=r},e.prototype.oncommentend=function(){this.lastNode=null},e.prototype.oncdatastart=function(){var t=new Gr.Text(""),r=new Gr.CDATA([t]);this.addNode(r),t.parent=r,this.lastNode=t},e.prototype.oncdataend=function(){this.lastNode=null},e.prototype.onprocessinginstruction=function(t,r){var u=new Gr.ProcessingInstruction(t,r);this.addNode(u)},e.prototype.handleCallback=function(t){if(typeof this.callback=="function")this.callback(t,this.dom);else if(t)throw t},e.prototype.addNode=function(t){var r=this.tagStack[this.tagStack.length-1],u=r.children[r.children.length-1];this.options.withStartIndices&&(t.startIndex=this.parser.startIndex),this.options.withEndIndices&&(t.endIndex=this.parser.endIndex),r.children.push(t),u&&(t.prev=u,u.next=t),t.parent=r,this.lastNode=null},e}();ur.DomHandler=Af;ur.default=Af});var mf=R(es=>{"use strict";Object.defineProperty(es,"__esModule",{value:!0});es.default=new Uint16Array(\'ᵁ<Õıʊҝջאٵ۞ޢߖࠏ੊ઑඡ๭༉༦჊ረዡᐕᒝᓃᓟᔥ\\0\\0\\0\\0\\0\\0ᕫᛍᦍᰒᷝ὾⁠↰⊍⏀⏻⑂⠤⤒ⴈ⹈⿎〖㊺㘹㞬㣾㨨㩱㫠㬮ࠀEMabcfglmnoprstu\\\\bfms¦³¹ÈÏlig耻Æ䃆P耻&䀦cute耻Á䃁reve;䄂Āiyx}rc耻Â䃂;䐐r;쀀𝔄rave耻À䃀pha;䎑acr;䄀d;橓Āgp¡on;䄄f;쀀𝔸plyFunction;恡ing耻Å䃅Ācs¾Ãr;쀀𝒜ign;扔ilde耻Ã䃃ml耻Ä䃄ЀaceforsuåûþėĜĢħĪĀcrêòkslash;或Ŷöø;櫧ed;挆y;䐑ƀcrtąċĔause;戵noullis;愬a;䎒r;쀀𝔅pf;쀀𝔹eve;䋘còēmpeq;扎܀HOacdefhilorsuōőŖƀƞƢƵƷƺǜȕɳɸɾcy;䐧PY耻©䂩ƀcpyŝŢźute;䄆Ā;iŧŨ拒talDifferentialD;慅leys;愭ȀaeioƉƎƔƘron;䄌dil耻Ç䃇rc;䄈nint;戰ot;䄊ĀdnƧƭilla;䂸terDot;䂷òſi;䎧rcleȀDMPTǇǋǑǖot;抙inus;抖lus;投imes;抗oĀcsǢǸkwiseContourIntegral;戲eCurlyĀDQȃȏoubleQuote;思uote;怙ȀlnpuȞȨɇɕonĀ;eȥȦ户;橴ƀgitȯȶȺruent;扡nt;戯ourIntegral;戮ĀfrɌɎ;愂oduct;成nterClockwiseContourIntegral;戳oss;樯cr;쀀𝒞pĀ;Cʄʅ拓ap;才րDJSZacefiosʠʬʰʴʸˋ˗ˡ˦̳ҍĀ;oŹʥtrahd;椑cy;䐂cy;䐅cy;䐏ƀgrsʿ˄ˇger;怡r;憡hv;櫤Āayː˕ron;䄎;䐔lĀ;t˝˞戇a;䎔r;쀀𝔇Āaf˫̧Ācm˰̢riticalȀADGT̖̜̀̆cute;䂴oŴ̋̍;䋙bleAcute;䋝rave;䁠ilde;䋜ond;拄ferentialD;慆Ѱ̽\\0\\0\\0͔͂\\0Ѕf;쀀𝔻ƀ;DE͈͉͍䂨ot;惜qual;扐blèCDLRUVͣͲ΂ϏϢϸontourIntegraìȹoɴ͹\\0\\0ͻ»͉nArrow;懓Āeo·ΤftƀARTΐΖΡrrow;懐ightArrow;懔eåˊngĀLRΫτeftĀARγιrrow;柸ightArrow;柺ightArrow;柹ightĀATϘϞrrow;懒ee;抨pɁϩ\\0\\0ϯrrow;懑ownArrow;懕erticalBar;戥ǹABLRTaВЪаўѿͼrrowƀ;BUНОТ憓ar;椓pArrow;懵reve;䌑eft˒к\\0ц\\0ѐightVector;楐eeVector;楞ectorĀ;Bљњ憽ar;楖ightǔѧ\\0ѱeeVector;楟ectorĀ;BѺѻ懁ar;楗eeĀ;A҆҇护rrow;憧ĀctҒҗr;쀀𝒟rok;䄐ࠀNTacdfglmopqstuxҽӀӄӋӞӢӧӮӵԡԯԶՒ՝ՠեG;䅊H耻Ð䃐cute耻É䃉ƀaiyӒӗӜron;䄚rc耻Ê䃊;䐭ot;䄖r;쀀𝔈rave耻È䃈ement;戈ĀapӺӾcr;䄒tyɓԆ\\0\\0ԒmallSquare;旻erySmallSquare;斫ĀgpԦԪon;䄘f;쀀𝔼silon;䎕uĀaiԼՉlĀ;TՂՃ橵ilde;扂librium;懌Āci՗՚r;愰m;橳a;䎗ml耻Ë䃋Āipժկsts;戃onentialE;慇ʀcfiosօֈ֍ֲ׌y;䐤r;쀀𝔉lledɓ֗\\0\\0֣mallSquare;旼erySmallSquare;斪Ͱֺ\\0ֿ\\0\\0ׄf;쀀𝔽All;戀riertrf;愱cò׋؀JTabcdfgorstר׬ׯ׺؀ؒؖ؛؝أ٬ٲcy;䐃耻>䀾mmaĀ;d׷׸䎓;䏜reve;䄞ƀeiy؇،ؐdil;䄢rc;䄜;䐓ot;䄠r;쀀𝔊;拙pf;쀀𝔾eater̀EFGLSTصلَٖٛ٦qualĀ;Lؾؿ扥ess;招ullEqual;执reater;檢ess;扷lantEqual;橾ilde;扳cr;쀀𝒢;扫ЀAacfiosuڅڋږڛڞڪھۊRDcy;䐪Āctڐڔek;䋇;䁞irc;䄤r;愌lbertSpace;愋ǰگ\\0ڲf;愍izontalLine;攀Āctۃۅòکrok;䄦mpńېۘownHumðįqual;扏܀EJOacdfgmnostuۺ۾܃܇܎ܚܞܡܨ݄ݸދޏޕcy;䐕lig;䄲cy;䐁cute耻Í䃍Āiyܓܘrc耻Î䃎;䐘ot;䄰r;愑rave耻Ì䃌ƀ;apܠܯܿĀcgܴܷr;䄪inaryI;慈lieóϝǴ݉\\0ݢĀ;eݍݎ戬Āgrݓݘral;戫section;拂isibleĀCTݬݲomma;恣imes;恢ƀgptݿރވon;䄮f;쀀𝕀a;䎙cr;愐ilde;䄨ǫޚ\\0ޞcy;䐆l耻Ï䃏ʀcfosuެ޷޼߂ߐĀiyޱ޵rc;䄴;䐙r;쀀𝔍pf;쀀𝕁ǣ߇\\0ߌr;쀀𝒥rcy;䐈kcy;䐄΀HJacfosߤߨ߽߬߱ࠂࠈcy;䐥cy;䐌ppa;䎚Āey߶߻dil;䄶;䐚r;쀀𝔎pf;쀀𝕂cr;쀀𝒦րJTaceflmostࠥࠩࠬࡐࡣ঳সে্਷ੇcy;䐉耻<䀼ʀcmnpr࠷࠼ࡁࡄࡍute;䄹bda;䎛g;柪lacetrf;愒r;憞ƀaeyࡗ࡜ࡡron;䄽dil;䄻;䐛Āfsࡨ॰tԀACDFRTUVarࡾࢩࢱࣦ࣠ࣼयज़ΐ४Ānrࢃ࢏gleBracket;柨rowƀ;BR࢙࢚࢞憐ar;懤ightArrow;懆eiling;挈oǵࢷ\\0ࣃbleBracket;柦nǔࣈ\\0࣒eeVector;楡ectorĀ;Bࣛࣜ懃ar;楙loor;挊ightĀAV࣯ࣵrrow;憔ector;楎Āerँगeƀ;AVउऊऐ抣rrow;憤ector;楚iangleƀ;BEतथऩ抲ar;槏qual;抴pƀDTVषूौownVector;楑eeVector;楠ectorĀ;Bॖॗ憿ar;楘ectorĀ;B॥०憼ar;楒ightáΜs̀EFGLSTॾঋকঝঢভqualGreater;拚ullEqual;扦reater;扶ess;檡lantEqual;橽ilde;扲r;쀀𝔏Ā;eঽা拘ftarrow;懚idot;䄿ƀnpw৔ਖਛgȀLRlr৞৷ਂਐeftĀAR০৬rrow;柵ightArrow;柷ightArrow;柶eftĀarγਊightáοightáϊf;쀀𝕃erĀLRਢਬeftArrow;憙ightArrow;憘ƀchtਾੀੂòࡌ;憰rok;䅁;扪Ѐacefiosuਗ਼੝੠੷੼અઋ઎p;椅y;䐜Ādl੥੯iumSpace;恟lintrf;愳r;쀀𝔐nusPlus;戓pf;쀀𝕄cò੶;䎜ҀJacefostuણધભીଔଙඑ඗ඞcy;䐊cute;䅃ƀaey઴હાron;䅇dil;䅅;䐝ƀgswે૰଎ativeƀMTV૓૟૨ediumSpace;怋hiĀcn૦૘ë૙eryThiî૙tedĀGL૸ଆreaterGreateòٳessLesóੈLine;䀊r;쀀𝔑ȀBnptଢନଷ଺reak;恠BreakingSpace;䂠f;愕ڀ;CDEGHLNPRSTV୕ୖ୪୼஡௫ఄ౞಄ದ೘ൡඅ櫬Āou୛୤ngruent;扢pCap;扭oubleVerticalBar;戦ƀlqxஃஊ஛ement;戉ualĀ;Tஒஓ扠ilde;쀀≂̸ists;戄reater΀;EFGLSTஶஷ஽௉௓௘௥扯qual;扱ullEqual;쀀≧̸reater;쀀≫̸ess;批lantEqual;쀀⩾̸ilde;扵umpń௲௽ownHump;쀀≎̸qual;쀀≏̸eĀfsఊధtTriangleƀ;BEచఛడ拪ar;쀀⧏̸qual;括s̀;EGLSTవశ఼ౄోౘ扮qual;扰reater;扸ess;쀀≪̸lantEqual;쀀⩽̸ilde;扴estedĀGL౨౹reaterGreater;쀀⪢̸essLess;쀀⪡̸recedesƀ;ESಒಓಛ技qual;쀀⪯̸lantEqual;拠ĀeiಫಹverseElement;戌ghtTriangleƀ;BEೋೌ೒拫ar;쀀⧐̸qual;拭ĀquೝഌuareSuĀbp೨೹setĀ;E೰ೳ쀀⊏̸qual;拢ersetĀ;Eഃആ쀀⊐̸qual;拣ƀbcpഓതൎsetĀ;Eഛഞ쀀⊂⃒qual;抈ceedsȀ;ESTലള഻െ抁qual;쀀⪰̸lantEqual;拡ilde;쀀≿̸ersetĀ;E൘൛쀀⊃⃒qual;抉ildeȀ;EFT൮൯൵ൿ扁qual;扄ullEqual;扇ilde;扉erticalBar;戤cr;쀀𝒩ilde耻Ñ䃑;䎝܀Eacdfgmoprstuvලෂ෉෕ෛ෠෧෼ขภยา฿ไlig;䅒cute耻Ó䃓Āiy෎ීrc耻Ô䃔;䐞blac;䅐r;쀀𝔒rave耻Ò䃒ƀaei෮ෲ෶cr;䅌ga;䎩cron;䎟pf;쀀𝕆enCurlyĀDQฎบoubleQuote;怜uote;怘;橔Āclวฬr;쀀𝒪ash耻Ø䃘iŬื฼de耻Õ䃕es;樷ml耻Ö䃖erĀBP๋๠Āar๐๓r;怾acĀek๚๜;揞et;掴arenthesis;揜Ҁacfhilors๿ງຊຏຒດຝະ໼rtialD;戂y;䐟r;쀀𝔓i;䎦;䎠usMinus;䂱Āipຢອncareplanåڝf;愙Ȁ;eio຺ູ໠໤檻cedesȀ;EST່້໏໚扺qual;檯lantEqual;扼ilde;找me;怳Ādp໩໮uct;戏ortionĀ;aȥ໹l;戝Āci༁༆r;쀀𝒫;䎨ȀUfos༑༖༛༟OT耻"䀢r;쀀𝔔pf;愚cr;쀀𝒬؀BEacefhiorsu༾གྷཇའཱིྦྷྪྭ႖ႩႴႾarr;椐G耻®䂮ƀcnrཎནབute;䅔g;柫rĀ;tཛྷཝ憠l;椖ƀaeyཧཬཱron;䅘dil;䅖;䐠Ā;vླྀཹ愜erseĀEUྂྙĀlq྇ྎement;戋uilibrium;懋pEquilibrium;楯r»ཹo;䎡ghtЀACDFTUVa࿁࿫࿳ဢဨၛႇϘĀnr࿆࿒gleBracket;柩rowƀ;BL࿜࿝࿡憒ar;懥eftArrow;懄eiling;按oǵ࿹\\0စbleBracket;柧nǔည\\0နeeVector;楝ectorĀ;Bဝသ懂ar;楕loor;挋Āerိ၃eƀ;AVဵံြ抢rrow;憦ector;楛iangleƀ;BEၐၑၕ抳ar;槐qual;抵pƀDTVၣၮၸownVector;楏eeVector;楜ectorĀ;Bႂႃ憾ar;楔ectorĀ;B႑႒懀ar;楓Āpuႛ႞f;愝ndImplies;楰ightarrow;懛ĀchႹႼr;愛;憱leDelayed;槴ڀHOacfhimoqstuფჱჷჽᄙᄞᅑᅖᅡᅧᆵᆻᆿĀCcჩხHcy;䐩y;䐨FTcy;䐬cute;䅚ʀ;aeiyᄈᄉᄎᄓᄗ檼ron;䅠dil;䅞rc;䅜;䐡r;쀀𝔖ortȀDLRUᄪᄴᄾᅉownArrow»ОeftArrow»࢚ightArrow»࿝pArrow;憑gma;䎣allCircle;战pf;쀀𝕊ɲᅭ\\0\\0ᅰt;戚areȀ;ISUᅻᅼᆉᆯ斡ntersection;抓uĀbpᆏᆞsetĀ;Eᆗᆘ抏qual;抑ersetĀ;Eᆨᆩ抐qual;抒nion;抔cr;쀀𝒮ar;拆ȀbcmpᇈᇛሉላĀ;sᇍᇎ拐etĀ;Eᇍᇕqual;抆ĀchᇠህeedsȀ;ESTᇭᇮᇴᇿ扻qual;檰lantEqual;扽ilde;承Tháྌ;我ƀ;esሒሓሣ拑rsetĀ;Eሜም抃qual;抇et»ሓրHRSacfhiorsሾቄ቉ቕ቞ቱቶኟዂወዑORN耻Þ䃞ADE;愢ĀHc቎ቒcy;䐋y;䐦Ābuቚቜ;䀉;䎤ƀaeyብቪቯron;䅤dil;䅢;䐢r;쀀𝔗Āeiቻ኉ǲኀ\\0ኇefore;戴a;䎘Ācn኎ኘkSpace;쀀  Space;怉ldeȀ;EFTካኬኲኼ戼qual;扃ullEqual;扅ilde;扈pf;쀀𝕋ipleDot;惛Āctዖዛr;쀀𝒯rok;䅦ૡዷጎጚጦ\\0ጬጱ\\0\\0\\0\\0\\0ጸጽ፷ᎅ\\0᏿ᐄᐊᐐĀcrዻጁute耻Ú䃚rĀ;oጇገ憟cir;楉rǣጓ\\0጖y;䐎ve;䅬Āiyጞጣrc耻Û䃛;䐣blac;䅰r;쀀𝔘rave耻Ù䃙acr;䅪Ādiፁ፩erĀBPፈ፝Āarፍፐr;䁟acĀekፗፙ;揟et;掵arenthesis;揝onĀ;P፰፱拃lus;抎Āgp፻፿on;䅲f;쀀𝕌ЀADETadps᎕ᎮᎸᏄϨᏒᏗᏳrrowƀ;BDᅐᎠᎤar;椒ownArrow;懅ownArrow;憕quilibrium;楮eeĀ;AᏋᏌ报rrow;憥ownáϳerĀLRᏞᏨeftArrow;憖ightArrow;憗iĀ;lᏹᏺ䏒on;䎥ing;䅮cr;쀀𝒰ilde;䅨ml耻Ü䃜ҀDbcdefosvᐧᐬᐰᐳᐾᒅᒊᒐᒖash;披ar;櫫y;䐒ashĀ;lᐻᐼ抩;櫦Āerᑃᑅ;拁ƀbtyᑌᑐᑺar;怖Ā;iᑏᑕcalȀBLSTᑡᑥᑪᑴar;戣ine;䁼eparator;杘ilde;所ThinSpace;怊r;쀀𝔙pf;쀀𝕍cr;쀀𝒱dash;抪ʀcefosᒧᒬᒱᒶᒼirc;䅴dge;拀r;쀀𝔚pf;쀀𝕎cr;쀀𝒲Ȁfiosᓋᓐᓒᓘr;쀀𝔛;䎞pf;쀀𝕏cr;쀀𝒳ҀAIUacfosuᓱᓵᓹᓽᔄᔏᔔᔚᔠcy;䐯cy;䐇cy;䐮cute耻Ý䃝Āiyᔉᔍrc;䅶;䐫r;쀀𝔜pf;쀀𝕐cr;쀀𝒴ml;䅸ЀHacdefosᔵᔹᔿᕋᕏᕝᕠᕤcy;䐖cute;䅹Āayᕄᕉron;䅽;䐗ot;䅻ǲᕔ\\0ᕛoWidtè૙a;䎖r;愨pf;愤cr;쀀𝒵௡ᖃᖊᖐ\\0ᖰᖶᖿ\\0\\0\\0\\0ᗆᗛᗫᙟ᙭\\0ᚕ᚛ᚲᚹ\\0ᚾcute耻á䃡reve;䄃̀;Ediuyᖜᖝᖡᖣᖨᖭ戾;쀀∾̳;房rc耻â䃢te肻´̆;䐰lig耻æ䃦Ā;r²ᖺ;쀀𝔞rave耻à䃠ĀepᗊᗖĀfpᗏᗔsym;愵èᗓha;䎱ĀapᗟcĀclᗤᗧr;䄁g;樿ɤᗰ\\0\\0ᘊʀ;adsvᗺᗻᗿᘁᘇ戧nd;橕;橜lope;橘;橚΀;elmrszᘘᘙᘛᘞᘿᙏᙙ戠;榤e»ᘙsdĀ;aᘥᘦ戡ѡᘰᘲᘴᘶᘸᘺᘼᘾ;榨;榩;榪;榫;榬;榭;榮;榯tĀ;vᙅᙆ戟bĀ;dᙌᙍ抾;榝Āptᙔᙗh;戢»¹arr;捼Āgpᙣᙧon;䄅f;쀀𝕒΀;Eaeiop዁ᙻᙽᚂᚄᚇᚊ;橰cir;橯;扊d;手s;䀧roxĀ;e዁ᚒñᚃing耻å䃥ƀctyᚡᚦᚨr;쀀𝒶;䀪mpĀ;e዁ᚯñʈilde耻ã䃣ml耻ä䃤Āciᛂᛈoninôɲnt;樑ࠀNabcdefiklnoprsu᛭ᛱᜰ᜼ᝃᝈ᝸᝽០៦ᠹᡐᜍ᤽᥈ᥰot;櫭Ācrᛶ᜞kȀcepsᜀᜅᜍᜓong;扌psilon;䏶rime;怵imĀ;e᜚᜛戽q;拍Ŷᜢᜦee;抽edĀ;gᜬᜭ挅e»ᜭrkĀ;t፜᜷brk;掶Āoyᜁᝁ;䐱quo;怞ʀcmprtᝓ᝛ᝡᝤᝨausĀ;eĊĉptyv;榰séᜌnoõēƀahwᝯ᝱ᝳ;䎲;愶een;扬r;쀀𝔟g΀costuvwឍឝឳេ៕៛៞ƀaiuបពរðݠrc;旯p»፱ƀdptឤឨឭot;樀lus;樁imes;樂ɱឹ\\0\\0ើcup;樆ar;昅riangleĀdu៍្own;施p;斳plus;樄eåᑄåᒭarow;植ƀako៭ᠦᠵĀcn៲ᠣkƀlst៺֫᠂ozenge;槫riangleȀ;dlr᠒᠓᠘᠝斴own;斾eft;旂ight;斸k;搣Ʊᠫ\\0ᠳƲᠯ\\0ᠱ;斒;斑4;斓ck;斈ĀeoᠾᡍĀ;qᡃᡆ쀀=⃥uiv;쀀≡⃥t;挐Ȁptwxᡙᡞᡧᡬf;쀀𝕓Ā;tᏋᡣom»Ꮜtie;拈؀DHUVbdhmptuvᢅᢖᢪᢻᣗᣛᣬ᣿ᤅᤊᤐᤡȀLRlrᢎᢐᢒᢔ;敗;敔;敖;敓ʀ;DUduᢡᢢᢤᢦᢨ敐;敦;敩;敤;敧ȀLRlrᢳᢵᢷᢹ;敝;敚;敜;教΀;HLRhlrᣊᣋᣍᣏᣑᣓᣕ救;敬;散;敠;敫;敢;敟ox;槉ȀLRlrᣤᣦᣨᣪ;敕;敒;攐;攌ʀ;DUduڽ᣷᣹᣻᣽;敥;敨;攬;攴inus;抟lus;択imes;抠ȀLRlrᤙᤛᤝ᤟;敛;敘;攘;攔΀;HLRhlrᤰᤱᤳᤵᤷ᤻᤹攂;敪;敡;敞;攼;攤;攜Āevģ᥂bar耻¦䂦Ȁceioᥑᥖᥚᥠr;쀀𝒷mi;恏mĀ;e᜚᜜lƀ;bhᥨᥩᥫ䁜;槅sub;柈Ŭᥴ᥾lĀ;e᥹᥺怢t»᥺pƀ;Eeįᦅᦇ;檮Ā;qۜۛೡᦧ\\0᧨ᨑᨕᨲ\\0ᨷᩐ\\0\\0᪴\\0\\0᫁\\0\\0ᬡᬮ᭍᭒\\0᯽\\0ᰌƀcpr᦭ᦲ᧝ute;䄇̀;abcdsᦿᧀᧄ᧊᧕᧙戩nd;橄rcup;橉Āau᧏᧒p;橋p;橇ot;橀;쀀∩︀Āeo᧢᧥t;恁îړȀaeiu᧰᧻ᨁᨅǰ᧵\\0᧸s;橍on;䄍dil耻ç䃧rc;䄉psĀ;sᨌᨍ橌m;橐ot;䄋ƀdmnᨛᨠᨦil肻¸ƭptyv;榲t脀¢;eᨭᨮ䂢räƲr;쀀𝔠ƀceiᨽᩀᩍy;䑇ckĀ;mᩇᩈ朓ark»ᩈ;䏇r΀;Ecefms᩟᩠ᩢᩫ᪤᪪᪮旋;槃ƀ;elᩩᩪᩭ䋆q;扗eɡᩴ\\0\\0᪈rrowĀlr᩼᪁eft;憺ight;憻ʀRSacd᪒᪔᪖᪚᪟»ཇ;擈st;抛irc;抚ash;抝nint;樐id;櫯cir;槂ubsĀ;u᪻᪼晣it»᪼ˬ᫇᫔᫺\\0ᬊonĀ;eᫍᫎ䀺Ā;qÇÆɭ᫙\\0\\0᫢aĀ;t᫞᫟䀬;䁀ƀ;fl᫨᫩᫫戁îᅠeĀmx᫱᫶ent»᫩eóɍǧ᫾\\0ᬇĀ;dኻᬂot;橭nôɆƀfryᬐᬔᬗ;쀀𝕔oäɔ脀©;sŕᬝr;愗Āaoᬥᬩrr;憵ss;朗Ācuᬲᬷr;쀀𝒸Ābpᬼ᭄Ā;eᭁᭂ櫏;櫑Ā;eᭉᭊ櫐;櫒dot;拯΀delprvw᭠᭬᭷ᮂᮬᯔ᯹arrĀlr᭨᭪;椸;椵ɰ᭲\\0\\0᭵r;拞c;拟arrĀ;p᭿ᮀ憶;椽̀;bcdosᮏᮐᮖᮡᮥᮨ截rcap;橈Āauᮛᮞp;橆p;橊ot;抍r;橅;쀀∪︀Ȁalrv᮵ᮿᯞᯣrrĀ;mᮼᮽ憷;椼yƀevwᯇᯔᯘqɰᯎ\\0\\0ᯒreã᭳uã᭵ee;拎edge;拏en耻¤䂤earrowĀlrᯮ᯳eft»ᮀight»ᮽeäᯝĀciᰁᰇoninôǷnt;戱lcty;挭ঀAHabcdefhijlorstuwz᰸᰻᰿ᱝᱩᱵᲊᲞᲬᲷ᳻᳿ᴍᵻᶑᶫᶻ᷆᷍rò΁ar;楥Ȁglrs᱈ᱍ᱒᱔ger;怠eth;愸òᄳhĀ;vᱚᱛ怐»ऊūᱡᱧarow;椏aã̕Āayᱮᱳron;䄏;䐴ƀ;ao̲ᱼᲄĀgrʿᲁr;懊tseq;橷ƀglmᲑᲔᲘ耻°䂰ta;䎴ptyv;榱ĀirᲣᲨsht;楿;쀀𝔡arĀlrᲳᲵ»ࣜ»သʀaegsv᳂͸᳖᳜᳠mƀ;oș᳊᳔ndĀ;ș᳑uit;晦amma;䏝in;拲ƀ;io᳧᳨᳸䃷de脀÷;o᳧ᳰntimes;拇nø᳷cy;䑒cɯᴆ\\0\\0ᴊrn;挞op;挍ʀlptuwᴘᴝᴢᵉᵕlar;䀤f;쀀𝕕ʀ;emps̋ᴭᴷᴽᵂqĀ;d͒ᴳot;扑inus;戸lus;戔quare;抡blebarwedgåúnƀadhᄮᵝᵧownarrowóᲃarpoonĀlrᵲᵶefôᲴighôᲶŢᵿᶅkaro÷གɯᶊ\\0\\0ᶎrn;挟op;挌ƀcotᶘᶣᶦĀryᶝᶡ;쀀𝒹;䑕l;槶rok;䄑Ādrᶰᶴot;拱iĀ;fᶺ᠖斿Āah᷀᷃ròЩaòྦangle;榦Āci᷒ᷕy;䑟grarr;柿ऀDacdefglmnopqrstuxḁḉḙḸոḼṉṡṾấắẽỡἪἷὄ὎὚ĀDoḆᴴoôᲉĀcsḎḔute耻é䃩ter;橮ȀaioyḢḧḱḶron;䄛rĀ;cḭḮ扖耻ê䃪lon;払;䑍ot;䄗ĀDrṁṅot;扒;쀀𝔢ƀ;rsṐṑṗ檚ave耻è䃨Ā;dṜṝ檖ot;檘Ȁ;ilsṪṫṲṴ檙nters;揧;愓Ā;dṹṺ檕ot;檗ƀapsẅẉẗcr;䄓tyƀ;svẒẓẕ戅et»ẓpĀ1;ẝẤĳạả;怄;怅怃ĀgsẪẬ;䅋p;怂ĀgpẴẸon;䄙f;쀀𝕖ƀalsỄỎỒrĀ;sỊị拕l;槣us;橱iƀ;lvỚớở䎵on»ớ;䏵ȀcsuvỪỳἋἣĀioữḱrc»Ḯɩỹ\\0\\0ỻíՈantĀglἂἆtr»ṝess»Ṻƀaeiἒ἖Ἒls;䀽st;扟vĀ;DȵἠD;橸parsl;槥ĀDaἯἳot;打rr;楱ƀcdiἾὁỸr;愯oô͒ĀahὉὋ;䎷耻ð䃰Āmrὓὗl耻ë䃫o;悬ƀcipὡὤὧl;䀡sôծĀeoὬὴctatioîՙnentialåչৡᾒ\\0ᾞ\\0ᾡᾧ\\0\\0ῆῌ\\0ΐ\\0ῦῪ \\0 ⁚llingdotseñṄy;䑄male;晀ƀilrᾭᾳ῁lig;耀ﬃɩᾹ\\0\\0᾽g;耀ﬀig;耀ﬄ;쀀𝔣lig;耀ﬁlig;쀀fjƀaltῙ῜ῡt;晭ig;耀ﬂns;斱of;䆒ǰ΅\\0ῳf;쀀𝕗ĀakֿῷĀ;vῼ´拔;櫙artint;樍Āao‌⁕Ācs‑⁒α‚‰‸⁅⁈\\0⁐β•‥‧‪‬\\0‮耻½䂽;慓耻¼䂼;慕;慙;慛Ƴ‴\\0‶;慔;慖ʴ‾⁁\\0\\0⁃耻¾䂾;慗;慜5;慘ƶ⁌\\0⁎;慚;慝8;慞l;恄wn;挢cr;쀀𝒻ࢀEabcdefgijlnorstv₂₉₟₥₰₴⃰⃵⃺⃿℃ℒℸ̗ℾ⅒↞Ā;lٍ₇;檌ƀcmpₐₕ₝ute;䇵maĀ;dₜ᳚䎳;檆reve;䄟Āiy₪₮rc;䄝;䐳ot;䄡Ȁ;lqsؾق₽⃉ƀ;qsؾٌ⃄lanô٥Ȁ;cdl٥⃒⃥⃕c;檩otĀ;o⃜⃝檀Ā;l⃢⃣檂;檄Ā;e⃪⃭쀀⋛︀s;檔r;쀀𝔤Ā;gٳ؛mel;愷cy;䑓Ȁ;Eajٚℌℎℐ;檒;檥;檤ȀEaesℛℝ℩ℴ;扩pĀ;p℣ℤ檊rox»ℤĀ;q℮ℯ檈Ā;q℮ℛim;拧pf;쀀𝕘Āci⅃ⅆr;愊mƀ;el٫ⅎ⅐;檎;檐茀>;cdlqr׮ⅠⅪⅮⅳⅹĀciⅥⅧ;檧r;橺ot;拗Par;榕uest;橼ʀadelsↄⅪ←ٖ↛ǰ↉\\0↎proø₞r;楸qĀlqؿ↖lesó₈ií٫Āen↣↭rtneqq;쀀≩︀Å↪ԀAabcefkosy⇄⇇⇱⇵⇺∘∝∯≨≽ròΠȀilmr⇐⇔⇗⇛rsðᒄf»․ilôکĀdr⇠⇤cy;䑊ƀ;cwࣴ⇫⇯ir;楈;憭ar;意irc;䄥ƀalr∁∎∓rtsĀ;u∉∊晥it»∊lip;怦con;抹r;쀀𝔥sĀew∣∩arow;椥arow;椦ʀamopr∺∾≃≞≣rr;懿tht;戻kĀlr≉≓eftarrow;憩ightarrow;憪f;쀀𝕙bar;怕ƀclt≯≴≸r;쀀𝒽asè⇴rok;䄧Ābp⊂⊇ull;恃hen»ᱛૡ⊣\\0⊪\\0⊸⋅⋎\\0⋕⋳\\0\\0⋸⌢⍧⍢⍿\\0⎆⎪⎴cute耻í䃭ƀ;iyݱ⊰⊵rc耻î䃮;䐸Ācx⊼⊿y;䐵cl耻¡䂡ĀfrΟ⋉;쀀𝔦rave耻ì䃬Ȁ;inoܾ⋝⋩⋮Āin⋢⋦nt;樌t;戭fin;槜ta;愩lig;䄳ƀaop⋾⌚⌝ƀcgt⌅⌈⌗r;䄫ƀelpܟ⌏⌓inåގarôܠh;䄱f;抷ed;䆵ʀ;cfotӴ⌬⌱⌽⍁are;愅inĀ;t⌸⌹戞ie;槝doô⌙ʀ;celpݗ⍌⍐⍛⍡al;抺Āgr⍕⍙eróᕣã⍍arhk;樗rod;樼Ȁcgpt⍯⍲⍶⍻y;䑑on;䄯f;쀀𝕚a;䎹uest耻¿䂿Āci⎊⎏r;쀀𝒾nʀ;EdsvӴ⎛⎝⎡ӳ;拹ot;拵Ā;v⎦⎧拴;拳Ā;iݷ⎮lde;䄩ǫ⎸\\0⎼cy;䑖l耻ï䃯̀cfmosu⏌⏗⏜⏡⏧⏵Āiy⏑⏕rc;䄵;䐹r;쀀𝔧ath;䈷pf;쀀𝕛ǣ⏬\\0⏱r;쀀𝒿rcy;䑘kcy;䑔Ѐacfghjos␋␖␢␧␭␱␵␻ppaĀ;v␓␔䎺;䏰Āey␛␠dil;䄷;䐺r;쀀𝔨reen;䄸cy;䑅cy;䑜pf;쀀𝕜cr;쀀𝓀஀ABEHabcdefghjlmnoprstuv⑰⒁⒆⒍⒑┎┽╚▀♎♞♥♹♽⚚⚲⛘❝❨➋⟀⠁⠒ƀart⑷⑺⑼rò৆òΕail;椛arr;椎Ā;gঔ⒋;檋ar;楢ॣ⒥\\0⒪\\0⒱\\0\\0\\0\\0\\0⒵Ⓔ\\0ⓆⓈⓍ\\0⓹ute;䄺mptyv;榴raîࡌbda;䎻gƀ;dlࢎⓁⓃ;榑åࢎ;檅uo耻«䂫rЀ;bfhlpst࢙ⓞⓦⓩ⓫⓮⓱⓵Ā;f࢝ⓣs;椟s;椝ë≒p;憫l;椹im;楳l;憢ƀ;ae⓿─┄檫il;椙Ā;s┉┊檭;쀀⪭︀ƀabr┕┙┝rr;椌rk;杲Āak┢┬cĀek┨┪;䁻;䁛Āes┱┳;榋lĀdu┹┻;榏;榍Ȁaeuy╆╋╖╘ron;䄾Ādi═╔il;䄼ìࢰâ┩;䐻Ȁcqrs╣╦╭╽a;椶uoĀ;rนᝆĀdu╲╷har;楧shar;楋h;憲ʀ;fgqs▋▌উ◳◿扤tʀahlrt▘▤▷◂◨rrowĀ;t࢙□aé⓶arpoonĀdu▯▴own»њp»०eftarrows;懇ightƀahs◍◖◞rrowĀ;sࣴࢧarpoonó྘quigarro÷⇰hreetimes;拋ƀ;qs▋ও◺lanôবʀ;cdgsব☊☍☝☨c;檨otĀ;o☔☕橿Ā;r☚☛檁;檃Ā;e☢☥쀀⋚︀s;檓ʀadegs☳☹☽♉♋pproøⓆot;拖qĀgq♃♅ôউgtò⒌ôছiíলƀilr♕࣡♚sht;楼;쀀𝔩Ā;Eজ♣;檑š♩♶rĀdu▲♮Ā;l॥♳;楪lk;斄cy;䑙ʀ;achtੈ⚈⚋⚑⚖rò◁orneòᴈard;楫ri;旺Āio⚟⚤dot;䅀ustĀ;a⚬⚭掰che»⚭ȀEaes⚻⚽⛉⛔;扨pĀ;p⛃⛄檉rox»⛄Ā;q⛎⛏檇Ā;q⛎⚻im;拦Ѐabnoptwz⛩⛴⛷✚✯❁❇❐Ānr⛮⛱g;柬r;懽rëࣁgƀlmr⛿✍✔eftĀar০✇ightá৲apsto;柼ightá৽parrowĀlr✥✩efô⓭ight;憬ƀafl✶✹✽r;榅;쀀𝕝us;樭imes;樴š❋❏st;戗áፎƀ;ef❗❘᠀旊nge»❘arĀ;l❤❥䀨t;榓ʀachmt❳❶❼➅➇ròࢨorneòᶌarĀ;d྘➃;業;怎ri;抿̀achiqt➘➝ੀ➢➮➻quo;怹r;쀀𝓁mƀ;egল➪➬;檍;檏Ābu┪➳oĀ;rฟ➹;怚rok;䅂萀<;cdhilqrࠫ⟒☹⟜⟠⟥⟪⟰Āci⟗⟙;檦r;橹reå◲mes;拉arr;楶uest;橻ĀPi⟵⟹ar;榖ƀ;ef⠀भ᠛旃rĀdu⠇⠍shar;楊har;楦Āen⠗⠡rtneqq;쀀≨︀Å⠞܀Dacdefhilnopsu⡀⡅⢂⢎⢓⢠⢥⢨⣚⣢⣤ઃ⣳⤂Dot;戺Ȁclpr⡎⡒⡣⡽r耻¯䂯Āet⡗⡙;時Ā;e⡞⡟朠se»⡟Ā;sျ⡨toȀ;dluျ⡳⡷⡻owîҌefôएðᏑker;斮Āoy⢇⢌mma;権;䐼ash;怔asuredangle»ᘦr;쀀𝔪o;愧ƀcdn⢯⢴⣉ro耻µ䂵Ȁ;acdᑤ⢽⣀⣄sôᚧir;櫰ot肻·Ƶusƀ;bd⣒ᤃ⣓戒Ā;uᴼ⣘;横ţ⣞⣡p;櫛ò−ðઁĀdp⣩⣮els;抧f;쀀𝕞Āct⣸⣽r;쀀𝓂pos»ᖝƀ;lm⤉⤊⤍䎼timap;抸ఀGLRVabcdefghijlmoprstuvw⥂⥓⥾⦉⦘⧚⧩⨕⨚⩘⩝⪃⪕⪤⪨⬄⬇⭄⭿⮮ⰴⱧⱼ⳩Āgt⥇⥋;쀀⋙̸Ā;v⥐௏쀀≫⃒ƀelt⥚⥲⥶ftĀar⥡⥧rrow;懍ightarrow;懎;쀀⋘̸Ā;v⥻ే쀀≪⃒ightarrow;懏ĀDd⦎⦓ash;抯ash;抮ʀbcnpt⦣⦧⦬⦱⧌la»˞ute;䅄g;쀀∠⃒ʀ;Eiop඄⦼⧀⧅⧈;쀀⩰̸d;쀀≋̸s;䅉roø඄urĀ;a⧓⧔普lĀ;s⧓ସǳ⧟\\0⧣p肻 ଷmpĀ;e௹ఀʀaeouy⧴⧾⨃⨐⨓ǰ⧹\\0⧻;橃on;䅈dil;䅆ngĀ;dൾ⨊ot;쀀⩭̸p;橂;䐽ash;怓΀;Aadqsxஒ⨩⨭⨻⩁⩅⩐rr;懗rĀhr⨳⨶k;椤Ā;oᏲᏰot;쀀≐̸uiöୣĀei⩊⩎ar;椨í஘istĀ;s஠டr;쀀𝔫ȀEest௅⩦⩹⩼ƀ;qs஼⩭௡ƀ;qs஼௅⩴lanô௢ií௪Ā;rஶ⪁»ஷƀAap⪊⪍⪑rò⥱rr;憮ar;櫲ƀ;svྍ⪜ྌĀ;d⪡⪢拼;拺cy;䑚΀AEadest⪷⪺⪾⫂⫅⫶⫹rò⥦;쀀≦̸rr;憚r;急Ȁ;fqs఻⫎⫣⫯tĀar⫔⫙rro÷⫁ightarro÷⪐ƀ;qs఻⪺⫪lanôౕĀ;sౕ⫴»శiíౝĀ;rవ⫾iĀ;eచథiäඐĀpt⬌⬑f;쀀𝕟膀¬;in⬙⬚⬶䂬nȀ;Edvஉ⬤⬨⬮;쀀⋹̸ot;쀀⋵̸ǡஉ⬳⬵;拷;拶iĀ;vಸ⬼ǡಸ⭁⭃;拾;拽ƀaor⭋⭣⭩rȀ;ast୻⭕⭚⭟lleì୻l;쀀⫽⃥;쀀∂̸lint;樔ƀ;ceಒ⭰⭳uåಥĀ;cಘ⭸Ā;eಒ⭽ñಘȀAait⮈⮋⮝⮧rò⦈rrƀ;cw⮔⮕⮙憛;쀀⤳̸;쀀↝̸ghtarrow»⮕riĀ;eೋೖ΀chimpqu⮽⯍⯙⬄୸⯤⯯Ȁ;cerല⯆ഷ⯉uå൅;쀀𝓃ortɭ⬅\\0\\0⯖ará⭖mĀ;e൮⯟Ā;q൴൳suĀbp⯫⯭å೸åഋƀbcp⯶ⰑⰙȀ;Ees⯿ⰀഢⰄ抄;쀀⫅̸etĀ;eഛⰋqĀ;qണⰀcĀ;eലⰗñസȀ;EesⰢⰣൟⰧ抅;쀀⫆̸etĀ;e൘ⰮqĀ;qൠⰣȀgilrⰽⰿⱅⱇìௗlde耻ñ䃱çృiangleĀlrⱒⱜeftĀ;eచⱚñదightĀ;eೋⱥñ೗Ā;mⱬⱭ䎽ƀ;esⱴⱵⱹ䀣ro;愖p;怇ҀDHadgilrsⲏⲔⲙⲞⲣⲰⲶⳓⳣash;抭arr;椄p;쀀≍⃒ash;抬ĀetⲨⲬ;쀀≥⃒;쀀>⃒nfin;槞ƀAetⲽⳁⳅrr;椂;쀀≤⃒Ā;rⳊⳍ쀀<⃒ie;쀀⊴⃒ĀAtⳘⳜrr;椃rie;쀀⊵⃒im;쀀∼⃒ƀAan⳰⳴ⴂrr;懖rĀhr⳺⳽k;椣Ā;oᏧᏥear;椧ቓ᪕\\0\\0\\0\\0\\0\\0\\0\\0\\0\\0\\0\\0\\0ⴭ\\0ⴸⵈⵠⵥ⵲ⶄᬇ\\0\\0ⶍⶫ\\0ⷈⷎ\\0ⷜ⸙⸫⸾⹃Ācsⴱ᪗ute耻ó䃳ĀiyⴼⵅrĀ;c᪞ⵂ耻ô䃴;䐾ʀabios᪠ⵒⵗǈⵚlac;䅑v;樸old;榼lig;䅓Ācr⵩⵭ir;榿;쀀𝔬ͯ⵹\\0\\0⵼\\0ⶂn;䋛ave耻ò䃲;槁Ābmⶈ෴ar;榵Ȁacitⶕ⶘ⶥⶨrò᪀Āir⶝ⶠr;榾oss;榻nå๒;槀ƀaeiⶱⶵⶹcr;䅍ga;䏉ƀcdnⷀⷅǍron;䎿;榶pf;쀀𝕠ƀaelⷔ⷗ǒr;榷rp;榹΀;adiosvⷪⷫⷮ⸈⸍⸐⸖戨rò᪆Ȁ;efmⷷⷸ⸂⸅橝rĀ;oⷾⷿ愴f»ⷿ耻ª䂪耻º䂺gof;抶r;橖lope;橗;橛ƀclo⸟⸡⸧ò⸁ash耻ø䃸l;折iŬⸯ⸴de耻õ䃵esĀ;aǛ⸺s;樶ml耻ö䃶bar;挽ૡ⹞\\0⹽\\0⺀⺝\\0⺢⺹\\0\\0⻋ຜ\\0⼓\\0\\0⼫⾼\\0⿈rȀ;astЃ⹧⹲຅脀¶;l⹭⹮䂶leìЃɩ⹸\\0\\0⹻m;櫳;櫽y;䐿rʀcimpt⺋⺏⺓ᡥ⺗nt;䀥od;䀮il;怰enk;怱r;쀀𝔭ƀimo⺨⺰⺴Ā;v⺭⺮䏆;䏕maô੶ne;明ƀ;tv⺿⻀⻈䏀chfork»´;䏖Āau⻏⻟nĀck⻕⻝kĀ;h⇴⻛;愎ö⇴sҀ;abcdemst⻳⻴ᤈ⻹⻽⼄⼆⼊⼎䀫cir;樣ir;樢Āouᵀ⼂;樥;橲n肻±ຝim;樦wo;樧ƀipu⼙⼠⼥ntint;樕f;쀀𝕡nd耻£䂣Ԁ;Eaceinosu່⼿⽁⽄⽇⾁⾉⾒⽾⾶;檳p;檷uå໙Ā;c໎⽌̀;acens່⽙⽟⽦⽨⽾pproø⽃urlyeñ໙ñ໎ƀaes⽯⽶⽺pprox;檹qq;檵im;拨iíໟmeĀ;s⾈ຮ怲ƀEas⽸⾐⽺ð⽵ƀdfp໬⾙⾯ƀals⾠⾥⾪lar;挮ine;挒urf;挓Ā;t໻⾴ï໻rel;抰Āci⿀⿅r;쀀𝓅;䏈ncsp;怈̀fiopsu⿚⋢⿟⿥⿫⿱r;쀀𝔮pf;쀀𝕢rime;恗cr;쀀𝓆ƀaeo⿸〉〓tĀei⿾々rnionóڰnt;樖stĀ;e【】䀿ñἙô༔઀ABHabcdefhilmnoprstux぀けさすムㄎㄫㅇㅢㅲㆎ㈆㈕㈤㈩㉘㉮㉲㊐㊰㊷ƀartぇおがròႳòϝail;検aròᱥar;楤΀cdenqrtとふへみわゔヌĀeuねぱ;쀀∽̱te;䅕iãᅮmptyv;榳gȀ;del࿑らるろ;榒;榥å࿑uo耻»䂻rր;abcfhlpstw࿜ガクシスゼゾダッデナp;極Ā;f࿠ゴs;椠;椳s;椞ë≝ð✮l;楅im;楴l;憣;憝Āaiパフil;椚oĀ;nホボ戶aló༞ƀabrョリヮrò៥rk;杳ĀakンヽcĀekヹ・;䁽;䁝Āes㄂㄄;榌lĀduㄊㄌ;榎;榐Ȁaeuyㄗㄜㄧㄩron;䅙Ādiㄡㄥil;䅗ì࿲âヺ;䑀Ȁclqsㄴㄷㄽㅄa;椷dhar;楩uoĀ;rȎȍh;憳ƀacgㅎㅟངlȀ;ipsླྀㅘㅛႜnåႻarôྩt;断ƀilrㅩဣㅮsht;楽;쀀𝔯ĀaoㅷㆆrĀduㅽㅿ»ѻĀ;l႑ㆄ;楬Ā;vㆋㆌ䏁;䏱ƀgns㆕ㇹㇼht̀ahlrstㆤㆰ㇂㇘㇤㇮rrowĀ;t࿜ㆭaéトarpoonĀduㆻㆿowîㅾp»႒eftĀah㇊㇐rrowó࿪arpoonóՑightarrows;應quigarro÷ニhreetimes;拌g;䋚ingdotseñἲƀahm㈍㈐㈓rò࿪aòՑ;怏oustĀ;a㈞㈟掱che»㈟mid;櫮Ȁabpt㈲㈽㉀㉒Ānr㈷㈺g;柭r;懾rëဃƀafl㉇㉊㉎r;榆;쀀𝕣us;樮imes;樵Āap㉝㉧rĀ;g㉣㉤䀩t;榔olint;樒arò㇣Ȁachq㉻㊀Ⴜ㊅quo;怺r;쀀𝓇Ābu・㊊oĀ;rȔȓƀhir㊗㊛㊠reåㇸmes;拊iȀ;efl㊪ၙᠡ㊫方tri;槎luhar;楨;愞ൡ㋕㋛㋟㌬㌸㍱\\0㍺㎤\\0\\0㏬㏰\\0㐨㑈㑚㒭㒱㓊㓱\\0㘖\\0\\0㘳cute;䅛quï➺Ԁ;Eaceinpsyᇭ㋳㋵㋿㌂㌋㌏㌟㌦㌩;檴ǰ㋺\\0㋼;檸on;䅡uåᇾĀ;dᇳ㌇il;䅟rc;䅝ƀEas㌖㌘㌛;檶p;檺im;择olint;樓iíሄ;䑁otƀ;be㌴ᵇ㌵担;橦΀Aacmstx㍆㍊㍗㍛㍞㍣㍭rr;懘rĀhr㍐㍒ë∨Ā;oਸ਼਴t耻§䂧i;䀻war;椩mĀin㍩ðnuóñt;朶rĀ;o㍶⁕쀀𝔰Ȁacoy㎂㎆㎑㎠rp;景Āhy㎋㎏cy;䑉;䑈rtɭ㎙\\0\\0㎜iäᑤaraì⹯耻­䂭Āgm㎨㎴maƀ;fv㎱㎲㎲䏃;䏂Ѐ;deglnprካ㏅㏉㏎㏖㏞㏡㏦ot;橪Ā;q኱ኰĀ;E㏓㏔檞;檠Ā;E㏛㏜檝;檟e;扆lus;樤arr;楲aròᄽȀaeit㏸㐈㐏㐗Āls㏽㐄lsetmé㍪hp;樳parsl;槤Ādlᑣ㐔e;挣Ā;e㐜㐝檪Ā;s㐢㐣檬;쀀⪬︀ƀflp㐮㐳㑂tcy;䑌Ā;b㐸㐹䀯Ā;a㐾㐿槄r;挿f;쀀𝕤aĀdr㑍ЂesĀ;u㑔㑕晠it»㑕ƀcsu㑠㑹㒟Āau㑥㑯pĀ;sᆈ㑫;쀀⊓︀pĀ;sᆴ㑵;쀀⊔︀uĀbp㑿㒏ƀ;esᆗᆜ㒆etĀ;eᆗ㒍ñᆝƀ;esᆨᆭ㒖etĀ;eᆨ㒝ñᆮƀ;afᅻ㒦ְrť㒫ֱ»ᅼaròᅈȀcemt㒹㒾㓂㓅r;쀀𝓈tmîñiì㐕aræᆾĀar㓎㓕rĀ;f㓔ឿ昆Āan㓚㓭ightĀep㓣㓪psiloîỠhé⺯s»⡒ʀbcmnp㓻㕞ሉ㖋㖎Ҁ;Edemnprs㔎㔏㔑㔕㔞㔣㔬㔱㔶抂;櫅ot;檽Ā;dᇚ㔚ot;櫃ult;櫁ĀEe㔨㔪;櫋;把lus;檿arr;楹ƀeiu㔽㕒㕕tƀ;en㔎㕅㕋qĀ;qᇚ㔏eqĀ;q㔫㔨m;櫇Ābp㕚㕜;櫕;櫓c̀;acensᇭ㕬㕲㕹㕻㌦pproø㋺urlyeñᇾñᇳƀaes㖂㖈㌛pproø㌚qñ㌗g;晪ڀ123;Edehlmnps㖩㖬㖯ሜ㖲㖴㗀㗉㗕㗚㗟㗨㗭耻¹䂹耻²䂲耻³䂳;櫆Āos㖹㖼t;檾ub;櫘Ā;dሢ㗅ot;櫄sĀou㗏㗒l;柉b;櫗arr;楻ult;櫂ĀEe㗤㗦;櫌;抋lus;櫀ƀeiu㗴㘉㘌tƀ;enሜ㗼㘂qĀ;qሢ㖲eqĀ;q㗧㗤m;櫈Ābp㘑㘓;櫔;櫖ƀAan㘜㘠㘭rr;懙rĀhr㘦㘨ë∮Ā;oਫ਩war;椪lig耻ß䃟௡㙑㙝㙠ዎ㙳㙹\\0㙾㛂\\0\\0\\0\\0\\0㛛㜃\\0㜉㝬\\0\\0\\0㞇ɲ㙖\\0\\0㙛get;挖;䏄rë๟ƀaey㙦㙫㙰ron;䅥dil;䅣;䑂lrec;挕r;쀀𝔱Ȁeiko㚆㚝㚵㚼ǲ㚋\\0㚑eĀ4fኄኁaƀ;sv㚘㚙㚛䎸ym;䏑Ācn㚢㚲kĀas㚨㚮pproø዁im»ኬsðኞĀas㚺㚮ð዁rn耻þ䃾Ǭ̟㛆⋧es膀×;bd㛏㛐㛘䃗Ā;aᤏ㛕r;樱;樰ƀeps㛡㛣㜀á⩍Ȁ;bcf҆㛬㛰㛴ot;挶ir;櫱Ā;o㛹㛼쀀𝕥rk;櫚á㍢rime;怴ƀaip㜏㜒㝤dåቈ΀adempst㜡㝍㝀㝑㝗㝜㝟ngleʀ;dlqr㜰㜱㜶㝀㝂斵own»ᶻeftĀ;e⠀㜾ñम;扜ightĀ;e㊪㝋ñၚot;旬inus;樺lus;樹b;槍ime;樻ezium;揢ƀcht㝲㝽㞁Āry㝷㝻;쀀𝓉;䑆cy;䑛rok;䅧Āio㞋㞎xô᝷headĀlr㞗㞠eftarro÷ࡏightarrow»ཝऀAHabcdfghlmoprstuw㟐㟓㟗㟤㟰㟼㠎㠜㠣㠴㡑㡝㡫㢩㣌㣒㣪㣶ròϭar;楣Ācr㟜㟢ute耻ú䃺òᅐrǣ㟪\\0㟭y;䑞ve;䅭Āiy㟵㟺rc耻û䃻;䑃ƀabh㠃㠆㠋ròᎭlac;䅱aòᏃĀir㠓㠘sht;楾;쀀𝔲rave耻ù䃹š㠧㠱rĀlr㠬㠮»ॗ»ႃlk;斀Āct㠹㡍ɯ㠿\\0\\0㡊rnĀ;e㡅㡆挜r»㡆op;挏ri;旸Āal㡖㡚cr;䅫肻¨͉Āgp㡢㡦on;䅳f;쀀𝕦̀adhlsuᅋ㡸㡽፲㢑㢠ownáᎳarpoonĀlr㢈㢌efô㠭ighô㠯iƀ;hl㢙㢚㢜䏅»ᏺon»㢚parrows;懈ƀcit㢰㣄㣈ɯ㢶\\0\\0㣁rnĀ;e㢼㢽挝r»㢽op;挎ng;䅯ri;旹cr;쀀𝓊ƀdir㣙㣝㣢ot;拰lde;䅩iĀ;f㜰㣨»᠓Āam㣯㣲rò㢨l耻ü䃼angle;榧ހABDacdeflnoprsz㤜㤟㤩㤭㦵㦸㦽㧟㧤㧨㧳㧹㧽㨁㨠ròϷarĀ;v㤦㤧櫨;櫩asèϡĀnr㤲㤷grt;榜΀eknprst㓣㥆㥋㥒㥝㥤㦖appá␕othinçẖƀhir㓫⻈㥙opô⾵Ā;hᎷ㥢ïㆍĀiu㥩㥭gmá㎳Ābp㥲㦄setneqĀ;q㥽㦀쀀⊊︀;쀀⫋︀setneqĀ;q㦏㦒쀀⊋︀;쀀⫌︀Āhr㦛㦟etá㚜iangleĀlr㦪㦯eft»थight»ၑy;䐲ash»ံƀelr㧄㧒㧗ƀ;beⷪ㧋㧏ar;抻q;扚lip;拮Ābt㧜ᑨaòᑩr;쀀𝔳tré㦮suĀbp㧯㧱»ജ»൙pf;쀀𝕧roð໻tré㦴Ācu㨆㨋r;쀀𝓋Ābp㨐㨘nĀEe㦀㨖»㥾nĀEe㦒㨞»㦐igzag;榚΀cefoprs㨶㨻㩖㩛㩔㩡㩪irc;䅵Ādi㩀㩑Ābg㩅㩉ar;機eĀ;qᗺ㩏;扙erp;愘r;쀀𝔴pf;쀀𝕨Ā;eᑹ㩦atèᑹcr;쀀𝓌ૣណ㪇\\0㪋\\0㪐㪛\\0\\0㪝㪨㪫㪯\\0\\0㫃㫎\\0㫘ៜ៟tré៑r;쀀𝔵ĀAa㪔㪗ròσrò৶;䎾ĀAa㪡㪤ròθrò৫að✓is;拻ƀdptឤ㪵㪾Āfl㪺ឩ;쀀𝕩imåឲĀAa㫇㫊ròώròਁĀcq㫒ីr;쀀𝓍Āpt៖㫜ré។Ѐacefiosu㫰㫽㬈㬌㬑㬕㬛㬡cĀuy㫶㫻te耻ý䃽;䑏Āiy㬂㬆rc;䅷;䑋n耻¥䂥r;쀀𝔶cy;䑗pf;쀀𝕪cr;쀀𝓎Ācm㬦㬩y;䑎l耻ÿ䃿Ԁacdefhiosw㭂㭈㭔㭘㭤㭩㭭㭴㭺㮀cute;䅺Āay㭍㭒ron;䅾;䐷ot;䅼Āet㭝㭡træᕟa;䎶r;쀀𝔷cy;䐶grarr;懝pf;쀀𝕫cr;쀀𝓏Ājn㮅㮇;怍j;怌\'.split("").map(function(e){return e.charCodeAt(0)}))});var gf=R(ts=>{"use strict";Object.defineProperty(ts,"__esModule",{value:!0});ts.default=new Uint16Array("Ȁaglq	\\x1Bɭ\\0\\0p;䀦os;䀧t;䀾t;䀼uot;䀢".split("").map(function(e){return e.charCodeAt(0)}))});var us=R(qr=>{"use strict";var rs;Object.defineProperty(qr,"__esModule",{value:!0});qr.replaceCodePoint=qr.fromCodePoint=void 0;var _E=new Map([[0,65533],[128,8364],[130,8218],[131,402],[132,8222],[133,8230],[134,8224],[135,8225],[136,710],[137,8240],[138,352],[139,8249],[140,338],[142,381],[145,8216],[146,8217],[147,8220],[148,8221],[149,8226],[150,8211],[151,8212],[152,732],[153,8482],[154,353],[155,8250],[156,339],[158,382],[159,376]]);qr.fromCodePoint=(rs=String.fromCodePoint)!==null&&rs!==void 0?rs:function(e){var t="";return e>65535&&(e-=65536,t+=String.fromCharCode(e>>>10&1023|55296),e=56320|e&1023),t+=String.fromCharCode(e),t};function vf(e){var t;return e>=55296&&e<=57343||e>1114111?65533:(t=_E.get(e))!==null&&t!==void 0?t:e}qr.replaceCodePoint=vf;function EE(e){return(0,qr.fromCodePoint)(vf(e))}qr.default=EE});var L0=R(_e=>{"use strict";var TE=_e&&_e.__createBinding||(Object.create?function(e,t,r,u){u===void 0&&(u=r);var a=Object.getOwnPropertyDescriptor(t,r);(!a||("get"in a?!t.__esModule:a.writable||a.configurable))&&(a={enumerable:!0,get:function(){return t[r]}}),Object.defineProperty(e,u,a)}:function(e,t,r,u){u===void 0&&(u=r),e[u]=t[r]}),xE=_e&&_e.__setModuleDefault||(Object.create?function(e,t){Object.defineProperty(e,"default",{enumerable:!0,value:t})}:function(e,t){e.default=t}),AE=_e&&_e.__importStar||function(e){if(e&&e.__esModule)return e;var t={};if(e!=null)for(var r in e)r!=="default"&&Object.prototype.hasOwnProperty.call(e,r)&&TE(t,e,r);return xE(t,e),t},yf=_e&&_e.__importDefault||function(e){return e&&e.__esModule?e:{default:e}};Object.defineProperty(_e,"__esModule",{value:!0});_e.decodeXML=_e.decodeHTMLStrict=_e.decodeHTMLAttribute=_e.decodeHTML=_e.determineBranch=_e.EntityDecoder=_e.DecodingMode=_e.BinTrieFlags=_e.fromCodePoint=_e.replaceCodePoint=_e.decodeCodePoint=_e.xmlDecodeTree=_e.htmlDecodeTree=void 0;var Df=yf(mf());_e.htmlDecodeTree=Df.default;var Cf=yf(gf());_e.xmlDecodeTree=Cf.default;var ns=AE(us());_e.decodeCodePoint=ns.default;var If=us();Object.defineProperty(_e,"replaceCodePoint",{enumerable:!0,get:function(){return If.replaceCodePoint}});Object.defineProperty(_e,"fromCodePoint",{enumerable:!0,get:function(){return If.fromCodePoint}});var $e;(function(e){e[e.NUM=35]="NUM",e[e.SEMI=59]="SEMI",e[e.EQUALS=61]="EQUALS",e[e.ZERO=48]="ZERO",e[e.NINE=57]="NINE",e[e.LOWER_A=97]="LOWER_A",e[e.LOWER_F=102]="LOWER_F",e[e.LOWER_X=120]="LOWER_X",e[e.LOWER_Z=122]="LOWER_Z",e[e.UPPER_A=65]="UPPER_A",e[e.UPPER_F=70]="UPPER_F",e[e.UPPER_Z=90]="UPPER_Z"})($e||($e={}));var mE=32,_u;(function(e){e[e.VALUE_LENGTH=49152]="VALUE_LENGTH",e[e.BRANCH_LENGTH=16256]="BRANCH_LENGTH",e[e.JUMP_TABLE=127]="JUMP_TABLE"})(_u=_e.BinTrieFlags||(_e.BinTrieFlags={}));function as(e){return e>=$e.ZERO&&e<=$e.NINE}function gE(e){return e>=$e.UPPER_A&&e<=$e.UPPER_F||e>=$e.LOWER_A&&e<=$e.LOWER_F}function vE(e){return e>=$e.UPPER_A&&e<=$e.UPPER_Z||e>=$e.LOWER_A&&e<=$e.LOWER_Z||as(e)}function yE(e){return e===$e.EQUALS||vE(e)}var Ke;(function(e){e[e.EntityStart=0]="EntityStart",e[e.NumericStart=1]="NumericStart",e[e.NumericDecimal=2]="NumericDecimal",e[e.NumericHex=3]="NumericHex",e[e.NamedEntity=4]="NamedEntity"})(Ke||(Ke={}));var ar;(function(e){e[e.Legacy=0]="Legacy",e[e.Strict=1]="Strict",e[e.Attribute=2]="Attribute"})(ar=_e.DecodingMode||(_e.DecodingMode={}));var Sf=function(){function e(t,r,u){this.decodeTree=t,this.emitCodePoint=r,this.errors=u,this.state=Ke.EntityStart,this.consumed=1,this.result=0,this.treeIndex=0,this.excess=1,this.decodeMode=ar.Strict}return e.prototype.startEntity=function(t){this.decodeMode=t,this.state=Ke.EntityStart,this.result=0,this.treeIndex=0,this.excess=1,this.consumed=1},e.prototype.write=function(t,r){switch(this.state){case Ke.EntityStart:return t.charCodeAt(r)===$e.NUM?(this.state=Ke.NumericStart,this.consumed+=1,this.stateNumericStart(t,r+1)):(this.state=Ke.NamedEntity,this.stateNamedEntity(t,r));case Ke.NumericStart:return this.stateNumericStart(t,r);case Ke.NumericDecimal:return this.stateNumericDecimal(t,r);case Ke.NumericHex:return this.stateNumericHex(t,r);case Ke.NamedEntity:return this.stateNamedEntity(t,r)}},e.prototype.stateNumericStart=function(t,r){return r>=t.length?-1:(t.charCodeAt(r)|mE)===$e.LOWER_X?(this.state=Ke.NumericHex,this.consumed+=1,this.stateNumericHex(t,r+1)):(this.state=Ke.NumericDecimal,this.stateNumericDecimal(t,r))},e.prototype.addToNumericResult=function(t,r,u,a){if(r!==u){var n=u-r;this.result=this.result*Math.pow(a,n)+parseInt(t.substr(r,n),a),this.consumed+=n}},e.prototype.stateNumericHex=function(t,r){for(var u=r;r<t.length;){var a=t.charCodeAt(r);if(as(a)||gE(a))r+=1;else return this.addToNumericResult(t,u,r,16),this.emitNumericEntity(a,3)}return this.addToNumericResult(t,u,r,16),-1},e.prototype.stateNumericDecimal=function(t,r){for(var u=r;r<t.length;){var a=t.charCodeAt(r);if(as(a))r+=1;else return this.addToNumericResult(t,u,r,10),this.emitNumericEntity(a,2)}return this.addToNumericResult(t,u,r,10),-1},e.prototype.emitNumericEntity=function(t,r){var u;if(this.consumed<=r)return(u=this.errors)===null||u===void 0||u.absenceOfDigitsInNumericCharacterReference(this.consumed),0;if(t===$e.SEMI)this.consumed+=1;else if(this.decodeMode===ar.Strict)return 0;return this.emitCodePoint((0,ns.replaceCodePoint)(this.result),this.consumed),this.errors&&(t!==$e.SEMI&&this.errors.missingSemicolonAfterCharacterReference(),this.errors.validateNumericCharacterReference(this.result)),this.consumed},e.prototype.stateNamedEntity=function(t,r){for(var u=this.decodeTree,a=u[this.treeIndex],n=(a&_u.VALUE_LENGTH)>>14;r<t.length;r++,this.excess++){var s=t.charCodeAt(r);if(this.treeIndex=Of(u,a,this.treeIndex+Math.max(1,n),s),this.treeIndex<0)return this.result===0||this.decodeMode===ar.Attribute&&(n===0||yE(s))?0:this.emitNotTerminatedNamedEntity();if(a=u[this.treeIndex],n=(a&_u.VALUE_LENGTH)>>14,n!==0){if(s===$e.SEMI)return this.emitNamedEntityData(this.treeIndex,n,this.consumed+this.excess);this.decodeMode!==ar.Strict&&(this.result=this.treeIndex,this.consumed+=this.excess,this.excess=0)}}return-1},e.prototype.emitNotTerminatedNamedEntity=function(){var t,r=this,u=r.result,a=r.decodeTree,n=(a[u]&_u.VALUE_LENGTH)>>14;return this.emitNamedEntityData(u,n,this.consumed),(t=this.errors)===null||t===void 0||t.missingSemicolonAfterCharacterReference(),this.consumed},e.prototype.emitNamedEntityData=function(t,r,u){var a=this.decodeTree;return this.emitCodePoint(r===1?a[t]&~_u.VALUE_LENGTH:a[t+1],u),r===3&&this.emitCodePoint(a[t+2],u),u},e.prototype.end=function(){var t;switch(this.state){case Ke.NamedEntity:return this.result!==0&&(this.decodeMode!==ar.Attribute||this.result===this.treeIndex)?this.emitNotTerminatedNamedEntity():0;case Ke.NumericDecimal:return this.emitNumericEntity(0,2);case Ke.NumericHex:return this.emitNumericEntity(0,3);case Ke.NumericStart:return(t=this.errors)===null||t===void 0||t.absenceOfDigitsInNumericCharacterReference(this.consumed),0;case Ke.EntityStart:return 0}},e}();_e.EntityDecoder=Sf;function Nf(e){var t="",r=new Sf(e,function(u){return t+=(0,ns.fromCodePoint)(u)});return function(a,n){for(var s=0,i=0;(i=a.indexOf("&",i))>=0;){t+=a.slice(s,i),r.startEntity(n);var c=r.write(a,i+1);if(c<0){s=i+r.end();break}s=i+c,i=c===0?s+1:s}var o=t+a.slice(s);return t="",o}}function Of(e,t,r,u){var a=(t&_u.BRANCH_LENGTH)>>7,n=t&_u.JUMP_TABLE;if(a===0)return n!==0&&u===n?r:-1;if(n){var s=u-n;return s<0||s>=a?-1:e[r+s]-1}for(var i=r,c=i+a-1;i<=c;){var o=i+c>>>1,f=e[o];if(f<u)i=o+1;else if(f>u)c=o-1;else return e[o+a]}return-1}_e.determineBranch=Of;var is=Nf(Df.default),DE=Nf(Cf.default);function CE(e,t){return t===void 0&&(t=ar.Legacy),is(e,t)}_e.decodeHTML=CE;function IE(e){return is(e,ar.Attribute)}_e.decodeHTMLAttribute=IE;function SE(e){return is(e,ar.Strict)}_e.decodeHTMLStrict=SE;function NE(e){return DE(e,ar.Strict)}_e.decodeXML=NE});var Rf=R(ss=>{"use strict";Object.defineProperty(ss,"__esModule",{value:!0});function Ua(e){for(var t=1;t<e.length;t++)e[t][0]+=e[t-1][0]+1;return e}ss.default=new Map(Ua([[9,"&Tab;"],[0,"&NewLine;"],[22,"&excl;"],[0,"&quot;"],[0,"&num;"],[0,"&dollar;"],[0,"&percnt;"],[0,"&amp;"],[0,"&apos;"],[0,"&lpar;"],[0,"&rpar;"],[0,"&ast;"],[0,"&plus;"],[0,"&comma;"],[1,"&period;"],[0,"&sol;"],[10,"&colon;"],[0,"&semi;"],[0,{v:"&lt;",n:8402,o:"&nvlt;"}],[0,{v:"&equals;",n:8421,o:"&bne;"}],[0,{v:"&gt;",n:8402,o:"&nvgt;"}],[0,"&quest;"],[0,"&commat;"],[26,"&lbrack;"],[0,"&bsol;"],[0,"&rbrack;"],[0,"&Hat;"],[0,"&lowbar;"],[0,"&DiacriticalGrave;"],[5,{n:106,o:"&fjlig;"}],[20,"&lbrace;"],[0,"&verbar;"],[0,"&rbrace;"],[34,"&nbsp;"],[0,"&iexcl;"],[0,"&cent;"],[0,"&pound;"],[0,"&curren;"],[0,"&yen;"],[0,"&brvbar;"],[0,"&sect;"],[0,"&die;"],[0,"&copy;"],[0,"&ordf;"],[0,"&laquo;"],[0,"&not;"],[0,"&shy;"],[0,"&circledR;"],[0,"&macr;"],[0,"&deg;"],[0,"&PlusMinus;"],[0,"&sup2;"],[0,"&sup3;"],[0,"&acute;"],[0,"&micro;"],[0,"&para;"],[0,"&centerdot;"],[0,"&cedil;"],[0,"&sup1;"],[0,"&ordm;"],[0,"&raquo;"],[0,"&frac14;"],[0,"&frac12;"],[0,"&frac34;"],[0,"&iquest;"],[0,"&Agrave;"],[0,"&Aacute;"],[0,"&Acirc;"],[0,"&Atilde;"],[0,"&Auml;"],[0,"&angst;"],[0,"&AElig;"],[0,"&Ccedil;"],[0,"&Egrave;"],[0,"&Eacute;"],[0,"&Ecirc;"],[0,"&Euml;"],[0,"&Igrave;"],[0,"&Iacute;"],[0,"&Icirc;"],[0,"&Iuml;"],[0,"&ETH;"],[0,"&Ntilde;"],[0,"&Ograve;"],[0,"&Oacute;"],[0,"&Ocirc;"],[0,"&Otilde;"],[0,"&Ouml;"],[0,"&times;"],[0,"&Oslash;"],[0,"&Ugrave;"],[0,"&Uacute;"],[0,"&Ucirc;"],[0,"&Uuml;"],[0,"&Yacute;"],[0,"&THORN;"],[0,"&szlig;"],[0,"&agrave;"],[0,"&aacute;"],[0,"&acirc;"],[0,"&atilde;"],[0,"&auml;"],[0,"&aring;"],[0,"&aelig;"],[0,"&ccedil;"],[0,"&egrave;"],[0,"&eacute;"],[0,"&ecirc;"],[0,"&euml;"],[0,"&igrave;"],[0,"&iacute;"],[0,"&icirc;"],[0,"&iuml;"],[0,"&eth;"],[0,"&ntilde;"],[0,"&ograve;"],[0,"&oacute;"],[0,"&ocirc;"],[0,"&otilde;"],[0,"&ouml;"],[0,"&div;"],[0,"&oslash;"],[0,"&ugrave;"],[0,"&uacute;"],[0,"&ucirc;"],[0,"&uuml;"],[0,"&yacute;"],[0,"&thorn;"],[0,"&yuml;"],[0,"&Amacr;"],[0,"&amacr;"],[0,"&Abreve;"],[0,"&abreve;"],[0,"&Aogon;"],[0,"&aogon;"],[0,"&Cacute;"],[0,"&cacute;"],[0,"&Ccirc;"],[0,"&ccirc;"],[0,"&Cdot;"],[0,"&cdot;"],[0,"&Ccaron;"],[0,"&ccaron;"],[0,"&Dcaron;"],[0,"&dcaron;"],[0,"&Dstrok;"],[0,"&dstrok;"],[0,"&Emacr;"],[0,"&emacr;"],[2,"&Edot;"],[0,"&edot;"],[0,"&Eogon;"],[0,"&eogon;"],[0,"&Ecaron;"],[0,"&ecaron;"],[0,"&Gcirc;"],[0,"&gcirc;"],[0,"&Gbreve;"],[0,"&gbreve;"],[0,"&Gdot;"],[0,"&gdot;"],[0,"&Gcedil;"],[1,"&Hcirc;"],[0,"&hcirc;"],[0,"&Hstrok;"],[0,"&hstrok;"],[0,"&Itilde;"],[0,"&itilde;"],[0,"&Imacr;"],[0,"&imacr;"],[2,"&Iogon;"],[0,"&iogon;"],[0,"&Idot;"],[0,"&imath;"],[0,"&IJlig;"],[0,"&ijlig;"],[0,"&Jcirc;"],[0,"&jcirc;"],[0,"&Kcedil;"],[0,"&kcedil;"],[0,"&kgreen;"],[0,"&Lacute;"],[0,"&lacute;"],[0,"&Lcedil;"],[0,"&lcedil;"],[0,"&Lcaron;"],[0,"&lcaron;"],[0,"&Lmidot;"],[0,"&lmidot;"],[0,"&Lstrok;"],[0,"&lstrok;"],[0,"&Nacute;"],[0,"&nacute;"],[0,"&Ncedil;"],[0,"&ncedil;"],[0,"&Ncaron;"],[0,"&ncaron;"],[0,"&napos;"],[0,"&ENG;"],[0,"&eng;"],[0,"&Omacr;"],[0,"&omacr;"],[2,"&Odblac;"],[0,"&odblac;"],[0,"&OElig;"],[0,"&oelig;"],[0,"&Racute;"],[0,"&racute;"],[0,"&Rcedil;"],[0,"&rcedil;"],[0,"&Rcaron;"],[0,"&rcaron;"],[0,"&Sacute;"],[0,"&sacute;"],[0,"&Scirc;"],[0,"&scirc;"],[0,"&Scedil;"],[0,"&scedil;"],[0,"&Scaron;"],[0,"&scaron;"],[0,"&Tcedil;"],[0,"&tcedil;"],[0,"&Tcaron;"],[0,"&tcaron;"],[0,"&Tstrok;"],[0,"&tstrok;"],[0,"&Utilde;"],[0,"&utilde;"],[0,"&Umacr;"],[0,"&umacr;"],[0,"&Ubreve;"],[0,"&ubreve;"],[0,"&Uring;"],[0,"&uring;"],[0,"&Udblac;"],[0,"&udblac;"],[0,"&Uogon;"],[0,"&uogon;"],[0,"&Wcirc;"],[0,"&wcirc;"],[0,"&Ycirc;"],[0,"&ycirc;"],[0,"&Yuml;"],[0,"&Zacute;"],[0,"&zacute;"],[0,"&Zdot;"],[0,"&zdot;"],[0,"&Zcaron;"],[0,"&zcaron;"],[19,"&fnof;"],[34,"&imped;"],[63,"&gacute;"],[65,"&jmath;"],[142,"&circ;"],[0,"&caron;"],[16,"&breve;"],[0,"&DiacriticalDot;"],[0,"&ring;"],[0,"&ogon;"],[0,"&DiacriticalTilde;"],[0,"&dblac;"],[51,"&DownBreve;"],[127,"&Alpha;"],[0,"&Beta;"],[0,"&Gamma;"],[0,"&Delta;"],[0,"&Epsilon;"],[0,"&Zeta;"],[0,"&Eta;"],[0,"&Theta;"],[0,"&Iota;"],[0,"&Kappa;"],[0,"&Lambda;"],[0,"&Mu;"],[0,"&Nu;"],[0,"&Xi;"],[0,"&Omicron;"],[0,"&Pi;"],[0,"&Rho;"],[1,"&Sigma;"],[0,"&Tau;"],[0,"&Upsilon;"],[0,"&Phi;"],[0,"&Chi;"],[0,"&Psi;"],[0,"&ohm;"],[7,"&alpha;"],[0,"&beta;"],[0,"&gamma;"],[0,"&delta;"],[0,"&epsi;"],[0,"&zeta;"],[0,"&eta;"],[0,"&theta;"],[0,"&iota;"],[0,"&kappa;"],[0,"&lambda;"],[0,"&mu;"],[0,"&nu;"],[0,"&xi;"],[0,"&omicron;"],[0,"&pi;"],[0,"&rho;"],[0,"&sigmaf;"],[0,"&sigma;"],[0,"&tau;"],[0,"&upsi;"],[0,"&phi;"],[0,"&chi;"],[0,"&psi;"],[0,"&omega;"],[7,"&thetasym;"],[0,"&Upsi;"],[2,"&phiv;"],[0,"&piv;"],[5,"&Gammad;"],[0,"&digamma;"],[18,"&kappav;"],[0,"&rhov;"],[3,"&epsiv;"],[0,"&backepsilon;"],[10,"&IOcy;"],[0,"&DJcy;"],[0,"&GJcy;"],[0,"&Jukcy;"],[0,"&DScy;"],[0,"&Iukcy;"],[0,"&YIcy;"],[0,"&Jsercy;"],[0,"&LJcy;"],[0,"&NJcy;"],[0,"&TSHcy;"],[0,"&KJcy;"],[1,"&Ubrcy;"],[0,"&DZcy;"],[0,"&Acy;"],[0,"&Bcy;"],[0,"&Vcy;"],[0,"&Gcy;"],[0,"&Dcy;"],[0,"&IEcy;"],[0,"&ZHcy;"],[0,"&Zcy;"],[0,"&Icy;"],[0,"&Jcy;"],[0,"&Kcy;"],[0,"&Lcy;"],[0,"&Mcy;"],[0,"&Ncy;"],[0,"&Ocy;"],[0,"&Pcy;"],[0,"&Rcy;"],[0,"&Scy;"],[0,"&Tcy;"],[0,"&Ucy;"],[0,"&Fcy;"],[0,"&KHcy;"],[0,"&TScy;"],[0,"&CHcy;"],[0,"&SHcy;"],[0,"&SHCHcy;"],[0,"&HARDcy;"],[0,"&Ycy;"],[0,"&SOFTcy;"],[0,"&Ecy;"],[0,"&YUcy;"],[0,"&YAcy;"],[0,"&acy;"],[0,"&bcy;"],[0,"&vcy;"],[0,"&gcy;"],[0,"&dcy;"],[0,"&iecy;"],[0,"&zhcy;"],[0,"&zcy;"],[0,"&icy;"],[0,"&jcy;"],[0,"&kcy;"],[0,"&lcy;"],[0,"&mcy;"],[0,"&ncy;"],[0,"&ocy;"],[0,"&pcy;"],[0,"&rcy;"],[0,"&scy;"],[0,"&tcy;"],[0,"&ucy;"],[0,"&fcy;"],[0,"&khcy;"],[0,"&tscy;"],[0,"&chcy;"],[0,"&shcy;"],[0,"&shchcy;"],[0,"&hardcy;"],[0,"&ycy;"],[0,"&softcy;"],[0,"&ecy;"],[0,"&yucy;"],[0,"&yacy;"],[1,"&iocy;"],[0,"&djcy;"],[0,"&gjcy;"],[0,"&jukcy;"],[0,"&dscy;"],[0,"&iukcy;"],[0,"&yicy;"],[0,"&jsercy;"],[0,"&ljcy;"],[0,"&njcy;"],[0,"&tshcy;"],[0,"&kjcy;"],[1,"&ubrcy;"],[0,"&dzcy;"],[7074,"&ensp;"],[0,"&emsp;"],[0,"&emsp13;"],[0,"&emsp14;"],[1,"&numsp;"],[0,"&puncsp;"],[0,"&ThinSpace;"],[0,"&hairsp;"],[0,"&NegativeMediumSpace;"],[0,"&zwnj;"],[0,"&zwj;"],[0,"&lrm;"],[0,"&rlm;"],[0,"&dash;"],[2,"&ndash;"],[0,"&mdash;"],[0,"&horbar;"],[0,"&Verbar;"],[1,"&lsquo;"],[0,"&CloseCurlyQuote;"],[0,"&lsquor;"],[1,"&ldquo;"],[0,"&CloseCurlyDoubleQuote;"],[0,"&bdquo;"],[1,"&dagger;"],[0,"&Dagger;"],[0,"&bull;"],[2,"&nldr;"],[0,"&hellip;"],[9,"&permil;"],[0,"&pertenk;"],[0,"&prime;"],[0,"&Prime;"],[0,"&tprime;"],[0,"&backprime;"],[3,"&lsaquo;"],[0,"&rsaquo;"],[3,"&oline;"],[2,"&caret;"],[1,"&hybull;"],[0,"&frasl;"],[10,"&bsemi;"],[7,"&qprime;"],[7,{v:"&MediumSpace;",n:8202,o:"&ThickSpace;"}],[0,"&NoBreak;"],[0,"&af;"],[0,"&InvisibleTimes;"],[0,"&ic;"],[72,"&euro;"],[46,"&tdot;"],[0,"&DotDot;"],[37,"&complexes;"],[2,"&incare;"],[4,"&gscr;"],[0,"&hamilt;"],[0,"&Hfr;"],[0,"&Hopf;"],[0,"&planckh;"],[0,"&hbar;"],[0,"&imagline;"],[0,"&Ifr;"],[0,"&lagran;"],[0,"&ell;"],[1,"&naturals;"],[0,"&numero;"],[0,"&copysr;"],[0,"&weierp;"],[0,"&Popf;"],[0,"&Qopf;"],[0,"&realine;"],[0,"&real;"],[0,"&reals;"],[0,"&rx;"],[3,"&trade;"],[1,"&integers;"],[2,"&mho;"],[0,"&zeetrf;"],[0,"&iiota;"],[2,"&bernou;"],[0,"&Cayleys;"],[1,"&escr;"],[0,"&Escr;"],[0,"&Fouriertrf;"],[1,"&Mellintrf;"],[0,"&order;"],[0,"&alefsym;"],[0,"&beth;"],[0,"&gimel;"],[0,"&daleth;"],[12,"&CapitalDifferentialD;"],[0,"&dd;"],[0,"&ee;"],[0,"&ii;"],[10,"&frac13;"],[0,"&frac23;"],[0,"&frac15;"],[0,"&frac25;"],[0,"&frac35;"],[0,"&frac45;"],[0,"&frac16;"],[0,"&frac56;"],[0,"&frac18;"],[0,"&frac38;"],[0,"&frac58;"],[0,"&frac78;"],[49,"&larr;"],[0,"&ShortUpArrow;"],[0,"&rarr;"],[0,"&darr;"],[0,"&harr;"],[0,"&updownarrow;"],[0,"&nwarr;"],[0,"&nearr;"],[0,"&LowerRightArrow;"],[0,"&LowerLeftArrow;"],[0,"&nlarr;"],[0,"&nrarr;"],[1,{v:"&rarrw;",n:824,o:"&nrarrw;"}],[0,"&Larr;"],[0,"&Uarr;"],[0,"&Rarr;"],[0,"&Darr;"],[0,"&larrtl;"],[0,"&rarrtl;"],[0,"&LeftTeeArrow;"],[0,"&mapstoup;"],[0,"&map;"],[0,"&DownTeeArrow;"],[1,"&hookleftarrow;"],[0,"&hookrightarrow;"],[0,"&larrlp;"],[0,"&looparrowright;"],[0,"&harrw;"],[0,"&nharr;"],[1,"&lsh;"],[0,"&rsh;"],[0,"&ldsh;"],[0,"&rdsh;"],[1,"&crarr;"],[0,"&cularr;"],[0,"&curarr;"],[2,"&circlearrowleft;"],[0,"&circlearrowright;"],[0,"&leftharpoonup;"],[0,"&DownLeftVector;"],[0,"&RightUpVector;"],[0,"&LeftUpVector;"],[0,"&rharu;"],[0,"&DownRightVector;"],[0,"&dharr;"],[0,"&dharl;"],[0,"&RightArrowLeftArrow;"],[0,"&udarr;"],[0,"&LeftArrowRightArrow;"],[0,"&leftleftarrows;"],[0,"&upuparrows;"],[0,"&rightrightarrows;"],[0,"&ddarr;"],[0,"&leftrightharpoons;"],[0,"&Equilibrium;"],[0,"&nlArr;"],[0,"&nhArr;"],[0,"&nrArr;"],[0,"&DoubleLeftArrow;"],[0,"&DoubleUpArrow;"],[0,"&DoubleRightArrow;"],[0,"&dArr;"],[0,"&DoubleLeftRightArrow;"],[0,"&DoubleUpDownArrow;"],[0,"&nwArr;"],[0,"&neArr;"],[0,"&seArr;"],[0,"&swArr;"],[0,"&lAarr;"],[0,"&rAarr;"],[1,"&zigrarr;"],[6,"&larrb;"],[0,"&rarrb;"],[15,"&DownArrowUpArrow;"],[7,"&loarr;"],[0,"&roarr;"],[0,"&hoarr;"],[0,"&forall;"],[0,"&comp;"],[0,{v:"&part;",n:824,o:"&npart;"}],[0,"&exist;"],[0,"&nexist;"],[0,"&empty;"],[1,"&Del;"],[0,"&Element;"],[0,"&NotElement;"],[1,"&ni;"],[0,"&notni;"],[2,"&prod;"],[0,"&coprod;"],[0,"&sum;"],[0,"&minus;"],[0,"&MinusPlus;"],[0,"&dotplus;"],[1,"&Backslash;"],[0,"&lowast;"],[0,"&compfn;"],[1,"&radic;"],[2,"&prop;"],[0,"&infin;"],[0,"&angrt;"],[0,{v:"&ang;",n:8402,o:"&nang;"}],[0,"&angmsd;"],[0,"&angsph;"],[0,"&mid;"],[0,"&nmid;"],[0,"&DoubleVerticalBar;"],[0,"&NotDoubleVerticalBar;"],[0,"&and;"],[0,"&or;"],[0,{v:"&cap;",n:65024,o:"&caps;"}],[0,{v:"&cup;",n:65024,o:"&cups;"}],[0,"&int;"],[0,"&Int;"],[0,"&iiint;"],[0,"&conint;"],[0,"&Conint;"],[0,"&Cconint;"],[0,"&cwint;"],[0,"&ClockwiseContourIntegral;"],[0,"&awconint;"],[0,"&there4;"],[0,"&becaus;"],[0,"&ratio;"],[0,"&Colon;"],[0,"&dotminus;"],[1,"&mDDot;"],[0,"&homtht;"],[0,{v:"&sim;",n:8402,o:"&nvsim;"}],[0,{v:"&backsim;",n:817,o:"&race;"}],[0,{v:"&ac;",n:819,o:"&acE;"}],[0,"&acd;"],[0,"&VerticalTilde;"],[0,"&NotTilde;"],[0,{v:"&eqsim;",n:824,o:"&nesim;"}],[0,"&sime;"],[0,"&NotTildeEqual;"],[0,"&cong;"],[0,"&simne;"],[0,"&ncong;"],[0,"&ap;"],[0,"&nap;"],[0,"&ape;"],[0,{v:"&apid;",n:824,o:"&napid;"}],[0,"&backcong;"],[0,{v:"&asympeq;",n:8402,o:"&nvap;"}],[0,{v:"&bump;",n:824,o:"&nbump;"}],[0,{v:"&bumpe;",n:824,o:"&nbumpe;"}],[0,{v:"&doteq;",n:824,o:"&nedot;"}],[0,"&doteqdot;"],[0,"&efDot;"],[0,"&erDot;"],[0,"&Assign;"],[0,"&ecolon;"],[0,"&ecir;"],[0,"&circeq;"],[1,"&wedgeq;"],[0,"&veeeq;"],[1,"&triangleq;"],[2,"&equest;"],[0,"&ne;"],[0,{v:"&Congruent;",n:8421,o:"&bnequiv;"}],[0,"&nequiv;"],[1,{v:"&le;",n:8402,o:"&nvle;"}],[0,{v:"&ge;",n:8402,o:"&nvge;"}],[0,{v:"&lE;",n:824,o:"&nlE;"}],[0,{v:"&gE;",n:824,o:"&ngE;"}],[0,{v:"&lnE;",n:65024,o:"&lvertneqq;"}],[0,{v:"&gnE;",n:65024,o:"&gvertneqq;"}],[0,{v:"&ll;",n:new Map(Ua([[824,"&nLtv;"],[7577,"&nLt;"]]))}],[0,{v:"&gg;",n:new Map(Ua([[824,"&nGtv;"],[7577,"&nGt;"]]))}],[0,"&between;"],[0,"&NotCupCap;"],[0,"&nless;"],[0,"&ngt;"],[0,"&nle;"],[0,"&nge;"],[0,"&lesssim;"],[0,"&GreaterTilde;"],[0,"&nlsim;"],[0,"&ngsim;"],[0,"&LessGreater;"],[0,"&gl;"],[0,"&NotLessGreater;"],[0,"&NotGreaterLess;"],[0,"&pr;"],[0,"&sc;"],[0,"&prcue;"],[0,"&sccue;"],[0,"&PrecedesTilde;"],[0,{v:"&scsim;",n:824,o:"&NotSucceedsTilde;"}],[0,"&NotPrecedes;"],[0,"&NotSucceeds;"],[0,{v:"&sub;",n:8402,o:"&NotSubset;"}],[0,{v:"&sup;",n:8402,o:"&NotSuperset;"}],[0,"&nsub;"],[0,"&nsup;"],[0,"&sube;"],[0,"&supe;"],[0,"&NotSubsetEqual;"],[0,"&NotSupersetEqual;"],[0,{v:"&subne;",n:65024,o:"&varsubsetneq;"}],[0,{v:"&supne;",n:65024,o:"&varsupsetneq;"}],[1,"&cupdot;"],[0,"&UnionPlus;"],[0,{v:"&sqsub;",n:824,o:"&NotSquareSubset;"}],[0,{v:"&sqsup;",n:824,o:"&NotSquareSuperset;"}],[0,"&sqsube;"],[0,"&sqsupe;"],[0,{v:"&sqcap;",n:65024,o:"&sqcaps;"}],[0,{v:"&sqcup;",n:65024,o:"&sqcups;"}],[0,"&CirclePlus;"],[0,"&CircleMinus;"],[0,"&CircleTimes;"],[0,"&osol;"],[0,"&CircleDot;"],[0,"&circledcirc;"],[0,"&circledast;"],[1,"&circleddash;"],[0,"&boxplus;"],[0,"&boxminus;"],[0,"&boxtimes;"],[0,"&dotsquare;"],[0,"&RightTee;"],[0,"&dashv;"],[0,"&DownTee;"],[0,"&bot;"],[1,"&models;"],[0,"&DoubleRightTee;"],[0,"&Vdash;"],[0,"&Vvdash;"],[0,"&VDash;"],[0,"&nvdash;"],[0,"&nvDash;"],[0,"&nVdash;"],[0,"&nVDash;"],[0,"&prurel;"],[1,"&LeftTriangle;"],[0,"&RightTriangle;"],[0,{v:"&LeftTriangleEqual;",n:8402,o:"&nvltrie;"}],[0,{v:"&RightTriangleEqual;",n:8402,o:"&nvrtrie;"}],[0,"&origof;"],[0,"&imof;"],[0,"&multimap;"],[0,"&hercon;"],[0,"&intcal;"],[0,"&veebar;"],[1,"&barvee;"],[0,"&angrtvb;"],[0,"&lrtri;"],[0,"&bigwedge;"],[0,"&bigvee;"],[0,"&bigcap;"],[0,"&bigcup;"],[0,"&diam;"],[0,"&sdot;"],[0,"&sstarf;"],[0,"&divideontimes;"],[0,"&bowtie;"],[0,"&ltimes;"],[0,"&rtimes;"],[0,"&leftthreetimes;"],[0,"&rightthreetimes;"],[0,"&backsimeq;"],[0,"&curlyvee;"],[0,"&curlywedge;"],[0,"&Sub;"],[0,"&Sup;"],[0,"&Cap;"],[0,"&Cup;"],[0,"&fork;"],[0,"&epar;"],[0,"&lessdot;"],[0,"&gtdot;"],[0,{v:"&Ll;",n:824,o:"&nLl;"}],[0,{v:"&Gg;",n:824,o:"&nGg;"}],[0,{v:"&leg;",n:65024,o:"&lesg;"}],[0,{v:"&gel;",n:65024,o:"&gesl;"}],[2,"&cuepr;"],[0,"&cuesc;"],[0,"&NotPrecedesSlantEqual;"],[0,"&NotSucceedsSlantEqual;"],[0,"&NotSquareSubsetEqual;"],[0,"&NotSquareSupersetEqual;"],[2,"&lnsim;"],[0,"&gnsim;"],[0,"&precnsim;"],[0,"&scnsim;"],[0,"&nltri;"],[0,"&NotRightTriangle;"],[0,"&nltrie;"],[0,"&NotRightTriangleEqual;"],[0,"&vellip;"],[0,"&ctdot;"],[0,"&utdot;"],[0,"&dtdot;"],[0,"&disin;"],[0,"&isinsv;"],[0,"&isins;"],[0,{v:"&isindot;",n:824,o:"&notindot;"}],[0,"&notinvc;"],[0,"&notinvb;"],[1,{v:"&isinE;",n:824,o:"&notinE;"}],[0,"&nisd;"],[0,"&xnis;"],[0,"&nis;"],[0,"&notnivc;"],[0,"&notnivb;"],[6,"&barwed;"],[0,"&Barwed;"],[1,"&lceil;"],[0,"&rceil;"],[0,"&LeftFloor;"],[0,"&rfloor;"],[0,"&drcrop;"],[0,"&dlcrop;"],[0,"&urcrop;"],[0,"&ulcrop;"],[0,"&bnot;"],[1,"&profline;"],[0,"&profsurf;"],[1,"&telrec;"],[0,"&target;"],[5,"&ulcorn;"],[0,"&urcorn;"],[0,"&dlcorn;"],[0,"&drcorn;"],[2,"&frown;"],[0,"&smile;"],[9,"&cylcty;"],[0,"&profalar;"],[7,"&topbot;"],[6,"&ovbar;"],[1,"&solbar;"],[60,"&angzarr;"],[51,"&lmoustache;"],[0,"&rmoustache;"],[2,"&OverBracket;"],[0,"&bbrk;"],[0,"&bbrktbrk;"],[37,"&OverParenthesis;"],[0,"&UnderParenthesis;"],[0,"&OverBrace;"],[0,"&UnderBrace;"],[2,"&trpezium;"],[4,"&elinters;"],[59,"&blank;"],[164,"&circledS;"],[55,"&boxh;"],[1,"&boxv;"],[9,"&boxdr;"],[3,"&boxdl;"],[3,"&boxur;"],[3,"&boxul;"],[3,"&boxvr;"],[7,"&boxvl;"],[7,"&boxhd;"],[7,"&boxhu;"],[7,"&boxvh;"],[19,"&boxH;"],[0,"&boxV;"],[0,"&boxdR;"],[0,"&boxDr;"],[0,"&boxDR;"],[0,"&boxdL;"],[0,"&boxDl;"],[0,"&boxDL;"],[0,"&boxuR;"],[0,"&boxUr;"],[0,"&boxUR;"],[0,"&boxuL;"],[0,"&boxUl;"],[0,"&boxUL;"],[0,"&boxvR;"],[0,"&boxVr;"],[0,"&boxVR;"],[0,"&boxvL;"],[0,"&boxVl;"],[0,"&boxVL;"],[0,"&boxHd;"],[0,"&boxhD;"],[0,"&boxHD;"],[0,"&boxHu;"],[0,"&boxhU;"],[0,"&boxHU;"],[0,"&boxvH;"],[0,"&boxVh;"],[0,"&boxVH;"],[19,"&uhblk;"],[3,"&lhblk;"],[3,"&block;"],[8,"&blk14;"],[0,"&blk12;"],[0,"&blk34;"],[13,"&square;"],[8,"&blacksquare;"],[0,"&EmptyVerySmallSquare;"],[1,"&rect;"],[0,"&marker;"],[2,"&fltns;"],[1,"&bigtriangleup;"],[0,"&blacktriangle;"],[0,"&triangle;"],[2,"&blacktriangleright;"],[0,"&rtri;"],[3,"&bigtriangledown;"],[0,"&blacktriangledown;"],[0,"&dtri;"],[2,"&blacktriangleleft;"],[0,"&ltri;"],[6,"&loz;"],[0,"&cir;"],[32,"&tridot;"],[2,"&bigcirc;"],[8,"&ultri;"],[0,"&urtri;"],[0,"&lltri;"],[0,"&EmptySmallSquare;"],[0,"&FilledSmallSquare;"],[8,"&bigstar;"],[0,"&star;"],[7,"&phone;"],[49,"&female;"],[1,"&male;"],[29,"&spades;"],[2,"&clubs;"],[1,"&hearts;"],[0,"&diamondsuit;"],[3,"&sung;"],[2,"&flat;"],[0,"&natural;"],[0,"&sharp;"],[163,"&check;"],[3,"&cross;"],[8,"&malt;"],[21,"&sext;"],[33,"&VerticalSeparator;"],[25,"&lbbrk;"],[0,"&rbbrk;"],[84,"&bsolhsub;"],[0,"&suphsol;"],[28,"&LeftDoubleBracket;"],[0,"&RightDoubleBracket;"],[0,"&lang;"],[0,"&rang;"],[0,"&Lang;"],[0,"&Rang;"],[0,"&loang;"],[0,"&roang;"],[7,"&longleftarrow;"],[0,"&longrightarrow;"],[0,"&longleftrightarrow;"],[0,"&DoubleLongLeftArrow;"],[0,"&DoubleLongRightArrow;"],[0,"&DoubleLongLeftRightArrow;"],[1,"&longmapsto;"],[2,"&dzigrarr;"],[258,"&nvlArr;"],[0,"&nvrArr;"],[0,"&nvHarr;"],[0,"&Map;"],[6,"&lbarr;"],[0,"&bkarow;"],[0,"&lBarr;"],[0,"&dbkarow;"],[0,"&drbkarow;"],[0,"&DDotrahd;"],[0,"&UpArrowBar;"],[0,"&DownArrowBar;"],[2,"&Rarrtl;"],[2,"&latail;"],[0,"&ratail;"],[0,"&lAtail;"],[0,"&rAtail;"],[0,"&larrfs;"],[0,"&rarrfs;"],[0,"&larrbfs;"],[0,"&rarrbfs;"],[2,"&nwarhk;"],[0,"&nearhk;"],[0,"&hksearow;"],[0,"&hkswarow;"],[0,"&nwnear;"],[0,"&nesear;"],[0,"&seswar;"],[0,"&swnwar;"],[8,{v:"&rarrc;",n:824,o:"&nrarrc;"}],[1,"&cudarrr;"],[0,"&ldca;"],[0,"&rdca;"],[0,"&cudarrl;"],[0,"&larrpl;"],[2,"&curarrm;"],[0,"&cularrp;"],[7,"&rarrpl;"],[2,"&harrcir;"],[0,"&Uarrocir;"],[0,"&lurdshar;"],[0,"&ldrushar;"],[2,"&LeftRightVector;"],[0,"&RightUpDownVector;"],[0,"&DownLeftRightVector;"],[0,"&LeftUpDownVector;"],[0,"&LeftVectorBar;"],[0,"&RightVectorBar;"],[0,"&RightUpVectorBar;"],[0,"&RightDownVectorBar;"],[0,"&DownLeftVectorBar;"],[0,"&DownRightVectorBar;"],[0,"&LeftUpVectorBar;"],[0,"&LeftDownVectorBar;"],[0,"&LeftTeeVector;"],[0,"&RightTeeVector;"],[0,"&RightUpTeeVector;"],[0,"&RightDownTeeVector;"],[0,"&DownLeftTeeVector;"],[0,"&DownRightTeeVector;"],[0,"&LeftUpTeeVector;"],[0,"&LeftDownTeeVector;"],[0,"&lHar;"],[0,"&uHar;"],[0,"&rHar;"],[0,"&dHar;"],[0,"&luruhar;"],[0,"&ldrdhar;"],[0,"&ruluhar;"],[0,"&rdldhar;"],[0,"&lharul;"],[0,"&llhard;"],[0,"&rharul;"],[0,"&lrhard;"],[0,"&udhar;"],[0,"&duhar;"],[0,"&RoundImplies;"],[0,"&erarr;"],[0,"&simrarr;"],[0,"&larrsim;"],[0,"&rarrsim;"],[0,"&rarrap;"],[0,"&ltlarr;"],[1,"&gtrarr;"],[0,"&subrarr;"],[1,"&suplarr;"],[0,"&lfisht;"],[0,"&rfisht;"],[0,"&ufisht;"],[0,"&dfisht;"],[5,"&lopar;"],[0,"&ropar;"],[4,"&lbrke;"],[0,"&rbrke;"],[0,"&lbrkslu;"],[0,"&rbrksld;"],[0,"&lbrksld;"],[0,"&rbrkslu;"],[0,"&langd;"],[0,"&rangd;"],[0,"&lparlt;"],[0,"&rpargt;"],[0,"&gtlPar;"],[0,"&ltrPar;"],[3,"&vzigzag;"],[1,"&vangrt;"],[0,"&angrtvbd;"],[6,"&ange;"],[0,"&range;"],[0,"&dwangle;"],[0,"&uwangle;"],[0,"&angmsdaa;"],[0,"&angmsdab;"],[0,"&angmsdac;"],[0,"&angmsdad;"],[0,"&angmsdae;"],[0,"&angmsdaf;"],[0,"&angmsdag;"],[0,"&angmsdah;"],[0,"&bemptyv;"],[0,"&demptyv;"],[0,"&cemptyv;"],[0,"&raemptyv;"],[0,"&laemptyv;"],[0,"&ohbar;"],[0,"&omid;"],[0,"&opar;"],[1,"&operp;"],[1,"&olcross;"],[0,"&odsold;"],[1,"&olcir;"],[0,"&ofcir;"],[0,"&olt;"],[0,"&ogt;"],[0,"&cirscir;"],[0,"&cirE;"],[0,"&solb;"],[0,"&bsolb;"],[3,"&boxbox;"],[3,"&trisb;"],[0,"&rtriltri;"],[0,{v:"&LeftTriangleBar;",n:824,o:"&NotLeftTriangleBar;"}],[0,{v:"&RightTriangleBar;",n:824,o:"&NotRightTriangleBar;"}],[11,"&iinfin;"],[0,"&infintie;"],[0,"&nvinfin;"],[4,"&eparsl;"],[0,"&smeparsl;"],[0,"&eqvparsl;"],[5,"&blacklozenge;"],[8,"&RuleDelayed;"],[1,"&dsol;"],[9,"&bigodot;"],[0,"&bigoplus;"],[0,"&bigotimes;"],[1,"&biguplus;"],[1,"&bigsqcup;"],[5,"&iiiint;"],[0,"&fpartint;"],[2,"&cirfnint;"],[0,"&awint;"],[0,"&rppolint;"],[0,"&scpolint;"],[0,"&npolint;"],[0,"&pointint;"],[0,"&quatint;"],[0,"&intlarhk;"],[10,"&pluscir;"],[0,"&plusacir;"],[0,"&simplus;"],[0,"&plusdu;"],[0,"&plussim;"],[0,"&plustwo;"],[1,"&mcomma;"],[0,"&minusdu;"],[2,"&loplus;"],[0,"&roplus;"],[0,"&Cross;"],[0,"&timesd;"],[0,"&timesbar;"],[1,"&smashp;"],[0,"&lotimes;"],[0,"&rotimes;"],[0,"&otimesas;"],[0,"&Otimes;"],[0,"&odiv;"],[0,"&triplus;"],[0,"&triminus;"],[0,"&tritime;"],[0,"&intprod;"],[2,"&amalg;"],[0,"&capdot;"],[1,"&ncup;"],[0,"&ncap;"],[0,"&capand;"],[0,"&cupor;"],[0,"&cupcap;"],[0,"&capcup;"],[0,"&cupbrcap;"],[0,"&capbrcup;"],[0,"&cupcup;"],[0,"&capcap;"],[0,"&ccups;"],[0,"&ccaps;"],[2,"&ccupssm;"],[2,"&And;"],[0,"&Or;"],[0,"&andand;"],[0,"&oror;"],[0,"&orslope;"],[0,"&andslope;"],[1,"&andv;"],[0,"&orv;"],[0,"&andd;"],[0,"&ord;"],[1,"&wedbar;"],[6,"&sdote;"],[3,"&simdot;"],[2,{v:"&congdot;",n:824,o:"&ncongdot;"}],[0,"&easter;"],[0,"&apacir;"],[0,{v:"&apE;",n:824,o:"&napE;"}],[0,"&eplus;"],[0,"&pluse;"],[0,"&Esim;"],[0,"&Colone;"],[0,"&Equal;"],[1,"&ddotseq;"],[0,"&equivDD;"],[0,"&ltcir;"],[0,"&gtcir;"],[0,"&ltquest;"],[0,"&gtquest;"],[0,{v:"&leqslant;",n:824,o:"&nleqslant;"}],[0,{v:"&geqslant;",n:824,o:"&ngeqslant;"}],[0,"&lesdot;"],[0,"&gesdot;"],[0,"&lesdoto;"],[0,"&gesdoto;"],[0,"&lesdotor;"],[0,"&gesdotol;"],[0,"&lap;"],[0,"&gap;"],[0,"&lne;"],[0,"&gne;"],[0,"&lnap;"],[0,"&gnap;"],[0,"&lEg;"],[0,"&gEl;"],[0,"&lsime;"],[0,"&gsime;"],[0,"&lsimg;"],[0,"&gsiml;"],[0,"&lgE;"],[0,"&glE;"],[0,"&lesges;"],[0,"&gesles;"],[0,"&els;"],[0,"&egs;"],[0,"&elsdot;"],[0,"&egsdot;"],[0,"&el;"],[0,"&eg;"],[2,"&siml;"],[0,"&simg;"],[0,"&simlE;"],[0,"&simgE;"],[0,{v:"&LessLess;",n:824,o:"&NotNestedLessLess;"}],[0,{v:"&GreaterGreater;",n:824,o:"&NotNestedGreaterGreater;"}],[1,"&glj;"],[0,"&gla;"],[0,"&ltcc;"],[0,"&gtcc;"],[0,"&lescc;"],[0,"&gescc;"],[0,"&smt;"],[0,"&lat;"],[0,{v:"&smte;",n:65024,o:"&smtes;"}],[0,{v:"&late;",n:65024,o:"&lates;"}],[0,"&bumpE;"],[0,{v:"&PrecedesEqual;",n:824,o:"&NotPrecedesEqual;"}],[0,{v:"&sce;",n:824,o:"&NotSucceedsEqual;"}],[2,"&prE;"],[0,"&scE;"],[0,"&precneqq;"],[0,"&scnE;"],[0,"&prap;"],[0,"&scap;"],[0,"&precnapprox;"],[0,"&scnap;"],[0,"&Pr;"],[0,"&Sc;"],[0,"&subdot;"],[0,"&supdot;"],[0,"&subplus;"],[0,"&supplus;"],[0,"&submult;"],[0,"&supmult;"],[0,"&subedot;"],[0,"&supedot;"],[0,{v:"&subE;",n:824,o:"&nsubE;"}],[0,{v:"&supE;",n:824,o:"&nsupE;"}],[0,"&subsim;"],[0,"&supsim;"],[2,{v:"&subnE;",n:65024,o:"&varsubsetneqq;"}],[0,{v:"&supnE;",n:65024,o:"&varsupsetneqq;"}],[2,"&csub;"],[0,"&csup;"],[0,"&csube;"],[0,"&csupe;"],[0,"&subsup;"],[0,"&supsub;"],[0,"&subsub;"],[0,"&supsup;"],[0,"&suphsub;"],[0,"&supdsub;"],[0,"&forkv;"],[0,"&topfork;"],[0,"&mlcp;"],[8,"&Dashv;"],[1,"&Vdashl;"],[0,"&Barv;"],[0,"&vBar;"],[0,"&vBarv;"],[1,"&Vbar;"],[0,"&Not;"],[0,"&bNot;"],[0,"&rnmid;"],[0,"&cirmid;"],[0,"&midcir;"],[0,"&topcir;"],[0,"&nhpar;"],[0,"&parsim;"],[9,{v:"&parsl;",n:8421,o:"&nparsl;"}],[44343,{n:new Map(Ua([[56476,"&Ascr;"],[1,"&Cscr;"],[0,"&Dscr;"],[2,"&Gscr;"],[2,"&Jscr;"],[0,"&Kscr;"],[2,"&Nscr;"],[0,"&Oscr;"],[0,"&Pscr;"],[0,"&Qscr;"],[1,"&Sscr;"],[0,"&Tscr;"],[0,"&Uscr;"],[0,"&Vscr;"],[0,"&Wscr;"],[0,"&Xscr;"],[0,"&Yscr;"],[0,"&Zscr;"],[0,"&ascr;"],[0,"&bscr;"],[0,"&cscr;"],[0,"&dscr;"],[1,"&fscr;"],[1,"&hscr;"],[0,"&iscr;"],[0,"&jscr;"],[0,"&kscr;"],[0,"&lscr;"],[0,"&mscr;"],[0,"&nscr;"],[1,"&pscr;"],[0,"&qscr;"],[0,"&rscr;"],[0,"&sscr;"],[0,"&tscr;"],[0,"&uscr;"],[0,"&vscr;"],[0,"&wscr;"],[0,"&xscr;"],[0,"&yscr;"],[0,"&zscr;"],[52,"&Afr;"],[0,"&Bfr;"],[1,"&Dfr;"],[0,"&Efr;"],[0,"&Ffr;"],[0,"&Gfr;"],[2,"&Jfr;"],[0,"&Kfr;"],[0,"&Lfr;"],[0,"&Mfr;"],[0,"&Nfr;"],[0,"&Ofr;"],[0,"&Pfr;"],[0,"&Qfr;"],[1,"&Sfr;"],[0,"&Tfr;"],[0,"&Ufr;"],[0,"&Vfr;"],[0,"&Wfr;"],[0,"&Xfr;"],[0,"&Yfr;"],[1,"&afr;"],[0,"&bfr;"],[0,"&cfr;"],[0,"&dfr;"],[0,"&efr;"],[0,"&ffr;"],[0,"&gfr;"],[0,"&hfr;"],[0,"&ifr;"],[0,"&jfr;"],[0,"&kfr;"],[0,"&lfr;"],[0,"&mfr;"],[0,"&nfr;"],[0,"&ofr;"],[0,"&pfr;"],[0,"&qfr;"],[0,"&rfr;"],[0,"&sfr;"],[0,"&tfr;"],[0,"&ufr;"],[0,"&vfr;"],[0,"&wfr;"],[0,"&xfr;"],[0,"&yfr;"],[0,"&zfr;"],[0,"&Aopf;"],[0,"&Bopf;"],[1,"&Dopf;"],[0,"&Eopf;"],[0,"&Fopf;"],[0,"&Gopf;"],[1,"&Iopf;"],[0,"&Jopf;"],[0,"&Kopf;"],[0,"&Lopf;"],[0,"&Mopf;"],[1,"&Oopf;"],[3,"&Sopf;"],[0,"&Topf;"],[0,"&Uopf;"],[0,"&Vopf;"],[0,"&Wopf;"],[0,"&Xopf;"],[0,"&Yopf;"],[1,"&aopf;"],[0,"&bopf;"],[0,"&copf;"],[0,"&dopf;"],[0,"&eopf;"],[0,"&fopf;"],[0,"&gopf;"],[0,"&hopf;"],[0,"&iopf;"],[0,"&jopf;"],[0,"&kopf;"],[0,"&lopf;"],[0,"&mopf;"],[0,"&nopf;"],[0,"&oopf;"],[0,"&popf;"],[0,"&qopf;"],[0,"&ropf;"],[0,"&sopf;"],[0,"&topf;"],[0,"&uopf;"],[0,"&vopf;"],[0,"&wopf;"],[0,"&xopf;"],[0,"&yopf;"],[0,"&zopf;"]]))}],[8906,"&fflig;"],[0,"&filig;"],[0,"&fllig;"],[0,"&ffilig;"],[0,"&ffllig;"]]))});var Ga=R(ze=>{"use strict";Object.defineProperty(ze,"__esModule",{value:!0});ze.escapeText=ze.escapeAttribute=ze.escapeUTF8=ze.escape=ze.encodeXML=ze.getCodePoint=ze.xmlReplacer=void 0;ze.xmlReplacer=/["&\'<>$\\x80-\\uFFFF]/g;var Pf=new Map([[34,"&quot;"],[38,"&amp;"],[39,"&apos;"],[60,"&lt;"],[62,"&gt;"]]);ze.getCodePoint=String.prototype.codePointAt!=null?function(e,t){return e.codePointAt(t)}:function(e,t){return(e.charCodeAt(t)&64512)===55296?(e.charCodeAt(t)-55296)*1024+e.charCodeAt(t+1)-56320+65536:e.charCodeAt(t)};function Bf(e){for(var t="",r=0,u;(u=ze.xmlReplacer.exec(e))!==null;){var a=u.index,n=e.charCodeAt(a),s=Pf.get(n);s!==void 0?(t+=e.substring(r,a)+s,r=a+1):(t+="".concat(e.substring(r,a),"&#x").concat((0,ze.getCodePoint)(e,a).toString(16),";"),r=ze.xmlReplacer.lastIndex+=+((n&64512)===55296))}return t+e.substr(r)}ze.encodeXML=Bf;ze.escape=Bf;function os(e,t){return function(u){for(var a,n=0,s="";a=e.exec(u);)n!==a.index&&(s+=u.substring(n,a.index)),s+=t.get(a[0].charCodeAt(0)),n=a.index+1;return s+u.substring(n)}}ze.escapeUTF8=os(/[&<>\'"]/g,Pf);ze.escapeAttribute=os(/["&\\u00A0]/g,new Map([[34,"&quot;"],[38,"&amp;"],[160,"&nbsp;"]]));ze.escapeText=os(/[&<>\\u00A0]/g,new Map([[38,"&amp;"],[60,"&lt;"],[62,"&gt;"],[160,"&nbsp;"]]))});var cs=R(jr=>{"use strict";var OE=jr&&jr.__importDefault||function(e){return e&&e.__esModule?e:{default:e}};Object.defineProperty(jr,"__esModule",{value:!0});jr.encodeNonAsciiHTML=jr.encodeHTML=void 0;var RE=OE(Rf()),wf=Ga(),PE=/[\\t\\n!-,./:-@[-`\\f{-}$\\x80-\\uFFFF]/g;function BE(e){return Lf(PE,e)}jr.encodeHTML=BE;function wE(e){return Lf(wf.xmlReplacer,e)}jr.encodeNonAsciiHTML=wE;function Lf(e,t){for(var r="",u=0,a;(a=e.exec(t))!==null;){var n=a.index;r+=t.substring(u,n);var s=t.charCodeAt(n),i=RE.default.get(s);if(typeof i=="object"){if(n+1<t.length){var c=t.charCodeAt(n+1),o=typeof i.n=="number"?i.n===c?i.o:void 0:i.n.get(c);if(o!==void 0){r+=o,u=e.lastIndex+=1;continue}}i=i.v}if(i!==void 0)r+=i,u=n+1;else{var f=(0,wf.getCodePoint)(t,n);r+="&#x".concat(f.toString(16),";"),u=e.lastIndex+=+(f!==s)}}return r+t.substr(u)}});var kf=R(oe=>{"use strict";Object.defineProperty(oe,"__esModule",{value:!0});oe.decodeXMLStrict=oe.decodeHTML5Strict=oe.decodeHTML4Strict=oe.decodeHTML5=oe.decodeHTML4=oe.decodeHTMLAttribute=oe.decodeHTMLStrict=oe.decodeHTML=oe.decodeXML=oe.DecodingMode=oe.EntityDecoder=oe.encodeHTML5=oe.encodeHTML4=oe.encodeNonAsciiHTML=oe.encodeHTML=oe.escapeText=oe.escapeAttribute=oe.escapeUTF8=oe.escape=oe.encodeXML=oe.encode=oe.decodeStrict=oe.decode=oe.EncodingMode=oe.EntityLevel=void 0;var fs=L0(),Mf=cs(),qa=Ga(),ju;(function(e){e[e.XML=0]="XML",e[e.HTML=1]="HTML"})(ju=oe.EntityLevel||(oe.EntityLevel={}));var M0;(function(e){e[e.UTF8=0]="UTF8",e[e.ASCII=1]="ASCII",e[e.Extensive=2]="Extensive",e[e.Attribute=3]="Attribute",e[e.Text=4]="Text"})(M0=oe.EncodingMode||(oe.EncodingMode={}));function Ff(e,t){t===void 0&&(t=ju.XML);var r=typeof t=="number"?t:t.level;if(r===ju.HTML){var u=typeof t=="object"?t.mode:void 0;return(0,fs.decodeHTML)(e,u)}return(0,fs.decodeXML)(e)}oe.decode=Ff;function LE(e,t){var r;t===void 0&&(t=ju.XML);var u=typeof t=="number"?{level:t}:t;return(r=u.mode)!==null&&r!==void 0||(u.mode=fs.DecodingMode.Strict),Ff(e,u)}oe.decodeStrict=LE;function ME(e,t){t===void 0&&(t=ju.XML);var r=typeof t=="number"?{level:t}:t;return r.mode===M0.UTF8?(0,qa.escapeUTF8)(e):r.mode===M0.Attribute?(0,qa.escapeAttribute)(e):r.mode===M0.Text?(0,qa.escapeText)(e):r.level===ju.HTML?r.mode===M0.ASCII?(0,Mf.encodeNonAsciiHTML)(e):(0,Mf.encodeHTML)(e):(0,qa.encodeXML)(e)}oe.encode=ME;var F0=Ga();Object.defineProperty(oe,"encodeXML",{enumerable:!0,get:function(){return F0.encodeXML}});Object.defineProperty(oe,"escape",{enumerable:!0,get:function(){return F0.escape}});Object.defineProperty(oe,"escapeUTF8",{enumerable:!0,get:function(){return F0.escapeUTF8}});Object.defineProperty(oe,"escapeAttribute",{enumerable:!0,get:function(){return F0.escapeAttribute}});Object.defineProperty(oe,"escapeText",{enumerable:!0,get:function(){return F0.escapeText}});var ja=cs();Object.defineProperty(oe,"encodeHTML",{enumerable:!0,get:function(){return ja.encodeHTML}});Object.defineProperty(oe,"encodeNonAsciiHTML",{enumerable:!0,get:function(){return ja.encodeNonAsciiHTML}});Object.defineProperty(oe,"encodeHTML4",{enumerable:!0,get:function(){return ja.encodeHTML}});Object.defineProperty(oe,"encodeHTML5",{enumerable:!0,get:function(){return ja.encodeHTML}});var Gt=L0();Object.defineProperty(oe,"EntityDecoder",{enumerable:!0,get:function(){return Gt.EntityDecoder}});Object.defineProperty(oe,"DecodingMode",{enumerable:!0,get:function(){return Gt.DecodingMode}});Object.defineProperty(oe,"decodeXML",{enumerable:!0,get:function(){return Gt.decodeXML}});Object.defineProperty(oe,"decodeHTML",{enumerable:!0,get:function(){return Gt.decodeHTML}});Object.defineProperty(oe,"decodeHTMLStrict",{enumerable:!0,get:function(){return Gt.decodeHTMLStrict}});Object.defineProperty(oe,"decodeHTMLAttribute",{enumerable:!0,get:function(){return Gt.decodeHTMLAttribute}});Object.defineProperty(oe,"decodeHTML4",{enumerable:!0,get:function(){return Gt.decodeHTML}});Object.defineProperty(oe,"decodeHTML5",{enumerable:!0,get:function(){return Gt.decodeHTML}});Object.defineProperty(oe,"decodeHTML4Strict",{enumerable:!0,get:function(){return Gt.decodeHTMLStrict}});Object.defineProperty(oe,"decodeHTML5Strict",{enumerable:!0,get:function(){return Gt.decodeHTMLStrict}});Object.defineProperty(oe,"decodeXMLStrict",{enumerable:!0,get:function(){return Gt.decodeXML}})});var Hf=R(zu=>{"use strict";Object.defineProperty(zu,"__esModule",{value:!0});zu.attributeNames=zu.elementNames=void 0;zu.elementNames=new Map(["altGlyph","altGlyphDef","altGlyphItem","animateColor","animateMotion","animateTransform","clipPath","feBlend","feColorMatrix","feComponentTransfer","feComposite","feConvolveMatrix","feDiffuseLighting","feDisplacementMap","feDistantLight","feDropShadow","feFlood","feFuncA","feFuncB","feFuncG","feFuncR","feGaussianBlur","feImage","feMerge","feMergeNode","feMorphology","feOffset","fePointLight","feSpecularLighting","feSpotLight","feTile","feTurbulence","foreignObject","glyphRef","linearGradient","radialGradient","textPath"].map(function(e){return[e.toLowerCase(),e]}));zu.attributeNames=new Map(["definitionURL","attributeName","attributeType","baseFrequency","baseProfile","calcMode","clipPathUnits","diffuseConstant","edgeMode","filterUnits","glyphRef","gradientTransform","gradientUnits","kernelMatrix","kernelUnitLength","keyPoints","keySplines","keyTimes","lengthAdjust","limitingConeAngle","markerHeight","markerUnits","markerWidth","maskContentUnits","maskUnits","numOctaves","pathLength","patternContentUnits","patternTransform","patternUnits","pointsAtX","pointsAtY","pointsAtZ","preserveAlpha","preserveAspectRatio","primitiveUnits","refX","refY","repeatCount","repeatDur","requiredExtensions","requiredFeatures","specularConstant","specularExponent","spreadMethod","startOffset","stdDeviation","stitchTiles","surfaceScale","systemLanguage","tableValues","targetX","targetY","textLength","viewBox","viewTarget","xChannelSelector","yChannelSelector","zoomAndPan"].map(function(e){return[e.toLowerCase(),e]}))});var ls=R(Ot=>{"use strict";var Yu=Ot&&Ot.__assign||function(){return Yu=Object.assign||function(e){for(var t,r=1,u=arguments.length;r<u;r++){t=arguments[r];for(var a in t)Object.prototype.hasOwnProperty.call(t,a)&&(e[a]=t[a])}return e},Yu.apply(this,arguments)},FE=Ot&&Ot.__createBinding||(Object.create?function(e,t,r,u){u===void 0&&(u=r);var a=Object.getOwnPropertyDescriptor(t,r);(!a||("get"in a?!t.__esModule:a.writable||a.configurable))&&(a={enumerable:!0,get:function(){return t[r]}}),Object.defineProperty(e,u,a)}:function(e,t,r,u){u===void 0&&(u=r),e[u]=t[r]}),kE=Ot&&Ot.__setModuleDefault||(Object.create?function(e,t){Object.defineProperty(e,"default",{enumerable:!0,value:t})}:function(e,t){e.default=t}),HE=Ot&&Ot.__importStar||function(e){if(e&&e.__esModule)return e;var t={};if(e!=null)for(var r in e)r!=="default"&&Object.prototype.hasOwnProperty.call(e,r)&&FE(t,e,r);return kE(t,e),t};Object.defineProperty(Ot,"__esModule",{value:!0});Ot.render=void 0;var Dr=HE(qu()),za=kf(),Gf=Hf(),UE=new Set(["style","script","xmp","iframe","noembed","noframes","plaintext","noscript"]);function GE(e){return e.replace(/"/g,"&quot;")}function qE(e,t){var r;if(e){var u=((r=t.encodeEntities)!==null&&r!==void 0?r:t.decodeEntities)===!1?GE:t.xmlMode||t.encodeEntities!=="utf8"?za.encodeXML:za.escapeAttribute;return Object.keys(e).map(function(a){var n,s,i=(n=e[a])!==null&&n!==void 0?n:"";return t.xmlMode==="foreign"&&(a=(s=Gf.attributeNames.get(a))!==null&&s!==void 0?s:a),!t.emptyAttrs&&!t.xmlMode&&i===""?a:"".concat(a,\'="\').concat(u(i),\'"\')}).join(" ")}}var Uf=new Set(["area","base","basefont","br","col","command","embed","frame","hr","img","input","isindex","keygen","link","meta","param","source","track","wbr"]);function Ya(e,t){t===void 0&&(t={});for(var r=("length"in e)?e:[e],u="",a=0;a<r.length;a++)u+=jE(r[a],t);return u}Ot.render=Ya;Ot.default=Ya;function jE(e,t){switch(e.type){case Dr.Root:return Ya(e.children,t);case Dr.Doctype:case Dr.Directive:return VE(e);case Dr.Comment:return KE(e);case Dr.CDATA:return XE(e);case Dr.Script:case Dr.Style:case Dr.Tag:return WE(e,t);case Dr.Text:return QE(e,t)}}var zE=new Set(["mi","mo","mn","ms","mtext","annotation-xml","foreignObject","desc","title"]),YE=new Set(["svg","math"]);function WE(e,t){var r;t.xmlMode==="foreign"&&(e.name=(r=Gf.elementNames.get(e.name))!==null&&r!==void 0?r:e.name,e.parent&&zE.has(e.parent.name)&&(t=Yu(Yu({},t),{xmlMode:!1}))),!t.xmlMode&&YE.has(e.name)&&(t=Yu(Yu({},t),{xmlMode:"foreign"}));var u="<".concat(e.name),a=qE(e.attribs,t);return a&&(u+=" ".concat(a)),e.children.length===0&&(t.xmlMode?t.selfClosingTags!==!1:t.selfClosingTags&&Uf.has(e.name))?(t.xmlMode||(u+=" "),u+="/>"):(u+=">",e.children.length>0&&(u+=Ya(e.children,t)),(t.xmlMode||!Uf.has(e.name))&&(u+="</".concat(e.name,">"))),u}function VE(e){return"<".concat(e.data,">")}function QE(e,t){var r,u=e.data||"";return((r=t.encodeEntities)!==null&&r!==void 0?r:t.decodeEntities)!==!1&&!(!t.xmlMode&&e.parent&&UE.has(e.parent.name))&&(u=t.xmlMode||t.encodeEntities!=="utf8"?(0,za.encodeXML)(u):(0,za.escapeText)(u)),u}function XE(e){return"<![CDATA[".concat(e.children[0].data,"]]>")}function KE(e){return"<!--".concat(e.data,"-->")}});var ps=R(Cr=>{"use strict";var $E=Cr&&Cr.__importDefault||function(e){return e&&e.__esModule?e:{default:e}};Object.defineProperty(Cr,"__esModule",{value:!0});Cr.getOuterHTML=qf;Cr.getInnerHTML=e3;Cr.getText=Wa;Cr.textContent=ds;Cr.innerText=hs;var nr=st(),ZE=$E(ls()),JE=qu();function qf(e,t){return(0,ZE.default)(e,t)}function e3(e,t){return(0,nr.hasChildren)(e)?e.children.map(function(r){return qf(r,t)}).join(""):""}function Wa(e){return Array.isArray(e)?e.map(Wa).join(""):(0,nr.isTag)(e)?e.name==="br"?`\n`:Wa(e.children):(0,nr.isCDATA)(e)?Wa(e.children):(0,nr.isText)(e)?e.data:""}function ds(e){return Array.isArray(e)?e.map(ds).join(""):(0,nr.hasChildren)(e)&&!(0,nr.isComment)(e)?ds(e.children):(0,nr.isText)(e)?e.data:""}function hs(e){return Array.isArray(e)?e.map(hs).join(""):(0,nr.hasChildren)(e)&&(e.type===JE.ElementType.Tag||(0,nr.isCDATA)(e))?hs(e.children):(0,nr.isText)(e)?e.data:""}});var Yf=R(ir=>{"use strict";Object.defineProperty(ir,"__esModule",{value:!0});ir.getChildren=jf;ir.getParent=zf;ir.getSiblings=t3;ir.getAttributeValue=r3;ir.hasAttrib=u3;ir.getName=a3;ir.nextElementSibling=n3;ir.prevElementSibling=i3;var bs=st();function jf(e){return(0,bs.hasChildren)(e)?e.children:[]}function zf(e){return e.parent||null}function t3(e){var t,r,u=zf(e);if(u!=null)return jf(u);for(var a=[e],n=e.prev,s=e.next;n!=null;)a.unshift(n),t=n,n=t.prev;for(;s!=null;)a.push(s),r=s,s=r.next;return a}function r3(e,t){var r;return(r=e.attribs)===null||r===void 0?void 0:r[t]}function u3(e,t){return e.attribs!=null&&Object.prototype.hasOwnProperty.call(e.attribs,t)&&e.attribs[t]!=null}function a3(e){return e.name}function n3(e){for(var t,r=e.next;r!==null&&!(0,bs.isTag)(r);)t=r,r=t.next;return r}function i3(e){for(var t,r=e.prev;r!==null&&!(0,bs.isTag)(r);)t=r,r=t.prev;return r}});var Wf=R(zr=>{"use strict";Object.defineProperty(zr,"__esModule",{value:!0});zr.removeElement=k0;zr.replaceElement=s3;zr.appendChild=o3;zr.append=c3;zr.prependChild=f3;zr.prepend=l3;function k0(e){if(e.prev&&(e.prev.next=e.next),e.next&&(e.next.prev=e.prev),e.parent){var t=e.parent.children,r=t.lastIndexOf(e);r>=0&&t.splice(r,1)}e.next=null,e.prev=null,e.parent=null}function s3(e,t){var r=t.prev=e.prev;r&&(r.next=t);var u=t.next=e.next;u&&(u.prev=t);var a=t.parent=e.parent;if(a){var n=a.children;n[n.lastIndexOf(e)]=t,e.parent=null}}function o3(e,t){if(k0(t),t.next=null,t.parent=e,e.children.push(t)>1){var r=e.children[e.children.length-2];r.next=t,t.prev=r}else t.prev=null}function c3(e,t){k0(t);var r=e.parent,u=e.next;if(t.next=u,t.prev=e,e.next=t,t.parent=r,u){if(u.prev=t,r){var a=r.children;a.splice(a.lastIndexOf(u),0,t)}}else r&&r.children.push(t)}function f3(e,t){if(k0(t),t.parent=e,t.prev=null,e.children.unshift(t)!==1){var r=e.children[1];r.prev=t,t.next=r}else t.next=null}function l3(e,t){k0(t);var r=e.parent;if(r){var u=r.children;u.splice(u.indexOf(e),0,t)}e.prev&&(e.prev.next=t),t.parent=r,t.prev=e.prev,t.next=e,e.prev=t}});var _s=R(Yr=>{"use strict";Object.defineProperty(Yr,"__esModule",{value:!0});Yr.filter=d3;Yr.find=Vf;Yr.findOneChild=h3;Yr.findOne=Qf;Yr.existsOne=Xf;Yr.findAll=p3;var Eu=st();function d3(e,t,r,u){return r===void 0&&(r=!0),u===void 0&&(u=1/0),Vf(e,Array.isArray(t)?t:[t],r,u)}function Vf(e,t,r,u){for(var a=[],n=[Array.isArray(t)?t:[t]],s=[0];;){if(s[0]>=n[0].length){if(s.length===1)return a;n.shift(),s.shift();continue}var i=n[0][s[0]++];if(e(i)&&(a.push(i),--u<=0))return a;r&&(0,Eu.hasChildren)(i)&&i.children.length>0&&(s.unshift(0),n.unshift(i.children))}}function h3(e,t){return t.find(e)}function Qf(e,t,r){r===void 0&&(r=!0);for(var u=Array.isArray(t)?t:[t],a=0;a<u.length;a++){var n=u[a];if((0,Eu.isTag)(n)&&e(n))return n;if(r&&(0,Eu.hasChildren)(n)&&n.children.length>0){var s=Qf(e,n.children,!0);if(s)return s}}return null}function Xf(e,t){return(Array.isArray(t)?t:[t]).some(function(r){return(0,Eu.isTag)(r)&&e(r)||(0,Eu.hasChildren)(r)&&Xf(e,r.children)})}function p3(e,t){for(var r=[],u=[Array.isArray(t)?t:[t]],a=[0];;){if(a[0]>=u[0].length){if(u.length===1)return r;u.shift(),a.shift();continue}var n=u[0][a[0]++];(0,Eu.isTag)(n)&&e(n)&&r.push(n),(0,Eu.hasChildren)(n)&&n.children.length>0&&(a.unshift(0),u.unshift(n.children))}}});var Ts=R(Wr=>{"use strict";Object.defineProperty(Wr,"__esModule",{value:!0});Wr.testElement=_3;Wr.getElements=E3;Wr.getElementById=T3;Wr.getElementsByTagName=x3;Wr.getElementsByClassName=A3;Wr.getElementsByTagType=m3;var Tu=st(),H0=_s(),Va={tag_name:function(e){return typeof e=="function"?function(t){return(0,Tu.isTag)(t)&&e(t.name)}:e==="*"?Tu.isTag:function(t){return(0,Tu.isTag)(t)&&t.name===e}},tag_type:function(e){return typeof e=="function"?function(t){return e(t.type)}:function(t){return t.type===e}},tag_contains:function(e){return typeof e=="function"?function(t){return(0,Tu.isText)(t)&&e(t.data)}:function(t){return(0,Tu.isText)(t)&&t.data===e}}};function Es(e,t){return typeof t=="function"?function(r){return(0,Tu.isTag)(r)&&t(r.attribs[e])}:function(r){return(0,Tu.isTag)(r)&&r.attribs[e]===t}}function b3(e,t){return function(r){return e(r)||t(r)}}function Kf(e){var t=Object.keys(e).map(function(r){var u=e[r];return Object.prototype.hasOwnProperty.call(Va,r)?Va[r](u):Es(r,u)});return t.length===0?null:t.reduce(b3)}function _3(e,t){var r=Kf(e);return r?r(t):!0}function E3(e,t,r,u){u===void 0&&(u=1/0);var a=Kf(e);return a?(0,H0.filter)(a,t,r,u):[]}function T3(e,t,r){return r===void 0&&(r=!0),Array.isArray(t)||(t=[t]),(0,H0.findOne)(Es("id",e),t,r)}function x3(e,t,r,u){return r===void 0&&(r=!0),u===void 0&&(u=1/0),(0,H0.filter)(Va.tag_name(e),t,r,u)}function A3(e,t,r,u){return r===void 0&&(r=!0),u===void 0&&(u=1/0),(0,H0.filter)(Es("class",e),t,r,u)}function m3(e,t,r,u){return r===void 0&&(r=!0),u===void 0&&(u=1/0),(0,H0.filter)(Va.tag_type(e),t,r,u)}});var Jf=R(xu=>{"use strict";Object.defineProperty(xu,"__esModule",{value:!0});xu.DocumentPosition=void 0;xu.removeSubsets=g3;xu.compareDocumentPosition=Zf;xu.uniqueSort=v3;var $f=st();function g3(e){for(var t=e.length;--t>=0;){var r=e[t];if(t>0&&e.lastIndexOf(r,t-1)>=0){e.splice(t,1);continue}for(var u=r.parent;u;u=u.parent)if(e.includes(u)){e.splice(t,1);break}}return e}var qt;(function(e){e[e.DISCONNECTED=1]="DISCONNECTED",e[e.PRECEDING=2]="PRECEDING",e[e.FOLLOWING=4]="FOLLOWING",e[e.CONTAINS=8]="CONTAINS",e[e.CONTAINED_BY=16]="CONTAINED_BY"})(qt||(xu.DocumentPosition=qt={}));function Zf(e,t){var r=[],u=[];if(e===t)return 0;for(var a=(0,$f.hasChildren)(e)?e:e.parent;a;)r.unshift(a),a=a.parent;for(a=(0,$f.hasChildren)(t)?t:t.parent;a;)u.unshift(a),a=a.parent;for(var n=Math.min(r.length,u.length),s=0;s<n&&r[s]===u[s];)s++;if(s===0)return qt.DISCONNECTED;var i=r[s-1],c=i.children,o=r[s],f=u[s];return c.indexOf(o)>c.indexOf(f)?i===t?qt.FOLLOWING|qt.CONTAINED_BY:qt.FOLLOWING:i===e?qt.PRECEDING|qt.CONTAINS:qt.PRECEDING}function v3(e){return e=e.filter(function(t,r,u){return!u.includes(t,r+1)}),e.sort(function(t,r){var u=Zf(t,r);return u&qt.PRECEDING?-1:u&qt.FOLLOWING?1:0}),e}});var tl=R(xs=>{"use strict";Object.defineProperty(xs,"__esModule",{value:!0});xs.getFeed=D3;var y3=ps(),U0=Ts();function D3(e){var t=Qa(O3,e);return t?t.name==="feed"?C3(t):I3(t):null}function C3(e){var t,r=e.children,u={type:"atom",items:(0,U0.getElementsByTagName)("entry",r).map(function(s){var i,c=s.children,o={media:el(c)};vt(o,"id","id",c),vt(o,"title","title",c);var f=(i=Qa("link",c))===null||i===void 0?void 0:i.attribs.href;f&&(o.link=f);var p=Vr("summary",c)||Vr("content",c);p&&(o.description=p);var d=Vr("updated",c);return d&&(o.pubDate=new Date(d)),o})};vt(u,"id","id",r),vt(u,"title","title",r);var a=(t=Qa("link",r))===null||t===void 0?void 0:t.attribs.href;a&&(u.link=a),vt(u,"description","subtitle",r);var n=Vr("updated",r);return n&&(u.updated=new Date(n)),vt(u,"author","email",r,!0),u}function I3(e){var t,r,u=(r=(t=Qa("channel",e.children))===null||t===void 0?void 0:t.children)!==null&&r!==void 0?r:[],a={type:e.name.substr(0,3),id:"",items:(0,U0.getElementsByTagName)("item",e.children).map(function(s){var i=s.children,c={media:el(i)};vt(c,"id","guid",i),vt(c,"title","title",i),vt(c,"link","link",i),vt(c,"description","description",i);var o=Vr("pubDate",i)||Vr("dc:date",i);return o&&(c.pubDate=new Date(o)),c})};vt(a,"title","title",u),vt(a,"link","link",u),vt(a,"description","description",u);var n=Vr("lastBuildDate",u);return n&&(a.updated=new Date(n)),vt(a,"author","managingEditor",u,!0),a}var S3=["url","type","lang"],N3=["fileSize","bitrate","framerate","samplingrate","channels","duration","height","width"];function el(e){return(0,U0.getElementsByTagName)("media:content",e).map(function(t){for(var r=t.attribs,u={medium:r.medium,isDefault:!!r.isDefault},a=0,n=S3;a<n.length;a++){var s=n[a];r[s]&&(u[s]=r[s])}for(var i=0,c=N3;i<c.length;i++){var s=c[i];r[s]&&(u[s]=parseInt(r[s],10))}return r.expression&&(u.expression=r.expression),u})}function Qa(e,t){return(0,U0.getElementsByTagName)(e,t,!0,1)[0]}function Vr(e,t,r){return r===void 0&&(r=!1),(0,y3.textContent)((0,U0.getElementsByTagName)(e,t,r,1)).trim()}function vt(e,t,r,u,a){a===void 0&&(a=!1);var n=Vr(r,u,a);n&&(e[t]=n)}function O3(e){return e==="rss"||e==="feed"||e==="rdf:RDF"}});var jt=R(Le=>{"use strict";var R3=Le&&Le.__createBinding||(Object.create?function(e,t,r,u){u===void 0&&(u=r);var a=Object.getOwnPropertyDescriptor(t,r);(!a||("get"in a?!t.__esModule:a.writable||a.configurable))&&(a={enumerable:!0,get:function(){return t[r]}}),Object.defineProperty(e,u,a)}:function(e,t,r,u){u===void 0&&(u=r),e[u]=t[r]}),Au=Le&&Le.__exportStar||function(e,t){for(var r in e)r!=="default"&&!Object.prototype.hasOwnProperty.call(t,r)&&R3(t,e,r)};Object.defineProperty(Le,"__esModule",{value:!0});Le.hasChildren=Le.isDocument=Le.isComment=Le.isText=Le.isCDATA=Le.isTag=void 0;Au(ps(),Le);Au(Yf(),Le);Au(Wf(),Le);Au(_s(),Le);Au(Ts(),Le);Au(Jf(),Le);Au(tl(),Le);var Wu=st();Object.defineProperty(Le,"isTag",{enumerable:!0,get:function(){return Wu.isTag}});Object.defineProperty(Le,"isCDATA",{enumerable:!0,get:function(){return Wu.isCDATA}});Object.defineProperty(Le,"isText",{enumerable:!0,get:function(){return Wu.isText}});Object.defineProperty(Le,"isComment",{enumerable:!0,get:function(){return Wu.isComment}});Object.defineProperty(Le,"isDocument",{enumerable:!0,get:function(){return Wu.isDocument}});Object.defineProperty(Le,"hasChildren",{enumerable:!0,get:function(){return Wu.hasChildren}})});var gu=R(Me=>{"use strict";var mu=Me&&Me.__assign||function(){return mu=Object.assign||function(e){for(var t,r=1,u=arguments.length;r<u;r++){t=arguments[r];for(var a in t)Object.prototype.hasOwnProperty.call(t,a)&&(e[a]=t[a])}return e},mu.apply(this,arguments)},P3=Me&&Me.__createBinding||(Object.create?function(e,t,r,u){u===void 0&&(u=r);var a=Object.getOwnPropertyDescriptor(t,r);(!a||("get"in a?!t.__esModule:a.writable||a.configurable))&&(a={enumerable:!0,get:function(){return t[r]}}),Object.defineProperty(e,u,a)}:function(e,t,r,u){u===void 0&&(u=r),e[u]=t[r]}),B3=Me&&Me.__setModuleDefault||(Object.create?function(e,t){Object.defineProperty(e,"default",{enumerable:!0,value:t})}:function(e,t){e.default=t}),w3=Me&&Me.__importStar||function(e){if(e&&e.__esModule)return e;var t={};if(e!=null)for(var r in e)r!=="default"&&Object.prototype.hasOwnProperty.call(e,r)&&P3(t,e,r);return B3(t,e),t};Object.defineProperty(Me,"__esModule",{value:!0});Me.merge=Me.contains=Me.root=Me.parseHTML=Me.text=Me.xml=Me.html=void 0;var L3=jt(),As=w3(Qi());function ul(e,t,r){return e?e(t!=null?t:e._root.children,null,void 0,r).toString():""}function M3(e,t){return!t&&typeof e=="object"&&e!=null&&!("length"in e)&&!("type"in e)}function F3(e,t){var r=M3(e)?(t=e,void 0):e,u=mu(mu(mu({},As.default),this===null||this===void 0?void 0:this._options),(0,As.flatten)(t!=null?t:{}));return ul(this,r,u)}Me.html=F3;function k3(e){var t=mu(mu({},this._options),{xmlMode:!0});return ul(this,e,t)}Me.xml=k3;function H3(e){for(var t=e||(this?this.root():[]),r="",u=0;u<t.length;u++)r+=(0,L3.textContent)(t[u]);return r}Me.text=H3;function U3(e,t,r){if(r===void 0&&(r=typeof t=="boolean"?t:!1),!e||typeof e!="string")return null;typeof t=="boolean"&&(r=t);var u=this.load(e,As.default,!1);return r||u("script").remove(),u.root()[0].children.slice()}Me.parseHTML=U3;function G3(){return this(this._root)}Me.root=G3;function q3(e,t){if(t===e)return!1;for(var r=t;r&&r!==r.parent;)if(r=r.parent,r===e)return!0;return!1}Me.contains=q3;function j3(e,t){if(!(!rl(e)||!rl(t))){for(var r=e.length,u=+t.length,a=0;a<u;a++)e[r++]=t[a];return e.length=r,e}}Me.merge=j3;function rl(e){if(Array.isArray(e))return!0;if(typeof e!="object"||!Object.prototype.hasOwnProperty.call(e,"length")||typeof e.length!="number"||e.length<0)return!1;for(var t=0;t<e.length;t++)if(!(t in e))return!1;return!0}});var yu=R(ot=>{"use strict";Object.defineProperty(ot,"__esModule",{value:!0});ot.isHtml=ot.cloneDom=ot.domEach=ot.cssCase=ot.camelCase=ot.isCheerio=ot.isTag=void 0;var ms=st(),z3=st();Object.defineProperty(ot,"isTag",{enumerable:!0,get:function(){return z3.isTag}});function Y3(e){return e.cheerio!=null}ot.isCheerio=Y3;function W3(e){return e.replace(/[_.-](\\w|$)/g,function(t,r){return r.toUpperCase()})}ot.camelCase=W3;function V3(e){return e.replace(/[A-Z]/g,"-$&").toLowerCase()}ot.cssCase=V3;function Q3(e,t){for(var r=e.length,u=0;u<r;u++)t(e[u],u);return e}ot.domEach=Q3;function X3(e){var t="length"in e?Array.prototype.map.call(e,function(u){return(0,ms.cloneNode)(u,!0)}):[(0,ms.cloneNode)(e,!0)],r=new ms.Document(t);return t.forEach(function(u){u.parent=r}),t}ot.cloneDom=X3;var vu;(function(e){e[e.LowerA=97]="LowerA",e[e.LowerZ=122]="LowerZ",e[e.UpperA=65]="UpperA",e[e.UpperZ=90]="UpperZ",e[e.Exclamation=33]="Exclamation"})(vu||(vu={}));function K3(e){var t=e.indexOf("<");if(t<0||t>e.length-3)return!1;var r=e.charCodeAt(t+1);return(r>=vu.LowerA&&r<=vu.LowerZ||r>=vu.UpperA&&r<=vu.UpperZ||r===vu.Exclamation)&&e.includes(">",t+2)}ot.isHtml=K3});var pl=R(je=>{"use strict";Object.defineProperty(je,"__esModule",{value:!0});je.toggleClass=je.removeClass=je.addClass=je.hasClass=je.removeAttr=je.val=je.data=je.prop=je.attr=void 0;var cl=gu(),Se=yu(),al=jt(),Vu=Object.prototype.hasOwnProperty,G0=/\\s+/,gs="data-",nl={null:null,true:!0,false:!1},ys=/^(?:autofocus|autoplay|async|checked|controls|defer|disabled|hidden|loop|multiple|open|readonly|required|scoped|selected)$/i,$3=/^{[^]*}$|^\\[[^]*]$/;function Xa(e,t,r){var u;if(!(!e||!(0,Se.isTag)(e))){if((u=e.attribs)!==null&&u!==void 0||(e.attribs={}),!t)return e.attribs;if(Vu.call(e.attribs,t))return!r&&ys.test(t)?t:e.attribs[t];if(e.name==="option"&&t==="value")return(0,cl.text)(e.children);if(e.name==="input"&&(e.attribs.type==="radio"||e.attribs.type==="checkbox")&&t==="value")return"on"}}function Qu(e,t,r){r===null?fl(e,t):e.attribs[t]="".concat(r)}function Z3(e,t){if(typeof e=="object"||t!==void 0){if(typeof t=="function"){if(typeof e!="string")throw new Error("Bad combination of arguments.");return(0,Se.domEach)(this,function(r,u){(0,Se.isTag)(r)&&Qu(r,e,t.call(r,u,r.attribs[e]))})}return(0,Se.domEach)(this,function(r){(0,Se.isTag)(r)&&(typeof e=="object"?Object.keys(e).forEach(function(u){var a=e[u];Qu(r,u,a)}):Qu(r,e,t))})}return arguments.length>1?this:Xa(this[0],e,this.options.xmlMode)}je.attr=Z3;function il(e,t,r){return t in e?e[t]:!r&&ys.test(t)?Xa(e,t,!1)!==void 0:Xa(e,t,r)}function vs(e,t,r,u){t in e?e[t]=r:Qu(e,t,!u&&ys.test(t)?r?"":null:"".concat(r))}function J3(e,t){var r=this,u;if(typeof e=="string"&&t===void 0){var a=this[0];if(!a||!(0,Se.isTag)(a))return;switch(e){case"style":{var n=this.css(),s=Object.keys(n);return s.forEach(function(c,o){n[o]=c}),n.length=s.length,n}case"tagName":case"nodeName":return a.name.toUpperCase();case"href":case"src":{var i=(u=a.attribs)===null||u===void 0?void 0:u[e];return typeof URL!="undefined"&&(e==="href"&&(a.tagName==="a"||a.name==="link")||e==="src"&&(a.tagName==="img"||a.tagName==="iframe"||a.tagName==="audio"||a.tagName==="video"||a.tagName==="source"))&&i!==void 0&&this.options.baseURI?new URL(i,this.options.baseURI).href:i}case"innerText":return(0,al.innerText)(a);case"textContent":return(0,al.textContent)(a);case"outerHTML":return this.clone().wrap("<container />").parent().html();case"innerHTML":return this.html();default:return il(a,e,this.options.xmlMode)}}if(typeof e=="object"||t!==void 0){if(typeof t=="function"){if(typeof e=="object")throw new Error("Bad combination of arguments.");return(0,Se.domEach)(this,function(c,o){(0,Se.isTag)(c)&&vs(c,e,t.call(c,o,il(c,e,r.options.xmlMode)),r.options.xmlMode)})}return(0,Se.domEach)(this,function(c){(0,Se.isTag)(c)&&(typeof e=="object"?Object.keys(e).forEach(function(o){var f=e[o];vs(c,o,f,r.options.xmlMode)}):vs(c,e,t,r.options.xmlMode))})}}je.prop=J3;function sl(e,t,r){var u,a=e;(u=a.data)!==null&&u!==void 0||(a.data={}),typeof t=="object"?Object.assign(a.data,t):typeof t=="string"&&r!==void 0&&(a.data[t]=r)}function ol(e,t){var r,u,a;t==null?(r=Object.keys(e.attribs).filter(function(c){return c.startsWith(gs)}),u=r.map(function(c){return(0,Se.camelCase)(c.slice(gs.length))})):(r=[gs+(0,Se.cssCase)(t)],u=[t]);for(var n=0;n<r.length;++n){var s=r[n],i=u[n];if(Vu.call(e.attribs,s)&&!Vu.call(e.data,i)){if(a=e.attribs[s],Vu.call(nl,a))a=nl[a];else if(a===String(Number(a)))a=Number(a);else if($3.test(a))try{a=JSON.parse(a)}catch(c){}e.data[i]=a}}return t==null?e.data:a}function e6(e,t){var r,u=this[0];if(!(!u||!(0,Se.isTag)(u))){var a=u;return(r=a.data)!==null&&r!==void 0||(a.data={}),e?typeof e=="object"||t!==void 0?((0,Se.domEach)(this,function(n){(0,Se.isTag)(n)&&(typeof e=="object"?sl(n,e):sl(n,e,t))}),this):Vu.call(a.data,e)?a.data[e]:ol(a,e):ol(a)}}je.data=e6;function t6(e){var t=arguments.length===0,r=this[0];if(!r||!(0,Se.isTag)(r))return t?void 0:this;switch(r.name){case"textarea":return this.text(e);case"select":{var u=this.find("option:selected");if(!t){if(this.attr("multiple")==null&&typeof e=="object")return this;this.find("option").removeAttr("selected");for(var a=typeof e!="object"?[e]:e,n=0;n<a.length;n++)this.find(\'option[value="\'.concat(a[n],\'"]\')).attr("selected","");return this}return this.attr("multiple")?u.toArray().map(function(s){return(0,cl.text)(s.children)}):u.attr("value")}case"input":case"option":return t?this.attr("value"):this.attr("value",e)}}je.val=t6;function fl(e,t){!e.attribs||!Vu.call(e.attribs,t)||delete e.attribs[t]}function Ka(e){return e?e.trim().split(G0):[]}function r6(e){for(var t=Ka(e),r=function(n){(0,Se.domEach)(u,function(s){(0,Se.isTag)(s)&&fl(s,t[n])})},u=this,a=0;a<t.length;a++)r(a);return this}je.removeAttr=r6;function u6(e){return this.toArray().some(function(t){var r=(0,Se.isTag)(t)&&t.attribs.class,u=-1;if(r&&e.length)for(;(u=r.indexOf(e,u+1))>-1;){var a=u+e.length;if((u===0||G0.test(r[u-1]))&&(a===r.length||G0.test(r[a])))return!0}return!1})}je.hasClass=u6;function ll(e){if(typeof e=="function")return(0,Se.domEach)(this,function(o,f){if((0,Se.isTag)(o)){var p=o.attribs.class||"";ll.call([o],e.call(o,f,p))}});if(!e||typeof e!="string")return this;for(var t=e.split(G0),r=this.length,u=0;u<r;u++){var a=this[u];if((0,Se.isTag)(a)){var n=Xa(a,"class",!1);if(!n)Qu(a,"class",t.join(" ").trim());else{for(var s=" ".concat(n," "),i=0;i<t.length;i++){var c="".concat(t[i]," ");s.includes(" ".concat(c))||(s+=c)}Qu(a,"class",s.trim())}}}return this}je.addClass=ll;function dl(e){if(typeof e=="function")return(0,Se.domEach)(this,function(a,n){(0,Se.isTag)(a)&&dl.call([a],e.call(a,n,a.attribs.class||""))});var t=Ka(e),r=t.length,u=arguments.length===0;return(0,Se.domEach)(this,function(a){if((0,Se.isTag)(a))if(u)a.attribs.class="";else{for(var n=Ka(a.attribs.class),s=!1,i=0;i<r;i++){var c=n.indexOf(t[i]);c>=0&&(n.splice(c,1),s=!0,i--)}s&&(a.attribs.class=n.join(" "))}})}je.removeClass=dl;function hl(e,t){if(typeof e=="function")return(0,Se.domEach)(this,function(p,d){(0,Se.isTag)(p)&&hl.call([p],e.call(p,d,p.attribs.class||"",t),t)});if(!e||typeof e!="string")return this;for(var r=e.split(G0),u=r.length,a=typeof t=="boolean"?t?1:-1:0,n=this.length,s=0;s<n;s++){var i=this[s];if((0,Se.isTag)(i)){for(var c=Ka(i.attribs.class),o=0;o<u;o++){var f=c.indexOf(r[o]);a>=0&&f<0?c.push(r[o]):a<=0&&f>=0&&c.splice(f,1)}i.attribs.class=c.join(" ")}}return this}je.toggleClass=hl});var $a=R(sr=>{"use strict";Object.defineProperty(sr,"__esModule",{value:!0});sr.AttributeAction=sr.IgnoreCaseMode=sr.SelectorType=void 0;var a6;(function(e){e.Attribute="attribute",e.Pseudo="pseudo",e.PseudoElement="pseudo-element",e.Tag="tag",e.Universal="universal",e.Adjacent="adjacent",e.Child="child",e.Descendant="descendant",e.Parent="parent",e.Sibling="sibling",e.ColumnCombinator="column-combinator"})(a6=sr.SelectorType||(sr.SelectorType={}));sr.IgnoreCaseMode={Unknown:null,QuirksMode:"quirks",IgnoreCase:!0,CaseSensitive:!1};var n6;(function(e){e.Any="any",e.Element="element",e.End="end",e.Equals="equals",e.Exists="exists",e.Hyphen="hyphen",e.Not="not",e.Start="start"})(n6=sr.AttributeAction||(sr.AttributeAction={}))});var xl=R(Xu=>{"use strict";Object.defineProperty(Xu,"__esModule",{value:!0});Xu.parse=Xu.isTraversal=void 0;var De=$a(),bl=/^[^\\\\#]?(?:\\\\(?:[\\da-f]{1,6}\\s?|.)|[\\w\\-\\u00b0-\\uFFFF])+/,i6=/\\\\([\\da-f]{1,6}\\s?|(\\s)|.)/gi,s6=new Map([[126,De.AttributeAction.Element],[94,De.AttributeAction.Start],[36,De.AttributeAction.End],[42,De.AttributeAction.Any],[33,De.AttributeAction.Not],[124,De.AttributeAction.Hyphen]]),o6=new Set(["has","not","matches","is","where","host","host-context"]);function El(e){switch(e.type){case De.SelectorType.Adjacent:case De.SelectorType.Child:case De.SelectorType.Descendant:case De.SelectorType.Parent:case De.SelectorType.Sibling:case De.SelectorType.ColumnCombinator:return!0;default:return!1}}Xu.isTraversal=El;var c6=new Set(["contains","icontains"]);function f6(e,t,r){var u=parseInt(t,16)-65536;return u!==u||r?t:u<0?String.fromCharCode(u+65536):String.fromCharCode(u>>10|55296,u&1023|56320)}function q0(e){return e.replace(i6,f6)}function Ds(e){return e===39||e===34}function _l(e){return e===32||e===9||e===10||e===12||e===13}function l6(e){var t=[],r=Tl(t,"".concat(e),0);if(r<e.length)throw new Error("Unmatched selector: ".concat(e.slice(r)));return t}Xu.parse=l6;function Tl(e,t,r){var u=[];function a(w){var S=t.slice(r+w).match(bl);if(!S)throw new Error("Expected name, found ".concat(t.slice(r)));var X=S[0];return r+=w+X.length,q0(X)}function n(w){for(r+=w;r<t.length&&_l(t.charCodeAt(r));)r++}function s(){r+=1;for(var w=r,S=1;S>0&&r<t.length;r++)t.charCodeAt(r)===40&&!i(r)?S++:t.charCodeAt(r)===41&&!i(r)&&S--;if(S)throw new Error("Parenthesis not matched");return q0(t.slice(w,r-1))}function i(w){for(var S=0;t.charCodeAt(--w)===92;)S++;return(S&1)===1}function c(){if(u.length>0&&El(u[u.length-1]))throw new Error("Did not expect successive traversals.")}function o(w){if(u.length>0&&u[u.length-1].type===De.SelectorType.Descendant){u[u.length-1].type=w;return}c(),u.push({type:w})}function f(w,S){u.push({type:De.SelectorType.Attribute,name:w,action:S,value:a(1),namespace:null,ignoreCase:"quirks"})}function p(){if(u.length&&u[u.length-1].type===De.SelectorType.Descendant&&u.pop(),u.length===0)throw new Error("Empty sub-selector");e.push(u)}if(n(0),t.length===r)return r;e:for(;r<t.length;){var d=t.charCodeAt(r);switch(d){case 32:case 9:case 10:case 12:case 13:{(u.length===0||u[0].type!==De.SelectorType.Descendant)&&(c(),u.push({type:De.SelectorType.Descendant})),n(1);break}case 62:{o(De.SelectorType.Child),n(1);break}case 60:{o(De.SelectorType.Parent),n(1);break}case 126:{o(De.SelectorType.Sibling),n(1);break}case 43:{o(De.SelectorType.Adjacent),n(1);break}case 46:{f("class",De.AttributeAction.Element);break}case 35:{f("id",De.AttributeAction.Equals);break}case 91:{n(1);var b=void 0,_=null;t.charCodeAt(r)===124?b=a(1):t.startsWith("*|",r)?(_="*",b=a(2)):(b=a(0),t.charCodeAt(r)===124&&t.charCodeAt(r+1)!==61&&(_=b,b=a(1))),n(0);var C=De.AttributeAction.Exists,D=s6.get(t.charCodeAt(r));if(D){if(C=D,t.charCodeAt(r+1)!==61)throw new Error("Expected `=`");n(2)}else t.charCodeAt(r)===61&&(C=De.AttributeAction.Equals,n(1));var T="",A=null;if(C!=="exists"){if(Ds(t.charCodeAt(r))){for(var v=t.charCodeAt(r),g=r+1;g<t.length&&(t.charCodeAt(g)!==v||i(g));)g+=1;if(t.charCodeAt(g)!==v)throw new Error("Attribute value didn\'t end");T=q0(t.slice(r+1,g)),r=g+1}else{for(var N=r;r<t.length&&(!_l(t.charCodeAt(r))&&t.charCodeAt(r)!==93||i(r));)r+=1;T=q0(t.slice(N,r))}n(0);var P=t.charCodeAt(r)|32;P===115?(A=!1,n(1)):P===105&&(A=!0,n(1))}if(t.charCodeAt(r)!==93)throw new Error("Attribute selector didn\'t terminate");r+=1;var H={type:De.SelectorType.Attribute,name:b,action:C,value:T,namespace:_,ignoreCase:A};u.push(H);break}case 58:{if(t.charCodeAt(r+1)===58){u.push({type:De.SelectorType.PseudoElement,name:a(2).toLowerCase(),data:t.charCodeAt(r)===40?s():null});continue}var k=a(1).toLowerCase(),B=null;if(t.charCodeAt(r)===40)if(o6.has(k)){if(Ds(t.charCodeAt(r+1)))throw new Error("Pseudo-selector ".concat(k," cannot be quoted"));if(B=[],r=Tl(B,t,r+1),t.charCodeAt(r)!==41)throw new Error("Missing closing parenthesis in :".concat(k," (").concat(t,")"));r+=1}else{if(B=s(),c6.has(k)){var j=B.charCodeAt(0);j===B.charCodeAt(B.length-1)&&Ds(j)&&(B=B.slice(1,-1))}B=q0(B)}u.push({type:De.SelectorType.Pseudo,name:k,data:B});break}case 44:{p(),u=[],n(1);break}default:{if(t.startsWith("/*",r)){var L=t.indexOf("*/",r+2);if(L<0)throw new Error("Comment was not terminated");r=L+2,u.length===0&&n(0);break}var _=null,F=void 0;if(d===42)r+=1,F="*";else if(d===124){if(F="",t.charCodeAt(r+1)===124){o(De.SelectorType.ColumnCombinator),n(2);break}}else if(bl.test(t.slice(r)))F=a(0);else break e;t.charCodeAt(r)===124&&t.charCodeAt(r+1)!==124&&(_=F,t.charCodeAt(r+1)===42?(F="*",r+=2):F=a(1)),u.push(F==="*"?{type:De.SelectorType.Universal,namespace:_}:{type:De.SelectorType.Tag,name:F,namespace:_})}}}return p(),r}});var Cl=R($u=>{"use strict";var Za=$u&&$u.__spreadArray||function(e,t,r){if(r||arguments.length===2)for(var u=0,a=t.length,n;u<a;u++)(n||!(u in t))&&(n||(n=Array.prototype.slice.call(t,0,u)),n[u]=t[u]);return e.concat(n||Array.prototype.slice.call(t))};Object.defineProperty($u,"__esModule",{value:!0});$u.stringify=void 0;var Ue=$a(),gl=["\\\\",\'"\'],vl=Za(Za([],gl,!0),["(",")"],!1),d6=new Set(gl.map(function(e){return e.charCodeAt(0)})),Al=new Set(vl.map(function(e){return e.charCodeAt(0)})),Ku=new Set(Za(Za([],vl,!0),["~","^","$","*","+","!","|",":","[","]"," ","."],!1).map(function(e){return e.charCodeAt(0)}));function yl(e){return e.map(function(t){return t.map(h6).join("")}).join(", ")}$u.stringify=yl;function h6(e,t,r){switch(e.type){case Ue.SelectorType.Child:return t===0?"> ":" > ";case Ue.SelectorType.Parent:return t===0?"< ":" < ";case Ue.SelectorType.Sibling:return t===0?"~ ":" ~ ";case Ue.SelectorType.Adjacent:return t===0?"+ ":" + ";case Ue.SelectorType.Descendant:return" ";case Ue.SelectorType.ColumnCombinator:return t===0?"|| ":" || ";case Ue.SelectorType.Universal:return e.namespace==="*"&&t+1<r.length&&"name"in r[t+1]?"":"".concat(Dl(e.namespace),"*");case Ue.SelectorType.Tag:return ml(e);case Ue.SelectorType.PseudoElement:return"::".concat(Ir(e.name,Ku)).concat(e.data===null?"":"(".concat(Ir(e.data,Al),")"));case Ue.SelectorType.Pseudo:return":".concat(Ir(e.name,Ku)).concat(e.data===null?"":"(".concat(typeof e.data=="string"?Ir(e.data,Al):yl(e.data),")"));case Ue.SelectorType.Attribute:{if(e.name==="id"&&e.action===Ue.AttributeAction.Equals&&e.ignoreCase==="quirks"&&!e.namespace)return"#".concat(Ir(e.value,Ku));if(e.name==="class"&&e.action===Ue.AttributeAction.Element&&e.ignoreCase==="quirks"&&!e.namespace)return".".concat(Ir(e.value,Ku));var u=ml(e);return e.action===Ue.AttributeAction.Exists?"[".concat(u,"]"):"[".concat(u).concat(p6(e.action),\'="\').concat(Ir(e.value,d6),\'"\').concat(e.ignoreCase===null?"":e.ignoreCase?" i":" s","]")}}}function p6(e){switch(e){case Ue.AttributeAction.Equals:return"";case Ue.AttributeAction.Element:return"~";case Ue.AttributeAction.Start:return"^";case Ue.AttributeAction.End:return"$";case Ue.AttributeAction.Any:return"*";case Ue.AttributeAction.Not:return"!";case Ue.AttributeAction.Hyphen:return"|";case Ue.AttributeAction.Exists:throw new Error("Shouldn\'t be here")}}function ml(e){return"".concat(Dl(e.namespace)).concat(Ir(e.name,Ku))}function Dl(e){return e!==null?"".concat(e==="*"?"*":Ir(e,Ku),"|"):""}function Ir(e,t){for(var r=0,u="",a=0;a<e.length;a++)t.has(e.charCodeAt(a))&&(u+="".concat(e.slice(r,a),"\\\\").concat(e.charAt(a)),r=a+1);return u.length>0?u+e.slice(r):e}});var Zu=R(Rt=>{"use strict";var b6=Rt&&Rt.__createBinding||(Object.create?function(e,t,r,u){u===void 0&&(u=r);var a=Object.getOwnPropertyDescriptor(t,r);(!a||("get"in a?!t.__esModule:a.writable||a.configurable))&&(a={enumerable:!0,get:function(){return t[r]}}),Object.defineProperty(e,u,a)}:function(e,t,r,u){u===void 0&&(u=r),e[u]=t[r]}),_6=Rt&&Rt.__exportStar||function(e,t){for(var r in e)r!=="default"&&!Object.prototype.hasOwnProperty.call(t,r)&&b6(t,e,r)};Object.defineProperty(Rt,"__esModule",{value:!0});Rt.stringify=Rt.parse=Rt.isTraversal=void 0;_6($a(),Rt);var Il=xl();Object.defineProperty(Rt,"isTraversal",{enumerable:!0,get:function(){return Il.isTraversal}});Object.defineProperty(Rt,"parse",{enumerable:!0,get:function(){return Il.parse}});var E6=Cl();Object.defineProperty(Rt,"stringify",{enumerable:!0,get:function(){return E6.stringify}})});var Qr=R((ED,Sl)=>{Sl.exports={trueFunc:function(){return!0},falseFunc:function(){return!1}}});var Cs=R(j0=>{"use strict";Object.defineProperty(j0,"__esModule",{value:!0});j0.isTraversal=void 0;var Pt=Zu(),Nl=new Map([[Pt.SelectorType.Universal,50],[Pt.SelectorType.Tag,30],[Pt.SelectorType.Attribute,1],[Pt.SelectorType.Pseudo,0]]);function T6(e){return!Nl.has(e.type)}j0.isTraversal=T6;var x6=new Map([[Pt.AttributeAction.Exists,10],[Pt.AttributeAction.Equals,8],[Pt.AttributeAction.Not,7],[Pt.AttributeAction.Start,6],[Pt.AttributeAction.End,6],[Pt.AttributeAction.Any,5]]);function A6(e){for(var t=e.map(Ol),r=1;r<e.length;r++){var u=t[r];if(!(u<0))for(var a=r-1;a>=0&&u<t[a];a--){var n=e[a+1];e[a+1]=e[a],e[a]=n,t[a+1]=t[a],t[a]=u}}}j0.default=A6;function Ol(e){var t,r,u=(t=Nl.get(e.type))!==null&&t!==void 0?t:-1;return e.type===Pt.SelectorType.Attribute?(u=(r=x6.get(e.action))!==null&&r!==void 0?r:4,e.action===Pt.AttributeAction.Equals&&e.name==="id"&&(u=9),e.ignoreCase&&(u>>=1)):e.type===Pt.SelectorType.Pseudo&&(e.data?e.name==="has"||e.name==="contains"?u=0:Array.isArray(e.data)?(u=Math.min.apply(Math,e.data.map(function(a){return Math.min.apply(Math,a.map(Ol))})),u<0&&(u=0)):u=2:u=3),u}});var Pl=R(Ju=>{"use strict";var m6=Ju&&Ju.__importDefault||function(e){return e&&e.__esModule?e:{default:e}};Object.defineProperty(Ju,"__esModule",{value:!0});Ju.attributeRules=void 0;var Ja=m6(Qr()),g6=/[-[\\]{}()*+?.,\\\\^$|#\\s]/g;function Rl(e){return e.replace(g6,"\\\\$&")}var v6=new Set(["accept","accept-charset","align","alink","axis","bgcolor","charset","checked","clear","codetype","color","compact","declare","defer","dir","direction","disabled","enctype","face","frame","hreflang","http-equiv","lang","language","link","media","method","multiple","nohref","noresize","noshade","nowrap","readonly","rel","rev","rules","scope","scrolling","selected","shape","target","text","type","valign","valuetype","vlink"]);function Du(e,t){return typeof e.ignoreCase=="boolean"?e.ignoreCase:e.ignoreCase==="quirks"?!!t.quirksMode:!t.xmlMode&&v6.has(e.name)}Ju.attributeRules={equals:function(e,t,r){var u=r.adapter,a=t.name,n=t.value;return Du(t,r)?(n=n.toLowerCase(),function(s){var i=u.getAttributeValue(s,a);return i!=null&&i.length===n.length&&i.toLowerCase()===n&&e(s)}):function(s){return u.getAttributeValue(s,a)===n&&e(s)}},hyphen:function(e,t,r){var u=r.adapter,a=t.name,n=t.value,s=n.length;return Du(t,r)?(n=n.toLowerCase(),function(c){var o=u.getAttributeValue(c,a);return o!=null&&(o.length===s||o.charAt(s)==="-")&&o.substr(0,s).toLowerCase()===n&&e(c)}):function(c){var o=u.getAttributeValue(c,a);return o!=null&&(o.length===s||o.charAt(s)==="-")&&o.substr(0,s)===n&&e(c)}},element:function(e,t,r){var u=r.adapter,a=t.name,n=t.value;if(/\\s/.test(n))return Ja.default.falseFunc;var s=new RegExp("(?:^|\\\\s)".concat(Rl(n),"(?:$|\\\\s)"),Du(t,r)?"i":"");return function(c){var o=u.getAttributeValue(c,a);return o!=null&&o.length>=n.length&&s.test(o)&&e(c)}},exists:function(e,t,r){var u=t.name,a=r.adapter;return function(n){return a.hasAttrib(n,u)&&e(n)}},start:function(e,t,r){var u=r.adapter,a=t.name,n=t.value,s=n.length;return s===0?Ja.default.falseFunc:Du(t,r)?(n=n.toLowerCase(),function(i){var c=u.getAttributeValue(i,a);return c!=null&&c.length>=s&&c.substr(0,s).toLowerCase()===n&&e(i)}):function(i){var c;return!!(!((c=u.getAttributeValue(i,a))===null||c===void 0)&&c.startsWith(n))&&e(i)}},end:function(e,t,r){var u=r.adapter,a=t.name,n=t.value,s=-n.length;return s===0?Ja.default.falseFunc:Du(t,r)?(n=n.toLowerCase(),function(i){var c;return((c=u.getAttributeValue(i,a))===null||c===void 0?void 0:c.substr(s).toLowerCase())===n&&e(i)}):function(i){var c;return!!(!((c=u.getAttributeValue(i,a))===null||c===void 0)&&c.endsWith(n))&&e(i)}},any:function(e,t,r){var u=r.adapter,a=t.name,n=t.value;if(n==="")return Ja.default.falseFunc;if(Du(t,r)){var s=new RegExp(Rl(n),"i");return function(c){var o=u.getAttributeValue(c,a);return o!=null&&o.length>=n.length&&s.test(o)&&e(c)}}return function(i){var c;return!!(!((c=u.getAttributeValue(i,a))===null||c===void 0)&&c.includes(n))&&e(i)}},not:function(e,t,r){var u=r.adapter,a=t.name,n=t.value;return n===""?function(s){return!!u.getAttributeValue(s,a)&&e(s)}:Du(t,r)?(n=n.toLowerCase(),function(s){var i=u.getAttributeValue(s,a);return(i==null||i.length!==n.length||i.toLowerCase()!==n)&&e(s)}):function(s){return u.getAttributeValue(s,a)!==n&&e(s)}}}});var wl=R(en=>{"use strict";Object.defineProperty(en,"__esModule",{value:!0});en.parse=void 0;var y6=new Set([9,10,12,13,32]),Bl=48,D6=57;function C6(e){if(e=e.trim().toLowerCase(),e==="even")return[2,0];if(e==="odd")return[2,1];var t=0,r=0,u=n(),a=s();if(t<e.length&&e.charAt(t)==="n"&&(t++,r=u*(a!=null?a:1),i(),t<e.length?(u=n(),i(),a=s()):u=a=0),a===null||t<e.length)throw new Error("n-th rule couldn\'t be parsed (\'".concat(e,"\')"));return[r,u*a];function n(){return e.charAt(t)==="-"?(t++,-1):(e.charAt(t)==="+"&&t++,1)}function s(){for(var c=t,o=0;t<e.length&&e.charCodeAt(t)>=Bl&&e.charCodeAt(t)<=D6;)o=o*10+(e.charCodeAt(t)-Bl),t++;return t===c?null:o}function i(){for(;t<e.length&&y6.has(e.charCodeAt(t));)t++}}en.parse=C6});var Ml=R(Xr=>{"use strict";var I6=Xr&&Xr.__importDefault||function(e){return e&&e.__esModule?e:{default:e}};Object.defineProperty(Xr,"__esModule",{value:!0});Xr.generate=Xr.compile=void 0;var Ll=I6(Qr());function S6(e){var t=e[0],r=e[1]-1;if(r<0&&t<=0)return Ll.default.falseFunc;if(t===-1)return function(n){return n<=r};if(t===0)return function(n){return n===r};if(t===1)return r<0?Ll.default.trueFunc:function(n){return n>=r};var u=Math.abs(t),a=(r%u+u)%u;return t>1?function(n){return n>=r&&n%u===a}:function(n){return n<=r&&n%u===a}}Xr.compile=S6;function N6(e){var t=e[0],r=e[1]-1,u=0;if(t<0){var a=-t,n=(r%a+a)%a;return function(){var s=n+a*u++;return s>r?null:s}}return t===0?r<0?function(){return null}:function(){return u++===0?r:null}:(r<0&&(r+=t*Math.ceil(-r/t)),function(){return t*u+++r})}Xr.generate=N6});var Fl=R(zt=>{"use strict";Object.defineProperty(zt,"__esModule",{value:!0});zt.sequence=zt.generate=zt.compile=zt.parse=void 0;var Is=wl();Object.defineProperty(zt,"parse",{enumerable:!0,get:function(){return Is.parse}});var tn=Ml();Object.defineProperty(zt,"compile",{enumerable:!0,get:function(){return tn.compile}});Object.defineProperty(zt,"generate",{enumerable:!0,get:function(){return tn.generate}});function O6(e){return(0,tn.compile)((0,Is.parse)(e))}zt.default=O6;function R6(e){return(0,tn.generate)((0,Is.parse)(e))}zt.sequence=R6});var Hl=R(Cu=>{"use strict";var kl=Cu&&Cu.__importDefault||function(e){return e&&e.__esModule?e:{default:e}};Object.defineProperty(Cu,"__esModule",{value:!0});Cu.filters=void 0;var rn=kl(Fl()),Bt=kl(Qr());function un(e,t){return function(r){var u=t.getParent(r);return u!=null&&t.isTag(u)&&e(r)}}Cu.filters={contains:function(e,t,r){var u=r.adapter;return function(n){return e(n)&&u.getText(n).includes(t)}},icontains:function(e,t,r){var u=r.adapter,a=t.toLowerCase();return function(s){return e(s)&&u.getText(s).toLowerCase().includes(a)}},"nth-child":function(e,t,r){var u=r.adapter,a=r.equals,n=(0,rn.default)(t);return n===Bt.default.falseFunc?Bt.default.falseFunc:n===Bt.default.trueFunc?un(e,u):function(i){for(var c=u.getSiblings(i),o=0,f=0;f<c.length&&!a(i,c[f]);f++)u.isTag(c[f])&&o++;return n(o)&&e(i)}},"nth-last-child":function(e,t,r){var u=r.adapter,a=r.equals,n=(0,rn.default)(t);return n===Bt.default.falseFunc?Bt.default.falseFunc:n===Bt.default.trueFunc?un(e,u):function(i){for(var c=u.getSiblings(i),o=0,f=c.length-1;f>=0&&!a(i,c[f]);f--)u.isTag(c[f])&&o++;return n(o)&&e(i)}},"nth-of-type":function(e,t,r){var u=r.adapter,a=r.equals,n=(0,rn.default)(t);return n===Bt.default.falseFunc?Bt.default.falseFunc:n===Bt.default.trueFunc?un(e,u):function(i){for(var c=u.getSiblings(i),o=0,f=0;f<c.length;f++){var p=c[f];if(a(i,p))break;u.isTag(p)&&u.getName(p)===u.getName(i)&&o++}return n(o)&&e(i)}},"nth-last-of-type":function(e,t,r){var u=r.adapter,a=r.equals,n=(0,rn.default)(t);return n===Bt.default.falseFunc?Bt.default.falseFunc:n===Bt.default.trueFunc?un(e,u):function(i){for(var c=u.getSiblings(i),o=0,f=c.length-1;f>=0;f--){var p=c[f];if(a(i,p))break;u.isTag(p)&&u.getName(p)===u.getName(i)&&o++}return n(o)&&e(i)}},root:function(e,t,r){var u=r.adapter;return function(a){var n=u.getParent(a);return(n==null||!u.isTag(n))&&e(a)}},scope:function(e,t,r,u){var a=r.equals;return!u||u.length===0?Cu.filters.root(e,t,r):u.length===1?function(n){return a(u[0],n)&&e(n)}:function(n){return u.includes(n)&&e(n)}},hover:Ss("isHovered"),visited:Ss("isVisited"),active:Ss("isActive")};function Ss(e){return function(r,u,a){var n=a.adapter,s=n[e];return typeof s!="function"?Bt.default.falseFunc:function(c){return s(c)&&r(c)}}}});var Ul=R(e0=>{"use strict";Object.defineProperty(e0,"__esModule",{value:!0});e0.verifyPseudoArgs=e0.pseudos=void 0;e0.pseudos={empty:function(e,t){var r=t.adapter;return!r.getChildren(e).some(function(u){return r.isTag(u)||r.getText(u)!==""})},"first-child":function(e,t){var r=t.adapter,u=t.equals;if(r.prevElementSibling)return r.prevElementSibling(e)==null;var a=r.getSiblings(e).find(function(n){return r.isTag(n)});return a!=null&&u(e,a)},"last-child":function(e,t){for(var r=t.adapter,u=t.equals,a=r.getSiblings(e),n=a.length-1;n>=0;n--){if(u(e,a[n]))return!0;if(r.isTag(a[n]))break}return!1},"first-of-type":function(e,t){for(var r=t.adapter,u=t.equals,a=r.getSiblings(e),n=r.getName(e),s=0;s<a.length;s++){var i=a[s];if(u(e,i))return!0;if(r.isTag(i)&&r.getName(i)===n)break}return!1},"last-of-type":function(e,t){for(var r=t.adapter,u=t.equals,a=r.getSiblings(e),n=r.getName(e),s=a.length-1;s>=0;s--){var i=a[s];if(u(e,i))return!0;if(r.isTag(i)&&r.getName(i)===n)break}return!1},"only-of-type":function(e,t){var r=t.adapter,u=t.equals,a=r.getName(e);return r.getSiblings(e).every(function(n){return u(e,n)||!r.isTag(n)||r.getName(n)!==a})},"only-child":function(e,t){var r=t.adapter,u=t.equals;return r.getSiblings(e).every(function(a){return u(e,a)||!r.isTag(a)})}};function P6(e,t,r,u){if(r===null){if(e.length>u)throw new Error("Pseudo-class :".concat(t," requires an argument"))}else if(e.length===u)throw new Error("Pseudo-class :".concat(t," doesn\'t have any arguments"))}e0.verifyPseudoArgs=P6});var Gl=R(an=>{"use strict";Object.defineProperty(an,"__esModule",{value:!0});an.aliases=void 0;an.aliases={"any-link":":is(a, area, link)[href]",link:":any-link:not(:visited)",disabled:`:is(\n        :is(button, input, select, textarea, optgroup, option)[disabled],\n        optgroup[disabled] > option,\n        fieldset[disabled]:not(fieldset[disabled] legend:first-of-type *)\n    )`,enabled:":not(:disabled)",checked:":is(:is(input[type=radio], input[type=checkbox])[checked], option:selected)",required:":is(input, select, textarea)[required]",optional:":is(input, select, textarea):not([required])",selected:"option:is([selected], select:not([multiple]):not(:has(> option[selected])) > :first-of-type)",checkbox:"[type=checkbox]",file:"[type=file]",password:"[type=password]",radio:"[type=radio]",reset:"[type=reset]",image:"[type=image]",submit:"[type=submit]",parent:":not(:empty)",header:":is(h1, h2, h3, h4, h5, h6)",button:":is(button, input[type=button])",input:":is(input, textarea, select, button)",text:"input:is(:not([type!=\'\']), [type=text])"}});var nn=R(_t=>{"use strict";var ql=_t&&_t.__spreadArray||function(e,t,r){if(r||arguments.length===2)for(var u=0,a=t.length,n;u<a;u++)(n||!(u in t))&&(n||(n=Array.prototype.slice.call(t,0,u)),n[u]=t[u]);return e.concat(n||Array.prototype.slice.call(t))},B6=_t&&_t.__importDefault||function(e){return e&&e.__esModule?e:{default:e}};Object.defineProperty(_t,"__esModule",{value:!0});_t.subselects=_t.getNextSiblings=_t.ensureIsTag=_t.PLACEHOLDER_ELEMENT=void 0;var Yt=B6(Qr()),w6=Cs();_t.PLACEHOLDER_ELEMENT={};function jl(e,t){return e===Yt.default.falseFunc?Yt.default.falseFunc:function(r){return t.isTag(r)&&e(r)}}_t.ensureIsTag=jl;function zl(e,t){var r=t.getSiblings(e);if(r.length<=1)return[];var u=r.indexOf(e);return u<0||u===r.length-1?[]:r.slice(u+1).filter(t.isTag)}_t.getNextSiblings=zl;function Os(e){return{xmlMode:!!e.xmlMode,lowerCaseAttributeNames:!!e.lowerCaseAttributeNames,lowerCaseTags:!!e.lowerCaseTags,quirksMode:!!e.quirksMode,cacheResults:!!e.cacheResults,pseudos:e.pseudos,adapter:e.adapter,equals:e.equals}}var Ns=function(e,t,r,u,a){var n=a(t,Os(r),u);return n===Yt.default.trueFunc?e:n===Yt.default.falseFunc?Yt.default.falseFunc:function(s){return n(s)&&e(s)}};_t.subselects={is:Ns,matches:Ns,where:Ns,not:function(e,t,r,u,a){var n=a(t,Os(r),u);return n===Yt.default.falseFunc?e:n===Yt.default.trueFunc?Yt.default.falseFunc:function(s){return!n(s)&&e(s)}},has:function(e,t,r,u,a){var n=r.adapter,s=Os(r);s.relativeSelector=!0;var i=t.some(function(d){return d.some(w6.isTraversal)})?[_t.PLACEHOLDER_ELEMENT]:void 0,c=a(t,s,i);if(c===Yt.default.falseFunc)return Yt.default.falseFunc;var o=jl(c,n);if(i&&c!==Yt.default.trueFunc){var f=c.shouldTestNextSiblings,p=f===void 0?!1:f;return function(d){if(!e(d))return!1;i[0]=d;var b=n.getChildren(d),_=p?ql(ql([],b,!0),zl(d,n),!0):b;return n.existsOne(o,_)}}return function(d){return e(d)&&n.existsOne(o,n.getChildren(d))}}}});var Bs=R(or=>{"use strict";Object.defineProperty(or,"__esModule",{value:!0});or.compilePseudoSelector=or.aliases=or.pseudos=or.filters=void 0;var L6=Zu(),Ps=Hl();Object.defineProperty(or,"filters",{enumerable:!0,get:function(){return Ps.filters}});var z0=Ul();Object.defineProperty(or,"pseudos",{enumerable:!0,get:function(){return z0.pseudos}});var Yl=Gl();Object.defineProperty(or,"aliases",{enumerable:!0,get:function(){return Yl.aliases}});var Rs=nn();function M6(e,t,r,u,a){var n,s=t.name,i=t.data;if(Array.isArray(i)){if(!(s in Rs.subselects))throw new Error("Unknown pseudo-class :".concat(s,"(").concat(i,")"));return Rs.subselects[s](e,i,r,u,a)}var c=(n=r.pseudos)===null||n===void 0?void 0:n[s],o=typeof c=="string"?c:Yl.aliases[s];if(typeof o=="string"){if(i!=null)throw new Error("Pseudo ".concat(s," doesn\'t have any arguments"));var f=(0,L6.parse)(o);return Rs.subselects.is(e,f,r,u,a)}if(typeof c=="function")return(0,z0.verifyPseudoArgs)(c,s,i,1),function(d){return c(d,i)&&e(d)};if(s in Ps.filters)return Ps.filters[s](e,i,r,u);if(s in z0.pseudos){var p=z0.pseudos[s];return(0,z0.verifyPseudoArgs)(p,s,i,2),function(d){return p(d,r,i)&&e(d)}}throw new Error("Unknown pseudo-class :".concat(s))}or.compilePseudoSelector=M6});var Wl=R(sn=>{"use strict";Object.defineProperty(sn,"__esModule",{value:!0});sn.compileGeneralSelector=void 0;var F6=Pl(),k6=Bs(),Wt=Zu();function ws(e,t){var r=t.getParent(e);return r&&t.isTag(r)?r:null}function H6(e,t,r,u,a){var n=r.adapter,s=r.equals;switch(t.type){case Wt.SelectorType.PseudoElement:throw new Error("Pseudo-elements are not supported by css-select");case Wt.SelectorType.ColumnCombinator:throw new Error("Column combinators are not yet supported by css-select");case Wt.SelectorType.Attribute:{if(t.namespace!=null)throw new Error("Namespaced attributes are not yet supported by css-select");return(!r.xmlMode||r.lowerCaseAttributeNames)&&(t.name=t.name.toLowerCase()),F6.attributeRules[t.action](e,t,r)}case Wt.SelectorType.Pseudo:return(0,k6.compilePseudoSelector)(e,t,r,u,a);case Wt.SelectorType.Tag:{if(t.namespace!=null)throw new Error("Namespaced tag names are not yet supported by css-select");var i=t.name;return(!r.xmlMode||r.lowerCaseTags)&&(i=i.toLowerCase()),function(f){return n.getName(f)===i&&e(f)}}case Wt.SelectorType.Descendant:{if(r.cacheResults===!1||typeof WeakSet=="undefined")return function(f){for(var p=f;p=ws(p,n);)if(e(p))return!0;return!1};var c=new WeakSet;return function(f){for(var p=f;p=ws(p,n);)if(!c.has(p)){if(n.isTag(p)&&e(p))return!0;c.add(p)}return!1}}case"_flexibleDescendant":return function(f){var p=f;do if(e(p))return!0;while(p=ws(p,n));return!1};case Wt.SelectorType.Parent:return function(f){return n.getChildren(f).some(function(p){return n.isTag(p)&&e(p)})};case Wt.SelectorType.Child:return function(f){var p=n.getParent(f);return p!=null&&n.isTag(p)&&e(p)};case Wt.SelectorType.Sibling:return function(f){for(var p=n.getSiblings(f),d=0;d<p.length;d++){var b=p[d];if(s(f,b))break;if(n.isTag(b)&&e(b))return!0}return!1};case Wt.SelectorType.Adjacent:return n.prevElementSibling?function(f){var p=n.prevElementSibling(f);return p!=null&&e(p)}:function(f){for(var p=n.getSiblings(f),d,b=0;b<p.length;b++){var _=p[b];if(s(f,_))break;n.isTag(_)&&(d=_)}return!!d&&e(d)};case Wt.SelectorType.Universal:{if(t.namespace!=null&&t.namespace!=="*")throw new Error("Namespaced universal selectors are not yet supported by css-select");return e}}}sn.compileGeneralSelector=H6});var Kl=R(ct=>{"use strict";var U6=ct&&ct.__createBinding||(Object.create?function(e,t,r,u){u===void 0&&(u=r);var a=Object.getOwnPropertyDescriptor(t,r);(!a||("get"in a?!t.__esModule:a.writable||a.configurable))&&(a={enumerable:!0,get:function(){return t[r]}}),Object.defineProperty(e,u,a)}:function(e,t,r,u){u===void 0&&(u=r),e[u]=t[r]}),G6=ct&&ct.__setModuleDefault||(Object.create?function(e,t){Object.defineProperty(e,"default",{enumerable:!0,value:t})}:function(e,t){e.default=t}),q6=ct&&ct.__importStar||function(e){if(e&&e.__esModule)return e;var t={};if(e!=null)for(var r in e)r!=="default"&&Object.prototype.hasOwnProperty.call(e,r)&&U6(t,e,r);return G6(t,e),t},j6=ct&&ct.__importDefault||function(e){return e&&e.__esModule?e:{default:e}};Object.defineProperty(ct,"__esModule",{value:!0});ct.compileToken=ct.compileUnsafe=ct.compile=void 0;var Sr=Zu(),Kr=j6(Qr()),Ls=q6(Cs()),z6=Wl(),Vl=nn();function Y6(e,t,r){var u=Ql(e,t,r);return(0,Vl.ensureIsTag)(u,t.adapter)}ct.compile=Y6;function Ql(e,t,r){var u=typeof e=="string"?(0,Sr.parse)(e):e;return Ms(u,t,r)}ct.compileUnsafe=Ql;function Xl(e){return e.type===Sr.SelectorType.Pseudo&&(e.name==="scope"||Array.isArray(e.data)&&e.data.some(function(t){return t.some(Xl)}))}var W6={type:Sr.SelectorType.Descendant},V6={type:"_flexibleDescendant"},Q6={type:Sr.SelectorType.Pseudo,name:"scope",data:null};function X6(e,t,r){for(var u=t.adapter,a=!!(r!=null&&r.every(function(c){var o=u.isTag(c)&&u.getParent(c);return c===Vl.PLACEHOLDER_ELEMENT||o&&u.isTag(o)})),n=0,s=e;n<s.length;n++){var i=s[n];if(!(i.length>0&&(0,Ls.isTraversal)(i[0])&&i[0].type!==Sr.SelectorType.Descendant))if(a&&!i.some(Xl))i.unshift(W6);else continue;i.unshift(Q6)}}function Ms(e,t,r){var u;e.forEach(Ls.default),r=(u=t.context)!==null&&u!==void 0?u:r;var a=Array.isArray(r),n=r&&(Array.isArray(r)?r:[r]);if(t.relativeSelector!==!1)X6(e,t,n);else if(e.some(function(c){return c.length>0&&(0,Ls.isTraversal)(c[0])}))throw new Error("Relative selectors are not allowed when the `relativeSelector` option is disabled");var s=!1,i=e.map(function(c){if(c.length>=2){var o=c[0],f=c[1];o.type!==Sr.SelectorType.Pseudo||o.name!=="scope"||(a&&f.type===Sr.SelectorType.Descendant?c[1]=V6:(f.type===Sr.SelectorType.Adjacent||f.type===Sr.SelectorType.Sibling)&&(s=!0))}return K6(c,t,n)}).reduce($6,Kr.default.falseFunc);return i.shouldTestNextSiblings=s,i}ct.compileToken=Ms;function K6(e,t,r){var u;return e.reduce(function(a,n){return a===Kr.default.falseFunc?Kr.default.falseFunc:(0,z6.compileGeneralSelector)(a,n,t,r,Ms)},(u=t.rootFunc)!==null&&u!==void 0?u:Kr.default.trueFunc)}function $6(e,t){return t===Kr.default.falseFunc||e===Kr.default.trueFunc?e:e===Kr.default.falseFunc||t===Kr.default.trueFunc?t:function(u){return e(u)||t(u)}}});var Us=R(ve=>{"use strict";var Z6=ve&&ve.__createBinding||(Object.create?function(e,t,r,u){u===void 0&&(u=r);var a=Object.getOwnPropertyDescriptor(t,r);(!a||("get"in a?!t.__esModule:a.writable||a.configurable))&&(a={enumerable:!0,get:function(){return t[r]}}),Object.defineProperty(e,u,a)}:function(e,t,r,u){u===void 0&&(u=r),e[u]=t[r]}),J6=ve&&ve.__setModuleDefault||(Object.create?function(e,t){Object.defineProperty(e,"default",{enumerable:!0,value:t})}:function(e,t){e.default=t}),eT=ve&&ve.__importStar||function(e){if(e&&e.__esModule)return e;var t={};if(e!=null)for(var r in e)r!=="default"&&Object.prototype.hasOwnProperty.call(e,r)&&Z6(t,e,r);return J6(t,e),t},tT=ve&&ve.__importDefault||function(e){return e&&e.__esModule?e:{default:e}};Object.defineProperty(ve,"__esModule",{value:!0});ve.aliases=ve.pseudos=ve.filters=ve.is=ve.selectOne=ve.selectAll=ve.prepareContext=ve._compileToken=ve._compileUnsafe=ve.compile=void 0;var $l=eT(jt()),Zl=tT(Qr()),Y0=Kl(),rT=nn(),Jl=function(e,t){return e===t},uT={adapter:$l,equals:Jl};function Fs(e){var t,r,u,a,n=e!=null?e:uT;return(t=n.adapter)!==null&&t!==void 0||(n.adapter=$l),(r=n.equals)!==null&&r!==void 0||(n.equals=(a=(u=n.adapter)===null||u===void 0?void 0:u.equals)!==null&&a!==void 0?a:Jl),n}function ks(e){return function(r,u,a){var n=Fs(u);return e(r,n,a)}}ve.compile=ks(Y0.compile);ve._compileUnsafe=ks(Y0.compileUnsafe);ve._compileToken=ks(Y0.compileToken);function ed(e){return function(r,u,a){var n=Fs(a);typeof r!="function"&&(r=(0,Y0.compileUnsafe)(r,n,u));var s=td(u,n.adapter,r.shouldTestNextSiblings);return e(r,s,n)}}function td(e,t,r){return r===void 0&&(r=!1),r&&(e=aT(e,t)),Array.isArray(e)?t.removeSubsets(e):t.getChildren(e)}ve.prepareContext=td;function aT(e,t){for(var r=Array.isArray(e)?e.slice(0):[e],u=r.length,a=0;a<u;a++){var n=(0,rT.getNextSiblings)(r[a],t);r.push.apply(r,n)}return r}ve.selectAll=ed(function(e,t,r){return e===Zl.default.falseFunc||!t||t.length===0?[]:r.adapter.findAll(e,t)});ve.selectOne=ed(function(e,t,r){return e===Zl.default.falseFunc||!t||t.length===0?null:r.adapter.findOne(e,t)});function nT(e,t,r){var u=Fs(r);return(typeof t=="function"?t:(0,Y0.compile)(t,u))(e)}ve.is=nT;ve.default=ve.selectAll;var Hs=Bs();Object.defineProperty(ve,"filters",{enumerable:!0,get:function(){return Hs.filters}});Object.defineProperty(ve,"pseudos",{enumerable:!0,get:function(){return Hs.pseudos}});Object.defineProperty(ve,"aliases",{enumerable:!0,get:function(){return Hs.aliases}})});var Gs=R(Nr=>{"use strict";Object.defineProperty(Nr,"__esModule",{value:!0});Nr.getLimit=Nr.isFilter=Nr.filterNames=void 0;Nr.filterNames=new Set(["first","last","eq","gt","nth","lt","even","odd"]);function rd(e){return e.type!=="pseudo"?!1:Nr.filterNames.has(e.name)?!0:e.name==="not"&&Array.isArray(e.data)?e.data.some(function(t){return t.some(rd)}):!1}Nr.isFilter=rd;function iT(e,t,r){var u=t!=null?parseInt(t,10):NaN;switch(e){case"first":return 1;case"nth":case"eq":return isFinite(u)?u>=0?u+1:1/0:0;case"lt":return isFinite(u)?u>=0?Math.min(u,r):1/0:0;case"gt":return isFinite(u)?1/0:0;case"odd":return 2*r;case"even":return 2*r-1;case"last":case"not":return 1/0}}Nr.getLimit=iT});var ud=R(t0=>{"use strict";Object.defineProperty(t0,"__esModule",{value:!0});t0.groupSelectors=t0.getDocumentRoot=void 0;var sT=Gs();function oT(e){for(;e.parent;)e=e.parent;return e}t0.getDocumentRoot=oT;function cT(e){for(var t=[],r=[],u=0,a=e;u<a.length;u++){var n=a[u];n.some(sT.isFilter)?t.push(n):r.push(n)}return[r,t]}t0.groupSelectors=cT});var fd=R(Pe=>{"use strict";var $r=Pe&&Pe.__assign||function(){return $r=Object.assign||function(e){for(var t,r=1,u=arguments.length;r<u;r++){t=arguments[r];for(var a in t)Object.prototype.hasOwnProperty.call(t,a)&&(e[a]=t[a])}return e},$r.apply(this,arguments)},fT=Pe&&Pe.__createBinding||(Object.create?function(e,t,r,u){u===void 0&&(u=r);var a=Object.getOwnPropertyDescriptor(t,r);(!a||("get"in a?!t.__esModule:a.writable||a.configurable))&&(a={enumerable:!0,get:function(){return t[r]}}),Object.defineProperty(e,u,a)}:function(e,t,r,u){u===void 0&&(u=r),e[u]=t[r]}),lT=Pe&&Pe.__setModuleDefault||(Object.create?function(e,t){Object.defineProperty(e,"default",{enumerable:!0,value:t})}:function(e,t){e.default=t}),nd=Pe&&Pe.__importStar||function(e){if(e&&e.__esModule)return e;var t={};if(e!=null)for(var r in e)r!=="default"&&Object.prototype.hasOwnProperty.call(e,r)&&fT(t,e,r);return lT(t,e),t},ad=Pe&&Pe.__spreadArray||function(e,t,r){if(r||arguments.length===2)for(var u=0,a=t.length,n;u<a;u++)(n||!(u in t))&&(n||(n=Array.prototype.slice.call(t,0,u)),n[u]=t[u]);return e.concat(n||Array.prototype.slice.call(t))};Object.defineProperty(Pe,"__esModule",{value:!0});Pe.select=Pe.filter=Pe.some=Pe.is=Pe.aliases=Pe.pseudos=Pe.filters=void 0;var Vt=Zu(),W0=Us(),cr=nd(jt()),js=nd(Qr()),cn=ud(),qs=Gs(),Ws=Us();Object.defineProperty(Pe,"filters",{enumerable:!0,get:function(){return Ws.filters}});Object.defineProperty(Pe,"pseudos",{enumerable:!0,get:function(){return Ws.pseudos}});Object.defineProperty(Pe,"aliases",{enumerable:!0,get:function(){return Ws.aliases}});var dT={type:Vt.SelectorType.Universal,namespace:null},hT={type:Vt.SelectorType.Pseudo,name:"scope",data:null};function pT(e,t,r){return r===void 0&&(r={}),id([e],t,r)}Pe.is=pT;function id(e,t,r){if(r===void 0&&(r={}),typeof t=="function")return e.some(t);var u=(0,cn.groupSelectors)((0,Vt.parse)(t)),a=u[0],n=u[1];return a.length>0&&e.some((0,W0._compileToken)(a,r))||n.some(function(s){return od(s,e,r).length>0})}Pe.some=id;function bT(e,t,r,u){var a=typeof r=="string"?parseInt(r,10):NaN;switch(e){case"first":case"lt":return t;case"last":return t.length>0?[t[t.length-1]]:t;case"nth":case"eq":return isFinite(a)&&Math.abs(a)<t.length?[a<0?t[t.length+a]:t[a]]:[];case"gt":return isFinite(a)?t.slice(a+1):[];case"even":return t.filter(function(s,i){return i%2===0});case"odd":return t.filter(function(s,i){return i%2===1});case"not":{var n=new Set(sd(r,t,u));return t.filter(function(s){return!n.has(s)})}}}function _T(e,t,r){return r===void 0&&(r={}),sd((0,Vt.parse)(e),t,r)}Pe.filter=_T;function sd(e,t,r){if(t.length===0)return[];var u=(0,cn.groupSelectors)(e),a=u[0],n=u[1],s;if(a.length){var i=Ys(t,a,r);if(n.length===0)return i;i.length&&(s=new Set(i))}for(var c=0;c<n.length&&(s==null?void 0:s.size)!==t.length;c++){var o=n[c],f=s?t.filter(function(d){return cr.isTag(d)&&!s.has(d)}):t;if(f.length===0)break;var i=od(o,t,r);if(i.length)if(s)i.forEach(function(d){return s.add(d)});else{if(c===n.length-1)return i;s=new Set(i)}}return typeof s!="undefined"?s.size===t.length?t:t.filter(function(p){return s.has(p)}):[]}function od(e,t,r){var u;if(e.some(Vt.isTraversal)){var a=(u=r.root)!==null&&u!==void 0?u:(0,cn.getDocumentRoot)(t[0]),n=$r($r({},r),{context:t,relativeSelector:!1});return e.push(hT),on(a,e,n,!0,t.length)}return on(t,e,r,!1,t.length)}function ET(e,t,r,u){if(r===void 0&&(r={}),u===void 0&&(u=1/0),typeof e=="function")return cd(t,e);var a=(0,cn.groupSelectors)((0,Vt.parse)(e)),n=a[0],s=a[1],i=s.map(function(c){return on(t,c,r,!0,u)});return n.length&&i.push(zs(t,n,r,u)),i.length===0?[]:i.length===1?i[0]:cr.uniqueSort(i.reduce(function(c,o){return ad(ad([],c,!0),o,!0)}))}Pe.select=ET;function on(e,t,r,u,a){var n=t.findIndex(qs.isFilter),s=t.slice(0,n),i=t[n],c=t.length-1===n?a:1/0,o=(0,qs.getLimit)(i.name,i.data,c);if(o===0)return[];var f=s.length===0&&!Array.isArray(e)?cr.getChildren(e).filter(cr.isTag):s.length===0?(Array.isArray(e)?e:[e]).filter(cr.isTag):u||s.some(Vt.isTraversal)?zs(e,[s],r,o):Ys(e,[s],r),p=f.slice(0,o),d=bT(i.name,p,i.data,r);if(d.length===0||t.length===n+1)return d;var b=t.slice(n+1),_=b.some(Vt.isTraversal);if(_){if((0,Vt.isTraversal)(b[0])){var C=b[0].type;(C===Vt.SelectorType.Sibling||C===Vt.SelectorType.Adjacent)&&(d=(0,W0.prepareContext)(d,cr,!0)),b.unshift(dT)}r=$r($r({},r),{relativeSelector:!1,rootFunc:function(D){return d.includes(D)}})}else r.rootFunc&&r.rootFunc!==js.trueFunc&&(r=$r($r({},r),{rootFunc:js.trueFunc}));return b.some(qs.isFilter)?on(d,b,r,!1,a):_?zs(d,[b],r,a):Ys(d,[b],r)}function zs(e,t,r,u){var a=(0,W0._compileToken)(t,r,e);return cd(e,a,u)}function cd(e,t,r){r===void 0&&(r=1/0);var u=(0,W0.prepareContext)(e,cr,t.shouldTestNextSiblings);return cr.find(function(a){return cr.isTag(a)&&t(a)},u,!0,r)}function Ys(e,t,r){var u=(Array.isArray(e)?e:[e]).filter(cr.isTag);if(u.length===0)return u;var a=(0,W0._compileToken)(t,r);return a===js.trueFunc?u:u.filter(a)}});var ld=R(ie=>{"use strict";var TT=ie&&ie.__createBinding||(Object.create?function(e,t,r,u){u===void 0&&(u=r);var a=Object.getOwnPropertyDescriptor(t,r);(!a||("get"in a?!t.__esModule:a.writable||a.configurable))&&(a={enumerable:!0,get:function(){return t[r]}}),Object.defineProperty(e,u,a)}:function(e,t,r,u){u===void 0&&(u=r),e[u]=t[r]}),xT=ie&&ie.__setModuleDefault||(Object.create?function(e,t){Object.defineProperty(e,"default",{enumerable:!0,value:t})}:function(e,t){e.default=t}),AT=ie&&ie.__importStar||function(e){if(e&&e.__esModule)return e;var t={};if(e!=null)for(var r in e)r!=="default"&&Object.prototype.hasOwnProperty.call(e,r)&&TT(t,e,r);return xT(t,e),t},Vs=ie&&ie.__spreadArray||function(e,t,r){if(r||arguments.length===2)for(var u=0,a=t.length,n;u<a;u++)(n||!(u in t))&&(n||(n=Array.prototype.slice.call(t,0,u)),n[u]=t[u]);return e.concat(n||Array.prototype.slice.call(t))};Object.defineProperty(ie,"__esModule",{value:!0});ie.addBack=ie.add=ie.end=ie.slice=ie.index=ie.toArray=ie.get=ie.eq=ie.last=ie.first=ie.has=ie.not=ie.is=ie.filterArray=ie.filter=ie.map=ie.each=ie.contents=ie.children=ie.siblings=ie.prevUntil=ie.prevAll=ie.prev=ie.nextUntil=ie.nextAll=ie.next=ie.closest=ie.parentsUntil=ie.parents=ie.parent=ie.find=void 0;var fn=st(),r0=AT(fd()),Qt=yu(),mT=gu(),fr=jt(),gT=/^\\s*[~+]/;function vT(e){var t;if(!e)return this._make([]);var r=this.toArray();if(typeof e!="string"){var u=(0,Qt.isCheerio)(e)?e.toArray():[e];return this._make(u.filter(function(s){return r.some(function(i){return(0,mT.contains)(i,s)})}))}var a=gT.test(e)?r:this.children().toArray(),n={context:r,root:(t=this._root)===null||t===void 0?void 0:t[0],xmlMode:this.options.xmlMode,lowerCaseTags:this.options.lowerCaseTags,lowerCaseAttributeNames:this.options.lowerCaseAttributeNames,pseudos:this.options.pseudos,quirksMode:this.options.quirksMode};return this._make(r0.select(e,a,n))}ie.find=vT;function Qs(e){return function(t){for(var r=[],u=1;u<arguments.length;u++)r[u-1]=arguments[u];return function(a){var n,s=e(t,this);return a&&(s=$s(s,a,this.options.xmlMode,(n=this._root)===null||n===void 0?void 0:n[0])),this._make(this.length>1&&s.length>1?r.reduce(function(i,c){return c(i)},s):s)}}}var V0=Qs(function(e,t){for(var r,u=[],a=0;a<t.length;a++){var n=e(t[a]);u.push(n)}return(r=new Array).concat.apply(r,u)}),Xs=Qs(function(e,t){for(var r=[],u=0;u<t.length;u++){var a=e(t[u]);a!==null&&r.push(a)}return r});function Ks(e){for(var t=[],r=1;r<arguments.length;r++)t[r-1]=arguments[r];var u=null,a=Qs(function(n,s){var i=[];return(0,Qt.domEach)(s,function(c){for(var o;(o=n(c))&&!(u!=null&&u(o,i.length));c=o)i.push(o)}),i}).apply(void 0,Vs([e],t,!1));return function(n,s){var i=this;u=typeof n=="string"?function(o){return r0.is(o,n,i.options)}:n?Q0(n):null;var c=a.call(this,s);return u=null,c}}function u0(e){return Array.from(new Set(e))}ie.parent=Xs(function(e){var t=e.parent;return t&&!(0,fn.isDocument)(t)?t:null},u0);ie.parents=V0(function(e){for(var t=[];e.parent&&!(0,fn.isDocument)(e.parent);)t.push(e.parent),e=e.parent;return t},fr.uniqueSort,function(e){return e.reverse()});ie.parentsUntil=Ks(function(e){var t=e.parent;return t&&!(0,fn.isDocument)(t)?t:null},fr.uniqueSort,function(e){return e.reverse()});function yT(e){var t,r=[];if(!e)return this._make(r);var u={xmlMode:this.options.xmlMode,root:(t=this._root)===null||t===void 0?void 0:t[0]},a=typeof e=="string"?function(n){return r0.is(n,e,u)}:Q0(e);return(0,Qt.domEach)(this,function(n){for(;n&&(0,Qt.isTag)(n);){if(a(n,0)){r.includes(n)||r.push(n);break}n=n.parent}}),this._make(r)}ie.closest=yT;ie.next=Xs(function(e){return(0,fr.nextElementSibling)(e)});ie.nextAll=V0(function(e){for(var t=[];e.next;)e=e.next,(0,Qt.isTag)(e)&&t.push(e);return t},u0);ie.nextUntil=Ks(function(e){return(0,fr.nextElementSibling)(e)},u0);ie.prev=Xs(function(e){return(0,fr.prevElementSibling)(e)});ie.prevAll=V0(function(e){for(var t=[];e.prev;)e=e.prev,(0,Qt.isTag)(e)&&t.push(e);return t},u0);ie.prevUntil=Ks(function(e){return(0,fr.prevElementSibling)(e)},u0);ie.siblings=V0(function(e){return(0,fr.getSiblings)(e).filter(function(t){return(0,Qt.isTag)(t)&&t!==e})},fr.uniqueSort);ie.children=V0(function(e){return(0,fr.getChildren)(e).filter(Qt.isTag)},u0);function DT(){var e=this.toArray().reduce(function(t,r){return(0,fn.hasChildren)(r)?t.concat(r.children):t},[]);return this._make(e)}ie.contents=DT;function CT(e){for(var t=0,r=this.length;t<r&&e.call(this[t],t,this[t])!==!1;)++t;return this}ie.each=CT;function IT(e){for(var t=[],r=0;r<this.length;r++){var u=this[r],a=e.call(u,r,u);a!=null&&(t=t.concat(a))}return this._make(t)}ie.map=IT;function Q0(e){return typeof e=="function"?function(t,r){return e.call(t,r,t)}:(0,Qt.isCheerio)(e)?function(t){return Array.prototype.includes.call(e,t)}:function(t){return e===t}}function ST(e){var t;return this._make($s(this.toArray(),e,this.options.xmlMode,(t=this._root)===null||t===void 0?void 0:t[0]))}ie.filter=ST;function $s(e,t,r,u){return typeof t=="string"?r0.filter(t,e,{xmlMode:r,root:u}):e.filter(Q0(t))}ie.filterArray=$s;function NT(e){var t=this.toArray();return typeof e=="string"?r0.some(t.filter(Qt.isTag),e,this.options):e?t.some(Q0(e)):!1}ie.is=NT;function OT(e){var t=this.toArray();if(typeof e=="string"){var r=new Set(r0.filter(e,t,this.options));t=t.filter(function(a){return!r.has(a)})}else{var u=Q0(e);t=t.filter(function(a,n){return!u(a,n)})}return this._make(t)}ie.not=OT;function RT(e){var t=this;return this.filter(typeof e=="string"?":has(".concat(e,")"):function(r,u){return t._make(u).find(e).length>0})}ie.has=RT;function PT(){return this.length>1?this._make(this[0]):this}ie.first=PT;function BT(){return this.length>0?this._make(this[this.length-1]):this}ie.last=BT;function wT(e){var t;return e=+e,e===0&&this.length<=1?this:(e<0&&(e=this.length+e),this._make((t=this[e])!==null&&t!==void 0?t:[]))}ie.eq=wT;function LT(e){return e==null?this.toArray():this[e<0?this.length+e:e]}ie.get=LT;function MT(){return Array.prototype.slice.call(this)}ie.toArray=MT;function FT(e){var t,r;return e==null?(t=this.parent().children(),r=this[0]):typeof e=="string"?(t=this._make(e),r=this[0]):(t=this,r=(0,Qt.isCheerio)(e)?e[0]:e),Array.prototype.indexOf.call(t,r)}ie.index=FT;function kT(e,t){return this._make(Array.prototype.slice.call(this,e,t))}ie.slice=kT;function HT(){var e;return(e=this.prevObject)!==null&&e!==void 0?e:this._make([])}ie.end=HT;function UT(e,t){var r=this._make(e,t),u=(0,fr.uniqueSort)(Vs(Vs([],this.get(),!0),r.get(),!0));return this._make(u)}ie.add=UT;function GT(e){return this.prevObject?this.add(e?this.prevObject.filter(e):this.prevObject):this}ie.addBack=GT});var Zs=R(a0=>{"use strict";Object.defineProperty(a0,"__esModule",{value:!0});a0.update=a0.getParse=void 0;var qT=jt(),dd=st();function jT(e){return function(r,u,a,n){if(typeof Buffer!="undefined"&&Buffer.isBuffer(r)&&(r=r.toString()),typeof r=="string")return e(r,u,a,n);var s=r;if(!Array.isArray(s)&&(0,dd.isDocument)(s))return s;var i=new dd.Document([]);return hd(s,i),i}}a0.getParse=jT;function hd(e,t){var r=Array.isArray(e)?e:[e];t?t.children=r:t=null;for(var u=0;u<r.length;u++){var a=r[u];a.parent&&a.parent.children!==r&&(0,qT.removeElement)(a),t?(a.prev=r[u-1]||null,a.next=r[u+1]||null):a.prev=a.next=null,a.parent=t}return t}a0.update=hd});var Ed=R(pe=>{"use strict";var zT=pe&&pe.__spreadArray||function(e,t,r){if(r||arguments.length===2)for(var u=0,a=t.length,n;u<a;u++)(n||!(u in t))&&(n||(n=Array.prototype.slice.call(t,0,u)),n[u]=t[u]);return e.concat(n||Array.prototype.slice.call(t))};Object.defineProperty(pe,"__esModule",{value:!0});pe.clone=pe.text=pe.toString=pe.html=pe.empty=pe.replaceWith=pe.remove=pe.insertBefore=pe.before=pe.insertAfter=pe.after=pe.wrapAll=pe.unwrap=pe.wrapInner=pe.wrap=pe.prepend=pe.append=pe.prependTo=pe.appendTo=pe._makeDomArray=void 0;var lr=st(),n0=Zs(),pd=gu(),Ye=yu(),YT=jt();function WT(e,t){var r=this;return e==null?[]:(0,Ye.isCheerio)(e)?t?(0,Ye.cloneDom)(e.get()):e.get():Array.isArray(e)?e.reduce(function(u,a){return u.concat(r._makeDomArray(a,t))},[]):typeof e=="string"?this._parse(e,this.options,!1,null).children:t?(0,Ye.cloneDom)([e]):[e]}pe._makeDomArray=WT;function bd(e){return function(){for(var t=this,r=[],u=0;u<arguments.length;u++)r[u]=arguments[u];var a=this.length-1;return(0,Ye.domEach)(this,function(n,s){if((0,lr.hasChildren)(n)){var i=typeof r[0]=="function"?r[0].call(n,s,t._render(n.children)):r,c=t._makeDomArray(i,s<a);e(c,n.children,n)}})}}function Zr(e,t,r,u,a){for(var n,s,i=zT([t,r],u,!0),c=t===0?null:e[t-1],o=t+r>=e.length?null:e[t+r],f=0;f<u.length;++f){var p=u[f],d=p.parent;if(d){var b=d.children,_=b.indexOf(p);_>-1&&(d.children.splice(_,1),a===d&&t>_&&i[0]--)}p.parent=a,p.prev&&(p.prev.next=(n=p.next)!==null&&n!==void 0?n:null),p.next&&(p.next.prev=(s=p.prev)!==null&&s!==void 0?s:null),p.prev=f===0?c:u[f-1],p.next=f===u.length-1?o:u[f+1]}return c&&(c.next=u[0]),o&&(o.prev=u[u.length-1]),e.splice.apply(e,i)}function VT(e){var t=(0,Ye.isCheerio)(e)?e:this._make(e);return t.append(this),this}pe.appendTo=VT;function QT(e){var t=(0,Ye.isCheerio)(e)?e:this._make(e);return t.prepend(this),this}pe.prependTo=QT;pe.append=bd(function(e,t,r){Zr(t,t.length,0,e,r)});pe.prepend=bd(function(e,t,r){Zr(t,0,0,e,r)});function _d(e){return function(t){for(var r=this.length-1,u=this.parents().last(),a=0;a<this.length;a++){var n=this[a],s=typeof t=="function"?t.call(n,a,n):typeof t=="string"&&!(0,Ye.isHtml)(t)?u.find(t).clone():t,i=this._makeDomArray(s,a<r)[0];if(!(!i||!(0,lr.hasChildren)(i))){for(var c=i,o=0;o<c.children.length;){var f=c.children[o];(0,Ye.isTag)(f)?(c=f,o=0):o++}e(n,c,[i])}}return this}}pe.wrap=_d(function(e,t,r){var u=e.parent;if(u){var a=u.children,n=a.indexOf(e);(0,n0.update)([e],t),Zr(a,n,0,r,u)}});pe.wrapInner=_d(function(e,t,r){(0,lr.hasChildren)(e)&&((0,n0.update)(e.children,t),(0,n0.update)(r,e))});function XT(e){var t=this;return this.parent(e).not("body").each(function(r,u){t._make(u).replaceWith(u.children)}),this}pe.unwrap=XT;function KT(e){var t=this[0];if(t){for(var r=this._make(typeof e=="function"?e.call(t,0,t):e).insertBefore(t),u=void 0,a=0;a<r.length;a++)r[a].type==="tag"&&(u=r[a]);for(var n=0;u&&n<u.children.length;){var s=u.children[n];s.type==="tag"?(u=s,n=0):n++}u&&this._make(u).append(this)}return this}pe.wrapAll=KT;function $T(){for(var e=this,t=[],r=0;r<arguments.length;r++)t[r]=arguments[r];var u=this.length-1;return(0,Ye.domEach)(this,function(a,n){var s=a.parent;if(!(!(0,lr.hasChildren)(a)||!s)){var i=s.children,c=i.indexOf(a);if(!(c<0)){var o=typeof t[0]=="function"?t[0].call(a,n,e._render(a.children)):t,f=e._makeDomArray(o,n<u);Zr(i,c+1,0,f,s)}}})}pe.after=$T;function ZT(e){var t=this;typeof e=="string"&&(e=this._make(e)),this.remove();var r=[];return this._makeDomArray(e).forEach(function(u){var a=t.clone().toArray(),n=u.parent;if(n){var s=n.children,i=s.indexOf(u);i<0||(Zr(s,i+1,0,a,n),r.push.apply(r,a))}}),this._make(r)}pe.insertAfter=ZT;function JT(){for(var e=this,t=[],r=0;r<arguments.length;r++)t[r]=arguments[r];var u=this.length-1;return(0,Ye.domEach)(this,function(a,n){var s=a.parent;if(!(!(0,lr.hasChildren)(a)||!s)){var i=s.children,c=i.indexOf(a);if(!(c<0)){var o=typeof t[0]=="function"?t[0].call(a,n,e._render(a.children)):t,f=e._makeDomArray(o,n<u);Zr(i,c,0,f,s)}}})}pe.before=JT;function ex(e){var t=this,r=this._make(e);this.remove();var u=[];return(0,Ye.domEach)(r,function(a){var n=t.clone().toArray(),s=a.parent;if(s){var i=s.children,c=i.indexOf(a);c<0||(Zr(i,c,0,n,s),u.push.apply(u,n))}}),this._make(u)}pe.insertBefore=ex;function tx(e){var t=e?this.filter(e):this;return(0,Ye.domEach)(t,function(r){(0,YT.removeElement)(r),r.prev=r.next=r.parent=null}),this}pe.remove=tx;function rx(e){var t=this;return(0,Ye.domEach)(this,function(r,u){var a=r.parent;if(a){var n=a.children,s=typeof e=="function"?e.call(r,u,r):e,i=t._makeDomArray(s);(0,n0.update)(i,null);var c=n.indexOf(r);Zr(n,c,1,i,a),i.includes(r)||(r.parent=r.prev=r.next=null)}})}pe.replaceWith=rx;function ux(){return(0,Ye.domEach)(this,function(e){(0,lr.hasChildren)(e)&&(e.children.forEach(function(t){t.next=t.prev=t.parent=null}),e.children.length=0)})}pe.empty=ux;function ax(e){var t=this;if(e===void 0){var r=this[0];return!r||!(0,lr.hasChildren)(r)?null:this._render(r.children)}return(0,Ye.domEach)(this,function(u){if((0,lr.hasChildren)(u)){u.children.forEach(function(n){n.next=n.prev=n.parent=null});var a=(0,Ye.isCheerio)(e)?e.toArray():t._parse("".concat(e),t.options,!1,u).children;(0,n0.update)(a,u)}})}pe.html=ax;function nx(){return this._render(this)}pe.toString=nx;function ix(e){var t=this;return e===void 0?(0,pd.text)(this):typeof e=="function"?(0,Ye.domEach)(this,function(r,u){return t._make(r).text(e.call(r,u,(0,pd.text)([r])))}):(0,Ye.domEach)(this,function(r){if((0,lr.hasChildren)(r)){r.children.forEach(function(a){a.next=a.prev=a.parent=null});var u=new lr.Text("".concat(e));(0,n0.update)(u,r)}})}pe.text=ix;function sx(){return this._make((0,Ye.cloneDom)(this.get()))}pe.clone=sx});var Ad=R(ln=>{"use strict";Object.defineProperty(ln,"__esModule",{value:!0});ln.css=void 0;var Js=yu();function ox(e,t){if(e!=null&&t!=null||typeof e=="object"&&!Array.isArray(e))return(0,Js.domEach)(this,function(r,u){(0,Js.isTag)(r)&&Td(r,e,t,u)});if(this.length!==0)return xd(this[0],e)}ln.css=ox;function Td(e,t,r,u){if(typeof t=="string"){var a=xd(e),n=typeof r=="function"?r.call(e,u,a[t]):r;n===""?delete a[t]:n!=null&&(a[t]=n),e.attribs.style=cx(a)}else typeof t=="object"&&Object.keys(t).forEach(function(s,i){Td(e,s,t[s],i)})}function xd(e,t){if(!(!e||!(0,Js.isTag)(e))){var r=fx(e.attribs.style);if(typeof t=="string")return r[t];if(Array.isArray(t)){var u={};return t.forEach(function(a){r[a]!=null&&(u[a]=r[a])}),u}return r}}function cx(e){return Object.keys(e).reduce(function(t,r){return"".concat(t).concat(t?" ":"").concat(r,": ").concat(e[r],";")},"")}function fx(e){if(e=(e||"").trim(),!e)return{};for(var t={},r,u=0,a=e.split(";");u<a.length;u++){var n=a[u],s=n.indexOf(":");if(s<1||s===n.length-1){var i=n.trimEnd();i.length>0&&r!==void 0&&(t[r]+=";".concat(i))}else r=n.slice(0,s).trim(),t[r]=n.slice(s+1).trim()}return t}});var vd=R(i0=>{"use strict";Object.defineProperty(i0,"__esModule",{value:!0});i0.serializeArray=i0.serialize=void 0;var lx=yu(),md="input,select,textarea,keygen",dx=/%20/g,gd=/\\r?\\n/g;function hx(){var e=this.serializeArray(),t=e.map(function(r){return"".concat(encodeURIComponent(r.name),"=").concat(encodeURIComponent(r.value))});return t.join("&").replace(dx,"+")}i0.serialize=hx;function px(){var e=this;return this.map(function(t,r){var u=e._make(r);return(0,lx.isTag)(r)&&r.name==="form"?u.find(md).toArray():u.filter(md).toArray()}).filter(\'[name!=""]:enabled:not(:submit, :button, :image, :reset, :file):matches([checked], :not(:checkbox, :radio))\').map(function(t,r){var u,a=e._make(r),n=a.attr("name"),s=(u=a.val())!==null&&u!==void 0?u:"";return Array.isArray(s)?s.map(function(i){return{name:n,value:i.replace(gd,`\\r\n`)}}):{name:n,value:s.replace(gd,`\\r\n`)}}).toArray()}i0.serializeArray=px});var yd=R(dr=>{"use strict";var bx=dr&&dr.__createBinding||(Object.create?function(e,t,r,u){u===void 0&&(u=r);var a=Object.getOwnPropertyDescriptor(t,r);(!a||("get"in a?!t.__esModule:a.writable||a.configurable))&&(a={enumerable:!0,get:function(){return t[r]}}),Object.defineProperty(e,u,a)}:function(e,t,r,u){u===void 0&&(u=r),e[u]=t[r]}),_x=dr&&dr.__setModuleDefault||(Object.create?function(e,t){Object.defineProperty(e,"default",{enumerable:!0,value:t})}:function(e,t){e.default=t}),X0=dr&&dr.__importStar||function(e){if(e&&e.__esModule)return e;var t={};if(e!=null)for(var r in e)r!=="default"&&Object.prototype.hasOwnProperty.call(e,r)&&bx(t,e,r);return _x(t,e),t};Object.defineProperty(dr,"__esModule",{value:!0});dr.Cheerio=void 0;var Ex=X0(pl()),Tx=X0(ld()),xx=X0(Ed()),Ax=X0(Ad()),mx=X0(vd()),K0=function(){function e(t,r,u){if(this.length=0,this.options=u,this._root=r,t){for(var a=0;a<t.length;a++)this[a]=t[a];this.length=t.length}}return e}();dr.Cheerio=K0;K0.prototype.cheerio="[cheerio object]";K0.prototype.splice=Array.prototype.splice;K0.prototype[Symbol.iterator]=Array.prototype[Symbol.iterator];Object.assign(K0.prototype,Ex,Tx,xx,Ax,mx)});var Cd=R(yt=>{"use strict";var gx=yt&&yt.__extends||function(){var e=function(t,r){return e=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(u,a){u.__proto__=a}||function(u,a){for(var n in a)Object.prototype.hasOwnProperty.call(a,n)&&(u[n]=a[n])},e(t,r)};return function(t,r){if(typeof r!="function"&&r!==null)throw new TypeError("Class extends value "+String(r)+" is not a constructor or null");e(t,r);function u(){this.constructor=t}t.prototype=r===null?Object.create(r):(u.prototype=r.prototype,new u)}}(),s0=yt&&yt.__assign||function(){return s0=Object.assign||function(e){for(var t,r=1,u=arguments.length;r<u;r++){t=arguments[r];for(var a in t)Object.prototype.hasOwnProperty.call(t,a)&&(e[a]=t[a])}return e},s0.apply(this,arguments)},vx=yt&&yt.__createBinding||(Object.create?function(e,t,r,u){u===void 0&&(u=r);var a=Object.getOwnPropertyDescriptor(t,r);(!a||("get"in a?!t.__esModule:a.writable||a.configurable))&&(a={enumerable:!0,get:function(){return t[r]}}),Object.defineProperty(e,u,a)}:function(e,t,r,u){u===void 0&&(u=r),e[u]=t[r]}),yx=yt&&yt.__setModuleDefault||(Object.create?function(e,t){Object.defineProperty(e,"default",{enumerable:!0,value:t})}:function(e,t){e.default=t}),Dd=yt&&yt.__importStar||function(e){if(e&&e.__esModule)return e;var t={};if(e!=null)for(var r in e)r!=="default"&&Object.prototype.hasOwnProperty.call(e,r)&&vx(t,e,r);return yx(t,e),t};Object.defineProperty(yt,"__esModule",{value:!0});yt.getLoad=void 0;var eo=Dd(Qi()),Dx=Dd(gu()),Cx=yd(),$0=yu();function Ix(e,t){return function r(u,a,n){if(n===void 0&&(n=!0),u==null)throw new Error("cheerio.load() expects a string");var s=s0(s0({},eo.default),(0,eo.flatten)(a)),i=e(u,s,n,null),c=function(f){gx(p,f);function p(){return f!==null&&f.apply(this,arguments)||this}return p.prototype._make=function(d,b){var _=o(d,b);return _.prevObject=this,_},p.prototype._parse=function(d,b,_,C){return e(d,b,_,C)},p.prototype._render=function(d){return t(d,this.options)},p}(Cx.Cheerio);function o(f,p,d,b){if(d===void 0&&(d=i),f&&(0,$0.isCheerio)(f))return f;var _=s0(s0({},s),(0,eo.flatten)(b)),C=typeof d=="string"?[e(d,_,!1,null)]:"length"in d?d:[d],D=(0,$0.isCheerio)(C)?C:new c(C,null,_);if(D._root=D,!f)return new c(void 0,D,_);var T=typeof f=="string"&&(0,$0.isHtml)(f)?e(f,_,!1,null).children:Sx(f)?[f]:Array.isArray(f)?f:void 0,A=new c(T,D,_);if(T)return A;if(typeof f!="string")throw new Error("Unexpected type of selector");var v=f,g=p?typeof p=="string"?(0,$0.isHtml)(p)?new c([e(p,_,!1,null)],D,_):(v="".concat(p," ").concat(v),D):(0,$0.isCheerio)(p)?p:new c(Array.isArray(p)?p:[p],D,_):D;return g?g.find(v):A}return Object.assign(o,Dx,{load:r,_root:i,_options:s,fn:c.prototype,prototype:c.prototype}),o}}yt.getLoad=Ix;function Sx(e){return!!e.name||e.type==="root"||e.type==="text"||e.type==="comment"}});var dn=R(wt=>{"use strict";Object.defineProperty(wt,"__esModule",{value:!0});wt.SEQUENCES=wt.CODE_POINTS=wt.REPLACEMENT_CHARACTER=void 0;wt.isSurrogate=Ox;wt.isSurrogatePair=Rx;wt.getSurrogatePairCodePoint=Px;wt.isControlCodePoint=Bx;wt.isUndefinedCodePoint=wx;var Nx=new Set([65534,65535,131070,131071,196606,196607,262142,262143,327678,327679,393214,393215,458750,458751,524286,524287,589822,589823,655358,655359,720894,720895,786430,786431,851966,851967,917502,917503,983038,983039,1048574,1048575,1114110,1114111]);wt.REPLACEMENT_CHARACTER="�";var Id;(function(e){e[e.EOF=-1]="EOF",e[e.NULL=0]="NULL",e[e.TABULATION=9]="TABULATION",e[e.CARRIAGE_RETURN=13]="CARRIAGE_RETURN",e[e.LINE_FEED=10]="LINE_FEED",e[e.FORM_FEED=12]="FORM_FEED",e[e.SPACE=32]="SPACE",e[e.EXCLAMATION_MARK=33]="EXCLAMATION_MARK",e[e.QUOTATION_MARK=34]="QUOTATION_MARK",e[e.AMPERSAND=38]="AMPERSAND",e[e.APOSTROPHE=39]="APOSTROPHE",e[e.HYPHEN_MINUS=45]="HYPHEN_MINUS",e[e.SOLIDUS=47]="SOLIDUS",e[e.DIGIT_0=48]="DIGIT_0",e[e.DIGIT_9=57]="DIGIT_9",e[e.SEMICOLON=59]="SEMICOLON",e[e.LESS_THAN_SIGN=60]="LESS_THAN_SIGN",e[e.EQUALS_SIGN=61]="EQUALS_SIGN",e[e.GREATER_THAN_SIGN=62]="GREATER_THAN_SIGN",e[e.QUESTION_MARK=63]="QUESTION_MARK",e[e.LATIN_CAPITAL_A=65]="LATIN_CAPITAL_A",e[e.LATIN_CAPITAL_Z=90]="LATIN_CAPITAL_Z",e[e.RIGHT_SQUARE_BRACKET=93]="RIGHT_SQUARE_BRACKET",e[e.GRAVE_ACCENT=96]="GRAVE_ACCENT",e[e.LATIN_SMALL_A=97]="LATIN_SMALL_A",e[e.LATIN_SMALL_Z=122]="LATIN_SMALL_Z"})(Id||(wt.CODE_POINTS=Id={}));wt.SEQUENCES={DASH_DASH:"--",CDATA_START:"[CDATA[",DOCTYPE:"doctype",SCRIPT:"script",PUBLIC:"public",SYSTEM:"system"};function Ox(e){return e>=55296&&e<=57343}function Rx(e){return e>=56320&&e<=57343}function Px(e,t){return(e-55296)*1024+9216+t}function Bx(e){return e!==32&&e!==10&&e!==13&&e!==9&&e!==12&&e>=1&&e<=31||e>=127&&e<=159}function wx(e){return e>=64976&&e<=65007||Nx.has(e)}});var Z0=R(hn=>{"use strict";Object.defineProperty(hn,"__esModule",{value:!0});hn.ERR=void 0;var Sd;(function(e){e.controlCharacterInInputStream="control-character-in-input-stream",e.noncharacterInInputStream="noncharacter-in-input-stream",e.surrogateInInputStream="surrogate-in-input-stream",e.nonVoidHtmlElementStartTagWithTrailingSolidus="non-void-html-element-start-tag-with-trailing-solidus",e.endTagWithAttributes="end-tag-with-attributes",e.endTagWithTrailingSolidus="end-tag-with-trailing-solidus",e.unexpectedSolidusInTag="unexpected-solidus-in-tag",e.unexpectedNullCharacter="unexpected-null-character",e.unexpectedQuestionMarkInsteadOfTagName="unexpected-question-mark-instead-of-tag-name",e.invalidFirstCharacterOfTagName="invalid-first-character-of-tag-name",e.unexpectedEqualsSignBeforeAttributeName="unexpected-equals-sign-before-attribute-name",e.missingEndTagName="missing-end-tag-name",e.unexpectedCharacterInAttributeName="unexpected-character-in-attribute-name",e.unknownNamedCharacterReference="unknown-named-character-reference",e.missingSemicolonAfterCharacterReference="missing-semicolon-after-character-reference",e.unexpectedCharacterAfterDoctypeSystemIdentifier="unexpected-character-after-doctype-system-identifier",e.unexpectedCharacterInUnquotedAttributeValue="unexpected-character-in-unquoted-attribute-value",e.eofBeforeTagName="eof-before-tag-name",e.eofInTag="eof-in-tag",e.missingAttributeValue="missing-attribute-value",e.missingWhitespaceBetweenAttributes="missing-whitespace-between-attributes",e.missingWhitespaceAfterDoctypePublicKeyword="missing-whitespace-after-doctype-public-keyword",e.missingWhitespaceBetweenDoctypePublicAndSystemIdentifiers="missing-whitespace-between-doctype-public-and-system-identifiers",e.missingWhitespaceAfterDoctypeSystemKeyword="missing-whitespace-after-doctype-system-keyword",e.missingQuoteBeforeDoctypePublicIdentifier="missing-quote-before-doctype-public-identifier",e.missingQuoteBeforeDoctypeSystemIdentifier="missing-quote-before-doctype-system-identifier",e.missingDoctypePublicIdentifier="missing-doctype-public-identifier",e.missingDoctypeSystemIdentifier="missing-doctype-system-identifier",e.abruptDoctypePublicIdentifier="abrupt-doctype-public-identifier",e.abruptDoctypeSystemIdentifier="abrupt-doctype-system-identifier",e.cdataInHtmlContent="cdata-in-html-content",e.incorrectlyOpenedComment="incorrectly-opened-comment",e.eofInScriptHtmlCommentLikeText="eof-in-script-html-comment-like-text",e.eofInDoctype="eof-in-doctype",e.nestedComment="nested-comment",e.abruptClosingOfEmptyComment="abrupt-closing-of-empty-comment",e.eofInComment="eof-in-comment",e.incorrectlyClosedComment="incorrectly-closed-comment",e.eofInCdata="eof-in-cdata",e.absenceOfDigitsInNumericCharacterReference="absence-of-digits-in-numeric-character-reference",e.nullCharacterReference="null-character-reference",e.surrogateCharacterReference="surrogate-character-reference",e.characterReferenceOutsideUnicodeRange="character-reference-outside-unicode-range",e.controlCharacterReference="control-character-reference",e.noncharacterCharacterReference="noncharacter-character-reference",e.missingWhitespaceBeforeDoctypeName="missing-whitespace-before-doctype-name",e.missingDoctypeName="missing-doctype-name",e.invalidCharacterSequenceAfterDoctypeName="invalid-character-sequence-after-doctype-name",e.duplicateAttribute="duplicate-attribute",e.nonConformingDoctype="non-conforming-doctype",e.missingDoctype="missing-doctype",e.misplacedDoctype="misplaced-doctype",e.endTagWithoutMatchingOpenElement="end-tag-without-matching-open-element",e.closingOfElementWithOpenChildElements="closing-of-element-with-open-child-elements",e.disallowedContentInNoscriptInHead="disallowed-content-in-noscript-in-head",e.openElementsLeftAfterEof="open-elements-left-after-eof",e.abandonedHeadElementChild="abandoned-head-element-child",e.misplacedStartTagForHeadElement="misplaced-start-tag-for-head-element",e.nestedNoscriptInHead="nested-noscript-in-head",e.eofInElementThatCanContainOnlyText="eof-in-element-that-can-contain-only-text"})(Sd||(hn.ERR=Sd={}))});var Nd=R(pn=>{"use strict";Object.defineProperty(pn,"__esModule",{value:!0});pn.Preprocessor=void 0;var Et=dn(),to=Z0(),Lx=65536,ro=class{constructor(t){this.handler=t,this.html="",this.pos=-1,this.lastGapPos=-2,this.gapStack=[],this.skipNextNewLine=!1,this.lastChunkWritten=!1,this.endOfChunkHit=!1,this.bufferWaterline=Lx,this.isEol=!1,this.lineStartPos=0,this.droppedBufferSize=0,this.line=1,this.lastErrOffset=-1}get col(){return this.pos-this.lineStartPos+ +(this.lastGapPos!==this.pos)}get offset(){return this.droppedBufferSize+this.pos}getError(t,r){let{line:u,col:a,offset:n}=this,s=a+r,i=n+r;return{code:t,startLine:u,endLine:u,startCol:s,endCol:s,startOffset:i,endOffset:i}}_err(t){this.handler.onParseError&&this.lastErrOffset!==this.offset&&(this.lastErrOffset=this.offset,this.handler.onParseError(this.getError(t,0)))}_addGap(){this.gapStack.push(this.lastGapPos),this.lastGapPos=this.pos}_processSurrogate(t){if(this.pos!==this.html.length-1){let r=this.html.charCodeAt(this.pos+1);if((0,Et.isSurrogatePair)(r))return this.pos++,this._addGap(),(0,Et.getSurrogatePairCodePoint)(t,r)}else if(!this.lastChunkWritten)return this.endOfChunkHit=!0,Et.CODE_POINTS.EOF;return this._err(to.ERR.surrogateInInputStream),t}willDropParsedChunk(){return this.pos>this.bufferWaterline}dropParsedChunk(){this.willDropParsedChunk()&&(this.html=this.html.substring(this.pos),this.lineStartPos-=this.pos,this.droppedBufferSize+=this.pos,this.pos=0,this.lastGapPos=-2,this.gapStack.length=0)}write(t,r){this.html.length>0?this.html+=t:this.html=t,this.endOfChunkHit=!1,this.lastChunkWritten=r}insertHtmlAtCurrentPos(t){this.html=this.html.substring(0,this.pos+1)+t+this.html.substring(this.pos+1),this.endOfChunkHit=!1}startsWith(t,r){if(this.pos+t.length>this.html.length)return this.endOfChunkHit=!this.lastChunkWritten,!1;if(r)return this.html.startsWith(t,this.pos);for(let u=0;u<t.length;u++)if((this.html.charCodeAt(this.pos+u)|32)!==t.charCodeAt(u))return!1;return!0}peek(t){let r=this.pos+t;if(r>=this.html.length)return this.endOfChunkHit=!this.lastChunkWritten,Et.CODE_POINTS.EOF;let u=this.html.charCodeAt(r);return u===Et.CODE_POINTS.CARRIAGE_RETURN?Et.CODE_POINTS.LINE_FEED:u}advance(){if(this.pos++,this.isEol&&(this.isEol=!1,this.line++,this.lineStartPos=this.pos),this.pos>=this.html.length)return this.endOfChunkHit=!this.lastChunkWritten,Et.CODE_POINTS.EOF;let t=this.html.charCodeAt(this.pos);return t===Et.CODE_POINTS.CARRIAGE_RETURN?(this.isEol=!0,this.skipNextNewLine=!0,Et.CODE_POINTS.LINE_FEED):t===Et.CODE_POINTS.LINE_FEED&&(this.isEol=!0,this.skipNextNewLine)?(this.line--,this.skipNextNewLine=!1,this._addGap(),this.advance()):(this.skipNextNewLine=!1,(0,Et.isSurrogate)(t)&&(t=this._processSurrogate(t)),this.handler.onParseError===null||t>31&&t<127||t===Et.CODE_POINTS.LINE_FEED||t===Et.CODE_POINTS.CARRIAGE_RETURN||t>159&&t<64976||this._checkForProblematicCharacters(t),t)}_checkForProblematicCharacters(t){(0,Et.isControlCodePoint)(t)?this._err(to.ERR.controlCharacterInInputStream):(0,Et.isUndefinedCodePoint)(t)&&this._err(to.ERR.noncharacterInInputStream)}retreat(t){for(this.pos-=t;this.pos<this.lastGapPos;)this.lastGapPos=this.gapStack.pop(),this.pos--;this.isEol=!1}};pn.Preprocessor=ro});var bn=R(J0=>{"use strict";Object.defineProperty(J0,"__esModule",{value:!0});J0.TokenType=void 0;J0.getTokenAttr=Mx;var Od;(function(e){e[e.CHARACTER=0]="CHARACTER",e[e.NULL_CHARACTER=1]="NULL_CHARACTER",e[e.WHITESPACE_CHARACTER=2]="WHITESPACE_CHARACTER",e[e.START_TAG=3]="START_TAG",e[e.END_TAG=4]="END_TAG",e[e.COMMENT=5]="COMMENT",e[e.DOCTYPE=6]="DOCTYPE",e[e.EOF=7]="EOF",e[e.HIBERNATION=8]="HIBERNATION"})(Od||(J0.TokenType=Od={}));function Mx(e,t){for(let r=e.attrs.length-1;r>=0;r--)if(e.attrs[r].name===t)return e.attrs[r].value;return null}});var uo=R(_n=>{"use strict";Object.defineProperty(_n,"__esModule",{value:!0});_n.htmlDecodeTree=void 0;_n.htmlDecodeTree=new Uint16Array(\'ᵁ<Õıʊҝջאٵ۞ޢߖࠏ੊ઑඡ๭༉༦჊ረዡᐕᒝᓃᓟᔥ\\0\\0\\0\\0\\0\\0ᕫᛍᦍᰒᷝ὾⁠↰⊍⏀⏻⑂⠤⤒ⴈ⹈⿎〖㊺㘹㞬㣾㨨㩱㫠㬮ࠀEMabcfglmnoprstu\\\\bfms¦³¹ÈÏlig耻Æ䃆P耻&䀦cute耻Á䃁reve;䄂Āiyx}rc耻Â䃂;䐐r;쀀𝔄rave耻À䃀pha;䎑acr;䄀d;橓Āgp¡on;䄄f;쀀𝔸plyFunction;恡ing耻Å䃅Ācs¾Ãr;쀀𝒜ign;扔ilde耻Ã䃃ml耻Ä䃄ЀaceforsuåûþėĜĢħĪĀcrêòkslash;或Ŷöø;櫧ed;挆y;䐑ƀcrtąċĔause;戵noullis;愬a;䎒r;쀀𝔅pf;쀀𝔹eve;䋘còēmpeq;扎܀HOacdefhilorsuōőŖƀƞƢƵƷƺǜȕɳɸɾcy;䐧PY耻©䂩ƀcpyŝŢźute;䄆Ā;iŧŨ拒talDifferentialD;慅leys;愭ȀaeioƉƎƔƘron;䄌dil耻Ç䃇rc;䄈nint;戰ot;䄊ĀdnƧƭilla;䂸terDot;䂷òſi;䎧rcleȀDMPTǇǋǑǖot;抙inus;抖lus;投imes;抗oĀcsǢǸkwiseContourIntegral;戲eCurlyĀDQȃȏoubleQuote;思uote;怙ȀlnpuȞȨɇɕonĀ;eȥȦ户;橴ƀgitȯȶȺruent;扡nt;戯ourIntegral;戮ĀfrɌɎ;愂oduct;成nterClockwiseContourIntegral;戳oss;樯cr;쀀𝒞pĀ;Cʄʅ拓ap;才րDJSZacefiosʠʬʰʴʸˋ˗ˡ˦̳ҍĀ;oŹʥtrahd;椑cy;䐂cy;䐅cy;䐏ƀgrsʿ˄ˇger;怡r;憡hv;櫤Āayː˕ron;䄎;䐔lĀ;t˝˞戇a;䎔r;쀀𝔇Āaf˫̧Ācm˰̢riticalȀADGT̖̜̀̆cute;䂴oŴ̋̍;䋙bleAcute;䋝rave;䁠ilde;䋜ond;拄ferentialD;慆Ѱ̽\\0\\0\\0͔͂\\0Ѕf;쀀𝔻ƀ;DE͈͉͍䂨ot;惜qual;扐blèCDLRUVͣͲ΂ϏϢϸontourIntegraìȹoɴ͹\\0\\0ͻ»͉nArrow;懓Āeo·ΤftƀARTΐΖΡrrow;懐ightArrow;懔eåˊngĀLRΫτeftĀARγιrrow;柸ightArrow;柺ightArrow;柹ightĀATϘϞrrow;懒ee;抨pɁϩ\\0\\0ϯrrow;懑ownArrow;懕erticalBar;戥ǹABLRTaВЪаўѿͼrrowƀ;BUНОТ憓ar;椓pArrow;懵reve;䌑eft˒к\\0ц\\0ѐightVector;楐eeVector;楞ectorĀ;Bљњ憽ar;楖ightǔѧ\\0ѱeeVector;楟ectorĀ;BѺѻ懁ar;楗eeĀ;A҆҇护rrow;憧ĀctҒҗr;쀀𝒟rok;䄐ࠀNTacdfglmopqstuxҽӀӄӋӞӢӧӮӵԡԯԶՒ՝ՠեG;䅊H耻Ð䃐cute耻É䃉ƀaiyӒӗӜron;䄚rc耻Ê䃊;䐭ot;䄖r;쀀𝔈rave耻È䃈ement;戈ĀapӺӾcr;䄒tyɓԆ\\0\\0ԒmallSquare;旻erySmallSquare;斫ĀgpԦԪon;䄘f;쀀𝔼silon;䎕uĀaiԼՉlĀ;TՂՃ橵ilde;扂librium;懌Āci՗՚r;愰m;橳a;䎗ml耻Ë䃋Āipժկsts;戃onentialE;慇ʀcfiosօֈ֍ֲ׌y;䐤r;쀀𝔉lledɓ֗\\0\\0֣mallSquare;旼erySmallSquare;斪Ͱֺ\\0ֿ\\0\\0ׄf;쀀𝔽All;戀riertrf;愱cò׋؀JTabcdfgorstר׬ׯ׺؀ؒؖ؛؝أ٬ٲcy;䐃耻>䀾mmaĀ;d׷׸䎓;䏜reve;䄞ƀeiy؇،ؐdil;䄢rc;䄜;䐓ot;䄠r;쀀𝔊;拙pf;쀀𝔾eater̀EFGLSTصلَٖٛ٦qualĀ;Lؾؿ扥ess;招ullEqual;执reater;檢ess;扷lantEqual;橾ilde;扳cr;쀀𝒢;扫ЀAacfiosuڅڋږڛڞڪھۊRDcy;䐪Āctڐڔek;䋇;䁞irc;䄤r;愌lbertSpace;愋ǰگ\\0ڲf;愍izontalLine;攀Āctۃۅòکrok;䄦mpńېۘownHumðįqual;扏܀EJOacdfgmnostuۺ۾܃܇܎ܚܞܡܨ݄ݸދޏޕcy;䐕lig;䄲cy;䐁cute耻Í䃍Āiyܓܘrc耻Î䃎;䐘ot;䄰r;愑rave耻Ì䃌ƀ;apܠܯܿĀcgܴܷr;䄪inaryI;慈lieóϝǴ݉\\0ݢĀ;eݍݎ戬Āgrݓݘral;戫section;拂isibleĀCTݬݲomma;恣imes;恢ƀgptݿރވon;䄮f;쀀𝕀a;䎙cr;愐ilde;䄨ǫޚ\\0ޞcy;䐆l耻Ï䃏ʀcfosuެ޷޼߂ߐĀiyޱ޵rc;䄴;䐙r;쀀𝔍pf;쀀𝕁ǣ߇\\0ߌr;쀀𝒥rcy;䐈kcy;䐄΀HJacfosߤߨ߽߬߱ࠂࠈcy;䐥cy;䐌ppa;䎚Āey߶߻dil;䄶;䐚r;쀀𝔎pf;쀀𝕂cr;쀀𝒦րJTaceflmostࠥࠩࠬࡐࡣ঳সে্਷ੇcy;䐉耻<䀼ʀcmnpr࠷࠼ࡁࡄࡍute;䄹bda;䎛g;柪lacetrf;愒r;憞ƀaeyࡗ࡜ࡡron;䄽dil;䄻;䐛Āfsࡨ॰tԀACDFRTUVarࡾࢩࢱࣦ࣠ࣼयज़ΐ४Ānrࢃ࢏gleBracket;柨rowƀ;BR࢙࢚࢞憐ar;懤ightArrow;懆eiling;挈oǵࢷ\\0ࣃbleBracket;柦nǔࣈ\\0࣒eeVector;楡ectorĀ;Bࣛࣜ懃ar;楙loor;挊ightĀAV࣯ࣵrrow;憔ector;楎Āerँगeƀ;AVउऊऐ抣rrow;憤ector;楚iangleƀ;BEतथऩ抲ar;槏qual;抴pƀDTVषूौownVector;楑eeVector;楠ectorĀ;Bॖॗ憿ar;楘ectorĀ;B॥०憼ar;楒ightáΜs̀EFGLSTॾঋকঝঢভqualGreater;拚ullEqual;扦reater;扶ess;檡lantEqual;橽ilde;扲r;쀀𝔏Ā;eঽা拘ftarrow;懚idot;䄿ƀnpw৔ਖਛgȀLRlr৞৷ਂਐeftĀAR০৬rrow;柵ightArrow;柷ightArrow;柶eftĀarγਊightáοightáϊf;쀀𝕃erĀLRਢਬeftArrow;憙ightArrow;憘ƀchtਾੀੂòࡌ;憰rok;䅁;扪Ѐacefiosuਗ਼੝੠੷੼અઋ઎p;椅y;䐜Ādl੥੯iumSpace;恟lintrf;愳r;쀀𝔐nusPlus;戓pf;쀀𝕄cò੶;䎜ҀJacefostuણધભીଔଙඑ඗ඞcy;䐊cute;䅃ƀaey઴હાron;䅇dil;䅅;䐝ƀgswે૰଎ativeƀMTV૓૟૨ediumSpace;怋hiĀcn૦૘ë૙eryThiî૙tedĀGL૸ଆreaterGreateòٳessLesóੈLine;䀊r;쀀𝔑ȀBnptଢନଷ଺reak;恠BreakingSpace;䂠f;愕ڀ;CDEGHLNPRSTV୕ୖ୪୼஡௫ఄ౞಄ದ೘ൡඅ櫬Āou୛୤ngruent;扢pCap;扭oubleVerticalBar;戦ƀlqxஃஊ஛ement;戉ualĀ;Tஒஓ扠ilde;쀀≂̸ists;戄reater΀;EFGLSTஶஷ஽௉௓௘௥扯qual;扱ullEqual;쀀≧̸reater;쀀≫̸ess;批lantEqual;쀀⩾̸ilde;扵umpń௲௽ownHump;쀀≎̸qual;쀀≏̸eĀfsఊధtTriangleƀ;BEచఛడ拪ar;쀀⧏̸qual;括s̀;EGLSTవశ఼ౄోౘ扮qual;扰reater;扸ess;쀀≪̸lantEqual;쀀⩽̸ilde;扴estedĀGL౨౹reaterGreater;쀀⪢̸essLess;쀀⪡̸recedesƀ;ESಒಓಛ技qual;쀀⪯̸lantEqual;拠ĀeiಫಹverseElement;戌ghtTriangleƀ;BEೋೌ೒拫ar;쀀⧐̸qual;拭ĀquೝഌuareSuĀbp೨೹setĀ;E೰ೳ쀀⊏̸qual;拢ersetĀ;Eഃആ쀀⊐̸qual;拣ƀbcpഓതൎsetĀ;Eഛഞ쀀⊂⃒qual;抈ceedsȀ;ESTലള഻െ抁qual;쀀⪰̸lantEqual;拡ilde;쀀≿̸ersetĀ;E൘൛쀀⊃⃒qual;抉ildeȀ;EFT൮൯൵ൿ扁qual;扄ullEqual;扇ilde;扉erticalBar;戤cr;쀀𝒩ilde耻Ñ䃑;䎝܀Eacdfgmoprstuvලෂ෉෕ෛ෠෧෼ขภยา฿ไlig;䅒cute耻Ó䃓Āiy෎ීrc耻Ô䃔;䐞blac;䅐r;쀀𝔒rave耻Ò䃒ƀaei෮ෲ෶cr;䅌ga;䎩cron;䎟pf;쀀𝕆enCurlyĀDQฎบoubleQuote;怜uote;怘;橔Āclวฬr;쀀𝒪ash耻Ø䃘iŬื฼de耻Õ䃕es;樷ml耻Ö䃖erĀBP๋๠Āar๐๓r;怾acĀek๚๜;揞et;掴arenthesis;揜Ҁacfhilors๿ງຊຏຒດຝະ໼rtialD;戂y;䐟r;쀀𝔓i;䎦;䎠usMinus;䂱Āipຢອncareplanåڝf;愙Ȁ;eio຺ູ໠໤檻cedesȀ;EST່້໏໚扺qual;檯lantEqual;扼ilde;找me;怳Ādp໩໮uct;戏ortionĀ;aȥ໹l;戝Āci༁༆r;쀀𝒫;䎨ȀUfos༑༖༛༟OT耻"䀢r;쀀𝔔pf;愚cr;쀀𝒬؀BEacefhiorsu༾གྷཇའཱིྦྷྪྭ႖ႩႴႾarr;椐G耻®䂮ƀcnrཎནབute;䅔g;柫rĀ;tཛྷཝ憠l;椖ƀaeyཧཬཱron;䅘dil;䅖;䐠Ā;vླྀཹ愜erseĀEUྂྙĀlq྇ྎement;戋uilibrium;懋pEquilibrium;楯r»ཹo;䎡ghtЀACDFTUVa࿁࿫࿳ဢဨၛႇϘĀnr࿆࿒gleBracket;柩rowƀ;BL࿜࿝࿡憒ar;懥eftArrow;懄eiling;按oǵ࿹\\0စbleBracket;柧nǔည\\0နeeVector;楝ectorĀ;Bဝသ懂ar;楕loor;挋Āerိ၃eƀ;AVဵံြ抢rrow;憦ector;楛iangleƀ;BEၐၑၕ抳ar;槐qual;抵pƀDTVၣၮၸownVector;楏eeVector;楜ectorĀ;Bႂႃ憾ar;楔ectorĀ;B႑႒懀ar;楓Āpuႛ႞f;愝ndImplies;楰ightarrow;懛ĀchႹႼr;愛;憱leDelayed;槴ڀHOacfhimoqstuფჱჷჽᄙᄞᅑᅖᅡᅧᆵᆻᆿĀCcჩხHcy;䐩y;䐨FTcy;䐬cute;䅚ʀ;aeiyᄈᄉᄎᄓᄗ檼ron;䅠dil;䅞rc;䅜;䐡r;쀀𝔖ortȀDLRUᄪᄴᄾᅉownArrow»ОeftArrow»࢚ightArrow»࿝pArrow;憑gma;䎣allCircle;战pf;쀀𝕊ɲᅭ\\0\\0ᅰt;戚areȀ;ISUᅻᅼᆉᆯ斡ntersection;抓uĀbpᆏᆞsetĀ;Eᆗᆘ抏qual;抑ersetĀ;Eᆨᆩ抐qual;抒nion;抔cr;쀀𝒮ar;拆ȀbcmpᇈᇛሉላĀ;sᇍᇎ拐etĀ;Eᇍᇕqual;抆ĀchᇠህeedsȀ;ESTᇭᇮᇴᇿ扻qual;檰lantEqual;扽ilde;承Tháྌ;我ƀ;esሒሓሣ拑rsetĀ;Eሜም抃qual;抇et»ሓրHRSacfhiorsሾቄ቉ቕ቞ቱቶኟዂወዑORN耻Þ䃞ADE;愢ĀHc቎ቒcy;䐋y;䐦Ābuቚቜ;䀉;䎤ƀaeyብቪቯron;䅤dil;䅢;䐢r;쀀𝔗Āeiቻ኉ǲኀ\\0ኇefore;戴a;䎘Ācn኎ኘkSpace;쀀  Space;怉ldeȀ;EFTካኬኲኼ戼qual;扃ullEqual;扅ilde;扈pf;쀀𝕋ipleDot;惛Āctዖዛr;쀀𝒯rok;䅦ૡዷጎጚጦ\\0ጬጱ\\0\\0\\0\\0\\0ጸጽ፷ᎅ\\0᏿ᐄᐊᐐĀcrዻጁute耻Ú䃚rĀ;oጇገ憟cir;楉rǣጓ\\0጖y;䐎ve;䅬Āiyጞጣrc耻Û䃛;䐣blac;䅰r;쀀𝔘rave耻Ù䃙acr;䅪Ādiፁ፩erĀBPፈ፝Āarፍፐr;䁟acĀekፗፙ;揟et;掵arenthesis;揝onĀ;P፰፱拃lus;抎Āgp፻፿on;䅲f;쀀𝕌ЀADETadps᎕ᎮᎸᏄϨᏒᏗᏳrrowƀ;BDᅐᎠᎤar;椒ownArrow;懅ownArrow;憕quilibrium;楮eeĀ;AᏋᏌ报rrow;憥ownáϳerĀLRᏞᏨeftArrow;憖ightArrow;憗iĀ;lᏹᏺ䏒on;䎥ing;䅮cr;쀀𝒰ilde;䅨ml耻Ü䃜ҀDbcdefosvᐧᐬᐰᐳᐾᒅᒊᒐᒖash;披ar;櫫y;䐒ashĀ;lᐻᐼ抩;櫦Āerᑃᑅ;拁ƀbtyᑌᑐᑺar;怖Ā;iᑏᑕcalȀBLSTᑡᑥᑪᑴar;戣ine;䁼eparator;杘ilde;所ThinSpace;怊r;쀀𝔙pf;쀀𝕍cr;쀀𝒱dash;抪ʀcefosᒧᒬᒱᒶᒼirc;䅴dge;拀r;쀀𝔚pf;쀀𝕎cr;쀀𝒲Ȁfiosᓋᓐᓒᓘr;쀀𝔛;䎞pf;쀀𝕏cr;쀀𝒳ҀAIUacfosuᓱᓵᓹᓽᔄᔏᔔᔚᔠcy;䐯cy;䐇cy;䐮cute耻Ý䃝Āiyᔉᔍrc;䅶;䐫r;쀀𝔜pf;쀀𝕐cr;쀀𝒴ml;䅸ЀHacdefosᔵᔹᔿᕋᕏᕝᕠᕤcy;䐖cute;䅹Āayᕄᕉron;䅽;䐗ot;䅻ǲᕔ\\0ᕛoWidtè૙a;䎖r;愨pf;愤cr;쀀𝒵௡ᖃᖊᖐ\\0ᖰᖶᖿ\\0\\0\\0\\0ᗆᗛᗫᙟ᙭\\0ᚕ᚛ᚲᚹ\\0ᚾcute耻á䃡reve;䄃̀;Ediuyᖜᖝᖡᖣᖨᖭ戾;쀀∾̳;房rc耻â䃢te肻´̆;䐰lig耻æ䃦Ā;r²ᖺ;쀀𝔞rave耻à䃠ĀepᗊᗖĀfpᗏᗔsym;愵èᗓha;䎱ĀapᗟcĀclᗤᗧr;䄁g;樿ɤᗰ\\0\\0ᘊʀ;adsvᗺᗻᗿᘁᘇ戧nd;橕;橜lope;橘;橚΀;elmrszᘘᘙᘛᘞᘿᙏᙙ戠;榤e»ᘙsdĀ;aᘥᘦ戡ѡᘰᘲᘴᘶᘸᘺᘼᘾ;榨;榩;榪;榫;榬;榭;榮;榯tĀ;vᙅᙆ戟bĀ;dᙌᙍ抾;榝Āptᙔᙗh;戢»¹arr;捼Āgpᙣᙧon;䄅f;쀀𝕒΀;Eaeiop዁ᙻᙽᚂᚄᚇᚊ;橰cir;橯;扊d;手s;䀧roxĀ;e዁ᚒñᚃing耻å䃥ƀctyᚡᚦᚨr;쀀𝒶;䀪mpĀ;e዁ᚯñʈilde耻ã䃣ml耻ä䃤Āciᛂᛈoninôɲnt;樑ࠀNabcdefiklnoprsu᛭ᛱᜰ᜼ᝃᝈ᝸᝽០៦ᠹᡐᜍ᤽᥈ᥰot;櫭Ācrᛶ᜞kȀcepsᜀᜅᜍᜓong;扌psilon;䏶rime;怵imĀ;e᜚᜛戽q;拍Ŷᜢᜦee;抽edĀ;gᜬᜭ挅e»ᜭrkĀ;t፜᜷brk;掶Āoyᜁᝁ;䐱quo;怞ʀcmprtᝓ᝛ᝡᝤᝨausĀ;eĊĉptyv;榰séᜌnoõēƀahwᝯ᝱ᝳ;䎲;愶een;扬r;쀀𝔟g΀costuvwឍឝឳេ៕៛៞ƀaiuបពរðݠrc;旯p»፱ƀdptឤឨឭot;樀lus;樁imes;樂ɱឹ\\0\\0ើcup;樆ar;昅riangleĀdu៍្own;施p;斳plus;樄eåᑄåᒭarow;植ƀako៭ᠦᠵĀcn៲ᠣkƀlst៺֫᠂ozenge;槫riangleȀ;dlr᠒᠓᠘᠝斴own;斾eft;旂ight;斸k;搣Ʊᠫ\\0ᠳƲᠯ\\0ᠱ;斒;斑4;斓ck;斈ĀeoᠾᡍĀ;qᡃᡆ쀀=⃥uiv;쀀≡⃥t;挐Ȁptwxᡙᡞᡧᡬf;쀀𝕓Ā;tᏋᡣom»Ꮜtie;拈؀DHUVbdhmptuvᢅᢖᢪᢻᣗᣛᣬ᣿ᤅᤊᤐᤡȀLRlrᢎᢐᢒᢔ;敗;敔;敖;敓ʀ;DUduᢡᢢᢤᢦᢨ敐;敦;敩;敤;敧ȀLRlrᢳᢵᢷᢹ;敝;敚;敜;教΀;HLRhlrᣊᣋᣍᣏᣑᣓᣕ救;敬;散;敠;敫;敢;敟ox;槉ȀLRlrᣤᣦᣨᣪ;敕;敒;攐;攌ʀ;DUduڽ᣷᣹᣻᣽;敥;敨;攬;攴inus;抟lus;択imes;抠ȀLRlrᤙᤛᤝ᤟;敛;敘;攘;攔΀;HLRhlrᤰᤱᤳᤵᤷ᤻᤹攂;敪;敡;敞;攼;攤;攜Āevģ᥂bar耻¦䂦Ȁceioᥑᥖᥚᥠr;쀀𝒷mi;恏mĀ;e᜚᜜lƀ;bhᥨᥩᥫ䁜;槅sub;柈Ŭᥴ᥾lĀ;e᥹᥺怢t»᥺pƀ;Eeįᦅᦇ;檮Ā;qۜۛೡᦧ\\0᧨ᨑᨕᨲ\\0ᨷᩐ\\0\\0᪴\\0\\0᫁\\0\\0ᬡᬮ᭍᭒\\0᯽\\0ᰌƀcpr᦭ᦲ᧝ute;䄇̀;abcdsᦿᧀᧄ᧊᧕᧙戩nd;橄rcup;橉Āau᧏᧒p;橋p;橇ot;橀;쀀∩︀Āeo᧢᧥t;恁îړȀaeiu᧰᧻ᨁᨅǰ᧵\\0᧸s;橍on;䄍dil耻ç䃧rc;䄉psĀ;sᨌᨍ橌m;橐ot;䄋ƀdmnᨛᨠᨦil肻¸ƭptyv;榲t脀¢;eᨭᨮ䂢räƲr;쀀𝔠ƀceiᨽᩀᩍy;䑇ckĀ;mᩇᩈ朓ark»ᩈ;䏇r΀;Ecefms᩟᩠ᩢᩫ᪤᪪᪮旋;槃ƀ;elᩩᩪᩭ䋆q;扗eɡᩴ\\0\\0᪈rrowĀlr᩼᪁eft;憺ight;憻ʀRSacd᪒᪔᪖᪚᪟»ཇ;擈st;抛irc;抚ash;抝nint;樐id;櫯cir;槂ubsĀ;u᪻᪼晣it»᪼ˬ᫇᫔᫺\\0ᬊonĀ;eᫍᫎ䀺Ā;qÇÆɭ᫙\\0\\0᫢aĀ;t᫞᫟䀬;䁀ƀ;fl᫨᫩᫫戁îᅠeĀmx᫱᫶ent»᫩eóɍǧ᫾\\0ᬇĀ;dኻᬂot;橭nôɆƀfryᬐᬔᬗ;쀀𝕔oäɔ脀©;sŕᬝr;愗Āaoᬥᬩrr;憵ss;朗Ācuᬲᬷr;쀀𝒸Ābpᬼ᭄Ā;eᭁᭂ櫏;櫑Ā;eᭉᭊ櫐;櫒dot;拯΀delprvw᭠᭬᭷ᮂᮬᯔ᯹arrĀlr᭨᭪;椸;椵ɰ᭲\\0\\0᭵r;拞c;拟arrĀ;p᭿ᮀ憶;椽̀;bcdosᮏᮐᮖᮡᮥᮨ截rcap;橈Āauᮛᮞp;橆p;橊ot;抍r;橅;쀀∪︀Ȁalrv᮵ᮿᯞᯣrrĀ;mᮼᮽ憷;椼yƀevwᯇᯔᯘqɰᯎ\\0\\0ᯒreã᭳uã᭵ee;拎edge;拏en耻¤䂤earrowĀlrᯮ᯳eft»ᮀight»ᮽeäᯝĀciᰁᰇoninôǷnt;戱lcty;挭ঀAHabcdefhijlorstuwz᰸᰻᰿ᱝᱩᱵᲊᲞᲬᲷ᳻᳿ᴍᵻᶑᶫᶻ᷆᷍rò΁ar;楥Ȁglrs᱈ᱍ᱒᱔ger;怠eth;愸òᄳhĀ;vᱚᱛ怐»ऊūᱡᱧarow;椏aã̕Āayᱮᱳron;䄏;䐴ƀ;ao̲ᱼᲄĀgrʿᲁr;懊tseq;橷ƀglmᲑᲔᲘ耻°䂰ta;䎴ptyv;榱ĀirᲣᲨsht;楿;쀀𝔡arĀlrᲳᲵ»ࣜ»သʀaegsv᳂͸᳖᳜᳠mƀ;oș᳊᳔ndĀ;ș᳑uit;晦amma;䏝in;拲ƀ;io᳧᳨᳸䃷de脀÷;o᳧ᳰntimes;拇nø᳷cy;䑒cɯᴆ\\0\\0ᴊrn;挞op;挍ʀlptuwᴘᴝᴢᵉᵕlar;䀤f;쀀𝕕ʀ;emps̋ᴭᴷᴽᵂqĀ;d͒ᴳot;扑inus;戸lus;戔quare;抡blebarwedgåúnƀadhᄮᵝᵧownarrowóᲃarpoonĀlrᵲᵶefôᲴighôᲶŢᵿᶅkaro÷གɯᶊ\\0\\0ᶎrn;挟op;挌ƀcotᶘᶣᶦĀryᶝᶡ;쀀𝒹;䑕l;槶rok;䄑Ādrᶰᶴot;拱iĀ;fᶺ᠖斿Āah᷀᷃ròЩaòྦangle;榦Āci᷒ᷕy;䑟grarr;柿ऀDacdefglmnopqrstuxḁḉḙḸոḼṉṡṾấắẽỡἪἷὄ὎὚ĀDoḆᴴoôᲉĀcsḎḔute耻é䃩ter;橮ȀaioyḢḧḱḶron;䄛rĀ;cḭḮ扖耻ê䃪lon;払;䑍ot;䄗ĀDrṁṅot;扒;쀀𝔢ƀ;rsṐṑṗ檚ave耻è䃨Ā;dṜṝ檖ot;檘Ȁ;ilsṪṫṲṴ檙nters;揧;愓Ā;dṹṺ檕ot;檗ƀapsẅẉẗcr;䄓tyƀ;svẒẓẕ戅et»ẓpĀ1;ẝẤĳạả;怄;怅怃ĀgsẪẬ;䅋p;怂ĀgpẴẸon;䄙f;쀀𝕖ƀalsỄỎỒrĀ;sỊị拕l;槣us;橱iƀ;lvỚớở䎵on»ớ;䏵ȀcsuvỪỳἋἣĀioữḱrc»Ḯɩỹ\\0\\0ỻíՈantĀglἂἆtr»ṝess»Ṻƀaeiἒ἖Ἒls;䀽st;扟vĀ;DȵἠD;橸parsl;槥ĀDaἯἳot;打rr;楱ƀcdiἾὁỸr;愯oô͒ĀahὉὋ;䎷耻ð䃰Āmrὓὗl耻ë䃫o;悬ƀcipὡὤὧl;䀡sôծĀeoὬὴctatioîՙnentialåչৡᾒ\\0ᾞ\\0ᾡᾧ\\0\\0ῆῌ\\0ΐ\\0ῦῪ \\0 ⁚llingdotseñṄy;䑄male;晀ƀilrᾭᾳ῁lig;耀ﬃɩᾹ\\0\\0᾽g;耀ﬀig;耀ﬄ;쀀𝔣lig;耀ﬁlig;쀀fjƀaltῙ῜ῡt;晭ig;耀ﬂns;斱of;䆒ǰ΅\\0ῳf;쀀𝕗ĀakֿῷĀ;vῼ´拔;櫙artint;樍Āao‌⁕Ācs‑⁒α‚‰‸⁅⁈\\0⁐β•‥‧‪‬\\0‮耻½䂽;慓耻¼䂼;慕;慙;慛Ƴ‴\\0‶;慔;慖ʴ‾⁁\\0\\0⁃耻¾䂾;慗;慜5;慘ƶ⁌\\0⁎;慚;慝8;慞l;恄wn;挢cr;쀀𝒻ࢀEabcdefgijlnorstv₂₉₟₥₰₴⃰⃵⃺⃿℃ℒℸ̗ℾ⅒↞Ā;lٍ₇;檌ƀcmpₐₕ₝ute;䇵maĀ;dₜ᳚䎳;檆reve;䄟Āiy₪₮rc;䄝;䐳ot;䄡Ȁ;lqsؾق₽⃉ƀ;qsؾٌ⃄lanô٥Ȁ;cdl٥⃒⃥⃕c;檩otĀ;o⃜⃝檀Ā;l⃢⃣檂;檄Ā;e⃪⃭쀀⋛︀s;檔r;쀀𝔤Ā;gٳ؛mel;愷cy;䑓Ȁ;Eajٚℌℎℐ;檒;檥;檤ȀEaesℛℝ℩ℴ;扩pĀ;p℣ℤ檊rox»ℤĀ;q℮ℯ檈Ā;q℮ℛim;拧pf;쀀𝕘Āci⅃ⅆr;愊mƀ;el٫ⅎ⅐;檎;檐茀>;cdlqr׮ⅠⅪⅮⅳⅹĀciⅥⅧ;檧r;橺ot;拗Par;榕uest;橼ʀadelsↄⅪ←ٖ↛ǰ↉\\0↎proø₞r;楸qĀlqؿ↖lesó₈ií٫Āen↣↭rtneqq;쀀≩︀Å↪ԀAabcefkosy⇄⇇⇱⇵⇺∘∝∯≨≽ròΠȀilmr⇐⇔⇗⇛rsðᒄf»․ilôکĀdr⇠⇤cy;䑊ƀ;cwࣴ⇫⇯ir;楈;憭ar;意irc;䄥ƀalr∁∎∓rtsĀ;u∉∊晥it»∊lip;怦con;抹r;쀀𝔥sĀew∣∩arow;椥arow;椦ʀamopr∺∾≃≞≣rr;懿tht;戻kĀlr≉≓eftarrow;憩ightarrow;憪f;쀀𝕙bar;怕ƀclt≯≴≸r;쀀𝒽asè⇴rok;䄧Ābp⊂⊇ull;恃hen»ᱛૡ⊣\\0⊪\\0⊸⋅⋎\\0⋕⋳\\0\\0⋸⌢⍧⍢⍿\\0⎆⎪⎴cute耻í䃭ƀ;iyݱ⊰⊵rc耻î䃮;䐸Ācx⊼⊿y;䐵cl耻¡䂡ĀfrΟ⋉;쀀𝔦rave耻ì䃬Ȁ;inoܾ⋝⋩⋮Āin⋢⋦nt;樌t;戭fin;槜ta;愩lig;䄳ƀaop⋾⌚⌝ƀcgt⌅⌈⌗r;䄫ƀelpܟ⌏⌓inåގarôܠh;䄱f;抷ed;䆵ʀ;cfotӴ⌬⌱⌽⍁are;愅inĀ;t⌸⌹戞ie;槝doô⌙ʀ;celpݗ⍌⍐⍛⍡al;抺Āgr⍕⍙eróᕣã⍍arhk;樗rod;樼Ȁcgpt⍯⍲⍶⍻y;䑑on;䄯f;쀀𝕚a;䎹uest耻¿䂿Āci⎊⎏r;쀀𝒾nʀ;EdsvӴ⎛⎝⎡ӳ;拹ot;拵Ā;v⎦⎧拴;拳Ā;iݷ⎮lde;䄩ǫ⎸\\0⎼cy;䑖l耻ï䃯̀cfmosu⏌⏗⏜⏡⏧⏵Āiy⏑⏕rc;䄵;䐹r;쀀𝔧ath;䈷pf;쀀𝕛ǣ⏬\\0⏱r;쀀𝒿rcy;䑘kcy;䑔Ѐacfghjos␋␖␢␧␭␱␵␻ppaĀ;v␓␔䎺;䏰Āey␛␠dil;䄷;䐺r;쀀𝔨reen;䄸cy;䑅cy;䑜pf;쀀𝕜cr;쀀𝓀஀ABEHabcdefghjlmnoprstuv⑰⒁⒆⒍⒑┎┽╚▀♎♞♥♹♽⚚⚲⛘❝❨➋⟀⠁⠒ƀart⑷⑺⑼rò৆òΕail;椛arr;椎Ā;gঔ⒋;檋ar;楢ॣ⒥\\0⒪\\0⒱\\0\\0\\0\\0\\0⒵Ⓔ\\0ⓆⓈⓍ\\0⓹ute;䄺mptyv;榴raîࡌbda;䎻gƀ;dlࢎⓁⓃ;榑åࢎ;檅uo耻«䂫rЀ;bfhlpst࢙ⓞⓦⓩ⓫⓮⓱⓵Ā;f࢝ⓣs;椟s;椝ë≒p;憫l;椹im;楳l;憢ƀ;ae⓿─┄檫il;椙Ā;s┉┊檭;쀀⪭︀ƀabr┕┙┝rr;椌rk;杲Āak┢┬cĀek┨┪;䁻;䁛Āes┱┳;榋lĀdu┹┻;榏;榍Ȁaeuy╆╋╖╘ron;䄾Ādi═╔il;䄼ìࢰâ┩;䐻Ȁcqrs╣╦╭╽a;椶uoĀ;rนᝆĀdu╲╷har;楧shar;楋h;憲ʀ;fgqs▋▌উ◳◿扤tʀahlrt▘▤▷◂◨rrowĀ;t࢙□aé⓶arpoonĀdu▯▴own»њp»०eftarrows;懇ightƀahs◍◖◞rrowĀ;sࣴࢧarpoonó྘quigarro÷⇰hreetimes;拋ƀ;qs▋ও◺lanôবʀ;cdgsব☊☍☝☨c;檨otĀ;o☔☕橿Ā;r☚☛檁;檃Ā;e☢☥쀀⋚︀s;檓ʀadegs☳☹☽♉♋pproøⓆot;拖qĀgq♃♅ôউgtò⒌ôছiíলƀilr♕࣡♚sht;楼;쀀𝔩Ā;Eজ♣;檑š♩♶rĀdu▲♮Ā;l॥♳;楪lk;斄cy;䑙ʀ;achtੈ⚈⚋⚑⚖rò◁orneòᴈard;楫ri;旺Āio⚟⚤dot;䅀ustĀ;a⚬⚭掰che»⚭ȀEaes⚻⚽⛉⛔;扨pĀ;p⛃⛄檉rox»⛄Ā;q⛎⛏檇Ā;q⛎⚻im;拦Ѐabnoptwz⛩⛴⛷✚✯❁❇❐Ānr⛮⛱g;柬r;懽rëࣁgƀlmr⛿✍✔eftĀar০✇ightá৲apsto;柼ightá৽parrowĀlr✥✩efô⓭ight;憬ƀafl✶✹✽r;榅;쀀𝕝us;樭imes;樴š❋❏st;戗áፎƀ;ef❗❘᠀旊nge»❘arĀ;l❤❥䀨t;榓ʀachmt❳❶❼➅➇ròࢨorneòᶌarĀ;d྘➃;業;怎ri;抿̀achiqt➘➝ੀ➢➮➻quo;怹r;쀀𝓁mƀ;egল➪➬;檍;檏Ābu┪➳oĀ;rฟ➹;怚rok;䅂萀<;cdhilqrࠫ⟒☹⟜⟠⟥⟪⟰Āci⟗⟙;檦r;橹reå◲mes;拉arr;楶uest;橻ĀPi⟵⟹ar;榖ƀ;ef⠀भ᠛旃rĀdu⠇⠍shar;楊har;楦Āen⠗⠡rtneqq;쀀≨︀Å⠞܀Dacdefhilnopsu⡀⡅⢂⢎⢓⢠⢥⢨⣚⣢⣤ઃ⣳⤂Dot;戺Ȁclpr⡎⡒⡣⡽r耻¯䂯Āet⡗⡙;時Ā;e⡞⡟朠se»⡟Ā;sျ⡨toȀ;dluျ⡳⡷⡻owîҌefôएðᏑker;斮Āoy⢇⢌mma;権;䐼ash;怔asuredangle»ᘦr;쀀𝔪o;愧ƀcdn⢯⢴⣉ro耻µ䂵Ȁ;acdᑤ⢽⣀⣄sôᚧir;櫰ot肻·Ƶusƀ;bd⣒ᤃ⣓戒Ā;uᴼ⣘;横ţ⣞⣡p;櫛ò−ðઁĀdp⣩⣮els;抧f;쀀𝕞Āct⣸⣽r;쀀𝓂pos»ᖝƀ;lm⤉⤊⤍䎼timap;抸ఀGLRVabcdefghijlmoprstuvw⥂⥓⥾⦉⦘⧚⧩⨕⨚⩘⩝⪃⪕⪤⪨⬄⬇⭄⭿⮮ⰴⱧⱼ⳩Āgt⥇⥋;쀀⋙̸Ā;v⥐௏쀀≫⃒ƀelt⥚⥲⥶ftĀar⥡⥧rrow;懍ightarrow;懎;쀀⋘̸Ā;v⥻ే쀀≪⃒ightarrow;懏ĀDd⦎⦓ash;抯ash;抮ʀbcnpt⦣⦧⦬⦱⧌la»˞ute;䅄g;쀀∠⃒ʀ;Eiop඄⦼⧀⧅⧈;쀀⩰̸d;쀀≋̸s;䅉roø඄urĀ;a⧓⧔普lĀ;s⧓ସǳ⧟\\0⧣p肻 ଷmpĀ;e௹ఀʀaeouy⧴⧾⨃⨐⨓ǰ⧹\\0⧻;橃on;䅈dil;䅆ngĀ;dൾ⨊ot;쀀⩭̸p;橂;䐽ash;怓΀;Aadqsxஒ⨩⨭⨻⩁⩅⩐rr;懗rĀhr⨳⨶k;椤Ā;oᏲᏰot;쀀≐̸uiöୣĀei⩊⩎ar;椨í஘istĀ;s஠டr;쀀𝔫ȀEest௅⩦⩹⩼ƀ;qs஼⩭௡ƀ;qs஼௅⩴lanô௢ií௪Ā;rஶ⪁»ஷƀAap⪊⪍⪑rò⥱rr;憮ar;櫲ƀ;svྍ⪜ྌĀ;d⪡⪢拼;拺cy;䑚΀AEadest⪷⪺⪾⫂⫅⫶⫹rò⥦;쀀≦̸rr;憚r;急Ȁ;fqs఻⫎⫣⫯tĀar⫔⫙rro÷⫁ightarro÷⪐ƀ;qs఻⪺⫪lanôౕĀ;sౕ⫴»శiíౝĀ;rవ⫾iĀ;eచథiäඐĀpt⬌⬑f;쀀𝕟膀¬;in⬙⬚⬶䂬nȀ;Edvஉ⬤⬨⬮;쀀⋹̸ot;쀀⋵̸ǡஉ⬳⬵;拷;拶iĀ;vಸ⬼ǡಸ⭁⭃;拾;拽ƀaor⭋⭣⭩rȀ;ast୻⭕⭚⭟lleì୻l;쀀⫽⃥;쀀∂̸lint;樔ƀ;ceಒ⭰⭳uåಥĀ;cಘ⭸Ā;eಒ⭽ñಘȀAait⮈⮋⮝⮧rò⦈rrƀ;cw⮔⮕⮙憛;쀀⤳̸;쀀↝̸ghtarrow»⮕riĀ;eೋೖ΀chimpqu⮽⯍⯙⬄୸⯤⯯Ȁ;cerല⯆ഷ⯉uå൅;쀀𝓃ortɭ⬅\\0\\0⯖ará⭖mĀ;e൮⯟Ā;q൴൳suĀbp⯫⯭å೸åഋƀbcp⯶ⰑⰙȀ;Ees⯿ⰀഢⰄ抄;쀀⫅̸etĀ;eഛⰋqĀ;qണⰀcĀ;eലⰗñസȀ;EesⰢⰣൟⰧ抅;쀀⫆̸etĀ;e൘ⰮqĀ;qൠⰣȀgilrⰽⰿⱅⱇìௗlde耻ñ䃱çృiangleĀlrⱒⱜeftĀ;eచⱚñదightĀ;eೋⱥñ೗Ā;mⱬⱭ䎽ƀ;esⱴⱵⱹ䀣ro;愖p;怇ҀDHadgilrsⲏⲔⲙⲞⲣⲰⲶⳓⳣash;抭arr;椄p;쀀≍⃒ash;抬ĀetⲨⲬ;쀀≥⃒;쀀>⃒nfin;槞ƀAetⲽⳁⳅrr;椂;쀀≤⃒Ā;rⳊⳍ쀀<⃒ie;쀀⊴⃒ĀAtⳘⳜrr;椃rie;쀀⊵⃒im;쀀∼⃒ƀAan⳰⳴ⴂrr;懖rĀhr⳺⳽k;椣Ā;oᏧᏥear;椧ቓ᪕\\0\\0\\0\\0\\0\\0\\0\\0\\0\\0\\0\\0\\0ⴭ\\0ⴸⵈⵠⵥ⵲ⶄᬇ\\0\\0ⶍⶫ\\0ⷈⷎ\\0ⷜ⸙⸫⸾⹃Ācsⴱ᪗ute耻ó䃳ĀiyⴼⵅrĀ;c᪞ⵂ耻ô䃴;䐾ʀabios᪠ⵒⵗǈⵚlac;䅑v;樸old;榼lig;䅓Ācr⵩⵭ir;榿;쀀𝔬ͯ⵹\\0\\0⵼\\0ⶂn;䋛ave耻ò䃲;槁Ābmⶈ෴ar;榵Ȁacitⶕ⶘ⶥⶨrò᪀Āir⶝ⶠr;榾oss;榻nå๒;槀ƀaeiⶱⶵⶹcr;䅍ga;䏉ƀcdnⷀⷅǍron;䎿;榶pf;쀀𝕠ƀaelⷔ⷗ǒr;榷rp;榹΀;adiosvⷪⷫⷮ⸈⸍⸐⸖戨rò᪆Ȁ;efmⷷⷸ⸂⸅橝rĀ;oⷾⷿ愴f»ⷿ耻ª䂪耻º䂺gof;抶r;橖lope;橗;橛ƀclo⸟⸡⸧ò⸁ash耻ø䃸l;折iŬⸯ⸴de耻õ䃵esĀ;aǛ⸺s;樶ml耻ö䃶bar;挽ૡ⹞\\0⹽\\0⺀⺝\\0⺢⺹\\0\\0⻋ຜ\\0⼓\\0\\0⼫⾼\\0⿈rȀ;astЃ⹧⹲຅脀¶;l⹭⹮䂶leìЃɩ⹸\\0\\0⹻m;櫳;櫽y;䐿rʀcimpt⺋⺏⺓ᡥ⺗nt;䀥od;䀮il;怰enk;怱r;쀀𝔭ƀimo⺨⺰⺴Ā;v⺭⺮䏆;䏕maô੶ne;明ƀ;tv⺿⻀⻈䏀chfork»´;䏖Āau⻏⻟nĀck⻕⻝kĀ;h⇴⻛;愎ö⇴sҀ;abcdemst⻳⻴ᤈ⻹⻽⼄⼆⼊⼎䀫cir;樣ir;樢Āouᵀ⼂;樥;橲n肻±ຝim;樦wo;樧ƀipu⼙⼠⼥ntint;樕f;쀀𝕡nd耻£䂣Ԁ;Eaceinosu່⼿⽁⽄⽇⾁⾉⾒⽾⾶;檳p;檷uå໙Ā;c໎⽌̀;acens່⽙⽟⽦⽨⽾pproø⽃urlyeñ໙ñ໎ƀaes⽯⽶⽺pprox;檹qq;檵im;拨iíໟmeĀ;s⾈ຮ怲ƀEas⽸⾐⽺ð⽵ƀdfp໬⾙⾯ƀals⾠⾥⾪lar;挮ine;挒urf;挓Ā;t໻⾴ï໻rel;抰Āci⿀⿅r;쀀𝓅;䏈ncsp;怈̀fiopsu⿚⋢⿟⿥⿫⿱r;쀀𝔮pf;쀀𝕢rime;恗cr;쀀𝓆ƀaeo⿸〉〓tĀei⿾々rnionóڰnt;樖stĀ;e【】䀿ñἙô༔઀ABHabcdefhilmnoprstux぀けさすムㄎㄫㅇㅢㅲㆎ㈆㈕㈤㈩㉘㉮㉲㊐㊰㊷ƀartぇおがròႳòϝail;検aròᱥar;楤΀cdenqrtとふへみわゔヌĀeuねぱ;쀀∽̱te;䅕iãᅮmptyv;榳gȀ;del࿑らるろ;榒;榥å࿑uo耻»䂻rր;abcfhlpstw࿜ガクシスゼゾダッデナp;極Ā;f࿠ゴs;椠;椳s;椞ë≝ð✮l;楅im;楴l;憣;憝Āaiパフil;椚oĀ;nホボ戶aló༞ƀabrョリヮrò៥rk;杳ĀakンヽcĀekヹ・;䁽;䁝Āes㄂㄄;榌lĀduㄊㄌ;榎;榐Ȁaeuyㄗㄜㄧㄩron;䅙Ādiㄡㄥil;䅗ì࿲âヺ;䑀Ȁclqsㄴㄷㄽㅄa;椷dhar;楩uoĀ;rȎȍh;憳ƀacgㅎㅟངlȀ;ipsླྀㅘㅛႜnåႻarôྩt;断ƀilrㅩဣㅮsht;楽;쀀𝔯ĀaoㅷㆆrĀduㅽㅿ»ѻĀ;l႑ㆄ;楬Ā;vㆋㆌ䏁;䏱ƀgns㆕ㇹㇼht̀ahlrstㆤㆰ㇂㇘㇤㇮rrowĀ;t࿜ㆭaéトarpoonĀduㆻㆿowîㅾp»႒eftĀah㇊㇐rrowó࿪arpoonóՑightarrows;應quigarro÷ニhreetimes;拌g;䋚ingdotseñἲƀahm㈍㈐㈓rò࿪aòՑ;怏oustĀ;a㈞㈟掱che»㈟mid;櫮Ȁabpt㈲㈽㉀㉒Ānr㈷㈺g;柭r;懾rëဃƀafl㉇㉊㉎r;榆;쀀𝕣us;樮imes;樵Āap㉝㉧rĀ;g㉣㉤䀩t;榔olint;樒arò㇣Ȁachq㉻㊀Ⴜ㊅quo;怺r;쀀𝓇Ābu・㊊oĀ;rȔȓƀhir㊗㊛㊠reåㇸmes;拊iȀ;efl㊪ၙᠡ㊫方tri;槎luhar;楨;愞ൡ㋕㋛㋟㌬㌸㍱\\0㍺㎤\\0\\0㏬㏰\\0㐨㑈㑚㒭㒱㓊㓱\\0㘖\\0\\0㘳cute;䅛quï➺Ԁ;Eaceinpsyᇭ㋳㋵㋿㌂㌋㌏㌟㌦㌩;檴ǰ㋺\\0㋼;檸on;䅡uåᇾĀ;dᇳ㌇il;䅟rc;䅝ƀEas㌖㌘㌛;檶p;檺im;择olint;樓iíሄ;䑁otƀ;be㌴ᵇ㌵担;橦΀Aacmstx㍆㍊㍗㍛㍞㍣㍭rr;懘rĀhr㍐㍒ë∨Ā;oਸ਼਴t耻§䂧i;䀻war;椩mĀin㍩ðnuóñt;朶rĀ;o㍶⁕쀀𝔰Ȁacoy㎂㎆㎑㎠rp;景Āhy㎋㎏cy;䑉;䑈rtɭ㎙\\0\\0㎜iäᑤaraì⹯耻­䂭Āgm㎨㎴maƀ;fv㎱㎲㎲䏃;䏂Ѐ;deglnprካ㏅㏉㏎㏖㏞㏡㏦ot;橪Ā;q኱ኰĀ;E㏓㏔檞;檠Ā;E㏛㏜檝;檟e;扆lus;樤arr;楲aròᄽȀaeit㏸㐈㐏㐗Āls㏽㐄lsetmé㍪hp;樳parsl;槤Ādlᑣ㐔e;挣Ā;e㐜㐝檪Ā;s㐢㐣檬;쀀⪬︀ƀflp㐮㐳㑂tcy;䑌Ā;b㐸㐹䀯Ā;a㐾㐿槄r;挿f;쀀𝕤aĀdr㑍ЂesĀ;u㑔㑕晠it»㑕ƀcsu㑠㑹㒟Āau㑥㑯pĀ;sᆈ㑫;쀀⊓︀pĀ;sᆴ㑵;쀀⊔︀uĀbp㑿㒏ƀ;esᆗᆜ㒆etĀ;eᆗ㒍ñᆝƀ;esᆨᆭ㒖etĀ;eᆨ㒝ñᆮƀ;afᅻ㒦ְrť㒫ֱ»ᅼaròᅈȀcemt㒹㒾㓂㓅r;쀀𝓈tmîñiì㐕aræᆾĀar㓎㓕rĀ;f㓔ឿ昆Āan㓚㓭ightĀep㓣㓪psiloîỠhé⺯s»⡒ʀbcmnp㓻㕞ሉ㖋㖎Ҁ;Edemnprs㔎㔏㔑㔕㔞㔣㔬㔱㔶抂;櫅ot;檽Ā;dᇚ㔚ot;櫃ult;櫁ĀEe㔨㔪;櫋;把lus;檿arr;楹ƀeiu㔽㕒㕕tƀ;en㔎㕅㕋qĀ;qᇚ㔏eqĀ;q㔫㔨m;櫇Ābp㕚㕜;櫕;櫓c̀;acensᇭ㕬㕲㕹㕻㌦pproø㋺urlyeñᇾñᇳƀaes㖂㖈㌛pproø㌚qñ㌗g;晪ڀ123;Edehlmnps㖩㖬㖯ሜ㖲㖴㗀㗉㗕㗚㗟㗨㗭耻¹䂹耻²䂲耻³䂳;櫆Āos㖹㖼t;檾ub;櫘Ā;dሢ㗅ot;櫄sĀou㗏㗒l;柉b;櫗arr;楻ult;櫂ĀEe㗤㗦;櫌;抋lus;櫀ƀeiu㗴㘉㘌tƀ;enሜ㗼㘂qĀ;qሢ㖲eqĀ;q㗧㗤m;櫈Ābp㘑㘓;櫔;櫖ƀAan㘜㘠㘭rr;懙rĀhr㘦㘨ë∮Ā;oਫ਩war;椪lig耻ß䃟௡㙑㙝㙠ዎ㙳㙹\\0㙾㛂\\0\\0\\0\\0\\0㛛㜃\\0㜉㝬\\0\\0\\0㞇ɲ㙖\\0\\0㙛get;挖;䏄rë๟ƀaey㙦㙫㙰ron;䅥dil;䅣;䑂lrec;挕r;쀀𝔱Ȁeiko㚆㚝㚵㚼ǲ㚋\\0㚑eĀ4fኄኁaƀ;sv㚘㚙㚛䎸ym;䏑Ācn㚢㚲kĀas㚨㚮pproø዁im»ኬsðኞĀas㚺㚮ð዁rn耻þ䃾Ǭ̟㛆⋧es膀×;bd㛏㛐㛘䃗Ā;aᤏ㛕r;樱;樰ƀeps㛡㛣㜀á⩍Ȁ;bcf҆㛬㛰㛴ot;挶ir;櫱Ā;o㛹㛼쀀𝕥rk;櫚á㍢rime;怴ƀaip㜏㜒㝤dåቈ΀adempst㜡㝍㝀㝑㝗㝜㝟ngleʀ;dlqr㜰㜱㜶㝀㝂斵own»ᶻeftĀ;e⠀㜾ñम;扜ightĀ;e㊪㝋ñၚot;旬inus;樺lus;樹b;槍ime;樻ezium;揢ƀcht㝲㝽㞁Āry㝷㝻;쀀𝓉;䑆cy;䑛rok;䅧Āio㞋㞎xô᝷headĀlr㞗㞠eftarro÷ࡏightarrow»ཝऀAHabcdfghlmoprstuw㟐㟓㟗㟤㟰㟼㠎㠜㠣㠴㡑㡝㡫㢩㣌㣒㣪㣶ròϭar;楣Ācr㟜㟢ute耻ú䃺òᅐrǣ㟪\\0㟭y;䑞ve;䅭Āiy㟵㟺rc耻û䃻;䑃ƀabh㠃㠆㠋ròᎭlac;䅱aòᏃĀir㠓㠘sht;楾;쀀𝔲rave耻ù䃹š㠧㠱rĀlr㠬㠮»ॗ»ႃlk;斀Āct㠹㡍ɯ㠿\\0\\0㡊rnĀ;e㡅㡆挜r»㡆op;挏ri;旸Āal㡖㡚cr;䅫肻¨͉Āgp㡢㡦on;䅳f;쀀𝕦̀adhlsuᅋ㡸㡽፲㢑㢠ownáᎳarpoonĀlr㢈㢌efô㠭ighô㠯iƀ;hl㢙㢚㢜䏅»ᏺon»㢚parrows;懈ƀcit㢰㣄㣈ɯ㢶\\0\\0㣁rnĀ;e㢼㢽挝r»㢽op;挎ng;䅯ri;旹cr;쀀𝓊ƀdir㣙㣝㣢ot;拰lde;䅩iĀ;f㜰㣨»᠓Āam㣯㣲rò㢨l耻ü䃼angle;榧ހABDacdeflnoprsz㤜㤟㤩㤭㦵㦸㦽㧟㧤㧨㧳㧹㧽㨁㨠ròϷarĀ;v㤦㤧櫨;櫩asèϡĀnr㤲㤷grt;榜΀eknprst㓣㥆㥋㥒㥝㥤㦖appá␕othinçẖƀhir㓫⻈㥙opô⾵Ā;hᎷ㥢ïㆍĀiu㥩㥭gmá㎳Ābp㥲㦄setneqĀ;q㥽㦀쀀⊊︀;쀀⫋︀setneqĀ;q㦏㦒쀀⊋︀;쀀⫌︀Āhr㦛㦟etá㚜iangleĀlr㦪㦯eft»थight»ၑy;䐲ash»ံƀelr㧄㧒㧗ƀ;beⷪ㧋㧏ar;抻q;扚lip;拮Ābt㧜ᑨaòᑩr;쀀𝔳tré㦮suĀbp㧯㧱»ജ»൙pf;쀀𝕧roð໻tré㦴Ācu㨆㨋r;쀀𝓋Ābp㨐㨘nĀEe㦀㨖»㥾nĀEe㦒㨞»㦐igzag;榚΀cefoprs㨶㨻㩖㩛㩔㩡㩪irc;䅵Ādi㩀㩑Ābg㩅㩉ar;機eĀ;qᗺ㩏;扙erp;愘r;쀀𝔴pf;쀀𝕨Ā;eᑹ㩦atèᑹcr;쀀𝓌ૣណ㪇\\0㪋\\0㪐㪛\\0\\0㪝㪨㪫㪯\\0\\0㫃㫎\\0㫘ៜ៟tré៑r;쀀𝔵ĀAa㪔㪗ròσrò৶;䎾ĀAa㪡㪤ròθrò৫að✓is;拻ƀdptឤ㪵㪾Āfl㪺ឩ;쀀𝕩imåឲĀAa㫇㫊ròώròਁĀcq㫒ីr;쀀𝓍Āpt៖㫜ré។Ѐacefiosu㫰㫽㬈㬌㬑㬕㬛㬡cĀuy㫶㫻te耻ý䃽;䑏Āiy㬂㬆rc;䅷;䑋n耻¥䂥r;쀀𝔶cy;䑗pf;쀀𝕪cr;쀀𝓎Ācm㬦㬩y;䑎l耻ÿ䃿Ԁacdefhiosw㭂㭈㭔㭘㭤㭩㭭㭴㭺㮀cute;䅺Āay㭍㭒ron;䅾;䐷ot;䅼Āet㭝㭡træᕟa;䎶r;쀀𝔷cy;䐶grarr;懝pf;쀀𝕫cr;쀀𝓏Ājn㮅㮇;怍j;怌\'.split("").map(e=>e.charCodeAt(0)))});var ao=R(En=>{"use strict";Object.defineProperty(En,"__esModule",{value:!0});En.xmlDecodeTree=void 0;En.xmlDecodeTree=new Uint16Array("Ȁaglq	\\x1Bɭ\\0\\0p;䀦os;䀧t;䀾t;䀼uot;䀢".split("").map(e=>e.charCodeAt(0)))});var io=R(Iu=>{"use strict";var no;Object.defineProperty(Iu,"__esModule",{value:!0});Iu.fromCodePoint=void 0;Iu.replaceCodePoint=Rd;Iu.decodeCodePoint=kx;var Fx=new Map([[0,65533],[128,8364],[130,8218],[131,402],[132,8222],[133,8230],[134,8224],[135,8225],[136,710],[137,8240],[138,352],[139,8249],[140,338],[142,381],[145,8216],[146,8217],[147,8220],[148,8221],[149,8226],[150,8211],[151,8212],[152,732],[153,8482],[154,353],[155,8250],[156,339],[158,382],[159,376]]);Iu.fromCodePoint=(no=String.fromCodePoint)!==null&&no!==void 0?no:function(e){let t="";return e>65535&&(e-=65536,t+=String.fromCharCode(e>>>10&1023|55296),e=56320|e&1023),t+=String.fromCharCode(e),t};function Rd(e){var t;return e>=55296&&e<=57343||e>1114111?65533:(t=Fx.get(e))!==null&&t!==void 0?t:e}function kx(e){return(0,Iu.fromCodePoint)(Rd(e))}});var Ld=R(He=>{"use strict";Object.defineProperty(He,"__esModule",{value:!0});He.fromCodePoint=He.replaceCodePoint=He.decodeCodePoint=He.xmlDecodeTree=He.htmlDecodeTree=He.EntityDecoder=He.DecodingMode=He.BinTrieFlags=void 0;He.determineBranch=wd;He.decodeHTML=Wx;He.decodeHTMLAttribute=Vx;He.decodeHTMLStrict=Qx;He.decodeXML=Xx;var Hx=uo(),Ux=ao(),Pd=io(),Je;(function(e){e[e.NUM=35]="NUM",e[e.SEMI=59]="SEMI",e[e.EQUALS=61]="EQUALS",e[e.ZERO=48]="ZERO",e[e.NINE=57]="NINE",e[e.LOWER_A=97]="LOWER_A",e[e.LOWER_F=102]="LOWER_F",e[e.LOWER_X=120]="LOWER_X",e[e.LOWER_Z=122]="LOWER_Z",e[e.UPPER_A=65]="UPPER_A",e[e.UPPER_F=70]="UPPER_F",e[e.UPPER_Z=90]="UPPER_Z"})(Je||(Je={}));var Gx=32,Jr;(function(e){e[e.VALUE_LENGTH=49152]="VALUE_LENGTH",e[e.BRANCH_LENGTH=16256]="BRANCH_LENGTH",e[e.JUMP_TABLE=127]="JUMP_TABLE"})(Jr||(He.BinTrieFlags=Jr={}));function so(e){return e>=Je.ZERO&&e<=Je.NINE}function qx(e){return e>=Je.UPPER_A&&e<=Je.UPPER_F||e>=Je.LOWER_A&&e<=Je.LOWER_F}function jx(e){return e>=Je.UPPER_A&&e<=Je.UPPER_Z||e>=Je.LOWER_A&&e<=Je.LOWER_Z||so(e)}function zx(e){return e===Je.EQUALS||jx(e)}var Ze;(function(e){e[e.EntityStart=0]="EntityStart",e[e.NumericStart=1]="NumericStart",e[e.NumericDecimal=2]="NumericDecimal",e[e.NumericHex=3]="NumericHex",e[e.NamedEntity=4]="NamedEntity"})(Ze||(Ze={}));var Xt;(function(e){e[e.Legacy=0]="Legacy",e[e.Strict=1]="Strict",e[e.Attribute=2]="Attribute"})(Xt||(He.DecodingMode=Xt={}));var Tn=class{constructor(t,r,u){this.decodeTree=t,this.emitCodePoint=r,this.errors=u,this.state=Ze.EntityStart,this.consumed=1,this.result=0,this.treeIndex=0,this.excess=1,this.decodeMode=Xt.Strict}startEntity(t){this.decodeMode=t,this.state=Ze.EntityStart,this.result=0,this.treeIndex=0,this.excess=1,this.consumed=1}write(t,r){switch(this.state){case Ze.EntityStart:return t.charCodeAt(r)===Je.NUM?(this.state=Ze.NumericStart,this.consumed+=1,this.stateNumericStart(t,r+1)):(this.state=Ze.NamedEntity,this.stateNamedEntity(t,r));case Ze.NumericStart:return this.stateNumericStart(t,r);case Ze.NumericDecimal:return this.stateNumericDecimal(t,r);case Ze.NumericHex:return this.stateNumericHex(t,r);case Ze.NamedEntity:return this.stateNamedEntity(t,r)}}stateNumericStart(t,r){return r>=t.length?-1:(t.charCodeAt(r)|Gx)===Je.LOWER_X?(this.state=Ze.NumericHex,this.consumed+=1,this.stateNumericHex(t,r+1)):(this.state=Ze.NumericDecimal,this.stateNumericDecimal(t,r))}addToNumericResult(t,r,u,a){if(r!==u){let n=u-r;this.result=this.result*Math.pow(a,n)+Number.parseInt(t.substr(r,n),a),this.consumed+=n}}stateNumericHex(t,r){let u=r;for(;r<t.length;){let a=t.charCodeAt(r);if(so(a)||qx(a))r+=1;else return this.addToNumericResult(t,u,r,16),this.emitNumericEntity(a,3)}return this.addToNumericResult(t,u,r,16),-1}stateNumericDecimal(t,r){let u=r;for(;r<t.length;){let a=t.charCodeAt(r);if(so(a))r+=1;else return this.addToNumericResult(t,u,r,10),this.emitNumericEntity(a,2)}return this.addToNumericResult(t,u,r,10),-1}emitNumericEntity(t,r){var u;if(this.consumed<=r)return(u=this.errors)===null||u===void 0||u.absenceOfDigitsInNumericCharacterReference(this.consumed),0;if(t===Je.SEMI)this.consumed+=1;else if(this.decodeMode===Xt.Strict)return 0;return this.emitCodePoint((0,Pd.replaceCodePoint)(this.result),this.consumed),this.errors&&(t!==Je.SEMI&&this.errors.missingSemicolonAfterCharacterReference(),this.errors.validateNumericCharacterReference(this.result)),this.consumed}stateNamedEntity(t,r){let{decodeTree:u}=this,a=u[this.treeIndex],n=(a&Jr.VALUE_LENGTH)>>14;for(;r<t.length;r++,this.excess++){let s=t.charCodeAt(r);if(this.treeIndex=wd(u,a,this.treeIndex+Math.max(1,n),s),this.treeIndex<0)return this.result===0||this.decodeMode===Xt.Attribute&&(n===0||zx(s))?0:this.emitNotTerminatedNamedEntity();if(a=u[this.treeIndex],n=(a&Jr.VALUE_LENGTH)>>14,n!==0){if(s===Je.SEMI)return this.emitNamedEntityData(this.treeIndex,n,this.consumed+this.excess);this.decodeMode!==Xt.Strict&&(this.result=this.treeIndex,this.consumed+=this.excess,this.excess=0)}}return-1}emitNotTerminatedNamedEntity(){var t;let{result:r,decodeTree:u}=this,a=(u[r]&Jr.VALUE_LENGTH)>>14;return this.emitNamedEntityData(r,a,this.consumed),(t=this.errors)===null||t===void 0||t.missingSemicolonAfterCharacterReference(),this.consumed}emitNamedEntityData(t,r,u){let{decodeTree:a}=this;return this.emitCodePoint(r===1?a[t]&~Jr.VALUE_LENGTH:a[t+1],u),r===3&&this.emitCodePoint(a[t+2],u),u}end(){var t;switch(this.state){case Ze.NamedEntity:return this.result!==0&&(this.decodeMode!==Xt.Attribute||this.result===this.treeIndex)?this.emitNotTerminatedNamedEntity():0;case Ze.NumericDecimal:return this.emitNumericEntity(0,2);case Ze.NumericHex:return this.emitNumericEntity(0,3);case Ze.NumericStart:return(t=this.errors)===null||t===void 0||t.absenceOfDigitsInNumericCharacterReference(this.consumed),0;case Ze.EntityStart:return 0}}};He.EntityDecoder=Tn;function Bd(e){let t="",r=new Tn(e,u=>t+=(0,Pd.fromCodePoint)(u));return function(a,n){let s=0,i=0;for(;(i=a.indexOf("&",i))>=0;){t+=a.slice(s,i),r.startEntity(n);let o=r.write(a,i+1);if(o<0){s=i+r.end();break}s=i+o,i=o===0?s+1:s}let c=t+a.slice(s);return t="",c}}function wd(e,t,r,u){let a=(t&Jr.BRANCH_LENGTH)>>7,n=t&Jr.JUMP_TABLE;if(a===0)return n!==0&&u===n?r:-1;if(n){let c=u-n;return c<0||c>=a?-1:e[r+c]-1}let s=r,i=s+a-1;for(;s<=i;){let c=s+i>>>1,o=e[c];if(o<u)s=c+1;else if(o>u)i=c-1;else return e[c+a]}return-1}var oo=Bd(Hx.htmlDecodeTree),Yx=Bd(Ux.xmlDecodeTree);function Wx(e,t=Xt.Legacy){return oo(e,t)}function Vx(e){return oo(e,Xt.Attribute)}function Qx(e){return oo(e,Xt.Strict)}function Xx(e){return Yx(e,Xt.Strict)}var Kx=uo();Object.defineProperty(He,"htmlDecodeTree",{enumerable:!0,get:function(){return Kx.htmlDecodeTree}});var $x=ao();Object.defineProperty(He,"xmlDecodeTree",{enumerable:!0,get:function(){return $x.xmlDecodeTree}});var co=io();Object.defineProperty(He,"decodeCodePoint",{enumerable:!0,get:function(){return co.decodeCodePoint}});Object.defineProperty(He,"replaceCodePoint",{enumerable:!0,get:function(){return co.replaceCodePoint}});Object.defineProperty(He,"fromCodePoint",{enumerable:!0,get:function(){return co.fromCodePoint}})});var Or=R(et=>{"use strict";Object.defineProperty(et,"__esModule",{value:!0});et.NUMBERED_HEADERS=et.SPECIAL_ELEMENTS=et.TAG_ID=et.TAG_NAMES=et.DOCUMENT_MODE=et.ATTRS=et.NS=void 0;et.getTagID=Jx;et.hasUnescapedText=t4;var eu;(function(e){e.HTML="http://www.w3.org/1999/xhtml",e.MATHML="http://www.w3.org/1998/Math/MathML",e.SVG="http://www.w3.org/2000/svg",e.XLINK="http://www.w3.org/1999/xlink",e.XML="http://www.w3.org/XML/1998/namespace",e.XMLNS="http://www.w3.org/2000/xmlns/"})(eu||(et.NS=eu={}));var Md;(function(e){e.TYPE="type",e.ACTION="action",e.ENCODING="encoding",e.PROMPT="prompt",e.NAME="name",e.COLOR="color",e.FACE="face",e.SIZE="size"})(Md||(et.ATTRS=Md={}));var Fd;(function(e){e.NO_QUIRKS="no-quirks",e.QUIRKS="quirks",e.LIMITED_QUIRKS="limited-quirks"})(Fd||(et.DOCUMENT_MODE=Fd={}));var q;(function(e){e.A="a",e.ADDRESS="address",e.ANNOTATION_XML="annotation-xml",e.APPLET="applet",e.AREA="area",e.ARTICLE="article",e.ASIDE="aside",e.B="b",e.BASE="base",e.BASEFONT="basefont",e.BGSOUND="bgsound",e.BIG="big",e.BLOCKQUOTE="blockquote",e.BODY="body",e.BR="br",e.BUTTON="button",e.CAPTION="caption",e.CENTER="center",e.CODE="code",e.COL="col",e.COLGROUP="colgroup",e.DD="dd",e.DESC="desc",e.DETAILS="details",e.DIALOG="dialog",e.DIR="dir",e.DIV="div",e.DL="dl",e.DT="dt",e.EM="em",e.EMBED="embed",e.FIELDSET="fieldset",e.FIGCAPTION="figcaption",e.FIGURE="figure",e.FONT="font",e.FOOTER="footer",e.FOREIGN_OBJECT="foreignObject",e.FORM="form",e.FRAME="frame",e.FRAMESET="frameset",e.H1="h1",e.H2="h2",e.H3="h3",e.H4="h4",e.H5="h5",e.H6="h6",e.HEAD="head",e.HEADER="header",e.HGROUP="hgroup",e.HR="hr",e.HTML="html",e.I="i",e.IMG="img",e.IMAGE="image",e.INPUT="input",e.IFRAME="iframe",e.KEYGEN="keygen",e.LABEL="label",e.LI="li",e.LINK="link",e.LISTING="listing",e.MAIN="main",e.MALIGNMARK="malignmark",e.MARQUEE="marquee",e.MATH="math",e.MENU="menu",e.META="meta",e.MGLYPH="mglyph",e.MI="mi",e.MO="mo",e.MN="mn",e.MS="ms",e.MTEXT="mtext",e.NAV="nav",e.NOBR="nobr",e.NOFRAMES="noframes",e.NOEMBED="noembed",e.NOSCRIPT="noscript",e.OBJECT="object",e.OL="ol",e.OPTGROUP="optgroup",e.OPTION="option",e.P="p",e.PARAM="param",e.PLAINTEXT="plaintext",e.PRE="pre",e.RB="rb",e.RP="rp",e.RT="rt",e.RTC="rtc",e.RUBY="ruby",e.S="s",e.SCRIPT="script",e.SEARCH="search",e.SECTION="section",e.SELECT="select",e.SOURCE="source",e.SMALL="small",e.SPAN="span",e.STRIKE="strike",e.STRONG="strong",e.STYLE="style",e.SUB="sub",e.SUMMARY="summary",e.SUP="sup",e.TABLE="table",e.TBODY="tbody",e.TEMPLATE="template",e.TEXTAREA="textarea",e.TFOOT="tfoot",e.TD="td",e.TH="th",e.THEAD="thead",e.TITLE="title",e.TR="tr",e.TRACK="track",e.TT="tt",e.U="u",e.UL="ul",e.SVG="svg",e.VAR="var",e.WBR="wbr",e.XMP="xmp"})(q||(et.TAG_NAMES=q={}));var Y;(function(e){e[e.UNKNOWN=0]="UNKNOWN",e[e.A=1]="A",e[e.ADDRESS=2]="ADDRESS",e[e.ANNOTATION_XML=3]="ANNOTATION_XML",e[e.APPLET=4]="APPLET",e[e.AREA=5]="AREA",e[e.ARTICLE=6]="ARTICLE",e[e.ASIDE=7]="ASIDE",e[e.B=8]="B",e[e.BASE=9]="BASE",e[e.BASEFONT=10]="BASEFONT",e[e.BGSOUND=11]="BGSOUND",e[e.BIG=12]="BIG",e[e.BLOCKQUOTE=13]="BLOCKQUOTE",e[e.BODY=14]="BODY",e[e.BR=15]="BR",e[e.BUTTON=16]="BUTTON",e[e.CAPTION=17]="CAPTION",e[e.CENTER=18]="CENTER",e[e.CODE=19]="CODE",e[e.COL=20]="COL",e[e.COLGROUP=21]="COLGROUP",e[e.DD=22]="DD",e[e.DESC=23]="DESC",e[e.DETAILS=24]="DETAILS",e[e.DIALOG=25]="DIALOG",e[e.DIR=26]="DIR",e[e.DIV=27]="DIV",e[e.DL=28]="DL",e[e.DT=29]="DT",e[e.EM=30]="EM",e[e.EMBED=31]="EMBED",e[e.FIELDSET=32]="FIELDSET",e[e.FIGCAPTION=33]="FIGCAPTION",e[e.FIGURE=34]="FIGURE",e[e.FONT=35]="FONT",e[e.FOOTER=36]="FOOTER",e[e.FOREIGN_OBJECT=37]="FOREIGN_OBJECT",e[e.FORM=38]="FORM",e[e.FRAME=39]="FRAME",e[e.FRAMESET=40]="FRAMESET",e[e.H1=41]="H1",e[e.H2=42]="H2",e[e.H3=43]="H3",e[e.H4=44]="H4",e[e.H5=45]="H5",e[e.H6=46]="H6",e[e.HEAD=47]="HEAD",e[e.HEADER=48]="HEADER",e[e.HGROUP=49]="HGROUP",e[e.HR=50]="HR",e[e.HTML=51]="HTML",e[e.I=52]="I",e[e.IMG=53]="IMG",e[e.IMAGE=54]="IMAGE",e[e.INPUT=55]="INPUT",e[e.IFRAME=56]="IFRAME",e[e.KEYGEN=57]="KEYGEN",e[e.LABEL=58]="LABEL",e[e.LI=59]="LI",e[e.LINK=60]="LINK",e[e.LISTING=61]="LISTING",e[e.MAIN=62]="MAIN",e[e.MALIGNMARK=63]="MALIGNMARK",e[e.MARQUEE=64]="MARQUEE",e[e.MATH=65]="MATH",e[e.MENU=66]="MENU",e[e.META=67]="META",e[e.MGLYPH=68]="MGLYPH",e[e.MI=69]="MI",e[e.MO=70]="MO",e[e.MN=71]="MN",e[e.MS=72]="MS",e[e.MTEXT=73]="MTEXT",e[e.NAV=74]="NAV",e[e.NOBR=75]="NOBR",e[e.NOFRAMES=76]="NOFRAMES",e[e.NOEMBED=77]="NOEMBED",e[e.NOSCRIPT=78]="NOSCRIPT",e[e.OBJECT=79]="OBJECT",e[e.OL=80]="OL",e[e.OPTGROUP=81]="OPTGROUP",e[e.OPTION=82]="OPTION",e[e.P=83]="P",e[e.PARAM=84]="PARAM",e[e.PLAINTEXT=85]="PLAINTEXT",e[e.PRE=86]="PRE",e[e.RB=87]="RB",e[e.RP=88]="RP",e[e.RT=89]="RT",e[e.RTC=90]="RTC",e[e.RUBY=91]="RUBY",e[e.S=92]="S",e[e.SCRIPT=93]="SCRIPT",e[e.SEARCH=94]="SEARCH",e[e.SECTION=95]="SECTION",e[e.SELECT=96]="SELECT",e[e.SOURCE=97]="SOURCE",e[e.SMALL=98]="SMALL",e[e.SPAN=99]="SPAN",e[e.STRIKE=100]="STRIKE",e[e.STRONG=101]="STRONG",e[e.STYLE=102]="STYLE",e[e.SUB=103]="SUB",e[e.SUMMARY=104]="SUMMARY",e[e.SUP=105]="SUP",e[e.TABLE=106]="TABLE",e[e.TBODY=107]="TBODY",e[e.TEMPLATE=108]="TEMPLATE",e[e.TEXTAREA=109]="TEXTAREA",e[e.TFOOT=110]="TFOOT",e[e.TD=111]="TD",e[e.TH=112]="TH",e[e.THEAD=113]="THEAD",e[e.TITLE=114]="TITLE",e[e.TR=115]="TR",e[e.TRACK=116]="TRACK",e[e.TT=117]="TT",e[e.U=118]="U",e[e.UL=119]="UL",e[e.SVG=120]="SVG",e[e.VAR=121]="VAR",e[e.WBR=122]="WBR",e[e.XMP=123]="XMP"})(Y||(et.TAG_ID=Y={}));var Zx=new Map([[q.A,Y.A],[q.ADDRESS,Y.ADDRESS],[q.ANNOTATION_XML,Y.ANNOTATION_XML],[q.APPLET,Y.APPLET],[q.AREA,Y.AREA],[q.ARTICLE,Y.ARTICLE],[q.ASIDE,Y.ASIDE],[q.B,Y.B],[q.BASE,Y.BASE],[q.BASEFONT,Y.BASEFONT],[q.BGSOUND,Y.BGSOUND],[q.BIG,Y.BIG],[q.BLOCKQUOTE,Y.BLOCKQUOTE],[q.BODY,Y.BODY],[q.BR,Y.BR],[q.BUTTON,Y.BUTTON],[q.CAPTION,Y.CAPTION],[q.CENTER,Y.CENTER],[q.CODE,Y.CODE],[q.COL,Y.COL],[q.COLGROUP,Y.COLGROUP],[q.DD,Y.DD],[q.DESC,Y.DESC],[q.DETAILS,Y.DETAILS],[q.DIALOG,Y.DIALOG],[q.DIR,Y.DIR],[q.DIV,Y.DIV],[q.DL,Y.DL],[q.DT,Y.DT],[q.EM,Y.EM],[q.EMBED,Y.EMBED],[q.FIELDSET,Y.FIELDSET],[q.FIGCAPTION,Y.FIGCAPTION],[q.FIGURE,Y.FIGURE],[q.FONT,Y.FONT],[q.FOOTER,Y.FOOTER],[q.FOREIGN_OBJECT,Y.FOREIGN_OBJECT],[q.FORM,Y.FORM],[q.FRAME,Y.FRAME],[q.FRAMESET,Y.FRAMESET],[q.H1,Y.H1],[q.H2,Y.H2],[q.H3,Y.H3],[q.H4,Y.H4],[q.H5,Y.H5],[q.H6,Y.H6],[q.HEAD,Y.HEAD],[q.HEADER,Y.HEADER],[q.HGROUP,Y.HGROUP],[q.HR,Y.HR],[q.HTML,Y.HTML],[q.I,Y.I],[q.IMG,Y.IMG],[q.IMAGE,Y.IMAGE],[q.INPUT,Y.INPUT],[q.IFRAME,Y.IFRAME],[q.KEYGEN,Y.KEYGEN],[q.LABEL,Y.LABEL],[q.LI,Y.LI],[q.LINK,Y.LINK],[q.LISTING,Y.LISTING],[q.MAIN,Y.MAIN],[q.MALIGNMARK,Y.MALIGNMARK],[q.MARQUEE,Y.MARQUEE],[q.MATH,Y.MATH],[q.MENU,Y.MENU],[q.META,Y.META],[q.MGLYPH,Y.MGLYPH],[q.MI,Y.MI],[q.MO,Y.MO],[q.MN,Y.MN],[q.MS,Y.MS],[q.MTEXT,Y.MTEXT],[q.NAV,Y.NAV],[q.NOBR,Y.NOBR],[q.NOFRAMES,Y.NOFRAMES],[q.NOEMBED,Y.NOEMBED],[q.NOSCRIPT,Y.NOSCRIPT],[q.OBJECT,Y.OBJECT],[q.OL,Y.OL],[q.OPTGROUP,Y.OPTGROUP],[q.OPTION,Y.OPTION],[q.P,Y.P],[q.PARAM,Y.PARAM],[q.PLAINTEXT,Y.PLAINTEXT],[q.PRE,Y.PRE],[q.RB,Y.RB],[q.RP,Y.RP],[q.RT,Y.RT],[q.RTC,Y.RTC],[q.RUBY,Y.RUBY],[q.S,Y.S],[q.SCRIPT,Y.SCRIPT],[q.SEARCH,Y.SEARCH],[q.SECTION,Y.SECTION],[q.SELECT,Y.SELECT],[q.SOURCE,Y.SOURCE],[q.SMALL,Y.SMALL],[q.SPAN,Y.SPAN],[q.STRIKE,Y.STRIKE],[q.STRONG,Y.STRONG],[q.STYLE,Y.STYLE],[q.SUB,Y.SUB],[q.SUMMARY,Y.SUMMARY],[q.SUP,Y.SUP],[q.TABLE,Y.TABLE],[q.TBODY,Y.TBODY],[q.TEMPLATE,Y.TEMPLATE],[q.TEXTAREA,Y.TEXTAREA],[q.TFOOT,Y.TFOOT],[q.TD,Y.TD],[q.TH,Y.TH],[q.THEAD,Y.THEAD],[q.TITLE,Y.TITLE],[q.TR,Y.TR],[q.TRACK,Y.TRACK],[q.TT,Y.TT],[q.U,Y.U],[q.UL,Y.UL],[q.SVG,Y.SVG],[q.VAR,Y.VAR],[q.WBR,Y.WBR],[q.XMP,Y.XMP]]);function Jx(e){var t;return(t=Zx.get(e))!==null&&t!==void 0?t:Y.UNKNOWN}var te=Y;et.SPECIAL_ELEMENTS={[eu.HTML]:new Set([te.ADDRESS,te.APPLET,te.AREA,te.ARTICLE,te.ASIDE,te.BASE,te.BASEFONT,te.BGSOUND,te.BLOCKQUOTE,te.BODY,te.BR,te.BUTTON,te.CAPTION,te.CENTER,te.COL,te.COLGROUP,te.DD,te.DETAILS,te.DIR,te.DIV,te.DL,te.DT,te.EMBED,te.FIELDSET,te.FIGCAPTION,te.FIGURE,te.FOOTER,te.FORM,te.FRAME,te.FRAMESET,te.H1,te.H2,te.H3,te.H4,te.H5,te.H6,te.HEAD,te.HEADER,te.HGROUP,te.HR,te.HTML,te.IFRAME,te.IMG,te.INPUT,te.LI,te.LINK,te.LISTING,te.MAIN,te.MARQUEE,te.MENU,te.META,te.NAV,te.NOEMBED,te.NOFRAMES,te.NOSCRIPT,te.OBJECT,te.OL,te.P,te.PARAM,te.PLAINTEXT,te.PRE,te.SCRIPT,te.SECTION,te.SELECT,te.SOURCE,te.STYLE,te.SUMMARY,te.TABLE,te.TBODY,te.TD,te.TEMPLATE,te.TEXTAREA,te.TFOOT,te.TH,te.THEAD,te.TITLE,te.TR,te.TRACK,te.UL,te.WBR,te.XMP]),[eu.MATHML]:new Set([te.MI,te.MO,te.MN,te.MS,te.MTEXT,te.ANNOTATION_XML]),[eu.SVG]:new Set([te.TITLE,te.FOREIGN_OBJECT,te.DESC]),[eu.XLINK]:new Set,[eu.XML]:new Set,[eu.XMLNS]:new Set};et.NUMBERED_HEADERS=new Set([te.H1,te.H2,te.H3,te.H4,te.H5,te.H6]);var e4=new Set([q.STYLE,q.SCRIPT,q.XMP,q.IFRAME,q.NOEMBED,q.NOFRAMES,q.PLAINTEXT]);function t4(e,t){return e4.has(e)||t&&e===q.NOSCRIPT}});var ho=R(o0=>{"use strict";Object.defineProperty(o0,"__esModule",{value:!0});o0.Tokenizer=o0.TokenizerMode=void 0;var r4=Nd(),E=dn(),Dt=bn(),xn=Ld(),Z=Z0(),fo=Or(),m;(function(e){e[e.DATA=0]="DATA",e[e.RCDATA=1]="RCDATA",e[e.RAWTEXT=2]="RAWTEXT",e[e.SCRIPT_DATA=3]="SCRIPT_DATA",e[e.PLAINTEXT=4]="PLAINTEXT",e[e.TAG_OPEN=5]="TAG_OPEN",e[e.END_TAG_OPEN=6]="END_TAG_OPEN",e[e.TAG_NAME=7]="TAG_NAME",e[e.RCDATA_LESS_THAN_SIGN=8]="RCDATA_LESS_THAN_SIGN",e[e.RCDATA_END_TAG_OPEN=9]="RCDATA_END_TAG_OPEN",e[e.RCDATA_END_TAG_NAME=10]="RCDATA_END_TAG_NAME",e[e.RAWTEXT_LESS_THAN_SIGN=11]="RAWTEXT_LESS_THAN_SIGN",e[e.RAWTEXT_END_TAG_OPEN=12]="RAWTEXT_END_TAG_OPEN",e[e.RAWTEXT_END_TAG_NAME=13]="RAWTEXT_END_TAG_NAME",e[e.SCRIPT_DATA_LESS_THAN_SIGN=14]="SCRIPT_DATA_LESS_THAN_SIGN",e[e.SCRIPT_DATA_END_TAG_OPEN=15]="SCRIPT_DATA_END_TAG_OPEN",e[e.SCRIPT_DATA_END_TAG_NAME=16]="SCRIPT_DATA_END_TAG_NAME",e[e.SCRIPT_DATA_ESCAPE_START=17]="SCRIPT_DATA_ESCAPE_START",e[e.SCRIPT_DATA_ESCAPE_START_DASH=18]="SCRIPT_DATA_ESCAPE_START_DASH",e[e.SCRIPT_DATA_ESCAPED=19]="SCRIPT_DATA_ESCAPED",e[e.SCRIPT_DATA_ESCAPED_DASH=20]="SCRIPT_DATA_ESCAPED_DASH",e[e.SCRIPT_DATA_ESCAPED_DASH_DASH=21]="SCRIPT_DATA_ESCAPED_DASH_DASH",e[e.SCRIPT_DATA_ESCAPED_LESS_THAN_SIGN=22]="SCRIPT_DATA_ESCAPED_LESS_THAN_SIGN",e[e.SCRIPT_DATA_ESCAPED_END_TAG_OPEN=23]="SCRIPT_DATA_ESCAPED_END_TAG_OPEN",e[e.SCRIPT_DATA_ESCAPED_END_TAG_NAME=24]="SCRIPT_DATA_ESCAPED_END_TAG_NAME",e[e.SCRIPT_DATA_DOUBLE_ESCAPE_START=25]="SCRIPT_DATA_DOUBLE_ESCAPE_START",e[e.SCRIPT_DATA_DOUBLE_ESCAPED=26]="SCRIPT_DATA_DOUBLE_ESCAPED",e[e.SCRIPT_DATA_DOUBLE_ESCAPED_DASH=27]="SCRIPT_DATA_DOUBLE_ESCAPED_DASH",e[e.SCRIPT_DATA_DOUBLE_ESCAPED_DASH_DASH=28]="SCRIPT_DATA_DOUBLE_ESCAPED_DASH_DASH",e[e.SCRIPT_DATA_DOUBLE_ESCAPED_LESS_THAN_SIGN=29]="SCRIPT_DATA_DOUBLE_ESCAPED_LESS_THAN_SIGN",e[e.SCRIPT_DATA_DOUBLE_ESCAPE_END=30]="SCRIPT_DATA_DOUBLE_ESCAPE_END",e[e.BEFORE_ATTRIBUTE_NAME=31]="BEFORE_ATTRIBUTE_NAME",e[e.ATTRIBUTE_NAME=32]="ATTRIBUTE_NAME",e[e.AFTER_ATTRIBUTE_NAME=33]="AFTER_ATTRIBUTE_NAME",e[e.BEFORE_ATTRIBUTE_VALUE=34]="BEFORE_ATTRIBUTE_VALUE",e[e.ATTRIBUTE_VALUE_DOUBLE_QUOTED=35]="ATTRIBUTE_VALUE_DOUBLE_QUOTED",e[e.ATTRIBUTE_VALUE_SINGLE_QUOTED=36]="ATTRIBUTE_VALUE_SINGLE_QUOTED",e[e.ATTRIBUTE_VALUE_UNQUOTED=37]="ATTRIBUTE_VALUE_UNQUOTED",e[e.AFTER_ATTRIBUTE_VALUE_QUOTED=38]="AFTER_ATTRIBUTE_VALUE_QUOTED",e[e.SELF_CLOSING_START_TAG=39]="SELF_CLOSING_START_TAG",e[e.BOGUS_COMMENT=40]="BOGUS_COMMENT",e[e.MARKUP_DECLARATION_OPEN=41]="MARKUP_DECLARATION_OPEN",e[e.COMMENT_START=42]="COMMENT_START",e[e.COMMENT_START_DASH=43]="COMMENT_START_DASH",e[e.COMMENT=44]="COMMENT",e[e.COMMENT_LESS_THAN_SIGN=45]="COMMENT_LESS_THAN_SIGN",e[e.COMMENT_LESS_THAN_SIGN_BANG=46]="COMMENT_LESS_THAN_SIGN_BANG",e[e.COMMENT_LESS_THAN_SIGN_BANG_DASH=47]="COMMENT_LESS_THAN_SIGN_BANG_DASH",e[e.COMMENT_LESS_THAN_SIGN_BANG_DASH_DASH=48]="COMMENT_LESS_THAN_SIGN_BANG_DASH_DASH",e[e.COMMENT_END_DASH=49]="COMMENT_END_DASH",e[e.COMMENT_END=50]="COMMENT_END",e[e.COMMENT_END_BANG=51]="COMMENT_END_BANG",e[e.DOCTYPE=52]="DOCTYPE",e[e.BEFORE_DOCTYPE_NAME=53]="BEFORE_DOCTYPE_NAME",e[e.DOCTYPE_NAME=54]="DOCTYPE_NAME",e[e.AFTER_DOCTYPE_NAME=55]="AFTER_DOCTYPE_NAME",e[e.AFTER_DOCTYPE_PUBLIC_KEYWORD=56]="AFTER_DOCTYPE_PUBLIC_KEYWORD",e[e.BEFORE_DOCTYPE_PUBLIC_IDENTIFIER=57]="BEFORE_DOCTYPE_PUBLIC_IDENTIFIER",e[e.DOCTYPE_PUBLIC_IDENTIFIER_DOUBLE_QUOTED=58]="DOCTYPE_PUBLIC_IDENTIFIER_DOUBLE_QUOTED",e[e.DOCTYPE_PUBLIC_IDENTIFIER_SINGLE_QUOTED=59]="DOCTYPE_PUBLIC_IDENTIFIER_SINGLE_QUOTED",e[e.AFTER_DOCTYPE_PUBLIC_IDENTIFIER=60]="AFTER_DOCTYPE_PUBLIC_IDENTIFIER",e[e.BETWEEN_DOCTYPE_PUBLIC_AND_SYSTEM_IDENTIFIERS=61]="BETWEEN_DOCTYPE_PUBLIC_AND_SYSTEM_IDENTIFIERS",e[e.AFTER_DOCTYPE_SYSTEM_KEYWORD=62]="AFTER_DOCTYPE_SYSTEM_KEYWORD",e[e.BEFORE_DOCTYPE_SYSTEM_IDENTIFIER=63]="BEFORE_DOCTYPE_SYSTEM_IDENTIFIER",e[e.DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED=64]="DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED",e[e.DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED=65]="DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED",e[e.AFTER_DOCTYPE_SYSTEM_IDENTIFIER=66]="AFTER_DOCTYPE_SYSTEM_IDENTIFIER",e[e.BOGUS_DOCTYPE=67]="BOGUS_DOCTYPE",e[e.CDATA_SECTION=68]="CDATA_SECTION",e[e.CDATA_SECTION_BRACKET=69]="CDATA_SECTION_BRACKET",e[e.CDATA_SECTION_END=70]="CDATA_SECTION_END",e[e.CHARACTER_REFERENCE=71]="CHARACTER_REFERENCE",e[e.AMBIGUOUS_AMPERSAND=72]="AMBIGUOUS_AMPERSAND"})(m||(m={}));o0.TokenizerMode={DATA:m.DATA,RCDATA:m.RCDATA,RAWTEXT:m.RAWTEXT,SCRIPT_DATA:m.SCRIPT_DATA,PLAINTEXT:m.PLAINTEXT,CDATA_SECTION:m.CDATA_SECTION};function u4(e){return e>=E.CODE_POINTS.DIGIT_0&&e<=E.CODE_POINTS.DIGIT_9}function ea(e){return e>=E.CODE_POINTS.LATIN_CAPITAL_A&&e<=E.CODE_POINTS.LATIN_CAPITAL_Z}function a4(e){return e>=E.CODE_POINTS.LATIN_SMALL_A&&e<=E.CODE_POINTS.LATIN_SMALL_Z}function tu(e){return a4(e)||ea(e)}function kd(e){return tu(e)||u4(e)}function An(e){return e+32}function Ud(e){return e===E.CODE_POINTS.SPACE||e===E.CODE_POINTS.LINE_FEED||e===E.CODE_POINTS.TABULATION||e===E.CODE_POINTS.FORM_FEED}function Hd(e){return Ud(e)||e===E.CODE_POINTS.SOLIDUS||e===E.CODE_POINTS.GREATER_THAN_SIGN}function n4(e){return e===E.CODE_POINTS.NULL?Z.ERR.nullCharacterReference:e>1114111?Z.ERR.characterReferenceOutsideUnicodeRange:(0,E.isSurrogate)(e)?Z.ERR.surrogateCharacterReference:(0,E.isUndefinedCodePoint)(e)?Z.ERR.noncharacterCharacterReference:(0,E.isControlCodePoint)(e)||e===E.CODE_POINTS.CARRIAGE_RETURN?Z.ERR.controlCharacterReference:null}var lo=class{constructor(t,r){this.options=t,this.handler=r,this.paused=!1,this.inLoop=!1,this.inForeignNode=!1,this.lastStartTagName="",this.active=!1,this.state=m.DATA,this.returnState=m.DATA,this.entityStartPos=0,this.consumedAfterSnapshot=-1,this.currentCharacterToken=null,this.currentToken=null,this.currentAttr={name:"",value:""},this.preprocessor=new r4.Preprocessor(r),this.currentLocation=this.getCurrentLocation(-1),this.entityDecoder=new xn.EntityDecoder(xn.htmlDecodeTree,(u,a)=>{this.preprocessor.pos=this.entityStartPos+a-1,this._flushCodePointConsumedAsCharacterReference(u)},r.onParseError?{missingSemicolonAfterCharacterReference:()=>{this._err(Z.ERR.missingSemicolonAfterCharacterReference,1)},absenceOfDigitsInNumericCharacterReference:u=>{this._err(Z.ERR.absenceOfDigitsInNumericCharacterReference,this.entityStartPos-this.preprocessor.pos+u)},validateNumericCharacterReference:u=>{let a=n4(u);a&&this._err(a,1)}}:void 0)}_err(t,r=0){var u,a;(a=(u=this.handler).onParseError)===null||a===void 0||a.call(u,this.preprocessor.getError(t,r))}getCurrentLocation(t){return this.options.sourceCodeLocationInfo?{startLine:this.preprocessor.line,startCol:this.preprocessor.col-t,startOffset:this.preprocessor.offset-t,endLine:-1,endCol:-1,endOffset:-1}:null}_runParsingLoop(){if(!this.inLoop){for(this.inLoop=!0;this.active&&!this.paused;){this.consumedAfterSnapshot=0;let t=this._consume();this._ensureHibernation()||this._callState(t)}this.inLoop=!1}}pause(){this.paused=!0}resume(t){if(!this.paused)throw new Error("Parser was already resumed");this.paused=!1,!this.inLoop&&(this._runParsingLoop(),this.paused||t==null||t())}write(t,r,u){this.active=!0,this.preprocessor.write(t,r),this._runParsingLoop(),this.paused||u==null||u()}insertHtmlAtCurrentPos(t){this.active=!0,this.preprocessor.insertHtmlAtCurrentPos(t),this._runParsingLoop()}_ensureHibernation(){return this.preprocessor.endOfChunkHit?(this.preprocessor.retreat(this.consumedAfterSnapshot),this.consumedAfterSnapshot=0,this.active=!1,!0):!1}_consume(){return this.consumedAfterSnapshot++,this.preprocessor.advance()}_advanceBy(t){this.consumedAfterSnapshot+=t;for(let r=0;r<t;r++)this.preprocessor.advance()}_consumeSequenceIfMatch(t,r){return this.preprocessor.startsWith(t,r)?(this._advanceBy(t.length-1),!0):!1}_createStartTagToken(){this.currentToken={type:Dt.TokenType.START_TAG,tagName:"",tagID:fo.TAG_ID.UNKNOWN,selfClosing:!1,ackSelfClosing:!1,attrs:[],location:this.getCurrentLocation(1)}}_createEndTagToken(){this.currentToken={type:Dt.TokenType.END_TAG,tagName:"",tagID:fo.TAG_ID.UNKNOWN,selfClosing:!1,ackSelfClosing:!1,attrs:[],location:this.getCurrentLocation(2)}}_createCommentToken(t){this.currentToken={type:Dt.TokenType.COMMENT,data:"",location:this.getCurrentLocation(t)}}_createDoctypeToken(t){this.currentToken={type:Dt.TokenType.DOCTYPE,name:t,forceQuirks:!1,publicId:null,systemId:null,location:this.currentLocation}}_createCharacterToken(t,r){this.currentCharacterToken={type:t,chars:r,location:this.currentLocation}}_createAttr(t){this.currentAttr={name:t,value:""},this.currentLocation=this.getCurrentLocation(0)}_leaveAttrName(){var t,r;let u=this.currentToken;if((0,Dt.getTokenAttr)(u,this.currentAttr.name)===null){if(u.attrs.push(this.currentAttr),u.location&&this.currentLocation){let a=(t=(r=u.location).attrs)!==null&&t!==void 0?t:r.attrs=Object.create(null);a[this.currentAttr.name]=this.currentLocation,this._leaveAttrValue()}}else this._err(Z.ERR.duplicateAttribute)}_leaveAttrValue(){this.currentLocation&&(this.currentLocation.endLine=this.preprocessor.line,this.currentLocation.endCol=this.preprocessor.col,this.currentLocation.endOffset=this.preprocessor.offset)}prepareToken(t){this._emitCurrentCharacterToken(t.location),this.currentToken=null,t.location&&(t.location.endLine=this.preprocessor.line,t.location.endCol=this.preprocessor.col+1,t.location.endOffset=this.preprocessor.offset+1),this.currentLocation=this.getCurrentLocation(-1)}emitCurrentTagToken(){let t=this.currentToken;this.prepareToken(t),t.tagID=(0,fo.getTagID)(t.tagName),t.type===Dt.TokenType.START_TAG?(this.lastStartTagName=t.tagName,this.handler.onStartTag(t)):(t.attrs.length>0&&this._err(Z.ERR.endTagWithAttributes),t.selfClosing&&this._err(Z.ERR.endTagWithTrailingSolidus),this.handler.onEndTag(t)),this.preprocessor.dropParsedChunk()}emitCurrentComment(t){this.prepareToken(t),this.handler.onComment(t),this.preprocessor.dropParsedChunk()}emitCurrentDoctype(t){this.prepareToken(t),this.handler.onDoctype(t),this.preprocessor.dropParsedChunk()}_emitCurrentCharacterToken(t){if(this.currentCharacterToken){switch(t&&this.currentCharacterToken.location&&(this.currentCharacterToken.location.endLine=t.startLine,this.currentCharacterToken.location.endCol=t.startCol,this.currentCharacterToken.location.endOffset=t.startOffset),this.currentCharacterToken.type){case Dt.TokenType.CHARACTER:{this.handler.onCharacter(this.currentCharacterToken);break}case Dt.TokenType.NULL_CHARACTER:{this.handler.onNullCharacter(this.currentCharacterToken);break}case Dt.TokenType.WHITESPACE_CHARACTER:{this.handler.onWhitespaceCharacter(this.currentCharacterToken);break}}this.currentCharacterToken=null}}_emitEOFToken(){let t=this.getCurrentLocation(0);t&&(t.endLine=t.startLine,t.endCol=t.startCol,t.endOffset=t.startOffset),this._emitCurrentCharacterToken(t),this.handler.onEof({type:Dt.TokenType.EOF,location:t}),this.active=!1}_appendCharToCurrentCharacterToken(t,r){if(this.currentCharacterToken)if(this.currentCharacterToken.type===t){this.currentCharacterToken.chars+=r;return}else this.currentLocation=this.getCurrentLocation(0),this._emitCurrentCharacterToken(this.currentLocation),this.preprocessor.dropParsedChunk();this._createCharacterToken(t,r)}_emitCodePoint(t){let r=Ud(t)?Dt.TokenType.WHITESPACE_CHARACTER:t===E.CODE_POINTS.NULL?Dt.TokenType.NULL_CHARACTER:Dt.TokenType.CHARACTER;this._appendCharToCurrentCharacterToken(r,String.fromCodePoint(t))}_emitChars(t){this._appendCharToCurrentCharacterToken(Dt.TokenType.CHARACTER,t)}_startCharacterReference(){this.returnState=this.state,this.state=m.CHARACTER_REFERENCE,this.entityStartPos=this.preprocessor.pos,this.entityDecoder.startEntity(this._isCharacterReferenceInAttribute()?xn.DecodingMode.Attribute:xn.DecodingMode.Legacy)}_isCharacterReferenceInAttribute(){return this.returnState===m.ATTRIBUTE_VALUE_DOUBLE_QUOTED||this.returnState===m.ATTRIBUTE_VALUE_SINGLE_QUOTED||this.returnState===m.ATTRIBUTE_VALUE_UNQUOTED}_flushCodePointConsumedAsCharacterReference(t){this._isCharacterReferenceInAttribute()?this.currentAttr.value+=String.fromCodePoint(t):this._emitCodePoint(t)}_callState(t){switch(this.state){case m.DATA:{this._stateData(t);break}case m.RCDATA:{this._stateRcdata(t);break}case m.RAWTEXT:{this._stateRawtext(t);break}case m.SCRIPT_DATA:{this._stateScriptData(t);break}case m.PLAINTEXT:{this._statePlaintext(t);break}case m.TAG_OPEN:{this._stateTagOpen(t);break}case m.END_TAG_OPEN:{this._stateEndTagOpen(t);break}case m.TAG_NAME:{this._stateTagName(t);break}case m.RCDATA_LESS_THAN_SIGN:{this._stateRcdataLessThanSign(t);break}case m.RCDATA_END_TAG_OPEN:{this._stateRcdataEndTagOpen(t);break}case m.RCDATA_END_TAG_NAME:{this._stateRcdataEndTagName(t);break}case m.RAWTEXT_LESS_THAN_SIGN:{this._stateRawtextLessThanSign(t);break}case m.RAWTEXT_END_TAG_OPEN:{this._stateRawtextEndTagOpen(t);break}case m.RAWTEXT_END_TAG_NAME:{this._stateRawtextEndTagName(t);break}case m.SCRIPT_DATA_LESS_THAN_SIGN:{this._stateScriptDataLessThanSign(t);break}case m.SCRIPT_DATA_END_TAG_OPEN:{this._stateScriptDataEndTagOpen(t);break}case m.SCRIPT_DATA_END_TAG_NAME:{this._stateScriptDataEndTagName(t);break}case m.SCRIPT_DATA_ESCAPE_START:{this._stateScriptDataEscapeStart(t);break}case m.SCRIPT_DATA_ESCAPE_START_DASH:{this._stateScriptDataEscapeStartDash(t);break}case m.SCRIPT_DATA_ESCAPED:{this._stateScriptDataEscaped(t);break}case m.SCRIPT_DATA_ESCAPED_DASH:{this._stateScriptDataEscapedDash(t);break}case m.SCRIPT_DATA_ESCAPED_DASH_DASH:{this._stateScriptDataEscapedDashDash(t);break}case m.SCRIPT_DATA_ESCAPED_LESS_THAN_SIGN:{this._stateScriptDataEscapedLessThanSign(t);break}case m.SCRIPT_DATA_ESCAPED_END_TAG_OPEN:{this._stateScriptDataEscapedEndTagOpen(t);break}case m.SCRIPT_DATA_ESCAPED_END_TAG_NAME:{this._stateScriptDataEscapedEndTagName(t);break}case m.SCRIPT_DATA_DOUBLE_ESCAPE_START:{this._stateScriptDataDoubleEscapeStart(t);break}case m.SCRIPT_DATA_DOUBLE_ESCAPED:{this._stateScriptDataDoubleEscaped(t);break}case m.SCRIPT_DATA_DOUBLE_ESCAPED_DASH:{this._stateScriptDataDoubleEscapedDash(t);break}case m.SCRIPT_DATA_DOUBLE_ESCAPED_DASH_DASH:{this._stateScriptDataDoubleEscapedDashDash(t);break}case m.SCRIPT_DATA_DOUBLE_ESCAPED_LESS_THAN_SIGN:{this._stateScriptDataDoubleEscapedLessThanSign(t);break}case m.SCRIPT_DATA_DOUBLE_ESCAPE_END:{this._stateScriptDataDoubleEscapeEnd(t);break}case m.BEFORE_ATTRIBUTE_NAME:{this._stateBeforeAttributeName(t);break}case m.ATTRIBUTE_NAME:{this._stateAttributeName(t);break}case m.AFTER_ATTRIBUTE_NAME:{this._stateAfterAttributeName(t);break}case m.BEFORE_ATTRIBUTE_VALUE:{this._stateBeforeAttributeValue(t);break}case m.ATTRIBUTE_VALUE_DOUBLE_QUOTED:{this._stateAttributeValueDoubleQuoted(t);break}case m.ATTRIBUTE_VALUE_SINGLE_QUOTED:{this._stateAttributeValueSingleQuoted(t);break}case m.ATTRIBUTE_VALUE_UNQUOTED:{this._stateAttributeValueUnquoted(t);break}case m.AFTER_ATTRIBUTE_VALUE_QUOTED:{this._stateAfterAttributeValueQuoted(t);break}case m.SELF_CLOSING_START_TAG:{this._stateSelfClosingStartTag(t);break}case m.BOGUS_COMMENT:{this._stateBogusComment(t);break}case m.MARKUP_DECLARATION_OPEN:{this._stateMarkupDeclarationOpen(t);break}case m.COMMENT_START:{this._stateCommentStart(t);break}case m.COMMENT_START_DASH:{this._stateCommentStartDash(t);break}case m.COMMENT:{this._stateComment(t);break}case m.COMMENT_LESS_THAN_SIGN:{this._stateCommentLessThanSign(t);break}case m.COMMENT_LESS_THAN_SIGN_BANG:{this._stateCommentLessThanSignBang(t);break}case m.COMMENT_LESS_THAN_SIGN_BANG_DASH:{this._stateCommentLessThanSignBangDash(t);break}case m.COMMENT_LESS_THAN_SIGN_BANG_DASH_DASH:{this._stateCommentLessThanSignBangDashDash(t);break}case m.COMMENT_END_DASH:{this._stateCommentEndDash(t);break}case m.COMMENT_END:{this._stateCommentEnd(t);break}case m.COMMENT_END_BANG:{this._stateCommentEndBang(t);break}case m.DOCTYPE:{this._stateDoctype(t);break}case m.BEFORE_DOCTYPE_NAME:{this._stateBeforeDoctypeName(t);break}case m.DOCTYPE_NAME:{this._stateDoctypeName(t);break}case m.AFTER_DOCTYPE_NAME:{this._stateAfterDoctypeName(t);break}case m.AFTER_DOCTYPE_PUBLIC_KEYWORD:{this._stateAfterDoctypePublicKeyword(t);break}case m.BEFORE_DOCTYPE_PUBLIC_IDENTIFIER:{this._stateBeforeDoctypePublicIdentifier(t);break}case m.DOCTYPE_PUBLIC_IDENTIFIER_DOUBLE_QUOTED:{this._stateDoctypePublicIdentifierDoubleQuoted(t);break}case m.DOCTYPE_PUBLIC_IDENTIFIER_SINGLE_QUOTED:{this._stateDoctypePublicIdentifierSingleQuoted(t);break}case m.AFTER_DOCTYPE_PUBLIC_IDENTIFIER:{this._stateAfterDoctypePublicIdentifier(t);break}case m.BETWEEN_DOCTYPE_PUBLIC_AND_SYSTEM_IDENTIFIERS:{this._stateBetweenDoctypePublicAndSystemIdentifiers(t);break}case m.AFTER_DOCTYPE_SYSTEM_KEYWORD:{this._stateAfterDoctypeSystemKeyword(t);break}case m.BEFORE_DOCTYPE_SYSTEM_IDENTIFIER:{this._stateBeforeDoctypeSystemIdentifier(t);break}case m.DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED:{this._stateDoctypeSystemIdentifierDoubleQuoted(t);break}case m.DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED:{this._stateDoctypeSystemIdentifierSingleQuoted(t);break}case m.AFTER_DOCTYPE_SYSTEM_IDENTIFIER:{this._stateAfterDoctypeSystemIdentifier(t);break}case m.BOGUS_DOCTYPE:{this._stateBogusDoctype(t);break}case m.CDATA_SECTION:{this._stateCdataSection(t);break}case m.CDATA_SECTION_BRACKET:{this._stateCdataSectionBracket(t);break}case m.CDATA_SECTION_END:{this._stateCdataSectionEnd(t);break}case m.CHARACTER_REFERENCE:{this._stateCharacterReference();break}case m.AMBIGUOUS_AMPERSAND:{this._stateAmbiguousAmpersand(t);break}default:throw new Error("Unknown state")}}_stateData(t){switch(t){case E.CODE_POINTS.LESS_THAN_SIGN:{this.state=m.TAG_OPEN;break}case E.CODE_POINTS.AMPERSAND:{this._startCharacterReference();break}case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter),this._emitCodePoint(t);break}case E.CODE_POINTS.EOF:{this._emitEOFToken();break}default:this._emitCodePoint(t)}}_stateRcdata(t){switch(t){case E.CODE_POINTS.AMPERSAND:{this._startCharacterReference();break}case E.CODE_POINTS.LESS_THAN_SIGN:{this.state=m.RCDATA_LESS_THAN_SIGN;break}case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter),this._emitChars(E.REPLACEMENT_CHARACTER);break}case E.CODE_POINTS.EOF:{this._emitEOFToken();break}default:this._emitCodePoint(t)}}_stateRawtext(t){switch(t){case E.CODE_POINTS.LESS_THAN_SIGN:{this.state=m.RAWTEXT_LESS_THAN_SIGN;break}case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter),this._emitChars(E.REPLACEMENT_CHARACTER);break}case E.CODE_POINTS.EOF:{this._emitEOFToken();break}default:this._emitCodePoint(t)}}_stateScriptData(t){switch(t){case E.CODE_POINTS.LESS_THAN_SIGN:{this.state=m.SCRIPT_DATA_LESS_THAN_SIGN;break}case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter),this._emitChars(E.REPLACEMENT_CHARACTER);break}case E.CODE_POINTS.EOF:{this._emitEOFToken();break}default:this._emitCodePoint(t)}}_statePlaintext(t){switch(t){case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter),this._emitChars(E.REPLACEMENT_CHARACTER);break}case E.CODE_POINTS.EOF:{this._emitEOFToken();break}default:this._emitCodePoint(t)}}_stateTagOpen(t){if(tu(t))this._createStartTagToken(),this.state=m.TAG_NAME,this._stateTagName(t);else switch(t){case E.CODE_POINTS.EXCLAMATION_MARK:{this.state=m.MARKUP_DECLARATION_OPEN;break}case E.CODE_POINTS.SOLIDUS:{this.state=m.END_TAG_OPEN;break}case E.CODE_POINTS.QUESTION_MARK:{this._err(Z.ERR.unexpectedQuestionMarkInsteadOfTagName),this._createCommentToken(1),this.state=m.BOGUS_COMMENT,this._stateBogusComment(t);break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofBeforeTagName),this._emitChars("<"),this._emitEOFToken();break}default:this._err(Z.ERR.invalidFirstCharacterOfTagName),this._emitChars("<"),this.state=m.DATA,this._stateData(t)}}_stateEndTagOpen(t){if(tu(t))this._createEndTagToken(),this.state=m.TAG_NAME,this._stateTagName(t);else switch(t){case E.CODE_POINTS.GREATER_THAN_SIGN:{this._err(Z.ERR.missingEndTagName),this.state=m.DATA;break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofBeforeTagName),this._emitChars("</"),this._emitEOFToken();break}default:this._err(Z.ERR.invalidFirstCharacterOfTagName),this._createCommentToken(2),this.state=m.BOGUS_COMMENT,this._stateBogusComment(t)}}_stateTagName(t){let r=this.currentToken;switch(t){case E.CODE_POINTS.SPACE:case E.CODE_POINTS.LINE_FEED:case E.CODE_POINTS.TABULATION:case E.CODE_POINTS.FORM_FEED:{this.state=m.BEFORE_ATTRIBUTE_NAME;break}case E.CODE_POINTS.SOLIDUS:{this.state=m.SELF_CLOSING_START_TAG;break}case E.CODE_POINTS.GREATER_THAN_SIGN:{this.state=m.DATA,this.emitCurrentTagToken();break}case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter),r.tagName+=E.REPLACEMENT_CHARACTER;break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInTag),this._emitEOFToken();break}default:r.tagName+=String.fromCodePoint(ea(t)?An(t):t)}}_stateRcdataLessThanSign(t){t===E.CODE_POINTS.SOLIDUS?this.state=m.RCDATA_END_TAG_OPEN:(this._emitChars("<"),this.state=m.RCDATA,this._stateRcdata(t))}_stateRcdataEndTagOpen(t){tu(t)?(this.state=m.RCDATA_END_TAG_NAME,this._stateRcdataEndTagName(t)):(this._emitChars("</"),this.state=m.RCDATA,this._stateRcdata(t))}handleSpecialEndTag(t){if(!this.preprocessor.startsWith(this.lastStartTagName,!1))return!this._ensureHibernation();this._createEndTagToken();let r=this.currentToken;switch(r.tagName=this.lastStartTagName,this.preprocessor.peek(this.lastStartTagName.length)){case E.CODE_POINTS.SPACE:case E.CODE_POINTS.LINE_FEED:case E.CODE_POINTS.TABULATION:case E.CODE_POINTS.FORM_FEED:return this._advanceBy(this.lastStartTagName.length),this.state=m.BEFORE_ATTRIBUTE_NAME,!1;case E.CODE_POINTS.SOLIDUS:return this._advanceBy(this.lastStartTagName.length),this.state=m.SELF_CLOSING_START_TAG,!1;case E.CODE_POINTS.GREATER_THAN_SIGN:return this._advanceBy(this.lastStartTagName.length),this.emitCurrentTagToken(),this.state=m.DATA,!1;default:return!this._ensureHibernation()}}_stateRcdataEndTagName(t){this.handleSpecialEndTag(t)&&(this._emitChars("</"),this.state=m.RCDATA,this._stateRcdata(t))}_stateRawtextLessThanSign(t){t===E.CODE_POINTS.SOLIDUS?this.state=m.RAWTEXT_END_TAG_OPEN:(this._emitChars("<"),this.state=m.RAWTEXT,this._stateRawtext(t))}_stateRawtextEndTagOpen(t){tu(t)?(this.state=m.RAWTEXT_END_TAG_NAME,this._stateRawtextEndTagName(t)):(this._emitChars("</"),this.state=m.RAWTEXT,this._stateRawtext(t))}_stateRawtextEndTagName(t){this.handleSpecialEndTag(t)&&(this._emitChars("</"),this.state=m.RAWTEXT,this._stateRawtext(t))}_stateScriptDataLessThanSign(t){switch(t){case E.CODE_POINTS.SOLIDUS:{this.state=m.SCRIPT_DATA_END_TAG_OPEN;break}case E.CODE_POINTS.EXCLAMATION_MARK:{this.state=m.SCRIPT_DATA_ESCAPE_START,this._emitChars("<!");break}default:this._emitChars("<"),this.state=m.SCRIPT_DATA,this._stateScriptData(t)}}_stateScriptDataEndTagOpen(t){tu(t)?(this.state=m.SCRIPT_DATA_END_TAG_NAME,this._stateScriptDataEndTagName(t)):(this._emitChars("</"),this.state=m.SCRIPT_DATA,this._stateScriptData(t))}_stateScriptDataEndTagName(t){this.handleSpecialEndTag(t)&&(this._emitChars("</"),this.state=m.SCRIPT_DATA,this._stateScriptData(t))}_stateScriptDataEscapeStart(t){t===E.CODE_POINTS.HYPHEN_MINUS?(this.state=m.SCRIPT_DATA_ESCAPE_START_DASH,this._emitChars("-")):(this.state=m.SCRIPT_DATA,this._stateScriptData(t))}_stateScriptDataEscapeStartDash(t){t===E.CODE_POINTS.HYPHEN_MINUS?(this.state=m.SCRIPT_DATA_ESCAPED_DASH_DASH,this._emitChars("-")):(this.state=m.SCRIPT_DATA,this._stateScriptData(t))}_stateScriptDataEscaped(t){switch(t){case E.CODE_POINTS.HYPHEN_MINUS:{this.state=m.SCRIPT_DATA_ESCAPED_DASH,this._emitChars("-");break}case E.CODE_POINTS.LESS_THAN_SIGN:{this.state=m.SCRIPT_DATA_ESCAPED_LESS_THAN_SIGN;break}case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter),this._emitChars(E.REPLACEMENT_CHARACTER);break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInScriptHtmlCommentLikeText),this._emitEOFToken();break}default:this._emitCodePoint(t)}}_stateScriptDataEscapedDash(t){switch(t){case E.CODE_POINTS.HYPHEN_MINUS:{this.state=m.SCRIPT_DATA_ESCAPED_DASH_DASH,this._emitChars("-");break}case E.CODE_POINTS.LESS_THAN_SIGN:{this.state=m.SCRIPT_DATA_ESCAPED_LESS_THAN_SIGN;break}case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter),this.state=m.SCRIPT_DATA_ESCAPED,this._emitChars(E.REPLACEMENT_CHARACTER);break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInScriptHtmlCommentLikeText),this._emitEOFToken();break}default:this.state=m.SCRIPT_DATA_ESCAPED,this._emitCodePoint(t)}}_stateScriptDataEscapedDashDash(t){switch(t){case E.CODE_POINTS.HYPHEN_MINUS:{this._emitChars("-");break}case E.CODE_POINTS.LESS_THAN_SIGN:{this.state=m.SCRIPT_DATA_ESCAPED_LESS_THAN_SIGN;break}case E.CODE_POINTS.GREATER_THAN_SIGN:{this.state=m.SCRIPT_DATA,this._emitChars(">");break}case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter),this.state=m.SCRIPT_DATA_ESCAPED,this._emitChars(E.REPLACEMENT_CHARACTER);break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInScriptHtmlCommentLikeText),this._emitEOFToken();break}default:this.state=m.SCRIPT_DATA_ESCAPED,this._emitCodePoint(t)}}_stateScriptDataEscapedLessThanSign(t){t===E.CODE_POINTS.SOLIDUS?this.state=m.SCRIPT_DATA_ESCAPED_END_TAG_OPEN:tu(t)?(this._emitChars("<"),this.state=m.SCRIPT_DATA_DOUBLE_ESCAPE_START,this._stateScriptDataDoubleEscapeStart(t)):(this._emitChars("<"),this.state=m.SCRIPT_DATA_ESCAPED,this._stateScriptDataEscaped(t))}_stateScriptDataEscapedEndTagOpen(t){tu(t)?(this.state=m.SCRIPT_DATA_ESCAPED_END_TAG_NAME,this._stateScriptDataEscapedEndTagName(t)):(this._emitChars("</"),this.state=m.SCRIPT_DATA_ESCAPED,this._stateScriptDataEscaped(t))}_stateScriptDataEscapedEndTagName(t){this.handleSpecialEndTag(t)&&(this._emitChars("</"),this.state=m.SCRIPT_DATA_ESCAPED,this._stateScriptDataEscaped(t))}_stateScriptDataDoubleEscapeStart(t){if(this.preprocessor.startsWith(E.SEQUENCES.SCRIPT,!1)&&Hd(this.preprocessor.peek(E.SEQUENCES.SCRIPT.length))){this._emitCodePoint(t);for(let r=0;r<E.SEQUENCES.SCRIPT.length;r++)this._emitCodePoint(this._consume());this.state=m.SCRIPT_DATA_DOUBLE_ESCAPED}else this._ensureHibernation()||(this.state=m.SCRIPT_DATA_ESCAPED,this._stateScriptDataEscaped(t))}_stateScriptDataDoubleEscaped(t){switch(t){case E.CODE_POINTS.HYPHEN_MINUS:{this.state=m.SCRIPT_DATA_DOUBLE_ESCAPED_DASH,this._emitChars("-");break}case E.CODE_POINTS.LESS_THAN_SIGN:{this.state=m.SCRIPT_DATA_DOUBLE_ESCAPED_LESS_THAN_SIGN,this._emitChars("<");break}case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter),this._emitChars(E.REPLACEMENT_CHARACTER);break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInScriptHtmlCommentLikeText),this._emitEOFToken();break}default:this._emitCodePoint(t)}}_stateScriptDataDoubleEscapedDash(t){switch(t){case E.CODE_POINTS.HYPHEN_MINUS:{this.state=m.SCRIPT_DATA_DOUBLE_ESCAPED_DASH_DASH,this._emitChars("-");break}case E.CODE_POINTS.LESS_THAN_SIGN:{this.state=m.SCRIPT_DATA_DOUBLE_ESCAPED_LESS_THAN_SIGN,this._emitChars("<");break}case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter),this.state=m.SCRIPT_DATA_DOUBLE_ESCAPED,this._emitChars(E.REPLACEMENT_CHARACTER);break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInScriptHtmlCommentLikeText),this._emitEOFToken();break}default:this.state=m.SCRIPT_DATA_DOUBLE_ESCAPED,this._emitCodePoint(t)}}_stateScriptDataDoubleEscapedDashDash(t){switch(t){case E.CODE_POINTS.HYPHEN_MINUS:{this._emitChars("-");break}case E.CODE_POINTS.LESS_THAN_SIGN:{this.state=m.SCRIPT_DATA_DOUBLE_ESCAPED_LESS_THAN_SIGN,this._emitChars("<");break}case E.CODE_POINTS.GREATER_THAN_SIGN:{this.state=m.SCRIPT_DATA,this._emitChars(">");break}case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter),this.state=m.SCRIPT_DATA_DOUBLE_ESCAPED,this._emitChars(E.REPLACEMENT_CHARACTER);break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInScriptHtmlCommentLikeText),this._emitEOFToken();break}default:this.state=m.SCRIPT_DATA_DOUBLE_ESCAPED,this._emitCodePoint(t)}}_stateScriptDataDoubleEscapedLessThanSign(t){t===E.CODE_POINTS.SOLIDUS?(this.state=m.SCRIPT_DATA_DOUBLE_ESCAPE_END,this._emitChars("/")):(this.state=m.SCRIPT_DATA_DOUBLE_ESCAPED,this._stateScriptDataDoubleEscaped(t))}_stateScriptDataDoubleEscapeEnd(t){if(this.preprocessor.startsWith(E.SEQUENCES.SCRIPT,!1)&&Hd(this.preprocessor.peek(E.SEQUENCES.SCRIPT.length))){this._emitCodePoint(t);for(let r=0;r<E.SEQUENCES.SCRIPT.length;r++)this._emitCodePoint(this._consume());this.state=m.SCRIPT_DATA_ESCAPED}else this._ensureHibernation()||(this.state=m.SCRIPT_DATA_DOUBLE_ESCAPED,this._stateScriptDataDoubleEscaped(t))}_stateBeforeAttributeName(t){switch(t){case E.CODE_POINTS.SPACE:case E.CODE_POINTS.LINE_FEED:case E.CODE_POINTS.TABULATION:case E.CODE_POINTS.FORM_FEED:break;case E.CODE_POINTS.SOLIDUS:case E.CODE_POINTS.GREATER_THAN_SIGN:case E.CODE_POINTS.EOF:{this.state=m.AFTER_ATTRIBUTE_NAME,this._stateAfterAttributeName(t);break}case E.CODE_POINTS.EQUALS_SIGN:{this._err(Z.ERR.unexpectedEqualsSignBeforeAttributeName),this._createAttr("="),this.state=m.ATTRIBUTE_NAME;break}default:this._createAttr(""),this.state=m.ATTRIBUTE_NAME,this._stateAttributeName(t)}}_stateAttributeName(t){switch(t){case E.CODE_POINTS.SPACE:case E.CODE_POINTS.LINE_FEED:case E.CODE_POINTS.TABULATION:case E.CODE_POINTS.FORM_FEED:case E.CODE_POINTS.SOLIDUS:case E.CODE_POINTS.GREATER_THAN_SIGN:case E.CODE_POINTS.EOF:{this._leaveAttrName(),this.state=m.AFTER_ATTRIBUTE_NAME,this._stateAfterAttributeName(t);break}case E.CODE_POINTS.EQUALS_SIGN:{this._leaveAttrName(),this.state=m.BEFORE_ATTRIBUTE_VALUE;break}case E.CODE_POINTS.QUOTATION_MARK:case E.CODE_POINTS.APOSTROPHE:case E.CODE_POINTS.LESS_THAN_SIGN:{this._err(Z.ERR.unexpectedCharacterInAttributeName),this.currentAttr.name+=String.fromCodePoint(t);break}case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter),this.currentAttr.name+=E.REPLACEMENT_CHARACTER;break}default:this.currentAttr.name+=String.fromCodePoint(ea(t)?An(t):t)}}_stateAfterAttributeName(t){switch(t){case E.CODE_POINTS.SPACE:case E.CODE_POINTS.LINE_FEED:case E.CODE_POINTS.TABULATION:case E.CODE_POINTS.FORM_FEED:break;case E.CODE_POINTS.SOLIDUS:{this.state=m.SELF_CLOSING_START_TAG;break}case E.CODE_POINTS.EQUALS_SIGN:{this.state=m.BEFORE_ATTRIBUTE_VALUE;break}case E.CODE_POINTS.GREATER_THAN_SIGN:{this.state=m.DATA,this.emitCurrentTagToken();break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInTag),this._emitEOFToken();break}default:this._createAttr(""),this.state=m.ATTRIBUTE_NAME,this._stateAttributeName(t)}}_stateBeforeAttributeValue(t){switch(t){case E.CODE_POINTS.SPACE:case E.CODE_POINTS.LINE_FEED:case E.CODE_POINTS.TABULATION:case E.CODE_POINTS.FORM_FEED:break;case E.CODE_POINTS.QUOTATION_MARK:{this.state=m.ATTRIBUTE_VALUE_DOUBLE_QUOTED;break}case E.CODE_POINTS.APOSTROPHE:{this.state=m.ATTRIBUTE_VALUE_SINGLE_QUOTED;break}case E.CODE_POINTS.GREATER_THAN_SIGN:{this._err(Z.ERR.missingAttributeValue),this.state=m.DATA,this.emitCurrentTagToken();break}default:this.state=m.ATTRIBUTE_VALUE_UNQUOTED,this._stateAttributeValueUnquoted(t)}}_stateAttributeValueDoubleQuoted(t){switch(t){case E.CODE_POINTS.QUOTATION_MARK:{this.state=m.AFTER_ATTRIBUTE_VALUE_QUOTED;break}case E.CODE_POINTS.AMPERSAND:{this._startCharacterReference();break}case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter),this.currentAttr.value+=E.REPLACEMENT_CHARACTER;break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInTag),this._emitEOFToken();break}default:this.currentAttr.value+=String.fromCodePoint(t)}}_stateAttributeValueSingleQuoted(t){switch(t){case E.CODE_POINTS.APOSTROPHE:{this.state=m.AFTER_ATTRIBUTE_VALUE_QUOTED;break}case E.CODE_POINTS.AMPERSAND:{this._startCharacterReference();break}case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter),this.currentAttr.value+=E.REPLACEMENT_CHARACTER;break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInTag),this._emitEOFToken();break}default:this.currentAttr.value+=String.fromCodePoint(t)}}_stateAttributeValueUnquoted(t){switch(t){case E.CODE_POINTS.SPACE:case E.CODE_POINTS.LINE_FEED:case E.CODE_POINTS.TABULATION:case E.CODE_POINTS.FORM_FEED:{this._leaveAttrValue(),this.state=m.BEFORE_ATTRIBUTE_NAME;break}case E.CODE_POINTS.AMPERSAND:{this._startCharacterReference();break}case E.CODE_POINTS.GREATER_THAN_SIGN:{this._leaveAttrValue(),this.state=m.DATA,this.emitCurrentTagToken();break}case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter),this.currentAttr.value+=E.REPLACEMENT_CHARACTER;break}case E.CODE_POINTS.QUOTATION_MARK:case E.CODE_POINTS.APOSTROPHE:case E.CODE_POINTS.LESS_THAN_SIGN:case E.CODE_POINTS.EQUALS_SIGN:case E.CODE_POINTS.GRAVE_ACCENT:{this._err(Z.ERR.unexpectedCharacterInUnquotedAttributeValue),this.currentAttr.value+=String.fromCodePoint(t);break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInTag),this._emitEOFToken();break}default:this.currentAttr.value+=String.fromCodePoint(t)}}_stateAfterAttributeValueQuoted(t){switch(t){case E.CODE_POINTS.SPACE:case E.CODE_POINTS.LINE_FEED:case E.CODE_POINTS.TABULATION:case E.CODE_POINTS.FORM_FEED:{this._leaveAttrValue(),this.state=m.BEFORE_ATTRIBUTE_NAME;break}case E.CODE_POINTS.SOLIDUS:{this._leaveAttrValue(),this.state=m.SELF_CLOSING_START_TAG;break}case E.CODE_POINTS.GREATER_THAN_SIGN:{this._leaveAttrValue(),this.state=m.DATA,this.emitCurrentTagToken();break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInTag),this._emitEOFToken();break}default:this._err(Z.ERR.missingWhitespaceBetweenAttributes),this.state=m.BEFORE_ATTRIBUTE_NAME,this._stateBeforeAttributeName(t)}}_stateSelfClosingStartTag(t){switch(t){case E.CODE_POINTS.GREATER_THAN_SIGN:{let r=this.currentToken;r.selfClosing=!0,this.state=m.DATA,this.emitCurrentTagToken();break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInTag),this._emitEOFToken();break}default:this._err(Z.ERR.unexpectedSolidusInTag),this.state=m.BEFORE_ATTRIBUTE_NAME,this._stateBeforeAttributeName(t)}}_stateBogusComment(t){let r=this.currentToken;switch(t){case E.CODE_POINTS.GREATER_THAN_SIGN:{this.state=m.DATA,this.emitCurrentComment(r);break}case E.CODE_POINTS.EOF:{this.emitCurrentComment(r),this._emitEOFToken();break}case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter),r.data+=E.REPLACEMENT_CHARACTER;break}default:r.data+=String.fromCodePoint(t)}}_stateMarkupDeclarationOpen(t){this._consumeSequenceIfMatch(E.SEQUENCES.DASH_DASH,!0)?(this._createCommentToken(E.SEQUENCES.DASH_DASH.length+1),this.state=m.COMMENT_START):this._consumeSequenceIfMatch(E.SEQUENCES.DOCTYPE,!1)?(this.currentLocation=this.getCurrentLocation(E.SEQUENCES.DOCTYPE.length+1),this.state=m.DOCTYPE):this._consumeSequenceIfMatch(E.SEQUENCES.CDATA_START,!0)?this.inForeignNode?this.state=m.CDATA_SECTION:(this._err(Z.ERR.cdataInHtmlContent),this._createCommentToken(E.SEQUENCES.CDATA_START.length+1),this.currentToken.data="[CDATA[",this.state=m.BOGUS_COMMENT):this._ensureHibernation()||(this._err(Z.ERR.incorrectlyOpenedComment),this._createCommentToken(2),this.state=m.BOGUS_COMMENT,this._stateBogusComment(t))}_stateCommentStart(t){switch(t){case E.CODE_POINTS.HYPHEN_MINUS:{this.state=m.COMMENT_START_DASH;break}case E.CODE_POINTS.GREATER_THAN_SIGN:{this._err(Z.ERR.abruptClosingOfEmptyComment),this.state=m.DATA;let r=this.currentToken;this.emitCurrentComment(r);break}default:this.state=m.COMMENT,this._stateComment(t)}}_stateCommentStartDash(t){let r=this.currentToken;switch(t){case E.CODE_POINTS.HYPHEN_MINUS:{this.state=m.COMMENT_END;break}case E.CODE_POINTS.GREATER_THAN_SIGN:{this._err(Z.ERR.abruptClosingOfEmptyComment),this.state=m.DATA,this.emitCurrentComment(r);break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInComment),this.emitCurrentComment(r),this._emitEOFToken();break}default:r.data+="-",this.state=m.COMMENT,this._stateComment(t)}}_stateComment(t){let r=this.currentToken;switch(t){case E.CODE_POINTS.HYPHEN_MINUS:{this.state=m.COMMENT_END_DASH;break}case E.CODE_POINTS.LESS_THAN_SIGN:{r.data+="<",this.state=m.COMMENT_LESS_THAN_SIGN;break}case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter),r.data+=E.REPLACEMENT_CHARACTER;break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInComment),this.emitCurrentComment(r),this._emitEOFToken();break}default:r.data+=String.fromCodePoint(t)}}_stateCommentLessThanSign(t){let r=this.currentToken;switch(t){case E.CODE_POINTS.EXCLAMATION_MARK:{r.data+="!",this.state=m.COMMENT_LESS_THAN_SIGN_BANG;break}case E.CODE_POINTS.LESS_THAN_SIGN:{r.data+="<";break}default:this.state=m.COMMENT,this._stateComment(t)}}_stateCommentLessThanSignBang(t){t===E.CODE_POINTS.HYPHEN_MINUS?this.state=m.COMMENT_LESS_THAN_SIGN_BANG_DASH:(this.state=m.COMMENT,this._stateComment(t))}_stateCommentLessThanSignBangDash(t){t===E.CODE_POINTS.HYPHEN_MINUS?this.state=m.COMMENT_LESS_THAN_SIGN_BANG_DASH_DASH:(this.state=m.COMMENT_END_DASH,this._stateCommentEndDash(t))}_stateCommentLessThanSignBangDashDash(t){t!==E.CODE_POINTS.GREATER_THAN_SIGN&&t!==E.CODE_POINTS.EOF&&this._err(Z.ERR.nestedComment),this.state=m.COMMENT_END,this._stateCommentEnd(t)}_stateCommentEndDash(t){let r=this.currentToken;switch(t){case E.CODE_POINTS.HYPHEN_MINUS:{this.state=m.COMMENT_END;break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInComment),this.emitCurrentComment(r),this._emitEOFToken();break}default:r.data+="-",this.state=m.COMMENT,this._stateComment(t)}}_stateCommentEnd(t){let r=this.currentToken;switch(t){case E.CODE_POINTS.GREATER_THAN_SIGN:{this.state=m.DATA,this.emitCurrentComment(r);break}case E.CODE_POINTS.EXCLAMATION_MARK:{this.state=m.COMMENT_END_BANG;break}case E.CODE_POINTS.HYPHEN_MINUS:{r.data+="-";break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInComment),this.emitCurrentComment(r),this._emitEOFToken();break}default:r.data+="--",this.state=m.COMMENT,this._stateComment(t)}}_stateCommentEndBang(t){let r=this.currentToken;switch(t){case E.CODE_POINTS.HYPHEN_MINUS:{r.data+="--!",this.state=m.COMMENT_END_DASH;break}case E.CODE_POINTS.GREATER_THAN_SIGN:{this._err(Z.ERR.incorrectlyClosedComment),this.state=m.DATA,this.emitCurrentComment(r);break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInComment),this.emitCurrentComment(r),this._emitEOFToken();break}default:r.data+="--!",this.state=m.COMMENT,this._stateComment(t)}}_stateDoctype(t){switch(t){case E.CODE_POINTS.SPACE:case E.CODE_POINTS.LINE_FEED:case E.CODE_POINTS.TABULATION:case E.CODE_POINTS.FORM_FEED:{this.state=m.BEFORE_DOCTYPE_NAME;break}case E.CODE_POINTS.GREATER_THAN_SIGN:{this.state=m.BEFORE_DOCTYPE_NAME,this._stateBeforeDoctypeName(t);break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInDoctype),this._createDoctypeToken(null);let r=this.currentToken;r.forceQuirks=!0,this.emitCurrentDoctype(r),this._emitEOFToken();break}default:this._err(Z.ERR.missingWhitespaceBeforeDoctypeName),this.state=m.BEFORE_DOCTYPE_NAME,this._stateBeforeDoctypeName(t)}}_stateBeforeDoctypeName(t){if(ea(t))this._createDoctypeToken(String.fromCharCode(An(t))),this.state=m.DOCTYPE_NAME;else switch(t){case E.CODE_POINTS.SPACE:case E.CODE_POINTS.LINE_FEED:case E.CODE_POINTS.TABULATION:case E.CODE_POINTS.FORM_FEED:break;case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter),this._createDoctypeToken(E.REPLACEMENT_CHARACTER),this.state=m.DOCTYPE_NAME;break}case E.CODE_POINTS.GREATER_THAN_SIGN:{this._err(Z.ERR.missingDoctypeName),this._createDoctypeToken(null);let r=this.currentToken;r.forceQuirks=!0,this.emitCurrentDoctype(r),this.state=m.DATA;break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInDoctype),this._createDoctypeToken(null);let r=this.currentToken;r.forceQuirks=!0,this.emitCurrentDoctype(r),this._emitEOFToken();break}default:this._createDoctypeToken(String.fromCodePoint(t)),this.state=m.DOCTYPE_NAME}}_stateDoctypeName(t){let r=this.currentToken;switch(t){case E.CODE_POINTS.SPACE:case E.CODE_POINTS.LINE_FEED:case E.CODE_POINTS.TABULATION:case E.CODE_POINTS.FORM_FEED:{this.state=m.AFTER_DOCTYPE_NAME;break}case E.CODE_POINTS.GREATER_THAN_SIGN:{this.state=m.DATA,this.emitCurrentDoctype(r);break}case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter),r.name+=E.REPLACEMENT_CHARACTER;break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInDoctype),r.forceQuirks=!0,this.emitCurrentDoctype(r),this._emitEOFToken();break}default:r.name+=String.fromCodePoint(ea(t)?An(t):t)}}_stateAfterDoctypeName(t){let r=this.currentToken;switch(t){case E.CODE_POINTS.SPACE:case E.CODE_POINTS.LINE_FEED:case E.CODE_POINTS.TABULATION:case E.CODE_POINTS.FORM_FEED:break;case E.CODE_POINTS.GREATER_THAN_SIGN:{this.state=m.DATA,this.emitCurrentDoctype(r);break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInDoctype),r.forceQuirks=!0,this.emitCurrentDoctype(r),this._emitEOFToken();break}default:this._consumeSequenceIfMatch(E.SEQUENCES.PUBLIC,!1)?this.state=m.AFTER_DOCTYPE_PUBLIC_KEYWORD:this._consumeSequenceIfMatch(E.SEQUENCES.SYSTEM,!1)?this.state=m.AFTER_DOCTYPE_SYSTEM_KEYWORD:this._ensureHibernation()||(this._err(Z.ERR.invalidCharacterSequenceAfterDoctypeName),r.forceQuirks=!0,this.state=m.BOGUS_DOCTYPE,this._stateBogusDoctype(t))}}_stateAfterDoctypePublicKeyword(t){let r=this.currentToken;switch(t){case E.CODE_POINTS.SPACE:case E.CODE_POINTS.LINE_FEED:case E.CODE_POINTS.TABULATION:case E.CODE_POINTS.FORM_FEED:{this.state=m.BEFORE_DOCTYPE_PUBLIC_IDENTIFIER;break}case E.CODE_POINTS.QUOTATION_MARK:{this._err(Z.ERR.missingWhitespaceAfterDoctypePublicKeyword),r.publicId="",this.state=m.DOCTYPE_PUBLIC_IDENTIFIER_DOUBLE_QUOTED;break}case E.CODE_POINTS.APOSTROPHE:{this._err(Z.ERR.missingWhitespaceAfterDoctypePublicKeyword),r.publicId="",this.state=m.DOCTYPE_PUBLIC_IDENTIFIER_SINGLE_QUOTED;break}case E.CODE_POINTS.GREATER_THAN_SIGN:{this._err(Z.ERR.missingDoctypePublicIdentifier),r.forceQuirks=!0,this.state=m.DATA,this.emitCurrentDoctype(r);break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInDoctype),r.forceQuirks=!0,this.emitCurrentDoctype(r),this._emitEOFToken();break}default:this._err(Z.ERR.missingQuoteBeforeDoctypePublicIdentifier),r.forceQuirks=!0,this.state=m.BOGUS_DOCTYPE,this._stateBogusDoctype(t)}}_stateBeforeDoctypePublicIdentifier(t){let r=this.currentToken;switch(t){case E.CODE_POINTS.SPACE:case E.CODE_POINTS.LINE_FEED:case E.CODE_POINTS.TABULATION:case E.CODE_POINTS.FORM_FEED:break;case E.CODE_POINTS.QUOTATION_MARK:{r.publicId="",this.state=m.DOCTYPE_PUBLIC_IDENTIFIER_DOUBLE_QUOTED;break}case E.CODE_POINTS.APOSTROPHE:{r.publicId="",this.state=m.DOCTYPE_PUBLIC_IDENTIFIER_SINGLE_QUOTED;break}case E.CODE_POINTS.GREATER_THAN_SIGN:{this._err(Z.ERR.missingDoctypePublicIdentifier),r.forceQuirks=!0,this.state=m.DATA,this.emitCurrentDoctype(r);break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInDoctype),r.forceQuirks=!0,this.emitCurrentDoctype(r),this._emitEOFToken();break}default:this._err(Z.ERR.missingQuoteBeforeDoctypePublicIdentifier),r.forceQuirks=!0,this.state=m.BOGUS_DOCTYPE,this._stateBogusDoctype(t)}}_stateDoctypePublicIdentifierDoubleQuoted(t){let r=this.currentToken;switch(t){case E.CODE_POINTS.QUOTATION_MARK:{this.state=m.AFTER_DOCTYPE_PUBLIC_IDENTIFIER;break}case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter),r.publicId+=E.REPLACEMENT_CHARACTER;break}case E.CODE_POINTS.GREATER_THAN_SIGN:{this._err(Z.ERR.abruptDoctypePublicIdentifier),r.forceQuirks=!0,this.emitCurrentDoctype(r),this.state=m.DATA;break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInDoctype),r.forceQuirks=!0,this.emitCurrentDoctype(r),this._emitEOFToken();break}default:r.publicId+=String.fromCodePoint(t)}}_stateDoctypePublicIdentifierSingleQuoted(t){let r=this.currentToken;switch(t){case E.CODE_POINTS.APOSTROPHE:{this.state=m.AFTER_DOCTYPE_PUBLIC_IDENTIFIER;break}case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter),r.publicId+=E.REPLACEMENT_CHARACTER;break}case E.CODE_POINTS.GREATER_THAN_SIGN:{this._err(Z.ERR.abruptDoctypePublicIdentifier),r.forceQuirks=!0,this.emitCurrentDoctype(r),this.state=m.DATA;break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInDoctype),r.forceQuirks=!0,this.emitCurrentDoctype(r),this._emitEOFToken();break}default:r.publicId+=String.fromCodePoint(t)}}_stateAfterDoctypePublicIdentifier(t){let r=this.currentToken;switch(t){case E.CODE_POINTS.SPACE:case E.CODE_POINTS.LINE_FEED:case E.CODE_POINTS.TABULATION:case E.CODE_POINTS.FORM_FEED:{this.state=m.BETWEEN_DOCTYPE_PUBLIC_AND_SYSTEM_IDENTIFIERS;break}case E.CODE_POINTS.GREATER_THAN_SIGN:{this.state=m.DATA,this.emitCurrentDoctype(r);break}case E.CODE_POINTS.QUOTATION_MARK:{this._err(Z.ERR.missingWhitespaceBetweenDoctypePublicAndSystemIdentifiers),r.systemId="",this.state=m.DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED;break}case E.CODE_POINTS.APOSTROPHE:{this._err(Z.ERR.missingWhitespaceBetweenDoctypePublicAndSystemIdentifiers),r.systemId="",this.state=m.DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED;break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInDoctype),r.forceQuirks=!0,this.emitCurrentDoctype(r),this._emitEOFToken();break}default:this._err(Z.ERR.missingQuoteBeforeDoctypeSystemIdentifier),r.forceQuirks=!0,this.state=m.BOGUS_DOCTYPE,this._stateBogusDoctype(t)}}_stateBetweenDoctypePublicAndSystemIdentifiers(t){let r=this.currentToken;switch(t){case E.CODE_POINTS.SPACE:case E.CODE_POINTS.LINE_FEED:case E.CODE_POINTS.TABULATION:case E.CODE_POINTS.FORM_FEED:break;case E.CODE_POINTS.GREATER_THAN_SIGN:{this.emitCurrentDoctype(r),this.state=m.DATA;break}case E.CODE_POINTS.QUOTATION_MARK:{r.systemId="",this.state=m.DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED;break}case E.CODE_POINTS.APOSTROPHE:{r.systemId="",this.state=m.DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED;break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInDoctype),r.forceQuirks=!0,this.emitCurrentDoctype(r),this._emitEOFToken();break}default:this._err(Z.ERR.missingQuoteBeforeDoctypeSystemIdentifier),r.forceQuirks=!0,this.state=m.BOGUS_DOCTYPE,this._stateBogusDoctype(t)}}_stateAfterDoctypeSystemKeyword(t){let r=this.currentToken;switch(t){case E.CODE_POINTS.SPACE:case E.CODE_POINTS.LINE_FEED:case E.CODE_POINTS.TABULATION:case E.CODE_POINTS.FORM_FEED:{this.state=m.BEFORE_DOCTYPE_SYSTEM_IDENTIFIER;break}case E.CODE_POINTS.QUOTATION_MARK:{this._err(Z.ERR.missingWhitespaceAfterDoctypeSystemKeyword),r.systemId="",this.state=m.DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED;break}case E.CODE_POINTS.APOSTROPHE:{this._err(Z.ERR.missingWhitespaceAfterDoctypeSystemKeyword),r.systemId="",this.state=m.DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED;break}case E.CODE_POINTS.GREATER_THAN_SIGN:{this._err(Z.ERR.missingDoctypeSystemIdentifier),r.forceQuirks=!0,this.state=m.DATA,this.emitCurrentDoctype(r);break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInDoctype),r.forceQuirks=!0,this.emitCurrentDoctype(r),this._emitEOFToken();break}default:this._err(Z.ERR.missingQuoteBeforeDoctypeSystemIdentifier),r.forceQuirks=!0,this.state=m.BOGUS_DOCTYPE,this._stateBogusDoctype(t)}}_stateBeforeDoctypeSystemIdentifier(t){let r=this.currentToken;switch(t){case E.CODE_POINTS.SPACE:case E.CODE_POINTS.LINE_FEED:case E.CODE_POINTS.TABULATION:case E.CODE_POINTS.FORM_FEED:break;case E.CODE_POINTS.QUOTATION_MARK:{r.systemId="",this.state=m.DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED;break}case E.CODE_POINTS.APOSTROPHE:{r.systemId="",this.state=m.DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED;break}case E.CODE_POINTS.GREATER_THAN_SIGN:{this._err(Z.ERR.missingDoctypeSystemIdentifier),r.forceQuirks=!0,this.state=m.DATA,this.emitCurrentDoctype(r);break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInDoctype),r.forceQuirks=!0,this.emitCurrentDoctype(r),this._emitEOFToken();break}default:this._err(Z.ERR.missingQuoteBeforeDoctypeSystemIdentifier),r.forceQuirks=!0,this.state=m.BOGUS_DOCTYPE,this._stateBogusDoctype(t)}}_stateDoctypeSystemIdentifierDoubleQuoted(t){let r=this.currentToken;switch(t){case E.CODE_POINTS.QUOTATION_MARK:{this.state=m.AFTER_DOCTYPE_SYSTEM_IDENTIFIER;break}case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter),r.systemId+=E.REPLACEMENT_CHARACTER;break}case E.CODE_POINTS.GREATER_THAN_SIGN:{this._err(Z.ERR.abruptDoctypeSystemIdentifier),r.forceQuirks=!0,this.emitCurrentDoctype(r),this.state=m.DATA;break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInDoctype),r.forceQuirks=!0,this.emitCurrentDoctype(r),this._emitEOFToken();break}default:r.systemId+=String.fromCodePoint(t)}}_stateDoctypeSystemIdentifierSingleQuoted(t){let r=this.currentToken;switch(t){case E.CODE_POINTS.APOSTROPHE:{this.state=m.AFTER_DOCTYPE_SYSTEM_IDENTIFIER;break}case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter),r.systemId+=E.REPLACEMENT_CHARACTER;break}case E.CODE_POINTS.GREATER_THAN_SIGN:{this._err(Z.ERR.abruptDoctypeSystemIdentifier),r.forceQuirks=!0,this.emitCurrentDoctype(r),this.state=m.DATA;break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInDoctype),r.forceQuirks=!0,this.emitCurrentDoctype(r),this._emitEOFToken();break}default:r.systemId+=String.fromCodePoint(t)}}_stateAfterDoctypeSystemIdentifier(t){let r=this.currentToken;switch(t){case E.CODE_POINTS.SPACE:case E.CODE_POINTS.LINE_FEED:case E.CODE_POINTS.TABULATION:case E.CODE_POINTS.FORM_FEED:break;case E.CODE_POINTS.GREATER_THAN_SIGN:{this.emitCurrentDoctype(r),this.state=m.DATA;break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInDoctype),r.forceQuirks=!0,this.emitCurrentDoctype(r),this._emitEOFToken();break}default:this._err(Z.ERR.unexpectedCharacterAfterDoctypeSystemIdentifier),this.state=m.BOGUS_DOCTYPE,this._stateBogusDoctype(t)}}_stateBogusDoctype(t){let r=this.currentToken;switch(t){case E.CODE_POINTS.GREATER_THAN_SIGN:{this.emitCurrentDoctype(r),this.state=m.DATA;break}case E.CODE_POINTS.NULL:{this._err(Z.ERR.unexpectedNullCharacter);break}case E.CODE_POINTS.EOF:{this.emitCurrentDoctype(r),this._emitEOFToken();break}default:}}_stateCdataSection(t){switch(t){case E.CODE_POINTS.RIGHT_SQUARE_BRACKET:{this.state=m.CDATA_SECTION_BRACKET;break}case E.CODE_POINTS.EOF:{this._err(Z.ERR.eofInCdata),this._emitEOFToken();break}default:this._emitCodePoint(t)}}_stateCdataSectionBracket(t){t===E.CODE_POINTS.RIGHT_SQUARE_BRACKET?this.state=m.CDATA_SECTION_END:(this._emitChars("]"),this.state=m.CDATA_SECTION,this._stateCdataSection(t))}_stateCdataSectionEnd(t){switch(t){case E.CODE_POINTS.GREATER_THAN_SIGN:{this.state=m.DATA;break}case E.CODE_POINTS.RIGHT_SQUARE_BRACKET:{this._emitChars("]");break}default:this._emitChars("]]"),this.state=m.CDATA_SECTION,this._stateCdataSection(t)}}_stateCharacterReference(){let t=this.entityDecoder.write(this.preprocessor.html,this.preprocessor.pos);if(t<0)if(this.preprocessor.lastChunkWritten)t=this.entityDecoder.end();else{this.active=!1,this.preprocessor.pos=this.preprocessor.html.length-1,this.consumedAfterSnapshot=0,this.preprocessor.endOfChunkHit=!0;return}t===0?(this.preprocessor.pos=this.entityStartPos,this._flushCodePointConsumedAsCharacterReference(E.CODE_POINTS.AMPERSAND),this.state=!this._isCharacterReferenceInAttribute()&&kd(this.preprocessor.peek(1))?m.AMBIGUOUS_AMPERSAND:this.returnState):this.state=this.returnState}_stateAmbiguousAmpersand(t){kd(t)?this._flushCodePointConsumedAsCharacterReference(t):(t===E.CODE_POINTS.SEMICOLON&&this._err(Z.ERR.unknownNamedCharacterReference),this.state=this.returnState,this._callState(t))}};o0.Tokenizer=lo});var Yd=R(gn=>{"use strict";Object.defineProperty(gn,"__esModule",{value:!0});gn.OpenElementStack=void 0;var ae=Or(),zd=new Set([ae.TAG_ID.DD,ae.TAG_ID.DT,ae.TAG_ID.LI,ae.TAG_ID.OPTGROUP,ae.TAG_ID.OPTION,ae.TAG_ID.P,ae.TAG_ID.RB,ae.TAG_ID.RP,ae.TAG_ID.RT,ae.TAG_ID.RTC]),Gd=new Set([...zd,ae.TAG_ID.CAPTION,ae.TAG_ID.COLGROUP,ae.TAG_ID.TBODY,ae.TAG_ID.TD,ae.TAG_ID.TFOOT,ae.TAG_ID.TH,ae.TAG_ID.THEAD,ae.TAG_ID.TR]),mn=new Set([ae.TAG_ID.APPLET,ae.TAG_ID.CAPTION,ae.TAG_ID.HTML,ae.TAG_ID.MARQUEE,ae.TAG_ID.OBJECT,ae.TAG_ID.TABLE,ae.TAG_ID.TD,ae.TAG_ID.TEMPLATE,ae.TAG_ID.TH]),i4=new Set([...mn,ae.TAG_ID.OL,ae.TAG_ID.UL]),s4=new Set([...mn,ae.TAG_ID.BUTTON]),qd=new Set([ae.TAG_ID.ANNOTATION_XML,ae.TAG_ID.MI,ae.TAG_ID.MN,ae.TAG_ID.MO,ae.TAG_ID.MS,ae.TAG_ID.MTEXT]),jd=new Set([ae.TAG_ID.DESC,ae.TAG_ID.FOREIGN_OBJECT,ae.TAG_ID.TITLE]),o4=new Set([ae.TAG_ID.TR,ae.TAG_ID.TEMPLATE,ae.TAG_ID.HTML]),c4=new Set([ae.TAG_ID.TBODY,ae.TAG_ID.TFOOT,ae.TAG_ID.THEAD,ae.TAG_ID.TEMPLATE,ae.TAG_ID.HTML]),f4=new Set([ae.TAG_ID.TABLE,ae.TAG_ID.TEMPLATE,ae.TAG_ID.HTML]),l4=new Set([ae.TAG_ID.TD,ae.TAG_ID.TH]),po=class{get currentTmplContentOrNode(){return this._isInTemplate()?this.treeAdapter.getTemplateContent(this.current):this.current}constructor(t,r,u){this.treeAdapter=r,this.handler=u,this.items=[],this.tagIDs=[],this.stackTop=-1,this.tmplCount=0,this.currentTagId=ae.TAG_ID.UNKNOWN,this.current=t}_indexOf(t){return this.items.lastIndexOf(t,this.stackTop)}_isInTemplate(){return this.currentTagId===ae.TAG_ID.TEMPLATE&&this.treeAdapter.getNamespaceURI(this.current)===ae.NS.HTML}_updateCurrentElement(){this.current=this.items[this.stackTop],this.currentTagId=this.tagIDs[this.stackTop]}push(t,r){this.stackTop++,this.items[this.stackTop]=t,this.current=t,this.tagIDs[this.stackTop]=r,this.currentTagId=r,this._isInTemplate()&&this.tmplCount++,this.handler.onItemPush(t,r,!0)}pop(){let t=this.current;this.tmplCount>0&&this._isInTemplate()&&this.tmplCount--,this.stackTop--,this._updateCurrentElement(),this.handler.onItemPop(t,!0)}replace(t,r){let u=this._indexOf(t);this.items[u]=r,u===this.stackTop&&(this.current=r)}insertAfter(t,r,u){let a=this._indexOf(t)+1;this.items.splice(a,0,r),this.tagIDs.splice(a,0,u),this.stackTop++,a===this.stackTop&&this._updateCurrentElement(),this.current&&this.currentTagId!==void 0&&this.handler.onItemPush(this.current,this.currentTagId,a===this.stackTop)}popUntilTagNamePopped(t){let r=this.stackTop+1;do r=this.tagIDs.lastIndexOf(t,r-1);while(r>0&&this.treeAdapter.getNamespaceURI(this.items[r])!==ae.NS.HTML);this.shortenToLength(Math.max(r,0))}shortenToLength(t){for(;this.stackTop>=t;){let r=this.current;this.tmplCount>0&&this._isInTemplate()&&(this.tmplCount-=1),this.stackTop--,this._updateCurrentElement(),this.handler.onItemPop(r,this.stackTop<t)}}popUntilElementPopped(t){let r=this._indexOf(t);this.shortenToLength(Math.max(r,0))}popUntilPopped(t,r){let u=this._indexOfTagNames(t,r);this.shortenToLength(Math.max(u,0))}popUntilNumberedHeaderPopped(){this.popUntilPopped(ae.NUMBERED_HEADERS,ae.NS.HTML)}popUntilTableCellPopped(){this.popUntilPopped(l4,ae.NS.HTML)}popAllUpToHtmlElement(){this.tmplCount=0,this.shortenToLength(1)}_indexOfTagNames(t,r){for(let u=this.stackTop;u>=0;u--)if(t.has(this.tagIDs[u])&&this.treeAdapter.getNamespaceURI(this.items[u])===r)return u;return-1}clearBackTo(t,r){let u=this._indexOfTagNames(t,r);this.shortenToLength(u+1)}clearBackToTableContext(){this.clearBackTo(f4,ae.NS.HTML)}clearBackToTableBodyContext(){this.clearBackTo(c4,ae.NS.HTML)}clearBackToTableRowContext(){this.clearBackTo(o4,ae.NS.HTML)}remove(t){let r=this._indexOf(t);r>=0&&(r===this.stackTop?this.pop():(this.items.splice(r,1),this.tagIDs.splice(r,1),this.stackTop--,this._updateCurrentElement(),this.handler.onItemPop(t,!1)))}tryPeekProperlyNestedBodyElement(){return this.stackTop>=1&&this.tagIDs[1]===ae.TAG_ID.BODY?this.items[1]:null}contains(t){return this._indexOf(t)>-1}getCommonAncestor(t){let r=this._indexOf(t)-1;return r>=0?this.items[r]:null}isRootHtmlElementCurrent(){return this.stackTop===0&&this.tagIDs[0]===ae.TAG_ID.HTML}hasInDynamicScope(t,r){for(let u=this.stackTop;u>=0;u--){let a=this.tagIDs[u];switch(this.treeAdapter.getNamespaceURI(this.items[u])){case ae.NS.HTML:{if(a===t)return!0;if(r.has(a))return!1;break}case ae.NS.SVG:{if(jd.has(a))return!1;break}case ae.NS.MATHML:{if(qd.has(a))return!1;break}}}return!0}hasInScope(t){return this.hasInDynamicScope(t,mn)}hasInListItemScope(t){return this.hasInDynamicScope(t,i4)}hasInButtonScope(t){return this.hasInDynamicScope(t,s4)}hasNumberedHeaderInScope(){for(let t=this.stackTop;t>=0;t--){let r=this.tagIDs[t];switch(this.treeAdapter.getNamespaceURI(this.items[t])){case ae.NS.HTML:{if(ae.NUMBERED_HEADERS.has(r))return!0;if(mn.has(r))return!1;break}case ae.NS.SVG:{if(jd.has(r))return!1;break}case ae.NS.MATHML:{if(qd.has(r))return!1;break}}}return!0}hasInTableScope(t){for(let r=this.stackTop;r>=0;r--)if(this.treeAdapter.getNamespaceURI(this.items[r])===ae.NS.HTML)switch(this.tagIDs[r]){case t:return!0;case ae.TAG_ID.TABLE:case ae.TAG_ID.HTML:return!1}return!0}hasTableBodyContextInTableScope(){for(let t=this.stackTop;t>=0;t--)if(this.treeAdapter.getNamespaceURI(this.items[t])===ae.NS.HTML)switch(this.tagIDs[t]){case ae.TAG_ID.TBODY:case ae.TAG_ID.THEAD:case ae.TAG_ID.TFOOT:return!0;case ae.TAG_ID.TABLE:case ae.TAG_ID.HTML:return!1}return!0}hasInSelectScope(t){for(let r=this.stackTop;r>=0;r--)if(this.treeAdapter.getNamespaceURI(this.items[r])===ae.NS.HTML)switch(this.tagIDs[r]){case t:return!0;case ae.TAG_ID.OPTION:case ae.TAG_ID.OPTGROUP:break;default:return!1}return!0}generateImpliedEndTags(){for(;this.currentTagId!==void 0&&zd.has(this.currentTagId);)this.pop()}generateImpliedEndTagsThoroughly(){for(;this.currentTagId!==void 0&&Gd.has(this.currentTagId);)this.pop()}generateImpliedEndTagsWithExclusion(t){for(;this.currentTagId!==void 0&&this.currentTagId!==t&&Gd.has(this.currentTagId);)this.pop()}};gn.OpenElementStack=po});var Vd=R(c0=>{"use strict";Object.defineProperty(c0,"__esModule",{value:!0});c0.FormattingElementList=c0.EntryType=void 0;var bo=3,Rr;(function(e){e[e.Marker=0]="Marker",e[e.Element=1]="Element"})(Rr||(c0.EntryType=Rr={}));var Wd={type:Rr.Marker},_o=class{constructor(t){this.treeAdapter=t,this.entries=[],this.bookmark=null}_getNoahArkConditionCandidates(t,r){let u=[],a=r.length,n=this.treeAdapter.getTagName(t),s=this.treeAdapter.getNamespaceURI(t);for(let i=0;i<this.entries.length;i++){let c=this.entries[i];if(c.type===Rr.Marker)break;let{element:o}=c;if(this.treeAdapter.getTagName(o)===n&&this.treeAdapter.getNamespaceURI(o)===s){let f=this.treeAdapter.getAttrList(o);f.length===a&&u.push({idx:i,attrs:f})}}return u}_ensureNoahArkCondition(t){if(this.entries.length<bo)return;let r=this.treeAdapter.getAttrList(t),u=this._getNoahArkConditionCandidates(t,r);if(u.length<bo)return;let a=new Map(r.map(s=>[s.name,s.value])),n=0;for(let s=0;s<u.length;s++){let i=u[s];i.attrs.every(c=>a.get(c.name)===c.value)&&(n+=1,n>=bo&&this.entries.splice(i.idx,1))}}insertMarker(){this.entries.unshift(Wd)}pushElement(t,r){this._ensureNoahArkCondition(t),this.entries.unshift({type:Rr.Element,element:t,token:r})}insertElementAfterBookmark(t,r){let u=this.entries.indexOf(this.bookmark);this.entries.splice(u,0,{type:Rr.Element,element:t,token:r})}removeEntry(t){let r=this.entries.indexOf(t);r!==-1&&this.entries.splice(r,1)}clearToLastMarker(){let t=this.entries.indexOf(Wd);t===-1?this.entries.length=0:this.entries.splice(0,t+1)}getElementEntryInScopeWithTagName(t){let r=this.entries.find(u=>u.type===Rr.Marker||this.treeAdapter.getTagName(u.element)===t);return r&&r.type===Rr.Element?r:null}getElementEntry(t){return this.entries.find(r=>r.type===Rr.Element&&r.element===t)}};c0.FormattingElementList=_o});var vn=R(Kt=>{"use strict";Object.defineProperty(Kt,"__esModule",{value:!0});Kt.defaultTreeAdapter=void 0;var d4=Or();Kt.defaultTreeAdapter={createDocument(){return{nodeName:"#document",mode:d4.DOCUMENT_MODE.NO_QUIRKS,childNodes:[]}},createDocumentFragment(){return{nodeName:"#document-fragment",childNodes:[]}},createElement(e,t,r){return{nodeName:e,tagName:e,attrs:r,namespaceURI:t,childNodes:[],parentNode:null}},createCommentNode(e){return{nodeName:"#comment",data:e,parentNode:null}},createTextNode(e){return{nodeName:"#text",value:e,parentNode:null}},appendChild(e,t){e.childNodes.push(t),t.parentNode=e},insertBefore(e,t,r){let u=e.childNodes.indexOf(r);e.childNodes.splice(u,0,t),t.parentNode=e},setTemplateContent(e,t){e.content=t},getTemplateContent(e){return e.content},setDocumentType(e,t,r,u){let a=e.childNodes.find(n=>n.nodeName==="#documentType");if(a)a.name=t,a.publicId=r,a.systemId=u;else{let n={nodeName:"#documentType",name:t,publicId:r,systemId:u,parentNode:null};Kt.defaultTreeAdapter.appendChild(e,n)}},setDocumentMode(e,t){e.mode=t},getDocumentMode(e){return e.mode},detachNode(e){if(e.parentNode){let t=e.parentNode.childNodes.indexOf(e);e.parentNode.childNodes.splice(t,1),e.parentNode=null}},insertText(e,t){if(e.childNodes.length>0){let r=e.childNodes[e.childNodes.length-1];if(Kt.defaultTreeAdapter.isTextNode(r)){r.value+=t;return}}Kt.defaultTreeAdapter.appendChild(e,Kt.defaultTreeAdapter.createTextNode(t))},insertTextBefore(e,t,r){let u=e.childNodes[e.childNodes.indexOf(r)-1];u&&Kt.defaultTreeAdapter.isTextNode(u)?u.value+=t:Kt.defaultTreeAdapter.insertBefore(e,Kt.defaultTreeAdapter.createTextNode(t),r)},adoptAttributes(e,t){let r=new Set(e.attrs.map(u=>u.name));for(let u=0;u<t.length;u++)r.has(t[u].name)||e.attrs.push(t[u])},getFirstChild(e){return e.childNodes[0]},getChildNodes(e){return e.childNodes},getParentNode(e){return e.parentNode},getAttrList(e){return e.attrs},getTagName(e){return e.tagName},getNamespaceURI(e){return e.namespaceURI},getTextNodeContent(e){return e.value},getCommentNodeContent(e){return e.data},getDocumentTypeNodeName(e){return e.name},getDocumentTypeNodePublicId(e){return e.publicId},getDocumentTypeNodeSystemId(e){return e.systemId},isTextNode(e){return e.nodeName==="#text"},isCommentNode(e){return e.nodeName==="#comment"},isDocumentTypeNode(e){return e.nodeName==="#documentType"},isElementNode(e){return Object.prototype.hasOwnProperty.call(e,"tagName")},setNodeSourceCodeLocation(e,t){e.sourceCodeLocation=t},getNodeSourceCodeLocation(e){return e.sourceCodeLocation},updateNodeSourceCodeLocation(e,t){e.sourceCodeLocation=Object.assign(Object.assign({},e.sourceCodeLocation),t)}}});var Zd=R(yn=>{"use strict";Object.defineProperty(yn,"__esModule",{value:!0});yn.isConforming=T4;yn.getDocumentMode=x4;var f0=Or(),Xd="html",h4="about:legacy-compat",p4="http://www.ibm.com/data/dtd/v11/ibmxhtml1-transitional.dtd",Kd=["+//silmaril//dtd html pro v0r11 19970101//","-//as//dtd html 3.0 aswedit + extensions//","-//advasoft ltd//dtd html 3.0 aswedit + extensions//","-//ietf//dtd html 2.0 level 1//","-//ietf//dtd html 2.0 level 2//","-//ietf//dtd html 2.0 strict level 1//","-//ietf//dtd html 2.0 strict level 2//","-//ietf//dtd html 2.0 strict//","-//ietf//dtd html 2.0//","-//ietf//dtd html 2.1e//","-//ietf//dtd html 3.0//","-//ietf//dtd html 3.2 final//","-//ietf//dtd html 3.2//","-//ietf//dtd html 3//","-//ietf//dtd html level 0//","-//ietf//dtd html level 1//","-//ietf//dtd html level 2//","-//ietf//dtd html level 3//","-//ietf//dtd html strict level 0//","-//ietf//dtd html strict level 1//","-//ietf//dtd html strict level 2//","-//ietf//dtd html strict level 3//","-//ietf//dtd html strict//","-//ietf//dtd html//","-//metrius//dtd metrius presentational//","-//microsoft//dtd internet explorer 2.0 html strict//","-//microsoft//dtd internet explorer 2.0 html//","-//microsoft//dtd internet explorer 2.0 tables//","-//microsoft//dtd internet explorer 3.0 html strict//","-//microsoft//dtd internet explorer 3.0 html//","-//microsoft//dtd internet explorer 3.0 tables//","-//netscape comm. corp.//dtd html//","-//netscape comm. corp.//dtd strict html//","-//o\'reilly and associates//dtd html 2.0//","-//o\'reilly and associates//dtd html extended 1.0//","-//o\'reilly and associates//dtd html extended relaxed 1.0//","-//sq//dtd html 2.0 hotmetal + extensions//","-//softquad software//dtd hotmetal pro 6.0::19990601::extensions to html 4.0//","-//softquad//dtd hotmetal pro 4.0::19971010::extensions to html 4.0//","-//spyglass//dtd html 2.0 extended//","-//sun microsystems corp.//dtd hotjava html//","-//sun microsystems corp.//dtd hotjava strict html//","-//w3c//dtd html 3 1995-03-24//","-//w3c//dtd html 3.2 draft//","-//w3c//dtd html 3.2 final//","-//w3c//dtd html 3.2//","-//w3c//dtd html 3.2s draft//","-//w3c//dtd html 4.0 frameset//","-//w3c//dtd html 4.0 transitional//","-//w3c//dtd html experimental 19960712//","-//w3c//dtd html experimental 970421//","-//w3c//dtd w3 html//","-//w3o//dtd w3 html 3.0//","-//webtechs//dtd mozilla html 2.0//","-//webtechs//dtd mozilla html//"],b4=[...Kd,"-//w3c//dtd html 4.01 frameset//","-//w3c//dtd html 4.01 transitional//"],_4=new Set(["-//w3o//dtd w3 html strict 3.0//en//","-/w3c/dtd html 4.0 transitional/en","html"]),$d=["-//w3c//dtd xhtml 1.0 frameset//","-//w3c//dtd xhtml 1.0 transitional//"],E4=[...$d,"-//w3c//dtd html 4.01 frameset//","-//w3c//dtd html 4.01 transitional//"];function Qd(e,t){return t.some(r=>e.startsWith(r))}function T4(e){return e.name===Xd&&e.publicId===null&&(e.systemId===null||e.systemId===h4)}function x4(e){if(e.name!==Xd)return f0.DOCUMENT_MODE.QUIRKS;let{systemId:t}=e;if(t&&t.toLowerCase()===p4)return f0.DOCUMENT_MODE.QUIRKS;let{publicId:r}=e;if(r!==null){if(r=r.toLowerCase(),_4.has(r))return f0.DOCUMENT_MODE.QUIRKS;let u=t===null?b4:Kd;if(Qd(r,u))return f0.DOCUMENT_MODE.QUIRKS;if(u=t===null?$d:E4,Qd(r,u))return f0.DOCUMENT_MODE.LIMITED_QUIRKS}return f0.DOCUMENT_MODE.NO_QUIRKS}});var Eo=R($t=>{"use strict";Object.defineProperty($t,"__esModule",{value:!0});$t.SVG_TAG_NAMES_ADJUSTMENT_MAP=void 0;$t.causesExit=D4;$t.adjustTokenMathMLAttrs=C4;$t.adjustTokenSVGAttrs=I4;$t.adjustTokenXMLAttrs=S4;$t.adjustTokenSVGTagName=N4;$t.isIntegrationPoint=P4;var ne=Or(),Jd={TEXT_HTML:"text/html",APPLICATION_XML:"application/xhtml+xml"},A4="definitionurl",m4="definitionURL",g4=new Map(["attributeName","attributeType","baseFrequency","baseProfile","calcMode","clipPathUnits","diffuseConstant","edgeMode","filterUnits","glyphRef","gradientTransform","gradientUnits","kernelMatrix","kernelUnitLength","keyPoints","keySplines","keyTimes","lengthAdjust","limitingConeAngle","markerHeight","markerUnits","markerWidth","maskContentUnits","maskUnits","numOctaves","pathLength","patternContentUnits","patternTransform","patternUnits","pointsAtX","pointsAtY","pointsAtZ","preserveAlpha","preserveAspectRatio","primitiveUnits","refX","refY","repeatCount","repeatDur","requiredExtensions","requiredFeatures","specularConstant","specularExponent","spreadMethod","startOffset","stdDeviation","stitchTiles","surfaceScale","systemLanguage","tableValues","targetX","targetY","textLength","viewBox","viewTarget","xChannelSelector","yChannelSelector","zoomAndPan"].map(e=>[e.toLowerCase(),e])),v4=new Map([["xlink:actuate",{prefix:"xlink",name:"actuate",namespace:ne.NS.XLINK}],["xlink:arcrole",{prefix:"xlink",name:"arcrole",namespace:ne.NS.XLINK}],["xlink:href",{prefix:"xlink",name:"href",namespace:ne.NS.XLINK}],["xlink:role",{prefix:"xlink",name:"role",namespace:ne.NS.XLINK}],["xlink:show",{prefix:"xlink",name:"show",namespace:ne.NS.XLINK}],["xlink:title",{prefix:"xlink",name:"title",namespace:ne.NS.XLINK}],["xlink:type",{prefix:"xlink",name:"type",namespace:ne.NS.XLINK}],["xml:lang",{prefix:"xml",name:"lang",namespace:ne.NS.XML}],["xml:space",{prefix:"xml",name:"space",namespace:ne.NS.XML}],["xmlns",{prefix:"",name:"xmlns",namespace:ne.NS.XMLNS}],["xmlns:xlink",{prefix:"xmlns",name:"xlink",namespace:ne.NS.XMLNS}]]);$t.SVG_TAG_NAMES_ADJUSTMENT_MAP=new Map(["altGlyph","altGlyphDef","altGlyphItem","animateColor","animateMotion","animateTransform","clipPath","feBlend","feColorMatrix","feComponentTransfer","feComposite","feConvolveMatrix","feDiffuseLighting","feDisplacementMap","feDistantLight","feFlood","feFuncA","feFuncB","feFuncG","feFuncR","feGaussianBlur","feImage","feMerge","feMergeNode","feMorphology","feOffset","fePointLight","feSpecularLighting","feSpotLight","feTile","feTurbulence","foreignObject","glyphRef","linearGradient","radialGradient","textPath"].map(e=>[e.toLowerCase(),e]));var y4=new Set([ne.TAG_ID.B,ne.TAG_ID.BIG,ne.TAG_ID.BLOCKQUOTE,ne.TAG_ID.BODY,ne.TAG_ID.BR,ne.TAG_ID.CENTER,ne.TAG_ID.CODE,ne.TAG_ID.DD,ne.TAG_ID.DIV,ne.TAG_ID.DL,ne.TAG_ID.DT,ne.TAG_ID.EM,ne.TAG_ID.EMBED,ne.TAG_ID.H1,ne.TAG_ID.H2,ne.TAG_ID.H3,ne.TAG_ID.H4,ne.TAG_ID.H5,ne.TAG_ID.H6,ne.TAG_ID.HEAD,ne.TAG_ID.HR,ne.TAG_ID.I,ne.TAG_ID.IMG,ne.TAG_ID.LI,ne.TAG_ID.LISTING,ne.TAG_ID.MENU,ne.TAG_ID.META,ne.TAG_ID.NOBR,ne.TAG_ID.OL,ne.TAG_ID.P,ne.TAG_ID.PRE,ne.TAG_ID.RUBY,ne.TAG_ID.S,ne.TAG_ID.SMALL,ne.TAG_ID.SPAN,ne.TAG_ID.STRONG,ne.TAG_ID.STRIKE,ne.TAG_ID.SUB,ne.TAG_ID.SUP,ne.TAG_ID.TABLE,ne.TAG_ID.TT,ne.TAG_ID.U,ne.TAG_ID.UL,ne.TAG_ID.VAR]);function D4(e){let t=e.tagID;return t===ne.TAG_ID.FONT&&e.attrs.some(({name:u})=>u===ne.ATTRS.COLOR||u===ne.ATTRS.SIZE||u===ne.ATTRS.FACE)||y4.has(t)}function C4(e){for(let t=0;t<e.attrs.length;t++)if(e.attrs[t].name===A4){e.attrs[t].name=m4;break}}function I4(e){for(let t=0;t<e.attrs.length;t++){let r=g4.get(e.attrs[t].name);r!=null&&(e.attrs[t].name=r)}}function S4(e){for(let t=0;t<e.attrs.length;t++){let r=v4.get(e.attrs[t].name);r&&(e.attrs[t].prefix=r.prefix,e.attrs[t].name=r.name,e.attrs[t].namespace=r.namespace)}}function N4(e){let t=$t.SVG_TAG_NAMES_ADJUSTMENT_MAP.get(e.tagName);t!=null&&(e.tagName=t,e.tagID=(0,ne.getTagID)(e.tagName))}function O4(e,t){return t===ne.NS.MATHML&&(e===ne.TAG_ID.MI||e===ne.TAG_ID.MO||e===ne.TAG_ID.MN||e===ne.TAG_ID.MS||e===ne.TAG_ID.MTEXT)}function R4(e,t,r){if(t===ne.NS.MATHML&&e===ne.TAG_ID.ANNOTATION_XML){for(let u=0;u<r.length;u++)if(r[u].name===ne.ATTRS.ENCODING){let a=r[u].value.toLowerCase();return a===Jd.TEXT_HTML||a===Jd.APPLICATION_XML}}return t===ne.NS.SVG&&(e===ne.TAG_ID.FOREIGN_OBJECT||e===ne.TAG_ID.DESC||e===ne.TAG_ID.TITLE)}function P4(e,t,r,u){return(!u||u===ne.NS.HTML)&&R4(e,t,r)||(!u||u===ne.NS.MATHML)&&O4(e,t)}});var Do=R(Pn=>{"use strict";Object.defineProperty(Pn,"__esModule",{value:!0});Pn.Parser=void 0;var Tt=ho(),B4=Yd(),e1=Vd(),w4=vn(),t1=Zd(),hr=Eo(),at=Z0(),n1=dn(),l=Or(),We=bn(),L4="hidden",M4=8,F4=3,y;(function(e){e[e.INITIAL=0]="INITIAL",e[e.BEFORE_HTML=1]="BEFORE_HTML",e[e.BEFORE_HEAD=2]="BEFORE_HEAD",e[e.IN_HEAD=3]="IN_HEAD",e[e.IN_HEAD_NO_SCRIPT=4]="IN_HEAD_NO_SCRIPT",e[e.AFTER_HEAD=5]="AFTER_HEAD",e[e.IN_BODY=6]="IN_BODY",e[e.TEXT=7]="TEXT",e[e.IN_TABLE=8]="IN_TABLE",e[e.IN_TABLE_TEXT=9]="IN_TABLE_TEXT",e[e.IN_CAPTION=10]="IN_CAPTION",e[e.IN_COLUMN_GROUP=11]="IN_COLUMN_GROUP",e[e.IN_TABLE_BODY=12]="IN_TABLE_BODY",e[e.IN_ROW=13]="IN_ROW",e[e.IN_CELL=14]="IN_CELL",e[e.IN_SELECT=15]="IN_SELECT",e[e.IN_SELECT_IN_TABLE=16]="IN_SELECT_IN_TABLE",e[e.IN_TEMPLATE=17]="IN_TEMPLATE",e[e.AFTER_BODY=18]="AFTER_BODY",e[e.IN_FRAMESET=19]="IN_FRAMESET",e[e.AFTER_FRAMESET=20]="AFTER_FRAMESET",e[e.AFTER_AFTER_BODY=21]="AFTER_AFTER_BODY",e[e.AFTER_AFTER_FRAMESET=22]="AFTER_AFTER_FRAMESET"})(y||(y={}));var k4={startLine:-1,startCol:-1,startOffset:-1,endLine:-1,endCol:-1,endOffset:-1},i1=new Set([l.TAG_ID.TABLE,l.TAG_ID.TBODY,l.TAG_ID.TFOOT,l.TAG_ID.THEAD,l.TAG_ID.TR]),r1={scriptingEnabled:!0,sourceCodeLocationInfo:!1,treeAdapter:w4.defaultTreeAdapter,onParseError:null},xo=class{constructor(t,r,u=null,a=null){this.fragmentContext=u,this.scriptHandler=a,this.currentToken=null,this.stopped=!1,this.insertionMode=y.INITIAL,this.originalInsertionMode=y.INITIAL,this.headElement=null,this.formElement=null,this.currentNotInHTML=!1,this.tmplInsertionModeStack=[],this.pendingCharacterTokens=[],this.hasNonWhitespacePendingCharacterToken=!1,this.framesetOk=!0,this.skipNextNewLine=!1,this.fosterParentingEnabled=!1,this.options=Object.assign(Object.assign({},r1),t),this.treeAdapter=this.options.treeAdapter,this.onParseError=this.options.onParseError,this.onParseError&&(this.options.sourceCodeLocationInfo=!0),this.document=r!=null?r:this.treeAdapter.createDocument(),this.tokenizer=new Tt.Tokenizer(this.options,this),this.activeFormattingElements=new e1.FormattingElementList(this.treeAdapter),this.fragmentContextID=u?(0,l.getTagID)(this.treeAdapter.getTagName(u)):l.TAG_ID.UNKNOWN,this._setContextModes(u!=null?u:this.document,this.fragmentContextID),this.openElements=new B4.OpenElementStack(this.document,this.treeAdapter,this)}static parse(t,r){let u=new this(r);return u.tokenizer.write(t,!0),u.document}static getFragmentParser(t,r){let u=Object.assign(Object.assign({},r1),r);t!=null||(t=u.treeAdapter.createElement(l.TAG_NAMES.TEMPLATE,l.NS.HTML,[]));let a=u.treeAdapter.createElement("documentmock",l.NS.HTML,[]),n=new this(u,a,t);return n.fragmentContextID===l.TAG_ID.TEMPLATE&&n.tmplInsertionModeStack.unshift(y.IN_TEMPLATE),n._initTokenizerForFragmentParsing(),n._insertFakeRootElement(),n._resetInsertionMode(),n._findFormInFragmentContext(),n}getFragment(){let t=this.treeAdapter.getFirstChild(this.document),r=this.treeAdapter.createDocumentFragment();return this._adoptNodes(t,r),r}_err(t,r,u){var a;if(!this.onParseError)return;let n=(a=t.location)!==null&&a!==void 0?a:k4,s={code:r,startLine:n.startLine,startCol:n.startCol,startOffset:n.startOffset,endLine:u?n.startLine:n.endLine,endCol:u?n.startCol:n.endCol,endOffset:u?n.startOffset:n.endOffset};this.onParseError(s)}onItemPush(t,r,u){var a,n;(n=(a=this.treeAdapter).onItemPush)===null||n===void 0||n.call(a,t),u&&this.openElements.stackTop>0&&this._setContextModes(t,r)}onItemPop(t,r){var u,a;if(this.options.sourceCodeLocationInfo&&this._setEndLocation(t,this.currentToken),(a=(u=this.treeAdapter).onItemPop)===null||a===void 0||a.call(u,t,this.openElements.current),r){let n,s;this.openElements.stackTop===0&&this.fragmentContext?(n=this.fragmentContext,s=this.fragmentContextID):{current:n,currentTagId:s}=this.openElements,this._setContextModes(n,s)}}_setContextModes(t,r){let u=t===this.document||t&&this.treeAdapter.getNamespaceURI(t)===l.NS.HTML;this.currentNotInHTML=!u,this.tokenizer.inForeignNode=!u&&t!==void 0&&r!==void 0&&!this._isIntegrationPoint(r,t)}_switchToTextParsing(t,r){this._insertElement(t,l.NS.HTML),this.tokenizer.state=r,this.originalInsertionMode=this.insertionMode,this.insertionMode=y.TEXT}switchToPlaintextParsing(){this.insertionMode=y.TEXT,this.originalInsertionMode=y.IN_BODY,this.tokenizer.state=Tt.TokenizerMode.PLAINTEXT}_getAdjustedCurrentElement(){return this.openElements.stackTop===0&&this.fragmentContext?this.fragmentContext:this.openElements.current}_findFormInFragmentContext(){let t=this.fragmentContext;for(;t;){if(this.treeAdapter.getTagName(t)===l.TAG_NAMES.FORM){this.formElement=t;break}t=this.treeAdapter.getParentNode(t)}}_initTokenizerForFragmentParsing(){if(!(!this.fragmentContext||this.treeAdapter.getNamespaceURI(this.fragmentContext)!==l.NS.HTML))switch(this.fragmentContextID){case l.TAG_ID.TITLE:case l.TAG_ID.TEXTAREA:{this.tokenizer.state=Tt.TokenizerMode.RCDATA;break}case l.TAG_ID.STYLE:case l.TAG_ID.XMP:case l.TAG_ID.IFRAME:case l.TAG_ID.NOEMBED:case l.TAG_ID.NOFRAMES:case l.TAG_ID.NOSCRIPT:{this.tokenizer.state=Tt.TokenizerMode.RAWTEXT;break}case l.TAG_ID.SCRIPT:{this.tokenizer.state=Tt.TokenizerMode.SCRIPT_DATA;break}case l.TAG_ID.PLAINTEXT:{this.tokenizer.state=Tt.TokenizerMode.PLAINTEXT;break}default:}}_setDocumentType(t){let r=t.name||"",u=t.publicId||"",a=t.systemId||"";if(this.treeAdapter.setDocumentType(this.document,r,u,a),t.location){let s=this.treeAdapter.getChildNodes(this.document).find(i=>this.treeAdapter.isDocumentTypeNode(i));s&&this.treeAdapter.setNodeSourceCodeLocation(s,t.location)}}_attachElementToTree(t,r){if(this.options.sourceCodeLocationInfo){let u=r&&Object.assign(Object.assign({},r),{startTag:r});this.treeAdapter.setNodeSourceCodeLocation(t,u)}if(this._shouldFosterParentOnInsertion())this._fosterParentElement(t);else{let u=this.openElements.currentTmplContentOrNode;this.treeAdapter.appendChild(u!=null?u:this.document,t)}}_appendElement(t,r){let u=this.treeAdapter.createElement(t.tagName,r,t.attrs);this._attachElementToTree(u,t.location)}_insertElement(t,r){let u=this.treeAdapter.createElement(t.tagName,r,t.attrs);this._attachElementToTree(u,t.location),this.openElements.push(u,t.tagID)}_insertFakeElement(t,r){let u=this.treeAdapter.createElement(t,l.NS.HTML,[]);this._attachElementToTree(u,null),this.openElements.push(u,r)}_insertTemplate(t){let r=this.treeAdapter.createElement(t.tagName,l.NS.HTML,t.attrs),u=this.treeAdapter.createDocumentFragment();this.treeAdapter.setTemplateContent(r,u),this._attachElementToTree(r,t.location),this.openElements.push(r,t.tagID),this.options.sourceCodeLocationInfo&&this.treeAdapter.setNodeSourceCodeLocation(u,null)}_insertFakeRootElement(){let t=this.treeAdapter.createElement(l.TAG_NAMES.HTML,l.NS.HTML,[]);this.options.sourceCodeLocationInfo&&this.treeAdapter.setNodeSourceCodeLocation(t,null),this.treeAdapter.appendChild(this.openElements.current,t),this.openElements.push(t,l.TAG_ID.HTML)}_appendCommentNode(t,r){let u=this.treeAdapter.createCommentNode(t.data);this.treeAdapter.appendChild(r,u),this.options.sourceCodeLocationInfo&&this.treeAdapter.setNodeSourceCodeLocation(u,t.location)}_insertCharacters(t){let r,u;if(this._shouldFosterParentOnInsertion()?({parent:r,beforeElement:u}=this._findFosterParentingLocation(),u?this.treeAdapter.insertTextBefore(r,t.chars,u):this.treeAdapter.insertText(r,t.chars)):(r=this.openElements.currentTmplContentOrNode,this.treeAdapter.insertText(r,t.chars)),!t.location)return;let a=this.treeAdapter.getChildNodes(r),n=u?a.lastIndexOf(u):a.length,s=a[n-1];if(this.treeAdapter.getNodeSourceCodeLocation(s)){let{endLine:c,endCol:o,endOffset:f}=t.location;this.treeAdapter.updateNodeSourceCodeLocation(s,{endLine:c,endCol:o,endOffset:f})}else this.options.sourceCodeLocationInfo&&this.treeAdapter.setNodeSourceCodeLocation(s,t.location)}_adoptNodes(t,r){for(let u=this.treeAdapter.getFirstChild(t);u;u=this.treeAdapter.getFirstChild(t))this.treeAdapter.detachNode(u),this.treeAdapter.appendChild(r,u)}_setEndLocation(t,r){if(this.treeAdapter.getNodeSourceCodeLocation(t)&&r.location){let u=r.location,a=this.treeAdapter.getTagName(t),n=r.type===We.TokenType.END_TAG&&a===r.tagName?{endTag:Object.assign({},u),endLine:u.endLine,endCol:u.endCol,endOffset:u.endOffset}:{endLine:u.startLine,endCol:u.startCol,endOffset:u.startOffset};this.treeAdapter.updateNodeSourceCodeLocation(t,n)}}shouldProcessStartTagTokenInForeignContent(t){if(!this.currentNotInHTML)return!1;let r,u;return this.openElements.stackTop===0&&this.fragmentContext?(r=this.fragmentContext,u=this.fragmentContextID):{current:r,currentTagId:u}=this.openElements,t.tagID===l.TAG_ID.SVG&&this.treeAdapter.getTagName(r)===l.TAG_NAMES.ANNOTATION_XML&&this.treeAdapter.getNamespaceURI(r)===l.NS.MATHML?!1:this.tokenizer.inForeignNode||(t.tagID===l.TAG_ID.MGLYPH||t.tagID===l.TAG_ID.MALIGNMARK)&&u!==void 0&&!this._isIntegrationPoint(u,r,l.NS.HTML)}_processToken(t){switch(t.type){case We.TokenType.CHARACTER:{this.onCharacter(t);break}case We.TokenType.NULL_CHARACTER:{this.onNullCharacter(t);break}case We.TokenType.COMMENT:{this.onComment(t);break}case We.TokenType.DOCTYPE:{this.onDoctype(t);break}case We.TokenType.START_TAG:{this._processStartTag(t);break}case We.TokenType.END_TAG:{this.onEndTag(t);break}case We.TokenType.EOF:{this.onEof(t);break}case We.TokenType.WHITESPACE_CHARACTER:{this.onWhitespaceCharacter(t);break}}}_isIntegrationPoint(t,r,u){let a=this.treeAdapter.getNamespaceURI(r),n=this.treeAdapter.getAttrList(r);return hr.isIntegrationPoint(t,a,n,u)}_reconstructActiveFormattingElements(){let t=this.activeFormattingElements.entries.length;if(t){let r=this.activeFormattingElements.entries.findIndex(a=>a.type===e1.EntryType.Marker||this.openElements.contains(a.element)),u=r===-1?t-1:r-1;for(let a=u;a>=0;a--){let n=this.activeFormattingElements.entries[a];this._insertElement(n.token,this.treeAdapter.getNamespaceURI(n.element)),n.element=this.openElements.current}}}_closeTableCell(){this.openElements.generateImpliedEndTags(),this.openElements.popUntilTableCellPopped(),this.activeFormattingElements.clearToLastMarker(),this.insertionMode=y.IN_ROW}_closePElement(){this.openElements.generateImpliedEndTagsWithExclusion(l.TAG_ID.P),this.openElements.popUntilTagNamePopped(l.TAG_ID.P)}_resetInsertionMode(){for(let t=this.openElements.stackTop;t>=0;t--)switch(t===0&&this.fragmentContext?this.fragmentContextID:this.openElements.tagIDs[t]){case l.TAG_ID.TR:{this.insertionMode=y.IN_ROW;return}case l.TAG_ID.TBODY:case l.TAG_ID.THEAD:case l.TAG_ID.TFOOT:{this.insertionMode=y.IN_TABLE_BODY;return}case l.TAG_ID.CAPTION:{this.insertionMode=y.IN_CAPTION;return}case l.TAG_ID.COLGROUP:{this.insertionMode=y.IN_COLUMN_GROUP;return}case l.TAG_ID.TABLE:{this.insertionMode=y.IN_TABLE;return}case l.TAG_ID.BODY:{this.insertionMode=y.IN_BODY;return}case l.TAG_ID.FRAMESET:{this.insertionMode=y.IN_FRAMESET;return}case l.TAG_ID.SELECT:{this._resetInsertionModeForSelect(t);return}case l.TAG_ID.TEMPLATE:{this.insertionMode=this.tmplInsertionModeStack[0];return}case l.TAG_ID.HTML:{this.insertionMode=this.headElement?y.AFTER_HEAD:y.BEFORE_HEAD;return}case l.TAG_ID.TD:case l.TAG_ID.TH:{if(t>0){this.insertionMode=y.IN_CELL;return}break}case l.TAG_ID.HEAD:{if(t>0){this.insertionMode=y.IN_HEAD;return}break}}this.insertionMode=y.IN_BODY}_resetInsertionModeForSelect(t){if(t>0)for(let r=t-1;r>0;r--){let u=this.openElements.tagIDs[r];if(u===l.TAG_ID.TEMPLATE)break;if(u===l.TAG_ID.TABLE){this.insertionMode=y.IN_SELECT_IN_TABLE;return}}this.insertionMode=y.IN_SELECT}_isElementCausesFosterParenting(t){return i1.has(t)}_shouldFosterParentOnInsertion(){return this.fosterParentingEnabled&&this.openElements.currentTagId!==void 0&&this._isElementCausesFosterParenting(this.openElements.currentTagId)}_findFosterParentingLocation(){for(let t=this.openElements.stackTop;t>=0;t--){let r=this.openElements.items[t];switch(this.openElements.tagIDs[t]){case l.TAG_ID.TEMPLATE:{if(this.treeAdapter.getNamespaceURI(r)===l.NS.HTML)return{parent:this.treeAdapter.getTemplateContent(r),beforeElement:null};break}case l.TAG_ID.TABLE:{let u=this.treeAdapter.getParentNode(r);return u?{parent:u,beforeElement:r}:{parent:this.openElements.items[t-1],beforeElement:null}}default:}}return{parent:this.openElements.items[0],beforeElement:null}}_fosterParentElement(t){let r=this._findFosterParentingLocation();r.beforeElement?this.treeAdapter.insertBefore(r.parent,t,r.beforeElement):this.treeAdapter.appendChild(r.parent,t)}_isSpecialElement(t,r){let u=this.treeAdapter.getNamespaceURI(t);return l.SPECIAL_ELEMENTS[u].has(r)}onCharacter(t){if(this.skipNextNewLine=!1,this.tokenizer.inForeignNode){p8(this,t);return}switch(this.insertionMode){case y.INITIAL:{ta(this,t);break}case y.BEFORE_HTML:{ua(this,t);break}case y.BEFORE_HEAD:{aa(this,t);break}case y.IN_HEAD:{na(this,t);break}case y.IN_HEAD_NO_SCRIPT:{ia(this,t);break}case y.AFTER_HEAD:{sa(this,t);break}case y.IN_BODY:case y.IN_CAPTION:case y.IN_CELL:case y.IN_TEMPLATE:{o1(this,t);break}case y.TEXT:case y.IN_SELECT:case y.IN_SELECT_IN_TABLE:{this._insertCharacters(t);break}case y.IN_TABLE:case y.IN_TABLE_BODY:case y.IN_ROW:{To(this,t);break}case y.IN_TABLE_TEXT:{p1(this,t);break}case y.IN_COLUMN_GROUP:{Cn(this,t);break}case y.AFTER_BODY:{In(this,t);break}case y.AFTER_AFTER_BODY:{Dn(this,t);break}default:}}onNullCharacter(t){if(this.skipNextNewLine=!1,this.tokenizer.inForeignNode){h8(this,t);return}switch(this.insertionMode){case y.INITIAL:{ta(this,t);break}case y.BEFORE_HTML:{ua(this,t);break}case y.BEFORE_HEAD:{aa(this,t);break}case y.IN_HEAD:{na(this,t);break}case y.IN_HEAD_NO_SCRIPT:{ia(this,t);break}case y.AFTER_HEAD:{sa(this,t);break}case y.TEXT:{this._insertCharacters(t);break}case y.IN_TABLE:case y.IN_TABLE_BODY:case y.IN_ROW:{To(this,t);break}case y.IN_COLUMN_GROUP:{Cn(this,t);break}case y.AFTER_BODY:{In(this,t);break}case y.AFTER_AFTER_BODY:{Dn(this,t);break}default:}}onComment(t){if(this.skipNextNewLine=!1,this.currentNotInHTML){Ao(this,t);return}switch(this.insertionMode){case y.INITIAL:case y.BEFORE_HTML:case y.BEFORE_HEAD:case y.IN_HEAD:case y.IN_HEAD_NO_SCRIPT:case y.AFTER_HEAD:case y.IN_BODY:case y.IN_TABLE:case y.IN_CAPTION:case y.IN_COLUMN_GROUP:case y.IN_TABLE_BODY:case y.IN_ROW:case y.IN_CELL:case y.IN_SELECT:case y.IN_SELECT_IN_TABLE:case y.IN_TEMPLATE:case y.IN_FRAMESET:case y.AFTER_FRAMESET:{Ao(this,t);break}case y.IN_TABLE_TEXT:{ra(this,t);break}case y.AFTER_BODY:{Y4(this,t);break}case y.AFTER_AFTER_BODY:case y.AFTER_AFTER_FRAMESET:{W4(this,t);break}default:}}onDoctype(t){switch(this.skipNextNewLine=!1,this.insertionMode){case y.INITIAL:{V4(this,t);break}case y.BEFORE_HEAD:case y.IN_HEAD:case y.IN_HEAD_NO_SCRIPT:case y.AFTER_HEAD:{this._err(t,at.ERR.misplacedDoctype);break}case y.IN_TABLE_TEXT:{ra(this,t);break}default:}}onStartTag(t){this.skipNextNewLine=!1,this.currentToken=t,this._processStartTag(t),t.selfClosing&&!t.ackSelfClosing&&this._err(t,at.ERR.nonVoidHtmlElementStartTagWithTrailingSolidus)}_processStartTag(t){this.shouldProcessStartTagTokenInForeignContent(t)?b8(this,t):this._startTagOutsideForeignContent(t)}_startTagOutsideForeignContent(t){switch(this.insertionMode){case y.INITIAL:{ta(this,t);break}case y.BEFORE_HTML:{Q4(this,t);break}case y.BEFORE_HEAD:{K4(this,t);break}case y.IN_HEAD:{Zt(this,t);break}case y.IN_HEAD_NO_SCRIPT:{J4(this,t);break}case y.AFTER_HEAD:{tA(this,t);break}case y.IN_BODY:{ft(this,t);break}case y.IN_TABLE:{l0(this,t);break}case y.IN_TABLE_TEXT:{ra(this,t);break}case y.IN_CAPTION:{$A(this,t);break}case y.IN_COLUMN_GROUP:{yo(this,t);break}case y.IN_TABLE_BODY:{On(this,t);break}case y.IN_ROW:{Rn(this,t);break}case y.IN_CELL:{e8(this,t);break}case y.IN_SELECT:{E1(this,t);break}case y.IN_SELECT_IN_TABLE:{r8(this,t);break}case y.IN_TEMPLATE:{a8(this,t);break}case y.AFTER_BODY:{i8(this,t);break}case y.IN_FRAMESET:{s8(this,t);break}case y.AFTER_FRAMESET:{c8(this,t);break}case y.AFTER_AFTER_BODY:{l8(this,t);break}case y.AFTER_AFTER_FRAMESET:{d8(this,t);break}default:}}onEndTag(t){this.skipNextNewLine=!1,this.currentToken=t,this.currentNotInHTML?_8(this,t):this._endTagOutsideForeignContent(t)}_endTagOutsideForeignContent(t){switch(this.insertionMode){case y.INITIAL:{ta(this,t);break}case y.BEFORE_HTML:{X4(this,t);break}case y.BEFORE_HEAD:{$4(this,t);break}case y.IN_HEAD:{Z4(this,t);break}case y.IN_HEAD_NO_SCRIPT:{eA(this,t);break}case y.AFTER_HEAD:{rA(this,t);break}case y.IN_BODY:{Nn(this,t);break}case y.TEXT:{GA(this,t);break}case y.IN_TABLE:{oa(this,t);break}case y.IN_TABLE_TEXT:{ra(this,t);break}case y.IN_CAPTION:{ZA(this,t);break}case y.IN_COLUMN_GROUP:{JA(this,t);break}case y.IN_TABLE_BODY:{mo(this,t);break}case y.IN_ROW:{_1(this,t);break}case y.IN_CELL:{t8(this,t);break}case y.IN_SELECT:{T1(this,t);break}case y.IN_SELECT_IN_TABLE:{u8(this,t);break}case y.IN_TEMPLATE:{n8(this,t);break}case y.AFTER_BODY:{A1(this,t);break}case y.IN_FRAMESET:{o8(this,t);break}case y.AFTER_FRAMESET:{f8(this,t);break}case y.AFTER_AFTER_BODY:{Dn(this,t);break}default:}}onEof(t){switch(this.insertionMode){case y.INITIAL:{ta(this,t);break}case y.BEFORE_HTML:{ua(this,t);break}case y.BEFORE_HEAD:{aa(this,t);break}case y.IN_HEAD:{na(this,t);break}case y.IN_HEAD_NO_SCRIPT:{ia(this,t);break}case y.AFTER_HEAD:{sa(this,t);break}case y.IN_BODY:case y.IN_TABLE:case y.IN_CAPTION:case y.IN_COLUMN_GROUP:case y.IN_TABLE_BODY:case y.IN_ROW:case y.IN_CELL:case y.IN_SELECT:case y.IN_SELECT_IN_TABLE:{d1(this,t);break}case y.TEXT:{qA(this,t);break}case y.IN_TABLE_TEXT:{ra(this,t);break}case y.IN_TEMPLATE:{x1(this,t);break}case y.AFTER_BODY:case y.IN_FRAMESET:case y.AFTER_FRAMESET:case y.AFTER_AFTER_BODY:case y.AFTER_AFTER_FRAMESET:{vo(this,t);break}default:}}onWhitespaceCharacter(t){if(this.skipNextNewLine&&(this.skipNextNewLine=!1,t.chars.charCodeAt(0)===n1.CODE_POINTS.LINE_FEED)){if(t.chars.length===1)return;t.chars=t.chars.substr(1)}if(this.tokenizer.inForeignNode){this._insertCharacters(t);return}switch(this.insertionMode){case y.IN_HEAD:case y.IN_HEAD_NO_SCRIPT:case y.AFTER_HEAD:case y.TEXT:case y.IN_COLUMN_GROUP:case y.IN_SELECT:case y.IN_SELECT_IN_TABLE:case y.IN_FRAMESET:case y.AFTER_FRAMESET:{this._insertCharacters(t);break}case y.IN_BODY:case y.IN_CAPTION:case y.IN_CELL:case y.IN_TEMPLATE:case y.AFTER_BODY:case y.AFTER_AFTER_BODY:case y.AFTER_AFTER_FRAMESET:{s1(this,t);break}case y.IN_TABLE:case y.IN_TABLE_BODY:case y.IN_ROW:{To(this,t);break}case y.IN_TABLE_TEXT:{h1(this,t);break}default:}}};Pn.Parser=xo;function H4(e,t){let r=e.activeFormattingElements.getElementEntryInScopeWithTagName(t.tagName);return r?e.openElements.contains(r.element)?e.openElements.hasInScope(t.tagID)||(r=null):(e.activeFormattingElements.removeEntry(r),r=null):l1(e,t),r}function U4(e,t){let r=null,u=e.openElements.stackTop;for(;u>=0;u--){let a=e.openElements.items[u];if(a===t.element)break;e._isSpecialElement(a,e.openElements.tagIDs[u])&&(r=a)}return r||(e.openElements.shortenToLength(Math.max(u,0)),e.activeFormattingElements.removeEntry(t)),r}function G4(e,t,r){let u=t,a=e.openElements.getCommonAncestor(t);for(let n=0,s=a;s!==r;n++,s=a){a=e.openElements.getCommonAncestor(s);let i=e.activeFormattingElements.getElementEntry(s),c=i&&n>=F4;!i||c?(c&&e.activeFormattingElements.removeEntry(i),e.openElements.remove(s)):(s=q4(e,i),u===t&&(e.activeFormattingElements.bookmark=i),e.treeAdapter.detachNode(u),e.treeAdapter.appendChild(s,u),u=s)}return u}function q4(e,t){let r=e.treeAdapter.getNamespaceURI(t.element),u=e.treeAdapter.createElement(t.token.tagName,r,t.token.attrs);return e.openElements.replace(t.element,u),t.element=u,u}function j4(e,t,r){let u=e.treeAdapter.getTagName(t),a=(0,l.getTagID)(u);if(e._isElementCausesFosterParenting(a))e._fosterParentElement(r);else{let n=e.treeAdapter.getNamespaceURI(t);a===l.TAG_ID.TEMPLATE&&n===l.NS.HTML&&(t=e.treeAdapter.getTemplateContent(t)),e.treeAdapter.appendChild(t,r)}}function z4(e,t,r){let u=e.treeAdapter.getNamespaceURI(r.element),{token:a}=r,n=e.treeAdapter.createElement(a.tagName,u,a.attrs);e._adoptNodes(t,n),e.treeAdapter.appendChild(t,n),e.activeFormattingElements.insertElementAfterBookmark(n,a),e.activeFormattingElements.removeEntry(r),e.openElements.remove(r.element),e.openElements.insertAfter(t,n,a.tagID)}function go(e,t){for(let r=0;r<M4;r++){let u=H4(e,t);if(!u)break;let a=U4(e,u);if(!a)break;e.activeFormattingElements.bookmark=u;let n=G4(e,a,u.element),s=e.openElements.getCommonAncestor(u.element);e.treeAdapter.detachNode(n),s&&j4(e,s,n),z4(e,a,u)}}function Ao(e,t){e._appendCommentNode(t,e.openElements.currentTmplContentOrNode)}function Y4(e,t){e._appendCommentNode(t,e.openElements.items[0])}function W4(e,t){e._appendCommentNode(t,e.document)}function vo(e,t){if(e.stopped=!0,t.location){let r=e.fragmentContext?0:2;for(let u=e.openElements.stackTop;u>=r;u--)e._setEndLocation(e.openElements.items[u],t);if(!e.fragmentContext&&e.openElements.stackTop>=0){let u=e.openElements.items[0],a=e.treeAdapter.getNodeSourceCodeLocation(u);if(a&&!a.endTag&&(e._setEndLocation(u,t),e.openElements.stackTop>=1)){let n=e.openElements.items[1],s=e.treeAdapter.getNodeSourceCodeLocation(n);s&&!s.endTag&&e._setEndLocation(n,t)}}}}function V4(e,t){e._setDocumentType(t);let r=t.forceQuirks?l.DOCUMENT_MODE.QUIRKS:t1.getDocumentMode(t);t1.isConforming(t)||e._err(t,at.ERR.nonConformingDoctype),e.treeAdapter.setDocumentMode(e.document,r),e.insertionMode=y.BEFORE_HTML}function ta(e,t){e._err(t,at.ERR.missingDoctype,!0),e.treeAdapter.setDocumentMode(e.document,l.DOCUMENT_MODE.QUIRKS),e.insertionMode=y.BEFORE_HTML,e._processToken(t)}function Q4(e,t){t.tagID===l.TAG_ID.HTML?(e._insertElement(t,l.NS.HTML),e.insertionMode=y.BEFORE_HEAD):ua(e,t)}function X4(e,t){let r=t.tagID;(r===l.TAG_ID.HTML||r===l.TAG_ID.HEAD||r===l.TAG_ID.BODY||r===l.TAG_ID.BR)&&ua(e,t)}function ua(e,t){e._insertFakeRootElement(),e.insertionMode=y.BEFORE_HEAD,e._processToken(t)}function K4(e,t){switch(t.tagID){case l.TAG_ID.HTML:{ft(e,t);break}case l.TAG_ID.HEAD:{e._insertElement(t,l.NS.HTML),e.headElement=e.openElements.current,e.insertionMode=y.IN_HEAD;break}default:aa(e,t)}}function $4(e,t){let r=t.tagID;r===l.TAG_ID.HEAD||r===l.TAG_ID.BODY||r===l.TAG_ID.HTML||r===l.TAG_ID.BR?aa(e,t):e._err(t,at.ERR.endTagWithoutMatchingOpenElement)}function aa(e,t){e._insertFakeElement(l.TAG_NAMES.HEAD,l.TAG_ID.HEAD),e.headElement=e.openElements.current,e.insertionMode=y.IN_HEAD,e._processToken(t)}function Zt(e,t){switch(t.tagID){case l.TAG_ID.HTML:{ft(e,t);break}case l.TAG_ID.BASE:case l.TAG_ID.BASEFONT:case l.TAG_ID.BGSOUND:case l.TAG_ID.LINK:case l.TAG_ID.META:{e._appendElement(t,l.NS.HTML),t.ackSelfClosing=!0;break}case l.TAG_ID.TITLE:{e._switchToTextParsing(t,Tt.TokenizerMode.RCDATA);break}case l.TAG_ID.NOSCRIPT:{e.options.scriptingEnabled?e._switchToTextParsing(t,Tt.TokenizerMode.RAWTEXT):(e._insertElement(t,l.NS.HTML),e.insertionMode=y.IN_HEAD_NO_SCRIPT);break}case l.TAG_ID.NOFRAMES:case l.TAG_ID.STYLE:{e._switchToTextParsing(t,Tt.TokenizerMode.RAWTEXT);break}case l.TAG_ID.SCRIPT:{e._switchToTextParsing(t,Tt.TokenizerMode.SCRIPT_DATA);break}case l.TAG_ID.TEMPLATE:{e._insertTemplate(t),e.activeFormattingElements.insertMarker(),e.framesetOk=!1,e.insertionMode=y.IN_TEMPLATE,e.tmplInsertionModeStack.unshift(y.IN_TEMPLATE);break}case l.TAG_ID.HEAD:{e._err(t,at.ERR.misplacedStartTagForHeadElement);break}default:na(e,t)}}function Z4(e,t){switch(t.tagID){case l.TAG_ID.HEAD:{e.openElements.pop(),e.insertionMode=y.AFTER_HEAD;break}case l.TAG_ID.BODY:case l.TAG_ID.BR:case l.TAG_ID.HTML:{na(e,t);break}case l.TAG_ID.TEMPLATE:{Su(e,t);break}default:e._err(t,at.ERR.endTagWithoutMatchingOpenElement)}}function Su(e,t){e.openElements.tmplCount>0?(e.openElements.generateImpliedEndTagsThoroughly(),e.openElements.currentTagId!==l.TAG_ID.TEMPLATE&&e._err(t,at.ERR.closingOfElementWithOpenChildElements),e.openElements.popUntilTagNamePopped(l.TAG_ID.TEMPLATE),e.activeFormattingElements.clearToLastMarker(),e.tmplInsertionModeStack.shift(),e._resetInsertionMode()):e._err(t,at.ERR.endTagWithoutMatchingOpenElement)}function na(e,t){e.openElements.pop(),e.insertionMode=y.AFTER_HEAD,e._processToken(t)}function J4(e,t){switch(t.tagID){case l.TAG_ID.HTML:{ft(e,t);break}case l.TAG_ID.BASEFONT:case l.TAG_ID.BGSOUND:case l.TAG_ID.HEAD:case l.TAG_ID.LINK:case l.TAG_ID.META:case l.TAG_ID.NOFRAMES:case l.TAG_ID.STYLE:{Zt(e,t);break}case l.TAG_ID.NOSCRIPT:{e._err(t,at.ERR.nestedNoscriptInHead);break}default:ia(e,t)}}function eA(e,t){switch(t.tagID){case l.TAG_ID.NOSCRIPT:{e.openElements.pop(),e.insertionMode=y.IN_HEAD;break}case l.TAG_ID.BR:{ia(e,t);break}default:e._err(t,at.ERR.endTagWithoutMatchingOpenElement)}}function ia(e,t){let r=t.type===We.TokenType.EOF?at.ERR.openElementsLeftAfterEof:at.ERR.disallowedContentInNoscriptInHead;e._err(t,r),e.openElements.pop(),e.insertionMode=y.IN_HEAD,e._processToken(t)}function tA(e,t){switch(t.tagID){case l.TAG_ID.HTML:{ft(e,t);break}case l.TAG_ID.BODY:{e._insertElement(t,l.NS.HTML),e.framesetOk=!1,e.insertionMode=y.IN_BODY;break}case l.TAG_ID.FRAMESET:{e._insertElement(t,l.NS.HTML),e.insertionMode=y.IN_FRAMESET;break}case l.TAG_ID.BASE:case l.TAG_ID.BASEFONT:case l.TAG_ID.BGSOUND:case l.TAG_ID.LINK:case l.TAG_ID.META:case l.TAG_ID.NOFRAMES:case l.TAG_ID.SCRIPT:case l.TAG_ID.STYLE:case l.TAG_ID.TEMPLATE:case l.TAG_ID.TITLE:{e._err(t,at.ERR.abandonedHeadElementChild),e.openElements.push(e.headElement,l.TAG_ID.HEAD),Zt(e,t),e.openElements.remove(e.headElement);break}case l.TAG_ID.HEAD:{e._err(t,at.ERR.misplacedStartTagForHeadElement);break}default:sa(e,t)}}function rA(e,t){switch(t.tagID){case l.TAG_ID.BODY:case l.TAG_ID.HTML:case l.TAG_ID.BR:{sa(e,t);break}case l.TAG_ID.TEMPLATE:{Su(e,t);break}default:e._err(t,at.ERR.endTagWithoutMatchingOpenElement)}}function sa(e,t){e._insertFakeElement(l.TAG_NAMES.BODY,l.TAG_ID.BODY),e.insertionMode=y.IN_BODY,Sn(e,t)}function Sn(e,t){switch(t.type){case We.TokenType.CHARACTER:{o1(e,t);break}case We.TokenType.WHITESPACE_CHARACTER:{s1(e,t);break}case We.TokenType.COMMENT:{Ao(e,t);break}case We.TokenType.START_TAG:{ft(e,t);break}case We.TokenType.END_TAG:{Nn(e,t);break}case We.TokenType.EOF:{d1(e,t);break}default:}}function s1(e,t){e._reconstructActiveFormattingElements(),e._insertCharacters(t)}function o1(e,t){e._reconstructActiveFormattingElements(),e._insertCharacters(t),e.framesetOk=!1}function uA(e,t){e.openElements.tmplCount===0&&e.treeAdapter.adoptAttributes(e.openElements.items[0],t.attrs)}function aA(e,t){let r=e.openElements.tryPeekProperlyNestedBodyElement();r&&e.openElements.tmplCount===0&&(e.framesetOk=!1,e.treeAdapter.adoptAttributes(r,t.attrs))}function nA(e,t){let r=e.openElements.tryPeekProperlyNestedBodyElement();e.framesetOk&&r&&(e.treeAdapter.detachNode(r),e.openElements.popAllUpToHtmlElement(),e._insertElement(t,l.NS.HTML),e.insertionMode=y.IN_FRAMESET)}function iA(e,t){e.openElements.hasInButtonScope(l.TAG_ID.P)&&e._closePElement(),e._insertElement(t,l.NS.HTML)}function sA(e,t){e.openElements.hasInButtonScope(l.TAG_ID.P)&&e._closePElement(),e.openElements.currentTagId!==void 0&&l.NUMBERED_HEADERS.has(e.openElements.currentTagId)&&e.openElements.pop(),e._insertElement(t,l.NS.HTML)}function oA(e,t){e.openElements.hasInButtonScope(l.TAG_ID.P)&&e._closePElement(),e._insertElement(t,l.NS.HTML),e.skipNextNewLine=!0,e.framesetOk=!1}function cA(e,t){let r=e.openElements.tmplCount>0;(!e.formElement||r)&&(e.openElements.hasInButtonScope(l.TAG_ID.P)&&e._closePElement(),e._insertElement(t,l.NS.HTML),r||(e.formElement=e.openElements.current))}function fA(e,t){e.framesetOk=!1;let r=t.tagID;for(let u=e.openElements.stackTop;u>=0;u--){let a=e.openElements.tagIDs[u];if(r===l.TAG_ID.LI&&a===l.TAG_ID.LI||(r===l.TAG_ID.DD||r===l.TAG_ID.DT)&&(a===l.TAG_ID.DD||a===l.TAG_ID.DT)){e.openElements.generateImpliedEndTagsWithExclusion(a),e.openElements.popUntilTagNamePopped(a);break}if(a!==l.TAG_ID.ADDRESS&&a!==l.TAG_ID.DIV&&a!==l.TAG_ID.P&&e._isSpecialElement(e.openElements.items[u],a))break}e.openElements.hasInButtonScope(l.TAG_ID.P)&&e._closePElement(),e._insertElement(t,l.NS.HTML)}function lA(e,t){e.openElements.hasInButtonScope(l.TAG_ID.P)&&e._closePElement(),e._insertElement(t,l.NS.HTML),e.tokenizer.state=Tt.TokenizerMode.PLAINTEXT}function dA(e,t){e.openElements.hasInScope(l.TAG_ID.BUTTON)&&(e.openElements.generateImpliedEndTags(),e.openElements.popUntilTagNamePopped(l.TAG_ID.BUTTON)),e._reconstructActiveFormattingElements(),e._insertElement(t,l.NS.HTML),e.framesetOk=!1}function hA(e,t){let r=e.activeFormattingElements.getElementEntryInScopeWithTagName(l.TAG_NAMES.A);r&&(go(e,t),e.openElements.remove(r.element),e.activeFormattingElements.removeEntry(r)),e._reconstructActiveFormattingElements(),e._insertElement(t,l.NS.HTML),e.activeFormattingElements.pushElement(e.openElements.current,t)}function pA(e,t){e._reconstructActiveFormattingElements(),e._insertElement(t,l.NS.HTML),e.activeFormattingElements.pushElement(e.openElements.current,t)}function bA(e,t){e._reconstructActiveFormattingElements(),e.openElements.hasInScope(l.TAG_ID.NOBR)&&(go(e,t),e._reconstructActiveFormattingElements()),e._insertElement(t,l.NS.HTML),e.activeFormattingElements.pushElement(e.openElements.current,t)}function _A(e,t){e._reconstructActiveFormattingElements(),e._insertElement(t,l.NS.HTML),e.activeFormattingElements.insertMarker(),e.framesetOk=!1}function EA(e,t){e.treeAdapter.getDocumentMode(e.document)!==l.DOCUMENT_MODE.QUIRKS&&e.openElements.hasInButtonScope(l.TAG_ID.P)&&e._closePElement(),e._insertElement(t,l.NS.HTML),e.framesetOk=!1,e.insertionMode=y.IN_TABLE}function c1(e,t){e._reconstructActiveFormattingElements(),e._appendElement(t,l.NS.HTML),e.framesetOk=!1,t.ackSelfClosing=!0}function f1(e){let t=(0,We.getTokenAttr)(e,l.ATTRS.TYPE);return t!=null&&t.toLowerCase()===L4}function TA(e,t){e._reconstructActiveFormattingElements(),e._appendElement(t,l.NS.HTML),f1(t)||(e.framesetOk=!1),t.ackSelfClosing=!0}function xA(e,t){e._appendElement(t,l.NS.HTML),t.ackSelfClosing=!0}function AA(e,t){e.openElements.hasInButtonScope(l.TAG_ID.P)&&e._closePElement(),e._appendElement(t,l.NS.HTML),e.framesetOk=!1,t.ackSelfClosing=!0}function mA(e,t){t.tagName=l.TAG_NAMES.IMG,t.tagID=l.TAG_ID.IMG,c1(e,t)}function gA(e,t){e._insertElement(t,l.NS.HTML),e.skipNextNewLine=!0,e.tokenizer.state=Tt.TokenizerMode.RCDATA,e.originalInsertionMode=e.insertionMode,e.framesetOk=!1,e.insertionMode=y.TEXT}function vA(e,t){e.openElements.hasInButtonScope(l.TAG_ID.P)&&e._closePElement(),e._reconstructActiveFormattingElements(),e.framesetOk=!1,e._switchToTextParsing(t,Tt.TokenizerMode.RAWTEXT)}function yA(e,t){e.framesetOk=!1,e._switchToTextParsing(t,Tt.TokenizerMode.RAWTEXT)}function u1(e,t){e._switchToTextParsing(t,Tt.TokenizerMode.RAWTEXT)}function DA(e,t){e._reconstructActiveFormattingElements(),e._insertElement(t,l.NS.HTML),e.framesetOk=!1,e.insertionMode=e.insertionMode===y.IN_TABLE||e.insertionMode===y.IN_CAPTION||e.insertionMode===y.IN_TABLE_BODY||e.insertionMode===y.IN_ROW||e.insertionMode===y.IN_CELL?y.IN_SELECT_IN_TABLE:y.IN_SELECT}function CA(e,t){e.openElements.currentTagId===l.TAG_ID.OPTION&&e.openElements.pop(),e._reconstructActiveFormattingElements(),e._insertElement(t,l.NS.HTML)}function IA(e,t){e.openElements.hasInScope(l.TAG_ID.RUBY)&&e.openElements.generateImpliedEndTags(),e._insertElement(t,l.NS.HTML)}function SA(e,t){e.openElements.hasInScope(l.TAG_ID.RUBY)&&e.openElements.generateImpliedEndTagsWithExclusion(l.TAG_ID.RTC),e._insertElement(t,l.NS.HTML)}function NA(e,t){e._reconstructActiveFormattingElements(),hr.adjustTokenMathMLAttrs(t),hr.adjustTokenXMLAttrs(t),t.selfClosing?e._appendElement(t,l.NS.MATHML):e._insertElement(t,l.NS.MATHML),t.ackSelfClosing=!0}function OA(e,t){e._reconstructActiveFormattingElements(),hr.adjustTokenSVGAttrs(t),hr.adjustTokenXMLAttrs(t),t.selfClosing?e._appendElement(t,l.NS.SVG):e._insertElement(t,l.NS.SVG),t.ackSelfClosing=!0}function a1(e,t){e._reconstructActiveFormattingElements(),e._insertElement(t,l.NS.HTML)}function ft(e,t){switch(t.tagID){case l.TAG_ID.I:case l.TAG_ID.S:case l.TAG_ID.B:case l.TAG_ID.U:case l.TAG_ID.EM:case l.TAG_ID.TT:case l.TAG_ID.BIG:case l.TAG_ID.CODE:case l.TAG_ID.FONT:case l.TAG_ID.SMALL:case l.TAG_ID.STRIKE:case l.TAG_ID.STRONG:{pA(e,t);break}case l.TAG_ID.A:{hA(e,t);break}case l.TAG_ID.H1:case l.TAG_ID.H2:case l.TAG_ID.H3:case l.TAG_ID.H4:case l.TAG_ID.H5:case l.TAG_ID.H6:{sA(e,t);break}case l.TAG_ID.P:case l.TAG_ID.DL:case l.TAG_ID.OL:case l.TAG_ID.UL:case l.TAG_ID.DIV:case l.TAG_ID.DIR:case l.TAG_ID.NAV:case l.TAG_ID.MAIN:case l.TAG_ID.MENU:case l.TAG_ID.ASIDE:case l.TAG_ID.CENTER:case l.TAG_ID.FIGURE:case l.TAG_ID.FOOTER:case l.TAG_ID.HEADER:case l.TAG_ID.HGROUP:case l.TAG_ID.DIALOG:case l.TAG_ID.DETAILS:case l.TAG_ID.ADDRESS:case l.TAG_ID.ARTICLE:case l.TAG_ID.SEARCH:case l.TAG_ID.SECTION:case l.TAG_ID.SUMMARY:case l.TAG_ID.FIELDSET:case l.TAG_ID.BLOCKQUOTE:case l.TAG_ID.FIGCAPTION:{iA(e,t);break}case l.TAG_ID.LI:case l.TAG_ID.DD:case l.TAG_ID.DT:{fA(e,t);break}case l.TAG_ID.BR:case l.TAG_ID.IMG:case l.TAG_ID.WBR:case l.TAG_ID.AREA:case l.TAG_ID.EMBED:case l.TAG_ID.KEYGEN:{c1(e,t);break}case l.TAG_ID.HR:{AA(e,t);break}case l.TAG_ID.RB:case l.TAG_ID.RTC:{IA(e,t);break}case l.TAG_ID.RT:case l.TAG_ID.RP:{SA(e,t);break}case l.TAG_ID.PRE:case l.TAG_ID.LISTING:{oA(e,t);break}case l.TAG_ID.XMP:{vA(e,t);break}case l.TAG_ID.SVG:{OA(e,t);break}case l.TAG_ID.HTML:{uA(e,t);break}case l.TAG_ID.BASE:case l.TAG_ID.LINK:case l.TAG_ID.META:case l.TAG_ID.STYLE:case l.TAG_ID.TITLE:case l.TAG_ID.SCRIPT:case l.TAG_ID.BGSOUND:case l.TAG_ID.BASEFONT:case l.TAG_ID.TEMPLATE:{Zt(e,t);break}case l.TAG_ID.BODY:{aA(e,t);break}case l.TAG_ID.FORM:{cA(e,t);break}case l.TAG_ID.NOBR:{bA(e,t);break}case l.TAG_ID.MATH:{NA(e,t);break}case l.TAG_ID.TABLE:{EA(e,t);break}case l.TAG_ID.INPUT:{TA(e,t);break}case l.TAG_ID.PARAM:case l.TAG_ID.TRACK:case l.TAG_ID.SOURCE:{xA(e,t);break}case l.TAG_ID.IMAGE:{mA(e,t);break}case l.TAG_ID.BUTTON:{dA(e,t);break}case l.TAG_ID.APPLET:case l.TAG_ID.OBJECT:case l.TAG_ID.MARQUEE:{_A(e,t);break}case l.TAG_ID.IFRAME:{yA(e,t);break}case l.TAG_ID.SELECT:{DA(e,t);break}case l.TAG_ID.OPTION:case l.TAG_ID.OPTGROUP:{CA(e,t);break}case l.TAG_ID.NOEMBED:case l.TAG_ID.NOFRAMES:{u1(e,t);break}case l.TAG_ID.FRAMESET:{nA(e,t);break}case l.TAG_ID.TEXTAREA:{gA(e,t);break}case l.TAG_ID.NOSCRIPT:{e.options.scriptingEnabled?u1(e,t):a1(e,t);break}case l.TAG_ID.PLAINTEXT:{lA(e,t);break}case l.TAG_ID.COL:case l.TAG_ID.TH:case l.TAG_ID.TD:case l.TAG_ID.TR:case l.TAG_ID.HEAD:case l.TAG_ID.FRAME:case l.TAG_ID.TBODY:case l.TAG_ID.TFOOT:case l.TAG_ID.THEAD:case l.TAG_ID.CAPTION:case l.TAG_ID.COLGROUP:break;default:a1(e,t)}}function RA(e,t){if(e.openElements.hasInScope(l.TAG_ID.BODY)&&(e.insertionMode=y.AFTER_BODY,e.options.sourceCodeLocationInfo)){let r=e.openElements.tryPeekProperlyNestedBodyElement();r&&e._setEndLocation(r,t)}}function PA(e,t){e.openElements.hasInScope(l.TAG_ID.BODY)&&(e.insertionMode=y.AFTER_BODY,A1(e,t))}function BA(e,t){let r=t.tagID;e.openElements.hasInScope(r)&&(e.openElements.generateImpliedEndTags(),e.openElements.popUntilTagNamePopped(r))}function wA(e){let t=e.openElements.tmplCount>0,{formElement:r}=e;t||(e.formElement=null),(r||t)&&e.openElements.hasInScope(l.TAG_ID.FORM)&&(e.openElements.generateImpliedEndTags(),t?e.openElements.popUntilTagNamePopped(l.TAG_ID.FORM):r&&e.openElements.remove(r))}function LA(e){e.openElements.hasInButtonScope(l.TAG_ID.P)||e._insertFakeElement(l.TAG_NAMES.P,l.TAG_ID.P),e._closePElement()}function MA(e){e.openElements.hasInListItemScope(l.TAG_ID.LI)&&(e.openElements.generateImpliedEndTagsWithExclusion(l.TAG_ID.LI),e.openElements.popUntilTagNamePopped(l.TAG_ID.LI))}function FA(e,t){let r=t.tagID;e.openElements.hasInScope(r)&&(e.openElements.generateImpliedEndTagsWithExclusion(r),e.openElements.popUntilTagNamePopped(r))}function kA(e){e.openElements.hasNumberedHeaderInScope()&&(e.openElements.generateImpliedEndTags(),e.openElements.popUntilNumberedHeaderPopped())}function HA(e,t){let r=t.tagID;e.openElements.hasInScope(r)&&(e.openElements.generateImpliedEndTags(),e.openElements.popUntilTagNamePopped(r),e.activeFormattingElements.clearToLastMarker())}function UA(e){e._reconstructActiveFormattingElements(),e._insertFakeElement(l.TAG_NAMES.BR,l.TAG_ID.BR),e.openElements.pop(),e.framesetOk=!1}function l1(e,t){let r=t.tagName,u=t.tagID;for(let a=e.openElements.stackTop;a>0;a--){let n=e.openElements.items[a],s=e.openElements.tagIDs[a];if(u===s&&(u!==l.TAG_ID.UNKNOWN||e.treeAdapter.getTagName(n)===r)){e.openElements.generateImpliedEndTagsWithExclusion(u),e.openElements.stackTop>=a&&e.openElements.shortenToLength(a);break}if(e._isSpecialElement(n,s))break}}function Nn(e,t){switch(t.tagID){case l.TAG_ID.A:case l.TAG_ID.B:case l.TAG_ID.I:case l.TAG_ID.S:case l.TAG_ID.U:case l.TAG_ID.EM:case l.TAG_ID.TT:case l.TAG_ID.BIG:case l.TAG_ID.CODE:case l.TAG_ID.FONT:case l.TAG_ID.NOBR:case l.TAG_ID.SMALL:case l.TAG_ID.STRIKE:case l.TAG_ID.STRONG:{go(e,t);break}case l.TAG_ID.P:{LA(e);break}case l.TAG_ID.DL:case l.TAG_ID.UL:case l.TAG_ID.OL:case l.TAG_ID.DIR:case l.TAG_ID.DIV:case l.TAG_ID.NAV:case l.TAG_ID.PRE:case l.TAG_ID.MAIN:case l.TAG_ID.MENU:case l.TAG_ID.ASIDE:case l.TAG_ID.BUTTON:case l.TAG_ID.CENTER:case l.TAG_ID.FIGURE:case l.TAG_ID.FOOTER:case l.TAG_ID.HEADER:case l.TAG_ID.HGROUP:case l.TAG_ID.DIALOG:case l.TAG_ID.ADDRESS:case l.TAG_ID.ARTICLE:case l.TAG_ID.DETAILS:case l.TAG_ID.SEARCH:case l.TAG_ID.SECTION:case l.TAG_ID.SUMMARY:case l.TAG_ID.LISTING:case l.TAG_ID.FIELDSET:case l.TAG_ID.BLOCKQUOTE:case l.TAG_ID.FIGCAPTION:{BA(e,t);break}case l.TAG_ID.LI:{MA(e);break}case l.TAG_ID.DD:case l.TAG_ID.DT:{FA(e,t);break}case l.TAG_ID.H1:case l.TAG_ID.H2:case l.TAG_ID.H3:case l.TAG_ID.H4:case l.TAG_ID.H5:case l.TAG_ID.H6:{kA(e);break}case l.TAG_ID.BR:{UA(e);break}case l.TAG_ID.BODY:{RA(e,t);break}case l.TAG_ID.HTML:{PA(e,t);break}case l.TAG_ID.FORM:{wA(e);break}case l.TAG_ID.APPLET:case l.TAG_ID.OBJECT:case l.TAG_ID.MARQUEE:{HA(e,t);break}case l.TAG_ID.TEMPLATE:{Su(e,t);break}default:l1(e,t)}}function d1(e,t){e.tmplInsertionModeStack.length>0?x1(e,t):vo(e,t)}function GA(e,t){var r;t.tagID===l.TAG_ID.SCRIPT&&((r=e.scriptHandler)===null||r===void 0||r.call(e,e.openElements.current)),e.openElements.pop(),e.insertionMode=e.originalInsertionMode}function qA(e,t){e._err(t,at.ERR.eofInElementThatCanContainOnlyText),e.openElements.pop(),e.insertionMode=e.originalInsertionMode,e.onEof(t)}function To(e,t){if(e.openElements.currentTagId!==void 0&&i1.has(e.openElements.currentTagId))switch(e.pendingCharacterTokens.length=0,e.hasNonWhitespacePendingCharacterToken=!1,e.originalInsertionMode=e.insertionMode,e.insertionMode=y.IN_TABLE_TEXT,t.type){case We.TokenType.CHARACTER:{p1(e,t);break}case We.TokenType.WHITESPACE_CHARACTER:{h1(e,t);break}}else ca(e,t)}function jA(e,t){e.openElements.clearBackToTableContext(),e.activeFormattingElements.insertMarker(),e._insertElement(t,l.NS.HTML),e.insertionMode=y.IN_CAPTION}function zA(e,t){e.openElements.clearBackToTableContext(),e._insertElement(t,l.NS.HTML),e.insertionMode=y.IN_COLUMN_GROUP}function YA(e,t){e.openElements.clearBackToTableContext(),e._insertFakeElement(l.TAG_NAMES.COLGROUP,l.TAG_ID.COLGROUP),e.insertionMode=y.IN_COLUMN_GROUP,yo(e,t)}function WA(e,t){e.openElements.clearBackToTableContext(),e._insertElement(t,l.NS.HTML),e.insertionMode=y.IN_TABLE_BODY}function VA(e,t){e.openElements.clearBackToTableContext(),e._insertFakeElement(l.TAG_NAMES.TBODY,l.TAG_ID.TBODY),e.insertionMode=y.IN_TABLE_BODY,On(e,t)}function QA(e,t){e.openElements.hasInTableScope(l.TAG_ID.TABLE)&&(e.openElements.popUntilTagNamePopped(l.TAG_ID.TABLE),e._resetInsertionMode(),e._processStartTag(t))}function XA(e,t){f1(t)?e._appendElement(t,l.NS.HTML):ca(e,t),t.ackSelfClosing=!0}function KA(e,t){!e.formElement&&e.openElements.tmplCount===0&&(e._insertElement(t,l.NS.HTML),e.formElement=e.openElements.current,e.openElements.pop())}function l0(e,t){switch(t.tagID){case l.TAG_ID.TD:case l.TAG_ID.TH:case l.TAG_ID.TR:{VA(e,t);break}case l.TAG_ID.STYLE:case l.TAG_ID.SCRIPT:case l.TAG_ID.TEMPLATE:{Zt(e,t);break}case l.TAG_ID.COL:{YA(e,t);break}case l.TAG_ID.FORM:{KA(e,t);break}case l.TAG_ID.TABLE:{QA(e,t);break}case l.TAG_ID.TBODY:case l.TAG_ID.TFOOT:case l.TAG_ID.THEAD:{WA(e,t);break}case l.TAG_ID.INPUT:{XA(e,t);break}case l.TAG_ID.CAPTION:{jA(e,t);break}case l.TAG_ID.COLGROUP:{zA(e,t);break}default:ca(e,t)}}function oa(e,t){switch(t.tagID){case l.TAG_ID.TABLE:{e.openElements.hasInTableScope(l.TAG_ID.TABLE)&&(e.openElements.popUntilTagNamePopped(l.TAG_ID.TABLE),e._resetInsertionMode());break}case l.TAG_ID.TEMPLATE:{Su(e,t);break}case l.TAG_ID.BODY:case l.TAG_ID.CAPTION:case l.TAG_ID.COL:case l.TAG_ID.COLGROUP:case l.TAG_ID.HTML:case l.TAG_ID.TBODY:case l.TAG_ID.TD:case l.TAG_ID.TFOOT:case l.TAG_ID.TH:case l.TAG_ID.THEAD:case l.TAG_ID.TR:break;default:ca(e,t)}}function ca(e,t){let r=e.fosterParentingEnabled;e.fosterParentingEnabled=!0,Sn(e,t),e.fosterParentingEnabled=r}function h1(e,t){e.pendingCharacterTokens.push(t)}function p1(e,t){e.pendingCharacterTokens.push(t),e.hasNonWhitespacePendingCharacterToken=!0}function ra(e,t){let r=0;if(e.hasNonWhitespacePendingCharacterToken)for(;r<e.pendingCharacterTokens.length;r++)ca(e,e.pendingCharacterTokens[r]);else for(;r<e.pendingCharacterTokens.length;r++)e._insertCharacters(e.pendingCharacterTokens[r]);e.insertionMode=e.originalInsertionMode,e._processToken(t)}var b1=new Set([l.TAG_ID.CAPTION,l.TAG_ID.COL,l.TAG_ID.COLGROUP,l.TAG_ID.TBODY,l.TAG_ID.TD,l.TAG_ID.TFOOT,l.TAG_ID.TH,l.TAG_ID.THEAD,l.TAG_ID.TR]);function $A(e,t){let r=t.tagID;b1.has(r)?e.openElements.hasInTableScope(l.TAG_ID.CAPTION)&&(e.openElements.generateImpliedEndTags(),e.openElements.popUntilTagNamePopped(l.TAG_ID.CAPTION),e.activeFormattingElements.clearToLastMarker(),e.insertionMode=y.IN_TABLE,l0(e,t)):ft(e,t)}function ZA(e,t){let r=t.tagID;switch(r){case l.TAG_ID.CAPTION:case l.TAG_ID.TABLE:{e.openElements.hasInTableScope(l.TAG_ID.CAPTION)&&(e.openElements.generateImpliedEndTags(),e.openElements.popUntilTagNamePopped(l.TAG_ID.CAPTION),e.activeFormattingElements.clearToLastMarker(),e.insertionMode=y.IN_TABLE,r===l.TAG_ID.TABLE&&oa(e,t));break}case l.TAG_ID.BODY:case l.TAG_ID.COL:case l.TAG_ID.COLGROUP:case l.TAG_ID.HTML:case l.TAG_ID.TBODY:case l.TAG_ID.TD:case l.TAG_ID.TFOOT:case l.TAG_ID.TH:case l.TAG_ID.THEAD:case l.TAG_ID.TR:break;default:Nn(e,t)}}function yo(e,t){switch(t.tagID){case l.TAG_ID.HTML:{ft(e,t);break}case l.TAG_ID.COL:{e._appendElement(t,l.NS.HTML),t.ackSelfClosing=!0;break}case l.TAG_ID.TEMPLATE:{Zt(e,t);break}default:Cn(e,t)}}function JA(e,t){switch(t.tagID){case l.TAG_ID.COLGROUP:{e.openElements.currentTagId===l.TAG_ID.COLGROUP&&(e.openElements.pop(),e.insertionMode=y.IN_TABLE);break}case l.TAG_ID.TEMPLATE:{Su(e,t);break}case l.TAG_ID.COL:break;default:Cn(e,t)}}function Cn(e,t){e.openElements.currentTagId===l.TAG_ID.COLGROUP&&(e.openElements.pop(),e.insertionMode=y.IN_TABLE,e._processToken(t))}function On(e,t){switch(t.tagID){case l.TAG_ID.TR:{e.openElements.clearBackToTableBodyContext(),e._insertElement(t,l.NS.HTML),e.insertionMode=y.IN_ROW;break}case l.TAG_ID.TH:case l.TAG_ID.TD:{e.openElements.clearBackToTableBodyContext(),e._insertFakeElement(l.TAG_NAMES.TR,l.TAG_ID.TR),e.insertionMode=y.IN_ROW,Rn(e,t);break}case l.TAG_ID.CAPTION:case l.TAG_ID.COL:case l.TAG_ID.COLGROUP:case l.TAG_ID.TBODY:case l.TAG_ID.TFOOT:case l.TAG_ID.THEAD:{e.openElements.hasTableBodyContextInTableScope()&&(e.openElements.clearBackToTableBodyContext(),e.openElements.pop(),e.insertionMode=y.IN_TABLE,l0(e,t));break}default:l0(e,t)}}function mo(e,t){let r=t.tagID;switch(t.tagID){case l.TAG_ID.TBODY:case l.TAG_ID.TFOOT:case l.TAG_ID.THEAD:{e.openElements.hasInTableScope(r)&&(e.openElements.clearBackToTableBodyContext(),e.openElements.pop(),e.insertionMode=y.IN_TABLE);break}case l.TAG_ID.TABLE:{e.openElements.hasTableBodyContextInTableScope()&&(e.openElements.clearBackToTableBodyContext(),e.openElements.pop(),e.insertionMode=y.IN_TABLE,oa(e,t));break}case l.TAG_ID.BODY:case l.TAG_ID.CAPTION:case l.TAG_ID.COL:case l.TAG_ID.COLGROUP:case l.TAG_ID.HTML:case l.TAG_ID.TD:case l.TAG_ID.TH:case l.TAG_ID.TR:break;default:oa(e,t)}}function Rn(e,t){switch(t.tagID){case l.TAG_ID.TH:case l.TAG_ID.TD:{e.openElements.clearBackToTableRowContext(),e._insertElement(t,l.NS.HTML),e.insertionMode=y.IN_CELL,e.activeFormattingElements.insertMarker();break}case l.TAG_ID.CAPTION:case l.TAG_ID.COL:case l.TAG_ID.COLGROUP:case l.TAG_ID.TBODY:case l.TAG_ID.TFOOT:case l.TAG_ID.THEAD:case l.TAG_ID.TR:{e.openElements.hasInTableScope(l.TAG_ID.TR)&&(e.openElements.clearBackToTableRowContext(),e.openElements.pop(),e.insertionMode=y.IN_TABLE_BODY,On(e,t));break}default:l0(e,t)}}function _1(e,t){switch(t.tagID){case l.TAG_ID.TR:{e.openElements.hasInTableScope(l.TAG_ID.TR)&&(e.openElements.clearBackToTableRowContext(),e.openElements.pop(),e.insertionMode=y.IN_TABLE_BODY);break}case l.TAG_ID.TABLE:{e.openElements.hasInTableScope(l.TAG_ID.TR)&&(e.openElements.clearBackToTableRowContext(),e.openElements.pop(),e.insertionMode=y.IN_TABLE_BODY,mo(e,t));break}case l.TAG_ID.TBODY:case l.TAG_ID.TFOOT:case l.TAG_ID.THEAD:{(e.openElements.hasInTableScope(t.tagID)||e.openElements.hasInTableScope(l.TAG_ID.TR))&&(e.openElements.clearBackToTableRowContext(),e.openElements.pop(),e.insertionMode=y.IN_TABLE_BODY,mo(e,t));break}case l.TAG_ID.BODY:case l.TAG_ID.CAPTION:case l.TAG_ID.COL:case l.TAG_ID.COLGROUP:case l.TAG_ID.HTML:case l.TAG_ID.TD:case l.TAG_ID.TH:break;default:oa(e,t)}}function e8(e,t){let r=t.tagID;b1.has(r)?(e.openElements.hasInTableScope(l.TAG_ID.TD)||e.openElements.hasInTableScope(l.TAG_ID.TH))&&(e._closeTableCell(),Rn(e,t)):ft(e,t)}function t8(e,t){let r=t.tagID;switch(r){case l.TAG_ID.TD:case l.TAG_ID.TH:{e.openElements.hasInTableScope(r)&&(e.openElements.generateImpliedEndTags(),e.openElements.popUntilTagNamePopped(r),e.activeFormattingElements.clearToLastMarker(),e.insertionMode=y.IN_ROW);break}case l.TAG_ID.TABLE:case l.TAG_ID.TBODY:case l.TAG_ID.TFOOT:case l.TAG_ID.THEAD:case l.TAG_ID.TR:{e.openElements.hasInTableScope(r)&&(e._closeTableCell(),_1(e,t));break}case l.TAG_ID.BODY:case l.TAG_ID.CAPTION:case l.TAG_ID.COL:case l.TAG_ID.COLGROUP:case l.TAG_ID.HTML:break;default:Nn(e,t)}}function E1(e,t){switch(t.tagID){case l.TAG_ID.HTML:{ft(e,t);break}case l.TAG_ID.OPTION:{e.openElements.currentTagId===l.TAG_ID.OPTION&&e.openElements.pop(),e._insertElement(t,l.NS.HTML);break}case l.TAG_ID.OPTGROUP:{e.openElements.currentTagId===l.TAG_ID.OPTION&&e.openElements.pop(),e.openElements.currentTagId===l.TAG_ID.OPTGROUP&&e.openElements.pop(),e._insertElement(t,l.NS.HTML);break}case l.TAG_ID.HR:{e.openElements.currentTagId===l.TAG_ID.OPTION&&e.openElements.pop(),e.openElements.currentTagId===l.TAG_ID.OPTGROUP&&e.openElements.pop(),e._appendElement(t,l.NS.HTML),t.ackSelfClosing=!0;break}case l.TAG_ID.INPUT:case l.TAG_ID.KEYGEN:case l.TAG_ID.TEXTAREA:case l.TAG_ID.SELECT:{e.openElements.hasInSelectScope(l.TAG_ID.SELECT)&&(e.openElements.popUntilTagNamePopped(l.TAG_ID.SELECT),e._resetInsertionMode(),t.tagID!==l.TAG_ID.SELECT&&e._processStartTag(t));break}case l.TAG_ID.SCRIPT:case l.TAG_ID.TEMPLATE:{Zt(e,t);break}default:}}function T1(e,t){switch(t.tagID){case l.TAG_ID.OPTGROUP:{e.openElements.stackTop>0&&e.openElements.currentTagId===l.TAG_ID.OPTION&&e.openElements.tagIDs[e.openElements.stackTop-1]===l.TAG_ID.OPTGROUP&&e.openElements.pop(),e.openElements.currentTagId===l.TAG_ID.OPTGROUP&&e.openElements.pop();break}case l.TAG_ID.OPTION:{e.openElements.currentTagId===l.TAG_ID.OPTION&&e.openElements.pop();break}case l.TAG_ID.SELECT:{e.openElements.hasInSelectScope(l.TAG_ID.SELECT)&&(e.openElements.popUntilTagNamePopped(l.TAG_ID.SELECT),e._resetInsertionMode());break}case l.TAG_ID.TEMPLATE:{Su(e,t);break}default:}}function r8(e,t){let r=t.tagID;r===l.TAG_ID.CAPTION||r===l.TAG_ID.TABLE||r===l.TAG_ID.TBODY||r===l.TAG_ID.TFOOT||r===l.TAG_ID.THEAD||r===l.TAG_ID.TR||r===l.TAG_ID.TD||r===l.TAG_ID.TH?(e.openElements.popUntilTagNamePopped(l.TAG_ID.SELECT),e._resetInsertionMode(),e._processStartTag(t)):E1(e,t)}function u8(e,t){let r=t.tagID;r===l.TAG_ID.CAPTION||r===l.TAG_ID.TABLE||r===l.TAG_ID.TBODY||r===l.TAG_ID.TFOOT||r===l.TAG_ID.THEAD||r===l.TAG_ID.TR||r===l.TAG_ID.TD||r===l.TAG_ID.TH?e.openElements.hasInTableScope(r)&&(e.openElements.popUntilTagNamePopped(l.TAG_ID.SELECT),e._resetInsertionMode(),e.onEndTag(t)):T1(e,t)}function a8(e,t){switch(t.tagID){case l.TAG_ID.BASE:case l.TAG_ID.BASEFONT:case l.TAG_ID.BGSOUND:case l.TAG_ID.LINK:case l.TAG_ID.META:case l.TAG_ID.NOFRAMES:case l.TAG_ID.SCRIPT:case l.TAG_ID.STYLE:case l.TAG_ID.TEMPLATE:case l.TAG_ID.TITLE:{Zt(e,t);break}case l.TAG_ID.CAPTION:case l.TAG_ID.COLGROUP:case l.TAG_ID.TBODY:case l.TAG_ID.TFOOT:case l.TAG_ID.THEAD:{e.tmplInsertionModeStack[0]=y.IN_TABLE,e.insertionMode=y.IN_TABLE,l0(e,t);break}case l.TAG_ID.COL:{e.tmplInsertionModeStack[0]=y.IN_COLUMN_GROUP,e.insertionMode=y.IN_COLUMN_GROUP,yo(e,t);break}case l.TAG_ID.TR:{e.tmplInsertionModeStack[0]=y.IN_TABLE_BODY,e.insertionMode=y.IN_TABLE_BODY,On(e,t);break}case l.TAG_ID.TD:case l.TAG_ID.TH:{e.tmplInsertionModeStack[0]=y.IN_ROW,e.insertionMode=y.IN_ROW,Rn(e,t);break}default:e.tmplInsertionModeStack[0]=y.IN_BODY,e.insertionMode=y.IN_BODY,ft(e,t)}}function n8(e,t){t.tagID===l.TAG_ID.TEMPLATE&&Su(e,t)}function x1(e,t){e.openElements.tmplCount>0?(e.openElements.popUntilTagNamePopped(l.TAG_ID.TEMPLATE),e.activeFormattingElements.clearToLastMarker(),e.tmplInsertionModeStack.shift(),e._resetInsertionMode(),e.onEof(t)):vo(e,t)}function i8(e,t){t.tagID===l.TAG_ID.HTML?ft(e,t):In(e,t)}function A1(e,t){var r;if(t.tagID===l.TAG_ID.HTML){if(e.fragmentContext||(e.insertionMode=y.AFTER_AFTER_BODY),e.options.sourceCodeLocationInfo&&e.openElements.tagIDs[0]===l.TAG_ID.HTML){e._setEndLocation(e.openElements.items[0],t);let u=e.openElements.items[1];u&&!(!((r=e.treeAdapter.getNodeSourceCodeLocation(u))===null||r===void 0)&&r.endTag)&&e._setEndLocation(u,t)}}else In(e,t)}function In(e,t){e.insertionMode=y.IN_BODY,Sn(e,t)}function s8(e,t){switch(t.tagID){case l.TAG_ID.HTML:{ft(e,t);break}case l.TAG_ID.FRAMESET:{e._insertElement(t,l.NS.HTML);break}case l.TAG_ID.FRAME:{e._appendElement(t,l.NS.HTML),t.ackSelfClosing=!0;break}case l.TAG_ID.NOFRAMES:{Zt(e,t);break}default:}}function o8(e,t){t.tagID===l.TAG_ID.FRAMESET&&!e.openElements.isRootHtmlElementCurrent()&&(e.openElements.pop(),!e.fragmentContext&&e.openElements.currentTagId!==l.TAG_ID.FRAMESET&&(e.insertionMode=y.AFTER_FRAMESET))}function c8(e,t){switch(t.tagID){case l.TAG_ID.HTML:{ft(e,t);break}case l.TAG_ID.NOFRAMES:{Zt(e,t);break}default:}}function f8(e,t){t.tagID===l.TAG_ID.HTML&&(e.insertionMode=y.AFTER_AFTER_FRAMESET)}function l8(e,t){t.tagID===l.TAG_ID.HTML?ft(e,t):Dn(e,t)}function Dn(e,t){e.insertionMode=y.IN_BODY,Sn(e,t)}function d8(e,t){switch(t.tagID){case l.TAG_ID.HTML:{ft(e,t);break}case l.TAG_ID.NOFRAMES:{Zt(e,t);break}default:}}function h8(e,t){t.chars=n1.REPLACEMENT_CHARACTER,e._insertCharacters(t)}function p8(e,t){e._insertCharacters(t),e.framesetOk=!1}function m1(e){for(;e.treeAdapter.getNamespaceURI(e.openElements.current)!==l.NS.HTML&&e.openElements.currentTagId!==void 0&&!e._isIntegrationPoint(e.openElements.currentTagId,e.openElements.current);)e.openElements.pop()}function b8(e,t){if(hr.causesExit(t))m1(e),e._startTagOutsideForeignContent(t);else{let r=e._getAdjustedCurrentElement(),u=e.treeAdapter.getNamespaceURI(r);u===l.NS.MATHML?hr.adjustTokenMathMLAttrs(t):u===l.NS.SVG&&(hr.adjustTokenSVGTagName(t),hr.adjustTokenSVGAttrs(t)),hr.adjustTokenXMLAttrs(t),t.selfClosing?e._appendElement(t,u):e._insertElement(t,u),t.ackSelfClosing=!0}}function _8(e,t){if(t.tagID===l.TAG_ID.P||t.tagID===l.TAG_ID.BR){m1(e),e._endTagOutsideForeignContent(t);return}for(let r=e.openElements.stackTop;r>0;r--){let u=e.openElements.items[r];if(e.treeAdapter.getNamespaceURI(u)===l.NS.HTML){e._endTagOutsideForeignContent(t);break}let a=e.treeAdapter.getTagName(u);if(a.toLowerCase()===t.tagName){t.tagName=a,e.openElements.shortenToLength(r);break}}}});var y1=R(tt=>{"use strict";Object.defineProperty(tt,"__esModule",{value:!0});tt.escapeText=tt.escapeAttribute=tt.escapeUTF8=tt.escape=tt.getCodePoint=tt.xmlReplacer=void 0;tt.encodeXML=v1;tt.xmlReplacer=/["$&\'<>\\u0080-\\uFFFF]/g;var g1=new Map([[34,"&quot;"],[38,"&amp;"],[39,"&apos;"],[60,"&lt;"],[62,"&gt;"]]);tt.getCodePoint=String.prototype.codePointAt==null?(e,t)=>(e.charCodeAt(t)&64512)===55296?(e.charCodeAt(t)-55296)*1024+e.charCodeAt(t+1)-56320+65536:e.charCodeAt(t):(e,t)=>e.codePointAt(t);function v1(e){let t="",r=0,u;for(;(u=tt.xmlReplacer.exec(e))!==null;){let{index:a}=u,n=e.charCodeAt(a),s=g1.get(n);s===void 0?(t+=`${e.substring(r,a)}&#x${(0,tt.getCodePoint)(e,a).toString(16)};`,r=tt.xmlReplacer.lastIndex+=+((n&64512)===55296)):(t+=e.substring(r,a)+s,r=a+1)}return t+e.substr(r)}tt.escape=v1;function Co(e,t){return function(u){let a,n=0,s="";for(;a=e.exec(u);)n!==a.index&&(s+=u.substring(n,a.index)),s+=t.get(a[0].charCodeAt(0)),n=a.index+1;return s+u.substring(n)}}tt.escapeUTF8=Co(/["&\'<>]/g,g1);tt.escapeAttribute=Co(/["&\\u00A0]/g,new Map([[34,"&quot;"],[38,"&amp;"],[160,"&nbsp;"]]));tt.escapeText=Co(/[&<>\\u00A0]/g,new Map([[38,"&amp;"],[60,"&lt;"],[62,"&gt;"],[160,"&nbsp;"]]))});var O1=R(Bn=>{"use strict";Object.defineProperty(Bn,"__esModule",{value:!0});Bn.serialize=x8;Bn.serializeOuter=A8;var Be=Or(),D1=y1(),E8=vn(),T8=new Set([Be.TAG_NAMES.AREA,Be.TAG_NAMES.BASE,Be.TAG_NAMES.BASEFONT,Be.TAG_NAMES.BGSOUND,Be.TAG_NAMES.BR,Be.TAG_NAMES.COL,Be.TAG_NAMES.EMBED,Be.TAG_NAMES.FRAME,Be.TAG_NAMES.HR,Be.TAG_NAMES.IMG,Be.TAG_NAMES.INPUT,Be.TAG_NAMES.KEYGEN,Be.TAG_NAMES.LINK,Be.TAG_NAMES.META,Be.TAG_NAMES.PARAM,Be.TAG_NAMES.SOURCE,Be.TAG_NAMES.TRACK,Be.TAG_NAMES.WBR]);function C1(e,t){return t.treeAdapter.isElementNode(e)&&t.treeAdapter.getNamespaceURI(e)===Be.NS.HTML&&T8.has(t.treeAdapter.getTagName(e))}var I1={treeAdapter:E8.defaultTreeAdapter,scriptingEnabled:!0};function x8(e,t){let r=Object.assign(Object.assign({},I1),t);return C1(e,r)?"":S1(e,r)}function A8(e,t){let r=Object.assign(Object.assign({},I1),t);return N1(e,r)}function S1(e,t){let r="",u=t.treeAdapter.isElementNode(e)&&t.treeAdapter.getTagName(e)===Be.TAG_NAMES.TEMPLATE&&t.treeAdapter.getNamespaceURI(e)===Be.NS.HTML?t.treeAdapter.getTemplateContent(e):e,a=t.treeAdapter.getChildNodes(u);if(a)for(let n of a)r+=N1(n,t);return r}function N1(e,t){return t.treeAdapter.isElementNode(e)?m8(e,t):t.treeAdapter.isTextNode(e)?v8(e,t):t.treeAdapter.isCommentNode(e)?y8(e,t):t.treeAdapter.isDocumentTypeNode(e)?D8(e,t):""}function m8(e,t){let r=t.treeAdapter.getTagName(e);return`<${r}${g8(e,t)}>${C1(e,t)?"":`${S1(e,t)}</${r}>`}`}function g8(e,{treeAdapter:t}){let r="";for(let u of t.getAttrList(e)){if(r+=" ",u.namespace)switch(u.namespace){case Be.NS.XML:{r+=`xml:${u.name}`;break}case Be.NS.XMLNS:{u.name!=="xmlns"&&(r+="xmlns:"),r+=u.name;break}case Be.NS.XLINK:{r+=`xlink:${u.name}`;break}default:r+=`${u.prefix}:${u.name}`}else r+=u.name;r+=`="${(0,D1.escapeAttribute)(u.value)}"`}return r}function v8(e,t){let{treeAdapter:r}=t,u=r.getTextNodeContent(e),a=r.getParentNode(e),n=a&&r.isElementNode(a)&&r.getTagName(a);return n&&r.getNamespaceURI(a)===Be.NS.HTML&&(0,Be.hasUnescapedText)(n,t.scriptingEnabled)?u:(0,D1.escapeText)(u)}function y8(e,{treeAdapter:t}){return`<!--${t.getCommentNodeContent(e)}-->`}function D8(e,{treeAdapter:t}){return`<!DOCTYPE ${t.getDocumentTypeNodeName(e)}>`}});var Io=R(Fe=>{"use strict";Object.defineProperty(Fe,"__esModule",{value:!0});Fe.TokenizerMode=Fe.Tokenizer=Fe.Token=Fe.html=Fe.foreignContent=Fe.ErrorCodes=Fe.serializeOuter=Fe.serialize=Fe.Parser=Fe.defaultTreeAdapter=void 0;Fe.parse=N8;Fe.parseFragment=O8;var R1=Do(),C8=vn();Object.defineProperty(Fe,"defaultTreeAdapter",{enumerable:!0,get:function(){return C8.defaultTreeAdapter}});var I8=Do();Object.defineProperty(Fe,"Parser",{enumerable:!0,get:function(){return I8.Parser}});var P1=O1();Object.defineProperty(Fe,"serialize",{enumerable:!0,get:function(){return P1.serialize}});Object.defineProperty(Fe,"serializeOuter",{enumerable:!0,get:function(){return P1.serializeOuter}});var S8=Z0();Object.defineProperty(Fe,"ErrorCodes",{enumerable:!0,get:function(){return S8.ERR}});Fe.foreignContent=Eo();Fe.html=Or();Fe.Token=bn();var B1=ho();Object.defineProperty(Fe,"Tokenizer",{enumerable:!0,get:function(){return B1.Tokenizer}});Object.defineProperty(Fe,"TokenizerMode",{enumerable:!0,get:function(){return B1.TokenizerMode}});function N8(e,t){return R1.Parser.parse(e,t)}function O8(e,t,r){typeof e=="string"&&(r=t,t=e,e=null);let u=R1.Parser.getFragmentParser(e,r);return u.tokenizer.write(t,!0),u.getFragment()}});var M1=R(Jt=>{"use strict";Object.defineProperty(Jt,"__esModule",{value:!0});Jt.adapter=void 0;Jt.serializeDoctypeContent=L1;var R8=Io(),Lt=st();function w1(e){let t=e.includes(\'"\')?"\'":\'"\';return t+e+t}function L1(e,t,r){let u="!DOCTYPE ";return e&&(u+=e),t?u+=` PUBLIC ${w1(t)}`:r&&(u+=" SYSTEM"),r&&(u+=` ${w1(r)}`),u}Jt.adapter={isCommentNode:Lt.isComment,isElementNode:Lt.isTag,isTextNode:Lt.isText,createDocument(){let e=new Lt.Document([]);return e["x-mode"]=R8.html.DOCUMENT_MODE.NO_QUIRKS,e},createDocumentFragment(){return new Lt.Document([])},createElement(e,t,r){let u=Object.create(null),a=Object.create(null),n=Object.create(null);for(let i=0;i<r.length;i++){let c=r[i].name;u[c]=r[i].value,a[c]=r[i].namespace,n[c]=r[i].prefix}let s=new Lt.Element(e,u,[]);return s.namespace=t,s["x-attribsNamespace"]=a,s["x-attribsPrefix"]=n,s},createCommentNode(e){return new Lt.Comment(e)},createTextNode(e){return new Lt.Text(e)},appendChild(e,t){let r=e.children[e.children.length-1];r&&(r.next=t,t.prev=r),e.children.push(t),t.parent=e},insertBefore(e,t,r){let u=e.children.indexOf(r),{prev:a}=r;a&&(a.next=t,t.prev=a),r.prev=t,t.next=r,e.children.splice(u,0,t),t.parent=e},setTemplateContent(e,t){Jt.adapter.appendChild(e,t)},getTemplateContent(e){return e.children[0]},setDocumentType(e,t,r,u){let a=L1(t,r,u),n=e.children.find(s=>(0,Lt.isDirective)(s)&&s.name==="!doctype");n?n.data=a!=null?a:null:(n=new Lt.ProcessingInstruction("!doctype",a),Jt.adapter.appendChild(e,n)),n["x-name"]=t,n["x-publicId"]=r,n["x-systemId"]=u},setDocumentMode(e,t){e["x-mode"]=t},getDocumentMode(e){return e["x-mode"]},detachNode(e){if(e.parent){let t=e.parent.children.indexOf(e),{prev:r,next:u}=e;e.prev=null,e.next=null,r&&(r.next=u),u&&(u.prev=r),e.parent.children.splice(t,1),e.parent=null}},insertText(e,t){let r=e.children[e.children.length-1];r&&(0,Lt.isText)(r)?r.data+=t:Jt.adapter.appendChild(e,Jt.adapter.createTextNode(t))},insertTextBefore(e,t,r){let u=e.children[e.children.indexOf(r)-1];u&&(0,Lt.isText)(u)?u.data+=t:Jt.adapter.insertBefore(e,Jt.adapter.createTextNode(t),r)},adoptAttributes(e,t){for(let r=0;r<t.length;r++){let u=t[r].name;e.attribs[u]===void 0&&(e.attribs[u]=t[r].value,e["x-attribsNamespace"][u]=t[r].namespace,e["x-attribsPrefix"][u]=t[r].prefix)}},getFirstChild(e){return e.children[0]},getChildNodes(e){return e.children},getParentNode(e){return e.parent},getAttrList(e){return e.attributes},getTagName(e){return e.name},getNamespaceURI(e){return e.namespace},getTextNodeContent(e){return e.data},getCommentNodeContent(e){return e.data},getDocumentTypeNodeName(e){var t;return(t=e["x-name"])!==null&&t!==void 0?t:""},getDocumentTypeNodePublicId(e){var t;return(t=e["x-publicId"])!==null&&t!==void 0?t:""},getDocumentTypeNodeSystemId(e){var t;return(t=e["x-systemId"])!==null&&t!==void 0?t:""},isDocumentTypeNode(e){return(0,Lt.isDirective)(e)&&e.name==="!doctype"},setNodeSourceCodeLocation(e,t){t&&(e.startIndex=t.startOffset,e.endIndex=t.endOffset),e.sourceCodeLocation=t},getNodeSourceCodeLocation(e){return e.sourceCodeLocation},updateNodeSourceCodeLocation(e,t){t.endOffset!=null&&(e.endIndex=t.endOffset),e.sourceCodeLocation=Object.assign(Object.assign({},e.sourceCodeLocation),t)}}});var k1=R(ru=>{"use strict";var P8=ru&&ru.__spreadArray||function(e,t,r){if(r||arguments.length===2)for(var u=0,a=t.length,n;u<a;u++)(n||!(u in t))&&(n||(n=Array.prototype.slice.call(t,0,u)),n[u]=t[u]);return e.concat(n||Array.prototype.slice.call(t))};Object.defineProperty(ru,"__esModule",{value:!0});ru.renderWithParse5=ru.parseWithParse5=void 0;var B8=st(),So=Io(),F1=M1();function w8(e,t,r,u){var a={scriptingEnabled:typeof t.scriptingEnabled=="boolean"?t.scriptingEnabled:!0,treeAdapter:F1.adapter,sourceCodeLocationInfo:t.sourceCodeLocationInfo};return r?(0,So.parse)(e,a):(0,So.parseFragment)(u,e,a)}ru.parseWithParse5=w8;var L8={treeAdapter:F1.adapter};function M8(e){for(var t,r=("length"in e)?e:[e],u=0;u<r.length;u+=1){var a=r[u];(0,B8.isDocument)(a)&&(t=Array.prototype.splice).call.apply(t,P8([r,u,1],a.children,!1))}for(var n="",u=0;u<r.length;u+=1){var a=r[u];n+=(0,So.serializeOuter)(a,L8)}return n}ru.renderWithParse5=M8});var No=R(h0=>{"use strict";Object.defineProperty(h0,"__esModule",{value:!0});h0.QuoteType=void 0;var Nu=L0(),se;(function(e){e[e.Tab=9]="Tab",e[e.NewLine=10]="NewLine",e[e.FormFeed=12]="FormFeed",e[e.CarriageReturn=13]="CarriageReturn",e[e.Space=32]="Space",e[e.ExclamationMark=33]="ExclamationMark",e[e.Number=35]="Number",e[e.Amp=38]="Amp",e[e.SingleQuote=39]="SingleQuote",e[e.DoubleQuote=34]="DoubleQuote",e[e.Dash=45]="Dash",e[e.Slash=47]="Slash",e[e.Zero=48]="Zero",e[e.Nine=57]="Nine",e[e.Semi=59]="Semi",e[e.Lt=60]="Lt",e[e.Eq=61]="Eq",e[e.Gt=62]="Gt",e[e.Questionmark=63]="Questionmark",e[e.UpperA=65]="UpperA",e[e.LowerA=97]="LowerA",e[e.UpperF=70]="UpperF",e[e.LowerF=102]="LowerF",e[e.UpperZ=90]="UpperZ",e[e.LowerZ=122]="LowerZ",e[e.LowerX=120]="LowerX",e[e.OpeningSquareBracket=91]="OpeningSquareBracket"})(se||(se={}));var J;(function(e){e[e.Text=1]="Text",e[e.BeforeTagName=2]="BeforeTagName",e[e.InTagName=3]="InTagName",e[e.InSelfClosingTag=4]="InSelfClosingTag",e[e.BeforeClosingTagName=5]="BeforeClosingTagName",e[e.InClosingTagName=6]="InClosingTagName",e[e.AfterClosingTagName=7]="AfterClosingTagName",e[e.BeforeAttributeName=8]="BeforeAttributeName",e[e.InAttributeName=9]="InAttributeName",e[e.AfterAttributeName=10]="AfterAttributeName",e[e.BeforeAttributeValue=11]="BeforeAttributeValue",e[e.InAttributeValueDq=12]="InAttributeValueDq",e[e.InAttributeValueSq=13]="InAttributeValueSq",e[e.InAttributeValueNq=14]="InAttributeValueNq",e[e.BeforeDeclaration=15]="BeforeDeclaration",e[e.InDeclaration=16]="InDeclaration",e[e.InProcessingInstruction=17]="InProcessingInstruction",e[e.BeforeComment=18]="BeforeComment",e[e.CDATASequence=19]="CDATASequence",e[e.InSpecialComment=20]="InSpecialComment",e[e.InCommentLike=21]="InCommentLike",e[e.BeforeSpecialS=22]="BeforeSpecialS",e[e.SpecialStartSequence=23]="SpecialStartSequence",e[e.InSpecialTag=24]="InSpecialTag",e[e.BeforeEntity=25]="BeforeEntity",e[e.BeforeNumericEntity=26]="BeforeNumericEntity",e[e.InNamedEntity=27]="InNamedEntity",e[e.InNumericEntity=28]="InNumericEntity",e[e.InHexEntity=29]="InHexEntity"})(J||(J={}));function Pr(e){return e===se.Space||e===se.NewLine||e===se.Tab||e===se.FormFeed||e===se.CarriageReturn}function wn(e){return e===se.Slash||e===se.Gt||Pr(e)}function H1(e){return e>=se.Zero&&e<=se.Nine}function F8(e){return e>=se.LowerA&&e<=se.LowerZ||e>=se.UpperA&&e<=se.UpperZ}function k8(e){return e>=se.UpperA&&e<=se.UpperF||e>=se.LowerA&&e<=se.LowerF}var d0;(function(e){e[e.NoValue=0]="NoValue",e[e.Unquoted=1]="Unquoted",e[e.Single=2]="Single",e[e.Double=3]="Double"})(d0=h0.QuoteType||(h0.QuoteType={}));var Ct={Cdata:new Uint8Array([67,68,65,84,65,91]),CdataEnd:new Uint8Array([93,93,62]),CommentEnd:new Uint8Array([45,45,62]),ScriptEnd:new Uint8Array([60,47,115,99,114,105,112,116]),StyleEnd:new Uint8Array([60,47,115,116,121,108,101]),TitleEnd:new Uint8Array([60,47,116,105,116,108,101])},H8=function(){function e(t,r){var u=t.xmlMode,a=u===void 0?!1:u,n=t.decodeEntities,s=n===void 0?!0:n;this.cbs=r,this.state=J.Text,this.buffer="",this.sectionStart=0,this.index=0,this.baseState=J.Text,this.isSpecial=!1,this.running=!0,this.offset=0,this.currentSequence=void 0,this.sequenceIndex=0,this.trieIndex=0,this.trieCurrent=0,this.entityResult=0,this.entityExcess=0,this.xmlMode=a,this.decodeEntities=s,this.entityTrie=a?Nu.xmlDecodeTree:Nu.htmlDecodeTree}return e.prototype.reset=function(){this.state=J.Text,this.buffer="",this.sectionStart=0,this.index=0,this.baseState=J.Text,this.currentSequence=void 0,this.running=!0,this.offset=0},e.prototype.write=function(t){this.offset+=this.buffer.length,this.buffer=t,this.parse()},e.prototype.end=function(){this.running&&this.finish()},e.prototype.pause=function(){this.running=!1},e.prototype.resume=function(){this.running=!0,this.index<this.buffer.length+this.offset&&this.parse()},e.prototype.getIndex=function(){return this.index},e.prototype.getSectionStart=function(){return this.sectionStart},e.prototype.stateText=function(t){t===se.Lt||!this.decodeEntities&&this.fastForwardTo(se.Lt)?(this.index>this.sectionStart&&this.cbs.ontext(this.sectionStart,this.index),this.state=J.BeforeTagName,this.sectionStart=this.index):this.decodeEntities&&t===se.Amp&&(this.state=J.BeforeEntity)},e.prototype.stateSpecialStartSequence=function(t){var r=this.sequenceIndex===this.currentSequence.length,u=r?wn(t):(t|32)===this.currentSequence[this.sequenceIndex];if(!u)this.isSpecial=!1;else if(!r){this.sequenceIndex++;return}this.sequenceIndex=0,this.state=J.InTagName,this.stateInTagName(t)},e.prototype.stateInSpecialTag=function(t){if(this.sequenceIndex===this.currentSequence.length){if(t===se.Gt||Pr(t)){var r=this.index-this.currentSequence.length;if(this.sectionStart<r){var u=this.index;this.index=r,this.cbs.ontext(this.sectionStart,r),this.index=u}this.isSpecial=!1,this.sectionStart=r+2,this.stateInClosingTagName(t);return}this.sequenceIndex=0}(t|32)===this.currentSequence[this.sequenceIndex]?this.sequenceIndex+=1:this.sequenceIndex===0?this.currentSequence===Ct.TitleEnd?this.decodeEntities&&t===se.Amp&&(this.state=J.BeforeEntity):this.fastForwardTo(se.Lt)&&(this.sequenceIndex=1):this.sequenceIndex=+(t===se.Lt)},e.prototype.stateCDATASequence=function(t){t===Ct.Cdata[this.sequenceIndex]?++this.sequenceIndex===Ct.Cdata.length&&(this.state=J.InCommentLike,this.currentSequence=Ct.CdataEnd,this.sequenceIndex=0,this.sectionStart=this.index+1):(this.sequenceIndex=0,this.state=J.InDeclaration,this.stateInDeclaration(t))},e.prototype.fastForwardTo=function(t){for(;++this.index<this.buffer.length+this.offset;)if(this.buffer.charCodeAt(this.index-this.offset)===t)return!0;return this.index=this.buffer.length+this.offset-1,!1},e.prototype.stateInCommentLike=function(t){t===this.currentSequence[this.sequenceIndex]?++this.sequenceIndex===this.currentSequence.length&&(this.currentSequence===Ct.CdataEnd?this.cbs.oncdata(this.sectionStart,this.index,2):this.cbs.oncomment(this.sectionStart,this.index,2),this.sequenceIndex=0,this.sectionStart=this.index+1,this.state=J.Text):this.sequenceIndex===0?this.fastForwardTo(this.currentSequence[0])&&(this.sequenceIndex=1):t!==this.currentSequence[this.sequenceIndex-1]&&(this.sequenceIndex=0)},e.prototype.isTagStartChar=function(t){return this.xmlMode?!wn(t):F8(t)},e.prototype.startSpecial=function(t,r){this.isSpecial=!0,this.currentSequence=t,this.sequenceIndex=r,this.state=J.SpecialStartSequence},e.prototype.stateBeforeTagName=function(t){if(t===se.ExclamationMark)this.state=J.BeforeDeclaration,this.sectionStart=this.index+1;else if(t===se.Questionmark)this.state=J.InProcessingInstruction,this.sectionStart=this.index+1;else if(this.isTagStartChar(t)){var r=t|32;this.sectionStart=this.index,!this.xmlMode&&r===Ct.TitleEnd[2]?this.startSpecial(Ct.TitleEnd,3):this.state=!this.xmlMode&&r===Ct.ScriptEnd[2]?J.BeforeSpecialS:J.InTagName}else t===se.Slash?this.state=J.BeforeClosingTagName:(this.state=J.Text,this.stateText(t))},e.prototype.stateInTagName=function(t){wn(t)&&(this.cbs.onopentagname(this.sectionStart,this.index),this.sectionStart=-1,this.state=J.BeforeAttributeName,this.stateBeforeAttributeName(t))},e.prototype.stateBeforeClosingTagName=function(t){Pr(t)||(t===se.Gt?this.state=J.Text:(this.state=this.isTagStartChar(t)?J.InClosingTagName:J.InSpecialComment,this.sectionStart=this.index))},e.prototype.stateInClosingTagName=function(t){(t===se.Gt||Pr(t))&&(this.cbs.onclosetag(this.sectionStart,this.index),this.sectionStart=-1,this.state=J.AfterClosingTagName,this.stateAfterClosingTagName(t))},e.prototype.stateAfterClosingTagName=function(t){(t===se.Gt||this.fastForwardTo(se.Gt))&&(this.state=J.Text,this.baseState=J.Text,this.sectionStart=this.index+1)},e.prototype.stateBeforeAttributeName=function(t){t===se.Gt?(this.cbs.onopentagend(this.index),this.isSpecial?(this.state=J.InSpecialTag,this.sequenceIndex=0):this.state=J.Text,this.baseState=this.state,this.sectionStart=this.index+1):t===se.Slash?this.state=J.InSelfClosingTag:Pr(t)||(this.state=J.InAttributeName,this.sectionStart=this.index)},e.prototype.stateInSelfClosingTag=function(t){t===se.Gt?(this.cbs.onselfclosingtag(this.index),this.state=J.Text,this.baseState=J.Text,this.sectionStart=this.index+1,this.isSpecial=!1):Pr(t)||(this.state=J.BeforeAttributeName,this.stateBeforeAttributeName(t))},e.prototype.stateInAttributeName=function(t){(t===se.Eq||wn(t))&&(this.cbs.onattribname(this.sectionStart,this.index),this.sectionStart=-1,this.state=J.AfterAttributeName,this.stateAfterAttributeName(t))},e.prototype.stateAfterAttributeName=function(t){t===se.Eq?this.state=J.BeforeAttributeValue:t===se.Slash||t===se.Gt?(this.cbs.onattribend(d0.NoValue,this.index),this.state=J.BeforeAttributeName,this.stateBeforeAttributeName(t)):Pr(t)||(this.cbs.onattribend(d0.NoValue,this.index),this.state=J.InAttributeName,this.sectionStart=this.index)},e.prototype.stateBeforeAttributeValue=function(t){t===se.DoubleQuote?(this.state=J.InAttributeValueDq,this.sectionStart=this.index+1):t===se.SingleQuote?(this.state=J.InAttributeValueSq,this.sectionStart=this.index+1):Pr(t)||(this.sectionStart=this.index,this.state=J.InAttributeValueNq,this.stateInAttributeValueNoQuotes(t))},e.prototype.handleInAttributeValue=function(t,r){t===r||!this.decodeEntities&&this.fastForwardTo(r)?(this.cbs.onattribdata(this.sectionStart,this.index),this.sectionStart=-1,this.cbs.onattribend(r===se.DoubleQuote?d0.Double:d0.Single,this.index),this.state=J.BeforeAttributeName):this.decodeEntities&&t===se.Amp&&(this.baseState=this.state,this.state=J.BeforeEntity)},e.prototype.stateInAttributeValueDoubleQuotes=function(t){this.handleInAttributeValue(t,se.DoubleQuote)},e.prototype.stateInAttributeValueSingleQuotes=function(t){this.handleInAttributeValue(t,se.SingleQuote)},e.prototype.stateInAttributeValueNoQuotes=function(t){Pr(t)||t===se.Gt?(this.cbs.onattribdata(this.sectionStart,this.index),this.sectionStart=-1,this.cbs.onattribend(d0.Unquoted,this.index),this.state=J.BeforeAttributeName,this.stateBeforeAttributeName(t)):this.decodeEntities&&t===se.Amp&&(this.baseState=this.state,this.state=J.BeforeEntity)},e.prototype.stateBeforeDeclaration=function(t){t===se.OpeningSquareBracket?(this.state=J.CDATASequence,this.sequenceIndex=0):this.state=t===se.Dash?J.BeforeComment:J.InDeclaration},e.prototype.stateInDeclaration=function(t){(t===se.Gt||this.fastForwardTo(se.Gt))&&(this.cbs.ondeclaration(this.sectionStart,this.index),this.state=J.Text,this.sectionStart=this.index+1)},e.prototype.stateInProcessingInstruction=function(t){(t===se.Gt||this.fastForwardTo(se.Gt))&&(this.cbs.onprocessinginstruction(this.sectionStart,this.index),this.state=J.Text,this.sectionStart=this.index+1)},e.prototype.stateBeforeComment=function(t){t===se.Dash?(this.state=J.InCommentLike,this.currentSequence=Ct.CommentEnd,this.sequenceIndex=2,this.sectionStart=this.index+1):this.state=J.InDeclaration},e.prototype.stateInSpecialComment=function(t){(t===se.Gt||this.fastForwardTo(se.Gt))&&(this.cbs.oncomment(this.sectionStart,this.index,0),this.state=J.Text,this.sectionStart=this.index+1)},e.prototype.stateBeforeSpecialS=function(t){var r=t|32;r===Ct.ScriptEnd[3]?this.startSpecial(Ct.ScriptEnd,4):r===Ct.StyleEnd[3]?this.startSpecial(Ct.StyleEnd,4):(this.state=J.InTagName,this.stateInTagName(t))},e.prototype.stateBeforeEntity=function(t){this.entityExcess=1,this.entityResult=0,t===se.Number?this.state=J.BeforeNumericEntity:t===se.Amp||(this.trieIndex=0,this.trieCurrent=this.entityTrie[0],this.state=J.InNamedEntity,this.stateInNamedEntity(t))},e.prototype.stateInNamedEntity=function(t){if(this.entityExcess+=1,this.trieIndex=(0,Nu.determineBranch)(this.entityTrie,this.trieCurrent,this.trieIndex+1,t),this.trieIndex<0){this.emitNamedEntity(),this.index--;return}this.trieCurrent=this.entityTrie[this.trieIndex];var r=this.trieCurrent&Nu.BinTrieFlags.VALUE_LENGTH;if(r){var u=(r>>14)-1;if(!this.allowLegacyEntity()&&t!==se.Semi)this.trieIndex+=u;else{var a=this.index-this.entityExcess+1;a>this.sectionStart&&this.emitPartial(this.sectionStart,a),this.entityResult=this.trieIndex,this.trieIndex+=u,this.entityExcess=0,this.sectionStart=this.index+1,u===0&&this.emitNamedEntity()}}},e.prototype.emitNamedEntity=function(){if(this.state=this.baseState,this.entityResult!==0){var t=(this.entityTrie[this.entityResult]&Nu.BinTrieFlags.VALUE_LENGTH)>>14;switch(t){case 1:{this.emitCodePoint(this.entityTrie[this.entityResult]&~Nu.BinTrieFlags.VALUE_LENGTH);break}case 2:{this.emitCodePoint(this.entityTrie[this.entityResult+1]);break}case 3:this.emitCodePoint(this.entityTrie[this.entityResult+1]),this.emitCodePoint(this.entityTrie[this.entityResult+2])}}},e.prototype.stateBeforeNumericEntity=function(t){(t|32)===se.LowerX?(this.entityExcess++,this.state=J.InHexEntity):(this.state=J.InNumericEntity,this.stateInNumericEntity(t))},e.prototype.emitNumericEntity=function(t){var r=this.index-this.entityExcess-1,u=r+2+ +(this.state===J.InHexEntity);u!==this.index&&(r>this.sectionStart&&this.emitPartial(this.sectionStart,r),this.sectionStart=this.index+Number(t),this.emitCodePoint((0,Nu.replaceCodePoint)(this.entityResult))),this.state=this.baseState},e.prototype.stateInNumericEntity=function(t){t===se.Semi?this.emitNumericEntity(!0):H1(t)?(this.entityResult=this.entityResult*10+(t-se.Zero),this.entityExcess++):(this.allowLegacyEntity()?this.emitNumericEntity(!1):this.state=this.baseState,this.index--)},e.prototype.stateInHexEntity=function(t){t===se.Semi?this.emitNumericEntity(!0):H1(t)?(this.entityResult=this.entityResult*16+(t-se.Zero),this.entityExcess++):k8(t)?(this.entityResult=this.entityResult*16+((t|32)-se.LowerA+10),this.entityExcess++):(this.allowLegacyEntity()?this.emitNumericEntity(!1):this.state=this.baseState,this.index--)},e.prototype.allowLegacyEntity=function(){return!this.xmlMode&&(this.baseState===J.Text||this.baseState===J.InSpecialTag)},e.prototype.cleanup=function(){this.running&&this.sectionStart!==this.index&&(this.state===J.Text||this.state===J.InSpecialTag&&this.sequenceIndex===0?(this.cbs.ontext(this.sectionStart,this.index),this.sectionStart=this.index):(this.state===J.InAttributeValueDq||this.state===J.InAttributeValueSq||this.state===J.InAttributeValueNq)&&(this.cbs.onattribdata(this.sectionStart,this.index),this.sectionStart=this.index))},e.prototype.shouldContinue=function(){return this.index<this.buffer.length+this.offset&&this.running},e.prototype.parse=function(){for(;this.shouldContinue();){var t=this.buffer.charCodeAt(this.index-this.offset);switch(this.state){case J.Text:{this.stateText(t);break}case J.SpecialStartSequence:{this.stateSpecialStartSequence(t);break}case J.InSpecialTag:{this.stateInSpecialTag(t);break}case J.CDATASequence:{this.stateCDATASequence(t);break}case J.InAttributeValueDq:{this.stateInAttributeValueDoubleQuotes(t);break}case J.InAttributeName:{this.stateInAttributeName(t);break}case J.InCommentLike:{this.stateInCommentLike(t);break}case J.InSpecialComment:{this.stateInSpecialComment(t);break}case J.BeforeAttributeName:{this.stateBeforeAttributeName(t);break}case J.InTagName:{this.stateInTagName(t);break}case J.InClosingTagName:{this.stateInClosingTagName(t);break}case J.BeforeTagName:{this.stateBeforeTagName(t);break}case J.AfterAttributeName:{this.stateAfterAttributeName(t);break}case J.InAttributeValueSq:{this.stateInAttributeValueSingleQuotes(t);break}case J.BeforeAttributeValue:{this.stateBeforeAttributeValue(t);break}case J.BeforeClosingTagName:{this.stateBeforeClosingTagName(t);break}case J.AfterClosingTagName:{this.stateAfterClosingTagName(t);break}case J.BeforeSpecialS:{this.stateBeforeSpecialS(t);break}case J.InAttributeValueNq:{this.stateInAttributeValueNoQuotes(t);break}case J.InSelfClosingTag:{this.stateInSelfClosingTag(t);break}case J.InDeclaration:{this.stateInDeclaration(t);break}case J.BeforeDeclaration:{this.stateBeforeDeclaration(t);break}case J.BeforeComment:{this.stateBeforeComment(t);break}case J.InProcessingInstruction:{this.stateInProcessingInstruction(t);break}case J.InNamedEntity:{this.stateInNamedEntity(t);break}case J.BeforeEntity:{this.stateBeforeEntity(t);break}case J.InHexEntity:{this.stateInHexEntity(t);break}case J.InNumericEntity:{this.stateInNumericEntity(t);break}default:this.stateBeforeNumericEntity(t)}this.index++}this.cleanup()},e.prototype.finish=function(){this.state===J.InNamedEntity&&this.emitNamedEntity(),this.sectionStart<this.index&&this.handleTrailingData(),this.cbs.onend()},e.prototype.handleTrailingData=function(){var t=this.buffer.length+this.offset;this.state===J.InCommentLike?this.currentSequence===Ct.CdataEnd?this.cbs.oncdata(this.sectionStart,t,0):this.cbs.oncomment(this.sectionStart,t,0):this.state===J.InNumericEntity&&this.allowLegacyEntity()?this.emitNumericEntity(!1):this.state===J.InHexEntity&&this.allowLegacyEntity()?this.emitNumericEntity(!1):this.state===J.InTagName||this.state===J.BeforeAttributeName||this.state===J.BeforeAttributeValue||this.state===J.AfterAttributeName||this.state===J.InAttributeName||this.state===J.InAttributeValueSq||this.state===J.InAttributeValueDq||this.state===J.InAttributeValueNq||this.state===J.InClosingTagName||this.cbs.ontext(this.sectionStart,t)},e.prototype.emitPartial=function(t,r){this.baseState!==J.Text&&this.baseState!==J.InSpecialTag?this.cbs.onattribdata(t,r):this.cbs.ontext(t,r)},e.prototype.emitCodePoint=function(t){this.baseState!==J.Text&&this.baseState!==J.InSpecialTag?this.cbs.onattribentity(t):this.cbs.ontextentity(t)},e}();h0.default=H8});var Oo=R(pr=>{"use strict";var U8=pr&&pr.__createBinding||(Object.create?function(e,t,r,u){u===void 0&&(u=r);var a=Object.getOwnPropertyDescriptor(t,r);(!a||("get"in a?!t.__esModule:a.writable||a.configurable))&&(a={enumerable:!0,get:function(){return t[r]}}),Object.defineProperty(e,u,a)}:function(e,t,r,u){u===void 0&&(u=r),e[u]=t[r]}),G8=pr&&pr.__setModuleDefault||(Object.create?function(e,t){Object.defineProperty(e,"default",{enumerable:!0,value:t})}:function(e,t){e.default=t}),q8=pr&&pr.__importStar||function(e){if(e&&e.__esModule)return e;var t={};if(e!=null)for(var r in e)r!=="default"&&Object.prototype.hasOwnProperty.call(e,r)&&U8(t,e,r);return G8(t,e),t};Object.defineProperty(pr,"__esModule",{value:!0});pr.Parser=void 0;var Ln=q8(No()),U1=L0(),p0=new Set(["input","option","optgroup","select","button","datalist","textarea"]),Ne=new Set(["p"]),G1=new Set(["thead","tbody"]),q1=new Set(["dd","dt"]),j1=new Set(["rt","rp"]),j8=new Map([["tr",new Set(["tr","th","td"])],["th",new Set(["th"])],["td",new Set(["thead","th","td"])],["body",new Set(["head","link","script"])],["li",new Set(["li"])],["p",Ne],["h1",Ne],["h2",Ne],["h3",Ne],["h4",Ne],["h5",Ne],["h6",Ne],["select",p0],["input",p0],["output",p0],["button",p0],["datalist",p0],["textarea",p0],["option",new Set(["option"])],["optgroup",new Set(["optgroup","option"])],["dd",q1],["dt",q1],["address",Ne],["article",Ne],["aside",Ne],["blockquote",Ne],["details",Ne],["div",Ne],["dl",Ne],["fieldset",Ne],["figcaption",Ne],["figure",Ne],["footer",Ne],["form",Ne],["header",Ne],["hr",Ne],["main",Ne],["nav",Ne],["ol",Ne],["pre",Ne],["section",Ne],["table",Ne],["ul",Ne],["rt",j1],["rp",j1],["tbody",G1],["tfoot",G1]]),z8=new Set(["area","base","basefont","br","col","command","embed","frame","hr","img","input","isindex","keygen","link","meta","param","source","track","wbr"]),z1=new Set(["math","svg"]),Y1=new Set(["mi","mo","mn","ms","mtext","annotation-xml","foreignobject","desc","title"]),Y8=/\\s|\\//,W8=function(){function e(t,r){r===void 0&&(r={});var u,a,n,s,i;this.options=r,this.startIndex=0,this.endIndex=0,this.openTagStart=0,this.tagname="",this.attribname="",this.attribvalue="",this.attribs=null,this.stack=[],this.foreignContext=[],this.buffers=[],this.bufferOffset=0,this.writeIndex=0,this.ended=!1,this.cbs=t!=null?t:{},this.lowerCaseTagNames=(u=r.lowerCaseTags)!==null&&u!==void 0?u:!r.xmlMode,this.lowerCaseAttributeNames=(a=r.lowerCaseAttributeNames)!==null&&a!==void 0?a:!r.xmlMode,this.tokenizer=new((n=r.Tokenizer)!==null&&n!==void 0?n:Ln.default)(this.options,this),(i=(s=this.cbs).onparserinit)===null||i===void 0||i.call(s,this)}return e.prototype.ontext=function(t,r){var u,a,n=this.getSlice(t,r);this.endIndex=r-1,(a=(u=this.cbs).ontext)===null||a===void 0||a.call(u,n),this.startIndex=r},e.prototype.ontextentity=function(t){var r,u,a=this.tokenizer.getSectionStart();this.endIndex=a-1,(u=(r=this.cbs).ontext)===null||u===void 0||u.call(r,(0,U1.fromCodePoint)(t)),this.startIndex=a},e.prototype.isVoidElement=function(t){return!this.options.xmlMode&&z8.has(t)},e.prototype.onopentagname=function(t,r){this.endIndex=r;var u=this.getSlice(t,r);this.lowerCaseTagNames&&(u=u.toLowerCase()),this.emitOpenTag(u)},e.prototype.emitOpenTag=function(t){var r,u,a,n;this.openTagStart=this.startIndex,this.tagname=t;var s=!this.options.xmlMode&&j8.get(t);if(s)for(;this.stack.length>0&&s.has(this.stack[this.stack.length-1]);){var i=this.stack.pop();(u=(r=this.cbs).onclosetag)===null||u===void 0||u.call(r,i,!0)}this.isVoidElement(t)||(this.stack.push(t),z1.has(t)?this.foreignContext.push(!0):Y1.has(t)&&this.foreignContext.push(!1)),(n=(a=this.cbs).onopentagname)===null||n===void 0||n.call(a,t),this.cbs.onopentag&&(this.attribs={})},e.prototype.endOpenTag=function(t){var r,u;this.startIndex=this.openTagStart,this.attribs&&((u=(r=this.cbs).onopentag)===null||u===void 0||u.call(r,this.tagname,this.attribs,t),this.attribs=null),this.cbs.onclosetag&&this.isVoidElement(this.tagname)&&this.cbs.onclosetag(this.tagname,!0),this.tagname=""},e.prototype.onopentagend=function(t){this.endIndex=t,this.endOpenTag(!1),this.startIndex=t+1},e.prototype.onclosetag=function(t,r){var u,a,n,s,i,c;this.endIndex=r;var o=this.getSlice(t,r);if(this.lowerCaseTagNames&&(o=o.toLowerCase()),(z1.has(o)||Y1.has(o))&&this.foreignContext.pop(),this.isVoidElement(o))!this.options.xmlMode&&o==="br"&&((a=(u=this.cbs).onopentagname)===null||a===void 0||a.call(u,"br"),(s=(n=this.cbs).onopentag)===null||s===void 0||s.call(n,"br",{},!0),(c=(i=this.cbs).onclosetag)===null||c===void 0||c.call(i,"br",!1));else{var f=this.stack.lastIndexOf(o);if(f!==-1)if(this.cbs.onclosetag)for(var p=this.stack.length-f;p--;)this.cbs.onclosetag(this.stack.pop(),p!==0);else this.stack.length=f;else!this.options.xmlMode&&o==="p"&&(this.emitOpenTag("p"),this.closeCurrentTag(!0))}this.startIndex=r+1},e.prototype.onselfclosingtag=function(t){this.endIndex=t,this.options.xmlMode||this.options.recognizeSelfClosing||this.foreignContext[this.foreignContext.length-1]?(this.closeCurrentTag(!1),this.startIndex=t+1):this.onopentagend(t)},e.prototype.closeCurrentTag=function(t){var r,u,a=this.tagname;this.endOpenTag(t),this.stack[this.stack.length-1]===a&&((u=(r=this.cbs).onclosetag)===null||u===void 0||u.call(r,a,!t),this.stack.pop())},e.prototype.onattribname=function(t,r){this.startIndex=t;var u=this.getSlice(t,r);this.attribname=this.lowerCaseAttributeNames?u.toLowerCase():u},e.prototype.onattribdata=function(t,r){this.attribvalue+=this.getSlice(t,r)},e.prototype.onattribentity=function(t){this.attribvalue+=(0,U1.fromCodePoint)(t)},e.prototype.onattribend=function(t,r){var u,a;this.endIndex=r,(a=(u=this.cbs).onattribute)===null||a===void 0||a.call(u,this.attribname,this.attribvalue,t===Ln.QuoteType.Double?\'"\':t===Ln.QuoteType.Single?"\'":t===Ln.QuoteType.NoValue?void 0:null),this.attribs&&!Object.prototype.hasOwnProperty.call(this.attribs,this.attribname)&&(this.attribs[this.attribname]=this.attribvalue),this.attribvalue=""},e.prototype.getInstructionName=function(t){var r=t.search(Y8),u=r<0?t:t.substr(0,r);return this.lowerCaseTagNames&&(u=u.toLowerCase()),u},e.prototype.ondeclaration=function(t,r){this.endIndex=r;var u=this.getSlice(t,r);if(this.cbs.onprocessinginstruction){var a=this.getInstructionName(u);this.cbs.onprocessinginstruction("!".concat(a),"!".concat(u))}this.startIndex=r+1},e.prototype.onprocessinginstruction=function(t,r){this.endIndex=r;var u=this.getSlice(t,r);if(this.cbs.onprocessinginstruction){var a=this.getInstructionName(u);this.cbs.onprocessinginstruction("?".concat(a),"?".concat(u))}this.startIndex=r+1},e.prototype.oncomment=function(t,r,u){var a,n,s,i;this.endIndex=r,(n=(a=this.cbs).oncomment)===null||n===void 0||n.call(a,this.getSlice(t,r-u)),(i=(s=this.cbs).oncommentend)===null||i===void 0||i.call(s),this.startIndex=r+1},e.prototype.oncdata=function(t,r,u){var a,n,s,i,c,o,f,p,d,b;this.endIndex=r;var _=this.getSlice(t,r-u);this.options.xmlMode||this.options.recognizeCDATA?((n=(a=this.cbs).oncdatastart)===null||n===void 0||n.call(a),(i=(s=this.cbs).ontext)===null||i===void 0||i.call(s,_),(o=(c=this.cbs).oncdataend)===null||o===void 0||o.call(c)):((p=(f=this.cbs).oncomment)===null||p===void 0||p.call(f,"[CDATA[".concat(_,"]]")),(b=(d=this.cbs).oncommentend)===null||b===void 0||b.call(d)),this.startIndex=r+1},e.prototype.onend=function(){var t,r;if(this.cbs.onclosetag){this.endIndex=this.startIndex;for(var u=this.stack.length;u>0;this.cbs.onclosetag(this.stack[--u],!0));}(r=(t=this.cbs).onend)===null||r===void 0||r.call(t)},e.prototype.reset=function(){var t,r,u,a;(r=(t=this.cbs).onreset)===null||r===void 0||r.call(t),this.tokenizer.reset(),this.tagname="",this.attribname="",this.attribs=null,this.stack.length=0,this.startIndex=0,this.endIndex=0,(a=(u=this.cbs).onparserinit)===null||a===void 0||a.call(u,this),this.buffers.length=0,this.bufferOffset=0,this.writeIndex=0,this.ended=!1},e.prototype.parseComplete=function(t){this.reset(),this.end(t)},e.prototype.getSlice=function(t,r){for(;t-this.bufferOffset>=this.buffers[0].length;)this.shiftBuffer();for(var u=this.buffers[0].slice(t-this.bufferOffset,r-this.bufferOffset);r-this.bufferOffset>this.buffers[0].length;)this.shiftBuffer(),u+=this.buffers[0].slice(0,r-this.bufferOffset);return u},e.prototype.shiftBuffer=function(){this.bufferOffset+=this.buffers[0].length,this.writeIndex--,this.buffers.shift()},e.prototype.write=function(t){var r,u;if(this.ended){(u=(r=this.cbs).onerror)===null||u===void 0||u.call(r,new Error(".write() after done!"));return}this.buffers.push(t),this.tokenizer.running&&(this.tokenizer.write(t),this.writeIndex++)},e.prototype.end=function(t){var r,u;if(this.ended){(u=(r=this.cbs).onerror)===null||u===void 0||u.call(r,new Error(".end() after done!"));return}t&&this.write(t),this.ended=!0,this.tokenizer.end()},e.prototype.pause=function(){this.tokenizer.pause()},e.prototype.resume=function(){for(this.tokenizer.resume();this.tokenizer.running&&this.writeIndex<this.buffers.length;)this.tokenizer.write(this.buffers[this.writeIndex++]);this.ended&&this.tokenizer.end()},e.prototype.parseChunk=function(t){this.write(t)},e.prototype.done=function(t){this.end(t)},e}();pr.Parser=W8});var Z1=R(ye=>{"use strict";var V8=ye&&ye.__createBinding||(Object.create?function(e,t,r,u){u===void 0&&(u=r);var a=Object.getOwnPropertyDescriptor(t,r);(!a||("get"in a?!t.__esModule:a.writable||a.configurable))&&(a={enumerable:!0,get:function(){return t[r]}}),Object.defineProperty(e,u,a)}:function(e,t,r,u){u===void 0&&(u=r),e[u]=t[r]}),Q8=ye&&ye.__setModuleDefault||(Object.create?function(e,t){Object.defineProperty(e,"default",{enumerable:!0,value:t})}:function(e,t){e.default=t}),W1=ye&&ye.__importStar||function(e){if(e&&e.__esModule)return e;var t={};if(e!=null)for(var r in e)r!=="default"&&Object.prototype.hasOwnProperty.call(e,r)&&V8(t,e,r);return Q8(t,e),t},X8=ye&&ye.__importDefault||function(e){return e&&e.__esModule?e:{default:e}};Object.defineProperty(ye,"__esModule",{value:!0});ye.DomUtils=ye.parseFeed=ye.getFeed=ye.ElementType=ye.Tokenizer=ye.createDomStream=ye.parseDOM=ye.parseDocument=ye.DefaultHandler=ye.DomHandler=ye.Parser=void 0;var V1=Oo(),K8=Oo();Object.defineProperty(ye,"Parser",{enumerable:!0,get:function(){return K8.Parser}});var Q1=st(),X1=st();Object.defineProperty(ye,"DomHandler",{enumerable:!0,get:function(){return X1.DomHandler}});Object.defineProperty(ye,"DefaultHandler",{enumerable:!0,get:function(){return X1.DomHandler}});function K1(e,t){var r=new Q1.DomHandler(void 0,t);return new V1.Parser(r,t).end(e),r.root}ye.parseDocument=K1;function $1(e,t){return K1(e,t).children}ye.parseDOM=$1;function $8(e,t,r){var u=new Q1.DomHandler(e,t,r);return new V1.Parser(u,t)}ye.createDomStream=$8;var Z8=No();Object.defineProperty(ye,"Tokenizer",{enumerable:!0,get:function(){return X8(Z8).default}});ye.ElementType=W1(qu());var J8=jt(),em=jt();Object.defineProperty(ye,"getFeed",{enumerable:!0,get:function(){return em.getFeed}});var tm={xmlMode:!0};function rm(e,t){return t===void 0&&(t=tm),(0,J8.getFeed)($1(e,t))}ye.parseFeed=rm;ye.DomUtils=W1(jt())});var th=R(Ce=>{"use strict";var J1=Ce&&Ce.__createBinding||(Object.create?function(e,t,r,u){u===void 0&&(u=r);var a=Object.getOwnPropertyDescriptor(t,r);(!a||("get"in a?!t.__esModule:a.writable||a.configurable))&&(a={enumerable:!0,get:function(){return t[r]}}),Object.defineProperty(e,u,a)}:function(e,t,r,u){u===void 0&&(u=r),e[u]=t[r]}),um=Ce&&Ce.__setModuleDefault||(Object.create?function(e,t){Object.defineProperty(e,"default",{enumerable:!0,value:t})}:function(e,t){e.default=t}),am=Ce&&Ce.__exportStar||function(e,t){for(var r in e)r!=="default"&&!Object.prototype.hasOwnProperty.call(t,r)&&J1(t,e,r)},nm=Ce&&Ce.__importStar||function(e){if(e&&e.__esModule)return e;var t={};if(e!=null)for(var r in e)r!=="default"&&Object.prototype.hasOwnProperty.call(e,r)&&J1(t,e,r);return um(t,e),t},im=Ce&&Ce.__importDefault||function(e){return e&&e.__esModule?e:{default:e}};Object.defineProperty(Ce,"__esModule",{value:!0});Ce.root=Ce.parseHTML=Ce.merge=Ce.contains=Ce.text=Ce.xml=Ce.html=Ce.load=void 0;am(af(),Ce);var sm=Cd(),om=Zs(),eh=k1(),cm=im(ls()),fm=Z1(),lm=(0,om.getParse)(function(e,t,r,u){return t.xmlMode||t._useHtmlParser2?(0,fm.parseDocument)(e,t):(0,eh.parseWithParse5)(e,t,r,u)});Ce.load=(0,sm.getLoad)(lm,function(e,t){return t.xmlMode||t._useHtmlParser2?(0,cm.default)(e,t):(0,eh.renderWithParse5)(e)});Ce.default=(0,Ce.load)([]);var Ro=gu();Object.defineProperty(Ce,"html",{enumerable:!0,get:function(){return Ro.html}});Object.defineProperty(Ce,"xml",{enumerable:!0,get:function(){return Ro.xml}});Object.defineProperty(Ce,"text",{enumerable:!0,get:function(){return Ro.text}});var Mn=nm(gu());Ce.contains=Mn.contains;Ce.merge=Mn.merge;Ce.parseHTML=Mn.parseHTML;Ce.root=Mn.root});var rh=R(()=>{});var Ae=R((Fn,uh)=>{(function(e,t){typeof Fn=="object"?uh.exports=Fn=t():typeof define=="function"&&define.amd?define([],t):e.CryptoJS=t()})(Fn,function(){var e=e||function(t,r){var u;if(typeof window!="undefined"&&window.crypto&&(u=window.crypto),typeof self!="undefined"&&self.crypto&&(u=self.crypto),typeof globalThis!="undefined"&&globalThis.crypto&&(u=globalThis.crypto),!u&&typeof window!="undefined"&&window.msCrypto&&(u=window.msCrypto),!u&&typeof global!="undefined"&&global.crypto&&(u=global.crypto),!u&&typeof rf=="function")try{u=rh()}catch(T){}var a=function(){if(u){if(typeof u.getRandomValues=="function")try{return u.getRandomValues(new Uint32Array(1))[0]}catch(T){}if(typeof u.randomBytes=="function")try{return u.randomBytes(4).readInt32LE()}catch(T){}}throw new Error("Native crypto module could not be used to get secure random number.")},n=Object.create||function(){function T(){}return function(A){var v;return T.prototype=A,v=new T,T.prototype=null,v}}(),s={},i=s.lib={},c=i.Base=function(){return{extend:function(T){var A=n(this);return T&&A.mixIn(T),(!A.hasOwnProperty("init")||this.init===A.init)&&(A.init=function(){A.$super.init.apply(this,arguments)}),A.init.prototype=A,A.$super=this,A},create:function(){var T=this.extend();return T.init.apply(T,arguments),T},init:function(){},mixIn:function(T){for(var A in T)T.hasOwnProperty(A)&&(this[A]=T[A]);T.hasOwnProperty("toString")&&(this.toString=T.toString)},clone:function(){return this.init.prototype.extend(this)}}}(),o=i.WordArray=c.extend({init:function(T,A){T=this.words=T||[],A!=r?this.sigBytes=A:this.sigBytes=T.length*4},toString:function(T){return(T||p).stringify(this)},concat:function(T){var A=this.words,v=T.words,g=this.sigBytes,N=T.sigBytes;if(this.clamp(),g%4)for(var P=0;P<N;P++){var H=v[P>>>2]>>>24-P%4*8&255;A[g+P>>>2]|=H<<24-(g+P)%4*8}else for(var k=0;k<N;k+=4)A[g+k>>>2]=v[k>>>2];return this.sigBytes+=N,this},clamp:function(){var T=this.words,A=this.sigBytes;T[A>>>2]&=4294967295<<32-A%4*8,T.length=t.ceil(A/4)},clone:function(){var T=c.clone.call(this);return T.words=this.words.slice(0),T},random:function(T){for(var A=[],v=0;v<T;v+=4)A.push(a());return new o.init(A,T)}}),f=s.enc={},p=f.Hex={stringify:function(T){for(var A=T.words,v=T.sigBytes,g=[],N=0;N<v;N++){var P=A[N>>>2]>>>24-N%4*8&255;g.push((P>>>4).toString(16)),g.push((P&15).toString(16))}return g.join("")},parse:function(T){for(var A=T.length,v=[],g=0;g<A;g+=2)v[g>>>3]|=parseInt(T.substr(g,2),16)<<24-g%8*4;return new o.init(v,A/2)}},d=f.Latin1={stringify:function(T){for(var A=T.words,v=T.sigBytes,g=[],N=0;N<v;N++){var P=A[N>>>2]>>>24-N%4*8&255;g.push(String.fromCharCode(P))}return g.join("")},parse:function(T){for(var A=T.length,v=[],g=0;g<A;g++)v[g>>>2]|=(T.charCodeAt(g)&255)<<24-g%4*8;return new o.init(v,A)}},b=f.Utf8={stringify:function(T){try{return decodeURIComponent(escape(d.stringify(T)))}catch(A){throw new Error("Malformed UTF-8 data")}},parse:function(T){return d.parse(unescape(encodeURIComponent(T)))}},_=i.BufferedBlockAlgorithm=c.extend({reset:function(){this._data=new o.init,this._nDataBytes=0},_append:function(T){typeof T=="string"&&(T=b.parse(T)),this._data.concat(T),this._nDataBytes+=T.sigBytes},_process:function(T){var A,v=this._data,g=v.words,N=v.sigBytes,P=this.blockSize,H=P*4,k=N/H;T?k=t.ceil(k):k=t.max((k|0)-this._minBufferSize,0);var B=k*P,j=t.min(B*4,N);if(B){for(var L=0;L<B;L+=P)this._doProcessBlock(g,L);A=g.splice(0,B),v.sigBytes-=j}return new o.init(A,j)},clone:function(){var T=c.clone.call(this);return T._data=this._data.clone(),T},_minBufferSize:0}),C=i.Hasher=_.extend({cfg:c.extend(),init:function(T){this.cfg=this.cfg.extend(T),this.reset()},reset:function(){_.reset.call(this),this._doReset()},update:function(T){return this._append(T),this._process(),this},finalize:function(T){T&&this._append(T);var A=this._doFinalize();return A},blockSize:512/32,_createHelper:function(T){return function(A,v){return new T.init(v).finalize(A)}},_createHmacHelper:function(T){return function(A,v){return new D.HMAC.init(T,v).finalize(A)}}}),D=s.algo={};return s}(Math);return e})});var fa=R((kn,ah)=>{(function(e,t){typeof kn=="object"?ah.exports=kn=t(Ae()):typeof define=="function"&&define.amd?define(["./core"],t):t(e.CryptoJS)})(kn,function(e){return function(t){var r=e,u=r.lib,a=u.Base,n=u.WordArray,s=r.x64={},i=s.Word=a.extend({init:function(o,f){this.high=o,this.low=f}}),c=s.WordArray=a.extend({init:function(o,f){o=this.words=o||[],f!=t?this.sigBytes=f:this.sigBytes=o.length*8},toX32:function(){for(var o=this.words,f=o.length,p=[],d=0;d<f;d++){var b=o[d];p.push(b.high),p.push(b.low)}return n.create(p,this.sigBytes)},clone:function(){for(var o=a.clone.call(this),f=o.words=this.words.slice(0),p=f.length,d=0;d<p;d++)f[d]=f[d].clone();return o}})}(),e})});var ih=R((Hn,nh)=>{(function(e,t){typeof Hn=="object"?nh.exports=Hn=t(Ae()):typeof define=="function"&&define.amd?define(["./core"],t):t(e.CryptoJS)})(Hn,function(e){return function(){if(typeof ArrayBuffer=="function"){var t=e,r=t.lib,u=r.WordArray,a=u.init,n=u.init=function(s){if(s instanceof ArrayBuffer&&(s=new Uint8Array(s)),(s instanceof Int8Array||typeof Uint8ClampedArray!="undefined"&&s instanceof Uint8ClampedArray||s instanceof Int16Array||s instanceof Uint16Array||s instanceof Int32Array||s instanceof Uint32Array||s instanceof Float32Array||s instanceof Float64Array)&&(s=new Uint8Array(s.buffer,s.byteOffset,s.byteLength)),s instanceof Uint8Array){for(var i=s.byteLength,c=[],o=0;o<i;o++)c[o>>>2]|=s[o]<<24-o%4*8;a.call(this,c,i)}else a.apply(this,arguments)};n.prototype=u}}(),e.lib.WordArray})});var oh=R((Un,sh)=>{(function(e,t){typeof Un=="object"?sh.exports=Un=t(Ae()):typeof define=="function"&&define.amd?define(["./core"],t):t(e.CryptoJS)})(Un,function(e){return function(){var t=e,r=t.lib,u=r.WordArray,a=t.enc,n=a.Utf16=a.Utf16BE={stringify:function(i){for(var c=i.words,o=i.sigBytes,f=[],p=0;p<o;p+=2){var d=c[p>>>2]>>>16-p%4*8&65535;f.push(String.fromCharCode(d))}return f.join("")},parse:function(i){for(var c=i.length,o=[],f=0;f<c;f++)o[f>>>1]|=i.charCodeAt(f)<<16-f%2*16;return u.create(o,c*2)}};a.Utf16LE={stringify:function(i){for(var c=i.words,o=i.sigBytes,f=[],p=0;p<o;p+=2){var d=s(c[p>>>2]>>>16-p%4*8&65535);f.push(String.fromCharCode(d))}return f.join("")},parse:function(i){for(var c=i.length,o=[],f=0;f<c;f++)o[f>>>1]|=s(i.charCodeAt(f)<<16-f%2*16);return u.create(o,c*2)}};function s(i){return i<<8&4278255360|i>>>8&16711935}}(),e.enc.Utf16})});var uu=R((Gn,ch)=>{(function(e,t){typeof Gn=="object"?ch.exports=Gn=t(Ae()):typeof define=="function"&&define.amd?define(["./core"],t):t(e.CryptoJS)})(Gn,function(e){return function(){var t=e,r=t.lib,u=r.WordArray,a=t.enc,n=a.Base64={stringify:function(i){var c=i.words,o=i.sigBytes,f=this._map;i.clamp();for(var p=[],d=0;d<o;d+=3)for(var b=c[d>>>2]>>>24-d%4*8&255,_=c[d+1>>>2]>>>24-(d+1)%4*8&255,C=c[d+2>>>2]>>>24-(d+2)%4*8&255,D=b<<16|_<<8|C,T=0;T<4&&d+T*.75<o;T++)p.push(f.charAt(D>>>6*(3-T)&63));var A=f.charAt(64);if(A)for(;p.length%4;)p.push(A);return p.join("")},parse:function(i){var c=i.length,o=this._map,f=this._reverseMap;if(!f){f=this._reverseMap=[];for(var p=0;p<o.length;p++)f[o.charCodeAt(p)]=p}var d=o.charAt(64);if(d){var b=i.indexOf(d);b!==-1&&(c=b)}return s(i,c,f)},_map:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="};function s(i,c,o){for(var f=[],p=0,d=0;d<c;d++)if(d%4){var b=o[i.charCodeAt(d-1)]<<d%4*2,_=o[i.charCodeAt(d)]>>>6-d%4*2,C=b|_;f[p>>>2]|=C<<24-p%4*8,p++}return u.create(f,p)}}(),e.enc.Base64})});var lh=R((qn,fh)=>{(function(e,t){typeof qn=="object"?fh.exports=qn=t(Ae()):typeof define=="function"&&define.amd?define(["./core"],t):t(e.CryptoJS)})(qn,function(e){return function(){var t=e,r=t.lib,u=r.WordArray,a=t.enc,n=a.Base64url={stringify:function(i,c){c===void 0&&(c=!0);var o=i.words,f=i.sigBytes,p=c?this._safe_map:this._map;i.clamp();for(var d=[],b=0;b<f;b+=3)for(var _=o[b>>>2]>>>24-b%4*8&255,C=o[b+1>>>2]>>>24-(b+1)%4*8&255,D=o[b+2>>>2]>>>24-(b+2)%4*8&255,T=_<<16|C<<8|D,A=0;A<4&&b+A*.75<f;A++)d.push(p.charAt(T>>>6*(3-A)&63));var v=p.charAt(64);if(v)for(;d.length%4;)d.push(v);return d.join("")},parse:function(i,c){c===void 0&&(c=!0);var o=i.length,f=c?this._safe_map:this._map,p=this._reverseMap;if(!p){p=this._reverseMap=[];for(var d=0;d<f.length;d++)p[f.charCodeAt(d)]=d}var b=f.charAt(64);if(b){var _=i.indexOf(b);_!==-1&&(o=_)}return s(i,o,p)},_map:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",_safe_map:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"};function s(i,c,o){for(var f=[],p=0,d=0;d<c;d++)if(d%4){var b=o[i.charCodeAt(d-1)]<<d%4*2,_=o[i.charCodeAt(d)]>>>6-d%4*2,C=b|_;f[p>>>2]|=C<<24-p%4*8,p++}return u.create(f,p)}}(),e.enc.Base64url})});var au=R((jn,dh)=>{(function(e,t){typeof jn=="object"?dh.exports=jn=t(Ae()):typeof define=="function"&&define.amd?define(["./core"],t):t(e.CryptoJS)})(jn,function(e){return function(t){var r=e,u=r.lib,a=u.WordArray,n=u.Hasher,s=r.algo,i=[];(function(){for(var b=0;b<64;b++)i[b]=t.abs(t.sin(b+1))*4294967296|0})();var c=s.MD5=n.extend({_doReset:function(){this._hash=new a.init([1732584193,4023233417,2562383102,271733878])},_doProcessBlock:function(b,_){for(var C=0;C<16;C++){var D=_+C,T=b[D];b[D]=(T<<8|T>>>24)&16711935|(T<<24|T>>>8)&4278255360}var A=this._hash.words,v=b[_+0],g=b[_+1],N=b[_+2],P=b[_+3],H=b[_+4],k=b[_+5],B=b[_+6],j=b[_+7],L=b[_+8],F=b[_+9],w=b[_+10],S=b[_+11],X=b[_+12],z=b[_+13],re=b[_+14],ue=b[_+15],U=A[0],W=A[1],Q=A[2],V=A[3];U=o(U,W,Q,V,v,7,i[0]),V=o(V,U,W,Q,g,12,i[1]),Q=o(Q,V,U,W,N,17,i[2]),W=o(W,Q,V,U,P,22,i[3]),U=o(U,W,Q,V,H,7,i[4]),V=o(V,U,W,Q,k,12,i[5]),Q=o(Q,V,U,W,B,17,i[6]),W=o(W,Q,V,U,j,22,i[7]),U=o(U,W,Q,V,L,7,i[8]),V=o(V,U,W,Q,F,12,i[9]),Q=o(Q,V,U,W,w,17,i[10]),W=o(W,Q,V,U,S,22,i[11]),U=o(U,W,Q,V,X,7,i[12]),V=o(V,U,W,Q,z,12,i[13]),Q=o(Q,V,U,W,re,17,i[14]),W=o(W,Q,V,U,ue,22,i[15]),U=f(U,W,Q,V,g,5,i[16]),V=f(V,U,W,Q,B,9,i[17]),Q=f(Q,V,U,W,S,14,i[18]),W=f(W,Q,V,U,v,20,i[19]),U=f(U,W,Q,V,k,5,i[20]),V=f(V,U,W,Q,w,9,i[21]),Q=f(Q,V,U,W,ue,14,i[22]),W=f(W,Q,V,U,H,20,i[23]),U=f(U,W,Q,V,F,5,i[24]),V=f(V,U,W,Q,re,9,i[25]),Q=f(Q,V,U,W,P,14,i[26]),W=f(W,Q,V,U,L,20,i[27]),U=f(U,W,Q,V,z,5,i[28]),V=f(V,U,W,Q,N,9,i[29]),Q=f(Q,V,U,W,j,14,i[30]),W=f(W,Q,V,U,X,20,i[31]),U=p(U,W,Q,V,k,4,i[32]),V=p(V,U,W,Q,L,11,i[33]),Q=p(Q,V,U,W,S,16,i[34]),W=p(W,Q,V,U,re,23,i[35]),U=p(U,W,Q,V,g,4,i[36]),V=p(V,U,W,Q,H,11,i[37]),Q=p(Q,V,U,W,j,16,i[38]),W=p(W,Q,V,U,w,23,i[39]),U=p(U,W,Q,V,z,4,i[40]),V=p(V,U,W,Q,v,11,i[41]),Q=p(Q,V,U,W,P,16,i[42]),W=p(W,Q,V,U,B,23,i[43]),U=p(U,W,Q,V,F,4,i[44]),V=p(V,U,W,Q,X,11,i[45]),Q=p(Q,V,U,W,ue,16,i[46]),W=p(W,Q,V,U,N,23,i[47]),U=d(U,W,Q,V,v,6,i[48]),V=d(V,U,W,Q,j,10,i[49]),Q=d(Q,V,U,W,re,15,i[50]),W=d(W,Q,V,U,k,21,i[51]),U=d(U,W,Q,V,X,6,i[52]),V=d(V,U,W,Q,P,10,i[53]),Q=d(Q,V,U,W,w,15,i[54]),W=d(W,Q,V,U,g,21,i[55]),U=d(U,W,Q,V,L,6,i[56]),V=d(V,U,W,Q,ue,10,i[57]),Q=d(Q,V,U,W,B,15,i[58]),W=d(W,Q,V,U,z,21,i[59]),U=d(U,W,Q,V,H,6,i[60]),V=d(V,U,W,Q,S,10,i[61]),Q=d(Q,V,U,W,N,15,i[62]),W=d(W,Q,V,U,F,21,i[63]),A[0]=A[0]+U|0,A[1]=A[1]+W|0,A[2]=A[2]+Q|0,A[3]=A[3]+V|0},_doFinalize:function(){var b=this._data,_=b.words,C=this._nDataBytes*8,D=b.sigBytes*8;_[D>>>5]|=128<<24-D%32;var T=t.floor(C/4294967296),A=C;_[(D+64>>>9<<4)+15]=(T<<8|T>>>24)&16711935|(T<<24|T>>>8)&4278255360,_[(D+64>>>9<<4)+14]=(A<<8|A>>>24)&16711935|(A<<24|A>>>8)&4278255360,b.sigBytes=(_.length+1)*4,this._process();for(var v=this._hash,g=v.words,N=0;N<4;N++){var P=g[N];g[N]=(P<<8|P>>>24)&16711935|(P<<24|P>>>8)&4278255360}return v},clone:function(){var b=n.clone.call(this);return b._hash=this._hash.clone(),b}});function o(b,_,C,D,T,A,v){var g=b+(_&C|~_&D)+T+v;return(g<<A|g>>>32-A)+_}function f(b,_,C,D,T,A,v){var g=b+(_&D|C&~D)+T+v;return(g<<A|g>>>32-A)+_}function p(b,_,C,D,T,A,v){var g=b+(_^C^D)+T+v;return(g<<A|g>>>32-A)+_}function d(b,_,C,D,T,A,v){var g=b+(C^(_|~D))+T+v;return(g<<A|g>>>32-A)+_}r.MD5=n._createHelper(c),r.HmacMD5=n._createHmacHelper(c)}(Math),e.MD5})});var Po=R((zn,hh)=>{(function(e,t){typeof zn=="object"?hh.exports=zn=t(Ae()):typeof define=="function"&&define.amd?define(["./core"],t):t(e.CryptoJS)})(zn,function(e){return function(){var t=e,r=t.lib,u=r.WordArray,a=r.Hasher,n=t.algo,s=[],i=n.SHA1=a.extend({_doReset:function(){this._hash=new u.init([1732584193,4023233417,2562383102,271733878,3285377520])},_doProcessBlock:function(c,o){for(var f=this._hash.words,p=f[0],d=f[1],b=f[2],_=f[3],C=f[4],D=0;D<80;D++){if(D<16)s[D]=c[o+D]|0;else{var T=s[D-3]^s[D-8]^s[D-14]^s[D-16];s[D]=T<<1|T>>>31}var A=(p<<5|p>>>27)+C+s[D];D<20?A+=(d&b|~d&_)+1518500249:D<40?A+=(d^b^_)+1859775393:D<60?A+=(d&b|d&_|b&_)-1894007588:A+=(d^b^_)-899497514,C=_,_=b,b=d<<30|d>>>2,d=p,p=A}f[0]=f[0]+p|0,f[1]=f[1]+d|0,f[2]=f[2]+b|0,f[3]=f[3]+_|0,f[4]=f[4]+C|0},_doFinalize:function(){var c=this._data,o=c.words,f=this._nDataBytes*8,p=c.sigBytes*8;return o[p>>>5]|=128<<24-p%32,o[(p+64>>>9<<4)+14]=Math.floor(f/4294967296),o[(p+64>>>9<<4)+15]=f,c.sigBytes=o.length*4,this._process(),this._hash},clone:function(){var c=a.clone.call(this);return c._hash=this._hash.clone(),c}});t.SHA1=a._createHelper(i),t.HmacSHA1=a._createHmacHelper(i)}(),e.SHA1})});var Wn=R((Yn,ph)=>{(function(e,t){typeof Yn=="object"?ph.exports=Yn=t(Ae()):typeof define=="function"&&define.amd?define(["./core"],t):t(e.CryptoJS)})(Yn,function(e){return function(t){var r=e,u=r.lib,a=u.WordArray,n=u.Hasher,s=r.algo,i=[],c=[];(function(){function p(C){for(var D=t.sqrt(C),T=2;T<=D;T++)if(!(C%T))return!1;return!0}function d(C){return(C-(C|0))*4294967296|0}for(var b=2,_=0;_<64;)p(b)&&(_<8&&(i[_]=d(t.pow(b,1/2))),c[_]=d(t.pow(b,1/3)),_++),b++})();var o=[],f=s.SHA256=n.extend({_doReset:function(){this._hash=new a.init(i.slice(0))},_doProcessBlock:function(p,d){for(var b=this._hash.words,_=b[0],C=b[1],D=b[2],T=b[3],A=b[4],v=b[5],g=b[6],N=b[7],P=0;P<64;P++){if(P<16)o[P]=p[d+P]|0;else{var H=o[P-15],k=(H<<25|H>>>7)^(H<<14|H>>>18)^H>>>3,B=o[P-2],j=(B<<15|B>>>17)^(B<<13|B>>>19)^B>>>10;o[P]=k+o[P-7]+j+o[P-16]}var L=A&v^~A&g,F=_&C^_&D^C&D,w=(_<<30|_>>>2)^(_<<19|_>>>13)^(_<<10|_>>>22),S=(A<<26|A>>>6)^(A<<21|A>>>11)^(A<<7|A>>>25),X=N+S+L+c[P]+o[P],z=w+F;N=g,g=v,v=A,A=T+X|0,T=D,D=C,C=_,_=X+z|0}b[0]=b[0]+_|0,b[1]=b[1]+C|0,b[2]=b[2]+D|0,b[3]=b[3]+T|0,b[4]=b[4]+A|0,b[5]=b[5]+v|0,b[6]=b[6]+g|0,b[7]=b[7]+N|0},_doFinalize:function(){var p=this._data,d=p.words,b=this._nDataBytes*8,_=p.sigBytes*8;return d[_>>>5]|=128<<24-_%32,d[(_+64>>>9<<4)+14]=t.floor(b/4294967296),d[(_+64>>>9<<4)+15]=b,p.sigBytes=d.length*4,this._process(),this._hash},clone:function(){var p=n.clone.call(this);return p._hash=this._hash.clone(),p}});r.SHA256=n._createHelper(f),r.HmacSHA256=n._createHmacHelper(f)}(Math),e.SHA256})});var _h=R((Vn,bh)=>{(function(e,t,r){typeof Vn=="object"?bh.exports=Vn=t(Ae(),Wn()):typeof define=="function"&&define.amd?define(["./core","./sha256"],t):t(e.CryptoJS)})(Vn,function(e){return function(){var t=e,r=t.lib,u=r.WordArray,a=t.algo,n=a.SHA256,s=a.SHA224=n.extend({_doReset:function(){this._hash=new u.init([3238371032,914150663,812702999,4144912697,4290775857,1750603025,1694076839,3204075428])},_doFinalize:function(){var i=n._doFinalize.call(this);return i.sigBytes-=4,i}});t.SHA224=n._createHelper(s),t.HmacSHA224=n._createHmacHelper(s)}(),e.SHA224})});var Bo=R((Qn,Eh)=>{(function(e,t,r){typeof Qn=="object"?Eh.exports=Qn=t(Ae(),fa()):typeof define=="function"&&define.amd?define(["./core","./x64-core"],t):t(e.CryptoJS)})(Qn,function(e){return function(){var t=e,r=t.lib,u=r.Hasher,a=t.x64,n=a.Word,s=a.WordArray,i=t.algo;function c(){return n.create.apply(n,arguments)}var o=[c(1116352408,3609767458),c(1899447441,602891725),c(3049323471,3964484399),c(3921009573,2173295548),c(961987163,4081628472),c(1508970993,3053834265),c(2453635748,2937671579),c(2870763221,3664609560),c(3624381080,2734883394),c(310598401,1164996542),c(607225278,1323610764),c(1426881987,3590304994),c(1925078388,4068182383),c(2162078206,991336113),c(2614888103,633803317),c(3248222580,3479774868),c(3835390401,2666613458),c(4022224774,944711139),c(264347078,2341262773),c(604807628,2007800933),c(770255983,1495990901),c(1249150122,1856431235),c(1555081692,3175218132),c(1996064986,2198950837),c(2554220882,3999719339),c(2821834349,766784016),c(2952996808,2566594879),c(3210313671,3203337956),c(3336571891,1034457026),c(3584528711,2466948901),c(113926993,3758326383),c(338241895,168717936),c(666307205,1188179964),c(773529912,1546045734),c(1294757372,1522805485),c(1396182291,2643833823),c(1695183700,2343527390),c(1986661051,1014477480),c(2177026350,1206759142),c(2456956037,344077627),c(2730485921,1290863460),c(2820302411,3158454273),c(3259730800,3505952657),c(3345764771,106217008),c(3516065817,3606008344),c(3600352804,1432725776),c(4094571909,1467031594),c(275423344,851169720),c(430227734,3100823752),c(506948616,1363258195),c(659060556,3750685593),c(883997877,3785050280),c(958139571,3318307427),c(1322822218,3812723403),c(1537002063,2003034995),c(1747873779,3602036899),c(1955562222,1575990012),c(2024104815,1125592928),c(2227730452,2716904306),c(2361852424,442776044),c(2428436474,593698344),c(2756734187,3733110249),c(3204031479,2999351573),c(3329325298,3815920427),c(3391569614,3928383900),c(3515267271,566280711),c(3940187606,3454069534),c(4118630271,4000239992),c(116418474,1914138554),c(174292421,2731055270),c(289380356,3203993006),c(460393269,320620315),c(685471733,587496836),c(852142971,1086792851),c(1017036298,365543100),c(1126000580,2618297676),c(1288033470,3409855158),c(1501505948,4234509866),c(1607167915,987167468),c(1816402316,1246189591)],f=[];(function(){for(var d=0;d<80;d++)f[d]=c()})();var p=i.SHA512=u.extend({_doReset:function(){this._hash=new s.init([new n.init(1779033703,4089235720),new n.init(3144134277,2227873595),new n.init(1013904242,4271175723),new n.init(2773480762,1595750129),new n.init(1359893119,2917565137),new n.init(2600822924,725511199),new n.init(528734635,4215389547),new n.init(1541459225,327033209)])},_doProcessBlock:function(d,b){for(var _=this._hash.words,C=_[0],D=_[1],T=_[2],A=_[3],v=_[4],g=_[5],N=_[6],P=_[7],H=C.high,k=C.low,B=D.high,j=D.low,L=T.high,F=T.low,w=A.high,S=A.low,X=v.high,z=v.low,re=g.high,ue=g.low,U=N.high,W=N.low,Q=P.high,V=P.low,de=H,xe=k,Oe=B,fe=j,dt=L,Re=F,ht=w,At=S,qe=X,it=z,Hu=re,pu=ue,Uu=U,kr=W,P0=Q,Ut=V,mt=0;mt<80;mt++){var pt,tr,ce=f[mt];if(mt<16)tr=ce.high=d[b+mt*2]|0,pt=ce.low=d[b+mt*2+1]|0;else{var rr=f[mt-15],h=rr.high,x=rr.low,I=(h>>>1|x<<31)^(h>>>8|x<<24)^h>>>7,O=(x>>>1|h<<31)^(x>>>8|h<<24)^(x>>>7|h<<25),G=f[mt-2],M=G.high,K=G.low,$=(M>>>19|K<<13)^(M<<3|K>>>29)^M>>>6,ee=(K>>>19|M<<13)^(K<<3|M>>>29)^(K>>>6|M<<26),le=f[mt-7],Ee=le.high,he=le.low,ge=f[mt-16],bt=ge.high,ut=ge.low;pt=O+he,tr=I+Ee+(pt>>>0<O>>>0?1:0),pt=pt+ee,tr=tr+$+(pt>>>0<ee>>>0?1:0),pt=pt+ut,tr=tr+bt+(pt>>>0<ut>>>0?1:0),ce.high=tr,ce.low=pt}var B0=qe&Hu^~qe&Uu,Gu=it&pu^~it&kr,uE=de&Oe^de&dt^Oe&dt,aE=xe&fe^xe&Re^fe&Re,nE=(de>>>28|xe<<4)^(de<<30|xe>>>2)^(de<<25|xe>>>7),Zc=(xe>>>28|de<<4)^(xe<<30|de>>>2)^(xe<<25|de>>>7),iE=(qe>>>14|it<<18)^(qe>>>18|it<<14)^(qe<<23|it>>>9),sE=(it>>>14|qe<<18)^(it>>>18|qe<<14)^(it<<23|qe>>>9),Jc=o[mt],oE=Jc.high,ef=Jc.low,St=Ut+sE,Hr=P0+iE+(St>>>0<Ut>>>0?1:0),St=St+Gu,Hr=Hr+B0+(St>>>0<Gu>>>0?1:0),St=St+ef,Hr=Hr+oE+(St>>>0<ef>>>0?1:0),St=St+pt,Hr=Hr+tr+(St>>>0<pt>>>0?1:0),tf=Zc+aE,cE=nE+uE+(tf>>>0<Zc>>>0?1:0);P0=Uu,Ut=kr,Uu=Hu,kr=pu,Hu=qe,pu=it,it=At+St|0,qe=ht+Hr+(it>>>0<At>>>0?1:0)|0,ht=dt,At=Re,dt=Oe,Re=fe,Oe=de,fe=xe,xe=St+tf|0,de=Hr+cE+(xe>>>0<St>>>0?1:0)|0}k=C.low=k+xe,C.high=H+de+(k>>>0<xe>>>0?1:0),j=D.low=j+fe,D.high=B+Oe+(j>>>0<fe>>>0?1:0),F=T.low=F+Re,T.high=L+dt+(F>>>0<Re>>>0?1:0),S=A.low=S+At,A.high=w+ht+(S>>>0<At>>>0?1:0),z=v.low=z+it,v.high=X+qe+(z>>>0<it>>>0?1:0),ue=g.low=ue+pu,g.high=re+Hu+(ue>>>0<pu>>>0?1:0),W=N.low=W+kr,N.high=U+Uu+(W>>>0<kr>>>0?1:0),V=P.low=V+Ut,P.high=Q+P0+(V>>>0<Ut>>>0?1:0)},_doFinalize:function(){var d=this._data,b=d.words,_=this._nDataBytes*8,C=d.sigBytes*8;b[C>>>5]|=128<<24-C%32,b[(C+128>>>10<<5)+30]=Math.floor(_/4294967296),b[(C+128>>>10<<5)+31]=_,d.sigBytes=b.length*4,this._process();var D=this._hash.toX32();return D},clone:function(){var d=u.clone.call(this);return d._hash=this._hash.clone(),d},blockSize:1024/32});t.SHA512=u._createHelper(p),t.HmacSHA512=u._createHmacHelper(p)}(),e.SHA512})});var xh=R((Xn,Th)=>{(function(e,t,r){typeof Xn=="object"?Th.exports=Xn=t(Ae(),fa(),Bo()):typeof define=="function"&&define.amd?define(["./core","./x64-core","./sha512"],t):t(e.CryptoJS)})(Xn,function(e){return function(){var t=e,r=t.x64,u=r.Word,a=r.WordArray,n=t.algo,s=n.SHA512,i=n.SHA384=s.extend({_doReset:function(){this._hash=new a.init([new u.init(3418070365,3238371032),new u.init(1654270250,914150663),new u.init(2438529370,812702999),new u.init(355462360,4144912697),new u.init(1731405415,4290775857),new u.init(2394180231,1750603025),new u.init(3675008525,1694076839),new u.init(1203062813,3204075428)])},_doFinalize:function(){var c=s._doFinalize.call(this);return c.sigBytes-=16,c}});t.SHA384=s._createHelper(i),t.HmacSHA384=s._createHmacHelper(i)}(),e.SHA384})});var mh=R((Kn,Ah)=>{(function(e,t,r){typeof Kn=="object"?Ah.exports=Kn=t(Ae(),fa()):typeof define=="function"&&define.amd?define(["./core","./x64-core"],t):t(e.CryptoJS)})(Kn,function(e){return function(t){var r=e,u=r.lib,a=u.WordArray,n=u.Hasher,s=r.x64,i=s.Word,c=r.algo,o=[],f=[],p=[];(function(){for(var _=1,C=0,D=0;D<24;D++){o[_+5*C]=(D+1)*(D+2)/2%64;var T=C%5,A=(2*_+3*C)%5;_=T,C=A}for(var _=0;_<5;_++)for(var C=0;C<5;C++)f[_+5*C]=C+(2*_+3*C)%5*5;for(var v=1,g=0;g<24;g++){for(var N=0,P=0,H=0;H<7;H++){if(v&1){var k=(1<<H)-1;k<32?P^=1<<k:N^=1<<k-32}v&128?v=v<<1^113:v<<=1}p[g]=i.create(N,P)}})();var d=[];(function(){for(var _=0;_<25;_++)d[_]=i.create()})();var b=c.SHA3=n.extend({cfg:n.cfg.extend({outputLength:512}),_doReset:function(){for(var _=this._state=[],C=0;C<25;C++)_[C]=new i.init;this.blockSize=(1600-2*this.cfg.outputLength)/32},_doProcessBlock:function(_,C){for(var D=this._state,T=this.blockSize/2,A=0;A<T;A++){var v=_[C+2*A],g=_[C+2*A+1];v=(v<<8|v>>>24)&16711935|(v<<24|v>>>8)&4278255360,g=(g<<8|g>>>24)&16711935|(g<<24|g>>>8)&4278255360;var N=D[A];N.high^=g,N.low^=v}for(var P=0;P<24;P++){for(var H=0;H<5;H++){for(var k=0,B=0,j=0;j<5;j++){var N=D[H+5*j];k^=N.high,B^=N.low}var L=d[H];L.high=k,L.low=B}for(var H=0;H<5;H++)for(var F=d[(H+4)%5],w=d[(H+1)%5],S=w.high,X=w.low,k=F.high^(S<<1|X>>>31),B=F.low^(X<<1|S>>>31),j=0;j<5;j++){var N=D[H+5*j];N.high^=k,N.low^=B}for(var z=1;z<25;z++){var k,B,N=D[z],re=N.high,ue=N.low,U=o[z];U<32?(k=re<<U|ue>>>32-U,B=ue<<U|re>>>32-U):(k=ue<<U-32|re>>>64-U,B=re<<U-32|ue>>>64-U);var W=d[f[z]];W.high=k,W.low=B}var Q=d[0],V=D[0];Q.high=V.high,Q.low=V.low;for(var H=0;H<5;H++)for(var j=0;j<5;j++){var z=H+5*j,N=D[z],de=d[z],xe=d[(H+1)%5+5*j],Oe=d[(H+2)%5+5*j];N.high=de.high^~xe.high&Oe.high,N.low=de.low^~xe.low&Oe.low}var N=D[0],fe=p[P];N.high^=fe.high,N.low^=fe.low}},_doFinalize:function(){var _=this._data,C=_.words,D=this._nDataBytes*8,T=_.sigBytes*8,A=this.blockSize*32;C[T>>>5]|=1<<24-T%32,C[(t.ceil((T+1)/A)*A>>>5)-1]|=128,_.sigBytes=C.length*4,this._process();for(var v=this._state,g=this.cfg.outputLength/8,N=g/8,P=[],H=0;H<N;H++){var k=v[H],B=k.high,j=k.low;B=(B<<8|B>>>24)&16711935|(B<<24|B>>>8)&4278255360,j=(j<<8|j>>>24)&16711935|(j<<24|j>>>8)&4278255360,P.push(j),P.push(B)}return new a.init(P,g)},clone:function(){for(var _=n.clone.call(this),C=_._state=this._state.slice(0),D=0;D<25;D++)C[D]=C[D].clone();return _}});r.SHA3=n._createHelper(b),r.HmacSHA3=n._createHmacHelper(b)}(Math),e.SHA3})});var vh=R(($n,gh)=>{(function(e,t){typeof $n=="object"?gh.exports=$n=t(Ae()):typeof define=="function"&&define.amd?define(["./core"],t):t(e.CryptoJS)})($n,function(e){return function(t){var r=e,u=r.lib,a=u.WordArray,n=u.Hasher,s=r.algo,i=a.create([0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12,1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2,4,0,5,9,7,12,2,10,14,1,3,8,11,6,15,13]),c=a.create([5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12,6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13,8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14,12,15,10,4,1,5,8,7,6,2,13,14,0,3,9,11]),o=a.create([11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8,7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5,11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12,9,15,5,11,6,8,13,12,5,12,13,14,11,8,5,6]),f=a.create([8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6,9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5,15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8,8,5,12,9,12,5,14,6,8,13,6,5,15,13,11,11]),p=a.create([0,1518500249,1859775393,2400959708,2840853838]),d=a.create([1352829926,1548603684,1836072691,2053994217,0]),b=s.RIPEMD160=n.extend({_doReset:function(){this._hash=a.create([1732584193,4023233417,2562383102,271733878,3285377520])},_doProcessBlock:function(g,N){for(var P=0;P<16;P++){var H=N+P,k=g[H];g[H]=(k<<8|k>>>24)&16711935|(k<<24|k>>>8)&4278255360}var B=this._hash.words,j=p.words,L=d.words,F=i.words,w=c.words,S=o.words,X=f.words,z,re,ue,U,W,Q,V,de,xe,Oe;Q=z=B[0],V=re=B[1],de=ue=B[2],xe=U=B[3],Oe=W=B[4];for(var fe,P=0;P<80;P+=1)fe=z+g[N+F[P]]|0,P<16?fe+=_(re,ue,U)+j[0]:P<32?fe+=C(re,ue,U)+j[1]:P<48?fe+=D(re,ue,U)+j[2]:P<64?fe+=T(re,ue,U)+j[3]:fe+=A(re,ue,U)+j[4],fe=fe|0,fe=v(fe,S[P]),fe=fe+W|0,z=W,W=U,U=v(ue,10),ue=re,re=fe,fe=Q+g[N+w[P]]|0,P<16?fe+=A(V,de,xe)+L[0]:P<32?fe+=T(V,de,xe)+L[1]:P<48?fe+=D(V,de,xe)+L[2]:P<64?fe+=C(V,de,xe)+L[3]:fe+=_(V,de,xe)+L[4],fe=fe|0,fe=v(fe,X[P]),fe=fe+Oe|0,Q=Oe,Oe=xe,xe=v(de,10),de=V,V=fe;fe=B[1]+ue+xe|0,B[1]=B[2]+U+Oe|0,B[2]=B[3]+W+Q|0,B[3]=B[4]+z+V|0,B[4]=B[0]+re+de|0,B[0]=fe},_doFinalize:function(){var g=this._data,N=g.words,P=this._nDataBytes*8,H=g.sigBytes*8;N[H>>>5]|=128<<24-H%32,N[(H+64>>>9<<4)+14]=(P<<8|P>>>24)&16711935|(P<<24|P>>>8)&4278255360,g.sigBytes=(N.length+1)*4,this._process();for(var k=this._hash,B=k.words,j=0;j<5;j++){var L=B[j];B[j]=(L<<8|L>>>24)&16711935|(L<<24|L>>>8)&4278255360}return k},clone:function(){var g=n.clone.call(this);return g._hash=this._hash.clone(),g}});function _(g,N,P){return g^N^P}function C(g,N,P){return g&N|~g&P}function D(g,N,P){return(g|~N)^P}function T(g,N,P){return g&P|N&~P}function A(g,N,P){return g^(N|~P)}function v(g,N){return g<<N|g>>>32-N}r.RIPEMD160=n._createHelper(b),r.HmacRIPEMD160=n._createHmacHelper(b)}(Math),e.RIPEMD160})});var Jn=R((Zn,yh)=>{(function(e,t){typeof Zn=="object"?yh.exports=Zn=t(Ae()):typeof define=="function"&&define.amd?define(["./core"],t):t(e.CryptoJS)})(Zn,function(e){(function(){var t=e,r=t.lib,u=r.Base,a=t.enc,n=a.Utf8,s=t.algo,i=s.HMAC=u.extend({init:function(c,o){c=this._hasher=new c.init,typeof o=="string"&&(o=n.parse(o));var f=c.blockSize,p=f*4;o.sigBytes>p&&(o=c.finalize(o)),o.clamp();for(var d=this._oKey=o.clone(),b=this._iKey=o.clone(),_=d.words,C=b.words,D=0;D<f;D++)_[D]^=1549556828,C[D]^=909522486;d.sigBytes=b.sigBytes=p,this.reset()},reset:function(){var c=this._hasher;c.reset(),c.update(this._iKey)},update:function(c){return this._hasher.update(c),this},finalize:function(c){var o=this._hasher,f=o.finalize(c);o.reset();var p=o.finalize(this._oKey.clone().concat(f));return p}})})()})});var Ch=R((ei,Dh)=>{(function(e,t,r){typeof ei=="object"?Dh.exports=ei=t(Ae(),Wn(),Jn()):typeof define=="function"&&define.amd?define(["./core","./sha256","./hmac"],t):t(e.CryptoJS)})(ei,function(e){return function(){var t=e,r=t.lib,u=r.Base,a=r.WordArray,n=t.algo,s=n.SHA256,i=n.HMAC,c=n.PBKDF2=u.extend({cfg:u.extend({keySize:128/32,hasher:s,iterations:25e4}),init:function(o){this.cfg=this.cfg.extend(o)},compute:function(o,f){for(var p=this.cfg,d=i.create(p.hasher,o),b=a.create(),_=a.create([1]),C=b.words,D=_.words,T=p.keySize,A=p.iterations;C.length<T;){var v=d.update(f).finalize(_);d.reset();for(var g=v.words,N=g.length,P=v,H=1;H<A;H++){P=d.finalize(P),d.reset();for(var k=P.words,B=0;B<N;B++)g[B]^=k[B]}b.concat(v),D[0]++}return b.sigBytes=T*4,b}});t.PBKDF2=function(o,f,p){return c.create(p).compute(o,f)}}(),e.PBKDF2})});var Br=R((ti,Ih)=>{(function(e,t,r){typeof ti=="object"?Ih.exports=ti=t(Ae(),Po(),Jn()):typeof define=="function"&&define.amd?define(["./core","./sha1","./hmac"],t):t(e.CryptoJS)})(ti,function(e){return function(){var t=e,r=t.lib,u=r.Base,a=r.WordArray,n=t.algo,s=n.MD5,i=n.EvpKDF=u.extend({cfg:u.extend({keySize:128/32,hasher:s,iterations:1}),init:function(c){this.cfg=this.cfg.extend(c)},compute:function(c,o){for(var f,p=this.cfg,d=p.hasher.create(),b=a.create(),_=b.words,C=p.keySize,D=p.iterations;_.length<C;){f&&d.update(f),f=d.update(c).finalize(o),d.reset();for(var T=1;T<D;T++)f=d.finalize(f),d.reset();b.concat(f)}return b.sigBytes=C*4,b}});t.EvpKDF=function(c,o,f){return i.create(f).compute(c,o)}}(),e.EvpKDF})});var Ve=R((ri,Sh)=>{(function(e,t,r){typeof ri=="object"?Sh.exports=ri=t(Ae(),Br()):typeof define=="function"&&define.amd?define(["./core","./evpkdf"],t):t(e.CryptoJS)})(ri,function(e){e.lib.Cipher||function(t){var r=e,u=r.lib,a=u.Base,n=u.WordArray,s=u.BufferedBlockAlgorithm,i=r.enc,c=i.Utf8,o=i.Base64,f=r.algo,p=f.EvpKDF,d=u.Cipher=s.extend({cfg:a.extend(),createEncryptor:function(L,F){return this.create(this._ENC_XFORM_MODE,L,F)},createDecryptor:function(L,F){return this.create(this._DEC_XFORM_MODE,L,F)},init:function(L,F,w){this.cfg=this.cfg.extend(w),this._xformMode=L,this._key=F,this.reset()},reset:function(){s.reset.call(this),this._doReset()},process:function(L){return this._append(L),this._process()},finalize:function(L){L&&this._append(L);var F=this._doFinalize();return F},keySize:128/32,ivSize:128/32,_ENC_XFORM_MODE:1,_DEC_XFORM_MODE:2,_createHelper:function(){function L(F){return typeof F=="string"?j:H}return function(F){return{encrypt:function(w,S,X){return L(S).encrypt(F,w,S,X)},decrypt:function(w,S,X){return L(S).decrypt(F,w,S,X)}}}}()}),b=u.StreamCipher=d.extend({_doFinalize:function(){var L=this._process(!0);return L},blockSize:1}),_=r.mode={},C=u.BlockCipherMode=a.extend({createEncryptor:function(L,F){return this.Encryptor.create(L,F)},createDecryptor:function(L,F){return this.Decryptor.create(L,F)},init:function(L,F){this._cipher=L,this._iv=F}}),D=_.CBC=function(){var L=C.extend();L.Encryptor=L.extend({processBlock:function(w,S){var X=this._cipher,z=X.blockSize;F.call(this,w,S,z),X.encryptBlock(w,S),this._prevBlock=w.slice(S,S+z)}}),L.Decryptor=L.extend({processBlock:function(w,S){var X=this._cipher,z=X.blockSize,re=w.slice(S,S+z);X.decryptBlock(w,S),F.call(this,w,S,z),this._prevBlock=re}});function F(w,S,X){var z,re=this._iv;re?(z=re,this._iv=t):z=this._prevBlock;for(var ue=0;ue<X;ue++)w[S+ue]^=z[ue]}return L}(),T=r.pad={},A=T.Pkcs7={pad:function(L,F){for(var w=F*4,S=w-L.sigBytes%w,X=S<<24|S<<16|S<<8|S,z=[],re=0;re<S;re+=4)z.push(X);var ue=n.create(z,S);L.concat(ue)},unpad:function(L){var F=L.words[L.sigBytes-1>>>2]&255;L.sigBytes-=F}},v=u.BlockCipher=d.extend({cfg:d.cfg.extend({mode:D,padding:A}),reset:function(){var L;d.reset.call(this);var F=this.cfg,w=F.iv,S=F.mode;this._xformMode==this._ENC_XFORM_MODE?L=S.createEncryptor:(L=S.createDecryptor,this._minBufferSize=1),this._mode&&this._mode.__creator==L?this._mode.init(this,w&&w.words):(this._mode=L.call(S,this,w&&w.words),this._mode.__creator=L)},_doProcessBlock:function(L,F){this._mode.processBlock(L,F)},_doFinalize:function(){var L,F=this.cfg.padding;return this._xformMode==this._ENC_XFORM_MODE?(F.pad(this._data,this.blockSize),L=this._process(!0)):(L=this._process(!0),F.unpad(L)),L},blockSize:128/32}),g=u.CipherParams=a.extend({init:function(L){this.mixIn(L)},toString:function(L){return(L||this.formatter).stringify(this)}}),N=r.format={},P=N.OpenSSL={stringify:function(L){var F,w=L.ciphertext,S=L.salt;return S?F=n.create([1398893684,1701076831]).concat(S).concat(w):F=w,F.toString(o)},parse:function(L){var F,w=o.parse(L),S=w.words;return S[0]==1398893684&&S[1]==1701076831&&(F=n.create(S.slice(2,4)),S.splice(0,4),w.sigBytes-=16),g.create({ciphertext:w,salt:F})}},H=u.SerializableCipher=a.extend({cfg:a.extend({format:P}),encrypt:function(L,F,w,S){S=this.cfg.extend(S);var X=L.createEncryptor(w,S),z=X.finalize(F),re=X.cfg;return g.create({ciphertext:z,key:w,iv:re.iv,algorithm:L,mode:re.mode,padding:re.padding,blockSize:L.blockSize,formatter:S.format})},decrypt:function(L,F,w,S){S=this.cfg.extend(S),F=this._parse(F,S.format);var X=L.createDecryptor(w,S).finalize(F.ciphertext);return X},_parse:function(L,F){return typeof L=="string"?F.parse(L,this):L}}),k=r.kdf={},B=k.OpenSSL={execute:function(L,F,w,S,X){if(S||(S=n.random(64/8)),X)var z=p.create({keySize:F+w,hasher:X}).compute(L,S);else var z=p.create({keySize:F+w}).compute(L,S);var re=n.create(z.words.slice(F),w*4);return z.sigBytes=F*4,g.create({key:z,iv:re,salt:S})}},j=u.PasswordBasedCipher=H.extend({cfg:H.cfg.extend({kdf:B}),encrypt:function(L,F,w,S){S=this.cfg.extend(S);var X=S.kdf.execute(w,L.keySize,L.ivSize,S.salt,S.hasher);S.iv=X.iv;var z=H.encrypt.call(this,L,F,X.key,S);return z.mixIn(X),z},decrypt:function(L,F,w,S){S=this.cfg.extend(S),F=this._parse(F,S.format);var X=S.kdf.execute(w,L.keySize,L.ivSize,F.salt,S.hasher);S.iv=X.iv;var z=H.decrypt.call(this,L,F,X.key,S);return z}})}()})});var Oh=R((ui,Nh)=>{(function(e,t,r){typeof ui=="object"?Nh.exports=ui=t(Ae(),Ve()):typeof define=="function"&&define.amd?define(["./core","./cipher-core"],t):t(e.CryptoJS)})(ui,function(e){return e.mode.CFB=function(){var t=e.lib.BlockCipherMode.extend();t.Encryptor=t.extend({processBlock:function(u,a){var n=this._cipher,s=n.blockSize;r.call(this,u,a,s,n),this._prevBlock=u.slice(a,a+s)}}),t.Decryptor=t.extend({processBlock:function(u,a){var n=this._cipher,s=n.blockSize,i=u.slice(a,a+s);r.call(this,u,a,s,n),this._prevBlock=i}});function r(u,a,n,s){var i,c=this._iv;c?(i=c.slice(0),this._iv=void 0):i=this._prevBlock,s.encryptBlock(i,0);for(var o=0;o<n;o++)u[a+o]^=i[o]}return t}(),e.mode.CFB})});var Ph=R((ai,Rh)=>{(function(e,t,r){typeof ai=="object"?Rh.exports=ai=t(Ae(),Ve()):typeof define=="function"&&define.amd?define(["./core","./cipher-core"],t):t(e.CryptoJS)})(ai,function(e){return e.mode.CTR=function(){var t=e.lib.BlockCipherMode.extend(),r=t.Encryptor=t.extend({processBlock:function(u,a){var n=this._cipher,s=n.blockSize,i=this._iv,c=this._counter;i&&(c=this._counter=i.slice(0),this._iv=void 0);var o=c.slice(0);n.encryptBlock(o,0),c[s-1]=c[s-1]+1|0;for(var f=0;f<s;f++)u[a+f]^=o[f]}});return t.Decryptor=r,t}(),e.mode.CTR})});var wh=R((ni,Bh)=>{(function(e,t,r){typeof ni=="object"?Bh.exports=ni=t(Ae(),Ve()):typeof define=="function"&&define.amd?define(["./core","./cipher-core"],t):t(e.CryptoJS)})(ni,function(e){return e.mode.CTRGladman=function(){var t=e.lib.BlockCipherMode.extend();function r(n){if((n>>24&255)===255){var s=n>>16&255,i=n>>8&255,c=n&255;s===255?(s=0,i===255?(i=0,c===255?c=0:++c):++i):++s,n=0,n+=s<<16,n+=i<<8,n+=c}else n+=1<<24;return n}function u(n){return(n[0]=r(n[0]))===0&&(n[1]=r(n[1])),n}var a=t.Encryptor=t.extend({processBlock:function(n,s){var i=this._cipher,c=i.blockSize,o=this._iv,f=this._counter;o&&(f=this._counter=o.slice(0),this._iv=void 0),u(f);var p=f.slice(0);i.encryptBlock(p,0);for(var d=0;d<c;d++)n[s+d]^=p[d]}});return t.Decryptor=a,t}(),e.mode.CTRGladman})});var Mh=R((ii,Lh)=>{(function(e,t,r){typeof ii=="object"?Lh.exports=ii=t(Ae(),Ve()):typeof define=="function"&&define.amd?define(["./core","./cipher-core"],t):t(e.CryptoJS)})(ii,function(e){return e.mode.OFB=function(){var t=e.lib.BlockCipherMode.extend(),r=t.Encryptor=t.extend({processBlock:function(u,a){var n=this._cipher,s=n.blockSize,i=this._iv,c=this._keystream;i&&(c=this._keystream=i.slice(0),this._iv=void 0),n.encryptBlock(c,0);for(var o=0;o<s;o++)u[a+o]^=c[o]}});return t.Decryptor=r,t}(),e.mode.OFB})});var kh=R((si,Fh)=>{(function(e,t,r){typeof si=="object"?Fh.exports=si=t(Ae(),Ve()):typeof define=="function"&&define.amd?define(["./core","./cipher-core"],t):t(e.CryptoJS)})(si,function(e){return e.mode.ECB=function(){var t=e.lib.BlockCipherMode.extend();return t.Encryptor=t.extend({processBlock:function(r,u){this._cipher.encryptBlock(r,u)}}),t.Decryptor=t.extend({processBlock:function(r,u){this._cipher.decryptBlock(r,u)}}),t}(),e.mode.ECB})});var Uh=R((oi,Hh)=>{(function(e,t,r){typeof oi=="object"?Hh.exports=oi=t(Ae(),Ve()):typeof define=="function"&&define.amd?define(["./core","./cipher-core"],t):t(e.CryptoJS)})(oi,function(e){return e.pad.AnsiX923={pad:function(t,r){var u=t.sigBytes,a=r*4,n=a-u%a,s=u+n-1;t.clamp(),t.words[s>>>2]|=n<<24-s%4*8,t.sigBytes+=n},unpad:function(t){var r=t.words[t.sigBytes-1>>>2]&255;t.sigBytes-=r}},e.pad.Ansix923})});var qh=R((ci,Gh)=>{(function(e,t,r){typeof ci=="object"?Gh.exports=ci=t(Ae(),Ve()):typeof define=="function"&&define.amd?define(["./core","./cipher-core"],t):t(e.CryptoJS)})(ci,function(e){return e.pad.Iso10126={pad:function(t,r){var u=r*4,a=u-t.sigBytes%u;t.concat(e.lib.WordArray.random(a-1)).concat(e.lib.WordArray.create([a<<24],1))},unpad:function(t){var r=t.words[t.sigBytes-1>>>2]&255;t.sigBytes-=r}},e.pad.Iso10126})});var zh=R((fi,jh)=>{(function(e,t,r){typeof fi=="object"?jh.exports=fi=t(Ae(),Ve()):typeof define=="function"&&define.amd?define(["./core","./cipher-core"],t):t(e.CryptoJS)})(fi,function(e){return e.pad.Iso97971={pad:function(t,r){t.concat(e.lib.WordArray.create([2147483648],1)),e.pad.ZeroPadding.pad(t,r)},unpad:function(t){e.pad.ZeroPadding.unpad(t),t.sigBytes--}},e.pad.Iso97971})});var Wh=R((li,Yh)=>{(function(e,t,r){typeof li=="object"?Yh.exports=li=t(Ae(),Ve()):typeof define=="function"&&define.amd?define(["./core","./cipher-core"],t):t(e.CryptoJS)})(li,function(e){return e.pad.ZeroPadding={pad:function(t,r){var u=r*4;t.clamp(),t.sigBytes+=u-(t.sigBytes%u||u)},unpad:function(t){for(var r=t.words,u=t.sigBytes-1,u=t.sigBytes-1;u>=0;u--)if(r[u>>>2]>>>24-u%4*8&255){t.sigBytes=u+1;break}}},e.pad.ZeroPadding})});var Qh=R((di,Vh)=>{(function(e,t,r){typeof di=="object"?Vh.exports=di=t(Ae(),Ve()):typeof define=="function"&&define.amd?define(["./core","./cipher-core"],t):t(e.CryptoJS)})(di,function(e){return e.pad.NoPadding={pad:function(){},unpad:function(){}},e.pad.NoPadding})});var Kh=R((hi,Xh)=>{(function(e,t,r){typeof hi=="object"?Xh.exports=hi=t(Ae(),Ve()):typeof define=="function"&&define.amd?define(["./core","./cipher-core"],t):t(e.CryptoJS)})(hi,function(e){return function(t){var r=e,u=r.lib,a=u.CipherParams,n=r.enc,s=n.Hex,i=r.format,c=i.Hex={stringify:function(o){return o.ciphertext.toString(s)},parse:function(o){var f=s.parse(o);return a.create({ciphertext:f})}}}(),e.format.Hex})});var Zh=R((pi,$h)=>{(function(e,t,r){typeof pi=="object"?$h.exports=pi=t(Ae(),uu(),au(),Br(),Ve()):typeof define=="function"&&define.amd?define(["./core","./enc-base64","./md5","./evpkdf","./cipher-core"],t):t(e.CryptoJS)})(pi,function(e){return function(){var t=e,r=t.lib,u=r.BlockCipher,a=t.algo,n=[],s=[],i=[],c=[],o=[],f=[],p=[],d=[],b=[],_=[];(function(){for(var T=[],A=0;A<256;A++)A<128?T[A]=A<<1:T[A]=A<<1^283;for(var v=0,g=0,A=0;A<256;A++){var N=g^g<<1^g<<2^g<<3^g<<4;N=N>>>8^N&255^99,n[v]=N,s[N]=v;var P=T[v],H=T[P],k=T[H],B=T[N]*257^N*16843008;i[v]=B<<24|B>>>8,c[v]=B<<16|B>>>16,o[v]=B<<8|B>>>24,f[v]=B;var B=k*16843009^H*65537^P*257^v*16843008;p[N]=B<<24|B>>>8,d[N]=B<<16|B>>>16,b[N]=B<<8|B>>>24,_[N]=B,v?(v=P^T[T[T[k^P]]],g^=T[T[g]]):v=g=1}})();var C=[0,1,2,4,8,16,32,64,128,27,54],D=a.AES=u.extend({_doReset:function(){var T;if(!(this._nRounds&&this._keyPriorReset===this._key)){for(var A=this._keyPriorReset=this._key,v=A.words,g=A.sigBytes/4,N=this._nRounds=g+6,P=(N+1)*4,H=this._keySchedule=[],k=0;k<P;k++)k<g?H[k]=v[k]:(T=H[k-1],k%g?g>6&&k%g==4&&(T=n[T>>>24]<<24|n[T>>>16&255]<<16|n[T>>>8&255]<<8|n[T&255]):(T=T<<8|T>>>24,T=n[T>>>24]<<24|n[T>>>16&255]<<16|n[T>>>8&255]<<8|n[T&255],T^=C[k/g|0]<<24),H[k]=H[k-g]^T);for(var B=this._invKeySchedule=[],j=0;j<P;j++){var k=P-j;if(j%4)var T=H[k];else var T=H[k-4];j<4||k<=4?B[j]=T:B[j]=p[n[T>>>24]]^d[n[T>>>16&255]]^b[n[T>>>8&255]]^_[n[T&255]]}}},encryptBlock:function(T,A){this._doCryptBlock(T,A,this._keySchedule,i,c,o,f,n)},decryptBlock:function(T,A){var v=T[A+1];T[A+1]=T[A+3],T[A+3]=v,this._doCryptBlock(T,A,this._invKeySchedule,p,d,b,_,s);var v=T[A+1];T[A+1]=T[A+3],T[A+3]=v},_doCryptBlock:function(T,A,v,g,N,P,H,k){for(var B=this._nRounds,j=T[A]^v[0],L=T[A+1]^v[1],F=T[A+2]^v[2],w=T[A+3]^v[3],S=4,X=1;X<B;X++){var z=g[j>>>24]^N[L>>>16&255]^P[F>>>8&255]^H[w&255]^v[S++],re=g[L>>>24]^N[F>>>16&255]^P[w>>>8&255]^H[j&255]^v[S++],ue=g[F>>>24]^N[w>>>16&255]^P[j>>>8&255]^H[L&255]^v[S++],U=g[w>>>24]^N[j>>>16&255]^P[L>>>8&255]^H[F&255]^v[S++];j=z,L=re,F=ue,w=U}var z=(k[j>>>24]<<24|k[L>>>16&255]<<16|k[F>>>8&255]<<8|k[w&255])^v[S++],re=(k[L>>>24]<<24|k[F>>>16&255]<<16|k[w>>>8&255]<<8|k[j&255])^v[S++],ue=(k[F>>>24]<<24|k[w>>>16&255]<<16|k[j>>>8&255]<<8|k[L&255])^v[S++],U=(k[w>>>24]<<24|k[j>>>16&255]<<16|k[L>>>8&255]<<8|k[F&255])^v[S++];T[A]=z,T[A+1]=re,T[A+2]=ue,T[A+3]=U},keySize:256/32});t.AES=u._createHelper(D)}(),e.AES})});var e2=R((bi,Jh)=>{(function(e,t,r){typeof bi=="object"?Jh.exports=bi=t(Ae(),uu(),au(),Br(),Ve()):typeof define=="function"&&define.amd?define(["./core","./enc-base64","./md5","./evpkdf","./cipher-core"],t):t(e.CryptoJS)})(bi,function(e){return function(){var t=e,r=t.lib,u=r.WordArray,a=r.BlockCipher,n=t.algo,s=[57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4],i=[14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32],c=[1,2,4,6,8,10,12,14,15,17,19,21,23,25,27,28],o=[{0:8421888,268435456:32768,536870912:8421378,805306368:2,1073741824:512,1342177280:8421890,1610612736:8389122,1879048192:8388608,2147483648:514,2415919104:8389120,2684354560:33280,2952790016:8421376,3221225472:32770,3489660928:8388610,3758096384:0,4026531840:33282,134217728:0,402653184:8421890,671088640:33282,939524096:32768,1207959552:8421888,1476395008:512,1744830464:8421378,2013265920:2,2281701376:8389120,2550136832:33280,2818572288:8421376,3087007744:8389122,3355443200:8388610,3623878656:32770,3892314112:514,4160749568:8388608,1:32768,268435457:2,536870913:8421888,805306369:8388608,1073741825:8421378,1342177281:33280,1610612737:512,1879048193:8389122,2147483649:8421890,2415919105:8421376,2684354561:8388610,2952790017:33282,3221225473:514,3489660929:8389120,3758096385:32770,4026531841:0,134217729:8421890,402653185:8421376,671088641:8388608,939524097:512,1207959553:32768,1476395009:8388610,1744830465:2,2013265921:33282,2281701377:32770,2550136833:8389122,2818572289:514,3087007745:8421888,3355443201:8389120,3623878657:0,3892314113:33280,4160749569:8421378},{0:1074282512,16777216:16384,33554432:524288,50331648:1074266128,67108864:1073741840,83886080:1074282496,100663296:1073758208,117440512:16,134217728:540672,150994944:1073758224,167772160:1073741824,184549376:540688,201326592:524304,218103808:0,234881024:16400,251658240:1074266112,8388608:1073758208,25165824:540688,41943040:16,58720256:1073758224,75497472:1074282512,92274688:1073741824,109051904:524288,125829120:1074266128,142606336:524304,159383552:0,176160768:16384,192937984:1074266112,209715200:1073741840,226492416:540672,243269632:1074282496,260046848:16400,268435456:0,285212672:1074266128,301989888:1073758224,318767104:1074282496,335544320:1074266112,352321536:16,369098752:540688,385875968:16384,402653184:16400,419430400:524288,436207616:524304,452984832:1073741840,469762048:540672,486539264:1073758208,503316480:1073741824,520093696:1074282512,276824064:540688,293601280:524288,310378496:1074266112,327155712:16384,343932928:1073758208,360710144:1074282512,377487360:16,394264576:1073741824,411041792:1074282496,427819008:1073741840,444596224:1073758224,461373440:524304,478150656:0,494927872:16400,511705088:1074266128,528482304:540672},{0:260,1048576:0,2097152:67109120,3145728:65796,4194304:65540,5242880:67108868,6291456:67174660,7340032:67174400,8388608:67108864,9437184:67174656,10485760:65792,11534336:67174404,12582912:67109124,13631488:65536,14680064:4,15728640:256,524288:67174656,1572864:67174404,2621440:0,3670016:67109120,4718592:67108868,5767168:65536,6815744:65540,7864320:260,8912896:4,9961472:256,11010048:67174400,12058624:65796,13107200:65792,14155776:67109124,15204352:67174660,16252928:67108864,16777216:67174656,17825792:65540,18874368:65536,19922944:67109120,20971520:256,22020096:67174660,23068672:67108868,24117248:0,25165824:67109124,26214400:67108864,27262976:4,28311552:65792,29360128:67174400,30408704:260,31457280:65796,32505856:67174404,17301504:67108864,18350080:260,19398656:67174656,20447232:0,21495808:65540,22544384:67109120,23592960:256,24641536:67174404,25690112:65536,26738688:67174660,27787264:65796,28835840:67108868,29884416:67109124,30932992:67174400,31981568:4,33030144:65792},{0:2151682048,65536:2147487808,131072:4198464,196608:2151677952,262144:0,327680:4198400,393216:2147483712,458752:4194368,524288:2147483648,589824:4194304,655360:64,720896:2147487744,786432:2151678016,851968:4160,917504:4096,983040:2151682112,32768:2147487808,98304:64,163840:2151678016,229376:2147487744,294912:4198400,360448:2151682112,425984:0,491520:2151677952,557056:4096,622592:2151682048,688128:4194304,753664:4160,819200:2147483648,884736:4194368,950272:4198464,1015808:2147483712,1048576:4194368,1114112:4198400,1179648:2147483712,1245184:0,1310720:4160,1376256:2151678016,1441792:2151682048,1507328:2147487808,1572864:2151682112,1638400:2147483648,1703936:2151677952,1769472:4198464,1835008:2147487744,1900544:4194304,1966080:64,2031616:4096,1081344:2151677952,1146880:2151682112,1212416:0,1277952:4198400,1343488:4194368,1409024:2147483648,1474560:2147487808,1540096:64,1605632:2147483712,1671168:4096,1736704:2147487744,1802240:2151678016,1867776:4160,1933312:2151682048,1998848:4194304,2064384:4198464},{0:128,4096:17039360,8192:262144,12288:536870912,16384:537133184,20480:16777344,24576:553648256,28672:262272,32768:16777216,36864:537133056,40960:536871040,45056:553910400,49152:553910272,53248:0,57344:17039488,61440:553648128,2048:17039488,6144:553648256,10240:128,14336:17039360,18432:262144,22528:537133184,26624:553910272,30720:536870912,34816:537133056,38912:0,43008:553910400,47104:16777344,51200:536871040,55296:553648128,59392:16777216,63488:262272,65536:262144,69632:128,73728:536870912,77824:553648256,81920:16777344,86016:553910272,90112:537133184,94208:16777216,98304:553910400,102400:553648128,106496:17039360,110592:537133056,114688:262272,118784:536871040,122880:0,126976:17039488,67584:553648256,71680:16777216,75776:17039360,79872:537133184,83968:536870912,88064:17039488,92160:128,96256:553910272,100352:262272,104448:553910400,108544:0,112640:553648128,116736:16777344,120832:262144,124928:537133056,129024:536871040},{0:268435464,256:8192,512:270532608,768:270540808,1024:268443648,1280:2097152,1536:2097160,1792:268435456,2048:0,2304:268443656,2560:2105344,2816:8,3072:270532616,3328:2105352,3584:8200,3840:270540800,128:270532608,384:270540808,640:8,896:2097152,1152:2105352,1408:268435464,1664:268443648,1920:8200,2176:2097160,2432:8192,2688:268443656,2944:270532616,3200:0,3456:270540800,3712:2105344,3968:268435456,4096:268443648,4352:270532616,4608:270540808,4864:8200,5120:2097152,5376:268435456,5632:268435464,5888:2105344,6144:2105352,6400:0,6656:8,6912:270532608,7168:8192,7424:268443656,7680:270540800,7936:2097160,4224:8,4480:2105344,4736:2097152,4992:268435464,5248:268443648,5504:8200,5760:270540808,6016:270532608,6272:270540800,6528:270532616,6784:8192,7040:2105352,7296:2097160,7552:0,7808:268435456,8064:268443656},{0:1048576,16:33555457,32:1024,48:1049601,64:34604033,80:0,96:1,112:34603009,128:33555456,144:1048577,160:33554433,176:34604032,192:34603008,208:1025,224:1049600,240:33554432,8:34603009,24:0,40:33555457,56:34604032,72:1048576,88:33554433,104:33554432,120:1025,136:1049601,152:33555456,168:34603008,184:1048577,200:1024,216:34604033,232:1,248:1049600,256:33554432,272:1048576,288:33555457,304:34603009,320:1048577,336:33555456,352:34604032,368:1049601,384:1025,400:34604033,416:1049600,432:1,448:0,464:34603008,480:33554433,496:1024,264:1049600,280:33555457,296:34603009,312:1,328:33554432,344:1048576,360:1025,376:34604032,392:33554433,408:34603008,424:0,440:34604033,456:1049601,472:1024,488:33555456,504:1048577},{0:134219808,1:131072,2:134217728,3:32,4:131104,5:134350880,6:134350848,7:2048,8:134348800,9:134219776,10:133120,11:134348832,12:2080,13:0,14:134217760,15:133152,2147483648:2048,2147483649:134350880,2147483650:134219808,2147483651:134217728,2147483652:134348800,2147483653:133120,2147483654:133152,2147483655:32,2147483656:134217760,2147483657:2080,2147483658:131104,2147483659:134350848,2147483660:0,2147483661:134348832,2147483662:134219776,2147483663:131072,16:133152,17:134350848,18:32,19:2048,20:134219776,21:134217760,22:134348832,23:131072,24:0,25:131104,26:134348800,27:134219808,28:134350880,29:133120,30:2080,31:134217728,2147483664:131072,2147483665:2048,2147483666:134348832,2147483667:133152,2147483668:32,2147483669:134348800,2147483670:134217728,2147483671:134219808,2147483672:134350880,2147483673:134217760,2147483674:134219776,2147483675:0,2147483676:133120,2147483677:2080,2147483678:131104,2147483679:134350848}],f=[4160749569,528482304,33030144,2064384,129024,8064,504,2147483679],p=n.DES=a.extend({_doReset:function(){for(var C=this._key,D=C.words,T=[],A=0;A<56;A++){var v=s[A]-1;T[A]=D[v>>>5]>>>31-v%32&1}for(var g=this._subKeys=[],N=0;N<16;N++){for(var P=g[N]=[],H=c[N],A=0;A<24;A++)P[A/6|0]|=T[(i[A]-1+H)%28]<<31-A%6,P[4+(A/6|0)]|=T[28+(i[A+24]-1+H)%28]<<31-A%6;P[0]=P[0]<<1|P[0]>>>31;for(var A=1;A<7;A++)P[A]=P[A]>>>(A-1)*4+3;P[7]=P[7]<<5|P[7]>>>27}for(var k=this._invSubKeys=[],A=0;A<16;A++)k[A]=g[15-A]},encryptBlock:function(C,D){this._doCryptBlock(C,D,this._subKeys)},decryptBlock:function(C,D){this._doCryptBlock(C,D,this._invSubKeys)},_doCryptBlock:function(C,D,T){this._lBlock=C[D],this._rBlock=C[D+1],d.call(this,4,252645135),d.call(this,16,65535),b.call(this,2,858993459),b.call(this,8,16711935),d.call(this,1,1431655765);for(var A=0;A<16;A++){for(var v=T[A],g=this._lBlock,N=this._rBlock,P=0,H=0;H<8;H++)P|=o[H][((N^v[H])&f[H])>>>0];this._lBlock=N,this._rBlock=g^P}var k=this._lBlock;this._lBlock=this._rBlock,this._rBlock=k,d.call(this,1,1431655765),b.call(this,8,16711935),b.call(this,2,858993459),d.call(this,16,65535),d.call(this,4,252645135),C[D]=this._lBlock,C[D+1]=this._rBlock},keySize:64/32,ivSize:64/32,blockSize:64/32});function d(C,D){var T=(this._lBlock>>>C^this._rBlock)&D;this._rBlock^=T,this._lBlock^=T<<C}function b(C,D){var T=(this._rBlock>>>C^this._lBlock)&D;this._lBlock^=T,this._rBlock^=T<<C}t.DES=a._createHelper(p);var _=n.TripleDES=a.extend({_doReset:function(){var C=this._key,D=C.words;if(D.length!==2&&D.length!==4&&D.length<6)throw new Error("Invalid key length - 3DES requires the key length to be 64, 128, 192 or >192.");var T=D.slice(0,2),A=D.length<4?D.slice(0,2):D.slice(2,4),v=D.length<6?D.slice(0,2):D.slice(4,6);this._des1=p.createEncryptor(u.create(T)),this._des2=p.createEncryptor(u.create(A)),this._des3=p.createEncryptor(u.create(v))},encryptBlock:function(C,D){this._des1.encryptBlock(C,D),this._des2.decryptBlock(C,D),this._des3.encryptBlock(C,D)},decryptBlock:function(C,D){this._des3.decryptBlock(C,D),this._des2.encryptBlock(C,D),this._des1.decryptBlock(C,D)},keySize:192/32,ivSize:64/32,blockSize:64/32});t.TripleDES=a._createHelper(_)}(),e.TripleDES})});var r2=R((_i,t2)=>{(function(e,t,r){typeof _i=="object"?t2.exports=_i=t(Ae(),uu(),au(),Br(),Ve()):typeof define=="function"&&define.amd?define(["./core","./enc-base64","./md5","./evpkdf","./cipher-core"],t):t(e.CryptoJS)})(_i,function(e){return function(){var t=e,r=t.lib,u=r.StreamCipher,a=t.algo,n=a.RC4=u.extend({_doReset:function(){for(var c=this._key,o=c.words,f=c.sigBytes,p=this._S=[],d=0;d<256;d++)p[d]=d;for(var d=0,b=0;d<256;d++){var _=d%f,C=o[_>>>2]>>>24-_%4*8&255;b=(b+p[d]+C)%256;var D=p[d];p[d]=p[b],p[b]=D}this._i=this._j=0},_doProcessBlock:function(c,o){c[o]^=s.call(this)},keySize:256/32,ivSize:0});function s(){for(var c=this._S,o=this._i,f=this._j,p=0,d=0;d<4;d++){o=(o+1)%256,f=(f+c[o])%256;var b=c[o];c[o]=c[f],c[f]=b,p|=c[(c[o]+c[f])%256]<<24-d*8}return this._i=o,this._j=f,p}t.RC4=u._createHelper(n);var i=a.RC4Drop=n.extend({cfg:n.cfg.extend({drop:192}),_doReset:function(){n._doReset.call(this);for(var c=this.cfg.drop;c>0;c--)s.call(this)}});t.RC4Drop=u._createHelper(i)}(),e.RC4})});var a2=R((Ei,u2)=>{(function(e,t,r){typeof Ei=="object"?u2.exports=Ei=t(Ae(),uu(),au(),Br(),Ve()):typeof define=="function"&&define.amd?define(["./core","./enc-base64","./md5","./evpkdf","./cipher-core"],t):t(e.CryptoJS)})(Ei,function(e){return function(){var t=e,r=t.lib,u=r.StreamCipher,a=t.algo,n=[],s=[],i=[],c=a.Rabbit=u.extend({_doReset:function(){for(var f=this._key.words,p=this.cfg.iv,d=0;d<4;d++)f[d]=(f[d]<<8|f[d]>>>24)&16711935|(f[d]<<24|f[d]>>>8)&4278255360;var b=this._X=[f[0],f[3]<<16|f[2]>>>16,f[1],f[0]<<16|f[3]>>>16,f[2],f[1]<<16|f[0]>>>16,f[3],f[2]<<16|f[1]>>>16],_=this._C=[f[2]<<16|f[2]>>>16,f[0]&4294901760|f[1]&65535,f[3]<<16|f[3]>>>16,f[1]&4294901760|f[2]&65535,f[0]<<16|f[0]>>>16,f[2]&4294901760|f[3]&65535,f[1]<<16|f[1]>>>16,f[3]&4294901760|f[0]&65535];this._b=0;for(var d=0;d<4;d++)o.call(this);for(var d=0;d<8;d++)_[d]^=b[d+4&7];if(p){var C=p.words,D=C[0],T=C[1],A=(D<<8|D>>>24)&16711935|(D<<24|D>>>8)&4278255360,v=(T<<8|T>>>24)&16711935|(T<<24|T>>>8)&4278255360,g=A>>>16|v&4294901760,N=v<<16|A&65535;_[0]^=A,_[1]^=g,_[2]^=v,_[3]^=N,_[4]^=A,_[5]^=g,_[6]^=v,_[7]^=N;for(var d=0;d<4;d++)o.call(this)}},_doProcessBlock:function(f,p){var d=this._X;o.call(this),n[0]=d[0]^d[5]>>>16^d[3]<<16,n[1]=d[2]^d[7]>>>16^d[5]<<16,n[2]=d[4]^d[1]>>>16^d[7]<<16,n[3]=d[6]^d[3]>>>16^d[1]<<16;for(var b=0;b<4;b++)n[b]=(n[b]<<8|n[b]>>>24)&16711935|(n[b]<<24|n[b]>>>8)&4278255360,f[p+b]^=n[b]},blockSize:128/32,ivSize:64/32});function o(){for(var f=this._X,p=this._C,d=0;d<8;d++)s[d]=p[d];p[0]=p[0]+1295307597+this._b|0,p[1]=p[1]+3545052371+(p[0]>>>0<s[0]>>>0?1:0)|0,p[2]=p[2]+886263092+(p[1]>>>0<s[1]>>>0?1:0)|0,p[3]=p[3]+1295307597+(p[2]>>>0<s[2]>>>0?1:0)|0,p[4]=p[4]+3545052371+(p[3]>>>0<s[3]>>>0?1:0)|0,p[5]=p[5]+886263092+(p[4]>>>0<s[4]>>>0?1:0)|0,p[6]=p[6]+1295307597+(p[5]>>>0<s[5]>>>0?1:0)|0,p[7]=p[7]+3545052371+(p[6]>>>0<s[6]>>>0?1:0)|0,this._b=p[7]>>>0<s[7]>>>0?1:0;for(var d=0;d<8;d++){var b=f[d]+p[d],_=b&65535,C=b>>>16,D=((_*_>>>17)+_*C>>>15)+C*C,T=((b&4294901760)*b|0)+((b&65535)*b|0);i[d]=D^T}f[0]=i[0]+(i[7]<<16|i[7]>>>16)+(i[6]<<16|i[6]>>>16)|0,f[1]=i[1]+(i[0]<<8|i[0]>>>24)+i[7]|0,f[2]=i[2]+(i[1]<<16|i[1]>>>16)+(i[0]<<16|i[0]>>>16)|0,f[3]=i[3]+(i[2]<<8|i[2]>>>24)+i[1]|0,f[4]=i[4]+(i[3]<<16|i[3]>>>16)+(i[2]<<16|i[2]>>>16)|0,f[5]=i[5]+(i[4]<<8|i[4]>>>24)+i[3]|0,f[6]=i[6]+(i[5]<<16|i[5]>>>16)+(i[4]<<16|i[4]>>>16)|0,f[7]=i[7]+(i[6]<<8|i[6]>>>24)+i[5]|0}t.Rabbit=u._createHelper(c)}(),e.Rabbit})});var i2=R((Ti,n2)=>{(function(e,t,r){typeof Ti=="object"?n2.exports=Ti=t(Ae(),uu(),au(),Br(),Ve()):typeof define=="function"&&define.amd?define(["./core","./enc-base64","./md5","./evpkdf","./cipher-core"],t):t(e.CryptoJS)})(Ti,function(e){return function(){var t=e,r=t.lib,u=r.StreamCipher,a=t.algo,n=[],s=[],i=[],c=a.RabbitLegacy=u.extend({_doReset:function(){var f=this._key.words,p=this.cfg.iv,d=this._X=[f[0],f[3]<<16|f[2]>>>16,f[1],f[0]<<16|f[3]>>>16,f[2],f[1]<<16|f[0]>>>16,f[3],f[2]<<16|f[1]>>>16],b=this._C=[f[2]<<16|f[2]>>>16,f[0]&4294901760|f[1]&65535,f[3]<<16|f[3]>>>16,f[1]&4294901760|f[2]&65535,f[0]<<16|f[0]>>>16,f[2]&4294901760|f[3]&65535,f[1]<<16|f[1]>>>16,f[3]&4294901760|f[0]&65535];this._b=0;for(var _=0;_<4;_++)o.call(this);for(var _=0;_<8;_++)b[_]^=d[_+4&7];if(p){var C=p.words,D=C[0],T=C[1],A=(D<<8|D>>>24)&16711935|(D<<24|D>>>8)&4278255360,v=(T<<8|T>>>24)&16711935|(T<<24|T>>>8)&4278255360,g=A>>>16|v&4294901760,N=v<<16|A&65535;b[0]^=A,b[1]^=g,b[2]^=v,b[3]^=N,b[4]^=A,b[5]^=g,b[6]^=v,b[7]^=N;for(var _=0;_<4;_++)o.call(this)}},_doProcessBlock:function(f,p){var d=this._X;o.call(this),n[0]=d[0]^d[5]>>>16^d[3]<<16,n[1]=d[2]^d[7]>>>16^d[5]<<16,n[2]=d[4]^d[1]>>>16^d[7]<<16,n[3]=d[6]^d[3]>>>16^d[1]<<16;for(var b=0;b<4;b++)n[b]=(n[b]<<8|n[b]>>>24)&16711935|(n[b]<<24|n[b]>>>8)&4278255360,f[p+b]^=n[b]},blockSize:128/32,ivSize:64/32});function o(){for(var f=this._X,p=this._C,d=0;d<8;d++)s[d]=p[d];p[0]=p[0]+1295307597+this._b|0,p[1]=p[1]+3545052371+(p[0]>>>0<s[0]>>>0?1:0)|0,p[2]=p[2]+886263092+(p[1]>>>0<s[1]>>>0?1:0)|0,p[3]=p[3]+1295307597+(p[2]>>>0<s[2]>>>0?1:0)|0,p[4]=p[4]+3545052371+(p[3]>>>0<s[3]>>>0?1:0)|0,p[5]=p[5]+886263092+(p[4]>>>0<s[4]>>>0?1:0)|0,p[6]=p[6]+1295307597+(p[5]>>>0<s[5]>>>0?1:0)|0,p[7]=p[7]+3545052371+(p[6]>>>0<s[6]>>>0?1:0)|0,this._b=p[7]>>>0<s[7]>>>0?1:0;for(var d=0;d<8;d++){var b=f[d]+p[d],_=b&65535,C=b>>>16,D=((_*_>>>17)+_*C>>>15)+C*C,T=((b&4294901760)*b|0)+((b&65535)*b|0);i[d]=D^T}f[0]=i[0]+(i[7]<<16|i[7]>>>16)+(i[6]<<16|i[6]>>>16)|0,f[1]=i[1]+(i[0]<<8|i[0]>>>24)+i[7]|0,f[2]=i[2]+(i[1]<<16|i[1]>>>16)+(i[0]<<16|i[0]>>>16)|0,f[3]=i[3]+(i[2]<<8|i[2]>>>24)+i[1]|0,f[4]=i[4]+(i[3]<<16|i[3]>>>16)+(i[2]<<16|i[2]>>>16)|0,f[5]=i[5]+(i[4]<<8|i[4]>>>24)+i[3]|0,f[6]=i[6]+(i[5]<<16|i[5]>>>16)+(i[4]<<16|i[4]>>>16)|0,f[7]=i[7]+(i[6]<<8|i[6]>>>24)+i[5]|0}t.RabbitLegacy=u._createHelper(c)}(),e.RabbitLegacy})});var o2=R((xi,s2)=>{(function(e,t,r){typeof xi=="object"?s2.exports=xi=t(Ae(),uu(),au(),Br(),Ve()):typeof define=="function"&&define.amd?define(["./core","./enc-base64","./md5","./evpkdf","./cipher-core"],t):t(e.CryptoJS)})(xi,function(e){return function(){var t=e,r=t.lib,u=r.BlockCipher,a=t.algo;let n=16,s=[608135816,2242054355,320440878,57701188,2752067618,698298832,137296536,3964562569,1160258022,953160567,3193202383,887688300,3232508343,3380367581,1065670069,3041331479,2450970073,2306472731],i=[[3509652390,2564797868,805139163,3491422135,3101798381,1780907670,3128725573,4046225305,614570311,3012652279,134345442,2240740374,1667834072,1901547113,2757295779,4103290238,227898511,1921955416,1904987480,2182433518,2069144605,3260701109,2620446009,720527379,3318853667,677414384,3393288472,3101374703,2390351024,1614419982,1822297739,2954791486,3608508353,3174124327,2024746970,1432378464,3864339955,2857741204,1464375394,1676153920,1439316330,715854006,3033291828,289532110,2706671279,2087905683,3018724369,1668267050,732546397,1947742710,3462151702,2609353502,2950085171,1814351708,2050118529,680887927,999245976,1800124847,3300911131,1713906067,1641548236,4213287313,1216130144,1575780402,4018429277,3917837745,3693486850,3949271944,596196993,3549867205,258830323,2213823033,772490370,2760122372,1774776394,2652871518,566650946,4142492826,1728879713,2882767088,1783734482,3629395816,2517608232,2874225571,1861159788,326777828,3124490320,2130389656,2716951837,967770486,1724537150,2185432712,2364442137,1164943284,2105845187,998989502,3765401048,2244026483,1075463327,1455516326,1322494562,910128902,469688178,1117454909,936433444,3490320968,3675253459,1240580251,122909385,2157517691,634681816,4142456567,3825094682,3061402683,2540495037,79693498,3249098678,1084186820,1583128258,426386531,1761308591,1047286709,322548459,995290223,1845252383,2603652396,3431023940,2942221577,3202600964,3727903485,1712269319,422464435,3234572375,1170764815,3523960633,3117677531,1434042557,442511882,3600875718,1076654713,1738483198,4213154764,2393238008,3677496056,1014306527,4251020053,793779912,2902807211,842905082,4246964064,1395751752,1040244610,2656851899,3396308128,445077038,3742853595,3577915638,679411651,2892444358,2354009459,1767581616,3150600392,3791627101,3102740896,284835224,4246832056,1258075500,768725851,2589189241,3069724005,3532540348,1274779536,3789419226,2764799539,1660621633,3471099624,4011903706,913787905,3497959166,737222580,2514213453,2928710040,3937242737,1804850592,3499020752,2949064160,2386320175,2390070455,2415321851,4061277028,2290661394,2416832540,1336762016,1754252060,3520065937,3014181293,791618072,3188594551,3933548030,2332172193,3852520463,3043980520,413987798,3465142937,3030929376,4245938359,2093235073,3534596313,375366246,2157278981,2479649556,555357303,3870105701,2008414854,3344188149,4221384143,3956125452,2067696032,3594591187,2921233993,2428461,544322398,577241275,1471733935,610547355,4027169054,1432588573,1507829418,2025931657,3646575487,545086370,48609733,2200306550,1653985193,298326376,1316178497,3007786442,2064951626,458293330,2589141269,3591329599,3164325604,727753846,2179363840,146436021,1461446943,4069977195,705550613,3059967265,3887724982,4281599278,3313849956,1404054877,2845806497,146425753,1854211946],[1266315497,3048417604,3681880366,3289982499,290971e4,1235738493,2632868024,2414719590,3970600049,1771706367,1449415276,3266420449,422970021,1963543593,2690192192,3826793022,1062508698,1531092325,1804592342,2583117782,2714934279,4024971509,1294809318,4028980673,1289560198,2221992742,1669523910,35572830,157838143,1052438473,1016535060,1802137761,1753167236,1386275462,3080475397,2857371447,1040679964,2145300060,2390574316,1461121720,2956646967,4031777805,4028374788,33600511,2920084762,1018524850,629373528,3691585981,3515945977,2091462646,2486323059,586499841,988145025,935516892,3367335476,2599673255,2839830854,265290510,3972581182,2759138881,3795373465,1005194799,847297441,406762289,1314163512,1332590856,1866599683,4127851711,750260880,613907577,1450815602,3165620655,3734664991,3650291728,3012275730,3704569646,1427272223,778793252,1343938022,2676280711,2052605720,1946737175,3164576444,3914038668,3967478842,3682934266,1661551462,3294938066,4011595847,840292616,3712170807,616741398,312560963,711312465,1351876610,322626781,1910503582,271666773,2175563734,1594956187,70604529,3617834859,1007753275,1495573769,4069517037,2549218298,2663038764,504708206,2263041392,3941167025,2249088522,1514023603,1998579484,1312622330,694541497,2582060303,2151582166,1382467621,776784248,2618340202,3323268794,2497899128,2784771155,503983604,4076293799,907881277,423175695,432175456,1378068232,4145222326,3954048622,3938656102,3820766613,2793130115,2977904593,26017576,3274890735,3194772133,1700274565,1756076034,4006520079,3677328699,720338349,1533947780,354530856,688349552,3973924725,1637815568,332179504,3949051286,53804574,2852348879,3044236432,1282449977,3583942155,3416972820,4006381244,1617046695,2628476075,3002303598,1686838959,431878346,2686675385,1700445008,1080580658,1009431731,832498133,3223435511,2605976345,2271191193,2516031870,1648197032,4164389018,2548247927,300782431,375919233,238389289,3353747414,2531188641,2019080857,1475708069,455242339,2609103871,448939670,3451063019,1395535956,2413381860,1841049896,1491858159,885456874,4264095073,4001119347,1565136089,3898914787,1108368660,540939232,1173283510,2745871338,3681308437,4207628240,3343053890,4016749493,1699691293,1103962373,3625875870,2256883143,3830138730,1031889488,3479347698,1535977030,4236805024,3251091107,2132092099,1774941330,1199868427,1452454533,157007616,2904115357,342012276,595725824,1480756522,206960106,497939518,591360097,863170706,2375253569,3596610801,1814182875,2094937945,3421402208,1082520231,3463918190,2785509508,435703966,3908032597,1641649973,2842273706,3305899714,1510255612,2148256476,2655287854,3276092548,4258621189,236887753,3681803219,274041037,1734335097,3815195456,3317970021,1899903192,1026095262,4050517792,356393447,2410691914,3873677099,3682840055],[3913112168,2491498743,4132185628,2489919796,1091903735,1979897079,3170134830,3567386728,3557303409,857797738,1136121015,1342202287,507115054,2535736646,337727348,3213592640,1301675037,2528481711,1895095763,1721773893,3216771564,62756741,2142006736,835421444,2531993523,1442658625,3659876326,2882144922,676362277,1392781812,170690266,3921047035,1759253602,3611846912,1745797284,664899054,1329594018,3901205900,3045908486,2062866102,2865634940,3543621612,3464012697,1080764994,553557557,3656615353,3996768171,991055499,499776247,1265440854,648242737,3940784050,980351604,3713745714,1749149687,3396870395,4211799374,3640570775,1161844396,3125318951,1431517754,545492359,4268468663,3499529547,1437099964,2702547544,3433638243,2581715763,2787789398,1060185593,1593081372,2418618748,4260947970,69676912,2159744348,86519011,2512459080,3838209314,1220612927,3339683548,133810670,1090789135,1078426020,1569222167,845107691,3583754449,4072456591,1091646820,628848692,1613405280,3757631651,526609435,236106946,48312990,2942717905,3402727701,1797494240,859738849,992217954,4005476642,2243076622,3870952857,3732016268,765654824,3490871365,2511836413,1685915746,3888969200,1414112111,2273134842,3281911079,4080962846,172450625,2569994100,980381355,4109958455,2819808352,2716589560,2568741196,3681446669,3329971472,1835478071,660984891,3704678404,4045999559,3422617507,3040415634,1762651403,1719377915,3470491036,2693910283,3642056355,3138596744,1364962596,2073328063,1983633131,926494387,3423689081,2150032023,4096667949,1749200295,3328846651,309677260,2016342300,1779581495,3079819751,111262694,1274766160,443224088,298511866,1025883608,3806446537,1145181785,168956806,3641502830,3584813610,1689216846,3666258015,3200248200,1692713982,2646376535,4042768518,1618508792,1610833997,3523052358,4130873264,2001055236,3610705100,2202168115,4028541809,2961195399,1006657119,2006996926,3186142756,1430667929,3210227297,1314452623,4074634658,4101304120,2273951170,1399257539,3367210612,3027628629,1190975929,2062231137,2333990788,2221543033,2438960610,1181637006,548689776,2362791313,3372408396,3104550113,3145860560,296247880,1970579870,3078560182,3769228297,1714227617,3291629107,3898220290,166772364,1251581989,493813264,448347421,195405023,2709975567,677966185,3703036547,1463355134,2715995803,1338867538,1343315457,2802222074,2684532164,233230375,2599980071,2000651841,3277868038,1638401717,4028070440,3237316320,6314154,819756386,300326615,590932579,1405279636,3267499572,3150704214,2428286686,3959192993,3461946742,1862657033,1266418056,963775037,2089974820,2263052895,1917689273,448879540,3550394620,3981727096,150775221,3627908307,1303187396,508620638,2975983352,2726630617,1817252668,1876281319,1457606340,908771278,3720792119,3617206836,2455994898,1729034894,1080033504],[976866871,3556439503,2881648439,1522871579,1555064734,1336096578,3548522304,2579274686,3574697629,3205460757,3593280638,3338716283,3079412587,564236357,2993598910,1781952180,1464380207,3163844217,3332601554,1699332808,1393555694,1183702653,3581086237,1288719814,691649499,2847557200,2895455976,3193889540,2717570544,1781354906,1676643554,2592534050,3230253752,1126444790,2770207658,2633158820,2210423226,2615765581,2414155088,3127139286,673620729,2805611233,1269405062,4015350505,3341807571,4149409754,1057255273,2012875353,2162469141,2276492801,2601117357,993977747,3918593370,2654263191,753973209,36408145,2530585658,25011837,3520020182,2088578344,530523599,2918365339,1524020338,1518925132,3760827505,3759777254,1202760957,3985898139,3906192525,674977740,4174734889,2031300136,2019492241,3983892565,4153806404,3822280332,352677332,2297720250,60907813,90501309,3286998549,1016092578,2535922412,2839152426,457141659,509813237,4120667899,652014361,1966332200,2975202805,55981186,2327461051,676427537,3255491064,2882294119,3433927263,1307055953,942726286,933058658,2468411793,3933900994,4215176142,1361170020,2001714738,2830558078,3274259782,1222529897,1679025792,2729314320,3714953764,1770335741,151462246,3013232138,1682292957,1483529935,471910574,1539241949,458788160,3436315007,1807016891,3718408830,978976581,1043663428,3165965781,1927990952,4200891579,2372276910,3208408903,3533431907,1412390302,2931980059,4132332400,1947078029,3881505623,4168226417,2941484381,1077988104,1320477388,886195818,18198404,3786409e3,2509781533,112762804,3463356488,1866414978,891333506,18488651,661792760,1628790961,3885187036,3141171499,876946877,2693282273,1372485963,791857591,2686433993,3759982718,3167212022,3472953795,2716379847,445679433,3561995674,3504004811,3574258232,54117162,3331405415,2381918588,3769707343,4154350007,1140177722,4074052095,668550556,3214352940,367459370,261225585,2610173221,4209349473,3468074219,3265815641,314222801,3066103646,3808782860,282218597,3406013506,3773591054,379116347,1285071038,846784868,2669647154,3771962079,3550491691,2305946142,453669953,1268987020,3317592352,3279303384,3744833421,2610507566,3859509063,266596637,3847019092,517658769,3462560207,3443424879,370717030,4247526661,2224018117,4143653529,4112773975,2788324899,2477274417,1456262402,2901442914,1517677493,1846949527,2295493580,3734397586,2176403920,1280348187,1908823572,3871786941,846861322,1172426758,3287448474,3383383037,1655181056,3139813346,901632758,1897031941,2986607138,3066810236,3447102507,1393639104,373351379,950779232,625454576,3124240540,4148612726,2007998917,544563296,2244738638,2330496472,2058025392,1291430526,424198748,50039436,29584100,3605783033,2429876329,2791104160,1057563949,3255363231,3075367218,3463963227,1469046755,985887462]];var c={pbox:[],sbox:[]};function o(_,C){let D=C>>24&255,T=C>>16&255,A=C>>8&255,v=C&255,g=_.sbox[0][D]+_.sbox[1][T];return g=g^_.sbox[2][A],g=g+_.sbox[3][v],g}function f(_,C,D){let T=C,A=D,v;for(let g=0;g<n;++g)T=T^_.pbox[g],A=o(_,T)^A,v=T,T=A,A=v;return v=T,T=A,A=v,A=A^_.pbox[n],T=T^_.pbox[n+1],{left:T,right:A}}function p(_,C,D){let T=C,A=D,v;for(let g=n+1;g>1;--g)T=T^_.pbox[g],A=o(_,T)^A,v=T,T=A,A=v;return v=T,T=A,A=v,A=A^_.pbox[1],T=T^_.pbox[0],{left:T,right:A}}function d(_,C,D){for(let N=0;N<4;N++){_.sbox[N]=[];for(let P=0;P<256;P++)_.sbox[N][P]=i[N][P]}let T=0;for(let N=0;N<n+2;N++)_.pbox[N]=s[N]^C[T],T++,T>=D&&(T=0);let A=0,v=0,g=0;for(let N=0;N<n+2;N+=2)g=f(_,A,v),A=g.left,v=g.right,_.pbox[N]=A,_.pbox[N+1]=v;for(let N=0;N<4;N++)for(let P=0;P<256;P+=2)g=f(_,A,v),A=g.left,v=g.right,_.sbox[N][P]=A,_.sbox[N][P+1]=v;return!0}var b=a.Blowfish=u.extend({_doReset:function(){if(this._keyPriorReset!==this._key){var _=this._keyPriorReset=this._key,C=_.words,D=_.sigBytes/4;d(c,C,D)}},encryptBlock:function(_,C){var D=f(c,_[C],_[C+1]);_[C]=D.left,_[C+1]=D.right},decryptBlock:function(_,C){var D=p(c,_[C],_[C+1]);_[C]=D.left,_[C+1]=D.right},blockSize:64/32,keySize:128/32,ivSize:64/32});t.Blowfish=u._createHelper(b)}(),e.Blowfish})});var f2=R((Ai,c2)=>{(function(e,t,r){typeof Ai=="object"?c2.exports=Ai=t(Ae(),fa(),ih(),oh(),uu(),lh(),au(),Po(),Wn(),_h(),Bo(),xh(),mh(),vh(),Jn(),Ch(),Br(),Ve(),Oh(),Ph(),wh(),Mh(),kh(),Uh(),qh(),zh(),Wh(),Qh(),Kh(),Zh(),e2(),r2(),a2(),i2(),o2()):typeof define=="function"&&define.amd?define(["./core","./x64-core","./lib-typedarrays","./enc-utf16","./enc-base64","./enc-base64url","./md5","./sha1","./sha256","./sha224","./sha512","./sha384","./sha3","./ripemd160","./hmac","./pbkdf2","./evpkdf","./cipher-core","./mode-cfb","./mode-ctr","./mode-ctr-gladman","./mode-ofb","./mode-ecb","./pad-ansix923","./pad-iso10126","./pad-iso97971","./pad-zeropadding","./pad-nopadding","./format-hex","./aes","./tripledes","./rc4","./rabbit","./rabbit-legacy","./blowfish"],t):e.CryptoJS=t(e.CryptoJS)})(Ai,function(e){return e})});var Ou=R((bC,l2)=>{"use strict";l2.exports=TypeError});var d2=R(()=>{});var pa=R((TC,P2)=>{var jo=typeof Map=="function"&&Map.prototype,wo=Object.getOwnPropertyDescriptor&&jo?Object.getOwnPropertyDescriptor(Map.prototype,"size"):null,gi=jo&&wo&&typeof wo.get=="function"?wo.get:null,h2=jo&&Map.prototype.forEach,zo=typeof Set=="function"&&Set.prototype,Lo=Object.getOwnPropertyDescriptor&&zo?Object.getOwnPropertyDescriptor(Set.prototype,"size"):null,vi=zo&&Lo&&typeof Lo.get=="function"?Lo.get:null,p2=zo&&Set.prototype.forEach,dm=typeof WeakMap=="function"&&WeakMap.prototype,da=dm?WeakMap.prototype.has:null,hm=typeof WeakSet=="function"&&WeakSet.prototype,ha=hm?WeakSet.prototype.has:null,pm=typeof WeakRef=="function"&&WeakRef.prototype,b2=pm?WeakRef.prototype.deref:null,bm=Boolean.prototype.valueOf,_m=Object.prototype.toString,Em=Function.prototype.toString,Tm=String.prototype.match,Yo=String.prototype.slice,nu=String.prototype.replace,xm=String.prototype.toUpperCase,_2=String.prototype.toLowerCase,D2=RegExp.prototype.test,E2=Array.prototype.concat,br=Array.prototype.join,Am=Array.prototype.slice,T2=Math.floor,ko=typeof BigInt=="function"?BigInt.prototype.valueOf:null,Mo=Object.getOwnPropertySymbols,Ho=typeof Symbol=="function"&&typeof Symbol.iterator=="symbol"?Symbol.prototype.toString:null,b0=typeof Symbol=="function"&&typeof Symbol.iterator=="object",lt=typeof Symbol=="function"&&Symbol.toStringTag&&(typeof Symbol.toStringTag===b0||!0)?Symbol.toStringTag:null,C2=Object.prototype.propertyIsEnumerable,x2=(typeof Reflect=="function"?Reflect.getPrototypeOf:Object.getPrototypeOf)||([].__proto__===Array.prototype?function(e){return e.__proto__}:null);function A2(e,t){if(e===1/0||e===-1/0||e!==e||e&&e>-1e3&&e<1e3||D2.call(/e/,t))return t;var r=/[0-9](?=(?:[0-9]{3})+(?![0-9]))/g;if(typeof e=="number"){var u=e<0?-T2(-e):T2(e);if(u!==e){var a=String(u),n=Yo.call(t,a.length+1);return nu.call(a,r,"$&_")+"."+nu.call(nu.call(n,/([0-9]{3})/g,"$&_"),/_$/,"")}}return nu.call(t,r,"$&_")}var Uo=d2(),m2=Uo.custom,g2=N2(m2)?m2:null,I2={__proto__:null,double:\'"\',single:"\'"},mm={__proto__:null,double:/(["\\\\])/g,single:/([\'\\\\])/g};P2.exports=function e(t,r,u,a){var n=r||{};if(wr(n,"quoteStyle")&&!wr(I2,n.quoteStyle))throw new TypeError(\'option "quoteStyle" must be "single" or "double"\');if(wr(n,"maxStringLength")&&(typeof n.maxStringLength=="number"?n.maxStringLength<0&&n.maxStringLength!==1/0:n.maxStringLength!==null))throw new TypeError(\'option "maxStringLength", if provided, must be a positive integer, Infinity, or `null`\');var s=wr(n,"customInspect")?n.customInspect:!0;if(typeof s!="boolean"&&s!=="symbol")throw new TypeError("option \\"customInspect\\", if provided, must be `true`, `false`, or `\'symbol\'`");if(wr(n,"indent")&&n.indent!==null&&n.indent!=="	"&&!(parseInt(n.indent,10)===n.indent&&n.indent>0))throw new TypeError(\'option "indent" must be "\\\\t", an integer > 0, or `null`\');if(wr(n,"numericSeparator")&&typeof n.numericSeparator!="boolean")throw new TypeError(\'option "numericSeparator", if provided, must be `true` or `false`\');var i=n.numericSeparator;if(typeof t=="undefined")return"undefined";if(t===null)return"null";if(typeof t=="boolean")return t?"true":"false";if(typeof t=="string")return R2(t,n);if(typeof t=="number"){if(t===0)return 1/0/t>0?"0":"-0";var c=String(t);return i?A2(t,c):c}if(typeof t=="bigint"){var o=String(t)+"n";return i?A2(t,o):o}var f=typeof n.depth=="undefined"?5:n.depth;if(typeof u=="undefined"&&(u=0),u>=f&&f>0&&typeof t=="object")return Go(t)?"[Array]":"[Object]";var p=Hm(n,u);if(typeof a=="undefined")a=[];else if(O2(a,t)>=0)return"[Circular]";function d(w,S,X){if(S&&(a=Am.call(a),a.push(S)),X){var z={depth:n.depth};return wr(n,"quoteStyle")&&(z.quoteStyle=n.quoteStyle),e(w,z,u+1,a)}return e(w,n,u+1,a)}if(typeof t=="function"&&!v2(t)){var b=Om(t),_=mi(t,d);return"[Function"+(b?": "+b:" (anonymous)")+"]"+(_.length>0?" { "+br.call(_,", ")+" }":"")}if(N2(t)){var C=b0?nu.call(String(t),/^(Symbol\\(.*\\))_[^)]*$/,"$1"):Ho.call(t);return typeof t=="object"&&!b0?la(C):C}if(Mm(t)){for(var D="<"+_2.call(String(t.nodeName)),T=t.attributes||[],A=0;A<T.length;A++)D+=" "+T[A].name+"="+S2(gm(T[A].value),"double",n);return D+=">",t.childNodes&&t.childNodes.length&&(D+="..."),D+="</"+_2.call(String(t.nodeName))+">",D}if(Go(t)){if(t.length===0)return"[]";var v=mi(t,d);return p&&!km(v)?"["+qo(v,p)+"]":"[ "+br.call(v,", ")+" ]"}if(ym(t)){var g=mi(t,d);return!("cause"in Error.prototype)&&"cause"in t&&!C2.call(t,"cause")?"{ ["+String(t)+"] "+br.call(E2.call("[cause]: "+d(t.cause),g),", ")+" }":g.length===0?"["+String(t)+"]":"{ ["+String(t)+"] "+br.call(g,", ")+" }"}if(typeof t=="object"&&s){if(g2&&typeof t[g2]=="function"&&Uo)return Uo(t,{depth:f-u});if(s!=="symbol"&&typeof t.inspect=="function")return t.inspect()}if(Rm(t)){var N=[];return h2&&h2.call(t,function(w,S){N.push(d(S,t,!0)+" => "+d(w,t))}),y2("Map",gi.call(t),N,p)}if(wm(t)){var P=[];return p2&&p2.call(t,function(w){P.push(d(w,t))}),y2("Set",vi.call(t),P,p)}if(Pm(t))return Fo("WeakMap");if(Lm(t))return Fo("WeakSet");if(Bm(t))return Fo("WeakRef");if(Cm(t))return la(d(Number(t)));if(Sm(t))return la(d(ko.call(t)));if(Im(t))return la(bm.call(t));if(Dm(t))return la(d(String(t)));if(typeof window!="undefined"&&t===window)return"{ [object Window] }";if(typeof globalThis!="undefined"&&t===globalThis||typeof global!="undefined"&&t===global)return"{ [object globalThis] }";if(!vm(t)&&!v2(t)){var H=mi(t,d),k=x2?x2(t)===Object.prototype:t instanceof Object||t.constructor===Object,B=t instanceof Object?"":"null prototype",j=!k&&lt&&Object(t)===t&&lt in t?Yo.call(iu(t),8,-1):B?"Object":"",L=k||typeof t.constructor!="function"?"":t.constructor.name?t.constructor.name+" ":"",F=L+(j||B?"["+br.call(E2.call([],j||[],B||[]),": ")+"] ":"");return H.length===0?F+"{}":p?F+"{"+qo(H,p)+"}":F+"{ "+br.call(H,", ")+" }"}return String(t)};function S2(e,t,r){var u=r.quoteStyle||t,a=I2[u];return a+e+a}function gm(e){return nu.call(String(e),/"/g,"&quot;")}function Go(e){return iu(e)==="[object Array]"&&(!lt||!(typeof e=="object"&&lt in e))}function vm(e){return iu(e)==="[object Date]"&&(!lt||!(typeof e=="object"&&lt in e))}function v2(e){return iu(e)==="[object RegExp]"&&(!lt||!(typeof e=="object"&&lt in e))}function ym(e){return iu(e)==="[object Error]"&&(!lt||!(typeof e=="object"&&lt in e))}function Dm(e){return iu(e)==="[object String]"&&(!lt||!(typeof e=="object"&&lt in e))}function Cm(e){return iu(e)==="[object Number]"&&(!lt||!(typeof e=="object"&&lt in e))}function Im(e){return iu(e)==="[object Boolean]"&&(!lt||!(typeof e=="object"&&lt in e))}function N2(e){if(b0)return e&&typeof e=="object"&&e instanceof Symbol;if(typeof e=="symbol")return!0;if(!e||typeof e!="object"||!Ho)return!1;try{return Ho.call(e),!0}catch(t){}return!1}function Sm(e){if(!e||typeof e!="object"||!ko)return!1;try{return ko.call(e),!0}catch(t){}return!1}var Nm=Object.prototype.hasOwnProperty||function(e){return e in this};function wr(e,t){return Nm.call(e,t)}function iu(e){return _m.call(e)}function Om(e){if(e.name)return e.name;var t=Tm.call(Em.call(e),/^function\\s*([\\w$]+)/);return t?t[1]:null}function O2(e,t){if(e.indexOf)return e.indexOf(t);for(var r=0,u=e.length;r<u;r++)if(e[r]===t)return r;return-1}function Rm(e){if(!gi||!e||typeof e!="object")return!1;try{gi.call(e);try{vi.call(e)}catch(t){return!0}return e instanceof Map}catch(t){}return!1}function Pm(e){if(!da||!e||typeof e!="object")return!1;try{da.call(e,da);try{ha.call(e,ha)}catch(t){return!0}return e instanceof WeakMap}catch(t){}return!1}function Bm(e){if(!b2||!e||typeof e!="object")return!1;try{return b2.call(e),!0}catch(t){}return!1}function wm(e){if(!vi||!e||typeof e!="object")return!1;try{vi.call(e);try{gi.call(e)}catch(t){return!0}return e instanceof Set}catch(t){}return!1}function Lm(e){if(!ha||!e||typeof e!="object")return!1;try{ha.call(e,ha);try{da.call(e,da)}catch(t){return!0}return e instanceof WeakSet}catch(t){}return!1}function Mm(e){return!e||typeof e!="object"?!1:typeof HTMLElement!="undefined"&&e instanceof HTMLElement?!0:typeof e.nodeName=="string"&&typeof e.getAttribute=="function"}function R2(e,t){if(e.length>t.maxStringLength){var r=e.length-t.maxStringLength,u="... "+r+" more character"+(r>1?"s":"");return R2(Yo.call(e,0,t.maxStringLength),t)+u}var a=mm[t.quoteStyle||"single"];a.lastIndex=0;var n=nu.call(nu.call(e,a,"\\\\$1"),/[\\x00-\\x1f]/g,Fm);return S2(n,"single",t)}function Fm(e){var t=e.charCodeAt(0),r={8:"b",9:"t",10:"n",12:"f",13:"r"}[t];return r?"\\\\"+r:"\\\\x"+(t<16?"0":"")+xm.call(t.toString(16))}function la(e){return"Object("+e+")"}function Fo(e){return e+" { ? }"}function y2(e,t,r,u){var a=u?qo(r,u):br.call(r,", ");return e+" ("+t+") {"+a+"}"}function km(e){for(var t=0;t<e.length;t++)if(O2(e[t],`\n`)>=0)return!1;return!0}function Hm(e,t){var r;if(e.indent==="	")r="	";else if(typeof e.indent=="number"&&e.indent>0)r=br.call(Array(e.indent+1)," ");else return null;return{base:r,prev:br.call(Array(t+1),r)}}function qo(e,t){if(e.length===0)return"";var r=`\n`+t.prev+t.base;return r+br.call(e,","+r)+`\n`+t.prev}function mi(e,t){var r=Go(e),u=[];if(r){u.length=e.length;for(var a=0;a<e.length;a++)u[a]=wr(e,a)?t(e[a],e):""}var n=typeof Mo=="function"?Mo(e):[],s;if(b0){s={};for(var i=0;i<n.length;i++)s["$"+n[i]]=n[i]}for(var c in e)wr(e,c)&&(r&&String(Number(c))===c&&c<e.length||b0&&s["$"+c]instanceof Symbol||(D2.call(/[^\\w$]/,c)?u.push(t(c,e)+": "+t(e[c],e)):u.push(c+": "+t(e[c],e))));if(typeof Mo=="function")for(var o=0;o<n.length;o++)C2.call(e,n[o])&&u.push("["+t(n[o])+"]: "+t(e[n[o]],e));return u}});var w2=R((xC,B2)=>{"use strict";var Um=pa(),Gm=Ou(),yi=function(e,t,r){for(var u=e,a;(a=u.next)!=null;u=a)if(a.key===t)return u.next=a.next,r||(a.next=e.next,e.next=a),a},qm=function(e,t){if(e){var r=yi(e,t);return r&&r.value}},jm=function(e,t,r){var u=yi(e,t);u?u.value=r:e.next={key:t,next:e.next,value:r}},zm=function(e,t){return e?!!yi(e,t):!1},Ym=function(e,t){if(e)return yi(e,t,!0)};B2.exports=function(){var t,r={assert:function(u){if(!r.has(u))throw new Gm("Side channel does not contain "+Um(u))},delete:function(u){var a=t&&t.next,n=Ym(t,u);return n&&a&&a===n&&(t=void 0),!!n},get:function(u){return qm(t,u)},has:function(u){return zm(t,u)},set:function(u,a){t||(t={next:void 0}),jm(t,u,a)}};return r}});var Wo=R((AC,L2)=>{"use strict";L2.exports=Object});var F2=R((mC,M2)=>{"use strict";M2.exports=Error});var H2=R((gC,k2)=>{"use strict";k2.exports=EvalError});var G2=R((vC,U2)=>{"use strict";U2.exports=RangeError});var j2=R((yC,q2)=>{"use strict";q2.exports=ReferenceError});var Y2=R((DC,z2)=>{"use strict";z2.exports=SyntaxError});var V2=R((CC,W2)=>{"use strict";W2.exports=URIError});var X2=R((IC,Q2)=>{"use strict";Q2.exports=Math.abs});var $2=R((SC,K2)=>{"use strict";K2.exports=Math.floor});var J2=R((NC,Z2)=>{"use strict";Z2.exports=Math.max});var tp=R((OC,ep)=>{"use strict";ep.exports=Math.min});var up=R((RC,rp)=>{"use strict";rp.exports=Math.pow});var np=R((PC,ap)=>{"use strict";ap.exports=Math.round});var sp=R((BC,ip)=>{"use strict";ip.exports=Number.isNaN||function(t){return t!==t}});var cp=R((wC,op)=>{"use strict";var Wm=sp();op.exports=function(t){return Wm(t)||t===0?t:t<0?-1:1}});var lp=R((LC,fp)=>{"use strict";fp.exports=Object.getOwnPropertyDescriptor});var Vo=R((MC,dp)=>{"use strict";var Di=lp();if(Di)try{Di([],"length")}catch(e){Di=null}dp.exports=Di});var pp=R((FC,hp)=>{"use strict";var Ci=Object.defineProperty||!1;if(Ci)try{Ci({},"a",{value:1})}catch(e){Ci=!1}hp.exports=Ci});var _p=R((kC,bp)=>{"use strict";bp.exports=function(){if(typeof Symbol!="function"||typeof Object.getOwnPropertySymbols!="function")return!1;if(typeof Symbol.iterator=="symbol")return!0;var t={},r=Symbol("test"),u=Object(r);if(typeof r=="string"||Object.prototype.toString.call(r)!=="[object Symbol]"||Object.prototype.toString.call(u)!=="[object Symbol]")return!1;var a=42;t[r]=a;for(var n in t)return!1;if(typeof Object.keys=="function"&&Object.keys(t).length!==0||typeof Object.getOwnPropertyNames=="function"&&Object.getOwnPropertyNames(t).length!==0)return!1;var s=Object.getOwnPropertySymbols(t);if(s.length!==1||s[0]!==r||!Object.prototype.propertyIsEnumerable.call(t,r))return!1;if(typeof Object.getOwnPropertyDescriptor=="function"){var i=Object.getOwnPropertyDescriptor(t,r);if(i.value!==a||i.enumerable!==!0)return!1}return!0}});var xp=R((HC,Tp)=>{"use strict";var Ep=typeof Symbol!="undefined"&&Symbol,Vm=_p();Tp.exports=function(){return typeof Ep!="function"||typeof Symbol!="function"||typeof Ep("foo")!="symbol"||typeof Symbol("bar")!="symbol"?!1:Vm()}});var Qo=R((UC,Ap)=>{"use strict";Ap.exports=typeof Reflect!="undefined"&&Reflect.getPrototypeOf||null});var Xo=R((GC,mp)=>{"use strict";var Qm=Wo();mp.exports=Qm.getPrototypeOf||null});var yp=R((qC,vp)=>{"use strict";var Xm="Function.prototype.bind called on incompatible ",Km=Object.prototype.toString,$m=Math.max,Zm="[object Function]",gp=function(t,r){for(var u=[],a=0;a<t.length;a+=1)u[a]=t[a];for(var n=0;n<r.length;n+=1)u[n+t.length]=r[n];return u},Jm=function(t,r){for(var u=[],a=r||0,n=0;a<t.length;a+=1,n+=1)u[n]=t[a];return u},eg=function(e,t){for(var r="",u=0;u<e.length;u+=1)r+=e[u],u+1<e.length&&(r+=t);return r};vp.exports=function(t){var r=this;if(typeof r!="function"||Km.apply(r)!==Zm)throw new TypeError(Xm+r);for(var u=Jm(arguments,1),a,n=function(){if(this instanceof a){var f=r.apply(this,gp(u,arguments));return Object(f)===f?f:this}return r.apply(t,gp(u,arguments))},s=$m(0,r.length-u.length),i=[],c=0;c<s;c++)i[c]="$"+c;if(a=Function("binder","return function ("+eg(i,",")+"){ return binder.apply(this,arguments); }")(n),r.prototype){var o=function(){};o.prototype=r.prototype,a.prototype=new o,o.prototype=null}return a}});var ba=R((jC,Dp)=>{"use strict";var tg=yp();Dp.exports=Function.prototype.bind||tg});var Ii=R((zC,Cp)=>{"use strict";Cp.exports=Function.prototype.call});var Ko=R((YC,Ip)=>{"use strict";Ip.exports=Function.prototype.apply});var Np=R((WC,Sp)=>{"use strict";Sp.exports=typeof Reflect!="undefined"&&Reflect&&Reflect.apply});var Rp=R((VC,Op)=>{"use strict";var rg=ba(),ug=Ko(),ag=Ii(),ng=Np();Op.exports=ng||rg.call(ag,ug)});var $o=R((QC,Pp)=>{"use strict";var ig=ba(),sg=Ou(),og=Ii(),cg=Rp();Pp.exports=function(t){if(t.length<1||typeof t[0]!="function")throw new sg("a function is required");return cg(ig,og,t)}});var kp=R((XC,Fp)=>{"use strict";var fg=$o(),Bp=Vo(),Lp;try{Lp=[].__proto__===Array.prototype}catch(e){if(!e||typeof e!="object"||!("code"in e)||e.code!=="ERR_PROTO_ACCESS")throw e}var Zo=!!Lp&&Bp&&Bp(Object.prototype,"__proto__"),Mp=Object,wp=Mp.getPrototypeOf;Fp.exports=Zo&&typeof Zo.get=="function"?fg([Zo.get]):typeof wp=="function"?function(t){return wp(t==null?t:Mp(t))}:!1});var jp=R((KC,qp)=>{"use strict";var Hp=Qo(),Up=Xo(),Gp=kp();qp.exports=Hp?function(t){return Hp(t)}:Up?function(t){if(!t||typeof t!="object"&&typeof t!="function")throw new TypeError("getProto: not an object");return Up(t)}:Gp?function(t){return Gp(t)}:null});var Yp=R(($C,zp)=>{"use strict";var lg=Function.prototype.call,dg=Object.prototype.hasOwnProperty,hg=ba();zp.exports=hg.call(lg,dg)});var Oi=R((ZC,$p)=>{"use strict";var Te,pg=Wo(),bg=F2(),_g=H2(),Eg=G2(),Tg=j2(),x0=Y2(),T0=Ou(),xg=V2(),Ag=X2(),mg=$2(),gg=J2(),vg=tp(),yg=up(),Dg=np(),Cg=cp(),Xp=Function,Jo=function(e){try{return Xp(\'"use strict"; return (\'+e+").constructor;")()}catch(t){}},_a=Vo(),Ig=pp(),ec=function(){throw new T0},Sg=_a?function(){try{return arguments.callee,ec}catch(e){try{return _a(arguments,"callee").get}catch(t){return ec}}}():ec,_0=xp()(),rt=jp(),Ng=Xo(),Og=Qo(),Kp=Ko(),Ea=Ii(),E0={},Rg=typeof Uint8Array=="undefined"||!rt?Te:rt(Uint8Array),Ru={__proto__:null,"%AggregateError%":typeof AggregateError=="undefined"?Te:AggregateError,"%Array%":Array,"%ArrayBuffer%":typeof ArrayBuffer=="undefined"?Te:ArrayBuffer,"%ArrayIteratorPrototype%":_0&&rt?rt([][Symbol.iterator]()):Te,"%AsyncFromSyncIteratorPrototype%":Te,"%AsyncFunction%":E0,"%AsyncGenerator%":E0,"%AsyncGeneratorFunction%":E0,"%AsyncIteratorPrototype%":E0,"%Atomics%":typeof Atomics=="undefined"?Te:Atomics,"%BigInt%":typeof BigInt=="undefined"?Te:BigInt,"%BigInt64Array%":typeof BigInt64Array=="undefined"?Te:BigInt64Array,"%BigUint64Array%":typeof BigUint64Array=="undefined"?Te:BigUint64Array,"%Boolean%":Boolean,"%DataView%":typeof DataView=="undefined"?Te:DataView,"%Date%":Date,"%decodeURI%":decodeURI,"%decodeURIComponent%":decodeURIComponent,"%encodeURI%":encodeURI,"%encodeURIComponent%":encodeURIComponent,"%Error%":bg,"%eval%":eval,"%EvalError%":_g,"%Float16Array%":typeof Float16Array=="undefined"?Te:Float16Array,"%Float32Array%":typeof Float32Array=="undefined"?Te:Float32Array,"%Float64Array%":typeof Float64Array=="undefined"?Te:Float64Array,"%FinalizationRegistry%":typeof FinalizationRegistry=="undefined"?Te:FinalizationRegistry,"%Function%":Xp,"%GeneratorFunction%":E0,"%Int8Array%":typeof Int8Array=="undefined"?Te:Int8Array,"%Int16Array%":typeof Int16Array=="undefined"?Te:Int16Array,"%Int32Array%":typeof Int32Array=="undefined"?Te:Int32Array,"%isFinite%":isFinite,"%isNaN%":isNaN,"%IteratorPrototype%":_0&&rt?rt(rt([][Symbol.iterator]())):Te,"%JSON%":typeof JSON=="object"?JSON:Te,"%Map%":typeof Map=="undefined"?Te:Map,"%MapIteratorPrototype%":typeof Map=="undefined"||!_0||!rt?Te:rt(new Map()[Symbol.iterator]()),"%Math%":Math,"%Number%":Number,"%Object%":pg,"%Object.getOwnPropertyDescriptor%":_a,"%parseFloat%":parseFloat,"%parseInt%":parseInt,"%Promise%":typeof Promise=="undefined"?Te:Promise,"%Proxy%":typeof Proxy=="undefined"?Te:Proxy,"%RangeError%":Eg,"%ReferenceError%":Tg,"%Reflect%":typeof Reflect=="undefined"?Te:Reflect,"%RegExp%":RegExp,"%Set%":typeof Set=="undefined"?Te:Set,"%SetIteratorPrototype%":typeof Set=="undefined"||!_0||!rt?Te:rt(new Set()[Symbol.iterator]()),"%SharedArrayBuffer%":typeof SharedArrayBuffer=="undefined"?Te:SharedArrayBuffer,"%String%":String,"%StringIteratorPrototype%":_0&&rt?rt(""[Symbol.iterator]()):Te,"%Symbol%":_0?Symbol:Te,"%SyntaxError%":x0,"%ThrowTypeError%":Sg,"%TypedArray%":Rg,"%TypeError%":T0,"%Uint8Array%":typeof Uint8Array=="undefined"?Te:Uint8Array,"%Uint8ClampedArray%":typeof Uint8ClampedArray=="undefined"?Te:Uint8ClampedArray,"%Uint16Array%":typeof Uint16Array=="undefined"?Te:Uint16Array,"%Uint32Array%":typeof Uint32Array=="undefined"?Te:Uint32Array,"%URIError%":xg,"%WeakMap%":typeof WeakMap=="undefined"?Te:WeakMap,"%WeakRef%":typeof WeakRef=="undefined"?Te:WeakRef,"%WeakSet%":typeof WeakSet=="undefined"?Te:WeakSet,"%Function.prototype.call%":Ea,"%Function.prototype.apply%":Kp,"%Object.defineProperty%":Ig,"%Object.getPrototypeOf%":Ng,"%Math.abs%":Ag,"%Math.floor%":mg,"%Math.max%":gg,"%Math.min%":vg,"%Math.pow%":yg,"%Math.round%":Dg,"%Math.sign%":Cg,"%Reflect.getPrototypeOf%":Og};if(rt)try{null.error}catch(e){Wp=rt(rt(e)),Ru["%Error.prototype%"]=Wp}var Wp,Pg=function e(t){var r;if(t==="%AsyncFunction%")r=Jo("async function () {}");else if(t==="%GeneratorFunction%")r=Jo("function* () {}");else if(t==="%AsyncGeneratorFunction%")r=Jo("async function* () {}");else if(t==="%AsyncGenerator%"){var u=e("%AsyncGeneratorFunction%");u&&(r=u.prototype)}else if(t==="%AsyncIteratorPrototype%"){var a=e("%AsyncGenerator%");a&&rt&&(r=rt(a.prototype))}return Ru[t]=r,r},Vp={__proto__:null,"%ArrayBufferPrototype%":["ArrayBuffer","prototype"],"%ArrayPrototype%":["Array","prototype"],"%ArrayProto_entries%":["Array","prototype","entries"],"%ArrayProto_forEach%":["Array","prototype","forEach"],"%ArrayProto_keys%":["Array","prototype","keys"],"%ArrayProto_values%":["Array","prototype","values"],"%AsyncFunctionPrototype%":["AsyncFunction","prototype"],"%AsyncGenerator%":["AsyncGeneratorFunction","prototype"],"%AsyncGeneratorPrototype%":["AsyncGeneratorFunction","prototype","prototype"],"%BooleanPrototype%":["Boolean","prototype"],"%DataViewPrototype%":["DataView","prototype"],"%DatePrototype%":["Date","prototype"],"%ErrorPrototype%":["Error","prototype"],"%EvalErrorPrototype%":["EvalError","prototype"],"%Float32ArrayPrototype%":["Float32Array","prototype"],"%Float64ArrayPrototype%":["Float64Array","prototype"],"%FunctionPrototype%":["Function","prototype"],"%Generator%":["GeneratorFunction","prototype"],"%GeneratorPrototype%":["GeneratorFunction","prototype","prototype"],"%Int8ArrayPrototype%":["Int8Array","prototype"],"%Int16ArrayPrototype%":["Int16Array","prototype"],"%Int32ArrayPrototype%":["Int32Array","prototype"],"%JSONParse%":["JSON","parse"],"%JSONStringify%":["JSON","stringify"],"%MapPrototype%":["Map","prototype"],"%NumberPrototype%":["Number","prototype"],"%ObjectPrototype%":["Object","prototype"],"%ObjProto_toString%":["Object","prototype","toString"],"%ObjProto_valueOf%":["Object","prototype","valueOf"],"%PromisePrototype%":["Promise","prototype"],"%PromiseProto_then%":["Promise","prototype","then"],"%Promise_all%":["Promise","all"],"%Promise_reject%":["Promise","reject"],"%Promise_resolve%":["Promise","resolve"],"%RangeErrorPrototype%":["RangeError","prototype"],"%ReferenceErrorPrototype%":["ReferenceError","prototype"],"%RegExpPrototype%":["RegExp","prototype"],"%SetPrototype%":["Set","prototype"],"%SharedArrayBufferPrototype%":["SharedArrayBuffer","prototype"],"%StringPrototype%":["String","prototype"],"%SymbolPrototype%":["Symbol","prototype"],"%SyntaxErrorPrototype%":["SyntaxError","prototype"],"%TypedArrayPrototype%":["TypedArray","prototype"],"%TypeErrorPrototype%":["TypeError","prototype"],"%Uint8ArrayPrototype%":["Uint8Array","prototype"],"%Uint8ClampedArrayPrototype%":["Uint8ClampedArray","prototype"],"%Uint16ArrayPrototype%":["Uint16Array","prototype"],"%Uint32ArrayPrototype%":["Uint32Array","prototype"],"%URIErrorPrototype%":["URIError","prototype"],"%WeakMapPrototype%":["WeakMap","prototype"],"%WeakSetPrototype%":["WeakSet","prototype"]},Ta=ba(),Si=Yp(),Bg=Ta.call(Ea,Array.prototype.concat),wg=Ta.call(Kp,Array.prototype.splice),Qp=Ta.call(Ea,String.prototype.replace),Ni=Ta.call(Ea,String.prototype.slice),Lg=Ta.call(Ea,RegExp.prototype.exec),Mg=/[^%.[\\]]+|\\[(?:(-?\\d+(?:\\.\\d+)?)|(["\'])((?:(?!\\2)[^\\\\]|\\\\.)*?)\\2)\\]|(?=(?:\\.|\\[\\])(?:\\.|\\[\\]|%$))/g,Fg=/\\\\(\\\\)?/g,kg=function(t){var r=Ni(t,0,1),u=Ni(t,-1);if(r==="%"&&u!=="%")throw new x0("invalid intrinsic syntax, expected closing `%`");if(u==="%"&&r!=="%")throw new x0("invalid intrinsic syntax, expected opening `%`");var a=[];return Qp(t,Mg,function(n,s,i,c){a[a.length]=i?Qp(c,Fg,"$1"):s||n}),a},Hg=function(t,r){var u=t,a;if(Si(Vp,u)&&(a=Vp[u],u="%"+a[0]+"%"),Si(Ru,u)){var n=Ru[u];if(n===E0&&(n=Pg(u)),typeof n=="undefined"&&!r)throw new T0("intrinsic "+t+" exists, but is not available. Please file an issue!");return{alias:a,name:u,value:n}}throw new x0("intrinsic "+t+" does not exist!")};$p.exports=function(t,r){if(typeof t!="string"||t.length===0)throw new T0("intrinsic name must be a non-empty string");if(arguments.length>1&&typeof r!="boolean")throw new T0(\'"allowMissing" argument must be a boolean\');if(Lg(/^%?[^%]*%?$/,t)===null)throw new x0("`%` may not be present anywhere but at the beginning and end of the intrinsic name");var u=kg(t),a=u.length>0?u[0]:"",n=Hg("%"+a+"%",r),s=n.name,i=n.value,c=!1,o=n.alias;o&&(a=o[0],wg(u,Bg([0,1],o)));for(var f=1,p=!0;f<u.length;f+=1){var d=u[f],b=Ni(d,0,1),_=Ni(d,-1);if((b===\'"\'||b==="\'"||b==="`"||_===\'"\'||_==="\'"||_==="`")&&b!==_)throw new x0("property names with quotes must have matching quotes");if((d==="constructor"||!p)&&(c=!0),a+="."+d,s="%"+a+"%",Si(Ru,s))i=Ru[s];else if(i!=null){if(!(d in i)){if(!r)throw new T0("base intrinsic for "+t+" exists, but the property is not available.");return}if(_a&&f+1>=u.length){var C=_a(i,d);p=!!C,p&&"get"in C&&!("originalValue"in C.get)?i=C.get:i=i[d]}else p=Si(i,d),i=i[d];p&&!c&&(Ru[s]=i)}}return i}});var tc=R((JC,eb)=>{"use strict";var Zp=Oi(),Jp=$o(),Ug=Jp([Zp("%String.prototype.indexOf%")]);eb.exports=function(t,r){var u=Zp(t,!!r);return typeof u=="function"&&Ug(t,".prototype.")>-1?Jp([u]):u}});var rc=R((eI,rb)=>{"use strict";var Gg=Oi(),xa=tc(),qg=pa(),jg=Ou(),tb=Gg("%Map%",!0),zg=xa("Map.prototype.get",!0),Yg=xa("Map.prototype.set",!0),Wg=xa("Map.prototype.has",!0),Vg=xa("Map.prototype.delete",!0),Qg=xa("Map.prototype.size",!0);rb.exports=!!tb&&function(){var t,r={assert:function(u){if(!r.has(u))throw new jg("Side channel does not contain "+qg(u))},delete:function(u){if(t){var a=Vg(t,u);return Qg(t)===0&&(t=void 0),a}return!1},get:function(u){if(t)return zg(t,u)},has:function(u){return t?Wg(t,u):!1},set:function(u,a){t||(t=new tb),Yg(t,u,a)}};return r}});var ab=R((tI,ub)=>{"use strict";var Xg=Oi(),Pi=tc(),Kg=pa(),Ri=rc(),$g=Ou(),A0=Xg("%WeakMap%",!0),Zg=Pi("WeakMap.prototype.get",!0),Jg=Pi("WeakMap.prototype.set",!0),ev=Pi("WeakMap.prototype.has",!0),tv=Pi("WeakMap.prototype.delete",!0);ub.exports=A0?function(){var t,r,u={assert:function(a){if(!u.has(a))throw new $g("Side channel does not contain "+Kg(a))},delete:function(a){if(A0&&a&&(typeof a=="object"||typeof a=="function")){if(t)return tv(t,a)}else if(Ri&&r)return r.delete(a);return!1},get:function(a){return A0&&a&&(typeof a=="object"||typeof a=="function")&&t?Zg(t,a):r&&r.get(a)},has:function(a){return A0&&a&&(typeof a=="object"||typeof a=="function")&&t?ev(t,a):!!r&&r.has(a)},set:function(a,n){A0&&a&&(typeof a=="object"||typeof a=="function")?(t||(t=new A0),Jg(t,a,n)):Ri&&(r||(r=Ri()),r.set(a,n))}};return u}:Ri});var ib=R((rI,nb)=>{"use strict";var rv=Ou(),uv=pa(),av=w2(),nv=rc(),iv=ab(),sv=iv||nv||av;nb.exports=function(){var t,r={assert:function(u){if(!r.has(u))throw new rv("Side channel does not contain "+uv(u))},delete:function(u){return!!t&&t.delete(u)},get:function(u){return t&&t.get(u)},has:function(u){return!!t&&t.has(u)},set:function(u,a){t||(t=sv()),t.set(u,a)}};return r}});var Bi=R((uI,sb)=>{"use strict";var ov=String.prototype.replace,cv=/%20/g,uc={RFC1738:"RFC1738",RFC3986:"RFC3986"};sb.exports={default:uc.RFC3986,formatters:{RFC1738:function(e){return ov.call(e,cv,"+")},RFC3986:function(e){return String(e)}},RFC1738:uc.RFC1738,RFC3986:uc.RFC3986}});var ic=R((aI,cb)=>{"use strict";var fv=Bi(),ac=Object.prototype.hasOwnProperty,Pu=Array.isArray,_r=function(){for(var e=[],t=0;t<256;++t)e.push("%"+((t<16?"0":"")+t.toString(16)).toUpperCase());return e}(),lv=function(t){for(;t.length>1;){var r=t.pop(),u=r.obj[r.prop];if(Pu(u)){for(var a=[],n=0;n<u.length;++n)typeof u[n]!="undefined"&&a.push(u[n]);r.obj[r.prop]=a}}},ob=function(t,r){for(var u=r&&r.plainObjects?Object.create(null):{},a=0;a<t.length;++a)typeof t[a]!="undefined"&&(u[a]=t[a]);return u},dv=function e(t,r,u){if(!r)return t;if(typeof r!="object"){if(Pu(t))t.push(r);else if(t&&typeof t=="object")(u&&(u.plainObjects||u.allowPrototypes)||!ac.call(Object.prototype,r))&&(t[r]=!0);else return[t,r];return t}if(!t||typeof t!="object")return[t].concat(r);var a=t;return Pu(t)&&!Pu(r)&&(a=ob(t,u)),Pu(t)&&Pu(r)?(r.forEach(function(n,s){if(ac.call(t,s)){var i=t[s];i&&typeof i=="object"&&n&&typeof n=="object"?t[s]=e(i,n,u):t.push(n)}else t[s]=n}),t):Object.keys(r).reduce(function(n,s){var i=r[s];return ac.call(n,s)?n[s]=e(n[s],i,u):n[s]=i,n},a)},hv=function(t,r){return Object.keys(r).reduce(function(u,a){return u[a]=r[a],u},t)},pv=function(e,t,r){var u=e.replace(/\\+/g," ");if(r==="iso-8859-1")return u.replace(/%[0-9a-f]{2}/gi,unescape);try{return decodeURIComponent(u)}catch(a){return u}},nc=1024,bv=function(t,r,u,a,n){if(t.length===0)return t;var s=t;if(typeof t=="symbol"?s=Symbol.prototype.toString.call(t):typeof t!="string"&&(s=String(t)),u==="iso-8859-1")return escape(s).replace(/%u[0-9a-f]{4}/gi,function(b){return"%26%23"+parseInt(b.slice(2),16)+"%3B"});for(var i="",c=0;c<s.length;c+=nc){for(var o=s.length>=nc?s.slice(c,c+nc):s,f=[],p=0;p<o.length;++p){var d=o.charCodeAt(p);if(d===45||d===46||d===95||d===126||d>=48&&d<=57||d>=65&&d<=90||d>=97&&d<=122||n===fv.RFC1738&&(d===40||d===41)){f[f.length]=o.charAt(p);continue}if(d<128){f[f.length]=_r[d];continue}if(d<2048){f[f.length]=_r[192|d>>6]+_r[128|d&63];continue}if(d<55296||d>=57344){f[f.length]=_r[224|d>>12]+_r[128|d>>6&63]+_r[128|d&63];continue}p+=1,d=65536+((d&1023)<<10|o.charCodeAt(p)&1023),f[f.length]=_r[240|d>>18]+_r[128|d>>12&63]+_r[128|d>>6&63]+_r[128|d&63]}i+=f.join("")}return i},_v=function(t){for(var r=[{obj:{o:t},prop:"o"}],u=[],a=0;a<r.length;++a)for(var n=r[a],s=n.obj[n.prop],i=Object.keys(s),c=0;c<i.length;++c){var o=i[c],f=s[o];typeof f=="object"&&f!==null&&u.indexOf(f)===-1&&(r.push({obj:s,prop:o}),u.push(f))}return lv(r),t},Ev=function(t){return Object.prototype.toString.call(t)==="[object RegExp]"},Tv=function(t){return!t||typeof t!="object"?!1:!!(t.constructor&&t.constructor.isBuffer&&t.constructor.isBuffer(t))},xv=function(t,r){return[].concat(t,r)},Av=function(t,r){if(Pu(t)){for(var u=[],a=0;a<t.length;a+=1)u.push(r(t[a]));return u}return r(t)};cb.exports={arrayToObject:ob,assign:hv,combine:xv,compact:_v,decode:pv,encode:bv,isBuffer:Tv,isRegExp:Ev,maybeMap:Av,merge:dv}});var bb=R((nI,pb)=>{"use strict";var lb=ib(),wi=ic(),Aa=Bi(),mv=Object.prototype.hasOwnProperty,db={brackets:function(t){return t+"[]"},comma:"comma",indices:function(t,r){return t+"["+r+"]"},repeat:function(t){return t}},Er=Array.isArray,gv=Array.prototype.push,hb=function(e,t){gv.apply(e,Er(t)?t:[t])},vv=Date.prototype.toISOString,fb=Aa.default,Qe={addQueryPrefix:!1,allowDots:!1,allowEmptyArrays:!1,arrayFormat:"indices",charset:"utf-8",charsetSentinel:!1,delimiter:"&",encode:!0,encodeDotInKeys:!1,encoder:wi.encode,encodeValuesOnly:!1,format:fb,formatter:Aa.formatters[fb],indices:!1,serializeDate:function(t){return vv.call(t)},skipNulls:!1,strictNullHandling:!1},yv=function(t){return typeof t=="string"||typeof t=="number"||typeof t=="boolean"||typeof t=="symbol"||typeof t=="bigint"},sc={},Dv=function e(t,r,u,a,n,s,i,c,o,f,p,d,b,_,C,D,T,A){for(var v=t,g=A,N=0,P=!1;(g=g.get(sc))!==void 0&&!P;){var H=g.get(t);if(N+=1,typeof H!="undefined"){if(H===N)throw new RangeError("Cyclic object value");P=!0}typeof g.get(sc)=="undefined"&&(N=0)}if(typeof f=="function"?v=f(r,v):v instanceof Date?v=b(v):u==="comma"&&Er(v)&&(v=wi.maybeMap(v,function(W){return W instanceof Date?b(W):W})),v===null){if(s)return o&&!D?o(r,Qe.encoder,T,"key",_):r;v=""}if(yv(v)||wi.isBuffer(v)){if(o){var k=D?r:o(r,Qe.encoder,T,"key",_);return[C(k)+"="+C(o(v,Qe.encoder,T,"value",_))]}return[C(r)+"="+C(String(v))]}var B=[];if(typeof v=="undefined")return B;var j;if(u==="comma"&&Er(v))D&&o&&(v=wi.maybeMap(v,o)),j=[{value:v.length>0?v.join(",")||null:void 0}];else if(Er(f))j=f;else{var L=Object.keys(v);j=p?L.sort(p):L}var F=c?r.replace(/\\./g,"%2E"):r,w=a&&Er(v)&&v.length===1?F+"[]":F;if(n&&Er(v)&&v.length===0)return w+"[]";for(var S=0;S<j.length;++S){var X=j[S],z=typeof X=="object"&&typeof X.value!="undefined"?X.value:v[X];if(!(i&&z===null)){var re=d&&c?X.replace(/\\./g,"%2E"):X,ue=Er(v)?typeof u=="function"?u(w,re):w:w+(d?"."+re:"["+re+"]");A.set(t,N);var U=lb();U.set(sc,A),hb(B,e(z,ue,u,a,n,s,i,c,u==="comma"&&D&&Er(v)?null:o,f,p,d,b,_,C,D,T,U))}}return B},Cv=function(t){if(!t)return Qe;if(typeof t.allowEmptyArrays!="undefined"&&typeof t.allowEmptyArrays!="boolean")throw new TypeError("`allowEmptyArrays` option can only be `true` or `false`, when provided");if(typeof t.encodeDotInKeys!="undefined"&&typeof t.encodeDotInKeys!="boolean")throw new TypeError("`encodeDotInKeys` option can only be `true` or `false`, when provided");if(t.encoder!==null&&typeof t.encoder!="undefined"&&typeof t.encoder!="function")throw new TypeError("Encoder has to be a function.");var r=t.charset||Qe.charset;if(typeof t.charset!="undefined"&&t.charset!=="utf-8"&&t.charset!=="iso-8859-1")throw new TypeError("The charset option must be either utf-8, iso-8859-1, or undefined");var u=Aa.default;if(typeof t.format!="undefined"){if(!mv.call(Aa.formatters,t.format))throw new TypeError("Unknown format option provided.");u=t.format}var a=Aa.formatters[u],n=Qe.filter;(typeof t.filter=="function"||Er(t.filter))&&(n=t.filter);var s;if(t.arrayFormat in db?s=t.arrayFormat:"indices"in t?s=t.indices?"indices":"repeat":s=Qe.arrayFormat,"commaRoundTrip"in t&&typeof t.commaRoundTrip!="boolean")throw new TypeError("`commaRoundTrip` must be a boolean, or absent");var i=typeof t.allowDots=="undefined"?t.encodeDotInKeys===!0?!0:Qe.allowDots:!!t.allowDots;return{addQueryPrefix:typeof t.addQueryPrefix=="boolean"?t.addQueryPrefix:Qe.addQueryPrefix,allowDots:i,allowEmptyArrays:typeof t.allowEmptyArrays=="boolean"?!!t.allowEmptyArrays:Qe.allowEmptyArrays,arrayFormat:s,charset:r,charsetSentinel:typeof t.charsetSentinel=="boolean"?t.charsetSentinel:Qe.charsetSentinel,commaRoundTrip:t.commaRoundTrip,delimiter:typeof t.delimiter=="undefined"?Qe.delimiter:t.delimiter,encode:typeof t.encode=="boolean"?t.encode:Qe.encode,encodeDotInKeys:typeof t.encodeDotInKeys=="boolean"?t.encodeDotInKeys:Qe.encodeDotInKeys,encoder:typeof t.encoder=="function"?t.encoder:Qe.encoder,encodeValuesOnly:typeof t.encodeValuesOnly=="boolean"?t.encodeValuesOnly:Qe.encodeValuesOnly,filter:n,format:u,formatter:a,serializeDate:typeof t.serializeDate=="function"?t.serializeDate:Qe.serializeDate,skipNulls:typeof t.skipNulls=="boolean"?t.skipNulls:Qe.skipNulls,sort:typeof t.sort=="function"?t.sort:null,strictNullHandling:typeof t.strictNullHandling=="boolean"?t.strictNullHandling:Qe.strictNullHandling}};pb.exports=function(e,t){var r=e,u=Cv(t),a,n;typeof u.filter=="function"?(n=u.filter,r=n("",r)):Er(u.filter)&&(n=u.filter,a=n);var s=[];if(typeof r!="object"||r===null)return"";var i=db[u.arrayFormat],c=i==="comma"&&u.commaRoundTrip;a||(a=Object.keys(r)),u.sort&&a.sort(u.sort);for(var o=lb(),f=0;f<a.length;++f){var p=a[f];u.skipNulls&&r[p]===null||hb(s,Dv(r[p],p,i,c,u.allowEmptyArrays,u.strictNullHandling,u.skipNulls,u.encodeDotInKeys,u.encode?u.encoder:null,u.filter,u.sort,u.allowDots,u.serializeDate,u.format,u.formatter,u.encodeValuesOnly,u.charset,o))}var d=s.join(u.delimiter),b=u.addQueryPrefix===!0?"?":"";return u.charsetSentinel&&(u.charset==="iso-8859-1"?b+="utf8=%26%2310003%3B&":b+="utf8=%E2%9C%93&"),d.length>0?b+d:""}});var Tb=R((iI,Eb)=>{"use strict";var m0=ic(),oc=Object.prototype.hasOwnProperty,Iv=Array.isArray,Ge={allowDots:!1,allowEmptyArrays:!1,allowPrototypes:!1,allowSparse:!1,arrayLimit:20,charset:"utf-8",charsetSentinel:!1,comma:!1,decodeDotInKeys:!1,decoder:m0.decode,delimiter:"&",depth:5,duplicates:"combine",ignoreQueryPrefix:!1,interpretNumericEntities:!1,parameterLimit:1e3,parseArrays:!0,plainObjects:!1,strictDepth:!1,strictNullHandling:!1},Sv=function(e){return e.replace(/&#(\\d+);/g,function(t,r){return String.fromCharCode(parseInt(r,10))})},_b=function(e,t){return e&&typeof e=="string"&&t.comma&&e.indexOf(",")>-1?e.split(","):e},Nv="utf8=%26%2310003%3B",Ov="utf8=%E2%9C%93",Rv=function(t,r){var u={__proto__:null},a=r.ignoreQueryPrefix?t.replace(/^\\?/,""):t;a=a.replace(/%5B/gi,"[").replace(/%5D/gi,"]");var n=r.parameterLimit===1/0?void 0:r.parameterLimit,s=a.split(r.delimiter,n),i=-1,c,o=r.charset;if(r.charsetSentinel)for(c=0;c<s.length;++c)s[c].indexOf("utf8=")===0&&(s[c]===Ov?o="utf-8":s[c]===Nv&&(o="iso-8859-1"),i=c,c=s.length);for(c=0;c<s.length;++c)if(c!==i){var f=s[c],p=f.indexOf("]="),d=p===-1?f.indexOf("="):p+1,b,_;d===-1?(b=r.decoder(f,Ge.decoder,o,"key"),_=r.strictNullHandling?null:""):(b=r.decoder(f.slice(0,d),Ge.decoder,o,"key"),_=m0.maybeMap(_b(f.slice(d+1),r),function(D){return r.decoder(D,Ge.decoder,o,"value")})),_&&r.interpretNumericEntities&&o==="iso-8859-1"&&(_=Sv(_)),f.indexOf("[]=")>-1&&(_=Iv(_)?[_]:_);var C=oc.call(u,b);C&&r.duplicates==="combine"?u[b]=m0.combine(u[b],_):(!C||r.duplicates==="last")&&(u[b]=_)}return u},Pv=function(e,t,r,u){for(var a=u?t:_b(t,r),n=e.length-1;n>=0;--n){var s,i=e[n];if(i==="[]"&&r.parseArrays)s=r.allowEmptyArrays&&(a===""||r.strictNullHandling&&a===null)?[]:[].concat(a);else{s=r.plainObjects?Object.create(null):{};var c=i.charAt(0)==="["&&i.charAt(i.length-1)==="]"?i.slice(1,-1):i,o=r.decodeDotInKeys?c.replace(/%2E/g,"."):c,f=parseInt(o,10);!r.parseArrays&&o===""?s={0:a}:!isNaN(f)&&i!==o&&String(f)===o&&f>=0&&r.parseArrays&&f<=r.arrayLimit?(s=[],s[f]=a):o!=="__proto__"&&(s[o]=a)}a=s}return a},Bv=function(t,r,u,a){if(t){var n=u.allowDots?t.replace(/\\.([^.[]+)/g,"[$1]"):t,s=/(\\[[^[\\]]*])/,i=/(\\[[^[\\]]*])/g,c=u.depth>0&&s.exec(n),o=c?n.slice(0,c.index):n,f=[];if(o){if(!u.plainObjects&&oc.call(Object.prototype,o)&&!u.allowPrototypes)return;f.push(o)}for(var p=0;u.depth>0&&(c=i.exec(n))!==null&&p<u.depth;){if(p+=1,!u.plainObjects&&oc.call(Object.prototype,c[1].slice(1,-1))&&!u.allowPrototypes)return;f.push(c[1])}if(c){if(u.strictDepth===!0)throw new RangeError("Input depth exceeded depth option of "+u.depth+" and strictDepth is true");f.push("["+n.slice(c.index)+"]")}return Pv(f,r,u,a)}},wv=function(t){if(!t)return Ge;if(typeof t.allowEmptyArrays!="undefined"&&typeof t.allowEmptyArrays!="boolean")throw new TypeError("`allowEmptyArrays` option can only be `true` or `false`, when provided");if(typeof t.decodeDotInKeys!="undefined"&&typeof t.decodeDotInKeys!="boolean")throw new TypeError("`decodeDotInKeys` option can only be `true` or `false`, when provided");if(t.decoder!==null&&typeof t.decoder!="undefined"&&typeof t.decoder!="function")throw new TypeError("Decoder has to be a function.");if(typeof t.charset!="undefined"&&t.charset!=="utf-8"&&t.charset!=="iso-8859-1")throw new TypeError("The charset option must be either utf-8, iso-8859-1, or undefined");var r=typeof t.charset=="undefined"?Ge.charset:t.charset,u=typeof t.duplicates=="undefined"?Ge.duplicates:t.duplicates;if(u!=="combine"&&u!=="first"&&u!=="last")throw new TypeError("The duplicates option must be either combine, first, or last");var a=typeof t.allowDots=="undefined"?t.decodeDotInKeys===!0?!0:Ge.allowDots:!!t.allowDots;return{allowDots:a,allowEmptyArrays:typeof t.allowEmptyArrays=="boolean"?!!t.allowEmptyArrays:Ge.allowEmptyArrays,allowPrototypes:typeof t.allowPrototypes=="boolean"?t.allowPrototypes:Ge.allowPrototypes,allowSparse:typeof t.allowSparse=="boolean"?t.allowSparse:Ge.allowSparse,arrayLimit:typeof t.arrayLimit=="number"?t.arrayLimit:Ge.arrayLimit,charset:r,charsetSentinel:typeof t.charsetSentinel=="boolean"?t.charsetSentinel:Ge.charsetSentinel,comma:typeof t.comma=="boolean"?t.comma:Ge.comma,decodeDotInKeys:typeof t.decodeDotInKeys=="boolean"?t.decodeDotInKeys:Ge.decodeDotInKeys,decoder:typeof t.decoder=="function"?t.decoder:Ge.decoder,delimiter:typeof t.delimiter=="string"||m0.isRegExp(t.delimiter)?t.delimiter:Ge.delimiter,depth:typeof t.depth=="number"||t.depth===!1?+t.depth:Ge.depth,duplicates:u,ignoreQueryPrefix:t.ignoreQueryPrefix===!0,interpretNumericEntities:typeof t.interpretNumericEntities=="boolean"?t.interpretNumericEntities:Ge.interpretNumericEntities,parameterLimit:typeof t.parameterLimit=="number"?t.parameterLimit:Ge.parameterLimit,parseArrays:t.parseArrays!==!1,plainObjects:typeof t.plainObjects=="boolean"?t.plainObjects:Ge.plainObjects,strictDepth:typeof t.strictDepth=="boolean"?!!t.strictDepth:Ge.strictDepth,strictNullHandling:typeof t.strictNullHandling=="boolean"?t.strictNullHandling:Ge.strictNullHandling}};Eb.exports=function(e,t){var r=wv(t);if(e===""||e===null||typeof e=="undefined")return r.plainObjects?Object.create(null):{};for(var u=typeof e=="string"?Rv(e,r):e,a=r.plainObjects?Object.create(null):{},n=Object.keys(u),s=0;s<n.length;++s){var i=n[s],c=Bv(i,u[i],r,typeof e=="string");a=m0.merge(a,c,r)}return r.allowSparse===!0?a:m0.compact(a)}});var Ab=R((sI,xb)=>{"use strict";var Lv=bb(),Mv=Tb(),Fv=Bi();xb.exports={formats:Fv,parse:Mv,stringify:Lv}});var mb=R((cc,fc)=>{(function(e,t){typeof cc=="object"&&typeof fc!="undefined"?fc.exports=t():typeof define=="function"&&define.amd?define(t):(e=typeof globalThis!="undefined"?globalThis:e||self).dayjs=t()})(cc,function(){"use strict";var e=1e3,t=6e4,r=36e5,u="millisecond",a="second",n="minute",s="hour",i="day",c="week",o="month",f="quarter",p="year",d="date",b="Invalid Date",_=/^(\\d{4})[-/]?(\\d{1,2})?[-/]?(\\d{0,2})[Tt\\s]*(\\d{1,2})?:?(\\d{1,2})?:?(\\d{1,2})?[.:]?(\\d+)?$/,C=/\\[([^\\]]+)]|Y{1,4}|M{1,4}|D{1,2}|d{1,4}|H{1,2}|h{1,2}|a|A|m{1,2}|s{1,2}|Z{1,2}|SSS/g,D={name:"en",weekdays:"Sunday_Monday_Tuesday_Wednesday_Thursday_Friday_Saturday".split("_"),months:"January_February_March_April_May_June_July_August_September_October_November_December".split("_"),ordinal:function(F){var w=["th","st","nd","rd"],S=F%100;return"["+F+(w[(S-20)%10]||w[S]||w[0])+"]"}},T=function(F,w,S){var X=String(F);return!X||X.length>=w?F:""+Array(w+1-X.length).join(S)+F},A={s:T,z:function(F){var w=-F.utcOffset(),S=Math.abs(w),X=Math.floor(S/60),z=S%60;return(w<=0?"+":"-")+T(X,2,"0")+":"+T(z,2,"0")},m:function F(w,S){if(w.date()<S.date())return-F(S,w);var X=12*(S.year()-w.year())+(S.month()-w.month()),z=w.clone().add(X,o),re=S-z<0,ue=w.clone().add(X+(re?-1:1),o);return+(-(X+(S-z)/(re?z-ue:ue-z))||0)},a:function(F){return F<0?Math.ceil(F)||0:Math.floor(F)},p:function(F){return{M:o,y:p,w:c,d:i,D:d,h:s,m:n,s:a,ms:u,Q:f}[F]||String(F||"").toLowerCase().replace(/s$/,"")},u:function(F){return F===void 0}},v="en",g={};g[v]=D;var N="$isDayjsObject",P=function(F){return F instanceof j||!(!F||!F[N])},H=function F(w,S,X){var z;if(!w)return v;if(typeof w=="string"){var re=w.toLowerCase();g[re]&&(z=re),S&&(g[re]=S,z=re);var ue=w.split("-");if(!z&&ue.length>1)return F(ue[0])}else{var U=w.name;g[U]=w,z=U}return!X&&z&&(v=z),z||!X&&v},k=function(F,w){if(P(F))return F.clone();var S=typeof w=="object"?w:{};return S.date=F,S.args=arguments,new j(S)},B=A;B.l=H,B.i=P,B.w=function(F,w){return k(F,{locale:w.$L,utc:w.$u,x:w.$x,$offset:w.$offset})};var j=function(){function F(S){this.$L=H(S.locale,null,!0),this.parse(S),this.$x=this.$x||S.x||{},this[N]=!0}var w=F.prototype;return w.parse=function(S){this.$d=function(X){var z=X.date,re=X.utc;if(z===null)return new Date(NaN);if(B.u(z))return new Date;if(z instanceof Date)return new Date(z);if(typeof z=="string"&&!/Z$/i.test(z)){var ue=z.match(_);if(ue){var U=ue[2]-1||0,W=(ue[7]||"0").substring(0,3);return re?new Date(Date.UTC(ue[1],U,ue[3]||1,ue[4]||0,ue[5]||0,ue[6]||0,W)):new Date(ue[1],U,ue[3]||1,ue[4]||0,ue[5]||0,ue[6]||0,W)}}return new Date(z)}(S),this.init()},w.init=function(){var S=this.$d;this.$y=S.getFullYear(),this.$M=S.getMonth(),this.$D=S.getDate(),this.$W=S.getDay(),this.$H=S.getHours(),this.$m=S.getMinutes(),this.$s=S.getSeconds(),this.$ms=S.getMilliseconds()},w.$utils=function(){return B},w.isValid=function(){return this.$d.toString()!==b},w.isSame=function(S,X){var z=k(S);return this.startOf(X)<=z&&z<=this.endOf(X)},w.isAfter=function(S,X){return k(S)<this.startOf(X)},w.isBefore=function(S,X){return this.endOf(X)<k(S)},w.$g=function(S,X,z){return B.u(S)?this[X]:this.set(z,S)},w.unix=function(){return Math.floor(this.valueOf()/1e3)},w.valueOf=function(){return this.$d.getTime()},w.startOf=function(S,X){var z=this,re=!!B.u(X)||X,ue=B.p(S),U=function(dt,Re){var ht=B.w(z.$u?Date.UTC(z.$y,Re,dt):new Date(z.$y,Re,dt),z);return re?ht:ht.endOf(i)},W=function(dt,Re){return B.w(z.toDate()[dt].apply(z.toDate("s"),(re?[0,0,0,0]:[23,59,59,999]).slice(Re)),z)},Q=this.$W,V=this.$M,de=this.$D,xe="set"+(this.$u?"UTC":"");switch(ue){case p:return re?U(1,0):U(31,11);case o:return re?U(1,V):U(0,V+1);case c:var Oe=this.$locale().weekStart||0,fe=(Q<Oe?Q+7:Q)-Oe;return U(re?de-fe:de+(6-fe),V);case i:case d:return W(xe+"Hours",0);case s:return W(xe+"Minutes",1);case n:return W(xe+"Seconds",2);case a:return W(xe+"Milliseconds",3);default:return this.clone()}},w.endOf=function(S){return this.startOf(S,!1)},w.$set=function(S,X){var z,re=B.p(S),ue="set"+(this.$u?"UTC":""),U=(z={},z[i]=ue+"Date",z[d]=ue+"Date",z[o]=ue+"Month",z[p]=ue+"FullYear",z[s]=ue+"Hours",z[n]=ue+"Minutes",z[a]=ue+"Seconds",z[u]=ue+"Milliseconds",z)[re],W=re===i?this.$D+(X-this.$W):X;if(re===o||re===p){var Q=this.clone().set(d,1);Q.$d[U](W),Q.init(),this.$d=Q.set(d,Math.min(this.$D,Q.daysInMonth())).$d}else U&&this.$d[U](W);return this.init(),this},w.set=function(S,X){return this.clone().$set(S,X)},w.get=function(S){return this[B.p(S)]()},w.add=function(S,X){var z,re=this;S=Number(S);var ue=B.p(X),U=function(V){var de=k(re);return B.w(de.date(de.date()+Math.round(V*S)),re)};if(ue===o)return this.set(o,this.$M+S);if(ue===p)return this.set(p,this.$y+S);if(ue===i)return U(1);if(ue===c)return U(7);var W=(z={},z[n]=t,z[s]=r,z[a]=e,z)[ue]||1,Q=this.$d.getTime()+S*W;return B.w(Q,this)},w.subtract=function(S,X){return this.add(-1*S,X)},w.format=function(S){var X=this,z=this.$locale();if(!this.isValid())return z.invalidDate||b;var re=S||"YYYY-MM-DDTHH:mm:ssZ",ue=B.z(this),U=this.$H,W=this.$m,Q=this.$M,V=z.weekdays,de=z.months,xe=z.meridiem,Oe=function(Re,ht,At,qe){return Re&&(Re[ht]||Re(X,re))||At[ht].slice(0,qe)},fe=function(Re){return B.s(U%12||12,Re,"0")},dt=xe||function(Re,ht,At){var qe=Re<12?"AM":"PM";return At?qe.toLowerCase():qe};return re.replace(C,function(Re,ht){return ht||function(At){switch(At){case"YY":return String(X.$y).slice(-2);case"YYYY":return B.s(X.$y,4,"0");case"M":return Q+1;case"MM":return B.s(Q+1,2,"0");case"MMM":return Oe(z.monthsShort,Q,de,3);case"MMMM":return Oe(de,Q);case"D":return X.$D;case"DD":return B.s(X.$D,2,"0");case"d":return String(X.$W);case"dd":return Oe(z.weekdaysMin,X.$W,V,2);case"ddd":return Oe(z.weekdaysShort,X.$W,V,3);case"dddd":return V[X.$W];case"H":return String(U);case"HH":return B.s(U,2,"0");case"h":return fe(1);case"hh":return fe(2);case"a":return dt(U,W,!0);case"A":return dt(U,W,!1);case"m":return String(W);case"mm":return B.s(W,2,"0");case"s":return String(X.$s);case"ss":return B.s(X.$s,2,"0");case"SSS":return B.s(X.$ms,3,"0");case"Z":return ue}return null}(Re)||ue.replace(":","")})},w.utcOffset=function(){return 15*-Math.round(this.$d.getTimezoneOffset()/15)},w.diff=function(S,X,z){var re,ue=this,U=B.p(X),W=k(S),Q=(W.utcOffset()-this.utcOffset())*t,V=this-W,de=function(){return B.m(ue,W)};switch(U){case p:re=de()/12;break;case o:re=de();break;case f:re=de()/3;break;case c:re=(V-Q)/6048e5;break;case i:re=(V-Q)/864e5;break;case s:re=V/r;break;case n:re=V/t;break;case a:re=V/e;break;default:re=V}return z?re:B.a(re)},w.daysInMonth=function(){return this.endOf(o).$D},w.$locale=function(){return g[this.$L]},w.locale=function(S,X){if(!S)return this.$L;var z=this.clone(),re=H(S,X,!0);return re&&(z.$L=re),z},w.clone=function(){return B.w(this.$d,this)},w.toDate=function(){return new Date(this.valueOf())},w.toJSON=function(){return this.isValid()?this.toISOString():null},w.toISOString=function(){return this.$d.toISOString()},w.toString=function(){return this.$d.toUTCString()},F}(),L=j.prototype;return k.prototype=L,[["$ms",u],["$s",a],["$m",n],["$H",s],["$W",i],["$M",o],["$y",p],["$D",d]].forEach(function(F){L[F[1]]=function(w){return this.$g(w,F[0],F[1])}}),k.extend=function(F,w){return F.$i||(F(w,j,k),F.$i=!0),k},k.locale=H,k.isDayjs=P,k.unix=function(F){return k(1e3*F)},k.en=g[v],k.Ls=g,k.p={},k})});var gb=R((oI,Li)=>{var Xe=function(e){"use strict";var t=1e7,r=7,u=9007199254740992,a=d(u),n="0123456789abcdefghijklmnopqrstuvwxyz",s=typeof BigInt=="function";function i(h,x,I,O){return typeof h=="undefined"?i[0]:typeof x!="undefined"?+x==10&&!I?ce(h):Uu(h,x,I,O):ce(h)}function c(h,x){this.value=h,this.sign=x,this.isSmall=!1}c.prototype=Object.create(i.prototype);function o(h){this.value=h,this.sign=h<0,this.isSmall=!0}o.prototype=Object.create(i.prototype);function f(h){this.value=h}f.prototype=Object.create(i.prototype);function p(h){return-u<h&&h<u}function d(h){return h<1e7?[h]:h<1e14?[h%1e7,Math.floor(h/1e7)]:[h%1e7,Math.floor(h/1e7)%1e7,Math.floor(h/1e14)]}function b(h){_(h);var x=h.length;if(x<4&&ue(h,a)<0)switch(x){case 0:return 0;case 1:return h[0];case 2:return h[0]+h[1]*t;default:return h[0]+(h[1]+h[2]*t)*t}return h}function _(h){for(var x=h.length;h[--x]===0;);h.length=x+1}function C(h){for(var x=new Array(h),I=-1;++I<h;)x[I]=0;return x}function D(h){return h>0?Math.floor(h):Math.ceil(h)}function T(h,x){var I=h.length,O=x.length,G=new Array(I),M=0,K=t,$,ee;for(ee=0;ee<O;ee++)$=h[ee]+x[ee]+M,M=$>=K?1:0,G[ee]=$-M*K;for(;ee<I;)$=h[ee]+M,M=$===K?1:0,G[ee++]=$-M*K;return M>0&&G.push(M),G}function A(h,x){return h.length>=x.length?T(h,x):T(x,h)}function v(h,x){var I=h.length,O=new Array(I),G=t,M,K;for(K=0;K<I;K++)M=h[K]-G+x,x=Math.floor(M/G),O[K]=M-x*G,x+=1;for(;x>0;)O[K++]=x%G,x=Math.floor(x/G);return O}c.prototype.add=function(h){var x=ce(h);if(this.sign!==x.sign)return this.subtract(x.negate());var I=this.value,O=x.value;return x.isSmall?new c(v(I,Math.abs(O)),this.sign):new c(A(I,O),this.sign)},c.prototype.plus=c.prototype.add,o.prototype.add=function(h){var x=ce(h),I=this.value;if(I<0!==x.sign)return this.subtract(x.negate());var O=x.value;if(x.isSmall){if(p(I+O))return new o(I+O);O=d(Math.abs(O))}return new c(v(O,Math.abs(I)),I<0)},o.prototype.plus=o.prototype.add,f.prototype.add=function(h){return new f(this.value+ce(h).value)},f.prototype.plus=f.prototype.add;function g(h,x){var I=h.length,O=x.length,G=new Array(I),M=0,K=t,$,ee;for($=0;$<O;$++)ee=h[$]-M-x[$],ee<0?(ee+=K,M=1):M=0,G[$]=ee;for($=O;$<I;$++){if(ee=h[$]-M,ee<0)ee+=K;else{G[$++]=ee;break}G[$]=ee}for(;$<I;$++)G[$]=h[$];return _(G),G}function N(h,x,I){var O;return ue(h,x)>=0?O=g(h,x):(O=g(x,h),I=!I),O=b(O),typeof O=="number"?(I&&(O=-O),new o(O)):new c(O,I)}function P(h,x,I){var O=h.length,G=new Array(O),M=-x,K=t,$,ee;for($=0;$<O;$++)ee=h[$]+M,M=Math.floor(ee/K),ee%=K,G[$]=ee<0?ee+K:ee;return G=b(G),typeof G=="number"?(I&&(G=-G),new o(G)):new c(G,I)}c.prototype.subtract=function(h){var x=ce(h);if(this.sign!==x.sign)return this.add(x.negate());var I=this.value,O=x.value;return x.isSmall?P(I,Math.abs(O),this.sign):N(I,O,this.sign)},c.prototype.minus=c.prototype.subtract,o.prototype.subtract=function(h){var x=ce(h),I=this.value;if(I<0!==x.sign)return this.add(x.negate());var O=x.value;return x.isSmall?new o(I-O):P(O,Math.abs(I),I>=0)},o.prototype.minus=o.prototype.subtract,f.prototype.subtract=function(h){return new f(this.value-ce(h).value)},f.prototype.minus=f.prototype.subtract,c.prototype.negate=function(){return new c(this.value,!this.sign)},o.prototype.negate=function(){var h=this.sign,x=new o(-this.value);return x.sign=!h,x},f.prototype.negate=function(){return new f(-this.value)},c.prototype.abs=function(){return new c(this.value,!1)},o.prototype.abs=function(){return new o(Math.abs(this.value))},f.prototype.abs=function(){return new f(this.value>=0?this.value:-this.value)};function H(h,x){var I=h.length,O=x.length,G=I+O,M=C(G),K=t,$,ee,le,Ee,he;for(le=0;le<I;++le){Ee=h[le];for(var ge=0;ge<O;++ge)he=x[ge],$=Ee*he+M[le+ge],ee=Math.floor($/K),M[le+ge]=$-ee*K,M[le+ge+1]+=ee}return _(M),M}function k(h,x){var I=h.length,O=new Array(I),G=t,M=0,K,$;for($=0;$<I;$++)K=h[$]*x+M,M=Math.floor(K/G),O[$]=K-M*G;for(;M>0;)O[$++]=M%G,M=Math.floor(M/G);return O}function B(h,x){for(var I=[];x-- >0;)I.push(0);return I.concat(h)}function j(h,x){var I=Math.max(h.length,x.length);if(I<=30)return H(h,x);I=Math.ceil(I/2);var O=h.slice(I),G=h.slice(0,I),M=x.slice(I),K=x.slice(0,I),$=j(G,K),ee=j(O,M),le=j(A(G,O),A(K,M)),Ee=A(A($,B(g(g(le,$),ee),I)),B(ee,2*I));return _(Ee),Ee}function L(h,x){return-.012*h-.012*x+15e-6*h*x>0}c.prototype.multiply=function(h){var x=ce(h),I=this.value,O=x.value,G=this.sign!==x.sign,M;if(x.isSmall){if(O===0)return i[0];if(O===1)return this;if(O===-1)return this.negate();if(M=Math.abs(O),M<t)return new c(k(I,M),G);O=d(M)}return L(I.length,O.length)?new c(j(I,O),G):new c(H(I,O),G)},c.prototype.times=c.prototype.multiply;function F(h,x,I){return h<t?new c(k(x,h),I):new c(H(x,d(h)),I)}o.prototype._multiplyBySmall=function(h){return p(h.value*this.value)?new o(h.value*this.value):F(Math.abs(h.value),d(Math.abs(this.value)),this.sign!==h.sign)},c.prototype._multiplyBySmall=function(h){return h.value===0?i[0]:h.value===1?this:h.value===-1?this.negate():F(Math.abs(h.value),this.value,this.sign!==h.sign)},o.prototype.multiply=function(h){return ce(h)._multiplyBySmall(this)},o.prototype.times=o.prototype.multiply,f.prototype.multiply=function(h){return new f(this.value*ce(h).value)},f.prototype.times=f.prototype.multiply;function w(h){var x=h.length,I=C(x+x),O=t,G,M,K,$,ee;for(K=0;K<x;K++){$=h[K],M=0-$*$;for(var le=K;le<x;le++)ee=h[le],G=2*($*ee)+I[K+le]+M,M=Math.floor(G/O),I[K+le]=G-M*O;I[K+x]=M}return _(I),I}c.prototype.square=function(){return new c(w(this.value),!1)},o.prototype.square=function(){var h=this.value*this.value;return p(h)?new o(h):new c(w(d(Math.abs(this.value))),!1)},f.prototype.square=function(h){return new f(this.value*this.value)};function S(h,x){var I=h.length,O=x.length,G=t,M=C(x.length),K=x[O-1],$=Math.ceil(G/(2*K)),ee=k(h,$),le=k(x,$),Ee,he,ge,bt,ut,B0,Gu;for(ee.length<=I&&ee.push(0),le.push(0),K=le[O-1],he=I-O;he>=0;he--){for(Ee=G-1,ee[he+O]!==K&&(Ee=Math.floor((ee[he+O]*G+ee[he+O-1])/K)),ge=0,bt=0,B0=le.length,ut=0;ut<B0;ut++)ge+=Ee*le[ut],Gu=Math.floor(ge/G),bt+=ee[he+ut]-(ge-Gu*G),ge=Gu,bt<0?(ee[he+ut]=bt+G,bt=-1):(ee[he+ut]=bt,bt=0);for(;bt!==0;){for(Ee-=1,ge=0,ut=0;ut<B0;ut++)ge+=ee[he+ut]-G+le[ut],ge<0?(ee[he+ut]=ge+G,ge=0):(ee[he+ut]=ge,ge=1);bt+=ge}M[he]=Ee}return ee=z(ee,$)[0],[b(M),b(ee)]}function X(h,x){for(var I=h.length,O=x.length,G=[],M=[],K=t,$,ee,le,Ee,he;I;){if(M.unshift(h[--I]),_(M),ue(M,x)<0){G.push(0);continue}ee=M.length,le=M[ee-1]*K+M[ee-2],Ee=x[O-1]*K+x[O-2],ee>O&&(le=(le+1)*K),$=Math.ceil(le/Ee);do{if(he=k(x,$),ue(he,M)<=0)break;$--}while($);G.push($),M=g(M,he)}return G.reverse(),[b(G),b(M)]}function z(h,x){var I=h.length,O=C(I),G=t,M,K,$,ee;for($=0,M=I-1;M>=0;--M)ee=$*G+h[M],K=D(ee/x),$=ee-K*x,O[M]=K|0;return[O,$|0]}function re(h,x){var I,O=ce(x);if(s)return[new f(h.value/O.value),new f(h.value%O.value)];var G=h.value,M=O.value,K;if(M===0)throw new Error("Cannot divide by zero");if(h.isSmall)return O.isSmall?[new o(D(G/M)),new o(G%M)]:[i[0],h];if(O.isSmall){if(M===1)return[h,i[0]];if(M==-1)return[h.negate(),i[0]];var $=Math.abs(M);if($<t){I=z(G,$),K=b(I[0]);var ee=I[1];return h.sign&&(ee=-ee),typeof K=="number"?(h.sign!==O.sign&&(K=-K),[new o(K),new o(ee)]):[new c(K,h.sign!==O.sign),new o(ee)]}M=d($)}var le=ue(G,M);if(le===-1)return[i[0],h];if(le===0)return[i[h.sign===O.sign?1:-1],i[0]];G.length+M.length<=200?I=S(G,M):I=X(G,M),K=I[0];var Ee=h.sign!==O.sign,he=I[1],ge=h.sign;return typeof K=="number"?(Ee&&(K=-K),K=new o(K)):K=new c(K,Ee),typeof he=="number"?(ge&&(he=-he),he=new o(he)):he=new c(he,ge),[K,he]}c.prototype.divmod=function(h){var x=re(this,h);return{quotient:x[0],remainder:x[1]}},f.prototype.divmod=o.prototype.divmod=c.prototype.divmod,c.prototype.divide=function(h){return re(this,h)[0]},f.prototype.over=f.prototype.divide=function(h){return new f(this.value/ce(h).value)},o.prototype.over=o.prototype.divide=c.prototype.over=c.prototype.divide,c.prototype.mod=function(h){return re(this,h)[1]},f.prototype.mod=f.prototype.remainder=function(h){return new f(this.value%ce(h).value)},o.prototype.remainder=o.prototype.mod=c.prototype.remainder=c.prototype.mod,c.prototype.pow=function(h){var x=ce(h),I=this.value,O=x.value,G,M,K;if(O===0)return i[1];if(I===0)return i[0];if(I===1)return i[1];if(I===-1)return x.isEven()?i[1]:i[-1];if(x.sign)return i[0];if(!x.isSmall)throw new Error("The exponent "+x.toString()+" is too large.");if(this.isSmall&&p(G=Math.pow(I,O)))return new o(D(G));for(M=this,K=i[1];O&!0&&(K=K.times(M),--O),O!==0;)O/=2,M=M.square();return K},o.prototype.pow=c.prototype.pow,f.prototype.pow=function(h){var x=ce(h),I=this.value,O=x.value,G=BigInt(0),M=BigInt(1),K=BigInt(2);if(O===G)return i[1];if(I===G)return i[0];if(I===M)return i[1];if(I===BigInt(-1))return x.isEven()?i[1]:i[-1];if(x.isNegative())return new f(G);for(var $=this,ee=i[1];(O&M)===M&&(ee=ee.times($),--O),O!==G;)O/=K,$=$.square();return ee},c.prototype.modPow=function(h,x){if(h=ce(h),x=ce(x),x.isZero())throw new Error("Cannot take modPow with modulus 0");var I=i[1],O=this.mod(x);for(h.isNegative()&&(h=h.multiply(i[-1]),O=O.modInv(x));h.isPositive();){if(O.isZero())return i[0];h.isOdd()&&(I=I.multiply(O).mod(x)),h=h.divide(2),O=O.square().mod(x)}return I},f.prototype.modPow=o.prototype.modPow=c.prototype.modPow;function ue(h,x){if(h.length!==x.length)return h.length>x.length?1:-1;for(var I=h.length-1;I>=0;I--)if(h[I]!==x[I])return h[I]>x[I]?1:-1;return 0}c.prototype.compareAbs=function(h){var x=ce(h),I=this.value,O=x.value;return x.isSmall?1:ue(I,O)},o.prototype.compareAbs=function(h){var x=ce(h),I=Math.abs(this.value),O=x.value;return x.isSmall?(O=Math.abs(O),I===O?0:I>O?1:-1):-1},f.prototype.compareAbs=function(h){var x=this.value,I=ce(h).value;return x=x>=0?x:-x,I=I>=0?I:-I,x===I?0:x>I?1:-1},c.prototype.compare=function(h){if(h===1/0)return-1;if(h===-1/0)return 1;var x=ce(h),I=this.value,O=x.value;return this.sign!==x.sign?x.sign?1:-1:x.isSmall?this.sign?-1:1:ue(I,O)*(this.sign?-1:1)},c.prototype.compareTo=c.prototype.compare,o.prototype.compare=function(h){if(h===1/0)return-1;if(h===-1/0)return 1;var x=ce(h),I=this.value,O=x.value;return x.isSmall?I==O?0:I>O?1:-1:I<0!==x.sign?I<0?-1:1:I<0?1:-1},o.prototype.compareTo=o.prototype.compare,f.prototype.compare=function(h){if(h===1/0)return-1;if(h===-1/0)return 1;var x=this.value,I=ce(h).value;return x===I?0:x>I?1:-1},f.prototype.compareTo=f.prototype.compare,c.prototype.equals=function(h){return this.compare(h)===0},f.prototype.eq=f.prototype.equals=o.prototype.eq=o.prototype.equals=c.prototype.eq=c.prototype.equals,c.prototype.notEquals=function(h){return this.compare(h)!==0},f.prototype.neq=f.prototype.notEquals=o.prototype.neq=o.prototype.notEquals=c.prototype.neq=c.prototype.notEquals,c.prototype.greater=function(h){return this.compare(h)>0},f.prototype.gt=f.prototype.greater=o.prototype.gt=o.prototype.greater=c.prototype.gt=c.prototype.greater,c.prototype.lesser=function(h){return this.compare(h)<0},f.prototype.lt=f.prototype.lesser=o.prototype.lt=o.prototype.lesser=c.prototype.lt=c.prototype.lesser,c.prototype.greaterOrEquals=function(h){return this.compare(h)>=0},f.prototype.geq=f.prototype.greaterOrEquals=o.prototype.geq=o.prototype.greaterOrEquals=c.prototype.geq=c.prototype.greaterOrEquals,c.prototype.lesserOrEquals=function(h){return this.compare(h)<=0},f.prototype.leq=f.prototype.lesserOrEquals=o.prototype.leq=o.prototype.lesserOrEquals=c.prototype.leq=c.prototype.lesserOrEquals,c.prototype.isEven=function(){return(this.value[0]&1)===0},o.prototype.isEven=function(){return(this.value&1)===0},f.prototype.isEven=function(){return(this.value&BigInt(1))===BigInt(0)},c.prototype.isOdd=function(){return(this.value[0]&1)===1},o.prototype.isOdd=function(){return(this.value&1)===1},f.prototype.isOdd=function(){return(this.value&BigInt(1))===BigInt(1)},c.prototype.isPositive=function(){return!this.sign},o.prototype.isPositive=function(){return this.value>0},f.prototype.isPositive=o.prototype.isPositive,c.prototype.isNegative=function(){return this.sign},o.prototype.isNegative=function(){return this.value<0},f.prototype.isNegative=o.prototype.isNegative,c.prototype.isUnit=function(){return!1},o.prototype.isUnit=function(){return Math.abs(this.value)===1},f.prototype.isUnit=function(){return this.abs().value===BigInt(1)},c.prototype.isZero=function(){return!1},o.prototype.isZero=function(){return this.value===0},f.prototype.isZero=function(){return this.value===BigInt(0)},c.prototype.isDivisibleBy=function(h){var x=ce(h);return x.isZero()?!1:x.isUnit()?!0:x.compareAbs(2)===0?this.isEven():this.mod(x).isZero()},f.prototype.isDivisibleBy=o.prototype.isDivisibleBy=c.prototype.isDivisibleBy;function U(h){var x=h.abs();if(x.isUnit())return!1;if(x.equals(2)||x.equals(3)||x.equals(5))return!0;if(x.isEven()||x.isDivisibleBy(3)||x.isDivisibleBy(5))return!1;if(x.lesser(49))return!0}function W(h,x){for(var I=h.prev(),O=I,G=0,M,K,$,ee;O.isEven();)O=O.divide(2),G++;e:for($=0;$<x.length;$++)if(!h.lesser(x[$])&&(ee=Xe(x[$]).modPow(O,h),!(ee.isUnit()||ee.equals(I)))){for(M=G-1;M!=0;M--){if(ee=ee.square().mod(h),ee.isUnit())return!1;if(ee.equals(I))continue e}return!1}return!0}c.prototype.isPrime=function(h){var x=U(this);if(x!==e)return x;var I=this.abs(),O=I.bitLength();if(O<=64)return W(I,[2,3,5,7,11,13,17,19,23,29,31,37]);for(var G=Math.log(2)*O.toJSNumber(),M=Math.ceil(h===!0?2*Math.pow(G,2):G),K=[],$=0;$<M;$++)K.push(Xe($+2));return W(I,K)},f.prototype.isPrime=o.prototype.isPrime=c.prototype.isPrime,c.prototype.isProbablePrime=function(h,x){var I=U(this);if(I!==e)return I;for(var O=this.abs(),G=h===e?5:h,M=[],K=0;K<G;K++)M.push(Xe.randBetween(2,O.minus(2),x));return W(O,M)},f.prototype.isProbablePrime=o.prototype.isProbablePrime=c.prototype.isProbablePrime,c.prototype.modInv=function(h){for(var x=Xe.zero,I=Xe.one,O=ce(h),G=this.abs(),M,K,$;!G.isZero();)M=O.divide(G),K=x,$=O,x=I,O=G,I=K.subtract(M.multiply(I)),G=$.subtract(M.multiply(G));if(!O.isUnit())throw new Error(this.toString()+" and "+h.toString()+" are not co-prime");return x.compare(0)===-1&&(x=x.add(h)),this.isNegative()?x.negate():x},f.prototype.modInv=o.prototype.modInv=c.prototype.modInv,c.prototype.next=function(){var h=this.value;return this.sign?P(h,1,this.sign):new c(v(h,1),this.sign)},o.prototype.next=function(){var h=this.value;return h+1<u?new o(h+1):new c(a,!1)},f.prototype.next=function(){return new f(this.value+BigInt(1))},c.prototype.prev=function(){var h=this.value;return this.sign?new c(v(h,1),!0):P(h,1,this.sign)},o.prototype.prev=function(){var h=this.value;return h-1>-u?new o(h-1):new c(a,!0)},f.prototype.prev=function(){return new f(this.value-BigInt(1))};for(var Q=[1];2*Q[Q.length-1]<=t;)Q.push(2*Q[Q.length-1]);var V=Q.length,de=Q[V-1];function xe(h){return Math.abs(h)<=t}c.prototype.shiftLeft=function(h){var x=ce(h).toJSNumber();if(!xe(x))throw new Error(String(x)+" is too large for shifting.");if(x<0)return this.shiftRight(-x);var I=this;if(I.isZero())return I;for(;x>=V;)I=I.multiply(de),x-=V-1;return I.multiply(Q[x])},f.prototype.shiftLeft=o.prototype.shiftLeft=c.prototype.shiftLeft,c.prototype.shiftRight=function(h){var x,I=ce(h).toJSNumber();if(!xe(I))throw new Error(String(I)+" is too large for shifting.");if(I<0)return this.shiftLeft(-I);for(var O=this;I>=V;){if(O.isZero()||O.isNegative()&&O.isUnit())return O;x=re(O,de),O=x[1].isNegative()?x[0].prev():x[0],I-=V-1}return x=re(O,Q[I]),x[1].isNegative()?x[0].prev():x[0]},f.prototype.shiftRight=o.prototype.shiftRight=c.prototype.shiftRight;function Oe(h,x,I){x=ce(x);for(var O=h.isNegative(),G=x.isNegative(),M=O?h.not():h,K=G?x.not():x,$=0,ee=0,le=null,Ee=null,he=[];!M.isZero()||!K.isZero();)le=re(M,de),$=le[1].toJSNumber(),O&&($=de-1-$),Ee=re(K,de),ee=Ee[1].toJSNumber(),G&&(ee=de-1-ee),M=le[0],K=Ee[0],he.push(I($,ee));for(var ge=I(O?1:0,G?1:0)!==0?Xe(-1):Xe(0),bt=he.length-1;bt>=0;bt-=1)ge=ge.multiply(de).add(Xe(he[bt]));return ge}c.prototype.not=function(){return this.negate().prev()},f.prototype.not=o.prototype.not=c.prototype.not,c.prototype.and=function(h){return Oe(this,h,function(x,I){return x&I})},f.prototype.and=o.prototype.and=c.prototype.and,c.prototype.or=function(h){return Oe(this,h,function(x,I){return x|I})},f.prototype.or=o.prototype.or=c.prototype.or,c.prototype.xor=function(h){return Oe(this,h,function(x,I){return x^I})},f.prototype.xor=o.prototype.xor=c.prototype.xor;var fe=1<<30,dt=(t&-t)*(t&-t)|fe;function Re(h){var x=h.value,I=typeof x=="number"?x|fe:typeof x=="bigint"?x|BigInt(fe):x[0]+x[1]*t|dt;return I&-I}function ht(h,x){if(x.compareTo(h)<=0){var I=ht(h,x.square(x)),O=I.p,G=I.e,M=O.multiply(x);return M.compareTo(h)<=0?{p:M,e:G*2+1}:{p:O,e:G*2}}return{p:Xe(1),e:0}}c.prototype.bitLength=function(){var h=this;return h.compareTo(Xe(0))<0&&(h=h.negate().subtract(Xe(1))),h.compareTo(Xe(0))===0?Xe(0):Xe(ht(h,Xe(2)).e).add(Xe(1))},f.prototype.bitLength=o.prototype.bitLength=c.prototype.bitLength;function At(h,x){return h=ce(h),x=ce(x),h.greater(x)?h:x}function qe(h,x){return h=ce(h),x=ce(x),h.lesser(x)?h:x}function it(h,x){if(h=ce(h).abs(),x=ce(x).abs(),h.equals(x))return h;if(h.isZero())return x;if(x.isZero())return h;for(var I=i[1],O,G;h.isEven()&&x.isEven();)O=qe(Re(h),Re(x)),h=h.divide(O),x=x.divide(O),I=I.multiply(O);for(;h.isEven();)h=h.divide(Re(h));do{for(;x.isEven();)x=x.divide(Re(x));h.greater(x)&&(G=x,x=h,h=G),x=x.subtract(h)}while(!x.isZero());return I.isUnit()?h:h.multiply(I)}function Hu(h,x){return h=ce(h).abs(),x=ce(x).abs(),h.divide(it(h,x)).multiply(x)}function pu(h,x,I){h=ce(h),x=ce(x);var O=I||Math.random,G=qe(h,x),M=At(h,x),K=M.subtract(G).add(1);if(K.isSmall)return G.add(Math.floor(O()*K));for(var $=Ut(K,t).value,ee=[],le=!0,Ee=0;Ee<$.length;Ee++){var he=le?$[Ee]+(Ee+1<$.length?$[Ee+1]/t:0):t,ge=D(O()*he);ee.push(ge),ge<$[Ee]&&(le=!1)}return G.add(i.fromArray(ee,t,!1))}var Uu=function(h,x,I,O){I=I||n,h=String(h),O||(h=h.toLowerCase(),I=I.toLowerCase());var G=h.length,M,K=Math.abs(x),$={};for(M=0;M<I.length;M++)$[I[M]]=M;for(M=0;M<G;M++){var ee=h[M];if(ee!=="-"&&ee in $&&$[ee]>=K){if(ee==="1"&&K===1)continue;throw new Error(ee+" is not a valid digit in base "+x+".")}}x=ce(x);var le=[],Ee=h[0]==="-";for(M=Ee?1:0;M<h.length;M++){var ee=h[M];if(ee in $)le.push(ce($[ee]));else if(ee==="<"){var he=M;do M++;while(h[M]!==">"&&M<h.length);le.push(ce(h.slice(he+1,M)))}else throw new Error(ee+" is not a valid character")}return kr(le,x,Ee)};function kr(h,x,I){var O=i[0],G=i[1],M;for(M=h.length-1;M>=0;M--)O=O.add(h[M].times(G)),G=G.times(x);return I?O.negate():O}function P0(h,x){return x=x||n,h<x.length?x[h]:"<"+h+">"}function Ut(h,x){if(x=Xe(x),x.isZero()){if(h.isZero())return{value:[0],isNegative:!1};throw new Error("Cannot convert nonzero numbers to base 0.")}if(x.equals(-1)){if(h.isZero())return{value:[0],isNegative:!1};if(h.isNegative())return{value:[].concat.apply([],Array.apply(null,Array(-h.toJSNumber())).map(Array.prototype.valueOf,[1,0])),isNegative:!1};var I=Array.apply(null,Array(h.toJSNumber()-1)).map(Array.prototype.valueOf,[0,1]);return I.unshift([1]),{value:[].concat.apply([],I),isNegative:!1}}var O=!1;if(h.isNegative()&&x.isPositive()&&(O=!0,h=h.abs()),x.isUnit())return h.isZero()?{value:[0],isNegative:!1}:{value:Array.apply(null,Array(h.toJSNumber())).map(Number.prototype.valueOf,1),isNegative:O};for(var G=[],M=h,K;M.isNegative()||M.compareAbs(x)>=0;){K=M.divmod(x),M=K.quotient;var $=K.remainder;$.isNegative()&&($=x.minus($).abs(),M=M.next()),G.push($.toJSNumber())}return G.push(M.toJSNumber()),{value:G.reverse(),isNegative:O}}function mt(h,x,I){var O=Ut(h,x);return(O.isNegative?"-":"")+O.value.map(function(G){return P0(G,I)}).join("")}c.prototype.toArray=function(h){return Ut(this,h)},o.prototype.toArray=function(h){return Ut(this,h)},f.prototype.toArray=function(h){return Ut(this,h)},c.prototype.toString=function(h,x){if(h===e&&(h=10),h!==10||x)return mt(this,h,x);for(var I=this.value,O=I.length,G=String(I[--O]),M="0000000",K;--O>=0;)K=String(I[O]),G+=M.slice(K.length)+K;var $=this.sign?"-":"";return $+G},o.prototype.toString=function(h,x){return h===e&&(h=10),h!=10||x?mt(this,h,x):String(this.value)},f.prototype.toString=o.prototype.toString,f.prototype.toJSON=c.prototype.toJSON=o.prototype.toJSON=function(){return this.toString()},c.prototype.valueOf=function(){return parseInt(this.toString(),10)},c.prototype.toJSNumber=c.prototype.valueOf,o.prototype.valueOf=function(){return this.value},o.prototype.toJSNumber=o.prototype.valueOf,f.prototype.valueOf=f.prototype.toJSNumber=function(){return parseInt(this.toString(),10)};function pt(h){if(p(+h)){var x=+h;if(x===D(x))return s?new f(BigInt(x)):new o(x);throw new Error("Invalid integer: "+h)}var I=h[0]==="-";I&&(h=h.slice(1));var O=h.split(/e/i);if(O.length>2)throw new Error("Invalid integer: "+O.join("e"));if(O.length===2){var G=O[1];if(G[0]==="+"&&(G=G.slice(1)),G=+G,G!==D(G)||!p(G))throw new Error("Invalid integer: "+G+" is not a valid exponent.");var M=O[0],K=M.indexOf(".");if(K>=0&&(G-=M.length-K-1,M=M.slice(0,K)+M.slice(K+1)),G<0)throw new Error("Cannot include negative exponent part for integers");M+=new Array(G+1).join("0"),h=M}var $=/^([0-9][0-9]*)$/.test(h);if(!$)throw new Error("Invalid integer: "+h);if(s)return new f(BigInt(I?"-"+h:h));for(var ee=[],le=h.length,Ee=r,he=le-Ee;le>0;)ee.push(+h.slice(he,le)),he-=Ee,he<0&&(he=0),le-=Ee;return _(ee),new c(ee,I)}function tr(h){if(s)return new f(BigInt(h));if(p(h)){if(h!==D(h))throw new Error(h+" is not an integer.");return new o(h)}return pt(h.toString())}function ce(h){return typeof h=="number"?tr(h):typeof h=="string"?pt(h):typeof h=="bigint"?new f(h):h}for(var rr=0;rr<1e3;rr++)i[rr]=ce(rr),rr>0&&(i[-rr]=ce(-rr));return i.one=i[1],i.zero=i[0],i.minusOne=i[-1],i.max=At,i.min=qe,i.gcd=it,i.lcm=Hu,i.isInstance=function(h){return h instanceof c||h instanceof o||h instanceof f},i.randBetween=pu,i.fromArray=function(h,x,I){return kr(h.map(ce),ce(x||10),I)},i}();typeof Li!="undefined"&&Li.hasOwnProperty("exports")&&(Li.exports=Xe);typeof define=="function"&&define.amd&&define(function(){return Xe})});var jb=R((cI,y0)=>{"use strict";function v0(e){let t=e.length;for(;--t>=0;)e[t]=0}var kv=0,Sb=1,Hv=2,Uv=3,Gv=258,Ec=29,Ca=256,ga=Ca+1+Ec,g0=30,Tc=19,Nb=2*ga+1,Bu=15,lc=16,qv=7,xc=256,Ob=16,Rb=17,Pb=18,bc=new Uint8Array([0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0]),Mi=new Uint8Array([0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13]),jv=new Uint8Array([0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,3,7]),Bb=new Uint8Array([16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15]),zv=512,Lr=new Array((ga+2)*2);v0(Lr);var ma=new Array(g0*2);v0(ma);var va=new Array(zv);v0(va);var ya=new Array(Gv-Uv+1);v0(ya);var Ac=new Array(Ec);v0(Ac);var Fi=new Array(g0);v0(Fi);function dc(e,t,r,u,a){this.static_tree=e,this.extra_bits=t,this.extra_base=r,this.elems=u,this.max_length=a,this.has_stree=e&&e.length}var wb,Lb,Mb;function hc(e,t){this.dyn_tree=e,this.max_code=0,this.stat_desc=t}var Fb=e=>e<256?va[e]:va[256+(e>>>7)],Da=(e,t)=>{e.pending_buf[e.pending++]=t&255,e.pending_buf[e.pending++]=t>>>8&255},It=(e,t,r)=>{e.bi_valid>lc-r?(e.bi_buf|=t<<e.bi_valid&65535,Da(e,e.bi_buf),e.bi_buf=t>>lc-e.bi_valid,e.bi_valid+=r-lc):(e.bi_buf|=t<<e.bi_valid&65535,e.bi_valid+=r)},Tr=(e,t,r)=>{It(e,r[t*2],r[t*2+1])},kb=(e,t)=>{let r=0;do r|=e&1,e>>>=1,r<<=1;while(--t>0);return r>>>1},Yv=e=>{e.bi_valid===16?(Da(e,e.bi_buf),e.bi_buf=0,e.bi_valid=0):e.bi_valid>=8&&(e.pending_buf[e.pending++]=e.bi_buf&255,e.bi_buf>>=8,e.bi_valid-=8)},Wv=(e,t)=>{let r=t.dyn_tree,u=t.max_code,a=t.stat_desc.static_tree,n=t.stat_desc.has_stree,s=t.stat_desc.extra_bits,i=t.stat_desc.extra_base,c=t.stat_desc.max_length,o,f,p,d,b,_,C=0;for(d=0;d<=Bu;d++)e.bl_count[d]=0;for(r[e.heap[e.heap_max]*2+1]=0,o=e.heap_max+1;o<Nb;o++)f=e.heap[o],d=r[r[f*2+1]*2+1]+1,d>c&&(d=c,C++),r[f*2+1]=d,!(f>u)&&(e.bl_count[d]++,b=0,f>=i&&(b=s[f-i]),_=r[f*2],e.opt_len+=_*(d+b),n&&(e.static_len+=_*(a[f*2+1]+b)));if(C!==0){do{for(d=c-1;e.bl_count[d]===0;)d--;e.bl_count[d]--,e.bl_count[d+1]+=2,e.bl_count[c]--,C-=2}while(C>0);for(d=c;d!==0;d--)for(f=e.bl_count[d];f!==0;)p=e.heap[--o],!(p>u)&&(r[p*2+1]!==d&&(e.opt_len+=(d-r[p*2+1])*r[p*2],r[p*2+1]=d),f--)}},Hb=(e,t,r)=>{let u=new Array(Bu+1),a=0,n,s;for(n=1;n<=Bu;n++)a=a+r[n-1]<<1,u[n]=a;for(s=0;s<=t;s++){let i=e[s*2+1];i!==0&&(e[s*2]=kb(u[i]++,i))}},Vv=()=>{let e,t,r,u,a,n=new Array(Bu+1);for(r=0,u=0;u<Ec-1;u++)for(Ac[u]=r,e=0;e<1<<bc[u];e++)ya[r++]=u;for(ya[r-1]=u,a=0,u=0;u<16;u++)for(Fi[u]=a,e=0;e<1<<Mi[u];e++)va[a++]=u;for(a>>=7;u<g0;u++)for(Fi[u]=a<<7,e=0;e<1<<Mi[u]-7;e++)va[256+a++]=u;for(t=0;t<=Bu;t++)n[t]=0;for(e=0;e<=143;)Lr[e*2+1]=8,e++,n[8]++;for(;e<=255;)Lr[e*2+1]=9,e++,n[9]++;for(;e<=279;)Lr[e*2+1]=7,e++,n[7]++;for(;e<=287;)Lr[e*2+1]=8,e++,n[8]++;for(Hb(Lr,ga+1,n),e=0;e<g0;e++)ma[e*2+1]=5,ma[e*2]=kb(e,5);wb=new dc(Lr,bc,Ca+1,ga,Bu),Lb=new dc(ma,Mi,0,g0,Bu),Mb=new dc(new Array(0),jv,0,Tc,qv)},Ub=e=>{let t;for(t=0;t<ga;t++)e.dyn_ltree[t*2]=0;for(t=0;t<g0;t++)e.dyn_dtree[t*2]=0;for(t=0;t<Tc;t++)e.bl_tree[t*2]=0;e.dyn_ltree[xc*2]=1,e.opt_len=e.static_len=0,e.sym_next=e.matches=0},Gb=e=>{e.bi_valid>8?Da(e,e.bi_buf):e.bi_valid>0&&(e.pending_buf[e.pending++]=e.bi_buf),e.bi_buf=0,e.bi_valid=0},vb=(e,t,r,u)=>{let a=t*2,n=r*2;return e[a]<e[n]||e[a]===e[n]&&u[t]<=u[r]},pc=(e,t,r)=>{let u=e.heap[r],a=r<<1;for(;a<=e.heap_len&&(a<e.heap_len&&vb(t,e.heap[a+1],e.heap[a],e.depth)&&a++,!vb(t,u,e.heap[a],e.depth));)e.heap[r]=e.heap[a],r=a,a<<=1;e.heap[r]=u},yb=(e,t,r)=>{let u,a,n=0,s,i;if(e.sym_next!==0)do u=e.pending_buf[e.sym_buf+n++]&255,u+=(e.pending_buf[e.sym_buf+n++]&255)<<8,a=e.pending_buf[e.sym_buf+n++],u===0?Tr(e,a,t):(s=ya[a],Tr(e,s+Ca+1,t),i=bc[s],i!==0&&(a-=Ac[s],It(e,a,i)),u--,s=Fb(u),Tr(e,s,r),i=Mi[s],i!==0&&(u-=Fi[s],It(e,u,i)));while(n<e.sym_next);Tr(e,xc,t)},_c=(e,t)=>{let r=t.dyn_tree,u=t.stat_desc.static_tree,a=t.stat_desc.has_stree,n=t.stat_desc.elems,s,i,c=-1,o;for(e.heap_len=0,e.heap_max=Nb,s=0;s<n;s++)r[s*2]!==0?(e.heap[++e.heap_len]=c=s,e.depth[s]=0):r[s*2+1]=0;for(;e.heap_len<2;)o=e.heap[++e.heap_len]=c<2?++c:0,r[o*2]=1,e.depth[o]=0,e.opt_len--,a&&(e.static_len-=u[o*2+1]);for(t.max_code=c,s=e.heap_len>>1;s>=1;s--)pc(e,r,s);o=n;do s=e.heap[1],e.heap[1]=e.heap[e.heap_len--],pc(e,r,1),i=e.heap[1],e.heap[--e.heap_max]=s,e.heap[--e.heap_max]=i,r[o*2]=r[s*2]+r[i*2],e.depth[o]=(e.depth[s]>=e.depth[i]?e.depth[s]:e.depth[i])+1,r[s*2+1]=r[i*2+1]=o,e.heap[1]=o++,pc(e,r,1);while(e.heap_len>=2);e.heap[--e.heap_max]=e.heap[1],Wv(e,t),Hb(r,c,e.bl_count)},Db=(e,t,r)=>{let u,a=-1,n,s=t[0*2+1],i=0,c=7,o=4;for(s===0&&(c=138,o=3),t[(r+1)*2+1]=65535,u=0;u<=r;u++)n=s,s=t[(u+1)*2+1],!(++i<c&&n===s)&&(i<o?e.bl_tree[n*2]+=i:n!==0?(n!==a&&e.bl_tree[n*2]++,e.bl_tree[Ob*2]++):i<=10?e.bl_tree[Rb*2]++:e.bl_tree[Pb*2]++,i=0,a=n,s===0?(c=138,o=3):n===s?(c=6,o=3):(c=7,o=4))},Cb=(e,t,r)=>{let u,a=-1,n,s=t[0*2+1],i=0,c=7,o=4;for(s===0&&(c=138,o=3),u=0;u<=r;u++)if(n=s,s=t[(u+1)*2+1],!(++i<c&&n===s)){if(i<o)do Tr(e,n,e.bl_tree);while(--i!==0);else n!==0?(n!==a&&(Tr(e,n,e.bl_tree),i--),Tr(e,Ob,e.bl_tree),It(e,i-3,2)):i<=10?(Tr(e,Rb,e.bl_tree),It(e,i-3,3)):(Tr(e,Pb,e.bl_tree),It(e,i-11,7));i=0,a=n,s===0?(c=138,o=3):n===s?(c=6,o=3):(c=7,o=4)}},Qv=e=>{let t;for(Db(e,e.dyn_ltree,e.l_desc.max_code),Db(e,e.dyn_dtree,e.d_desc.max_code),_c(e,e.bl_desc),t=Tc-1;t>=3&&e.bl_tree[Bb[t]*2+1]===0;t--);return e.opt_len+=3*(t+1)+5+5+4,t},Xv=(e,t,r,u)=>{let a;for(It(e,t-257,5),It(e,r-1,5),It(e,u-4,4),a=0;a<u;a++)It(e,e.bl_tree[Bb[a]*2+1],3);Cb(e,e.dyn_ltree,t-1),Cb(e,e.dyn_dtree,r-1)},Kv=e=>{let t=4093624447,r;for(r=0;r<=31;r++,t>>>=1)if(t&1&&e.dyn_ltree[r*2]!==0)return 0;if(e.dyn_ltree[9*2]!==0||e.dyn_ltree[10*2]!==0||e.dyn_ltree[13*2]!==0)return 1;for(r=32;r<Ca;r++)if(e.dyn_ltree[r*2]!==0)return 1;return 0},Ib=!1,$v=e=>{Ib||(Vv(),Ib=!0),e.l_desc=new hc(e.dyn_ltree,wb),e.d_desc=new hc(e.dyn_dtree,Lb),e.bl_desc=new hc(e.bl_tree,Mb),e.bi_buf=0,e.bi_valid=0,Ub(e)},qb=(e,t,r,u)=>{It(e,(kv<<1)+(u?1:0),3),Gb(e),Da(e,r),Da(e,~r),r&&e.pending_buf.set(e.window.subarray(t,t+r),e.pending),e.pending+=r},Zv=e=>{It(e,Sb<<1,3),Tr(e,xc,Lr),Yv(e)},Jv=(e,t,r,u)=>{let a,n,s=0;e.level>0?(e.strm.data_type===2&&(e.strm.data_type=Kv(e)),_c(e,e.l_desc),_c(e,e.d_desc),s=Qv(e),a=e.opt_len+3+7>>>3,n=e.static_len+3+7>>>3,n<=a&&(a=n)):a=n=r+5,r+4<=a&&t!==-1?qb(e,t,r,u):e.strategy===4||n===a?(It(e,(Sb<<1)+(u?1:0),3),yb(e,Lr,ma)):(It(e,(Hv<<1)+(u?1:0),3),Xv(e,e.l_desc.max_code+1,e.d_desc.max_code+1,s+1),yb(e,e.dyn_ltree,e.dyn_dtree)),Ub(e),u&&Gb(e)},e5=(e,t,r)=>(e.pending_buf[e.sym_buf+e.sym_next++]=t,e.pending_buf[e.sym_buf+e.sym_next++]=t>>8,e.pending_buf[e.sym_buf+e.sym_next++]=r,t===0?e.dyn_ltree[r*2]++:(e.matches++,t--,e.dyn_ltree[(ya[r]+Ca+1)*2]++,e.dyn_dtree[Fb(t)*2]++),e.sym_next===e.sym_end);y0.exports._tr_init=$v;y0.exports._tr_stored_block=qb;y0.exports._tr_flush_block=Jv;y0.exports._tr_tally=e5;y0.exports._tr_align=Zv});var mc=R((fI,zb)=>{"use strict";var t5=(e,t,r,u)=>{let a=e&65535|0,n=e>>>16&65535|0,s=0;for(;r!==0;){s=r>2e3?2e3:r,r-=s;do a=a+t[u++]|0,n=n+a|0;while(--s);a%=65521,n%=65521}return a|n<<16|0};zb.exports=t5});var gc=R((lI,Yb)=>{"use strict";var r5=()=>{let e,t=[];for(var r=0;r<256;r++){e=r;for(var u=0;u<8;u++)e=e&1?3988292384^e>>>1:e>>>1;t[r]=e}return t},u5=new Uint32Array(r5()),a5=(e,t,r,u)=>{let a=u5,n=u+r;e^=-1;for(let s=u;s<n;s++)e=e>>>8^a[(e^t[s])&255];return e^-1};Yb.exports=a5});var ki=R((dI,Wb)=>{"use strict";Wb.exports={2:"need dictionary",1:"stream end",0:"","-1":"file error","-2":"stream error","-3":"data error","-4":"insufficient memory","-5":"buffer error","-6":"incompatible version"}});var su=R((hI,Vb)=>{"use strict";Vb.exports={Z_NO_FLUSH:0,Z_PARTIAL_FLUSH:1,Z_SYNC_FLUSH:2,Z_FULL_FLUSH:3,Z_FINISH:4,Z_BLOCK:5,Z_TREES:6,Z_OK:0,Z_STREAM_END:1,Z_NEED_DICT:2,Z_ERRNO:-1,Z_STREAM_ERROR:-2,Z_DATA_ERROR:-3,Z_MEM_ERROR:-4,Z_BUF_ERROR:-5,Z_NO_COMPRESSION:0,Z_BEST_SPEED:1,Z_BEST_COMPRESSION:9,Z_DEFAULT_COMPRESSION:-1,Z_FILTERED:1,Z_HUFFMAN_ONLY:2,Z_RLE:3,Z_FIXED:4,Z_DEFAULT_STRATEGY:0,Z_BINARY:0,Z_TEXT:1,Z_UNKNOWN:2,Z_DEFLATED:8}});var u_=R((pI,gr)=>{"use strict";var{_tr_init:n5,_tr_stored_block:Dc,_tr_flush_block:i5,_tr_tally:lu,_tr_align:s5}=jb(),$b=mc(),ou=gc(),o5=ki(),{Z_NO_FLUSH:du,Z_PARTIAL_FLUSH:c5,Z_FULL_FLUSH:f5,Z_FINISH:kt,Z_BLOCK:Qb,Z_OK:nt,Z_STREAM_END:Xb,Z_STREAM_ERROR:Ar,Z_DATA_ERROR:l5,Z_BUF_ERROR:vc,Z_DEFAULT_COMPRESSION:d5,Z_FILTERED:h5,Z_HUFFMAN_ONLY:Hi,Z_RLE:p5,Z_FIXED:b5,Z_DEFAULT_STRATEGY:_5,Z_UNKNOWN:E5,Z_DEFLATED:Ui}=su(),T5=9,x5=15,A5=8,m5=29,g5=256,Cc=g5+1+m5,v5=30,y5=19,D5=2*Cc+1,C5=15,me=3,fu=258,mr=fu+me+1,I5=32,C0=42,Pc=57,Ic=69,Sc=73,Nc=91,Oc=103,wu=113,Sa=666,xt=1,S0=2,Mu=3,N0=4,S5=3,Lu=(e,t)=>(e.msg=o5[t],t),Kb=e=>e*2-(e>4?9:0),cu=e=>{let t=e.length;for(;--t>=0;)e[t]=0},N5=e=>{let t,r,u,a=e.w_size;t=e.hash_size,u=t;do r=e.head[--u],e.head[u]=r>=a?r-a:0;while(--t);t=a,u=t;do r=e.prev[--u],e.prev[u]=r>=a?r-a:0;while(--t)},O5=(e,t,r)=>(t<<e.hash_shift^r)&e.hash_mask,hu=O5,Mt=e=>{let t=e.state,r=t.pending;r>e.avail_out&&(r=e.avail_out),r!==0&&(e.output.set(t.pending_buf.subarray(t.pending_out,t.pending_out+r),e.next_out),e.next_out+=r,t.pending_out+=r,e.total_out+=r,e.avail_out-=r,t.pending-=r,t.pending===0&&(t.pending_out=0))},Ft=(e,t)=>{i5(e,e.block_start>=0?e.block_start:-1,e.strstart-e.block_start,t),e.block_start=e.strstart,Mt(e.strm)},Ie=(e,t)=>{e.pending_buf[e.pending++]=t},Ia=(e,t)=>{e.pending_buf[e.pending++]=t>>>8&255,e.pending_buf[e.pending++]=t&255},Rc=(e,t,r,u)=>{let a=e.avail_in;return a>u&&(a=u),a===0?0:(e.avail_in-=a,t.set(e.input.subarray(e.next_in,e.next_in+a),r),e.state.wrap===1?e.adler=$b(e.adler,t,a,r):e.state.wrap===2&&(e.adler=ou(e.adler,t,a,r)),e.next_in+=a,e.total_in+=a,a)},Zb=(e,t)=>{let r=e.max_chain_length,u=e.strstart,a,n,s=e.prev_length,i=e.nice_match,c=e.strstart>e.w_size-mr?e.strstart-(e.w_size-mr):0,o=e.window,f=e.w_mask,p=e.prev,d=e.strstart+fu,b=o[u+s-1],_=o[u+s];e.prev_length>=e.good_match&&(r>>=2),i>e.lookahead&&(i=e.lookahead);do if(a=t,!(o[a+s]!==_||o[a+s-1]!==b||o[a]!==o[u]||o[++a]!==o[u+1])){u+=2,a++;do;while(o[++u]===o[++a]&&o[++u]===o[++a]&&o[++u]===o[++a]&&o[++u]===o[++a]&&o[++u]===o[++a]&&o[++u]===o[++a]&&o[++u]===o[++a]&&o[++u]===o[++a]&&u<d);if(n=fu-(d-u),u=d-fu,n>s){if(e.match_start=t,s=n,n>=i)break;b=o[u+s-1],_=o[u+s]}}while((t=p[t&f])>c&&--r!==0);return s<=e.lookahead?s:e.lookahead},I0=e=>{let t=e.w_size,r,u,a;do{if(u=e.window_size-e.lookahead-e.strstart,e.strstart>=t+(t-mr)&&(e.window.set(e.window.subarray(t,t+t-u),0),e.match_start-=t,e.strstart-=t,e.block_start-=t,e.insert>e.strstart&&(e.insert=e.strstart),N5(e),u+=t),e.strm.avail_in===0)break;if(r=Rc(e.strm,e.window,e.strstart+e.lookahead,u),e.lookahead+=r,e.lookahead+e.insert>=me)for(a=e.strstart-e.insert,e.ins_h=e.window[a],e.ins_h=hu(e,e.ins_h,e.window[a+1]);e.insert&&(e.ins_h=hu(e,e.ins_h,e.window[a+me-1]),e.prev[a&e.w_mask]=e.head[e.ins_h],e.head[e.ins_h]=a,a++,e.insert--,!(e.lookahead+e.insert<me)););}while(e.lookahead<mr&&e.strm.avail_in!==0)},Jb=(e,t)=>{let r=e.pending_buf_size-5>e.w_size?e.w_size:e.pending_buf_size-5,u,a,n,s=0,i=e.strm.avail_in;do{if(u=65535,n=e.bi_valid+42>>3,e.strm.avail_out<n||(n=e.strm.avail_out-n,a=e.strstart-e.block_start,u>a+e.strm.avail_in&&(u=a+e.strm.avail_in),u>n&&(u=n),u<r&&(u===0&&t!==kt||t===du||u!==a+e.strm.avail_in)))break;s=t===kt&&u===a+e.strm.avail_in?1:0,Dc(e,0,0,s),e.pending_buf[e.pending-4]=u,e.pending_buf[e.pending-3]=u>>8,e.pending_buf[e.pending-2]=~u,e.pending_buf[e.pending-1]=~u>>8,Mt(e.strm),a&&(a>u&&(a=u),e.strm.output.set(e.window.subarray(e.block_start,e.block_start+a),e.strm.next_out),e.strm.next_out+=a,e.strm.avail_out-=a,e.strm.total_out+=a,e.block_start+=a,u-=a),u&&(Rc(e.strm,e.strm.output,e.strm.next_out,u),e.strm.next_out+=u,e.strm.avail_out-=u,e.strm.total_out+=u)}while(s===0);return i-=e.strm.avail_in,i&&(i>=e.w_size?(e.matches=2,e.window.set(e.strm.input.subarray(e.strm.next_in-e.w_size,e.strm.next_in),0),e.strstart=e.w_size,e.insert=e.strstart):(e.window_size-e.strstart<=i&&(e.strstart-=e.w_size,e.window.set(e.window.subarray(e.w_size,e.w_size+e.strstart),0),e.matches<2&&e.matches++,e.insert>e.strstart&&(e.insert=e.strstart)),e.window.set(e.strm.input.subarray(e.strm.next_in-i,e.strm.next_in),e.strstart),e.strstart+=i,e.insert+=i>e.w_size-e.insert?e.w_size-e.insert:i),e.block_start=e.strstart),e.high_water<e.strstart&&(e.high_water=e.strstart),s?N0:t!==du&&t!==kt&&e.strm.avail_in===0&&e.strstart===e.block_start?S0:(n=e.window_size-e.strstart,e.strm.avail_in>n&&e.block_start>=e.w_size&&(e.block_start-=e.w_size,e.strstart-=e.w_size,e.window.set(e.window.subarray(e.w_size,e.w_size+e.strstart),0),e.matches<2&&e.matches++,n+=e.w_size,e.insert>e.strstart&&(e.insert=e.strstart)),n>e.strm.avail_in&&(n=e.strm.avail_in),n&&(Rc(e.strm,e.window,e.strstart,n),e.strstart+=n,e.insert+=n>e.w_size-e.insert?e.w_size-e.insert:n),e.high_water<e.strstart&&(e.high_water=e.strstart),n=e.bi_valid+42>>3,n=e.pending_buf_size-n>65535?65535:e.pending_buf_size-n,r=n>e.w_size?e.w_size:n,a=e.strstart-e.block_start,(a>=r||(a||t===kt)&&t!==du&&e.strm.avail_in===0&&a<=n)&&(u=a>n?n:a,s=t===kt&&e.strm.avail_in===0&&u===a?1:0,Dc(e,e.block_start,u,s),e.block_start+=u,Mt(e.strm)),s?Mu:xt)},yc=(e,t)=>{let r,u;for(;;){if(e.lookahead<mr){if(I0(e),e.lookahead<mr&&t===du)return xt;if(e.lookahead===0)break}if(r=0,e.lookahead>=me&&(e.ins_h=hu(e,e.ins_h,e.window[e.strstart+me-1]),r=e.prev[e.strstart&e.w_mask]=e.head[e.ins_h],e.head[e.ins_h]=e.strstart),r!==0&&e.strstart-r<=e.w_size-mr&&(e.match_length=Zb(e,r)),e.match_length>=me)if(u=lu(e,e.strstart-e.match_start,e.match_length-me),e.lookahead-=e.match_length,e.match_length<=e.max_lazy_match&&e.lookahead>=me){e.match_length--;do e.strstart++,e.ins_h=hu(e,e.ins_h,e.window[e.strstart+me-1]),r=e.prev[e.strstart&e.w_mask]=e.head[e.ins_h],e.head[e.ins_h]=e.strstart;while(--e.match_length!==0);e.strstart++}else e.strstart+=e.match_length,e.match_length=0,e.ins_h=e.window[e.strstart],e.ins_h=hu(e,e.ins_h,e.window[e.strstart+1]);else u=lu(e,0,e.window[e.strstart]),e.lookahead--,e.strstart++;if(u&&(Ft(e,!1),e.strm.avail_out===0))return xt}return e.insert=e.strstart<me-1?e.strstart:me-1,t===kt?(Ft(e,!0),e.strm.avail_out===0?Mu:N0):e.sym_next&&(Ft(e,!1),e.strm.avail_out===0)?xt:S0},D0=(e,t)=>{let r,u,a;for(;;){if(e.lookahead<mr){if(I0(e),e.lookahead<mr&&t===du)return xt;if(e.lookahead===0)break}if(r=0,e.lookahead>=me&&(e.ins_h=hu(e,e.ins_h,e.window[e.strstart+me-1]),r=e.prev[e.strstart&e.w_mask]=e.head[e.ins_h],e.head[e.ins_h]=e.strstart),e.prev_length=e.match_length,e.prev_match=e.match_start,e.match_length=me-1,r!==0&&e.prev_length<e.max_lazy_match&&e.strstart-r<=e.w_size-mr&&(e.match_length=Zb(e,r),e.match_length<=5&&(e.strategy===h5||e.match_length===me&&e.strstart-e.match_start>4096)&&(e.match_length=me-1)),e.prev_length>=me&&e.match_length<=e.prev_length){a=e.strstart+e.lookahead-me,u=lu(e,e.strstart-1-e.prev_match,e.prev_length-me),e.lookahead-=e.prev_length-1,e.prev_length-=2;do++e.strstart<=a&&(e.ins_h=hu(e,e.ins_h,e.window[e.strstart+me-1]),r=e.prev[e.strstart&e.w_mask]=e.head[e.ins_h],e.head[e.ins_h]=e.strstart);while(--e.prev_length!==0);if(e.match_available=0,e.match_length=me-1,e.strstart++,u&&(Ft(e,!1),e.strm.avail_out===0))return xt}else if(e.match_available){if(u=lu(e,0,e.window[e.strstart-1]),u&&Ft(e,!1),e.strstart++,e.lookahead--,e.strm.avail_out===0)return xt}else e.match_available=1,e.strstart++,e.lookahead--}return e.match_available&&(u=lu(e,0,e.window[e.strstart-1]),e.match_available=0),e.insert=e.strstart<me-1?e.strstart:me-1,t===kt?(Ft(e,!0),e.strm.avail_out===0?Mu:N0):e.sym_next&&(Ft(e,!1),e.strm.avail_out===0)?xt:S0},R5=(e,t)=>{let r,u,a,n,s=e.window;for(;;){if(e.lookahead<=fu){if(I0(e),e.lookahead<=fu&&t===du)return xt;if(e.lookahead===0)break}if(e.match_length=0,e.lookahead>=me&&e.strstart>0&&(a=e.strstart-1,u=s[a],u===s[++a]&&u===s[++a]&&u===s[++a])){n=e.strstart+fu;do;while(u===s[++a]&&u===s[++a]&&u===s[++a]&&u===s[++a]&&u===s[++a]&&u===s[++a]&&u===s[++a]&&u===s[++a]&&a<n);e.match_length=fu-(n-a),e.match_length>e.lookahead&&(e.match_length=e.lookahead)}if(e.match_length>=me?(r=lu(e,1,e.match_length-me),e.lookahead-=e.match_length,e.strstart+=e.match_length,e.match_length=0):(r=lu(e,0,e.window[e.strstart]),e.lookahead--,e.strstart++),r&&(Ft(e,!1),e.strm.avail_out===0))return xt}return e.insert=0,t===kt?(Ft(e,!0),e.strm.avail_out===0?Mu:N0):e.sym_next&&(Ft(e,!1),e.strm.avail_out===0)?xt:S0},P5=(e,t)=>{let r;for(;;){if(e.lookahead===0&&(I0(e),e.lookahead===0)){if(t===du)return xt;break}if(e.match_length=0,r=lu(e,0,e.window[e.strstart]),e.lookahead--,e.strstart++,r&&(Ft(e,!1),e.strm.avail_out===0))return xt}return e.insert=0,t===kt?(Ft(e,!0),e.strm.avail_out===0?Mu:N0):e.sym_next&&(Ft(e,!1),e.strm.avail_out===0)?xt:S0};function xr(e,t,r,u,a){this.good_length=e,this.max_lazy=t,this.nice_length=r,this.max_chain=u,this.func=a}var Na=[new xr(0,0,0,0,Jb),new xr(4,4,8,4,yc),new xr(4,5,16,8,yc),new xr(4,6,32,32,yc),new xr(4,4,16,16,D0),new xr(8,16,32,32,D0),new xr(8,16,128,128,D0),new xr(8,32,128,256,D0),new xr(32,128,258,1024,D0),new xr(32,258,258,4096,D0)],B5=e=>{e.window_size=2*e.w_size,cu(e.head),e.max_lazy_match=Na[e.level].max_lazy,e.good_match=Na[e.level].good_length,e.nice_match=Na[e.level].nice_length,e.max_chain_length=Na[e.level].max_chain,e.strstart=0,e.block_start=0,e.lookahead=0,e.insert=0,e.match_length=e.prev_length=me-1,e.match_available=0,e.ins_h=0};function w5(){this.strm=null,this.status=0,this.pending_buf=null,this.pending_buf_size=0,this.pending_out=0,this.pending=0,this.wrap=0,this.gzhead=null,this.gzindex=0,this.method=Ui,this.last_flush=-1,this.w_size=0,this.w_bits=0,this.w_mask=0,this.window=null,this.window_size=0,this.prev=null,this.head=null,this.ins_h=0,this.hash_size=0,this.hash_bits=0,this.hash_mask=0,this.hash_shift=0,this.block_start=0,this.match_length=0,this.prev_match=0,this.match_available=0,this.strstart=0,this.match_start=0,this.lookahead=0,this.prev_length=0,this.max_chain_length=0,this.max_lazy_match=0,this.level=0,this.strategy=0,this.good_match=0,this.nice_match=0,this.dyn_ltree=new Uint16Array(D5*2),this.dyn_dtree=new Uint16Array((2*v5+1)*2),this.bl_tree=new Uint16Array((2*y5+1)*2),cu(this.dyn_ltree),cu(this.dyn_dtree),cu(this.bl_tree),this.l_desc=null,this.d_desc=null,this.bl_desc=null,this.bl_count=new Uint16Array(C5+1),this.heap=new Uint16Array(2*Cc+1),cu(this.heap),this.heap_len=0,this.heap_max=0,this.depth=new Uint16Array(2*Cc+1),cu(this.depth),this.sym_buf=0,this.lit_bufsize=0,this.sym_next=0,this.sym_end=0,this.opt_len=0,this.static_len=0,this.matches=0,this.insert=0,this.bi_buf=0,this.bi_valid=0}var Oa=e=>{if(!e)return 1;let t=e.state;return!t||t.strm!==e||t.status!==C0&&t.status!==Pc&&t.status!==Ic&&t.status!==Sc&&t.status!==Nc&&t.status!==Oc&&t.status!==wu&&t.status!==Sa?1:0},e_=e=>{if(Oa(e))return Lu(e,Ar);e.total_in=e.total_out=0,e.data_type=E5;let t=e.state;return t.pending=0,t.pending_out=0,t.wrap<0&&(t.wrap=-t.wrap),t.status=t.wrap===2?Pc:t.wrap?C0:wu,e.adler=t.wrap===2?0:1,t.last_flush=-2,n5(t),nt},t_=e=>{let t=e_(e);return t===nt&&B5(e.state),t},L5=(e,t)=>Oa(e)||e.state.wrap!==2?Ar:(e.state.gzhead=t,nt),r_=(e,t,r,u,a,n)=>{if(!e)return Ar;let s=1;if(t===d5&&(t=6),u<0?(s=0,u=-u):u>15&&(s=2,u-=16),a<1||a>T5||r!==Ui||u<8||u>15||t<0||t>9||n<0||n>b5||u===8&&s!==1)return Lu(e,Ar);u===8&&(u=9);let i=new w5;return e.state=i,i.strm=e,i.status=C0,i.wrap=s,i.gzhead=null,i.w_bits=u,i.w_size=1<<i.w_bits,i.w_mask=i.w_size-1,i.hash_bits=a+7,i.hash_size=1<<i.hash_bits,i.hash_mask=i.hash_size-1,i.hash_shift=~~((i.hash_bits+me-1)/me),i.window=new Uint8Array(i.w_size*2),i.head=new Uint16Array(i.hash_size),i.prev=new Uint16Array(i.w_size),i.lit_bufsize=1<<a+6,i.pending_buf_size=i.lit_bufsize*4,i.pending_buf=new Uint8Array(i.pending_buf_size),i.sym_buf=i.lit_bufsize,i.sym_end=(i.lit_bufsize-1)*3,i.level=t,i.strategy=n,i.method=r,t_(e)},M5=(e,t)=>r_(e,t,Ui,x5,A5,_5),F5=(e,t)=>{if(Oa(e)||t>Qb||t<0)return e?Lu(e,Ar):Ar;let r=e.state;if(!e.output||e.avail_in!==0&&!e.input||r.status===Sa&&t!==kt)return Lu(e,e.avail_out===0?vc:Ar);let u=r.last_flush;if(r.last_flush=t,r.pending!==0){if(Mt(e),e.avail_out===0)return r.last_flush=-1,nt}else if(e.avail_in===0&&Kb(t)<=Kb(u)&&t!==kt)return Lu(e,vc);if(r.status===Sa&&e.avail_in!==0)return Lu(e,vc);if(r.status===C0&&r.wrap===0&&(r.status=wu),r.status===C0){let a=Ui+(r.w_bits-8<<4)<<8,n=-1;if(r.strategy>=Hi||r.level<2?n=0:r.level<6?n=1:r.level===6?n=2:n=3,a|=n<<6,r.strstart!==0&&(a|=I5),a+=31-a%31,Ia(r,a),r.strstart!==0&&(Ia(r,e.adler>>>16),Ia(r,e.adler&65535)),e.adler=1,r.status=wu,Mt(e),r.pending!==0)return r.last_flush=-1,nt}if(r.status===Pc){if(e.adler=0,Ie(r,31),Ie(r,139),Ie(r,8),r.gzhead)Ie(r,(r.gzhead.text?1:0)+(r.gzhead.hcrc?2:0)+(r.gzhead.extra?4:0)+(r.gzhead.name?8:0)+(r.gzhead.comment?16:0)),Ie(r,r.gzhead.time&255),Ie(r,r.gzhead.time>>8&255),Ie(r,r.gzhead.time>>16&255),Ie(r,r.gzhead.time>>24&255),Ie(r,r.level===9?2:r.strategy>=Hi||r.level<2?4:0),Ie(r,r.gzhead.os&255),r.gzhead.extra&&r.gzhead.extra.length&&(Ie(r,r.gzhead.extra.length&255),Ie(r,r.gzhead.extra.length>>8&255)),r.gzhead.hcrc&&(e.adler=ou(e.adler,r.pending_buf,r.pending,0)),r.gzindex=0,r.status=Ic;else if(Ie(r,0),Ie(r,0),Ie(r,0),Ie(r,0),Ie(r,0),Ie(r,r.level===9?2:r.strategy>=Hi||r.level<2?4:0),Ie(r,S5),r.status=wu,Mt(e),r.pending!==0)return r.last_flush=-1,nt}if(r.status===Ic){if(r.gzhead.extra){let a=r.pending,n=(r.gzhead.extra.length&65535)-r.gzindex;for(;r.pending+n>r.pending_buf_size;){let i=r.pending_buf_size-r.pending;if(r.pending_buf.set(r.gzhead.extra.subarray(r.gzindex,r.gzindex+i),r.pending),r.pending=r.pending_buf_size,r.gzhead.hcrc&&r.pending>a&&(e.adler=ou(e.adler,r.pending_buf,r.pending-a,a)),r.gzindex+=i,Mt(e),r.pending!==0)return r.last_flush=-1,nt;a=0,n-=i}let s=new Uint8Array(r.gzhead.extra);r.pending_buf.set(s.subarray(r.gzindex,r.gzindex+n),r.pending),r.pending+=n,r.gzhead.hcrc&&r.pending>a&&(e.adler=ou(e.adler,r.pending_buf,r.pending-a,a)),r.gzindex=0}r.status=Sc}if(r.status===Sc){if(r.gzhead.name){let a=r.pending,n;do{if(r.pending===r.pending_buf_size){if(r.gzhead.hcrc&&r.pending>a&&(e.adler=ou(e.adler,r.pending_buf,r.pending-a,a)),Mt(e),r.pending!==0)return r.last_flush=-1,nt;a=0}r.gzindex<r.gzhead.name.length?n=r.gzhead.name.charCodeAt(r.gzindex++)&255:n=0,Ie(r,n)}while(n!==0);r.gzhead.hcrc&&r.pending>a&&(e.adler=ou(e.adler,r.pending_buf,r.pending-a,a)),r.gzindex=0}r.status=Nc}if(r.status===Nc){if(r.gzhead.comment){let a=r.pending,n;do{if(r.pending===r.pending_buf_size){if(r.gzhead.hcrc&&r.pending>a&&(e.adler=ou(e.adler,r.pending_buf,r.pending-a,a)),Mt(e),r.pending!==0)return r.last_flush=-1,nt;a=0}r.gzindex<r.gzhead.comment.length?n=r.gzhead.comment.charCodeAt(r.gzindex++)&255:n=0,Ie(r,n)}while(n!==0);r.gzhead.hcrc&&r.pending>a&&(e.adler=ou(e.adler,r.pending_buf,r.pending-a,a))}r.status=Oc}if(r.status===Oc){if(r.gzhead.hcrc){if(r.pending+2>r.pending_buf_size&&(Mt(e),r.pending!==0))return r.last_flush=-1,nt;Ie(r,e.adler&255),Ie(r,e.adler>>8&255),e.adler=0}if(r.status=wu,Mt(e),r.pending!==0)return r.last_flush=-1,nt}if(e.avail_in!==0||r.lookahead!==0||t!==du&&r.status!==Sa){let a=r.level===0?Jb(r,t):r.strategy===Hi?P5(r,t):r.strategy===p5?R5(r,t):Na[r.level].func(r,t);if((a===Mu||a===N0)&&(r.status=Sa),a===xt||a===Mu)return e.avail_out===0&&(r.last_flush=-1),nt;if(a===S0&&(t===c5?s5(r):t!==Qb&&(Dc(r,0,0,!1),t===f5&&(cu(r.head),r.lookahead===0&&(r.strstart=0,r.block_start=0,r.insert=0))),Mt(e),e.avail_out===0))return r.last_flush=-1,nt}return t!==kt?nt:r.wrap<=0?Xb:(r.wrap===2?(Ie(r,e.adler&255),Ie(r,e.adler>>8&255),Ie(r,e.adler>>16&255),Ie(r,e.adler>>24&255),Ie(r,e.total_in&255),Ie(r,e.total_in>>8&255),Ie(r,e.total_in>>16&255),Ie(r,e.total_in>>24&255)):(Ia(r,e.adler>>>16),Ia(r,e.adler&65535)),Mt(e),r.wrap>0&&(r.wrap=-r.wrap),r.pending!==0?nt:Xb)},k5=e=>{if(Oa(e))return Ar;let t=e.state.status;return e.state=null,t===wu?Lu(e,l5):nt},H5=(e,t)=>{let r=t.length;if(Oa(e))return Ar;let u=e.state,a=u.wrap;if(a===2||a===1&&u.status!==C0||u.lookahead)return Ar;if(a===1&&(e.adler=$b(e.adler,t,r,0)),u.wrap=0,r>=u.w_size){a===0&&(cu(u.head),u.strstart=0,u.block_start=0,u.insert=0);let c=new Uint8Array(u.w_size);c.set(t.subarray(r-u.w_size,r),0),t=c,r=u.w_size}let n=e.avail_in,s=e.next_in,i=e.input;for(e.avail_in=r,e.next_in=0,e.input=t,I0(u);u.lookahead>=me;){let c=u.strstart,o=u.lookahead-(me-1);do u.ins_h=hu(u,u.ins_h,u.window[c+me-1]),u.prev[c&u.w_mask]=u.head[u.ins_h],u.head[u.ins_h]=c,c++;while(--o);u.strstart=c,u.lookahead=me-1,I0(u)}return u.strstart+=u.lookahead,u.block_start=u.strstart,u.insert=u.lookahead,u.lookahead=0,u.match_length=u.prev_length=me-1,u.match_available=0,e.next_in=s,e.input=i,e.avail_in=n,u.wrap=a,nt};gr.exports.deflateInit=M5;gr.exports.deflateInit2=r_;gr.exports.deflateReset=t_;gr.exports.deflateResetKeep=e_;gr.exports.deflateSetHeader=L5;gr.exports.deflate=F5;gr.exports.deflateEnd=k5;gr.exports.deflateSetDictionary=H5;gr.exports.deflateInfo="pako deflate (from Nodeca project)"});var wc=R((bI,Bc)=>{"use strict";var U5=(e,t)=>Object.prototype.hasOwnProperty.call(e,t);Bc.exports.assign=function(e){let t=Array.prototype.slice.call(arguments,1);for(;t.length;){let r=t.shift();if(r){if(typeof r!="object")throw new TypeError(r+"must be non-object");for(let u in r)U5(r,u)&&(e[u]=r[u])}}return e};Bc.exports.flattenChunks=e=>{let t=0;for(let u=0,a=e.length;u<a;u++)t+=e[u].length;let r=new Uint8Array(t);for(let u=0,a=0,n=e.length;u<n;u++){let s=e[u];r.set(s,a),a+=s.length}return r}});var Lc=R((_I,Gi)=>{"use strict";var a_=!0;try{String.fromCharCode.apply(null,new Uint8Array(1))}catch(e){a_=!1}var Ra=new Uint8Array(256);for(let e=0;e<256;e++)Ra[e]=e>=252?6:e>=248?5:e>=240?4:e>=224?3:e>=192?2:1;Ra[254]=Ra[254]=1;Gi.exports.string2buf=e=>{if(typeof TextEncoder=="function"&&TextEncoder.prototype.encode)return new TextEncoder().encode(e);let t,r,u,a,n,s=e.length,i=0;for(a=0;a<s;a++)r=e.charCodeAt(a),(r&64512)===55296&&a+1<s&&(u=e.charCodeAt(a+1),(u&64512)===56320&&(r=65536+(r-55296<<10)+(u-56320),a++)),i+=r<128?1:r<2048?2:r<65536?3:4;for(t=new Uint8Array(i),n=0,a=0;n<i;a++)r=e.charCodeAt(a),(r&64512)===55296&&a+1<s&&(u=e.charCodeAt(a+1),(u&64512)===56320&&(r=65536+(r-55296<<10)+(u-56320),a++)),r<128?t[n++]=r:r<2048?(t[n++]=192|r>>>6,t[n++]=128|r&63):r<65536?(t[n++]=224|r>>>12,t[n++]=128|r>>>6&63,t[n++]=128|r&63):(t[n++]=240|r>>>18,t[n++]=128|r>>>12&63,t[n++]=128|r>>>6&63,t[n++]=128|r&63);return t};var G5=(e,t)=>{if(t<65534&&e.subarray&&a_)return String.fromCharCode.apply(null,e.length===t?e:e.subarray(0,t));let r="";for(let u=0;u<t;u++)r+=String.fromCharCode(e[u]);return r};Gi.exports.buf2string=(e,t)=>{let r=t||e.length;if(typeof TextDecoder=="function"&&TextDecoder.prototype.decode)return new TextDecoder().decode(e.subarray(0,t));let u,a,n=new Array(r*2);for(a=0,u=0;u<r;){let s=e[u++];if(s<128){n[a++]=s;continue}let i=Ra[s];if(i>4){n[a++]=65533,u+=i-1;continue}for(s&=i===2?31:i===3?15:7;i>1&&u<r;)s=s<<6|e[u++]&63,i--;if(i>1){n[a++]=65533;continue}s<65536?n[a++]=s:(s-=65536,n[a++]=55296|s>>10&1023,n[a++]=56320|s&1023)}return G5(n,a)};Gi.exports.utf8border=(e,t)=>{t=t||e.length,t>e.length&&(t=e.length);let r=t-1;for(;r>=0&&(e[r]&192)===128;)r--;return r<0||r===0?t:r+Ra[e[r]]>t?r:t}});var Mc=R((EI,n_)=>{"use strict";function q5(){this.input=null,this.next_in=0,this.avail_in=0,this.total_in=0,this.output=null,this.next_out=0,this.avail_out=0,this.total_out=0,this.msg="",this.state=null,this.data_type=2,this.adler=0}n_.exports=q5});var c_=R((TI,O0)=>{"use strict";var Pa=u_(),i_=wc(),s_=Lc(),Fc=ki(),j5=Mc(),o_=Object.prototype.toString,{Z_NO_FLUSH:z5,Z_SYNC_FLUSH:Y5,Z_FULL_FLUSH:W5,Z_FINISH:V5,Z_OK:qi,Z_STREAM_END:Q5,Z_DEFAULT_COMPRESSION:X5,Z_DEFAULT_STRATEGY:K5,Z_DEFLATED:$5}=su();function Ba(e){this.options=i_.assign({level:X5,method:$5,chunkSize:16384,windowBits:15,memLevel:8,strategy:K5},e||{});let t=this.options;t.raw&&t.windowBits>0?t.windowBits=-t.windowBits:t.gzip&&t.windowBits>0&&t.windowBits<16&&(t.windowBits+=16),this.err=0,this.msg="",this.ended=!1,this.chunks=[],this.strm=new j5,this.strm.avail_out=0;let r=Pa.deflateInit2(this.strm,t.level,t.method,t.windowBits,t.memLevel,t.strategy);if(r!==qi)throw new Error(Fc[r]);if(t.header&&Pa.deflateSetHeader(this.strm,t.header),t.dictionary){let u;if(typeof t.dictionary=="string"?u=s_.string2buf(t.dictionary):o_.call(t.dictionary)==="[object ArrayBuffer]"?u=new Uint8Array(t.dictionary):u=t.dictionary,r=Pa.deflateSetDictionary(this.strm,u),r!==qi)throw new Error(Fc[r]);this._dict_set=!0}}Ba.prototype.push=function(e,t){let r=this.strm,u=this.options.chunkSize,a,n;if(this.ended)return!1;for(t===~~t?n=t:n=t===!0?V5:z5,typeof e=="string"?r.input=s_.string2buf(e):o_.call(e)==="[object ArrayBuffer]"?r.input=new Uint8Array(e):r.input=e,r.next_in=0,r.avail_in=r.input.length;;){if(r.avail_out===0&&(r.output=new Uint8Array(u),r.next_out=0,r.avail_out=u),(n===Y5||n===W5)&&r.avail_out<=6){this.onData(r.output.subarray(0,r.next_out)),r.avail_out=0;continue}if(a=Pa.deflate(r,n),a===Q5)return r.next_out>0&&this.onData(r.output.subarray(0,r.next_out)),a=Pa.deflateEnd(this.strm),this.onEnd(a),this.ended=!0,a===qi;if(r.avail_out===0){this.onData(r.output);continue}if(n>0&&r.next_out>0){this.onData(r.output.subarray(0,r.next_out)),r.avail_out=0;continue}if(r.avail_in===0)break}return!0};Ba.prototype.onData=function(e){this.chunks.push(e)};Ba.prototype.onEnd=function(e){e===qi&&(this.result=i_.flattenChunks(this.chunks)),this.chunks=[],this.err=e,this.msg=this.strm.msg};function kc(e,t){let r=new Ba(t);if(r.push(e,!0),r.err)throw r.msg||Fc[r.err];return r.result}function Z5(e,t){return t=t||{},t.raw=!0,kc(e,t)}function J5(e,t){return t=t||{},t.gzip=!0,kc(e,t)}O0.exports.Deflate=Ba;O0.exports.deflate=kc;O0.exports.deflateRaw=Z5;O0.exports.gzip=J5;O0.exports.constants=su()});var l_=R((xI,f_)=>{"use strict";f_.exports=function(t,r){let u,a,n,s,i,c,o,f,p,d,b,_,C,D,T,A,v,g,N,P,H,k,B,j,L=t.state;u=t.next_in,B=t.input,a=u+(t.avail_in-5),n=t.next_out,j=t.output,s=n-(r-t.avail_out),i=n+(t.avail_out-257),c=L.dmax,o=L.wsize,f=L.whave,p=L.wnext,d=L.window,b=L.hold,_=L.bits,C=L.lencode,D=L.distcode,T=(1<<L.lenbits)-1,A=(1<<L.distbits)-1;e:do{_<15&&(b+=B[u++]<<_,_+=8,b+=B[u++]<<_,_+=8),v=C[b&T];t:for(;;){if(g=v>>>24,b>>>=g,_-=g,g=v>>>16&255,g===0)j[n++]=v&65535;else if(g&16){N=v&65535,g&=15,g&&(_<g&&(b+=B[u++]<<_,_+=8),N+=b&(1<<g)-1,b>>>=g,_-=g),_<15&&(b+=B[u++]<<_,_+=8,b+=B[u++]<<_,_+=8),v=D[b&A];r:for(;;){if(g=v>>>24,b>>>=g,_-=g,g=v>>>16&255,g&16){if(P=v&65535,g&=15,_<g&&(b+=B[u++]<<_,_+=8,_<g&&(b+=B[u++]<<_,_+=8)),P+=b&(1<<g)-1,P>c){t.msg="invalid distance too far back",L.mode=16209;break e}if(b>>>=g,_-=g,g=n-s,P>g){if(g=P-g,g>f&&L.sane){t.msg="invalid distance too far back",L.mode=16209;break e}if(H=0,k=d,p===0){if(H+=o-g,g<N){N-=g;do j[n++]=d[H++];while(--g);H=n-P,k=j}}else if(p<g){if(H+=o+p-g,g-=p,g<N){N-=g;do j[n++]=d[H++];while(--g);if(H=0,p<N){g=p,N-=g;do j[n++]=d[H++];while(--g);H=n-P,k=j}}}else if(H+=p-g,g<N){N-=g;do j[n++]=d[H++];while(--g);H=n-P,k=j}for(;N>2;)j[n++]=k[H++],j[n++]=k[H++],j[n++]=k[H++],N-=3;N&&(j[n++]=k[H++],N>1&&(j[n++]=k[H++]))}else{H=n-P;do j[n++]=j[H++],j[n++]=j[H++],j[n++]=j[H++],N-=3;while(N>2);N&&(j[n++]=j[H++],N>1&&(j[n++]=j[H++]))}}else if((g&64)===0){v=D[(v&65535)+(b&(1<<g)-1)];continue r}else{t.msg="invalid distance code",L.mode=16209;break e}break}}else if((g&64)===0){v=C[(v&65535)+(b&(1<<g)-1)];continue t}else if(g&32){L.mode=16191;break e}else{t.msg="invalid literal/length code",L.mode=16209;break e}break}}while(u<a&&n<i);N=_>>3,u-=N,_-=N<<3,b&=(1<<_)-1,t.next_in=u,t.next_out=n,t.avail_in=u<a?5+(a-u):5-(u-a),t.avail_out=n<i?257+(i-n):257-(n-i),L.hold=b,L.bits=_}});var h_=R((AI,d_)=>{"use strict";var ey=new Uint16Array([3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258,0,0]),ty=new Uint8Array([16,16,16,16,16,16,16,16,17,17,17,17,18,18,18,18,19,19,19,19,20,20,20,20,21,21,21,21,16,72,78]),ry=new Uint16Array([1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577,0,0]),uy=new Uint8Array([16,16,16,16,17,17,18,18,19,19,20,20,21,21,22,22,23,23,24,24,25,25,26,26,27,27,28,28,29,29,64,64]),ay=(e,t,r,u,a,n,s,i)=>{let c=i.bits,o=0,f=0,p=0,d=0,b=0,_=0,C=0,D=0,T=0,A=0,v,g,N,P,H,k=null,B,j=new Uint16Array(16),L=new Uint16Array(16),F=null,w,S,X;for(o=0;o<=15;o++)j[o]=0;for(f=0;f<u;f++)j[t[r+f]]++;for(b=c,d=15;d>=1&&j[d]===0;d--);if(b>d&&(b=d),d===0)return a[n++]=1<<24|64<<16|0,a[n++]=1<<24|64<<16|0,i.bits=1,0;for(p=1;p<d&&j[p]===0;p++);for(b<p&&(b=p),D=1,o=1;o<=15;o++)if(D<<=1,D-=j[o],D<0)return-1;if(D>0&&(e===0||d!==1))return-1;for(L[1]=0,o=1;o<15;o++)L[o+1]=L[o]+j[o];for(f=0;f<u;f++)t[r+f]!==0&&(s[L[t[r+f]]++]=f);if(e===0?(k=F=s,B=20):e===1?(k=ey,F=ty,B=257):(k=ry,F=uy,B=0),A=0,f=0,o=p,H=n,_=b,C=0,N=-1,T=1<<b,P=T-1,e===1&&T>852||e===2&&T>592)return 1;for(;;){w=o-C,s[f]+1<B?(S=0,X=s[f]):s[f]>=B?(S=F[s[f]-B],X=k[s[f]-B]):(S=96,X=0),v=1<<o-C,g=1<<_,p=g;do g-=v,a[H+(A>>C)+g]=w<<24|S<<16|X|0;while(g!==0);for(v=1<<o-1;A&v;)v>>=1;if(v!==0?(A&=v-1,A+=v):A=0,f++,--j[o]===0){if(o===d)break;o=t[r+s[f]]}if(o>b&&(A&P)!==N){for(C===0&&(C=b),H+=p,_=o-C,D=1<<_;_+C<d&&(D-=j[_+C],!(D<=0));)_++,D<<=1;if(T+=1<<_,e===1&&T>852||e===2&&T>592)return 1;N=A&P,a[N]=b<<24|_<<16|H-n|0}}return A!==0&&(a[H+A]=o-C<<24|64<<16|0),i.bits=b,0};d_.exports=ay});var Q_=R((mI,er)=>{"use strict";var zc=mc(),vr=gc(),ny=l_(),wa=h_(),iy=0,H_=1,U_=2,{Z_FINISH:p_,Z_BLOCK:sy,Z_TREES:ji,Z_OK:Fu,Z_STREAM_END:oy,Z_NEED_DICT:cy,Z_STREAM_ERROR:Ht,Z_DATA_ERROR:G_,Z_MEM_ERROR:Yc,Z_BUF_ERROR:fy,Z_DEFLATED:b_}=su(),Vi=16180,__=16181,E_=16182,T_=16183,x_=16184,A_=16185,m_=16186,g_=16187,v_=16188,y_=16189,Wi=16190,Mr=16191,Hc=16192,D_=16193,Uc=16194,C_=16195,I_=16196,S_=16197,N_=16198,zi=16199,Yi=16200,O_=16201,R_=16202,P_=16203,B_=16204,w_=16205,Gc=16206,L_=16207,M_=16208,ke=16209,Wc=16210,q_=16211,ly=852,dy=592,hy=15,py=hy,F_=e=>(e>>>24&255)+(e>>>8&65280)+((e&65280)<<8)+((e&255)<<24);function by(){this.strm=null,this.mode=0,this.last=!1,this.wrap=0,this.havedict=!1,this.flags=0,this.dmax=0,this.check=0,this.total=0,this.head=null,this.wbits=0,this.wsize=0,this.whave=0,this.wnext=0,this.window=null,this.hold=0,this.bits=0,this.length=0,this.offset=0,this.extra=0,this.lencode=null,this.distcode=null,this.lenbits=0,this.distbits=0,this.ncode=0,this.nlen=0,this.ndist=0,this.have=0,this.next=null,this.lens=new Uint16Array(320),this.work=new Uint16Array(288),this.lendyn=null,this.distdyn=null,this.sane=0,this.back=0,this.was=0}var ku=e=>{if(!e)return 1;let t=e.state;return!t||t.strm!==e||t.mode<Vi||t.mode>q_?1:0},j_=e=>{if(ku(e))return Ht;let t=e.state;return e.total_in=e.total_out=t.total=0,e.msg="",t.wrap&&(e.adler=t.wrap&1),t.mode=Vi,t.last=0,t.havedict=0,t.flags=-1,t.dmax=32768,t.head=null,t.hold=0,t.bits=0,t.lencode=t.lendyn=new Int32Array(ly),t.distcode=t.distdyn=new Int32Array(dy),t.sane=1,t.back=-1,Fu},z_=e=>{if(ku(e))return Ht;let t=e.state;return t.wsize=0,t.whave=0,t.wnext=0,j_(e)},Y_=(e,t)=>{let r;if(ku(e))return Ht;let u=e.state;return t<0?(r=0,t=-t):(r=(t>>4)+5,t<48&&(t&=15)),t&&(t<8||t>15)?Ht:(u.window!==null&&u.wbits!==t&&(u.window=null),u.wrap=r,u.wbits=t,z_(e))},W_=(e,t)=>{if(!e)return Ht;let r=new by;e.state=r,r.strm=e,r.window=null,r.mode=Vi;let u=Y_(e,t);return u!==Fu&&(e.state=null),u},_y=e=>W_(e,py),k_=!0,qc,jc,Ey=e=>{if(k_){qc=new Int32Array(512),jc=new Int32Array(32);let t=0;for(;t<144;)e.lens[t++]=8;for(;t<256;)e.lens[t++]=9;for(;t<280;)e.lens[t++]=7;for(;t<288;)e.lens[t++]=8;for(wa(H_,e.lens,0,288,qc,0,e.work,{bits:9}),t=0;t<32;)e.lens[t++]=5;wa(U_,e.lens,0,32,jc,0,e.work,{bits:5}),k_=!1}e.lencode=qc,e.lenbits=9,e.distcode=jc,e.distbits=5},V_=(e,t,r,u)=>{let a,n=e.state;return n.window===null&&(n.wsize=1<<n.wbits,n.wnext=0,n.whave=0,n.window=new Uint8Array(n.wsize)),u>=n.wsize?(n.window.set(t.subarray(r-n.wsize,r),0),n.wnext=0,n.whave=n.wsize):(a=n.wsize-n.wnext,a>u&&(a=u),n.window.set(t.subarray(r-u,r-u+a),n.wnext),u-=a,u?(n.window.set(t.subarray(r-u,r),0),n.wnext=u,n.whave=n.wsize):(n.wnext+=a,n.wnext===n.wsize&&(n.wnext=0),n.whave<n.wsize&&(n.whave+=a))),0},Ty=(e,t)=>{let r,u,a,n,s,i,c,o,f,p,d,b,_,C,D=0,T,A,v,g,N,P,H,k,B=new Uint8Array(4),j,L,F=new Uint8Array([16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15]);if(ku(e)||!e.output||!e.input&&e.avail_in!==0)return Ht;r=e.state,r.mode===Mr&&(r.mode=Hc),s=e.next_out,a=e.output,c=e.avail_out,n=e.next_in,u=e.input,i=e.avail_in,o=r.hold,f=r.bits,p=i,d=c,k=Fu;e:for(;;)switch(r.mode){case Vi:if(r.wrap===0){r.mode=Hc;break}for(;f<16;){if(i===0)break e;i--,o+=u[n++]<<f,f+=8}if(r.wrap&2&&o===35615){r.wbits===0&&(r.wbits=15),r.check=0,B[0]=o&255,B[1]=o>>>8&255,r.check=vr(r.check,B,2,0),o=0,f=0,r.mode=__;break}if(r.head&&(r.head.done=!1),!(r.wrap&1)||(((o&255)<<8)+(o>>8))%31){e.msg="incorrect header check",r.mode=ke;break}if((o&15)!==b_){e.msg="unknown compression method",r.mode=ke;break}if(o>>>=4,f-=4,H=(o&15)+8,r.wbits===0&&(r.wbits=H),H>15||H>r.wbits){e.msg="invalid window size",r.mode=ke;break}r.dmax=1<<r.wbits,r.flags=0,e.adler=r.check=1,r.mode=o&512?y_:Mr,o=0,f=0;break;case __:for(;f<16;){if(i===0)break e;i--,o+=u[n++]<<f,f+=8}if(r.flags=o,(r.flags&255)!==b_){e.msg="unknown compression method",r.mode=ke;break}if(r.flags&57344){e.msg="unknown header flags set",r.mode=ke;break}r.head&&(r.head.text=o>>8&1),r.flags&512&&r.wrap&4&&(B[0]=o&255,B[1]=o>>>8&255,r.check=vr(r.check,B,2,0)),o=0,f=0,r.mode=E_;case E_:for(;f<32;){if(i===0)break e;i--,o+=u[n++]<<f,f+=8}r.head&&(r.head.time=o),r.flags&512&&r.wrap&4&&(B[0]=o&255,B[1]=o>>>8&255,B[2]=o>>>16&255,B[3]=o>>>24&255,r.check=vr(r.check,B,4,0)),o=0,f=0,r.mode=T_;case T_:for(;f<16;){if(i===0)break e;i--,o+=u[n++]<<f,f+=8}r.head&&(r.head.xflags=o&255,r.head.os=o>>8),r.flags&512&&r.wrap&4&&(B[0]=o&255,B[1]=o>>>8&255,r.check=vr(r.check,B,2,0)),o=0,f=0,r.mode=x_;case x_:if(r.flags&1024){for(;f<16;){if(i===0)break e;i--,o+=u[n++]<<f,f+=8}r.length=o,r.head&&(r.head.extra_len=o),r.flags&512&&r.wrap&4&&(B[0]=o&255,B[1]=o>>>8&255,r.check=vr(r.check,B,2,0)),o=0,f=0}else r.head&&(r.head.extra=null);r.mode=A_;case A_:if(r.flags&1024&&(b=r.length,b>i&&(b=i),b&&(r.head&&(H=r.head.extra_len-r.length,r.head.extra||(r.head.extra=new Uint8Array(r.head.extra_len)),r.head.extra.set(u.subarray(n,n+b),H)),r.flags&512&&r.wrap&4&&(r.check=vr(r.check,u,b,n)),i-=b,n+=b,r.length-=b),r.length))break e;r.length=0,r.mode=m_;case m_:if(r.flags&2048){if(i===0)break e;b=0;do H=u[n+b++],r.head&&H&&r.length<65536&&(r.head.name+=String.fromCharCode(H));while(H&&b<i);if(r.flags&512&&r.wrap&4&&(r.check=vr(r.check,u,b,n)),i-=b,n+=b,H)break e}else r.head&&(r.head.name=null);r.length=0,r.mode=g_;case g_:if(r.flags&4096){if(i===0)break e;b=0;do H=u[n+b++],r.head&&H&&r.length<65536&&(r.head.comment+=String.fromCharCode(H));while(H&&b<i);if(r.flags&512&&r.wrap&4&&(r.check=vr(r.check,u,b,n)),i-=b,n+=b,H)break e}else r.head&&(r.head.comment=null);r.mode=v_;case v_:if(r.flags&512){for(;f<16;){if(i===0)break e;i--,o+=u[n++]<<f,f+=8}if(r.wrap&4&&o!==(r.check&65535)){e.msg="header crc mismatch",r.mode=ke;break}o=0,f=0}r.head&&(r.head.hcrc=r.flags>>9&1,r.head.done=!0),e.adler=r.check=0,r.mode=Mr;break;case y_:for(;f<32;){if(i===0)break e;i--,o+=u[n++]<<f,f+=8}e.adler=r.check=F_(o),o=0,f=0,r.mode=Wi;case Wi:if(r.havedict===0)return e.next_out=s,e.avail_out=c,e.next_in=n,e.avail_in=i,r.hold=o,r.bits=f,cy;e.adler=r.check=1,r.mode=Mr;case Mr:if(t===sy||t===ji)break e;case Hc:if(r.last){o>>>=f&7,f-=f&7,r.mode=Gc;break}for(;f<3;){if(i===0)break e;i--,o+=u[n++]<<f,f+=8}switch(r.last=o&1,o>>>=1,f-=1,o&3){case 0:r.mode=D_;break;case 1:if(Ey(r),r.mode=zi,t===ji){o>>>=2,f-=2;break e}break;case 2:r.mode=I_;break;case 3:e.msg="invalid block type",r.mode=ke}o>>>=2,f-=2;break;case D_:for(o>>>=f&7,f-=f&7;f<32;){if(i===0)break e;i--,o+=u[n++]<<f,f+=8}if((o&65535)!==(o>>>16^65535)){e.msg="invalid stored block lengths",r.mode=ke;break}if(r.length=o&65535,o=0,f=0,r.mode=Uc,t===ji)break e;case Uc:r.mode=C_;case C_:if(b=r.length,b){if(b>i&&(b=i),b>c&&(b=c),b===0)break e;a.set(u.subarray(n,n+b),s),i-=b,n+=b,c-=b,s+=b,r.length-=b;break}r.mode=Mr;break;case I_:for(;f<14;){if(i===0)break e;i--,o+=u[n++]<<f,f+=8}if(r.nlen=(o&31)+257,o>>>=5,f-=5,r.ndist=(o&31)+1,o>>>=5,f-=5,r.ncode=(o&15)+4,o>>>=4,f-=4,r.nlen>286||r.ndist>30){e.msg="too many length or distance symbols",r.mode=ke;break}r.have=0,r.mode=S_;case S_:for(;r.have<r.ncode;){for(;f<3;){if(i===0)break e;i--,o+=u[n++]<<f,f+=8}r.lens[F[r.have++]]=o&7,o>>>=3,f-=3}for(;r.have<19;)r.lens[F[r.have++]]=0;if(r.lencode=r.lendyn,r.lenbits=7,j={bits:r.lenbits},k=wa(iy,r.lens,0,19,r.lencode,0,r.work,j),r.lenbits=j.bits,k){e.msg="invalid code lengths set",r.mode=ke;break}r.have=0,r.mode=N_;case N_:for(;r.have<r.nlen+r.ndist;){for(;D=r.lencode[o&(1<<r.lenbits)-1],T=D>>>24,A=D>>>16&255,v=D&65535,!(T<=f);){if(i===0)break e;i--,o+=u[n++]<<f,f+=8}if(v<16)o>>>=T,f-=T,r.lens[r.have++]=v;else{if(v===16){for(L=T+2;f<L;){if(i===0)break e;i--,o+=u[n++]<<f,f+=8}if(o>>>=T,f-=T,r.have===0){e.msg="invalid bit length repeat",r.mode=ke;break}H=r.lens[r.have-1],b=3+(o&3),o>>>=2,f-=2}else if(v===17){for(L=T+3;f<L;){if(i===0)break e;i--,o+=u[n++]<<f,f+=8}o>>>=T,f-=T,H=0,b=3+(o&7),o>>>=3,f-=3}else{for(L=T+7;f<L;){if(i===0)break e;i--,o+=u[n++]<<f,f+=8}o>>>=T,f-=T,H=0,b=11+(o&127),o>>>=7,f-=7}if(r.have+b>r.nlen+r.ndist){e.msg="invalid bit length repeat",r.mode=ke;break}for(;b--;)r.lens[r.have++]=H}}if(r.mode===ke)break;if(r.lens[256]===0){e.msg="invalid code -- missing end-of-block",r.mode=ke;break}if(r.lenbits=9,j={bits:r.lenbits},k=wa(H_,r.lens,0,r.nlen,r.lencode,0,r.work,j),r.lenbits=j.bits,k){e.msg="invalid literal/lengths set",r.mode=ke;break}if(r.distbits=6,r.distcode=r.distdyn,j={bits:r.distbits},k=wa(U_,r.lens,r.nlen,r.ndist,r.distcode,0,r.work,j),r.distbits=j.bits,k){e.msg="invalid distances set",r.mode=ke;break}if(r.mode=zi,t===ji)break e;case zi:r.mode=Yi;case Yi:if(i>=6&&c>=258){e.next_out=s,e.avail_out=c,e.next_in=n,e.avail_in=i,r.hold=o,r.bits=f,ny(e,d),s=e.next_out,a=e.output,c=e.avail_out,n=e.next_in,u=e.input,i=e.avail_in,o=r.hold,f=r.bits,r.mode===Mr&&(r.back=-1);break}for(r.back=0;D=r.lencode[o&(1<<r.lenbits)-1],T=D>>>24,A=D>>>16&255,v=D&65535,!(T<=f);){if(i===0)break e;i--,o+=u[n++]<<f,f+=8}if(A&&(A&240)===0){for(g=T,N=A,P=v;D=r.lencode[P+((o&(1<<g+N)-1)>>g)],T=D>>>24,A=D>>>16&255,v=D&65535,!(g+T<=f);){if(i===0)break e;i--,o+=u[n++]<<f,f+=8}o>>>=g,f-=g,r.back+=g}if(o>>>=T,f-=T,r.back+=T,r.length=v,A===0){r.mode=w_;break}if(A&32){r.back=-1,r.mode=Mr;break}if(A&64){e.msg="invalid literal/length code",r.mode=ke;break}r.extra=A&15,r.mode=O_;case O_:if(r.extra){for(L=r.extra;f<L;){if(i===0)break e;i--,o+=u[n++]<<f,f+=8}r.length+=o&(1<<r.extra)-1,o>>>=r.extra,f-=r.extra,r.back+=r.extra}r.was=r.length,r.mode=R_;case R_:for(;D=r.distcode[o&(1<<r.distbits)-1],T=D>>>24,A=D>>>16&255,v=D&65535,!(T<=f);){if(i===0)break e;i--,o+=u[n++]<<f,f+=8}if((A&240)===0){for(g=T,N=A,P=v;D=r.distcode[P+((o&(1<<g+N)-1)>>g)],T=D>>>24,A=D>>>16&255,v=D&65535,!(g+T<=f);){if(i===0)break e;i--,o+=u[n++]<<f,f+=8}o>>>=g,f-=g,r.back+=g}if(o>>>=T,f-=T,r.back+=T,A&64){e.msg="invalid distance code",r.mode=ke;break}r.offset=v,r.extra=A&15,r.mode=P_;case P_:if(r.extra){for(L=r.extra;f<L;){if(i===0)break e;i--,o+=u[n++]<<f,f+=8}r.offset+=o&(1<<r.extra)-1,o>>>=r.extra,f-=r.extra,r.back+=r.extra}if(r.offset>r.dmax){e.msg="invalid distance too far back",r.mode=ke;break}r.mode=B_;case B_:if(c===0)break e;if(b=d-c,r.offset>b){if(b=r.offset-b,b>r.whave&&r.sane){e.msg="invalid distance too far back",r.mode=ke;break}b>r.wnext?(b-=r.wnext,_=r.wsize-b):_=r.wnext-b,b>r.length&&(b=r.length),C=r.window}else C=a,_=s-r.offset,b=r.length;b>c&&(b=c),c-=b,r.length-=b;do a[s++]=C[_++];while(--b);r.length===0&&(r.mode=Yi);break;case w_:if(c===0)break e;a[s++]=r.length,c--,r.mode=Yi;break;case Gc:if(r.wrap){for(;f<32;){if(i===0)break e;i--,o|=u[n++]<<f,f+=8}if(d-=c,e.total_out+=d,r.total+=d,r.wrap&4&&d&&(e.adler=r.check=r.flags?vr(r.check,a,d,s-d):zc(r.check,a,d,s-d)),d=c,r.wrap&4&&(r.flags?o:F_(o))!==r.check){e.msg="incorrect data check",r.mode=ke;break}o=0,f=0}r.mode=L_;case L_:if(r.wrap&&r.flags){for(;f<32;){if(i===0)break e;i--,o+=u[n++]<<f,f+=8}if(r.wrap&4&&o!==(r.total&4294967295)){e.msg="incorrect length check",r.mode=ke;break}o=0,f=0}r.mode=M_;case M_:k=oy;break e;case ke:k=G_;break e;case Wc:return Yc;case q_:default:return Ht}return e.next_out=s,e.avail_out=c,e.next_in=n,e.avail_in=i,r.hold=o,r.bits=f,(r.wsize||d!==e.avail_out&&r.mode<ke&&(r.mode<Gc||t!==p_))&&V_(e,e.output,e.next_out,d-e.avail_out)?(r.mode=Wc,Yc):(p-=e.avail_in,d-=e.avail_out,e.total_in+=p,e.total_out+=d,r.total+=d,r.wrap&4&&d&&(e.adler=r.check=r.flags?vr(r.check,a,d,e.next_out-d):zc(r.check,a,d,e.next_out-d)),e.data_type=r.bits+(r.last?64:0)+(r.mode===Mr?128:0)+(r.mode===zi||r.mode===Uc?256:0),(p===0&&d===0||t===p_)&&k===Fu&&(k=fy),k)},xy=e=>{if(ku(e))return Ht;let t=e.state;return t.window&&(t.window=null),e.state=null,Fu},Ay=(e,t)=>{if(ku(e))return Ht;let r=e.state;return(r.wrap&2)===0?Ht:(r.head=t,t.done=!1,Fu)},my=(e,t)=>{let r=t.length,u,a,n;return ku(e)||(u=e.state,u.wrap!==0&&u.mode!==Wi)?Ht:u.mode===Wi&&(a=1,a=zc(a,t,r,0),a!==u.check)?G_:(n=V_(e,t,r,r),n?(u.mode=Wc,Yc):(u.havedict=1,Fu))};er.exports.inflateReset=z_;er.exports.inflateReset2=Y_;er.exports.inflateResetKeep=j_;er.exports.inflateInit=_y;er.exports.inflateInit2=W_;er.exports.inflate=Ty;er.exports.inflateEnd=xy;er.exports.inflateGetHeader=Ay;er.exports.inflateSetDictionary=my;er.exports.inflateInfo="pako inflate (from Nodeca project)"});var K_=R((gI,X_)=>{"use strict";function gy(){this.text=0,this.time=0,this.xflags=0,this.os=0,this.extra=null,this.extra_len=0,this.name="",this.comment="",this.hcrc=0,this.done=!1}X_.exports=gy});var eE=R((vI,R0)=>{"use strict";var Fr=Q_(),Z_=wc(),Xc=Lc(),Kc=ki(),vy=Mc(),yy=K_(),J_=Object.prototype.toString,{Z_NO_FLUSH:Dy,Z_FINISH:Cy,Z_OK:La,Z_STREAM_END:Vc,Z_NEED_DICT:Qc,Z_STREAM_ERROR:Iy,Z_DATA_ERROR:$_,Z_MEM_ERROR:Sy}=su();function Ma(e){this.options=Z_.assign({chunkSize:1024*64,windowBits:15,to:""},e||{});let t=this.options;t.raw&&t.windowBits>=0&&t.windowBits<16&&(t.windowBits=-t.windowBits,t.windowBits===0&&(t.windowBits=-15)),t.windowBits>=0&&t.windowBits<16&&!(e&&e.windowBits)&&(t.windowBits+=32),t.windowBits>15&&t.windowBits<48&&(t.windowBits&15)===0&&(t.windowBits|=15),this.err=0,this.msg="",this.ended=!1,this.chunks=[],this.strm=new vy,this.strm.avail_out=0;let r=Fr.inflateInit2(this.strm,t.windowBits);if(r!==La)throw new Error(Kc[r]);if(this.header=new yy,Fr.inflateGetHeader(this.strm,this.header),t.dictionary&&(typeof t.dictionary=="string"?t.dictionary=Xc.string2buf(t.dictionary):J_.call(t.dictionary)==="[object ArrayBuffer]"&&(t.dictionary=new Uint8Array(t.dictionary)),t.raw&&(r=Fr.inflateSetDictionary(this.strm,t.dictionary),r!==La)))throw new Error(Kc[r])}Ma.prototype.push=function(e,t){let r=this.strm,u=this.options.chunkSize,a=this.options.dictionary,n,s,i;if(this.ended)return!1;for(t===~~t?s=t:s=t===!0?Cy:Dy,J_.call(e)==="[object ArrayBuffer]"?r.input=new Uint8Array(e):r.input=e,r.next_in=0,r.avail_in=r.input.length;;){for(r.avail_out===0&&(r.output=new Uint8Array(u),r.next_out=0,r.avail_out=u),n=Fr.inflate(r,s),n===Qc&&a&&(n=Fr.inflateSetDictionary(r,a),n===La?n=Fr.inflate(r,s):n===$_&&(n=Qc));r.avail_in>0&&n===Vc&&r.state.wrap>0&&e[r.next_in]!==0;)Fr.inflateReset(r),n=Fr.inflate(r,s);switch(n){case Iy:case $_:case Qc:case Sy:return this.onEnd(n),this.ended=!0,!1}if(i=r.avail_out,r.next_out&&(r.avail_out===0||n===Vc))if(this.options.to==="string"){let c=Xc.utf8border(r.output,r.next_out),o=r.next_out-c,f=Xc.buf2string(r.output,c);r.next_out=o,r.avail_out=u-o,o&&r.output.set(r.output.subarray(c,c+o),0),this.onData(f)}else this.onData(r.output.length===r.next_out?r.output:r.output.subarray(0,r.next_out));if(!(n===La&&i===0)){if(n===Vc)return n=Fr.inflateEnd(this.strm),this.onEnd(n),this.ended=!0,!0;if(r.avail_in===0)break}}return!0};Ma.prototype.onData=function(e){this.chunks.push(e)};Ma.prototype.onEnd=function(e){e===La&&(this.options.to==="string"?this.result=this.chunks.join(""):this.result=Z_.flattenChunks(this.chunks)),this.chunks=[],this.err=e,this.msg=this.strm.msg};function $c(e,t){let r=new Ma(t);if(r.push(e),r.err)throw r.msg||Kc[r.err];return r.result}function Ny(e,t){return t=t||{},t.raw=!0,$c(e,t)}R0.exports.Inflate=Ma;R0.exports.inflate=$c;R0.exports.inflateRaw=Ny;R0.exports.ungzip=$c;R0.exports.constants=su()});var tE=R((yI,yr)=>{"use strict";var{Deflate:Oy,deflate:Ry,deflateRaw:Py,gzip:By}=c_(),{Inflate:wy,inflate:Ly,inflateRaw:My,ungzip:Fy}=eE(),ky=su();yr.exports.Deflate=Oy;yr.exports.deflate=Ry;yr.exports.deflateRaw=Py;yr.exports.gzip=By;yr.exports.Inflate=wy;yr.exports.inflate=Ly;yr.exports.inflateRaw=My;yr.exports.ungzip=Fy;yr.exports.constants=ky});var Hy=R((DI,rE)=>{rE.exports={cheerio:th(),"crypto-js":f2(),qs:Ab(),dayjs:mb(),"big-integer":gb(),pako:tE()}});return Hy();})();\n';
const preloadSource = "'use strict'\n\n/**\n * MusicFree 插件运行时（QuickJS 沙箱）。\n *\n * MusicFree 插件是 CommonJS 模块，通过 `module.exports` 暴露\n * `getMediaSource` 等方法，用 `require` 获取依赖。本预载脚本提供\n * 最小 CommonJS 外壳和受控依赖实现，只接管播放地址解析。\n *\n * 与 LX 运行时的差异：\n * - LX 是事件协议，插件注册 `globalThis.lx.on('request')`。\n * - MusicFree 是模块协议，宿主主动调用导出的方法。\n *\n * 网络请求仍然复用宿主提供的 `request / response / cancelRequest` 桥，\n * 插件不接触 React Native 全局对象，也拿不到文件系统。\n */\n\nif (typeof globalThis.URLSearchParams !== 'function') {\n  globalThis.URLSearchParams = class URLSearchParams {\n    constructor(init = '') {\n      this._entries = []\n      if (typeof init === 'string') {\n        const source = init.startsWith('?') ? init.slice(1) : init\n        if (source) {\n          for (const part of source.split('&')) {\n            if (!part) continue\n            const index = part.indexOf('=')\n            const key = index >= 0 ? part.slice(0, index) : part\n            const value = index >= 0 ? part.slice(index + 1) : ''\n            this.append(decodeURIComponent(key), decodeURIComponent(value))\n          }\n        }\n      } else if (Array.isArray(init)) {\n        for (const pair of init) this.append(pair[0], pair[1])\n      } else if (init && typeof init === 'object') {\n        for (const key of Object.keys(init)) this.append(key, init[key])\n      }\n    }\n\n    append(key, value) {\n      this._entries.push([String(key), String(value)])\n    }\n\n    set(key, value) {\n      const normalizedKey = String(key)\n      this.delete(normalizedKey)\n      this.append(normalizedKey, value)\n    }\n\n    delete(key) {\n      const normalizedKey = String(key)\n      this._entries = this._entries.filter(\n        ([entryKey]) => entryKey !== normalizedKey,\n      )\n    }\n\n    get(key) {\n      const normalizedKey = String(key)\n      const entry = this._entries.find(\n        ([entryKey]) => entryKey === normalizedKey,\n      )\n      return entry ? entry[1] : null\n    }\n\n    has(key) {\n      return this.get(key) !== null\n    }\n\n    toString() {\n      return this._entries\n        .map(\n          ([key, value]) =>\n            `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,\n        )\n        .join('&')\n    }\n  }\n}\n\nif (typeof Promise.any !== 'function') {\n  Promise.any = promises =>\n    new Promise((resolve, reject) => {\n      const items = Array.from(promises || [])\n      if (items.length === 0) {\n        reject(new Error('All promises were rejected'))\n        return\n      }\n      let rejectedCount = 0\n      items.forEach(promise => {\n        Promise.resolve(promise).then(resolve, () => {\n          rejectedCount += 1\n          if (rejectedCount === items.length) {\n            reject(new Error('All promises were rejected'))\n          }\n        })\n      })\n    })\n}\n\n// QuickJS 只提供 ECMAScript 标准内建，没有 Web 的 URL。\n// 这里补一个最小实现，覆盖插件里常见的 new URL(...) / searchParams 用法。\nif (typeof globalThis.URL !== 'function') {\n  const URL_PATTERN =\n    /^([a-zA-Z][a-zA-Z0-9+.-]*:)\\/\\/([^/?#]*)([^?#]*)(\\?[^#]*)?(#.*)?$/\n  globalThis.URL = class URL {\n    constructor(input, base) {\n      let full = String(input == null ? '' : input)\n      if (!URL_PATTERN.test(full) && base) {\n        const baseMatch = String(base).match(\n          /^([a-zA-Z][a-zA-Z0-9+.-]*:\\/\\/[^/?#]*)([^?#]*)/,\n        )\n        if (baseMatch) {\n          const baseDir = baseMatch[2].replace(/[^/]*$/, '')\n          full =\n            baseMatch[1] +\n            (baseDir || '/') +\n            full.replace(/^\\.?\\//, '')\n        }\n      }\n      const match = full.match(URL_PATTERN)\n      if (!match) {\n        throw new TypeError(`Invalid URL: ${input}`)\n      }\n      this.protocol = match[1]\n      this.host = match[2]\n      this.pathname = match[3] || '/'\n      const query = match[4] ? match[4].slice(1) : ''\n      this.hash = match[5] || ''\n      this.searchParams = new URLSearchParams(query)\n    }\n\n    get search() {\n      const query = this.searchParams.toString()\n      return query ? `?${query}` : ''\n    }\n\n    set search(value) {\n      const source = String(value || '')\n      this.searchParams = new URLSearchParams(\n        source.startsWith('?') ? source.slice(1) : source,\n      )\n    }\n\n    get origin() {\n      return `${this.protocol}//${this.host}`\n    }\n\n    toString() {\n      return `${this.protocol}//${this.host}${this.pathname}${this.search}${this.hash}`\n    }\n\n    toJSON() {\n      return this.toString()\n    }\n  }\n}\n\nglobalThis.musicfree_setup = (\n  key,\n  rawScript,\n  rawUserVariables,\n  rawAppVersion,\n) => {\n  delete globalThis.musicfree_setup\n  const _nativeCall = globalThis.__lx_native_call__\n  delete globalThis.__lx_native_call__\n  const checkLength = (str, length = 1048576) => {\n    if (typeof str === 'string' && str.length > length) {\n      throw new Error('Input too long')\n    }\n    return str\n  }\n\n  const nativeFunc = globalThis.__lx_native_call__set_timeout\n  delete globalThis.__lx_native_call__set_timeout\n  // 本运行时不需要 LX 的加密/编码原生工具，直接移除避免暴露给插件。\n  for (const name of [\n    '__lx_native_call__utils_str2b64',\n    '__lx_native_call__utils_b642buf',\n    '__lx_native_call__utils_str2md5',\n    '__lx_native_call__utils_aes_encrypt',\n    '__lx_native_call__utils_rsa_encrypt',\n  ]) {\n    delete globalThis[name]\n  }\n\n  const nativeCall = (action, data) => {\n    const payload = JSON.stringify(data)\n    checkLength(payload, 4194304)\n    _nativeCall(key, action, payload)\n  }\n\n  let userVariables = {}\n  try {\n    const parsed = JSON.parse(String(rawUserVariables || '{}'))\n    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {\n      userVariables = Object.keys(parsed).reduce((result, variableKey) => {\n        if (variableKey) {\n          const value = parsed[variableKey]\n          result[variableKey] =\n            typeof value === 'string'\n              ? value\n              : value == null\n                ? ''\n                : String(value)\n        }\n        return result\n      }, {})\n    }\n  } catch {\n    userVariables = {}\n  }\n  const appVersion = String(rawAppVersion || '')\n  const env = {\n    getUserVariables: () => userVariables,\n    get userVariables() {\n      return this.getUserVariables()\n    },\n    appVersion,\n    os: 'android',\n    lang: 'zh-CN',\n  }\n  const process = {\n    platform: 'android',\n    version: appVersion,\n    env,\n  }\n\n  // 部分旧版听书插件只保留了 getToneId/getVoiceId 调用，却漏掉函数定义。\n  // 提供同名全局兜底；插件内部若声明了同名函数，仍会优先使用自身实现。\n  globalThis.getToneId = () => {\n    const raw = userVariables.toneId || userVariables.tone_id || ''\n    const parsed = parseInt(String(raw), 10)\n    return Number.isNaN(parsed) ? '' : parsed\n  }\n  globalThis.getVoiceId = () => {\n    const raw = userVariables.voiceId || userVariables.voice_id || ''\n    const parsed = parseInt(String(raw), 10)\n    return Number.isNaN(parsed) ? '' : String(parsed)\n  }\n\n  const callbacks = new Map()\n  let timeoutId = 0\n  const _setTimeout = (callback, timeout = 0, ...params) => {\n    if (typeof callback !== 'function') {\n      throw new Error('callback required a function')\n    }\n    if (typeof timeout !== 'number' || timeout < 0) {\n      throw new Error('timeout required a number')\n    }\n    const id = timeoutId++\n    callbacks.set(id, {callback, params})\n    nativeFunc(id, parseInt(timeout))\n    return id\n  }\n  const _clearTimeout = id => {\n    callbacks.delete(id)\n  }\n  const handleSetTimeout = id => {\n    const target = callbacks.get(id)\n    if (!target) return\n    callbacks.delete(id)\n    target.callback(...target.params)\n  }\n\n  const NATIVE_EVENTS_NAMES = {\n    init: 'init',\n    request: 'request',\n    cancelRequest: 'cancelRequest',\n    response: 'response',\n  }\n\n  const requestQueue = new Map()\n\n  const sendNativeRequest = (url, options, callback) => {\n    const requestKey = Math.random().toString()\n    const requestInfo = {\n      aborted: false,\n      abort: () => {\n        nativeCall(NATIVE_EVENTS_NAMES.cancelRequest, requestKey)\n      },\n    }\n    requestQueue.set(requestKey, {callback, requestInfo})\n    nativeCall(NATIVE_EVENTS_NAMES.request, {requestKey, url, options})\n    return requestInfo\n  }\n\n  const handleNativeResponse = ({requestKey, error, response}) => {\n    const targetRequest = requestQueue.get(requestKey)\n    if (!targetRequest) return\n    requestQueue.delete(requestKey)\n    targetRequest.requestInfo.aborted = true\n    if (error == null) targetRequest.callback(null, response)\n    else targetRequest.callback(new Error(error), null)\n  }\n\n  // ---------- 受控依赖实现 ----------\n\n  const toUint8Array = input => {\n    if (input instanceof Uint8Array) return input\n    if (Array.isArray(input)) return new Uint8Array(input)\n    if (input && typeof input.length === 'number') {\n      return new Uint8Array(Array.prototype.slice.call(input))\n    }\n    return new Uint8Array(0)\n  }\n\n  const bytesToString = bytes => {\n    let result = ''\n    let i = 0\n    while (i < bytes.length) {\n      const byte = bytes[i]\n      if (byte < 128) {\n        result += String.fromCharCode(byte)\n        i += 1\n      } else if (byte >= 192 && byte < 224) {\n        result += String.fromCharCode(\n          ((byte & 31) << 6) | (bytes[i + 1] & 63),\n        )\n        i += 2\n      } else if (byte >= 224 && byte < 240) {\n        result += String.fromCharCode(\n          ((byte & 15) << 12) |\n            ((bytes[i + 1] & 63) << 6) |\n            (bytes[i + 2] & 63),\n        )\n        i += 3\n      } else {\n        result += String.fromCharCode(0xfffd)\n        i += 4\n      }\n    }\n    return result\n  }\n\n  const stringToBytes = input => {\n    const text = String(input)\n    const bytes = []\n    for (let i = 0; i < text.length; i += 1) {\n      let code = text.charCodeAt(i)\n      if (code < 0x80) {\n        bytes.push(code)\n      } else if (code < 0x800) {\n        bytes.push((code >> 6) | 0xc0, (code & 63) | 0x80)\n      } else if (code >= 0xd800 && code <= 0xdbff) {\n        const next = text.charCodeAt(i + 1)\n        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000\n        i += 1\n        bytes.push(\n          (code >> 18) | 0xf0,\n          ((code >> 12) & 63) | 0x80,\n          ((code >> 6) & 63) | 0x80,\n          (code & 63) | 0x80,\n        )\n      } else {\n        bytes.push(\n          (code >> 12) | 0xe0,\n          ((code >> 6) & 63) | 0x80,\n          (code & 63) | 0x80,\n        )\n      }\n    }\n    return new Uint8Array(bytes)\n  }\n\n  const BASE64_CHARS =\n    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'\n\n  const bytesToBase64 = bytes => {\n    let result = ''\n    for (let i = 0; i < bytes.length; i += 3) {\n      const b0 = bytes[i]\n      const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0\n      const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0\n      result += BASE64_CHARS[b0 >> 2]\n      result += BASE64_CHARS[((b0 & 3) << 4) | (b1 >> 4)]\n      result +=\n        i + 1 < bytes.length\n          ? BASE64_CHARS[((b1 & 15) << 2) | (b2 >> 6)]\n          : '='\n      result += i + 2 < bytes.length ? BASE64_CHARS[b2 & 63] : '='\n    }\n    return result\n  }\n\n  const base64ToBytes = input => {\n    const text = String(input).replace(/[^A-Za-z0-9+/=]/g, '')\n    const output = []\n    for (let i = 0; i < text.length; i += 4) {\n      const enc0 = BASE64_CHARS.indexOf(text[i])\n      const enc1 = BASE64_CHARS.indexOf(text[i + 1])\n      const enc2 = BASE64_CHARS.indexOf(text[i + 2])\n      const enc3 = BASE64_CHARS.indexOf(text[i + 3])\n      output.push((enc0 << 2) | (enc1 >> 4))\n      if (enc2 !== -1) output.push(((enc1 & 15) << 4) | (enc2 >> 2))\n      if (enc3 !== -1) output.push(((enc2 & 3) << 6) | enc3)\n    }\n    return new Uint8Array(output)\n  }\n\n  class MusicFreeBuffer extends Uint8Array {\n    toString(encoding) {\n      const normalized = String(encoding || 'utf8').toLowerCase()\n      if (normalized === 'base64') {\n        return bytesToBase64(this)\n      }\n      if (normalized === 'hex') {\n        return Array.from(this)\n          .map(byte => byte.toString(16).padStart(2, '0'))\n          .join('')\n      }\n      if (normalized === 'binary' || normalized === 'latin1') {\n        return Array.from(this)\n          .map(byte => String.fromCharCode(byte))\n          .join('')\n      }\n      return bytesToString(this)\n    }\n\n    static from(input, encoding) {\n      if (typeof input === 'string') {\n        const normalized = String(encoding || 'utf8').toLowerCase()\n        if (normalized === 'base64') return new MusicFreeBuffer(base64ToBytes(input))\n        if (normalized === 'hex') {\n          const bytes = []\n          for (let i = 0; i < input.length; i += 2) {\n            bytes.push(parseInt(input.slice(i, i + 2), 16) || 0)\n          }\n          return new MusicFreeBuffer(bytes)\n        }\n        return new MusicFreeBuffer(stringToBytes(input))\n      }\n      return new MusicFreeBuffer(toUint8Array(input))\n    }\n\n    static alloc(size) {\n      return new MusicFreeBuffer(Number(size) || 0)\n    }\n\n    static isBuffer(value) {\n      return value instanceof Uint8Array\n    }\n  }\n\n  const htmlEntities = {\n    amp: '&',\n    lt: '<',\n    gt: '>',\n    quot: '\"',\n    apos: \"'\",\n    nbsp: '\\u00a0',\n  }\n  const decodeEntities = value =>\n    String(value).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {\n      if (entity[0] === '#') {\n        const isHex = entity[1] === 'x' || entity[1] === 'X'\n        const code = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10)\n        return Number.isFinite(code) ? String.fromCharCode(code) : match\n      }\n      return Object.prototype.hasOwnProperty.call(htmlEntities, entity)\n        ? htmlEntities[entity]\n        : match\n    })\n  const he = {\n    decode: decodeEntities,\n    encode: value =>\n      String(value)\n        .replace(/&/g, '&amp;')\n        .replace(/</g, '&lt;')\n        .replace(/>/g, '&gt;')\n        .replace(/\"/g, '&quot;')\n        .replace(/'/g, '&#39;'),\n    decodeEntity: decodeEntities,\n  }\n\n  const buildQuery = params => {\n    if (!params || typeof params !== 'object') return ''\n    const search = new URLSearchParams()\n    Object.keys(params).forEach(key => {\n      const value = params[key]\n      if (value === undefined || value === null) return\n      if (Array.isArray(value)) {\n        value.forEach(item => search.append(key, String(item)))\n      } else {\n        search.append(key, String(value))\n      }\n    })\n    return search.toString()\n  }\n\n  const axiosRequest = config => {\n    const options = config && typeof config === 'object' ? config : {}\n    const method = String(options.method || 'get').toLowerCase()\n    let url = String(options.url || '')\n    const query = buildQuery(options.params)\n    if (query) {\n      url += url.includes('?') ? `&${query}` : `?${query}`\n    }\n    const binary = options.responseType === 'arraybuffer'\n    const requestOptions = {\n      method,\n      headers: options.headers || {},\n      binary,\n    }\n    if (options.timeout) {\n      requestOptions.timeout = Math.min(Number(options.timeout), 60000)\n    }\n    if (options.data !== undefined) {\n      requestOptions.body = options.data\n    }\n\n    return new Promise((resolve, reject) => {\n      if (!url) {\n        reject(new Error('axios: url is required'))\n        return\n      }\n      sendNativeRequest(url, requestOptions, (error, response) => {\n        if (error) {\n          reject(error)\n          return\n        }\n        const data = binary ? toUint8Array(response.body) : response.body\n        resolve({\n          data,\n          status: response.statusCode,\n          statusText: response.statusMessage,\n          headers: response.headers,\n          config: options,\n          request: {},\n        })\n      })\n    })\n  }\n  axiosRequest.get = (url, config) =>\n    axiosRequest({...(config || {}), url, method: 'get'})\n  axiosRequest.post = (url, data, config) =>\n    axiosRequest({...(config || {}), url, data, method: 'post'})\n  axiosRequest.put = (url, data, config) =>\n    axiosRequest({...(config || {}), url, data, method: 'put'})\n  axiosRequest.delete = (url, config) =>\n    axiosRequest({...(config || {}), url, method: 'delete'})\n  axiosRequest.head = (url, config) =>\n    axiosRequest({...(config || {}), url, method: 'head'})\n  axiosRequest.create = () => axiosRequest\n  axiosRequest.default = axiosRequest\n\n  const bundledModules =\n    globalThis.__musicfreeDependencies &&\n    typeof globalThis.__musicfreeDependencies === 'object'\n      ? globalThis.__musicfreeDependencies\n      : null\n  if (!bundledModules) {\n    throw new Error('MusicFree 依赖包未加载')\n  }\n\n  const MODULES = {\n    ...bundledModules,\n    axios: axiosRequest,\n    he,\n    buffer: {Buffer: MusicFreeBuffer},\n    // 少数插件直接 `require('url')` / `require('querystring')`，\n    // 这里用已有实现补位，避免插件因缺少 Node 内建模块而整体加载失败。\n    url:\n      typeof globalThis.URL === 'function'\n        ? {URL: globalThis.URL, URLSearchParams}\n        : {URLSearchParams},\n    querystring: {\n      stringify: params => {\n        if (!params || typeof params !== 'object') return ''\n        const parts = []\n        Object.keys(params).forEach(key => {\n          const value = params[key]\n          if (value === undefined || value === null) return\n          if (Array.isArray(value)) {\n            value.forEach(item => {\n              parts.push(\n                `${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`,\n              )\n            })\n          } else {\n            parts.push(\n              `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,\n            )\n          }\n        })\n        return parts.join('&')\n      },\n      parse: value => {\n        const result = {}\n        const source = String(value || '').replace(/^\\?/, '')\n        if (!source) return result\n        source.split('&').forEach(part => {\n          if (!part) return\n          const index = part.indexOf('=')\n          const key = decodeURIComponent(\n            index >= 0 ? part.slice(0, index) : part,\n          )\n          const entryValue = decodeURIComponent(\n            index >= 0 ? part.slice(index + 1) : '',\n          )\n          if (\n            Object.prototype.hasOwnProperty.call(result, key) &&\n            Array.isArray(result[key])\n          ) {\n            result[key].push(entryValue)\n          } else if (Object.prototype.hasOwnProperty.call(result, key)) {\n            result[key] = [result[key], entryValue]\n          } else {\n            result[key] = entryValue\n          }\n        })\n        return result\n      },\n      escape: encodeURIComponent,\n      unescape: decodeURIComponent,\n    },\n  }\n\n  const UNSUPPORTED_MODULES = ['crypto']\n\n  const musicfreeRequire = name => {\n    const key = String(name || '').trim()\n    if (Object.prototype.hasOwnProperty.call(MODULES, key)) {\n      return MODULES[key]\n    }\n    if (UNSUPPORTED_MODULES.indexOf(key) >= 0) {\n      throw new Error(`MusicFree 插件依赖 ${key} 暂不受支持`)\n    }\n    throw new Error(`MusicFree 插件依赖 ${key} 未提供`)\n  }\n\n  // ---------- 插件加载 ----------\n\n  const moduleObject = {exports: {}}\n  const exportsObject = moduleObject.exports\n\n  const compilePlugin = source => {\n    // eslint-disable-next-line no-new-func\n    return new Function(\n      'require',\n      'module',\n      'exports',\n      'console',\n      'globalThis',\n      'env',\n      'URL',\n      'process',\n      `${source}\\n;return module.exports;`,\n    )\n  }\n\n  let pluginExports = null\n  try {\n    const factory = compilePlugin(rawScript)\n    const result = factory(\n      musicfreeRequire,\n      moduleObject,\n      exportsObject,\n      console,\n      globalThis,\n      env,\n      typeof globalThis.URL === 'function' ? globalThis.URL : undefined,\n      process,\n    )\n    const exported = result || moduleObject.exports\n    pluginExports =\n      exported &&\n      typeof exported === 'object' &&\n      exported.default &&\n      typeof exported.default === 'object'\n        ? exported.default\n        : exported\n  } catch (error) {\n    nativeCall(NATIVE_EVENTS_NAMES.init, {\n      status: false,\n      errorMessage: error && error.message ? error.message : '插件加载失败',\n    })\n    return\n  }\n\n  if (!pluginExports || typeof pluginExports !== 'object') {\n    nativeCall(NATIVE_EVENTS_NAMES.init, {\n      status: false,\n      errorMessage: '插件未导出有效模块',\n    })\n    return\n  }\n\n  const normalizedUserVariables = Array.isArray(pluginExports.userVariables)\n    ? pluginExports.userVariables.reduce((result, item) => {\n        const variableKey = String(item && item.key ? item.key : '').trim()\n        if (\n          !variableKey ||\n          result.some(variable => variable.key === variableKey)\n        ) {\n          return result\n        }\n        const name = String(item && item.name ? item.name : '').trim()\n        const hint = String(item && item.hint ? item.hint : '').trim()\n        result.push({\n          key: variableKey,\n          ...(name ? {name} : {}),\n          ...(hint ? {hint} : {}),\n        })\n        return result\n      }, [])\n    : []\n\n  const supportedSearchTypes = (() => {\n    const declared =\n      pluginExports.supportedSearchTypes || pluginExports.supportedSearchType\n    if (!Array.isArray(declared)) return []\n    return Array.from(\n      new Set(\n        declared\n          .map(item => String(item || '').trim().toLowerCase())\n          .filter(Boolean),\n      ),\n    )\n  })()\n\n  nativeCall(NATIVE_EVENTS_NAMES.init, {\n    status: true,\n    info: {\n      platform: String(pluginExports.platform || ''),\n      version: String(pluginExports.version || ''),\n      author: String(pluginExports.author || ''),\n      homepage: String(pluginExports.homepage || ''),\n      srcUrl: String(pluginExports.srcUrl || ''),\n      supportedQualities: Array.isArray(pluginExports.supportedQualities)\n        ? pluginExports.supportedQualities.map(String)\n        : [],\n      userVariables: normalizedUserVariables,\n      hasGetMediaSource: typeof pluginExports.getMediaSource === 'function',\n      hasSearchMusic:\n        typeof pluginExports.searchMusic === 'function' ||\n        typeof pluginExports.search === 'function',\n      hasGetMusicInfo: typeof pluginExports.getMusicInfo === 'function',\n      hasGetAlbumInfo: typeof pluginExports.getAlbumInfo === 'function',\n      supportedSearchTypes,\n    },\n  })\n\n  const createResponder = data => {\n    const payload = data || {}\n    const requestKey = payload.requestKey\n    return (status, result, errorMessage) => {\n      nativeCall(NATIVE_EVENTS_NAMES.response, {\n        requestKey,\n        status,\n        result: status ? result : undefined,\n        errorMessage: status ? undefined : errorMessage,\n      })\n    }\n  }\n\n  const handleGetMediaSource = data => {\n    const payload = data || {}\n    const respond = createResponder(payload)\n    if (typeof pluginExports.getMediaSource !== 'function') {\n      respond(false, null, '插件不支持 getMediaSource')\n      return\n    }\n    Promise.resolve(\n      pluginExports.getMediaSource(payload.musicItem, payload.quality),\n    )\n      .then(result => {\n        if (!result || typeof result.url !== 'string') {\n          respond(false, null, '插件未返回有效播放地址')\n          return\n        }\n        // 汽水等插件会返回 CENC 的 cek 字段，必须原样交给原生桥接层，\n        // 由应用层按来源二次校验后再决定是否启用本机解密。\n        const rawCek = result.cek == null ? '' : String(result.cek).trim()\n        const cek = /^[0-9a-fA-F]{32}$/.test(rawCek) ? rawCek : ''\n        const encryption =\n          result.encryption == null\n            ? ''\n            : String(result.encryption).trim().toLowerCase()\n        respond(true, {\n          url: result.url,\n          headers: result.headers,\n          userAgent: result.userAgent,\n          quality: result.quality,\n          ...(cek ? {cek} : {}),\n          ...(cek && encryption === 'cenc' ? {encryption: 'cenc'} : {}),\n        })\n      })\n      .catch(error => {\n        respond(\n          false,\n          null,\n          error && error.message ? error.message : '播放解析失败',\n        )\n      })\n  }\n\n  const handleSearchMusic = data => {\n    const payload = data || {}\n    const respond = createResponder(payload)\n    const search =\n      typeof pluginExports.searchMusic === 'function'\n        ? pluginExports.searchMusic\n        : typeof pluginExports.search === 'function'\n        ? pluginExports.search\n        : null\n    if (!search) {\n      respond(false, null, '插件不支持歌曲搜索')\n      return\n    }\n    const query = String(payload.query || '').trim()\n    const page = Math.max(1, Number(payload.page) || 1)\n    const type = String(payload.type || 'music')\n    if (!query) {\n      respond(true, {isEnd: true, data: []})\n      return\n    }\n    Promise.resolve(search.call(pluginExports, query, page, type))\n      .then(result => {\n        respond(true, result)\n      })\n      .catch(error => {\n        respond(\n          false,\n          null,\n          error && error.message ? error.message : '搜索失败',\n        )\n      })\n  }\n\n  const handleGetMusicInfo = data => {\n    const payload = data || {}\n    const respond = createResponder(payload)\n    if (typeof pluginExports.getMusicInfo !== 'function') {\n      respond(false, null, '插件不支持 getMusicInfo')\n      return\n    }\n    Promise.resolve(pluginExports.getMusicInfo(payload.musicItem))\n      .then(result => {\n        respond(true, result)\n      })\n      .catch(error => {\n        respond(\n          false,\n          null,\n          error && error.message ? error.message : '获取歌曲信息失败',\n        )\n      })\n  }\n\n  const handleGetAlbumInfo = data => {\n    const payload = data || {}\n    const respond = createResponder(payload)\n    if (typeof pluginExports.getAlbumInfo !== 'function') {\n      respond(false, null, '插件不支持 getAlbumInfo')\n      return\n    }\n    Promise.resolve(\n      pluginExports.getAlbumInfo(payload.albumItem, payload.page),\n    )\n      .then(result => {\n        respond(true, result)\n      })\n      .catch(error => {\n        respond(\n          false,\n          null,\n          error && error.message ? error.message : '获取专辑信息失败',\n        )\n      })\n  }\n\n  const jsCall = (action, data) => {\n    switch (action) {\n      case '__run_error__':\n        return\n      case '__set_timeout__':\n        handleSetTimeout(data)\n        return\n      case 'response':\n        handleNativeResponse(data)\n        return\n      case 'getMediaSource':\n        handleGetMediaSource(data)\n        return\n      case 'searchMusic':\n        handleSearchMusic(data)\n        return\n      case 'getMusicInfo':\n        handleGetMusicInfo(data)\n        return\n      case 'getAlbumInfo':\n        handleGetAlbumInfo(data)\n        return\n    }\n    return `Unknown action: ${action}`\n  }\n\n  Object.defineProperty(globalThis, '__lx_native__', {\n    enumerable: false,\n    configurable: false,\n    writable: false,\n    value: (_key, action, data) => {\n      if (key !== _key) return 'Invalid key'\n      return data == null ? jsCall(action) : jsCall(action, JSON.parse(data))\n    },\n  })\n\n  globalThis.setTimeout = _setTimeout\n  globalThis.clearTimeout = _clearTimeout\n\n  console.log('MusicFree preload finished.')\n}\n";
const sourcesDir = () => join$1(app.getPath("userData"), "sources");
class PluginSandbox {
  ctx = null;
  sessionKey = "";
  loadedName = null;
  pending = /* @__PURE__ */ new Map();
  pendingRequests = /* @__PURE__ */ new Map();
  timeoutTimers = /* @__PURE__ */ new Map();
  timeoutSeq = 0;
  disposed = false;
  get name() {
    return this.loadedName;
  }
  load(fileName) {
    if (this.loadedName === fileName && this.ctx) return;
    this.dispose();
    this.ctx = this.createContext();
    this.loadedName = fileName;
    const script = fs.readFileSync(join$1(sourcesDir(), fileName), "utf-8");
    this.sessionKey = crypto.randomUUID();
    const setupCall = `globalThis.musicfree_setup(${JSON.stringify(this.sessionKey)},${JSON.stringify(script)},'{}',${JSON.stringify("2.0.0")})`;
    vm.runInContext(setupCall, this.ctx, { filename: fileName });
  }
  createContext() {
    const sandbox = {
      console,
      Buffer,
      URL: URL$1,
      setTimeout: (fn, ms, ...rest) => {
        const id = ++this.timeoutSeq;
        const t = setTimeout(() => {
          this.timeoutTimers.delete(id);
          this.dispatchNative("__set_timeout__", id);
          fn(...rest);
        }, Math.max(0, Number(ms) || 0));
        this.timeoutTimers.set(id, t);
        return id;
      },
      clearTimeout: (id) => {
        const t = this.timeoutTimers.get(id);
        if (t) clearTimeout(t);
        this.timeoutTimers.delete(id);
      },
      // JS→宿主桥（网络）
      __lx_native_call__: (key, action, payload) => {
        this.dispatchFromJs(key, action, payload);
      },
      __lx_native_call__set_timeout: (id, ms) => {
        const t = setTimeout(() => {
          this.timeoutTimers.delete(id);
          this.dispatchNative("__set_timeout__", id);
        }, Math.max(0, Number(ms) || 0));
        this.timeoutTimers.set(id, t);
        return id;
      }
    };
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox, { name: "musicfree-plugin" });
    vm.runInContext(depsSource, ctx, { filename: "musicfree-dependencies.js" });
    vm.runInContext(preloadSource, ctx, { filename: "musicfree-preload.js" });
    return ctx;
  }
  /** 调用插件方法（searchMusic / getMediaSource / getMusicInfo / getAlbumInfo） */
  callPlugin(action, payload) {
    const ctx = this.ctx;
    if (!ctx) return Promise.reject(new Error("音源未加载"));
    const key = crypto.randomUUID();
    const data = { requestKey: key };
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === "string" && (v.startsWith("{") || v.startsWith("["))) {
        try {
          data[k] = JSON.parse(v);
          continue;
        } catch {
        }
      }
      data[k] = v;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error("插件调用超时"));
      }, 3e4);
      this.pending.set(key, { resolve, reject, timer });
      try {
        const fn = vm.runInContext("globalThis.__lx_native__", ctx);
        fn(this.sessionKey, action, JSON.stringify(data));
      } catch (err) {
        this.pending.delete(key);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
  /** 宿主→JS 回灌 */
  dispatchNative(action, value) {
    if (!this.ctx || this.disposed) return;
    try {
      const fn = vm.runInContext("globalThis.__lx_native__", this.ctx);
      fn(
        this.sessionKey,
        action,
        JSON.stringify(value)
      );
    } catch {
    }
  }
  /** JS→宿主 分发 */
  dispatchFromJs(key, action, data) {
    if (key !== this.sessionKey) return;
    let payload = {};
    try {
      payload = JSON.parse(data);
    } catch {
      payload = {};
    }
    switch (action) {
      case "request":
        this.handleNativeRequest(payload);
        break;
      case "cancelRequest": {
        const rk = String(payload.requestKey || "");
        const cancel = this.pendingRequests.get(rk);
        if (cancel) cancel();
        this.pendingRequests.delete(rk);
        break;
      }
      case "__set_timeout__":
        break;
      case "response": {
        const rk = String(payload.requestKey || "");
        const p = this.pending.get(rk);
        if (!p) break;
        this.pending.delete(rk);
        if (p.timer) clearTimeout(p.timer);
        const status = Boolean(payload.status);
        if (status) {
          const result = payload.result;
          const json = result == null ? "{}" : typeof result === "string" ? result : JSON.stringify(result);
          p.resolve(json);
        } else {
          p.reject(new Error(String(payload.errorMessage || "插件调用失败")));
        }
        break;
      }
    }
  }
  /** 网络请求桥（request action） */
  handleNativeRequest(payload) {
    const rk = String(payload.requestKey || "");
    const url = String(payload.url || "");
    const options = payload.options || {};
    const method = String(options.method || "GET").toUpperCase();
    const headers = options.headers || {};
    const body = options.body == null ? "" : String(options.body);
    let u;
    try {
      u = new URL$1(url);
    } catch {
      this.respondToJs(rk, { error: "URL 非法" });
      return;
    }
    const isHttps = u.protocol === "https:";
    const mod = isHttps ? https : http;
    const req = mod.request(
      u,
      {
        method,
        headers: {
          ...headers,
          "User-Agent": headers["User-Agent"] || "LGMusic/2.0.0"
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          this.respondToJs(rk, {
            response: {
              statusCode: res.statusCode || 0,
              statusMessage: res.statusMessage || "",
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf-8")
            }
          });
        });
      }
    );
    this.pendingRequests.set(rk, () => req.destroy());
    req.on("error", (err) => {
      this.pendingRequests.delete(rk);
      this.respondToJs(rk, { error: err.message || "网络请求失败" });
    });
    if (body) req.write(body);
    req.end();
  }
  respondToJs(rk, data) {
    this.dispatchNative("response", {
      requestKey: rk,
      ...data.error ? { error: data.error } : {},
      ...data.response ? { response: data.response } : {}
    });
  }
  dispose() {
    this.disposed = true;
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error("音源已切换"));
    }
    this.pending.clear();
    for (const t of this.timeoutTimers.values()) clearTimeout(t);
    this.timeoutTimers.clear();
    this.ctx = null;
    this.loadedName = null;
  }
}
let runtime = null;
function listPluginSources() {
  const dir = sourcesDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => ({
    fileName: f,
    name: f.replace(/\.js$/, ""),
    importedAt: fs.statSync(join$1(dir, f)).mtimeMs
  }));
}
function loadPluginRuntime(fileName) {
  if (!runtime) runtime = new PluginSandbox();
  runtime.load(fileName);
  return fileName;
}
function getLoadedPluginRuntime() {
  return runtime?.name ?? null;
}
function callPluginRuntime(action, payload) {
  if (!runtime) return Promise.reject(new Error("音源未加载"));
  return runtime.callPlugin(action, payload);
}
const VITE_DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL;
const RENDERER_DIST = app.isPackaged ? join$1(app.getAppPath(), "dist") : join$1(process.env.APP_ROOT || path.dirname(__dirname, ".."), "dist");
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
    frame: false,
    backgroundColor: "#f6f7f9",
    webPreferences: {
      preload: join$1(__dirname, "../preload/index.mjs"),
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
    void mainWindow.loadFile(join$1(__dirname, "../renderer/index.html"));
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
  const iconPath = join$1(process.env.VITE_PUBLIC || RENDERER_DIST, "icon.png");
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
      preload: join$1(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  });
  lyricWindow.setBackgroundColor("#00000000");
  if (VITE_DEV_SERVER_URL) {
    void lyricWindow.loadURL(`${VITE_DEV_SERVER_URL}/desktop-lyric.html`);
  } else {
    void lyricWindow.loadFile(join$1(RENDERER_DIST, "desktop-lyric.html"));
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
    const { createHash: createHash2, createCipheriv: createCipheriv2 } = await import("node:crypto");
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
    const cipher = createCipheriv2("aes-128-ecb", Buffer.from(secret), null);
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
  ipcMain.handle("mv-list", async (_e, input) => wyMvList(Number(input?.page) || 1, Number(input?.limit) || 24));
  ipcMain.handle("mv-url", async (_e, input) => wyMvUrl(Number(input?.id) || 0));
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
  ipcMain.handle("settings-get", () => getConfig());
  ipcMain.handle("settings-set", (_e, patch) => setConfig(patch));
  ipcMain.handle("source-list", () => listSources());
  ipcMain.handle("source-import", () => importSourceDialog(mainWindow ?? void 0));
  ipcMain.handle("source-delete", (_e, fileName) => deleteSource(String(fileName)));
  ipcMain.handle("plugin-list", () => listPluginSources());
  ipcMain.handle("plugin-load", (_e, fileName) => loadPluginRuntime(String(fileName)));
  ipcMain.handle("plugin-loaded", () => getLoadedPluginRuntime());
  ipcMain.handle(
    "plugin-call",
    (_e, input) => callPluginRuntime(String(input?.action || ""), input?.payload || {})
  );
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
