/**
 * 播放层：react-native-track-player + SecureKwApi 原生桥（网关 resolve）
 */
import TrackPlayer, { Capability } from 'react-native-track-player'
import { NativeModules } from 'react-native'

const { SecureKwApi } = NativeModules as {
  SecureKwApi: {
    resolve: (source: string, rid: string, level: string) => Promise<{
      url: string
      level: string
      mimeType?: string
      headers?: Record<string, string>
    }>
    gatewayGet: (path: string) => Promise<string>
    kgSongDetail: (hash: string) => Promise<string>
    search: (source: string, keyword: string, page: number, pagesize: number) => Promise<Array<Record<string, string>>>
  }
}

export const secureApi = SecureKwApi

let initialized = false

export async function setupPlayer(): Promise<void> {
  if (initialized) return
  await TrackPlayer.setupPlayer()
  await TrackPlayer.updateOptions({
    capabilities: [
      Capability.Play,
      Capability.Pause,
      Capability.SkipToNext,
      Capability.SkipToPrevious,
      Capability.SeekTo
    ],
    compactCapabilities: [Capability.Play, Capability.Pause]
  })
  initialized = true
}

export interface PlayableTrack {
  rid: string
  name: string
  artist: string
  album?: string
  pic?: string
  duration?: number
  source: string
}

/** 经原生桥解析播放地址并交给 track-player */
export async function playTrack(track: PlayableTrack): Promise<void> {
  await setupPlayer()
  const resolved = await secureApi.resolve(track.source, track.rid, 'standard')
  if (!resolved.url) throw new Error('未取得播放地址')
  await TrackPlayer.reset()
  await TrackPlayer.add({
    id: `${track.source}:${track.rid}`,
    url: resolved.url,
    title: track.name,
    artist: track.artist,
    album: track.album ?? '',
    artwork: track.pic ?? undefined,
    duration: track.duration ?? 0,
    // B 站等源的 Referer 头
    headers: resolved.headers && Object.keys(resolved.headers).length > 0 ? resolved.headers : undefined
  })
  await TrackPlayer.play()
}

export async function togglePlayback(): Promise<void> {
  const state = await TrackPlayer.getPlaybackState()
  if (state.state === 'playing') await TrackPlayer.pause()
  else await TrackPlayer.play()
}

export async function skipNext(): Promise<void> {
  await TrackPlayer.skipToNext()
}

export async function skipPrev(): Promise<void> {
  await TrackPlayer.skipToPrevious()
}

/** 六源搜索（原生 SecureKwApi.search，返回归一化歌单项） */
export async function searchMusic(
  source: string,
  keyword: string,
  page: number,
  pagesize: number
): Promise<PlayableTrack[]> {
  const res = await secureApi.search(source, keyword, page, pagesize)
  return (res || []).map((item) => ({
    rid: item.rid ?? '',
    name: item.name ?? '',
    artist: item.artist ?? '',
    album: item.album,
    pic: item.pic,
    duration: Number(item.duration) || undefined,
    source
  })).filter((t) => t.rid || t.name)
}
