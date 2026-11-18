<template>
  <div class="settings-page">
    <div class="page-head">
      <h1 class="page-title">设置</h1>
    </div>

    <div class="settings-group">
      <div class="group-title">下载设置</div>
      <div class="setting-row">
        <div class="setting-label">
          <div class="label-name">下载目录</div>
          <div class="label-desc">{{ downloadPath || '默认为系统下载目录' }}</div>
        </div>
        <button class="setting-btn" @click="chooseDownloadDir">更改</button>
      </div>
    </div>

    <div class="settings-group">
      <div class="group-title">关于</div>
      <div class="setting-row">
        <div class="setting-label">
          <div class="label-name">版本</div>
          <div class="label-desc">甘露音乐 v2.0.0</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../api'

const downloadPath = ref('')

onMounted(async () => {
  const res = await api.invoke('get-download-path')
  downloadPath.value = String(res || '')
})

async function chooseDownloadDir(): Promise<void> {
  const res = await api.invoke('set-download-path')
  if (res?.success) downloadPath.value = String(res.path || '')
}
</script>

<style scoped>
.settings-page {
  padding-top: 8px;
  max-width: 760px;
}
.page-head {
  margin-bottom: 18px;
}
.page-title {
  font-size: 24px;
  font-weight: 800;
}
.settings-group {
  margin-bottom: 22px;
}
.group-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-secondary);
  margin-bottom: 10px;
}
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 14px 18px;
  margin-bottom: 10px;
}
.label-name {
  font-size: 14px;
  font-weight: 600;
}
.label-desc {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 4px;
  max-width: 480px;
  word-break: break-all;
}
.setting-btn {
  height: 32px;
  padding: 0 18px;
  border-radius: 16px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
}
.setting-btn:hover {
  background: var(--surface-hover);
}
</style>
