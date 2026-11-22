<template>
  <div class="toplist-page">
    <div class="toplist-tabs">
      <button
        v-for="tab in boards"
        :key="tab.id"
        class="toplist-tab"
        :class="{ on: currentBoard === tab.id }"
        type="button"
        @click="switchBoard(tab.id)"
      >
        {{ tab.name }}
      </button>
    </div>
    <div class="board-title-row">
      <h2 class="board-title">{{ currentBoardName }}</h2>
      <button class="play-all" type="button" @click="playAll">▶ 播放全部</button>
    </div>
    <div v-if="loading" class="loading-tip">加载中…</div>
    <div v-else-if="error" class="loading-tip">{{ error }}</div>
    <div v-else class="song-list">
      <div
        v-for="(song, i) in songs"
        :key="`${song.rid}:${i}`"
        class="song-row"
        @dblclick="playSong(song)"
      >
        <div class="song-index" :class="{ hot: i < 3 }">{{ i + 1 }}</div>
        <div class="song-cover">
          <img v-if="song.pic" :src="song.pic" referrerpolicy="no-referrer" />
          <span v-else class="cover-fallback">♪</span>
        </div>
        <div class="song-meta">
          <div class="song-name" :title="song.name">{{ song.name }}</div>
          <div class="song-artist" :title="song.artist">{{ song.artist }}</div>
        </div>
        <div class="song-duration">{{ fmt(Number(song.duration) || 0) }}</div>
        <button class="song-play" type="button" aria-label="播放" @click="playSong(song)">▶</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '../api'
import { playTracks } from '../stores/player'
import type { UnifiedTrack } from '../api'

// 网易云官方榜（飙升/新歌/热歌/原创）
const boards = [
  { id: '19723756', name: '飙升榜' },
  { id: '3779629', name: '新歌榜' },
  { id: '3778678', name: '热歌榜' },
  { id: '2884035', name: '原创榜' }
]

const currentBoard = ref('19723756')
const loading = ref(false)
const error = ref('')
const songs = ref<UnifiedTrack[]>([])

const currentBoardName = computed(
  () => boards.find((b) => b.id === currentBoard.value)?.name ?? ''
)

onMounted(() => void loadBoard())

async function switchBoard(id: string): Promise<void> {
  if (currentBoard.value === id) return
  currentBoard.value = id
  await loadBoard()
}

async function loadBoard(): Promise<void> {
  loading.value = true
  error.value = ''
  songs.value = []
  try {
    const res = await api.invoke('get-wy-playlist', { id: currentBoard.value, limit: 50 })
    const list = (res?.data?.musicList as Array<Record<string, unknown>>) || []
    songs.value = list.slice(0, 50).map((s) => ({
      rid: String(s.rid ?? s.id ?? ''),
      name: String(s.name ?? ''),
      artist: String(s.artist ?? ''),
      album: (s.album as string | undefined) || undefined,
      pic: (s.pic as string | undefined) || undefined,
      duration: Number(s.duration) || undefined,
      source: 'wy'
    }))
    if (songs.value.length === 0) error.value = '榜单暂不可用，请稍后重试'
  } catch {
    error.value = '榜单加载失败，请稍后重试'
  } finally {
    loading.value = false
  }
}

function playSong(song: UnifiedTrack): void {
  const idx = songs.value.findIndex((t) => t.rid === song.rid)
  playTracks(songs.value, idx >= 0 ? idx : 0)
}

function playAll(): void {
  if (songs.value.length > 0) playTracks(songs.value, 0)
}

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
</script>

<style scoped>
.toplist-page {
  padding-top: 8px;
}
.toplist-tabs {
  display: flex;
  gap: 10px;
}
.toplist-tab {
  height: 34px;
  padding: 0 22px;
  border-radius: 17px;
  border: 1px solid var(--border-color, #ececf0);
  background: var(--surface, #fff);
  color: var(--text-secondary, #6b7280);
  font-size: 14px;
  cursor: pointer;
}
.toplist-tab.on {
  background: #e0f7ec;
  border-color: transparent;
  color: #17a06b;
  font-weight: 600;
}
.board-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 22px 0 12px;
}
.board-title {
  font-size: 19px;
  font-weight: 800;
}
.play-all {
  height: 34px;
  padding: 0 18px;
  border-radius: 17px;
  border: none;
  background: #29c586;
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}
.play-all:hover {
  filter: brightness(0.95);
}
.song-list {
  display: flex;
  flex-direction: column;
}
.song-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 10px;
  cursor: pointer;
}
.song-row:hover {
  background: var(--surface-hover, rgba(0, 0, 0, 0.03));
}
.song-index {
  width: 28px;
  text-align: center;
  color: var(--text-tertiary, #9ca3af);
  font-size: 13px;
  font-weight: 600;
}
.song-index.hot {
  color: #29c586;
}
.song-cover {
  width: 46px;
  height: 46px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--surface-hover, #e5e7eb);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.song-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cover-fallback {
  color: var(--text-tertiary, #9ca3af);
  font-size: 18px;
}
.song-meta {
  flex: 1;
  min-width: 0;
}
.song-name {
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.song-artist {
  font-size: 12px;
  color: var(--text-tertiary, #9ca3af);
  margin-top: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.song-duration {
  color: var(--text-tertiary, #9ca3af);
  font-size: 12px;
}
.song-play {
  width: 30px;
  height: 30px;
  border-radius: 15px;
  border: none;
  background: transparent;
  color: #29c586;
  cursor: pointer;
  font-size: 13px;
  opacity: 0;
}
.song-row:hover .song-play {
  opacity: 1;
}
.loading-tip {
  color: var(--text-tertiary, #9ca3af);
  padding: 28px 0;
  text-align: center;
}
</style>
