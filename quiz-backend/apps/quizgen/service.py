"""把「一份 PDF 的文字」变成「一份能直接刷的题库」，以及 AI 补解析 / 出题。

三条路，成本从低到高，**永远先走便宜的那条**：

    1. 规则解析（免费、精确、可复现）
       复用 quiz/tools/pdf_to_json.py 里的同一份规则 —— 那个模块是动态加载的，
       不是拷贝，所以规则只有一份实现，不会两边跑偏。

    2. 规则解析 + AI 兜底（只在规则漏题时才花钱）
       规则能识别的题一律用规则的；AI 只负责补上规则漏掉的那些。

    3. AI 补解析 / AI 出题（用户明确点了才调）

关键设计：AI 产出的题**必须走和规则解析同一条 normalize() + validate()**。
这样模型没听话、答案越界、选项不连续之类的问题会被同一套校验拦下来，
而不是绕过校验直接进题库。
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from . import llm, prompts

#: 单次送给模型的字符预算（中文约 1 字 1 token，留足输出空间）
CHUNK_CHARS = 9000

#: 模型输出的上限。小额模型（1.5B）不加限制时偶尔会吐到一半就停，
#: 结果 JSON 缺个括号 → 整段作废。给足空间能显著减少这种情况。
MAX_OUTPUT_TOKENS = 2048

#: 选项前缀："A. " / "A、" / "A）" / "(A)" —— 和前端 core/normalize.js 一个思路
OPTION_PREFIX = re.compile(r"^\s*[(（\[【]?\s*([A-Ha-h])\s*[)）\]】.、．:：]\s*(.+)$", re.S)

#: 规则覆盖率低于这个值才考虑用 AI 兜底
LLM_FALLBACK_COVERAGE = 0.75

#: 规则解析出的题**少于**这个数，无论覆盖率多少都让 AI 补一遍。
#: ⚠️ 为什么要这条：覆盖率的分母是"文本里出现过的最大题号"，只认出一道题、
#:    而文本里最大题号也是 1 时 coverage = 1.0 —— 覆盖率满分，AI 兜底根本不会跑。
#:    真实事故（2026-10-11）：站主上传扫描件，规则只认出一道**只有一个选项**的
#:    伪题，覆盖率 1.0 让 AI 没兜底，那道伪题又被前端判非法 → 用户拿到 0 道题。
#:    两道是"一道题不足以叫题库"的最小值。
MIN_RULE_QUESTIONS = 2

_PARSER_LOCK = threading.Lock()
_PARSER_CACHE: dict = {}


# --------------------------------------------------------------------------
# 配置（都从 Django settings 读，取不到就用默认值 —— 方便脱离 Django 单测）
# --------------------------------------------------------------------------

def _setting(name: str, default):
    try:
        from django.conf import settings

        return getattr(settings, name, default)
    except Exception:  # noqa: BLE001 - 脱离 Django 运行时也要能跑
        return default


def parser_path() -> Path:
    return Path(_setting("QUIZ_PARSER_PATH", Path.cwd() / "pdf_to_json.py"))


def java_sandbox_path() -> Path:
    return Path(_setting("QUIZ_JAVA_SANDBOX_PATH", Path.cwd() / "java_sandbox.py"))


def java_enabled() -> bool:
    """Java 真跑**默认关**。原因见 config/settings.py 里 QUIZ_JAVA_ENABLED 那段注释。"""
    return bool(_setting("QUIZ_JAVA_ENABLED", False))


def java_limits() -> tuple[float, int]:
    return (
        float(_setting("QUIZ_JAVA_TIMEOUT", 20.0)),
        int(_setting("QUIZ_JAVA_MEMORY_MB", 128)),
    )


def cache_dir() -> Path:
    path = Path(_setting("QUIZ_CACHE_DIR", Path.cwd() / "quiz-cache"))
    path.mkdir(parents=True, exist_ok=True)
    return path


# --------------------------------------------------------------------------
# 动态加载解析规则模块
# --------------------------------------------------------------------------

def load_parser():
    """加载并缓存 pdf_to_json.py。

    用文件路径动态加载而不是普通 import，是因为它在板子上位于 shared/ 下
    （跨 release 持久化），不在 Python 包路径里。
    文件改动（mtime 变了）会自动重新加载，方便热修规则。
    """
    path = parser_path()
    if not path.is_file():
        raise RuntimeError(f"找不到解析规则模块：{path}（部署时要用 rexec --put 传上去）")

    mtime = path.stat().st_mtime
    with _PARSER_LOCK:
        cached = _PARSER_CACHE.get("module")
        if cached is not None and _PARSER_CACHE.get("key") == (str(path), mtime):
            return cached

        spec = importlib.util.spec_from_file_location("quiz_rules", path)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"无法加载 {path}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _PARSER_CACHE.update({"module": module, "key": (str(path), mtime)})
        return module


def parser_digest() -> str:
    """规则文件的 sha256（前 12 位）。用来核对板子上跑的是不是仓库里那一份。"""
    path = parser_path()
    if not path.is_file():
        return ""
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]


# --------------------------------------------------------------------------
# 动态加载 Java 沙箱模块（和解析规则同一个套路：一份实现、mtime 变了就重载）
# --------------------------------------------------------------------------

#: 单份源码上限。前端一次只该提交"一道题那么长"的代码。
JAVA_MAX_SOURCES = 6
JAVA_MAX_SOURCE_BYTES = 200 * 1024


def load_java_sandbox():
    """加载并缓存 java_sandbox.py（仓库里 quiz/tools/java_sandbox.py 的同一份）。"""
    path = java_sandbox_path()
    if not path.is_file():
        raise RuntimeError(f"找不到 Java 沙箱模块：{path}（部署时要用 rexec --put 传上去）")

    mtime = path.stat().st_mtime
    with _PARSER_LOCK:
        cached = _PARSER_CACHE.get("java")
        if cached is not None and _PARSER_CACHE.get("java_key") == (str(path), mtime):
            return cached

        spec = importlib.util.spec_from_file_location("quiz_java_sandbox", path)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"无法加载 {path}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _PARSER_CACHE.update({"java": module, "java_key": (str(path), mtime)})
        return module


def java_sandbox_digest() -> str:
    path = java_sandbox_path()
    if not path.is_file():
        return ""
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]


def run_java_code(
    sources: dict[str, str],
    *,
    params: list[str] | None = None,
    timeout: float | None = None,
    memory_mb: int | None = None,
) -> dict:
    """编译并运行一份 Java 源码。

    ⚠️ 这里**不做**限流/权限判断 —— 那是视图层的事（见 views.java_run）。
       这一层只负责"把源码跑起来，把结果如实报回来"。
    """
    if not sources:
        raise ValueError("sources 不能为空：需要 {文件名: 源码}")
    if len(sources) > JAVA_MAX_SOURCES:
        raise ValueError(f"文件太多（{len(sources)} > {JAVA_MAX_SOURCES}）")
    total = sum(len(v.encode("utf-8")) for v in sources.values())
    if total > JAVA_MAX_SOURCE_BYTES:
        raise ValueError(f"源码太大（{total} > {JAVA_MAX_SOURCE_BYTES} 字节）")
    for name in sources:
        # 只允许 .java，且不许带路径 —— 否则能往工作目录外写文件
        if not name.endswith(".java") or "/" in name or "\\" in name or ".." in name:
            raise ValueError(f"文件名不合法：{name!r}（只允许不带路径的 .java）")

    sandbox = load_java_sandbox()
    default_timeout, default_memory = java_limits()
    return sandbox.run_java(
        sources,
        params=params or [],
        timeout=timeout or default_timeout,
        memory_mb=memory_mb or default_memory,
        sandbox="auto",   # 有 bwrap 就用；板子上有，本机开发时是 none
    )


# --------------------------------------------------------------------------
# 工具
# --------------------------------------------------------------------------

def chunk_pages(pages: list[list[str]], budget: int = CHUNK_CHARS) -> list[str]:
    """把「一页一个行列表」按字符预算切成若干段纯文本（不切碎页面）。"""
    chunks: list[str] = []
    buf: list[str] = []
    size = 0
    for page in pages:
        text = "\n".join(page)
        if buf and size + len(text) > budget:
            chunks.append("\n".join(buf))
            buf, size = [], 0
        buf.append(text)
        size += len(text) + 1
    if buf:
        chunks.append("\n".join(buf))
    return [c for c in chunks if c.strip()]


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _slug(text: str) -> str:
    """给题库 id 用：只留字母数字和短横线，中文全被过滤就退化成 hash。"""
    cleaned = re.sub(r"[^0-9A-Za-z_-]+", "-", text or "").strip("-").lower()
    return cleaned[:40] or f"bank-{hashlib.sha256((text or 'x').encode()).hexdigest()[:8]}"


# --------------------------------------------------------------------------
# 1 + 2：PDF 文字 → 题库
# --------------------------------------------------------------------------

_STRUCTURE_SYSTEM = (
    "你是题库结构化助手。你只输出 JSON，不输出任何解释文字、不加 markdown 代码围栏。"
)

_STRUCTURE_TEMPLATE = """把下面的题库文本转成 JSON，格式固定为：

{{"questions":[{{"no":1,"type":"single","stem":"题干","options":[{{"key":"A","text":"选项正文"}}],"answer":["A"],"analysis":"解析（原文有才给）"}}]}}

必须遵守：
1. 原样保留题干和选项的文字，**不要改写、不要精简、不要自己编题、不要删题**。
2. 答案必须来自原文的「答案：」标注。原文没写答案的题目整题丢弃，不要猜。
3. 判断题 type 用 "judge"，answer 用 ["T"]（正确）或 ["F"]（错误），options 可以省略。
4. 选择题：答案是 1 个字母用 "single"，2 个及以上用 "multiple"；选项 key 必须从 A 连续排下来。
5. 合并因排版产生的断行和多余空格；填空处统一写成 (  )。
6. 原文给了「解析/答案解析」就放进 analysis 字段，没有就省略这个字段。

题库文本：
{content}"""


def _chat_json(
    messages: list[dict],
    *,
    temperature: float = 0.2,
    attempts: int = 2,
    validate=None,
    task: str = "",
    prefer: str = "",
    timeout: int | None = None,
    local_attempts: int | None = None,
):
    """要模型给 JSON；给不出来就重试，返回 (payload, 最后一次的原始结果)。

    为什么值得重试：小额模型（qwen2.5:1.5b 实测）大约每 4 次就有 1 次把 JSON
    吐一半就停 —— 这是**模型能力**问题，不是解析问题，靠改正则救不回来。
    但它是随机的，所以重试一次（并把温度压低）就能把成功率从 ~75% 拉到 ~95%，
    代价只是一次额外的推理；本机模型不花钱，云端也只是多花一点。

    validate 交给 llm.chat_with_fallback，用来判断「本机这一次算不算合格」，
    不合格就往上升级到云端。注意**重试和升级是两件事**，别混在一起：
        重试 = 同一条来源再要一次（这里做，只有 JSON 都没抠出来才重试）
        升级 = 换一条来源（chat_with_fallback 做）

    task 是「这是哪个功能在要结果」（analysis / generate / graph / import），
    一路传给 chat_with_fallback，用来按功能记「本机不行」的冷却 ——
    同一台机器上补解析好使、知识图谱不好使是常有的事，判据必须分开算。

    prefer 是「哪条来源打头」（见 chat_with_fallback）：docs 出题要它把云端提到最前，
    因为"逐字引用原文"这种精确活本机 1.5B 干不了。

    timeout / local_attempts 是**给"会撞反代上限"的那条路专用的两道闸**
    （目前只有 service.task_from_material 用），两个都默认 None = 不传，
    行为与加它们之前**完全一样**（review / 教练 / 图谱那几条路不受影响）。
    为什么要按"每次 HTTP 调用"和"本机重试次数"分别给闸，见 _task_budget()。
    """
    extra: dict = {}
    if timeout is not None:
        extra["timeout"] = timeout
    if local_attempts is not None:
        extra["local_attempts"] = local_attempts

    last = None
    for attempt in range(max(1, attempts)):
        result = llm.chat_with_fallback(
            messages,
            validate=validate,
            temperature=temperature if attempt == 0 else 0.1,
            max_tokens=MAX_OUTPUT_TOKENS,
            task=task,
            prefer=prefer,
            **extra,
        )
        last = result
        payload = llm.extract_json(result.get("text") or "")
        if payload is not None:
            if attempt:
                print(f"[quizgen] JSON 第一次没解析出来，重试第 {attempt + 1} 次成功")
            return payload, result
    return None, last


class _SourceTrace:
    """把一次请求里若干次模型调用的来源信息合并成一份给前端。

    为什么要合并：出题要跑好几轮（本机一批只敢要 2 道），每一轮的来源都可能不同
    —— 这一轮本机过了，下一轮本机吐了半截 JSON 就升级到了云端。前端只想显示
    一句「现在用的是本机 / 已经降级到云端」，所以这里汇总成一份：
    只要有一轮用过云端就报 cloud，只要有一轮降级就报 degraded。
    """

    def __init__(self) -> None:
        self.rounds: list[dict] = []

    def add(self, result: dict | None) -> None:
        if not isinstance(result, dict) or not result.get("source"):
            return
        self.rounds.append(
            {
                "source": result.get("source") or "none",
                "model": result.get("model") or "",
                "degraded": bool(result.get("degraded")),
                "escalated": bool(result.get("escalated")),
                "reason": result.get("reason") or "",
                "tried": result.get("tried") or [],
            }
        )

    def as_dict(self) -> dict:
        if not self.rounds:
            return {
                "used": "none",
                "degraded": False,
                "escalated": False,
                "reason": "这次没有调用模型",
                "tried": [],
                "rounds": 0,
            }

        used = "cloud" if any(r["source"] == "cloud" for r in self.rounds) else self.rounds[-1]["source"]
        notes = []
        if any(r["escalated"] for r in self.rounds):
            notes.append("有批次本机没顶住，已升级到云端")
        if any(r["degraded"] for r in self.rounds):
            notes.append("有批次云端用不上，已降级回本机")
        if not notes:
            notes.append("全程用的都是云端" if used == "cloud" else "全程用的都是本机")
        return {
            "used": used,
            "degraded": any(r["degraded"] for r in self.rounds),
            "escalated": any(r["escalated"] for r in self.rounds),
            "reason": "；".join(notes) + f"（共 {len(self.rounds)} 次模型调用）",
            # 详细到「试过哪几条、各自为什么失败」的只有最后一轮，够定位问题又不会把响应撑爆
            "tried": self.rounds[-1]["tried"],
            "lastReason": self.rounds[-1]["reason"],
            "rounds": len(self.rounds),
        }


def _structure_usable(text: str) -> bool:
    """本机这一次「补解析」算不算合格：能抠出 JSON，且至少有一道题过了校验。

    刻意复用 questions_from_llm（也就是入库用的那套 normalize + validate）——
    升级的判据和最终入库的判据必须是同一套。要是各写一套，就会出现
    「本机看着合格所以没升级，入库时又全被丢掉，用户只看到一篇空题库」。
    """
    payload = llm.extract_json(text)
    if not isinstance(payload, dict) or not isinstance(payload.get("questions"), list):
        return False
    return bool(questions_from_llm(payload["questions"], []))


def _llm_structure_chunk(
    chunk: str,
    warnings: list[str],
    trace: _SourceTrace | None = None,
    *,
    prefer_cloud: bool | None = None,
) -> list[dict]:
    """让模型把一段文本结构化，返回已经过 normalize 的题目列表。"""
    parser = load_parser()
    payload, result = _chat_json(
        [
            {"role": "system", "content": _STRUCTURE_SYSTEM},
            {"role": "user", "content": _STRUCTURE_TEMPLATE.format(content=chunk)},
        ],
        temperature=0.0,
        validate=_structure_usable,
        task="import",  # PDF 兜底结构化：本机好不好使，单独记一笔
        prefer=_generate_prefer("", prefer_cloud),
    )
    if trace is not None:
        trace.add(result)
    if not isinstance(payload, dict):
        warnings.append("AI 返回的不是 JSON 对象，这一段已跳过")
        return []

    items = payload.get("questions")
    if not isinstance(items, list):
        warnings.append("AI 返回里没有 questions 数组，这一段已跳过")
        return []

    return questions_from_llm(items, warnings)


def _generate_budget() -> float:
    """整批出题**总共**能花多久（秒）。

    ★ 为什么必须有这个上限（实测踩过，用户的真金白银）：
      `/api/quiz/import/` 是**同步**请求，前面站着反代（Cloudflare 约 100 秒就掐）。
      板子上的 `QUIZ_LLM_TIMEOUT` 一度是 **600**，而一次出题最多 8 轮 × 每块材料，
      于是出现：约 100 秒时浏览器收到 **502**，而后端**还在继续算、token 照花**，
      算完的结果没有任何人接收 —— "烧完钱吐个 502"。
      有了这个上限，后端会**在自己被掐断之前**收手，把已经出的题返回给用户
      （下面 `if questions:` 那条路本来就会保留前几轮的产出）。

    默认 75 秒：留出 25 秒余量给反代/传输。可用 `QUIZ_GENERATE_BUDGET` 覆盖。
    """
    raw = (os.environ.get("QUIZ_GENERATE_BUDGET") or "").strip()
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 75.0
    return value if value > 0 else 75.0


def questions_from_llm(items: list, warnings: list[str]) -> list[dict]:
    """把模型给的结构过一遍**和规则解析完全相同**的归一化 + 校验。

    这一步是这套设计的关键：模型输出不可信，所以不能直接塞进题库。
    """
    parser = load_parser()
    out: list[dict] = []
    for raw in items:
        if not isinstance(raw, dict):
            continue
        try:
            no = int(raw.get("no") or 0)
        except (TypeError, ValueError):
            no = 0
        if no <= 0:
            no = len(out) + 1

        q = parser.Q(no, None)
        q.stem = str(raw.get("stem") or raw.get("question") or "")
        options = raw.get("options") or []
        pairs: list[tuple[str, str]] = []
        if isinstance(options, dict):
            options = [{"key": k, "text": v} for k, v in options.items()]
        if isinstance(options, list):
            for opt in options:
                if isinstance(opt, dict):
                    key = str(opt.get("key") or opt.get("label") or "")
                    text = str(opt.get("text") or opt.get("content") or "")
                    if key or text:
                        pairs.append((key, text))
                elif isinstance(opt, str):
                    # ⚠️ 真模型（qwen2.5:1.5b 实测）经常把选项写成
                    #     ["A. 甲", "B. 乙"]  这种**带前缀的纯字符串**，
                    # 而不是 [{"key":"A","text":"甲"}]。
                    # 原来的代码直接 append(("", 文本)) —— key 是空串，
                    # 于是「A/B/C/D 必须连续」这条校验把**完全正确的题**全丢了。
                    # 这里做和前端容错层（core/normalize.js）一样的事：
                    # 先剥前缀，剥不出来按顺序补字母。
                    matched = OPTION_PREFIX.match(opt.strip())
                    if matched:
                        pairs.append((matched.group(1).upper(), matched.group(2).strip()))
                    else:
                        pairs.append(("", opt.strip()))
        # 没给 key 的按顺序补 A/B/C…（跳过已经被占用的字母）
        if any(not key for key, _ in pairs):
            used = {key for key, _ in pairs if key}
            cursor = 0
            fixed: list[tuple[str, str]] = []
            for key, text in pairs:
                if not key:
                    while cursor < 26 and chr(ord("A") + cursor) in used:
                        cursor += 1
                    key = chr(ord("A") + cursor) if cursor < 26 else str(len(fixed) + 1)
                    used.add(key)
                    cursor += 1
                fixed.append((key, text))
            pairs = fixed
        # 按 key 排序：解析器要求选项必须是 A、B、C… 的**顺序**，
        # 而模型给的顺序未必和 key 一致（实测：字符串项排在带 key 的项前面时，
        # 补完字母会得到 B,A,C —— 这种顺序会被校验拒掉，可内容其实没问题）。
        pairs.sort(key=lambda kv: kv[0])
        q.options = pairs

        answer = raw.get("answer")
        if answer is None:
            answer = raw.get("correct")
        if isinstance(answer, list):
            q.answer_raw = "".join(str(a) for a in answer)
        elif isinstance(answer, bool):
            q.answer_raw = "正确" if answer else "错误"
        else:
            q.answer_raw = str(answer or "")

        item = parser.normalize(q)
        if item is None:
            warnings.append(f"AI 给的「第 {no} 题」没通过校验，已丢弃")
            continue
        item["id"] = f"q{item['no']}"
        analysis = str(raw.get("analysis") or raw.get("explanation") or "").strip()
        if analysis:
            item["analysis"] = analysis
        # 出处透传：只有 docs 包（官方文档/教材）会要求模型给 source，
        # 其余包的输出里没有这个键 → 这里对老行为**零影响**。
        # 为什么要留下它：docs_to_bank.py 要拿 quote 去原文里做**逐字命中校验**，
        # 抄不出来就丢弃整道题（教材内容最怕"凭记忆讲 API"）。
        # 校验必须拿到结构化的 quote，所以不能只把它塞在 analysis 文本里。
        source = raw.get("source")
        if isinstance(source, dict) and (source.get("quote") or source.get("heading")):
            item["source"] = {
                "heading": str(source.get("heading") or "").strip()[:200],
                "quote": str(source.get("quote") or "").strip()[:600],
            }
        tags = parser.auto_tags(item)
        if tags:
            item["tags"] = tags
        out.append(item)
    return out


def bank_from_pages(
    pages: list[list[str]],
    *,
    bank_id: str = "",
    title: str = "",
    subject: str = "",
    source: str = "",
    use_llm: bool = True,
    prefer_cloud: bool | None = None,
) -> dict:
    """主入口：一页一行的文字 → 题库。

    prefer_cloud 三态（和 generate_bank 一致）：True = 云端先上；False = 本机先上；
    None = 按后端默认。**用户问过"开关在哪里"** —— 这个导入路径以前根本不认这个开关，
    于是"先试本机 1.5B"成了唯一选项，板子白烤、请求最后被 Cloudflare 掐成 524。
    """
    if not isinstance(pages, list) or not pages:
        raise ValueError("pages 不能为空：需要 [{页1的行...}, {页2的行...}]")

    parser = load_parser()
    lines = parser.lines_from_pages(pages)

    warnings: list[str] = []
    bank, rule_warnings = parser.build_bank_from_lines(
        lines, _slug(bank_id or title or source or "bank"), title or Path(source).stem or "题库",
        subject, source=source,
    )
    warnings.extend(rule_warnings)

    questions: list[dict] = bank["questions"]
    strategy = "rules"

    # 期望题数 ≈ 文本里出现过的最大题号，用它算覆盖率
    expected = 0
    for line in lines:
        match = parser.RE_QUESTION.match(line)
        if match:
            expected = max(expected, int(match.group(1)))
    coverage = (len(questions) / expected) if expected else (1.0 if questions else 0.0)

    # 规则啃不动 / 漏得多 / **认出来的题少得不像一份题库** → 让 AI 兜底（只补规则没给出的题号）
    # ⚠️ 第三個条件（绝对量）不能省：覆盖率的分母是"文本里出现过的最大题号"，
    #    只认出一道题且最大题号也是 1 时 coverage=1.0，光看覆盖率 AI 一次都不会跑
    #    （真实事故，见 MIN_RULE_QUESTIONS 的注释）。
    trace = _SourceTrace()
    thin = len(questions) < MIN_RULE_QUESTIONS
    if use_llm and llm.config()["configured"] and (thin or coverage < LLM_FALLBACK_COVERAGE):
        have = {q["no"] for q in questions}
        added = 0
        # ★ 整批墙钟上限 —— **站主上传 PDF 走的正是这条路**（不是 generate_bank）。
        #   踩过：我先只给 generate_bank 加了上限，回头才发现 /import/ 用的是这里，
        #   等于"修了另一条路"。反代约 100s 就掐，到点必须收手把已出的题交出去，
        #   而不是继续一块一块地调模型、钱花光、结果没人接收（见 _generate_budget 的说明）。
        budget = _generate_budget()
        deadline = time.monotonic() + budget
        chunks = chunk_pages(pages)
        for index, chunk in enumerate(chunks, start=1):
            if time.monotonic() >= deadline:
                warnings.append(
                    f"到整批时间上限（{budget:.0f}s）先收手：还剩 {len(chunks) - index + 1} 段没补，"
                    f"已做出的题照样给你。要更多就分小批再传一次。"
                )
                break
            try:
                items = _llm_structure_chunk(chunk, warnings, trace, prefer_cloud=prefer_cloud)
            except llm.LlmError as exc:
                # 降级链两条都顶不住时才会抛到这里。**别让整次导入失败**：
                # 规则已经解析出来的题、以及前面几段补出来的题，都是有效产出，
                # 为了一段没补上就整包 502，用户看到的是「一份都读不出来」。
                if not questions and not added:
                    raise  # 一条都还没有，那就老老实实报错（消息里两条原因都有）
                warnings.append(f"AI 兜底中途失败，剩下的段落已跳过（{exc}）")
                break
            for item in items:
                if item["no"] in have:
                    continue  # 规则已经识别出来了，以规则为准
                have.add(item["no"])
                questions.append(item)
                added += 1
        if added:
            strategy = "rules+llm" if questions else "llm"
            warnings.append(f"规则漏了 {added} 道，已用 AI 补齐")
        questions.sort(key=lambda q: q["no"])
    elif use_llm and not llm.config()["configured"] and coverage < LLM_FALLBACK_COVERAGE:
        warnings.append("规则解析覆盖不全，而且服务器没配云端 API 密钥，无法用 AI 兜底")

    # 重新编号：AI 补进来的题号可能和规则的重叠或跳号，统一按顺序重排更安全
    for index, item in enumerate(questions, start=1):
        item["no"] = index
        item["id"] = f"q{index}"

    counts = {"single": 0, "multiple": 0, "judge": 0}
    tag_counter: dict[str, int] = {}
    for item in questions:
        counts[item["type"]] = counts.get(item["type"], 0) + 1
        for tag in item.get("tags") or []:
            tag_counter[tag] = tag_counter.get(tag, 0) + 1

    bank["meta"].update(
        {
            "id": _slug(bank_id or title or source or "bank"),
            "title": title or Path(source).stem or "题库",
            "subject": subject,
            "source": source,
            "generatedAt": _now(),
            "total": len(questions),
            "counts": counts,
            "tags": [{"name": k, "count": v} for k, v in sorted(tag_counter.items(), key=lambda x: -x[1])],
        }
    )
    bank["questions"] = questions

    ok, problems = parser.validate(questions)
    if problems:
        warnings.extend(problems[:10])

    # 一道题都没解析出来时，别报 ok=true —— 前端只能靠 total 猜，接口契约不该这样
    if not questions:
        detail = "；".join(warnings[:3]) or "规则没能识别出任何题目"
        return {
            "ok": False,
            "error": f"没能从这份文件里解析出题目（{detail}）。"
            "扫描件/图片版 PDF 需要先做 OCR；排版太乱的话可以试试让 AI 兜底。",
            "bank": bank,
            "strategy": strategy,
            "warnings": warnings,
            "coverage": {"expected": expected, "parsed": 0, "ratio": 0.0},
            "valid": False,
            "llm": llm.public_config(),
            "llmSource": trace.as_dict(),
        }

    return {
        "ok": True,
        "bank": bank,
        "strategy": strategy,
        "warnings": warnings,
        "coverage": {
            "expected": expected,
            "parsed": len(questions),
            "ratio": round(coverage, 3),
        },
        "valid": ok,
        "llm": llm.public_config(),
        "llmSource": trace.as_dict(),
    }


# --------------------------------------------------------------------------
# 3：AI 补解析（带服务端缓存，避免重复花钱）
# --------------------------------------------------------------------------

# ⚠️ 提示词已经挪到 prompts.py 按领域分包（generic / drive）。
# 这里保留别名只为兼容历史引用点，**不要在这两个常量里改内容** ——
# 改了不会生效，真正生效的是 prompts.GENERIC_*。
_ANALYSIS_SYSTEM = prompts.GENERIC_ANALYSIS_SYSTEM
_ANALYSIS_TEMPLATE = prompts.GENERIC_ANALYSIS_TEMPLATE


def _analysis_cache_path(bank_id: str, item: dict) -> Path:
    key = "|".join(
        [
            bank_id or "",
            str(item.get("no")),
            str(item.get("stem") or ""),
            ",".join(item.get("answer") or []),
        ]
    )
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:32]
    return cache_dir() / "analysis" / f"{digest}.json"


def cached_analysis(bank_id: str, item: dict) -> str:
    path = _analysis_cache_path(bank_id, item)
    if not path.is_file():
        return ""
    try:
        return json.loads(path.read_text(encoding="utf-8")).get("analysis", "")
    except (OSError, json.JSONDecodeError):
        return ""


def _store_analysis(bank_id: str, item: dict, analysis: str) -> None:
    path = _analysis_cache_path(bank_id, item)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {"analysis": analysis, "no": item.get("no"), "model": llm.config()["model"], "at": _now()},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


def _render_question(item: dict) -> str:
    lines = [f"第 {item.get('no')} 题（{item.get('type')}）：{item.get('stem')}"]
    for opt in item.get("options") or []:
        lines.append(f"  {opt.get('key')}. {opt.get('text')}")
    lines.append(f"  答案：{' '.join(item.get('answer') or [])}")
    return "\n".join(lines)


def _analysis_rows(payload) -> tuple[list[str], dict[int, str]]:
    """从模型返回里抽出 (按顺序的解析清单, 题号→解析)。

    单独抽出来是因为要复用两次：升级判据（_analysis_usable）和真正入库的解析
    必须走同一段代码，否则「本机判合格、入库时又一条都对不上」这种事会神不知鬼不觉。
    """
    ordered: list[str] = []
    by_no: dict[int, str] = {}
    if isinstance(payload, dict) and isinstance(payload.get("items"), list):
        for row in payload["items"]:
            if not (isinstance(row, dict) and row.get("analysis")):
                continue
            text = str(row["analysis"]).strip()
            if not text:
                continue
            ordered.append(text)
            try:
                by_no[int(row.get("no"))] = text
            except (TypeError, ValueError):
                # 模型没给题号 / 给了非数字。**别把这段解析扔了**。
                # 实测 1.5B 经常只回 [{"analysis":"…"}]，原来的代码在这里
                # int(None) 抛异常就 continue，于是「模型明明答了」却算失败 ——
                # 补解析成功率只有 1/4 就是这个原因，跟模型质量无关。
                pass
    return ordered, by_no


def _analysis_usable(text: str) -> bool:
    """本机这一次「补解析」算不算合格：至少给出一条能用的解析。

    判据刻意宽松（不要求条数齐全）：缺的那几道下游会老老实实标 failed，
    而且补解析是按批调的，为了「一道没给」就整批升级到云端不划算。
    """
    ordered, _ = _analysis_rows(llm.extract_json(text))
    return bool(ordered)


def add_analysis(
    bank_id: str,
    questions: list[dict],
    *,
    use_cache: bool = True,
    domain: str = "generic",
) -> dict:
    """给一批题补解析。命中缓存的直接返回，不会重复调用云端。

    domain 决定用哪套提示词：默认 generic（保持刷题站原有行为），
    驾考站传 "drive" —— 否则会得到一份「依据马克思主义理论常识」的驾考解析。
    """
    if not questions:
        return {"ok": True, "items": [], "usage": {}, "hit": 0, "missed": 0, "llmSource": _SourceTrace().as_dict()}

    pack = prompts.pack(domain)

    items: list[dict] = []
    pending: list[dict] = []
    trace = _SourceTrace()

    for item in questions:
        hit = cached_analysis(bank_id, item) if use_cache else ""
        if hit:
            items.append({"no": item.get("no"), "analysis": hit, "cached": True})
        else:
            pending.append(item)

    usage = {}
    if pending:
        payload, result = _chat_json(
            [
                {"role": "system", "content": pack["analysis_system"]},
                {"role": "user", "content": pack["analysis_template"].format(
                    content="\n\n".join(_render_question(q) for q in pending)
                )},
            ],
            temperature=0.3,
            validate=_analysis_usable,
            task="analysis",  # 补解析（本机最拿手的活，别被别的任务牵连）
        )
        trace.add(result)
        usage = (result or {}).get("usage") or {}
        # 先按题号对；对不上时留一份**按顺序**的清单做兜底。
        ordered, by_no = _analysis_rows(payload)

        # 按题号一条都对不上（比如模型从 1 重新编号）时，按返回顺序一一对应
        positional = len(ordered) == len(pending)

        for index, item in enumerate(pending):
            text = by_no.get(item.get("no"))
            if not text and positional:
                text = ordered[index]
            if not text:
                items.append({"no": item.get("no"), "analysis": "", "cached": False, "failed": True})
                continue
            _store_analysis(bank_id, item, text)
            items.append({"no": item.get("no"), "analysis": text, "cached": False})

    items.sort(key=lambda x: x.get("no") or 0)
    return {
        "ok": True,
        "items": items,
        "usage": usage,
        "hit": sum(1 for i in items if i.get("cached")),
        "missed": sum(1 for i in items if i.get("failed")),
        "llmSource": trace.as_dict(),
    }


# --------------------------------------------------------------------------
# 3.5：AI 教练追问 / 错题诊断
#
# 这两个是「对话/散文」类接口，模型输出的是**自然语言**而不是 JSON，
# 所以不走 _chat_json（那个会去抠 JSON，散文抠不出来就被判成失败）。
# 直接调 llm.chat_with_fallback，把本机→云端的降级链照旧用上。
# --------------------------------------------------------------------------

#: 教练回答的字数上限（中文 200 字 ≈ 400 token，留够余量）
MAX_TUTOR_TOKENS = 1024

#: 带上来的对话轮数上限。学员连问十几轮会把上下文撑爆，
#: 而最近的几轮才是相关的 —— 更早的由 system 里的题目上下文兜着。
MAX_TUTOR_HISTORY = 12


def _plain_text(text: str) -> str:
    """把模型返回的散文收拾干净：去掉代码围栏、去掉 markdown 标题/加粗记号。

    为什么要去 markdown：前端是按 `white-space: pre-wrap` 直接显示纯文本的，
    不渲染 markdown。模型很爱回「### 错题诊断」「**错在哪：**」，
    不处理的话学员看到的就是一堆字面量井号和星号。
    """
    out = (text or "").strip()
    if out.startswith("```"):
        # ```json\n...\n``` 或 ```\n...\n```
        lines = out.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        out = "\n".join(lines).strip()

    lines = []
    for line in out.splitlines():
        stripped = line.lstrip()
        # 标题记号去掉，但保留文字（"### 错题诊断" -> "错题诊断"）
        if stripped.startswith("#"):
            indent = line[: len(line) - len(stripped)]
            line = indent + stripped.lstrip("#").lstrip()
        # 加粗/斜体记号去掉（**x** -> x，__x__ -> x）
        if "**" in line:
            line = line.replace("**", "")
        if "__" in line:
            line = line.replace("__", "")
        # 行首的 "- **x**" 去掉加粗后可能剩下 "- x"，保留连字符（列表读起来更清楚）
        lines.append(line.rstrip())
    return "\n".join(lines).strip()


def _coach_prefer() -> str | None:
    """AI 教练 / 错题诊断用哪条来源打头。

    默认 **cloud**：这两个功能产出的是**给学员看的讲解**，
    本机 qwen2.5:1.5b 实测会把驾考法规讲歪（比如把记分周期解释成
    「12 个月内完成所有科目一考试」），学员会当真背下来。
    宁可花点钱，也不能让要考试的人学到错的东西。

    想省钱/离线：设 QUIZ_COACH_PREFER=local（先本机，不行再云端）
    或 QUIZ_COACH_PREFER=off / 空（完全按原来的「先本机」链路走）。

    ⚠️ 注意「没设」和「设成空串」是两回事：
      没设     → 默认 cloud（要质量）
      设成 ""  → 关掉偏好（等价 off），跟 .env 里写 `QUIZ_COACH_PREFER=` 的直觉一致
    """
    raw = os.environ.get("QUIZ_COACH_PREFER")
    if raw is None:
        return "cloud"
    value = raw.strip().lower()
    if value in ("off", "none", "", "0", "false"):
        return None
    return value if value in ("local", "explicit", "cloud") else "cloud"


#: 代码题的四种模式 → 给模型看的中文说法（和前端 core/code.js 的 CODE_MODE_LABEL 对齐）
CODE_MODE_TEXT = {
    "fill": "填空：___ 处要补回原文写法",
    "spot": "找错行：其中有一行被改动过，答案是行号",
    "predict": "预测输出：先判断这段代码打印什么",
    "fix": "修好它：改代码让输出对上期望值",
}


def _render_code_block(q: dict) -> list[str]:
    """代码题的代码要一起给模型 —— 题干写着"下面这段"，不附代码它只能瞎猜。

    代码题的 `answer` 不是字母（是原文片段 / 行号 / 运行输出），所以这里
    额外把模式说清楚。这个字段只有刷题站的代码题才有，其它题库不会出现。
    """
    code = q.get("code")
    if not code:
        return []
    mode = str(q.get("mode") or "").strip()
    label = CODE_MODE_TEXT.get(mode, mode or "代码题")
    return [f"代码（{label}）：", "```", str(code), "```"]


def _render_tutor_question(question: dict) -> str:
    """把一道题渲染成教练的上下文。字段缺失时安静跳过，绝不抛。"""
    q = question or {}
    parts = [f"题型：{q.get('type') or '未知'}"]
    if q.get("chapter"):
        parts.append(f"章节：{q['chapter']}")
    if q.get("no") is not None:
        parts.append(f"题号：{q['no']}")
    parts.append(f"题干：{q.get('stem') or ''}")

    for opt in q.get("options") or []:
        if isinstance(opt, dict):
            parts.append(f"  {opt.get('key')}. {opt.get('text')}")

    parts.extend(_render_code_block(q))

    answer = q.get("answer")
    if isinstance(answer, (list, tuple)) and answer:
        shown = "、".join(str(a) for a in answer)
        if (q.get("type") or "") == "judge":
            shown = "、".join({"T": "正确", "F": "错误"}.get(str(a), str(a)) for a in answer)
        parts.append(f"正确答案：{shown}")
    if q.get("law"):
        parts.append(f"法规依据：{q['law']}")
    if q.get("analysis"):
        parts.append(f"已有解析：{q['analysis']}")
    return "\n".join(parts)


def tutor(
    question: dict,
    message: str,
    *,
    history: list[dict] | None = None,
    domain: str = "generic",
) -> dict:
    """AI 教练：就着某一道题回答学员的追问。

    @param question 题目上下文（no/type/stem/options/answer/law/analysis）
    @param message  学员这一句
    @param history  之前的对话 [{"role":"user"|"assistant","content":...}]
    """
    ask = (message or "").strip()
    if not ask:
        raise ValueError("message 不能为空")

    pack = prompts.pack(domain)
    rendered = _render_tutor_question(question)
    system = pack["tutor_system"]
    # ⚠️ 提示词包**必须**留 {question} 占位。docs 包曾经漏了它，而 `.format(question=…)`
    # 对没有占位的模板是**静默忽略**的 —— 于是模型完全看不到题目，
    # 实测它会反过来问学员"把题目或代码贴出来"（2026-10-08 板子上真调一次才发现）。
    # 所以这里两层：有占位就填；没有就**把题目贴在后面**，绝不让模型空着题目回答。
    # （另一个包 PromptPackTests 里有断言盯着，防止将来新加的包又漏占位。）
    if "{question}" in system:
        system = system.format(question=rendered)
    else:
        system = f"{system}\n\n{rendered}"

    messages: list[dict] = [{"role": "system", "content": system}]
    # 只保留最近的若干轮，并且只认 user/assistant 两种角色
    # （前端传了别的角色一律丢弃，避免把系统提示注入进来）
    for turn in (history or [])[-MAX_TUTOR_HISTORY:]:
        if not isinstance(turn, dict):
            continue
        role = turn.get("role")
        content = str(turn.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": ask})

    trace = _SourceTrace()
    result = llm.chat_with_fallback(
        messages,
        validate=lambda text: bool(_plain_text(text)),
        temperature=0.5,
        max_tokens=MAX_TUTOR_TOKENS,
        task="tutor",
        prefer=_coach_prefer(),
    )
    trace.add(result)

    answer = _plain_text(result.get("text") or "")
    if not answer:
        raise llm.LlmError("模型这次没有给出回答，换个问法再试试")

    return {"ok": True, "answer": answer, "llmSource": trace.as_dict()}


def _render_wrong_item(item: dict) -> str:
    """把一道错题渲染成诊断材料：题干 + 正确答案 + 学员的选择 + 章节/标签。"""
    q = item or {}
    parts = []
    if q.get("no") is not None:
        parts.append(f"第 {q['no']} 题")
    if q.get("chapter"):
        parts.append(f"[{q['chapter']}]")
    if q.get("tags"):
        parts.append(f"（标签：{'、'.join(str(t) for t in q['tags'])}）")
    head = " ".join(parts)

    lines = [head, f"  题干：{q.get('stem') or ''}"]
    for opt in q.get("options") or []:
        if isinstance(opt, dict):
            lines.append(f"    {opt.get('key')}. {opt.get('text')}")

    code_lines = _render_code_block(q)
    if code_lines:
        lines.extend(f"  {line}" for line in code_lines)

    def _show(keys) -> str:
        if not isinstance(keys, (list, tuple)) or not keys:
            return "（空）"
        if (q.get("type") or "") == "judge":
            return "、".join({"T": "正确", "F": "错误"}.get(str(k), str(k)) for k in keys)
        return "、".join(str(k) for k in keys)

    lines.append(f"  正确答案：{_show(q.get('answer'))}")
    lines.append(f"  学员选择：{_show(q.get('picked'))}")
    return "\n".join(lines)


def diagnose(wrongs: list[dict], *, subject: str = "", domain: str = "generic") -> dict:
    """错题诊断：把一批错题交给模型，归纳薄弱考点并给复习顺序。"""
    rows = [w for w in (wrongs or []) if isinstance(w, dict) and w.get("stem")]
    if not rows:
        raise ValueError("wrongs 不能为空：至少要有一道带题干的错题")

    pack = prompts.pack(domain)
    content = "\n\n".join(_render_wrong_item(w) for w in rows)
    if subject:
        content = f"科目：{subject}\n\n{content}"

    trace = _SourceTrace()
    result = llm.chat_with_fallback(
        [
            {"role": "system", "content": pack["diagnose_system"]},
            {"role": "user", "content": pack["diagnose_template"].format(
                count=len(rows), content=content
            )},
        ],
        validate=lambda text: bool(_plain_text(text)),
        temperature=0.4,
        max_tokens=MAX_TUTOR_TOKENS * 2,
        task="diagnose",
        prefer=_coach_prefer(),
    )
    trace.add(result)

    answer = _plain_text(result.get("text") or "")
    if not answer:
        raise llm.LlmError("模型这次没有给出诊断结果，稍后再试")

    return {"ok": True, "answer": answer, "count": len(rows), "llmSource": trace.as_dict()}


# --------------------------------------------------------------------------
# 3.6：AI 批改学生的作业（演武场的「让 AI 检查」）
#
# 这是任务回路的**最后半步**：学生写完代码 → 运行看到真实结果 → 他自己觉得行了 →
# 这里给结构化的反馈（哪里对 / 哪里不对 / 下一步补什么）。
#
# 和上面几个功能一样的规矩：
#   · LLM 调用**只走 llm.chat_with_fallback**（先本机后云端 + 超时 + 冷却），
#     这里绝不自己写 HTTP —— 一个判据一处实现（坑 58/110）；
#   · 模型只负责产出候选，**能不能用由我们这边的校验决定**（_review_points）。
# --------------------------------------------------------------------------

#: 批改结果最多几条意见 / 每条多少字。**提示词里也写着这两个数**，
#: 这里再兜一层：模型（尤其本机小模型）很爱写成一大段，前端那种分色列表会被撑爆。
MAX_REVIEW_POINTS = 5
MAX_REVIEW_POINT_CHARS = 60
#: summary / next 各自的字数上限（"一句话结论"和"下一步"，不是作文）
MAX_REVIEW_LINE_CHARS = 120
#: 学生代码的字符上限。超了**直接报错**而不是偷偷截断 —— 截掉一半再批改，
#: 人拿到的是"对另一段代码的评价"，比不给还糟。
MAX_REVIEW_CODE_CHARS = 20000
#: 运行输出的上限。这个截断无所谓（它是"证据"，不是被打分的对象），
#: 截了会明确写出来。
MAX_REVIEW_OUTPUT_CHARS = 4000
#: "我想做什么"的上限。只是一句话的目标，写长了也没有用。
MAX_REVIEW_GOAL_CHARS = 300
#: 认不出的目标/语言都给一句人话兜住，而不是空着让模型去猜。
REVIEW_GOAL_MISSING = "（学生没有写目标，就按代码本身判断，不要替 TA 编一个目标）"
REVIEW_LANG_UNKNOWN = "不确定（按代码自己判断；判断不了就别下结论）"

#: 认得的语言 → 给模型看的说法。**认不出来就说认不出来**，别瞎猜：
#: 猜错了整段批改都会跑偏（把 Java 当 JS 讲，学生越看越糊涂）。
_REVIEW_LANGS = {
    "java": "Java",
    "js": "JavaScript",
    "javascript": "JavaScript",
    "vue": "Vue（单文件组件或片段）",
}

#: level 只能是这三档（前端按它分色：ok 绿 / bad 红 / todo 黄）。
#: 模型偶尔会写别的词（中文、近义词）。认得出来的对上去，认不出的落到 todo ——
#: 「还没做/下一步」是最安全的兜底：它不会让学生误以为某处已经通过了。
_REVIEW_LEVEL_ALIASES = {
    "ok": "ok", "good": "ok", "pass": "ok", "对": "ok", "好的": "ok", "没问题": "ok",
    "bad": "bad", "error": "bad", "fail": "bad", "wrong": "bad", "错": "bad", "错误": "bad",
    "不对": "bad", "有问题": "bad",
    "todo": "todo", "next": "todo", "warn": "todo", "待办": "todo", "下一步": "todo", "还没做": "todo",
}


def _clip(text, limit: int) -> str:
    """把一句话压成一行、并夹到 limit 字以内（超了用省略号，别截成半句话还没提示）。"""
    line = " ".join(_plain_text(text).split())
    if len(line) <= limit:
        return line
    return line[: max(1, limit - 1)] + "…"


def _review_points(payload) -> list[dict]:
    """把模型给的 points 过一遍校验，返回能直接给前端渲染的那几条。

    抽成函数是为了让「本机这一次算不算合格」（_review_usable，决定要不要升级到云端）
    和最终返回给前端的内容**用同一套规则** —— 和 _graph_parts 同一个理由：
    两套规则迟早跑偏，就会出现「判据说合格所以没升级、结果又一条都用不上」。

    规矩：
      · level 只认 ok / bad / todo（近义词对上去，认不出的按 todo 兜）；
      · text 走 _plain_text（模型很爱回 `**重点**`，前端是纯文本，星号会原样显示）；
      · 最多 MAX_REVIEW_POINTS 条、每条最长 MAX_REVIEW_POINT_CHARS 字。
    """
    raw_points = (payload or {}).get("points") if isinstance(payload, dict) else None
    points: list[dict] = []
    for raw in raw_points or []:
        if isinstance(raw, dict):
            level = str(raw.get("level") or raw.get("kind") or "").strip().lower()
            text = raw.get("text") or raw.get("point") or raw.get("content") or ""
        elif isinstance(raw, str):
            level, text = "", raw  # 只给了一句话：当"下一步"处理
        else:
            continue
        line = _clip(text, MAX_REVIEW_POINT_CHARS)
        if not line:
            continue
        points.append({"level": _REVIEW_LEVEL_ALIASES.get(level, "todo"), "text": line})
        if len(points) >= MAX_REVIEW_POINTS:
            break
    return points


def _review_usable(text: str) -> bool:
    """本机这一次「批改」算不算合格：能抠出 JSON，且至少有一条能用的意见。

    判据取「有一条意见」而不是「有 summary」：学生要的正是"哪里对、哪里不对"，
    只有一句总评等于没批改；那种才值得升级到云端重来一次。
    """
    payload = llm.extract_json(text)
    if not isinstance(payload, dict):
        return False
    return bool(_review_points(payload))


def review_code(goal: str, code: str, lang: str = "", output: str = "") -> dict:
    """批改一段学生自己写的代码，返回 {summary, points, next}。

    @param goal   学生想做什么（可以空 —— 他没写目标时别逼他，也别替他编一个）
    @param code   他写的代码（**不可信输入**，只当数据放进 user 消息）
    @param lang   'java' / 'js' / 'vue'；认不出来就说认不出来
    @param output 他上次运行看到的结果（空＝还没运行过，就只能做静态判断）
    """
    source = str(code or "")
    if not source.strip():
        raise ValueError("代码是空的：先写点东西，再让 AI 检查")
    if len(source) > MAX_REVIEW_CODE_CHARS:
        raise ValueError(
            f"代码太长（{len(source)} 字符，上限 {MAX_REVIEW_CODE_CHARS}）："
            "先只留想检查的那一段，改完再看"
        )

    run_text = str(output or "").strip()
    if len(run_text) > MAX_REVIEW_OUTPUT_CHARS:
        # 输出是"证据"，截断不会误导；但要写明截过，别让人以为程序就输出到这里。
        run_text = run_text[:MAX_REVIEW_OUTPUT_CHARS] + "\n…（输出太长，已截断）"

    lang_label = _REVIEW_LANGS.get(str(lang or "").strip().lower(), REVIEW_LANG_UNKNOWN)
    goal_text = _clip(goal, MAX_REVIEW_GOAL_CHARS) or REVIEW_GOAL_MISSING
    # ⚠️ 这一句是**两种情况的唯一区别**（有单测盯着）：没运行过时必须说清是静态判断。
    run_note = prompts.REVIEW_RUN_DONE if run_text else prompts.REVIEW_RUN_MISSING

    messages = [
        {"role": "system", "content": prompts.REVIEW_SYSTEM},
        {
            "role": "user",
            # 学生的代码只**替换进模板的值**（str.format 不会再去解析替换进来的内容），
            # 所以代码里的 { } 和中文引号都安全；它进的是 user 消息，不进 system。
            "content": prompts.REVIEW_TEMPLATE.format(
                goal=goal_text,
                lang=lang_label,
                run_note=run_note,
                output=run_text or "（学生还没有运行过）",
                code=source,
            ),
        },
    ]

    trace = _SourceTrace()
    payload, result = _chat_json(
        messages,
        temperature=0.2,
        validate=_review_usable,
        task="review",  # 本机在这个功能上顶不顶得住，单独记一笔冷却
        # 批改是**给学生看的教学内容**，和 tutor/diagnose 同一档（本机 1.5B 可能讲歪），
        # 所以复用同一个偏好开关 QUIZ_COACH_PREFER，不再造第二个开关。
        prefer=_coach_prefer(),
    )
    trace.add(result)

    if not isinstance(payload, dict):
        raise llm.LlmError("AI 没能给出批改结果（可以再点一次试试）")

    points = _review_points(payload)
    if not points:
        raise llm.LlmError("AI 这次没给出能用的意见（可以再点一次试试）")

    return {
        # ⚠️ 必须自己带 ok：views 的 _ok() 只是序列化，不会替你补这个字段
        # （漏了它前端会把成功响应当失败，见 build_graph 上面那条注释）。
        "ok": True,
        "summary": _clip(payload.get("summary"), MAX_REVIEW_LINE_CHARS)
        or "模型这次只给了分点意见，没有给总评。",
        "points": points,
        "next": _clip(payload.get("next"), MAX_REVIEW_LINE_CHARS),
        "llmSource": trace.as_dict(),
    }


# ══════════════════════════════════════════════════════════════════════
# 3.5：按课本 + 他的弱项留一个**任务**（任务回路的左半段）
#
# 站主要的回路是：课本 → **按他的基础生成任务** → 他做 → 运行看结果 →
# 他觉得行了 → AI 批改。右半段（review / SnippetRunner）已经在线上，
# 这一节补的是左边那半步：产出的是**任务**（做什么 + 什么算完成），不是"题"。
#
# ⚠️ 复用同一条 LLM 通路（_chat_json → llm.chat_with_fallback），**不另写一份调用**。
#    这里和 review_code 的唯一区别是提示词和"什么算合格"的判据。
#
# 三条"不许编"的落地（提示词管一层，代码再管一层 —— 光靠提示词挡不住模型）：
#   ① 教材文字 / 错题标签只进 user 消息、被定界符圈起来（它们是数据，不是指令）；
#   ② ★ 给到学生看的**引文**必须能在教材文字里逐字命中（忽略空白差异）；
#      模型给的引文对不上时，由 `_task_fallback_quote` 从材料里**自己挑一句**顶上 ——
#      所以学生看到的每一句"教材原话"都真的来自课本；
#   ③ `fromPage` 也只能是材料里出现过的页号，模型报的页号对不上就用材料里的首页。
# ══════════════════════════════════════════════════════════════════════

#: 各字段的字数上限。**和 prompts.TASK_* 里写的必须一致**（改一处要改两处，
#: 有单测盯着提示词里的数字）。
MAX_TASK_GOAL_CHARS = 80
MAX_TASK_WHY_CHARS = 80
MAX_TASK_HINT_CHARS = 80
MAX_TASK_DONE_CHARS = 40
MAX_TASK_QUOTE_CHARS = 32
MIN_TASK_QUOTE_CHARS = 8
MAX_TASK_DONE_ITEMS = 4
MIN_TASK_DONE_ITEMS = 2
MAX_TASK_START_LINES = 40
MAX_TASK_START_CHARS = 4000
#: 教材文字的字符上限。和 views 的生成接口同一个量级：这一章的预习页远小于它，
#: 超了基本是前端把整本书传上来了。
MAX_TASK_MATERIAL_CHARS = 20000
#: 弱项标签最多带几条（前端只挑最弱的 2~3 个；多了是前端的问题，这里直接截）
MAX_TASK_WEAK_ITEMS = 8

#: 认得的语言。**只有这两种**：SnippetRunner 能跑的就是 Java（后端真跑）和 JS/Vue（浏览器沙箱）。
TASK_LANGS = ("java", "js")
#: 认得的阶段（前端三档；认不出来宁可报错，也别让模型按错的阶段出任务）
TASK_LEVELS = ("初学", "在学", "复习")

#: "起始代码能跑起来"的判据：Java 必须有 main，JS 必须有一句输出。
#: 为什么按这个判：任务卡上的"运行"就在下面，起手代码跑不起来 = 学生第一下就卡住。
_TASK_RUNNABLE = {
    "java": re.compile(r"static\s+void\s+main\s*\(", re.I),
    "js": re.compile(r"\b(console\.log|print)\s*\(", re.I),
}
#: 伪代码的记号（提示词里禁了，这里再拦一道）
_RE_TASK_PSEUDO = re.compile(r"(伪代码|此处省略|省略若干|^\s*[.·…]{2,}\s*$)", re.M)
#: 引号里的一小段（why 里的引用 / 模型自带引号的引文）
_QUOTE_OPEN = "「『“‘\"'"
_QUOTE_CLOSE = "」』”\"'"
_RE_QUOTED = re.compile(
    f"[{re.escape(_QUOTE_OPEN)}]([^{re.escape(_QUOTE_OPEN + _QUOTE_CLOSE)}]{{4,60}})"
    f"[{re.escape(_QUOTE_CLOSE)}]"
)
#: 材料里的页码标记（前端 core/task.js 的 lessonMaterial 写的就是这个形状）
_RE_MATERIAL_PAGE = re.compile(r"\[p(\d{1,4})\]")
#: 拆句：中文句读 + 英文句读 + 换行（挑兜底引文时用）
_RE_SENTENCE = re.compile(r"[^。；！？!?;\n]+")


def _squash_indexed(text: str) -> tuple[str, list[int]]:
    """`_squash` 的带索引版本：返回（压平后的串, 每个字在原文里的下标）。

    为什么要索引：命中之后要把**教材自己那几个字**取出来给学生看
    （而不是把模型那份空格乱掉的副本发出去）。`_verbatim_in` 靠它把
    "压平后命中"翻译回"原文里的那一段"。
    """
    chars: list[str] = []
    positions: list[int] = []
    for index, ch in enumerate(str(text or "")):
        # 零宽字符（OCR 很爱丢）与所有空白：都不参与比较
        if ch in "\u200b\u200c\u200d\ufeff" or ch.isspace():
            continue
        ch = ch.replace("“", '"').replace("”", '"').replace("‘", "'").replace("’", "'")
        out = ord(ch)
        # 全角 ASCII（ＡＢＣ １２３ （））→ 半角：中文标点不在这个区间，不受影响
        if 0xFF01 <= out <= 0xFF5E:
            ch = chr(out - 0xFEE0)
        chars.append(ch)
        positions.append(index)
    return "".join(chars), positions


def _squash(text: str) -> str:
    """**去掉所有空白、抹平引号与全角**再比 —— 用来判"这句原文是不是真的在材料里"。

    为什么不能直接 `in`：OCR / 排版会把「每20s」写成「每 20s」，模型抄原文时
    也会把换行弄乱。这些差异不算"抄错"。这一档和 quiz/tools/docs_to_bank.py 的
    `_squash` 是同一条判据（那边判的是题库出处，这边判的是任务引文；
    后端在板子上跑，import 不到那个离线管线，所以规则各写一份、行为由单测钉住）。
    """
    return _squash_indexed(text)[0]


def _verbatim_in(candidate: str, material: str) -> str:
    """这句候选引文是不是材料里的原文？

    是就返回**材料里的那一段原样文字**（不是模型给的那份副本，见 _squash_indexed），
    不是就返回空串。太短的（< MIN_TASK_QUOTE_CHARS）一律不算 —— "的" 也命中就白校验了。
    """
    text = str(candidate or "").strip().strip(_QUOTE_OPEN + _QUOTE_CLOSE).strip()
    want = _squash(text)
    if len(want) < MIN_TASK_QUOTE_CHARS:
        return ""
    hay, positions = _squash_indexed(material)
    at = hay.find(want)
    if at < 0:
        return ""
    found = str(material)[positions[at] : positions[at + len(want) - 1] + 1].strip()
    # ★ 我们给前端材料加的**版面记号**（`【骨架】` 这种分节标题）不算教材原文：
    #   它虽然是"能逐字命中"的，但它不是课本里的话，贴出来学生会去找却找不到。
    if found.startswith("【"):
        return ""
    # 截到上限：**引文的子串仍然是原文**，所以这一步不会破坏"逐字命中"
    return found[:MAX_TASK_QUOTE_CHARS]


def _material_pages(material: str) -> list[int]:
    """材料里出现过的页号（升序、去重）。`fromPage` 只能从这里挑。"""
    return sorted({int(n) for n in _RE_MATERIAL_PAGE.findall(str(material or ""))})


def _task_fallback_quote(material: str, hint: str) -> str:
    """从材料里挑一句原文顶上（模型给的引文对不上时用）。

    挑法：把材料拆成句子，取长度合适、带实词的那些，按"和任务目标重合的字数"打分，
    分最高、且**在材料里出现得最早**的那句。确定性、可复现、可断言。

    为什么值得这么做，而不是直接不放引文：任务卡上那句「教材原话」是学生
    **唯一**能自己回去核对的东西。宁可引一句没那么贴题的原文，也不能让模型
    编一句"教材里的话"贴在那里 —— 那正是教育内容唯一不可接受的失败模式。
    """
    want = set(_squash(hint))
    best = ""
    best_score = -1
    for raw in _RE_SENTENCE.findall(str(material or "")):
        line = _RE_MATERIAL_PAGE.sub(" ", raw).strip()
        # 骨架里的标题行（【骨架】/ 页码标记）不算"原文"
        if not line or line.startswith("【") or line.startswith("#"):
            continue
        squashed = _squash(line)
        if not (MIN_TASK_QUOTE_CHARS <= len(squashed) <= MAX_TASK_QUOTE_CHARS * 2):
            continue
        if not re.search(r"[\u4e00-\u9fffA-Za-z]", line):
            continue
        score = sum(1 for ch in squashed if ch in want)
        if score > best_score:
            best, best_score = line, score
    return best[:MAX_TASK_QUOTE_CHARS] if best else ""


def _task_text(value) -> str:
    """模型给的字段**只有字符串才算数**。

    为什么不 `str(value)` 兜一下：模型偶尔把 goal 写成数组、把 why 写成对象，
    `str()` 会把它变成 "{'a': 1}" 这种看着"有内容"的东西混进任务卡 ——
    那是把一个明显不合格的回复包装成合格的（审查型的兜底宁可严）。
    """
    return value if isinstance(value, str) else ""


def _task_quote(payload: dict, material: str, scope: str) -> str:
    """定下给学生看的那句教材原文（**可能为空**，空 = 这次没有可引的教材原话）。

    顺序：模型在 why 里用「」圈出来的 → 模型单独给的 quote 字段。两者都要过
    **逐字命中**校验。都命中不了时两档做法**不一样**（这是那个开关的核心差别）：
      · 「只照书本」：从材料里**我们自己挑一句**顶上 —— 这一档的任务本来就建在教材上，
        引文是它的骨架，不能空着（挑出来的必然是原文，所以不算编）。
      · 「允许补充」：**留空**。教材外补出来的知识，宁可不给引文，也绝不拿模型编的句子
        冒充"教材原话"（站主的判据：允许它讲教材外的东西，但不允许它把教材外的话
        说成教材里的话）。
    """
    if not isinstance(payload, dict):
        return ""
    candidates = _RE_QUOTED.findall(_task_text(payload.get("why")))
    candidates.append(_task_text(payload.get("quote")))
    for candidate in candidates:
        found = _verbatim_in(candidate, material)
        if found:
            return found
    if scope == "book":
        hint = f"{_task_text(payload.get('goal'))}{_task_text(payload.get('why'))}"
        return _task_fallback_quote(material, hint)
    return ""


def _strip_quotes(text: str) -> str:
    """把没有校验过的引文从句子里摘掉：why 里的引用由我们自己拼（见 _task_why）。"""
    out = _RE_QUOTED.sub(" ", str(text or ""))
    out = out.replace("「", " ").replace("」", " ").replace("『", " ").replace("』", " ")
    return " ".join(out.split())


def _task_why(raw, quote: str) -> str:
    """拼 why：模型给的解释 + 那句**校验过的**教材原文，总长不超过 MAX_TASK_WHY_CHARS。

    为什么由代码来拼、不直接信模型：模型很容易在 why 里"顺手"编一句像原话的句子。
    这里把引文的位置留给 `quote`（它必然是教材里的），模型的话只当解释 ——
    所以学生看到的 why 里，凡是带引号的那段，回去翻书一定找得到。
    """
    explain = _strip_quotes(raw)
    if not quote:
        return _clip(explain, MAX_TASK_WHY_CHARS)
    tail = f"（教材原话：「{quote}」）"
    budget = MAX_TASK_WHY_CHARS - len(tail)
    if budget < 8:
        # 引文长到把位置占满了：留引文，解释只留一句话的开头
        return _clip(f"教材原话：「{quote}」", MAX_TASK_WHY_CHARS)
    head = _clip(explain, budget)
    return f"{head}{tail}" if head else f"教材原话：「{quote}」"


def _task_start(value) -> str:
    """清洗起始代码：剥掉模型加的 ``` 围栏、限行数（**不过 _plain_text**）。

    ⚠️ 千万别拿 `_plain_text` 洗代码：它会去掉行首的 `#`（Python 注释）和 `**`，
    还会把 ``` 围栏当成"散文的围栏"删掉 —— 那是在改学生要编译的东西。
    """
    src = _task_text(value).strip()
    if src.startswith("```"):
        lines = src.splitlines()
        lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        src = "\n".join(lines).strip()
    lines = src.splitlines()
    if len(lines) > MAX_TASK_START_LINES:
        lines = lines[:MAX_TASK_START_LINES]
    out = "\n".join(lines).strip()
    if len(out) > MAX_TASK_START_CHARS:
        return ""
    return out


def _task_runnable(start: str, lang: str) -> bool:
    """起手代码能直接跑吗？（Java 有 main / JS 有一句输出；且不是伪代码）"""
    text = str(start or "")
    if not text.strip():
        return False
    if _RE_TASK_PSEUDO.search(text):
        return False
    return bool(_TASK_RUNNABLE.get(lang, _TASK_RUNNABLE["js"]).search(text))


def _task_done(value) -> list[str] | None:
    """完成判据：2~4 条、每条一句话；不够 2 条就当不合格（那是"没说什么算完成"）。"""
    if isinstance(value, str):
        raw = [value]
    elif isinstance(value, list):
        raw = value
    else:
        return None
    out: list[str] = []
    for item in raw:
        text = item.get("text") if isinstance(item, dict) else item
        line = _clip(_task_text(text), MAX_TASK_DONE_CHARS)
        if line:
            out.append(line)
    if len(out) < MIN_TASK_DONE_ITEMS:
        return None
    # 多于 4 条就截断（提示词要 2~4；为这个把整次生成判死太亏）
    return out[:MAX_TASK_DONE_ITEMS]


def _task_fields(payload, material: str, lang: str, scope: str) -> dict | None:
    """把模型给的 JSON 过一遍校验，返回能直接给前端渲染的任务；不合格返回 None。

    ★ 这个函数就是"什么算合格"的**唯一实现**：本机这一次顶不顶得住
    （_task_usable，决定要不要升级到云端）和最终发给前端的，都走它 ——
    两套规则迟早跑偏（和 _review_points / _graph_parts 同一个理由）。

    ★ 两档（scope）的差别**只在这里的 quote 那一条**，别的判据两档共用：
      引文可以放宽（允许补充档允许空着），但**下面这三条从不放宽** ——
        · goal 要有（一句话说要做出什么）
        · start 必须能跑（有 main / 有能 print 的东西）
        · done 要有、2~4 条、可验证
      站主那句"讲错了比讲不出更糟"说的就是这个：坏任务比没有任务更糟。
    """
    if not isinstance(payload, dict):
        return None
    goal = _clip(_task_text(payload.get("goal")), MAX_TASK_GOAL_CHARS)
    if not goal:
        return None
    start = _task_start(payload.get("start"))
    if not _task_runnable(start, lang):
        return None
    done = _task_done(payload.get("done"))
    if done is None:
        return None
    hint = _clip(_task_text(payload.get("hint")), MAX_TASK_HINT_CHARS)
    if not hint:
        return None

    quote = _task_quote(payload, material, scope)
    why = _task_why(_task_text(payload.get("why")), quote)
    if not why:
        return None

    pages = _material_pages(material)
    try:
        want = int(payload.get("fromPage") or 0)
    except (TypeError, ValueError):
        want = 0
    from_page = want if (want and want in pages) else (pages[0] if pages else 0)
    # ★ 没有引文就没有页码：允许补充档补出来的知识**不许**假装来自某一页。
    #   （这一档的 why 里也不会出现"教材原话"，前端那行本来就不显示。）
    if not quote:
        from_page = 0

    return {
        "goal": goal,
        "why": why,
        # 单独带一份**校验过的**教材原文：前端把它单独显示一行，学生能照着回去翻书
        # （why 里也拼了同一句；这份是给机器核对的，也是给"引文真的来自课本"作证的）。
        # 「允许补充」档下它可能是空的 —— 空就表示这次**没有**教材引文，不是"引文丢了"。
        "quote": quote,
        "start": start,
        "done": done,
        "hint": hint,
        "lang": lang,
        "fromPage": from_page,
        "scope": scope,
    }


def _task_usable(text: str, material: str, lang: str, scope: str) -> bool:
    """本机这一次"留任务"算不算合格：能抠出 JSON，且字段过了 _task_fields。"""
    payload = llm.extract_json(text)
    if not isinstance(payload, dict):
        return False
    return _task_fields(payload, material, lang, scope) is not None


def _task_weak_text(weak) -> tuple[str, str]:
    """弱项 → (给模型看的那段文字, 弱项说明)。

    ⚠️ 弱项是**不可信输入**（来自浏览器的 localStorage）：这条只负责"能不能读成
    一串统计"，不做任何执行；真正把它当数据处理的是提示词那一层（定界符 + 明说不可执行）。
    """
    if weak is None:
        weak = []
    if not isinstance(weak, list):
        raise ValueError("weak 必须是数组：形如 [{\"tag\":\"数组遍历\",\"wrong\":3,\"total\":5}]")

    rows: list[str] = []
    for item in weak[:MAX_TASK_WEAK_ITEMS]:
        if isinstance(item, str):
            tag = item.strip()
            wrong = total = 0
        elif isinstance(item, dict):
            tag = str(item.get("tag") or item.get("name") or "").strip()
            try:
                wrong = int(item.get("wrong") or 0)
            except (TypeError, ValueError):
                wrong = 0
            try:
                total = int(item.get("total") or 0)
            except (TypeError, ValueError):
                total = 0
        else:
            continue
        if not tag:
            continue
        tag = tag[:MAX_TASK_DONE_CHARS]
        rows.append(f"{tag}（错 {max(0, wrong)} / 共 {max(0, total)}）")

    if not rows:
        return "", prompts.TASK_NO_WEAK
    return "\n".join(rows), "上面这些就是他最近错得最多的几个标签，任务要练到它们。"


def _task_budget() -> int:
    """生成任务时**单次 HTTP 调用**的时间上限（秒）。

    为什么必须给（2026-10-11 线上实测，见 PRODUCT.md §5.4.1）：
    `_chat_json` 默认重试 2 次，每次尝试又走「云端 → 本机」整条降级链，
    而每段都可能耗到 `QUIZ_LLM_TIMEOUT`（板子上 75s）—— 最坏 ≈ 2 × (75 + 75) ≈ 300s，
    反代约 100s 就掐 ⇒ **材料一长，第一次点「生成任务」必 502**。
    出题那条路没事，是因为它有 `_generate_budget()` 那道整批闸门兜着。

    ★ 最坏耗时怎么算（**按"每次 HTTP 调用"算，别按"每次尝试"算** —— 这里我算错过一次，
      实测把它纠正了）：一次生成任务的模型调用次数 =
        `_chat_json` 的 attempts × 降级链上的来源数（cloud 1 + local 的 local_attempts）。
      所以除了这道 timeout，调用处还必须把 `attempts=1, local_attempts=1` 一起压住，
      最坏才是 **2 次调用 × 40s = 80s**，落在反代上限（约 100s）以内、还留 20% 余量。
      只给 timeout、不压重试的话，最坏是 5 次 × 40s = 200s —— 照样被掐（探针量过）。

    40 秒的依据（2026-10-11 两个探针量出来的，不是拍的）：
      · **反代没有"20 秒"那道硬顶**。老板看到长材料失败只用 19.7/19/20.7s，和直连板子
        同一请求的 21.5s 一模一样 —— 那是**应用自己**在 ~20s 返了 5xx 之后被 CDN 换页，
        不是 CDN 在 20s 切人（Cloudflare 切人是 **524**，不是 502；它给 502 恰恰说明
        **源站已经答复了**）。仓库里记的那条老账也是 ~100s（api.js 的 SAFE_TIMEOUT 注释
        "原来的 110s 会让请求必挂"）。
      · 线上实测云端拿一次任务 4.9s / 10s / 15.8s。40s ≈ 最慢那次的 2.5 倍，
        而 2 × 40 = 80s 离 CDN 上限还有 20s 余量。
      · 真超时也不会甩一个 CDN 错误页：会走 `llm.LlmError` 那条**中文**路（"再点一次"）。
      · ⚠️ **别为了"材料长"去压它**：材料长短不是失败的触发条件（§5.4.4 的对照实验：
        同一份材料重试就可能成功；触发条件是**那一次模型输出能不能过校验**）。
        这道闸只负责"最坏别撞 CDN 上限"，不负责降低失败率。
    可用 `QUIZ_TASK_TIMEOUT` 覆盖（照 `QUIZ_GENERATE_BUDGET` 的样子，别在调用处写死）。
    ⚠️ 改大它要连着上面那条最坏值一起算：`2 × 预算` 必须明显小于 100s，
    `TaskTests.test_最坏耗时不会撞反代上限` 就是钉这件事的（改大了它会红）。
    """
    raw = (os.environ.get("QUIZ_TASK_TIMEOUT") or "").strip()
    if raw:
        try:
            value = int(float(raw))
            if value > 0:
                return value
        except ValueError:
            pass
    return 40


def _task_material(material: str) -> str:
    """送进**提示词**的那份教材 —— 原样，一个字都不截。

    ★ 为什么刻意**不**在这里限长（我一度加过 CHUNK_CHARS 的截断，后来撤了）：
      2026-10-11 的对照实验（PRODUCT.md §5.4.4）证明"材料一长就 502"是**错的** ——
      失败是**间歇性**的，触发条件是**那一次模型输出能不能过校验**，和材料长短无关。
      既然长度不是病因，就不该为了它去动教材内容：截掉一半材料等于让模型在
      看不见的那半章里挑知识点 —— 而这段材料是学生**唯一**能回去核对的东西。
      （要限的是"接口收多大的材料"，那是 MAX_TASK_MATERIAL_CHARS 管的事，在上面校验。）
    """
    return str(material or "")


def task_from_material(
    material: str,
    weak=None,
    *,
    lang: str = "java",
    level: str = "在学",
    scope: str = prompts.DEFAULT_TASK_SCOPE,
) -> dict:
    """按课本这一章的文字 + 他的弱项，留一个可以就地运行、就地交给 AI 检查的任务。

    返回 {ok, goal, why, quote, start, done, hint, lang, fromPage, scope, llmSource}。

    @param material 课本这一章的文字（**不可信输入**，只当数据放进 user 消息）
    @param weak     他的弱项 [{"tag","wrong","total"}]（同样不可信；空 = 数据不够）
    @param lang     'java' / 'js' —— 决定起手代码长什么样，也决定"能不能跑"怎么判
    @param level    '初学' / '在学' / '复习'
    @param scope    取材范围（站主要的那个开关）：
                    'book' = 只照书本（教材里没写的一个字都不许提，引文必须逐字命中）；
                    'open' = 允许补充（材料太薄时可以用通用知识把任务补完整，
                             但**绝不许把教材外的话说成教材原话**，见 _task_quote）。
                    默认 'open'（站主原话：「如果只照着书本，信息量不足以出题，所以放宽吧」）。
    """
    text = str(material or "")
    if not text.strip():
        raise ValueError("material 是空的：把课本这一章的文字传上来（预习页上那一份）")
    if len(text) > MAX_TASK_MATERIAL_CHARS:
        raise ValueError(
            f"教材文字太长（{len(text)} 字符，上限 {MAX_TASK_MATERIAL_CHARS}）：只传这一章就够了"
        )
    lang_key = str(lang or "").strip().lower()
    if lang_key not in TASK_LANGS:
        raise ValueError('lang 只能是 "java" 或 "js"')
    level_text = str(level or "").strip() or "在学"
    if level_text not in TASK_LEVELS:
        raise ValueError('level 只能是 "初学" / "在学" / "复习" 之一')
    scope_key = str(scope or "").strip().lower() or prompts.DEFAULT_TASK_SCOPE
    if scope_key not in prompts.TASK_SCOPES:
        raise ValueError('scope 只能是 "book"（只照书本）或 "open"（允许补充）')

    weak_text, weak_note = _task_weak_text(weak)

    lang_label = "Java" if lang_key == "java" else "JavaScript（Vue 片段也算）"
    messages = [
        # 取材范围决定 system：'book' 不许提教材外的东西，'open' 允许用通用知识补完，
        # 但两档共用同一条底线（不许把教材外的话说成教材原话）—— 见 prompts.task_system。
        {"role": "system", "content": prompts.task_system(scope_key)},
        {
            "role": "user",
            # 教材文字和弱项只**替换进模板的值**（str.format 不会解析替换进来的内容），
            # 所以教材里的 { } 和引号都安全；它们进的是 user 消息，不进 system。
            "content": prompts.TASK_TEMPLATE.format(
                material=_task_material(text),
                weak=weak_text or "（没有）",
                lang=lang_label,
                level=level_text,
                scope=prompts.TASK_SCOPE_LABEL[scope_key],
                weak_note=weak_note,
            ),
        },
    ]

    trace = _SourceTrace()
    payload, result = _chat_json(
        messages,
        temperature=0.3,
        # ★ 有界预算：这道闸是四件事一起给的，少一件都不成立（见 _task_budget()）
        #   timeout       = 单次 HTTP 调用上限（云端/本机各自都受它管）
        #   attempts      = 1：不再"整条链重走一遍"（那会让最坏值直接翻倍）
        #   local_attempts= 1：本机只试一次（1.5B 的 JSON 截断重试在这里不值得，
        #                     真给不出 JSON 时下面那句中文提示本来就写着"再点一次"）
        timeout=_task_budget(),
        attempts=1,
        local_attempts=1,
        validate=lambda raw: _task_usable(raw, text, lang_key, scope_key),
        task="task",  # 本机在这个功能上顶不顶得住，单独记一笔冷却
        # 留任务要**逐字引用教材**（精确活），和批改同一档：复用同一个偏好开关，不造第二个
        prefer=_coach_prefer(),
    )
    trace.add(result)

    fields = _task_fields(payload, text, lang_key, scope_key)
    if fields is None:
        if not isinstance(payload, dict):
            raise llm.LlmError("AI 没能给出任务（可以再点一次试试）")
        raise llm.LlmError(
            "AI 这次给的任务不能用（起手代码跑不起来 / 完成判据不齐 / 少了提示）：再点一次试试"
        )

    fields["ok"] = True  # views 的 _ok() 只是序列化，不会替你补这个字段
    fields["llmSource"] = trace.as_dict()
    return fields


# --------------------------------------------------------------------------
# 4：AI 出题
# --------------------------------------------------------------------------

# 同上：内容以 prompts.GENERIC_* 为准，这里只是别名。
_GENERATE_SYSTEM = prompts.GENERIC_GENERATE_SYSTEM
_GENERATE_TEMPLATE = prompts.GENERIC_GENERATE_TEMPLATE


# ═══════════════════════════ AI 知识图谱 ═══════════════════════════
#
# 把「已经做过的题」归纳成一张概念网络。和出题/解析一样：模型只负责产出
# 候选，**能不能用由我们这边的校验决定**（节点 id 必须存在、边不能悬空、
# 层次只能是我们认得的三种）。

_GRAPH_SYSTEM = (
    "你是学科知识体系整理专家。你只输出 JSON，不加解释、不加代码围栏。"
    "你擅长把零散题目归纳成有层次、有关系、能复习的概念网络。"
)

_GRAPH_TEMPLATE = """下面是一个题库里的题目（题型、题干、答案、已有标签）。
请把它们归纳成一张**知识图谱**：哪些是核心概念、概念之间是什么关系。

要求：
1. 节点只放**知识点/概念/理论**，不要把"第3题"这种题号当节点；
2. 每条关系写成 4~10 个字的短语（如"包含""决定""来源于""检验""对立于"），不要写成句子；
3. weight 给 1~5：这个知识点在这批题里出现越多、越容易错，就给越高；
4. kind 标明层次，只能是这三个字之一：
   '章'（大板块）、'节'（中等主题）、'点'（具体概念/原理）；
5. 尽量**复用题目已有的标签当节点名** —— 这样能和刷题页的标签筛选对上；
6. 最多 {max_nodes} 个节点、{max_edges} 条关系，宁可少而准，不要凑数。

输出格式：
{{"nodes":[{{"id":"k1","label":"实事求是","kind":"点","weight":5}}],
 "edges":[{{"from":"k1","to":"k2","label":"是…的精髓"}}]}}

题目：
{content}"""

_KINDS = ("章", "节", "点")


def _render_graph_item(item: dict) -> str:
    """把一道题压成一行给模型看：题号/题型/题干/答案/标签。"""
    tags = item.get("tags") or []
    tag_text = f"　标签：{'、'.join(tags)}" if tags else ""
    answer = item.get("answer") or []
    answer_text = "、".join(str(a) for a in answer) if answer else "（无）"
    stem = str(item.get("stem") or "").replace("\n", " ")[:80]
    return f"第{item.get('no')}题[{item.get('type')}] {stem}　答案：{answer_text}{tag_text}"


def _graph_parts(payload, max_nodes: int, max_edges: int) -> tuple[list[dict], list[dict], int]:
    """把模型给的图谱过一遍校验，返回 (节点, 边, 被丢掉的悬空边数)。

    抽成函数是为了让「本机产出算不算合格」（_graph_usable，决定要不要升级到云端）
    和最终返回给前端的图谱**用同一套规则**。两套规则一定会跑偏：判据说合格、
    真入库时又全被丢掉，用户看到的就是「升级了还是没有图」。
    """
    # ---- 节点校验 ----
    nodes: list[dict] = []
    seen_ids: set[str] = set()
    seen_labels: set[str] = set()
    for raw in (payload or {}).get("nodes") or []:
        if not isinstance(raw, dict):
            continue
        node_id = str(raw.get("id") or "").strip()
        label = str(raw.get("label") or raw.get("name") or "").strip()
        if not node_id or not label:
            continue
        if node_id in seen_ids or label in seen_labels:
            continue  # 同一个概念被写了两遍
        kind = str(raw.get("kind") or "点").strip()
        if kind not in _KINDS:
            kind = "点"
        try:
            weight = int(raw.get("weight") or 3)
        except (TypeError, ValueError):
            weight = 3
        seen_ids.add(node_id)
        seen_labels.add(label)
        nodes.append({"id": node_id, "label": label, "kind": kind, "weight": max(1, min(5, weight))})
        if len(nodes) >= max_nodes:
            break

    # ---- 边校验：两端都必须存在，且不能自环 ----
    edges: list[dict] = []
    seen_edges: set[tuple[str, str, str]] = set()
    dangling = 0
    for raw in (payload or {}).get("edges") or []:
        if not isinstance(raw, dict):
            continue
        src = str(raw.get("from") or raw.get("source") or "").strip()
        dst = str(raw.get("to") or raw.get("target") or "").strip()
        label = str(raw.get("label") or "").strip()
        if src not in seen_ids or dst not in seen_ids:
            dangling += 1
            continue
        if src == dst:
            continue
        key = (src, dst, label)
        if key in seen_edges:
            continue
        seen_edges.add(key)
        edges.append({"from": src, "to": dst, "label": label})
        if len(edges) >= max_edges:
            break

    return nodes, edges, dangling


def _graph_usable(text: str, max_nodes: int, max_edges: int) -> bool:
    """本机这一次「归纳图谱」算不算合格：至少有一个合法知识点。

    判据取「有节点」而不是「节点够多」：本机 1.5B 出得少是能力问题，
    少总比没有强；一条节点都产不出来才是真的没顶住，那种才值得升级到云端。
    """
    payload = llm.extract_json(text)
    if not isinstance(payload, dict):
        return False
    nodes, _edges, _dangling = _graph_parts(payload, max_nodes, max_edges)
    return bool(nodes)


def build_graph(questions: list[dict], *, max_nodes: int = 14, max_edges: int = 18) -> dict:
    """把一批题目归纳成知识图谱。

    返回 {nodes, edges, warnings}。**只返回通过校验的部分** —— 模型编出来的
    悬空边（指向不存在的节点）会被丢掉并记进 warnings，而不是让前端去崩。

    默认规模刻意压得小（14 节点 / 18 关系）：本机 1.5B 的输出上限是
    2048 token，一开始我让它出 40 节点 + 60 关系，结果 JSON 写到一半就被截断，
    `extract_json` 直接失败（实测：180 秒白跑）。**宁少而准**，反正知识图谱
    是给人看的，十几个概念比四十个更能看清结构。
    """
    rows = [q for q in (questions or []) if isinstance(q, dict) and q.get("stem")]
    if not rows:
        raise ValueError("没有可用的题目：至少传一道带题干的题")

    # 送太多题会超上下文，也拖慢本机模型；按题号均匀取样
    if len(rows) > 60:
        step = len(rows) / 60
        rows = [rows[int(i * step)] for i in range(60)]

    trace = _SourceTrace()
    payload, result = _chat_json(
        [
            {"role": "system", "content": _GRAPH_SYSTEM},
            {
                "role": "user",
                "content": _GRAPH_TEMPLATE.format(
                    max_nodes=max_nodes,
                    max_edges=max_edges,
                    content="\n".join(_render_graph_item(q) for q in rows),
                ),
            },
        ],
        temperature=0.3,
        validate=lambda text: _graph_usable(text, max_nodes, max_edges),
        task="graph",  # 板子上本机算这个要 180+ 秒还可能不合格，冷却的意义最大
    )
    trace.add(result)

    warnings: list[str] = []
    if not isinstance(payload, dict):
        raise llm.LlmError("AI 没能返回图谱 JSON（可以重试一次，或换一批题再试）")

    nodes, edges, dangling = _graph_parts(payload, max_nodes, max_edges)

    if not nodes:
        raise llm.LlmError("AI 没产出可用的知识点（可以重试一次，或换一批题再试）")

    if dangling:
        warnings.append(f"丢掉了 {dangling} 条指向不存在知识点的关系")

    # ⚠️ 必须自己带 ok：views 里的 _ok() 只是原样序列化，**不会**替你补这个字段。
    # 漏了它前端就会把成功响应当失败处理（实测踩到：返回 200 但界面报"失败"）。
    return {
        "ok": True,
        "nodes": nodes,
        "edges": edges,
        "warnings": warnings,
        "sampled": len(rows),
        "llmSource": trace.as_dict(),
    }


def _quota(ask: int, wanted: list[str]) -> dict:
    """把 ask 道题的配额按题型轮着分。"""
    quota = {t: 0 for t in ("single", "multiple", "judge")}
    for i in range(max(0, ask)):
        quota[wanted[i % len(wanted)]] += 1
    return quota


def _generate_prefer(domain: str, prefer_cloud: bool | None) -> str:
    """
    出题用哪条来源打头。三档，从具体到宽松：

      1. 请求里明确写了 preferCloud（前端那个开关）→ 就用它
      2. 否则看 domain：**docs（官方文档 / 教材）默认 cloud**
      3. 再否则看环境变量 QUIZ_DOCS_PREFER（cloud / local / off）
      4. 都没有 → ""（不偏好，保持老的"先本机"链路）

    为什么 docs 默认云端：这个包要求**逐字引用原文**，而本机 qwen2.5:1.5b 干不了 ——
    2026-10-08 实测 20 道题里 10 道给出的"原文"在材料里**根本不存在**（都是凭记忆改写的），
    于是整批被引用校验丢掉，白跑一轮还污染审阅报告。
    这和 QUIZ_COACH_PREFER 默认 cloud 是同一个理由：**讲错了比讲不出更糟**。

    2026-10-09 补充：**通用材料（domain=""，也就是刷题站的 PDF/JSON 导入与 AI 出题）
    也改成云端优先**。用户实测的原话是「接口返回 524，除了让我的机器发热占我资源，
    什么用都没有，它吐不出题目就该用云了呀」—— 本机 1.5B 出题本来就只是"结构勉强合格"
    （_structure_usable 的标准很宽），白等一两分钟换一批要人工重挑的题，不如直接上云端。

    ⚠️ prefer 只是"把云端提到链子最前面"，**不是"只准用云端"**：
    云端没钱/超时的时候仍然会退回本机 —— 两条路都活着是这套链子的底线，不能破。
    （云端的可用性由 QUIZ_LLM_API_KEY 决定；本机那条永远留在链子上。）

    域自己的覆盖：QUIZ_DOCS_PREFER / QUIZ_GENERIC_PREFER（值 'local' / 'off' 都表示不偏好云端）。
    驾考站（drive）保持原样（先本机），他们的诉求没提过这个。
    """
    if prefer_cloud is True:
        return "cloud"
    if prefer_cloud is False:
        return ""
    dom = prompts.normalize_domain(domain)
    if dom == "drive":
        return "cloud" if (os.environ.get("QUIZ_DRIVE_PREFER") or "").strip().lower() == "cloud" else ""
    env_name = "QUIZ_DOCS_PREFER" if dom == "docs" else "QUIZ_GENERIC_PREFER"
    raw = os.environ.get(env_name)
    if raw is None:
        return "cloud"
    return "cloud" if raw.strip().lower() == "cloud" else ""


def generate_bank(
    material: str,
    *,
    count: int = 10,
    types: list[str] | None = None,
    title: str = "",
    subject: str = "",
    domain: str = "generic",
    prefer_cloud: bool | None = None,
) -> dict:
    """根据材料出题。types 是 ['single','multiple','judge'] 的子集。

    domain 选提示词包：默认 generic，驾考站传 "drive"，官方文档传 "docs"。
    prefer_cloud 三态：True = 云端先上；False = 明确允许本机先上；None = 按 domain 默认。
    """
    material = (material or "").strip()
    if len(material) < 20:
        raise ValueError("材料太短了：至少给一段能出题的正文（20 字以上）")

    pack = prompts.pack(domain)
    wanted = [t for t in (types or ["single", "multiple", "judge"]) if t in ("single", "multiple", "judge")]
    if not wanted:
        wanted = ["single"]

    total_wanted = max(1, min(count, 60))

    # ⚠️ 单次请求的题量必须按**链子上第一条**来源的能力定。
    # 本机小模型（qwen2.5:1.5b）一次要 12 道**基本必挂**：输出太长，
    # 要么 JSON 截断、要么题目结构跑偏，整批作废 —— 用户实际撞到的 502 就是这个。
    # 云端模型一次 8 道没问题。所以本机按 2 道一批循环凑。
    # （本机推理不花钱，多跑几轮换成功率是划算的。）
    # 注意这里用的是 primary_source() 而不是 config()["source"]：板子上既有 key
    # 又有 Ollama 时，config() 报的是云端，可链子第一档其实是本机 —— 按云端拆 8 道
    # 会让本机每一批都失败、然后每一批都升级去花钱，正好把「省钱」这件事做反。
    per_call = 2 if llm.primary_source() in ("local", "explicit") else 8

    warnings: list[str] = []
    questions: list[dict] = []
    usage = {}
    trace = _SourceTrace()

    # ★ 整批的墙钟上限（见 _generate_budget 的说明：反代约 100s 就掐，
    #   到了就先返回已有的题，而不是继续算到钱花光、结果没人收）
    budget = _generate_budget()
    deadline = time.monotonic() + budget

    for chunk in _split_material(material):
        if time.monotonic() >= deadline:
            warnings.append(
                f"到整批时间上限（{budget:.0f}s）先收手，已保留前面出的 {len(questions)} 道。"
                "要更多就分小批再传一次。"
            )
            break
        rounds = 0
        # 每块材料最多补 8 轮，避免模型一直产同一种题型时死循环
        while len(questions) < total_wanted and rounds < 8:
            if time.monotonic() >= deadline:
                warnings.append(
                    f"到整批时间上限（{budget:.0f}s）先收手，已保留前面出的 {len(questions)} 道"
                    "（再等下去反代会先掐断，你连这些也拿不到）。"
                )
                break
            rounds += 1
            ask = min(total_wanted - len(questions), per_call)
            quota = _quota(ask, wanted)
            try:
                payload, result = _chat_json(
                    [
                        {"role": "system", "content": pack["generate_system"]},
                        {"role": "user", "content": pack["generate_template"].format(
                            single=quota["single"],
                            multiple=quota["multiple"],
                            judge=quota["judge"],
                            content=chunk,
                        )},
                    ],
                    temperature=0.6,
                    validate=_structure_usable,
                    task="generate",  # 出题：本机大约每 4 次挂 1 次，单独记账
                    prefer=_generate_prefer(domain, prefer_cloud),
                )
            except llm.LlmError as exc:
                # 两条来源都顶不住（消息里两条原因都有）。同样别让整批作废：
                # 前面几轮已经出的题是有效产出，丢掉它等于「费力跑一半，一条都不给」。
                if questions:
                    warnings.append(f"AI 中途失败，已保留前面出的 {len(questions)} 道（{exc}）")
                    break
                raise
            trace.add(result)
            usage = (result or {}).get("usage") or usage
            if not isinstance(payload, dict) or not isinstance(payload.get("questions"), list):
                warnings.append("AI 返回的格式不对，这一段已跳过")
                break
            fresh = questions_from_llm(payload["questions"], warnings)
            if not fresh:
                warnings.append("这一轮没能产出可用题目，不再继续追加")
                break
            questions.extend(fresh)

    # 去重：题干（去掉空白后）完全一样就只留一道
    seen: set[str] = set()
    unique: list[dict] = []
    for item in questions:
        fingerprint = re.sub(r"\s+", "", item["stem"])
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        unique.append(item)

    for index, item in enumerate(unique, start=1):
        item["no"] = index
        item["id"] = f"q{index}"

    counts = {"single": 0, "multiple": 0, "judge": 0}
    tag_counter: dict[str, int] = {}
    for item in unique:
        counts[item["type"]] = counts.get(item["type"], 0) + 1
        for tag in item.get("tags") or []:
            tag_counter[tag] = tag_counter.get(tag, 0) + 1

    parser = load_parser()
    ok, problems = parser.validate(unique)
    if problems:
        warnings.extend(problems[:10])

    # ⚠️ 必须在这里显式判空。
    # 踩过：parser.validate([]) 对**空列表**返回「没问题」（它只是逐题检查），
    # 于是"模型一道题都没产出"被报成 ok=true、valid=true —— 前端只能靠
    # total==0 才发现不对。真模型（qwen2.5:1.5b）偶尔就会这样。
    if not unique:
        detail = "；".join(warnings[:3]) or "模型没有返回可用的题目"
        raise llm.LlmError(
            f"AI 没产出可用的题目（{detail}）。可以换个材料、把材料写具体一点，或稍后重试。"
        )

    bank = {
        "meta": {
            "id": _slug(title or "ai-generated"),
            "title": title or "AI 生成的题库",
            "subject": subject or "",
            "source": "AI 生成（依据给定材料）",
            "generatedAt": _now(),
            "total": len(unique),
            "counts": counts,
            "tags": [{"name": k, "count": v} for k, v in sorted(tag_counter.items(), key=lambda x: -x[1])],
        },
        "questions": unique,
    }
    return {
        "ok": True,
        "bank": bank,
        "strategy": "llm-generate",
        "warnings": warnings,
        "valid": ok,
        "usage": usage,
        "dropped": max(0, len(questions) - len(unique)),
        "llmSource": trace.as_dict(),
    }


def _split_material(material: str, budget: int = CHUNK_CHARS) -> list[str]:
    return [material[i : i + budget] for i in range(0, len(material), budget)] or [material]
