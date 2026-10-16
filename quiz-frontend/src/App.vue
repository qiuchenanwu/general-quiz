<script setup>
/**
 * App —— 全局外壳：顶栏（品牌 / 当前题库 / 导航 / 账号 / 主题 / 设置）+ 路由出口。
 * 题库的自动恢复也在这里做：刷新页面能回到上次刷的那套题。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useBankStore } from '@/stores/bank'
import { useQuizStore } from '@/stores/quiz'
import SettingsPanel from '@/components/SettingsPanel.vue'
import AppBackground from '@/components/AppBackground.vue'
import MusicPlayer from '@/components/MusicPlayer.vue'
import ElevateDialog from '@/components/ElevateDialog.vue'
import { celebrate } from '@/core/celebrate'
import { KNOCK_WINDOW_MS, knockStep, shouldIgnoreTarget } from '@/core/elevate'
import { auth, loadMe, logout } from '@/core/auth'
import { stopSync, syncBank, syncLabel } from '@/core/sync'
import { storageWorks } from '@/core/storage'

const bank = useBankStore()
const quiz = useQuizStore()
const route = useRoute()

/* ---------------------- 答题庆祝特效 ---------------------- */
/**
 * store 只写 `lastFeedback` 状态，放特效（碰 DOM/Canvas）的活在这里。
 * 这样 store 保持纯逻辑、能在 Node 引擎测试里直接跑。
 */
const cheer = ref(null)
let cheerTimer = 0

watch(
  () => quiz.lastFeedback,
  (feedback) => {
    if (!feedback || !quiz.settings.celebrate) return
    celebrate(feedback.kind, { level: feedback.level })
    cheer.value = feedback
    clearTimeout(cheerTimer)
    cheerTimer = setTimeout(() => {
      cheer.value = null
    }, 2300)
  },
)

onUnmounted(() => clearTimeout(cheerTimer))
const router = useRouter()

const settingsOpen = ref(false)
const booting = ref(true)

// 同步加载偏好，避免暗色用户看到一瞬白屏
quiz.loadSettings()

const THEME_ICON = { auto: 'Monitor', light: 'Sunny', dark: 'Moon' }
const themeIcon = computed(() => THEME_ICON[quiz.settings.theme] || 'Monitor')
const themeLabel = computed(
  () => ({ auto: '跟随系统', light: '浅色', dark: '深色' })[quiz.settings.theme] || '主题',
)

const bankTitle = computed(() => bank.meta?.title || '')
/**
 * 导航条：**常显**。
 *
 * ⚠️ 原来是 `!!bank.meta`（进了题库才显示），于是"演武场"这种**跟题库无关**的入口
 * 在首页根本看不见 —— 站主 2026-10-11 反馈「我感觉你什么都没改」，根因就是这个：
 * 新功能全藏在"先进一个题库"之后，而人第一眼看到的是首页。
 */
const showNav = computed(() => true)

/**
 * 导航分两层（2026-10-12，起因是站主说「导航太多了，自适应有点问题」）。
 *
 * 实测（`quiz/tools/nav_check.py`，1024px + 题库名 chip）：7 个导航项平铺时，
 * 「知识图谱 / 图笔记」会被右侧主题/设置两个按钮**压住**、页面还会横向溢出，
 * 一直到 1180px 才开始正常。根因不是"少写了一条 media query"：
 * 7 个汉字标签 + 品牌 + 题库名 chip + 右侧按钮，在 1024~1180px 这一档**本来就装不下**。
 *
 * 所以改成：**常用的 4 个留在外面，其余收进「更多」**。
 * 判据是"学生一进来最可能去哪个"：刷题（题库）/ 看教材（预习页）/ 写代码（演武场）/ 复习错题（错题本）。
 * 报告、图谱、图笔记都是"回头才看"的，进「更多」不影响主路径。
 */
// AI 入口按 settings.aiEnabled 过滤：开源版默认 false，「预习页」和「知识图谱」会藏起来；
// 想用 AI 时把 settings.aiEnabled 设 true 即可，所有路由和按钮一次性回来。
const aiEnabled = computed(() => !!quiz.settings.aiEnabled)

const PRIMARY_LINKS = [
  { to: '/', label: '题库', icon: 'HomeFilled', title: '题库', exact: true },
  { to: '/lesson', label: '预习页', icon: 'Reading', title: '预习页（扫描件教材）', ai: true },
  { to: '/forge', label: '演武场', icon: 'Cpu', title: '演武场（随手粘一段代码就能跑）' },
  { to: '/review', label: '错题本', icon: 'Files', title: '错题本', badge: true },
]
const MORE_LINKS = [
  { to: '/report', label: '学习报告', icon: 'DataLine' },
  { to: '/graph', label: '知识图谱', icon: 'Share', ai: true },
  { to: '/diagram', label: '图笔记', icon: 'EditPen' },
]
const visiblePrimaryLinks = computed(() => PRIMARY_LINKS.filter((l) => !l.ai || aiEnabled.value))
const visibleMoreLinks = computed(() => MORE_LINKS.filter((l) => !l.ai || aiEnabled.value))
/** 当前路由在「更多」里 ⇒ 「更多」这个按钮也要有选中态（不然点进去就"失联"了） */
const moreActive = computed(() => visibleMoreLinks.value.some((item) => route.path === item.to))

/* ------------------------------ 账号（登录后进度跟着走） ------------------------------ */
const displayName = computed(() => auth.user?.nickname || auth.user?.username || '')
const initial = computed(() => (displayName.value || '?').slice(0, 1))

/**
 * 登录之后第一次打开某个题库就对齐一次（合并本机和账号里那两份）。
 *
 * ⚠️ `quiet: true`：自动同步不弹提示 —— 每次切题库都弹一句"同步成功"是噪音。
 * 有冲突（两边同一条笔记内容不同）时才出声，那是真的要告诉学生。
 */
async function syncCurrentBank({ quiet = true } = {}) {
  if (!auth.user || !quiz.bankId) return null
  return syncBank(quiz, { quiet })
}

async function onUserCommand(command) {
  if (command === 'login') {
    router.push('/login')
    return
  }
  if (command === 'sync') {
    const result = await syncCurrentBank({ quiet: false })
    if (result) ElMessage.success('进度已经和账号对齐')
    return
  }
  if (command === 'logout') {
    try {
      await ElMessageBox.confirm(
        '退出只是把账号从这台浏览器上摘下来：错题本和笔记还在账号里，这台浏览器上的进度也留着。',
        '退出登录',
        { type: 'warning', confirmButtonText: '退出', cancelButtonText: '取消' },
      )
    } catch {
      return
    }
    stopSync()
    await logout()
    ElMessage.success('已退出登录')
  }
}

// 换题库就对齐一次：学生换一套题接着刷时，账号里那套的进度也该立刻回来
watch(
  () => quiz.bankId,
  (bankId) => {
    if (bankId && auth.user) syncCurrentBank()
  },
)

function onThemeClick() {
  const next = quiz.cycleTheme()
  ElMessage({
    message: `主题：${{ auto: '跟随系统', light: '浅色', dark: '深色' }[next]}`,
    duration: 1200,
    grouping: true,
  })
}

let mq = null
function onSystemThemeChange() {
  if (quiz.settings.theme === 'auto') quiz.applyAppearance()
}

/** 从 URL 取题库地址：兼容 ?bank=x.json#/ 和 #/?bank=x.json 两种写法 */
function bankFromUrl() {
  const direct = new URLSearchParams(window.location.search).get('bank')
  if (direct) return direct
  const q = route.query.bank
  return typeof q === 'string' && q ? q : ''
}

/* ------------------------------ 站内提权（敲键序列） ------------------------------ */

/**
 * 5 秒内依次按下 x s 9 9 9 → 弹出提权框。
 *
 * ⚠️ 这个序列**不是安全边界**（bundle 是公开可读的，谁都能翻到），它只是"门把手"：
 *   真正的门是服务端拿密码换签名 token（见 renwu/backend/apps/quizgen/elevate.py）。
 *   所以**不要**往这个序列上加"隐藏功能" —— 那不是隐藏，那是公开。
 *
 * 状态机本身是纯函数（core/elevate.js 的 knockStep，可在 Node 里断言），这里只管挂监听。
 */
const elevateOpen = ref(false)
let knockState = { progress: 0, startMs: 0 }

function onKeydown(event) {
  // 在输入框 / 代码编辑器里打字**不算** —— 否则答案解析里敲出 xs999 会突然弹密码框
  if (shouldIgnoreTarget(event.target)) return
  knockState = knockStep(knockState, event.key, Date.now(), KNOCK_WINDOW_MS)
  if (knockState.matched) elevateOpen.value = true
}

onMounted(async () => {
  bank.loadCustom()
  // 先问"我是谁"（顺便把 csrftoken 种上）：登录了的话，下面打开题库时要顺带对齐进度。
  // 连不上后端时 loadMe 内部吞掉异常，只当没登录 —— 刷题不受影响。
  await loadMe()
  await bank.loadManifest()
  const url = bankFromUrl()
  if (url) {
    try {
      await bank.openUrl(url)
      quiz.init(bank.meta.id)
      // 清掉 query，免得刷新时重复拉取
      router.replace({ path: '/', query: {} })
      ElMessage.success(`已加载题库：${bank.meta.title}`)
    } catch (e) {
      ElMessage.error(`从 URL 加载题库失败：${e.message}`)
    }
  } else if (!bank.meta) {
    await bank.restoreLast()
    if (bank.meta) quiz.init(bank.meta.id)
  }

  // 登录着的话，进来就把这套题库的本机进度和账号那份合并一次（登录之后第一次打开就走这里）
  if (auth.user && quiz.bankId) syncCurrentBank()

  booting.value = false
  bank.booted = true

  mq = window.matchMedia?.('(prefers-color-scheme: dark)')
  mq?.addEventListener?.('change', onSystemThemeChange)
})

onMounted(() => window.addEventListener('keydown', onKeydown))

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  mq?.removeEventListener?.('change', onSystemThemeChange)
})
</script>

<template>
  <div class="q-app">
    <!-- 全屏背景（可切换：无 / 极光 / 星点 / 星云）。z-index:0 且 pointer-events:none，
         正文在 .q-top / RouterView 里靠 z-index 压在上面 -->
    <AppBackground />
    <!-- 网易云播放器：默认关闭，开了才出现在右下角 -->
    <MusicPlayer />
    <!-- 站内提权（敲 x s 9 9 9 打开）。它不是安全边界，只是"门把手" -->
    <ElevateDialog v-model="elevateOpen" />
    <!-- 庆祝横幅（配合 celebrate() 的 Canvas 粒子；aria-live 让读屏也能感知） -->
    <transition name="q-cheer">
      <div
        v-if="cheer"
        class="q-cheer"
        :class="`q-cheer--${cheer.kind}`"
        role="status"
        aria-live="polite"
      >
        <el-icon :size="17"><Trophy /></el-icon>
        <span>{{ cheer.label }}</span>
      </div>
    </transition>
    <!-- ─────────────── 顶栏 ─────────────── -->
    <header class="q-top q-no-print">
      <div class="q-wrap q-top__inner">
        <RouterLink to="/" class="q-brand">
          <span class="q-brand__mark">
            <!-- 手写 SVG，不用 Element Plus 的图标：品牌标记要和 favicon 用**同一份图形**，
                 而且勾的粗细、圆点的位置是按 34px 方块专门调过的（EP 那个勾偏细、
                 右下留白多，放进方块里显得轻飘）。 -->
            <svg class="q-brand__glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M3.8 11.6l4.8 4.9L18.4 6.4" />
              <circle cx="18.9" cy="18.2" r="2.5" />
            </svg>
          </span>
          <span class="q-brand__text">
            <b>刷题</b>
            <em>Quiz</em>
          </span>
        </RouterLink>

        <div v-if="bankTitle" class="q-top__bank" :title="bankTitle">
          <el-icon :size="13"><Collection /></el-icon>
          <span>{{ bankTitle }}</span>
          <span v-if="bank.meta?.total" class="q-num q-dim">{{ bank.meta.total }} 题</span>
        </div>

        <nav v-if="showNav" class="q-top__nav">
          <RouterLink
            v-for="item in visiblePrimaryLinks"
            :key="item.to"
            :to="item.to"
            class="q-top__link"
            active-class="is-active"
            :exact-active-class="item.exact ? 'is-active' : ''"
            :title="item.title"
          >
            <el-icon :size="14"><component :is="item.icon" /></el-icon>{{ item.label }}
            <em v-if="item.badge && quiz.wrongCount" class="q-top__badge">{{ quiz.wrongCount }}</em>
          </RouterLink>

          <!--
            「更多」：收进去的是"回头才看"的几项。
            AI 禁用时少一项（知识图谱），其余按 settings.aiEnabled 过滤。
            为什么用收纳而不是硬挤：1024px 这一档**本来就装不下 7 个汉字标签**
            （实测它们会被右侧按钮压住，见 PRIMARY_LINKS 上面的注释）。
          -->
          <el-dropdown
            v-if="visibleMoreLinks.length > 0"
            trigger="click"
            placement="bottom-end"
            @command="(to) => router.push(to)"
          >
            <button
              type="button"
              class="q-top__link q-top__more"
              :class="{ 'is-active': moreActive }"
              data-nav-more
              title="更多"
            >
              <el-icon :size="14"><MoreFilled /></el-icon>更多
              <el-icon :size="11"><ArrowDown /></el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  v-for="item in visibleMoreLinks"
                  :key="item.to"
                  class="q-top__moreitem"
                  :command="item.to"
                >
                  <el-icon :size="14"><component :is="item.icon" /></el-icon>{{ item.label }}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </nav>

        <div class="q-top__actions">
          <!-- 账号：登录之后错题本/收藏/笔记/历史跟着账号走（见 core/sync.js） -->
          <RouterLink v-if="!auth.user" to="/login" class="q-top__user" data-nav-login title="登录后进度跟着账号走">
            <el-icon :size="15"><User /></el-icon><span class="q-top__usertext">登录</span>
          </RouterLink>
          <el-dropdown v-else trigger="click" placement="bottom-end" @command="onUserCommand">
            <button type="button" class="q-top__user q-top__user--me" data-nav-user :title="syncLabel()">
              <span class="q-top__avatar">{{ initial }}</span>
              <span class="q-top__usertext">{{ displayName }}</span>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="login">
                  <el-icon :size="14"><User /></el-icon>我的账号
                </el-dropdown-item>
                <el-dropdown-item command="sync" :disabled="!quiz.bankId">
                  <el-icon :size="14"><Refresh /></el-icon>立即同步进度
                </el-dropdown-item>
                <el-dropdown-item command="logout" divided>
                  <el-icon :size="14"><SwitchButton /></el-icon>退出登录
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>

          <el-tooltip :content="`主题：${themeLabel}`" placement="bottom">
            <button class="q-iconbtn" @click="onThemeClick">
              <el-icon :size="16"><component :is="themeIcon" /></el-icon>
            </button>
          </el-tooltip>
          <el-tooltip content="设置" placement="bottom">
            <button class="q-iconbtn" @click="settingsOpen = true">
              <el-icon :size="16"><Setting /></el-icon>
            </button>
          </el-tooltip>
        </div>
      </div>
    </header>

    <!-- ─────────────── 内容 ─────────────── -->
    <main class="q-main">
      <RouterView v-slot="{ Component }">
        <transition name="q-page" mode="out-in">
          <component :is="Component" />
        </transition>
      </RouterView>
    </main>

    <footer class="q-foot q-no-print">
      <div class="q-wrap q-foot__inner">
        <!--
          ⚠️ 这一行原来写死的是「进度只存在本机浏览器」。加了账号之后它就是**错的信息**：
          登录过的人会以为自己在别的设备上看得到，其实他从来没登录。文案必须跟着状态走。
        -->
        <span v-if="auth.user">
          <el-icon :size="12"><CircleCheck /></el-icon>
          已登录 <b>{{ displayName }}</b> · 进度存在账号里，换设备也在
        </span>
        <span v-else>
          <el-icon :size="12"><Lock /></el-icon>
          进度只存在本机浏览器
          <RouterLink class="q-foot__login" to="/login">登录后跟着账号走</RouterLink>
          <template v-if="!storageWorks()">（<b style="color: var(--q-bad)">当前浏览器禁用了本地存储</b>）</template>
        </span>
        <!-- 学生视角的收尾一句：以前写的是「丢一个 JSON 题库进来就能刷」（那是导入说明，不是给学生看的） -->
        <span class="q-dim">共 {{ bank.entries.length }} 套题库 · 挑一套就能开始</span>
      </div>
    </footer>

    <SettingsPanel v-model="settingsOpen" />
  </div>
</template>

<style scoped>
.q-app {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

/* ---------- 顶栏 ---------- */
.q-top {
  position: sticky;
  top: 0;
  z-index: 100;
  background: color-mix(in srgb, var(--q-bg) 78%, transparent);
  backdrop-filter: saturate(1.6) blur(14px);
  -webkit-backdrop-filter: saturate(1.6) blur(14px);
  border-bottom: 1px solid var(--q-border);
}
.q-top__inner {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 62px;
  /* ★ 顶栏**绝不许把页面撑宽**（2026-10-12 实测：1024px 下 7 个导航项会把
     scrollWidth 顶到 1085，整页出现横向滚动条、连 toast 都出屏）。
     根因是 flex 子项默认 `min-width: auto`（= 内容宽度），谁都不肯先收缩。
     这里让导航那一块可以收缩（min-width:0 + overflow:hidden），
     真正"挤不下"的部分由下面的 media query 收进「更多」或只留图标来解决。 */
  min-width: 0;
}

.q-brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
}
.q-brand__mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 13px;
  background: var(--q-grad);
  color: #fff;
  /* 柔光立体：顶部一道内高光 + 底部一层内阴影，用 inset 画出来，
     不额外加元素（这样 hover 的 transform 也只需要作用在一个盒子上）。
     最后那条仍是原来的品牌投影变量。 */
  box-shadow:
    inset 0 1.5px 0 rgba(255, 255, 255, 0.42),
    inset 0 -6px 12px rgba(30, 20, 80, 0.22),
    var(--q-shadow-brand);
  transition: transform var(--q-dur) var(--q-ease);
}
/* 图标用 currentColor，所以在浅色/深色主题里都会跟着 .q-brand__mark 的 color 走 */
.q-brand__glyph {
  display: block;
  width: 19px;
  height: 19px;
}
.q-brand__glyph path {
  fill: none;
  stroke: currentColor;
  stroke-width: 3.1;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.q-brand__glyph circle {
  fill: currentColor;
}
.q-brand:hover .q-brand__mark {
  transform: rotate(-6deg) scale(1.05);
}
.q-brand__text {
  display: flex;
  align-items: baseline;
  gap: 5px;
}
.q-brand__text b {
  font-size: 17px;
  font-weight: 800;
  letter-spacing: 0.02em;
  color: var(--q-text);
}
.q-brand__text em {
  font-style: normal;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--q-text-3);
}

.q-top__bank {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  /* 题库名 chip 是**最容易被挤爆**的一块（chip 一度有 346px）：
     它自己可以收缩 + 省略号，绝不去顶别人。 */
  flex: 0 1 auto;
  max-width: min(320px, 26vw);
  padding: 6px 12px;
  border-radius: var(--q-r-full);
  background: var(--q-surface-2);
  border: 1px solid var(--q-border);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--q-text-2);
}
.q-top__bank span:first-of-type {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.q-top__nav {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  /* ★ 两块都要：min-width:0 才允许它比内容窄；overflow:hidden 兜住
     "万一还是不够"的情况 —— 宁可裁掉，也不许把整页撑出横向滚动条。 */
  min-width: 0;
  overflow: hidden;
  /* 绝不换行：汉字被拆成两行（"题/库"）看着像排版坏了（原来那条注释的教训） */
  flex-wrap: nowrap;
}
.q-top__link {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 13px;
  border-radius: 10px;
  font-size: 13.5px;
  /* ★ 导航项**绝不许折行**：题库名长的时候（"毛泽东思想和中国特色社会主义理论体系概论题库"
     这一档 chip 有 346px），7 个导航项会全被挤成两行（"题/库""预/习/页"…），
     看着像排版坏了。实测：chip 215px 时 7 项各 33px 一行；346px 时全部 52px 两行。
     宁可挤（下面窄屏会改成横向滚动），也不许把汉字拆成两行。 */
  white-space: nowrap;
  /* 不许被压扁（收缩靠"收进更多 + 只留图标"，不是靠把标题挤没） */
  flex: 0 0 auto;
  font-weight: 650;
  color: var(--q-text-2);
  transition: all var(--q-dur) var(--q-ease);
}
/* 「更多」是个 <button>，不是 RouterLink：要把浏览器默认按钮样式清干净 */
.q-top__more {
  border: 0;
  background: transparent;
  font: inherit;
  font-size: 13.5px;
  font-weight: 650;
  color: var(--q-text-2);
  cursor: pointer;
}
.q-top__link:hover {
  background: var(--q-surface-2);
  color: var(--q-text);
}
.q-top__link.is-active {
  background: color-mix(in srgb, var(--q-brand-1) 13%, transparent);
  color: var(--q-brand-1);
}
html.dark .q-top__link.is-active {
  color: #a5b0ff;
}
.q-top__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: 99px;
  background: var(--q-bad);
  color: #fff;
  font-size: 10.5px;
  font-weight: 700;
  font-style: normal;
}

.q-top__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  /* 右侧按钮区**不许被收缩**：它是最后一道，宁可让导航裁一点也不能让按钮被压没 */
  flex: 0 0 auto;
}
.q-top__nav + .q-top__actions {
  margin-left: 0;
}

/* ---------- 账号入口（登录 / 昵称） ---------- */
.q-top__user {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 150px;
  padding: 7px 12px;
  border-radius: 10px;
  border: 1px solid var(--q-border);
  background: var(--q-surface-2);
  color: var(--q-text-2);
  font: inherit;
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
  transition: all var(--q-dur) var(--q-ease);
}
.q-top__user:hover {
  color: var(--q-brand-1);
  border-color: color-mix(in srgb, var(--q-brand-1) 40%, transparent);
}
/* 昵称可能很长（中文昵称 24 个字）：只留一行 + 省略号，绝不把顶栏顶开 */
.q-top__usertext {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.q-top__avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 21px;
  height: 21px;
  border-radius: 7px;
  background: var(--q-grad);
  color: #fff;
  font-size: 12px;
  font-weight: 800;
  flex: 0 0 auto;
}
.q-iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  border: 1px solid var(--q-border);
  background: var(--q-surface-2);
  color: var(--q-text-2);
  cursor: pointer;
  transition: all var(--q-dur) var(--q-ease);
}
.q-iconbtn:hover {
  color: var(--q-brand-1);
  border-color: color-mix(in srgb, var(--q-brand-1) 40%, transparent);
  transform: translateY(-1px);
}
.q-iconbtn:active {
  transform: translateY(0);
}

/* ---------- 庆祝横幅（配合 Canvas 粒子） ---------- */
.q-cheer {
  position: fixed;
  top: 86px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9998;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 22px;
  border-radius: 99px;
  font-size: 14px;
  font-weight: 850;
  letter-spacing: 0.01em;
  color: #fff;
  /* 连对：紫粉渐变，呼应"越来越热" */
  background: linear-gradient(135deg, #6366f1, #a855f7 55%, #ec4899);
  box-shadow: 0 18px 48px -18px rgb(99 102 241 / 0.95);
  /* 横幅也不能挡点击 */
  pointer-events: none;
}
/* 拿下旧错题：绿色，和"答对"的语义一致 */
.q-cheer--redeem {
  background: linear-gradient(135deg, #22c55e, #14b8a6 60%, #6366f1);
  box-shadow: 0 18px 48px -18px rgb(34 197 94 / 0.95);
}
.q-cheer-enter-active,
.q-cheer-leave-active {
  transition: opacity 0.26s var(--q-ease), transform 0.26s var(--q-ease);
}
.q-cheer-enter-from,
.q-cheer-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-16px) scale(0.92);
}
@media (prefers-reduced-motion: reduce) {
  .q-cheer-enter-active,
  .q-cheer-leave-active {
    transition: opacity 0.2s linear;
  }
  .q-cheer-enter-from,
  .q-cheer-leave-to {
    transform: translateX(-50%);
  }
}

/* ---------- 内容 ---------- */
.q-main {
  flex: 1 1 auto;
  padding: 26px 0 40px;
  /* ⚠️ 必须抬到背景之上：AppBackground 是 position:fixed + z-index:0，
     而定位元素会盖在**静态**内容上面 —— 不给这里 position/z-index 的话，
     背景会把整个页面糊住。 */
  position: relative;
  z-index: 1;
}

/* ---------- 页脚 ---------- */
.q-foot {
  border-top: 1px solid var(--q-border);
  padding: 16px 0;
}
.q-foot__inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--q-text-3);
}
.q-foot__inner span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.q-foot__login {
  color: var(--q-brand-1);
  font-weight: 650;
}
.q-foot__login:hover {
  text-decoration: underline;
}

/* ---------- 路由过渡 ---------- */
.q-page-enter-active,
.q-page-leave-active {
  transition: opacity 0.24s var(--q-ease), transform 0.24s var(--q-ease);
}
.q-page-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
.q-page-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

@media (max-width: 860px) {
  .q-top__link {
    padding: 7px 10px;
  }
  .q-brand__text em {
    display: none;
  }
  .q-main {
    padding: 16px 0 30px;
  }
}

/*
 * ⚠️ 这一档（1100px 以下）**必须**把题库名 chip 收掉，这不是审美：
 * 实测（quiz/tools/nav_check.py，2026-10-12）——chip 在的时候，
 * 1180px 就开始出现"图笔记被右侧按钮压住"，1024/960px 时整页横向溢出 61/103px。
 * 根因是"品牌 + chip(≤320) + 导航 + 账号 + 两个图标按钮"这一排在 1100px 左右**真的装不下**。
 * 题库名在顶栏只是"提醒你正在刷哪套"，收掉不影响任何功能（首页/题库卡片里都有）。
 */
@media (max-width: 1100px) {
  .q-top__bank {
    display: none;
  }
}

/*
 * 窄屏（≤900px）：导航**不再横向滚**。
 * 原来这里是 `overflow-x: auto` —— 那正是站主说的"遮挡"：滚出去的那几项
 * 在屏幕外（点击也点不到），看着就是"有的入口莫名其妙不见了"。
 * 现在的做法是"能收就收、能缩就缩"：题库名 chip 已经收掉（上面那条），
 * 导航项只剩 4 个 + 更多，900px 完全放得下。
 */
@media (max-width: 900px) {
  .q-top__nav {
    gap: 2px;
  }
  .q-top__link {
    padding: 7px 9px;
  }
}
@media (max-width: 740px) {
  /* 只留图标：文字用 font-size:0 收掉，图标的字号是 el-icon 的行内样式，不受影响。
     收掉文字后 4 项 + 更多 ≈ 5×34px，480px 的屏幕也放得下。
     收掉文字时靠 title 属性兜底（鼠标悬停能看到名字）。 */
  .q-top__link,
  .q-top__more {
    font-size: 0;
    padding: 7px 7px;
  }
  .q-top__badge {
    font-size: 10.5px;
  }
  /* 账号那块也一样：只留头像（未登录时只留人形图标） */
  .q-top__usertext {
    display: none;
  }
  .q-top__user {
    padding: 7px 9px;
  }
}
@media (max-width: 520px) {
  /* 手机宽度：品牌只留那个方块标记，把宽度让给导航和账号 */
  .q-brand__text {
    display: none;
  }
}
</style>
