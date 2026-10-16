/**
 * normalize.js —— 容错归一化层
 * ============================================================================
 * 这是整个「复用」承诺的兑现处：用户把 AI 生成的、字段名乱七八糟的 JSON
 * 拖进页面，也得能刷。所以这里不校验，只「尽量理解」。
 *
 * 能吃的输入形态：
 *   1. { meta:{...}, questions:[...] }        ← 规范形态（tools/schema.json）
 *   2. [ {...}, {...} ]                       ← 裸数组
 *   3. { data:[...] } / { list:[...] } / { items:[...] } / { 题目:[...] }
 *
 * 单题字段别名（中英文都认）：
 *   题干：stem / question / title / content / text / 题干 / 题目 / 问题
 *   选项：options / choices / option / 选项   （字符串数组 / 对象数组 / {A:".."} 映射）
 *   答案：answer / correct / correctAnswer / 正确答案 / 答案
 *   类型：type / questionType / 题型
 *   解析：analysis / explanation / 解析 / 答案解析
 *
 * 答案能吃的写法： "A" / "AB" / "A,B" / "A、B" / ["A","B"] / 1 / 0 /
 *                  "正确" / "错误" / "对" / "错" / "√" / "×" / true / false
 *
 * 代码题（`type:'code'`，2026-10 新增）：题干之外带 `code` / `mode` / `blanks` / `run`，
 * 答案不是字母而是**原文片段 / 行号 / 运行输出**。判据在 core/code.js，
 * 这里只负责「尽量理解 + 判不了就丢掉」。
 */
import { blankCount } from './code.js'

const STEM_KEYS = ['stem', 'question', 'questionText', 'question_text', 'title', 'content', 'text', 'name', '题干', '题目', '问题', '试题']
const OPT_KEYS = ['options', 'choices', 'choice', 'option', 'optionList', 'optionsList', '选项', '备选答案']
const ANS_KEYS = ['answer', 'answers', 'correct', 'correctAnswer', 'correct_answer', 'rightAnswer', 'right_answer', 'key', '正确答案', '答案', '参考答案', 'standardAnswer']
const TYPE_KEYS = ['type', 'questionType', 'question_type', 'kind', '题型', '类型']
const ANAL_KEYS = ['analysis', 'explanation', 'explain', 'analyze', 'comment', 'note', 'remark', '解析', '答案解析', '说明']
const NO_KEYS = ['no', 'num', 'number', 'index', 'seq', 'order', '题号', '序号']
const CHAP_KEYS = ['chapter', 'chapterName', 'chapter_name', 'section', 'category', '章节', '章', '所属章节']
const TAGS_KEYS = ['tags', 'tag', 'keywords', 'labels', '标签', '知识点']
const DIFF_KEYS = ['difficulty', 'level', '难度']

const LETTERS = 'ABCDEFGHIJ'
const TRUE_WORDS = ['正确', '对', '是', '√', '✓', 'T', 'TRUE', 'Y', 'YES', '1']
const FALSE_WORDS = ['错误', '错', '否', '×', '✗', 'X', 'F', 'FALSE', 'N', 'NO', '0']

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '')

/** 取第一个「存在且非空」的别名字段 */
function pick(obj, keys) {
  if (!isObj(obj)) return undefined
  for (const k of keys) {
    if (!isBlank(obj[k])) return obj[k]
  }
  // 大小写不敏感兜底
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]))
  for (const k of keys) {
    const real = lower.get(k.toLowerCase())
    if (real !== undefined && !isBlank(obj[real])) return obj[real]
  }
  return undefined
}

function str(v) {
  if (v === undefined || v === null) return ''
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join('\n')
  return String(v).replace(/\r\n?/g, '\n').trim()
}

function splitOptionText(s) {
  // 支持一段文本里塞了多行选项
  const lines = s.split('\n').map((x) => x.trim()).filter(Boolean)
  if (lines.length > 1 && lines.every((l) => /^\s*[(（[【]?\s*[A-Ja-j]\s*[)）\]】.、．:：]\s*\S/.test(l))) {
    return lines.map((l) => {
      const m = l.match(/^\s*[(（[【]?\s*([A-Ja-j])\s*[)）\]】.、．:：]\s*([\s\S]*)$/)
      return { key: m[1].toUpperCase(), text: m[2].trim() }
    })
  }
  return [{ key: 'A', text: s }]
}

/** 选项归一化：字符串数组 / 对象数组 / {A:".."} 映射 / 单个字符串 */
function normalizeOptions(raw) {
  if (isBlank(raw)) return []

  // { A: "工人", B: "农民" } 或 { A: {text:"工人"} }
  if (isObj(raw)) {
    return Object.entries(raw)
      .filter(([, v]) => !isBlank(v))
      .map(([k, v], i) => {
        const key = /^[A-Ja-j]$/.test(k) ? k.toUpperCase() : LETTERS[i] || String(i + 1)
        const text = isObj(v) ? str(pick(v, ['text', 'content', 'value', 'label', 'title'])) : str(v)
        return { key, text }
      })
      .filter((o) => o.text)
  }

  // 单个字符串：可能内含多行选项
  if (typeof raw === 'string') return splitOptionText(str(raw)).filter((o) => o.text)

  if (!Array.isArray(raw)) return []

  const out = []
  raw.forEach((item, i) => {
    // ["A", "工人"] 这种二元组
    if (Array.isArray(item) && item.length >= 2) {
      out.push({ key: str(item[0]).toUpperCase(), text: str(item.slice(1).join(' ')) })
      return
    }
    if (isObj(item)) {
      const text = str(pick(item, ['text', 'content', 'value', 'label', 'title', 'option', '选项']))
      let key = pick(item, ['key', 'label', 'optionKey', 'option_key', 'id', 'value', '字母'])
      key = isBlank(key) ? LETTERS[i] || String(i + 1) : str(key).replace(/[^A-Za-z0-9]/g, '').toUpperCase()
      out.push({ key: key || LETTERS[i], text })
      return
    }
    // 纯字符串：可能自带 "A. " 前缀
    let s = str(item)
    const m = s.match(/^\s*[(（[【]?\s*([A-Ja-j])\s*[)）\]】.、．:：]\s*([\s\S]*)$/)
    if (m) out.push({ key: m[1].toUpperCase(), text: m[2].trim() })
    else out.push({ key: LETTERS[i] || String(i + 1), text: s })
  })

  // 剥掉重复的 key（保留先出现的）
  const seen = new Set()
  return out
    .filter((o) => o.text !== '' || o.key)
    .filter((o) => (seen.has(o.key) ? false : (seen.add(o.key), true)))
}

/** 把单个答案片段变成标准字母 / T / F / 原文 */
function singleToken(v, options) {
  if (typeof v === 'boolean') return v ? 'T' : 'F'
  if (typeof v === 'number') {
    // 数字答案：优先当 1-based 序号，0 当第一个
    const idx = v === 0 ? 0 : v - 1
    return options[idx]?.key ?? null
  }
  let s = str(v).trim()
  if (!s) return null

  const up = s.toUpperCase().replace(/\s+/g, '')
  if (TRUE_WORDS.includes(up)) return 'T'
  if (FALSE_WORDS.includes(up)) return 'F'

  // "答案：B" 之类残留
  s = s.replace(/^[^A-Za-z0-9\u4e00-\u9fff]*/, '')

  // 单个字母统一转大写：AI 很常产出小写答案（"b"、"a,c"）
  if (/^[A-Ja-j]$/.test(s)) return s.toUpperCase()

  // 纯数字 → 序号
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10)
    const idx = n === 0 ? 0 : n - 1
    if (options[idx]) return options[idx].key
  }
  return s
}

/** 答案归一化：统一成字符串数组 */
function normalizeAnswer(raw, options, type) {
  if (isBlank(raw)) return []
  const list = []
  const push = (t) => {
    if (t === null || t === undefined) return
    // 多字母串拆成单个字母（只在有选项、且是选择题时）
    const s = String(t)
    if (options.length && /^[A-Ja-j]{2,}$/.test(s)) {
      s.toUpperCase().split('').forEach((c) => list.push(c))
    } else {
      list.push(s)
    }
  }

  if (Array.isArray(raw)) {
    raw.forEach((v) => push(singleToken(v, options)))
  } else {
    const t = singleToken(raw, options)
    // 字符串里可能塞了 "A、B、C" / "A B C"
    if (typeof t === 'string' && options.length && /[A-Ja-j]/.test(t) && !/[\u4e00-\u9fff]/.test(t)) {
      const letters = t.toUpperCase().match(/[A-J]/g)
      if (letters && letters.length) letters.forEach((c) => list.push(c))
      else push(t)
    } else {
      push(t)
    }
  }

  // 去重 + 按选项顺序排序（多选题答案乱序也能对上）
  const uniq = [...new Set(list.filter((x) => x !== null && x !== undefined && x !== ''))]
  if (options.length) {
    const valid = new Set(options.map((o) => o.key))
    const kept = uniq.filter((k) => valid.has(k) || k === 'T' || k === 'F')
    // 判断题：选项被补成 T/F 后，答案只剩 T/F
    const final = kept.length ? kept : uniq
    return final.sort((a, b) => {
      const ia = options.findIndex((o) => o.key === a)
      const ib = options.findIndex((o) => o.key === b)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    })
  }
  return uniq
}

/** 题型归一化 */
function normalizeType(raw, options, answer) {
  const t = str(raw).toLowerCase()
  // 代码题要排在最前面：它的题干里可能带"选择"之类的字，而且**没有选项**，
  // 掉到下面的推断里会被当成判断题（那是老题库才有的形态）
  if (/代码题|编程题|代码|^code$|coding|snippet|playground/.test(t)) return 'code'
  if (/多选|多项|不定项|multi/.test(t)) return 'multiple'
  if (/判断|对错|是非|true.?false|judge|bool/.test(t)) return 'judge'
  if (/单选|单项|single|choice|选择/.test(t)) return 'single'

  // 没写类型就推断
  const optText = options.map((o) => o.text).join('')
  if (!options.length) return 'judge'
  if (options.length === 2 && /^(正确|对|√|T)$/.test(options[0].text) && /^(错误|错|×|F)$/.test(options[1].text)) return 'judge'
  if (options.length === 2 && /正确|错误/.test(optText) && answer.every((a) => a === 'T' || a === 'F')) return 'judge'
  return answer.length > 1 ? 'multiple' : 'single'
}

const JUDGE_OPTIONS = [
  { key: 'T', text: '正确' },
  { key: 'F', text: '错误' },
]

/* ------------------------------- 代码题 ------------------------------- */
/**
 * 代码题（`type: 'code'`）的字段别名。
 *
 * 它是**第四种题型，也是唯一一种"不靠选项"的题**：填空 / 找错行 / 预测输出 /
 * 修好它。为什么值得单开一条路：教材编译器抽出来的教学点里 2/3 是真实代码
 * （quiz/tools/docs_to_bank.py），把它们压成"下列说法正确的有哪些"，
 * 学到的只是词。判据与沙箱在 core/code.js（纯函数、可离线断言）。
 */
const CODE_KEYS = ['code', 'snippet', 'sourceCode', 'source_code', '代码', '示例代码']
const MODE_KEYS = ['mode', 'codeMode', 'code_mode', '模式']
const BLANKS_KEYS = ['blanks', 'blank', '填空', '空']
const RUN_KEYS = ['run', 'expect', 'expected', 'expectOutput', 'expectedOutput', '期望输出']
const LANG_KEYS = ['lang', 'language', '语言']
/** 拖拽排序题：打乱后的块（`{key,text}`），以及正确顺序（key 数组） */
const BLOCKS_KEYS = ['blocks', 'orderBlocks', 'parsons', '排序块', '块']

const MODE_ALIAS = [
  [/填空|^fill$|blank/, 'fill'],
  [/找错|改错|哪一行|^spot$|spot_?the/, 'spot'],
  [/预测|输出|^predict$|output/, 'predict'],
  [/手写|白纸|^write$|from ?scratch|implement/, 'write'],
  [/修好|修复|^fix$|repair/, 'fix'],
  [/排序|拖拽|^order$|parsons|reorder/, 'order'],
]

function normalizeLang(raw) {
  const t = str(raw).toLowerCase().replace(/^\./, '')
  if (!t) return 'js'
  if (['js', 'jsx', 'javascript', 'mjs', 'node', 'ecmascript'].includes(t)) return 'js'
  if (['ts', 'tsx', 'typescript'].includes(t)) return 'ts'
  return t
}

function normalizeCodeMode(raw, { code, blanks, options, answer, spotNo, run, blocks }) {
  const t = str(raw).toLowerCase()
  if (t) {
    for (const [re, mode] of MODE_ALIAS) if (re.test(t)) return mode
  }
  // 没写 mode 就按材料推断 —— 宁可猜错也别把题丢掉
  // ⚠️ 排序题要先判：它的 `code` 是**参考答案**（不能拿来当"填空"推），
  //    而且 blocks 是它独有的标志。
  if (blocks.length >= 2) return 'order'
  if (blanks.length || /_{3,}/.test(code)) return 'fill'
  if (options.length >= 2 && answer.every((a) => /^[A-J]$/.test(a))) return 'predict'
  if (spotNo) return 'spot'
  if (run) return 'fix'
  return 'fill'
}

/** 排序块能吃的写法：[{key,text}] / ["第一行","第二行"] / {s1:"…",s2:"…"} */
function normalizeBlocks(raw) {
  if (isBlank(raw)) return []
  if (Array.isArray(raw)) {
    return raw
      .map((b, i) => {
        if (isObj(b)) {
          const text = str(pick(b, ['text', 'code', 'content', 'line', '块', '内容']))
          const key = str(pick(b, ['key', 'id', 'blockId'])) || `s${i + 1}`
          return text ? { key, text } : null
        }
        const text = str(b)
        return text ? { key: `s${i + 1}`, text } : null
      })
      .filter(Boolean)
  }
  if (isObj(raw)) {
    return Object.entries(raw)
      .map(([key, v]) => ({ key, text: str(v) }))
      .filter((b) => b.text)
  }
  return []
}

/** 从任意写法里取第一个整数（"3" / 3 / ["3"] / "第 3 行"） */
function firstInt(v) {
  const s = Array.isArray(v) ? v[0] : v
  const m = String(s ?? '').match(/\d+/)
  return m ? m[0] : ''
}

/** `blanks` 能吃的写法：["ref"] / [{answer:"ref"}] / [{answer:["ref","reactive"], hint:"…"}] */
function normalizeBlanks(raw) {
  if (isBlank(raw)) return []
  if (typeof raw === 'string') return [{ answer: [str(raw)], hint: '' }]
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => {
      if (isObj(item)) {
        const a = item.answer ?? item.a ?? item.text ?? item.value ?? item.答案
        const list = (Array.isArray(a) ? a : [a]).map(str).filter(Boolean)
        return { answer: list, hint: str(item.hint ?? item.tip ?? item.提示) }
      }
      const s = str(item)
      return { answer: s ? [s] : [], hint: '' }
    })
    .filter((b) => b.answer.length)
}

/** `run` 能吃的写法：{expect:[…]} / {expect:{contains:[…]}} / ["…"] / "…" */
function normalizeRun(raw) {
  if (isBlank(raw)) return null
  if (Array.isArray(raw)) return { expect: raw.map(str) }
  if (typeof raw === 'string') return { expect: [str(raw)] }
  if (isObj(raw)) {
    const e = raw.expect ?? raw.expected ?? raw.output ?? raw.期望输出
    if (isObj(e) && Array.isArray(e.contains)) return { expect: { contains: e.contains.map(str) } }
    if (Array.isArray(e)) return { expect: e.map(str) }
    if (!isBlank(e)) return { expect: [str(e)] }
    return null
  }
  return null
}

/**
 * 代码题的归一化。**不走 options/answer 那条路**（它的 answer 不是字母）。
 * @returns {{q:object|null, issue:string|null}}
 */
function normalizeCodeQuestion(raw, index, stem) {
  const code = str(pick(raw, CODE_KEYS))
  const options = normalizeOptions(pick(raw, OPT_KEYS))
  const rawAnsValue = pick(raw, ANS_KEYS)
  const rawAnswer = normalizeAnswer(rawAnsValue, options, null)
  const blanks = normalizeBlanks(pick(raw, BLANKS_KEYS))
  const run = normalizeRun(pick(raw, RUN_KEYS))
  const blocks = normalizeBlocks(pick(raw, BLOCKS_KEYS))
  const spotNo = firstInt(rawAnsValue)
  const requested = str(pick(raw, MODE_KEYS))
  const mode = normalizeCodeMode(requested, {
    code,
    blanks,
    options,
    answer: rawAnswer,
    spotNo,
    run,
    blocks,
  })

  // 「手写」题是白纸一张：没有起始代码也成立（要跑的是用户当场写的东西）。
  // 其余模式没有代码就没法出题 —— 宁可丢掉，也不要放一道没法做的题进题库。
  if (!code.trim() && mode !== 'write') {
    return { q: null, issue: '代码题缺 code' }
  }
  if (!code.trim() && mode === 'write') {
    // 判据还是要的（写完拿什么对照）—— 没有期望输出就成了自由发挥
    if (!run) return { q: null, issue: '手写题缺 run.expect（没有对照就没法判）' }
  }

  // 答案：填空=每个空的原文；预测=字母；找错=行号；排序=key 顺序；修好它=没有文字答案（跑通才算过）
  let answer = []
  if (mode === 'fill') {
    answer = blanks.length ? blanks.map((b) => b.answer[0]) : rawAnswer.map(str)
  } else if (mode === 'predict') {
    answer = rawAnswer
  } else if (mode === 'spot') {
    answer = spotNo ? [spotNo] : []
  } else if (mode === 'order') {
    // ⚠️ 排序题的答案**不能走 normalizeAnswer**：它会把 `s3` 这种 key 当字母/序号处理掉。
    //    直接从原始字段取字符串数组。
    const rawAns = Array.isArray(rawAnsValue) ? rawAnsValue : [rawAnsValue]
    answer = rawAns.map((k) => str(isObj(k) ? pick(k, ['key', 'id']) : k)).filter(Boolean)
  }

  // ---- 逐模式校验：宁可丢掉，也不要放一道判不了的题进题库 ----
  if (mode === 'fill') {
    const holes = blankCount(code)
    if (!blanks.length) return { q: null, issue: '填空题缺 blanks（每个空的答案）' }
    if (holes !== blanks.length) {
      return { q: null, issue: `填空题的 ${holes} 个空和 ${blanks.length} 个答案对不上` }
    }
  } else if (mode === 'predict') {
    if (options.length < 2 || !answer.length) return { q: null, issue: '预测输出题缺选项或答案' }
  } else if (mode === 'spot') {
    if (!answer.length || !/^\d+$/.test(answer[0])) return { q: null, issue: '找错行题缺行号答案' }
    const lines = code.split('\n').length
    if (Number(answer[0]) > lines) return { q: null, issue: '找错行的行号超出代码行数' }
  } else if (mode === 'fix' || mode === 'write') {
    // 手写题的 code 可能只是空骨架（甚至空的）—— 要跑的是用户当场写的东西
    if (mode === 'fix' && !code.trim()) return { q: null, issue: '修好它没有可改的代码' }
    if (!run) return { q: null, issue: `${mode === 'write' ? '手写' : '修好它'}缺 run.expect（不知道跑出什么才算对）` }
  } else if (mode === 'order') {
    // 排序题：块要够、答案要是**这些块的一个排列**（少一块/多一块/写了不存在的 key 都不行）
    if (blocks.length < 2) return { q: null, issue: '排序题至少要有 2 块' }
    if (answer.length !== blocks.length) {
      return { q: null, issue: `排序题的答案数（${answer.length}）和块数（${blocks.length}）对不上` }
    }
    const keys = new Set(blocks.map((b) => b.key))
    if (answer.some((k) => !keys.has(k))) return { q: null, issue: '排序题的答案里有不存在的块' }
    if (new Set(answer).size !== answer.length) return { q: null, issue: '排序题的答案里有重复的块' }
  }

  const q = { id: str(raw.id) || `q${index + 1}`, no: index + 1, type: 'code', mode, stem, code, lang: normalizeLang(pick(raw, LANG_KEYS)), answer }
  if (blocks.length) q.blocks = blocks.map((b) => ({ key: b.key, text: b.text }))
  if (blanks.length) q.blanks = blanks.map((b) => ({ answer: b.answer, hint: b.hint }))
  if (options.length) {
    // 预测输出题仍然用选项作答，界面也会给「运行」按钮
    q.options = options
  }
  if (run) q.run = run
  return finalizeQuestion(raw, index, q)
}

/**
 * 两种题型共用的收尾：题号 / 章节 / 解析 / 标签 / 难度 / 出处。
 * （2026-10 抽出：代码题和选择题的答案形态完全不同，但除了答案，别的字段一模一样。）
 */
function finalizeQuestion(raw, index, q) {
  const noRaw = pick(raw, NO_KEYS)
  const no = Number.isFinite(Number(noRaw)) ? Number(noRaw) : index + 1
  q.no = no
  if (!q.id) q.id = `q${no}`
  return attachExtras(raw, q)
}

/**
 * 归一化单题。无法救的返回 null。
 * @returns {{q:object|null, issue:string|null}}
 */
export function normalizeQuestion(raw, index) {
  if (!isObj(raw)) {
    // 也可能是 ["题干", ["A","B"], "A"] 这种数组写法
    if (Array.isArray(raw) && raw.length >= 2) {
      raw = { stem: raw[0], options: raw[1], answer: raw[2] }
    } else {
      return { q: null, issue: '不是对象' }
    }
  }

  const stem = str(pick(raw, STEM_KEYS))
  let options = normalizeOptions(pick(raw, OPT_KEYS))
  let answer = normalizeAnswer(pick(raw, ANS_KEYS), options, null)
  let type = normalizeType(pick(raw, TYPE_KEYS), options, answer)

  // 代码题：**在选项那套之前就分出去**（它的答案不是字母，掉进去只会被"缺答案"丢掉）
  if (type === 'code') {
    if (!stem) return { q: null, issue: '代码题题干为空' }
    return normalizeCodeQuestion(raw, index, stem)
  }

  // 判断题：补上 T/F 选项，让前端只有一条渲染路径
  if (type === 'judge') {
    if (options.length < 2) options = JUDGE_OPTIONS.map((o) => ({ ...o }))
    // 答案可能是 "正确" 之类，重新按判断题解析一遍
    if (!answer.length || answer.some((a) => a !== 'T' && a !== 'F')) {
      answer = normalizeAnswer(pick(raw, ANS_KEYS), options, 'judge')
      if (!answer.length) {
        const t = singleToken(pick(raw, ANS_KEYS), options)
        if (t === 'T' || t === 'F') answer = [t]
      }
    }
  }

  if (!stem) return { q: null, issue: '题干为空' }
  if (!answer.length) return { q: null, issue: '缺答案' }
  if (type !== 'judge' && options.length < 2) return { q: null, issue: '选项少于 2 个' }

  // 答案里有选项里不存在的字母 → 丢弃该字母
  if (options.length) {
    const valid = new Set(options.map((o) => o.key))
    const filtered = answer.filter((a) => valid.has(a))
    if (filtered.length) answer = filtered
    else if (type !== 'judge') return { q: null, issue: `答案 ${answer.join('')} 不在选项 ${[...valid].join('')} 中` }
  }

  if (type === 'multiple' && answer.length < 2) type = 'single'
  if (type === 'single' && answer.length > 1) type = 'multiple'

  return finalizeQuestion(raw, index, { id: str(raw.id), type, stem, options, answer })
}

/** 收尾（续）：章节 / 解析 / 标签 / 难度 / 出处 */
function attachExtras(raw, q) {
  const tagsRaw = pick(raw, TAGS_KEYS)
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw.map(str).filter(Boolean)
    : str(tagsRaw) ? str(tagsRaw).split(/[,，、;；\s]+/).filter(Boolean) : []

  const diff = Number(pick(raw, DIFF_KEYS))

  const chapter = str(pick(raw, CHAP_KEYS))
  if (chapter) q.chapter = chapter
  const analysis = str(pick(raw, ANAL_KEYS))
  if (analysis) q.analysis = analysis
  if (tags.length) q.tags = tags
  if (Number.isFinite(diff) && diff >= 1 && diff <= 5) q.difficulty = diff
  /*
   * 出处：`{url, heading, quote}`。
   *
   * 为什么单独留一个字段、而不是只写在解析里：
   *   教材/官方文档编译出来的题库，每道题都该能**点回原文**——
   *   这是"AI 出的题可不可信"唯一能给用户的硬保证。
   *   而解析里那段文字是给人读的，浏览器没法把其中的网址自动变成"出处"按钮。
   * 兼容：老题库没有这个字段 → 不设这个键（不是设成 null，免得界面到处判空）。
   */
  const srcRaw = raw.source ?? raw.出处
  if (isObj(srcRaw) && (srcRaw.url || srcRaw.heading)) {
    q.source = {
      url: str(srcRaw.url),
      heading: str(srcRaw.heading),
      quote: str(srcRaw.quote),
    }
  }

  return { q, issue: null }
}

/** 找出题库数组藏在哪里 */
function findArray(input) {
  if (Array.isArray(input)) return input
  if (!isObj(input)) return null
  for (const k of ['questions', 'data', 'list', 'items', 'results', 'bank', '题目', '题库', 'questionList']) {
    if (Array.isArray(input[k])) return input[k]
  }
  // 退而求其次：第一个「元素是对象且看着像题」的数组字段
  for (const v of Object.values(input)) {
    if (Array.isArray(v) && v.length && isObj(v[0]) && (pick(v[0], STEM_KEYS) !== undefined)) return v
  }
  return null
}

function hashId(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/**
 * 把任意输入归一化成 { meta, questions, issues }
 * @param {any} input 解析后的 JSON
 * @param {string} fallbackName 文件名之类，用来兜底标题
 */
export function normalizeBank(input, fallbackName = '未命名题库') {
  const arr = findArray(input)
  if (!arr) {
    throw new Error('没找到题目数组：期望顶层是数组，或含有 questions / data / list 字段的对象')
  }

  const srcMeta = isObj(input) && isObj(input.meta) ? input.meta : isObj(input) ? input : {}
  const metaRaw = isObj(srcMeta) && isObj(srcMeta.meta) ? srcMeta.meta : srcMeta

  const questions = []
  const issues = []
  let dropped = 0
  const dropReasons = new Map()

  arr.forEach((raw, i) => {
    const { q, issue } = normalizeQuestion(raw, i)
    if (q) {
      // 同一题库里 id 撞车 → 加后缀
      if (questions.some((x) => x.id === q.id)) q.id = `${q.id}-${i + 1}`
      questions.push(q)
    } else {
      dropped++
      dropReasons.set(issue, (dropReasons.get(issue) || 0) + 1)
    }
  })

  if (!questions.length) {
    const why = [...dropReasons.entries()].map(([r, c]) => `${r}×${c}`).join('，')
    throw new Error(`解析出 0 道可用题目${why ? `（丢弃原因：${why}）` : ''}`)
  }

  if (dropped) {
    const why = [...dropReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([r, c]) => `${r} ${c} 道`)
      .join('、')
    issues.push(`有 ${dropped} 道题被跳过：${why}`)
  }

  const title = str(pick(metaRaw, ['title', 'name', 'subject', '题库', '标题'])) || fallbackName
  const counts = { single: 0, multiple: 0, judge: 0, code: 0 }
  questions.forEach((q) => {
    counts[q.type] = (counts[q.type] || 0) + 1
  })

  // 章节 / 标签汇总
  const chapterSet = new Map()
  questions.forEach((q) => {
    if (q.chapter && !chapterSet.has(q.chapter)) chapterSet.set(q.chapter, chapterSet.size + 1)
  })
  questions.forEach((q) => {
    if (q.chapter) q.chapterId = `c${chapterSet.get(q.chapter)}`
  })
  const tagCounts = new Map()
  questions.forEach((q) => (q.tags || []).forEach((t) => tagCounts.set(t, (tagCounts.get(t) || 0) + 1)))

  const meta = {
    id: str(pick(metaRaw, ['id', 'bankId', 'key'])) || `bank-${hashId(title)}`,
    title,
    subject: str(pick(metaRaw, ['subject', 'course', '科目', '课程'])),
    description: str(pick(metaRaw, ['description', 'desc', 'intro', '简介', '说明'])),
    version: str(pick(metaRaw, ['version', '版本'])) || '1.0.0',
    source: str(pick(metaRaw, ['source', 'from', '来源'])),
    total: questions.length,
    counts,
    chapters: [...chapterSet.entries()].map(([name, i]) => ({ id: `c${i}`, name })),
    tags: [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count })),
  }

  // 题号重复的提醒
  const nos = questions.map((q) => q.no)
  if (new Set(nos).size !== nos.length) issues.push('题号有重复（不影响刷题，答题卡按顺序显示）')

  return { meta, questions, issues }
}

/** 判断两个答案数组是否等价（顺序无关） */
export function isCorrect(picked, answer) {
  if (!picked || !picked.length || !answer || !answer.length) return false
  if (picked.length !== answer.length) return false
  const a = [...picked].sort()
  const b = [...answer].sort()
  return a.every((v, i) => v === b[i])
}

export const TYPE_LABEL = {
  single: '单选题',
  multiple: '多选题',
  judge: '判断题',
  code: '代码题',
  fill: '填空题',
  short: '简答题',
}
