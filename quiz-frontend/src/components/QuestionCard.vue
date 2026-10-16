<script setup>
/**
 * QuestionCard —— 一道题的完整展示：题干 + 选项 + 判定反馈 + 解析。
 * 纯展示组件，所有状态都由 props 传入，交互通过事件抛出。
 */
import { computed, ref, watch } from 'vue'
import OptionItem from './OptionItem.vue'
import NoteEditor from './NoteEditor.vue'
import CodeRunner from './CodeRunner.vue'
import AnalysisBody from './AnalysisBody.vue'
import { TYPE_LABEL } from '@/core/normalize'
import { stemHtml } from '@/core/text'

const props = defineProps({
  question: { type: Object, required: true },
  pick: { type: Array, default: () => [] },
  revealed: { type: Boolean, default: false },
  ok: { type: Boolean, default: false },
  fav: { type: Boolean, default: false },
  /** 考试模式：做题过程中不揭示答案 */
  examMode: { type: Boolean, default: false },
  /** 背题模式：只亮答案、没判定，别显示「回答错误」 */
  peeked: { type: Boolean, default: false },
  /** AI 功能是否启用（开源版默认 false；启用才显示"问 AI"按钮） */
  aiEnabled: { type: Boolean, default: false },
  /** 当前连对次数（≥2 时在判定条上亮出来，也是连对音效的来源） */
  combo: { type: Number, default: 0 },
  /** 这道题的笔记内容（没有就空串） */
  note: { type: String, default: '' },
  /** 笔记编辑器是否展开（由父组件控制，这样 N 快捷键能打开它） */
  noteOpen: { type: Boolean, default: false },
  /** 是否显示「下一题」按钮（最后一题由父组件决定文案） */
  showNext: { type: Boolean, default: true },
  isLast: { type: Boolean, default: false },
  /**
   * **有效答案**（用户修正过就用修正的）。由父组件从 store 取，别在这里读 q.answer ——
   * 用户改了答案之后，界面上显示的正确答案必须跟着变。
   */
  answerKeys: { type: Array, default: () => [] },
  /** **有效解析**（用户手写 > AI 补的 > 题库自带），同样由父组件给 */
  analysis: { type: String, default: '' },
  /** 这道题的答案/解析是否被用户改过（界面上要给个标记 + 恢复入口） */
  overridden: { type: Boolean, default: false },
  /** 「重新生成解析」是否正在跑（按钮转圈 + 禁用） */
  regening: { type: Boolean, default: false },
})

const emit = defineEmits([
  'pick',
  'confirm',
  'submit-code',
  'ask-coach',
  'reveal',
  'toggle-fav',
  'next',
  'update:noteOpen',
  'save-note',
  'remove-note',
  'fix-answer',
  'fix-analysis',
  'regen-analysis',
  'reset-override',
])

const q = computed(() => props.question)
const isJudge = computed(() => q.value.type === 'judge')
const isMulti = computed(() => q.value.type === 'multiple')
/**
 * 代码题（core/code.js）：**没有选项**，交互在 CodeRunner 里。
 * 唯一例外是「预测输出」——它仍然是选字母，所以选项照旧由这里渲染，
 * 这样才能复用选项的对错着色；CodeRunner 只补一个「运行」让人自己验。
 */
const isCode = computed(() => q.value.type === 'code')
const isCodePredict = computed(() => isCode.value && q.value.mode === 'predict')
const answerSet = computed(() => new Set(props.answerKeys))

/**
 * 这道题的原文出处（教材/官方文档编译出来的题库才有，见 core/normalize.js）
 */
const source = computed(() => q.value.source || null)

/** 把填空占位渲染成一条下划线（先转义再拼 HTML，题干里的尖括号也安全） */
const stem = computed(() => stemHtml(q.value.stem))

const KEY_TEXT = { T: '正确', F: '错误' }

/* ---------------------- 题库修正（改答案 / 改解析） ---------------------- */
// 题目/解析不准是常态（AI 解析、OCR、人工录入都会错），所以判完就开放修改。
const answerEditing = ref(false)
const analysisEditing = ref(false)
const draftAnswer = ref([])
const draftAnalysis = ref('')

/** 判断题在题库里常常没有 options，这时用「正确/错误」两个键当选项 */
const fixOptions = computed(() =>
  q.value.options?.length ? q.value.options.map((o) => o.key) : isJudge.value ? ['T', 'F'] : [],
)

function openAnswerEdit() {
  draftAnswer.value = [...props.answerKeys]
  answerEditing.value = true
  analysisEditing.value = false
}

function toggleDraft(key) {
  const at = draftAnswer.value.indexOf(key)
  if (at >= 0) draftAnswer.value.splice(at, 1)
  else draftAnswer.value.push(key)
}

function saveAnswer() {
  if (!draftAnswer.value.length) return
  // 排序后再交出去：判断题/多选都按字母顺序存（A、B、C…），判定那边就不用管顺序
  emit('fix-answer', [...draftAnswer.value].sort())
  answerEditing.value = false
}

function openAnalysisEdit() {
  draftAnalysis.value = props.analysis
  analysisEditing.value = true
  answerEditing.value = false
}

function saveAnalysis() {
  emit('fix-analysis', draftAnalysis.value)
  analysisEditing.value = false
}
function keysToText(keys) {
  if (!keys || !keys.length) return '未作答'
  return keys.map((k) => (isJudge.value ? KEY_TEXT[k] || k : k)).join(' ')
}

/** 一串作答值压成一行（代码题的作答可能是一整段输出，判定条里放不下） */
function brief(values, max = 42) {
  const text = (values || []).map((v) => String(v ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ')
  if (!text) return '未作答'
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * 拖拽排序题：把块 key（`s2` 这种）翻回**人看得懂的文本**。
 *
 * 为什么要这一步：判定条上写「正确答案 s2 | s1 | s3」等于什么都没说 ——
 * 学生记不住 key 和代码块的对应关系。这里按 key 找块、取第一行文本，用 `→` 连起来。
 */
function orderText(keys) {
  const blocks = Array.isArray(q.value.blocks) ? q.value.blocks : []
  const byKey = new Map(blocks.map((b) => [b.key, b]))
  const list = Array.isArray(keys) ? keys : []
  const texts = list.map((k) => {
    const t = String(byKey.get(k)?.text ?? k).split('\n')[0].trim()
    return t.length > 24 ? `${t.slice(0, 24)}…` : t
  })
  return texts.length ? texts.join(' → ') : '（没作答）'
}

/** 代码题的判定条文案：找错行说"第 N 行"，填空/修好它给出原文/期望输出 */
const answerText = computed(() => {
  if (isCode.value) {
    if (q.value.mode === 'spot') return `第 ${props.answerKeys[0] || '?'} 行`
    if (q.value.mode === 'order') return orderText(props.answerKeys)
    // 修好它 / 手写：没有文字答案，判据是**运行输出** —— 判定条上直接把期望输出摆出来
    if (q.value.mode === 'fix' || q.value.mode === 'write') {
      const exp = q.value.run?.expect
      const lines = Array.isArray(exp) ? exp : exp?.contains || []
      return lines.length ? brief(lines) : '以「运行」输出为准'
    }
    return brief(props.answerKeys)
  }
  return keysToText(props.answerKeys)
})
/** 判定条上那个标签也要跟着换：写"正确答案 未作答"会让人以为题目坏了 */
const answerLabel = computed(() => {
  if (!isCode.value) return '正确答案'
  if (q.value.mode === 'spot') return '被改动的行'
  if (q.value.mode === 'fix' || q.value.mode === 'write') return '期望输出'
  if (q.value.mode === 'order') return '原文顺序'
  return '正确答案'
})
const pickText = computed(() => {
  if (isCode.value) {
    if (q.value.mode === 'spot') return pickedLineText.value
    if (q.value.mode === 'order') return orderText(props.pick)
    if (q.value.mode === 'fix') return props.pick.length ? `输出：${brief(props.pick)}` : '未跑通'
    return brief(props.pick)
  }
  return keysToText(props.pick)
})
const pickedLineText = computed(() => (props.pick[0] ? `第 ${props.pick[0]} 行` : '未作答'))
const tags = computed(() => (q.value.tags || []).slice(0, 4))

/** 多选题选了但没确认 */
const canConfirm = computed(
  () => !props.examMode && isMulti.value && !props.revealed && props.pick.length > 0,
)
/** 「不会，看答案」：考试模式里绝不能出现，否则等于作弊 */
const showRevealBtn = computed(
  () => !props.examMode && !props.revealed && (!isMulti.value || props.pick.length === 0),
)

/**
 * 笔记默认是收起的：笔记里常写着「答案是 C 因为…」，答题前摊开会直接剧透。
 * 一旦本题判定了结果，就自动展开给你看。
 */
const noteExpanded = ref(false)
watch(
  () => [props.revealed, props.note],
  ([revealed, note]) => {
    if (revealed && note) noteExpanded.value = true
  },
  { immediate: true },
)
</script>

<template>
  <article class="q-qc q-card q-rise" :key="q.id">
    <!-- ─────────── 题头 ─────────── -->
    <header class="q-qc__head">
      <div class="q-qc__meta">
        <span class="q-chip" :class="isMulti ? 'q-chip--warn' : 'q-chip--brand'">
          {{ TYPE_LABEL[q.type] || '题目' }}
        </span>
        <span class="q-qc__no q-num">第 {{ q.no }} 题</span>
        <span v-for="t in tags" :key="t" class="q-chip q-qc__tag">{{ t }}</span>
      </div>

      <div class="q-qc__acts">
        <!-- 问 AI：答题前后都能问（错题时最有价值，所以不藏到判定之后） -->
        <el-tooltip v-if="props.aiEnabled" content="问 AI (Q)" placement="top">
          <button class="q-qc__act" @click="emit('ask-coach')">
            <el-icon :size="16"><Cpu /></el-icon>
          </button>
        </el-tooltip>

        <el-tooltip :content="note ? '编辑笔记 (N)' : '写笔记 (N)'" placement="top">
          <button
            class="q-qc__act"
            :class="{ 'is-note': !!note, 'is-open': noteOpen }"
            @click="emit('update:noteOpen', !noteOpen)"
          >
            <el-icon :size="16"><component :is="note ? 'Memo' : 'EditPen'" /></el-icon>
            <span v-if="note" class="q-qc__act-dot"></span>
          </button>
        </el-tooltip>

        <el-tooltip :content="fav ? '取消收藏 (S)' : '收藏本题 (S)'" placement="top">
          <button class="q-qc__act" :class="{ 'is-fav': fav }" @click="emit('toggle-fav')">
            <el-icon :size="17"><component :is="fav ? 'StarFilled' : 'Star'" /></el-icon>
          </button>
        </el-tooltip>
      </div>
    </header>

    <!-- ─────────── 题干 ─────────── -->
    <h2 class="q-qc__stem" v-html="stem"></h2>

    <p v-if="examMode && !revealed" class="q-qc__tip is-exam">
      <el-icon><Lock /></el-icon>
      考试模式 · 交卷后才显示对错和解析，现在随时可以改答案
    </p>
    <p v-else-if="isMulti && !revealed" class="q-qc__tip">
      <el-icon><InfoFilled /></el-icon>
      多选题 · 选出所有正确项后点「确认答案」
    </p>
    <p v-else-if="isCode && !revealed" class="q-qc__tip">
      <el-icon><Cpu /></el-icon>
      代码题 · {{ isCodePredict ? '先自己判断，再按「运行」让结果说话' : '改完可以先运行看看，再提交判定' }}
    </p>

    <!-- ─────────── 代码区（代码题） ─────────── -->
    <CodeRunner
      v-if="isCode"
      :question="q"
      :pick="pick"
      :revealed="revealed"
      :ok="ok"
      :exam-mode="examMode"
      :answer-keys="answerKeys"
      @submit="(v) => emit('submit-code', v)"
    />

    <!-- ─────────── 选项（判断题 / 选择题 / 代码题的"预测输出"） ─────────── -->
    <div
      v-if="!isCode || isCodePredict"
      class="q-qc__opts"
      :class="{ 'q-qc__opts--judge': isJudge }"
    >
      <OptionItem
        v-for="opt in q.options"
        :key="opt.key"
        :option="opt"
        :judge="isJudge"
        :picked="pick.includes(opt.key)"
        :revealed="revealed"
        :is-answer="answerSet.has(opt.key)"
        :disabled="revealed"
        @pick="(k) => emit('pick', k)"
      />
    </div>

    <!-- ─────────── 操作区 ─────────── -->
    <footer v-if="!revealed" class="q-qc__actions q-no-print">
      <el-button v-if="canConfirm" type="primary" size="large" @click="emit('confirm')">
        <el-icon style="margin-right: 5px"><Select /></el-icon>确认答案
      </el-button>
      <el-button v-if="showRevealBtn" size="large" @click="emit('reveal')">
        不会，看答案
        <span class="q-kbd" style="margin-left: 8px">F</span>
      </el-button>
      <span v-if="canConfirm" class="q-qc__hint">
        <span class="q-kbd">Enter</span> 也能确认
      </span>
    </footer>

    <!-- ─────────── 结果反馈 ─────────── -->
    <transition name="q-fb">
      <section v-if="revealed" class="q-qc__fb q-no-print">
        <!-- 背题模式：只看答案，不判定对错 -->
        <div v-if="peeked" class="q-qc__verdict is-peek">
          <span class="q-qc__verdict-icon">
            <el-icon :size="19"><View /></el-icon>
          </span>
          <div class="q-qc__verdict-main">
            <strong>答案已显示</strong>
            <span class="q-qc__verdict-sub">
              {{ answerLabel }} <b class="q-num">{{ answerText }}</b>
              <i class="q-qc__dot">·</i>
              背题模式不计入错题本
            </span>
          </div>
          <el-button
            v-if="showNext && !examMode"
            type="primary"
            class="q-qc__next"
            @click="emit('next')"
          >
            {{ isLast ? '完成本次练习' : '下一题' }}
            <span class="q-kbd" style="margin-left: 8px">Enter</span>
          </el-button>
        </div>

        <div v-else class="q-qc__verdict" :class="ok ? 'is-ok' : 'is-bad'">
          <span class="q-qc__verdict-icon">
            <el-icon :size="19"><component :is="ok ? 'CircleCheckFilled' : 'CircleCloseFilled'" /></el-icon>
          </span>
          <div class="q-qc__verdict-main">
            <strong>{{ ok ? '回答正确' : '回答错误' }}</strong>
            <span class="q-qc__verdict-sub">
              {{ answerLabel }} <b class="q-num">{{ answerText }}</b>
              <i class="q-qc__dot">·</i>
              你的答案 <b class="q-num" :class="ok ? 'is-ok' : 'is-bad'">{{ pickText }}</b>
              <transition name="q-opt-fade">
                <span v-if="ok && combo >= 2" class="q-combo">
                  <el-icon :size="11"><Trophy /></el-icon>连对 {{ combo }}
                </span>
              </transition>
            </span>
          </div>
          <el-button
            v-if="showNext"
            :type="ok ? 'primary' : 'danger'"
            class="q-qc__next"
            @click="emit('next')"
          >
            {{ isLast ? (examMode ? '查看成绩' : '完成本次练习') : '下一题' }}
            <span class="q-kbd" style="margin-left: 8px">Enter</span>
          </el-button>
        </div>

        <!-- ── 题库修正：题库答案/解析不准时，用户当场就能改 ── -->
        <div class="q-qc__fix q-no-print">
          <!-- 代码题的答案不是字母（是原文/行号/输出），"改答案"那套给不了它 -->
          <button v-if="!isCode" class="q-qc__fixbtn" @click="openAnswerEdit">
            <el-icon :size="12"><EditPen /></el-icon>改答案
          </button>
          <button class="q-qc__fixbtn" @click="openAnalysisEdit">
            <el-icon :size="12"><EditPen /></el-icon>改解析
          </button>
          <button class="q-qc__fixbtn" :disabled="regening" @click="emit('regen-analysis')">
            <el-icon :size="12" :class="{ 'is-spin': regening }"><MagicStick /></el-icon>
            {{ regening ? '生成中…' : '重新生成解析' }}
          </button>
          <button v-if="overridden" class="q-qc__fixbtn is-warn" @click="emit('reset-override')">
            <el-icon :size="12"><RefreshLeft /></el-icon>恢复题库原文
          </button>
          <span v-if="overridden" class="q-qc__fixmark">已修正</span>
        </div>

        <div v-if="answerEditing" class="q-qc__fixbox">
          <p class="q-qc__fixhint q-dim">
            点选正确的选项（可多选）。保存后会<b>立刻按新答案重新判定</b>，错题本也跟着变。
          </p>
          <div class="q-qc__keys">
            <button
              v-for="k in fixOptions"
              :key="k"
              class="q-qc__key"
              :class="{ 'is-on': draftAnswer.includes(k) }"
              @click="toggleDraft(k)"
            >
              {{ k }}<template v-if="isJudge"> · {{ KEY_TEXT[k] }}</template>
            </button>
          </div>
          <div class="q-qc__fixbtns">
            <el-button size="small" type="primary" :disabled="!draftAnswer.length" @click="saveAnswer">
              保存并重判
            </el-button>
            <el-button size="small" @click="answerEditing = false">取消</el-button>
          </div>
        </div>

        <div v-if="analysisEditing" class="q-qc__fixbox">
          <el-input
            v-model="draftAnalysis"
            type="textarea"
            :rows="4"
            placeholder="写你自己的解析…（留空则清除手写解析，回落到题库/AI 版）"
          />
          <div class="q-qc__fixbtns">
            <el-button size="small" type="primary" @click="saveAnalysis">保存</el-button>
            <el-button size="small" @click="analysisEditing = false">取消</el-button>
          </div>
        </div>

        <div v-if="analysis" class="q-qc__analysis">
          <div class="q-qc__analysis-head">
            <el-icon><MagicStick /></el-icon>解析
            <!--
              出处：教材/官方文档编译出来的题库，每道题都能点回原文。
              「AI 出的题可不可信」唯一能给用户的硬保证就是这个链接 ——
              点开就能自己核对，而不是只能信解析里那句话。
            -->
            <a
              v-if="source && source.url"
              class="q-qc__src q-no-print"
              :href="source.url"
              target="_blank"
              rel="noopener noreferrer"
              :title="source.quote ? `原文：${source.quote}` : '去原文看这一段'"
            >
              <el-icon :size="11"><Link /></el-icon>
              <span class="q-qc__src-text">出处{{ source.heading ? `：${source.heading}` : '' }}</span>
            </a>
          </div>
          <!--
            解析正文走 AnalysisBody（core/text.js 的 analysisSegs）：**强调** / `代码` /
            ``` 围栏都会格式化，和题干同一条管线；网址照旧可点。
            以前这里是 raw 文本，学生看到的是星号和反引号本身（UX 审计 2026-10-11 块 3-1）。
          -->
          <AnalysisBody class="q-qc__analysis-body" :text="analysis" />
        </div>
        <p v-else class="q-qc__no-analysis q-dim">
          <el-icon><Document /></el-icon>
          原题库里这道题没有配解析（可以点上面的「重新生成解析」）
        </p>
      </section>
    </transition>

    <!-- ─────────── 我的笔记 ─────────── -->
    <section v-if="noteOpen" class="q-qc__note q-no-print">
      <NoteEditor
        :model-value="note"
        :label="`第 ${q.no} 题 · 我的笔记`"
        @save="(t) => emit('save-note', t)"
        @remove="emit('remove-note')"
        @cancel="emit('update:noteOpen', false)"
      />
    </section>

    <section v-else-if="note" class="q-qc__noteread q-no-print">
      <button class="q-qc__noteread-head" @click="noteExpanded = !noteExpanded">
        <el-icon :size="14"><Memo /></el-icon>
        <b>我的笔记</b>
        <span class="q-dim">{{ noteExpanded ? '收起' : '展开' }}</span>
        <el-icon class="q-qc__noteread-caret" :size="12">
          <component :is="noteExpanded ? 'ArrowUp' : 'ArrowDown'" />
        </el-icon>
      </button>
      <p v-if="noteExpanded" class="q-qc__noteread-body">{{ note }}</p>
    </section>
  </article>
</template>

<style scoped>
.q-qc {
  padding: 24px 26px 22px;
  animation-delay: 0.02s;
}

/* ---------- 题头 ---------- */
.q-qc__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
.q-qc__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.q-qc__no {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--q-text-3);
}
.q-qc__tag {
  font-size: 11.5px;
  height: 23px;
  padding: 0 9px;
}
.q-qc__acts {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.q-qc__act {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  border: 1px solid var(--q-border);
  background: var(--q-surface-2);
  color: var(--q-text-3);
  cursor: pointer;
  transition: all var(--q-dur) var(--q-ease);
}
.q-qc__act:hover {
  color: var(--q-text);
  transform: scale(1.06);
}
/* 收藏态 */
.q-qc__act.is-fav {
  color: var(--q-star);
  background: var(--q-warn-bg);
  border-color: color-mix(in srgb, var(--q-star) 40%, transparent);
}
.q-qc__act.is-fav:hover {
  color: var(--q-star);
  border-color: color-mix(in srgb, var(--q-star) 55%, transparent);
}
/* 有笔记 / 编辑中 */
.q-qc__act.is-note {
  color: var(--q-brand-2);
  background: color-mix(in srgb, var(--q-brand-2) 12%, transparent);
  border-color: color-mix(in srgb, var(--q-brand-2) 40%, transparent);
}
.q-qc__act.is-note:hover {
  color: var(--q-brand-2);
  border-color: color-mix(in srgb, var(--q-brand-2) 55%, transparent);
}
.q-qc__act.is-open {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--q-brand-2) 18%, transparent);
}
/* 右上角小圆点：一眼看出这题有笔记 */
.q-qc__act-dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--q-brand-2);
  box-shadow: 0 0 0 1.5px var(--q-surface-2);
}

/* ---------- 我的笔记（只读展示，可折叠） ---------- */
.q-qc__noteread {
  margin-top: 14px;
  border: 1px solid color-mix(in srgb, var(--q-brand-2) 26%, transparent);
  border-left: 3px solid var(--q-brand-2);
  border-radius: var(--q-r-sm);
  background: color-mix(in srgb, var(--q-brand-2) 6%, transparent);
  overflow: hidden;
}
.q-qc__noteread-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 10px 13px;
  border: 0;
  background: transparent;
  font: inherit;
  color: var(--q-brand-2);
  cursor: pointer;
  text-align: left;
}
.q-qc__noteread-head b {
  font-size: 12.5px;
  font-weight: 700;
}
.q-qc__noteread-head span {
  font-size: 11.5px;
}
.q-qc__noteread-caret {
  margin-left: auto;
  color: var(--q-text-3);
}
.q-qc__noteread-body {
  padding: 0 13px 12px;
  font-size: 14px;
  line-height: 1.75;
  color: var(--q-text-2);
  white-space: pre-wrap;
  word-break: break-word;
}

/* ---------- 我的笔记（编辑中） ---------- */
.q-qc__note {
  margin-top: 14px;
  padding: 14px 15px;
  border: 1px dashed color-mix(in srgb, var(--q-brand-2) 40%, transparent);
  border-radius: var(--q-r-sm);
  background: var(--q-surface-2);
}

/* ---------- 题干 ---------- */
.q-qc__stem {
  font-size: var(--q-stem-size);
  line-height: 1.78;
  font-weight: 600;
  color: var(--q-text);
  letter-spacing: 0.01em;
  word-break: break-word;
}

.q-qc__tip {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  font-size: 12.5px;
  color: var(--q-warn);
}
.q-qc__tip.is-exam {
  color: var(--q-text-3);
}

/* ---------- 选项 ---------- */
.q-qc__opts {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 18px;
}
.q-qc__opts--judge {
  flex-direction: row;
  gap: 12px;
}
@media (max-width: 600px) {
  .q-qc__opts--judge {
    flex-direction: column;
  }
}

/* ---------- 操作区 ---------- */
.q-qc__actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px dashed var(--q-border);
}
.q-qc__hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--q-text-3);
}

/* ---------- 判定 ---------- */
.q-qc__fb {
  margin-top: 18px;
}
.q-qc__verdict {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 14px 16px;
  border-radius: var(--q-r-sm);
  border: 1px solid transparent;
}
.q-qc__verdict.is-ok {
  background: var(--q-ok-bg);
  border-color: color-mix(in srgb, var(--q-ok) 30%, transparent);
}
.q-qc__verdict.is-bad {
  background: var(--q-bad-bg);
  border-color: color-mix(in srgb, var(--q-bad) 30%, transparent);
}
.q-qc__verdict.is-peek {
  background: var(--q-grad-soft);
  border-color: color-mix(in srgb, var(--q-brand-2) 30%, transparent);
}
.q-qc__verdict-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  color: #fff;
  flex: 0 0 auto;
}
.is-ok .q-qc__verdict-icon {
  background: var(--q-ok);
}
.is-bad .q-qc__verdict-icon {
  background: var(--q-bad);
}
.is-peek .q-qc__verdict-icon {
  background: var(--q-brand-2);
}
.q-qc__verdict-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1 1 auto;
  min-width: 0;
}
.q-qc__verdict-main strong {
  font-size: 15px;
  font-weight: 700;
}
.is-ok .q-qc__verdict-main strong {
  color: var(--q-ok);
}
.is-bad .q-qc__verdict-main strong {
  color: var(--q-bad);
}
.q-qc__verdict-sub {
  font-size: 12.5px;
  color: var(--q-text-2);
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}
.q-qc__verdict-sub b {
  color: var(--q-text);
  font-size: 13.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.q-qc__verdict-sub b.is-ok {
  color: var(--q-ok);
}
.q-qc__verdict-sub b.is-bad {
  color: var(--q-bad);
}
.q-qc__dot {
  font-style: normal;
  color: var(--q-text-3);
}

/* 连对徽标：答对且 ≥2 连时出现，配合连对音效一起给正反馈 */
.q-combo {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: 3px;
  padding: 1px 8px;
  border-radius: var(--q-r-full);
  background: var(--q-warn-bg);
  color: var(--q-star);
  font-size: 11.5px;
  font-weight: 700;
}
.q-qc__next {
  flex: 0 0 auto;
}

/* ---------- 解析 ---------- */
/* ---------- 题库修正（改答案 / 改解析） ---------- */
.q-qc__fix {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--q-border);
}
.q-qc__fixbtn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--q-border);
  border-radius: 99px;
  background: var(--q-surface-2);
  color: var(--q-text-2);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.18s var(--q-ease);
}
.q-qc__fixbtn:hover:not(:disabled) {
  border-color: var(--q-brand-1);
  color: var(--q-brand-1);
  background: var(--q-surface-3);
}
.q-qc__fixbtn:disabled {
  opacity: 0.6;
  cursor: default;
}
.q-qc__fixbtn.is-warn {
  border-color: color-mix(in srgb, var(--q-warn) 45%, var(--q-border));
  color: var(--q-warn);
}
/* 重新生成时的转动：给个"在干活"的反馈（本机模型要跑几十秒） */
.q-qc__fixbtn .is-spin {
  animation: q-spin 1.1s linear infinite;
}
@keyframes q-spin {
  to {
    transform: rotate(360deg);
  }
}
.q-qc__fixmark {
  margin-left: 2px;
  padding: 1px 7px;
  border-radius: 99px;
  font-size: 11px;
  font-weight: 700;
  color: var(--q-warn);
  background: color-mix(in srgb, var(--q-warn) 14%, transparent);
}
.q-qc__fixbox {
  margin-top: 10px;
  padding: 12px 14px;
  border-radius: var(--q-r-sm);
  background: var(--q-surface-2);
  border: 1px solid var(--q-border);
}
.q-qc__fixhint {
  font-size: 12px;
  margin-bottom: 9px;
  line-height: 1.6;
}
.q-qc__keys {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  margin-bottom: 11px;
}
.q-qc__key {
  min-width: 38px;
  padding: 5px 11px;
  border: 1.5px solid var(--q-border-strong);
  border-radius: var(--q-r-sm);
  background: var(--q-surface);
  color: var(--q-text);
  font-size: 13px;
  font-weight: 700;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.16s var(--q-ease);
}
.q-qc__key:hover {
  border-color: var(--q-brand-1);
}
.q-qc__key.is-on {
  border-color: var(--q-ok);
  background: color-mix(in srgb, var(--q-ok) 16%, transparent);
  color: var(--q-ok);
}
.q-qc__fixbtns {
  display: flex;
  gap: 8px;
}

.q-qc__analysis {
  margin-top: 12px;
  padding: 14px 16px;
  border-radius: var(--q-r-sm);
  background: var(--q-surface-2);
  border-left: 3px solid var(--q-brand-2);
}
.q-qc__analysis-head {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--q-brand-2);
  margin-bottom: 7px;
}
/* 解析正文的排版（字号/行距/链接/围栏）都在 AnalysisBody 里，这里只留位置 */
.q-qc__analysis-body {
  margin-top: 0;
}
/* 出处按钮：跟着"解析"标题走，一眼能看到、但别抢解析本身的注意力 */
.q-qc__src {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  max-width: 62%;
  padding: 2px 8px;
  border-radius: 99px;
  border: 1px solid color-mix(in srgb, var(--q-brand-1) 30%, transparent);
  color: var(--q-brand-1);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0;
  text-decoration: none;
}
.q-qc__src:hover {
  background: color-mix(in srgb, var(--q-brand-1) 12%, transparent);
}
.q-qc__src-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.q-qc__no-analysis {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 11px;
  font-size: 12.5px;
}

.q-fb-enter-active {
  transition: opacity 0.3s var(--q-ease), transform 0.3s var(--q-ease);
}
.q-fb-enter-from {
  opacity: 0;
  transform: translateY(-6px);
}

@media (max-width: 600px) {
  .q-qc {
    padding: 18px 15px 16px;
  }
  .q-qc__verdict {
    flex-wrap: wrap;
  }
  .q-qc__next {
    width: 100%;
  }
}
</style>
