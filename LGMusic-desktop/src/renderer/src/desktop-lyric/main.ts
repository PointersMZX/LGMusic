/**
 * 桌面歌词窗 —— 透明悬浮窗，显示当前/下一行歌词。
 * 结构复刻自青听 v1.0.3 桌面端桌面歌词页。
 * IPC：lyric-update（当前/下一行）、desktop-lyric-settings-update（样式设置）。
 */
import './desktop-lyric.css'

interface LyricPayload {
  line?: string
  next?: string
  rid?: string
  name?: string
}

interface LyricSettings {
  fontSize?: number
  color?: string
  shadow?: boolean
  twoLine?: boolean
}

const app = document.getElementById('app') as HTMLElement

app.innerHTML = `
  <div class="lyric-wrap" id="lyricWrap">
    <div class="lyric-main" id="lyricMain">甘露音乐桌面歌词</div>
    <div class="lyric-next" id="lyricNext"></div>
    <div class="lyric-drag" id="lyricDrag"></div>
    <div class="lyric-close" id="lyricClose">✕</div>
  </div>
`

let settings: LyricSettings = { fontSize: 26, color: '#29c586', shadow: true, twoLine: false }

function applySettings(): void {
  const mainEl = document.getElementById('lyricMain')
  const nextEl = document.getElementById('lyricNext')
  if (!mainEl || !nextEl) return
  mainEl.style.fontSize = `${settings.fontSize ?? 26}px`
  mainEl.style.color = settings.color ?? '#29c586'
  const shadow = settings.shadow === false ? 'none' : '0 2px 8px rgba(0,0,0,0.55)'
  mainEl.style.textShadow = shadow
  nextEl.style.textShadow = shadow
  nextEl.style.display = settings.twoLine === false ? 'none' : 'block'
}

function renderLyric(payload: LyricPayload): void {
  const mainEl = document.getElementById('lyricMain')
  const nextEl = document.getElementById('lyricNext')
  if (!mainEl || !nextEl) return
  mainEl.textContent = (payload.line || '').trim() || '甘露音乐桌面歌词'
  nextEl.textContent = (payload.next || '').trim()
}

window.electronAPI.on('lyric-update', (payload) => {
  renderLyric((payload || {}) as LyricPayload)
})

window.electronAPI.on('desktop-lyric-settings-update', (payload) => {
  settings = { ...settings, ...((payload || {}) as LyricSettings) }
  applySettings()
})

document.getElementById('lyricClose')?.addEventListener('click', () => {
  window.electronAPI.send('lyric-window-control', 'close')
})

applySettings()
