<template>
  <section class="q-ar">
    <div class="q-ar__head">
      <h3 class="q-ar__title">让 AI 检查</h3>
      <p class="q-ar__sub">
        写完、跑过之后点一下，让 AI 看看：哪里对、哪里不对、下一步补什么。
      </p>
    </div>

    <label class="q-ar__goal">
      <span class="q-ar__glabel">我想做什么</span>
      <input
        class="q-ar__input"
        type="text"
        maxlength="300"
        placeholder="比如：把一列数字求和再打印出来（不写也行）"
        :value="goal"
        @input="$emit('update:goal', $event.target.value)"
      />
    </label>

    <div class="q-ar__bar">
      <button class="q-ar__go" :disabled="busy || !hasCode" @click="check">
        <span v-if="busy">AI 正在看…</span>
        <span v-else>让 AI 检查</span>
      </button>
      <span v-if="runText" class="q-ar__chip is-run">会带上你上次运行的结果</span>
      <span v-else class="q-ar__chip">还没运行过，这次只能静态判断</span>
    </div>

    <!-- 拿不到模型 / 接口失败：直接显示后端给的那句中文说明，不自己编一句 -->
    <p v-if="note" class="q-ar__note">{{ note }}</p>

    <div v-if="result" class="q-ar__card">
      <p v-if="result.summary" class="q-ar__summary">{{ result.summary }}</p>

      <ul class="q-ar__points">
        <li
          v-for="(p, i) in result.points"
          :key="i"
          class="q-ar__point"
          :class="'is-' + p.level"
        >
          <span class="q-ar__badge">{{ LEVEL_LABEL[p.level] || '待看' }}</span>
          <span class="q-ar__ptext">{{ p.text }}</span>
        </li>
      </ul>

      <p v-if="result.next" class="q-ar__next"><b>下一步</b>：{{ result.next }}</p>

      <p v-if="sourceText" class="q-ar__src">{{ sourceText }}</p>
    </div>
  </section>
</template>

<script setup>
/**
 * AiReview.vue —— 演武场的「让 AI 检查」（任务回路的最后半步）
 * ============================================================================
 * 为什么单独一个组件：演武场那个页面（ForgeView）只管"写 + 跑"，
 * 而这里是"他觉得自己做完了之后"才发生的事 —— 请求、忙碌、失败提示、
 * 三档分色渲染都在这一块里，页面只负责把 goal / 代码 / 上次运行结果递进来。
 *
 * 三条和其他 AI 组件一致的规矩（别在这里破例）：
 *   · LLM 调用只走 core/api.js 的 reviewCode（它背后是同一个后端降级链）；
 *   · **后端给的中文说明原样显示** —— 没配模型、限流、接口挂了，
 *     后端说的是人话，前端不要再自己编一句（那样两边话术会慢慢跑偏）；
 *   · 纯文本渲染，不 v-html：批改内容里混着模型输出，走 innerHTML 等于开门。
 */
import { computed, ref } from 'vue'

import { ApiError, reviewCode } from '@/core/api'

const props = defineProps({
  /** 他想做什么（v-model:goal，可以空） */
  goal: { type: String, default: '' },
  /** 当前编辑器里的代码 */
  code: { type: String, default: '' },
  /** 'java' / 'js'；空串表示"自动"，那就别告诉后端语言，让它按代码自己判断 */
  lang: { type: String, default: '' },
  /** 上一次运行看到的结果 {text, ok}；没有就传 null */
  lastRun: { type: Object, default: null },
})

defineEmits(['update:goal'])

/** 三档 level → 中文短标签（颜色在 CSS 里，按语义色变量走） */
const LEVEL_LABEL = { ok: '做对了', bad: '有问题', todo: '下一步' }

const busy = ref(false)
const result = ref(null)
const note = ref('')

const hasCode = computed(() => Boolean(props.code && props.code.trim()))
const runText = computed(() => String(props.lastRun?.text || '').trim())

const sourceText = computed(() => {
  const info = result.value?.llmSource || {}
  const used = info.used
  if (!used || used === 'none') return ''
  const who = used === 'cloud' ? '云端模型' : used === 'local' ? '本机小模型' : used
  const warn = info.degraded ? '（已降级）' : ''
  return `本次批改来自${who}${warn} —— 模型也可能看错，以你自己的运行结果为准。`
})

async function check() {
  if (busy.value || !hasCode.value) return
  busy.value = true
  note.value = ''
  result.value = null
  try {
    const r = await reviewCode({
      goal: props.goal,
      code: props.code,
      lang: props.lang === 'java' ? 'java' : props.lang ? 'js' : '',
      output: runText.value,
    })
    result.value = {
      summary: String(r?.summary || ''),
      points: Array.isArray(r?.points) ? r.points : [],
      next: String(r?.next || ''),
      llmSource: r?.llmSource || null,
    }
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError(String(e?.message || e))
    note.value = err.message || '没拿到批改结果，过一会儿再试。'
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.q-ar {
  margin-top: 12px;
  padding: 12px 14px 14px;
  border: 1px solid var(--q-border);
  border-radius: 8px;
  background: var(--q-surface-2);
}
.q-ar__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.q-ar__title {
  margin: 0;
  font-size: 15px;
}
.q-ar__sub {
  margin: 0;
  font-size: 12px;
  color: var(--q-text-3);
}
.q-ar__goal {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.q-ar__glabel {
  font-size: 12px;
  color: var(--q-text-3);
  white-space: nowrap;
}
.q-ar__input {
  flex: 1;
  min-width: 220px;
  padding: 6px 10px;
  font-size: 13px;
  color: var(--q-text);
  background: var(--q-surface-3);
  border: 1px solid var(--q-border);
  border-radius: 6px;
  outline: none;
}
.q-ar__input:focus {
  border-color: var(--q-brand-1);
}
.q-ar__bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.q-ar__go {
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 600;
  color: #fff;
  background: var(--q-brand-1);
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
}
.q-ar__go:disabled {
  opacity: 0.55;
  cursor: default;
}
.q-ar__chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  color: var(--q-text-3);
  border: 1px solid var(--q-border);
}
.q-ar__chip.is-run {
  color: var(--q-ok);
  background: var(--q-ok-bg);
  border-color: transparent;
}
.q-ar__note {
  margin: 10px 0 0;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  color: var(--q-text-2);
  background: var(--q-warn-bg);
  border-radius: 6px;
}
.q-ar__card {
  margin-top: 10px;
}
.q-ar__summary {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--q-text);
}
.q-ar__points {
  margin: 0;
  padding: 0;
  list-style: none;
}
.q-ar__point {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  margin-bottom: 6px;
  border-radius: 6px;
  border-left: 3px solid var(--q-border);
  background: var(--q-surface-3);
}
.q-ar__badge {
  flex: none;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  color: var(--q-text-2);
  background: var(--q-surface-2);
}
.q-ar__ptext {
  font-size: 13px;
  line-height: 1.7;
  color: var(--q-text);
  word-break: break-word;
}
/* 三档分色：绿＝做对了 / 红＝有问题 / 黄＝下一步（和站点的语义色变量对齐） */
.q-ar__point.is-ok {
  border-left-color: var(--q-ok);
  background: var(--q-ok-bg);
}
.q-ar__point.is-ok .q-ar__badge {
  color: var(--q-ok);
}
.q-ar__point.is-bad {
  border-left-color: var(--q-bad);
  background: var(--q-bad-bg);
}
.q-ar__point.is-bad .q-ar__badge {
  color: var(--q-bad);
}
.q-ar__point.is-todo {
  border-left-color: var(--q-warn);
  background: var(--q-warn-bg);
}
.q-ar__point.is-todo .q-ar__badge {
  color: var(--q-warn);
}
.q-ar__next {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--q-text);
}
.q-ar__src {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--q-text-3);
}
</style>

