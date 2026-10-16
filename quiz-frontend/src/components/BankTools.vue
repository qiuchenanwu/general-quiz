<script setup>
/**
 * BankTools —— 题库工具面板：导入文件 / AI 出题 / 补解析。
 *
 * 这是给「不知道 JSON 是什么」的人准备的入口：
 * 把老师发的 PDF 拖进来 → 浏览器自己抽出文字 → 后端用规则解析 →
 * 识别不全再用 AI 兜底 → 直接变成能刷的题库。全程不用碰 JSON。
 *
 * 三种能力都依赖 Q8B 板子上的 quizgen 后端；后端不可用时**不隐藏面板**，
 * 而是明确说明「纯本地还能做什么」（拖 JSON、用 rules 解析），
 * 免得用户以为功能坏了。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useBankStore } from '@/stores/bank'
import { useQuizStore } from '@/stores/quiz'
import { apiBase, ping, importPages, addAnalysis, generateBank, ApiError } from '@/core/api'
import { extractPdfPages, openPdfForOcr } from '@/core/pdf'
import { ocrPdfPages, ocrSupported } from '@/core/ocr'
import { buildDocModel, docModelToPages, canProceed } from '@/core/docmodel'
import { mergeCrossPage } from '@/core/merge'
import { MIN_TOTAL_BEFORE_FALLBACK, buildFallbackTasks, mergeIntoBank } from '@/core/fallback'
import { buildLesson } from '@/core/lesson'
import { readableError } from '@/core/text'
import { K, save, remove } from '@/core/storage'
import DocReview from '@/components/DocReview.vue'

const bank = useBankStore()
const quiz = useQuizStore()

// AI 功能开关：默认 false；用户在 quiz.settings.aiEnabled 设 true 才会显示 AI 入口。
// 这是开源版的"AI 默认禁用"在侧上的体现 —— 后端没配 key 时 AI 按钮点了会 503，
// 索性藏起来，省得用户点了才知道。
const aiEnabled = computed(() => !!quiz.settings.aiEnabled)

const tab = ref('file') // file | generate | analysis
const backend = ref(null) // /status/ 的返回；null = 还没探到
const probing = ref(true)

/* ------------------------------- AI 出题的两组开关 ------------------------------- */

/** 材料类型：决定用后端的哪个提示词包（prompts.py 的 _PACKS） */
const MATERIAL_KINDS = [
  {
    value: '',
    label: '通用材料',
    hint: '课本段落、讲义、课件文字。按老规矩：先本机、不合格才升云端。',
  },
  {
    value: 'docs',
    label: '官方文档 / 教材',
    hint: '每道题都必须逐字引用原文；引用对不上就整道丢弃。默认「云端优先」——本机小模型抄不准。',
  },
]

/** 哪条模型来源打头（对应后端的 preferCloud 三态） */
const MODEL_PREFS = [
  { value: 'auto', label: '跟随', hint: '官方文档默认云端优先，通用材料默认先本机' },
  { value: 'cloud', label: '云端优先', hint: '更准，会花钱；抄原文、讲解类任务建议用它' },
  { value: 'local', label: '本机优先', hint: '免费、离线；质量自己盯，本机是 1.5B 小模型' },
]

/** 三档 → 三态：auto（跟随）必须传 null，不能传 false（false 是"明确要求本机先上"） */
const modelPref = computed(() => {
  const v = quiz.settings.aiModelPref
  if (v === 'cloud') return true
  if (v === 'local') return false
  return null
})

/** 当前这档会怎么走（开关那一行右边的说明） */
const currentModelHint = computed(
  () => MODEL_PREFS.find((m) => m.value === quiz.settings.aiModelPref)?.hint || '',
)

/** 导入进行中显示的"现在在干什么"：用户最怕的就是不知道在等什么 */
const modelHint = computed(() => {
  if (modelPref.value === true) return '云端优先'
  if (modelPref.value === false) return '本机优先（免费，但慢）'
  return '先试本机，撑不住自动升云端'
})

/* ------------------------------- 后端探测 ------------------------------- */
/**
 * 探测失败后的静默期。
 *
 * 纯静态部署（本地 /test/index/、或直接起 http.server）是没有后端的，
 * `/api/quiz/status/` 必然 404。如果每次进首页都探一次，控制台就会一路飘红
 * —— 看着像站点坏了，其实只是没有后端。
 * 所以失败后 60 秒内不再自动探；用户**主动**点 AI/拖 PDF 时（ensureBackend）
 * 仍然会强制重试，不会因为静默期而用不了。
 */
const PROBE_COOLDOWN_MS = 60000
// 记在 sessionStorage 而不是模块变量里：模块变量只活在一次页面加载内，
// 而「刷新一下」就会重置 —— 那样每刷新一次仍然打一次 404。
// 实测：整个验收流程有 7 次整页加载，就对应 7 条 404，看着像站点坏了。
const PROBE_KEY = 'quiz:v1:probeFailedAt'

function markProbeFailed() {
  try {
    sessionStorage.setItem(PROBE_KEY, String(Date.now()))
  } catch {
    /* 隐私模式下没 sessionStorage，退化成每次都探，不影响功能 */
  }
}

function clearProbeFailure() {
  try {
    sessionStorage.removeItem(PROBE_KEY)
  } catch {}
}

function probeRecentlyFailed() {
  try {
    const at = Number(sessionStorage.getItem(PROBE_KEY) || 0)
    return at > 0 && Date.now() - at < PROBE_COOLDOWN_MS
  } catch {
    return false
  }
}

async function probe({ force = false } = {}) {
  if (!force && probeRecentlyFailed()) {
    backend.value = null
    probing.value = false
    return null
  }
  probing.value = true
  try {
    const result = await ping()
    backend.value = result
    if (result?.ok) clearProbeFailure()
    else markProbeFailed()
    return result
  } finally {
    probing.value = false
  }
}

/** 需要后端时用：先等/重探一次，失败也允许再试（用户主动动作，无视静默期） */
function ensureBackend() {
  return backend.value?.ok ? Promise.resolve(backend.value) : probe({ force: true })
}

onMounted(() => probe())

const online = computed(() => !!backend.value?.ok)
const aiReady = computed(() => !!backend.value?.llm?.configured)
const backendHint = computed(() => {
  if (probing.value) return '正在检测后端…'
  if (!online.value) return `连不上后端（${apiBase()}）—— AI 功能不可用，本地功能照常`
  const llm = backend.value.llm || {}
  if (!aiReady.value) {
    return '后端在线，但没有可用模型；规则解析照常，AI 功能会提示怎么配（也能用本机 Ollama 免费跑）'
  }
  const where = { cloud: '云端 API', explicit: '指定端点', local: '本机模型（免费）' }[llm.source] || '模型'
  return `后端在线 · ${where} ${llm.model}`
})

/* ------------------------------- Tab 1：导入文件 ------------------------------- */
const importing = ref(false)
const dragOver = ref(false)
const progress = ref(0) // 0~1（PDF 抽文字是真进度；后端整理是"按时间估算"的软进度）
const stage = ref('')
const fileInput = ref(null)
const lastResult = ref(null)
/** 后端整理阶段的秒表 + 估算（用户报过：没有任何进度，不知道在干嘛） */
const elapsed = ref(0)
const etaSeconds = ref(0)
let tickTimer = null
let abortCtl = null

/* ------------------- 扫描件校对台（批 1：文档模型 + 人工核对） ------------------- */
/**
 * 扫描件 OCR 完之后**不能直接出题**：先建文档模型、让人在页图旁边核一遍。
 * 做了什么、为什么必须做，见 `core/docmodel.js` 与 `components/DocReview.vue` 的头部注释。
 * 这里只负责把三样东西接起来：OCR 的版面 → 文档模型 → 校对台 → 送后端的 pages。
 */
const docModel = ref(null)
const reviewOpen = ref(false)
const previewCache = new Map() // 页号 → dataURL（校对台的页图，按需渲染）
let ocrHandle = null // OCR 期间到校对结束，PDF 句柄要活着（页图要从它渲染）
let reviewResolve = null

/** 校对台的页图：低 DPI 渲染成 dataURL（只给人看排版，不做识别） */
async function pagePreview(page) {
  if (previewCache.has(page)) return previewCache.get(page)
  if (!ocrHandle) return ''
  const canvas = await ocrHandle.renderPage(page, 110)
  const url = canvas.toDataURL('image/jpeg', 0.72)
  canvas.width = 0
  canvas.height = 0
  previewCache.set(page, url)
  return url
}

/**
 * 走一遍校对台。**有 high 级待核对项时必须由人逐条打勾**才继续
 * （判据在 docmodel.canProceed，界面上的勾选状态在 DocReview 里）。
 */
function runReview(model) {
  docModel.value = model
  if (!model.review.some((r) => r.level === 'high')) return Promise.resolve(true)
  return new Promise((resolve) => {
    reviewResolve = resolve
    reviewOpen.value = true
  })
}
function onReviewDone(ok) {
  reviewOpen.value = false
  if (reviewResolve) reviewResolve(ok)
  reviewResolve = null
}

/** 后端整理题库这一段没有真实进度（一个 POST 打到底），所以用"时间 + 阶段"给个诚实的估算：
 *  本机 1.5B 常常要 1~3 分钟，云端通常 10~30 秒。
 *
 *  ⚠️ **只在整秒变化时才写状态**：每 250ms 都写会让这一块一秒重渲染四次，
 *  按钮一直在"抖"（自动化测试点不稳，人手点也别扭）。 */
function startTicker(eta) {
  stopTicker()
  etaSeconds.value = eta
  const t0 = Date.now()
  tickTimer = setInterval(() => {
    const secs = Math.round((Date.now() - t0) / 1000)
    if (secs !== elapsed.value) {
      elapsed.value = secs
      // 软进度：最多爬到 92%，剩下的留给"真的完成"那一刻
      progress.value = Math.min(0.92, secs / Math.max(8, eta))
    }
  }, 250)
}
function stopTicker() {
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
}

function cancelImport() {
  if (abortCtl) abortCtl.abort()
}

async function handleFile(file) {
  if (!file) return
  const isPdf = /\.pdf$/i.test(file.name)
  const isJson = /\.json$/i.test(file.name)
  // ⚠️ **只收 .pdf 和 .json** —— 这是站主的策略。
  //    2026-10-09 我一度放开成"也收图片"（为了手机拍书页），被站主否掉了：
  //    "我只允许 PDF/JSON，其他的不安全"。别再加回来了 ——
  //    要收新格式先问，这是策略不是技术选择。
  //    （说明：图片本来也不会离开浏览器（OCR 在本地跑），但**输入面**多大由站主定。）
  if (!isPdf && !isJson) {
    ElMessage.error('只认 .pdf 和 .json 两种文件')
    return
  }

  importing.value = true
  lastResult.value = null
  docModel.value = null
  try {
    if (isJson) {
      await importLocalJson(file)
    } else {
      await importFromPdf(file)
    }
  } catch (error) {
    reportError(error)
  } finally {
    importing.value = false
    stage.value = ''
    progress.value = 0
    elapsed.value = 0
    abortCtl = null
    stopTicker()
    if (fileInput.value) fileInput.value.value = ''
  }
}

async function importLocalJson(file) {
  stage.value = '解析 JSON…'
  await bank.openFile(file)
  quiz.init(bank.meta.id)
  ElMessage.success(`导入成功：${bank.meta.total} 道题`)
  lastResult.value = { kind: 'json', total: bank.meta.total, warnings: bank.current?.issues || [] }
}

async function importFromPdf(file) {
  // 不能只看挂载时那一次探测的结果：网慢的时候探测可能还没回来
  const status = await ensureBackend()
  if (!status?.ok) {
    throw new ApiError(
      'PDF 需要后端帮忙解析，但现在连不上后端。你可以：① 用板子上的地址打开本站；' +
        '② 或者把 PDF 交给 AI，产出 JSON 后拖进来（.json 是本地解析，不需要后端）。',
    )
  }

  // 1) 浏览器里抽文字
  stage.value = '正在从 PDF 里抽文字…'
  const { pages, numPages, emptyPages } = await extractPdfPages(file, (done, total) => {
    progress.value = done / total
    stage.value = `正在抽文字… 第 ${done}/${total} 页`
  })

  let chars = pages.reduce((sum, lines) => sum + lines.reduce((n, l) => n + l.length, 0), 0)
  let usedOcr = false
  let ocrInfo = null
  let pendingLesson = null // 扫描件生成的预习页，等题库 id 定下来再存（见下面 quiz.init 之后）
  let lessonStashed = { ok: false }

  // ★ 抽不出文字 = 扫描件/图片版 → **在这里走浏览器 OCR**，而不是报错了事。
  //   以前这里直接抛"需要先做 OCR 再转"，把球踢给了用户；现在自己认。
  //   放在浏览器做的理由见 core/ocr.js（服务器零成本、板子一个包都不用加、图片不用上传）。
  if (chars < 50) {
    if (!ocrSupported()) {
      throw new ApiError(
        `这份 PDF 几乎抽不出文字（${numPages} 页里 ${emptyPages} 页是空的），` +
          '而且这个浏览器不支持 OCR（需要能跑 Web Worker）。',
      )
    }
    stage.value = '这是扫描件 —— 正在用浏览器里的 OCR 识别（第一次要下约 19MB 中文模型，之后有缓存）…'
    progress.value = 0
    const doc = await openPdfForOcr(file)
    ocrHandle = doc
    previewCache.clear()
    try {
      // ★ `geometry: true` = 除了文字，还要**版面**（bbox + 逐词置信度）。
      //   为什么要：没有版面就只能靠正则猜页眉页脚、也分不出代码左边那列行号、
      //   更不知道"哪一行 OCR 没把握"。见 core/docmodel.js 的头部说明。
      const out = await ocrPdfPages(doc, {
        dpi: 200,
        geometry: true,
        onProgress: (done, total, text) => {
          progress.value = total ? done / total : 0
          stage.value = text
        },
        isCancelled: () => !!abortCtl?.signal?.aborted,
      })
      usedOcr = true
      ocrInfo = { numPages, emptyPages: out.emptyPages, chars: 0 }

      // ★ 版面 → 文档模型 → **跨页合并** → 校对台（人核对过才准往下走）
      //   为什么合并在校对台**之前**：书翻页会把一段代码切成两半，分开判会让
      //   "缺了第 21、22 行"这个结论永远出不来，也会把半段当成一整段拿去出题。
      //   判据与"为什么高危"见 core/merge.js 的头部注释。
      const built = buildDocModel(out.docPages)
      const { model, merges, dropped } = mergeCrossPage(built)
      if (merges.length || dropped.length) {
        ElMessage.info(
          `跨页接回 ${merges.length} 处、去掉重叠 ${dropped.length} 处（书翻页把一段切开了，已在下方标出）`,
        )
      }
      docModel.value = model
      const reviewed = await runReview(model)
      if (!reviewed) throw new ApiError('已取消：你在校对台上选择了不继续')

      // ★ 顺手生成**预习页**（确定性抽取，不花额度）：骨架/术语/代码清单/图表/
      //   先猜后验。**先存一份 pending** —— 预习页是零成本的那部分产出，
      //   而"变成题库"那一步可能失败（本地没解析器/没模型/额度用光/反代超时），
      //   不该因为出题失败就把刚整理好的东西丢掉。导入成功后再挂到题库 id 上。
      pendingLesson = buildLesson(model)
      lessonStashed = save(K.lessonPending, pendingLesson)

      // 送后端的文字**取文档模型的出口**，不取 OCR 的原始行 ——
      // 页眉页脚、水印、行号栏在这一步已经被剔掉，而且人在校对台上改过的代码
      // 会在这里生效（一处真值）。
      pages.length = 0
      pages.push(...docModelToPages(model))
      chars = pages.reduce((sum, lines) => sum + lines.reduce((n, l) => n + l.length, 0), 0)
      ocrInfo.chars = chars
    } finally {
      ocrHandle = null
      previewCache.clear()
      await doc.close()
    }
    if (chars < 20) {
      throw new ApiError(
        `OCR 之后还是没读出多少字（${numPages} 页共 ${chars} 字）。` +
          '可以试试：① 换更清晰的扫描/拍照；② 把照片裁到只剩正文再传。',
      )
    }
  }

  // 2) 交给后端：先规则解析，规则啃不动才用 AI
  //    ⚠️ 这一段**没有真实进度**（一个 POST 打到底），所以给"阶段 + 秒表 + 估算"，
  //    并且把模型来源开关一起传上去 —— 本机小模型出不了题时别硬等（会拖成 524）。
  stage.value = usedOcr ? '正在把 OCR 出来的文字整理成题库…' : '正在整理成题库…'
  progress.value = 0
  elapsed.value = 0
  abortCtl = new AbortController()
  // 本机优先时给更宽的估算（板子 CPU 出题慢），云端优先按 25 秒估
  startTicker(modelPref.value === false ? 150 : 25)
  let result = null
  let importError = null
  try {
    result = await importPages({
      pages,
      filename: file.name,
      title: file.name.replace(/\.pdf$/i, ''),
      bankId: file.name.replace(/\.pdf$/i, ''),
      useLlm: true,
      preferCloud: modelPref.value,
      signal: abortCtl.signal,
    })
  } catch (error) {
    // ⚠️ 用户**主动取消**不算失败 —— 别拿一份兜底题库糊他一脸。
    if (abortCtl?.signal?.aborted) throw error
    // 出题那一步整个挂了（后端 502 / 反代 524 / 模型没配 / 超时）也往下走：
    // 材料是人刚传上来、刚在校对台上核对过的，**不该因为出题失败就白费**。
    importError = error
  }
  stopTicker()
  progress.value = 1

  // ★ 零额度兜底（站主 2026-10-11 实测反馈：「这个丢弃是不是很浪费…出不了选择判断
  //   可以出交互式的代码题呀」）。后端一道可用题都没给、或只给了一道、或干脆报错时，
  //   把教材里的**代码清单**变成填空代码题 —— 不调模型、不花额度。
  //   数据来源是**人已经在校对台上核对过**的文档模型（`docModel`），
  //   所以这一步用的代码是"人看过的那份"，不是 OCR 原始吐出来的。
  const imported = result?.ok ? result.bank : null
  const importedTotal = Number(imported?.meta?.total || 0)
  let payload = imported
  let fallbackCount = 0
  if (importedTotal < MIN_TOTAL_BEFORE_FALLBACK) {
    const extra = buildFallbackTasks(docModel.value)
    if (extra.length) {
      payload = mergeIntoBank(imported, extra, { title: file.name.replace(/\.pdf$/i, '') })
      fallbackCount = extra.length
    }
  }

  // 连兜底都凑不出题（材料里没有可信的代码清单）时，才如实报错 —— 而且要说清试过哪两条路
  if (!payload?.questions?.length) {
    if (importError) throw importError
    throw new ApiError(
      '后端没能从这份文件里解析出题目，教材里的代码清单也没凑出兜底题' +
        '（可能这份材料里没有可用的代码块）。可以换个排版规整的版本，或改用 AI 出题。',
    )
  }

  bank.importJson(payload, payload.meta?.title, { persist: true })
  quiz.init(bank.meta.id)

  // 预习页挂到**后端定下来的**题库 id 上（后端会把 id slug 一遍，用文件名当键会读不到）。
  // 挂上之后那把 pending 就可以撤了 —— 但**只在真的挂成功之后**撤。
  let lessonSaved = false
  if (pendingLesson && bank.meta.id) {
    lessonSaved = !!((save(K.lesson(bank.meta.id), pendingLesson) || {}).ok)
    if (lessonSaved) remove(K.lessonPending)
  }

  lastResult.value = {
    kind: 'pdf',
    total: payload.meta?.total ?? payload.questions.length,
    strategy: result?.strategy,
    coverage: result?.coverage,
    warnings: [
      // ★ 诚实：OCR 读出来的东西要标清楚，尤其代码
      //   ⚠️ 这里**不能写 `**markdown**`** —— 模板不是 markdown，星号会原样显示出来
      ...(usedOcr
        ? [
            `这份 PDF 没有文字层（扫描件），文字是浏览器 OCR 读出来的（${ocrInfo?.chars ?? chars} 字）。` +
              `页眉页脚、扫描水印、代码左边的行号栏已经按版面剔掉了` +
              // ⚠️ 必须写 `docModel.value`：`docModel` 是个 ref，写 `docModel?.stats` 永远
              //    取到 undefined → `?? 0` → 结果卡就印出"剔除 0 行 / 核对过的 0 处"，
              //    而校对台明明写着"剔除 5 行 / 还有 9 处" —— 审计逐字对比出来的
              //    "数字打架"就是这个（同一个 `?? 0` 骗了两处）。
              (docModel.value?.stats?.droppedLines
                ? `（剔除 ${docModel.value.stats.droppedLines} 行）`
                : '') +
              `；` +
              ((docModel.value?.review || []).filter((r) => r.level === 'high').length
                ? `校对台上你核对过的 ${
                    (docModel.value.review || []).filter((r) => r.level === 'high').length
                  } 处高风险项已按你的判断放行。`
                : ''),
            '提醒：代码清单即使核对过，仍建议对着原书再看一眼再让它出代码题 —— 期望输出是从代码真跑出来的，代码错一个字题就是错的。',
          ]
        : []),
      // ★ 兜底要**明说**，不能让人以为这些是模型出的题（题目质量、判据都不一样）
      ...(fallbackCount
        ? [
            (importError
              ? `出题那一步没成功（${readableError(importError?.message || importError)}），`
              : '模型没能从这份材料里出题，') +
              `于是改用「兜底」：把教材里的代码清单变成了 ${fallbackCount} 道填空代码题` +
              `（判据是教材原文那一行，没有调用模型、不花额度；每题都能点开出处自己核对）。` +
              (importError ? '等后端好了再传一次，就能把模型出的题一起补上。' : ''),
          ]
        : []),
      ...(lessonSaved
        ? [
            `顺手生成了预习页：骨架 ${pendingLesson.stats.sections} 节、术语 ${pendingLesson.stats.terms} 条、` +
              `代码清单 ${pendingLesson.stats.listings} 段、先猜后验 ${pendingLesson.stats.selfCheck} 道` +
              `（全部来自教材原文，没有调用模型）。去顶栏「预习页」看。`,
          ]
        : []),
      ...(result?.warnings || []),
    ],
  }

  const strategyText = fallbackCount
    ? '代码清单兜底'
    : { rules: '规则解析', 'rules+llm': '规则 + AI 兜底', llm: 'AI 兜底' }[result?.strategy] || '规则解析'
  const okMsg =
    `已生成题库：${payload.meta?.total ?? payload.questions.length} 道题（${strategyText}）` +
    (lessonSaved ? '，预习页也生成了' : '')
  // 兜底顶上来时用 warning（不是 success）：这是"退而求其次"，不是"一切顺利"
  if (fallbackCount) ElMessage.warning(okMsg)
  else ElMessage.success(okMsg)
}

/* ------------------------------- Tab 2：AI 出题 ------------------------------- */
const material = ref('')
const genCount = ref(10)
const genTypes = ref(['single', 'multiple', 'judge'])
const generating = ref(false)
const genTitle = ref('')

const TYPE_LABEL = { single: '单选', multiple: '多选', judge: '判断' }

async function doGenerate() {
  if (!aiReady.value) {
    ElMessage.warning(aiReady.value ? '' : '后端还没配云端 API 密钥，AI 出题不可用')
    return
  }
  if (material.value.trim().length < 20) {
    ElMessage.warning('材料太短了，至少贴一段能出题的正文')
    return
  }
  if (!genTypes.value.length) {
    ElMessage.warning('至少选一种题型')
    return
  }

  generating.value = true
  elapsed.value = 0
  progress.value = 0
  abortCtl = new AbortController()
  startTicker(modelPref.value === false ? 150 : 25) // 本机慢、云端快，估算差很多
  try {
    const result = await generateBank({
      material: material.value,
      count: genCount.value,
      types: genTypes.value,
      title: genTitle.value || 'AI 生成的题库',
      domain: quiz.settings.aiMaterialKind === 'docs' ? 'docs' : '',
      // 三档 → 三态：auto 就**不传**这个字段，让后端按领域决定
      // （docs 与通用材料默认云端优先）。千万别写成 `!!`，那会把 auto 变成 false。
      preferCloud: modelPref.value,
      signal: abortCtl.signal,
    })
    stopTicker()
    progress.value = 1
    if (!result?.ok || !result.bank?.meta?.total) {
      throw new ApiError('AI 没产出可用的题目，换个材料或稍后重试')
    }
    bank.importJson(result.bank, result.bank.meta.title, { persist: true })
    quiz.init(bank.meta.id)
    lastResult.value = { kind: 'generate', total: result.bank.meta.total, warnings: result.warnings || [] }
    ElMessage.success(`已生成 ${result.bank.meta.total} 道题`)
  } catch (error) {
    reportError(error)
  } finally {
    generating.value = false
    stopTicker()
    elapsed.value = 0
    progress.value = 0
    abortCtl = null
  }
}

/* ------------------------------- Tab 3：补解析 ------------------------------- */
const analyzing = ref(false)
const analysisProgress = ref({ done: 0, total: 0, hit: 0 })

/** 当前题库里还没有解析的题 */
const missingAnalysis = computed(() => bank.questions.filter((q) => !q.analysis))

async function doAnalysis() {
  if (!aiReady.value) {
    ElMessage.warning('后端还没配云端 API 密钥，补解析不可用')
    return
  }
  const target = missingAnalysis.value
  if (!target.length) {
    ElMessage.info('这套题库的题都已经有解析了')
    return
  }

  // ⚠️ 批次大小必须按模型能力定，不能一刀切。
  // 云端模型一次 12 道没问题；本机小模型（qwen2.5:1.5b）一次 12 道**基本必挂**
  // —— 输出太长，模型要么把 JSON 吐一半、要么题目结构跑偏，整批作废。
  // 用户实际就是这样撞到 502 的（出题接口）。
  //
  // 补解析更严格：实测一次塞 3 道时，1.5B 只有 1 道能对上题号（它要靠 no 字段
  // 把解析映射回题目，条目一多就乱），所以本机压到 2 道。没成功的题不会写缓存，
  // 再点一次会把它们补上（缓存让这个过程是**增量**的）。
  const isLocalModel = backend.value?.llm?.source === 'local'
  const batchSize = isLocalModel ? 2 : 12 // 后端上限 20
  try {
    await ElMessageBox.confirm(
      `将为 ${target.length} 道题生成解析，结果存在服务器上，同一道题只算一次${
        isLocalModel ? '（本机模型，不花钱，但慢）' : '钱'
      }。\n` +
        (isLocalModel
          ? `本机模型按每批 ${batchSize} 道跑，预计 ${Math.ceil((target.length / batchSize) * 4)} 秒左右；\n` +
            '万一有题没出结果，再点一次会只补缺的那些。\n'
          : '') +
        '确认开始吗？',
      'AI 补解析',
      { confirmButtonText: '开始', cancelButtonText: '取消' },
    )
  } catch {
    return
  }

  analyzing.value = true
  analysisProgress.value = { done: 0, total: target.length, hit: 0 }
  let failed = 0

  try {
    for (let start = 0; start < target.length; start += batchSize) {
      const slice = target.slice(start, start + batchSize)
      const result = await addAnalysis({
        bankId: bank.meta.id,
        questions: slice.map((q) => ({
          no: q.no,
          type: q.type,
          stem: q.stem,
          options: q.options,
          answer: q.answer,
        })),
      })
      // 解析存进 quiz store 的 analyses（**不是**把整份题库重存一遍：
      // 重存会把内置题库冻结成「当时那一版」，以后题库更新就看不到了）
      quiz.setAnalyses(result.items || [])
      analysisProgress.value.done += slice.length
      analysisProgress.value.hit += result.hit || 0
      failed += result.missed || 0
    }

    ElMessage.success(
      `补解析完成：本次处理 ${target.length} 道` +
        (analysisProgress.value.hit ? `，其中 ${analysisProgress.value.hit} 道命中服务器缓存没花钱` : '') +
        (failed ? `，${failed} 道模型没给出解析，可再点一次重试` : ''),
    )
  } catch (error) {
    reportError(error)
  } finally {
    analyzing.value = false
  }
}

/* ------------------------------- 通用 ------------------------------- */
function reportError(error) {
  const message = error instanceof ApiError ? error.message : error?.message || String(error)
  // 用户自己点的取消不是"失败"—— 报"失败：已取消"会让人以为出错了
  if (message === '已取消。') {
    ElMessage({ message: '已取消。后端最多再算完当前这一步就会停。', type: 'info', duration: 4000 })
    return
  }
  if (error instanceof ApiError && error.code === 'llm_not_configured') {
    ElMessage({ message, type: 'warning', duration: 9000, showClose: true })
  } else if (error instanceof ApiError && error.code === 'throttled') {
    ElMessage.warning(message)
  } else {
    ElMessage({ message: `失败：${message}`, type: 'error', duration: 8000, showClose: true })
  }
}

function onDrop(event) {
  dragOver.value = false
  handleFile(event.dataTransfer?.files?.[0])
}

function onPick(event) {
  handleFile(event.target.files?.[0])
}

function toggleGenType(key) {
  const index = genTypes.value.indexOf(key)
  if (index >= 0) genTypes.value.splice(index, 1)
  else genTypes.value.push(key)
}
</script>

<template>
  <section class="q-tools q-card">
    <header class="q-tools__head">
      <h3 class="q-tools__title">
        <el-icon :size="15"><MagicStick /></el-icon>题库工具
      </h3>
      <span class="q-tools__status" :class="{ 'is-on': online, 'is-ai': aiReady }">
        <i></i>{{ backendHint }}
      </span>
    </header>

    <div class="q-tools__tabs">
      <button
        v-for="t in [
          { key: 'file', label: '导入 JSON', icon: 'UploadFilled' },
          ...(aiEnabled ? [
            { key: 'generate', label: 'AI 出题', icon: 'EditPen' },
            { key: 'analysis', label: 'AI 补解析', icon: 'Reading' },
          ] : []),
        ]"
        :key="t.key"
        class="q-tools__tab"
        :class="{ 'is-active': tab === t.key }"
        @click="tab = t.key"
      >
        <el-icon :size="14"><component :is="t.icon" /></el-icon>{{ t.label }}
      </button>
    </div>

    <!-- ─────────── 导入文件 ─────────── -->
    <div v-if="tab === 'file'" class="q-tools__pane">
      <div
        class="q-tools__drop"
        :class="{ 'is-over': dragOver, 'is-busy': importing }"
        @dragover.prevent="dragOver = true"
        @dragleave.prevent="dragOver = false"
        @drop.prevent="onDrop"
        @click="fileInput?.click()"
      >
        <input ref="fileInput" type="file" accept=".pdf,.json,application/pdf,application/json" hidden @change="onPick" />
        <span class="q-tools__drop-icon">
          <el-icon :size="22"><component :is="importing ? 'Loading' : 'UploadFilled'" /></el-icon>
        </span>
        <b>{{ importing ? stage : '把题库 PDF（或 JSON）拖到这里' }}</b>
        <em v-if="!importing">
          只收 .pdf 和 .json。电子版 PDF 直接抽文字；扫描件会在你的浏览器里做 OCR
          （第一次要下约 19MB 中文模型）；再由服务器整理成题库。
        </em>
      </div>

      <!-- 进度**放在拖放区外面**：拖放区是点击选文件的区域，
           把状态塞进去会被它的布局裁掉（取消按钮点不到，实测过） -->
      <div v-if="importing" class="q-tools__prog q-tools__prog--left">
        <div class="q-tools__bar">
          <div class="q-tools__bar-in" :style="{ width: Math.round(progress * 100) + '%' }"></div>
        </div>
        <div class="q-tools__progline">
          <span class="q-num">{{ Math.round(progress * 100) }}%</span>
          <span v-if="elapsed" class="q-num q-dim">已用 {{ elapsed }}s</span>
          <span class="q-dim">{{ modelHint }}</span>
          <button class="q-tools__cancel" @click="cancelImport">取消</button>
        </div>
      </div>

      <!-- 模型来源（AI 启用时才显示）：放在导入按钮**旁边**（用户问过"开关在哪里" —— 藏在设置里等于没有） -->
      <div v-if="tab === 'file' && aiEnabled" class="q-tools__modelpick">
        <span class="q-dim">用哪条模型整理：</span>
        <button
          v-for="m in MODEL_PREFS"
          :key="m.value"
          class="q-tools__modelbtn"
          :class="{ 'is-active': quiz.settings.aiModelPref === m.value }"
          :title="m.hint"
          @click="quiz.setSetting('aiModelPref', m.value)"
        >
          {{ m.label }}
        </button>
        <span class="q-dim q-tools__modelhint">{{ currentModelHint }}</span>
      </div>

      <p v-if="!online && !probing" class="q-tools__note">
        <el-icon><InfoFilled /></el-icon>
        PDF 需要后端。现在连不上 <code>{{ apiBase() }}</code> ——
        <b>.json 文件仍然可以本地导入</b>（不需要后端）。要连后端就用板子上的
        <code>/quiz/</code> 打开本站。
      </p>

      <div v-if="lastResult" class="q-tools__result">
        <div class="q-tools__result-row">
          <el-icon color="var(--q-ok)"><CircleCheckFilled /></el-icon>
          <b>{{ lastResult.total }} 道题</b>
          <span v-if="lastResult.strategy" class="q-chip q-chip--brand">
            {{ { rules: '规则解析', 'rules+llm': '规则+AI', llm: 'AI 兜底' }[lastResult.strategy] }}
          </span>
          <span v-if="lastResult.coverage" class="q-dim">
            规则识别 {{ lastResult.coverage.parsed }}/{{ lastResult.coverage.expected }}
          </span>
        </div>
        <ul v-if="lastResult.warnings?.length" class="q-tools__warns">
          <li v-for="(w, i) in lastResult.warnings.slice(0, 5)" :key="i">{{ w }}</li>
        </ul>
      </div>
    </div>

    <!-- ─────────── AI 出题 ─────────── -->
    <div v-else-if="tab === 'generate' && aiEnabled" class="q-tools__pane">
      <el-input
        v-model="material"
        type="textarea"
        :autosize="{ minRows: 5, maxRows: 12 }"
        placeholder="把要考的材料粘进来（课本段落、讲义、课件文字都行）。AI 只会考材料里写到的内容，不会自己发挥。"
      />
      <div class="q-tools__row">
        <span class="q-tools__label">标题</span>
        <el-input v-model="genTitle" placeholder="不给就写「AI 生成的题库」" style="width: 240px" />
        <span class="q-tools__label">题量</span>
        <el-input-number v-model="genCount" :min="1" :max="60" size="small" controls-position="right" style="width: 110px" />
      </div>
      <div class="q-tools__row">
        <span class="q-tools__label">题型</span>
        <button
          v-for="t in ['single', 'multiple', 'judge']"
          :key="t"
          class="q-chip q-clickable"
          :class="{ 'q-chip--brand': genTypes.includes(t) }"
          @click="toggleGenType(t)"
        >
          {{ TYPE_LABEL[t] }}
        </button>
      </div>
      <!--
        材料类型：官方文档走 docs 提示词包 —— 它要求**每道题逐字引用原文**，
        调用方（quiz/tools/docs_to_bank.py）会拿引文去原文里做逐字命中校验，
        抄不出来就丢弃。教材类内容最怕"编得像模像样"，所以这一步不能省。
      -->
      <div class="q-tools__row">
        <span class="q-tools__label">材料类型</span>
        <button
          v-for="k in MATERIAL_KINDS"
          :key="k.value"
          class="q-chip q-clickable"
          :class="{ 'q-chip--brand': quiz.settings.aiMaterialKind === k.value }"
          :title="k.hint"
          @click="quiz.setSetting('aiMaterialKind', k.value)"
        >
          {{ k.label }}
        </button>
      </div>
      <!--
        模型来源开关。为什么需要它：出题里最难的一类是"逐字引用原文"，
        本机 qwen2.5:1.5b 干不了 —— 实测 20 道里 10 道给的"原文"在材料里根本不存在
        （都是凭记忆改写），整批被引用校验丢掉，白跑一轮。
        三档而不是开关：「跟随」这档必须留着，否则等于替所有人改了账单。
      -->
      <div class="q-tools__row">
        <span class="q-tools__label">用哪条模型</span>
        <button
          v-for="m in MODEL_PREFS"
          :key="m.value"
          class="q-chip q-clickable"
          :class="{ 'q-chip--brand': quiz.settings.aiModelPref === m.value }"
          :title="m.hint"
          @click="quiz.setSetting('aiModelPref', m.value)"
        >
          {{ m.label }}
        </button>
      </div>
      <p class="q-tools__tiny q-dim">
        {{
          quiz.settings.aiMaterialKind === 'docs'
            ? '官方文档/教材：每道题都必须逐字引用原文，引用对不上就整道丢弃（默认「云端优先」）。'
            : '通用材料：默认也走「云端优先」—— 本机小模型出题慢且只能勉强合格，'
        }}
        <template v-if="quiz.settings.aiMaterialKind !== 'docs'">
          <br />硬等它只会把机器烤热、把请求拖成 524（要省钱可以在下面切「本机优先」）。
        </template>
      </p>
      <div class="q-tools__row q-tools__row--end">
        <el-button type="primary" :loading="generating" :disabled="!aiReady" @click="doGenerate">
          <el-icon style="margin-right: 5px"><MagicStick /></el-icon>
          {{ generating ? '正在出题…' : '生成题库' }}
        </el-button>
        <span v-if="!aiReady" class="q-dim q-tools__tiny">需要后端配好云端 API 密钥</span>
      </div>
      <!-- 出题也是几十秒起的长请求：给百分比 + 秒表 + 取消（和导入那条一致） -->
      <div v-if="generating" class="q-tools__prog q-tools__prog--left">
        <div class="q-tools__bar">
          <div class="q-tools__bar-in" :style="{ width: Math.round(progress * 100) + '%' }"></div>
        </div>
        <div class="q-tools__progline">
          <span class="q-num">{{ Math.round(progress * 100) }}%</span>
          <span v-if="elapsed" class="q-num q-dim">已用 {{ elapsed }}s</span>
          <span class="q-dim">{{ modelHint }}</span>
          <button class="q-tools__cancel" @click="cancelImport">取消</button>
        </div>
      </div>
    </div>

    <!-- ─────────── 补解析 ─────────── -->
    <div v-else-if="aiEnabled" class="q-tools__pane">
      <template v-if="bank.meta">
        <p class="q-tools__note">
          <el-icon><InfoFilled /></el-icon>
          当前题库《{{ bank.meta.title }}》共 {{ bank.meta.total }} 题，
          <b>{{ missingAnalysis.length }} 题还没有解析</b>。
          补上之后答题就能看到「为什么对、错在哪」。
        </p>
        <div class="q-tools__row q-tools__row--end">
          <el-button
            type="primary"
            :loading="analyzing"
            :disabled="!aiReady || !missingAnalysis.length"
            @click="doAnalysis"
          >
            <el-icon style="margin-right: 5px"><Reading /></el-icon>
            {{ analyzing ? '正在补解析…' : `给这 ${missingAnalysis.length} 道题补解析` }}
          </el-button>
          <span v-if="analyzing" class="q-dim q-num">
            {{ analysisProgress.done }}/{{ analysisProgress.total }}
            <template v-if="analysisProgress.hit">（缓存命中 {{ analysisProgress.hit }}）</template>
          </span>
        </div>
        <p class="q-tools__tiny q-dim">
          解析会缓存在服务器上：同一道题只花一次钱，别人再补就直接命中缓存。
        </p>
      </template>
      <p v-else class="q-tools__note">先在首页选一套题库，再来补解析。</p>
    </div>
  </section>

  <!--
    扫描件校对台（批 1）。**必须在导入之前**：OCR 出来的代码本来就可能有错
    （实测小模型把 `resp.setHeader(` 认成 `resp,setHeadqer (`），
    而代码题的对错判据是"真跑出来的期望输出"—— 拿认错的代码出题，
    学生做对了也会被判错，而且他看不出来。所以有 high 级待核对项时不许静默通过。
  -->
  <DocReview
    v-if="reviewOpen && docModel"
    :model="docModel"
    :page-image="pagePreview"
    @confirm="onReviewDone(true)"
    @cancel="onReviewDone(false)"
  />
</template>

<style scoped>
.q-tools {
  display: flex;
  flex-direction: column;
  gap: 13px;
  padding: 16px 18px;
}
.q-tools__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.q-tools__title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 15px;
  font-weight: 800;
  color: var(--q-text);
}
.q-tools__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--q-text-3);
}
.q-tools__status i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--q-text-3);
  flex: 0 0 auto;
}
.q-tools__status.is-on i {
  background: var(--q-warn);
}
.q-tools__status.is-ai i {
  background: var(--q-ok);
  box-shadow: 0 0 0 3px var(--q-ok-bg);
}

.q-tools__tabs {
  display: flex;
  gap: 6px;
  padding: 4px;
  background: var(--q-surface-3);
  border-radius: 11px;
  flex-wrap: wrap;
}
.q-tools__tab {
  flex: 1 1 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  font: 650 12.5px var(--q-font);
  color: var(--q-text-2);
  cursor: pointer;
  transition: all var(--q-dur) var(--q-ease);
  white-space: nowrap;
}
.q-tools__tab:hover {
  color: var(--q-text);
}
.q-tools__tab.is-active {
  background: var(--q-surface);
  color: var(--q-brand-1);
  box-shadow: var(--q-shadow-sm);
}
html.dark .q-tools__tab.is-active {
  color: #a5b0ff;
}

.q-tools__pane {
  display: flex;
  flex-direction: column;
  gap: 11px;
}

/* 拖入区 */
.q-tools__drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 138px;
  padding: 20px 18px;
  border: 2px dashed var(--q-border-strong);
  border-radius: var(--q-r);
  text-align: center;
  cursor: pointer;
  transition: all var(--q-dur) var(--q-ease);
}
.q-tools__drop:hover,
.q-tools__drop.is-over {
  border-color: var(--q-brand-1);
  background: color-mix(in srgb, var(--q-brand-1) 8%, transparent);
  transform: translateY(-2px);
}
.q-tools__drop.is-busy {
  pointer-events: none;
  opacity: 0.85;
}
.q-tools__drop-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 14px;
  background: var(--q-surface-3);
  color: var(--q-text-2);
}
.q-tools__drop.is-over .q-tools__drop-icon,
.q-tools__drop:hover .q-tools__drop-icon {
  background: var(--q-grad);
  color: #fff;
}
.q-tools__drop b {
  font-size: 14.5px;
  font-weight: 700;
}
.q-tools__drop em {
  font-style: normal;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--q-text-3);
  max-width: 420px;
}
.q-tools__bar {
  width: min(320px, 80%);
  height: 5px;
  margin-top: 4px;
  border-radius: 99px;
  background: var(--q-surface-3);
  overflow: hidden;
}
.q-tools__bar-in {
  height: 100%;
  background: var(--q-grad);
  transition: width 0.2s var(--q-ease);
}

/* 导入进度那一行：百分比 + 秒表 + 取消 */
.q-tools__prog {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 100%;
}
.q-tools__prog--left {
  align-items: flex-start;
  margin-top: 10px;
}
.q-tools__prog--left .q-tools__bar {
  width: 100%;
}
.q-tools__prog--left .q-tools__progline {
  justify-content: flex-start;
}
.q-tools__progline {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12.5px;
}
.q-tools__cancel {
  border: 1px solid var(--q-border-strong);
  background: var(--q-surface);
  color: var(--q-text-2);
  font-size: 12px;
  padding: 4px 12px;
  border-radius: var(--q-r-full);
  cursor: pointer;
  transition: all var(--q-dur) var(--q-ease);
}
.q-tools__cancel:hover {
  border-color: var(--q-bad);
  color: var(--q-bad);
  background: var(--q-bad-bg);
}

/* 模型来源：就放在导入区下面（用户问过"开关在哪里"） */
.q-tools__modelpick {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 12px;
  font-size: 12.5px;
}
.q-tools__modelbtn {
  border: 1px solid var(--q-border);
  background: var(--q-surface);
  color: var(--q-text-2);
  font-size: 12.5px;
  font-weight: 600;
  padding: 5px 12px;
  border-radius: var(--q-r-full);
  cursor: pointer;
  transition: all var(--q-dur) var(--q-ease);
}
.q-tools__modelbtn:hover {
  border-color: var(--q-brand-1);
  color: var(--q-brand-1);
}
.q-tools__modelbtn.is-active {
  background: color-mix(in srgb, var(--q-brand-1) 12%, transparent);
  border-color: color-mix(in srgb, var(--q-brand-1) 45%, transparent);
  color: var(--q-brand-1);
}
.q-tools__modelhint {
  flex: 1 1 200px;
  min-width: 0;
}

.q-tools__note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--q-text-2);
  padding: 10px 12px;
  border-radius: var(--q-r-sm);
  background: var(--q-surface-2);
}
.q-tools__note code {
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--q-surface-3);
  font-family: var(--q-mono);
  font-size: 11.5px;
}
.q-tools__tiny {
  font-size: 11.5px;
  line-height: 1.6;
}

.q-tools__result {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 11px 13px;
  border-radius: var(--q-r-sm);
  background: var(--q-ok-bg);
  border: 1px solid color-mix(in srgb, var(--q-ok) 28%, transparent);
}
.q-tools__result-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}
.q-tools__warns {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--q-text-2);
}

.q-tools__row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.q-tools__row--end {
  justify-content: flex-end;
}
.q-tools__label {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--q-text-3);
}

@media (max-width: 700px) {
  .q-tools__row .el-input,
  .q-tools__row :deep(.el-input) {
    width: 100% !important;
  }
}
</style>
