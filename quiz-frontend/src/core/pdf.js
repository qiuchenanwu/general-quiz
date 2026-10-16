/**
 * pdf.js 抽文字 —— 在**浏览器里**把 PDF 变成「一页一行」的文字。
 *
 * 为什么在浏览器抽、而不是传到后端让 Python 抽：
 *   Q8B 板子是 aarch64，那个 venv 是 uv 管的（连 pip 都没有），
 *   多装一个 PyMuPDF 就多一次「板子上装不上」的风险。
 *   而 pdf.js 本来就是浏览器里的东西，装在**前端**，板子一个包都不用加。
 *   顺带好处：大 PDF 不用整份上传，传的是抽好的文字（小一个数量级）。
 *
 * 抽出来的结构是 [[第1页的行...], [第2页的行...]]，和后端规则解析器
 * （quiz/tools/pdf_to_json.py 的 lines_from_pages）约好的格式一致 ——
 * 所以「去页眉页脚」「跨页断行接续」这些规则还是那一份 Python 实现，没有分叉。
 */

// 故意**不用**顶层 import：pdf.js 有 ~500KB（worker 还有 1.2MB），
// 而只有真的拖了 PDF 才需要它。顶层 import 会让首页白白多下 155KB(gzip)。
// 改成动态 import，Vite 会把它切成独立 chunk，按需加载。
let pdfjsReady = null

function loadPdfjs() {
  if (!pdfjsReady) {
    pdfjsReady = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]).then(([lib, worker]) => {
      // Vite 会把 worker 作为独立文件产出并给出相对 URL；base './' 下也能正确解析
      lib.GlobalWorkerOptions.workerSrc = worker.default
      return lib
    })
  }
  return pdfjsReady
}

/** 中日韩文字与全角标点：这些字符之间不该插空格 */
function isCjk(ch) {
  const code = ch.codePointAt(0)
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // 汉字
    (code >= 0x3000 && code <= 0x303f) || // 、。《》「」
    (code >= 0xff00 && code <= 0xffef) || // 全角 ，：；（）？！
    (code >= 0x2000 && code <= 0x206f) // 通用标点
  )
}

/**
 * 拼接同一行里的相邻文字块。
 * 中文之间直接接上；只要有一边不是中文就补一个空格 ——
 * 不然后面万一有英文题，单词会被粘成一坨。
 */
function joinRun(left, right) {
  if (!left) return right
  if (!right) return left
  return isCjk(left[left.length - 1]) && isCjk(right[0]) ? left + right : `${left} ${right}`
}

/**
 * 把 pdf.js 的 text items 还原成「一行行文字」。
 *
 * pdf.js 给的是一个个带坐标的文字块，不是行。这里按 y 坐标分组：
 * 差 2 个单位以内算同一行（同一行的不同字号基线会差一点点），
 * 行内按 x 从左到右排。
 */
export function linesFromItems(items) {
  const rows = []
  for (const item of items) {
    if (typeof item.str !== 'string' || item.str === '') continue
    const x = item.transform[4]
    const y = item.transform[5]
    let row = null
    for (const candidate of rows) {
      if (Math.abs(candidate.y - y) <= 2) {
        row = candidate
        break
      }
    }
    if (!row) {
      row = { y, parts: [] }
      rows.push(row)
    }
    row.parts.push({ x, s: item.str })
  }
  // PDF 的 y 轴向上，所以 y 大的在上面
  rows.sort((a, b) => b.y - a.y)
  return rows
    .map((row) =>
      row.parts
        .sort((a, b) => a.x - b.x)
        .reduce((acc, part) => joinRun(acc, part.s), '')
        .trim(),
    )
    .filter(Boolean)
}

/**
 * 打开 PDF 准备**渲染成图**（扫描件 OCR 用）。
 *
 * 为什么需要它：上面那条路是 `getTextContent()` —— 只对**有文字层**的电子版有用。
 * 扫描件的文字层是空的，唯一的办法是**把页面渲染成位图**再交给 OCR。
 *
 * ⚠️ 一次只渲一页、用完就丢：一张 300 DPI 的 A4 是 2480×3508 ≈ 8.7M 像素
 *   ≈ 35MB 内存，9 页一起渲就是 300MB+，浏览器会直接崩。
 *   所以这里只提供 `renderPage(i)`，循环和释放交给调用方。
 */
export async function openPdfForOcr(file) {
  const pdfjsLib = await loadPdfjs()
  const buffer = await file.arrayBuffer()
  const loadingTask = pdfjsLib.getDocument({ data: buffer, isEvalSupported: false })
  const doc = await loadingTask.promise

  return {
    numPages: doc.numPages,
    /** 把第 number 页（1 起）渲成 canvas。用完请把它置空，让 GC 收走。 */
    async renderPage(number, dpi = 200) {
      const page = await doc.getPage(number)
      const viewport = page.getViewport({ scale: dpi / 72 })
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      await page.render({ canvasContext: ctx, viewport }).promise
      page.cleanup()
      return canvas
    },
    async close() {
      try {
        if (typeof loadingTask.destroy === 'function') await loadingTask.destroy()
        else if (typeof doc.destroy === 'function') await doc.destroy()
      } catch {
        /* worker 随页面回收 */
      }
    },
  }
}

/**
 * 抽一份 PDF。
 * @param {File} file
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<{pages:string[][], numPages:number, emptyPages:number}>}
 */
export async function extractPdfPages(file, onProgress) {
  const pdfjsLib = await loadPdfjs()
  const buffer = await file.arrayBuffer()
  // 注意：要拿住 loadingTask，销毁用它的 destroy()。
  // pdf.js 6.x 的 PDFDocumentProxy 上**没有** destroy()（5.x 有过），
  // 直接 doc.destroy() 会报「o.destroy is not a function」——
  // 实测踩到，而且它抛在 finally 里，看起来像「导入失败」。
  const loadingTask = pdfjsLib.getDocument({
    data: buffer,
    // 抽文字不需要求值字体里的 JS；关掉更安全
    isEvalSupported: false,
  })
  const doc = await loadingTask.promise

  const numPages = doc.numPages
  const pages = []
  let emptyPages = 0
  try {
    for (let index = 1; index <= numPages; index++) {
      const page = await doc.getPage(index)
      const content = await page.getTextContent()
      const lines = linesFromItems(content.items)
      if (!lines.length) emptyPages += 1
      pages.push(lines)
      page.cleanup()
      onProgress?.(index, numPages)
    }
  } finally {
    // 销毁失败不该把「已经抽到的文字」判成失败，所以这里吞掉异常
    try {
      if (typeof loadingTask.destroy === 'function') await loadingTask.destroy()
      else if (typeof doc.destroy === 'function') await doc.destroy()
    } catch {
      /* 忽略：worker 随页面回收 */
    }
  }

  // 注意：numPages 要在 destroy() 之前读出来，销毁后再读可能拿不到
  return { pages, numPages, emptyPages }
}
