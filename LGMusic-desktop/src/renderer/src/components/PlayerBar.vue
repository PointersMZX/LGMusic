<template>
  <footer class="player-bar">
    <div class="player-left">
      <div class="cover-holder">
        <img v-if="playerState.current?.pic" :src="playerState.current.pic" referrerpolicy="no-referrer" />
        <span v-else class="cover-note">{{ playerState.current ? '♪' : '' }}</span>
      </div>
      <div class="track-meta">
        <div class="meta-name">{{ playerState.current?.name || '未在播放' }}</div>
        <div class="meta-artist">{{ playerState.current?.artist || '' }}</div>
      </div>
    </div>
    <div class="player-center">
      <div class="player-controls">
        <button class="ctrl" @click="playPrev">⏮</button>
        <button class="ctrl main" @click="togglePlay">{{ playerState.loading ? '…' : playerState.playing ? '⏸' : '▶' }}</button>
        <button class="ctrl" @click="playNext">⏭</button>
      </div>
      <div class="progress-line">
        <span class="time">{{ fmt(playerState.currentTime) }}</span>
        <div class="progress-track" @click="onSeek">
          <div class="progress-fill" :style="{ width: progressPercent + '%' }"></div>
        </div>
        <span class="time">{{ fmt(playerState.duration) }}</span>
      </div>
    </div>
    <div class="player-right">
      <span class="level-badge">{{ playerState.level || '' }}</span>
      <span v-if="playerState.error" class="player-error">{{ playerState.error }}</span>
    </div>
  </footer>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { playerState, togglePlay, playNext, playPrev, seekTo } from '../stores/player'

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const progressPercent = computed(() =>
  playerState.duration > 0 ? Math.min(100, (playerState.currentTime / playerState.duration) * 100) : 0
)

function onSeek(event: MouseEvent): void {
  const target = event.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  const ratio = (event.clientX - rect.left) / rect.width
  seekTo(ratio * playerState.duration)
}
</script>

<style scoped>
.player-bar {
  height: 78px;
  background: var(--bg-sidebar);
  border-top: 1px solid var(--border);
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  padding: 0 20px;
  gap: 20px;
}
.player-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.cover-holder {
  width: 48px;
  height: 48px;
  border-radius: 10px;
  overflow: hidden;
  background: var(--surface-hover);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.cover-holder img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cover-note {
  font-size: 20px;
  color: var(--text-tertiary);
}
.track-meta {
  min-width: 0;
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
  color: var(--text-tertiary);
  margin-top: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.player-center {
  width: 480px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  align-items: center;
}
.player-controls {
  display: flex;
  gap: 16px;
  align-items: center;
}
.ctrl {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: none;
  background: rgba(0, 0, 0, 0.05);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 13px;
}
.ctrl.main {
  width: 40px;
  height: 40px;
  background: var(--accent);
  color: #fff;
  font-size: 15px;
}
.progress-line {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
}
.time {
  font-size: 11px;
  color: var(--text-tertiary);
  min-width: 38px;
  text-align: center;
}
.progress-track {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: rgba(0, 0, 0, 0.08);
  cursor: pointer;
  position: relative;
}
.progress-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
}
.player-right {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.level-badge {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent-text);
}
.player-error {
  font-size: 11px;
  color: #e5484d;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 220px;
}
</style>
