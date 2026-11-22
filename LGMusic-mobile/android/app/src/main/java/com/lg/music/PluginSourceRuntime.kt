package com.lg.music

import android.os.Handler
import android.os.HandlerThread
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.whl.quickjs.wrapper.JSCallFunction
import com.whl.quickjs.wrapper.QuickJSContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * PluginSourceRuntime —— 外置音源插件运行时（MusicFree 插件格式）。
 *
 * 本体不内置任何音源：音源脚本由用户在设置中导入（.js），运行于 QuickJS 沙箱
 * （assets/script 三件套：musicfree-dependencies + musicfree-preload + 插件源码）。
 *
 * 桥契约（musicfree-preload.js 约定）：
 * - JS→宿主：__lx_native_call__(key, action, payload)
 *     action = request / cancelRequest / __set_timeout__
 * - 宿主→JS：__lx_native__(key, action, dataJson)
 *     action = response（网络回灌 {requestKey,error,response} 与
 *               插件方法结果回灌 {requestKey,status,result,errorMessage} 共通道，按 status 区分）
 *            / __set_timeout__（data = timeoutId）
 */
class PluginSourceRuntime(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "PluginSourceRuntime"

  private val http: OkHttpClient by lazy {
    OkHttpClient.Builder()
      .connectTimeout(15, TimeUnit.SECONDS)
      .readTimeout(30, TimeUnit.SECONDS)
      .build()
  }

  /** QuickJS 必须单线程访问：所有 JS 操作派发到该线程 */
  private val jsThread = HandlerThread("plugin-js-runtime").also { it.start() }
  private val jsHandler = Handler(jsThread.looper)

  private var ctx: QuickJSContext? = null
  private var sessionKey: String = ""
  private var loadedPluginName: String? = null

  private val pendingRequests = HashMap<String, Call>()
  private val pendingMethodCalls = HashMap<String, Promise>()
  private val timeoutCalls = HashMap<Int, Runnable>()

  private val mainHandler = Handler(reactContext.mainLooper)

  // ---------------------------------------------------------------------------
  // RN 暴露方法
  // ---------------------------------------------------------------------------

  /** 已导入音源列表（来自用户导入，本体不内置） */
  @ReactMethod
  fun listSources(promise: Promise) {
    Thread {
      try {
        val dir = sourcesDir()
        val files = dir.listFiles { f -> f.extension == "js" } ?: arrayOf()
        val arr = Arguments.createArray()
        for (f in files) {
          val m = Arguments.createMap()
          m.putString("fileName", f.name)
          m.putString("name", f.nameWithoutExtension)
          m.putDouble("importedAt", f.lastModified().toDouble())
          arr.pushMap(m)
        }
        mainHandler.post { promise.resolve(arr) }
      } catch (e: Exception) {
        mainHandler.post { promise.reject("LIST_FAILED", e.message) }
      }
    }.start()
  }

  /** 通过 URL 导入音源脚本（保存到 filesDir/sources/） */
  @ReactMethod
  fun importSourceUrl(url: String, promise: Promise) {
    Thread {
      try {
        val req = Request.Builder().url(url).build()
        http.newCall(req).execute().use { resp ->
          if (!resp.isSuccessful) throw Exception("HTTP ${resp.code}")
          val body = resp.body?.string() ?: throw Exception("空内容")
          val dir = sourcesDir()
          val fileName = (url.substringBefore('?').substringAfterLast('/')
            .takeIf { it.endsWith(".js", true) } ?: "source-${System.currentTimeMillis()}.js")
          File(dir, fileName).writeText(body, Charsets.UTF_8)
          mainHandler.post { promise.resolve(fileName) }
        }
      } catch (e: Exception) {
        mainHandler.post { promise.reject("IMPORT_FAILED", e.message) }
      }
    }.start()
  }

  @ReactMethod
  fun deleteSource(fileName: String, promise: Promise) {
    try {
      val f = File(sourcesDir(), fileName)
      if (f.exists()) f.delete()
      mainHandler.post { promise.resolve(true) }
    } catch (e: Exception) {
      mainHandler.post { promise.reject("DELETE_FAILED", e.message) }
    }
  }

  /** 加载指定音源插件（同一插件复用；换插件时重建沙箱，因 setup 会消费 musicfree_setup） */
  @ReactMethod
  fun loadPlugin(fileName: String, promise: Promise) {
    jsHandler.post {
      try {
        if (loadedPluginName == fileName && ctx != null) {
          mainHandler.post { promise.resolve(fileName) }
          return@post
        }
        // 销毁旧沙箱，重建（musicfree_setup 是一次性函数，需要全新上下文）
        try { ctx?.close() } catch (e: Exception) { /* 忽略 */ }
        ctx = null
        loadedPluginName = null
        ensureRuntimeLocked()
        val script = File(sourcesDir(), fileName).readText(Charsets.UTF_8)
        sessionKey = UUID.randomUUID().toString()
        // musicfree_setup(key, rawScript, rawUserVariables, rawAppVersion)
        val setupCall =
          "globalThis.musicfree_setup(" +
            JSONObject.quote(sessionKey) + "," +
            JSONObject.quote(script) + "," +
            "'{}'," +
            JSONObject.quote("2.0.0") +
            ")"
        ctx?.evaluate(setupCall)
        android.util.Log.d("PluginRuntime", "setup ok plugin=" + fileName)
        loadedPluginName = fileName
        mainHandler.post { promise.resolve(fileName) }
      } catch (e: Exception) {
        android.util.Log.e("PluginRuntime", "load failed: " + (e.message ?: e.toString()))
        mainHandler.post { promise.reject("LOAD_FAILED", e.message) }
      }
    }
  }

  /** 当前已加载音源 */
  @ReactMethod
  fun getLoadedPlugin(promise: Promise) {
    mainHandler.post { promise.resolve(loadedPluginName) }
  }

  /** 调用插件方法（searchMusic / getMediaSource / getMusicInfo / getAlbumInfo） */
  @ReactMethod
  fun callPlugin(action: String, payload: ReadableMap, promise: Promise) {
    jsHandler.post {
      try {
        val ctxLocal = ctx ?: throw Exception("音源未加载")
        val requestKey = UUID.randomUUID().toString()
        synchronized(pendingMethodCalls) { pendingMethodCalls[requestKey] = promise }
        val payloadJson = JSONObject().apply {
          put("requestKey", requestKey)
          val iter = payload.keySetIterator()
          while (iter.hasNextKey()) {
            val k = iter.nextKey()
            val v = payload.getString(k) ?: ""
            // 值若本身是 JSON 对象/数组（如 musicItem），还原为结构体传给插件
            put(k, if (v.startsWith("{") || v.startsWith("[")) {
              try { org.json.JSONTokener(v).nextValue() } catch (e: Exception) { v }
            } else v)
          }
        }
        val callArgs = arrayOf(sessionKey, action, payloadJson.toString())
        android.util.Log.d("PluginRuntime", "callPlugin action=$action")
        ctxLocal.globalObject.getJSFunctionProperty("__lx_native__")?.call(*callArgs)
        drainJobs()
      } catch (e: Exception) {
        mainHandler.post { promise.reject("CALL_FAILED", e.message) }
      }
    }
  }

  /**
   * 驱动 QuickJS pending job（Promise 反应任务）。
   * 原生侧 call JS 函数后 Promise 链不会自动续跑，
   * evaluate 内部会循环执行 runtime 队列里的 pending job，补一发空求值即可推进。
   */
  private fun drainJobs() {
    try {
      ctx?.evaluate("0")
    } catch (e: Exception) {
      android.util.Log.e("PluginRuntime", "drainJobs: " + (e.message ?: e.toString()))
    }
  }

  // ---------------------------------------------------------------------------
  // QuickJS 初始化与桥
  // ---------------------------------------------------------------------------

  private fun sourcesDir(): File {
    val dir = File(reactContext.filesDir, "sources")
    if (!dir.exists()) dir.mkdirs()
    return dir
  }

  private fun asset(name: String): String =
    reactContext.assets.open("script/$name").bufferedReader().use { it.readText() }

  private fun ensureRuntimeLocked() {
    if (ctx != null) return
    android.util.Log.d("PluginRuntime", "create ctx")
    com.whl.quickjs.android.QuickJSLoader.init()
    val context = QuickJSContext.create()
    android.util.Log.d("PluginRuntime", "ctx created")
    // 整体替换引擎内置 console（内置 console.js 的 stdout 槽无法从外部赋值，
    // 用宿主实现直接覆盖，插件内不再触发 stdout 检查）
    context.evaluate(
      "Object.defineProperty(globalThis, 'console', {" +
        "value: {" +
        "log: function (...a) { __qjs_stdout__(a.map(String).join(' ')) }," +
        "info: function (...a) { __qjs_stdout__(a.map(String).join(' ')) }," +
        "warn: function (...a) { __qjs_stdout__('WARN ' + a.map(String).join(' ')) }," +
        "error: function (...a) { __qjs_stdout__('ERROR ' + a.map(String).join(' ')) }," +
        "debug: function () {}," +
        "dir: function () {}," +
        "trace: function () {}," +
        "assert: function () {}," +
        "count: function () {}," +
        "time: function () {}," +
        "timeEnd: function () {}," +
        "group: function () {}," +
        "groupEnd: function () {}," +
        "table: function () {}" +
        "}," +
        "writable: true, configurable: true, enumerable: false" +
        "})"
    )
    context.globalObject.setProperty(
      "__qjs_stdout__",
      JSCallFunction { args ->
        android.util.Log.d("QJS", args.getOrNull(0)?.toString() ?: "")
        null
      }
    )
    context.evaluate(asset("musicfree-dependencies.js"), "musicfree-dependencies.js")
    android.util.Log.d("PluginRuntime", "deps ok")
    context.evaluate(asset("musicfree-preload.js"), "musicfree-preload.js")
    android.util.Log.d("PluginRuntime", "preload ok")

    // JS→宿主回调桥
    context.globalObject.setProperty(
      "__lx_native_call__",
      JSCallFunction { args ->
        val key = args.getOrNull(0)?.toString() ?: ""
        val action = args.getOrNull(1)?.toString() ?: ""
        val data = args.getOrNull(2)?.toString() ?: "{}"
        dispatchFromJs(key, action, data)
        null
      }
    )
    // setTimeout 桥：JS 侧注册定时器，宿主到点回调 __set_timeout__
    context.globalObject.setProperty(
      "__lx_native_call__set_timeout",
      JSCallFunction { args ->
        val id = args.getOrNull(0)?.toString()?.toIntOrNull() ?: -1
        val timeoutMs = args.getOrNull(1)?.toString()?.toLongOrNull() ?: 0L
        val runnable = Runnable {
          jsHandler.post {
            try {
          ctx?.globalObject
            ?.getJSFunctionProperty("__lx_native__")
            ?.call(sessionKey, "__set_timeout__", id.toString())
          drainJobs()
        } catch (e: Exception) {
              // 定时回调失败忽略（插件可能已销毁）
            }
          }
        }
        if (timeoutMs <= 0) runnable.run() else jsHandler.postDelayed(runnable, timeoutMs)
        synchronized(timeoutCalls) { timeoutCalls[id] = runnable }
        null
      }
    )
    ctx = context
  }

  /** JS→宿主 分发（jsHandler 线程上下文） */
  private fun dispatchFromJs(key: String, action: String, data: String) {
    if (key != sessionKey) return
    val payload = try { JSONObject(data) } catch (e: Exception) { JSONObject() }
    when (action) {
      "init" -> {
        // 插件加载结果通知（status=false 时 errorMessage 含失败原因）
        android.util.Log.e("PluginRuntime", "plugin init: " + payload.toString().take(200))
      }
      "request" -> handleNativeRequest(payload)
      "cancelRequest" -> {
        val requestKey = payload.optString("requestKey")
        synchronized(pendingRequests) { pendingRequests.remove(requestKey)?.cancel() }
      }
      "__set_timeout__" -> {
        // preload 内部处理（jsCall('__set_timeout__')），宿主无需动作
      }
      "response" -> {
        // 插件方法结果回灌（带 status 字段）
        val requestKey = payload.optString("requestKey")
        android.util.Log.d("PluginRuntime", "plugin response key=$requestKey status=${payload.optBoolean("status", false)}")
        val promise = synchronized(pendingMethodCalls) { pendingMethodCalls.remove(requestKey) }
        if (promise != null) {
          val status = payload.optBoolean("status", false)
          if (status) {
            val result = payload.opt("result")
            val resultJson = if (result is JSONObject || result is org.json.JSONArray) {
              result.toString()
            } else {
              JSONObject().put("value", result ?: JSONObject.NULL).toString()
            }
            mainHandler.post { promise.resolve(resultJson) }
          } else {
            val msg = payload.optString("errorMessage").ifBlank { "插件调用失败" }
            mainHandler.post { promise.reject("PLUGIN_ERROR", msg) }
          }
        }
      }
    }
  }

  /** 网络请求桥（request action）：OkHttp 执行 → response action 回灌 */
  private fun handleNativeRequest(payload: JSONObject) {
    val requestKey = payload.optString("requestKey")
    val url = payload.optString("url")
    val options = payload.optJSONObject("options") ?: JSONObject()
    try {
      val method = options.optString("method", "GET").uppercase()
      val headers = options.optJSONObject("headers") ?: JSONObject()
      val bodyText = if (options.has("body")) {
        val b = options.opt("body")
        if (b is JSONObject || b is org.json.JSONArray) b.toString() else b.toString()
      } else ""

      val builder = Request.Builder().url(url)
      headers.keys().forEach { k -> builder.header(k, headers.optString(k)) }
      val mediaType = "application/json; charset=utf-8".toMediaType()
      when (method) {
        "GET" -> builder.get()
        "POST" -> builder.post(bodyText.toRequestBody(mediaType))
        "PUT" -> builder.put(bodyText.toRequestBody(mediaType))
        "DELETE" -> if (bodyText.isBlank()) builder.delete() else builder.delete(bodyText.toRequestBody(mediaType))
        "HEAD" -> builder.head()
        else -> builder.method(method, if (bodyText.isBlank()) null else bodyText.toRequestBody(mediaType))
      }
      val call = http.newCall(builder.build())
      synchronized(pendingRequests) { pendingRequests[requestKey] = call }
      call.enqueue(object : Callback {
        override fun onFailure(call: Call, e: java.io.IOException) {
          synchronized(pendingRequests) { pendingRequests.remove(requestKey) }
          respondToJs(requestKey, error = e.message ?: "网络请求失败")
        }

        override fun onResponse(call: Call, response: okhttp3.Response) {
          val bodyText = try { response.body?.string() ?: "" } catch (e: Exception) { "" }
          synchronized(pendingRequests) { pendingRequests.remove(requestKey) }
          val respHeaders = JSONObject()
          response.headers.forEach { (k, v) -> if (!respHeaders.has(k)) respHeaders.put(k, v) }
          respondToJs(
            requestKey,
            response = JSONObject()
              .put("statusCode", response.code)
              .put("statusMessage", response.message)
              .put("headers", respHeaders)
              .put("body", bodyText)
          )
        }
      })
    } catch (e: Exception) {
      respondToJs(requestKey, error = e.message ?: "请求构造失败")
    }
  }

  /** 宿主→JS 回灌（必须派发回 JS 线程） */
  private fun respondToJs(requestKey: String, error: String? = null, response: JSONObject? = null) {
    jsHandler.post {
      try {
        val data = JSONObject()
        data.put("requestKey", requestKey)
        if (error != null) data.put("error", error)
        if (response != null) data.put("response", response)
        ctx?.globalObject
          ?.getJSFunctionProperty("__lx_native__")
          ?.call(sessionKey, "response", data.toString())
        drainJobs()
      } catch (e: Exception) {
        // 回灌失败忽略（插件可能已销毁）
      }
    }
  }

  override fun onCatalystInstanceDestroy() {
    super.onCatalystInstanceDestroy()
    jsHandler.post {
      synchronized(pendingRequests) {
        pendingRequests.values.forEach { it.cancel() }
        pendingRequests.clear()
      }
      try { ctx?.close() } catch (e: Exception) { /* 忽略 */ }
      ctx = null
    }
  }
}
