<script setup>
/**
 * AchievementPage —— 刷完一整轮之后的全屏成就页。
 *
 * 为什么单独做一个全屏页，而不是把成绩单做大一点：
 *   成绩单（ResultPanel）是**信息**，用户看完就走；成就页是**情绪**，
 *   要的是一下子的"值了"。两者的排版目标不一样，硬塞进一个组件会互相将就。
 *   所以：成绩单照旧留在答题页，成就页是盖在上面的一层，看完即走。
 *
 * 播放器有**两条路**，按用户配了什么自动选（这是用户明确要求的"两条都跑通"）：
 *   ① 设置里填了自己的 mp3 直链（`settings.musicList`）→ 用 **APlayer**
 *      （MIT，github.com/MoePlayer/APlayer）：封面、歌词、播放列表、进度条，
 *      真正的"帅气播放器"。
 *   ② 只填了网易云 id → 用**官方外链 iframe**（合规、稳定，但外观不可控）。
 *   ③ 都没填 → 给一句怎么配的提示，而不是留一块空白。
 *
 * 2026-10-08 改：① 不再是"本页自己 new 一个 APlayer"，而是**接管全局那一个**
 * （stores/player.js）。原来本页和右下角各有一个实例，互不知道对方在响 ——
 * 症状是"成就页在放歌、角落那颗也能同时出声"。现在：
 *   · 打开本页 → `player.attach(本页容器, 'achievement')`，实例从右下角搬过来，
 *     **位置和播放状态带过来**（不会从头开始）
 *   · 关掉本页 → `release()`，右下角那个面板自动接回去（它的 watchEffect 负责）
 *   · 用户没开「网易云播放器」开关、只在自己的音乐里填了歌单时，本页照样能放 ——
 *     这条是原来就有的行为，接管机制把它保住了
 *
 * 几个刻意的决定：
 *   · **APlayer 懒加载**：真正的 `import('aplayer')` 现在在 stores/player.js 里，
 *     只有真的用自己播放列表的人才会下载它（~59KB JS + 12.5KB CSS）。默认路径
 *     （不配音乐）一份都不下 —— 主包不该为少数人的功能买单。
 *   · **不自动播放**。等用户按播放键。突然出声很烦，而且会被浏览器拦掉
 *     还留一条控制台红字。
 *   · **彩花规模按成绩分档**，而且题量太少会降一档（见 core/music.js 的 gradeOf）——
 *     3 道题全对不值得放 132 颗彩花的"史诗级"庆祝。
 *   · 只在**真的完成一轮**时自动弹一次，且记在 session 里（刷新不会又弹）。
 *     成绩单上留了入口可以重开。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useQuizStore } from '@/stores/quiz'
import { usePlayerStore } from '@/stores/player'
import { celebrate, prefersReducedMotion } from '@/core/celebrate'
import { gradeOf, humanDuration, neteaseFrameHeight, neteasePageUrl, neteasePlayerSrc } from '@/core/music'

const props = defineProps({
  /** 本轮用时（秒），由练习页算好传进来 —— 避免这里再碰 Date.now() */
  usedSeconds: { type: Number, default: 0 },
})
const emit = defineEmits(['close', 'review', 'restart'])

const quiz = useQuizStore()
const player = usePlayerStore()

const stats = computed(() => quiz.sessionStats || { total: 0, ok: 0, bad: 0, graded: 0, accuracy: 0, score: 0 })
const grade = computed(() =>
  gradeOf({ accuracy: stats.value.accuracy, graded: stats.value.graded, total: stats.value.total }),
)
const bestStreak = computed(() => quiz.session?.bestStreak || 0)
const isExam = computed(() => quiz.session?.mode === 'exam')

/* ------------------------------------------------------------------ *
 * 播放器：接管全局那一个（不再自己 new）
 * ------------------------------------------------------------------ */
const tracks = computed(() => player.tracks)
const skippedLines = computed(() => quiz.myMusic.skipped)
const hasOwn = computed(() => tracks.value.length > 0)

const neteaseId = computed(() => String(quiz.settings.musicId || '').trim())
const neteaseKind = computed(() => Number(quiz.settings.musicType ?? 2))
const neteaseSrc = computed(() =>
  neteasePlayerSrc(neteaseKind.value, neteaseId.value, neteaseFrameHeight(neteaseKind.value)),
)
const neteaseHeight = computed(() => neteaseFrameHeight(neteaseKind.value))

/** APlayer 的容器。实例是从右下角**搬**过来的（见文件头） */
const playerHost = ref(null)

onMounted(() => {
  // 彩花交给统一的庆祝模块（和答对旧错题、连对里程碑同一套）
  if (!prefersReducedMotion()) {
    celebrate('streak', { level: grade.value.level, label: `${grade.value.emoji} ${grade.value.title}` })
  }
  if (hasOwn.value) player.attach(playerHost.value, 'achievement')
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  // 把实例交还出去：右下角面板的 watchEffect 会把播放器接回自己那儿，
  // 正在放的歌不会因为关掉成就页就没了
  player.release('achievement')
})

// 在成就页里改播放列表 → 让引擎按新列表重建（自己不是持有者时它什么都不做）
watch(tracks, () => player.rebuild('achievement'))

function onKeydown(event) {
  if (event.key === 'Escape') emit('close')
}

/* ------------------------------------------------------------------ *
 * 分数环
 * ------------------------------------------------------------------ */
const RING = 2 * Math.PI * 52

const ringOffset = computed(() => RING * (1 - Math.min(1, Math.max(0, stats.value.accuracy / 100))))
const ringColor = computed(() => {
  if (stats.value.accuracy >= 90) return 'var(--q-ok)'
  if (stats.value.accuracy >= 70) return 'var(--q-brand-1)'
  if (stats.value.accuracy >= 60) return 'var(--q-warn)'
  return 'var(--q-bad)'
})
</script>

<template>
  <!--
    ⚠️ 必须 Teleport 到 body。
    一开始我直接写在 PracticeView 里，给它 z-index: 300（比顶栏的 100 高），
    结果**顶栏还是浮在遮罩上面** —— 因为正文容器自己有 `z-index: 1`，
    形成了一个层叠上下文，遮罩的 300 被关在里面，只能跟同一层的兄弟比大小，
    跟外面那个 100 根本不在一个层级里比。Teleport 出去之后才真的盖住顶栏。
  -->
  <Teleport to="body">
    <div class="q-ach q-no-print" role="dialog" aria-modal="true" aria-label="本轮完成">
    <div class="q-ach__glow" aria-hidden="true"></div>

    <div class="q-ach__card">
      <!-- ── 评价 ── -->
      <header class="q-ach__head">
        <span class="q-ach__emoji">{{ grade.emoji }}</span>
        <h2 class="q-ach__title">{{ grade.title }}</h2>
        <p class="q-ach__sub">{{ grade.note }}</p>
        <p class="q-ach__mode q-dim">
          {{ isExam ? '模拟考试' : '这一轮' }} · 共 {{ stats.total }} 题 · 用时 {{ humanDuration(props.usedSeconds) }}
        </p>
      </header>

      <!-- ── 正确率环 ── -->
      <div class="q-ach__ring">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle class="q-ach__ring-track" cx="60" cy="60" r="52" />
          <circle
            class="q-ach__ring-value"
            cx="60"
            cy="60"
            r="52"
            :stroke="ringColor"
            :stroke-dasharray="RING"
            :stroke-dashoffset="ringOffset"
          />
        </svg>
        <div class="q-ach__ring-text">
          <b class="q-num">{{ stats.accuracy }}<i>%</i></b>
          <span class="q-dim">正确率</span>
        </div>
      </div>

      <!-- ── 数据 ── -->
      <ul class="q-ach__stats">
        <li><b class="q-num q-ach__ok">{{ stats.ok }}</b><span>答对</span></li>
        <li><b class="q-num q-ach__bad">{{ stats.bad }}</b><span>答错</span></li>
        <li><b class="q-num">{{ bestStreak }}</b><span>最长连对</span></li>
        <li><b class="q-num">{{ stats.unanswered }}</b><span>未作答</span></li>
      </ul>

      <!-- ── 播放器 ── -->
      <section class="q-ach__player">
        <div class="q-ach__player-head">
          <el-icon :size="13"><Headset /></el-icon>
          <span>{{ hasOwn ? '边听边看' : '奖励一首' }}</span>
          <span v-if="hasOwn" class="q-dim">共 {{ tracks.length }} 首</span>
          <a
            v-if="!hasOwn && neteaseSrc"
            class="q-ach__link"
            :href="neteasePageUrl(neteaseKind, neteaseId)"
            target="_blank"
            rel="noopener noreferrer"
          >
            在新窗口打开 ↗
          </a>
        </div>

        <!-- ① 自己的 mp3 → 全局那个 APlayer 搬到这里（见文件头） -->
        <div v-if="hasOwn" ref="playerHost" class="q-ach__ap"></div>

        <!-- ② 只配了网易云 id → 官方外链 -->
        <div v-else-if="neteaseSrc" class="q-ach__frame-wrap" :style="{ height: neteaseHeight + 'px' }">
          <iframe
            class="q-ach__frame"
            :src="neteaseSrc"
            :height="neteaseHeight"
            frameborder="no"
            allow="autoplay"
            loading="lazy"
            referrerpolicy="no-referrer"
          ></iframe>
        </div>

        <!-- ③ 什么都没配 -->
        <p v-else class="q-ach__hint">
          想在这儿放首歌的话，打开「设置 → 音乐」：<br />
          填<b>自己的 mp3 直链</b>（一行一首，可带封面和歌词，会用上完整播放器），
          或者填<b>网易云歌曲 id</b>（用官方外链）。
        </p>

        <!--
          ⚠️ 这条必须放在 v-if/v-else-if/v-else **链条之外**。
          原来它插在 `v-if="hasOwn"` 和 `v-else-if="neteaseSrc"` 中间，
          于是 Vue 把 v-else-if/v-else 挂到了它身上（链条被它截断了）——
          表现是：配了 mp3、APlayer 正常显示，**下面却还多出一段"想放首歌的话…"**。
        -->
        <p v-if="player.error" class="q-ach__hint q-ach__hint--bad">
          播放器：{{ player.error }}
        </p>

        <p v-if="skippedLines.length" class="q-ach__hint q-ach__hint--bad">
          有 {{ skippedLines.length }} 行没认出来（每行是 http(s) 地址，或「名字 | 地址 | 封面 | 歌词」）：
          <code>{{ skippedLines[0].slice(0, 60) }}</code>
        </p>
      </section>

      <!-- ── 操作 ── -->
      <footer class="q-ach__acts">
        <el-button type="primary" size="large" @click="emit('restart')">再来一轮</el-button>
        <el-button v-if="stats.bad" size="large" @click="emit('review')">
          把 {{ stats.bad }} 道错题过一遍
        </el-button>
        <el-button text @click="emit('close')">先看解析</el-button>
      </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.q-ach {
  position: fixed;
  inset: 0;
  z-index: 300; /* 盖住右下角的播放器（200）和设置抽屉（Element Plus 默认 2000+ 时要在它下面）*/
  display: grid;
  place-items: center;
  padding: 20px;
  overflow: auto;
  background: color-mix(in srgb, var(--q-bg-deep, #080a0f) 72%, transparent);
  backdrop-filter: blur(18px) saturate(1.3);
  animation: q-ach-in 0.32s var(--q-ease) both;
}
@keyframes q-ach-in {
  from {
    opacity: 0;
  }
}

/* 背后一圈光晕：让"成就"这件事有点仪式感 */
.q-ach__glow {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(42% 34% at 50% 34%, color-mix(in srgb, var(--q-brand-1) 40%, transparent), transparent 70%),
    radial-gradient(36% 30% at 76% 74%, color-mix(in srgb, var(--q-brand-3, #ec4899) 26%, transparent), transparent 72%);
  animation: q-ach-breathe 6s ease-in-out infinite;
}
@keyframes q-ach-breathe {
  50% {
    opacity: 0.62;
  }
}

.q-ach__card {
  position: relative;
  width: min(560px, 100%);
  padding: 26px 26px 20px;
  border-radius: 24px;
  border: 1px solid var(--q-border);
  background: color-mix(in srgb, var(--q-surface) 92%, transparent);
  box-shadow: 0 40px 90px -30px rgb(20 26 46 / 0.5);
  animation: q-ach-pop 0.42s var(--q-ease) both;
}
@keyframes q-ach-pop {
  from {
    opacity: 0;
    transform: translateY(18px) scale(0.96);
  }
}
html.dark .q-ach__card {
  box-shadow: 0 40px 90px -30px rgb(0 0 0 / 0.7);
}

/* ---------- 评价 ---------- */
.q-ach__head {
  text-align: center;
}
.q-ach__emoji {
  font-size: 40px;
  line-height: 1;
  display: block;
  margin-bottom: 6px;
}
.q-ach__title {
  margin: 0;
  font-size: 25px;
  font-weight: 800;
  letter-spacing: 0.01em;
  color: var(--q-text);
}
.q-ach__sub {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--q-text-2);
}
.q-ach__mode {
  margin: 8px 0 0;
  font-size: 12px;
}

/* ---------- 正确率环 ---------- */
.q-ach__ring {
  position: relative;
  width: 168px;
  height: 168px;
  margin: 14px auto 4px;
}
.q-ach__ring svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}
.q-ach__ring circle {
  fill: none;
  stroke-width: 9;
  stroke-linecap: round;
}
.q-ach__ring-track {
  stroke: var(--q-surface-3);
}
.q-ach__ring-value {
  transition: stroke-dashoffset 0.9s var(--q-ease);
}
.q-ach__ring-text {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
}
.q-ach__ring-text b {
  font-size: 40px;
  font-weight: 800;
  color: var(--q-text);
  line-height: 1;
}
.q-ach__ring-text b i {
  font-style: normal;
  font-size: 19px;
  margin-left: 1px;
}
.q-ach__ring-text span {
  font-size: 12px;
}

/* ---------- 数据 ---------- */
.q-ach__stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin: 14px 0 4px;
  padding: 0;
  list-style: none;
}
.q-ach__stats li {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 10px 4px;
  border-radius: 14px;
  background: var(--q-surface-2);
}
.q-ach__stats b {
  font-size: 21px;
  font-weight: 800;
  color: var(--q-text);
  line-height: 1;
}
.q-ach__stats span {
  font-size: 11.5px;
  color: var(--q-text-3);
}
.q-ach__ok {
  color: var(--q-ok) !important;
}
.q-ach__bad {
  color: var(--q-bad) !important;
}

/* ---------- 播放器 ---------- */
.q-ach__player {
  margin-top: 16px;
  padding: 12px;
  border-radius: 16px;
  border: 1px solid var(--q-border);
  background: var(--q-surface-2);
}
.q-ach__player-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--q-text-2);
}
.q-ach__player-head .q-dim {
  font-weight: 400;
}
.q-ach__link {
  margin-left: auto;
  font-weight: 400;
  font-size: 11.5px;
  color: var(--q-brand-1);
  text-decoration: none;
}
.q-ach__link:hover {
  text-decoration: underline;
}
.q-ach__frame-wrap {
  position: relative;
  width: 100%;
  border-radius: 12px;
  overflow: hidden;
}
.q-ach__frame {
  display: block;
  width: 100%;
  border: 0;
}
.q-ach__hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--q-text-3);
}
.q-ach__hint--bad {
  margin-top: 8px;
  color: var(--q-warn);
}
.q-ach__hint code {
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--q-surface-3);
  font-size: 11px;
}

/*
 * APlayer 默认是**浅色硬编码**（白底黑字），和本站的深色主题打架。
 * 这里按本站的 CSS 变量覆盖它的关键几处。
 *
 * ⚠️ 2026-10-08 修：原来这些全写成 `.q-ach__ap :deep(.aplayer …)`，
 * 而 APlayer 是**把类加在容器本身**上的（`container.classList.add('aplayer')`）——
 * `.q-ach__ap` 这个 div 自己就是 `.aplayer`，找"后代 .aplayer"永远找不到，
 * 这套覆盖**一直是死代码**（深色主题下播放器依然是白底，只是没人仔细看）。
 * 现在：容器本身直接写 `.q-ach__ap`；里面的元素才是后代，继续用 :deep()。
 */
.q-ach__ap {
  border-radius: 12px;
  border: 1px solid var(--q-border);
  background: var(--q-surface);
  color: var(--q-text);
  box-shadow: none;
  margin: 0;
}
.q-ach__ap :deep(.aplayer-info) {
  border-bottom-color: var(--q-border);
}
.q-ach__ap :deep(.aplayer-info .aplayer-music .aplayer-title) {
  color: var(--q-text);
}
.q-ach__ap :deep(.aplayer-info .aplayer-music .aplayer-author),
.q-ach__ap :deep(.aplayer-info .aplayer-controller .aplayer-time) {
  color: var(--q-text-3);
}
.q-ach__ap :deep(.aplayer-info .aplayer-controller .aplayer-bar-wrap .aplayer-bar) {
  background: var(--q-surface-3);
}
.q-ach__ap :deep(.aplayer-list) {
  border-top-color: var(--q-border);
}
.q-ach__ap :deep(.aplayer-list ol li) {
  border-top-color: var(--q-border);
  color: var(--q-text-2);
}
.q-ach__ap :deep(.aplayer-list ol li .aplayer-list-index),
.q-ach__ap :deep(.aplayer-list ol li .aplayer-list-author) {
  color: var(--q-text-3);
}
.q-ach__ap :deep(.aplayer-list ol li:hover) {
  background: var(--q-surface-2);
}
.q-ach__ap :deep(.aplayer-list ol li.aplayer-list-light) {
  background: color-mix(in srgb, var(--q-brand-1) 12%, transparent);
}
.q-ach__ap :deep(.aplayer-list ol li.aplayer-list-light .aplayer-list-title) {
  color: var(--q-brand-1);
}
/*
 * 歌词区**不要**再写 `display: none` 了（原来这里有一条）：
 * 现在播放列表支持「名字 | 地址 | 封面 | 歌词」，配了歌词就真的该滚起来；
 * 没配歌词时 APlayer 自己会给它加 `aplayer-lrc-hide`（它的 CSS 里
 * `.aplayer-lrc-hide{display:none}`），用不着我们一刀切掉。
 */
.q-ach__ap :deep(.aplayer-lrc p) {
  color: var(--q-text-2);
}
.q-ach__ap :deep(.aplayer-lrc p.aplayer-lrc-current) {
  color: var(--q-text);
}

/* ---------- 操作 ---------- */
.q-ach__acts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 18px;
}
.q-ach__acts :deep(.el-button + .el-button) {
  margin-left: 0;
}

@media (max-width: 520px) {
  .q-ach__card {
    padding: 20px 16px 16px;
  }
  .q-ach__ring {
    width: 142px;
    height: 142px;
  }
  .q-ach__stats {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (prefers-reduced-motion: reduce) {
  .q-ach,
  .q-ach__card,
  .q-ach__glow {
    animation: none;
  }
}
</style>
