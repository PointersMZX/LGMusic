package com.lg.music

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.ArrayList

/**
 * LocalMusicScannerModule —— 本地音乐扫描（复刻青听 v1.4.1 同名模块）。
 * 扫描外部存储（可写入位置）下的音乐文件列表。
 * v2 播放链路未启用本地音乐下载，该模块保留为扫描入口；
 * SDK API 上本地 ContentResolver 查询签名在当前编译 SDK 不可用，暂返回空列表，
 * 后续接入本地音乐功能时按当时 SDK 的 query 签名补全查询实现。
 */
class LocalMusicScannerModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "LocalMusicScanner"

  @ReactMethod
  fun scanLocalMusic(promise: Promise) {
    // 占位入口：待 SDK 查询 API 对齐后补全 MediaStore 扫描实现
    val result: ArrayList<Map<String, String>> = ArrayList<Map<String, String>>()
    promise.resolve(java.util.Collections.singletonList(result))
  }
}
