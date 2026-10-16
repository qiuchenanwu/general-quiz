import { defineStore } from 'pinia'
import { normalizeBank } from '@/core/normalize'
import { K, load, save, remove } from '@/core/storage'

/**
 * 内置题库分两层（2026-10-09 改，起因见 HANDOFF「懒加载大题库」）：
 *
 *   src/banks/*.json       小题库 → **构建时打进来**（eager），丢一个 JSON 就自动上架
 *   src/banks/big/*.json   大题库 → 只打成**独立 chunk**，打开时才 `import()`
 *
 * 为什么分：题库原来全量进主包，2026-10-09 实测主包 1921KB（gzip 550KB），
 * 其中题库占 820KB —— **只想要毛概的人也得下那 478KB 的 Vue 题库**。
 *
 * 大题库的"卡片信息"（标题/题量/许可）从 `big/index.json` 读，那份清单由
 * `quiz/tools/make_bank_index.mjs` **生成**（手写会飘），并由引擎断言守着不飘。
 *
 * 三个 glob 都包在 try/catch 里：`import.meta.glob` 是 Vite 的**编译期**语法，
 * 纯 Node（跑 tests/test_engine.mjs）下不存在 —— 单测会自己往 store 里塞题库。
 */
let RAW_BANKS = {} // 小题库：路径 → 已解析的 JSON 对象
let BIG_LOADERS = {} // 大题库：路径 → () => Promise<模块>
let BIG_INDEX = [] // 大题库清单（生成物）
try {
  RAW_BANKS = import.meta.glob('../banks/*.json', { eager: true, import: 'default' })
  BIG_LOADERS = import.meta.glob('../banks/big/*.json', { import: 'default' })
  const idx = import.meta.glob('../banks/big/index.json', { eager: true, import: 'default' })
  BIG_INDEX = idx['../banks/big/index.json'] || []
} catch {
  /* 非 Vite 环境：没有内置清单，由调用方提供数据 */
}

/** 归一化一遍所有内置题库，结果缓存下来（只做一次） */
let builtinCache = null
function builtins() {
  if (builtinCache) return builtinCache
  const list = []
  for (const [path, json] of Object.entries(RAW_BANKS)) {
    const file = path.split('/').pop()
    if (file === 'index.json' || file === 'embedded.js') continue // 旧版清单，忽略
    try {
      const bank = normalizeBank(json, file.replace(/\.json$/i, ''))
      list.push({
        id: bank.meta.id,
        file,
        title: bank.meta.title,
        subject: bank.meta.subject,
        description: bank.meta.description,
        total: bank.meta.total,
        counts: bank.meta.counts,
        bank, // 已经归一化好的，打开时直接用，不重复解析
      })
    } catch (e) {
      // 坏题库不该拖垮整个首页
      console.warn(`[quiz] 内置题库 ${file} 解析失败，已跳过：${e.message}`)
    }
  }

  // 大题库：只有卡片（清单是生成物），正文等打开时再下载
  for (const card of BIG_INDEX) {
    if (!card || !card.file) continue
    list.push({
      id: card.id,
      file: card.file,
      title: card.title,
      subject: card.subject,
      description: card.description,
      total: card.total,
      counts: card.counts,
      lazy: true, // ← openEntry 看到这个就知道要走 import()
    })
  }

  // 题多的排前面（主题库通常在第一个）
  list.sort((a, b) => b.total - a.total)
  builtinCache = list
  return list
}

export const useBankStore = defineStore('bank', {
  state: () => ({
    manifest: [], // 内置题库清单
    custom: [], // 用户导入的题库（存在 localStorage）
    current: null, // { meta, questions, issues, origin }
    loading: false,
    error: '',
    /** App 启动时的「恢复上次题库」是否已完成——页面用它区分「还在加载」和「真的没有题库」 */
    booted: false,
  }),

  getters: {
    /** 首页要展示的全部题库（内置 + 导入） */
    entries(state) {
      const seen = new Set()
      const out = []
      state.manifest.forEach((m) => {
        if (seen.has(m.id)) return
        seen.add(m.id)
        out.push({ ...m, kind: 'builtin' })
      })
      state.custom.forEach((c) => {
        if (seen.has(c.id)) return
        seen.add(c.id)
        out.push({
          id: c.id,
          title: c.meta?.title || c.id,
          subject: c.meta?.subject || '',
          description: c.meta?.description || '',
          total: c.meta?.total || c.questions?.length || 0,
          counts: c.meta?.counts,
          savedAt: c.savedAt,
          kind: 'custom',
        })
      })
      return out
    },

    hasBank: (state) => !!state.current && state.current.questions.length > 0,
    questions: (state) => state.current?.questions || [],
    meta: (state) => state.current?.meta || null,

    /** id → question，答题卡和错题本到处都要用 */
    byId: (state) => {
      const m = new Map()
      ;(state.current?.questions || []).forEach((q) => m.set(q.id, q))
      return m
    },
  },

  actions: {
    /* ----------------------------- 题库清单 ----------------------------- */
    loadManifest() {
      this.manifest = builtins().map(({ bank, ...rest }) => rest)
    },

    loadCustom() {
      const list = load(K.customBanks, [])
      this.custom = Array.isArray(list) ? list : []
    },

    /* ------------------------------- 打开题库 ------------------------------- */
    /**
     * 打开一套内置题库。
     *
     * ⚠️ **这是 async 的**：大题库（`banks/big/`）正文不在主包里，要等它下载完。
     * 调用方必须 `await`（App.vue 的启动恢复、HomeView 的「选这套」都已经 await 了）。
     */
    async openEntry(entry) {
      if (entry.kind === 'custom') {
        const found = this.custom.find((c) => c.id === entry.id)
        if (!found) throw new Error('这个题库已经不在本地存储里了，请重新导入')
        this.applyBank(found, 'custom')
        save(K.lastBank, found.id)
        return this.current
      }

      // 内置题库：小题库直接从构建期打进来的模块里取，零网络请求
      const hit = builtins().find((b) => b.id === entry.id || b.file === entry.file)
      if (hit && !hit.lazy && hit.bank) {
        const b = hit.bank
        this.applyBank({ meta: b.meta, questions: b.questions, issues: b.issues }, 'builtin')
        save(K.lastBank, b.meta.id)
        return this.current
      }

      // 大题库：这时才下载它的 chunk（首页只加载过卡片）
      if (hit && hit.lazy) {
        this.loading = true
        this.error = ''
        try {
          const load = BIG_LOADERS[`../banks/big/${hit.file}`]
          if (!load) throw new Error(`找不到大题库的加载入口：${hit.file}`)
          const mod = await load()
          const bank = normalizeBank(mod?.default ?? mod, hit.file.replace(/\.json$/i, ''))
          // 下载过一次就把它塞回缓存：再打开是零延迟的
          hit.bank = bank
          hit.lazy = false
          hit.counts = bank.meta.counts
          this.applyBank({ meta: bank.meta, questions: bank.questions, issues: bank.issues }, 'builtin')
          save(K.lastBank, bank.meta.id)
          return this.current
        } catch (e) {
          this.error = e.message || String(e)
          throw e
        } finally {
          this.loading = false
        }
      }

      // 清单里写的是 URL / 相对路径 → 退回到 fetch（需要 http，file:// 下会被 CORS 拦）
      if (entry.file) return this.openUrl(entry.file, entry)
      throw new Error(`找不到题库：${entry.title || entry.id}`)
    },

    async openUrl(url, entry = {}) {
      this.loading = true
      this.error = ''
      try {
        const res = await fetch(url, { cache: 'no-cache' })
        if (!res.ok) throw new Error(`下载题库失败：HTTP ${res.status}`)
        const text = await res.text()
        let json
        try {
          json = JSON.parse(text)
        } catch {
          throw new Error('这不是合法的 JSON 文件（可能下载到的是 HTML 错误页）')
        }
        const bank = normalizeBank(json, entry.title || url.split('/').pop())
        this.applyBank({ meta: bank.meta, questions: bank.questions, issues: bank.issues }, 'remote')
        save(K.lastBank, bank.meta.id)
        return this.current
      } catch (e) {
        this.error = e.message || String(e)
        throw e
      } finally {
        this.loading = false
      }
    },

    /** 读取用户拖进来 / 选中的本地 JSON 文件 */
    async openFile(file) {
      this.loading = true
      this.error = ''
      try {
        const text = await file.text()
        let json
        try {
          json = JSON.parse(text)
        } catch {
          throw new Error(`「${file.name}」不是合法的 JSON 文件`)
        }
        return this.importJson(json, file.name.replace(/\.json$/i, ''), { persist: true })
      } catch (e) {
        this.error = e.message || String(e)
        throw e
      } finally {
        this.loading = false
      }
    },

    /** 归一化 + 落到 localStorage + 切为当前题库 */
    importJson(json, fallbackName = '导入的题库', { persist = true } = {}) {
      const bank = normalizeBank(json, fallbackName)
      const record = {
        id: bank.meta.id,
        meta: bank.meta,
        questions: bank.questions,
        issues: bank.issues,
        savedAt: Date.now(),
      }

      if (persist) {
        // 同 id 覆盖
        const list = this.custom.filter((c) => c.id !== record.id)
        list.unshift(record)
        const r = save(K.customBanks, list)
        if (r.ok) {
          this.custom = list
        } else if (r.reason === 'quota') {
          // 存不下就只在内存里用，别拦住用户刷题
          record.persistWarning = '题库太大，本地存储放不下，刷新后会丢（本次仍可正常刷题）'
          this.custom = [record, ...this.custom.filter((c) => c.id !== record.id)]
        }
      } else {
        this.custom = [record, ...this.custom.filter((c) => c.id !== record.id)]
      }

      this.applyBank(record, 'custom')
      save(K.lastBank, record.id)
      return this.current
    },

    applyBank(record, origin) {
      this.current = {
        meta: record.meta,
        questions: record.questions,
        issues: record.issues || [],
        persistWarning: record.persistWarning || '',
        origin,
      }
    },

    removeCustom(id) {
      this.custom = this.custom.filter((c) => c.id !== id)
      save(K.customBanks, this.custom)
      if (this.current?.meta?.id === id) this.current = null
    },

    /**
     * 刷新后自动回到上次的题库。
     *
     * ⚠️ 也是 async：上次那套可能正好是**大题库**（要下载 chunk）。
     * 这里用 `.catch` 而不是 try/catch —— `openEntry` 现在返回 Promise，
     * 抛出的错误会变成 rejection，同步的 try 抓不到（会变成"未处理的 rejection"）。
     */
    async restoreLast() {
      const lastId = load(K.lastBank)
      if (!lastId) return null
      this.loadCustom()

      const mine = this.custom.find((c) => c.id === lastId)
      if (mine) {
        this.applyBank(mine, 'custom')
        return this.current
      }

      const entry = this.manifest.find((m) => m.id === lastId)
      if (entry) {
        try {
          return await this.openEntry({ ...entry, kind: 'builtin' })
        } catch {
          // 题库没了（或 chunk 下载失败）：清掉"上次的题库"，别让每次启动都白试一次
          remove(K.lastBank)
        }
      }
      return null
    },
  },
})
