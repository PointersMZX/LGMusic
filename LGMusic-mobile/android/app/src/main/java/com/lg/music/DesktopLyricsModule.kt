package com.lg.music

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.os.Build
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * DesktopLyricsModule —— 悬浮歌词窗口（复刻青听 v1.4.1 同名模块）。
 * 用 WindowManager + TYPE_APPLICATION_OVERLAY 承载逐行歌词悬浮窗，可拖动、点击关闭。
 * 需要 SYSTEM_ALERT_WINDOW 悬浮窗权限（Manifest 已声明，运行时由宿主检查）。
 */
class DesktopLyricsModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "DesktopLyrics"

  private var overlayView: View? = null
  private var overlayParams: WindowManager.LayoutParams? = null

  private val windowManager: WindowManager?
    get() = reactContext.getSystemService(Context.WINDOW_SERVICE) as? WindowManager

  private fun canDrawOverlays(): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      Settings.canDrawOverlays(reactContext)
    } else true
  }

  @ReactMethod
  fun showLyrics(text: String, promise: Promise) {
    if (text.isBlank()) {
      promise.reject("BAD_PARAM", "歌词文本不能为空")
      return
    }
    if (!canDrawOverlays()) {
      promise.reject("NO_OVERLAY_PERMISSION", "需要悬浮窗权限才能显示桌面歌词")
      return
    }
    try {
      if (overlayView == null) createOverlay()
      (overlayView?.findViewById<TextView>(R_ID_TEXT))?.text = text
      promise.resolve("ok")
    } catch (e: Exception) {
      Log.w("DesktopLyrics", "悬浮歌词窗口创建失败: ${e.message}")
      promise.reject("OVERLAY_FAILED", e.message ?: "歌词窗口创建失败")
    }
  }

  @SuppressLint("ClickableViewAccessibility")
  private fun createOverlay() {
    val wm = windowManager ?: throw IllegalStateException("WindowManager 不可用")
    val density = reactContext.resources.displayMetrics.density

    val container = LinearLayout(reactContext)
    container.orientation = LinearLayout.VERTICAL
    container.setPadding(
      (12 * density).toInt(),
      (8 * density).toInt(),
      (12 * density).toInt(),
      (8 * density).toInt()
    )
    container.setBackgroundColor(0xB3202125.toInt()) // 半透明深色底

    val text = TextView(reactContext)
    text.id = R_ID_TEXT
    text.setTextColor(Color.WHITE)
    text.textSize = 16f
    text.typeface = Typeface.DEFAULT_BOLD
    text.gravity = Gravity.CENTER
    text.setShadowLayer(3f, 0f, 1f, Color.BLACK)
    text.text = ""
    container.addView(text)

    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
    } else {
      @Suppress("DEPRECATION")
      WindowManager.LayoutParams.TYPE_PHONE
    }
    val params = WindowManager.LayoutParams(
      WindowManager.LayoutParams.MATCH_PARENT,
      WindowManager.LayoutParams.WRAP_CONTENT,
      type,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
      PixelFormat.TRANSLUCENT
    )
    params.gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
    params.y = (120 * density).toInt()

    // 拖动
    var downX = 0f
    var downY = 0f
    var startX = 0
    var startY = 0
    var moved = false
    container.setOnTouchListener { _, ev ->
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downX = ev.rawX
          downY = ev.rawY
          startX = params.x
          startY = params.y
          moved = false
          true
        }
        MotionEvent.ACTION_MOVE -> {
          val dx = (ev.rawX - downX).toInt()
          val dy = (ev.rawY - downY).toInt()
          if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true
          params.x = startX + dx
          params.y = startY + dy
          wm.updateViewLayout(container, params)
          true
        }
        MotionEvent.ACTION_UP -> {
          if (!moved) {
            // 点击：关闭
            dismissOverlay()
          }
          true
        }
        else -> false
      }
    }

    wm.addView(container, params)
    overlayView = container
    overlayParams = params
  }

  private fun dismissOverlay() {
    val view = overlayView ?: return
    try {
      windowManager?.removeView(view)
    } catch (e: Exception) {
      Log.w("DesktopLyrics", "移除歌词窗口失败: ${e.message}")
    }
    overlayView = null
    overlayParams = null
  }

  @ReactMethod
  fun closeLyrics() {
    dismissOverlay()
  }

  @ReactMethod
  fun updateLyrics(text: String) {
    try {
      if (overlayView != null) {
        (overlayView?.findViewById<TextView>(R_ID_TEXT))?.text = text
      }
    } catch (e: Exception) {
      // 忽略更新失败
    }
  }

  @ReactMethod
  fun isShowing(promise: Promise) {
    promise.resolve(overlayView != null)
  }

  companion object {
    private const val R_ID_TEXT = 0x1A000001
  }
}
