<template>
  <div class="plaza-page">
    <div class="page-head">
      <h1 class="page-title">歌单广场</h1>
    </div>
    <div class="category-row">
      <div v-for="c in categories" :key="c" class="cat-chip" :class="{ active: c === activeCat }" @click="activeCat = c">
        {{ c }}
      </div>
    </div>
    <div v-if="error" class="error-tip">{{ error }}</div>
    <div class="plaza-grid">
      <div v-for="(pl, i) in playlists" :key="i" class="plaza-card">
        <div class="plaza-cover">
          <img v-if="pl.pic" :src="pl.pic" referrerpolicy="no-referrer" />
          <span v-else class="cover-fallback">♫</span>
          <span class="play-count">▶ {{ formatCount(pl.count) }}</span>
        </div>
        <div class="plaza-name" :title="pl.name">{{ pl.name }}</div>
      </div>
    </div>
    <div v-if="loading" class="loading-tip">加载中…</div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../api'

const categories = ['推荐', '热歌', '网络', '流行', '经典', '摇滚', '民谣', '电子']
const activeCat = ref('推荐')
const playlists = ref<Array<{ name: string; pic?: string; count?: number; id?: string }>>([])
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
    const res = await api.invoke('get-qq-playlist-square', { category: '10000000', page: 1, limit: 21 })
    if (res?.code !== 200) throw new Error(res?.msg || '获取歌单广场失败')
    playlists.value = (res.data?.musicList || []).map((it: Record<string, unknown>) => ({
      name: String(it.name || ''),
      pic: (it.pic as string) || undefined,
      count: Number(it.PlayCnt || 0) || undefined,
      id: String(it.rid || '')
    }))
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    playlists.value = []
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.plaza-page {
  padding-top: 8px;
}
.page-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 16px;
}
.page-title {
  font-size: 24px;
  font-weight: 800;
}
.category-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 18px;
}
.cat-chip {
  padding: 6px 16px;
  border-radius: 15px;
  font-size: 13px;
  color: var(--text-secondary);
  background: var(--surface);
  cursor: pointer;
  border: 1px solid var(--border);
}
.cat-chip.active {
  background: var(--accent-soft);
  color: var(--accent-text);
  border-color: transparent;
  font-weight: 600;
}
.plaza-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 18px;
}
.plaza-card {
  cursor: pointer;
}
.plaza-cover {
  position: relative;
  aspect-ratio: 1;
  border-radius: 12px;
  overflow: hidden;
  background: var(--surface-hover);
  box-shadow: var(--shadow-card);
}
.plaza-cover img {
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
  font-size: 28px;
}
.play-count {
  position: absolute;
  right: 8px;
  top: 8px;
  font-size: 11px;
  color: #fff;
  background: rgba(0, 0, 0, 0.45);
  border-radius: 8px;
  padding: 2px 7px;
}
.plaza-name {
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
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
