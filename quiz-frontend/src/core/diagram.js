/**
 * diagram.js —— 图笔记的纯逻辑层：数据模型 / 编辑操作 / 撤销栈 / Mermaid 互转。
 *
 * 为什么单独一层
 * --------------
 * 这里**不碰 Vue、不碰 DOM、不碰 canvas**，只做「图怎么变」和「怎么变成文本」。
 * 好处是能在 Node 里直接断言（tests/test_engine.mjs 的 F 段）——
 * 画布上的拖拽、命中、缩放是视图的事，logic 出错和渲染出错要能分开定位。
 *
 * 不可变约定（很重要）
 * --------------------
 * 所有 `addNode` / `moveNode` / ... 都**返回新的 diagram 对象，绝不改传入的那个**。
 * 两个理由：
 *   1. 撤销栈可以直接存旧对象的**引用**（不用深拷贝）—— 因为没人会去改它。
 *      节点/边数组按结构共享，拖一次鼠标只多分配一个小小的对象。
 *   2. Node 测试里对比「改之前 / 改之后」是天然成立的，不用先克隆。
 * 唯一的例外是 `createHistory` 出来的撤销栈本身：它是个可变的小容器。
 *
 * 坐标约定
 * --------
 * 节点的 `x, y` 是**中心点**（不是左上角）。圆的命中判定、连线的端点都从中心算最方便。
 * 尺寸 `w, h` 由 `nodeSize()` 从文字和形状算出来并**存在节点上**，
 * 这样命中检测不用每次重新估算文字宽度（估算函数不便宜，而且拖拽时每帧都要判）。
 */

/** 支持的四种形状。键是内部值，值是给用户看的字 */
export const SHAPES = ['rect', 'round', 'circle', 'diamond']

export const SHAPE_LABEL = {
  rect: '矩形',
  round: '圆角',
  circle: '圆形',
  diamond: '菱形',
}

/** 撤销栈上限。快照本身很小（结构共享），但也没必要无限留 */
export const HISTORY_LIMIT = 60

const MIN_W = 76 // 节点最小宽：再窄就放不下两个汉字
const MAX_W = 240 // 最大宽：超过就折行，不然一个长句会把画布撑爆
const MIN_H = 46
const PAD_X = 26
const PAD_Y = 20
const LINE_H = 20

// 文字宽度估算：不引测量库，也不想为了量字去建一个隐藏的 canvas。
// 中文/全角按 15px、其余按 8.5px —— 只用来定节点尺寸，不要求像素级精确。
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/

function charWidth(ch) {
  return CJK.test(ch) ? 15 : 8.5
}

/** 单行文本的估算宽度 */
export function textWidth(text) {
  let w = 0
  for (const ch of String(text ?? '')) w += charWidth(ch)
  return w
}

/**
 * 按最大宽度折行。返回行数组 —— **视图必须用它来画**，
 * 否则视图自己折一套、core 又按另一套算尺寸，文字就会溢出方框。
 */
export function wrapLines(text, maxWidth) {
  const source = String(text ?? '')
  const out = []
  for (const rawLine of source.split('\n')) {
    if (!rawLine) {
      out.push('')
      continue
    }
    let line = ''
    let width = 0
    for (const ch of rawLine) {
      const w = charWidth(ch)
      if (line && width + w > maxWidth) {
        out.push(line)
        line = ch
        width = w
      } else {
        line += ch
        width += w
      }
    }
    out.push(line)
  }
  return out.length ? out : ['']
}

/**
 * 节点尺寸。**只依赖文字和形状**，所以同样的内容永远得到同样的尺寸
 * （存进节点的 w/h 才能和它一致）。
 */
export function nodeSize(text, shape = 'rect') {
  const lines = wrapLines(text, MAX_W - PAD_X)
  const longest = lines.reduce((m, l) => Math.max(m, textWidth(l)), 0)
  let w = Math.max(MIN_W, Math.min(MAX_W, Math.ceil(longest + PAD_X)))
  let h = Math.max(MIN_H, lines.length * LINE_H + PAD_Y)
  if (shape === 'circle') {
    // 圆要能装下最长边：直径取两者的较大值
    const d = Math.max(w, h, 72)
    w = d
    h = d
  } else if (shape === 'diamond') {
    // 菱形内接矩形只有一半面积，不放大文字会顶到尖角外面
    w = Math.ceil(w * 1.3)
    h = Math.ceil(h * 1.35)
  }
  return { w, h }
}

/** 视图画一个节点要用的全部几何信息（尺寸 + 折好的行） */
export function nodeMetrics(node) {
  const { w, h } = nodeSize(node.text, node.shape)
  return { w, h, lines: wrapLines(node.text, w - PAD_X) }
}

export function emptyDiagram() {
  return { nodes: [], edges: [] }
}

/* ═══════════════════════════ id 生成 ═══════════════════════════ */

/**
 * 生成下一个不冲突的 id（`n1` / `e3` …）。
 *
 * 为什么不用时间戳或随机数：Mermaid 的节点 id 必须是 `[A-Za-z_][A-Za-z0-9_-]*`，
 * 而且导入别人的 Mermaid 时会带进来 `A`、`node1` 这类 id ——
 * 所以新 id 必须**扫一遍现有的**再取最大号 +1，不能自己从头数。
 */
export function nextId(diagram, prefix) {
  const re = new RegExp(`^${prefix}(\\d+)$`)
  let max = 0
  const pool = prefix === 'n' ? diagram.nodes.map((n) => n.id) : diagram.edges.map((e) => e.id)
  for (const id of pool) {
    const m = re.exec(String(id || ''))
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `${prefix}${max + 1}`
}

/* ═══════════════════════════ 节点操作 ═══════════════════════════ */

function makeNode(id, patch) {
  const text = String(patch.text ?? '').trim() || '新节点'
  const shape = SHAPES.includes(patch.shape) ? patch.shape : 'rect'
  const { w, h } = nodeSize(text, shape)
  return { id, text, shape, x: Number(patch.x) || 0, y: Number(patch.y) || 0, w, h }
}

/**
 * 找一个不和已有节点重叠的落点。
 * 双击空白处连点几下就会叠在一起，挪开一点体验好很多。
 */
export function findFreeSpot(diagram, x, y, size) {
  const w = size?.w ?? MIN_W
  const h = size?.h ?? MIN_H
  let px = x
  let py = y
  for (let guard = 0; guard < 40; guard++) {
    const hit = diagram.nodes.some(
      (n) => Math.abs(n.x - px) < (n.w + w) / 2 + 8 && Math.abs(n.y - py) < (n.h + h) / 2 + 8,
    )
    if (!hit) break
    px += 26
    py += 26
  }
  return { x: px, y: py }
}

export function addNode(diagram, patch = {}) {
  const id = patch.id && !diagram.nodes.some((n) => n.id === patch.id)
    ? patch.id
    : nextId(diagram, 'n')
  const probe = makeNode(id, patch)
  const spot = findFreeSpot(diagram, probe.x, probe.y, probe)
  return { ...diagram, nodes: [...diagram.nodes, { ...probe, ...spot }] }
}

/** 删节点时**必须把它连的边一起删**，否则会留下指向空气的边 */
export function removeNode(diagram, id) {
  if (!diagram.nodes.some((n) => n.id === id)) return diagram
  return {
    nodes: diagram.nodes.filter((n) => n.id !== id),
    edges: diagram.edges.filter((e) => e.from !== id && e.to !== id),
  }
}

export function moveNode(diagram, id, x, y) {
  let changed = false
  const nodes = diagram.nodes.map((n) => {
    if (n.id !== id) return n
    if (n.x === x && n.y === y) return n
    changed = true
    return { ...n, x, y }
  })
  return changed ? { ...diagram, nodes } : diagram
}

/** 改文字要顺带重算尺寸，否则文字会溢出/留大片空白 */
export function setNodeText(diagram, id, text) {
  const clean = String(text ?? '').trim()
  if (!clean) return diagram // 空文字不合法：节点必须有个名字，要删就删节点
  let changed = false
  const nodes = diagram.nodes.map((n) => {
    if (n.id !== id || n.text === clean) return n
    changed = true
    return { ...n, text: clean, ...nodeSize(clean, n.shape) }
  })
  return changed ? { ...diagram, nodes } : diagram
}

export function setNodeShape(diagram, id, shape) {
  if (!SHAPES.includes(shape)) return diagram
  let changed = false
  const nodes = diagram.nodes.map((n) => {
    if (n.id !== id || n.shape === shape) return n
    changed = true
    return { ...n, shape, ...nodeSize(n.text, shape) }
  })
  return changed ? { ...diagram, nodes } : diagram
}

/* ═══════════════════════════ 边操作 ═══════════════════════════ */

function makeEdge(id, from, to, label) {
  return { id, from, to, label: String(label ?? '').trim() }
}

/**
 * 加边。自环和重复边都拒绝（返回原对象）：
 * 自环在 Mermaid 里能写但语义上没意义，重复边会让导出出现两行一样的东西。
 */
export function addEdge(diagram, from, to, label = '') {
  if (!from || !to || from === to) return diagram
  const has = (id) => diagram.nodes.some((n) => n.id === id)
  if (!has(from) || !has(to)) return diagram
  if (diagram.edges.some((e) => e.from === from && e.to === to)) return diagram
  const id = nextId(diagram, 'e')
  return { ...diagram, edges: [...diagram.edges, makeEdge(id, from, to, label)] }
}

export function removeEdge(diagram, id) {
  if (!diagram.edges.some((e) => e.id === id)) return diagram
  return { ...diagram, edges: diagram.edges.filter((e) => e.id !== id) }
}

export function setEdgeLabel(diagram, id, label) {
  const clean = String(label ?? '').trim()
  let changed = false
  const edges = diagram.edges.map((e) => {
    if (e.id !== id || e.label === clean) return e
    changed = true
    return { ...e, label: clean }
  })
  return changed ? { ...diagram, edges } : diagram
}

/* ═══════════════════════════ 命中检测 ═══════════════════════════ */

/** 节点包围盒（左上角 + 尺寸） */
export function nodeBox(node) {
  return { x: node.x - node.w / 2, y: node.y - node.h / 2, w: node.w, h: node.h }
}

export function pointInNode(node, x, y) {
  const dx = Math.abs(x - node.x)
  const dy = Math.abs(y - node.y)
  const hw = node.w / 2
  const hh = node.h / 2
  if (node.shape === 'circle') {
    const rx = hw || 1
    const ry = hh || 1
    return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1
  }
  if (node.shape === 'diamond') {
    // 菱形：|dx|/hw + |dy|/hh <= 1。用包围盒判会让四个角"看着在外面却能选中"
    return dx / (hw || 1) + dy / (hh || 1) <= 1
  }
  return dx <= hw && dy <= hh
}

/** 连边手柄的中心点（画在节点右边，拖它就能拉出一条边） */
export function handleCenter(node) {
  return { x: node.x + node.w / 2 + 2, y: node.y }
}

export function hitHandle(diagram, x, y, radius = 11) {
  for (let i = diagram.nodes.length - 1; i >= 0; i--) {
    const h = handleCenter(diagram.nodes[i])
    if (Math.hypot(x - h.x, y - h.y) <= radius) return diagram.nodes[i]
  }
  return null
}

/** 点到线段的距离，用来判"点没点到这条边" */
export function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  if (!len2) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

/**
 * 点选。返回 `{ type: 'node' | 'edge', id }`，什么都没点到就返回 null。
 *
 * 优先级：手柄 > 节点 > 边。
 * 节点比边优先是必须的 —— 边常常从节点中心出发，节点下面那一段边如果先被命中，
 * 用户就永远选不中节点了。节点之间则按**倒序**（后画的在上面）。
 */
export function hitTest(diagram, x, y, { edgeTolerance = 7 } = {}) {
  const handle = hitHandle(diagram, x, y)
  if (handle) return { type: 'handle', id: handle.id }

  for (let i = diagram.nodes.length - 1; i >= 0; i--) {
    if (pointInNode(diagram.nodes[i], x, y)) return { type: 'node', id: diagram.nodes[i].id }
  }

  const byId = new Map(diagram.nodes.map((n) => [n.id, n]))
  for (let i = diagram.edges.length - 1; i >= 0; i--) {
    const e = diagram.edges[i]
    const a = byId.get(e.from)
    const b = byId.get(e.to)
    if (!a || !b) continue
    if (distanceToSegment(x, y, a.x, a.y, b.x, b.y) <= edgeTolerance) {
      return { type: 'edge', id: e.id }
    }
  }
  return null
}

/**
 * 箭头该停在节点边界的哪一点 —— 从节点中心朝 `(towardX, towardY)` 方向射出，
 * 和节点轮廓的交点。
 *
 * 为什么不直接连到中心：箭头会插进方框里，看着像"穿过节点"；
 * 而且多个节点连向同一个时，线头会重叠成一团。
 * 用轮廓交点之后，箭头正好贴在框边上。
 *
 * 判据和 pointInNode 是同一套（矩形按包围盒、圆按椭圆、菱形按内接），
 * 这样"线从哪儿出去"和"点在不在里面"永远一致 —— 不一致的话会出现
 * 线头落在框里、但框角又选不中的怪事。
 */
export function edgeAnchor(node, towardX, towardY) {
  const dx = towardX - node.x
  const dy = towardY - node.y
  if (!dx && !dy) return { x: node.x, y: node.y }
  const hw = node.w / 2 || 1
  const hh = node.h / 2 || 1
  let t
  if (node.shape === 'circle') {
    t = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2)
  } else if (node.shape === 'diamond') {
    t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh)
  } else {
    t = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh)
  }
  return { x: node.x + dx * t, y: node.y + dy * t }
}

/** 所有节点的包围盒，视图用它算"内容有多大多小" */export function contentBounds(diagram) {
  if (!diagram.nodes.length) return { x: 0, y: 0, w: 0, h: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of diagram.nodes) {
    const b = nodeBox(n)
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w)
    maxY = Math.max(maxY, b.y + b.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/* ═══════════════════════════ 自适应布局 ═══════════════════════════ */

/**
 * 给没有坐标的图排一个能看的位置（导入 Mermaid 时用）。
 *
 * 按入度分层（BFS）：没有入边的当第一层，指向它的当第二层……
 * 概念图基本都是这种"从总概念往外发散"的形状，比网格好看得多。
 * 有环时入度永远不为 0，那就退化成"按声明顺序取没排过的"。
 */
export function autoLayout(diagram, { colGap = 210, rowGap = 86, originX = 90, originY = 80 } = {}) {
  if (!diagram.nodes.length) return diagram

  const indeg = new Map(diagram.nodes.map((n) => [n.id, 0]))
  for (const e of diagram.edges) {
    if (indeg.has(e.to)) indeg.set(e.to, indeg.get(e.to) + 1)
  }

  const layer = new Map()
  let queue = diagram.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id)
  if (!queue.length) queue = [diagram.nodes[0].id]

  for (const id of queue) layer.set(id, 0)
  let head = 0
  while (head < queue.length) {
    const id = queue[head++]
    const depth = layer.get(id) || 0
    for (const e of diagram.edges) {
      if (e.from !== id) continue
      if (layer.has(e.to)) continue
      layer.set(e.to, depth + 1)
      queue.push(e.to)
    }
  }
  // 环里剩下的、或者从任何根都到不了的节点：接到最后一层后面，别让它们叠在 (0,0)
  let maxLayer = 0
  for (const v of layer.values()) maxLayer = Math.max(maxLayer, v)
  for (const n of diagram.nodes) {
    if (!layer.has(n.id)) {
      maxLayer += 1
      layer.set(n.id, maxLayer)
      queue.push(n.id)
    }
  }

  const columns = new Map()
  const nodes = diagram.nodes.map((n) => {
    const col = layer.get(n.id) || 0
    const row = columns.get(col) || 0
    columns.set(col, row + 1)
    return { ...n, x: originX + n.w / 2 + col * colGap, y: originY + n.h / 2 + row * rowGap }
  })
  return { ...diagram, nodes }
}

/* ═══════════════════════════ 容错归一化 ═══════════════════════════ */

/**
 * 把存进 localStorage 的东西收拾成合法图（脏数据不该让页面白屏）。
 * 返回的图保证：id 唯一非空、坐标是有限数、边两端都存在、自环/重复边已去掉。
 */
export function normalizeDiagram(raw) {
  const out = emptyDiagram()
  if (!raw || typeof raw !== 'object') return out
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : []
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : []

  const seen = new Set()
  for (const item of rawNodes) {
    if (!item || typeof item !== 'object') continue
    const id = String(item.id ?? '').trim()
    if (!id || seen.has(id)) continue
    const text = String(item.text ?? '').trim()
    if (!text) continue
    seen.add(id)
    const shape = SHAPES.includes(item.shape) ? item.shape : 'rect'
    const size = nodeSize(text, shape)
    const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback)
    out.nodes.push({
      id,
      text,
      shape,
      x: num(item.x, 0),
      y: num(item.y, 0),
      w: size.w,
      h: size.h,
    })
  }

  const ids = new Set(out.nodes.map((n) => n.id))
  const pairs = new Set()
  for (const item of rawEdges) {
    if (!item || typeof item !== 'object') continue
    const from = String(item.from ?? '')
    const to = String(item.to ?? '')
    if (!ids.has(from) || !ids.has(to) || from === to) continue
    const pair = `${from}\u0000${to}`
    if (pairs.has(pair)) continue
    pairs.add(pair)
    out.edges.push(makeEdge(String(item.id ?? '') || `e${out.edges.length + 1}`, from, to, item.label))
  }
  // 兜底：id 重复或空的话补一个
  const edgeIds = new Set()
  out.edges = out.edges.map((e, i) => {
    let id = e.id
    if (!id || edgeIds.has(id)) id = `e${i + 1}`
    while (edgeIds.has(id)) id = `${id}_`
    edgeIds.add(id)
    return { ...e, id }
  })
  return out
}

/* ═══════════════════════════ 撤销 / 重做 ═══════════════════════════ */

/**
 * 撤销栈（命令栈）：每格存「做这件事**之前**的图」+ 一句说明。
 *
 * 为什么快照不用深拷贝：diagram 是不可变的（见文件头注释），
 * 旧对象永远不会被改，所以直接存引用就是一份可靠的快照，而且省内存。
 *
 * 这个对象本身是**可变**的（push/pop），和 diagram 的不可变风格相反 ——
 * 因为它是"栈"，语义上就该是就地变化的。
 */
export function createHistory(limit = HISTORY_LIMIT) {
  return { past: [], future: [], limit }
}

/** 记录一步。`snapshot` 传**改动前**的图 */
export function record(history, snapshot, label = '') {
  history.past.push({ snapshot, label })
  if (history.past.length > history.limit) {
    history.past.splice(0, history.past.length - history.limit)
  }
  // 一旦有了新动作，原来的重做链就作废了（这是撤销栈的通用语义）
  history.future.length = 0
  return history
}

/** @returns {{diagram:object,label:string}|null} null = 没得撤销了 */
export function undo(history, current) {
  if (!history.past.length) return null
  const entry = history.past.pop()
  history.future.push({ snapshot: current, label: entry.label })
  if (history.future.length > history.limit) {
    history.future.splice(0, history.future.length - history.limit)
  }
  return { diagram: entry.snapshot, label: entry.label }
}

export function redo(history, current) {
  if (!history.future.length) return null
  const entry = history.future.pop()
  history.past.push({ snapshot: current, label: entry.label })
  if (history.past.length > history.limit) {
    history.past.splice(0, history.past.length - history.limit)
  }
  return { diagram: entry.snapshot, label: entry.label }
}

export function canUndo(history) {
  return history.past.length > 0
}

export function canRedo(history) {
  return history.future.length > 0
}

export function undoLabel(history) {
  return history.past.length ? history.past[history.past.length - 1].label : ''
}

export function redoLabel(history) {
  return history.future.length ? history.future[history.future.length - 1].label : ''
}

/* ═══════════════════════════ Mermaid 导出 / 导入 ═══════════════════════════ */

/**
 * 文字转义。**必须是双射**，否则「导出→导入往返一致」会假通过。
 *
 * 规则：`& # " < >` 各自换成一个 Mermaid 实体码。
 * 关键点是**单趟**替换（用一个正则 + 映射表），不是连续 replace：
 * 连续替换的话，先 `#`→`#35;` 再 `"`→`#quot;`，无法反过来区分
 * "用户本来就写了 #quot;" 和 "引号转义出来的 #quot;"。
 *     `#`  → `#35;`      （35 是 # 的 ASCII 码）
 *     `&`  → `#38;`
 *     `"`  → `#quot;`
 *     `<`  → `#60;`
 *     `>`  → `#62;`
 * 解码同样用**一趟**正则，所以不会被二次解码。
 *
 * 换行会被压成一个空格 —— 这是唯一有损的地方（Mermaid 的节点标签本来是单行的）。
 * 视图里编辑文字用的是单行输入框，所以正常操作不会碰到。
 */
const ESC_MAP = { '#': '#35;', '&': '#38;', '"': '#quot;', '<': '#60;', '>': '#62;' }
const UNESC_MAP = { '#35;': '#', '#38;': '&', '#quot;': '"', '#60;': '<', '#62;': '>' }

export function escapeLabel(text) {
  return String(text ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/[#&"<>]/g, (ch) => ESC_MAP[ch])
}

export function unescapeLabel(text) {
  return String(text ?? '').replace(/#(35|38|quot|60|62);/g, (m) => UNESC_MAP[m])
}

/** 形状 → Mermaid 的括号对（导出用） */
const SHAPE_BRACKETS = {
  rect: ['[', ']'],
  round: ['(', ')'],
  circle: ['((', '))'],
  diamond: ['{', '}'],
}

/**
 * Mermaid 括号 → 形状（导入用）：`[开头, 收尾, 形状]`。
 * ⚠️ `((` 必须排在 `(` 前面：否则 `n1((圆))` 会被当成"圆角节点 + 剩下的 (圆))"。
 */
const BRACKET_SHAPES = [
  ['((', '))', 'circle'],
  ['[', ']', 'rect'],
  ['(', ')', 'round'],
  ['{', '}', 'diamond'],
]

export function toMermaid(diagram, { direction = 'TD' } = {}) {
  const lines = [`flowchart ${direction}`]
  // Mermaid 的 id 不能带中文，而我们的 id 本来就是 n1/e1 这种，直接用
  for (const n of diagram.nodes) {
    const [open, close] = SHAPE_BRACKETS[n.shape] || SHAPE_BRACKETS.rect
    lines.push(`  ${n.id}${open}"${escapeLabel(n.text)}"${close}`)
  }
  for (const e of diagram.edges) {
    const label = e.label ? `|"${escapeLabel(e.label)}"|` : ''
    lines.push(`  ${e.from} -->${label} ${e.to}`)
  }
  return lines.join('\n')
}

/** 从一段文本里读一个 id：`[A-Za-z_][A-Za-z0-9_-]*` */
function readId(text, pos) {
  const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(text.slice(pos))
  if (!m) return null
  return { id: m[0], next: pos + m[0].length }
}

/** 读一个标签：`"..."` 或读到匹配的收尾括号 */
function readLabel(text, pos, closer) {
  if (text[pos] === '"') {
    const end = text.indexOf('"', pos + 1)
    if (end === -1) return { label: text.slice(pos + 1), next: text.length }
    return { label: text.slice(pos + 1, end), next: end + 1 }
  }
  const end = text.indexOf(closer, pos)
  if (end === -1) return { label: text.slice(pos), next: text.length }
  return { label: text.slice(pos, end), next: end }
}

/**
 * 解析一个「节点引用」：可能只是 id，也可能带形状声明。
 * 顺手把遇到的节点声明记进 nodes（Mermaid 允许边里直接写 `A[文本] --> B`）。
 */
function parseNodeRef(text, pos, nodes) {
  const lead = /^\s*/.exec(text.slice(pos))[0].length
  pos += lead
  const read = readId(text, pos)
  if (!read) return null
  let { id, next } = read

  // 形状：按 BRACKET_SHAPES 的顺序试（`((` 在 `(` 前面）
  const rest = text.slice(next)
  let matched = null
  for (const [open, close, shape] of BRACKET_SHAPES) {
    if (!rest.startsWith(open)) continue
    const inner = next + open.length
    const { label } = readLabel(text, inner, close)
    matched = { shape, label: unescapeLabel(label.trim()) }
    break
  }
  if (matched) {
    const existing = nodes.find((n) => n.id === id)
    if (existing) {
      // 后声明的覆盖先声明的（和 Mermaid 自己的行为一致）
      existing.text = matched.label
      existing.shape = matched.shape
    } else {
      nodes.push({ id, text: matched.label, shape: matched.shape })
    }
  } else if (!nodes.some((n) => n.id === id)) {
    // 裸 id：先占个位，等别处声明文字；一直没有就用 id 当文字
    nodes.push({ id, text: id, shape: 'rect', bare: true })
  }
  return { id, next }
}

/**
 * 找这一行里的箭头。返回 {index, length} 或 null。
 *
 * ⚠️ 必须**跳过引号和括号里**的内容：节点文字里带个连字符太常见了
 * （"马克思-列宁主义"、"2020-2021"），不跳过的话会被当成箭头，
 * 于是一行节点声明被切成两半，报出莫名其妙的错。
 */
function findArrow(text) {
  let inQuote = false
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      inQuote = !inQuote
      continue
    }
    if (inQuote) continue
    if (ch === '[' || ch === '(' || ch === '{') {
      depth++
      continue
    }
    if (ch === ']' || ch === ')' || ch === '}') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth > 0) continue
    const m = /^(-{1,3}>|={1,3}>|-\.->|-{2,3}|={2,3})/.exec(text.slice(i))
    if (m) return { index: i, length: m[0].length }
  }
  return null
}

/** 去掉 `%%` 注释，但**不要**动引号里的 `%%`（"完成率 %% 提升"这种文字要留住） */
function stripComment(line) {
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') inQuote = !inQuote
    else if (!inQuote && ch === '%' && line[i + 1] === '%') return line.slice(0, i)
  }
  return line
}

/**
 * 解析 Mermaid 文本成图。宽容优先：**不抛错**，解析不了的语句收进 warnings。
 *
 * 支持：`flowchart TD` / `graph LR` 头（可缺）、`id[文本]`、`id(文本)`、
 * `id((文本))`、`id{文本}`、`a --> b`、`a -->|标签| b`、`%%` 注释、空行、
 * 一行多条语句（分号分隔）、`;` 结尾。
 * 不支持（也不报错，只是当普通文字）：`subgraph`、`click`、样式类、`-- 文字 -->` 这种中置标签。
 */
export function fromMermaid(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const warnings = []
  const nodes = []
  const edges = []
  const edgeKeys = new Set()

  let sawHeader = false

  for (const rawLine of lines) {
    const line = stripComment(rawLine).trim()
    if (!line) continue

    // 头部：flowchart TD / graph LR / 光秃秃的 `flowchart`
    // ⚠️ 不能用「替换掉头再解析」的写法：`flowchart` 本身是合法 id
    // （[A-Za-z_][A-Za-z0-9_-]*），替换不干净就会凭空多出一个叫 flowchart 的节点。
    const header = /^(flowchart|graph)\b\s*([A-Za-z]{2})?\s*;?/i.exec(line)
    if (!sawHeader && header) {
      sawHeader = true
      const rest = line.slice(header[0].length).trim()
      if (!rest) continue
      parseStatements(rest, nodes, edges, edgeKeys, warnings)
      continue
    }

    parseStatements(line, nodes, edges, edgeKeys, warnings)
  }

  // 到这一步还没被赋文字的节点：用 id 当文字，并给个名分
  for (const n of nodes) {
    if (n.bare) {
      n.bare = false
      n.text = n.id
    }
  }

  const diagram = autoLayout({
    nodes: nodes.map((n) => {
      const shape = SHAPES.includes(n.shape) ? n.shape : 'rect'
      const size = nodeSize(n.text, shape)
      return { id: n.id, text: n.text, shape, x: 0, y: 0, w: size.w, h: size.h }
    }),
    edges: edges.map((e, i) => ({ id: `e${i + 1}`, from: e.from, to: e.to, label: e.label })),
  })

  // 悬空边（指向没声明过的节点）在上面已经被补成节点了，所以这里不会丢东西
  return { ...diagram, warnings }
}

function parseStatements(chunk, nodes, edges, edgeKeys, warnings) {
  // 一行里可能用分号写多条；但不能按分号硬切（引号里可能有分号）
  for (const piece of splitStatements(chunk)) {
    const stmt = piece.trim()
    if (!stmt) continue
    parseOne(stmt, nodes, edges, edgeKeys, warnings)
  }
}

function splitStatements(chunk) {
  const out = []
  let buf = ''
  let inQuote = false
  let depth = 0
  for (const ch of chunk) {
    if (ch === '"') inQuote = !inQuote
    if (!inQuote) {
      if (ch === '[' || ch === '(' || ch === '{') depth++
      else if (ch === ']' || ch === ')' || ch === '}') depth = Math.max(0, depth - 1)
      else if (ch === ';' && depth === 0) {
        out.push(buf)
        buf = ''
        continue
      }
    }
    buf += ch
  }
  out.push(buf)
  return out
}

function parseOne(stmt, nodes, edges, edgeKeys, warnings) {
  // 顶层的关键字（subgraph / classDef / style / click / linkStyle）直接跳过，
  // 它们不影响"有哪些节点和边"，硬解析反而容易把图的形状搞错
  if (/^(subgraph|end|classDef|class|style|click|linkStyle|direction)\b/i.test(stmt)) {
    return
  }

  const arrow = findArrow(stmt)
  if (!arrow) {
    const ref = parseNodeRef(stmt, 0, nodes)
    if (!ref) warnings.push(`看不懂的语句：${stmt.slice(0, 60)}`)
    return
  }

  const left = stmt.slice(0, arrow.index)
  let right = stmt.slice(arrow.index + arrow.length)

  // 边标签：`-->|标签|`（我们导出的就是这种），也可能带引号
  let label = ''
  const trimmedRight = right.replace(/^\s*/, '')
  if (trimmedRight.startsWith('|')) {
    const end = trimmedRight.indexOf('|', 1)
    if (end > 0) {
      label = unescapeLabel(trimmedRight.slice(1, end).trim().replace(/^"|"$/g, ''))
      right = trimmedRight.slice(end + 1)
    }
  }

  const from = parseNodeRef(left, 0, nodes)
  const to = parseNodeRef(right, 0, nodes)
  if (!from || !to) {
    warnings.push(`这条边看不懂，已跳过：${stmt.slice(0, 60)}`)
    return
  }
  if (from.id === to.id) return // 自环丢掉
  const key = `${from.id}\u0000${to.id}`
  if (edgeKeys.has(key)) return // 重复边丢掉
  edgeKeys.add(key)
  edges.push({ from: from.id, to: to.id, label })
}
