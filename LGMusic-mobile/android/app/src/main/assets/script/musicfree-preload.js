'use strict'

/**
 * MusicFree 插件运行时（QuickJS 沙箱）。
 *
 * MusicFree 插件是 CommonJS 模块，通过 `module.exports` 暴露
 * `getMediaSource` 等方法，用 `require` 获取依赖。本预载脚本提供
 * 最小 CommonJS 外壳和受控依赖实现，只接管播放地址解析。
 *
 * 与 LX 运行时的差异：
 * - LX 是事件协议，插件注册 `globalThis.lx.on('request')`。
 * - MusicFree 是模块协议，宿主主动调用导出的方法。
 *
 * 网络请求仍然复用宿主提供的 `request / response / cancelRequest` 桥，
 * 插件不接触 React Native 全局对象，也拿不到文件系统。
 */

if (typeof globalThis.URLSearchParams !== 'function') {
  globalThis.URLSearchParams = class URLSearchParams {
    constructor(init = '') {
      this._entries = []
      if (typeof init === 'string') {
        const source = init.startsWith('?') ? init.slice(1) : init
        if (source) {
          for (const part of source.split('&')) {
            if (!part) continue
            const index = part.indexOf('=')
            const key = index >= 0 ? part.slice(0, index) : part
            const value = index >= 0 ? part.slice(index + 1) : ''
            this.append(decodeURIComponent(key), decodeURIComponent(value))
          }
        }
      } else if (Array.isArray(init)) {
        for (const pair of init) this.append(pair[0], pair[1])
      } else if (init && typeof init === 'object') {
        for (const key of Object.keys(init)) this.append(key, init[key])
      }
    }

    append(key, value) {
      this._entries.push([String(key), String(value)])
    }

    set(key, value) {
      const normalizedKey = String(key)
      this.delete(normalizedKey)
      this.append(normalizedKey, value)
    }

    delete(key) {
      const normalizedKey = String(key)
      this._entries = this._entries.filter(
        ([entryKey]) => entryKey !== normalizedKey,
      )
    }

    get(key) {
      const normalizedKey = String(key)
      const entry = this._entries.find(
        ([entryKey]) => entryKey === normalizedKey,
      )
      return entry ? entry[1] : null
    }

    has(key) {
      return this.get(key) !== null
    }

    toString() {
      return this._entries
        .map(
          ([key, value]) =>
            `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
        )
        .join('&')
    }
  }
}

if (typeof Promise.any !== 'function') {
  Promise.any = promises =>
    new Promise((resolve, reject) => {
      const items = Array.from(promises || [])
      if (items.length === 0) {
        reject(new Error('All promises were rejected'))
        return
      }
      let rejectedCount = 0
      items.forEach(promise => {
        Promise.resolve(promise).then(resolve, () => {
          rejectedCount += 1
          if (rejectedCount === items.length) {
            reject(new Error('All promises were rejected'))
          }
        })
      })
    })
}

// QuickJS 只提供 ECMAScript 标准内建，没有 Web 的 URL。
// 这里补一个最小实现，覆盖插件里常见的 new URL(...) / searchParams 用法。
if (typeof globalThis.URL !== 'function') {
  const URL_PATTERN =
    /^([a-zA-Z][a-zA-Z0-9+.-]*:)\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/
  globalThis.URL = class URL {
    constructor(input, base) {
      let full = String(input == null ? '' : input)
      if (!URL_PATTERN.test(full) && base) {
        const baseMatch = String(base).match(
          /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*)([^?#]*)/,
        )
        if (baseMatch) {
          const baseDir = baseMatch[2].replace(/[^/]*$/, '')
          full =
            baseMatch[1] +
            (baseDir || '/') +
            full.replace(/^\.?\//, '')
        }
      }
      const match = full.match(URL_PATTERN)
      if (!match) {
        throw new TypeError(`Invalid URL: ${input}`)
      }
      this.protocol = match[1]
      this.host = match[2]
      this.pathname = match[3] || '/'
      const query = match[4] ? match[4].slice(1) : ''
      this.hash = match[5] || ''
      this.searchParams = new URLSearchParams(query)
    }

    get search() {
      const query = this.searchParams.toString()
      return query ? `?${query}` : ''
    }

    set search(value) {
      const source = String(value || '')
      this.searchParams = new URLSearchParams(
        source.startsWith('?') ? source.slice(1) : source,
      )
    }

    get origin() {
      return `${this.protocol}//${this.host}`
    }

    toString() {
      return `${this.protocol}//${this.host}${this.pathname}${this.search}${this.hash}`
    }

    toJSON() {
      return this.toString()
    }
  }
}

globalThis.musicfree_setup = (
  key,
  rawScript,
  rawUserVariables,
  rawAppVersion,
) => {
  delete globalThis.musicfree_setup
  const _nativeCall = globalThis.__lx_native_call__
  delete globalThis.__lx_native_call__
  const checkLength = (str, length = 1048576) => {
    if (typeof str === 'string' && str.length > length) {
      throw new Error('Input too long')
    }
    return str
  }

  const nativeFunc = globalThis.__lx_native_call__set_timeout
  delete globalThis.__lx_native_call__set_timeout
  // 本运行时不需要 LX 的加密/编码原生工具，直接移除避免暴露给插件。
  for (const name of [
    '__lx_native_call__utils_str2b64',
    '__lx_native_call__utils_b642buf',
    '__lx_native_call__utils_str2md5',
    '__lx_native_call__utils_aes_encrypt',
    '__lx_native_call__utils_rsa_encrypt',
  ]) {
    delete globalThis[name]
  }

  const nativeCall = (action, data) => {
    const payload = JSON.stringify(data)
    checkLength(payload, 4194304)
    _nativeCall(key, action, payload)
  }

  let userVariables = {}
  try {
    const parsed = JSON.parse(String(rawUserVariables || '{}'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      userVariables = Object.keys(parsed).reduce((result, variableKey) => {
        if (variableKey) {
          const value = parsed[variableKey]
          result[variableKey] =
            typeof value === 'string'
              ? value
              : value == null
                ? ''
                : String(value)
        }
        return result
      }, {})
    }
  } catch {
    userVariables = {}
  }
  const appVersion = String(rawAppVersion || '')
  const env = {
    getUserVariables: () => userVariables,
    get userVariables() {
      return this.getUserVariables()
    },
    appVersion,
    os: 'android',
    lang: 'zh-CN',
  }
  const process = {
    platform: 'android',
    version: appVersion,
    env,
  }

  // 部分旧版听书插件只保留了 getToneId/getVoiceId 调用，却漏掉函数定义。
  // 提供同名全局兜底；插件内部若声明了同名函数，仍会优先使用自身实现。
  globalThis.getToneId = () => {
    const raw = userVariables.toneId || userVariables.tone_id || ''
    const parsed = parseInt(String(raw), 10)
    return Number.isNaN(parsed) ? '' : parsed
  }
  globalThis.getVoiceId = () => {
    const raw = userVariables.voiceId || userVariables.voice_id || ''
    const parsed = parseInt(String(raw), 10)
    return Number.isNaN(parsed) ? '' : String(parsed)
  }

  const callbacks = new Map()
  let timeoutId = 0
  const _setTimeout = (callback, timeout = 0, ...params) => {
    if (typeof callback !== 'function') {
      throw new Error('callback required a function')
    }
    if (typeof timeout !== 'number' || timeout < 0) {
      throw new Error('timeout required a number')
    }
    const id = timeoutId++
    callbacks.set(id, {callback, params})
    nativeFunc(id, parseInt(timeout))
    return id
  }
  const _clearTimeout = id => {
    callbacks.delete(id)
  }
  const handleSetTimeout = id => {
    const target = callbacks.get(id)
    if (!target) return
    callbacks.delete(id)
    target.callback(...target.params)
  }

  const NATIVE_EVENTS_NAMES = {
    init: 'init',
    request: 'request',
    cancelRequest: 'cancelRequest',
    response: 'response',
  }

  const requestQueue = new Map()

  const sendNativeRequest = (url, options, callback) => {
    const requestKey = Math.random().toString()
    const requestInfo = {
      aborted: false,
      abort: () => {
        nativeCall(NATIVE_EVENTS_NAMES.cancelRequest, requestKey)
      },
    }
    requestQueue.set(requestKey, {callback, requestInfo})
    nativeCall(NATIVE_EVENTS_NAMES.request, {requestKey, url, options})
    return requestInfo
  }

  const handleNativeResponse = ({requestKey, error, response}) => {
    const targetRequest = requestQueue.get(requestKey)
    if (!targetRequest) return
    requestQueue.delete(requestKey)
    targetRequest.requestInfo.aborted = true
    if (error == null) targetRequest.callback(null, response)
    else targetRequest.callback(new Error(error), null)
  }

  // ---------- 受控依赖实现 ----------

  const toUint8Array = input => {
    if (input instanceof Uint8Array) return input
    if (Array.isArray(input)) return new Uint8Array(input)
    if (input && typeof input.length === 'number') {
      return new Uint8Array(Array.prototype.slice.call(input))
    }
    return new Uint8Array(0)
  }

  const bytesToString = bytes => {
    let result = ''
    let i = 0
    while (i < bytes.length) {
      const byte = bytes[i]
      if (byte < 128) {
        result += String.fromCharCode(byte)
        i += 1
      } else if (byte >= 192 && byte < 224) {
        result += String.fromCharCode(
          ((byte & 31) << 6) | (bytes[i + 1] & 63),
        )
        i += 2
      } else if (byte >= 224 && byte < 240) {
        result += String.fromCharCode(
          ((byte & 15) << 12) |
            ((bytes[i + 1] & 63) << 6) |
            (bytes[i + 2] & 63),
        )
        i += 3
      } else {
        result += String.fromCharCode(0xfffd)
        i += 4
      }
    }
    return result
  }

  const stringToBytes = input => {
    const text = String(input)
    const bytes = []
    for (let i = 0; i < text.length; i += 1) {
      let code = text.charCodeAt(i)
      if (code < 0x80) {
        bytes.push(code)
      } else if (code < 0x800) {
        bytes.push((code >> 6) | 0xc0, (code & 63) | 0x80)
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(i + 1)
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000
        i += 1
        bytes.push(
          (code >> 18) | 0xf0,
          ((code >> 12) & 63) | 0x80,
          ((code >> 6) & 63) | 0x80,
          (code & 63) | 0x80,
        )
      } else {
        bytes.push(
          (code >> 12) | 0xe0,
          ((code >> 6) & 63) | 0x80,
          (code & 63) | 0x80,
        )
      }
    }
    return new Uint8Array(bytes)
  }

  const BASE64_CHARS =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

  const bytesToBase64 = bytes => {
    let result = ''
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i]
      const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
      const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
      result += BASE64_CHARS[b0 >> 2]
      result += BASE64_CHARS[((b0 & 3) << 4) | (b1 >> 4)]
      result +=
        i + 1 < bytes.length
          ? BASE64_CHARS[((b1 & 15) << 2) | (b2 >> 6)]
          : '='
      result += i + 2 < bytes.length ? BASE64_CHARS[b2 & 63] : '='
    }
    return result
  }

  const base64ToBytes = input => {
    const text = String(input).replace(/[^A-Za-z0-9+/=]/g, '')
    const output = []
    for (let i = 0; i < text.length; i += 4) {
      const enc0 = BASE64_CHARS.indexOf(text[i])
      const enc1 = BASE64_CHARS.indexOf(text[i + 1])
      const enc2 = BASE64_CHARS.indexOf(text[i + 2])
      const enc3 = BASE64_CHARS.indexOf(text[i + 3])
      output.push((enc0 << 2) | (enc1 >> 4))
      if (enc2 !== -1) output.push(((enc1 & 15) << 4) | (enc2 >> 2))
      if (enc3 !== -1) output.push(((enc2 & 3) << 6) | enc3)
    }
    return new Uint8Array(output)
  }

  class MusicFreeBuffer extends Uint8Array {
    toString(encoding) {
      const normalized = String(encoding || 'utf8').toLowerCase()
      if (normalized === 'base64') {
        return bytesToBase64(this)
      }
      if (normalized === 'hex') {
        return Array.from(this)
          .map(byte => byte.toString(16).padStart(2, '0'))
          .join('')
      }
      if (normalized === 'binary' || normalized === 'latin1') {
        return Array.from(this)
          .map(byte => String.fromCharCode(byte))
          .join('')
      }
      return bytesToString(this)
    }

    static from(input, encoding) {
      if (typeof input === 'string') {
        const normalized = String(encoding || 'utf8').toLowerCase()
        if (normalized === 'base64') return new MusicFreeBuffer(base64ToBytes(input))
        if (normalized === 'hex') {
          const bytes = []
          for (let i = 0; i < input.length; i += 2) {
            bytes.push(parseInt(input.slice(i, i + 2), 16) || 0)
          }
          return new MusicFreeBuffer(bytes)
        }
        return new MusicFreeBuffer(stringToBytes(input))
      }
      return new MusicFreeBuffer(toUint8Array(input))
    }

    static alloc(size) {
      return new MusicFreeBuffer(Number(size) || 0)
    }

    static isBuffer(value) {
      return value instanceof Uint8Array
    }
  }

  const htmlEntities = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u00a0',
  }
  const decodeEntities = value =>
    String(value).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
      if (entity[0] === '#') {
        const isHex = entity[1] === 'x' || entity[1] === 'X'
        const code = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10)
        return Number.isFinite(code) ? String.fromCharCode(code) : match
      }
      return Object.prototype.hasOwnProperty.call(htmlEntities, entity)
        ? htmlEntities[entity]
        : match
    })
  const he = {
    decode: decodeEntities,
    encode: value =>
      String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;'),
    decodeEntity: decodeEntities,
  }

  const buildQuery = params => {
    if (!params || typeof params !== 'object') return ''
    const search = new URLSearchParams()
    Object.keys(params).forEach(key => {
      const value = params[key]
      if (value === undefined || value === null) return
      if (Array.isArray(value)) {
        value.forEach(item => search.append(key, String(item)))
      } else {
        search.append(key, String(value))
      }
    })
    return search.toString()
  }

  const axiosRequest = config => {
    const options = config && typeof config === 'object' ? config : {}
    const method = String(options.method || 'get').toLowerCase()
    let url = String(options.url || '')
    const query = buildQuery(options.params)
    if (query) {
      url += url.includes('?') ? `&${query}` : `?${query}`
    }
    const binary = options.responseType === 'arraybuffer'
    const requestOptions = {
      method,
      headers: options.headers || {},
      binary,
    }
    if (options.timeout) {
      requestOptions.timeout = Math.min(Number(options.timeout), 60000)
    }
    if (options.data !== undefined) {
      requestOptions.body = options.data
    }

    return new Promise((resolve, reject) => {
      if (!url) {
        reject(new Error('axios: url is required'))
        return
      }
      sendNativeRequest(url, requestOptions, (error, response) => {
        if (error) {
          reject(error)
          return
        }
        const data = binary ? toUint8Array(response.body) : response.body
        resolve({
          data,
          status: response.statusCode,
          statusText: response.statusMessage,
          headers: response.headers,
          config: options,
          request: {},
        })
      })
    })
  }
  axiosRequest.get = (url, config) =>
    axiosRequest({...(config || {}), url, method: 'get'})
  axiosRequest.post = (url, data, config) =>
    axiosRequest({...(config || {}), url, data, method: 'post'})
  axiosRequest.put = (url, data, config) =>
    axiosRequest({...(config || {}), url, data, method: 'put'})
  axiosRequest.delete = (url, config) =>
    axiosRequest({...(config || {}), url, method: 'delete'})
  axiosRequest.head = (url, config) =>
    axiosRequest({...(config || {}), url, method: 'head'})
  axiosRequest.create = () => axiosRequest
  axiosRequest.default = axiosRequest

  const bundledModules =
    globalThis.__musicfreeDependencies &&
    typeof globalThis.__musicfreeDependencies === 'object'
      ? globalThis.__musicfreeDependencies
      : null
  if (!bundledModules) {
    throw new Error('MusicFree 依赖包未加载')
  }

  const MODULES = {
    ...bundledModules,
    axios: axiosRequest,
    he,
    buffer: {Buffer: MusicFreeBuffer},
    // 少数插件直接 `require('url')` / `require('querystring')`，
    // 这里用已有实现补位，避免插件因缺少 Node 内建模块而整体加载失败。
    url:
      typeof globalThis.URL === 'function'
        ? {URL: globalThis.URL, URLSearchParams}
        : {URLSearchParams},
    querystring: {
      stringify: params => {
        if (!params || typeof params !== 'object') return ''
        const parts = []
        Object.keys(params).forEach(key => {
          const value = params[key]
          if (value === undefined || value === null) return
          if (Array.isArray(value)) {
            value.forEach(item => {
              parts.push(
                `${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`,
              )
            })
          } else {
            parts.push(
              `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
            )
          }
        })
        return parts.join('&')
      },
      parse: value => {
        const result = {}
        const source = String(value || '').replace(/^\?/, '')
        if (!source) return result
        source.split('&').forEach(part => {
          if (!part) return
          const index = part.indexOf('=')
          const key = decodeURIComponent(
            index >= 0 ? part.slice(0, index) : part,
          )
          const entryValue = decodeURIComponent(
            index >= 0 ? part.slice(index + 1) : '',
          )
          if (
            Object.prototype.hasOwnProperty.call(result, key) &&
            Array.isArray(result[key])
          ) {
            result[key].push(entryValue)
          } else if (Object.prototype.hasOwnProperty.call(result, key)) {
            result[key] = [result[key], entryValue]
          } else {
            result[key] = entryValue
          }
        })
        return result
      },
      escape: encodeURIComponent,
      unescape: decodeURIComponent,
    },
  }

  const UNSUPPORTED_MODULES = ['crypto']

  const musicfreeRequire = name => {
    const key = String(name || '').trim()
    if (Object.prototype.hasOwnProperty.call(MODULES, key)) {
      return MODULES[key]
    }
    if (UNSUPPORTED_MODULES.indexOf(key) >= 0) {
      throw new Error(`MusicFree 插件依赖 ${key} 暂不受支持`)
    }
    throw new Error(`MusicFree 插件依赖 ${key} 未提供`)
  }

  // ---------- 插件加载 ----------

  const moduleObject = {exports: {}}
  const exportsObject = moduleObject.exports

  const compilePlugin = source => {
    // eslint-disable-next-line no-new-func
    return new Function(
      'require',
      'module',
      'exports',
      'console',
      'globalThis',
      'env',
      'URL',
      'process',
      `${source}\n;return module.exports;`,
    )
  }

  let pluginExports = null
  try {
    const factory = compilePlugin(rawScript)
    const result = factory(
      musicfreeRequire,
      moduleObject,
      exportsObject,
      console,
      globalThis,
      env,
      typeof globalThis.URL === 'function' ? globalThis.URL : undefined,
      process,
    )
    const exported = result || moduleObject.exports
    pluginExports =
      exported &&
      typeof exported === 'object' &&
      exported.default &&
      typeof exported.default === 'object'
        ? exported.default
        : exported
  } catch (error) {
    nativeCall(NATIVE_EVENTS_NAMES.init, {
      status: false,
      errorMessage: error && error.message ? error.message : '插件加载失败',
    })
    return
  }

  if (!pluginExports || typeof pluginExports !== 'object') {
    nativeCall(NATIVE_EVENTS_NAMES.init, {
      status: false,
      errorMessage: '插件未导出有效模块',
    })
    return
  }

  const normalizedUserVariables = Array.isArray(pluginExports.userVariables)
    ? pluginExports.userVariables.reduce((result, item) => {
        const variableKey = String(item && item.key ? item.key : '').trim()
        if (
          !variableKey ||
          result.some(variable => variable.key === variableKey)
        ) {
          return result
        }
        const name = String(item && item.name ? item.name : '').trim()
        const hint = String(item && item.hint ? item.hint : '').trim()
        result.push({
          key: variableKey,
          ...(name ? {name} : {}),
          ...(hint ? {hint} : {}),
        })
        return result
      }, [])
    : []

  const supportedSearchTypes = (() => {
    const declared =
      pluginExports.supportedSearchTypes || pluginExports.supportedSearchType
    if (!Array.isArray(declared)) return []
    return Array.from(
      new Set(
        declared
          .map(item => String(item || '').trim().toLowerCase())
          .filter(Boolean),
      ),
    )
  })()

  nativeCall(NATIVE_EVENTS_NAMES.init, {
    status: true,
    info: {
      platform: String(pluginExports.platform || ''),
      version: String(pluginExports.version || ''),
      author: String(pluginExports.author || ''),
      homepage: String(pluginExports.homepage || ''),
      srcUrl: String(pluginExports.srcUrl || ''),
      supportedQualities: Array.isArray(pluginExports.supportedQualities)
        ? pluginExports.supportedQualities.map(String)
        : [],
      userVariables: normalizedUserVariables,
      hasGetMediaSource: typeof pluginExports.getMediaSource === 'function',
      hasSearchMusic:
        typeof pluginExports.searchMusic === 'function' ||
        typeof pluginExports.search === 'function',
      hasGetMusicInfo: typeof pluginExports.getMusicInfo === 'function',
      hasGetAlbumInfo: typeof pluginExports.getAlbumInfo === 'function',
      supportedSearchTypes,
    },
  })

  const createResponder = data => {
    const payload = data || {}
    const requestKey = payload.requestKey
    return (status, result, errorMessage) => {
      nativeCall(NATIVE_EVENTS_NAMES.response, {
        requestKey,
        status,
        result: status ? result : undefined,
        errorMessage: status ? undefined : errorMessage,
      })
    }
  }

  const handleGetMediaSource = data => {
    const payload = data || {}
    const respond = createResponder(payload)
    if (typeof pluginExports.getMediaSource !== 'function') {
      respond(false, null, '插件不支持 getMediaSource')
      return
    }
    Promise.resolve(
      pluginExports.getMediaSource(payload.musicItem, payload.quality),
    )
      .then(result => {
        if (!result || typeof result.url !== 'string') {
          respond(false, null, '插件未返回有效播放地址')
          return
        }
        // 汽水等插件会返回 CENC 的 cek 字段，必须原样交给原生桥接层，
        // 由应用层按来源二次校验后再决定是否启用本机解密。
        const rawCek = result.cek == null ? '' : String(result.cek).trim()
        const cek = /^[0-9a-fA-F]{32}$/.test(rawCek) ? rawCek : ''
        const encryption =
          result.encryption == null
            ? ''
            : String(result.encryption).trim().toLowerCase()
        respond(true, {
          url: result.url,
          headers: result.headers,
          userAgent: result.userAgent,
          quality: result.quality,
          ...(cek ? {cek} : {}),
          ...(cek && encryption === 'cenc' ? {encryption: 'cenc'} : {}),
        })
      })
      .catch(error => {
        respond(
          false,
          null,
          error && error.message ? error.message : '播放解析失败',
        )
      })
  }

  const handleSearchMusic = data => {
    const payload = data || {}
    const respond = createResponder(payload)
    const search =
      typeof pluginExports.searchMusic === 'function'
        ? pluginExports.searchMusic
        : typeof pluginExports.search === 'function'
        ? pluginExports.search
        : null
    if (!search) {
      respond(false, null, '插件不支持歌曲搜索')
      return
    }
    const query = String(payload.query || '').trim()
    const page = Math.max(1, Number(payload.page) || 1)
    const type = String(payload.type || 'music')
    if (!query) {
      respond(true, {isEnd: true, data: []})
      return
    }
    Promise.resolve(search.call(pluginExports, query, page, type))
      .then(result => {
        respond(true, result)
      })
      .catch(error => {
        respond(
          false,
          null,
          error && error.message ? error.message : '搜索失败',
        )
      })
  }

  const handleGetMusicInfo = data => {
    const payload = data || {}
    const respond = createResponder(payload)
    if (typeof pluginExports.getMusicInfo !== 'function') {
      respond(false, null, '插件不支持 getMusicInfo')
      return
    }
    Promise.resolve(pluginExports.getMusicInfo(payload.musicItem))
      .then(result => {
        respond(true, result)
      })
      .catch(error => {
        respond(
          false,
          null,
          error && error.message ? error.message : '获取歌曲信息失败',
        )
      })
  }

  const handleGetAlbumInfo = data => {
    const payload = data || {}
    const respond = createResponder(payload)
    if (typeof pluginExports.getAlbumInfo !== 'function') {
      respond(false, null, '插件不支持 getAlbumInfo')
      return
    }
    Promise.resolve(
      pluginExports.getAlbumInfo(payload.albumItem, payload.page),
    )
      .then(result => {
        respond(true, result)
      })
      .catch(error => {
        respond(
          false,
          null,
          error && error.message ? error.message : '获取专辑信息失败',
        )
      })
  }

  const jsCall = (action, data) => {
    switch (action) {
      case '__run_error__':
        return
      case '__set_timeout__':
        handleSetTimeout(data)
        return
      case 'response':
        handleNativeResponse(data)
        return
      case 'getMediaSource':
        handleGetMediaSource(data)
        return
      case 'searchMusic':
        handleSearchMusic(data)
        return
      case 'getMusicInfo':
        handleGetMusicInfo(data)
        return
      case 'getAlbumInfo':
        handleGetAlbumInfo(data)
        return
    }
    return `Unknown action: ${action}`
  }

  Object.defineProperty(globalThis, '__lx_native__', {
    enumerable: false,
    configurable: false,
    writable: false,
    value: (_key, action, data) => {
      if (key !== _key) return 'Invalid key'
      return data == null ? jsCall(action) : jsCall(action, JSON.parse(data))
    },
  })

  globalThis.setTimeout = _setTimeout
  globalThis.clearTimeout = _clearTimeout

  console.log('MusicFree preload finished.')
}
