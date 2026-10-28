<template>
  <div v-show="enabled" :class="$style.stage" aria-hidden="true">
    <div :class="[$style.orb, $style.orbA]" />
    <div :class="[$style.orb, $style.orbB]" />
    <div :class="[$style.orb, $style.orbC]" />
  </div>
</template>

<script setup>
// 流动舞台光：紫金光斑在背景缓慢漂移，为液态玻璃提供「活的」折射源。
// 开关 = 主题键 --glass-flow（与 LiquidGlass 组件同款轮询模式；
// prefers-reduced-motion 时整层不渲染，舞台回落到静态主题渐变）。
import { ref, onMounted, onBeforeUnmount } from '@common/utils/vueTools'

const enabled = ref(false)
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

let timer = 0
const sync = () => {
  if (reduceMotion) {
    enabled.value = false
    return
  }
  const v = (getComputedStyle(document.documentElement).getPropertyValue('--glass-flow') || '').trim()
  enabled.value = v != 'false'
}

onMounted(() => {
  sync()
  timer = setInterval(sync, 500)
})

onBeforeUnmount(() => {
  clearInterval(timer)
})
</script>

<style lang="less" module>
/* 三团光斑互质周期（19s/26s/37s）避免整体重复感；
   radial-gradient 软边免 filter blur，动画全走 transform（合成器免费） */
.stage {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
}

.orb {
  position: absolute;
  border-radius: 50%;
  will-change: transform;
}

.orbA {
  width: 58vw;
  height: 58vw;
  left: -12vw;
  top: -18vw;
  background: radial-gradient(closest-side, rgba(124, 32, 194, 0.52), transparent 72%);
  animation: flowA 19s ease-in-out infinite alternate;
}

.orbB {
  width: 48vw;
  height: 48vw;
  right: -14vw;
  bottom: -16vw;
  background: radial-gradient(closest-side, rgba(212, 176, 111, 0.30), transparent 70%);
  animation: flowB 26s ease-in-out infinite alternate;
}

.orbC {
  width: 40vw;
  height: 40vw;
  left: 34%;
  top: 38%;
  background: radial-gradient(closest-side, rgba(63, 15, 90, 0.44), transparent 74%);
  animation: flowC 37s ease-in-out infinite alternate;
}

@keyframes flowA {
  from { transform: translate3d(0, 0, 0) scale(1); }
  to { transform: translate3d(14vw, 9vh, 0) scale(1.18); }
}

@keyframes flowB {
  from { transform: translate3d(0, 0, 0) scale(1); }
  to { transform: translate3d(-11vw, -10vh, 0) scale(0.86); }
}

@keyframes flowC {
  from { transform: translate3d(0, 0, 0) rotate(0deg) scale(1); }
  to { transform: translate3d(-7vw, 7vh, 0) rotate(30deg) scale(1.12); }
}
</style>
