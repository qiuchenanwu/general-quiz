# -*- coding: utf-8 -*-
"""人工抽查：把解析结果和 PDF 原文对照，确认断行/换页/特殊符号没被搞坏。"""
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

bank = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
qs = {q["no"]: q for q in bank["questions"]}

print(f"共 {bank['meta']['total']} 题  {bank['meta']['counts']}\n")
for n in [1, 4, 5, 9, 10, 16, 25, 35, 206, 210, 224]:
    q = qs[n]
    print(f"#{n}  [{q['type']}]  {q['stem']}")
    for o in q["options"]:
        print(f"        {o['key']}. {o['text']}")
    print(f"      >>> 答案 {q['answer']}   tags={q.get('tags', [])}")
    print()

print("=== 完整性体检 ===")
print("题号连续:", [q["no"] for q in bank["questions"]] == list(range(1, 225)))
print("题干为空的题:", [q["no"] for q in bank["questions"] if not q["stem"].strip()])
print("选项少于2个的题:", [q["no"] for q in bank["questions"] if len(q["options"]) < 2])
print("含异常空格的题干:", [q["no"] for q in bank["questions"] if "  " in q["stem"]][:10])
print("题干里仍带换行符的题:", [q["no"] for q in bank["questions"] if "\n" in q["stem"]])
print("答案字母越界的题:", [
    q["no"] for q in bank["questions"]
    if any(a not in {o["key"] for o in q["options"]} for a in q["answer"])
])
print("最长题干:", max((len(q["stem"]), q["no"]) for q in bank["questions"]))
