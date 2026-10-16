"""刷题站账号：注册开关、用户名/密码规则、限流、给前端的"我是谁"。

设计要点（都是刻意的，别照"更省事"的写法改）
--------------------------------------------
1. **不新开 user 表**：用 Django 内置 ``auth.User``，注册出来的就是普通用户。
   刷题站没有"角色矩阵" —— 老师 / 学生 / 路人看到的页面都一样，全用普通用户即可。

2. **注册默认开放，但一个环境变量就能收紧**：
       QUIZ_SIGNUP_MODE=open    谁都能注册（默认）
       QUIZ_SIGNUP_MODE=key     要邀请码（填 QUIZ_SIGNUP_KEY）
       QUIZ_SIGNUP_MODE=closed  只能在 /admin/ 里开号
   ⚠️ `key` 档**没配邀请码 = 注册关闭**（fail closed）：
      "忘了配就等于人人可注册"这种口子绝不留给公网站点。

3. **允许中文用户名**。传统 Django 默认 ``UnicodeUsernameValidator`` 限制太严，
   但刷题站的学生第一反应就是拿自己的名字/昵称当账号 —— 一律拒绝中文等于
   把"注册"这个动作提高了没必要的门槛。这里用 Python 正则的 `\\w`（默认 Unicode），
   汉字算在内；只挡空格和标点这类会让人分不清的东西。

4. **限流走 Django cache**（不新引依赖）。⚠️ 板子上是 `uvicorn --workers 2`，
   locmem cache 是**每进程一份**的 ⇒ 实际额度约为配置值的 2 倍。
   这个精度对"防字典爆破"够用（8 次/10 分钟 → 最多 16 次），
   但要精确就得换 Redis —— 那属于另一件事，不在这里顺手做。
"""

from __future__ import annotations

import re
import secrets
from typing import Any

from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.cache import cache
from django.core.exceptions import ValidationError as DjangoValidationError

from .models import QuizAccount

User = get_user_model()

#: 用户名规则：2~30 个"字"（汉字/字母/数字），允许 _ . @ + -（\w 在 Python 里默认 Unicode）
USERNAME_RE = re.compile(r"^[\w.@+-]{2,30}$", re.UNICODE)
NICKNAME_MAX = 24
#: 和 settings.AUTH_PASSWORD_VALIDATORS 的 min_length 对齐（那边是权威；这里只用来给前端提示）
PASSWORD_MIN = 8

SIGNUP_MODES = ("open", "key", "closed")

#: 限流的默认值，可用环境变量覆盖（板子上在 shared/.env）
DEFAULT_LOGIN_PER_IP = 20
DEFAULT_LOGIN_PER_NAME = 8
DEFAULT_SIGNUP_PER_IP = 5
DEFAULT_WINDOW = 600  # 秒


# ---------------------------------------------------------------------------
# 注册开关
# ---------------------------------------------------------------------------

def signup_mode() -> str:
    """当前注册档位。写错的值一律当 `closed`（fail closed，别当 open）。"""
    raw = str(getattr(settings, "QUIZ_SIGNUP_MODE", "open") or "").strip().lower()
    if raw not in SIGNUP_MODES:
        return "closed"
    if raw == "key" and not signup_key():
        # 选了"要邀请码"却没配码 ⇒ 注册关闭（不然就是"填个空就能注册"）
        return "closed"
    return raw


def signup_key() -> str:
    return str(getattr(settings, "QUIZ_SIGNUP_KEY", "") or "").strip()


def signup_public() -> dict:
    """给前端的注册开关说明（**不含邀请码本身**）。"""
    mode = signup_mode()
    return {
        "mode": mode,
        "open": mode == "open",
        "keyRequired": mode == "key",
        "closed": mode == "closed",
        "note": {
            "open": "直接注册就能用，注册完自动登录。",
            "key": "注册需要邀请码 —— 找老师要一个。",
            "closed": "暂时关闭了自助注册，请联系老师开号。",
        }[mode],
    }


def check_signup_key(given: Any) -> bool:
    """定长时间比较邀请码。

    ⚠️ `compare_digest` 在 str 上只接受 ASCII —— 邀请码完全可能是中文（或从聊天记录里
    粘来的），直接比会 TypeError（= 500）。统一编成 bytes 再比。
    """
    key = signup_key()
    if not key:
        return False
    return secrets.compare_digest(str(given or "").strip()[:200].encode("utf-8"), key.encode("utf-8"))


# ---------------------------------------------------------------------------
# 校验
# ---------------------------------------------------------------------------

def validate_username(raw: Any) -> str:
    """把用户名洗干净或抛 ValueError（消息是给**学生**看的中文）。"""
    username = str(raw or "").strip()
    if not username:
        raise ValueError("请填用户名")
    if not USERNAME_RE.fullmatch(username):
        raise ValueError("用户名要 2~30 位，只能用汉字、字母、数字和 _ . @ + -（不能有空格）")
    return username


def validate_nickname(raw: Any) -> str:
    nickname = str(raw or "").strip()
    if len(nickname) > NICKNAME_MAX:
        raise ValueError(f"昵称太长（最多 {NICKNAME_MAX} 个字）")
    return nickname


def validate_new_password(password: Any, username: str) -> str:
    """跑 Django 自带的那套口令校验（settings.AUTH_PASSWORD_VALIDATORS）。

    为什么不自创一套：`/admin/`、人物画像的注册页用的是同一套校验器，
    两处不一致就等于留了个弱口令后门。
    """
    value = str(password or "")
    if not value:
        raise ValueError("请填密码")
    try:
        validate_password(value, User(username=username))
    except DjangoValidationError as exc:
        raise ValueError("；".join(exc.messages)) from exc
    return value


# ---------------------------------------------------------------------------
# 限流
# ---------------------------------------------------------------------------

def _limit(name: str, default: int) -> int:
    try:
        return max(1, int(getattr(settings, name, default)))
    except (TypeError, ValueError):
        return default


def _window() -> int:
    try:
        return max(30, int(getattr(settings, "QUIZ_AUTH_WINDOW", DEFAULT_WINDOW)))
    except (TypeError, ValueError):
        return DEFAULT_WINDOW


def check_rate(bucket: str, ident: str, limit: int) -> int:
    """记一次命中。返回 0 = 放行，否则返回"还要等多少秒"。

    用 `cache.add` + `cache.incr`：第一次写就把窗口设上，之后只在同一个键上自增 ——
    这样窗口是**固定**的（不是滑动窗口）。对"别让人拿字典刷密码"这个目的足够，
    而且不需要额外存时间戳列表。
    """
    window = _window()
    key = f"quiz:auth:{bucket}:{ident}"
    if cache.add(key, 1, window):
        return 0
    try:
        hits = cache.incr(key)
    except ValueError:
        # 键刚好在这两句之间过期了：重新起一个窗口，这次算第 1 次
        cache.set(key, 1, window)
        return 0
    if hits <= limit:
        return 0
    try:
        ttl = cache.ttl(key)
    except Exception:  # noqa: BLE001 - 后端不支持 ttl 时用窗口值兜底
        ttl = None
    return int(ttl) if ttl and ttl > 0 else window


def login_limits() -> tuple[int, int]:
    return _limit("QUIZ_LOGIN_PER_IP", DEFAULT_LOGIN_PER_IP), _limit(
        "QUIZ_LOGIN_PER_NAME", DEFAULT_LOGIN_PER_NAME
    )


def signup_limit() -> int:
    return _limit("QUIZ_SIGNUP_PER_IP", DEFAULT_SIGNUP_PER_IP)


def wait_message(seconds: int) -> str:
    minutes = max(1, round(seconds / 60))
    return f"试得太频繁了，请等 {minutes} 分钟再试"


# ---------------------------------------------------------------------------
# 账号
# ---------------------------------------------------------------------------

def account_for(user) -> QuizAccount:
    """取（或补建）这个账号的刷题档案。

    用 get_or_create 而不是"注册时建好就行"：老板完全可能在 `/admin/` 里
    直接建一个账号给学生用（那时没有 QuizAccount 行），他不该因此看到 500。
    """
    account, _ = QuizAccount.objects.get_or_create(user=user)
    return account


def username_taken(username: str) -> bool:
    """整张 User 表都要查（见文件头第 1 条）。"""
    return User.objects.filter(username__iexact=username).exists()


def create_account(username: str, password: str, nickname: str = ""):
    """建号 + 建刷题档案。调用方负责先跑完校验。"""
    user = User.objects.create_user(
        username=username,
        password=password,
    )
    account = QuizAccount.objects.create(user=user, nickname=nickname or username)
    return user, account


def user_payload(user) -> dict:
    """给前端的"当前用户"。别把 User 直接序列化（会带出 password 等字段）。"""
    account = account_for(user)
    return {
        "id": user.pk,
        "username": user.get_username(),
        "nickname": account.nickname or user.get_username(),
        "joinedAt": account.created_at.isoformat() if account.created_at else "",
    }


def signed_in(request) -> bool:
    return bool(getattr(request, "user", None) and request.user.is_authenticated)
