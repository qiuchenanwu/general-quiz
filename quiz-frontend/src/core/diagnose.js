/**
 * diagnose.js —— **诊断先行**：先花 10 分钟摸清底细，再决定这章该怎么学。
 * ============================================================================
 * 由来（HANDOVER 待办第 2 条，也是用户自己提的那句
 * 「预习过和没预习不是一个量级」）：
 *
 *   原来的流程对所有人都一样：从第 1 题顺序刷。可"预习过的人"和"完全没接触过的人"
 *   需要的东西根本不同 —— 前者该做的是**找错、手写、把话说清楚**，
 *   后者该做的是**先看原文、先跑最小示例**。刷题站过去只有一个档位，
 *   于是预习过的人在做他早就会的题，没预习的人在硬猜。
 *
 * 这一层只做三件事，而且全是纯函数（能离线断言）：
 *   1. `pickDiagnostic`  抽一组**又快又能分辨**的题（10 道左右，铺开覆盖各知识点）
 *   2. `routeFor`        按正确率把学习者分流到三条路之一（80 / 50 两条线）
 *   3. `planFor`         给出这条路**具体做什么**（先读哪一节、做哪类题、写什么）
 *
 * 判定标准是刻意的"粗"：诊断的目的是**分流**，不是打分 ——
 * 所以宁可 10 道题、两条线，也不要 50 道题、五个档位（那样没人愿意做第二遍）。
 */

/** 分流线：≥80 直接进"找错 + 手写"；<50 先"原文 + 可跑示例" */
export const ROUTE_LINES = { advanced: 80, remedial: 50 }

import { isCorrect } from './normalize.js'
import { judgeCode } from './code.js'

/**
 * 判一道诊断题对不对。
 *
 * 诊断**不走 store 的答题流程**（那一套会写进度、进错题本、放音效）——
 * 这里只是"测一测你现在在哪"，不该污染学习记录。所以判定要在这儿再来一次：
 * 选择题比字母、代码题交给 core/code.js（和练习页同一份判据，不会两套标准）。
 */
export function judgeOne(q, picked) {
  if (q?.type === 'code') return judgeCode(q, picked).ok
  return isCorrect(picked, q?.answer || [])
}

/** 诊断题量默认 10 道（10 分钟量级），最少 4 道才有分辨力 */
export const DIAGNOSE_COUNT = 10
export const DIAGNOSE_MIN = 4

/* ------------------------------------------------------------ 抽题 --- */

/**
 * 抽一组诊断题。
 *
 * 抽题的三条规矩（都是"诊断"这个用途决定的，不是随便凑够数量）：
 *   1. **铺开覆盖**：按 tag 轮流取，别让 10 道题全落在同一个知识点上；
 *   2. **快**：只收选择题、判断题和**填空**（找错行/修好它要动手，属于"学"不属于"测"，
 *      留到分流之后再用）；
 *   3. **可复现**：同样的题库 + 同样的 chapter 抽出来的题是同一批
 *      （种子固定）—— 不然两次诊断的分数没法比。
 *
 * @param {object} o
 * @param {Array} o.questions    归一化后的题
 * @param {string} [o.chapter]   只诊断这一章（空 = 整本题库）
 * @param {number} [o.count]
 * @param {number} [o.seed]      固定种子 → 可复现
 * @returns {Array} 抽中的题（顺序 = 作答顺序）
 */
export function pickDiagnostic({ questions, chapter = '', count = DIAGNOSE_COUNT, seed = 20261008 }) {
  const pool = (questions || []).filter((q) => {
    if (chapter && q.chapter !== chapter && q.chapterId !== chapter) return false
    if (q.type === 'multiple') return false // 多选慢，且一处漏选就全错，诊断里不划算
    if (q.type === 'code') return q.mode === 'fill' // 找错/修好它留到分流之后
    return q.type === 'single' || q.type === 'judge'
  })
  if (pool.length <= count) return [...pool]

  // 按"主标签"分组，然后轮流从各组取 —— 这样覆盖面自然就铺开了
  const groups = new Map()
  pool.forEach((q) => {
    const key = (q.tags || [])[0] || q.chapter || '其他'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(q)
  })

  const order = [...groups.keys()].sort() // 稳定顺序，配合固定种子 → 可复现
  const rnd = mulberry32(seed)
  const buckets = order.map((k) => {
    const list = [...groups.get(k)]
    // 组内打乱（种子固定）
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      ;[list[i], list[j]] = [list[j], list[i]]
    }
    return list
  })

  const out = []
  let empty = 0
  while (out.length < count && empty < buckets.length) {
    empty = 0
    for (const bucket of buckets) {
      if (!bucket.length) {
        empty++
        continue
      }
      out.push(bucket.shift())
      if (out.length >= count) break
    }
  }
  return out
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ------------------------------------------------------------ 分流 --- */

/**
 * 按正确率分流。
 * @param {number} accuracy 0~100
 * @returns {{key:string, title:string, desc:string, tone:string}}
 */
export function routeFor(accuracy) {
  const acc = Number.isFinite(Number(accuracy)) ? Number(accuracy) : 0
  if (acc >= ROUTE_LINES.advanced) {
    return {
      key: 'advanced',
      title: '直接上强度',
      desc: '这一章你已经会了 —— 再做一遍顺序练习是浪费时间。去做"找错行 / 修好它"，并把话说清楚。',
      tone: 'ok',
    }
  }
  if (acc >= ROUTE_LINES.remedial) {
    return {
      key: 'standard',
      title: '边做边补',
      desc: '有基础但不稳。按本章顺序练习，每道题都点开「出处」看一眼原文，再点题卡右上角的「问 AI」把错题问明白。',
      tone: 'brand',
    }
  }
  return {
    key: 'remedial',
    title: '先看原文再动手',
    desc: '这一章还没建立起来。先读原文（每题都有出处），把最小示例跑一遍看它到底输出什么，再做填空。',
    tone: 'warn',
  }
}

/* --------------------------------------------------------- 统计 --- */

/**
 * 把诊断的作答结果汇总一下。
 * @param {Array<{ok:boolean, q:object}>} rows
 */
export function summarizeDiagnostic(rows) {
  const list = rows || []
  const total = list.length
  const correct = list.filter((r) => r && r.ok).length
  const accuracy = total ? Math.round((correct / total) * 100) : 0
  const tagAgg = new Map()
  list.forEach((r) => {
    if (!r || !r.q) return
    for (const t of r.q.tags || []) {
      const cur = tagAgg.get(t) || { name: t, total: 0, correct: 0 }
      cur.total += 1
      if (r.ok) cur.correct += 1
      tagAgg.set(t, cur)
    }
  })
  const weakTags = [...tagAgg.values()]
    .filter((t) => t.correct < t.total)
    .sort((a, b) => a.correct / a.total - b.correct / b.total || b.total - a.total)
    .slice(0, 5)
    .map((t) => ({ ...t, accuracy: Math.round((t.correct / t.total) * 100) }))
  return { total, correct, wrong: total - correct, accuracy, weakTags, route: routeFor(accuracy) }
}

/* --------------------------------------------------------- 计划 --- */

/**
 * 这条路具体做什么 —— 返回可以直接渲染的步骤（而不是一段含糊的鼓励）。
 *
 * @param {object} o
 * @param {object} o.summary  summarizeDiagnostic 的结果
 * @param {string} [o.chapterName]
 * @param {Array} [o.questions] 该章的题（用来数"有多少道可跑的示例 / 多少道找错题"）
 */
export function planFor({ summary, chapterName = '', questions = [] }) {
  const route = summary?.route?.key || routeFor(summary?.accuracy || 0).key
  const scope = chapterName ? `「${chapterName}」` : '这套题库'
  const of = (fn) => questions.filter(fn).length
  const hasSource = questions.some((q) => q.source?.url)

  if (route === 'advanced') {
    return {
      key: route,
      steps: [
        {
          label: '做「找错行」',
          detail: `${of((q) => q.type === 'code' && q.mode === 'spot')} 道：改动的那一行会让行为怎么变？`,
          action: 'practice-spot',
        },
        {
          label: '做「修好它」',
          detail: `${of((q) => q.type === 'code' && q.mode === 'fix')} 道：改到跑出来的输出对上文档为止`,
          action: 'practice-fix',
        },
        {
          label: '**手写**一遍',
          detail: `${of((q) => q.type === 'code' && q.mode === 'write')} 道：只给文档的说法和期望输出，代码自己写出来（判据是跑出来的输出）`,
          action: 'practice-write',
        },
        {
          label: '把话说清楚',
          detail: '在图笔记里给这一章画一张概念图，再点题卡右上角的「问 AI」把"我以为我懂"的地方问一遍',
          action: 'diagram',
        },
      ],
    }
  }
  if (route === 'standard') {
    return {
      key: route,
      steps: [
        {
          label: `按顺序过一遍${scope}`,
          detail: `${questions.length} 道：答完先别急着下一题，点开「出处」看一眼原文怎么说的`,
          action: 'practice-seq',
        },
        {
          label: '就着错题问 AI',
          detail: '答错的那道题，就着它继续追问"我这样理解错在哪"（不是只看解析）',
          action: 'coach',
        },
        {
          label: '薄弱点补一遍',
          detail: summary?.weakTags?.length
            ? `最弱的是 ${summary.weakTags.map((t) => t.name).join('、')}`
            : '把答错的题重做一遍',
          action: 'practice-wrong',
        },
      ],
    }
  }
  return {
    key: route,
    steps: [
      {
        label: '先读原文',
        detail: hasSource
          ? '这一章的题都带「出处」，点开读那一节（比看解析有用）'
          : '题库里没有出处链接，先把解析逐条读完再做题',
        action: 'read',
      },
      {
        label: '跑最小示例',
        detail: `${of((q) => q.type === 'code' && q.mode === 'fill')} 道填空题可以按「运行」直接看结果 —— 先看它输出什么，再填`,
        action: 'practice-fill',
      },
      {
        label: '再做一遍诊断',
        detail: '同一章、同一批题：正确率先过 50% 再上强度（题目是固定抽的，可以直接比）',
        action: 'rediagnose',
      },
    ],
  }
}

/**
 * 分流的落点 → 该给练习页什么筛选条件。
 * 这样"高分进找错、低分走填空"就不是一句话，而是**真的换了一套题**。
 *
 * @returns {{filters:object, label:string}}
 */
export function sessionFiltersFor(route, { chapter = '' } = {}) {
  const base = { types: [], tags: [], chapter, codeModes: [] }
  if (route === 'advanced') {
    return {
      filters: { ...base, types: ['code'], codeModes: ['spot', 'fix', 'write'] },
      label: '找错行 + 修好它 + 手写',
    }
  }
  if (route === 'remedial') {
    return {
      filters: { ...base, types: ['code'], codeModes: ['fill'] },
      label: '可跑的填空题',
    }
  }
  return { filters: base, label: '本章顺序练习' }
}
