"""OpenAI 兼容接口的极简客户端 —— **只用标准库**。

为什么不用 openai / requests：
    aarch64 / Python 3.x 的某些发行版 venv 是 uv 管的（连 pip 都没有），
    每多一个运行时依赖，就多一次「装不上」的风险。
    urllib 已经够了：一次 POST、读一个 JSON。

配置全部走环境变量（生产写在 .env / systemd 的 EnvironmentFile，dev 写 shell 都行）：
    QUIZ_LLM_API_KEY        必填。不填就整体降级成「只能用规则解析」，不报错、不崩。
    QUIZ_LLM_BASE_URL       默认 https://api.deepseek.com/v1
    QUIZ_LLM_MODEL          默认 deepseek-chat
    QUIZ_LLM_TIMEOUT        单次请求超时秒数，默认 90
    QUIZ_LLM_LOCAL_COOLDOWN 本机在某个 task 上失败后的冷却秒数，默认 600。
                            0 = 关掉自适应短路（永远先试本机）。详见 local_blocked()

AI 功能总开关：
    QUIZ_LLM_DISABLED=1     整个 LLM 模块全部返回 ``LlmDisabled`` 异常，
                            前端调任何 AI 接口都会拿到 503 + ``ai_disabled`` 错误码。
                            这是开源版的默认行为 —— 不配 key 也能跑，但 AI 按钮不工作。
                            把环境变量去掉（或者设为 0），并配上 QUIZ_LLM_API_KEY，
                            AI 功能立刻启用，无需改任何代码。

密钥只从环境变量读：既不写进代码，也不回传给前端，
/api/quiz/status/ 只告诉前端「配没配、用的哪个模型」。

来源有两条路，权重是用户定的：**先本机，本机顶不住再升级到云端；
云端不可用（没钱/失效/限流/超时）就退回本机那次的结果，绝不让请求整体失败**。
实现在 chat_with_fallback()，被降级链选中的顺序由 sources() 给出。
chat() 是「只发一次请求」的底层函数，不掺和选谁的问题。

在此之上还有一层**自适应短路**：本机在某个 task（补解析 / 出题 / 图谱 / 导入）上
刚失败过，接下来 QUIZ_LLM_LOCAL_COOLDOWN 秒内就不再去试它，直接走云端 ——
但仍然守着「两条路都得活着」：云端要是不在链子上或正在冷却，本机照试不误。
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request

DEFAULT_BASE_URL = "https://api.deepseek.com/v1"
DEFAULT_MODEL = "deepseek-chat"

#: 没配云端密钥时，按顺序找这些**本机**上的 OpenAI 兼容服务。
#: 板子有 14G 内存却一直"AI 不可用"，只是因为没人给它配 key ——
#: 而 Ollama / LM Studio 这类本地服务根本不需要 key。先探本机再谈配不配。
LOCAL_CANDIDATES = (
    "http://127.0.0.1:11435",  # 板子上的 NPU 服务（tools/npu_llm_server.py 包 Genie）
    "http://127.0.0.1:11434",  # Ollama 默认端口
    "http://127.0.0.1:1234",  # LM Studio / llama.cpp server 常用端口
)
LOCAL_PROBE_TTL = 60.0  # 探测结果缓存 60 秒，别每次调用都去连一圈
_local_cache: dict = {"at": 0.0, "value": None, "done": False}

#: 依次找这几个环境变量，谁先有值用谁的 —— 不同人手上的 key 名字不一样
KEY_ENVS = (
    "QUIZ_LLM_API_KEY",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "DASHSCOPE_API_KEY",
    "ZHIPUAI_API_KEY",
    "MOONSHOT_API_KEY",
)


class LlmError(RuntimeError):
    """调用失败（网络、限流、返回格式不对…）。消息是给人看的。"""


class LlmNotConfigured(LlmError):
    """服务器没配密钥。前端要靠这个类型给出「怎么配」的提示。"""


class LlmDisabled(LlmError):
    """整个 LLM 模块被 ``QUIZ_LLM_DISABLED=1`` 关掉。

    开源版默认走这条 —— 不配 key 也能跑，但 AI 接口全部返 503 + ai_disabled。
    views.py 把这个异常映射成 HTTP 503 / ``code=ai_disabled``。
    """


class LlmHttpError(LlmError):
    """带 HTTP 状态码的调用失败。

    降级链必须能区分两种失败，否则「缓存坏消息」这件事没法做对：

        401/402/403  余额不足、key 失效 —— 不会自己好，记住别再撞（TTL 10 分钟）
        429/5xx/超时/网络抖动 —— 会自己好，只能短冷却（30 秒）

    原来的代码只把状态码拼成一句 f"HTTP {code}" 的字符串，想分辨就只能去正则里
    抠数字 —— 抠错一次就多花一次钱（或者把「限流十秒」当成「整天不可用」）。
    所以把状态码挂在异常对象上，不靠解析文案。
    """

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = int(status)


def _probe_local(base: str, timeout: float = 1.5) -> dict | None:
    """探一个本机端点，认出它是什么、装了哪些模型。

    Ollama 用 /api/tags（返回 {"models":[{"name":...}]}），
    LM Studio / llama.cpp 用 OpenAI 的 /v1/models（返回 {"data":[{"id":...}]}）。
    两个都试，谁先给出模型列表就用谁。
    """
    base = base.rstrip("/")
    for path, key, kind in (("/api/tags", "models", "ollama"), ("/v1/models", "data", "openai")):
        try:
            with urllib.request.urlopen(f"{base}{path}", timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8", "replace"))
        except Exception:  # noqa: BLE001 - 探测失败是常态（没装就是没装），不该抛
            continue
        rows = payload.get(key) if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            continue
        names = [row.get("name") or row.get("id") for row in rows if isinstance(row, dict)]
        names = [n for n in names if n]
        if names:
            return {"baseUrl": f"{base}/v1", "model": names[0], "kind": kind, "models": names}
    return None


def detect_local(*, force: bool = False) -> dict | None:
    """找本机可用的 OpenAI 兼容服务；找不到返回 None。结果缓存 60 秒。

    `QUIZ_LLM_DISABLE_LOCAL=1` 可以整个关掉这个探测：只想用云端的人不需要它，
    而单测/CI 里也不该去连本机端口（Windows 上防火墙会静默丢包，
    一次探测就要白等 1.5 秒）。
    """
    now = time.monotonic()
    if not force and _local_cache["done"] and now - _local_cache["at"] < LOCAL_PROBE_TTL:
        return _local_cache["value"]

    if (os.environ.get("QUIZ_LLM_DISABLE_LOCAL") or "").strip() == "1":
        _local_cache.update({"at": now, "value": None, "done": True})
        return None

    explicit = (os.environ.get("QUIZ_LLM_LOCAL_URL") or "").strip()
    candidates = [explicit] if explicit else list(LOCAL_CANDIDATES)
    found = None
    for base in candidates:
        if not base:
            continue
        found = _probe_local(base)
        if found:
            break
    _local_cache.update({"at": now, "value": found, "done": True})
    return found


def _first_key() -> str:
    """依次找 KEY_ENVS 里几个环境变量，谁先有值用谁 —— 不同人手上的 key 名字不一样。"""
    for name in KEY_ENVS:
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    return ""


def _disabled() -> bool:
    """整个 LLM 模块是否被禁用。

    设为 ``QUIZ_LLM_DISABLED=1`` 时返回 True，chat() / chat_with_fallback() / config() 等
    会直接抛 ``LlmDisabled`` —— views.py 把它映射成 HTTP 503 + ai_disabled。

    这是开源版的默认开关：**不配 key 也能跑**（PDF 规则解析、刷题、笔记、学习报告
    全都正常），AI 按钮点了会拿到清楚的"未启用"提示；用户配好 key 再启用即可，
    不需要碰代码。
    """
    return (os.environ.get("QUIZ_LLM_DISABLED") or "").strip().lower() in (
        "1", "true", "yes", "on"
    )


def _timeout() -> int:
    """单次请求超时秒数。板子上由 .env 覆盖成 600（见 tools/check_timeouts.py）。"""
    return int(os.environ.get("QUIZ_LLM_TIMEOUT") or "90")


def _local_timeout() -> int:
    """本机这一条**单次尝试**最多等多久（默认 40 秒）。

    为什么要有它：板子上是 4 核 ARM + qwen2.5:1.5b，出题这种活它算上 1~3 分钟很正常，
    而链路是"先本机、不行再升云端" → 用户在浏览器里等到的是 **Cloudflare 的 524**
    （边缘节点 ~100 秒就放弃），板子白烤一轮，真正的云端一次都没试过。
    用户原话：「除了让我的机器发热占我资源，什么用都没有，它吐不出题目就该用云了呀」。

    给了上限之后：本机 40 秒内出不来 → 算它没扛住 → 立刻升云端，整个请求通常 60 秒内落地。
    **不是不给本机机会，是不让它独占整个请求。** `QUIZ_LLM_LOCAL_TIMEOUT=0` 关掉这个上限。
    """
    raw = (os.environ.get("QUIZ_LLM_LOCAL_TIMEOUT") or "").strip()
    if not raw:
        return 40
    try:
        return max(0, int(raw))
    except ValueError:
        return 40


def _local_budget() -> int:
    """本机这一条**总共**能花多久（默认 70 秒，含重试）。见 _local_timeout 的说明。"""
    raw = (os.environ.get("QUIZ_LLM_LOCAL_BUDGET") or "").strip()
    if not raw:
        return 70
    try:
        return max(0, int(raw))
    except ValueError:
        return 70


def _scrub(text: str) -> str:
    """把密钥从「要返回给前端 / 要记进状态」的文字里抹掉。

    错误细节是对方服务器给的，按理不会回显 key；但真有网关会把整段请求头塞进报错体，
    而我们会把这段文字一路带到 502 的 error 字段里（浏览器可见）。宁可多做一次替换。
    """
    key = _first_key()
    if key and key in text:
        text = text.replace(key, "***")
    return text


def _source_label(cfg: dict) -> str:
    """报错文案里怎么称呼这条来源 —— 「云端接口」还是「本机模型」。

    本机那一档出错时还写「云端接口返回…」会把人带偏（真踩过：本地 Ollama 没启动，
    报的却是云端，用户跑去查 key）。
    """
    return "云端接口" if (cfg or {}).get("source") == "cloud" else "本机模型"


def _local_config() -> dict | None:
    """本机那一档（不需要 key 的 OpenAI 兼容端点）。没装/没拉模型时返回 None。"""
    try:
        local = detect_local()
    except Exception:  # noqa: BLE001 - 探测本身不该让整条路炸掉
        return None
    if not local:
        return None
    return {
        # 本地服务不校验 key，但 HTTP 头里得有个东西
        "apiKey": "local",
        "baseUrl": local["baseUrl"],
        "model": local["model"],
        "timeout": _timeout(),
        "source": "local",
        "configured": True,
        "kind": local.get("kind") or "",
    }


def config() -> dict:
    """把「云端 key / 显式指定 / 本机模型」三种来源合成一份可用配置。

    source 会返回给前端显示，让人知道现在到底在用哪个：
        cloud     云端 key（QUIZ_LLM_API_KEY 之类）
        explicit  显式配了 QUIZ_LLM_BASE_URL + QUIZ_LLM_MODEL（本机 llama.cpp 之类，可能不需要 key）
        local     自动发现的本机服务（Ollama / LM Studio）
        disabled  ``QUIZ_LLM_DISABLED=1`` 关掉了整个模块
        none      什么都没有 —— 只用规则解析，AI 按钮会提示怎么配

    ⚠️ 这里选出的是「唯一那条」，**不是**降级链的顺序（链子请用 sources()）。
    它保留原来的优先级（云端 > 显式 > 本机）是按调用方的需要：限流档位、
    状态接口的向后兼容字段都读它。降级链的顺序（先本机后云端）另算。
    """
    if _disabled():
        return {
            "apiKey": "",
            "baseUrl": "",
            "model": "",
            "timeout": _timeout(),
            "source": "disabled",
            "configured": False,
        }
    key = _first_key()

    base_url = (os.environ.get("QUIZ_LLM_BASE_URL") or "").strip().rstrip("/")
    model = (os.environ.get("QUIZ_LLM_MODEL") or "").strip()
    source = "none"

    if key:
        source = "cloud"
    elif base_url and model:
        # 显式指定了地址和模型 —— 本地服务通常不需要 key，所以这也算配好了
        source = "explicit"
    else:
        local = detect_local()
        if local:
            base_url, model, source = local["baseUrl"], local["model"], "local"

    return {
        # 本地服务不校验 key，但 HTTP 头里得有个东西；顺手标出这是本机来源
        "apiKey": key or ("local" if source in ("local", "explicit") else ""),
        "baseUrl": base_url or DEFAULT_BASE_URL,
        "model": model or DEFAULT_MODEL,
        "timeout": _timeout(),
        "source": source,
        "configured": source != "none",
    }


def sources() -> list[dict]:
    """降级链上的候选来源，**按尝试顺序**：先本机，后云端。

    用户定的权重是「本地解决不了 —— 那就 api；api 没钱了 —— 只能本地」。
    落到这份列表上就是：本机排前面（不花钱），云端排后面（花钱）。
    两种来源同时活着是很常见的情况 —— 板子上既有 Ollama、.env 里也有 deepseek key，
    原来 config() 只挑一个（云端），本机那台就一直闲着。

    为什么还要先看 config()：它已经被 views（限流档位）、service（本机小批量）
    和一群单测当成「来源判定」的唯一真相。这里要是自己再读一遍环境变量，
    两处判定迟早会跑偏；而且单测直接 mock config() 就不再管用了。

    返回 [] 表示一条来源都没有 —— 调用方要按「没配模型」处理，
    而不是当成「配了但都失败了」（两者的报错文案完全不同）。
    """
    cfg = config()
    chain: list[dict] = []

    if cfg["source"] in ("local", "explicit"):
        chain.append(cfg)
    else:
        # config() 选了云端（因为配了 key），但本机可能也在跑。
        # 「先本机」这条策略真正起作用的就是这种机器：有 key、也有 Ollama。
        local = _local_config()
        if local:
            chain.append(local)

    if cfg["source"] == "cloud":
        chain.append(cfg)
    return chain


def primary_source() -> str:
    """链子上第一个来源 —— 前端显示、限流档位、本机小批量都按它算。"""
    chain = sources()
    return chain[0]["source"] if chain else "none"


def public_config() -> dict:
    """可以安全返回给前端的那部分配置（**不含密钥**）。

    chain 是降级链上真正会被尝试的顺序。只给一个 source 已经不够用了：
    有 key 又有本机 Ollama 时两条都活着，而且优先走本机。
    """
    cfg = config()
    cfgs = sources()
    return {
        "configured": cfg["configured"],
        "baseUrl": cfg["baseUrl"],
        "model": cfg["model"],
        "source": cfg["source"],  # cloud / explicit / local / none（向后兼容字段）
        "primary": cfgs[0]["source"] if cfgs else "none",  # 实际会先试哪条
        "chain": [
            {"source": item["source"], "model": item.get("model") or "", "baseUrl": item.get("baseUrl") or ""}
            for item in cfgs
        ],
    }


# --------------------------------------------------------------------------
# 云端的「暂时别去撞墙」状态
# --------------------------------------------------------------------------
#
# 为什么要有这个：板子上的 key 一旦余额不足（402）或失效（401），**每一个**请求
# 都会先规规矩矩去撞一次墙、等一个网络往返才降级回本机 —— 用户看到的是「每次
# 出结果都卡好几秒」，而账单那边其实早就不能用了。这类错误不会自己好，记下来。
#
# ⚠️ 反过来，429 限流 / 5xx / 超时 / 网络抖动是**会自己好**的。它们绝不能按
# 10 分钟去拉黑云端 —— 那会把「限流十秒」放大成「一整天用不了云端」。
# 所以只有很短的冷却，且标记成 dead=False，让调用方知道性质不一样。

#: 不会自己好的状态码：401 认证失败、402 余额不足、403 没权限
CLOUD_DEAD_STATUSES = (401, 402, 403)
#: 「去充值 / 去换 key」级别的冷却时长
CLOUD_DEAD_TTL = 600.0
#: 「等一会可能就好」级别的冷却时长
CLOUD_SOFT_TTL = 30.0

_cloud_state: dict = {"until": 0.0, "status": 0, "reason": "", "dead": False}


def reset_cloud_state() -> None:
    """清掉云端冷却状态（换 key、充值后，以及单测之间）。"""
    _cloud_state.update({"until": 0.0, "status": 0, "reason": "", "dead": False})


def cloud_blocked() -> dict | None:
    """云端现在是不是处于冷却期；是则返回原因和剩余秒数，否则 None。"""
    now = time.monotonic()
    if now >= _cloud_state["until"]:
        return None
    return {
        "status": _cloud_state["status"],
        "reason": _cloud_state["reason"],
        "dead": _cloud_state["dead"],
        "remain": _cloud_state["until"] - now,
    }


def _mark_cloud_failure(exc: BaseException) -> None:
    """云端失败后记一笔，让接下来的一段时间别再白撞一次。

    401/402/403 记 10 分钟；其它（429/超时/网络/5xx）只记 30 秒。
    """
    status = int(getattr(exc, "status", 0) or 0)
    dead = status in CLOUD_DEAD_STATUSES
    _cloud_state.update(
        {
            "until": time.monotonic() + (CLOUD_DEAD_TTL if dead else CLOUD_SOFT_TTL),
            "status": status,
            "reason": _scrub(str(exc)),
            "dead": dead,
        }
    )


# --------------------------------------------------------------------------
# 本机在某个 task 上的「暂时别去试」状态（自适应短路）
# --------------------------------------------------------------------------
#
# 为什么要有这个（板子真机实测）：
#     知识图谱这个任务，本机小模型连算 186 秒、191 秒，两次都是**算到超长才产出
#     不合格**，然后才升级到云端；而云端本身只要 3 秒。也就是说每点一次图谱，
#     用户都要白等三分钟才拿到本来三秒就能拿到的东西。
#     同一个 task 第二次、第三次还是同样的结果 —— 本机的「不行」在短时间内是
#     稳定的，所以第一枪失败就该记一笔，别一遍遍重演。
#
# 记两件事（都是「本机这次没成」，不是「本机永远不行」）：
#     1. 产出不合格（validate 不通过）—— 小模型能力问题，短时间内不会变好；
#     2. 连不上 / 模型没了这类基础设施失败 —— 反复去连、每次白等超时同样是浪费。
#
# ⚠️ 这不是「拉黑本机」，只是一笔有期限的账。所以：
#     · 冷却只按 **task** 记，补解析好用的机器不会被图谱那次失败牵连；
#     · 冷却只在**云端能用**时才真的短路本机（见 chat_with_fallback），
#       云端也不可用时必须回去试本机 —— 两条路不能一起断。

#: 冷却秒数默认值（QUIZ_LLM_LOCAL_COOLDOWN 没配时用这个）
LOCAL_COOLDOWN_DEFAULT = 600.0

#: task → {"until": 单调时刻, "reason": 为什么失败, "kind": invalid/unreachable}
#:
#: ⚠️ 进程内存实现，和 views.py 里的限流同一个约定：uvicorn 现在单进程，够用。
#: 将来上多 worker，每个 worker 各记各的 —— 短路只是省时间的优化，不短路也不会错，
#: 所以多 worker 下的「记忆不共享」是可以接受的；真要做到一致就得挪到
#: Django cache / redis（和限流一起挪）。
_local_state: dict[str, dict] = {}


def local_cooldown() -> float:
    """本机失败后对**同一个 task** 的冷却秒数（QUIZ_LLM_LOCAL_COOLDOWN）。

    默认 600 秒。`0`（或负数）= 关掉自适应短路：永远先试本机，和加这个功能之前
    一模一样。写成看不懂的东西（空、`abc`）时按**默认值**算 —— 宁可保留短路，
    也不要因为一个错字把优化悄悄关掉。
    """
    raw = (os.environ.get("QUIZ_LLM_LOCAL_COOLDOWN") or "").strip()
    if not raw:
        return LOCAL_COOLDOWN_DEFAULT
    try:
        value = float(raw)
    except ValueError:
        return LOCAL_COOLDOWN_DEFAULT
    return max(0.0, value)


def reset_local_state() -> None:
    """清掉各 task 的本机冷却状态（换配置、以及单测之间）。"""
    _local_state.clear()


def local_blocked(task: str) -> dict | None:
    """本机对这个 task 现在是不是处于冷却期；是则返回原因和剩余秒数，否则 None。

    开关关掉（冷却时长 0）时永远返回 None —— 调用方据此就不会跳过本机。
    不传 task（空字符串）同样返回 None：不知道是哪个功能，就无从判断该不该短路。
    """
    key = (task or "").strip()
    if not key:
        return None
    ttl = local_cooldown()
    if ttl <= 0:
        return None
    item = _local_state.get(key)
    if not item:
        return None
    now = time.monotonic()
    if now >= item["until"]:
        return None
    return {
        "task": key,
        "remain": item["until"] - now,
        "ttl": ttl,
        "kind": item["kind"],
        "reason": item["reason"],
    }


def _mark_local_failure(task: str, detail: str, *, kind: str = "invalid") -> None:
    """本机在某个 task 上失败后记一笔，接下来一段时间别再白等它。

    kind 只有两种值（给状态接口区分「去装个模型」还是「再等等」）：
        invalid      产出不合格（validate 没过）—— 小模型能力问题
        unreachable  连不上 / 模型没了 —— 基础设施问题

    不传 task 或开关关掉时什么都不记：老调用方（裸调 chat_with_fallback 的）
    行为完全不变。
    """
    key = (task or "").strip()
    if not key:
        return
    ttl = local_cooldown()
    if ttl <= 0:
        return
    _local_state[key] = {
        "until": time.monotonic() + ttl,
        "kind": kind,
        "reason": _scrub(str(detail or "本机这次没产出可用的结果")),
    }


def local_cooldowns() -> dict:
    """当前还处在冷却期的各 task —— 给 /api/quiz/status/ 真机观察用。

    只列还没过期的；reason 已经过 _scrub()，不带密钥。
    """
    now = time.monotonic()
    out: dict = {}
    for key, item in list(_local_state.items()):
        remain = item["until"] - now
        if remain <= 0:
            continue
        out[key] = {
            "remain": round(remain, 1),
            "kind": item["kind"],
            "reason": item["reason"],
        }
    return out


def cooldown_status() -> dict:
    """降级链两头的「暂时别去」状态汇总（给状态接口，便于真机观察）。

    字段：
        localCooldownSeconds  本机冷却时长（QUIZ_LLM_LOCAL_COOLDOWN），0 = 关掉短路
        localSkipEnabled      短路开着吗
        localTasks            各个 task 各自还剩多少秒、上次为什么失败
        cloudUsable           云端现在能不能用（没配 key / 正在冷却 → False）
        localSkipActive       因为冷却**真的会被跳过**的 task（云端不可用时为空 ——
                              那种情况仍然先试本机，这是设计底线）
        cloud                 云端正在冷却时的原因和剩余秒数
    """
    ttl = local_cooldown()
    tasks = local_cooldowns()
    try:
        chain = sources()
    except Exception:  # noqa: BLE001 - 状态接口不该因为探测失败而 500
        chain = []
    blocked = cloud_blocked()
    cloud_usable = any(item["source"] == "cloud" for item in chain) and blocked is None
    return {
        "localCooldownSeconds": ttl,
        "localSkipEnabled": ttl > 0,
        "localTasks": tasks,
        "cloudUsable": cloud_usable,
        "localSkipActive": sorted(tasks) if cloud_usable else [],
        "cloud": (
            {
                "status": blocked["status"],
                "dead": blocked["dead"],
                "remain": round(blocked["remain"], 1),
                "reason": blocked["reason"],
            }
            if blocked
            else None
        ),
    }


def chat(
    messages: list[dict],
    *,
    temperature: float = 0.2,
    max_tokens: int | None = None,
    timeout: int | None = None,
    cfg: dict | None = None,
) -> dict:
    """发一轮对话，返回 {text, usage, model}。

    故意不带 response_format=json_object：DeepSeek 支持，但别的兼容端点不一定，
    传了可能直接 400。改成「提示词里要求只输出 JSON + 本地宽松解析」更通用。

    cfg 让调用方指定**具体用哪一档**（降级链就是这么先本机后云端的：有 key 的
    机器上 config() 选的是云端，但链子的第一档是本机）。不传就按 config() 那条走，
    单档行为完全不变。
    """
    if _disabled():
        raise LlmDisabled(
            "AI 功能未启用（QUIZ_LLM_DISABLED=1）。配上 QUIZ_LLM_API_KEY "
            "并去掉这个开关就能启用，无需改代码。"
        )
    cfg = cfg or config()
    if not cfg["configured"]:
        raise LlmNotConfigured(
            "服务器还没有可用的模型。三条路任选：\n"
            "① 用云端：设环境变量 QUIZ_LLM_API_KEY=你的key\n"
            "② 用本机模型（免费、不用 key）：装个 Ollama 并 ollama pull 一个小模型，"
            "服务会自动发现它，不用改任何配置\n"
            "③ 什么都不配：PDF 规则解析、拖 JSON、刷题、笔记、学习报告都照常可用"
        )

    label = _source_label(cfg)
    body = {"model": cfg["model"], "messages": messages, "temperature": temperature}
    if max_tokens:
        body["max_tokens"] = max_tokens

    request = urllib.request.Request(
        f"{cfg['baseUrl']}/chat/completions",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {cfg['apiKey']}",
            # 有些网关会按 UA 拦，给一个正常的
            "User-Agent": "quizgen/1.0 (+renwu)",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout or cfg["timeout"]) as response:
            payload = json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = _scrub(exc.read().decode("utf-8", "replace")[:400])
        except Exception:  # noqa: BLE001 - 读错误体失败就算了，别覆盖原始异常
            pass
        # 带上状态码：降级链要靠它判断「是没钱了还是只是限流」
        raise LlmHttpError(exc.code, _scrub(f"{label}返回 HTTP {exc.code}：{detail}")) from exc
    except urllib.error.URLError as exc:
        raise LlmError(_scrub(f"连不上{label} {cfg['baseUrl']}：{exc.reason}")) from exc
    except TimeoutError as exc:
        raise LlmError(
            _scrub(f"{label}超时（{timeout or cfg['timeout']}s），题量太大可以分批重试")
        ) from exc

    try:
        text = payload["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError) as exc:
        raise LlmError(f"{label}返回的结构不对：{str(payload)[:300]}") from exc

    return {"text": text, "usage": payload.get("usage") or {}, "model": payload.get("model") or cfg["model"]}


def _with_source(result: dict, cfg: dict, *, tried: list[dict], degraded: bool, escalated: bool, reason: str) -> dict:
    """给 chat() 的结果挂上「实际用了哪条来源、为什么」——前端要显示，测试要断言。"""
    out = dict(result)
    out.update(
        {
            "source": (cfg or {}).get("source") or "none",
            "degraded": bool(degraded),
            "escalated": bool(escalated),
            "reason": reason,
            "tried": list(tried),
        }
    )
    return out


def chat_with_fallback(
    messages: list[dict],
    *,
    validate=None,
    temperature: float = 0.2,
    max_tokens: int | None = None,
    timeout: int | None = None,
    local_attempts: int = 2,
    task: str = "",
    prefer: str | None = None,
) -> dict:
    """按「先本机、后云端」要一次回答，并把「用了哪条、为什么」一并带回来。

    用户的权重原话是「本地解决不了 —— 那就 api；api 没钱了 —— 只能本地」。落到代码：

        1. 先试本机（免费）。连不上、或者产出不合格，都只算「本机这次没成」，
           不是请求失败。
        2. 本机压根不存在（没装 Ollama / 没拉模型）→ 直接走云端，不装样子。
        3. 本机顶不住 → 升级到云端（这一档才花钱）。
        4. 云端抛错（402 余额不足 / 401 认证失败 / 429 限流 / 超时 / 网络）→
           **把本机那次的结果还回去**，标 degraded=True，绝不让整个请求失败：
           用户要的是「尽量给一份能用的东西」，不是一句报错。
        5. 两条都不行才抛 LlmError，且消息里**两条各自为什么失败**都写清楚。

    validate 是调用方给的「这一次产出能不能用」的判定（收文本、返回 bool）。
    各功能自己定义什么算能用（见 service.py 里的 *_usable），但必须复用它们**已有**
    的解析与校验 —— 升级判据和最终入库判据要是两套，就会出现
    「判据说合格所以没升级、入库时又全被丢掉」这种自相矛盾的结果。

    task 是「这是哪个功能在要结果」，取值如 analysis / generate / graph / import
    （service.py 四个调用点各自传对）。它的唯一用途是**自适应短路**：
    本机在这个 task 上刚失败过（产出不合格，或连不上/模型没了），
    QUIZ_LLM_LOCAL_COOLDOWN 秒内不再去试它，直接走云端 —— 板子上的知识图谱就是
    这么白等三分钟的（本机算 186 秒产出不合格，云端只要 3 秒）。
    不传 task（老调用方、单测）就完全不做短路，行为和加这个功能之前一模一样。

    prefer 是「这次希望先用哪条来源」（取值 local / explicit / cloud，或 None）。
    注意它是**重排序不是过滤**：被偏好的那条提到最前面，其它来源仍然留在链子上 ——
    云端没钱/超时的时候本机还得能顶上来。「两条路都得活着」是这套链子的底线，
    所以这里绝不允许把别的来源删掉。

    用途见 service.tutor / service.diagnose：那两个是**教学内容**，
    本机 1.5B 讲驾考法规会讲错（实测给出过「记分周期 12 个月，
    就像你可以在 12 个月内完成所有科目一考试」这种似是而非的解释），
    对要背法规的学员是有害的，所以那两个功能优先走云端。

    ⚠️ **短路只在云端真的能用时才生效**：云端不在链子上（没配 key）或正在冷却期时，
    本机照试不误。反过来就会出现「两条一起被跳过 → 直接失败」，
    正好违背「两条路都得活着」这条设计底线。

    返回在 chat() 的基础上多了：
        source     实际用了哪条：local / explicit / cloud / none
        degraded   是不是「本该用更好的那条、退回本机了」
        escalated  是不是「本机没顶住（或这次被短路跳过）、升级到云端了」
        reason     给前端显示的一句话（中文，不含密钥）
        tried      试过哪几条、各自为什么没成（被短路的那条带 skipped=True）
    """
    if _disabled():
        raise LlmDisabled(
            "AI 功能未启用（QUIZ_LLM_DISABLED=1）。配上 QUIZ_LLM_API_KEY "
            "并去掉这个开关就能启用，无需改代码。"
        )
    chain = sources()
    if prefer:
        # 重排序而非过滤：把偏好的来源提到最前，其余保持原相对顺序留在链上。
        # 过滤掉别的来源会导致「云端 402 时无人兜底」→ 整个请求失败，
        # 那正好违背这套链子的设计底线。
        chain = [item for item in chain if item["source"] == prefer] + [
            item for item in chain if item["source"] != prefer
        ]
    tried: list[dict] = []
    failures: list[str] = []
    cloud_failures: list[str] = []

    if not chain:
        # 一条来源都没有。仍然走一次 chat()，让它抛出那条「三条路任选」的说明 ——
        # 这段文案前端和单测都当契约用，别在这里换一套。
        result = chat(messages, temperature=temperature, max_tokens=max_tokens, timeout=timeout)
        return _with_source(
            result,
            {"source": "none", "model": ""},
            tried=tried,
            degraded=False,
            escalated=False,
            reason="没有可用的模型来源：既没发现本机模型，也没配云端密钥",
        )

    task_key = (task or "").strip()

    # ── 这次要不要跳过本机？ ──
    # 前提是云端现在**真的能用**：在链子上、且不在冷却期（没配 key 就没有云端这一档，
    # 云端 402 冷却中同理）。不满足就老老实实先试本机 —— 宁可白等一次，
    # 也不能两条一起跳过、把请求直接做失败。
    cloud_cfgs = [item for item in chain if item["source"] == "cloud"]
    cloud_usable = bool(cloud_cfgs) and cloud_blocked() is None
    skip_local_cfg: dict | None = None
    skip_note = ""
    if task_key and cloud_usable:
        held = local_blocked(task_key)
        if held:
            skip_local_cfg = next((item for item in chain if item["source"] != "cloud"), None)
            if skip_local_cfg is not None:
                skip_note = (
                    f"本机对该任务（{task_key}）刚失败过，冷却中"
                    f"（还剩 {int(held['remain'])} 秒），这次直接跳过，不再白等一次"
                )
                tried.append(
                    {
                        "source": skip_local_cfg["source"],
                        "model": skip_local_cfg.get("model") or "",
                        "ok": False,
                        "skipped": True,
                        "error": skip_note,
                    }
                )
                failures.append(f"本机（{skip_local_cfg.get('model')}）：{skip_note}")

    # 本机被短路时先只排云端；本机没被跳过就按原来的顺序走
    pending_chain = list(cloud_cfgs) if skip_local_cfg is not None else list(chain)

    def _attempt(cfg: dict, *, is_local: bool) -> tuple[dict | None, str, bool]:
        """试一条来源。返回 (最后一次拿到的原文, 失败说明, 这次算不算成功)。

        本机重试不要钱（1.5B 的 JSON 截断是随机的，再试一次通常就好）；
        云端重试要花钱，所以只试一次。
        主循环和「短路之后云端也顶不住」的兜底那次共用这一段 —— 两处各写一份
        迟早会跑偏，而这里的每一行都直接决定花不花钱、等多久。
        """
        attempts = max(1, local_attempts) if is_local else 1
        last_result: dict | None = None
        last_error = ""
        infra_failed = False  # 是「连不上」还是「产出不合格」—— 两者的 kind 不一样

        # 本机的时间预算：单次上限 + 总预算（见 _local_timeout / _local_budget）。
        # 只在**云端真的可用**时才收紧 —— 云端不在链子上（没配 key / 冷却中）时，
        # 本机就是唯一的路，把它掐短等于让请求直接失败（违背"两条路都得活着"）。
        attempt_timeout = timeout
        budget_deadline = 0.0
        if is_local and cloud_usable:
            base = timeout or _timeout()
            lt = _local_timeout()
            if lt:
                attempt_timeout = min(base, lt)
            lb = _local_budget()
            if lb:
                budget_deadline = time.monotonic() + lb

        for index in range(attempts):
            if budget_deadline and time.monotonic() >= budget_deadline:
                last_error = (
                    f"本机这次已经花了 {_local_budget()} 秒还没给出能用的结果，"
                    "不再等它了，直接升级到云端"
                )
                break
            try:
                result = chat(
                    messages,
                    cfg=cfg,
                    temperature=temperature if index == 0 else min(temperature, 0.1),
                    max_tokens=max_tokens,
                    timeout=attempt_timeout,
                )
            except LlmNotConfigured:
                raise  # 配置问题不是「这条来源不行」，别被降级链吞掉
            except LlmError as exc:
                if is_local:
                    # 连不上 / 模型没了：反复去连、每次白等超时同样是浪费，一起记进冷却
                    _mark_local_failure(task_key, str(exc), kind="unreachable")
                    infra_failed = True
                else:
                    _mark_cloud_failure(exc)  # 记一笔，后面几分钟的请求别再撞
                last_error = _scrub(str(exc))
                break  # 连不上 / HTTP 报错：同一条来源再试也是同样的结果
            last_result = result
            if validate is None or validate(result.get("text") or ""):
                return result, "", True
            last_error = "模型返回的内容没通过校验（结构不对，不能直接采用）"
            if not is_local:
                break  # 云端不合格就交给调用方按原来的办法报错，不在这里烧钱重试

        if is_local and not infra_failed:
            # 产出不合格也记一笔：这才是短路真正的判据（本机在这个 task 上「不行」）
            _mark_local_failure(task_key, last_error, kind="invalid")
        return last_result, last_error, False

    local_tried: dict | None = None  # 本机这条有没有真的试过（决定 escalated 怎么标）
    local_result: dict | None = None  # 本机返回过的原文（云端不行时拿它兜底）
    local_cfg: dict | None = None
    cloud_hard_failed = True  # 云端有没有「至少返回过一段文本」；硬失败才能退回本机
    soft_result: dict | None = None  # 任何一条来源返回过的原文（单来源时的老行为）
    soft_cfg: dict | None = None

    for cfg in pending_chain:
        is_local = cfg["source"] != "cloud"
        label = "本机" if is_local else "云端"

        if not is_local:
            blocked = cloud_blocked()
            if blocked:
                note = (
                    f"云端还在冷却期（{blocked['reason']}），剩 {int(blocked['remain'])} 秒，"
                    "这次直接跳过，不再白撞一次"
                )
                tried.append(
                    {"source": cfg["source"], "model": cfg.get("model") or "", "ok": False, "skipped": True, "error": note}
                )
                failures.append(f"{label}（{cfg.get('model')}）：{note}")
                cloud_failures.append(note)
                continue

        if is_local:
            local_tried = cfg

        result, last_error, usable = _attempt(cfg, is_local=is_local)

        if usable:
            tried.append({"source": cfg["source"], "model": cfg.get("model") or "", "ok": True, "error": ""})
            if is_local:
                reason = f"本机模型（{cfg.get('model')}）可用，没动用云端 API（不花钱）"
            elif skip_local_cfg is not None:
                # 这次是本机在冷却期，被短路了，所以「直接走云端」不是「没发现本机」
                reason = f"已直接走云端（{cfg.get('model')}）：{skip_note}"
            elif local_tried is None:
                reason = f"没有发现本机模型，直接用云端（{cfg.get('model')}）"
            else:
                why = failures[0].split("：", 1)[-1] if failures else "本机这次没顶住"
                reason = f"已升级到云端（{cfg.get('model')}）：本机没顶住 —— {why}"
            return _with_source(
                result,
                cfg,
                tried=tried,
                degraded=False,
                escalated=not is_local and (local_tried is not None or skip_local_cfg is not None),
                reason=reason,
            )

        tried.append({"source": cfg["source"], "model": cfg.get("model") or "", "ok": False, "error": last_error})
        failures.append(f"{label}（{cfg.get('model')}）：{last_error}")
        if not is_local:
            cloud_failures.append(last_error)
        if soft_result is None and result is not None:
            soft_result, soft_cfg = result, cfg
        if is_local and result is not None:
            local_result, local_cfg = result, cfg
        if not is_local and result is not None:
            # 云端返回过文本（只是不合格）—— 那就不算「硬失败」，
            # 这种情况该由调用方按老办法报「没产出可用的题目」，而不是拿本机的旧结果糊上去
            cloud_hard_failed = False

    # ── 短路掉的那一档本机，还得补一次兜底 ──
    # 短路的前提是「云端能用」，可云端到底能不能用是**试了才知道**的：链子上排着、
    # 不在冷却期，结果一撞就 402 / 429 / 超时。这时候如果就此收场，就是两条一起没产出；
    # 而本机好歹是一条活路 —— 冷却记的只是「上次不行」，不是判它死刑。
    # 所以补试一次：成了就标 degraded（结果来自本机、事情经过要如实说），
    # 不成才按两条都失败报错（错误信息里两条的原因都在）。
    if skip_local_cfg is not None:
        cfg = skip_local_cfg
        local_tried = cfg
        result, last_error, usable = _attempt(cfg, is_local=True)
        if usable:
            tried.append({"source": cfg["source"], "model": cfg.get("model") or "", "ok": True, "error": ""})
            return _with_source(
                result,
                cfg,
                tried=tried,
                degraded=True,
                escalated=False,
                reason=(
                    "云端这次用不上（" + ("；".join(cloud_failures) or "没产出可用的结果") + "），"
                    f"只能回到本机（{cfg.get('model')}）再试一次 —— 它的失败还在冷却期，"
                    "但两条路不能一起断"
                ),
            )
        tried.append({"source": cfg["source"], "model": cfg.get("model") or "", "ok": False, "error": last_error})
        failures.append(f"本机（{cfg.get('model')}）：{last_error}（冷却期中补试的一次）")
        if soft_result is None and result is not None:
            soft_result, soft_cfg = result, cfg
        if result is not None:
            local_result, local_cfg = result, cfg

    # ── 没有一条来源给出可用产出 ──
    # 「api 没钱了 —— 只能本地」：本机好歹吐了东西、而云端是硬失败
    # （402/401/限流/超时/连不上/冷却中）时，把本机那次的结果还回去并标 degraded。
    if len(chain) > 1 and local_result is not None and cloud_hard_failed:
        return _with_source(
            local_result,
            local_cfg,
            tried=tried,
            degraded=True,
            escalated=False,
            reason="云端这次用不上（" + "；".join(cloud_failures) + "），已降级回本机那次的结果",
        )

    if len(chain) == 1 and soft_result is not None:
        # 只配了一条来源时保持原来的行为：把模型返回的原文交回调用方，
        # 由它自己的校验去报「没产出可用的题目」—— 换一套文案前后端都认不出来。
        return _with_source(
            soft_result,
            soft_cfg,
            tried=tried,
            degraded=False,
            escalated=False,
            reason="只配了一条来源，它返回的内容没通过校验",
        )

    lines: list[str] = []
    if local_tried is None:
        lines.append("本机：没发现可用的本机模型（没装 Ollama / 没拉模型，或 QUIZ_LLM_LOCAL_URL 指错了）")
    lines.extend(failures)
    if not cloud_failures and not any(line.startswith("云端") for line in failures):
        lines.append("云端：没配云端密钥（QUIZ_LLM_API_KEY 之类），这条路压根没开")
    detail = "\n".join(f"  {index + 1}) {text}" for index, text in enumerate(lines))
    header = "本机和云端两条路都试过了，都不行：" if len(chain) > 1 else "唯一可用的 AI 来源失败了："
    raise LlmError(
        f"{header}\n{detail}\n"
        "先修哪条都行：本机装/启动 Ollama（免费、不用 key），"
        "或把云端的 QUIZ_LLM_API_KEY 换成有效的、余额够的。"
    )


def extract_json(text: str):
    """从模型输出里抠出 JSON。

    模型经常不听话：外面裹 ```json 围栏、前面加一句「好的，以下是 JSON」、
    或者在末尾多写一段解释。这里做三件事：
      1. 去掉代码围栏；
      2. 从第一个 { 或 [ 开始，按括号配对扫描到匹配的收尾（跳过字符串里的括号和转义）；
      3. json.loads，失败返回 None（由调用方决定是报错还是重试）。
    """
    if not text:
        return None
    cleaned = text.strip()
    if cleaned.startswith("```"):
        # ```json ... ``` 或 ``` ... ```
        cleaned = cleaned.split("\n", 1)[-1] if "\n" in cleaned else ""
        if cleaned.rstrip().endswith("```"):
            cleaned = cleaned.rstrip()[:-3]

    start = None
    for i, ch in enumerate(cleaned):
        if ch in "{[":
            start = i
            break
    if start is None:
        return None

    openers = {"{": "}", "[": "]"}
    stack: list[str] = []
    in_string = False
    escaped = False
    for i in range(start, len(cleaned)):
        ch = cleaned[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch in openers:
            stack.append(openers[ch])
        elif stack and ch == stack[-1]:
            stack.pop()
            if not stack:
                try:
                    return json.loads(cleaned[start : i + 1])
                except json.JSONDecodeError:
                    return None
    return None
