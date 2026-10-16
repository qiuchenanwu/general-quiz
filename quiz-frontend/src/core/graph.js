/**
 * graph.js —— 知识图谱的**纯逻辑层**（不碰 Vue / DOM / canvas）
 *
 * 为什么单独抽出来：力导向布局的「单步更新」、弱点着色映射、按节点筛题
 * 这三件事最容易写错，而且错了在界面上只是"看着有点怪"，靠肉眼发现不了。
 * 抽成纯函数之后，它们能在 Node 里被逐条断言（见 tests/test_engine.mjs 的 E 段），
 * 视图只负责把算好的 x/y/颜色画到 canvas 上。
 *
 * 三个刻意的设计决定：
 *
 * 1. **不引任何图表/布局库**。整个项目（学习报告的热力图/趋势图）都是手写 SVG，
 *    为了十几个节点引 d3（~250KB）不值当，而且那样没法精确跟 CSS 变量对齐。
 *
 * 2. **初始布局不用 Math.random**。用「按权重分档摆在同心圆上 + 下标抖动」，
 *    这样测试可复现，用户点「重排」看到的是同一个起始形状，不会每次都不一样。
 *
 * 3. **弱点数据复用 analytics.tagStats**。学习报告页的「知识点弱项」用的是同一个
 *    函数，所以图谱里看到的正确率永远和报告页对得上 —— 不另造一套平行统计。
 *    没做过的知识点正确率是 **null**（不是 0），界面上画成灰色而不是"全错"。
 *
 * 一个图谱节点的形状（后端 service.build_graph 产出的）：
 *     { id: 'k1', label: '实事求是', kind: '章' | '节' | '点', weight: 1~5 }
 * 一条边的形状：
 *     { from: 'k1', to: 'k2', label: '是…的精髓' }
 */

import { tagStats } from './analytics'

/** 一次最多送多少道题给后端。和后端 views.MAX_GRAPH_QUESTIONS 对齐，超了会被 400 拒绝。 */
export const GRAPH_MAX_QUESTIONS = 120

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/**
 * 权重兜底：后端本该给 1~5，但脏数据（0 / '3' / null）不能让布局算出 NaN。
 * 没给算 3（中间值）；给了就夹到 1~5 —— 显式的 0 按 1 算，
 * 不要静默改成 3（那等于替模型改了口径）。
 */
export function normalizeWeight(value) {
  if (value === undefined || value === null) return 3
  if (typeof value === 'string' && value.trim() === '') return 3
  const num = Number(value)
  if (!Number.isFinite(num)) return 3
  return clamp(Math.round(num) || 1, 1, 5)
}

/* ═══════════════════════════ 1. 标签与知识点对齐 ═══════════════════════════ */

/**
 * 标签归一化：去空白（含全角空格）、转小写。
 * 图谱节点名和题目标签来自两个地方（模型生成 vs 题库），"生产力 与 生产关系"
 * 这种空格差异不该让它们对不上。
 */
export function normalizeTag(text) {
  return String(text ?? '')
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase()
}

/** 题库里出现过的全部标签名（保持原样，用于匹配和显示） */
export function collectTagNames(questions) {
  const set = new Set()
  for (const q of questions || []) {
    for (const t of q?.tags || []) {
      if (t) set.add(t)
    }
  }
  return [...set]
}

/**
 * 把一个知识点名对到题目标签上。
 *
 * 三级：完全相等 → 归一化后相等 → **唯一的**包含关系。
 * 包含关系只在唯一命中时才算（"实事求是"能对到"实事求是的思想路线"，但如果同时
 * 有好几个标签都含这四个字，就宁可不猜 —— 猜错等于把不相干的题算进这个知识点）。
 * 对不上返回空串，调用方据此把它当"没有题目数据"处理。
 */
export function matchTag(label, tagNames) {
  const want = normalizeTag(label)
  if (!want) return ''
  for (const name of tagNames || []) {
    if (normalizeTag(name) === want) return name
  }
  const hits = (tagNames || []).filter((name) => {
    const n = normalizeTag(name)
    return n.includes(want) || want.includes(n)
  })
  return hits.length === 1 ? hits[0] : ''
}

/* ═══════════════════════════ 2. 弱点热力（复用报告页统计） ═══════════════════════════ */

/**
 * 每个知识点节点的作答表现。
 *
 * 直接复用 analytics.tagStats（门槛设成 1：图谱要把"做过 1 道的"也显示出来，
 * 只是颜色浅；报告页才需要 minAttempts=3 来压掉噪声）。
 *
 * @returns 以节点 id 为键的映射；每项 { id, label, tag, n, ok, wrong, accuracy }
 *          · tag 为空 = 这个知识点没有对得上的标签（可能模型自己起了个新名字）
 *          · accuracy 为 null = 这个知识点还没做过（不是 0）
 */
export function nodeStats(nodes, history, questions, { minAttempts = 1 } = {}) {
  const tagNames = collectTagNames(questions)
  const rows = tagStats(history, questions, { minAttempts })
  const index = new Map()
  for (const row of rows) index.set(normalizeTag(row.name), row)

  const out = new Map()
  for (const node of nodes || []) {
    if (!node?.id) continue
    const tag = matchTag(node.label, tagNames)
    const row = tag ? index.get(normalizeTag(tag)) : null
    const n = row?.n || 0
    const ok = row?.ok || 0
    out.set(node.id, {
      id: node.id,
      label: node.label || '',
      tag,
      n,
      ok,
      wrong: n - ok,
      accuracy: n ? row.accuracy : null,
    })
  }
  return out
}

/**
 * 正确率 → 弱点等级。
 * -1 = 还没做过（灰）；0 掌握最好，3 最差。
 * 阈值 50/70/85：低于 50% 说明这个概念基本没掌握，先补它。
 */
export function weaknessLevel(accuracy) {
  if (accuracy === null || accuracy === undefined || Number.isNaN(accuracy)) return -1
  if (accuracy < 50) return 3
  if (accuracy < 70) return 2
  if (accuracy < 85) return 1
  return 0
}

/** 等级 → 颜色（和 theme.css 的语义色一致：绿→蓝→橙→红） */
export const LEVEL_COLORS = ['#10b981', '#38bdf8', '#f59e0b', '#ef4444']

/** 没做过的节点用中性灰，避免和"掌握良好"的绿色混淆 */
export const UNKNOWN_COLOR = '#98a1b5'

export function levelColor(level) {
  return LEVEL_COLORS[level] ?? UNKNOWN_COLOR
}

/** 等级 → 中文说明（图例和侧栏都用它，别在模板里再写一份） */
export const LEVEL_LABELS = ['掌握良好', '基本掌握', '需要复习', '重点补强']

export function levelLabel(level) {
  return LEVEL_LABELS[level] || '还没做过'
}

/**
 * 节点半径：做过的题越多越大（用 sqrt 收敛，免得一个热门知识点把画布撑爆），
 * 错题数再补一点点 —— 同样做过 10 道，错 5 道的那块该比全对的那块更显眼。
 * 后端给的 weight（1~5，模型对"这个概念多重要"的判断）最后微调。
 */
export function nodeRadius(n, weight = 3, wrong = 0) {
  const span = Math.min(15, Math.sqrt(Math.max(0, n || 0)) * 3.6)
  const bump = (normalizeWeight(weight) - 3) * 1.6
  const scar = Math.min(5, Math.max(0, Number(wrong) || 0) * 1.4)
  return Math.round(clamp(13 + span + bump + scar, 10, 32) * 10) / 10
}

/** 节点是否该画"有错题"的红环 */
export function hasWrongMark(stat) {
  return !!stat && stat.wrong > 0
}

/**
 * 「最该补的知识点」排序分：正确率缺口 + 错题数加权。
 * 错题数要额外加权 —— 做 3 道错 3 道和做 20 道错 3 道，前者更该先补。
 * 没做过的返回 -1（不是"最弱"，只是"没数据"），排序时落到最后。
 */
export function weaknessScore(stat) {
  if (!stat || !stat.n) return -1
  return Math.round((100 - stat.accuracy + stat.wrong * 15) * 10) / 10
}

/** 按弱点分从高到低取前 limit 个（只取有作答数据的） */
export function rankWeakNodes(stats, limit = 8) {
  return [...(stats?.values?.() || stats || [])]
    .filter((s) => s.n > 0)
    .sort((a, b) => weaknessScore(b) - weaknessScore(a) || b.n - a.n)
    .slice(0, limit)
}

/* ═══════════════════════════ 3. 力导向布局 ═══════════════════════════ */

/**
 * 物理参数。调这几个数就够改手感了：
 *   repulsion  节点两两斥力（库仑式，越近推得越狠）
 *   spring     边的弹簧刚度
 *   springLength 弹簧自然长度（希望相连节点隔多远）
 *   gravity    向心力，把跑远的节点拉回画布中心
 *   damping    **阻尼，必须小于 1**，否则永远不收敛（画面一直抖）
 *   maxSpeed / maxStep 限速，防止初始重叠时"炸开"
 */
export const PHYSICS = {
  repulsion: 16000,
  spring: 0.012,
  springLength: 150,
  gravity: 0.004,
  damping: 0.86,
  maxSpeed: 12,
  maxStep: 26,
}

/**
 * 初始布局：按 weight 分档摆在同心圆上（权重大的靠里，更像"核心概念"），
 * 下标抖动打破完美对称。**不用 Math.random**，保证可复现。
 *
 * @returns { nodes: [{id,x,y,vx,vy,pinned}], edges: [...], width, height }
 */
export function initLayout(nodes, edges = [], { width = 900, height = 620 } = {}) {
  const list = nodes || []
  const total = Math.max(1, list.length)
  const cx = width / 2
  const cy = height / 2
  const maxRing = Math.min(width, height) * 0.42

  const placed = list.map((node, i) => {
    const angle = (i / total) * Math.PI * 2
    const rank = (normalizeWeight(node?.weight) - 1) / 4 // 0~1
    const ring = maxRing * (0.96 - rank * 0.5)
    const jitter = ((i * 37) % 11) - 5
    return {
      id: node.id,
      x: cx + Math.cos(angle) * ring + jitter,
      y: cy + Math.sin(angle) * ring * 0.9 + jitter,
      vx: 0,
      vy: 0,
      pinned: false,
    }
  })

  return { nodes: placed, edges: [...(edges || [])], width, height }
}

/**
 * 力模拟的**单步**更新。纯函数：不改入参，返回新 state（视图才能安全地
 * 一边被 rAF 调用、一边被 Vue 的响应式读到）。
 *
 * 每步做四件事：
 *   1. 节点两两斥力；
 *   2. 每条边当弹簧（拉长往回拽、压短往外推）；
 *   3. 向心力把整体收拢到画布中心；
 *   4. 阻尼 + 限速 + 限位移，然后积分位置；pinned 的节点（正在被拖）不动。
 */
export function stepLayout(state, opts = {}) {
  const cfg = { ...PHYSICS, ...opts }
  const width = state?.width || 900
  const height = state?.height || 620
  const cx = width / 2
  const cy = height / 2
  const nodes = (state?.nodes || []).map((n) => ({ ...n }))
  const count = nodes.length

  // 1. 斥力
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const a = nodes[i]
      const b = nodes[j]
      let dx = b.x - a.x
      let dy = b.y - a.y
      let d2 = dx * dx + dy * dy
      if (d2 < 1) {
        // 完全重叠：用下标给一个确定的方向，绝不除以 0
        dx = ((i + j) % 2 ? 1 : -1) * (1 + (i % 3))
        dy = i % 2 ? -1 : 1
        d2 = dx * dx + dy * dy
      }
      const dist = Math.sqrt(d2)
      const force = cfg.repulsion / d2
      const ux = dx / dist
      const uy = dy / dist
      a.vx -= ux * force
      a.vy -= uy * force
      b.vx += ux * force
      b.vy += uy * force
    }
  }

  // 2. 弹簧
  const index = new Map(nodes.map((n) => [n.id, n]))
  for (const edge of state?.edges || []) {
    const a = index.get(edge?.from)
    const b = index.get(edge?.to)
    if (!a || !b) continue
    let dx = b.x - a.x
    let dy = b.y - a.y
    let dist = Math.hypot(dx, dy)
    if (dist < 0.01) {
      dx = 1
      dy = 0
      dist = 1
    }
    const force = cfg.spring * (dist - cfg.springLength)
    const ux = dx / dist
    const uy = dy / dist
    a.vx += ux * force
    a.vy += uy * force
    b.vx -= ux * force
    b.vy -= uy * force
  }

  // 3~4. 向心力 / 阻尼 / 限速 / 积分
  for (const node of nodes) {
    node.vx += (cx - node.x) * cfg.gravity
    node.vy += (cy - node.y) * cfg.gravity
    node.vx *= cfg.damping
    node.vy *= cfg.damping
    const speed = Math.hypot(node.vx, node.vy)
    if (speed > cfg.maxSpeed) {
      node.vx = (node.vx / speed) * cfg.maxSpeed
      node.vy = (node.vy / speed) * cfg.maxSpeed
    }
    if (node.pinned) {
      node.vx = 0
      node.vy = 0
      continue
    }
    node.x = clamp(node.x + clamp(node.vx, -cfg.maxStep, cfg.maxStep), 24, width - 24)
    node.y = clamp(node.y + clamp(node.vy, -cfg.maxStep, cfg.maxStep), 24, height - 24)
  }

  return { ...state, nodes, width, height }
}

/** 系统的"动能"：趋近 0 说明布局稳了（视图据此停掉 rAF，不再空转烧 CPU） */
export function layoutEnergy(state) {
  return (state?.nodes || []).reduce((sum, n) => sum + n.vx * n.vx + n.vy * n.vy, 0)
}

/** 连跑 steps 步。视图的「重排」和测试都用它 —— 同一份实现，不会两边不一致。 */
export function runLayout(state, steps = 160, opts = {}) {
  let cur = state
  for (let i = 0; i < steps; i++) cur = stepLayout(cur, opts)
  return cur
}

/* ═══════════════════════════ 4. 图谱 ↔ 题目 ═══════════════════════════ */

/**
 * 把后端返回的图谱整理成视图直接能用的形状。
 * 后端已经校验过悬空边/重复节点，这里只做兜底（拿不到就当空），**绝不抛错** ——
 * 图谱是"锦上添花"的功能，不该因为它把整页搞崩。
 */
export function normalizeGraph(raw) {
  const nodes = []
  const seen = new Set()
  for (const item of raw?.nodes || []) {
    const id = String(item?.id ?? '').trim()
    const label = String(item?.label ?? item?.name ?? '').trim()
    if (!id || !label || seen.has(id)) continue
    seen.add(id)
    nodes.push({
      id,
      label,
      kind: String(item?.kind || '点'),
      weight: normalizeWeight(item?.weight),
    })
  }

  const ids = new Set(nodes.map((n) => n.id))
  const edges = []
  const edgeSeen = new Set()
  for (const item of raw?.edges || []) {
    const from = String(item?.from ?? item?.source ?? '').trim()
    const to = String(item?.to ?? item?.target ?? '').trim()
    if (!ids.has(from) || !ids.has(to) || from === to) continue
    const key = `${from}\u0000${to}`
    if (edgeSeen.has(key)) continue
    edgeSeen.add(key)
    edges.push({ from, to, label: String(item?.label || '') })
  }

  const warnings = Array.isArray(raw?.warnings) ? raw.warnings.map((w) => String(w)) : []
  return { nodes, edges, warnings, sampled: Number(raw?.sampled) || 0 }
}

/** 节点的**一跳邻居**。关系虽然是有向的，但复习时两边都算相关。 */
export function neighborsOf(nodeId, edges) {
  const out = new Set()
  for (const edge of edges || []) {
    if (edge?.from === nodeId) out.add(edge.to)
    else if (edge?.to === nodeId) out.add(edge.from)
  }
  return [...out]
}

/**
 * 点某个知识点时筛出相关题目（返回 id 列表 + 用到的标签）。
 *
 * 主路径：节点名对上题目标签 —— 图谱的提示词就是让模型**复用题目已有标签**当
 * 节点名的，所以绝大多数节点能直接对上。
 * 兜底：对不上时把**相邻知识点**的标签也算进来。点"实事求是"时，挂在它下面的
 * "实事求是的思想路线"那批题也该出来，否则用户点了一个核心概念却发现"没有题目"。
 *
 * 视图起会话时传的是这里返回的 tags，走的是 store 既有的 filterQuestions，
 * 所以「筛选出来的题」和「练习里的题」天然一致，不会出现两套口径。
 */
export function nodeQuestions(nodeId, graph, questions, { withNeighbors = true } = {}) {
  const nodes = graph?.nodes || []
  const edges = graph?.edges || []
  const node = nodes.find((x) => x?.id === nodeId)
  const empty = { ids: [], tags: [], ownTag: '', neighborTags: [], questions: [] }
  if (!node) return empty

  const tagNames = collectTagNames(questions)
  const ownTag = matchTag(node.label, tagNames)

  const neighborTags = []
  if (withNeighbors) {
    const near = new Set(neighborsOf(nodeId, edges))
    for (const other of nodes) {
      if (!near.has(other.id)) continue
      const tag = matchTag(other.label, tagNames)
      if (tag && tag !== ownTag && !neighborTags.includes(tag)) neighborTags.push(tag)
    }
  }

  const tags = [...(ownTag ? [ownTag] : []), ...neighborTags]
  if (!tags.length) return { ...empty, neighborTags }

  const hits = (questions || []).filter((q) => (q?.tags || []).some((t) => tags.includes(t)))
  return { ids: hits.map((q) => q.id), tags, ownTag, neighborTags, questions: hits }
}

/**
 * 抽样：后端一次只收 120 道。**均匀取样**而不是截前 120 道 ——
 * 题库是按章节排的，截断会让图谱只反映前几章。
 */
export function sampleQuestions(questions, max = GRAPH_MAX_QUESTIONS) {
  const rows = (questions || []).filter(Boolean)
  if (rows.length <= max) return [...rows]
  const step = rows.length / max
  const out = []
  for (let i = 0; i < max; i++) out.push(rows[Math.floor(i * step)])
  return out
}

/** 压缩成后端 build_graph 认的字段（少传 = 少占上下文 = 本机模型更快出结果） */
export function graphPayload(questions) {
  return (questions || []).map((q) => ({
    no: q.no,
    type: q.type,
    stem: q.stem,
    answer: q.answer,
    tags: q.tags || [],
  }))
}
