/**
 * feedback.js —— 答题音效（WebAudio 实时合成，仓库里没有任何音频文件）
 *
 * 为什么不用 mp3：
 *   1. 构建产物不增大，也不用管素材授权；
 *   2. 音高能跟着「连对」次数往上爬 —— 音频文件做不到这件事。
 *
 * 两个必须处理的浏览器限制：
 *   · AudioContext 必须在**用户手势**里才能启动，所以 installAudioUnlock()
 *     会在第一次点击/按键时把上下文唤醒，之后再答题就都有声音；
 *   · resume() 是异步的，第一次发声往往赶不上，所以 playSfx() 会在 resume
 *     完成后补播一次（带递归保护）。
 */

/** 所有音效名，设置面板的试听按钮也照着这个列表来 */
export const SFX_NAMES = ['click', 'correct', 'wrong', 'star', 'finish', 'tick']

let ctx = null
let master = null
let unlocked = false
let retrying = false

const state = { enabled: true, volume: 0.5 }

/** 由 store 调用：把「开关 / 音量」同步进来。Node 环境下调用也无害。 */
export function configureSound({ enabled, volume } = {}) {
  if (typeof enabled === 'boolean') state.enabled = enabled
  if (typeof volume === 'number') state.volume = Math.min(1, Math.max(0, volume))
  if (master) master.gain.value = state.volume
}

function ensureCtx() {
  if (ctx) return ctx
  if (typeof window === 'undefined') return null
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return null
  try {
    ctx = new AC()
    master = ctx.createGain()
    master.gain.value = state.volume
    master.connect(ctx.destination)
  } catch {
    ctx = null
  }
  return ctx
}

/** 唤醒音频上下文（要放在用户手势里调用） */
export function unlockAudio() {
  const ac = ensureCtx()
  if (!ac) return
  if (ac.state === 'suspended') ac.resume().catch(() => {})
  if (unlocked) return
  unlocked = true
  try {
    // iOS/Safari 的经典套路：放一个 1 帧的静音 buffer 才算真正解锁
    const src = ac.createBufferSource()
    src.buffer = ac.createBuffer(1, 1, 22050)
    src.connect(ac.destination)
    src.start(0)
  } catch {
    /* 有些环境不认这套，忽略即可 */
  }
}

/** 一次性挂上解锁监听：用户第一次点屏幕/敲键盘就把音频唤醒 */
export function installAudioUnlock(target) {
  const el = target || (typeof document !== 'undefined' ? document : null)
  if (!el) return
  const on = () => {
    unlockAudio()
    el.removeEventListener('pointerdown', on)
    el.removeEventListener('keydown', on)
    el.removeEventListener('touchstart', on)
  }
  el.addEventListener('pointerdown', on, { passive: true })
  el.addEventListener('keydown', on)
  el.addEventListener('touchstart', on, { passive: true })
}

/* ------------------------------------------------------------------ */
/* 合成器                                                              */
/* ------------------------------------------------------------------ */

/**
 * 一个「拨弦」音：基音 + 一个弱的高八度泛音，快速起音后指数衰减。
 * 比单纯的 sine 有质感，又不会像方波那样刺耳。
 */
function pluck(freq, at, dur, gain = 1, type = 'triangle') {
  const ac = ctx
  if (!ac) return
  const env = ac.createGain()
  const peak = Math.min(0.34, 0.16 * gain)
  env.gain.setValueAtTime(0.0001, at)
  env.gain.exponentialRampToValueAtTime(peak, at + 0.008)
  env.gain.exponentialRampToValueAtTime(0.0001, at + dur)
  env.connect(master)

  const partials = [
    [1, 1, 0],
    [2, 0.16, 6], // 轻微失谐的高八度 → 更"亮"
  ]
  for (const [mult, level, detune] of partials) {
    const osc = ac.createOscillator()
    osc.type = type
    osc.frequency.value = freq * mult
    osc.detune.value = detune
    const og = ac.createGain()
    og.gain.value = level
    osc.connect(og).connect(env)
    osc.start(at)
    osc.stop(at + dur + 0.03)
  }
}

const RECIPES = {
  /** 选中选项 / 切页：很轻的一下，几乎只是"手感" */
  click: (t) => pluck(1180, t, 0.05, 0.45),

  /** 答对：G5 → C6（纯四度上行，听着"完成"） */
  correct: (t) => {
    pluck(784, t, 0.16, 1)
    pluck(1046.5, t + 0.075, 0.24, 0.9)
  },

  /** 答错：下行两音，音区比答对低，用 sine 让它"软"一点而不是刺耳 */
  wrong: (t) => {
    pluck(311, t, 0.18, 0.9, 'sine')
    pluck(233, t + 0.1, 0.3, 0.8, 'sine')
  },

  /** 收藏：清脆的高音 ping */
  star: (t) => {
    pluck(1568, t, 0.1, 0.7)
    pluck(2093, t + 0.06, 0.16, 0.4)
  },

  /** 练习完成 / 交卷：C-E-G-C 上行琶音 */
  finish: (t) => {
    ;[523.25, 659.25, 783.99, 1046.5].forEach((f, i) => pluck(f, t + i * 0.09, 0.3, 0.8))
  },

  /** 考试最后几秒的滴答（很轻，别吓人） */
  tick: (t) => pluck(1320, t, 0.055, 0.3, 'square'),
}

/**
 * 播一个音效。
 * @param {string} name SFX_NAMES 之一
 * @param {{combo?: number}} opt combo = 当前连对次数，会额外加一个音高递增的音
 */
export function playSfx(name, opt = {}) {
  if (!state.enabled || state.volume <= 0) return
  const ac = ensureCtx()
  if (!ac) return

  // 还没解锁：resume 完成后补播一次（只补一次，避免无限递归）
  if (ac.state === 'suspended') {
    if (retrying) return
    retrying = true
    ac.resume()
      .then(() => {
        retrying = false
        playSfx(name, opt)
      })
      .catch(() => {
        retrying = false
      })
    return
  }

  const t = ac.currentTime + 0.012
  try {
    if (name === 'correct') {
      RECIPES.correct(t)
      // 连对 ≥ 3 再加一个音，音高随连对数往上爬（最多爬 7 个半音，别太尖）
      const combo = opt.combo || 0
      if (combo >= 3) {
        const step = Math.min(combo - 2, 7)
        pluck(1046.5 * Math.pow(2, step / 12), t + 0.16, 0.3, 0.7)
      }
    } else {
      const fn = RECIPES[name]
      if (fn) fn(t)
    }
  } catch {
    /* 音频出错绝不能影响答题 */
  }
}

/** 设置面板的「试听」：无视开关（用户是主动点的），并顺手解锁上下文 */
export function previewSfx(name) {
  unlockAudio()
  const wasEnabled = state.enabled
  state.enabled = true
  playSfx(name, { combo: 3 }) // 带上连对，方便听出第三个音
  state.enabled = wasEnabled
}
