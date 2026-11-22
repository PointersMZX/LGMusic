<template>
  <div class="settings-page">
    <div class="page-head">
      <h1 class="page-title">设置</h1>
    </div>

    <!-- 音源配置 -->
    <div class="settings-group">
      <div class="group-title">音源配置</div>
      <div class="setting-hint">导入音源配置后才能搜索歌曲、播放网络歌曲和使用 MV。支持导入本地音源配置文件。</div>
      <div class="setting-row">
        <div class="setting-label">
          <div class="label-name">音源脚本</div>
          <div class="label-desc">支持导入 .js 音源（MusicFree 插件 / LX 音源）与 .json 配置</div>
        </div>
        <button class="setting-btn primary" @click="importSources">导入</button>
      </div>
      <div v-if="sources.length" class="source-list">
        <div v-for="src in sources" :key="src.fileName" class="source-row">
          <div class="source-info">
            <div class="source-name">{{ src.name }}</div>
            <div class="source-file">{{ src.fileName }} · {{ src.type }}{{ src.version ? ' · v' + src.version : '' }}</div>
          </div>
          <button class="setting-btn danger" @click="removeSource(src.fileName)">删除</button>
        </div>
      </div>
      <div v-else class="source-empty">尚未导入音源配置</div>
    </div>

    <!-- 播放设置 -->
    <div class="settings-group">
      <div class="group-title">播放设置</div>
      <div class="setting-row">
        <div class="setting-label">
          <div class="label-name">默认音质</div>
          <div class="label-desc">在线播放与下载使用的默认音质档位</div>
        </div>
        <select v-model="quality" class="setting-select" @change="saveQuality">
          <option value="standard">标准</option>
          <option value="exhigh">较高</option>
          <option value="lossless">无损</option>
          <option value="hires">Hi-Res</option>
        </select>
      </div>
    </div>

    <!-- 下载设置 -->
    <div class="settings-group">
      <div class="group-title">下载设置</div>
      <div class="setting-row">
        <div class="setting-label">
          <div class="label-name">下载目录</div>
          <div class="label-desc">{{ downloadPath || '默认为系统下载目录' }}</div>
        </div>
        <button class="setting-btn" @click="chooseDownloadDir">更改</button>
        <button class="setting-btn" @click="openDownloadDir">打开</button>
      </div>
    </div>

    <!-- 桌面歌词 -->
    <div class="settings-group">
      <div class="group-title">桌面歌词</div>
      <div class="setting-row">
        <div class="setting-label">
          <div class="label-name">开启桌面歌词</div>
          <div class="label-desc">在屏幕上悬浮显示当前播放歌词</div>
        </div>
        <button class="setting-btn" @click="toggleLyricWindow">{{ lyricWindowOpen ? '关闭' : '开启' }}</button>
      </div>
      <div class="setting-row">
        <div class="setting-label">
          <div class="label-name">歌词字号</div>
          <div class="label-desc">{{ lyricFontSize }}px</div>
        </div>
        <input
          v-model.number="lyricFontSize"
          class="setting-range"
          type="range"
          min="16"
          max="44"
          step="2"
          @change="saveDesktopLyric"
        />
      </div>
      <div class="setting-row">
        <div class="setting-label">
          <div class="label-name">歌词颜色</div>
          <div class="label-desc">{{ lyricColor }}</div>
        </div>
        <input v-model="lyricColor" class="setting-color" type="color" @change="saveDesktopLyric" />
      </div>
      <div class="setting-row">
        <div class="setting-label">
          <div class="label-name">双行显示</div>
          <div class="label-desc">同时显示下一句歌词</div>
        </div>
        <label class="setting-switch">
          <input v-model="lyricTwoLine" type="checkbox" @change="saveDesktopLyric" />
          <span class="switch-ui"></span>
        </label>
      </div>
    </div>

    <!-- 备份 -->
    <div class="settings-group">
      <div class="group-title">备份与恢复</div>
      <div class="setting-row">
        <div class="setting-label">
          <div class="label-name">数据备份</div>
          <div class="label-desc">歌单、收藏等数据的快照备份（{{ backupFiles.length }} 份备份）</div>
        </div>
        <button class="setting-btn primary" @click="createBackup">立即备份</button>
      </div>
      <div v-if="backupFiles.length" class="source-list">
        <div v-for="f in backupFiles" :key="f" class="source-row">
          <div class="source-info">
            <div class="source-name">{{ f }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 关于 -->
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
import { computed, onMounted, ref } from 'vue'
import { api } from '../api'

interface SourceMeta {
  fileName: string
  name: string
  type: string
  version: string
  importedAt: number
}

interface AppConfigView {
  defaultQuality: string
  downloadDir: string
  desktopLyric: { fontSize: number; color: string; shadow: boolean; twoLine: boolean }
}

const downloadPath = ref('')
const quality = ref('standard')
const sources = ref<SourceMeta[]>([])
const lyricFontSize = ref(26)
const lyricColor = ref('#29c586')
const lyricTwoLine = ref(false)
const lyricWindowOpen = ref(false)
const backupFiles = ref<string[]>([])

const lyricSettingsPayload = computed(() => ({
  fontSize: lyricFontSize.value,
  color: lyricColor.value,
  twoLine: lyricTwoLine.value
}))

async function loadAll(): Promise<void> {
  const config = (await api.invoke('settings-get').catch(() => null)) as AppConfigView | null
  if (config) {
    quality.value = config.defaultQuality || 'standard'
    downloadPath.value = config.downloadDir || ''
    lyricFontSize.value = config.desktopLyric?.fontSize ?? 26
    lyricColor.value = config.desktopLyric?.color ?? '#29c586'
    lyricTwoLine.value = config.desktopLyric?.twoLine ?? false
  }
  const dirRes = (await api.invoke('get-download-path').catch(() => null)) as string | null
  if (dirRes) downloadPath.value = String(dirRes)
  sources.value = ((await api.invoke('source-list').catch(() => [])) as SourceMeta[]) || []
  const backupStatus = (await api.invoke('backup-list-files').catch(() => null)) as string[] | null
  backupFiles.value = Array.isArray(backupStatus) ? backupStatus : []
}

async function saveQuality(): Promise<void> {
  await api.invoke('settings-set', { defaultQuality: quality.value })
}

async function saveDesktopLyric(): Promise<void> {
  await api.invoke('settings-set', { desktopLyric: lyricSettingsPayload.value })
  await api.invoke('update-desktop-lyric-settings', lyricSettingsPayload.value)
}

async function importSources(): Promise<void> {
  const added = (await api.invoke('source-import').catch(() => null)) as SourceMeta[] | null
  if (added && added.length > 0) {
    sources.value = ((await api.invoke('source-list').catch(() => [])) as SourceMeta[]) || []
  }
}

async function removeSource(fileName: string): Promise<void> {
  sources.value = ((await api.invoke('source-delete', fileName).catch(() => [])) as SourceMeta[]) || []
}

async function chooseDownloadDir(): Promise<void> {
  const res = (await api.invoke('set-download-path').catch(() => null)) as { success: boolean; path?: string } | null
  if (res?.success) downloadPath.value = String(res.path || '')
}

async function openDownloadDir(): Promise<void> {
  await api.invoke('open-download-directory')
}

async function toggleLyricWindow(): Promise<void> {
  await api.invoke('lyric-window-control', 'toggle')
  lyricWindowOpen.value = !lyricWindowOpen.value
}

async function createBackup(): Promise<void> {
  await api.invoke('backup-create', {})
  const files = (await api.invoke('backup-list-files').catch(() => null)) as string[] | null
  backupFiles.value = Array.isArray(files) ? files : []
}

onMounted(() => void loadAll())
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
  font-size: 22px;
  font-weight: 800;
}
.settings-group {
  background: var(--surface, #fff);
  border-radius: 14px;
  padding: 6px 18px 10px;
  margin-bottom: 16px;
  box-shadow: var(--shadow-card);
}
.group-title {
  font-size: 15px;
  font-weight: 700;
  padding: 12px 0 6px;
  color: #1f2329;
}
.setting-hint {
  font-size: 12px;
  color: #e08a3a;
  background: #fff7ec;
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 8px;
  line-height: 1.5;
}
.setting-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid rgba(0, 0, 0, 0.04);
}
.setting-row:first-of-type {
  border-top: none;
}
.setting-label {
  flex: 1;
  min-width: 0;
}
.label-name {
  font-size: 14px;
  font-weight: 500;
  color: #1f2329;
}
.label-desc {
  font-size: 12px;
  color: var(--text-tertiary, #9ca3af);
  margin-top: 3px;
  word-break: break-all;
}
.setting-btn {
  height: 32px;
  padding: 0 16px;
  border-radius: 16px;
  border: 1px solid var(--border-color, #ececf0);
  background: var(--surface, #fff);
  color: #374151;
  font-size: 13px;
  cursor: pointer;
  flex-shrink: 0;
}
.setting-btn:hover {
  filter: brightness(0.97);
}
.setting-btn.primary {
  background: #29c586;
  border-color: transparent;
  color: #fff;
}
.setting-btn.danger {
  color: #e5484d;
  border-color: rgba(229, 72, 77, 0.35);
}
.setting-select {
  height: 32px;
  border-radius: 8px;
  border: 1px solid var(--border-color, #ececf0);
  padding: 0 10px;
  font-size: 13px;
  background: var(--surface, #fff);
  color: #1f2329;
}
.setting-range {
  width: 180px;
  accent-color: #29c586;
}
.setting-color {
  width: 44px;
  height: 32px;
  border: 1px solid var(--border-color, #ececf0);
  border-radius: 8px;
  padding: 2px;
  background: var(--surface, #fff);
}
.setting-switch {
  position: relative;
  display: inline-block;
  width: 42px;
  height: 24px;
  flex-shrink: 0;
}
.setting-switch input {
  display: none;
}
.switch-ui {
  position: absolute;
  inset: 0;
  border-radius: 12px;
  background: #d1d5db;
  transition: background 0.2s;
  cursor: pointer;
}
.switch-ui::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 9px;
  background: #fff;
  transition: left 0.2s;
}
.setting-switch input:checked + .switch-ui {
  background: #29c586;
}
.setting-switch input:checked + .switch-ui::after {
  left: 21px;
}
.source-list {
  margin: 4px 0 8px;
}
.source-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--surface-hover, rgba(0, 0, 0, 0.03));
  margin-bottom: 6px;
}
.source-info {
  flex: 1;
  min-width: 0;
}
.source-name {
  font-size: 13px;
  font-weight: 600;
  color: #1f2329;
}
.source-file {
  font-size: 11px;
  color: var(--text-tertiary, #9ca3af);
  margin-top: 2px;
}
.source-empty {
  font-size: 12px;
  color: var(--text-tertiary, #9ca3af);
  padding: 4px 0 10px;
}
</style>
