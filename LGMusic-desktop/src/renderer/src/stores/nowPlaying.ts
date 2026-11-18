/** 播放页显隐状态 */
import { reactive } from 'vue'

export const nowPlayingState = reactive({ visible: false })

export function showNowPlaying(): void {
  nowPlayingState.visible = true
}

export function hideNowPlaying(): void {
  nowPlayingState.visible = false
}

export const nowPlayingVisible = nowPlayingState
