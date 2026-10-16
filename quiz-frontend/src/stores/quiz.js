import { defineStore } from 'pinia'
import { isCorrect, TYPE_LABEL } from '@/core/normalize'
import { judgeCode, CODE_MODE_LABEL } from '@/core/code'
import { buildReport } from '@/core/analytics'
import { emptyDiagram, normalizeDiagram } from '@/core/diagram'
import { STREAK_MILESTONES, streakLevel } from '@/core/celebrate'
import { parseTracks } from '@/core/music'
import { playSfx, configureSound } from '@/core/feedback'
import { K, load, save, remove } from '@/core/storage'
import { DEFAULT_CODE_THEME, PANEL_VARS, TOKEN_NAMES, themeCssVars, themeOverrides } from '@/core/code-theme'
// 账号同步（未登录时这些函数什么都不做，见 core/sync.js）
import { resetRemoteState, schedulePush } from '@/core/sync'
import { applyState, collectState, emptyCleared } from '@/core/state'
import { useBankStore } from './bank'

const DEFAULT_SETTINGS = {
  theme: 'auto', // auto | light | dark
  // 代码块配色（可选主题见 core/code-theme.js）。'site' = 跟随站点明暗，**默认不变**
  codeTheme: DEFAULT_CODE_THEME,
  stemSize: 19, // 题干字号 px
  autoNext: false, // 答对后自动跳下一题
  autoNextDelay: 700,
  revealFirst: false, // 背题模式：进来就直接显示答案
  removeWrongOnCorrect: true, // 答对即移出错题本
  sound: true, // 答题音效（默认开：没声音用户根本不知道有这功能）
  soundVolume: 0.5, // 0~1
  showAnswerSheet: true, // 桌面端显示右侧答题卡
  // 背景：none（默认，最省电最清晰）| aurora（CSS 极光，几乎零开销）
  //        | silk（片元着色器丝缎）| stars（Canvas 星点）
  //        | webgl（片元着色器星云）
  background: 'none',
  backgroundIntensity: 0.6, // 0~1，背景的显眼程度（答题时太亮会分心）
  // 音乐播放器（右下角那颗小按钮）的总开关。**默认关**：突然冒出音乐很烦人，
  // 而且浏览器会拦住自动播放（还会留一条控制台红字）。
  // 注意它只管"右下角那颗按钮/面板在不在"：成就页的播放器只看 musicList 有没有配歌
  // （这是老行为，别顺手改成"关掉就哪儿都不放"）。
  musicOn: false,
  musicType: 2, // 2=单曲（官方 outchain 的 type），0=歌单/专辑
  musicId: '', // 网易云地址栏里 id= 后面那串数字
  musicNote: '', // 自己起个名字显示在按钮上（可空）
  // 播放器按钮被拖到哪了：{ rx, ry } = 按钮中心占视口宽高的**比例**。
  // 存比例而不是像素，换窗口大小/换设备后按新视口重算再夹紧，不会跑出屏幕。
  // null = 没拖过，走默认的右下角。
  musicPos: null,
  // **主播放器的曲库**（右下角面板和成就页都用它）。
  // 配了就走完整播放器（APlayer：封面/歌词/列表/媒体键），没配才退回上面的网易云外链。
  // 每行一首，`|` 分段，后两段可省：
  //     https://example.com/a.mp3
  //     起个名字 | https://example.com/b.mp3
  //     起个名字 | https://example.com/c.mp3 | 封面网址 | 歌词网址
  // 解析规则见 core/music.js 的 parseTracks（有单测）。
  musicList: '',
  // 音乐音量（0~1）。和答题音效的音量分开：
  // 那个是提示音、要轻；这个是听歌、通常想大声一点。
  // 播放器自己的音量条拖动也会回写到这儿（见 stores/player.js 的 pullVolume）。
  musicVolume: 0.8,
  // 答题庆祝特效（答对旧错题爆彩花、连对里程碑放更盛大的）
  celebrate: true,
  // AI 出题用哪条模型来源打头。三档，别改成布尔 —— 「跟随」这一档是必需的：
  //   auto  跟随后端默认（官方文档/教材类默认云端优先，其余先本机）
  //   cloud 云端先上（贵但准：逐字引用原文这种精确活本机小模型干不了）
  //   local 本机先上（免费 / 离线；讲错的地方得自己盯）
  // 为什么默认跟随而不是一刀切云端：出题大多是"通用材料"，先本机是省钱的老行为，
  // 不能因为加了 docs 就悄悄改掉所有人的账单。
  aiModelPref: 'auto',
  // AI 出题的材料类型：'' 通用 / 'docs' 官方文档·教材
  // docs 走另一个提示词包（强制每道题逐字引用原文，且默认云端优先）
  aiMaterialKind: '',
  // 开源版默认隐藏所有 AI 入口（补解析 / 出题 / 教练 / 诊断 / 知识图谱 / 任务）。
  // 后端没有配 QUIZ_LLM_API_KEY 时调过去只会拿到 503 + ai_disabled，
  // 把这层也藏掉是省得用户点了才发现。
  // 想启用：把这里改成 true（或者在浏览器控制台跑
  //   localStorage.setItem('quiz:v1:settings', JSON.stringify({...}))）。
  // 注意：AI 是默认**功能禁用** + 代码保留的方式发布的，配上后端 key 即可启用，
  // 不需要改前端代码。
  aiEnabled: false,
}

const MODE_LABEL = {
  seq: '顺序练习',
  random: '随机练习',
  exam: '模拟考试',
  wrong: '错题重做',
  fav: '收藏练习',
}

/** 作答历史上限。一条约 60 字节，8000 条 ≈ 500KB，够看很久的趋势又不会撑爆 localStorage */
export const HISTORY_MAX = 8000

export function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * 判定一道题对不对 —— **唯一的判定入口**。
 *
 * 选择题比字母集合（isCorrect），代码题走 core/code.js 的 judgeCode
 * （填空比原文、找错比行号、预测比字母、修好它比运行输出）。
 * 之所以要一个入口而不是在调用处 if：判定散在多处（作答/交卷/重判），
 * 漏一处就会出现"练习判对、交卷判错"这种最难查的 bug。
 */
function judgeOf(q, picked, answer) {
  if (q?.type === 'code') return judgeCode(q, picked).ok
  return isCorrect(picked, answer)
}

export const useQuizStore = defineStore('quiz', {
  state: () => ({
    bankId: '',
    answers: {}, // qid -> { p:['A'], ok:true, ts }
    fav: {}, // qid -> 1
    wrong: {}, // qid -> 1
    // ---- 下面这几项是「账号同步」要用的元数据（2026-10-12 新增，见 core/state.js）----
    // favAt: qid -> 取消/加上收藏的时间。收藏本身没有时间戳，没有它就分不清
    //        "账号里没有这条收藏"是"从没收藏过"还是"在别处取消过"。
    favAt: {},
    // notesRemoved: qid -> 删掉这条笔记的时间（墓碑）。删单条笔记没法用"清空阈值"表达，
    //        那会把别的笔记一起判死。
    notesRemoved: {},
    // clearedAt: 清空过哪一类、什么时候。合并时拿它当阈值 ——
    //        没有它就会出现"我清空了进度，登录之后又全回来了"（并集合并的经典错法）。
    clearedAt: emptyCleared(),
    // diagramAt: 画布最后一次被动过的时间（画过或清过都算）
    diagramAt: 0,
    // progressUpdatedAt: 进度最后一次写盘的时间（只是"整块快照"的时间，不参与逐题判先后）
    progressUpdatedAt: 0,
    notes: {}, // qid -> { text, ts, updatedAt }  自己写的笔记
    // 图笔记：一套题库一张概念图画布 { nodes:[...], edges:[...] }
    // 只存"图长什么样"；撤销栈、缩放、当前选中都是**视图的临时状态**，
    // 不进 store（刷新后本来也不该恢复撤销历史）
    diagram: emptyDiagram(),
    analyses: {}, // 题号 -> 解析文本（AI 补的，单独存，见 storage.js 的注释）
    history: [], // 作答历史：[{ q, ok, t, ms }] —— 报告页的原始数据
    overrides: {}, // 用户修正：{ [qid]: { answer?: [...], analysis?: string } }
    // 最近一次"值得庆祝"的作答：{ kind, level, label, qid, ts }
    // 视图 watch 它来放特效/横幅；store 本身不碰 DOM（否则没法在 Node 里测）
    lastFeedback: null,
    _shownAt: 0, // 当前这道题是什么时候显示出来的（用来算耗时），不属于业务状态
    session: null,
    settings: { ...DEFAULT_SETTINGS },
    _saveTimer: null,
    _noteTimer: null,
    _diagramTimer: null,
  }),

  getters: {
    /* ------------------------------ 进度统计 ------------------------------ */
    stats(state) {
      // 有选项 → 正常作答；没选项但 ok=false → 点了「不会，看答案」，也算做过
      const isDone = (r) => !!r && ((r.p && r.p.length > 0) || r.skipped)
      const recs = Object.values(state.answers)
      const answered = recs.filter(isDone).length
      const correct = recs.filter((r) => r && r.ok).length
      const bank = useBankStore()
      const byType = {}
      bank.questions.forEach((q) => {
        const r = state.answers[q.id]
        byType[q.type] ||= { total: 0, answered: 0, correct: 0 }
        byType[q.type].total++
        if (isDone(r)) {
          byType[q.type].answered++
          if (r.ok) byType[q.type].correct++
        }
      })
      return {
        total: bank.questions.length,
        answered,
        correct,
        wrong: answered - correct,
        accuracy: answered ? Math.round((correct / answered) * 100) : 0,
        byType,
      }
    },

    answeredCount: (state) =>
      Object.values(state.answers).filter((r) => r && ((r.p && r.p.length) || r.skipped)).length,
    favCount: (state) => Object.keys(state.fav).length,
    wrongCount: (state) => Object.keys(state.wrong).length,

    wrongIds: (state) => Object.keys(state.wrong),
    favIds: (state) => Object.keys(state.fav),

    /* ------------------------------- 笔记 ------------------------------- */
    noteIds: (state) => Object.keys(state.notes),
    noteCount: (state) => Object.keys(state.notes).length,
    noteOf: (state) => (qid) => state.notes[qid]?.text || '',

    /* ------------------------------- 图笔记 ------------------------------- */
    /** 有没有画过东西（没画过的时候页面给引导空态，而不是一块空白画布） */
    hasDiagram: (state) => state.diagram.nodes.length > 0,
    diagramNodeCount: (state) => state.diagram.nodes.length,
    diagramEdgeCount: (state) => state.diagram.edges.length,

    /* ------------------------------- 学习报告 ------------------------------- */
    /**
     * 报告页要的全部统计。计算放在 core/analytics.js（纯函数，能在 Node 里断言），
     * 这里只负责把「历史 + 当前题库」喂进去。
     */
    report(state) {
      const bank = useBankStore()
      return buildReport(state.history, bank.questions)
    },

    /** 有没有足够数据画报告（没做过题时报告页给空态而不是一堆 0） */
    hasHistory: (state) => state.history.length > 0,
    hasNote: (state) => (qid) => !!state.notes[qid]?.text,

    /** 有笔记的题目（按题库原顺序），笔记页和导出都用它 */
    notedQuestions() {
      const bank = useBankStore()
      return bank.questions.filter((q) => this.notes[q.id]?.text)
    },

    /* ------------------------------ 会话状态 ------------------------------ */
    queue: (state) => state.session?.queue || [],
    currentIndex: (state) => state.session?.index || 0,
    currentQid: (state) => state.session?.queue?.[state.session.index] || null,

    currentQuestion() {
      const bank = useBankStore()
      const id = this.currentQid
      return id ? bank.byId.get(id) || null : null
    },

    /** 本题当前的作答（选项 key 数组） */
    currentPick(state) {
      const id = this.currentQid
      if (!id || !state.session) return []
      return state.session.picks[id] || []
    },

    /** 本题答案是否可见（作答后揭示，或背题模式偷看） */
    currentRevealed(state) {
      const id = this.currentQid
      if (!id || !state.session) return false
      return !!(state.session.revealed?.[id] || state.session.peeks?.[id])
    },

    /** 本题是否已被判定（真正作答过 / 点了「不会」） */
    currentJudged(state) {
      const id = this.currentQid
      if (!id || !state.session) return false
      return state.session.results?.[id] !== undefined
    },

    currentOk(state) {
      const id = this.currentQid
      if (!id || !state.session) return false
      return state.session.results?.[id] === true
    },

    /** 只是偷看了答案、没有判定 */
    currentIsPeek(state) {
      const id = this.currentQid
      if (!id || !state.session) return false
      return !!state.session.peeks?.[id] && state.session.results?.[id] === undefined
    },

    isExam: (state) => state.session?.mode === 'exam',
    modeLabel: (state) => (state.session ? MODE_LABEL[state.session.mode] || '练习' : ''),

    /** 会话整体进度（练习/考试都按「已处理」算） */
    sessionProgress(state) {
      const s = state.session
      if (!s || !s.queue.length) return { done: 0, total: 0, pct: 0 }
      const done = s.queue.filter(
        (id) => s.revealed?.[id] || s.peeks?.[id] || (s.picks[id] || []).length,
      ).length
      return { done, total: s.queue.length, pct: Math.round((done / s.queue.length) * 100) }
    },

    /** 本次会话的成绩单（练习完成 / 交卷后用） */
    sessionStats(state) {
      const s = state.session
      if (!s || !s.queue.length) return null
      let ok = 0
      let bad = 0
      let unanswered = 0
      let peeked = 0
      s.queue.forEach((id) => {
        const judged = s.results?.[id]
        const picked = s.picks[id] || []
        if (judged === true) ok++
        else if (judged === false) bad++
        else if (s.peeks?.[id]) peeked++
        else if (!picked.length) unanswered++
        else bad++
      })
      const total = s.queue.length
      const graded = ok + bad
      return {
        total,
        ok,
        bad,
        unanswered,
        peeked,
        graded,
        accuracy: graded ? Math.round((ok / graded) * 100) : 0,
        score: total ? Math.round((ok / total) * 100) : 0,
      }
    },

    /** 本次会话的错题（交卷后展示） */
    sessionWrongIds(state) {
      const s = state.session
      if (!s) return []
      return s.queue.filter((id) => {
        const p = s.picks[id]
        return p && p.length && !s.results?.[id]
      })
    },

    answerOf: (state) => (qid) => state.answers[qid] || null,

    /** 当前连对次数（连对音效和界面上的「连对 N」都读它） */
    streak: (state) => state.session?.streak || 0,

    /**
     * 播放列表（解析自 settings.musicList）。
     * 挂在 getter 上而不是每次在组件里 parse：设置一改就自动重算，
     * 设置面板、右下角面板、成就页、stores/player.js 看到的是**同一份**结果。
     * 解析是纯函数，见 core/music.js。
     */
    myMusic: (state) => parseTracks(state.settings.musicList),
  },

  actions: {
    /**
     * 考试模式剩余秒数。
     *
     * ⚠️ 这个**必须在 actions 里、并且是普通函数**，不能挪回 getters。
     * 它原来是个 getter（Pinia 会把 getters 里的东西都当 computed 缓存），
     * 依赖 session.deadline 却**不依赖 Date.now()** —— 而 Date.now() 不是响应式的，
     * 于是算一次就永久缓存住，倒计时看着就是"不走"
     * （2026-10-07 实测：「模拟考试时间不会变化」就是这个）。
     *
     * 放进 actions 就不会被缓存，每次调用都是当场算的。**不要改回 getter。**
     * 另外：需要"每秒自己刷新"的显示（比如倒计时读数），除了调这个函数，
     * 还得自己起 setInterval 重算 —— 见 PracticeView 的 syncRemaining()。
     */
    examRemainingNow() {
      const s = this.session
      if (!s || s.mode !== 'exam' || !s.deadline) return null
      return Math.max(0, Math.round((s.deadline - Date.now()) / 1000))
    },
    /* ------------------------------- 持久化 ------------------------------- */
    /** 只加载外观/偏好（不需要题库也能先跑起来） */
    loadSettings() {
      this.settings = { ...DEFAULT_SETTINGS, ...(load(K.settings, {}) || {}) }
      this.applyAppearance()
      this.syncSound()
    },

    init(bankId) {
      this.loadSettings()
      this.bankId = bankId
      const p = load(K.progress(bankId), null)
      this.answers = p?.answers || {}
      this.wrong = p?.wrong || {}
      this.fav = p?.fav || {}
      // 同步元数据：老数据里没有这几项 ⇒ 全是默认值，行为和以前**完全一样**（纯并集）
      this.favAt = p?.favAt || {}
      this.notesRemoved = p?.notesRemoved || {}
      this.clearedAt = { ...emptyCleared(), ...(p?.clearedAt || {}) }
      this.diagramAt = Number(p?.diagramAt) || 0
      this.progressUpdatedAt = Number(p?.updatedAt) || 0
      this.notes = load(K.notes(bankId), null) || {}
      // 走 normalizeDiagram 而不是直接塞：localStorage 里的东西可能是
      // 上个版本写的、或者被手工改坏了，脏数据不该让画布白屏
      this.diagram = normalizeDiagram(load(K.diagram(bankId), null))
      this.analyses = load(K.analyses(bankId), null) || {}
      this.history = load(K.history(bankId), null) || []
      this.overrides = load(K.overrides(bankId), null) || {}
      const s = load(K.session(bankId), null)
      this.session = s && s.queue?.length ? s : null
      this.applyAnalyses()
    },

    /** 把存下来的 AI 解析贴回题库里（只补空缺，不覆盖题库自带的解析） */
    applyAnalyses() {
      const bank = useBankStore()
      if (!Object.keys(this.analyses).length) return
      bank.questions.forEach((q) => {
        if (!q.analysis && this.analyses[q.no]) q.analysis = this.analyses[q.no]
      })
    },

    /**
     * 存一批 AI 生成的解析。
     * @param {Array<{no:number, analysis:string}>} entries
     * @returns {number} 实际新增了几条
     */
    setAnalyses(entries) {
      let added = 0
      for (const item of entries || []) {
        if (!item?.analysis || !item.no) continue
        if (this.analyses[item.no]) continue
        this.analyses[item.no] = item.analysis
        added += 1
      }
      if (added) {
        save(K.analyses(this.bankId), this.analyses)
        this.applyAnalyses()
        schedulePush(this)
      }
      return added
    },

    saveSettings() {
      save(K.settings, this.settings)
    },

    /** 进度写盘做 300ms 防抖，选择题连点不至于每次都序列化 */
    persist() {
      clearTimeout(this._saveTimer)
      this._saveTimer = setTimeout(() => {
        this.progressUpdatedAt = Date.now()
        save(K.progress(this.bankId), {
          answers: this.answers,
          wrong: this.wrong,
          fav: this.fav,
          favAt: this.favAt,
          notesRemoved: this.notesRemoved,
          clearedAt: this.clearedAt,
          diagramAt: this.diagramAt,
          updatedAt: this.progressUpdatedAt,
        })
        // 登录了的话，顺手排一次"推给账号"（没登录时它什么都不做）
        schedulePush(this)
      }, 300)
    },

    /**
     * 把内存里的进度**整块**写回 localStorage。
     *
     * 什么时候要它：账号同步把合并结果放回内存之后。只放内存不写盘的话，
     * 刷新一下就回到合并前了 —— "看着同步成功了、刷新又变回去"是最难查的一类。
     */
    saveLocalState() {
      this.progressUpdatedAt = this.progressUpdatedAt || Date.now()
      save(K.progress(this.bankId), {
        answers: this.answers,
        wrong: this.wrong,
        fav: this.fav,
        favAt: this.favAt,
        notesRemoved: this.notesRemoved,
        clearedAt: this.clearedAt,
        diagramAt: this.diagramAt,
        updatedAt: this.progressUpdatedAt,
      })
      save(K.notes(this.bankId), this.notes)
      save(K.history(this.bankId), this.history)
      save(K.overrides(this.bankId), this.overrides)
      save(K.analyses(this.bankId), this.analyses)
      save(K.diagram(this.bankId), { nodes: this.diagram.nodes, edges: this.diagram.edges })
    },

    /** 同步用：这一套题库里"能跟着账号走"的那部分（形状见 core/state.js） */
    snapshotState() {
      return collectState(this)
    },

    /**
     * 同步用：把账号里那份（合并后的）进度落到本机。
     * 内存 + localStorage 一起改，然后补一次 AI 解析的回填（解析变了预览才对得上）。
     */
    applyRemoteState(state) {
      applyState(this, state)
      this.saveLocalState()
      this.applyAnalyses()
    },

    /** 重置进度的另一半：账号里那份也要删（不做的话下次登录又回来了） */
    resetAccountState() {
      return resetRemoteState(this)
    },

    /** 笔记写盘同样防抖：一边打字一边存会卡 */
    persistNotes() {
      clearTimeout(this._noteTimer)
      this._noteTimer = setTimeout(() => {
        save(K.notes(this.bankId), this.notes)
        schedulePush(this)
      }, 300)
    },

    /**
     * 换一张图（= 一次编辑的结果）。
     *
     * ⚠️ 传入的图必须来自 core/diagram.js 的操作结果（那些函数不改旧对象）。
     * 撤销栈靠"旧对象永远不变"才能只存引用，这里要是就地改图，撤销就会失真。
     */
    setDiagram(next) {
      this.diagram = next
      // 记下"这张画布最后一次被动过"—— 同步时靠它判"哪边的图更新"（见 qstate.py）
      this.diagramAt = Date.now()
      this.persistDiagram()
    },

    /** 画布拖拽时每帧都会调，必须防抖，不然每帧一次 JSON.stringify 会明显掉帧 */
    persistDiagram() {
      clearTimeout(this._diagramTimer)
      this._diagramTimer = setTimeout(() => {
        save(K.diagram(this.bankId), { nodes: this.diagram.nodes, edges: this.diagram.edges })
        this.persist()
      }, 300)
    },

    /** 清空画布（清完立刻写盘，不然刷新一下又回来了） */
    clearDiagram() {
      clearTimeout(this._diagramTimer)
      this.diagram = emptyDiagram()
      // 清空也是"动过"，而且要留个清空时间戳：不然同步时账号里那张旧图会把它顶回来
      this.diagramAt = Date.now()
      this.clearedAt = { ...this.clearedAt, diagram: this.diagramAt }
      save(K.diagram(this.bankId), emptyDiagram())
      this.persist()
    },

    persistSession() {
      if (!this.session) {
        remove(K.session(this.bankId))
        return
      }
      save(K.session(this.bankId), this.session)
    },

    /* ------------------------------- 外观 ------------------------------- */
    applyAppearance() {
      if (typeof document === 'undefined') return
      const t = this.settings.theme
      const prefersDark =
        typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
      const dark = t === 'dark' || (t === 'auto' && prefersDark)
      document.documentElement.classList.toggle('dark', dark)
      document.documentElement.style.setProperty('--q-stem-size', `${this.settings.stemSize}px`)
      // 字号联动：选项比题干小 2px
      document.documentElement.style.setProperty('--q-opt-size', `${Math.max(13, this.settings.stemSize - 3)}px`)
      this.applyCodeTheme()
    },

    /**
     * 代码块主题：把选中的配色写成 `--q-code-*` / `--q-tok-*` 变量。
     *
     * 为什么走"内联变量"而不是切 CSS class：`styles/theme.css` 已经把
     * `--q-code-*` 定义在 `:root` 与 `html.dark` 上了，内联在 `<html>` 上的
     * 变量优先级更高、又**不用为每个主题写一份 CSS**（配色表的唯一来源是
     * `core/code-theme.js`，引擎断言会查它完不完整）。
     *
     * ⚠️ 选 `site` 时必须**把变量删掉**（removeProperty），不能留上一次的值 ——
     *    否则从 Dracula 切回"跟随站点"会连明暗切换都不跟着变了。
     */
    applyCodeTheme() {
      if (typeof document === 'undefined') return
      const root = document.documentElement
      const id = this.settings.codeTheme
      // 先清干净（两个变量族都要清：面板 + token）
      for (const k of PANEL_VARS) root.style.removeProperty(`--q-${k}`)
      for (const k of TOKEN_NAMES) root.style.removeProperty(`--q-tok-${k}`)
      root.dataset.codeTheme = themeOverrides(id) ? id : 'site'
      if (!themeOverrides(id)) return
      for (const [name, value] of Object.entries(themeCssVars(id))) {
        root.style.setProperty(name, value)
      }
    },

    setSetting(key, value) {
      this.settings[key] = value
      this.saveSettings()
      if (key === 'theme' || key === 'stemSize') this.applyAppearance()
      if (key === 'codeTheme') this.applyCodeTheme()
      if (key === 'sound' || key === 'soundVolume') this.syncSound()
    },

    /** 把音效设置同步给合成器；顺便在用户已经交互过时主动解锁一次 */
    syncSound() {
      configureSound({
        enabled: this.settings.sound,
        volume: this.settings.soundVolume,
      })
    },

    cycleTheme() {
      const order = ['auto', 'light', 'dark']
      const next = order[(order.indexOf(this.settings.theme) + 1) % order.length]
      this.setSetting('theme', next)
      return next
    },

    /* ------------------------------- 收藏 / 错题 ------------------------------- */
    toggleFav(qid) {
      // 记下这次"收藏/取消收藏"的时间：收藏本身没有时间戳，
      // 没有它就没法区分"账号里没有这条"是"从没收藏"还是"在别处取消过"（见 qstate.py）
      this.favAt = { ...this.favAt, [qid]: Date.now() }
      if (this.fav[qid]) delete this.fav[qid]
      else this.fav[qid] = 1
      playSfx('star')
      this.persist()
    },

    /** 从错题本里手动移掉一道（比如确认自己其实会了） */
    removeWrong(qid) {
      delete this.wrong[qid]
      this.persist()
    },

    /** 清空错题本 */
    clearWrong() {
      this.wrong = {}
      // 留个清空时间戳：不然登录之后账号里那些错题会原样回来
      this.clearedAt = { ...this.clearedAt, wrong: Date.now() }
      this.persist()
    },

    /* ------------------------------- 笔记 ------------------------------- */
    /**
     * 保存一道题的笔记。传空字符串等于删除。
     * @returns {boolean} 是否真的存下了内容
     */
    setNote(qid, text) {
      const clean = String(text ?? '').replace(/\r\n?/g, '\n').trim()
      if (!clean) {
        delete this.notes[qid]
        this.notesRemoved = { ...this.notesRemoved, [qid]: Date.now() }
        this.persistNotes()
        return false
      }
      const now = Date.now()
      const prev = this.notes[qid]
      this.notes[qid] = {
        text: clean,
        ts: prev?.ts || now, // 第一次写的时间
        updatedAt: now,
      }
      // 重新写了这条笔记 ⇒ 撤掉墓碑（不然它会被自己刚才的删除挡住）
      if (this.notesRemoved[qid]) {
        const next = { ...this.notesRemoved }
        delete next[qid]
        this.notesRemoved = next
      }
      this.persistNotes()
      return true
    },

    removeNote(qid) {
      delete this.notes[qid]
      // 按题号留墓碑：删单条笔记不能用"清空阈值"，那会把别的笔记一起判死
      this.notesRemoved = { ...this.notesRemoved, [qid]: Date.now() }
      this.persistNotes()
    },

    /** 清空本套题库的全部笔记 */
    clearNotes() {
      const now = Date.now()
      const removed = { ...this.notesRemoved }
      Object.keys(this.notes).forEach((qid) => {
        removed[qid] = now
      })
      this.notesRemoved = removed
      this.notes = {}
      save(K.notes(this.bankId), {})
      this.persist()
    },

    /**
     * 把笔记导出成 Markdown（方便贴到 Word / 飞书 / 打印）。
     * 包含题干、选项、正确答案和你的作答，这样脱离网站也能看。
     */
    exportNotesMarkdown() {
      const bank = useBankStore()
      const title = bank.meta?.title || '题库'
      const list = this.notedQuestions
      const lines = [`# ${title} · 笔记`, '', `共 ${list.length} 条，导出于 ${new Date().toLocaleString('zh-CN')}`, '']
      lines.push('---', '')

      list.forEach((q) => {
        const rec = this.answers[q.id]
        // 导出的答案也要用修正后的（用户改了答案，导出的笔记才对得上）
        const ansText = this.effectiveAnswer(q.id)
          .map((k) => (q.type === 'judge' ? { T: '正确', F: '错误' }[k] || k : k))
          .join(' ')
        lines.push(`## 第 ${q.no} 题（${TYPE_LABEL[q.type] || q.type}）`)
        lines.push('')
        lines.push(`**题干**：${q.stem}`)
        lines.push('')
        // 代码题没有选项，但**有代码** —— 导出的笔记里必须带上，否则回头看不懂自己在说什么
        if (q.code) {
          lines.push(`**代码**（${CODE_MODE_LABEL[q.mode] || q.mode || '代码'}）：`)
          lines.push('')
          lines.push('```' + (q.lang === 'js' ? 'js' : ''))
          lines.push(String(q.code))
          lines.push('```')
          lines.push('')
        }
        // 老题库/选择题才有 options；代码题的 options 是 undefined（不是空数组）
        ;(q.options || []).forEach((o) => lines.push(`- ${o.key}. ${o.text}`))
        lines.push('')
        lines.push(`**正确答案**：${ansText}`)
        if (rec && (rec.p?.length || rec.skipped)) {
          const mine = rec.skipped
            ? '（当时点了「不会」）'
            : rec.p.map((k) => (q.type === 'judge' ? { T: '正确', F: '错误' }[k] || k : k)).join(' ')
          lines.push(`**我的作答**：${mine} ${rec.ok ? '✅' : '❌'}`)
        }
        lines.push('')
        lines.push('**我的笔记**：')
        lines.push('')
        lines.push(
          this.notes[q.id].text
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n'),
        )
        lines.push('')
        lines.push('---')
        lines.push('')
      })
      return lines.join('\n')
    },

    /**
     * 重置本套题库的**作答进度**。
     * 刻意不动三样东西 —— 它们都是「记录」，不是「进度」，
     * 清掉等于把用户攒的东西毁了：
     *   · 笔记（自己写的）
     *   · 作答历史（学习报告的数据源）
     *   · AI 补的解析（花了额度的）
     */
    resetProgress() {
      const now = Date.now()
      this.answers = {}
      this.wrong = {}
      this.fav = {}
      this.session = null
      this._shownAt = 0
      this.lastFeedback = null
      // ★ 留清空时间戳：登录后同步时，账号里那些旧作答/错题/收藏才不会被带回来
      this.clearedAt = { ...this.clearedAt, answers: now, wrong: now, fav: now }
      this.persist()
      remove(K.session(this.bankId))
      save(K.progress(this.bankId), {
        answers: {},
        wrong: {},
        fav: {},
        favAt: this.favAt,
        notesRemoved: this.notesRemoved,
        clearedAt: this.clearedAt,
        diagramAt: this.diagramAt,
        updatedAt: now,
      })
      // 账号里那份也要真的删掉（推一份空的上去会被服务端的并集顶回来）
      this.resetAccountState()
    },

    /* ------------------------------- 组卷 ------------------------------- */
    /**
     * 按筛选条件取出题目子集。
     *
     * `codeModes` 是给**代码题**用的（fill / spot / predict / fix）：诊断先行分流之后，
     * "高分去做找错行"必须是**真的换了一套题**，而不是界面上一句话
     * （见 core/diagnose.js 的 sessionFiltersFor）。
     */
    filterQuestions({ types = [], tags = [], chapter = '', from = null, to = null, codeModes = [] } = {}) {
      const bank = useBankStore()
      return bank.questions.filter((q) => {
        if (types.length && !types.includes(q.type)) return false
        if (codeModes.length && !(q.type === 'code' && codeModes.includes(q.mode))) return false
        if (tags.length && !(q.tags || []).some((t) => tags.includes(t))) return false
        if (chapter && q.chapterId !== chapter && q.chapter !== chapter) return false
        if (from != null && to != null && (q.no < from || q.no > to)) return false
        return true
      })
    },

    startSession({ mode = 'seq', filters = {}, limit = 0, examMinutes = 0 } = {}) {
      const pool = this.filterQuestions(filters)
      let queue = pool.map((q) => q.id)

      if (mode === 'random') queue = shuffle(queue)
      else if (mode === 'exam') queue = shuffle(queue).slice(0, limit || 50)
      else if (mode === 'wrong') {
        const w = new Set(this.wrongIds)
        queue = queue.filter((id) => w.has(id))
      } else if (mode === 'fav') {
        const f = new Set(this.favIds)
        queue = queue.filter((id) => f.has(id))
      }

      if (!queue.length) return false

      this.session = {
        mode,
        queue,
        index: 0,        picks: {},
        revealed: {},
        peeks: {},
        results: {},
        streak: 0, // 连对次数：驱动连对音效和界面上的「连对 N」
        // 连对的历史最高（成就页要显示"这一轮最长连对"）——
        // streak 会随答错清零，所以必须单独记一个峰值
        bestStreak: 0,
        submitted: false,
        finished: false,
        // 成就页是不是已经给这一轮弹过了。持久化在 session 里：
        // 看完再刷新不该又弹一次（但成绩单上留了「看成就页」的入口可以重开）
        achievementSeen: false,
        startedAt: Date.now(),
        finishedAt: 0,
        examMinutes: mode === 'exam' ? examMinutes : 0,
        deadline: mode === 'exam' && examMinutes ? Date.now() + examMinutes * 60000 : 0,
        filters,
      }
      // 新会话的计时起点（不然第一题的耗时会算到上一次会话头上）
      this._shownAt = Date.now()
      // 上一次的庆祝状态也要清掉：否则新会话里"答错"时，
      // 视图 watch 到的还是上一局遗留的 redeem，会莫名其妙爆一次彩花
      // （引擎测试 C18 就是先撞到这个才发现的）
      this.lastFeedback = null
      this.persistSession()
      return true
    },

    /* ------------------------------- 答题 ------------------------------- */
    isCurrentRevealed() {
      return this.currentRevealed
    },

    /**
     * 选中 / 取消选中一个选项。
     * 多选：只记录，等用户点「确认答案」。
     * 考试模式：所有题型都只记录，绝不揭示答案（交卷时统一判）。
     * 单选 / 判断（练习模式）：选中即判定并揭示。
     */
    toggleOption(key) {
      const s = this.session
      const q = this.currentQuestion
      if (!s || !q) return { changed: false }
      if (s.revealed[q.id]) return { changed: false }

      const cur = s.picks[q.id] || []

      if (q.type === 'multiple') {
        const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]
        next.sort(
          (a, b) => q.options.findIndex((o) => o.key === a) - q.options.findIndex((o) => o.key === b),
        )
        s.picks[q.id] = next
        playSfx('click') // 多选不会立刻判定，给一下"手感"
        this.persistSession()
        return { changed: true, revealed: false }
      }

      // 单选 / 判断
      if (s.mode === 'exam') {
        // 考试里只是记答案，可以改；但只能有一个选项
        if (cur.length === 1 && cur[0] === key) return { changed: false }
        s.picks[q.id] = [key]
        playSfx('click')
        this.persistSession()
        return { changed: true, revealed: false }
      }

      // 再点已选的选项不做任何事，避免误触把已判定的题取消掉
      if (cur.includes(key)) return { changed: false }
      s.picks[q.id] = [key]
      const res = this.reveal()
      return { changed: true, revealed: true, ok: res.ok }
    },

    /**
     * 提交一道**代码题**。
     *
     * 为什么不复用 toggleOption：代码题的作答值不是字母 ——
     *   填空    每个空填进去的原文
     *   找错行  行号
     *   预测    选项字母（和选择题一样，但界面上还能按「运行」自己验）
     *   修好它  沙箱跑出来的**输出**
     * 而且代码题**一定要显式提交**：不能像单选那样"点一下就判"，
     * 那样填空题根本没法输入。所以单独一条路。
     */
    submitCode(values) {
      const s = this.session
      const q = this.currentQuestion
      if (!s || !q || q.type !== 'code') return { ok: false }
      const picked = (Array.isArray(values) ? values : [values]).map((v) => String(v ?? ''))
      // 已经判定过就不重复判（否则填空可以反复提交刷连对）
      if (s.revealed?.[q.id] !== undefined || s.results?.[q.id] !== undefined) {
        return { ok: !!s.results?.[q.id], already: true }
      }
      s.picks[q.id] = picked
      if (s.mode === 'exam') {
        // 考试里只记录，绝不揭示（和选择题一致）
        this.persistSession()
        return { changed: true, revealed: false }
      }
      const res = this.reveal()
      return { changed: true, revealed: true, ok: res.ok }
    },

    /** 判定本题：算对错、写入进度、必要时进错题本 */
    reveal({ markWrong = false } = {}) {
      const s = this.session
      const q = this.currentQuestion
      if (!s || !q) return { ok: false }
      // 已经判定过就不重复判（避免连点把正确改成错误）
      if (s.results?.[q.id] !== undefined) return { ok: !!s.results[q.id], already: true }

      const picked = s.picks[q.id] || []
      // 判定必须用**有效答案**（用户可能修正过题库）
      const ok = markWrong ? false : judgeOf(q, picked, this.effectiveAnswer(q.id))
      s.revealed[q.id] = true
      s.results[q.id] = ok
      delete s.peeks[q.id]
      this.commit(q.id, picked, ok)
      this.persistSession()
      return { ok }
    },

    /** 背题模式 / 预习：只把答案亮出来，不判定、不进错题本、也不记历史 */
    peek() {
      const s = this.session
      const q = this.currentQuestion
      if (!s || !q) return
      if (s.results?.[q.id] !== undefined) return
      s.peeks[q.id] = true
      this.persistSession()
    },

    /* ------------------------------- 题库修正 ------------------------------- */
    /**
     * 这道题的**有效答案**：用户修正优先，没有修正才用题库原答案。
     *
     * 所有判定（作答、交卷、导出）都必须走这里，不能直接读 q.answer ——
     * 否则用户改了答案，判定却还按旧的算，越改越乱。
     */
    effectiveAnswer(qid) {
      const override = this.overrides[qid]?.answer
      if (override && override.length) return [...override]
      return useBankStore().byId.get(qid)?.answer || []
    },

    /** 这道题的有效解析：用户改过的 > AI 补的 > 题库自带的 */
    effectiveAnalysis(qid) {
      const override = this.overrides[qid]?.analysis
      if (override) return override
      return this.analyses[qid] || useBankStore().byId.get(qid)?.analysis || ''
    },

    /** 这道题的答案/解析是不是被改过（界面上要给个标记） */
    isOverridden(qid) {
      const o = this.overrides[qid]
      return !!(o && ((o.answer && o.answer.length) || o.analysis))
    },

    persistOverrides() {
      save(K.overrides(this.bankId), this.overrides)
      schedulePush(this)
    },

    /**
     * 改这道题的正确答案，并**立刻按新答案重判**。
     *
     * 重判是必须的：用户改答案的理由几乎都是"题库这条是错的，我原来被判错了"。
     * 所以要把 answers / 错题本一起纠正过来，而不是只改显示。
     */
    setAnswerOverride(qid, keys) {
      // 代码题的答案不是字母（是原文/行号/输出），修正入口给不了它 ——
      // 硬套只会把题判歪，所以直接拒绝（界面上也不会给代码题显示"修正答案"）
      if (useBankStore().byId.get(qid)?.type === 'code') return
      const clean = [...new Set((keys || []).filter(Boolean))].sort()
      if (!clean.length) return
      const prev = this.overrides[qid] || {}
      this.overrides[qid] = { ...prev, answer: clean }

      // 已经作答过就按新答案重判
      const rec = this.answers[qid]
      if (rec) {
        const ok = isCorrect(rec.p || [], clean)
        this.answers[qid] = { ...rec, ok, correctedAt: Date.now() }
        if (ok) delete this.wrong[qid]
        else this.wrong[qid] = 1
        // 考试里的 session 结果也一起纠正，免得成绩单和错题本对不上
        const s = this.session
        if (s && s.results && qid in s.results) s.results[qid] = ok
        this.persist()
        if (s) this.persistSession()
      }
      this.persistOverrides()
    },

    /** 改这道题的解析（用户手写） */
    setAnalysisOverride(qid, text) {
      const clean = String(text || '').trim()
      const prev = this.overrides[qid] || {}
      if (clean) this.overrides[qid] = { ...prev, analysis: clean }
      else delete prev.analysis
      if (!clean && !prev.answer?.length) delete this.overrides[qid]
      this.persistOverrides()
    },

    /** 恢复这道题的题库原答案和原解析 */
    clearOverride(qid) {
      delete this.overrides[qid]
      this.persistOverrides()
    },

    /* ------------------------------- 作答历史 ------------------------------- */
    /**
     * 记一条作答历史。报告页（热力图 / 趋势 / 弱项 / 耗时）全靠它。
     *
     * 和 answers 的区别：answers 每题只留**最后一次**（用来判对错、进错题本），
     * 历史要留**每一次**才能看出「这道题我错过三回」和「今天做了多少」。
     */
    recordAttempt(qid, ok, ms = 0) {
      const now = Date.now()
      this.history.push({
        q: qid,
        ok: ok ? 1 : 0,
        t: now,
        // 超过 10 分钟的耗时不算「做题想了多久」（多半是中途走开了），
        // 记 0 让统计把它排除掉，而不是把平均值拉飞
        ms: ms > 0 && ms < 10 * 60 * 1000 ? Math.round(ms) : 0,
      })
      // 上限：一条约 60 字节，8000 条约 500KB，够用又不会把 localStorage 撑爆
      if (this.history.length > HISTORY_MAX) {
        this.history.splice(0, this.history.length - HISTORY_MAX)
      }
      this.persistHistory()
    },

    persistHistory() {
      save(K.history(this.bankId), this.history)
      schedulePush(this)
    },

    /** 清空学习记录（只清历史，不动作答/错题/笔记） */
    clearHistory() {
      this.history = []
      // 留个清空时间戳：不然同步时账号里那些旧历史会原样回来（合并是并集）
      this.clearedAt = { ...this.clearedAt, history: Date.now() }
      save(K.history(this.bankId), [])
      this.persist()
    },

    /** 把作答结果落到长期进度 + 错题本 */
    commit(qid, picked, ok) {
      // ⚠️ 必须在删错题本**之前**记下"这题原来错过" ——
      // 答对之后它就被移除了，事后再看是看不出来的。
      const wasWrong = !!this.wrong[qid]

      this.answers[qid] = {
        p: [...picked],
        ok,
        skipped: !picked.length, // 点了「不会，看答案」
        ts: Date.now(),
      }
      if (!ok) this.wrong[qid] = 1
      else delete this.wrong[qid]

      // 连对计数：答对 +1，答错/放弃归零。
      // ⚠️ 顺手记峰值 bestStreak —— streak 会被答错清零，成就页要显示的是
      // "这一轮最长连对"，只看 streak 的话答错一次这个数就没了。
      const s = this.session
      if (s) {
        s.streak = ok ? (s.streak || 0) + 1 : 0
        if (s.streak > (s.bestStreak || 0)) s.bestStreak = s.streak
      }
      const streak = s?.streak || 0

      // 耗时 = 从这道题显示出来到判定的时间
      this.recordAttempt(qid, ok, this._shownAt ? Date.now() - this._shownAt : 0)

      this.markFeedback({ ok, wasWrong, streak, qid })

      this.persist()
      playSfx(ok ? 'correct' : 'wrong', { combo: streak })
    },

    /**
     * 决定这一题该放什么特效。
     *
     * 只写状态、**不碰 DOM** —— 特效由视图 watch `lastFeedback` 去放。
     * store 里出现 document/canvas 会让它没法在 Node 里测（这个项目的引擎
     * 测试就是直接跑 store 的）。
     *
     * 优先级：连对里程碑（更大更稀有）> 拿下以前错过的题。
     * 连对 3 之类不爆 —— 满地彩花就不值钱了，只有 5/10/20/30/50 才配。
     */
    markFeedback({ ok, wasWrong, streak, qid }) {
      if (!ok) return
      const level = streakLevel(streak)
      if (level > 0 && STREAK_MILESTONES.includes(streak)) {
        this.lastFeedback = { kind: 'streak', level, label: `连对 ${streak}！`, qid, ts: Date.now() }
      } else if (wasWrong) {
        this.lastFeedback = { kind: 'redeem', level: 1, label: '这道错题拿下了', qid, ts: Date.now() }
      }
    },

    /* ------------------------------- 导览 ------------------------------- */
    goTo(index) {
      const s = this.session
      if (!s) return
      const next = Math.max(0, Math.min(s.queue.length - 1, index))
      // 换题就重置计时起点（包括在同一题上重复调用 —— 宁可少算，不要多算）
      if (next !== s.index) this._shownAt = Date.now()
      s.index = next
      this.persistSession()
    },
    next() {
      const s = this.session
      if (!s) return false
      if (s.index >= s.queue.length - 1) return false
      this.goTo(s.index + 1)
      return true
    },
    prev() {
      const s = this.session
      if (!s) return false
      if (s.index <= 0) return false
      this.goTo(s.index - 1)
      return true
    },
    nextUnanswered() {
      const s = this.session
      if (!s) return false
      const n = s.queue.length
      for (let step = 1; step <= n; step++) {
        const i = (s.index + step) % n
        const id = s.queue[i]
        if (!s.revealed?.[id] && !s.peeks?.[id] && !(s.picks[id] || []).length) {
          this.goTo(i)
          return true
        }
      }
      return false
    },

    /** 练习模式做完最后一题：落成绩单 */
    finishPractice() {
      const s = this.session
      if (!s) return
      s.finished = true
      s.finishedAt = Date.now()
      this.persistSession()
      playSfx('finish')
    },

    /* ------------------------------- 交卷 ------------------------------- */
    submitExam({ auto = false } = {}) {
      const s = this.session
      if (!s || s.submitted) return null
      let correct = 0
      let answered = 0
      s.queue.forEach((id) => {
        const picked = s.picks[id] || []
        const q = useBankStore().byId.get(id)
        if (!q) return
        const hasAnswer = picked.length > 0
        // 交卷判定也走有效答案
        const ok = hasAnswer ? judgeOf(q, picked, this.effectiveAnswer(id)) : false
        // 交卷后所有题都可以看答案
        s.revealed[id] = true
        // 只有真作答过的才判定对错：留空不该被算成「答错」，
        // 否则成绩单会把「未作答」和「答错」混成一类。
        if (hasAnswer) {
          s.results[id] = ok
          answered++
          if (ok) correct++
          this.answers[id] = { p: [...picked], ok, skipped: false, ts: Date.now() }
          if (!ok) this.wrong[id] = 1
          else if (this.settings.removeWrongOnCorrect) delete this.wrong[id]
          // 考试交卷时逐题计时没有意义（是一次性判的），ms 传 0 让统计排除掉。
          // 但「做了哪些题、对了几道」对报告页仍然有用。
          this.recordAttempt(id, ok, 0)
        } else {
          delete s.results[id]
        }
      })
      s.submitted = true
      s.finishedAt = Date.now()
      s.examAutoSubmitted = !!auto
      this.persist()
      this.persistSession()
      playSfx('finish')
      const total = s.queue.length
      return {
        total,
        answered,
        correct,
        wrong: answered - correct,
        unanswered: total - answered,
        score: total ? Math.round((correct / total) * 100) : 0,
        usedSeconds: Math.round((s.finishedAt - s.startedAt) / 1000),
        auto,
      }
    },

    /** 成就页给过了就记下来（存在 session 里，刷新不会又弹一次） */
    markAchievementSeen() {
      const s = this.session
      if (!s || s.achievementSeen) return
      s.achievementSeen = true
      this.persistSession()
    },

    endSession() {
      this.session = null
      this.persistSession()
    },
  },
})
