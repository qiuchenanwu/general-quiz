/**
 * text.js —— 题干 / 解析共用的文本渲染小工具
 *
 * 三件事：
 *   ① 题库里的填空占位统一写成 "(  )"（**里面至少一个空格**）。如果直接塞进 {{ }}，
 *      HTML 会把连续空格折叠掉，界面上就变成光秃秃的 "()"，很难看也不好读。
 *      所以这里把它转成一个下划线小横条。
 *   ② 行内 markdown（`代码` / **强调**）—— **题干和解析共用同一份实现**（见 inlineSegs）。
 *   ③ 解析里的网址切成片段，交给模板渲染成 <a>。
 *
 * ⚠️ 空格是**必须的**，不能用 `\s*`："(  )" 和 "()" 看起来一样，但后者在
 * 代码里到处都是 —— `ref()`、`createApp()`、`watch()`。第一版写的就是 `\s*`，
 * 于是代码题题干里那句"`ref()` takes the argument…"被渲染成"ref ___ takes…"，
 * 读起来像一道填空题（2026-10-09 真机截图里发现的）。
 *
 * ⚠️ 一个判据一处实现（坑 58 / 110）：行内标记只认这一份 inlineSegs()。
 *    2026-10-11 的 UX 审计发现"题干里的 ** 会格式化、解析里的 ** 裸显示"，
 *    根因就是解析那条路根本没过这里 —— 所以解析也走 inlineSegs()，不许再写第二份。
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }

/**
 * HTML 转义（**唯一的转义实现**）。
 * 任何要拼进 HTML 的文本，都必须先过这里；先转义、再拼标签。
 */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ESCAPES[c])
}

/**
 * 行内 markdown → 片段数组：`代码` → code，**强调** → strong。
 *
 * 为什么返回片段数组而不是 HTML 字符串：解析文本里混着用户手写和模型生成的内容，
 * 拼 HTML 就等于给它们开门。返回片段、让调用方决定怎么渲染，是这里唯一安全的做法
 * （题干那边由 stemHtml() 拼 HTML，但每个片段都先过了 escapeHtml()）。
 *
 * @returns {Array<{type:'text'|'code'|'strong', text:string}>}
 */
export function inlineSegs(text) {
  const src = String(text ?? '')
  if (!src) return []
  const out = []
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g
  let last = 0
  let m
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ type: 'text', text: src.slice(last, m.index) })
    if (m[1] != null) out.push({ type: 'code', text: m[1] })
    else out.push({ type: 'strong', text: m[2] })
    last = m.index + m[0].length
  }
  if (last < src.length) out.push({ type: 'text', text: src.slice(last) })
  return out
}

/** 片段 → 安全 HTML（片段文本一律先转义） */
function segHtml(seg) {
  const text = escapeHtml(seg.text)
  if (seg.type === 'code') return `<code class="q-code">${text}</code>`
  if (seg.type === 'strong') return `<strong>${text}</strong>`
  return text
}

/**
 * 行内标记 → **纯文本**（`代码` / **强调** / ``` 围栏 都只留文字）。
 *
 * 给"只能显示纯文本"的地方用：
 *   · 题库简介（`.q-bank__desc`）—— 编译脚本里写着 `**代码题**`，直接渲染就把星号亮给用户；
 *   · 诊断页的解析预览（一行 80 字，排不下 markdown）。
 * 判据还是 analysisSegs() 那一份（围栏里的代码保留，去掉围栏标记本身）。
 */
export function plainText(text) {
  const out = []
  for (const s of analysisSegs(text)) {
    if (s.type === 'pre' && out.length) out.push('\n')
    out.push(s.text)
    if (s.type === 'pre') out.push('\n')
  }
  return out.join('').trim()
}

/**
 * 题干 → 安全 HTML（模板里用 v-html 渲染，见 QuestionCard.vue / ReviewView.vue）：
 *   `代码`        → <code>（教材编译出来的题干里到处是反引号，直接显示很难看）
 *   **强调**      → <strong>
 *   "(  )"        → 填空横条 .q-blank
 *   换行          → <br>
 *
 * ⚠️ 顺序是"先转义 → 再拼标签"，所以题干里的 < > & " 不会破坏页面。
 * ⚠️ 填空横条只在**普通文本片段**里认：`` `ref()` `` 这种行内代码里的括号不算空。
 */
export function stemHtml(stem) {
  return inlineSegs(stem)
    .map((seg) =>
      seg.type === 'text'
        ? escapeHtml(seg.text).replace(/[(（]\s+[)）]/g, '<span class="q-blank"></span>')
        : segHtml(seg),
    )
    .join('')
    .replace(/\n/g, '<br />')
}

/** 纯文本截断（列表里用），不产生 HTML */
export function truncate(s, n = 60) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/**
 * 把一段文字按"网址 / 非网址"切成片段，交给模板用 `v-for` 渲染成纯文本 + `<a>`。
 *
 * 为什么要这个：教材编译出来的题库，解析最后一行是
 * `出处：<小标题> <原文网址>`（见 quiz/tools/docs_to_bank.py）—— 那是给人读的，
 * 但用户看着一整条网址点不动很难受。
 *
 * ⚠️ 刻意**不返回 HTML 字符串**、调用处也不许用 `v-html`：
 *   解析文本里混着用户自己写的内容和模型生成的内容，一旦走 innerHTML 就等于开门。
 *   返回片段数组、让 Vue 去转义文本，是这里唯一安全的做法。
 *
 * @returns {Array<{type:'text'|'link', text:string, href?:string}>}
 */
export function splitLinks(text) {
  const src = String(text ?? '')
  if (!src) return []
  const re = /https?:\/\/[^\s<>"'）】]+/g
  const out = []
  let last = 0
  let m
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ type: 'text', text: src.slice(last, m.index) })
    let href = m[0]
    // 网址末尾常被中文标点粘住（"…computed.html#basic-example。"）
    // —— 把尾部标点还回文本，别让它进 href
    const tail = href.match(/[.,;:!?、。，；：！？)）]+$/)
    let suffix = ''
    if (tail) {
      href = href.slice(0, -tail[0].length)
      suffix = tail[0]
    }
    if (href) out.push({ type: 'link', text: href, href })
    if (suffix) out.push({ type: 'text', text: suffix })
    last = m.index + m[0].length
  }
  if (last < src.length) out.push({ type: 'text', text: src.slice(last) })
  return out
}

/**
 * 解析 → 片段数组（块级 ``` 围栏 + 行内标记 + 网址）。
 *
 * 为什么解析也要这一份：521 道代码题里 129 条解析写着 `**强调**`、87 条带 ```js 围栏，
 * 学生看到的却是星号和反引号本身（UX 审计 2026-10-11，块 3-1）。
 *
 * 仍然是"片段数组"，**不走 v-html** —— 解析可能来自用户手写或模型生成。
 * 行内标记交给 inlineSegs()：和题干同一份实现，不会过期。
 *
 * @returns {Array<{type:'text'|'code'|'strong'|'link'|'pre', text:string, href?:string}>}
 */
export function analysisSegs(text) {
  const src = String(text ?? '')
  if (!src) return []
  const out = []
  const fence = /```[^\n]*\n?([\s\S]*?)(?:```|$)/g
  let last = 0
  let m

  /** 普通文本：先切网址，再切行内标记 */
  const pushText = (raw, { trimEnd = false, trimStart = false } = {}) => {
    let t = raw
    if (trimEnd) t = t.replace(/\n+$/, '')
    if (trimStart) t = t.replace(/^\n+/, '')
    if (!t) return
    for (const seg of splitLinks(t)) {
      if (seg.type === 'link') out.push(seg)
      else for (const s of inlineSegs(seg.text)) out.push(s)
    }
  }

  while ((m = fence.exec(src)) !== null) {
    // 围栏前的那段：去掉紧贴围栏的换行，免得在代码块前后多出一个空行
    pushText(src.slice(last, m.index), { trimEnd: true })
    const code = m[1].replace(/\n+$/, '')
    if (code) out.push({ type: 'pre', text: code })
    last = fence.lastIndex
  }
  // 结尾这段：只有紧跟在代码块后面的那段才需要去掉行首换行
  const endsWithPre = out.length > 0 && out[out.length - 1].type === 'pre'
  pushText(src.slice(last), { trimStart: endsWithPre })
  return out
}

/**
 * 把后端抛回来的错误变成**能给学生看**的一句话。
 *
 * 为什么必须过这一道（2026-10-11 UX 审计把原话逐字抄下来了）：
 *   「出题那一步没成功（找不到解析规则模块：
 *     C:\Users\alice\PycharmProjects\shared\quiz-tools\pdf_to_json.py（部署时要用 ），
 *     于是改用**兜底**…」
 * 三处硬伤：① **服务器绝对路径**露给学生（还带着用户名）；
 *          ② `.slice(0, 80)` 把句子**截断在括号里**，留个悬空的"（部署时要用"；
 *          ③ 字面 `**兜底**`（模板不是 markdown，星号会原样显示）。
 * 这条纯函数治 ① 和 ②；③ 由调用方别写星号。
 */
export function readableError(raw, { max = 60 } = {}) {
  let text = String(raw ?? '').trim()
  if (!text) return '原因未知'
  // ① 抹掉绝对路径，只留文件名（Windows 的 C:\a\b.py 和 POSIX 的 /home/x/y.py 都要治）
  text = text
    .replace(/[A-Za-z]:\\[^\s，。；）)]+/g, (m) => m.split(/[\\/]/).filter(Boolean).pop() || '（路径）')
    .replace(
      /\/(?:home|Users|opt|srv|var|tmp)\/[^\s，。；）)]+/g,
      (m) => m.split('/').filter(Boolean).pop() || '（路径）',
    )
  // ② 先按句界收一刀（最自然），再截断时避开括号 —— 别留"（部署时要用"这种悬空括号
  const cut = text.search(/[。；]/)
  if (cut > 0 && cut + 1 <= max) return text.slice(0, cut + 1)
  if (text.length <= max) return text
  return text.slice(0, max).replace(/[（(][^）)]*$/, '').trimEnd() + '…'
}
