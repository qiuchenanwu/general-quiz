#!/usr/bin/env node
/**
 * units_to_parsons.mjs —— 从**干净的官方文档 units** 生成「拖拽排序」题（Parsons），
 * 追加进一份已有的代码题库。
 * ============================================================================
 * 为什么另开一个工具、而不是从已上架的代码题库里生成：
 *   已上架那些代码题的 `code` 是**故意改过的** ——
 *   `fill` 挖了空、`spot` 改了一行、`fix` 是坏的、`write` 是空骨架。
 *   拿它们去排序，等于让学生把"那一行错的"排进"正确顺序"里（教错）。
 *   干净的材料只有一处：出题管线用的 **units**（来自官方文档 markdown，不是 OCR）。
 *
 * 判据全在 `core/parsons.js`（`buildParsonsTask` / `orderableUnits`）——
 * 同一份实现，前端兜底、扫描件题库、这里三处共用（坑 58）。
 *
 * 用法（要先跑过出题管线的 units 阶段）：
 *   cd quiz\frontend
 *   node --import ./tests/alias-loader.mjs ..\tools\units_to_parsons.mjs `
 *     --units ..\..\.tmp\docs-bank\vue-essentials.units.json ..\..\.tmp\docs-bank\vue-guide.units.json `
 *     --bank src\banks\big\vue-code-tasks.json --limit 80 --langs js,vue --max-blocks 7
 *
 * 产物写回 `--bank`（追加）：新题的 id 是 `parsons-<n>`，`no` 接在现有题后面 ——
 * **不重排已有题目**，所以老用户的作答进度不会错位。
 */

import fs from 'node:fs'
import path from 'node:path'

import { buildParsonsTask } from '../frontend/src/core/parsons.js'

function parseArgs(argv) {
  const out = { units: [], langs: ['js', 'vue'], maxBlocks: 7, limit: 0, dryRun: false }
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dry-run') {
      out.dryRun = true
      continue
    }
    const key = a.replace(/^--/, '')
    if (key === 'units') {
      // 吃掉后面所有不是 -- 开头的参数
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) out.units.push(argv[++i])
      continue
    }
    const val = argv[++i]
    if (key === 'langs') out.langs = String(val).split(',').map((s) => s.trim()).filter(Boolean)
    else if (key === 'maxBlocks') out.maxBlocks = Number(val) || 7
    else if (key === 'limit') out.limit = Number(val) || 0
    else out[key] = val
  }
  return out
}

const args = parseArgs(process.argv)
if (!args.units.length || !args.bank) {
  console.error('用法：node units_to_parsons.mjs --units <units.json…> --bank <题库.json> [--limit N] [--langs js,vue] [--max-blocks 7] [--dry-run]')
  process.exit(2)
}

const byLang = {}
const picked = []
const seenCode = new Set()

for (const rel of args.units) {
  const p = path.resolve(rel)
  if (!fs.existsSync(p)) {
    console.error(`  跳过（不存在）：${rel}`)
    continue
  }
  const units = JSON.parse(fs.readFileSync(p, 'utf8'))
  for (const unit of units) {
    for (const point of unit.points || []) {
      if (point.kind !== 'code') continue
      const lang = String(point.extra?.lang || '').toLowerCase()
      if (args.langs.length && !args.langs.includes(lang)) continue
      const code = String(point.text || '').replace(/\r\n?/g, '\n').trim()
      if (!code || code.length > 1200) continue
      if (seenCode.has(code)) continue
      const task = buildParsonsTask(code, { maxBlocks: args.maxBlocks })
      if (!task) continue
      seenCode.add(code)
      byLang[lang] = (byLang[lang] || 0) + 1
      picked.push({ unit, point, task, lang, code })
    }
  }
}

console.log(`候选：${picked.length} 道（语言分布 ${JSON.stringify(byLang)}）`)
const chosen = args.limit > 0 ? picked.slice(0, args.limit) : picked

// ★ 抽查样本（坑 101 的教训：自动生成的东西必须**看例子**，数字好看不代表对）
console.log('\n抽查 6 个样本：')
for (const c of chosen.slice(0, 6)) {
  console.log(`  · [${c.lang}] ${c.task.blocks.length} 块（${c.unit.heading}）`)
  console.log(`      首块：${JSON.stringify(c.task.blocks[0].text.slice(0, 60))}`)
}

if (args.dryRun) {
  console.log('\n（--dry-run：没有写文件）')
  process.exit(0)
}

const bankPath = path.resolve(args.bank)
const bank = JSON.parse(fs.readFileSync(bankPath, 'utf8'))
const before = bank.questions.length
const baseNo = before
chosen.forEach((c, i) => {
  const u = c.unit
  bank.questions.push({
    id: `parsons-${i + 1}`,
    no: baseNo + i + 1,
    type: 'code',
    mode: 'order',
    lang: c.lang,
    stem: `${u.heading || '官方文档'}这一段：把下面 ${c.task.blocks.length} 块拖回原文的顺序。`,
    code: c.task.code,
    blocks: c.task.blocks,
    answer: c.task.answer,
    analysis: `按官方文档原文的顺序排。原文这一段是：\n\n\`\`\`\n${c.task.code}\n\`\`\``,
    chapter: u.chapter || u.heading || '',
    tags: (u.tags || []).slice(0, 6),
    source: { url: u.url || '', heading: u.heading || '', quote: '' },
    provenance: 'parsons-from-units',
  })
})
bank.meta.total = bank.questions.length
// 让"第二处数字"跟着走（清单里也存了题量，见 HANDOVER 那条警告）
fs.writeFileSync(bankPath, `${JSON.stringify(bank, null, 2)}\n`, 'utf8')
console.log(`\n${path.basename(bankPath)}：${before} → ${bank.questions.length} 道（新增拖拽排序 ${chosen.length} 道）`)
console.log('⚠️ 记得重跑 `node quiz/tools/make_bank_index.mjs`（清单里也存了题量）')
