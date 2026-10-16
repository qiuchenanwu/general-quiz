/**
 * coach.js —— **问 AI / 错题诊断**的纯逻辑（可离线断言，不碰网络、不碰 DOM）
 * ============================================================================
 * 后端那两个接口（`/api/quiz/tutor/`、`/api/quiz/diagnose/`）本来是驾考站加的，
 * 刷题站一直没接。这里补上"接"之前该想清楚的部分：
 *
 *   1. **喂什么**：错题要带上题干/选项/正确答案/学员选了什么/章节/标签 ——
 *      少一样，模型就只能猜（`wrongItems`，纯函数）。
 *   2. **喂多少**：后端上限 40 道（`service.MAX_DIAGNOSE_WRONGS`），超了直接 400。
 *      所以这里先截断，并**按最近错的优先**（`wrongItems` 里用作答时间排序）——
 *      一次把整个错题本发上去，模型反而给不出重点。
 *   3. **用哪个提示词包**：教材/官方文档编译的题库要走 `docs` 包
 *      （它明确要求"引用文档原文的说法、文档没写就说没写、答错先问学生怎么想的"），
 *      普通题库走 `generic`。判断依据见 `coachDomain`。
 *
 * 代码题也要能问：它的"答案"不是字母而是原文/行号/运行输出，
 * 所以 `wrongItems` 会把 `code` / `mode` 一起带上，后端渲染器认这两个字段。
 */

/** 后端一次最多吃 40 道错题（service.MAX_DIAGNOSE_WRONGS）—— 这里必须跟着改 */
export const COACH_WRONG_MAX = 40

/**
 * 这个题库该用哪个提示词包？
 *
 * `docs` 包的差别不是"更好听"，而是**约束更紧**：只讲文档写过的、答错先反问、
 * 不确定的版本差异要说不确定。教材题库（CC BY 的官方文档编译出来的）正需要这个。
 *
 * @param {object} meta  题库 meta
 * @param {string} [materialKind] 用户在设置里选的"材料类型"（'docs' / ''），优先级最高
 * @returns {'docs'|''}
 */
export function coachDomain(meta, materialKind = '') {
  if (String(materialKind || '').trim().toLowerCase() === 'docs') return 'docs'
  const hay = [meta?.license, meta?.attribution, meta?.source, meta?.modified, meta?.description]
    .filter(Boolean)
    .join(' ')
  if (!hay) return ''
  // 许可/来源里出现这些字样 → 这份题库是从文档/教材编译来的
  if (/CC[\s-]?BY|官方文档|文档|docs?\.|vuejs|wiki|readthedocs|MDN/i.test(hay)) return 'docs'
  return ''
}

/**
 * 把错题整理成后端要的形状。
 *
 * @param {object} o
 * @param {Map<string,object>} o.byId      id → 归一化后的题
 * @param {string[]} o.wrongIds            错题 id（顺序无所谓，这里按最近错的重排）
 * @param {(id:string)=>string[]} o.answerOf   **有效答案**（用户修正过就用修正的）
 * @param {(id:string)=>string[]} o.pickOf     学员当时选了什么
 * @param {(id:string)=>number} [o.timeOf]     这道题最后一次作答的时间戳（用来排序）
 * @param {number} [o.limit]
 * @returns {Array<object>}
 */
export function wrongItems({ byId, wrongIds, answerOf, pickOf, timeOf, limit = COACH_WRONG_MAX }) {
  const rows = (wrongIds || [])
    .map((id) => {
      const q = byId?.get?.(id)
      if (!q || !q.stem) return null
      return {
        id,
        t: typeof timeOf === 'function' ? Number(timeOf(id)) || 0 : 0,
        row: {
          no: q.no,
          type: q.type,
          stem: q.stem,
          options: q.options || [],
          answer: (answerOf ? answerOf(id) : q.answer) || [],
          picked: (pickOf ? pickOf(id) : []) || [],
          chapter: q.chapter || '',
          tags: q.tags || [],
          // 代码题：不给代码，模型根本没法讲这道题
          code: q.code || '',
          mode: q.mode || '',
        },
      }
    })
    .filter(Boolean)

  rows.sort((a, b) => b.t - a.t) // 最近错的排前面（截断时先丢最老的）
  return rows.slice(0, Math.max(1, limit)).map((r) => r.row)
}

/**
 * 就着某一道题追问时，送给后端的题目上下文（只带必要字段，省 token）。
 *
 * 代码题把 `code` / `mode` 一起带上：不然模型看到"下面这段代码哪一行被改了"
 * 却看不到代码，只能瞎猜。
 */
export function tutorContext(q, { answerKeys = [], analysis = '' } = {}) {
  if (!q) return {}
  const out = {
    no: q.no,
    type: q.type,
    stem: q.stem,
    options: q.options || [],
    answer: answerKeys.length ? answerKeys : q.answer || [],
    analysis: analysis || q.analysis || '',
    chapter: q.chapter || '',
  }
  if (q.code) {
    out.code = q.code
    out.mode = q.mode || ''
  }
  return out
}

/**
 * 问 AI 的快捷问法。
 *
 * 为什么要有：手打问题在手机上很烦，而"为什么不选别的""我这样理解对不对"
 * 这类追问恰恰是刷题站最该提供的东西（它比"答案是什么"值钱得多）。
 * 教材题库和普通题库的问法不一样 —— 前者的答案是"去读文档那一节"。
 */
export function quickAsks(domain, mode = '') {
  const common = [
    '我总是记不住，给我一个最小例子。',
    '这道题考的是哪个概念？容易和什么混淆？',
    '换个更简单的说法再讲一遍。',
  ]
  if (mode === 'spot') {
    return ['被改动的那一行会让行为怎么变？', '原文为什么要那样写？', ...common]
  }
  if (mode === 'fill' || mode === 'fix') {
    return ['这段代码每一行在做什么？', '我这样改对不对？还有别的写法吗？', ...common]
  }
  if (domain === 'docs') {
    return [
      '为什么不选其他选项？逐个说一下。',
      '文档里哪一节讲了这件事？我该去读什么？',
      '文档没写、但你确定吗？（不确定就说不确定）',
      ...common,
    ]
  }
  return ['为什么不选其他选项？逐个说一下。', ...common]
}
