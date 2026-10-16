/**
 * task.js —— 「按你的弱项做一个任务」的**纯逻辑**（不碰 Vue / DOM / localStorage）
 *
 * 任务回路的左半段（站主要的那条回路的第一截）：
 *     课本这一章 ──(预习页那份文字)──▶ 挑出他最弱的 2~3 个标签 ──▶ POST /api/quiz/task/
 *
 * 为什么要单独一个模块、而且做成纯函数：
 *   · 「把预习页拼成教材文字」「挑最弱标签」「起手代码该用哪种语言」这三件事
 *     都是**能算错**的逻辑，放视图里就只能靠肉眼看；
 *   · 放这里就能在 Node 里直接跑断言（tests/test_engine.mjs 的 W 段）。
 *
 * ⚠️ 后端 `_task_quote` 会对引文做逐字命中校验（忽略空白差异），
 *    所以这里拼材料时**绝不能改写教材原句** —— 术语的 quote、代码清单的 code
 *    都是原样搬进去的（只加页码前缀，不动句子本身）。
 */
import { tagStats } from '@/core/analytics'

/** 材料长度上限。和后端 service.MAX_TASK_MATERIAL_CHARS 是同一个数（超了后端会 400） */
export const TASK_MATERIAL_MAX = 20000

/** 弱项标签最多带几个上去（后端也截，这里先挑好最弱的几个） */
export const TASK_WEAK_LIMIT = 3

/**
 * 取材范围（站主要求的那个开关）。
 *
 * 背景（站主原话）：「这提示词要加个开关，针对性的来，因为**如果只照着书本，
 * 信息量不足以出题，所以放宽吧**」。于是：
 *   · `open`（允许补充，**默认**）：材料太薄时允许模型用通用知识把任务补完整；
 *     但**绝不许把教材外的话说成教材原话** —— 引文核对不通过就干脆不给引文。
 *   · `book`（只照书本）：教材里没写的一个字都不许提，引文必须逐字命中材料。
 * 做成开关而不是写死：材料够用就严格、不够用才放宽，而且**看得见、能一键切回来**。
 *
 * ⚠️ 默认值必须和后端 `prompts.DEFAULT_TASK_SCOPE` 一致（那边也默认 open）。
 */
export const TASK_SCOPES = [
  { value: 'open', label: '允许补充', hint: '材料不够时让 AI 用自己的知识把任务补完整（绝不冒充教材原话）' },
  { value: 'book', label: '只照书本', hint: '只用这一章里的内容，教材里没写的一律不提' },
]
export const DEFAULT_TASK_SCOPE = 'open'

/** 取材范围 → 卡片上显示的中文档名（认不出就按默认档） */
export function taskScopeLabel(scope) {
  const hit = TASK_SCOPES.find((s) => s.value === scope)
  return hit ? hit.label : TASK_SCOPES[0].label
}

/**
 * **这次没有教材引文**时，卡片上要说的那句话 —— 按档各说各的。
 *
 * 为什么必须有这句、而且分两档：后端两档的引文规则不一样（见 quizgen 的
 * `_task_quote`）——「允许补充」档引文本来就可以为空，「只照书本」档只在
 * 材料里挑不出一句能逐字核对的原话时才为空。**两种空都不是"引文丢了"**，
 * 所以界面上既不能什么都不显示（学生会以为卡坏了），更不能留一个空的引文位
 * 让人以为有教材依据。这里明说"没有引文"，并说清那句 why 不是课本上的话。
 *
 * ⚠️ 措辞里**不许出现「教材原话」四个字**：那是引文那行的说法，
 *    这里出现就成了"空引文位"的变体（task_check.py 会断言这一点）。
 *
 * @param {string} scope 'book' / 'open'（认不出按默认档）
 * @returns {string} 给人看的中文说明
 */
export function taskNoQuoteNote(scope) {
  const label = taskScopeLabel(scope)
  if (scope === 'book') {
    return `这次没有引文（取材范围：${label}）—— 这一档只用课本里的内容，` +
      '但材料里没找到能逐字核对的句子，所以我们宁可不给引文；上面那句「为什么」不是课本上的话。'
  }
  return `这次没有引文（取材范围：${label}）—— 这一档允许助教用教材外的通用知识把任务补完整，` +
    '但不会把教材外的话说成课本里的话；上面那句「为什么」是按通用写法讲的。'
}

/**
 * 弱项判据的**最小作答次数**：做 1 道错 1 道不算弱项。
 * ⚠️ 必须和报告页（stores/quiz.js 的 report → buildReport 默认值）一致 ——
 *    不然报告页说"你弱在 A"、任务卡说"你弱在 B"，学生只会觉得这站在瞎说。
 */
export const TASK_MIN_ATTEMPTS = 3

/**
 * 把预习页（core/lesson.js 的 buildLesson 产物）拼成**给模型看的教材文字**。
 *
 * 形状（每个片段都带 `[p12]` 这样的页码标记，后端的 fromPage 只能从这里挑）：
 *     【这一章】…
 *     【骨架】…
 *     【教材原文】…   ← 术语表里那句教材原话，原样搬
 *     【代码清单】…   ← 教材里的代码，原样搬
 *     【先猜后验的原文】…
 *
 * @param {object} lesson 预习页
 * @returns {string} 教材文字（超长会截断并写明）
 */
export function lessonMaterial(lesson) {
  if (!lesson || typeof lesson !== 'object') return ''
  const out = []
  const page = (n) => (n ? `[p${n}] ` : '')
  const push = (line = '') => out.push(line)

  push(`【这一章】${lesson.title || '（没有标题）'}`)
  if (lesson.book) push(`【教材】${lesson.book}`)
  push('')

  const outline = Array.isArray(lesson.outline) ? lesson.outline : []
  if (outline.length) {
    push('【骨架】')
    for (const o of outline) push(`${page(o.page)}${o.title || ''}`)
    push('')
  }

  const terms = Array.isArray(lesson.terms) ? lesson.terms : []
  if (terms.length) {
    // 这一节是"能逐字引用"的主料：每条都是教材原句（见 lesson.js 的 buildTerms）
    push('【教材原文（术语与定义）】')
    for (const t of terms) push(`${page(t.page)}${t.term}：${t.quote}`)
    push('')
  }

  const listings = Array.isArray(lesson.listings) ? lesson.listings : []
  if (listings.length) {
    push('【代码清单】')
    for (const l of listings) {
      push(`${page(l.page)}${l.caption || l.id}${l.section ? ` · ${l.section}` : ''}`)
      push('```')
      push(l.code || '')
      push('```')
    }
    push('')
  }

  const selfCheck = Array.isArray(lesson.selfCheck) ? lesson.selfCheck : []
  if (selfCheck.length) {
    push('【先猜后验的原文】')
    for (const q of selfCheck) push(`${q.verify || ''}`)
    push('')
  }

  let text = out.join('\n').trim()
  if (!text) text = String(lesson.title || '')
  if (text.length > TASK_MATERIAL_MAX) {
    // 截断要留痕：不然模型以为材料就这么点，学生也看不出少了东西
    text = `${text.slice(0, TASK_MATERIAL_MAX - 20)}\n…（材料太长，已截断）`
  }
  return text
}

/**
 * 他最弱的 2~3 个标签（交给后端"按他的基础"出任务）。
 *
 * 复用 core/analytics.js 的 tagStats（**同一条弱项判据**，报告页用的就是它）：
 * 只算作答次数 ≥ minAttempts 的标签，按正确率升序 —— 最前面的就是最弱的。
 *
 * ⚠️ 再加一道：**至少错过一次的才算弱项**。tagStats 会把"做了 3 次全对"的标签
 * 也排在后面返回（它只按正确率排序、不做取舍），而卡片上写的是"你最近做错的 X" ——
 * 把一个从没错过的标签说成弱项，学生一眼就看出这站在瞎说。
 * 一个都没有（数据不够）时返回空数组，调用方要说清"先按这一章的基础出"。
 *
 * @param {Array} history   quiz store 的 history：[{q, ok, t, ms}]
 * @param {Array} questions 当前题库（要它的 tags）
 * @param {object} [opt]    { limit, minAttempts }
 * @returns {Array<{tag:string, wrong:number, total:number}>}
 */
export function weakTags(history, questions, { limit = TASK_WEAK_LIMIT, minAttempts = TASK_MIN_ATTEMPTS } = {}) {
  const stats = tagStats(history, questions, { minAttempts })
  return stats
    .map((row) => ({
      tag: String(row.name || ''),
      wrong: Math.max(0, (row.n || 0) - (row.ok || 0)),
      total: row.n || 0,
    }))
    .filter((row) => row.tag && row.wrong > 0)
    .slice(0, Math.max(0, limit))
}

/** 弱项 → 一句人话（卡片上那句"会用到你最近做错的 X"）。空弱项返回空串。 */
export function weakSummary(weak) {
  const names = (weak || []).map((w) => String(w?.tag || '')).filter(Boolean)
  return names.length ? names.join('、') : ''
}

/** 没有弱项时卡片上显示的那句话（和后端 prompts.TASK_NO_WEAK 说的是同一件事） */
export const TASK_NO_WEAK_NOTE = '还没有足够的数据，先按这一章的基础给你出任务。'

const RE_JAVA = /(public\s+class|System\.out|import\s+java|@WebServlet|HttpServlet|void\s+main)/
const RE_JS = /(console\.log|\bconst\s|\blet\s|=>|<script|document\.|ref\(|computed\(|Vue\.)/

/**
 * 预习页里的代码更像哪一种？用来给卡片选一个默认语言（学生可以改）。
 *
 * 判据：逐个数两边的特征词，谁多算谁；一个特征都没有就按 Java（这套教材是 JavaWeb）。
 * ⚠️ 只影响**默认值**：真正的 lang 是卡片上那个开关说了算，别在这里"替学生决定"。
 */
export function guessTaskLang(lesson) {
  const listings = (lesson && Array.isArray(lesson.listings) && lesson.listings) || []
  let java = 0
  let js = 0
  for (const l of listings) {
    const code = String(l?.code || '')
    if (RE_JAVA.test(code)) java += 1
    if (RE_JS.test(code)) js += 1
  }
  return js > java ? 'js' : 'java'
}

/** 交给「让 AI 检查」的目标：把任务的目标和完成判据一起说清（≤300 字，和后端上限一致） */
export const TASK_REVIEW_GOAL_MAX = 300

/**
 * 任务 → AiReview 的 goal。
 *
 * 为什么要把 done 拼进去：AI 批改要**对着这个任务**评"你做到没有"，
 * 只丢一句 goal 给它，它就只会泛泛评代码（那正是站主说的"等于没批改"）。
 *
 * ⚠️ 只能拼成**一行**：这段文字要塞进 `<input>`，而单行 input 的取值会
 *    把换行吃掉 —— 那样"框里显示的"和"发给后端的"就不是同一句话了
 *    （真浏览器验收里就是这么撞出来的）。
 */
export function taskReviewGoal(task) {
  const goal = String(task?.goal || '').trim()
  const done = (Array.isArray(task?.done) ? task.done : []).map((d) => String(d || '').trim()).filter(Boolean)
  const parts = []
  if (goal) parts.push(`任务：${goal}`)
  if (done.length) parts.push(`完成判据：${done.map((d, i) => `${i + 1}) ${d}`).join('；')}`)
  const text = parts.join('；')
  return text.length > TASK_REVIEW_GOAL_MAX ? text.slice(0, TASK_REVIEW_GOAL_MAX - 1) + '…' : text
}
