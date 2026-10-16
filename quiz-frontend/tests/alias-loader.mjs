/**
 * alias-loader.mjs —— 让 Node 也能理解 Vite 的 `@/` 别名。
 *
 * 源码里写的是 `import { x } from '@/core/normalize'`（Vite 的别名，前端常规写法），
 * 但 Node 原生不认。这里用 Node 22.15+ 的 module.registerHooks 把
 * `@/xxx` 映射成 `<frontend>/src/xxx`，这样纯 Node 的测试就能直接跑 store。
 *
 * 用法： node --import ./tests/alias-loader.mjs tests/test_engine.mjs
 */
import { registerHooks } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const srcUrl = pathToFileURL(path.join(here, '..', 'src') + path.sep).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    // 1) @/xxx → <frontend>/src/xxx
    let target = specifier
    if (specifier === '@' || specifier.startsWith('@/')) {
      const rest = specifier === '@' ? '' : specifier.slice(2)
      target = new URL(rest, srcUrl).href
    }

    try {
      return nextResolve(target, context)
    } catch (err) {
      // 2) 前端的 import 常省略扩展名（'./bank'、'@/core/normalize'），
      //    Node 要求写全，所以这里补 .js / /index.js 再试一次。
      //    裸包名（pinia、vue）保持原样往上抛，别乱补。
      const isLocal =
        target.startsWith('file:') || target.startsWith('.') || target.startsWith('/')
      if (!isLocal) throw err
      const base = target.startsWith('file:') ? target : new URL(target, context.parentURL).href
      for (const suffix of ['.js', '.mjs', '/index.js']) {
        try {
          return nextResolve(base + suffix, context)
        } catch {
          /* 试下一个后缀 */
        }
      }
      throw err
    }
  },
})
