/**
 * core/snippet.js —— 「随手跑一段代码」的**纯逻辑**
 * ============================================================================
 * 站主原话：「提权后我需要可以运行代码」「扫描件出结果复核的时候更能学到东西，
 * 那简直就是活的代码排错」。
 *
 * 这个文件只做一件事：**判断这段代码能不能跑、要跑的话该把什么交给执行器**。
 * 真正执行的（iframe 沙箱 / 后端 JVM）在 components/SnippetRunner.vue。
 *
 * 为什么中间要夹一层"补壳"：
 *   第二十批量过一件硬事实 —— 教材扫描件里的 Java 代码**自动出不了"真跑"题**：
 *   3 块编译不过、2 块没有类壳（就是几行语句）、2 块是 JSP 页。
 *   所以"把片段塞进 main 方法里"不是锦上添花，它是这类代码**唯一**能跑起来的路径
 *   （HANDOVER 批 5 的结论：出路是手写可运行壳，不是调参数）。
 *
 * ⚠️ 纯函数，不许碰 DOM / 不许 import 执行器 —— 引擎断言要直接测它。
 */

/** Java 里"这已经是一个完整的编译单元"的判据：有类的声明就不该再套壳 */
const HAS_TYPE_DECL = /\b(?:public\s+|final\s+|abstract\s+)*(?:class|interface|enum|record|@interface)\s+[A-Za-z_$]/

/** JSP 页面：`<%@ page ... %>` / `<% ... %>` —— 它不是类，套壳也跑不了 */
const LOOKS_LIKE_JSP = /<%[@=!]?/

/**
 * 这段代码能不能跑、跑的话交什么。
 *
 * @param {string} code 原始（可能是 OCR 出来的）代码
 * @param {{lang?:string}} [opts] 语言提示（'java' / 'js' / ''）
 * @returns {{runnable:boolean, source:string, wrapped:boolean, reason:string, lang:string}}
 *   · `runnable=false` 时 `reason` 是给**人**看的一句话（别写英文异常名）
 *   · `wrapped=true` 表示我们替它补了类壳 + main 方法，界面上要说清楚
 */
export function snippetRunPlan(code, opts = {}) {
  const text = String(code ?? '')
  const lang = String(opts.lang || '').toLowerCase() || (/System\.out|public\s+class|import\s+java\./.test(text) ? 'java' : 'js')

  if (!text.trim()) {
    return { runnable: false, source: '', wrapped: false, reason: '这段是空的，先写点东西再跑。', lang }
  }
  if (lang !== 'java') {
    // JS / Vue 片段：浏览器沙箱直接跑（沙箱里装了迷你 Vue，见 core/vue-shim.js）
    return { runnable: true, source: text, wrapped: false, reason: '', lang }
  }
  if (LOOKS_LIKE_JSP.test(text)) {
    return {
      runnable: false,
      source: text,
      wrapped: false,
      reason: '这是一段 JSP 页面（<% %> 那种），它要 Servlet 容器才跑得起来，单独编译不了。',
      lang,
    }
  }
  if (HAS_TYPE_DECL.test(text)) {
    return { runnable: true, source: text, wrapped: false, reason: '', lang }
  }
  return { runnable: true, source: wrapJavaFragment(text), wrapped: true, reason: '', lang }
}

/**
 * 把"几行语句"包进一个能编译的类里。
 *
 * 两条规矩（都是实测踩出来的，别图省事合成一条）：
 *   1. `import` / `package` **必须留在类外面**：塞进方法体里编译不过，
 *      而且报错是 "illegal start of type"，看着完全不像 import 的问题。
 *   2. 类名叫 `Main`：`java Main.java` 单文件启动认这个名字，
 *      也不用去猜教材里那个类到底叫什么。
 */
export function wrapJavaFragment(code) {
  const lines = String(code ?? '').split('\n')
  const head = []
  const body = []
  let inHead = true
  for (const line of lines) {
    if (inHead && /^\s*(?:import|package)\s/.test(line)) head.push(line)
    else {
      inHead = false
      body.push(line)
    }
  }
  // 方法体缩进一级，读起来才像话（也方便人核对补了什么）
  const indented = body.map((l) => (l.trim() ? `        ${l}` : l)).join('\n')
  const preamble = head.length ? head.join('\n') + '\n' : ''
  return `${preamble}public class Main {
    public static void main(String[] args) {
${indented}
    }
}
`
}
