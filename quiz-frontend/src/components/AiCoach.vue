<script setup>
/**
 * AiCoach.vue —— 问 AI：**就着当前这道题**多轮追问。
 *
 * 它接的是后端已有的 `/api/quiz/tutor/`（本来是驾考站在用，接口和降级链都在
 * quizgen 里）。刷题站这边想要的不是"再给一个答案"，而是三件事：
 *   1. **答错之后能接着问** ——「我这样理解错在哪」「为什么不选 C」；
 *   2. **教材题库要能点回原文** —— 提示词走 docs 包（引用文档说法、没写就说没写）；
 *   3. **代码题也得能问** —— 题干之外的 `code` / `mode` 一起送上去，
 *      否则模型看到"哪一行被改了"却看不到代码。
 *
 * 实现上是个受控抽屉：消息只存在组件内存里（不落盘）——
 * 这些对话是一次性的学习过程，没必要占本地存储。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { askCoach, ApiError } from '@/core/api'
import { TYPE_LABEL } from '@/core/normalize'
import { coachDomain, quickAsks, tutorContext } from '@/core/coach'
import { CODE_MODE_LABEL } from '@/core/code'

const props = defineProps({
  question: { type: Object, default: null },
  bankId: { type: String, default: '' },
  subject: { type: String, default: '' },
  /** 题库 meta —— 用来判断该走 docs 包还是通用包（见 core/coach.js） */
  meta: { type: Object, default: null },
  answerKeys: { type: Array, default: () => [] },
  analysis: { type: String, default: '' },
  /** 学员当时选了什么（答错时特别有用："我选了 B，为什么不对"） */
  picked: { type: Array, default: () => [] },
})

const open = defineModel({ type: Boolean, default: false })

const messages = ref([])
const input = ref('')
const busy = ref(false)
const fatal = ref('')
const scroller = ref(null)
/**
 * 上一次回答是哪条来源给的。
 * 为什么要显示：后端是"先本机小模型、不行再云端"的降级链，
 * 而本机那个 1.5B **做不了精确任务**（HANDOVER 里实测过：逐字引用 20 道错 10 道）。
 * 学员得知道这份讲解是强模型给的还是弱模型给的 —— 弱模型说的别当真背。
 */
const lastSource = ref(null)

const q = computed(() => props.question)
const isCode = computed(() => q.value?.type === 'code')
const domain = computed(() => coachDomain(props.meta))

const QUICK = computed(() => quickAsks(domain.value, q.value?.mode || ''))

const answerText = computed(() => {
  const keys = props.answerKeys || []
  if (!keys.length) return '（题库没给）'
  if (isCode.value) {
    if (q.value.mode === 'spot') return `第 ${keys[0]} 行`
    return keys.map((k) => String(k)).join(' | ').slice(0, 80)
  }
  if (q.value?.type === 'judge') return keys.map((k) => (k === 'T' ? '正确' : '错误')).join('、')
  return keys.join('、')
})

const pickText = computed(() => {
  const keys = props.picked || []
  if (!keys.length) return '（没作答 / 跳过了）'
  if (isCode.value) {
    if (q.value.mode === 'spot') return `第 ${keys[0]} 行`
    return keys.map((k) => String(k)).join(' | ').slice(0, 80)
  }
  if (q.value?.type === 'judge') return keys.map((k) => (k === 'T' ? '正确' : '错误')).join('、')
  return keys.join('、')
})

function optionLines() {
  return (q.value?.options || []).map((o) => {
    const key = q.value?.type === 'judge' ? (o.key === 'T' ? '正确' : '错误') : o.key
    return `${key}. ${o.text}`
  })
}

async function scrollDown() {
  await nextTick()
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}

async function send(text) {
  const msg = String(text ?? input.value).trim()
  if (!msg || busy.value) return
  if (!q.value) return

  fatal.value = ''
  input.value = ''
  messages.value.push({ role: 'user', content: msg })
  busy.value = true
  await scrollDown()

  // 只把最近几轮带上去，避免上下文无限增长（也省 token；后端另有 12 轮上限）
  const history = messages.value
    .slice(0, -1)
    .slice(-6)
    .map((m) => ({ role: m.role, content: m.content }))

  try {
    const r = await askCoach({
      bankId: props.bankId,
      subject: props.subject,
      question: tutorContext(q.value, { answerKeys: props.answerKeys, analysis: props.analysis }),
      history,
      message: msg,
      domain: domain.value,
    })
    const answer = String(r?.answer || '').trim()
    lastSource.value = r?.llmSource || null
    messages.value.push({
      role: 'assistant',
      content: answer || '（模型这次没有返回内容，换个问法再试试）',
    })
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError(String(e?.message || e))
    let tip = err.message
    if (err.code === 'llm_not_configured') {
      tip = '后端还没有可用的模型。到「设置 → AI 后端」看一下，或让管理员配上密钥/本机模型。'
    } else if (err.code === 'throttled') {
      tip = '问得太快了，AI 接口有限流。过几分钟再问。'
    } else if (err.status === 404) {
      tip = '后端没有「问 AI」这个接口（需要 quizgen 的 /api/quiz/tutor/）。本机 Django 上没有这套接口，用 npm run dev 或板子上的地址试。'
    }
    fatal.value = tip
  } finally {
    busy.value = false
    await scrollDown()
  }
}

// 换题就重开一段对话 —— 上一题的追问留着只会让人困惑
watch(
  () => q.value?.id,
  () => {
    messages.value = []
    fatal.value = ''
    input.value = ''
    lastSource.value = null
  },
)

// 打开抽屉时，如果这道题还没有解析，就让 AI 先讲一遍
watch(open, async (v) => {
  if (!v || !q.value) return
  if (messages.value.length) return
  if (!props.analysis && !q.value.analysis) {
    await send('这道题我还没有解析，请你讲清楚：为什么是这个答案，其他选项各错在哪里。')
  }
})
</script>

<template>
  <el-drawer
    v-model="open"
    :title="q ? `问 AI · 第 ${q.no} 题` : '问 AI'"
    size="520px"
    :z-index="3000"
    direction="rtl"
    class="q-coach-drawer"
  >
    <div v-if="!q" class="q-coach__empty q-dim">先选一道题，再问 AI。</div>

    <div v-else class="q-coach">
      <!-- 题目上下文：滚上去也能看见在问哪道题 -->
      <div class="q-coach__ctx">
        <div class="q-coach__ctxhead">
          <span class="q-chip q-chip--brand">{{ TYPE_LABEL[q.type] || q.type }}</span>
          <span v-if="isCode && q.mode" class="q-chip">{{ CODE_MODE_LABEL[q.mode] || q.mode }}</span>
          <span v-if="q.chapter" class="q-chip">{{ q.chapter }}</span>
          <span class="q-coach__ans">答案 {{ answerText }}</span>
        </div>
        <p class="q-coach__stem">{{ q.stem }}</p>
        <pre v-if="isCode" class="q-coach__code"><code>{{ q.code }}</code></pre>
        <ul v-if="!isCode && optionLines().length" class="q-coach__opts">
          <li v-for="line in optionLines()" :key="line">{{ line }}</li>
        </ul>
        <p class="q-coach__pick q-dim">你选的是 {{ pickText }}</p>
      </div>

      <!-- 对话 -->
      <div ref="scroller" class="q-coach__log">
        <div v-if="!messages.length && !busy" class="q-coach__intro q-dim">
          就着这道题随便问。也可以点下面的快捷问题。
        </div>
        <div
          v-for="(m, i) in messages"
          :key="i"
          class="q-coach__msg"
          :class="m.role === 'user' ? 'is-me' : 'is-ai'"
        >
          <div class="q-coach__bubble">{{ m.content }}</div>
        </div>
        <div v-if="busy" class="q-coach__msg is-ai">
          <div class="q-coach__bubble q-coach__typing"><span /><span /><span /></div>
        </div>
      </div>

      <p v-if="fatal" class="q-coach__fatal">
        <el-icon><WarningFilled /></el-icon>{{ fatal }}
      </p>

      <!-- 这条回答是哪条来源给的：本机小模型做不了精确任务，得让学员看得见 -->
      <p v-if="lastSource && lastSource.used && lastSource.used !== 'none'" class="q-coach__src">
        <el-icon><Cpu /></el-icon>
        <template v-if="lastSource.used === 'local'">
          本次由<b>本机小模型</b>回答（免费，但它做不了逐字引用这类精确任务，别直接背）
        </template>
        <template v-else-if="lastSource.used === 'cloud'">本次由<b>云端模型</b>回答</template>
        <template v-else>本次由 {{ lastSource.used }} 回答</template>
        <span v-if="lastSource.degraded" class="q-coach__srcwarn">（已降级）</span>
      </p>

      <!-- 快捷问法 -->
      <div class="q-coach__quick">
        <button v-for="k in QUICK" :key="k" class="q-coach__qbtn" :disabled="busy" @click="send(k)">
          {{ k }}
        </button>
      </div>

      <!-- 输入 -->
      <div class="q-coach__input">
        <el-input
          v-model="input"
          type="textarea"
          :rows="2"
          resize="none"
          placeholder="继续追问… （Ctrl/Cmd + Enter 发送）"
          :disabled="busy"
          @keydown.enter.ctrl.prevent="send()"
          @keydown.enter.meta.prevent="send()"
        />
        <el-button type="primary" :loading="busy" :disabled="!input.trim()" @click="send()">
          <el-icon><Promotion /></el-icon>发送
        </el-button>
      </div>
      <p class="q-coach__note q-dim">
        AI 的回答可能有误。教材题库的每道题都有「出处」，以原文为准；对话不会保存。
      </p>
    </div>
  </el-drawer>
</template>

<style scoped>
.q-coach {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 10px;
}
.q-coach__empty {
  padding: 30px 0;
  text-align: center;
}

.q-coach__ctx {
  flex: none;
  padding: 12px 13px;
  border-radius: var(--q-r-sm);
  background: var(--q-surface-2);
  border: 1px solid var(--q-border);
  max-height: 34vh;
  overflow: auto;
}
.q-coach__ctxhead {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.q-coach__ans {
  margin-left: auto;
  font-size: 12px;
  font-weight: 800;
  color: var(--q-ok);
  font-family: var(--q-mono);
}
.q-coach__stem {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.7;
}
.q-coach__code {
  margin: 0 0 8px;
  padding: 8px 10px;
  border-radius: var(--q-r-xs);
  background: var(--q-bg-deep);
  font-family: var(--q-mono);
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  max-height: 22vh;
}
.q-coach__opts {
  margin: 0;
  padding-left: 18px;
  font-size: 12.5px;
  color: var(--q-text-2);
  line-height: 1.75;
}
.q-coach__pick {
  margin: 8px 0 0;
  font-size: 12px;
}

.q-coach__log {
  flex: 1;
  min-height: 120px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 2px;
}
.q-coach__intro {
  font-size: 12.5px;
  text-align: center;
  padding: 20px 0;
}
.q-coach__msg {
  display: flex;
}
.q-coach__msg.is-me {
  justify-content: flex-end;
}
.q-coach__bubble {
  max-width: 88%;
  padding: 9px 12px;
  border-radius: 12px;
  font-size: 13.5px;
  line-height: 1.78;
  white-space: pre-wrap;
  word-break: break-word;
}
.q-coach__msg.is-me .q-coach__bubble {
  background: var(--q-brand-1);
  color: #fff;
  border-bottom-right-radius: 4px;
}
.q-coach__msg.is-ai .q-coach__bubble {
  background: var(--q-surface-3);
  color: var(--q-text);
  border-bottom-left-radius: 4px;
}
.q-coach__typing {
  display: flex;
  gap: 4px;
  align-items: center;
  min-height: 20px;
}
.q-coach__typing span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--q-text-3);
  animation: q-blink 1.1s infinite ease-in-out;
}
.q-coach__typing span:nth-child(2) {
  animation-delay: 0.18s;
}
.q-coach__typing span:nth-child(3) {
  animation-delay: 0.36s;
}
@keyframes q-blink {
  0%,
  60%,
  100% {
    opacity: 0.25;
  }
  30% {
    opacity: 1;
  }
}

.q-coach__fatal {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin: 0;
  padding: 9px 11px;
  border-radius: var(--q-r-xs);
  background: var(--q-bad-bg);
  color: var(--q-bad);
  font-size: 12.5px;
  line-height: 1.6;
}

.q-coach__src {
  flex: none;
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0;
  padding: 6px 10px;
  border-radius: var(--q-r-xs);
  background: var(--q-surface-2);
  border: 1px solid var(--q-border);
  font-size: 11.5px;
  color: var(--q-text-3);
  line-height: 1.55;
}
.q-coach__src b {
  color: var(--q-text-2);
}
.q-coach__srcwarn {
  color: var(--q-warn);
}

.q-coach__quick {
  flex: none;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.q-coach__qbtn {
  border: 1px solid var(--q-border);
  background: var(--q-surface);
  color: var(--q-text-2);
  font-size: 12px;
  padding: 5px 9px;
  border-radius: var(--q-r-full);
  cursor: pointer;
  transition: all var(--q-dur) var(--q-ease);
}
.q-coach__qbtn:hover:not(:disabled) {
  border-color: var(--q-brand-1);
  color: var(--q-brand-1);
  background: color-mix(in srgb, var(--q-brand-1) 7%, transparent);
}
.q-coach__qbtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.q-coach__input {
  flex: none;
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.q-coach__note {
  flex: none;
  margin: 0;
  font-size: 11.5px;
}

@media (max-width: 640px) {
  :deep(.el-drawer) {
    width: 100% !important;
  }
}
</style>
