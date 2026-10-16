"""刷题站的账号档案与进度（两张小表）。

为什么有这个文件
---------------
站主说"加一个登录和注册"。一个"登录了但什么都不会变"的账号是假功能 ——
学生换台电脑、或者清一次浏览器数据，错题本 / 收藏 / 笔记 / 作答历史就全没了。
所以账号和**进度存服务端**是同一件事。

两个边界，改这个文件之前先读：
  1. 用 Django 内置 ``auth.User``（``AUTH_USER_MODEL="auth.User"``）。
     quizgen 不另开 user 表 —— 题库站 / 学习站一般没有"角色矩阵"，
     用 Django 自带 User 就够，注册出来的就是普通用户。
  2. 进度的**合并规则**在 ``qstate.py``（纯函数、可单测），这里只负责存。

本地开发要建表：``manage.py migrate``。
"""

from __future__ import annotations

from django.conf import settings
from django.db import models


class QuizAccount(models.Model):
    """刷题站的账号档案（昵称等）。"""

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        verbose_name="账号",
        on_delete=models.CASCADE,
        related_name="quiz_account",
    )
    nickname = models.CharField("昵称", max_length=24, blank=True)
    created_at = models.DateTimeField("注册时间", auto_now_add=True)

    class Meta:
        verbose_name = "刷题账号"
        verbose_name_plural = "刷题账号"

    def __str__(self) -> str:  # pragma: no cover - 只是 admin 里好认
        return self.nickname or self.user.get_username()


class QuizState(models.Model):
    """一个账号在某套题库上的进度（一份 JSON）。

    为什么是"一套题库一行 JSON"而不是拆成一堆关系表：
    前端本来就是**整块读写** localStorage 的（answers / wrong / fav / history / notes / …），
    拆表只会让"本机 ↔ 账号"的同步多出一层映射，收益是零。
    ``updated_at`` 是服务端时间，用来给前端显示"上次同步是什么时候"。

    ``bank_id`` 用 CharField 而不是外键：题库是**前端构建产物里的 JSON**
    （``src/banks/*.json`` 和用户临时导入的题库），后端并没有一张题库表。
    导入的题库 id 是前端生成的（见 ``stores/bank.js``），后端只当字符串存。
    """

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        verbose_name="账号",
        on_delete=models.CASCADE,
        related_name="quiz_states",
    )
    bank_id = models.CharField("题库 id", max_length=120)
    data = models.JSONField("进度", default=dict, blank=True)
    created_at = models.DateTimeField("创建时间", auto_now_add=True)
    updated_at = models.DateTimeField("更新时间", auto_now=True)

    class Meta:
        verbose_name = "刷题进度"
        verbose_name_plural = "刷题进度"
        constraints = [
            models.UniqueConstraint(fields=["user", "bank_id"], name="uniq_quiz_state_user_bank"),
        ]
        indexes = [models.Index(fields=["user", "-updated_at"], name="quiz_state_user_recent")]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.user_id}@{self.bank_id}"
