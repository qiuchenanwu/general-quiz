#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""docs_to_bank.py —— 把「官方文档 / 教材」编译成刷题网站能吃的题库。

它和 pdf_to_json.py 的分工
--------------------------
    pdf_to_json.py  解的是**题库 PDF**（题干 + A/B/C/D + 答案：X，排版固定）
    docs_to_bank.py 解的是**教材/文档**（先切出"知识单元"，再出题）

两者共享同一条原则：**确定性优先、AI 兜底**。
- 切分、校验、判分**全是确定性代码**（可单测、可复现、可 diff）
- AI 只负责两件事：**选材**（这段值不值得考）和**写讲解**

为什么必须这么分：教材类内容最怕"AI 讲错了你也不知道"。所以凡是"对错"，
一律交给能重放的代码；AI 的产出**必须带原文出处**，且出处要能在原文里逐字命中。

三段式（每段产物落盘，可单独重跑）
----------------------------------
    source   取源（插件式）：markdown 目录 / GitHub 仓库。PDF、OCR 后补。
    units    切知识单元：**按标题层级切，不按 token 窗口切**。
             一个 section = 一个教学单元，id 用 `文件#锚点` —— 它直接变成题库里的
             `chapter` 和题目的 `source.url`，于是"你哪一节最弱"能精确到章节。
    questions 出题：调后端 `/api/quiz/generate/` 的 **docs 提示词包**（要求带出处），
             再跑一串确定性自检（出处逐字命中 / 结构 / 去重 / 答案是否只在原文里成立）。

用法
----
    # 0. 先离线自检（不联网、不花钱）：解析器的断言
    python quiz/tools/docs_to_bank.py --selftest

    # 1. 取源 + 切单元（纯本地，不花 AI 额度）
    python quiz/tools/docs_to_bank.py --source github:vuejs/docs@main:src/guide/essentials \
        --name vue-essentials --stage units

    # 2. 出题（会花 AI 额度：一次一个单元）
    python quiz/tools/docs_to_bank.py --source github:vuejs/docs@main:src/guide/essentials \
        --name vue-essentials --stage questions --only computed.md --count-per-unit 4

    # 3. 直接用本地目录（自己的电子版教材转成 md 之后走同一条路）
    python quiz/tools/docs_to_bank.py --source dir:/path/to/md --url-base https://example.com/doc

产物（默认落 .tmp/docs-bank/，**不直接进 src/banks/** —— 编译期产物要人工审过再入库）
--------------------------------------------------------------------------
    <name>.units.json    机器可读的全部知识单元（出题阶段的输入，可 review 可 diff）
    <name>.units.md      人工可读的单元索引（"它到底把文档切成了什么"）
    <name>.bank.json     题库（**前端能直接吃**的 schema；含 chapter/tags/analysis）
    <name>.sources.json  每道题的出处（url + 标题 + 逐字片段）——前端 schema 暂不存这些
    <name>.review.md     审阅报告：逐题列出题目/答案/解析/出处 + 自检结果 + 存疑清单

版权提醒
--------
官方文档（Vue / MDN / Rust Book 等）许可相对友好，但它们**仍是有版权的作品**：
引用要短、要给出处。**教材扫描件只能自用（私有题库），别公开托管**——
所以最终入库前请确认 `meta.license` / `meta.source` 这两项。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from http.cookiejar import CookieJar
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ══════════════════════════════════════════════════════════════════════
# 一、Markdown 解析（确定性的那一半）
# ══════════════════════════════════════════════════════════════════════

FENCE_RE = re.compile(r"^(`{3,}|~{3,})\s*(.*)$")
#: VitePress 的围栏信息串可以很花：`js`、`vue [BlogPost.vue]`、`js{6}`、`vue{5} [BlogPost.vue]`、`vue-html{1,7}`
FENCE_LABEL_RE = re.compile(r"\[([^\]]*)\]\s*$")
FENCE_HL_RE = re.compile(r"\{[^}]*\}\s*$")
CONTAINER_RE = re.compile(r"^:::+\s*([a-zA-Z][\w-]*)?\s*(.*)$")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
INCLUDE_RE = re.compile(r"^<<<\s+@?(\S+?)(?:#(\S+))?\s*$")
SLUG_STRIP_RE = re.compile(r"[^\w\u4e00-\u9fff\- ]+", re.UNICODE)
# VitePress 的显式锚点：`## 标题 {#my-anchor}` —— 官方文档自己给了锚点，比我们猜的准
ANCHOR_RE = re.compile(r"\{#([^}]+)\}\s*$")
# 标题尾部的 `*` / `**` 是 Vue 文档的"仅 Options API / 仅组合式 API"脚注标记，不是标题的一部分。
# 原文写的是**转义过的** `\*` / `\*\*`，所以反斜杠也要一起剥掉（否则标题会留个尾巴 `\`）。
FOOTNOTE_RE = re.compile(r"[\s\\*]+$")
# 一个单元的材料超过这个体量就再切一层：**单元粒度要适配出题粒度**，
# 19000 字符一个单元会让"出处必须在材料里逐字命中"这条校验形同虚设（太大，哪句都算命中）
MAX_UNIT_CHARS = 6000
# 段落里出现这些词，多半是在讲"别这么写"——反模式句是最高价值的考点
ANTIPATTERN_RE = re.compile(
    r"(不能|不要|不该|而不是|否则|反之|注意|陷阱|常见错误|"
    r"\bmust not\b|\bdo not\b|\bdon't\b|\binstead\b|\bavoid\b|\bpitfall\b|\bnote that\b)",
    re.IGNORECASE,
)
CODE_IDENT_RE = re.compile(r"`([A-Za-z_$][\w$.]*(?:\(\))?)`")


@dataclass
class Block:
    """markdown 里的一个块。容器（tip/warning）用 container 记下它被包在什么里"""

    kind: str  # heading | para | code | list | table | html | quote | include | hr
    text: str = ""
    level: int = 0  # heading 的层级
    lang: str = ""
    label: str = ""  # VitePress 的 ```js [Options API] 里的方括号标签
    container: tuple[str, ...] = ()
    anchor: str = ""  # 标题自带的显式锚点 `{#xxx}`（有就用它，没有才去猜）


@dataclass
class Point:
    """一个"可考的知识点"。出题阶段一个 point 一次调用，自检阶段用它核对出处"""

    id: str
    kind: str  # concept | code | pitfall | contrast
    text: str
    anchor: str  # 单元内的锚点（用于拼 url#anchor）
    extra: dict = field(default_factory=dict)


@dataclass
class Unit:
    id: str
    file: str
    doc_title: str  # 文件的 H1
    heading: str  # 本单元的标题
    level: int
    slug: str
    url: str
    blocks: list[Block] = field(default_factory=list)
    points: list[Point] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    #: 上级 `##` 标题。题库里的 `chapter` 用它 —— 站点上的"章节"列表不该碎成 58 条，
    #: 而**出处链接**仍然指向精确的 `#锚点`（两者分开，各司其职）
    chapter: str = ""


def strip_frontmatter(text: str) -> tuple[dict, str]:
    """去掉 VitePress 的 --- 头。里面常写着 outline/title，对切分没用但值得留档"""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    head = text[3:end].strip()
    meta = {}
    for line in head.splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            meta[k.strip()] = v.strip()
    return meta, text[end + 4 :]


def parse_heading(raw: str) -> tuple[str, str]:
    """
    拆标题：`## Declaring Reactive State * {#declaring-reactive-state}`
      → ("Declaring Reactive State", "declaring-reactive-state")

    官方文档自己给的 `{#anchor}` 是**权威**的，比 slugify 猜的准得多 ——
    有它就用它，出处链接才能真的点得对。
    """
    explicit = ""
    m = ANCHOR_RE.search(raw)
    if m:
        explicit = m.group(1).strip()
        raw = raw[: m.start()]
    return FOOTNOTE_RE.sub("", raw).strip(), explicit


def slugify(text: str) -> str:
    """
    VitePress 风格的锚点。

    ⚠️ 这是**近似**实现：VitePress 用的是 @mdit-vue/shared 的 slugify，
    对重复标题会加序号、对开头是数字/怪符号的会补 `_`。
    出处链接的**准确性**靠人抽查（report 里每条都带 url，点一下就知道）。
    宁可给个近似锚点 + 让人能核对，也不要为了"绝对准确"而去抓渲染后的 HTML
    ——那会把最干净的 markdown 源丢掉，得不偿失。
    """
    s = (text or "").strip().lower()
    s = SLUG_STRIP_RE.sub("", s)
    s = re.sub(r"\s+", "-", s).strip("-")
    if s and not (s[0].isalnum() or "\u4e00" <= s[0] <= "\u9fff"):
        s = "_" + s
    return s


def parse_fence_info(info: str) -> tuple[str, str]:
    """
    拆围栏信息串 → (语言, 方括号标签)。

    ⚠️ 这里踩过一个**会把整篇文档吞掉**的坑：Vue 文档的围栏会写成
    ```` ```js{6} ```` / ```` ```vue{5} [BlogPost.vue] ````（VitePress 的**高亮行**标记，
    14 个文件里有 22 处）。第一版的正则只认 `语言 [标签]`，遇到 `{6}` 就**匹配不上** →
    那一行没被当成围栏开头 → 后面的收尾围栏反倒被当成开头 → **围栏奇偶翻转**，
    从那儿往后整篇都被当成一个代码块。
    症状很隐蔽：`reactivity-fundamentals.md` 有 5 个 `##`，只切出了 1 个
    （另外 4 个"变成了代码"）。所以现在把信息串整个接住再自己拆，并对账（见 audit_units）。
    """
    info = (info or "").strip()
    label = ""
    m = FENCE_LABEL_RE.search(info)
    if m:
        label = m.group(1).strip()
        info = info[: m.start()].strip()
    info = FENCE_HL_RE.sub("", info).strip()
    lang = info.split()[0] if info else ""
    return lang, label


def parse_markdown(text: str) -> list[Block]:
    """
    单遍扫描。三条状态要注意：
      ① 围栏代码块内部的 `:::` 和 `#` **都不是语法** —— 必须先整块吃掉
      ② `::: tip` 开、光秃秃的 `:::` 关（VitePress 容器），要能嵌套
      ③ `<<< @/path` 是文档的"引入示例文件"，本期不展开（只记下来）
    """
    _, body = strip_frontmatter(text)
    lines = body.split("\n")
    blocks: list[Block] = []
    stack: list[str] = []
    i = 0

    def push(kind: str, text_: str, **kw) -> None:
        blocks.append(Block(kind=kind, text=text_, container=tuple(stack), **kw))

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # ① 围栏代码块
        fence = FENCE_RE.match(stripped)
        if fence and stripped.startswith(("```", "~~~")):
            marker = fence.group(1)
            lang, label = parse_fence_info(fence.group(2))
            buf: list[str] = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith(marker[:3]):
                buf.append(lines[i])
                i += 1
            i += 1  # 吃掉收尾的围栏
            push("code", "\n".join(buf), lang=lang, label=label)
            continue

        # ② 容器
        container = CONTAINER_RE.match(stripped)
        if container and stripped.startswith(":::"):
            name = (container.group(1) or "").lower()
            title = container.group(2).strip()
            if not name:
                if stack:
                    stack.pop()
                i += 1
                continue
            stack.append(f"{name}:{title}" if title else name)
            i += 1
            continue

        # ③ 示例文件引入
        include = INCLUDE_RE.match(stripped)
        if include:
            push("include", include.group(1), label=include.group(2) or "")
            i += 1
            continue

        # 标题
        heading = HEADING_RE.match(stripped)
        if heading:
            text_, anchor_ = parse_heading(heading.group(2))
            push("heading", text_, level=len(heading.group(1)), anchor=anchor_)
            i += 1
            continue

        if not stripped:
            i += 1
            continue

        if stripped.startswith("<") and stripped.endswith(">"):
            push("html", stripped)
            i += 1
            continue

        if stripped.startswith(">"):
            push("quote", stripped.lstrip("> ").strip())
            i += 1
            continue

        if re.match(r"^([-*+]|\d+\.)\s", stripped):
            push("list", stripped)
            i += 1
            continue

        if stripped.startswith("|"):
            push("table", stripped)
            i += 1
            continue

        if re.match(r"^([-*_])\1{2,}$", stripped):
            push("hr", "")
            i += 1
            continue

        # 其余：按空行分段的普通段落
        buf = [stripped]
        i += 1
        while i < len(lines):
            nxt = lines[i].strip()
            if not nxt or HEADING_RE.match(nxt) or FENCE_RE.match(nxt) or nxt.startswith(":::"):
                break
            if re.match(r"^([-*+]|\d+\.)\s", nxt) or nxt.startswith("|") or nxt.startswith("<"):
                break
            buf.append(nxt)
            i += 1
        push("para", " ".join(buf))

    return blocks


def container_kind(block: Block) -> str:
    for c in block.container:
        return c.split(":")[0]
    return ""


def container_label(block: Block) -> str:
    for c in reversed(block.container):
        if ":" in c:
            return c.split(":", 1)[1]
    return ""


def split_units(
    blocks: list[Block], file: str, url_base: str, url_ext: str, max_chars: int = MAX_UNIT_CHARS
) -> list[Unit]:
    """
    两级切分：
      ① 按 `##` 切（`###` 先留在单元内）
      ② **体量超标的再按 `###` 切一层**（还不够就按段落硬切）

    为什么必须有第②级：真实文档里 `reactivity-fundamentals.md` 的 `## Declaring Reactive State`
    一节能有 19000 字符、33 个代码块。塞给模型出 4 道题，等于让它从一本书里随便挑 ——
    而且"出处必须在材料里逐字命中"这条校验会因为材料太大而形同虚设。
    单元粒度 = 出题粒度 = 校验粒度，三者必须对齐。
    """
    units: list[Unit] = []
    doc_title = ""
    cur: Unit | None = None
    pending: list[Block] = []
    stem = doc_rel(file)
    url_file = url_of(url_base, file, url_ext)

    def new_unit(heading: str, level: int, slug: str, chapter: str = "") -> Unit:
        uid = f"{stem}#{slug}" if slug else stem
        return Unit(
            id=uid, file=file, doc_title=doc_title, heading=heading, level=level,
            slug=slug, url=(f"{url_file}#{slug}" if slug else url_file), chapter=chapter or heading,
        )

    for b in blocks:
        if b.kind == "heading" and b.level == 1:
            doc_title = b.text
            if cur:
                cur.doc_title = doc_title
            continue
        if b.kind == "heading" and b.level == 2:
            if cur:
                units.append(cur)
            slug = b.anchor or slugify(b.text)
            cur = new_unit(b.text, 2, slug)
            continue
        if b.kind == "heading" and b.level >= 3:
            if cur is None:
                cur = new_unit("（开头）", 2, "intro")
            cur.blocks.append(b)  # 子标题留在单元内，出题时当"小节点"
            continue
        if cur is None:
            pending.append(b)
            continue
        cur.blocks.append(b)

    if cur:
        units.append(cur)

    # 开头那一段（H1 到第一个 ## 之间）经常只是页面的 <script setup> 管道，没有教学内容。
    # 判据：有正文段落（够长）或真有可运行的示例（带 template）才算一个单元 ——
    # 否则它会变成一堆"教学点为 0"的空单元，出题阶段白跑一趟。
    if pending:
        substantial = any(
            (b.kind == "para" and len(b.text) >= 80) or (b.kind == "code" and "<template" in b.text)
            for b in pending
        )
        if substantial:
            intro = new_unit("（开头）", 2, "intro")
            intro.blocks = pending
            units.insert(0, intro)

    fine: list[Unit] = []
    for u in units:
        fine.extend(split_unit_by_size(u, file, url_base, url_ext, max_chars))
    for u in fine:
        u.doc_title = doc_title or doc_rel(file)
        u.chapter = u.chapter or u.heading
    return fine


def doc_rel(file: str) -> str:
    """文件在文档树里的相对路径（去扩展名、统一用 `/`）。单元 id 和 URL 都靠它。

    为什么要保留目录层级：整本 guide 是**多层目录**（`guide/components/props.md`），
    只取 `Path(file).stem` 会同时坏两件事 ——
      · URL 丢掉中间那层（`vuejs.org/guide/props.html` 是 404，正确是 `/guide/components/props.html`）；
      · id 会撞车（`components/index.md` 和 `guide/index.md` 都是 `index`）。
    """
    rel = str(file).replace("\\", "/")
    if rel.endswith(".md"):
        rel = rel[:-3]
    return rel


def url_of(url_base: str, file: str, url_ext: str, anchor: str = "") -> str:
    """一个单元/一篇文档的原文网址（带锚点）"""
    base = f"{url_base.rstrip('/')}/{doc_rel(file)}{url_ext}"
    return f"{base}#{anchor}" if anchor else base


def split_unit_by_size(u: Unit, file: str, url_base: str, url_ext: str, max_chars: int) -> list[Unit]:
    """体量超标的单元按 `###` 再切；没有 `###` 可用就按段落硬切（保留同一个锚点）"""
    if len(render_text(u)) <= max_chars:
        return [u]

    stem = doc_rel(file)
    url_file = url_of(url_base, file, url_ext)
    chunks: list[tuple[str, str, int, list[Block]]] = []
    cur_head, cur_slug, cur_lv, cur_blocks = u.heading, u.slug, u.level, []
    for b in u.blocks:
        if b.kind == "heading" and b.level >= 3 and cur_blocks:
            chunks.append((cur_head, cur_slug, cur_lv, cur_blocks))
            cur_head, cur_slug, cur_lv, cur_blocks = b.text, (b.anchor or slugify(b.text)), b.level, [b]
        else:
            cur_blocks.append(b)
    chunks.append((cur_head, cur_slug, cur_lv, cur_blocks))

    out: list[Unit] = []
    for head, slug, level, blks in chunks:
        sub = Unit(
            id=f"{stem}#{slug}", file=file, doc_title=u.doc_title, heading=head, level=level,
            slug=slug, url=f"{url_file}#{slug}", blocks=blks, chapter=u.heading,
        )
        if len(render_text(sub)) > max_chars:
            out.extend(hard_split(sub, file, url_base, url_ext, max_chars))
        else:
            out.append(sub)

    # 一个 ### 都没有（整篇就一个 ##）→ 只能按段落硬切
    if len(chunks) == 1:
        return hard_split(u, file, url_base, url_ext, max_chars)

    for s in out:
        s.points = extract_points(s)
        s.tags = collect_tags(s)
    return [s for s in out if s.points]


def hard_split(u: Unit, file: str, url_base: str, url_ext: str, max_chars: int) -> list[Unit]:
    """
    最后的兜底：按段落累积切段。锚点只能沿用原标题的（没法更准了），
    所以标题里注明"（第 N 段）"——**宁可让人看出来这是硬切的**，
    也不要假装它是个精确的小节。
    """
    stem = doc_rel(file)
    url_file = url_of(url_base, file, url_ext)
    parts: list[list[Block]] = []
    buf: list[Block] = []
    size = 0
    for b in u.blocks:
        blen = len(b.text) + 8
        if buf and size + blen > max_chars:
            parts.append(buf)
            buf, size = [], 0
        buf.append(b)
        size += blen
    if buf:
        parts.append(buf)

    out: list[Unit] = []
    for i, blks in enumerate(parts, 1):
        sub = Unit(
            id=f"{stem}#{u.slug}~{i}", file=file, doc_title=u.doc_title,
            heading=f"{u.heading}（第 {i}/{len(parts)} 段）", level=u.level,
            slug=u.slug, url=f"{url_file}#{u.slug}", blocks=blks, chapter=u.chapter or u.heading,
        )
        sub.points = extract_points(sub)
        sub.tags = collect_tags(sub)
        out.append(sub)
    return [s for s in out if s.points]


def render_text(unit: Unit) -> str:
    """
    把单元渲染成"给模型看的材料"。

    刻意**保留** `⚠️ 注意` 这类标记：文档里的 tip/warning 就是"官方亲口说的坑"，
    是出题素材里最值钱的一类，弄丢了很可惜。
    """
    out: list[str] = []
    for b in unit.blocks:
        if b.kind == "heading":
            out.append("#" * b.level + " " + b.text)
        elif b.kind == "code":
            lang = b.lang or ""
            label = f" [{b.label}]" if b.label else ""
            out.append(f"```{lang}{label}\n{b.text}\n```")
        elif b.kind in ("para", "list", "quote", "table"):
            ck = container_kind(b)
            if ck in ("tip", "warning", "danger", "info", "important", "caution", "note"):
                mark = {"tip": "提示", "warning": "注意", "danger": "警告", "info": "说明"}.get(ck, "注意")
                label = container_label(b)
                out.append(f"> ⚠️ {mark}{'（' + label + '）' if label else ''}：{b.text}")
            elif b.kind == "list":
                out.append(b.text)
            else:
                out.append(b.text)
        elif b.kind == "include":
            out.append(f"<!-- 示例文件：{b.text} -->")
    return "\n\n".join(x for x in out if x.strip())


def extract_points(unit: Unit) -> list[Point]:
    """
    从单元里挑"可考的知识点"。**这一步不花钱、不调 AI**，纯结构判断：

      concept   小节标题本身（"Declaring Reactive State" 就是一个知识单元）
      code      真实代码示例（填空 / 找错 / 预测输出都从这里来）
      pitfall   文档自己标的 tip/warning（官方亲口说的坑 —— 最高价值）
      contrast  讲了"别这么写"的段落（反模式识别题）
    """
    points: list[Point] = []
    n = 0
    last_para = ""

    for b in unit.blocks:
        ck = container_kind(b)
        if b.kind == "heading":
            n += 1
            points.append(
                Point(
                    id=f"{unit.id}:h{n}", kind="concept", text=b.text,
                    anchor=slugify(b.text), extra={"level": b.level},
                )
            )
            continue
        if b.kind == "code":
            # 纯 `<script setup>` 的管道块不是教学内容（文档里每个交互示例前面都有一段），
            # 拿它出题会问出"这里 import 了什么"这种没营养的题
            plumbing = b.text.strip().startswith("<script") and "<template" not in b.text
            if len(b.text.strip()) >= 24 and not plumbing:
                n += 1
                points.append(
                    Point(
                        id=f"{unit.id}:c{n}", kind="code", text=b.text,
                        anchor=unit.slug,
                        extra={"lang": b.lang, "label": b.label, "context": last_para[:400]},
                    )
                )
            continue
        if b.kind in ("para", "list", "quote", "table"):
            if ck in ("tip", "warning", "danger", "important", "caution"):
                n += 1
                points.append(
                    Point(
                        id=f"{unit.id}:p{n}", kind="pitfall", text=b.text,
                        anchor=unit.slug, extra={"level": ck},
                    )
                )
            elif b.kind == "para" and ANTIPATTERN_RE.search(b.text) and len(b.text) >= 40:
                n += 1
                points.append(
                    Point(
                        id=f"{unit.id}:x{n}", kind="contrast", text=b.text,
                        anchor=unit.slug, extra={},
                    )
                )
            if b.kind == "para":
                last_para = b.text
    return points


def collect_tags(unit: Unit) -> list[str]:
    """从行内代码里抽 API 名当 tag —— 让"弱项统计"能落到 API 粒度（ref/computed/watch…）"""
    seen: list[str] = []
    for b in unit.blocks:
        for m in CODE_IDENT_RE.finditer(b.text):
            name = m.group(1)
            if len(name) < 3 or name.endswith((".js", ".ts", ".json", ".html")):
                continue
            if name not in seen:
                seen.append(name)
    return seen[:12]


# ══════════════════════════════════════════════════════════════════════
# 二、取源（插件式：markdown 目录 / GitHub；PDF、OCR 后补）
# ══════════════════════════════════════════════════════════════════════


@dataclass
class Source:
    kind: str  # dir | github
    files: list[tuple[str, str]]  # [(相对名, markdown 原文)]
    label: str
    url_base: str
    url_ext: str
    license: str = ""
    #: 署名（谁的东西）。CC BY 这类许可**要求署名**，所以这不是可选项，见 load_github
    attribution: str = ""


#: GitHub 源递归列目录的最大深度（`src/guide/components/nested/...` 这种层次够用了）
GH_MAX_DEPTH = 4
#: 递归时跳过的目录名（都不是正文；素材图/示例工程混进来会把单元切得很脏）
GH_SKIP_DIRS = {
    "assets", "images", "img", "public", "static", "examples", "demos",
    "node_modules", "dist", ".vitepress", "translations",
}


def load_dir(path: Path, url_base: str, url_ext: str) -> Source:
    files = []
    for p in sorted(path.rglob("*.md")):
        files.append((str(p.relative_to(path)).replace("\\", "/"), p.read_text(encoding="utf-8")))
    if not files:
        raise SystemExit(f"目录里没有 .md：{path}")
    return Source("dir", files, str(path), url_base, url_ext)


def load_github(spec: str, cache_root: Path, refresh: bool = False) -> Source:
    """
    spec 形式：owner/repo@ref:子路径        例如 vuejs/docs@main:src/guide/essentials

    **吃源码 markdown，不吃爬来的 HTML** —— 这决定了整条管线的干净程度：
    标题层级、代码块、VitePress 容器都在，不用去猜 DOM。
    （MDN 是 mdn/content，Rust 是 rust-lang/book，Django/Python 是 rst —— 同一套路。）
    """
    if ":" in spec:
        repo_ref, subpath = spec.split(":", 1)
    else:
        repo_ref, subpath = spec, ""
    repo, _, ref = repo_ref.partition("@")
    ref = ref or "main"
    subpath = subpath.strip("/")

    cache = cache_root / f"{repo.replace('/', '-')}@{ref}" / subpath
    cache.mkdir(parents=True, exist_ok=True)

    def get_json(url: str):
        req = urllib.request.Request(url, headers={"User-Agent": "docs-to-bank/1.0", "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode("utf-8"))

    files: list[tuple[str, str]] = []

    def walk(path: str, depth: int) -> None:
        """递归列目录。

        2026-10-09 加：原来只列**一层**，于是 `--source github:vuejs/docs@main:src/guide`
        只拿到 2 个 md（guide 底下几乎都是子目录）——"整本 guide"根本切不出来。
        """
        if depth > GH_MAX_DEPTH:
            print(f"  （跳过更深的目录：{path}）", flush=True)
            return
        for item in get_json(f"https://api.github.com/repos/{repo}/contents/{path}?ref={ref}"):
            name = item.get("name") or ""
            if item.get("type") == "dir":
                if name in GH_SKIP_DIRS or name.startswith("."):
                    continue
                walk(f"{path}/{name}".strip("/"), depth + 1)
                continue
            if item.get("type") != "file" or not name.endswith(".md"):
                continue
            rel = f"{path}/{name}".strip("/")
            if rel.startswith(f"{subpath}/"):
                rel = rel[len(subpath) + 1 :]
            elif subpath:
                rel = rel[len(subpath) :].lstrip("/")
            local = cache / rel
            local.parent.mkdir(parents=True, exist_ok=True)
            if local.exists() and not refresh:
                text = local.read_text(encoding="utf-8")
            else:
                req = urllib.request.Request(item["download_url"], headers={"User-Agent": "docs-to-bank/1.0"})
                with urllib.request.urlopen(req, timeout=60) as r:
                    text = r.read().decode("utf-8")
                local.write_text(text, encoding="utf-8")
            files.append((rel, text))

    walk(subpath, 0)
    files.sort(key=lambda x: x[0])  # 顺序稳定：产物可复现

    if not files:
        raise SystemExit(f"{repo}@{ref}:{subpath} 里没找到 .md")

    base = re.sub(r"^src/", "", subpath)
    return Source(
        kind="github", files=files, label=f"{repo}@{ref} {subpath}",
        url_base=f"https://vuejs.org/{base}", url_ext=".html",
        # ★ 许可与署名叫"编译教材"这件事的**硬约束**，不是装饰：
        #   Vue 官方文档是 **CC BY 4.0**（图片除外）—— 允许商用、允许改编（出题就是改编），
        #   但**必须署名 + 链接许可 + 说明做过修改**。
        #   所以这三样必须写进题库 meta（题库卡片上会显示），而不是只留在注释里。
        #   （判据：仓库根的 LICENSE。GitHub API 只说 "NOASSERTION"，别信那个字段。）
        license="CC BY 4.0（https://creativecommons.org/licenses/by/4.0/）",
        attribution=f"{repo}：Vue 3 官方文档，版权归 Yuxi (Evan) You 与 Vue 文档贡献者所有",
    )


# ══════════════════════════════════════════════════════════════════════
# 源插件：文档模型（扫描件 → `core/docmodel.js` 的产物 → 伪 markdown）
# ══════════════════════════════════════════════════════════════════════

#: 中日韩字符 + 全角标点（和前端 `core/ocr.js` 的 `isCjk` 同一套范围）
CJK_CHAR = re.compile(r"[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]")


def _join_ocr_lines(lines: list[str]) -> str:
    """把 OCR 的硬换行接回一段话。

    ⚠️ 不能直接 `"".join`：英文单词会被粘成 `thequickbrown`（真会发生）。
    规则和前端 `core/ocr.js` 的 `joinWord` 同一条：中日韩之间不插空格，其余插一个。
    """
    out = ""
    for raw in lines:
        t = (raw or "").strip()
        if not t:
            continue
        if out and not (CJK_CHAR.match(out[-1]) and CJK_CHAR.match(t[0])):
            out += " "
        out += t
    return out


def _model_chapter(model: dict) -> str:
    """这一章叫什么（两条路，都不猜）：

    ① 模型里真有"第X章"标题（`heading` 且 `level == 1`）；
    ② 没有就从**被剔除的页脚**里捞那条跑马灯（`第3章 Servlet 113` → 去掉行尾页码）。
       扫描切片常常正好躲开章标题，而页脚每页都印着 —— 这是"剔除"的额外收益。

    ⚠️ 第②条必须**只认看上去干净的那条**：实测全量模型会把页脚认成
    `第3原 Sosa 113`（`章`→`原`、`Servlet`→`Sosa`）。照抄的话章名就成了
    `第3原 Sosa`，而这个字符串会变成每个单元的 `chapter`、还会多切出一个名字是垃圾的单元。
    所以：先把行尾页码和 `章/原` 的误认修掉，再用"第X章 + 不超过 12 个汉字"这条形态去卡；
    卡不过就返回空 → 调用方用**书名**兜底（一次扫描件只有一章时，这完全够用）。
    """
    for pg in model.get("pages") or []:
        for b in pg.get("blocks") or []:
            if b.get("kind") == "heading" and b.get("level") == 1:
                text = str(b.get("text") or "").strip()
                if re.match(r"^第\s*\d+\s*[章原篇节]", text):
                    return _clean_chapter(text, _model_text(model))
    for pg in model.get("pages") or []:
        for d in pg.get("dropped") or []:
            t = str(d.get("text") or "").strip()
            if re.match(r"^第\s*\d+\s*[章原篇节]", t):
                cleaned = _clean_chapter(t, _model_text(model))
                if cleaned:
                    return cleaned
    return ""


def _model_text(model: dict) -> str:
    """模型里全部正文（用来印证"章名尾巴那个词在书里真的出现过"）"""
    out = []
    for pg in model.get("pages") or []:
        for b in pg.get("blocks") or []:
            for l in b.get("lines") or []:
                out.append(str(l.get("text") or ""))
    return "\n".join(out)


def _clean_label(raw: str) -> str:
    """
    把一个小节名/章名洗掉**OCR 带进来的标点噪声**，并压掉多余空白。

    为什么需要：扫描件里的小节标题常被认成 `3.6.2 “重定向`、`3.5.2 “设置响应体`
    （那个 `“` 是页面上的引号/装饰被认进来的）。它直接变成题目卡上的"章节"，
    而"你哪一节最弱"这条统计**就是按这个字段分桶**的 —— 带噪声的话
    `3.6.2 “重定向` 和 `3.6.2 重定向` 会分成两桶，统计就花了。
    （只去标点、不改字：改字是校对台和多数拼法判据的事，不在这里做。）
    """
    t = str(raw or "")
    t = t.replace("“", "").replace("”", "").replace("‘", "").replace("’", "")
    t = t.replace("`", "").replace("「", "").replace("」", "").replace("『", "").replace("』", "")
    t = re.sub(r"^[\s·•\-–—、,，.。:：]+", "", t)          # 行首的装饰
    t = re.sub(r"[\s·•\-–—、,，]+$", "", t)               # 行尾的装饰
    t = re.sub(r"\s{2,}", " ", t)                          # 压掉多余空白
    t = re.sub(r"^(\d+(?:\.\d+)+)\s*", r"\1 ", t)          # `3.6.2重定向` → `3.6.2 重定向`
    return t.strip()


def _clean_chapter(raw: str, model_text: str) -> str:
    """
    把一条"跑马灯章名"洗成可用的章名，认不出来就只留 `第X章`。

    为什么要这么麻烦：实测全量模型把页脚 `第3章 Servlet 113` 认成 `第3原 Sosa 113`
    （`章`→`原`、`Servlet`→`Sosa`）。照抄的话章名就是 `第3原 Sosa`，
    它会变成每个单元的 `chapter`、还多切出一个名字是垃圾的单元。

    判据（和预习页"自测题答案必须在书里出现 ≥2 次"同一套思路）：
      · 行尾页码去掉；`第X原` 修回 `第X章`（`原` 是 `章` 的常见误认）
      · 尾巴是 2~12 个纯汉字 → 接受
      · 尾巴是一个拉丁词，**而且它在全书出现过 ≥2 次** → 接受（`Servlet` ✓ / `Sosa` ✗）
      · 其余（认不出来的垃圾尾巴）→ 只留 `第X章`
    """
    t = re.sub(r"\s*\d{1,4}\s*$", "", str(raw or "")).strip()
    m = re.match(r"^第\s*(\d+)\s*[章原篇节]\s*(.*)$", t)
    if not m:
        return ""
    prefix = f"第{m.group(1)}章"
    tail = m.group(2).strip()
    if not tail:
        return prefix
    if re.match(r"^[\u4e00-\u9fff]{2,12}$", tail):
        return f"{prefix} {tail}"
    latin = re.match(r"^([A-Za-z][A-Za-z0-9]*)$", tail)
    if latin and model_text.count(latin.group(1)) >= 2:
        return f"{prefix} {latin.group(1)}"
    return prefix


def _looks_like_java(code: str) -> bool:
    return bool(re.search(r"\b(import|package|public|class|void|new)\b|;\s*$", code, re.M))


def model_to_markdown(model: dict) -> tuple[str, str]:
    """
    文档模型 → **伪 markdown**，返回 `(markdown, 书名)`。

    为什么绕这一圈、而不是给后面的流程直接塞 `Unit`：
    切单元、抽教学点（concept/code/pitfall/contrast）、**引用逐字校验**、去重、审阅报告
    全长在 markdown 这条路上。转一层 markdown，这些**一个都不用重写** ——
    也就不会出现"同一判据两处实现、迟早有一处过期"（坑 58 已经付过两次学费）。
    代价是版面信息在转换时被压平成文本（这一层本来也不看版面）。

    映射：
      `#` 书名 / `##` 章（跑马灯那条）/ `###` 小节（= 单元；超长时上游再按 `###` 切）
      代码清单 → 围栏块（前面一行题注）；图 → 引用块并写明"别当正文"；
      表格 → 行文本 + "列关系已丢"的说明
    """
    book = str(model.get("book") or "").strip() or "扫描件教材"
    chapter = _model_chapter(model) or book
    out: list[str] = [f"# {book}", "", f"## {chapter}", ""]

    for pg in model.get("pages") or []:
        for block in pg.get("blocks") or []:
            kind = block.get("kind")
            lines = [str(l.get("text") or "") for l in block.get("lines") or []]

            if kind == "heading":
                text = str(block.get("text") or "").strip()
                if not text:
                    continue
                if block.get("level") == 1 and text == chapter:
                    continue  # 已经当 `##` 发过了，别再来一次
                out += [f"### {text}", ""]
            elif kind == "code":
                caption = str(block.get("caption") or "").strip()
                if caption:
                    out += [f"（教材代码清单：{caption}）", ""]
                code = str(block.get("text") or "").rstrip()
                if not code:
                    continue
                lang = "java" if _looks_like_java(code) else ""
                out += [f"```{lang}", code, "```", ""]
            elif kind == "figure":
                cap = str(block.get("caption") or block.get("title") or "").strip()
                out += [f"> 图：{cap}（这一块是图里的文字，不是正文）", ""]
            elif kind == "table":
                cap = str(block.get("caption") or block.get("title") or "").strip()
                out += [f"> 表：{cap}", "（OCR 只给了行，列关系已丢 —— 出题别依赖列对应）", ""]
                out += [t for t in lines if t.strip()]
                out += [""]
            elif kind == "list":
                rows = [t.strip() for t in lines if t.strip()]
                out += [f"- {r}" for r in rows]
                out += [""]
            else:  # para 及其它 → 接回段落
                text = _join_ocr_lines(lines)
                if text:
                    out += [text, ""]

    return "\n".join(out).strip() + "\n", book


def load_docmodel(path: Path, url_base: str, url_ext: str) -> Source:
    """
    源插件：`--source model:.tmp/docmodel.json`（`core/docmodel.js` 的产物）。

    这条路的形状：**扫描件 → 浏览器 OCR → 文档模型 → 伪 markdown → 知识单元 →
    走 `docs` 提示词包出题（强制逐字引用）**。所以扫描件也能享受"引用抄不出来就丢弃"
    这条硬保证 —— 这正是教材类内容唯一不可接受的失败模式（讲错了学生看不出来）。

    ⚠️ 扫描件教材是**私有**的：没有可点的原文链接。所以 `url_base` 留空，
    调用方会把每个单元的 `url` 清掉 —— 别给用户一个点不开的死链。
    """
    if not path.is_file():
        raise SystemExit(
            f"找不到文档模型：{path}\n"
            f"先生成它：node quiz/tools/docmodel_check.mjs --raw <模型.json>（见 HANDOVER 第十批）"
        )
    model = json.loads(path.read_text(encoding="utf-8"))
    md, book = model_to_markdown(model)
    stats = model.get("stats") or {}
    if not model.get("book"):
        # 书名是 `core/docmodel.js` 的 `guessBook()` 算的（从被剔除的页眉里挑）。
        # 没有这个字段 = 模型是**旧版本**生成的 → 说清楚，别悄悄用个假书名。
        print("⚠️ 这份文档模型里没有 `book` 字段（旧版本生成的）—— 建议重新生成一次：")
        print("   node quiz/tools/docmodel_check.mjs --raw <模型.json>")
    return Source(
        kind="docmodel",
        files=[(f"{book}.md", md)],
        label=f"{book}（扫描件 {stats.get('pages', '?')} 页 / 文档模型）",
        url_base="",
        url_ext="",
        # ⚠️ 站主 2026-10-11 的澄清：**不能公开发布的是"教材原文"**（避免版权问题），
        #    **不是**"这份题库不公开"。题库是**衍生内容**（题目 + 解析 + 原文**短片段**引用），
        #    可以上站；不进仓库、不外发的是整本书的扫描件与 OCR 全文。
        #    原来这里写"私有（…不公开发布）"，把这两件事混成了一件 —— 站主纠正过。
        license="教材原文不公开发布（避免版权问题）；题库为衍生内容，仅引用原文短片段",
        attribution=f"{book}：扫描件由站点 OCR 整理；教材原文不再分发，题目与解析为衍生内容",
    )


# ══════════════════════════════════════════════════════════════════════
# 三、出题（调后端；带出处的强制要求在后端 docs 提示词包里）
# ══════════════════════════════════════════════════════════════════════


class Backend:
    """
    后端 API 客户端。

    为什么要绕后端而不是直接调模型：
      · **key 在板子上**（renwu/shared/.env），本机没有 —— 也不该为了跑个批处理
        把用户的 key 复制到各处
      · 后端里已经有降级链（本机 Ollama → 云端）和限流，复用它等于不用维护第二套
      · 提示词包在后端统一管理（`prompts.py` 的 `_PACKS`），出题规则只有一份实现

    CSRF 按仓库既有约定：GET status/ 会种 csrftoken cookie，POST 要带 X-CSRFToken
    （这几个接口是真花钱的，所以后端刻意没用 csrf_exempt —— 别绕过它）。
    """

    def __init__(self, base: str, timeout: float = 600.0):
        self.base = base.rstrip("/") + "/"
        self.timeout = timeout
        self.jar = CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self._primed = False

    def _token(self) -> str:
        for c in self.jar:
            if c.name == "csrftoken":
                return c.value
        return ""

    def prime(self) -> None:
        if self._primed and self._token():
            return
        req = urllib.request.Request(self.base + "status/", headers={"User-Agent": "docs-to-bank/1.0"})
        with self.opener.open(req, timeout=60) as r:
            r.read()
        self._primed = True

    def post(self, path: str, payload: dict) -> dict:
        self.prime()
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            self.base + path.lstrip("/"),
            data=data,
            headers={
                "Content-Type": "application/json",
                "X-CSRFToken": self._token(),
                "User-Agent": "docs-to-bank/1.0",
            },
            method="POST",
        )
        try:
            with self.opener.open(req, timeout=self.timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")
            try:
                return json.loads(body)
            except Exception:  # noqa: BLE001
                return {"ok": False, "error": f"HTTP {exc.code}: {body[:200]}"}

    def generate(
        self, material: str, count: int, types: list[str], title: str, subject: str,
        domain: str, prefer_cloud: bool | None = None,
    ) -> dict:
        payload = {
            "material": material, "count": count, "types": types,
            "title": title, "subject": subject, "domain": domain,
        }
        # 三态：不传 = 跟随后端默认（docs 领域默认云端优先）。
        # 后端 docs 的出题默认就是云端先上 —— 精确任务（逐字引用原文）小模型干不了。
        if prefer_cloud is not None:
            payload["preferCloud"] = prefer_cloud
        return self.post("generate/", payload)


# ══════════════════════════════════════════════════════════════════════
# 四、确定性自检（AI 的产出必须过这几关）
# ══════════════════════════════════════════════════════════════════════


def norm_text(s: str) -> str:
    """压缩空白后再比 —— 模型抄原文时经常把换行/空格弄乱，那不算抄错"""
    return re.sub(r"\s+", " ", s or "").strip()


def _squash(s: str) -> str:
    """
    **去掉所有空白**再比（比 norm_text 更狠）。

    为什么需要这一档：OCR 排版会把「每20s」读成「每 20s」、把英文断词处插空格 ——
    这种差异在"空格算不算一个字"这一层上必须抹平，否则会得出
    「答案的用词在材料里找不到」这种**自相矛盾**的结论（材料明明写着）。
    """
    return re.sub(r"\s+", "", s or "")


def citation_of(question: dict) -> dict:
    """
    取出处。两条路，按可信度：

      ① `question["source"] = {heading, quote}` —— 结构化字段（后端 service.py 透传）
      ② 从 `analysis` 最后一行 `依据：<原文>` 里抠 —— **兼容还没升级的后端**

    为什么留第②条：出处必须"用户看得见"（analysis 是直接显示给学生的），
    而校验需要"机器读得到"。所以提示词要求两处都写：analysis 里写给人看，
    source 里给校验用。后端只透传了 source，旧版本则只剩 analysis —— 两条都认，
    这套管线就不会因为后端没来得及升级而整个哑掉。
    """
    src = question.get("source")
    if isinstance(src, dict) and (src.get("quote") or src.get("heading")):
        return {"heading": str(src.get("heading") or "").strip(), "quote": str(src.get("quote") or "").strip()}
    analysis = str(question.get("analysis") or "")
    for line in reversed([l.strip() for l in analysis.splitlines() if l.strip()]):
        for prefix in ("依据：", "依据:"):
            if line.startswith(prefix):
                quote = line[len(prefix) :].strip().strip("「」『』\"'")
                return {"heading": "", "quote": quote}
    return {}


def check_citation(question: dict, material: str) -> tuple[bool, str]:
    """
    ★ 整套设计里最要紧的一条：**出处必须能在原文里逐字命中**。

    没这一条，模型就会"凭记忆讲 API"（把 Vue 2 的写法、别的框架的写法混进来），
    而学生看不出错 —— 这是教育类内容唯一不可接受的失败模式。
    所以：抄不出来 = 丢掉，不商量。
    """
    src = citation_of(question)
    quote = norm_text(src.get("quote") or "")
    if len(quote) < 12:
        return False, "没有给 source.quote（或太短）"
    hay = norm_text(material)
    if quote in hay:
        return True, ""
    # 允许模型把 Markdown 记号（**、`、#）去掉后再抄：去掉记号再比一次
    loose = norm_text(re.sub(r"[`*_#>\[\]()]", "", quote))
    hay_loose = norm_text(re.sub(r"[`*_#>\[\]()]", "", hay))
    if len(loose) >= 12 and loose in hay_loose:
        return True, ""
    return False, "引用的原文片段在材料里找不到（疑似凭记忆编的）"


def check_structure(question: dict) -> tuple[bool, str]:
    qtype = question.get("type")
    stem = str(question.get("stem") or "").strip()
    answer = question.get("answer") or []
    options = question.get("options") or []
    if len(stem) < 8:
        return False, "题干太短"
    if qtype not in ("single", "multiple", "judge"):
        return False, f"题型不认识：{qtype}"
    if not answer:
        return False, "没有答案"
    if qtype == "judge":
        if any(k not in ("T", "F", "对", "错", "正确", "错误") for k in answer):
            return False, f"判断题答案形状不对：{answer}"
        return True, ""
    keys = [str(o.get("key")) for o in options if isinstance(o, dict)]
    if len(keys) != 4:
        return False, f"选项不是 4 个：{len(keys)}"
    if any(k not in keys for k in answer):
        return False, f"答案里有不存在的选项：{answer} vs {keys}"
    if qtype == "single" and len(answer) != 1:
        return False, "单选题答案不唯一"
    if qtype == "multiple" and not (2 <= len(answer) <= 4):
        return False, f"多选题答案个数不对：{len(answer)}"
    texts = [norm_text(str(o.get("text") or "")) for o in options]
    if len(set(texts)) != len(texts):
        return False, "选项之间有重复"
    if any(len(t) < 1 for t in texts):
        return False, "有空选项"
    return True, ""


def _tokens(s: str) -> set[str]:
    """
    切"特征词"。

    ⚠️ **中文和数字/字母不能粘成一个词**：OCR 原文写「每20s」、选项写「每 20s」，
    正则在 CJK↔ASCII 边界上不切，就会把「20s」并进「每20s」里，
    于是正确答案被判成"用词在材料里找不到"。所以按边界再切一刀
    （真实数据里第 1 题就是这么被误报成"存疑"的，见坑 86）。
    """
    text = norm_text(s).lower()
    toks = {t for t in re.findall(r"[\w$.\u4e00-\u9fff]+", text) if len(t) >= 2}
    for t in list(toks):
        for part in re.findall(r"[\u4e00-\u9fff]+|[^\u4e00-\u9fff]+", t):
            part = part.strip("$.")
            if len(part) >= 2:
                toks.add(part)
    return toks


CJK_RE = re.compile(r"[\u4e00-\u9fff]")


def _cjk_ratio(text: str) -> float:
    if not text:
        return 0.0
    return len(CJK_RE.findall(text)) / max(1, len(text))


def check_answer_grounded(question: dict, material: str) -> tuple[bool, str]:
    """
    正确选项的"特征词"应该能在材料里找到。

    这是**弱判据**（用词不同就误报），所以只用来打标记、不用来丢弃 ——
    真正的强判据是"把材料抽掉再让模型做一遍"，那一步需要再一次 LLM 调用，
    排在下一步（见 report 里的 TODO），本期先用这条兜住明显的"答非所问"。

    ⚠️ **跨语言时这条判据不成立，必须跳过**：
    材料是英文官方文档、题干和选项是中文（这正是我们要的形态）时，
    中文选项在英文材料里的"用词重合度"天然接近 0 —— 第一轮实测 6 条"存疑"
    全是这么来的**误报**。所以先看语言：一边中文一边英文就直接放行。
    """
    if question.get("type") == "judge":
        return True, ""
    options = question.get("options") or []
    answer = {str(k) for k in (question.get("answer") or [])}
    picked = [str(o.get("text") or "") for o in options if str(o.get("key")) in answer]
    if not picked:
        return True, ""
    if _cjk_ratio("".join(picked)) > 0.25 and _cjk_ratio(material) < 0.05:
        return True, ""  # 材料英文 / 选项中文：判据不适用，放行（不是"找不到依据"）
    # ★ 最强也最便宜的一条：正确选项**逐字**出现在材料里（忽略空白差异）→ 依据确凿。
    #   要求**全部**正确选项都命中，免得"一个选项抄对了、另两个是编的"也蒙过去。
    #   为什么非要这一条：token 切分对中英数混排不可靠，「每 20s」这条真实数据
    #   明明抄的是原文「每20s」，却因为切词被判了 0% 重合（见坑 86）。
    squashed = _squash(material)
    if picked and all(_squash(t) and _squash(t) in squashed for t in picked):
        return True, ""
    hay = _tokens(material)
    hit = set()
    for t in picked:
        hit |= _tokens(t)
    if not hit:
        return True, ""
    overlap = len(hit & hay) / max(1, len(hit))
    if overlap < 0.34:
        return False, f"正确选项的用词在材料里几乎找不到（重合 {overlap:.0%}）"
    return True, ""


IDENT_RE = re.compile(r"[A-Za-z][A-Za-z0-9_]{5,}")
"""只认长度 ≥6 的标识符。`req`/`resp` 这种短词差两个字符就完全是两样东西，
把它们当"同一个标识符的两种拼法"会把误报灌进来。"""


def _edit_distance_at_most(a: str, b: str, k: int) -> int:
    """编辑距离，超过 k 立刻返回 k+1（这里只关心"是不是只差一个字符"）。"""
    if abs(len(a) - len(b)) > k:
        return k + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        if min(cur) > k:
            return k + 1
        prev = cur
    return prev[-1]


def identifier_counts(material: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for m in IDENT_RE.finditer(material):
        t = m.group(0).lower()
        counts[t] = counts.get(t, 0) + 1
    return counts


def _digit_sig(s: str) -> str:
    return "".join(ch for ch in s if ch.isdigit())


# 英文的**词形变化**后缀。`components`/`component`、`watchers`/`watcher` 只差一个字符，
# 但它们是两个正常的词，不是同一个标识符的错拼。
_INFLECTIONS = ("s", "es", "ed", "d", "ing", "er", "ers", "est", "ly", "ion", "ions")


def _is_inflection(a: str, b: str) -> bool:
    """是不是"同一个词的两种词形"（单复数 / 时态 / 比较级）——是的话就不是 OCR 错拼。"""
    for x, y in ((a, b), (b, a)):
        for suf in _INFLECTIONS:
            if y == x + suf:
                return True
    return False


def _dominance_ratio() -> int:
    """
    "少数拼法"要少数到什么程度才算 OCR 错拼：多数拼法的出现次数至少是它的 **3 倍**。

    这个阈值是**量出来的**，不是拍的：
    - 真 OCR 错拼是"偶发误读" → 差得很悬殊：`usertname` 1 次 vs `username` 10 次（10×）、
      `HitpServletRequest` 1 次 vs `HttpServletRequest` 3 次（3×，**正好卡在阈值上**）
    - 正常英文近形词是"两个词都在用" → 次数接近：`getter` 4 vs `setter` 5、
      `watched` 2 vs `watcher` 3、`components` 4 vs `component` 9
    在真实的 283 道 Vue 题（干净 markdown，没有 OCR）上量过：不加这条，新判据会报
    **16 条全是误报**（`components`/`attribute`/`getter`/`watched`/`object`…）；
    加上这条 + 词形排除之后，干净语料上的误报降到 0，而扫描件上那 2 条真错拼照旧报出来。
    ⚠️ 阈值是经验值：真错拼如果只出现 2~3 次，和近形词就分不开了（那时只能靠人看）。
    """
    return 3


def _display_spelling(material: str, tok: str) -> str:
    """
    报告里要显示**材料里的原始大小写**。

    数出现次数必须忽略大小写（`Servlet`/`servlet` 是同一个东西），
    但把 `hitpservletrequest` 这种全小写形式端给人看就变成另一个样子了 ——
    人要照着改的是 `HitpServletRequest`。
    """
    m = re.search(rf"(?i)(?<![A-Za-z0-9_]){re.escape(tok)}(?![A-Za-z0-9_])", material)
    return m.group(0) if m else tok


def check_identifier_spelling(question: dict, material: str) -> list[str]:
    """
    答案里的**标识符**拼法，在材料里站不站得住。

    坑 86：OCR 会把同一个标识符认成两种拼法（`username`/`usertname`、
    `HttpServletRequest`/`HitpServletRequest`），而**只看置信度**会拿认错的词当标准答案。
    判据是**互相印证**：同一标识符出现多次时，以**多数拼法**为准。

    两个方向都报，而且都只**标存疑**（不丢弃）：
      · 引文处是少数拼法、材料他处是多数 → **引文**错：学生点开出处会发现和正确答案对不上
      · 答案用少数拼法、材料多数是另一种 → **答案**可能抄了 OCR 的错字（"标准答案错"，更要人看）

    ⚠️ 三条降噪的限制，缺一条误报就压不住：
      1. 只认长度 ≥6 的标识符、且只差**一个字符**（`_edit_distance_at_most(..., 1)`）；
      2. 两个拼法的**数字必须完全一样** —— `ResponseServlet01` 和 `ResponseServlet02`
         只差一个字符，但它们是两样东西，不是同一个标识符的错拼；
      3. 只在**本单元材料**里数，不跨单元 —— 拼法证据要在同一段语境里才算数。
    """
    if question.get("type") == "judge":
        return []
    options = question.get("options") or []
    answer = {str(k) for k in (question.get("answer") or [])}
    picked = [str(o.get("text") or "") for o in options if str(o.get("key")) in answer]
    if not picked:
        return []
    counts = identifier_counts(material)
    if len(counts) < 2:
        return []
    # ⚠️ 引文要**小写化**再比：counts 的键是小写的，而引文里是 `HitpServletRequest` 这种
    #    正常大小写 —— 第一版忘了这一步，于是只有"OCR 恰好全小写"的 `usertname` 被标出来，
    #    `HitpServletRequest` 那条悄悄漏过去了（同一类问题只抓到一半，比不抓更坏）。
    quote = _squash((question.get("source") or {}).get("quote") or "").lower()
    issues: list[str] = []
    for tok in sorted({t.lower() for text in picked for t in IDENT_RE.findall(text)}):
        c_t = counts.get(tok, 0)
        rivals = [
            v
            for v in counts
            if v != tok
            and _digit_sig(v) == _digit_sig(tok)
            and _edit_distance_at_most(tok, v, 1) <= 1
        ]
        if not rivals:
            continue
        best = max(rivals, key=lambda v: counts[v])
        c_best = counts[best]
        if _is_inflection(tok, best):
            continue  # components/component 这种词形变化不是错拼
        if max(c_t, c_best) < _dominance_ratio() * min(c_t, c_best):
            continue  # 两个拼法"势均力敌" → 是两个词各在用，不是偶发误读
        tok_show = _display_spelling(material, tok)
        best_show = _display_spelling(material, best)
        if c_t < c_best:
            # 答案用少数拼法 —— 这才是坑 86 真正要拦的："标准答案抄了 OCR 的错字"
            issues.append(
                f"答案里的标识符「{tok_show}」在材料里只出现 {c_t} 次，「{best_show}」出现 {c_best} 次"
                f" —— 答案可能抄了 OCR 的错字，请按多数拼法核对"
            )
        elif c_t > c_best and best in quote and tok not in quote:
            # 答案是对的，但**引文**是少数拼法 —— 学生点"看出处"会对不上
            issues.append(
                f"引文这里是 OCR 少数拼法「{best_show}」（{c_best} 次），材料他处「{tok_show}」{c_t} 次"
                f" —— 答案用的是多数拼法，但点开出处会和正确答案对不上"
            )
        if len(issues) >= 2:
            break
    return issues


def dedupe_questions(questions: list[dict]) -> tuple[list[dict], int]:
    """按题干查重（老判据，留着兜底：有些题没有出处，只能看题干）"""
    seen: set[str] = set()
    out: list[dict] = []
    dropped = 0
    for q in questions:
        key = norm_text(str(q.get("stem") or "")).lower()[:80]
        if key in seen:
            dropped += 1
            continue
        seen.add(key)
        out.append(q)
    return out, dropped


def _answer_fp(question: dict) -> set[str]:
    """「正确答案这一串字」的指纹。优先用**选项文本**（模型可以换词），没有就退回 key。"""
    options = question.get("options") or []
    answer = {str(k) for k in (question.get("answer") or [])}
    picked = [str(o.get("text") or "") for o in options if str(o.get("key")) in answer]
    text = _squash("".join(picked) or "".join(sorted(answer)))
    if not text:
        return set()
    return {text[i : i + 4] for i in range(max(0, len(text) - 3))} or {text}


def same_exam_point(a: dict, b: dict) -> bool:
    """
    这两道题是不是**在考同一个考点**？

    判据是「引用同一句原文 + 答案事实相同」，**不是**「题干长得像」。
    第十三批实测：12 道题里有 **3 对**在引用同一句原文，可题干各写得不一样，
    所以按题干前 80 字查重报 **0 对** —— 等于把同一个考点买了两遍（老待办 A）。
    引用逐字相同是可确定性判定的，**不用花额度**：embedding 只对"换了句子但考同一个点"
    才有增量，那部分交给下一轮。

    ⚠️ 只看引用相同**不够**：一段长引文本来就撑得起好几个不同的考点，
    所以答案事实也要重合（4-gram Jaccard ≥ 0.5）。答案不同 → 认为是两个考点，都留。
    """
    qa = _squash((a.get("source") or {}).get("quote") or "")
    qb = _squash((b.get("source") or {}).get("quote") or "")
    if not qa or qa != qb:
        return False
    fa, fb = _answer_fp(a), _answer_fp(b)
    if not fa or not fb:
        return False
    return len(fa & fb) / max(1, len(fa | fb)) >= 0.5


def _record_rank(rec: dict) -> tuple:
    """两题同考点时留哪一道：先保**不存疑**的，再保题干更具体的（信息更多），最后按原顺序稳定。"""
    return (0 if rec.get("status") == "kept" else 1, -len(norm_text(str(rec.get("stem") or ""))))


def dedupe_records(records: list[dict]) -> tuple[list[dict], list[dict]]:
    """
    跨题去重（考点级）。返回（留下的、被合并掉的）。

    ⚠️ **被合并掉的绝不静默消失**：它们连理由带出处进审阅报告，人能复核 ——
    这份管线的规矩是"有高风险项不许静默通过"，去重同样不能例外。
    ⚠️ 已经被判据丢弃的（status=dropped）不参与合并计数，免得同一个数在两处各算一次。
    """
    kept: list[dict] = []
    merged: list[dict] = []
    for rec in records:
        if rec.get("status") == "dropped":
            kept.append(rec)
            continue
        rival = next((k for k in kept if k.get("status") != "dropped" and same_exam_point(k, rec)), None)
        if rival is None:
            kept.append(rec)
            continue
        if _record_rank(rec) < _record_rank(rival):
            kept[kept.index(rival)] = rec
            merged.append(rival)
        else:
            merged.append(rec)
    return kept, merged


# ══════════════════════════════════════════════════════════════════════
# 五、产物
# ══════════════════════════════════════════════════════════════════════


def write_units_report(units: list[Unit], source: Source, path: Path) -> None:
    lines = [
        f"# 知识单元索引 · {source.label}",
        "",
        f"- 文件数：{len({u.file for u in units})}",
        f"- 单元数：{len(units)}",
        f"- 教学点：{sum(len(u.points) for u in units)}"
        f"（concept {sum(1 for u in units for p in u.points if p.kind == 'concept')} /"
        f" code {sum(1 for u in units for p in u.points if p.kind == 'code')} /"
        f" pitfall {sum(1 for u in units for p in u.points if p.kind == 'pitfall')} /"
        f" contrast {sum(1 for u in units for p in u.points if p.kind == 'contrast')}）",
        "",
        "> 这张表就是「它到底把文档切成了什么」。切错了，后面出题全是歪的 —— 所以先看这张表。",
        "",
        "| 文件 | 章（chapter） | 单元 | 锚点 | 教学点 | 字符 |",
        "|---|---|---|---|---|---|",
    ]
    for u in units:
        kinds = {}
        for p in u.points:
            kinds[p.kind] = kinds.get(p.kind, 0) + 1
        detail = " ".join(f"{k}×{v}" for k, v in sorted(kinds.items()))
        lines.append(
            f"| {u.file} | {u.chapter} | {u.heading} | [`#{u.slug}`]({u.url}) | {detail or '—'} | {len(render_text(u))} |"
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_bank(bank: dict, path: Path) -> None:
    path.write_text(json.dumps(bank, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_review(
    records: list[dict],
    source: Source,
    path: Path,
    counts: dict,
    merged: list[dict] | None = None,
) -> None:
    lines = [
        f"# 出题审阅报告 · {source.label}",
        "",
        f"- 单元跑过：{counts.get('units', 0)}；生成：{counts.get('generated', 0)}；"
        f"通过自检：{counts.get('kept', 0)}；丢弃：{counts.get('dropped', 0)}；存疑：{counts.get('flagged', 0)}；"
        f"去重合并：{counts.get('dup', 0)}",
        "",
        "> 审阅重点：**出处那一段**。题能不能做、答案对不对，全看它抄的是不是原文。",
        "> 每条都带原文链接，点开对照一眼就知道。",
        "",
    ]
    for rec in records:
        mark = "✅" if rec["status"] == "kept" else ("⚠️" if rec["status"] == "flagged" else "❌")
        lines.append(f"## {mark} {rec['stem']}")
        lines.append("")
        lines.append(f"- 类型：`{rec['type']}`　答案：`{','.join(rec['answer'])}`")
        if rec.get("llm"):
            # 审阅时很想知道"这道题是谁出的"：本机 1.5B 出的题引用几乎都抄不对
            lines.append(f"- 模型：`{rec['llm']}`")
        lines.append(f"- 出处：[{rec['source']['heading'] or rec['unit_heading']}]({rec['source']['url']})")
        if rec["source"].get("quote"):
            lines.append(f"- 原文片段：> {rec['source']['quote']}")
        if rec.get("issues"):
            lines.append(f"- **问题**：{'；'.join(rec['issues'])}")
        lines.append("")
        for o in rec.get("options") or []:
            tick = "✓" if o["key"] in rec["answer"] else " "
            lines.append(f"  - [{tick}] {o['key']}. {o['text']}")
        if rec.get("analysis"):
            lines.append("")
            lines.append(f"  <sub>解析：{rec['analysis']}</sub>")
        lines.append("")

    # ★ 被去重合并掉的题**照样列出来**：人能看到"哪两道题在考同一个考点、留了哪一道"，
    #   不同意就把它从合并里放回来（改判据即可，不用重花额度）。
    if merged:
        lines += [
            "---",
            "",
            f"## 🔁 去重合并掉的 {len(merged)} 道（考了同一个考点）",
            "",
            "> 判据：**引用同一句原文 + 答案事实重合**（详见 `same_exam_point`）。",
            "> 留的是原题；下面这些没进题库，但出处都在，可以复核。",
            "",
        ]
        for rec in merged:
            surv = next((r for r in records if same_exam_point(r, rec)), None)
            lines.append(f"### ❌ {rec['stem']}")
            lines.append("")
            lines.append(f"- 类型：`{rec['type']}`　答案：`{','.join(rec['answer'])}`")
            lines.append(f"- 和它撞车的是：{surv['stem'] if surv else '（已不在题库里）'}")
            if (rec.get("source") or {}).get("quote"):
                lines.append(f"- 原文片段：> {rec['source']['quote']}")
            lines.append("")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# ══════════════════════════════════════════════════════════════════════
# 六、自检（不联网、不花钱：解析器的断言）
# ══════════════════════════════════════════════════════════════════════

FIXTURE = """---
outline: deep
---

# Reactivity Fundamentals

<script setup>
import { ref } from 'vue'
</script>

## Declaring Reactive State

With the Options API, we use the `data` option to declare reactive state.

:::tip
`ref()` is the recommended way to declare reactive state.
:::

```js [Options API]
export default {
  data() {
    return { count: 0 }
  }
}
```

```js [Composition API]
import { ref } from 'vue'

const count = ref(0)
console.log(count.value) // 0
```

:::warning Note
Do not destructure `reactive()` objects, as it will lose reactivity.
:::

### Deep Reactivity

Refs created with `ref()` are deeply reactive.

<<< @/guide/essentials/reactivity-fundamentals/ref.js

## Another Section

The `computed()` function takes a getter.
"""


def selftest() -> int:
    ok = 0
    fails: list[str] = []

    def eq(name: str, got, want) -> None:
        nonlocal ok
        if got == want:
            ok += 1
        else:
            fails.append(f"{name}: 期望 {want!r}，实际 {got!r}")

    blocks = parse_markdown(FIXTURE)
    eq("frontmatter 被剥掉", any(b.text.startswith("outline") for b in blocks), False)
    eq("H1 被识别", [b.text for b in blocks if b.kind == "heading" and b.level == 1], ["Reactivity Fundamentals"])
    eq("tip 容器被识别", sum(1 for b in blocks if container_kind(b) == "tip"), 1)
    eq("warning 带标题", container_label([b for b in blocks if container_kind(b) == "warning"][0]), "Note")
    eq("代码块语言", [b.lang for b in blocks if b.kind == "code"], ["js", "js"])
    eq("代码块标签（VitePress 的 [Options API]）", [b.label for b in blocks if b.kind == "code"], ["Options API", "Composition API"])
    eq("代码块内容没被容器吃掉", "count: 0" in [b.text for b in blocks if b.kind == "code"][0], True)
    eq("<<< 示例引入被识别", [b.text for b in blocks if b.kind == "include"], ["/guide/essentials/reactivity-fundamentals/ref.js"])
    eq("容器内的代码块也带容器上下文", [container_kind(b) for b in blocks if b.kind == "code"], ["", ""])

    eq("slug：普通标题", slugify("Declaring Reactive State"), "declaring-reactive-state")
    eq("slug：带标点", slugify("`ref()` vs `reactive()`"), "ref-vs-reactive")
    eq("slug：中文", slugify("响应式基础"), "响应式基础")

    # ★ 真实文档里标题长这样：`## The Application Instance {#the-application-instance}`。
    #   第一版没处理它，结果标题被污染、锚点重复成 `...-the-application-instance-the-application-instance`。
    #   官方给的锚点是权威的 —— 有它就别猜。
    eq("显式锚点优先：标题被清干净", parse_heading("The Application Instance {#the-application-instance}"),
       ("The Application Instance", "the-application-instance"))
    eq("脚注 * 要剥掉（Vue 文档用它标「仅某写法」）", parse_heading("Declaring Reactive State *"), ("Declaring Reactive State", ""))
    eq("脚注 ** 也剥掉", parse_heading("`watchEffect()` **"), ("`watchEffect()`", ""))
    eq("没有锚点时留空（交给 slugify）", parse_heading("Deep Reactivity"), ("Deep Reactivity", ""))

    # ★★ 围栏信息串：Vue 文档里有 ```` ```js{6} ```` / ```` ```vue{5} [BlogPost.vue] ````（22 处）
    #    第一版正则不认 `{6}` → 围栏奇偶翻转 → **整篇文档被当成一个代码块**
    #    （症状：reactivity-fundamentals.md 的 5 个 ## 只切出 1 个）。这条是那个 bug 的回归测试。
    eq("围栏：普通语言", parse_fence_info("js"), ("js", ""))
    eq("围栏：高亮行标记", parse_fence_info("js{6}"), ("js", ""))
    eq("围栏：高亮区间", parse_fence_info("js{7-11}"), ("js", ""))
    eq("围栏：高亮 + 标签", parse_fence_info("vue{5} [BlogPost.vue]"), ("vue", "BlogPost.vue"))
    eq("围栏：带连字符的语言 + 高亮", parse_fence_info("vue-html{1,7}"), ("vue-html", ""))

    parity = """# 标题

## 第一节

```js{2}
const a = 1
```

## 第二节

```vue{5} [X.vue]
<script setup>
const b = 2
</script>
```

## 第三节

正文
"""
    pb = parse_markdown(parity)
    eq("★ 围栏带 {n} 时，后面的 ## 仍然被识别（回归测试）",
       [b.text for b in pb if b.kind == "heading" and b.level == 2], ["第一节", "第二节", "第三节"])
    eq("★ 围栏内容没被截断", sum(1 for b in pb if b.kind == "code"), 2)
    eq("★ 带 {n} 的围栏也能读出语言", [b.lang for b in pb if b.kind == "code"], ["js", "vue"])

    blocks2 = parse_markdown("## A {#a}\n\ntext here\n\n### B {#b}\n\nmore text\n")
    eq("标题块带上了锚点", [b.anchor for b in blocks2 if b.kind == "heading"], ["a", "b"])
    u2 = split_units(blocks2, "x.md", "https://e.com", ".html")
    eq("显式锚点直接进单元", u2[0].slug, "a")
    eq("子标题的锚点也认", any(b.anchor == "b" for b in u2[0].blocks), True)

    units = split_units(blocks, "reactivity-fundamentals.md", "https://vuejs.org/guide/essentials", ".html")
    eq("按 ## 切成 2 个单元", len(units), 2)
    eq("单元 id 是 文件#锚点", units[0].id, "reactivity-fundamentals#declaring-reactive-state")
    eq("单元 url 拼对了", units[0].url, "https://vuejs.org/guide/essentials/reactivity-fundamentals.html#declaring-reactive-state")
    eq("### 留在单元内（不另起单元）", any(b.kind == "heading" and b.level == 3 for b in units[0].blocks), True)

    points = extract_points(units[0])
    kinds = sorted(p.kind for p in points)
    eq("教学点：小节标题算 concept", kinds.count("concept"), 1)
    eq("教学点：两个代码块", kinds.count("code"), 2)
    # tip 和 warning 都算 pitfall —— 它们都是"官方亲口说的坑"，是素材里最值钱的一类
    eq("教学点：tip/warning 都算 pitfall", kinds.count("pitfall"), 2)

    text = render_text(units[0])
    eq("材料里保留了注意标记", "⚠️ 注意" in text, True)
    eq("材料里保留了示例文件占位", "示例文件：/guide/essentials" in text, True)

    # ★ 体量超标的单元要按 ### 再切一层（真实数据里有一节 19000 字符）
    big = "## 大单元 {#big}\n\n" + "\n\n".join(
        f"### 小节{i} {{#s{i}}}\n\n这是第 {i} 段正文，" + "内容" * 400 + f"\n\n```js\nconst x{i} = ref({i})\n```"
        for i in range(1, 6)
    )
    bu = split_units(parse_markdown(big), "big.md", "https://e.com", ".html", max_chars=2000)
    eq("大单元被按 ### 切开", len(bu) > 1, True)
    eq("切开后每段都有自己的锚点", bu[0].slug != bu[1].slug, True)
    eq("每段都还认得出属于哪一章", all(u.chapter == "大单元" for u in bu), True)
    eq("切开后每段都没超标", all(len(render_text(u)) <= 2000 for u in bu), True)

    eq("出处逐字命中 → 过", check_citation({"source": {"quote": "`ref()` is the recommended way"}}, text)[0], True)
    eq("出处编的 → 不过", check_citation({"source": {"quote": "Vue 2 用 Object.defineProperty 实现响应式"}}, text)[0], False)
    eq("没给出处 → 不过", check_citation({}, text)[0], False)
    eq("出处忽略 Markdown 记号也能命中", check_citation({"source": {"quote": "ref() is the recommended way to declare reactive state"}}, text)[0], True)

    eq("结构：判断题不要求选项", check_structure({"type": "judge", "stem": "下面这段话的说法是对的", "answer": ["T"]})[0], True)
    eq("结构：单选答案必须唯一", check_structure({"type": "single", "stem": "下面哪个是对的呀", "answer": ["A", "B"], "options": [{"key": k, "text": t} for k, t in zip("ABCD", "wxyz")]})[0], False)
    eq("结构：选项重复要拦", check_structure({"type": "single", "stem": "下面哪个是对的呀", "answer": ["A"], "options": [{"key": k, "text": "same"} for k in "ABCD"]})[0], False)
    eq("结构：正常单选过", check_structure({"type": "single", "stem": "下面哪个是对的呀", "answer": ["A"], "options": [{"key": k, "text": t} for k, t in zip("ABCD", ["one", "two", "three", "four"])]})[0], True)

    kept, dropped = dedupe_questions([{"stem": "同一道题"}, {"stem": "同一道题"}, {"stem": "另一道题"}])
    eq("去重", (len(kept), dropped), (2, 1))

    # ── 考点级去重（第十三批：12 道题里 3 对考同一个考点，按题干查重却是 0 对）────
    def _rec(no, stem, quote, answer_text, status="kept"):
        return {
            "status": status, "no": no, "stem": stem, "type": "single", "answer": ["A"],
            "options": [{"key": "A", "text": answer_text}, {"key": "B", "text": "干扰项"}],
            "source": {"heading": "h", "quote": quote},
        }

    same_point = [
        _rec(1, "关于请求转发，下列说法正确的是？", "请求转发只能转发当前项目内部的资源。", "只能转发当前项目内部的资源"),
        # 题干换了个说法（所以按题干查重抓不到）、引用同一句、答案是同一个事实 → 同一个考点
        _rec(2, "关于请求转发的说法，下列哪一项是正确的？", "请求转发只能转发当前项目内部的资源 。", "只能转发当前项目内部的资源"),
        _rec(3, "重定向会带来什么后果？", "重定向会产生新的请求对象。", "产生新的 HttpServletRequest 对象"),
    ]
    s_kept, s_merged = dedupe_records(same_point)
    eq("★ 引用同一句原文 + 答案事实相同 → 合并掉一条", (len(s_kept), len(s_merged)), (2, 1))
    eq("★ 换了引文的两道题都留下（是两个考点）", [r["no"] for r in s_kept], [2, 3])
    eq("★ 同考点同状态时留题干更具体的那道（#2 比 #1 长）",
       [r["no"] for r in s_merged], [1])

    # 同一段长引文撑得起好几个不同考点 → 不能因为引用相同就合并
    one_quote_two_points = [
        _rec(1, "甲这件事怎么做？", "这一段里同时讲了甲和乙两件事。", "甲的做法是设置响应内容类型"),
        _rec(2, "乙这件事怎么做？", "这一段里同时讲了甲和乙两件事。", "乙的做法是请求转发到目标资源"),
    ]
    eq("★ 同一段引文考了两个不同事实 → 不许合并",
       len(dedupe_records(one_quote_two_points)[1]), 0)

    pref_kept, _ = dedupe_records([
        _rec(1, "短题干？", "同一句原文在这里。", "同一个答案事实", status="flagged"),
        _rec(2, "更具体的题干：带了文件名和行号？", "同一句原文在这里。", "同一个答案事实"),
    ])
    eq("★ 同考点时留下不存疑的那一道", [r["no"] for r in pref_kept], [2])

    # ── 答案逐字命中材料（坑 86：中英数混排切词会把对的判成错的）────────────
    marquee = "同时浏览器页面每20s 会自动刷新页面"
    eq("★ 答案「每 20s」对材料「每20s」→ 算命中（原判据误报 0% 重合）",
       check_answer_grounded(
           {"type": "single", "stem": "隔多久刷新？", "answer": ["B"],
            "options": [{"key": "A", "text": "每 10s"}, {"key": "B", "text": "每 20s"}]},
           marquee)[0], True)
    eq("★ 答案在材料里真的找不到 → 仍然要报",
       check_answer_grounded(
           {"type": "single", "stem": "隔多久刷新？", "answer": ["A"],
            "options": [{"key": "A", "text": "每秒刷新三次"}, {"key": "B", "text": "每 20s"}]},
           marquee)[0], False)

    # ── 坑 99：标识符拼法要互相印证（以多数拼法为准）────────────────────────
    # 造一份"OCR 把 username 认成 usertname / HttpServletRequest 认成 HitpServletRequest"的材料
    ocr_material = (
        "在请求对象中设置了一个名称为 usertname、值为 li 的属性。"          # ← 少数拼法（引文用的是它）
        + " username 出现很多次。" * 15
        + " 转发给 HttpServletRequest 对象。" * 11
        + " 会产生新的 HitpServletRequest 对象。"                           # ← 少数拼法
        + " ServletA 转发给 ServletB。" * 5
        + " ResponseServlet01 与 ResponseServlet02 各是一个类。"
    )

    def _sq(stem, opts, ans, quote):
        return {"type": "single", "stem": stem, "answer": [ans], "options": opts,
                "source": {"heading": "h", "quote": quote}}

    sp = check_identifier_spelling(
        _sq("第14行代码设置了什么属性？",
            [{"key": "A", "text": "名称为 username、值为 lisi 的属性"}, {"key": "B", "text": "别的东西"}],
            "A", "第14行代码在请求对象中设置了一个名称为 usertname、值为 li 的属性"),
        ocr_material)
    eq("★ 引文是 OCR 少数拼法、答案是多数拼法 → 标出来（学生点开出处会对不上）",
       len(sp), 1)
    eq("★ 两种拼法都要写在提示里（人得知道改成什么）",
       ("usertname" in sp[0]) and ("username" in sp[0]), True)

    sp2 = check_identifier_spelling(
        _sq("会产生什么对象？",
            [{"key": "A", "text": "新的 HitpServletRequest 对象"}, {"key": "B", "text": "别的东西"}],
            "A", "会产生新的 HitpServletRequest 对象"),
        ocr_material)
    eq("★ 答案抄了 OCR 错字（少数拼法）→ 更要标（这条是「标准答案错」）",
       ("HttpServletRequest" in sp2[0]) and ("HitpServletRequest" in sp2[0]), True)

    sp3 = check_identifier_spelling(
        _sq("会产生什么对象？",
            [{"key": "A", "text": "新的 HttpServletRequest 对象"}, {"key": "B", "text": "别的东西"}],
            "A", "会产生新的 HitpServletRequest 对象"),
        ocr_material)
    eq("★ 引文是**混合大小写**的 OCR 错拼 → 也要标（第一版拿小写 token 比没小写的引文，漏了这条）",
       len(sp3), 1)

    # ⚠️ 这两条是**在真实干净语料上量出来的误报**（283 道 Vue 题报了 16 条，全是这类）：
    #    英文单复数/词形变化只差一个字符，但它们是两个正常的词，不是 OCR 错拼。
    plural_material = (
        "Component 出现 9 次。" * 9 + " Components 出现 4 次。" * 4
        + " getter 出现 4 次。" * 4 + " setter 出现 5 次。" * 5
    )
    eq("★ 单复数不算错拼（components/component → 不报）",
       check_identifier_spelling(
           _sq("注册组件用什么选项？",
               [{"key": "A", "text": "用 components 选项注册它"}, {"key": "B", "text": "别的"}],
               "A", "Component 出现 9 次。"), plural_material), [])
    eq("★ 两个正常近形词势均力敌时不算错拼（getter/setter → 不报）",
       check_identifier_spelling(
           _sq("计算属性的取值函数？",
               [{"key": "A", "text": "getter 里不应改原数组"}, {"key": "B", "text": "别的"}],
               "A", "getter 出现 4 次。"), plural_material), [])
    eq("★ 真要报的时候还得报（错拼 1 次 vs 正确 10 次）",
       len(check_identifier_spelling(
           _sq("哪个属性？",
               [{"key": "A", "text": "username 属性"}, {"key": "B", "text": "别的"}],
               "A", "usertname 出现 1 次。"),
           "username 出现 10 次。" * 10 + " usertname 出现 1 次。")), 1)

    eq("★ 只差一个数字的标识符不算错拼（Servlet01/Servlet02 是两样东西）",
       check_identifier_spelling(
           _sq("哪个类？",
               [{"key": "A", "text": "ResponseServlet01 类"}, {"key": "B", "text": "别的"}],
               "A", "ResponseServlet01 与 ResponseServlet02 各是一个类。"),
           ocr_material), [])
    eq("★ 短标识符不参与（req/resp 差两个字符就是两样东西）",
       check_identifier_spelling(
           _sq("用哪个对象？",
               [{"key": "A", "text": "req 对象"}, {"key": "B", "text": "resp 对象"}],
               "A", "req 对象"),
           "resp 出现很多次。" * 9 + " req 对象"), [])

    # ── 文档模型源（扫描件那条路，见「第十批/第十一批」）──────────────────
    # 夹具照真实模型的形状：一条跑马灯页脚（章名来源）、一个代码块、一段被 OCR
    # 硬换行切开的英文（接回去时**不能**粘成一个词）、一张列关系已丢的表。
    model = {
        "book": "Java Web 程序设计任务教程 (第3版)",
        "pages": [
            {
                "page": 1,
                "blocks": [
                    {"kind": "para", "id": "b1", "level": 0, "section": "3.6.1 请求转发",
                     "lines": [{"text": "请求转发是服务器内部的一种"}, {"text": "资源跳转方式。"}]},
                    {"kind": "para", "id": "b7", "level": 0,
                     "lines": [{"text": "Servlet 由容器管理；"}, {"text": "Servlet 的生命周期由容器控制。"}]},
                    {"kind": "code", "id": "b2", "caption": "文件 3-15", "text": "resp.getWriter();",
                     "lines": [{"text": "resp.getWriter();"}]},
                    {"kind": "table", "id": "b3", "caption": "表 3-13",
                     "lines": [{"text": "getWriter 返回一个 PrintWriter"}]},
                    {"kind": "figure", "id": "b4", "caption": "图 3-17",
                     "lines": [{"text": "Cache-Control: no-cache"}]},
                    {"kind": "heading", "id": "b5", "level": 3, "text": "3.6.1 请求转发", "lines": []},
                    {"kind": "para", "id": "b6", "level": 0,
                     "lines": [{"text": "the quick brown"}, {"text": "fox jumps"}]},
                ],
                "dropped": [{"kind": "running-head", "text": "第3章 Servlet 113"}],
            }
        ],
        "sections": [],
        "stats": {"pages": 1, "blocks": 6},
        "review": [],
        "version": 1,
    }
    md, book = model_to_markdown(model)
    eq("模型源：书名进 H1", md.splitlines()[0], "# Java Web 程序设计任务教程 (第3版)")
    eq("模型源：章名从**被剔除的页脚**里捞（去掉行尾页码）", "## 第3章 Servlet" in md, True)
    # ★ 反面用例：全量模型真把页脚认成 `第3原 Sosa 113`（章→原、Servlet→Sosa）。
    #   照抄的话章名就成了 `第3原 Sosa`，还会多切出一个名字是垃圾的单元。
    #   判据是"尾巴那个词在全书出现过没有" —— `Sosa` 没出现过 → 只留 `第3章`。
    eq("模型源：认花的章名只留 `第X章`", _clean_chapter("第3原 Sosa 113", _model_text(model)), "第3章")
    eq("模型源：尾巴是纯汉字就保留", _clean_chapter("第3章 请求转发 113", _model_text(model)), "第3章 请求转发")
    eq("模型源：小节变 `###`（= 单元边界）", "### 3.6.1 请求转发" in md, True)
    eq("模型源：代码清单进围栏块", "```java" in md and "resp.getWriter();" in md, True)
    eq("模型源：中文硬换行接回时**不加空格**", "请求转发是服务器内部的一种资源跳转方式。" in md, True)
    eq("模型源：英文硬换行接回时**要加空格**（否则 thequickbrown）", "the quick brown fox jumps" in md, True)
    eq("模型源：表/图都写明了列关系丢失、别当正文", ("列关系已丢" in md) and ("不是正文" in md), True)
    src_model = Source("docmodel", [(f"{book}.md", md)], book, "", "")
    mu, _ = build_units(src_model)
    eq("模型源：切出单元", len(mu) >= 1, True)
    probe = "请求转发是服务器内部的一种资源跳转方式。"
    eq("模型源：单元里的引用能被逐字校验", check_citation({"source": {"quote": probe}}, render_text(mu[0]))[0], True)

    print(f"  自检：{ok} 项通过", end="")
    if fails:
        print(f"，{len(fails)} 项失败")
        for f in fails:
            print(f"    ✗ {f}")
        return 1
    print("（解析器 / 出处校验 / 结构校验 / 去重）")
    return 0


# ══════════════════════════════════════════════════════════════════════
# 七、主流程
# ══════════════════════════════════════════════════════════════════════


def build_units(source: Source, max_chars: int = MAX_UNIT_CHARS) -> tuple[list[Unit], list[Unit]]:
    """
    @returns (可出题的单元, 切出来的全部单元)

    为什么要返回两份：**切分对账必须拿"全部单元"去比**。
    只拿过滤后的比，会把"这一节没有教学点、被主动跳过"（正常）
    误报成"被围栏吞掉了"（真 bug）—— 我第一次跑对账就被自己误报了三处。
    """
    usable: list[Unit] = []
    allu: list[Unit] = []
    for name, text in source.files:
        blocks = parse_markdown(text)
        for u in split_units(blocks, name, source.url_base, source.url_ext, max_chars):
            if not u.points:
                u.points = extract_points(u)
            if not u.tags:
                u.tags = collect_tags(u)
            if not render_text(u).strip():
                continue
            allu.append(u)
            if u.points:
                usable.append(u)
    return usable, allu


def clean_for_compare(raw: str) -> str:
    """对账用的标题归一化：剥锚点、脚注、markdown 记号，两边比的是"同一个标题"这件事"""
    text, _ = parse_heading(raw)
    return re.sub(r"[`*_\\]", "", text).strip()


def audit_units(source: Source, units: list[Unit]) -> list[str]:
    """
    切分对账：**拿原始 markdown 的 `##` 数量去核对切出来的单元数**。

    这是被"围栏奇偶翻转吞掉整篇文档"咬过之后加的。那个 bug 的症状是
    「文件里有 5 个 `##`，只切出 1 个单元」—— 光看产物完全看不出来（单元看起来很正常，
    只是内容多了一大坨）。所以必须拿源文件对一次账，**切少了就大声报出来**。
    """
    by_file: dict[str, list[Unit]] = {}
    for u in units:
        by_file.setdefault(u.file, []).append(u)

    warns: list[str] = []
    for name, text in source.files:
        _, body = strip_frontmatter(text)
        raw = [clean_for_compare(h) for h in re.findall(r"^##\s+(.+?)\s*$", body, re.M)]
        mine = by_file.get(name, [])
        got = {clean_for_compare(u.chapter) for u in mine} | {clean_for_compare(u.heading) for u in mine}
        missing = [h for h in raw if h not in got]
        if missing:
            warns.append(
                f"{name}：源文件有 {len(raw)} 个 `##`，其中 {len(missing)} 个没成为单元"
                f"（{'、'.join(missing[:3])}…）—— 八成是被没配对的围栏吞了"
            )
    return warns


def llm_label(res: dict) -> str:
    """
    这次出题**用的是哪条链**（本机小模型 / 云端），以及一共调了几次。

    为什么值得记下来：第一轮实测里丢掉的题几乎都是"引用原文抄不出来"，
    而"逐字抄一小段"恰恰是小模型做不了的事。记下来源，"该不该让本机掺和精确任务"
    这个问题就有数据可依，而不是凭印象争论。

    后端返回的形状（service.py 的 _SourceTrace.as_dict）：
        {used: cloud|local|explicit|none, degraded, escalated, reason, rounds: <次数>}
    注意 rounds 是**次数**不是数组 —— 第一版按数组写，直接 TypeError。
    """
    info = res.get("llmSource") or {}
    used = str(info.get("used") or "")
    if not used or used == "none":
        return ""
    label = {"cloud": "云端", "local": "本机", "explicit": "指定端点"}.get(used, used)
    n = info.get("rounds")
    if isinstance(n, int) and n > 0:
        label += f"×{n}"
    if info.get("escalated"):
        label += "（有升级）"
    if info.get("degraded"):
        label += "（有降级）"
    return label


def judge_question(q: dict, unit: Unit, material: str, llm: str = "") -> dict:
    """
    对一道模型产出的题跑完全部确定性自检，返回审阅记录。

    抽成独立函数是为了 `--recheck`：**调提示词 / 调判据时不必重新花钱出题**，
    拿存下来的模型原始输出重跑一遍就行（判据是会反复调的，出题不该跟着反复花钱）。
    """
    issues: list[str] = []
    cit_ok, cit_msg = check_citation(q, material)
    if not cit_ok:
        issues.append(cit_msg)
    st_ok, st_msg = check_structure(q)
    if not st_ok:
        issues.append(st_msg)
    gr_ok, gr_msg = check_answer_grounded(q, material)
    if not gr_ok:
        issues.append(gr_msg)
    # 坑 99：标识符拼法要**互相印证**（同一标识符以多数拼法为准）——
    # 单看置信度会拿 OCR 认错的词当标准答案，也会让引文和答案互相打架。
    issues.extend(check_identifier_spelling(q, material))

    hard_fail = (not cit_ok) or (not st_ok)
    src = citation_of(q)
    return {
        "unit": unit.id,
        "unit_heading": unit.heading,
        "llm": llm,
        "stem": str(q.get("stem") or ""),
        "type": q.get("type"),
        "options": q.get("options") or [],
        "answer": [str(k) for k in (q.get("answer") or [])],
        "analysis": str(q.get("analysis") or ""),
        "source": {
            "url": unit.url,
            "heading": str(src.get("heading") or unit.heading),
            "quote": str(src.get("quote") or ""),
        },
        "issues": issues,
        "status": "dropped" if hard_fail else ("flagged" if issues else "kept"),
    }


def run_questions(
    source: Source, units: list[Unit], out: Path, name: str,
    backend: Backend, count_per_unit: int, types: list[str], only: str, domain: str, sleep_s: float,
    prefer_cloud: bool | None = None,
) -> int:
    records: list[dict] = []
    counts = {"units": 0, "generated": 0}

    for unit in units:
        # `--only` 按**子串**匹配三样：文件名（原行为）、单元 id、单元标题。
        # 加后两样是为了**限量花钱**：模型源的"文件名"只有一个（整份扫描件），
        # 只按文件名筛等于没法只出一节 —— 而第一次试跑必须能只出一节。
        # ⚠️ 第一版写成 `only not in (a, b, c)` —— 那是**元组的精确相等**判断，
        #    于是 `--only 3.6.1` 一道都没匹配上、整个循环被静默跳过（实测）。
        if only and not any(only in x for x in (unit.file, unit.id, unit.heading)):
            continue
        material = render_text(unit)
        if len(material) < 200:
            continue
        counts["units"] += 1
        print(f"  · {unit.id}（{len(material)} 字符）…", end="", flush=True)
        res = backend.generate(material, count_per_unit, types, unit.doc_title, "计算机", domain, prefer_cloud)
        if not res.get("ok"):
            print(f" 失败：{res.get('error')}")
            continue
        # 出题接口的返回长这样：{ok, bank:{meta, questions}, warnings, valid, dropped, llmSource}
        # （⚠️ 不是 {ok, questions} —— 按后者写会静默拿到 0 道题，第一版就踩了）
        bank_out = res.get("bank") or {}
        questions = bank_out.get("questions") or []
        for w in (res.get("warnings") or [])[:2]:
            print(f"\n    ! 后端提示：{w}", end="")
        counts["generated"] += len(questions)
        src_label = llm_label(res)
        print(f" 生成 {len(questions)} 道" + (f"　[{src_label}]" if src_label else ""))

        for q in questions:
            # 计数（通过/存疑/丢弃）由 finish_bank 从 records 统一算 ——
            # 那里是唯一的出口，避免同一个数在两处各加一次
            records.append(judge_question(q, unit, material, src_label))
        if sleep_s:
            time.sleep(sleep_s)

    # 把模型原始产出也存下来 —— 这样调判据时用 --recheck 重跑即可，**不必再花一次 AI 调用**
    (out / f"{name}.records.json").write_text(
        json.dumps(records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    counts = finish_bank(records, {u.id: u for u in units}, source, out, name)
    print(
        f"\n  生成 {counts['generated']} 道 → 通过 {counts['kept']}、存疑 {counts['flagged']}、"
        f"丢弃 {counts['dropped']}" + (f"、去重合并 {counts['dup']}" if counts.get("dup") else "")
    )
    print(f"  题库 → {out / (name + '.bank.json')}")
    print(f"  审阅 → {out / (name + '.review.md')}")
    return 0


def finish_bank(records: list[dict], units_by_id: dict[str, Unit], source: Source, out: Path, name: str) -> dict:
    """
    审阅记录 → 题库 / 出处表 / 审阅报告。

    和 run_questions 拆开是为了 `--recheck`：判据（尤其"答案是否只在原文里成立"）
    是要反复调的，调的时候不该每次都重新出题 —— 那既慢又费钱，还会让题目质量随机漂移。
    """
    bank_questions: list[dict] = []
    sources_sidecar: dict[str, dict] = {}
    counts = {"generated": len(records), "kept": 0, "flagged": 0, "dropped": 0, "dup": 0, "dup_stem": 0}
    # ★ 先按**考点**去重（同引用 + 同答案事实），再进计数循环 ——
    #   放在计数之前，是为了让"通过/存疑/丢弃/合并"四个数加起来等于"生成"。
    #   ⚠️ 第一版把去重放在计数之后、还把 dup 加进 dropped：12 道题会报成
    #   "通过 11 + 丢弃 3 = 14 > 生成 12"，审阅报告上的数字自相矛盾。
    records, merged = dedupe_records(records)
    counts["dup"] = len(merged)
    no = 0

    for rec in records:
        if rec.get("status") == "dropped":
            counts["dropped"] += 1
            continue
        if rec.get("status") == "flagged":
            counts["flagged"] += 1
        else:
            counts["kept"] += 1

        unit = units_by_id.get(rec.get("unit") or "")
        no += 1
        qid = f"{Path(unit.file).stem if unit else 'doc'}-{no}"
        sources_sidecar[qid] = rec["source"]
        bank_questions.append(
            {
                "id": qid,
                "no": no,
                "type": rec["type"],
                "stem": rec["stem"],
                "options": rec["options"],
                "answer": rec["answer"],
                # 出处进 analysis：**给人读**（点不动，但一眼能看到依据是哪句）
                "analysis": (rec["analysis"] + f"\n\n出处：{rec['source']['heading']} {rec['source']['url']}").strip(),
                # ★ 结构化出处：前端 core/normalize.js 会保留它，
                #   题目卡上就有了一个**能点回原文**的按钮 —— 这是"AI 出的题可不可信"
                #   唯一能给用户的硬保证（点开自己核对，而不是只能信解析）
                "source": {
                    "url": rec["source"]["url"],
                    # 出处标题也洗一下：`3.6.2 “重定向` 这种带引号噪声的会显示在题目卡上
                    "heading": _clean_label(rec["source"]["heading"]),
                    "quote": rec["source"]["quote"],
                },
                # ★ 章节要洗：它是"你哪一节最弱"那条统计的分桶键（见 _clean_label 的说明）
                "chapter": _clean_label((unit.chapter or unit.heading) if unit else rec.get("unit_heading") or ""),
                "tags": ((unit.tags or [])[:6]) if unit else [],
            }
        )

    bank_questions, stem_dup = dedupe_questions(bank_questions)
    counts["dup_stem"] = stem_dup
    counts["dup"] += stem_dup

    bank = {
        "meta": {
            "id": name,
            "title": f"{source.label} · 教学题库",
            "subject": "计算机",
            # description 会显示在题库卡片上 —— 所以**署名和要求的三件事都放这儿**
            "description": (
                f"{source.attribution or source.label}。"
                f"许可：{source.license or '见上游许可'}；"
                "已修改：由 AI 依据原文编译成题目并引用原文短片段，题目与解析为衍生内容。"
                "每题都带原文出处，可点回原文核对。"
            ),
            "source": source.label,
            "license": source.license or "见上游文档许可",
            "attribution": source.attribution,
            "modified": "是（AI 编译为题目 + 引用原文片段）",
            "total": len(bank_questions),
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        },
        "questions": bank_questions,
    }
    write_bank(bank, out / f"{name}.bank.json")
    (out / f"{name}.sources.json").write_text(
        json.dumps(sources_sidecar, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    write_review(records, source, out / f"{name}.review.md", counts, merged)
    return counts


def recheck(out: Path, name: str, license_: str = "", attribution: str = "") -> int:
    """
    拿存下来的模型原始产出**只重跑确定性判据**（不联网、不花钱）。

    ⚠️ 许可/署名要**从上次的产物里继承**（或由命令行给）：
    重跑判据不该把 CC BY 要求的署名弄丢。第一版就是 Source("recheck", ...) 一片空白，
    重建出来的题库 meta 变成"许可：见上游文档许可" —— 署名没了。
    """
    records_path = out / f"{name}.records.json"
    units_path = out / f"{name}.units.json"
    if not records_path.exists() or not units_path.exists():
        print(f"缺少 {records_path.name} 或 {units_path.name} —— 先跑一次 --stage questions")
        return 2

    # 许可/署名的来源，按可信度：命令行 > 上次的题库 meta
    prev_meta: dict = {}
    bank_path = out / f"{name}.bank.json"
    if bank_path.exists():
        try:
            prev_meta = (json.loads(bank_path.read_text(encoding="utf-8")) or {}).get("meta") or {}
        except Exception:  # noqa: BLE001
            prev_meta = {}

    records = json.loads(records_path.read_text(encoding="utf-8"))
    raw_units = json.loads(units_path.read_text(encoding="utf-8"))
    units_by_id: dict[str, Unit] = {}
    material_by_id: dict[str, str] = {}
    for item in raw_units:
        u = Unit(
            id=item["id"], file=item["file"], doc_title=item.get("doc_title", ""),
            heading=item["heading"], level=item.get("level", 2), slug=item.get("slug", ""),
            url=item["url"], chapter=item.get("chapter", ""), tags=item.get("tags") or [],
        )
        units_by_id[u.id] = u
        material_by_id[u.id] = item.get("material") or ""

    fresh: list[dict] = []
    for rec in records:
        unit = units_by_id.get(rec.get("unit") or "")
        material = material_by_id.get(rec.get("unit") or "", "")
        if unit is None or not material:
            fresh.append(rec)  # 单元对不上（换了切分规则）→ 原样留着，别把它悄悄丢掉
            continue
        # 记录里已经带了出处（含 quote），重建成"模型产出"的形状再判一次
        q = {
            "stem": rec["stem"], "type": rec["type"], "options": rec["options"],
            "answer": rec["answer"], "analysis": rec["analysis"],
            "source": {"heading": rec["source"].get("heading", ""), "quote": rec["source"].get("quote", "")},
        }
        fresh.append(judge_question(q, unit, material, rec.get("llm", "")))

    records_path.write_text(json.dumps(fresh, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    src = Source(
        "recheck", [], name, "", "",
        license=license_ or str(prev_meta.get("license") or ""),
        attribution=attribution or str(prev_meta.get("attribution") or ""),
    )
    counts = finish_bank(fresh, units_by_id, src, out, name)
    print(
        f"  重判 {counts['generated']} 道 → 通过 {counts['kept']}、存疑 {counts['flagged']}、"
        f"丢弃 {counts['dropped']}" + (f"、去重合并 {counts['dup']}" if counts.get("dup") else "")
    )
    print(f"  审阅 → {out / (name + '.review.md')}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="把官方文档编译成题库（确定性优先、AI 兜底）")
    ap.add_argument("--source", default="", help="github:owner/repo@ref:子路径  或  dir:/本地/目录")
    ap.add_argument("--name", default="docs", help="产物名（也当题库 id）")
    ap.add_argument("--out-dir", default=".tmp/docs-bank")
    ap.add_argument("--stage", default="units", choices=["units", "questions", "all"])
    ap.add_argument("--only", default="", help="只跑文件名含这个子串的单元（出题阶段限流/试跑用）")
    ap.add_argument("--count-per-unit", type=int, default=4, help="每个单元出几道（本地小模型建议 2~4）")
    ap.add_argument("--types", default="single,multiple,judge")
    ap.add_argument("--domain", default="docs", help="后端提示词包（docs = 官方文档：强制带出处）")
    ap.add_argument("--api", default="http://127.0.0.1:8000/api/quiz/", help="后端 API 根地址")
    ap.add_argument("--url-base", default="", help="dir 源用：原文的网址前缀")
    ap.add_argument("--url-ext", default=".html")
    ap.add_argument("--license", default="", help="覆盖源里的许可（dir: 源不知道许可时用；不传则用源自带的）")
    ap.add_argument("--attribution", default="", help="覆盖/补充署名（CC BY 这类许可**要求署名**）")
    ap.add_argument("--sleep", type=float, default=0.5, help="每次调用之间歇一下（别把限流撞爆）")
    ap.add_argument("--max-unit-chars", type=int, default=MAX_UNIT_CHARS,
                    help="单元材料超过这个体量就再切一层（单元粒度 = 出题粒度 = 校验粒度）")
    ap.add_argument("--refresh", action="store_true", help="忽略缓存重新下载")
    ap.add_argument("--prefer-cloud", dest="prefer_cloud", default=None, action=argparse.BooleanOptionalAction,
                    help="云端先上。不传＝跟随后端默认（docs 领域默认就是云端优先）；--no-prefer-cloud 允许本机先上")
    ap.add_argument("--recheck", action="store_true",
                    help="拿上次存的模型产出**只重跑判据**（不联网、不花钱；调判据时用这个）")
    ap.add_argument("--selftest", action="store_true", help="只跑离线自检（不联网、不花钱）")
    args = ap.parse_args(argv)

    if args.selftest:
        print("▶ 解析器 / 校验器 自检")
        return selftest()

    if args.recheck:
        print(f"▶ 重跑判据：{args.name}")
        return recheck(Path(args.out_dir), args.name, args.license, args.attribution)

    if not args.source:
        ap.error("要么 --selftest，要么给 --source")

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    cache_root = Path(".tmp/docs-cache")

    if args.source.startswith("dir:"):
        src = load_dir(Path(args.source[4:]), args.url_base or "https://example.com", args.url_ext)
    elif args.source.startswith("github:"):
        src = load_github(args.source[len("github:") :], cache_root, refresh=args.refresh)
    elif args.source.startswith("model:"):
        # 扫描件那条路：文档模型（core/docmodel.js 的产物）→ 伪 markdown → 单元 → 出题
        src = load_docmodel(Path(args.source[len("model:") :]), args.url_base, args.url_ext)
    else:
        ap.error("--source 只认 github: / dir: / model:（model: 是扫描件的文档模型）")
        return 2
    # ⚠️ 用 `or`：不传就保留源自带的许可。写成 `src.license = args.license` 会把
    # GitHub 源查好的 CC BY 4.0 冲成空串（第一版就是这么把署名弄丢的）
    src.license = args.license or src.license
    src.attribution = args.attribution or src.attribution

    print(f"▶ 取源：{src.label}（{len(src.files)} 个 markdown）")
    units, all_units = build_units(src, args.max_unit_chars)
    if src.kind == "docmodel":
        # 扫描件是私有的：清掉"原文链接"，否则题目卡上会出现一个点不开的死链
        # （出处那句话仍然保留 —— 它指向的是教材原文，只是没有网址可点）
        for u in all_units:
            u.url = ""
    skipped = len(all_units) - len(units)
    print(
        f"▶ 切单元：{len(all_units)} 个 → 可出题 {len(units)} 个"
        f"（{skipped} 个没有教学点，已跳过）；教学点 {sum(len(u.points) for u in units)} 个"
    )

    warns = audit_units(src, all_units)
    if warns:
        print(f"⚠️ 切分对账发现 {len(warns)} 处对不上（先修这个，否则后面出题全是歪的）：")
        for w in warns:
            print(f"   · {w}")
    else:
        print("✓ 切分对账：源文件里的每个 `##` 都切成了单元")

    (out / f"{args.name}.units.json").write_text(
        json.dumps([{**asdict(u), "material": render_text(u)} for u in units], ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    write_units_report(units, src, out / f"{args.name}.units.md")
    print(f"  单元 → {out / (args.name + '.units.json')}")
    print(f"  索引 → {out / (args.name + '.units.md')}")

    if args.stage in ("questions", "all"):
        types = [t.strip() for t in args.types.split(",") if t.strip()]
        backend = Backend(args.api)
        print(f"▶ 出题：domain={args.domain}，每单元 {args.count_per_unit} 道")
        return run_questions(
            src, units, out, args.name, backend, args.count_per_unit, types, args.only,
            args.domain, args.sleep, args.prefer_cloud,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
