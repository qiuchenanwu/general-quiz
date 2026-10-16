/**
 * core/fallback.js —— **零额度兜底**：出不了选择/判断，就把教材里的代码清单变成交互式代码题。
 * ============================================================================
 * 为什么要有这个（站主 2026-10-11 的实测反馈）：
 *   他上传一份扫描件，最后拿到的是
 *   「失败：解析出 0 道可用题目（丢弃原因：选项少于 2 个×1）」——
 *   **整份材料一点产出都没有**。而那份材料里明明有好几段代码清单。
 *   "只盯着选择/判断"这条路一旦空了，材料就被浪费掉了，所以另辟一条：
 *   用**已经确定性的**办法把代码清单变成题（不调模型、不花额度）。
 *
 * 只生成 `fill`（填空/cloze），这是**唯一不需要真跑**就能保证判得对的形态：
 *   · `fill` 的答案就是被挖掉的那个词本身 —— "教材里怎么写的"就是判据，不用执行；
 *   · `predict` 需要 `options` + `run.expect`（期望输出必须真跑出来），
 *     `fix` / `write` 需要 `run.expect` —— **没有真跑就生成它们，
 *     会被 core/normalize.js 直接丢掉**（缺 run 的代码题进不了题库，宁可别生成）。
 *   → 真跑那条路（predict/fix/write）留给有沙箱的离线工具：
 *     `quiz/tools/units_to_tasks.mjs`（JS，Node vm）与
 *     `quiz/tools/textbook_java_tasks.py`（Java，真 JVM 跑期望值）。
 *
 * 判据**全部复用 core/lesson.js**（坑 58：同一判据不要写第二份）：
 *   · 只在**可信行**上挖空（`isTrusted`：这行没有高风险项、不是低置信）
 *   · 被挖的词必须**在全书出现过 ≥2 次**，且不是"近似拼法里次数更少的那个"
 *     （`tokenTrustworthy`）—— 这条专治 OCR 认错的词被当成标准答案
 *   · 这个词在**这一段清单里只能出现一次**（`buildSelfCheck` 已保证），所以挖空无歧义
 *
 * 教育研究上这也是最稳的一类：cloze 不需要执行、总是能生成；
 * Parsons（拖拽排序）是证据最好的确定性题型（Ericson ICER'18 / CHI'21），
 * 但需要新的交互形态，排在下一步。
 */

import { buildLesson } from '@/core/lesson'
import { guessLang } from '@/core/editor'
import { buildParsonsTask } from '@/core/parsons'
import { cleanLabel } from '@/core/docmodel'
// 猜语言只有一份实现（在 core/editor.js —— 高亮/补全也要用它）。这里**转出去**给调用方，
// 顺便保住 `FB.guessLang` 这个测试入口（坑 58：同一判据不要写第二份）。
// ⚠️ 要 `import` 之后再 `export`（只写 `export ... from` 不会在本文件里生成绑定，
//    下面 buildFallbackTasks 里就用不了它了）。
export { guessLang }

/** 后端给出来的题少于这个数，就值得兜底（和 service.py 的 MIN_RULE_QUESTIONS 一个意思） */
export const MIN_TOTAL_BEFORE_FALLBACK = 2

/**
 * 教材材料 → 兜底代码题（`mode: 'fill'`）。
 *
 * @param {object} model  `core/docmodel.js` 的文档模型（**人已经在校对台上核对过**的那份）
 * @param {{max?: number, prefix?: string}} [opts]
 * @returns {object[]} 题库 schema 的代码题（可直接进 `normalizeBank`）
 */
export function buildFallbackTasks(model, { max = 12, prefix = 'fb' } = {}) {
  if (!model || !Array.isArray(model.pages)) return []
  let lesson
  try {
    lesson = buildLesson(model)
  } catch {
    return []
  }
  const byId = new Map((lesson.listings || []).map((l) => [l.id, l]))
  const out = []

  /**
   * 有的清单**既没有 caption 也没有 section**（OCR 没读到标题）—— 退到全书的章级标题。
   * 为什么值得这一步：`chapter` 为空的题**不进"你哪一节最弱"那条统计**
   * （它按 chapter 分桶），等于那道题白做了一次诊断。
   */
  const defaultChapter = cleanLabel(
    (lesson.outline || []).find((o) => o.level === 1)?.title || lesson.book || '',
  )

  /** 出处/解析都带上教材原话 —— "点开自己核对"这条硬保证对兜底题也成立 */
  const provenance = (listing, quote) => ({
    source: {
      // ⚠️ 标题/章节要**洗掉 OCR 标点噪声**（`3.6.2 “重定向` 那种）：
      //    章节是"你哪一节最弱"那条统计的分桶键，带噪声会把同一节分成两桶。
      heading: cleanLabel(listing.caption || listing.section || '') || defaultChapter,
      quote: String(quote || ''),
      page: listing.page,
    },
    chapter: cleanLabel(listing.section || listing.caption || '') || defaultChapter,
    tags: ['兜底代码题'],
    // 让界面/报告能说清这道题的来路（不是模型编的）
    fallback: 'code-listing',
  })

  // ① **拖拽排序**（Parsons）：每个代码清单出一道。
  //    研究上这是证据最好的确定性题型（Ericson ICER'18：比从头写更快、效果相当；
  //    CHI'21 的 faded Parsons 更好），判据是**教材原文的顺序**，不需要真跑。
  for (const listing of lesson.listings || []) {
    if (out.length >= max) break
    const code = String(listing.code || '')
    if (code.trim().length < 20) continue
    const task = buildParsonsTask(code)
    if (!task) continue
    out.push({
      id: `${prefix}-order-${out.length + 1}`,
      type: 'code',
      mode: 'order',
      // ⚠️ 题干是**显示给学生看的纯文本**：不能写 markdown 星号（坑 76 ——
      //    模板/题面里的星号会原样显示出来，check_sfc 只拦 .vue，题面得自己注意）
      stem: `${listing.caption || '这段代码清单'}：把下面 ${task.blocks.length} 块拖回教材原文的顺序。`,
      code: task.code,
      blocks: task.blocks,
      answer: task.answer,
      lang: guessLang(code),
      analysis: `按教材原文的顺序排。原文这一段是：\n\n\`\`\`\n${task.code}\n\`\`\``,
      ...provenance(listing, (listing.lines || []).map((l) => l.text).join('\n') || task.code),
    })
  }

  // ② **填空**（cloze）：只在可信行上挖空（判据全在 lesson.js，见文件头）
  for (const item of lesson.selfCheck || []) {
    if (out.length >= max) break
    const listing = byId.get(item.listingId)
    if (!listing) continue
    const code = String(listing.code || '')
    const token = String(item.answer || '')
    if (!token || !code) continue
    // 这个词在清单里只出现一次（buildSelfCheck 的 count !== 1 → continue 保证的），
    // 所以"挖第一个出现处"没有歧义。挖不出来就跳过，不硬凑。
    const at = code.indexOf(token)
    if (at < 0) continue
    const filled = code.slice(0, at) + '___' + code.slice(at + token.length)
    if (!/_{3,}/.test(filled)) continue
    out.push({
      id: `${prefix}-fill-${out.length + 1}`,
      type: 'code',
      mode: 'fill',
      stem: item.stem,
      code: filled,
      lang: guessLang(code),
      blanks: [{ answer: [token], hint: '' }],
      answer: [token],
      // 解析里写清"补的是什么" + **教材原话那一行**，
      // 这样"点开出处能自己核对"那条硬保证在兜底题上也成立。
      analysis: `补上的东西是什么：${token}\n\n${item.verify || ''}`.trim(),
      ...provenance(listing, item.line),
    })
  }

  // 编号放在最后统一给（两种题型混在一起，编号不能各算各的）
  out.forEach((q, i) => {
    q.no = i + 1
  })
  return out
}

/**
 * 把兜底题并进后端给的题库。
 *
 * `imported` 可能是 null（后端 ok:false，一道题都没给）—— 那就现造一份 meta，
 * 让"有产出"优先于"接口体面"：预习页那条路已经是这个思路（先存 pending）。
 */
export function mergeIntoBank(imported, extra, { title = '扫描件题库' } = {}) {
  if (!extra || !extra.length) return imported
  if (!imported || !Array.isArray(imported.questions)) {
    return {
      meta: {
        id: '',
        title: `${title} · 代码清单兜底`,
        subject: '计算机',
        description:
          '这份题库是**兜底生成**的：模型没能从材料里出题，于是把教材里的代码清单' +
          '变成了填空代码题（判据是教材原文，没有调用模型）。',
        total: extra.length,
        generatedAt: new Date().toISOString(),
      },
      questions: extra,
    }
  }
  const questions = [...imported.questions, ...extra]
  return {
    ...imported,
    meta: {
      ...(imported.meta || {}),
      total: questions.length,
      // 别覆盖原来的描述，只补一句来路（人要知道多出来的题是哪来的）
      description: `${imported.meta?.description || ''}${
        imported.meta?.description ? ' ' : ''
      }另附 ${extra.length} 道**代码清单兜底题**（模型出不了选择/判断时，用教材里的代码生成的填空题）。`,
    },
    questions,
  }
}
