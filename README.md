# general-quiz

一个**通用**的刷题站：前端 Vue3 + Element Plus + Pinia，后端 Django（独立项目，不依赖 Django REST framework）。
题库就是一个 JSON 文件 —— 丢进去就能刷，换科目换题库都不用改一行代码。

> 通用刷题站 · Vue3 + Django · JSON 题库 · 代码题 / 错题本 / 笔记 / OCR · AI 可选

## 它能做什么

**刷题**
- 顺序练习 / 随机练习 / **模拟考试**（限题量 + 限时 + 到点自动交卷）
- 错题重做 / 收藏练习 / 按题型 + 标签 + 题号区间筛题 / **背题模式**（不判对错、不污染错题本）
- 答题卡按「未做 / 错题」过滤，长卷子也能一眼定位

**代码题**（5 种模式，判定全在本地，不花钱）
- `填空`：代码里的 `___` 变成输入框
- `找错行`：点出"被改动的那一行"
- `预测输出`：先判断，再按运行让结果说话
- `修好它`：直接改代码，跑到输出对上文档
- `手写`：只给文档说法和期望输出，代码从零写

**学习记录**
- 错题本 / 收藏 / 笔记（**笔记单独存**，重置进度不会丢）
- 学习报告：热力图、趋势、弱项标签、耗时中位数

**物理**
- 题库 → JSON（规则解析器，不依赖 AI；可选扫描件 PDF + 浏览器 OCR）
- 账号 / 进度云同步（登录后错题本跟着账号走）
- Java 真跑沙箱（**默认关闭**，配 `QUIZ_JAVA_ENABLED=1` 启用；用于代码题判据）

**AI**（**默认禁用**）
- 全部接口 / 代码 / 路由都在仓库里 —— 配上环境变量即可启用，无需改任何代码。
- 后端 `QUIZ_LLM_DISABLED=1` 时所有 AI 接口返 `503 ai_disabled`；前端默认不显示 AI 入口。
- 启用：去掉 `QUIZ_LLM_DISABLED`，配上 `QUIZ_LLM_API_KEY`（OpenAI 兼容协议），
  并在前端把 `quiz:v1:settings.aiEnabled` 设为 `true`。

## 快速开始

```bash
# 后端
cd quiz-backend
uv sync              # 或 pip install -e .
python manage.py migrate
python manage.py runserver

# 前端（另一个终端）
cd quiz-frontend
npm install
npm run dev          # http://localhost:5199，/api 已代理到后端 :8000

# 生产构建
npm run build        # 产物在 quiz-frontend/dist/
```

把 `dist/` 整个放到后端 `QUIZ_FRONTEND_DIST` 指向的位置，后端 `/quiz/` 路由会自动发静态文件（hash 路由，丢到任意子目录都能跑）。

## 题库怎么放

把 JSON 丢进 `quiz-frontend/src/banks/` 就能上架，开发模式自动热更新；出构建产物则再 `npm run build`。
或者直接把 `.json` 拖到首页虚线框。

仓库里带了一份 `src/banks/example.json`（3 道示例题），其它题库由你自己提供。

字段名中英文都认，结构随便一点也行（前端 `core/normalize.js` 会归一化）：

```json
[
  { "题目": "中国的武装斗争是无产阶级领导下的以( )为主体的革命战争。",
    "选项": ["工人", "农民", "城市小资产阶级", "知识分子"],
    "正确答案": "B" }
]
```

| 部分 | 支持的写法 |
|---|---|
| 顶层 | 裸数组、`{questions}`、`{data}`、`{list}`、`{items}`、`{题目}` |
| 题干 | `stem` / `question` / `content` / `text` / `题干` / `题目` / `问题` |
| 选项 | 字符串数组（自动配 A/B/C/D）、`[{key,text}]`、`{A:"…",B:"…"}`、自带 `"A. "` 前缀 |
| 答案 | `"A"` / `"AB"` / `"A,B"` / `"A、B"` / `["A","B"]` / `1` / `0` / `"正确"` / `"错误"` / `"对"` / `"错"` / `"√"` / `"×"` / `true` / `false` / `"b"`（小写也行） |
| 类型 | `type` / `questionType` / `题型`；**不写就自动推断** |
| 其它 | `analysis` / `解析`、`tags` / `标签`、`chapter` / `章节`、`difficulty` / `难度` |

## 启用 AI 功能

后端 — 三个环境变量：

```bash
QUIZ_LLM_DISABLED=          # 留空 / 删掉 / 设 0 = 启用
QUIZ_LLM_API_KEY=sk-...     # 必填（OpenAI 兼容协议）
QUIZ_LLM_BASE_URL=https://api.deepseek.com/v1   # 默认值
QUIZ_LLM_MODEL=deepseek-chat                    # 默认值
QUIZ_LLM_TIMEOUT=90
```

也可以配本地 Ollama（默认自动发现 `127.0.0.1:11434` 和 `127.0.0.1:1234`，不用改配置）。

前端 — 在浏览器控制台跑：

```js
const s = JSON.parse(localStorage.getItem('quiz:v1:settings') || '{}')
s.aiEnabled = true
localStorage.setItem('quiz:v1:settings', JSON.stringify(s))
location.reload()
```

刷新后顶栏会出现「预习页」「知识图谱」，题目卡右上角会出现「问 AI」按钮，AI 出题 / 补解析 入口出现在题库工具面板。

## Java 真跑沙箱（代码题判据）

```bash
QUIZ_JAVA_ENABLED=1         # 默认关闭，公网千万别开
QUIZ_JAVA_ELEVATE_PASSWORD=...   # 不设 = 没这个功能 = Java 永远 403
```

`tools/java_sandbox.py` 用 bubblewrap 做隔离（网络、`/home`、环境变量、写超大文件都挡得住），但**不是多租户级别**。仅供内网自用。

## 仓库结构

```
.
├── LICENSE
├── README.md
├── quiz-frontend/                ← Vue3 SPA
│   ├── package.json
│   ├── vite.config.js
│   ├── public/                   ← 静态资源（含 OCR 模型）
│   ├── src/
│   │   ├── banks/                ← 题库 JSON（丢进去就上架）
│   │   │   └── example.json      ← 3 道示例题
│   │   ├── components/           ← 题卡、选项、答题卡、笔记、播放器…
│   │   ├── core/                 ← 纯逻辑（normalize / storage / code / coach …）
│   │   ├── stores/               ← Pinia stores（bank / quiz / player）
│   │   └── views/                ← 路由页面
│   └── tests/                    ← 引擎自测（纯 Node）
│
└── quiz-backend/                 ← Django 后端（独立项目）
    ├── manage.py
    ├── pyproject.toml
    ├── .env.example
    ├── config/                   ← Django 配置
    │   ├── settings.py
    │   ├── urls.py
    │   ├── wsgi.py / asgi.py
    │   └── spa.py
    └── apps/quizgen/             ← 刷题站 app（账号 / 进度 / AI / Java）
        ├── models.py             ← QuizAccount / QuizState
        ├── accounts.py           ← 注册 + 限流
        ├── qstate.py             ← 进度合并规则（纯函数）
        ├── elevate.py            ← 提权（解锁 Java）
        ├── views.py              ← JSON 接口
        ├── urls.py
        ├── llm.py                ← OpenAI 兼容客户端（默认禁用）
        ├── service.py            ← AI 功能封装
        ├── prompts.py            ← 提示词包
        ├── tests.py              ← 单测
        ├── migrations/
        ├── tools/                ← 离线工具（PDF→题库 / 规则检查 / OCR 等）
        └── quiz_spa.py           ← 前端 SPA 托管
```

## License

MIT — 见 [LICENSE](./LICENSE)。
