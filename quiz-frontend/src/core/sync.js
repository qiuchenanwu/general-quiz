/**
 * sync.js —— 把本机进度和账号里那份对起来。
 *
 * 三条规则（都是踩过坑之后定的，别照"更省事"的写法改）：
 *
 *   ① **推上去的那份和拉回来的是同一个动作**：`POST /state/save/` 传本机这份，
 *      服务端**合并**（不是覆盖）之后把全量还回来。所以不存在"先拉还是先推"的时序问题
 *      —— 这也是为什么合并规则必须写在服务端（见 qstate.py），而不是前端猜。
 *
 *   ② **登录/换题库时应用返回值，平时推送不应用**。推送返回的合并结果可能是
 *      "一两秒前"的快照；那时学生可能刚点了下一题，拿它覆盖会把那一下抹掉。
 *      服务端反正已经收下并合并了，本机的改动会在下一次推送里带上。
 *
 *   ③ **推送是防抖的、失败了也不弹红**：同步是后台动作，断网时不该每答一题弹一次错。
 *      真正的失败会在下次登录/切题库时说清楚（`sync.error`）。
 *
 * 未登录 / 后端不可用 ⇒ 这个模块什么都不做，进度照旧只存本机。
 */

import { ElMessage } from 'element-plus'
import { reactive } from 'vue'
import * as api from './api'
import { auth } from './auth'
import { collectState, conflictNote } from './state'

export const sync = reactive({
  /** 当前正在同步哪套题库 */
  bank: '',
  /** 这套题库"本机 ↔ 账号"已经对齐过了（没对齐之前不许推，否则空进度会盖掉账号那份） */
  ready: false,
  syncing: false,
  /** 有改动还没推上去（界面上显示"同步中…"用） */
  pending: false,
  lastAt: 0,
  error: '',
})

/** 答一题到推上去之间的延迟：太短会一路推、太长"换设备前刚做的题"可能没带上 */
const PUSH_DELAY = 1500
let timer = 0

function canPush(store) {
  return !!(auth.user && store?.bankId && sync.ready && sync.bank === store.bankId)
}

/** 会话结束（登出）时叫一下：停掉待推的定时器，别让它在登出后再发一次 */
export function stopSync() {
  clearTimeout(timer)
  sync.ready = false
  sync.pending = false
}

function handleError(error, { quiet }) {
  sync.error = error?.message || '同步失败'
  // 401 = 会话过期（服务端重启过、或 cookie 到期）：把本地登录态也收回，
  // 免得界面一直显示"已登录"却什么都存不进去
  if (error?.status === 401) {
    stopSync()
    auth.user = null
  }
  if (!quiet) ElMessage.error(`进度同步失败：${sync.error}`)
}

/**
 * 对齐当前这套题库：把本机这份推上去，拿回合并后的全量并落到本机。
 *
 * @param {object} store useQuizStore() 实例
 * @param {{quiet?: boolean}} options quiet=true 时不弹提示（自动同步用）
 */
export async function syncBank(store, { quiet = true } = {}) {
  if (!auth.user || !store?.bankId) return null
  const bank = store.bankId
  sync.syncing = true
  sync.error = ''
  try {
    const response = await api.saveState({ bank, state: collectState(store) })
    // 合并结果落到内存 + localStorage：**两处都要**，只落内存的话刷新就回去了
    store.applyRemoteState(response.state)
    sync.bank = bank
    sync.ready = true
    sync.pending = false
    sync.lastAt = Date.now()
    const note = quiet ? '' : conflictNote(response.conflicts)
    if (note) ElMessage.warning(note)
    return response
  } catch (error) {
    handleError(error, { quiet })
    return null
  } finally {
    sync.syncing = false
  }
}

/**
 * 记一笔"本机变了"，稍后推上去。store 的每个 persist* 都会调它。
 * 未登录 / 还没对齐过 ⇒ 直接返回（未登录时这个函数的全部意义是"什么都不做"）。
 */
export function schedulePush(store) {
  if (!canPush(store)) return
  clearTimeout(timer)
  sync.pending = true
  timer = setTimeout(() => {
    pushNow(store)
  }, PUSH_DELAY)
}

/** 立刻推一次（不等防抖）。界面上的"手动同步"和"离开页面前"可调它 */
export async function pushNow(store) {
  sync.pending = false
  if (!canPush(store)) return null
  try {
    const response = await api.saveState({ bank: store.bankId, state: collectState(store) })
    sync.lastAt = Date.now()
    sync.error = ''
    // ⚠️ 这里**故意不** applyRemoteState（见文件头第 ②)
    return response
  } catch (error) {
    handleError(error, { quiet: true })
    return null
  }
}

/**
 * 把账号里这套题库的进度删掉（"重置进度"的另一半）。
 * 不做这件事的话，学生重置完进度、下次登录又会看到那些题回来。
 */
export async function resetRemoteState(store) {
  clearTimeout(timer)
  sync.pending = false
  if (!auth.user || !store?.bankId) return false
  try {
    await api.resetState({ bank: store.bankId })
    sync.bank = store.bankId
    sync.ready = true
    sync.lastAt = Date.now()
    return true
  } catch (error) {
    handleError(error, { quiet: true })
    return false
  }
}

/** 给界面用的一句话：现在同步到什么程度了 */
export function syncLabel() {
  if (!auth.user) return ''
  if (sync.error) return `同步出问题了：${sync.error}`
  if (sync.syncing) return '正在同步…'
  if (sync.pending) return '有改动待同步…'
  if (sync.lastAt) {
    const at = new Date(sync.lastAt)
    const pad = (n) => String(n).padStart(2, '0')
    return `进度已存到账号 · ${pad(at.getHours())}:${pad(at.getMinutes())}`
  }
  return '登录后进度会存到账号'
}
