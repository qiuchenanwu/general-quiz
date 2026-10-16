/**
 * auth.js —— 刷题站的登录态（注册 / 登录 / 登出 / 我是谁）。
 *
 * 为什么这么薄：认证是**服务端**的事（Django session + `/api/quiz/auth/*`）。
 * 前端只做三件事：记住"现在是谁"、把密码原样发过去、把中文错误显示出来。
 * 绝不在前端"判断密码对不对" —— 那种"前端校验"只是体验，不是边界。
 *
 * ⚠️ `auth` 是**模块级单例**（reactive 对象），不是 Pinia store。
 * 理由：`core/api.js`、`core/sync.js`、顶栏、登录页都要读它，
 * 而 Pinia store 得先 `setActivePinia` —— 在 `main.js` 之外（比如纯逻辑测试里）
 * 多一层时序依赖。这个对象没有任何需要 devtools 追踪的复杂状态。
 *
 * 未登录时的行为**必须和以前一模一样**：进度照常存本机、所有页面照常用。
 * 登录只多一件事 —— 进度跟着账号走（见 core/sync.js）。
 */

import { reactive } from 'vue'
import * as api from './api'

export const auth = reactive({
  /** 问过后端了没有（没问过之前不要显示"登录"按钮又突然变成昵称） */
  ready: false,
  /** 当前用户：null = 没登录。形状 { id, username, nickname } */
  user: null,
  /** 注册档位（后端说了算）：open / key / closed */
  signup: { mode: 'open', open: true, keyRequired: false, closed: false, note: '' },
  /** 正在提交（按钮转圈、防重复点） */
  busy: false,
})

/**
 * 用户名规则：2~30 个"字"，允许 `_ . @ + -`。
 *
 * ⚠️ 必须用 `\p{L}\p{N}`（Unicode 属性类）**不能**用 `\w`：
 * JS 里的 `\w` 是 **ASCII only** 的（加 `u` 标志也一样），
 * 写成 `/^[\w.@+-]{2,30}$/u` 会把「学生abc12」这种用户名判成非法 ——
 * 而后端 Python 的 `\w` 默认就是 Unicode，于是变成
 * **前端拦住、后端其实能过**的假失败（auth_check.py 第一次跑就是这么红的）。
 * 两边规则要对齐，这里以后端 accounts.USERNAME_RE 为准。
 */
export const USERNAME_RE = /^[\p{L}\p{N}_.@+-]{2,30}$/u
export const NICKNAME_MAX = 24
/** 和后端 settings.AUTH_PASSWORD_VALIDATORS 的 min_length 对齐（后端才是权威） */
export const PASSWORD_MIN = 8

export function isLoggedIn() {
  return !!auth.user
}

/**
 * 用户名校验。**只是本地体验**（别让人点提交才看到"不能有空格"），
 * 规则必须和后端 `accounts.USERNAME_RE` 一致；不一致时以后端为准。
 */
export function validateUsername(value) {
  const name = String(value ?? '').trim()
  if (!name) return '请填用户名'
  if (!USERNAME_RE.test(name)) {
    return '用户名要 2~30 位，只能用汉字、字母、数字和 _ . @ + -（不能有空格）'
  }
  return ''
}

export function validatePassword(value) {
  const pwd = String(value ?? '')
  if (!pwd) return '请填密码'
  if (pwd.length < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 位`
  if (/^\d+$/.test(pwd)) return '密码不能全是数字'
  return ''
}

export function validateNickname(value) {
  return String(value ?? '').trim().length > NICKNAME_MAX ? `昵称最多 ${NICKNAME_MAX} 个字` : ''
}

/**
 * 问一次"我是谁"。
 *
 * 连不上后端时（纯静态部署 / 断网）**当成没登录**，绝不抛出去 ——
 * 刷题站的整套设计是「有后端更好，没后端也能用」，登录不该破例。
 */
export async function loadMe() {
  try {
    const me = await api.authMe()
    auth.user = me?.authenticated ? me.user : null
    if (me?.signup) auth.signup = me.signup
  } catch {
    auth.user = null
  } finally {
    auth.ready = true
  }
  return auth.user
}

async function submit(fn) {
  auth.busy = true
  try {
    const result = await fn()
    auth.user = result?.user || null
    if (result?.signup) auth.signup = result.signup
    return auth.user
  } finally {
    auth.busy = false
  }
}

/** 登录。失败抛 ApiError（调用方把 `error.message` 显示出来就行，已经是中文） */
export function login(username, password) {
  return submit(() => api.authLogin({ username: String(username ?? '').trim(), password }))
}

export function register({ username, password, nickname = '', key = '' }) {
  return submit(() =>
    api.authRegister({
      username: String(username ?? '').trim(),
      password,
      nickname: String(nickname ?? '').trim(),
      key: String(key ?? '').trim(),
    }),
  )
}

/**
 * 登出。
 *
 * ⚠️ **不动本机进度**：谁会希望点一下"退出登录"就把错题本清空。
 * 服务端那份也留着，下次登录会合并回来（见 core/sync.js）。
 * 接口失败也要把本地登录态清掉 —— 前端还端着"已登录"而服务端已经不认，
 * 是比"没登出"更糟的状态。
 */
export async function logout() {
  try {
    await api.authLogout()
  } catch {
    /* 网络断了、会话早就过期了：照样登出 */
  }
  auth.user = null
}
