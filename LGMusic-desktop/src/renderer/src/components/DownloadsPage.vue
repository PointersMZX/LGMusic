<template>
  <div class="dl-page">
    <div class="page-head">
      <h1 class="page-title">下载管理</h1>
      <button class="open-dir" @click="openDir">打开下载目录</button>
    </div>
    <div class="dl-list">
      <div v-for="(item, i) in items" :key="i" class="dl-row">
        <div class="dl-cover">
          <img v-if="item.cover" :src="item.cover" referrerpolicy="no-referrer" />
          <span v-else>♪</span>
        </div>
        <div class="dl-meta">
          <div class="dl-name">{{ item.name }}</div>
          <div class="dl-artist">{{ item.artist }}</div>
          <div v-if="item.progress !== undefined" class="dl-progress">
            <div class="dl-progress-fill" :style="{ width: item.progress + '%' }"></div>
          </div>
          <div v-if="item.error" class="dl-error">{{ item.error }}</div>
        </div>
        <div class="dl-state" :class="item.state">{{ stateLabel(item.state) }}</div>
      </div>
      <div v-if="items.length === 0" class="empty-tip">暂无下载任务，播放页或歌曲操作中可发起下载</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { api } from '../api'

interface DownloadItem {
  name: string
  artist: string
  cover?: string
  state: 'downloading' | 'completed' | 'error'
  progress?: number
  error?: string
}

const items = ref<DownloadItem[]>([])
let handlers: Array<[string, (...args: unknown[]) => void]> = []

function stateLabel(state: DownloadItem['state']): string {
  return state === 'downloading' ? '下载中' : state === 'completed' ? '已完成' : '失败'
}

function openDir(): void {
  void api.invoke('open-download-directory')
}

onMounted(() => {
  const started = (payload: Record<string, unknown>): void => {
    items.value.unshift({
      name: String(payload.name || '未知歌曲'),
      artist: String(payload.artist || ''),
      cover: payload.cover ? String(payload.cover) : undefined,
      state: 'downloading',
      progress: 0
    })
  }
  const progress = (payload: Record<string, unknown>): void => {
    const item = items.value.find((it) => it.name)
    if (item && item.state === 'downloading') {
      item.progress = Number(payload.progress ?? 0)
    }
  }
  const complete = (payload: Record<string, unknown>): void => {
    const item = items.value.find((it) => it.name === payload.name)
    if (item) {
      item.state = 'completed'
      item.progress = 100
    }
  }
  const failed = (payload: Record<string, unknown>): void => {
    const item = items.value.find((it) => it.name === payload.name)
    if (item) {
      item.state = 'error'
      item.error = String(payload.error || '下载失败')
    }
  }
  api.on('download-started', started)
  api.on('download-progress', progress)
  api.on('download-complete', complete)
  api.on('download-error', failed)
  handlers = [
    ['download-started', started],
    ['download-progress', progress],
    ['download-complete', complete],
    ['download-error', failed]
  ]
})

onUnmounted(() => {
  handlers.forEach(([channel, listener]) => api.off(channel, listener))
})
</script>

<style scoped>
.dl-page {
  padding-top: 8px;
}
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.page-title {
  font-size: 24px;
  font-weight: 800;
}
.open-dir {
  height: 34px;
  padding: 0 18px;
  border-radius: 17px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
}
.dl-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dl-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  border-radius: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.dl-cover {
  width: 46px;
  height: 46px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--surface-hover);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  flex-shrink: 0;
}
.dl-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.dl-meta {
  flex: 1;
  min-width: 0;
}
.dl-name {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dl-artist {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 2px;
}
.dl-progress {
  height: 4px;
  border-radius: 2px;
  background: rgba(0, 0, 0, 0.08);
  margin-top: 8px;
  max-width: 320px;
}
.dl-progress-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
}
.dl-error {
  font-size: 12px;
  color: #e5484d;
  margin-top: 4px;
}
.dl-state {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 10px;
  flex-shrink: 0;
}
.dl-state.downloading {
  background: var(--accent-soft);
  color: var(--accent-text);
}
.dl-state.completed {
  background: rgba(0, 0, 0, 0.05);
  color: var(--text-secondary);
}
.dl-state.error {
  background: rgba(229, 72, 77, 0.1);
  color: #e5484d;
}
.empty-tip {
  text-align: center;
  color: var(--text-tertiary);
  padding: 60px 0;
}
</style>
