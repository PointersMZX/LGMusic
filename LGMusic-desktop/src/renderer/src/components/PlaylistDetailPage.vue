<template>
  <transition name="detail-fade">
    <div v-if="navigateState.detailVisible" class="detail-mask">
      <div class="detail-page">
        <div class="detail-head">
          <button class="back-btn" @click="closeDetail">‹ 返回</button>
          <div class="head-info">
            <div class="head-title">{{ navigateState.detailName }}</div>
            <div class="head-sub">{{ sourceLabel }} · {{ tracks.length }} 首</div>
          </div>
          <button class="play-all" @click="playAll">▶ 播放全部</button>
        </div>
        <div v-if="error" class="error-tip">{{ error }}</div>
        <div class="detail-list">
          <div v-for="(track, index) in tracks" :key="`${track.source}:${track.rid}`" class="track-row" :class="{ playing: isCurrent(track) }" @dblclick="playFrom(index)">
            <div class="track-index">{{ index + 1 }}</div>
            <div class="track-name">{{ track.name }}</div>
            <div class="track-artist">{{ track.artist }}</div>
            <div class="track-album">{{ track.album || '' }}</div>
            <div class="track-duration">{{ formatDuration(track.duration) }}</div>
            <button class="track-play" title="播放" @click="playFrom(index)">▶</button>
          </div>
        </div>
        <div v-if="loading" class="loading-tip">加载中…</div>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { api, type UnifiedTrack } from '../api'
import { navigateState, closeDetail } from '../stores/navigate'
import { playerState, playTracks } from '../stores/player'

const tracks = ref<UnifiedTrack[]>([])
const loading = ref(false)
const error = ref('')

const sourceLabels: Record<string, string> = {
  wy: '网易云音乐',
  kw: '酷我音乐',
  qq: 'QQ 音乐',
  tx: 'QQ 音乐',
  kg: '酷狗音乐'
}

const sourceLabel = ref('')

function formatDuration(value: number | string | undefined): string {
  const sec = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(sec) || sec <= 0) return '--:--'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function isCurrent(track: UnifiedTrack): boolean {
  return playerState.current?.rid === track.rid && playerState.current?.source === track.source
}

async function load(): Promise<void> {
  const { detailSource, detailId } = navigateState
  tracks.value = []
  error.value = ''
  if (!detailId) return
  loading.value = true
  sourceLabel.value = sourceLabels[detailSource] || detailSource
  try {
    let res: Record<string, unknown> | null = null
    if (detailSource === 'wy') {
      res = await api.invoke('get-wy-playlist', { id: detailId, limit: 300 })
    } else if (detailSource === 'kw') {
      res = await api.invoke('get-kw-playlist', { id: detailId, page: 1, limit: 100 })
    } else if (detailSource === 'qq' || detailSource === 'tx') {
      res = await api.invoke('get-qq-playlist', { id: detailId })
    } else if (detailSource === 'kg') {
      res = await api.invoke('get-kg-playlist', { id: detailId, page: 1 })
    }
    if (!res || res.code !== 200) throw new Error(String(res?.msg || '获取歌单失败'))
    const data = (res.data ?? {}) as Record<string, unknown>
    const list = (data.musicList as Array<Record<string, unknown>>) || []
    tracks.value = list
      .map((it) => {
        const rid = String(it.rid ?? it.hash ?? '')
        if (!rid) return null
        return {
          rid,
          name: String(it.name ?? ''),
          artist: String(it.artist ?? ''),
          album: it.album ? String(it.album) : undefined,
          pic: it.pic ? String(it.pic) : undefined,
          duration: it.duration as number | string | undefined,
          hash: it.hash ? String(it.hash) : undefined,
          sqHash: it.sqHash ? String(it.sqHash) : undefined,
          source: detailSource === 'tx' ? 'qq' : detailSource
        } satisfies UnifiedTrack
      })
      .filter((t): t is UnifiedTrack => !!t)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

watch(() => navigateState.detailVisible, (visible) => {
  if (visible) void load()
})

function playFrom(index: number): void {
  playTracks(tracks.value, index)
}

function playAll(): void {
  if (tracks.value.length) playTracks(tracks.value, 0)
}
</script>

<style scoped>
.detail-mask {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: var(--bg-base);
  display: flex;
  flex-direction: column;
}
.detail-page {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 20px 32px;
  min-height: 0;
}
.detail-head {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-bottom: 16px;
}
.back-btn {
  height: 34px;
  padding: 0 16px;
  border-radius: 17px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
}
.head-info {
  flex: 1;
  min-width: 0;
}
.head-title {
  font-size: 20px;
  font-weight: 800;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.head-sub {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 4px;
}
.play-all {
  height: 36px;
  padding: 0 22px;
  border-radius: 18px;
  border: none;
  background: var(--accent);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.error-tip {
  color: #e5484d;
  padding: 12px 0;
}
.detail-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.track-row {
  display: grid;
  grid-template-columns: 40px 1fr 200px 200px 60px 40px;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  cursor: default;
}
.track-row:hover {
  background: var(--surface-hover);
}
.track-row.playing {
  background: var(--accent-soft);
  color: var(--accent-text);
}
.track-index {
  color: var(--text-tertiary);
  text-align: center;
}
.track-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.track-artist,
.track-album {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.track-duration {
  color: var(--text-tertiary);
}
.track-play {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: none;
  background: var(--accent-soft);
  color: var(--accent-text);
  cursor: pointer;
  display: none;
}
.track-row:hover .track-play {
  display: block;
}
.loading-tip {
  color: var(--text-tertiary);
  padding: 24px 0;
  text-align: center;
}
.detail-fade-enter-active,
.detail-fade-leave-active {
  transition: opacity 0.15s;
}
.detail-fade-enter-from,
.detail-fade-leave-to {
  opacity: 0;
}
</style>
