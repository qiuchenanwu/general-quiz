<script setup>
/**
 * MusicPlayer —— 右下角那颗可拖动的小按钮 + 展开后的播放面板。
 *
 * 2026-10-08 重构：**这里不再嵌网易云 iframe 当主播放器**。
 *
 * 原来面板里塞的是网易云官方 `outchain` 外链 iframe（一张别人家的白底小卡片）：
 *   播放键、进度、音量、列表**全在 iframe 里**，我们一个都碰不到，
 *   浅色白底在深色主题下格外突兀，歌单模式 430px 高塞进 360px 面板还会被切。
 * 现在：
 *   · 配了「自己的音乐」→ 面板里是**我们自己的 APlayer**：封面、歌词、进度、
 *     音量、上一首/下一首、播放列表，可以拖动的面板，深浅色都跟着主题走。
 *   · 只配了网易云 id → 保留官方外链作为**降级**（合规、能放就行，
 *     但不再假装它是"我们的播放器"，面板头部也明说了）。
 *
 * ⚠️ 两条本次重构踩过的、**不要改回去**的坑：
 *
 * 1. **面板不能用 `v-if` / `display: none` 藏。**
 *    播放器实例就挂在这个面板里（见下），`v-if` 会在收起时把容器连同实例一起
 *    卸掉 → 一收起音乐就停；而且 APlayer 建实例时要量元素尺寸，
 *    在 display:none 里量出来是 0，展开后进度条/歌词位置全是错的。
 *    所以收起只用 `visibility` + `opacity`（class `is-open` 控制），
 *    元素始终在布局里 —— 既量得准，也不吃 Tab 焦点（visibility:hidden
 *    的子元素本来就不可聚焦）。
 *
 * 2. **播放器是全局单例**（stores/player.js），这里只负责"把实例挂到自己身上"。
 *    `watchEffect` 里那句 attach 会在成就页用完 `release()` 之后自动把实例接回来，
 *    所以不要改成只 `onMounted` 挂一次。
 *
 * 关于拖动/开合/翻面的那套逻辑（下面 Drag 区块）是上一轮做的，实测没问题，原样保留。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import { useQuizStore } from '@/stores/quiz'
import { usePlayerStore } from '@/stores/player'
import { neteaseFrameHeight, neteasePageUrl, neteasePlayerSrc } from '@/core/music'

const router = useRouter()
const quiz = useQuizStore()
const player = usePlayerStore()

/** 展开状态。默认收起成一个唱片小图标，不占地方也不抢注意力。 */
const open = ref(false)

const enabled = computed(() => !!quiz.settings.musicOn)
const note = computed(() => String(quiz.settings.musicNote || '').trim())

/* ------------------------------------------------------------------ *
 * 两条音源：自己的播放列表（主） / 网易云外链（降级）
 * ------------------------------------------------------------------ */

const hasTracks = computed(() => player.hasTracks)
/** 曲库里认出来的**网页地址**（用户最常粘错的：网易云歌曲页） */
const pageLinks = computed(() => quiz.myMusic.pages || [])
const firstNetease = computed(() => pageLinks.value.find((p) => p.netease)?.netease || null)

const songId = computed(() => String(quiz.settings.musicId || '').trim())
const kind = computed(() => Number(quiz.settings.musicType ?? 2))

/**
 * 官方外链地址。拼法统一走 core/music.js —— 成就页里也用同一个函数，
 * 免得出现"小按钮能放、成就页放不了"这种两边不一致的怪事。
 *   type=2 单曲（height 66 是官方给的最小高度）
 *   type=0 歌单/专辑（要高得多，不然列表被切掉）
 */
const src = computed(() => neteasePlayerSrc(kind.value, songId.value, neteaseFrameHeight(kind.value)))
const frameHeight = computed(() => neteaseFrameHeight(kind.value))
const pageUrl = computed(() => neteasePageUrl(kind.value, songId.value))
const configured = computed(() => !!src.value)

/**
 * 面板里到底是什么：
 *   own          配了能播的音频 → 我们自己的 APlayer
 *   netease      配了网易云 id → 官方外链
 *   netease-link 只粘了网易云**网页地址** → 提示一键转成 id（见 useNeteaseLink）
 *   empty        什么都没配
 */
const mode = computed(() => {
  if (hasTracks.value) return 'own'
  if (configured.value) return 'netease'
  if (firstNetease.value) return 'netease-link'
  if (pageLinks.value.length) return 'page-link'
  return 'empty'
})

const panelTitle = computed(() => {
  if (note.value) return note.value
  if (mode.value === 'netease' || mode.value === 'netease-link') return '网易云音乐（官方外链）'
  return '我的音乐'
})

/**
 * 把「粘进来的网易云网页地址」一键变成正确的配置。
 *
 * 用户粘 `https://music.163.com/song?id=438456541` 是最自然的行为（刚从网页复制来的），
 * 但那个地址是网页、放不出声。与其只报错，不如直接帮他填好 ID 并切到官方外链 ——
 * **能猜对用户意图的时候就不要只报错**。
 */
function useNeteaseLink() {
  const nz = firstNetease.value
  if (!nz) return
  quiz.setSetting('musicType', nz.kind)
  quiz.setSetting('musicId', nz.id)
  quiz.setSetting('musicNote', quiz.settings.musicNote || '')
  quiz.setSetting('musicOn', true)
  open.value = true
}

/** 收起态那颗唱片上显示的：正在放的那首 > 用户起的名字 > 默认 */
const discLabel = computed(() => player.current?.name || note.value)
/** 有封面就把封面画到唱片上（没有就用主题色渐变的假唱片） */
const discStyle = computed(() =>
  player.cover ? { backgroundImage: `url('${player.cover}')`, backgroundSize: 'cover' } : {},
)

/** iframe 加载失败（被墙/被拦）时切换成降级提示 */
const failed = ref(false)
watch(src, () => {
  failed.value = false
})

/* ------------------------------------------------------------------ *
 * 把单例播放器挂到本面板
 * ------------------------------------------------------------------ */

const hostRef = ref(null)

function ensureAttached() {
  if (!enabled.value || !hasTracks.value || player.owner || !hostRef.value) return
  player.attach(hostRef.value, 'fab')
}

// 依赖里含 hostRef / owner / hasTracks：
//   · 首次挂载后 hostRef 有值 → 自动挂上
//   · 成就页用完 release()（owner 变空）→ 自动接回来
watchEffect(ensureAttached)
onMounted(ensureAttached)

// 设置里改了播放列表 → 让引擎重建（自己不是当前持有者时什么也不做）
watch(
  () => player.tracks,
  () => player.rebuild('fab'),
)

onBeforeUnmount(() => player.release('fab'))

function toggle() {
  if (!enabled.value) {
    // 还没开就先帮用户打开设置，别让人对着一个没反应的图标点
    quiz.setSetting('musicOn', true)
  }
  open.value = !open.value
}

/* ------------------------------------------------------------------ *
 * 拖动
 * ------------------------------------------------------------------ */

/** 边距：夹紧时留的余量，和默认位置一致 */
const MARGIN = 20
/** 判定为「拖动」而不是「点击」的位移阈值（px） */
const DRAG_SLOP = 5

const rootRef = ref(null)
/** 视口尺寸。resize 时要重算，所以放在响应式里 */
const viewport = ref({
  w: typeof window === 'undefined' ? 1280 : window.innerWidth,
  h: typeof window === 'undefined' ? 800 : window.innerHeight,
})

/** 从设置里读回比例；没存过（或存坏了）就是 null = 用默认的右下角 */
function readRatio() {
  const p = quiz.settings.musicPos
  if (p && Number.isFinite(p.rx) && Number.isFinite(p.ry)) {
    return { rx: Math.min(Math.max(p.rx, 0), 1), ry: Math.min(Math.max(p.ry, 0), 1) }
  }
  return null
}

const ratio = ref(readRatio())
/** 拖动进行中（用来改光标、临时关掉过渡动画） */
const dragging = ref(false)

/** 按当前视口把中心点夹到屏幕内，返回 px */
function clampCenter(cx, cy) {
  const el = rootRef.value
  const hw = (el?.offsetWidth || 132) / 2
  const hh = (el?.offsetHeight || 40) / 2
  const m = 8
  return {
    x: Math.min(Math.max(cx, hw + m), Math.max(hw + m, viewport.value.w - hw - m)),
    y: Math.min(Math.max(cy, hh + m), Math.max(hh + m, viewport.value.h - hh - m)),
  }
}

/** 有存过位置才接管定位；否则交给 CSS 的 right/bottom（默认右下角） */
const positioned = computed(() => !!ratio.value)

const posStyle = computed(() => {
  if (!ratio.value) return {}
  const c = clampCenter(ratio.value.rx * viewport.value.w, ratio.value.ry * viewport.value.h)
  return { left: `${Math.round(c.x)}px`, top: `${Math.round(c.y)}px` }
})

/** 按钮中心的 y（用于决定面板往哪边开） */
function centerY() {
  if (ratio.value) return clampCenter(ratio.value.rx * viewport.value.w, ratio.value.ry * viewport.value.h).y
  const el = rootRef.value
  const hh = (el?.offsetHeight || 40) / 2
  return viewport.value.h - MARGIN - hh
}

/** 面板总高（含头部和间隙），用来判断上方放不放得下 */
const panelHeight = computed(() => {
  if (!open.value) return 0
  if (mode.value === 'own') return 240
  return mode.value === 'netease' ? frameHeight.value + 58 : 120
})

/** 上方放不下、且下方更宽裕 → 面板向下展开 */
const flipped = computed(() => {
  if (!open.value) return false
  const spaceAbove = centerY()
  const spaceBelow = viewport.value.h - centerY()
  return spaceAbove < panelHeight.value + 16 && spaceBelow > spaceAbove
})

let drag = null

/**
 * ⚠️ 这里踩过一个坑，别再改回去：
 * 原先用 `el.setPointerCapture(pointerId)` 把指针捕获在**根 div** 上，
 * 但监听器挂在**按钮**上 —— 一旦捕获生效，后续 pointermove / pointerup
 * 全部被重定向到根 div，按钮的处理器**一次都收不到**，表现是"按住拖毫无反应"
 * （而且不报错，只是一动不动）。
 *
 * 现在改成：按下之后把 move / up 挂到 **window** 上。这样
 *   ① 指针拖出按钮甚至拖出窗口都不会丢事件；
 *   ② 不依赖指针捕获的各种浏览器差异；
 *   ③ 谁在捕获谁在监听一目了然。
 */
function onPointerDown(event) {
  // 只认主键 / 触摸 / 笔
  if (event.button != null && event.button !== 0) return
  const el = rootRef.value
  if (!el) return
  const box = el.getBoundingClientRect()
  drag = {
    startX: event.clientX,
    startY: event.clientY,
    // 记录「按下点相对按钮中心」的偏移，这样拖起来不会跳一下
    offsetX: event.clientX - (box.left + box.width / 2),
    offsetY: event.clientY - (box.top + box.height / 2),
    moved: 0,
  }
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerUp)
}

function detachDrag() {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerUp)
}

function onPointerMove(event) {
  if (!drag) return
  drag.moved = Math.max(
    drag.moved,
    Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY),
  )
  if (drag.moved < DRAG_SLOP) return // 还没越过阈值，先别动，免得手抖就挪位
  dragging.value = true
  const centre = clampCenter(event.clientX - drag.offsetX, event.clientY - drag.offsetY)
  ratio.value = { rx: centre.x / viewport.value.w, ry: centre.y / viewport.value.h }
}

function onPointerUp() {
  detachDrag()
  if (!drag) return
  const moved = drag.moved
  drag = null
  dragging.value = false
  if (moved >= DRAG_SLOP) {
    // ① 必须**同步**置位：pointerup 之后紧跟的 click 是同一个任务链里的，
    //    靠 watch(dragging) 去置位会晚一拍（Vue 的 watcher 走异步队列），
    //    结果拖完照样把面板开合一次。
    suppressClick = true
    // ② 只有真的拖了才落盘：pointermove 里每帧写 localStorage 是没必要的
    quiz.setSetting('musicPos', { ...ratio.value })
  }
}

/**
 * 点击分流：拖完那一下会紧跟一个 click，这里吃掉它，
 * 否则「拖动」会顺手把面板开合一次。
 */
let suppressClick = false

function onFabClick() {
  if (suppressClick) {
    suppressClick = false
    return
  }
  toggle()
}

/** 复位到默认右下角（面板里给了入口） */
function resetPos() {
  ratio.value = null
  quiz.setSetting('musicPos', null)
}

/** 去整页播放器（面板收起，音乐不断 —— 同一个单例，只是换页面） */
function openPlayerPage() {
  open.value = false
  router.push('/player')
}

function onResize() {
  viewport.value = { w: window.innerWidth, h: window.innerHeight }
}

/** 进度条点击 → 按比例跳转（条不宽，用比例比像素稳） */
function onSeekClick(event) {
  const box = event.currentTarget?.getBoundingClientRect()
  if (!box?.width) return
  player.seekRatio((event.clientX - box.left) / box.width)
}

onMounted(() => {
  window.addEventListener('resize', onResize)
  // 设置是异步从 localStorage 读回来的，挂载后再同步一次
  ratio.value = readRatio()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  detachDrag() // 组件被销毁时别把监听留在 window 上
})

watch(
  () => quiz.settings.musicPos,
  () => {
    // 换题库 / 别的组件改了位置，这里跟着走（拖动中不要打断自己）
    if (!dragging.value) ratio.value = readRatio()
  },
)
</script>

<template>
  <div
    v-if="enabled"
    ref="rootRef"
    class="q-music q-no-print"
    :class="{ 'is-open': open, 'is-moved': positioned, 'is-flipped': flipped, 'is-dragging': dragging }"
    :style="posStyle"
  >
    <!-- 收起时的唱片按钮：可拖动（按住别放），单击开合 -->
    <button
      class="q-music__fab"
      :title="`${open ? '收起播放器' : '打开播放器'} · 按住可拖动`"
      @pointerdown="onPointerDown"
      @click="onFabClick"
    >
      <span
        class="q-music__disc"
        :class="{ 'is-spinning': player.playing, 'is-cover': !!player.cover }"
        :style="discStyle"
      >
        <el-icon :size="18"><Headset /></el-icon>
      </span>
      <span v-if="discLabel && !open" class="q-music__note">{{ discLabel }}</span>
      <!-- 抓手：让人一眼看出"这东西能拖" -->
      <span class="q-music__grip" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></span>
    </button>

    <!--
      ⚠️ 这里**不能**用 v-if / v-show（= display:none）：
      面板收起时也要留在布局里，否则挂在上面的播放器实例会被卸掉、
      建实例时量到的尺寸也全是 0。用 is-open 这个 class 切 visibility/opacity。
    -->
    <div class="q-music__panel" :class="{ 'is-open': open }" :aria-hidden="!open">
      <header class="q-music__head">
        <span class="q-music__title">
          <el-icon :size="13"><Headset /></el-icon>
          {{ panelTitle }}
        </span>
        <div class="q-music__acts">
          <span v-if="hasTracks" class="q-music__count">{{ player.index + 1 }}/{{ player.tracks.length }}</span>
          <a
            v-if="mode === 'netease' && configured"
            class="q-music__link"
            :href="pageUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            在新窗口打开
          </a>
          <button v-if="positioned" class="q-music__close" title="复位到右下角" @click="resetPos">
            <el-icon :size="13"><RefreshRight /></el-icon>
          </button>
          <!-- 展开成整页播放器（歌词/封面/播放条）—— 面板只负责"随手控制" -->
          <button v-if="hasTracks" class="q-music__close" title="打开播放页" @click="openPlayerPage">
            <el-icon :size="13"><FullScreen /></el-icon>
          </button>
          <button class="q-music__close" title="收起（音乐继续放）" @click="open = false">
            <el-icon :size="13"><Close /></el-icon>
          </button>
        </div>
      </header>

      <!-- ① 自己的音乐 → 全局单例 APlayer 挂在这里 -->
      <div v-if="mode === 'own'" class="q-music__body">
        <!-- 这个 div 就是播放器的容器：收起时也不卸载，音乐才不会停 -->
        <div ref="hostRef" class="q-music__ap"></div>

        <!-- 进度条：APlayer 自己那条太细、点不准，这里给一条宽的好点的 -->
        <div class="q-music__seek" role="presentation" @click="onSeekClick">
          <span class="q-music__time">{{ player.timeText }}</span>
          <span class="q-music__track"><i :style="{ width: `${Math.round(player.progress * 100)}%` }"></i></span>
          <span class="q-music__time">{{ player.durationText }}</span>
        </div>

        <p v-if="player.error" class="q-music__bad">
          {{ player.error }}
          <template v-if="player.errorUrl">：{{ player.errorUrl }}</template>
          <br />
          <span class="q-dim">
            网页地址（如 music.163.com/song?id=…）不是音频文件，放不出来是正常的。
          </span>
        </p>
      </div>

      <!-- ①b 只粘了网易云网页地址 → 直接帮他转成正确的用法 -->
      <div v-else-if="mode === 'netease-link'" class="q-music__empty">
        <p>检测到网易云链接，但它是个<b>网页地址</b>，不能当音频播。</p>
        <p class="q-dim">要不要用它填好上面的 ID、改用官方外链播放？</p>
        <button class="q-music__cta" @click="useNeteaseLink">用它播放这首</button>
      </div>

      <!-- ①c 粘了别的网页地址（B 站 / YouTube 之类） -->
      <div v-else-if="mode === 'page-link'" class="q-music__empty">
        <p>这几行是<b>网页地址</b>，不是音频文件，浏览器解不了。</p>
        <p class="q-dim">要放歌得填 mp3 / m4a / flac 这类直链。</p>
      </div>

      <!-- ② 只配了网易云 id → 官方外链（降级路线） -->
      <div v-else-if="mode === 'netease'" class="q-music__frame-wrap" :style="{ height: frameHeight + 'px' }">
        <iframe
          v-if="!failed"
          class="q-music__frame"
          :src="src"
          :height="frameHeight"
          frameborder="no"
          allow="autoplay"
          loading="lazy"
          referrerpolicy="no-referrer"
          @error="failed = true"
        ></iframe>
        <div v-else class="q-music__empty">
          <p>播放器加载不出来（可能是网络把它拦了）。</p>
          <a class="q-music__link" :href="pageUrl" target="_blank" rel="noopener noreferrer">
            点这里在新窗口打开 ↗
          </a>
        </div>
      </div>

      <!-- ③ 什么都没配 -->
      <div v-else class="q-music__empty">
        <p>还没有配置音乐。</p>
        <p class="q-dim">
          打开「设置 → 音乐」：填<b>自己的 mp3 直链</b>（一行一首，可带封面和歌词，
          右下角这里就是完整播放器），或者填<b>网易云歌曲 id</b>（用官方外链）。
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * 定位说明：.q-music 的**盒子就是那个按钮**（inline-flex），
 * 有存过位置时用 left/top + translate(-50%,-50%) 把"按钮中心"放到目标点；
 * 没存过就交给 right/bottom 走默认的右下角。
 * 面板是绝对定位的子元素，跟着盒子整体走，所以拖按钮等于拖整个播放器。
 */
.q-music {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 200;
  display: inline-flex;
  flex-direction: column;
  align-items: flex-end;
}
.q-music.is-moved {
  right: auto;
  bottom: auto;
  transform: translate(-50%, -50%);
}
/* 拖动中别让 hover 的位移参与进来，否则会跟手抖一下 */
.q-music.is-dragging .q-music__fab:hover {
  transform: none;
}

/* ---------- 收起态的唱片按钮 ---------- */
.q-music__fab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px 8px 8px;
  border: 1px solid color-mix(in srgb, var(--q-brand-1) 35%, var(--q-border));
  border-radius: 99px;
  background: color-mix(in srgb, var(--q-surface) 78%, transparent);
  backdrop-filter: blur(14px) saturate(1.4);
  color: var(--q-text);
  font: inherit;
  font-size: 12.5px;
  /* 能拖：光标 + 关掉触摸端的手势抢占 */
  cursor: grab;
  touch-action: none;
  user-select: none;
  box-shadow: 0 8px 26px -12px color-mix(in srgb, var(--q-brand-1) 70%, transparent);
  transition: transform 0.2s var(--q-ease), box-shadow 0.25s var(--q-ease);
}
.q-music__fab:hover {
  transform: translateY(-2px);
  box-shadow: 0 12px 32px -12px color-mix(in srgb, var(--q-brand-1) 85%, transparent);
}
.q-music__fab:active,
.q-music.is-dragging .q-music__fab {
  cursor: grabbing;
}
.q-music__disc {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  color: #fff;
  /* 唱片质感：中心孔 + 一圈金属边 */
  background:
    radial-gradient(circle at 50% 50%, var(--q-surface) 0 3px, transparent 3px),
    conic-gradient(from 0deg, #6366f1, #a855f7, #ec4899, #f97316, #6366f1);
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.25);
  animation: q-music-halo 4.5s ease-in-out infinite;
}
/* 有封面时用封面当唱片：图标压暗一点，别糊在脸上 */
.q-music__disc.is-cover {
  background-position: center;
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.35), inset 0 0 0 999px rgb(10 12 20 / 0.35);
}
.q-music__disc.is-spinning {
  animation: q-music-halo 4.5s ease-in-out infinite, q-music-spin 7s linear infinite;
}
@keyframes q-music-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes q-music-halo {
  0%,
  100% {
    box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.25), 0 0 0 0 color-mix(in srgb, var(--q-brand-1) 45%, transparent);
  }
  50% {
    box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.25), 0 0 0 9px transparent;
  }
}
/* 六点抓手：拖动的可见提示 */
.q-music__grip {
  display: grid;
  grid-template-columns: repeat(2, 3px);
  grid-auto-rows: 3px;
  gap: 2px;
  opacity: 0.32;
  transition: opacity 0.2s var(--q-ease);
}
.q-music__grip i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
}
.q-music__fab:hover .q-music__grip {
  opacity: 0.6;
}
.q-music__note {
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 展开面板：玻璃拟态 + 极光描边 ---------- */
/*
 * 收起时用 visibility/opacity 藏（**不用 display:none**，原因见模板里的注释）。
 * visibility 也会把子元素从 Tab 焦点链和无障碍树里摘掉，所以不用额外加 inert。
 */
.q-music__panel {
  position: absolute;
  right: 0;
  /* 默认向上展开（按钮在屏幕下半部时） */
  bottom: calc(100% + 10px);
  width: min(380px, calc(100vw - 40px));
  border-radius: 18px;
  border: 1px solid color-mix(in srgb, var(--q-brand-1) 30%, var(--q-border));
  background: color-mix(in srgb, var(--q-surface) 72%, transparent);
  backdrop-filter: blur(20px) saturate(1.5);
  box-shadow: 0 22px 60px -24px color-mix(in srgb, var(--q-brand-1) 80%, transparent);
  overflow: hidden;
  visibility: hidden;
  opacity: 0;
  transform: translateY(10px) scale(0.97);
  pointer-events: none;
  transition: opacity 0.22s var(--q-ease), transform 0.22s var(--q-ease), visibility 0.22s;
}
.q-music__panel.is-open {
  visibility: visible;
  opacity: 1;
  transform: none;
  pointer-events: auto;
}
/* 按钮被拖到屏幕上半部 → 面板翻到下面，否则会顶出屏幕 */
.q-music.is-flipped .q-music__panel {
  bottom: auto;
  top: calc(100% + 10px);
  transform: translateY(-10px) scale(0.97);
}
.q-music.is-flipped .q-music__panel.is-open {
  transform: none;
}
.q-music__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--q-border);
}
.q-music__title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--q-text);
  max-width: 170px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.q-music__acts {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.q-music__count {
  font-size: 11px;
  color: var(--q-text-3);
  font-variant-numeric: tabular-nums;
}
.q-music__link {
  font-size: 11.5px;
  color: var(--q-brand-1);
  text-decoration: none;
}
.q-music__link:hover {
  text-decoration: underline;
}
.q-music__close {
  display: inline-flex;
  border: 0;
  background: transparent;
  color: var(--q-text-3);
  cursor: pointer;
  padding: 2px;
}
.q-music__close:hover {
  color: var(--q-text);
}

/* ---------- 自己的播放器 ---------- */
.q-music__body {
  padding: 10px 12px 12px;
}
.q-music__ap {
  border-radius: 12px;
  overflow: hidden;
}

/*
 * 进度条：APlayer 自己那条能点，但又细又贴边，面板里不好瞄。
 * 这里在它**外面**再加一条宽的（点它调 player.seekRatio），
 * 两条并存不冲突 —— 审美归我们，播放归 APlayer。
 */
.q-music__seek {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  cursor: pointer;
}
.q-music__time {
  font-size: 11px;
  color: var(--q-text-3);
  font-variant-numeric: tabular-nums;
  min-width: 34px;
  text-align: center;
}
.q-music__track {
  position: relative;
  flex: 1;
  height: 5px;
  border-radius: 99px;
  background: var(--q-surface-3);
  overflow: hidden;
}
.q-music__track i {
  display: block;
  height: 100%;
  border-radius: 99px;
  background: linear-gradient(90deg, var(--q-brand-1), var(--q-brand-3, #ec4899));
  transition: width 0.15s linear;
}
.q-music__bad {
  margin: 8px 0 0;
  font-size: 11.5px;
  color: var(--q-warn);
}

/* ---------- 网易云外链（降级路线） ---------- */
.q-music__frame-wrap {
  position: relative;
  width: 100%;
}
.q-music__frame {
  display: block;
  width: 100%;
  border: 0;
}
.q-music__empty {
  padding: 14px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--q-text-2);
}
.q-music__empty p {
  margin: 0 0 4px;
}
/* 一键修复按钮：能猜对用户意图时，给他一个按钮，而不是一段解释 */
.q-music__cta {
  margin-top: 6px;
  padding: 7px 14px;
  border: 0;
  border-radius: 99px;
  color: #fff;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  background: linear-gradient(135deg, var(--q-brand-1), var(--q-brand-3, #ec4899));
  box-shadow: 0 10px 24px -12px color-mix(in srgb, var(--q-brand-1) 90%, transparent);
}
.q-music__cta:hover {
  filter: brightness(1.06);
}

/*
 * APlayer 默认是**浅色硬编码**（白底黑字），和本站主题打架。
 * 用 :deep() 覆盖它的关键几处（这些 class 来自它自己的全局样式表）。
 *
 * ⚠️ 两个坑（2026-10-08 实测）：
 *   1. APlayer 是**把类加在容器本身**上的（`container.classList.add('aplayer')`），
 *      所以 `.q-music__ap` 这个 div 自己就是 `.aplayer` —— 不能写成
 *      `.q-music__ap :deep(.aplayer)`（那是找**后代**，永远匹配不到）。
 *      这个写法在成就页里其实一直是死代码，深色主题下 APlayer 还是白的。
 *      要命中同一个元素，直接写 `.q-music__ap { ... }` 就行（scoped 会带上
 *      `[data-v-xxx]`，特异性 0,2,0 高于 APlayer 自己的 `.aplayer` 0,1,0）。
 *   2. 里面的元素（.aplayer-info / .aplayer-list …）才是后代，继续用 :deep()。
 */
.q-music__ap {
  border-radius: 12px;
  border: 1px solid var(--q-border);
  background: var(--q-surface);
  color: var(--q-text);
  box-shadow: none;
  margin: 0;
}
.q-music__ap :deep(.aplayer-info) {
  border-bottom-color: var(--q-border);
}
.q-music__ap :deep(.aplayer-info .aplayer-music .aplayer-title) {
  color: var(--q-text);
}
.q-music__ap :deep(.aplayer-info .aplayer-music .aplayer-author),
.q-music__ap :deep(.aplayer-info .aplayer-controller .aplayer-time) {
  color: var(--q-text-3);
}
.q-music__ap :deep(.aplayer-info .aplayer-controller .aplayer-bar-wrap .aplayer-bar) {
  background: var(--q-surface-3);
}
.q-music__ap :deep(.aplayer-list) {
  border-top-color: var(--q-border);
}
.q-music__ap :deep(.aplayer-list ol li) {
  border-top-color: var(--q-border);
  color: var(--q-text-2);
}
.q-music__ap :deep(.aplayer-list ol li .aplayer-list-index),
.q-music__ap :deep(.aplayer-list ol li .aplayer-list-author) {
  color: var(--q-text-3);
}
.q-music__ap :deep(.aplayer-list ol li:hover) {
  background: var(--q-surface-2);
}
.q-music__ap :deep(.aplayer-list ol li.aplayer-list-light) {
  background: color-mix(in srgb, var(--q-brand-1) 12%, transparent);
}
.q-music__ap :deep(.aplayer-list ol li.aplayer-list-light .aplayer-list-title) {
  color: var(--q-brand-1);
}
/* 歌词区（有 lrc 时才出现 —— 没有歌词 APlayer 自己会加 aplayer-lrc-hide） */
.q-music__ap :deep(.aplayer-lrc p) {
  color: var(--q-text-2);
}
.q-music__ap :deep(.aplayer-lrc p.aplayer-lrc-current) {
  color: var(--q-text);
}

/* 少动效的人：别给他转个不停的唱片 */
@media (prefers-reduced-motion: reduce) {
  .q-music__disc,
  .q-music__disc.is-spinning {
    animation: none;
  }
  .q-music__track i {
    transition: none;
  }
}

@media (max-width: 640px) {
  .q-music:not(.is-moved) {
    right: 12px;
    bottom: 12px;
  }
  .q-music__panel {
    width: calc(100vw - 24px);
  }
}
</style>
