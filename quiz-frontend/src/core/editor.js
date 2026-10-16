/**
 * core/editor.js —— 代码输入框：**语法高亮 + 自动补全**（站主 2026-10-11 反馈）
 * ============================================================================
 * 站主原话：「用户修改代码你要加上自动补全和颜色区分，让他们在校验的时候就提前熟悉代码」。
 * 目标不是做成 IDE，而是**让学生在改/写这段教材代码时，眼睛先熟悉它**：
 *   · 高亮：关键字、字符串、注释、数字一眼分得开（原来是纯黑一行行字）
 *   · 补全：词表**主要来自这道题自己的代码**（教材里出现过的 API），
 *     而不是塞一整套语言服务 —— 学生会优先看到"这道题里就有的名字"
 *
 * 选型（量过，不是拍脑袋）：CodeMirror 6，**动态 import**。
 *   核心 min+gzip 100.8KB；+JS 143.8KB；+Java 128.7KB；+Vue 170.2KB（各自单独 lazy）
 *   自带词表补全只多 0.6KB。官方 `basicSetup` 打全套三个语言 = 210KB，
 *   **超了仓库"单个 chunk ≤200KB"的规矩**，所以这里手工挑扩展，不用 basicSetup（见坑 107）。
 *   Monaco 最小 685.7KB + 一个 1.5MB 的 ts.worker，且**没有 Java 补全** —— 不考虑。
 *
 * ⚠️ 这个文件在 Node 里也要能 import（引擎断言要测 `completionWords`），
 *   所以**任何 @codemirror/* 都只能出现在函数内部的 `await import()` 里**。
 *   （`./code-theme.js` 是纯数据，没有这个限制。）
 */
import { themeOverrides } from './code-theme.js'

/**
 * 语法 token → 我们的**稳定 class 后缀**（`.q-tok-kw`、`.q-tok-str` …）。
 *
 * 为什么不让 CodeMirror 自己生成 class：`HighlightStyle.define` 不给 `class` 时
 * 会现编一个哈希名（`ͼ1a`）写进样式表，**外面没法用 CSS 覆盖** ——
 * 那样"换主题"就只能重建编辑器（丢光标、还得为每个主题写一份 JS）。
 * 这里改成"只挂 class、颜色全交给 CSS 变量"（官方文档里明确支持这种用法），
 * 于是换主题 = 换一组变量，见 core/code-theme.js 的注释。
 *
 * ⚠️ 键名必须和 `core/code-theme.js` 的 `TOKEN_NAMES` **一一对应**：
 *    这套对应关系由引擎断言交叉核对（少一个 token 就没颜色，多一个就是死配置）。
 */
export const TOKEN_CLASS_KEYS = [
  'kw', 'str', 'com', 'num', 'type', 'fn', 'op', 'prop', 'atom', 'tag', 'attr',
]

/** 按上面的键名，把 @lezer/highlight 的 tag 分组（tags 只能动态 import，所以在函数里建） */
function tokenTagGroups(tags) {
  return {
    kw: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.definitionKeyword,
      tags.operatorKeyword, tags.modifier],
    str: [tags.string, tags.special(tags.string), tags.character, tags.docString],
    com: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    num: [tags.number, tags.integer, tags.float],
    type: [tags.typeName, tags.className, tags.namespace, tags.macroName],
    fn: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    op: [tags.operator, tags.compareOperator, tags.arithmeticOperator, tags.logicOperator,
      tags.bitwiseOperator, tags.updateOperator, tags.definitionOperator, tags.typeOperator,
      tags.controlOperator, tags.derefOperator],
    prop: [tags.propertyName],
    atom: [tags.bool, tags.null, tags.atom, tags.self, tags.unit, tags.constant],
    tag: [tags.tagName, tags.angleBracket],
    attr: [tags.attributeName, tags.attributeValue, tags.labelName],
  }
}

/** 造"只挂 class、不写颜色"的高亮扩展（颜色在 CSS：`.q-tok-kw { color: var(--q-tok-kw) }`） */
function buildTokenHighlight(CM, tags) {
  const groups = tokenTagGroups(tags)
  const specs = []
  for (const key of TOKEN_CLASS_KEYS) {
    for (const tag of groups[key] || []) specs.push({ tag, class: `q-tok-${key}` })
  }
  return CM.language.syntaxHighlighting(CM.language.HighlightStyle.define(specs), { fallback: true })
}

/**
 * 高亮扩展按主题二选一：
 *   · `site`（默认）→ 还是 CodeMirror 自带的 `defaultHighlightStyle`，**改之前的行为不变**；
 *   · 任何预设主题 → 我们那套 `.q-tok-*`，颜色由 code-theme.js 写进 CSS 变量。
 * 放进 Compartment 是为了**换主题时能就地重配**，不用重建编辑器（不丢光标）。
 */
function highlightExtension(CM, themeId, tags) {
  const wantsPreset = themeOverrides(themeId) && tags
  if (wantsPreset) return buildTokenHighlight(CM, tags)
  return CM.language.syntaxHighlighting(CM.language.defaultHighlightStyle, { fallback: true })
}

/** 当前主题需不需要 `@lezer/highlight`（不需要就别去 import 它：省一次下载） */
function needsTokenTags(themeId) {
  return themeOverrides(themeId)
}

/**
 * 猜语言（**只为了高亮和界面提示**；猜不准就留空 → 界面会说"这段跑不了"，填空照样能做）。
 *
 * 为什么不硬猜：代码题的判据是"教材原文怎么写的"，跟跑不跑没关系；
 * 猜错了只会让"运行"按钮出现却跑不动 —— 宁可留空。
 */
export function guessLang(code) {
  const s = String(code || '')
  if (/System\.out\.print|public\s+class|import\s+java\.|@WebServlet|HttpServlet(Request|Response)|resp\.(set|get|send)/.test(s)) {
    return 'java'
  }
  if (/(^|\s)(const|let|ref|reactive|computed)\s*[(=\s]|=>|<\/?template|<script\s+setup/.test(s)) {
    return 'js'
  }
  return ''
}

/** 语言关键字（补全用的兜底词表：教材代码里没出现、但学生一定会用到的） */
const KEYWORDS = {
  java: [
    'public', 'private', 'protected', 'static', 'final', 'void', 'class', 'interface',
    'extends', 'implements', 'new', 'return', 'import', 'package', 'throws', 'try', 'catch',
    'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'null', 'true', 'false',
    'this', 'super', 'String', 'Integer', 'System', 'out', 'println', 'print',
  ],
  js: [
    'const', 'let', 'var', 'function', 'return', 'import', 'export', 'default', 'from',
    'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'null', 'undefined',
    'true', 'false', 'this', 'new', 'class', 'extends', 'async', 'await', 'try', 'catch',
    'ref', 'reactive', 'computed', 'watch', 'onMounted', 'console', 'log',
  ],
}

/**
 * 从代码里"收词"给补全用（**纯函数，可离线断言**）。
 *
 * 为什么主要用题目自己的代码当词表：学生要熟悉的是**这段教材代码**，
 * 给他一屏语言内置的 API 反而干扰。所以这段代码里的标识符排在最前面，
 * 关键字兜底排后面（CodeMirror 按我们给的顺序展示）。
 */
export function completionWords(code, lang = '', extra = []) {
  const src = String(code || '')
  const seen = new Set()
  const out = []
  const push = (w) => {
    const s = String(w || '').trim()
    if (s.length < 2 || seen.has(s)) return
    seen.add(s)
    out.push(s)
  }
  // ① 这段代码里的标识符（含驼峰/下划线/点号前的对象名）
  for (const m of src.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const w = m[0]
    if (/^\d/.test(w)) continue
    push(w)
  }
  // ② 调用点补全更想要"函数名"，把带 ( 的挑出来再放一遍（顺序靠前）
  const calls = []
  for (const m of src.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
    if (!calls.includes(m[1])) calls.push(m[1])
  }
  // ③ 调用方给的关键词（有的题会自带"这一节在讲的 API"）
  for (const w of extra) push(w)
  // ④ 关键字兜底
  const kws = KEYWORDS[lang === 'java' ? 'java' : 'js'] || KEYWORDS.js
  const rest = out.filter((w) => !calls.includes(w))
  return [...calls, ...kws.filter((k) => !seen.has(k)), ...rest]
}

/** 按题目声明/推断的语言，动态取语言包（**每个语言单独一个 chunk**） */
async function loadLanguage(lang) {
  const l = String(lang || '').toLowerCase()
  if (l === 'java') return (await import('@codemirror/lang-java')).java()
  if (l === 'vue' || l === 'vue-html' || l === 'html') {
    const mod = await import('@codemirror/lang-vue')
    return (mod.vue ? mod.vue() : mod.html())
  }
  if (l === 'js' || l === 'javascript' || l === 'jsx' || l === '') {
    return (await import('@codemirror/lang-javascript')).javascript()
  }
  // 认不出的语言：只要有高亮就行（用 JS 的词法也聊胜于无，至少括号/字符串分得开）
  return (await import('@codemirror/lang-javascript')).javascript()
}

/**
 * 把编辑器挂到一个 DOM 元素上。
 *
 * ⚠️ **动态 import**：CodeMirror 只在真的打开一道代码题时才下载，
 *    不进主包（主包已经 1468KB 了）。
 * ⚠️ 任何一步失败都**退回普通 textarea** —— 宁可没有高亮，也不能让人没法答题。
 *
 * @returns {Promise<{destroy:Function, getValue:Function, setValue:Function, focus:Function, kind:string}>}
 */
export async function mountEditor(host, { doc = '', lang = '', words = [], onChange = null, readOnly = false, themeId = 'site' } = {}) {
  const fallback = () => {
    const ta = document.createElement('textarea')
    ta.className = 'q-ce__fallback'
    ta.spellcheck = false
    ta.value = doc
    ta.rows = 8
    if (readOnly) ta.readOnly = true
    ta.addEventListener('input', () => onChange && onChange(ta.value))
    host.appendChild(ta)
    return {
      kind: 'textarea',
      destroy: () => ta.remove(),
      getValue: () => ta.value,
      setValue: (v) => {
        ta.value = v
      },
      focus: () => ta.focus(),
    }
  }

  let CM
  try {
    CM = {
      state: await import('@codemirror/state'),
      view: await import('@codemirror/view'),
      commands: await import('@codemirror/commands'),
      language: await import('@codemirror/language'),
      autocomplete: await import('@codemirror/autocomplete'),
    }
  } catch {
    return fallback()
  }

  try {
    const { EditorState, Compartment } = CM.state
    const { EditorView, keymap, lineNumbers, highlightActiveLine } = CM.view
    const { defaultKeymap, indentWithTab, history, historyKeymap } = CM.commands
    const { bracketMatching, indentOnInput } = CM.language
    const { autocompletion, closeBrackets, closeBracketsKeymap, completeFromList } = CM.autocomplete

    const languageConf = new Compartment()
    //: 高亮也放 Compartment：换主题时**就地重配**，不重建编辑器（不丢光标、不丢撤销栈）
    const highlightConf = new Compartment()
    const langExt = await loadLanguage(lang)

    // 只有预设主题才需要 tag 表；site 主题连这个包都不碰（它本来就用自带高亮）
    //
    // ⚠️ `@lezer/highlight` **没有**写进 package.json，这是有意的：
    //    它是 `@codemirror/language` 的**硬依赖**（^1.0.0，不是 optional/peer），
    //    而我们直接依赖 @codemirror/language ⇒ npm 的扁平 node_modules 里它一定在。
    //    把它写进依赖就得跟着改 package-lock.json（要联网重算），
    //    为省这一次抖动，这里用 try/catch 兜底：真拿不到就退回自带高亮，
    //    **最坏情况只是配色不理想，绝不会让人没法答题**。
    let tokenTags = null
    if (needsTokenTags(themeId)) {
      try {
        tokenTags = (await import('@lezer/highlight')).tags
      } catch {
        tokenTags = null
      }
    }

    // 高亮配色跟着站点主题走（深色代码面板的 CSS 变量在 CodeRunner.vue 里）
    const theme = EditorView.theme({
      '&': { backgroundColor: 'transparent', color: 'inherit', fontSize: '13px' },
      '.cm-content': { fontFamily: 'inherit', caretColor: 'var(--q-code-caret, #7dd3fc)' },
      '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--q-code-dim, #64748b)', border: 'none' },
      '.cm-activeLine': { backgroundColor: 'rgba(125, 211, 252, 0.06)' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent' },
      '&.cm-focused': { outline: 'none' },
      '.cm-tooltip-autocomplete': { fontSize: '12px' },
    })

    const state = EditorState.create({
      doc: String(doc || ''),
      extensions: [
        lineNumbers(),
        history(),
        highlightActiveLine(),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        highlightConf.of(highlightExtension(CM, themeId, tokenTags)),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        // ★ 补全词表来自"这道题自己的代码 + 关键字兜底"（completionWords）
        autocompletion({ override: [completeFromList(words.map((w) => ({ label: w, type: 'keyword' })))] }),
        languageConf.of(langExt),
        theme,
        EditorView.editable.of(!readOnly),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && onChange) onChange(u.state.doc.toString())
        }),
      ],
    })

    const view = new EditorView({ state, parent: host })
    return {
      kind: 'codemirror',
      destroy: () => view.destroy(),
      getValue: () => view.state.doc.toString(),
      setValue: (v) => {
        const cur = view.state.doc.toString()
        if (v === cur) return
        view.dispatch({ changes: { from: 0, to: cur.length, insert: String(v ?? '') } })
      },
      focus: () => view.focus(),
      /**
       * 换代码块主题（设置页改了就调它）。
       *
       * ⚠️ tag 表要**在这里再兜一次**：挂载时如果选的是 `site`，
       *    上面那段根本不会去 import `@lezer/highlight`（`tokenTags` 还是 null），
       *    于是用户第一次切到预设主题时就没有 tag 可用 —— 表现是
       *    「变量都对了、data-code-theme 也变了，但代码就是不上色」。
       *    这个坑单测看不出来（单测只查表，不挂编辑器），是**真浏览器**验出来的。
       */
      setTheme: async (next) => {
        try {
          if (needsTokenTags(next) && !tokenTags) {
            tokenTags = (await import('@lezer/highlight')).tags
          }
          view.dispatch({ effects: highlightConf.reconfigure(highlightExtension(CM, next, tokenTags)) })
        } catch {
          /* 换主题失败不该影响答题：忽略 */
        }
      },
    }
  } catch {
    return fallback()
  }
}
