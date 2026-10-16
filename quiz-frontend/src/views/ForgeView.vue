<template>
  <section class="q-wrap fg">
    <header class="fg__head">
      <h2 class="fg__title">演武场</h2>
      <p class="fg__sub">
        随手粘一段代码就能跑：<b>Java</b> 走服务器真编译真运行（片段会自动补一个类壳），
        <b>JS / Vue</b> 片段在浏览器沙箱里跑（沙箱里装了迷你 Vue，教材里的
        <code>ref</code> / <code>computed</code> 示例也能跑）。
        校对台上改扫描件的代码时，每个代码块下面也有一个「运行」，改完立刻能试。
      </p>
      <p class="fg__sub">
        跑出结果、自己觉得行了，就在下面写一句「我想做什么」再点「让 AI 检查」——
        它会告诉你哪里对、哪里不对、下一步补什么。
      </p>
    </header>

    <div class="fg__bar">
      <span class="fg__label">语言</span>
      <div class="q-seg">
        <button
          v-for="l in LANGS"
          :key="l.value"
          class="q-seg__item"
          :class="{ 'is-active': lang === l.value }"
          @click="lang = l.value"
        >
          {{ l.label }}
        </button>
      </div>
      <span class="fg__grow" />
      <button class="fg__clear" @click="code = ''">清空</button>
    </div>

    <CodeEditor
      v-model="code"
      class="fg__editor"
      :lang="editorLang"
      :words="words"
      :theme="quiz.settings.codeTheme"
    />

    <SnippetRunner class="fg__runner" :code="code" :lang="editorLang" @ran="onRan" />

    <AiReview
      v-model:goal="goal"
      :code="code"
      :lang="editorLang"
      :last-run="lastRun"
    />

    <p class="fg__foot">
      草稿只存在<b>这台浏览器</b>里（刷新/下次打开还在，换设备不会同步）。
      Java 那条路要用服务器，需要授权；没授权时它只会说「当前不可用」。
    </p>
  </section>
</template>

<script setup>
/**
 * ForgeView.vue —— **演武场**：随手粘一段代码就能跑
 * ============================================================================
 * 站主原话：「我只需要给扫描件，就有了自己的演武场」。
 * 这一页是那句里的"演武场"最直白的形态：不挑题库、不挑题型，粘进去就跑。
 *
 * 它和校对台里的「运行」共用同一个执行器（components/SnippetRunner.vue），
 * 所以两条路的行为一定一致 —— 不要在这里另写一份运行逻辑。
 *
 * 任务回路在这页上是完整的一小段：**写 → 运行看到真实结果 → 让 AI 检查**。
 * 「我想做什么」和「让 AI 检查」都在下面的 AiReview.vue 里；
 * 这一页只负责把当前代码和**上一次运行的结果**递过去（@ran）。
 */
import { computed, ref, watch } from 'vue'

import { K, load, save } from '@/core/storage'
import { completionWords } from '@/core/editor'
import { useQuizStore } from '@/stores/quiz'
import CodeEditor from '@/components/CodeEditor.vue'
import SnippetRunner from '@/components/SnippetRunner.vue'
import AiReview from '@/components/AiReview.vue'

const quiz = useQuizStore()

const LANGS = [
  { value: 'auto', label: '自动' },
  { value: 'java', label: 'Java' },
  { value: 'js', label: 'JS / Vue' },
]

/** 第一次进来给一段能跑的小例子：空编辑器里没有"运行"可点的东西，人会不知道这页干嘛的 */
const SEED = `// 随手写点 JS / Vue，再点下面的「运行」
const count = ref(0)
count.value++
console.log('count =', count.value)
`

const draft = load(K.forge, null) || {}
const code = ref(typeof draft.code === 'string' ? draft.code : SEED)
const lang = ref(LANGS.some((l) => l.value === draft.lang) ? draft.lang : 'auto')
/** 「我想做什么」：可选，但不落盘的话刷新就没了 —— 学生多半是分几次做完的 */
const goal = ref(typeof draft.goal === 'string' ? draft.goal : '')
/** 上一次运行他看到的东西：{text, ok}；「让 AI 检查」会把它一起发给后端 */
const lastRun = ref(null)

/** 编辑器/执行器要的是具体语言；'auto' 交给它们自己猜（core/editor.js 的 guessLang） */
const editorLang = computed(() => (lang.value === 'auto' ? '' : lang.value))
const words = computed(() => completionWords(code.value, lang.value === 'java' ? 'java' : 'js'))

function onRan(info) {
  lastRun.value = { text: String(info?.text || ''), ok: !!info?.ok }
}

// 代码一改，上一次的运行结果就不再是"这段代码的结果"了 —— 直接丢掉，
// 免得把上一版的输出当证据发给 AI（那会得到一段看着很对、其实对不上号的批改）。
watch(code, () => {
  lastRun.value = null
})

watch([code, lang, goal], () => save(K.forge, { code: code.value, lang: lang.value, goal: goal.value }))
</script>

<style scoped>
.fg {
  padding: 18px 0 40px;
}
.fg__title {
  margin: 0 0 6px;
  font-size: 20px;
}
.fg__sub {
  margin: 0 0 14px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--q-text-2);
}
/* 第二段是「让 AI 检查」那一句：和上一段贴紧一点，别看成两块不相干的说明 */
.fg__sub + .fg__sub {
  margin-top: -8px;
}
.fg__sub code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--q-surface-3);
  color: var(--q-brand-1);
  font-family: var(--q-mono);
  font-size: 0.92em;
}
.fg__bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.fg__label {
  font-size: 12px;
  color: var(--q-text-3);
}
.fg__grow {
  flex: 1;
}
.fg__clear {
  border: 1px solid var(--q-border);
  background: transparent;
  color: var(--q-text-2);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}
.fg__editor {
  margin-bottom: 10px;
}
.fg__foot {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--q-text-3);
}
</style>
