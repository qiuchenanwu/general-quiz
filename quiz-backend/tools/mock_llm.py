# -*- coding: utf-8 -*-
"""OpenAI 兼容的 mock 服务 —— 用来**不花钱**验 quizgen 的 AI 通路。

为什么需要它：
    `apps/quizgen` 的单测都是把 `llm.chat()` mock 掉的，没真的走过 HTTP ——
    请求体构造、响应解析、分批、错误处理、**服务端缓存**这些都没被验证。
    这个 mock 让板子（或本机）真的发一次 HTTP 请求过来，把整条链路跑通。

它按请求里的提示词判断该返回哪种 JSON：
    system 里有「解析」  → 回 {"items":[{no, analysis}]}（题号从 prompt 里抽出来）
    有「出题」/ 结构化   → 回 {"questions":[...]}
    有「动手做的任务」   → 回 {"goal","why","quote","start","done","hint","lang","fromPage"}
                           （预习页那张任务卡；quote 从**收到的教材**里抄一句，
                            这样后端"引文必须逐字来自教材"那条校验真的走了一遍）
    有「批改」           → 回 {"summary","points","next"}（演武场的「让 AI 检查」；
                          运行输出那段是空的时候，summary 里会带上"静态判断"那句）
同时把每次请求记进日志，所以能验证「第二次补解析命中了缓存、没重复请求」。

用法：
    # 1) 在本机起 mock（板子要能访问到；走 Tailscale 就用你的 100.x 地址）
    python quiz/tools/mock_llm.py 18080

    # 2) 把板子的后端指过来（改 shared/.env）
    #    QUIZ_LLM_API_KEY=mock-key
    #    QUIZ_LLM_BASE_URL=http://<你的100.x地址>:18080/v1
    #    QUIZ_LLM_MODEL=mock-model
    #    sudo systemctl restart renwu

    # 3) 打完三个接口，看 mock_llm_calls.log：应该只有 3 次 POST（缓存那次不该来）
    # 4) 验完把 QUIZ_LLM_* 删掉并 restart，别让板子一直指着 mock

⚠️ 这只证明**代码路径**通了，替代不了真实服务商的兼容性冒烟 ——
   各家对模型名 / 限流 / 返回格式的要求不一样，真 key 还是要自己配一次。
"""
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

#: 每个请求先睡这么久再回 —— 用来**模拟板子上那个慢吞吞的本机模型**。
#: 为什么需要它：验收"进度条/取消"这类界面时，mock 秒回就什么也看不见；
#: ⚠️ 别用 Playwright 的 route 回调去 sleep —— 那会把测试自己的事件循环堵死
#: （实测"等 2.2 秒"变成了 60 秒，取消分支根本执行不到）。
DELAY = float(os.environ.get("MOCK_LLM_DELAY") or 0)
PORT = 18080
LOG = Path(
    os.environ.get("MOCK_LLM_LOG") or (Path(__file__).resolve().parent / "mock_llm_calls.log")
)
_lock = threading.Lock()


def log(line: str) -> None:
    with _lock:
        with LOG.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    print(line, flush=True)


def pick_material_quote(material: str) -> str:
    """从**收到的教材文字**里挑一句当 quote。

    为什么 mock 要费这个劲：后端的 `service._task_quote` 会拿返回的 quote 去教材里
    做**逐字命中校验**，对不上就换成它自己挑的。mock 如果随便编一句，
    这条验收就永远走不到"命中"那一支 —— 那就等于没验。
    这里照材料里真实的一句抄下来，让真链路把命中这条路走通。

    ⚠️ 要跳过**我们自己加的版面记号**（`【骨架】`、`3.1 Servlet 简介` 这种小节号）：
    它们虽然也在材料里，但不是课本里的话（后端的 _verbatim_in 同样会把它们判掉）。
    """
    for raw in re.split(r"[。；！？!?;\n]", material or ""):
        line = re.sub(r"\[p\d+\]", " ", raw).strip()
        if line.startswith("【") or re.match(r"^\d+(\.\d+)*\s", line):
            continue
        # `Servlet：Servlet 是运行在…` —— 冒号前是我们加的术语名，真正的原文在后面
        if "：" in line and len(line.split("：", 1)[0]) <= 12:
            line = line.split("：", 1)[1].strip()
        if 12 <= len(line) <= 30 and re.search(r"[\u4e00-\u9fffA-Za-z]", line):
            return line
    return ""


def build_content(messages: list[dict]) -> str:
    """按提示词判断这次是「结构化 / 补解析 / 出题 / 教练问答 / 批改作业 / 留任务」，返回对应的字符串。"""
    system = " ".join(m.get("content", "") for m in messages if m.get("role") == "system")
    user = " ".join(m.get("content", "") for m in messages if m.get("role") == "user")

    # 任务卡（预习页的「按你的弱项做一个任务」）：也是 JSON，但形状是
    # goal/why/quote/start/done/hint/lang/fromPage。
    # ⚠️ 必须排在最前面判：它的 system 也是"耐心的编程助教"，掉到批改分支上会回一份
    #    summary/points，后端抠不出 goal/start，整个接口就 502 了。
    # 判据用 system 里的"动手做的任务"：那是提示词包的开场白，改提示词要回来看看还认不认得出。
    if "动手做的任务" in system:
        block = ""
        m = re.search(r"<<<教材 开始>>>(.*?)<<<教材 结束>>>", user, re.S)
        if m:
            block = m.group(1)
        # ★ 故意按**取材范围**给两种不同的 quote，这样开关的两档在真浏览器里
        #   都走得到、而且照得出差别（判据看 quiz/tools/task_check.py）：
        #     「只照书本」= 照提示词的要求**从收到的教材里逐字抄一句**（命中那条路）；
        #     「允许补充」= 给一句**教材里没有的**话 —— 后端必须把它丢掉（quote 空、
        #                   why 不提引文、fromPage=0），**绝不许**让它冒充教材原话。
        #   编的那句正好也是"编造引文"的固定靶子：真模型编出来的样子就是这样。
        quote = "【mock】Servlet 会在每次请求时自动重启服务器内存。"
        if "只照书本" in user:
            quote = pick_material_quote(block) or quote
        pages = [int(n) for n in re.findall(r"\[p(\d+)\]", block)]
        lang = "js" if "JavaScript" in user else "java"
        if lang == "java":
            start = (
                "public class TaskMain {\n"
                "    public static void main(String[] args) {\n"
                '        System.out.println("【mock】先让这段跑起来，再改成任务要的输出");\n'
                "    }\n"
                "}\n"
            )
        else:
            start = (
                "// 【mock】先让这段跑起来，再改成任务要的输出\n"
                "console.log('【mock】Hello')\n"
            )
        return json.dumps(
            {
                "goal": "【mock 任务】照教材把这段起手代码改成能跑出结果的程序",
                "why": "【mock】这一章在讲这段代码用到的基础，这个任务正好练它。",
                "quote": quote,
                "start": start,
                "done": ["【mock】运行后输出里能看到那行文字", "【mock】改掉文字再运行一次，输出跟着变"],
                "hint": "【mock】先看教材里那段代码是怎么拿到输出的。",
                "lang": lang,
                "fromPage": pages[0] if pages else 0,
            },
            ensure_ascii=False,
        )

    # AI 批改学生作业（演武场「让 AI 检查」）：也是 JSON，但形状是 summary/points/next。
    # ⚠️ 必须排在"结构化兜底"前面判：它的 system 里没有别的分支认得的词，掉到最后那条
    #    「结构化兜底」上会回一份 questions —— 后端抠不出 points，整个接口就 502 了。
    # 判据用 system 里的"批改"：那是提示词包的开场白，改提示词就要回来看看还认不认得出。
    if "批改" in system:
        block = ""
        m = re.search(r"<<<运行输出 开始>>>(.*?)<<<运行输出 结束>>>", user, re.S)
        if m:
            block = m.group(1).strip()
            # 后端在"还没运行过"时会填这句占位，它不算真输出
            if block in ("（学生还没有运行过）", ""):
                block = ""
        static_note = "" if block else "你还没运行过，我给的是静态判断。"
        points = [
            {"level": "ok", "text": "【mock】结构和方法都写出来了，思路是对的。"},
            {"level": "bad", "text": "【mock】边界情况没处理，空输入会出错。"},
            {"level": "todo", "text": "【mock】先补一个空输入的用例再跑一次。"},
        ]
        if not block:
            points.append({"level": "todo", "text": "【mock】还没运行过，先点「运行」看真实输出。"})
        return json.dumps(
            {
                "summary": f"【mock 批改】整体能跑通，细节还要改。{static_note}",
                "points": points,
                "next": "【mock】按上面的意见改一处，再运行一次。",
            },
            ensure_ascii=False,
        )

    # AI 教练 / 错题诊断：**这两个接口要的是自然语言，不是 JSON**
    # （quizgen 的 tutor/diagnose 直接走 chat_with_fallback，不解析 JSON）。
    # 判断依据用提示词包里的开场白 —— 三个域（generic/drive/docs）都不带 "JSON" 字样。
    # ⚠️ 这些开场白是**提示词文本**，改提示词就要回来看看这里还认不认得出（别只留一种写法）。
    if ("正在陪学生做题" in system or "正在陪学员刷" in system or "陪他做题" in system
            or "陪他做下面这道题" in system
            or "复盘他最近做错的题" in system or "复盘最近做错的题" in system):
        if "复盘" in system:
            return "【mock 诊断】薄弱点：1) 响应式与 .value（读文档《响应式基础》）；2) 条件渲染 v-if/v-show 的区别。建议先读原文再改错题。"
        return "【mock 教练】这道题问的是概念本身，不是记答案。文档没写的我不补充（这是 mock 回答，只用来验通路）。"

    # 补解析：把请求里出现过的题号原样回一份解析
    if "解析" in system:
        numbers = sorted({int(n) for n in re.findall(r"第\s*(\d+)\s*题", user)})
        items = [{"no": n, "analysis": f"【mock 解析】第 {n} 题：正确答案的依据见教材对应章节。"} for n in numbers]
        return json.dumps({"items": items}, ensure_ascii=False)

    # 结构化 或 出题：都返回 questions
    if "出题" in system or "根据下面的材料出题" in user:
        return json.dumps(
            {
                "questions": [
                    {
                        "no": 1,
                        "type": "single",
                        "stem": "【mock 生成】材料里提到的核心观点是(  )",
                        "options": [
                            {"key": "A", "text": "甲观点"},
                            {"key": "B", "text": "乙观点"},
                            {"key": "C", "text": "丙观点"},
                            {"key": "D", "text": "丁观点"},
                        ],
                        "answer": ["B"],
                        "analysis": "【mock】材料第二段明确写了乙观点。",
                    },
                    {
                        "no": 2,
                        "type": "judge",
                        "stem": "【mock 生成】材料主张完全照搬国外经验。",
                        "answer": ["错误"],
                        "analysis": "【mock】材料强调结合实际，不主张照搬。",
                    },
                ]
            },
            ensure_ascii=False,
        )

    # 结构化兜底
    return json.dumps(
        {
            "questions": [
                {
                    "no": 1,
                    "type": "single",
                    "stem": "【mock 结构化】从图片里读出来的题(  )",
                    "options": [{"key": "A", "text": "甲"}, {"key": "B", "text": "乙"}],
                    "answer": ["A"],
                },
                {
                    "no": 2,
                    "type": "judge",
                    "stem": "【mock 结构化】第二道判断题。",
                    "answer": ["正确"],
                },
            ]
        },
        ensure_ascii=False,
    )


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler 的约定
        log(f"GET  {self.path}")
        # 装成 Ollama：/api/tags 返回 {"models":[{"name":...}]}，
        # 这样能验证 quizgen 的「没配 key 时自动发现本机模型」那条路。
        if self.path.startswith("/api/tags"):
            self._send(200, {"models": [{"name": "mock-local:latest", "size": 123}, {"name": "other:7b"}]})
            return
        # OpenAI 兼容的 /v1/models
        self._send(200, {"object": "list", "data": [{"id": "mock-model", "object": "model"}]})

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8", "replace")
        if DELAY:
            time.sleep(DELAY)
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            log(f"POST {self.path} 非法 JSON")
            self._send(400, {"error": {"message": "bad json"}})
            return

        messages = payload.get("messages") or []
        auth = self.headers.get("Authorization", "(无)")
        content = build_content(messages)
        log(f"POST {self.path} model={payload.get('model')} auth={auth[:20]} 回复 {len(content)} 字符")
        self._send(
            200,
            {
                "id": "mock-1",
                "object": "chat.completion",
                "model": payload.get("model") or "mock-model",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
            },
        )

    def log_message(self, *args):  # 静音默认的每请求日志
        return


def _parse_argv() -> None:
    """用法：mock_llm.py [端口] [--delay 秒]

    不引 argparse 是为了保持这个工具"零依赖、随手能跑"（它连 .venv-renwu 都不需要）。
    """
    global PORT, DELAY
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--delay":
            DELAY = float(args[i + 1])
            i += 2
            continue
        if a.isdigit():
            PORT = int(a)
        i += 1


if __name__ == "__main__":
    _parse_argv()
    LOG.write_text("", encoding="utf-8")
    extra = f"，每个请求先睡 {DELAY:.0f} 秒（模拟慢模型）" if DELAY else ""
    print(f"mock LLM 监听 0.0.0.0:{PORT}，调用记录写入 {LOG}{extra}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
