import { type Ref, onBeforeUnmount, onMounted } from '@common/utils/vueTools'

// 磁吸弹簧（液态玻璃规范 §3.4 弹簧阻尼：v += (t - p) * k; v *= d; p += v）
// 指针进入吸附半径内，元素向指针方向微移；离开后弹簧回弹归位，稳定后自动停止 rAF。
// 写入 --mx/--my（-1~1，按 6px 满幅换算），CSS 侧由 .glass-magnet() 消费；
// prefers-reduced-motion 时整体不启动。
export default (domRef: Ref<HTMLElement | undefined>, { radius = 70, maxOffset = 5, stiffness = 0.12, damping = 0.86 } = {}) => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return

  let rafId = 0
  let x = 0
  let y = 0
  let vx = 0
  let vy = 0
  let tx = 0
  let ty = 0
  let hover = false
  let rect: DOMRect | null = null

  const measure = () => {
    rect = domRef.value?.getBoundingClientRect() ?? null
  }

  const write = () => {
    const dom = domRef.value
    if (!dom) return
    dom.style.setProperty('--mx', (x / 6).toFixed(4))
    dom.style.setProperty('--my', (y / 6).toFixed(4))
  }

  const step = () => {
    vx = (vx + (tx - x) * stiffness) * damping
    vy = (vy + (ty - y) * stiffness) * damping
    x += vx
    y += vy
    write()
    // 指针不在场且弹簧能量耗尽：落定并停帧
    if (!hover && Math.abs(x) < 0.05 && Math.abs(y) < 0.05 && Math.abs(vx) < 0.02 && Math.abs(vy) < 0.02) {
      x = 0
      y = 0
      vx = 0
      vy = 0
      write()
      rafId = 0
      return
    }
    rafId = requestAnimationFrame(step)
  }

  const wake = () => {
    if (!rafId) rafId = requestAnimationFrame(step)
  }

  const onMove = (e: PointerEvent) => {
    if (!rect) measure()
    if (!rect) return
    const dx = e.clientX - (rect.left + rect.width / 2)
    const dy = e.clientY - (rect.top + rect.height / 2)
    const dist = Math.hypot(dx, dy)
    if (dist < radius) {
      hover = true
      // 越近吸得越深，目标位移封顶 maxOffset px
      const pull = (1 - dist / radius) * 0.55 + 0.45
      tx = Math.max(-1, Math.min(1, dx / radius)) * pull * maxOffset
      ty = Math.max(-1, Math.min(1, dy / radius)) * pull * maxOffset
    } else {
      hover = false
      tx = 0
      ty = 0
    }
    wake()
  }

  const onResize = () => {
    rect = null
  }

  onMounted(() => {
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('resize', onResize)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('resize', onResize)
    if (rafId) cancelAnimationFrame(rafId)
  })
}
