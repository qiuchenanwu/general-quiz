<script setup>
/**
 * LessonView —— **预习页**（"书本扫描件 → 定制化教学"批 3）
 * ============================================================================
 * 这一页完全不花额度：它显示的是 `core/lesson.js` 从文档模型里**确定性抽取**出来的东西 ——
 * 教材是哪本、这一章的骨架、术语表（每条都钉着教材原话）、代码清单、图/表、
 * 以及"先猜后验"自测题（答案就是教材原文，只从 OCR 可信的行里出）。
 *
 * 为什么先做"预习"而不是"再来一套题"：站主的原话是「上课预习过和没预习，
 * 不是一个量级」。预习要的是**骨架 + 术语（教材自己的措辞）+ 带问题上课堂**，
 * 不是一堆选择题。题目那条线要调模型（要花额度），是下一步。
 *
 * ⚠️ 这一页**不编造任何内容**：每条术语后面都是教材原句；每道自测题都能翻到原文；
 *    有疑问的地方（OCR 没把握/表格列丢了/漏行）单独列成一节，提示你上课时问。
 *
 * ★ 2026-10-11 这一批在这页最上面加了「按你的弱项做一个任务」那张卡：
 *   课本材料就落在这页上，所以**回路的第一截放在这儿** —— 打开预习页第一眼就看得见。
 *   它调 POST /api/quiz/task/（会花额度），拿回来的起手代码直接进编辑器、
 *   下面挂着"运行"和「让 AI 检查」—— 就把「课本 → 任务 → 做 → 运行 → AI 批改」闭起来了。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useBankStore } from '@/stores/bank'
import { useQuizStore } from '@/stores/quiz'
import { lessonToMarkdown } from '@/core/lesson'
import { K, load, remove } from '@/core/storage'
import { ApiError, generateTask as apiGenerateTask } from '@/core/api'
import { completionWords } from '@/core/editor'
import {
  DEFAULT_TASK_SCOPE,
  TASK_NO_WEAK_NOTE,
  TASK_SCOPES,
  guessTaskLang,
  lessonMaterial,
  taskNoQuoteNote,
  taskReviewGoal,
  weakSummary,
  weakTags,
} from '@/core/task'
import AiReview from '@/components/AiReview.vue'
import CodeEditor from '@/components/CodeEditor.vue'
import SnippetRunner from '@/components/SnippetRunner.vue'

const bank = useBankStore()
const quiz = useQuizStore()
/**
 * 当前题库的预习页；没有就看有没有"还没挂上题库"的那一份
 * （见 storage.js 的 lessonPending：出题那一步失败时，预习页不该跟着丢）
 */
function readLesson() {
  const keyed = bank.meta?.id ? load(K.lesson(bank.meta.id), null) : null
  if (keyed) return { lesson: keyed, pending: false }
  const stashed = load(K.lessonPending, null)
  return stashed ? { lesson: stashed, pending: true } : { lesson: null, pending: false }
}
const first = readLesson()
const lesson = ref(first.lesson)
const isPending = ref(first.pending)

const guessing = ref({}) // 题号 → 用户猜的词
const revealed = ref(new Set())

function reload() {
  const next = readLesson()
  lesson.value = next.lesson
  isPending.value = next.pending
  guessing.value = {}
  revealed.value = new Set()
}
reload()

const stats = computed(() => lesson.value?.stats || {})

function reveal(i) {
  const next = new Set(revealed.value)
  if (next.has(i)) next.delete(i)
  else next.add(i)
  revealed.value = next
}
function guessedRight(i) {
  const q = lesson.value?.selfCheck[i]
  if (!q) return false
  return String(guessing.value[i] || '').trim().toLowerCase() === String(q.answer).trim().toLowerCase()
}

/** 导出 Markdown —— 预习提纲可以直接贴进笔记/打印 */
function exportMarkdown() {
  if (!lesson.value) return
  const md = lessonToMarkdown(lesson.value)
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${lesson.value.title || '预习页'}.md`
  a.click()
  URL.revokeObjectURL(url)
}
function clearLesson() {
  remove(K.lessonPending)
  if (bank.meta?.id) remove(K.lesson(bank.meta.id))
  reload()
  ElMessage.success('已清掉这份预习页')
}
function jumpTo(blockId) {
  const el = document.getElementById(`ls-${blockId}`)
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

/* ══════════════════ ★ 按你的弱项做一个任务（回路的第一截） ══════════════════ */

/** 卡片上能挑的语言。SnippetRunner 能跑的就是这两种（Java 真跑 / JS 浏览器沙箱） */
const TASK_LANGS = [
  { value: 'java', label: 'Java' },
  { value: 'js', label: 'JS / Vue' },
]
/** 卡片上能挑的阶段（后端只认这三档；它只影响任务的大小，不改变"不许编"那几条） */
const TASK_LEVELS = ['初学', '在学', '复习']

const task = ref(null)
const taskBusy = ref(false)
const taskNote = ref('')
const taskLang = ref('java')
const taskLevel = ref('在学')
/**
 * 取材范围（站主要的那个开关）：
 *   允许补充（默认）＝ 材料太薄时让模型用通用知识把任务补完整，但绝不许冒充教材原话；
 *   只照书本        ＝ 只用这一章里的内容，教材里没写的一律不提。
 */
const taskScope = ref(DEFAULT_TASK_SCOPE)
/** 起手代码（学生就在这上面改）；他上一次运行看到的东西也在这儿管 */
const code = ref('')
const lastRun = ref(null)
/** 「让 AI 检查」的目标：默认由任务的 goal + 完成判据拼成（学生可以改） */
const reviewGoal = ref('')

/**
 * 他最弱的 2~3 个标签 —— 走 core/analytics.js 的 tagStats（和报告页**同一个判据**）。
 * 一个都没有 = 数据还不够：这时不编弱项，卡片上直说"先按这一章的基础出"。
 */
const weak = computed(() => weakTags(quiz.history, bank.questions))
const weakNames = computed(() => weakSummary(weak.value))
const material = computed(() => lessonMaterial(lesson.value))

/** 编辑器补全词表要的是**起手代码**里的词，不是学生正在打的这份（见 CodeEditor.vue 的注释） */
const words = computed(() => completionWords(task.value?.start || code.value, taskLang.value))

/** 取材范围开关下面那句说明：跟着选中的那一档走 */
const scopeHint = computed(() => {
  const hit = TASK_SCOPES.find((s) => s.value === taskScope.value) || TASK_SCOPES[0]
  return hit.hint
})

function onRan(info) {
  lastRun.value = { text: String(info?.text || ''), ok: !!info?.ok }
}

// 代码一改，上一次的运行结果就不再是"这段代码的结果"了 —— 丢掉，
// 免得把上一版的输出当证据发给 AI（和演武场 ForgeView 同一条规矩）
watch(code, () => {
  lastRun.value = null
})

async function generateTask() {
  if (taskBusy.value) return
  if (!material.value.trim()) {
    taskNote.value = '这一章还没有可用的教材文字（预习页是空的）。'
    return
  }
  taskBusy.value = true
  taskNote.value = ''
  try {
    const r = await apiGenerateTask({
      material: material.value,
      weak: weak.value,
      lang: taskLang.value,
      level: taskLevel.value,
      scope: taskScope.value,
    })
    task.value = {
      goal: String(r?.goal || ''),
      why: String(r?.why || ''),
      // ⚠️ 「允许补充」档下它可能是空串：那表示**这次没有教材引文**（模型给的对不上教材，
      //    我们宁可不给，也不拿它编的话冒充教材原话）。空就不再显示"教材原话"那一行。
      quote: String(r?.quote || ''),
      start: String(r?.start || ''),
      done: Array.isArray(r?.done) ? r.done.map((d) => String(d)) : [],
      hint: String(r?.hint || ''),
      lang: r?.lang === 'js' ? 'js' : 'java',
      fromPage: Number(r?.fromPage || 0),
      scope: r?.scope === 'book' ? 'book' : 'open',
    }
    taskLang.value = task.value.lang
    code.value = task.value.start
    lastRun.value = null
    // AI 批改要**对着这个任务**评，所以把目标 + 完成判据一起递进去
    reviewGoal.value = taskReviewGoal(task.value)
  } catch (e) {
    // 后端给的中文说明原样显示（没配模型 / 限流 / 模型没给出能用的任务都是人话）
    const err = e instanceof ApiError ? e : new ApiError(String(e?.message || e))
    taskNote.value = err.message || '没拿到任务，过一会儿再试。'
  } finally {
    taskBusy.value = false
  }
}

/** 预览页换了一份（重新导入过）就把上一份任务清掉：它引用的教材可能已经不在了 */
watch(lesson, (next) => {
  task.value = null
  taskNote.value = ''
  code.value = ''
  lastRun.value = null
  reviewGoal.value = ''
  taskLang.value = guessTaskLang(next)
})
taskLang.value = guessTaskLang(lesson.value)
</script>

<template>
  <section class="q-wrap ls">
    <template v-if="lesson">
      <header class="ls-head">
        <div class="ls-head__main">
          <h1 class="ls-title">
            <el-icon :size="20"><Reading /></el-icon>
            {{ lesson.title }}
          </h1>
          <p v-if="lesson.book" class="ls-book">教材：{{ lesson.book }}</p>
          <p class="ls-dim">
            由扫描件自动整理（{{ lesson.generatedFrom.pages }} 页 / {{ lesson.generatedFrom.blocks }} 块）·
            未调用任何模型 · 每条术语后面都是教材原话
          </p>
        </div>
        <div class="ls-head__acts">
          <el-button size="small" @click="exportMarkdown">
            <el-icon style="margin-right: 4px"><Download /></el-icon>导出 Markdown
          </el-button>
          <el-button size="small" text @click="clearLesson">清掉</el-button>
        </div>
      </header>

      <div v-if="isPending" class="ls-banner">
        这份预习页还没挂到题库上（"变成题库"那一步没成功）—— 它照样能用：
        骨架、术语、先猜后验都在这儿。重新导入成功后会自动挂上去。
      </div>

      <div class="ls-stats">
        <span class="q-chip">骨架 {{ stats.sections }}</span>
        <span class="q-chip">术语 {{ stats.terms }}</span>
        <span class="q-chip">代码清单 {{ stats.listings }}</span>
        <span class="q-chip">图 {{ stats.figures }} · 表 {{ stats.tables }}</span>
        <span class="q-chip q-chip--brand">先猜后验 {{ stats.selfCheck }}</span>
        <span class="q-chip" :class="stats.checks ? 'ls-warn' : ''">要核对 {{ stats.checks }}</span>
      </div>

      <!-- ★ 任务卡：按你的弱项做一个任务（课本 → 任务 → 做 → 运行 → AI 批改） -->
      <div class="ls-card ls-task">
        <div class="ls-task__head">
          <h2 class="ls-h2">按你的弱项做一个任务</h2>
          <span class="ls-dim">课本 → 任务 → 你动手做 → 运行看结果 → 让 AI 检查</span>
        </div>
        <p class="ls-task__sub">
          <template v-if="weakNames">会用到你最近做错的：{{ weakNames }}</template>
          <template v-else>{{ TASK_NO_WEAK_NOTE }}</template>
        </p>
        <div class="ls-task__bar">
          <span class="ls-dim">语言</span>
          <button
            v-for="l in TASK_LANGS"
            :key="l.value"
            class="ls-task__seg"
            :class="{ 'is-on': taskLang === l.value }"
            @click="taskLang = l.value"
          >
            {{ l.label }}
          </button>
          <span class="ls-dim">阶段</span>
          <button
            v-for="v in TASK_LEVELS"
            :key="v"
            class="ls-task__seg"
            :class="{ 'is-on': taskLevel === v }"
            @click="taskLevel = v"
          >
            {{ v }}
          </button>
          <span class="ls-task__grow" />
          <el-button class="ls-task__go" type="primary" size="small" :loading="taskBusy" @click="generateTask">
            {{ task ? '再生成一个' : '生成任务' }}
          </el-button>
        </div>

        <!-- ★ 取材范围：材料够用就"只照书本"，不够用才"允许补充"（站主要的"针对性的来"） -->
        <div class="ls-task__bar ls-task__bar--scope">
          <span class="ls-dim">取材范围</span>
          <button
            v-for="s in TASK_SCOPES"
            :key="s.value"
            class="ls-task__seg ls-task__scope"
            :class="{ 'is-on': taskScope === s.value }"
            @click="taskScope = s.value"
          >
            {{ s.label }}
          </button>
          <span class="ls-task__scopehint">{{ scopeHint }}</span>
        </div>

        <p v-if="taskNote" class="ls-task__note">{{ taskNote }}</p>

        <div v-if="task" class="ls-task__out" :data-scope="task.scope">
          <p class="ls-task__goal">{{ task.goal }}</p>
          <p class="ls-task__why">为什么是这个任务：{{ task.why }}</p>
          <!-- ★ 引文只能是**逐字核对过**的教材原文；核对不过就一行都不给 -->
          <p v-if="task.quote" class="ls-task__quote" :data-scope="task.scope">
            教材原话<template v-if="task.fromPage">（第 {{ task.fromPage }} 页）</template>：{{ task.quote }}
          </p>
          <!-- ⚠️ 没有引文时**不许**留一个空的引文位（学生会以为这是"教材依据"）。
               这里按档明说"这次没有引文"，措辞见 core/task.js 的 taskNoQuoteNote
               （两档各一句：允许补充档是"引文本来就可以为空"，只照书本档是"材料里挑不出来"）。 -->
          <p v-else class="ls-dim ls-task__noquote" :data-scope="task.scope">
            {{ taskNoQuoteNote(task.scope) }}
          </p>
          <div class="ls-task__done">
            <span class="ls-task__label">什么算完成</span>
            <ul>
              <li v-for="(d, i) in task.done" :key="i">{{ d }}</li>
            </ul>
          </div>
          <p class="ls-task__hint">卡住了先看这里：{{ task.hint }}</p>

          <p class="ls-task__label">起始代码（从这里改，改完点下面的「运行」）</p>
          <CodeEditor
            v-model="code"
            class="ls-task__editor"
            :lang="task.lang"
            :words="words"
            :theme="quiz.settings.codeTheme"
          />
          <SnippetRunner class="ls-task__runner" :code="code" :lang="task.lang" @ran="onRan" />
          <AiReview v-model:goal="reviewGoal" :code="code" :lang="task.lang" :last-run="lastRun" />
        </div>
      </div>

      <!-- ① 骨架 -->
      <div class="ls-card">
        <h2 class="ls-h2">这一章的骨架</h2>
        <ul class="ls-outline">
          <li v-for="o in lesson.outline" :key="o.blockId" :style="{ paddingLeft: (o.level - 1) * 18 + 'px' }">
            <button class="ls-link" @click="jumpTo(o.blockId)">{{ o.title }}</button>
            <span class="ls-dim">
              p{{ o.page }}
              <template v-if="o.code"> · 代码 {{ o.code }}</template>
              <template v-if="o.figures"> · 图 {{ o.figures }}</template>
              <template v-if="o.tables"> · 表 {{ o.tables }}</template>
            </span>
          </li>
        </ul>
      </div>

      <!-- ② 术语 -->
      <div v-if="lesson.terms.length" class="ls-card">
        <h2 class="ls-h2">术语（后面那句是教材原话，考试按教材）</h2>
        <dl class="ls-terms">
          <template v-for="t in lesson.terms" :key="t.term">
            <dt>
              {{ t.term }}
              <span class="ls-dim">p{{ t.page }}{{ t.source === 'textbook-table' ? ' · 来自表格' : '' }}</span>
            </dt>
            <dd>{{ t.quote }}</dd>
          </template>
        </dl>
      </div>

      <!-- ③ 先猜后验 -->
      <div v-if="lesson.selfCheck.length" class="ls-card">
        <h2 class="ls-h2">先猜后验（先自己猜，再翻教材对）</h2>
        <p class="ls-dim">
          答案就是教材原文里的那个词。只从「识别可信」的行里出题 —— 认不准的行宁可不出，
          也不给你一个错的答案。
        </p>
        <ol class="ls-quiz">
          <li v-for="(q, i) in lesson.selfCheck" :key="i">
            <p class="ls-quiz__stem">{{ q.stem }}</p>
            <div class="ls-quiz__row">
              <el-input
                v-model="guessing[i]"
                size="small"
                placeholder="先猜一个词"
                style="max-width: 220px"
                @keyup.enter="reveal(i)"
              />
              <el-button size="small" @click="reveal(i)">{{ revealed.has(i) ? '收起' : '对答案' }}</el-button>
              <span v-if="revealed.has(i)" class="ls-verdict" :class="guessedRight(i) ? 'ok' : 'no'">
                {{ guessedRight(i) ? '猜对了' : `答案是 ${q.answer}` }}
              </span>
            </div>
            <p v-if="revealed.has(i)" class="ls-quiz__verify">{{ q.verify }}</p>
          </li>
        </ol>
      </div>

      <!-- ④ 代码清单 -->
      <div v-if="lesson.listings.length" class="ls-card">
        <h2 class="ls-h2">代码清单</h2>
        <el-collapse>
          <el-collapse-item v-for="l in lesson.listings" :key="l.id" :name="l.id">
            <template #title>
              <span class="ls-listing__title">
                {{ l.caption || l.id }}
                <span class="ls-dim">{{ l.section }} · p{{ l.page }} · {{ l.lineCount }} 行</span>
                <span v-if="!l.verified" class="ls-tag ls-tag--warn">有要核对的地方</span>
                <span v-if="l.missingLines.length" class="ls-tag ls-tag--bad">
                  漏了第 {{ l.missingLines.slice(0, 6).join('、') }}{{ l.missingLines.length > 6 ? '…' : '' }} 行
                </span>
              </span>
            </template>
            <div :id="`ls-${l.id}`">
              <pre class="ls-code">{{ l.code }}</pre>
              <ul v-if="l.issues.length" class="ls-issues">
                <li v-for="(m, k) in l.issues" :key="k">{{ m }}</li>
              </ul>
            </div>
          </el-collapse-item>
        </el-collapse>
      </div>

      <!-- ⑤ 图 / 表 -->
      <div v-if="lesson.figures.length || lesson.tables.length" class="ls-card">
        <h2 class="ls-h2">图与表</h2>
        <ul class="ls-list">
          <li v-for="f in lesson.figures" :key="f.blockId">
            <el-icon :size="13"><Picture /></el-icon> {{ f.caption || f.blockId }}
            <span class="ls-dim">p{{ f.page }}</span>
          </li>
          <li v-for="t in lesson.tables" :key="t.blockId">
            <el-icon :size="13"><Grid /></el-icon> {{ t.caption || t.blockId }}
            <span class="ls-dim">p{{ t.page }} · {{ t.rows.length }} 行</span>
            <span class="ls-tag ls-tag--warn">列关系已丢，要对着原书看</span>
          </li>
        </ul>
      </div>

      <!-- ⑥ 待核对 / 带问题上课堂 -->
      <div v-if="lesson.checks.length" class="ls-card">
        <h2 class="ls-h2">上课前要问清的地方（{{ lesson.checks.length }} 条）</h2>
        <p class="ls-dim">这些是 OCR 没把握、或者版面关系丢了的地方 —— 正是"带着问题上课堂"的清单。</p>
        <ul class="ls-list">
          <li v-for="(c, i) in lesson.checks.slice(0, 40)" :key="i">
            <span class="ls-dim">p{{ c.page }}</span> {{ c.message }}
            <em v-if="c.text" class="ls-dim">{{ c.text.slice(0, 60) }}</em>
          </li>
        </ul>
        <p v-if="lesson.checks.length > 40" class="ls-dim">（还有 {{ lesson.checks.length - 40 }} 条，导出 Markdown 能看到全部）</p>
      </div>
    </template>

    <div v-else class="ls-empty">
      <el-icon :size="34"><Reading /></el-icon>
      <h2>还没有预习页</h2>
      <p>
        预习页是扫描件专属的产物：在「题库工具」里把教材的扫描件 PDF 拖进来，
        校对台上核对完，这一页就会自动生成。
      </p>
      <p class="ls-dim">
        它会给你：这一章的骨架、术语表（附教材原话）、代码清单、图/表索引、
        以及几道"先猜后验" —— 全程不调用任何模型，所以不花额度。
      </p>
      <template v-if="!bank.meta?.id">
        <p class="ls-dim">（先在首页选一套题库，预习页是挂在题库上的）</p>
      </template>
    </div>
  </section>
</template>

<style scoped>
.ls {
  padding: 18px 0 60px;
}
.ls-head {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  justify-content: space-between;
  flex-wrap: wrap;
}
.ls-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 4px;
  font-size: 21px;
}
.ls-book {
  margin: 0 0 2px;
  font-weight: 600;
}
.ls-dim {
  color: var(--q-text-3);
  font-size: 12.5px;
}
.ls-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 12px 0 16px;
}
.ls-banner {
  background: var(--el-color-warning-light-9);
  border: 1px solid var(--el-color-warning-light-5);
  border-radius: 10px;
  padding: 9px 12px;
  font-size: 13px;
  line-height: 1.6;
  margin-bottom: 12px;
}
.ls-warn {
  background: var(--el-color-warning-light-8);
  color: var(--el-color-warning);
}
/* ── ★ 任务卡（回路的第一截：课本材料就在这页上，所以它排在最前面） ── */
.ls-task {
  border-color: var(--q-brand-1, var(--el-color-primary));
  background: var(--q-surface-2, var(--el-fill-color-lighter));
}
.ls-task__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.ls-task__sub {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--q-text-2);
}
.ls-task__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.ls-task__grow {
  flex: 1;
}
.ls-task__seg {
  border: 1px solid var(--q-border);
  background: transparent;
  color: var(--q-text-2);
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
}
.ls-task__seg.is-on {
  border-color: var(--q-brand-1, var(--el-color-primary));
  color: var(--q-brand-1, var(--el-color-primary));
  font-weight: 600;
}
/* 取材范围那一条单独一行，说明文字跟在按钮后面（不挤在语言/阶段那一行） */
.ls-task__bar--scope {
  margin-top: 6px;
}
.ls-task__scopehint {
  font-size: 12px;
  color: var(--q-text-3);
}
.ls-task__noquote {
  margin: 0 0 8px;
  line-height: 1.7;
}
.ls-task__note {
  margin: 10px 0 0;
  padding: 8px 10px;
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  background: var(--q-warn-bg, var(--el-color-warning-light-9));
  border-radius: 6px;
  color: var(--q-text-2);
}
.ls-task__out {
  margin-top: 12px;
}
.ls-task__goal {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.7;
}
.ls-task__why,
.ls-task__hint {
  margin: 0 0 6px;
  font-size: 13px;
  line-height: 1.75;
  color: var(--q-text-2);
}
.ls-task__quote {
  margin: 0 0 8px;
  padding: 6px 10px;
  font-size: 13px;
  line-height: 1.75;
  border-left: 3px solid var(--q-brand-1, var(--el-color-primary));
  background: var(--q-surface-3, var(--el-fill-color-light));
  border-radius: 0 6px 6px 0;
}
.ls-task__done {
  margin: 0 0 8px;
}
.ls-task__done ul {
  margin: 4px 0 0;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.8;
}
.ls-task__label {
  font-size: 12px;
  color: var(--q-text-3);
}
.ls-task__editor {
  margin: 6px 0 8px;
}
.ls-card {
  background: var(--q-card, #fff);
  border: 1px solid var(--q-line, rgba(0, 0, 0, 0.08));
  border-radius: 12px;
  padding: 14px 16px;
  margin-bottom: 14px;
}
.ls-h2 {
  margin: 0 0 8px;
  font-size: 15px;
}
.ls-outline {
  list-style: none;
  margin: 0;
  padding: 0;
}
.ls-outline li {
  padding: 3px 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.ls-link {
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  padding: 0;
  text-align: left;
}
.ls-link:hover {
  color: var(--el-color-primary);
}
.ls-terms {
  margin: 0;
}
.ls-terms dt {
  font-weight: 600;
  margin-top: 8px;
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.ls-terms dd {
  margin: 2px 0 0;
  line-height: 1.65;
}
.ls-quiz {
  margin: 6px 0 0;
  padding-left: 20px;
}
.ls-quiz li {
  margin-bottom: 10px;
}
.ls-quiz__stem {
  margin: 0 0 6px;
}
.ls-quiz__row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ls-verdict {
  font-weight: 600;
  font-size: 13px;
}
.ls-verdict.ok {
  color: var(--el-color-success);
}
.ls-verdict.no {
  color: var(--el-color-danger);
}
.ls-quiz__verify {
  margin: 6px 0 0;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12.5px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  padding: 6px 8px;
  white-space: pre-wrap;
  word-break: break-all;
}
.ls-listing__title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.ls-tag {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 8px;
}
.ls-tag--warn {
  background: var(--el-color-warning-light-8);
  color: var(--el-color-warning);
}
.ls-tag--bad {
  background: var(--el-color-danger-light-8);
  color: var(--el-color-danger);
}
.ls-code {
  margin: 0;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.55;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  padding: 8px 10px;
  white-space: pre-wrap;
  word-break: break-all;
}
.ls-issues {
  margin: 8px 0 0;
  padding-left: 18px;
  color: var(--el-color-danger);
  font-size: 12.5px;
}
.ls-list {
  margin: 0;
  padding-left: 18px;
  line-height: 1.8;
}
.ls-empty {
  text-align: center;
  padding: 46px 20px;
  color: var(--q-text-3);
}
.ls-empty h2 {
  color: var(--q-text-1, inherit);
  margin: 10px 0 6px;
  font-size: 17px;
}
.ls-empty p {
  max-width: 620px;
  margin: 6px auto;
  line-height: 1.7;
}
</style>
