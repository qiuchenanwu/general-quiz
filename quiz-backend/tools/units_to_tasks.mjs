#!/usr/bin/env node
/**
 * units_to_tasks.mjs —— 教材知识单元 → **代码题**（填空 / 找错行 / 预测输出 / 修好它 / 手写）
 * ============================================================================
 * 为什么要有这一步：
 *   docs_to_bank.py 从官方文档里抽出了 398 个教学点，其中 273 个是**真实代码块**，
 *   而它们最后全被压成了"下列说法正确的有哪些"。那份代码本来是能跑的 ——
 *   于是这里把它还给用户：填空、找错行、预测输出、修好它，四种交互，
 *   判据全部是**确定性的**（字符串 / 行号 / 运行输出），不花一分钱 API。
 *
 * ★ 这个工具最要紧的规矩：**不许编造期望输出**。
 *   - "预测输出"和"修好它"都要求代码能真跑、且跑出来的东西**被证明过**。证明有两种：
 *     ① 文档自己的注释（文档里写着 `console.log(count.value) // 1` 这种），一条对不上就整段不要；
 *     ② 文档**没写**结果时，补一句 `console.log(…)` 再用同一份运行时真跑一遍算出来
 *        （见下面「补一句 console.log 再跑」一节：只收推得出来的值，且每题都标注来源）。
 *   - 跑代码用的是前端沙箱里**同一份**迷你运行时（frontend/src/core/vue-shim.js），
 *     所以在 Node 里算出来的期望输出，和用户在浏览器里按「运行」看到的是一回事。
 *   - "找错行"的每个改动，都要先验证**它真的能被察觉**（JS 的跑一遍：输出变了或报错；
 *     模板的改动是语义变化，会在解析里说清楚）—— 察觉不到的改动不成题。
 *
 * 用法（在仓库根目录跑）：
 *   node quiz/tools/units_to_tasks.mjs --selftest
 *   node quiz/tools/units_to_tasks.mjs \
 *     --units .tmp/docs-bank/vue-essentials.units.json \
 *     --out quiz/frontend/src/banks/vue-code-tasks.json
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import process from 'node:process'

import { SANDBOX_RUNTIME, runBlockReason } from '../frontend/src/core/code.js'

/* ══════════════════════════ 迷你运行时的调用口 ══════════════════════════ */

/**
 * 在全新上下文里跑一段代码，拿控制台输出。**和浏览器沙箱同一份运行时**。
 * @returns {{lines:string[], error:string}}
 */
export function runSnippet(code) {
  const lines = []
  const ctx = vm.createContext({ __send: (kind, text) => lines.push({ kind, text }) })
  try {
    vm.runInContext(`${SANDBOX_RUNTIME}\n__captureConsole(__send);\n${code}`, ctx, { timeout: 2000 })
  } catch (e) {
    return { lines: [], error: String((e && e.name ? e.name + ': ' : '') + (e && e.message)) }
  }
  return {
    lines: lines.filter((l) => l.kind === 'stdout').map((l) => l.text),
    error: '',
  }
}

/* ══════════════════════════ 小工具 ══════════════════════════ */

/** 固定种子的随机数：题库要**可复现**，不能每次生成都换选项顺序 */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffleSeeded(arr, seed) {
  const rnd = mulberry32(seed)
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const LETTERS = 'ABCDEFGH'
function lettersFor(n) {
  return LETTERS.slice(0, n).split('')
}

/** 官方文档里代码块的语言标记 → 我们认的语言 */
function normLang(lang) {
  const t = String(lang || '').toLowerCase()
  if (['js', 'javascript', 'mjs'].includes(t)) return 'js'
  if (['vue-html', 'vue', 'html', 'template'].includes(t)) return t === 'vue-html' ? 'vue-html' : t
  return t
}

/** 去掉 `import … from 'vue'`：沙箱里靠迷你运行时提供同名全局，import 语句没法解析 */
function stripVueImports(code) {
  let removed = 0
  const out = code
    .split('\n')
    .filter((line) => {
      const hit = /^\s*import\s+[^'"]*from\s+['"](vue|@vue\/[^'"]+)['"]\s*;?\s*$/.test(line)
      if (hit) removed++
      return !hit
    })
    .join('\n')
  return { code: out, removed }
}

/* ══════════════════════════ 词条说明（判完后的解析） ══════════════════════════ */

/**
 * 填空/找错行的解析文案。**答案本身就是这些名字**，所以判完之后讲清楚它是干什么的 ——
 * 这才是"交互式学习"和"考词汇"的区别。
 */
const TOKEN_NOTES = {
  ref: 'ref(x) 造一个带 .value 的响应式引用；JS 里读写要走 .value，模板里自动解包。',
  reactive: 'reactive(obj) 把对象变成响应式代理；返回的是代理，不等于原对象，同一对象多次调用给同一个代理。',
  computed: 'computed(getter) 是带缓存的计算属性：依赖没变就不会重算。',
  watch: 'watch(源, 回调) 是"源变了再做副作用"；源可以是 ref、getter 或数组。',
  watchEffect: 'watchEffect(fn) 立刻跑一遍并自动收集依赖，之后依赖变了再跑。',
  onMounted: 'onMounted(fn) 在组件挂载后执行一次（拿得到 DOM）。',
  onUnmounted: 'onUnmounted(fn) 在组件卸载后执行，用来清定时器/事件监听。',
  onUpdated: 'onUpdated(fn) 在组件因响应式数据变化重新渲染后执行。',
  createApp: 'createApp(根组件) 创建应用实例，再由 .mount(选择器) 挂到页面上。',
  defineProps: 'defineProps() 声明这个组件接收哪些 props（<script setup> 里的编译宏）。',
  defineEmits: 'defineEmits() 声明这个组件会发出哪些事件。',
  defineExpose: 'defineExpose() 决定父组件通过模板 ref 能拿到什么。',
  toRef: 'toRef(obj, key) 取对象某个属性的 ref，断开它和原对象的绑定。',
  toRefs: 'toRefs(obj) 把响应式对象拆成一堆 ref —— 解构后仍然响应式。',
  nextTick: 'nextTick() 等 DOM 更新完再执行（数据变了但 DOM 还没变时用）。',
  useTemplateRef: 'useTemplateRef("名字") 拿模板里 ref="名字" 的元素引用（3.5+）。',
  shallowRef: 'shallowRef(x) 只对 .value 整体替换做响应式，内部深层变化不触发。',
  readonly: 'readonly(x) 造一个只读代理，改了会警告。',
  'v-if': 'v-if 是条件渲染：不满足时元素**根本不存在**。',
  'v-else': 'v-else 必须紧跟在 v-if / v-else-if 后面。',
  'v-else-if': 'v-else-if 是链式条件的中间一环。',
  'v-for': 'v-for="item in list" 循环渲染，记得给 :key。',
  'v-show': 'v-show 只是切 display：元素一直在 DOM 里，开销不同。',
  'v-bind': 'v-bind（简写 :）把数据**单向**传给元素属性。',
  'v-on': 'v-on（简写 @）绑定事件监听。',
  'v-model': 'v-model 是**双向**绑定：表单输入会写回数据。',
  'v-html': 'v-html 插入原始 HTML（内容可信时才用）。',
  'v-text': 'v-text 设置元素的文本内容（等价于 {{ }}）。',
  'v-slot': 'v-slot（简写 #）给插槽传内容。',
  'v-once': 'v-once 只渲染一次，之后不再更新。',
  'v-memo': 'v-memo 在依赖数组没变时跳过这一块的更新。',
}

/** 找错行的"配对"说明：改动前后差在哪、为什么这个差别重要 */
const PAIR_NOTES = {
  'ref→reactive':
    '原文用的是 ref(…)：JS 里通过 .value 读写。换成 reactive(…) 之后拿到的是代理对象，.value 就不存在了。',
  'drop-value':
    'ref 在 JS 里必须写 .value；漏掉它，拿到的是 ref 对象本身（在 JS 里不会自动解包）。',
  'drop-await': '少了 await，这一步拿到的是 Promise 而不是结果 —— 后面的代码就开始对着 Promise 干活了。',
  'eq-to-assign': '=== 是判断（得到布尔值），= 是赋值：写成赋值之后，打印出来的是被赋的那个值。',
  'v-model→v-bind': 'v-model 是双向绑定；改成 v-bind（简写 :）只剩单向传值，输入框的改动不会再写回数据。',
  'v-if→v-show': 'v-if 不满足条件时元素不存在；v-show 只是 display:none —— DOM、生命周期、性能都不一样。',
}

/* ══════════════════════════ 填空 ══════════════════════════ */

const JS_TOKENS = [
  'ref', 'reactive', 'computed', 'watch', 'watchEffect', 'onMounted', 'onUnmounted', 'onUpdated',
  'createApp', 'defineProps', 'defineEmits', 'defineExpose', 'toRef', 'toRefs', 'nextTick',
  'useTemplateRef', 'shallowRef', 'readonly',
]
const DIR_TOKENS = [
  'v-if', 'v-else-if', 'v-else', 'v-for', 'v-show', 'v-bind', 'v-on', 'v-model', 'v-html',
  'v-text', 'v-slot', 'v-once', 'v-memo',
]

function countOccurrences(code, token) {
  const re = JS_TOKENS.includes(token) ? new RegExp(`\\b${token}\\b`, 'g') : new RegExp(token.replace(/[-]/g, '\\-'), 'g')
  return (code.match(re) || []).length
}

/** 把一个词条的所有出现位置挖成 `___` */
function blankToken(code, token) {
  const re = JS_TOKENS.includes(token) ? new RegExp(`\\b${token}\\b`, 'g') : new RegExp(token.replace(/[-]/g, '\\-'), 'g')
  return code.replace(re, '___')
}

/**
 * 挑要挖空的词条：优先"这个单元的 tag"（docs_to_bank 抽出来的 API 名），
 * 同一段里最多挖 2 个词条，且一个词条的每次出现都要挖（否则能从上下文猜出来）。
 */
function pickBlankTokens(code, unitTags) {
  const all = [...JS_TOKENS, ...DIR_TOKENS]
  const present = all.filter((t) => countOccurrences(code, t) > 0)
  if (!present.length) return []
  const tags = new Set(unitTags || [])
  const score = (t) => {
    const n = countOccurrences(code, t)
    let s = n * 10                       // 出现次数少的优先（更"专一"，答案更明确）
    if (tags.has(t)) s -= 25             // 这个单元讲的就是它 → 优先考
    if (t.startsWith('v-')) s -= 3       // 模板指令更值得记
    return s
  }
  const ordered = present.sort((a, b) => score(a) - score(b))
  const chosen = []
  let holes = 0
  for (const t of ordered) {
    if (chosen.length >= 2) break
    const n = countOccurrences(code, t)
    if (holes + n > 4) continue          // 空太多就变成默写整段了
    chosen.push(t)
    holes += n
  }
  return chosen
}

function buildFillTask(point, unit, code, opts) {
  const tokens = pickBlankTokens(code, unit.tags)
  if (!tokens.length) return null
  let blanked = code
  const blanks = []
  for (const t of tokens) {
    const n = countOccurrences(blanked, t)
    blanked = blankToken(blanked, t)
    for (let i = 0; i < n; i++) {
      blanks.push({ answer: [t], hint: '' })
    }
  }
  // 挖空之后必须还有内容、且空数 > 0
  if (!blanked.includes('___') || blanked.replace(/___/g, '').trim().length < 12) return null

  const notes = tokens.map((t) => TOKEN_NOTES[t]).filter(Boolean)
  return {
    id: `${point.id}-fill`.replace(/[^A-Za-z0-9_-]/g, '-'),
    type: 'code',
    mode: 'fill',
    stem: `下面这段来自官方文档（${unit.heading}）。把 \`___\` 处补回原文的写法：`,
    lang: opts.lang,
    code: blanked,
    blanks,
    // 原始契约里也把答案写出来（前端 normalize 会从 blanks 推，但契约要自解释）
    answer: blanks.map((b) => b.answer[0]),
    analysis: notes.length ? `补上的东西是什么：${notes.join(' ')}` : '对照原文核对一下这几处写法。',
    chapter: unit.chapter || unit.doc_title || '',
    tags: (unit.tags || []).slice(0, 6),
    source: {
      url: unit.url || '',
      heading: unit.heading || '',
      quote: String(point.extra?.context || '').slice(0, 200),
    },
  }
}

/* ══════════════════════════ 找错行 ══════════════════════════ */

/** 找出 `const NAME = ref(` 里的 NAME */
function refNames(code) {
  const out = []
  for (const m of code.matchAll(/\b(\w+)\s*=\s*ref\(/g)) out.push(m[1])
  return out
}

/**
 * 生成候选改动。返回值：{ code, line, pair }
 * 每个改动都必须"能被察觉"——后面会跑一遍验证（模板的改动靠语义说明）。
 */
function mutations(code, lang) {
  const out = []
  const isJs = lang === 'js'

  if (isJs) {
    // ① ref(…) → reactive(…)：只有在别处用了 .value 时才是真错（.value 会失效）
    for (const name of refNames(code)) {
      if (!new RegExp(`\\b${name}\\.value\\b`).test(code)) continue
      const re = new RegExp(`(\\b${name}\\s*=\\s*)ref\\(`)
      const idx = code.search(re)
      if (idx < 0) continue
      const mutated = code.replace(re, `$1reactive(`)
      out.push({ code: mutated, line: lineOf(code, idx), pair: 'ref→reactive' })
    }

    // ② 漏掉 .value
    for (const name of refNames(code)) {
      const m = new RegExp(`\\b${name}\\.value\\b`).exec(code)
      if (!m) continue
      const mutated = `${code.slice(0, m.index)}${name}${code.slice(m.index + m[0].length)}`
      out.push({ code: mutated, line: lineOf(code, m.index), pair: 'drop-value' })
    }

    // ③ 去掉 await
    const aw = /\bawait\s+/.exec(code)
    if (aw) {
      const mutated = `${code.slice(0, aw.index)}${code.slice(aw.index + aw[0].length)}`
      out.push({ code: mutated, line: lineOf(code, aw.index), pair: 'drop-await' })
    }

    // ④ === → =
    const eq = code.indexOf('===')
    if (eq >= 0 && /console\.log/.test(code)) {
      const mutated = `${code.slice(0, eq)}=${code.slice(eq + 3)}`
      out.push({ code: mutated, line: lineOf(code, eq), pair: 'eq-to-assign' })
    }
  } else {
    // ⑤ v-model → v-bind（模板）
    const vm = /\bv-model\b/.exec(code)
    if (vm) {
      const mutated = `${code.slice(0, vm.index)}v-bind${code.slice(vm.index + 'v-model'.length)}`
      out.push({ code: mutated, line: lineOf(code, vm.index), pair: 'v-model→v-bind' })
    }
    // ⑥ v-if → v-show（模板）
    const vi = /\bv-if\b/.exec(code)
    if (vi) {
      const mutated = `${code.slice(0, vi.index)}v-show${code.slice(vi.index + 'v-if'.length)}`
      out.push({ code: mutated, line: lineOf(code, vi.index), pair: 'v-if→v-show' })
    }
  }
  return out
}

function lineOf(code, index) {
  let line = 1
  for (let i = 0; i < index && i < code.length; i++) if (code[i] === '\n') line++
  return line
}

function buildSpotTask(point, unit, code, opts) {
  const candidates = mutations(code, opts.lang)
  for (const cand of candidates) {
    // 能被察觉吗？JS 的跑一遍看输出/报错有没有变；模板的看说明够不够硬
    if (opts.lang === 'js') {
      const before = runSnippet(code)
      const after = runSnippet(cand.code)
      const changed = after.error !== before.error || after.lines.join('\n') !== before.lines.join('\n')
      if (!changed) continue // 改了跟没改一样 → 不成题
    }
    if (!PAIR_NOTES[cand.pair]) continue
    return {
      id: `${point.id}-spot`.replace(/[^A-Za-z0-9_-]/g, '-'),
      type: 'code',
      mode: 'spot',
      stem: `下面这段是从官方文档（${unit.heading}）抄来的，**其中有一行被改动了**。点出被改动的那一行：`,
      lang: opts.lang,
      code: cand.code,
      answer: [String(cand.line)],
      analysis: `被改动的是第 ${cand.line} 行。${PAIR_NOTES[cand.pair]}`,
      chapter: unit.chapter || unit.doc_title || '',
      tags: (unit.tags || []).slice(0, 6),
      source: { url: unit.url || '', heading: unit.heading || '', quote: '' },
      // 出题过程中的证据：原文与改动点（不给用户看，工具自检要）
      _origin: { pair: cand.pair, originalLine: lineOf(code, code.search(/\S/)) },
    }
  }
  return null
}

/* ══════════════════════════ 预测输出 / 修好它 ══════════════════════════ */

/**
 * 解析文档里的"期望值注释"：`console.log(count.value) // 1` → { line, value }。
 * 这是整个工具**唯一的真相来源** —— 没有这个注释，就不生成预测输出题。
 */
function docExpectations(code) {
  const out = []
  const lines = code.split('\n')
  lines.forEach((line, i) => {
    if (!/console\.log\s*\(/.test(line)) return
    if (!/\)\s*;?\s*\/\//.test(line)) return
    const m = line.match(/\)\s*;?\s*\/\/\s*(?:=>)?\s*(.+?)\s*$/)
    if (!m) return
    out.push({ line: i + 1, value: m[1].trim() })
  })
  return out
}

/** 造干扰项：只从"看起来像那么回事"的差异里挑，凑不出就放弃这道题 */
function distractors(value) {
  const out = []
  if (/^(true|false)$/.test(value)) out.push(value === 'true' ? 'false' : 'true')
  const num = value.match(/^-?\d+$/)
  if (num) {
    const n = Number(value)
    out.push(String(n + 1), String(n - 1))
  }
  const refish = value.match(/^\{\s*value:\s*(-?\d+)\s*\}$/)
  if (refish) {
    out.push(refish[1], `{ value: ${Number(refish[1]) + 1} }`)
  }
  if (/^(null|undefined)$/.test(value)) out.push(value === 'null' ? 'undefined' : 'null')
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const n = Number(value)
    out.push(`${-n}`)
  }
  if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
    out.push(value.replace(/,\s*/, ''))
  }
  return [...new Set(out)].filter((x) => x !== value).slice(0, 2)
}

function buildPredictTask(point, unit, code, opts) {
  const expects = docExpectations(code)
  if (!expects.length) return null
  const run = runSnippet(code)
  if (run.error) return null
  // ★ 文档注释和实际输出必须**逐行对上**，否则这段代码不进题库
  if (run.lines.length !== expects.length) return null
  for (let i = 0; i < expects.length; i++) {
    if (run.lines[i].trim() !== expects[i].value) return null
  }
  const tasks = []
  expects.forEach((exp, i) => {
    const wrong = distractors(exp.value)
    if (!wrong.length) return
    // 正确的那个 + 干扰项；只有 3 个也别硬凑
    const values = shuffleSeeded([exp.value, ...wrong], 7000 + i)
    const answerIdx = values.indexOf(exp.value)
    tasks.push({
      id: `${point.id}-predict${i + 1}`.replace(/[^A-Za-z0-9_-]/g, '-'),
      type: 'code',
      mode: 'predict',
      stem: `这段代码跑起来，第 ${i + 1} 个 \`console.log\` 会打印什么？（先自己判断，再按「运行」对照）`,
      lang: 'js',
      code,
      options: values.map((v, k) => ({ key: lettersFor(values.length)[k], text: v })),
      answer: [lettersFor(values.length)[answerIdx]],
      // 整段的期望输出：既给「运行」做对照，也让单测能复核"题库里的期望值被文档证明过"
      run: { expect: run.lines },
      analysis: `这段代码的完整输出：\n${run.lines.join('\n')}\n\n官方文档给的注释：${expects.map((e) => `第${e.line}行 // ${e.value}`).join('；')}`,
      chapter: unit.chapter || unit.doc_title || '',
      tags: (unit.tags || []).slice(0, 6),
      source: { url: unit.url || '', heading: unit.heading || '', quote: '' },
    })
  })
  return tasks.length ? tasks : null
}

function buildFixTask(point, unit, code, opts) {
  const expects = docExpectations(code)
  if (!expects.length) return null
  const run = runSnippet(code)
  if (run.error || run.lines.length !== expects.length) return null
  if (expects.some((e, i) => run.lines[i].trim() !== e.value)) return null

  // 找一个"改了就跑不出原输出、但还能跑"的改动当题目
  for (const cand of mutations(code, 'js')) {
    if (cand.pair === 'drop-await') continue // 常常直接抛错，留着不当作"修好它"
    const after = runSnippet(cand.code)
    if (after.error) continue                       // 一跑就炸的，不适合让人慢慢改
    if (after.lines.join('\n') === run.lines.join('\n')) continue
    return {
      id: `${point.id}-fix`.replace(/[^A-Za-z0-9_-]/g, '-'),
      type: 'code',
      mode: 'fix',
      stem: '下面这段代码**跑出来的结果和官方文档不一致**（也可能一跑就报错）。改好它，让它打印出文档里的结果：',
      lang: 'js',
      code: cand.code,
      run: { expect: run.lines },
      analysis: `文档里这段代码的输出是：\n${run.lines.join('\n')}\n\n改动提示：${PAIR_NOTES[cand.pair] || ''}`,
      chapter: unit.chapter || unit.doc_title || '',
      tags: (unit.tags || []).slice(0, 6),
      source: { url: unit.url || '', heading: unit.heading || '', quote: '' },
      _origin: { pair: cand.pair },
    }
  }
  return null
}

/**
 * ⑤ 手写：只给**文档的说法**和**期望输出**，代码从零写。
 *
 * 这是"诊断先行"分流里那一档「把话说清楚（手写）」的落地 ——
 * 它和"填空"的区别不是难度，而是**要不要自己组织代码**：
 * 填空考的是"这个 API 叫什么"，手写考的是"这件事该怎么做出来"。
 *
 * 期望输出同样必须被文档自己的注释证明过（和 predict/fix 一个规矩）：
 * 判据是"跑出来的输出对不对"，所以没有期望输出就判不了。
 */
function buildWriteTask(point, unit, code, opts) {
  const expects = docExpectations(code)
  if (!expects.length) return null
  const run = runSnippet(code)
  if (run.error || run.lines.length !== expects.length) return null
  if (expects.some((e, i) => run.lines[i].trim() !== e.value)) return null

  const context = String(point.extra?.context || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
  const notes = expects.map((e) => `· 第 ${e.line} 行 \`// ${e.value}\``).join('\n')
  return {
    id: `${point.id}-write`.replace(/[^A-Za-z0-9_-]/g, '-'),
    type: 'code',
    mode: 'write',
    stem: `官方文档（${unit.heading}）里讲的是：${context || '这一节的那个写法。'}\n**不看原文，自己把它写出来**，让它打印出期望输出：`,
    lang: 'js',
    // 白纸一张。给一行注释只是别让输入框看起来像坏了
    code: '// 在这里写：写完按「运行」，输出对上了再提交\n',
    run: { expect: run.lines },
    analysis:
      `**参考实现**（官方文档原文，写完再对照）：\n\`\`\`js\n${code}\n\`\`\`\n\n` +
      `文档里给的注释就是期望输出：\n${notes}`,
    chapter: unit.chapter || unit.doc_title || '',
    tags: (unit.tags || []).slice(0, 6),
    source: { url: unit.url || '', heading: unit.heading || '', quote: '' },
    _origin: { pair: 'write' },
  }
}

/* ══════════ 补一句 console.log 再跑：扩 predict / fix / write 的语料 ══════════ */

/**
 * ★ 为什么要这一步（2026-10-09）：
 *   predict / fix / write 三种模式的期望输出原来只认**文档自己写好的** `// 值` 注释
 *   （见 docExpectations）。整本 guide 里符合条件的代码块只有 4 个，于是三类合计只有 14 道。
 *   可剩下的 js 片段里，很多本来就"跑一下就知道" —— 文档只是**没把结果写进注释**而已。
 *
 * 这里的办法是**生成**而不是编造：给片段**补一句** `console.log(<表达式>)`，
 * 用同一份迷你运行时（和浏览器沙箱是同一份）真跑一遍，把跑出来那一行当期望输出。
 * "补哪个表达式"也不是随便挑，见 observables 的排序。
 *
 * 两条自我约束，缺一条就会变成烂题：
 *   ① **期望值必须能从代码推出来**：原始类型，或 ref 的 `{ value: x }` 形态。
 *      对象/数组/`Map(1)` 的打印形态是**本站格式化器**的约定（真浏览器控制台不长这样），
 *      出一道"猜我们怎么打印"的题没有意义 → 一律不收（isPredictable）。
 *   ② **必须需要动脑**：computed 派生、声明后被真改写、或 ref 的 `{ value: x }` 形态
 *      （`log(count)` 还是 `log(count.value)` 正是响应式的第一课）。
 *      把 ref 里的字面量原样读回来的（`isActive.value` → `true`）不收。
 *
 * ★ 出处必须标注：这样来的题在解析里写明"文档没给这个注释、期望值是沙箱跑出来的"，
 *   结构化字段是 `provenance: 'sandbox-injected'`（若文档别处正好写着同一个值，会额外注明）。
 */

/** 把名字安全地塞进正则（标识符其实用不着，但不留"以后手滑"的口子） */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 稳定种子：同一个 id 永远得到同一个选项顺序（题库要可复现） */
function seedOf(s) {
  let h = 0
  const t = String(s)
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0
  return h
}

/**
 * 截断文档 prose 当题面。**在句子边界收尾** —— 硬切到一半
 * （"...has changed from `true`"）看着像题面坏了。
 */
function clipSentence(text, max = 240) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const head = t.slice(0, max)
  const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('。'), head.lastIndexOf('; '))
  if (cut > max * 0.5) return head.slice(0, cut + 1).trim()
  const sp = head.lastIndexOf(' ')
  return (sp > 0 ? head.slice(0, sp) : head).trim() + '…'
}

/** 数组上那些"会改内容"的方法：命中就算这个绑定被改写过 */
const MUTATING_METHODS = ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'set', 'add', 'delete']

/**
 * 声明之后的**真**改写：`NAME.value++`、`NAME.value = …`、`NAME.count = …`、`NAME.value.push(…)`。
 * 必须排除 `const NAME = ref(…)` 那条声明本身 —— 它的 `=` 不是改写。
 * （踩过：不排除的话每个 ref 都会被判成"被改写"，闸门等于没有。）
 */
function mutatedAfterDecl(code, name) {
  const n = escapeRe(name)
  const patterns = [
    // NAME.value++ / NAME.value = / NAME += …
    new RegExp(`\\b${n}(\\.value)?\\s*(\\+\\+|--|[-+*/]?=(?!=))`, 'g'),
    // reactive 对象的属性改写：NAME.count = …
    new RegExp(`\\b${n}\\.[A-Za-z_$][\\w$]*\\s*(\\+\\+|--|[-+*/]?=(?!=))`, 'g'),
    // 数组/集合方法：NAME.value.push(…) / NAME.set(…)
    new RegExp(`\\b${n}(\\.value)?\\.(${MUTATING_METHODS.join('|')})\\s*\\(`, 'g'),
  ]
  for (const re of patterns) {
    for (const m of code.matchAll(re)) {
      // 紧挨着的就是声明本身 → 不算改写
      if (/(?:const|let|var)\s*$/.test(code.slice(0, m.index))) continue
      return true
    }
  }
  return false
}

/**
 * 候选"可观测表达式"，按"该不该问它"从高到低排。
 * 排序依据：prose 提到了它 > 它被改写过 > 它是 computed > 声明顺序。
 */
function observables(code, context) {
  const out = []
  const seen = new Set()
  const re = /(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(ref|reactive|shallowRef|computed|readonly)\s*\(/g
  for (const m of code.matchAll(re)) {
    const name = m[1]
    const kind = m[2]
    if (seen.has(name)) continue
    seen.add(name)
    const inProse = new RegExp(`\\b${escapeRe(name)}\\b`).test(context)
    const mutated = mutatedAfterDecl(code, name)
    const forms = []
    if (kind === 'ref' || kind === 'shallowRef') {
      forms.push({ expr: `${name}.value`, form: 'value' })
      forms.push({ expr: name, form: 'refobj' })
    } else if (kind === 'computed') {
      forms.push({ expr: `${name}.value`, form: 'value' })
    } else {
      forms.push({ expr: name, form: 'reactive' })
    }
    for (const f of forms) {
      out.push({ name, kind, inProse, mutated, ...f, order: out.length })
    }
  }
  const score = (o) => (o.inProse ? 4 : 0) + (o.mutated ? 2 : 0) + (o.kind === 'computed' ? 1 : 0)
  // 稳定排序：分数相同时保持声明顺序
  return out.map((o, i) => ({ o, i })).sort((a, b) => score(b.o) - score(a.o) || a.i - b.i).map((x) => x.o)
}

/**
 * 值能不能"从代码推出来"。对象/数组/Map 的打印形态是本站格式化器的约定，不算。
 * `{ value: x }` 是 ref 的形态 —— Vue 文档自己就用这种写法（`// { value: 0 }`），所以收。
 */
function isPredictable(v) {
  const s = String(v)
  // `undefined` 是"这段片段本来就跑不出东西"的信号（比如 defineProps 的哑实现给了个空壳），
  // 问它等于问沙箱实现细节，推不出来也不该问。
  if (s === 'undefined' || s === '') return false
  if (/^-?\d+(\.\d+)?$/.test(s)) return true
  if (/^(true|false)$/.test(s)) return true
  const refish = s.match(/^\{\s*value:\s*(.+?)\s*\}$/)
  if (refish) return isPredictable(refish[1])
  if (/^(Map\(\d+\)|Set\(\d+\))$/.test(s)) return false   // 格式化器约定，推不出来
  if (/\{\s*\}/.test(s)) return false                       // 空对象打成 `{  }`，是格式化器的毛刺
  return !/[{}\[\]]/.test(s)                               // 裸字符串（__fmt 对字符串是原样输出）
}

/**
 * 给这段代码补一句 `console.log(<表达式>)`，返回可用的观测。
 *
 * 每一道闸门都是"宁可不出题"：
 *   原片段能跑 → 补的表达式能跑 → **输出只是多了一行**（前缀一模一样，说明补的这句不改变原行为）
 *   → 值可预测 → 两次跑结果一致（挡 Date.now / Math.random）→ 需要动脑
 */
/**
 * 这段代码能不能在沙箱里跑 —— **判据必须和 check_bank.mjs 里的 notRunnable 一模一样**。
 * ⚠️ 两处会同时决定"这道题收不收"，改一处必须改另一处（题库校验器不认，出题工具却出了，
 *    结果就是 `check_bank` 报"判据是运行输出，但沙箱里跑不了"）。
 * 踩过：`document.body.innerHTML = …` 那种"在浏览器里跑"的片段，Node 的 vm 里因为没被调用
 * 反而不报错，于是被收进来做了预测/修好题 —— 但它判不了（界面上「运行」是禁的）。
 */
function sandboxRunnable(code) {
  // ★ 判据**只用前端那一份**（core/code.js 的 runBlockReason），别再手写正则：
  //   我手写过一次，只对齐了旧规则（document/window/import/export），**漏了 `fetch`**，
  //   于是出了两道"判据是运行输出、界面却拒绝运行"的题（坑 58 的第三次现形）。
  //   现在只有一处实现：界面能不能跑，出题工具就用同一个函数判。
  return runBlockReason({ type: 'code', lang: 'js', code, mode: 'fix' }) === ''
}

function injectedObservation(code, context) {
  if (!sandboxRunnable(code)) return null
  const base = runSnippet(code)
  if (base.error) return null
  const viable = []
  for (const o of observables(code, context)) {
    // ② 需要动脑：computed 派生 / 被真改写 / ref 的 `{ value: x }` 形态
    const valuable = o.kind === 'computed' || o.mutated || o.form === 'refobj'
    if (!valuable) continue

    const injectedCode = `${code}\nconsole.log(${o.expr})`
    const run = runSnippet(injectedCode)
    if (run.error) continue
    // 只是多了一行，且原有输出一字不差（证明补的这句是**观测**，不是改行为）
    if (run.lines.length !== base.lines.length + 1) continue
    if (run.lines.slice(0, base.lines.length).join('\n') !== base.lines.join('\n')) continue

    const value = run.lines[run.lines.length - 1]
    if (!isPredictable(value)) continue
    // 确定性：同样的代码跑两次必须一样
    const again = runSnippet(injectedCode)
    if (again.error || again.lines.join('\n') !== run.lines.join('\n')) continue

    const reason = o.kind === 'computed'
      ? `它是这段里的 computed（派生值，得顺着依赖算一遍）`
      : o.mutated
        ? `它在片段里被改写过（值要跟着代码走一遍才知道）`
        : `它是 ref 本身 —— 正好和 \`${o.name}.value\` 的差别对上`
    // 文档别处是不是正好写了同一个值？（那就是"沙箱算出来的"和"文档说的"互相印证）
    // 按**行**找：文档常把 log 写在回调里（`watchEffect(() => console.log(x)) // true`），
    // 那种行严格匹配 `console.log(x) // v` 是匹配不到的，但结论一样可信。
    const corroborated = code.split('\n').some((line) => {
      if (!line.includes(`console.log(${o.expr})`)) return false
      const m = line.match(/\/\/\s*(.+?)\s*$/)
      return !!m && m[1] === value
    })
    viable.push({
      ...o,
      injectedCode,
      lines: run.lines,
      baseLines: base.lines.length,
      value,
      reason,
      corroborated,
      provenance: corroborated ? 'sandbox-injected+doc-corroborated' : 'sandbox-injected',
    })
  }
  if (!viable.length) return null
  // 文档自己写着同一个值的**优先**（那是"沙箱算的"和"文档说的"互相印证，比只有一边强）
  return viable.find((v) => v.corroborated) || viable[0]
}

/**
 * 补跑题的干扰项。核心那一对是响应式的第一课：
 *   `count.value` 打出 `0`，而 `count` 打出 `{ value: 0 }` —— 互为干扰项。
 * 再补上数值 ±1 / 取负、布尔取反、同片段里另一个字符串字面量。
 * 凑不出 2 个选项就不出这道题（宁可不做）。
 */
function injectedOptions(obs, code) {
  const truth = obs.value
  const out = []
  const push = (v) => {
    const s = String(v)
    if (!s || s === truth || out.includes(s)) return
    out.push(s)
  }
  // ① ref 与 .value 的形态互扰
  if (obs.form === 'value' && isPredictable(truth)) push(`{ value: ${truth} }`)
  const refish = truth.match(/^\{\s*value:\s*(.+?)\s*\}$/)
  if (refish) push(refish[1])
  // ② 常规干扰项（数值 ±1 / 取负、布尔取反…）
  for (const d of distractors(truth)) push(d)
  // ③ 同片段里另一个字符串字面量（"打印的到底是哪一个"）
  if (!/^-?\d/.test(truth) && !/^(true|false)$/.test(truth)) {
    for (const m of code.matchAll(/'([^'\n]{1,24})'/g)) push(m[1])
  }
  return shuffleSeeded([truth, ...out.slice(0, 2)], seedOf(obs.name + obs.expr))
}

/** 三种模式共用的解析尾巴：**必须**把"期望值是沙箱算的"这件事说清楚 */
function injectedAnalysis(obs, extraNote = '') {
  const note =
    `\n\n⚠️ 期望输出**不是文档注释给的**：官方文档只给了这段代码，没有写打印结果。` +
    `期望值是把代码在**本站沙箱**（迷你 Vue 运行时，和界面上的「运行」是同一份）里真跑一遍算出来的 —— ` +
    `补的语句就是最后一行 \`console.log(${obs.expr})\`，选它是因为${obs.reason}。`
  const corroborated = obs.corroborated
    ? `\n（顺带：文档里另外写着一处 \`// ${obs.value}\`，和跑出来的一致。）`
    : ''
  return `${note}${corroborated}${extraNote}`
}

/** 补跑出来的三种题：预测输出 / 修好它 / 手写 */
function buildInjectedTasks(point, unit, code, opts) {
  // 「补什么」要由文档的 prose 决定 —— 连一句引入文字都没有的片段，不补。
  const context = String(point.extra?.context || '').replace(/\s+/g, ' ').trim()
  if (!context) return null
  const obs = injectedObservation(code, context)
  if (!obs) return null
  const out = []
  const base = {
    chapter: unit.chapter || unit.doc_title || '',
    tags: (unit.tags || []).slice(0, 6),
    source: { url: unit.url || '', heading: unit.heading || '', quote: '' },
    provenance: obs.provenance,
    injected: { expr: obs.expr, form: obs.form },
  }
  const mkId = (suffix) => `${point.id}-${suffix}`.replace(/[^A-Za-z0-9_-]/g, '-')

  // ① 预测输出：代码原样 + 补的那一句；判据是"真跑一遍的输出"
  const options = injectedOptions(obs, code)
  if (options.length >= 2 && options.includes(obs.value)) {
    out.push({
      ...base,
      id: mkId('predict-inj'),
      type: 'code',
      mode: 'predict',
      stem:
        `这段代码来自官方文档（${unit.heading}）。为了让你看清结果，**最后一行 \`console.log(${obs.expr})\` 是本站补上去的**` +
        `（文档原文没有这一句）—— 它跑出来会打印什么？`,
      lang: 'js',
      code: obs.injectedCode,
      options: options.map((v, k) => ({ key: lettersFor(options.length)[k], text: v })),
      answer: [lettersFor(options.length)[options.indexOf(obs.value)]],
      run: { expect: obs.lines },
      analysis: `这段代码跑一遍，完整输出是：\n${obs.lines.join('\n')}\n` + injectedAnalysis(obs),
    })
  }

  // ② 修好它：改**原文**，再把观测那一句补回去（这样改动永远不会落在补的那行上）
  for (const cand of mutations(code, 'js')) {
    if (cand.pair === 'drop-await') continue
    const mutated = `${cand.code}\nconsole.log(${obs.expr})`
    const after = runSnippet(mutated)
    if (after.error) continue                                        // 一跑就炸的不适合让人慢慢改
    if (after.lines.join('\n') === obs.lines.join('\n')) continue    // 改了跟没改一样
    out.push({
      ...base,
      id: mkId('fix-inj'),
      type: 'code',
      mode: 'fix',
      stem:
        `下面这段代码**跑出来的结果和官方文档不一致**（也可能一跑就报错）。改好它，让它打印出判定条上的期望输出：\n` +
        `（\`console.log(${obs.expr})\` 是本站为了让你看清结果补上的，文档原文没有这一句）`,
      lang: 'js',
      code: mutated,
      run: { expect: obs.lines },
      analysis: `文档里这段代码的输出是：\n${obs.lines.join('\n')}\n\n改动提示：${PAIR_NOTES[cand.pair] || ''}` + injectedAnalysis(obs),
      _origin: { pair: cand.pair },
    })
    break
  }

  // ③ 手写：只在"原片段本来不打印任何东西"时出（否则要求用户连原文的输出一起重现，不公平）
  if (obs.baseLines === 0) {
    out.push({
      ...base,
      id: mkId('write-inj'),
      type: 'code',
      mode: 'write',
      stem:
        `官方文档（${unit.heading}）里讲的是：${clipSentence(context) || '这一节的那个写法。'}\n` +
        `**不看原文，自己把它写出来**，让它打印出判定条上的期望输出：`,
      lang: 'js',
      code: '// 在这里写：写完按「运行」，输出对上了再提交\n',
      run: { expect: obs.lines },
      analysis:
        `**参考实现**（官方文档原文，另加一句为了看清结果补上的 \`console.log(${obs.expr})\`）：\n` +
        `\`\`\`js\n${obs.injectedCode}\n\`\`\`\n` +
        `期望输出就是上面这段跑出来的：\n${obs.lines.join('\n')}` + injectedAnalysis(obs),
      _origin: { pair: 'write-injected' },
    })
  }

  return out.length ? out : null
}

/* ══════════════════════════ 主流程 ══════════════════════════ */

const META = {
  id: 'vue-code-tasks',
  title: 'Vue 官方文档 · 代码题',
  subject: '计算机',
  description:
    '从 Vue 官方文档（src/guide 全量，52 篇）的代码块自动生成的**代码题**（填空 / 找错行 / 预测输出 / 修好它），每题都带原文出处。' +
    '沙箱里跑的是本站手写的迷你运行时（ref/reactive/computed 等的行为对齐文档示例），不是 Vue 本体；' +
    '「预测输出 / 修好它 / 手写」的期望输出有两种来源，**每题解析里都写明是哪一种**：' +
    '① 官方文档自己写好的注释（`console.log(x) // 值`）；' +
    '② 文档没写结果时，脚本补一句 `console.log(…)`、再用**同一份沙箱运行时**真跑一遍算出来的 —— ' +
    '只收原始类型或 ref 的 `{ value: x }` 形态（对象/数组/Map 的打印形态是本站约定，推不出来的一律不出题），' +
    '且答案必须靠 computed 派生或跟着代码里的改写才能得到。' +
    '版权：Vue 3 官方文档，版权归 Yuxi (Evan) You 与 Vue 文档贡献者所有。许可：CC BY 4.0（https://creativecommons.org/licenses/by/4.0/）。' +
    '已修改：由脚本切分为代码题、挖空/改动若干处，题目与解析为衍生内容。',
  source: 'vuejs/docs · src/guide（52 篇，经 docs_to_bank.py 递归切好的知识单元）',
  license: 'CC BY 4.0（https://creativecommons.org/licenses/by/4.0/）',
  attribution: 'vuejs/docs：Vue 3 官方文档，版权归 Yuxi (Evan) You 与 Vue 文档贡献者所有',
  modified: '是（代码块 → 填空题 / 找错行 / 预测输出 / 修好它 / 手写）',
}

export function buildBank(units, { log = () => {} } = {}) {
  const questions = []
  const skipped = new Map()
  const note = (reason) => skipped.set(reason, (skipped.get(reason) || 0) + 1)
  const stats = { fill: 0, spot: 0, predict: 0, fix: 0, write: 0 }

  let serial = 0
  for (const unit of units) {
    const points = (unit.points || []).filter((p) => p.kind === 'code')
    for (const point of points) {
      const rawLang = normLang(point.extra?.lang)
      let code = String(point.text || '').replace(/\r\n?/g, '\n').trim()
      if (!code) continue
      if (rawLang === 'diff') {
        note('diff 片段不是可运行代码')
        continue
      }
      if (code.length < 40) {
        note('片段太短')
        continue
      }
      if (code.length > 1600) {
        note('片段太长（不适合做成一道题）')
        continue
      }
      // 纯 `<script setup>` 管道块不是教学内容（和 docs_to_bank 一个判据）
      if (code.startsWith('<script') && !code.includes('<template')) {
        // 但它本身是不错的"填空"素材：把 import 去掉当 JS 用
        const inner = code.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')
        if (inner.trim().length < 40) {
          note('只有 import 的管道块')
          continue
        }
        code = inner.trim()
      }

      const isJsLike = rawLang === 'js' || (!code.includes('<') && !code.includes('</'))
      let lang = isJsLike ? 'js' : rawLang === 'vue' ? 'vue-html' : rawLang
      if (isJsLike) {
        const stripped = stripVueImports(code)
        code = stripped.code.trim()
        if (!code) {
          note('只剩 import')
          continue
        }
      }
      if (lang === 'vue' && !code.includes('<')) lang = 'js'

      const opts = { lang }
      const made = []

      if (lang === 'js') {
        const predicts = buildPredictTask(point, unit, code, opts)
        if (predicts) made.push(...predicts)
      }
      if (lang === 'js') {
        const fix = buildFixTask(point, unit, code, opts)
        if (fix) made.push(fix)
        const write = buildWriteTask(point, unit, code, opts)
        if (write) made.push(write)
      }
      // 文档没给注释 → 用"补一句 console.log 再跑"再争取一次。
      // 只在这段还没出过 predict/fix/write 时跑：文档写明了结果的，以文档为准（更强）。
      if (lang === 'js' && !made.some((t) => ['predict', 'fix', 'write'].includes(t.mode))) {
        const injected = buildInjectedTasks(point, unit, code, opts)
        if (injected) made.push(...injected)
      }
      const spot = buildSpotTask(point, unit, code, opts)
      if (spot) made.push(spot)
      const fill = buildFillTask(point, unit, code, opts)
      if (fill) made.push(fill)

      if (!made.length) {
        note('这段里没有可出题的素材')
        continue
      }
      for (const task of made) {
        serial += 1
        task.no = serial
        // 上一题的行号（找错行）不能因为删掉 import 而错位 —— 这里统一重算
        if (task.mode === 'spot') {
          const line = Number(task.answer[0])
          const lines = task.code.split('\n')
          if (line < 1 || line > lines.length) continue
          // 改动的那一行确实存在且非空，才收下
          if (!lines[line - 1] || !lines[line - 1].trim()) continue
        }
        stats[task.mode] += 1
        questions.push(task)
      }
    }
  }
  log(
    `生成 ${questions.length} 道代码题：填空 ${stats.fill} / 找错行 ${stats.spot} / ` +
      `预测输出 ${stats.predict} / 修好它 ${stats.fix} / 手写 ${stats.write}`,
  )
  return { questions, skipped, stats }
}

/** 去掉只给工具看的字段（`_origin` 不进题库） */
function cleanForBank(q) {
  const { _origin, ...rest } = q
  return rest
}

/* ══════════════════════════ 自检 ══════════════════════════ */

export function selftest() {
  let pass = 0
  let failed = 0
  const ok = (cond, label, extra = '') => {
    if (cond) {
      pass++
      console.log(`  ✓ ${label}`)
    } else {
      failed++
      console.log(`  ✗ ${label}${extra ? `  →  ${extra}` : ''}`)
    }
  }
  const eq = (a, b, label) => ok(a === b, label, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)

  console.log('\n═══ 出题工具自检 ═══')

  // 运行器
  const r = runSnippet('const c = ref(0)\nc.value++\nconsole.log(c.value)')
  eq(r.lines.join(''), '1', '运行器能跑通 ref 片段')
  ok(runSnippet('throw new Error("x")').error.includes('x'), '运行器能报错')

  // 空缺词条：优先单元 tag、同一词条全部挖掉
  eq(countOccurrences('const a = ref(0)\nref(1)', 'ref'), 2, '数出现次数')
  eq(blankToken('const a = ref(0)', 'ref'), 'const a = ___(0)', '挖空')
  const picked = pickBlankTokens('const c = ref(0)\nconsole.log(c.value)', ['ref'])
  eq(picked.join(','), 'ref', '优先挖这个单元的 tag')

  // 找错行：改动必须能被察觉
  const unit = {
    id: 'u1',
    heading: '测试小节',
    url: 'https://vuejs.org/x',
    tags: ['ref'],
    chapter: 'ch1',
    points: [],
  }
  const changeable = 'const count = ref(0)\nconsole.log(count.value)'
  const spot = buildSpotTask({ id: 'p1', extra: {} }, unit, changeable, { lang: 'js' })
  ok(!!spot, '能生成找错行题')
  eq(spot.answer[0], '1', '找错行指向被改动的那一行')
  ok(!runSnippet(changeable).error, '原片段本来能跑')
  const after = runSnippet(spot.code)
  ok(!after.error, '改动后的片段仍然能跑（否则不适合让人"找出来"）')
  ok(
    after.lines.join() !== runSnippet(changeable).lines.join(),
    '★ 改动确实改变了输出（察觉不到的改动不成题）',
  )

  // 预测输出：文档注释对得上才出题
  const docCode = 'const count = ref(0)\nconsole.log(count) // { value: 0 }\nconsole.log(count.value) // 0'
  const preds = buildPredictTask({ id: 'p2', extra: {} }, unit, docCode, { lang: 'js' })
  ok(Array.isArray(preds) && preds.length === 2, '每个带注释的 console.log 出一道预测题')
  eq(preds[0].run.expect.join('|'), '{ value: 0 }|0', '★ 期望输出就是把代码真跑一遍的结果')
  ok(preds[0].options.length >= 2, '有干扰项')
  ok(
    preds[0].options.some((o) => o.text === '{ value: 0 }' && preds[0].answer[0] === o.key),
    '正确答案在选项里且 key 对得上',
  )
  const badDoc = 'const count = ref(0)\nconsole.log(count.value) // 999'
  eq(buildPredictTask({ id: 'p3', extra: {} }, unit, badDoc, { lang: 'js' }), null, '★ 注释和实际输出对不上 → 不出题')
  eq(docExpectations('console.log(1)\n// 注释在下一行不算').length, 0, '注释必须在同一行才算期望值')

  // 修好它
  const fix = buildFixTask({ id: 'p4', extra: {} }, unit, docCode, { lang: 'js' })
  ok(!!fix, '能生成修好它题')
  ok(runSnippet(fix.code).lines.join('|') !== fix.run.expect.join('|'), '改动后的输出和期望不一样')
  eq(fix.run.expect.join('|'), '{ value: 0 }|0', '期望输出是文档证明过的')

  // 手写：白纸一张 + 期望输出（判据是跑出来对不对）
  const write = buildWriteTask(
    { id: 'p5', extra: { context: '文档说：count 是一个响应式引用。' } },
    unit,
    docCode,
    { lang: 'js' },
  )
  ok(!!write, '能生成手写题')
  eq(write.mode, 'write', '模式是 write')
  eq(write.run.expect.join('|'), '{ value: 0 }|0', '★ 手写题的期望输出也是文档证明过的')
  ok(!/\bref\(/.test(write.code), '★ 起始代码里**不能**出现答案（不然手写就成了抄写）')
  ok(write.stem.includes('响应式引用'), '题面用文档的说法当要求')
  ok(write.analysis.includes('const count = ref(0)'), '解析里放参考实现（写完能对照）')
  eq(buildWriteTask({ id: 'p6', extra: {} }, unit, 'console.log(1)', { lang: 'js' }), null, '没有文档注释就不出手写题')

  // 干扰项
  ok(distractors('true').includes('false'), '布尔干扰项')
  ok(distractors('{ value: 0 }').includes('0'), 'ref 打印形态的干扰项')

  // ── 补一句 console.log 再跑（扩 predict/fix/write 语料）──────────────────
  // ① 值可不可预测：对象/数组/Map 的打印形态是本站格式化器的约定，不算"推得出来"
  eq(isPredictable('0'), true, '可预测：数字')
  eq(isPredictable('{ value: 0 }'), true, '★ 可预测：ref 的 { value: x } 形态（文档自己就这么写）')
  eq(isPredictable('Vue.js'), true, '可预测：裸字符串')
  eq(isPredictable('{ count: 0 }'), false, '★ 对象形态推不出来（是我们的格式化器，不是 Vue）')
  eq(isPredictable('[1, 2]'), false, '★ 数组形态推不出来')
  eq(isPredictable('Map(1)'), false, '★ Map(1) 是格式化器约定')
  eq(isPredictable('undefined'), false, '★ undefined 推不出来（问了等于问沙箱实现）')
  eq(isPredictable('{ value: undefined }'), false, '★ ref 里是 undefined 也不出题')

  // ② "被改写"必须排除声明本身（踩过：不排除的话每个 ref 都被当成被改写）
  eq(mutatedAfterDecl('const c = ref(0)', 'c'), false, '★ 声明本身不算"被改写"')
  eq(mutatedAfterDecl('const c = ref(0)\nc.value++', 'c'), true, 'c.value++ 算被改写')
  eq(mutatedAfterDecl('const s = reactive({ n: 1 })\ns.n = 2', 's'), true, 'reactive 属性改写算被改写')
  eq(mutatedAfterDecl('const l = ref([])\nl.value.push(1)', 'l'), true, '数组 push 算被改写')

  // ③ 观测闸门：补的这句必须**只是多一行**，且原输出一字不差
  const addCode = 'const c = ref(0)\nc.value = 2\nconsole.log(c.value)'
  const addObs = injectedObservation(addCode, '文档说：改一下 count 再看它的值。')
  ok(!!addObs, '能补出观测')
  eq(addObs.baseLines, 1, '原片段本来打印 1 行')
  eq(addObs.lines.length, 2, '★ 补的那句只是多一行（不是改行为）')
  eq(addObs.lines[0], '2', '原有输出一字不差')
  eq(addObs.value, '2', '期望值就是补那句跑出来的')
  eq(addObs.injectedCode.split('\n').pop(), 'console.log(c.value)', '补的语句进了题面代码')

  // ④ 只把字面量读回来的，走 ref 形态（"log(c) 还是 log(c.value)"正是响应式的第一课）
  const litObs = injectedObservation('const isActive = ref(true)', '文档说：isActive 是个响应式引用。')
  ok(!!litObs && litObs.expr === 'isActive' && litObs.form === 'refobj',
    '★ 字面量只读得回来时走 ref 形态，不拿 .value 原样复述')
  eq(litObs.value, '{ value: true }', '值就是沙箱跑出来的 ref 形态')

  // ⑤ 推不出来的值 → 不出题（宁可少，也不要出"猜格式化器"的题）
  eq(injectedObservation('const s = reactive({ count: 0 })', '文档说：这是响应式对象。'), null,
    '★ reactive 对象的打印形态推不出来 → 不出题')
  eq(injectedObservation('const props = defineProps(["x"])\nconst c = ref(props.x)', '文档说：c 是 props 的初始值。'), null,
    '★ 值是 undefined → 不出题')
  // 判据是运行输出的题，代码里不能有 document/window —— 判据要和 check_bank.mjs 一致
  eq(injectedObservation('const n = ref(0)\ndocument.body.innerHTML = String(n.value)', '文档说：把 count 渲染进页面。'), null,
    '★ 引用 document/window 的片段判不了 → 不出运行输出题（同 check_bank 的 notRunnable）')

  // ⑥ 文档自己写了同一个值时，优先它，并标成"互相印证"
  const corrCode = 'const count = ref(0)\nconst isEven = computed(() => count.value % 2 === 0)\n'
    + 'watchEffect(() => console.log(isEven.value)) // true\ncount.value = 4'
  const corrObs = injectedObservation(corrCode, '文档说：computed 的值没变就不会触发副作用。')
  ok(!!corrObs && corrObs.expr === 'isEven.value', '★ 文档写了结果的那个观测优先（不是先声明的那个）')
  eq(corrObs.provenance, 'sandbox-injected+doc-corroborated', '标成"沙箱算的 + 文档说的"互相印证')

  // ⑦ 出题：解析里**必须**标注期望值来源；手写题不给答案
  const injPoint = { id: 'p-inj', extra: { context: '文档说：count 是响应式引用，改完再看它的值。' } }
  const injTasks = buildInjectedTasks(injPoint, unit, 'const count = ref(0)\ncount.value = 3', { lang: 'js' })
  ok(Array.isArray(injTasks) && injTasks.length >= 1, '能生成补跑题')
  const pInj = injTasks.find((t) => t.mode === 'predict')
  ok(!!pInj, '有预测输出题')
  eq(pInj.run.expect.join('|'), '3', '★ 期望值 = 真跑一遍的结果')
  ok(pInj.options.some((o) => o.text === '3' && pInj.answer[0] === o.key), '正确答案在选项里、key 对得上')
  ok(pInj.options.some((o) => o.text === '{ value: 3 }'), '★ 干扰项里有 ref 形态（考的就是 .value 的差别）')
  ok(pInj.code.includes('console.log(count.value)'), '题面代码里带着补的那一句')
  ok(pInj.analysis.includes('不是文档注释给的'), '★ 解析里必须写明期望值不是文档注释给的')
  eq(pInj.provenance, 'sandbox-injected', '结构化标注供复核')
  const wInj = injTasks.find((t) => t.mode === 'write')
  ok(!!wInj && !/\bref\(/.test(wInj.code), '★ 手写题的起始代码里不能出现答案')
  const fInj = injTasks.find((t) => t.mode === 'fix')
  if (fInj) {
    ok(!runSnippet(fInj.code).error, '修好它的改动后仍能跑（不适合让人慢慢改的不出）')
    ok(runSnippet(fInj.code).lines.join('|') !== fInj.run.expect.join('|'), '改动后输出确实和期望不一样')
  }
  // 没有 prose 不补（补什么要由文档的话决定）；值推不出来也不出
  eq(buildInjectedTasks({ id: 'p-np', extra: {} }, unit, 'const count = ref(0)', { lang: 'js' }), null,
    '★ 没有文档 prose 就不补这一句')
  eq(buildInjectedTasks({ id: 'p-rx', extra: { context: '文档说：这是响应式对象。' } }, unit,
    'const s = reactive({ count: 0 })', { lang: 'js' }), null, '★ 值推不出来就不出题')

  console.log(`\n${failed ? '❌' : '✅'} 自检：${pass} 通过 / ${failed} 失败`)
  return failed === 0
}

/* ══════════════════════════ 命令行 ══════════════════════════ */

function parseArgs(argv) {
  // 默认吃**整本 guide** 切出来的单元（52 篇 / 370 单元）——
  // 语料越大，"填空/找错行"的覆盖面越广；只切 essentials 也能跑，但会少 2/3 的素材。
  // 生成命令见文件头的用法说明。
  const out = {
    units: '.tmp/docs-bank/vue-guide.units.json',
    out: 'quiz/frontend/src/banks/big/vue-code-tasks.json',
    selftest: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--selftest') out.selftest = true
    else if (a === '--units') out.units = argv[++i]
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--help' || a === '-h') {
      console.log('用法：node quiz/tools/units_to_tasks.mjs [--selftest] [--units <units.json>] [--out <bank.json>]')
      process.exit(0)
    }
  }
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.selftest) {
    process.exit(selftest() ? 0 : 1)
  }
  if (!fs.existsSync(args.units)) {
    console.error(`找不到知识单元文件：${args.units}`)
    console.error('先在仓库根目录跑：')
    console.error('  .\\.venv-renwu\\Scripts\\python.exe quiz\\tools\\docs_to_bank.py --source github:vuejs/docs@main:src/guide/essentials --name vue-essentials --stage units')
    process.exit(2)
  }
  const units = JSON.parse(fs.readFileSync(args.units, 'utf8'))
  const { questions, skipped } = buildBank(units, { log: (m) => console.log(m) })

  const bank = {
    meta: {
      ...META,
      total: questions.length,
      generatedAt: new Date().toISOString().slice(0, 19),
      generator: 'quiz/tools/units_to_tasks.mjs',
    },
    questions: questions.map(cleanForBank),
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true })
  fs.writeFileSync(args.out, `${JSON.stringify(bank, null, 2)}\n`, 'utf8')

  // 抽查：库里每道"预测输出"的期望值都必须能被重新跑出来（防手改、防运行时漂移）
  let verified = 0
  let broken = 0
  for (const q of bank.questions) {
    if (!q.run) continue
    const run = runSnippet(q.code)
    const same = !run.error && run.lines.join('\n') === q.run.expect.join('\n')
    if (q.mode === 'predict') {
      // 预测题：期望输出 = 这段代码（原样）的输出
      if (same) verified++
      else broken++
    }
  }
  console.log(`写出 ${args.out}（${questions.length} 道）`)
  if (skipped.size) {
    console.log('跳过的原因：')
    ;[...skipped.entries()].sort((a, b) => b[1] - a[1]).forEach(([r, n]) => console.log(`  ${n} 段：${r}`))
  }
  console.log(`复核预测题的期望输出：${verified} 道对得上${broken ? `，${broken} 道对不上（这是 bug！）` : ''}`)
  process.exit(broken ? 1 : 0)
}

if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/') || process.argv[1]?.endsWith('units_to_tasks.mjs')) {
  main()
}
