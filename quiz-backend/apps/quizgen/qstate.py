"""刷题进度的形状与合并规则（纯函数，不碰数据库、不碰 HTTP）。

一份"进度"长这样（键名**跟着前端的 localStorage 走**，不改名 —— 改名就要写映射，
映射写错就是"同步之后错题本变空"，那是这个功能最贵的失败）：

    {
      "v": 1,
      "progress": {"answers": {...}, "wrong": {...}, "fav": {...},
                   "favAt": {...}, "updatedAt": 1710000000000},
      "history": [{"q": "12", "ok": 1, "t": 1710000000000, "ms": 4200}, ...],
      "notes":     {"12": "老师说这题考…"},
      "overrides": {"12": {"answer": [...], "analysis": "…"}},
      "analyses":  {"12": "AI 补的解析"},
      "diagram":   {"nodes": [...], "edges": [...]},
      "diagnose":  {"chapter": "…", "accuracy": 60, "at": 1710000000000},
      "clearedAt": {"answers": 0, "wrong": 0, "fav": 0, "history": 0, "diagram": 0},
      "diagramAt": 0
    }

合并规则（★ 这一段是**产品判断**，不是随便选的；改之前先读 `quiz/PRODUCT.md` §6）
--------------------------------------------------------------------------------
两台设备各有一份进度时，"谁对"没有唯一答案。这里选**不丢数据**那一侧，
并且把"说不清"的地方**报出来**（返回 conflicts），而不是悄悄丢掉一边：

  · history        并集去重（按 q+t+ok）—— 这是唯一能跨设备累积的原始事实，永不丢。
  · answers/wrong  逐题按**最近一次作答时间**（answers[q].ts）取胜方；一边没这题的记录
                   就用另一边；时间相同（或都没时间戳）→ **本机优先**（正在用的设备是"当下"）。
                   错题本**只由取胜方说了算**，所以"A 上答对了"能真的把 B 上那条错题消掉。
  · fav            收藏本身没有时间戳，所以默认并集（绝不因为登录弄丢收藏）。
                   `favAt` 是新增的"取消收藏时间"：只有它明确记录"某台设备更晚取消过"时才真取消。
  · notes          笔记带 `updatedAt`（前端 setNote 写的）⇒ 按它定先后；
                   两边都没有时间戳、内容又不同 ⇒ 本机优先 + 记一条 conflict。
                   删单条笔记按题号留墓碑（`progress.notesRemoved[qid]`）：
                   墓碑比对方那条更新 ⇒ 不复活；重新写过笔记会清掉墓碑。
                   ⚠️ 笔记的值是 `{text, ts, updatedAt}` **对象**，不是字符串 —— 这一条踩过。
  · analyses       AI 补的解析：并集，本机优先（别用旧解析覆盖他刚生成的那份）。
  · diagram        手画的图**不做自动合并**（节点 id 会撞）：按 `diagramAt`/`clearedAt.diagram`
                   判断哪边更新；同样新（或都没时间戳）时——一边空用另一边，都非空 → 本机优先 + conflict。
  · diagnose       取 `at` 较晚的一方。

★ 删除（"我清空了，刷新又回来了"）怎么处理 —— 这是并集合并最容易做错的地方
--------------------------------------------------------------------------------
答案不是"清空也当并集"，而是**清空留一个时间戳**：前端在"重置进度 / 清空错题本 /
清空学习记录 / 清空画布"时把 `clearedAt[桶]` 写成 `Date.now()`（见 stores/quiz.js）。
合并时先取两边**更晚的那次清空**当阈值，**比阈值旧的记录一律不复活**：

    · answers/wrong  这题最近一次作答 ≤ 阈值 ⇒ 整题作废（清空之后重新做的当然会留下）
    · history        t ≤ 阈值的行直接丢掉
    · fav            （favAt 或 0）≤ 阈值 ⇒ 不复活
    · diagram        clearedAt.diagram 比另一边的 diagramAt/clearedAt 都晚 ⇒ 空图就该是空图

没有 `clearedAt` 的老数据全是 0 ⇒ 行为和"纯并集"完全一样，不会因为升级丢掉任何东西。

刻意**不**同步的东西（这一版）：正在进行的练习（`session`，跨设备续做会把人吓一跳）、
扫描件的预习材料（`lesson`，几百 KB 的大块材料，不该跟着进度走）。见 `quiz/RELAY.md`。
"""

from __future__ import annotations

import json
from typing import Any

#: 形状版本。将来改结构时前端按它决定要不要迁移（现在只有 1）
STATE_VERSION = 1

#: 一个账号最多存几套题库的进度（防"脚本刷行数"把库撑爆）
MAX_BANKS_PER_USER = 200
#: 单套题库的进度上限（字节）。实测一套 224 题的进度约 20KB，
#: 8000 条历史的题也是几百 KB 的量级，2MB 是"明显不正常"的分界线。
MAX_STATE_BYTES = 2 * 1024 * 1024
#: 历史条数上限，和前端 stores/quiz.js 的 HISTORY_MAX 对齐（8000）
HISTORY_CAP = 8000

#: 有"清空时间戳"的四个桶（键名要和前端 store 里的名字一致）
BUCKETS = ("answers", "wrong", "fav", "history", "diagram")


def _int(value: Any, default: int = 0) -> int:
    """把 JSON 里的东西尽量变成 int —— 脏数据不许让合并抛异常。"""
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(float(value))
        except ValueError:
            return default
    return default


def _dict(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list:
    return value if isinstance(value, list) else []


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _notes_map(raw: Any) -> dict:
    """笔记是 `{qid: {text, ts, updatedAt}}`（**不是** `{qid: "文字"}`）。

    ⚠️ 这一条踩过：第一版按"值是字符串"归一化，而前端存的是对象 ⇒
    所有笔记在同步时被静默丢光。形状必须和前端 `stores/quiz.js` 的 `setNote` 一致。
    """
    out = {}
    for key, value in _dict(raw).items():
        if isinstance(value, str):  # 容忍手写/老版本的裸字符串
            if value:
                out[str(key)] = {"text": value, "ts": 0, "updatedAt": 0}
            continue
        item = _dict(value)
        text = _text(item.get("text"))
        if not text:
            continue
        out[str(key)] = {
            "text": text,
            "ts": _int(item.get("ts")),
            "updatedAt": _int(item.get("updatedAt")),
        }
    return out


def _note_at(note: Any) -> int:
    """一条笔记"最后被动过"的时间（setNote 写 updatedAt，老数据可能只有 ts）。"""
    item = _dict(note)
    return _int(item.get("updatedAt")) or _int(item.get("ts"))


def normalize_state(raw: Any) -> dict:
    """把任意外来 JSON 收敛成上面那个形状。

    为什么必须收敛：这是**公网可写的接口**，客户端传什么都有可能
    （老版本前端、被改坏的数据、故意构造的 JSON）。合并逻辑里只要有一个
    `dict.get` 打在 list 上就是 500 —— 那正是"学生一打开错题本页面就白屏"。
    """
    src = _dict(raw)
    progress = _dict(src.get("progress"))

    history: list[dict] = []
    for row in _list(src.get("history")):
        item = _dict(row)
        qid = item.get("q")
        stamp = _int(item.get("t"))
        if qid is None or not stamp:
            # 没有题号或没有时间的历史条目没法去重、也没法排序，直接丢
            continue
        history.append(
            {"q": str(qid), "ok": 1 if _int(item.get("ok")) else 0, "t": stamp,
             "ms": max(0, _int(item.get("ms")))}
        )

    def _map_of_dicts(bucket: Any) -> dict:
        return {str(k): v for k, v in _dict(bucket).items() if isinstance(v, dict)}

    def _map_of_ones(bucket: Any) -> dict:
        # 错题本/收藏存的是 {qid: 1}，但历史数据里也可能是 {qid: {…}} 或 true
        out = {}
        for key, value in _dict(bucket).items():
            if value in (0, None, False, ""):
                continue
            out[str(key)] = 1
        return out

    cleared_src = _dict(src.get("clearedAt"))
    return {
        "v": STATE_VERSION,
        "progress": {
            "answers": _map_of_dicts(progress.get("answers")),
            "wrong": _map_of_ones(progress.get("wrong")),
            "fav": _map_of_ones(progress.get("fav")),
            "favAt": {str(k): _int(v) for k, v in _dict(progress.get("favAt")).items() if _int(v)},
            #: 删掉某条笔记的时间（按题号）—— 删单条笔记没法用"清空阈值"表达，
            #: 因为那会连带把**别的**笔记一起判死。见下面 merge 里的注释。
            "notesRemoved": {
                str(k): _int(v) for k, v in _dict(progress.get("notesRemoved")).items() if _int(v)
            },
            "updatedAt": _int(progress.get("updatedAt")),
        },
        "history": history[-HISTORY_CAP:],
        "notes": _notes_map(src.get("notes")),
        "overrides": _map_of_dicts(src.get("overrides")),
        "analyses": {str(k): _text(v) for k, v in _dict(src.get("analyses")).items() if _text(v)},
        "diagram": {
            "nodes": _list(_dict(src.get("diagram")).get("nodes")),
            "edges": _list(_dict(src.get("diagram")).get("edges")),
        },
        "diagnose": _dict(src.get("diagnose")),
        "clearedAt": {bucket: _int(cleared_src.get(bucket)) for bucket in BUCKETS},
        "diagramAt": _int(src.get("diagramAt")),
    }


def state_is_empty(state: dict) -> bool:
    """这份进度里有没有"学生的东西"。空进度不该占一行、也不该覆盖服务端那份。

    ⚠️ `clearedAt` / `diagramAt` 是**元数据**，不算"有东西"：
    一台什么都没做的新设备清过一次空，不该被当成一份进度推上去。
    """
    progress = state.get("progress") or {}
    if progress.get("answers") or progress.get("wrong") or progress.get("fav"):
        return False
    if state.get("history") or state.get("notes") or state.get("analyses"):
        return False
    if state.get("overrides") or state.get("diagnose"):
        return False
    diagram = state.get("diagram") or {}
    return not (diagram.get("nodes") or diagram.get("edges"))


def state_size(state: dict) -> int:
    """序列化后有多大（按 UTF-8 字节算，中文一个字 3 字节）。"""
    return len(json.dumps(state, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _recency(state: dict, qid: str) -> int:
    record = (state["progress"]["answers"] or {}).get(qid)
    return _int(record.get("ts")) if isinstance(record, dict) else 0


def _cleared(state: dict, bucket: str) -> int:
    return _int((state.get("clearedAt") or {}).get(bucket))


def _diagram_key(state: dict) -> int:
    """这张画布"最后一次被动过"的时间：改过或清过，取更晚的那个。"""
    return max(_int(state.get("diagramAt")), _cleared(state, "diagram"))


def merge_state(server: Any, client: Any) -> tuple[dict, dict]:
    """把"账号里那份"和"这台设备这份"合成一份。

    `client` 是**正在用的这台设备**，平局时它赢（见文件头那段）。
    返回 `(合并后的进度, conflicts)`；conflicts 是给前端提示用的计数：
    `{"notes": n, "fav": n, "diagram": 0|1}` —— 只统计"两边都有、内容不同"的条数。
    """
    left = normalize_state(server)   # left  = 服务端（账号）那份
    right = normalize_state(client)  # right = 本机这份
    conflicts = {"notes": 0, "fav": 0, "diagram": 0}
    out = normalize_state({})

    # 清空阈值：谁清得更晚听谁的（见文件头"删除怎么处理"）
    cleared = {
        bucket: max(_cleared(left, bucket), _cleared(right, bucket)) for bucket in BUCKETS
    }

    # ---------- 历史：并集去重，但清空阈值之前的行不复活 ----------
    seen: set[tuple] = set()
    rows: list[dict] = []
    for row in [*left["history"], *right["history"]]:
        if row["t"] <= cleared["history"]:
            continue
        key = (row["q"], row["t"], row["ok"])
        if key in seen:
            continue
        seen.add(key)
        rows.append(row)
    rows.sort(key=lambda item: item["t"])
    out["history"] = rows[-HISTORY_CAP:]

    # ---------- 作答 / 错题：逐题按最近一次作答取胜方 ----------
    qids = (
        set(left["progress"]["answers"])
        | set(left["progress"]["wrong"])
        | set(right["progress"]["answers"])
        | set(right["progress"]["wrong"])
    )
    clear_limit = cleared["answers"] if cleared["answers"] >= cleared["wrong"] else cleared["wrong"]
    for qid in sorted(qids):
        s_ts, c_ts = _recency(left, qid), _recency(right, qid)
        # 两边这题的记录都比"上一次清空"旧 ⇒ 是清空之前的东西，不许复活
        if clear_limit and max(s_ts, c_ts) <= clear_limit:
            continue
        s_rec = left["progress"]["answers"].get(qid)
        c_rec = right["progress"]["answers"].get(qid)
        if s_rec is None and c_rec is None:
            # 这题在两边都只有错题标记（没有作答记录）：并集处理
            if qid in left["progress"]["wrong"] or qid in right["progress"]["wrong"]:
                out["progress"]["wrong"][qid] = 1
            continue
        if c_rec is None:
            winner, loser = left, right
        elif s_rec is None:
            winner, loser = right, left
        elif c_ts >= s_ts:
            winner, loser = right, left
        else:
            winner, loser = left, right

        record = winner["progress"]["answers"].get(qid) or loser["progress"]["answers"].get(qid)
        if isinstance(record, dict):
            out["progress"]["answers"][qid] = record
        if qid in winner["progress"]["wrong"]:
            out["progress"]["wrong"][qid] = 1

    # ---------- 收藏：并集，但显式取消过（favAt 更晚）的要真的取消 ----------
    fav_keys = (
        set(left["progress"]["fav"])
        | set(right["progress"]["fav"])
        | set(left["progress"]["favAt"])
        | set(right["progress"]["favAt"])
    )
    fav_clear = cleared["fav"]
    for qid in sorted(fav_keys):
        in_left = qid in left["progress"]["fav"]
        in_right = qid in right["progress"]["fav"]
        left_at = _int(left["progress"]["favAt"].get(qid))
        right_at = _int(right["progress"]["favAt"].get(qid))
        if in_left and in_right:
            out["progress"]["fav"][qid] = 1
            continue
        if in_right:
            # 账号那份没有这条收藏：它可能是"更晚取消过"，也可能是清空过 ——
            # 两种都别把它带回来；只有"对面明确更晚取消"才算一条冲突（值得告诉学生）
            if left_at > right_at:
                conflicts["fav"] += 1
            if max(left_at, fav_clear) > right_at:
                continue
            out["progress"]["fav"][qid] = 1
        else:
            if right_at > left_at:
                conflicts["fav"] += 1
            if max(right_at, fav_clear) > left_at:
                continue
            out["progress"]["fav"][qid] = 1
    for qid in set(left["progress"]["favAt"]) | set(right["progress"]["favAt"]):
        out["progress"]["favAt"][qid] = max(
            _int(left["progress"]["favAt"].get(qid)), _int(right["progress"]["favAt"].get(qid))
        )

    # ---------- 笔记：只有一边有就用它；两边都有则按 updatedAt 定，平局听本机 ----------
    # 笔记带 `updatedAt`（前端 setNote 写的），所以这里能真判先后。
    #
    # ★ 删除单条笔记要有**按题号的墓碑**（`notesRemoved[qid]`）：
    #   不能用"清空阈值"—— 删第 3 题的笔记时把阈值抬到此刻，
    #   会把账号里第 4、5 题的笔记一起判死（那是数据丢失，不是删除意图）。
    #   墓碑比对方那条笔记的 updatedAt 更晚 ⇒ 那条笔记不复活；重新写过笔记时会清掉墓碑。
    left_removed = left["progress"]["notesRemoved"]
    right_removed = right["progress"]["notesRemoved"]
    for qid in set(left["notes"]) | set(right["notes"]) | set(left_removed) | set(right_removed):
        left_note = left["notes"].get(qid)
        right_note = right["notes"].get(qid)
        if left_note is not None and _int(right_removed.get(qid)) > _note_at(left_note):
            left_note = None  # 本机在某个时刻删过，而且比这条新
        if right_note is not None and _int(left_removed.get(qid)) > _note_at(right_note):
            right_note = None  # 账号那边删过，比本机这条新
        if left_note is None and right_note is None:
            continue
        if left_note is None:
            out["notes"][qid] = right_note
            continue
        if right_note is None:
            out["notes"][qid] = left_note
            continue
        left_at = _note_at(left_note)
        right_at = _note_at(right_note)
        if left_note.get("text") != right_note.get("text") and not (left_at or right_at):
            conflicts["notes"] += 1
        out["notes"][qid] = left_note if left_at > right_at else right_note
    for qid in set(left_removed) | set(right_removed):
        out["progress"]["notesRemoved"][qid] = max(
            _int(left_removed.get(qid)), _int(right_removed.get(qid))
        )

    # ---------- 题目修正 / AI 解析：并集，本机优先 ----------
    for qid in set(left["overrides"]) | set(right["overrides"]):
        out["overrides"][qid] = right["overrides"].get(qid) or left["overrides"].get(qid)
    for qid in set(left["analyses"]) | set(right["analyses"]):
        out["analyses"][qid] = right["analyses"].get(qid) or left["analyses"].get(qid)

    # ---------- 图笔记：不做自动合并（节点 id 会撞），按"最后动过的时间"定 ----------
    left_key, right_key = _diagram_key(left), _diagram_key(right)
    left_diagram, right_diagram = left["diagram"], right["diagram"]
    left_empty = not (left_diagram["nodes"] or left_diagram["edges"])
    right_empty = not (right_diagram["nodes"] or right_diagram["edges"])
    if right_key > left_key:
        out["diagram"] = right_diagram
    elif left_key > right_key:
        out["diagram"] = left_diagram
    elif right_empty:
        out["diagram"] = left_diagram
    elif left_empty:
        out["diagram"] = right_diagram
    elif left_diagram != right_diagram:
        conflicts["diagram"] = 1
        out["diagram"] = right_diagram
    else:
        out["diagram"] = right_diagram

    # ---------- 诊断结果：取较晚的那次 ----------
    left_at = _int(left["diagnose"].get("at"))
    right_at = _int(right["diagnose"].get("at"))
    if right_at >= left_at:
        out["diagnose"] = right["diagnose"] or left["diagnose"]
    else:
        out["diagnose"] = left["diagnose"]

    out["progress"]["updatedAt"] = max(
        _int(left["progress"]["updatedAt"]), _int(right["progress"]["updatedAt"])
    )
    out["clearedAt"] = cleared
    out["diagramAt"] = max(_int(left["diagramAt"]), _int(right["diagramAt"]))
    return out, conflicts
