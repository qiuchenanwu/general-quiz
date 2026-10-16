<script setup>
/**
 * AnswerSheet —— 答题卡。右侧常驻（移动端进抽屉），点题号直接跳题。
 * 支持按「未做 / 错题」过滤，224 题的长卷子里很好用。
 */
import { computed, ref } from 'vue'

const props = defineProps({
  questions: { type: Array, default: () => [] }, // 按队列顺序的题目对象
  picks: { type: Object, default: () => ({}) },
  results: { type: Object, default: () => ({}) }, // qid -> true/false（未判定则无键）
  peeks: { type: Object, default: () => ({}) }, // 背题模式偷看过答案
  notes: { type: Object, default: () => ({}) }, // qid -> { text }：有笔记的题号上打个点
  index: { type: Number, default: 0 },
  /** 是否已经交卷：交卷后即便没揭示也按对错显示 */
  submitted: { type: Boolean, default: false },
  title: { type: String, default: '答题卡' },
})

const emit = defineEmits(['goto'])

const filter = ref('all') // all | todo | wrong

function stateOf(q) {
  const id = q.id
  const judged = props.results?.[id]
  if (judged === true) return 'ok'
  if (judged === false) return 'bad'
  if (props.peeks?.[id]) return 'peek'
  if ((props.picks[id] || []).length) return 'picked'
  return 'idle'
}

const cells = computed(() =>
  props.questions.map((q, i) => ({
    id: q.id,
    no: q.no,
    type: q.type,
    i,
    state: stateOf(q),
    hasNote: !!props.notes?.[q.id]?.text,
  })),
)

const noteStat = computed(() => cells.value.filter((c) => c.hasNote).length)

const filtered = computed(() => {
  if (filter.value === 'todo')
    return cells.value.filter((c) => c.state === 'idle' || c.state === 'picked' || c.state === 'peek')
  if (filter.value === 'wrong') return cells.value.filter((c) => c.state === 'bad')
  return cells.value
})

const stat = computed(() => {
  let ok = 0
  let bad = 0
  let picked = 0
  let peek = 0
  cells.value.forEach((c) => {
    if (c.state === 'ok') ok++
    else if (c.state === 'bad') bad++
    else if (c.state === 'picked') picked++
    else if (c.state === 'peek') peek++
  })
  const total = cells.value.length
  const done = ok + bad + picked + peek
  return { total, ok, bad, picked, peek, idle: total - done, done, pct: total ? Math.round((done / total) * 100) : 0 }
})

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'todo', label: '未做' },
  { key: 'wrong', label: '错题' },
]
</script>

<template>
  <aside class="q-sheet q-card">
    <header class="q-sheet__head">
      <h3 class="q-sheet__title">{{ title }}</h3>
      <span class="q-sheet__count q-num">{{ stat.done }}/{{ stat.total }}</span>
    </header>

    <!-- 进度条 -->
    <div class="q-sheet__bar">
      <div class="q-sheet__bar-ok" :style="{ width: stat.total ? (stat.ok / stat.total) * 100 + '%' : '0' }"></div>
      <div class="q-sheet__bar-bad" :style="{ width: stat.total ? (stat.bad / stat.total) * 100 + '%' : '0' }"></div>
      <div
        class="q-sheet__bar-picked"
        :style="{ width: stat.total ? (stat.picked / stat.total) * 100 + '%' : '0' }"
      ></div>
    </div>

    <!-- 筛选 -->
    <div class="q-sheet__filters">
      <button
        v-for="f in FILTERS"
        :key="f.key"
        class="q-sheet__filter"
        :class="{ 'is-active': filter === f.key }"
        @click="filter = f.key"
      >
        {{ f.label }}
        <em v-if="f.key === 'wrong' && stat.bad">{{ stat.bad }}</em>
        <em v-else-if="f.key === 'todo' && stat.total - stat.done">{{ stat.total - stat.done }}</em>
      </button>
    </div>

    <!-- 题号网格 -->
    <div class="q-sheet__grid">
      <button
        v-for="c in filtered"
        :key="c.id"
        class="q-sheet__cell q-num"
        :class="[`is-${c.state}`, { 'is-current': c.i === index, 'is-3d': c.no >= 100 }]"
        :title="`第 ${c.no} 题${c.hasNote ? ' · 有笔记' : ''}`"
        @click="emit('goto', c.i)"
      >
        {{ c.no }}
        <i v-if="c.hasNote" class="q-sheet__dot"></i>
      </button>
      <p v-if="!filtered.length" class="q-sheet__empty q-dim">
        {{ filter === 'wrong' ? '还没有错题，继续保持 🎉' : '全部做完了 🎉' }}
      </p>
    </div>

    <!-- 图例 -->
    <footer class="q-sheet__legend">
      <span><i class="is-idle"></i>未做 {{ stat.idle }}</span>
      <span><i class="is-picked"></i>已选 {{ stat.picked }}</span>
      <span><i class="is-ok"></i>正确 {{ stat.ok }}</span>
      <span><i class="is-bad"></i>错误 {{ stat.bad }}</span>
      <span v-if="stat.peek"><i class="is-peek"></i>看答案 {{ stat.peek }}</span>
      <span v-if="noteStat"><i class="is-note"></i>有笔记 {{ noteStat }}</span>
    </footer>
  </aside>
</template>

<style scoped>
.q-sheet {
  display: flex;
  flex-direction: column;
  padding: 16px;
  gap: 13px;
}
.q-sheet__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.q-sheet__title {
  font-size: 14px;
  font-weight: 700;
  color: var(--q-text);
}
.q-sheet__count {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--q-text-3);
}

/* 三段式进度条 */
.q-sheet__bar {
  display: flex;
  height: 6px;
  border-radius: 99px;
  overflow: hidden;
  background: var(--q-surface-3);
}
.q-sheet__bar-ok {
  background: var(--q-ok);
  transition: width 0.4s var(--q-ease);
}
.q-sheet__bar-bad {
  background: var(--q-bad);
  transition: width 0.4s var(--q-ease);
}
.q-sheet__bar-picked {
  background: var(--q-brand-1);
  transition: width 0.4s var(--q-ease);
}

/* 筛选 */
.q-sheet__filters {
  display: flex;
  gap: 5px;
  padding: 4px;
  background: var(--q-surface-3);
  border-radius: 10px;
}
.q-sheet__filter {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 6px 4px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  font: 600 12.5px var(--q-font);
  color: var(--q-text-2);
  cursor: pointer;
  transition: all var(--q-dur) var(--q-ease);
}
.q-sheet__filter em {
  font-style: normal;
  font-size: 11px;
  opacity: 0.75;
}
.q-sheet__filter:hover {
  color: var(--q-text);
}
.q-sheet__filter.is-active {
  background: var(--q-surface);
  color: var(--q-brand-1);
  box-shadow: var(--q-shadow-sm);
}
html.dark .q-sheet__filter.is-active {
  color: #a5b0ff;
}

/* 网格 */
.q-sheet__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(38px, 1fr));
  gap: 6px;
  max-height: min(46vh, 420px);
  /* ⚠️ 不许横向溢出：这一格是"题号"，题库到 409 题时是 3 位数，
     窄侧栏 + 负外边距会让最右一列被裁掉（用户报过：框框超出显示区被截断） */
  overflow-y: auto;
  overflow-x: hidden;
  padding: 3px 0;
  margin: 0;
  min-width: 0;
}
.q-sheet__cell {
  position: relative;
  aspect-ratio: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  border: 1.5px solid transparent;
  background: var(--q-surface-3);
  font-size: 12px;
  font-weight: 700;
  color: var(--q-text-3);
  cursor: pointer;
  /* 题号是数字：等宽数字 + 不换行，位数多了也别裁 */
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.2px;
  overflow: hidden;
  transition: all 0.18s var(--q-ease);
}
/* 三位数（题库超过 100 题）再压一点字号，保证 4 位数也放得下 */
.q-sheet__cell.is-3d {
  font-size: 11px;
  letter-spacing: -0.4px;
}
.q-sheet__cell:hover {
  transform: translateY(-1px);
  border-color: var(--q-border-strong);
}
.q-sheet__cell.is-picked {
  background: color-mix(in srgb, var(--q-brand-1) 16%, transparent);
  color: var(--q-brand-1);
  border-color: color-mix(in srgb, var(--q-brand-1) 45%, transparent);
}
html.dark .q-sheet__cell.is-picked {
  color: #a5b0ff;
}
.q-sheet__cell.is-peek {
  background: transparent;
  color: var(--q-brand-2);
  border-color: color-mix(in srgb, var(--q-brand-2) 45%, transparent);
  border-style: dashed;
}
.q-sheet__cell.is-ok {
  background: var(--q-ok-bg);
  color: var(--q-ok);
  border-color: color-mix(in srgb, var(--q-ok) 40%, transparent);
}
.q-sheet__cell.is-bad {
  background: var(--q-bad-bg);
  color: var(--q-bad);
  border-color: color-mix(in srgb, var(--q-bad) 45%, transparent);
}
.q-sheet__cell.is-current {
  box-shadow: 0 0 0 2px var(--q-surface), 0 0 0 4px var(--q-brand-1);
  transform: translateY(-1px);
  z-index: 1;
}
/* 有笔记的题号：右上角一个小点，不抢主色 */
.q-sheet__dot {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--q-brand-2);
}
.q-sheet__empty {
  grid-column: 1 / -1;
  padding: 22px 0;
  text-align: center;
  font-size: 12.5px;
}

/* 图例 */
.q-sheet__legend {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px 10px;
  padding-top: 11px;
  border-top: 1px solid var(--q-border);
  font-size: 11.5px;
  color: var(--q-text-3);
}
.q-sheet__legend span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.q-sheet__legend i {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex: 0 0 auto;
}
.q-sheet__legend i.is-idle {
  background: var(--q-surface-3);
  border: 1px solid var(--q-border-strong);
}
.q-sheet__legend i.is-picked {
  background: color-mix(in srgb, var(--q-brand-1) 45%, transparent);
}
.q-sheet__legend i.is-ok {
  background: var(--q-ok);
}
.q-sheet__legend i.is-bad {
  background: var(--q-bad);
}
.q-sheet__legend i.is-peek {
  border: 1.5px dashed var(--q-brand-2);
}
.q-sheet__legend i.is-note {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--q-brand-2);
  margin: 0 2px;
}
</style>
