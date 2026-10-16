<script setup>
/**
 * DiagnoseView —— **诊断先行**（`#/diagnose`）。
 *
 * 为什么要有这一页（HANDOVER 待办第 2 条，也是用户自己提过的那句
 * 「预习过和没预习不是一个量级」）：
 *
 *   刷题站以前对所有人都是同一套流程：从第 1 题顺序刷。
 *   可"预习过的人"需要的是**找错、手写、把话说清楚**，
 *   "完全没接触过的人"需要的是**先读原文、先跑最小示例**。
 *   同一套流程必然有一半人在浪费时间 —— 于是有了这三步：
 *
 *     ① 抽 10 道又快又能分辨的题（core/diagnose.js，题目固定、两次可比）
 *     ② 按正确率分流：≥80 上强度 / ≥50 边做边补 / <50 先看原文
 *     ③ 给出**具体做什么**，按钮点下去真的换一套题（不是一句鼓励）
 *
 * 诊断本身**不记进度、不进错题本、不写作答历史** —— 它只回答"你现在在哪"，
 * 不该污染你的学习记录。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useBankStore } from '@/stores/bank'
import { useQuizStore } from '@/stores/quiz'
import { K, load, save } from '@/core/storage'
import { TYPE_LABEL } from '@/core/normalize'
import { plainText } from '@/core/text'
import {
  DIAGNOSE_COUNT,
  DIAGNOSE_MIN,
  judgeOne,
  pickDiagnostic,
  planFor,
  routeFor,
  sessionFiltersFor,
  summarizeDiagnostic,
} from '@/core/diagnose'
import OptionItem from '@/components/OptionItem.vue'
import CodeRunner from '@/components/CodeRunner.vue'

const bank = useBankStore()
const quiz = useQuizStore()
const router = useRouter()

const phase = ref('setup') // setup | running | result
const scope = ref('') // '' = 整本，否则是 chapter 名
const count = ref(DIAGNOSE_COUNT)
const items = ref([])
const index = ref(0)
const picked = ref([])
const revealed = ref(false)
const rows = ref([]) // [{ q, ok }]
const lastResult = ref(null) // 上次诊断（从 storage 读）

const chapterList = computed(() => {
  const map = new Map()
  bank.questions.forEach((q) => {
    const name = q.chapter || ''
    if (!name) return
    map.set(name, (map.get(name) || 0) + 1)
  })
  return [...map.entries()].map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total)
})

const scopedQuestions = computed(() =>
  scope.value ? bank.questions.filter((q) => q.chapter === scope.value) : bank.questions,
)

const current = computed(() => items.value[index.value] || null)
const isCode = computed(() => current.value?.type === 'code')
const isMulti = computed(() => current.value?.type === 'multiple')

const summary = computed(() => summarizeDiagnostic(rows.value))
const plan = computed(() =>
  planFor({
    summary: summary.value,
    chapterName: scope.value,
    questions: scopedQuestions.value,
  }),
)

/** 该章的原文清单（"先读原文"那一步要真的能点开） */
const readingList = computed(() => {
  const seen = new Set()
  const out = []
  for (const q of scopedQuestions.value) {
    const src = q.source
    if (!src?.url || seen.has(src.url)) continue
    seen.add(src.url)
    out.push({ url: src.url, heading: src.heading || src.url, no: q.no })
    if (out.length >= 10) break
  }
  return out
})

function loadLast() {
  const rec = load(K.diagnose(bank.meta?.id), null)
  lastResult.value = rec && typeof rec === 'object' ? rec : null
}
loadLast()

/* ------------------------------- 做题 ------------------------------- */

function start() {
  const list = pickDiagnostic({ questions: bank.questions, chapter: scope.value, count: count.value })
  if (list.length < Math.min(DIAGNOSE_MIN, scopedQuestions.value.length)) {
    ElMessage.warning('这一章的题目太少，没法做诊断（先去刷一遍吧）')
    return
  }
  items.value = list
  index.value = 0
  picked.value = []
  revealed.value = false
  rows.value = []
  phase.value = 'running'
}

function toggle(key) {
  if (revealed.value) return
  if (isMulti.value) {
    picked.value = picked.value.includes(key)
      ? picked.value.filter((k) => k !== key)
      : [...picked.value, key]
    return
  }
  picked.value = [key]
}

/** 代码题的提交（填空/找错行/修好它） */
function submitCode(values) {
  if (revealed.value) return
  picked.value = (Array.isArray(values) ? values : [values]).map(String)
  reveal()
}

function canReveal() {
  if (!current.value) return false
  if (isCode.value) return picked.value.length > 0 || current.value.mode === 'fix'
  return picked.value.length > 0
}

function reveal() {
  const q = current.value
  if (!q || revealed.value) return
  // 修好它：交上来的就是运行输出，判定交给同一份 core/code.js
  const ok = judgeOne(q, picked.value)
  rows.value = [...rows.value, { q, ok, picked: [...picked.value] }]
  revealed.value = true
}

function next() {
  if (index.value >= items.value.length - 1) {
    finish()
    return
  }
  index.value += 1
  picked.value = []
  revealed.value = false
}

function finish() {
  const s = summary.value
  phase.value = 'result'
  const rec = {
    chapter: scope.value,
    total: s.total,
    correct: s.correct,
    accuracy: s.accuracy,
    route: s.route.key,
    at: Date.now(),
  }
  save(K.diagnose(bank.meta?.id), rec)
  lastResult.value = rec
}

function redo() {
  phase.value = 'setup'
  items.value = []
  rows.value = []
}

/* ------------------------------- 分流后的动作 ------------------------------- */

function startSession(kind) {
  const route = summary.value.route.key
  let filters = { types: [], tags: [], chapter: scope.value, codeModes: [] }
  let label = '本章练习'
  if (kind === 'practice-spot') {
    filters = { ...filters, types: ['code'], codeModes: ['spot'] }
    label = '找错行'
  } else if (kind === 'practice-fix') {
    filters = { ...filters, types: ['code'], codeModes: ['fix'] }
    label = '修好它'
  } else if (kind === 'practice-write') {
    filters = { ...filters, types: ['code'], codeModes: ['write'] }
    label = '手写'
  } else if (kind === 'practice-fill') {
    filters = { ...filters, types: ['code'], codeModes: ['fill'] }
    label = '可跑的填空题'
  } else if (kind === 'practice-seq') {
    // 本章顺序过一遍
  } else if (kind === 'practice-wrong') {
    if (!quiz.wrongCount) {
      ElMessage.info('错题本是空的')
      return
    }
    const ok = quiz.startSession({ mode: 'wrong' })
    if (ok) router.push('/practice')
    return
  } else if (kind === 'coach') {
    // 让"问 AI"有题可问：直接进本章练习，题卡右上角就是 问 AI
    const r = sessionFiltersFor(route, { chapter: scope.value })
    filters = r.filters
    label = r.label
    ElMessage.info('进去之后点题目右上角的「问 AI」，就着那道题追问')
  }

  const ok = quiz.startSession({ mode: 'seq', filters })
  if (!ok) {
    ElMessage.warning(`这一章没有${label}的题`)
    return
  }
  router.push('/practice')
}

function goDiagram() {
  router.push('/diagram')
}

function scrollToReading() {
  document.getElementById('q-diag-read')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

const TYPE_TEXT = { advanced: '直接上强度', standard: '边做边补', remedial: '先看原文再动手' }

/* ------------------------------- 键盘 ------------------------------- */
/**
 * 快捷键（和练习页同一套手感，用户报过"之前的快捷键逻辑用不了"）：
 *   A~J / 1~9   选选项（数字按选项顺序）
 *   Enter       提交 → 判定后再按就是「下一题 / 看结果」
 *   Esc         回上一步（诊断中退出、结果页重来）
 * 输入框里打字时不抢键（和练习页一样的判断）。
 */
function onKeydown(e) {
  const tag = (e.target?.tagName || '').toLowerCase()
  if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) {
    // 填空框里：Ctrl/Cmd+Enter 交给组件自己（它绑定的是"提交判定"）
    return
  }

  if (e.key === 'Escape') {
    if (phase.value === 'running') redo()
    else if (phase.value === 'result') redo()
    return
  }

  if (phase.value === 'setup') {
    if (e.key === 'Enter') {
      e.preventDefault()
      start()
    }
    return
  }

  if (phase.value === 'result') {
    if (e.key === 'Enter') {
      e.preventDefault()
      redo()
    }
    return
  }

  // 诊断中
  if (e.key === 'Enter') {
    e.preventDefault()
    if (revealed.value) next()
    else if (canReveal()) reveal()
    return
  }
  if (revealed.value || !current.value) return

  const upper = e.key.length === 1 ? e.key.toUpperCase() : e.key
  const opts = current.value.options || []
  if (/^[1-9]$/.test(e.key)) {
    const opt = opts[Number(e.key) - 1]
    if (opt) {
      e.preventDefault()
      toggle(opt.key)
    }
    return
  }
  if (/^[A-J]$/.test(upper) && opts.some((o) => o.key === upper)) {
    e.preventDefault()
    toggle(upper)
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="q-diag">
    <!-- ─────────────── 还没开始 ─────────────── -->
    <section v-if="phase === 'setup'" class="q-card">
      <header class="q-diag__head">
        <span class="q-chip q-chip--brand">诊断先行</span>
        <h1>先花 10 分钟，摸清这一章该怎么学</h1>
      </header>
      <p class="q-diag__lead">
        抽 {{ count }} 道题，答完就分流：<b>≥{{ 80 }}</b> 直接去做「找错行 / 修好它」，
        中间档边做边补，<b>&lt;50</b> 先读原文、先跑最小示例。
        诊断不写进度、不进错题本 —— 它只回答"你现在在哪"。
      </p>

      <div class="q-diag__field">
        <label>诊断范围</label>
        <el-select v-model="scope" placeholder="整本题库" class="q-diag__scope">
          <el-option label="整本题库（混合各章）" value="" />
          <el-option
            v-for="c in chapterList"
            :key="c.name"
            :label="`${c.name}（${c.total} 题）`"
            :value="c.name"
          />
        </el-select>
      </div>

      <div class="q-diag__field">
        <label>题量</label>
        <!-- 用自己的分段控件：Element 的 el-radio-button 在这套主题里会被压窄，
             三个选项的文字全裁成"10 道（默…"（用户报的"字都显示不全"） -->
        <div class="q-diag__seg">
          <button
            v-for="n in [6, 10, 16]"
            :key="n"
            class="q-diag__segbtn"
            :class="{ 'is-active': count === n }"
            @click="count = n"
          >
            {{ n }} 道<span class="q-diag__segsub">{{ n === 6 ? '（快）' : n === 10 ? '（默认）' : '（更准）' }}</span>
          </button>
        </div>
      </div>

      <div class="q-diag__actions">
        <el-button type="primary" size="large" @click="start">
          <el-icon style="margin-right: 5px"><MagicStick /></el-icon>开始诊断
          <span class="q-kbd" style="margin-left: 8px">Enter</span>
        </el-button>
        <span class="q-dim">题目是按固定种子抽的：同一章、同一题量，两次诊断是同一批题，分才能比。</span>
      </div>

      <p v-if="lastResult" class="q-diag__last">
        <el-icon><Clock /></el-icon>
        上次诊断：{{ lastResult.chapter || '整本题库' }} ·
        {{ lastResult.correct }}/{{ lastResult.total }}（{{ lastResult.accuracy }}%）·
        {{ TYPE_TEXT[lastResult.route] || lastResult.route }} ·
        {{ new Date(lastResult.at).toLocaleString('zh-CN') }}
      </p>
    </section>

    <!-- ─────────────── 诊断中 ─────────────── -->
    <section v-else-if="phase === 'running' && current" class="q-card q-diag__run">
      <header class="q-diag__bar">
        <span class="q-chip q-chip--brand">诊断</span>
        <span class="q-num">{{ index + 1 }} / {{ items.length }}</span>
        <div class="q-diag__pbar"><div :style="{ width: ((index + 1) / items.length) * 100 + '%' }"></div></div>
      </header>

      <div class="q-diag__meta">
        <span class="q-chip">{{ TYPE_LABEL[current.type] || current.type }}</span>
        <!-- 题号要露出来：诊断是"抽题"的，不显示题号会让人不知道自己在第几题 -->
        <span class="q-chip q-num q-diag__no">第 {{ current.no }} 题</span>
        <span v-if="current.chapter" class="q-chip">{{ current.chapter }}</span>
        <span v-for="t in (current.tags || []).slice(0, 3)" :key="t" class="q-chip">{{ t }}</span>
      </div>

      <h2 class="q-diag__stem">{{ current.stem }}</h2>

      <CodeRunner
        v-if="isCode"
        :question="current"
        :pick="picked"
        :revealed="revealed"
        :ok="revealed && rows[rows.length - 1]?.ok"
        :answer-keys="current.answer"
        @submit="submitCode"
      />

      <div v-else class="q-diag__opts">
        <OptionItem
          v-for="opt in current.options"
          :key="opt.key"
          :option="opt"
          :judge="current.type === 'judge'"
          :picked="picked.includes(opt.key)"
          :revealed="revealed"
          :is-answer="(current.answer || []).includes(opt.key)"
          :disabled="revealed"
          @pick="toggle"
        />
      </div>

      <footer class="q-diag__foot">
        <el-button v-if="!revealed && !isCode" type="primary" :disabled="!canReveal()" @click="reveal">
          提交
          <span class="q-kbd" style="margin-left: 8px">Enter</span>
        </el-button>
        <el-button v-if="!revealed && !isCode" text @click="picked = []">先跳过</el-button>
        <el-button v-if="revealed" type="primary" @click="next">
          {{ index >= items.length - 1 ? '看诊断结果' : '下一题' }}
          <span class="q-kbd" style="margin-left: 8px">Enter</span>
          <el-icon style="margin-left: 4px"><ArrowRight /></el-icon>
        </el-button>
        <span v-if="!revealed && !isCode" class="q-diag__keys q-dim">
          <span class="q-kbd">A</span>~<span class="q-kbd">J</span> /
          <span class="q-kbd">1</span>~<span class="q-kbd">9</span> 选，<span class="q-kbd">Enter</span> 提交
        </span>
        <span v-if="revealed" class="q-dim">
          {{ rows[rows.length - 1]?.ok ? '✓ 对' : '✗ 错' }}
          <!-- 这是解析预览（一行 80 字），排不下 markdown —— 先把标记剥成纯文本，
               别让 `**强调**` 的星号亮出来（和题目卡片/错题本同一份判据：core/text.js） -->
          <template v-if="current.analysis">· {{ plainText(current.analysis).slice(0, 80) }}</template>
        </span>
      </footer>
    </section>

    <!-- ─────────────── 分流结果 ─────────────── -->
    <section v-else-if="phase === 'result'" class="q-card q-diag__result">
      <header class="q-diag__head">
        <span class="q-chip q-chip--brand">诊断结果</span>
        <h1>{{ summary.route.title }}</h1>
      </header>

      <div class="q-diag__score" :class="`is-${summary.route.tone}`">
        <b class="q-num">{{ summary.accuracy }}%</b>
        <span>{{ summary.correct }} / {{ summary.total }} 道对（{{ scope || '整本题库' }}）</span>
      </div>

      <p class="q-diag__lead">{{ summary.route.desc }}</p>

      <div v-if="summary.weakTags.length" class="q-diag__weak">
        <span class="q-dim">最弱的地方：</span>
        <span v-for="t in summary.weakTags" :key="t.name" class="q-chip q-chip--warn">
          {{ t.name }} {{ t.accuracy }}%
        </span>
      </div>

      <!-- 具体做什么 -->
      <ol class="q-diag__steps">
        <li v-for="s in plan.steps" :key="s.label">
          <b>{{ s.label }}</b>
          <em>{{ s.detail }}</em>
          <el-button
            v-if="s.action.startsWith('practice-') || s.action === 'coach'"
            size="small"
            type="primary"
            plain
            @click="startSession(s.action)"
          >
            去练
          </el-button>
          <el-button v-else-if="s.action === 'diagram'" size="small" plain @click="goDiagram">
            去画图
          </el-button>
          <el-button v-else-if="s.action === 'read'" size="small" plain @click="scrollToReading">
            看原文清单
          </el-button>
          <el-button v-else-if="s.action === 'rediagnose'" size="small" plain @click="redo">
            重新诊断
          </el-button>
        </li>
      </ol>

      <!-- "先读原文"那一步的落点：这一章每道题的出处 -->
      <div v-if="readingList.length" id="q-diag-read" class="q-diag__read">
        <h3><el-icon><Link /></el-icon>这一章的原文（点开就是官方文档那一节）</h3>
        <ul>
          <li v-for="r in readingList" :key="r.url">
            <a :href="r.url" target="_blank" rel="noopener noreferrer">{{ r.heading }}</a>
            <span class="q-dim">（第 {{ r.no }} 题的出处）</span>
          </li>
        </ul>
      </div>

      <div class="q-diag__actions">
        <el-button @click="redo">重新诊断</el-button>
        <el-button text @click="router.push('/')">返回题库</el-button>
        <span class="q-dim">诊断只用于分流，不写学习记录；练习才会写。</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.q-diag {
  max-width: 880px;
  margin: 0 auto;
  padding: 18px 16px 60px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.q-diag__head h1 {
  margin: 8px 0 0;
  font-size: 21px;
}
.q-diag__lead {
  margin: 10px 0 0;
  font-size: 13.5px;
  line-height: 1.85;
  color: var(--q-text-2);
}
.q-diag__field {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  flex-wrap: wrap;
}
.q-diag__field label {
  flex: none;
  width: 68px;
  font-size: 13px;
  color: var(--q-text-3);
}
.q-diag__scope {
  width: 320px;
  max-width: 100%;
}

/* 自己的分段控件（替代 el-radio-button —— 那份样式在我们的主题里会被压窄，
   三个选项的文字全被裁掉）。 */
.q-diag__seg {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  border-radius: var(--q-r-full);
  background: var(--q-surface-3);
  border: 1px solid var(--q-border);
  flex-wrap: wrap;
}
.q-diag__segbtn {
  border: 0;
  background: none;
  color: var(--q-text-2);
  font-size: 13px;
  font-weight: 600;
  padding: 6px 14px;
  border-radius: var(--q-r-full);
  cursor: pointer;
  white-space: nowrap;
  transition: all var(--q-dur) var(--q-ease);
}
.q-diag__segbtn:hover:not(.is-active) {
  color: var(--q-brand-1);
  background: color-mix(in srgb, var(--q-brand-1) 8%, transparent);
}
.q-diag__segbtn.is-active {
  background: var(--q-surface);
  color: var(--q-brand-1);
  box-shadow: var(--q-shadow-sm);
}
.q-diag__segsub {
  color: var(--q-text-3);
  font-weight: 500;
  font-size: 12px;
}
.q-diag__segbtn.is-active .q-diag__segsub {
  color: color-mix(in srgb, var(--q-brand-1) 70%, var(--q-text-3));
}
.q-diag__actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 20px;
  font-size: 12px;
}
.q-diag__last {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 16px 0 0;
  padding: 9px 12px;
  border-radius: var(--q-r-sm);
  background: var(--q-surface-2);
  border: 1px solid var(--q-border);
  font-size: 12.5px;
  color: var(--q-text-2);
}

/* 做题中 */
.q-diag__bar {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
  color: var(--q-text-3);
}
.q-diag__pbar {
  flex: 1;
  height: 6px;
  border-radius: var(--q-r-full);
  background: var(--q-surface-3);
  overflow: hidden;
}
.q-diag__pbar > div {
  height: 100%;
  background: var(--q-grad);
  transition: width var(--q-dur) var(--q-ease);
}
.q-diag__meta {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 14px;
}
.q-diag__stem {
  margin: 12px 0 4px;
  font-size: var(--q-stem-size);
  line-height: 1.7;
}
.q-diag__opts {
  display: flex;
  flex-direction: column;
  gap: 9px;
  margin-top: 12px;
}
.q-diag__foot {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 18px;
  font-size: 12.5px;
}
.q-diag__keys {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

/* 结果 */
.q-diag__score {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-top: 16px;
}
.q-diag__score b {
  font-size: 44px;
  line-height: 1;
}
.q-diag__score.is-ok b {
  color: var(--q-ok);
}
.q-diag__score.is-brand b {
  color: var(--q-brand-1);
}
.q-diag__score.is-warn b {
  color: var(--q-warn);
}
.q-diag__score span {
  font-size: 13px;
  color: var(--q-text-3);
}
.q-diag__weak {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 14px;
  font-size: 12.5px;
}
.q-diag__steps {
  margin: 18px 0 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.q-diag__steps li {
  font-size: 13.5px;
  line-height: 1.7;
}
.q-diag__steps b {
  display: block;
}
.q-diag__steps em {
  display: block;
  font-style: normal;
  font-size: 12.5px;
  color: var(--q-text-3);
  margin: 3px 0 7px;
}
.q-diag__read {
  margin-top: 22px;
  padding: 13px 15px;
  border-radius: var(--q-r-sm);
  background: var(--q-surface-2);
  border: 1px solid var(--q-border);
}
.q-diag__read h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 8px;
  font-size: 14px;
}
.q-diag__read ul {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.95;
}
.q-diag__read a {
  color: var(--q-brand-1);
  text-decoration: none;
}
.q-diag__read a:hover {
  text-decoration: underline;
}

@media (max-width: 640px) {
  .q-diag__field {
    flex-direction: column;
    align-items: flex-start;
  }
  .q-diag__score b {
    font-size: 34px;
  }
}
</style>
