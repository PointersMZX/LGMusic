/**
 * 歌词常驻层：解析/当前行计算/桌面歌词窗推送。
 * 独立于 NowPlayingPage 的显隐生命周期（歌词窗推送不随页面卸载而停止）。
 */
import { reactive, watch } from 'vue'
import { playerState } from './player'
import { api } from '../api'

export interface LyricLine {
  time: number
  text: string
}

export const lyricState = reactive({
  lines: [] as LyricLine[],
  activeIndex: -1,
  loading: false
})

export function parseLyric(text: string): LyricLine[] {
  const out: LyricLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const matches = [...raw.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
    if (!matches.length) continue
    const content = raw
      .replace(/^\[(?:\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?)\]\s*/, '')
      .replace(/\[(?:\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?)\]/g, '')
      .trim()
    for (const m of matches) {
      const time = Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(`0.${m[3]}`) : 0)
      out.push({ time, text: content })
    }
  }
  return out.sort((a, b) => a.time - b.time)
}

const LYRIC_CHANNELS: Record<string, string> = {
  wy: 'get-lyric-wy',
  kw: 'get-lyric-kw',
  kg: 'get-lyric-kg',
  qq: 'get-lyric-qq',
  mg: 'get-lyric-mg'
}

async function loadLyric(): Promise<void> {
  const track = playerState.current
  lyricState.lines = []
  lyricState.activeIndex = -1
  if (!track) return
  const channel = LYRIC_CHANNELS[track.source]
  if (!channel) return
  try {
    const payload = track.source === 'kg' ? (track as Record<string, unknown>).hash ?? track.rid : track.rid
    const res = (await window.electronAPI.invoke(channel, payload)) as Record<string, unknown> | undefined
    const raw = String(res?.lyric || res?.raw_lyric || (res?.lrc as Record<string, unknown> | undefined)?.lyric || res?.lrc || '')
    lyricState.lines = parseLyric(raw)
  } catch {
    lyricState.lines = []
  }
}

function pushDesktopLyric(): void {
  const idx = lyricState.activeIndex
  const line = idx >= 0 ? lyricState.lines[idx]?.text || '' : ''
  const next = idx >= 0 ? lyricState.lines[idx + 1]?.text || '' : ''
  window.electronAPI?.send('update-desktop-lyric', {
    line,
    next,
    rid: playerState.current?.rid ?? '',
    name: playerState.current?.name ?? ''
  })
}

watch(() => playerState.current?.rid, () => void loadLyric(), { immediate: true })

watch(
  () => playerState.currentTime,
  (t) => {
    let idx = -1
    for (let i = 0; i < lyricState.lines.length; i += 1) {
      if (lyricState.lines[i].time <= t) idx = i
      else break
    }
    if (idx !== lyricState.activeIndex) {
      lyricState.activeIndex = idx
      pushDesktopLyric()
    }
  }
)

// 歌词窗刚打开时补推当前行（主进程 lyric-window-opened 广播）
window.electronAPI?.on('lyric-window-opened', () => {
  const idx = lyricState.activeIndex
  const line = idx >= 0 ? lyricState.lines[idx]?.text || '' : ''
  const next = idx >= 0 ? lyricState.lines[idx + 1]?.text || '' : ''
  window.electronAPI.send('update-desktop-lyric', {
    line,
    next,
    rid: playerState.current?.rid ?? '',
    name: playerState.current?.name ?? ''
  })
})
