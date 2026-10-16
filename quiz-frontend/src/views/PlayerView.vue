<script setup>
/**
 * PlayerView —— 专门的播放页（`#/player`）。
 *
 * 为什么单独做一个页面，而不是把右下角那个面板做大：
 *   面板的定位是"随时能摸到的小控件"，它必须小、必须让路（答题时挡视线）；
 *   播放页的定位是"我想好好听一首歌、看着歌词跟唱"。这两个目标**互相打架**，
 *   硬塞进一个组件只会两头都不像。所以：面板负责"控制"，播放页负责"沉浸"。
 *
 * 视觉上要像商业播放器，靠的是这几件事（不是堆特效）：
 *   ① **封面当背景**：整页铺一张放大 + 高斯模糊 + 压暗的封面，颜色跟着封面走。
 *      没有封面时用主题色渐变兜底，不能出现"一张灰底"。
 *   ② **歌词是主角**：当前行最大最亮、相邻行逐级变淡，整块平滑上滚；
 *      点任意一行跳到那句（这是"看着歌词听"最实际的操作）。
 *   ③ **底部一条完整的播放条**：进度（可拖）、上一首/播放/下一首、音量、模式、播放列表。
 *   ④ 转录：一切数据都来自 stores/player.js 那个**全局单例**，
 *      所以从这个页面切到刷题页，音乐不会断（同一个实例，只是换了容器）。
 *
 * ⚠️ 两条实现上的取舍：
 *   1. **不自己 new 播放器**。进页面时如果还没有实例（比如用户没开右下角那个开关），
 *      就把单例挂到本页一个**屏幕外的容器**上（引擎用），页面上显示的是我们自己画的 UI。
 *      离开页面时 release，右下角面板会自动接回去。
 *   2. **歌词取不到就老实说取不到**（含跨域这种常见原因），不编、不占位假装。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import { useQuizStore } from '@/stores/quiz'
import { usePlayerStore } from '@/stores/player'
import { clock } from '@/core/lyrics'

const router = useRouter()
const quiz = useQuizStore()
const player = usePlayerStore()

/** 屏幕外的引擎容器：APlayer 只用来出声，界面我们自己画 */
const engineHost = ref(null)
/** 播放列表抽屉 */
const showList = ref(false)
/** 歌词区容器（自动滚动要算它的高度） */
const lyricBox = ref(null)
const lyricList = ref(null)

const hasTracks = computed(() => player.hasTracks)
const track = computed(() => player.current)
const cover = computed(() => player.cover)
const active = computed(() => player.lyricActive)
const MODE_LABEL = { list: '顺序', random: '随机', single: '单曲' }
const modeLabel = computed(() => MODE_LABEL[player.mode] || '顺序')

/** 背景层：把封面放大模糊后铺满。没有封面就用主题色渐变 */
const backdrop = computed(() =>
  cover.value
    ? { backgroundImage: `url('${cover.value}')` }
    : { backgroundImage: '' },
)

/* ------------------------------------------------------------------ *
 * 引擎：进页面时确保有实例；离开时交还
 * ------------------------------------------------------------------ */

function ensureEngine() {
  // 已经有实例（右下角面板拿着，或成就页拿着）就别抢 —— 抢了歌会重新缓冲一次
  if (player.owner || !hasTracks.value || !engineHost.value) return
  player.attach(engineHost.value, 'player')
}

watchEffect(ensureEngine)
onMounted(ensureEngine)
onBeforeUnmount(() => player.release('player'))

/* ------------------------------------------------------------------ *
 * 交互
 * ------------------------------------------------------------------ */

function seekRatio(event) {
  const box = event.currentTarget?.getBoundingClientRect()
  if (!box?.width) return
  player.seekRatio((event.clientX - box.left) / box.width)
}

function jumpTo(line) {
  if (!player.hasLyrics || !line || line.time < 0) return
  player.seek(line.time)
  player.toggle(true) // 点歌词 = 我要听这句
}

function onKey(event) {
  // 别抢输入框的键（设置里可能在打字）。
  // ⚠️ 用 toLowerCase 比较，而不是直接写 tagName 的大写常量：
  // tools/check_sfc.mjs 会把全大写的字符串当组件名核对，于是报"这不是组件"。
  // （那个体检**不剥注释**，所以注释里也别写大写常量 —— 这里踩过两次。）
  const tag = String(event.target?.tagName || '').toLowerCase()
  if (tag === 'input' || tag === 'textarea' || event.target?.isContentEditable) return
  switch (event.key) {
    case ' ':
      event.preventDefault()
      player.toggle()
      break
    case 'ArrowRight':
      player.seek(player.time + 5)
      break
    case 'ArrowLeft':
      player.seek(player.time - 5)
      break
    case 'ArrowUp':
      player.setVolume(Math.min(1, Number(quiz.settings.musicVolume || 0) + 0.05))
      break
    case 'ArrowDown':
      player.setVolume(Math.max(0, Number(quiz.settings.musicVolume || 0) - 0.05))
      break
    case 'n':
      player.next()
      break
    case 'p':
      player.prev()
      break
    case 'l':
      showList.value = !showList.value
      break
    default:
      break
  }
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

/* ------------------------------------------------------------------ *
 * 歌词自动滚动
 * ------------------------------------------------------------------ */

/**
 * 让当前行停在歌词区的**中间**。
 *
 * 为什么用 translateY 而不是 scrollTop：
 *   看起来更顺（可以加 transition），也不会被用户的滚动条打断。
 * 只在当前行变化时动一次，不是每帧都动 —— 每帧动会让歌词"飘"。
 */
const scrollY = ref(0)
watch(active, () => {
  const box = lyricBox.value
  const list = lyricList.value
  if (!box || !list) return
  const rows = list.children
  // ★ 还没到第一句（active = -1）时按**第一句**居中：
  //   直接 scrollY = 0 会把整块歌词顶到可视区外面（浅色主题那次就是这么"整块看不见"的）
  const row = rows[active.value < 0 ? 0 : active.value]
  if (!row) {
    scrollY.value = 0
    return
  }
  const mid = box.clientHeight / 2
  const target = row.offsetTop + row.offsetHeight / 2
  // ★ 允许**负值**：第一句要能停在正中间（内容整体往下挪）。
  //   夹到 0 的话第一句只能贴顶、还被渐隐吃掉一半。
  scrollY.value = target - mid
})
</script>

<template>
  <div class="q-pl">
    <!-- 背景：封面放大模糊 + 压暗。没有封面时这层是主题色渐变（见 backdrop 的计算） -->
    <div class="q-pl__bg" :style="backdrop" aria-hidden="true"></div>
    <div class="q-pl__veil" aria-hidden="true"></div>

    <!-- 顶栏 -->
    <header class="q-pl__head">
      <button class="q-pl__back" title="回到刷题（音乐会继续放）" @click="router.push('/')">
        <el-icon :size="16"><ArrowLeft /></el-icon>
        <span>返回刷题</span>
      </button>
      <div class="q-pl__head-mid">
        <span class="q-pl__badge">正在播放</span>
        <span v-if="hasTracks" class="q-pl__count">{{ player.index + 1 }} / {{ player.tracks.length }}</span>
      </div>
      <button class="q-pl__icon" :class="{ 'is-on': showList }" title="播放列表（L）" @click="showList = !showList">
        <el-icon :size="16"><List /></el-icon>
      </button>
    </header>

    <!-- 没配音乐：老实引导，不要给一个空壳页面 -->
    <div v-if="!hasTracks" class="q-pl__empty">
      <el-icon :size="34"><Headset /></el-icon>
      <h2>还没有可播放的歌</h2>
      <p>
        打开「设置 → 音乐」，往<b>自己的音乐</b>里填 mp3 直链（一行一首，可带封面和歌词）：
      </p>
      <pre class="q-pl__hint">晴天 | https://example.com/qing.mp3 | https://example.com/qing.jpg | https://example.com/qing.lrc</pre>
      <p class="q-dim">
        网易云的<b>网页地址</b>（<code>music.163.com/song?id=…</code>）不能当音频播 ——
        那种地址请填到上面的「ID」里，用官方外链播放器。
      </p>
      <el-button type="primary" @click="router.push('/')">去设置</el-button>
    </div>

    <main v-else class="q-pl__body">
      <!-- 左：封面 + 曲目信息 -->
      <section class="q-pl__left">
        <div class="q-pl__art" :class="{ 'is-playing': player.playing }">
          <img v-if="cover" :src="cover" :alt="track?.name || '封面'" />
          <div v-else class="q-pl__art-fallback" aria-hidden="true">
            <el-icon :size="52"><Headset /></el-icon>
          </div>
        </div>
        <h1 class="q-pl__title">{{ track?.name || '未命名' }}</h1>
        <p class="q-pl__sub">
          <span>{{ player.lyricArtist || '我的音乐' }}</span>
          <span v-if="player.lyricTitle" class="q-dim">· {{ player.lyricTitle }}</span>
        </p>
        <a v-if="track?.url" class="q-pl__src" :href="track.url" target="_blank" rel="noopener noreferrer">
          音频地址 ↗
        </a>
      </section>

      <!-- 右：歌词（主角） -->
      <section class="q-pl__right">
        <div ref="lyricBox" class="q-pl__lyric">
          <div
            ref="lyricList"
            class="q-pl__lyric-inner"
            :class="{ 'is-static': !player.lyricSynced }"
            :style="{ transform: `translateY(${-scrollY}px)` }"
          >
            <p
              v-for="(line, i) in player.lyricLines"
              :key="i"
              class="q-pl__line"
              :class="{ 'is-active': i === active, 'is-past': i < active }"
              :title="line.time >= 0 ? `跳到 ${clock(line.time)}` : ''"
              @click="jumpTo(line)"
            >
              <span class="q-pl__line-text">{{ line.text || '♪' }}</span>
              <span v-if="line.time >= 0" class="q-pl__line-time">{{ clock(line.time) }}</span>
            </p>
          </div>

          <div v-if="player.lyricStatus === 'loading'" class="q-pl__lyric-note">正在取歌词…</div>
          <div v-else-if="player.lyricStatus === 'none'" class="q-pl__lyric-note">
            <template v-if="track?.lrc">这句歌没有歌词内容（那个 .lrc 是空的）</template>
            <template v-else>
              这首歌没有配歌词。在曲库里加第四段就行：<br />
              <code>{{ track?.name || '歌名' }} | 音频地址 | 封面地址 | 歌词.lrc 地址</code>
            </template>
          </div>
          <div v-else-if="player.lyricStatus === 'error'" class="q-pl__lyric-note is-bad">
            取歌词失败：{{ player.lyricError }}<br />
            <span class="q-dim">（.lrc 所在的服务器要允许跨域；放在本站里的文件天然可以）</span>
          </div>
        </div>
      </section>
    </main>

    <!-- 底部播放条 -->
    <footer v-if="hasTracks" class="q-pl__bar">
      <div class="q-pl__bar-left">
        <img v-if="cover" class="q-pl__mini" :src="cover" alt="" />
        <div class="q-pl__mini-meta">
          <strong>{{ track?.name || '未命名' }}</strong>
          <span class="q-dim">{{ player.lyricArtist || '我的音乐' }}</span>
        </div>
      </div>

      <div class="q-pl__bar-mid">
        <div class="q-pl__transport">
          <button class="q-pl__icon" title="上一首（P）" @click="player.prev()">
            <el-icon :size="18"><ArrowLeftBold /></el-icon>
          </button>
          <button class="q-pl__play" :title="player.playing ? '暂停（空格）' : '播放（空格）'" @click="player.toggle()">
            <el-icon :size="24">
              <VideoPause v-if="player.playing" />
              <VideoPlay v-else />
            </el-icon>
          </button>
          <button class="q-pl__icon" title="下一首（N）" @click="player.next()">
            <el-icon :size="18"><ArrowRightBold /></el-icon>
          </button>
        </div>
        <div class="q-pl__track" role="presentation" @click="seekRatio">
          <span class="q-pl__time">{{ player.timeText }}</span>
          <span class="q-pl__rail"><i :style="{ width: `${Math.round(player.progress * 100)}%` }"></i></span>
          <span class="q-pl__time">{{ player.durationText }}</span>
        </div>
      </div>

      <div class="q-pl__bar-right">
        <button class="q-pl__icon q-pl__mode" :title="`播放模式：${modeLabel}（点击切换）`" @click="player.cycleMode()">
          {{ modeLabel }}
        </button>
        <el-icon :size="15" class="q-pl__vol-icon"><Headset /></el-icon>
        <el-slider
          class="q-pl__vol"
          :model-value="Number(quiz.settings.musicVolume ?? 0.8)"
          :min="0"
          :max="1"
          :step="0.05"
          :show-tooltip="false"
          @update:model-value="(v) => player.setVolume(v)"
        />
      </div>
    </footer>

    <!-- 出错时才说话：把地址亮出来，别让用户对着"放不出来"发呆 -->
    <p v-if="player.error" class="q-pl__err">
      {{ player.error }}
      <template v-if="player.errorUrl">
        ：<code>{{ player.errorUrl }}</code>
      </template>
      <br />
      <span class="q-dim">
        地址失效 / 跨域被拦 / 断网都会这样。如果是 <code>music.163.com/song?id=…</code>
        这种网页地址，它不是音频文件 —— 请填到设置里的「ID」用官方外链。
      </span>
    </p>

    <!-- 播放列表抽屉 -->
    <transition name="q-pl-list">
      <aside v-if="showList" class="q-pl__list">
        <header>
          <strong>播放列表</strong>
          <button class="q-pl__icon" title="关闭" @click="showList = false">
            <el-icon :size="14"><Close /></el-icon>
          </button>
        </header>
        <ol>
          <li
            v-for="(t, i) in player.tracks"
            :key="t.url"
            :class="{ 'is-active': i === player.index }"
            @click="player.playAt(i)"
          >
            <span class="q-pl__list-no">{{ i + 1 }}</span>
            <span class="q-pl__list-name">{{ t.name }}</span>
            <el-icon v-if="i === player.index && player.playing" :size="13"><VideoPause /></el-icon>
            <el-icon v-else-if="i === player.index" :size="13"><VideoPlay /></el-icon>
          </li>
        </ol>
      </aside>
    </transition>

    <!-- 引擎容器：屏幕外。APlayer 只用来出声，界面全部由上面这些画 -->
    <div ref="engineHost" class="q-pl__engine" aria-hidden="true"></div>
  </div>
</template>

<style scoped>
.q-pl {
  position: relative;
  min-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--q-text);
}

/* ---------- 背景：封面模糊铺满 + 压暗纱 ---------- */
.q-pl__bg {
  position: fixed;
  inset: -8%;
  z-index: 0;
  background:
    radial-gradient(120% 80% at 20% 0%, color-mix(in srgb, var(--q-brand-1) 55%, transparent), transparent 60%),
    radial-gradient(120% 80% at 90% 20%, color-mix(in srgb, var(--q-brand-3, #ec4899) 45%, transparent), transparent 65%),
    var(--q-surface);
  background-size: cover;
  background-position: center;
  filter: blur(58px) saturate(1.7);
  transform: scale(1.12);
  opacity: 0.85;
}
.q-pl__veil {
  position: fixed;
  inset: 0;
  z-index: 0;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--q-bg-deep, #080a0f) 55%, transparent),
    color-mix(in srgb, var(--q-bg-deep, #080a0f) 78%, transparent)
  );
  backdrop-filter: blur(2px);
}

.q-pl__head,
.q-pl__body,
.q-pl__bar,
.q-pl__empty,
.q-pl__err {
  position: relative;
  z-index: 2;
}

/* ---------- 顶栏 ---------- */
.q-pl__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 22px;
}
.q-pl__back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: 99px;
  border: 1px solid color-mix(in srgb, var(--q-brand-1) 28%, var(--q-border));
  background: color-mix(in srgb, var(--q-surface) 60%, transparent);
  backdrop-filter: blur(12px);
  color: var(--q-text);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.q-pl__back:hover {
  border-color: var(--q-brand-1);
}
.q-pl__head-mid {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.q-pl__badge {
  font-size: 11px;
  letter-spacing: 0.08em;
  padding: 3px 9px;
  border-radius: 99px;
  color: #fff;
  background: linear-gradient(90deg, var(--q-brand-1), var(--q-brand-3, #ec4899));
}
.q-pl__count {
  font-size: 11.5px;
  color: var(--q-text-3);
  font-variant-numeric: tabular-nums;
}
.q-pl__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 32px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--q-text-2);
  cursor: pointer;
  font: inherit;
  font-size: 11.5px;
  transition: background 0.18s var(--q-ease), color 0.18s var(--q-ease);
}
.q-pl__icon:hover,
.q-pl__icon.is-on {
  background: color-mix(in srgb, var(--q-brand-1) 16%, transparent);
  color: var(--q-text);
}
.q-pl__mode {
  padding: 0 10px;
  border-radius: 99px;
}

/* ---------- 主体：封面 + 歌词 ---------- */
.q-pl__body {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(240px, 340px) 1fr;
  gap: 34px;
  align-items: center;
  /* 上边要留够：歌词区是"当前行居中"的，贴到顶栏上会把当前行裁掉（截图里就是这个症状） */
  padding: 18px 40px 12px;
  min-height: 0;
}
.q-pl__left {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.q-pl__art {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  border-radius: 18px;
  overflow: hidden;
  background: linear-gradient(140deg, var(--q-brand-1), var(--q-brand-3, #ec4899));
  box-shadow: 0 30px 70px -28px rgb(6 10 24 / 0.75), 0 2px 0 0 rgb(255 255 255 / 0.06) inset;
  transition: transform 0.4s var(--q-ease);
}
.q-pl__art.is-playing {
  transform: translateY(-4px) scale(1.012);
}
.q-pl__art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.q-pl__art-fallback {
  display: grid;
  place-items: center;
  height: 100%;
  color: rgb(255 255 255 / 0.72);
}
.q-pl__title {
  margin: 4px 0 0;
  font-size: 21px;
  font-weight: 800;
  letter-spacing: -0.01em;
  line-height: 1.25;
}
.q-pl__sub {
  margin: 0;
  font-size: 12.5px;
  color: var(--q-text-2);
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.q-pl__src {
  font-size: 11.5px;
  color: var(--q-brand-1);
  text-decoration: none;
  width: fit-content;
}
.q-pl__src:hover {
  text-decoration: underline;
}

/* ---------- 歌词 ---------- */
.q-pl__right {
  min-height: 0;
  height: 100%;
}
.q-pl__lyric {
  position: relative;
  height: min(52vh, 420px);
  overflow: hidden;
  /* 上下淡出：让歌词像"从雾里进来"。这是商业播放器最标志性的一处细节 */
  mask-image: linear-gradient(180deg, transparent 0, #000 16%, #000 80%, transparent 100%);
  -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 16%, #000 80%, transparent 100%);
}
.q-pl__lyric-inner {
  /* ★ 这里**不要**留 padding 来"让第一句居中"：
     padding 的百分比是按**宽度**算的（歌词区宽 986px × 44% ≈ 434px），
     框高才 420px —— 于是内容被顶到框外面，浅色主题下整块歌词直接看不见。
     居中改由 JS 算 translateY（允许负值），见 scrollY 的计算。 */
  transition: transform 0.45s cubic-bezier(0.22, 0.61, 0.36, 1);
  will-change: transform;
}
.q-pl__lyric-inner.is-static {
  transition: none;
}
.q-pl__line {
  display: flex;
  align-items: baseline;
  gap: 14px;
  margin: 0;
  padding: 7px 10px 7px 4px;
  border-radius: 10px;
  cursor: pointer;
  font-size: 17px;
  font-weight: 600;
  line-height: 1.5;
  color: color-mix(in srgb, var(--q-text) 42%, transparent);
  transform-origin: left center;
  transition: color 0.3s var(--q-ease), transform 0.3s var(--q-ease), opacity 0.3s var(--q-ease);
}
.q-pl__line:hover {
  color: var(--q-text-2);
  background: color-mix(in srgb, var(--q-surface) 30%, transparent);
}
.q-pl__line.is-past {
  color: color-mix(in srgb, var(--q-text) 26%, transparent);
}
/*
 * 当前行：更大、更亮、带品牌色光晕 —— 一眼就知道唱到哪。
 *
 * ⚠️ 颜色**必须跟着主题走**：一开始直接写死白色 + 白色渐变文字，
 * 浅色主题下就成了"白字白底"，当前行整个看不见（截图才发现）。
 * 这里用 html.dark 分两套：深色用白 + 渐变，浅色用品牌色 + 深色字。
 */
.q-pl__line.is-active {
  color: var(--q-brand-1);
  font-size: 22px;
  font-weight: 800;
  transform: scale(1.02);
  text-shadow: 0 2px 20px color-mix(in srgb, var(--q-brand-1) 26%, transparent);
}
html.dark .q-pl__line.is-active {
  color: #fff;
  text-shadow: 0 2px 24px color-mix(in srgb, var(--q-brand-1) 65%, transparent);
}
/* 深色下再叠一层渐变文字：浅色下这招会把字"洗没"，所以只在暗色用 */
html.dark .q-pl__line.is-active .q-pl__line-text {
  background: linear-gradient(90deg, #fff, color-mix(in srgb, var(--q-brand-3, #ec4899) 55%, #fff));
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
.q-pl__line-time {
  font-size: 11px;
  color: var(--q-text-3);
  font-variant-numeric: tabular-nums;
  opacity: 0;
  transition: opacity 0.2s var(--q-ease);
}
.q-pl__line:hover .q-pl__line-time,
.q-pl__line.is-active .q-pl__line-time {
  opacity: 1;
}
.q-pl__lyric-note {
  position: absolute;
  left: 12px;
  top: 42%;
  font-size: 13px;
  line-height: 1.9;
  color: var(--q-text-3);
  max-width: 92%;
}
.q-pl__lyric-note.is-bad {
  color: var(--q-warn);
}
.q-pl__lyric-note code {
  padding: 1px 6px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--q-surface) 70%, transparent);
  font-size: 11.5px;
}

/* ---------- 底部播放条 ---------- */
.q-pl__bar {
  display: grid;
  grid-template-columns: minmax(160px, 240px) 1fr minmax(160px, 240px);
  align-items: center;
  gap: 18px;
  margin: 0 18px 16px;
  padding: 12px 18px;
  border-radius: 18px;
  border: 1px solid color-mix(in srgb, var(--q-brand-1) 22%, var(--q-border));
  background: color-mix(in srgb, var(--q-surface) 62%, transparent);
  backdrop-filter: blur(22px) saturate(1.5);
  box-shadow: 0 24px 60px -30px rgb(6 10 24 / 0.8);
}
.q-pl__bar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.q-pl__mini {
  width: 40px;
  height: 40px;
  border-radius: 9px;
  object-fit: cover;
  flex: none;
}
.q-pl__mini-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.q-pl__mini-meta strong {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.q-pl__mini-meta span {
  font-size: 11px;
}
.q-pl__bar-mid {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.q-pl__transport {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}
.q-pl__play {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border: 0;
  border-radius: 50%;
  color: #fff;
  background: linear-gradient(135deg, var(--q-brand-1), var(--q-brand-3, #ec4899));
  box-shadow: 0 12px 30px -10px color-mix(in srgb, var(--q-brand-1) 80%, transparent);
  cursor: pointer;
  transition: transform 0.18s var(--q-ease), box-shadow 0.24s var(--q-ease);
}
.q-pl__play:hover {
  transform: scale(1.06);
  box-shadow: 0 16px 38px -10px color-mix(in srgb, var(--q-brand-1) 90%, transparent);
}
.q-pl__track {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
}
.q-pl__time {
  font-size: 11px;
  color: var(--q-text-3);
  font-variant-numeric: tabular-nums;
  min-width: 36px;
  text-align: center;
}
.q-pl__rail {
  position: relative;
  flex: 1;
  height: 5px;
  border-radius: 99px;
  background: color-mix(in srgb, var(--q-text) 16%, transparent);
  overflow: hidden;
}
.q-pl__rail i {
  display: block;
  height: 100%;
  border-radius: 99px;
  background: linear-gradient(90deg, var(--q-brand-1), var(--q-brand-3, #ec4899));
  transition: width 0.15s linear;
}
.q-pl__bar-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.q-pl__vol {
  width: 96px;
}
.q-pl__vol-icon {
  color: var(--q-text-3);
}

/* ---------- 空态 / 报错 ---------- */
.q-pl__empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  text-align: center;
  padding: 30px;
}
.q-pl__empty h2 {
  margin: 6px 0 0;
  font-size: 19px;
}
.q-pl__empty p {
  margin: 0;
  max-width: 620px;
  font-size: 13px;
  line-height: 1.9;
  color: var(--q-text-2);
}
.q-pl__hint {
  margin: 2px 0;
  padding: 10px 14px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--q-surface) 70%, transparent);
  font-size: 12px;
  color: var(--q-text-2);
  max-width: 100%;
  overflow-x: auto;
}
.q-pl__err {
  margin: 0 22px 10px;
  padding: 10px 14px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--q-warn) 40%, transparent);
  background: color-mix(in srgb, var(--q-warn) 12%, transparent);
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--q-warn);
}
.q-pl__err code {
  font-size: 11.5px;
  word-break: break-all;
}

/* ---------- 播放列表抽屉 ---------- */
.q-pl__list {
  position: absolute;
  top: 58px;
  right: 18px;
  z-index: 6;
  width: min(340px, calc(100vw - 36px));
  max-height: min(58vh, 460px);
  display: flex;
  flex-direction: column;
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, var(--q-brand-1) 26%, var(--q-border));
  background: color-mix(in srgb, var(--q-surface) 88%, transparent);
  backdrop-filter: blur(24px) saturate(1.5);
  box-shadow: 0 30px 70px -28px rgb(6 10 24 / 0.8);
  overflow: hidden;
}
.q-pl__list header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--q-border);
  font-size: 12.5px;
}
.q-pl__list ol {
  list-style: none;
  margin: 0;
  padding: 6px;
  overflow-y: auto;
}
.q-pl__list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 9px;
  font-size: 12.5px;
  color: var(--q-text-2);
  cursor: pointer;
}
.q-pl__list li:hover {
  background: color-mix(in srgb, var(--q-brand-1) 12%, transparent);
}
.q-pl__list li.is-active {
  color: var(--q-brand-1);
  font-weight: 700;
  background: color-mix(in srgb, var(--q-brand-1) 14%, transparent);
}
.q-pl__list-no {
  width: 18px;
  text-align: right;
  color: var(--q-text-3);
  font-variant-numeric: tabular-nums;
}
.q-pl__list-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.q-pl-list-enter-active,
.q-pl-list-leave-active {
  transition: opacity 0.2s var(--q-ease), transform 0.2s var(--q-ease);
}
.q-pl-list-enter-from,
.q-pl-list-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

/* 引擎容器：留在布局里但不可见（APlayer 建实例要量尺寸，不能用 display:none） */
.q-pl__engine {
  position: fixed;
  left: -10000px;
  bottom: 0;
  width: 320px;
  height: 90px;
  overflow: hidden;
  pointer-events: none;
}

/* 浅色主题：背景纱要更实一点，否则白底 + 浅色渐变会让歌词"发飘"看不到层次 */
html:not(.dark) .q-pl__veil {
  background: linear-gradient(
    180deg,
    rgb(255 255 255 / 0.72),
    rgb(248 248 252 / 0.86)
  );
}

@media (max-width: 900px) {
  .q-pl__body {
    grid-template-columns: 1fr;
    gap: 18px;
    padding: 4px 18px 10px;
  }
  .q-pl__left {
    align-items: center;
    text-align: center;
  }
  .q-pl__art {
    width: min(52vw, 220px);
  }
  .q-pl__src {
    margin: 0 auto;
  }
  .q-pl__lyric {
    height: 34vh;
  }
  .q-pl__bar {
    grid-template-columns: 1fr;
    gap: 10px;
  }
  .q-pl__bar-left,
  .q-pl__bar-right {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .q-pl__art,
  .q-pl__play,
  .q-pl__lyric-inner,
  .q-pl__line {
    transition: none;
  }
}
</style>
