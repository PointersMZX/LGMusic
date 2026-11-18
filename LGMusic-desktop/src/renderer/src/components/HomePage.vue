<template>
  <div class="home-page">
    <div class="banner-row">
      <div class="banner-card">
        <div class="banner-inner">
          <div class="banner-slogan">
            <div class="slogan-big">甘露音乐</div>
            <div class="slogan-sub">用心倾听</div>
          </div>
        </div>
        <div class="banner-dots"><i class="on"></i><i></i><i></i></div>
      </div>
      <div class="banner-side">
        <div class="side-card" v-for="card in sideCards" :key="card.title" :style="{ background: card.bg }">
          <div class="side-title">{{ card.title }}</div>
          <div class="side-sub">{{ card.sub }}</div>
        </div>
      </div>
    </div>

    <div class="section-head">
      <h2 class="section-title">新歌速递</h2>
    </div>
    <div class="song-grid">
      <div v-for="(song, i) in newSongs" :key="i" class="song-card" @click="$emit('navigate', 'search')">
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
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../api'

const emit = defineEmits<{ (e: 'navigate', key: string): void }>()

const loading = ref(false)
const newSongs = ref<Array<{ name: string; artist: string; pic?: string }>>([])

const sideCards = [
  { title: '歌单广场', sub: '发现好歌单', bg: 'linear-gradient(135deg,#e0f7ec,#c6efdd)' },
  { title: '排行榜', sub: '热歌实时更新', bg: 'linear-gradient(135deg,#e8f1ff,#d3e4ff)' },
  { title: 'MV', sub: '流行音乐视频', bg: 'linear-gradient(135deg,#fff3e0,#ffe4bd)' }
]

onMounted(async () => {
  loading.value = true
  try {
    // 首页新歌速递：先用网易热歌榜填充（青听首页数据源为服务端配置，后续接入）
    const res = await api.invoke('search-wy', { name: '热门', page: 0, limit: 12 }).catch(() => null)
    const songs = res?.result?.songs || []
    newSongs.value = songs.slice(0, 12).map((s: Record<string, unknown>) => {
      const ar = (s.ar as Array<{ name?: string }>) || []
      return {
        name: String(s.name || ''),
        artist: ar.map((a) => a.name).join(' & '),
        pic: (s.al as Record<string, unknown> | undefined)?.picUrl as string | undefined
      }
    })
  } finally {
    loading.value = false
  }
})
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
  background: linear-gradient(120deg, #dff3ea 0%, #c9ecd9 55%, #bfe6d2 100%);
  box-shadow: var(--shadow-card);
}
.banner-inner {
  height: 100%;
  display: flex;
  align-items: center;
  padding: 0 56px;
}
.slogan-big {
  font-size: 40px;
  font-weight: 800;
  color: #145c40;
}
.slogan-sub {
  font-size: 18px;
  color: #2e7d5b;
  margin-top: 8px;
}
.banner-dots {
  position: absolute;
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 6px;
}
.banner-dots i {
  width: 6px;
  height: 6px;
  border-radius: 3px;
  background: rgba(20, 92, 64, 0.25);
}
.banner-dots i.on {
  width: 18px;
  background: #145c40;
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
  margin: 26px 0 14px;
}
.section-title {
  font-size: 19px;
  font-weight: 800;
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
}
.song-cover img {
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
