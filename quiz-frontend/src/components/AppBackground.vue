<script setup>
/**
 * AppBackground —— 可切换的全屏背景。
 *
 * 十一种模式（由 quiz store 的 `background` 决定）：
 *   none     什么都不画（默认）—— 最省电，看题最清楚
 *   aurora   纯 CSS 渐变极光 —— 几乎零开销，动效交给 GPU 合成
 *   aurora2  纯 CSS 帘幕极光「极光·帘」—— 竖向光帘（2026-10-08 新增）
 *   stars    Canvas 星点 —— 缓慢漂移 + 偶发闪烁
 *   sparkles Canvas 星光粒子 —— 强呼吸/爆闪的碎星（2026-10-08 新增）
 *   wavy     Canvas 波浪 —— 多条正弦波横向流动（2026-10-08 新增）
 *   webgl    片元着色器星云 —— 流动的云雾
 *   silk     片元着色器丝缎 —— 域扭曲出来的布料褶皱与光带（2026-10-07 新增）
 *   vortex   片元着色器旋涡「旋涡」—— 极坐标差速旋转卷出的旋臂（2026-10-08 新增）
 *   blackhole 片元着色器黑洞「黑洞」—— 引力透镜的亮环 + 全黑视界（2026-10-08 新增）
 *   neural   Canvas 神经网络连线「神经网」—— 节点漂浮 + 距离衰减的连线（2026-10-08 新增）
 *
 * 2026-10-08 新增的模式（sparkles / wavy / aurora2 / vortex / blackhole / neural）
 * 的视觉思路参考了 Inspira UI（MIT，https://github.com/unovue/inspira-ui ）里同名的
 * 背景组件。只借"要什么效果"这个想法，**代码全部自己写**：那边是 Tailwind + Vue
 * 组件，本项目是纯 scoped CSS + CSS 变量 + 手写 canvas 2D / GLSL，抄过来一行都用不了。
 *
 * 几条必须守住的规矩：
 *   1. **pointer-events: none** —— 背景绝不能挡住点击
 *   2. 尊重 `prefers-reduced-motion` —— 前庭敏感的人会被满屏动效搞晕
 *   3. 页面切到后台（visibilitychange）就停掉动画，别白烧电
 *   4. WebGL 拿不到上下文时**回落成 aurora**，而不是留一块黑
 *
 * ────────────────────────────────────────────────────────────────────
 * 2026-10-07 修：**"开了跟没开一样"**
 *
 * 用户反馈背景看不出效果。查下来不是着色器不好，是被自己压掉了：
 *   · 着色器 alpha = (0.12 + 0.30*n) * intensity → 上限 0.42，默认强度 0.6 → 实际 ~0.25
 *   · 上面还盖着 `.q-bg__veil`：`color-mix(bg 62%, transparent)`，又压掉六成
 * 两层相乘，最终可见度只剩一成左右 —— 等于没开。
 *
 * 现在改成：
 *   · alpha 提到 (0.28 + 0.52*n) * intensity —— 满强度时"有存在感但不刺眼"
 *   · 纱从 62% 降到 34%，它的职责只是"保证正文对比度"，不该替用户做审美决定
 *   · 暗色主题的纱同样处理（原来 52%）
 * 强度滑杆的语义因此变准了：**50% 已经看得出来，100% 是很明显**。
 * ────────────────────────────────────────────────────────────────────
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import { useQuizStore } from '@/stores/quiz'

const quiz = useQuizStore()
const mode = computed(() => quiz.settings.background || 'none')
const intensity = computed(() => Number(quiz.settings.backgroundIntensity ?? 0.6))

const canvasRef = ref(null)

/** 用户是不是要求"少动效" */
const reduceMotion =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false

/** 用 WebGL 的四个模式；拿不到上下文时回落成 aurora，不留黑屏 */
const GL_MODES = ['webgl', 'silk', 'vortex', 'blackhole']
/**
 * 用 canvas 2D 的模式。
 * ⚠️ 集中成一张表，是因为 start / loop / resize / onVisibility 四处都要判"是不是
 *    canvas 模式"，早先散着写 `=== 'stars'`，加一个模式就得改四处、漏一处就白屏。
 */
const CANVAS2D_MODES = ['stars', 'sparkles', 'wavy', 'neural']

/**
 * Vanta（MIT，github.com/tengbao/vanta）的 3D 效果 —— 和上面两类**完全不同的第三条路**：
 * 效果由库自己建 canvas、自己跑 rAF、自己管 resize，我们只给它一个容器元素。
 *
 * 两条硬性约束（都是踩过之后定下来的）：
 *
 *  1. **必须懒加载**。three.js 约 600KB + 每个效果各自 10~30KB。
 *     不玩背景的人一个字节都不该付这个代价，所以 `import('three')` 写在函数里、
 *     六个效果各写一个 import()（分开写才会各自切 chunk）。
 *
 *  2. **开了「减少动态效果」时不用它**。Vanta 的效果本质就是"一直动"，
 *     **没有"画一帧停住"这个接口** —— 硬要停只能去 hack 它的内部 rAF。
 *     所以这种情况下退回 `aurora2`（纯 CSS 的静态帘幕）。
 *     同一条原则：**宁可不那么华丽，也绝不能一片空白** ——
 *     之前正是"直接不画"导致了用户看到全白。
 */
/**
 * ⚠️ 不是 Vanta 的每个效果都能跟**现代 three** 一起用 —— 这一条是实测出来的：
 * Vanta 0.5.24 是 three r134 时代的产物，而这里装的是 three 0.186，
 * 中间删过不少 API。我逐个试过它的 11 个效果：
 *
 *   能用且**稳定可见**（实测三次几乎一致）：waves 53% / fog 52% / clouds 50% / cells 57%
 *   能用但**偏淡**（10.4%，留着当"几乎无感"的选项）：net
 *   起不来（都实测报错，已剔除）：
 *     birds   → TypeError: L is not a constructor（GPGPU 那套）
 *     dots    → 读不到 three 的相机类（undefined）
 *     topology→ TypeError: b is not a constructor
 *     trunk   → TypeError: b is not a constructor
 *   能起来但**不稳定 / 太淡**（也剔除了）：
 *     halo    → "脉冲"式：光环随动画周期胀缩，相位不对时整屏 0.0% 差异
 *               （同一份代码别的时候能到 25.9%）
 *     rings   → 稳定但只有 4.7%~5.1%，低于"看得见"的线
 *               背景"有时看得见有时看不见"、或者"开了跟没开一样"，
 *               都比不给这个选项更糟。
 *
 * 注：上面的报错原文里本来有具体类名，这里故意不照抄 ——
 * `quiz/tools/check_sfc.mjs` **不剥注释**，注释里的大写标识符会被当成组件名报错
 * （这个坑交接文档里记过，我还是踩了一次）。
 */
const VANTA_MODES = ['vanwaves', 'vanfog', 'vanclouds', 'vannet', 'vancells']

const VANTA_LOADERS = {
  vanwaves: () => import('vanta/dist/vanta.waves.min.js'),
  vanfog: () => import('vanta/dist/vanta.fog.min.js'),
  vanclouds: () => import('vanta/dist/vanta.clouds.min.js'),
  vannet: () => import('vanta/dist/vanta.net.min.js'),
  vancells: () => import('vanta/dist/vanta.cells.min.js'),
}

/**
 * 每个 Vanta 效果额外乘的透明度（见 .q-bg__vanta 的注释）。
 *
 * 为什么**必须按效果分别给**：Vanta 的效果铺满整屏且不透明，但**浓淡差得很远** ——
 * 细胞/云海/迷雾/海浪几乎是实心画面，而网格/光环只有几条细线。
 * 一刀切乘 0.5 的实测结果：浓的刚好（50%+），淡的**直接归零**
 * （网格 7.2% → 0.6%、光环 25.9% → 0.0%）。
 */
const VANTA_OPACITY = {
  vanwaves: 0.5,
  vanfog: 0.5,
  vanclouds: 0.5,
  vancells: 0.55,
  vannet: 1,
}

/**
 * 每个效果的参数。**颜色必须跟着主题走**：Vanta 的效果大多要一个不透明的
 * 背景色，默认是深色 —— 直接用在浅色主题上就是一块黑板。
 * 所以做成函数：读当前主题，返回对应的一套颜色（色值和 theme.css 对齐）。
 */
function vantaOptions(mode, dark) {
  const bg = dark ? 0x0e1016 : 0xf4f6fb
  const brand1 = 0x6366f1
  const brand2 = 0x8b5cf6
  const brand3 = 0xec4899
  /*
   * ⚠️ 底色**不能直接用页面的背景色**，这是实测踩出来的：
   * Vanta 的效果会随动画周期"起伏"—— 海浪平静的那一刻、云散开的那一刻，
   * 整屏就等于它的底色。底色如果正好是页面底色，那一瞬间**看起来就是没开**
   * （实测同一份代码：海浪 49.8% ↔ 1.5%、云海 49.9% ↔ 8.1%，只看相位）。
   * 所以统一给一层很淡的品牌色（indigo-50/100 那种），
   * 让"平静时刻"也始终和页面底色有色差 —— 背景不该有时看得见有时看不见。
   */
  const tint = dark ? 0x1b2135 : 0xe9ecfb
  // 关掉鼠标/陀螺仪交互：背景是 pointer-events:none，本来就收不到事件，
  // 开着只会让它白监听
  //
  // `scale: 1` 是必须显式给的：fog / clouds 默认按 0.5 / 0.33 的倍率建画布
  // （实测 1280×800 的视口只建出 640×400 / 426×266 的画布，放大到全屏就是糊的）。
  const base = { mouseControls: false, touchControls: false, gyroControls: false, scale: 1 }
  switch (mode) {
    case 'vanwaves':
      // 海面颜色也别用页面底色，否则平潮时整屏一片白。
      // ⚠️ 深色主题下尤其要注意：一开始深浅两套都用了很暗的色，
      //    结果深色主题上"深色的海"贴着"深色的页" —— 实测差量只有 0.1%，
      //    等于没开（shoot.py 恰好是深色主题跑的，就是它把这个抓出来的）。
      //    所以深色主题反而要用**比页面底色亮**的色。
      return { ...base, color: dark ? 0x7c8cf0 : 0xc7d2fe, shininess: 38, waveHeight: 17, waveSpeed: 0.85, zoom: 0.82 }
    case 'vanfog':
      return {
        ...base,
        baseColor: tint,
        lowlightColor: dark ? 0x4f46e5 : brand1,
        midtoneColor: brand2,
        highlightColor: brand3,
        blurFactor: 0.72,
        speed: 1.3,
        zoom: 0.85,
      }
    case 'vanclouds':
      return {
        ...base,
        backgroundColor: tint,
        skyColor: dark ? 0x3b2f7a : 0xa5b4fc,
        cloudColor: dark ? 0x8b5cf6 : 0x8b5cf6,
        speed: 0.8,
      }
    case 'vannet':
      // ⚠️ 网格默认参数在 1280×800 下几乎看不见（实测可见度 1.6%）：
      // 点是散的、连线的距离阈值又小，最后只有零星几根线。
      // 加大点数、缩小间距、放宽连线距离，底色给淡色调。
      // 深色主题下点线用**亮**靛蓝，不然贴在深底上根本看不见。
      return {
        ...base,
        color: dark ? 0x9aa8ff : brand1,
        backgroundColor: tint,
        points: 18,
        maxDistance: 36,
        spacing: 10,
        showDots: true,
      }
    case 'vancells':
      // 用柔和的靛蓝→浅紫，不用品红：它铺满整屏，饱和色会把正文压没。
      // 深色主题下同样要更亮一档，否则贴底看不见。
      return {
        ...base,
        backgroundColor: tint,
        color1: dark ? 0x93a2ff : 0x818cf8,
        color2: dark ? 0xb9a8ff : 0xa78bfa,
        size: 1.5,
        speed: 1.2,
      }
    default:
      return { ...base, backgroundColor: tint }
  }
}

const webglFailed = ref(false)
const vantaFailed = ref(false)
const vantaError = ref('')
/** 当前主题（Vanta 的颜色是创建时写死的，主题一换必须重建效果） */
const isDark = ref(
  typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
)

/**
 * 最终真正生效的模式 —— 所有"降级"都收敛在这一个地方。
 *   ① 开了少动效 + 选了 Vanta → 退回 aurora2（Vanta 没有定格接口）
 *   ② WebGL / Vanta 起不来 → 退回 aurora
 * 把判断集中在这里，模板和 start() 只认 effective，不用各自记得处理降级。
 */
const effective = computed(() => {
  if (VANTA_MODES.includes(mode.value) && reduceMotion) return 'aurora2'
  if (GL_MODES.includes(mode.value) && webglFailed.value) return 'aurora'
  if (VANTA_MODES.includes(mode.value) && vantaFailed.value) return 'aurora'
  return mode.value
})

/* ------------------------------------------------------------------ *
 * Canvas / WebGL 的公共生命周期
 * ------------------------------------------------------------------ */
let raf = 0
let gl = null
let starField = null
let sparkleField = null
let waveField = null
let neuralField = null
let startedAt = 0
let running = false

function stop() {
  running = false
  if (raf) {
    cancelAnimationFrame(raf)
    raf = 0
  }
}

function onVisibility() {
  if (document.hidden) stop()
  else if (GL_MODES.includes(effective.value) || CANVAS2D_MODES.includes(effective.value)) start()
  // Vanta 不在这里停：它自己管 rAF，而浏览器本来就会把隐藏标签页的 rAF
  // 压到几乎不跑。为省这点电去 destroy + 重建整个效果，反而更亏。
}

/* ------------------------------------------------------------------ *
 * Vanta：库自己建 canvas / 跑 rAF / 管 resize，我们只给容器
 * ------------------------------------------------------------------ */
const vantaHost = ref(null)
let vantaEffect = null
/** 每次挂载自增，用来作废"加载到一半用户又换了模式"的那一发 */
let vantaToken = 0
/** 盯着 <html class> —— 主题一换 Vanta 必须重建（颜色写死在创建时） */
let themeObserver = null

function destroyVanta() {
  vantaToken++ // 作废在途的挂载
  if (vantaEffect) {
    try {
      vantaEffect.destroy()
    } catch {
      /* 销毁失败不该影响切模式 */
    }
    vantaEffect = null
  }
}

async function mountVanta(target) {
  destroyVanta()
  const host = vantaHost.value
  if (!host) return
  const token = vantaToken
  try {
    // 两个 import 并行：three 是共享 chunk（第一个 Vanta 模式拉一次，之后命中缓存）
    const [threeMod, effectMod] = await Promise.all([import('three'), VANTA_LOADERS[target]()])
    if (token !== vantaToken) return // 期间换了模式，这一发作废
    const THREE = threeMod.default || threeMod
    const factory = effectMod?.default || effectMod
    if (typeof factory !== 'function') throw new Error('Vanta 模块没有导出可调用对象')
    vantaEffect = factory({ el: host, THREE, ...vantaOptions(target, isDark.value) })
    vantaFailed.value = false
    vantaError.value = ''
  } catch (error) {
    // 起不来就交给 effective 退回 aurora，别留一块黑
    vantaError.value = String(error?.message || error)
    vantaFailed.value = true
  }
}

/** 主题变了要重建：Vanta 的颜色是创建时写死的，没有"换配色"的接口 */
function onThemeChange() {
  const next = document.documentElement.classList.contains('dark')
  if (next === isDark.value) return
  isDark.value = next
  if (VANTA_MODES.includes(effective.value)) mountVanta(effective.value)
}

/* ------------------------------------------------------------------ *
 * stars：自己写的小星场（不引库）
 * ------------------------------------------------------------------ */
function initStars(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = (canvas.width = window.innerWidth * dpr)
  const h = (canvas.height = window.innerHeight * dpr)
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  // ⚠️ 密度和大小踩过坑：原来 26000 一档、半径 0.3~1.4px，
  //    实测在 1280×800 里只占 0.05% 的像素 —— 等于"看不见"。
  //    现在密得多、也大一点，并且**分层**：大部分是小的，
  //    少数几颗大的当"亮星"，这样才像星空而不是噪点。
  const count = Math.min(Math.round((w * h) / (9000 * dpr)), 700)
  const stars = Array.from({ length: count }, () => {
    const big = Math.random() < 0.12
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      r: (big ? Math.random() * 1.5 + 1.5 : Math.random() * 0.8 + 0.5) * dpr,
      // 每颗星一个自己的相位/速度，避免整片一起闪（那看起来像卡了）
      phase: Math.random() * Math.PI * 2,
      speed: Math.random() * 0.0006 + 0.0002,
      drift: (Math.random() - 0.5) * 0.05 * dpr,
      warm: Math.random() < 0.25, // 少数偏暖色，整片单色会显得很假
    }
  })
  return { ctx: canvas.getContext('2d'), stars, w, h, dpr }
}

function drawStars(now) {
  if (!starField) return
  const { ctx, stars, w, h } = starField
  ctx.clearRect(0, 0, w, h)
  for (const s of stars) {
    s.y += s.drift
    if (s.y < 0) s.y = h
    if (s.y > h) s.y = 0
    const twinkle = reduceMotion ? 0.8 : 0.55 + 0.45 * Math.abs(Math.sin(now * s.speed + s.phase))
    ctx.globalAlpha = Math.min(1, twinkle * (0.55 + 0.65 * intensity.value))
    ctx.fillStyle = s.warm ? '#ffe6c7' : '#dbe4ff'
    ctx.beginPath()
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

/* ------------------------------------------------------------------ *
 * sparkles：星光粒子
 *
 * 和 stars 的差别（不然就是同一个模式换个名字）：
 *   1. **动态范围更大** —— 每颗星有自己的"底色亮度 base"和"呼吸幅度 amp"，
 *      再加一条慢速包络做**偶发爆闪**（flare）。stars 是全屏统一在 0.55~1.0
 *      之间晃，sparkles 是"大部分时间很暗、偶尔一下很亮"。
 *   2. **不只是点** —— 大亮点额外叠一张预渲染的光晕贴图（halo），
 *      并且整片再压一层很淡的径向渐变底色（CSS `::before`，见 <style>）。
 *      纯点阵放在浅色页面上看着就是噪点，这层底色是"氛围"的来源。
 *
 * 性能上的一个取舍：光晕**不**每帧 createRadialGradient（60fps × 几十次 =
 * 每秒几千个渐变对象，GC 会抖），而是启动时按调色板预渲染成小 canvas，
 * 之后只 drawImage 缩放 —— 这是 canvas 2D 里最便宜的软光晕做法。
 * ------------------------------------------------------------------ */
const SPARKLE_PALETTE = ['#c7d2fe', '#ddd6fe', '#fbcfe8', '#ffffff']

/** 预渲染一张带颜色的软光晕贴图（64px 够用，缩放交给 drawImage） */
function makeGlowSprite(color, dpr) {
  const size = Math.max(16, Math.round(64 * dpr))
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const g = c.getContext('2d')
  const r = size / 2
  const grd = g.createRadialGradient(r, r, 0, r, r, r)
  // 中心实、边缘透明；中间多给一档 0.5，光晕才不会像一块圆饼
  grd.addColorStop(0, color)
  grd.addColorStop(0.12, color)
  grd.addColorStop(0.5, 'rgba(255,255,255,0.001)')
  grd.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, size, size)
  return c
}

function initSparkles(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = (canvas.width = window.innerWidth * dpr)
  const h = (canvas.height = window.innerHeight * dpr)
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  // 密度比 stars 略稀：每颗都带光晕，太密会糊成一片白
  const count = Math.min(Math.round((w * h) / (10000 * dpr)), 620)
  const sparks = Array.from({ length: count }, () => {
    const big = Math.random() < 0.1 // 10% 是大亮点，其余都是小暗点 —— 这就是"分层"
    const color = SPARKLE_PALETTE[(Math.random() * SPARKLE_PALETTE.length) | 0]
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      // ⚠️ 小星半径别低于 ~0.6px：第一版给到 0.45px，在 dpr=1 的屏幕上
      //    亚像素渲染会把它摊成几乎全透明 —— 实测整屏只有零星几个点看得见。
      r: (big ? Math.random() * 1.6 + 2.0 : Math.random() * 0.7 + 0.65) * dpr,
      big,
      color,
      // 每颗一个独立的相位/频率：整片同步闪会让人以为是掉帧
      phase: Math.random() * Math.PI * 2,
      speed: Math.random() * 0.0012 + 0.0004,
      // base 低、amp 高 → 明暗差拉得开，才有"闪"的感觉
      base: Math.random() * 0.26 + 0.10,
      amp: Math.random() * 0.45 + 0.55,
      // 慢速包络 + 高次幂 = 大部分时间不动声色、偶尔爆一下
      flareSpeed: Math.random() * 0.00035 + 0.00008,
      flarePhase: Math.random() * Math.PI * 2,
      // 只有一部分会飘，全都在动会像下雪
      driftX: Math.random() < 0.35 ? (Math.random() - 0.5) * 0.09 * dpr : 0,
      driftY: Math.random() < 0.35 ? (Math.random() - 0.5) * 0.07 * dpr : 0,
    }
  })
  const ctx = canvas.getContext('2d')
  // 调色板去重后各预渲染一张光晕，只给大亮点用
  const glows = new Map()
  for (const c of new Set(SPARKLE_PALETTE)) glows.set(c, makeGlowSprite(c, dpr))
  return { ctx, sparks, w, h, dpr, glows }
}

function drawSparkles(now) {
  if (!sparkleField) return
  const { ctx, sparks, w, h, glows } = sparkleField
  ctx.clearRect(0, 0, w, h)
  /*
   * `lighter`（加色）而不是默认的 source-over：光点叠在一起时会互相"点亮"，
   * 这是星光该有的样子。因为背景层最终是按 alpha 合成到页面上的，加色把
   * alpha 也一起加上去，重叠处会更实 —— 正好也是我们想要的。
   */
  ctx.globalCompositeOperation = 'lighter'
  const k = 0.35 + 0.75 * intensity.value // 强度滑杆的落点
  for (const s of sparks) {
    if (!reduceMotion) {
      s.x += s.driftX
      s.y += s.driftY
      // 从另一边绕回来，避免所有星慢慢全飘出屏幕
      if (s.x < -4) s.x = w + 4
      else if (s.x > w + 4) s.x = -4
      if (s.y < -4) s.y = h + 4
      else if (s.y > h + 4) s.y = -4
    }
    const t = now
    // 呼吸：0~1，pow 让"亮"的那一段更短，观感上更接近一闪一闪
    const breath = Math.pow(0.5 + 0.5 * Math.sin(t * s.speed + s.phase), 1.7)
    // 爆闪：6 次幂 → 只有包络接近 1 的极短时间才亮，其余时间≈0
    const flare = reduceMotion ? 0 : Math.pow(0.5 + 0.5 * Math.sin(t * s.flareSpeed + s.flarePhase), 6)
    let a = (s.base + s.amp * breath + flare * 0.85) * k
    if (a > 1) a = 1
    if (a <= 0.012) continue // 太暗的直接跳过，省绘制

    if (s.big || flare > 0.35) {
      // 光晕半径随亮度长大 —— 亮的时候"晕开"，这就是 sparkles 的灵魂。
      // 小星只在爆闪（flare 高）时也给一次光晕，否则"闪"只发生在大星上，
      // 整片看起来还是静态的。
      const R = s.r * (6 + 9 * Math.min(1, a))
      ctx.globalAlpha = Math.min(1, a * 0.5)
      ctx.drawImage(glows.get(s.color), s.x - R, s.y - R, R * 2, R * 2)
    }
    ctx.globalAlpha = a
    ctx.fillStyle = s.color
    ctx.beginPath()
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
}

/* ------------------------------------------------------------------ *
 * wavy：波浪
 *
 * 若干条正弦波叠在一起横向流动。每条波由**两个不同频率的分量**相加而成
 * （`sin(k1*x + t) + 0.5*sin(k2*x - 1.3t)`）—— 单频正弦一眼就能看出是数学函数，
 * 两个频率拍频之后才有"水面"的松散感。
 *
 * 层次：靠后的波振幅小、位置高、颜色淡（大气透视），靠前的波振幅大、颜色实，
 * 所以从列表头到尾 alpha 递增，叠出来就有纵深。
 * 参考的是 Stripe 首页那种"渐变波浪"的观感，颜色用站点自己的品牌色系。
 * ------------------------------------------------------------------ */
/*
 * 每条的参数含义（数字都踩过一遍，注释里写清楚免得下次又要试半天）：
 *   y      基准高度，占视口高度比例 —— 靠后的波放高一点，靠前的放低一点
 *   amp    振幅（占视口高度比例）；实际位移还会乘上第二分量，最大约 ±1.5×amp
 *   len    **横跨整个视口宽度的波数**（不是弧度，也不是像素）
 *   speed  角速度，单位 rad/ms。2π/0.0005 ≈ 12.6 秒走完一个周期 ——
 *          刷题时眼角余光能看出"在动"，但不会把注意力拽走
 *   alpha  描边透明度；整条列表从头到尾递增 = 从远到近
 */
const WAVE_STROKES = [
  { color: '#6366f1', y: 0.38, amp: 0.030, len: 1.10, speed: 0.00042, alpha: 0.20, width: 2.0 },
  { color: '#8b5cf6', y: 0.50, amp: 0.038, len: 0.75, speed: -0.00036, alpha: 0.27, width: 2.4 },
  { color: '#ec4899', y: 0.59, amp: 0.032, len: 1.45, speed: 0.00052, alpha: 0.24, width: 2.2 },
  { color: '#6366f1', y: 0.70, amp: 0.046, len: 0.95, speed: -0.00030, alpha: 0.34, width: 2.8 },
  { color: '#8b5cf6', y: 0.82, amp: 0.052, len: 0.62, speed: 0.00046, alpha: 0.42, width: 3.2 },
]

function initWaves(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = (canvas.width = window.innerWidth * dpr)
  const h = (canvas.height = window.innerHeight * dpr)
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  const ctx = canvas.getContext('2d')
  // 每条波再随机一个相位偏移，否则五条波在 x=0 处全部同相，会出现一条竖直的"接缝"
  const waves = WAVE_STROKES.map((s) => ({ ...s, phase: Math.random() * Math.PI * 2 }))
  return { ctx, waves, w, h, dpr }
}

/**
 * 第 i 条波在 x 处的高度。
 * ⚠️ `p` 必须按**视口宽度**归一化后乘 2π —— 一开始我按高度归一化，
 *    结果 2560px 宽只走了 1.4 弧度，屏幕上是一根几乎水平的直线，
 *    "波浪"两个字完全看不出来。现在 len 直接就是"横跨屏幕几个波"。
 */
function waveY(wave, x, h, w, t) {
  const p = (x / w) * wave.len * Math.PI * 2
  const a = Math.sin(p + t * wave.speed + wave.phase)
  // 第二个分量：频率不是整数倍、速度还反向 —— 两个频率"拍"起来才像水面
  const b = 0.5 * Math.sin(p * 2.17 - t * wave.speed * 1.35 + wave.phase * 1.7)
  return h * wave.y + h * wave.amp * (a + b)
}

function drawWaves(now) {
  if (!waveField) return
  const { ctx, waves, w, h, dpr } = waveField
  ctx.clearRect(0, 0, w, h)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  const t = reduceMotion ? 0 : now
  for (const wave of waves) {
    // 步长 6px（设备像素）：再密看不出区别，再稀折线会露角
    const step = 6 * dpr
    ctx.beginPath()
    for (let x = -step; x <= w + step; x += step) {
      const y = waveY(wave, x, h, w, t)
      if (x <= -step) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    // 先描一条又宽又淡的当"辉光"，再描本体 —— 比 shadowBlur 便宜得多：
    // shadowBlur 在近 500 个点的长路径上每帧要几十毫秒，会把动画拖成幻灯片
    ctx.globalAlpha = wave.alpha * 0.5 * intensity.value
    ctx.lineWidth = wave.width * 4 * dpr
    ctx.strokeStyle = wave.color
    ctx.stroke()
    ctx.globalAlpha = Math.min(1, wave.alpha * (0.6 + 0.7 * intensity.value))
    ctx.lineWidth = wave.width * dpr
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

/* ------------------------------------------------------------------ *
 * neural：神经网络连线「神经网」
 *
 * 思路参考 Inspira UI（MIT，https://github.com/unovue/inspira-ui ）里同名的
 * 「Neural Network」背景组件：一堆节点缓慢漂浮，离得近的两个之间连一条线，
 * **线的透明度随距离衰减**。代码自己写（那边是 Vue + SVG/Tailwind）。
 *
 * 三个实现上的决定，都是踩过才写下来的：
 *
 * 1. **不做鼠标交互。** 这个组件挂着 `pointer-events: none`（背景绝不能吃点击，
 *    见文件顶部第 1 条），鼠标事件根本收不到。与其为了"节点跟着鼠标动"去偷偷
 *    打开 pointer-events，不如老老实实做自发漂移 —— 规矩比花活重要。
 *
 * 2. **连线按"亮度档 × 颜色"分桶，一桶一条路径。** 朴素写法是每条连线一次
 *    beginPath/stroke；90 个节点两两配对约 4000 条，再加一层辉光就是 8000 次
 *    stroke/帧，这不是"稍微慢一点"，是直接掉成幻灯片。现在把线按亮度分成
 *    NEURAL_BUCKETS 档、再按 3 种颜色分开，最多 18 条路径，每帧只 stroke 36 次。
 *    线的亮度本来就是连续渐变的，量化到 6 档肉眼看不出来（线很细）。
 *
 * 3. **漂移速度压在 ~3px/s（0.05 设备像素/帧）。** 这是刷题背景，眼角余光里
 *    "在动"就够；动快了会把人从题目上拽走。
 * ------------------------------------------------------------------ */
const NEURAL_PALETTE = ['#6366f1', '#8b5cf6', '#ec4899']
/** 亮度分档数：档太多就退化成逐条描边，档太少远处的线会"啪"地跳一档 */
const NEURAL_BUCKETS = 6

function initNeural(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = (canvas.width = window.innerWidth * dpr)
  const h = (canvas.height = window.innerHeight * dpr)
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  // 节点数按面积定（大屏不至于稀稀拉拉），夹在 60~90：
  // 再多人眼也数不清，只会让两两配对的检查和连线糊成一片。
  // 别用 4000 这种小屏才够的固定值 —— stars 那次的教训就是密度按常量给，
  // 到 1280×800 上只剩几个点。
  const count = Math.min(90, Math.max(60, Math.round((w * h) / (13000 * dpr))))
  const nodes = Array.from({ length: count }, (_, i) => ({
    x: Math.random() * w,
    y: Math.random() * h,
    vx: (Math.random() - 0.5) * 0.05 * dpr,
    vy: (Math.random() - 0.5) * 0.05 * dpr,
    // 半径别小于 ~1.7px：亚像素的小点会被浏览器摊成几乎全透明（stars 踩过）
    r: (Math.random() * 1.3 + 1.7) * dpr,
    // 颜色按索引取而不是随机：随机会扎堆，一片全是紫的就没了"网络"的层次
    color: NEURAL_PALETTE[i % NEURAL_PALETTE.length],
    ci: i % NEURAL_PALETTE.length,
    // 每个节点自己的呼吸相位，整片同频会像在闪屏
    phase: Math.random() * Math.PI * 2,
    speed: Math.random() * 0.0007 + 0.00025,
  }))
  // 连线阈值 = 短边的一个比例。太大整屏蜘蛛网、太小一杯散点。
  // ⚠️ 0.24 是"看着刚好"但**默认 60% 强度下实测只有 5.8% 的像素明显不同**
  //    （踩线过关，稍微降一点强度就等于看不见）。0.27 让每个节点多约 2 条连线，
  //    实测抬到 8% 以上，观感上也只是略密一点，没有变成蜘蛛网。
  const maxDist = Math.min(w, h) * 0.27
  const ctx = canvas.getContext('2d')
  // 节点光晕复用 sparkles 那套预渲染贴图（每帧 createRadialGradient 会 GC 抖动）
  const glows = new Map()
  for (const c of NEURAL_PALETTE) glows.set(c, makeGlowSprite(c, dpr))
  return { ctx, nodes, w, h, dpr, maxDist, glows }
}

/** 把一批 [x1,y1,x2,y2] 攒成一条路径一次描边 —— 这就是"分桶"省下来的开销 */
function strokeSegments(ctx, seg) {
  ctx.beginPath()
  for (let i = 0; i < seg.length; i += 4) {
    ctx.moveTo(seg[i], seg[i + 1])
    ctx.lineTo(seg[i + 2], seg[i + 3])
  }
  ctx.stroke()
}

function drawNeural(now) {
  if (!neuralField) return
  const { ctx, nodes, w, h, dpr, maxDist, glows } = neuralField
  ctx.clearRect(0, 0, w, h)
  const t = reduceMotion ? 0 : now

  // 先漂移、再连线：同一帧里"点"和"线"用的是同一份坐标，线才不会追不上点。
  // 越界后从对边绕回来（留一点 pad 让节点可以部分出屏），否则密度会慢慢
  // 全挤到角落里去
  const pad = maxDist * 0.35
  if (!reduceMotion) {
    for (const n of nodes) {
      n.x += n.vx
      n.y += n.vy
      if (n.x < -pad) n.x = w + pad
      else if (n.x > w + pad) n.x = -pad
      if (n.y < -pad) n.y = h + pad
      else if (n.y > h + pad) n.y = -pad
    }
  }

  // ⚠️ 强度映射的基线给到 0.7（星星/波浪那边是 0.35~0.45）：细线本来就"省墨"，
  //    照搬那些模式的系数会让默认 60% 强度下的可见度只剩 5% 上下 ——
  //    量出来才知道，靠眼睛看全屏截图是看不出来的。
  const k = 0.7 + 0.7 * intensity.value
  const maxD2 = maxDist * maxDist
  const buckets = new Map()
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]
      const dx = a.x - b.x
      const dy = a.y - b.y
      const d2 = dx * dx + dy * dy
      if (d2 >= maxD2) continue // 先比平方，省掉每对的 sqrt
      // 透明度随距离衰减：线性太"匀"（远处的线还留着一截看得见的灰），
      // 平方又掉得太快（只剩最近那几条）。0.8 次方是试出来的折中。
      const f = Math.pow(1 - Math.sqrt(d2) / maxDist, 0.8)
      let bi = (f * NEURAL_BUCKETS) | 0
      if (bi >= NEURAL_BUCKETS) bi = NEURAL_BUCKETS - 1
      const key = bi * NEURAL_PALETTE.length + a.ci
      let seg = buckets.get(key)
      if (!seg) {
        seg = []
        buckets.set(key, seg)
      }
      seg.push(a.x, a.y, b.x, b.y)
    }
  }

  // 加色混合：连线交叉处会互相"点亮"，像真的在放电；也省得去算交点的颜色
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'
  ctx.strokeStyle = '#ffffff'
  for (const [key, seg] of buckets) {
    const color = NEURAL_PALETTE[key % NEURAL_PALETTE.length]
    // 档内取中点当这一档的代表亮度，6 档才够连成一条平滑的衰减曲线
    const bright = (((key / NEURAL_PALETTE.length) | 0) + 0.5) / NEURAL_BUCKETS
    ctx.strokeStyle = color
    ctx.globalAlpha = Math.min(1, bright * bright * 0.30 * k) // 辉光层：宽而淡
    ctx.lineWidth = 4.0 * dpr
    strokeSegments(ctx, seg)
    ctx.globalAlpha = Math.min(1, bright * 0.82 * k) // 本体：细而实
    ctx.lineWidth = 1.25 * dpr
    strokeSegments(ctx, seg)
  }

  // 节点：光晕 + 实心点，跟 sparkles 一样的两层结构
  for (const n of nodes) {
    const pulse = reduceMotion ? 0.85 : 0.7 + 0.3 * Math.sin(t * n.speed + n.phase)
    const a = Math.min(1, (0.45 + 0.55 * pulse) * k)
    const R = n.r * (5.5 + 3 * pulse)
    ctx.globalAlpha = Math.min(1, a * 0.50)
    ctx.drawImage(glows.get(n.color), n.x - R, n.y - R, R * 2, R * 2)
    ctx.globalAlpha = a
    ctx.fillStyle = n.color
    ctx.beginPath()
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
}

/* ------------------------------------------------------------------ *
 * WebGL 公共部分：几个片元着色器共用顶点着色器和噪声函数
 * ------------------------------------------------------------------ */
const VERT = `
attribute vec2 pos;
void main() { gl_Position = vec4(pos, 0.0, 1.0); }
`

/** 值噪声 + fbm：便宜、够好看，且不需要任何纹理资源 */
const NOISE_GLSL = `
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; }
  return v;
}
`

/** webgl：一片缓慢流动的星云 */
const FRAG_NEBULA = `
precision mediump float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_intensity;
${NOISE_GLSL}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  vec2 p = (gl_FragCoord.xy * 2.0 - u_res.xy) / min(u_res.x, u_res.y);
  float t = u_time * 0.03;

  float n = fbm(p * 1.6 + vec2(t, -t * 0.7));
  float m = fbm(p * 2.7 + vec2(-t * 0.5, t * 0.9) + n);

  // 靛蓝 -> 紫 -> 一点点暖色，和站点主色（indigo）是一家的
  vec3 c1 = vec3(0.36, 0.39, 0.94);
  vec3 c2 = vec3(0.55, 0.30, 0.85);
  vec3 c3 = vec3(0.95, 0.55, 0.45);
  vec3 col = mix(c1, c2, smoothstep(0.25, 0.85, m));
  col = mix(col, c3, smoothstep(0.72, 1.0, n * m) * 0.45);

  // 暗角：⚠️ 这里的方向踩过坑。
  // 原来写的是"中间亮、四周压暗"（smoothstep(1.25, 0.15, len)），
  // 可实测发现最终只剩 0.1% 的像素能看出区别 —— 因为**中间被不透明的
  // 题目卡片盖住了，能露出背景的恰恰是四周**，而四周正好被我压成 0。
  // 方向刚好反了。现在只做很轻的衰减（四周保留 ~55%），
  // 让"看得见的地方"有东西可看。
  float vig = 1.0 - 0.45 * smoothstep(0.75, 1.75, length(p));
  col *= vig;

  // 底色，不是主体：压暗到能读题，但**要看得出来**
  float a = (0.34 + 0.55 * n) * u_intensity;
  gl_FragColor = vec4(col, a * vig);
}
`

/**
 * silk：丝缎。
 *
 * 思路（公开的常规做法，不依赖任何第三方代码）：两次**域扭曲**（用 fbm 去偏移
 * 采样坐标）把一层斜向正弦"条带"揉皱，得到布料那种连续的褶皱；再把条带接近
 * 峰值的窄区间提出来当**光带**（高光），并按位置混一点暖色。
 *
 * 和星云的区别：星云是"随机云雾"，丝缎是**有条理的方向感**，
 * 所以看起来更像"一块布在缓慢流动"，适合当刷题时的背景 —— 不抢注意力但有质感。
 */
const FRAG_SILK = `
precision mediump float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_intensity;
${NOISE_GLSL}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  vec2 p = (gl_FragCoord.xy * 2.0 - u_res.xy) / min(u_res.x, u_res.y);
  float t = u_time * 0.045;

  // 两次域扭曲：第一次给出大褶皱，第二次在小尺度上再揉一遍
  vec2 q = p * 1.05;
  float w1 = fbm(q + vec2(t * 0.7, -t * 0.5));
  float w2 = fbm(q * 1.7 + w1 * 1.4 + vec2(-t * 0.4, t * 0.6));

  // 斜向条带 + 褶皱偏移
  float bands = sin((q.x + q.y * 0.75) * 3.1 + w1 * 4.6 + w2 * 2.8);

  float body = smoothstep(-0.35, 1.0, bands);          // 布面
  float sheen = pow(smoothstep(0.45, 1.0, bands), 2.6); // 光带（窄、亮）

  vec3 deep = vec3(0.09, 0.11, 0.30);
  vec3 mid  = vec3(0.40, 0.35, 0.92);
  vec3 warm = vec3(0.90, 0.46, 0.74);

  vec3 col = mix(deep, mid, smoothstep(0.10, 0.92, body * 0.75 + w2 * 0.35));
  col = mix(col, warm, sheen * 0.60);

  // 同上：暗角别往四周压死，否则"看得见的地方"什么都看不到
  float vig = 1.0 - 0.42 * smoothstep(0.7, 1.7, length(p));
  col *= vig;

  float a = (0.32 + 0.56 * (body * 0.6 + sheen * 0.7)) * u_intensity;
  gl_FragColor = vec4(col, a * vig);
}
`

/**
 * vortex：旋涡。
 *
 * 思路参考 Inspira UI（MIT，https://github.com/unovue/inspira-ui ）里同名的
 * 「Vortex」背景组件 —— 只借"极坐标下按半径错开角度、越靠中心转得越快"这个想法，
 * 代码是自己按下面的推导写的（那边是 Tailwind + SVG/CSS，搬不过来）。
 *
 * 原理：先转到极坐标 (r, a)，然后给角度 a 加上一个 **与 r 相关的偏移**。
 * 关键就是"与 r 相关"这四个字 —— 如果所有半径都加同一个量，整体只是刚体旋转，
 * 看起来是一个转动的圆盘；只有内圈转得多、外圈转得少（差速），噪声才会被
 * 拧成一条条旋臂。1.6/(r+0.28) 就是这个差速项：r=0 时约 5.7 弧度，
 * r=1 时只剩 1.25 弧度。
 *
 * 采样完再叠第二层高频噪声：单层 fbm 的旋臂是一坨一坨的，
 * 加一层细的才有"丝缕"的质感。
 */
const FRAG_VORTEX = `
precision mediump float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_intensity;
${NOISE_GLSL}

void main() {
  vec2 p = (gl_FragCoord.xy * 2.0 - u_res.xy) / min(u_res.x, u_res.y);
  float r = length(p);
  // GLSL 的 atan(y, x) 在两点重合时也有定义（返回 0），这里不会出 NaN
  float a = atan(p.y, p.x);

  // ← 旋涡的全部秘密就在这一行：极角按"离中心多远"错开。
  // 差速旋转（内快外慢）才卷得出旋臂；u_time 那项是整体缓慢自转。
  a += 1.6 / (r + 0.28) + u_time * 0.14;

  // 拧完再转回笛卡尔坐标去采样噪声：噪声本身是"直的"，
  // 被上面那一步扭过之后就成了螺旋
  vec2 q = vec2(cos(a), sin(a)) * r;
  // ⚠️ 采样频率踩过一次坑：照 fbm(q * 2.4) 写，实测整屏是几团大色块，
  //    差速旋转只在"糊"上体现出一点拖影，完全看不出旋臂 ——
  //    差异旋转要靠**看得清的细节**才显现得出来，尺度太大的噪声会被直接抹平。
  //    4.2 让旋臂宽度落在几十像素，肉眼才能顺着看出一条条弧线。
  float n = fbm(q * 4.2);
  // 拉开对比：fbm 的输出挤在 0.5 附近，不 smoothstep 一下就没有"臂"，
  // 只有一片渐变的雾
  float arms = smoothstep(0.32, 0.78, n);
  // 第二层高频噪声（同样在扭曲过的坐标系里），给旋臂加丝缕感
  float d = fbm(q * 8.5 + n * 1.6);

  // 品牌靛蓝 → 紫 → 品红，和站点主色是一家的
  vec3 c1 = vec3(0.33, 0.36, 0.93);
  vec3 c2 = vec3(0.60, 0.34, 0.92);
  vec3 c3 = vec3(0.93, 0.30, 0.62);

  vec3 col = mix(c1, c2, arms);
  // 越靠中心越偏品红（d 再乘一个随 r 衰减的权重，中心那一圈才吃得到）
  col = mix(col, c3, smoothstep(0.50, 0.95, d * (1.0 - r * 0.6)));

  // "越靠中心越亮"：给中心叠一层芯。没有它，中心和外圈一样亮，看不出是个旋涡
  float core = 1.0 / (1.0 + r * r * 3.0);
  col *= 0.60 + 1.05 * core;

  // 暗角只轻压：⚠️ 能露出背景的恰恰是四周（中间被题目卡片盖住了），
  // 四周压死就等于整块背景白做，这条在 FRAG_NEBULA 那里已经踩过一次
  float vig = 1.0 - 0.38 * smoothstep(0.75, 1.8, r);
  col *= vig;

  // 中心同时更"实"（alpha 更大）：芯要看得见，边缘保持很淡不干扰读题
  float alpha = (0.30 + 0.62 * arms) * (0.70 + 0.65 * core) * u_intensity * vig;
  gl_FragColor = vec4(col, min(alpha, 1.0));
}
`

/**
 * blackhole：黑洞 / 引力透镜。
 *
 * 思路参考 Inspira UI（MIT）里「Black Hole」背景组件：中心一个全黑的盘，
 * 外围一圈被弯折的亮环（吸积盘），背景星点被引力拉成弧。代码自己写。
 *
 * 三个部分：
 *   1. **透镜**：把采样坐标按 0.34/(r+0.08) 往外推 —— 越靠近中心推得越远，
 *      于是"本该在视界后面的星点"被折射到视界边缘，形成一圈挤在一起的亮弧。
 *      只做径向放大像放大镜，所以再叠一个**切向**旋转项，星弧才会绕着中心打转。
 *   2. **吸积盘**：中心外一条高斯亮环。用 exp(-d²) 而不是硬边，
 *      硬边看起来像贴了一张圆环贴纸。
 *   3. **事件视界**：r < 0.28 涂成纯黑并且把 alpha 拉到接近 1 —— 这是
 *      "全黑的盘"这个要求；透明度不够的话它会被下面的页面底色透上来变成灰盘。
 */
const FRAG_BLACKHOLE = `
precision mediump float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_intensity;
${NOISE_GLSL}

void main() {
  vec2 p = (gl_FragCoord.xy * 2.0 - u_res.xy) / min(u_res.x, u_res.y);
  float r = length(p);

  // 引力透镜的强度：r→0 时 0.34/0.08 = 4.25，也就是视界附近会去采样
  // "外面很远"的位置 —— 背景星点因此被横向拉开成弧
  float lens = 0.34 / (r + 0.08);
  vec2 q = p * (1.0 + lens * 0.55);

  // 再补一点切向拖拽（真实透镜也会把像沿切向拉伸）。
  // ⚠️ GLSL ES 1.0 里 mat2 的参数是**列优先**：mat2(m00,m10,m01,m11)，
  //    所以下面这行其实是在做 -tw 的旋转，方向无所谓，能转就行。
  float tw = 0.55 / (r + 0.16) + u_time * 0.03;
  float ct = cos(tw);
  float st = sin(tw);
  q = mat2(ct, -st, st, ct) * q;

  // 被弯折的星点：fbm 取高次幂 → 只有噪声接近峰值的那一小块亮起来，
  // 这就是"一颗颗星"；坐标被上面的透镜扭过，所以它们连成了弧
  float sN = fbm(q * 6.5);
  float arc = pow(sN, 6.0) * 3.4;

  // 很淡的星云底噪：除了星弧之外还得有"物质"，否则整屏大半是空的
  float haze = fbm(q * 1.7 + vec2(0.0, u_time * 0.012));

  // 吸积盘：中心外一圈亮环。⚠️ 不能写 exp(-pow(dr, 2.0))：
  // dr 可能为负，而 GLSL 的 pow(负底数, x) 是**未定义行为**（实测会出黑块）。
  // 改成 dr*dr，结果一样还便宜。
  float dr = (r - 0.30) / 0.09;
  float ring = exp(-dr * dr);

  vec3 col = vec3(0.10, 0.12, 0.26);
  col += vec3(0.34, 0.36, 0.88) * haze * 0.95;
  col += vec3(0.88, 0.90, 1.00) * arc * 0.60;                 // 拉长的星弧
  col += vec3(0.80, 0.72, 1.00) * ring * (0.85 + 0.50 * sN);  // 亮环

  float vig = 1.0 - 0.38 * smoothstep(0.75, 1.8, r);
  col *= vig;

  float alpha = (0.30 + 0.52 * haze + 0.55 * arc + 0.45 * ring) * u_intensity * vig;

  // 事件视界：r < 0.28 涂黑、alpha 拉到 0.92。
  // ⚠️ 写成 1.0 - smoothstep(0.235, 0.285, r)，而不是把两个边界反过来写 ——
  //    GLSL 规定 edge0 >= edge1 时 smoothstep 的结果是"未定义"。
  float hole = 1.0 - smoothstep(0.235, 0.285, r);
  col = mix(col, vec3(0.0), hole);
  alpha = mix(alpha, 0.92, hole);

  gl_FragColor = vec4(col, min(alpha, 1.0));
}
`

const SHADERS = { webgl: FRAG_NEBULA, silk: FRAG_SILK, vortex: FRAG_VORTEX, blackhole: FRAG_BLACKHOLE }

function initGl(canvas, fragSrc) {
  const opts = { alpha: true, antialias: false, depth: false, powerPreference: 'low-power' }
  const context = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts)
  if (!context) return null
  const compile = (type, src) => {
    const sh = context.createShader(type)
    context.shaderSource(sh, src)
    context.compileShader(sh)
    if (!context.getShaderParameter(sh, context.COMPILE_STATUS)) {
      // 编译不过就当拿不到上下文（会回落成 aurora），别把控制台喷满
      return null
    }
    return sh
  }
  const vs = compile(context.VERTEX_SHADER, VERT)
  const fs = compile(context.FRAGMENT_SHADER, fragSrc)
  if (!vs || !fs) return null
  const prog = context.createProgram()
  context.attachShader(prog, vs)
  context.attachShader(prog, fs)
  context.linkProgram(prog)
  if (!context.getProgramParameter(prog, context.LINK_STATUS)) return null
  context.useProgram(prog)

  const buf = context.createBuffer()
  context.bindBuffer(context.ARRAY_BUFFER, buf)
  // 覆盖整个屏幕的两个三角形
  context.bufferData(
    context.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    context.STATIC_DRAW,
  )
  const loc = context.getAttribLocation(prog, 'pos')
  context.enableVertexAttribArray(loc)
  context.vertexAttribPointer(loc, 2, context.FLOAT, false, 0, 0)

  context.enable(context.BLEND)
  /*
   * ⚠️⚠️ 这一行是「背景开了跟没开一样」的**真正根因**，别再改回 blendFunc。
   *
   * `blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)` 会把**同一对系数**也用在 alpha
   * 通道上，于是目标的 alpha 变成 `a × a`（a 的平方）：
   *     60% 强度时着色器输出 a≈0.34 → 写进缓冲的 alpha 只有 0.116
   * 再被 `.q-bg__veil` 压掉三成，最终整屏与"无背景"只差 7/255 —— 肉眼当然看不出来。
   * 这是我拿放大 alpha 系数去"补偿"了半天的那个 bug。
   *
   * `blendFuncSeparate` 的第 3/4 个参数专门管 alpha 通道：
   * 用 (ONE, ONE_MINUS_SRC_ALPHA)，目标 alpha 就等于 a（初始缓冲是透明的），
   * 和 RGB 里已经乘过 a 的预乘值保持一致 —— 浏览器按预乘 alpha 合成才不会出错。
   *
   * 验证方法：脚本里另建一个 `preserveDrawingBuffer: true` 的画布跑同一套噪声，
   * `readPixels` 读回的 alpha 应当与最终合成到页面上的强度一致（见 .tmp/probe_alpha.py）。
   */
  context.blendFuncSeparate(
    context.SRC_ALPHA,
    context.ONE_MINUS_SRC_ALPHA,
    context.ONE,
    context.ONE_MINUS_SRC_ALPHA,
  )
  return {
    context,
    //: 记住这个 program 是给哪个模式编译的 —— 换模式要重新编译，不能复用
    kind: '',
    uRes: context.getUniformLocation(prog, 'u_res'),
    uTime: context.getUniformLocation(prog, 'u_time'),
    uIntensity: context.getUniformLocation(prog, 'u_intensity'),
  }
}

function resize() {
  const canvas = canvasRef.value
  if (!canvas) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  if (GL_MODES.includes(effective.value) && gl) {
    canvas.width = window.innerWidth * dpr
    canvas.height = window.innerHeight * dpr
    gl.context.viewport(0, 0, canvas.width, canvas.height)
    // ⚠️ 改 canvas.width/height 会**清空**画布。少动效时没有 rAF 循环补画，
    //    所以必须在这里立刻重画一帧 —— 否则一改窗口大小，背景就变全白。
    if (reduceMotion) drawGlStatic()
  } else if (CANVAS2D_MODES.includes(effective.value)) {
    // 尺寸变了必须重来：粒子坐标是像素级的，不重建就会挤在左上角一小块里
    init2d(effective.value, canvas)
    if (reduceMotion) drawOnce(effective.value)
  }
}

function drawGl(now, fixedSeconds = null) {
  if (!gl) return
  const { context, uRes, uTime, uIntensity } = gl
  context.uniform2f(uRes, context.drawingBufferWidth, context.drawingBufferHeight)
  // fixedSeconds 传了就按固定秒数算 —— 用来"定格"一帧静态画面
  context.uniform1f(uTime, fixedSeconds == null ? (now - startedAt) / 1000 : fixedSeconds)
  context.uniform1f(uIntensity, intensity.value)
  context.drawArrays(context.TRIANGLES, 0, 6)
}

/**
 * 少动效时的**定格帧**（着色器版）。
 *
 * ⚠️ 这里踩过一个很难发现的坑：原来写的是
 *     `if (reduceMotion) return // 着色器只能"一直算"，没法定格，那就干脆不算`
 *   —— 理由是错的。着色器当然可以只算一帧：把时间 uniform 给一个常量，
 *   画一次、**不挂 rAF**，画面就是静止的，而且一点都不费电。
 *   直接 return 的后果是：系统开了「减少动态效果」的人选 星云 / 丝缎 / 旋涡 / 黑洞
 *   **整屏一个像素都没有**（实测可见度 0.0%），而 UI 里还显示"已选中"。
 *
 * 固定秒数挑了 7.5 秒：这几个着色器都带缓慢漂移，时间不同画面构图差挺多，
 * 7.5 秒这一帧的分布比较匀、中心不会糊成一团。
 */
const GL_STATIC_SECONDS = 7.5

function drawGlStatic() {
  drawGl(0, GL_STATIC_SECONDS)
}

function loop(now) {
  if (!running) return
  if (GL_MODES.includes(effective.value) && gl) drawGl(now)
  else if (effective.value === 'stars' && starField) drawStars(now)
  else if (effective.value === 'sparkles' && sparkleField) drawSparkles(now)
  else if (effective.value === 'wavy' && waveField) drawWaves(now)
  else if (effective.value === 'neural' && neuralField) drawNeural(now)
  raf = requestAnimationFrame(loop)
}

/** 建/重建当前模式的 canvas 2D 场；GL 模式走另一条路 */
function init2d(mode, canvas) {
  if (mode === 'stars') starField = initStars(canvas)
  else if (mode === 'sparkles') sparkleField = initSparkles(canvas)
  else if (mode === 'wavy') waveField = initWaves(canvas)
  else if (mode === 'neural') neuralField = initNeural(canvas)
}

/**
 * 少动效时画**一帧静止**的。
 * 早先的做法是直接 return，结果 stars 在 reduced-motion 下只剩 CSS 底色、
 * 一颗星都没有 —— 但"静态的星点"本来就不算动效，不该被一起砍掉。
 * 呼吸/爆闪/漂移全部关掉（t 固定为 0、不累加 drift），只留一个好看的定格。
 */
function drawOnce(mode) {
  const t = 0
  if (mode === 'stars' && starField) drawStars(t)
  else if (mode === 'sparkles' && sparkleField) drawSparkles(t)
  else if (mode === 'wavy' && waveField) drawWaves(t)
  else if (mode === 'neural' && neuralField) drawNeural(t)
}

function start() {
  stop()
  // Vanta 走自己的路：它自己建 canvas、自己跑 rAF、自己管 resize，
  // 这里只负责把它起停（千万不能再去动 canvasRef，那是另一条路的东西）
  if (VANTA_MODES.includes(effective.value)) {
    mountVanta(effective.value)
    return
  }
  destroyVanta()
  const canvas = canvasRef.value
  if (!canvas || effective.value === 'none' || effective.value === 'aurora' || effective.value === 'aurora2') {
    return
  }

  if (GL_MODES.includes(effective.value)) {
    // ⚠️ 换模式必须重新编译：program 里的片元着色器是编译期固定的，
    //    直接复用会把"丝缎"画成"星云"（或反过来），而且不报错，很难查。
    if (!gl || gl.kind !== effective.value) {
      gl = initGl(canvas, SHADERS[effective.value])
      if (!gl) {
        webglFailed.value = true // 交给 effective 回落成 aurora
        return
      }
      gl.kind = effective.value
    }
    resize()
    // 少动效：画一帧定格就收工，不挂 rAF（见 drawGlStatic 上的注释）
    if (reduceMotion) {
      drawGlStatic()
      return
    }
  } else {
    // 2D 模式：reduced-motion 下只画一帧，不挂 rAF（省电，也不动）
    if (canvas.width !== Math.round(window.innerWidth * Math.min(window.devicePixelRatio || 1, 2))) {
      resize() // 画布尺寸变了才重建，避免无谓地重新随机一遍星点
    } else {
      init2d(effective.value, canvas)
    }
    if (reduceMotion) {
      drawOnce(effective.value)
      return
    }
  }
  startedAt = performance.now()
  running = true
  raf = requestAnimationFrame(loop)
}

onMounted(async () => {
  await nextTick()
  window.addEventListener('resize', resize)
  document.addEventListener('visibilitychange', onVisibility)
  // 主题切换（<html class="dark">）要能感知到：Vanta 的颜色写死在创建时，
  // 换主题必须重建效果，否则浅色主题上会出现一块深色板
  themeObserver = new MutationObserver(onThemeChange)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  start()
})

onBeforeUnmount(() => {
  stop()
  destroyVanta()
  themeObserver?.disconnect()
  themeObserver = null
  window.removeEventListener('resize', resize)
  document.removeEventListener('visibilitychange', onVisibility)
})

// 换背景模式 / 调强度都要重新来一遍
watch(effective, async () => {
  await nextTick()
  start()
})
// 用户重新选了某个 Vanta 模式 → 给失败标记一次重来的机会
// （否则上次加载失败之后，这个模式就永远是 aurora 了）
watch(mode, () => {
  if (VANTA_MODES.includes(mode.value)) {
    vantaFailed.value = false
    vantaError.value = ''
  }
})
watch(intensity, () => {
  // 有 rAF 时强度是绘制参数，下一帧自然生效。
  // ⚠️ 但少动效时**根本没有下一帧**（定格帧画完就不循环了），
  //    所以必须手动重画 —— 否则拉强度滑杆会毫无反应。
  if (reduceMotion) {
    if (GL_MODES.includes(effective.value)) drawGlStatic()
    else if (CANVAS2D_MODES.includes(effective.value)) drawOnce(effective.value)
  }
})
</script>

<template>
  <div
    class="q-bg"
    :class="[`q-bg--${effective}`, { 'q-bg--heavy': VANTA_MODES.includes(effective) }]"
    :style="{ '--q-bg-alpha': intensity }"
    aria-hidden="true"
  >
    <!-- aurora 用纯 CSS：几个大范围渐变色团缓慢漂移，交给合成器，几乎不占 CPU -->
    <div v-if="effective === 'aurora'" class="q-bg__aurora">
      <span class="q-bg__blob q-bg__blob--1"></span>
      <span class="q-bg__blob q-bg__blob--2"></span>
      <span class="q-bg__blob q-bg__blob--3"></span>
    </div>
    <!-- aurora2 也是纯 CSS，但形状完全不同：竖向帘幕，不是色团 -->
    <div v-if="effective === 'aurora2'" class="q-bg__curtain">
      <span class="q-bg__ray q-bg__ray--1"></span>
      <span class="q-bg__ray q-bg__ray--2"></span>
      <span class="q-bg__ray q-bg__ray--3"></span>
    </div>
    <!-- stars / sparkles / wavy / neural / webgl / silk / vortex / blackhole 共用一个
         canvas（同一时刻只会用一种） -->
    <canvas
      v-if="CANVAS2D_MODES.includes(effective) || GL_MODES.includes(effective)"
      ref="canvasRef"
      class="q-bg__canvas"
    ></canvas>
    <!-- Vanta 的 3D 效果：库自己往这个容器里塞 canvas（见 VANTA_MODES 上的注释） -->
    <div
      v-if="VANTA_MODES.includes(effective)"
      ref="vantaHost"
      class="q-bg__vanta"
      :style="{ opacity: (intensity * (VANTA_OPACITY[effective] ?? 0.5)).toFixed(3) }"
    ></div>
    <div v-if="effective !== 'none'" class="q-bg__veil"></div>
  </div>
</template>

<style scoped>
.q-bg {
  position: fixed;
  inset: 0;
  z-index: 0;
  /* 背景绝不能吃掉点击 —— 这条比什么都重要 */
  pointer-events: none;
  overflow: hidden;
}
.q-bg__canvas {
  position: absolute;
  inset: 0;
  display: block;
}
/*
 * Vanta 容器。透明度由模板上的内联样式给（每个效果倍率不同，见 VANTA_OPACITY），
 * 这里只留一个兜底值，万一内联样式没生效也不会变成完全不透明盖住正文。
 *
 * 为什么要压这道透明度：Vanta 的效果是**整屏不透明**的画面，
 * 不像我们自己写的着色器那样带 alpha 通道。不压的话强度 100% 时
 * 「细胞」会把灰色小字糊到看不见（截图对比过）。
 */
.q-bg__vanta {
  position: absolute;
  inset: 0;
  opacity: calc(var(--q-bg-alpha, 0.6) * 0.5);
}
.q-bg__vanta :deep(canvas) {
  display: block;
}
/*
 * 压一层纱，保证文字对比度。
 *
 * ⚠️ 这个值被下调过两次，每次都是因为"背景看起来像没开"：
 *   62%（最初）→ 34% → **22%（现在）**。
 * 用户的原话是"极光本身也是被遮罩挡住了，不好看" —— 纱确实在压。
 * 实测（首页、强度 100%）把纱去掉之后的提升：
 *   丝缎 25.7 → 39.2、星云 24.1 → 36.7、极光 3.1 → 4.7（平均色差 /255）。
 *
 * 为什么还留着 22% 而不是直接删掉：正文有一部分**直接压在背景上**
 * （首页大标题、各区块小标题），没有这层纱时灰色小字（--q-text-3）在
 * 花纹密的模式上会看不太清。22% 是"能明显看见背景"和"小字仍然清楚"的折中。
 * 觉得还嫌淡/嫌浓的，用设置里的强度滑杆 —— 那才是给人调的地方。
 */
.q-bg__veil {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--q-bg, #fff) 22%, transparent);
}

/*
 * Vanta 那几个效果是**整屏不透明且花纹密**的，22% 的纱不够 ——
 * 灰字（--q-text-3）压在中紫上对比度偏低（实测截图确认过）。
 * 这里单独加厚到 34%：纱把底纹推向页面底色，**既提高对比度、又保留花纹**，
 * 比单纯把效果调淡更划算（调淡是连花纹一起牺牲）。
 */
.q-bg--heavy .q-bg__veil {
  background: color-mix(in srgb, var(--q-bg, #fff) 34%, transparent);
}

/* ---------- aurora ---------- */
.q-bg__aurora {
  position: absolute;
  inset: -20%;
  filter: blur(70px) saturate(1.35);
  opacity: calc(var(--q-bg-alpha, 0.6) * 1.15);
}
.q-bg__blob {
  position: absolute;
  width: 46vmax;
  height: 46vmax;
  border-radius: 50%;
  will-change: transform;
}
.q-bg__blob--1 {
  top: -6%;
  left: -8%;
  background: radial-gradient(circle, #6366f1 0%, transparent 68%);
  animation: q-bg-drift-1 34s ease-in-out infinite alternate;
}
.q-bg__blob--2 {
  right: -10%;
  top: 8%;
  background: radial-gradient(circle, #a855f7 0%, transparent 68%);
  animation: q-bg-drift-2 41s ease-in-out infinite alternate;
}
.q-bg__blob--3 {
  bottom: -14%;
  left: 24%;
  background: radial-gradient(circle, #f97316 0%, transparent 70%);
  animation: q-bg-drift-3 47s ease-in-out infinite alternate;
}
@keyframes q-bg-drift-1 {
  to {
    transform: translate3d(12vw, 8vh, 0) scale(1.18);
  }
}
@keyframes q-bg-drift-2 {
  to {
    transform: translate3d(-14vw, 12vh, 0) scale(1.1);
  }
}
@keyframes q-bg-drift-3 {
  to {
    transform: translate3d(8vw, -10vh, 0) scale(1.22);
  }
}

/* ---------- stars ---------- */
/*
 * 先铺一层很淡的夜空底色。没有这层的话，白点落在纯色页面上就是一堆噪点 ——
 * 实测原来只有 0.05% 的像素是被星点覆盖的，等于没有背景。
 */
.q-bg--stars::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(60% 50% at 20% 16%, rgba(99, 102, 241, 0.34), transparent 70%),
    radial-gradient(55% 45% at 82% 78%, rgba(168, 85, 247, 0.26), transparent 72%),
    radial-gradient(45% 40% at 60% 45%, rgba(236, 72, 153, 0.14), transparent 74%);
  opacity: var(--q-bg-alpha, 0.6);
}

/* ---------- aurora2：帘幕极光「极光·帘」 ----------
 * 和 aurora 的根本区别：aurora 是**团**（radial-gradient 的模糊球在漂），
 * 这个是**帘**—— 一根根竖直的光柱。做法：
 *   repeating-linear-gradient 造出等距的细竖条（就是"帘褶"），
 *   filter: blur() 把条子揉软（极光不该有硬边），
 *   mask-image 自上而下渐隐（真实极光是"上亮下淡"地垂下来，不是一条均匀的色带）。
 * 三层用不同角度（92°/86°/97°）互相交叉，才有厚度，不然就是一块条纹布。
 */
.q-bg__curtain {
  position: absolute;
  /* 往外撑一圈：blur 会让边缘变淡，贴边的话屏幕四边会出现"没色"的硬框 */
  inset: -12% -18% -30%;
  filter: blur(22px) saturate(1.45);
  /* 帘幕之间用 screen 相加，重叠处更亮 —— 这是"光"该有的行为。
     注意 .q-bg 自己是个 stacking context（fixed + z-index:0），
     所以这里的混合只发生在帘幕之间，不会去和页面底色相乘，两种主题都安全。 */
  mix-blend-mode: screen;
  opacity: calc(var(--q-bg-alpha, 0.6) * 1.05);
  will-change: transform, opacity;
}
.q-bg__ray {
  position: absolute;
  inset: 0;
  transform-origin: 50% 0%; /* 从顶边往下摆，帘子才不会整条平移 */
  will-change: transform, opacity;
}
/*
 * ⚠️ 条纹周期必须**大到扛得住 blur**。
 *    第一版我把亮条做成 ~1.5% 宽（1280px 上约 19px），再 blur 26px ——
 *    亮条被糊成一整片均匀的紫色，完全看不出"一根根帘子"。
 *    现在周期 18~27%（约 230~350px）、亮条约 100px，blur 只是把边揉软。
 */
.q-bg__ray--1 {
  background:
    repeating-linear-gradient(
      92deg,
      transparent 0 4%,
      rgba(99, 102, 241, 0.58) 7.5%,
      rgba(129, 140, 248, 0.32) 10.5%,
      transparent 14% 18%
    ),
    linear-gradient(180deg, rgba(99, 102, 241, 0.50), rgba(99, 102, 241, 0.16) 46%, transparent 82%);
  -webkit-mask-image: linear-gradient(180deg, #000 0%, rgba(0, 0, 0, 0.72) 45%, transparent 90%);
  mask-image: linear-gradient(180deg, #000 0%, rgba(0, 0, 0, 0.72) 45%, transparent 90%);
  animation: q-bg-sway-1 19s ease-in-out infinite alternate;
}
.q-bg__ray--2 {
  background:
    repeating-linear-gradient(
      86deg,
      transparent 0 6%,
      rgba(139, 92, 246, 0.52) 10%,
      rgba(167, 139, 250, 0.28) 13.5%,
      transparent 18% 23%
    ),
    linear-gradient(180deg, rgba(139, 92, 246, 0.46), rgba(139, 92, 246, 0.14) 40%, transparent 76%);
  -webkit-mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.9) 0%, rgba(0, 0, 0, 0.55) 52%, transparent 96%);
  mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.9) 0%, rgba(0, 0, 0, 0.55) 52%, transparent 96%);
  animation: q-bg-sway-2 26s ease-in-out infinite alternate;
}
.q-bg__ray--3 {
  background:
    repeating-linear-gradient(
      97deg,
      transparent 0 8%,
      rgba(236, 72, 153, 0.40) 12.5%,
      rgba(244, 114, 182, 0.22) 16%,
      transparent 20.5% 27%
    ),
    linear-gradient(180deg, rgba(236, 72, 153, 0.34), rgba(236, 72, 153, 0.10) 36%, transparent 70%);
  -webkit-mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.85) 0%, rgba(0, 0, 0, 0.4) 46%, transparent 88%);
  mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.85) 0%, rgba(0, 0, 0, 0.4) 46%, transparent 88%);
  animation: q-bg-sway-3 15s ease-in-out infinite alternate;
}
/* 摆动 = 轻微斜切 + 横向平移 + 纵向伸缩，都是合成器能做的属性（transform/opacity） */
@keyframes q-bg-sway-1 {
  0% {
    transform: translate3d(-3vw, 0, 0) skewX(0deg) scaleY(1);
    opacity: 0.85;
  }
  100% {
    transform: translate3d(4vw, 1.5vh, 0) skewX(-7deg) scaleY(1.16);
    opacity: 1;
  }
}
@keyframes q-bg-sway-2 {
  0% {
    transform: translate3d(5vw, 1vh, 0) skewX(6deg) scaleY(1.1);
    opacity: 1;
  }
  100% {
    transform: translate3d(-6vw, -1vh, 0) skewX(-5deg) scaleY(0.92);
    opacity: 0.72;
  }
}
@keyframes q-bg-sway-3 {
  0% {
    transform: translate3d(2vw, 0, 0) skewX(-4deg) scaleY(0.95);
    opacity: 0.7;
  }
  100% {
    transform: translate3d(-3vw, 2vh, 0) skewX(8deg) scaleY(1.2);
    opacity: 0.95;
  }
}

/* ---------- sparkles ---------- */
/*
 * 和 stars 一样先铺一层底色，但更"散"：用得广一点、淡一点。
 * 这层是"氛围"，不是主体 —— 主体是 canvas 上那些会爆闪的星。
 * 没有它，纯点阵在浅色页面上就只是一堆噪点。
 */
.q-bg--sparkles::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(65% 55% at 24% 20%, rgba(139, 92, 246, 0.30), transparent 72%),
    radial-gradient(60% 50% at 78% 74%, rgba(99, 102, 241, 0.30), transparent 74%),
    radial-gradient(50% 45% at 55% 12%, rgba(236, 72, 153, 0.16), transparent 76%);
  opacity: var(--q-bg-alpha, 0.6);
}

/* ---------- wavy ---------- */
/*
 * 波浪模式如果只有几条线，浅色页面上会很空。垫一层"地平线"式的纵向渐变：
 * 上方干净（不干扰读题），越往下品牌色越明显，波正好落在有色区的上缘 ——
 * 就是 Stripe 首页那种"从底部泛上来的渐变"观感。
 */
.q-bg--wavy::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    linear-gradient(180deg, transparent 24%, rgba(99, 102, 241, 0.10) 62%, rgba(139, 92, 246, 0.22) 100%),
    radial-gradient(70% 45% at 30% 96%, rgba(236, 72, 153, 0.20), transparent 72%),
    radial-gradient(70% 45% at 78% 100%, rgba(99, 102, 241, 0.22), transparent 74%);
  opacity: var(--q-bg-alpha, 0.6);
}

/* ---------- neural ---------- */
/*
 * 和 stars / sparkles 一样垫一层底色，但更"闷"一点：
 * 神经网的主体是那些细线和节点，底色只负责两件事 ——
 * 让纯线框在浅色页面上不至于空得发白，以及给整片一个偏冷的基调。
 * 所以用的是两团很淡的靛蓝/紫，而不是 wavy 那种从底部泛上来的渐变。
 */
.q-bg--neural::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(58% 52% at 22% 24%, rgba(99, 102, 241, 0.34), transparent 72%),
    radial-gradient(55% 48% at 80% 76%, rgba(139, 92, 246, 0.28), transparent 74%),
    radial-gradient(42% 38% at 62% 42%, rgba(236, 72, 153, 0.14), transparent 76%);
  opacity: var(--q-bg-alpha, 0.6);
}

/* 暗色主题下纱要反过来（压亮而不是压暗），否则一片死黑 */
html.dark .q-bg__veil {
  background: color-mix(in srgb, #0b1020 30%, transparent);
}
html.dark .q-bg--heavy .q-bg__veil {
  background: color-mix(in srgb, #0b1020 40%, transparent);
}

/* 少动效：只留静态底色，删掉所有动画 */
@media (prefers-reduced-motion: reduce) {
  .q-bg__blob,
  .q-bg__ray {
    animation: none !important;
  }
}
</style>
