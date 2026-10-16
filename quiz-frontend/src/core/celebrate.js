/**
 * celebrate.js —— 答题反馈特效（**纯 Canvas，不引库**）
 *
 * 两种场合：
 *   redeem  答对了一道**以前做错的题** —— 这是刷题里最爽的一刻，值得爆一下
 *   streak  连对达到里程碑（5 / 10 / 20 / 30）—— 越往上越盛大
 *
 * 为什么不引 confetti 之类的库：这个项目对图表/特效一贯是手写
 * （见报告页"不引图表库"、背景的 WebGL 也是自己写的着色器）。为了这点粒子
 * 加一个几十 KB 的依赖不划算，而且它们的默认配色和本站主题对不上。
 *
 * 几条必须守住的规矩：
 *   1. 覆盖层 `pointer-events: none` —— 特效绝不能挡住"下一题"按钮
 *   2. 尊重 `prefers-reduced-motion` —— 直接不画（不是画慢一点）
 *   3. 画完**必须**把 canvas 摘掉并取消 rAF，绝不后台常驻
 *   4. 同时只允许一层特效：连点下一题不能叠出十个 canvas
 */

/** 特效只能同时存在一层：新的来了就把旧的收掉 */
let activeTeardown = null

const PALETTE = [
  '#6366f1', // 主色靛蓝
  '#a855f7', // 紫
  '#ec4899', // 玫红
  '#f97316', // 橙
  '#22c55e', // 绿（答对色）
  '#facc15', // 金
]

export function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)]
}

/** 画一颗五角星（比圆点更"庆典"，也比贴图省事） */
function starPath(ctx, radius) {
  ctx.beginPath()
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? radius : radius * 0.45
    const angle = (Math.PI / 5) * i - Math.PI / 2
    const x = Math.cos(angle) * r
    const y = Math.sin(angle) * r
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

/**
 * 放一次特效。
 *
 * @param {'redeem'|'streak'} kind
 * @param {{level?:number, label?:string, origin?:{x:number,y:number}}} opts
 *        level 1~3 决定规模；origin 是爆点（默认屏幕水平中央、垂直偏上）
 */
export function celebrate(kind = 'redeem', opts = {}) {
  if (typeof document === 'undefined') return
  if (prefersReducedMotion()) return // 前庭敏感的人：一个粒子都不画

  const level = Math.max(1, Math.min(3, opts.level || 1))
  const originX = opts.origin?.x ?? window.innerWidth / 2
  const originY = opts.origin?.y ?? window.innerHeight * 0.32

  // 先收掉上一波
  if (activeTeardown) {
    activeTeardown()
    activeTeardown = null
  }

  const canvas = document.createElement('canvas')
  canvas.className = 'q-celebrate-canvas'
  canvas.setAttribute('aria-hidden', 'true')
  Object.assign(canvas.style, {
    position: 'fixed',
    inset: '0',
    width: '100%',
    height: '100%',
    pointerEvents: 'none', // ⚠️ 绝不能吃点击
    zIndex: '9999',
  })
  document.body.appendChild(canvas)

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = window.innerWidth * dpr
  canvas.height = window.innerHeight * dpr
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)

  /* ---------------- 粒子 ---------------- */
  const confettiCount = [0, 46, 84, 132][level]
  const starCount = [0, 0, 10, 20][level]
  const particles = []

  for (let i = 0; i < confettiCount; i++) {
    // 向斜上方喷，然后被重力拉回来 —— 比"四面炸开"更像真实的彩带炮
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.9
    const speed = 7 + Math.random() * 9 + level * 1.6
    particles.push({
      type: 'strip',
      x: originX + (Math.random() - 0.5) * 66,
      y: originY + (Math.random() - 0.5) * 26,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      w: 5 + Math.random() * 5,
      h: 8 + Math.random() * 8,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.36,
      color: pick(PALETTE),
      life: 1,
      decay: 0.0075 + Math.random() * 0.005,
    })
  }

  for (let i = 0; i < starCount; i++) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.6
    const speed = 5 + Math.random() * 7 + level * 1.4
    particles.push({
      type: 'star',
      x: originX,
      y: originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 5 + Math.random() * 6,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.24,
      color: pick(['#facc15', '#fde68a', '#ffffff', '#a855f7']),
      life: 1,
      decay: 0.009 + Math.random() * 0.006,
    })
  }

  // 光环冲击波：一次放大的圆环，是"这一下很重"的信号
  const rings = level >= 2 ? [{ r: 12, alpha: 0.75, speed: 11 + level * 3 }] : []

  const gravity = 0.34
  const drag = 0.988
  let raf = 0
  let teardown = () => {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    canvas.remove()
  }

  function frame() {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)

    // 光环
    for (const ring of rings) {
      if (ring.alpha <= 0) continue
      ring.r += ring.speed
      ring.alpha -= 0.022
      ctx.beginPath()
      ctx.arc(originX, originY, ring.r, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(168, 85, 247, ${Math.max(0, ring.alpha)})`
      ctx.lineWidth = 3
      ctx.stroke()
    }

    let alive = 0
    for (const p of particles) {
      if (p.life <= 0) continue
      p.vy += gravity
      p.vx *= drag
      p.vy *= drag
      p.x += p.vx
      p.y += p.vy
      p.rot += p.vr
      p.life -= p.decay
      // 掉出屏幕就别再画了
      if (p.y - 40 > window.innerHeight || p.x < -60 || p.x > window.innerWidth + 60) {
        p.life = 0
        continue
      }
      alive++

      ctx.save()
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life))
      ctx.translate(p.x, p.y)
      ctx.rotate(p.rot)
      ctx.fillStyle = p.color
      if (p.type === 'star') {
        starPath(ctx, p.size)
        ctx.fill()
      } else {
        // 纸屑：画成有厚度的长条，旋转起来才看得出翻面
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * (0.4 + 0.6 * Math.abs(Math.cos(p.rot))))
      }
      ctx.restore()
    }

    if (alive > 0 || rings.some((r) => r.alpha > 0)) {
      raf = requestAnimationFrame(frame)
    } else {
      teardown()
      if (activeTeardown === teardown) activeTeardown = null
    }
  }

  activeTeardown = teardown
  raf = requestAnimationFrame(frame)
  return teardown
}

/** 里程碑：只有这些数字才配得上大特效（连对 3 就爆太廉价了） */
export const STREAK_MILESTONES = [5, 10, 20, 30, 50]

/**
 * 连对 → 特效等级。
 * 5 连 1 级、10 连 2 级、20 连及以上 3 级。
 */
export function streakLevel(streak) {
  if (streak >= 20) return 3
  if (streak >= 10) return 2
  if (streak >= 5) return 1
  return 0
}
