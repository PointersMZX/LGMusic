package com.lg.music

import android.view.View
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager

/**
 * AppPackages —— 注册本仓全部 Java 原生模块（SecureKwApi/CencModule/DesktopLyrics/LocalMusicScanner）。
 * 各模块继承 ReactContextBaseJavaModule，统一经 Package 暴露到 React 运行时。
 */
class AppPackages : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(
      SecureKwApiModule(reactContext),
      CencModule(reactContext),
      DesktopLyricsModule(reactContext),
      LocalMusicScannerModule(reactContext)
    )

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<View, ReactShadowNode<*>>> =
    emptyList()
}
