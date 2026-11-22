/**
 * 主进程入口：窗口管理、托盘、桌面歌词、下载管理、全量 IPC 编排。
 * 结构忠实还原自青听 v1.0.3 桌面端主进程。
 */
import { app, BrowserWindow, Tray, Menu, session, ipcMain, dialog, nativeImage, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { Stream } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'

import { accountClient, accountErrorInfo } from './account/client'
import { MusicGatewayClient } from './gateway/client'
import { qmcProxy } from './qmc/server'
import { playlistLibrary, playlistErrorInfo } from './playlist/library'
import { importPlaylist, refreshImportedPlaylist } from './playlist/import'
import { PlaylistSyncEngine } from './playlist/sync'
import { favoriteLibrary, favoriteErrorInfo } from './favorite/library'
import { FavoriteSyncEngine } from './favorite/sync'
import { backupService } from './backup/service'
import { localMusicLibrary, readLocalAudioMetadata } from './localMusic/library'
import { kgCategoryRequest, kgPlaylist, kgSongDetail } from './sources/kg'
import { biliSearch, biliResolve, clearSearchSessions } from './sources/bili'
import { wyPlaylist, wySongDetail } from './sources/wy'
import { kwPlaylist, kwSongDetail } from './sources/kw'
import { qqPlaylist, qqPlaylistSquare, qqSongDetail } from './sources/qq'
import { mgSearch, mgLyric } from './sources/mg'
import { qqLyric, wyLyricPlain, kwLyric, kgLyric } from './sources/lyrics'
import { httpGetText, httpPostText } from './sources/types'
import { GATEWAY_SERVERS } from './gateway/sign'
import { getConfig, setConfig, type AppConfig } from './settings'
import { listSources, importSourceDialog, deleteSource } from './sources-manager'

const VITE_DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL
const RENDERER_DIST = app.isPackaged ? join(app.getAppPath(), 'dist') : join(process.env.APP_ROOT || path.dirname(__dirname, '..'), 'dist')

process.env.APP_ROOT = process.env.APP_ROOT || path.join(__dirname, '..')
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let lyricWindow: BrowserWindow | null = null
let closingToQuit = false
let forceQuit = false

/** 播放地址注册头（按 URL 精确匹配，带过期） */
const playbackHeaders = new Map<string, { headers: Record<string, string>; expiresAt: number }>()

/** 下载任务表 */
interface DownloadTask {
  params: Record<string, unknown>
  resolve: (value: { success: boolean; filePath?: string; id: string }) => void
  reject: (err: Error) => void
  lastBytes: number
  settled: boolean
  startTimer?: NodeJS.Timeout
  inactivityTimer?: NodeJS.Timeout
}
const downloadTasks = new Map<string, DownloadTask>()
const downloadLastTs = new Map<string, number>()
const downloadLastProgress = new Map<string, number>()
const DOWNLOAD_START_TIMEOUT_MS = 30000
const DOWNLOAD_INACTIVITY_TIMEOUT_MS = 60000

let downloadPath: string | null = null

const appConfigFile = (): string => {
  const dir = path.join(app.getPath('userData'), 'data')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'app-config.json')
}

const loadDownloadPath = (): void => {
  try {
    const file = appConfigFile()
    if (fs.existsSync(file)) {
      const json = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (json.downloadPath) downloadPath = json.downloadPath
    }
  } catch (err) {
    console.error('加载配置文件失败:', err)
  }
}

const saveDownloadPath = (): void => {
  try {
    if (!downloadPath) return
    const file = appConfigFile()
    let json: Record<string, unknown> = {}
    if (fs.existsSync(file)) {
      try {
        json = JSON.parse(fs.readFileSync(file, 'utf-8'))
      } catch {
        /* 损坏则重写 */
      }
    }
    json.downloadPath = downloadPath
    fs.writeFileSync(file, JSON.stringify(json, null, 2))
  } catch (err) {
    console.error('保存配置文件失败:', err)
  }
}

const currentDownloadPath = (): string => downloadPath || app.getPath('downloads')

// ---------------------------------------------------------------------------
// 实例绑定与网关客户端
// ---------------------------------------------------------------------------

const gateway = new MusicGatewayClient({
  getAppVersion: () => app.getVersion(),
  getDeviceId: () => accountClient.getDeviceIdentity().id,
  getAccessTokenForGateway: () => accountClient.getAccessTokenForGateway()
})

const playlistSync = new PlaylistSyncEngine(playlistLibrary, accountClient)
const favoriteSync = new FavoriteSyncEngine(accountClient)

// ---------------------------------------------------------------------------
// 主窗口 / 托盘 / 桌面歌词
// ---------------------------------------------------------------------------

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    frame: false,
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.on('close', (event) => {
    if (forceQuit || closingToQuit) return
    event.preventDefault()
    closingToQuit = false
    mainWindow?.webContents.send('app-close-requested')
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(VITE_DEV_SERVER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function hideToTray(): void {
  mainWindow?.hide()
}

function ensureTray(): void {
  if (tray) {
    tray.focus()
    return
  }
  const iconPath = join(process.env.VITE_PUBLIC || RENDERER_DIST, 'icon.png')
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty()
  tray = new Tray(icon)
  tray.setToolTip('甘露音乐')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => {
          mainWindow?.show()
          mainWindow?.focus()
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          forceQuit = true
          app.quit()
        }
      }
    ])
  )
  tray.on('double-click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
}

function createLyricWindow(): void {
  if (lyricWindow) {
    lyricWindow.focus()
    return
  }
  const { screen } = require('electron') as typeof Electron
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  lyricWindow = new BrowserWindow({
    width: 800,
    height: 200,
    x: Math.floor((width - 800) / 2),
    y: Math.floor(height * 0.7),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })
  lyricWindow.setBackgroundColor('#00000000')
  if (VITE_DEV_SERVER_URL) {
    void lyricWindow.loadURL(`${VITE_DEV_SERVER_URL}/desktop-lyric.html`)
  } else {
    void lyricWindow.loadFile(join(RENDERER_DIST, 'desktop-lyric.html'))
  }
  lyricWindow.webContents.on('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('lyric-window-opened')
  })
  lyricWindow.on('closed', () => {
    lyricWindow = null
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('lyric-window-closed')
  })
}

function closeLyricWindow(): void {
  lyricWindow?.close()
  lyricWindow = null
}

// ---------------------------------------------------------------------------
// 下载管理
// ---------------------------------------------------------------------------

function cancelDownload(url: string, message: string, item?: Electron.DownloadItem): void {
  const task = downloadTasks.get(url)
  if (!task || task.settled) return
  task.settled = true
  if (task.startTimer) clearTimeout(task.startTimer)
  if (task.inactivityTimer) clearTimeout(task.inactivityTimer)
  downloadTasks.delete(url)
  downloadLastTs.delete(url)
  downloadLastProgress.delete(url)
  try {
    if (item && item.getState() === 'progressing') item.cancel()
  } catch (err) {
    console.warn('取消失败下载任务时出错:', err)
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('download-error', {
      id: url,
      error: message,
      name: task.params.name,
      artist: task.params.artist,
      album: task.params.album,
      cover: task.params.cover,
      quality: task.params.quality,
      source: task.params.source,
      mediaType: task.params.mediaType || 'audio'
    })
  }
  task.reject(new Error(message))
}

function sanitizeFileName(input: unknown, fallback: string): string {
  return (
    String(input || '')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/[. ]+$/g, '')
      .trim() || fallback
  ).slice(0, 120)
}

const AUDIO_EXTS = new Set(['mp3', 'flac', 'm4a', 'aac', 'ogg', 'wav'])
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mkv', 'mov', 'm4v'])

function startDownload(input: Record<string, unknown>): Promise<{ success: boolean; filePath?: string; id: string }> {
  return new Promise((resolve, reject) => {
    const url = String(input?.url || '')
    try {
      if (!input || !input.url) {
        reject(new Error('下载链接不能为空'))
        return
      }
      const mediaType = String(input.mediaType || 'audio')
      if (!input.name || (mediaType === 'audio' && !input.artist)) {
        reject(new Error(mediaType === 'mv' ? 'MV 信息不完整' : '歌曲信息不完整'))
        return
      }
      const extRaw = String(input.format || '').toLowerCase().replace(/^\./, '')
      if (mediaType === 'mv' && extRaw === 'm3u8') {
        reject(new Error('暂不支持下载 M3U8 分片视频'))
        return
      }
      const task: DownloadTask = { params: input, resolve, reject, lastBytes: 0, settled: false }
      downloadTasks.set(url, task)
      task.startTimer = setTimeout(() => {
        cancelDownload(url, '下载启动超时，下载地址可能已失效或服务器无响应')
      }, DOWNLOAD_START_TIMEOUT_MS)
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('开始下载任务:', input.name, url)
        const headers =
          input.headers && typeof input.headers === 'object' && !Array.isArray(input.headers)
            ? Object.fromEntries(
                Object.entries(input.headers as Record<string, unknown>)
                  .filter(([key, value]) => key.trim() && value !== undefined && value !== null)
                  .map(([key, value]) => [key, String(value)])
              )
            : undefined
        if (headers && Object.keys(headers).length > 0) {
          mainWindow.webContents.downloadURL(url, { headers })
        } else {
          mainWindow.webContents.downloadURL(url)
        }
        mainWindow.webContents.send('download-started', {
          id: url,
          name: input.name || '未知歌曲',
          artist: input.artist || '未知艺术家',
          album: input.album || '',
          cover: input.cover || '',
          quality: input.quality || 'exhigh',
          source: input.source || '',
          mediaType: mediaType
        })
      } else {
        cancelDownload(url, '窗口不存在')
      }
    } catch (err) {
      cancelDownload(url, err instanceof Error ? err.message : String(err))
    }
  })
}

function setupDownloadListener(): void {
  session.defaultSession.on('will-download', (_event, item) => {
    const requestedUrl = item.getURL()
    const urls = new Set([item.getURL(), ...item.getURLChain()])
    let matchedUrl = ''
    for (const candidate of urls) {
      if (downloadTasks.has(candidate)) {
        matchedUrl = candidate
        break
      }
    }
    console.log('will-download 事件触发，URL:', requestedUrl, '任务:', matchedUrl || '未匹配')
    const task = matchedUrl ? downloadTasks.get(matchedUrl) : undefined
    if (!task || !task.params) {
      console.log('未找到下载任务，取消下载:', requestedUrl)
      item.cancel()
      return
    }
    console.log('找到下载任务:', task.params.name)
    if (task.startTimer) {
      clearTimeout(task.startTimer)
      task.startTimer = undefined
    }
    const armInactivity = (): void => {
      if (task.inactivityTimer) clearTimeout(task.inactivityTimer)
      task.inactivityTimer = setTimeout(() => {
        cancelDownload(matchedUrl, '下载长时间没有进度，服务器可能无响应或下载地址已失效', item)
      }, DOWNLOAD_INACTIVITY_TIMEOUT_MS)
    }
    armInactivity()
    const params = task.params
    const mediaType = String(params.mediaType || 'audio')
    if (!params.name || (mediaType === 'audio' && !params.artist)) {
      cancelDownload(matchedUrl, mediaType === 'mv' ? 'MV 信息不完整' : '歌曲信息不完整', item)
      return
    }
    const targetDir = currentDownloadPath()
    let ext = String(params.format || '').toLowerCase().replace(/^\./, '')
    if (!ext) {
      try {
        ext = path.extname(new URL(String(params.url)).pathname).slice(1).toLowerCase()
      } catch {
        ext = ''
      }
    }
    const ext2 =
      mediaType === 'mv'
        ? `.${VIDEO_EXTS.has(ext) ? ext : 'mp4'}`
        : AUDIO_EXTS.has(ext)
          ? `.${ext}`
          : params.quality === 'lossless'
            ? '.flac'
            : '.mp3'
    const name = sanitizeFileName(params.name, mediaType === 'mv' ? '未知MV' : '未知歌曲')
    const artist = sanitizeFileName(params.artist, '未知艺术家')
    const quality = sanitizeFileName(params.quality, '默认画质')
    const fileName = mediaType === 'mv' ? `${name} - ${artist} - ${quality}${ext2}` : `${name} - ${artist}${ext2}`
    const savePath = path.join(targetDir, fileName)
    try {
      if (fs.existsSync(savePath)) {
        fs.unlinkSync(savePath)
        console.log('删除已存在文件，准备覆盖:', savePath)
      }
    } catch (err) {
      console.error('删除已有同名文件失败:', err)
    }
    item.setSavePath(savePath)
    item.on('updated', (_e, state) => {
      if (task.settled) return
      if (state === 'interrupted') {
        cancelDownload(matchedUrl, '网络连接中断，下载失败', item)
        return
      }
      if (state !== 'progressing' || !mainWindow || mainWindow.isDestroyed()) return
      const received = item.getReceivedBytes()
      const total = item.getTotalBytes()
      if (received > task.lastBytes) {
        task.lastBytes = received
        armInactivity()
      }
      let progress: number
      if (total > 0) progress = received / total
      else progress = Math.min(0.99, received / (received + 5 * 1024 * 1024))
      const percent = Math.round((received > 0 ? progress : 0.01) * 100)
      const now = Date.now()
      const lastTs = downloadLastTs.get(matchedUrl) ?? 0
      const lastPercent = downloadLastProgress.get(matchedUrl) ?? -1
      const throttled = now - lastTs < 100
      const tinyDelta = Math.abs(percent - lastPercent) < 1
      if ((throttled && tinyDelta && percent !== 100) || percent === 0) return
      downloadLastTs.set(matchedUrl, now)
      downloadLastProgress.set(matchedUrl, percent)
      mainWindow.webContents.send('download-progress', {
        id: matchedUrl,
        progress: percent,
        received,
        total: total || 0
      })
    })
    item.on('done', (_e, state) => {
      if (task.inactivityTimer) clearTimeout(task.inactivityTimer)
      downloadLastTs.delete(matchedUrl)
      downloadLastProgress.delete(matchedUrl)
      console.log('下载完成，状态:', state)
      if (task.settled) {
        downloadTasks.delete(matchedUrl)
        return
      }
      task.settled = true
      if (state === 'completed') {
        const savedPath = item.getSavePath()
        console.log('文件保存路径:', savedPath)
        if (!fs.existsSync(savedPath)) {
          console.error('文件不存在:', savedPath)
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-error', {
              id: matchedUrl,
              error: '下载的文件不存在',
              name: params.name,
              artist: params.artist,
              album: params.album,
              cover: params.cover,
              quality: params.quality,
              source: params.source,
              mediaType
            })
          }
          task.reject(new Error('下载的文件不存在'))
          downloadTasks.delete(matchedUrl)
          return
        }
        let size = 0
        try {
          size = fs.statSync(savedPath).size
          console.log('文件大小:', size)
        } catch (err) {
          console.error('获取文件大小失败:', err)
        }
        // 音频写元数据由渲染层触发（musicMeta 模块后续接入）
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            const info = {
              id: matchedUrl,
              filePath: savedPath,
              name: params.name || '未知歌曲',
              artist: params.artist || '未知艺术家',
              album: params.album || '',
              cover: params.cover || '',
              size,
              downloadTime: new Date().toISOString().split('T')[0],
              quality: params.quality || 'exhigh',
              source: params.source || '',
              mediaType
            }
            mainWindow.webContents.send('download-complete', info)
            console.log('已发送下载完成事件:', info.name)
          }
        } catch (err) {
          console.error('发送下载完成事件失败:', err)
        }
        try {
          task.resolve({ success: true, filePath: savedPath, id: matchedUrl })
          console.log('下载任务完成')
        } catch (err) {
          console.error('解析 Promise 失败:', err)
        }
      } else {
        console.error('下载失败，状态:', state)
        const message = state === 'cancelled' ? '下载已取消' : '下载中断，请检查网络后重试'
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('download-error', {
            id: matchedUrl,
            error: message,
            name: params.name,
            artist: params.artist,
            album: params.album,
            cover: params.cover,
            quality: params.quality,
            source: params.source,
            mediaType
          })
        }
        task.reject(new Error(message))
      }
      downloadTasks.delete(matchedUrl)
    })
  })
}

// ---------------------------------------------------------------------------
// 通用返回包装
// ---------------------------------------------------------------------------

function wrapHandler<T>(fn: () => Promise<T>): Promise<T | { ok: false; error: unknown }> {
  return fn().then(
    (data) => data,
    (err) => ({ ok: false, error: err })
  )
}

// ---------------------------------------------------------------------------
// IPC 注册
// ---------------------------------------------------------------------------

function registerIpcHandlers(): void {
  // 窗口与关闭流程
  ipcMain.on('app-close-action', (_e, action: string) => {
    closingToQuit = false
    if (action === 'quit') {
      forceQuit = true
      app.quit()
    } else if (action === 'tray') {
      hideToTray()
    }
  })
  ipcMain.on('window-control', (_e, action: string) => {
    if (!mainWindow) return
    switch (action) {
      case 'minimize':
        mainWindow.minimize()
        break
      case 'maximize':
        mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
        break
      case 'close':
        mainWindow.close()
        break
      case 'tray':
        hideToTray()
        break
      case 'fullscreen':
        mainWindow.setFullScreen(true)
        break
      case 'fullscreen-exit':
        mainWindow.setFullScreen(false)
        break
    }
  })
  ipcMain.on('lyric-window-control', (_e, action: string) => {
    switch (action) {
      case 'open':
        createLyricWindow()
        break
      case 'close':
        closeLyricWindow()
        break
      case 'toggle':
        lyricWindow ? closeLyricWindow() : createLyricWindow()
        break
    }
  })
  ipcMain.on('update-desktop-lyric', (_e, payload) => {
    if (lyricWindow && !lyricWindow.isDestroyed()) lyricWindow.webContents.send('lyric-update', payload)
  })
  ipcMain.on('update-desktop-lyric-settings', (_e, payload) => {
    if (lyricWindow && !lyricWindow.isDestroyed()) lyricWindow.webContents.send('desktop-lyric-settings-update', payload)
  })
  ipcMain.on('player-control', (_e, action, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('player-control-from-lyric', action, payload)
    }
  })

  // B 站
  ipcMain.handle('search-bili', async (_e, input) => {
    const keyword = String(input?.name || '').trim()
    if (!keyword) return { code: 400, msg: '请提供搜索关键词', data: [], hasMore: false }
    try {
      return {
        code: 200,
        msg: '成功',
        ...(await biliSearch(keyword, input?.page ?? 0, input?.limit ?? 20, input?.expandMultiPart === true))
      }
    } catch (err) {
      return { code: 500, msg: err instanceof Error ? err.message : '哔哩哔哩搜索失败', data: [], hasMore: false }
    }
  })
  ipcMain.handle('get-song-detail-bili', async (_e, trackId) => biliResolve(trackId))
  ipcMain.handle('clear-bili-search-sessions', () => {
    clearSearchSessions()
    return true
  })

  // 五源搜索
  ipcMain.handle('search-kw', async (_e, input) => {
    const keyword = String(input?.name || '').trim()
    if (!keyword) return { code: 400, msg: '请提供搜索关键词', data: [] }
    const page = input.page ?? 0
    const limit = input.limit ?? 30
    const url =
      'http://search.kuwo.cn/r.s?' +
      new URLSearchParams({
        client: 'kt',
        all: keyword,
        pn: String(page),
        rn: String(limit),
        uid: '794762570',
        ver: 'kwplayer_ar_9.2.2.1',
        vipver: '1',
        show_copyright_off: '1',
        newver: '1',
        ft: 'music',
        cluster: '0',
        strategy: '2012',
        encoding: 'utf8',
        rformat: 'json',
        vermerge: '1',
        mobi: '1',
        issubtitle: '1'
      }).toString()
    try {
      return JSON.parse(await httpGetText(url, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }))
    } catch (err) {
      throw err instanceof Error && err.message === '请求超时' ? err : err
    }
  })
  ipcMain.handle('search-wy', async (_e, input) => {
    const keyword = String(input?.name || '').trim()
    if (!keyword) return { code: 400, msg: '请提供搜索关键词', data: [] }
    const page = input.page ?? 0
    const limit = input.limit ?? 30
    const { createHash, createCipheriv } = await import('node:crypto')
    const secret = 'e82ckenh8dichen8'
    const payload = JSON.stringify({
      s: keyword,
      type: 1,
      limit,
      total: page === 0,
      offset: page * limit
    })
    const digest = createHash('md5').update(`nobody/api/cloudsearch/pcuse${payload}md5forencrypt`).digest('hex')
    const message = `/api/cloudsearch/pc-36cd479b6b5-${payload}-36cd479b6b5-${digest}`
    const cipher = createCipheriv('aes-128-ecb', Buffer.from(secret), null)
    const sign = (cipher.update(message, 'utf8', 'hex') + cipher.final('hex')).toUpperCase()
    const body = new URLSearchParams({ params: sign }).toString()
    return new Promise((resolve, reject) => {
      const http = require('node:http') as typeof import('node:http')
      const req = http.request(
        {
          hostname: 'interface.music.163.com',
          port: 80,
          path: '/eapi/batch',
          method: 'POST',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
            Origin: 'https://music.163.com',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body)
          },
          timeout: 10000
        },
        (res) => {
          let data = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => (data += chunk))
          res.on('end', () => {
            if (res.statusCode && res.statusCode !== 200) {
              reject(new Error(`请求失败，状态码: ${res.statusCode}`))
              return
            }
            try {
              let json = JSON.parse(data)
              if (typeof json === 'string') json = JSON.parse(json)
              if (Array.isArray(json) && json[0] && json[0].code !== undefined) json = json[0]
              resolve(json)
            } catch {
              reject(new Error('响应解析失败'))
            }
          })
        }
      )
      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('请求超时'))
      })
      req.write(body)
      req.end()
    })
  })
  ipcMain.handle('search-qq', async (_e, input) => {
    const keyword = String(input?.name || '').trim()
    if (!keyword) return { code: 400, msg: '请提供搜索关键词', data: [] }
    const page = (input.page ?? 0) + 1
    const limit = input.limit ?? 30
    const payload = JSON.stringify({
      comm: {
        ct: '11',
        cv: '14090508',
        v: '14090508',
        tmeAppID: 'qqmusic',
        phonetype: 'EBG-AN10',
        deviceScore: '553.47',
        devicelevel: '50',
        newdevicelevel: '20',
        rom: 'HuaWei/EMOTION/EmotionUI_14.2.0',
        os_ver: '12',
        OpenUDID: '0',
        OpenUDID2: '0',
        QIMEI36: '0',
        udid: '0',
        chid: '0',
        aid: '0',
        oaid: '0',
        taid: '0',
        tid: '0',
        wid: '0',
        uid: '0',
        sid: '0',
        modeSwitch: '6',
        teenMode: '0',
        ui_mode: '2',
        nettype: '1020',
        v4ip: ''
      },
      req: {
        module: 'music.search.SearchCgiService',
        method: 'DoSearchForQQMusicMobile',
        param: {
          search_type: 0,
          query: keyword,
          page_num: page,
          num_per_page: limit,
          highlight: 0,
          nqc_flag: 0,
          multi_zhida: 0,
          cat: 2,
          grp: 1,
          sin: 0,
          sem: 0
        }
      }
    })
    try {
      const res = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        method: 'POST',
        headers: { 'User-Agent': 'QQMusic 14090508(android 12)', 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(10000)
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`请求失败，状态码: ${res.status}`)
      return JSON.parse(text)
    } catch (err) {
      throw err instanceof Error && err.name === 'TimeoutError' ? new Error('请求超时') : err
    }
  })
  ipcMain.handle('search-kg', async (_e, input) => {
    const keyword = String(input?.name || '').trim()
    if (!keyword) return { code: 400, msg: '请提供搜索关键词', data: [] }
    const page = (input.page ?? 0) + 1
    const limit = input.limit ?? 30
    const url =
      'https://songsearch.kugou.com/song_search_v2?' +
      new URLSearchParams({
        keyword,
        page: String(page),
        pagesize: String(limit),
        userid: '0',
        clientver: '',
        platform: 'WebFilter',
        filter: '2',
        iscorrection: '1',
        privilege_filter: '0',
        area_code: '1'
      }).toString()
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(10000)
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`请求失败，状态码: ${res.status}`)
      return JSON.parse(text)
    } catch (err) {
      throw err instanceof Error && err.name === 'TimeoutError' ? new Error('请求超时') : err
    }
  })
  ipcMain.handle('search-mg', async (_e, input) => {
    const keyword = String(input?.name || '').trim()
    if (!keyword) return { code: 400, msg: '请提供搜索关键词', data: [] }
    return mgSearch(keyword, input.page ?? 0, input.limit ?? 30)
  })
  ipcMain.handle('get-kg-catalog', (_e, input) => kgCategoryRequest(input))

  // 歌词
  ipcMain.handle('get-lyric-qq', (_e, songMid) => qqLyric(songMid))
  ipcMain.handle('get-lyric-wy', (_e, id) => wyLyricPlain(id))
  ipcMain.handle('get-lyric-kw', (_e, id) => kwLyric(id))
  ipcMain.handle('get-lyric-kg', (_e, hash) => kgLyric(hash))
  ipcMain.handle('get-lyric-mg', async (_e, id) => {
    console.log('[Main] 收到获取咪咕歌词请求:', id)
    try {
      return { code: 200, lyric: await mgLyric(id) }
    } catch (err) {
      console.error('get-lyric-mg error:', err)
      return { code: 500, msg: 'Internal Server Error' }
    }
  })

  // 音质大小
  ipcMain.handle('get-quality-sizes', async (_e, input) => {
    const aliasMap: Record<string, string> = { tx: 'qq' }
    const sourceRaw = String(input?.source || '').trim().toLowerCase()
    const source = aliasMap[sourceRaw] || sourceRaw
    const songId = String(input?.songId ?? '').trim()
    if (!songId) return { success: false, message: '缺少歌曲 ID' }
    const encoded = encodeURIComponent(songId)
    const endpoint = {
      wy: `https://music.haitangw.cc/wy/getwy_quality_size.php?id=${encoded}`,
      kg: `https://music.haitangw.cc/kgqq/get_qualitysize.php/?id=${encoded}&platform=kg`,
      qq: `https://music.haitangw.cc/kgqq/get_qualitysize.php/?id=${encoded}&platform=qq`,
      kw: `https://music.haitangw.cc/kw/getkw_quality_size.php?id=${encoded}`
    }[source]
    if (!endpoint) return { success: false, message: '当前线路不支持查询音质大小' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const res = await fetch(endpoint, { signal: controller.signal, headers: { Accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      const raw = Array.isArray(json?.qualities)
        ? json.qualities
        : Array.isArray(json?.data?.qualities)
          ? json.data.qualities
          : []
      const qualities = raw
        .map((item: Record<string, unknown>) => {
          const level = String(item?.level || '').trim().toLowerCase()
          const size = String(item?.size || '').trim()
          const sizeBytes = Number(item?.size_bytes)
          return {
            level,
            size,
            ...(Number.isFinite(sizeBytes) && sizeBytes > 0 ? { size_bytes: sizeBytes } : {}),
            ...(item?.quality ? { quality: String(item.quality) } : {}),
            ...(item?.format ? { format: String(item.format) } : {}),
            ...(item?.bitrate ? { bitrate: String(item.bitrate) } : {}),
            ...(item?.available === false ? { available: false } : {})
          }
        })
        .filter((item: { level: string }) => !!item.level)
      return qualities.length
        ? { success: true, qualities }
        : { success: false, message: String(json?.msg || json?.message || '暂无音质大小数据') }
    } catch (err) {
      console.error(`[Main] 获取 ${source} 音质大小失败:`, err)
      return {
        success: false,
        message: err instanceof Error && err.name === 'AbortError' ? '音质大小获取超时' : '获取音质大小失败'
      }
    } finally {
      clearTimeout(timer)
    }
  })

  // 歌单与详情
  ipcMain.handle('get-wy-playlist', async (_e, input) => wyPlaylist(input.id, input.limit))
  ipcMain.handle('get-song-detail-wy', async (_e, input) => wySongDetail(input))
  ipcMain.handle('get-kw-playlist', async (_e, input) => kwPlaylist(input.id, input.page, input.limit))
  ipcMain.handle('get-song-detail-kw', async (_e, input) => kwSongDetail(input))
  ipcMain.handle('get-qq-playlist-square', async (_e, input) => qqPlaylistSquare(input.category, input.page, input.limit))
  ipcMain.handle('get-qq-playlist', async (_e, input) => qqPlaylist(input.id))
  ipcMain.handle('get-song-detail-qq', async (_e, input) => qqSongDetail(input))
  ipcMain.handle('get-kg-playlist', async (_e, input) => kgPlaylist(input.id, input.page, input.name))
  ipcMain.handle('get-song-detail-kg', async (_e, input) => kgSongDetail(input))

  // 歌单库
  ipcMain.handle('playlist-get-snapshot', () => wrapHandler(async () => playlistLibrary.getSnapshot()))
  ipcMain.handle('playlist-create', (_e, input) => wrapHandler(async () => playlistLibrary.createPlaylist(input?.name)))
  ipcMain.handle('playlist-rename', (_e, input) => wrapHandler(async () => playlistLibrary.renamePlaylist(input?.playlistId, input?.name)))
  ipcMain.handle('playlist-delete', (_e, input) => wrapHandler(async () => playlistLibrary.deletePlaylist(input)))
  ipcMain.handle('playlist-add-tracks', (_e, input) => wrapHandler(async () => playlistLibrary.addTracks(input?.playlistId, input?.tracks)))
  ipcMain.handle('playlist-remove-tracks', (_e, input) => wrapHandler(async () => playlistLibrary.removeTracks(input?.playlistId, input?.trackIds)))
  ipcMain.handle('playlist-reorder-tracks', (_e, input) => wrapHandler(async () => playlistLibrary.reorderTracks(input?.playlistId, input?.orderedTrackIds)))
  ipcMain.handle('playlist-import', (_e, input) => wrapHandler(async () => importPlaylist(input)))
  ipcMain.handle('playlist-refresh-import', (_e, input) => wrapHandler(async () => refreshImportedPlaylist(input)))
  ipcMain.handle('playlist-search', async (_e, input) => {
    try {
      const source = String(input?.source || '').toLowerCase()
      if (source === 'qq') return qqPlaylistSquare(input?.keyword || input?.category || '10000000', input?.page ?? 1, input?.limit ?? 30)
      return { code: 400, msg: '暂不支持该来源歌单搜索', data: [] }
    } catch (err) {
      return { code: 500, msg: err instanceof Error ? err.message : String(err), data: [] }
    }
  })

  // 歌单云同步
  ipcMain.handle('playlist-sync-get-status', () => wrapHandler(async () => playlistSync.getStatus()))
  ipcMain.handle('playlist-sync-now', () => wrapHandler(async () => playlistSync.retry()))
  ipcMain.handle('playlist-sync-push', () => wrapHandler(async () => playlistSync.pushLocalToCloud()))
  ipcMain.handle('playlist-sync-pull', () => wrapHandler(async () => playlistSync.pullCloudToLocal()))
  ipcMain.on('playlist-sync-online', (_e, payload) => {
    playlistSync.activate(payload?.userId || '', {
      enabled: payload?.enabled,
      autoSyncEnabled: payload?.autoSyncEnabled
    })
  })

  // 收藏库与同步
  ipcMain.handle('favorite-get-snapshot', () => wrapHandler(async () => favoriteLibrary.getSnapshot()))
  ipcMain.handle('favorite-record-local', (_e, input) => wrapHandler(async () => favoriteLibrary.recordLocalFavorites(input)))
  ipcMain.handle('favorite-sync-get-status', () => wrapHandler(async () => favoriteSync.getStatus()))
  ipcMain.handle('favorite-sync-now', () => wrapHandler(async () => favoriteSync.retry()))
  ipcMain.handle('favorite-sync-push', () => wrapHandler(async () => favoriteSync.pushLocalToCloud()))
  ipcMain.handle('favorite-sync-pull', () => wrapHandler(async () => favoriteSync.pullCloudToLocal()))
  ipcMain.on('favorite-sync-online', (_e, payload) => {
    favoriteSync.activate(payload?.userId || '', {
      enabled: payload?.enabled,
      autoSyncEnabled: payload?.autoSyncEnabled
    })
  })

  // 备份
  ipcMain.handle('settings-get', () => getConfig())
  ipcMain.handle('settings-set', (_e, patch) => setConfig(patch as Partial<AppConfig>))
  ipcMain.handle('source-list', () => listSources())
  ipcMain.handle('source-import', () => importSourceDialog(mainWindow ?? undefined))
  ipcMain.handle('source-delete', (_e, fileName) => deleteSource(String(fileName)))
  ipcMain.handle('backup-get-status', () => wrapHandler(async () => backupService.getStatus()))
  ipcMain.handle('backup-set-settings', (_e, input) => wrapHandler(async () => backupService.setSettings(input)))
  ipcMain.handle('backup-create', (_e, input) => wrapHandler(async () => backupService.createBackup(input)))
  ipcMain.handle('backup-list-files', () => wrapHandler(async () => backupService.listFiles()))
  ipcMain.handle('backup-delete-file', (_e, input) => wrapHandler(async () => backupService.deleteFile(input)))
  ipcMain.handle('backup-inspect-file', (_e, input) => wrapHandler(async () => backupService.inspectFile(input)))
  ipcMain.handle('backup-choose-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
      title: '选择备份目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths?.length) return { success: false }
    await backupService.setSettings({ path: result.filePaths[0] })
    return { success: true, path: result.filePaths[0] }
  })
  ipcMain.handle('backup-choose-import-file', async (_e, input) => {
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
      title: '选择备份文件',
      properties: ['openFile'],
      filters: [{ name: '备份文件', extensions: ['txt'] }]
    })
    if (result.canceled || !result.filePaths?.length) return { success: false }
    return backupService.chooseImportPath(result.filePaths[0])
  })
  ipcMain.handle('backup-import', (_e, input) => wrapHandler(async () => backupService.importBackup(input?.path, input?.scopes)))
  ipcMain.handle('backup-run-automatic', (_e, input) =>
    wrapHandler(async () => backupService.runAutomaticBackup({ force: input?.force === true, trigger: 'manual' }))
  )
  ipcMain.handle('backup-open-directory', () => {
    shell.openPath(backupService.getSettings().path)
  })

  // 账号
  ipcMain.handle('account-get-state', () => wrapHandler(async () => accountClient.getState()))
  ipcMain.handle('account-send-register-email-code', (_e, input) => wrapHandler(async () => accountClient.sendRegisterEmailCode(input)))
  ipcMain.handle('account-register', (_e, input) => wrapHandler(async () => accountClient.register(input)))
  ipcMain.handle('account-login', (_e, input) => wrapHandler(async () => accountClient.login(input)))
  ipcMain.handle('account-send-password-reset-code', (_e, input) => wrapHandler(async () => accountClient.sendPasswordResetEmailCode(input)))
  ipcMain.handle('account-reset-password', (_e, input) => wrapHandler(async () => accountClient.resetPassword(input)))
  ipcMain.handle('account-change-password', (_e, input) => wrapHandler(async () => accountClient.changePassword(input)))
  ipcMain.handle('account-logout', () => wrapHandler(async () => accountClient.logout()))
  ipcMain.handle('account-update-profile', (_e, input) => wrapHandler(async () => accountClient.updateProfile(input)))
  ipcMain.handle('account-send-binding-email-code', (_e, input) => wrapHandler(async () => accountClient.sendBindingEmailCode(input)))
  ipcMain.handle('account-bind-email', (_e, email, code) => wrapHandler(async () => accountClient.bindEmail(email, code)))
  ipcMain.handle('account-upload-avatar', () => wrapHandler(async () => accountClient.selectAndUploadMedia('avatar', mainWindow)))
  ipcMain.handle('account-upload-background', () => wrapHandler(async () => accountClient.selectAndUploadMedia('background', mainWindow)))
  ipcMain.handle('account-remove-avatar', () => wrapHandler(async () => accountClient.removeMedia('avatar')))
  ipcMain.handle('account-remove-background', () => wrapHandler(async () => accountClient.removeMedia('background')))

  // 音乐网关
  ipcMain.handle('music-gateway-resolve', (_e, input) => gateway.resolve(input))
  ipcMain.handle('music-gateway-clear-cache', () => gateway.clearCache())

  // 本地音乐
  ipcMain.handle('local-music-get-state', () => localMusicLibrary.getState())
  ipcMain.handle('local-music-choose-directories', async () => {
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
      title: '选择音乐目录',
      properties: ['openDirectory', 'multiSelections']
    })
    if (result.canceled || !result.filePaths?.length) return localMusicLibrary.getState()
    return localMusicLibrary.addDirectories(result.filePaths)
  })
  ipcMain.handle('local-music-remove-directory', (_e, input) => localMusicLibrary.removeDirectory(input))
  ipcMain.handle('local-music-clear', () => localMusicLibrary.clear())
  ipcMain.handle('local-music-scan', () => localMusicLibrary.scan(mainWindow?.webContents ?? null))
  ipcMain.handle('local-music-get-cover', (_e, input) => localMusicLibrary.getCover(input))
  ipcMain.handle('read-local-audio-metadata', (_e, input) => readLocalAudioMetadata(input))

  // 下载
  ipcMain.handle('download-music', (_e, input) => startDownload({ ...input, mediaType: 'audio' }))
  ipcMain.handle('download-mv', (_e, input) => startDownload({ ...input, mediaType: 'mv' }))
  ipcMain.handle('download-lyrics', (_e, input) => {
    try {
      const lyrics = String(input?.lyrics || '')
      if (!lyrics.trim()) return { success: false, message: '歌词内容为空' }
      const name = sanitizeFileName(input?.name, '未知歌曲')
      const artist = sanitizeFileName(input?.artist, '')
      const fileName = artist ? `${name} - ${artist}.lrc` : `${name}.lrc`
      const dir = currentDownloadPath()
      fs.mkdirSync(dir, { recursive: true })
      const filePath = path.join(dir, fileName)
      fs.writeFileSync(filePath, lyrics, 'utf8')
      return { success: true, filePath }
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : '歌词下载失败' }
    }
  })
  ipcMain.handle('get-download-path', () => currentDownloadPath())
  ipcMain.handle('set-download-path', async () => {
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
      title: '选择下载保存位置',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths?.length) return { success: false }
    const previous = currentDownloadPath()
    downloadPath = result.filePaths[0]
    saveDownloadPath()
    if (previous === downloadPath) {
      try {
        await backupService.setSettings({ path: downloadPath })
      } catch (err) {
        console.warn('[backup] 同步歌曲下载目录失败', err)
      }
    }
    return { success: true, path: downloadPath }
  })
  ipcMain.handle('open-download-directory', () => {
    shell.openPath(currentDownloadPath())
  })
  ipcMain.handle('open-local-file', async (_e, input) => {
    if (!input || typeof input !== 'string' || !path.isAbsolute(input)) return { success: false, message: '无效的本地文件路径' }
    if (!fs.existsSync(input)) return { success: false, message: '本地文件不存在' }
    const err = await shell.openPath(input)
    return { success: !err, message: err }
  })
  ipcMain.handle('open-external', async (_e, input) => {
    if (!input || typeof input !== 'string') return { success: false, message: '无效的链接' }
    try {
      await shell.openExternal(input)
      return { success: true }
    } catch (err) {
      console.error('打开外部链接失败:', err)
      return { success: false, message: String(err) }
    }
  })

  // 播放会话
  ipcMain.handle('register-playback-headers', (_e, input) => {
    if (!input?.url || !input.headers || Object.keys(input.headers).length === 0) return false
    const parsed = new URL(String(input.url))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('仅支持为 HTTP(S) 播放地址注册请求头')
    }
    const expiresRaw = Number(input.expiresAt)
    const expiresAt = Number.isFinite(expiresRaw) && expiresRaw > 0 ? (expiresRaw < 1e12 ? expiresRaw * 1000 : expiresRaw) : Date.now() + 24 * 60 * 60 * 1000
    playbackHeaders.set(String(input.url), { headers: input.headers, expiresAt })
    return true
  })
  ipcMain.handle('create-qmc-playback-session', (_e, input) => qmcProxy.createSession(input))

  // 通用存储
  const dataFile = (name: string): string => {
    const dir = path.join(app.getPath('userData'), 'data')
    fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, name)
  }
  ipcMain.handle('write-data', async (_e, name, value) => {
    try {
      fs.writeFileSync(dataFile(`${name}.json`), JSON.stringify(value, null, 2))
      return { success: true }
    } catch (err) {
      console.error(`写入数据失败 ${name}:`, err)
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('read-data', async (_e, name) => {
    try {
      const file = dataFile(`${name}.json`)
      if (fs.existsSync(file)) {
        return { success: true, data: JSON.parse(fs.readFileSync(file, 'utf-8')) }
      }
      return { success: true, data: null }
    } catch (err) {
      console.error(`读取数据失败 ${name}:`, err)
      return { success: false, error: String(err) }
    }
  })

  // 手动更新下载（留壳：支持任意 HTTPS 包下载后打开）
  ipcMain.handle('download-update', async (_e, input) => {
    const url = String(input?.url || '').trim()
    let filePath = ''
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { success: false, message: '在线更新仅支持 HTTP(S) 地址' }
      }
      const fallbackName = process.platform === 'win32' ? 'LGMusic-Update.exe' : process.platform === 'darwin' ? 'LGMusic-Update.dmg' : 'LGMusic-Update.AppImage'
      const baseName =
        typeof input?.fileName === 'string' && input.fileName.trim()
          ? input.fileName.trim()
          : decodeURIComponent(path.basename(parsed.pathname))
      const fileName = path
        .basename(baseName || fallbackName)
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/^\.+/, '')
      const ext = path.extname(fileName).toLowerCase()
      if (!new Set(['.exe', '.msi', '.dmg', '.pkg', '.appimage']).has(ext)) {
        return { success: false, message: '更新包格式不受支持，请配置 exe、msi、dmg、pkg 或 AppImage' }
      }
      const dir = path.join(app.getPath('temp'), 'LGMusic-updates')
      await fs.promises.mkdir(dir, { recursive: true })
      filePath = path.join(dir, fileName)
      await fs.promises.rm(filePath, { force: true })
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok || !res.body) {
        return { success: false, message: `更新包下载失败（HTTP ${res.status}）` }
      }
      const total = Number(res.headers.get('content-length') || 0)
      let received = 0
      let lastTick = 0
      const stream = Stream.Readable.fromWeb(res.body as never)
      stream.on('data', (chunk: Buffer) => {
        received += chunk.length
        const now = Date.now()
        const progress = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null
        if (now - lastTick >= 150 || progress === 100) {
          lastTick = now
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-download-progress', { progress, received, total })
          }
        }
      })
      await pipeline(stream, fs.createWriteStream(filePath))
      const openError = await shell.openPath(filePath)
      return openError ? { success: false, filePath, message: openError } : { success: true, filePath }
    } catch (err) {
      if (filePath) await fs.promises.rm(filePath, { force: true }).catch(() => undefined)
      console.error('在线更新下载失败:', err)
      return { success: false, message: err instanceof Error ? err.message : String(err) }
    }
  })
}

// ---------------------------------------------------------------------------
// 启动编排
// ---------------------------------------------------------------------------

const refreshAccountBindings = async (): Promise<void> => {
  try {
    const state = await accountClient.getState()
    const userId = state.status === 'authenticated' ? state.user?.id ?? null : null
    const playlistChanged = playlistLibrary.setActiveUser(userId)
    favoriteLibrary.setActiveUser(userId)
    if (userId) {
      playlistSync.activate(userId, {
        enabled: state.user?.cloudSyncEnabled === true,
        autoSyncEnabled: state.user?.cloudSyncAutoEnabled !== false
      })
      favoriteSync.activate(userId, {
        enabled: state.user?.cloudSyncEnabled === true,
        autoSyncEnabled: state.user?.cloudSyncAutoEnabled !== false
      })
    } else {
      playlistSync.stop()
      favoriteSync.stop()
    }
    if (playlistChanged) {
      mainWindow?.webContents.send('playlist-library-changed')
      mainWindow?.webContents.send('favorite-library-changed')
    }
  } catch (err) {
    console.warn('[playlist-library] 获取账号状态失败，使用游客歌单库', err)
    const changed = playlistLibrary.setActiveUser(null)
    favoriteLibrary.setActiveUser(null)
    playlistSync.stop()
    favoriteSync.stop()
    if (changed) {
      mainWindow?.webContents.send('playlist-library-changed')
      mainWindow?.webContents.send('favorite-library-changed')
    }
  }
}

app.whenReady().then(() => {
  const userData = app.getPath('userData')
  accountClient.bindUserData(userData)
  gateway.bindUserData(userData)
  playlistLibrary.bindUserData(userData)
  favoriteLibrary.bindUserData(userData)
  backupService.bindUserData(userData)
  localMusicLibrary.bindUserData(userData)
  backupService.setSongDownloadPathProvider(() => downloadPath)
  playlistLibrary.setLocalChangeListener(() => playlistSync.notifyLocalChange())
  favoriteLibrary.setLocalChangeListener(() => favoriteSync.notifyLocalChange())

  loadDownloadPath()
  setupDownloadListener()
  registerIpcHandlers()
  gateway.startTicketRefresh()
  ensureTray()
  createMainWindow()

  app.on('browser-window-focus', () => {
    /* 保留：原版在此处理失焦降级 */
  })

  setTimeout(() => {
    void refreshAccountBindings()
  }, 800)
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  forceQuit = true
  gateway.dispose()
  qmcProxy.dispose()
})

export { accountErrorInfo, favoriteErrorInfo, playlistErrorInfo, GATEWAY_SERVERS }
