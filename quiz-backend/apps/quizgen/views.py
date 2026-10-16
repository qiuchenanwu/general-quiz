"""quizgen 的 JSON 接口。

挂载在 /api/quiz/ 下（见 config/urls.py）—— 复用 nginx 里已有的
`location ~ ^/(api|admin)/` 反代规则，**不需要改 nginx 配置**。

CSRF 按仓库既有约定处理（和 apps/agency/api/auth_views.py 一致）：
    GET  status/   带 @ensure_csrf_cookie，把 csrftoken 种进 cookie
    POST */        带 @csrf_protect，前端从 cookie 读 token 放进 X-CSRFToken

为什么这里值得认真做 CSRF：这几个接口会**真的花掉服务器上的 API 额度**。
不校验的话，任何人诱导你打开一个页面就能刷你的账单。
"""

from __future__ import annotations

import json
import threading
import time

from django.contrib.auth import authenticate, login, logout
from django.db import IntegrityError, transaction
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST

from . import accounts, elevate, llm, qstate, service
from .models import QuizState

#: 一次请求最多接受多少页 / 多少字符（防止有人拿超大 body 把内存打满）
MAX_PAGES = 400
MAX_CHARS = 600_000
#: 一次补解析最多几道题。故意小：nginx 的 proxy_read_timeout 是 120s，
#: 单次调用必须远小于它，所以前端要分批。
MAX_ANALYSIS_BATCH = 20
#: 请求体上限
MAX_BODY = 8 * 1024 * 1024

# --------------------------------------------------------------------------
# 粗限流：带 AI 的接口要花钱，别让人（或前端 bug）刷起来
# 注意：进程内存实现。uvicorn 现在是单进程，够用；
# 将来上多 worker 就要挪到 Django cache 或 redis。
# --------------------------------------------------------------------------
_RATE_LOCK = threading.Lock()
_RATE_HITS: dict[str, list[float]] = {}
RATE_WINDOW = 600.0  # 10 分钟
RATE_MAX = 40  # 窗口内最多 40 次带 AI 的请求（云端）
#: 本机模型（Ollama/LM Studio）没有花钱风险，限流的意义只剩「别把板子 CPU 打满」。
#: 而本机小模型一次只敢塞一两个条目，244 道题就是一百多次请求 ——
#: 还用 40 次的上限等于把功能锁死，所以本机放宽。
RATE_MAX_LOCAL = 300


def _rate_max() -> int:
    """按降级链上**第一条**来源给限额。

    ⚠️ 这里必须看 primary_source() 而不是 config()["source"]：板子上既有云端 key
    又有 Ollama 时 config() 报的是云端，但请求绝大多数走的是本机 —— 用 40 次/10 分钟
    的云端额度去卡本机，两百多道题根本跑不完（这是用户实际撞到的问题）。
    云端只在「本机顶不住」时才被用到，那时也走不了几次。
    """
    try:
        return RATE_MAX_LOCAL if llm.primary_source() in ("local", "explicit") else RATE_MAX
    except Exception:  # noqa: BLE001 - 配置读不出来时按最保守的算
        return RATE_MAX


class Throttled(Exception):
    pass


def _client_ip(request) -> str:
    forwarded = (request.META.get("HTTP_X_FORWARDED_FOR") or "").split(",")[0].strip()
    return forwarded or request.META.get("REMOTE_ADDR") or "unknown"


def _throttle(request, cost: int = 1) -> None:
    now = time.time()
    ip = _client_ip(request)
    limit = _rate_max()
    with _RATE_LOCK:
        hits = [t for t in _RATE_HITS.get(ip, []) if now - t < RATE_WINDOW]
        if len(hits) + cost > limit:
            _RATE_HITS[ip] = hits
            raise Throttled(
                f"请求太频繁：{int(RATE_WINDOW / 60)} 分钟内最多 {limit} 次 AI 调用，"
                "过一会儿再试"
            )
        hits.extend([now] * cost)
        _RATE_HITS[ip] = hits


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------

def _body(request) -> dict:
    if len(request.body) > MAX_BODY:
        raise ValueError("请求体太大")
    if not request.body:
        return {}
    try:
        payload = json.loads(request.body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"请求体不是合法 JSON：{exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError("请求体必须是 JSON 对象")
    return payload


def _fail(message: str, status: int = 400, **extra) -> JsonResponse:
    return JsonResponse({"ok": False, "error": message, **extra}, status=status, json_dumps_params={"ensure_ascii": False})


def _ok(payload: dict, status: int = 200) -> JsonResponse:
    return JsonResponse(payload, status=status, json_dumps_params={"ensure_ascii": False})


# --------------------------------------------------------------------------
# GET /api/quiz/status/
# --------------------------------------------------------------------------

@require_GET
@ensure_csrf_cookie
def status(request):
    """告诉前端：有没有配 AI、规则模块在不在、限流多大。

    **不返回密钥**，只返回「配没配 + 用的哪个模型 + 规则文件的指纹」。
    指纹用来核对板子上跑的是不是仓库里那一份规则。

    额外多一份 `llmCooldown`（新增，不动上面的老字段）：本机自适应短路的开关值、
    各 task 各自的冷却剩余、云端在不在冷却 —— 真机上「为什么这次没先试本机」
    全靠它看。同样是进程内存状态（和限流一个约定）。
    """
    parser_info = {"available": False, "path": "", "digest": ""}
    try:
        service.load_parser()
        parser_info = {
            "available": True,
            "path": str(service.parser_path()),
            "digest": service.parser_digest(),
        }
    except Exception as exc:  # noqa: BLE001 - 只是状态查询，不该 500
        parser_info["error"] = str(exc)

    # Java 沙箱：和规则一样报「在不在 + 指纹」，这样部署完能一眼核对
    # （坑 15：部署会静默失败，光看"传过了"不算数）。
    # ⚠️ enabled=false 是**正常的**：这个接口会在服务器上执行代码，默认关。
    java_info = {
        "enabled": service.java_enabled(),
        "available": False,
        "path": "",
        "digest": "",
        # 提权配没配也报出来 —— 否则"Java 开着但一直 403"要查到怀疑人生
        # （公开这两个字段不泄露密码，只是说明"门装没装"）
        "elevateConfigured": elevate.configured(),
        "elevateTtl": elevate.ttl(),
    }
    try:
        service.load_java_sandbox()
        java_info.update(
            {
                "available": True,
                "path": str(service.java_sandbox_path()),
                "digest": service.java_sandbox_digest(),
            }
        )
    except Exception as exc:  # noqa: BLE001 - 同上
        java_info["error"] = str(exc)

    try:
        cooldown = llm.cooldown_status()
    except Exception as exc:  # noqa: BLE001 - 同上：状态查不出来也不能 500
        cooldown = {"error": str(exc)}

    return _ok(
        {
            "ok": True,
            "llm": llm.public_config(),
            "llmCooldown": cooldown,
            "parser": parser_info,
            "java": java_info,
            "limits": {
                "maxPages": MAX_PAGES,
                "maxChars": MAX_CHARS,
                "maxAnalysisBatch": MAX_ANALYSIS_BATCH,
                "rateWindowSeconds": int(RATE_WINDOW),
                "rateMax": _rate_max(),
            },
        }
    )


# --------------------------------------------------------------------------
# POST /api/quiz/import/   PDF 文字 → 题库
# --------------------------------------------------------------------------

@require_POST
@csrf_protect
def import_bank(request):
    payload = _body(request)
    pages = payload.get("pages")
    if not isinstance(pages, list) or not pages:
        return _fail("pages 必填：形如 [[\"第1页第1行\", ...], ...]（浏览器用 pdf.js 抽好后传上来）")
    if len(pages) > MAX_PAGES:
        return _fail(f"页数太多：{len(pages)} 页，上限 {MAX_PAGES} 页")

    normalized: list[list[str]] = []
    total = 0
    for index, page in enumerate(pages, start=1):
        if isinstance(page, str):
            rows = page.split("\n")
        elif isinstance(page, list):
            rows = [str(x) for x in page]
        else:
            return _fail(f"第 {index} 页的格式不对：应该是字符串或字符串数组")
        total += sum(len(r) for r in rows)
        if total > MAX_CHARS:
            return _fail(f"文字太多：超过 {MAX_CHARS} 字符，建议只上传需要的那一部分")
        normalized.append(rows)

    use_llm = bool(payload.get("useLlm", True))
    prefer_cloud = payload.get("preferCloud")
    if prefer_cloud is not None and not isinstance(prefer_cloud, bool):
        return _fail("preferCloud 只能是 true / false，或者不传（不传＝跟随后端默认）")

    try:
        # 限流要放在 try 里面：不然 Throttled 会冒出去变成 500
        if use_llm:
            _throttle(request)
        result = service.bank_from_pages(
            normalized,
            bank_id=str(payload.get("bankId") or ""),
            title=str(payload.get("title") or ""),
            subject=str(payload.get("subject") or ""),
            source=str(payload.get("filename") or ""),
            use_llm=use_llm,
            prefer_cloud=prefer_cloud,
        )
    except llm.LlmNotConfigured as exc:
        return _fail(str(exc), status=424, code="llm_not_configured")
    except llm.LlmDisabled as exc:
        return _fail(str(exc), status=503, code="ai_disabled")
    except llm.LlmError as exc:
        return _fail(str(exc), status=424, code="llm_failed")
    except (ValueError, RuntimeError) as exc:
        return _fail(str(exc), status=400)
    except Throttled as exc:
        return _fail(str(exc), status=429, code="throttled")

    return _ok(result)


# --------------------------------------------------------------------------
# POST /api/quiz/elevate/   密码 → 短期通行证（危险接口要用）
# --------------------------------------------------------------------------

@require_POST
@csrf_protect
def elevate_view(request):
    """拿密码换一张 30 分钟有效的通行证。

    ⚠️ **这道校验才是真正的门**。前端的敲键序列（x s 9 9 9）只是"把密码框叫出来"，
    bundle 是公开可读的，谁都能看到那个序列 —— 所以秘密只能放在这里的密码里。

    幂等性/无状态：token 是 SECRET_KEY 签名的，服务端不存东西，
    所以 `uvicorn --workers 2` 的两个进程都认（存内存就会出现"一半请求还 403"）。
    """
    if not elevate.configured():
        # fail closed：没配密码就是没这个功能，绝不"没配就放行"
        return _fail(
            "没有配置提权密码（QUIZ_ELEVATE_PASSWORD），提权功能未启用",
            status=403,
            code="elevate_not_configured",
        )

    payload = _body(request)
    candidate = payload.get("password")
    if not isinstance(candidate, str) or not candidate:
        return _fail("password 必填")

    if elevate.too_many_tries(request):
        return _fail("密码试得太多了，过一会儿再试", status=429, code="throttled")

    elevate.note_try(request)
    token = elevate.issue(request, candidate)
    if not token:
        # 统一话术，不区分"密码错"和"没配密码"（别给攻击者当预言机）
        return _fail("密码不对", status=403, code="bad_password")

    elevate.reset_tries(request)
    return _ok({"ok": True, "token": token, "expiresIn": elevate.ttl()})


# --------------------------------------------------------------------------
# POST /api/quiz/java/run/   源码 → 真编译真运行（JavaWeb 代码题的判据）
# --------------------------------------------------------------------------

#: 代码题的"运行"是**交互式**的，学生按一次要一次，所以限额比 AI 接口宽得多；
#: 但它比 AI 便宜（不花钱），要防的只是"别把板子 CPU 打满"。
JAVA_RATE_WINDOW = 600.0
JAVA_RATE_MAX = 300
_JAVA_LOCK = threading.Lock()
_JAVA_HITS: dict[str, list[float]] = {}


def _java_throttle(request) -> None:
    now = time.time()
    ip = _client_ip(request)
    with _JAVA_LOCK:
        hits = [t for t in _JAVA_HITS.get(ip, []) if now - t < JAVA_RATE_WINDOW]
        if len(hits) >= JAVA_RATE_MAX:
            raise Throttled(f"跑得太频繁了（{JAVA_RATE_WINDOW / 60:.0f} 分钟内上限 {JAVA_RATE_MAX} 次）")
        hits.append(now)
        _JAVA_HITS[ip] = hits


@require_POST
@csrf_protect
def java_run(request):
    """真编译 + 真运行一段 Java，返回可断言的结果。

    ⚠️ **两道锁，都得过**：
      ① `QUIZ_JAVA_ENABLED`（环境变量开关）= "这台机器允许跑 Java"（默认关）
      ② 提权 token = "这个人现在被授权了"
    这么设计是因为公网可达：光靠"站内敲个序列"不是安全边界（见 elevate.py 的注释）。
    """
    if not service.java_enabled():
        return _fail(
            "服务器没有打开 Java 真跑（QUIZ_JAVA_ENABLED）。"
            "这个接口会在服务器上执行提交的代码，所以默认关闭 —— "
            "把环境变量 QUIZ_JAVA_ENABLED=1 配上并重启后端。",
            status=403,
            code="java_disabled",
        )

    # 第二道锁：必须提过权。未提权时**不泄露**任何细节，只说到哪儿去解锁。
    if not elevate.is_elevated(request):
        return _fail(
            "这个操作需要在站内提权（在页面上依次按 x s 9 9 9，或调 /api/quiz/elevate/）",
            status=403,
            code="elevate_required",
        )

    payload = _body(request)
    sources = payload.get("sources")
    if not isinstance(sources, dict) or not sources:
        return _fail('sources 必填：形如 {"Demo.java": "public class Demo { ... }"}')
    sources = {str(k): str(v) for k, v in sources.items()}

    params = payload.get("params") or []
    if not isinstance(params, list) or any(not isinstance(p, str) for p in params):
        return _fail("params 必须是字符串数组（Servlet 的请求参数，形如 name=张三）")

    try:
        _java_throttle(request)
        result = service.run_java_code(sources, params=params)
    except (ValueError, RuntimeError) as exc:
        return _fail(str(exc), status=400)
    except Throttled as exc:
        return _fail(str(exc), status=429, code="throttled")

    # ⚠️ 必须**嵌套**成 result：run_java 自己也返回一个 ok 字段（"编译运行成功了吗"），
    # 直接摊平到顶层会和接口级的 ok（"这次请求成功了吗"）撞车 ——
    # 编译失败时 HTTP 是 200（请求本身成功）但 ok=False，前端会以为接口挂了。
    return _ok({"ok": True, "result": result})


# --------------------------------------------------------------------------
# POST /api/quiz/graph/   把做过的题归纳成知识图谱
# --------------------------------------------------------------------------

#: 一次最多归纳多少道题。图谱是"归纳"任务，题目越多上下文越膨胀、
#: 本机模型越容易跑飞，所以给个明确上限，前端自己分批/抽样。
MAX_GRAPH_QUESTIONS = 120


@require_POST
@csrf_protect
def graph(request):
    payload = _body(request)
    questions = payload.get("questions")
    if not isinstance(questions, list) or not questions:
        return _fail("questions 必填：把想归纳的题目原样传上来")
    if len(questions) > MAX_GRAPH_QUESTIONS:
        return _fail(
            f"一次最多 {MAX_GRAPH_QUESTIONS} 道（当前 {len(questions)} 道）。"
            "知识点归纳不需要整库，挑最近做错的、或某个章节的就够了。"
        )

    for index, item in enumerate(questions, start=1):
        if not isinstance(item, dict) or not item.get("stem"):
            return _fail(f"第 {index} 条不是合法题目（至少要有个 stem）")

    try:
        _throttle(request)
        result = service.build_graph(questions)
    except llm.LlmNotConfigured as exc:
        return _fail(str(exc), status=424, code="llm_not_configured")
    except llm.LlmDisabled as exc:
        return _fail(str(exc), status=503, code="ai_disabled")
    except llm.LlmError as exc:
        return _fail(str(exc), status=424, code="llm_failed")
    except Throttled as exc:
        return _fail(str(exc), status=429, code="throttled")
    except ValueError as exc:
        return _fail(str(exc))

    return _ok(result)


# --------------------------------------------------------------------------
# POST /api/quiz/analysis/   AI 补解析（分批调用，服务端有缓存）
# --------------------------------------------------------------------------

@require_POST
@csrf_protect
def analysis(request):
    payload = _body(request)
    questions = payload.get("questions")
    if not isinstance(questions, list) or not questions:
        return _fail("questions 必填：把「还没有解析」的题目原样传上来")
    if len(questions) > MAX_ANALYSIS_BATCH:
        return _fail(
            f"一次最多 {MAX_ANALYSIS_BATCH} 道（当前 {len(questions)} 道）。"
            "请分批调用，这样每次都在 nginx 的 120s 超时之内。"
        )

    for index, item in enumerate(questions, start=1):
        if not isinstance(item, dict) or not item.get("stem"):
            return _fail(f"第 {index} 条不是合法题目（至少要有个 stem）")

    try:
        _throttle(request)
        result = service.add_analysis(
            str(payload.get("bankId") or ""),
            questions,
            # force=true 绕过**读**缓存，拿一份新的生成结果。
            # 用户点「重新生成解析」就是嫌旧的那份不好用，此时给缓存等于没反应。
            # 生成完仍然写回缓存，所以不会越点越乱。
            use_cache=not bool(payload.get("force")) and bool(payload.get("useCache", True)),
            domain=str(payload.get("domain") or ""),
        )
    except llm.LlmNotConfigured as exc:
        return _fail(str(exc), status=424, code="llm_not_configured")
    except llm.LlmDisabled as exc:
        return _fail(str(exc), status=503, code="ai_disabled")
    except llm.LlmError as exc:
        return _fail(str(exc), status=424, code="llm_failed")
    except Throttled as exc:
        return _fail(str(exc), status=429, code="throttled")

    return _ok(result)


# --------------------------------------------------------------------------
# POST /api/quiz/review/   AI 批改学生自己写的代码（演武场的「让 AI 检查」）
#
# 这是任务回路的最后半步：学生写完 → 运行看到真实结果 → 他觉得行了 → 这里给反馈。
# 和上面的 tutor/diagnose 是同一类接口（会花钱），所以三处保持一致：
#   · _body() 包在 try 里（上面几个老视图把 _body() 放在 try 外，非法 JSON 会 500）；
#   · _throttle 在 try 里（放外面 Throttled 会冒出去变成 500）；
#   · 没配模型 → 503 + llm_not_configured，把 llm.py 那句**中文**说明原样带出去
#     （不要 500、不要英文异常）。
# --------------------------------------------------------------------------

@require_POST
@csrf_protect
def review(request):
    """{goal, code, lang, output} → {ok, summary, points, next}。

    ⚠️ `code` / `output` 是**不可信输入**。这里只做"是不是字符串 / 长不长"，
    真正把它们当数据处理的是提示词那一层（见 prompts.REVIEW_*：定界符 + 明说不可执行）。
    """
    try:
        payload = _body(request)
    except ValueError as exc:
        return _fail(f"请求体不是合法 JSON：{exc}")

    code = payload.get("code")
    if not isinstance(code, str) or not code.strip():
        return _fail("code 必填：把学生写的代码原样传上来（字符串）")

    for field in ("goal", "output", "lang"):
        value = payload.get(field)
        if value is not None and not isinstance(value, str):
            return _fail(f"{field} 必须是字符串（可以不传或传空串）")

    try:
        _throttle(request)
        result = service.review_code(
            goal=str(payload.get("goal") or ""),
            code=code,
            lang=str(payload.get("lang") or ""),
            output=str(payload.get("output") or ""),
        )
    except llm.LlmNotConfigured as exc:
        # 没配模型是完全正常的一种状态（板子可能压根没配 key）：给人话，别 500
        return _fail(str(exc), status=424, code="llm_not_configured")
    except llm.LlmDisabled as exc:
        return _fail(str(exc), status=503, code="ai_disabled")
    except llm.LlmError as exc:
        return _fail(str(exc), status=424, code="llm_failed")
    except Throttled as exc:
        return _fail(str(exc), status=429, code="throttled")
    except (ValueError, RuntimeError) as exc:
        return _fail(str(exc), status=400)

    return _ok(result)


# --------------------------------------------------------------------------
# POST /api/quiz/task/   课本这一章 + 他的弱项 → 一个**任务**
#
# 这是任务回路的**左半段**：站主要的顺序是
#   课本 → 按他的基础生成【任务】 → 他做 → 运行看结果 → 他觉得行了 → AI 批改
# 右半段（/review/ + 那个「让 AI 检查」）已经在线上了，这里补上前面那半步。
#
# 和 /generate/ 的区别（别把两个接口合成一个）：
#   · /generate/ 产出的是**题**（有选项、有对错，做完只拿到一个字母）；
#   · 这里产出的是**任务**（要你做出什么 + 什么算完成），学生做完能就地运行、就地交给 AI 检查。
#
# 三处和 /review/ 保持一致的约定（它们都会花钱，行为必须一样）：
#   · _body() 包在 try 里（非法 JSON → 400，不是 500）；
#   · _throttle 在 try 里（放外面 Throttled 会冒出去变成 500）；
#   · 模型这条路不通 → 424 + llm_not_configured / llm_failed，把 llm.py 那句**中文**说明
#     原样带出去。★ 4xx 不是 5xx：Cloudflare 会把源站 5xx 换成它自己的错误页，
#     我们那句中文会被吃掉（2026-10-11 线上实测，见 PRODUCT.md §5.4）。
# --------------------------------------------------------------------------

@require_POST
@csrf_protect
def task(request):
    """{material, weak, lang, level, scope} → {ok, goal, why, quote, start, done, hint, lang, fromPage, scope}。

    ⚠️ `material`（教材文字）和 `weak`（错题标签）都是**不可信输入**：
    这里只做"是不是字符串 / 是不是数组 / 长不长"，真正把它们当数据处理的是
    提示词那一层（prompts.TASK_*：定界符 + 明说不可执行），以及 service 里
    对引文的逐字命中校验。
    """
    try:
        payload = _body(request)
    except ValueError as exc:
        return _fail(f"请求体不是合法 JSON：{exc}")

    material = payload.get("material")
    if not isinstance(material, str) or not material.strip():
        return _fail("material 必填：把课本这一章的文字原样传上来（预习页上那一份）")

    weak = payload.get("weak")
    if weak is not None and not isinstance(weak, list):
        return _fail('weak 必须是数组：形如 [{"tag":"数组遍历","wrong":3,"total":5}]；没有就传空数组')

    for field in ("lang", "level", "scope"):
        value = payload.get(field)
        if value is not None and not isinstance(value, str):
            return _fail(f"{field} 必须是字符串（可以不传）")

    try:
        _throttle(request)
        result = service.task_from_material(
            material,
            weak or [],
            lang=str(payload.get("lang") or "java"),
            level=str(payload.get("level") or "在学"),
            # 取材范围那个开关：不传 = 默认「允许补充」（站主说的"放宽吧"）。
            # 认不出的值由 service 报 400 中文说明 —— 判据只有一份，别在这里再写一遍。
            scope=str(payload.get("scope") or ""),
        )
    except llm.LlmNotConfigured as exc:
        # 没配模型是完全正常的一种状态（板子可能压根没配 key）：给人话，别 500
        return _fail(str(exc), status=424, code="llm_not_configured")
    except llm.LlmDisabled as exc:
        return _fail(str(exc), status=503, code="ai_disabled")
    except llm.LlmError as exc:
        return _fail(str(exc), status=424, code="llm_failed")
    except Throttled as exc:
        return _fail(str(exc), status=429, code="throttled")
    except (ValueError, RuntimeError) as exc:
        return _fail(str(exc), status=400)

    return _ok(result)


# --------------------------------------------------------------------------
# POST /api/quiz/generate/   根据材料出题
# --------------------------------------------------------------------------

@require_POST
@csrf_protect
def generate(request):
    payload = _body(request)
    material = str(payload.get("material") or "")
    if len(material) > MAX_CHARS:
        return _fail(f"材料太长：超过 {MAX_CHARS} 字符，建议分段生成")

    try:
        count = int(payload.get("count") or 10)
    except (TypeError, ValueError):
        return _fail("count 必须是数字")
    if not 1 <= count <= 60:
        return _fail("count 要在 1~60 之间")

    types = payload.get("types")
    if types is not None and not isinstance(types, list):
        return _fail("types 必须是数组，比如 [\"single\",\"judge\"]")

    # 「哪条模型来源打头」的开关（前端设置里那三档）。三态，**不能用 falsy 判**：
    #   不传 / null → 跟随后端默认（docs 默认云端，其余先本机）
    #   true        → 云端先上（精确任务：教材出题要求逐字引用原文，小模型干不了）
    #   false       → 明确允许本机先上（省钱 / 离线）
    prefer_cloud = payload.get("preferCloud")
    if prefer_cloud is not None and not isinstance(prefer_cloud, bool):
        return _fail("preferCloud 只能是 true / false，或者不传（不传＝跟随后端默认）")

    try:
        _throttle(request)
        result = service.generate_bank(
            material,
            count=count,
            types=[str(t) for t in types] if types else None,
            title=str(payload.get("title") or ""),
            subject=str(payload.get("subject") or ""),
            domain=str(payload.get("domain") or ""),
            prefer_cloud=prefer_cloud,
        )
    except llm.LlmNotConfigured as exc:
        return _fail(str(exc), status=424, code="llm_not_configured")
    except llm.LlmDisabled as exc:
        return _fail(str(exc), status=503, code="ai_disabled")
    except llm.LlmError as exc:
        return _fail(str(exc), status=424, code="llm_failed")
    except (ValueError, RuntimeError) as exc:
        return _fail(str(exc), status=400)
    except Throttled as exc:
        return _fail(str(exc), status=429, code="throttled")

    return _ok(result)


# --------------------------------------------------------------------------
# 账号：注册 / 登录 / 登出 / 我是谁
#
# 用的是 Django 自带的 session 认证（和 /admin/、人物画像同一套），不引入 JWT：
# 同一台板子、同一个数据库，多一套 token 就多一处会过期/会配错的地方。
#
# CSRF 按仓库既有约定（和 apps/agency/api/auth_views.py 一致）：
#   GET  auth/me/  带 @ensure_csrf_cookie，把 csrftoken 种进 cookie
#   POST auth/*    带 @csrf_protect，前端从 cookie 读 token 放进 X-CSRFToken
# 为什么登录接口也必须校验：不校验就是"登录 CSRF"（攻击者把你登录成他的账号，
# 你后面刷的进度全记到他名下）。
#
# 注册档位（open / key / closed）与限流都在 accounts.py，这里的视图只负责"翻译成 JSON"。
# --------------------------------------------------------------------------


@require_GET
@ensure_csrf_cookie
def auth_me(request):
    """我是谁 + 注册开不开。

    ⚠️ 这个接口**每次启动都该先调**：
      ① 它顺手把 csrftoken 种到 cookie 里（后面所有 POST 都要用）；
      ② 前端靠它知道"要不要显示登录入口、注册页要不要邀请码"。
    """
    payload = {
        "ok": True,
        "authenticated": False,
        "signup": accounts.signup_public(),
    }
    if accounts.signed_in(request):
        payload["authenticated"] = True
        payload["user"] = accounts.user_payload(request.user)
    return _ok(payload)


@require_POST
@csrf_protect
def auth_register(request):
    """注册。body: {"username":…, "password":…, "nickname":可选, "key":邀请码(仅 key 档)}

    注册成功**直接登录**（不要让人刚设完密码再输一遍）。
    """
    try:
        payload = _body(request)
    except ValueError as exc:
        return _fail(f"请求体不是合法 JSON：{exc}")

    mode = accounts.signup_mode()
    if mode == "closed":
        return _fail("暂时关闭了自助注册，请联系老师开号", status=403, code="signup_closed")

    wait = accounts.check_rate("signup", _client_ip(request), accounts.signup_limit())
    if wait:
        return _fail(accounts.wait_message(wait), status=429, code="throttled", retryAfter=wait)

    if mode == "key" and not accounts.check_signup_key(payload.get("key")):
        return _fail("邀请码不对 —— 找老师要一个", status=400, code="signup_key")

    try:
        username = accounts.validate_username(payload.get("username"))
        nickname = accounts.validate_nickname(payload.get("nickname"))
        password = accounts.validate_new_password(payload.get("password"), username)
    except ValueError as exc:
        return _fail(str(exc), status=400, code="invalid")

    if accounts.username_taken(username):
        return _fail("这个用户名已经有人用了，换一个", status=400, code="username_taken")

    try:
        with transaction.atomic():
            user, _account = accounts.create_account(username, password, nickname)
    except IntegrityError:
        # 两个人同时注册同一个名字：唯一约束兜住（不能只靠上面那句 exists 查询）
        return _fail("这个用户名已经有人用了，换一个", status=400, code="username_taken")

    login(request, user)
    return _ok(
        {"ok": True, "user": accounts.user_payload(user), "signup": accounts.signup_public()},
        status=201,
    )


@require_POST
@csrf_protect
def auth_login(request):
    """登录。body: {"username":…, "password":…}

    两条限流（按 IP + 按账号）都在 accounts.py 里：只按 IP 挡不住分布式撞库，
    只按账号挡不住"一个常用密码撞一堆账号"。
    """
    try:
        payload = _body(request)
    except ValueError as exc:
        return _fail(f"请求体不是合法 JSON：{exc}")

    username = str(payload.get("username") or "").strip()
    password = str(payload.get("password") or "")
    if not username or not password:
        return _fail("请填用户名和密码")

    per_ip, per_name = accounts.login_limits()
    wait = accounts.check_rate("login_ip", _client_ip(request), per_ip) or accounts.check_rate(
        "login_name", username.lower(), per_name
    )
    if wait:
        return _fail(accounts.wait_message(wait), status=429, code="throttled", retryAfter=wait)

    user = authenticate(request, username=username, password=password)
    if user is None:
        # 不区分"用户不存在"/"密码不对"/"账号已停用" —— 否则这个接口就成了账号枚举器。
        # ⚠️ 停用的账号走的就是这里：Django 默认的 ModelBackend 对 `is_active=False`
        #    直接返回 None（`user_can_authenticate`），压根轮不到写"这个账号已停用"。
        #    这是**特意保留**的行为：那句话说出去，等于告诉猜密码的人"这个号真的存在"。
        return _fail("用户名或密码不对", status=400, code="bad_credentials")

    login(request, user)
    return _ok({"ok": True, "user": accounts.user_payload(user)})


@require_POST
@csrf_protect
def auth_logout(request):
    """登出。没登录也返回 200 —— 前端不必为"已经登出"再写一套分支。

    ⚠️ 登出**不动本机进度**（谁会希望登出把错题本清空）：服务端那份还在账号里，
    下次登录会合并回来。
    """
    logout(request)
    return _ok({"ok": True})


# --------------------------------------------------------------------------
# 进度同步：GET /api/quiz/state/   POST /api/quiz/state/   POST /api/quiz/state/reset/
#
# 一个账号 + 一套题库 = 一行 JSON（见 models.QuizState）。合并规则在 qstate.py，
# 这里只管"鉴权 + 取行 + 存行"。
#
# ⚠️ 为什么"保存"也返回合并后的结果：两台设备都会推自己的那份，
# 谁先谁后说不准。让**每次写都返回合并后的全量**，前端拿回来覆盖本机 ——
# 这样无论顺序如何，两边最终收敛到同一份（不用再写一套"改完要再拉一遍"的时序）。
# --------------------------------------------------------------------------

#: 题库 id 上限（和 models.QuizState.bank_id 的 max_length 对齐）
MAX_BANK_ID = 120


def _bank_id(raw) -> str | None:
    """校验题库 id。返回 None = 不合法（调用方给 400）。"""
    value = str(raw or "").strip()
    if len(value) > MAX_BANK_ID:
        return None
    if any(ord(ch) < 32 for ch in value):
        return None
    return value


def _state_payload(request, bank: str, state: dict, updated_at="", **extra) -> JsonResponse:
    return _ok(
        {
            "ok": True,
            "bank": bank,
            "state": state,
            "updatedAt": updated_at,
            "serverTime": int(time.time() * 1000),
            **extra,
        }
    )


def _require_login(request):
    if accounts.signed_in(request):
        return None
    return _fail("先登录才能同步进度", status=401, code="login_required")


@require_GET
def state_get(request):
    """取账号里的进度。

    带 `?bank=<id>` → 那套题库的进度；
    不带 → 这个账号有哪些题库有进度（给"我的账号"页做列表用）。
    """
    gate = _require_login(request)
    if gate:
        return gate

    bank = _bank_id(request.GET.get("bank"))
    if bank is None:
        return _fail(f"bank 参数不合法（最多 {MAX_BANK_ID} 个字符）")
    if not bank:
        rows = QuizState.objects.filter(user=request.user).order_by("-updated_at")[
            : qstate.MAX_BANKS_PER_USER
        ]
        return _ok(
            {
                "ok": True,
                "banks": [
                    {
                        "bank": row.bank_id,
                        "updatedAt": row.updated_at.isoformat(),
                        "empty": qstate.state_is_empty(qstate.normalize_state(row.data)),
                    }
                    for row in rows
                ],
            }
        )

    row = QuizState.objects.filter(user=request.user, bank_id=bank).first()
    state = qstate.normalize_state(row.data if row else {})
    return _state_payload(
        request, bank, state, row.updated_at.isoformat() if row else "", exists=bool(row)
    )


@require_POST
@csrf_protect
def state_save(request):
    """存进度。body: {"bank":…, "state":{…}} → 返回**合并后**的进度。

    ⚠️ 空进度**不覆盖**账号里那份：新设备（本机什么都没有）第一次同步时先推后拉，
    要是让空进度赢，学生一换设备错题本就全没了。所以空推送直接返回服务端那份。
    """
    gate = _require_login(request)
    if gate:
        return gate

    try:
        payload = _body(request)
    except ValueError as exc:
        return _fail(f"请求体不是合法 JSON：{exc}")

    bank = _bank_id(payload.get("bank"))
    if not bank:
        return _fail("bank 必填（哪套题库的进度）")

    incoming = qstate.normalize_state(payload.get("state"))
    if qstate.state_size(incoming) > qstate.MAX_STATE_BYTES:
        return _fail(
            f"这份进度太大了（上限 {qstate.MAX_STATE_BYTES // 1024 // 1024}MB），这次没有保存",
            status=400,
            code="state_too_large",
        )

    row = QuizState.objects.filter(user=request.user, bank_id=bank).first()
    if row is None:
        if qstate.state_is_empty(incoming):
            # 没有任何东西可存：不建行，直接告诉他账号里现在是空的
            return _state_payload(request, bank, incoming, exists=False, created=False)
        if QuizState.objects.filter(user=request.user).count() >= qstate.MAX_BANKS_PER_USER:
            return _fail(
                f"一个账号最多同步 {qstate.MAX_BANKS_PER_USER} 套题库的进度", status=400,
                code="too_many_banks",
            )
        row = QuizState(user=request.user, bank_id=bank, data={})

    if qstate.state_is_empty(incoming) and not qstate.state_is_empty(
        qstate.normalize_state(row.data)
    ):
        merged, conflicts = qstate.normalize_state(row.data), {"notes": 0, "fav": 0, "diagram": 0}
        skipped = True
    else:
        merged, conflicts = qstate.merge_state(row.data, incoming)
        skipped = False

    # 合并后反而超限（两边各自都合法、加起来不合法）：宁可不存，也不截断学生的数据
    if qstate.state_size(merged) > qstate.MAX_STATE_BYTES:
        return _fail(
            "两份进度合起来太大了（上限 "
            f"{qstate.MAX_STATE_BYTES // 1024 // 1024}MB），这次没有保存。"
            "可以先在设置里清空一下学习记录再试。",
            status=400,
            code="state_too_large",
        )

    row.data = merged
    row.save()

    return _state_payload(
        request,
        bank,
        merged,
        row.updated_at.isoformat(),
        conflicts=conflicts,
        skipped=skipped,
        exists=True,
        created=False,
    )


@require_POST
@csrf_protect
def state_reset(request):
    """把账号里某套题库的进度**删掉**（学生点"重置进度"时用）。

    为什么删除要单独一个接口、而不是"推一份空的上去"：
    合并规则是**并集**，空推送会被服务端那份原样顶回来（那正是"清空了刷新又回来"）。
    删除是明确的意图，就用明确的动作表达 —— 不留时间戳、不留墓碑，直接删行。
    """
    gate = _require_login(request)
    if gate:
        return gate

    try:
        payload = _body(request)
    except ValueError as exc:
        return _fail(f"请求体不是合法 JSON：{exc}")

    bank = _bank_id(payload.get("bank"))
    if not bank:
        return _fail("bank 必填（要清哪套题库的进度）")

    deleted, _detail = QuizState.objects.filter(user=request.user, bank_id=bank).delete()
    return _ok({"ok": True, "bank": bank, "deleted": bool(deleted)})


# --------------------------------------------------------------------------
# POST /api/quiz/tutor/      AI 教练：就着某一道题多轮追问
# POST /api/quiz/diagnose/   错题诊断：归纳薄弱考点
#
# 这两个是给驾考站加的。它们和上面几个接口的三处不同，都是刻意的：
#   ① 🔴 _body() 包在 try 里。上面几个视图的 _body() 在 try 之外，
#      非法 JSON 抛的 ValueError 没人接 → 500（不是 400）。新接口不重复这个坑。
#   ② 输出是**自然语言**不是 JSON，所以 service 层直接走 chat_with_fallback。
#   ③ 上下文（对话轮数 / 错题条数）要设上限，否则一次请求能把模型上下文撑爆。
# --------------------------------------------------------------------------

MAX_TUTOR_HISTORY = 12
MAX_DIAGNOSE_WRONGS = 40


@require_POST
@csrf_protect
def tutor(request):
    try:
        payload = _body(request)
    except ValueError as exc:
        return _fail(f"请求体不是合法 JSON：{exc}")

    question = payload.get("question")
    if not isinstance(question, dict) or not question.get("stem"):
        return _fail("question 必填：至少要有 stem（把当前这道题传上来）")

    message = str(payload.get("message") or "").strip()
    if not message:
        return _fail("message 不能为空：把学员的问题传上来")

    history = payload.get("history") or []
    if not isinstance(history, list):
        return _fail("history 必须是数组（[{{role,content}}]），没有就传空数组或省略")
    if len(history) > MAX_TUTOR_HISTORY:
        # 截断而不是报错：前端多带了几轮不该让学员问不成
        history = history[-MAX_TUTOR_HISTORY:]

    try:
        _throttle(request)
        result = service.tutor(
            question,
            message,
            history=history,
            domain=str(payload.get("domain") or ""),
        )
    except llm.LlmNotConfigured as exc:
        return _fail(str(exc), status=424, code="llm_not_configured")
    except llm.LlmDisabled as exc:
        return _fail(str(exc), status=503, code="ai_disabled")
    except llm.LlmError as exc:
        return _fail(str(exc), status=424, code="llm_failed")
    except Throttled as exc:
        return _fail(str(exc), status=429, code="throttled")
    except (ValueError, RuntimeError) as exc:
        return _fail(str(exc), status=400)

    return _ok(result)


@require_POST
@csrf_protect
def diagnose(request):
    try:
        payload = _body(request)
    except ValueError as exc:
        return _fail(f"请求体不是合法 JSON：{exc}")

    wrongs = payload.get("wrongs")
    if not isinstance(wrongs, list) or not wrongs:
        return _fail("wrongs 必填：把错题（含 stem / answer / picked）传上来")
    if len(wrongs) > MAX_DIAGNOSE_WRONGS:
        return _fail(
            f"一次最多 {MAX_DIAGNOSE_WRONGS} 道错题（当前 {len(wrongs)} 道）。"
            "请先挑最近做错的那些，不必把整个错题本都发上来。"
        )

    for index, item in enumerate(wrongs, start=1):
        if not isinstance(item, dict) or not item.get("stem"):
            return _fail(f"第 {index} 条不是合法错题（至少要有个 stem）")

    try:
        _throttle(request)
        result = service.diagnose(
            wrongs,
            subject=str(payload.get("subject") or ""),
            domain=str(payload.get("domain") or ""),
        )
    except llm.LlmNotConfigured as exc:
        return _fail(str(exc), status=424, code="llm_not_configured")
    except llm.LlmDisabled as exc:
        return _fail(str(exc), status=503, code="ai_disabled")
    except llm.LlmError as exc:
        return _fail(str(exc), status=424, code="llm_failed")
    except Throttled as exc:
        return _fail(str(exc), status=429, code="throttled")
    except (ValueError, RuntimeError) as exc:
        return _fail(str(exc), status=400)

    return _ok(result)

