/**
 * state.js —— 「一份能跟着账号走的进度」：形状、怎么从 store 取出来、怎么放回去。
 *
 * 为什么单独一个模块（而不是写在 store 里）：
 *   ① 它是**纯数据搬运**，能在 Node 里直接断言（见 tests/test_engine.mjs 的 S 段）；
 *   ② 它必须和服务端 `renwu/backend/apps/quizgen/qstate.py` 的归一同构 ——
 *      两边形状一旦不一致，症状是"同步完错题本变空"，那是最贵的一类失败。
 *      所以这里的字段名和那边**一字不差**，改一边就必须改另一边。
 *
 * 同步哪些、不同步哪些（这个选择本身是产品判断，见 quiz/PRODUCT.md）：
 *   ✅ 作答/错题本/收藏/作答历史/笔记/题目修正/AI 解析/图笔记/上一次诊断结果
 *   ❌ 正在进行的练习（`session`）—— 那是"这台设备看到第几题"，跨设备续做会把人吓一跳
 *   ❌ 扫描件的预习材料（`lesson`）—— 几百 KB 的大块材料，不该跟着进度走
 *   ❌ 外观设置（主题/字号/音乐）—— 每台设备各自的偏好
 *
 * ★ 清空也要算数：`clearedAt` 记下"我什么时候清空过哪一类"，
 *   合并时用它当阈值，不然"清空了刷新又回来"（并集合并最容易做错的地方）。
 */

import { emptyDiagram, normalizeDiagram } from './diagram'
import { K, load, save } from './storage'

export const STATE_VERSION = 1

/** 有"清空时间戳"的五类东西（名字要和后端 qstate.BUCKETS 一致） */
export const BUCKETS = ['answers', 'wrong', 'fav', 'history', 'diagram']

export function emptyCleared() {
  return { answers: 0, wrong: 0, fav: 0, history: 0, diagram: 0 }
}

const num = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}
const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})
const arr = (value) => (Array.isArray(value) ? value : [])
const str = (value) => (typeof value === 'string' ? value : '')

/** 键是题号、值是对象的映射（answers / overrides） */
function mapOfObjects(raw) {
  const out = {}
  for (const [key, value] of Object.entries(obj(raw))) {
    if (value && typeof value === 'object' && !Array.isArray(value)) out[String(key)] = value
  }
  return out
}

/** 键是题号、值只有"在不在"（wrong / fav） */
function mapOfOnes(raw) {
  const out = {}
  for (const [key, value] of Object.entries(obj(raw))) {
    if (value === 0 || value === false || value === null || value === undefined || value === '') continue
    out[String(key)] = 1
  }
  return out
}

/**
 * 笔记是 `{ 题号: { text, ts, updatedAt } }`（前端 setNote 写的）。
 * ⚠️ 不是 `{ 题号: "文字" }` —— 第一版按字符串归一化，结果所有笔记在同步时被静默丢光。
 * 裸字符串仍然收下（手写的、老版本的），转成同样的对象形状。
 */
function normalizeNotes(raw) {
  const out = {}
  for (const [key, value] of Object.entries(obj(raw))) {
    if (typeof value === 'string') {
      if (value) out[String(key)] = { text: value, ts: 0, updatedAt: 0 }
      continue
    }
    const item = obj(value)
    const text = str(item.text)
    if (!text) continue
    out[String(key)] = { text, ts: num(item.ts), updatedAt: num(item.updatedAt) }
  }
  return out
}

function normalizeHistory(raw) {
  const out = []
  for (const row of arr(raw)) {
    const item = obj(row)
    const q = item.q
    const t = num(item.t)
    if (q === null || q === undefined || !t) continue // 没题号/没时间的历史没法去重，丢掉
    out.push({ q: String(q), ok: Number(item.ok) ? 1 : 0, t, ms: num(item.ms) })
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

/**
 * 把任意外来数据收敛成一份合法进度。
 * 为什么脏数据要能扛：这份东西来自 localStorage（可能被手工改坏、可能是上个大版本写的）
 * **也**来自服务端响应 —— 任何一处形状不对都不该让错题本页面白屏。
 */
export function normalizeState(raw) {
  const src = obj(raw)
  const progress = obj(src.progress)
  const cleared = obj(src.clearedAt)
  return {
    v: STATE_VERSION,
    progress: {
      answers: mapOfObjects(progress.answers),
      wrong: mapOfOnes(progress.wrong),
      fav: mapOfOnes(progress.fav),
      favAt: Object.fromEntries(
        Object.entries(obj(progress.favAt))
          .map(([k, v]) => [String(k), num(v)])
          .filter(([, v]) => v),
      ),
      //: 删掉某条笔记的时间（按题号）。删单条笔记不能用"清空阈值"表达 ——
      //: 那会把别的笔记一起判死。见后端 qstate.py 的 merge 注释。
      notesRemoved: Object.fromEntries(
        Object.entries(obj(progress.notesRemoved))
          .map(([k, v]) => [String(k), num(v)])
          .filter(([, v]) => v),
      ),
      updatedAt: num(progress.updatedAt),
    },
    history: normalizeHistory(src.history),
    notes: normalizeNotes(src.notes),
    overrides: mapOfObjects(src.overrides),
    analyses: Object.fromEntries(
      Object.entries(obj(src.analyses))
        .map(([k, v]) => [String(k), str(v)])
        .filter(([, v]) => v),
    ),
    diagram: { nodes: arr(obj(src.diagram).nodes), edges: arr(obj(src.diagram).edges) },
    diagnose: obj(src.diagnose),
    clearedAt: Object.fromEntries(BUCKETS.map((b) => [b, num(cleared[b])])),
    diagramAt: num(src.diagramAt),
  }
}

/** 这一份进度里有没有"学生的东西"（空的那份不许覆盖账号里的） */
export function stateIsEmpty(state) {
  const s = normalizeState(state)
  const p = s.progress
  if (Object.keys(p.answers).length || Object.keys(p.wrong).length || Object.keys(p.fav).length) return false
  if (s.history.length || Object.keys(s.notes).length || Object.keys(s.analyses).length) return false
  if (Object.keys(s.overrides).length || Object.keys(s.diagnose).length) return false
  return !(s.diagram.nodes.length || s.diagram.edges.length)
}

/** 序列化后多大（只用来给界面显示 / 兜住明显不正常的推送，服务端才是硬上限） */
export function stateSize(state) {
  try {
    return JSON.stringify(normalizeState(state)).length
  } catch {
    return 0
  }
}

/**
 * 把 store 里"该同步的那些"整块取出来。
 * @param {object} store useQuizStore() 的实例（对象形状即可，Node 里也能喂普通对象）
 */
export function collectState(store) {
  const s = store || {}
  return normalizeState({
    v: STATE_VERSION,
    progress: {
      answers: s.answers,
      wrong: s.wrong,
      fav: s.fav,
      favAt: s.favAt,
      notesRemoved: s.notesRemoved,
      updatedAt: s.progressUpdatedAt || Date.now(),
    },
    history: s.history,
    notes: s.notes,
    overrides: s.overrides,
    analyses: s.analyses,
    diagram: s.diagram,
    // 上一次「诊断先行」的结果存在 localStorage 里（不在 store 上），这里顺手带上
    diagnose: s.bankId ? load(K.diagnose(s.bankId), null) || {} : {},
    clearedAt: { ...emptyCleared(), ...(s.clearedAt || {}) },
    diagramAt: s.diagramAt || 0,
  })
}

/**
 * 把一份（合并后的）进度放回 store 的内存状态里。
 * ⚠️ 只改内存 —— 要落 localStorage 得再调 store.saveLocalState()，
 *    否则刷新一下就回到合并前了（这类"看着同步成功了、刷新又变回去"最难查）。
 */
export function applyState(store, state) {
  const s = normalizeState(state)
  store.answers = s.progress.answers
  store.wrong = s.progress.wrong
  store.fav = s.progress.fav
  store.favAt = s.progress.favAt
  store.notesRemoved = s.progress.notesRemoved
  store.history = s.history
  store.notes = s.notes
  store.overrides = s.overrides
  store.analyses = s.analyses
  store.diagram = normalizeDiagram({ nodes: s.diagram.nodes, edges: s.diagram.edges })
  store.clearedAt = s.clearedAt
  store.diagramAt = s.diagramAt
  store.progressUpdatedAt = s.progress.updatedAt
  if (store.bankId && Object.keys(s.diagnose).length) save(K.diagnose(store.bankId), s.diagnose)
  return s
}

/** 画布有没有内容（给界面判断"要不要提示合并"用） */
export function diagramIsEmpty(diagram) {
  const d = obj(diagram)
  return !(arr(d.nodes).length || arr(d.edges).length)
}

/** 空画布（原样转发 core/diagram.js 的，少一处 import 分叉） */
export const blankDiagram = emptyDiagram

/**
 * 把服务端报的 conflicts 说成一句人话。
 *
 * 为什么必须说出来：两边都有、又分不出先后时只能选一边 —— 另一边的内容**真的被覆盖了**。
 * 悄悄吞掉它，学生会在另一台设备上发现"我刚写的东西没了"，却不知道为什么。
 * 「讲错了比讲不出更糟」这条站上原则在这里的落点是：宁可说"这次用了本机这份"。
 */
export function conflictNote(conflicts) {
  const c = obj(conflicts)
  const parts = []
  if (c.notes) parts.push(`${c.notes} 条笔记`)
  if (c.fav) parts.push(`${c.fav} 条收藏`)
  if (c.diagram) parts.push('1 张图笔记')
  if (!parts.length) return ''
  return `${parts.join('、')}在两边不一样、又分不出先后，这次以本机这份为准`
}
