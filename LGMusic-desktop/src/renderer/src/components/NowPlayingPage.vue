<template>
  <transition name="np-fade">
    <div v-if="nowPlayingState.visible" class="np-mask">
      <div class="np-page">
        <div class="np-bg" :style="bgStyle"></div>
        <div class="np-topbar">
          <button class="np-down" title="收起" @click="hideNowPlaying">▼</button>
        </div>
        <div class="np-body">
          <div class="np-left">
            <div class="np-cover">
              <img v-if="playerState.current?.pic" :src="playerState.current.pic" referrerpolicy="no-referrer" />
              <span v-else class="cover-note">{{ playerState.current ? '♪' : '' }}</span>
            </div>
          </div>
          <div class="np-right">
            <div class="np-title">{{ playerState.current?.name || '未在播放' }}</div>
            <div class="np-artist">
              {{ playerState.current?.artist || '' }}
              <span v-if="playerState.level" class="np-level">{{ playerState.level }}</span>
            </div>
            <div class="np-lyric" ref="lyricBox">
              <div
                v-for="(line, i) in lyricDisplay"
                :key="i"
                class="lyric-line"
                :class="{ on: line.active }"
                :data-line="i"
              >{{ line.text }}</div>
              <div v-if="!lyricDisplay.length" class="lyric-empty">暂无歌词</div>
            </div>
          </div>
        </div>
        <div class="np-bottom">
          <div class="np-controls">
            <button class="np-ctrl" @click="playPrev">⏮</button>
            <button class="np-ctrl main" @click="togglePlay">{{ playerState.loading ? '…' : playerState.playing ? '⏸' : '▶' }}</button>
            <button class="np-ctrl" @click="playNext">⏭</button>
          </div>
          <div class="np-progress">
            <span class="time">{{ fmt(playerState.currentTime) }}</span>
            <div class="np-track" @click="onSeek">
              <div class="np-fill" :style="{ width: progressPercent + '%' }"></div>
            </div>
            <span class="time">{{ fmt(playerState.duration) }}</span>
          </div>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { playerState, togglePlay, playNext, playPrev, seekTo } from '../stores/player'
import { nowPlayingState, hideNowPlaying } from '../stores/nowPlaying'

const lyricLines = ref<Array<{ time: number; text: string }>>([])

function parseLyric(text: string): Array<{ time: number; text: string }> {
  const out: Array<{ time: number; text: string }> = []
  for (const raw of text.split(/\r?\n/)) {
    const matches = [...raw.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
    if (!matches.length) continue
    const content = raw
      .replace(/^\[(?:\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?)\]\s*/, '')
      .replace(/\[(?:\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?)\]/g, '')
      .trim()
    for (const m of matches) {
      const time = Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(`0.${m[3]}`) : 0)
      out.push({ time, text: content })
    }
  }
  return out.sort((a, b) => a.time - b.time)
}

async function loadLyric(): Promise<void> {
  const track = playerState.current
  lyricLines.value = []
  if (!track) return
  try {
    const channelMap: Record<string, string> = {
      wy: 'get-lyric-wy',
      kw: 'get-lyric-kw',
      kg: 'get-lyric-kg',
      qq: 'get-lyric-qq',
      mg: 'get-lyric-mg'
    }
    const channel = channelMap[track.source]
    if (!channel) return
    const payload = track.source === 'kg' ? track.hash : track.rid
    const res = await window.electronAPI.invoke(channel, payload)
    const raw = res?.lyric || res?.raw_lyric || res?.lrc || ''
    lyricLines.value = parseLyric(String(raw))
  } catch {
    lyricLines.value = []
  }
}

watch(() => playerState.current?.rid, loadLyric, { immediate: true })

const activeIndex = computed(() => {
  let idx = -1
  for (let i = 0; i < lyricLines.value.length; i += 1) {
    if (lyricLines.value[i].time <= playerState.currentTime) idx = i
    else break
  }
  return idx
})

const lyricBox = ref<HTMLElement | null>(null)

// 当前行变化 → 滚动歌词盒，让当前行保持在中部
watch(activeIndex, async (idx) => {
  if (idx < 0 || !lyricBox.value) return
  await nextTick()
  const line = lyricBox.value.querySelector(`[data-line="${idx}"]`) as HTMLElement | null
  if (line) {
    lyricBox.value.scrollTo({
      top: line.offsetTop - lyricBox.value.clientHeight / 2 + line.clientHeight / 2,
      behavior: 'smooth'
    })
  }
})

const lyricDisplay = computed(() =>
  lyricLines.value.map((line, i) => ({ ...line, active: i === activeIndex.value }))
)

const bgStyle = computed(() => {
  const pic = playerState.current?.pic
  return pic
    ? { backgroundImage: `url(${pic})`, filter: 'blur(60px)', transform: 'scale(1.3)' }
    : { background: 'linear-gradient(140deg,#2a2a34,#1c1c24)' }
})

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
</script>

<style scoped>
.np-mask {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(12, 12, 16, 0.92);
  backdrop-filter: blur(20px);
}
.np-page {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  color: #f3eef0;
  overflow: hidden;
}
.np-bg {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center;
  opacity: 0.4;
  z-index: 0;
}
.np-topbar {
  position: relative;
  z-index: 1;
  height: 56px;
  display: flex;
  align-items: center;
  padding: 0 24px;
}
.np-down {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: none;
  background: rgba(255, 255, 255, 0.12);
  color: inherit;
  cursor: pointer;
}
.np-body {
  position: relative;
  z-index: 1;
  flex: 1;
  display: flex;
  gap: 48px;
  padding: 12px 64px;
  min-height: 0;
}
.np-left {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.np-cover {
  width: min(46vh, 380px);
  aspect-ratio: 1;
  border-radius: 20px;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  background: rgba(255, 255, 255, 0.08);
}
.np-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cover-note {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  font-size: 60px;
  color: rgba(255, 255, 255, 0.4);
}
.np-right {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.np-title {
  font-size: 22px;
  font-weight: 700;
}
.np-artist {
  font-size: 14px;
  color: rgba(243, 238, 240, 0.65);
  margin-top: 6px;
}
.np-level {
  font-size: 11px;
  background: rgba(41, 197, 134, 0.3);
  color: #bdeedd;
  border-radius: 8px;
  padding: 2px 8px;
  margin-left: 10px;
}
.np-lyric {
  flex: 1;
  margin-top: 22px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  mask-image: linear-gradient(transparent, #000 15%, #000 85%, transparent);
}
.lyric-line {
  font-size: 15px;
  color: rgba(243, 238, 240, 0.5);
  transition: color 0.25s;
  text-align: left;
}
.lyric-line.on {
  color: #fff;
  font-weight: 600;
  font-size: 16px;
}
.lyric-empty {
  color: rgba(243, 238, 240, 0.4);
  margin-top: 40px;
}
.np-bottom {
  position: relative;
  z-index: 1;
  padding: 12px 64px 26px;
}
.np-controls {
  display: flex;
  justify-content: center;
  gap: 22px;
  margin-bottom: 12px;
}
.np-ctrl {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: none;
  background: rgba(255, 255, 255, 0.12);
  color: inherit;
  cursor: pointer;
  font-size: 15px;
}
.np-ctrl.main {
  width: 50px;
  height: 50px;
  background: #29c586;
  font-size: 18px;
}
.np-progress {
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: 640px;
  margin: 0 auto;
  width: 100%;
}
.time {
  font-size: 11px;
  color: rgba(243, 238, 240, 0.6);
  min-width: 38px;
  text-align: center;
}
.np-track {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.18);
  cursor: pointer;
}
.np-fill {
  height: 100%;
  border-radius: 2px;
  background: #e86a7a;
}
.np-fade-enter-active,
.np-fade-leave-active {
  transition: opacity 0.2s;
}
.np-fade-enter-from,
.np-fade-leave-to {
  opacity: 0;
}
</style>
