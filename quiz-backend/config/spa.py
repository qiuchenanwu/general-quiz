"""前端构建产物的托管视图。

生产环境里静态文件由 nginx 发（见 deploy/nginx-renwu.conf），
但本地开发、或者 nginx 还没配好时，让 Django 直接把 dist 发出来最省事 ——
不用同时开两个服务就能看到离线的真实页面。

行为：
    /                 -> frontend/dist/index.html
    /workers/12       -> 同上（Vue Router 的 history 模式，由前端自己解析路径）
    /assets/xxx.js    -> 真实文件
    dist 不存在       -> 给一页人话提示，告诉你怎么构建
"""

from __future__ import annotations

import mimetypes
from pathlib import Path

from django.conf import settings
from django.http import FileResponse, Http404, HttpResponse

#: 构建产物目录（vite.config.js 里的 outDir 是 frontend/dist）
DIST_DIR = Path(getattr(settings, "FRONTEND_DIST", settings.BASE_DIR.parent / "frontend" / "dist"))

_HELP_PAGE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>人物画像 · 前端还没构建</title>
<style>
 body{{font-family:-apple-system,'Microsoft YaHei',sans-serif;max-width:640px;
      margin:60px auto;padding:0 20px;color:#1f2937;line-height:1.8}}
 code{{background:#f3f4f6;padding:2px 6px;border-radius:4px}}
 pre{{background:#111827;color:#e5e7eb;padding:12px;border-radius:8px;overflow:auto}}
</style></head><body>
<h1>前端还没构建</h1>
<p>后端是活的（这个页面就是 Django 发出来的），但 <code>{dist}</code> 里没有
<code>index.html</code>。先构建前端：</p>
<pre>cd renwu/frontend
npm install
npm run build</pre>
<p>构建完刷新本页即可。若只是想改前端，用开发模式更舒服：</p>
<pre>cd renwu/frontend
npm run dev     # 打开 http://127.0.0.1:5273，/api 自动代理到 Django</pre>
<p>另外后台管理一直是可用的：<a href="/admin/">/admin/</a></p>
</body></html>
"""


def _safe_path(relative: str) -> Path | None:
    """把 URL 里的相对路径解析到 DIST_DIR 内部，挡住 ../ 越权读取。"""
    target = (DIST_DIR / relative).resolve()
    try:
        target.relative_to(DIST_DIR.resolve())
    except ValueError:
        return None
    return target


def spa(request, path: str = ""):
    """先把真实文件发出去，找不到就回 index.html 交给前端路由。"""
    if path:
        candidate = _safe_path(path)
        if candidate and candidate.is_file():
            content_type, _ = mimetypes.guess_type(candidate.name)
            return FileResponse(candidate.open("rb"),
                                content_type=content_type or "application/octet-stream")

    index = DIST_DIR / "index.html"
    if not index.is_file():
        return HttpResponse(_HELP_PAGE.format(dist=DIST_DIR), status=200)

    # index.html 不缓存：否则发新版前端后用户会一直看到旧壳子
    response = FileResponse(index.open("rb"), content_type="text/html; charset=utf-8")
    response["Cache-Control"] = "no-store"
    return response


def favicon(_request):
    """浏览器总会来要 /favicon.ico。

    构建产物里只有 favicon.png（index.html 里指定），所以这里把它顶上去；
    都没有就明确 404，省得在日志里刷一堆噪声。
    """
    for name in ("favicon.ico", "favicon.png"):
        icon = DIST_DIR / name
        if icon.is_file():
            content_type = "image/x-icon" if name.endswith(".ico") else "image/png"
            return FileResponse(icon.open("rb"), content_type=content_type)
    raise Http404
