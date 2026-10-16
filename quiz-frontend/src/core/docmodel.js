/**
 * docmodel.js —— OCR 结果 → **文档模型**（"书本扫描件 → 交互式教学"批 1 的地基）
 * ============================================================================
 * 为什么要有这一层（"现在这个太垃圾了"的根因之一）：
 *   改之前，扫描件被压成 `pages: string[][]`（一页一堆行）就丢给后端了。
 *   于是三种东西**在同一个数组里分不出来**：
 *     · 版面噪声 —— 页眉、页脚、扫描 App 的水印、代码左边那列行号
 *     · 真正要教的东西 —— 正文段落、代码清单、表格、图
 *     · OCR 没把握的地方 —— 低置信度的字、整行漏掉的行号
 *   后端只能拿"行"去猜，猜出来自然垃圾：它连"这一段是代码"都不知道，
 *   更不知道"这行下面的 26 行是同一张清单、第 27 行根本没被识别到"。
 *
 * 这一层只做**确定性**的事（一条都不猜内容）：
 *   · 页眉/页脚/水印 → 按「位置 + 跨页重复」判定，不靠正则猜
 *   · 代码行号栏       → 按坐标判定（贴左边缘 < 13% 页宽 + 内容像行号）
 *   · 漏行             → 用行号连续性算（教材行号是连续的，缺哪个号就是漏了哪行）
 *   · 低置信度         → 逐词置信度，标出"哪一行要人看"
 *   · 代码清单/表格/图/章节标题 → 各自成块，带章节路径
 *
 * ★ 它**一个字都不改**：所有可疑处只「标记 + 进待核对清单」。
 *   "改"是下一步的事，而且必须有判据才许改（代码清单走 javac，见
 *   quiz/tools/fix_java_ocr.py）；"猜着改"已经被证明是最坏的做法。
 *
 * 纯函数：没有 DOM、不联网、不花额度 —— 所以能在 Node 里直接拿**真实 OCR 结果**
 * 跑断言（`quiz/tools/docmodel_check.mjs` 用真实 9 页样张，
 * `tests/test_engine.mjs` 的 docmodel 一节用合成夹具）。
 *
 * 输入契约（`core/ocr.js` 的 `flattenTesseract` 就产出这个形状）：
 *   [{ page, width, height, lines: [{ text, confidence, bbox:{x0,y0,x1,y1},
 *      words:[{ text, confidence, bbox }] }] }]
 */
import { cleanOcrText, isCjk, looksLikeCode } from './ocr.js'

/** 模型结构变了就改这个号（下游存了旧模型时能认出来） */
export const DOCMODEL_VERSION = 1

/** 扫描 App 的固定水印噪声（每页都有，不清会混进正文）—— 和 scan_to_text.py 同一份清单 */
export const WATERMARK = [
  '夸克扫描王', '极速扫描', '就是高效', '扫描全能王', 'CamScanner', 'CS 扫描全能王',
  '极速扫描，就是高效',
]

/**
 * 行号栏的文本形态。
 * ⚠️ 别只写纯数字：OCR 会把行号 `12` 认成 **`1.2`**（实测踩过），
 *   只认 `^\d+$` 会让这些行号漏网、然后被当成代码粘进源码里。
 *   也不能太宽 —— `3.14` 这种字面量要排除，所以小数位最多一位。
 */
export const GUTTER_RE = /^(?:\d{1,3}|\d{1,3}\.|\d\.\d)$/

/** 版面比例：这三个数是**全部**位置判据的出处，改这里就够了 */
export const BAND = {
  /** 页眉带：行底 <= 7% 页高 */
  top: 0.07,
  /** 页脚带：行顶 >= 93% 页高 */
  bottom: 0.93,
  /**
   * 行号栏：行右边界 < 15% 页宽。
   *
   * ⚠️ PC 那套（`scan_to_text.py`）写的是 **13%**，那是 rapidocr 的框量出来的
   *    （行号在 x≈272~302）。**换成 tesseract 就不够了**：真实样张上 tesseract 把
   *    行号框到 x1=316~360，13% 在 300 DPI（宽 2480）只有 322.4 ——
   *    于是 `26`（x1=325）**差 2.6 像素**没被当成行号，粘在代码前面进了正文。
   *    15% 在两种 DPI 下都成立（200 DPI 时边界 248，行号 x1≈240、正文 x0≈295）。
   *    —— 阈值这种数**必须按自己那条链的实测**定，不能照抄别人的。
   */
  gutter: 0.15,
}

/** 低于这个置信度就要人看（0~100，tesseract 用的是百分制） */
export const LOW_CONFIDENCE = 60

/* ------------------------------- 文本判据 ------------------------------- */

/**
 * 把一个小节名/章名洗掉 **OCR 带进来的标点噪声**。
 *
 * 为什么需要：扫描件里的小节标题常被认成 `3.6.2 “重定向`、`3.5.2 “设置响应体`
 * （那个 `“` 是页面上的引号/装饰被认进来的）。它会显示在题目卡上当"章节"，
 * 而**"你哪一节最弱"那条统计就是按这个字段分桶**的 —— 带噪声的话
 * `3.6.2 “重定向` 和 `3.6.2 重定向` 会分成两桶，统计就花了。
 *
 * ⚠️ **只去标点、不改字**：改字是校对台和"多数拼法"判据的事，不在这里做
 *    （否则这里就成了第二个改字的地方，坑 58）。
 * ⚠️ Python 侧（`docs_to_bank.py` 的 `_clean_label`）有一份等价实现 ——
 *    跨语言没法共用，两边规则要保持一致（改一边记得改另一边）。
 */
export function cleanLabel(raw) {
  return String(raw ?? '')
    // ⚠️ **只洗弯引号/书名号，不动反引号**：官方文档标题里的反引号是
    //    **正经 markdown**（``The `<Transition>` Component``、`` `v-if` ``），
    //    洗掉就把标题弄坏了。扫描件里的噪声恰恰是**弯引号**（`3.6.2 “重定向`）。
    .replace(/[“”‘’「」『』]/g, '')
    .replace(/^[\s·•\-–—、,，.。:：]+/, '')
    .replace(/[\s·•\-–—、,，]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^(\d+(?:\.\d+)+)\s*/, '$1 ')
    .trim()
}

export function isWatermark(text) {
  const t = String(text ?? '').trim()
  if (!t) return true
  return WATERMARK.some((w) => t.includes(w))
}

export function isGutterText(text) {
  return GUTTER_RE.test(String(text ?? '').trim())
}

/** 行号文本 → 数字（`1.2` 是 `12` 被认错的样子；`1.` 是 `1`） */
export function gutterNumber(text) {
  const t = String(text ?? '').trim()
  if (/^\d{1,3}\.\d$/.test(t)) return Number(t.replace('.', ''))
  if (/^\d{1,3}\.$/.test(t)) return Number(t.slice(0, -1))
  if (/^\d{1,3}$/.test(t)) return Number(t)
  return null
}

function stripSpaces(text) {
  return String(text ?? '').replace(/[\s\u3000]+/g, '')
}

/**
 * 跨页比较用的键：抹掉数字、空白和标点。
 * 为什么要抹数字：页脚 `第3章 Servlet 113` 每页的页码都不同，
 * 不抹掉就永远配不上"重复行"，页脚就删不掉了。
 */
export function furnitureKey(text) {
  return stripSpaces(text)
    .replace(/\d+/g, '#')
    .replace(/[，。、；：！？·…—–\-|_"'“”‘’()（）[\]{}<>《》]/g, '')
    .toLowerCase()
}

/* ------------------------------- 章节/题注 ------------------------------- */

// ⚠️ 全部容忍 CJK 逐字空格：tesseract 的中文输出是 `文 件 3-14`（坑 71），
//    `文件\s*\d+-\d+` 这种紧挨着的写法会一条都匹配不上。
const RE_CHAPTER = /^第\s*\d+\s*[章原篇]/ // `原` 是 OCR 把 `章` 认错的样子（实测）
const RE_SECTION3 = /^(\d{1,2}\.\d{1,2}\.\d{1,2})\s*(.*)$/
const RE_SECTION2 = /^(\d{1,2}\.\d{1,2})(?![\d.])\s*(.*)$/
const RE_CAPTION_CODE = /^文\s*件\s*(\d{1,2}\s*[-–—]\s*\d{1,2})/
const RE_CAPTION_FIG = /^图\s*(\d{1,2}\s*[-–—]\s*\d{1,2})/
const RE_CAPTION_TABLE = /^表\s*(\d{1,2}\s*[-–—]\s*\d{1,2})/
const RE_PAGE_NUMBER_ONLY = /^[-—–]?\s*\d{1,4}\s*[-—–]?$/
const RE_LIST_ITEM = /^(?:[（(]\s*\d{1,2}\s*[)）]|\d{1,2}\s*[.、]|[①-⑳]|[·•]\s)/

/**
 * 「页眉/页脚那一行的形态」—— **单页**就要判得出来。
 *
 * 为什么不能只靠跨页重复：站主明说学生是**断断续续传几页**的（碎片化摄入），
 * 只传 1~2 页时"这一行在别的页也出现"根本不成立 —— 实测两页的验收里，
 * 页眉 `112 JavaWeb程序设计任务教程（第3版）` 就因此留在了正文里（截图里看得见）。
 *
 * 判据是"书上跑马灯那一行的形状"，不是内容：
 *   · 不在页眉/页脚带里的不算（调用方已经先判过位置）
 *   · 成句的（以 。！？；，结尾）不算 —— 那是正文
 *   · 行首或行尾带 1~4 位页码 → 是版面行
 *     （`112 Java Web 程序设计任务教程…` 行首 112；`第3章 Servlet 113` 行尾 113，
 *      OCR 常把它认成 `第3原 Sex#j 甸113`，所以**只认数字的位置，不认字**）
 * ⚠️ 故意**不**把"含第X章"也算进来：章标题偶尔真的会出现在页面顶部，
 *    误删一章的开头比留一行页眉贵得多。有页码这一条就够用了。
 */
export function looksLikeFurnitureLine(text) {
  const t = String(text ?? '').trim()
  if (!t) return false
  if (/[。！？；，]$/.test(t)) return false
  // 形态②：**跑马灯式的章名 + 页码**（`第3章 Servlet 113` / OCR 认花成 `第3原 Sosa 113`）。
  // 这种行不管落在哪儿都是版面行 —— 教材正文不会写"第3章 xxx 113"。
  // ⚠️ 真实事故：它落在页眉带之外时活了下来，然后在 lesson 里被当成"一级标题"，
  //    整份预习页的标题就成了 `第3原 Sosa 113`。
  if (t.length <= 40 && /^第\s*\d+\s*[章原篇节]/.test(t) && /\d{1,4}\s*$/.test(t)) return true
  return /^\d{1,4}\b/.test(t) || /\d{1,4}\s*$/.test(t)
}

/** 章名 + 页码那种"跑马灯"行（上面形态②），它不该被当成章节标题 */
export function isChapterRunner(text) {
  const t = String(text ?? '').trim()
  return t.length <= 40 && /^第\s*\d+\s*[章原篇节]/.test(t) && /\d{1,4}\s*$/.test(t)
}

/** 图里的文字（截图/界面/示意图）：没有成句的中文、或明显是 `Key: value` 的转储 */function looksLikeFigureContent(text) {
  const t = String(text ?? '').trim()
  if (!t) return false
  if (/[。！？；]$/.test(t)) return false
  if (RE_CAPTION_FIG.test(t) || RE_CAPTION_TABLE.test(t) || RE_CAPTION_CODE.test(t)) return false
  if (RE_CHAPTER.test(t) || RE_SECTION2.test(t)) return false
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length
  if (cjk === 0) return true
  if (cjk / t.length < 0.3) return true
  return /^[A-Za-z][\w-]*\s*:/.test(t)
}

/**
 * 代码里"成类"的 OCR 错误（真实教材上量出来的，见交接文档「第七批」）。
 * ★ **只标记，不修改**：改是 fix_java_ocr.py 的事，而它每改一处都要有判据
 *   （javac 编译）才成立。这里的作用只是把"这行你得看一眼"指出来。
 */
const CODE_SUSPECTS = [
  { re: /\b1mport\b|\b1mp\s*ort\b/, hint: '`1mport` 多半是 `import`（i/l/1 互认）' },
  { re: /\w+O\s*[;,)]/, hint: '右括号被认成字母 O（`getWriterO` → `getWriter()`）' },
  {
    // 点号被认成逗号。⚠️ 别只匹配 `resp,` —— 实测接收者本身也会被认花
    // （`respb,setHeader (`、`zesp,setContentType (`），那样这些行就漏过了标记，
    //  然后被"先猜后验"当成可信行拿去出题（真实截图里就出过这种题）。
    // 判据写成"小写标识符 + 逗号 + 标识符 + `(` 或 `.`"，并要求中间**没有空格**
    // （正常的 `foo(a, b)` 逗号后有空格，不会中招）。
    re: /\b[a-z][A-Za-z0-9_]{1,12},[A-Za-z_][A-Za-z0-9_.]*\s*[.(]/,
    hint: '点号被认成逗号（`resp,setHeader(` → `resp.setHeader(`）',
  },
  { re: /\bI\s*=\s*-?\d/, hint: '`I=` 多半是 `!=`' },
  { re: /\w\[\)/, hint: '`[)` 多半是 `[]`' },
  { re: /\bIoException\b|\bServ1etException\b|\bHttpServletReaponae\b/, hint: 'i/l 互认或形近字母（`IoException` → `IOException`）' },
  { re: /^\s*[)\]}]/, hint: '行首孤立的括号，可能是上一行被拆断了' },
]

/* =============================== 主入口 =============================== */

/**
 * 建文档模型。
 * @param {object[]} pages 见文件头的输入契约
 * @returns {{version:number, pages:object[], sections:object[], review:object[], stats:object}}
 */
export function buildDocModel(pages, { lowConfidence = LOW_CONFIDENCE } = {}) {
  if (!Array.isArray(pages) || !pages.length) {
    throw new Error('buildDocModel：pages 不能为空（要先有 OCR 出来的版面）')
  }
  const input = pages.map((pg, index) => ({
    page: Number(pg?.page) || index + 1,
    width: Math.max(1, Number(pg?.width) || 0),
    height: Math.max(1, Number(pg?.height) || 0),
    lines: normalizeLines(pg?.lines),
  }))

  // 第一遍：跨页的"版面重复行"（页眉页脚/水印）—— 这件事必须跨页看，
  // 单页里"这行是不是页脚"根本判不出来。
  const furniture = detectFurniture(input)

  // 第二遍：逐页建模
  const outPages = input.map((pg) => buildPage(pg, furniture, lowConfidence))

  // 第三遍：章节路径（顺序跨页）
  const sections = []
  let chapter = ''
  let section = ''
  let subsection = ''
  for (const pg of outPages) {
    for (const block of pg.blocks) {
      if (block.kind === 'heading') {
        if (block.level === 1) {
          chapter = block.text
          section = ''
          subsection = ''
        } else if (block.level === 2) {
          section = block.text
          subsection = ''
        } else {
          subsection = block.text
        }
        const entry = { level: block.level, number: block.number, title: block.title, page: pg.page, blockId: block.id }
        block.section = sectionPath(chapter, section, subsection)
        sections.push(entry)
      } else if (block.kind === 'code' || block.kind === 'table' || block.kind === 'figure') {
        block.section = sectionPath(chapter, section, subsection)
      } else {
        block.section = sectionPath(chapter, section, subsection)
      }
    }
  }

  const review = collectReview(outPages)
  const stats = collectStats(outPages, review)
  // ★ 书名属于**文档本身**，所以放在文档模型里（不是预习页里）——否则下游想用书名
  //   就得各自再实现一遍"从被剔除的页眉里挑一个"（坑 58：同一判据两处实现迟早过期；
  //   Python 侧的 model: 源插件就是这么被逼出来的）。
  const book = guessBook(outPages)
  return { version: DOCMODEL_VERSION, book, pages: outPages, sections, review, stats }
}

/**
 * 这是哪本书 —— 从**被剔除的页眉**里挑。
 *
 * 页眉对正文是噪声，对"这是哪本书"却是唯一线索（每页都印着）。
 * 但要打分，不能只数次数，否则会挑到页脚或水印碎屑（这两条都是真实踩过的）：
 *   ① 页脚 `第3章 Servlet 115` 出现得一样多 → **行尾带页码的扣分**
 *   ② 水印碎屑 `〇导克扫描王`（`夸克扫描王` 被认花了）也落在页脚带里、而且没有行尾页码
 *      → 要判**像不像书名**（计算机教材几乎都带拉丁字母 / `教程`/`第X版` 这类词）
 */
export function guessBook(pages) {
  const counter = new Map()
  for (const pg of pages) {
    for (const item of pg.dropped || []) {
      if (item.kind !== 'running-head' && item.kind !== 'band-repeat') continue
      const text = String(item.text || '').replace(/^\s*\d{1,4}\s*/, '').trim()
      if (text.length < 4) continue
      const key = furnitureKey(text)
      if (!counter.has(key)) counter.set(key, { text, n: 0 })
      counter.get(key).n += 1
    }
  }
  let best = null
  for (const entry of counter.values()) {
    if (isWatermark(entry.text) || /扫描|高效|CamScanner/i.test(entry.text)) continue
    const text = entry.text
    const noPageNumber = /\d{1,4}\s*$/.test(text) ? 0 : 2
    const longEnough = text.length >= 10 ? 1 : 0
    const latin = /[A-Za-z]{2,}/.test(text) ? 3 : 0
    const bookish = /(教程|程序设计|原理|导论|基础|技术|第\s*\d+\s*版|AIGC|实践)/.test(text) ? 2 : 0
    const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
    if (cjk / Math.max(1, text.length) > 0.85 && text.length < 12) continue // 一整块汉字的水印碎屑
    const score = entry.n * 2 + noPageNumber + longEnough + latin + bookish
    if (!best || score > best.score) best = { ...entry, score }
  }
  if (!best) return ''
  // 洗一遍：OCR 的汉字间空格、`（第3版 )` 这种括号前的空格
  return cleanOcrText(best.text)
    .replace(/\s+([)）】」》])/g, '$1')
    .replace(/([(（【「《])\s+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function sectionPath(chapter, section, subsection) {
  return [chapter, section, subsection].filter(Boolean).join(' > ')
}

function normalizeLines(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map((line) => {
      const bbox = line?.bbox || null
      const words = (Array.isArray(line?.words) ? line.words : [])
        .map((w) => ({
          text: String(w?.text ?? ''),
          confidence: Number(w?.confidence ?? 0),
          bbox: w?.bbox || null,
        }))
        .filter((w) => w.text.trim() !== '' && w.bbox)
        .sort((a, b) => a.bbox.x0 - b.bbox.x0)
      return {
        text: String(line?.text ?? ''),
        confidence: Number(line?.confidence ?? 0),
        bbox,
        words,
        y: bbox ? bbox.y0 : 0,
      }
    })
    .filter((line) => line.text.trim() !== '')
}

/* --------------------------- ① 跨页版面重复行 --------------------------- */

function inTopBand(line, pg) {
  return !!line.bbox && line.bbox.y1 <= BAND.top * pg.height
}

function inBottomBand(line, pg) {
  return !!line.bbox && line.bbox.y0 >= BAND.bottom * pg.height
}

function detectFurniture(pages) {
  // key → { pages:Set, alwaysInBand:bool, sample:string }
  const seen = new Map()
  for (const pg of pages) {
    for (const line of pg.lines) {
      const text = line.text.trim()
      if (!text) continue
      const key = furnitureKey(text)
      if (key.length < 2) continue
      if (!seen.has(key)) seen.set(key, { pages: new Set(), alwaysInBand: true, sample: text })
      const entry = seen.get(key)
      entry.pages.add(pg.page)
      if (!(inTopBand(line, pg) || inBottomBand(line, pg))) entry.alwaysInBand = false
    }
  }

  const furniture = new Map() // key → reason
  for (const [key, entry] of seen) {
    if (isWatermark(entry.sample)) {
      furniture.set(key, 'watermark')
      continue
    }
    // 一次出现不算版面（可能是正文里重复的一句），两次以上且**每次都在页眉/页脚带**才算
    if (entry.pages.size >= 2 && entry.alwaysInBand) {
      furniture.set(key, entry.pages.size >= Math.max(2, Math.ceil(pages.length / 2)) ? 'running-head' : 'band-repeat')
    }
  }
  return furniture
}

/* ------------------------------- ② 逐页建模 ------------------------------- */

function buildPage(pg, furniture, lowConfidence) {
  const dropped = []
  const kept = []

  // ★ 行号栏是**版面上的一列**，而且在同一本书里会随页面右移
  //   （实测：第 1 页行号在 x1≈300~360，第 5 页整段右移到 x1≈433）。
  //   所以"页宽的百分之几"这种固定阈值一定有页会漏 —— 改成**按页找出那一列**。
  const band = detectGutterBand(pg.lines, pg.width)

  for (const raw of pg.lines) {
    const text = raw.text.trim()
    if (!text) continue

    if (isWatermark(text)) {
      dropped.push({ kind: 'watermark', text, y: raw.y, reason: '扫描 App 的水印' })
      continue
    }
    const key = furnitureKey(text)
    if (furniture.has(key)) {
      dropped.push({ kind: furniture.get(key), text, y: raw.y, reason: '位置 + 跨页重复 → 版面行' })
      continue
    }
    if (RE_PAGE_NUMBER_ONLY.test(text) && (inTopBand(raw, pg) || inBottomBand(raw, pg))) {
      dropped.push({ kind: 'page-number', text, y: raw.y, reason: '页眉/页脚带里的纯页码' })
      continue
    }
    // ★ 单页也判得出来的页眉/页脚（碎片化摄入时"跨页重复"不成立，见 looksLikeFurnitureLine）
    //   `isChapterRunner` 那种跑马灯行**不要求落在带里**（见那个函数的注释）
    if ((inTopBand(raw, pg) || inBottomBand(raw, pg)) && looksLikeFurnitureLine(text)) {
      dropped.push({ kind: 'running-head', text, y: raw.y, reason: '页眉/页脚带里"带页码"的那一行' })
      continue
    }
    if (isChapterRunner(text)) {
      dropped.push({ kind: 'running-head', text, y: raw.y, reason: '章名 + 页码的跑马灯行（正文不会这么写）' })
      continue
    }

    // ★ 行号栏：按**坐标**丢，不按文字猜（`scan_to_text.py` 那一版最重要的结论）。
    //   实测：行号在 x≈272~302，代码从 x≈350 开始；而 `3.14` 这种字面量
    //   在正文里（不在左边缘）所以不会被误伤。
    const { line, gutters } = stripGutter(raw, pg.width, lowConfidence, band)
    if (!line.text.trim()) {
      dropped.push({ kind: 'gutter', text, y: raw.y, reason: '整行就是行号栏', numbers: gutters.map((g) => g.n) })
      continue
    }
    kept.push({ ...line, gutters })
  }

  const { blocks, warnings } = groupBlocks(kept, pg, lowConfidence)

  // ★ 对账：一行都不能凭空消失。
  //   第一版真的丢过行（分块时把图区里的行先吃掉、块却没建起来），
  //   而它**不报错**——只是内容悄悄少了。所以把"进出的行数"写成本层的硬约束。
  const accounted = blocks.reduce((n, b) => n + b.lines.length, 0)
  if (accounted !== kept.length) {
    warnings.push({
      code: 'lines-lost',
      level: 'high',
      message: `对账不平：进分块 ${kept.length} 行，落到块里只有 ${accounted} 行`,
    })
  }

  return {
    page: pg.page,
    width: pg.width,
    height: pg.height,
    blocks,
    dropped,
    warnings,
    inputLines: pg.lines.length,
    keptLines: kept.length,
    accountedLines: accounted,
  }
}

/**
 * 把贴在左边缘的"行号"从行里剥出来。
 * 两种形态都要处理（`scan_to_text.py` 踩过两次才成）：
 *   ① 行号与代码在**同一个词列表**里（`18 resp.setHeader(...)`）
 *   ② 行号**单独成行**（OCR 有时把它当独立文字块）—— 剥完就没字了 → 整行丢
 */
/**
 * 找出这一页的**行号栏**在哪儿（返回一个 x 区间）。
 *
 * 为什么不能写死比例：同一本书里代码清单会缩进变化 —— 实测第 1 页行号的
 * 右边界是 300~360，第 5 页整段右移到 433（15% 页宽 = 372，于是第 5 页那列
 * `1 import jakarta...` 的行号没被剥掉、直接粘进了源码）。
 * 行号栏是**版面上的一列**：同一页里它会落在很窄的一段 x 里，用中位数就能圈出来。
 * 圈不出来（少于 3 个候选）就返回 null，退回"页宽 15%"这个保守阈值。
 */
function detectGutterBand(lines, width) {
  const xs = []
  for (const line of lines) {
    for (const word of line.words || []) {
      if (!word.bbox || !isGutterText(word.text)) continue
      if (word.bbox.x1 > 0.3 * width) continue // 太靠右：那是正文里的数字，不是行号栏
      xs.push(word.bbox.x1)
    }
  }
  if (xs.length < 3) return null
  const sorted = xs.slice().sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const column = sorted.filter((x) => Math.abs(x - median) <= 60)
  if (column.length < 3) return null
  return { min: Math.min(...column) - 30, max: Math.max(...column) + 30, candidates: xs.length, column: column.length }
}

function inGutterBand(x, width, band) {
  if (band) return x >= band.min && x <= band.max
  return x < BAND.gutter * width
}

function stripGutter(line, width, lowConfidence, band) {
  const edge = BAND.gutter * width

  // 先按位置分成"行号栏那一列的词"和"正文的词"
  const edgeWords = []
  let bodyWords = []
  for (const word of line.words) {
    if (word.bbox && inGutterBand(word.bbox.x1, width, band)) edgeWords.push(word)
    else bodyWords.push(word)
  }

  // 正文拼出来，用它判断"这一行到底是不是代码" —— 噪声要不要剥取决于这个
  const bodyText = cleanOcrText(bodyWords.reduce((acc, w) => joinWord(acc, w.text), '')).trim()
  const looksCode = looksLikeCode(bodyText) || /[;{}()[\]]/.test(bodyText)

  const gutters = []
  const back = []
  const edgeNumbers = edgeWords.filter((w) => isGutterText(w.text))
  for (const word of edgeWords) {
    if (isGutterText(word.text)) {
      // 行号 → 无条件剥离（正文极少以数字开头；编号列表丢个序号是可接受的代价，
      // 而把行号留在代码里会直接毁掉源码）
      gutters.push({ text: word.text, n: gutterNumber(word.text), y: line.y })
      continue
    }
    // ★ 贴在行号边上的**识别噪声**（实测：行号 `27` 被拆成 `2` `了` `7`，
    //   `36` 被拆成 `睛` `6` `必`）—— 这些碎屑也贴在左边缘。
    //   ⚠️ 两道闸门，缺一不可（第一版只有第一道，把正文行首的「的」剥掉了、
    //   整行还被判成代码块 —— 真的踩到了）：
    //     ① 同一行里**必须真的有一个数字行号**（噪声是行号被认花时旁边的碎屑，
    //        正文里没有这个数字，所以正文永远不会中招）
    //     ② 剩下的部分还得像代码
    if (edgeNumbers.length && looksCode && isEdgeNoise(word.text)) {
      gutters.push({ text: word.text, n: null, y: line.y, noise: true })
      continue
    }
    back.push(word)
  }
  if (back.length) bodyWords = [...back, ...bodyWords]

  // ★ 形态③：行号与代码被粘成一个词（小模型上常见）。位置事实没变，把开头的号切出来。
  //   判据用词的**左边界**（粘成一坨时右边界会一直到行尾，不能用来判列）。
  const leftLimit = band ? band.max : edge
  const glued = splitGluedGutter(bodyWords, leftLimit)
  if (glued) {
    gutters.push({ text: glued.numberText, n: gutterNumber(glued.numberText), y: line.y, glued: true })
    bodyWords = [{ ...bodyWords[0], text: glued.rest }, ...bodyWords.slice(1)]
  }

  const text = cleanOcrText(bodyWords.reduce((acc, w) => joinWord(acc, w.text), '')).trim()
  return {
    line: { ...line, text, words: bodyWords, lowConfidence: line.confidence < lowConfidence },
    gutters,
  }
}

/**
 * 贴在左边缘的"识别噪声"：≤2 个字符，而且既没有字母也没有数字
 * （单个汉字 / 单个符号 —— 行号被认花时旁边的碎屑）。
 * 只在**左边缘带内**才这么判，所以正文里正常的短词不会中招。
 */
function isEdgeNoise(text) {
  const t = String(text ?? '').trim()
  if (!t || t.length > 2) return false
  return !/[0-9A-Za-z]/.test(t)
}

/**
 * 行号与代码被 OCR 粘成一个词时的补救。
 * ⚠️ 允许数字前面最多两个杂字：实测 `了7`（=27）——
 *    那个汉字是**识别噪声贴在数字上**，位置仍然在最左边。
 */
function splitGluedGutter(kept, edge) {
  const first = kept[0]
  if (!first || !first.bbox || first.bbox.x0 >= edge) return null
  const m = /^[^\d]{0,2}(\d{1,3}(?:\.\d)?)\s+(.+)$/.exec(first.text)
  if (!m) return null
  const rest = m[2].trim()
  if (!rest) return null
  if (!looksLikeCode(rest) && !/[;{}()[\]]/.test(rest)) return null
  return { numberText: m[1], rest }
}

function joinWord(left, right) {
  if (!left) return right
  if (!right) return left
  return isCjk(left[left.length - 1]) && isCjk(right[0]) ? left + right : `${left} ${right}`
}

/* --------------------------- ③ 分块（代码/表/图/标题） --------------------------- */

function groupBlocks(lines, pg, lowConfidence) {
  const blocks = []
  const warnings = []
  const figureStart = new Map() // 题注行索引 → 图区起始索引
  const figureContent = new Set() // 图区里的所有行索引

  // 图里的文字在**题注前面**（`图 3-17` 是图下方那行），所以要往回吃
  for (let i = 0; i < lines.length; i++) {
    if (!RE_CAPTION_FIG.test(lines[i].text.trim())) continue
    let start = i
    while (start > 0 && looksLikeFigureContent(lines[start - 1].text)) start--
    if (start < i) {
      figureStart.set(i, start)
      for (let k = start; k < i; k++) figureContent.add(k)
    }
  }

  // ⚠️ 段落/列表的"吃到哪儿为止"**必须**认图区：第一版忘了这一条，
  //    于是图里的界面文字被前面那段正文吸收掉了，图块根本建不起来（实测）。
  const isPara = (i) => !figureContent.has(i) && isParaLine(lines[i])
  const isList = (i) => !figureContent.has(i) && RE_LIST_ITEM.test(lines[i].text.trim()) && !looksLikeCode(lines[i].text)

  let index = 0
  while (index < lines.length) {
    // 图块：只要落在图区里（不管从哪一行进来），就整块吃掉
    const fig = findFigure(figureStart, index)
    if (fig) {
      const members = lines.slice(fig.start, fig.cap + 1)
      const block = makeBlock('figure', members, { index: blocks.length, title: lines[fig.cap].text.trim(), lowConfidence })
      block.caption = lines[fig.cap].text.trim()
      block.uncertain = true
      blocks.push(block)
      index = fig.cap + 1
      continue
    }

    const line = lines[index]
    const text = line.text.trim()

    if (RE_CAPTION_CODE.test(text)) {
      const block = makeBlock('code', [line], { index: blocks.length, title: text, lowConfidence })
      block.caption = text
      index = consumeCode(lines, index + 1, block, lowConfidence)
      finalizeCode(block, warnings)
      blocks.push(block)
      continue
    }
    if (RE_CAPTION_TABLE.test(text)) {
      const block = makeBlock('table', [line], { index: blocks.length, title: text, lowConfidence })
      block.caption = text
      block.columnsLost = true
      index = consumeTable(lines, index + 1, block, lowConfidence, pg.width)
      blocks.push(block)
      continue
    }
    if (RE_CHAPTER.test(text) || RE_SECTION3.test(text) || RE_SECTION2.test(text)) {
      const info = headingInfo(text)
      const block = makeBlock('heading', [line], { index: blocks.length, title: info.title, lowConfidence })
      block.level = info.level
      block.number = info.number
      blocks.push(block)
      index++
      continue
    }
    if (looksLikeCode(text) || hasGutterNumber(line)) {
      const block = makeBlock('code', [line], { index: blocks.length, title: '', lowConfidence })
      index = consumeCode(lines, index + 1, block, lowConfidence)
      finalizeCode(block, warnings)
      blocks.push(block)
      continue
    }
    if (RE_LIST_ITEM.test(text)) {
      const members = [line]
      let i = index + 1
      while (i < lines.length && isList(i)) {
        members.push(lines[i])
        i++
      }
      blocks.push(makeBlock('list', members, { index: blocks.length, title: '', lowConfidence }))
      index = i
      continue
    }

    // 剩下的默认按段落合并（连续的行属于同一段）—— 只在遇到"另一种块"时断开
    const members = [line]
    let i = index + 1
    while (i < lines.length && isPara(i)) {
      members.push(lines[i])
      i++
    }
    blocks.push(makeBlock('para', members, { index: blocks.length, title: '', lowConfidence }))
    index = i
  }

  for (const block of blocks) block.page = pg.page
  return { blocks, warnings }
}

function findFigure(figureStart, index) {
  for (const [cap, start] of figureStart) {
    if (index >= start && index <= cap) return { start, cap }
  }
  return null
}

/** 这一行有没有**真正的行号**（噪声碎屑不算）——"是不是代码"的判据只看这个 */
function hasGutterNumber(line) {
  return (line.gutters || []).some((g) => g.n !== null)
}

function isParaLine(line) {
  const t = line.text.trim()
  if (!t) return false
  if (hasGutterNumber(line)) return false
  if (looksLikeCode(t)) return false
  if (RE_CAPTION_CODE.test(t) || RE_CAPTION_FIG.test(t) || RE_CAPTION_TABLE.test(t)) return false
  if (RE_CHAPTER.test(t) || RE_SECTION3.test(t) || RE_SECTION2.test(t)) return false
  if (RE_PAGE_NUMBER_ONLY.test(t)) return false
  return true
}

/**
 * 一个代码块吃到哪儿为止。
 * 允许中间夹**一行**非代码（教材里常见：中文注释被 OCR 单独拆出来），
 * 但要求那一行还带着行号 —— 行号在，说明它确实在这段清单里。
 */
function consumeCode(lines, start, block, lowConfidence) {
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    const t = line.text.trim()
    if (RE_CAPTION_CODE.test(t) || RE_CAPTION_FIG.test(t) || RE_CAPTION_TABLE.test(t)) break
    if (RE_CHAPTER.test(t) || RE_SECTION3.test(t)) break
    const isCode = looksLikeCode(t) || hasGutterNumber(line)
    if (!isCode) {
      const next = lines[i + 1]
      const nextIsCode = next && (looksLikeCode(next.text) || hasGutterNumber(next))
      if (!(block.lines.length && nextIsCode && hasGutterNumber(line))) break
    }
    addLine(block, line, lowConfidence)
    i++
  }
  return i
}

function consumeTable(lines, start, block, lowConfidence, width) {
  let i = start
  while (i < lines.length) {
    const t = lines[i].text.trim()
    if (RE_CAPTION_TABLE.test(t) || RE_CAPTION_CODE.test(t) || RE_CAPTION_FIG.test(t)) break
    if (RE_CHAPTER.test(t) || RE_SECTION3.test(t) || RE_SECTION2.test(t)) break
    // ⚠️ 表格单元格里出现 `getOutputStream()` 这种"像代码"的字样是**正常的**
    //    （表3-13 讲的就是两个方法）—— 第一版在这里断开了，把表最后一行切成了一个
    //    假的代码块。真正的代码清单在这本教材里都带行号栏，所以用行号当边界。
    if (lines[i].gutters.some((g) => g.n !== null)) break
    // 正文回来了：没有列间隙、而且以句号收尾 → 表格结束
    if (/[。；]$/.test(t) && wideGaps(lines[i], width) === 0) break
    addLine(block, lines[i], lowConfidence)
    i++
  }
  return i
}

/** 一行里有几处"明显的列间隙"（表格行的特征：词与词之间空一大块） */
function wideGaps(line, width) {
  const words = line.words || []
  let gaps = 0
  for (let k = 1; k < words.length; k++) {
    if (words[k].bbox.x0 - words[k - 1].bbox.x1 > 0.18 * width) gaps++
  }
  return gaps
}

function makeBlock(kind, lines, { index, title = '', lowConfidence = LOW_CONFIDENCE }) {
  const block = {
    id: '', // 由调用方补页号后回填
    kind,
    title: String(title || ''),
    text: '',
    lines: [],
    bbox: null,
    confidence: 0,
    lowConfidence: false,
    section: '',
  }
  for (const line of lines) addLine(block, line, lowConfidence)
  block.id = `b${index + 1}`
  return block
}

function addLine(block, line, lowConfidence) {
  const entry = {
    text: line.text,
    confidence: Number(line.confidence ?? 0),
    y: line.y,
    x0: line.bbox ? line.bbox.x0 : 0,
    x1: line.bbox ? line.bbox.x1 : 0,
    lowConfidence: Number(line.confidence ?? 0) < lowConfidence,
    gutters: (line.gutters || []).map((g) => g.n).filter((n) => n !== null),
  }
  block.lines.push(entry)
  block.text = block.text ? `${block.text}\n${entry.text}` : entry.text
  const ys = block.lines.map((l) => l.y)
  const xs0 = block.lines.map((l) => l.x0)
  const xs1 = block.lines.map((l) => l.x1)
  block.bbox = { x0: Math.min(...xs0), y0: Math.min(...ys), x1: Math.max(...xs1), y1: Math.max(...ys) }
  const confs = block.lines.map((l) => l.confidence).filter((c) => c > 0)
  block.confidence = confs.length ? Math.min(...confs) : 0
  block.lowConfidence = block.lines.some((l) => l.lowConfidence)
}

/**
 * 代码块的**行号连续性检查** —— 这是"漏行"唯一的确定性判据。
 * 教材清单的行号是连续的（1..27），缺哪个号就是漏了哪一行；
 * 漏行**补不回来**（也不该猜），所以这里只把它精确指出来。
 */
function finalizeCode(block, warnings) {
  const numbers = []
  for (const line of block.lines) for (const n of line.gutters) if (!numbers.includes(n)) numbers.push(n)
  block.gutterNumbers = numbers.slice().sort((a, b) => a - b)
  if (numbers.length < 3) return
  const min = Math.min(...numbers)
  const max = Math.max(...numbers)
  const missing = []
  for (let n = min; n <= max; n++) if (!numbers.includes(n)) missing.push(n)
  block.missingLines = missing
  if (!missing.length) return

  // ⚠️ 两档，不是一个档（真实样张量出来的）：
  //   号少、跨度大的时候，"缺哪几个号"这个结论**本身不可靠** ——
  //   实测小模型把行号 22 认成 2，于是一次报出「第 3~22 行都没识别到」二十个缺号，
  //   等于没报。这时候该说的是"整段要对着原书核对"，而不是列一串假缺号。
  const dense = missing.length <= 5 && max - min + 1 <= 2 * numbers.length
  if (dense) {
    warnings.push({
      code: 'missing-lines',
      level: 'high',
      message: `代码清单的行号不连续：第 ${missing.join('、')} 行没被识别到（漏行补不回来，要你看）`,
      blockId: block.id,
    })
  } else {
    warnings.push({
      code: 'gutter-unreliable',
      level: 'high',
      message: `这段代码清单的行号读不可靠（只读到 ${numbers.length} 个号、跨度 ${min}~${max}）→ 整段要对着原书核对`,
      blockId: block.id,
    })
  }
}

function headingInfo(text) {
  const t = text.trim()
  let m = RE_SECTION3.exec(t)
  if (m) return { level: 3, number: stripSpaces(m[1]), title: t }
  m = RE_SECTION2.exec(t)
  if (m) return { level: 2, number: stripSpaces(m[1]), title: t }
  return { level: 1, number: (t.match(/\d+/) || [''])[0], title: t }
}

/* --------------------------- ④ 待核对清单 --------------------------- */

function collectReview(pages) {
  const items = []
  const levelRank = { high: 0, warn: 1, info: 2 }

  for (const pg of pages) {
    for (const block of pg.blocks) {
      const where = { page: pg.page, blockId: block.id, section: block.section, kind: block.kind }

      if (block.kind === 'code') {
        for (const warning of pg.warnings.filter((w) => w.blockId === block.id)) {
          items.push({ ...where, level: warning.level, code: warning.code, message: warning.message })
        }
        for (const line of block.lines) {
          // 代码里的可疑串：**只标不改**（改要有 javac 判据）
          for (const suspect of CODE_SUSPECTS) {
            if (suspect.re.test(line.text)) {
              items.push({
                ...where, level: 'high', code: 'code-suspect', y: line.y, text: line.text,
                message: `代码可疑：${suspect.hint}`,
              })
              break
            }
          }
          if (line.lowConfidence) {
            items.push({
              ...where, level: 'high', code: 'low-confidence', y: line.y, text: line.text,
              message: `这行置信度只有 ${line.confidence.toFixed(0)}，代码认错会直接变成错的期望输出`,
            })
          }
        }
        continue
      }

      if (block.kind === 'table') {
        items.push({
          ...where, level: 'warn', code: 'table-columns-lost',
          message: `${block.caption || '表格'}：OCR 只给了行，**列关系已经丢了** —— 这张表要人对着原书核对`,
        })
      }
      if (block.kind === 'figure') {
        items.push({
          ...where, level: 'info', code: 'figure-region',
          message: `${block.caption || '图'}：这块是图里的文字，已单独成块（别当正文出题）`,
        })
      }
      for (const line of block.lines) {
        if (!line.lowConfidence) continue
        items.push({
          ...where, level: 'warn', code: 'low-confidence', y: line.y, text: line.text,
          message: `这行置信度只有 ${line.confidence.toFixed(0)}`,
        })
      }
    }
  }

  items.sort((a, b) => levelRank[a.level] - levelRank[b.level] || a.page - b.page || (a.y || 0) - (b.y || 0))
  return items
}

function collectStats(pages, review) {
  const dropped = pages.flatMap((pg) => pg.dropped)
  const blocks = pages.flatMap((pg) => pg.blocks)
  const codeBlocks = blocks.filter((b) => b.kind === 'code')
  const inputLines = pages.reduce((n, pg) => n + (pg.inputLines || 0), 0)
  return {
    pages: pages.length,
    blocks: blocks.length,
    // ★ 对账三件套：进来的行 = 落到块里的行 + 明确剔除的行。差分必须是 0。
    inputLines,
    keptLines: blocks.reduce((n, b) => n + b.lines.length, 0),
    droppedLines: dropped.length,
    reconcile: inputLines - (blocks.reduce((n, b) => n + b.lines.length, 0) + dropped.length),
    watermarks: dropped.filter((d) => d.kind === 'watermark').length,
    headers: dropped.filter((d) => d.kind === 'running-head' || d.kind === 'band-repeat').length,
    pageNumbers: dropped.filter((d) => d.kind === 'page-number').length,
    gutterDropped: dropped.filter((d) => d.kind === 'gutter').length,
    codeBlocks: codeBlocks.length,
    codeLines: codeBlocks.reduce((n, b) => n + b.lines.length, 0),
    // "缺了哪几行"是可靠结论的（号密、跨度小）
    codeMissingLines: codeBlocks.reduce((n, b) => n + (b.missingLines?.length || 0), 0),
    // "整段要人核对"的（行号读不可靠）——两者不能混成一个数字
    codeUnreliable: codeBlocks.filter((b) => (b.missingLines?.length || 0) > 5).length,
    tables: blocks.filter((b) => b.kind === 'table').length,
    figures: blocks.filter((b) => b.kind === 'figure').length,
    headings: blocks.filter((b) => b.kind === 'heading').length,
    lowConfidenceLines: blocks.reduce((n, b) => n + b.lines.filter((l) => l.lowConfidence).length, 0),
    review: {
      high: review.filter((r) => r.level === 'high').length,
      warn: review.filter((r) => r.level === 'warn').length,
      info: review.filter((r) => r.level === 'info').length,
    },
  }
}

/* --------------------------- ⑤ 出口（给下游用） --------------------------- */

/**
 * 文档模型 → 老的 `pages: string[][]` 契约。
 *
 * ★ 为什么要这两个出口并存：后端 `/api/quiz/import/` 吃的是"一页一行"，
 *   那条路一行都不用改（改它等于同时改后端、测试、验收脚本）。
 *   校对台改了文字之后，也**只**需要通过这个函数重新生成 `pages` 就能再导入。
 *   ⚠️ 丢弃的版面行（页眉/页脚/水印/行号栏）**不会**出现在这里 —— 这正是这一层的目的。
 */
export function docModelToPages(model, { includeKinds = null } = {}) {
  return model.pages.map((pg) =>
    pg.blocks
      // ★ 人对着原书判定"这一块不用于出题"的（图里的文字、纯装饰、彻底认花的），
      //   在这里就被剔掉 —— 送后端的文字**取这个出口**，所以排除立刻生效。
      //   校对台里那个「不用于出题」按钮改的就是 block.excluded。
      .filter((b) => !b.excluded)
      .filter((b) => (includeKinds ? includeKinds.includes(b.kind) : true))
      .flatMap((b) => b.lines.map((l) => l.text))
      .filter((t) => t.trim()),
  )
}

/** 带页标记的纯文本（人看 / 存 .txt / 喂离线工具都用这个） */
export function modelToText(model) {
  const out = []
  for (const pg of model.pages) {
    out.push(`<!-- page ${pg.page} -->`)
    for (const block of pg.blocks) {
      if (block.excluded) out.push('<!-- 这一块被人工排除，不用于出题 -->')
      if (block.kind === 'code') out.push(`\`\`\`${block.caption ? ` ${block.caption}` : ''}`)
      for (const line of block.lines) out.push(line.text)
      if (block.kind === 'code') out.push('```')
    }
  }
  return out.join('\n')
}

/**
 * 还有哪些**高风险项**没过，按页分组（校对台用它告诉人"还剩哪几页"）。
 *
 * 为什么要有这个纯函数：真实样张上高风险项跨好几页（实测 2 页 9 条），
 * 而**校对台一次只渲染当前页的项**。人把这一页全勾完，底部的计数却只从 9 掉到 5、
 * 「继续生成」还是灰的 —— 看起来就是"点了没用"。所以计数必须能说出**在哪一页**，
 * 并且要能一键跳过去。判据放这里（纯函数、可离线断言），组件只负责显示。
 */
export function remainingHighByPage(model, acked) {
  const counts = new Map()
  for (const [idx, item] of (model.review || []).entries()) {
    if (item.level !== 'high') continue
    if (acked && typeof acked.has === 'function' && acked.has(idx)) continue
    const page = item.page || 0
    counts.set(page, (counts.get(page) || 0) + 1)
  }
  return counts
}


/** 待核对清单（默认全部；`minLevel` 可只看 high） */
export function reviewOf(model, { minLevel = 'info' } = {}) {
  const rank = { high: 0, warn: 1, info: 2 }
  return model.review.filter((r) => rank[r.level] <= rank[minLevel])
}

/**
 * 允许"直接导入"的判断：**不允许静默通过**。
 * 只要有 high 级待核对项，就必须由人显式确认（`acked`），否则前端不许往下走。
 * 这条是这一层的意义所在 —— 改之前界面上只有一句"代码容易认错，请核对"，
 * 然后照样拿没核对的文字去出题。
 */
export function canProceed(model, { acked = false } = {}) {
  const high = model.review.filter((r) => r.level === 'high')
  return { ok: high.length === 0 || acked, blockers: high.length, unacked: high.length }
}
