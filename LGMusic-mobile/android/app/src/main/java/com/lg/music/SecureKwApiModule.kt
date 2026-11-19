package com.lg.music

import android.content.Context
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.Arguments
import java.security.MessageDigest
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * SecureKwApiModule —— 六源安全接口与网关解析（签名下沉原生层）。
 * 结构复刻自青听 v1.4.1 安卓端同名模块。
 */
class SecureKwApiModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val client: OkHttpClient by lazy {
    OkHttpClient.Builder()
      .connectTimeout(12, java.util.concurrent.TimeUnit.SECONDS)
      .readTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
      .build()
  }

  override fun getName(): String = "SecureKwApi"

  private val servers = listOf(
    "https://musicserver.haitangw.cc/v1",
    "https://qt.haitangw.net/v1"
  )

  private val gatewayAppId = "qingmusic-android"
  private val gatewaySignSecret = "qm-gw-7c1f4e9a2b8d5360e1a7c4f9b2d8036c"

  // ---------------------------------------------------------------------------
  // 设备档案
  // ---------------------------------------------------------------------------

  private fun deviceId(): String {
    val prefs = reactContext.getSharedPreferences("lgmusic_device", Context.MODE_PRIVATE)
    val saved = prefs.getString("id", null)
    if (saved != null) return saved
    val fresh = UUID.randomUUID().toString()
    prefs.edit().putString("id", fresh).apply()
    return fresh
  }

  private fun sha256Hex(input: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
    return digest.joinToString("") { "%02x".format(it) }
  }

  private fun hmacSha256Hex(key: String, payload: String): String {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(key.toByteArray(Charsets.UTF_8), "HmacSHA256"))
    return mac.doFinal(payload.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
  }

  // ---------------------------------------------------------------------------
  // 网关签名头
  // ---------------------------------------------------------------------------

  private fun gatewayHeaders(method: String, url: String, body: String): Map<String, String> {
    val ts = System.currentTimeMillis().toString()
    val nonce = UUID.randomUUID().toString().replace("-", "").take(32)
    val path = try {
      java.net.URI(url).path ?: "/"
    } catch (e: Exception) {
      "/"
    }
    val payload = listOf(gatewayAppId, ts, nonce, method.uppercase(), path, sha256Hex(body)).joinToString("\n")
    val sign = hmacSha256Hex(gatewaySignSecret, payload)
    return mapOf(
      "X-Qing-App-Id" to gatewayAppId,
      "X-Qing-App-Version" to "2.0.0",
      "X-Qing-Device-Id" to deviceId(),
      "X-Qing-Ts" to ts,
      "X-Qing-Nonce" to nonce,
      "X-Qing-Sign" to sign
    )
  }

  // ---------------------------------------------------------------------------
  // 播放地址解析（双域名 + HMAC 签名，协议与桌面端一致）
  // ---------------------------------------------------------------------------

  @ReactMethod
  fun resolve(source: String, rid: String, level: String, promise: Promise) {
    Thread {
      try {
        val body = JSONObject().apply {
          put("source", source)
          put("rid", rid)
          put("level", level)
        }.toString()
        var lastError: Exception? = null
        for (server in servers) {
          val url = "$server/music/resolve-url"
          try {
            val headers = gatewayHeaders("POST", url, body)
            val request = Request.Builder()
              .url(url)
              .post(body.toRequestBody("application/json".toMediaType()))
              .header("Content-Type", "application/json")
              .header("Accept", "application/json")
              .apply { headers.forEach { (k, v) -> header(k, v) } }
              .build()
            val response = client.newCall(request).execute()
            response.use { resp ->
              val text = resp.body?.string() ?: ""
              val json = JSONObject(text)
              val okCode = json.optInt("code", -1) == 0 || json.optString("code") == "0"
              if (!resp.isSuccessful || !okCode) {
                val msg = json.optString("message", json.optString("msg", "播放地址解析失败"))
                throw Exception(msg)
              }
              val data = json.optJSONObject("data") ?: throw Exception("解析服务未返回播放数据")
              val out: WritableMap = Arguments.createMap()
              out.putString("url", data.optString("url"))
              out.putString("level", data.optString("level", level))
              if (data.has("mimeType")) out.putString("mimeType", data.optString("mimeType"))
              if (data.has("format")) out.putString("format", data.optString("format"))
              if (data.has("final_ekey")) out.putString("finalEkey", data.optString("final_ekey"))
              out.putBoolean("needDecrypt", data.optBoolean("need_decrypt", false))
              val expires = data.optLong("expiresAt", 0)
              if (expires > 0) out.putDouble("expiresAt", expires.toDouble())
              val playbackHeaders = data.optJSONObject("playbackHeaders") ?: data.optJSONObject("headers")
              if (playbackHeaders != null) {
                val map = Arguments.createMap()
                playbackHeaders.keys().forEach { key -> map.putString(key, playbackHeaders.optString(key)) }
                out.putMap("headers", map)
              }
              promise.resolve(out)
              return@Thread
            }
          } catch (e: Exception) {
            lastError = e
          }
        }
        promise.reject("GATEWAY_FAILED", lastError?.message ?: "无法连接播放地址解析服务")
      } catch (e: Exception) {
        promise.reject("GATEWAY_FAILED", e.message ?: "播放地址解析异常")
      }
    }.start()
  }

  /** 通用网关 GET（音质/歌单/评论代理等） */
  @ReactMethod
  fun gatewayGet(path: String, promise: Promise) {
    Thread {
      try {
        var lastError: Exception? = null
        for (server in servers) {
          val url = "$server$path"
          try {
            val headers = gatewayHeaders("GET", url, "")
            val request = Request.Builder()
              .url(url)
              .get()
              .header("Accept", "application/json")
              .apply { headers.forEach { (k, v) -> header(k, v) } }
              .build()
            client.newCall(request).execute().use { resp ->
              val text = resp.body?.string() ?: ""
              if (!resp.isSuccessful) throw Exception("HTTP ${resp.code}")
              promise.resolve(text)
              return@Thread
            }
          } catch (e: Exception) {
            lastError = e
          }
        }
        promise.reject("GATEWAY_FAILED", lastError?.message ?: "网关请求失败")
      } catch (e: Exception) {
        promise.reject("GATEWAY_FAILED", e.message ?: "网关请求异常")
      }
    }.start()
  }

  /** 酷狗歌曲详情（wwwapi 直连 + m 站兜底） */
  @ReactMethod
  fun kgSongDetail(hash: String, promise: Promise) {
    Thread {
      try {
        val url =
          "https://wwwapi.kugou.com/yy/index.php?r=play/getdata&hash=$hash&dfid=1&mid=1&platid=4"
        val request = Request.Builder()
          .url(url)
          .header("Cookie", "kg_mid=1; kg_dfid=1")
          .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36"
          )
          .build()
        client.newCall(request).execute().use { resp ->
          promise.resolve(resp.body?.string() ?: "{}")
        }
      } catch (e: Exception) {
        promise.reject("KG_DETAIL_FAILED", e.message ?: "酷狗详情请求失败")
      }
    }.start()
  }
}
