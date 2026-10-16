"""提权：把密码换成一张**短期通行证**（Java 真跑那类"危险动作"要用）。

为什么单独一个模块
------------------
这是一处**安全边界**，和限流/缓存那种"工程方便"不是一回事，值得单独放、单独测。

设计：为什么是**无状态签名 token**，不是进程内存
--------------------------------------------------
板子的后端是 `uvicorn --workers 2` —— **两个进程各有各的内存**。
把"谁提过权"存在内存里，会出现"提权成功了，但一半请求还是 403"这种鬼问题
（这个仓库的限流就是进程内实现，它的注释里已经承认了这一点；这里不能照抄）。

所以这里用 `django.core.signing`（`SECRET_KEY` 签名 + 自带时间戳）：

    * 两个 worker 都认（不共享状态也能验签）
    * 重启后端不失效（只要 QUIZ_SECRET_KEY 没变）
    * 服务端**不存任何东西**，也就没有"清理过期 token"的活

⚠️ 敲键序列（x s 9 9 9）**不是**安全边界
------------------------------------------
前端 bundle 是公开可读的，谁翻一遍 JS 都能看到那个序列。
它只负责"把密码框叫出来"，**真正的门是这里的密码校验**。
所以别把秘密放进敲键序列里 —— 这一条我写在代码里，免得以后有人往那边加"隐藏功能"。
"""
from __future__ import annotations

import hmac
import threading
import time

from django.core import signing

#: 签名用的 salt（和别的签名用途隔开，防止 token 被挪用到别处）
SALT = "quiz-elevate"

#: 请求头里带 token 的字段名（Django 把 `X-Quiz-Elevate` 放进 META 时是这个样子）
HEADER_META = "HTTP_X_QUIZ_ELEVATE"

#: 密码试错限流：每个 IP 在一个窗口里允许试几次
TRIES_WINDOW = 600.0

_LOCK = threading.Lock()
_TRIES: dict[str, list[float]] = {}


# --------------------------------------------------------------------------
# 配置（都从 Django settings 读，取不到就用默认值 —— 方便脱离 Django 单测）
# --------------------------------------------------------------------------

def _setting(name: str, default):
    try:
        from django.conf import settings

        return getattr(settings, name, default)
    except Exception:  # noqa: BLE001 - 脱离 Django 运行时也要能跑
        return default


def password() -> str:
    return str(_setting("QUIZ_ELEVATE_PASSWORD", "") or "")


def ttl() -> int:
    """一次提权有效期（秒）。"""
    try:
        return max(60, int(_setting("QUIZ_ELEVATE_TTL", 1800)))
    except (TypeError, ValueError):
        return 1800


def max_tries() -> int:
    try:
        return max(1, int(_setting("QUIZ_ELEVATE_TRIES", 8)))
    except (TypeError, ValueError):
        return 8


def configured() -> bool:
    """**没配密码 = 提权功能不存在**（fail closed）。

    绝不退化成"没配密码就放行" —— 那等于把最危险的那个接口直接开在公网上。
    """
    return bool(password())


# --------------------------------------------------------------------------
# 试错限流
# --------------------------------------------------------------------------

def _client_ip(request) -> str:
    forwarded = (request.META.get("HTTP_X_FORWARDED_FOR") or "").split(",")[0].strip()
    return forwarded or request.META.get("REMOTE_ADDR") or "unknown"


def too_many_tries(request) -> bool:
    now = time.time()
    ip = _client_ip(request)
    with _LOCK:
        hits = [t for t in _TRIES.get(ip, []) if now - t < TRIES_WINDOW]
        _TRIES[ip] = hits
        return len(hits) >= max_tries()


def note_try(request) -> None:
    """记一次尝试（**成功失败都记**：成功之后也不该被无限试）。"""
    now = time.time()
    ip = _client_ip(request)
    with _LOCK:
        hits = [t for t in _TRIES.get(ip, []) if now - t < TRIES_WINDOW]
        hits.append(now)
        _TRIES[ip] = hits


def reset_tries(request) -> None:
    """密码对了就清零（合法用户不该被自己的手误锁住）。"""
    with _LOCK:
        _TRIES.pop(_client_ip(request), None)


# --------------------------------------------------------------------------
# 发 token / 验 token
# --------------------------------------------------------------------------

def issue(request, candidate: str) -> str | None:
    """密码对就发一张通行证，否则 None。

    对比用 `hmac.compare_digest`（常数时间）—— 别用 `==`，
    那会按字符逐位短路，理论上能被计时侧信道摸出前缀。
    """
    if not configured():
        return None
    expected = password()
    if not isinstance(candidate, str) or not candidate:
        return None
    if not hmac.compare_digest(candidate, expected):
        return None
    return signing.dumps({"scope": "elevate"}, salt=SALT)


def verify(token: str | None) -> bool:
    """token 有效吗？（验签 + 过期）"""
    if not configured() or not token:
        return False
    try:
        data = signing.loads(token, salt=SALT, max_age=ttl())
    except signing.BadSignature:  # 包含 SignatureExpired
        return False
    except Exception:  # noqa: BLE001 - 畸形 token 一律当无效，不许冒泡成 500
        return False
    return isinstance(data, dict) and data.get("scope") == "elevate"


def token_from_request(request) -> str | None:
    token = request.META.get(HEADER_META)
    if token:
        return str(token).strip()
    # 兼容一下 body/query（调试用 curl 方便），仍然要验签
    return None


def is_elevated(request) -> bool:
    return verify(token_from_request(request))

