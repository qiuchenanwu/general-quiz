/**
 * check_bank.mjs —— 用**前端真实的归一化逻辑**校验一份题库 JSON。
 *
 * 为什么不把这个校验写进 docs_to_bank.py：
 *   这个仓库的规矩是"规则只有一份实现"（`pdf_to_json.py` 之所以被板子**动态加载**，
 *   就是为了让解析规则不出现第二份）。题库能不能被站点吃掉，唯一权威是
 *   前端 `src/core/normalize.js` —— 它会补 id、给判断题补 T/F 选项、
 *   丢掉不认识的字段、并把坏数据收集成 `issues`。
 *   另写一份 Python 版 schema 校验，等于给自己留一个"两边不一致"的坑：
 *   编辑器说没问题、页面上一片空白，这种 bug 最难查。
 *
 * 用法（在 quiz/frontend 下跑，或者任意目录给绝对路径）：
 *   node ../tools/check_bank.mjs ../../.tmp/docs-bank/vue-computed.bank.json
 *
 * 退出码：0 = 能入库；1 = 有问题（会打印出来）；2 = 用法不对
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { normalizeBank } from '../frontend/src/core/normalize.js'
// ★ "这段代码能不能跑"也用**前端那一份**实现（core/code.js 的 runBlockReason）——
//   以前这里手写了一句 `q.lang !== 'js'`，于是加了 Java 真跑之后，
//   校验器把 lang:'java' 的题全判成"跑不了"，而界面明明能跑（坑 58 的同类：
//   两处判据各写一份，就一定会有一处过期）。
import { runBlockReason } from '../frontend/src/core/code.js'

const file = process.argv[2]
if (!file) {
  console.error('用法: node quiz/tools/check_bank.mjs <bank.json>')
  process.exit(2)
}

const raw = JSON.parse(readFileSync(file, 'utf8'))
const bank = normalizeBank(raw, basename(file).replace(/\.json$/i, ''))

const problems = []
const stats = { total: 0, byType: {}, chapters: new Set(), tags: new Set(), withAnalysis: 0, withChapter: 0 }

if (!bank.questions.length) problems.push('一道题都没解析出来（题库 JSON 的结构前端不认）')

for (const q of bank.questions) {
  stats.total += 1
  stats.byType[q.type] = (stats.byType[q.type] || 0) + 1
  if (q.chapter) {
    stats.chapters.add(q.chapter)
    stats.withChapter += 1
  }
  for (const t of q.tags || []) stats.tags.add(t)
  if (q.analysis) stats.withAnalysis += 1

  if (!q.id) problems.push(`第 ${q.no} 题没有 id`)
  if (!q.stem) problems.push(`第 ${q.no} 题没有题干`)
  // 代码题的"答案"不是字母而是原文/行号/运行输出，判据在 core/code.js ——
  // 这里按它的四种模式分别查，别拿选择题的尺子去量
  if (q.type === 'code') {
    stats.byMode = stats.byMode || {}
    stats.byMode[q.mode] = (stats.byMode[q.mode] || 0) + 1
    if (!q.code) problems.push(`第 ${q.no} 题没有代码`)
    if (q.mode === 'fill') {
      const holes = (String(q.code).match(/_{3,}/g) || []).length
      const answers = Array.isArray(q.blanks) ? q.blanks : []
      if (!answers.length) problems.push(`第 ${q.no} 填空题没有 blanks`)
      if (holes !== answers.length) {
        problems.push(`第 ${q.no} 填空题的 ${holes} 个空和 ${answers.length} 个答案对不上`)
      }
      if (answers.some((b) => !b || !Array.isArray(b.answer) || !b.answer.length)) {
        problems.push(`第 ${q.no} 填空题有空答案`)
      }
    } else if (q.mode === 'spot') {
      const line = Number(q.answer?.[0])
      const total = String(q.code).split('\n').length
      if (!Number.isFinite(line) || line < 1 || line > total) {
        problems.push(`第 ${q.no} 找错行的答案不是合法行号（${q.answer?.[0]} / 共 ${total} 行）`)
      }
    } else if (q.mode === 'predict') {
      if (!Array.isArray(q.options) || q.options.length < 2) problems.push(`第 ${q.no} 预测输出题没有选项`)
      else {
        const keys = q.options.map((o) => o.key)
        for (const k of q.answer) if (!keys.includes(k)) problems.push(`第 ${q.no} 的答案 ${k} 不在选项里`)
      }
    } else if (q.mode === 'fix' || q.mode === 'write') {
      if (!q.run || !q.run.expect) {
        problems.push(`第 ${q.no} ${q.mode === 'write' ? '手写' : '修好它'}没有期望输出（判不了）`)
      }
    } else {
      problems.push(`第 ${q.no} 的代码题模式不认识：${q.mode}`)
    }
    // 「预测输出 / 修好它」**必须真能跑**（它们的判据就是运行结果）；
    // 填空/找错行可以跑不了（比如 Options API 的 export default 片段），
    // 那时界面上「运行」会自己禁掉并给出理由 —— 这是诚实，不是错误。
    // 「预测输出 / 修好它 / 手写」**必须真能跑**（它们的判据就是运行结果）；
    // 填空/找错行可以跑不了（比如 Options API 的 export default 片段、JSP 页），
    // 那时界面上「运行」会自己禁掉并给出理由 —— 这是诚实，不是错误。
    // ⚠️ 判据**调前端那一份**（core/code.js），别在这儿再写一遍：
    //    JS 走浏览器沙箱、Java 走**后端真 JVM**，两边能跑的集合不一样，
    //    手写一份必然会有一次忘改（实测：加 Java 之后这里把 java 题全判成跑不了）。
    const reason = runBlockReason(q)
    if (q.run && reason) {
      problems.push(`第 ${q.no} 的判据是"运行输出"，但这段代码跑不了：${reason}`)
    }
  } else if (q.type !== 'judge') {
    if (!Array.isArray(q.answer) || !q.answer.length) problems.push(`第 ${q.no} 题没有答案`)
    if (!Array.isArray(q.options) || q.options.length < 2) {
      problems.push(`第 ${q.no} 题选项不够（${(q.options || []).length} 个）`)
    } else {
      const keys = q.options.map((o) => o.key)
      for (const k of q.answer) {
        if (!keys.includes(k)) problems.push(`第 ${q.no} 题的答案 ${k} 不在选项里`)
      }
    }
  }
  if (q.type !== 'code' && (!Array.isArray(q.answer) || !q.answer.length)) {
    problems.push(`第 ${q.no} 题没有答案`)
  }
  // 章节是"弱点统计能落到哪一节"的前提：没有它，报告页只能给一个笼统的百分比
  if (!q.chapter) problems.push(`第 ${q.no} 题没有 chapter（章节级统计会落空）`)
}

for (const issue of bank.issues || []) problems.push(`前端归一化报告：${issue}`)

console.log(`题库：${bank.meta?.title || '(无标题)'}`)
console.log(`  题量：${stats.total}　题型：${JSON.stringify(stats.byType)}`)
if (stats.byMode) console.log(`  代码题模式：${JSON.stringify(stats.byMode)}`)
console.log(`  章节：${stats.chapters.size} 个　带 chapter 的题：${stats.withChapter}/${stats.total}`)
console.log(`  带解析：${stats.withAnalysis}/${stats.total}　标签：${stats.tags.size} 个`)
if (bank.meta?.source) console.log(`  来源：${bank.meta.source}`)

if (problems.length) {
  console.log(`\n❌ 有问题 ${problems.length} 处：`)
  for (const p of problems.slice(0, 20)) console.log(`   · ${p}`)
  process.exit(1)
}
console.log('\n✅ 前端能直接吃这份题库（schema 校验通过）')
