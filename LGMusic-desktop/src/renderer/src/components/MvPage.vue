<template>
  <div class="mv-page">
    <div class="page-head">
      <h1 class="page-title">MV <span class="page-sub">音乐视频</span></h1>
      <div class="head-search">
        <input v-model="keyword" class="head-search-input" placeholder="搜索 MV" @keyup.enter="load" />
      </div>
    </div>
    <div class="section-label">
      <strong>热门 MV</strong>
      <span class="section-sub">网易云音乐视频</span>
    </div>
    <div v-if="error" class="error-tip">{{ error }}</div>
    <div class="mv-grid">
      <div v-for="(mv, i) in mvs" :key="i" class="mv-card" @click="playMv(mv)">
        <div class="mv-cover">
          <img v-if="mv.pic" :src="mv.pic" referrerpolicy="no-referrer" />
          <span v-else class="cover-fallback">🎬</span>
          <span class="hot-badge">HOT</span>
          <span class="mv-count">▶ {{ formatCount(mv.playCount) }}</span>
          <span class="mv-duration">{{ formatDuration(mv.duration) }}</span>
        </div>
        <div class="mv-name" :title="mv.name">{{ mv.name }}</div>
        <div class="mv-artist">{{ mv.artist }}</div>
      </div>
    </div>
    <div v-if="loading" class="loading-tip">加载中…</div>

    <!-- MV 播放弹层 -->
    <div v-if="playing" class="mv-player" @click.self="closePlayer">
      <div class="player-box">
        <div class="player-head">
          <span class="player-title">{{ playing.name }}</span>
          <button class="player-close" @click="closePlayer">×</button>
        </div>
        <video
          ref="videoEl"
          class="player-video"
          :src="playing.url"
          controls
          autoplay
          playsinline
        ></video>
        <div class="player-meta">{{ playing.artist }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { api } from '../api'

interface MvItem {
  id: number
  name: string
  artist: string
  pic: string
  playCount: number
  duration: number
}

const keyword = ref('')
const mvs = ref<MvItem[]>([])
const loading = ref(false)
const error = ref('')
const playing = ref<(MvItem & { url: string }) | null>(null)
const videoEl = ref<HTMLVideoElement | null>(null)

function formatCount(count: number): string {
  if (!count) return ''
  return count >= 100000000
    ? `${Math.floor(count / 100000000)}亿`
    : count >= 10000
      ? `${Math.floor(count / 10000)}万`
      : String(count)
}

function formatDuration(sec: number): string {
  if (!sec) return ''
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = (await api.invoke('mv-list', { page: 1, limit: 24 }).catch(() => null)) as {
      code?: number
      msg?: string
      mvs?: MvItem[]
    } | null
    if (res?.code === 200 && res.mvs) {
      mvs.value = res.mvs
    } else {
      error.value = res?.msg || 'MV 列表加载失败'
      mvs.value = []
    }
  } finally {
    loading.value = false
  }
}

async function playMv(mv: MvItem): Promise<void> {
  try {
    const url = (await api.invoke('mv-url', { id: mv.id }).catch(() => '')) as string
    if (!url) {
      error.value = 'MV 播放地址获取失败'
      return
    }
    playing.value = { ...mv, url }
    await nextTick()
    videoEl.value?.play().catch(() => {})
  } catch {
    error.value = 'MV 播放失败'
  }
}

function closePlayer(): void {
  videoEl.value?.pause()
  playing.value = null
}

onMounted(load)
</script>

<style scoped>
.mv-page {
  padding-top: 8px;
}
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.page-title {
  font-size: 24px;
  font-weight: 800;
}
.page-sub {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-tertiary);
  margin-left: 8px;
}
.head-search-input {
  height: 36px;
  width: 220px;
  border-radius: 18px;
  border: none;
  background: rgba(0, 0, 0, 0.055);
  padding: 0 16px;
  font-size: 13px;
  outline: none;
}
.section-label {
  margin-bottom: 14px;
}
.section-label strong {
  font-size: 16px;
}
.section-sub {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-left: 10px;
}
.mv-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px 18px;
}
.mv-card {
  cursor: pointer;
}
.mv-cover {
  position: relative;
  aspect-ratio: 16 / 9;
  border-radius: 12px;
  overflow: hidden;
  background: var(--surface-hover);
  box-shadow: var(--shadow-card);
}
.mv-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cover-fallback {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  font-size: 30px;
}
.hot-badge {
  position: absolute;
  left: 8px;
  top: 8px;
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  background: var(--accent);
  border-radius: 6px;
  padding: 2px 8px;
}
.mv-count {
  position: absolute;
  left: 10px;
  bottom: 8px;
  font-size: 11px;
  color: #fff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
}
.mv-duration {
  position: absolute;
  right: 10px;
  bottom: 8px;
  font-size: 11px;
  color: #fff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
}
.mv-name {
  margin-top: 8px;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mv-artist {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 3px;
}
.error-tip {
  color: #e5484d;
  padding: 12px 0;
}
.loading-tip {
  color: var(--text-tertiary);
  padding: 24px 0;
  text-align: center;
}
.mv-player {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.7);
}
.player-box {
  width: min(720px, 86vw);
  background: #101113;
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}
.player-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
}
.player-title {
  font-size: 15px;
  font-weight: 600;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.player-close {
  border: none;
  background: transparent;
  color: #fff;
  font-size: 22px;
  cursor: pointer;
  padding: 0 4px;
}
.player-video {
  width: 100%;
  max-height: 60vh;
  background: #000;
}
.player-meta {
  padding: 10px 16px 14px;
  color: #aaa;
  font-size: 13px;
}
</style>
