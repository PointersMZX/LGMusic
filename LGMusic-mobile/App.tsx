/**
 * 甘露音乐 安卓端 —— 复刻青听 v1.4.1 架构
 * 结构：六源搜索 + 播放（SecureKwApi 原生桥 + react-native-track-player）
 * UI：搜索页（六源 tab）+ mini 播放栏 + 全屏播放页（封面/进度/上下曲）
 */
import React, { useCallback, useEffect, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { SafeAreaView } from 'react-native'
import TrackPlayer, {
  Event,
  State,
  type PlaybackStateEvent,
  type PlaybackProgressUpdatedEvent
} from 'react-native-track-player'
import {
  playTrack as startPlayback,
  togglePlayback,
  searchMusic,
  seekTo,
  getProgress,
  setupPlayer,
  listSources,
  importSourceUrl,
  deleteSource,
  loadPlugin,
  type PlayableTrack,
  type MusicSource
} from './player'

interface Track extends PlayableTrack {
  rid: string
}

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

const App = (): React.JSX.Element => {
  const [keyword, setKeyword] = useState('')
  const [tracks, setTracks] = useState<Track[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [current, setCurrent] = useState<Track | null>(null)
  const [playing, setPlaying] = useState(false)
  const [showPlayer, setShowPlayer] = useState(false)
  const [progress, setProgress] = useState({ position: 0, duration: 0 })
  const [sourceResults, setSourceResults] = useState<Record<string, Track[]>>({})
  const [availableSources, setAvailableSources] = useState<MusicSource[]>([])
  const [activeSource, setActiveSource] = useState<string>('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [importing, setImporting] = useState(false)
  const [showSources, setShowSources] = useState(false)

  // 启动时加载已导入音源列表并恢复上次使用的音源
  useEffect(() => {
    void (async () => {
      const list = await listSources().catch(() => [])
      setAvailableSources(list)
      if (list.length > 0) {
        const loaded = await loadPlugin(list[0].fileName).catch(() => null)
        setActiveSource(loaded ?? list[0].fileName)
      }
    })()
  }, [])

  // track-player 事件订阅（播放状态 + 进度），替代轮询
  useEffect(() => {
    const subState = TrackPlayer.addEventListener(Event.PlaybackState, (e: PlaybackStateEvent) => {
      setPlaying(e.state === State.Playing)
    })
    const subProgress = TrackPlayer.addEventListener(
      Event.PlaybackProgressUpdated,
      (e: PlaybackProgressUpdatedEvent) => {
        setProgress({ position: e.position, duration: e.duration })
      }
    )
    return () => {
      subState.remove()
      subProgress.remove()
    }
  }, [])

  const doSearch = useCallback(
    async (kw: string) => {
      const text = kw.trim()
      if (!text) return
      setLoading(true)
      setError('')
      try {
        // 六源统一走原生 SecureKwApi 桥（网关 resolve/search 能力，与桌面端协议一致）
        if (!activeSource) throw new Error('请先在「音源」页导入音源脚本')
        const found = await searchMusic(activeSource, text, 1, 30)
        setTracks(found)
        setSourceResults((prev) => ({ ...prev, [`${activeSource}:${text}`]: found }))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setTracks([])
      } finally {
        setLoading(false)
      }
    },
    [activeSource]
  )

  const playTrack = useCallback(async (track: Track, list?: Track[]) => {
    setCurrent(track)
    setPlaying(false)
    setError('')
    try {
      await startPlayback(track)
      if (list) setTracks(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const playOffset = useCallback(
    async (offset: number) => {
      if (!current) return
      const list = tracks.length > 0 ? tracks : [current]
      const idx = list.findIndex((t) => t.rid === current.rid && t.source === current.source)
      const next = list[(idx + offset + list.length) % list.length]
      if (next) await playTrack(next)
    },
    [current, tracks, playTrack]
  )

  const switchSource = useCallback(async (fileName: string) => {
    const loaded = await loadPlugin(fileName).catch(() => null)
    setActiveSource(loaded ?? fileName)
  }, [])

  const doImportSource = useCallback(async () => {
    const url = sourceUrl.trim()
    if (!url) return
    setImporting(true)
    setError('')
    try {
      const fileName = await importSourceUrl(url)
      setSourceUrl('')
      const list = await listSources().catch(() => [])
      setAvailableSources(list)
      await loadPlugin(fileName)
      setActiveSource(fileName)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
    }
  }, [sourceUrl])

  const doDeleteSource = useCallback(async (fileName: string) => {
    await deleteSource(fileName).catch(() => null)
    const list = await listSources().catch(() => [])
    setAvailableSources(list)
    if (activeSource === fileName) {
      setActiveSource(list[0]?.fileName ?? '')
      if (list[0]) await loadPlugin(list[0].fileName)
    }
  }, [activeSource])

  const toggleNow = useCallback(async () => {
    try {
      await togglePlayback()
    } catch {
      /* 未初始化忽略 */
    }
  }, [])

  const onSeek = useCallback(async (ratio: number) => {
    try {
      await setupPlayer()
      const { duration } = await getProgress()
      if (duration > 0) await seekTo(Math.min(duration - 1, Math.max(0, duration * ratio)))
    } catch {
      /* 忽略 */
    }
  }, [])

  const renderTrack = useCallback(
    ({ item, index }: { item: Track; index: number }) => (
      <Pressable
        style={styles.trackRow}
        android_ripple={{ color: 'rgba(41,197,134,0.08)' }}
        onPress={() => void playTrack(item, tracks)}
      >
        <Text style={styles.trackIndex}>{index + 1}</Text>
        <View style={styles.trackMeta}>
          <Text numberOfLines={1} style={styles.trackName}>
            {item.name}
          </Text>
          <Text numberOfLines={1} style={styles.trackArtist}>
            {item.artist}
            {item.album ? ` · ${item.album}` : ''}
          </Text>
        </View>
        <Text style={styles.trackDuration}>
          {item.duration ? fmt(Number(item.duration)) : '--:--'}
        </Text>
      </Pressable>
    ),
    [playTrack, tracks]
  )

  // ---------------------------------------------------------------------------
  // 音源管理页
  // ---------------------------------------------------------------------------
  if (showSources) {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="dark-content" backgroundColor="#f6f7f9" />
        <View style={styles.sourcesTop}>
          <Pressable onPress={() => setShowSources(false)} hitSlop={10}>
            <Text style={styles.playerClose}>‹</Text>
          </Pressable>
          <Text style={styles.sourcesTitle}>音源管理</Text>
          <View style={{ width: 28 }} />
        </View>
        <View style={styles.importRow}>
          <TextInput
            style={styles.searchInput}
            placeholder="粘贴音源脚本 URL（.js）"
            placeholderTextColor="#9ca3af"
            value={sourceUrl}
            onChangeText={setSourceUrl}
            autoCapitalize="none"
          />
          <Pressable
            style={[styles.searchBtn, importing && styles.importBtnDisabled]}
            disabled={importing}
            onPress={() => void doImportSource()}
          >
            <Text style={styles.searchBtnText}>{importing ? '导入中' : '导入'}</Text>
          </Pressable>
        </View>
        <FlatList
          data={availableSources}
          keyExtractor={(s) => s.fileName}
          renderItem={({ item }) => (
            <View style={styles.sourceRow}>
              <Pressable
                style={styles.sourceMeta}
                onPress={() => void switchSource(item.fileName)}
              >
                <Text
                  numberOfLines={1}
                  style={[styles.sourceNameText, item.fileName === activeSource && styles.sourceNameOn]}
                >
                  {item.name}
                  {item.fileName === activeSource ? '（使用中）' : ''}
                </Text>
                <Text numberOfLines={1} style={styles.sourceFileText}>
                  {item.fileName}
                </Text>
              </Pressable>
              <Pressable
                style={styles.sourceDelete}
                onPress={() => void doDeleteSource(item.fileName)}
              >
                <Text style={styles.sourceDeleteText}>删除</Text>
              </Pressable>
            </View>
          )}
        />
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        <Text style={styles.sourcesHint}>
          本体不内置音源。可导入 MusicFree 插件（.js）或 LX 音源脚本，音源由用户自行提供。
        </Text>
      </SafeAreaView>
    )
  }

  // ---------------------------------------------------------------------------
  // 全屏播放页
  // ---------------------------------------------------------------------------
  if (showPlayer && current) {
    const dur = progress.duration > 0 ? progress.duration : Number(current.duration) || 0
    const ratio = dur > 0 ? Math.min(1, progress.position / dur) : 0
    return (
      <SafeAreaView style={styles.playerPage}>
        <StatusBar barStyle="dark-content" backgroundColor="#f6f7f9" />
        <View style={styles.playerTop}>
          <Pressable onPress={() => setShowPlayer(false)} hitSlop={12}>
            <Text style={styles.playerClose}>⌄</Text>
          </Pressable>
          <Text style={styles.playerTopTitle}>正在播放</Text>
          <View style={{ width: 28 }} />
        </View>
        <View style={styles.playerCoverWrap}>
          {current.pic ? (
            <Image source={{ uri: current.pic }} style={styles.playerCover} resizeMode="cover" />
          ) : (
            <View style={[styles.playerCover, styles.playerCoverEmpty]}>
              <Text style={{ fontSize: 56 }}>🎵</Text>
            </View>
          )}
        </View>
        <View style={styles.playerMeta}>
          <Text numberOfLines={1} style={styles.playerName}>
            {current.name}
          </Text>
          <Text numberOfLines={1} style={styles.playerArtist}>
            {current.artist}
            {current.album ? ` · ${current.album}` : ''}
          </Text>
        </View>
        <Pressable
          style={styles.playerProgressWrap}
          onPress={(e) => {
            const w = e.nativeEvent.layout?.width || 1
            void onSeek(e.nativeEvent.locationX / w)
          }}
        >
          <View style={styles.playerProgressBg}>
            <View style={[styles.playerProgressFill, { flex: ratio }]} />
            <View style={[styles.playerProgressRest, { flex: 1 - ratio }]} />
          </View>
        </Pressable>
        <View style={styles.playerTimeRow}>
          <Text style={styles.playerTime}>{fmt(progress.position)}</Text>
          <Text style={styles.playerTime}>{fmt(dur)}</Text>
        </View>
        <View style={styles.playerControls}>
          <Pressable onPress={() => void playOffset(-1)} hitSlop={16}>
            <Text style={styles.ctrlSide}>⏮</Text>
          </Pressable>
          <Pressable style={styles.ctrlMain} onPress={() => void toggleNow()}>
            <Text style={styles.ctrlMainText}>{playing ? '⏸' : '▶'}</Text>
          </Pressable>
          <Pressable onPress={() => void playOffset(1)} hitSlop={16}>
            <Text style={styles.ctrlSide}>⏭</Text>
          </Pressable>
        </View>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" backgroundColor="#f6f7f9" />
      <View style={styles.topbar}>
        <Text style={styles.logo}>甘露音乐</Text>
      </View>
      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          placeholder="搜索想听的音乐"
          placeholderTextColor="#9ca3af"
          value={keyword}
          onChangeText={setKeyword}
          onSubmitEditing={() => void doSearch(keyword)}
          returnKeyType="search"
        />
        <Pressable style={styles.searchBtn} onPress={() => void doSearch(keyword)}>
          <Text style={styles.searchBtnText}>搜索</Text>
        </Pressable>
      </View>
      <View style={styles.sourceTabs}>
        {availableSources.map((s) => (
          <Pressable
            key={s.fileName}
            style={[styles.tab, s.fileName === activeSource && styles.tabOn]}
            onPress={() => void switchSource(s.fileName)}
          >
            <Text
              numberOfLines={1}
              style={[styles.tabText, s.fileName === activeSource && styles.tabTextOn]}
            >
              {s.name}
            </Text>
          </Pressable>
        ))}
        <Pressable style={[styles.tab, styles.tabAdd]} onPress={() => setShowSources(true)}>
          <Text style={styles.tabTextOn}>＋音源</Text>
        </Pressable>
      </View>
      {availableSources.length === 0 ? (
        <Text style={styles.emptySourceTip}>尚未导入音源脚本，点「＋音源」导入后即可搜索播放</Text>
      ) : null}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      {loading ? (
        <ActivityIndicator style={styles.loading} color="#29c586" size="large" />
      ) : (
        <FlatList
          data={tracks}
          keyExtractor={(t) => `${t.source}:${t.rid}`}
          renderItem={renderTrack}
          style={styles.list}
        />
      )}
      {current ? (
        <Pressable style={styles.playerBar} onPress={() => setShowPlayer(true)}>
          {current.pic ? (
            <Image source={{ uri: current.pic }} style={styles.barCover} resizeMode="cover" />
          ) : (
            <View style={[styles.barCover, styles.barCoverEmpty]}>
              <Text style={{ fontSize: 16 }}>🎵</Text>
            </View>
          )}
          <View style={styles.barMeta}>
            <Text numberOfLines={1} style={styles.barName}>
              {current.name}
            </Text>
            <Text numberOfLines={1} style={styles.barArtist}>
              {current.artist}
            </Text>
          </View>
          <Pressable style={styles.barCtrl} onPress={() => void toggleNow()} hitSlop={10}>
            <Text style={styles.barCtrlText}>{playing ? '⏸' : '▶'}</Text>
          </Pressable>
          <Text style={styles.barState}>{playing ? '播放中' : '已暂停'}</Text>
        </Pressable>
      ) : null}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f6f7f9' },
  topbar: { paddingHorizontal: 16, paddingTop: 8 },
  logo: { fontSize: 20, fontWeight: '800', color: '#1f2329' },
  searchRow: { flexDirection: 'row', paddingHorizontal: 16, paddingTop: 10, gap: 8 },
  searchInput: {
    flex: 1,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.055)',
    paddingHorizontal: 16,
    fontSize: 14,
    color: '#1f2329'
  },
  searchBtn: {
    height: 40,
    paddingHorizontal: 18,
    borderRadius: 20,
    backgroundColor: '#29c586',
    justifyContent: 'center'
  },
  searchBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  sourceTabs: { flexDirection: 'row', paddingHorizontal: 16, paddingTop: 10, gap: 6 },
  tab: {
    paddingHorizontal: 14,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ececf0',
    justifyContent: 'center'
  },
  tabOn: { backgroundColor: '#e0f7ec', borderColor: 'transparent' },
  tabText: { fontSize: 13, color: '#6b7280' },
  tabTextOn: { color: '#17a06b', fontWeight: '600' },
  list: { flex: 1, marginTop: 6 },
  trackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 10
  },
  trackIndex: { width: 30, textAlign: 'center', color: '#9ca3af', fontSize: 13 },
  trackMeta: { flex: 1 },
  trackName: { fontSize: 14, fontWeight: '500', color: '#1f2329' },
  trackArtist: { fontSize: 12, color: '#9ca3af', marginTop: 3 },
  trackDuration: { color: '#9ca3af', fontSize: 12 },
  errorText: { color: '#e5484d', paddingHorizontal: 16, paddingTop: 8, fontSize: 13 },
  loading: { flex: 1 },
  // mini 播放栏
  playerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#4a2a33',
    paddingVertical: 10,
    paddingHorizontal: 14,
    gap: 10
  },
  barCover: { width: 40, height: 40, borderRadius: 6, backgroundColor: '#5d3843' },
  barCoverEmpty: { alignItems: 'center', justifyContent: 'center' },
  barMeta: { flex: 1 },
  barName: { color: '#f3eef0', fontSize: 13, fontWeight: '600' },
  barArtist: { color: '#bdeedd', fontSize: 11, marginTop: 2 },
  barCtrl: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  barCtrlText: { color: '#fff', fontSize: 15 },
  barState: { color: '#bdeedd', fontSize: 11, width: 44, textAlign: 'right' },
  // 全屏播放页
  playerPage: { flex: 1, backgroundColor: '#f6f7f9' },
  playerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8
  },
  playerClose: { fontSize: 22, color: '#1f2329', lineHeight: 26 },
  playerTopTitle: { fontSize: 13, color: '#6b7280' },
  playerCoverWrap: { alignItems: 'center', marginTop: 24 },
  playerCover: {
    width: 280,
    height: 280,
    borderRadius: 16,
    backgroundColor: '#e5e7eb'
  },
  playerCoverEmpty: { alignItems: 'center', justifyContent: 'center' },
  playerMeta: { alignItems: 'center', marginTop: 26, paddingHorizontal: 24 },
  playerName: { fontSize: 20, fontWeight: '700', color: '#1f2329' },
  playerArtist: { fontSize: 13, color: '#9ca3af', marginTop: 6 },
  playerProgressWrap: { paddingHorizontal: 32, marginTop: 26 },
  playerProgressBg: {
    flexDirection: 'row',
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: '#e5e7eb'
  },
  playerProgressFill: { backgroundColor: '#29c586' },
  playerProgressRest: { backgroundColor: 'transparent' },
  playerTimeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 32,
    marginTop: 6
  },
  playerTime: { fontSize: 11, color: '#9ca3af' },
  playerControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 40,
    marginTop: 26
  },
  ctrlSide: { fontSize: 30, color: '#374151' },
  ctrlMain: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#29c586',
    alignItems: 'center',
    justifyContent: 'center'
  },
  ctrlMainText: { fontSize: 30, color: '#fff' },
  tabAdd: { backgroundColor: '#fff', borderStyle: 'dashed' },
  emptySourceTip: {
    paddingHorizontal: 16,
    paddingTop: 8,
    fontSize: 12,
    color: '#e08a3a'
  },
  sourcesTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8
  },
  sourcesTitle: { fontSize: 17, fontWeight: '700', color: '#1f2329' },
  importRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingTop: 14,
    gap: 8
  },
  importBtnDisabled: { opacity: 0.6 },
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.05)'
  },
  sourceMeta: { flex: 1 },
  sourceNameText: { fontSize: 14, fontWeight: '500', color: '#374151' },
  sourceNameOn: { color: '#17a06b', fontWeight: '600' },
  sourceFileText: { fontSize: 11, color: '#9ca3af', marginTop: 3 },
  sourceDelete: {
    paddingHorizontal: 12,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: 'rgba(229,72,77,0.35)',
    justifyContent: 'center'
  },
  sourceDeleteText: { color: '#e5484d', fontSize: 12 },
  sourcesHint: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 12,
    color: '#9ca3af',
    lineHeight: 18
  }
})

export default App
