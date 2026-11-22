<template>
  <footer class="player-bar">
    <div class="player-left">
      <div class="cover-holder" @click="openNowPlaying">
        <img v-if="playerState.current?.pic" :src="playerState.current.pic" referrerpolicy="no-referrer" />
        <span v-else class="cover-note">{{ playerState.current ? '♪' : '' }}</span>
      </div>
      <div class="track-meta" @click="openNowPlaying">
        <div class="meta-name" :title="metaTitle">{{ metaTitle }}</div>
        <div class="meta-artist" :title="metaArtist">{{ metaArtist }}</div>
      </div>
      <div class="left-actions">
        <button class="mini-btn" title="收藏" @click="toggleFavorite">
          <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 21s-7.5-4.7-10-9.3C.4 8.4 2.4 5 5.7 5c1.9 0 3.4 1 4.3 2.5h4c1-1.5 2.4-2.5 4.3-2.5 3.3 0 5.3 3.4 3.7 6.7C19.5 16.3 12 21 12 21z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
        </button>
        <button class="mini-btn" title="下载" @click="downloadCurrentTrack">
          <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 3v10M7 9l5 5 5-5M4 19h16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>
    <div class="player-center">
      <div class="control-row">
        <button class="ctrl ghost" title="MV">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 6h16v12H4zM10 9l5 3-5 3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
        </button>
        <button class="ctrl" title="上一首" @click="playPrev">
          <svg viewBox="0 0 24 24" width="20" height="20"><path d="M6 5h2v14H6zM20 5v14L9 12z" fill="currentColor"/></svg>
        </button>
        <button class="ctrl main" title="播放/暂停" @click="togglePlay">
          <svg v-if="!playerState.playing" viewBox="0 0 24 24" width="22" height="22"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>
          <svg v-else viewBox="0 0 24 24" width="22" height="22"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>
        </button>
        <button class="ctrl" title="下一首" @click="playNext">
          <svg viewBox="0 0 24 24" width="20" height="20"><path d="M16 5h2v14h-2zM4 5l11 7-11 7z" fill="currentColor"/></svg>
        </button>
        <button class="ctrl ghost" title="音量">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 9v6h4l5 4V5L8 9zM16.5 12a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z" fill="currentColor"/></svg>
        </button>
      </div>
      <div class="progress-row">
        <span class="time">{{ fmt(playerState.currentTime) }}</span>
        <div class="progress-track" @click="onSeek">
          <div class="progress-fill" :style="{ width: progressPercent + '%' }"></div>
          <div class="progress-knob" :style="{ left: progressPercent + '%' }"></div>
        </div>
        <span class="time">{{ fmt(playerState.duration) }}</span>
      </div>
    </div>
    <div class="player-right">
      <span class="level-badge">{{ playerState.level || '' }}</span>
      <button class="pill-btn" title="小 Q">小Q</button>
      <button class="pill-btn" title="桌面歌词" @click="toggleDesktopLyric">词</button>
      <button class="pill-btn" title="播放列表">☰</button>
      <span v-if="playerState.error" class="player-error">{{ playerState.error }}</span>
    </div>
  </footer>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { playerState, togglePlay, playNext, playPrev, seekTo, downloadCurrentTrack } from '../stores/player'
import { nowPlayingVisible, showNowPlaying } from '../stores/nowPlaying'

const metaTitle = computed(() =>
  playerState.current ? `${playerState.current.name}${playerState.current.artist ? ' – ' : ''}` : '未在播放'
)
const metaArtist = computed(() => (playerState.current?.artist ? playerState.current.artist : ''))

const progressPercent = computed(() =>
  playerState.duration > 0 ? Math.min(100, (playerState.currentTime / playerState.duration) * 100) : 0
)

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function onSeek(event: MouseEvent): void {
  const target = event.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  const ratio = (event.clientX - rect.left) / rect.width
  seekTo(ratio * playerState.duration)
}

function toggleFavorite(): void {
  /* 收藏逻辑接入 favorite-get-snapshot / 主进程收藏接口 */
}

function toggleDesktopLyric(): void {
  window.electronAPI.send('lyric-window-control', 'toggle')
}

function openNowPlaying(): void {
  showNowPlaying()
}
</script>

<style scoped>
.player-bar {
  height: 82px;
  background: linear-gradient(120deg, #3a1d24 0%, #4a2a33 45%, #33202b 100%);
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  padding: 0 20px;
  gap: 18px;
  color: #f3eef0;
}
.player-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.cover-holder {
  width: 52px;
  height: 52px;
  border-radius: 10px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.12);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  cursor: pointer;
}
.cover-holder img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cover-note {
  font-size: 20px;
  color: rgba(255, 255, 255, 0.6);
}
.track-meta {
  min-width: 0;
  cursor: pointer;
}
.meta-name {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta-artist {
  font-size: 12px;
  color: rgba(243, 238, 240, 0.62);
  margin-top: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.left-actions {
  display: flex;
  gap: 4px;
  margin-left: 6px;
}
.mini-btn {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: rgba(243, 238, 240, 0.75);
  cursor: pointer;
  font-size: 13px;
}
.mini-btn:hover {
  background: rgba(255, 255, 255, 0.12);
}
.player-center {
  width: 520px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}
.control-row {
  display: flex;
  gap: 14px;
  align-items: center;
}
.ctrl {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: #f3eef0;
  cursor: pointer;
  font-size: 14px;
}
.ctrl:hover {
  background: rgba(255, 255, 255, 0.12);
}
.ctrl.main {
  width: 44px;
  height: 44px;
  background: #29c586;
  color: #fff;
  font-size: 16px;
  box-shadow: 0 4px 14px rgba(41, 197, 134, 0.4);
}
.ctrl.ghost {
  color: rgba(243, 238, 240, 0.7);
}
.progress-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
}
.time {
  font-size: 11px;
  color: rgba(243, 238, 240, 0.65);
  min-width: 38px;
  text-align: center;
}
.progress-track {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.18);
  cursor: pointer;
  position: relative;
}
.progress-fill {
  height: 100%;
  border-radius: 2px;
  background: #e86a7a;
}
.progress-knob {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
}
.player-right {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.level-badge {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 8px;
  background: rgba(41, 197, 134, 0.25);
  color: #bdeedd;
}
.pill-btn {
  height: 30px;
  min-width: 44px;
  border-radius: 15px;
  border: none;
  background: rgba(255, 255, 255, 0.14);
  color: #f3eef0;
  font-size: 12px;
  cursor: pointer;
  padding: 0 12px;
}
.pill-btn:hover {
  background: rgba(255, 255, 255, 0.22);
}
.player-error {
  font-size: 11px;
  color: #ffb3ba;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 180px;
}
</style>
