/**
 * check_sfc.mjs —— 不依赖 esbuild / vite 的静态体检。
 *
 * 为什么需要它：沙箱里 esbuild 拉起子进程会被拒（spawn EPERM），所以
 * `vite build` 跑不起来。这个脚本用纯 Node（@vue/compiler-sfc + vm）把
 * 语法错误、模板编译错误、图标名写错之类的问题先揪出来，
 * 这样真正跑构建时一次就能过。
 *
 * 用法： node ../tools/check_sfc.mjs        （在 frontend/ 下执行）
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import * as ElIcons from '@element-plus/icons-vue'

/** 不是组件、也不是图标，只是恰好写成 PascalCase 的字符串（键盘键名等） */
const NOT_A_COMPONENT = new Set([
  'Escape',
  'Enter',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Backspace',
  'Tab',
  'Shift',
  // 语言名当选项标签用（'Java' / 'JS / Vue'）：是给人看的文字，不是图标名
  'Java',
])

const SRC = path.resolve('src')
const ICONS = new Set(Object.keys(ElIcons))

/** 本地组件名（模板里 <OptionItem/> 这种，不需要是图标） */
const LOCAL_COMPONENTS = new Set([
  'OptionItem',
  'QuestionCard',
  'CodeRunner',
  'AnalysisBody',
  'AiCoach',
  'AnswerSheet',
  'ResultPanel',
  'SettingsPanel',
  'NoteEditor',
  'BankTools',
  'AppBackground',
  'MusicPlayer',
  'ElevateDialog',
  'DocReview',
  'CodeEditor',
  // 演武场那条线（随手跑一段代码）
  'SnippetRunner',
  'ForgeView',
  // 演武场的「让 AI 检查」（任务回路的最后半步）
  'AiReview',
  'LessonView',
  // 路由级视图（GraphView 是 /graph 的页面组件，不走标签引用，
  // 但登记在这里，将来谁在模板里写 <GraphView/> 也不会误报）
  'GraphView',
  'DiagramView',
  'AchievementPage',
  'DiagnoseView',
  'RouterLink',
  'RouterView',
  'Transition',
  'Component',
  'Suspense',
  'Teleport',
  'KeepAlive',
])

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const files = walk(SRC)
let errors = 0
let warnings = 0

const fail = (file, msg) => {
  errors++
  console.error(`  ✗ ${path.relative(process.cwd(), file)}\n    ${msg}`)
}
const warn = (file, msg) => {
  warnings++
  console.warn(`  ! ${path.relative(process.cwd(), file)}\n    ${msg}`)
}

/* ------------------------- 1. 普通 JS：语法检查 ------------------------- */
console.log('▶ JS 语法检查')
const jsFiles = files.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
// 用 vm.SourceTextModule 按 ESM 规则只解析、不执行；
// 需要 `node --experimental-vm-modules`，没有就跳过（不影响其它检查）。
const canModule = typeof vm.SourceTextModule === 'function'
if (!canModule) {
  console.log('  (跳过：需要 node --experimental-vm-modules 才能按 ESM 解析)')
} else {
  for (const f of jsFiles) {
    try {
      new vm.SourceTextModule(fs.readFileSync(f, 'utf8'), { identifier: f })
    } catch (e) {
      fail(f, `语法错误：${e.message}`)
    }
  }
  console.log(`  检查了 ${jsFiles.length} 个 .js 文件`)
}

/* ------------------------- 2. Vue SFC：解析+编译 ------------------------- */
console.log('▶ SFC 解析与模板编译')
const vueFiles = files.filter((f) => f.endsWith('.vue'))
const iconRefs = new Map() // iconName -> [files]

for (const f of vueFiles) {
  const source = fs.readFileSync(f, 'utf8')
  const rel = path.relative(process.cwd(), f)

  // ★ 模板里**不能写 markdown 星号** —— 模板不是 markdown，`**粗体**` 会原样显示成星号。
  //   踩过：我把 `**只收 .pdf 和 .json**（站主定的）` 写进拖放区文案，
  //   站主截图回来说"这不是 md 文件，你在做什么鬼事"。
  //   只查模板段、且剥掉 `<!-- -->` 注释（注释里写 markdown 无所谓）。
  //   注意：`src/core/quiz.js` 里导出 Markdown 报告用的星号是**故意**的，不在此列。
  const tpl = source.match(/<template>([\s\S]*)<\/template>/)
  if (tpl) {
    const body = tpl[1].replace(/<!--[\s\S]*?-->/g, '')
    const marks = [...body.matchAll(/\*\*[^*\n]{1,60}\*\*/g)]
    if (marks.length) {
      fail(f, `模板里出现了 markdown 星号（会原样显示）：${marks.slice(0, 3).map((m) => m[0]).join(' / ')}`)
    }
    // 文案里不该出现"站主"这种内部称呼
    const inner = [...body.matchAll(/站主/g)]
    if (inner.length) {
      fail(f, '模板文案里出现了内部称呼"站主"（用户看到会莫名其妙）')
    }
  }

  const { descriptor, errors: parseErrors } = parse(source, { filename: f })
  if (parseErrors.length) {
    parseErrors.forEach((e) => fail(f, `SFC 解析失败：${e.message}`))
    continue
  }

  // <script setup> 编译
  let bindings = null
  try {
    const compiled = compileScript(descriptor, { id: rel })
    bindings = compiled.bindings
  } catch (e) {
    fail(f, `compileScript 失败：${e.message}`)
  }

  // 模板编译
  if (descriptor.template) {
    const res = compileTemplate({
      source: descriptor.template.content,
      filename: f,
      id: rel,
      compilerOptions: { bindingMetadata: bindings || undefined },
    })
    if (res.errors?.length) {
      res.errors.forEach((e) => {
        const msg = typeof e === 'string' ? e : e.message
        fail(f, `模板编译错误：${msg}`)
      })
    }
  }

  // 图标名收集在下面「组件与图标名核对」里统一做
}
console.log(`  编译了 ${vueFiles.length} 个 .vue 文件`)

/* ------------------------- 3. 图标 / 组件名核对 ------------------------- */
console.log('▶ 组件与图标名核对')
const quotedNames = new Map() // 'Xxx' -> Set(files)
const tagNames = new Map() // <Xxx -> Set(files)
for (const f of vueFiles) {
  const source = fs.readFileSync(f, 'utf8')
  const rel = path.relative(process.cwd(), f)
  const add = (map, n) => {
    if (!map.has(n)) map.set(n, new Set())
    map.get(n).add(rel)
  }
  // 引号里的 PascalCase：icon: 'Sort' / :is="'Moon'" / a ? 'Star' : 'StarFilled'
  for (const m of source.matchAll(/'([A-Z][A-Za-z0-9]{2,})'/g)) add(quotedNames, m[1])
  // 模板里以大写字母开头的标签
  for (const m of source.matchAll(/<([A-Z][A-Za-z0-9]*)/g)) add(tagNames, m[1])
}

let checked = 0
for (const [name, where] of quotedNames) {
  checked++
  if (LOCAL_COMPONENTS.has(name) || ICONS.has(name) || NOT_A_COMPONENT.has(name)) continue
  fail([...where][0], `字符串 '${name}' 既不是本地组件也不是 Element Plus 图标（是不是拼错了？）`)
}
for (const [name, where] of tagNames) {
  checked++
  if (LOCAL_COMPONENTS.has(name) || ICONS.has(name)) continue
  fail([...where][0], `组件 <${name}> 未注册（既不是本地组件也不是全局图标）`)
}
console.log(`  核对了 ${checked} 个名字（图标库共 ${ICONS.size} 个图标）`)

/* ------------------------- 4. 汇总 ------------------------- */
console.log('')
if (errors) {
  console.error(`❌ 静态体检失败：${errors} 个错误，${warnings} 个警告`)
  process.exit(1)
}
console.log(`✅ 静态体检通过（${errors} 错误，${warnings} 警告）`)
