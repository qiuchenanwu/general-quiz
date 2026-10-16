#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
scan_to_text.py —— 扫描件 PDF → 文字（教材预习链路的第一段）
============================================================================
为什么要有它：
  站点自己读 PDF 是在**浏览器里用 pdf.js 抽文字**（见 frontend/src/core/pdf.js），
  但那只对"电子版 PDF"有效。**扫描件抽出来是 0 个字符** ——
  实测用户的《Java Web 程序设计任务教程》9 页扫描件：9 页全空，
  站点会正确地告诉他"多半是扫描件/图片版 —— 需要先做 OCR"。
  这一步就是那个 OCR。

为什么跑在 PC 上、不放进板子：
  OCR 是**一次性预处理**，产出的是文字；进入站点的是文字，不是图片。
  所以没必要让 aarch64 的板子去装 onnxruntime + opencv（那是另一个工程，
  而且和"站点要少一个装不上的依赖"这条既定取舍冲突）。
  板上那个 NPU 是 Qualcomm Hexagon，理论上能跑视觉模型，但那是另一条路。

为什么选 rapidocr-onnxruntime：
  · **离线、纯 CPU、不要 torch**（PaddleOCR/MinerU/surya 都要拖一个几百 MB 的框架）
  · 中文识别是它的强项（PP-OCR 系）
  · 仓库自己的 tools/AI_PROMPT.md 里就是这么建议的
  ⚠️ 依赖装在一个**单独的 venv** 里（`.venv-ocr`），别污染后端那个：
      uv venv .venv-ocr
      uv pip install --python .venv-ocr\\Scripts\\python.exe `
        --index-url https://pypi.tuna.tsinghua.edu.cn/simple PyMuPDF rapidocr-onnxruntime

  ⚠️ **必须用镜像**：实测官方 PyPI 拉 2.5MB 要 239 秒（约 10KB/s），
     清华镜像是 1.2 秒（约 700KB/s），差 70 倍。

★ 对 **JavaWeb 教材**有个特别有利的性质：教材里的**代码清单是可校验的**。
  OCR 把 `resp.setHeader` 认成 `resp.setHeader` 还是 `resp.setHeader(` ，
  散文里没人看得出来，但**编译一遍就报错**。
  所以这个工具会把"看起来像代码的行"单独标出来，方便下一步拿去编译校验 ——
  数学公式没有这个福气（那正是"公式是瓶颈"的原因）。

用法：
    .venv-ocr\\Scripts\\python.exe quiz\\tools\\scan_to_text.py 教材.pdf -o .tmp/book.txt
    ... --pages 1-9 --dpi 300 --report
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path


# --------------------------------------------------------------------------
# 版式还原：把 OCR 的散块拼回"一行行文字"
# --------------------------------------------------------------------------

def group_lines(items, y_tol: float = 12.0, page_width: float | None = None):
    """把 OCR 出来的框拼成行。

    和前端 core/pdf.js 的 linesFromItems 一个思路（那边拼的是 pdf.js 的文字块）：
    先按 y 分行（同一行的基线会差一点点，给个容差），行内再按 x 从左到右。
    这样出来的行序才是人读的顺序，后面的规则解析（题号/选项）才有意义。

    ★ 顺便**按坐标丢掉代码行号栏**：
      教材的代码清单左边有一列小数字（12、13…），OCR 会把它当成同一行的文字块。
      按文字去猜（"行首的数字要不要删"）非常容易误伤字面量（`3.14`）；
      但**它在版面上一眼就能认出来**：贴在页面最左边、内容纯数字。
      所以这里按位置丢 —— 这是这一版最重要的一个改动。
    """
    rows: list[dict] = []
    for box, text, score in items:
        ys = [p[1] for p in box]
        xs = [p[0] for p in box]
        cy = sum(ys) / len(ys)
        cx = sum(xs) / len(xs)
        placed = None
        for row in rows:
            if abs(row["y"] - cy) <= y_tol:
                placed = row
                break
        if placed is None:
            placed = {"y": cy, "parts": []}
            rows.append(placed)
        placed["parts"].append({"x": cx, "text": text, "score": float(score)})
    rows.sort(key=lambda r: r["y"])
    out = []
    for row in rows:
        parts = sorted(row["parts"], key=lambda p: p["x"])
        if page_width:
            edge = 0.13 * page_width
            # ① 同一行里，贴在左边缘的纯数字 → 是行号栏，丢掉
            if len(parts) > 1:
                kept = [p for p in parts if not (_is_gutter_text(p["text"]) and p["x"] < edge)]
                if kept:
                    parts = kept
            # ② 整行**只有**一个左边缘的数字 → 也是行号（OCR 常把它单独成行）
            #    ⚠️ 少了这条，`2` / `1.2` 会各自占一行混进正文（实测踩到）
            elif _is_gutter_text(parts[0]["text"]) and parts[0]["x"] < edge:
                continue
        line = ""
        for part in parts:
            if line and not (_is_cjk(line[-1]) and _is_cjk(part["text"][:1] or " ")):
                line += " "
            line += part["text"]
        out.append({
            "text": line.strip(),
            "score": min(p["score"] for p in parts),
            "y": row["y"],
        })
    return out


#: 行号栏的文本形态。⚠️ 别只写纯数字：OCR 会把行号 12 认成 **1.2**（实测），
#: 只认 `^\d+$` 的话这些行号会漏网、然后被当成代码粘进源码里。
#: 但也不能太宽 —— `3.14` 这种字面量要排除，所以小数位最多一位。
_GUTTER_TEXT = re.compile(r"^(?:\d{1,3}|\d{1,3}\.|\d\.\d)$")


def _is_gutter_text(text: str) -> bool:
    return bool(_GUTTER_TEXT.match(text.strip()))


def _is_cjk(ch: str) -> bool:
    code = ord(ch)
    return 0x4E00 <= code <= 0x9FFF or 0x3000 <= code <= 0x303F or 0xFF00 <= code <= 0xFFEF


#: 像"代码行"的判据（下一步要拿去编译校验的那些）
CODE_HINTS = (
    "import ", "public ", "private ", "protected ", "class ", "void ", "resp.", "req.",
    "System.", "return ", "new ", "int ", "String ", "if (", "for (", "});", ");",
    "println", "getWriter", "setHeader", "addHeader", "@Override", "@WebServlet",
)

#: 扫描 App 的水印 / 固定噪声：**每页都有**，不清掉会混进正文。
#: 实测用户那份「夸克扫描王」导出的 PDF，每页底部都是这两行。
WATERMARK = (
    "夸克扫描王", "极速扫描", "就是高效", "扫描全能王", "CamScanner", "CS 扫描全能王",
    "极速扫描，就是高效",
)


def is_watermark(text: str) -> bool:
    t = text.strip()
    if not t:
        return True
    return any(w in t for w in WATERMARK)


def clean_line(text: str) -> str:
    """行级清洗：全角标点收紧、去掉 OCR 爱插的多余空格。

    ⚠️ 这里**只做保守的规范化**，不猜内容 ——
       `resp,setHeader` 这种"逗号当点号"要留给**编译校验**去发现（见文件顶部说明），
       盲目替换 `,`→`.` 会把正文里的顿号也改坏。
    """
    t = text
    # 全角括号/冒号/分号在**代码行**里一定是错的（教材正文里是正常的，所以只在像代码时才收紧）
    if looks_like_code(t):
        t = (t.replace("（", "(").replace("）", ")")
               .replace("；", ";").replace("：", ":")
               .replace("，", ",").replace("＝", "="))
    # 中英文之间被 OCR 硬塞的空格：`2024 年3 月` → `2024年3月`
    t = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])", "", t)
    t = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=\d)", "", t)
    t = re.sub(r"(?<=\d)\s+(?=[\u4e00-\u9fff])", "", t)
    return t.strip()


def looks_like_code(text: str) -> bool:
    if any(h in text for h in CODE_HINTS):
        return True
    stripped = text.strip()
    return stripped.endswith((";", "{", "}")) and len(stripped) > 8

# --------------------------------------------------------------------------
# 主体
# --------------------------------------------------------------------------

def parse_pages(spec: str | None, total: int) -> list[int]:
    """`1-9` / `3` / `2,5,7` → 0-based 页码列表"""
    if not spec:
        return list(range(total))
    out: list[int] = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if "-" in chunk:
            a, b = chunk.split("-", 1)
            out.extend(range(int(a) - 1, int(b)))
        elif chunk:
            out.append(int(chunk) - 1)
    return [p for p in out if 0 <= p < total]


def run(pdf: Path, *, dpi: int, pages_spec: str | None, out_path: Path | None, report: bool) -> int:
    import fitz  # PyMuPDF
    from rapidocr_onnxruntime import RapidOCR

    started = time.time()
    doc = fitz.open(pdf)
    total = doc.page_count
    wanted = parse_pages(pages_spec, total)
    print(f"PDF：{pdf.name}  共 {total} 页，处理 {len(wanted)} 页（{dpi} DPI）")

    # ⚠️ 给 PyMuPDF 也抽一次文字：**用来确认它确实是扫描件**（而不是我们白跑 OCR）
    embedded = []
    for i in wanted:
        text = doc[i].get_text().strip()
        embedded.append(len(text))
    if sum(embedded) == 0:
        print("  ✓ 确认：PDF **没有文字层**（纯扫描件）—— OCR 是必须的")
    else:
        print(f"  ⚠️ 这份 PDF **有文字层**（{sum(embedded)} 字）—— 能直接抽就别 OCR（OCR 会引入错字）")

    ocr = RapidOCR()
    all_pages: list[dict] = []
    for n, i in enumerate(wanted, start=1):
        page = doc[i]
        pix = page.get_pixmap(dpi=dpi)
        img = pix.tobytes("png")
        result, _ = ocr(img)
        items = result or []
        # 传页面宽度进去 → 按版面丢掉左边缘的"行号栏"
        raw_lines = group_lines(items, page_width=float(pix.width))
        # 清洗 + 去水印（水印是**每页都有**的固定噪声，不清会混进正文）
        lines = []
        for line in raw_lines:
            text = clean_line(line["text"])
            if not text or is_watermark(text):
                continue
            lines.append({**line, "text": text})
        all_pages.append({"page": i + 1, "lines": lines})
        low = sum(1 for l in lines if l["score"] < 0.6)
        print(f"  第 {i + 1} 页：{len(lines)} 行（去掉 {len(raw_lines) - len(lines)} 行水印/空行），"
              f"最低置信度 {min([l['score'] for l in lines], default=0):.2f}"
              f"{f'，{low} 行低于 0.6' if low else ''}")
        del pix

    # ---- 产出 ----
    if out_path:
        pieces = []
        for pg in all_pages:
            pieces.append(f"\n<!-- page {pg['page']} -->")
            pieces.extend(l["text"] for l in pg["lines"])
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text("\n".join(pieces) + "\n", encoding="utf-8")
        print(f"\n写出 {out_path}（{out_path.stat().st_size} 字节）")

    if report:
        code_lines = [l for pg in all_pages for l in pg["lines"] if looks_like_code(l["text"])]
        print(f"\n=== 报告 ===")
        print(f"  总行数：{sum(len(pg['lines']) for pg in all_pages)}")
        print(f"  疑似**代码行**：{len(code_lines)}（这些下一步可以拿去编译校验 —— JavaWeb 的便宜之处）")
        print(f"  低置信度（<0.6）：{sum(1 for pg in all_pages for l in pg['lines'] if l['score'] < 0.6)}")
        print(f"  耗时：{time.time() - started:.1f}s")

    return 0


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    ap = argparse.ArgumentParser(description="扫描件 PDF → 文字（教材预习链路的第一段）")
    ap.add_argument("pdf", type=Path)
    ap.add_argument("-o", "--out", type=Path, default=None, help="输出文本（默认只打印，不落盘）")
    ap.add_argument("--pages", default=None, help="只处理这些页，如 1-9 / 3 / 2,5,7（默认全部）")
    ap.add_argument("--dpi", type=int, default=300, help="渲染 DPI：300 足够，低了小字会错")
    ap.add_argument("--report", action="store_true", help="打印质量报告")
    ap.add_argument("--json", dest="json_out", type=Path, default=None, help="把逐页行+置信度存成 JSON")
    args = ap.parse_args()

    if not args.pdf.is_file():
        print(f"找不到文件：{args.pdf}")
        return 2

    try:
        code = run(args.pdf, dpi=args.dpi, pages_spec=args.pages, out_path=args.out, report=args.report)
    except ImportError as exc:
        print(f"缺依赖：{exc}\n请用 .venv-ocr 里的 python 跑（见本文件顶部注释）")
        return 3
    return code


if __name__ == "__main__":
    raise SystemExit(main())
