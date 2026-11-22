package com.lg.music

import android.content.Context
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.Arguments
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.json.JSONArray
import java.security.MessageDigest
import java.util.ArrayList

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

  /** 网易云固定设备 Cookie（复刻青听 v1.0.3） */
  private val WY_COOKIE =
    "EVNSM=1.0.0; osver=14; MUSIC_U=; NMCID=oyapoh.1707738771510.01.4; versioncode=1000022; URS_APPID=E26D3B65474AEE2FC2586DCAE42BCF0CBEA421D4CB53C42A74EBEF035ACE98E0B6F0E44087D61EFC06BE92279CD6EEC6; buildver=231106171719; resolution=3040x1440; sDeviceId=bnVsbAljNjowOTpiMzphYzo4NDowNgk4NzNjZWYxNGQxYjY4MWI5CWY1ZjVhNTIxOGFjNDA3ZmY%3D; os=magicos; channel=netease; screenType=other; deviceId=bnVsbAljNjowOTpiMzphYzo4NDowNgk4NzNjZWYxNGQxYjY4MWI5CWY1ZjVhNTIxOGFjNDA3ZmY%3D; appver=1.0.22; NMDI=Q1NKTQkBDACdyBclTqtsEuV2ecI7AAAAKyV%2B9xWzSJenvmG2RFU9D82gQoo96WkqNFpO59px3PrvpN5DF0cFPRJ3BXMIBMdBOcxhjUoyxI898tU%3D; ntes_kaola_ad=1; language=zh-CN; mobilename=22041211AC; __csrf=b383e0976daab42a166a9544f90a1dc3; NMTID=00O3nhQ8Br3egFvnEAIjk_hfVnTjsAAAGNnSmw4w; packageType=release"
  private val WY_UA =
    "NeteaseMusic/1.0.22.231106171719(1000022);Dalvik/2.1.0 (Linux; U; Android 14; 22041211AC Build/UP1A.231005.007)"

  /** 酷我 UA（复刻青听 v1.0.3） */
  private val KW_UA =
    "Mozilla/5.0 (Windows NT 6.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/37.0.2062.120 Safari/537.36"

  /** B 站 WBI 键（复刻青听 v1.0.3） */
  private val WBI_MID = "7fa3d2b5f1c34b0d8a9e7c2f1b3d4e5f"

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

  // ---------------------------------------------------------------------------
  // 六源搜索（复刻青听原生 SecureKwApiModule 搜索能力）
  // ---------------------------------------------------------------------------

  @ReactMethod
  fun search(source: String, keyword: String, page: Int, pagesize: Int, promise: Promise) {
    Thread {
      try {
        val result = when (source) {
          "kg" -> kgSearch(keyword, page, pagesize)
          "wy" -> wySearch(keyword, page, pagesize)
          "mg" -> mgSearch(keyword, page, pagesize)
          "bili" -> biliSearch(keyword, page, pagesize)
          "kw" -> kwSearch(keyword, page, pagesize)
          else -> null
        }
        if (result != null) promise.resolve(toWritableArray(result))
        else promise.reject("SEARCH_UNSUPPORTED", "不支持的音源")
      } catch (e: Exception) {
        promise.reject("SEARCH_FAILED", e.message ?: "搜索失败")
      }
    }.start()
  }

  /** List<Map> → WritableArray（RN 桥 promise.resolve 仅接受可转换类型） */
  private fun toWritableArray(list: List<Map<String, String>>): com.facebook.react.bridge.WritableArray {
    val arr = com.facebook.react.bridge.Arguments.createArray()
    for (item in list) {
      val map = com.facebook.react.bridge.Arguments.createMap()
      for ((k, v) in item) {
        if (v != null && v.isNotEmpty()) map.putString(k, v)
      }
      arr.pushMap(map)
    }
    return arr
  }

  /** 酷狗搜索（songsearch 直连，与桌面端 kg 搜索一致） */
  private fun kgSearch(keyword: String, page: Int, pagesize: Int): List<Map<String, String>> {
    val url =
      "https://songsearch.kugou.com/song_search_v2?keyword=${encode(keyword)}&page=$page&pagesize=$pagesize&userid=0&clientver=&platform=WebFilter&filter=2&iscorrection=1&privilege_filter=0&area_code=1"
    val text = jsonGet(
      url,
      mapOf(
        "User-Agent" to "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36",
        "Referer" to "https://www.kugou.com/"
      )
    )
    val json = JSONObject(text)
    val lists = json.optJSONObject("data")?.optJSONArray("lists") ?: return emptyList()
    val out = ArrayList<Map<String, String>>()
    for (i in 0 until lists.length()) {
      val item = lists.getJSONObject(i)
      val fileName = item.optString("FileName")
      val parts = fileName.split(" - ")
      val cover = item.optString("Image").replace("{size}", "480").replace("/{size}", "/480")
      out.add(
        mapOf(
          "rid" to item.optString("FileHash"),
          "name" to (if (parts.size > 1) parts.drop(1).joinToString(" - ") else fileName),
          "artist" to (if (parts.isNotEmpty() && parts[0].isNotBlank()) parts[0] else item.optString("SingerName")),
          "album" to item.optString("AlbumName"),
          "pic" to cover,
          "duration" to item.optString("Duration"),
          "keyword" to keyword
        )
      )
    }
    return out
  }

  private fun buildGetRequest(url: String, headers: Map<String, String>): Request {
    return Request.Builder().url(url)
      .header("Accept", "application/json")
      .apply { headers.forEach { (k, v) -> header(k, v) } }
      .build()
  }

  private fun buildPostRequest(url: String, body: okhttp3.RequestBody, headers: Map<String, String>): Request {
    return Request.Builder().url(url)
      .post(body)
      .header("Content-Type", "application/json")
      .header("Accept", "application/json")
      .apply { headers.forEach { (k, v) -> header(k, v) } }
      .build()
  }

  /** 网易云搜索（interface3 v3，固定设备 Cookie） */
  private fun wySearch(keyword: String, page: Int, pagesize: Int): List<Map<String, String>> {
    val c = JSONArray().apply {
      put(JSONObject().apply {
        put("s", 0)
        put("type", 2)
        put("limit", pagesize)
        put("offset", page * pagesize)
      })
    }.toString()
    val text = jsonGet(
      "https://interface3.music.163.com/api/v3/search/song?c=${encode(c)}",
      mapOf("Cookie" to WY_COOKIE, "User-Agent" to WY_UA))
    return parseJsonList(text, keyword)
  }

  /** 咪咕搜索（jadeite searchAll） */
  private fun mgSearch(keyword: String, page: Int, pagesize: Int): List<Map<String, String>> {
    val url = "https://jadeite.migu.cn/music_search/v3/search/searchAll?keyword=${encode(keyword)}&pageNo=${page}&pageSize=${pagesize}&v=3.0"
    val text = jsonGet(url, mapOf("Referer" to "https://music.migu.cn/", "User-Agent" to "Mozilla/5.0 (Linux; Android 10; LGmusic) AppleWebKit/537.36"))
    return parseJsonList(text, keyword)
  }

  /** B 站搜索（web-interface search/type + WBI 签名） */
  private fun biliSearch(keyword: String, page: Int, pagesize: Int): List<Map<String, String>> {
    val pageNo = page * 30
    val wc = pageNo.toString()
    val wp = String.format("p%s%s", page + 1, pagesize.coerceAtMost(30))
    val mid = WBI_MID
    val sign = WBI_SIGN(keyword, wp, wc, mid)
    val url = "https://api.bilibili.com/x/web-interface/search/type?search_type=music&keyword=${encode(keyword)}&page=$wp"
    val headers = mapOf(
      "Referer" to "https://search.bilibili.com/",
      "Origin" to "https://search.bilibili.com",
      "User-Agent" to "Mozilla/5.0 (Linux; Android 10; LGmusic) AppleWebKit/537.36",
      "wts" to sign)
    val text = jsonGet(url, headers)
    return parseJsonList(text, keyword)
  }

  /** 酷我搜索（msearch song_search_v2，dfid/mid/uuid/token 参数） */
  private fun kwSearch(keyword: String, page: Int, pagesize: Int): List<Map<String, String>> {
    val dfid = "-" + System.currentTimeMillis() + Math.floor(Math.random() * 100000)
    val mid = MD5_HEX(dfid)
    val uuid = MD5_HEX(dfid + mid)
    val clienttime = System.currentTimeMillis() / 1000
    val token = MD5_HEX("11111111111111111111" + clienttime)
    val params: Map<String, String> = mapOf(
      "key" to keyword, "page" to page.toString(), "pagesize" to pagesize.toString(),
      "dfid" to dfid, "mid" to mid, "uuid" to uuid,
      "clienttime" to "$clienttime", "token" to token, "platform" to "web")
    val url = "https://msearch.kuwo.cn/song_search_v2?" + appendQuery(params)
    val headers = mutableMapOf(
      "User-Agent" to KW_UA, "Referer" to "https://m.kuwo.cn/")
    headers.put("x-forwarded-for", "1.0.1.114")
    val text = jsonGet(url, headers)
    return parseJsonList(text, keyword)
  }

  private fun parseJsonList(text: String, keyword: String): List<Map<String, String>> {
    val json = JSONObject(text)
    val result: org.json.JSONArray = json.optJSONArray("result") ?: org.json.JSONArray()
    val list = ArrayList<Map<String, String>>()
    var i = 0
    while (i < result.length()) {
      val item = result.getJSONObject(i)
      val name = item.optString("name") ?: ""
      if (name.isBlank()) {
        i++
        continue
      }
      list.add(mapOf(
        "rid" to item.optString("rid", ""),
        "name" to name,
        "artist" to item.optString("artist", ""),
        "album" to item.optString("album", ""),
        "duration" to item.optString("duration", ""),
        "pic" to item.optString("pic", ""),
        "keyword" to keyword))
      i++
    }
    return list
  }

  private fun jsonGet(url: String, headers: Map<String, String>): String {
    val request = Request.Builder().url(url)
      .header("Accept", "application/json")
      .apply { headers.forEach { (k, v) -> header(k, v) } }
      .build()
    return try {
      client.newCall(request).execute().use { r ->
        if (!r.isSuccessful) throw Exception("HTTP ${r.code}")
        r.body?.string() ?: ""
      }
    } catch (e: Exception) {
      throw e
    }
  }

  private fun appendQuery(params: Map<String, String>): String {
    val sb = StringBuilder()
    for ((k, v) in params) {
      sb.append(encode(k)).append('=').append(encode(v))
    }
    return sb.toString()
  }

  private fun encode(s: String): String {
    val safe = setOf('a'..'z', 'A'..'Z', '0'..'9', '-', '_', '.', '~', '*', '(', ')', '!', '&', ',', '?', ':')
    val out = StringBuilder()
    for (i in s.indices) {
      val v = s[i].code
      if (safe.contains(v)) {
        out.append(s[i])
      } else {
        out.append('%')
        out.append(String.format("%02x", v and 0xFF))
      }
    }
    return out.toString()
  }

  private fun MD5_HEX(input: String): String {
    val digest = MessageDigest.getInstance("MD5").digest(input.toByteArray(Charsets.UTF_8))
    return digest.joinToString("") { "%02x".format(it) }
  }

  /** WBI 签名（B 站搜索 wts 头） */
  private fun WBI_SIGN(keyword: String, wp: String, wc: String, mid: String): String {
    val dict = "wts,${MD5_HEX(mid)},${MD5_HEX(keyword)}"
    val fp = dict.split(",").sorted().joinToString("") { it }
    return MD5_HEX("%s%s%s".format("1", MD5_HEX(mid), fp))
  }
}
