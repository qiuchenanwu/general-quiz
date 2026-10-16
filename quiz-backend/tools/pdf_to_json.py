#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pdf_to_json.py —— 把「选择题 / 判断题」题库 PDF 确定性地转成刷题网站能直接吃的 JSON。

设计目标
--------
1. **不依赖 AI**：对排版规整的题库 PDF（题干 + A/B/C/D 选项 + 答案：X）用状态机解析，
   结果可复现、可校验；AI 只用来兜底那些排版烂到无法规则化的 PDF。
2. **输出统一**：无论单选 / 多选 / 判断，出来都是同一套 schema，
   前端只有一条渲染代码路径（判断题也会被补上 T/F 两个选项）。
3. **会自检**：解析完打印覆盖率报告 —— 题号连续吗？每题都有答案吗？
   多选题答案里有不存在的选项吗？有异常就退出码非 0。

用法
----
    python tools/pdf_to_json.py 题库.pdf -o frontend/src/banks/bank.json \
        --id maogai --title "毛泽东思想和中国特色社会主义理论体系概论题库"

    # 只看解析报告，不写文件
    python tools/pdf_to_json.py 题库.pdf --dry-run

依赖：PyMuPDF (pip install pymupdf)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

def _fitz():
    """按需导入 PyMuPDF。

    故意不在模块顶层 import：Q8B 板子上没装 pymupdf（那边 PDF 文字是浏览器用
    pdf.js 抽好再传来的），但后端仍要复用这个模块里的**解析规则**。
    顶层 import 会让板子一 import 就退出，规则就没法共享了。
    """
    try:
        import fitz  # noqa: PLC0415 - 故意延迟导入
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "需要 PyMuPDF 才能直接从 PDF 抽文字（pip install pymupdf）；"
            "只做规则解析的话不需要它。"
        ) from exc
    return fitz


# --------------------------------------------------------------------------
# 1. 正则：识别「题号 / 选项 / 答案 / 章节标题」
# --------------------------------------------------------------------------

# 题号：  "12、"  "12."  "12）"  "第12题"  也容忍题号前有 "1." 之类的脏数据 (如 "210、1.关于...")
RE_QUESTION = re.compile(r"^\s*(\d{1,4})\s*[、.．)）]\s*(.*)$")

# 选项：  "A、"  "A."  "A）"  "Ａ、"  容忍选项后面直接跟文字
RE_OPTION = re.compile(r"^\s*([A-Ha-hＡ-Ｈ])\s*[、.．:：)）]\s*(.*)$")

# 答案：  "答案： A"  "答案:A"  "【答案】A"  "正确答案：AB"  "参考答案：正确"
RE_ANSWER = re.compile(r"^\s*(?:正确)?(?:参考)?答案\s*[】\]：:]*\s*[（(]?\s*(.*)$")

# 章节标题： "第一章 xxx"  "一、单选题"  "绪论"  "第1章"
RE_CHAPTER = re.compile(r"^\s*(第\s*[一二三四五六七八九十百零\d]+\s*[章节讲部分]|绪\s*论|导\s*论)\s*[、.．:：]?\s*(.*)$")
RE_SECTION = re.compile(r"^\s*[一二三四五六七八九十]+\s*[、.．]\s*(单项选择题|多项选择题|多选题|单选题|判断题|填空题|简答题|论述题|选择题)\s*$")

# 判断题的答案词 → 布尔
TRUE_WORDS = {"正确", "对", "是", "√", "T", "True", "true", "Y", "yes"}
FALSE_WORDS = {"错误", "错", "否", "×", "x", "X", "F", "False", "false", "N", "no"}

# 一页里重复出现的页眉/页脚（例如书名），解析时丢掉
PAGE_NOISE = re.compile(r"^\s*(?:第\s*\d+\s*页|\d+\s*/\s*\d+|-?\s*\d+\s*-?)\s*$")


# --------------------------------------------------------------------------
# 2. 文本抽取 + 清洗
# --------------------------------------------------------------------------

def looks_like_content(s: str) -> bool:
    """这行看起来是「题干 / 选项 / 答案」吗？

    这个判断是页眉页脚识别的安全阀：像 "答案： A"（全卷出现 21 次）、
    "A、 农民" 这种行会大量重复，但它们是正文，绝对不能当页眉删掉。
    """
    return bool(
        RE_QUESTION.match(s) or RE_OPTION.match(s) or RE_ANSWER.match(s)
    )


def lines_from_pages(raw_pages: list[list[str]]) -> list[str]:
    """把「一页一个字符串列表」整理成逻辑行列表：去页眉页脚、丢空行。

    抽离出来是为了让**不止 PyMuPDF** 能复用这套规则 ——
    网页端用 pdf.js 抽出来的文字也走同一条路（见 quizgen 应用），
    这样解析规则只有一份实现，不会两边跑偏。
    """
    pages = [[ln.strip() for ln in page] for page in raw_pages]

    # 真正的页眉页脚：短、且**在大多数页面上都出现**（书名、页码、页脚线）。
    # 只按出现次数判断会把 "答案： A" 这类高频正文误杀，所以必须同时满足
    # 「跨页数够多」+「不像正文」两个条件。
    pages_of: dict[str, set[int]] = {}
    for i, lines in enumerate(pages):
        for s in lines:
            if s and len(s) < 40:
                pages_of.setdefault(s, set()).add(i)
    threshold = max(3, int(len(pages) * 0.5))
    noise = {
        s for s, seen in pages_of.items()
        if len(seen) >= threshold and not looks_like_content(s)
    }

    out: list[str] = []
    for lines in pages:
        for s in lines:
            if not s:
                continue
            if s in noise or PAGE_NOISE.match(s):
                continue
            out.append(s)
    return out


def extract_lines(pdf_path: Path) -> list[str]:
    """把 PDF 抽成「逻辑行」列表（PyMuPDF 版）。"""
    fitz = _fitz()
    doc = fitz.open(pdf_path)
    raw_pages: list[list[str]] = []
    for page in doc:
        # sort=True 让文字块按阅读顺序输出，避免多栏时错行
        text = page.get_text("text", sort=True)
        raw_pages.append(text.splitlines())
    doc.close()
    return lines_from_pages(raw_pages)


def is_cjk(ch: str) -> bool:
    """中日韩文字、全角标点、CJK 符号：这些字符之间不该有空格。"""
    o = ord(ch)
    return (
        0x4E00 <= o <= 0x9FFF      # 汉字
        or 0x3000 <= o <= 0x303F   # 、。《》「」
        or 0xFF00 <= o <= 0xFFEF   # 全角 ，：；（）？！
        or 0x2000 <= o <= 0x206F   # 通用标点
    )


def tidy(text: str) -> str:
    """把断行拼接后的文字收拾干净。

    PDF 两端对齐会往汉字之间塞空格（"， 是"），这里删掉；
    但保留 ASCII 之间的空格，避免把英文单词粘死。
    """
    text = text.replace("\u3000", " ")
    text = re.sub(r"[ \t]+", " ", text)
    # 删掉「非 ASCII 字符 ↔ 非 ASCII 字符」之间的空格
    prev = None
    while prev != text:
        prev = text
        text = re.sub(r"(?<=[^\x00-\x7F]) (?=[^\x00-\x7F])", "", text)
    # 括号里的填空占位统一成 "(  )"，避免出现 "(     )" 这种超长空白
    text = re.sub(r"[(（]\s*[)）]", "(  )", text)
    return text.strip()


# --------------------------------------------------------------------------
# 3. 状态机解析
# --------------------------------------------------------------------------

class Q:
    __slots__ = ("no", "stem", "options", "answer_raw", "chapter")

    def __init__(self, no: int, chapter: str | None):
        self.no = no
        self.stem = ""
        self.options: list[tuple[str, str]] = []
        self.answer_raw = ""
        self.chapter = chapter


def parse_questions(lines: list[str]) -> tuple[list[Q], list[str]]:
    """状态机：题干 → 选项* → 答案，遇到新题号就收题。"""
    questions: list[Q] = []
    warnings: list[str] = []
    cur: Q | None = None
    chapter: str | None = None
    # 当前正在累积的字段：'stem' | 'answer' | 选项索引
    target: object = None

    def flush() -> None:
        nonlocal cur
        if cur is not None:
            if not cur.stem:
                warnings.append(f"第 {cur.no} 题没有题干，已丢弃")
            else:
                questions.append(cur)
        cur = None

    # 用来判断 "210、1.关于以人为本" 这种题号里混了小序号的情况
    for raw in lines:
        line = raw.strip()
        if not line:
            continue

        # 章节 / 题型小标题：只更新 chapter 上下文，不入题干
        m_ch = RE_CHAPTER.match(line)
        if m_ch and len(line) <= 40:
            title = tidy(line)
            # "一、单选题" 这种不算章节，直接跳过
            if not RE_SECTION.match(line):
                chapter = title
            continue
        if RE_SECTION.match(line):
            continue

        m_q = RE_QUESTION.match(line)
        m_opt = RE_OPTION.match(line)
        m_ans = RE_ANSWER.match(line)

        # --- 题号：只有当它不是选项内容时才当新题 ---
        if m_q and not (m_opt and m_opt.group(1).isalpha()):
            no = int(m_q.group(1))
            rest = m_q.group(2)
            # 丢掉题号后紧跟的 "1." / "1、" 之类的内层编号
            rest = re.sub(r"^\d{1,2}\s*[、.．]\s*", "", rest)
            flush()
            cur = Q(no, chapter)
            cur.stem = rest
            target = "stem"
            continue

        if cur is None:
            # 答案出现前没有题目 → 典型的孤立的 "答案：" 行，忽略
            continue

        if m_ans:
            cur.answer_raw = m_ans.group(1)
            target = "answer"
            continue

        if m_opt and not m_ans:
            key = m_opt.group(1).upper()
            # 全角 A → 半角
            if "Ａ" <= key <= "Ｈ":
                key = chr(ord(key) - 0xFEE0)
            cur.options.append((key, m_opt.group(2)))
            target = len(cur.options) - 1
            continue

        # --- 续行：接到当前字段后面 ---
        if target == "answer":
            cur.answer_raw += line
        elif isinstance(target, int):
            k, t = cur.options[target]
            cur.options[target] = (k, t + line)
        else:
            cur.stem += line

    flush()
    return questions, warnings


# --------------------------------------------------------------------------
# 4. 归一化：把各种脏答案变成统一的 type + options + answer
# --------------------------------------------------------------------------

RE_LETTERS = re.compile(r"[A-Ha-h]")


def normalize(q: Q) -> dict | None:
    """返回前端 schema 里的 question 对象；无法修复则返回 None。"""
    stem = tidy(q.stem)
    opts = [(k, tidy(v)) for k, v in q.options]
    # 选项去重（有的 PDF 会把同一选项印两遍）
    seen: set[str] = set()
    uniq: list[tuple[str, str]] = []
    for k, v in opts:
        if k in seen:
            continue
        seen.add(k)
        uniq.append((k, v))
    opts = uniq

    ans_raw = tidy(q.answer_raw)

    # ---- 判断题：没有选项，答案是对/错 ----
    if not opts:
        compact = ans_raw.replace(" ", "")
        if compact in TRUE_WORDS or any(compact.startswith(w) for w in ("正确", "对")):
            letters = ["T"]
        elif compact in FALSE_WORDS or compact.startswith("错"):
            letters = ["F"]
        else:
            return None  # 填空题 / 简答题 / 解析失败 —— 交给 AI 兜底
        return {
            "no": q.no,
            "type": "judge",
            "stem": stem,
            "options": [
                {"key": "T", "text": "正确"},
                {"key": "F", "text": "错误"},
            ],
            "answer": letters,
        }

    # ---- 选择题：从答案里抠出字母 ----
    letters = [c.upper() for c in RE_LETTERS.findall(ans_raw)]
    # 支持 "答案：3" 这种用序号回答的（1=A, 2=B ...）
    if not letters and ans_raw.strip().isdigit():
        idx = int(ans_raw.strip())
        if 1 <= idx <= len(opts):
            letters = [opts[idx - 1][0]]
    # 已经有选项、但答案里抠不出字母时：试试「答案文本正好等于某个选项的文本」。
    # 小模型（实测 qwen2.5:1.5b）很爱把判断题写成
    #     options=[{A:正确},{B:错误}]  answer="正确"
    # 这种情况原来会被整题丢掉 —— 明明信息是全的，只是没写成 T/F。
    if not letters and ans_raw:
        compact = ans_raw.replace(" ", "").replace("　", "")
        for key, text in opts:
            if text.replace(" ", "").replace("　", "") == compact:
                letters = [key]
                break
    letters = sorted(set(letters), key=lambda c: [k for k, _ in opts].index(c)
                     if c in [k for k, _ in opts] else 99)
    valid = {k for k, _ in opts}
    letters = [c for c in letters if c in valid]
    if not letters:
        return None

    # 选项必须是连续的 A..N，中间断了就认为解析出错，交给 AI 兜底
    keys = [k for k, _ in opts]
    if keys != [chr(ord("A") + i) for i in range(len(keys))]:
        return None

    # ★ 只有一个选项的"选择题"不是题（没得选）。
    #   原来只校验"key 连续"，单项 `['A']` 恰好连续 → 一路活到前端才被丢掉，
    #   用户看到的是「解析出 0 道可用题目（丢弃原因：选项少于 2 个×1）」——
    #   整次导入白跑一趟（真实事故，2026-10-11）。这里就判死，交给 AI 兜底。
    #   ⚠️ 判断题在上面已经被补成 T/F 两个选项，所以这条不会误伤判断题。
    if len(keys) < 2:
        return None

    return {
        "no": q.no,
        "type": "single" if len(letters) == 1 else "multiple",
        "stem": stem,
        "options": [{"key": k, "text": v} for k, v in opts],
        "answer": letters,
    }


# --------------------------------------------------------------------------
# 5. 自动打标签（让题库不只有「顺序刷」一种玩法）
# --------------------------------------------------------------------------

TAG_RULES: list[tuple[str, list[str]]] = [
    ("马克思主义中国化", ["马克思主义中国化", "中国化时代化"]),
    ("毛泽东思想", ["毛泽东思想", "毛泽东同志", "毛泽东"]),
    ("新民主主义革命", ["新民主主义革命", "新民主主义"]),
    ("社会主义改造", ["社会主义改造", "过渡时期总路线", "三大改造"]),
    ("邓小平理论", ["邓小平理论", "邓小平", "社会主义本质", "一国两制", "市场经济"]),
    ("三个代表重要思想", ["三个代表"]),
    ("科学发展观", ["科学发展观", "以人为本", "和谐社会", "全面协调可持续"]),
    ("习近平新时代中国特色社会主义思想", ["习近平", "新时代", "中国梦", "四个全面", "五位一体"]),
    ("党的历史与会议", ["党的七大", "遵义会议", "六届六中全会", "十一届三中全会", "党的二十", "党的十九", "党的十八大", "党的一大"]),
    ("实事求是", ["实事求是", "解放思想", "与时俱进", "求真务实"]),
    ("群众路线", ["群众路线", "人民群众"]),
    ("统一战线与武装斗争", ["统一战线", "武装斗争", "武装夺取政权", "农村包围城市"]),
    ("党的建设", ["党的建设", "从严治党", "党性"]),
    ("生态文明", ["生态文明", "资源节约型", "环境友好型"]),
]


def auto_tags(item: dict) -> list[str]:
    hay = item["stem"] + "".join(o["text"] for o in item["options"])
    tags = [name for name, kws in TAG_RULES if any(k in hay for k in kws)]
    return tags


# --------------------------------------------------------------------------
# 6. 校验
# --------------------------------------------------------------------------

def validate(questions: list[dict]) -> tuple[bool, list[str]]:
    problems: list[str] = []
    nos = [q["no"] for q in questions]
    if len(set(nos)) != len(nos):
        dup = [n for n, c in Counter(nos).items() if c > 1]
        problems.append(f"题号重复：{sorted(dup)}")
    expect = list(range(1, max(nos, default=0) + 1))
    missing = sorted(set(expect) - set(nos))
    if missing:
        problems.append(f"题号缺失 {len(missing)} 个：{missing[:20]}{' ...' if len(missing) > 20 else ''}")

    for q in questions:
        keys = {o["key"] for o in q["options"]}
        bad = [a for a in q["answer"] if a not in keys]
        if bad:
            problems.append(f"第 {q['no']} 题答案 {bad} 不在选项 {sorted(keys)} 中")
        if not q["stem"]:
            problems.append(f"第 {q['no']} 题题干为空")
        if q["type"] == "multiple" and len(q["answer"]) < 2:
            problems.append(f"第 {q['no']} 题标为多选但只有 1 个答案")
        for o in q["options"]:
            if not o["text"]:
                problems.append(f"第 {q['no']} 题选项 {o['key']} 文本为空")
    return (not problems), problems


# --------------------------------------------------------------------------
# 7. CLI
# --------------------------------------------------------------------------

def build_bank_from_lines(lines: list[str], bank_id: str, title: str | None,
                          subject: str | None, source: str = "") -> tuple[dict, list[str]]:
    """从「逻辑行」列表组装题库。CLI（PyMuPDF）和网页端（pdf.js）都走这里。"""
    raw_qs, warnings = parse_questions(lines)

    questions: list[dict] = []
    dropped: list[int] = []
    for raw in raw_qs:
        item = normalize(raw)
        if item is None:
            dropped.append(raw.no)
            continue
        item["id"] = f"q{item['no']}"
        if raw.chapter:
            item["chapter"] = raw.chapter
        tags = auto_tags(item)
        if tags:
            item["tags"] = tags
        questions.append(item)

    questions.sort(key=lambda q: q["no"])

    if dropped:
        warnings.append(
            f"{len(dropped)} 题无法用规则解析（缺答案 / 选项不连续），已跳过：{dropped[:20]}"
        )

    chapters: list[str] = []
    for q in questions:
        ch = q.get("chapter")
        if ch and ch not in chapters:
            chapters.append(ch)

    counts = Counter(q["type"] for q in questions)
    tags = Counter(t for q in questions for t in q.get("tags", []))

    bank = {
        "meta": {
            "id": bank_id,
            "title": title or source or bank_id,
            "subject": subject or "",
            "version": "1.0.0",
            "source": source,
            "generatedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
            "total": len(questions),
            "counts": {
                "single": counts.get("single", 0),
                "multiple": counts.get("multiple", 0),
                "judge": counts.get("judge", 0),
            },
            "chapters": [{"id": f"c{i + 1}", "name": c} for i, c in enumerate(chapters)],
            "tags": [{"name": t, "count": c} for t, c in tags.most_common()],
        },
        "questions": questions,
    }
    return bank, warnings


def build_bank(pdf_path: Path, bank_id: str, title: str | None,
               subject: str | None) -> tuple[dict, list[str]]:
    return build_bank_from_lines(
        extract_lines(pdf_path), bank_id, title, subject, source=pdf_path.name
    )


def force_utf8_console() -> None:
    """Windows 控制台默认 GBK，打印 ✅/⚠️ 会 UnicodeEncodeError，这里兜一下。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def main() -> int:
    force_utf8_console()
    ap = argparse.ArgumentParser(description="题库 PDF → 刷题 JSON")
    ap.add_argument("pdf", type=Path, help="输入 PDF")
    ap.add_argument("-o", "--out", type=Path, default=Path("bank.json"), help="输出 JSON")
    ap.add_argument("--id", default=None, help="题库 id（默认取文件名）")
    ap.add_argument("--title", default=None, help="题库标题")
    ap.add_argument("--subject", default=None, help="科目名")
    ap.add_argument("--dry-run", action="store_true", help="只打印报告，不写文件")
    args = ap.parse_args()

    if not args.pdf.exists():
        sys.stderr.write(f"找不到文件：{args.pdf}\n")
        return 2

    bank_id = args.id or re.sub(r"[^0-9A-Za-z_-]+", "-", args.pdf.stem).strip("-").lower() or "bank"
    bank, warnings = build_bank(args.pdf, bank_id, args.title, args.subject)

    ok, problems = validate(bank["questions"])
    m = bank["meta"]

    print("=" * 68)
    print(f"题库：{m['title']}")
    print(f"来源：{m['source']}")
    print(f"题目：{m['total']} 道   （单选 {m['counts']['single']} / "
          f"多选 {m['counts']['multiple']} / 判断 {m['counts']['judge']}）")
    if m["chapters"]:
        print(f"章节：{len(m['chapters'])} 个")
    if m["tags"]:
        print("标签：" + "、".join(f"{t['name']}({t['count']})" for t in m["tags"]))
    print("-" * 68)
    for w in warnings:
        print(f"⚠️  {w}")
    if ok:
        print("✅ 校验通过：题号连续、每题都有合法答案、选项文本完整")
    else:
        print(f"❌ 校验发现 {len(problems)} 个问题：")
        for p in problems[:30]:
            print(f"   - {p}")
    print("=" * 68)

    if args.dry_run:
        return 0 if ok else 1

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(bank, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"已写入 {args.out}  ({args.out.stat().st_size / 1024:.1f} KB)")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
