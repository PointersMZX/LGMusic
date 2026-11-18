<template>
  <div class="fav-page">
    <div class="page-head">
      <h1 class="page-title">我的喜欢</h1>
      <span class="head-count">{{ tracks.length }} 首</span>
    </div>
    <div v-if="error" class="error-tip">{{ error }}</div>
    <div class="track-list">
      <div v-for="(track, index) in tracks" :key="`${track.source}:${track.rid}`" class="track-row" :class="{ playing: isCurrent(track) }" @dblclick="playFrom(index)">
        <div class="track-index">{{ index + 1 }}</div>
        <div class="track-name">{{ track.name }}</div>
        <div class="track-artist">{{ track.artist }}</div>
        <div class="track-album">{{ track.album || '' }}</div>
        <div class="track-duration">{{ formatDuration(track.duration) }}</div>
        <button class="track-play" title="播放" @click="playFrom(index)">▶</button>
      </div>
      <div v-if="!loading && tracks.length === 0" class="empty-tip">还没有收藏的歌曲，双击搜索结果中的歌曲可播放</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, type UnifiedTrack } from '../api'
import { playerState, playTracks } from '../stores/player'

const tracks = ref<UnifiedTrack[]>([])
const loading = ref(false)
const error = ref('')

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

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = await api.invoke('favorite-get-snapshot')
    if (res?.code && res.code !== 'OK') throw new Error(res?.message || '获取收藏失败')
    tracks.value = ((res?.favorites as Array<Record<string, unknown>>) || [])
      .map((f) => ({
        rid: String(f.rid ?? ''),
        name: String(f.name ?? ''),
        artist: String(f.artist ?? ''),
        album: f.album ? String(f.album) : undefined,
        pic: f.pic ? String(f.pic) : undefined,
        duration: f.duration as number | string | undefined,
        source: String(f.source ?? '')
      }))
      .filter((t) => t.rid)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

onMounted(load)

function playFrom(index: number): void {
  playTracks(tracks.value, index)
}
</script>

<style scoped>
.fav-page {
  padding-top: 8px;
}
.page-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 14px;
}
.page-title {
  font-size: 24px;
  font-weight: 800;
}
.head-count {
  font-size: 13px;
  color: var(--text-tertiary);
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
  padding: 60px 0;
}
.error-tip {
  color: #e5484d;
  padding: 12px 0;
}
</style>
