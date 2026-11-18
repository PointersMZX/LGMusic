<template>
  <div class="search-page">
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
import { ref, watch } from 'vue'
import { searchSource, type UnifiedTrack } from '../api'
import { playerState, playTracks } from '../stores/player'

const props = defineProps<{ initialKeyword?: string }>()

const sources = [
  { key: 'wy', label: '网易' },
  { key: 'kw', label: '酷我' },
  { key: 'qq', label: 'QQ' },
  { key: 'kg', label: '酷狗' },
  { key: 'mg', label: '咪咕' },
  { key: 'bili', label: 'B站' }
]

const activeSource = ref('wy')
const tracks = ref<UnifiedTrack[]>([])
const loading = ref(false)
const error = ref('')
const searched = ref(false)
const lastKeyword = ref('')

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

async function doSearch(keyword: string): Promise<void> {
  const kw = keyword.trim()
  if (!kw) return
  loading.value = true
  error.value = ''
  lastKeyword.value = kw
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
  if (lastKeyword.value) void doSearch(lastKeyword.value)
}

function play(track: UnifiedTrack): void {
  playTracks(tracks.value, tracks.value.indexOf(track))
}

watch(
  () => props.initialKeyword,
  (kw) => {
    if (kw) void doSearch(kw)
  },
  { immediate: true }
)
</script>

<style scoped>
.search-page {
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.source-tabs {
  display: flex;
  gap: 8px;
}
.tab {
  padding: 6px 18px;
  border-radius: 16px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  background: var(--surface);
  border: 1px solid var(--border);
}
.tab.active {
  background: var(--accent-soft);
  color: var(--accent-text);
  border-color: transparent;
  font-weight: 600;
}
.search-error {
  color: #e5484d;
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
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  cursor: default;
}
.track-row:hover {
  background: var(--surface-hover);
}
.track-row.playing {
  background: var(--accent-soft);
  color: var(--accent-text);
}
.track-index {
  color: var(--text-tertiary);
  text-align: center;
}
.track-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.track-artist,
.track-album {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.track-duration {
  color: var(--text-tertiary);
}
.track-play {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: none;
  background: var(--accent-soft);
  color: var(--accent-text);
  cursor: pointer;
  display: none;
}
.track-row:hover .track-play {
  display: block;
}
.empty-tip {
  text-align: center;
  color: var(--text-tertiary);
  padding: 40px 0;
}
</style>
