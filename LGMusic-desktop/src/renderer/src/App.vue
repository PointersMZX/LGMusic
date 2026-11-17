<template>
  <div class="app-root">
    <aside class="app-sidebar">
      <div class="app-logo">甘露音乐</div>
      <nav class="app-nav">
        <div v-for="item in nav" :key="item.key" class="nav-item" :class="{ active: item.key === activeNav }" @click="activeNav = item.key">
          {{ item.label }}
        </div>
      </nav>
    </aside>
    <main class="app-content">
      <div class="placeholder-page">
        <h1>{{ activeLabel }}</h1>
        <p>复刻开发中 —— 本页面将按青听样式重建。</p>
      </div>
    </main>
    <footer class="app-player-bar">
      <div class="player-placeholder">播放器底栏</div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

const nav = [
  { key: 'home', label: '首页' },
  { key: 'search', label: '搜索' },
  { key: 'playlist', label: '歌单' },
  { key: 'ranking', label: '排行榜' },
  { key: 'library', label: '我的' },
  { key: 'local', label: '本地音乐' },
  { key: 'settings', label: '设置' }
]

const activeNav = ref('home')
const activeLabel = computed(() => nav.find((n) => n.key === activeNav.value)?.label ?? '')
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}
html,
body,
#app {
  height: 100%;
  font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
  color: #e8e8ee;
  background: #101014;
  overflow: hidden;
  user-select: none;
}
.app-root {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.app-content {
  flex: 1;
  display: flex;
  min-height: 0;
}
.app-sidebar {
  width: 220px;
  background: rgba(255, 255, 255, 0.04);
  padding: 20px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.app-logo {
  font-size: 20px;
  font-weight: 700;
  padding: 8px 12px 20px;
}
.nav-item {
  padding: 10px 14px;
  border-radius: 10px;
  cursor: pointer;
  font-size: 14px;
  color: #b9b9c6;
  transition: background 0.15s;
}
.nav-item:hover {
  background: rgba(255, 255, 255, 0.06);
}
.nav-item.active {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}
.placeholder-page {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #8888a0;
}
.placeholder-page h1 {
  font-size: 22px;
  margin-bottom: 10px;
}
.app-player-bar {
  height: 72px;
  background: rgba(255, 255, 255, 0.05);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #8888a0;
  font-size: 13px;
}
</style>
