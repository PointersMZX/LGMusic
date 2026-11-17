<template>
  <div class="search-page">
    <div class="search-header">
      <input v-model="keyword" class="search-input" placeholder="搜索歌曲、歌手、专辑" @keyup.enter="doSearch" />
      <button class="search-btn" :disabled="loading" @click="doSearch">搜索</button>
    </div>
    <div class="source-tabs">
      <div v-for="src in sources" :key="src.key" class="tab" :class="{ active: src.key === activeSource }" @click="switchSource(src.key)">
        {{ src.label }}
      </div>
    </div>
    <div v-if="error" class="search-error">{{ error }}</div>
    <div class="track-list">
      <div v-for="(track, index) in tracks" :key="`${track.source}:${track.rid}`" class="track-row" :class="{ playing: isCurrent(track) }" @dblclick="play(track)">
        <div class="track-index">{{ index + 1 }}</div>
        <div class="track-name">
          {{ track.name }}
        </div>
        <div class="track-artist">{{ track.artist }}</div>
        <div class="track-album">{{ track.album || '' }}</div>
        <div class="track-duration">{{ formatDuration(track.duration) }}</div>
        <button class="track-play" title="播放" @click="play(track)">▶</button>
      </div>
      <div v-if="!loading && tracks.length === 0 && searched" class="empty-tip">没有找到相关歌曲</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { searchSource, type UnifiedTrack } from '../api'
import { playerState, playTracks } from '../stores/player'

const sources = [
  { key: 'wy', label: '网易' },
  { key: 'kw', label: '酷我' },
  { key: 'qq', label: 'QQ' },
  { key: 'kg', label: '酷狗' },
  { key: 'mg', label: '咪咕' },
  { key: 'bili', label: 'B站' }
]

const keyword = ref('')
const activeSource = ref('wy')
const tracks = ref<UnifiedTrack[]>([])
const loading = ref(false)
const error = ref('')
const searched = ref(false)

function formatDuration(value: number | string | undefined): string {
  const sec = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(sec) || sec <= 0) return '--:--'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function isCurrent(track: UnifiedTrack): boolean {
  return playerState.current?.rid === track.rid && playerState.current?.source === track.source
}

async function doSearch(): Promise<void> {
  const kw = keyword.value.trim()
  if (!kw) return
  loading.value = true
  error.value = ''
  try {
    const result = await searchSource(activeSource.value, kw, 0, 30)
    tracks.value = result.tracks
    searched.value = true
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    tracks.value = []
  } finally {
    loading.value = false
  }
}

function switchSource(key: string): void {
  activeSource.value = key
  if (keyword.value.trim()) void doSearch()
}

function play(track: UnifiedTrack): void {
  playTracks(tracks.value, tracks.value.indexOf(track))
}
</script>

<style scoped>
.search-page {
  padding: 16px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.search-header {
  display: flex;
  gap: 10px;
}
.search-input {
  flex: 1;
  max-width: 520px;
  height: 38px;
  border-radius: 19px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  padding: 0 16px;
  font-size: 14px;
  outline: none;
}
.search-input:focus {
  border-color: rgba(255, 255, 255, 0.28);
}
.search-btn {
  height: 38px;
  padding: 0 22px;
  border-radius: 19px;
  border: none;
  background: var(--accent, #4f8cff);
  color: #fff;
  font-size: 14px;
  cursor: pointer;
}
.search-btn:disabled {
  opacity: 0.6;
}
.source-tabs {
  display: flex;
  gap: 6px;
}
.tab {
  padding: 6px 16px;
  border-radius: 14px;
  font-size: 13px;
  color: #b9b9c6;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.04);
}
.tab.active {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}
.search-error {
  color: #ff7a7a;
  font-size: 13px;
}
.track-list {
  display: flex;
  flex-direction: column;
}
.track-row {
  display: grid;
  grid-template-columns: 40px 1fr 200px 200px 60px 40px;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 8px;
  font-size: 13px;
  cursor: default;
}
.track-row:hover {
  background: rgba(255, 255, 255, 0.05);
}
.track-row.playing {
  background: rgba(79, 140, 255, 0.12);
  color: #9dc0ff;
}
.track-index {
  color: #8888a0;
  text-align: center;
}
.track-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.track-artist,
.track-album {
  color: #9a9ab0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.track-duration {
  color: #8888a0;
}
.track-play {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: none;
  background: rgba(255, 255, 255, 0.1);
  color: #e8e8ee;
  cursor: pointer;
  display: none;
}
.track-row:hover .track-play {
  display: block;
}
.empty-tip {
  text-align: center;
  color: #8888a0;
  padding: 40px 0;
}
</style>
