/**
 * core/parsons.js —— **拖拽排序题**（Parsons problem）：把一段代码的顺序打乱，让学生排回原样。
 * ============================================================================
 * 为什么加这一种（站主 2026-10-11：「下一步拖拽排序你也开始做」）：
 *   · 它是**确定性**题型里**证据最好**的一类：Ericson ICER'18 发现 Parsons 比"从头写代码"
 *     更省时间、效果相当；CHI'21（N=237）里"部分挖空的 faded Parsons"显著优于标准版；
 *     PRIMM（13 校 493 人）的 Predict→Run 也印证了"先判断再执行"这条线。
 *   · **不需要真跑**：正确答案就是教材原文的顺序 —— "教材怎么写的"本身就是判据。
 *     所以它和 `fill` 一样可以零额度、零沙箱地产出。
 *   · 研究里也有一条**要注意**的：Wiggins ICER'16 发现"干扰块"会**降低**学习效率，
 *     所以这里**默认不放干扰块**（宁可少考一点，也别拖慢学生）；`distractors` 只作为
 *     可选的难度开关留在数据模型里。
 *
 * 判分用**最长公共子序列**（LCS）给部分分 —— 这是 PrairieLearn `pl-order-blocks` 的模型：
 * 顺序对得越多、分越高，而不是"错一个就是零分"。
 */

/* ------------------------------------------------------------------ 切块 --- */

/**
 * 把一段代码切成"排序单元"。
 *
 * 先按**语句**切（跟踪字符串/注释/括号深度，绝不切进 `"a;b"` 或 `// ;` 里）；
 * 语句不够就退回**按行**切 —— 教材里常见"整段包在一个大括号里"的代码，
 * 按语句切只有 1 块，那种情况按行切才是可做的排序题。
 */
export function splitStatements(code) {
  const text = String(code ?? '').replace(/\r\n?/g, '\n')
  const out = []
  let cur = ''
  let depth = 0
  let state = null // null | 引号 | '//' | '/*'
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (state === '//') {
      cur += ch
      if (ch === '\n') {
        state = null
        // ⚠️ 行注释后面的这个换行**也是语句边界**（第一版把它吞了：
        //    `String s = "a;b"; // 注释` 会和下一行粘成一块）。
        if (depth === 0) {
          if (cur.trim()) out.push(cur.replace(/\s+$/, ''))
          cur = ''
        }
      }
      i += 1
      continue
    }
    if (state === '/*') {
      cur += ch
      if (ch === '*' && next === '/') {
        cur += next
        i += 2
        state = null
        continue
      }
      i += 1
      continue
    }
    if (state) {
      // 字符串里：转义要跳过，引号成对才算结束
      cur += ch
      if (ch === '\\') {
        cur += next ?? ''
        i += 2
        continue
      }
      if (ch === state) state = null
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      state = '//'
      cur += ch
      i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      state = '/*'
      cur += ch
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      state = ch
      cur += ch
      i += 1
      continue
    }
    if (ch === '{' || ch === '(' || ch === '[') depth += 1
    else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
    if (ch === '\n' && depth === 0) {
      if (cur.trim()) out.push(cur.replace(/\s+$/, ''))
      cur = ''
      i += 1
      continue
    }
    cur += ch
    i += 1
  }
  if (cur.trim()) out.push(cur.replace(/\s+$/, ''))

  // 只有注释的块并进**下一块**（孤立的一行注释没法排序，也没意义）。
  // 末尾多出来的并进上一块。
  const merged = []
  let pending = ''
  for (const s of out) {
    const bare = s.trim()
    const commentOnly = /^(\/\/|\/\*|\*)/.test(bare) && !/[;{}]\s*$/.test(bare)
    if (commentOnly) {
      pending += (pending ? '\n' : '') + s
      continue
    }
    merged.push(pending ? `${pending}\n${s}` : s)
    pending = ''
  }
  if (pending) {
    if (merged.length) merged[merged.length - 1] += `\n${pending}`
    else merged.push(pending)
  }
  return merged
}

/** 排序单元：语句优先，语句太少就按行 */
export function toUnits(code) {
  const stmts = splitStatements(code)
  if (stmts.length >= 3) return stmts
  return String(code ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim())
}

/* -------------------------------------------------------------- 造题/判分 --- */

/** 定种子随机（同一个 seed 必然同一套打乱 —— 题面要可复现） */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 字符串 → 32 位种子（同样的代码得到同样的打乱） */
export function seedOf(text) {
  let h = 2166136261
  const s = String(text ?? '')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * 这堆"块"适不适合做排序题？
 *
 * ⚠️ 为什么必须有这道闸门（实测教训）：拿**已经上架的 Vue 代码题库**去生成排序题，
 * 456 道里 240 道"能切出 3~9 块"，可一看样本就露馅 —— 块长这样：
 * `</li>`、`Name:`、`</label>`。那是 **HTML/模板碎片**，不是可排序的语句，
 * 排出来毫无意义（还会让学生把一堆闭合标签当"代码"看）。
 * 自动生成的东西**必须抽查样本**（坑 101 的老毛病：数字好看、例子荒谬）。
 *
 * 判据（宽进严出，只挡明显不成句的）：
 *   · 含标签的行不能超过三成 → 多半是 HTML 模板
 *   · **不能有"只有标点括号"的块**（`})`、`{`、`},`）—— 那是把一条长语句按行切开后的碎渣，
 *     排它没有意义（实测样本里第一个块就是 `})`）
 *   · 至少六成像"语句"：以 `;`/`{`/`}`/`)` 收尾、是注释行、或以关键字开头
 */
export function orderableUnits(units) {
  const list = Array.isArray(units) ? units : []
  if (list.length < 3) return false
  if (list.some((u) => String(u).trim().length < 2)) return false
  if (list.some((u) => /^[\s(){}[\];,]+$/.test(String(u)))) return false
  const taggy = list.filter((u) => /<\/?[a-zA-Z][^>]*>/.test(u)).length
  if (taggy / list.length > 0.3) return false
  const stmtish = list.filter(
    (u) =>
      /[;{}]\s*$|\)\s*$|^\s*(\/\/|\/\*|\*)/.test(String(u).trim()) ||
      /^\s*(if|for|while|switch|else|return|const|let|var|function|class|import|export|public|private|protected|new|try|catch)\b/.test(
        String(u).trim(),
      ),
  ).length
  return stmtish / list.length >= 0.6
}

/**
 * 造一道拖拽排序题。
 *
 * @returns {{blocks:{key:string,text:string}[], answer:string[], code:string}|null}
 *   `blocks` 是**打乱后**的顺序（学生看到的就是它），`answer` 是正确顺序的 key 列表。
 *   ⚠️ key 按**打乱后**的位置命名（s1..sn），所以 `answer` 不会是 `['s1','s2',…]`
 *   这种一眼看穿的样子 —— 别改成按原文命名。
 *   块数不够/切不出来/不像可排序的语句 → 返回 null（**宁可不出题，也别出一道没意义的**）。
 */
export function buildParsonsTask(code, { seed = null, minBlocks = 3, maxBlocks = 9 } = {}) {
  const units = toUnits(code)
  if (units.length < minBlocks || units.length > maxBlocks) return null
  if (!orderableUnits(units)) return null
  // 全是一样的块（比如全是 `}`）排了也没意义
  if (new Set(units.map((u) => u.trim())).size < units.length) return null

  const rnd = mulberry32(seed === null ? seedOf(units.join('\n')) : seed)
  /**
   * ⚠️ 打乱要**打得动**：随机洗牌有时只把一块挪了位置（实测 65 道里 8 道是
   * "LCS = 块数−1" = 只有一块不在原位）—— 那种题学生一眼就看出来了，等于白出。
   * 所以要求**至少两块不在原位**（`块数 − LCS ≥ 2`），不够就重摇；
   * 摇不出来（块太少）就取"挪得最多"的那次，实在挪不动才不出题。
   */
  let best = null
  for (let tries = 0; tries < 30; tries += 1) {
    const order = units.map((_, i) => i)
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1))
      ;[order[i], order[j]] = [order[j], order[i]]
    }
    if (order.every((v, i) => v === i)) continue // 原样，跳过
    const blocks = order.map((srcIdx, i) => ({ key: `s${i + 1}`, text: units[srcIdx] }))
    const answer = units.map((_, u) => blocks[order.indexOf(u)].key)
    const displaced = units.length - lcsLength(blocks.map((b) => b.key), answer)
    if (!best || displaced > best.displaced) best = { blocks, answer, displaced }
    if (displaced >= 2) break
  }
  if (!best || best.displaced < 1) return null
  return { blocks: best.blocks, answer: best.answer, code: units.join('\n') }
}

/** 最长公共子序列长度（部分分的依据） */
function lcsLength(a, b) {
  const n = a.length
  const m = b.length
  let prev = new Array(m + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1).fill(0)
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    prev = cur
  }
  return prev[m]
}

/**
 * 判分：顺序完全对才算对；同时给**部分分**和逐位置对错（界面要标出哪一块放错了）。
 *
 * @param {string[]} pick   学生排出来的 key 顺序
 * @param {string[]} answer 正确顺序
 */
export function judgeParsons(pick, answer) {
  const want = Array.isArray(answer) ? answer.map(String) : []
  const got = Array.isArray(pick) ? pick.map(String) : []
  const total = want.length
  const correct = total ? lcsLength(got, want) : 0
  const posOk = want.map((k, i) => got[i] === k)
  return { ok: total > 0 && got.length === total && correct === total, correct, total, posOk }
}
