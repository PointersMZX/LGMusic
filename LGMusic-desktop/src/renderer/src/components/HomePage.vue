<template>
  <div class="home-page">
    <div class="banner-row">
      <div class="banner-card">
        <div class="banner-inner" :style="{ background: banners[bannerIndex].bg }">
          <div class="banner-slogan">
            <div class="slogan-big">{{ banners[bannerIndex].title }}</div>
            <div class="slogan-sub">{{ banners[bannerIndex].sub }}</div>
          </div>
        </div>
        <div class="banner-dots">
          <i
            v-for="(b, i) in banners"
            :key="i"
            :class="{ on: i === bannerIndex }"
            @click="bannerIndex = i"
          ></i>
        </div>
      </div>
      <div class="banner-side">
        <div
          class="side-card"
          v-for="card in sideCards"
          :key="card.title"
          :style="{ background: card.bg }"
          @click="$emit('navigate', card.nav)"
        >
          <div class="side-title">{{ card.title }}</div>
          <div class="side-sub">{{ card.sub }}</div>
        </div>
      </div>
    </div>

    <div class="section-head">
      <h2 class="section-title">新歌速递</h2>
      <button class="refresh-icon" type="button" :disabled="loading" aria-label="刷新" @click="loadNewSongs">↻</button>
    </div>
    <div class="song-grid">
      <div v-for="(song, i) in newSongs" :key="i" class="song-card" @click="playSong(song)">
        <div class="song-cover">
          <img v-if="song.pic" :src="song.pic" referrerpolicy="no-referrer" />
          <span v-else class="cover-fallback">♪</span>
        </div>
        <div class="song-meta">
          <div class="song-name" :title="song.name">{{ song.name }}</div>
          <div class="song-artist" :title="song.artist">{{ song.artist }}</div>
        </div>
      </div>
    </div>
    <div v-if="loading" class="loading-tip">加载中…</div>
    <div v-else-if="loadError" class="loading-tip">{{ loadError }}</div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { api } from '../api'
import { playTracks } from '../stores/player'
import type { UnifiedTrack } from '../stores/player'

const emit = defineEmits<{ (e: 'navigate', key: string): void }>()

const loading = ref(false)
const loadError = ref('')
const newSongs = ref<UnifiedTrack[]>([])
const bannerIndex = ref(0)
let bannerTimer: ReturnType<typeof setInterval> | null = null

// 首页 banner（结构对齐青听 banner.json 的 banners 协议，内容为甘露元素，后续可换远端同结构 JSON）
const banners = [
  { title: '甘露音乐', sub: '用心倾听', bg: 'linear-gradient(120deg,#2abf8a,#178a62)' },
  { title: '发现好音乐', sub: '六源聚合 一起聆听', bg: 'linear-gradient(120deg,#3a7bd5,#2a5fa8)' },
  { title: '高品质曲库', sub: '无损 FLAC 随心听', bg: 'linear-gradient(120deg,#e08a3a,#c96a1a)' }
]

const sideCards = [
  { title: '歌单广场', sub: '发现好歌单', bg: 'linear-gradient(135deg,#e0f7ec,#c6efdd)', nav: 'playlist' },
  { title: '排行榜', sub: '热歌实时更新', bg: 'linear-gradient(135deg,#e8f1ff,#d3e4ff)', nav: 'toplist' },
  { title: 'MV', sub: '流行音乐视频', bg: 'linear-gradient(135deg,#fff3e0,#ffe4bd)', nav: 'mv' }
]

onMounted(() => {
  bannerTimer = setInterval(() => {
    bannerIndex.value = (bannerIndex.value + 1) % banners.length
  }, 5000)
  void loadNewSongs()
})
onUnmounted(() => {
  if (bannerTimer) clearInterval(bannerTimer)
})

async function loadNewSongs(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    // 青听同款：新歌速递 = 网易新歌榜（歌单 id 3779629）
    const res = await api.invoke('get-wy-playlist', { id: '3779629', limit: 30 })
    const list = (res?.data?.musicList as Array<Record<string, unknown>>) || []
    newSongs.value = list.slice(0, 12).map((s) => ({
      rid: String(s.rid ?? s.id ?? ''),
      name: String(s.name ?? ''),
      artist: String(s.artist ?? ''),
      pic: (s.pic as string | undefined) || (s.cover as string | undefined),
      duration: Number(s.duration) || undefined,
      source: 'wy'
    }))
    if (newSongs.value.length === 0) loadError.value = '新歌速递暂不可用，请点击刷新重试'
  } catch {
    loadError.value = '新歌速递加载失败，请点击刷新重试'
  } finally {
    loading.value = false
  }
}

function playSong(song: UnifiedTrack): void {
  const idx = newSongs.value.findIndex((t) => t.rid === song.rid)
  playTracks(newSongs.value, idx >= 0 ? idx : 0)
}
</script>

<style scoped>
.home-page {
  padding-top: 8px;
}
.banner-row {
  display: grid;
  grid-template-columns: 1fr 220px;
  gap: 14px;
}
.banner-card {
  position: relative;
  height: 240px;
  border-radius: 18px;
  overflow: hidden;
  box-shadow: var(--shadow-card);
}
.banner-inner {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  padding: 0 56px;
  transition: background 0.5s ease;
}
.slogan-big {
  font-size: 40px;
  font-weight: 800;
  color: #fff;
  letter-spacing: 2px;
}
.slogan-sub {
  font-size: 18px;
  color: rgba(255, 255, 255, 0.88);
  margin-top: 8px;
  letter-spacing: 4px;
}
.banner-dots {
  position: absolute;
  bottom: 14px;
  left: 56px;
  display: flex;
  gap: 6px;
}
.banner-dots i {
  width: 6px;
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.4);
  cursor: pointer;
  transition: width 0.2s;
}
.banner-dots i.on {
  width: 18px;
  background: #fff;
}
.banner-side {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.side-card {
  flex: 1;
  border-radius: 14px;
  padding: 14px 16px;
  cursor: pointer;
  box-shadow: var(--shadow-card);
}
.side-card:hover {
  filter: brightness(0.97);
}
.side-title {
  font-size: 15px;
  font-weight: 700;
  color: #1f3830;
}
.side-sub {
  font-size: 12px;
  color: rgba(31, 56, 48, 0.6);
  margin-top: 4px;
}
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 26px 0 14px;
}
.section-title {
  font-size: 19px;
  font-weight: 800;
}
.refresh-icon {
  border: none;
  background: transparent;
  font-size: 17px;
  color: #29c586;
  cursor: pointer;
}
.refresh-icon:disabled {
  opacity: 0.5;
  cursor: default;
}
.song-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 18px 22px;
}
.song-card {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  border-radius: 12px;
  padding: 6px;
}
.song-card:hover {
  background: var(--surface-hover);
}
.song-cover {
  width: 64px;
  height: 64px;
  border-radius: 10px;
  overflow: hidden;
  background: var(--surface-hover);
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
  color: var(--text-tertiary);
  font-size: 22px;
}
.song-meta {
  min-width: 0;
}
.song-name {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.song-artist {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.loading-tip {
  color: var(--text-tertiary);
  padding: 24px 0;
  text-align: center;
}
</style>
