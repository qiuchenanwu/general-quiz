"""刷题站前端构建产物的托管视图。

    /quiz/             -> <QUIZ_FRONTEND_DIST>/index.html
    /quiz/assets/xx.js -> 真实文件

为什么走 Django 而不是在 nginx 里再加一段 location：
    能不动 nginx 就不动 —— 少一次 reload 就少一次「改错了整站 502」的机会。
    走 Django 的代价只是静态文件多绕一跳，对自用刷题站完全无所谓。
    将来真觉得慢，再把 /quiz/ 挪进 nginx 也不影响这里的任何逻辑。

构造产物目录默认在仓库同级 ``../quiz-frontend/dist/``，生产可由
``QUIZ_FRONTEND_DIST`` 环境变量覆盖。
"""

from __future__ import annotations

import mimetypes
from pathlib import Path

from django.conf import settings
from django.http import FileResponse, HttpResponse


def quiz_dist() -> Path:
    """**每次调用**都读一次 settings，而不是在模块导入时绑死。

    绑死会有两个坑：测试里 override_settings(QUIZ_FRONTEND_DIST=...) 不生效；
    以后要支持运行时换目录也得重启进程。这里多读一次 settings 的成本可以忽略。
    """
    return Path(
        getattr(
            settings,
            "QUIZ_FRONTEND_DIST",
            settings.BASE_DIR.parent / "quiz-frontend" / "dist",
        )
    )

_HELP_PAGE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>general-quiz · 前端还没构建</title>
<style>
 body{{font-family:-apple-system,'Microsoft YaHei',sans-serif;max-width:660px;
      margin:60px auto;padding:0 20px;color:#1f2937;line-height:1.8}}
 code{{background:#f3f4f6;padding:2px 6px;border-radius:4px}}
 pre{{background:#111827;color:#e5e7eb;padding:12px;border-radius:8px;overflow:auto}}
</style></head><body>
<h1>general-quiz 后端是活的，但前端产物还没构建</h1>
<p>这个页面就是 Django 发出来的，说明 /quiz/ 路由通了；
只是 <code>{dist}</code> 里没有 <code>index.html</code>。</p>
<p>前端构建：</p>
<pre>cd quiz-frontend
npm install
npm run build</pre>
<p>或者用 vite dev（自带 /api/quiz/ 代理，更适合日常开发）：</p>
<pre>npm run dev    # http://localhost:5199</pre>
<p>接口本身可以直接验：<a href="../api/quiz/status/">/api/quiz/status/</a></p>
</body></html>
"""


def _safe_path(relative: str) -> Path | None:
    """把 URL 相对路径解析到 QUIZ_DIST 内部，挡住 ../ 越权读取。"""
    base = quiz_dist()
    target = (base / relative).resolve()
    try:
        target.relative_to(base.resolve())
    except ValueError:
        return None
    return target


#: 显式钉死的 MIME 类型。
#: Windows 上 Python 的 mimetypes 会去读注册表，.js 常被判成 text/plain，
#: 而浏览器**拒绝执行** MIME 不对的 ES module —— 整个页面直接白屏。
#: 不想依赖操作系统，所以这几个关键类型写死。
_FORCE_TYPES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".wasm": "application/wasm",
    ".webp": "image/webp",
}


def _content_type(path: Path) -> str:
    forced = _FORCE_TYPES.get(path.suffix.lower())
    if forced:
        return forced
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def quiz_spa(request, path: str = ""):
    """先发真实文件，找不到就回 index.html 交给前端（hash 路由，其实只需要这一个入口）。"""
    dist = quiz_dist()
    if path:
        candidate = _safe_path(path)
        if candidate and candidate.is_file():
            response = FileResponse(candidate.open("rb"), content_type=_content_type(candidate))
            # Vite 产物带内容哈希，可以长缓存
            if "/assets/" in f"/{path}":
                response["Cache-Control"] = "public, max-age=31536000, immutable"
            return response

    index = dist / "index.html"
    if not index.is_file():
        return HttpResponse(_HELP_PAGE.format(dist=dist), status=200)

    # index.html 绝不缓存：否则发了新前端，用户还在跑旧壳子
    response = FileResponse(index.open("rb"), content_type="text/html; charset=utf-8")
    response["Cache-Control"] = "no-store"
    return response

