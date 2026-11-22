/**
 * 播放层：外置音源插件运行时（PluginSourceRuntime）+ react-native-track-player。
 * 本体不内置任何音源：搜索/取播放地址全部由用户导入的音源脚本提供。
 */
import TrackPlayer, { Capability, Event, State } from 'react-native-track-player'
import { NativeModules } from 'react-native'

const { PluginSourceRuntime } = NativeModules as {
  PluginSourceRuntime: {
    listSources: () => Promise<Array<{ fileName: string; name: string; importedAt: number }>>
    importSourceUrl: (url: string) => Promise<string>
    deleteSource: (fileName: string) => Promise<boolean>
    loadPlugin: (fileName: string) => Promise<string>
    getLoadedPlugin: () => Promise<string | null>
    callPlugin: (action: string, payload: Record<string, string>) => Promise<string>
  }
}

export const pluginRuntime = PluginSourceRuntime
export { Event, State }

let initialized = false

export async function setupPlayer(): Promise<void> {
  if (initialized) return
  await TrackPlayer.setupPlayer()
  await TrackPlayer.updateOptions({
    capabilities: [
      Capability.Play,
      Capability.Pause,
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
  /** 来源音源脚本文件名（插件标识） */
  source: string
}

export interface MusicSource {
  fileName: string
  name: string
  importedAt: number
}

export async function listSources(): Promise<MusicSource[]> {
  return (await PluginSourceRuntime.listSources()) || []
}

export async function importSourceUrl(url: string): Promise<string> {
  return await PluginSourceRuntime.importSourceUrl(url)
}

export async function deleteSource(fileName: string): Promise<boolean> {
  return await PluginSourceRuntime.deleteSource(fileName)
}

export async function loadPlugin(fileName: string): Promise<string> {
  return await PluginSourceRuntime.loadPlugin(fileName)
}

export async function getLoadedPlugin(): Promise<string | null> {
  return (await PluginSourceRuntime.getLoadedPlugin()) || null
}

function parseJsonResponse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error('音源返回数据异常')
  }
}

/** 通过音源插件搜索歌曲 */
export async function searchMusic(
  source: string,
  keyword: string,
  page: number,
  pagesize: number
): Promise<PlayableTrack[]> {
  const raw = await PluginSourceRuntime.callPlugin(
    'searchMusic',
    { query: keyword, page: String(page), type: 'music' }
  )
  const json = parseJsonResponse(raw)
  // callPlugin 返回的 raw 即插件 result 对象（preload 已包一层 {requestKey,status,result}）
  const result = (json.result ?? json) as Record<string, unknown>
  const list = (result.data as Array<Record<string, unknown>>) || []
  return list
    .map((item) => normalizePluginTrack(item, source))
    .filter((t) => t.rid || t.name)
}

/** MusicFree 插件歌曲条目 → 统一结构 */
function normalizePluginTrack(item: Record<string, unknown>, source: string): PlayableTrack {
  const musicItem = (item.musicItem ?? item) as Record<string, unknown>
  return {
    rid: String(musicItem.id ?? musicItem.rid ?? ''),
    name: String(musicItem.title ?? musicItem.name ?? ''),
    artist: String(
      (musicItem.artist as Record<string, unknown>)?.name ??
        musicItem.artist ??
        musicItem.singer ??
        ''
    ),
    album: (musicItem.album as Record<string, unknown>)?.name as string | undefined,
    pic:
      ((musicItem.cover ?? musicItem.artwork ?? musicItem.img) as string | undefined) ||
      ((musicItem.album as Record<string, unknown>)?.cover as string | undefined),
    duration: Number(musicItem.duration) || undefined,
    source
  }
}

/** 经音源插件解析播放地址并交给 track-player */
export async function playTrack(track: PlayableTrack): Promise<void> {
  await setupPlayer()
  const raw = await PluginSourceRuntime.callPlugin(
    'getMediaSource',
    {
      musicItem: JSON.stringify({
        id: track.rid,
        title: track.name,
        artist: track.artist,
        album: track.album ?? '',
        cover: track.pic ?? '',
        duration: track.duration ?? 0
      }),
      quality: 'standard'
    }
  )
  const json = parseJsonResponse(raw)
  const result = (json.result ?? json) as Record<string, unknown>
  const url = String(result.url ?? '')
  if (!url) throw new Error((json.errorMessage as string) || '音源未返回播放地址')

  const headers: Record<string, string> = {}
  const resultHeaders = (result.headers ?? {}) as Record<string, unknown>
  Object.keys(resultHeaders).forEach((k) => {
    headers[k] = String(resultHeaders[k])
  })
  const userAgent = result.userAgent as string | undefined
  if (userAgent) headers['User-Agent'] = userAgent

  await TrackPlayer.reset()
  await TrackPlayer.add({
    id: `${track.source}:${track.rid}`,
    url,
    title: track.name,
    artist: track.artist,
    album: track.album ?? '',
    artwork: track.pic ?? undefined,
    duration: track.duration ?? 0,
    headers: Object.keys(headers).length > 0 ? headers : undefined
  })
  await TrackPlayer.play()
}

export async function togglePlayback(): Promise<void> {
  const state = await TrackPlayer.getPlaybackState()
  if (state.state === State.Playing) await TrackPlayer.pause()
  else await TrackPlayer.play()
}

export interface PlaybackProgress {
  position: number
  duration: number
}

export async function getProgress(): Promise<PlaybackProgress> {
  try {
    const [position, duration] = await Promise.all([
      TrackPlayer.getPosition(),
      TrackPlayer.getDuration()
    ])
    return { position, duration }
  } catch {
    return { position: 0, duration: 0 }
  }
}

export async function seekTo(seconds: number): Promise<void> {
  await TrackPlayer.seekTo(seconds)
}
