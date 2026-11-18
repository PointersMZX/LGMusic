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
        <button class="mini-btn" title="收藏" @click="toggleFavorite">♥</button>
        <button class="mini-btn" title="下载" @click="downloadCurrentTrack">⬇</button>
      </div>
    </div>
    <div class="player-center">
      <div class="control-row">
        <button class="ctrl ghost" title="MV">🎬</button>
        <button class="ctrl" @click="playPrev">⏮</button>
        <button class="ctrl main" @click="togglePlay">{{ playerState.loading ? '…' : playerState.playing ? '⏸' : '▶' }}</button>
        <button class="ctrl" @click="playNext">⏭</button>
        <button class="ctrl ghost" title="音量">🔊</button>
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
