/**
 * analytics.js —— 学习数据统计（**纯函数**，不碰 Vue / DOM / localStorage）
 *
 * 为什么单独抽出来：这些「按天聚合 / 连续打卡 / 弱项排序」的逻辑最容易算错，
 * 而纯函数能在 Node 里直接跑断言（见 frontend/tests/test_engine.mjs 的 D 段）。
 * 视图只负责把结果画成 SVG。
 *
 * 一条历史记录的形状（刻意用短键，因为要一条条存进 localStorage）：
 *     { q: 'q12', ok: 1, t: 1780000000000, ms: 8400 }
 *       q  题目 id      ok 1 对 / 0 错      t 作答完成的毫秒时间戳
 *       ms 这道题想了多久（毫秒；考试交卷时没有逐题计时，记 0）
 */

export const DAY_MS = 86400000

/** 按**本地时区**出日期键。打卡是给人看的，不能用 UTC —— 否则晚上做的题会算到明天。 */
export function dayKey(ts) {
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 当天零点的时间戳 */
export function startOfDay(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 把历史记录按天聚合：{ 'YYYY-MM-DD': { n, ok, ms } } */
export function dailyStats(history) {
  const out = {}
  for (const row of history || []) {
    if (!row || !row.t) continue
    const key = dayKey(row.t)
    const bucket = out[key] || (out[key] = { n: 0, ok: 0, ms: 0 })
    bucket.n += 1
    if (row.ok) bucket.ok += 1
    bucket.ms += row.ms || 0
  }
  return out
}

/**
 * 连续打卡天数。
 *
 * 「今天还没开始」不该立刻把连续记录清零 —— 那意味着每天零点一到
 * 前一天攒的连胜就没了，很打击人。所以今天没有记录时，从**昨天**往回数。
 */
export function streakDays(daily, now = Date.now()) {
  const today = startOfDay(now)
  let cursor = today
  if (!daily[dayKey(cursor)]) {
    cursor -= DAY_MS
    if (!daily[dayKey(cursor)]) return 0
  }
  let days = 0
  while (daily[dayKey(cursor)]) {
    days += 1
    cursor -= DAY_MS
  }
  return days
}

/**
 * 最近 N 天，**补齐没有作答的空白天**（返回连续序列）。
 * 趋势图和热力图都需要连续序列，靠 dayKey 拼字符串很容易跳日期。
 */
export function recentDays(daily, days, now = Date.now()) {
  const out = []
  const today = startOfDay(now)
  for (let i = days - 1; i >= 0; i--) {
    const ts = today - i * DAY_MS
    const key = dayKey(ts)
    const bucket = daily[key] || { n: 0, ok: 0, ms: 0 }
    out.push({
      key,
      ts,
      n: bucket.n,
      ok: bucket.ok,
      // 当天没做题时正确率是 0/0，标成 null 而不是 0 ——
      // 否则趋势图会把「没做题」画成「正确率 0%」，看着像退步
      accuracy: bucket.n ? Math.round((bucket.ok / bucket.n) * 100) : null,
    })
  }
  return out
}

/**
 * 打卡热力图矩阵：weeks 列 × 7 行，第 0 行是周一。
 * 最后一列是「本周」，所以最后一行可能还没到 —— 未来的格子标 future。
 */
export function heatmapWeeks(daily, weeks = 26, now = Date.now()) {
  const today = startOfDay(now)
  // 把今天所在周的周一作为最后一列的起点
  const weekday = (new Date(today).getDay() + 6) % 7 // 周一=0 … 周日=6
  const lastMonday = today - weekday * DAY_MS
  const firstMonday = lastMonday - (weeks - 1) * 7 * DAY_MS

  const columns = []
  let max = 0
  for (let w = 0; w < weeks; w++) {
    const column = []
    for (let d = 0; d < 7; d++) {
      const ts = firstMonday + (w * 7 + d) * DAY_MS
      const key = dayKey(ts)
      const bucket = daily[key]
      const n = bucket ? bucket.n : 0
      if (n > max) max = n
      column.push({ key, ts, n, ok: bucket ? bucket.ok : 0, future: ts > today })
    }
    columns.push(column)
  }
  return { columns, max, firstMonday, lastMonday }
}

/** qid → tags，避免每个统计函数都重复遍历题库 */
function tagIndex(questions) {
  const map = new Map()
  for (const q of questions || []) {
    map.set(q.id, Array.isArray(q.tags) ? q.tags : [])
  }
  return map
}

/**
 * 知识点弱项。
 *
 * 只统计作答次数达到 minAttempts 的标签：做 1 道错 1 道就标成 0% 没有意义，
 * 排序之后会把真正需要复习的（做了很多但错得多）挤下去。
 */
export function tagStats(history, questions, { minAttempts = 3 } = {}) {
  const tags = tagIndex(questions)
  const buckets = new Map()
  for (const row of history || []) {
    if (!row || !row.q) continue
    for (const tag of tags.get(row.q) || []) {
      const bucket = buckets.get(tag) || { name: tag, n: 0, ok: 0 }
      bucket.n += 1
      if (row.ok) bucket.ok += 1
      buckets.set(tag, bucket)
    }
  }
  return [...buckets.values()]
    .map((b) => ({ ...b, accuracy: b.n ? Math.round((b.ok / b.n) * 100) : 0 }))
    .filter((b) => b.n >= minAttempts)
    .sort((a, b) => a.accuracy - b.accuracy || b.n - a.n)
}

/** 题型统计：做了多少、正确率 */
export function typeStats(history, questions) {
  const types = new Map()
  for (const q of questions || []) types.set(q.id, q.type)
  const buckets = {}
  for (const row of history || []) {
    if (!row || !row.q) continue
    const type = types.get(row.q) || 'unknown'
    const bucket = buckets[type] || (buckets[type] = { type, n: 0, ok: 0 })
    bucket.n += 1
    if (row.ok) bucket.ok += 1
  }
  return Object.values(buckets)
    .map((b) => ({ ...b, accuracy: b.n ? Math.round((b.ok / b.n) * 100) : 0 }))
    .sort((a, b) => b.n - a.n)
}

/** 每题耗时的合理区间：太短是误触，太长多半是中途去干别的了 */
const MIN_REASONABLE_MS = 500
const MAX_REASONABLE_MS = 10 * 60 * 1000

function median(sorted) {
  if (!sorted.length) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/**
 * 耗时统计。用中位数当"典型值"而不是平均数 ——
 * 只要有一道题中途去接了杯水，平均数就被拉飞了。
 */
export function timingStats(history, { slowest = 5 } = {}) {
  const samples = (history || [])
    .filter((r) => r && r.ms >= MIN_REASONABLE_MS && r.ms <= MAX_REASONABLE_MS)
    .map((r) => ({ q: r.q, ms: r.ms, ok: r.ok }))

  const values = samples.map((s) => s.ms).sort((a, b) => a - b)
  const totalMs = values.reduce((sum, v) => sum + v, 0)
  return {
    samples: samples.length,
    totalMs,
    medianMs: median(values),
    meanMs: samples.length ? Math.round(totalMs / samples.length) : 0,
    minMs: values[0] || 0,
    maxMs: values[values.length - 1] || 0,
    slowest: [...samples].sort((a, b) => b.ms - a.ms).slice(0, slowest),
  }
}

/** 最长连对（按时间顺序扫一遍） */
export function longestStreak(history) {
  let best = 0
  let run = 0
  for (const row of (history || []).slice().sort((a, b) => (a.t || 0) - (b.t || 0))) {
    if (row && row.ok) {
      run += 1
      if (run > best) best = run
    } else {
      run = 0
    }
  }
  return best
}

/**
 * 一次性算出报告页要的所有东西。
 * @param {Array} history 作答历史
 * @param {Array} questions 当前题库的题目（用来拿 tags / type）
 * @param {object} opt { now, weeks, trendDays, minTagAttempts }
 */
export function buildReport(history, questions, opt = {}) {
  const now = opt.now || Date.now()
  const weeks = opt.weeks || 26
  const trendDays = opt.trendDays || 30
  const rows = (history || []).filter(Boolean)

  const daily = dailyStats(rows)
  const answered = rows.length
  const correct = rows.filter((r) => r.ok).length
  const totalMs = rows.reduce((sum, r) => sum + (r.ms || 0), 0)

  return {
    total: answered,
    correct,
    wrong: answered - correct,
    accuracy: answered ? Math.round((correct / answered) * 100) : 0,
    totalMs,
    activeDays: Object.keys(daily).length,
    streak: streakDays(daily, now),
    longestStreak: longestStreak(rows),
    firstAt: rows.length ? Math.min(...rows.map((r) => r.t || Infinity)) : 0,
    heatmap: heatmapWeeks(daily, weeks, now),
    trend: recentDays(daily, trendDays, now),
    tags: tagStats(rows, questions, { minAttempts: opt.minTagAttempts ?? 3 }),
    types: typeStats(rows, questions),
    timing: timingStats(rows),
  }
}

/** 把毫秒说成人话：'1 小时 12 分' / '46 秒' */
export function humanDuration(ms) {
  const seconds = Math.round((ms || 0) / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}
