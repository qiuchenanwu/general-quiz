import { createRouter, createWebHashHistory } from 'vue-router'

// 用 hash 路由：`base: './'` + hash 的组合让构建产物可以直接双击打开，
// 也能丢到任意子目录（/quiz/、/tools/quiz/…）而不用配 rewrite。
const routes = [
  {
    path: '/',
    name: 'home',
    component: () => import('@/views/HomeView.vue'),
    meta: { title: '题库' },
  },
  {
    path: '/practice',
    name: 'practice',
    component: () => import('@/views/PracticeView.vue'),
    meta: { title: '刷题' },
  },
  {
    // 诊断先行：10 分钟摸清这一章该怎么学，再决定去做哪类题（见 core/diagnose.js）
    // ⚠️ AI 功能：默认隐藏（quiz.settings.aiEnabled=false 时 router.beforeEach 跳到 /）
    path: '/diagnose',
    name: 'diagnose',
    component: () => import('@/views/DiagnoseView.vue'),
    meta: { title: '诊断先行', ai: true },
  },
  {
    // 预习页：扫描件教材 → 骨架/术语/先猜后验（见 core/lesson.js，**不花额度**）
    // AI 功能：默认隐藏
    path: '/lesson',
    name: 'lesson',
    component: () => import('@/views/LessonView.vue'),
    meta: { title: '预习页', ai: true },
  },
  {
    // 演武场：随手粘一段代码就能跑（Java 走服务器真跑、片段自动补壳；JS/Vue 走浏览器沙箱）
    // 代码运行不需要 AI；保留入口。
    path: '/forge',
    name: 'forge',
    component: () => import('@/views/ForgeView.vue'),
    meta: { title: '演武场' },
  },
  {
    path: '/review',
    name: 'review',
    component: () => import('@/views/ReviewView.vue'),
    meta: { title: '错题本' },
  },
  {
    // 登录/注册：登录之后进度跟着账号走（见 core/auth.js、core/sync.js）
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { title: '登录' },
  },
  {
    path: '/report',
    name: 'report',
    component: () => import('@/views/ReportView.vue'),
    meta: { title: '学习报告' },
  },
  {
    // 知识图谱：AI 功能，默认隐藏
    path: '/graph',
    name: 'graph',
    component: () => import('@/views/GraphView.vue'),
    meta: { title: '知识图谱', ai: true },
  },
  {
    path: '/player',
    name: 'player',
    component: () => import('@/views/PlayerView.vue'),
    meta: { title: '播放器' },
  },
  {
    path: '/diagram',
    name: 'diagram',
    component: () => import('@/views/DiagramView.vue'),
    meta: { title: '图笔记' },
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

// AI 入口守卫：默认（quiz.settings.aiEnabled=false）拦截所有标了 ai:true 的路由，
// 跳到首页 + 给个一次性提示。让用户没法"误碰"了再发现不能用。
router.beforeEach((to) => {
  if (to.meta?.ai) {
    try {
      const settings = JSON.parse(localStorage.getItem('quiz:v1:settings') || '{}')
      if (!settings.aiEnabled) {
        return { name: 'home', query: { aiBlocked: to.name } }
      }
    } catch { /* localStorage 解析失败 → 当作禁用 */ }
  }
  return true
})

router.afterEach((to) => {
  const t = to.meta?.title
  document.title = t ? `${t} · 刷题` : '刷题 · Quiz'
})

export default router
