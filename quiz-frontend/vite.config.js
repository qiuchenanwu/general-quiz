import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

// 开发时 /api 转给谁。
// 默认指本机的 Django（manage.py runserver 默认端口 8000）。
// 想换成别的地址：$env:VITE_QUIZ_API="http://your.host:8000"; npm run dev
const BACKEND = process.env.VITE_QUIZ_API || 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [vue()],

  // 相对路径 + hash 路由：构建产物丢到任何子目录都能跑
  // （默认挂在 /quiz/，也可放在根或别的路径），不用配 nginx rewrite。
  base: './',

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  server: {
    host: true,
    port: 5199,
    proxy: {
      // 只代理接口，前端本体走 vite 自己。
      '/api': {
        target: BACKEND,
        changeOrigin: true,
        timeout: 120000,
      },
    },
  },

  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        /**
         * ⚠️ 把 .mjs 资源改成 .js 输出。某些 nginx 版本（Ubuntu 1.28 的
         * mime.types 里就没有 mjs 这一项）会把 .mjs 当 octet-stream 发出去，
         * 浏览器拒绝把 MIME 不对的东西当模块加载，于是报
         * "Setting up fake worker failed: Failed to fetch dynamically imported module"。
         * （实测：worker 文件 HTTP 200、字节数也对，就是 Content-Type 是 octet-stream。）
         *
         * 改扩展名比改服务器更省事：.js 在 mime.types 里有正确的
         * application/javascript，而 ES module worker 本身不关心扩展名。
         */
        assetFileNames: (info) => {
          const name = (info.names && info.names[0]) || info.name || ''
          return name.endsWith('.mjs')
            ? 'assets/[name]-[hash].js'
            : 'assets/[name]-[hash][extname]'
        },
      },
    },
  },
})
