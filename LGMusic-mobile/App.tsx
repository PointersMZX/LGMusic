/**
 * 甘露音乐 安卓端 —— 复刻青听 v1.4.1 架构
 * 结构：六源搜索 + 播放（SecureKwApi 原生桥 + react-native-track-player）
 */
import React, { useCallback, useEffect, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { SafeAreaView } from 'react-native'
import { playTrack as startPlayback, togglePlayback, searchMusic, type PlayableTrack } from './player'

const SOURCES = [
  { key: 'kg', label: '酷狗' },
  { key: 'wy', label: '网易' },
  { key: 'kw', label: '酷我' },
  { key: 'qq', label: 'QQ' },
  { key: 'mg', label: '咪咕' },
  { key: 'bili', label: 'B站' }
]

interface Track {
  rid: string
  name: string
  artist: string
  album?: string
  pic?: string
  duration?: number
  source: string
}

const App = (): React.JSX.Element => {
  const [source, setSource] = useState('kg')
  const [keyword, setKeyword] = useState('')
  const [tracks, setTracks] = useState<Track[]>([])
  const [loading, setLoading] = useState(false)
  const [current, setCurrent] = useState<Track | null>(null)
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState('')

  const doSearch = useCallback(
    async (kw: string) => {
      const text = kw.trim()
      if (!text) return
      setLoading(true)
      setError('')
      try {
        // 六源统一走原生 SecureKwApi 桥（网关 resolve/search 能力，与桌面端协议一致）
        const tracks = await searchMusic(source, text, 1, 30)
        setTracks(tracks)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setTracks([])
      } finally {
        setLoading(false)
      }
    },
    [source]
  )

  // 播放状态轮询（track-player 状态桥）
  useEffect(() => {
    if (!current) return
    const timer = setInterval(async () => {
      try {
        const { TrackPlayer } = require('react-native-track-player')
        const state = await TrackPlayer.getPlaybackState()
        setPlaying(state.state === 'playing')
      } catch {
        /* 初始化前忽略 */
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [current])

  const playTrack = useCallback(async (track: Track) => {
    setCurrent(track)
    setPlaying(false)
    setError('')
    try {
      // 经 SecureKwApi 原生桥走网关 resolve-url（与桌面端一致），track-player 播放
      await startPlayback(track as PlayableTrack)
      setPlaying(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const toggleNow = useCallback(async () => {
    try {
      await togglePlayback()
    } catch {
      /* 未初始化忽略 */
    }
  }, [])

  const renderTrack = useCallback(
    ({ item, index }: { item: Track; index: number }) => (
      <Pressable style={styles.trackRow} onPress={() => void playTrack(item)}>
        <Text style={styles.trackIndex}>{index + 1}</Text>
        <View style={styles.trackMeta}>
          <Text numberOfLines={1} style={styles.trackName}>
            {item.name}
          </Text>
          <Text numberOfLines={1} style={styles.trackArtist}>
            {item.artist}
          </Text>
        </View>
        <Text style={styles.trackDuration}>
          {item.duration
            ? `${Math.floor(Number(item.duration) / 60)}:${String(Number(item.duration) % 60).padStart(2, '0')}`
            : '--:--'}
        </Text>
      </Pressable>
    ),
    [playTrack]
  )

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
          {SOURCES.map((s) => (
            <Pressable
              key={s.key}
              style={[styles.tab, s.key === source && styles.tabOn]}
              onPress={() => setSource(s.key)}
            >
              <Text style={[styles.tabText, s.key === source && styles.tabTextOn]}>{s.label}</Text>
            </Pressable>
          ))}
        </View>
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
          <Pressable style={styles.playerBar} onPress={() => void toggleNow()}>
            <Text numberOfLines={1} style={styles.playerName}>
              {current.name}
            </Text>
            <Text style={styles.playerState}>{playing ? '⏸ 播放中' : '▶ 已暂停'}</Text>
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
  trackRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 10 },
  trackIndex: { width: 30, textAlign: 'center', color: '#9ca3af', fontSize: 13 },
  trackMeta: { flex: 1 },
  trackName: { fontSize: 14, fontWeight: '500', color: '#1f2329' },
  trackArtist: { fontSize: 12, color: '#9ca3af', marginTop: 3 },
  trackDuration: { color: '#9ca3af', fontSize: 12 },
  errorText: { color: '#e5484d', paddingHorizontal: 16, paddingTop: 8, fontSize: 13 },
  loading: { flex: 1 },
  playerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#4a2a33',
    paddingVertical: 12,
    paddingHorizontal: 16
  },
  playerName: { flex: 1, color: '#f3eef0', fontSize: 13, fontWeight: '600' },
  playerState: { color: '#bdeedd', fontSize: 12, marginLeft: 10 }
})

export default App
