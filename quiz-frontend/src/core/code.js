/**
 * code.js —— **代码题的纯逻辑层**（12 个核心模块之外新增的一个，纯函数、无依赖）
 * ============================================================================
 * 为什么要有它：
 *   刷题站原来的所有交互都收敛成「从选项里挑一个」，而教材编译器抽出来的
 *   398 个教学点里有 273 个是**真实代码**（见 quiz/tools/docs_to_bank.py 的
 *   extract_points）。把一段能跑的代码压成"下列说法正确的有哪些"，学到的是词，
 *   不是计算机。代码题把那段代码还给用户：填空、找错、预测输出 —— 而且能真跑。
 *
 * 四种模式（`type: 'code'` 的 `mode` 字段）：
 *   fill      填空：代码里 `___`（3 个及以上下划线）是空，逐空填回原文
 *   spot      找错行：代码被改动过一行，指出是哪一行（判据：行号）
 *   predict   预测输出：给代码 + 选项，先选再跑，让运行结果自己说话
 *   fix       修好它：用户改代码，跑通且输出对上才算过
 *   write     手写：白纸一张，写完跑通对上期望输出
 *   order     拖拽排序（Parsons）：把打乱的语句拖回原来的顺序（判据 = 教材原文的顺序，
 *             不需要真跑；判分在 core/parsons.js，含部分分）
 *
 * 判定**全部是确定性的**（字符串/行号/输出比对），不花一分钱 API：
 *   这是刻意选的 —— 能机判的交互才敢让人随便点、随便错。
 *
 * 沙箱：`buildSandboxDoc()` 产出的 HTML 塞进
 *   <iframe sandbox="allow-scripts" srcdoc="…">
 * 里跑。没有 allow-same-origin，所以那段代码碰不到本站的 localStorage / cookie /
 * DOM；父子之间只靠 postMessage 说话（见 SANDBOX_SOURCE）。
 * 死循环由**父窗口超时后把 iframe 摘掉**来兜底（见 CodeRunner.vue）。
 */
import { SANDBOX_RUNTIME } from './vue-shim.js'
import { judgeParsons } from './parsons.js'

// 运行时那一段是"沙箱里跑什么"的一部分，从 code.js 一起导出：
// 出题工具（quiz/tools/units_to_tasks.mjs）要在 Node 里用**同一份**跑文档片段
export { SANDBOX_RUNTIME }

/** postMessage 的握手标识：收到别的组件的消息一律忽略 */
export const SANDBOX_SOURCE = 'quiz-code-runner'

/** 空心：3 个及以上下划线。刻意用 3 个 —— `__dirname` 这类只有 2 个，不会误伤 */
const BLANK_RE = /_{3,}/g

export const CODE_MODE_LABEL = {
  fill: '填空',
  spot: '找错行',
  predict: '预测输出',
  fix: '修好它',
  write: '手写',
  order: '拖拽排序',
}

/* ------------------------------------------------------------------ 填空 --- */

/**
 * 把代码切成「文本段 / 空」两种片段。
 * @returns {{parts: Array<{type:'text',text:string}|{type:'blank',index:number}>, total:number}}
 */
export function splitCode(code) {
  const text = String(code ?? '')
  const parts = []
  let last = 0
  let index = 0
  BLANK_RE.lastIndex = 0
  let m
  while ((m = BLANK_RE.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: 'text', text: text.slice(last, m.index) })
    parts.push({ type: 'blank', index })
    index += 1
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) })
  return { parts, total: index }
}

/** 这段代码里有几个空 */
export function blankCount(code) {
  return splitCode(code).total
}

/**
 * 一个空的答案文本归一化。
 *
 * 规则刻意保守：**只吃空白差异**，不偷偷接受别的写法 ——
 * 多一个分号、少一个 `const` 都算错（这类差异正是要人记住的东西）。
 * 大小写也默认敏感（`ref` 写成 `Ref` 就是错的）。
 */
export function normalizeBlank(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    // 全角空格 / 不换行空格都当普通空格
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim()
}

/** 单个空的判定。expected 可以是字符串，也可以是「都算对」的数组 */
export function judgeBlank(expected, actual) {
  const want = Array.isArray(expected) ? expected : [expected]
  const got = normalizeBlank(actual)
  if (!got) return false
  return want.some((w) => {
    const target = normalizeBlank(w)
    return target !== '' && target === got
  })
}

/* ---------------------------------------------------------- 找错 / 预测 --- */

/** 数字化的行号：`"3"` / `3` / `"3.0"` 都认，认不出返回 null */
function toLineNo(v) {
  const n = Number(String(v ?? '').trim())
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null
}

/** 预测输出：和选择题同一套判据（答案是无序字母集合） */
function judgeLetters(picked, answer) {
  const a = [...new Set((picked || []).map((x) => String(x)))].sort()
  const b = [...new Set((answer || []).map((x) => String(x)))].sort()
  if (!a.length || !b.length || a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

/* --------------------------------------------------------------- 运行 --- */

/**
 * 运行输出归一化：拆行、去掉行尾空白、丢掉尾部空行。
 * 不比较前导空格是有意的 —— 缩进差异（比如 `console.table` 的对齐）
 * 不该让一道本来做对的题判错。
 */
export function normalizeOutput(text) {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 实际输出对不对得上题目期望（`q.run.expect`）。
 *
 * `expect` 写数组 → 逐行相等；写 `{contains: ["…"]}` → 只要每段都出现在输出里就算过
 * （有些题目只关心"这行打印出来了"，不关心前后还有没有别的东西）。
 */
export function judgeRun(q, outputText) {
  const run = q?.run || {}
  const expect = run.expect
  if (expect === undefined || expect === null) return null // 这道题没写期望值：无从判
  const got = normalizeOutput(outputText)
  const gotAll = Array.isArray(outputText) ? outputText.join('\n') : String(outputText ?? '')

  if (Array.isArray(expect)) {
    const want = normalizeOutput(expect.join('\n'))
    if (want.length !== got.length) return false
    return want.every((line, i) => line === got[i])
  }
  if (typeof expect === 'object' && Array.isArray(expect.contains)) {
    return expect.contains.every((piece) => gotAll.includes(String(piece)))
  }
  return normalizeOutput(String(expect)).join('\n') === got.join('\n')
}

/**
 * 代码题判定 —— store 里所有判定都要走这里（和 isCorrect 并列）。
 *
 * @param {object} q      归一化后的题
 * @param {any[]} picked  用户提交的值：填空=每个空的文本；找错行=行号；预测=选项字母；修好它=运行输出
 * @returns {{ok:boolean, blanks?:boolean[], mode:string}}
 */
export function judgeCode(q, picked) {
  const mode = q?.mode || 'fill'
  const values = Array.isArray(picked) ? picked : picked === undefined || picked === null ? [] : [picked]

  if (mode === 'spot') {
    const want = toLineNo(q?.answer?.[0])
    const got = toLineNo(values[0])
    return { ok: want !== null && got === want, mode }
  }
  if (mode === 'predict') {
    return { ok: judgeLetters(values, q?.answer), mode }
  }
  if (mode === 'fix' || mode === 'write') {
    // 「修好它」和「手写」是同一个判据：**跑出来的输出对不对**。
    // 差别只在题面和起始代码（手写给的是空骨架，修好它给的是改坏了的原文）。
    const ok = judgeRun(q, values[0]) === true
    return { ok, mode }
  }
  if (mode === 'order') {
    // 拖拽排序：答案是**原来的顺序**（判据在 core/parsons.js，含部分分与逐位置对错）。
    // ⚠️ 用整个 `values`，不是 `values[0]` —— 作答形态就是"一串 key"（一个块一个字符串），
    //    和填空"一个空一个字符串"是同一个契约（见 CodeRunner 的 submitValues）。
    const res = judgeParsons(values, q?.answer)
    return { ok: res.ok, mode, order: res }
  }

  // fill（默认）：空数对不上直接判错，但**逐空结果照样返回**，界面要标出哪个空错了
  const specs = Array.isArray(q?.blanks) ? q.blanks : []
  const blanks = specs.map((spec, i) => {
    const expected = spec && typeof spec === 'object' ? spec.answer : spec
    return judgeBlank(expected, values[i])
  })
  const filled = specs.length > 0 ? values.slice(0, specs.length) : values
  const ok = blanks.length > 0 && blanks.every(Boolean) && filled.length === blanks.length
  return { ok, blanks, mode }
}

/* ------------------------------------------------------------- 可运行性 --- */

const NOT_RUNNABLE = [
  { re: /^\s*(import|export)\b/m, why: '这段用了 import/export（ES 模块），沙箱里按普通脚本执行，跑不了' },
  { re: /\brequire\s*\(/, why: '这段用了 require()，浏览器里没有这个函数' },
  { re: /\bfrom\s+['"][^'"]+['"]/, why: '这段引用了外部模块，沙箱里拿不到' },
  { re: /\bdocument\b|\bwindow\b/, why: '这段会碰 DOM（document/window），沙箱里没有页面可操作' },
  { re: /\bfetch\s*\(/, why: '这段要联网（fetch），沙箱不放行' },
]

/**
 * 单文件组件 / vue-html 为什么跑不了 —— **理由要分开说**。
 *
 * ⚠️ 以前这里只有一句"浏览器里没有编译器"，对**裸片段**来说是**假话**：
 *    库里 203 个 vue-html 代码块里有 134 个是片段（`<button @click="...">` 这种），
 *    它们压根没有配套的状态，**就算装了编译器也跑不起来**。
 *    学生看到"没有编译器"会以为是本站能力不行，而不是"这段本来就该配合正文读"。
 *
 * 真实分布（2026-10-09 量的）：完整 SFC 55 / 只有模板 13 / 裸片段 134。
 * Vue 官方文档能让前两类跑起来，是因为它把 `@vue/compiler-sfc`
 * 和真 Vue 运行时都拉进了浏览器（见 @vue/repl 的 vueCompilerUrl）—— 那是另一条路，代价不小。
 */
export function sfcBlockReason(code) {
  const hasScript = /<script[\s>]/i.test(code)
  const hasTemplate = /<template[\s>]/i.test(code)
  const hasStyle = /<style[\s>]/i.test(code)
  if (!hasScript && !hasTemplate && !hasStyle) return ''
  if (hasScript && hasTemplate) {
    return '这是完整的 Vue 单文件组件：浏览器沙箱里没有 SFC 编译器，跑不了（Vue 官方文档能跑，是因为它另外把编译器装进了浏览器）。填空／找错照样能做'
  }
  if (hasTemplate) {
    return '这段只有模板、没有配套的 <script>（状态定义在别的代码块里），单独跑不起来。填空／找错照样能做'
  }
  return '这是单文件组件里的一段（script/style），单独跑不起来。填空／找错照样能做'
}

/**
 * Java 的"跑不了"是另一套判据 —— 它走的不是浏览器沙箱，是**后端真 JVM**
 * （见 core/java.js 与 quiz/tools/java_sandbox.py）。
 *
 * 报的是**能力边界**，不是权限：JSP 要容器、JDBC 要真数据库，
 * 这两样板子上都没有（别让用户按了「运行」才发现）。
 */
const JAVA_NOT_RUNNABLE = [
  { re: /<%\s*[@=]?|%>/, why: '这是 JSP：它要 servlet 容器先翻译成 Java 再编译，沙箱里没有容器（Servlet / 纯 Java 片段能跑）' },
  { re: /\bDriverManager\b|\bjdbc:/i, why: '这段要连真数据库（JDBC）：板子上没有数据库也没有 JDBC 驱动，跑不了（能出填空／找错这类静态题）' },
  { re: /^\s*(package|import\s+static)\b/m, why: '这段带 package 声明或静态导入，沙箱按单文件编译，跑不了' },
]

/**
 * 这段代码能不能在沙箱里跑？能跑返回 ''，不能跑返回**给人看的理由**。
 *
 * 宁可明确说"跑不了"，也不要让用户点了运行只看到一个莫名其妙的报错 ——
 * 这是这个项目一贯的取舍（见 HANDOVER 里"起不来的不要留在列表里"那条）。
 */
export function runBlockReason(q) {
  const code = String(q?.code ?? '')
  if (q?.type !== 'code') return '这不是代码题'
  // 拖拽排序不需要运行：判据是**教材原文的顺序**，跑一遍也证明不了顺序对不对
  if (q?.mode === 'order') return '排序题不用运行（把每一块拖回原来的位置就是答案）'
  if (!code.trim() && q?.mode !== 'write') return '这道题没有代码'
  const lang = String(q?.lang ?? 'js').toLowerCase()

  // Java 走**后端真跑**，判据和浏览器沙箱完全不同（别拿 JS 的尺子量它）
  if (lang === 'java' || lang === 'jsp') {
    for (const rule of JAVA_NOT_RUNNABLE) {
      if (rule.re.test(code)) return rule.why
    }
    if (!blankCount(code) && q?.mode === 'fill') return '这道填空题没有空'
    return ''
  }

  // 先看结构（SFC / ESM / DOM 这些理由比"语言不对"更有用），再看语言
  const sfc = sfcBlockReason(code)
  if (sfc) return sfc
  for (const rule of NOT_RUNNABLE) {
    if (rule.re.test(code)) return rule.why
  }
  // vue-html / html：走到这里说明**连 script/template/style 标签都没有**，
  // 也就是文档里的"裸片段"（`<button @click="n++">` 这种）—— 它没有配套状态。
  // ⚠️ 别说成"没有编译器"（那是假话），也别说成"语言不对"（等于没说清为什么）。
  if (['vue-html', 'html', 'vue', 'template'].includes(lang)) {
    return '这是文档里的一个片段（模板／标记）：没有配套的状态（状态定义在别的代码块里），单独跑不起来。填空／找错照样能做'
  }
  if (!['js', 'javascript', 'mjs', 'node'].includes(lang)) {
    return `这段是 ${lang}（不是纯 JS），沙箱只跑 JavaScript`
  }
  if (!blankCount(code) && q?.mode === 'fill') return '这道填空题没有空'
  return ''
}

export function isRunnable(q) {
  return runBlockReason(q) === ''
}

/* --------------------------------------------------------------- 沙箱 --- */

/** 拼进 srcdoc 的字符串字面量：必须把 `</script>` 打散，否则脚本会被提前截断 */
function scriptSafeLiteral(value) {
  return JSON.stringify(String(value ?? '')).replace(/<\//g, '<\\/')
}

/**
 * 造一份跑代码用的最小 HTML。
 *
 * 它做的事只有三件：把 console 的输出、抛出的异常、跑完这件事本身
 * postMessage 给父窗口 —— 至于超时、展示、判定都在父窗口（CodeRunner.vue）。
 *
 * 里面会先装**迷你 Vue**（core/vue-shim.js）：官方文档的示例都是
 * `const count = ref(0)` 这种片段，不装它就只能跑纯 JS，等于把教材里
 * 最有价值的那一半（响应式）全挡在门外。装的是小实现，不是 Vue 本体 ——
 * 这件事必须在界面上说清楚（CodeRunner 有提示）。
 *
 * @param {{code:string}} o
 * @returns {string} 塞进 iframe srcdoc 的 HTML
 */
export function buildSandboxDoc({ code }) {
  const literal = scriptSafeLiteral(code)
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>runner</title></head>
<body>
<script>
(function () {
  var SOURCE = ${scriptSafeLiteral(SANDBOX_SOURCE)};
  function send(kind, payload) {
    try { parent.postMessage({ source: SOURCE, kind: kind, payload: payload }, '*'); } catch (e) {}
  }
${SANDBOX_RUNTIME}
  __captureConsole(send);
  window.onerror = function (msg) { send('error', String(msg)); };
  window.addEventListener('unhandledrejection', function (e) {
    send('error', 'Uncaught (in promise) ' + String((e && e.reason && e.reason.message) || (e && e.reason) || ''));
  });
  send('ready', null);
  try {
    // 用户代码包一层函数执行：顶层 return / 重名变量都不会污染沙箱自己的变量
    new Function(${scriptSafeLiteral('"use strict";\n')} + ${literal})();
    send('done', null);
  } catch (err) {
    send('error', String((err && err.name ? err.name + ': ' : '') + ((err && err.message) || err)));
    send('done', null);
  }
})();
<\/script>
</body></html>`
}

/**
 * 读一条来自沙箱的消息。不是我们的消息返回 null（页面上还有别的 postMessage 在用）。
 * @returns {{kind:string, payload:any}|null}
 */
export function readSandboxMessage(data) {
  if (!data || typeof data !== 'object') return null
  if (data.source !== SANDBOX_SOURCE) return null
  const kind = String(data.kind || '')
  if (!kind) return null
  return { kind, payload: data.payload }
}

/**
 * 把沙箱消息攒成「运行结果」。
 *
 * @param {Array<{kind:string,payload:any}>} messages
 * @param {{timedOut?:boolean}} o
 * @returns {{ok:boolean, lines:Array<{kind:string,text:string}>, output:string, error:string, timedOut:boolean}}
 */
export function collectRun(messages, { timedOut = false } = {}) {
  const lines = []
  let error = ''
  for (const msg of messages || []) {
    if (!msg) continue
    if (msg.kind === 'stdout' || msg.kind === 'warn' || msg.kind === 'stderr') {
      lines.push({ kind: msg.kind, text: String(msg.payload ?? '') })
    } else if (msg.kind === 'error') {
      error = String(msg.payload ?? '')
      lines.push({ kind: 'error', text: error })
    }
  }
  if (timedOut) {
    error = '运行超时（代码里可能有死循环）。已经把它掐掉了，改完再跑。'
    lines.push({ kind: 'error', text: error })
  }
  return {
    ok: !timedOut && !error,
    lines,
    output: lines
      .filter((l) => l.kind !== 'warn' && l.kind !== 'stderr' && l.kind !== 'error')
      .map((l) => l.text)
      .join('\n'),
    error,
    timedOut,
  }
}
