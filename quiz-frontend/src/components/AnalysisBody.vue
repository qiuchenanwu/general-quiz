<script setup>
/**
 * AnalysisBody —— 解析正文的唯一渲染入口（题目卡片 / 复习本都用它）。
 *
 * 为什么单独抽一个组件：解析在**两个地方**显示（做完题看到的解析、错题本里展开的解析），
 * 两处必须长得一样。一个判据一处实现（坑 58 / 110）—— 上一轮就是"题干会格式化、
 * 解析裸显示 ** 和 ```"，根因是两条路各写各的。
 *
 * ⚠️ 刻意**不用 v-html**：解析可能来自用户手写或模型生成，走 innerHTML 就等于开门。
 *    这里拿的是 core/text.js 的 analysisSegs() 给的片段数组，由 Vue 负责转义文本；
 *    行内标记（`代码` / **强调**）与题干共用同一份 inlineSegs()。
 */
import { computed } from 'vue'
import { analysisSegs } from '@/core/text'

const props = defineProps({
  /** 解析原文（可以是题库自带的、AI 补的、或用户手写的） */
  text: { type: String, default: '' },
})

const segs = computed(() => analysisSegs(props.text))
</script>

<template>
  <div class="q-ab">
    <template v-for="(seg, i) in segs" :key="i">
      <!-- ``` 围栏：整段代码，深色面板摆出来 -->
      <pre v-if="seg.type === 'pre'" class="q-ab__pre"><code>{{ seg.text }}</code></pre>
      <a
        v-else-if="seg.type === 'link'"
        class="q-ab__link"
        :href="seg.href"
        target="_blank"
        rel="noopener noreferrer"
        >{{ seg.text }}</a
      ><code v-else-if="seg.type === 'code'" class="q-code">{{ seg.text }}</code
      ><strong v-else-if="seg.type === 'strong'">{{ seg.text }}</strong
      ><template v-else>{{ seg.text }}</template>
    </template>
  </div>
</template>

<style scoped>
.q-ab {
  font-size: 14px;
  line-height: 1.78;
  color: var(--q-text-2);
  /* 解析里的换行是作者写的，保留（和以前一样） */
  white-space: pre-wrap;
  word-break: break-word;
}
/* 强调：把 **x** 里的 x 提出来，别让它和正文一个灰度 */
.q-ab strong {
  color: var(--q-text);
  font-weight: 700;
}
/* 解析里的网址（比如那行"出处：… <原文地址>"）做成可点链接 */
.q-ab__link {
  color: var(--q-brand-1);
  text-decoration: none;
  word-break: break-all;
}
.q-ab__link:hover {
  text-decoration: underline;
}
/* ``` 围栏：和代码面板同一套深色（浅色主题下也用深色，一眼认得这是代码） */
.q-ab__pre {
  margin: 9px 0;
  padding: 11px 13px;
  border-radius: var(--q-r-sm);
  background: var(--q-code-bg);
  color: var(--q-code-text);
  font-family: var(--q-mono);
  font-size: 12.5px;
  line-height: 1.72;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
}
.q-ab__pre code {
  font-family: inherit;
  font-size: inherit;
  color: inherit;
  background: none;
  padding: 0;
}
</style>
