<script setup>
/**
 * CodeRunner.vue —— **代码题**的交互区：真代码 + 真运行 + 确定性判定。
 *
 * 四种模式：
 *   fill     填空：代码里的 ___ 变成输入框，逐空填回原文（可运行验证）
 *   spot     找错行：点出被改动过的那一行（可运行看报错）
 *   fix      修好它：直接改代码，跑通且输出对上才算过
 *   write    手写：给你要求和期望输出，代码从零写（和 fix 同一套判据）
 *   predict  预测输出：选项仍由 QuestionCard 渲染（那样才能复用对错着色），
 *            这里只负责把代码摆出来 + 给一个「运行」让结果自己说话
 *
 * 判定用的是 core/code.js 的纯函数（离线可断言），运行用的是
 * <iframe sandbox="allow-scripts"> + postMessage —— 两份逻辑都不碰网络、不花钱。
 *
 * 沙箱的三条底线（别改）：
 *   1. 不给 allow-same-origin：那段代码碰不到本站的 localStorage / cookie / DOM
 *   2. 只跑纯 JS：SFC / import / require / DOM 的代码**明确说跑不了**（core/code.js
 *      的 runBlockReason 给理由），而不是让人看到一个莫名其妙的报错
 *   3. 死循环由父窗口超时后把 iframe 摘掉兜底（在页面里 while(true) 会把标签页冻住）
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  CODE_MODE_LABEL,
  buildSandboxDoc,
  collectRun,
  judgeCode,
  readSandboxMessage,
  runBlockReason,
  splitCode,
} from '@/core/code'
import { runJava as apiRunJava } from '@/core/api'
import { clearToken, loadToken, wasElevatedBefore } from '@/core/elevate'
import { javaResultToRun, javaSources } from '@/core/java'
import { completionWords } from '@/core/editor'
import { judgeParsons } from '@/core/parsons'
import { useQuizStore } from '@/stores/quiz'
import CodeEditor from '@/components/CodeEditor.vue'

// 代码块配色（设置页可选；见 core/code-theme.js）
const quiz = useQuizStore()

const props = defineProps({
  question: { type: Object, required: true },
  /** 已提交的作答值（填空=每个空的文本 / 找错=行号 / 修好它=运行输出） */
  pick: { type: Array, default: () => [] },
  revealed: { type: Boolean, default: false },
  ok: { type: Boolean, default: false },
  /** 考试模式：不给「运行」以外的反馈，判定也要等交卷 */
  examMode: { type: Boolean, default: false },
  /** 有效答案（用户修正过就用修正的）—— 判定后要亮出来 */
  answerKeys: { type: Array, default: () => [] },
})

const emit = defineEmits(['submit'])

const q = computed(() => props.question)
const mode = computed(() => q.value.mode || 'fill')
const modeLabel = computed(() => CODE_MODE_LABEL[mode.value] || '代码')
const isPredict = computed(() => mode.value === 'predict')
/** 拖拽排序（Parsons）—— 声明放在 canRun 之前，免得读的人以为踩了 TDZ */
const isOrder = computed(() => mode.value === 'order')
/** 「修好它」和「手写」都是直接编辑代码框（差别只在起始代码和题面） */
const isEditable = computed(() => mode.value === 'fix' || mode.value === 'write')

/* --------------------------- 拖拽排序（Parsons） --------------------------- */
/**
 * 站主 2026-10-11：「下一步拖拽排序你也开始做」。
 * 判据在 core/parsons.js（教材原文的顺序 + LCS 部分分），这里只管交互：
 *   · 拖（HTML5 drag & drop，桌面顺手）
 *   · 点 ↑/↓（键盘/触屏也能用，而且**验收脚本可以确定性地驱动它** ——
 *     真拖拽在 Playwright 里容易假红，别让断言依赖拖的手势）
 */
const orderPick = ref([])
const dragFrom = ref(-1)
const dragOver = ref(-1)

const orderBlocks = computed(() => (Array.isArray(q.value?.blocks) ? q.value.blocks : []))
const orderMap = computed(() => new Map(orderBlocks.value.map((b) => [b.key, b])))
/** 当前排列（每块一个 key），初始 = 题库给的那个打乱顺序 */
function resetOrder() {
  orderPick.value = orderBlocks.value.map((b) => b.key)
}
watch(
  () => [q.value?.id, mode.value],
  () => {
    if (isOrder.value) resetOrder()
  },
  { immediate: true },
)

function moveBlock(from, to) {
  const arr = [...orderPick.value]
  if (to < 0 || to >= arr.length || from < 0 || from >= arr.length) return
  const [item] = arr.splice(from, 1)
  arr.splice(to, 0, item)
  orderPick.value = arr
}
function onDrop(to) {
  if (dragFrom.value >= 0) moveBlock(dragFrom.value, to)
  dragFrom.value = -1
  dragOver.value = -1
}
/** 提交后每块的对错（没提交就全是 null） */
const orderState = computed(() => {
  // ⚠️ 脚本里必须写 `props.revealed`：`revealed` 只在**模板**里能直接写。
  //    第一版在这里写了裸 `revealed` → 渲染时抛 ReferenceError，
  //    整个 CodeRunner 挂不上（`.q-cr` 一个都不出现），而这种错**静态检查抓不到**，
  //    只有真浏览器跑一遍才看得见。
  if (!props.revealed) return orderPick.value.map(() => null)
  const want = Array.isArray(q.value?.answer) ? q.value.answer : []
  return orderPick.value.map((k, i) => want[i] === k)
})
const orderScore = computed(() => {
  if (!props.revealed) return null
  return judgeParsons(orderPick.value, q.value?.answer)
})


/**
 * 补全词表：从**题目原始代码**收词（+ 这一题的标签，比如"这一节在讲的 API"）。
 * ⚠️ 用原始代码而不是 draft：补全列表要是跟着输入实时变，
 *    学生自己刚打错的词会变成"建议"，越打越歪。
 */
const editorWords = computed(() =>
  completionWords(String(q.value.code ?? ''), q.value.lang || '', q.value.tags || []),
)

/** 这道题能不能跑；不能跑的理由（'' = 能跑） */
const blockReason = computed(() => runBlockReason(q.value))
/** 排序题不显示「运行」（判据是教材原文的顺序，跑一遍也证明不了顺序对） */
const canRun = computed(() => !blockReason.value && !isOrder.value)

/** 这道题是不是走**后端真 JVM**（Java）那条路 */
const isJava = computed(() => String(q.value?.lang ?? '').toLowerCase() === 'java')

/**
 * Java 那条路的请求参数：从题面里抠 `k=v` 形式的提示（Servlet 的请求参数）。
 * 题库里目前没有这个字段，先留空；以后出 Java 题时在 `q.javaParams` 里给。
 */
const javaParams = computed(() => (Array.isArray(q.value?.javaParams) ? q.value.javaParams.map(String) : []))

/** Java 特有的提示（没提权 / 提权失效 / 服务器没开）—— 和"代码跑不了"是两回事 */
const javaHint = ref('')

/* ------------------------------ 本地作答状态 ------------------------------ */
/** 填空：每个空一个字符串；找错行：选中的行号；修好它：用户改过的代码 */
const blanks = ref([])
const pickedLine = ref(0)
const draft = ref('')

/**
 * 运行状态。
 * ⚠️ 这两个必须在下面的 watch **之前**声明：那个 watch 是 `immediate: true`，
 * 回调在 setup 里**当场**就跑一次（会写 output.value）——
 * 声明在后面就是 TDZ，浏览器里会抛
 * 「Cannot access 'output' before initialization」，而这个错误只在真浏览器里看得见。
 */
const output = ref(null) // collectRun() 的结果
const running = ref(false)
const host = ref(null)

/* ------------------------------ 代码渲染 ------------------------------ */
const rawParts = computed(() => splitCode(String(q.value.code ?? '')).parts)
const blankTotal = computed(() => splitCode(String(q.value.code ?? '')).total)

watch(
  () => q.value.id,
  () => {
    blanks.value = Array.from({ length: blankTotal.value }, () => '')
    pickedLine.value = 0
    draft.value = String(q.value.code ?? '')
    output.value = null
    javaHint.value = ''
  },
  { immediate: true },
)

/** 判定之后：把用户填的/选的换成提交值，避免显示和判定不一致 */
watch(
  () => props.revealed,
  (v) => {
    if (!v) return
    if (mode.value === 'fill' && props.pick.length) blanks.value = props.pick.map(String)
    if (mode.value === 'spot' && props.pick.length) pickedLine.value = Number(props.pick[0]) || 0
  },
)

/**
 * 按行拆开，好让每个空落在它自己那一行里（也为了行号）。
 * 空可能落在任意位置，所以先按 \n 切文本段、再把空插进去。
 */
const lines = computed(() => {
  const out = [[]]
  for (const part of rawParts.value) {
    if (part.type === 'blank') {
      out[out.length - 1].push(part)
      continue
    }
    const chunks = String(part.text).split('\n')
    chunks.forEach((text, i) => {
      if (i > 0) out.push([])
      if (text) out[out.length - 1].push({ type: 'text', text })
    })
  }
  return out
})

/** 找错行：可点的行（空行不给点，避免"点了个空"也算答题） */
function lineClickable(no) {
  if (props.revealed || mode.value !== 'spot') return false
  return lines.value[no - 1]?.some((s) => s.type === 'text' && s.text.trim()) || false
}

function selectLine(no) {
  if (!lineClickable(no)) return
  pickedLine.value = no
}

/**
 * 填空框的宽度：**跟着内容走**（用户原话：有多长就多长，而不是固定的）。
 *
 * 用 `ch`（等宽字体的字符宽）算，所以宽度正好是"能装下 n 个字符"。
 * 判定之后还要按**正确答案**的长度再放一次 —— 否则用户填短了、
 * 答案更长时会被输入框裁掉（那就等于把人误导了）。
 */
function blankWidth(i) {
  const typed = String(blanks.value[i] ?? '')
  let len = Math.max(4, typed.length + 2)
  const right = q.value.blanks?.[i]?.answer?.[0]
  if (props.revealed && right) len = Math.max(len, String(right).length + 2)
  return `${len}ch`
}

/** 要交给沙箱跑的代码：填空=把用户填的填回去；修好它=用户改的；其余=原样 */
const runnableCode = computed(() => {
  if (isEditable.value) return draft.value
  const code = String(q.value.code ?? '')
  if (mode.value !== 'fill') return code
  let i = 0
  return code.replace(/_{3,}/g, () => String(blanks.value[i++] ?? ''))
})

/* ------------------------------ 运行（沙箱） ------------------------------ */
let frame = null
let timer = 0
let messages = []
let settle = null

const RUN_TIMEOUT = 5000

function onMessage(event) {
  if (!frame || event.source !== frame.contentWindow) return
  const msg = readSandboxMessage(event.data)
  if (!msg) return
  if (msg.kind === 'done') return finish(false)
  messages.push(msg)
}

/** 收尾：把 iframe 摘掉（这也是掐死死循环的唯一手段），再归集结果 */
function finish(timedOut) {
  if (timer) clearTimeout(timer)
  timer = 0
  if (frame) {
    try {
      frame.remove()
    } catch {
      /* 已经不在了 */
    }
    frame = null
  }
  output.value = collectRun(messages, { timedOut })
  running.value = false
  if (settle) {
    const done = settle
    settle = null
    done()
  }
}

/**
 * 跑一次。
 *
 * **两条路**：
 *   - 默认：浏览器里的 iframe 沙箱（手写迷你 Vue，纯 JS）
 *   - `lang === 'java'`：**后端真 JVM**（板子上真 javac + java，bwrap 隔离）。
 *     Java 不能在浏览器里跑，所以这条路必须联网、而且后端必须提过权。
 *
 * 两条路最后都收敛成 `collectRun()` 那一种形状，所以判定和渲染都不用分叉。
 *
 * @returns {Promise<object|null>}
 */
async function run() {
  if (!canRun.value || running.value) return output.value
  if (isJava.value) return runJavaOnce()

  if (frame) finish(false) // 上一次没跑完（连点）先掐掉
  messages = []
  output.value = null
  running.value = true

  frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  // 0×0 摆在屏幕外：不能用 display:none —— 有些浏览器会连脚本一起不跑
  frame.setAttribute(
    'style',
    'position:absolute;left:-9999px;top:0;width:0;height:0;border:0;visibility:hidden',
  )
  frame.srcdoc = buildSandboxDoc({ code: runnableCode.value })
  host.value?.appendChild(frame)

  return new Promise((resolve) => {
    settle = resolve
    timer = setTimeout(() => finish(true), RUN_TIMEOUT)
  })
}

/**
 * Java：打后端真跑。
 *
 * 没提权时不发请求 —— 后端一定是 403，先让用户去解锁，省一次往返也少一句看不懂的报错。
 * （真正的门在服务端，这里只是别让人白按。）
 *
 * ⚠️ **对外只说"当前不可用"，不许提"提权"这件事、更不许写敲键序列**（站主要求：
 *    别对外显示可以提权）。怎么开只有站主自己知道。
 *    注意：序列本身仍写在公开 bundle 里（core/elevate.js），所以做到的是"不广告"，
 *    不是安全边界 —— 别把它当门锁（见 HANDOVER 坑里那条）。
 */
async function runJavaOnce() {
  output.value = null
  const record = loadToken()
  if (!record) {
    javaHint.value = wasElevatedBefore()
      ? 'Java 真跑当前不可用：按 x s 9 9 9 解锁。'
      : 'Java 真跑要在这台服务器上真编译真运行，当前不可用。'
    return null
  }
  running.value = true
  javaHint.value = ''
  try {
    const payload = await apiRunJava({
      sources: javaSources(runnableCode.value),
      params: javaParams.value,
      token: record.token,
    })
    output.value = javaResultToRun(payload?.result)
    return output.value
  } catch (error) {
    // 提权过期（后端比本地时钟更权威）→ 清掉本地票。
    // ⚠️ 文案同样**不提"提权"、不给敲键序列**（见 runJavaOnce 的注释）：对访客只说不可用。
    if (error?.code === 'elevate_required') {
      clearToken()
      javaHint.value = wasElevatedBefore()
        ? 'Java 真跑当前不可用（授权已过期）：按 x s 9 9 9 重新解锁。'
        : 'Java 真跑当前不可用（授权已失效）。'
    } else if (error?.code === 'java_disabled') {
      javaHint.value = '服务器没打开 Java 真跑（要设 QUIZ_JAVA_ENABLED=1）。这道题暂时只能看代码。'
    } else {
      javaHint.value = error?.message || 'Java 没跑起来。'
    }
    return null
  } finally {
    running.value = false
  }
}

/* ------------------------------ 提交判定 ------------------------------ */
const filled = computed(() => blanks.value.filter((b) => String(b).trim()).length)
/** 还差几个空（0 就是填满了）—— 提示条要一直看得见，不能等填满了才说 */
const blanksLeft = computed(() => Math.max(0, blankTotal.value - filled.value))

/**
 * 能交了吗。
 * ⚠️ 填空**必须全填满**才算能交：判定是逐空对错的，"填一半就交"只会白白记一道错题
 * （审计块 3-4：以前 filled>0 就能交，学生填一个空随手一点就判错）。
 */
const canSubmit = computed(() => {
  if (props.revealed || isPredict.value) return false
  if (mode.value === 'fill') return blankTotal.value > 0 && filled.value >= blankTotal.value
  if (mode.value === 'spot') return pickedLine.value > 0
  if (isOrder.value) return orderPick.value.length === orderBlocks.value.length && orderBlocks.value.length >= 2
  // fix / write：交上去就按最后一次运行结果判 —— 但代码框空着就别交了
  return String(draft.value).trim().length > 0
})

/**
 * 提交条**常显**（审计块 3-4）：以前整条 footer 挂在 `v-if="canSubmit"` 上，
 * 填空题没填满时全页唯一能点的就只剩「不会，看答案」——
 * 学生找不到提交入口，只好点看答案，题被剧透还记一道错题。
 * 只有"判过了"和"预测输出"（它本来就没有提交这回事）才收起。
 */
const showFoot = computed(() => !props.revealed && !isPredict.value)

/**
 * 填空框里按 Enter = 提交（填满了才算）。
 * ⚠️ 中文输入法组字中的 Enter 是"确认候选词"，绝不能当成提交
 *    （isComposing / keyCode 229 时直接放行，连 preventDefault 都不做）。
 */
function onBlankEnter(e) {
  if (e.isComposing || e.keyCode === 229) return
  if (!canSubmit.value) return
  e.preventDefault()
  submit()
}

/** 交出去的值：各模式各自的"作答"形态（判定由 core/code.js 负责）
 *  ⚠️ 排序题交的是**平铺的 key 数组**，不是 `[keys]`：
 *     store 的 `submitCode` 会对传进来的数组做 `.map(String)`（"每个空一个字符串"的契约），
 *     嵌一层数组会被 stringify 成 `"s2,s1,s3"` 一整条 —— 判定就永远不过。 */
const submitValues = computed(() => {
  if (mode.value === 'fill') return blanks.value.map((b) => String(b))
  if (mode.value === 'spot') return [String(pickedLine.value)]
  if (isOrder.value) return orderPick.value.map(String)
  return [output.value?.output ?? '']
})

async function submit() {
  if (!canSubmit.value) return
  if (isOrder.value) {
    // 排序题不需要运行：判据就是"教材原文的顺序"
    emit('submit', submitValues.value)
    return
  }
  if (isEditable.value) {
    // 判据是"跑出来对不对"，所以先跑；跑不通就别急着判错，
    // 让人看着报错继续改（这才是这道题的意义）。
    await run()
    if (!output.value || output.value.error) return
  }
  emit('submit', submitValues.value)
}

/* ------------------------------ 判定后的呈现 ------------------------------ */
/** 提交之后逐空对错（判定只在 core/code.js 里实现一次） */
const verdict = computed(() => (props.revealed ? judgeCode(q.value, props.pick) : null))
const blankOk = (i) => (verdict.value?.blanks ? !!verdict.value.blanks[i] : null)

/** 找错行：答案行 / 我选的行 */
const answerLine = computed(() => {
  const raw = String(props.answerKeys?.[0] ?? '')
  return /^\d+$/.test(raw) ? Number(raw) : 0
})
function lineState(no) {
  if (!props.revealed) return pickedLine.value === no ? 'is-picked' : ''
  if (no === answerLine.value) return 'is-answer'
  if (no === pickedLine.value) return 'is-mine-bad'
  return ''
}

/** 判定后要告诉用户"正确写法是什么" */
const answerLines = computed(() => (props.answerKeys || []).map((x) => String(x)))

onMounted(() => window.addEventListener('message', onMessage))

onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
  if (frame) finish(false)
})
</script>

<template>
  <section class="q-cr" :class="`is-${mode}`">
    <div class="q-cr__bar q-no-print">
      <span class="q-chip q-chip--brand">{{ modeLabel }}</span>
      <span v-if="q.lang" class="q-cr__lang q-num">{{ q.lang }}</span>
      <span class="q-cr__spacer"></span>

      <!-- 跑不了的代码：不再挂一条常驻横幅（挡视野），只在按钮上给个灰态 + 悬停看原因 -->
      <el-tooltip v-if="blockReason && !isOrder" :content="blockReason" placement="top">
        <span class="q-cr__norun"><el-icon><WarningFilled /></el-icon>这段跑不了</span>
      </el-tooltip>
      <!-- 排序题：给「打乱」而不是「运行」（判据是教材原文的顺序，跑一遍证明不了顺序对） -->
      <button v-else-if="isOrder" class="q-cr__run q-cr__shuffle" :disabled="revealed" @click="resetOrder">
        <el-icon><Refresh /></el-icon>重新打乱
      </button>
      <button v-else class="q-cr__run" :disabled="running" @click="run">
        <el-icon><VideoPlay /></el-icon>{{ running ? '运行中…' : '运行' }}
        <span class="q-kbd">Ctrl ↵</span>
      </button>
      <!-- Java 走**服务器真跑**：标一下，别让人以为和上面那些一样是本机沙箱 -->
      <span v-if="isJava && canRun" class="q-cr__remote">服务器真跑</span>
    </div>

    <!-- Java 特有的提示：没提权 / 提权失效 / 服务器没开。和"代码跑不了"是两回事。
         ⚠️ 这些文案对外**故意含糊**（不提"提权"、不给敲键序列）—— 站主要求别对外显示可以提权，
            所以别"顺手写清楚点"，那是往回退。 -->
    <p v-if="javaHint" class="q-cr__javahint">{{ javaHint }}</p>

    <!-- ── 拖拽排序（Parsons）：把打乱的块拖回原来的顺序 ──
         判据是**教材原文的顺序**（core/parsons.js），所以没有「运行」。
         拖 + ↑/↓ 两种操作都支持（后者键盘/触屏能用，验收脚本也靠它做确定性断言）。 -->
    <div v-if="isOrder" class="q-cr__parsons">
      <p class="q-cr__phint q-dim">
        <!-- ⚠️ 这里**不能写 markdown 星号**（模板不是 markdown，星号会原样显示）—— 坑 76，check_sfc 会拦 -->
        把下面 {{ orderBlocks.length }} 块拖回原来的顺序（也可以点 ↑ ↓ 挪）。排对了才算过。
      </p>
      <ol class="q-cr__plist">
        <li
          v-for="(key, i) in orderPick"
          :key="key"
          class="q-cr__pblock"
          :class="[
            `slot-${i}`,
            orderState[i] === true ? 'is-ok' : orderState[i] === false ? 'is-bad' : '',
            { 'is-drag': dragFrom === i, 'is-over': dragOver === i && dragFrom !== i },
          ]"
          :draggable="!revealed"
          @dragstart="dragFrom = i"
          @dragover.prevent="dragOver = i"
          @dragleave="dragOver === i && (dragOver = -1)"
          @drop.prevent="onDrop(i)"
          @dragend="dragFrom = -1; dragOver = -1"
        >
          <span class="q-cr__pgrip" aria-hidden="true">⠿</span>
          <span class="q-cr__pno q-num">{{ i + 1 }}</span>
          <pre class="q-cr__ptext">{{ orderMap.get(key)?.text }}</pre>
          <span class="q-cr__pbtn">
            <button type="button" :disabled="revealed || i === 0" title="上移" @click="moveBlock(i, i - 1)">↑</button>
            <button
              type="button"
              :disabled="revealed || i === orderPick.length - 1"
              title="下移"
              @click="moveBlock(i, i + 1)"
            >↓</button>
          </span>
        </li>
      </ol>
      <p v-if="orderScore" class="q-cr__pscore" :class="orderScore.ok ? 'is-ok' : 'is-bad'">
        <template v-if="orderScore.ok">顺序完全正确（{{ orderScore.total }} / {{ orderScore.total }}）</template>
        <template v-else>
          还差一点：{{ orderScore.correct }} / {{ orderScore.total }} 块的位置是对的（错的那几块已标红）
        </template>
      </p>
    </div>

    <!-- ── 填空 / 找错行 / 预测：按行渲染，空和可点行都在行内 ── -->
    <pre v-if="!isEditable && !isOrder" class="q-cr__code"><code><span
      v-for="(line, i) in lines"
      :key="i"
      class="q-cr__line"
      :class="[mode === 'spot' ? lineState(i + 1) : '', { 'is-clickable': lineClickable(i + 1) }]"
      @click="mode === 'spot' && selectLine(i + 1)"
    ><span class="q-cr__ln q-num">{{ i + 1 }}</span><span class="q-cr__txt"><template
      v-for="(seg, j) in line"
      :key="j"
    ><input
      v-if="seg.type === 'blank'"
      v-model="blanks[seg.index]"
      class="q-cr__blank"
      :class="[blankOk(seg.index) === true ? 'is-ok' : blankOk(seg.index) === false ? 'is-bad' : '']"
      :style="{ width: blankWidth(seg.index) }"
      :disabled="revealed"
      :placeholder="q.blanks?.[seg.index]?.hint || '…'"
      spellcheck="false"
      autocomplete="off"
      @keydown.enter="onBlankEnter"
      @keydown.ctrl.enter.prevent="submit"
      @keydown.meta.enter.prevent="submit"
    /><span v-else>{{ seg.text }}</span></template></span></span></code></pre>

    <!-- ── 修好它 / 手写：直接写代码（手写给的是空骨架） ──
         ★ 站主反馈：「用户修改代码你要加上自动补全和颜色区分，让他们在校验的时候就提前熟悉代码」。
         词表取自**题目原始代码**（不是学生正在打的这份），这样建议列表是稳的。 -->
    <CodeEditor
      v-else
      v-model="draft"
      class="q-cr__edit q-num"
      :lang="q.lang || ''"
      :words="editorWords"
      :read-only="revealed"
      :theme="quiz.settings.codeTheme"
      @keydown.ctrl.enter.prevent="run"
      @keydown.meta.enter.prevent="run"
    />

    <!-- ── 运行结果（沙箱里真跑出来的） ── -->
    <div v-if="output" class="q-cr__out">
      <div class="q-cr__outhead">
        <span>运行结果</span>
        <span v-if="output.timedOut" class="q-chip q-chip--bad">超时</span>
        <span v-else-if="output.error" class="q-chip q-chip--bad">报错</span>
        <span v-else class="q-chip q-chip--ok">跑完了</span>
      </div>
      <pre v-if="output.lines.length" class="q-cr__outbody"><span
        v-for="(l, i) in output.lines"
        :key="i"
        class="q-cr__outline"
        :class="`is-${l.kind}`"
      >{{ l.text }}</span></pre>
      <p v-else class="q-cr__outempty q-dim">（没有输出 —— 这段代码什么都没打印）</p>
      <p v-if="output.error" class="q-cr__err">{{ output.error }}</p>
    </div>

    <!-- ── 判定后的正确答案 ── -->
    <div v-if="revealed" class="q-cr__ans q-no-print">
      <template v-if="mode === 'fill'">
        <span class="q-cr__anslabel">正确答案</span>
        <code v-for="(a, i) in answerLines" :key="i" class="q-cr__ansitem">{{ i + 1 }}. {{ a }}</code>
      </template>
      <template v-else-if="mode === 'spot'">
        <span class="q-cr__anslabel">被改动的是第 {{ answerLine }} 行</span>
      </template>
      <template v-else-if="isEditable">
        <span class="q-cr__anslabel">{{ mode === 'write' ? '期望输出（参考实现见解析）' : '期望输出' }}</span>
        <code v-for="(a, i) in answerLines" :key="i" class="q-cr__ansitem">{{ a }}</code>
      </template>
      <template v-else-if="mode === 'predict'">
        <span class="q-cr__anslabel">自己按一下「运行」对照 —— 跑出来的就是答案</span>
      </template>
      <template v-else-if="isOrder">
        <span class="q-cr__anslabel">正确顺序</span>
        <code v-for="(k, i) in q.answer || []" :key="k" class="q-cr__ansitem">
          {{ i + 1 }}. {{ (orderMap.get(k)?.text || '').split('\n')[0].slice(0, 40) }}
        </code>
      </template>
    </div>

    <!-- ── 提交 ──
         常显（见 showFoot 的注释）：没填满时按钮 disabled + 下面那行提示说清还差几个空。
         ⚠️ 「不会，看答案」不在这里（在题目卡片上）—— 它是退路，不该是唯一能点的东西。 -->
    <footer v-if="showFoot" class="q-cr__foot q-no-print">
      <el-button type="primary" :disabled="!canSubmit || running" @click="submit">
        <el-icon style="margin-right: 5px"><Select /></el-icon>提交判定
      </el-button>
      <span v-if="mode === 'fill'" class="q-cr__hint q-dim" :class="{ 'is-todo': blanksLeft > 0 }">
        <template v-if="blanksLeft > 0">还差 {{ blanksLeft }} 个空（已填 {{ filled }} / {{ blankTotal }}）</template>
        <template v-else>已填 {{ filled }} / {{ blankTotal }} 个空 · 也可以直接按 <span class="q-kbd">Enter</span></template>
      </span>
      <span v-else-if="isOrder" class="q-cr__hint q-dim">
        拖不动就点 ↑ ↓；排好顺序再提交
      </span>
      <span v-else-if="isEditable" class="q-cr__hint q-dim">
        {{ mode === 'write' ? '写出来 → 按「运行」→ 输出对上了再提交' : '改完先点「运行」，跑通了再提交' }}
      </span>
      <span v-else class="q-cr__hint q-dim" :class="{ 'is-todo': !canSubmit }">点一下左边那一行</span>
    </footer>

    <!-- 沙箱挂载点：用户看不见（0×0 摆在屏幕外） -->
    <div ref="host" class="q-cr__host" aria-hidden="true"></div>
  </section>
</template>

<style scoped>
.q-cr {
  margin: 14px 0 4px;
  border: 1px solid var(--q-border);
  border-radius: var(--q-r-sm);
  background: var(--q-surface-2);
  overflow: hidden;
}

/* ------------------------------- 工具条 ------------------------------- */
.q-cr__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--q-border);
  background: var(--q-surface-3);
}
.q-cr__lang {
  font-size: 11.5px;
  color: var(--q-text-3);
}
.q-cr__spacer {
  flex: 1;
}
.q-cr__run {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 11px;
  border: 1px solid var(--q-border-strong);
  border-radius: var(--q-r-full);
  background: var(--q-surface);
  color: var(--q-text-2);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--q-dur) var(--q-ease);
}
.q-cr__run:hover:not(:disabled) {
  border-color: var(--q-brand-1);
  color: var(--q-brand-1);
  background: color-mix(in srgb, var(--q-brand-1) 8%, transparent);
}
.q-cr__run:disabled {
  opacity: 0.6;
  cursor: progress;
}
/* Java 走服务器真跑：给个低调的标记，和"本机沙箱"区分开 */
.q-cr__remote {
  font-size: 11px;
  color: var(--q-dim);
  border: 1px dashed var(--q-border);
  border-radius: var(--q-r-full);
  padding: 2px 7px;
}
.q-cr__javahint {
  margin: 8px 0 0;
  padding: 7px 10px;
  border-radius: var(--q-r-sm);
  background: color-mix(in srgb, var(--q-warn) 12%, transparent);
  border-left: 3px solid var(--q-warn);
  font-size: 12.5px;
  color: var(--q-text-2);
  line-height: 1.6;
}
.q-cr__norun {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  border-radius: var(--q-r-full);
  background: color-mix(in srgb, var(--q-warn) 16%, transparent);
  color: var(--q-warn);
  font-size: 12px;
  cursor: help;
}
.q-cr__why {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 7px 11px;
  font-size: 12px;
  background: var(--q-warn-bg);
}

/* ------------------------------- 代码 ------------------------------- */
.q-cr {
  border-color: var(--q-code-bg);
}
.q-cr__bar {
  background: var(--q-code-bg);
  border-bottom-color: var(--q-code-line);
  color: var(--q-code-dim);
}
.q-cr__lang {
  color: var(--q-code-dim);
}
.q-cr__code {
  margin: 0;
  padding: 10px 0;
  font-family: var(--q-mono);
  font-size: 13px;
  line-height: 1.9;
  overflow-x: auto;
  background: var(--q-code-bg);
  color: var(--q-code-text);
  tab-size: 2;
}
.q-cr__line {
  display: block;
  padding: 0 14px 0 0;
  white-space: pre;
}
.q-cr__line:nth-child(even) {
  background: var(--q-code-line);
}
.q-cr__ln {
  display: inline-block;
  width: 46px;
  padding-right: 12px;
  text-align: right;
  color: var(--q-code-dim);
  user-select: none;
  font-size: 11.5px;
}
.q-cr__txt {
  white-space: pre;
  color: var(--q-code-text);
}
.q-cr__line.is-clickable {
  cursor: pointer;
}
.q-cr__line.is-clickable:hover {
  background: color-mix(in srgb, var(--q-code-caret) 16%, transparent);
}
.q-cr__line.is-picked {
  background: color-mix(in srgb, var(--q-code-caret) 22%, transparent);
  box-shadow: inset 3px 0 0 var(--q-code-caret);
}
.q-cr__line.is-answer {
  background: color-mix(in srgb, var(--q-code-ok) 20%, transparent);
  box-shadow: inset 3px 0 0 var(--q-code-ok);
}
.q-cr__line.is-mine-bad {
  background: color-mix(in srgb, var(--q-code-bad) 20%, transparent);
  box-shadow: inset 3px 0 0 var(--q-code-bad);
}

/* 空的输入框：**宽度跟着内容走**（用户：有多长就多长，别固定）。
   判定之后按正确答案的长度再放一次，免得答案比填的长就看不全。 */
.q-cr__blank {
  display: inline-block;
  min-width: 4ch;
  max-width: 100%;
  padding: 1px 6px;
  margin: 0 2px;
  border: 1px dashed var(--q-code-caret);
  border-radius: var(--q-r-xs);
  background: color-mix(in srgb, var(--q-code-caret) 14%, transparent);
  color: #fff;
  caret-color: var(--q-code-caret);
  font-family: var(--q-mono);
  font-size: 13px;
  outline: none;
  transition: width 0.12s var(--q-ease), box-shadow var(--q-dur) var(--q-ease);
}
.q-cr__blank::placeholder {
  color: color-mix(in srgb, var(--q-code-text) 45%, transparent);
}
.q-cr__blank:focus {
  border-style: solid;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--q-code-caret) 28%, transparent);
}
.q-cr__blank.is-ok {
  border-color: var(--q-code-ok);
  border-style: solid;
  background: color-mix(in srgb, var(--q-code-ok) 18%, transparent);
}
.q-cr__blank.is-bad {
  border-color: var(--q-code-bad);
  border-style: solid;
  background: color-mix(in srgb, var(--q-code-bad) 18%, transparent);
}

/* 手写/修好它：编辑框也是代码面板（深色 + 等宽），别看起来像一块普通文本域 */
.q-cr__edit {
  display: block;
  width: 100%;
  margin: 0;
  padding: 12px 14px;
  border: 0;
  outline: none;
  resize: vertical;
  background: var(--q-code-bg);
  color: var(--q-code-text);
  caret-color: var(--q-code-caret);
  font-family: var(--q-mono);
  font-size: 13px;
  line-height: 1.9;
  tab-size: 2;
}
.q-cr__edit::placeholder {
  color: var(--q-code-dim);
}
.q-cr__edit:disabled {
  opacity: 0.8;
}

/* ------------------------------ 运行结果 ------------------------------ */
.q-cr__out {
  border-top: 1px solid var(--q-code-line);
  background: var(--q-code-bg-2);
}
.q-cr__outhead {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: 11.5px;
  color: var(--q-code-dim);
}
.q-cr__outbody {
  margin: 0;
  padding: 4px 14px 12px;
  font-family: var(--q-mono);
  font-size: 12.5px;
  line-height: 1.85;
  max-height: 220px;
  overflow: auto;
  color: var(--q-code-text);
}
.q-cr__outline {
  display: block;
  white-space: pre-wrap;
  word-break: break-word;
}
.q-cr__outline.is-error,
.q-cr__outline.is-stderr {
  color: var(--q-code-bad);
}
.q-cr__outline.is-warn {
  color: var(--q-warn);
}
.q-cr__outempty {
  margin: 0;
  padding: 4px 14px 12px;
  font-size: 12px;
  color: var(--q-code-dim);
}
.q-cr__err {
  margin: 0;
  padding: 0 14px 12px;
  font-family: var(--q-mono);
  font-size: 12px;
  color: var(--q-code-bad);
  white-space: pre-wrap;
}

/* ------------------------------ 判定后 ------------------------------ */
.q-cr__ans {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 9px 11px;
  border-top: 1px solid var(--q-border);
  background: var(--q-surface-3);
}
.q-cr__anslabel {
  font-size: 12px;
  font-weight: 700;
  color: var(--q-text-2);
}
.q-cr__ansitem {
  padding: 2px 7px;
  border-radius: var(--q-r-xs);
  background: var(--q-ok-bg);
  color: var(--q-ok);
  font-family: var(--q-mono);
  font-size: 12.5px;
}

/* ------------------------------- 提交 ------------------------------- */
.q-cr__foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 11px;
  border-top: 1px solid var(--q-border);
}
.q-cr__hint {
  font-size: 12px;
}
/* 还差 N 个空 / 还没点行：这不是花边提示，是"为什么按钮是灰的"的答案，要看得见 */
.q-cr__hint.is-todo {
  color: var(--q-warn);
  font-weight: 600;
}

/* ── 拖拽排序（Parsons）─────────────────────────────────────────────────
   目标：一眼看出"这是一摞可搬动的代码块"，而不是一段读的代码。
   拖拽中的块浮起来、落点上给一条提示线；提交后对/错直接在块上标出来。 */
.q-cr__parsons {
  padding: 10px 12px;
}
.q-cr__phint {
  margin: 0 0 8px;
  font-size: 12px;
}
.q-cr__plist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.q-cr__pblock {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--q-code-line, #2a3040);
  border-left: 3px solid var(--q-code-line, #2a3040);
  border-radius: 6px;
  background: var(--q-code-bg-2, #12151e);
  color: var(--q-code-text, #e6edf3);
  cursor: grab;
}
.q-cr__pblock.is-drag {
  opacity: 0.4;
}
.q-cr__pblock.is-over {
  border-top: 2px dashed var(--q-code-caret, #7dd3fc);
}
.q-cr__pblock.is-ok {
  border-left-color: var(--q-code-ok, #34d399);
}
.q-cr__pblock.is-bad {
  border-left-color: var(--q-code-bad, #f87171);
  background: color-mix(in srgb, var(--q-code-bad, #f87171) 12%, transparent);
}
.q-cr__pgrip {
  color: var(--q-code-dim, #64748b);
  user-select: none;
}
.q-cr__pno {
  color: var(--q-code-dim, #64748b);
  font-size: 12px;
  min-width: 1.4em;
}
.q-cr__ptext {
  margin: 0;
  flex: 1;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--q-mono);
  font-size: 13px;
  line-height: 1.6;
}
.q-cr__pbtn {
  display: flex;
  gap: 2px;
  flex: none;
}
.q-cr__pbtn button {
  width: 22px;
  height: 22px;
  border: 1px solid var(--q-code-line, #2a3040);
  border-radius: 4px;
  background: transparent;
  color: var(--q-code-text, #e6edf3);
  cursor: pointer;
  line-height: 1;
}
.q-cr__pbtn button:disabled {
  opacity: 0.35;
  cursor: default;
}
.q-cr__pscore {
  margin: 10px 0 0;
  font-size: 12px;
}
.q-cr__pscore.is-ok {
  color: var(--q-code-ok, #34d399);
}
.q-cr__pscore.is-bad {
  color: var(--q-code-bad, #f87171);
}
.q-cr__shuffle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.q-cr__host {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
}

@media (max-width: 640px) {
  .q-cr__code {
    font-size: 12px;
    /* ★ 手机屏窄：实测代码框只有 328px 而内容 608px —— 原来能横向滑（`overflow-x` 一直有），
       但**没有任何提示**，学生只看到右半边被"裁"掉（例如第 1 行结尾的 `/>` 看不见）。
       手机上宁可折行：读代码时看不到右半边，比排版稍微难看糟糕得多。
       ⚠️ 必须连**子元素**一起管：代码是按行渲染的，只写父级 `white-space` 管不到行元素，
          实测那样做仍然横溢 608px（父级算出来是 pre-wrap，scrollWidth 却纹丝不动）。 */
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .q-cr__code * {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .q-cr__blank {
    min-width: 70px;
  }
  /* 拖拽排序的 ↑/↓ 实测只有 16~24px，手指点不中（而提示写着"拖不动就点 ↑ ↓"）。
     40px 是可点下限（iOS 44 / Material 48 更宽，先按 40 兜住）。 */
  .q-cr__pblock > button {
    min-width: 40px;
    min-height: 40px;
  }
}
</style>
