#!/usr/bin/env node
/**
 * docmodel_check.mjs —— 文档模型的**真实样张**离线验收（批 1 的验收工具）
 * ============================================================================
 * 它跑的是**生产同一套代码**，只把运行环境从浏览器换成 Node：
 *   · OCR：tesseract.js，语言包直接用站点自托管的那两份
 *     （`frontend/public/ocr/*.traineddata.gz` = `4.0.0_best_int`，用户真正下载的就是它）
 *   · 版面→结构：`frontend/src/core/ocr.js` 的 `pageFromTesseract`
 *   · 结构化：`frontend/src/core/docmodel.js` 的 `buildDocModel`
 *   → 所以这里量出来的数字就是用户会遇到的数字（不是"另一套实现"），
 *     这也正是坑 58 的教训：**同一判据只能有一处实现**。
 *
 * ★ 不花钱：这一整个工具不碰 LLM，零额度。
 *
 * 样张：`.tmp/pages300/p01..p09.png`（真实教材《Java Web 程序设计任务教程（第3版）》
 *       9 页扫描件，300 DPI；页面尺寸 2480×3775）。这些 PNG 在 .gitignore 里。
 *       ⚠️ 站点里 OCR 走的是 **200 DPI**（`BankTools.vue` 里 `dpi: 200`）——
 *       想验生产那一档就 `--dir .tmp/pages`（1653×2517，同一份 PDF）。
 *       默认用 300 DPI 是为了和已有的基线 `.tmp/tess_book.txt` 对得上（同输入才可比）。
 *
 * 用法（在仓库根目录）：
 *     node quiz/tools/docmodel_check.mjs                 # 9 页全跑
 *     node quiz/tools/docmodel_check.mjs --limit 3       # 先跑 3 页（快）
 *     node quiz/tools/docmodel_check.mjs --raw .tmp/docpages9.json   # 存下 OCR 版面
 *     node quiz/tools/docmodel_check.mjs --from-raw .tmp/docpages9.json   # 复用（调规则免重跑 OCR）
 *     node quiz/tools/docmodel_check.mjs --dir .tmp/pages # 按站点那档 200 DPI 跑
 *     node quiz/tools/docmodel_check.mjs --lang .tmp/ocr-bench/tessdata   # 换全量模型比质量
 *
 * ⚠️ 换模型比质量时**必须**让两个模型的缓存分开（本工具已按语言包目录自动隔离）——
 *    共用缓存目录会让"换模型"变成假动作，这个仓库已经栽过一次（见下面 cachePath 的注释）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { pageFromTesseract } from '../frontend/src/core/ocr.js'
import { buildDocModel, docModelToPages, modelToText, canProceed, reviewOf } from '../frontend/src/core/docmodel.js'
import { buildLesson, lessonToMarkdown } from '../frontend/src/core/lesson.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const FRONTEND = path.join(ROOT, 'quiz', 'frontend')

/* ------------------------------- 参数 ------------------------------- */
function argOf(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const PAGES_DIR = path.resolve(ROOT, argOf('--dir', '.tmp/pages300'))
const LIMIT = Number(argOf('--limit', '0')) || 0
const JSON_OUT = argOf('--json', path.join(ROOT, '.tmp', 'docmodel.json'))
const RAW_IN = argOf('--from-raw', '') // 复用已有的 OCR 版面（调规则时免重跑 OCR）
const RAW_OUT = argOf('--raw', '') // 给了就把 OCR 的版面结构也存下来（调 docmodel 时不用重跑 OCR）
const TEXT_OUT = path.join(ROOT, '.tmp', 'docmodel.txt')
// 默认用**站点自托管的那份**语言包（4.0.0_best_int，4.7MB）——
// 这里量的必须是用户真正会得到的东西。想看全量模型：--lang .tmp/ocr-bench/tessdata
const LANG_DIR = path.resolve(ROOT, argOf('--lang', 'quiz/frontend/public/ocr'))
// 和旧产出对账：**默认关**。旧产出是另一个模型/DPI 跑出来的，数字不可比
//（第一版默认开着，量出"96.6% 丢失"，纯属模型不同的假警报）。要看就显式给。
const BASELINE = argOf('--baseline', '')

let pass = 0
let failed = 0
function ok(cond, label, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}${extra ? `  →  ${extra}` : ''}`)
  }
}

/* --------------------------- 小工具（无依赖） --------------------------- */
/** PNG 的宽高在 IHDR 里（字节 16..24，大端）—— 免得为这一件事装一个图像库 */
function pngSize(file) {
  const buf = fs.readFileSync(file)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/**
 * 语言包的缓存目录名：**按文件内容**算（不是按目录名）。
 * 为什么：tesseract.js 的缓存键只认语言名，同一台机器上"换了模型但目录名没变"
 * 就会静默复用旧模型 —— 这个仓库已经在 Node 侧和浏览器侧各栽过一次
 * （交接文档坑 77）。用内容的 sha256 前 8 位当目录名，换模型必然换目录。
 */
function cacheKeyFor(langPath) {
  const hash = crypto.createHash('sha256')
  for (const name of ['chi_sim.traineddata.gz', 'eng.traineddata.gz']) {
    const file = path.join(langPath, name)
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0
    hash.update(`${name}:${size}:`)
    if (size) hash.update(fs.readFileSync(file))
  }
  return `${path.basename(langPath)}-${hash.digest('hex').slice(0, 8)}`
}

const stripSpaces = (s) => String(s).replace(/[\s\u3000]+/g, '')
/** 对账用：去掉空白 + 去掉可能粘在行首的行号（旧产出里行号和代码是同一行） */
const normLine = (s) => stripSpaces(s).replace(/^\d{1,3}/, '')

/* ------------------------------- 主体 ------------------------------- */
async function main() {
  // 复用 OCR 版面时不要求样张还在（.tmp 会被清理）
  let files = []
  if (!RAW_IN) {
    if (!fs.existsSync(PAGES_DIR)) {
      console.error(`找不到样张目录：${PAGES_DIR}`)
      console.error('（那 9 页真实扫描件不在仓库里；换一台机器就要重新放一份，或者用 --dir 指定）')
      return 2
    }
    files = fs.readdirSync(PAGES_DIR).filter((f) => /^p\d+\.png$/i.test(f)).sort()
    if (LIMIT) files = files.slice(0, LIMIT)
    if (!files.length) {
      console.error(`${PAGES_DIR} 里没有 p01.png 这样的样张`)
      return 2
    }
  }

  const langPath = LANG_DIR
  for (const lang of ['chi_sim.traineddata.gz', 'eng.traineddata.gz']) {
    if (!fs.existsSync(path.join(langPath, lang))) {
      console.error(`缺语言包：${path.join(langPath, lang)}`)
      return 2
    }
  }

  const docPages = []
  if (RAW_IN) {
    // 复用上一次的 OCR 结果：调 docmodel 的规则时**不要每次重跑 OCR**（9 页 40s+，
    // 而且 OCR 本身有随机性，重跑会让"改了规则"和"OCR 抖了"混在一起分不清）。
    if (process.argv.includes('--lang')) {
      // ⚠️ 护栏：`--from-raw` 意味着**根本不跑 OCR**，这时 `--lang` 是死参数。
      //    不提醒的话很容易得出"换了模型也一样"的假结论 —— 本仓库已经栽过一次
      //    （共用语言缓存那次）。这里直接说清楚，别让人自己骗自己。
      console.log('⚠️  --from-raw 复用的是**已有**的 OCR 版面，--lang 不会生效（想看模型差异就别给 --from-raw）')
    }
    const rawPath = path.resolve(ROOT, RAW_IN)
    if (!fs.existsSync(rawPath)) {
      console.error(`找不到 --from-raw 的文件：${rawPath}`)
      return 2
    }
    docPages.push(...JSON.parse(fs.readFileSync(rawPath, 'utf8')))
    console.log(`复用 OCR 版面：${path.relative(ROOT, rawPath)}（${docPages.length} 页，跳过 OCR）`)
  } else {
    // tesseract.js 是 CJS，而且装在 frontend/ 下 —— 用那里的 require 去解析，
    // 保证工具和站点用的是**同一个版本**（版本不同，版面输出也会不同）。
    const require = createRequire(path.join(FRONTEND, 'package.json'))
    const { createWorker } = require('tesseract.js')

    const cachePath = path.join(ROOT, '.tmp', 'ocr-cache', cacheKeyFor(langPath))
    // ★★ 缓存目录**必须按语言包的内容**分开（这就是本仓库最贵的一个假测量）：
    //    tesseract.js 的语言缓存**只按语言名存**（`cache/chi_sim.traineddata`），
    //    不认模型文件。2026-10-08 那次"4.0.0_best_int(4.5MB) 和 4.0.0(31MB) 输出
    //    完全一致 → 发小的"就是**共用 cache 目录**造成的：小模型那次直接命中了
    //    全量模型的缓存（那份 cache/chi_sim.traineddata 有 42.3MB = 全量模型），
    //    两次跑的其实是同一个模型。实测（分开缓存）在真实教材代码上：
    //      best_int 命中 5/8 个关键 API 串（`setHeader`→`setHeadqer`）
    //      全量     命中 8/8
    //    ⚠️ 2026-10-10 又栽了半次：隔离键一开始用的是**目录名**（`ocr`），
    //       而换模型后目录名没变 → 工具复用了旧模型的缓存、量出来的还是老数字。
    //       现在按**模型文件内容的哈希**隔离（见 cacheKeyFor），换模型就必然换目录。
    fs.mkdirSync(cachePath, { recursive: true })
    console.log(`样张：${PAGES_DIR}（${files.length} 页）`)
    console.log(`语言包：${path.relative(ROOT, langPath)}（缓存 ${path.relative(ROOT, cachePath)}，按语言包目录隔离）`)
    console.log('建 tesseract worker（chi_sim + eng）…')
    const t0 = Date.now()
    const worker = await createWorker(['chi_sim', 'eng'], 1, { langPath, cachePath, gzip: true, logger: () => {} })
    console.log(`worker 就绪 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`)

    try {
      for (const [i, file] of files.entries()) {
        const full = path.join(PAGES_DIR, file)
        const { width, height } = pngSize(full)
        const t = Date.now()
        // output 里点名 blocks —— 只要 text 的话 tesseract 不解析版面，拿不到 bbox
        const { data } = await worker.recognize(full, {}, { text: true, blocks: true })
        const page = pageFromTesseract(data, { page: i + 1, width, height })
        docPages.push(page)
        console.log(
          `  第 ${page.page} 页：${page.lines.length} 行 / ${width}×${height} / ` +
            `${((Date.now() - t) / 1000).toFixed(1)}s`,
        )
      }
    } finally {
      await worker.terminate()
    }
  }

  /* --------------------------- 建文档模型 --------------------------- */
  if (RAW_OUT) {
    const rawPath = path.resolve(ROOT, RAW_OUT)
    fs.mkdirSync(path.dirname(rawPath), { recursive: true })
    fs.writeFileSync(rawPath, `${JSON.stringify(docPages)}\n`, 'utf8')
    console.log(`OCR 版面结构已存：${path.relative(ROOT, rawPath)}（可用 --from-raw 复用，免重跑 OCR）`)
  }

  console.log('\n═══ 文档模型（实测）═══')
  const model = buildDocModel(docPages)
  const stats = model.stats
  console.log(
    `  页 ${stats.pages} · 块 ${stats.blocks}（代码 ${stats.codeBlocks} / 表 ${stats.tables} / 图 ${stats.figures} / 标题 ${stats.headings}）\n` +
      `  行：进 ${stats.inputLines} = 落块 ${stats.keptLines} + 剔除 ${stats.droppedLines}（对账差分 ${stats.reconcile}）\n` +
      `      剔除明细：水印 ${stats.watermarks}、页眉页脚 ${stats.headers}、页码 ${stats.pageNumbers}、行号栏 ${stats.gutterDropped}\n` +
      `  代码行 ${stats.codeLines}；漏行（可靠）${stats.codeMissingLines} 行、行号读不可靠的段 ${stats.codeUnreliable} 个\n` +
      `  低置信行 ${stats.lowConfidenceLines}\n` +
      `  待核对：high ${stats.review.high} / warn ${stats.review.warn} / info ${stats.review.info}`,
  )

  console.log('\n  章节：')
  for (const s of model.sections.slice(0, 40)) {
    console.log(`    ${'  '.repeat(Math.max(0, s.level - 1))}${s.number || '-'} ${stripSpaces(s.title).slice(0, 46)}  (p${s.page})`)
  }

  console.log('\n  待核对（前 14 条）：')
  for (const r of reviewOf(model).slice(0, 14)) {
    console.log(`    [${r.level}] p${r.page} ${r.message}${r.text ? `\n           ↳ ${r.text.slice(0, 64)}` : ''}`)
  }

  /* --------------------------- 预习页（批 3） --------------------------- */
  // 这一层不调模型：书名/骨架/术语（带教材原话）/代码清单/图表/待核对/先猜后验
  // 全是确定性抽取。**先猜后验**的答案必须"在书里出现过 ≥2 次"，
  // 否则会把 OCR 认错的词当成标准答案（真实样张上出过 `A=Strzing`）。
  console.log('\n═══ 预习页（确定性抽取，零额度）═══')
  const lesson = buildLesson(model)
  const ls = lesson.stats
  console.log(
    `  教材：${lesson.book || '（没认出来）'}\n` +
      `  骨架 ${ls.sections} · 术语 ${ls.terms} · 代码清单 ${ls.listings} · 图 ${ls.figures} · 表 ${ls.tables}\n` +
      `  先猜后验 ${ls.selfCheck} 道（可信行 ${ls.trustedLines} 行 / 要核对 ${ls.checks} 条）`,
  )
  if (lesson.terms.length) console.log(`  术语：${lesson.terms.map((t) => t.term).join(' / ')}`)
  if (lesson.selfCheck.length) console.log(`  自测答案：${lesson.selfCheck.map((q) => q.answer).join(' / ')}`)
  ok(lesson.book.length >= 4 && !/扫描|高效/.test(lesson.book), `书名认出来了且不是水印（${lesson.book || '空'}）`)
  ok(lesson.terms.length >= 2, `抽出 ≥2 条术语（实际 ${lesson.terms.length}）`)
  const badTerm = lesson.terms.filter((t) => /[，。！？；,.;!?]/.test(t.term) || /\b[A-Za-z]\b/.test(t.term))
  ok(badTerm.length === 0, '术语名里没有半句话/单字母碎屑', badTerm.map((t) => t.term).join('、'))
  // ★ 自测题的答案必须"在书里出现过 ≥2 次"（同一标识符的多数拼法）——
  //   不然答案可能是 OCR 认错的词，学生按错的记
  const lessonText = modelToText(model)
  const singleUse = lesson.selfCheck.filter((q) => (lessonText.match(new RegExp(`\\b${q.answer}\\b`, 'g')) || []).length < 2)
  ok(singleUse.length === 0, '★ 自测题的答案都在书里出现过 ≥2 次（防"拿 OCR 认错的词当答案"）', singleUse.map((q) => q.answer).join('、'))
  ok(
    lesson.selfCheck.every((q) => q.line.includes(q.answer)),
    '每道自测题的答案都能在它那一行里找到（可对照教材原话）',
  )
  ok(/^# /.test(lessonToMarkdown(lesson)), '预习页能导出成 Markdown')

  /* --------------------------- 结构性断言 --------------------------- */
  console.log('\n═══ 断言 ═══')
  ok(stats.reconcile === 0, `★ 对账平：进 ${stats.inputLines} 行 = 落块 ${stats.keptLines} + 剔除 ${stats.droppedLines}`, `差分 ${stats.reconcile}`)
  ok(model.pages.every((p) => p.blocks.length > 0), '每一页都建出了块（没有空页）')
  ok(stats.codeBlocks >= 3, `识别出 ≥3 个代码清单（实际 ${stats.codeBlocks}）`)
  ok(stats.gutterDropped + stats.codeLines > 0, '行号栏按坐标被剥离（不是当文字留着）')
  ok(stats.watermarks > 0 || stats.headers > 0, `版面噪声被剔除（水印 ${stats.watermarks} / 页眉页脚 ${stats.headers}）`)
  ok(stats.tables >= 1, `表被单独成块（实际 ${stats.tables}）`)
  ok(stats.figures >= 1, `图被单独成块（实际 ${stats.figures}）`)
  const allLines = docModelToPages(model).flat()
  ok(
    !allLines.some((l) => l.includes('夸克扫描王') || l.includes('极速扫描')),
    '水印没有一行留在正文里',
  )
  // 行号栏有没有真被剥掉：保留的行里不该再出现「数字 + 空格 + 代码开头」这种形态
  const gutterPrefixed = allLines.filter((l) =>
    /^\s*\d{1,3}\s+(?:resp|pw|import|public|private|protected|int|return|System|if|for|String|@)/.test(l),
  )
  ok(gutterPrefixed.length === 0, '代码行开头不再粘着行号（`18 resp.` → `resp.`）', gutterPrefixed.slice(0, 2).join(' | '))
  ok(canProceed(model).ok === false, '★ 有 high 级待核对项时 canProceed=false（不许静默通过）')

  // 确定性与"别一边剔除一边又留着"
  const again = buildDocModel(JSON.parse(JSON.stringify(docPages)))
  ok(JSON.stringify(again) === JSON.stringify(model), '同一个输入建两次模型完全一致（确定性，可缓存/可比）')
  const droppedText = new Set(model.pages.flatMap((p) => p.dropped.map((d) => stripSpaces(d.text))))
  const both = allLines.filter((l) => droppedText.has(stripSpaces(l)))
  ok(both.length === 0, '被剔除的版面行没有同时又被留下（剔除与保留不重叠）', both.slice(0, 2).join(' | '))

  /* --------------- OCR 质量：拿**人工校对过的源码**当参照 --------------- */
  // `textbook-sources/javaweb-ch03/` 里那 4 份源码是**逐字核对过**的（交接文档「第七批」），
  // 所以它们是仓库里唯一的"真值"。量的是：这些源码里的关键 API 名/标识符，
  // OCR 之后还能不能找到。**这一项量的不是 docmodel，是 OCR 模型** ——
  // 小模型（站点现在发的）与全量模型在这里差别很大，所以要看得见。
  const SRC_DIR = path.join(ROOT, 'quiz', 'tools', 'textbook-sources', 'javaweb-ch03')
  if (fs.existsSync(SRC_DIR)) {
    const identifiers = new Set()
    for (const f of fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.java'))) {
      const src = fs.readFileSync(path.join(SRC_DIR, f), 'utf8')
      for (const m of src.matchAll(/\b(?:[a-z]+\.)*([A-Z][A-Za-z0-9]{3,}|[a-z]+[A-Z][A-Za-z0-9]{2,})\b/g)) {
        if (!/^(Override|String|System|Version|Admin|Inline|Filename)$/.test(m[1])) identifiers.add(m[1])
      }
    }
    const compact = stripSpaces(allLines.join('\n'))
    const keys = [...identifiers]
    const hits = keys.filter((k) => compact.includes(k))
    const rate = hits.length / Math.max(1, keys.length)
    console.log(`\n  OCR 关键串命中（参照人工校对过的源码，${keys.length} 个标识符）：${hits.length} → ${(rate * 100).toFixed(0)}%`)
    const missed = keys.filter((k) => !compact.includes(k))
    if (missed.length) console.log(`    没找到：${missed.slice(0, 14).join('、')}`)
    // 阈值只钉"下游还能用"：代码题本来就要人工核对（界面上也这么写）。
    // 想比模型就把这一项跑两遍：--lang quiz/frontend/public/ocr 与 --lang .tmp/ocr-bench/tessdata
    ok(rate >= 0.45, `OCR 关键串命中率 ≥45%（实际 ${(rate * 100).toFixed(0)}%）`)
  } else {
    console.log('\n  （跳过 OCR 关键串命中：人工校对过的源码目录不在）')
  }

  /* ------------------- 可选：和"改之前的产出"粗对照 ------------------- */
  if (BASELINE && fs.existsSync(BASELINE)) {
    const oldLines = fs
      .readFileSync(BASELINE, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('<!--'))
    const newLines = allLines
    const oldLong = oldLines.filter((l) => normLine(l).length >= 20)
    const newLong = newLines.filter((l) => normLine(l).length >= 20)
    const newSet = new Set(newLong.map(normLine))
    const oldSet = new Set(oldLong.map(normLine))
    const lost = oldLong.filter((l) => !newSet.has(normLine(l)))
    const added = newLong.filter((l) => !oldSet.has(normLine(l)))
    console.log(
      `\n  与旧产出粗对照（${path.relative(ROOT, BASELINE)}，长行 ≥20 字）：` +
        `旧 ${oldLong.length} 行中未命中 ${lost.length}；新 ${newLong.length} 行中新增 ${added.length}`,
    )
    console.log('  ⚠️ 只是参照：语言包/DPI 不同，逐字比对本来就会差很多（所以这里**不做断言**）')
    for (const l of lost.slice(0, 5)) console.log(`    − ${l.slice(0, 76)}`)
    for (const l of added.slice(0, 5)) console.log(`    + ${l.slice(0, 76)}`)
  }

  /* ------------------------------ 落盘 ------------------------------ */
  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true })
  fs.writeFileSync(JSON_OUT, `${JSON.stringify(model, null, 2)}\n`, 'utf8')
  fs.writeFileSync(TEXT_OUT, `${modelToText(model)}\n`, 'utf8')
  const lessonJson = path.join(ROOT, '.tmp', 'lesson.json')
  const lessonMd = path.join(ROOT, '.tmp', 'lesson.md')
  fs.writeFileSync(lessonJson, `${JSON.stringify(lesson, null, 2)}\n`, 'utf8')
  fs.writeFileSync(lessonMd, `${lessonToMarkdown(lesson)}\n`, 'utf8')
  console.log(
    `\n产物：${path.relative(ROOT, JSON_OUT)}（文档模型）、${path.relative(ROOT, TEXT_OUT)}（带页标记的文本）、` +
      `${path.relative(ROOT, lessonJson)}（预习页）、${path.relative(ROOT, lessonMd)}（预习页 Markdown）`,
  )

  console.log('\n' + '═'.repeat(52))
  if (failed) {
    console.log(`❌ 文档模型验收失败：${pass} 通过 / ${failed} 失败`)
    return 1
  }
  console.log(`✅ 文档模型验收通过：${pass} 项断言`)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
