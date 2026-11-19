package com.lg.music

import android.content.Context
import android.os.Build
import android.os.Vibrator
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap

/**
 * CencModule —— 复用青听 cenc 库（libqingmusic-cenc.so）。
 * 结构复刻自青听 v1.4.1 同名模块：CENC 公共加密 MP4/FLAC 采样解密 + 本地解密流代理。
 * .so 已随本模块原样带入 jniLibs/arm64-v8a（原样来自青听 apk lib）。
 * 当前 v2 播放链路走青听网关播放地址（不经 CENC 加密流），JNI 入口留占位，
 * 后续接入 CENC 加密流时按青听导出名（nativeDecrypt/GetFlacRanges 等）补接。
 */
class CencModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "CencModule"

  init {
    System.loadLibrary("libqingmusic-cenc")
  }

  private val vib: Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
    reactContext.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
  } else null

  // ---------------------------------------------------------------------------
  // CENC 流解密（经 .so 采样解密；占位入口，预留 JNI 补接）
  // ---------------------------------------------------------------------------

  /** 请求解码指定流（MP4/FLAC 加密流），返回解密地址与采样信息 */
  @ReactMethod
  fun decryptSource(source: String, key: String, promise: Promise) {
    try {
      // JNI 入口 nativeDecrypt(source, key) 在接入 CENC 流时补接
      val result = cencNativeDecrypt(source, key)
      val map: WritableMap = Arguments.createMap()
      if (result != null) {
        map.putString("decryptedUrl", result)
      }
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("CENC_FAILED", e.message ?: "CENC 解密失败")
    }
  }

  /** JNI 占位：接入 CENC 流时改为调用 .so 导出 nativeDecrypt 的 JNI 方法 */
  private fun cencNativeDecrypt(source: String, key: String): String? = null

  // ---------------------------------------------------------------------------
  // 本地解密流代理（CENC 加密本地文件 → 解密出可播放流）
  // ---------------------------------------------------------------------------

  @ReactMethod
  fun decryptLocalFile(path: String, promise: Promise) {
    try {
      val result = cencNativeDecrypt(path, "")
      promise.resolve(result ?: "")
    } catch (e: Exception) {
      promise.reject("CENC_FAILED", e.message ?: "本地 CENC 解密失败")
    }
  }
}
