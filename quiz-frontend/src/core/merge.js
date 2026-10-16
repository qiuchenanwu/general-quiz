/**
 * merge.js —— **跨页合并**：书上一段内容被翻页切成两半时，把它们接回去
 * ============================================================================
 * 站主原话：「书有一个问题，那就是上一页的东西和下一页会有关联，如果只有上一页
 * 是不完整的，可不可以合并呢？？加个合并展示」。
 *
 * 为什么非做不可（不是排版好看问题）：
 *   ① **行号判据会算错**：一段代码清单被翻页切成两半，`docmodel.js` 会**各判各的**：
 *      上半段行号 18~20 没缺、下半段 23~25 也没缺 ——"缺了第 21、22 行"这个结论
 *      **永远出不来**。而这正是第二十批那条"危险：行号读不可靠"要拦的东西。
 *   ② **出题会拆成两段**：`docs_to_bank.py` 的 `model_to_markdown()` 是**一块一个围栏块**，
 *      半段代码清单各自变成一个"代码教学点" → 出出来的题必然缺一半
 *      （批 5 量过：自动出不了"真跑"题，这是其中一个原因）。
 *   ③ 校对台上一次只看一页，人看不到"下半段在下一页"，会把半段当成完整的核对过去。
 *
 * ⚠️ **只动"块怎么分组"，不动文字顺序**：`docModelToPages()` 是按行摊平的，
 *    所以合并前合并后送给后端的文字**逐字节相同**（这一点很重要：它意味着
 *    这个功能不可能改变"后端看到了什么"，最多改变"我们怎么判断和展示"）。
 *    真正因此受益的是：行号判据、出题切分、校对台展示。
 *
 * ⚠️ **一个高危点**：`model.review[]` 的待核对项是按 `blockId` 挂到块上的
 *    （`docmodel.js` 的 834/841 行）。合并时如果把被并掉的那一块直接删掉，
 *    挂在它上面的高风险项就成了**孤儿** —— 校对台上再也渲染不出来，
 *    「继续生成」会永远灰着，而人怎么点都清不掉那个计数。
 *    所以这里**必须把 `blockId` 改挂到保留下来的那一块上**（`_repoint`）。
 */

/** 一段文字里花括号/圆括号/方括号的净深度（> 0 = 还没写完，多半续到下一页） */
export function bracketBalance(text) {
  const s = String(text ?? '')
  let depth = 0
  let i = 0
  let inStr = null
  let inLine = false
  let inBlock = false
  while (i < s.length) {
    const c = s[i]
    const n = s[i + 1]
    if (inLine) {
      if (c === '\n') inLine = false
      i++
      continue
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false
        i += 2
        continue
      }
      i++
      continue
    }
    if (inStr) {
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === inStr) inStr = null
      i++
      continue
    }
    if (c === '/' && n === '/') {
      inLine = true
      i += 2
      continue
    }
    if (c === '/' && n === '*') {
      inBlock = true
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c
      i++
      continue
    }
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') depth--
    i++
  }
  return depth
}

/** 块里的文字（代码块有 `text`，其它块按行拼） */
export function blockText(b) {
  if (!b) return ''
  if (typeof b.text === 'string' && b.text) return b.text
  return (b.lines || []).map((l) => l.text).join('\n')
}

/** 一句已经收尾了（下一段多半是新的一段，不是接着写） */
const SENT_END = /[。！？!?；;：:”"』】）)]\s*$/
/** 下一段的开头像"新条目/新小标题" */
const LIST_START = /^\s*(?:[•·▪◦*\-–—]|\(?\d+[.)、]|[（(]\d+[）)]|[一二三四五六七八九十]+[、.])/

/** 去掉空白后的文字：用来判"这两块其实是同一块"（重叠页） */
const squeeze = (t) => String(t ?? '').replace(/\s+/g, '')

/**
 * 这两块其实是**同一块**吗（扫描时相邻页重叠扫到同一段）。
 * 判据故意用"去空白后完全相等"：宁可不合并，也别把两段相近的正文错当重复删掉。
 */
export function isDuplicateBlock(a, b) {
  if (!a || !b || a.kind !== b.kind) return false
  const ta = squeeze(blockText(a))
  const tb = squeeze(blockText(b))
  if (!ta || ta !== tb) return false
  return ta.length >= 8 // 太短的不算（"解"、"图 3-17"这种撞车太容易）
}

/**
 * page 上最后一块 + 下一页第一块，是不是**同一段代码**被翻页切开了？
 *
 * 判据的强弱顺序（先证据、后推理）：
 *   ① 下一页那块带**题注**（"文件 3-14 ResponseServlet02.java"）→ 那是**另一份**清单，不合并
 *   ② 两边都读到了行号 → 用行号接不接着当**唯一**判据（这是硬证据，别再用别的去推翻它）；
 *      允许中间缺 1~2 个号（OCR 漏号很常见），但**倒退或跳太远就不是同一段**
 *   ③ 没有行号 → 退回"这段还没写完"：括号净深度 > 0
 */
export function codeContinues(a, b) {
  if (!a || !b || a.kind !== 'code' || b.kind !== 'code') return false
  if (a.excluded || b.excluded) return false
  // ★ 判据按"证据强度"排，**中心问题是"这段代码写完了没有"**，不是它在哪一页
  //   （站主原话：「判据改成'这段代码是否没写完/下一段能否在语法上接上'，而不是靠页缝位置」）：
  //
  //   ① 上一段括号没闭合 → 它**必然**还得往下写，那就接上 —— **哪怕下一页开头带着题注**。
  //      原来这里是"下一块有题注就直接拒绝"，而教材里 `文件 3-14 xxx.java` 这类题注
  //      恰好常常出现在**续页顶部**，等于把最该合的那一类全挡掉了（真样张上代码续写
  //      一次都没触发，就是这个原因）。
  //   ② 两边都读到了行号 → 用"行号接不接着"当唯一判据（这是硬证据，别再用别的推翻它）。
  //   ③ 两条都不成立 → 不合并。
  if (bracketBalance(blockText(a)) > 0) return true
  const ag = a.gutterNumbers || []
  const bg = b.gutterNumbers || []
  if (ag.length >= 2 && bg.length >= 2) {
    const gap = bg[0] - ag[ag.length - 1]
    return gap >= 1 && gap <= 3
  }
  return false
}

/**
 * 两个正文段是不是同一段被翻页切开了？
 *
 * ⚠️ 这条**不影响送给后端的文字**（行序不变），只影响校对台怎么分组显示 ——
 *    所以判据可以宽一点：上一段没有句末标点、下一段又不像新条目，就当它接着写。
 */
export function paraContinues(a, b) {
  if (!a || !b || a.kind !== 'para' || b.kind !== 'para') return false
  if (a.excluded || b.excluded) return false
  const ta = blockText(a).trim()
  const tb = blockText(b).trim()
  if (!ta || !tb) return false
  if (SENT_END.test(ta)) return false
  if (LIST_START.test(tb)) return false
  // 下一段必须以"词的开始"开头：真实样张上量到过一例假阳性 ——
  // 一条拼坏的页眉 `,=uw Java Web 程序设计任务教程 (第3版 ) (AIGC 版 )`
  // 被粘到正文段尾巴上。真正的跨页续写是从词中间断的
  // （同一样张上的正例：`…同时浏览器` + `页面每20s 会自动刷新…`），
  // 而以标点/等号开头的，几乎都是版面行或拼坏的行，不是正文的继续。
  if (!/^[\p{Script=Han}A-Za-z0-9]/u.test(tb)) return false
  return true
}

/**
 * 合并一个边界上的两块：`into` 吃掉 `from`。
 * 行号/缺行/低置信这些**判据字段必须重算**，不能简单相加 ——
 * 这正是①里说的"分开判会算错"要修的东西。
 *
 * `fromPage` 显式传进来（不靠 `into.page` 推）：合并块的 `page` 要固定成**起始页**，
 * 而 `pages` 要记全它横跨了哪几页。
 */
function absorb(into, from, fromPage) {
  into.lines = [...(into.lines || []), ...(from.lines || [])]
  const nums = [...new Set([...(into.gutterNumbers || []), ...(from.gutterNumbers || [])])].sort(
    (x, y) => x - y,
  )
  into.gutterNumbers = nums
  if (nums.length >= 3) {
    const min = nums[0]
    const max = nums[nums.length - 1]
    const missing = []
    for (let n = min; n <= max; n++) if (!nums.includes(n)) missing.push(n)
    into.missingLines = missing
  }
  into.lowConfidence = !!into.lowConfidence || !!from.lowConfidence
  if (into.kind === 'code') into.text = into.lines.map((l) => l.text).join('\n')
  // 合并出来的块要能说出"我来自哪几页" —— 校对台靠它显示「跨页合并 · 第 3–4 页」
  const startPage = into.page ?? fromPage
  into.page = startPage
  into.pages = [...new Set([...(into.pages || [startPage]), fromPage, ...(from.pages || [])])].sort(
    (x, y) => x - y,
  )
  into.mergedFrom = [...(into.mergedFrom || [into.id]), ...(from.mergedFrom || [from.id])]
  return into
}

/**
 * 把模型里跨页被切开的内容接回去（**返回新模型，不改原来那份**）。
 *
 * @returns {{model:object, merges:Array, dropped:Array}}
 *   · `merges` 每条 `{page, kind, from:[id], to:id}` —— 界面要说清楚合并了什么
 *   · `dropped` 每页边界上判为"重叠扫重了"的块
 */
export function mergeCrossPage(model) {
  if (!model || !Array.isArray(model.pages)) return { model, merges: [], dropped: [] }

  const next = {
    ...model,
    pages: model.pages.map((pg) => ({ ...pg, blocks: (pg.blocks || []).map((b) => ({ ...b })) })),
    // review 是**对象数组**，后面对 blockId 的改挂必须改到副本上，别动调用方那份
    review: (model.review || []).map((r) => ({ ...r })),
  }

  const merges = []
  const dropped = []
  //: 被并掉 / 被丢弃的块 → 接管它的那一块。
  //  ⚠️ **键必须是 (页, 块号)**，不能只用块号：`docmodel.js` 的块号是
  //  `b${index+1}`，**每页各编一套**（第 6 页和第 3 页都有 `b1`）。
  //  只按块号改挂，会把**别的页**上同号的待核对项一起改到错的块上；
  //  而校对台的匹配键是 `r.page === block.page && r.blockId === block.id`
  //  （DocReview.vue 的 blockItems）—— 配不上就渲染不出来，
  //  于是「继续生成」永远灰着、人怎么点都清不掉。
  //  **这个坑是拿真实 9 页样张量出来的**（合成夹具里块号恰好全局唯一，照不出来）。
  const repoint = new Map()
  const rk = (page, id) => `${page}|${id}`

  for (let i = 0; i < next.pages.length - 1; i++) {
    const P = next.pages[i]
    const Q = next.pages[i + 1]
    const live = (arr) => (arr || []).filter((b) => !b.excluded)
    const pLast = live(P.blocks).slice(-1)[0]
    const qFirst = live(Q.blocks)[0]
    if (!pLast || !qFirst) continue

    // ① 重叠扫重（整页被扫了两遍）：按页缝相邻那两块判
    if (isDuplicateBlock(pLast, qFirst)) {
      Q.blocks = Q.blocks.filter((x) => x.id !== qFirst.id)
      repoint.set(rk(Q.page, qFirst.id), { page: P.page, id: pLast.id })
      dropped.push({ page: Q.page, kind: qFirst.kind, id: qFirst.id, lines: (qFirst.lines || []).length })
      continue
    }

    // ② 配对：**只合并页缝相邻的那一对**（本页最后一块 + 下一页第一块）。
    //
    // ⚠️ 我试过放宽成"拿这一页**最后一块代码**去配下一页第一块代码"（理由是实测发现
    //    8 个页缝的尾块全是 para/table，一个 code 都没有，所以那样才配得上"该合的一对"）。
    //    结果被**真实 9 页样张**当场拦住：`docModelToPages()` 送后端的文字
    //    **顺序变了**（逐字节不再相同）—— 因为被并掉的那块要从下一页搬到本页的
    //    **中间**去，跨过了它前面那些块。那已经不是"合并"，是**偷偷重排教材**。
    //    ⇒ 想做"清单在页面中间被切开"那种，必须先跟站主确认"允许重排材料"，
    //      不能顺手做掉。合成夹具照不出这个（夹具里那两块恰好相邻），真数据才行。
    let a = null
    let b = null
    if (codeContinues(pLast, qFirst)) {
      a = pLast
      b = qFirst
    } else if (paraContinues(pLast, qFirst)) {
      a = pLast
      b = qFirst
    }
    if (!a || !b) continue

    absorb(a, b, Q.page)
    Q.blocks = Q.blocks.filter((x) => x.id !== b.id)
    repoint.set(rk(Q.page, b.id), { page: a.page, id: a.id })
    merges.push({ page: a.page, kind: a.kind, from: b.id, to: a.id, pages: a.pages })
  }

  // ★ 把待核对项/告警**改挂到保留下来的那块**上（页面也要跟着改，见上面 rk 的注释）。
  //   不做这一步 = 校对台上那些高风险项永远渲染不出来 = 人卡在"还有 N 处没核对"。
  const resolve = (page, id) => {
    let cur = { page, id }
    const seen = new Set()
    for (let i = 0; i < 8; i++) {
      const key = rk(cur.page, cur.id)
      if (seen.has(key)) break
      seen.add(key)
      const target = repoint.get(key)
      if (!target) break
      cur = target
    }
    return cur
  }
  if (repoint.size) {
    for (const r of next.review) {
      if (!r.blockId) continue
      const to = resolve(r.page, r.blockId)
      if (to.page !== r.page || to.id !== r.blockId) {
        r.page = to.page
        r.blockId = to.id
      }
    }
    for (const pg of next.pages) {
      for (const w of pg.warnings || []) {
        if (!w.blockId) continue
        const to = resolve(pg.page, w.blockId)
        if (to.id !== w.blockId) w.blockId = to.id
      }
    }
  }

  next.merges = merges
  next.droppedDuplicates = dropped
  next.stats = recomputeStats(next)
  return { model: next, merges, dropped }
}

/**
 * 合并之后把 `stats` 里"按块算"的那几个数重算。
 *
 * ⚠️ 对账等式 `inputLines = keptLines + droppedLines` **必须继续成立**：
 *    合并只是把两个块的行挪进一个块（kept 不变）；只有"重叠页去重"会真的少行，
 *    所以那部分要计进 `droppedLines`。这条等式在 test_engine 里有断言。
 */
function recomputeStats(model) {
  const stats = { ...(model.stats || {}) }
  const blocks = model.pages.flatMap((pg) => pg.blocks || [])
  const codeBlocks = blocks.filter((b) => b.kind === 'code')
  const keptLines = blocks.reduce((n, b) => n + (b.lines || []).length, 0)
  stats.blocks = blocks.length
  stats.keptLines = keptLines
  stats.codeBlocks = codeBlocks.length
  stats.codeLines = codeBlocks.reduce((n, b) => n + (b.lines || []).length, 0)
  stats.codeMissingLines = codeBlocks.reduce((n, b) => n + (b.missingLines?.length || 0), 0)
  stats.codeUnreliable = codeBlocks.filter((b) => (b.missingLines?.length || 0) > 5).length
  stats.lowConfidenceLines = blocks.reduce(
    (n, b) => n + (b.lines || []).filter((l) => l.lowConfidence).length,
    0,
  )
  stats.merges = model.merges?.length || 0
  stats.droppedDuplicates = (model.droppedDuplicates || []).reduce(
    (n, d) => n + (d.lines || 0),
    0,
  )
  if (typeof stats.droppedLines === 'number') {
    stats.droppedLines += stats.droppedDuplicates
    if (typeof stats.inputLines === 'number') {
      stats.reconcile = stats.inputLines - (keptLines + stats.droppedLines)
    }
  }
  return stats
}
