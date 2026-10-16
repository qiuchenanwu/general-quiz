<script setup>
/**
 * ResultPanel —— 练习完成 / 交卷后的成绩单。
 */
import { computed } from 'vue'

const props = defineProps({
  stats: { type: Object, required: true },
  mode: { type: String, default: 'seq' },
  exam: { type: Boolean, default: false },
  autoSubmitted: { type: Boolean, default: false },
  usedSeconds: { type: Number, default: 0 },
  wrongCount: { type: Number, default: 0 },
  favCount: { type: Number, default: 0 },
  /** 「错题诊断」是否正在跑（按钮转圈） */
  aiBusy: { type: Boolean, default: false },
  /** AI 功能是否启用（开源版默认 false；启用才显示"错题诊断"按钮） */
  aiEnabled: { type: Boolean, default: false },
})

const emit = defineEmits([
  'retry',
  'review-wrong',
  'home',
  'review-all',
  'achievement',
  'ai-diagnose',
])

const R = 52
const C = 2 * Math.PI * R

const score = computed(() => props.stats?.score ?? 0)
const dash = computed(() => C * (1 - score.value / 100))

/** 及格线 60：决定成绩单的主色和文案 */
const tone = computed(() => (score.value >= 85 ? 'great' : score.value >= 60 ? 'ok' : 'bad'))

const headline = computed(() => {
  if (props.autoSubmitted) return '时间到，已自动交卷'
  if (props.exam) return '交卷完成'
  return '本次练习完成'
})

const subline = computed(() => {
  const s = props.stats
  if (!s) return ''
  if (tone.value === 'great') return '这套题你已经拿下了 👏'
  if (tone.value === 'ok') return '基本掌握，把错题再过一遍就稳了'
  return '错的有点多，建议先看错题解析再来一轮'
})

function fmt(sec) {
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  const r = s % 60
  return m ? `${m} 分 ${r} 秒` : `${r} 秒`
}

const TONE_TEXT = {
  great: '优秀',
  ok: '及格',
  bad: '需加强',
}
</script>

<template>
  <section class="q-res q-card q-pop">
    <!-- ─────────── 得分环 ─────────── -->
    <div class="q-res__ring" :class="`is-${tone}`">
      <svg viewBox="0 0 120 120">
        <circle class="q-res__ring-bg" cx="60" cy="60" :r="R" />
        <circle
          class="q-res__ring-fg"
          cx="60"
          cy="60"
          :r="R"
          :stroke-dasharray="C"
          :stroke-dashoffset="dash"
        />
      </svg>
      <div class="q-res__ring-in">
        <b class="q-num">{{ score }}</b>
        <em>分</em>
        <span class="q-res__tone">{{ TONE_TEXT[tone] }}</span>
      </div>
    </div>

    <!-- ─────────── 文案 ─────────── -->
    <div class="q-res__head">
      <h2>{{ headline }}</h2>
      <p>{{ subline }}</p>
    </div>

    <!-- ─────────── 明细 ─────────── -->
    <div class="q-res__grid">
      <div class="q-res__cell is-ok">
        <b class="q-num">{{ stats.ok }}</b>
        <span>答对</span>
      </div>
      <div class="q-res__cell is-bad">
        <b class="q-num">{{ stats.bad }}</b>
        <span>答错</span>
      </div>
      <div class="q-res__cell">
        <b class="q-num">{{ stats.total }}</b>
        <span>总题数</span>
      </div>
      <div class="q-res__cell">
        <b class="q-num">{{ stats.accuracy }}%</b>
        <span>正确率</span>
      </div>
      <div v-if="stats.unanswered" class="q-res__cell is-warn">
        <b class="q-num">{{ stats.unanswered }}</b>
        <span>未作答</span>
      </div>
      <div v-if="stats.peeked" class="q-res__cell is-warn">
        <b class="q-num">{{ stats.peeked }}</b>
        <span>看答案</span>
      </div>
      <div v-if="usedSeconds" class="q-res__cell">
        <b class="q-res__cell-time">{{ fmt(usedSeconds) }}</b>
        <span>用时</span>
      </div>
    </div>

    <!-- ─────────── 操作 ─────────── -->
    <div class="q-res__actions">
      <el-button v-if="wrongCount" type="danger" size="large" @click="emit('review-wrong')">
        <el-icon style="margin-right: 5px"><WarningFilled /></el-icon>
        立即重做 {{ wrongCount }} 道错题
      </el-button>
      <!-- 错题诊断：让模型看看"你错的是哪一类"，而不是又刷一遍（后端 /api/quiz/diagnose/） -->
      <el-button
        v-if="wrongCount && aiEnabled"
        size="large"
        :loading="aiBusy"
        @click="emit('ai-diagnose')"
      >
        <el-icon v-if="!aiBusy" style="margin-right: 5px"><MagicStick /></el-icon>
        {{ aiBusy ? '诊断中…' : 'AI 诊断这些错题' }}
      </el-button>
      <el-button size="large" @click="emit('review-all')">
        <el-icon style="margin-right: 5px"><View /></el-icon>
        逐题看解析
      </el-button>
      <el-button size="large" @click="emit('retry')">
        <el-icon style="margin-right: 5px"><Refresh /></el-icon>
        再来一轮
      </el-button>
      <!-- 成就页关掉之后还能从这儿重开（不然"看完了想给同学看一眼"就没辙了） -->
      <el-button size="large" text @click="emit('achievement')">
        <el-icon style="margin-right: 5px"><Trophy /></el-icon>
        看成就页
      </el-button>
      <el-button size="large" text @click="emit('home')">
        <el-icon style="margin-right: 5px"><HomeFilled /></el-icon>
        返回题库
      </el-button>
    </div>
  </section>
</template>

<style scoped>
.q-res {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 22px;
  padding: 38px 30px 30px;
  text-align: center;
}

/* ---------- 得分环 ---------- */
.q-res__ring {
  position: relative;
  width: 168px;
  height: 168px;
}
.q-res__ring svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}
.q-res__ring circle {
  fill: none;
  stroke-width: 9;
  stroke-linecap: round;
}
.q-res__ring-bg {
  stroke: var(--q-surface-3);
}
.q-res__ring-fg {
  stroke: var(--q-brand-1);
  transition: stroke-dashoffset 1s var(--q-ease);
}
.q-res__ring.is-great .q-res__ring-fg {
  stroke: var(--q-ok);
}
.q-res__ring.is-ok .q-res__ring-fg {
  stroke: var(--q-brand-1);
}
.q-res__ring.is-bad .q-res__ring-fg {
  stroke: var(--q-bad);
}

.q-res__ring-in {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
}
.q-res__ring-in b {
  font-size: 42px;
  font-weight: 850;
  line-height: 1;
  color: var(--q-text);
}
.q-res__ring-in em {
  font-style: normal;
  font-size: 12px;
  color: var(--q-text-3);
}
.q-res__tone {
  margin-top: 6px;
  padding: 2px 10px;
  border-radius: 99px;
  font-size: 11.5px;
  font-weight: 700;
  background: var(--q-surface-3);
  color: var(--q-text-2);
}
.q-res__ring.is-great .q-res__tone {
  background: var(--q-ok-bg);
  color: var(--q-ok);
}
.q-res__ring.is-bad .q-res__tone {
  background: var(--q-bad-bg);
  color: var(--q-bad);
}

/* ---------- 文案 ---------- */
.q-res__head h2 {
  font-size: 22px;
  font-weight: 800;
  color: var(--q-text);
}
.q-res__head p {
  margin-top: 7px;
  font-size: 13.5px;
  color: var(--q-text-2);
}

/* ---------- 明细 ---------- */
.q-res__grid {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
}
.q-res__cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 84px;
  padding: 12px 15px;
  border-radius: var(--q-r-sm);
  background: var(--q-surface-2);
  border: 1px solid var(--q-border);
}
.q-res__cell b {
  font-size: 20px;
  font-weight: 800;
  color: var(--q-text);
  line-height: 1.2;
}
.q-res__cell-time {
  font-size: 15px !important;
}
.q-res__cell span {
  font-size: 11.5px;
  color: var(--q-text-3);
}
.q-res__cell.is-ok b {
  color: var(--q-ok);
}
.q-res__cell.is-bad b {
  color: var(--q-bad);
}
.q-res__cell.is-warn b {
  color: var(--q-warn);
}

/* ---------- 操作 ---------- */
.q-res__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  padding-top: 6px;
}

@media (max-width: 600px) {
  .q-res {
    padding: 26px 16px 22px;
  }
  .q-res__actions :deep(.el-button) {
    flex: 1 1 calc(50% - 10px);
  }
}
</style>
