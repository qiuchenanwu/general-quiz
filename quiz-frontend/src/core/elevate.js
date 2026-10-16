/**
 * elevate.js —— 提权的**纯逻辑**（敲键序列 + 通行证存取）
 * ============================================================================
 * ★ 先把一句话写在这儿，免得以后有人往这里加"隐藏功能"：
 *
 *   敲键序列 x s 9 9 9 **不是安全边界**。
 *   前端 bundle 是公开可读的，谁翻一遍 JS 都能看到这个序列 ——
 *   它唯一的作用是"把密码框叫出来"，真正的门是服务端拿密码换签名 token
 *   （见 renwu/backend/apps/quizgen/elevate.py）。
 *
 *   所以：**别把秘密放进敲键序列里**。要藏东西就往服务端放。
 *
 * 为什么通行证存 sessionStorage 而不是 localStorage：
 *   这张票的用途是"在服务器上执行代码"，属于会话级授权。
 *   localStorage 会跨浏览器重启一直留着，等于把提权状态变成常驻 —— 没必要。
 *   sessionStorage 关掉标签页就没了，用完即焚，正合适。
 */

/** 敲键序列（小写）。用户要的是 5 秒内依次按下这五个键。 */
export const KNOCK = ['x', 's', '9', '9', '9']

/** 整段序列必须在这么久之内按完（从**第一个键**算起） */
export const KNOCK_WINDOW_MS = 5000

const STORAGE_KEY = 'quiz:v1:elevate'

/**
 * 推进敲键状态机。**纯函数**（时间从外面传进来），所以能在 Node 里断言。
 *
 * @param {{progress:number,startMs:number}} state 上一次的状态
 * @param {string} key 这次按下的键
 * @param {number} now 现在（毫秒）
 * @param {number} windowMs 整段序列的时间窗
 * @returns {{progress:number,startMs:number,matched:boolean}}
 *          matched=true 表示刚刚凑齐（此时 progress 归零，下次要重新按）
 */
export function knockStep(state, key, now, windowMs = KNOCK_WINDOW_MS) {
  const k = String(key ?? '').toLowerCase()
  let progress = state?.progress ?? 0
  let startMs = state?.startMs ?? 0

  // 整段超时 → 从头再来（但这一下本身可能是新的开头，下面会处理）
  if (progress > 0 && now - startMs > windowMs) progress = 0

  let next = 0
  let nextStart = now
  if (k === KNOCK[progress]) {
    // 接上一位；第一位就把计时起点定下来
    next = progress + 1
    nextStart = progress === 0 ? now : startMs
  } else if (k === KNOCK[0]) {
    // 这一下是新开头（比如按了 x s x …，第二个 x 要重新当开头，而不是把进度清零什么都不要）
    next = 1
    nextStart = now
  } else {
    // 别的键：**不推进也不清零**。刻意如此 ——
    // 用户很可能在按到一半时插了别的操作（点了下页面、按了 Esc），
    // 清零会让这个功能变得"必须一次不差"，体验很差。超时自然会兜住。
    next = progress
    nextStart = startMs
  }

  const matched = next >= KNOCK.length
  return { progress: matched ? 0 : next, startMs: matched ? 0 : nextStart, matched }
}

/**
 * 这一下按键该不该**不算**敲键序列？
 *
 * ⚠️ 必须判：代码题的编辑器就是个输入框，学生在里面敲代码时完全可能敲出
 *    `xs999`（变量名、循环、字符串里都可能）。不判的话，写着代码突然弹出密码框。
 *    Monaco / CodeMirror 用 div 实现，所以要连 `[contenteditable]` 和它们的类名一起看。
 */
export function shouldIgnoreTarget(el) {
  if (!el || typeof el !== 'object') return false
  const tag = String(el.tagName || '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  if (typeof el.closest === 'function') {
    try {
      if (el.closest('[contenteditable="true"], .cm-editor, .monaco-editor')) return true
    } catch {
      /* 有些节点没有 closest 的实现细节，忽略 */
    }
  }
  return false
}

/* ------------------------------ 通行证存取 ------------------------------ */

/**
 * 「这台浏览器成功提权过」的标记。**故意放 localStorage**（跨会话留着）。
 *
 * 用途只有一个：决定"当前不可用"那句提示**要不要说出怎么解锁**。
 *   · 从没提权过的访客 → 中性的一句"当前不可用"（**不对外广告**，站主要求）；
 *   · 提权过一次的人（站主自己）→ 过期后能看到"按 x s 9 9 9 重新解锁"。
 * 为什么需要它：站主说「别对外显示可以提权」之后，我把提示全删了 ——
 * 结果是**连站主自己都被关在门外**（Java 真跑永远只说"当前不可用"，没有任何出路）。
 * 这条标记就是那个折中：不广告，但用过的人找得回来。
 */
const SEEN_KEY = 'quiz:v1:elevatedBefore'

/** 这台浏览器以前成功提权过吗（决定提示要不要给出解锁办法） */
export function wasElevatedBefore() {
  try {
    return localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * 存一张通行证。带 `expiresAt`，这样界面能显示还剩多久、
 * 也能在本地先判过期（少发一次注定 403 的请求）。
 */
export function saveToken(token, expiresIn, now = Date.now()) {
  const record = { token: String(token || ''), expiresAt: now + Number(expiresIn || 0) * 1000 }
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(record))
  } catch {
    /* 隐私模式 / 存储被禁：退化成"这次页面内有效"，功能不该因此崩 */
  }
  try {
    localStorage.setItem(SEEN_KEY, '1') // 只用于上面的提示取舍
  } catch {
    /* 同上：存不了就算了，最多下次不提示 */
  }
  return record
}

/** 读通行证；**本地就能看出过期的直接返回 null 并清掉** */
export function loadToken(now = Date.now()) {
  let record = null
  try {
    record = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null')
  } catch {
    return null
  }
  if (!record || !record.token) return null
  if (!(record.expiresAt > now)) {
    clearToken()
    return null
  }
  return record
}

export function clearToken() {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* 同上 */
  }
}

/** 还剩多久（毫秒）；没有或过期返回 0 */
export function remainingMs(now = Date.now()) {
  const record = loadToken(now)
  return record ? Math.max(0, record.expiresAt - now) : 0
}
