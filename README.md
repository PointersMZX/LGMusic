# 甘露音乐（LG Music）

甘露音乐是一款聚合音乐播放器，提供 Windows 端与 Android 端（分开研发、共用本仓库）。

## 功能

- **液态玻璃视觉**：磨砂玻璃 + 折射 + 七彩色散 + 金色边缘流光，紫金黑主题默认开启
- **4 套主题**：紫金黑（默认）/ 自定义（支持玻璃开关与取色）/ 纯白 / 纯黑
- **本地音乐**：添加本地目录自动扫描（mp3/flac/ogg/oga/wav/m4a），支持 4 种默认排序与自定义拖动排序、按歌名实时搜索、长按多选管理（仅从列表移除，保留本地文件）
- **歌词**：锁屏 / 浮窗歌词（移动端），无歌词时统一显示应用标识
- **自动更新**：应用内版本检查（Windows 提供普通版与 Win7 兼容版）

## 下载与安装

- **Windows**：安装版（NSIS）与绿色版（7z 压缩包）见 [GitHub Releases](https://github.com/PointersMZX/LGMusic/releases)；Win7 兼容版文件名带 `win7` 标识。
- **Android**：APK 见 [GitHub Releases](https://github.com/PointersMZX/LGMusic/releases)（universal 通用包 + 分架构包，按设备选择即可）。

## 更新

- Windows 端应用内自动检查更新；Android 端新版本请从 GitHub Releases 下载。
- 品牌更名后：Android 旧版本需先卸载再安装新版；Windows 端更新后设置将重置（启用新数据目录）。

## 反馈与版权

- 遇到问题请截图并反馈至官方群聊或作者本人（附上具体操作步骤，以及「设置-错误日志」的内容）
- 本项目完全免费且开源，发布于 [GitHub](https://github.com/PointersMZX/LGMusic) 面向全世界用作技术学习交流。

## 开发（仓库维护者）

```bash
# Windows 端
cd LGMusic-desktop
pnpm install
pnpm dev       # 开发
pnpm build     # 生产编译（不打包）

# Android 端
cd LGMusic-mobile
npm install
npm start                    # Metro
npm run pack:android:debug   # 需本机 Android SDK + JDK17
```

| 目录 | 说明 |
| --- | --- |
| `LGMusic-desktop/` | Windows 端（Electron + Vue） |
| `LGMusic-mobile/` | Android 端（React Native） |
| `publish/version.json` | 桌面端更新检查数据源 |
