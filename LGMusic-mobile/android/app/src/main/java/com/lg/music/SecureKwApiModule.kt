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

  /** B 站桌面 UA（与桌面端 bili 适配器一致） */
  private val BILI_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"

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
          "qq" -> qqSearch(keyword, page, pagesize)
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

  /** QQ 搜索（musicu.fcg POST DoSearchForQQMusicMobile，与桌面端 search-qq 一致） */
  private fun qqSearch(keyword: String, page: Int, pagesize: Int): List<Map<String, String>> {
    val payload = JSONObject().apply {
      put("comm", JSONObject().apply {
        put("ct", "11"); put("cv", "14090508"); put("v", "14090508")
        put("tmeAppID", "qqmusic"); put("phonetype", "EBG-AN10")
        put("deviceScore", "553.47"); put("devicelevel", "50"); put("newdevicelevel", "20")
        put("rom", "HuaWei/EMOTION/EmotionUI_14.2.0"); put("os_ver", "12")
        put("OpenUDID", "0"); put("OpenUDID2", "0"); put("QIMEI36", "0")
        put("udid", "0"); put("chid", "0"); put("aid", "0"); put("oaid", "0")
        put("taid", "0"); put("tid", "0"); put("wid", "0"); put("uid", "0"); put("sid", "0")
        put("modeSwitch", "6"); put("teenMode", "0"); put("ui_mode", "2")
        put("nettype", "1020"); put("v4ip", "")
      })
      put("req", JSONObject().apply {
        put("module", "music.search.SearchCgiService")
        put("method", "DoSearchForQQMusicMobile")
        put("param", JSONObject().apply {
          put("search_type", 0)
          put("query", keyword)
          put("page_num", page + 1)
          put("num_per_page", pagesize)
          put("highlight", 0); put("nqc_flag", 0); put("multi_zhida", 0)
          put("cat", 2); put("grp", 1); put("sin", 0); put("sem", 0)
        })
      })
    }.toString()
    val text = jsonPostText(
      "https://u.y.qq.com/cgi-bin/musicu.fcg",
      payload,
      mapOf(
        "User-Agent" to "QQMusic 14090508(android 12)",
        "Content-Type" to "application/json"
      )
    )
    val json = JSONObject(text)
    val body = json.optJSONObject("req")?.optJSONObject("data")?.optJSONObject("body")
      ?: return emptyList()
    val list = body.optJSONArray("item_song")
      ?: body.optJSONObject("song")?.optJSONArray("list") ?: return emptyList()
    val out = ArrayList<Map<String, String>>()
    for (i in 0 until list.length()) {
      val song = list.getJSONObject(i)
      val singers = song.optJSONArray("singer")
      val artist = (0 until (singers?.length() ?: 0)).joinToString(" / ") { j ->
        singers?.getJSONObject(j)?.optString("name") ?: ""
      }
      val album = song.optJSONObject("album")
      val albumMid = album?.optString("mid") ?: ""
      out.add(
        mapOf(
          "rid" to song.optString("mid"),
          "name" to song.optString("name"),
          "artist" to artist,
          "album" to (album?.optString("name") ?: ""),
          "pic" to (if (albumMid.isNotBlank()) "http://y.gtimg.cn/music/photo_new/T002R300x300M000$albumMid.jpg" else ""),
          "duration" to song.optInt("interval").toString(),
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

  /** POST JSON 文本（QQ musicu.fcg 等接口用） */
  private fun jsonPostText(url: String, body: String, headers: Map<String, String>): String {
    val request = Request.Builder().url(url)
      .post(body.toRequestBody("application/json".toMediaType()))
      .apply { headers.forEach { (k, v) -> header(k, v) } }
      .build()
    return client.newCall(request).execute().use { r ->
      if (!r.isSuccessful) throw Exception("HTTP ${r.code}")
      r.body?.string() ?: ""
    }
  }

  private fun buildPostRequest(url: String, body: okhttp3.RequestBody, headers: Map<String, String>): Request {
    return Request.Builder().url(url)
      .post(body)
      .header("Content-Type", "application/json")
      .header("Accept", "application/json")
      .apply { headers.forEach { (k, v) -> header(k, v) } }
      .build()
  }

  /** 网易云搜索（api/search/get/web 老版免签名接口，固定设备 Cookie） */
  private fun wySearch(keyword: String, page: Int, pagesize: Int): List<Map<String, String>> {
    val url =
      "https://music.163.com/api/search/get/web?s=${encode(keyword)}&type=1&offset=${page * pagesize}&limit=$pagesize"
    val text = jsonGet(
      url,
      mapOf(
        "Cookie" to WY_COOKIE,
        "User-Agent" to WY_UA,
        "Referer" to "https://music.163.com/"
      )
    )
    val json = JSONObject(text)
    val songs = json.optJSONObject("result")?.optJSONArray("songs") ?: return emptyList()
    val out = ArrayList<Map<String, String>>()
    for (i in 0 until songs.length()) {
      val song = songs.getJSONObject(i)
      val artists = song.optJSONArray("artists")
      val artist = (0 until (artists?.length() ?: 0)).joinToString(" / ") { j ->
        artists?.getJSONObject(j)?.optString("name") ?: ""
      }
      val album = song.optJSONObject("album")
      out.add(
        mapOf(
          "rid" to song.optInt("id").toString(),
          "name" to song.optString("name"),
          "artist" to artist,
          "album" to (album?.optString("name") ?: ""),
          "pic" to (album?.optString("img1v1Url") ?: ""),
          "duration" to (song.optLong("duration") / 1000).toString(),
          "keyword" to keyword
        )
      )
    }
    return out
  }

  /** 咪咕搜索（jadeite searchAll + yyapp 双盐 MD5 签名，与桌面端 mg 适配器一致） */
  private fun mgSearch(keyword: String, page: Int, pagesize: Int): List<Map<String, String>> {
    val deviceId = "963B7AA0D21511ED807EE5846EC87D20"
    val timestamp = System.currentTimeMillis().toString()
    val raw =
      keyword + "6cdc72a439cef99a3418d2a78aa28c73" + "yyapp2d16148780a1dcc7408e06336b98cfd50" + deviceId + timestamp
    val sign = MD5_HEX(raw)
    val searchSwitch = encode(
      "{\"song\":1,\"album\":0,\"singer\":0,\"tagSong\":1,\"mvSong\":0,\"bestShow\":1,\"songlist\":0,\"lyricSong\":0}"
    )
    val url =
      "https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1&searchSwitch=$searchSwitch&pageSize=$pagesize&text=${encode(keyword)}&pageNo=${page + 1}&sort=0&sid=USS"
    val text = jsonGet(
      url,
      mapOf(
        "uiVersion" to "A_music_3.6.1",
        "deviceId" to deviceId,
        "timestamp" to timestamp,
        "sign" to sign,
        "channel" to "0146921",
        "User-Agent" to "Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30"
      )
    )
    val json = JSONObject(text)
    val data = json.optJSONObject("data") ?: return emptyList()
    val outer = data.optJSONObject("songResultData")?.optJSONArray("resultList")
      ?: data.optJSONArray("songData") ?: return emptyList()
    val out = ArrayList<Map<String, String>>()
    // resultList 是嵌套数组 [[item,item],...]，拍平一层
    for (g in 0 until outer.length()) {
      val inner = outer.optJSONArray(g) ?: continue
      for (i in 0 until inner.length()) {
        val it = inner.getJSONObject(i)
        val singers = it.optJSONArray("singers")
        val artist = if (singers != null && singers.length() > 0) {
          (0 until singers.length()).joinToString(" & ") { j ->
            singers.getJSONObject(j).optString("name")
          }
        } else it.optString("singerName")
        out.add(
          mapOf(
            "rid" to (if (it.optString("contentId").isNotBlank()) it.optString("contentId") else it.optString("copyrightId")),
            "name" to (if (it.optString("songName").isNotBlank()) it.optString("songName") else it.optString("name")),
            "artist" to artist,
            "album" to it.optString("album"),
            "pic" to (if (it.optString("albumImg").isNotBlank()) it.optString("albumImg") else it.optString("img")),
            "duration" to it.optString("duration"),
            "keyword" to keyword
          )
        )
      }
    }
    return out
  }

  /** 匿名设备标识 buvid3/buvid4（spi 接口，与桌面端 bili 适配器一致） */
  private var biliBuvid: Pair<String, String>? = null

  private fun fetchBuvid(): Pair<String, String> {
    biliBuvid?.let { return it }
    val text = jsonGet(
      "https://api.bilibili.com/x/frontend/finger/spi",
      mapOf("User-Agent" to BILI_UA)
    )
    val data = JSONObject(text).optJSONObject("data")
    val b3 = data?.optString("b_3") ?: ""
    val b4 = data?.optString("b_4") ?: ""
    if (b3.isBlank() || b4.isBlank()) throw Exception("无法获取哔哩哔哩匿名设备标识")
    val pair = Pair(b3, b4)
    biliBuvid = pair
    return pair
  }

  /** B 站搜索（search/type video 分区 + buvid Cookie，与桌面端 bili 适配器一致） */
  private fun biliSearch(keyword: String, page: Int, pagesize: Int): List<Map<String, String>> {
    val (b3, b4) = fetchBuvid()
    val query = mapOf(
      "context" to "", "page" to (page + 1).toString(), "order" to "",
      "page_size" to pagesize.coerceAtMost(30).toString(), "keyword" to keyword,
      "duration" to "", "tids_1" to "", "tids_2" to "",
      "__refresh__" to "true", "_extra" to "", "highlight" to "1",
      "single_column" to "0", "platform" to "pc", "from_source" to "",
      "search_type" to "video", "dynamic_offset" to "0")
    val url = "https://api.bilibili.com/x/web-interface/search/type?" + appendQuery(query)
    val headers = mapOf(
      "User-Agent" to BILI_UA,
      "Accept" to "application/json, text/plain, */*",
      "Accept-Language" to "zh-CN,zh;q=0.9,en;q=0.8",
      "Origin" to "https://search.bilibili.com",
      "Referer" to "https://search.bilibili.com/",
      "Cookie" to "buvid3=$b3; buvid4=$b4")
    val text = jsonGet(url, headers)
    val json = JSONObject(text)
    val list = json.optJSONObject("data")?.optJSONArray("result") ?: return emptyList()
    val out = ArrayList<Map<String, String>>()
    for (i in 0 until list.length()) {
      val item = list.getJSONObject(i)
      // B 站 duration 为 "mm:ss" 文本，转秒
      val durRaw = item.optString("duration")
      val durParts = durRaw.split(":")
      val durSec = when (durParts.size) {
        2 -> (durParts[0].toIntOrNull() ?: 0) * 60 + (durParts[1].toIntOrNull() ?: 0)
        3 -> (durParts[0].toIntOrNull() ?: 0) * 3600 + (durParts[1].toIntOrNull() ?: 0) * 60 + (durParts[2].toIntOrNull() ?: 0)
        else -> 0
      }
      out.add(
        mapOf(
          "rid" to item.optString("bvid"),
          "name" to item.optString("title").replace(Regex("<[^>]*>"), ""),
          "artist" to item.optString("author"),
          "album" to "哔哩哔哩",
          "pic" to item.optString("pic"),
          "duration" to (if (durSec > 0) durSec.toString() else durRaw),
          "keyword" to keyword
        )
      )
    }
    return out
  }

  /** 酷我搜索（search.kuwo.cn/r.s 老版接口，abslist 大写字段，与桌面端 kw 搜索一致） */
  private fun kwSearch(keyword: String, page: Int, pagesize: Int): List<Map<String, String>> {
    val params: Map<String, String> = mapOf(
      "client" to "kt", "all" to keyword, "pn" to page.toString(), "rn" to pagesize.toString(),
      "uid" to "794762570", "ver" to "kwplayer_ar_9.2.2.1", "vipver" to "1",
      "show_copyright_off" to "1", "newver" to "1", "ft" to "music", "cluster" to "0",
      "strategy" to "2012", "encoding" to "utf8", "rformat" to "json", "vermerge" to "1",
      "mobi" to "1", "issubtitle" to "1")
    val url = "https://search.kuwo.cn/r.s?" + appendQuery(params)
    val text = jsonGet(
      url,
      mapOf("User-Agent" to "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
    )
    val json = try {
      JSONObject(text.trim())
    } catch (e: Exception) {
      throw Exception("kw无结果($url): " + text.take(80))
    }
    val list = json.optJSONArray("abslist") ?: return emptyList()
    val out = ArrayList<Map<String, String>>()
    for (i in 0 until list.length()) {
      val item = list.getJSONObject(i)
      val name = item.optString("SONGNAME").replace(Regex("<em>|</em>"), "")
      val artist = item.optString("ARTIST").replace(Regex("<em>|</em>"), "")
      val album = item.optString("ALBUM").replace(Regex("<em>|</em>"), "")
      val rid = if (item.optString("RID").isNotBlank()) item.optString("RID")
      else item.optString("MUSICRID").removePrefix("MUSIC_")
      val pic = if (item.optString("hts_MVPIC").isNotBlank()) item.optString("hts_MVPIC")
      else if (item.optString("web_albumpic_short").isNotBlank())
        item.optString("web_albumpic_short") else item.optString("ALUMPIC")
      out.add(
        mapOf(
          "rid" to rid,
          "name" to name,
          "artist" to artist,
          "album" to album,
          "pic" to pic,
          "duration" to item.optString("DURATION"),
          "keyword" to keyword
        )
      )
    }
    return out
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
    var first = true
    for ((k, v) in params) {
      if (!first) sb.append('&')
      sb.append(encode(k)).append('=').append(encode(v))
      first = false
    }
    return sb.toString()
  }

  private fun encode(s: String): String {
    val out = StringBuilder()
    for (ch in s) {
      val ok = ch in 'a'..'z' || ch in 'A'..'Z' || ch in '0'..'9' ||
        ch == '-' || ch == '_' || ch == '.' || ch == '~' || ch == '*' ||
        ch == '(' || ch == ')' || ch == '!' || ch == '&' || ch == ',' ||
        ch == '?' || ch == ':' || ch == '/' || ch == '='
      if (ok) {
        out.append(ch)
      } else {
        out.append('%')
        out.append(String.format("%02x", ch.code and 0xFF))
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
