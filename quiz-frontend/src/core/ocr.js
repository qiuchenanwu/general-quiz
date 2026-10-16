/**
 * ocr.js —— **浏览器里**的 OCR（扫描件 → 文字）
 * ============================================================================
 * 为什么放在浏览器里，而不是板子上：
 *   和 `core/pdf.js` 当初的选择同一条理由 —— 板子是 aarch64、venv 是 uv 管的，
 *   多装一个 onnxruntime+opencv 就多一次"板子上装不上"的风险；
 *   而 OCR 是**用户机器**能干的事。放浏览器：服务器零成本、板子一个包都不用加，
 *   而且**图片根本不用上传**（一本 200 页的书上百 MB，传上去纯属浪费）。
 *
 * 为什么是 tesseract.js：
 *   浏览器里能跑的 OCR 里它最成熟，而且**模型可以完全自托管**（见下面 langPath），
 *   不依赖第三方 CDN —— 板子那条网络有 DNS 劫持的历史，公网 CDN 不可靠。
 *
 * ★ 模型选型（2026-10-10 **重新量过**，推翻了这个文件里原来那条结论）：
 *   原来写着「`4.0.0_best_int`(4.5MB) 和 `4.0.0`(31MB) 输出完全一致 → 发小的」，
 *   那是**共用语言缓存**造成的假测量（详见 HANDOVER 坑 77：tesseract.js 的缓存
 *   只按语言名存，小模型那次直接命中了全量模型的缓存）。分开缓存重测四种组合：
 *
 *     | chi_sim | eng     | 关键串命中 | 先猜后验能出几道 |
 *     |---------|---------|-----------|------------------|
 *     | best_int| best_int| 91%       | 1                |
 *     | best_int| 4.0.0   | 91%       | 1                |
 *     | 4.0.0   | best_int| **100%**  | **12**           |
 *     | 4.0.0   | 4.0.0   | 100%      | 12               |
 *
 *   → **瓶颈是中文模型**（这份教材是中文正文 + 拉丁代码，eng 那份换不换毫无差别），
 *     所以现在发的是 **chi_sim 4.0.0（19MB）+ eng best_int（2.9MB）**：
 *     质量按实测拉满，又不白搭 7.6MB。
 *   ⚠️ 这个结论只在这份**中文教材**上量过；要是以后有全英文材料，eng 那份也要重新量。
 *
 * ★ 实测质量（同一批 9 页，和 PC 上的 rapidocr 对照，判据是"代码还能不能编译"）：
 *     rapidocr：23/24 个关键串（丢了 `IOException`），找出 3 个 Java 清单
 *     tesseract.js：**24/24 全对**，同样 3 个 Java 清单
 *   —— 对**代码/英文**反而更准。两边"编译通过 0/3"也一样，因为卡点是**人工校对那一行**，
 *   不是 OCR。所以界面上不要吹"能自动出题"，要说清"能读出来，代码仍需核对"。
 *
 * ⚠️ 已知形态（实测）：tesseract 会把**中文逐字用空格隔开**（`在 表 3-13 中`），
 *   所以洗完再往下走（`cleanOcrText`）。这一点会让"教材清单标题"这类正则失配
 *   （`文 件 3-14`）—— 下游的正则必须容忍空格。
 *
 * ⚠️ 控制台会出现两条 **tesseract 自己的警告**，不是我们的 bug、也不影响结果：
 *     `Parameter not found: language_model_ngram_on`
 *     `Parameter not found: segsearch_max_char_wh_ratio`
 *   因为 `best_int`（精简/整数化）模型里没有这几个参数。**验收脚本要放行这两条**，
 *   否则每次都会假报红（我第一次就被它绊了一下）。
 */

/**
 * ★★ 语言缓存的**版本号**（浏览器端）。这不是装饰，是"换模型真的生效"的唯一开关。
 *
 * tesseract.js 的缓存键是 `` `${cachePath || '.'}/${lang}.traineddata` `` ——
 * **只认语言名，不认模型文件**（`worker-script/browser/cache.js` 就是 idb-keyval 的
 * get/set）。所以：
 *   · 只改 `langPath` 或只换 `public/ocr/` 里的文件 → 老用户（包括站主自己，
 *     他早就导入过扫描件了）**会一直用着缓存里的旧模型**，换模型变成静默假动作；
 *   · 想让新模型生效，就必须**让缓存键变掉** → 每次换模型把这个版本号 +1。
 * 旧的那些条目会留在 IndexedDB 里（约 5MB），可以不管 —— 也可以让用户在浏览器里
 * 清站点数据；不值得为它写迁移代码。
 */
const OCR_CACHE_VERSION = 'quiz-ocr-2026-10-full-chi'

let workerPromise = null
/** tesseract 的进度回调是建 worker 时挂的；用一个可替换的 sink 让它跟着调用走 */
let progressSink = null

/**
 * 懒建 worker（第一次用才会下载模型、起 WASM）。
 * 建一次就复用 —— 一页一页重开会把模型加载时间乘上页数。
 */
async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js') // 懒加载：不进主包
      // ★ 三个路径**全都要显式覆盖** —— tesseract.js 的默认值是
      //   `https://cdn.jsdelivr.net/npm/...`（worker 脚本、wasm 内核都是）。
      //   在国内 jsdelivr 经常不通，而且这仓库的既定取舍是"不依赖第三方 CDN"
      //   （板子那条网络有 DNS 劫持史）。所以 worker / core / 语言模型**全部自托管**，
      //   一共约 11MB，只在**真的导入扫描件时**才下载（懒加载 + 浏览器缓存）。
      //
      // 用 document.baseURI 而不是写死路径 —— 站点挂在 /quiz/ 下，写死会 404
      const base = new URL('ocr/', document.baseURI).href.replace(/\/$/, '')
      return createWorker(['chi_sim', 'eng'], 1, {
        workerPath: `${base}/worker.min.js`,
        // corePath 指到**具体文件**（以 .js 结尾）时它就不按 SIMD 探测挑变体了，
        // 这样只需自托管一份内核。选 simd-lstm：SIMD 现在几乎所有浏览器都有
        // （本仓库本来就"只测了 Chrome"）。
        corePath: `${base}/tesseract-core-simd-lstm.wasm.js`,
        langPath: base,
        // ★ 缓存键 = `${cachePath}/${lang}.traineddata` —— **不带版本号就会出现
        //   "换了 public/ocr 里的模型，老用户还在用旧的"这种静默假动作（见上面的常量）
        cachePath: OCR_CACHE_VERSION,
        gzip: true,
        logger: (m) => progressSink?.(m),
      })
    })().catch((err) => {
      workerPromise = null // 失败别把坏 promise 缓存住，下次还能重试
      throw err
    })
  }
  return workerPromise
}

/** 现在能不能用（用来决定界面上要不要显示"OCR 识别"这条路） */
export function ocrSupported() {
  try {
    return typeof document !== 'undefined' && typeof Worker !== 'undefined'
  } catch {
    return false
  }
}

/**
 * 认一张图（canvas / Blob / File / ImageData 都行）。
 *
 * `geometry`（可选）= `{ page, width, height }`：给了就**额外**返回 `docPage` ——
 * 带 bbox 和逐词置信度的版面结构，喂给 `core/docmodel.js` 建文档模型。
 *
 * ★ 为什么要多要这一份（2026-10-10）：原来只取 `data.text`，于是**版面信息全丢了**：
 *   · 教材代码左边那列行号（OCR 会把 `18` 和代码行并成一行）分不出来
 *   · 页眉页脚只能靠正则猜，不能靠"它在页面顶部/底部"这个事实
 *   · 低置信度的字认不出来 —— 而"哪一行要人看"恰恰是校对台唯一要说清的事
 *   拿到 bbox 之后这三件事都变成确定性的（见 docmodel.js）。
 *
 * ⚠️ 保持向后兼容：不传 `geometry` 时**返回值和以前完全一样**（只有 text/lines/confidence）。
 * @returns {Promise<{text:string, lines:string[], confidence:number, docPage?:object}>}
 */
export async function ocrImage(source, { onProgress, geometry = null } = {}) {
  const worker = await getWorker()
  progressSink = (m) => {
    if (onProgress && m && typeof m.progress === 'number') {
      onProgress(m.status || '', m.progress)
    }
  }
  try {
    // ★ 第三个参数是 tesseract 的 output 选项。只要 text 时它就不解析 blocks
    //   （省时间），要版面就必须显式点名 —— 实测：只传 text 时 data.blocks 是 undefined。
    const output = geometry ? { text: true, blocks: true } : { text: true }
    const { data } = await worker.recognize(source, {}, output)
    const text = String(data?.text || '')
    const out = {
      text,
      lines: cleanOcrText(text).split('\n').filter((l) => l.trim()),
      confidence: Number(data?.confidence || 0),
    }
    if (geometry) out.docPage = pageFromTesseract(data, geometry)
    return out
  } finally {
    progressSink = null
  }
}

/**
 * tesseract 的 `data.blocks → paragraphs → lines → words` 摊成**一页一个扁平数组**。
 *
 * 为什么要摊平：下游（docmodel.js）只关心"行"和"词"，不需要段落树；
 * 而层级越深，写断言时越容易漏（实测 `blocks[].paragraphs` 在某些页是空数组）。
 *
 * 行文本**由词拼出来**（不直接用 `line.text`）：因为行号栏混在行首时，
 * 只有拿到词的 x 坐标才切得干净。拼法与 `core/pdf.js` 的 `joinRun` 同一条规则 ——
 * 中日韩之间不插空格，其余情况插一个。
 *
 * ★ 导出它是为了**只有一份实现**：离线验收工具 `quiz/tools/docmodel_check.mjs`
 *   在 Node 里跑同一段代码（它拿真实样张跑 tesseract，然后喂给同一个 docmodel）。
 *   要是工具里另写一份，就会重演坑 58（两处判据，迟早有一处过期）。
 */
export function pageFromTesseract(data, { page = 1, width = 0, height = 0 } = {}) {
  const rawLines = []
  const pushLine = (line) => {
    const words = (line.words || []).map((w) => ({
      text: String(w.text ?? ''),
      confidence: Number(w.confidence ?? 0),
      bbox: normBbox(w.bbox),
    })).filter((w) => w.text.trim() !== '')
    if (!words.length) return
    words.sort((a, b) => a.bbox.x0 - b.bbox.x0)
    rawLines.push({
      text: words.reduce((acc, w) => joinWord(acc, w.text), ''),
      confidence: Number(line.confidence ?? Math.min(...words.map((w) => w.confidence))),
      bbox: normBbox(line.bbox) || bboxOfWords(words),
      words,
    })
  }

  const blocks = Array.isArray(data?.blocks) ? data.blocks : null
  if (blocks) {
    for (const block of blocks) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) pushLine(line)
      }
    }
  } else if (Array.isArray(data?.lines)) {
    for (const line of data.lines) pushLine(line)
  }
  if (!rawLines.length) return { page, width, height, lines: [] }

  // 按 y 再排一次：block 顺序不保证是阅读顺序（实测多栏/图片框会插在中间）
  rawLines.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)
  // 页面尺寸兜底：调用方没给就从词框推（宁可略小，也别是 0 —— 所有比例判据都除以它）
  const maxX = Math.max(...rawLines.map((l) => l.bbox.x1), 0)
  const maxY = Math.max(...rawLines.map((l) => l.bbox.y1), 0)
  return {
    page,
    width: width || maxX,
    height: height || maxY,
    lines: rawLines.map((l) => ({ ...l, text: cleanOcrText(l.text) })),
  }
}

function normBbox(bbox) {
  if (!bbox) return null
  const { x0, y0, x1, y1 } = bbox
  if ([x0, y0, x1, y1].some((v) => typeof v !== 'number')) return null
  return { x0, y0, x1, y1 }
}

function bboxOfWords(words) {
  return {
    x0: Math.min(...words.map((w) => w.bbox.x0)),
    y0: Math.min(...words.map((w) => w.bbox.y0)),
    x1: Math.max(...words.map((w) => w.bbox.x1)),
    y1: Math.max(...words.map((w) => w.bbox.y1)),
  }
}

function joinWord(left, right) {
  if (!left) return right
  if (!right) return left
  return isCjk(left[left.length - 1]) && isCjk(right[0]) ? left + right : `${left} ${right}`
}

/** 中日韩文字与全角标点：这些字符之间不该插空格（和 core/pdf.js 同一套） */
export function isCjk(ch) {
  if (!ch) return false
  const code = ch.codePointAt(0)
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x2000 && code <= 0x206f)
  )
}

/**
 * 把 OCR 出来的文字洗一遍。**和 PC 那套（quiz/tools/scan_to_text.py 的 clean_line）同一套规则**，
 * 这样"浏览器读出来的"和"PC 读出来的"能进同一条下游管线。
 *
 * 两条规则：
 *   ① CJK 之间被塞的空格去掉（`在 表 3-13 中` → `在表3-13中`）
 *   ② 代码行里的全角标点收紧（`（）；：，` → `();:,`）—— 只在"像代码"的行上做
 */
export function cleanOcrText(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => {
      let t = line
      if (looksLikeCode(t)) {
        t = t
          .replace(/（/g, '(')
          .replace(/）/g, ')')
          .replace(/；/g, ';')
          .replace(/：/g, ':')
          .replace(/，/g, ',')
          .replace(/＝/g, '=')
      }
      // CJK 之间的空格；以及 CJK 与数字之间的空格
      t = t
        .replace(/(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '')
        .replace(/(?<=[\u4e00-\u9fff])\s+(?=\d)/g, '')
        .replace(/(?<=\d)\s+(?=[\u4e00-\u9fff])/g, '')
      return t.replace(/\s+$/, '')
    })
    .join('\n')
}

/**
 * ★ 这一份是**全仓库唯一**的"这行像不像代码"判据：`cleanOcrText` 用它决定要不要收紧
 * 全角标点，`core/docmodel.js` 用它决定要不要开一个代码块。**别再写第二份** ——
 * 坑 58 已经用两次真事故证明了"同一判据两处实现，迟早有一处过期"。
 *
 * 2026-10-10 扩充：原来只有 17 个提示串，对**代码块识别**不够用（教材里的
 * `int count = 0;` / `println(...)` / `setHeader(` 都判不出来 → 整段代码被当散文）。
 * 现在把 PC 那套 `scan_to_text.py` 的清单并过来。
 * ⚠️ 代价要知道：判据变宽，会有更多行被"收紧全角标点"。所以每个提示串都要求
 * **带分隔**（`int ` / `String ` 而不是裸的 `int`），否则正文里的 "point "、"print "
 * 这种词会中招。
 */
const CODE_HINTS = [
  'import ', 'public ', 'private ', 'protected ', 'class ', 'void ', 'resp.', 'req.',
  'System.', 'return ', 'new ', 'String ', 'if (', 'for (', ');', '@Override', '@WebServlet',
  // 2026-10-10 并入：教材里真实出现、但原来判不出来的
  'int ', 'println', 'getWriter', 'getOutputStream', 'setHeader', 'addHeader', 'setContentType',
  '@WebFilter', 'extends HttpServlet', 'ServletContext', 'throws ',
]

/** 这行像代码吗（决定要不要收紧全角标点 / 要不要开代码块）—— 全仓库唯一判据 */
export function looksLikeCode(text) {
  const t = String(text ?? '').trim()
  if (!t) return false
  if (CODE_HINTS.some((h) => t.includes(h))) return true
  return t.endsWith(';') || t.endsWith('{') || t.endsWith('}')
}

/**
 * 扫描件整本 → 文字（**一页一页来**，内存才不会炸）。
 *
 * @param {object} doc `openPdfForOcr()` 返回的句柄
 * @param {(done:number,total:number,stage:string)=>void} [onProgress]
 * @param {() => boolean} [isCancelled] 用户点了取消就提前退出
 * @param {boolean} [geometry] 额外返回 `docPages`（带 bbox 的版面结构，见 docmodel.js）
 * @returns {Promise<{pages:string[][], emptyPages:number, docPages?:object[]}>}
 */
export async function ocrPdfPages(doc, { dpi = 200, onProgress, isCancelled, geometry = false } = {}) {
  const pages = []
  const docPages = []
  let emptyPages = 0
  for (let n = 1; n <= doc.numPages; n++) {
    if (isCancelled?.()) break
    onProgress?.(n - 1, doc.numPages, `正在渲染第 ${n}/${doc.numPages} 页…`)
    let canvas = await doc.renderPage(n, dpi)
    try {
      onProgress?.(n - 1, doc.numPages, `正在识别第 ${n}/${doc.numPages} 页…`)
      const { lines, docPage } = await ocrImage(canvas, {
        // ★ 画布尺寸就是这一页的坐标系原点（bbox 是像素）—— 必须在这里给，
        //    OCR 结果自己不带页面宽高，而 docmodel 的所有比例判据（页眉/行号栏）
        //    都除以它。给了错的尺寸，整套版面判据都是错的。
        geometry: geometry ? { page: n, width: canvas.width, height: canvas.height } : null,
        onProgress: (stage, p) => {
          if (stage === 'recognizing text') {
            onProgress?.(n - 1 + p, doc.numPages, `正在识别第 ${n}/${doc.numPages} 页…`)
          }
        },
      })
      if (!lines.length) emptyPages += 1
      pages.push(lines)
      if (geometry) docPages.push(docPage)
    } finally {
      // 显式丢引用：一张画布几十 MB，等 GC 太被动
      canvas.width = 0
      canvas.height = 0
      canvas = null
    }
  }
  onProgress?.(doc.numPages, doc.numPages, '识别完成')
  return geometry ? { pages, emptyPages, docPages } : { pages, emptyPages }
}

// ⚠️ 这里曾经有一个 `ocrImageFile()`（图片文件 → 文字），2026-10-09 删掉了：
//    站点**只收 .pdf 和 .json**（站主的策略：「我只允许 PDF/JSON，其他的不安全」）。
//    扫描件仍然支持 —— 扫描出来就是 PDF，走 `ocrPdfPages()` 那条路。

