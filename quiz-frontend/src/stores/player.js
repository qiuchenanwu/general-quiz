/**
 * player.js —— 全站**唯一**的音乐播放器（单例）。
 *
 * 为什么要有这个 store（而不是像原来那样各处 `new APlayer`）：
 *   2026-10-08 之前是两个播放器各活各的 ——
 *     ① 右下角小按钮里嵌的是**网易云 iframe**（样式全在人家手里，没有播放键、
 *        没有进度、没有音量，深色主题下一块白底）
 *     ② 成就页里是 **APlayer**（有封面/歌词/列表，但只在成就页存在）
 *   两边互不知道对方在响，于是"成就页在放歌、角落那颗也能同时出声"。
 *   现在：**一个 APlayer 实例**，两个界面都只是遥控器 ——
 *   右下角面板和成就页卡片谁在前面谁当容器（见下面的 owner / 接管机制）。
 *
 * 三条实现上的取舍：
 *
 *   a. **实例放模块作用域，不进 state。** 它是个带 DOM 的大对象，塞进 Vue 的
 *      响应式代理只会让每次事件回调都过一遍 Proxy（音频事件每秒十几次），
 *      而且我们**本来就要**全局唯一。state 里只放"界面上要显示的那几个数"。
 *
 *   b. **同一时刻只允许一个音源。** 换容器 = 先把旧的 destroy 掉再建新的，
 *      建之前把 index / 进度 / 是否在播记下来，建好之后恢复 —— 所以打开成就页
 *      不会把正在放的歌打断成从头开始（只有一次很短的重新缓冲）。
 *
 *   c. **恢复进度必须等 `canplay`。** APlayer 的 seek 是
 *      `Math.min(e, this.duration)`，而 duration 在元数据到达前是 NaN ——
 *      直接 seek 会把 `currentTime` 设成 NaN 抛 TypeError。
 *      所以进度先存在 resumeAt 里，等能播了再落地。
 *
 * ⚠️ 还有一个**不要改回去**的地方：容器不能用 `display: none` 藏。
 *   APlayer 建实例时要量元素尺寸（歌词区高度、进度条宽度），
 *   在 display:none 里量出来全是 0，展开后进度条和歌词位置都是错的。
 *   面板收起时用 visibility/opacity 藏（见 MusicPlayer.vue 的 CSS 注释）。
 */
import { defineStore } from 'pinia'
import { mediaInfo, formatClock } from '@/core/music'
import { parseLrc, activeLineIndex } from '@/core/lyrics'
import { useQuizStore } from './quiz'

/** APlayer 实例。模块作用域 = 天然单例（HMR 重载会丢，开发时刷新即可） */
let ap = null
/** 当前容器元素。用来判断"是不是已经挂在这个位置了" */
let hostEl = null
/** 待恢复的播放位置（秒）。等 canplay 再 seek，见文件头 c 条 */
let resumeAt = null
/**
 * `release()` 交还实例时留下的"听到哪了"：{ index, time, playing }。
 *
 * 为什么不能直接读 state：`detach()` 会把 state 里的 index/time/playing 清零
 * （它得保证"没有实例时界面显示 0:00"）。而成就页关掉 → 右下角接手这一段，
 * 中间必然经过一次 detach —— 等新的容器建好再读 state，看到的就是全零，
 * 于是歌会**从头开始、而且不接着放**（实测就是这个症状）。
 * 所以交还的那一刻先把这几个数存下来，下一个容器接手时用掉再清掉。
 */
let handover = null
/** 歌词请求的序号：取的过程中切歌了，旧的那批要丢掉（否则会显示上一首的歌词） */
let lyricToken = 0
/** 串行化 attach：两次交错会让后建的实例被先建的覆盖，最后谁的都不对 */
let chain = Promise.resolve()
/**
 * 请求序号。每次 attach 自增，`_mount` 等完动态 import 之后要对一下 ——
 * 不是最新那一次就直接放弃。
 *
 * 为什么需要它：attach 里有 `await import('aplayer')`，这期间 owner 还是空的，
 * 另一个界面（成就页打开 / 关掉）可能又发一次 attach。没有这个号，
 * 先发起的那次会在后面把界面已经换过去的实例又抢回来，症状是
 * "打开成就页，歌却还在右下角那个已经看不见的面板里放"。
 */
let token = 0

/** 把解析出来的 track 转成 APlayer 认的 audio 项 */
function toAudio(track) {
  const item = { name: track.name, artist: '我的音乐', url: track.url }
  if (track.cover) item.cover = track.cover
  if (track.lrc) item.lrc = track.lrc
  return item
}

export const usePlayerStore = defineStore('player', {
  state: () => ({
    /** 谁拿着播放器：'' | 'fab'（右下角）| 'achievement'（成就页）。空串 = 没有实例 */
    owner: '',
    /** 实例建好了没（没建好的时候按钮要 disabled，不然点了没反应像坏了） */
    ready: false,
    index: 0,
    playing: false,
    time: 0,
    duration: 0,
    error: '',
    /** 出错的那个地址。光说"放不出来"用户没法自己查，得把地址亮出来 */
    errorUrl: '',
    /** 播放模式：list 顺序 / random 随机 / single 单曲循环（和 APlayer 的 mode 一致） */
    mode: 'list',
    /** 歌词：'idle' 还没取 | 'loading' | 'ready' | 'none' 这首没有 | 'error' 取不到 */
    lyricStatus: 'idle',
    lyricLines: [],
    lyricSynced: false,
    lyricTitle: '',
    lyricArtist: '',
    lyricError: '',
  }),

  getters: {
    /** 播放列表来自设置，解析是纯函数（core/music.js 的 parseTracks） */
    tracks: () => useQuizStore().myMusic.tracks,
    hasTracks() {
      return this.tracks.length > 0
    },
    current() {
      return this.tracks[this.index] || null
    },
    cover() {
      return this.current?.cover || ''
    },
    /** 0~1，进度条宽度直接用 */
    progress: (state) => (state.duration > 0 ? Math.min(1, state.time / state.duration) : 0),
    timeText: (state) => formatClock(state.time),
    durationText: (state) => formatClock(state.duration),
    /** 现在唱到第几句（-1 = 还没到第一句；播放页靠它高亮 + 自动滚动） */
    lyricActive: (state) => activeLineIndex(state.lyricLines, state.time),
    hasLyrics() {
      return this.lyricLines.length > 0
    },
  },

  actions: {
    /* ═══════════════════════ 挂载 / 卸载 ═══════════════════════ */

    /**
     * 把播放器挂到 `el` 上（会接管：原来挂在别处的实例先销毁）。
     *
     * @param {HTMLElement} el  容器（必须是"已经排在页面上"的元素，见文件头）
     * @param {string} tag      谁挂的：'fab' | 'achievement'
     */
    async attach(el, tag = 'fab') {
      if (!el) return
      const run = () => this._mount(el, tag)
      const job = chain.then(run, run)
      // 链条不能因为一次失败就断掉（否则以后所有 attach 都不执行了）
      chain = job.then(
        () => {},
        () => {},
      )
      return job
    },

    /** 真正干活的那个（不要在组件里直接调，用 attach） */
    async _mount(el, tag) {
      const quiz = useQuizStore()
      const audio = quiz.myMusic.tracks.map(toAudio)

      // 已经挂在这个容器上：只更新归属，别白重建一次（会打断正在放的歌）
      if (hostEl === el && ap) {
        this.owner = tag
        return
      }

      /*
       * 换容器前先记住"听到哪了"。两个来源，按可信度取：
       *   ① 当前 state（真的在放的时候它最准）
       *   ② handover —— release() 交还时存下的那份（因为 detach 会把 state 清零，
       *      成就页关掉后右下角接手时只能靠它，见 handover 的注释）
       * 取完就清，免得留到下一次无关的 attach 上（比如用户关了音乐又打开）。
       */
      const snap = { index: this.index, time: this.time, playing: this.playing }
      const live = snap.playing || snap.time > 0 || snap.index > 0 ? snap : null
      const resume = live || handover || { index: 0, time: 0, playing: false }
      handover = null

      if (!audio.length) {
        this.detach()
        return
      }

      this.detach()
      // ★ 先占位再 await：见 token 的注释。owner 非空期间别的界面不会来抢
      this.owner = tag
      const my = ++token

      // 动态 import：APlayer 是 UMD 包（package.json 只有 main、没有 module），
      // 静态 import 会把它连同 CSS 一起塞进主包，让"不配音乐"的人也跟着下 70KB。
      const [{ default: APlayer }] = await Promise.all([
        import('aplayer'),
        import('aplayer/dist/APlayer.min.css'),
      ])

      // ① 已经被更新的请求取代 ② 等 import 的工夫组件被卸载了
      // —— 两种都别往一个不再需要的元素里塞播放器
      if (my !== token || !el.isConnected) return

      ap = new APlayer({
        container: el,
        audio,
        listFolded: true, // 列表默认收起：面板本来就小，展开会顶出屏幕
        listMaxHeight: '176px',
        volume: Number(quiz.settings.musicVolume ?? 0.8),
        theme: '#6366f1',
        // 3 = 歌词给的是**文件地址**（1 是字符串，2 是元素）。
        // ⚠️ 只有真的有歌带 lrc 才给这个选项：给了它 APlayer 就会加上
        // `aplayer-withlrc` 类，把歌词区撑成一条 30px 的空白（一首都没歌词时
        // 那条空白很显眼）。没歌词的曲库干脆不要这个类。
        lrcType: audio.some((a) => a.lrc) ? 3 : undefined,
        autoplay: false, // 见文件头：突然出声很烦人，也可能被浏览器拦掉
        mutex: true, // 同一页面里别的 audio 让它闭嘴
        storageName: 'q-player', // 别和 APlayer 自己的默认键打架
        preload: 'none', // 没点播放就不下载音频（答题站没必要偷跑流量）
      })
      hostEl = el
      this.owner = tag
      this.ready = true
      this.error = ''

      this.index = Math.min(Math.max(0, resume.index), audio.length - 1)
      if (this.index > 0) ap.switchAudio(this.index)

      resumeAt = resume.playing && resume.time > 0 ? resume.time : null
      this.time = 0
      this.duration = 0

      this._bind()
      this.applyVolume()
      this.bindMedia()
      this.syncMedia()
      if (this.mode !== 'list') this.setMode(this.mode)
      this.loadLyrics()
      if (resume.playing) ap.play()
    },

    /**
     * 播放列表变了就重建（设置里改一行就生效）。
     * 只重建，不管挂载位置 —— 谁拿着还是谁拿着。
     *
     * @param {string} tag 传了就只在自己持有播放器时才重建。
     *   右下角面板和成就页**都**在 watch 播放列表，不设这道闸会一连重建两次，
     *   第二次白拆一次正在放的歌。
     */
    async rebuild(tag = '') {
      if (tag && this.owner !== tag) return
      if (!this.hasTracks) {
        this.detach()
        return
      }
      if (!hostEl) return
      const el = hostEl
      await this.attach(el, this.owner || 'fab')
    },

    /** 卸载。`release(tag)` 只在自己还拿着的时候才卸（防止把别人的实例拆了） */
    detach() {
      if (ap) {
        try {
          ap.destroy()
        } catch {
          /* 销毁失败也不该挡住换容器 */
        }
      }
      /*
       * ⚠️ APlayer 的 destroy() **只清内容，不摘自己加在容器上的类**
       * （`aplayer` / `aplayer-withlrc` … 是它 constructor 里加到容器本身的）。
       * 不手动摘掉的话：换到成就页之后，右下角那个已经空了的 div 仍然带着
       * `aplayer` 类 —— 会被 APlayer 的样式表当成一个播放器画出来（一个空壳），
       * 而且"页面上有几个播放器"这种判断也会数错。
       */
      if (hostEl) {
        hostEl.className = hostEl.className
          .split(/\s+/)
          .filter((c) => c && !c.startsWith('aplayer'))
          .join(' ')
      }
      ap = null
      hostEl = null
      resumeAt = null
      this.owner = ''
      this.ready = false
      this.playing = false
      this.time = 0
      this.duration = 0
      this.error = ''
      this.errorUrl = ''
      this.lyricStatus = 'idle'
      this.lyricLines = []
      this.lyricSynced = false
      this.clearMedia()
    },

    release(tag) {
      if (this.owner !== tag) return
      // 交还前把"听到哪了"留给下一个容器（否则 detach 一清零，歌就从头开始了）
      handover = { index: this.index, time: this.time, playing: this.playing }
      this.detach()
    },

    /* ═══════════════════════ 事件 → 状态 ═══════════════════════ */

    _bind() {
      if (!ap) return
      ap.on('play', () => {
        this.playing = true
        this.error = ''
        this.errorUrl = ''
        this.syncMedia()
      })
      ap.on('pause', () => {
        this.playing = false
        this.syncMedia()
      })
      ap.on('ended', () => {
        this.playing = false
        this.syncMedia()
      })
      ap.on('timeupdate', () => this.readClock())
      ap.on('loadedmetadata', () => this.readClock())
      ap.on('canplay', () => {
        this.applyResume()
        this.readClock()
      })
      // payload 是 { index }（见 APlayer 里 list.switch 的实现）。
      // 用 typeof 兜一下：切列表时它也会触发，那时 index 可能是 undefined。
      // ★ 只注册**一个** listswitch：切歌要同时做三件事 —— 记住新下标、更新系统媒体面板、
      //   换歌词。拆成两个 handler 也能跑，但"同一个事件两处处理"以后必然漏一处。
      ap.on('listswitch', (payload) => {
        const i = payload?.index
        if (typeof i === 'number') this.index = i
        this.error = ''
        this.errorUrl = ''
        this.syncMedia()
        this.loadLyrics()
      })
      ap.on('volumechange', () => this.pullVolume())
      ap.on('error', () => {
        const el = ap?.audio
        this.errorUrl = String(el?.currentSrc || el?.src || this.current?.url || '')
        this.error = '这首歌放不出来'
      })
    },

    /** 从引擎读回时间。duration 在元数据到达前是 NaN，别往 state 里塞 NaN */
    readClock() {
      const el = ap?.audio
      if (!el) return
      const t = Number(el.currentTime)
      const d = Number(el.duration)
      if (Number.isFinite(t)) this.time = t
      if (Number.isFinite(d) && d > 0) this.duration = d
    },

    /** 能播了才 seek（见文件头 c 条） */
    applyResume() {
      if (resumeAt == null || !ap) return
      if (!Number.isFinite(Number(ap.audio?.duration))) return
      const at = resumeAt
      resumeAt = null
      ap.seek(at)
      this.readClock()
    },

    /* ═══════════════════════ 遥控（两个界面都调这些） ═══════════════════════ */

    toggle(force) {
      if (!ap) return
      const want = force === undefined ? !this.playing : !!force
      if (want) ap.play()
      else ap.pause()
    },

    /** 上一首 / 下一首（APlayer 的 skipBack / skipForward 是切歌，不是快退快进） */
    next() {
      if (ap) ap.skipForward()
    },
    prev() {
      if (ap) ap.skipBack()
    },

    /** 从列表里放第 i 首（成就页的曲目列表点一下就调它） */
    playAt(i) {
      if (!ap) return
      const n = Number(i)
      if (!Number.isFinite(n) || !this.tracks[n]) return
      if (n === ap.list?.index) {
        this.toggle(true) // 点的就是当前这首 → 当播放键用
        return
      }
      ap.switchAudio(n)
      ap.play()
    },

    seek(seconds) {
      if (!ap) return
      const d = Number(ap.audio?.duration)
      if (!Number.isFinite(d) || d <= 0) return
      const at = Math.min(Math.max(0, Number(seconds) || 0), d)
      ap.seek(at)
      this.readClock()
      this.syncMedia()
    },

    /** 进度条点击：传 0~1 的比例（比像素好传，也不用在这里知道条有多宽） */
    seekRatio(ratio) {
      if (this.duration <= 0) return
      const r = Math.min(1, Math.max(0, Number(ratio) || 0))
      this.seek(r * this.duration)
    },

    /* ═══════════════════════ 音量（和设置双向同步） ═══════════════════════ */

    applyVolume() {
      if (!ap) return
      const v = Number(useQuizStore().settings.musicVolume ?? 0.8)
      // 第二个参数 nostore=true：音量以**我们的设置**为准，
      // 不让 APlayer 自己那份 localStorage 记录反过来盖掉设置
      ap.volume(Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8, true)
    },

    /** 设置面板的音量滑杆走这里（写设置 + 立刻作用于引擎） */
    setVolume(value) {
      const v = Math.min(1, Math.max(0, Number(value) || 0))
      useQuizStore().setSetting('musicVolume', v)
      this.applyVolume()
    },

    /** 用户在 APlayer 自己的音量条上拖了 → 回写设置，下次开还是这个音量 */
    pullVolume() {
      const v = Number(ap?.audio?.volume)
      if (!Number.isFinite(v)) return
      const quiz = useQuizStore()
      const cur = Number(quiz.settings.musicVolume ?? 0)
      // 容差：拖一次会连续触发几十回，没必要次次写 localStorage
      if (Math.abs(cur - v) < 0.01) return
      quiz.setSetting('musicVolume', v)
    },

    /* ═══════════════════════ 歌词 ═══════════════════════ */

    /**
     * 取当前这首歌的歌词。
     *
     * 歌词来源只有一个：曲库里那一段 `名字 | 地址 | 封面 | 歌词` 的**歌词字段**。
     * 它可以是
     *   · http(s) 的 .lrc 地址 —— 需要对方允许跨域（我们自己 public/ 下的文件天然满足）
     *   · 我们站点内的相对路径（以 `./` 开头）—— 演示曲目用这种
     * 取不到就老实显示"这首歌没有歌词"，**绝不编**（歌词编错了比没有更糟）。
     */
    async loadLyrics() {
      const track = this.current
      const src = String(track?.lrc || '').trim()
      this.lyricLines = []
      this.lyricSynced = false
      this.lyricTitle = ''
      this.lyricArtist = ''
      this.lyricError = ''
      if (!src) {
        this.lyricStatus = 'none'
        return
      }
      this.lyricStatus = 'loading'
      const token = ++lyricToken
      try {
        const res = await fetch(src, { credentials: 'omit' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const text = await res.text()
        if (token !== lyricToken) return // 取的过程中切歌了 → 丢掉这批
        const parsed = parseLrc(text)
        this.lyricLines = parsed.lines
        this.lyricSynced = parsed.synced
        this.lyricTitle = String(parsed.meta.ti || '')
        this.lyricArtist = String(parsed.meta.ar || '')
        this.lyricStatus = parsed.lines.length ? 'ready' : 'none'
      } catch (err) {
        if (token !== lyricToken) return
        this.lyricStatus = 'error'
        // 跨域是最常见的原因，提示里要点出来（用户自己看不出"被 CORS 拦了"）
        this.lyricError = String(err?.message || err)
      }
    },

    /* ═══════════════════════ 播放模式 ═══════════════════════ */

    setMode(mode) {
      const allowed = ['list', 'random', 'single']
      const next = allowed.includes(mode) ? mode : 'list'
      this.mode = next
      if (ap && typeof ap.setMode === 'function') ap.setMode(next)
    },

    cycleMode() {
      const order = ['list', 'random', 'single']
      this.setMode(order[(order.indexOf(this.mode) + 1) % order.length])
      return this.mode
    },

    /* ═══════════════════════ 系统媒体面板（媒体键 / 锁屏） ═══════════════════════ */

    /**
     * 把当前这首歌告诉操作系统 —— 耳机按键、键盘媒体键、锁屏/通知中心上的
     * "正在播放"都靠它。没有这一步，系统面板上是一片空白，媒体键也只会
     * 去控制"最后一个 <audio>"（可能是答题音效那个）。
     */
    syncMedia() {
      const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : null
      if (!ms) return
      const track = this.current
      if (!track) return
      try {
        // MediaMetadata 是浏览器类，Node 里没有 —— 所以拼字段的活儿放在
        // core/music.js 的 mediaInfo（纯函数，有单测）
        if (typeof MediaMetadata === 'function') ms.metadata = new MediaMetadata(mediaInfo(track))
        ms.playbackState = this.playing ? 'playing' : 'paused'
        if (this.duration > 0 && typeof ms.setPositionState === 'function') {
          ms.setPositionState({
            duration: this.duration,
            position: Math.min(this.time, this.duration),
            playbackRate: 1,
          })
        }
      } catch {
        /* 系统媒体面板是加分项：任何浏览器差异都不该影响播放本身 */
      }
    },

    /** 注册媒体键回调。每个动作单独 try —— 旧浏览器不认 seekto 之类会抛 */
    bindMedia() {
      const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : null
      if (!ms || typeof ms.setActionHandler !== 'function') return
      const set = (action, fn) => {
        try {
          ms.setActionHandler(action, fn)
        } catch {
          /* 这个动作当前浏览器不支持，忽略 */
        }
      }
      set('play', () => this.toggle(true))
      set('pause', () => this.toggle(false))
      set('previoustrack', () => this.prev())
      set('nexttrack', () => this.next())
      set('seekto', (d) => {
        if (d && Number.isFinite(d.seekTime)) this.seek(d.seekTime)
      })
      set('seekbackward', (d) => this.seek(this.time - (d?.seekOffset || 10)))
      set('seekforward', (d) => this.seek(this.time + (d?.seekOffset || 10)))
    },

    /** 卸掉媒体键回调 —— 否则关掉播放器后按键还在控制一个不存在的音源 */
    clearMedia() {
      const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : null
      if (!ms) return
      for (const action of ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto', 'seekbackward', 'seekforward']) {
        try {
          ms.setActionHandler(action, null)
        } catch {
          /* 不支持就本来没注册上 */
        }
      }
      try {
        ms.metadata = null
        ms.playbackState = 'none'
      } catch {
        /* 同上 */
      }
    },
  },
})
