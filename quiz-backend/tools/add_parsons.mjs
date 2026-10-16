#!/usr/bin/env node
/**
 * add_parsons.mjs —— 给一份**已经生成好的**题库补上「拖拽排序」题（Parsons）。
 * ============================================================================
 * 为什么要单独一个工具、而不是改出题提示词：
 *   拖拽排序**不需要模型**。判据就是"教材原文的顺序"，所以它是**零额度**的 ——
 *   让模型去"出"这种题纯属浪费（而且它还会出得不如确定性切分准）。
 *   和 `fill` 一样属于"材料里本来就有答案"的那一类。
 *
 * 用的是**和前端同一个实现**：`core/fallback.js` 的 `buildFallbackTasks()`
 * （坑 58：同一判据不要写第二份）。这里只挑出 `mode: 'order'` 的那些。
 *
 * 用法：
 *   node quiz/tools/add_parsons.mjs \
 *     --model .tmp/docmodel.json \
 *     --bank  .tmp/docs-bank/javaweb-ch03-scan.bank.json \
 *     --out   quiz/frontend/src/banks/javaweb-ch03-scan.json \
 *     --title "JavaWeb 第3章 Servlet（扫描件）· 教材题库"
 *
 * ⚠️ `--max 0`：**一道排序题都不加，只把题库按给定标题/说明写到 `--out`**。
 *    什么时候用：这份材料的代码 OCR 认花得太厉害（排序题会把错的写法摆给学生看）——
 *    那就不加代码题，只上架概念题。**扫描件上架时用的就是这个**（见 HANDOVER 第十九批）。
 */

import fs from 'node:fs'
import path from 'node:path'

import { buildFallbackTasks } from '../frontend/src/core/fallback.js'

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '')
    out[k] = argv[i + 1]
  }
  return out
}

const args = parseArgs(process.argv)
if (!args.model || !args.bank || !args.out) {
  console.error('用法：node add_parsons.mjs --model <文档模型.json> --bank <题库.json> --out <输出.json> [--title ...]')
  process.exit(2)
}

const model = JSON.parse(fs.readFileSync(args.model, 'utf8'))
const bank = JSON.parse(fs.readFileSync(args.bank, 'utf8'))

const before = bank.questions.length
let tasks = buildFallbackTasks(model).filter((q) => q.mode === 'order')
if (args.max !== undefined) {
  const max = Number(args.max)
  if (Number.isFinite(max) && max >= 0) tasks = tasks.slice(0, max)
}

// 编号/ id 接在现有题后面（`no` 是全局题号，答题卡和进度都靠它）
tasks.forEach((q, i) => {
  q.id = `scan-order-${i + 1}`
  q.no = before + i + 1
})
bank.questions.push(...tasks)

bank.meta.total = bank.questions.length
if (args.title) bank.meta.title = args.title
bank.meta.description = `${bank.meta.description || ''}${
  bank.meta.description ? ' ' : ''
}另含 ${tasks.length} 道**拖拽排序**题：把教材代码清单的语句拖回原文顺序（判据是教材原文，没有调用模型）。`
bank.meta.generator = 'quiz/tools/docs_to_bank.py + quiz/tools/add_parsons.mjs'

fs.mkdirSync(path.dirname(args.out), { recursive: true })
fs.writeFileSync(args.out, `${JSON.stringify(bank, null, 2)}\n`, 'utf8')

const kinds = bank.questions.reduce((acc, q) => {
  const k = q.type === 'code' ? `code/${q.mode}` : q.type
  acc[k] = (acc[k] || 0) + 1
  return acc
}, {})
console.log(`题库：${before} 道 → ${bank.questions.length} 道（新增拖拽排序 ${tasks.length} 道）`)
console.log(`题型分布：${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(' / ')}`)
console.log(`→ ${args.out}`)
for (const q of tasks) {
  console.log(`  · 第 ${q.no} 题：${q.blocks.length} 块排序（${q.source?.heading || '未标出处'}）`)
}
