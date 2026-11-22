<template>
  <div class="search-page">
    <div class="source-tabs">
      <div v-for="src in sources" :key="src.fileName" class="tab" :class="{ active: src.fileName === activeSource }" @click="switchSource(src.fileName)">
        {{ src.name }}
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
import { ref, watch, onMounted } from 'vue'
import { pluginList, pluginLoad, pluginLoaded, pluginSearch, type PluginSourceMeta, type UnifiedTrack } from '../api'
import { playerState, playTracks } from '../stores/player'

const props = defineProps<{ initialKeyword?: string }>()

// 音源 tab 动态来自用户导入的音源插件（本体不内置音源）
const sources = ref<PluginSourceMeta[]>([])
const activeSource = ref('')
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

async function loadSources(): Promise<void> {
  const list = await pluginList().catch(() => [])
  sources.value = list
  const loaded = await pluginLoaded().catch(() => null)
  if (loaded) {
    activeSource.value = loaded
  } else if (list.length > 0) {
    await pluginLoad(list[0].fileName).catch(() => null)
    activeSource.value = list[0].fileName
  }
}

async function doSearch(keyword: string): Promise<void> {
  const kw = keyword.trim()
  if (!kw) return
  if (!activeSource.value) {
    error.value = '尚未导入音源脚本，请先在设置页导入'
    tracks.value = []
    return
  }
  loading.value = true
  error.value = ''
  lastKeyword.value = kw
  try {
    const result = await pluginSearch(kw, 1)
    tracks.value = result.tracks
    searched.value = true
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    tracks.value = []
  } finally {
    loading.value = false
  }
}

function switchSource(fileName: string): void {
  if (fileName === activeSource.value) return
  void pluginLoad(fileName).then(() => {
    activeSource.value = fileName
    if (lastKeyword.value) void doSearch(lastKeyword.value)
  })
}

function play(track: UnifiedTrack): void {
  playTracks(tracks.value, tracks.value.indexOf(track))
}

onMounted(() => void loadSources())

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
