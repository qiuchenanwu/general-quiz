/**
 * test_engine.mjs —— 刷题引擎的自动化验收（纯 Node，不需要浏览器）
 *
 * 覆盖三件事：
 *   A. 真实题库的完整性（224 题，答案都在选项里）
 *   B. 容错归一化层能不能吃下「AI 随手产出的脏 JSON」（这是「可复用」的核心承诺）
 *   C. Pinia store 的答题流程：单选/多选/判断、错题本进出、背题模式、考试交卷计分
 *
 * 用法： node tests/test_engine.mjs     （在 frontend/ 目录下执行）
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'

import { normalizeBank, normalizeQuestion, isCorrect } from '../src/core/normalize.js'
import * as A from '../src/core/analytics.js'
import * as G from '../src/core/graph.js'
import * as D from '../src/core/diagram.js'
import * as M from '../src/core/music.js'
import * as L from '../src/core/lyrics.js'
import * as T from '../src/core/text.js'
import * as celebrate from '../src/core/celebrate.js'
import * as CD from '../src/core/code.js'
import * as CO from '../src/core/coach.js'
import * as DI from '../src/core/diagnose.js'
import * as EK from '../src/core/elevate.js'
import * as JV from '../src/core/java.js'
import * as DM from '../src/core/docmodel.js'
import * as LS from '../src/core/lesson.js'
import * as FB from '../src/core/fallback.js'
import * as ED from '../src/core/editor.js'
import * as CT from '../src/core/code-theme.js'
import * as SN from '../src/core/snippet.js'
import * as MG from '../src/core/merge.js'
import * as PS from '../src/core/parsons.js'
import * as TK from '../src/core/task.js'
import * as ST from '../src/core/state.js'
import * as AU from '../src/core/auth.js'
import { useBankStore } from '../src/stores/bank.js'
import { useQuizStore } from '../src/stores/quiz.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BANK = path.join(HERE, '..', 'src', 'banks', 'maogai.json')

let pass = 0
let failed = 0

function ok(cond, label, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}${extra ? `  →  ${extra}` : ''}`)
  }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

/* ═══════════════════════════ A. 题库完整性 ═══════════════════════════ */
console.log('\n═══ A. 真实题库完整性 ═══')
const raw = JSON.parse(fs.readFileSync(BANK, 'utf8'))
const bank = normalizeBank(raw, 'maogai')

eq(bank.questions.length, 224, '题目数量 = 224')
eq(bank.meta.counts.single, 90, '单选题 90')
eq(bank.meta.counts.multiple, 44, '多选题 44')
eq(bank.meta.counts.judge, 90, '判断题 90')
eq(bank.issues.length, 0, '归一化零告警')

const badAnswer = bank.questions.filter((q) => {
  const keys = new Set(q.options.map((o) => o.key))
  return !q.answer.length || q.answer.some((a) => !keys.has(a))
})
eq(badAnswer.length, 0, '每道题的答案都落在选项里')

const badMulti = bank.questions.filter((q) => q.type === 'multiple' && q.answer.length < 2)
eq(badMulti.length, 0, '多选题答案都 ≥ 2 个字母')

const badOpts = bank.questions.filter((q) => q.options.length < 2)
eq(badOpts.length, 0, '每道题至少 2 个选项')

const nos = bank.questions.map((q) => q.no).sort((a, b) => a - b)
eq(nos[0], 1, '题号从 1 开始')
eq(nos[nos.length - 1], 224, '题号到 224 结束')
ok(
  nos.every((n, i) => n === i + 1),
  '题号 1..224 连续无缺口',
)
ok(
  bank.questions.every((q) => q.stem.length > 0 && q.options.every((o) => o.text.length > 0)),
  '没有空题干 / 空选项',
)
ok(
  bank.questions.every((q) => new Set(q.options.map((o) => o.key)).size === q.options.length),
  '同一题内选项 key 不重复',
)
ok(bank.meta.tags.length > 0, `自动标签生成成功（${bank.meta.tags.length} 个）`)
ok(
  bank.questions.every((q) => q.id && q.id.length > 0),
  '每题都有 id',
)

/* ═══════════════════════════ B. 容错归一化 ═══════════════════════════ */
console.log('\n═══ B. 容错归一化（吃脏 JSON 的能力）═══')

// B1. 中文键名 + 字符串选项数组 + 纯字母答案
{
  const n = normalizeBank(
    [
      {
        题目: '中国的武装斗争是无产阶级领导下的以( )为主体的革命战争。',
        选项: ['工人', '农民', '城市小资产阶级', '知识分子'],
        正确答案: 'B',
      },
    ],
    '脏题库',
  )
  const q = n.questions[0]
  eq(q.type, 'single', 'B1 中文键名 → 推断为单选')
  eq(q.options.length, 4, 'B1 字符串选项数组 → 自动分配 A/B/C/D')
  eq(q.options[1].key, 'B', 'B1 第 2 个选项 key = B')
  eq(q.options[1].text, '农民', 'B1 选项文本正确')
  eq(q.answer[0], 'B', 'B1 答案 B')
}
// B2. 选项自带 "A. " 前缀
{
  const { q } = normalizeQuestion({ question: '题干', options: ['A. 甲', 'B、乙', 'C）丙'], answer: 'C' }, 0)
  eq(q.options.length, 3, 'B2 识别 3 个选项')
  eq(q.options[0].text, '甲', 'B2 剥掉 "A. " 前缀')
  eq(q.options[2].text, '丙', 'B2 剥掉 "C）" 前缀')
  eq(q.options[2].key, 'C', 'B2 key 抽取正确')
}
// B3. {A: "...", B: "..."} 映射
{
  const { q } = normalizeQuestion({ stem: '题干', options: { A: '甲', B: '乙', C: '丙' }, answer: 'AC' }, 0)
  eq(q.type, 'multiple', 'B3 映射选项 + 两个答案 → 多选')
  eq(q.options.map((o) => o.key).join(''), 'ABC', 'B3 key 顺序 A/B/C')
  eq(q.answer.join(''), 'AC', 'B3 多选答案 AC')
}
// B4. 判断题：正确/错误、对/错、√/×、true/false、T/F
{
  const cases = [
    ['正确', 'T'],
    ['对', 'T'],
    ['√', 'T'],
    [true, 'T'],
    ['T', 'T'],
    ['错误', 'F'],
    ['错', 'F'],
    ['×', 'F'],
    [false, 'F'],
    ['F', 'F'],
  ]
  let allOk = true
  const detail = []
  for (const [input, expected] of cases) {
    const { q } = normalizeQuestion({ stem: '判断题', answer: input }, 0)
    if (!q || q.type !== 'judge' || q.answer[0] !== expected) {
      allOk = false
      detail.push(`${JSON.stringify(input)}→${q ? q.answer[0] : 'null'}(期望${expected})`)
    }
  }
  ok(allOk, 'B4 判断题 10 种写法全部识别（正确/对/√/true/T/错误/错/×/false/F）', detail.join(', '))
}
// B5. 判断题自动补选项
{
  const { q } = normalizeQuestion({ stem: '判断题', answer: '正确' }, 0)
  eq(q.options.length, 2, 'B5 判断题自动补出 2 个选项')
  eq(q.options[0].key, 'T', 'B5 选项 1 = T 正确')
  eq(q.options[1].key, 'F', 'B5 选项 2 = F 错误')
}
// B6. 数字答案（1-based 序号 / 0-based）
{
  const a = normalizeQuestion({ stem: 'x', options: ['甲', '乙', '丙'], answer: 2 }, 0).q
  eq(a.answer[0], 'B', 'B6 数字答案 2 → B（1-based）')
  const b = normalizeQuestion({ stem: 'x', options: ['甲', '乙', '丙'], answer: 0 }, 0).q
  eq(b.answer[0], 'A', 'B6 数字答案 0 → A（0-based 兜底）')
}
// B7. 答案带分隔符 / 数组 / 乱序
{
  const a = normalizeQuestion({ stem: 'x', options: ['甲', '乙', '丙'], answer: 'C,A' }, 0).q
  eq(a.answer.join(''), 'AC', 'B7 "C,A" → 排序成 AC')
  const b = normalizeQuestion({ stem: 'x', options: ['甲', '乙', '丙'], answer: ['B', 'a'] }, 0).q
  eq(b.answer.join(''), 'AB', 'B7 ["B","a"] → 排序成 AB')
  const c = normalizeQuestion({ stem: 'x', options: ['甲', '乙', '丙'], answer: 'A、B' }, 0).q
  eq(c.answer.join(''), 'AB', 'B7 "A、B" → AB')
}
// B8. 各种顶层包装
{
  const shapes = [
    [{ stem: 'q', options: ['a', 'b'], answer: 'A' }],
    { questions: [{ stem: 'q', options: ['a', 'b'], answer: 'A' }] },
    { data: [{ stem: 'q', options: ['a', 'b'], answer: 'A' }] },
    { list: [{ stem: 'q', options: ['a', 'b'], answer: 'A' }] },
    { items: [{ stem: 'q', options: ['a', 'b'], answer: 'A' }] },
    { 题目: [{ stem: 'q', options: ['a', 'b'], answer: 'A' }] },
  ]
  let allOk = true
  for (const s of shapes) {
    try {
      if (normalizeBank(s, 't').questions.length !== 1) allOk = false
    } catch {
      allOk = false
    }
  }
  ok(allOk, 'B8 六种顶层结构（裸数组/questions/data/list/items/题目）都能识别')
}
// B9. 默认 id 与去重
{
  const n = normalizeBank(
    [
      { stem: 'a', options: ['1', '2'], answer: 'A' },
      { stem: 'b', options: ['1', '2'], answer: 'A' },
      { stem: 'c', options: ['1', '2'], answer: 'A' },
    ],
    't',
  )
  eq(new Set(n.questions.map((q) => q.id)).size, 3, 'B9 自动生成的 id 不重复')
}
// B10. 坏数据要被温和地跳过，而不是炸掉整个题库
{
  const n = normalizeBank(
    [
      { stem: '好题', options: ['1', '2'], answer: 'A' },
      { stem: '', options: ['1', '2'], answer: 'A' }, // 空题干
      { stem: '没答案', options: ['1', '2'] }, // 缺答案
      { stem: '答案越界', options: ['1', '2'], answer: 'D' }, // D 不在选项里
      '不是对象', // 完全不是题
    ],
    't',
  )
  eq(n.questions.length, 1, 'B10 5 条数据里只保留 1 道合法题')
  ok(n.issues.length > 0, 'B10 跳过的题会生成告警文案')
  ok(/4 道题被跳过/.test(n.issues[0]), 'B10 告警里写清了跳过数量', n.issues[0])
}
// B11. 全空输入要抛出可读错误
{
  let msg = ''
  try {
    normalizeBank({ foo: 'bar' }, 't')
  } catch (e) {
    msg = e.message
  }
  ok(/没找到题目数组/.test(msg), 'B11 找不到题目数组时抛出可读错误', msg)
}
// B12. 答案判定：顺序无关、数量必须一致
{
  ok(isCorrect(['B', 'A'], ['A', 'B']), 'B12 多选答案顺序不同也算对')
  ok(!isCorrect(['A'], ['A', 'B']), 'B12 少选算错')
  ok(!isCorrect(['A', 'B', 'C'], ['A', 'B']), 'B12 多选算错')
  ok(!isCorrect([], ['A']), 'B12 空作答算错')
  ok(isCorrect(['T'], ['T']), 'B12 判断题 T 判定正确')
}

/* ═══════════════════════════ C. 答题引擎 ═══════════════════════════ */
console.log('\n═══ C. 答题引擎（Pinia store）═══')

setActivePinia(createPinia())
const bankStore = useBankStore()
const quiz = useQuizStore()

// 直接塞入题库，跳过 fetch
bankStore.current = { meta: bank.meta, questions: bank.questions, issues: [], origin: 'test' }
quiz.init(bank.meta.id)

const byNo = new Map(bank.questions.map((q) => [q.no, q]))
const qSingle = byNo.get(1) // 答案 A
const qMulti = byNo.get(11) // 答案 AB
const qJudgeTrue = byNo.get(17) // 答案 正确 → T
const qJudgeFalse = byNo.get(16) // 答案 错误 → F

// C1. 顺序练习：答对
{
  quiz.startSession({ mode: 'seq' })
  quiz.goTo(0) // 第 1 题 qSingle
  const r = quiz.toggleOption(qSingle.answer[0])
  ok(r.revealed === true, 'C1 单选题点选项即揭示答案')
  ok(quiz.currentOk === true, 'C1 答对被判定为正确')
  eq(quiz.wrongCount, 0, 'C1 答对不进错题本')
  const rec = quiz.answers[qSingle.id]
  ok(!!rec && rec.ok === true, 'C1 作答记录写入进度')
}

// C2. 答错 → 进错题本；再答对 → 移出
{
  const q2 = byNo.get(2)
  quiz.goTo(1) // 换一题，避免被「已判定就不再判」拦住
  const bad = q2.options.find((o) => o.key !== q2.answer[0]).key
  quiz.toggleOption(bad)
  ok(quiz.currentOk === false, 'C2 故意选错 → 判定为错')
  eq(quiz.wrongCount, 1, 'C2 错题进入错题本')
  ok(!!quiz.wrong[q2.id], 'C2 错题本里就是这道题')

  // 重做错题：答对后自动移出
  quiz.endSession()
  quiz.startSession({ mode: 'wrong' })
  eq(quiz.queue.length, 1, 'C2 错题重做只给 1 道题')
  quiz.goTo(0)
  eq(quiz.currentQid, q2.id, 'C2 错题重做给到的就是那道错题')
  quiz.toggleOption(q2.answer[0])
  ok(quiz.currentOk === true, 'C2 重做答对')
  eq(quiz.wrongCount, 0, 'C2 答对后自动移出错题本')
}

// C3. 多选题：选完必须点确认才判定
{
  quiz.endSession()
  quiz.startSession({ mode: 'seq' })
  const idx = quiz.queue.indexOf(qMulti.id)
  quiz.goTo(idx)
  quiz.toggleOption(qMulti.answer[0])
  ok(quiz.currentJudged === false, 'C3 多选只选一个还不判定')
  ok(quiz.currentRevealed === false, 'C3 多选未确认前不揭示答案')
  quiz.toggleOption(qMulti.answer[1])
  eq(quiz.currentPick.length, 2, 'C3 选中 2 个')
  quiz.reveal()
  ok(quiz.currentOk === true, 'C3 选全后确认 → 答对')
  ok(quiz.currentPick.join('') === qMulti.answer.join(''), 'C3 答案匹配')
}

// C4. 多选题漏选 → 错
{
  const q = byNo.get(12) // ABCD
  quiz.endSession()
  quiz.startSession({ mode: 'seq' })
  quiz.goTo(quiz.queue.indexOf(q.id))
  quiz.toggleOption('A')
  quiz.reveal()
  ok(quiz.currentOk === false, 'C4 多选漏选判错')
  ok(!!quiz.wrong[q.id], 'C4 漏选进错题本')
}

// C5. 判断题
{
  quiz.endSession()
  quiz.startSession({ mode: 'seq' })
  quiz.goTo(quiz.queue.indexOf(qJudgeTrue.id))
  eq(quiz.currentQuestion.type, 'judge', 'C5 判断题 type = judge')
  eq(quiz.currentQuestion.options.length, 2, 'C5 判断题有 2 个选项 T/F')
  quiz.toggleOption('T')
  ok(quiz.currentOk === true, 'C5 判断题选「正确」判对')

  quiz.goTo(quiz.queue.indexOf(qJudgeFalse.id))
  quiz.toggleOption('T') // 这题答案是「错误」，选 T 就错
  ok(quiz.currentOk === false, 'C5 判断题选反判错')
}

// C6. 「不会，看答案」→ 判定为错并进错题本
{
  const q = byNo.get(20)
  quiz.endSession()
  quiz.startSession({ mode: 'seq' })
  quiz.goTo(quiz.queue.indexOf(q.id))
  quiz.reveal({ markWrong: true })
  ok(quiz.currentRevealed === true, 'C6 看答案后揭示')
  ok(quiz.currentOk === false, 'C6 自认不会 → 判错')
  ok(!!quiz.wrong[q.id], 'C6 进错题本')
  ok(quiz.answers[q.id].skipped === true, 'C6 记录标记为 skipped')
}

// C7. 背题模式 peek → 亮答案但不算错、不进错题本
{
  const q = byNo.get(21)
  const before = quiz.wrongCount
  quiz.endSession()
  quiz.startSession({ mode: 'seq' })
  quiz.goTo(quiz.queue.indexOf(q.id))
  quiz.peek()
  ok(quiz.currentRevealed === true, 'C7 peek 后答案可见')
  ok(quiz.currentJudged === false, 'C7 peek 不判定')
  ok(quiz.currentIsPeek === true, 'C7 标记为「偷看」状态')
  eq(quiz.wrongCount, before, 'C7 偷看不污染错题本')
}

// C8. 收藏
{
  const q = byNo.get(30)
  quiz.toggleFav(q.id)
  ok(quiz.fav[q.id] === 1, 'C8 收藏成功')
  eq(quiz.favCount, 1, 'C8 收藏数 = 1')
  quiz.endSession()
  quiz.startSession({ mode: 'fav' })
  eq(quiz.queue.length, 1, 'C8 收藏练习只给收藏的题')
  eq(quiz.currentQid, q.id, 'C8 收藏练习给到的就是收藏题')
  quiz.endSession()
}

// C9. 考试模式：限时抽题 + 交卷计分
{
  quiz.resetProgress()
  quiz.startSession({ mode: 'exam', limit: 5, examMinutes: 10 })
  eq(quiz.queue.length, 5, 'C9 考试抽 5 道题')
  ok(quiz.isExam === true, 'C9 处于考试模式')
  ok(quiz.examRemainingNow() > 590 && quiz.examRemainingNow() <= 600, 'C9 倒计时约 600 秒')

  // 前 3 题答对，后 2 题留空
  for (let i = 0; i < 3; i++) {
    quiz.goTo(i)
    const q = quiz.currentQuestion
    q.answer.forEach((k) => quiz.toggleOption(k)) // 多选题要把答案全选上
    ok(quiz.currentJudged === false, `C9 考试中第 ${i + 1} 题答题后不判定`)
    ok(quiz.currentRevealed === false, `C9 考试中第 ${i + 1} 题不揭示答案`)
    eq(quiz.currentPick.length, q.answer.length, `C9 考试中第 ${i + 1} 题选中 ${q.answer.length} 项`)

    // 考试里单选/判断可以改答案，但永远不会变成多选
    if (q.type !== 'multiple') {
      const other = q.options.find((o) => o.key !== q.answer[0]).key
      quiz.toggleOption(other)
      eq(quiz.currentPick.length, 1, `C9 第 ${i + 1} 题（单选/判断）改答案后仍只有 1 个选项`)
      quiz.toggleOption(q.answer[0]) // 改回正确答案，不影响后面的计分
      eq(quiz.currentPick[0], q.answer[0], `C9 第 ${i + 1} 题答案能改回来`)
    }
  }
  ok(
    quiz.queue.slice(3).every((id) => (quiz.session.picks[id] || []).length === 0),
    'C9 后 2 题保持未作答',
  )
  const res = quiz.submitExam()
  eq(res.total, 5, 'C9 交卷：总题数 5')
  eq(res.answered, 3, 'C9 交卷：作答 3')
  eq(res.correct, 3, 'C9 交卷：答对 3')
  eq(res.unanswered, 2, 'C9 交卷：未作答 2')
  eq(res.score, 60, 'C9 交卷：得分 60')
  ok(quiz.session.submitted === true, 'C9 session 标记已交卷')
  ok(quiz.currentRevealed === true, 'C9 交卷后可以看答案')
}

// C10. sessionStats 成绩单
{
  const s = quiz.sessionStats
  eq(s.total, 5, 'C10 成绩单总题数 5')
  eq(s.ok, 3, 'C10 成绩单答对 3')
  eq(s.unanswered, 2, 'C10 成绩单未作答 2')
  eq(s.accuracy, 100, 'C10 已作答的正确率 100%')
  eq(s.score, 60, 'C10 卷面得分 60')
}

// C11. 练习完成 → finishPractice
{
  quiz.endSession()
  quiz.startSession({ mode: 'seq', filters: { from: 1, to: 2 } })
  eq(quiz.queue.length, 2, 'C11 题号范围筛选出 2 道')
  quiz.goTo(0)
  ok(quiz.next() === true, 'C11 可以翻到下一题')
  eq(quiz.currentIndex, 1, 'C11 当前在第 2 题')
  ok(quiz.next() === false, 'C11 最后一题不能再往下翻')
  quiz.finishPractice()
  ok(quiz.session.finished === true, 'C11 标记练习完成')
}

// C12. 题型 / 标签筛选
{
  quiz.endSession()
  quiz.startSession({ mode: 'seq', filters: { types: ['judge'] } })
  ok(quiz.queue.length === 90, 'C12 只看判断题 → 90 道', String(quiz.queue.length))
  quiz.endSession()
  const tag = bank.meta.tags[0].name
  quiz.startSession({ mode: 'seq', filters: { tags: [tag] } })
  ok(quiz.queue.length === bank.meta.tags[0].count, `C12 按标签「${tag}」筛选题数吻合`)
  quiz.endSession()
}

// C13. 随机模式确实打乱了顺序
{
  quiz.startSession({ mode: 'random' })
  const shuffled = quiz.queue.join(',')
  const straight = bank.questions.map((q) => q.id).join(',')
  ok(shuffled !== straight, 'C13 随机模式顺序与原顺序不同')
  eq(quiz.queue.length, 224, 'C13 随机模式题数不变')
  quiz.endSession()
}

// C14. 进度统计汇总
{
  quiz.resetProgress()
  quiz.startSession({ mode: 'seq', filters: { from: 1, to: 4 } })
  for (let i = 0; i < 4; i++) {
    quiz.goTo(i)
    const q = quiz.currentQuestion
    // 故意让第 3 题答错
    const key = i === 2 ? q.options.find((o) => o.key !== q.answer[0]).key : q.answer[0]
    quiz.toggleOption(key)
  }
  const st = quiz.stats
  eq(st.total, 224, 'C14 总题量仍是 224')
  eq(st.answered, 4, 'C14 已作答 4')
  eq(st.correct, 3, 'C14 答对 3')
  eq(st.accuracy, 75, 'C14 正确率 75%')
  eq(quiz.wrongCount, 1, 'C14 错题 1')
  ok(st.byType.single.total === 90, 'C14 分题型统计里单选题 90')
}

// C15. 连对次数（连对音效和「连对 N」徽标都靠它）
{
  quiz.resetProgress()
  quiz.startSession({ mode: 'seq', filters: { from: 1, to: 6 } })
  eq(quiz.streak, 0, 'C15 新会话连对从 0 开始')

  // 连答 3 题正确
  for (let i = 0; i < 3; i++) {
    quiz.goTo(i)
    const q = quiz.currentQuestion
    q.answer.forEach((k) => quiz.toggleOption(k))
    if (q.type === 'multiple') quiz.reveal()
  }
  eq(quiz.streak, 3, 'C15 连答 3 题正确 → 连对 3')

  // 再答对一题 → 4
  quiz.goTo(3)
  {
    const q = quiz.currentQuestion
    q.answer.forEach((k) => quiz.toggleOption(k))
    if (q.type === 'multiple') quiz.reveal()
  }
  eq(quiz.streak, 4, 'C15 继续答对 → 连对 4')

  // 答错一次 → 归零
  quiz.goTo(4)
  {
    const q = quiz.currentQuestion
    quiz.toggleOption(q.options.find((o) => o.key !== q.answer[0]).key)
  }
  eq(quiz.streak, 0, 'C15 答错一次 → 连对归零')

  // 「不会，看答案」也算断连
  quiz.goTo(5)
  quiz.reveal({ markWrong: true })
  eq(quiz.streak, 0, 'C15 主动看答案 → 连对保持 0')

  // 音效设置默认是开的，而且改设置不会抛错（Node 下 WebAudio 不存在，必须静默降级）
  ok(quiz.settings.sound === true, 'C15 答题音效默认开启')
  ok(typeof quiz.settings.soundVolume === 'number', 'C15 音量为数值')
  let threw = false
  try {
    quiz.setSetting('sound', false)
    quiz.setSetting('soundVolume', 0.3)
    quiz.setSetting('sound', true)
    quiz.setSetting('soundVolume', 0.5)
    quiz.toggleFav(byNo.get(1).id) // 收藏也会发声
  } catch (e) {
    threw = true
  }
  ok(!threw, 'C15 没有 WebAudio 的环境下音效相关调用静默降级、不抛错')
  quiz.endSession()
}

// C16. 笔记
{
  quiz.resetProgress()
  const q1 = byNo.get(1)
  const q2 = byNo.get(2)

  eq(quiz.noteCount, 0, 'C16 初始没有笔记')
  ok(quiz.noteOf(q1.id) === '', 'C16 没写过笔记时返回空串')
  ok(quiz.hasNote(q1.id) === false, 'C16 hasNote 为 false')

  // 写入
  const saved = quiz.setNote(q1.id, '  七大确立毛泽东思想为指导思想，别和七大「写入党章」搞混  ')
  ok(saved === true, 'C16 setNote 返回 true')
  eq(quiz.noteCount, 1, 'C16 笔记数 1')
  eq(
    quiz.noteOf(q1.id),
    '七大确立毛泽东思想为指导思想，别和七大「写入党章」搞混',
    'C16 首尾空白被 trim 掉了',
  )
  ok(quiz.hasNote(q1.id) === true, 'C16 hasNote 为 true')
  ok(!!quiz.notes[q1.id].ts && !!quiz.notes[q1.id].updatedAt, 'C16 记录了创建/更新时间')

  // 再写一条，且同一题重写不新增条数
  quiz.setNote(q2.id, '第二条笔记')
  eq(quiz.noteCount, 2, 'C16 又一题写了笔记 → 2 条')
  const firstTs = quiz.notes[q1.id].ts
  quiz.setNote(q1.id, '改过的内容')
  eq(quiz.noteCount, 2, 'C16 同一题重写不会多出一条')
  eq(quiz.notes[q1.id].text, '改过的内容', 'C16 内容被更新')
  eq(quiz.notes[q1.id].ts, firstTs, 'C16 首次创建时间保持不变')

  // 空内容 = 删除
  const cleared = quiz.setNote(q2.id, '   ')
  ok(cleared === false, 'C16 写空白返回 false')
  eq(quiz.noteCount, 1, 'C16 空白笔记等于删除')

  // 关键：重置进度不能把用户写的笔记清掉
  quiz.resetProgress()
  eq(quiz.noteCount, 1, 'C16 ★「重置进度」保留了笔记')
  eq(quiz.noteOf(q1.id), '改过的内容', 'C16 ★ 重置后笔记内容还在')

  // 有笔记的题列表 + 导出
  const noted = quiz.notedQuestions
  eq(noted.length, 1, 'C16 notedQuestions 只返回有笔记的题')
  eq(noted[0].id, q1.id, 'C16 就是写了笔记的那道题')

  const md = quiz.exportNotesMarkdown()
  ok(md.includes('改过的内容'), 'C16 导出的 Markdown 含笔记正文')
  ok(md.includes(q1.stem), 'C16 导出含题干')
  ok(md.includes('正确答案'), 'C16 导出含正确答案')
  ok(md.includes(`第 ${q1.no} 题`), 'C16 导出标注了题号')
  ok(md.includes('共 1 条'), 'C16 导出标注了条数')

  // 手动删除
  quiz.removeNote(q1.id)
  eq(quiz.noteCount, 0, 'C16 removeNote 后为 0')

  // 批量清空
  quiz.setNote(q1.id, 'a')
  quiz.setNote(q2.id, 'b')
  eq(quiz.noteCount, 2, 'C16 重新写两条')
  quiz.clearNotes()
  eq(quiz.noteCount, 0, 'C16 clearNotes 清空全部')

  quiz.endSession()
}

/* C9b. 倒计时必须真的会走 —— 「模拟考试时间不会变化」那个 bug 的回归测试 */
console.log('\n─── C9b. 考试倒计时会走 ───')
{
  // 先证明"用 getter 会被永久缓存"这件事是真的（否则这个 bug 会再回来）
  quiz.startSession({ mode: 'exam', limit: 3, examMinutes: 1 })
  ok(
    quiz.examRemaining === undefined,
    'C9b examRemaining 必须已经是 action 而不是 getter（getter 依赖不到 Date.now()，会被永久缓存）',
  )

  const t1 = quiz.examRemainingNow()
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const t2 = quiz.examRemainingNow()
  ok(t2 < t1, `C9b 1.1 秒后剩余时间必须变小（${t1}s -> ${t2}s）`)
  ok(t1 - t2 >= 1 && t1 - t2 <= 2, `C9b 减少的量要接近真实经过的秒数（减了 ${t1 - t2}s）`)
  quiz.endSession()
}

/* C17. 题库修正：用户改答案后要**立刻重判**，错题本跟着变 */
console.log('\n─── C17. 题库修正（答案/解析可改） ───')
{
  const q = bank.questions.find((x) => x.type === 'single')
  quiz.resetProgress()
  quiz.startSession({ mode: 'seq', filters: { from: q.no, to: q.no } })
  const mine = q.options.find((o) => o.key !== q.answer[0]).key

  quiz.toggleOption(mine)
  quiz.reveal()
  ok(quiz.wrongIds.includes(q.id), 'C17 先按题库答案判错，进了错题本')

  // 用户认为题库这条答案写错了，把自己的选择定为正确答案
  quiz.setAnswerOverride(q.id, [mine])
  ok(!quiz.wrongIds.includes(q.id), 'C17 ★ 改答案后**立刻重判**，错题本里被移除')
  eq(quiz.answers[q.id].ok, true, 'C17 作答记录也跟着改成了对')
  ok(quiz.isOverridden(q.id), 'C17 标记为"改过"（界面上要提示）')

  // 判定要真的走修正值：再答一次原题库答案，现在应该算错
  quiz.resetProgress()
  quiz.startSession({ mode: 'seq', filters: { from: q.no, to: q.no } })
  quiz.toggleOption(q.answer[0])
  quiz.reveal()
  eq(quiz.answers[q.id].ok, false, 'C17 按修正后的答案，原来的"正确选项"现在算错')

  // 解析：用户手写 > AI 补的 > 题库自带
  quiz.setAnalysisOverride(q.id, '我自己写的解析')
  eq(quiz.effectiveAnalysis(q.id), '我自己写的解析', 'C17 手写解析排最前')
  quiz.setAnalysisOverride(q.id, '')
  quiz.analyses[q.id] = 'AI 补的解析'
  eq(quiz.effectiveAnalysis(q.id), 'AI 补的解析', 'C17 没有手写时用 AI 补的')
  delete quiz.analyses[q.id]
  eq(quiz.effectiveAnalysis(q.id), q.analysis || '', 'C17 都没有时回落到题库自带')

  // 恢复（比字符串：eq 是严格相等，两个内容相同的数组也是 !== ）
  quiz.clearOverride(q.id)
  eq(
    quiz.effectiveAnswer(q.id).join(''),
    [...q.answer].sort().join(''),
    'C17 恢复后回到题库原答案',
  )
  ok(!quiz.isOverridden(q.id), 'C17 恢复后不再标记为改过')
  quiz.resetProgress()
}

/* C18. 庆祝特效的触发时机（store 只写状态，放特效由视图做） */
console.log('\n─── C18. 庆祝特效触发 ───')
{
  const q = bank.questions.find((x) => x.type === 'single')
  const wrongKey = q.options.find((o) => o.key !== q.answer[0]).key
  quiz.resetProgress()
  quiz.startSession({ mode: 'seq', filters: { from: q.no, to: q.no } })

  // 先答错，让它进错题本
  quiz.toggleOption(wrongKey)
  quiz.reveal()
  eq(quiz.lastFeedback, null, 'C18 答错不庆祝')

  // 再答一遍，答对 → 这是"拿下以前错过的题"
  quiz.resetProgress()
  quiz.startSession({ mode: 'seq', filters: { from: q.no, to: q.no } })
  quiz.toggleOption(q.answer[0])
  quiz.reveal()
  // 注意：上面 resetProgress 清掉了错题本，所以这次不算 redeem —— 这正是我们要的行为
  ok(
    quiz.lastFeedback === null || quiz.lastFeedback.kind !== 'redeem',
    'C18 清空进度后答对不算"拿下旧错题"（错题本已经空了）',
  )

  // 真的错题重做场景：错一次 → 再答对
  quiz.resetProgress()
  quiz.startSession({ mode: 'seq', filters: { from: q.no, to: q.no } })
  quiz.toggleOption(wrongKey)
  quiz.reveal()
  // 不清理进度，直接重做这道题（错题本里还留着）
  quiz.startSession({ mode: 'wrong' })
  quiz.toggleOption(q.answer[0])
  quiz.reveal()
  ok(quiz.lastFeedback?.kind === 'redeem', 'C18 ★ 答对以前错过的题 → redeem 特效')
  eq(quiz.lastFeedback.level, 1, 'C18 redeem 是 1 级')

  // 连对里程碑
  quiz.resetProgress()
  const singles = bank.questions.filter((x) => x.type === 'single').slice(0, 6)
  quiz.startSession({ mode: 'seq', filters: { from: singles[0].no, to: singles[singles.length - 1].no } })
  for (let i = 0; i < 5; i++) {
    const item = quiz.currentQuestion
    item.answer.forEach((k) => quiz.toggleOption(k))
    quiz.reveal()
    if (i < 4) quiz.goTo(i + 1)
  }
  eq(quiz.streak, 5, 'C18 连对 5 次')
  eq(quiz.lastFeedback?.kind, 'streak', 'C18 ★ 连对 5 → streak 特效（盖过 redeem）')
  eq(quiz.lastFeedback.level, 1, 'C18 5 连是 1 级')
  ok(quiz.lastFeedback.label.includes('5'), `C18 横幅文案带数字：${quiz.lastFeedback.label}`)
  quiz.resetProgress()
}

/* C19. 连对等级映射（连对 3 不该爆特效） */
{
  eq(celebrate.streakLevel(1), 0, 'C19 连对 1 没特效')
  eq(celebrate.streakLevel(3), 0, 'C19 ★ 连对 3 没特效（满地彩花就不值钱了）')
  eq(celebrate.streakLevel(5), 1, 'C19 连对 5 → 1 级')
  eq(celebrate.streakLevel(9), 1, 'C19 连对 9 → 仍是 1 级')
  eq(celebrate.streakLevel(10), 2, 'C19 连对 10 → 2 级')
  eq(celebrate.streakLevel(19), 2, 'C19 连对 19 → 仍是 2 级')
  eq(celebrate.streakLevel(20), 3, 'C19 连对 20 → 3 级')
  eq(celebrate.streakLevel(999), 3, 'C19 封顶 3 级')
  ok(celebrate.STREAK_MILESTONES.includes(5), 'C19 5 是里程碑')
  ok(!celebrate.STREAK_MILESTONES.includes(7), 'C19 7 不是里程碑')
}

/* ═══════════════════════ D. 学习报告统计（纯函数） ═══════════════════════ */
console.log('\n═══ D. 学习报告统计 ═══')

/** 用本地时间构造时间戳，避免测试结果随机器时区变化 */
const at = (y, m, d, hh = 10, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0).getTime()
const DAY = 86400000

// D1. 日期键用本地时区
{
  eq(A.dayKey(at(2026, 3, 9, 23, 30)), '2026-03-09', 'D1 深夜 23:30 算当天（不是 UTC 的第二天）')
  eq(A.dayKey(at(2026, 3, 9, 0, 5)), '2026-03-09', 'D1 凌晨 00:05 也算当天')
}

// D2. 按天聚合
{
  const history = [
    { q: 'q1', ok: 1, t: at(2026, 3, 9, 9), ms: 5000 },
    { q: 'q2', ok: 0, t: at(2026, 3, 9, 11), ms: 9000 },
    { q: 'q3', ok: 1, t: at(2026, 3, 10, 8), ms: 3000 },
  ]
  const daily = A.dailyStats(history)
  eq(Object.keys(daily).length, 2, 'D2 聚合成 2 天')
  eq(daily['2026-03-09'].n, 2, 'D2 9 号做了 2 题')
  eq(daily['2026-03-09'].ok, 1, 'D2 9 号对 1 题')
  eq(daily['2026-03-09'].ms, 14000, 'D2 9 号累计耗时 14 秒')
  eq(daily['2026-03-10'].n, 1, 'D2 10 号做了 1 题')
}

// D3. 连续打卡：今天没做但从昨天起连续，也要认
{
  const now = at(2026, 3, 10, 20)
  const mk = (days) => {
    const daily = {}
    for (const d of days) daily[A.dayKey(at(2026, 3, d, 10))] = { n: 1, ok: 1, ms: 0 }
    return daily
  }
  eq(A.streakDays(mk([10, 9, 8]), now), 3, 'D3 今天+前两天连续 → 3 天')
  eq(A.streakDays(mk([9, 8]), now), 2, 'D3 今天还没做，昨天起连续 → 仍算 2 天（不归零）')
  eq(A.streakDays(mk([8, 7]), now), 0, 'D3 只做到前天 → 断了，0 天')
  eq(A.streakDays({}, now), 0, 'D3 完全没记录 → 0 天')
  eq(A.streakDays(mk([10, 8]), now), 1, 'D3 今天做了、昨天没做 → 1 天（不跨过断点）')
}

// D4. 最近 N 天要补齐空白天，空白的正确率是 null 而不是 0
{
  const daily = A.dailyStats([
    { q: 'q1', ok: 1, t: at(2026, 3, 10, 9), ms: 0 },
    { q: 'q2', ok: 0, t: at(2026, 3, 10, 10), ms: 0 },
    { q: 'q3', ok: 1, t: at(2026, 3, 8, 10), ms: 0 },
  ])
  const days = A.recentDays(daily, 4, at(2026, 3, 10, 20))
  eq(days.length, 4, 'D4 返回 4 天')
  eq(days[3].key, '2026-03-10', 'D4 最后一天是今天')
  eq(days[3].n, 2, 'D4 今天做了 2 题')
  eq(days[3].accuracy, 50, 'D4 今天正确率 50%')
  eq(days[2].n, 0, 'D4 中间那天没做题')
  eq(days[2].accuracy, null, 'D4 ★ 没做题那天的正确率是 null，不是 0（否则趋势图看着像退步）')
  eq(days[1].accuracy, 100, 'D4 前天做了 1 题全对')
}

// D5. 知识点弱项：次数太少的标签不参与排序，弱的排前面
{
  const questions = [
    { id: 'q1', type: 'single', tags: ['毛泽东思想'] },
    { id: 'q2', type: 'single', tags: ['毛泽东思想'] },
    { id: 'q3', type: 'single', tags: ['毛泽东思想'] },
    { id: 'q4', type: 'single', tags: ['邓小平理论'] },
    { id: 'q5', type: 'single', tags: ['邓小平理论'] },
    { id: 'q6', type: 'single', tags: ['邓小平理论'] },
    { id: 'q7', type: 'single', tags: ['只做过一次'] },
  ]
  const history = [
    { q: 'q1', ok: 0 }, { q: 'q2', ok: 0 }, { q: 'q3', ok: 1 }, // 毛泽东思想 1/3
    { q: 'q4', ok: 1 }, { q: 'q5', ok: 1 }, { q: 'q6', ok: 1 }, // 邓小平理论 3/3
    { q: 'q7', ok: 0 }, // 只做过一次，不该出现
  ]
  const tags = A.tagStats(history, questions, { minAttempts: 3 })
  eq(tags.length, 2, 'D5 作答次数不足 3 的标签被过滤掉')
  eq(tags[0].name, '毛泽东思想', 'D5 正确率低的排前面')
  eq(tags[0].accuracy, 33, 'D5 毛泽东思想正确率 33%')
  eq(tags[1].accuracy, 100, 'D5 邓小平理论 100%')
  ok(
    A.tagStats(history, questions, { minAttempts: 1 }).length === 3,
    'D5 把门槛调到 1 就都能出现',
  )
}

// D6. 题型统计
{
  const questions = [
    { id: 'q1', type: 'single' },
    { id: 'q2', type: 'judge' },
    { id: 'q3', type: 'judge' },
  ]
  const types = A.typeStats([{ q: 'q1', ok: 1 }, { q: 'q2', ok: 0 }, { q: 'q3', ok: 1 }], questions)
  const judge = types.find((t) => t.type === 'judge')
  eq(judge.n, 2, 'D6 判断题做了 2 道')
  eq(judge.accuracy, 50, 'D6 判断题正确率 50%')
  eq(types.find((t) => t.type === 'single').accuracy, 100, 'D6 单选题 100%')
}

// D7. 耗时：用中位数而不是平均数，且排除离谱值
{
  const history = [
    { q: 'q1', ok: 1, ms: 4000 },
    { q: 'q2', ok: 1, ms: 6000 },
    { q: 'q3', ok: 1, ms: 5000 },
    { q: 'q4', ok: 1, ms: 100 }, // 误触，太短
    { q: 'q5', ok: 1, ms: 30 * 60 * 1000 }, // 中途走开了，太长
    { q: 'q6', ok: 1, ms: 0 }, // 考试交卷，没有逐题计时
  ]
  const t = A.timingStats(history)
  eq(t.samples, 3, 'D7 只保留 3 个合理样本（排除 100ms / 30min / 0）')
  eq(t.medianMs, 5000, 'D7 中位数 5 秒')
  eq(t.meanMs, 5000, 'D7 这里的平均数也是 5 秒')
  eq(t.maxMs, 6000, 'D7 最大值 6 秒')
  eq(t.slowest.length, 3, 'D7 slowest 返回全部 3 个样本')

  // 有一个超长样本时，中位数不受影响
  const skewed = A.timingStats([
    { q: 'a', ok: 1, ms: 3000 },
    { q: 'b', ok: 1, ms: 4000 },
    { q: 'c', ok: 1, ms: 600000 }, // 9 分钟，仍在合理区间内
  ])
  eq(skewed.medianMs, 4000, 'D7 ★ 中位数不被超长样本带跑（平均数会被拉到 20 万毫秒）')
  ok(skewed.meanMs > 100000, `D7 平均数确实被拉飞了（${skewed.meanMs}ms）—— 所以界面上用中位数`)
}

// D8. 最长连对
{
  const rows = [
    { q: 'a', ok: 1, t: 1 }, { q: 'b', ok: 1, t: 2 }, { q: 'c', ok: 1, t: 3 },
    { q: 'd', ok: 0, t: 4 },
    { q: 'e', ok: 1, t: 5 }, { q: 'f', ok: 1, t: 6 },
  ]
  eq(A.longestStreak(rows), 3, 'D8 最长连对 3')
  eq(A.longestStreak([{ q: 'a', ok: 0, t: 1 }]), 0, 'D8 全错 → 0')
  eq(A.longestStreak([]), 0, 'D8 空历史 → 0')
}

// D9. 热力图矩阵
{
  const daily = A.dailyStats([{ q: 'q1', ok: 1, t: at(2026, 3, 10, 9), ms: 0 }])
  const now = at(2026, 3, 10, 20)
  const heat = A.heatmapWeeks(daily, 12, now)
  eq(heat.columns.length, 12, 'D9 12 列（周）')
  eq(heat.columns[0].length, 7, 'D9 每列 7 天')
  eq(heat.max, 1, 'D9 最大值 1')

  const flat = heat.columns.flat()
  eq(flat.filter((c) => c.key === '2026-03-10').length, 1, 'D9 今天在矩阵里出现且只出现一次')
  const todayCell = flat.find((c) => c.key === '2026-03-10')
  eq(todayCell.future, false, 'D9 今天不是未来')
  eq(todayCell.n, 1, 'D9 今天那格是 1')
  ok(
    flat.some((c) => c.future),
    'D9 本周今天之后的日子标成 future（画成浅灰而不是"没做题"）',
  )
  // 列首应该是周一
  for (const col of heat.columns) {
    eq(new Date(col[0].ts).getDay(), 1, 'D9 每列第 0 行是周一')
  }
}

// D10. 汇总
{
  const questions = [
    { id: 'q1', type: 'single', tags: ['甲'] },
    { id: 'q2', type: 'judge', tags: ['甲'] },
  ]
  const history = [
    { q: 'q1', ok: 1, t: at(2026, 3, 9), ms: 4000 },
    { q: 'q2', ok: 0, t: at(2026, 3, 10), ms: 6000 },
    { q: null, ok: 1, t: at(2026, 3, 10), ms: 0 }, // 脏数据不该让统计崩
  ]
  const rep = A.buildReport(history, questions, { now: at(2026, 3, 10, 20), weeks: 8, trendDays: 5 })
  eq(rep.total, 3, 'D10 总数 3')
  eq(rep.correct, 2, 'D10 对 2')
  eq(rep.accuracy, 67, 'D10 正确率 67%')
  eq(rep.activeDays, 2, 'D10 活跃 2 天')
  eq(rep.streak, 2, 'D10 连续 2 天')
  eq(rep.trend.length, 5, 'D10 趋势 5 天')
  eq(rep.heatmap.columns.length, 8, 'D10 热力图 8 周')
  eq(rep.totalMs, 10000, 'D10 总耗时 10 秒')

  const empty = A.buildReport([], questions, { now: at(2026, 3, 10) })
  eq(empty.total, 0, 'D10 空历史：总数 0')
  eq(empty.accuracy, 0, 'D10 空历史：正确率 0（不是 NaN）')
  eq(empty.tags.length, 0, 'D10 空历史：没有弱项')
  eq(empty.streak, 0, 'D10 空历史：连续 0 天')
}

// D11. 时长说法
{
  eq(A.humanDuration(45000), '45 秒', 'D11 45 秒')
  eq(A.humanDuration(90 * 1000), '1 分 30 秒', 'D11 1 分 30 秒')
  eq(A.humanDuration(3 * 3600 * 1000 + 12 * 60000), '3 小时 12 分', 'D11 3 小时 12 分')
  eq(A.humanDuration(0), '0 秒', 'D11 0 秒')
}

/* ═══════════════════ E. 知识图谱（纯逻辑：力模拟 / 弱点热力 / 筛题） ═══════════════════ */
console.log('\n═══ E. 知识图谱纯逻辑 ═══')

// E1. 知识点名 ↔ 题目标签的匹配
{
  eq(G.normalizeTag('  生产力 与 生产关系 '), '生产力与生产关系', 'E1 标签归一化去掉空白（含全角）')
  eq(G.normalizeTag('AB'), 'ab', 'E1 归一化转小写')
  eq(G.matchTag('实事求是', ['实事求是', '毛泽东思想']), '实事求是', 'E1 完全相等 → 命中')
  eq(G.matchTag('党的建设', ['党的建设 ']), '党的建设 ', 'E1 归一化后相等 → 命中（返回题库里的原名）')
  eq(
    G.matchTag('实事求是', ['实事求是的思想路线']),
    '实事求是的思想路线',
    'E1 唯一的包含关系 → 命中（模型常把标签写全）',
  )
  eq(
    G.matchTag('实事求是', ['实事求是的思想路线', '实事求是活的灵魂']),
    '',
    'E1 ★ 包含关系有歧义时宁可不猜（否则会把不相干的题算进这个知识点）',
  )
  eq(G.matchTag('模型瞎起的名字', ['毛泽东思想']), '', 'E1 对不上 → 空串')
  eq(G.matchTag('', ['毛泽东思想']), '', 'E1 空节点名 → 空串')
}

// E2. 弱点统计：复用 analytics.tagStats，没做过的是 null 而不是 0
{
  const questions = [
    { id: 'q1', tags: ['毛泽东思想'] },
    { id: 'q2', tags: ['毛泽东思想'] },
    { id: 'q3', tags: ['毛泽东思想'] },
    { id: 'q4', tags: ['邓小平理论'] },
    { id: 'q5', tags: ['邓小平理论'] },
    { id: 'q6', tags: [] },
  ]
  const history = [
    { q: 'q1', ok: 0 }, { q: 'q2', ok: 0 }, { q: 'q3', ok: 1 }, // 毛泽东思想 1/3
    { q: 'q4', ok: 1 }, { q: 'q5', ok: 1 }, // 邓小平理论 2/2
  ]
  const nodes = [
    { id: 'k1', label: '毛泽东思想', kind: '章', weight: 5 },
    { id: 'k2', label: '邓小平理论', kind: '节', weight: 3 },
    { id: 'k3', label: '模型自己起的名', kind: '点', weight: 2 },
  ]
  const stats = G.nodeStats(nodes, history, questions)

  eq(stats.size, 3, 'E2 每个节点都有一条统计')
  eq(stats.get('k1').n, 3, 'E2 毛泽东思想做过 3 次')
  eq(stats.get('k1').accuracy, 33, 'E2 毛泽东思想正确率 33%')
  eq(stats.get('k1').wrong, 2, 'E2 毛泽东思想错 2 道')
  eq(stats.get('k2').accuracy, 100, 'E2 邓小平理论 100%')
  eq(stats.get('k3').n, 0, 'E2 对不上标签的节点：作答数 0')
  eq(stats.get('k3').accuracy, null, 'E2 ★ 没做过时正确率是 null（不是 0，否则看着像全军覆没）')

  // 报告页用同一个函数、同样的口径：门槛调成 1 时图谱写的是同一份数据
  const reportStyle = A.tagStats(history, questions, { minAttempts: 1 })
  eq(reportStyle[0].accuracy, stats.get('k1').accuracy, 'E2 ★ 图谱与报告页的正确率出自同一个 tagStats')

  // 「最该补的知识点」排序
  eq(G.weaknessScore(stats.get('k3')), -1, 'E2 没做过的排序分是 -1（不是最弱，是没数据）')
  ok(
    G.weaknessScore(stats.get('k1')) > G.weaknessScore(stats.get('k2')),
    'E2 正确率低 + 错得多 → 排序分更高',
  )
  const ranked = G.rankWeakNodes(stats, 5)
  eq(ranked.length, 2, 'E2 排序只收有作答数据的节点')
  eq(ranked[0].id, 'k1', 'E2 最该补的是毛泽东思想')
  eq(G.rankWeakNodes(stats, 1).length, 1, 'E2 limit 生效')
}

// E3. 弱点着色 / 节点大小
{
  eq(G.weaknessLevel(null), -1, 'E3 没做过 → 等级 -1（灰）')
  eq(G.weaknessLevel(undefined), -1, 'E3 undefined 也算没做过')
  eq(G.weaknessLevel(0), 3, 'E3 全错 → 3 级')
  eq(G.weaknessLevel(49), 3, 'E3 49% 仍是 3 级')
  eq(G.weaknessLevel(50), 2, 'E3 50% → 2 级')
  eq(G.weaknessLevel(69), 2, 'E3 69% → 2 级')
  eq(G.weaknessLevel(70), 1, 'E3 70% → 1 级')
  eq(G.weaknessLevel(84), 1, 'E3 84% → 1 级')
  eq(G.weaknessLevel(85), 0, 'E3 85% → 0 级（掌握良好）')
  eq(G.weaknessLevel(100), 0, 'E3 100% → 0 级')

  eq(G.levelColor(-1), G.UNKNOWN_COLOR, 'E3 没做过用中性灰')
  eq(G.levelColor(3), '#ef4444', 'E3 3 级是红')
  eq(G.levelColor(0), '#10b981', 'E3 0 级是绿')
  eq(G.levelColor(99), G.UNKNOWN_COLOR, 'E3 越界等级兜底成灰，不返回 undefined')
  eq(G.levelLabel(3), '重点补强', 'E3 等级文案')
  eq(G.levelLabel(-1), '还没做过', 'E3 没做过的文案')

  ok(G.nodeRadius(4) > G.nodeRadius(0), 'E3 做过的题越多，节点越大')
  ok(G.nodeRadius(400) > G.nodeRadius(4), 'E3 半径随作答数单调递增')
  ok(G.nodeRadius(100000) <= 32, 'E3 ★ 半径有上限（不然一个热门知识点会把画布撑爆）')
  eq(G.nodeRadius(100000), G.nodeRadius(10000), 'E3 作答数再大半径也饱和，不会一直涨')
  eq(G.nodeRadius(0, 1), 10, 'E3 半径有下限')
  ok(G.nodeRadius(0, 5) > G.nodeRadius(0, 1), 'E3 后端给的 weight 能微调半径')
  ok(G.nodeRadius(10, 3, 5) > G.nodeRadius(10, 3, 0), 'E3 ★ 同样做过 10 道，错 5 道的节点更大（错题数也进大小）')
  ok(G.nodeRadius(10, 3, 99) - G.nodeRadius(10, 3, 0) <= 5, 'E3 错题数对大小的加成有上限，不会盖过"做过多少"')

  eq(G.hasWrongMark({ wrong: 1 }), true, 'E3 有错题 → 画红环')
  eq(G.hasWrongMark({ wrong: 0 }), false, 'E3 没错题 → 不画')
  eq(G.hasWrongMark(null), false, 'E3 没有统计时也不炸')
}

// E4. 力模拟的单步更新（自己写的力导向布局）
{
  // 4.1 斥力：两个孤立的点靠得近，应该被推开
  const close = {
    nodes: [
      { id: 'a', x: 400, y: 300, vx: 0, vy: 0 },
      { id: 'b', x: 430, y: 300, vx: 0, vy: 0 },
    ],
    edges: [],
    width: 900,
    height: 620,
  }
  const pushed = G.stepLayout(close)
  const distOf = (s) => Math.hypot(s.nodes[1].x - s.nodes[0].x, s.nodes[1].y - s.nodes[0].y)
  ok(distOf(pushed) > 30, `E4 节点斥力：30px → ${distOf(pushed).toFixed(1)}px（被推开）`)
  eq(close.nodes[0].x, 400, 'E4 ★ 纯函数：不修改传进来的 state')

  // 4.2 完全重叠也不能除以 0（NaN 会把整张图画没）
  const overlap = {
    nodes: [
      { id: 'a', x: 400, y: 300, vx: 0, vy: 0 },
      { id: 'b', x: 400, y: 300, vx: 0, vy: 0 },
      { id: 'c', x: 400, y: 300, vx: 0, vy: 0 },
    ],
    edges: [],
    width: 900,
    height: 620,
  }
  const spread = G.runLayout(overlap, 30)
  ok(
    spread.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)),
    'E4 ★ 三个点完全重叠也能算出有限坐标（不出现 NaN）',
  )
  ok(
    Math.hypot(spread.nodes[1].x - spread.nodes[0].x, spread.nodes[1].y - spread.nodes[0].y) > 1,
    'E4 重叠的点被斥力分开',
  )

  // 4.3 边弹簧：连着边、隔得很远，应该被拉近（把斥力和向心力关掉只看弹簧）
  const far = {
    nodes: [
      { id: 'a', x: 150, y: 300, vx: 0, vy: 0 },
      { id: 'b', x: 650, y: 300, vx: 0, vy: 0 },
    ],
    edges: [{ from: 'a', to: 'b' }],
    width: 900,
    height: 620,
  }
  const pulled = G.stepLayout(far, { repulsion: 0, gravity: 0, damping: 1 })
  ok(distOf(pulled) < 500, `E4 边弹簧：500px → ${distOf(pulled).toFixed(1)}px（被拉近）`)

  // 弹簧也会把"被压得太短"的边推开
  const tight = {
    nodes: [
      { id: 'a', x: 440, y: 300, vx: 0, vy: 0 },
      { id: 'b', x: 460, y: 300, vx: 0, vy: 0 },
    ],
    edges: [{ from: 'a', to: 'b' }],
    width: 900,
    height: 620,
  }
  const loosened = G.stepLayout(tight, { repulsion: 0, gravity: 0, damping: 1 })
  ok(distOf(loosened) > 20, 'E4 弹簧被压短时会往外推（自然长度 150px）')

  // 4.4 阻尼 + 收敛：能量必须一路降下去，视图才敢在静止后停掉 rAF
  const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `k${i}`, label: `n${i}`, weight: (i % 5) + 1 }))
  const edges = []
  for (let i = 1; i < 12; i++) edges.push({ from: `k${Math.floor(i / 2)}`, to: `k${i}` })
  const start = G.initLayout(nodes, edges, { width: 900, height: 620 })
  eq(start.nodes.length, 12, 'E4 初始布局给每个节点都放了位置')
  eq(start.edges.length, 11, 'E4 边原样带进布局状态')
  eq(G.layoutEnergy(start), 0, 'E4 初始速度都是 0')

  const e5 = G.layoutEnergy(G.runLayout(start, 5))
  const e60 = G.layoutEnergy(G.runLayout(start, 60))
  const e200 = G.layoutEnergy(G.runLayout(start, 200))
  ok(e5 > e60 && e60 > e200, `E4 ★ 能量单调下降：${e5.toFixed(1)} → ${e60.toFixed(2)} → ${e200.toFixed(3)}`)
  ok(e200 < 1, 'E4 200 步之后基本静止（能停 rAF，不空转烧 CPU）')

  const settled = G.runLayout(start, 400)
  ok(
    settled.nodes.every(
      (n) =>
        Number.isFinite(n.x) &&
        n.x >= 24 &&
        n.x <= 876 &&
        n.y >= 24 &&
        n.y <= 596,
    ),
    'E4 节点被限制在画布范围内（不会跑没影）',
  )

  // 4.5 正在拖的节点（pinned）在模拟里不动
  const dragging = {
    nodes: [
      { id: 'a', x: 300, y: 300, vx: 0, vy: 0, pinned: true },
      { id: 'b', x: 340, y: 300, vx: 0, vy: 0 },
    ],
    edges: [{ from: 'a', to: 'b' }],
    width: 900,
    height: 620,
  }
  const dragged = G.stepLayout(dragging)
  eq(dragged.nodes[0].x, 300, 'E4 ★ 被拖住的节点不动（否则拖拽会跟模拟打架）')
  eq(dragged.nodes[0].y, 300, 'E4 被拖住的节点 y 也不动')
  ok(dragged.nodes[1].x !== 340, 'E4 其它节点照常参与布局')
}

// E5. 点节点筛题
{
  const questions = [
    { id: 'q1', no: 1, type: 'single', stem: '甲', answer: ['A'], tags: ['毛泽东思想'] },
    { id: 'q2', no: 2, type: 'single', stem: '乙', answer: ['A'], tags: ['邓小平理论'] },
    { id: 'q3', no: 3, type: 'single', stem: '丙', answer: ['A'], tags: [] },
    { id: 'q4', no: 4, type: 'single', stem: '丁', answer: ['A'], tags: ['三大法宝'] },
  ]
  const graph = {
    nodes: [
      { id: 'k1', label: '毛泽东思想', kind: '章', weight: 5 },
      { id: 'k2', label: '邓小平理论', kind: '节', weight: 3 },
      { id: 'k3', label: '不存在的概念', kind: '点', weight: 2 },
    ],
    edges: [{ from: 'k1', to: 'k2', label: '发展' }],
  }

  const own = G.nodeQuestions('k1', graph, questions, { withNeighbors: false })
  eq(own.ids.join(','), 'q1', 'E5 只算自己：k1 → q1')
  eq(own.ownTag, '毛泽东思想', 'E5 报出对上的标签')

  const withNear = G.nodeQuestions('k1', graph, questions)
  eq(withNear.ids.join(','), 'q1,q2', 'E5 ★ 含相邻知识点：k1 还能筛到 k2（邓小平理论）的题')
  eq(withNear.neighborTags.join(','), '邓小平理论', 'E5 相邻知识点的标签单独列出')
  eq(
    G.nodeQuestions('k2', graph, questions).ids.join(','),
    'q1,q2',
    'E5 关系是无向的：点 k2 也能筛到 k1 的题',
  )

  const none = G.nodeQuestions('k3', graph, questions)
  eq(none.ids.length, 0, 'E5 对不上标签的节点筛不出题')
  eq(none.tags.length, 0, 'E5 没有可用标签')
  eq(G.nodeQuestions('不存在', graph, questions).ids.length, 0, 'E5 节点不存在时返回空，不抛错')

  eq(G.neighborsOf('k1', graph.edges).join(','), 'k2', 'E5 邻居查询（有向关系两边都算）')
  eq(G.neighborsOf('k2', graph.edges).join(','), 'k1', 'E5 反向也算邻居')

  // ★ 和图谱筛选**完全一致**的题，必须能用 store 既有的 startSession 起出来
  const tag = bank.meta.tags[0].name
  const realGraph = { nodes: [{ id: 'r1', label: tag, kind: '章', weight: 5 }], edges: [] }
  const rel = G.nodeQuestions('r1', realGraph, bank.questions)
  eq(rel.ids.length, bank.meta.tags[0].count, 'E5 真实题库：节点筛出的题数 = 标签题数')
  quiz.endSession()
  quiz.startSession({ mode: 'seq', filters: { tags: [...rel.tags] } })
  eq(quiz.queue.join(','), rel.ids.join(','), 'E5 ★ 图谱筛题与 startSession 的队列完全一致（同一套口径）')
  quiz.endSession()
}

// E6. 抽样、payload 与后端返回的兜底整理
{
  const many = Array.from({ length: 224 }, (_, i) => ({ id: `q${i + 1}`, no: i + 1, tags: [] }))
  const picked = G.sampleQuestions(many, 120)
  eq(picked.length, 120, 'E6 超过上限时抽到 120 道（后端硬上限）')
  eq(new Set(picked.map((q) => q.id)).size, 120, 'E6 抽样不重复')
  const indices = picked.map((q) => many.indexOf(q))
  ok(
    indices.every((v, i) => i === 0 || v > indices[i - 1]),
    'E6 ★ 抽样是均匀取样（保持原顺序、不截断），不是"取前 120 道"',
  )
  ok(indices[indices.length - 1] > 200, 'E6 抽到了靠后的题（题库是按章节排的，截断会丢掉后面几章）')
  const few = G.sampleQuestions(many.slice(0, 30), 120)
  eq(few.length, 30, 'E6 不够上限就全给')
  ok(few !== many.slice(0, 30), 'E6 返回的是副本，不共享调用方的数组')
  eq(G.sampleQuestions([], 120).length, 0, 'E6 空输入不炸')

  const payload = G.graphPayload([
    { id: 'q1', no: 7, type: 'single', stem: '题干', answer: ['A'], tags: ['甲'], analysis: '不要传' },
  ])
  eq(payload.length, 1, 'E6 payload 逐题映射')
  eq(Object.keys(payload[0]).join(','), 'no,type,stem,answer,tags', 'E6 ★ 只传后端要的字段（少占上下文）')
  eq(payload[0].tags.join(','), '甲', 'E6 标签带上（提示词让模型复用标签）')
  eq(G.graphPayload([{ id: 'x', no: 1, stem: 's' }])[0].tags.join(','), '', 'E6 没标签时给空数组')

  // 后端返回的兜底整理：悬空边/重复节点/自环都要丢掉，而不是让视图崩
  const raw = {
    ok: true,
    sampled: 40,
    warnings: ['丢掉了 2 条指向不存在知识点的关系'],
    nodes: [
      { id: 'k1', label: '甲', kind: '章', weight: 9 },
      { id: 'k1', label: '重复的', kind: '点', weight: 3 },
      { id: 'k2', name: '乙', weight: 0 },
      { id: '', label: '没 id', weight: 3 },
      { id: 'k3', label: '  ', weight: 3 },
    ],
    edges: [
      { from: 'k1', to: 'k2', label: '包含' },
      { from: 'k1', to: 'k9', label: '悬空' },
      { from: 'k2', to: 'k2' },
      { from: 'k1', to: 'k2', label: '包含' },
      { from: 'k1', label: '缺目标' },
    ],
  }
  const clean = G.normalizeGraph(raw)
  eq(clean.nodes.length, 2, 'E6 重复 id / 空 id / 空名字的节点被丢掉')
  eq(clean.nodes[0].weight, 5, 'E6 weight 被夹到 1~5')
  eq(clean.nodes[1].label, '乙', 'E6 name 兜底成 label')
  eq(clean.nodes[1].weight, 1, 'E6 ★ 显式 weight 0 夹到 1（不静默改成默认的 3）')
  eq(G.normalizeWeight(undefined), 3, 'E6 没给 weight → 默认 3')
  eq(G.normalizeWeight('4'), 4, 'E6 字符串数字也能认')
  eq(G.normalizeWeight('  '), 3, 'E6 空白 → 默认 3')
  eq(G.normalizeWeight(99), 5, 'E6 超上限夹到 5')
  eq(clean.edges.length, 1, 'E6 ★ 悬空边 / 自环 / 重复边都被丢掉')
  eq(clean.edges[0].label, '包含', 'E6 边的关系短语保留')
  eq(clean.sampled, 40, 'E6 sampled 透传（界面上要显示"归纳了多少道"）')
  eq(clean.warnings.length, 1, 'E6 warnings 透传（后端丢掉了多少条边要告诉用户）')

  const empty = G.normalizeGraph(null)
  eq(empty.nodes.length, 0, 'E6 后端什么都没返回时是空图谱，不抛错')
  eq(empty.edges.length, 0, 'E6 空图谱没有边')
  eq(empty.warnings.length, 0, 'E6 空图谱没有警告')
}

/* ═══════════════════ F. 图笔记（纯逻辑：编辑 / 撤销 / Mermaid 互转） ═══════════════════ */
console.log('\n═══ F. 图笔记（纯逻辑）═══')

// F1. 增删节点与边
{
  let d = D.emptyDiagram()
  d = D.addNode(d, { text: '马克思主义中国化', x: 10, y: 20 })
  d = D.addNode(d, { text: '毛泽东思想', x: 300, y: 20 })
  eq(d.nodes.length, 2, 'F1 加两个节点')
  eq(d.nodes[0].id, 'n1', 'F1 第一个节点 id = n1')
  eq(d.nodes[1].id, 'n2', 'F1 第二个节点 id = n2')
  eq(d.nodes[0].x, 10, 'F1 落点 x 被采用')
  ok(d.nodes[0].w > 0 && d.nodes[0].h > 0, 'F1 节点自带尺寸（命中检测不用反复估文字宽）')

  d = D.addEdge(d, 'n1', 'n2', '包含')
  eq(d.edges.length, 1, 'F1 加一条边')
  eq(d.edges[0].id, 'e1', 'F1 边 id = e1')
  eq(d.edges[0].label, '包含', 'F1 边标签存下了')

  // 自环 / 重复边 / 悬空边都要拒绝
  const before = d
  eq(D.addEdge(d, 'n1', 'n1').edges.length, 1, 'F1 拒绝自环')
  eq(D.addEdge(d, 'n1', 'n2').edges.length, 1, 'F1 拒绝重复边（同方向）')
  eq(D.addEdge(d, 'n1', 'n9').edges.length, 1, 'F1 拒绝指向不存在节点的边')
  ok(D.addEdge(d, 'n1', 'n1') === before, 'F1 被拒绝的改动静默返回原对象（不长出无意义的历史）')

  // ★ 删节点必须把挂在它身上的边一起删，否则会留下指向空气的边
  const cut = D.removeNode(d, 'n1')
  eq(cut.nodes.length, 1, 'F1 删掉一个节点')
  eq(cut.edges.length, 0, 'F1 ★ 删节点时相关边跟着删掉')

  d = D.removeEdge(d, 'e1')
  eq(d.edges.length, 0, 'F1 删边')
  d = D.removeEdge(d, 'e1')
  eq(d.edges.length, 0, 'F1 重复删边不报错')

  // 不可变约定：上面这些操作都不该改到旧的 d
  const snapshot = D.emptyDiagram()
  const fresh = D.addNode(snapshot, { text: '甲', x: 0, y: 0 })
  eq(snapshot.nodes.length, 0, 'F1 ★ 所有操作都不改传入的图（撤销栈才能只存引用）')
  eq(fresh.nodes.length, 1, 'F1 返回的是新图')
}

// F2. 改文字 / 改形状 / 移动
{
  let d = D.emptyDiagram()
  d = D.addNode(d, { text: '甲', x: 100, y: 100 })
  const id = d.nodes[0].id
  const widthBefore = d.nodes[0].w

  d = D.setNodeText(d, id, '这是一句明显更长的节点文字')
  ok(d.nodes[0].w > widthBefore, 'F2 改长文字后节点变宽（尺寸跟着重算）')
  const gap = D.setNodeText(d, id, '   ')
  ok(gap === d, 'F2 空文字被拒绝（要删就删节点，不留没名字的框）')

  d = D.setNodeShape(d, id, 'circle')
  eq(d.nodes[0].shape, 'circle', 'F2 改形状')
  ok(d.nodes[0].w === d.nodes[0].h, 'F2 圆形节点宽高相等')
  const bad = D.setNodeShape(d, id, 'triangle')
  ok(bad === d, 'F2 不认识的形状被拒绝')

  d = D.moveNode(d, id, 5, 6)
  eq(d.nodes[0].x, 5, 'F2 移动 x')
  eq(d.nodes[0].y, 6, 'F2 移动 y')
  ok(D.moveNode(d, id, 5, 6) === d, 'F2 移到原地不算一次改动')

  eq(D.SHAPES.length, 4, 'F2 支持 4 种形状')
  eq(D.SHAPE_LABEL.circle, '圆形', 'F2 形状有中文名给界面用')
}

// F3. 命中检测
{
  let d = D.emptyDiagram()
  d = D.addNode(d, { id: 'a', text: '甲', x: 100, y: 100 })
  d = D.addNode(d, { id: 'b', text: '乙', x: 400, y: 100 })

  eq(D.hitTest(d, 100, 100)?.id, 'a', 'F3 点在节点正中 → 命中')
  eq(D.hitTest(d, 0, 0), null, 'F3 点在空白处 → 不命中')

  const box = D.nodeBox(d.nodes[0])
  const inside = D.hitTest(d, box.x + 2, box.y + 2)
  eq(inside.id === 'a' && inside.type === 'node', true, 'F3 点在边上一点也算命中节点')

  // 边的命中：两点连线中点，但要离节点远一点
  d = D.addEdge(d, 'a', 'b')
  const mid = D.hitTest(d, 250, 100)
  eq(mid?.type, 'edge', 'F3 点在两点连线上 → 命中边')
  eq(mid?.id, 'e1', 'F3 命中的是正确的边')

  // 菱形：包围盒的角**不该**算命中，否则"看着在外面却能选中"
  let dm = D.emptyDiagram()
  dm = D.addNode(dm, { id: 'x', text: '菱形', shape: 'diamond', x: 0, y: 0 })
  const n = dm.nodes[0]
  ok(D.pointInNode(n, 0, 0), 'F3 菱形中心命中')
  ok(!D.pointInNode(n, n.w / 2 - 1, n.h / 2 - 1), 'F3 ★ 菱形的角不算命中（用内接判定，不是包围盒）')

  // 节点优先于边：边从中心出发，节点必须能选中
  const atCenter = D.hitTest(d, 100, 100)
  eq(atCenter?.type, 'node', 'F3 ★ 节点优先于边（否则被边压住的节点永远选不中）')

  // 手柄
  const handle = D.handleCenter(d.nodes[0])
  eq(D.hitTest(d, handle.x, handle.y)?.type, 'handle', 'F3 连边手柄能被单独命中')

  // 箭头端点必须落在节点边界上（不能连到中心，否则线穿进方框里）
  const a = d.nodes[0]
  const anchor = D.edgeAnchor(a, 400, 100)
  ok(Math.abs(anchor.x - (a.x + a.w / 2)) < 0.01, 'F3 ★ 箭头端点落在节点右边界上')
  ok(Math.abs(anchor.y - a.y) < 0.01, 'F3 水平连线的端点在同一高度')
  ok(!D.pointInNode(a, anchor.x + 0.5, anchor.y), 'F3 端点稍稍往外就出了节点（确实贴着边）')

  // 斜着连：端点必须还在轮廓上（用同一套判据，所以一定在边界附近）
  // 注意 pointInNode 用的是 <=，边界本身算"在里面"，所以这里断言的是
  // "端点刚好在边界上、再往外半像素就出去"
  const diag = D.edgeAnchor(a, a.x + 300, a.y + 300)
  ok(D.pointInNode(a, diag.x, diag.y), 'F3 斜向端点正好落在轮廓上（边界算在内）')
  ok(!D.pointInNode(a, diag.x + 0.5, diag.y + 0.5), 'F3 端点再往外半像素就出节点了')
  const selfAnchor = D.edgeAnchor({ x: 0, y: 0, w: 10, h: 10, shape: 'rect' }, 0, 0)
  eq(selfAnchor.x, 0, 'F3 目标和中心重合时返回中心（不除零）')
}

// F4. 撤销 / 重做
{
  let d = D.emptyDiagram()
  const h = D.createHistory(5)

  // 两个节点 + 一步
  let next = D.addNode(d, { id: 'a', text: '甲', x: 0, y: 0 })
  D.record(h, d, '新建节点')
  d = next
  next = D.addNode(d, { id: 'b', text: '乙', x: 200, y: 0 })
  D.record(h, d, '新建节点')
  d = next
  eq(d.nodes.length, 2, 'F4 做了两步，图里有 2 个节点')
  ok(D.canUndo(h), 'F4 可以撤销')
  eq(D.undoLabel(h), '新建节点', 'F4 撤销按钮能显示"要撤的是哪一步"')

  const step1 = D.undo(h, d)
  eq(step1.diagram.nodes.length, 1, 'F4 撤销一步 → 剩 1 个节点')
  d = step1.diagram
  const step2 = D.undo(h, d)
  eq(step2.diagram.nodes.length, 0, 'F4 撤销两步 → 空图')
  d = step2.diagram

  // 边界：撤到底
  eq(D.undo(h, d), null, 'F4 ★ 撤到底返回 null，不抛错')
  ok(!D.canUndo(h), 'F4 撤到底后 canUndo = false')

  const back1 = D.redo(h, d)
  eq(back1.diagram.nodes.length, 1, 'F4 重做一步')
  d = back1.diagram
  const back2 = D.redo(h, d)
  eq(back2.diagram.nodes.length, 2, 'F4 重做两步，回到 2 个节点')
  d = back2.diagram
  eq(D.redo(h, d), null, 'F4 ★ 重做到底返回 null')
  ok(!D.canRedo(h), 'F4 重做到底后 canRedo = false')

  // 撤销之后再做一个新动作：原来的重做链必须作废
  const u = D.undo(h, d)
  d = u.diagram
  // 注意：作废重做链是 record() 的职责 —— 光加节点不记录，栈当然不会变
  ok(D.canRedo(h), 'F4 只改图不记录时，重做链还在（历史只由 record 维护）')
  D.record(h, d, '新建节点')
  d = D.addNode(d, { id: 'c', text: '丙', x: 300, y: 0 })
  ok(!D.canRedo(h), 'F4 ★ 撤了之后做新动作并记录，重做链作废（撤销栈的通用语义）')

  // 上限：栈不会无限涨
  const small = D.createHistory(3)
  let g = D.emptyDiagram()
  for (let i = 0; i < 10; i++) {
    D.record(small, g, `第 ${i} 步`)
    g = D.addNode(g, { text: `节点${i}`, x: i * 10, y: 0 })
  }
  eq(small.past.length, 3, 'F4 ★ 撤销栈有上限（10 步只留最近的 3 格）')
  eq(D.undoLabel(small), '第 9 步', 'F4 留的是最近的那几步')
}

// F5. Mermaid 导出格式
{
  let d = D.emptyDiagram()
  d = D.addNode(d, { id: 'n1', text: '马克思主义中国化', x: 0, y: 0 })
  d = D.addNode(d, { id: 'n2', text: '毛泽东思想', shape: 'round', x: 200, y: 0 })
  d = D.addNode(d, { id: 'n3', text: '实事求是', shape: 'circle', x: 400, y: 0 })
  d = D.addNode(d, { id: 'n4', text: '判断题', shape: 'diamond', x: 600, y: 0 })
  d = D.addEdge(d, 'n1', 'n2', '包含')
  d = D.addEdge(d, 'n2', 'n3')

  const md = D.toMermaid(d)
  const lines = md.split('\n')
  eq(lines[0], 'flowchart TD', 'F5 第一行是 flowchart TD')
  ok(lines.includes('  n1["马克思主义中国化"]'), 'F5 矩形 → id["文字"]')
  ok(lines.includes('  n2("毛泽东思想")'), 'F5 圆角 → id("文字")')
  ok(lines.includes('  n3(("实事求是"))'), 'F5 圆形 → id(("文字"))')
  ok(lines.includes('  n4{"判断题"}'), 'F5 菱形 → id{"文字"}')
  ok(lines.includes('  n1 -->|"包含"| n2'), 'F5 有标签的边 → a -->|"标签"| b')
  ok(lines.includes('  n2 --> n3'), 'F5 没标签的边 → a --> b（不写空的 ||）')

  // 默认方向可换（用户想从左到右时用）
  ok(D.toMermaid(d, { direction: 'LR' }).startsWith('flowchart LR'), 'F5 方向可指定')

  // 转义必须是双射，否则往返测试是假通过
  const tricky = '他说"这个#很重要" & <真的>'
  eq(D.unescapeLabel(D.escapeLabel(tricky)), tricky, 'F5 ★ 转义是可逆的（引号/#/&/尖括号都能还原）')
  const already = '#quot;没被二次解码#35;'
  eq(D.unescapeLabel(D.escapeLabel(already)), already, 'F5 ★ 本来就长得像转义码的文字也不会被解错')

  // 导出时必须挡住会破坏 Mermaid 语法的字符
  let bad = D.emptyDiagram()
  bad = D.addNode(bad, { id: 'q', text: '带"引号"的文字', x: 0, y: 0 })
  const badMd = D.toMermaid(bad)
  eq(badMd.split('"').length - 1, 2, 'F5 ★ 文字里的引号被转义，不会把 Mermaid 的双引号提前闭合')
}

// F6. 导入（含脏文本）
{
  // 自己导出的必须能自己读回来，且**再导出一次完全一样**（幂等）
  let d = D.emptyDiagram()
  d = D.addNode(d, { id: 'n1', text: '总概念', x: 0, y: 0 })
  d = D.addNode(d, { id: 'n2', text: '子概念', shape: 'round', x: 0, y: 0 })
  d = D.addNode(d, { id: 'n3', text: '判断', shape: 'diamond', x: 0, y: 0 })
  d = D.addEdge(d, 'n1', 'n2', '包含')
  d = D.addEdge(d, 'n2', 'n3', '是')

  const md1 = D.toMermaid(d)
  const back = D.fromMermaid(md1)
  const md2 = D.toMermaid(back)
  eq(md2, md1, 'F6 ★★ 导出→导入→再导出，文本完全一致（往返一致）')
  eq(back.nodes.length, 3, 'F6 节点数对得上')
  eq(back.edges.length, 2, 'F6 边数对得上')
  eq(back.nodes.map((n) => n.text).join('|'), '总概念|子概念|判断', 'F6 文字原样回来')
  eq(back.nodes.map((n) => n.shape).join('|'), 'rect|round|diamond', 'F6 形状原样回来')
  eq(back.edges.map((e) => e.label).join('|'), '包含|是', 'F6 边标签原样回来')
  ok(back.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)), 'F6 导入后自动排了位置')
  ok(
    back.nodes.every((n) => n.w > 0 && n.h > 0),
    'F6 导入后节点有尺寸',
  )

  // 手写的、格式比较随便的 Mermaid
  const messy = [
    'flowchart TD',
    '  %% 这是注释，应该被忽略',
    '',
    '  A[第一层] --> B(第二层)',
    '  B -->|"关系"| C{第三层}',
    '  A --> D((圆))',
    '  %% A --> 注释掉的边',
    '  A --> B', // 重复边
    '  A --> A', // 自环
  ].join('\n')
  const m = D.fromMermaid(messy)
  eq(m.nodes.length, 4, 'F6 脏文本：认出 4 个节点')
  eq(m.edges.length, 3, 'F6 ★ 重复边和自环被丢掉（3 条有效边）')
  eq(m.nodes.map((n) => n.shape).join('|'), 'rect|round|diamond|circle', 'F6 四种括号都认')

  // 缺头、乱格式、空白 —— 一律不抛错
  const noHeader = D.fromMermaid('X[甲] --> Y[乙]')
  eq(noHeader.nodes.length, 2, 'F6 缺 flowchart 头也能解析')
  eq(noHeader.edges.length, 1, 'F6 缺头时边也在')

  const garbage = D.fromMermaid('这不是 mermaid\n### ^^^ \n%%%%\n\n')
  eq(garbage.nodes.length, 0, 'F6 完全不是 Mermaid 的文本 → 空图，不抛错')
  eq(D.fromMermaid('').nodes.length, 0, 'F6 空文本 → 空图')
  eq(D.fromMermaid(null).nodes.length, 0, 'F6 null 也不抛错')

  // 裸 id：没有方括号的节点
  const bare = D.fromMermaid('flowchart LR\n  Start --> Stop')
  eq(bare.nodes.length, 2, 'F6 裸 id 也当节点')
  eq(bare.nodes.map((n) => n.text).join('|'), 'Start|Stop', 'F6 裸 id 用 id 当文字（总比空框好）')

  // 重复 id 声明：后面的覆盖前面的
  const dup = D.fromMermaid('A[旧文字]\nA[新文字]')
  eq(dup.nodes.length, 1, 'F6 重复 id 只留一个节点')
  eq(dup.nodes[0].text, '新文字', 'F6 重复 id 时后声明的覆盖先声明的')

  // 不支持的关键字不能把图搞坏
  const withSub = D.fromMermaid('flowchart TD\nsubgraph 一组\nA[甲]-->B[乙]\nend')
  eq(withSub.nodes.length, 2, 'F6 subgraph 被跳过，但里面的节点照样解析出来')

  // 头部写全 / 不写方向
  eq(D.fromMermaid('flowchart\nA[甲]').nodes.length, 1, 'F6 光写 flowchart 也认')
  ok(
    D.fromMermaid('flowchart\nA[甲]').nodes[0].text === '甲',
    'F6 ★ 光写 flowchart 时不会凭空多出一个叫 flowchart 的节点',
  )

  // 文字里带连字符不能被当成箭头（踩过的坑：'马克思-列宁主义' 被切成两半）
  const dashed = D.fromMermaid('A[马克思-列宁主义]\nB[甲]')
  eq(dashed.nodes.length, 2, 'F6 ★ 节点文字里的连字符不会被误判成箭头')
  eq(dashed.nodes[0].text, '马克思-列宁主义', 'F6 带连字符的文字完整保留')
}

// F7. 容错归一化 + 自适应布局
{
  const dirty = D.normalizeDiagram({
    nodes: [
      { id: 'a', text: '甲', x: '10', y: 20, shape: 'circle' },
      { id: 'a', text: '重复 id', x: 0, y: 0 },
      { id: '', text: '没 id', x: 0, y: 0 },
      { id: 'b', text: '   ', x: 0, y: 0 },
      { id: 'c', text: '丙', x: NaN, y: null },
    ],
    edges: [
      { from: 'a', to: 'c', label: '连' },
      { from: 'a', to: 'zzz', label: '悬空' },
      { from: 'a', to: 'a' },
      { from: 'a', to: 'c' },
    ],
  })
  eq(dirty.nodes.length, 2, 'F7 重复 id / 空 id / 空文字被丢掉')
  eq(dirty.nodes[0].x, 10, 'F7 字符串坐标能转成数字')
  eq(dirty.edges.length, 1, 'F7 悬空边 / 自环 / 重复边被丢掉')
  eq(dirty.edges[0].label, '连', 'F7 标签保留')
  eq(D.normalizeDiagram(null).nodes.length, 0, 'F7 null → 空图')
  eq(D.normalizeDiagram({ nodes: 'x', edges: 3 }).edges.length, 0, 'F7 类型不对也不抛错')

  // 分层布局：根在第一列、它的下游在更右边
  let d = D.emptyDiagram()
  d = D.addNode(d, { id: 'r', text: '根', x: 0, y: 0 })
  d = D.addNode(d, { id: 'm', text: '中', x: 0, y: 0 })
  d = D.addNode(d, { id: 'l', text: '叶', x: 0, y: 0 })
  d = D.addEdge(d, 'r', 'm')
  d = D.addEdge(d, 'm', 'l')
  const laid = D.autoLayout(d)
  const get = (id) => laid.nodes.find((n) => n.id === id)
  ok(get('r').x < get('m').x && get('m').x < get('l').x, 'F7 ★ 分层布局：根 → 中 → 叶 依次向右')
  ok(laid.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)), 'F7 每个节点都拿到了坐标')
  ok(!(get('r').x === 0 && get('r').y === 0), 'F7 不会全叠在原点')

  // 有环也不能死循环
  let cyc = D.emptyDiagram()
  cyc = D.addNode(cyc, { id: 'p', text: 'P', x: 0, y: 0 })
  cyc = D.addNode(cyc, { id: 'q', text: 'Q', x: 0, y: 0 })
  cyc = D.addEdge(cyc, 'p', 'q')
  cyc = D.addEdge(cyc, 'q', 'p')
  const cycLaid = D.autoLayout(cyc)
  ok(cycLaid.nodes.every((n) => Number.isFinite(n.x)), 'F7 ★ 有环的图也能排完（不死循环）')

  // 孤立节点（没有任何边）也要有位置
  const lonely = D.autoLayout(D.addNode(D.emptyDiagram(), { text: '孤儿', x: 0, y: 0 }))
  ok(lonely.nodes[0].x !== 0 || lonely.nodes[0].y !== 0, 'F7 孤立节点也有位置')
}

// F8. 尺寸估算（视图折行和 core 算尺寸必须用同一套）
{
  ok(D.textWidth('中文') > D.textWidth('ab'), 'F8 中文按全角估宽（比等量西文宽）')
  const wide = D.nodeSize('这是一句很长很长的节点文字用来把方框撑宽')
  ok(wide.w > D.nodeSize('短').w, 'F8 长文字 → 更宽的节点')
  ok(wide.w <= 240, 'F8 宽度有上限（超过就折行，不能把画布撑爆）')

  const lines = D.wrapLines('这是一句很长很长的节点文字用来把方框撑宽', 120)
  ok(lines.length > 1, 'F8 超宽文字会折成多行')
  const tall = D.nodeSize('这是一句很长很长的节点文字用来把方框撑宽')
  ok(tall.h > D.nodeSize('短').h, 'F8 折行后节点变高')

  // ★ 视图要用 nodeMetrics().lines 来画，两者必须是同一份折行结果
  const node = { text: '这是一句很长很长的节点文字用来把方框撑宽', shape: 'rect' }
  const metrics = D.nodeMetrics(node)
  eq(metrics.w, D.nodeSize(node.text, node.shape).w, 'F8 ★ nodeMetrics 给出的尺寸和 nodeSize 一致')
  eq(metrics.lines.length, D.wrapLines(node.text, metrics.w - 26).length, 'F8 ★ 视图折的行数和 core 一致')
}

// F9. id 生成不会和导入的 id 撞
{
  const imported = D.fromMermaid('flowchart TD\nn1[甲]\nn2[乙]\nA[丙]')
  const withNew = D.addNode(imported, { text: '新的', x: 0, y: 0 })
  eq(withNew.nodes.length, 4, 'F9 导入 3 个 + 新增 1 个')
  const ids = withNew.nodes.map((n) => n.id)
  eq(new Set(ids).size, ids.length, 'F9 ★ 新增节点的 id 不会和导入的撞')
  eq(withNew.nodes[3].id, 'n3', 'F9 新 id 接着已有的最大号往下排')
  ok(ids.includes('A'), 'F9 导入的英文字母 id 原样保留')
}

// F10. store 接线（Node 里没有 localStorage，只验状态与 getter 这条链路）
{
  const before = quiz.diagram
  eq(quiz.hasDiagram, false, 'F10 初始没有图')
  quiz.setDiagram(D.addNode(D.emptyDiagram(), { text: '甲', x: 10, y: 10 }))
  eq(quiz.hasDiagram, true, 'F10 setDiagram 之后 hasDiagram = true')
  eq(quiz.diagramNodeCount, 1, 'F10 节点数透出给界面')
  eq(quiz.diagramEdgeCount, 0, 'F10 还没有边')

  const selfLoop = D.addEdge(quiz.diagram, 'n1', 'n1', '自己指自己')
  quiz.setDiagram(selfLoop)
  eq(quiz.diagramEdgeCount, 0, 'F10 自环被 core 拒绝，store 里也就不会出现')

  quiz.clearDiagram()
  eq(quiz.hasDiagram, false, 'F10 clearDiagram 清空画布')
  quiz.setDiagram(before)
}

/* ═══════════════ G. 音乐与成就（外链地址 / 播放列表解析 / 成就评价） ═══════════════ */
console.log('\n═══ G. 音乐与成就（纯逻辑）═══')
{
  // --- 网易云官方外链地址 ---
  eq(M.neteasePlayerSrc(2, '186016', 66).includes('id=186016'), true, 'G1 单曲外链带上 id')
  eq(M.neteasePlayerSrc(2, '186016', 66).includes('auto=0'), true, 'G1 ★ 永远 auto=0（不自动出声）')
  eq(M.neteasePlayerSrc(2, '186016', 66).includes('type=2'), true, 'G1 单曲 type=2')
  eq(M.neteasePlayerSrc(0, '3778678', 430).includes('type=0'), true, 'G1 歌单 type=0')
  eq(M.neteasePlayerSrc(2, '   ', 66), '', 'G1 空 id 返回空串（不拼出坏地址）')
  eq(M.neteasePlayerSrc(2, 'a b/c', 66).includes('a%20b%2Fc'), true, 'G1 id 做了 URL 编码')
  eq(M.neteaseFrameHeight(2), 66, 'G1 单曲高度 66（官方最小值）')
  eq(M.neteaseFrameHeight(0), 430, 'G1 歌单高度 430（不然列表被切）')
  eq(M.neteasePageUrl(2, '1').includes('/song?id=1'), true, 'G1 单曲页面地址')
  eq(M.neteasePageUrl(0, '1').includes('/playlist?id=1'), true, 'G1 歌单页面地址')

  // --- 自己的播放列表：一行一首 ---
  const r1 = M.parseTracks('https://a.com/x.mp3')
  eq(r1.tracks.length, 1, 'G2 一行一个地址能认出来')
  eq(r1.tracks[0].name, 'x', 'G2 没写名字时从文件名推')
  eq(r1.skipped.length, 0, 'G2 没有认不出的行')

  const r2 = M.parseTracks('晴天 | https://a.com/q.mp3\nhttps://a.com/b.mp3')
  eq(r2.tracks.length, 2, 'G2 两行两首')
  eq(r2.tracks[0].name, '晴天', 'G2 「名字 | 地址」用前面的名字')
  eq(r2.tracks[1].name, 'b', 'G2 第二首没写名字就推文件名')

  const r3 = M.parseTracks('# 注释\n\n   \n// 另一种注释\nhttps://a.com/c.mp3')
  eq(r3.tracks.length, 1, 'G3 注释 / 空行 / 空白都被忽略')
  eq(r3.skipped.length, 0, 'G3 ★ 注释不算「没认出来」（否则会误报给用户）')

  eq(M.parseTracks('https://a.com/d.mp3\nhttps://a.com/d.mp3').tracks.length, 1, 'G4 重复地址只留一条')

  const r5 = M.parseTracks('a.mp3\nftp://x/y.mp3\n随手的笔记')
  eq(r5.tracks.length, 0, 'G5 相对路径 / ftp / 纯文字都不认（免得静默不播）')
  eq(r5.skipped.length, 3, 'G5 认不出的行进 skipped，交给 UI 提示')

  eq(M.parseTracks('').tracks.length, 0, 'G6 空字符串不炸')
  eq(M.parseTracks(null).tracks.length, 0, 'G6 null 不炸')
  eq(M.nameFromUrl('https://a.com/a%20b.mp3'), 'a b', 'G6 文件名里的 %20 还原成空格')
  eq(M.nameFromUrl('https://a.com/dir/'), 'dir', 'G6 以 / 结尾时取上一段')
  eq(M.nameFromUrl('乱写的东西'), '乱写的东西', 'G6 不是 URL 也不炸')
  eq(M.nameFromUrl('https://a.com/.mp3'), '未命名', 'G6 去掉扩展名后空了就给「未命名」')

  // --- 四段写法：名字 | 地址 | 封面 | 歌词（2026-10-08 加）---
  const r7 = M.parseTracks('晴天 | https://a.com/q.mp3 | https://a.com/q.jpg | https://a.com/q.lrc')
  eq(r7.tracks.length, 1, 'G11 四段行能认出来')
  eq(r7.tracks[0].name, '晴天', 'G11 第一段是名字')
  eq(r7.tracks[0].cover, 'https://a.com/q.jpg', 'G11 第三段是封面')
  eq(r7.tracks[0].lrc, 'https://a.com/q.lrc', 'G11 第四段是歌词')
  eq(r7.skipped.length, 0, 'G11 四段行不算没认出来')

  const r8 = M.parseTracks('只有地址 | https://a.com/x.mp3')
  eq(r8.tracks[0].cover, undefined, 'G12 只写两段时没有 cover 字段')
  eq(r8.tracks[0].lrc, undefined, 'G12 只写两段时没有 lrc 字段')

  // ★ 封面/歌词是装饰：写坏了只丢这两个字段，歌本身必须留下
  //   （为一张写错的封面图把整首歌吞掉，用户会一脸问号）
  const r9 = M.parseTracks('歌 | https://a.com/y.mp3 | cover.jpg | lrc.txt')
  eq(r9.tracks.length, 1, 'G13 封面/歌词不是 http(s) 时歌还在')
  eq(r9.tracks[0].cover, undefined, 'G13 坏封面被丢掉')
  eq(r9.tracks[0].lrc, undefined, 'G13 坏歌词被丢掉')
  eq(r9.skipped.length, 0, 'G13 这行不算没认出来')

  // ★ 有 `|` 时第一段就是名字 —— 所以"只写封面不写名字"会被判成没认出来。
  //   宁可报错，也不要静默把封面图当音频地址放。
  const r10 = M.parseTracks('https://a.com/z.mp3 | https://a.com/z.jpg')
  eq(r10.tracks.length, 0, 'G14 想只写封面 → 整行没认出来（不会静默放错）')
  eq(r10.skipped.length, 1, 'G14 并报给用户')

  // --- 系统媒体面板的信息 ---
  eq(M.mediaInfo({ name: '晴天' }).title, '晴天', 'G15 媒体面板标题用歌名')
  eq(M.mediaInfo({ name: '晴天' }).artist, '我的音乐', 'G15 没写歌手时给个默认')
  eq(M.mediaInfo({ name: '晴天' }).artwork, undefined, 'G15 ★ 没封面就别给 artwork（否则系统面板一块灰方块）')
  eq(M.mediaInfo({ name: '晴天', cover: 'https://a.com/c.jpg' }).artwork[0].src, 'https://a.com/c.jpg', 'G15 有封面就带上')
  eq(M.mediaInfo({}).title, '未命名', 'G15 空对象不炸')
  eq(M.mediaInfo(null).artist, '我的音乐', 'G15 null 不炸')

  // --- 播放器时间读数 ---
  eq(M.formatClock(0), '0:00', 'G16 0 秒')
  eq(M.formatClock(65), '1:05', 'G16 补零（播放器里必须定宽，不然每秒都在抖）')
  eq(M.formatClock(600), '10:00', 'G16 十分钟')
  eq(M.formatClock(3661), '1:01:01', 'G16 超过一小时才带小时位')
  eq(M.formatClock(-5), '0:00', 'G16 负数当 0')
  eq(M.formatClock(undefined), '0:00', 'G16 undefined 当 0')
  eq(M.formatClock(NaN), '0:00', 'G16 NaN 当 0（duration 没到时就是 NaN）')

  // --- 地址分类：认出"这是网页不是音频"（2026-10-08 用户实际踩的坑）---
  eq(M.classifyUrl('https://a.com/x.mp3'), 'audio', 'G17 普通音频地址')
  eq(M.classifyUrl('https://cdn.a.com/signed?token=1'), 'audio', 'G17 没后缀的 CDN 地址也算音频（不误杀）')
  eq(M.classifyUrl('./demo/demo.wav'), 'audio', 'G17 站内 ./ 路径算音频')
  eq(M.classifyUrl('https://music.163.com/song?id=438456541'), 'page', 'G17 ★ 网易云歌曲页是**网页**')
  eq(M.classifyUrl('https://music.163.com/#/playlist?id=123'), 'page', 'G17 ★ 网易云歌单页也是网页')
  eq(M.classifyUrl('https://www.bilibili.com/video/BV1xx'), 'page', 'G17 B 站也是网页')
  eq(M.classifyUrl('https://youtu.be/abcdef'), 'page', 'G17 YouTube 也是网页')
  eq(M.classifyUrl('a.mp3'), 'page', 'G17 ★ 裸文件名不行（hash 路由下会解析到错的地方）')

  const nz1 = M.neteaseFromUrl('https://music.163.com/song?id=438456541')
  eq(nz1 && nz1.id, '438456541', 'G18 从歌曲页抠出 id')
  eq(nz1 && nz1.kind, 2, 'G18 歌曲 → 官方外链 type=2')
  const nz2 = M.neteaseFromUrl('https://music.163.com/#/my/m/music/playlist?id=999')
  eq(nz2 && nz2.kind, 0, 'G18 歌单 → type=0')
  eq(nz2 && nz2.id, '999', 'G18 歌单 id 也抠得到')
  eq(M.neteaseFromUrl('https://a.com/song?id=1'), null, 'G18 不是网易云的地址不认')
  eq(M.neteaseFromUrl('https://music.163.com/song'), null, 'G18 没有 id 就返回 null')

  // ★ 粘错的地址必须**从 tracks 里剔出去**，否则播放器又会去解一页 HTML
  const rp = M.parseTracks('https://music.163.com/song?id=438456541')
  eq(rp.tracks.length, 0, 'G19 ★ 网页地址不进 tracks（否则 APlayer 报一句看不懂的错）')
  eq(rp.pages.length, 1, 'G19 但要在 pages 里交出来（UI 好做一键修复）')
  eq(rp.pages[0].netease.id, '438456541', 'G19 并带上解析好的 id')
  const rp2 = M.parseTracks('演示音轨 | ./demo/demo.wav | | ./demo/demo.lrc')
  eq(rp2.tracks.length, 1, 'G19 站内演示曲目认得出')
  eq(rp2.tracks[0].lrc, './demo/demo.lrc', 'G19 相对路径的歌词也要收下')
  eq(rp2.pages.length, 0, 'G19 站内路径不会被当成网页')

  // --- 成就评价 ---
  eq(M.gradeOf({ accuracy: 100, graded: 10, total: 10 }).title, '满分', 'G7 全对是「满分」')
  eq(M.gradeOf({ accuracy: 100, graded: 10, total: 10 }).level, 3, 'G7 全对放最高档彩花')
  eq(M.gradeOf({ accuracy: 92, graded: 10, total: 10 }).level, 3, 'G7 90% 以上是 3 档')
  eq(M.gradeOf({ accuracy: 80, graded: 10, total: 10 }).level, 2, 'G7 70~89% 是 2 档')
  eq(M.gradeOf({ accuracy: 30, graded: 10, total: 10 }).level, 1, 'G7 低分是 1 档')
  // ★ 题量太少要降档：3 道全对不值得 132 颗彩花的「史诗级」庆祝，
  //   否则真正的大胜利会变得不值钱
  eq(M.gradeOf({ accuracy: 100, graded: 3, total: 3 }).level, 2, 'G8 只做 3 道全对降一档')
  eq(M.gradeOf({ accuracy: 100, graded: 5, total: 5 }).level, 3, 'G8 做满 5 道就不降了')
  eq(M.gradeOf({ accuracy: 100, graded: 2, total: 2 }).level, 2, 'G8 题少时最高只降到 2 档（不再往下扣）')
  eq(M.gradeOf({ accuracy: 0, graded: 3, total: 3 }).level, 1, 'G8 本来 1 档的不会再降')
  eq(M.gradeOf({ accuracy: 0, graded: 0, total: 8 }).title, '这一轮没作答', 'G9 一道没作答是单独的说法')
  eq(M.gradeOf({}).level, 1, 'G9 gradeOf() 空参不炸')
  eq(M.gradeOf({ accuracy: 100, graded: 3, total: 3 }).emoji.length > 0, true, 'G9 每种评价都有 emoji')

  // --- 时长文案（成就页和报告页共用同一套说法）---
  eq(M.humanDuration(45), '45 秒', 'G10 45 秒')
  eq(M.humanDuration(90), '1 分 30 秒', 'G10 1 分 30 秒')
  eq(M.humanDuration(7500), '2 小时 5 分', 'G10 2 小时 5 分')
  eq(M.humanDuration(-5), '0 秒', 'G10 负数当 0')
  eq(M.humanDuration(undefined), '0 秒', 'G10 undefined 当 0')
}

/* ═══════════════ H. 解析里的网址 / 题目出处（教材题库要用） ═══════════════ */
console.log('\n═══ H. 文本切链接与出处字段 ═══')
{
  const segs = T.splitLinks('依据见 https://vuejs.org/guide/computed.html#basic-example 这一段')
  eq(segs.length, 3, 'H1 切成「文本 + 链接 + 文本」三段')
  eq(segs[1].type, 'link', 'H1 中间那段是链接')
  eq(segs[1].href, 'https://vuejs.org/guide/computed.html#basic-example', 'H1 href 就是那个地址')
  eq(segs[2].text.startsWith(' 这一段'), true, 'H1 链接后面的文本还在')

  // ★ 中文标点粘在网址尾巴上是最常见的形态（"…basic-example。"）
  const segs2 = T.splitLinks('出处：https://vuejs.org/guide/computed.html。')
  eq(segs2.filter((s) => s.type === 'link')[0].href, 'https://vuejs.org/guide/computed.html', 'H2 ★ 尾部句号不进 href')
  eq(segs2[segs2.length - 1].text, '。', 'H2 句号回到文本里')
  eq(T.splitLinks('没有网址的一段话').length, 1, 'H3 没有网址就原样一段')
  eq(T.splitLinks('').length, 0, 'H3 空串返回空数组')
  eq(T.splitLinks(null).length, 0, 'H3 null 不炸')
  eq(T.splitLinks('https://a.com/x').length, 1, 'H3 整段就是一个网址')
  // 安全性：绝不返回 HTML 字符串，调用处就不会有 v-html 的机会
  eq(typeof T.splitLinks('a https://a.com b')[0].text, 'string', 'H3 返回的是片段对象，不是拼好的 HTML')

  // ── H5 解析的 markdown：题干会格式化、解析裸显示（UX 审计 2026-10-11 块 3-1）──
  //    521 道代码题里 129 条解析写着 `**强调**`、87 条带 ```js 围栏。
  //    ★ 判据只有一份：行内标记走 inlineSegs()，题干和解析共用（坑 58 / 110）。
  const seg = (arr, type) => arr.filter((s) => s.type === type)

  const a1 = T.analysisSegs('期望输出**不是文档注释给的**：真跑一遍')
  eq(seg(a1, 'strong').length, 1, 'H5 ★ **强调** 切成 strong 片段（不是把星号显示出来）')
  eq(seg(a1, 'strong')[0].text, '不是文档注释给的', 'H5 强调里的文字留下来了')
  eq(
    a1.map((s) => s.text).join(''),
    '期望输出不是文档注释给的：真跑一遍',
    'H5 片段拼回去就是原文（标记之外的字符一个不丢）',
  )

  const a2 = T.analysisSegs('补的语句就是最后一行 `console.log(isEven.value)`')
  eq(seg(a2, 'code').length, 1, 'H5 反引号切成行内 code 片段')
  eq(seg(a2, 'code')[0].text, 'console.log(isEven.value)', 'H5 代码内容没有被当成标记吃掉')

  const a3 = T.analysisSegs('**参考实现**：\n```js\nconst n = 1\n```\n跑出来是 true')
  eq(seg(a3, 'pre').length, 1, 'H5 ★ ``` 围栏切成 pre 片段')
  eq(seg(a3, 'pre')[0].text, 'const n = 1', 'H5 围栏里的代码原样保留（语言名不入正文）')
  eq(seg(a3, 'strong').length, 1, 'H5 围栏外的强调照旧生效')
  eq(
    a3.filter((s) => s.type === 'text').map((s) => s.text).join('|'),
    '：|跑出来是 true',
    'H5 围栏前后不留空行（trim 掉了，否则代码块上下各多一个空行）',
  )

  // 没闭合的围栏也不能把后面整段吞掉（材料里被截断的解析真的会遇到）
  const a3b = T.analysisSegs('```js\nconst n = 1')
  eq(seg(a3b, 'pre').length, 1, 'H5 ★ 没闭合的围栏也当代码块，不丢内容')

  // 网址照旧可点：解析里那行「出处：… <地址>」
  const a4 = T.analysisSegs('出处：https://vuejs.org/guide/computed.html#basic-example')
  eq(seg(a4, 'link')[0].href, 'https://vuejs.org/guide/computed.html#basic-example', 'H5 解析里的网址还是链接')
  eq(seg(a4, 'link')[0].text, 'https://vuejs.org/guide/computed.html#basic-example', 'H5 链接文字还是网址本身')

  // ★ 安全：解析可能来自用户手写或模型生成 —— 拿到的必须是"片段"，不许是拼好的 HTML
  const a5 = T.analysisSegs('**<img src=x onerror=alert(1)>** 和 `<b>x</b>`')
  eq(
    seg(a5, 'strong')[0].text,
    '<img src=x onerror=alert(1)>',
    'H5 强调里的尖括号原样留在片段里（渲染时由 Vue 转义，绝不走 innerHTML）',
  )
  ok(
    a5.every((s) => typeof s.text === 'string' && !/<strong|<code|&lt;/.test(s.text)),
    'H5 ★ analysisSegs 只返回片段对象，不拼任何标签',
  )
  eq(T.analysisSegs('').length, 0, 'H5 空解析返回空数组')
  eq(T.analysisSegs(null).length, 0, 'H5 null 不炸')

  // 题干：填空横条**不再**在行内代码里认（`ref()` 不是空）
  const stemWithCode = T.stemHtml('填空是 (  )，代码是 `f(  )`')
  eq(stemWithCode.split('q-blank').length - 1, 1, 'H5 ★ 只认正文里的填空，行内代码里的括号不算空')

  // ── H6 题库简介：卡片上只有两行小字，星号不该亮给用户（首页第一屏就能看到）──
  eq(
    T.plainText('自动生成的**代码题**（填空 / 找错行）'),
    '自动生成的代码题（填空 / 找错行）',
    'H6 ★ 简介里的 **强调** 剥成纯文本（首页卡片上不再出现星号）',
  )
  eq(T.plainText('跑 `console.log(x)` 看结果'), '跑 console.log(x) 看结果', 'H6 简介里的行内反引号也剥掉')
  eq(
    T.plainText('参考实现：\n```js\nconst n = 1\n```\n跑出来是 true'),
    '参考实现：\nconst n = 1\n跑出来是 true',
    'H6 ★ 围栏只去掉标记本身（代码保留、前后留一个换行）',
  )
  eq(T.plainText(''), '', 'H6 空串不炸')

  // 出处字段：教材编译出来的题库每道题都带，老题库没有也不能出错
  const withSrc = normalizeQuestion(
    {
      no: 1,
      type: 'single',
      stem: '下面哪个说法对',
      options: [
        { key: 'A', text: '甲' },
        { key: 'B', text: '乙' },
        { key: 'C', text: '丙' },
        { key: 'D', text: '丁' },
      ],
      answer: ['A'],
      source: { url: 'https://vuejs.org/x.html#y', heading: 'Basic Example', quote: '原文一句' },
    },
    0,
  )
  eq(withSrc.q.source?.url, 'https://vuejs.org/x.html#y', 'H4 ★ 出处字段被保留（前端要靠它渲染"点回原文"）')
  eq(withSrc.q.source?.heading, 'Basic Example', 'H4 出处标题也保留')
  const noSrc = normalizeQuestion(
    { no: 2, type: 'judge', stem: '这句话对不对呢', answer: ['T'] },
    0,
  )
  eq('source' in noSrc.q, false, 'H4 老题库没出处字段时不要凭空造一个（界面到处判空很烦）')
  const badSrc = normalizeQuestion(
    { no: 3, type: 'judge', stem: '这句话对不对呢', answer: ['T'], source: 'https://a.com' },
    0,
  )
  eq('source' in badSrc.q, false, 'H4 出处写成字符串就丢掉，不要塞个坏对象进来')
}

/* ═══════════════ H. 歌词（播放页的同步歌词全靠它） ═══════════════ */
console.log('\n═══ H. 歌词解析与同步（纯逻辑）═══')
{
  const lrc = [
    '[ti:测试歌]',
    '[ar:某人]',
    '[offset:0]',
    '[00:12.34]第一句',
    '[00:15.00][01:20.00]副歌（同一句出现两次）',
    '[00:18.5]小数位少一位也要认',
    '',
    '[01:05.00]最后一句',
  ].join('\n')
  const p = L.parseLrc(lrc)
  eq(p.synced, true, 'H1 有时间戳就算同步歌词')
  eq(p.meta.ti, '测试歌', 'H1 元信息 ti')
  eq(p.meta.ar, '某人', 'H1 元信息 ar')
  eq(p.lines.length, 5, 'H1 一行两个时间戳要拆成两条')
  eq(p.lines[0].time, 12.34, 'H1 小数两位 → 秒')
  eq(p.lines[0].text, '第一句', 'H1 歌词正文没带上时间戳')
  eq(p.lines[2].time, 18.5, 'H1 小数一位也认（.5 → 0.5 秒）')
  eq(p.lines[3].time, 65, 'H1 按时间排好序（65 秒在 80 秒前）')
  eq(p.lines[4].time, 80, 'H1 一行多时间戳的第二条也在（80 秒）')

  // ★ 边界：歌词还没开始 / 已经唱完
  eq(L.activeLineIndex(p.lines, 0), -1, 'H2 ★ 前奏阶段返回 -1（不要硬塞第一句）')
  eq(L.activeLineIndex(p.lines, 12.33), -1, 'H2 差一点点也还没到')
  eq(L.activeLineIndex(p.lines, 12.34), 0, 'H2 正好到点就是第一句')
  eq(L.activeLineIndex(p.lines, 14), 0, 'H2 第一句持续到下一句之前')
  eq(L.activeLineIndex(p.lines, 999), 4, 'H2 唱完之后停在最后一句')
  eq(L.activeLineIndex([], 5), -1, 'H2 空歌词不炸')
  eq(L.activeLineIndex(p.lines, NaN), -1, 'H2 时间是 NaN 时返回 -1')

  // offset：正数表示歌词整体提前
  const off = L.parseLrc('[offset:500]\n[00:10.00]甲')
  eq(off.lines[0].time, 9.5, 'H3 offset 正数 → 歌词提前 0.5 秒')
  const off2 = L.parseLrc('[offset:-500]\n[00:10.00]甲')
  eq(off2.lines[0].time, 10.5, 'H3 offset 负数 → 歌词延后 0.5 秒')
  eq(L.applyOffset([{ time: 0.2, text: 'x' }], 1000)[0].time, 0, 'H3 提前过头夹到 0，不出负数')

  // 纯文本歌词（没有时间戳）：要能识别出来，UI 才知道"这句没法跟着滚"
  const plain = L.parseLrc('这是一段没有时间戳的歌词\n第二行\n第三行')
  eq(plain.synced, false, 'H4 ★ 没有时间戳 → 不是同步歌词（不能假装能滚）')
  eq(plain.lines.length, 3, 'H4 但内容要留着给用户看')
  eq(L.parseLrc('').lines.length, 0, 'H4 空字符串不炸')
  eq(L.parseLrc(null).lines.length, 0, 'H4 null 不炸')
  eq(L.parseLrc('[ti:只有元信息]').lines.length, 0, 'H4 只有元信息时没有歌词行')

  eq(L.clock(65), '1:05', 'H5 播放页的时间标签')
  eq(L.clock(0), '0:00', 'H5 0 秒')
}

/* ═══════════════ I. 代码题（填空 / 找错行 / 预测 / 修好它） ═══════════════ */
console.log('\n═══ I. 代码题（core/code.js + 归一化 + store 作答）═══')
{
  // ── I1 切分：空心是 3 个及以上下划线，`__dirname` 这种两个的不能误伤 ──
  const split = CD.splitCode('const a = ___;\nlet b = __dirname\nconst c = ___')
  eq(split.total, 2, 'I1 数出 2 个空（__dirname 不算）')
  eq(split.parts.filter((p) => p.type === 'blank').length, 2, 'I1 片段里有 2 个空')
  eq(CD.splitCode('let x = 1').total, 0, 'I1 没有空就是 0')
  eq(CD.splitCode('').total, 0, 'I1 空字符串不炸')
  eq(CD.blankCount('a___b___c___'), 3, 'I1 连续三个空都数得到')

  // ── I2 单空判定：只吃空白差异；大小写、分号差异都算错 ──
  eq(CD.judgeBlank('const', '  const  '), true, 'I2 前后空白不算错')
  eq(CD.judgeBlank('a  +  b', 'a + b'), true, 'I2 内部多余空格不算错')
  eq(CD.judgeBlank('const', 'Const'), false, 'I2 ★ 大小写敏感（ref 写成 Ref 就是错的）')
  eq(CD.judgeBlank('a;', 'a'), false, 'I2 ★ 少个分号算错（这正是要人记住的）')
  eq(CD.judgeBlank(['ref', 'reactive'], 'reactive'), true, 'I2 多个写法都算对')
  eq(CD.judgeBlank('const', ''), false, 'I2 空作答不算对')
  eq(CD.judgeBlank('', ''), false, 'I2 答案本身为空时不能算对')

  // ── I3 judgeCode：填空 ──
  const fillQ = {
    type: 'code',
    mode: 'fill',
    code: 'const count = ___(0)\ncount.___++',
    blanks: [{ answer: ['ref'] }, { answer: ['value'] }],
  }
  const good = CD.judgeCode(fillQ, ['ref', 'value'])
  eq(good.ok, true, 'I3 两个空都填对 → 过')
  eq(good.blanks.join(','), 'true,true', 'I3 逐空结果都是 true（界面要标哪个空错）')
  const half = CD.judgeCode(fillQ, ['ref', 'x'])
  eq(half.ok, false, 'I3 错一个空 → 不过')
  eq(half.blanks.join(','), 'true,false', 'I3 ★ 仍然返回逐空结果（不能只给一个 false）')
  eq(CD.judgeCode(fillQ, ['ref']).ok, false, 'I3 空没填完 → 不过')

  // ── I4 找错行 / 预测输出 ──
  eq(CD.judgeCode({ type: 'code', mode: 'spot', answer: ['3'] }, ['3']).ok, true, 'I4 行号对上')
  eq(CD.judgeCode({ type: 'code', mode: 'spot', answer: ['3'] }, [3]).ok, true, 'I4 行号是数字也对')
  eq(CD.judgeCode({ type: 'code', mode: 'spot', answer: ['3'] }, ['4']).ok, false, 'I4 行号错了')
  eq(CD.judgeCode({ type: 'code', mode: 'spot', answer: ['3'] }, ['']).ok, false, 'I4 没选不算对')
  eq(CD.judgeCode({ type: 'code', mode: 'predict', answer: ['B'] }, ['B']).ok, true, 'I4 预测输出按字母判')
  eq(
    CD.judgeCode({ type: 'code', mode: 'predict', answer: ['A', 'C'] }, ['C', 'A']).ok,
    true,
    'I4 预测输出多选题与顺序无关',
  )
  eq(CD.judgeCode({ type: 'code', mode: 'predict', answer: ['A', 'C'] }, ['A']).ok, false, 'I4 少选一个不算对')

  // ── I5 运行输出判定 ──
  eq(CD.judgeRun({ run: { expect: ['1', '2'] } }, '1\n2'), true, 'I5 逐行相等')
  eq(CD.judgeRun({ run: { expect: ['1', '2'] } }, '1\n2\n'), true, 'I5 尾部空行不算差异')
  eq(CD.judgeRun({ run: { expect: ['1', '2'] } }, '1  \n2'), true, 'I5 行尾空白不算差异')
  eq(CD.judgeRun({ run: { expect: ['1', '2'] } }, '2\n1'), false, 'I5 ★ 顺序也算（输出是有序的）')
  eq(CD.judgeRun({ run: { expect: ['1'] } }, '1\n2'), false, 'I5 多打了一行不算过')
  eq(CD.judgeRun({ run: { expect: { contains: ['done'] } } }, 'a\ndone\nb'), true, 'I5 contains 只要求出现')
  eq(CD.judgeRun({ run: { expect: { contains: ['done'] } } }, 'a\nb'), false, 'I5 contains 没出现就是没过')
  eq(CD.judgeRun({ run: {} }, '随便'), null, 'I5 没写期望值时返回 null（无从判，别瞎判）')
  eq(CD.judgeCode({ type: 'code', mode: 'fix', run: { expect: ['4'] } }, ['4']).ok, true, 'I5 修好它：跑出 4 就算过')
  eq(CD.judgeCode({ type: 'code', mode: 'fix', run: { expect: ['4'] } }, ['3']).ok, false, 'I5 修好它：输出不对不算过')
  eq(
    CD.judgeCode({ type: 'code', mode: 'fix', run: { expect: ['4'] } }, ['TypeError: nope']).ok,
    false,
    'I5 修好它：报错文本不会碰巧算过',
  )

  // ── I6 可运行性：宁可明确说"跑不了"，也不要让人看莫名其妙的报错 ──
  eq(CD.runBlockReason({ type: 'code', lang: 'js', code: 'console.log(1)' }), '', 'I6 纯 JS 能跑')
  // 理由变了：以前对**所有** vue-html 都说"没有编译器"，可库里 203 个里有 134 个
  // 是**裸片段**（状态在别的代码块），说"没有编译器"是假话 —— 见 N6 那一组
  ok(
    /SFC 编译器/.test(
      CD.runBlockReason({ type: 'code', lang: 'vue', code: '<script setup>const a=1</script><template><p/></template>' }),
    ),
    'I6 ★ 完整 SFC 明说跑不了（理由是缺编译器）',
  )
  ok(
    /没有配套/.test(CD.runBlockReason({ type: 'code', lang: 'vue-html', code: '<p>只有标记</p>' })),
    'I6 ★ 裸片段明说跑不了（理由是缺配套状态）',
  )
  ok(/import\/export/.test(CD.runBlockReason({ type: 'code', lang: 'js', code: "import { ref } from 'vue'" })), 'I6 ESM 明说跑不了')
  ok(/require/.test(CD.runBlockReason({ type: 'code', lang: 'js', code: "const x = require('fs')" })), 'I6 require 明说跑不了')
  ok(/DOM/.test(CD.runBlockReason({ type: 'code', lang: 'js', code: 'document.title = "x"' })), 'I6 碰 DOM 明说跑不了')
  ok(/联网/.test(CD.runBlockReason({ type: 'code', lang: 'js', code: 'fetch("/x")' })), 'I6 fetch 明说跑不了')
  ok(/typescript|TS/.test(CD.runBlockReason({ type: 'code', lang: 'ts', code: 'const a: number = 1' })) || CD.runBlockReason({ type: 'code', lang: 'ts', code: 'const a: number = 1' }) !== '', 'I6 TS 不给跑')
  eq(CD.isRunnable({ type: 'code', lang: 'js', code: 'console.log(1)' }), true, 'I6 isRunnable 是 runBlockReason 的取反')

  // ── I7 沙箱文档：用户代码里的 </script> 必须打散，否则整个沙箱被截断 ──
  const doc = CD.buildSandboxDoc({ code: 'console.log("</script><b>x")' })
  ok(doc.includes(CD.SANDBOX_SOURCE), 'I7 文档里有握手标识')
  ok(!doc.includes('"</script><b>x"'), 'I7 ★ 用户代码里的 </script> 被转义了（否则脚本提前结束）')
  ok(doc.includes('console.log'), 'I7 用户代码在文档里')
  ok(doc.includes('unhandledrejection'), 'I7 异步报错也接得住')
  ok(doc.includes('new Function'), 'I7 用 new Function 包一层执行')

  // ── I8 消息握手 / 结果归集 ──
  eq(CD.readSandboxMessage({ source: '别的组件', kind: 'x' }), null, 'I8 不是我们的消息一律忽略')
  eq(CD.readSandboxMessage(null), null, 'I8 null 不炸')
  eq(CD.readSandboxMessage('字符串'), null, 'I8 字符串不炸')
  const read = CD.readSandboxMessage({ source: CD.SANDBOX_SOURCE, kind: 'stdout', payload: 'hi' })
  eq(read.kind, 'stdout', 'I8 我们的消息读得出 kind')
  const run = CD.collectRun([
    { kind: 'stdout', payload: 'a' },
    { kind: 'warn', payload: 'w' },
    { kind: 'error', payload: 'TypeError: boom' },
  ])
  eq(run.ok, false, 'I8 有报错就不是 ok')
  eq(run.output, 'a', 'I8 输出只算 stdout（警告/报错不算输出，否则修好它会假过）')
  eq(run.error, 'TypeError: boom', 'I8 报错原文留着给用户看')
  const to = CD.collectRun([{ kind: 'stdout', payload: 'a' }], { timedOut: true })
  eq(to.ok, false, 'I8 ★ 超时不算 ok')
  ok(/死循环/.test(to.error), 'I8 超时要说人话（提示可能是死循环）')

  // ── I9 归一化：代码题走单独一条路 ──
  const nFill = normalizeQuestion(
    {
      type: 'code',
      stem: '把下面这段补完整',
      lang: 'js',
      code: 'const n = ___(0)',
      blanks: [{ answer: 'ref', hint: '响应式' }],
    },
    0,
  )
  eq(nFill.q.type, 'code', 'I9 题型是 code')
  eq(nFill.q.mode, 'fill', 'I9 没写 mode，看到空 → 推断为填空')
  eq(nFill.q.answer[0], 'ref', 'I9 答案取第一个空的原文（答题卡/解析都要用）')
  eq(nFill.q.blanks[0].hint, '响应式', 'I9 提示词保留')

  const nMismatch = normalizeQuestion(
    { type: 'code', stem: '空对不上', code: 'a ___ b ___ c', blanks: [{ answer: 'x' }] },
    0,
  )
  eq(nMismatch.q, null, 'I9 ★ 空数和答案数对不上 → 丢掉（放进去就是一道判不了的题）')
  ok(/对不上/.test(nMismatch.issue), 'I9 丢弃原因说得清楚')

  const nPredict = normalizeQuestion(
    {
      type: 'code',
      stem: '这段打印什么？',
      code: 'console.log([1,2].length)',
      options: ['1', '2'],
      answer: 'B',
      run: { expect: ['2'] },
    },
    1,
  )
  eq(nPredict.q.mode, 'predict', 'I9 有选项有字母答案 → 预测输出')
  eq(nPredict.q.answer.join(''), 'B', 'I9 预测输出仍然用选项字母作答')

  const nSpot = normalizeQuestion(
    { type: '代码题', stem: '哪一行被改了？', code: 'a\nb\nc', answer: 2 },
    2,
  )
  eq(nSpot.q.mode, 'spot', 'I9 答案是行号 → 找错行')
  eq(nSpot.q.answer[0], '2', 'I9 行号归一化成字符串')

  eq(
    normalizeQuestion({ type: 'code', stem: '修好它', code: 'let a = 1', run: null }, 0).q,
    null,
    'I9 ★ 修好它但没有期望输出 → 丢掉（判不了）',
  )
  eq(
    normalizeQuestion({ type: 'code', stem: '越界', code: 'a\nb', answer: 9 }, 0).q,
    null,
    'I9 找错行给了超出代码行数的行号 → 丢掉',
  )
  eq(normalizeQuestion({ type: 'code', stem: '', code: 'a' }, 0).q, null, 'I9 代码题没题干 → 丢掉')

  // ── I9b 手写题（write）：白纸一张，判据是跑出来的输出 ──
  const nWrite = normalizeQuestion(
    {
      type: 'code',
      mode: 'write',
      stem: '按文档的说法自己写出来，让它打印期望输出',
      code: '// 在这里写\n',
      run: { expect: ['4'] },
    },
    0,
  )
  eq(nWrite.q?.mode, 'write', 'I9b 手写题认得出（mode=write）')
  eq(nWrite.q?.answer.length, 0, 'I9b 手写题没有文字答案（跑通才算过）')
  eq(
    normalizeQuestion({ type: 'code', mode: 'write', stem: 'x', code: '' }, 0).q,
    null,
    'I9b ★ 手写题没有期望输出 → 丢掉（自由发挥判不了）',
  )
  const nWriteBlank = normalizeQuestion(
    { type: 'code', mode: 'write', stem: 'x', code: '', run: ['1'] },
    0,
  )
  eq(nWriteBlank.q?.code, '', 'I9b 手写题允许没有起始代码（真的白纸一张）')
  eq(CD.judgeCode(nWrite.q, ['4']).ok, true, 'I9b 手写：输出对上 → 过')
  eq(CD.judgeCode(nWrite.q, ['5']).ok, false, 'I9b 手写：输出不对 → 不过')
  eq(CD.runBlockReason(nWrite.q), '', 'I9b ★ 手写题即使起始代码是空的，也允许「运行」')

  const nBank = normalizeBank({
    meta: { title: '代码题测试' },
    questions: [
      { type: 'code', stem: '填空', code: 'const a = ___', blanks: [{ answer: 'ref' }] },
      { type: 'single', stem: '普通题', options: ['甲', '乙'], answer: 'A' },
    ],
  })
  eq(nBank.questions.length, 2, 'I9 代码题和选择题混在一个题库里都进得来')
  eq(nBank.meta.counts.code, 1, 'I9 counts 里数出 1 道代码题')
  eq(nBank.issues.length, 0, 'I9 零告警')

  // ── I10 store 里真的能作答（练习模式） ──
  const bankStore = useBankStore()
  const quiz = useQuizStore()
  bankStore.applyBank({ meta: nBank.meta, questions: nBank.questions, issues: [] }, 'custom')
  quiz.bankId = nBank.meta.id
  quiz.answers = {}
  quiz.wrong = {}
  quiz.startSession({ mode: 'seq' })
  quiz.goTo(0)
  const wrongTry = quiz.submitCode(['不是这个'])
  eq(wrongTry.ok, false, 'I10 填空填错 → 判错')
  eq(quiz.wrong[nBank.questions[0].id], 1, 'I10 错题进错题本')
  eq(quiz.answers[nBank.questions[0].id].p[0], '不是这个', 'I10 作答记录留着用户填的内容')
  const again = quiz.submitCode(['ref'])
  eq(again.already, true, 'I10 ★ 判过的题不能再提交（否则填空可以反复提交刷连对）')
  eq(quiz.wrong[nBank.questions[0].id], 1, 'I10 重复提交不改判定')

  quiz.goTo(1)
  quiz.toggleOption('A')
  eq(quiz.answers[nBank.questions[1].id].ok, true, 'I10 选择题那条路没被代码题改动（回归）')

  // ── I12 题干渲染：填空占位要"里面有空格"，代码调用不能被当成空 ──
  ok(T.stemHtml('毛泽东思想的活的灵魂是(  )').includes('q-blank'), 'I12 中文题干里的 (  ) 渲染成填空横线')
  ok(T.stemHtml('（　）全角括号也算').includes('q-blank'), 'I12 全角括号也认')
  ok(T.stemHtml('只填 ( ) 一个空格').includes('q-blank'), 'I12 里面只有一个空格也认')
  ok(
    !T.stemHtml('`ref()` takes the argument and returns it wrapped within a ref object').includes('q-blank'),
    'I12 ★ 代码调用 `ref()` **不能**被当成填空（2026-10-09 真机截图里发现的：句子变成 "ref ___"）',
  )
  ok(!T.stemHtml('调用 createApp() 创建实例').includes('q-blank'), 'I12 ★ 同理 createApp()')
  ok(!T.stemHtml('数组是 [1, 2] 长度是 2').includes('q-blank'), 'I12 方括号不受影响')
  ok(T.stemHtml('<b>坏标签</b>').includes('&lt;b&gt;'), 'I12 尖括号照旧转义')
  // 教材编译出来的题干里到处是反引号和 ** 强调 —— 直出很难看
  const codeStem = T.stemHtml('文档说：`ref()` 返回一个带 `.value` 的对象')
  ok(codeStem.includes('<code class="q-code">ref()</code>'), 'I12 ★ 反引号渲染成行内代码（不是把反引号显示出来）')
  ok(codeStem.includes('<code class="q-code">.value</code>'), 'I12 多个行内代码都认')
  ok(T.stemHtml('**不看原文，自己写**').includes('<strong>不看原文，自己写</strong>'), 'I12 **强调** 也认')
  ok(!T.stemHtml('`<script>` 这种要转义').includes('<script>'), 'I12 ★ 行内代码里的尖括号仍然是转义过的（不能因为加了个 code 标签就开门）')
}

/* ═══════════════ J. 迷你 Vue 运行时（沙箱里跑文档代码的地基） ═══════════════ */
console.log('\n═══ J. 迷你 Vue 运行时（core/vue-shim.js）═══')
{
  /**
   * 在**全新**的 vm 上下文里跑一段文档片段，拿 console 输出。
   * 用 vm 而不是直接 eval：沙箱运行时会往 globalThis 上挂 ref/reactive 等，
   * 不能在测试进程的全局里留东西（后面的断言会受影响）。
   */
  const runShim = (code) => {
    const out = []
    const ctx = vm.createContext({ __send: (kind, text) => out.push(text) })
    vm.runInContext(`${CD.SANDBOX_RUNTIME}\n__captureConsole(__send);\n${code}`, ctx)
    return out
  }

  ok(!CD.SANDBOX_RUNTIME.includes('</'), 'J0 ★ 运行时源码里没有 "</"（否则拼进 srcdoc 会截断脚本）')
  ok(CD.buildSandboxDoc({ code: 'console.log(1)' }).includes('function reactive'), 'J0 沙箱文档里装了迷你 Vue')

  // 下面这几段的期望值**全部抄自 Vue 官方文档的注释**（就是出题工具对账用的那几条）
  const r7 = runShim(
    'const count = ref(0)\nconsole.log(count)\nconsole.log(count.value)\ncount.value++\nconsole.log(count.value)',
  )
  eq(r7.join(' / '), '{ value: 0 } / 0 / 1', 'J1 ★ 官方文档 #Declaring Reactive State：ref 的打印与 .value')

  const r8 = runShim(
    'const raw = {}\nconst proxy = reactive(raw)\nconsole.log(proxy === raw)\nconsole.log(reactive(raw) === proxy)\nconsole.log(reactive(proxy) === proxy)',
  )
  eq(r8.join(' / '), 'false / true / true', 'J2 ★ reactive 的同一性（代理 ≠ 原对象，同一对象给同一个代理）')

  const r10 = runShim('const proxy = reactive({})\nconst raw = {}\nproxy.nested = raw\nconsole.log(proxy.nested === raw)')
  eq(r10.join(' / '), 'false', 'J3 ★ 存进响应式对象的普通对象会被代理一层')

  const r11 = runShim(
    'const count = ref(0)\nconst state = reactive({ count })\nconsole.log(state.count)\nstate.count = 1\nconsole.log(count.value)',
  )
  eq(r11.join(' / '), '0 / 1', 'J4 ★ reactive 里 ref 自动解包，且赋值会写回 ref')

  const r12 = runShim(
    'const count = ref(1)\nconst state = reactive({ count })\nconst otherCount = ref(2)\nstate.count = otherCount\nconsole.log(state.count)\nconsole.log(count.value)',
  )
  eq(r12.join(' / '), '2 / 1', 'J4 ★ 用 ref 赋值是替换属性（老 ref 断开）——和文档一致')

  eq(runShim('const n = ref(2)\nconst d = computed(() => n.value * 2)\nconsole.log(d.value)')[0], '4', 'J5 computed 能取值')
  eq(
    runShim("const itemRefs = useTemplateRef('items')\nconsole.log(itemRefs.value)")[0],
    'null',
    'J5 useTemplateRef 有哑实现（文档示例不报错）',
  )
  eq(runShim("const props = defineProps(['title'])\nconsole.log(props.title)")[0], 'undefined', 'J5 defineProps 有哑实现')
  eq(
    runShim("const x = ref(0)\nwatch(x, () => console.log('fired'))\nconsole.log('done')").join('/'),
    'done',
    'J6 ★ watch 不做响应式触发（所以靠回调打印的片段不会被做成"预测输出"题）',
  )
  eq(runShim('const m = reactive(new Map([["a", 1]]))\nconsole.log(m.get("a"))')[0], '1', 'J6 Map 集合也能取值')
}

/* ═══════════ K. 真实的代码题库（vue-code-tasks.json） ═══════════ */
console.log('\n═══ K. 代码题库出库检查（store 里也能刷）═══')
{
  const CODE_BANK = path.join(HERE, '..', 'src', 'banks', 'big', 'vue-code-tasks.json')
  ok(fs.existsSync(CODE_BANK), 'K0 代码题库文件在（由 tools/units_to_tasks.mjs 生成）')
  const rawCode = JSON.parse(fs.readFileSync(CODE_BANK, 'utf8'))
  const codeBank = normalizeBank(rawCode, 'vue-code-tasks')

  eq(codeBank.questions.length, rawCode.questions.length, 'K1 ★ 一道都没被归一化丢掉（丢掉说明 schema 不匹配）')
  eq(codeBank.issues.length, 0, 'K1 零告警')
  const modes = {}
  codeBank.questions.forEach((q) => (modes[q.mode] = (modes[q.mode] || 0) + 1))
  ok(
    modes.fill > 0 && modes.spot > 0 && modes.fix > 0 && modes.predict > 0 && modes.write > 0,
    `K1 五种模式都有（${JSON.stringify(modes)}）`,
  )
  ok(
    codeBank.questions.every((q) => q.type === 'code' && q.source?.url && q.chapter),
    'K1 每题都是代码题、都带出处和章节',
  )
  ok(
    codeBank.questions.every((q) => q.mode !== 'fill' || q.blanks.length === CD.blankCount(q.code)),
    'K1 填空题的空数和答案数一一对应',
  )
  ok(
    codeBank.questions.every(
      (q) => q.mode !== 'spot' || Number(q.answer[0]) <= q.code.split('\n').length,
    ),
    'K1 找错行的行号都在代码范围内',
  )

  // ★ 题库里带期望输出的题，用**沙箱同一份运行时**再跑一遍：
  //   这一条是"期望输出不是编的"的守门人 —— 运行时改了而题库没重生成，这里立刻红
  const rerun = (code) => {
    const lines = []
    const ctx = vm.createContext({ __send: (kind, text) => lines.push(text) })
    vm.runInContext(`${CD.SANDBOX_RUNTIME}\n__captureConsole(__send);\n${code}`, ctx)
    return lines
  }
  const withRun = codeBank.questions.filter((q) => q.run)
  ok(withRun.length > 0, `K2 有 ${withRun.length} 道题带期望输出（预测输出/修好它）`)
  const predictOk = withRun
    .filter((q) => q.mode === 'predict')
    .every((q) => rerun(q.code).join('\n') === q.run.expect.join('\n'))
  ok(predictOk, 'K2 ★ 预测输出题的期望值 = 真跑一遍的结果')
  const fixDiff = withRun
    .filter((q) => q.mode === 'fix')
    .every((q) => rerun(q.code).join('\n') !== q.run.expect.join('\n'))
  ok(fixDiff, 'K2 ★ 修好它题的初始输出确实和期望不一致（否则是道假题）')

  // ★ 手写题的两条：期望值可复核 + **起始代码本身不能已经过关**（否则提交白纸就过了）
  const writes = codeBank.questions.filter((q) => q.mode === 'write')
  ok(writes.length > 0, `K2 手写题有 ${writes.length} 道（诊断分流里"手写"那一档靠它）`)
  ok(
    writes.every((q) => rerun(q.code).join('\n') !== q.run.expect.join('\n')),
    'K2 ★ 手写题的起始代码自己**过不了**（交白纸不能算对）',
  )
  ok(
    writes.every((q) => /```/.test(q.analysis || '')),
    'K2 ★ 手写题的解析里有参考实现（写完能对照）',
  )
  ok(
    writes.every((q) => !/\bref\(|\breactive\(|\bcomputed\(/.test(q.code)),
    'K2 ★ 手写题的起始代码里没有 API 答案（不是抄写题）',
  )

  // 真的能在 store 里刷（选题 → 作答 → 判错/改对）
  // 注意：startSession 是按 filters 组卷的，所以这里换一个"只含这一道题"的题库
  const bs = useBankStore()
  const qz = useQuizStore()
  const solo = (q) => {
    codeBank.questions = codeBank.questions // 保持可读性
    bs.applyBank({ meta: codeBank.meta, questions: [q], issues: [] }, 'builtin')
    qz.bankId = codeBank.meta.id
    qz.answers = {}
    qz.wrong = {}
    qz.startSession({ mode: 'seq' })
    qz.goTo(0)
  }
  const fillQ = codeBank.questions.find((q) => q.mode === 'fill')
  solo(fillQ)
  const bad = fillQ.blanks.map(() => '肯定不是这个')
  eq(qz.submitCode(bad).ok, false, 'K3 填空题填错 → 判错')
  eq(!!qz.wrong[fillQ.id], true, 'K3 进错题本')

  const goodFill = codeBank.questions.find((q) => q.mode === 'fill' && q.blanks.length === 1)
  solo(goodFill)
  eq(qz.submitCode([goodFill.blanks[0].answer[0]]).ok, true, 'K3 填空题填对 → 判对')

  const spotQ = codeBank.questions.find((q) => q.mode === 'spot')
  solo(spotQ)
  eq(qz.submitCode([spotQ.answer[0]]).ok, true, 'K3 找错行选对行号 → 判对')

  const predictQ = codeBank.questions.find((q) => q.mode === 'predict')
  solo(predictQ)
  eq(qz.submitCode(predictQ.answer).ok, true, 'K3 预测输出选中正确项 → 判对')

  const fixQ = codeBank.questions.find((q) => q.mode === 'fix')
  solo(fixQ)
  eq(qz.submitCode(['和期望不一样']).ok, false, 'K3 修好它没跑对 → 判错')
  solo(fixQ)
  eq(qz.submitCode([fixQ.run.expect.join('\n')]).ok, true, 'K3 修好它输出对上期望 → 判对')
}

/* ═══════════ L. AI 教练 / 错题诊断（喂什么、喂多少、用哪个提示词包） ═══════════ */
console.log('\n═══ L. AI 教练的纯逻辑（core/coach.js）═══')
{
  // ── L1 用哪个提示词包：教材题库走 docs（要求引用原文、不确定就说不确定）──
  eq(CO.coachDomain({ license: 'CC BY 4.0（https://…）' }), 'docs', 'L1 带 CC BY 许可 → docs 包')
  eq(CO.coachDomain({ source: 'vuejs/docs · src/guide/essentials' }), 'docs', 'L1 来源是 vuejs/docs → docs 包')
  eq(CO.coachDomain({ attribution: '某本公开教材' }), '', 'L1 ★ 没有文档/许可线索的题库不硬套 docs 包')
  eq(CO.coachDomain({ license: 'CC BY 4.0' }, 'generic'), 'docs', 'L1 设置里没选 docs 时仍然按题库判断')
  eq(CO.coachDomain({}, 'docs'), 'docs', 'L1 ★ 设置里明确选了"官方文档·教材" → 听用户的')
  eq(CO.coachDomain(null), '', 'L1 没 meta 也不炸')

  // ── L2 喂什么：错题要带题干/选项/正确答案/学员选择/章节/标签 ──
  const bank = normalizeBank({
    meta: { title: 'L2', license: 'CC BY 4.0' },
    questions: [
      { no: 1, type: 'single', stem: '甲题', options: ['A选项', 'B选项'], answer: 'A', chapter: '第一章', tags: ['ref'] },
      { no: 2, type: 'code', mode: 'fill', stem: '乙题', code: 'const a = ___', blanks: [{ answer: 'ref' }], chapter: '第二章' },
      { no: 3, type: 'judge', stem: '丙题', answer: 'T' },
    ],
  })
  const byId = new Map(bank.questions.map((q) => [q.id, q]))
  const ids = bank.questions.map((q) => q.id)
  const items = CO.wrongItems({
    byId,
    wrongIds: ids,
    answerOf: (id) => byId.get(id).answer,
    pickOf: () => ['Z'],
    timeOf: (id) => (id === ids[1] ? 500 : 100), // 第 2 题最近错的
  })
  eq(items.length, 3, 'L2 三道错题都带上')
  eq(items[0].no, 2, 'L2 ★ 最近错的排最前面（截断时先丢最老的）')
  eq(items[0].code, 'const a = ___', 'L2 ★ 代码题要带上代码（不然模型看不到"这段代码"）')
  eq(items[0].mode, 'fill', 'L2 代码题带上模式')
  eq(items[2].no, 3, 'L2 最老的排最后')
  ok(items[2].answer.length === 1, 'L2 判断题的正确答案也带上了')
  eq(CO.wrongItems({ byId, wrongIds: [], answerOf: () => [] }).length, 0, 'L2 没错题时返回空数组')

  // ── L3 喂多少：后端上限 40，超了会 400，所以这里必须先截断 ──
  const many = normalizeBank({
    meta: { title: 'L3' },
    questions: Array.from({ length: 60 }, (_, i) => ({
      no: i + 1,
      type: 'judge',
      stem: `第 ${i + 1} 题`,
      answer: 'T',
    })),
  })
  const manyById = new Map(many.questions.map((q) => [q.id, q]))
  const capped = CO.wrongItems({
    byId: manyById,
    wrongIds: many.questions.map((q) => q.id),
    answerOf: () => ['T'],
    timeOf: (id) => Number(id.replace(/\D/g, '')) || 0,
  })
  eq(capped.length, CO.COACH_WRONG_MAX, `L3 ★ 最多 ${CO.COACH_WRONG_MAX} 道（后端上限，超了直接 400）`)
  eq(CO.COACH_WRONG_MAX, 40, 'L3 这个数字必须和后端 service.MAX_DIAGNOSE_WRONGS 一致')

  // ── L4 就着一道题追问时送的上下文 ──
  const codeQ = bank.questions.find((q) => q.type === 'code')
  const ctx = CO.tutorContext(codeQ, { answerKeys: ['ref'], analysis: '解析' })
  eq(ctx.code, 'const a = ___', 'L4 代码题上下文带代码')
  eq(ctx.mode, 'fill', 'L4 带模式')
  eq(ctx.answer.join(''), 'ref', 'L4 ★ 用有效答案（用户改过答案时不能送题库原答案）')
  eq(ctx.analysis, '解析', 'L4 用有效解析')
  eq('code' in CO.tutorContext(bank.questions[0]), false, 'L4 普通题不会凭空多一个 code 字段')

  // ── L5 快捷问法：代码题和教材题库问得不一样 ──
  ok(CO.quickAsks('docs').some((s) => s.includes('文档')), 'L5 教材题库会提示"去读文档哪一节"')
  ok(CO.quickAsks('', 'spot').some((s) => s.includes('改动')), 'L5 找错行题问"改动让行为怎么变"')
  ok(CO.quickAsks('', 'fill').some((s) => s.includes('代码')), 'L5 填空题问"这段代码每行在做什么"')
  ok(CO.quickAsks('').length >= 3, 'L5 通用题库也有几个能点的问法')
}

/* ═══════════ M. 诊断先行（抽题 / 分流 / 计划 / 换一套题） ═══════════ */
console.log('\n═══ M. 诊断先行（core/diagnose.js）═══')
{
  const dBank = normalizeBank({
    meta: { title: 'M' },
    questions: [
      { no: 1, type: 'single', stem: '甲', options: ['x', 'y'], answer: 'A', chapter: '第一章', tags: ['ref'] },
      { no: 2, type: 'judge', stem: '乙', answer: 'T', chapter: '第一章', tags: ['ref'] },
      { no: 3, type: 'multiple', stem: '丙', options: ['x', 'y', 'z'], answer: 'AB', chapter: '第一章', tags: ['computed'] },
      { no: 4, type: 'single', stem: '丁', options: ['x', 'y'], answer: 'B', chapter: '第二章', tags: ['watch'] },
      {
        no: 5,
        type: 'code',
        mode: 'fill',
        stem: '戊',
        code: 'const a = ___',
        blanks: [{ answer: 'ref' }],
        chapter: '第二章',
        tags: ['ref'],
        source: { url: 'https://vuejs.org/x', heading: 'X 节' },
      },
      { no: 6, type: 'code', mode: 'spot', stem: '己', code: 'a\nb', answer: 1, chapter: '第二章', tags: ['watch'] },
    ],
  })
  const qs = [dBank.questions.length]
  eq(qs[0], 6, 'M0 测试题库有 6 道题')

  // ── M1 抽题：只抽快题型、铺开覆盖、可复现 ──
  const picked = DI.pickDiagnostic({ questions: dBank.questions, count: 4 })
  eq(picked.length, 4, 'M1 按数量抽')
  ok(
    picked.every((q) => q.type === 'single' || q.type === 'judge' || (q.type === 'code' && q.mode === 'fill')),
    'M1 ★ 只抽"快"的题（多选慢、找错/修好它要动手，都留到分流之后）',
  )
  ok(new Set(picked.map((q) => q.chapter)).size >= 1, 'M1 覆盖到章节')
  const again = DI.pickDiagnostic({ questions: dBank.questions, count: 4 })
  eq(again.map((q) => q.no).join(','), picked.map((q) => q.no).join(','), 'M1 ★ 同种子抽出来的题一样（两次诊断分数才能比）')
  eq(DI.pickDiagnostic({ questions: dBank.questions, chapter: '第一章' }).every((q) => q.chapter === '第一章'), true, 'M1 按章节抽题')
  eq(DI.pickDiagnostic({ questions: [], count: 4 }).length, 0, 'M1 空题库不炸')
  eq(DI.pickDiagnostic({ questions: dBank.questions.slice(0, 2), count: 10 }).length, 2, 'M1 题不够时有多少给多少')

  // ── M2 分流线：80 / 50 ──
  eq(DI.routeFor(100).key, 'advanced', 'M2 满分 → 上强度')
  eq(DI.routeFor(80).key, 'advanced', 'M2 ★ 正好 80 算上强度（含等号）')
  eq(DI.routeFor(79).key, 'standard', 'M2 差一分就进中间档')
  eq(DI.routeFor(50).key, 'standard', 'M2 ★ 正好 50 还留在中间档')
  eq(DI.routeFor(49).key, 'remedial', 'M2 低于 50 → 先看原文')
  eq(DI.routeFor(0).key, 'remedial', 'M2 一道不对 → 先看原文')
  eq(DI.routeFor(undefined).key, 'remedial', 'M2 没数据当 0 处理（不炸）')
  ok(DI.routeFor(90).desc.includes('浪费'), 'M2 上强度那条会说明"再顺序刷是浪费时间"')

  // ── M3 汇总：正确率 + 最弱的知识点 ──
  const s = DI.summarizeDiagnostic([
    { q: dBank.questions[0], ok: true }, // ref 对
    { q: dBank.questions[1], ok: false }, // ref 错
    { q: dBank.questions[4], ok: false }, // ref 错
    { q: dBank.questions[3], ok: true }, // watch 对
  ])
  eq(s.total, 4, 'M3 总数')
  eq(s.correct, 2, 'M3 对了几道')
  eq(s.accuracy, 50, 'M3 正确率 50%')
  eq(s.route.key, 'standard', 'M3 50% → 中间档')
  eq(s.weakTags[0].name, 'ref', 'M3 ★ 最弱的知识点排最前（ref 1/3）')
  eq(DI.summarizeDiagnostic([]).accuracy, 0, 'M3 没作答时正确率 0（不炸）')

  // ── M4 计划：每一步都要能点 ──
  const adv = DI.planFor({ summary: DI.summarizeDiagnostic([{ q: dBank.questions[0], ok: true }]), questions: dBank.questions })
  ok(adv.steps.some((x) => x.action === 'practice-spot'), 'M4 上强度那条给"做找错行"')
  ok(adv.steps.some((x) => x.action === 'practice-write'), 'M4 ★ 上强度那条给"手写"（这一档现在是真题型，不是一句建议）')
  ok(adv.steps.some((x) => x.action === 'diagram'), 'M4 上强度那条也给"画图/说清楚"')
  const rem = DI.planFor({ summary: DI.summarizeDiagnostic([{ q: dBank.questions[0], ok: false }]), questions: dBank.questions })
  ok(rem.steps.some((x) => x.action === 'read'), 'M4 先看原文那条给"读原文"')
  ok(rem.steps.some((x) => x.action === 'practice-fill'), 'M4 先看原文那条给"跑最小示例（填空题）"')
  ok(rem.steps.some((x) => x.action === 'rediagnose'), 'M4 先看原文那条给"再做一遍诊断"')
  ok(rem.steps.find((x) => x.action === 'practice-fill').detail.includes('道'), 'M4 步骤里说清有多少道')

  // ── M5 分流要真的换一套题（不是界面上一句话）──
  const fAdv = DI.sessionFiltersFor('advanced', { chapter: '第二章' })
  eq(fAdv.filters.codeModes.join(','), 'spot,fix,write', 'M5 ★ 高分档：只出找错行 + 修好它 + 手写')
  eq(fAdv.filters.chapter, '第二章', 'M5 仍然限定在这一章')
  const fRem = DI.sessionFiltersFor('remedial', { chapter: '第二章' })
  eq(fRem.filters.codeModes.join(','), 'fill', 'M5 ★ 低分档：只出可跑的填空题')
  eq(DI.sessionFiltersFor('standard', {}).filters.codeModes.length, 0, 'M5 中间档不筛代码模式（全做）')

  // ── M6 诊断判定和练习页用同一份判据 ──
  const sp = dBank.questions.find((q) => q.mode === 'spot')
  eq(DI.judgeOne(sp, ['1']), true, 'M6 找错行判对')
  eq(DI.judgeOne(sp, ['2']), false, 'M6 找错行判错')
  eq(DI.judgeOne(dBank.questions[0], ['A']), true, 'M6 选择题判对（复用 isCorrect）')
  eq(DI.judgeOne(dBank.questions[0], ['B']), false, 'M6 选择题判错')

  // ── M7 代码题/找错题也能进诊断题库（不然教材题库没法诊断）──
  const codePicked = DI.pickDiagnostic({ questions: dBank.questions, chapter: '第二章', count: 4 })
  ok(codePicked.length >= 2, 'M7 第二章抽到了题')
  ok(
    codePicked.every((q) => q.type !== 'code' || q.mode === 'fill'),
    'M7 抽题时把"找错行"排除掉（它属于分流之后的学习动作）',
  )
}

/* ═══════════ N. Java 真跑 + 站内提权（core/java.js、core/elevate.js） ═══════════ */
console.log('\n═══ N. Java 真跑与提权的纯逻辑 ═══')
{
  // ── N1 敲键序列的状态机（时间从外面喂，所以完全确定）──
  let st = { progress: 0, startMs: 0 }
  const feed = (keys, t0 = 1000) =>
    keys.reduce((s, k, i) => EK.knockStep(s, k, t0 + i * 100, 5000), st)
  st = feed(['x', 's', '9', '9'])
  eq(st.progress, 4, 'N1 按到第 4 个键，进度是 4')
  eq(st.matched, false, 'N1 还没凑齐')
  st = EK.knockStep(st, '9', 1500, 5000)
  eq(st.matched, true, 'N1 ★ 第五个键凑齐 → 触发')

  // 超时：整段超过 5 秒就得重来（用户的原话是"5 秒内分别摁下"）
  st = feed(['x', 's'])
  eq(st.progress, 2, 'N1 先按 x s 到第 2 位')
  st = EK.knockStep(st, '9', 1000 + 6000, 5000) // 第三个键来的时候已经超窗
  eq(st.progress, 0, 'N1 ★ 超窗之后按 9：清零（9 不是开头，重新等 x）')
  st = EK.knockStep({ progress: 2, startMs: 1000 }, 'x', 7000, 5000)
  eq(st.progress, 1, 'N1 ★ 超窗之后按 x：当作新的开头')

  // 中途按了别的键：不清零（不然必须一次不差，体验很差），超时兜底
  st = EK.knockStep({ progress: 0, startMs: 0 }, 'x', 100)
  st = EK.knockStep(st, 'z', 200)
  eq(st.progress, 1, 'N1 中途按别的键不清零（超时自然会兜住）')
  // 按错之后重新从 x 开始
  st = EK.knockStep(st, 'x', 300)
  eq(st.progress, 1, 'N1 再按 x 仍然是第 1 位')
  st = EK.knockStep(st, 's', 400)
  eq(st.progress, 2, 'N1 接着 s 就走到第 2 位')

  // 大小写不敏感（按 Shift 打了 X 也该算）
  eq(EK.knockStep({ progress: 0, startMs: 0 }, 'X', 100).progress, 1, 'N1 大写 X 也算')

  // ── N2 ★ 在输入框里打字不能触发（否则代码题里敲 xs999 会弹密码框）──
  eq(EK.shouldIgnoreTarget({ tagName: 'INPUT' }), true, 'N2 INPUT 里不触发')
  eq(EK.shouldIgnoreTarget({ tagName: 'TEXTAREA' }), true, 'N2 TEXTAREA 里不触发')
  eq(EK.shouldIgnoreTarget({ tagName: 'DIV', isContentEditable: true }), true, 'N2 可编辑 div 不触发')
  eq(
    EK.shouldIgnoreTarget({ tagName: 'DIV', closest: () => ({}) }),
    true,
    'N2 代码编辑器（CodeMirror/Monaco 是 div）不触发',
  )
  eq(EK.shouldIgnoreTarget({ tagName: 'DIV', closest: () => null }), false, 'N2 普通 div 照常触发')
  eq(EK.shouldIgnoreTarget(null), false, 'N2 没有 target 时按常触发')

  // ── N3 ★ Java 结果的形状必须和浏览器沙箱一致（判定才能不分叉）──
  const okRun = JV.javaResultToRun({
    ok: true,
    phase: 'ok',
    output: 'hi\r\n张三\n',
    stderr: ['[status] 200'],
    exit_code: 0,
    sandbox: 'bwrap',
  })
  eq(okRun.ok, true, 'N3 跑通 → ok')
  eq(okRun.output, 'hi\n张三', 'N3 ★ CRLF 被归一化成 LF、尾部空行丢掉')
  ok(
    okRun.lines.some((l) => l.kind === 'stderr' && l.text.includes('[status]')),
    'N3 诊断信息在 lines 里看得见',
  )
  eq(okRun.meta.sandbox, 'bwrap', 'N3 如实带上隔离方式')
  // 关键：stderr 不能混进 output（Servlet 驱动的诊断会污染期望输出比对）
  ok(!okRun.output.includes('[status]'), 'N3 ★ stderr 不参与判定（不混进 output）')
  eq(CD.judgeRun({ run: { expect: ['hi', '张三'] } }, okRun.output), true, 'N3 归一化后能和期望对上')

  const compileFail = JV.javaResultToRun({ ok: false, phase: 'compile', compile_errors: ['Bad.java:1: 错误'] })
  eq(compileFail.ok, false, 'N3 编译失败 → ok=false')
  eq(compileFail.timedOut, false, 'N3 编译失败不是超时')
  ok(compileFail.error.includes('编译没过'), 'N3 编译错误要说清是编译错（和运行异常要分开）')

  const boom = JV.javaResultToRun({ ok: false, phase: 'run', stderr: ['Exception in thread "main"'] })
  ok(boom.error.includes('运行时抛异常'), 'N3 运行异常和编译失败是两种话术')

  const to = JV.javaResultToRun({ ok: false, phase: 'timeout' })
  eq(to.timedOut, true, 'N3 超时 → timedOut')

  // ── N4 从代码抠类名当文件名（Java 的硬规矩：public 类名必须等于文件名）──
  eq(
    Object.keys(JV.javaSources('public class HelloServlet extends HttpServlet {}'))[0],
    'HelloServlet.java',
    'N4 文件名跟着 public 类名走',
  )
  eq(Object.keys(JV.javaSources('public final class Foo {}'))[0], 'Foo.java', 'N4 final class 也认')
  eq(Object.keys(JV.javaSources('int x = 1;'))[0], 'Main.java', 'N4 抠不到类名就退回 Main.java')

  // ── N5 ★ Java 的可运行性判据（不是权限，是能力边界）──
  ok(
    CD.runBlockReason({ type: 'code', lang: 'java', code: 'public class A {}', mode: 'fill' }).includes('JSP') ===
      false,
    'N5 纯 Java 片段不拦',
  )
  eq(
    CD.runBlockReason({ type: 'code', lang: 'java', code: '<% out.print(1); %>', mode: 'fix' }).includes('JSP'),
    true,
    'N5 ★ JSP 拦住（要容器，板子上没有）',
  )
  eq(
    CD.runBlockReason({
      type: 'code',
      lang: 'java',
      code: 'Connection c = DriverManager.getConnection("jdbc:mysql://x");',
      mode: 'fix',
    }).includes('JDBC'),
    true,
    'N5 ★ JDBC 拦住（要真数据库 + 驱动）',
  )
  eq(
    CD.runBlockReason({ type: 'code', lang: 'java', code: 'package a;\npublic class A {}', mode: 'fix' }).length > 0,
    true,
    'N5 带 package 声明的拦住',
  )

  // ── N6 ★ vue-html 的拒绝理由要分开说（以前对全部 vue-html 都说"没有编译器"）──
  const sfcMsg = CD.runBlockReason({
    type: 'code',
    lang: 'vue-html',
    code: '<script setup>\nconst a = ref(0)\n</script>\n<template><p>{{ a }}</p></template>',
    mode: 'fix',
  })
  ok(sfcMsg.includes('SFC 编译器'), 'N6 完整 SFC 的理由是"没有编译器"')
  const fragMsg = CD.runBlockReason({ type: 'code', lang: 'vue-html', code: '<button @click="n++">+1</button>', mode: 'fix' })
  eq(fragMsg.includes('没有配套'), true, 'N6 ★ 裸片段的理由是"没有配套状态"，不是"没有编译器"')
  ok(!fragMsg.includes('编译器'), 'N6 ★ 不该对片段说"没有编译器"（那是假话）')
  const tplMsg = CD.runBlockReason({
    type: 'code',
    lang: 'vue-html',
    code: '<template><p>{{ a }}</p></template>',
    mode: 'fix',
  })
  eq(tplMsg.includes('没有配套'), true, 'N6 只有模板的也归到"没有配套状态"')
}

/* ═══════════ O. 题库分层（懒加载：大题库不进主包，且清单不飘） ═══════════ */console.log('\n═══ N. 题库分层与懒加载清单 ═══')
{
  const BANKS = path.join(HERE, '..', 'src', 'banks')
  const BIG = path.join(BANKS, 'big')
  const BIG_LIMIT = 200 * 1024

  const readDir = (dir, skipIndex = false) =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.json') && !(skipIndex && f === 'index.json' && dir === BIG))
          .filter((f) => f !== 'index.json')
      : []

  const small = readDir(BANKS)
  ok(small.length > 0, `banks/ 根目录有 ${small.length} 套小题库（自动上架、打进主包）`)

  // ★ 规矩一：超过 200KB 的题库不许留在根目录（它会被打进每个人的主包）
  const fat = small.filter((f) => fs.statSync(path.join(BANKS, f)).size > BIG_LIMIT)
  ok(
    fat.length === 0,
    `★ 根目录没有超 ${BIG_LIMIT / 1024}KB 的题库（有就挪到 banks/big/）`,
    fat.join('、'),
  )

  // ★ 规矩二：big/ 里的清单必须和目录一一对应（清单是生成的，飘了就是有人改了没重跑）
  const bigFiles = readDir(BIG)
  ok(bigFiles.length > 0, `banks/big/ 里有 ${bigFiles.length} 套大题库`)
  const index = JSON.parse(fs.readFileSync(path.join(BIG, 'index.json'), 'utf8'))
  eq(index.length, bigFiles.length, '★ 清单条数 = big/ 里的题库数')
  eq(
    index.map((c) => c.file).sort().join(','),
    [...bigFiles].sort().join(','),
    '★ 清单里的文件名和目录一致（没有多列/漏列）',
  )

  // ★ 规矩三：卡片上的字段必须和真题库对得上（生成物也不能飘）
  for (const card of index) {
    const real = JSON.parse(fs.readFileSync(path.join(BIG, card.file), 'utf8'))
    const qs = real.questions || []
    eq(card.total, real.meta?.total ?? qs.length, `N 卡片题量 = ${card.file} 的实际题量`)
    eq(card.title, String(real.meta?.title || ''), `N 卡片标题 = ${card.file} 的 meta.title`)
    eq(card.id, String(real.meta?.id || ''), `N 卡片 id = ${card.file} 的 meta.id`)
    const codeCount = qs.filter((q) => q.type === 'code').length
    if (codeCount) eq(card.counts?.code, codeCount, `N 代码题数量也进了卡片（${card.file}）`)
  }

  // ★ 规矩四：大题库确实"大"（不然放在 big/ 里纯属绕远路）
  const thin = bigFiles.filter((f) => fs.statSync(path.join(BIG, f)).size <= BIG_LIMIT)
  ok(thin.length === 0, '★ big/ 里没有小题库（小题库直接放 banks/ 就会自动上架）', thin.join('、'))

  // 仓库里那份生成工具的规矩要和这里一致（数字写两遍就会飘）
  const toolSrc = fs.readFileSync(path.join(HERE, '..', '..', 'tools', 'make_bank_index.mjs'), 'utf8')
  ok(
    toolSrc.includes('200 * 1024'),
    'N 生成工具里的阈值也是 200KB（和这条断言一致）',
  )

  // ★ 规矩五：**带 run 的代码题必须真能跑**，判据用界面那一个函数（CD.runBlockReason）。
  //   这条是拿两次真事故换来的 —— 两次都是"判据写了两份"：
  //     · 校验器里手写 `q.lang !== 'js'` → 加了 Java 真跑之后把 java 题全判成跑不了
  //     · 出题工具里手写正则（漏了 `fetch`）→ 出了两道"判据是运行输出、界面却拒绝运行"的题
  //   所以这里扫**所有**题库，把不变量钉死；谁再写第二份判据，这条会红。
  for (const [dir, files] of [
    [BANKS, small],
    [BIG, bigFiles],
  ]) {
    for (const f of files) {
      const real = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      const bad = (real.questions || []).filter((q) => q.run && CD.runBlockReason(q) !== '')
      ok(
        bad.length === 0,
        `★ ${f}：带 run 的代码题都必须真能跑（判据 = 界面同一个 runBlockReason）`,
        bad.slice(0, 3).map((q) => `第${q.no}：${CD.runBlockReason(q)}`).join('；'),
      )
    }
  }

  // ★ 规矩六：**已上架的拖拽排序题，每一道都要站得住**。
  //   排序题是"零额度自动生成"的（`units_to_parsons.mjs` / `add_parsons.mjs`），
  //   自动生成的东西必须逐题查不变量 —— 只抽查一两道，剩下的可能全是歪的。
  //   判据用 `PS.judgeParsons`（界面上那一个，判定只有一份实现）。
  //   ⚠️ 必须**同时扫 big/**：65 道排序题就在 `big/vue-code-tasks.json` 里，
  //      只扫根目录等于没查（第一版就是这个漏洞）。
  for (const [dir, files] of [
    [BANKS, small],
    [BIG, bigFiles],
  ]) {
    for (const f of files) {
      const real = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      const orders = (real.questions || []).filter((q) => q.mode === 'order')
      for (const q of orders) {
        const keys = (q.blocks || []).map((b) => b.key)
        const bad = []
        if (keys.length < 3) bad.push('块少于 3')
        if (new Set(keys).size !== keys.length) bad.push('块 key 重复')
        if ((q.answer || []).length !== keys.length) bad.push('答案数与块数对不上')
        if (new Set(q.answer || []).size !== (q.answer || []).length) bad.push('答案里有重复块')
        if ((q.answer || []).some((k) => !keys.includes(k))) bad.push('答案里有不存在的块')
        if ((q.blocks || []).some((b) => !String(b.text || '').trim())) bad.push('有空块')
        if ((q.blocks || []).some((b) => /^[\s(){}[\];,]+$/.test(String(b.text)))) bad.push('有只含标点的块')
        if ((q.answer || []).every((k, i) => keys[i] === k)) bad.push('原样就是答案（没打乱）')
        // ★ 打乱要打得动：只挪一块的题学生一眼就看出来（实测 65 道里曾有 8 道是这样）
        const servedOk = PS.judgeParsons(keys, q.answer)
        if (keys.length - servedOk.correct < 2) bad.push(`只挪了 ${keys.length - servedOk.correct} 块（太容易）`)
        if (!PS.judgeParsons(q.answer, q.answer).ok) bad.push('照答案排却不判对')
        if (PS.judgeParsons([...q.answer].reverse(), q.answer).ok && keys.length > 1) bad.push('倒着排也判对')
        ok(bad.length === 0, `★ ${f} 第 ${q.no} 题的排序题站得住`, bad.join('；'))
      }
      if (orders.length) ok(true, `（${f} 里 ${orders.length} 道排序题都查过了）`)
    }
  }

  // ★ 规矩七：**章节名/出处标题不能带 OCR 弯引号噪声**。
  //   为什么值得钉：题目卡上的"章节"就是"你哪一节最弱"那条统计的分桶键 ——
  //   带噪声（`3.6.2 “重定向`）的话，同一节会被分成两桶，统计直接花掉。
  //   ⚠️ **反引号不算噪声**：官方文档标题里的反引号是正经 markdown
  //      （``The `<Transition>` Component``、`` `v-if` ``）—— 第一版把它们也当成噪声，
  //      结果把两套老题库全判红了（假红比漏判更浪费时间）。
  const OCR_QUOTES = /[“”‘’「」『』]/
  for (const [dir, files] of [
    [BANKS, small],
    [BIG, bigFiles],
  ]) {
    for (const f of files) {
      const real = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      const noisy = (real.questions || []).filter((q) => OCR_QUOTES.test(String(q.chapter || '')))
      ok(
        noisy.length === 0,
        `★ ${f}：章节名里没有 OCR 弯引号噪声（统计按它分桶）`,
        noisy.slice(0, 3).map((q) => `第${q.no}：${q.chapter}`).join('；'),
      )
      const noisyHead = (real.questions || []).filter((q) =>
        OCR_QUOTES.test(String((q.source || {}).heading || '')),
      )
      ok(
        noisyHead.length === 0,
        `★ ${f}：出处标题里也没有弯引号噪声`,
        noisyHead.slice(0, 3).map((q) => `第${q.no}：${q.source.heading}`).join('；'),
      )
    }
  }
}

/* ═══════════ P. 文档模型（扫描件版面 → 结构化，纯函数） ═══════════ */
console.log('\n═══ P. 文档模型（页眉页脚 / 行号栏 / 漏行 / 低置信）═══')
{
  // 夹具的形状**照真实样张抄**（《Java Web 程序设计任务教程》9 页扫描件，
  // 实测：页眉 `112 JavaWeb…`、页脚 `第3章 Servlet 113`、代码行号在 x≈272~302、
  // 代码从 x≈350 开始、每页底部有「夸克扫描王」水印）。
  // 真实 9 页的端到端验收在 quiz/tools/docmodel_check.mjs（要 OCR，慢）。
  const W = 2480
  const H = 3508
  const word = (text, x0, x1, y, conf = 95) => ({ text, confidence: conf, bbox: { x0, y0: y, x1, y1: y + 40 } })
  const line = (text, y, { conf = 95, x0 = 350, x1 = 1900, words = null } = {}) => ({
    text,
    confidence: conf,
    bbox: { x0, y0: y, x1, y1: y + 40 },
    words: words || [word(text, x0, x1, y, conf)],
  })
  // 代码行：左边一个行号词（贴左边缘）+ 代码词
  const codeLine = (gutter, code, y, conf = 93) => line(`${gutter} ${code}`, y, {
    conf,
    words: [word(String(gutter), 272, 302, y), word(code, 350, 1800, y, conf)],
  })

  const page1 = {
    page: 1,
    width: W,
    height: H,
    lines: [
      line('112 JavaWeb程序设计任务教程（第3版）', 60), // 页眉（顶部带 + 跨页重复）
      codeLine(18, 'resp.setHeader("Cache-Control",', 600),
      codeLine(19, '"no-cache, no-store, must-revalidate");', 640),
      codeLine(20, '// 添加两个额外的响应头', 680),
      codeLine(22, 'resp.addHeader("X-Custom-Header", "Version 1.0");', 720), // ★ 21 漏了
      codeLine(23, 'resp,setHeader("X-Custom-Header", "Admin");', 760), // ★ 点号被认成逗号
      line('PrintWriter pw = resp.getWriter();', 800, { conf: 41 }), // ★ 低置信（且无行号）
      line('在上述代码中，第14～22行代码设置了一系列响应头信息。', 900),
      line('回 responseservlet01 ¥ Response Headers 口 Raw', 1000),
      line('Cache-Control: no-cache, no-store, must-revalidate', 1040),
      line('Content-Type: text/html;charset=UTF-8', 1080),
      line('图 3-17 名称为 responseservlet01 的响应头信息', 1120), // 图题注（图里文字在前面）
      line('表 3-13 HttpServletResponse 接口设置响应体的方法', 1200),
      line('方法 描述', 1240),
      line('PrintWriter 返回一个 PrintWriter 对象，用于向客户端发送字符数据', 1280),
      line('3.5.2 设置响应体', 1400), // 三级小节
      line('在HTTP响应中，大量数据都是通过响应体发送的。', 1500),
      line('夸克扫描王', 3400), // 水印
      line('第3章 Servlet 113', 3440), // 页脚（底部带 + 跨页重复）
    ],
  }
  const page2 = {
    page: 2,
    width: W,
    height: H,
    lines: [
      line('112 JavaWeb程序设计任务教程（第3版）', 60),
      line('第3章 Servlet 113', 3440),
      line('文件 3-14 ResponseServlet02.java', 500), // 代码清单题注
      codeLine(1, 'import jakarta.servlet.ServletException;', 540),
      codeLine(2, 'import jakarta.servlet.annotation.WebServlet;', 580),
      codeLine(3, '1mport jakarta.servlet.http.HttpServlet;', 620), // ★ i/l/1 互认
    ],
  }

  const model = DM.buildDocModel([page1, page2])
  const flat = model.pages.flatMap((p) => p.blocks)
  const allText = DM.docModelToPages(model).flat().join('\n')
  const kinds = (k) => flat.filter((b) => b.kind === k)

  // ① 跨页版面行（页眉/页脚）与固定水印必须剔除
  const droppedKinds = model.pages.flatMap((p) => p.dropped.map((d) => d.kind))
  ok(droppedKinds.filter((k) => k === 'running-head' || k === 'band-repeat').length >= 3, '页眉/页脚按「位置 + 跨页重复」被剔除', droppedKinds.join(','))
  ok(droppedKinds.includes('watermark'), '扫描 App 的水印被剔除')
  ok(!allText.includes('夸克扫描王'), '水印没有留在正文里')
  ok(!allText.includes('第3章 Servlet 113'), '页脚没有留在正文里（否则每页都会混进一句）')
  ok(allText.includes('在上述代码中'), '正文段落没有被误删')

  // ② 行号栏按坐标剥离：行号不能在正文里，但**要**被收集起来做漏行检测
  const codeBlocks = kinds('code')
  ok(codeBlocks.length >= 2, `代码清单成块（${codeBlocks.length} 个）`)
  ok(!allText.includes('18 resp.setHeader'), '行号与代码被切开（`18 resp.` → `resp.`）')
  ok(allText.includes('resp.setHeader("Cache-Control",'), '代码行本体还在')
  const first = codeBlocks.find((b) => b.gutterNumbers && b.gutterNumbers.length)
  ok(!!first && first.gutterNumbers.includes(18) && first.gutterNumbers.includes(23), '行号被收集成数字（18…23）', JSON.stringify(first && first.gutterNumbers))

  // ③ 漏行检测：行号连续性是**唯一确定性**的漏行判据
  const missing = model.review.filter((r) => r.code === 'missing-lines')
  eq(missing.length, 1, '报出 1 处漏行')
  ok(!!missing[0] && missing[0].message.includes('21'), '漏的正是第 21 行（夹具里故意抽掉的那行）', missing[0] && missing[0].message)

  // ④ 低置信与代码可疑串：只标不改
  const lowConf = model.review.filter((r) => r.code === 'low-confidence')
  ok(lowConf.length >= 1, `低置信行进了待核对清单（${lowConf.length} 条）`)
  const suspect = model.review.filter((r) => r.code === 'code-suspect')
  ok(suspect.length >= 2, `代码可疑串被标出（${suspect.length} 条：逗号当点号 / 1mport）`, suspect.map((s) => s.text).join(' | '))
  ok(allText.includes('resp,setHeader'), '★ 可疑串**没有被自动改掉**（只标不改：改要有 javac 判据）')

  // ⑤ 图 / 表 / 标题各自成块（"按材料里真实存在什么决定出什么"的前提）
  eq(kinds('figure').length, 1, '图题注识别出 1 个图块')
  ok(kinds('figure')[0].lines.length >= 4, '图里的界面文字被归进图块（不是当正文出题）', String(kinds('figure')[0].lines.length))
  eq(kinds('table').length, 1, '表题注识别出 1 个表块')
  ok(kinds('table')[0].columnsLost === true, '表格标记「列关系已丢」（OCR 只给行）')
  const heading = kinds('heading').find((b) => b.number === '3.5.2')
  ok(!!heading, '三级小节 `3.5.2` 识别成标题')
  const after = flat[flat.indexOf(heading) + 1]
  ok(!!after && after.section.includes('3.5.2'), '标题后面的块带上了章节路径', after && after.section)
  const caption = codeBlocks.find((b) => b.caption)
  ok(!!caption && DM.furnitureKey(caption.caption).includes('文件'), '代码清单题注（`文件 3-14`）成为块标题', caption && caption.caption)

  // ⑥ 表格行的判定：宽间隙
  ok(model.stats.tables === 1 && model.stats.figures === 1, '统计口径（表格 1 / 图 1）')

  // ⑦ 出口：给后端的 pages 契约 + 人看的文本
  const pages = DM.docModelToPages(model)
  eq(pages.length, 2, 'docModelToPages 保持「一页一个数组」的契约')
  eq(pages[0].filter((l) => l.includes('JavaWeb程序设计任务教程')).length, 0, '出口文本里没有页眉')
  ok(DM.modelToText(model).includes('<!-- page 2 -->'), 'modelToText 带页标记')

  // ⑧ 不许静默通过：有 high 就必须人显式确认
  ok(DM.canProceed(model).ok === false, '有待核对项时 canProceed = false（不许静默通过）')
  ok(DM.canProceed(model, { acked: true }).ok === true, '人确认过之后才能往下走')

  // ⑧b 站主反馈「红底 checkbox 点了没用」的根因：计数**跨页**，而一次只渲染当前页。
  //     所以必须能算出"还剩在哪一页"，否则人把当前页点完、按钮还是灰的，看起来就是控件坏了。
  {
    const idxHi = model.review.map((r, i) => (r.level === 'high' ? i : -1)).filter((i) => i >= 0)
    ok(idxHi.length >= 2, '这份夹具里至少要有多条高风险项才测得出跨页', String(idxHi.length))
    const none = DM.remainingHighByPage(model, new Set())
    eq([...none.values()].reduce((a, b) => a + b, 0), idxHi.length, '没核对时：按页分组的总数 = 高风险项总数')
    const byPage = model.review.filter((r) => r.level === 'high')
    const pagesSeen = new Set(byPage.map((r) => r.page))
    eq(none.size, pagesSeen.size, '★ 分组数 = 有高风险项的那几页（人靠这个知道该翻哪一页）')
    const half = new Set(idxHi.slice(0, 1))
    const after = DM.remainingHighByPage(model, half)
    eq([...after.values()].reduce((a, b) => a + b, 0), idxHi.length - 1, '确认一条就少一条')
    ok(
      !after.has(byPage[0].page) || after.get(byPage[0].page) < none.get(byPage[0].page),
      '该页的计数会跟着降（否则界面上看不出点击生效）',
    )
    eq(DM.remainingHighByPage(model, new Set(idxHi)).size, 0, '全确认完就没有剩余页')
  }

  // ⑧c 站主反馈「有些错误的地方没有交互按钮改不了」的落点：
  //     "这一块不用于出题"必须真的把这一块的文字从出口里拿掉（不是只写个注释）。
  {
    const target = model.pages[0].blocks.find((b) => b.lines.length)
    const before = DM.docModelToPages(model)[0].length
    const probe = target.lines[0].text
    target.excluded = true
    const after = DM.docModelToPages(model)[0]
    eq(after.length, before - target.lines.filter((l) => l.text.trim()).length, '★ 排除一块 → 出口文本里少了这块的行')
    ok(!after.includes(probe), '★ 被排除的那一行确实不在出口文本里', probe.slice(0, 30))
    ok(DM.modelToText(model).includes('这一块被人工排除'), '导出文本里留了"被排除"的痕迹（不是无声删掉）')
    target.excluded = false
    eq(DM.docModelToPages(model)[0].length, before, '恢复之后又回来了（按钮是双向的）')
  }

  // ⑨ 单页也要能用（学生是断断续续传几页的）；空输入要炸得明白
  const one = DM.buildDocModel([{ ...page1, lines: page1.lines.slice(0, 3) }])
  eq(one.pages.length, 1, '单页输入也能建模型（增量摄入的前提）')
  // ★ 只传一页时"跨页重复"不成立 —— 页眉必须靠**形态**（行首/行尾带页码）判出来。
  //   真实事故：两页的浏览器验收里，页眉 `112 JavaWeb程序设计任务教程（第3版）` 留在了正文里。
  const oneDropped = one.pages[0].dropped.map((d) => d.text).join('\n')
  ok(oneDropped.includes('JavaWeb程序设计任务教程'), '★ 单页上传也能认出页眉（靠"带页码"的形态）', oneDropped.replace(/\n/g, ' | '))
  ok(!DM.docModelToPages(one)[0].some((l) => l.includes('JavaWeb程序设计任务教程')), '单页模型里页眉不在正文里')
  eq(DM.looksLikeFurnitureLine('把这一章的内容压缩成 20 行'), false, '成句的正文不算版面行')
  eq(DM.looksLikeFurnitureLine('第 3 章 Servlet 113'), true, '页脚形态（行尾页码）算版面行')
  eq(DM.looksLikeFurnitureLine('第 3 章 Servlet'), false, '★ 章标题不算版面行（误删一章的开头比留一行页眉贵）')
  let threw = ''
  try {
    DM.buildDocModel([])
  } catch (e) {
    threw = String(e.message || e)
  }
  ok(threw.includes('不能为空'), '空输入报错信息可读', threw)

  // ⑩ 两个纯函数判据（挡的是"行号 12 被认成 1.2"这个实测过的坑）
  eq(DM.gutterNumber('1.2'), 12, '`1.2` 认成行号 12（OCR 实测会这样）')
  eq(DM.gutterNumber('27'), 27, '普通行号')
  eq(DM.GUTTER_RE.test('3.14'), false, '`3.14` 不算行号（别误伤字面量）')
  eq(DM.furnitureKey('第3章 Servlet 113'), DM.furnitureKey('第4章 Servlet 120'), 'furnitureKey 抹掉数字后页脚能配上')
}

/* ═══════════ Q. 预习页（扫描件 → 教学骨架 / 术语 / 先猜后验） ═══════════ */
console.log('\n═══ Q. 预习页（确定性抽取，零额度）═══')
{
  const W = 2480
  const H = 3508
  const word = (text, x0, x1, y, conf = 95) => ({ text, confidence: conf, bbox: { x0, y0: y, x1, y1: y + 40 } })
  const line = (text, y, { conf = 95, words = null } = {}) => ({
    text,
    confidence: conf,
    bbox: { x0: 350, y0: y, x1: 1900, y1: y + 40 },
    words: words || [word(text, 350, 1900, y, conf)],
  })
  const codeLine = (gutter, code, y, conf = 95) =>
    line(`${gutter} ${code}`, y, { conf, words: [word(String(gutter), 272, 302, y), word(code, 350, 1800, y, conf)] })

  const pageA = {
    page: 1,
    width: W,
    height: H,
    lines: [
      line('112 Java Web 程序设计任务教程（第3版）', 60),
      line('请求转发是服务器内部的一种资源跳转方式，客户端并不知情。', 400),
      line('的开发者工具中查看名称为 responseservlet01的响应头信息。', 440), // ★ 半句话：不该进术语表
      codeLine(18, 'resp.setHeader("X-Custom-Header", "1");', 600),
      codeLine(19, 'resp.setHeader("X-Custom-Header", "2");', 640),
      codeLine(20, 'zesp.setHeader("X-Custom-Header", "3");', 680), // ★ zesp 全书只出现一次
      codeLine(21, 'resp.sendRedirect("page.jsp");', 720, 40), // ★ 低置信行
      // 让 getWriter 在"书里"出现 ≥2 次（这一次 + 下面表格里那次）——
      // 印证规则要求拉丁术语出现过多次才敢用（见 core/lesson.js 的 buildVocabulary）
      codeLine(22, 'PrintWriter pw = resp.getWriter();', 760),
      line('表 3-13 HttpServletResponse 接口设置响应体的方法', 800),
      line('getWriter 返回一个 PrintWriter 对象，用于发送字符数据', 840),
      line('pg 返回一个 prin ter 对象', 880), // ★ pg 只出现一次（真实样张里是 pw 被认花）
      line('感谢阅读', 3400),
    ],
  }
  const pageB = { ...pageA, page: 2, lines: [
    line('112 Java Web 程序设计任务教程（第3版）', 60),
    codeLine(1, 'resp.setHeader("X", "1");', 500),
    codeLine(2, 'resp.sendRedirect("page.jsp");', 540), // 与低置信行同词，但这一行是可信的
    line('感谢阅读', 3400),
  ] }

  const model = DM.buildDocModel([pageA, pageB])
  const lesson = LS.buildLesson(model)
  const answers = lesson.selfCheck.map((q) => q.answer)

  ok(lesson.book.includes('Java Web') && !/\d{4}\s*$/.test(lesson.book), '书名从被剔除的页眉里取，且去掉了行首页码', lesson.book)
  ok(lesson.terms.some((t) => t.term === '请求转发'), '术语表从"下定义"的句子里抽出来（教材原话留下）')
  ok(!lesson.terms.some((t) => t.term.includes('开发者工具')), '★ 半句话不会被当成术语（真实样张上抓到过 `的开发者工具中查看名`）')
  ok(lesson.terms.some((t) => t.term === 'getWriter'), '表格里的 API 名能当术语')
  ok(!lesson.terms.some((t) => t.term === 'pg'), '★ 只出现过一次的拉丁术语被拒（防 OCR 认花的词）', lesson.terms.map((t) => t.term).join('、'))
  ok(lesson.selfCheck.length >= 1, `生成出先猜后验（${lesson.selfCheck.length} 道）`)
  ok(answers.includes('setHeader'), '★ 书里出现过多次的 API 会被挖空', answers.join('、'))
  ok(!answers.includes('zesp'), '★ 只出现一次的拼法不会被当成答案（那可能是 OCR 认错的）', answers.join('、'))
  ok(
    lesson.selfCheck.every((q) => q.line.includes(q.answer)),
    '每道题的答案都在它那一行里找得到（先猜后验的"验"）',
  )
  const lowConfLine = 'resp.sendRedirect("page.jsp");'
  const lowConfItems = lesson.selfCheck.filter((q) => q.line === lowConfLine && q.page === 1)
  ok(lowConfItems.length === 0, '★ 低置信行不出自测题（宁可不考，也不给错答案）')
  ok(lesson.selfCheck.some((q) => q.line === lowConfLine && q.page === 2), '同一行在**可信页**上就能出题（逐行判，不按块判）')
  const md = LS.lessonToMarkdown(lesson)
  ok(md.includes('# ') && md.includes('术语') && md.includes('先猜后验'), 'Markdown 导出含标题/术语/先猜后验三节')
  let lthrew = ''
  try {
    LS.buildLesson(null)
  } catch (e) {
    lthrew = String(e.message || e)
  }
  ok(lthrew.includes('文档模型'), '没给文档模型时报错信息可读', lthrew)

  // ── Q. 兜底：出不了选择/判断，就用教材里的代码清单出**代码题** ──────────
  //   站主 2026-10-11 实测：模型一道题都没出，整份材料就白费了；
  //   而材料里明明有代码清单。兜底这条路**不调模型、不花额度**。
  //   两种形态（都是"不需要真跑就能判对"的）：
  //     order 拖拽排序 —— 判据是教材原文的顺序
  //     fill  填空     —— 判据是教材原文那一行
  const fb = FB.buildFallbackTasks(model)
  const fbFill = fb.filter((q) => q.mode === 'fill')
  const fbOrder = fb.filter((q) => q.mode === 'order')
  ok(fb.length >= 1, `兜底能出题（${fb.length} 道：排序 ${fbOrder.length} + 填空 ${fbFill.length}）`)
  ok(fbOrder.length >= 1, '★ 兜底里有拖拽排序题（研究上证据最好的确定性题型）')
  ok(fbFill.length >= 1, '兜底里也有填空题')
  ok(
    fb.every((q) => q.type === 'code' && (q.mode === 'fill' || q.mode === 'order')),
    '兜底题只出这两种"不用真跑就能判对"的形态（predict/fix/write 的 run 必须真跑，出了也会被丢掉）',
  )
  ok(
    fbFill.every((q) => (String(q.code).match(/___/g) || []).length === q.blanks.length),
    '★ 每个空都对应一个答案（空数和 blanks 数一致，否则会被 normalize 丢掉）',
    JSON.stringify(fbFill.map((q) => [(String(q.code).match(/___/g) || []).length, q.blanks.length])),
  )
  ok(
    fbFill.every((q) => q.blanks[0].answer[0] && String(q.code).includes('___') && !String(q.code).includes(q.blanks[0].answer[0])),
    '★ 被挖掉的那个词确实不在题面代码里了（不然照着抄就过了）',
  )
  ok(fbFill.some((q) => q.blanks[0].answer[0] === 'setHeader'), '挖的是书里出现多次的 API（复用预习页那套可信判据）')
  ok(
    fbFill.every((q) => !q.blanks.some((b) => b.answer.includes('zesp'))),
    '★ 只出现一次的拼法不会被当成答案（防 OCR 认错的词当标准答案）',
  )
  ok(
    fbOrder.every((q) => q.blocks.length >= 3 && q.answer.length === q.blocks.length),
    '排序题的块数够、答案覆盖每一块',
  )
  ok(
    fbOrder.every((q) => new Set(q.answer).size === q.answer.length),
    '★ 排序题答案是这些块的一个排列（不重不漏）',
  )
  eq(fb.map((q) => q.no).join(','), fb.map((_, i) => i + 1).join(','), '两种题型混在一起时编号连续（不能各算各的）')
  ok(fb.every((q) => String(q.analysis).length > 0 && q.source && q.source.quote), '每题都带解析 + 教材原话（点开出处能自己核对）')
  ok(fb.every((q) => q.lang === 'java'), '按代码内容猜出语言（JavaWeb 教材 → java）', fb.map((q) => q.lang).join('、'))
  eq(FB.guessLang('const x = ref(0)'), 'js', 'JS 代码认得出（猜语言只为界面提示）')
  eq(FB.guessLang('今天天气不错'), '', '认不出就留空（界面会说"这段跑不了"，填空照样能做）')

  // 归一化必须能吃下去 —— 否则兜底题会静默消失，等于没兜
  const fbBank = FB.mergeIntoBank(null, fb, { title: '扫描件' })
  eq(fbBank.meta.total, fb.length, '合并后的 meta.total 与题数一致')
  const fbNorm = normalizeBank(fbBank, '扫描件')
  eq(fbNorm.questions.length, fb.length, '★ 兜底题全部通过前端归一化（不会被"选项少于 2 个"之类丢掉）')
  eq(
    fbNorm.questions.filter((q) => q.mode === 'order').length,
    fbOrder.length,
    '★ 排序题也全部通过归一化（mode/blocks/answer 一个都不能丢）',
  )

  // 后端给了一道题也要兜（站主那次就是 1 道伪题）
  const merged = FB.mergeIntoBank(
    { meta: { id: 'x', title: 'x', total: 1 }, questions: [{ stem: '后端的一道题', type: 'judge', answer: ['T'], options: [{ key: 'T', text: '正确' }, { key: 'F', text: '错误' }] }] },
    fb,
    { title: 'x' },
  )
  eq(merged.questions.length, 1 + fb.length, '后端已有的题不会被兜底题覆盖（是追加不是替换）')
  eq(merged.meta.total, 1 + fb.length, 'total 跟着重算')
  ok(String(merged.meta.description).includes('兜底'), '描述里说明了多出来的题是哪来的（不许冒充模型出的题）')
  eq(FB.mergeIntoBank(null, [], { title: 'x' }), null, '没有兜底题时原样返回 null（调用方据此报错）')

  // ── 代码输入框的补全词表（站主：「加上自动补全和颜色区分」）──────────────────
  {
    const src = 'PrintWriter pw = resp.getWriter();\npw.println("hi");'
    const words = ED.completionWords(src, 'java', ['setHeader'])
    ok(words.includes('getWriter'), '★ 题目自己的 API 进词表（补全要的是"这道题里有什么"）', words.slice(0, 8).join('、'))
    ok(words.includes('PrintWriter') || words.includes('pw'), '变量/类型名也进词表')
    ok(words.includes('setHeader'), '调用方给的额外词进词表（这一节在讲的 API）')
    ok(words.indexOf('getWriter') < words.indexOf('println'), '★ 函数名排在普通标识符前面（补全多半想打的是方法）')
    ok(words.includes('public') && words.includes('static'), '关键字兜底在里面（教材代码里没出现也得能补）')
    eq(new Set(words).size, words.length, '词表去重（重复的 label 会让补全面板出现两遍）')
    ok(!words.includes('a') && !words.includes('i'), '单字母不补（噪声）')
    eq(ED.completionWords('', 'js', []).includes('const'), true, '空代码也有关键字兜底（手写题给的是空骨架）')
    eq(ED.guessLang('public class A { }'), 'java', 'Java 认得出（给高亮用）')
    eq(ED.guessLang('const a = ref(0)'), 'js', 'JS/Vue 认得出')
    // 章节/标题的标点清洗（统计按章节分桶，带噪声会把同一节分成两桶）
    eq(DM.cleanLabel('3.6.2 “重定向'), '3.6.2 重定向', '★ 洗掉 OCR 的引号噪声')
    eq(DM.cleanLabel('3.6.2重定向'), '3.6.2 重定向', '★ 编号和标题之间补一个空格')
    eq(DM.cleanLabel('第3章 Servlet'), '第3章 Servlet', '正常的不动')
    eq(DM.cleanLabel('  3.5.2 “设置响应体  '), '3.5.2 设置响应体', '首尾空白一起去掉')
    eq(DM.cleanLabel(''), '', '空输入不炸')
  }

  // ── 拖拽排序（Parsons）：判据是"教材原文的顺序" ─────────────────────────
  {
    const snippet = [
      'PrintWriter pw = resp.getWriter();',
      'resp.setContentType("text/html;charset=utf-8");',
      'pw.println("<p>hello</p>");',
      'pw.close();',
    ].join('\n')

    eq(PS.splitStatements(snippet).length, 4, '按语句切成 4 块')
    eq(
      PS.splitStatements('String s = "a;b"; // 分号在字符串和注释里\nint n = 1;').length,
      2,
      '★ 不切进字符串/注释里的分号（切错了这道题就没法做）',
    )
    eq(
      PS.splitStatements('if (a) {\n  b();\n}\nc();').length,
      2,
      '★ 括号里的换行不算语句边界（if 块是一整块）',
    )
    eq(
      PS.splitStatements('// 顶部注释\nint a = 1;\nint b = 2;').length,
      2,
      '只有注释的行并进下一块（孤立注释没法排序）',
    )
    eq(PS.toUnits('a();\nb();\nc();').length, 3, '语句够用时不退回按行切')
    eq(PS.toUnits('{ a();\n  b();\n  c(); }').length, 3, '★ 整段包在一个大括号里 → 退回按行切（否则只有 1 块）')

    const task = PS.buildParsonsTask(snippet)
    ok(task !== null, '能造出一道排序题')
    eq(task.answer.length, 4, '答案覆盖每一块')
    eq(new Set(task.answer).size, 4, '答案是这些块的一个**排列**（不重不漏）')
    eq(new Set(task.blocks.map((b) => b.key)).size, 4, '块 key 不重复')
    ok(
      task.answer.some((k, i) => task.blocks[i].key !== k),
      '★ 打乱过了（题目不能一上来就是对的）',
    )
    eq(
      PS.buildParsonsTask(snippet).answer.join(','),
      task.answer.join(','),
      '★ 同样的代码 → 同样的打乱（可复现，题面稳定）',
    )
    eq(
      task.blocks.map((b) => b.text).sort().join('|'),
      PS.splitStatements(snippet).sort().join('|'),
      '块的内容 = 原文的语句（一个字都不改）',
    )
    eq(PS.buildParsonsTask('a();'), null, '块太少不出题（两三块才值得排）')
    eq(PS.buildParsonsTask('x();\nx();\nx();'), null, '块全一样不出题（排了也没意义）')

    // 判分：全对 / 顺序错 / 部分对（LCS 给部分分）
    eq(PS.judgeParsons(task.answer, task.answer).ok, true, '排对了 → 过')
    eq(PS.judgeParsons([...task.answer].reverse(), task.answer).ok, false, '完全倒过来 → 不过')
    const partial = PS.judgeParsons(
      [task.answer[1], task.answer[0], task.answer[2], task.answer[3]],
      task.answer,
    )
    eq(partial.ok, false, '换了两块 → 不过')
    // ⚠️ 期望值是 3 不是 2：只交换**相邻**两块时，最长公共子序列是 3（[a1,a2,a3] 或 [a0,a2,a3]）——
    //    LCS 部分分就是这么算的（PrairieLearn 的 pl-order-blocks 同一个模型）。
    //    第一版我按"错了几块"去猜 2，猜错了 —— 断言要按算法定义写，不能凭感觉。
    eq(partial.correct, 3, '★ 部分分：LCS = 3（交换相邻两块时不是 2）')
    eq(partial.total, 4, '总分 = 块数')
    eq(partial.posOk.filter(Boolean).length, 2, '逐位置对错给出来了（前两块位置错，界面要标红）')
    eq(PS.judgeParsons([], task.answer).ok, false, '没作答 → 不过')

    // ★ 归一化必须吃得下（否则题库里的排序题会被静默丢掉）
    const nb = normalizeBank(
      {
        meta: { title: 't' },
        questions: [
          { id: 'p1', type: 'code', mode: 'order', stem: '把顺序排回去', code: snippet, blocks: task.blocks, answer: task.answer },
        ],
      },
      't',
    )
    eq(nb.questions.length, 1, '★ 排序题通过了归一化')
    eq(nb.questions[0].mode, 'order', 'mode 保住了')
    eq(nb.questions[0].blocks.length, 4, '块带过来了')
    eq(nb.questions[0].answer.join(','), task.answer.join(','), '答案顺序没被改（不能走字母那套归一化）')
    eq(
      CD.runBlockReason(nb.questions[0]),
      '排序题不用运行（把每一块拖回原来的位置就是答案）',
      '排序题不显示「运行」，给的理由说得清',
    )
    // ⚠️ 作答形态 = **平铺的 key 数组**（store 的 submitCode 会对它 `.map(String)`；
    //    嵌一层 `[keys]` 会被 stringify 成一整条字符串，判定永远不过 —— 真机踩过）
    eq(CD.judgeCode(nb.questions[0], task.answer).ok, true, '★ 走 judgeCode 判分也对（判定只有一份实现）')
    eq(
      CD.judgeCode(nb.questions[0], [task.answer]).ok,
      false,
      '★ 多嵌一层数组就判不过（这正是 store 传参的形态，别再嵌了）',
    )
    eq(CD.CODE_MODE_LABEL.order, '拖拽排序', '模式有中文名（界面上要显示）')

    // 坏数据要拦：答案少一块 / 答案里有不存在的块。
    // ⚠️ 夹具里要留一道**好题**：全被丢掉时 normalizeBank 会直接抛
    //    「解析出 0 道可用题目」，那就测不到"逐条跳过 + 告警"这件事了。
    const bad = normalizeBank(
      {
        meta: { title: 't' },
        questions: [
          { id: 'ok', type: 'code', mode: 'order', stem: '好题', code: snippet, blocks: task.blocks, answer: task.answer },
          { type: 'code', mode: 'order', stem: 'x', code: snippet, blocks: task.blocks, answer: [task.answer[0]] },
          { type: 'code', mode: 'order', stem: 'y', code: snippet, blocks: task.blocks, answer: ['nope', ...task.answer.slice(1)] },
        ],
      },
      't',
    )
    eq(bad.questions.length, 1, '坏排序题被跳过，好题留下')
    ok(
      bad.issues.join(' ').includes('对不上') && bad.issues.join(' ').includes('不存在'),
      '★ 两种坏法各给了一条告警（说清为什么跳过）',
      bad.issues.join(' | '),
    )
  }
}

/* ═══════════ R. 浏览器 OCR 的模型与缓存（防"换模型变成假动作"） ═══════════ */
console.log('\n═══ R. 浏览器 OCR：模型选型与缓存版本 ═══')
{
  const OCR_JS = path.join(HERE, '..', 'src', 'core', 'ocr.js')
  const src = fs.readFileSync(OCR_JS, 'utf8')
  const chi = path.join(HERE, '..', 'public', 'ocr', 'chi_sim.traineddata.gz')
  const chiMB = fs.existsSync(chi) ? fs.statSync(chi).size / 1024 / 1024 : 0

  // ① 中文模型必须是**全量**那一份。实测（分开缓存，四种组合都量过）：
  //    best_int 91% 关键串 / 预习页出 1 道自测题；4.0.0 100% / 12 道。
  //    这条断言挡的是"哪天有人又按体积把它换回小的"。
  ok(chiMB >= 8, `★ public/ocr 里的中文模型是全量那份（${chiMB.toFixed(1)}MB ≥ 8MB）`, `${chiMB.toFixed(1)}MB`)

  // ② 缓存键 = `${cachePath}/${lang}.traineddata`，**只认语言名**。
  //    只换 public/ocr 里的文件而不改缓存版本号，老用户会一直用缓存里的旧模型 ——
  //    2026-10-10 真踩过（Node 侧那次是坑 77，这是浏览器端的同一个陷阱）。
  ok(/cachePath:\s*OCR_CACHE_VERSION/.test(src), '★ 传了带版本的 cachePath（否则换模型对老用户不生效）')
  const ver = /const OCR_CACHE_VERSION = '([^']+)'/.exec(src)
  ok(!!ver && ver[1].length >= 8, 'OCR_CACHE_VERSION 有实义版本号', ver ? ver[1] : '（没找到常量）')

  // ③ 别让那条**假测量**的结论再回到注释里（"两套模型输出完全一致 → 发小的"）
  ok(!src.includes('两套模型输出完全一致'), '★ 注释里没有那条已被推翻的结论（共用缓存造成的假测量）')
}

/* ═══════════ S. 代码块主题（自定义配色，站主 2026-10-11 提） ═══════════ */
console.log('\n═══ S. 代码块主题 ═══')
{
  const THEME_CSS = path.join(HERE, '..', 'src', 'styles', 'theme.css')
  const QUIZ_JS = path.join(HERE, '..', 'src', 'stores', 'quiz.js')
  const css = fs.readFileSync(THEME_CSS, 'utf8')
  const quizSrc = fs.readFileSync(QUIZ_JS, 'utf8')

  // ① editor.js 给 token 挂的 class 后缀，和 code-theme.js 的配色键必须是**同一套**。
  //    少一个 → 那个 token 永远没颜色；多一个 → 死配置。这条就是防"只改一处"
  //    （这套配色是"数据在 code-theme、class 名在 editor、颜色在 CSS"三处配合的）。
  eq(
    [...ED.TOKEN_CLASS_KEYS].sort().join(','),
    [...CT.TOKEN_NAMES].sort().join(','),
    '★ editor.js 的 token class 与 code-theme.js 的配色键一一对应',
  )

  // ② 主题表自洽
  const ids = CT.CODE_THEMES.map((t) => t.id)
  eq(new Set(ids).size, ids.length, '主题 id 不重复')
  ok(ids.includes(CT.DEFAULT_CODE_THEME), `默认主题 ${CT.DEFAULT_CODE_THEME} 在表里`)

  // ③ 每个预设主题都要把变量**配齐**（缺一个就是那个 token 没颜色）
  for (const t of CT.CODE_THEMES) {
    if (t.site) continue
    const miss = [
      ...CT.PANEL_VARS.filter((k) => !t.vars || !t.vars[k]),
      ...CT.TOKEN_NAMES.filter((k) => !t.tokens || !t.tokens[k]),
    ]
    ok(!miss.length, `预设主题 ${t.id} 的变量配齐了`, miss.join(','))
  }

  // ④ site 主题**必须一个变量都不覆盖** —— 它就是"改之前的行为"（跟随明暗）。
  //    哪天有人给它补了 vars，明暗切换就被钉死了，而且默认外观悄悄变了。
  const site = CT.getCodeTheme('site')
  ok(
    !site.vars && !site.tokens && Object.keys(CT.themeCssVars('site')).length === 0,
    '★ site 主题不覆盖任何变量（"跟随明暗"仍是老行为）',
  )

  // ⑤ localStorage 里的脏 id（上个版本写的/被手工改坏的）要回退到默认，
  //    而不是让代码块整片没颜色。
  eq(CT.getCodeTheme('nope-not-a-theme').id, CT.DEFAULT_CODE_THEME, '认不出的主题 id 回退到默认')
  eq(Object.keys(CT.themeCssVars('nope-not-a-theme')).length, 0, '认不出的主题不写任何变量')

  // ⑥ 变量名要和 CSS 期望的一致（CSS 读的是 --q-tok-<key>）
  const vars = CT.themeCssVars('dracula')
  const badVar = CT.TOKEN_NAMES.filter((k) => !vars[`--q-tok-${k}`])
  ok(!badVar.length, '预设主题输出 --q-tok-<key> 形式的变量', badVar.join(','))

  // ⑦ CSS 里每个 token class 都要有规则：改了 class 名却忘了改 CSS，表现是"全都没颜色"，
  //    而单看 JS 一切正常 —— 那种最难查，所以在这里拦。
  const missCss = ED.TOKEN_CLASS_KEYS.filter((k) => !new RegExp(`\\.q-tok-${k}\\s*\\{`).test(css))
  ok(!missCss.length, 'theme.css 给每个 token class 都写了规则', missCss.join(','))

  // ⑧ 设置项要真的接上（"存了但没应用" = 改了没反应）
  ok(/codeTheme:/.test(quizSrc), 'DEFAULT_SETTINGS 里有 codeTheme')
  ok(/applyCodeTheme\(\)/.test(quizSrc), 'applyAppearance 会应用代码块主题')
  ok(/key === 'codeTheme'/.test(quizSrc), 'setSetting 改 codeTheme 时立刻重涂')
  ok(/removeProperty/.test(quizSrc), '★ 切回 site 会清掉内联变量（否则明暗切换会失效）')
}

/* ═══════════ T. 演武场 / 校对台的"随手跑一段"（core/snippet.js） ═══════════ */
console.log('\n═══ T. 随手跑一段代码 ═══')
{
  // ① 空的：不能跑，且理由是**给人看的**（不是英文异常名）
  const empty = SN.snippetRunPlan('', {})
  ok(!empty.runnable, '空代码判定为不可运行')
  ok(empty.reason && !/Error|Exception/.test(empty.reason), '空代码的理由是人话', empty.reason)

  // ② JS 片段：原样交给浏览器沙箱
  const js = SN.snippetRunPlan('const a = ref(1)\nconsole.log(a.value)', { lang: 'js' })
  ok(js.runnable && !js.wrapped && js.lang === 'js', 'JS 片段：可跑、不补壳')

  // ③ Java **片段**（没有类壳）：第二十批量过的真事实 —— 扫描件里这种最多，
  //    不补壳就永远编译不过（"class, interface, or enum expected"）。
  const frag = SN.snippetRunPlan('int a = 1;\nSystem.out.println(a);', { lang: 'java' })
  ok(frag.runnable, 'Java 片段判定为可运行')
  ok(frag.wrapped, '★ Java 片段被标成"已补壳"（界面要告诉人补了什么）')
  ok(/public\s+class\s+Main/.test(frag.source), '补出来的类叫 Main（java Main.java 认它）')
  ok(/static\s+void\s+main\s*\(\s*String\[\]\s*args\s*\)/.test(frag.source), '补出来了 main 方法')
  ok(frag.source.includes('System.out.println(a);'), '原始语句还在（没被吃掉）')

  // ④ 已经是完整类的：**不许再套一层壳**（套了必然编译不过）
  const full = SN.snippetRunPlan('public class Foo { public static void main(String[] a) {} }', { lang: 'java' })
  ok(full.runnable && !full.wrapped, '★ 已有类声明的 Java 不再补壳')

  // ⑤ import 必须留在**类外面**：塞进方法体里会报 "illegal start of type"，
  //    那个报错看着完全不像 import 的问题（所以这条要单独钉住）。
  const withImport = SN.snippetRunPlan('import java.util.List;\nList<String> xs = null;\nSystem.out.println(xs);', { lang: 'java' })
  const src = withImport.source
  ok(src.indexOf('import java.util.List;') < src.indexOf('public class Main'), '★ import 被提到类外面了')
  ok(!/main\(String\[\] args\) \{[\s\S]*import java\.util\.List/.test(src), '★ import 没有被塞进 main 方法里')

  // ⑥ JSP 页：不是类，套壳也跑不了 —— 要说清楚为什么（第二十批量出有 2 块是 JSP）
  const jsp = SN.snippetRunPlan('<%@ page language="java" %>\n<% out.print("hi"); %>', { lang: 'java' })
  ok(!jsp.runnable, '★ JSP 页面判定为不可运行（不是"编译失败"，是压根不该编译）')
  ok(/JSP/.test(jsp.reason), 'JSP 的理由里点明了是 JSP', jsp.reason)

  // ⑦ 不给语言时按内容猜（教材代码多为 Java）
  eq(SN.snippetRunPlan('System.out.println("x");', {}).lang, 'java', '不给语言时认出 Java')
  eq(SN.snippetRunPlan('const x = 1', {}).lang, 'js', '不给语言时认出 JS')
}

/* ═══════════ U. 跨页合并（书翻页把一段切开 —— 站主 2026-10-11 提） ═══════════ */
console.log('\n═══ U. 跨页合并 ═══')
{
  // 手搓一个"文档模型"形状的夹具：merge.js 只认 pages[].blocks[] 和 review[]，
  // 不需要真去跑 OCR（真实 9 页样张那条端到端在 docmodel_check.mjs 里）。
  const blk = (id, kind, page, lines, extra = {}) => ({
    id,
    kind,
    page,
    lines: lines.map((t) => ({ text: t })),
    excluded: false,
    ...extra,
  })
  const makeModel = () => ({
    pages: [
      {
        page: 1,
        blocks: [
          blk('b1', 'para', 1, ['上一段正文。']),
          blk('b2', 'code', 1, ['resp.setHeader("Cache-Control",', '"no-cache");'], {
            gutterNumbers: [18, 19, 20],
          }),
        ],
        warnings: [],
      },
      {
        page: 2,
        blocks: [
          blk('b3', 'code', 2, ['resp.addHeader("X", "1");', '}'], { gutterNumbers: [23, 24] }),
          blk('b4', 'para', 2, ['下一段。']),
        ],
        warnings: [],
      },
    ],
    review: [
      { idx: 0, level: 'high', page: 1, blockId: 'b2', message: '上' },
      { idx: 1, level: 'high', page: 2, blockId: 'b3', message: '下' },
    ],
    stats: {
      pages: 2,
      inputLines: 6,
      keptLines: 6,
      droppedLines: 0,
      reconcile: 0,
      blocks: 4,
      codeBlocks: 2,
      codeLines: 4,
      codeMissingLines: 0,
      codeUnreliable: 0,
      lowConfidenceLines: 0,
    },
  })

  const before = makeModel()
  const beforeText = DM.docModelToPages(before).flat().join('\n')
  const { model: merged, merges, dropped } = MG.mergeCrossPage(before)

  eq(merges.length, 1, '行号接得上的两段代码被接回（1 处）')
  eq(dropped.length, 0, '没有误判成重叠去重')

  const code = merged.pages[0].blocks.find((b) => b.id === 'b2')
  eq(code.lines.length, 4, '接回后是一个 4 行的块（两半合一块）')
  eq(code.gutterNumbers.join(','), '18,19,20,23,24', '行号取并集')

  // ★★ 这条是**功能的核心价值**：分开判时两半各自"不缺行"，
  //    "缺了第 21、22 行"这个结论永远出不来（那正是第二十批要拦的东西）。
  eq(code.missingLines.join(','), '21,22', '★ 接回后才算出"缺了第 21、22 行"')
  eq(code.pages.join(','), '1,2', '合并块记得自己横跨第 1、2 页（校对台要显示）')

  ok(
    !merged.pages[1].blocks.some((b) => b.id === 'b3'),
    '下半段不再作为独立块留在第 2 页（避免一道题出两半）',
  )

  // ★★ 高危点：待核对项是按 blockId 挂的。被并掉那块的项必须改挂到留下的块上，
  //    否则校对台渲染不出来 →「继续生成」永远灰着，人怎么点都清不掉。
  const ids = new Set(merged.pages.flatMap((p) => p.blocks).map((b) => b.id))
  const orphans = merged.review.filter((r) => r.blockId && !ids.has(r.blockId))
  eq(orphans.length, 0, '★ 没有孤儿待核对项（否则人会卡在"还有 N 处没核对"）')
  eq(merged.review[1].blockId, 'b2', '被并掉那块的待核对项改挂到留下的块上')

  // ★ 送后端的文字**逐字节不变**（docModelToPages 是按行摊平的）——
  //   这个性质很重要：它保证"跨页合并"不可能改变后端看到了什么。
  eq(DM.docModelToPages(merged).flat().join('\n'), beforeText, '★ 送给后端的文字逐字节不变')

  // 纯函数：不能改调用方那份
  eq(before.pages[0].blocks.length, 2, '原模型没被就地改（块数不变）')
  eq(before.review[1].blockId, 'b3', '原模型的待核对项没被就地改')
  ok(!before.pages[0].blocks.find((b) => b.id === 'b2').pages, '原模型的块没被加上 pages 字段')

  // 对账等式必须继续成立（docmodel 的"进来的行 = 落块 + 丢弃"）
  eq(merged.stats.reconcile, 0, '★ 对账等式仍为 0（合并只挪块、不少行）')

  // ── 判据：**"这段代码写完了没有"说了算**，不是它在哪一页（站主 2026-10-11 的要求）──
  //    ① 上一段括号没闭合 → 必然还得往下写 ⇒ 接上，**哪怕下一页开头带着题注**
  //       （教材里 `文件 3-14 xxx.java` 这种题注常常正好在续页顶部；
  //        原来"有题注就拒绝"正是代码续写在真样张上一次都没触发的原因）
  const contWithCaption = makeModel()
  contWithCaption.pages[0].blocks[1].lines = [{ text: 'public void doGet(HttpServletRequest req,' }]
  contWithCaption.pages[1].blocks[0].caption = '文件 3-14 ResponseServlet02.java'
  eq(MG.mergeCrossPage(contWithCaption).merges.length, 1, '★ 上一段没写完时，下一页带题注也照样接上')

  //    ② 上一段**写完了**、行号又接不上 → 没有题注也不许合（不能"见缝就合"）
  const doneNotAdjacent = makeModel()
  doneNotAdjacent.pages[0].blocks[1].lines = [{ text: 'resp.setHeader("X", "1");' }]
  doneNotAdjacent.pages[0].blocks[1].gutterNumbers = [18, 19, 20]
  doneNotAdjacent.pages[1].blocks[0].gutterNumbers = [90, 91]
  eq(MG.mergeCrossPage(doneNotAdjacent).merges.length, 0, '上一段已写完且行号接不上 → 不合并')

  // ── 反例：行号倒退 = 另一段 ────────────────────────────────────────────
  const back = makeModel()
  back.pages[1].blocks[0].gutterNumbers = [4, 5]
  eq(MG.mergeCrossPage(back).merges.length, 0, '行号倒退时不合并')

  // ── 没行号时退回"这段还没写完"（括号没闭合）────────────────────────────
  const brace = makeModel()
  brace.pages[0].blocks[1].gutterNumbers = []
  brace.pages[1].blocks[0].gutterNumbers = []
  brace.pages[0].blocks[1].lines = [{ text: 'public void doGet() {' }]
  brace.pages[1].blocks[0].lines = [{ text: 'System.out.println(1);' }]
  eq(MG.mergeCrossPage(brace).merges.length, 1, '没行号但括号没闭合 → 判为续写')

  const closed = makeModel()
  closed.pages[0].blocks[1].gutterNumbers = []
  closed.pages[1].blocks[0].gutterNumbers = []
  closed.pages[0].blocks[1].lines = [{ text: 'int a = 1;' }]
  closed.pages[1].blocks[0].lines = [{ text: 'int b = 2;' }]
  eq(MG.mergeCrossPage(closed).merges.length, 0, '没行号且已经写完 → 不合并')

  // ── 正文段：上一段没句末标点、下一段不像新条目 → 接着写 ────────────────
  const para = makeModel()
  para.pages[0].blocks[1] = blk('b2', 'para', 1, ['这一段话说到一半'])
  para.pages[1].blocks[0] = blk('b3', 'para', 2, ['下一页接着说完。'])
  eq(MG.mergeCrossPage(para).merges.length, 1, '正文段跨页续写被接回')

  const paraEnd = makeModel()
  paraEnd.pages[0].blocks[1] = blk('b2', 'para', 1, ['这一段已经说完了。'])
  paraEnd.pages[1].blocks[0] = blk('b3', 'para', 2, ['这是新的一段。'])
  eq(MG.mergeCrossPage(paraEnd).merges.length, 0, '上一段已收尾时不合并')

  // ── ★ 假阳性反例（真实 9 页样张上量出来的）─────────────────────────────
  //    拼坏的页眉 `,=uw Java Web 程序设计任务教程 (第3版 )` 被粘到正文段尾巴上。
  //    真正的跨页续写是从"词中间"断的，不会以逗号/等号开头。
  const junk = makeModel()
  junk.pages[0].blocks[1] = blk('b2', 'para', 1, ['说明通过 HttpServletResponse 对象成功设置响应头信息，同时浏览器'])
  junk.pages[1].blocks[0] = blk('b3', 'para', 2, [',=uw Java Web 程序设计任务教程 (第3版 ) (AIGC 版 )'])
  eq(MG.mergeCrossPage(junk).merges.length, 0, '★ 下一段以标点/等号开头（拼坏的版面行）时不合并')

  //    同一个样张上的**正例**：从词中间断开的，必须照合不误
  const good = makeModel()
  good.pages[0].blocks[1] = blk('b2', 'para', 1, ['…一致的，同时浏览器'])
  good.pages[1].blocks[0] = blk('b3', 'para', 2, ['页面每20s 会自动刷新页面。'])
  eq(MG.mergeCrossPage(good).merges.length, 1, '★ 从词中间断开的跨页续写照合不误')

  // ── 重叠页去重：同一段被扫了两遍 ──────────────────────────────────────
  const dup = makeModel()
  dup.pages[0].blocks[1] = blk('b2', 'code', 1, ['int a = 1;', 'int b = 2;'])
  dup.pages[1].blocks[0] = blk('b3', 'code', 2, ['int a = 1;', 'int b = 2;'])
  const dupOut = MG.mergeCrossPage(dup)
  eq(dupOut.dropped.length, 1, '重叠扫重的块被去掉')
  eq(dupOut.model.pages[1].blocks.some((b) => b.id === 'b3'), false, '重复的那份不再留着')
  // 丢行必须计进 droppedLines，否则 docmodel 的"对账差分必须是 0"会破
  eq(dupOut.model.stats.reconcile, 0, '★ 去重后对账等式仍为 0（丢的行计进了 droppedLines）')
  eq(dupOut.model.stats.droppedDuplicates, 2, '去重丢掉的 2 行记在 stats 上')

  // ── 排除掉的块不参与合并（人工判过"不用于出题"的东西别再动它）──────────
  const excl = makeModel()
  excl.pages[1].blocks[0].excluded = true
  eq(MG.mergeCrossPage(excl).merges.length, 0, '被排除的块不参与合并')

  // ── ★★ 块号在**每页各编一套**（docmodel 的 `b${index+1}`）──────────────────
  //    这是拿真实 9 页样张量出来的：第 7 页的第一块也叫 `b1`，和第 3 页的 `b1` 撞名。
  //    改挂待核对项如果只按块号，会把**别页**同号的项也一起改到错的块上；
  //    而校对台的匹配键是 `r.page === block.page && r.blockId === block.id`，
  //    配不上就渲染不出来 →「继续生成」永远灰着。合成夹具里块号恰好全局唯一，照不出来。
  const collide = {
    pages: [
      {
        page: 1,
        blocks: [
          blk('b1', 'para', 1, ['第一页正文。']),
          blk('b6', 'code', 1, ['int a = 1;'], { gutterNumbers: [18, 19, 20] }),
        ],
        warnings: [{ blockId: 'b6', level: 'warn', message: 'w6' }],
      },
      {
        page: 2,
        blocks: [
          blk('b1', 'code', 2, ['int b = 2;'], { gutterNumbers: [23, 24] }),
          blk('b2', 'para', 2, ['第二页正文。']),
        ],
        warnings: [{ blockId: 'b1', level: 'warn', message: 'w1' }],
      },
      { page: 3, blocks: [blk('b1', 'para', 3, ['第三页正文，块号也叫 b1。'])], warnings: [] },
    ],
    review: [
      { idx: 0, level: 'high', page: 1, blockId: 'b6', message: '一' },
      { idx: 1, level: 'high', page: 2, blockId: 'b1', message: '二（该跟着块走）' },
      { idx: 2, level: 'high', page: 3, blockId: 'b1', message: '三（别动它）' },
    ],
    stats: { pages: 3, inputLines: 5, keptLines: 5, droppedLines: 0, reconcile: 0, blocks: 5 },
  }
  const col = MG.mergeCrossPage(collide).model
  eq(col.review[1].page, 1, '★ 被并掉那页的待核对项改挂到**起始页**（页号也要改）')
  eq(col.review[1].blockId, 'b6', '★ 改挂到留下的那个块号（而不是被并掉的 b1）')
  eq(col.review[2].page, 3, '★ 第 3 页同号（b1）的待核对项**没被动**——它跟这次合并无关')
  eq(col.review[2].blockId, 'b1', '★ 第 3 页同号项的块号保持原样')
  // 兜底不变量：每一项都要能落到某个块上（(页,块号) 唯一）
  const keyOf = (page, id) => `${page}|${id}`
  const blockKeys = new Set(col.pages.flatMap((p) => p.blocks.map((b) => keyOf(p.page, b.id))))
  const stillOrphan = col.review.filter((r) => !blockKeys.has(keyOf(r.page, r.blockId)))
  eq(stillOrphan.length, 0, '★ 块号撞名的真实情形下也没有孤儿待核对项')
}

/* ═══════════ V. 给人看的错误信息（core/text.js 的 readableError） ═══════════ */
console.log('\n═══ V. 错误信息不说黑话 ═══')
{
  // 审计把界面上那段原话逐字抄下来了：
  // 「出题那一步没成功（找不到解析规则模块：C:\Users\alice\PycharmProjects\shared\quiz-tools\pdf_to_json.py（部署时要用 ），…」
  const raw =
    '找不到解析规则模块：C:\\Users\\alice\\PycharmProjects\\shared\\quiz-tools\\pdf_to_json.py（部署时要用那个文件）'
  const out = T.readableError(raw)
  ok(!/[A-Za-z]:\\/.test(out), '★ 服务器绝对路径不露给学生', out)
  ok(!out.includes('alice'), '★ 路径里的用户名也不露', out)
  ok(out.includes('pdf_to_json.py'), '文件名留着（不然没法排查）', out)
  ok(!/[（(][^）)]*$/.test(out), '★ 不会截断在括号里（别留悬空的"（部署时要用"）', out)
  eq(T.readableError('后端超时了。请稍后再试'), '后端超时了。', '有句界就收在句界')
  eq(T.readableError(''), '原因未知', '空错误有兜底')
  ok(T.readableError('x'.repeat(200)).length <= 61, '超长会截断（max + 省略号）', T.readableError('x'.repeat(200)).length)
  // POSIX 路径同样要治 —— 抹掉以防暴露服务器用户名/路径
  ok(
    !T.readableError('找不到 /srv/quiz/shared/quiz-tools/pdf_to_json.py').includes('/srv/quiz'),
    '★ POSIX 绝对路径也抹掉',
  )
}

/* ═══════ W. 按弱项出任务：材料怎么拼 / 最弱标签怎么挑（core/task.js） ═══════ */
console.log('\n═══ W. 任务回路的左半段（core/task.js） ═══')
{
  // 一份最小的预习页（形状照抄 core/lesson.js 的 buildLesson 产物）
  const lesson = {
    title: '第3章 Servlet 基础',
    book: 'JavaWeb 程序设计',
    outline: [
      { level: 1, title: '3.1 Servlet 简介', page: 5 },
      { level: 2, title: '3.2 响应对象', page: 12 },
    ],
    terms: [
      { term: 'Servlet', quote: 'Servlet 是运行在服务器端的 Java 程序。', page: 5 },
      { term: 'doGet', quote: 'doGet 方法用来处理浏览器的 GET 请求。', page: 6 },
    ],
    listings: [
      {
        id: 'b9',
        caption: '文件3-14 ResponseServlet02.java',
        section: '3.2',
        page: 12,
        code: 'public class A {\n  public static void main(String[] a) {}\n}',
      },
    ],
    selfCheck: [{ stem: 'Servlet 跑在哪？', answer: '服务器', verify: '运行在服务器端的 Java 程序' }],
  }
  const material = TK.lessonMaterial(lesson)

  ok(
    material.includes('Servlet 是运行在服务器端的 Java 程序。'),
    '★ 术语的教材原话原样进了材料（后端要拿它做逐字命中）',
    material.slice(0, 80),
  )
  ok(material.includes('[p6] doGet：doGet 方法用来处理浏览器的 GET 请求。'), '第二条术语也带页码进材料')
  ok(material.includes('public class A {'), '代码清单原样进了材料（不许改写）')
  ok(material.includes('【骨架】') && material.includes('【教材原文（术语与定义）】'), '材料分了节，模型知道哪段是原文')
  eq(TK.lessonMaterial(null), '', '没有预习页时给空串（调用方好判）')

  const huge = {
    title: 'T',
    terms: Array.from({ length: 400 }, (_, i) => ({ term: `t${i}`, quote: '长'.repeat(80), page: i + 1 })),
  }
  const cut = TK.lessonMaterial(huge)
  ok(cut.length <= TK.TASK_MATERIAL_MAX, '★ 材料超长会截断（后端上限 20000，不能把整本书发上去）', String(cut.length))
  ok(cut.includes('已截断'), '截断要留痕，别让人以为材料就这么多')

  /* 挑最弱标签 —— 复用 tagStats（报告页同一条判据） */
  const questions = [
    { id: 'q1', tags: ['数组遍历'] },
    { id: 'q2', tags: ['数组遍历'] },
    { id: 'q3', tags: ['数组遍历'] },
    { id: 'q4', tags: ['循环嵌套'] },
    { id: 'q5', tags: ['循环嵌套'] },
    { id: 'q6', tags: ['循环嵌套'] },
    { id: 'q7', tags: ['异常处理'] },
    { id: 'q8', tags: ['异常处理'] },
    { id: 'q9', tags: ['异常处理'] },
    { id: 'q10', tags: ['只做了一次'] },
  ]
  const history = [
    { q: 'q1', ok: 0 }, { q: 'q2', ok: 0 }, { q: 'q3', ok: 1 }, // 数组遍历 1/3
    { q: 'q4', ok: 1 }, { q: 'q5', ok: 0 }, { q: 'q6', ok: 0 }, // 循环嵌套 1/3
    { q: 'q7', ok: 1 }, { q: 'q8', ok: 1 }, { q: 'q9', ok: 1 }, // 异常处理 3/3
    { q: 'q10', ok: 0 }, // 只做了一次 → 不算弱项
  ]
  const weak = TK.weakTags(history, questions)
  eq(weak.length, 2, '★ 做够 3 次才算弱项（做 1 错 1 不算 —— 和报告页一致）')
  eq(weak[0].tag, '数组遍历', '正确率最低的排第一')
  eq(weak[0].wrong, 2, '错几次 = 做了几次 - 对了几次')
  eq(weak[0].total, 3, '一共做了几次')
  ok(!weak.some((w) => w.tag === '异常处理'), '★ 一次没错过的标签不算弱项（卡片上说的是"你做错的 X"）')
  eq(TK.weakTags([], questions).length, 0, '没有作答记录时给空数组（卡片要说"数据还不够"）')
  eq(TK.weakTags(history, questions, { limit: 1 }).length, 1, 'limit 能只取最弱的那个')
  // 弱项顺序必须和报告页**一模一样**（同一份 tagStats）：不然两页会各说各的
  const fromReport = A.tagStats(history, questions, { minAttempts: 3 })
  eq(
    weak.map((w) => w.tag).join(','),
    fromReport.filter((r) => r.n > r.ok).slice(0, 3).map((r) => r.name).join(','),
    '和报告页挑出来的是同一批、同一个顺序（只是滤掉了没错过的）',
  )

  eq(TK.weakSummary(weak), '数组遍历、循环嵌套', '卡片上那句"会用到你最近做错的 X"')
  eq(TK.weakSummary([]), '', '没有弱项时给空串（调用方换成"数据还不够"那句）')
  ok(TK.TASK_NO_WEAK_NOTE.includes('还没有足够的数据'), '没有弱项时要明说，别硬编一个弱项')

  /* 默认语言：按预习页里的代码猜，只当默认值 */
  eq(TK.guessTaskLang(lesson), 'java', 'Java 代码 → 默认 Java')
  eq(TK.guessTaskLang({ listings: [{ code: 'const a = 1\nconsole.log(a)' }] }), 'js', 'JS 代码 → 默认 JS')
  eq(TK.guessTaskLang({ listings: [] }), 'java', '没有代码清单时按 Java（这套教材是 JavaWeb）')

  /* 取材范围那个开关（站主：「如果只照着书本，信息量不足以出题，所以放宽吧」） */
  eq(TK.DEFAULT_TASK_SCOPE, 'open', '★ 默认是「允许补充」（站主说的放宽吧）')
  eq(TK.TASK_SCOPES.map((s) => s.value).join(','), 'open,book', '两档：允许补充 / 只照书本')
  eq(TK.taskScopeLabel('book'), '只照书本', '卡片上的中文名')
  eq(TK.taskScopeLabel('open'), '允许补充', '卡片上的中文名')
  eq(TK.taskScopeLabel('乱七八糟'), '允许补充', '认不出的值按默认档显示（和后端退回默认一致）')
  ok(
    TK.TASK_SCOPES.every((s) => s.label && s.hint && s.hint.length > 8),
    '★ 两档都要有给人看的说明（开关要看得懂才有意义）',
  )

  /* ★ 没有引文时卡片上要说的那句话：**两档各说各的**，而且都不许留一个空引文位 */
  const noteOpen = TK.taskNoQuoteNote('open')
  const noteBook = TK.taskNoQuoteNote('book')
  ok(noteOpen.includes('没有引文'), '★ 敞开档明说「这次没有引文」（不许留白让人以为有教材依据）', noteOpen)
  ok(noteOpen.includes('允许补充'), '敞开档要写清是哪一档', noteOpen)
  ok(noteOpen.includes('教材外'), '★ 敞开档说清"允许讲教材外的知识，但不冒充课本里的话"', noteOpen)
  ok(noteBook.includes('没有引文') && noteBook.includes('只照书本'), '★ 严格档也明说没有引文、并写清是哪一档', noteBook)
  ok(noteBook.includes('材料里没找到'), '★ 严格档的引文本来该有 —— 要说清是"材料里挑不出可核对的句子"', noteBook)
  ok(noteOpen !== noteBook, '★ 两档的空引文说明必须不一样（两档是两档，别做成同一档）')
  ok(
    !noteOpen.includes('教材原话') && !noteBook.includes('教材原话'),
    '★ 这两句里不许出现「教材原话」四个字 —— 那是引文那行的说法，出现就等于变相的空引文位',
  )
  ok(
    !noteOpen.includes('「」') && !noteBook.includes('「」'),
    '空引文说明里不许出现空的引号对（那就是个空引文位）',
  )
  eq(TK.taskNoQuoteNote('乱七八糟'), noteOpen, '认不出的档按默认档说')

  /* AI 批改要对着**这个任务**评：goal + 完成判据一起递进去 */
  const task = {
    goal: '写一个 Servlet：访问时打印一句话',
    done: ['运行后输出里能看到那行文字', '改掉那句文字再跑还是能出结果'],
  }
  const reviewGoal = TK.taskReviewGoal(task)
  ok(reviewGoal.includes('写一个 Servlet'), 'goal 拼进去了', reviewGoal)
  ok(reviewGoal.includes('1) 运行后输出里能看到那行文字'), '★ 完成判据也拼进去了（否则 AI 只能泛泛评代码）', reviewGoal)
  ok(!reviewGoal.includes('\n'), '★ 拼成一行（单行 input 会把换行吃掉，那样框里和发上去的就不是同一句了）')
  ok(reviewGoal.length <= TK.TASK_REVIEW_GOAL_MAX, '不超过后端 300 字的上限', String(reviewGoal.length))
  const longGoal = TK.taskReviewGoal({ goal: '做'.repeat(400), done: ['够长'] })
  eq(longGoal.length, TK.TASK_REVIEW_GOAL_MAX, '超长会夹到上限而不是被后端 400')
  eq(TK.taskReviewGoal({}), '', '没有任务时给空串')
}

/* ═══════════ X. 账号同步的状态形状（core/state.js，2026-10-12） ═══════════ */
console.log('\n═══ X. 账号同步：一份进度怎么取出来、又怎么放回去 ═══')
{
  /**
   * ★ 这一段的判据不是"函数能跑"，而是**形状和后端一字不差**。
   *   两边形状一旦飘了，症状是"登录同步之后错题本/笔记变空"——
   *   那种 bug 只在真机上出现、且看起来像"数据没了"，所以在这里钉死字段名。
   *   对照物：renwu/backend/apps/quizgen/qstate.py 的 normalize_state / merge_state。
   */
  const store = {
    bankId: 'maogai',
    answers: { 1: { p: ['A'], ok: true, ts: 100 } },
    wrong: { 2: 1 },
    fav: { 3: 1 },
    favAt: { 3: 50 },
    notesRemoved: { 4: 60 },
    clearedAt: { answers: 0, wrong: 0, fav: 0, history: 7, diagram: 0 },
    diagramAt: 88,
    progressUpdatedAt: 999,
    history: [{ q: '1', ok: 1, t: 100, ms: 3000 }],
    notes: { 1: { text: '老师说这题考', ts: 10, updatedAt: 20 } },
    overrides: { 1: { analysis: '改过' } },
    analyses: { 1: 'AI 补的' },
    diagram: { nodes: [{ id: 'n1', text: '一个概念' }], edges: [] },
  }
  const snap = ST.collectState(store)

  eq(
    Object.keys(snap).sort().join(','),
    'analyses,clearedAt,diagnose,diagram,diagramAt,history,notes,overrides,progress,v',
    '★ 顶层字段就是这几个（和后端 normalize_state 对齐）',
  )
  eq(
    Object.keys(snap.progress).sort().join(','),
    'answers,fav,favAt,notesRemoved,updatedAt,wrong',
    '★ progress 里的字段（少一个就会"同步时静默丢掉那一类"）',
  )
  eq(
    Object.keys(snap.clearedAt).sort().join(','),
    'answers,diagram,fav,history,wrong',
    '★ 清空时间戳的桶（和后端 qstate.BUCKETS 一致）',
  )
  eq(snap.v, 1, '带版本号（将来改结构时前端要能迁移）')

  // 最容易丢的那一类：笔记是**对象**不是字符串
  eq(typeof snap.notes['1'], 'object', '★ 笔记保持对象形状（按字符串归一化会把笔记全丢光）')
  eq(snap.notes['1'].text, '老师说这题考', '笔记正文在')
  eq(snap.notes['1'].updatedAt, 20, '笔记的更新时间也在（合并靠它判先后）')
  eq(snap.progress.favAt['3'], 50, '收藏时间在')
  eq(snap.progress.notesRemoved['4'], 60, '笔记墓碑在')
  eq(snap.clearedAt.history, 7, '清空时间戳在')
  eq(snap.diagramAt, 88, '画布改动时间在')

  // 脏数据：形状不对的东西不许把页面搞崩
  const dirty = ST.normalizeState({
    progress: { answers: [1, 2], fav: { a: 0, b: 1 }, favAt: 'x' },
    history: [{ q: '1', t: 0 }, { q: '2', t: 5, ok: 1 }, 'nope'],
    notes: { 1: '裸字符串也要收下', 2: { text: '' }, 3: { text: '正经笔记' } },
    diagram: 'nope',
    clearedAt: 'nope',
  })
  eq(Object.keys(dirty.progress.answers).length, 0, 'answers 是数组 ⇒ 丢掉而不是抛异常')
  eq(Object.keys(dirty.progress.fav).join(','), 'b', 'fav 里的 0 当没有')
  eq(dirty.history.length, 1, '没题号/没时间的历史条目丢掉')
  eq(dirty.notes['1'].text, '裸字符串也要收下', '裸字符串笔记收下（老数据不能丢）')
  eq(dirty.notes['3'].text, '正经笔记', '正经笔记留着')
  eq(dirty.notes['2'], undefined, '空笔记丢掉')
  eq(dirty.clearedAt.history, 0, 'clearedAt 脏数据 ⇒ 全 0（退化成纯并集）')

  // 空判断：元数据不算"有东西"
  ok(ST.stateIsEmpty(ST.normalizeState({})), '空对象 = 空进度')
  ok(ST.stateIsEmpty(snap) === false, '有作答就不是空的')
  ok(
    ST.stateIsEmpty(
      ST.normalizeState({ clearedAt: { answers: 1 }, diagramAt: 2, progress: { favAt: { 1: 3 } } }),
    ),
    '★ 只有元数据（清空时间/墓碑）也算空 —— 新设备别把空进度推上去覆盖账号那份',
  )

  // 放回去：内存 + localStorage 两处都要
  const target = { bankId: 'maogai', diagram: { nodes: [], edges: [] } }
  ST.applyState(target, snap)
  eq(target.answers['1'].ts, 100, '作答放回来了')
  eq(target.notes['1'].text, '老师说这题考', '笔记放回来了')
  eq(target.diagram.nodes[0].id, 'n1', '画布放回来了（并归一化过）')
  eq(target.clearedAt.history, 7, '清空时间戳也放回来（否则下次合并会复活旧数据）')
  eq(ST.collectState(target).progress.notesRemoved['4'], 60, '墓碑放回来')
  const again = ST.collectState(target)
  eq(again.progress.answers['1'].ok, true, '一来一回没变样')
  eq(again.history.length, 1, '历史也还在')

  // 冲突提示：必须说人话，且不许悄悄吞掉
  ok(ST.conflictNote({ notes: 2, fav: 0, diagram: 0 }).includes('2 条笔记'), '冲突提示点了条数')
  ok(ST.conflictNote({ notes: 0, fav: 0, diagram: 1 }).includes('图笔记'), '图的冲突也说')
  ok(ST.conflictNote({ notes: 0, fav: 0, diagram: 0 }) === '', '没冲突就不出声')
  ok(!ST.conflictNote({ notes: 1 }).includes('undefined'), '别把 undefined 显示给人看')

  // 体积：一套 224 题的进度是几十 KB 的量级（服务端上限 2MB）
  ok(ST.stateSize(snap) < 4096, '这一份很小', String(ST.stateSize(snap)))
  const big = { ...store, history: Array.from({ length: 2000 }, (_, i) => ({ q: String(i), ok: 1, t: i + 1, ms: 0 })) }
  ok(ST.stateSize(big) > 20000, '两千条历史就上几十 KB（所以服务端要有上限）')

  /* ---------- 账号规则：前后端必须一致（这里钉住前端那一半） ---------- */
  // ⚠️ 这一条是真踩出来的：`/^[\w.@+-]{2,30}$/u` 里的 `\w` 在 JS 里是 **ASCII only**，
  //    于是「学生abc12」被前端判成非法（而后端 Python 的 \w 接受它）——
  //    表现是"注册页死活提交不了"，且错误信息还理直气壮。必须用 \p{L}\p{N}。
  ok(AU.validateUsername('学生abc12') === '', '★ 中文用户名能过前端校验（\\w 是 ASCII only 的坑）')
  ok(AU.validateUsername('小明') === '', '纯中文也行')
  ok(AU.validateUsername('stu_01-x@y.z') === '', '字母数字和 _ . @ + - 都行')
  ok(AU.validateUsername('有 空格') !== '', '空格要拒')
  ok(AU.validateUsername('a') !== '', '太短要拒')
  ok(AU.validateUsername('x'.repeat(31)) !== '', '太长要拒')
  ok(AU.validateUsername('') !== '', '空的要拒')
  ok(AU.validateUsername('带/斜杠') !== '', '路径符要拒')

  ok(AU.validatePassword('Quiz-Stu-2026!') === '', '够长的密码能过')
  ok(AU.validatePassword('12345678') !== '', '全数字要拒（和后端 NumericPasswordValidator 对齐）')
  ok(AU.validatePassword('short') !== '', '太短要拒')
  ok(AU.validatePassword('') !== '', '空的要拒')
  ok(AU.validateNickname('阿米') === '', '正常昵称能过')
  ok(AU.validateNickname('长'.repeat(25)) !== '', '昵称超长要拒')
  eq(AU.auth.user, null, '冷启动时是"没登录"（loadMe 还没跑）')
  eq(AU.isLoggedIn(), false, '没登录时 isLoggedIn 为 false')

  /* ---------- store 那一半：清空/删除动作必须留时间戳 ---------- */
  // 后端合并是**并集**，"清空了又回来"就发生在这里：动作不留时间戳 ⇒ 服务端那份把本机覆盖回去。
  setActivePinia(createPinia())
  const qs = useQuizStore()
  qs.init('maogai')
  eq(qs.clearedAt.wrong, 0, '初始没有任何清空时间戳')

  qs.wrong = { 1: 1 }
  qs.clearWrong()
  ok(qs.clearedAt.wrong > 0, '★ 清空错题本留了时间戳（不然登录后又被账号里那份带回来）')

  qs.toggleFav('5')
  eq(qs.fav['5'], 1, '收藏上了')
  ok(qs.favAt['5'] > 0, '★ 收藏动作也记时间（否则"取消收藏"没法同步）')
  qs.toggleFav('5')
  eq('5' in qs.fav, false, '再点一次取消收藏')
  ok(qs.favAt['5'] > 0, '取消之后时间戳仍在（它是"最后一次动过"的时间）')

  qs.setNote('7', '写点什么')
  eq(qs.notes['7'].text, '写点什么', '笔记写上了（形状是对象，不是字符串）')
  eq('7' in qs.notesRemoved, false, '写笔记时不带墓碑')
  qs.removeNote('7')
  ok(qs.notesRemoved['7'] > 0, '★ 删笔记按题号留墓碑（删单条不能用"清空阈值"，那会连累别的笔记）')
  qs.setNote('7', '又写回来了')
  eq('7' in qs.notesRemoved, false, '★ 重新写同一条会撤掉墓碑（不然自己把自己挡了）')

  qs.setDiagram({ nodes: [{ id: 'n1', text: '一个概念' }], edges: [] })
  ok(qs.diagramAt > 0, '画布改动会记时间')
  qs.clearDiagram()
  ok(qs.clearedAt.diagram > 0, '★ 清空画布留了时间戳（不然账号里那张旧图会回来）')
  eq(qs.diagram.nodes.length, 0, '画布确实空了')

  qs.answers = { 1: { p: ['A'], ok: true, ts: 1 } }
  qs.resetProgress()
  ok(
    qs.clearedAt.answers > 0 && qs.clearedAt.wrong > 0 && qs.clearedAt.fav > 0,
    '★ 重置进度三类都留时间戳',
  )
  eq(Object.keys(qs.answers).length, 0, '作答清空了')
  eq(qs.snapshotState().v, 1, 'snapshotState() 能整块取出来（同步用的就是它）')
  eq(qs.snapshotState().clearedAt.answers > 0, true, '快照里带着清空时间戳（它在顶层，和后端 qstate 一致）')
}

/* ═══════════════════════════ 汇总 ═══════════════════════════ */
console.log('\n' + '═'.repeat(52))
if (failed) {
  console.log(`❌ 验收失败：${pass} 通过 / ${failed} 失败`)
  process.exit(1)
}
console.log(`✅ 全部通过：${pass} 项断言`)
