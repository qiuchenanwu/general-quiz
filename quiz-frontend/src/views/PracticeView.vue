<script setup>
/**
 * PracticeView —— 刷题主战场。
 * 键盘：A-J / 1-9 选选项，Enter 确认或下一题，← → 翻页，S 收藏，F 看答案，Esc 退出。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useBankStore } from '@/stores/bank'
import { useQuizStore } from '@/stores/quiz'
import { playSfx } from '@/core/feedback'
import { addAnalysis, diagnose, ApiError } from '@/core/api'
import { coachDomain, wrongItems } from '@/core/coach'
import QuestionCard from '@/components/QuestionCard.vue'
import AnswerSheet from '@/components/AnswerSheet.vue'
import ResultPanel from '@/components/ResultPanel.vue'
import AiCoach from '@/components/AiCoach.vue'
import AchievementPage from '@/components/AchievementPage.vue'

const bank = useBankStore()
const quiz = useQuizStore()
const router = useRouter()

const sheetOpen = ref(false) // 移动端答题卡抽屉
const dismissedSummary = ref(false) // 「逐题看解析」时先收起成绩单
const noteOpen = ref(false) // 当前题的笔记编辑器是否展开

/* ── 问 AI / 错题诊断（后端 /api/quiz/tutor/ 与 /diagnose/，本来是驾考站在用）── */
const coachOpen = ref(false) // 「问 AI」抽屉
const diagBusy = ref(false)
const diagnosis = ref('') // 错题诊断的自然语言结果
/** 这个题库该走哪个提示词包：教材/文档编译来的走 docs（要求引用原文、不确定就说不确定）*/
const domain = computed(() => coachDomain(bank.meta, quiz.settings.aiMaterialKind))
/**
 * 成就页（刷完一整轮后的全屏页）是否盖着。
 * 它是**叠在成绩单上面**的一层，不是替代成绩单 —— 关掉之后成绩单还在下面，
 * 这样"看情绪"和"看数据"两件事互不打扰。
 */
const showAchievement = ref(false)
const remaining = ref(0)
let tickTimer = null
let autoTimer = null

/* ------------------------------- 派生状态 ------------------------------- */
const session = computed(() => quiz.session)
const queueQuestions = computed(() => quiz.queue.map((id) => bank.byId.get(id)).filter(Boolean))
const q = computed(() => quiz.currentQuestion)
const pick = computed(() => quiz.currentPick)
const revealed = computed(() => quiz.currentRevealed)
const judged = computed(() => quiz.currentJudged)
const ok = computed(() => quiz.currentOk)
const peeked = computed(() => quiz.currentIsPeek)
const isExam = computed(() => quiz.isExam)
const total = computed(() => quiz.queue.length || 0)
const isLast = computed(() => quiz.currentIndex >= total.value - 1)
const fav = computed(() => (q.value ? !!quiz.fav[q.value.id] : false))
const note = computed(() => (q.value ? quiz.noteOf(q.value.id) : ''))

/* ------------------------------- 笔记 ------------------------------- */
function toggleNote() {
  noteOpen.value = !noteOpen.value
}

function saveNote(text) {
  if (!q.value) return
  const saved = quiz.setNote(q.value.id, text)
  noteOpen.value = false
  ElMessage({
    message: saved ? '笔记已保存' : '空笔记已删除',
    duration: 1200,
    grouping: true,
  })
}

function removeNote() {
  if (!q.value) return
  quiz.removeNote(q.value.id)
  noteOpen.value = false
  ElMessage({ message: '笔记已删除', duration: 1200, grouping: true })
}

const showSummary = computed(
  () => !!session.value && (session.value.submitted || session.value.finished) && !dismissedSummary.value,
)

const examUsedSeconds = computed(() => {
  const s = session.value
  if (!s) return 0
  const end = s.finishedAt || Date.now()
  return Math.round((end - s.startedAt) / 1000)
})

/** 成绩单上的错题数：练习模式看会话，考试模式看错题本增量 */
const wrongForReview = computed(() => {
  if (!session.value) return 0
  const { ok: o, bad: b } = quiz.sessionStats || {}
  return b || 0
})

/**
 * 一轮真的做完时，弹一次成就页。
 *
 * 为什么挂在「成绩单出现」这个信号上，而不是在 doSubmit / finishPractice 里各写一行：
 * 结束的入口有三个 —— 手动交卷、考试时间到自动交卷、练习做完整轮。
 * 挂在统一信号上就不会漏掉某一个（漏了会出现"考试有成就页、练习没有"这种怪事）。
 *
 * `immediate: true` + `session.achievementSeen`：做完之后刷新页面，
 * 如果那次还没看过就补上；看过就不再弹（标记存在 session 里）。
 */
watch(
  showSummary,
  (now) => {
    if (!now) return
    if (quiz.session?.achievementSeen) return
    quiz.markAchievementSeen()
    showAchievement.value = true
  },
  { immediate: true },
)

function closeAchievement() {
  showAchievement.value = false
}
function achievementReview() {
  showAchievement.value = false
  reviewWrong()
}
function achievementRestart() {
  showAchievement.value = false
  retry()
}

/* ------------------------------- 计时器（考试） ------------------------------- */
function stopTimer() {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}

/**
 * 把剩余秒数**从考试截止时间当场算出来**。
 *
 * ⚠️ 绝对不要用 store 里的 `examRemaining`：那是个 Pinia getter（本质是 computed），
 * 它依赖 `session.deadline`，但**不依赖 `Date.now()`** —— 而 `Date.now()` 不是
 * 响应式的。所以它算一次就被永久缓存住，倒计时看起来就是"不走"。
 * 这正是「模拟考试时间不会变化」那个 bug 的根因（2026-10-07 实测复现）。
 *
 * 修法：在这里每次用新鲜的 Date.now() 算，再赋给本地 ref —— ref 是响应式的，
 * 视图就会跟着刷新。下面的 setInterval 每 500ms 调一次这个函数。
 */
function syncRemaining() {
  const deadline = quiz.session?.deadline
  remaining.value = deadline ? Math.max(0, Math.round((deadline - Date.now()) / 1000)) : 0
}

let lastTickedSecond = -1
/** 考试最后 5 秒滴答提醒（很轻，且只在开启音效时） */
function maybeTick() {
  if (!isExam.value || remaining.value <= 0 || remaining.value > 5) return
  if (remaining.value === lastTickedSecond) return
  lastTickedSecond = remaining.value
  playSfx('tick')
}

function startTimer() {
  stopTimer()
  if (!isExam.value || !session.value?.deadline) return
  lastTickedSecond = -1
  syncRemaining()
  tickTimer = setInterval(() => {
    syncRemaining()
    maybeTick()
    if (remaining.value <= 0) {
      stopTimer()
      doSubmit(true)
    }
  }, 500)
}

const timerText = computed(() => {
  const s = Math.max(0, remaining.value)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
})

const timerUrgent = computed(() => isExam.value && remaining.value > 0 && remaining.value <= 300)

/* ------------------------- 题库修正（改答案 / 改解析） ------------------------- */
const regening = ref(false)

/**
 * 改答案：交给 store，它会**立刻按新答案重判**（并把错题本一起纠正）。
 * 这里只负责给个反馈 —— 用户改答案的心理就是"我原来被判错了"。
 */
function fixAnswer(keys) {
  const before = quiz.answers[q.value.id]?.ok
  quiz.setAnswerOverride(q.value.id, keys)
  const after = quiz.answers[q.value.id]?.ok
  if (before === false && after === true) {
    ElMessage.success('已改成正确答案，这道题从错题本移除了')
  } else if (before === true && after === false) {
    ElMessage.warning('按新答案，你原来的选择算错了')
  } else {
    ElMessage.success('答案已更新')
  }
}

function fixAnalysis(text) {
  quiz.setAnalysisOverride(q.value.id, text)
  ElMessage.success(text ? '解析已保存（只影响你这台浏览器）' : '已清除手写解析')
}

function resetOverride() {
  quiz.clearOverride(q.value.id)
  ElMessage.success('已恢复题库原文')
}

/* ─────────────────────── 问 AI / 错题诊断 ─────────────────────── */

/**
 * 打开「问 AI」抽屉。
 * 后端 /api/quiz/tutor/ 是驾考站先做出来的（多轮追问 + 限流 + 降级链都在），
 * 刷题站只是把它接上；提示词包按题库来源选（教材题库走 docs，见 core/coach.js）。
 */
function askCoach() {
  if (!q.value) return
  coachOpen.value = true
}

/**
 * 错题诊断：把**最近的**错题（≤40 道，后端上限）交给模型归纳薄弱点。
 * 先把整个错题本发上去是最常见的错法 —— 模型只会给一段泛泛而谈，
 * 所以 core/coach.js 的 wrongItems 按"最近错的优先"截断。
 */
async function runDiagnose() {
  const wrongIds = quiz.wrongIds
  if (!wrongIds.length) {
    ElMessage.info('还没有错题，没什么可诊断的')
    return
  }
  diagBusy.value = true
  diagnosis.value = ''
  try {
    const wrongs = wrongItems({
      byId: bank.byId,
      wrongIds,
      answerOf: (id) => quiz.effectiveAnswer(id),
      pickOf: (id) => quiz.answers[id]?.p || [],
      timeOf: (id) => quiz.answers[id]?.ts || 0,
    })
    const r = await diagnose({
      bankId: bank.meta?.id || '',
      subject: bank.meta?.subject || '',
      wrongs,
      domain: domain.value,
    })
    diagnosis.value = String(r?.answer || '').trim()
    if (!diagnosis.value) ElMessage.warning('这次没生成诊断结果，稍后再试')
    else ElMessage.success(`已诊断 ${r?.count || wrongs.length} 道错题`)
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError(String(e?.message || e))
    ElMessage.error(err.code === 'llm_not_configured' ? '后端没有可用模型。' : err.message)
  } finally {
    diagBusy.value = false
  }
}

/**
 * 重新生成解析：只发这一道题，并且**带上 force** ——
 * 服务端对解析有缓存（同一道题不会重复花钱），但用户点"重新生成"就是嫌旧的不好，
 * 必须绕过缓存拿一份新的。
 */
async function regenAnalysis() {
  if (regening.value) return
  regening.value = true
  try {
    const result = await addAnalysis({
      bankId: bank.meta?.id,
      questions: [
        {
          no: q.value.no,
          type: q.value.type,
          stem: q.value.stem,
          options: q.value.options,
          answer: quiz.effectiveAnswer(q.value.id),
          // 代码题不给代码，模型只能瞎猜（题干里写着"下面这段"）
          code: q.value.code || '',
          mode: q.value.mode || '',
        },
      ],
      force: true,
    })
    const item = (result.items || [])[0]
    const text = (item?.analysis || '').trim()
    if (!text) {
      ElMessage.error('没能生成新解析，稍后再试（本机模型有时会失败）')
      return
    }
    // 存成"手写解析"：用户主动重新生成的那一份，应该压过旧的
    quiz.setAnalysisOverride(q.value.id, text)
    ElMessage.success('新解析已生成')
  } catch (err) {
    ElMessage.error(err?.message || '生成失败')
  } finally {
    regening.value = false
  }
}

/* ------------------------------- 自动下一题 ------------------------------- */
function clearAuto() {
  if (autoTimer) {
    clearTimeout(autoTimer)
    autoTimer = null
  }
}

function scheduleAuto() {
  clearAuto()
  if (isExam.value) return
  if (!quiz.settings.autoNext) return
  if (!quiz.currentOk) return // 答错不自动跳，给时间看解析
  if (isLast.value) return
  autoTimer = setTimeout(() => onNext(), quiz.settings.autoNextDelay)
}

/* ------------------------------- 背题模式 ------------------------------- */
function applyRevealFirst() {
  if (!quiz.settings.revealFirst) return
  if (isExam.value) return
  if (!quiz.currentQid) return
  if (quiz.currentRevealed) return
  quiz.peek()
}

/* ------------------------------- 交互 ------------------------------- */
function onPick(key) {
  clearAuto()
  const r = quiz.toggleOption(key)
  if (r.revealed) scheduleAuto()
}

function onConfirm() {
  clearAuto()
  quiz.reveal()
  scheduleAuto()
}

/**
 * 代码题提交（填空/找错行/修好它）。
 * 判定走 store 的 submitCode —— 和选择题一样，判定完就揭示、进错题本、放音效。
 */
function onSubmitCode(values) {
  clearAuto()
  const r = quiz.submitCode(values)
  if (r.revealed) scheduleAuto()
}

function onReveal() {
  clearAuto()
  // 主动看答案 = 自认不会，记进错题本（背题模式走 peek，不记）
  quiz.reveal({ markWrong: true })
}

function onNext() {
  clearAuto()
  if (quiz.next()) return
  if (isExam.value) {
    doSubmit()
  } else {
    quiz.finishPractice()
  }
}

function onPrev() {
  clearAuto()
  quiz.prev()
}

function goto(i) {
  clearAuto()
  dismissedSummary.value = true
  quiz.goTo(i)
  sheetOpen.value = false
}

function toggleFav() {
  if (!q.value) return
  quiz.toggleFav(q.value.id)
  ElMessage({
    message: quiz.fav[q.value.id] ? '已收藏' : '已取消收藏',
    duration: 1100,
    grouping: true,
  })
}

/* ------------------------------- 交卷 / 结束 ------------------------------- */
async function doSubmit(auto = false) {
  const s = quiz.session
  if (!s || s.submitted) return
  if (!auto) {
    const left = total.value - quiz.sessionProgress.done
    try {
      await ElMessageBox.confirm(
        left ? `还有 ${left} 道题没做完，确定交卷吗？` : '所有题目都做完了，确定交卷吗？',
        '交卷',
        { type: 'warning', confirmButtonText: '交卷', cancelButtonText: '再检查一下' },
      )
    } catch {
      return
    }
  }
  stopTimer()
  clearAuto()
  quiz.submitExam({ auto })
  ElMessage.success(auto ? '时间到，已自动交卷' : '已交卷')
}

async function exit() {
  if (quiz.session && !quiz.session.submitted && !quiz.session.finished) {
    try {
      await ElMessageBox.confirm('退出后本次进度会保留，下次可以继续。', '退出刷题', {
        confirmButtonText: '退出',
        cancelButtonText: '继续刷',
      })
    } catch {
      return
    }
  }
  clearAuto()
  stopTimer()
  router.push('/')
}

function retry() {
  const s = quiz.session
  if (!s) return
  const cfg = {
    mode: s.mode,
    filters: s.filters || {},
    limit: s.queue.length,
    examMinutes: s.examMinutes,
  }
  dismissedSummary.value = false
  quiz.endSession()
  const okStart = quiz.startSession(cfg)
  if (!okStart) {
    ElMessage.warning('没有可用题目了')
    router.push('/')
    return
  }
  startTimer()
  applyRevealFirst()
}

function reviewWrong() {
  dismissedSummary.value = false
  quiz.endSession()
  const okStart = quiz.startSession({ mode: 'wrong' })
  if (!okStart) {
    ElMessage.info('错题本是空的')
    router.push('/')
    return
  }
  ElMessage.success('已开始重做错题')
  startTimer()
}

function reviewAll() {
  dismissedSummary.value = true
  quiz.goTo(0)
}

function goHome() {
  clearAuto()
  stopTimer()
  router.push('/')
}

/* ------------------------------- 键盘 ------------------------------- */
/**
 * 有 Element Plus 弹层（设置抽屉 / 答题卡抽屉 / 确认框）开着时，键盘交给弹层。
 * 不然在设置里按 Esc，会「穿过」抽屉直接把「退出刷题」的确认框弹出来。
 */
function overlayVisible() {
  // v-show 关掉时会写成内联 display:none，用它判断比 querySelector 存在与否靠谱
  return [...document.querySelectorAll('.el-overlay')].some((el) => el.style.display !== 'none')
}

function onKeydown(e) {
  if (e.isComposing || e.repeat) return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (e.target?.closest?.('.el-overlay') || overlayVisible()) return
  const tag = (e.target?.tagName || '').toLowerCase()
  if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return

  if (showSummary.value) {
    if (e.key === 'Escape') goHome()
    return
  }

  const cur = q.value
  if (!cur) return
  // ⚠️ `cur.options` 对**代码题**是 undefined（填空/找错行/修好它根本没有选项）——
  // 这里不加兜底，敲任意一个键都会抛 TypeError，而症状是"按了没反应"，
  // 极难查（真浏览器验收脚本抓到的就是它）。
  const keys = new Set((cur.options || []).map((o) => o.key))
  const upper = e.key.length === 1 ? e.key.toUpperCase() : e.key

  // 1) 选项字母（优先，避免 S/F 与选项 F 冲突）
  if (/^[A-J]$/.test(upper) && keys.has(upper)) {
    e.preventDefault()
    if (!revealed.value) onPick(upper)
    return
  }
  // 2) 数字键 = 选项序号
  if (/^[1-9]$/.test(e.key)) {
    const opt = (cur.options || [])[Number(e.key) - 1]
    if (opt) {
      e.preventDefault()
      if (!revealed.value) onPick(opt.key)
      return
    }
  }
  // 3) 功能键
  if (upper === 'S' && !keys.has('S')) {
    e.preventDefault()
    toggleFav()
    return
  }
  if (upper === 'F' && !keys.has('F')) {
    e.preventDefault()
    if (!revealed.value) onReveal()
    return
  }
  if (upper === 'N' && !keys.has('N')) {
    e.preventDefault()
    toggleNote()
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    if (!revealed.value) {
      if (cur.type === 'multiple' && pick.value.length) onConfirm()
    } else {
      onNext()
    }
    return
  }
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') {
    e.preventDefault()
    onNext()
    return
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
    e.preventDefault()
    onPrev()
    return
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    exit()
  }
}

/* ------------------------------- 生命周期 ------------------------------- */
function onSessionChange() {
  dismissedSummary.value = false
  startTimer()
  applyRevealFirst()
}

// 换题就应用背题模式，并收起上一题还开着的笔记编辑器
watch(
  () => quiz.currentQid,
  () => {
    noteOpen.value = false
    applyRevealFirst()
  },
)
// 新一轮会话（重做/换模式）要重启计时
watch(() => quiz.session?.startedAt, onSessionChange)

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  startTimer()
  applyRevealFirst()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  clearAuto()
  stopTimer()
})
</script>

<template>
  <div class="q-wrap q-pv">
    <!-- ─────────────── 成就页（刷完一整轮盖上来，关掉后成绩单还在下面）─────────────── -->
    <AchievementPage
      v-if="showAchievement"
      :used-seconds="examUsedSeconds"
      @close="closeAchievement"
      @review="achievementReview"
      @restart="achievementRestart"
    />
    <!-- ─────────────── 还没加载好 / 没开始 ─────────────── -->
    <template v-if="!bank.booted">
      <div class="q-card q-pv__loading">
        <el-skeleton :rows="6" animated />
      </div>
    </template>

    <section v-else-if="!session || !q" class="q-card q-pv__empty q-pop">
      <span class="q-pv__empty-icon">
        <el-icon :size="34"><Reading /></el-icon>
      </span>
      <h2>还没有开始练习</h2>
      <p class="q-dim">回首页挑一套题库，选个模式就能开始</p>
      <el-button type="primary" size="large" @click="router.push('/')">
        <el-icon style="margin-right: 5px"><HomeFilled /></el-icon>去选题库
      </el-button>
    </section>

    <!-- ─────────────── 成绩单 ─────────────── -->
    <ResultPanel
      v-else-if="showSummary"
      :stats="quiz.sessionStats"
      :mode="session.mode"
      :exam="isExam"
      :auto-submitted="!!session.examAutoSubmitted"
      :used-seconds="examUsedSeconds"
      :wrong-count="wrongForReview"
      :fav-count="quiz.favCount"
      :ai-busy="diagBusy"
      :ai-enabled="quiz.settings.aiEnabled"
      @retry="retry"
      @review-wrong="reviewWrong"
      @review-all="reviewAll"
      @ai-diagnose="runDiagnose"
      @achievement="showAchievement = true"
      @home="goHome"
    />

    <!-- ─────────────── 错题诊断结果（AI 归纳的薄弱点 + 复习顺序）─────────────── -->
    <section v-if="diagnosis" class="q-card q-pv__diag">
      <header class="q-pv__diaghead">
        <h3><el-icon><MagicStick /></el-icon>错题诊断</h3>
        <span class="q-chip q-chip--brand">{{ domain === 'docs' ? '按文档口径回答' : '通用口径' }}</span>
        <button class="q-pv__diagclose" title="收起" @click="diagnosis = ''">
          <el-icon :size="14"><Close /></el-icon>
        </button>
      </header>
      <p class="q-pv__diagtext">{{ diagnosis }}</p>
      <p class="q-pv__diagnote q-dim">
        诊断由模型生成，可能有误；教材题库的每道错题都带「出处」，以原文为准。
      </p>
    </section>

    <!-- ─────────────── 刷题 ─────────────── -->
    <template v-else>
      <!-- 工具条 -->
      <div class="q-pbar q-card q-no-print">
        <button class="q-pbar__back" title="退出 (Esc)" @click="exit">
          <el-icon :size="16"><Back /></el-icon>
        </button>

        <span class="q-chip q-chip--brand">{{ quiz.modeLabel }}</span>

        <span class="q-pbar__pos q-num">
          <b>{{ quiz.currentIndex + 1 }}</b><em>/{{ total }}</em>
        </span>

        <div class="q-pbar__prog">
          <div class="q-pbar__prog-in" :style="{ width: quiz.sessionProgress.pct + '%' }"></div>
        </div>

        <span v-if="isExam" class="q-pbar__timer q-num" :class="{ 'is-urgent': timerUrgent }">
          <el-icon :size="13"><AlarmClock /></el-icon>{{ timerText }}
        </span>

        <button class="q-pbar__sheet" @click="sheetOpen = true">
          <el-icon :size="15"><Grid /></el-icon>
          <span class="q-pbar__sheet-txt">答题卡</span>
        </button>

        <el-button v-if="isExam" type="danger" size="small" @click="doSubmit(false)">交卷</el-button>
      </div>

      <div class="q-pv__body" :class="{ 'has-side': quiz.settings.showAnswerSheet }">
        <!-- 主区 -->
        <div class="q-pv__main">
          <QuestionCard
            :key="q.id"
            :question="q"
            :pick="pick"
            :revealed="revealed"
            :ok="ok"
            :peeked="peeked"
            :fav="fav"
            :exam-mode="isExam"
            :combo="quiz.streak"
            :note="note"
            :note-open="noteOpen"
            :is-last="isLast"
            :ai-enabled="quiz.settings.aiEnabled"
            :answer-keys="quiz.effectiveAnswer(q.id)"
            :analysis="quiz.effectiveAnalysis(q.id)"
            :overridden="quiz.isOverridden(q.id)"
            :regening="regening"
            @pick="onPick"
            @confirm="onConfirm"
            @submit-code="onSubmitCode"
            @ask-coach="askCoach"
            @reveal="onReveal"
            @toggle-fav="toggleFav"
            @next="onNext"
            @update:note-open="(v) => (noteOpen = v)"
            @save-note="saveNote"
            @remove-note="removeNote"
            @fix-answer="fixAnswer"
            @fix-analysis="fixAnalysis"
            @regen-analysis="regenAnalysis"
            @reset-override="resetOverride"
          />

          <!-- 底部翻页 -->
          <div class="q-pv__nav q-no-print">
            <el-button :disabled="quiz.currentIndex === 0" @click="onPrev">
              <el-icon style="margin-right: 4px"><ArrowLeft /></el-icon>上一题
            </el-button>
            <button class="q-pv__jump q-num" @click="sheetOpen = true">
              {{ quiz.currentIndex + 1 }} / {{ total }}
            </button>
            <el-button :disabled="isLast" @click="onNext">
              下一题<el-icon style="margin-left: 4px"><ArrowRight /></el-icon>
            </el-button>
            <el-button v-if="quiz.settings.revealFirst && !revealed" text @click="quiz.peek()">
              显示答案
            </el-button>
            <el-button v-else-if="!revealed" text @click="quiz.nextUnanswered()">跳到未做</el-button>
          </div>
        </div>

        <!-- 侧栏答题卡 -->
        <div v-if="quiz.settings.showAnswerSheet" class="q-pv__side q-no-print">
          <AnswerSheet
            :questions="queueQuestions"
            :picks="session.picks"
            :results="session.results"
            :peeks="session.peeks"
            :notes="quiz.notes"
            :submitted="session.submitted"
            :index="quiz.currentIndex"
            :title="isExam ? '答题卡（考试）' : '答题卡'"
            @goto="goto"
          />
        </div>
      </div>

      <!-- 移动端答题卡抽屉 -->
      <el-drawer v-model="sheetOpen" title="答题卡" direction="btt" size="72%" class="q-sheet-drawer">
        <AnswerSheet
          :questions="queueQuestions"
          :picks="session.picks"
          :results="session.results"
          :peeks="session.peeks"
          :notes="quiz.notes"
          :submitted="session.submitted"
          :index="quiz.currentIndex"
          @goto="goto"
        />
      </el-drawer>
    </template>

    <!-- ─────────────── 问 AI（就着当前这道题多轮追问，AI 默认关闭）─────────────── -->
    <AiCoach
      v-if="quiz.settings.aiEnabled"
      v-model="coachOpen"
      :question="q"
      :bank-id="bank.meta?.id || ''"
      :subject="bank.meta?.subject || ''"
      :meta="bank.meta"
      :answer-keys="q ? quiz.effectiveAnswer(q.id) : []"
      :analysis="q ? quiz.effectiveAnalysis(q.id) : ''"
      :picked="pick"
    />
  </div>
</template>

<style scoped>
/* ── 错题诊断结果（模型给的自然语言，不是题目）── */
.q-pv__diag {
  padding: 16px 18px;
}
.q-pv__diaghead {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.q-pv__diaghead h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 15px;
}
.q-pv__diagclose {
  margin-left: auto;
  border: 0;
  background: none;
  color: var(--q-text-3);
  cursor: pointer;
}
.q-pv__diagclose:hover {
  color: var(--q-text);
}
.q-pv__diagtext {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.85;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--q-text);
}
.q-pv__diagnote {
  margin: 10px 0 0;
  font-size: 11.5px;
}

.q-pv {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.q-pv__loading {
  padding: 26px;
}
.q-pv__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 56px 24px;
  text-align: center;
}
.q-pv__empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 68px;
  height: 68px;
  border-radius: 20px;
  background: var(--q-surface-3);
  color: var(--q-text-3);
}
.q-pv__empty h2 {
  font-size: 19px;
  font-weight: 800;
}

/* ---------- 工具条 ---------- */
.q-pbar {
  position: sticky;
  top: 74px;
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 9px 13px;
  background: color-mix(in srgb, var(--q-surface) 88%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
.q-pbar__back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  border: 1px solid var(--q-border);
  background: var(--q-surface-2);
  color: var(--q-text-2);
  cursor: pointer;
  transition: all var(--q-dur) var(--q-ease);
}
.q-pbar__back:hover {
  color: var(--q-brand-1);
  border-color: color-mix(in srgb, var(--q-brand-1) 40%, transparent);
}
.q-pbar__pos {
  font-size: 12.5px;
  color: var(--q-text-3);
  white-space: nowrap;
}
.q-pbar__pos b {
  font-size: 15px;
  font-weight: 800;
  color: var(--q-text);
}
.q-pbar__pos em {
  font-style: normal;
}
.q-pbar__prog {
  flex: 1 1 auto;
  min-width: 40px;
  height: 6px;
  border-radius: 99px;
  background: var(--q-surface-3);
  overflow: hidden;
}
.q-pbar__prog-in {
  height: 100%;
  border-radius: 99px;
  background: var(--q-grad);
  transition: width 0.4s var(--q-ease);
}
.q-pbar__timer {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 11px;
  border-radius: var(--q-r-full);
  background: var(--q-surface-3);
  font-size: 13px;
  font-weight: 700;
  color: var(--q-text-2);
}
.q-pbar__timer.is-urgent {
  background: var(--q-bad-bg);
  color: var(--q-bad);
  animation: q-pulse-ring 1.6s var(--q-ease) infinite;
}
.q-pbar__sheet {
  display: none;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 11px;
  border-radius: 9px;
  border: 1px solid var(--q-border);
  background: var(--q-surface-2);
  font: 650 12.5px var(--q-font);
  color: var(--q-text-2);
  cursor: pointer;
}

/* ---------- 布局 ---------- */
.q-pv__body {
  display: block;
}
.q-pv__body.has-side {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 292px;
  gap: 16px;
  align-items: start;
}
.q-pv__main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.q-pv__side {
  position: sticky;
  top: 138px;
}

/* ---------- 底部翻页 ---------- */
.q-pv__nav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
}
.q-pv__jump {
  padding: 5px 12px;
  border-radius: 99px;
  border: 1px dashed var(--q-border-strong);
  background: transparent;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--q-text-3);
  cursor: pointer;
}

@media (max-width: 1080px) {
  .q-pv__body.has-side {
    grid-template-columns: minmax(0, 1fr);
  }
  .q-pv__side {
    display: none;
  }
  .q-pbar__sheet {
    display: inline-flex;
  }
}
@media (max-width: 620px) {
  .q-pbar {
    top: 66px;
    gap: 8px;
    padding: 8px 10px;
  }
  .q-pbar__sheet-txt {
    display: none;
  }
  .q-pv__nav :deep(.el-button) {
    flex: 1;
  }
}
</style>

<style>
/* 抽屉里的答题卡去掉卡片的阴影和边框，避免和外层叠两层 */
.q-sheet-drawer .q-sheet {
  border: 0;
  box-shadow: none;
  padding: 0;
  background: transparent;
}
.q-sheet-drawer .q-sheet__grid {
  max-height: none;
}
</style>
