/** 播放器状态（组合式单例 store） */
import { reactive } from 'vue'
import { api, resolveTrack, extractPlaybackUrl, type UnifiedTrack } from '../api'

interface PlayerState {
  current: UnifiedTrack | null
  queue: UnifiedTrack[]
  queueIndex: number
  playing: boolean
  loading: boolean
  currentTime: number
  duration: number
  level: string
  error: string
}

export const playerState = reactive<PlayerState>({
  current: null,
  queue: [],
  queueIndex: -1,
  playing: false,
  loading: false,
  currentTime: 0,
  duration: 0,
  level: '',
  error: ''
})

let audio: HTMLAudioElement | null = null

function ensureAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio()
    audio.addEventListener('timeupdate', () => {
      playerState.currentTime = audio!.currentTime
    })
    audio.addEventListener('durationchange', () => {
      playerState.duration = audio!.duration || 0
    })
    audio.addEventListener('ended', () => {
      playNext()
    })
    audio.addEventListener('pause', () => {
      playerState.playing = false
    })
    audio.addEventListener('play', () => {
      playerState.playing = true
    })
  }
  return audio
}

async function playTrackAt(index: number): Promise<void> {
  const track = playerState.queue[index]
  if (!track) return
  playerState.queueIndex = index
  playerState.current = track
  playerState.loading = true
  playerState.error = ''
  playerState.level = ''
  try {
    const resolved = await resolveTrack(track.source, track.rid)
    const url = extractPlaybackUrl(resolved)
    if (!url) throw new Error('未取得播放地址')
    playerState.level = resolved.level || ''
    if (resolved.playbackHeaders && Object.keys(resolved.playbackHeaders).length > 0) {
      await api.invoke('register-playback-headers', { url, headers: resolved.playbackHeaders })
    }
    const audioEl = ensureAudio()
    audioEl.src = url
    await audioEl.play()
  } catch (err) {
    playerState.error = err instanceof Error ? err.message : String(err)
  } finally {
    playerState.loading = false
  }
}

export function playTracks(tracks: UnifiedTrack[], startIndex = 0): void {
  playerState.queue = tracks
  void playTrackAt(startIndex)
}

export function playTrack(track: UnifiedTrack): void {
  const index = playerState.queue.findIndex((t) => t.rid === track.rid && t.source === track.source)
  if (index >= 0) {
    void playTrackAt(index)
  } else {
    playerState.queue = [track, ...playerState.queue]
    void playTrackAt(0)
  }
}

export function playNext(): void {
  if (playerState.queueIndex + 1 < playerState.queue.length) {
    void playTrackAt(playerState.queueIndex + 1)
  }
}

export function playPrev(): void {
  if (playerState.queueIndex > 0) {
    void playTrackAt(playerState.queueIndex - 1)
  }
}

export function togglePlay(): void {
  if (!audio) return
  if (audio.paused) void audio.play()
  else audio.pause()
}

export function seekTo(seconds: number): void {
  if (audio && Number.isFinite(seconds)) audio.currentTime = seconds
}

export async function downloadCurrentTrack(): Promise<void> {
  const track = playerState.current
  if (!track) return
  await api.invoke('download-music', {
    url: audio?.src,
    name: track.name,
    artist: track.artist,
    album: track.album,
    cover: track.pic,
    quality: playerState.level,
    source: track.source,
    mediaType: 'audio'
  })
}
