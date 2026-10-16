/**
 * api.js —— 和刷题站后端（Q8B 板子上的 apps/quizgen）通信。
 *
 * 默认走**同源** /api/quiz：
 *   板子上刷题站在 /quiz/，接口在 /api/quiz/，同一个域，没有跨域问题。
 *   本地 vite 开发时由 vite.config.js 的 server.proxy 转发。
 *
 * 整套是「有后端更好，没后端也能用」：
 *   - 纯静态部署（直接开 dist、或只起了 http.server）→ ping() 会失败，
 *     前端只显示本地能力（拖 JSON、PDF 抽出文字后本地规则不给力就明确提示），
 *     不会白屏、不会报一堆红。
 *   - 想手动指向别的后端：localStorage['quiz:v1:apiBase'] 或 URL 加 ?api=...
 */

const DEFAULT_BASE = '/api/quiz'
const OVERRIDE_KEY = 'quiz:v1:apiBase'

export function apiBase() {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get('api')
    if (fromQuery) return fromQuery.replace(/\/$/, '')
    const saved = localStorage.getItem(OVERRIDE_KEY)
    if (saved) return saved.replace(/\/$/, '')
  } catch {
    /* 隐私模式下 localStorage 可能抛异常，忽略 */
  }
  return DEFAULT_BASE
}

/** 后端返回的错误：带上 code 方便 UI 分辨「没配密钥」和「调失败了」 */
export class ApiError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

function readCookie(name) {
  const hit = document.cookie.split('; ').find((row) => row.startsWith(`${name}=`))
  return hit ? decodeURIComponent(hit.split('=').slice(1).join('=')) : ''
}

let csrfPrimed = false

/**
 * 先把 csrftoken 种到 cookie 里。
 * 后端按仓库既有约定：GET /status/ 带 @ensure_csrf_cookie，
 * 之后 POST 要把 token 放进 X-CSRFToken —— 这几个接口是会真花钱的，
 * 所以不能图省事用 csrf_exempt。
 */
async function primeCsrf(force = false) {
  if (csrfPrimed && readCookie('csrftoken') && !force) return
  const response = await fetch(`${apiBase()}/status/`, { credentials: 'same-origin' })
  if (!response.ok) throw new ApiError(`后端没就绪：HTTP ${response.status}`, { status: response.status })
  csrfPrimed = true
}

/**
 * 超时上限。
 *
 * ⚠️ 这个数字由 nginx 决定，不能拍脑袋：板子上 `/api/` 那段用了
 * `proxy_read_timeout`。客户端如果等得比它久，先返回的是 nginx 的 504
 * 页面（而且是个 HTML 错误页，前端解析 JSON 会失败），报错会变得很难懂。
 * 所以这里要**略小于** nginx 的那个值，宁可早点失败让用户重试。
 *
 * 2026-10-07 调整：板子换成了本机模型（Qwen2.5-3B 跑在 4 个 CPU 线程上），
 * 写一段解析要几十秒、出一套题要好几分钟 —— 原来的 110s 会让请求必挂，
 * 前端只看到 502/504，看着像模型坏了。现在三层一起放宽：
 *     前端 SAFE_TIMEOUT 600s < nginx proxy_read_timeout 900s
 *     后端 QUIZ_LLM_TIMEOUT 600s
 */
const SAFE_TIMEOUT = 600000

async function request(path, { method = 'GET', body, timeoutMs = 30000, needCsrf = false, signal, headers: extra } = {}) {
  const base = apiBase()
  if (needCsrf) await primeCsrf()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // 调用方也能取消：用户点「取消」时立刻断开，别让板子继续拿 CPU 算
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  let response
  try {
    response = await fetch(`${base}${path}`, {
      method,
      credentials: 'same-origin',
      signal: controller.signal,
      headers:
        method === 'POST'
          ? {
              'Content-Type': 'application/json',
              'X-CSRFToken': readCookie('csrftoken'),
              ...(extra || {}),
            }
          : extra || undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    if (error?.name === 'AbortError') {
      // 用户取消 vs 自己超时：两件事，别混成一句话
      if (signal?.aborted) throw new ApiError('已取消。')
      throw new ApiError(
        `请求超时（${Math.round(timeoutMs / 1000)}s）。题量大时请分批，或稍后重试。`,
      )
    }
    throw new ApiError('连不上后端。如果你是直接打开 dist 或只起了静态服务器，AI 功能不可用。')
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }

  let payload = null
  try {
    payload = await response.json()
  } catch {
    /* 后端返的不是 JSON（比如 nginx 502 页面）*/
  }

  if (!response.ok) {
    const message = payload?.error || `接口返回 HTTP ${response.status}`
    // CSRF token 过期（服务重启过）→ 强制刷一次，让用户重试能成功
    if (response.status === 403) csrfPrimed = false
    throw new ApiError(message, { status: response.status, code: payload?.code || '' })
  }
  return payload
}

/** 后端能力自检。失败时返回 null（调用方据此降级），不抛异常。 */
export async function ping() {
  try {
    return await request('/status/', { timeoutMs: 12000 })
  } catch {
    return null
  }
}

/**
 * 提权：密码 → 一张短期通行证。
 *
 * ⚠️ 这是**安全边界**，密码只发给服务端校验、**永不进前端**。
 *   站内那个敲键序列（x s 9 9 9）只是"把密码框叫出来"——
 *   bundle 是公开可读的，谁都能看到序列，所以它本身不构成任何保护。
 */
export function elevate(password) {
  return request('/elevate/', { method: 'POST', body: { password }, timeoutMs: 15000 })
}

/**
 * Java 真跑（后端真 javac + java，不是浏览器沙箱）。
 *
 * 必须带提权 token —— 后端两道锁：`QUIZ_JAVA_ENABLED`（这台机器允许跑）
 * 和提权（这个人现在被授权）。少一个都是 403。
 *
 * 超时给 60s：后端单次墙钟 20s，编译那段最多 30s，留足余量。
 */
export function runJava({ sources, params = [], token = '' }) {
  return request('/java/run/', {
    method: 'POST',
    body: { sources, params },
    timeoutMs: 60000,
    headers: token ? { 'X-Quiz-Elevate': token } : null,
  })
}

/**
 * 浏览器抽好的「一页一行」文字 → 题库。
 *
 * `preferCloud` 和 `/generate/` 一样是三态（null=跟随后端默认）。
 * 为什么要在这个接口上也给开关：板子上「先试本机 1.5B」实测出不了能用的题，
 * 只是把机器烤热、把请求拖到 Cloudflare 的 524 —— 用户要能自己选云端。
 *
 * `signal` 用来**取消**：这类请求要跑几十秒，用户有权中途喊停
 * （不取消 = 继续占着板子的 CPU 和用户的等待）。
 */
export function importPages({
  pages,
  filename = '',
  title = '',
  subject = '',
  bankId = '',
  useLlm = true,
  preferCloud = null,
  signal,
}) {
  const body = { pages, filename, title, subject, bankId, useLlm }
  if (typeof preferCloud === 'boolean') body.preferCloud = preferCloud
  return request('/import/', {
    method: 'POST',
    needCsrf: true,
    body,
    signal,
    // 规则解析毫秒级；走 AI 兜底时才慢，整体压在 nginx 的 120s 之内
    timeoutMs: SAFE_TIMEOUT,
  })
}

/**
 * 给一批（≤20）题补解析。
 *
 * `force=true` 会**绕过服务端缓存**重新生成 —— 用于「重新生成解析」按钮：
 * 用户嫌旧的那份不好用，给缓存等于没反应。生成完仍写回缓存。
 */
export function addAnalysis({ bankId = '', questions, useCache = true, force = false }) {
  return request('/analysis/', {
    method: 'POST',
    needCsrf: true,
    body: { bankId, questions, useCache, force },
    timeoutMs: SAFE_TIMEOUT,
  })
}

/**
 * 把一批题目归纳成知识图谱（nodes / edges）。
 *
 * 和补解析一样是**会花钱**的接口，所以同样走 needCsrf（后端 @csrf_protect）。
 * 一次最多 120 道（后端 views.MAX_GRAPH_QUESTIONS），超了会被 400 拒绝 ——
 * 调用方自己抽样，见 core/graph.js 的 sampleQuestions / graphPayload。
 *
 * 返回值直接交给 core/graph.js 的 normalizeGraph() 处理：
 * 后端只保证 nodes 里至少有一个节点，edges 可能为空、也可能带 warnings
 * （模型编出来的悬空边会被丢掉并记在 warnings 里）。
 */
export function buildGraph({ questions }) {
  return request('/graph/', {
    method: 'POST',
    needCsrf: true,
    body: { questions },
    timeoutMs: SAFE_TIMEOUT,
  })
}

/**
 * 根据材料出题。
 *
 * @param {object} o
 * @param {string} [o.domain]      提示词包：'' 通用 / 'docs' 官方文档·教材（要求逐字引用原文）
 * @param {boolean|null} [o.preferCloud]
 *   哪条模型来源打头。三态，**别用 falsy 判**：
 *     null/不传 → 跟随后端默认（docs 领域默认云端优先）
 *     true      → 云端先上（精确任务：小模型做不到逐字引用）
 *     false     → 明确允许本机先上（省钱 / 离线）
 */
export function generateBank({
  material,
  count = 10,
  types,
  title = '',
  subject = '',
  domain = '',
  preferCloud = null,
  signal,
}) {
  const body = { material, count, types, title, subject, domain }
  if (typeof preferCloud === 'boolean') body.preferCloud = preferCloud
  return request('/generate/', {
    method: 'POST',
    needCsrf: true,
    body,
    signal,
    timeoutMs: SAFE_TIMEOUT,
  })
}

/**
 * 问 AI：就着**当前这道题**多轮追问（后端 `/api/quiz/tutor/`）。
 *
 * 这个接口本来只有驾考站在用（`drive/frontend`，UI 是 AiCoach.vue）。
 * 刷题站接上它之后，"答错了"才不只是看到一句解析 —— 可以接着问
 * 「我这样理解错在哪」「文档哪一节讲了这件事」。
 *
 * @param {object} o
 * @param {string} [o.domain] '' 通用 / 'docs' 官方文档·教材（要求引用原文、不确定就说不确定）
 * @returns {Promise<{ok:boolean, answer:string, llmSource?:object}>}
 */
export function askCoach({
  bankId = '',
  subject = '',
  question,
  history = [],
  message,
  domain = '',
}) {
  return request('/tutor/', {
    method: 'POST',
    needCsrf: true,
    body: { bankId, subject, question, history, message, domain },
    timeoutMs: SAFE_TIMEOUT,
  })
}

/**
 * 错题诊断：把最近错的题（≤40 道，见 core/coach.js）交给模型归纳薄弱点。
 *
 * 和补解析走同一套限流与降级链，只是提示词不同（domain='docs' 时会要求
 * 只依据错题本身、并给出"先读文档哪一节"的复习顺序）。
 *
 * @returns {Promise<{ok:boolean, answer:string, count:number, llmSource?:object}>}
 */
export function diagnose({ bankId = '', subject = '', wrongs, domain = '' }) {
  return request('/diagnose/', {
    method: 'POST',
    needCsrf: true,
    body: { bankId, subject, wrongs, domain },
    timeoutMs: SAFE_TIMEOUT,
  })
}

/**
 * 让 AI 批改**学生自己写的代码**（后端 `/api/quiz/review/`）。
 *
 * 任务回路的最后半步：写完 → 运行看到真实结果 → 他觉得行了 → 这里拿反馈。
 * 和 tutor/diagnose 一样会花钱，所以走 needCsrf（后端 @csrf_protect + 限流）。
 *
 * @param {object} o
 * @param {string} [o.goal]   他想做什么（可以空 —— 后端会按"没写目标"处理）
 * @param {string} o.code     他写的代码（不可信输入，后端只当数据）
 * @param {string} [o.lang]   'java' / 'js'；给不准就别传
 * @param {string} [o.output] 上次运行看到的结果（空＝还没跑过，后端会给静态判断）
 * @returns {Promise<{ok:boolean, summary:string, points:Array<{level:string,text:string}>, next:string, llmSource?:object}>}
 */
export function reviewCode({ goal = '', code, lang = '', output = '' }) {
  return request('/review/', {
    method: 'POST',
    needCsrf: true,
    body: { goal, code, lang, output },
    // 批改要等模型看完代码，和教练问答一个量级
    timeoutMs: SAFE_TIMEOUT,
  })
}

/**
 * 按课本这一章 + 他的弱项**留一个任务**（后端 `/api/quiz/task/`）。
 *
 * 任务回路的左半段：产出的是任务（做什么 + 什么算完成 + 能直接跑的起手代码），
 * 不是"题"。和 /generate/（出题）是两件事，别合并 —— 见 HANDOVER 的回路说明。
 *
 * @param {object} o
 * @param {string} o.material 课本这一章的文字（core/task.js 的 lessonMaterial）
 * @param {Array<{tag:string,wrong:number,total:number}>} [o.weak] 他最弱的几个标签（空＝数据不够）
 * @param {string} [o.lang]   'java' / 'js' —— 决定起手代码长什么样
 * @param {string} [o.level]  '初学' / '在学' / '复习'
 * @param {string} [o.scope]  'book' 只照书本 / 'open' 允许补充（默认，见 core/task.js 的 DEFAULT_TASK_SCOPE）
 * @returns {Promise<{ok:boolean, goal:string, why:string, quote:string, start:string,
 *   done:string[], hint:string, lang:string, fromPage:number, scope:string, llmSource?:object}>}
 */
export function generateTask({ material, weak = [], lang = 'java', level = '在学', scope = 'open' }) {
  return request('/task/', {
    method: 'POST',
    needCsrf: true,
    body: { material, weak, lang, level, scope },
    // 要模型读完整章再写代码，和批改/出题一个量级
    timeoutMs: SAFE_TIMEOUT,
  })
}

/* ==========================================================================
 * 账号与进度同步（2026-10-12）
 *
 * 用的是 Django 自带的 session 认证（和 /admin/ 同一套）—— 前端只需带 cookie，
 * 没有 token 要自己存。POST 都要 CSRF：`needCsrf` 会先 GET /status/ 把 csrftoken 种上
 * （后端那一条 `@ensure_csrf_cookie` 就是为这个存在的）。
 * ========================================================================== */

/**
 * 我是谁 + 顺便把 csrftoken 种到 cookie 里。
 * 返回 `{authenticated, user?, signup:{mode, open, keyRequired, closed, note}}`。
 * 连不上后端时抛 ApiError —— 调用方（core/auth.js）会把它当成"没登录"而不是崩溃。
 */
export function authMe() {
  return request('/auth/me/', { timeoutMs: 12000 })
}

export function authLogin({ username, password }) {
  return request('/auth/login/', {
    method: 'POST',
    needCsrf: true,
    body: { username, password },
    timeoutMs: 20000,
  })
}

/** 注册。`key` 只在「要邀请码」那一档需要（见后端 accounts.signup_public）。 */
export function authRegister({ username, password, nickname = '', key = '' }) {
  return request('/auth/register/', {
    method: 'POST',
    needCsrf: true,
    body: { username, password, nickname, key },
    timeoutMs: 20000,
  })
}

export function authLogout() {
  return request('/auth/logout/', { method: 'POST', needCsrf: true, body: {}, timeoutMs: 15000 })
}

/**
 * 取账号里某套题库的进度（传空 = 列出这个账号有哪些题库有进度）。
 *
 * ⚠️ 真正"同步"用的是下面的 saveState：**推**上去、拿回合并后的全量。
 * 这个 GET 只用于"看看账号里有什么"。两边形状见 core/state.js。
 */
export function fetchState({ bank = '' } = {}) {
  const query = bank ? `?bank=${encodeURIComponent(bank)}` : ''
  return request(`/state/${query}`, { timeoutMs: 15000 })
}

/** 推一份进度上去，拿回**合并后**的全量（服务端是"合并"而不是"覆盖"，见 qstate.py） */
export function saveState({ bank, state }) {
  return request('/state/save/', {
    method: 'POST',
    needCsrf: true,
    body: { bank, state },
    timeoutMs: 25000,
  })
}

/**
 * 把账号里某套题库的进度**删掉**（学生点"重置进度"时用）。
 * 为什么删除要单独的接口：合并是并集，推一份空的上去会被服务端那份顶回来。
 */
export function resetState({ bank }) {
  return request('/state/reset/', {
    method: 'POST',
    needCsrf: true,
    body: { bank },
    timeoutMs: 15000,
  })
}
