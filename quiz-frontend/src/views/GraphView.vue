<script setup>
/**
 * GraphView —— 知识图谱：AI 把做过的题归纳成概念网络，前端自己画出来。
 *
 * 三件必须自己实现的事（这个项目不引图表库，学习报告就是手写内联 SVG 的）：
 *
 *   1. **力导向布局**。`<canvas>` + core/graph.js 里手写的力模拟
 *      （节点斥力 + 边弹簧 + 向心力 + 阻尼），requestAnimationFrame 驱动，
 *      能量小到一定值自动停 —— 不然静止的画面也在满帧烧 CPU。
 *   2. **弱点热力**。节点大小 = 这个知识点做过多少题，颜色 = 正确率，
 *      红虚线环 = 还有错题。统计直接来自 analytics.tagStats（学习报告同一份），
 *      所以图谱和报告页的数字永远对得上。
 *   3. **点节点筛选刷题**。点中节点 → 用它的标签（含相邻知识点）过 filterQuestions
 *      → 复用 store 既有的 startSession 起会话 → 跳 /practice。
 *
 * 后端不可用时**不白屏、不报整页错**：图谱卡片里给空态 + 原因 + 重试按钮，
 * 首页和刷题照常能用（图谱只是锦上添花）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useBankStore } from '@/stores/bank'
import { useQuizStore } from '@/stores/quiz'
import { apiBase, buildGraph } from '@/core/api'
import {
  GRAPH_MAX_QUESTIONS,
  graphPayload,
  hasWrongMark,
  initLayout,
  layoutEnergy,
  levelColor,
  levelLabel,
  LEVEL_COLORS,
  neighborsOf,
  nodeQuestions,
  nodeRadius,
  nodeStats,
  normalizeGraph,
  rankWeakNodes,
  runLayout,
  sampleQuestions,
  stepLayout,
  UNKNOWN_COLOR,
  weaknessLevel,
} from '@/core/graph'

const bank = useBankStore()
const quiz = useQuizStore()
const router = useRouter()

/* ─────────────────────────── 页面上方的控制区 ─────────────────────────── */

/** 归纳范围：全库太散、错题太窄，给三种口径 */
const SCOPES = [
  { value: 'all', label: '全部题目（自动抽样）', hint: '看整体结构，最多送 120 道' },
  { value: 'answered', label: '只归纳做过的题', hint: '和弱点热力最贴' },
  { value: 'wrong', label: '只归纳做错过的题', hint: '专挑薄弱环节' },
]

const scope = ref('all')
const loading = ref(false)
const errorText = ref('')
const graph = ref(null) // { nodes, edges, warnings, sampled }
const generatedLabel = ref('') // 生成时间文案（在 action 里取一次 Date.now()，不放 getter）

/** 当前范围下有多少题可归纳（用来提前拦住"一道题都没有"） */
const poolSize = computed(() => pickScopeQuestions().length)

function pickScopeQuestions() {
  const questions = bank.questions || []
  if (scope.value === 'wrong') {
    const wrong = new Set(quiz.wrongIds)
    return questions.filter((q) => wrong.has(q.id))
  }
  if (scope.value === 'answered') {
    return questions.filter((q) => quiz.answers[q.id])
  }
  return questions
}

async function generate() {
  if (!bank.meta) {
    ElMessage.warning('先去首页选一套题库')
    return
  }
  const pool = pickScopeQuestions()
  if (!pool.length) {
    ElMessage.warning(
      scope.value === 'wrong' ? '错题本还是空的，先刷几道题' : '这个范围下没有题目，换个范围试试',
    )
    return
  }

  const picked = sampleQuestions(pool, GRAPH_MAX_QUESTIONS)
  loading.value = true
  errorText.value = ''
  try {
    const result = await buildGraph({ questions: graphPayload(picked) })
    if (result && result.ok === false) throw new Error(result.error || '后端归纳失败')
    const normalized = normalizeGraph(result)
    if (!normalized.nodes.length) {
      graph.value = null
      errorText.value = '后端没有产出可用的知识点。可以换个范围重试，或稍后再来一次。'
      return
    }
    graph.value = normalized
    // Date.now() 只在这里取一次并存成文案：放进 computed/getter 会被永久缓存
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    generatedLabel.value = `${pad(now.getHours())}:${pad(now.getMinutes())} · 归纳 ${normalized.sampled || picked.length} 道`
    buildSimulation()
    ElMessage.success(`图谱生成好了：${normalized.nodes.length} 个知识点、${normalized.edges.length} 条关系`)
  } catch (e) {
    graph.value = null
    sim = null
    errorText.value = e?.message || String(e)
    ElMessage.error('生成知识图谱失败，看看下面的提示')
  } finally {
    loading.value = false
  }
}

/* ─────────────────────────── 弱点热力（复用报告统计） ─────────────────────────── */

const stats = computed(() => nodeStats(graph.value?.nodes || [], quiz.history, bank.questions))

const nodeById = computed(() => new Map((graph.value?.nodes || []).map((n) => [n.id, n])))

const weakList = computed(() => rankWeakNodes(stats.value, 8))

/** 选中节点 + 它的邻居（画布上一起高亮） */
const selectedId = ref('')

const highlightIds = computed(() => {
  if (!selectedId.value) return new Set()
  const ids = new Set([selectedId.value])
  for (const id of neighborsOf(selectedId.value, graph.value?.edges || [])) ids.add(id)
  return ids
})

const selectedNode = computed(() => nodeById.value.get(selectedId.value) || null)
const selectedStat = computed(() => stats.value.get(selectedId.value) || null)

/** 选中知识点关联到的题目（纯函数算好，练习时用的是同一批标签） */
const related = computed(() => {
  if (!selectedId.value) return null
  return nodeQuestions(selectedId.value, graph.value, bank.questions)
})

const relatedPreview = computed(() => (related.value?.questions || []).slice(0, 6))

const hasHistory = computed(() => quiz.history.length > 0)

/* ─────────────────────────── 画布：力导向布局 ─────────────────────────── */

const wrapRef = ref(null)
const canvasRef = ref(null)

/** 视图变换（缩放 + 平移）。不放进 sim —— 布局坐标系和屏幕坐标系要分开。 */
const viewport = reactive({ scale: 1, offsetX: 0, offsetY: 0 })
const zoomText = computed(() => `${Math.round(viewport.scale * 100)}%`)

const reduceMotion =
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches

/** 调色板：canvas 读不到 CSS 变量，只能 getComputedStyle 抄一份，换主题时重抄 */
const palette = reactive({
  text: '#1a1f2e',
  dim: '#98a1b5',
  surface: '#ffffff',
  border: 'rgba(26,31,46,0.12)',
})

function readPalette() {
  if (typeof window === 'undefined') return
  const cs = getComputedStyle(document.documentElement)
  const pick = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback
  palette.text = pick('--q-text', '#1a1f2e')
  palette.dim = pick('--q-text-3', '#98a1b5')
  palette.surface = pick('--q-surface', '#ffffff')
  palette.border = pick('--q-border', 'rgba(26,31,46,0.12)')
}

/** 布局状态（不是响应式的：每帧改一次 x/y，塞进 Vue 响应式只会白烧性能） */
let sim = null
let raf = 0
let idleFrames = 0

function buildSimulation() {
  stopLoop()
  const canvas = canvasRef.value
  if (!graph.value) {
    sim = null
    draw()
    return
  }
  const width = canvas?.clientWidth || wrapRef.value?.clientWidth || 900
  const height = canvas?.clientHeight || wrapRef.value?.clientHeight || 620
  sim = initLayout(graph.value.nodes, graph.value.edges, { width, height })
  viewport.scale = 1
  viewport.offsetX = 0
  viewport.offsetY = 0
  selectedId.value = ''
  startLoop()
}

function startLoop() {
  if (!sim) return
  if (reduceMotion) {
    // 系统设了"减少动态效果"：直接算到收敛再画一帧，不做动画
    sim = runLayout(sim, 260)
    draw()
    return
  }
  if (raf) return
  idleFrames = 0
  raf = requestAnimationFrame(tick)
}

function stopLoop() {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
}

function tick() {
  raf = 0
  if (!sim) return
  sim = stepLayout(sim)
  draw()
  // 能量（动能）足够小说明已经稳了 → 再画 45 帧就停，避免空转
  idleFrames = layoutEnergy(sim) < 0.05 ? idleFrames + 1 : 0
  if (idleFrames < 45) raf = requestAnimationFrame(tick)
}

/** 拖拽/缩放/重排之后要让布局"重新热起来" */
function reheat() {
  if (!sim) return
  startLoop()
}

function radiusOf(id) {
  const stat = stats.value.get(id)
  const node = nodeById.value.get(id)
  return nodeRadius(stat?.n || 0, node?.weight || 3, stat?.wrong || 0)
}

function colorOf(id) {
  const stat = stats.value.get(id)
  if (!stat || !stat.n) return UNKNOWN_COLOR
  return levelColor(weaknessLevel(stat.accuracy))
}

function syncCanvasSize() {
  const canvas = canvasRef.value
  const wrap = wrapRef.value
  if (!canvas || !wrap) return
  const dpr = window.devicePixelRatio || 1
  const width = Math.max(260, Math.round(wrap.clientWidth))
  const height = Math.max(280, Math.round(wrap.clientHeight))
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  if (sim) {
    sim.width = width
    sim.height = height
  }
  draw()
}

function truncate(text, max) {
  const s = String(text || '')
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function draw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = window.devicePixelRatio || 1
  const width = canvas.width / dpr
  const height = canvas.height / dpr
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  if (!sim) return

  ctx.save()
  ctx.translate(viewport.offsetX, viewport.offsetY)
  ctx.scale(viewport.scale, viewport.scale)

  const nodeIndex = new Map(sim.nodes.map((n) => [n.id, n]))
  const showEdgeLabel = viewport.scale > 0.7 && (graph.value?.edges || []).length <= 26

  /* ---------- 边 ---------- */
  ctx.lineWidth = 1.2
  for (const edge of graph.value?.edges || []) {
    const a = nodeIndex.get(edge.from)
    const b = nodeIndex.get(edge.to)
    if (!a || !b) continue
    const active = highlightIds.value.has(edge.from) && highlightIds.value.has(edge.to)
    ctx.strokeStyle = active ? 'rgba(99, 102, 241, 0.75)' : palette.border
    ctx.lineWidth = active ? 2 : 1.2
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()

    if (edge.label && showEdgeLabel) {
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      ctx.font = '400 10.5px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const text = truncate(edge.label, 9)
      const w = ctx.measureText(text).width
      ctx.fillStyle = palette.surface
      ctx.globalAlpha = 0.86
      ctx.fillRect(mx - w / 2 - 4, my - 8, w + 8, 16)
      ctx.globalAlpha = 1
      ctx.fillStyle = palette.dim
      ctx.fillText(text, mx, my)
    }
  }

  /* ---------- 节点 ---------- */
  for (const nd of sim.nodes) {
    const stat = stats.value.get(nd.id)
    const r = radiusOf(nd.id)
    const color = colorOf(nd.id)
    const selected = nd.id === selectedId.value
    const near = highlightIds.value.has(nd.id)

    // 选中：外面套一圈品牌色光晕
    if (selected || near) {
      ctx.beginPath()
      ctx.arc(nd.x, nd.y, r + (selected ? 9 : 6), 0, Math.PI * 2)
      ctx.fillStyle = selected ? 'rgba(99, 102, 241, 0.22)' : 'rgba(99, 102, 241, 0.12)'
      ctx.fill()
    }

    // 主体
    ctx.beginPath()
    ctx.arc(nd.x, nd.y, r, 0, Math.PI * 2)
    ctx.globalAlpha = stat && stat.n ? 0.92 : 0.55
    ctx.fillStyle = color
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.lineWidth = selected ? 3 : 2
    ctx.strokeStyle = selected ? '#6366f1' : palette.surface
    ctx.stroke()

    // 红虚线环 = 这个知识点还有错题（错题数用环表示，颜色已经被正确率占用了）
    if (hasWrongMark(stat)) {
      ctx.beginPath()
      ctx.setLineDash([3, 3])
      ctx.lineWidth = 2
      ctx.strokeStyle = '#ef4444'
      ctx.arc(nd.x, nd.y, r + 4.5, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // 节点名
    const label = truncate(nodeById.value.get(nd.id)?.label || nd.id, 8)
    ctx.font = `${selected ? 700 : 600} 12px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillStyle = palette.text
    ctx.fillText(label, nd.x, nd.y + r + 7)

    // 正确率（做过才写；没做过的写"未做"，免得看着像 0%）
    if (stat) {
      ctx.font = '400 10.5px system-ui, sans-serif'
      ctx.fillStyle = stat.n ? color : palette.dim
      ctx.fillText(stat.n ? `${stat.accuracy}%` : '未做', nd.x, nd.y + r + 22)
    }
  }

  ctx.restore()
}

/* ─────────────────────────── 交互：拖拽 / 缩放 / 选中 ─────────────────────────── */

const drag = {
  mode: '', // 'node' | 'pan' | ''
  id: '',
  pointerId: -1,
  originX: 0, // 世界坐标下的抓取偏移
  originY: 0,
  startX: 0, // 屏幕坐标，用来判断"这是点击还是拖动"
  startY: 0,
  moved: 0,
}

function toWorld(event) {
  const rect = canvasRef.value.getBoundingClientRect()
  return {
    x: (event.clientX - rect.left - viewport.offsetX) / viewport.scale,
    y: (event.clientY - rect.top - viewport.offsetY) / viewport.scale,
  }
}

function hitNode(wx, wy) {
  if (!sim) return null
  for (const nd of sim.nodes) {
    if (Math.hypot(nd.x - wx, nd.y - wy) <= radiusOf(nd.id) + 5) return nd
  }
  return null
}

function onPointerDown(event) {
  if (!sim) return
  const canvas = canvasRef.value
  canvas.setPointerCapture?.(event.pointerId)
  const world = toWorld(event)
  const hit = hitNode(world.x, world.y)
  drag.startX = event.clientX
  drag.startY = event.clientY
  drag.moved = 0
  drag.pointerId = event.pointerId
  if (hit) {
    drag.mode = 'node'
    drag.id = hit.id
    drag.originX = hit.x - world.x
    drag.originY = hit.y - world.y
    hit.pinned = true
  } else {
    drag.mode = 'pan'
    drag.originX = viewport.offsetX
    drag.originY = viewport.offsetY
  }
}

function onPointerMove(event) {
  if (!sim || !drag.mode) return
  drag.moved = Math.max(
    drag.moved,
    Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY),
  )
  if (drag.mode === 'pan') {
    viewport.offsetX = drag.originX + (event.clientX - drag.startX)
    viewport.offsetY = drag.originY + (event.clientY - drag.startY)
    draw()
    return
  }
  const world = toWorld(event)
  const node = sim.nodes.find((n) => n.id === drag.id)
  if (!node) return
  node.x = world.x + drag.originX
  node.y = world.y + drag.originY
  node.vx = 0
  node.vy = 0
  reheat()
  draw()
}

function onPointerUp(event) {
  const canvas = canvasRef.value
  canvas?.releasePointerCapture?.(event.pointerId)
  if (drag.mode === 'node') {
    const node = sim?.nodes.find((n) => n.id === drag.id)
    if (node) node.pinned = false
    // 位移很小 = 用户其实是想"点"，不是想拖
    if (drag.moved < 5) selectNode(drag.id)
    reheat()
  } else if (drag.mode === 'pan' && drag.moved < 5 && selectedId.value) {
    // 点空白处 = 取消选中（真的拖动过画布就不算点击）
    selectedId.value = ''
    draw()
  }
  drag.mode = ''
  drag.id = ''
  drag.pointerId = -1
}

function onWheel(event) {
  if (!sim) return
  const rect = canvasRef.value.getBoundingClientRect()
  const px = event.clientX - rect.left
  const py = event.clientY - rect.top
  const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
  const next = Math.min(3, Math.max(0.35, viewport.scale * factor))
  // 让光标下的那个点在缩放前后待在原地
  const ratio = next / viewport.scale
  viewport.offsetX = px - (px - viewport.offsetX) * ratio
  viewport.offsetY = py - (py - viewport.offsetY) * ratio
  viewport.scale = next
  draw()
}

function zoomBy(factor) {
  const canvas = canvasRef.value
  const px = (canvas?.clientWidth || 800) / 2
  const py = (canvas?.clientHeight || 600) / 2
  const next = Math.min(3, Math.max(0.35, viewport.scale * factor))
  const ratio = next / viewport.scale
  viewport.offsetX = px - (px - viewport.offsetX) * ratio
  viewport.offsetY = py - (py - viewport.offsetY) * ratio
  viewport.scale = next
  draw()
}

function resetView() {
  viewport.scale = 1
  viewport.offsetX = 0
  viewport.offsetY = 0
  draw()
}

function relayout() {
  if (!graph.value) return
  buildSimulation()
}

function selectNode(id) {
  selectedId.value = selectedId.value === id ? '' : id
  draw()
}

/* ─────────────────────────── 点节点 → 筛题 → 进练习 ─────────────────────────── */

/**
 * 用知识点关联的标签起一个会话。
 * 走的是 store 既有的 startSession + filterQuestions（和首页组卷同一条路径），
 * 所以图谱里的"相关题目"和练习里的题一定是同一批。
 */
function practice(mode = 'seq') {
  const rel = related.value
  if (!rel || !rel.ids.length) {
    ElMessage.warning('这个知识点还没对应到题目')
    return
  }
  const ok = quiz.startSession({ mode, filters: { tags: [...rel.tags] } })
  if (!ok) {
    ElMessage.warning(mode === 'wrong' ? '这个知识点下还没有错题' : '没有可用题目')
    return
  }
  router.push('/practice')
}

/** 从列表里点某一道题：起会话后直接跳到那一题，省得用户自己翻 */
function practiceAt(qid) {
  const rel = related.value
  if (!rel || !rel.ids.includes(qid)) return
  if (!quiz.startSession({ mode: 'seq', filters: { tags: [...rel.tags] } })) {
    ElMessage.warning('没有可用题目')
    return
  }
  const index = quiz.queue.indexOf(qid)
  if (index > 0) quiz.goTo(index)
  router.push('/practice')
}

/* ─────────────────────────── 生命周期 ─────────────────────────── */

let observer = null

/**
 * 观察画布容器尺寸。
 *
 * 直接挂在元素上、刷新页面直接进 #/graph 时，App 恢复题库是异步的 ——
 * 这时 canvas 还没渲染出来（模板里是 v-else 分支），所以在题库加载后要重新挂一次。
 */
function attachObserver() {
  const wrap = wrapRef.value
  if (!wrap || typeof ResizeObserver === 'undefined') return
  if (!observer) observer = new ResizeObserver(() => syncCanvasSize())
  observer.disconnect()
  observer.observe(wrap)
}

onMounted(() => {
  readPalette()
  attachObserver()
  syncCanvasSize()
})

onBeforeUnmount(() => {
  stopLoop()
  observer?.disconnect()
  observer = null
})

// 换题库：作废旧图谱，并把画布重新挂上（题库是异步恢复的，首次进来可能还没有 canvas）
watch(
  () => bank.meta?.id,
  async () => {
    graph.value = null
    sim = null
    errorText.value = ''
    generatedLabel.value = ''
    selectedId.value = ''
    await nextTick()
    readPalette()
    attachObserver()
    syncCanvasSize()
  },
)

// 换主题：CSS 变量变了，canvas 读不到，得重抄一份再画
watch(
  () => quiz.settings.theme,
  () => {
    readPalette()
    draw()
  },
  { flush: 'post' },
)

// 图谱存在时，节点统计依赖 quiz.history —— 做完题回来颜色要跟着变
watch(stats, () => draw(), { flush: 'post' })
</script>

<template>
  <div class="q-wrap q-gp">
    <header class="q-gp__head">
      <div>
        <h1 class="q-gp__title">知识图谱</h1>
        <p class="q-gp__sub q-dim">
          <template v-if="bank.meta">《{{ bank.meta.title }}》· </template>
          让模型把题目归纳成概念网络，节点颜色是正确率、大小是做题量、红环是有错题。
        </p>
      </div>
      <el-button text @click="router.push('/')">
        <el-icon style="margin-right: 4px"><HomeFilled /></el-icon>回题库
      </el-button>
    </header>

    <!-- ─────────── 控制条 ─────────── -->
    <section class="q-card q-gp__panel">
      <div class="q-gp__panel-row">
        <span class="q-gp__label">归纳范围</span>
        <el-select v-model="scope" size="default" class="q-gp__select" :disabled="loading">
          <el-option v-for="s in SCOPES" :key="s.value" :label="s.label" :value="s.value">
            <span>{{ s.label }}</span>
            <span class="q-dim q-gp__opt-hint">{{ s.hint }}</span>
          </el-option>
        </el-select>
        <span class="q-dim q-gp__pool">可归纳 {{ poolSize }} 道（单次最多 {{ GRAPH_MAX_QUESTIONS }} 道）</span>
        <span v-if="scope === 'wrong' && !poolSize" class="q-chip q-chip--warn">错题本是空的</span>
      </div>

      <div class="q-gp__panel-row">
        <el-button type="primary" :loading="loading" @click="generate">
          <el-icon v-if="!loading" style="margin-right: 5px"><MagicStick /></el-icon>
          {{ graph ? '重新生成' : '生成知识图谱' }}
        </el-button>
        <span v-if="loading" class="q-dim">
          正在让模型归纳…本机小模型可能要一两分钟，别关页面。
        </span>
        <span v-else-if="generatedLabel" class="q-dim">{{ generatedLabel }}</span>
        <span v-else class="q-dim">
          归纳是 AI 接口，需要有后端；没有后端时这个页面只显示空态，刷题不受影响。
        </span>
      </div>

      <ul v-if="graph?.warnings?.length" class="q-gp__warn">
        <li v-for="(w, i) in graph.warnings" :key="i">
          <el-icon :size="12"><WarningFilled /></el-icon>{{ w }}
        </li>
      </ul>
      <p v-if="!hasHistory && graph" class="q-gp__note">
        <el-icon :size="12"><WarningFilled /></el-icon>
        这台浏览器还没有作答记录，所以节点全是灰色 —— 先刷几道题，颜色才有意义。
      </p>
      <p v-if="errorText" class="q-gp__error">
        <el-icon :size="13"><WarningFilled /></el-icon>
        <span>{{ errorText }}</span>
        <em class="q-dim">（后端地址 {{ apiBase() }}，生成失败不影响刷题和报告）</em>
      </p>
    </section>

    <!-- ─────────── 没题库 ─────────── -->
    <section v-if="!bank.meta" class="q-card q-gp__empty q-pop">
      <span class="q-gp__empty-icon"><el-icon :size="30"><Share /></el-icon></span>
      <h2>还没选题库</h2>
      <p class="q-dim">先去首页选一套题库（或导入一份 JSON），再回来生成知识图谱。</p>
      <el-button type="primary" size="large" @click="router.push('/')">去选题库</el-button>
    </section>

    <template v-else>
      <!-- ─────────── 画布 + 侧栏 ─────────── -->
      <section class="q-gp__main">
        <div class="q-card q-gp__canvas-card">
          <div class="q-gp__tools">
            <el-button size="small" :disabled="!graph" @click="relayout">
              <el-icon style="margin-right: 4px"><RefreshRight /></el-icon>重排
            </el-button>
            <el-button size="small" :disabled="!graph" @click="zoomBy(1.15)">
              <el-icon><ZoomIn /></el-icon>
            </el-button>
            <el-button size="small" :disabled="!graph" @click="zoomBy(1 / 1.15)">
              <el-icon><ZoomOut /></el-icon>
            </el-button>
            <el-button size="small" :disabled="!graph" @click="resetView">
              <el-icon style="margin-right: 4px"><Aim /></el-icon>复位
            </el-button>
            <span class="q-dim q-gp__zoom q-num">{{ zoomText }}</span>
            <span class="q-dim q-gp__tip">拖动节点可调整位置 · 滚轮缩放 · 拖空白处平移</span>
          </div>

          <div ref="wrapRef" class="q-gp__stage">
            <canvas
              ref="canvasRef"
              class="q-gp__canvas"
              @pointerdown="onPointerDown"
              @pointermove="onPointerMove"
              @pointerup="onPointerUp"
              @pointercancel="onPointerUp"
              @wheel.prevent="onWheel"
            ></canvas>

            <!-- 空态盖在画布上（而不是销毁 canvas，省得反复挂载/卸载） -->
            <div v-if="!graph" class="q-gp__stage-empty">
              <el-icon :size="30"><Share /></el-icon>
              <b>{{ loading ? '正在归纳…' : '还没有图谱' }}</b>
              <p class="q-dim">
                {{
                  loading
                    ? '模型正在读题目、归纳概念，请稍等'
                    : '点上面的「生成知识图谱」，AI 会把当前范围里的题目归纳成概念网络'
                }}
              </p>
            </div>
          </div>

          <!-- 图例 -->
          <div class="q-gp__legend">
            <span class="q-gp__legend-item">
              <i class="q-gp__dot" :style="{ background: UNKNOWN_COLOR }"></i>还没做过
            </span>
            <span v-for="(color, i) in LEVEL_COLORS" :key="i" class="q-gp__legend-item">
              <i class="q-gp__dot" :style="{ background: color }"></i>{{ levelLabel(i) }}
            </span>
            <span class="q-gp__legend-item">
              <i class="q-gp__ring"></i>还有错题
            </span>
            <span class="q-dim q-gp__legend-note">节点越大 = 做过的题越多、错题越多</span>
          </div>
        </div>

        <!-- 侧栏 -->
        <aside class="q-gp__side">
          <!-- 选中的知识点 -->
          <div class="q-card q-gp__box">
            <template v-if="selectedNode">
              <div class="q-gp__box-head">
                <span class="q-chip q-chip--brand">{{ selectedNode.kind }}</span>
                <h3 class="q-gp__box-title">{{ selectedNode.label }}</h3>
              </div>

              <div class="q-gp__metrics">
                <div class="q-gp__metric">
                  <b class="q-num" :style="{ color: colorOf(selectedNode.id) }">
                    {{ selectedStat && selectedStat.n ? `${selectedStat.accuracy}%` : '—' }}
                  </b>
                  <span>正确率</span>
                </div>
                <div class="q-gp__metric">
                  <b class="q-num">{{ selectedStat?.n || 0 }}</b><span>做过</span>
                </div>
                <div class="q-gp__metric">
                  <b class="q-num" :style="{ color: selectedStat?.wrong ? 'var(--q-bad)' : '' }">
                    {{ selectedStat?.wrong || 0 }}
                  </b>
                  <span>错题</span>
                </div>
              </div>

              <p class="q-dim q-gp__match">
                {{
                  selectedStat && selectedStat.tag
                    ? `对应标签「${selectedStat.tag}」`
                    : '这个知识点没有对上题库标签，统计按猜算——先看它相邻概念的题'
                }}
                <template v-if="related?.neighborTags?.length">
                  · 含相邻知识点 {{ related.neighborTags.length }} 个
                </template>
              </p>

              <div class="q-gp__acts">
                <el-button
                  type="primary"
                  :disabled="!related || !related.ids.length"
                  @click="practice('seq')"
                >
                  <el-icon style="margin-right: 4px"><VideoPlay /></el-icon>
                  刷这个知识点（{{ related?.ids?.length || 0 }} 题）
                </el-button>
                <el-button
                  :disabled="!selectedStat || !selectedStat.wrong"
                  @click="practice('wrong')"
                >
                  只练错题{{ selectedStat?.wrong ? `（${selectedStat.wrong}）` : '' }}
                </el-button>
              </div>

              <ul v-if="relatedPreview.length" class="q-gp__qlist">
                <li v-for="q in relatedPreview" :key="q.id">
                  <button class="q-gp__qitem" @click="practiceAt(q.id)">
                    <span class="q-num q-dim">{{ q.no }}</span>
                    <span class="q-gp__qstem">{{ q.stem }}</span>
                  </button>
                </li>
              </ul>
              <p v-else class="q-dim q-gp__qempty">这个知识点（含相邻概念）暂时没筛到题目。</p>
            </template>

            <template v-else>
              <h3 class="q-gp__box-title">点一个知识点</h3>
              <p class="q-dim q-gp__match">
                点画布上的节点，就能看到它的正确率、错题数，并直接筛出相关题目开始刷。
              </p>
            </template>
          </div>

          <!-- 最该补的知识点 -->
          <div class="q-card q-gp__box">
            <h3 class="q-gp__box-title">最该补的知识点</h3>
            <p v-if="!weakList.length" class="q-dim q-gp__match">
              还没有足够的作答数据 —— 做过题之后，这里会按「正确率缺口 + 错题数」排出来。
            </p>
            <ul v-else class="q-gp__weak">
              <li v-for="item in weakList" :key="item.id">
                <button
                  class="q-gp__weak-item"
                  :class="{ 'is-active': item.id === selectedId }"
                  @click="selectNode(item.id)"
                >
                  <i class="q-gp__dot" :style="{ background: colorOf(item.id) }"></i>
                  <span class="q-gp__weak-name">{{ item.label }}</span>
                  <span class="q-num q-dim">{{ item.accuracy }}%</span>
                  <span class="q-num q-gp__weak-wrong">错 {{ item.wrong }}</span>
                </button>
              </li>
            </ul>
          </div>
        </aside>
      </section>
    </template>
  </div>
</template>

<style scoped>
.q-gp {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ---------- 头部 ---------- */
.q-gp__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.q-gp__title {
  font-size: 22px;
  font-weight: 850;
  letter-spacing: -0.01em;
}
.q-gp__sub {
  margin-top: 6px;
  font-size: 12.5px;
  line-height: 1.7;
  max-width: 760px;
}

/* ---------- 控制条 ---------- */
.q-gp__panel {
  display: flex;
  flex-direction: column;
  gap: 11px;
  padding: 14px 16px;
}
.q-gp__panel-row {
  display: flex;
  align-items: center;
  gap: 11px;
  flex-wrap: wrap;
}
.q-gp__label {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--q-text-3);
}
.q-gp__select {
  width: min(300px, 100%);
}
.q-gp__opt-hint {
  float: right;
  margin-left: 14px;
  font-size: 11.5px;
}
.q-gp__pool {
  font-size: 12px;
}
.q-gp__warn {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--q-warn);
}
.q-gp__warn li {
  display: flex;
  align-items: center;
  gap: 6px;
}
.q-gp__note {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--q-warn);
}
.q-gp__error {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  padding: 9px 12px;
  border-radius: var(--q-r-sm);
  background: var(--q-bad-bg);
  color: var(--q-bad);
  font-size: 12.5px;
  line-height: 1.6;
}
.q-gp__error em {
  font-style: normal;
  font-size: 11.5px;
}

/* ---------- 空态 ---------- */
.q-gp__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 46px 20px;
  text-align: center;
}
.q-gp__empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 62px;
  height: 62px;
  border-radius: 20px;
  background: var(--q-grad-soft);
  color: var(--q-brand-1);
}
.q-gp__empty h2 {
  font-size: 17px;
  font-weight: 800;
}
.q-gp__empty p {
  font-size: 13px;
  max-width: 460px;
  line-height: 1.7;
}

/* ---------- 主区 ---------- */
.q-gp__main {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 322px;
  gap: 14px;
  align-items: start;
}

.q-gp__canvas-card {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.q-gp__tools {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border-bottom: 1px solid var(--q-border);
}
.q-gp__zoom {
  font-size: 12px;
  min-width: 42px;
}
.q-gp__tip {
  font-size: 11.5px;
  margin-left: auto;
}

.q-gp__stage {
  position: relative;
  height: clamp(380px, 56vh, 640px);
  background:
    radial-gradient(680px 340px at 50% 0%, rgba(99, 102, 241, 0.07), transparent 70%),
    var(--q-surface);
}
.q-gp__canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
}
.q-gp__canvas:active {
  cursor: grabbing;
}
.q-gp__stage-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  text-align: center;
  color: var(--q-text-3);
  padding: 0 24px;
}
.q-gp__stage-empty b {
  font-size: 14.5px;
  color: var(--q-text);
}
.q-gp__stage-empty p {
  font-size: 12.5px;
  line-height: 1.7;
  max-width: 380px;
}

.q-gp__legend {
  display: flex;
  align-items: center;
  gap: 13px;
  flex-wrap: wrap;
  padding: 9px 13px;
  border-top: 1px solid var(--q-border);
  font-size: 11.5px;
  color: var(--q-text-2);
}
.q-gp__legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.q-gp__legend-note {
  margin-left: auto;
  font-size: 11px;
}
.q-gp__dot {
  width: 9px;
  height: 9px;
  border-radius: 99px;
  flex: 0 0 auto;
}
.q-gp__ring {
  width: 9px;
  height: 9px;
  border-radius: 99px;
  border: 1.5px dashed var(--q-bad);
  flex: 0 0 auto;
}

/* ---------- 侧栏 ---------- */
.q-gp__side {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.q-gp__box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 15px;
}
.q-gp__box-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.q-gp__box-title {
  font-size: 14.5px;
  font-weight: 800;
  line-height: 1.4;
  word-break: break-word;
}
.q-gp__metrics {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 7px;
}
.q-gp__metric {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 9px 4px;
  border-radius: var(--q-r-sm);
  background: var(--q-surface-2);
  border: 1px solid var(--q-border);
}
.q-gp__metric b {
  font-size: 17px;
  font-weight: 800;
  line-height: 1.1;
}
.q-gp__metric span {
  font-size: 11px;
  color: var(--q-text-3);
}
.q-gp__match {
  font-size: 12px;
  line-height: 1.7;
}
.q-gp__acts {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.q-gp__acts :deep(.el-button + .el-button) {
  margin-left: 0;
}
.q-gp__qlist {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 210px;
  overflow-y: auto;
}
.q-gp__qitem {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--q-r-xs);
  background: transparent;
  color: var(--q-text-2);
  font: inherit;
  font-size: 12px;
  line-height: 1.55;
  text-align: left;
  cursor: pointer;
  transition: background var(--q-dur) var(--q-ease);
}
.q-gp__qitem:hover {
  background: var(--q-surface-2);
  color: var(--q-text);
}
.q-gp__qstem {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.q-gp__qempty {
  font-size: 12px;
}

.q-gp__weak {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.q-gp__weak-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border: 0;
  border-radius: var(--q-r-xs);
  background: transparent;
  color: var(--q-text);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  transition: background var(--q-dur) var(--q-ease);
}
.q-gp__weak-item:hover,
.q-gp__weak-item.is-active {
  background: var(--q-surface-2);
}
.q-gp__weak-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.q-gp__weak-wrong {
  font-size: 11px;
  color: var(--q-bad);
}

@media (max-width: 980px) {
  .q-gp__main {
    grid-template-columns: minmax(0, 1fr);
  }
  .q-gp__stage {
    height: clamp(320px, 52vh, 520px);
  }
  .q-gp__tip {
    display: none;
  }
}
</style>
