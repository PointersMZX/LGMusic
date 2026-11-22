<template>
  <div class="app-root">
    <div class="app-body">
      <aside class="app-sidebar">
        <div class="app-logo">
          <div class="logo-badge">🐸</div>
          <span class="logo-text">甘露音乐</span>
        </div>
        <nav class="app-nav">
          <div class="nav-group-label">发现</div>
          <div
            v-for="item in discoverNav"
            :key="item.key"
            class="nav-item"
            :class="{ active: item.key === activeNav }"
            @click="activeNav = item.key"
          >
            <span class="nav-icon">{{ item.icon }}</span>{{ item.label }}
          </div>
          <div class="nav-group-label">我的</div>
          <div
            v-for="item in myNav"
            :key="item.key"
            class="nav-item"
            :class="{ active: item.key === activeNav }"
            @click="activeNav = item.key"
          >
            <span class="nav-icon">{{ item.icon }}</span>{{ item.label }}
          </div>
          <div class="nav-group-label custom-head">
            自建歌单
            <span class="custom-count">0</span>
            <span class="custom-add">＋</span>
          </div>
        </nav>
      </aside>
      <div class="main-col">
        <header class="app-topbar">
          <div class="nav-arrows">
            <button class="arrow-btn">‹</button>
            <button class="arrow-btn disabled">›</button>
          </div>
          <div class="topbar-search">
            <input
              v-model="globalKeyword"
              class="topbar-search-input"
              placeholder="搜索想听的音乐"
              @keyup.enter="goSearch"
            />
            <span class="topbar-search-icon">🔍</span>
          </div>
          <div class="topbar-right">
            <div class="avatar-holder" @click="activeNav = 'account'">👤</div>
            <span class="user-name">游客</span>
            <button class="win-btn" title="设置" @click="activeNav = 'settings'">⚙</button>
            <button class="win-btn" title="最小化" @click="winControl('minimize')">—</button>
            <button class="win-btn" title="最大化" @click="winControl('maximize')">□</button>
            <button class="win-btn close" title="关闭" @click="winControl('close')">✕</button>
          </div>
        </header>
        <main class="app-content">
          <SearchPage v-if="activeNav === 'search'" :initial-keyword="pendingKeyword" />
          <HomePage v-else-if="activeNav === 'home'" @navigate="activeNav = $event" />
          <ToplistPage v-else-if="activeNav === 'toplist'" />
          <PlaylistSquare v-else-if="activeNav === 'playlist'" />
          <MvPage v-else-if="activeNav === 'mv'" />
          <FavoritesPage v-else-if="activeNav === 'favorites'" />
          <DownloadsPage v-else-if="activeNav === 'downloads'" />
          <SettingsPage v-else-if="activeNav === 'settings'" />
          <RecentPage v-else-if="activeNav === 'recent'" />
          <div v-else class="placeholder-page">
            <h1>{{ activeLabel }}</h1>
            <p>复刻开发中 —— 本页面将按青听样式重建。</p>
          </div>
        </main>
      </div>
    </div>
    <PlayerBar />
    <NowPlayingPage />
    <PlaylistDetailPage />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import SearchPage from './components/SearchPage.vue'
import PlayerBar from './components/PlayerBar.vue'
import HomePage from './components/HomePage.vue'
import ToplistPage from './components/ToplistPage.vue'
import PlaylistSquare from './components/PlaylistSquare.vue'
import MvPage from './components/MvPage.vue'
import NowPlayingPage from './components/NowPlayingPage.vue'
import PlaylistDetailPage from './components/PlaylistDetailPage.vue'
import FavoritesPage from './components/FavoritesPage.vue'
import DownloadsPage from './components/DownloadsPage.vue'
import SettingsPage from './components/SettingsPage.vue'
import RecentPage from './components/RecentPage.vue'
import { api } from './api'

function winControl(action: string): void {
  api.send('window-control', action)
}

const discoverNav = [
  { key: 'home', label: '首页', icon: '🏠' },
  { key: 'playlist', label: '歌单广场', icon: '🎵' },
  { key: 'mv', label: 'MV', icon: '🎬' }
]
const myNav = [
  { key: 'favorites', label: '我的喜欢', icon: '❤️' },
  { key: 'recent', label: '最近播放', icon: '🕘' },
  { key: 'downloads', label: '下载管理', icon: '⬇️' },
  { key: 'local', label: '本地音乐', icon: '📁' }
]

const activeNav = ref('home')
const globalKeyword = ref('')
const pendingKeyword = ref('')

const activeLabel = computed(() => {
  const known = [...discoverNav, ...myNav].find((n) => n.key === activeNav.value)?.label
  if (known) return known
  if (activeNav.value === 'account') return '账号'
  if (activeNav.value === 'settings') return '设置'
  if (activeNav.value === 'toplist') return '排行榜'
  return ''
})

function goSearch(): void {
  pendingKeyword.value = globalKeyword.value
  activeNav.value = 'search'
}
</script>

<style scoped>
.app-root {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.app-body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.app-sidebar {
  width: 228px;
  background: var(--bg-sidebar);
  padding: 18px 14px 12px;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
.app-logo {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px 18px;
}
.logo-badge {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: var(--accent-soft);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
}
.logo-text {
  font-size: 17px;
  font-weight: 700;
}
.app-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.nav-group-label {
  font-size: 12px;
  color: var(--text-tertiary);
  padding: 14px 12px 8px;
}
.nav-group-label.custom-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.custom-count {
  font-size: 11px;
  background: var(--surface-hover);
  border-radius: 8px;
  padding: 1px 7px;
}
.custom-add {
  margin-left: auto;
  cursor: pointer;
  color: var(--text-secondary);
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 12px;
  cursor: pointer;
  font-size: 14px;
  color: var(--text-secondary);
  transition: background 0.15s;
}
.nav-item:hover {
  background: var(--surface-hover);
}
.nav-item.active {
  background: var(--accent-soft);
  color: var(--accent-text);
  font-weight: 600;
}
.nav-icon {
  font-size: 15px;
}
.main-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.app-topbar {
  height: 64px;
  display: grid;
  grid-template-columns: 1fr minmax(320px, 520px) 1fr;
  align-items: center;
  padding: 0 24px;
  background: transparent;
  -webkit-app-region: drag;
}
.app-topbar button,
.app-topbar input,
.app-topbar .avatar-holder,
.app-topbar .user-name {
  -webkit-app-region: no-drag;
}
.nav-arrows {
  display: flex;
  gap: 6px;
}
.arrow-btn {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: none;
  background: rgba(0, 0, 0, 0.05);
  color: var(--text-secondary);
  font-size: 16px;
  cursor: pointer;
}
.arrow-btn.disabled {
  opacity: 0.45;
}
.topbar-search {
  position: relative;
  width: 100%;
}
.topbar-search-input {
  width: 100%;
  height: 40px;
  border-radius: 20px;
  border: none;
  background: rgba(0, 0, 0, 0.055);
  color: inherit;
  padding: 0 44px 0 18px;
  font-size: 14px;
  outline: none;
}
.topbar-search-input:focus {
  background: #fff;
  box-shadow: var(--shadow-card);
}
.topbar-search-icon {
  position: absolute;
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 14px;
  opacity: 0.55;
}
.topbar-right {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 6px;
}
.avatar-holder {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.06);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.user-name {
  font-size: 14px;
  font-weight: 600;
  margin-right: 8px;
}
.win-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
}
.win-btn:hover {
  background: rgba(0, 0, 0, 0.07);
}
.win-btn.close:hover {
  background: #e5484d;
  color: #fff;
}
.app-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 4px 24px 24px;
}
.placeholder-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
}
.placeholder-page h1 {
  font-size: 22px;
  margin-bottom: 10px;
}
</style>
