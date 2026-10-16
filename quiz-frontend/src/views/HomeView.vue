<script setup>
/**
 * HomeView —— 首页：题库总览 + 组卷（选模式/筛题型/选标签）+ 题库工具。
 *
 * 导入 PDF/JSON、AI 出题、AI 补解析都在 BankTools 组件里（那里要跟后端打交道，
 * 并且要能优雅降级到「纯本地」），这个页面只管组卷和题库列表。
 */
import { computed, ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useBankStore } from '@/stores/bank'
import { useQuizStore } from '@/stores/quiz'
import BankTools from '@/components/BankTools.vue'
import { TYPE_LABEL } from '@/core/normalize'
import { plainText } from '@/core/text'

const bank = useBankStore()
const quiz = useQuizStore()
const router = useRouter()
const route = useRoute()

/* ------------------------------- AI 入口拦截提示 ------------------------------- */
// router 把 ai 路由跳回首页时会带 ?aiBlocked=<name>，这里弹个一次性提示。
// 不要在"AI 已启用"时弹这个（避免跟用户自己点 AI 入口的逻辑打架）。
onMounted(() => {
  if (route.query.aiBlocked && !quiz.settings.aiEnabled) {
    ElMessage({
      type: 'info',
      message: 'AI 功能默认未启用（开源版）。需要时把 quiz:v1:settings 里的 aiEnabled 设为 true。',
      duration: 4000,
    })
    router.replace({ name: 'home', query: {} })
  }
})

/* ------------------------------- 组卷条件 ------------------------------- */
const filters = ref({ types: [], tags: [], from: null, to: null })
const examCount = ref(50)
const examMinutes = ref(60)

const meta = computed(() => bank.meta)
/** 所有题库加起来的题量（首访也要能说出"这里有多少题可以刷"） */
const bankTotal = computed(() => bank.entries.reduce((sum, e) => sum + (e.total || 0), 0))
const qMax = computed(() => {
  const nos = bank.questions.map((q) => q.no)
  return nos.length ? Math.max(...nos) : 0
})

const MODES = computed(() => [
  {
    // 诊断先行：不是"再做一个练习模式"，而是**决定接下来做哪种练习**（见 core/diagnose.js）
    key: 'diagnose',
    icon: 'Odometer',
    label: '先做诊断',
    desc: '10 分钟摸清这一章该怎么学：会了就直接上强度，不会就先看原文',
    tone: 'warn',
    disabled: !bank.questions.length,
  },
  {
    key: 'seq',
    icon: 'Sort',
    label: '顺序练习',
    desc: '按题库原顺序，从第 1 题开始',
    tone: 'brand',
    disabled: false,
  },
  {
    key: 'random',
    icon: 'Refresh',
    label: '随机练习',
    desc: '打乱顺序，避免记住题号',
    tone: 'brand',
    disabled: false,
  },
  {
    key: 'wrong',
    icon: 'WarningFilled',
    label: '错题重做',
    desc: quiz.wrongCount ? `错题本里现有 ${quiz.wrongCount} 道` : '还没有错题',
    tone: 'danger',
    disabled: !quiz.wrongCount,
  },
  {
    key: 'fav',
    icon: 'StarFilled',
    label: '收藏练习',
    desc: quiz.favCount ? `已收藏 ${quiz.favCount} 道` : '还没有收藏',
    tone: 'warn',
    disabled: !quiz.favCount,
  },
  {
    key: 'exam',
    icon: 'AlarmClock',
    label: '模拟考试',
    desc: '限时抽题，交卷后统一看结果',
    tone: 'violet',
    disabled: false,
    exam: true,
  },
])

const TYPE_OPTIONS = [
  { key: 'single', label: '单选题' },
  { key: 'multiple', label: '多选题' },
  { key: 'judge', label: '判断题' },
  // 代码题（填空/找错行/预测输出/修好它）—— 教材编译出来的题库里才有
  { key: 'code', label: '代码题' },
]

const tagOptions = computed(() => meta.value?.tags || [])

/** 当前筛选条件下能组出多少题 */
const availableCount = computed(
  () => quiz.filterQuestions({ ...filters.value }).length,
)

function toggleType(k) {
  const i = filters.value.types.indexOf(k)
  if (i >= 0) filters.value.types.splice(i, 1)
  else filters.value.types.push(k)
  // 「全不选」等价于「全选」
  if (filters.value.types.length === TYPE_OPTIONS.length) filters.value.types = []
}

const allTypes = computed(() => filters.value.types.length === 0)

const activeFilterText = computed(() => {
  const parts = []
  parts.push(allTypes.value ? '全部题型' : filters.value.types.map((t) => TYPE_LABEL[t]).join('/'))
  if (filters.value.tags.length) parts.push(`${filters.value.tags.length} 个标签`)
  if (filters.value.from != null && filters.value.to != null)
    parts.push(`第 ${filters.value.from}-${filters.value.to} 题`)
  return parts.join(' · ')
})

const rangeInvalid = computed(
  () =>
    filters.value.from != null &&
    filters.value.to != null &&
    filters.value.from > filters.value.to,
)

function resetFilters() {
  filters.value = { types: [], tags: [], from: null, to: null }
}

/* ------------------------------- 开始练习 ------------------------------- */
async function start(mode) {
  // 「先做诊断」不是一个练习模式，它要先去诊断页决定做哪类题
  if (mode === 'diagnose') {
    router.push('/diagnose')
    return
  }
  if (rangeInvalid.value) {
    ElMessage.warning('题号范围起始值不能大于结束值')
    return
  }
  if (!availableCount.value) {
    ElMessage.warning('当前筛选条件下没有题目，换个条件试试')
    return
  }
  const ok = quiz.startSession({
    mode,
    filters: { ...filters.value, tags: [...filters.value.tags] },
    limit: examCount.value,
    examMinutes: examMinutes.value,
  })
  if (!ok) {
    ElMessage.warning(
      mode === 'wrong' ? '错题本是空的' : mode === 'fav' ? '还没有收藏题目' : '没有可用题目',
    )
    return
  }
  router.push('/practice')
}

function resume() {
  router.push('/practice')
}

async function abandon() {
  try {
    await ElMessageBox.confirm('放弃后本次的答题位置会清空，已记录的错题和收藏会保留。', '放弃本次练习', {
      type: 'warning',
      confirmButtonText: '放弃',
      cancelButtonText: '继续做',
    })
    quiz.endSession()
    ElMessage.success('已放弃本次练习')
  } catch {}
}

/* ------------------------------- 打开题库 ------------------------------- */
/**
 * 滚到本页某个锚点。
 *
 * ⚠️ 必须用 `scrollIntoView`，**不能**写 `<a href="#q-tools">` ——
 * 这个站是 **hash 路由**（`createWebHashHistory`），`#q-tools` 会被 router 当成
 * 一条路由去找，找不到就按兜底规则跳回首页（点一下等于"页面闪一下、没动"）。
 */
function scrollTo(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function open(entry) {
  if (bank.meta?.id === entry.id) {
    scrollTo('q-start')
    return
  }
  try {
    await bank.openEntry(entry)
    quiz.init(bank.meta.id)
    ElMessage.success(`已切换到「${bank.meta.title}」`)
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function removeCustom(entry) {
  try {
    await ElMessageBox.confirm(`删除导入的题库「${entry.title}」？不影响其它题库。`, '删除题库', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
    bank.removeCustom(entry.id)
    ElMessage.success('已删除')
  } catch {}
}

/* ------------------------------- 示例 JSON ------------------------------- */
const SAMPLE = `{
  "meta": { "title": "我的题库" },
  "questions": [
    {
      "type": "single",
      "stem": "中国的武装斗争是无产阶级领导下的以(  )为主体的革命战争。",
      "options": [
        { "key": "A", "text": "工人" },
        { "key": "B", "text": "农民" },
        { "key": "C", "text": "城市小资产阶级" },
        { "key": "D", "text": "知识分子" }
      ],
      "answer": "B"
    },
    { "type": "judge", "stem": "五四运动促进了马克思主义在中国的广泛传播。", "answer": "正确" }
  ]
}`

async function copySample() {
  try {
    await navigator.clipboard.writeText(SAMPLE)
    ElMessage.success('示例 JSON 已复制，可直接发给 AI 当模板')
  } catch {
    ElMessage.warning('复制失败，请手动选中文本框内容')
  }
}
</script>

<template>
  <div class="q-wrap q-home">
    <!-- ─────────────── Hero ─────────────── -->
    <section class="q-hero">
      <div class="q-hero__left">
        <!--
          站主 2026-10-12 定的：首页大标题换回「丢一个 JSON，就能开始刷题。」
          （给的就是这句话的原图）。
          ⚠️ 这里**以前**是「挑一套题库，现在就开始刷」——那是 2026-10-11 按 UX 审计
          块 1-2 改的（当时理由是"学生看完导入流程仍然不知道能干什么"）。
          现在换回来，是因为**这个站实际的来客就是站主自己**：他手上是老师给的
          PDF/JSON，第一件事就是把它变成能刷的题库。所以：
            · 标题/副标题照原图，一个字不改（含 tools/pdf_to_json.py 和 schema 的代码样式）；
            · 但下面**保留一行学生兜底**（已有多少套题库、多少道题、直接挑一套就能刷）——
              只照图会把"只想刷题的人"挡在门外。
        -->
        <h1 class="q-hero__title">
          丢一个 <span class="q-grad-text">JSON</span>，<br />就能开始刷题。
        </h1>
        <p class="q-hero__sub">
          老师给的题库 PDF，用 <code class="q-hero__code">tools/pdf_to_json.py</code> 转成 JSON，
          或者直接让 AI 按 <code class="q-hero__code">schema</code> 输出，然后拖到
          <button type="button" class="q-hero__link" @click="scrollTo('q-tools')">下面那个框</button>里就能刷。
        </p>
        <p v-if="bank.entries.length" class="q-hero__meta">
          不用导题也行：现在有 <b class="q-num">{{ bank.entries.length }}</b> 套题库、共
          <b class="q-num">{{ bankTotal }}</b> 道题，
          <button type="button" class="q-hero__link" @click="scrollTo('q-start')">直接挑一套就能刷</button>
        </p>
      </div>

      <div v-if="meta" class="q-hero__stats">
        <div class="q-stat">
          <span class="q-stat__num q-num">{{ meta.total }}</span>
          <span class="q-stat__label">总题量</span>
        </div>
        <div class="q-stat">
          <span class="q-stat__num q-num">{{ quiz.stats.answered }}</span>
          <span class="q-stat__label">已作答</span>
        </div>
        <div class="q-stat">
          <span class="q-stat__num q-num" :style="{ color: 'var(--q-ok)' }">{{ quiz.stats.accuracy }}%</span>
          <span class="q-stat__label">正确率</span>
        </div>
        <div class="q-stat">
          <span class="q-stat__num q-num" :style="{ color: 'var(--q-bad)' }">{{ quiz.wrongCount }}</span>
          <span class="q-stat__label">错题</span>
        </div>
        <div class="q-stat">
          <span class="q-stat__num q-num" :style="{ color: 'var(--q-star)' }">{{ quiz.favCount }}</span>
          <span class="q-stat__label">收藏</span>
        </div>
      </div>
    </section>

    <!-- ─────────────── 继续上次练习 ─────────────── -->
    <section v-if="quiz.session" class="q-resume q-card q-pop">
      <div class="q-resume__icon">
        <el-icon :size="20"><VideoPlay /></el-icon>
      </div>
      <div class="q-resume__main">
        <strong>{{ quiz.modeLabel }} 进行中</strong>
        <span class="q-dim">
          第 {{ quiz.currentIndex + 1 }} / {{ quiz.queue.length }} 题 ·
          已作答 {{ quiz.sessionProgress.done }} 题
        </span>
      </div>
      <div class="q-resume__bar">
        <div class="q-resume__bar-in" :style="{ width: quiz.sessionProgress.pct + '%' }"></div>
      </div>
      <div class="q-resume__actions">
        <el-button @click="abandon">放弃</el-button>
        <el-button type="primary" @click="resume">
          继续 <el-icon style="margin-left: 4px"><ArrowRight /></el-icon>
        </el-button>
      </div>
    </section>

    <!-- ─────────────── 组卷 ─────────────── -->
    <section v-if="meta" id="q-start" class="q-section">
      <div class="q-section__head">
        <h2 class="q-section__title">开始刷题</h2>
        <span class="q-dim q-section__hint">{{ activeFilterText }} · 共 {{ availableCount }} 题可选</span>
      </div>

      <!-- 筛选 -->
      <div class="q-filters q-card">
        <div class="q-filters__row">
          <span class="q-filters__label">题型</span>
          <div class="q-filters__chips">
            <button class="q-chip q-clickable" :class="{ 'q-chip--brand': allTypes }" @click="filters.types = []">
              全部
            </button>
            <button
              v-for="t in TYPE_OPTIONS"
              :key="t.key"
              class="q-chip q-clickable"
              :class="{ 'q-chip--brand': filters.types.includes(t.key) }"
              @click="toggleType(t.key)"
            >
              {{ t.label }}
              <em class="q-dim">{{ (meta.counts || {})[t.key] || 0 }}</em>
            </button>
          </div>
        </div>

        <div v-if="tagOptions.length" class="q-filters__row">
          <span class="q-filters__label">标签</span>
          <el-select
            v-model="filters.tags"
            multiple
            collapse-tags
            collapse-tags-tooltip
            clearable
            filterable
            placeholder="按知识点筛选（可不选）"
            size="default"
            class="q-filters__select"
          >
            <el-option v-for="t in tagOptions" :key="t.name" :label="`${t.name} (${t.count})`" :value="t.name" />
          </el-select>
        </div>

        <div class="q-filters__row">
          <span class="q-filters__label">题号</span>
          <div class="q-filters__range">
            <el-input-number v-model="filters.from" :min="1" :max="qMax" :controls="false" placeholder="从" size="default" style="width: 92px" />
            <span class="q-dim">—</span>
            <el-input-number v-model="filters.to" :min="1" :max="qMax" :controls="false" placeholder="到" size="default" style="width: 92px" />
            <el-button text @click="filters.from = null; filters.to = null">不限</el-button>
            <span v-if="rangeInvalid" class="q-filters__err">起始题号大于结束题号</span>
          </div>
        </div>
      </div>

      <!-- 模式卡片 -->
      <div class="q-modes">
        <div
          v-for="m in MODES"
          :key="m.key"
          class="q-mode q-card q-card--hover"
          :class="[`q-mode--${m.tone}`, { 'is-disabled': m.disabled, 'q-mode--wide': m.exam }]"
        >
          <button class="q-mode__hit" :disabled="m.disabled" @click="start(m.key)">
            <span class="q-mode__icon"><el-icon :size="20"><component :is="m.icon" /></el-icon></span>
            <span class="q-mode__body">
              <b>{{ m.label }}</b>
              <em>{{ m.desc }}</em>
            </span>
            <el-icon class="q-mode__arrow" :size="15"><ArrowRight /></el-icon>
          </button>

          <!-- 考试参数放在按钮外面：<input> 嵌在 <button> 里是非法 HTML，焦点行为也不可靠 -->
          <div v-if="m.exam" class="q-mode__exam">
            <span class="q-mode__exam-item">
              <em>题量</em>
              <el-input-number
                v-model="examCount"
                :min="5"
                :max="Math.max(5, availableCount)"
                :step="10"
                size="small"
                controls-position="right"
                style="width: 104px"
              />
            </span>
            <span class="q-mode__exam-item">
              <em>时长</em>
              <el-input-number
                v-model="examMinutes"
                :min="5"
                :max="300"
                :step="5"
                size="small"
                controls-position="right"
                style="width: 104px"
              />
              <em>分钟</em>
            </span>
          </div>
        </div>
      </div>

      <!-- 知识图谱入口：AI 把题目归纳成概念网络，点知识点直接筛题刷 -->
      <RouterLink to="/graph" class="q-graphlink q-card q-card--hover">
        <span class="q-graphlink__icon"><el-icon :size="20"><Share /></el-icon></span>
        <span class="q-graphlink__body">
          <b>知识图谱</b>
          <em>
            把题目归纳成概念网络：颜色是正确率、大小是做题量、红环是有错题；
            点一个知识点就能直接筛出相关题目来刷
          </em>
        </span>
        <el-icon class="q-graphlink__arrow" :size="15"><ArrowRight /></el-icon>
      </RouterLink>
    </section>

    <!-- ─────────────── 题库列表 ─────────────── -->
    <section class="q-section">
      <div class="q-section__head">
        <h2 class="q-section__title">我的题库</h2>
        <span class="q-dim q-section__hint">{{ bank.entries.length }} 套</span>
      </div>

      <!--
        ⚠️ 题库卡片放在**题库工具前面**：工具那一块有 383px 高，
        以前它挡在中间，第一张题库卡要到 y=697 才出现（1440×900 首屏）。
        学生进来是来刷题的，不是来导入 PDF 的（UX 审计块 1-1）。
      -->
      <div class="q-banks">
        <!-- 题库卡片 -->
        <article
          v-for="e in bank.entries"
          :key="e.id"
          class="q-bank q-card q-card--hover"
          :class="{ 'is-current': meta?.id === e.id }"
        >
          <header class="q-bank__head">
            <span class="q-bank__icon" :class="e.kind === 'custom' ? 'is-custom' : 'is-builtin'">
              <el-icon :size="16"><component :is="e.kind === 'custom' ? 'Upload' : 'Collection'" /></el-icon>
            </span>
            <span v-if="meta?.id === e.id" class="q-chip q-chip--ok"><el-icon :size="11"><Select /></el-icon>当前</span>
            <button
              v-if="e.kind === 'custom'"
              class="q-bank__del"
              title="删除这套导入的题库"
              @click.stop="removeCustom(e)"
            >
              <el-icon :size="14"><Delete /></el-icon>
            </button>          </header>

          <h3 class="q-bank__title">{{ e.title }}</h3>
          <p v-if="e.subject" class="q-bank__subject">{{ e.subject }}</p>
          <!--
            简介**单独占一行**，不再"有科目就不显示"。
            为什么这条是必须的：教材编译出来的题库，简介里带着**署名 + 许可 + 已修改说明**
            （Vue 官方文档是 CC BY 4.0，这三样是使用条件，不是装饰）。
            原来写成 v-else-if，有 subject 就把简介整个藏了 —— 等于没署名。
          -->
          <p v-if="e.description" class="q-bank__desc" :title="plainText(e.description)">
            {{ plainText(e.description) }}
          </p>
          <p v-else-if="!e.subject" class="q-bank__subject q-dim">没有简介</p>

          <footer class="q-bank__foot">
            <span class="q-num q-bank__total">{{ e.total }} 题</span>
            <span v-if="e.counts" class="q-bank__counts">
              单 {{ e.counts.single }} · 多 {{ e.counts.multiple }} · 判 {{ e.counts.judge }}
              <!-- 代码题单独列出来：不然"单 0 · 多 0 · 判 0"会让人以为这是空题库 -->
              <template v-if="e.counts.code"> · 代码 {{ e.counts.code }}</template>
            </span>
          </footer>

          <!-- ★ 首屏最该点的地方：升成 primary + 40px 高 + 撑满卡片宽
               （以前是个没样式的裸 <button>，73×23 —— 还没旁边那个导入 tab 大，UX 审计块 1-1） -->
          <el-button type="primary" size="large" class="q-bank__go" @click="open(e)">
            {{ meta?.id === e.id ? '去刷题' : '选这套' }}
            <el-icon style="margin-left: 6px"><ArrowRight /></el-icon>
          </el-button>
        </article>
      </div>

      <!--
        题库工具（导入 PDF / JSON、AI 出题、AI 补解析）—— 降级到题库卡片**下面**。
        它是"把材料变成题库"的那一侧的事，不是学生的第一个动作，所以不再占首屏。
        ⚠️ 功能一个没删：站主自己还要用它导题库（UX 审计块 1-1）。
      -->
      <div class="q-section__head q-toolshead" id="q-tools">
        <h3 class="q-section__title q-toolshead__title">题库工具</h3>
        <span class="q-dim q-section__hint">把老师给的 PDF / JSON 变成题库；只刷题的话不用动这里</span>
      </div>
      <BankTools />
    </section>

    <!-- ─────────────── 给 AI 的模板 ─────────────── -->
    <section class="q-section">
      <el-collapse class="q-collapse">
        <el-collapse-item name="ai">
          <template #title>
            <span class="q-collapse__title">
              <el-icon><MagicStick /></el-icon>
              怎么让 AI 把 PDF 转成这个格式？
            </span>
          </template>
          <div class="q-ai">
            <ol class="q-ai__steps">
              <li>
                先试规则解析（能选中文字的 PDF 都适用，结果确定、不会编答案）：
                <code>python tools/pdf_to_json.py "题库.pdf" --dry-run</code>
              </li>
              <li>
                扫描件或排版太乱，再让 AI 转。把 <code>tools/schema.json</code> 和 PDF 文本一起给它，
                提示词模板在 <code>tools/AI_PROMPT.md</code>。
              </li>
              <li>
                其实没有严格格式也行 —— 下面这种最朴素的写法，拖进来照样能刷：
              </li>
            </ol>
            <div class="q-ai__code">
              <pre>{{ SAMPLE }}</pre>
              <el-button size="small" class="q-ai__copy" @click="copySample">
                <el-icon style="margin-right: 4px"><DocumentCopy /></el-icon>复制
              </el-button>
            </div>
          </div>
        </el-collapse-item>
      </el-collapse>
    </section>
  </div>
</template>

<style scoped>
.q-home {
  display: flex;
  flex-direction: column;
  gap: 34px;
}

/* ---------- Hero ---------- */
.q-hero {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 32px;
  flex-wrap: wrap;
  padding: 14px 0 4px;
}
.q-hero__title {
  font-size: clamp(27px, 4.4vw, 44px);
  font-weight: 850;
  line-height: 1.22;
  letter-spacing: -0.015em;
  color: var(--q-text);
}
.q-hero__sub {
  margin-top: 14px;
  max-width: 620px;
  font-size: 14.5px;
  line-height: 1.75;
  color: var(--q-text-2);
}
.q-hero__code {
  padding: 1px 7px;
  border-radius: 6px;
  background: var(--q-surface-3);
  font-family: var(--q-mono);
  font-size: 12.5px;
  color: var(--q-brand-1);
}
/* 页内锚点（"下面那个框" / "直接挑一套"）：是**按钮不是链接** ——
   这个站是 hash 路由，`href="#x"` 会被当成一条路由（见 scrollTo 的注释）。 */
.q-hero__link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--q-brand-1);
  font: inherit;
  font-weight: 650;
  cursor: pointer;
}
.q-hero__link:hover {
  text-decoration: underline;
}
/* 首访也能看见的那行"有多少题可以刷"（不依赖"选过题库"） */
.q-hero__meta {
  margin-top: 10px;
  font-size: 13.5px;
  color: var(--q-text-3);
}
.q-hero__meta b {
  font-size: 15px;
  font-weight: 800;
  color: var(--q-text);
}

.q-hero__stats {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.q-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  min-width: 74px;
  padding: 13px 14px;
  border-radius: var(--q-r-sm);
  background: var(--q-surface);
  border: 1px solid var(--q-border);
  box-shadow: var(--q-shadow-sm);
}
.q-stat__num {
  font-size: 21px;
  font-weight: 800;
  color: var(--q-text);
  line-height: 1.1;
}
.q-stat__label {
  font-size: 11.5px;
  color: var(--q-text-3);
}

/* ---------- 继续练习 ---------- */
.q-resume {
  display: flex;
  align-items: center;
  gap: 15px;
  padding: 15px 18px;
  background: var(--q-grad-soft);
  border-color: color-mix(in srgb, var(--q-brand-1) 26%, transparent);
}
.q-resume__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 13px;
  background: var(--q-grad);
  color: #fff;
  flex: 0 0 auto;
  box-shadow: var(--q-shadow-brand);
  animation: q-pulse-ring 2s var(--q-ease) infinite;
}
.q-resume__main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.q-resume__main strong {
  font-size: 15px;
  font-weight: 700;
}
.q-resume__main span {
  font-size: 12.5px;
}
.q-resume__bar {
  flex: 1 1 auto;
  min-width: 80px;
  height: 6px;
  border-radius: 99px;
  background: var(--q-surface-3);
  overflow: hidden;
}
.q-resume__bar-in {
  height: 100%;
  border-radius: 99px;
  background: var(--q-grad);
  transition: width 0.4s var(--q-ease);
}
.q-resume__actions {
  display: flex;
  gap: 9px;
  flex: 0 0 auto;
}

/* ---------- 区块 ---------- */
.q-section {
  display: flex;
  flex-direction: column;
  gap: 15px;
  scroll-margin-top: 80px;
}
.q-section__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.q-section__title {
  font-size: 18px;
  font-weight: 800;
  letter-spacing: -0.01em;
  color: var(--q-text);
}
.q-section__hint {
  font-size: 12.5px;
}

/* ---------- 筛选 ---------- */
.q-filters {
  display: flex;
  flex-direction: column;
  gap: 13px;
  padding: 16px 18px;
}
.q-filters__row {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.q-filters__label {
  flex: 0 0 34px;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--q-text-3);
}
.q-filters__chips {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
}
.q-filters__chips .q-chip {
  border: 0;
  cursor: pointer;
  height: 29px;
  padding: 0 13px;
  font-size: 13px;
}
.q-filters__chips .q-chip em {
  font-style: normal;
  font-size: 11px;
  margin-left: 3px;
}
.q-filters__select {
  width: min(430px, 100%);
}
.q-filters__range {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
}
.q-filters__err {
  font-size: 12px;
  color: var(--q-bad);
}

/* ---------- 模式卡片 ---------- */
.q-modes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(270px, 1fr));
  gap: 13px;
}
.q-mode {
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--q-surface);
  color: var(--q-text);
  border: 1px solid var(--q-border);
  overflow: hidden;
}
/* 考试卡片独占整行：左边点进去开始，右边调题量和时长 */
.q-mode--wide {
  grid-column: 1 / -1;
  flex-direction: row;
  align-items: center;
}
.q-mode--wide .q-mode__arrow {
  display: none;
}
.q-mode__hit {
  display: flex;
  align-items: center;
  gap: 13px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 17px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.q-mode__hit:disabled {
  cursor: not-allowed;
}
.q-mode__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 13px;
  flex: 0 0 auto;
  transition: transform var(--q-dur) var(--q-ease);
}
.q-mode:hover:not(.is-disabled) .q-mode__icon {
  transform: scale(1.08) rotate(-4deg);
}
.q-mode--brand .q-mode__icon {
  background: rgba(99, 102, 241, 0.13);
  color: var(--q-brand-1);
}
.q-mode--danger .q-mode__icon {
  background: var(--q-bad-bg);
  color: var(--q-bad);
}
.q-mode--warn .q-mode__icon {
  background: var(--q-warn-bg);
  color: var(--q-star);
}
.q-mode--violet .q-mode__icon {
  background: rgba(139, 92, 246, 0.14);
  color: var(--q-brand-2);
}
.q-mode__body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1 1 auto;
  min-width: 0;
}
.q-mode__body b {
  font-size: 15px;
  font-weight: 700;
}
.q-mode__body em {
  font-style: normal;
  font-size: 12.5px;
  color: var(--q-text-3);
}
.q-mode__arrow {
  color: var(--q-text-3);
  transition: transform var(--q-dur) var(--q-ease);
}
.q-mode:hover:not(.is-disabled) .q-mode__arrow {
  transform: translateX(3px);
  color: var(--q-brand-1);
}
.q-mode.is-disabled {
  opacity: 0.5;
}

.q-mode__exam {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  margin-left: auto;
  padding: 0 17px;
}
.q-mode__exam-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.q-mode__exam-item em {
  font-style: normal;
  font-size: 12px;
  color: var(--q-text-3);
}

/* ---------- 知识图谱入口 ---------- */
.q-graphlink {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 15px 17px;
  background: var(--q-grad-soft);
  border-color: color-mix(in srgb, var(--q-brand-2) 26%, transparent);
}
.q-graphlink__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 13px;
  flex: 0 0 auto;
  background: rgba(139, 92, 246, 0.14);
  color: var(--q-brand-2);
  transition: transform var(--q-dur) var(--q-ease);
}
.q-graphlink:hover .q-graphlink__icon {
  transform: scale(1.08) rotate(-6deg);
}
.q-graphlink__body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1 1 auto;
  min-width: 0;
}
.q-graphlink__body b {
  font-size: 15px;
  font-weight: 700;
}
.q-graphlink__body em {
  font-style: normal;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--q-text-3);
}
.q-graphlink__arrow {
  color: var(--q-text-3);
  transition: transform var(--q-dur) var(--q-ease);
}
.q-graphlink:hover .q-graphlink__arrow {
  transform: translateX(3px);
  color: var(--q-brand-1);
}

/* ---------- 题库列表 ---------- */
.q-banks {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(252px, 1fr));
  gap: 13px;
}
/*
 * 题库卡片内部：以前这些元素**一条样式都没有**（连内边距都没有），
 * 所以「选这套」是个 73×23 的裸按钮 —— 首屏最该点的地方反而最小。
 * 这里只补"读得清、点得到"的最小一套，不动原有的信息结构。
 */
.q-bank {
  display: flex;
  flex-direction: column;
  padding: 14px 15px 15px;
}
.q-bank__go {
  width: 100%;
  margin-top: 10px;
  font-weight: 700;
}
/* 题库工具的标题比正文区标题低一档（它是"另一侧的工具"，不是第二个主区） */
.q-toolshead {
  margin-top: 6px;
  padding-top: 14px;
  border-top: 1px dashed var(--q-border);
}
.q-toolshead__title {
  font-size: 15px;
}
/*
 * 题库简介。教材编译出来的题库把**署名 + 许可 + 已修改说明**写在简介里
 * （CC BY 4.0 的使用条件），所以要给它一个正经位置：两行截断、悬停能看全文。
 */
.q-bank__desc {
  margin: 2px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--q-text-3);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* ---------- AI 折叠说明 ---------- */
.q-collapse {
  border: 1px solid var(--q-border);
  border-radius: var(--q-r);
  background: var(--q-surface);
  padding: 4px 18px;
  overflow: hidden;
}
.q-collapse__title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 14px;
  font-weight: 700;
  color: var(--q-text);
}
.q-ai {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-bottom: 12px;
}
.q-ai__steps {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  font-size: 13.5px;
  line-height: 1.75;
  color: var(--q-text-2);
}
.q-ai__steps code {
  padding: 1.5px 6px;
  border-radius: 6px;
  background: var(--q-surface-3);
  font-family: var(--q-mono);
  font-size: 12.5px;
  color: var(--q-brand-1);
}
.q-ai__code {
  position: relative;
  border-radius: var(--q-r-sm);
  background: var(--q-bg-deep);
  border: 1px solid var(--q-border);
  overflow: hidden;
}
.q-ai__code pre {
  margin: 0;
  padding: 15px 16px;
  overflow-x: auto;
  font-family: var(--q-mono);
  font-size: 12px;
  line-height: 1.7;
  color: var(--q-text-2);
}
.q-ai__copy {
  position: absolute;
  top: 10px;
  right: 10px;
}

@media (max-width: 760px) {
  .q-hero {
    align-items: flex-start;
  }
  /* 窄屏：考试卡片改回上下排，参数落到第二行 */
  .q-mode--wide {
    flex-direction: column;
    align-items: stretch;
  }
  .q-mode--wide .q-mode__exam {
    margin-left: 0;
    padding: 0 17px 16px;
  }
  .q-resume {
    flex-wrap: wrap;
  }
  .q-resume__bar {
    order: 5;
    flex-basis: 100%;
  }
  .q-resume__actions {
    width: 100%;
  }
  .q-resume__actions :deep(.el-button) {
    flex: 1;
  }
  .q-filters__label {
    flex-basis: 100%;
  }
}
</style>
