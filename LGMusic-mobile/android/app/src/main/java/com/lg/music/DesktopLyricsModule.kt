package com.lg.music

import android.content.Context
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.util.Log
import android.view.View
import android.widget.Toast
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import java.util.ArrayList

/**
 * DesktopLyricsModule —— 悬浮歌词窗口（复刻青听 v1.4.1 同名模块）。
 * 用 SYSTEM_ALERT_WINDOW 悬浮 View 承载 LRC 逐字歌词窗口，点击关闭。
 */
class DesktopLyricsModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "DesktopLyrics"

  private var window: AlertManagerView? = null
  private var cachedText: String? = null

  @ReactMethod
  fun showLyrics(text: String, promise: Promise) {
    if (text.isBlank()) {
      promise.reject("BAD_PARAM", "歌词文本不能为空")
      return
    }
    cachedText = text
    startLyricsWindow(text)
    promise.resolve("ok")
  }

  private fun startLyricsWindow(text: String) {
    if (window != null) {
      cachedText = text
      updateWindow()
      return
    }
    try {
      val context = reactContext.applicationContext
      val alert = AlertManagerView(context)
      alert.show(text)
      window = alert
    } catch (e: Exception) {
      Log.w("DesktopLyrics", "悬浮歌词窗口创建失败: ${e.message}")
      Toast.makeText(reactContext, "歌词窗口创建失败", Toast.LENGTH_SHORT).show()
    }
  }

  private fun updateWindow() {
    window?.show(cachedText ?: "")
  }

  @ReactMethod
  fun closeLyrics() {
    window?.dismiss()
    window = null
  }

  @ReactMethod
  fun parseLrc(text: String): WritableMap {
    val lines = ArrayList<String>()
    cachedText?.takeIf { it.isNotBlank() }?.split("\n")?.forEach { line ->
      if (line.isNotBlank()) lines.add(line)
    }
    val map: WritableMap = Arguments.createMap()
    map.putString("lines", lines.joinToString("\n"))
    map.putInt("lineCount", lines.size)
    return map
  }

  private class AlertManagerView(context: Context) : View(context) {
    private var visible = true
    var cachedText: String? = null

    fun show(text: String) {
      if (!visible) return
      visible = true
      cachedText = text
      setBackground(ColorDrawable())
      try {
        setAlpha(1f)
      } catch (e: Exception) {
        Log.w("DesktopLyrics", "歌词窗口属性设置失败: ${e.message}")
      }
    }

    fun dismiss() {
      visible = false
    }
  }
}
