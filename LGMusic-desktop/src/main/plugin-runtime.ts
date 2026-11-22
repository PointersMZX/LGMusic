/**
 * 桌面端外置音源插件运行时（MusicFree 插件格式，node:vm 沙箱）。
 *
 * 本体不内置任何音源：音源脚本由用户在设置中导入（userData/sources/*.js），
 * 运行于独立 vm context，复用与安卓端相同的 musicfree-dependencies + musicfree-preload。
 *
 * 桥契约（与安卓 PluginSourceRuntime 一致）：
 * - JS→宿主：__lx_native_call__(key, action, payload)
 *     action = request / cancelRequest / __set_timeout__
 * - 宿主→JS：__lx_native__(key, action, dataJson)
 *     action = response（网络回灌 {requestKey,error,response} 与
 *               插件方法结果回灌 {requestKey,status,result,errorMessage} 共通道，按 status 区分）
 *            / __set_timeout__（data = timeoutId）
 */
import vm from 'node:vm'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'
import { app } from 'electron'
import { join } from 'node:path'
// 以源码字符串打进 bundle（构建时打包，避免运行时依赖插件目录拷贝）
import depsSource from './plugin-assets/musicfree-dependencies.js?raw'
import preloadSource from './plugin-assets/musicfree-preload.js?raw'

const sourcesDir = (): string => join(app.getPath('userData'), 'sources')

interface PendingMethod {
  resolve: (value: string) => void
  reject: (err: Error) => void
  timer?: NodeJS.Timeout
}

/** 一次插件运行时：单插件独占（换插件重建，setup 一次性） */
class PluginSandbox {
  private ctx: vm.Context | null = null
  private sessionKey = ''
  private loadedName: string | null = null
  private readonly pending = new Map<string, PendingMethod>()
  private readonly pendingRequests = new Map<string, () => void>()
  private readonly timeoutTimers = new Map<number, NodeJS.Timeout>()
  private timeoutSeq = 0
  private disposed = false

  get name(): string | null {
    return this.loadedName
  }

  load(fileName: string): void {
    if (this.loadedName === fileName && this.ctx) return
    this.dispose()
    this.ctx = this.createContext()
    this.loadedName = fileName
    const script = fs.readFileSync(join(sourcesDir(), fileName), 'utf-8')
    this.sessionKey = crypto.randomUUID()
    const setupCall =
      `globalThis.musicfree_setup(` +
      `${JSON.stringify(this.sessionKey)},` +
      `${JSON.stringify(script)},` +
      `'{}',` +
      `${JSON.stringify('2.0.0')})`
    vm.runInContext(setupCall, this.ctx, { filename: fileName })
  }

  private createContext(): vm.Context {
    const sandbox: Record<string, unknown> = {
      console,
      Buffer,
      URL,
      setTimeout: (fn: (...a: unknown[]) => void, ms: number, ...rest: unknown[]) => {
        const id = ++this.timeoutSeq
        const t = setTimeout(() => {
          this.timeoutTimers.delete(id)
          this.dispatchNative('__set_timeout__', id)
          fn(...rest)
        }, Math.max(0, Number(ms) || 0))
        this.timeoutTimers.set(id, t)
        return id
      },
      clearTimeout: (id: number) => {
        const t = this.timeoutTimers.get(id)
        if (t) clearTimeout(t)
        this.timeoutTimers.delete(id)
      },
      // JS→宿主桥（网络）
      __lx_native_call__: (key: string, action: string, payload: string) => {
        this.dispatchFromJs(key, action, payload)
      },
      __lx_native_call__set_timeout: (id: number, ms: number) => {
        const t = setTimeout(() => {
          this.timeoutTimers.delete(id)
          this.dispatchNative('__set_timeout__', id)
        }, Math.max(0, Number(ms) || 0))
        this.timeoutTimers.set(id, t)
        return id
      },
    }
    // 给 vm 里的 globalThis 指向自身（preload 用 globalThis.URL 等）
    sandbox.globalThis = sandbox
    const ctx = vm.createContext(sandbox, { name: 'musicfree-plugin' })
    vm.runInContext(depsSource, ctx, { filename: 'musicfree-dependencies.js' })
    vm.runInContext(preloadSource, ctx, { filename: 'musicfree-preload.js' })
    return ctx
  }

  /** 调用插件方法（searchMusic / getMediaSource / getMusicInfo / getAlbumInfo） */
  callPlugin(action: string, payload: Record<string, string>): Promise<string> {
    const ctx = this.ctx
    if (!ctx) return Promise.reject(new Error('音源未加载'))
    const key = crypto.randomUUID()
    const data: Record<string, unknown> = { requestKey: key }
    for (const [k, v] of Object.entries(payload)) {
      // 值若本身是 JSON 对象/数组（如 musicItem），还原为结构体传给插件
      if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
        try {
          data[k] = JSON.parse(v)
          continue
        } catch {
          /* 保留原字符串 */
        }
      }
      data[k] = v
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        reject(new Error('插件调用超时'))
      }, 30000)
      this.pending.set(key, { resolve, reject, timer })
      try {
        const fn = vm.runInContext('globalThis.__lx_native__', ctx)
        ;(fn as (k: string, a: string, d: string) => void)(this.sessionKey, action, JSON.stringify(data))
      } catch (err) {
        this.pending.delete(key)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** 宿主→JS 回灌 */
  private dispatchNative(action: string, value: unknown): void {
    if (!this.ctx || this.disposed) return
    try {
      const fn = vm.runInContext('globalThis.__lx_native__', this.ctx)
      ;(fn as (k: string, a: string, d: string) => void)(
        this.sessionKey,
        action,
        JSON.stringify(value)
      )
    } catch {
      /* 回灌失败忽略 */
    }
  }

  /** JS→宿主 分发 */
  private dispatchFromJs(key: string, action: string, data: string): void {
    if (key !== this.sessionKey) return
    let payload: Record<string, unknown> = {}
    try {
      payload = JSON.parse(data) as Record<string, unknown>
    } catch {
      payload = {}
    }
    switch (action) {
      case 'request':
        this.handleNativeRequest(payload as { requestKey: string } & Record<string, unknown>)
        break
      case 'cancelRequest': {
        const rk = String(payload.requestKey || '')
        const cancel = this.pendingRequests.get(rk)
        if (cancel) cancel()
        this.pendingRequests.delete(rk)
        break
      }
      case '__set_timeout__':
        break
      case 'response': {
        const rk = String(payload.requestKey || '')
        const p = this.pending.get(rk)
        if (!p) break
        this.pending.delete(rk)
        if (p.timer) clearTimeout(p.timer)
        const status = Boolean(payload.status)
        if (status) {
          const result = payload.result
          const json =
            result == null
              ? '{}'
              : typeof result === 'string'
                ? result
                : JSON.stringify(result)
          p.resolve(json)
        } else {
          p.reject(new Error(String(payload.errorMessage || '插件调用失败')))
        }
        break
      }
    }
  }

  /** 网络请求桥（request action） */
  private handleNativeRequest(payload: { requestKey: string } & Record<string, unknown>): void {
    const rk = String(payload.requestKey || '')
    const url = String(payload.url || '')
    const options = (payload.options || {}) as Record<string, unknown>
    const method = String(options.method || 'GET').toUpperCase()
    const headers = (options.headers || {}) as Record<string, string>
    const body = options.body == null ? '' : String(options.body)

    let u: URL
    try {
      u = new URL(url)
    } catch {
      this.respondToJs(rk, { error: 'URL 非法' })
      return
    }
    const isHttps = u.protocol === 'https:'
    const mod = isHttps ? https : http
    const req = mod.request(
      u,
      {
        method,
        headers: {
          ...(headers as Record<string, string>),
          'User-Agent': headers['User-Agent'] || 'LGMusic/2.0.0'
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          this.respondToJs(rk, {
            response: {
              statusCode: res.statusCode || 0,
              statusMessage: res.statusMessage || '',
              headers: res.headers as Record<string, string>,
              body: Buffer.concat(chunks).toString('utf-8')
            }
          })
        })
      }
    )
    this.pendingRequests.set(rk, () => req.destroy())
    req.on('error', (err) => {
      this.pendingRequests.delete(rk)
      this.respondToJs(rk, { error: err.message || '网络请求失败' })
    })
    if (body) req.write(body)
    req.end()
  }

  private respondToJs(
    rk: string,
    data: { error?: string; response?: Record<string, unknown> }
  ): void {
    this.dispatchNative('response', {
      requestKey: rk,
      ...(data.error ? { error: data.error } : {}),
      ...(data.response ? { response: data.response } : {})
    })
  }

  dispose(): void {
    this.disposed = true
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(new Error('音源已切换'))
    }
    this.pending.clear()
    for (const t of this.timeoutTimers.values()) clearTimeout(t)
    this.timeoutTimers.clear()
    this.ctx = null
    this.loadedName = null
  }
}

let runtime: PluginSandbox | null = null

export function listPluginSources(): Array<{ fileName: string; name: string; importedAt: number }> {
  const dir = sourcesDir()
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({
      fileName: f,
      name: f.replace(/\.js$/, ''),
      importedAt: fs.statSync(join(dir, f)).mtimeMs
    }))
}

export function loadPluginRuntime(fileName: string): string {
  if (!runtime) runtime = new PluginSandbox()
  runtime.load(fileName)
  return fileName
}

export function getLoadedPluginRuntime(): string | null {
  return runtime?.name ?? null
}

export function callPluginRuntime(
  action: string,
  payload: Record<string, string>
): Promise<string> {
  if (!runtime) return Promise.reject(new Error('音源未加载'))
  return runtime.callPlugin(action, payload)
}

export function disposePluginRuntime(): void {
  if (runtime) {
    runtime.dispose()
    runtime = null
  }
}

/** 切换音源后释放旧沙箱（loadPlugin 内部会重建） */
export function switchPluginSource(fileName: string): string {
  if (!runtime) runtime = new PluginSandbox()
  runtime.load(fileName)
  return fileName
}
