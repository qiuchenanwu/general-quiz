#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
fix_java_ocr.py —— 扫描件里的**代码清单**：按类修复，然后用 **javac 当判据**
============================================================================
为什么这一步值钱（JavaWeb 相对数学的结构性优势）：
  散文 OCR 错一个字，没人看得出来；**代码 OCR 错了，编译器会喊**。
  实测用户那本《Java Web 程序设计任务教程（第3版）》9 页扫描件：
  正文近乎完美，但代码里出现了成类的错误 ——
  `resp,setHeader`（点→逗号）、`getWriterO`（()→O）、`1mport`（i→1）、
  `I= -1`、`byte[) buffer`、行号粘进代码（`1.2 @Override`）。
  数学公式没有这个福气，所以"公式是瓶颈"；**代码有，所以 JavaWeb 好办**。

怎么修：分三层，越往后越贵，能停就停
  第 1 层 **确定性 token 修复**（不需要编译）：错误是成类的，就按类替换。
        规则必须**保守** —— 改错比不改更糟，所以只做"在 Java 里原来那种写法一定非法"的替换。
  第 2 层 **javac 当判据**：拿迷你 Servlet API 一起编译，编译过了就算过关。
  第 3 层 **报出剩下的行号**：修不动的**不猜**，列成"需要你看一眼"的清单。
        ★ 这一步才是真正的产出：把"345 行不知道对不对"变成"这 3 行要你确认"。

⚠️ 为什么不做"错误驱动的自动改写"：
  javac 的报错（"找不到符号"/"';' expected"）到"该改哪个字符"之间没有可靠映射，
  硬猜会产生一串看似合理其实是编的代码 —— 那比留着错更糟（这个项目的一贯取舍：
  宁可说"这行要你看"，也不要给一个能编译但意思错了的东西）。

用法：
    .venv-ocr\\Scripts\\python.exe quiz\\tools\\fix_java_ocr.py .tmp/book.txt --pages 2 --dump .tmp/fixed/
    ... --file Some.java          # 也可以直接修一个 .java 文件
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import java_sandbox  # noqa: E402

# --------------------------------------------------------------------------
# 第 1 层：确定性 token 修复（每条规则都写明"为什么在 Java 里这么改一定是修 OCR"）
# --------------------------------------------------------------------------

#: 注解丢了 `@`：OCR 常把 `@WebServlet(...)` 认成 `WebServlet(...)`（实测就是）。
#: 判据：这两个是**注解名**，写成方法调用在 Java 里一定非法。
LOST_AT = re.compile(r"^\s*(WebServlet|WebFilter|WebListener|Override)\b")

#: `{` 被认成字母 i：`public class X extends HttpServlet i`（实测）、
#: `resp) throws ServletException, IOException i`。
#: 判据：行尾一个孤零零的 i/I，而且这一行是"该有花括号"的（class/方法签名/try/else…），
#: 且**不含赋值号** —— 避开 `x = i` 这种合法写法。
BLOCK_OPENER = re.compile(r"\b(class|interface|enum|throws|void|try|else|do|finally)\b")
TRAILING_I = re.compile(r"\s[iI1l]\s*$")
#: `{` 被认成左括号：`public class X extends HttpServlet (`（实测，清单 2/6 都是这个）。
#: 判据同上：这一行是"该有花括号"的，行尾却是个 `(`。
TRAILING_PAREN = re.compile(r"\s\(\s*$")


def repair_line_level(line: str, notes: list[str], lineno: int) -> str:
    """整行级的修复：缺 @、`{`→i、行号栏变体。"""
    # ① 缺 @
    if LOST_AT.match(line) and "@" not in line:
        line = "@" + line.lstrip()
        notes.append(f"第 {lineno} 行：注解补回 `@`（OCR 把 @ 吃掉了）")
    # ② 行尾孤立的 i 其实是 `{`
    if (
        TRAILING_I.search(line)
        and BLOCK_OPENER.search(line)
        and "=" not in line
        and "{" not in line
    ):
        line = TRAILING_I.sub(" {", line)
        notes.append(f"第 {lineno} 行：行尾的 i 其实是 `{{`（OCR 认错）")
    # ③ 行尾孤立的 `(` 其实也是 `{`（同一类错误，换个认错的字形）
    elif (
        TRAILING_PAREN.search(line)
        and BLOCK_OPENER.search(line)
        and "=" not in line
        and "{" not in line
        and line.count("(") == line.count(")") + 1
    ):
        line = TRAILING_PAREN.sub(" {", line)
        notes.append(f"第 {lineno} 行：行尾的 `(` 其实是 `{{`（OCR 认错）")
    return line


#: 行号栏的两种形态：`10 ` / `13 `（数字+空格）和 `1.2 `（书上的 12 被插了个点）。
#: ⚠️ 不能无脑删行首数字 —— `3.14` 这种字面量会被误伤。
#: 所以要求"剩下那部分看起来像代码"，且**不能以 ; 或数字开头**。
#: ⚠️ 分支顺序有讲究：`\d\.\d\s+` 必须排在 `\d{1,3}[.\s]` **前面** ——
#:   否则 `1.2 @Override` 会先被后者切成 `1.` + `2 @Override`，
#:   而剩下那段以数字开头、被守卫拒掉，结果**看着像修了其实没修**（实测踩到）。
GUTTER = re.compile(r"^\s*(?:\d\.\d\s+|\d{1,3}\s+|\d{1,3}[.\s]\s*)")


def code_ish(line: str) -> bool:
    """这行看起来像代码吗？（判定行号栏要不要剥、代码块从哪开始）"""
    t = line.strip()
    if not t:
        return False
    if GUTTER.match(line):
        return True
    if CODE_START.match(line):
        return True
    # 注解/方法调用：`WebServlet("...")`、`resp.setHeader(...)`
    # ⚠️ 少了这条，`10 WebServlet("/x")` 的行号栏就剥不掉（实测踩到）
    if re.match(r"^[A-Za-z_$][\w$.]*\s*\(", t):
        return True
    return t.endswith((";", "{", "}"))


def strip_gutter(line: str) -> tuple[str, bool]:
    m = GUTTER.match(line)
    if not m:
        return line, False
    rest = line[m.end():]
    head = rest.lstrip()[:1]
    if not head or head.isdigit() or head in ";,)":
        return line, False
    if not code_ish(rest):
        return line, False
    return rest, True

#: `import` 行：形状极其规整，可以下重手
IMPORT_HEAD = re.compile(r"^\s*(?:1|!|l)?\s*[i1lI]mport\b")

TOKEN_FIXES: tuple[tuple[re.Pattern[str], str, str], ...] = (
    # import 的拼错：i 被认成 1 / l / !
    (re.compile(r"\b[i1l!]mport\b"), "import", "import 的首字母 i 被认成 1/l/!（实测 `1mport`）"),
    # import 语句里的逗号一定是点号：`import jakarta,servlet,X;` 在 Java 里非法
    (re.compile(r"(?m)^(\s*import\s+[A-Za-z_$][\w$]*)\s*,\s*"), r"\1.", "import 路径里的 `,` 必是 `.`"),
    # `getWriterO` / `getOutputStreamO` / `printlnO` → `xxx()`
    # 判据：已知方法名 + 结尾一个大写 O（`()` 被认成一个 O），Java 里那种写法非法
    (re.compile(r"\b(getWriter|getOutputStream|getInputStream|getSession|getParameter|"
                r"getServletContext|getName|toByteArray|flush|close|print|println|size|next|"
                r"write|read|setContentType|setHeader|addHeader|setAttribute|getAttribute)\s*O\b"),
     r"\1()", "`()` 被 OCR 成一个字母 O（实测 `getWriterO`）"),
    # `I= -1` → `!= -1`（`!` 被认成大写 I）
    (re.compile(r"(?<![=!<>])\bI\s*=\s*-\s*1\b"), "!= -1", "`!=` 被认成 `I=`（实测 `I= -1`）"),
    # `byte[) buffer` → `byte[] buffer`
    (re.compile(r"\[\s*\)\s*\]"), "[]", "`[]` 被认成 `[)`（实测 `byte[) buffer`）"),
    # 方法调用里的小写 `fis、read(` → `fis.read(`：中文顿号出现在标识符之间，Java 里非法
    (re.compile(r"(?<=[\w$])\s*、\s*(?=[A-Za-z_$][\w$]*\s*\()"), ".", "标识符之间的中文顿号必是 `.`"),
    # 代码行里的全角标点
    (re.compile(r"[（]"), "(", "全角左括号"),
    (re.compile(r"[）]"), ")", "全角右括号"),
    (re.compile(r"[；]"), ";", "全角分号"),
    (re.compile(r"[：]"), ":", "全角冒号"),
    (re.compile(r"[＝]"), "=", "全角等号"),
    # 行尾的 `:` 其实是 `;`（实测 `getRealPath("/img/image.jpg") :`）。
    # 判据：Java 里语句结尾的冒号只可能出现在 case/label/三元里，那三种都不会单独结尾，
    # 所以"整行以 : 收尾且含 ( 或 ) 或 ="基本就是分号被认错了。
    (re.compile(r":\s*$"), ";", "行尾的 `:` 其实是 `;`"),
)


def repair_lines(lines: list[str]) -> tuple[list[str], list[str]]:
    """按类修一遍。返回 (修好的行, 做了哪些修的说明)。"""
    out: list[str] = []
    notes: list[str] = []
    for i, raw in enumerate(lines, start=1):
        line = raw.rstrip()
        # import 行先整行归一化（形状规整，可以下重手）
        fixed_import = fix_import_line(line)
        if fixed_import is not None:
            if fixed_import != line.strip():
                notes.append(f"第 {i} 行：import 行整行归一化（{line.strip()[:30]!r} → {fixed_import[:30]!r}）")
            out.append(fixed_import)
            continue
        # 行号栏
        line, stripped = strip_gutter(line)
        if stripped:
            notes.append(f"第 {i} 行：去掉行号栏")
        # 整行级修复（缺 @ / 行尾 i 其实是 {）
        line = repair_line_level(line, notes, i)
        # token 级替换
        for pattern, repl, why in TOKEN_FIXES:
            new = pattern.sub(repl, line)
            if new != line:
                notes.append(f"第 {i} 行：{why}")
                line = new
        out.append(line)
    return out, notes


#: `import` 行**可以下重手**：它的形状极其规整（`import a.b.C;` 只有点号和一个分号，
#: 合法语句里不可能出现逗号）。所以整行归一化，而不是零敲碎打。
IMPORT_LINE = re.compile(r"^\s*(?:\d{1,3}\s*[.\s]\s*)?(?:import|Import|[i1l!]mport)\b(.*)$")


def fix_import_line(line: str) -> str | None:
    m = IMPORT_LINE.match(line)
    if not m:
        return None
    body = m.group(1)
    body = body.split(";")[0]                      # 分号后面的是注解/注释，扔掉
    body = body.replace(",", ".").replace("，", ".").replace("。", ".")
    body = re.sub(r"[\s　]+", "", body)             # import 路径里不该有空格
    # 常见的"点被吃成冒号/顿号"也一起收
    body = body.replace(":", ".").replace("、", ".").replace("；", ".")
    return f"import {body};"


#: 修复 javac 报的"找不到符号"时，**只在闭集里挑**候选名字。
#: 闭集 = 我们提供的迷你 Servlet API + 教材常用的 JDK 类型。
#: ★ 为什么不自由生成：改错比不改更糟 —— 只从"确实存在的名字"里选，
#:   而且**必须重新编译验证**，通不过就撤回。
KNOWN_NAMES: tuple[str, ...] = (
    # 迷你 Servlet API 提供的（和 java_sandbox.py 保持同步）
    "ServletException", "ServletContext", "ServletOutputStream",
    "HttpServlet", "HttpServletRequest", "HttpServletResponse", "HttpSession", "Cookie",
    "WebServlet", "WebFilter",
    # 教材常用的 JDK 类型
    "IOException", "FileInputStream", "FileOutputStream", "FileReader", "FileWriter",
    "File", "OutputStream", "InputStream", "PrintWriter", "BufferedReader", "BufferedWriter",
    "String", "System", "Override", "Integer", "List", "ArrayList", "HashMap", "Map",
    "Connection", "DriverManager", "PreparedStatement", "ResultSet", "RequestDispatcher",
)


def _edit_distance_at_most(a: str, b: str, limit: int = 2) -> bool:
    """a 和 b 的编辑距离是否 ≤ limit（不用完整 DP，够用就行）。"""
    if abs(len(a) - len(b)) > limit:
        return False
    if a == b:
        return True
    # 只看"长度相同/差一"这两种最常见的情况（OCR 少认/多认一个字符）
    if len(a) == len(b):
        return sum(1 for x, y in zip(a, b) if x != y) <= limit
    if abs(len(a) - len(b)) == 1:
        short, long = (a, b) if len(a) < len(b) else (b, a)
        i = j = diff = 0
        while i < len(short) and j < len(long):
            if short[i] != long[j]:
                diff += 1
                j += 1
                if diff > limit:
                    return False
            else:
                i += 1
                j += 1
        return diff + (len(long) - j) <= limit
    return False


UNKNOWN_SYMBOL = re.compile(r"(?:找不到符号|cannot find symbol)[\s\S]{0,120}?(?:符号|symbol)\s*[:：]\s*(?:类|class|变量|variable|方法|method)?\s*([A-Za-z_$][\w$]*)")


def repair_unknown_symbols(source: str, errors: list[str]) -> tuple[str, list[str]]:
    """按 javac 报的"找不到符号"，从**闭集**里挑最像的名字替换。

    返回 (新源码, 做了哪些替换)。**调用方必须重新编译验证**，不通过就撤回。
    """
    notes: list[str] = []
    fixed = source
    for err in errors:
        m = UNKNOWN_SYMBOL.search(err)
        if not m:
            continue
        bad = m.group(1)
        if bad in KNOWN_NAMES:
            continue
        best = None
        for good in KNOWN_NAMES:
            if _edit_distance_at_most(bad, good, 2):
                best = good
                break
        if not best or not re.search(rf"\b{re.escape(bad)}\b", fixed):
            continue
        fixed = re.sub(rf"\b{re.escape(bad)}\b", best, fixed)
        notes.append(f"`{bad}` → `{best}`（javac 说找不到符号，闭集里最像的是它）")
    return fixed, notes


# --------------------------------------------------------------------------
# 代码块抽取：文案里混着散文，要先把"整段代码"框出来
# --------------------------------------------------------------------------

CODE_START = re.compile(
    r"^\s*(?:@|import\s|package\s|public\s|private\s|protected\s|class\s|interface\s|"
    r"[A-Z]\w*\s+\w+\s*=|\w+\s*\(.*\)\s*;|\}\s*;?\s*$)"
)


def extract_blocks(lines: list[str]) -> list[dict]:
    """把连续的代码行聚成块（用花括号配平判断块什么时候结束）。"""
    blocks: list[dict] = []
    cur: list[str] = []
    depth = 0
    started = False
    for line in lines:
        if not started:
            if code_ish(line) and (GUTTER.match(line) or CODE_START.match(line)):
                started = True
                cur = [line]
                depth = line.count("{") - line.count("}")
            continue
        cur.append(line)
        depth += line.count("{") - line.count("}")
        if depth <= 0 and any("}" in l for l in cur):
            blocks.append({"lines": cur})
            cur, started, depth = [], False, 0
    if cur:
        blocks.append({"lines": cur})
    return blocks


# --------------------------------------------------------------------------
# 第 2 层：javac 当判据
# --------------------------------------------------------------------------

ERROR_LINE = re.compile(r"\.java:(\d+):\s*(?:错误|error)")


def compile_check(source: str) -> dict:
    """拿迷你 Servlet API 一起编译。编译过了就算过关。"""
    name = java_sandbox.java_file_name(source, "OcrSnippet")
    result = java_sandbox.run_java({name: source}, sandbox="auto")
    if result["phase"] == "env":
        # 没找到入口类（比如只有一个类片段）—— 那是正常的，编译通过就已经够
        pass
    errors = result.get("compile_errors") or []
    bad_lines = sorted({int(m.group(1)) for e in errors for m in [ERROR_LINE.search(e)] if m})
    return {
        "phase": result["phase"],
        "compiled": result["phase"] != "compile",
        "errors": errors,
        "badLines": bad_lines,
        "ms": result["ms"],
    }


# --------------------------------------------------------------------------

def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    ap = argparse.ArgumentParser(description="扫描件代码清单：按类修复 + javac 当判据")
    ap.add_argument("text", type=Path, nargs="?", help="scan_to_text.py 产出的文本")
    ap.add_argument("--file", type=Path, help="直接修一个 .java")
    ap.add_argument("--pages", default=None, help="只看这些页（如 2 / 1-3）")
    ap.add_argument("--dump", type=Path, default=None, help="把修好的代码写到这个目录")
    ap.add_argument("--json", dest="json_out", type=Path, default=None, help="报告存成 JSON（给增量管线用）")
    args = ap.parse_args()

    # ---- 取输入 ----
    if args.file:
        blocks = [{"lines": args.file.read_text(encoding="utf-8").split("\n")}]
        label = args.file.name
    elif args.text:
        raw = args.text.read_text(encoding="utf-8").split("\n")
        if args.pages:
            keep, want = [], {int(p) for p in args.pages.replace("-", " ").split()}
            page = 0
            for line in raw:
                m = re.match(r"<!-- page (\d+) -->", line.strip())
                if m:
                    page = int(m.group(1))
                    continue
                if page in want:
                    keep.append(line)
            raw = keep
        blocks = extract_blocks(raw)
        label = args.text.name
    else:
        ap.print_help()
        return 2

    print(f"来源：{label}　抽到 {len(blocks)} 个代码块\n")
    report: list[dict] = []
    need_eyes = 0
    compiled_ok = 0

    for idx, block in enumerate(blocks, start=1):
        lines = [l for l in block["lines"]]
        fixed, notes = repair_lines(lines)
        source = "\n".join(fixed).strip() + "\n"

        # 第 2 层：javac 当判据。没过就按"找不到符号"在**闭集**里修一次，
        # **必须重新编译验证**，错误没减少就撤回（绝不留下"改了但没验证"的东西）。
        check = compile_check(source)
        rounds = 0
        while not check["compiled"] and rounds < 3:
            rounds += 1
            candidate, sym_notes = repair_unknown_symbols(source, check["errors"])
            if not sym_notes:
                break
            after = compile_check(candidate)
            if len(after["errors"]) >= len(check["errors"]):
                notes.append(f"（第 {rounds} 轮符号修复被**撤回**：错误数没减少 {len(check['errors'])} → {len(after['errors'])}）")
                break
            source, check = candidate, after
            notes.extend(sym_notes)

        if check["compiled"]:
            compiled_ok += 1
        else:
            need_eyes += len(check["badLines"]) or 1
        print(f"── 块 {idx}（{len(lines)} 行）")
        print(f"   修复：{len(notes)} 处；编译：{'✅ 通过' if check['compiled'] else '❌ 没过'}")
        if check["errors"]:
            for e in check["errors"][:6]:
                print("     " + e[:130])
        if args.dump:
            outp = args.dump / f"block{idx}.java"
            outp.parent.mkdir(parents=True, exist_ok=True)
            outp.write_text(source, encoding="utf-8")
        report.append({
            "block": idx,
            "lines": len(lines),
            "repairs": notes,
            "compiled": check["compiled"],
            "badLines": check["badLines"],
            "errors": check["errors"][:10],
            "source": source if args.dump else "",
        })

    print(f"\n=== 汇总 ===")
    print(f"  {len(blocks)} 个代码块：编译通过 {compiled_ok}，需要人工看 {len(blocks) - compiled_ok}")
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"  报告 → {args.json_out}")
    print("\n⚠️ 修不动的**不猜**：上面那些行号就是要人看一眼的地方 —— 这是有意的取舍。")
    return 0 if compiled_ok == len(blocks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
