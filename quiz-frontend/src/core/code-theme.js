/**
 * core/code-theme.js —— 代码块的**主题（配色方案）**
 * ============================================================================
 * 站主原话：「现在的代码块我需要自定义主题」。
 *
 * 现状（改之前）：代码面板的底色/文字是 `styles/theme.css` 里的 `--q-code-*` 变量，
 * 但**语法分色**用的是 CodeMirror 自带的 `defaultHighlightStyle` —— 那套配色是照着
 * 浅色背景调的，摆在站点这个深色代码面板上既不统一、也没法换。
 *
 * 做法（关键是"配色全在 CSS 变量里"，见 core/editor.js 的注释）：
 *   · 这里只是**纯数据**：每个主题一组面板变量（bg/text/…）+ 一组 token 颜色；
 *   · editor.js 给每个 token 挂一个**稳定 class**（`.q-tok-kw` 等），自己不写颜色；
 *   · 真正上色的是 CSS：`.q-tok-kw { color: var(--q-tok-kw) }`，
 *     而 `--q-tok-*` 由 `stores/quiz.js` 的 `applyAppearance()` 按这里的值写上去。
 *   ⇒ 换主题 = 换一组 CSS 变量，**不用重建编辑器、不丢光标**。
 *
 * ⚠️ 这个文件必须能在 Node 里直接 import（引擎断言要查主题表的完整性），
 *    所以**不许 import 任何 @codemirror/* 或碰 DOM**。
 */

/** 面板变量（键名去掉 `--q-` 前缀，方便断言；写法见 applyAppearance） */
export const PANEL_VARS = ['code-bg', 'code-bg-2', 'code-text', 'code-dim', 'code-line', 'code-caret']

/**
 * token 名 → CSS 变量后缀。
 * ⚠️ 这里的**键名要和 editor.js 里 `TOKEN_TAGS` 的键一一对应**：
 *    少一个，那个 token 就会没颜色（退回正文色）；多一个，就是一条死变量。
 *    两边由引擎断言交叉核对（别只改一处）。
 */
export const TOKEN_NAMES = ['kw', 'str', 'com', 'num', 'type', 'fn', 'op', 'prop', 'atom', 'tag', 'attr']

/** 主题 id 的集合，用于"设置里存了个不认识的 id"时回退 */
export const CODE_THEMES = [
  {
    id: 'site',
    label: '跟随站点（默认）',
    //: site = **不覆盖任何变量**，完全走 theme.css 的明暗两套（改之前的行为）
    site: true,
    hint: '跟着站点明暗走；浅色模式下代码面板也保持深色',
  },
  {
    id: 'one-dark',
    label: 'One Dark',
    hint: 'Atom 那套深色配色',
    vars: {
      'code-bg': '#282c34',
      'code-bg-2': '#21252b',
      'code-text': '#abb2bf',
      'code-dim': '#5c6370',
      'code-line': 'rgba(255, 255, 255, 0.06)',
      'code-caret': '#528bff',
    },
    tokens: {
      kw: '#c678dd',
      str: '#98c379',
      com: '#5c6370',
      num: '#d19a66',
      type: '#e5c07b',
      fn: '#61afef',
      op: '#56b6c2',
      prop: '#e06c75',
      atom: '#d19a66',
      tag: '#e06c75',
      attr: '#d19a66',
    },
  },
  {
    id: 'dracula',
    label: 'Dracula',
    hint: '高对比深色，紫/粉为主',
    vars: {
      'code-bg': '#282a36',
      'code-bg-2': '#21222c',
      'code-text': '#f8f8f2',
      'code-dim': '#6272a4',
      'code-line': 'rgba(255, 255, 255, 0.06)',
      'code-caret': '#f8f8f2',
    },
    tokens: {
      kw: '#ff79c6',
      str: '#f1fa8c',
      com: '#6272a4',
      num: '#bd93f9',
      type: '#8be9fd',
      fn: '#50fa7b',
      op: '#ff79c6',
      prop: '#f8f8f2',
      atom: '#bd93f9',
      tag: '#ff79c6',
      attr: '#50fa7b',
    },
  },
  {
    id: 'github-light',
    label: 'GitHub Light',
    hint: '浅色，适合白天/投屏',
    vars: {
      'code-bg': '#f6f8fa',
      'code-bg-2': '#eaeef2',
      'code-text': '#1f2328',
      'code-dim': '#6e7781',
      'code-line': 'rgba(0, 0, 0, 0.08)',
      'code-caret': '#0969da',
    },
    tokens: {
      kw: '#cf222e',
      str: '#0a3069',
      com: '#6e7781',
      num: '#0550ae',
      type: '#953800',
      fn: '#8250df',
      op: '#0550ae',
      prop: '#0550ae',
      atom: '#0550ae',
      tag: '#116329',
      attr: '#0550ae',
    },
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    hint: '米黄低对比，久看不累',
    vars: {
      'code-bg': '#fdf6e3',
      'code-bg-2': '#eee8d5',
      'code-text': '#657b83',
      'code-dim': '#93a1a1',
      'code-line': 'rgba(0, 0, 0, 0.07)',
      'code-caret': '#268bd2',
    },
    tokens: {
      kw: '#859900',
      str: '#2aa198',
      com: '#93a1a1',
      num: '#d33682',
      type: '#b58900',
      fn: '#268bd2',
      op: '#859900',
      prop: '#268bd2',
      atom: '#d33682',
      tag: '#268bd2',
      attr: '#b58900',
    },
  },
]

/** 默认主题 id（**必须是 CODE_THEMES 里存在的**，断言会查） */
export const DEFAULT_CODE_THEME = 'site'

/**
 * 按 id 取主题；**认不出就回退默认**（localStorage 里可能是旧版本写的、
 * 或被手工改坏了 —— 那种脏数据不该让代码块没颜色）。
 */
export function getCodeTheme(id) {
  const found = CODE_THEMES.find((t) => t.id === id)
  return found || CODE_THEMES.find((t) => t.id === DEFAULT_CODE_THEME)
}

/** 这个主题要不要覆盖 CSS 变量（site 不覆盖：完全交给 theme.css 的明暗两套） */
export function themeOverrides(id) {
  const t = getCodeTheme(id)
  return !t.site
}

/**
 * 把主题摊成 `--q-*` 变量表（**只给 site 之外的主题**；site 返回空对象）。
 * 面板变量和 token 变量一起给，applyAppearance 一把写上去。
 */
export function themeCssVars(id) {
  const t = getCodeTheme(id)
  if (t.site) return {}
  const out = {}
  for (const [k, v] of Object.entries(t.vars || {})) out[`--q-${k}`] = v
  for (const [k, v] of Object.entries(t.tokens || {})) out[`--q-tok-${k}`] = v
  return out
}
