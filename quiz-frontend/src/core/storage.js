/**
 * storage.js —— localStorage 安全封装
 * 隐私模式 / 配额写满 / 脏数据都能扛住，绝不让存进度这件事把页面搞崩。
 */

const NS = 'quiz:v1'

export const K = {
  settings: `${NS}:settings`,
  lastBank: `${NS}:lastBank`,
  customBanks: `${NS}:customBanks`,
  // 演武场（随手跑一段代码）里那份草稿：{ code, lang }
  // 单独存、不跟题库走 —— 它跟任何一套题库都没关系，是站主自己的草稿纸。
  forge: `${NS}:forge`,
  progress: (bankId) => `${NS}:progress:${bankId}`,
  session: (bankId) => `${NS}:session:${bankId}`,
  // 笔记单独存：它是用户自己写的内容，不该跟着「重置进度」一起被清掉
  notes: (bankId) => `${NS}:notes:${bankId}`,
  // 图笔记（概念图画布）：{ nodes: [...], edges: [...] }
  // 和文本笔记同一个道理单独存 —— 也是用户自己画的内容，不能被「重置进度」清掉。
  // 一套题库一张画布（没做多张，见 DiagramView 顶部注释）
  diagram: (bankId) => `${NS}:diagram:${bankId}`,
  // AI 补的解析也单独存：**不要**为了存解析把整份题库重存一遍，
  // 那会把内置题库冻结成「当时那一版」，以后题库更新了也看不到
  analyses: (bankId) => `${NS}:analyses:${bankId}`,
  // 作答历史（每条含题目/对错/时间戳/耗时）。报告页的原始数据。
  // 单独存是为了不跟 answers 抢空间：answers 只留每题最后一次，历史要留全部。
  history: (bankId) => `${NS}:history:${bankId}`,
  // 用户对题库的**修正**：{ [qid]: { answer?: [...], analysis?: string } }
  // 题库不准、解析写错了，用户可以就地改。
  // ⚠️ 单独存一层、不改内置题库本身：内置题库是构建时打进来的，
  // 直接改会把它冻结成"当时那一版"，以后题库更新就看不到了
  // （analyses 上我已经踩过一次这个坑，注释还留着）。
  overrides: (bankId) => `${NS}:overrides:${bankId}`,
  // 上一次"诊断先行"的结果：{ chapter, accuracy, route, total, at }
  // 存下来是为了让首页能说"上次这一章 60%" —— 诊断的价值在于**前后可比**，
  // 只存在内存里的话刷新一次就断了。
  diagnose: (bankId) => `${NS}:diagnose:${bankId}`,
  // 预习页（扫描件 → 教学骨架/术语/先猜后验，见 core/lesson.js）
  // 和题库分开存：预习页是"这次扫描件的产物"，不是题库的一部分；
  // 一套题库可以先后对应好几份扫描件（先传第 3 章、再传第 4 章）
  lesson: (bankId) => `${NS}:lesson:${bankId}`,
  // 还没挂到题库上的预习页。为什么需要它：预习页是**零成本**的那部分产出，
  // 而"变成题库"那一步可能失败（本地没配解析器/没配模型/额度用光/反代超时）。
  // 不该因为出题失败就把学生刚传的扫描件的整理结果丢掉 —— 先存这儿，
  // 导入成功后再挂到题库 id 上（见 BankTools）。
  lessonPending: `${NS}:lesson:pending`,
}

function available() {
  try {
    const t = `${NS}:__t`
    localStorage.setItem(t, '1')
    localStorage.removeItem(t)
    return true
  } catch {
    return false
  }
}

const OK = typeof window !== 'undefined' && available()

export function load(key, fallback = null) {
  if (!OK) return fallback
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    return JSON.parse(raw)
  } catch {
    // 脏数据直接丢掉，别让页面起不来
    try {
      localStorage.removeItem(key)
    } catch {}
    return fallback
  }
}

export function save(key, value) {
  if (!OK) return { ok: false, reason: 'unavailable' }
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return { ok: true }
  } catch (e) {
    // 配额超了：清掉最占地方的导入题库再试一次
    try {
      const quota = e && (e.name === 'QuotaExceededError' || e.code === 22)
      if (quota) {
        const customs = load(K.customBanks, [])
        if (Array.isArray(customs) && customs.length) {
          localStorage.removeItem(K.customBanks)
          localStorage.setItem(key, JSON.stringify(value))
          return { ok: true, reason: 'evicted-custom-banks' }
        }
      }
    } catch {}
    return { ok: false, reason: 'quota' }
  }
}

export function remove(key) {
  if (!OK) return
  try {
    localStorage.removeItem(key)
  } catch {}
}

export function storageWorks() {
  return OK
}
