<template>
  <div class="q-sr">
    <div class="q-sr__bar">
      <button class="q-sr__run" :disabled="running || !code" @click="run">
        <span v-if="running">运行中…</span>
        <span v-else>运行</span>
      </button>
      <span v-if="planned && planned.wrapped" class="q-sr__badge" title="这段是片段，已经替你补了类壳 + main 方法再跑">
        已自动补壳
      </span>
      <span v-if="langLabel" class="q-sr__lang">{{ langLabel }}</span>
      <span class="q-sr__grow" />
      <span v-if="ran" class="q-sr__dim">最后一次运行的结果</span>
    </div>

    <!-- 补了壳就把最终跑的那份给人看：不然输出对不上原文，人会以为跑错了 -->
    <details v-if="ran && planned && planned.wrapped" class="q-sr__shell">
      <summary>看看补壳之后真正编译的是什么</summary>
      <pre class="q-sr__pre">{{ planned.source }}</pre>
    </details>

    <p v-if="hint" class="q-sr__hint">{{ hint }}</p>

    <div v-if="output" class="q-sr__out">
      <pre v-for="(l, i) in output.lines" :key="i" class="q-sr__line" :class="`is-${l.kind}`">{{ l.text }}</pre>
      <p v-if="!output.lines.length" class="q-sr__dim">（跑完了，没有任何输出 —— 是不是忘了 print / console.log？）</p>
      <p v-if="output.meta && output.meta.ms" class="q-sr__dim">
        用了 {{ output.meta.ms }}ms<span v-if="output.meta.sandbox"> · {{ output.meta.sandbox }}</span>
      </p>
    </div>
  </div>
</template>

<script setup>
/**
 * SnippetRunner.vue —— **随手跑一段代码**（校对台 / 演武场共用）
 * ============================================================================
 * 站主原话：「提权后我需要可以运行代码」「扫描件出结果复核的时候更能学到东西，
 * 那简直就是活的代码排错」。
 *
 * 两条执行路径（和题目里的代码题**同一套**，别另起一份）：
 *   · JS / Vue 片段 → 浏览器里的 iframe 沙箱（`core/code.js` 的 buildSandboxDoc，
 *     沙箱里装了迷你 Vue，所以 `ref/computed` 那种教材示例也能跑）
 *   · Java → **后端真 JVM**（板子上真 javac + java），必须提权后才可用
 *
 * ⚠️ 提权相关的话**只说"当前不可用"**：站主要求别对外显示可以提权，
 *    所以这里既不提"提权"两个字、也不写敲键序列（见 CodeRunner.vue 同款规矩）。
 */
import { computed, onBeforeUnmount, ref } from 'vue'

import { buildSandboxDoc, collectRun, readSandboxMessage } from '@/core/code'
import { runJava as apiRunJava } from '@/core/api'
import { clearToken, loadToken, wasElevatedBefore } from '@/core/elevate'
import { javaResultToRun, javaSources } from '@/core/java'
import { snippetRunPlan } from '@/core/snippet'
import { guessLang } from '@/core/editor'

const props = defineProps({
  code: { type: String, default: '' },
  /** 语言提示；留空就按代码内容猜（core/editor.js 的 guessLang） */
  lang: { type: String, default: '' },
})

/**
 * 把"这一次他看到了什么"报给外面。
 *
 * 为什么要有这个出口：演武场的「让 AI 检查」要把**上一次运行的结果**一起发给后端
 * （学生先看到真实结果、再让 AI 批改，这正是这条回路的意义）。在这里另写一份
 * 收集逻辑就会和面板上显示的东西慢慢跑偏，所以直接复用 collectRun 的产物。
 */
const emit = defineEmits(['ran'])

const running = ref(false)
const output = ref(null)
const hint = ref('')
const ran = ref(false)
const planned = ref(null)

const RUN_TIMEOUT = 5000

const effectiveLang = computed(() => props.lang || guessLang(props.code) || 'js')
const langLabel = computed(() => (effectiveLang.value === 'java' ? 'Java（服务器真跑）' : 'JS / Vue（浏览器沙箱）'))

/* ------------------------------ JS：iframe 沙箱 ------------------------------ */
let frame = null
let timer = 0
let messages = []
let settle = null

function onMessage(event) {
  if (!frame || event.source !== frame.contentWindow) return
  const msg = readSandboxMessage(event.data)
  if (!msg) return
  if (msg.kind === 'done') return finish(false)
  messages.push(msg)
}

/** 把这一次运行的结果报给外面（演武场的「让 AI 检查」要用）。
 *
 *  只报**事实**：成功了给 stdout+报错文本，没跑成给那句人话提示 ——
 *  绝不能把"其实没跑起来"报成一段空输出，那会让 AI 那边误判成"跑过但没输出"。 */
function reportRun(run, fallbackHint = '') {
  if (run) {
    const parts = []
    if (run.output) parts.push(run.output)
    if (run.error) parts.push(run.error)
    emit('ran', { text: parts.join('\n').trim(), ok: !!run.ok })
    return
  }
  if (fallbackHint) emit('ran', { text: `（没能运行）${fallbackHint}`, ok: false })
}

/** 收尾：把 iframe 摘掉（也是掐死死循环的唯一手段），再归集结果 */
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
  reportRun(output.value)
  running.value = false
  if (settle) {
    const done = settle
    settle = null
    done()
  }
}

function runSandbox(source) {
  if (frame) finish(false)
  messages = []
  output.value = null
  running.value = true
  frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  // 0×0 摆屏幕外：不能用 display:none（有些浏览器连脚本一起不跑）
  frame.setAttribute('style', 'position:absolute;left:-9999px;top:0;width:0;height:0;border:0;visibility:hidden')
  frame.srcdoc = buildSandboxDoc({ code: source })
  document.body.appendChild(frame)
  return new Promise((resolve) => {
    settle = resolve
    timer = setTimeout(() => finish(true), RUN_TIMEOUT)
  })
}

/* ------------------------------ Java：后端真跑 ------------------------------ */
async function runJava(source) {
  const record = loadToken()
  if (!record) {
    // 对外只说不可用；**自己提权过**的人（localStorage 有标记）才告诉他怎么解锁 ——
    // 否则站主自己也会被关在门外（见 core/elevate.js 的 wasElevatedBefore）
    hint.value = wasElevatedBefore()
      ? '这段要在服务器上真跑，当前不可用：按 x s 9 9 9 解锁。'
      : '这段要在服务器上真编译真运行，当前不可用。'
    running.value = false
    reportRun(null, hint.value)
    return null
  }
  running.value = true
  hint.value = ''
  try {
    const payload = await apiRunJava({ sources: javaSources(source), params: [], token: record.token })
    output.value = javaResultToRun(payload?.result)
    reportRun(output.value)
    return output.value
  } catch (error) {
    if (error?.code === 'elevate_required') {
      clearToken()
      hint.value = wasElevatedBefore()
        ? '服务器真跑当前不可用（授权已过期）：按 x s 9 9 9 重新解锁。'
        : '服务器真跑当前不可用（授权已失效）。'
    } else if (error?.code === 'java_disabled') {
      hint.value = '服务器没打开 Java 真跑。这段暂时只能看代码。'
    } else {
      hint.value = error?.message || '没跑起来。'
    }
    reportRun(null, hint.value)
    return null
  } finally {
    running.value = false
  }
}

async function run() {
  if (running.value || !props.code) return
  output.value = null
  hint.value = ''
  ran.value = true
  const plan = snippetRunPlan(props.code, { lang: props.lang || effectiveLang.value })
  planned.value = plan
  if (!plan.runnable) {
    hint.value = plan.reason
    reportRun(null, plan.reason)
    return
  }
  if (plan.lang === 'java') return runJava(plan.source)
  return runSandbox(plan.source)
}

// 沙箱消息是 postMessage 过来的，监听挂在 window 上
if (typeof window !== 'undefined') window.addEventListener('message', onMessage)

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener('message', onMessage)
  if (timer) clearTimeout(timer)
  if (frame) {
    try {
      frame.remove()
    } catch {
      /* 已不在 */
    }
    frame = null
  }
})
</script>

<style scoped>
.q-sr {
  border: 1px solid var(--q-code-line, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
  background: var(--q-code-bg-2, #12151e);
  padding: 8px 10px;
}
.q-sr__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.q-sr__grow {
  flex: 1;
}
.q-sr__run {
  border: 1px solid var(--q-code-line, rgba(255, 255, 255, 0.12));
  background: var(--q-code-bg, #191d29);
  color: var(--q-code-text, #e7ebf5);
  border-radius: 6px;
  padding: 4px 12px;
  font: 600 12px var(--q-mono, monospace);
  cursor: pointer;
}
.q-sr__run:disabled {
  opacity: 0.55;
  cursor: default;
}
.q-sr__badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  color: var(--q-code-caret, #a5b0ff);
  border: 1px solid currentColor;
}
.q-sr__lang,
.q-sr__dim {
  font-size: 11px;
  color: var(--q-code-dim, #7c86a2);
}
.q-sr__hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--q-code-dim, #7c86a2);
}
.q-sr__shell summary {
  margin-top: 8px;
  font-size: 11px;
  color: var(--q-code-dim, #7c86a2);
  cursor: pointer;
}
.q-sr__pre,
.q-sr__line {
  margin: 6px 0 0;
  padding: 0;
  font-family: var(--q-mono, monospace);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--q-code-text, #e7ebf5);
}
.q-sr__out {
  margin-top: 6px;
  border-top: 1px dashed var(--q-code-line, rgba(255, 255, 255, 0.08));
  padding-top: 4px;
}
.q-sr__line.is-stderr {
  color: var(--q-code-dim, #7c86a2);
}
.q-sr__line.is-error {
  color: var(--q-code-bad, #f87171);
}
</style>
