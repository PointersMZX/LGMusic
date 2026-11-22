<template>
  <div class="recent-page">
    <div class="page-head">
      <h1 class="page-title">最近播放</h1>
      <span class="page-sub">最近播放的歌曲</span>
    </div>
    <div v-if="loading" class="loading-tip">加载中…</div>
    <div v-else-if="items.length === 0" class="empty-tip">暂无播放记录，去搜索播放歌曲吧</div>
    <div v-else class="recent-list">
      <div v-for="(item, index) in items" :key="`${item.rid}-${item.ts}`" class="recent-item" @click="playTrack(item)">
        <div class="recent-index">{{ index + 1 }}</div>
        <div class="recent-info">
          <div class="recent-name">{{ item.name }}</div>
          <div class="recent-artist">{{ item.artist }}</div>
        </div>
        <div class="recent-time">{{ formatTime(item.ts) }}</div>
        <div class="recent-play">▶</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, type UnifiedTrack } from '../api'
import { playerState, playTracks } from '../stores/player'

const items = ref<Array<{ rid: string; name: string; artist: string; ts: number; source: string }>>([])
const loading = ref(false)

const recentItems = computed(() => {
  const list = [...playerState.playHistory].reverse()
  return list
    .map((h) => ({
      rid: h.rid,
      name: h.name,
      artist: h.artist,
      ts: h.ts,
      source: h.source
    }))
    .filter((i) => i.name || i.artist)
})

function formatTime(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function playTrack(item: { rid: string; name: string; artist: string; source: string }): Promise<void> {
  const track: UnifiedTrack = { rid: item.rid, name: item.name, artist: item.artist, source: item.source }
  playTracks([track], 0)
}

onMounted(() => {
  items.value = recentItems.value
})
</script>

<style scoped>
.recent-page {
  padding-top: 8px;
}
.page-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 16px;
}
.page-title {
  font-size: 24px;
  font-weight: 800;
}
.page-sub {
  font-size: 13px;
  color: var(--text-tertiary);
}
.loading-tip,
.empty-tip {
  color: var(--text-tertiary);
  padding: 48px 0;
  text-align: center;
  font-size: 14px;
}
.recent-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.recent-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  border-radius: 12px;
  cursor: pointer;
  background: var(--surface-hover, rgba(0, 0, 0, 0.03));
}
.recent-item:active {
  background: var(--surface-hover, rgba(0, 0, 0, 0.06));
}
.recent-index {
  width: 26px;
  text-align: center;
  font-size: 13px;
  color: var(--text-tertiary);
  font-weight: 600;
}
.recent-info {
  flex: 1;
  min-width: 0;
}
.recent-name {
  font-size: 15px;
  font-weight: 600;
  color: #1f2329;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.recent-artist {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 4px;
}
.recent-time {
  font-size: 12px;
  color: var(--text-tertiary);
}
.recent-play {
  color: var(--accent, #29c586);
  font-size: 14px;
  opacity: 0.7;
}
</style>
