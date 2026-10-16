<script setup>
/**
 * DiagramView —— 图笔记：手画概念图，能导出 / 导入 Mermaid。
 *
 * 分工（**别在视图里重复实现逻辑**）
 * --------------------------------
 * 图的增删改、命中检测、撤销栈、Mermaid 互转全在 core/diagram.js 里，
 * 而且已经被 tests/test_engine.mjs 的 F 段断言过。这个文件只做三件事：
 *   1. 把 diagram 画到 canvas 上（形状 / 箭头 / 边标签 / 折行文字）；
 *   2. 把鼠标键盘事件翻译成 core 的那几个函数调用；
 *   3. 把新图交回 store（quiz.setDiagram），**视图里不碰 localStorage**。
 *
 * 为什么撤销栈留在视图里
 * ----------------------
 * 它是"这次打开页面做了哪些动作"的临时状态，刷新后本来也不该恢复；
 * 而写盘（localStorage）走 store — setDiagram 里做了 300ms 防抖，
 * 画布拖拽时每帧都调也不会卡。
 *
 * 踩过的坑（写在这儿免得下次再踩）
 * ------------------------------
 *  · canvas 读不到 CSS 变量，颜色只能 getComputedStyle 抄一份；换主题要重抄。
 *  · 文字必须用 nodeMetrics().lines 来画，行高必须和 core 的 LINE_H（20）一致：
 *    方块尺寸是 core 按 20px 行高算的，视图要是自己折行、自己定行高，
 *    文字就会溢出方框（F8 那条断言说的就是这件事）。
 *  · 空态是**盖在画布上**的，所以必须 pointer-events:none —— 否则
 *    「双击空白处新建节点」的那一下会被空态这一层吃掉。这是本页最容易踩的坑。
 *  · 全局快捷键里第一件事就是判断 event.target 是不是输入控件：
 *    在 Mermaid 输入框里按 Delete / Ctrl+Z 不能把画布上的节点删掉。
 *  · 拖拽过程中**不记历史**（否则拖一次鼠标会往撤销栈里塞几十格），
 *    松手时用 pointerdown 时存的快照记一步。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useBankStore } from '@/stores/bank'
import { useQuizStore } from '@/stores/quiz'
import {
  SHAPES,
  SHAPE_LABEL,
  addEdge,
  addNode,
  canRedo,
  canUndo,
  contentBounds,
  createHistory,
  edgeAnchor,
  fromMermaid,
  handleCenter,
  hitTest,
  moveNode,
  nodeMetrics,
  record,
  redo,
  redoLabel,
  removeEdge,
  removeNode,
  setEdgeLabel,
  setNodeShape,
  setNodeText,
  toMermaid,
  undo,
  undoLabel,
} from '@/core/diagram'

const bank = useBankStore()
const quiz = useQuizStore()
const router = useRouter()

/* ═══════════════════════════ 撤销 / 重做 ═══════════════════════════ */

/** 撤销栈是可变对象（core 里说的），不是响应式的；按钮的可用状态靠下面两个 ref 顶 */
const history = createHistory()
const canUndoNow = ref(false)
const canRedoNow = ref(false)
const undoHint = ref('')
const redoHint = ref('')

function syncHistory() {
  canUndoNow.value = canUndo(history)
  canRedoNow.value = canRedo(history)
  undoHint.value = undoLabel(history)
  redoHint.value = redoLabel(history)
}

/**
 * 所有"编辑动作"的唯一入口。
 *
 * 约定：`next` 必须是 core/diagram.js 算出来的**新对象**（那些函数不改旧对象）。
 * 被 core 拒绝的改动（空文字、自环、重复边…）会返回同一个对象，
 * 这时 `next === quiz.diagram`，直接返回 —— 不给撤销栈塞一步"什么都没变"的历史。
 *
 * @returns {boolean} 图有没有真的变
 */
function applyEdit(next, label) {
  if (!next || next === quiz.diagram) return false
  record(history, quiz.diagram, label) // 快照存「改之前」的图
  quiz.setDiagram(next)
  needFit = false // 用户一动手，就别再自动"把内容摆到中间"了
  syncHistory()
  return true
}

function doUndo() {
  const step = undo(history, quiz.diagram)
  if (!step) {
    ElMessage({ message: '没有可撤销的操作了', duration: 1200, grouping: true })
    return
  }
  quiz.setDiagram(step.diagram)
  pruneSelection()
  syncHistory()
  draw()
  ElMessage({ message: `已撤销：${step.label || '上一步'}`, duration: 1200, grouping: true })
}

function doRedo() {
  const step = redo(history, quiz.diagram)
  if (!step) {
    ElMessage({ message: '没有可重做的操作了', duration: 1200, grouping: true })
    return
  }
  quiz.setDiagram(step.diagram)
  pruneSelection()
  syncHistory()
  draw()
  ElMessage({ message: `已重做：${step.label || '下一步'}`, duration: 1200, grouping: true })
}

/* ═══════════════════════════ 选中 ═══════════════════════════ */

/** { type: 'node' | 'edge', id } 或 null */
const selection = ref(null)

const selectedNode = computed(() => {
  const sel = selection.value
  if (!sel || sel.type !== 'node') return null
  return quiz.diagram.nodes.find((n) => n.id === sel.id) || null
})

/** 撤销/重做之后选中的东西可能已经不存在了（删掉的节点又"回来"、或反过来） */
function pruneSelection() {
  const sel = selection.value
  if (!sel) return
  const pool = sel.type === 'node' ? quiz.diagram.nodes : quiz.diagram.edges
  if (!pool.some((x) => x.id === sel.id)) selection.value = null
}

function deleteSelected() {
  const sel = selection.value
  if (!sel) {
    ElMessage({ message: '先点一下画布上的节点或边，再删', duration: 1400, grouping: true })
    return
  }
  // 删节点时 core 会把挂在它身上的边一起删掉，这里不用自己清
  const ok =
    sel.type === 'node'
      ? applyEdit(removeNode(quiz.diagram, sel.id), '删除节点')
      : applyEdit(removeEdge(quiz.diagram, sel.id), '删除边')
  if (ok) {
    selection.value = null
    draw()
  }
}

function applyShape(shape) {
  const node = selectedNode.value
  if (!node) {
    ElMessage({ message: '先点一个节点，再改形状', duration: 1400, grouping: true })
    return
  }
  applyEdit(setNodeShape(quiz.diagram, node.id, shape), '改形状')
  draw()
}

/* ═══════════════════════════ 画布与视图变换 ═══════════════════════════ */

const wrapRef = ref(null)
const canvasRef = ref(null)

/** 视图变换：世界坐标 → 屏幕坐标 = 乘 scale 再加 offset。和 core 的坐标约定分开管 */
const viewport = reactive({ scale: 1, x: 0, y: 0 })
const zoomText = computed(() => `${Math.round(viewport.scale * 100)}%`)

const SCALE_MIN = 0.35
const SCALE_MAX = 3

/** 第一次拿到内容时把视野摆正（只在"本来没东西可点"的时候做，见 maybeFit） */
let needFit = true

/** 连边时那根虚线的当前端点（世界坐标）。故意不做成 ref：draw 是手动调的 */
let linkPoint = null
/** 鼠标悬停在哪个节点的手柄上（只为了画出"这里能拖"的反馈） */
let hoverHandleId = ''

const FONT = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
/** 和 core/diagram.js 的 LINE_H 必须一致（见文件头注释） */
const LINE_H = 20

/** 调色板：canvas 读不到 CSS 变量，只能抄一份；换主题时重抄 */
const palette = reactive({
  text: '#1a1f2e',
  text2: '#5b6478',
  surface: '#ffffff',
  line: 'rgba(26, 31, 46, 0.3)',
  brand: '#6366f1',
  dot: 'rgba(26, 31, 46, 0.12)',
})

function readPalette() {
  if (typeof window === 'undefined') return
  const cs = getComputedStyle(document.documentElement)
  const pick = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback
  palette.text = pick('--q-text', '#1a1f2e')
  palette.text2 = pick('--q-text-2', '#5b6478')
  palette.surface = pick('--q-surface', '#ffffff')
  palette.line = pick('--q-border-strong', 'rgba(26, 31, 46, 0.3)')
  palette.brand = pick('--q-brand-1', '#6366f1')
  palette.dot = pick('--q-border', 'rgba(26, 31, 46, 0.12)')
}

function toWorld(event) {
  const canvas = canvasRef.value
  if (!canvas) return { x: 0, y: 0 }
  const rect = canvas.getBoundingClientRect()
  return {
    x: (event.clientX - rect.left - viewport.x) / viewport.scale,
    y: (event.clientY - rect.top - viewport.y) / viewport.scale,
  }
}

/** 上一次的画布像素尺寸，用来在容器变宽/变窄时把视野中心跟着挪 */
let lastSize = { w: 0, h: 0 }

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
  // 窗口变窄（或手机转屏）时画布也变小，视野中心跟着挪半个差值 ——
  // 不这么做的话，原来摆在中间的内容会从右边滑出去，看着像"图丢了"
  if (lastSize.w && (width !== lastSize.w || height !== lastSize.h)) {
    viewport.x += (width - lastSize.w) / 2
    viewport.y += (height - lastSize.h) / 2
  }
  lastSize = { w: width, h: height }
  draw()
}

/** 复位：回到 100%，并把内容摆到画布中间（内容为空时就是左上角原点） */
function resetView() {
  const canvas = canvasRef.value
  viewport.scale = 1
  const d = quiz.diagram
  if (canvas && d.nodes.length) {
    const b = contentBounds(d)
    viewport.x = canvas.clientWidth / 2 - (b.x + b.w / 2)
    viewport.y = canvas.clientHeight / 2 - (b.y + b.h / 2)
  } else {
    viewport.x = 0
    viewport.y = 0
  }
  draw()
}

/**
 * 只在"画布本来就空"的时候摆一次视野（比如刷新后从 localStorage 读回一张图）。
 * 用户双击建第一个节点时不能再摆 —— 那会把刚点出来的节点甩到屏幕中间，
 * 手动验收和自动化都会点空。
 */
function maybeFit() {
  if (!needFit || !quiz.diagram.nodes.length) return
  needFit = false
  syncCanvasSize()
  resetView()
}

function clampScale(v) {
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, v))
}

function zoomBy(factor) {
  const canvas = canvasRef.value
  const px = (canvas?.clientWidth || 800) / 2
  const py = (canvas?.clientHeight || 600) / 2
  const next = clampScale(viewport.scale * factor)
  const ratio = next / viewport.scale
  viewport.x = px - (px - viewport.x) * ratio
  viewport.y = py - (py - viewport.y) * ratio
  viewport.scale = next
  draw()
}

/* ═══════════════════════════ 绘制 ═══════════════════════════ */

function arrowHead(ctx, from, to) {
  const ang = Math.atan2(to.y - from.y, to.x - from.x)
  const size = 9
  ctx.beginPath()
  ctx.moveTo(to.x, to.y)
  ctx.lineTo(to.x - size * Math.cos(ang - 0.42), to.y - size * Math.sin(ang - 0.42))
  ctx.lineTo(to.x - size * Math.cos(ang + 0.42), to.y - size * Math.sin(ang + 0.42))
  ctx.closePath()
  ctx.fillStyle = ctx.strokeStyle
  ctx.fill()
}

/** 形状路径。判据要和 core 的 pointInNode 一致，否则"看着在里面却选不中" */
function shapePath(ctx, n) {
  const hw = n.w / 2
  const hh = n.h / 2
  ctx.beginPath()
  if (n.shape === 'circle') {
    ctx.ellipse(n.x, n.y, hw || 1, hh || 1, 0, 0, Math.PI * 2)
  } else if (n.shape === 'diamond') {
    ctx.moveTo(n.x, n.y - hh)
    ctx.lineTo(n.x + hw, n.y)
    ctx.lineTo(n.x, n.y + hh)
    ctx.lineTo(n.x - hw, n.y)
    ctx.closePath()
  } else if (n.shape === 'round') {
    const x = n.x - hw
    const y = n.y - hh
    const w = n.w
    const h = n.h
    const r = Math.min(16, hw, hh)
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + w - r, y)
    ctx.quadraticCurveTo(x + w, y, x + w, y + r)
    ctx.lineTo(x + w, y + h - r)
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
    ctx.lineTo(x + r, y + h)
    ctx.quadraticCurveTo(x, y + h, x, y + h - r)
    ctx.lineTo(x, y + r)
    ctx.quadraticCurveTo(x, y, x + r, y)
    ctx.closePath()
  } else {
    ctx.rect(n.x - hw, n.y - hh, n.w, n.h)
  }
}

function drawNodeText(ctx, n) {
  const metrics = nodeMetrics(n)
  ctx.fillStyle = palette.text
  ctx.font = `600 13px ${FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  let y = n.y - ((metrics.lines.length - 1) * LINE_H) / 2
  for (const line of metrics.lines) {
    ctx.fillText(line, n.x, y)
    y += LINE_H
  }
}

function drawEdgeLabel(ctx, x, y, label) {
  const text = label.length > 16 ? `${label.slice(0, 16)}…` : label
  ctx.font = `500 11.5px ${FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const w = ctx.measureText(text).width
  // 标签底下垫一块底色，不然线和字叠在一起看不清
  ctx.fillStyle = palette.surface
  ctx.globalAlpha = 0.92
  ctx.fillRect(x - w / 2 - 5, y - 9, w + 10, 18)
  ctx.globalAlpha = 1
  ctx.fillStyle = palette.text2
  ctx.fillText(text, x, y)
}

function drawGrid(ctx, width, height) {
  if (viewport.scale < 0.45) return // 缩得太小时点会糊成一片
  const step = 26 * viewport.scale
  const ox = viewport.x % step
  const oy = viewport.y % step
  ctx.fillStyle = palette.dot
  for (let x = ox; x < width; x += step) {
    for (let y = oy; y < height; y += step) ctx.fillRect(x, y, 1.4, 1.4)
  }
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
  drawGrid(ctx, width, height)

  ctx.save()
  ctx.translate(viewport.x, viewport.y)
  ctx.scale(viewport.scale, viewport.scale)

  const d = quiz.diagram
  const byId = new Map(d.nodes.map((n) => [n.id, n]))
  const sel = selection.value

  /* ---------- 边（先画，压在节点下面） ---------- */
  for (const e of d.edges) {
    const a = byId.get(e.from)
    const b = byId.get(e.to)
    if (!a || !b) continue // 理论上不会有（core 删节点时清了边），脏数据也不至于炸
    const p1 = edgeAnchor(a, b.x, b.y)
    const p2 = edgeAnchor(b, a.x, a.y)
    const active = sel?.type === 'edge' && sel.id === e.id
    ctx.strokeStyle = active ? palette.brand : palette.line
    ctx.lineWidth = active ? 2.4 : 1.6
    ctx.beginPath()
    ctx.moveTo(p1.x, p1.y)
    ctx.lineTo(p2.x, p2.y)
    ctx.stroke()
    arrowHead(ctx, p1, p2)
    if (e.label) drawEdgeLabel(ctx, (p1.x + p2.x) / 2, (p1.y + p2.y) / 2, e.label)
  }

  /* ---------- 正在拖出来的那条虚线 ---------- */
  if (drag.mode === 'link' && linkPoint) {
    const from = byId.get(drag.id)
    if (from) {
      const start = handleCenter(from)
      ctx.save()
      ctx.setLineDash([5, 4])
      ctx.strokeStyle = palette.brand
      ctx.lineWidth = 1.8
      ctx.beginPath()
      ctx.moveTo(start.x, start.y)
      ctx.lineTo(linkPoint.x, linkPoint.y)
      ctx.stroke()
      ctx.restore()
    }
  }

  /* ---------- 节点 ---------- */
  for (const n of d.nodes) {
    const selected = sel?.type === 'node' && sel.id === n.id

    // 选中：先描一圈品牌色光晕
    if (selected) {
      shapePath(ctx, n)
      ctx.save()
      ctx.shadowColor = 'rgba(99, 102, 241, 0.5)'
      ctx.shadowBlur = 16
      ctx.fillStyle = palette.surface
      ctx.fill()
      ctx.restore()
    }

    shapePath(ctx, n)
    ctx.fillStyle = palette.surface
    ctx.fill()
    ctx.strokeStyle = selected ? palette.brand : palette.line
    ctx.lineWidth = selected ? 2.4 : 1.6
    ctx.stroke()

    // 连边手柄：画在节点右边一丁点，和 core 的 handleCenter 是同一个点
    const h = handleCenter(n)
    ctx.beginPath()
    ctx.arc(h.x, h.y, 4.6, 0, Math.PI * 2)
    ctx.fillStyle = selected || hoverHandleId === n.id ? palette.brand : palette.line
    ctx.fill()
    ctx.strokeStyle = palette.surface
    ctx.lineWidth = 1.2
    ctx.stroke()

    drawNodeText(ctx, n)
  }

  ctx.restore()
}

/* ═══════════════════════════ 鼠标交互 ═══════════════════════════ */

/**
 * 拖拽状态机。刻意**不做成响应式**：每帧改一次的东西塞进 Vue 只会白烧性能。
 * mode: '' | 'node'（拖节点）| 'pan'（拖空白）| 'link'（拖手柄连边）
 */
const drag = {
  mode: '',
  id: '',
  pointerId: -1,
  moved: 0,
  startX: 0,
  startY: 0,
  grabX: 0, // 抓取点相对节点中心的偏移（世界坐标）
  grabY: 0,
  panX: 0,
  panY: 0,
  before: null, // 拖动前的快照 —— 松手时用它记一步历史
  hit: null, // 空白按下时命中的东西（可能是边），松手没动就选中它
}

function updateCursor(w) {
  const canvas = canvasRef.value
  if (!canvas) return
  const hit = hitTest(quiz.diagram, w.x, w.y)
  const hoverId = hit && hit.type === 'handle' ? hit.id : ''
  if (hoverId !== hoverHandleId) {
    hoverHandleId = hoverId
    draw()
  }
  canvas.style.cursor =
    hit?.type === 'handle' ? 'crosshair' : hit?.type === 'node' ? 'move' : hit?.type === 'edge' ? 'pointer' : 'grab'
}

function onPointerDown(event) {
  if (event.button !== 0) return
  const canvas = canvasRef.value
  if (!canvas) return
  canvas.setPointerCapture?.(event.pointerId)

  const w = toWorld(event)
  const hit = hitTest(quiz.diagram, w.x, w.y)

  drag.mode = ''
  drag.id = ''
  drag.hit = null
  drag.before = null
  drag.moved = 0
  drag.startX = event.clientX
  drag.startY = event.clientY
  drag.pointerId = event.pointerId

  if (hit && hit.type === 'handle') {
    // 手柄优先级最高（core 的 hitTest 也是这么排的）
    drag.mode = 'link'
    drag.id = hit.id
    linkPoint = w
    selection.value = { type: 'node', id: hit.id }
  } else if (hit && hit.type === 'node') {
    const node = quiz.diagram.nodes.find((n) => n.id === hit.id)
    drag.mode = 'node'
    drag.id = hit.id
    drag.grabX = node.x - w.x
    drag.grabY = node.y - w.y
    drag.before = quiz.diagram
    selection.value = { type: 'node', id: hit.id }
  } else {
    drag.mode = 'pan'
    drag.panX = viewport.x
    drag.panY = viewport.y
    drag.hit = hit
  }
  draw()
}

function onPointerMove(event) {
  if (!drag.mode) {
    updateCursor(toWorld(event))
    return
  }
  drag.moved = Math.max(
    drag.moved,
    Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY),
  )

  if (drag.mode === 'pan') {
    viewport.x = drag.panX + (event.clientX - drag.startX)
    viewport.y = drag.panY + (event.clientY - drag.startY)
    draw()
    return
  }

  const w = toWorld(event)
  if (drag.mode === 'node') {
    // 取整：省得存一堆小数点，也避免亚像素抖动
    const x = Math.round(w.x + drag.grabX)
    const y = Math.round(w.y + drag.grabY)
    const next = moveNode(quiz.diagram, drag.id, x, y)
    if (next !== quiz.diagram) quiz.setDiagram(next)
    draw()
    return
  }

  if (drag.mode === 'link') {
    linkPoint = w
    draw()
  }
}

function onPointerUp(event) {
  const canvas = canvasRef.value
  canvas?.releasePointerCapture?.(event.pointerId)
  const mode = drag.mode

  if (mode === 'node') {
    // 拖动过程没记历史，这里补一步；没真的变过（点了一下没动）就不记
    if (drag.before && quiz.diagram !== drag.before) {
      record(history, drag.before, '移动节点')
      syncHistory()
    }
  } else if (mode === 'link') {
    const w = toWorld(event)
    const hit = hitTest(quiz.diagram, w.x, w.y)
    // 手柄也算（拖到目标节点的手柄上松手，意思很清楚）
    const toId = hit && hit.type !== 'edge' ? hit.id : ''
    if (toId && toId !== drag.id) {
      const before = quiz.diagram
      const next = addEdge(quiz.diagram, drag.id, toId)
      if (next === before) {
        ElMessage({ message: '这两个节点之间已经有一条边了', duration: 1600, grouping: true })
      } else {
        applyEdit(next, '连接节点')
      }
    }
    linkPoint = null
  } else if (mode === 'pan' && drag.moved < 4) {
    // 位移很小 = 用户其实是在"点"空白处：点到边就选中它，否则取消选中
    selection.value = drag.hit?.type === 'edge' ? { type: 'edge', id: drag.hit.id } : null
  }

  drag.mode = ''
  drag.id = ''
  drag.pointerId = -1
  drag.before = null
  drag.hit = null
  drag.moved = 0
  updateCursor(toWorld(event))
  draw()
}

function onWheel(event) {
  const canvas = canvasRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const px = event.clientX - rect.left
  const py = event.clientY - rect.top
  const next = clampScale(viewport.scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12))
  // 让光标下的那个点在缩放前后待在原地
  const ratio = next / viewport.scale
  viewport.x = px - (px - viewport.x) * ratio
  viewport.y = py - (py - viewport.y) * ratio
  viewport.scale = next
  draw()
}

function onDblClick(event) {
  const w = toWorld(event)
  const hit = hitTest(quiz.diagram, w.x, w.y)
  if (hit && hit.type === 'edge') {
    startEdit('edge', hit.id)
    return
  }
  if (hit) {
    // ⚠️ 这里必须连 handler 一起认（hit.type === 'handle'）：手柄就在节点右边
    // 2px 处、命中半径 11px，而 hitTest 又是手柄优先 —— 只认 'node' 的话，
    // 双击节点靠右的位置会凭空掉出一个新节点（踩过）。
    startEdit('node', hit.id)
    return
  }
  // 空白处：立刻落一个节点（findFreeSpot 会躲开已有节点），再让用户双击它改名。
  // 这里刻意不自动弹出改名框：那样焦点会被输入框抢走，
  // 紧接着的第二次双击（或 Delete）就不落在画布上了。
  const next = addNode(quiz.diagram, { text: '新节点', x: Math.round(w.x), y: Math.round(w.y) })
  const created = next.nodes[next.nodes.length - 1]
  if (!created) return
  if (applyEdit(next, '新建节点')) {
    selection.value = { type: 'node', id: created.id }
    ElMessage({ message: '已新建节点 · 双击它改名', duration: 1600, grouping: true })
    draw()
  }
}

/* ═══════════════════════════ 就地改名 ═══════════════════════════ */

/** { kind: 'node' | 'edge', id, text } —— 就地输入框，不用弹对话框（不挡画布） */
const editing = ref(null)
const editRef = ref(null)
/** Esc 取消时置位：紧接着的 blur 不该再提交一次 */
let skipCommit = false

function edgeMidWorld(edge) {
  const byId = new Map(quiz.diagram.nodes.map((n) => [n.id, n]))
  const a = byId.get(edge.from)
  const b = byId.get(edge.to)
  if (!a || !b) return null
  const p1 = edgeAnchor(a, b.x, b.y)
  const p2 = edgeAnchor(b, a.x, a.y)
  return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
}

function startEdit(kind, id) {
  const d = quiz.diagram
  if (kind === 'node') {
    const n = d.nodes.find((x) => x.id === id)
    if (!n) return
    editing.value = { kind, id, text: n.text }
  } else {
    const e = d.edges.find((x) => x.id === id)
    if (!e) return
    editing.value = { kind, id, text: e.label || '' }
    selection.value = { type: 'edge', id }
  }
  skipCommit = false
  nextTick(() => {
    editRef.value?.focus()
    editRef.value?.select?.()
    draw()
  })
}

/** 输入框跟着节点/边跑（画布缩放平移时也要跟着） */
const editStyle = computed(() => {
  const ed = editing.value
  if (!ed) return {}
  let cx = 0
  let cy = 0
  let width = 150
  if (ed.kind === 'node') {
    const n = quiz.diagram.nodes.find((x) => x.id === ed.id)
    if (!n) return {}
    cx = n.x
    cy = n.y
    width = Math.min(320, Math.max(130, n.w))
  } else {
    const e = quiz.diagram.edges.find((x) => x.id === ed.id)
    const mid = e ? edgeMidWorld(e) : null
    if (!mid) return {}
    cx = mid.x
    cy = mid.y
  }
  return {
    left: `${viewport.x + cx * viewport.scale}px`,
    top: `${viewport.y + cy * viewport.scale}px`,
    width: `${Math.max(96, Math.round(width * viewport.scale))}px`,
  }
})

function commitEdit() {
  const ed = editing.value
  if (!ed) return
  if (skipCommit) {
    skipCommit = false
    return
  }
  editing.value = null
  if (ed.kind === 'node') {
    const node = quiz.diagram.nodes.find((x) => x.id === ed.id)
    if (!node) return
    const text = String(ed.text ?? '').trim()
    if (!text) {
      ElMessage({ message: '节点名不能为空（要删就选中它按 Delete）', duration: 1800, grouping: true })
      return
    }
    if (text !== node.text) applyEdit(setNodeText(quiz.diagram, ed.id, text), '改文字')
  } else {
    const edge = quiz.diagram.edges.find((x) => x.id === ed.id)
    if (!edge) return
    const label = String(ed.text ?? '').trim()
    if (label !== edge.label) applyEdit(setEdgeLabel(quiz.diagram, ed.id, label), '改边标签')
  }
  draw()
}

function cancelEdit() {
  skipCommit = true
  editing.value = null
  draw()
}

/* ═══════════════════════════ 快捷键 ═══════════════════════════ */

/**
 * 用**小写**的键名比较，别写 event.key 和 Delete 这种大写字面量的直接相等。
 *
 * 为什么：quiz/tools/check_sfc.mjs 会把源码里单引号包起来的 PascalCase 字符串
 * 统统当成"组件名"去核对（它不剥注释、也不区分模板还是逻辑），
 * Delete / INPUT 这类词会被误报成"未注册的组件"。全用小写就绕开了。
 * （下面 TYPING_TAGS 的键也故意不加引号，同一个原因。）
 */
const TYPING_TAGS = { INPUT: 1, TEXTAREA: 1, SELECT: 1 }

function isTyping(target) {
  if (!target) return false
  return TYPING_TAGS[target.tagName] === 1 || target.isContentEditable === true
}

function onKeydown(event) {
  // 在输入框 / 文本域里打字时一律不抢键 —— 否则在 Mermaid 框里按 Delete
  // 会顺手删掉画布上选中的节点，Ctrl+Z 也会把输入框的撤销吃掉
  if (isTyping(event.target)) return

  const mod = event.ctrlKey || event.metaKey
  const key = String(event.key || '').toLowerCase()

  if (mod && key === 'z') {
    event.preventDefault()
    if (event.shiftKey) doRedo()
    else doUndo()
    return
  }
  if (mod && key === 'y') {
    event.preventDefault()
    doRedo()
    return
  }
  if (key === 'delete' || key === 'backspace') {
    if (!selection.value) return
    event.preventDefault()
    deleteSelected()
    return
  }
  if (key === 'escape' && selection.value) {
    selection.value = null
    draw()
  }
}

/* ═══════════════════════════ Mermaid 导出 / 导入 ═══════════════════════════ */

const mermaidRef = ref(null)
const importText = ref('')
const importWarnings = ref([])

/** 只读文本框的内容 = toMermaid(diagram)，纯函数，可以直接放 computed */
const mermaidText = computed(() => toMermaid(quiz.diagram))

async function copyMermaid() {
  const text = mermaidText.value
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(`已复制 Mermaid（${quiz.diagramNodeCount} 个节点、${quiz.diagramEdgeCount} 条边）`)
  } catch {
    // 浏览器不给写剪贴板（非安全上下文 / 没授权）：帮用户选中，让他自己按 Ctrl+C
    mermaidRef.value?.focus()
    mermaidRef.value?.select?.()
    ElMessage.warning('浏览器不让写剪贴板，已帮你选中文本，按 Ctrl+C 复制')
  }
}

function importFromText() {
  const text = String(importText.value ?? '')
  if (!text.trim()) {
    ElMessage.warning('先把 Mermaid 文本贴进「导入」下面的框里')
    return
  }

  // fromMermaid 是"宽容优先"的（解析不了的语句收进 warnings，不抛错），
  // 这里再兜一层 try：万一以后它改了行为，页面也不能白屏
  let parsed = null
  try {
    parsed = fromMermaid(text)
  } catch (e) {
    parsed = null
    importWarnings.value = []
    ElMessage.error(`解析这段 Mermaid 时出错了：${e?.message || e}`)
    return
  }

  if (!parsed || !parsed.nodes.length) {
    importWarnings.value = []
    ElMessage.error('这段文本里没解析出节点。要 Mermaid 的 flowchart，例如：A[甲] --> B[乙]')
    return
  }

  importWarnings.value = parsed.warnings || []
  // 只存 nodes / edges（warnings 是给提示用的，不该混进图里）；
  // 走 applyEdit 是为了让这次导入也能被 Ctrl+Z 撤回
  applyEdit({ nodes: parsed.nodes, edges: parsed.edges }, '导入 Mermaid')
  selection.value = null
  editing.value = null
  nextTick(() => {
    // 导入的图是 autoLayout 排好的，复位一下视野才看得到
    resetView()
  })
  ElMessage.success(`已导入 ${parsed.nodes.length} 个节点、${parsed.edges.length} 条边`)
}

/* ═══════════════════════════ 生命周期 ═══════════════════════════ */

let observer = null

/**
 * 观察画布容器尺寸。直接刷新进 #/diagram 时，App 恢复题库、quiz.init 读回图
 * 都是异步的，所以换题库之后要重新挂一次观察器。
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
  nextTick(maybeFit)
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  window.removeEventListener('keydown', onKeydown)
})

// 换题库：图也跟着换（store 里每套题库一张）。撤销栈跟着作废 —— 它属于上一张图
watch(
  () => bank.meta?.id,
  async () => {
    history.past.length = 0
    history.future.length = 0
    selection.value = null
    editing.value = null
    importWarnings.value = []
    importText.value = ''
    linkPoint = null
    needFit = true
    syncHistory()
    await nextTick()
    readPalette()
    attachObserver()
    syncCanvasSize()
    maybeFit()
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

// store 里的图变了就重画（拖拽、撤销、导入、换题库读回图都走这条）
watch(
  () => quiz.diagram,
  () => {
    pruneSelection()
    maybeFit()
    draw()
  },
  { flush: 'post' },
)
</script>

<template>
  <div class="q-wrap q-dg">
    <header class="q-dg__head">
      <div>
        <h1 class="q-dg__title">图笔记</h1>
        <p class="q-dg__sub q-dim">
          <template v-if="bank.meta">《{{ bank.meta.title }}》· </template>
          自己画概念图：双击空白处落节点、拖节点整理位置、从节点右边的小圆点拖到另一个节点连一条带箭头的边。
          画完能导出成 Mermaid 贴到笔记里，也能把现成的 Mermaid 导回来。
        </p>
      </div>
      <el-button text @click="router.push('/')">
        <el-icon style="margin-right: 4px"><HomeFilled /></el-icon>回题库
      </el-button>
    </header>

    <p v-if="!bank.meta" class="q-dg__notice">
      <el-icon :size="13"><WarningFilled /></el-icon>
      还没选题库 —— 图是按题库分开存的，先去首页选一套再回来画（现在画的内容会存到空题库名下）。
    </p>

    <!-- ─────────── 工具栏 + Mermaid 动作 ─────────── -->
    <section class="q-card q-dg__tools">
      <div class="q-dg__row">
        <el-button size="small" :disabled="!canUndoNow" @click="doUndo">撤销</el-button>
        <el-button size="small" :disabled="!canRedoNow" @click="doRedo">重做</el-button>
        <el-button size="small" @click="resetView">复位</el-button>
        <span class="q-dg__sep" aria-hidden="true"></span>
        <el-button size="small" type="danger" plain :disabled="!selection" @click="deleteSelected">
          删除
        </el-button>
        <span class="q-dg__label">形状</span>
        <el-button
          v-for="s in SHAPES"
          :key="s"
          size="small"
          :type="selectedNode && selectedNode.shape === s ? 'primary' : ''"
          :plain="!(selectedNode && selectedNode.shape === s)"
          :disabled="!selectedNode"
          @click="applyShape(s)"
        >
          {{ SHAPE_LABEL[s] }}
        </el-button>
        <span class="q-dg__sep" aria-hidden="true"></span>
        <el-button size="small" @click="zoomBy(1 / 1.15)">
          <el-icon><ZoomOut /></el-icon>
        </el-button>
        <el-button size="small" @click="zoomBy(1.15)">
          <el-icon><ZoomIn /></el-icon>
        </el-button>
        <span class="q-dim q-dg__zoom q-num">{{ zoomText }}</span>
        <span class="q-dg__count q-num">
          节点 {{ quiz.diagramNodeCount }} · 边 {{ quiz.diagramEdgeCount }}
        </span>
      </div>

      <div class="q-dg__row">
        <el-button size="small" text @click="copyMermaid">
          <el-icon style="margin-right: 4px"><DocumentCopy /></el-icon>复制 Mermaid
        </el-button>
        <el-button size="small" @click="importFromText">导入</el-button>
        <span class="q-dg__hint q-dim">
          <template v-if="undoHint">可撤销：{{ undoHint }} · </template>
          <template v-if="redoHint">可重做：{{ redoHint }} · </template>
          Ctrl+Z 撤销 · Ctrl+Y（或 Ctrl+Shift+Z）重做 · 选中后按 Delete 删除
        </span>
      </div>
    </section>

    <!-- ─────────── 画布 ─────────── -->
    <section class="q-card q-dg__stage-card">
      <div ref="wrapRef" class="q-dg__stage">
        <canvas
          ref="canvasRef"
          class="q-dg__canvas"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
          @dblclick="onDblClick"
          @wheel.prevent="onWheel"
        ></canvas>

        <!-- 空态：盖在画布上做引导。⚠️ 必须 pointer-events:none，
             否则"双击空白处建第一个节点"的那一下会被这一层吃掉 -->
        <div v-if="!quiz.hasDiagram" class="q-dg__empty">
          <span class="q-dg__empty-icon"><el-icon :size="24"><Share /></el-icon></span>
          <b>还没有图笔记，从双击开始</b>
          <p>
            在画布上<strong>双击空白处</strong>就会落下一个节点，双击节点改文字；<br />
            从节点右边的小圆点按住拖到另一个节点，就连出一条带箭头的边。
          </p>
          <p class="q-dim">
            滚轮缩放 · 拖空白处平移 · 点「复位」回到正中间 · 也可以直接粘一份 Mermaid 到下面的「导入」
          </p>
        </div>

        <!-- 就地改名：不用弹对话框，免得挡住画布 -->
        <input
          v-if="editing"
          ref="editRef"
          v-model="editing.text"
          class="q-dg__edit"
          :style="editStyle"
          spellcheck="false"
          @keydown.enter.prevent="commitEdit"
          @keydown.esc.prevent="cancelEdit"
          @blur="commitEdit"
        />
      </div>
    </section>

    <!-- ─────────── Mermaid 导出 / 导入 ─────────── -->
    <section class="q-card q-dg__io">
      <div class="q-dg__io-block">
        <div class="q-dg__io-head">
          <h3>导出 Mermaid</h3>
          <span class="q-dim q-dg__io-tag">只读</span>
        </div>
        <textarea
          ref="mermaidRef"
          class="q-dg__mermaid-text"
          readonly
          spellcheck="false"
          rows="6"
          :value="mermaidText"
        ></textarea>
        <p class="q-dim q-dg__io-note">
          贴到支持 Mermaid 的地方（飞书 / 语雀 / GitHub / Obsidian）就能直接渲染成同一张图。
        </p>
      </div>

      <div class="q-dg__io-block">
        <div class="q-dg__io-head">
          <h3>导入 Mermaid</h3>
          <span class="q-dim q-dg__io-tag">覆盖当前画布</span>
        </div>
        <textarea
          v-model="importText"
          class="q-dg__import-text"
          spellcheck="false"
          rows="6"
          placeholder="flowchart TD&#10;  A[总概念] -->|包含| B(子概念)&#10;  B --> C{判断}"
        ></textarea>
        <ul v-if="importWarnings.length" class="q-dg__warns">
          <li v-for="(w, i) in importWarnings" :key="i">
            <el-icon :size="12"><WarningFilled /></el-icon>{{ w }}
          </li>
        </ul>
        <p v-else class="q-dim q-dg__io-note">
          导入会整张替换当前画布（不满意就 Ctrl+Z 撤回），节点位置会自动排好。
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.q-dg {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ---------- 头部 ---------- */
.q-dg__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.q-dg__title {
  font-size: 22px;
  font-weight: 850;
  letter-spacing: -0.01em;
}
.q-dg__sub {
  margin-top: 6px;
  font-size: 12.5px;
  line-height: 1.7;
  max-width: 760px;
}
.q-dg__notice {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 12px;
  border-radius: var(--q-r-sm);
  background: var(--q-warn-bg);
  color: var(--q-warn);
  font-size: 12.5px;
  line-height: 1.6;
}

/* ---------- 工具栏 ---------- */
.q-dg__tools {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 11px 13px;
}
.q-dg__row {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
/* Element Plus 默认给相邻按钮加 margin-left，和 flex 的 gap 叠起来会疏密不匀 */
.q-dg__row :deep(.el-button + .el-button) {
  margin-left: 0;
}
.q-dg__sep {
  width: 1px;
  height: 18px;
  margin: 0 3px;
  background: var(--q-border-strong);
}
.q-dg__label {
  font-size: 12px;
  font-weight: 700;
  color: var(--q-text-3);
}
.q-dg__zoom {
  font-size: 12px;
  min-width: 42px;
}
.q-dg__count {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--q-text-2);
  padding: 3px 10px;
  border-radius: var(--q-r-full);
  background: var(--q-surface-2);
  border: 1px solid var(--q-border);
}
.q-dg__hint {
  font-size: 11.5px;
  line-height: 1.6;
}

/* ---------- 画布 ---------- */
.q-dg__stage-card {
  overflow: hidden;
}
.q-dg__stage {
  position: relative;
  height: clamp(380px, 56vh, 640px);
  background:
    radial-gradient(680px 340px at 50% 0%, rgba(99, 102, 241, 0.07), transparent 70%),
    var(--q-surface);
}
.q-dg__canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
}
.q-dg__canvas:active {
  cursor: grabbing;
}

.q-dg__empty {
  position: absolute;
  inset: 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 0 22px;
  border: 1.5px dashed var(--q-border-strong);
  border-radius: var(--q-r);
  text-align: center;
  color: var(--q-text-3);
  /* ⚠️ 见模板上的注释：这层不能吃指针事件 */
  pointer-events: none;
}
.q-dg__empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  border-radius: 15px;
  background: var(--q-grad-soft);
  color: var(--q-brand-1);
}
.q-dg__empty b {
  font-size: 14.5px;
  color: var(--q-text);
}
.q-dg__empty p {
  font-size: 12.5px;
  line-height: 1.8;
  max-width: 460px;
}
.q-dg__empty strong {
  color: var(--q-brand-1);
}

.q-dg__edit {
  position: absolute;
  transform: translate(-50%, -50%);
  z-index: 2;
  padding: 5px 9px;
  border: 2px solid var(--q-brand-1);
  border-radius: 9px;
  background: var(--q-surface);
  color: var(--q-text);
  font: inherit;
  font-size: 13px;
  text-align: center;
  outline: none;
  box-shadow: var(--q-shadow-brand);
}

/* ---------- Mermaid ---------- */
.q-dg__io {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  padding: 14px 15px;
}
.q-dg__io-block {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}
.q-dg__io-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.q-dg__io-head h3 {
  font-size: 13.5px;
  font-weight: 800;
}
.q-dg__io-tag {
  font-size: 11.5px;
}
.q-dg__mermaid-text,
.q-dg__import-text {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--q-border);
  border-radius: var(--q-r-sm);
  background: var(--q-surface-2);
  color: var(--q-text);
  font-family: var(--q-mono);
  font-size: 12.5px;
  line-height: 1.65;
  resize: vertical;
}
.q-dg__mermaid-text {
  /* 只读框：颜色淡一点，一眼看出"这是给你复制的，不是给你改的" */
  color: var(--q-text-2);
  cursor: text;
}
.q-dg__import-text:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--q-brand-1) 55%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--q-brand-1) 14%, transparent);
}
.q-dg__io-note {
  font-size: 11.5px;
  line-height: 1.7;
}
.q-dg__warns {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 90px;
  overflow-y: auto;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--q-warn);
}
.q-dg__warns li {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

/* ---------- 窄屏 ---------- */
@media (max-width: 900px) {
  .q-dg__io {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 720px) {
  .q-dg__stage {
    height: clamp(320px, 52vh, 520px);
  }
  .q-dg__hint {
    display: none;
  }
}
@media (max-width: 480px) {
  .q-dg__tools {
    padding: 9px 10px;
  }
  .q-dg__row {
    gap: 5px;
  }
  .q-dg__label {
    display: none;
  }
  .q-dg__zoom {
    min-width: 0;
  }
}
</style>
