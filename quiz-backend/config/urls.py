"""general-quiz · URL 总表。

    /api/quiz/   刷题站的 JSON 接口（账号 / 进度 / 状态 / Java 沙箱 / AI）
    /quiz/...    刷题站前端 SPA（由 apps/quizgen/quiz_spa.py 直发 dist/）
    其余         兜底返回 SPA index.html（hash 路由，rewrite 友好）
"""

from django.conf import settings
from django.urls import include, path, re_path

from apps.quizgen import quiz_spa

urlpatterns = [
    # 刷题站接口
    path("api/quiz/", include("apps.quizgen.urls")),

    # 刷题站前端（按顺序排在前 —— 见下面的兜底说明）
    path("quiz/", quiz_spa.quiz_spa, {"path": ""}, name="quiz"),
    re_path(r"^quiz/(?P<path>.*)$", quiz_spa.quiz_spa, name="quiz-asset"),
]

# 开发环境：暴露 /static/
if settings.DEBUG:
    from django.contrib.staticfiles.views import serve as staticfiles_serve

    urlpatterns += [
        re_path(r"^static/(?P<path>.*)$", staticfiles_serve),
    ]

# 兜底：所有非 /api、/static 的路径都返回 SPA index.html（hash 路由）
urlpatterns += [
    re_path(r"^(?P<path>(?!api/|static/|quiz/|admin/).*)$", quiz_spa.quiz_spa, name="spa-fallback"),
]
