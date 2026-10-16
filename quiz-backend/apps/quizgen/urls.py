"""quizgen 的路由，由 config/urls.py 以 /api/quiz/ 前缀 include 进来。"""

from django.urls import path

from . import views

app_name = "quizgen"

urlpatterns = [
    path("status/", views.status, name="status"),
    path("import/", views.import_bank, name="import"),
    path("analysis/", views.analysis, name="analysis"),
    path("graph/", views.graph, name="graph"),
    path("generate/", views.generate, name="generate"),
    # JavaWeb 代码题：真编译真运行（默认关 + 必须提权，见 settings.QUIZ_JAVA_ENABLED）
    path("java/run/", views.java_run, name="java_run"),
    # 提权：密码换一张短期通行证（敲键序列只负责把密码框叫出来，不是安全边界）
    path("elevate/", views.elevate_view, name="elevate"),
    # 驾考站新增（刷题站不用，但共用同一套限流/降级/缓存基建）
    path("tutor/", views.tutor, name="tutor"),
    path("diagnose/", views.diagnose, name="diagnose"),
    # AI 批改学生自己写的代码（演武场的「让 AI 检查」＝ 任务回路的最后半步）
    path("review/", views.review, name="review"),
    # 课本这一章 + 他的弱项 → 一个**任务**（任务回路的左半段：不是题，是要他做出东西）
    path("task/", views.task, name="task"),
    # 账号：注册 / 登录 / 登出 / 我是谁（注册档位 open|key|closed 见 accounts.py）
    path("auth/me/", views.auth_me, name="auth_me"),
    path("auth/register/", views.auth_register, name="auth_register"),
    path("auth/login/", views.auth_login, name="auth_login"),
    path("auth/logout/", views.auth_logout, name="auth_logout"),
    # 进度同步（登录后错题本/收藏/笔记/历史跟着账号走）
    path("state/", views.state_get, name="state_get"),
    path("state/save/", views.state_save, name="state_save"),
    path("state/reset/", views.state_reset, name="state_reset"),
]
