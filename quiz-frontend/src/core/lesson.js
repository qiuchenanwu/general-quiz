/**
 * lesson.js —— 文档模型 → **预习页**（"书本扫描件 → 定制化教学"批 3）
 * ============================================================================
 * 为什么是"预习页"而不是"再来一套题"：站主的原话是
 *   「上课预习过和没预习，效果不是一个量级」「要指定教学针对教材定制」
 *   「15 分钟时间盒 + 骨架 + 术语表（**用教材自己的措辞**，考试按教材）
 *     + 一个能跑的最小例子 + 3~5 道"先猜后验" + 带问题上课堂」。
 *
 * ★ 这一层**不调模型、不花一分钱额度**，所以能做的和不能做的必须说清楚：
 *   能做（确定性抽取）：书籍/章节骨架、术语表附**教材原话**、代码清单索引、
 *                       图/表索引、待核对提示、从**可信行**生成"先猜后验"填空。
 *   不能做：讲解、类比、把散文改写成教学语言 —— 那要调模型（后面再说）。
 *   它替代不了老师，但**把"翻书找重点"这件事变成 0 秒**，而且一个字都不编：
 *   每条术语后面都钉着教材原句，考试按教材也好对照。
 *
 * ⚠️ 一条硬规矩：**只从"可信"的行里生成自测题**。
 *   "可信"= 这一行 OCR 置信度不低、而且没有被 docmodel 标成代码可疑。
 *   理由：站点现在发的小语言包会把 `resp.setHeader(` 认成 `resp,setHeadqer (`——
 *   拿这种文字挖空考学生，**答案是错的**，而学生看不出来。宁可少出题。
 */
import { LOW_CONFIDENCE, furnitureKey, isWatermark } from './docmodel.js'
import { cleanOcrText } from './ocr.js'

export const LESSON_VERSION = 1

/* ------------------------------- 小工具 ------------------------------- */

const RE_SENTENCE_SPLIT = /(?<=[。！？；])/
const CJK = /[\u4e00-\u9fff]/

function sentences(text) {
  return String(text ?? '')
    .split(RE_SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 术语名清洗：去掉行首序号/顿号/引号，压掉空白 */
function cleanTerm(text) {
  return String(text ?? '')
    .replace(/^[\s\d.、,，:：()（）[\]【】"'“”]+/, '')
    .replace(/[\s\u3000]+/g, '')
    .trim()
}

/**
 * 术语表的判据：教材里"下定义"的句子。
 * 用的是**教材自己的措辞**（原句整句留下当引用），只把术语名抠出来当目录。
 *
 * ⚠️ 第一版只看正则，结果真实样张上抓出来一半是**半句话**：
 *   `的开发者工具中查看名`、`码设置了一个响应头,`、`这个转发过程对客户端来说` ——
 *   因为 OCR 是按行切的，"定义"的上半句可能在上一行。
 *   所以加了三道过滤（都是拿真实数据量出来的）：
 *     ① 不能以虚词/指代/动词开头（的/在/这/知道…）
 *     ② 不能含 的/了/一/个（术语名里出现这些，多半是半句话）
 *     ③ 不能有单字母的拉丁碎屑（`ia的oem村CE` 这种 OCR 认花的东西）
 */
const RE_DEFINITION = /^(.{2,24}?)(?:是指|指的是|被称为|称为|叫做|是一个|是一种|是|即|表示|用于)(.{6,})$/
const BAD_TERM_START = /^(?:的|了|在|和|与|这|那|其|而|并|即|如|由|把|被|从|对|当|若|则|是|有|会|能|可|为|以|及|或|但|也|都|就|才|只|又|还|更|最|很|不|没|无|每|各|某|该|此|上|下|前|后|中|内|外|时|第|知道|包括|例如|比如|其中|注意|如下|上述|下面|然后|接着|此时|这时|它|他|我们|你们|他们)/
const BAD_TERM_BODY = /[的了一个行码]/

/** 表格第一列像 API/标识符时，那一行其实就是一个"术语 + 释义" */
const RE_TABLE_TERM = /^([A-Za-z_@][\w.]*(?:\(\))?)\s+(\S.*)$/

/** "先猜后验"里值得挖空的词：API 名/方法名/关键字。太平凡的不挖（挖了等于没考） */
const BORING_TOKENS = new Set([
  'String', 'Integer', 'Boolean', 'Object', 'Class', 'Main', 'args',
  'true', 'false', 'null', 'this', 'super', 'void', 'public', 'private',
  'protected', 'static', 'final', 'return', 'import', 'package', 'int',
  'byte', 'char', 'long', 'double', 'float', 'short', 'value', 'text',
  // Java 关键字（挖空了只是在考语法，不是在考这一章）
  'class', 'extends', 'implements', 'throws', 'try', 'catch', 'else', 'while',
  'switch', 'case', 'break', 'continue', 'interface', 'boolean', 'abstract',
  'interface', 'instanceof', 'synchronized', 'volatile', 'transient',
])
const RE_TOKEN = /\b([A-Za-z_][A-Za-z0-9_]{3,})\b/g

/* ------------------- 标识符的"互相印证"（这一层的关键判据） ------------------- */

/**
 * ★ 只出现过一次的标识符**不许**当答案。
 *
 * 为什么必须要有这条：真实样张（小语言包）上，OCR 会把
 *   `String`→`Strzing`、`resp`→`zesp`、`FileInputStream`→`RileInputStream`、
 *   `getOutputStream`→`getOutpPutStream`、`IOException`→`IOExceptiony`
 * 这类错误散在代码里。第一版只按"置信度 ≥60 + 没被标可疑"判"可信"，
 * 于是生出来的自测题答案是 `Strzing` / `zesp` —— **拿错的答案考学生，而学生看不出来**，
 * 比不出题糟得多。
 *
 * 判据（纯确定性，不需要模型、不需要跑代码）：**同一个标识符在书里出现多次时，
 * 以出现次数最多的那个拼法为准**；只出现一次的、或者存在一个"更像真的"的近似拼法的，
 * 一律不用来出题。书里 API 名天然会重复出现（import 一次、调用一次、表格里一次），
 * 而 OCR 认错的拼法通常只出现一次。
 */
function buildVocabulary(blocks) {
  const all = []
  for (const block of blocks) {
    if (block.kind !== 'code' && block.kind !== 'table') continue
    for (const line of block.lines) {
      const text = String(line.text || '')
      RE_TOKEN.lastIndex = 0
      let m
      while ((m = RE_TOKEN.exec(text))) all.push(m[1])
    }
  }
  const freq = new Map()
  for (const t of all) freq.set(t, (freq.get(t) || 0) + 1)
  const uniq = [...freq.keys()]
  // 近似拼法（编辑距离 ≤1 对短词、≤2 对长词）里，出现次数更多的那个算"正牌"
  const suspicious = new Set()
  for (const t of uniq) {
    const limit = t.length >= 8 ? 2 : 1
    const mine = freq.get(t)
    for (const other of uniq) {
      if (other === t) continue
      const f = freq.get(other)
      if (f <= mine) continue
      if (Math.abs(other.length - t.length) > limit) continue
      if (editWithin(t, other, limit)) {
        suspicious.add(t)
        break
      }
    }
  }
  return { freq, suspicious }
}

/** 编辑距离是否 ≤ limit（只需要"是否"，不用算完整距离） */
function editWithin(a, b, limit) {
  const m = a.length
  const n = b.length
  let i = 0
  while (i < m && i < n && a[i] === b[i]) i++
  let j = 0
  while (j < m - i && j < n - i && a[m - 1 - j] === b[n - 1 - j]) j++
  return Math.max(m, n) - i - j <= limit
}

/** 这个标识符能不能当"标准答案"：出现过 ≥2 次、且不是被认花的近似拼法 */
function tokenTrustworthy(token, vocab) {
  if (!token || BORING_TOKENS.has(token)) return false
  if (vocab.suspicious.has(token)) return false
  return (vocab.freq.get(token) || 0) >= 2
}

/* =============================== 主入口 =============================== */

/**
 * 由文档模型建预习页。
 * @param {object} model `core/docmodel.js` 的 `buildDocModel()` 产物
 * @returns {object} 预习页（纯 JSON，可直接存 localStorage / 后端）
 */
export function buildLesson(model) {
  if (!model || !Array.isArray(model.pages)) {
    throw new Error('buildLesson：要先有文档模型（core/docmodel.js 的产物）')
  }

  const blocks = model.pages.flatMap((pg) => pg.blocks.map((b) => ({ ...b, page: pg.page })))
  const vocab = buildVocabulary(blocks)
  // 书名现在挂在**文档模型**上（`docmodel.js` 的 `guessBook`）—— 它是"这份文档是什么"
  // 的事实，Python 侧的 `model:` 源插件也要用同一份。**别再在这里实现第二遍**（坑 58）。
  // 只有老模型（没 book 字段）才退回兜底。
  const book = String(model.book || '')
  const outline = buildOutline(model, blocks)
  const terms = buildTerms(blocks, vocab)
  const listings = buildListings(model, blocks)
  const figures = buildFigures(blocks)
  const tables = buildTables(blocks)
  const checks = (model.review || []).filter((r) => r.level !== 'info')
  const selfCheck = buildSelfCheck(listings, vocab)

  const firstChapter = outline.find((o) => o.level === 1)
  return {
    version: LESSON_VERSION,
    title: firstChapter ? firstChapter.title : book || '预习页',
    book,
    generatedFrom: { pages: model.pages.length, blocks: blocks.length, version: model.version },
    stats: {
      sections: outline.length,
      terms: terms.length,
      listings: listings.length,
      figures: figures.length,
      tables: tables.length,
      checks: checks.length,
      selfCheck: selfCheck.length,
      trustedLines: listings.reduce((n, l) => n + l.trustedLines, 0),
    },
    outline,
    terms,
    listings,
    figures,
    tables,
    checks,
    selfCheck,
  }
}

/* ------------------------------- 书籍 / 骨架 ------------------------------- */

function buildOutline(model, blocks) {
  const outline = (model.sections || []).map((s) => ({
    level: s.level,
    number: s.number,
    title: s.title,
    page: s.page,
    blockId: s.blockId,
    code: 0,
    figures: 0,
    tables: 0,
  }))
  if (!outline.length) return outline

  // 每个块归到"它前面最近的一个标题"下（块的 section 路径已经由 docmodel 写好）
  let current = null
  for (const block of blocks) {
    if (block.kind === 'heading') {
      current = outline.find((o) => o.blockId === block.id) || current
      continue
    }
    if (!current) continue
    if (block.kind === 'code') current.code += 1
    else if (block.kind === 'figure') current.figures += 1
    else if (block.kind === 'table') current.tables += 1
  }
  return outline
}

/* ------------------------------- 术语表 ------------------------------- */

function buildTerms(blocks, vocab) {
  const terms = []
  const seen = new Set()
  const push = (term, quote, block, extra = {}) => {
    const name = cleanTerm(term)
    if (!name || name.length < 2 || name.length > 24) return
    // 三道过滤（见 RE_DEFINITION 上面的注释：第一版抓出来一半是半句话）
    if (BAD_TERM_START.test(name)) return
    if (BAD_TERM_BODY.test(name)) return
    if (/\b[A-Za-z]\b/.test(name)) return // 单字母拉丁碎屑 = OCR 认花的
    if (CJK.test(name) && name.length > 16) return
    // 拉丁术语必须**在书里被印证过**：出现过 ≥2 次、且不是被认花的近似拼法。
    // 真实数据：表格里抓出来的 `pg`（其实是 `pw`）、`We`、`YL` 都是这么滤掉的。
    if (!CJK.test(name) && vocab && !tokenTrustworthy(name, vocab)) return
    const key = name.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    terms.push({
      term: name,
      quote: String(quote).trim(),
      page: block.page,
      blockId: block.id,
      section: block.section || '',
      source: extra.source || 'textbook-sentence',
    })
  }

  for (const block of blocks) {
    if (block.kind === 'para' || block.kind === 'list') {
      for (const line of block.lines) {
        for (const s of sentences(line.text)) {
          const m = RE_DEFINITION.exec(s)
          if (!m) continue
          // 术语名不能带句读/叹号（**半角逗号也算** —— 实测 `动态资源,也可以` 就是这么漏进来的），
          // 否则那是半句话不是术语
          if (/[，。！？；、,.;!?]/.test(m[1])) continue
          push(m[1], s, block)
        }
      }
    }
    if (block.kind === 'table') {
      for (const line of block.lines.slice(1)) {
        // ⚠️ 别按"两个以上空格"切列：OCR 出来的表格**只有一个空格**，
        //    所以这里直接认"行首那个标识符"（`PrintWriter 返回一个…` → PrintWriter）
        const m = RE_TABLE_TERM.exec(String(line.text).trim())
        if (!m) continue
        push(m[1].replace(/\(\)$/, ''), line.text, block, { source: 'textbook-table' })
      }
    }
  }
  return terms
}

/* --------------------------- 代码清单 / 图表 --------------------------- */

function reviewFor(model, blockId) {
  return (model.review || []).filter((r) => r.blockId === blockId)
}

function buildListings(model, blocks) {
  return blocks
    .filter((b) => b.kind === 'code')
    .map((block) => {
      const items = reviewFor(model, block.id)
      const high = items.filter((r) => r.level === 'high')
      const lowConf = block.lines.filter((l) => l.lowConfidence).length
      // 逐行判"可信"：**不是**整块可信才出题 —— 真实样张上小语言包让大多数块都带
      // high 项，要是按块判，"先猜后验"会一条都生不出来（第一版就是这样，selfCheck=0）。
      const lines = block.lines.map((l) => ({
        text: l.text,
        confidence: l.confidence,
        trusted: isTrusted(itemFor(items, l), l),
      }))
      return {
        id: block.id,
        caption: block.caption || '',
        section: block.section || '',
        page: block.page,
        code: block.text,
        lineCount: block.lines.length,
        gutterNumbers: block.gutterNumbers || [],
        missingLines: block.missingLines || [],
        unreliable: (block.missingLines || []).length > 5,
        lowConfidenceLines: lowConf,
        verified: high.length === 0,
        issues: high.map((r) => r.message),
        trustedLines: lines.filter((l) => l.trusted).length,
        lines,
      }
    })
}

function itemFor(items, line) {
  return items.find((r) => r.y === line.y) // 行级的待核对项带 y
}

/** 这一行能不能拿来出题：置信度不低、且没有被标成可疑 */
export function isTrusted(reviewItem, line) {
  if (reviewItem) return false
  if (line.lowConfidence) return false
  return Number(line.confidence || 0) >= LOW_CONFIDENCE
}

function buildFigures(blocks) {
  return blocks
    .filter((b) => b.kind === 'figure')
    .map((b) => ({ caption: b.caption || b.title || '', page: b.page, blockId: b.id, section: b.section || '', text: b.text }))
}

function buildTables(blocks) {
  return blocks
    .filter((b) => b.kind === 'table')
    .map((b) => ({ caption: b.caption || b.title || '', page: b.page, blockId: b.id, section: b.section || '', rows: b.lines.map((l) => l.text) }))
}

/* --------------------------- "先猜后验" --------------------------- */

/**
 * 只从**可信行**出题（见文件头的硬规矩）。做法是挖掉一个"值得猜"的词，
 * 答案就是教材原文里那个词 —— 所以"验"这一步不需要模型，也不需要跑代码。
 *
 * ⚠️ 判"可信"必须**逐行**，不能"整块可信才出题"：真实样张上小语言包让 24 个代码块里
 *    23 个都带 high 项（低置信/可疑串），按块判的结果是 selfCheck **一条都没有** ——
 *    而块里其实还有 55 行是干净的（整块按行看：置信度够、没被标可疑）。
 */
function buildSelfCheck(listings, vocab) {
  const out = []
  for (const listing of listings) {
    for (const [index, line] of (listing.lines || []).entries()) {
      if (!line.trusted) continue
      const text = String(line.text || '').trim()
      if (text.length < 12) continue
      if (/^(?:\/\/|\/\*|\*)/.test(text)) continue // 注释行不挖（挖的是代码，不是中文注释）
      // `import` 行不挖：那里的 `java` / `http` / `annotation` 是包名，
      // 挖出来只是在考"你记得包名吗"，不是这一章的考点（实测第一版就出了 `A=java`）
      if (/^import\b/.test(text)) continue
      // 代码清单的题注行（`文件3-16 ForwardServlet02.java`）也不是代码
      if (/^文\s*件/.test(text)) continue
      const tokens = pickTokens(text, vocab)
      for (const token of tokens) {
        // 这个词必须在**这一段清单里只出现一次**，否则挖空了有多个答案
        const count = (String(listing.code).match(new RegExp(`\\b${token}\\b`, 'g')) || []).length
        if (count !== 1) continue
        out.push({
          kind: 'fill-token',
          listingId: listing.id,
          page: listing.page,
          section: listing.section,
          stem: `${listing.caption || '这段代码清单'}第 ${index + 1} 行里，被挖掉的是哪个词？`,
          // 答案 = 教材原文里的那个词（"先猜，再翻书对"）
          answer: token,
          line: text,
          verify: `${listing.caption || '教材原文'}第 ${index + 1} 行：${text}`,
        })
        break // 一行只挖一个
      }
    }
  }
  return out.slice(0, 12)
}

function pickTokens(text, vocab) {
  const found = []
  RE_TOKEN.lastIndex = 0
  let m
  while ((m = RE_TOKEN.exec(text))) {
    const token = m[1]
    // ★ 只留"书里印证过的"标识符 —— 这是防"拿 OCR 认错的词当标准答案"的那道闸门
    if (!tokenTrustworthy(token, vocab)) continue
    // 还要"值得猜"：要么是个调用（后面跟括号），要么是驼峰名。
    // 这样 `java` / `http` / `annotation` 这种全小写包名就不会被挖（实测第一版出了 `A=java`）
    if (!text.includes(`${token}(`) && !/[A-Z]/.test(token)) continue
    if (found.includes(token)) continue
    found.push(token)
  }
  // 优先"后面跟着括号"的（方法/函数调用），那才是这段代码的考点
  found.sort((a, b) => {
    const ca = text.includes(`${a}(`) ? 0 : 1
    const cb = text.includes(`${b}(`) ? 0 : 1
    return ca - cb
  })
  return found
}

/* ------------------------------- 人看 / 导出 ------------------------------- */

/** 预习页 → Markdown（自带出处；"引用的都是教材原话"这件事在文件里看得见） */
export function lessonToMarkdown(lesson) {
  const out = []
  const push = (s = '') => out.push(s)
  push(`# ${lesson.title}`)
  push('')
  if (lesson.book) push(`> 教材：${lesson.book}`)
  push(`> 由扫描件自动整理（${lesson.generatedFrom.pages} 页 / ${lesson.generatedFrom.blocks} 块）· 未调用任何模型`)
  push('')
  const s = lesson.stats
  push(`骨架 ${s.sections} · 术语 ${s.terms} · 代码清单 ${s.listings} · 图 ${s.figures} · 表 ${s.tables} · 先猜后验 ${s.selfCheck} · 要核对 ${s.checks}`)
  push('')
  push('## 这一章的骨架')
  for (const o of lesson.outline) {
    // 标题里本来就带编号（`3.5.2 设置响应体`），不要再补一次
    push(`${'  '.repeat(Math.max(0, o.level - 1))}- ${o.title}` + (o.page ? `  ·  p${o.page}` : ''))
  }
  push('')
  if (lesson.terms.length) {
    push('## 术语（后面的句子是教材原话）')
    for (const t of lesson.terms) push(`- **${t.term}** —— ${t.quote}`)
    push('')
  }
  if (lesson.selfCheck.length) {
    push('## 先猜后验')
    for (const [i, q] of lesson.selfCheck.entries()) {
      push(`${i + 1}. ${q.stem}`)
      push(`   - 猜：________`)
      push(`   - 验：${q.verify}`)
    }
    push('')
  }
  if (lesson.listings.length) {
    push('## 代码清单')
    for (const l of lesson.listings) {
      push(`### ${l.caption || l.id}${l.section ? ` · ${l.section}` : ''}${l.verified ? '' : '  ⚠️ 有要核对的地方'}`)
      if (!l.verified) for (const issue of l.issues) push(`> ⚠️ ${issue}`)
      push('```')
      push(l.code)
      push('```')
      push('')
    }
  }
  for (const [name, list] of [['图', lesson.figures], ['表', lesson.tables]]) {
    if (!list.length) continue
    push(`## ${name}`)
    for (const item of list) push(`- ${item.caption || item.blockId}（p${item.page}）`)
    push('')
  }
  if (lesson.checks.length) {
    push('## 上课前要问清的地方（OCR 没把握 / 版面丢了）')
    for (const c of lesson.checks) push(`- [p${c.page}] ${c.message}`)
    push('')
  }
  return out.join('\n')
}
