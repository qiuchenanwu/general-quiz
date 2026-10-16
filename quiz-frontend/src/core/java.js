/**
 * java.js —— Java 真跑的**纯逻辑**：把后端结果整成和浏览器沙箱**同一种形状**
 * ============================================================================
 * 为什么关键：判定和展示都只认 `collectRun()` 那一套
 * （`{ok, lines:[{kind,text}], output, error, timedOut}`，见 core/code.js）。
 * 只要 Java 这条路也产出同样形状，"修好它/手写"的判定、运行面板的渲染、
 * 期望输出比对全都不用分叉 —— 少一套分叉就少一类"两条路行为不一致"的 bug。
 *
 * ⚠️ 换行符：板子上 `println` 是 LF，Windows 上是 CRLF。
 *   判期望输出前必须归一化，否则同一段代码开发机上过、板子上判错，看着毫无差别。
 *   （这里统一走 `normalizeOutput`，和 JS 那条路同一份实现。）
 */
import { normalizeOutput } from './code'

/**
 * 后端 `run_java()` 的返回 → `collectRun()` 的形状。
 *
 * 后端字段：{ok, phase, sandbox, output, stdout, stderr, exit_code, ms,
 *           truncated, compile_errors}
 * phase：compile（编译失败）/ run（运行出错）/ ok / timeout / env
 *
 * 约定（和 JS 沙箱保持一致）：
 *   - **stdout 才算"程序的输出"**，参与判定
 *   - stderr 显示出来但**不参与判定**（Servlet 驱动的 [status]/[content-type]
 *     就走 stderr，见 quiz/tools/java_sandbox.py 的驱动注释）
 *   - 编译错误 / 运行异常 → 归到 error，UI 要明显区分（这两种错学生要做的事完全不同）
 */
export function javaResultToRun(result) {
  const r = result || {}
  const lines = []
  const phase = String(r.phase || '')

  const stdout = normalizeOutput(r.output ?? '')
  for (const text of stdout) lines.push({ kind: 'stdout', text })

  // stderr 也摆出来（诊断信息），但不算进 output
  for (const text of normalizeOutput((r.stderr || []).join('\n'))) {
    lines.push({ kind: 'stderr', text })
  }

  let error = ''
  if (phase === 'compile') {
    const details = (r.compile_errors || []).join('\n')
    error = `编译没过。Java 是静态类型的，先按编译器说的改：\n${details}`
    lines.push({ kind: 'error', text: error })
  } else if (phase === 'timeout') {
    error = '运行超时（代码里可能有死循环）。已经把它掐掉了，改完再跑。'
    lines.push({ kind: 'error', text: error })
  } else if (phase === 'env') {
    error = `沙箱环境没准备好：${(r.compile_errors || [])[0] || r.error || '未知原因'}`
    lines.push({ kind: 'error', text: error })
  } else if (phase === 'run' || r.ok === false) {
    error = '运行时抛异常了（看下面的栈）：'
    lines.push({ kind: 'error', text: error })
  }

  return {
    ok: !!r.ok && !error,
    lines,
    output: stdout.join('\n'),
    error,
    timedOut: phase === 'timeout',
    // Java 独有的附加信息，界面可以显示（沙箱方式/耗时）
    meta: { sandbox: r.sandbox || '', ms: r.ms || 0, phase, truncated: !!r.truncated },
  }
}

/**
 * 从**一道题的代码**拼出要交给后端的源文件。
 *
 * 现阶段只支持"单文件"：教材片段都是一个类一个文件。
 * 类名必须和文件名一致（Java 的硬规矩），所以要从代码里把 public 类名抠出来 ——
 * 抠不到就退回 Main.java（`java Main.java` 单文件启动也认）。
 *
 * 返回 `{ 'Xxx.java': '源码' }`。
 */
export function javaSources(code) {
  const text = String(code ?? '')
  const m = text.match(/\bpublic\s+(?:final\s+|abstract\s+)?class\s+([A-Za-z_$][\w$]*)/)
  const name = m ? m[1] : 'Main'
  return { [`${name}.java`]: text }
}
