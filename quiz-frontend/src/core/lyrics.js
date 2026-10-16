/**
 * lyrics.js —— LRC 歌词的**纯逻辑**：解析 + 定位"现在唱到哪一句"。
 *
 * 为什么自己写而不是用库：
 *   ① APlayer 自带歌词渲染，但那是它自己的 DOM 和样式 —— 播放页要做出
 *      "现代播放器"的观感（当前行放大、邻居行淡出、点行跳转、自动滚动），
 *      必须自己控制 DOM 才行。
 *   ② 这个文件的每一行都能在 Node 里断言（见 tests/test_engine.mjs 的 H 段）。
 *      歌词同步这种事最容易出错在边界上（时间戳越界、空行、多时间戳一行），
 *      而这些恰恰是纯函数最好测的地方。
 *
 * LRC 长这样（网易云/音乐软件导出就是它）：
 *     [ti:歌名]
 *     [ar:歌手]
 *     [offset:-200]
 *     [00:12.34]第一句
 *     [00:15.00][01:20.00]副歌（同一句在歌里出现两次）
 *     [00:18.5]时间戳小数位可以只有一位
 */

/** 一行里可以带多个时间戳：[00:12.34][01:20.00]歌词 */
const TAG_RE = /\[([a-zA-Z]+):([^\]]*)\]/g
const TIME_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

/**
 * 解析 LRC。
 *
 * @param {string} text
 * @returns {{lines: Array<{time:number, text:string}>, synced:boolean, meta:object}}
 *   time 单位是**秒**（浮点）；synced=false 表示这份歌词没有时间戳（纯文本歌词），
 *   UI 应该整段静态展示，而不是假装能跟着滚。
 */
export function parseLrc(text) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n')
  const meta = {}
  const lines = []

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    // 元信息标签：[ti:...] [ar:...] [al:...] [offset:...] [by:...]
    let cursor = 0
    let consumed = 0
    TAG_RE.lastIndex = 0
    let tag
    while ((tag = TAG_RE.exec(line)) !== null) {
      if (tag.index !== consumed) break
      const key = tag[1].toLowerCase()
      // 时间戳也长这样，但 key 是数字 —— 那不是元信息
      if (!/^\d+$/.test(key)) {
        meta[key] = tag[2].trim()
        consumed = TAG_RE.lastIndex
      }
    }
    cursor = consumed

    // 时间戳（可能一行多个）
    const stamps = []
    TIME_RE.lastIndex = 0
    let m
    while ((m = TIME_RE.exec(line)) !== null) {
      if (m.index !== cursor) break
      const min = Number(m[1])
      const sec = Number(m[2])
      // 小数位补成毫秒：.5 → 500ms，.34 → 340ms，.345 → 345ms
      const fracRaw = m[3] || ''
      const frac = fracRaw ? Number(fracRaw.padEnd(3, '0').slice(0, 3)) / 1000 : 0
      stamps.push(min * 60 + sec + frac)
      cursor = TIME_RE.lastIndex
    }

    const body = line.slice(cursor).trim()
    if (!stamps.length) {
      // 没有时间戳的行：既不是元信息也不是歌词 → 整份歌词当纯文本用
      if (body && !isMetaLine(line)) lines.push({ time: -1, text: body })
      continue
    }
    for (const t of stamps) lines.push({ time: t, text: body })
  }

  const timed = lines.filter((l) => l.time >= 0).sort((a, b) => a.time - b.time)
  const synced = timed.length > 0
  const offset = Number(meta.offset)
  const finalLines = synced ? applyOffset(timed, Number.isFinite(offset) ? offset : 0) : lines.filter((l) => l.text)
  return { lines: finalLines, synced, meta }
}

function isMetaLine(line) {
  // 整行都是 [xx:yy] 形式，且 xx 不是数字 → 元信息行（不是歌词）
  const stripped = line.replace(TAG_RE, '').trim()
  if (stripped) return false
  const first = line.match(/^\[([a-zA-Z]+):/)
  return !!first
}

/**
 * 应用 `[offset:±ms]` 标签：正数表示歌词**提前**（LRC 规范里 offset 是"整体位移毫秒"，
 * 网易云导出的正 offset 表示歌词应提前出现）。为负时结果为负 → 夹到 0。
 */
export function applyOffset(lines, offsetMs) {
  const delta = (Number(offsetMs) || 0) / 1000
  return lines.map((l) => ({ ...l, time: Math.max(0, l.time - delta) }))
}

/**
 * 当前时间对应第几句（没有就到 -1）。
 *
 * 用二分而不是 filter：歌词几百行、播放时每 200ms 调一次，
 * 线性扫虽然也不慢，但二分是这个函数该有的写法 —— 而且**越界要稳**：
 * 歌曲还没开始（time 小于第一句）返回 -1，而不是硬塞第 0 句。
 */
export function activeLineIndex(lines, time) {
  if (!Array.isArray(lines) || !lines.length) return -1
  const t = Number(time)
  if (!Number.isFinite(t)) return -1
  let lo = 0
  let hi = lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((lines[mid].time ?? -1) <= t) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/** 把秒数写成 `mm:ss`（歌词页右侧的时间标签） */
export function clock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
