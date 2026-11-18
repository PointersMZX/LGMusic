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
      <span class="section-sub">发现正在流行的音乐视频</span>
    </div>
    <div v-if="error" class="error-tip">{{ error }}</div>
    <div class="mv-grid">
      <div v-for="(mv, i) in mvs" :key="i" class="mv-card">
        <div class="mv-cover">
          <img v-if="mv.pic" :src="mv.pic" referrerpolicy="no-referrer" />
          <span v-else class="cover-fallback">🎬</span>
          <span class="hot-badge">HOT</span>
          <span class="mv-count">▶ {{ formatCount(mv.count) }}</span>
          <span class="mv-duration">{{ mv.duration || '' }}</span>
        </div>
        <div class="mv-name" :title="mv.name">{{ mv.name }}</div>
        <div class="mv-artist">{{ mv.artist }}</div>
      </div>
    </div>
    <div v-if="loading" class="loading-tip">加载中…</div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../api'

const keyword = ref('')
const mvs = ref<Array<{ name: string; artist: string; pic?: string; count?: number; duration?: string; id?: string }>>([])
const loading = ref(false)
const error = ref('')

function formatCount(count?: number): string {
  if (!count) return ''
  return count >= 100000000 ? `${Math.floor(count / 100000000)}亿` : count >= 10000 ? `${Math.floor(count / 10000)}万` : String(count)
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    // MV 数据走网关 MV 代理端点（main 进程待补 mv-list IPC 时接入，此处先以搜索接口占位骨架）
    const res = await api.invoke('get-qq-playlist-square', { category: '10000000', page: 1, limit: 15 }).catch(() => null)
    if (res?.code === 200) {
      mvs.value = (res.data?.musicList || []).slice(0, 15).map((it: Record<string, unknown>) => ({
        name: String(it.name || ''),
        artist: String(it.uname || ''),
        pic: (it.pic as string) || undefined,
        count: Number(it.PlayCnt || 0) || undefined
      }))
    } else {
      mvs.value = []
    }
  } finally {
    loading.value = false
  }
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
</style>
