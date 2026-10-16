<script setup>
/**
 * ReportView —— 学习报告。
 *
 * 图表全部是**手写内联 SVG**，没有引入图表库：
 *   热力图 = 一堆 rect，趋势图 = 一条 polyline + 一排 rect。
 *   为这点图形引一个 ECharts（~1MB）不值当，而且那样就没法精确控制暗色主题。
 *
 * 所有统计都来自 core/analytics.js 的纯函数（那边有 70 多项单元测试），
 * 这个文件只负责「把算好的数字画出来」。
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useBankStore } from '@/stores/bank'
import { useQuizStore } from '@/stores/quiz'
import { humanDuration } from '@/core/analytics'
import { TYPE_LABEL } from '@/core/normalize'

const bank = useBankStore()
const quiz = useQuizStore()
const router = useRouter()

const report = computed(() => quiz.report)

/** 热力图色阶：0 格用底色，1~4 级用品牌色由浅到深 */
function levelOf(n, max) {
  if (!n) return 0
  if (!max) return 1
  return Math.min(4, Math.max(1, Math.ceil((n / max) * 4)))
}

/* ---------------- 热力图几何 ---------------- */
const CELL = 11
const GAP = 3
const heat = computed(() => {
  const data = report.value.heatmap
  const step = CELL + GAP
  const width = data.columns.length * step
  const height = 7 * step

  const cells = []
  data.columns.forEach((column, ci) => {
    column.forEach((day, di) => {
      cells.push({
        ...day,
        x: ci * step,
        y: di * step,
        level: day.future ? -1 : levelOf(day.n, data.max),
      })
    })
  })

  // 月份标签：某一列的周一进了新月份，就在这列上方写月份
  const monthLabels = []
  let lastMonth = -1
  data.columns.forEach((column, ci) => {
    const d = new Date(column[0].ts)
    if (d.getMonth() !== lastMonth) {
      lastMonth = d.getMonth()
      monthLabels.push({ x: ci * step, text: `${d.getMonth() + 1}月` })
    }
  })

  return { cells, monthLabels, width, height, max: data.max }
})

/* ---------------- 趋势图几何 ---------------- */
const TREND_W = 600
const TREND_H = 150
const trend = computed(() => {
  const days = report.value.trend
  const n = days.length || 1
  const stepX = TREND_W / n
  const top = 12
  const lineBottom = 84 // 正确率折线的底
  const barTop = 92 // 柱状区顶端
  const barBottom = 132

  const maxN = Math.max(1, ...days.map((d) => d.n))

  const dots = []
  const bars = []
  days.forEach((day, i) => {
    const cx = i * stepX + stepX / 2
    if (day.accuracy !== null) {
      dots.push({ x: cx, y: lineBottom - (day.accuracy / 100) * (lineBottom - top), day })
    }
    if (day.n > 0) {
      const h = Math.max(2, (day.n / maxN) * (barBottom - barTop))
      bars.push({ x: cx - Math.min(7, stepX * 0.34), y: barBottom - h, w: Math.min(14, stepX * 0.68), h, day })
    }
  })

  // x 轴只标 4 个日期，免得挤成一团
  const ticks = []
  for (let i = 0; i < 4; i++) {
    const index = Math.round((i * (n - 1)) / 3)
    const day = days[index]
    if (day) ticks.push({ x: index * stepX + stepX / 2, text: day.key.slice(5), anchor: i === 0 ? 'start' : i === 3 ? 'end' : 'middle' })
  }

  return {
    // 折线至少要有两个点才画得出来。**只有一个点的话点也要画** ——
    // 不然「今天刚做了几道题」会看到一片空白，像功能坏了。
    dots,
    points: dots.map((d) => `${d.x.toFixed(1)},${d.y.toFixed(1)}`).join(' '),
    bars,
    ticks,
    hasLine: dots.length >= 2,
    activeDays: dots.length,
    ref60: lineBottom - 0.6 * (lineBottom - top),
    lineBottom,
    barBottom,
    barTop,
  }
})

const typeRows = computed(() =>
  report.value.types.map((t) => ({ ...t, label: TYPE_LABEL[t.type] || t.type })),
)

/** 最慢的几道题：把题干也带上，不然只看到一个题号没法复习 */
const slowest = computed(() =>
  report.value.timing.slowest.map((row) => {
    const q = bank.byId.get(row.q)
    return { ...row, no: q?.no, stem: q?.stem || '（这道题不在当前题库里）' }
  }),
)

const weakTags = computed(() => report.value.tags.slice(0, 8))

function fmtMs(ms) {
  if (!ms) return '—'
  return ms < 1000 ? `${ms} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`
}
</script>

<template>
  <div class="q-wrap q-rp">
    <header class="q-rp__head">
      <div>
        <h1 class="q-rp__title">学习报告</h1>
        <p class="q-rp__sub q-dim">
          <template v-if="bank.meta">《{{ bank.meta.title }}》· </template>
          数据只来自这台浏览器里的作答记录，不上传任何服务器。
        </p>
      </div>
      <el-button text @click="router.push('/')">
        <el-icon style="margin-right: 4px"><HomeFilled /></el-icon>回题库
      </el-button>
    </header>

    <!-- 还没做过题 -->
    <section v-if="!quiz.hasHistory" class="q-card q-rp__empty q-pop">
      <span class="q-rp__empty-icon"><el-icon :size="32"><DataLine /></el-icon></span>
      <h2>还没有作答记录</h2>
      <p class="q-dim">做过几道题之后，这里会显示打卡热力图、正确率趋势和知识点弱项。</p>
      <el-button type="primary" size="large" @click="router.push('/')">去刷几道题</el-button>
    </section>

    <template v-else>
      <!-- ─────────── 总览 ─────────── -->
      <section class="q-rp__stats">
        <div class="q-rp__stat">
          <b class="q-num">{{ report.total }}</b><span>累计作答</span>
        </div>
        <div class="q-rp__stat">
          <b class="q-num" :class="report.accuracy >= 80 ? 'is-ok' : report.accuracy >= 60 ? '' : 'is-bad'">
            {{ report.accuracy }}%
          </b><span>总正确率</span>
        </div>
        <div class="q-rp__stat">
          <b class="q-num is-brand">{{ report.streak }}</b><span>连续打卡（天）</span>
        </div>
        <div class="q-rp__stat">
          <b class="q-num">{{ report.longestStreak }}</b><span>最长连对</span>
        </div>
        <div class="q-rp__stat">
          <b class="q-num">{{ report.activeDays }}</b><span>学习天数</span>
        </div>
        <div class="q-rp__stat">
          <b class="q-num q-rp__dur">{{ humanDuration(report.totalMs) }}</b><span>累计用时</span>
        </div>
      </section>

      <!-- ─────────── 打卡热力图 ─────────── -->
      <section class="q-card q-rp__card">
        <header class="q-rp__card-head">
          <h2><el-icon :size="15"><Calendar /></el-icon>打卡热力图</h2>
          <span class="q-dim">最近 {{ report.heatmap.columns.length }} 周 · 最多的一天 {{ heat.max }} 题</span>
        </header>

        <div class="q-rp__heat-wrap">
          <svg
            class="q-rp__heat"
            :viewBox="`0 -16 ${heat.width} ${heat.height + 16}`"
            :style="{ minWidth: heat.width + 'px' }"
          >
            <text v-for="m in heat.monthLabels" :key="m.x" :x="m.x" y="-5" class="q-rp__heat-month">
              {{ m.text }}
            </text>
            <rect
              v-for="c in heat.cells"
              :key="c.key"
              :x="c.x"
              :y="c.y"
              :width="CELL"
              :height="CELL"
              rx="2.5"
              :class="c.level < 0 ? 'q-rp__cell-future' : `q-rp__cell-${c.level}`"
            >
              <title>{{ c.key }} · {{ c.future ? '还没到' : `${c.n} 题` }}</title>
            </rect>
          </svg>
        </div>

        <footer class="q-rp__legend">
          <span class="q-dim">少</span>
          <i class="q-rp__cell-0"></i><i class="q-rp__cell-1"></i><i class="q-rp__cell-2"></i>
          <i class="q-rp__cell-3"></i><i class="q-rp__cell-4"></i>
          <span class="q-dim">多</span>
        </footer>
      </section>

      <!-- ─────────── 正确率趋势 ─────────── -->
      <section class="q-card q-rp__card">
        <header class="q-rp__card-head">
          <h2><el-icon :size="15"><TrendCharts /></el-icon>最近 30 天</h2>
          <span class="q-rp__key">
            <i class="q-rp__key-line"></i>正确率
            <i class="q-rp__key-bar"></i>题量
          </span>
        </header>

        <svg class="q-rp__trend" :viewBox="`0 0 ${TREND_W} ${TREND_H}`" preserveAspectRatio="none">
          <!-- 60% 参考线：及格感 -->
          <line :x1="0" :x2="TREND_W" :y1="trend.ref60" :y2="trend.ref60" class="q-rp__ref" />
          <text :x="4" :y="trend.ref60 - 4" class="q-rp__ref-text">60%</text>

          <rect
            v-for="b in trend.bars"
            :key="b.day.key"
            :x="b.x"
            :y="b.y"
            :width="b.w"
            :height="b.h"
            rx="1.5"
            class="q-rp__bar"
          >
            <title>{{ b.day.key }} · {{ b.day.n }} 题 · 正确率 {{ b.day.accuracy }}%</title>
          </rect>

          <polyline v-if="trend.hasLine" :points="trend.points" class="q-rp__line" />
          <circle
            v-for="d in trend.dots"
            :key="d.day.key"
            :cx="d.x"
            :cy="d.y"
            r="3"
            class="q-rp__dot"
          >
            <title>{{ d.day.key }} · 正确率 {{ d.day.accuracy }}%（{{ d.day.n }} 题）</title>
          </circle>

          <line :x1="0" :x2="TREND_W" :y1="trend.barBottom" :y2="trend.barBottom" class="q-rp__axis" />
          <text
            v-for="t in trend.ticks"
            :key="t.text"
            :x="t.x"
            :y="TREND_H - 3"
            :text-anchor="t.anchor"
            class="q-rp__tick"
          >
            {{ t.text }}
          </text>
        </svg>
        <p class="q-rp__hint q-dim">
          <template v-if="trend.activeDays < 2">
            目前只有 <b>{{ trend.activeDays }}</b> 天有作答记录，所以画不出趋势线（先画成点）——
            再坚持几天就能看到走势了。
          </template>
          <template v-else>
            折线只连「有做题的日子」—— 空白天不画点，否则会把没学习画成 0%。
          </template>
        </p>
      </section>

      <div class="q-rp__grid">
        <!-- ─────────── 知识点弱项 ─────────── -->
        <section class="q-card q-rp__card">
          <header class="q-rp__card-head">
            <h2><el-icon :size="15"><WarningFilled /></el-icon>知识点弱项</h2>
            <span class="q-dim">按正确率从低到高</span>
          </header>

          <p v-if="!weakTags.length" class="q-rp__hint q-dim">
            每个知识点至少做过 3 道题才会出现在这里 —— 只做 1 道就判「弱项」没有意义。
          </p>
          <ul v-else class="q-rp__ranks">
            <li v-for="t in weakTags" :key="t.name">
              <span class="q-rp__rank-name">{{ t.name }}</span>
              <span class="q-rp__rank-bar">
                <i
                  :style="{ width: t.accuracy + '%' }"
                  :class="t.accuracy >= 80 ? 'is-ok' : t.accuracy >= 60 ? 'is-warn' : 'is-bad'"
                ></i>
              </span>
              <span class="q-rp__rank-val q-num" :class="t.accuracy >= 80 ? 'is-ok' : t.accuracy >= 60 ? 'is-warn' : 'is-bad'">
                {{ t.accuracy }}%
              </span>
              <span class="q-rp__rank-n q-num q-dim">{{ t.ok }}/{{ t.n }}</span>
            </li>
          </ul>
        </section>

        <!-- ─────────── 题型 ─────────── -->
        <section class="q-card q-rp__card">
          <header class="q-rp__card-head">
            <h2><el-icon :size="15"><Histogram /></el-icon>题型</h2>
          </header>
          <ul class="q-rp__types">
            <li v-for="t in typeRows" :key="t.type">
              <span class="q-chip" :class="t.type === 'multiple' ? 'q-chip--warn' : 'q-chip--brand'">
                {{ t.label }}
              </span>
              <span class="q-rp__type-bar">
                <i :style="{ width: t.accuracy + '%' }" :class="t.accuracy >= 60 ? 'is-ok' : 'is-bad'"></i>
              </span>
              <b class="q-num">{{ t.accuracy }}%</b>
              <span class="q-dim q-num">{{ t.ok }}/{{ t.n }}</span>
            </li>
          </ul>

          <header class="q-rp__card-head q-rp__card-head--mt">
            <h2><el-icon :size="15"><Timer /></el-icon>每题耗时</h2>
          </header>
          <div class="q-rp__timing">
            <div><b class="q-num">{{ fmtMs(report.timing.medianMs) }}</b><span>中位数</span></div>
            <div><b class="q-num">{{ fmtMs(report.timing.meanMs) }}</b><span>平均</span></div>
            <div><b class="q-num">{{ report.timing.samples }}</b><span>有效样本</span></div>
          </div>
          <p class="q-rp__hint q-dim">
            用<b>中位数</b>而不是平均数：只要有一道题中途去接了杯水，平均数就被拉飞了。
            超过 10 分钟的作答按「走开了」处理，不计入耗时。
          </p>
        </section>
      </div>

      <!-- ─────────── 最慢的题 ─────────── -->
      <section v-if="slowest.length" class="q-card q-rp__card">
        <header class="q-rp__card-head">
          <h2><el-icon :size="15"><Clock /></el-icon>想得最久的几道题</h2>
          <span class="q-dim">慢通常等于不熟，值得再看一遍</span>
        </header>
        <ul class="q-rp__slow">
          <li v-for="s in slowest" :key="s.q">
            <span class="q-chip" :class="s.ok ? 'q-chip--ok' : 'q-chip--bad'">{{ s.ok ? '答对' : '答错' }}</span>
            <span class="q-rp__slow-no q-num q-dim" v-if="s.no">#{{ s.no }}</span>
            <span class="q-rp__slow-stem">{{ s.stem }}</span>
            <b class="q-num q-rp__slow-ms">{{ fmtMs(s.ms) }}</b>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.q-rp {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.q-rp__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}
.q-rp__title {
  font-size: 26px;
  font-weight: 850;
  letter-spacing: -0.01em;
  color: var(--q-text);
}
.q-rp__sub {
  margin-top: 6px;
  font-size: 13px;
}

/* 空态 */
.q-rp__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 11px;
  padding: 56px 24px;
  text-align: center;
}
.q-rp__empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 66px;
  height: 66px;
  border-radius: 20px;
  background: var(--q-surface-3);
  color: var(--q-text-3);
}
.q-rp__empty h2 {
  font-size: 18px;
  font-weight: 800;
}

/* 总览 */
.q-rp__stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));
  gap: 10px;
}
.q-rp__stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 14px 10px;
  border-radius: var(--q-r-sm);
  background: var(--q-surface);
  border: 1px solid var(--q-border);
  box-shadow: var(--q-shadow-sm);
}
.q-rp__stat b {
  font-size: 22px;
  font-weight: 850;
  line-height: 1.1;
  color: var(--q-text);
}
.q-rp__dur {
  font-size: 15px !important;
}
.q-rp__stat span {
  font-size: 11.5px;
  color: var(--q-text-3);
}
.is-ok {
  color: var(--q-ok) !important;
}
.is-bad {
  color: var(--q-bad) !important;
}
.is-warn {
  color: var(--q-warn) !important;
}
.is-brand {
  color: var(--q-brand-1) !important;
}

/* 卡片 */
.q-rp__card {
  display: flex;
  flex-direction: column;
  gap: 13px;
  padding: 16px 18px;
}
.q-rp__card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.q-rp__card-head--mt {
  margin-top: 6px;
}
.q-rp__card-head h2 {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 15px;
  font-weight: 800;
  color: var(--q-text);
}
.q-rp__card-head span {
  font-size: 12px;
}
.q-rp__hint {
  font-size: 11.5px;
  line-height: 1.7;
}
.q-rp__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 16px;
  align-items: start;
}

/* ───────── 热力图 ───────── */
.q-rp__heat-wrap {
  overflow-x: auto;
  padding-bottom: 4px;
}
.q-rp__heat {
  display: block;
  width: 100%;
  height: auto;
  max-height: 140px;
}
.q-rp__heat-month {
  font-size: 8px;
  fill: var(--q-text-3);
}
.q-rp__cell-0 {
  fill: var(--q-surface-3);
  background: var(--q-surface-3);
}
.q-rp__cell-1 {
  fill: color-mix(in srgb, var(--q-brand-1) 26%, var(--q-surface-3));
  background: color-mix(in srgb, var(--q-brand-1) 26%, var(--q-surface-3));
}
.q-rp__cell-2 {
  fill: color-mix(in srgb, var(--q-brand-1) 50%, var(--q-surface-3));
  background: color-mix(in srgb, var(--q-brand-1) 50%, var(--q-surface-3));
}
.q-rp__cell-3 {
  fill: color-mix(in srgb, var(--q-brand-1) 76%, var(--q-surface-3));
  background: color-mix(in srgb, var(--q-brand-1) 76%, var(--q-surface-3));
}
.q-rp__cell-4 {
  fill: var(--q-brand-1);
  background: var(--q-brand-1);
}
.q-rp__cell-future {
  fill: transparent;
  stroke: var(--q-border);
  stroke-width: 0.6;
}
.q-rp__legend {
  display: flex;
  align-items: center;
  gap: 4px;
  justify-content: flex-end;
  font-size: 11px;
}
.q-rp__legend i {
  width: 11px;
  height: 11px;
  border-radius: 2.5px;
  display: inline-block;
}

/* ───────── 趋势图 ───────── */
.q-rp__trend {
  display: block;
  width: 100%;
  height: 150px;
}
.q-rp__ref {
  stroke: var(--q-border-strong);
  stroke-width: 1;
  stroke-dasharray: 4 4;
}
.q-rp__ref-text {
  font-size: 9px;
  fill: var(--q-text-3);
}
.q-rp__bar {
  fill: color-mix(in srgb, var(--q-brand-2) 34%, transparent);
}
.q-rp__line {
  fill: none;
  stroke: var(--q-ok);
  stroke-width: 2.2;
  stroke-linejoin: round;
  stroke-linecap: round;
}
/* 只有一天数据时画不出线，但点要画 —— 否则整张图是空的，像功能坏了 */
.q-rp__dot {
  fill: var(--q-ok);
  stroke: var(--q-surface);
  stroke-width: 1.5;
}
.q-rp__axis {
  stroke: var(--q-border);
  stroke-width: 1;
}
.q-rp__tick {
  font-size: 10px;
  fill: var(--q-text-3);
}
.q-rp__key {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--q-text-3);
}
.q-rp__key i {
  display: inline-block;
  margin-left: 8px;
}
.q-rp__key-line {
  width: 14px;
  height: 2.5px;
  border-radius: 2px;
  background: var(--q-ok);
}
.q-rp__key-bar {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--q-brand-2) 45%, transparent);
}

/* ───────── 弱项排行 ───────── */
.q-rp__ranks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.q-rp__ranks li {
  display: grid;
  grid-template-columns: minmax(72px, 1.3fr) 2fr 42px 46px;
  align-items: center;
  gap: 9px;
  font-size: 12.5px;
}
.q-rp__rank-name {
  color: var(--q-text);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.q-rp__rank-bar,
.q-rp__type-bar {
  height: 7px;
  border-radius: 99px;
  background: var(--q-surface-3);
  overflow: hidden;
}
.q-rp__rank-bar i,
.q-rp__type-bar i {
  display: block;
  height: 100%;
  border-radius: 99px;
  transition: width 0.5s var(--q-ease);
}
.q-rp__rank-bar i.is-ok,
.q-rp__type-bar i.is-ok {
  background: var(--q-ok);
}
.q-rp__rank-bar i.is-warn {
  background: var(--q-warn);
}
.q-rp__rank-bar i.is-bad,
.q-rp__type-bar i.is-bad {
  background: var(--q-bad);
}
.q-rp__rank-val,
.q-rp__rank-n {
  text-align: right;
  font-weight: 700;
}
.q-rp__rank-n {
  font-weight: 500;
}

/* ───────── 题型 / 耗时 ───────── */
.q-rp__types {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.q-rp__types li {
  display: grid;
  grid-template-columns: 76px 1fr 44px 48px;
  align-items: center;
  gap: 9px;
  font-size: 12.5px;
}
.q-rp__types b {
  text-align: right;
  font-weight: 800;
}
.q-rp__timing {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 9px;
}
.q-rp__timing div {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 10px 6px;
  border-radius: var(--q-r-sm);
  background: var(--q-surface-2);
  border: 1px solid var(--q-border);
}
.q-rp__timing b {
  font-size: 15px;
  font-weight: 800;
  color: var(--q-text);
}
.q-rp__timing span {
  font-size: 11px;
  color: var(--q-text-3);
}

/* ───────── 最慢的题 ───────── */
.q-rp__slow {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.q-rp__slow li {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 13px;
}
.q-rp__slow-stem {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--q-text);
  display: -webkit-box;
  -webkit-line-clamp: 1;
  line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.q-rp__slow-ms {
  flex: 0 0 auto;
  font-weight: 700;
  color: var(--q-warn);
  font-size: 12.5px;
}

@media (max-width: 640px) {
  .q-rp__ranks li {
    grid-template-columns: minmax(60px, 1fr) 1.4fr 38px;
  }
  .q-rp__rank-n {
    display: none;
  }
}
</style>
