#!/usr/bin/env node
/**
 * make_bank_index.mjs —— 给 `src/banks/big/` 里的**大题库**生成清单（`big/index.json`）。
 * ============================================================================
 * 为什么要有这一步（这一层是"懒加载"的配套）：
 *
 *   题库原来是 `import.meta.glob('../banks/*.json', { eager: true })` **全量进主包**——
 *   丢一个 JSON 进 banks/ 就自动上架，很方便；代价是**每个人都得下全部题库**：
 *   2026-10-09 实测主包 1921KB（gzip 550KB），其中题库占 820KB，
 *   而"只想刷毛概的人"根本不需要那 478KB 的 Vue 题库。
 *
 *   于是分两层：
 *     `banks/*.json`     小题库 → 仍然**自动发现 + 打进主包**（方便是第一位的）
 *     `banks/big/*.json` 大题库 → 只打进**独立 chunk**，打开时才下载；
 *                        首页要显示的卡片信息（标题/题量/许可…）从这个清单读
 *
 *   清单是**生成**的，不是手写的 —— 手写就会飘。`--check` 用来在测试里守规矩。
 *
 * 用法：
 *   node quiz/tools/make_bank_index.mjs            # 重新生成 big/index.json
 *   node quiz/tools/make_bank_index.mjs --check     # 只检查（测试用；不一致就退出码 1）
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/** 超过这个体积就不该再进主包了（gzip 后大约是它的 1/3） */
export const BIG_BANK_BYTES = 200 * 1024

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const BANKS = path.join(HERE, '..', 'frontend', 'src', 'banks')
const BIG = path.join(BANKS, 'big')
const INDEX = path.join(BIG, 'index.json')

/** 从题库 JSON 里抽出首页卡片要用的那几个字段（缺了就留空，绝不抛） */
export function cardOf(json, file) {
  const meta = (json && json.meta) || {}
  const questions = Array.isArray(json?.questions) ? json.questions : []
  const counts = meta.counts || questions.reduce((acc, q) => {
    const t = q?.type || 'single'
    acc[t] = (acc[t] || 0) + 1
    return acc
  }, {})
  return {
    id: String(meta.id || file.replace(/\.json$/i, '')),
    file,
    title: String(meta.title || file.replace(/\.json$/i, '')),
    subject: String(meta.subject || ''),
    description: String(meta.description || ''),
    total: Number(meta.total) || questions.length,
    counts,
    license: String(meta.license || ''),
    attribution: String(meta.attribution || ''),
  }
}

export function buildIndex() {
  if (!fs.existsSync(BIG)) return []
  return fs
    .readdirSync(BIG)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .sort()
    .map((file) => {
      const json = JSON.parse(fs.readFileSync(path.join(BIG, file), 'utf8'))
      return cardOf(json, file)
    })
}

/** 守两条规矩：① 大题库必须在 big/ 里；② 小题库不该躺在 big/ 里 */
export function checkLayout() {
  const problems = []
  const rootFiles = fs
    .readdirSync(BANKS)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
  for (const file of rootFiles) {
    const size = fs.statSync(path.join(BANKS, file)).size
    if (size > BIG_BANK_BYTES) {
      problems.push(
        `${file} 有 ${Math.round(size / 1024)}KB（>${BIG_BANK_BYTES / 1024}KB）却在 banks/ 根目录里` +
          ' —— 它会被打进主包。移到 banks/big/ 再跑一次本工具。',
      )
    }
  }
  const bigFiles = fs.existsSync(BIG)
    ? fs.readdirSync(BIG).filter((f) => f.endsWith('.json') && f !== 'index.json')
    : []
  for (const file of bigFiles) {
    const size = fs.statSync(path.join(BIG, file)).size
    if (size <= BIG_BANK_BYTES) {
      problems.push(
        `${file} 只有 ${Math.round(size / 1024)}KB，放在 big/ 里是多余的（小题库直接放 banks/ 就会自动上架）`,
      )
    }
  }
  // 清单和目录必须一一对应（清单是生成的，飘了就是有人改了没重跑）
  if (fs.existsSync(INDEX)) {
    const listed = new Set(JSON.parse(fs.readFileSync(INDEX, 'utf8')).map((c) => c.file))
    for (const f of bigFiles) if (!listed.has(f)) problems.push(`big/index.json 里没有 ${f}（跑一次本工具重新生成）`)
    for (const f of listed) if (!bigFiles.includes(f)) problems.push(`big/index.json 里列的 ${f} 不存在了`)
  } else if (bigFiles.length) {
    problems.push('big/ 里有题库但没有 big/index.json（跑一次本工具生成）')
  }
  return problems
}

function main() {
  const check = process.argv.includes('--check')
  const problems = checkLayout()
  if (check) {
    if (problems.length) {
      console.error('❌ 题库分层有问题：')
      for (const p of problems) console.error(`   · ${p}`)
      process.exit(1)
    }
    console.log('✅ 题库分层 OK（大题库都在 big/，清单与目录一致）')
    return
  }
  if (!fs.existsSync(BIG)) fs.mkdirSync(BIG, { recursive: true })
  const index = buildIndex()
  const body = `${JSON.stringify(index, null, 2)}\n`
  const old = fs.existsSync(INDEX) ? fs.readFileSync(INDEX, 'utf8') : ''
  if (old === body) {
    console.log(`big/index.json 没变化（${index.length} 套大题库）`)
  } else {
    fs.writeFileSync(INDEX, body, 'utf8')
    console.log(`写出 big/index.json：${index.length} 套大题库`)
    for (const c of index) console.log(`  ${c.file} → ${c.title}（${c.total} 题）`)
  }
  if (problems.length) {
    console.warn('⚠️ 还有这些要收拾（不影响本次生成）：')
    for (const p of problems) console.warn(`   · ${p}`)
  }
}

if (process.argv[1] && process.argv[1].endsWith('make_bank_index.mjs')) main()
