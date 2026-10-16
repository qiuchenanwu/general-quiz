<template>
  <div ref="host" class="q-ce" :class="`q-ce--${kind}`" />
</template>

<script setup>
/**
 * CodeEditor.vue —— 能写代码的输入框：**语法高亮 + 自动补全**。
 * ============================================================================
 * 站主原话：「用户修改代码你要加上自动补全和颜色区分，让他们在校验的时候就提前熟悉代码」。
 * 真正的实现（选型、为什么不用 basicSetup、为什么动态 import）在 `core/editor.js` 的注释里，
 * 这里只负责：**Vue 的 v-model 语义 + 卸载时销毁 + 加载不出来就退回 textarea**。
 *
 * ⚠️ 词表（`words`）由调用方给，而且要给**题目原始代码**里的词，不是学生正在打的那份 ——
 *    补全列表要是跟着输入实时变，学生会看到自己刚打错的词被当成"建议"，越打越歪。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { mountEditor } from '@/core/editor'

const props = defineProps({
  modelValue: { type: String, default: '' },
  /** 语言：'java' / 'js' / 'vue'（认不出就按 js 高亮，至少括号和字符串分得开） */
  lang: { type: String, default: '' },
  /** 补全词表（调用方用 core/editor.js 的 completionWords 从**题目原始代码**收词） */
  words: { type: Array, default: () => [] },
  readOnly: { type: Boolean, default: false },
  /** 代码块主题 id（见 core/code-theme.js）。'site' = 跟随站点明暗，是默认 */
  theme: { type: String, default: 'site' },
})
const emit = defineEmits(['update:modelValue'])

const host = ref(null)
const kind = ref('loading')
let ed = null
// 防止 setValue → onChange → emit → prop 回灌 → setValue 的死循环
let syncing = false

onMounted(async () => {
  ed = await mountEditor(host.value, {
    doc: props.modelValue,
    lang: props.lang,
    words: props.words,
    readOnly: props.readOnly,
    themeId: props.theme,
    onChange: (v) => {
      syncing = true
      emit('update:modelValue', v)
      syncing = false
    },
  })
  kind.value = ed.kind
})

watch(
  () => props.modelValue,
  (v) => {
    if (!ed || syncing) return
    if (ed.getValue() !== v) ed.setValue(v ?? '')
  },
)

watch(
  () => props.readOnly,
  (v) => {
    if (ed && ed.kind === 'textarea') {
      const ta = host.value?.querySelector('textarea')
      if (ta) ta.readOnly = v
    }
  },
)

/**
 * 换代码块主题：**就地重配高亮**，不重建编辑器 ——
 * 重建会丢光标位置和撤销栈，用户在设置页顺手换个配色不该有这种代价。
 */
watch(
  () => props.theme,
  (v) => {
    ed?.setTheme?.(v)
  },
)

onBeforeUnmount(() => {
  if (ed) ed.destroy()
  ed = null
})
</script>

<style scoped>
.q-ce {
  border: 1px solid var(--q-code-line, #2a3040);
  border-radius: 6px;
  background: var(--q-code-bg, #191d29);
  color: var(--q-code-text, #e6edf3);
  font-family: var(--q-mono);
  font-size: 13px;
  overflow: hidden;
}
.q-ce :deep(.cm-editor) {
  font-family: var(--q-mono);
}
.q-ce :deep(.cm-scroller) {
  font-family: var(--q-mono);
  line-height: 1.7;
}
.q-ce :deep(.cm-gutters) {
  border-right: 1px solid var(--q-code-line, #2a3040);
}
/* 兜底路径（CodeMirror 没加载出来）：至少保证还能正常写 */
.q-ce__fallback {
  display: block;
  width: 100%;
  border: 0;
  outline: none;
  resize: vertical;
  padding: 10px 12px;
  background: transparent;
  color: inherit;
  font-family: var(--q-mono);
  font-size: 13px;
  line-height: 1.7;
}
</style>
