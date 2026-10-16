# -*- coding: utf-8 -*-
"""
shoot.py —— 用真实浏览器把刷题站跑一遍并截图（视觉验收）

不只是截图：还会点进练习、故意答错、导入一份脏 JSON，
把「能不能用」和「好不好看」一起验掉。控制台报错会全部收集出来。

用法（需先起静态服务，例如 python -m http.server 5198 --directory frontend/dist）：
    .venv\\Scripts\\python.exe quiz\\tools\\shoot.py [base_url]

⚠️ 在 DSH 沙箱里跑之前必须把 TEMP/TMP 指到工作区内，否则 Playwright 根本起不来：

    New-Item -ItemType Directory -Force -Path .tmp\\pw-temp | Out-Null
    $env:TEMP = (Resolve-Path .tmp\\pw-temp).Path; $env:TMP = $env:TEMP

原因：沙箱**拒绝写工作区之外的目录**（在 `%LOCALAPPDATA%\\Temp` 建目录报
`WinError 5 拒绝访问`）。Python 的 `tempfile` 会自动降级到当前目录，所以
"看起来一切正常"；但 Playwright 拉起的 Node 子进程用 `os.tmpdir()`，
它读 `TEMP` 且不会降级，于是直接抛
`EPERM: operation not permitted, mkdtemp '...\\playwright-artifacts-XXXXXX'` ——
看着像 Playwright 装坏了，其实只是临时目录不可写。
"""
import json
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

# 背景"看不看得出来"要靠**像素差**来验，所以需要 Pillow。
# 但它是可选依赖：没装就跳过那几条断言，不能因此让整个验收跑不起来。
try:
    from PIL import Image, ImageChops

    HAS_PIL = True
except ImportError:
    HAS_PIL = False

# Windows 控制台默认 GBK，打印 ▶/✓ 会炸，这里兜一下
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5198"
OUT = Path(__file__).resolve().parent.parent / "shots"
OUT.mkdir(exist_ok=True)
TMP = Path(__file__).resolve().parent.parent / ".tmp"
TMP.mkdir(exist_ok=True)

errors: list[str] = []
not_found: list[str] = []
results: list[tuple[bool, str]] = []


def check(cond, label, extra=""):
    results.append((bool(cond), label))
    print(("  OK   " if cond else "  FAIL ") + label + (f"   -> {extra}" if extra and not cond else ""))


def diff_stat(path_a, path_b):
    """两张同尺寸截图的差异 -> (平均绝对差 0~255, 明显不同的像素占比 %)。

    "明显不同"取差值 > 8 —— 抗掉抗锯齿/亚像素渲染那点噪声，
    只算人眼真的能分辨的变化。
    """
    a = Image.open(path_a).convert("RGB")
    b = Image.open(path_b).convert("RGB")
    gray = ImageChops.difference(a, b).convert("L")
    hist = gray.histogram()
    total = sum(hist) or 1
    mean = sum(i * n for i, n in enumerate(hist)) / total
    visible = sum(n for i, n in enumerate(hist) if i > 8) / total * 100
    return mean, visible


def main():
    with sync_playwright() as p:
        # 用系统装的 Chrome，省得下 Playwright 自带的那几百 MB。
        # --autoplay-policy：让 AudioContext 一上来就是 running，
        #   否则音效要么被自动播放策略拦住、要么测起来时好时坏。
        # --no-proxy-server：本机系统代理会劫持 100.x（Tailscale）的 HTTP 请求，
        #   表现为空 502，看着像板子挂了。板子那条链路必须绕开代理。
        #
        # QUIZ_CHROME_ARGS：附加 Chrome 参数（分号分隔）。用来做
        #   --host-resolver-rules="MAP your.domain 1.2.3.4"
        # 这类事 —— 本机 DNS 被代理劫持（解析成 198.18.x.x）时，
        # 仍能按真实 Host 头去访问指定服务器，从而验证**域名专属的 nginx 配置**
        # （比如「这个域名的根路径是不是刷题站」）。
        extra_args = [a for a in (os.environ.get("QUIZ_CHROME_ARGS") or "").split(";") if a.strip()]
        browser = p.chromium.launch(
            channel="chrome",
            headless=True,
            args=[
                "--autoplay-policy=no-user-gesture-required",
                "--no-proxy-server",
                *extra_args,
            ],
        )
        ctx = browser.new_context(
            viewport={"width": 1440, "height": 920},
            device_scale_factor=1.5,
            locale="zh-CN",
        )
        page = ctx.new_page()
        # 音效探针：把 AudioContext 包一层，数一数到底建了多少个振荡器。
        # 这是「音效到底有没有真的发声」唯一靠谱的自动化验证方式 ——
        # 光看代码或截图都证明不了。
        page.add_init_script(
            """
            (() => {
              const AC = window.AudioContext || window.webkitAudioContext
              if (!AC) return
              window.__sfx = { contexts: 0, oscillators: 0, resumes: 0 }
              function Wrapped(...a) {
                const c = new AC(...a)
                window.__sfx.contexts++
                const oc = c.createOscillator.bind(c)
                c.createOscillator = (...x) => { window.__sfx.oscillators++; return oc(...x) }
                const rs = c.resume.bind(c)
                c.resume = (...x) => { window.__sfx.resumes++; return rs(...x) }
                return c
              }
              Wrapped.prototype = AC.prototype
              window.AudioContext = Wrapped
              window.webkitAudioContext = Wrapped
            })()
            """
        )
        page.on(
            "console",
            lambda m: errors.append(f"[console.{m.type}] {m.text}")
            if m.type in ("error", "warning")
            else None,
        )
        page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
        # 记下 404 的 URL：控制台只说"某个资源 404"，不说是哪个 —— 得自己抓
        page.on(
            "response",
            lambda r: not_found.append(r.url) if r.status == 404 else None,
        )

        # ─────────── 1. 首页（浅色） ───────────
        # ⚠️ 这里有一个"等应用就绪"的统一动作，别退回成单纯的 sleep。
        # 板子上是 1.4MB 的包走 WiFi，忙的时候光加载就要好几秒；
        # 固定 wait_for_timeout 会在慢的时候**假失败**（实测连挂两次：
        # "跳到刷题页（url=/）"——点的时候应用还没挂载完）。
        def wait_home_ready(timeout=20000):
            try:
                page.wait_for_selector(".q-bank__go", timeout=timeout)
            except Exception:  # noqa: BLE001
                pass  # 真等不到就让后面的断言去报错，别在这里吞掉信息

        print("\n▶ 首页")
        page.goto(BASE + "/#/", wait_until="load")
        wait_home_ready()
        page.wait_for_timeout(600)
        # Hero 文案 2026-10-11 改成学生视角（原句「丢一个 JSON，就能开始刷题」已删），
        # 所以这里改成钉结构：标题/副文在不在，比钉某一句文案抗改。
        check(
            page.locator(".q-hero__title").count() == 1
            and page.locator(".q-hero__sub").inner_text().strip() != "",
            "首页 Hero 渲染出来了",
        )
        check(
            page.locator("text=毛泽东思想和中国特色社会主义理论体系概论题库").count() > 0,
            "内置题库卡片出现在首页",
        )
        n_entries = page.locator(".q-bank").count()
        check(n_entries >= 1, f"题库卡片数量 = {n_entries}")
        check(page.locator(".q-tools__drop").count() > 0, "题库工具的导入区在（PDF/JSON 都能拖）")
        page.screenshot(path=OUT / "01-home-light.png", full_page=True)

        # ─────────── 2. 深色首页 ───────────
        print("\n▶ 深色主题")
        page.evaluate(
            "localStorage.setItem('quiz:v1:settings', JSON.stringify({theme:'dark',stemSize:19}))"
        )
        page.reload(wait_until="load")
        wait_home_ready()
        page.wait_for_timeout(600)
        is_dark = page.evaluate("document.documentElement.classList.contains('dark')")
        check(is_dark, "深色模式 class 已挂到 <html>")
        page.screenshot(path=OUT / "02-home-dark.png", full_page=True)

        # ─────────── 3. 选中题库 → 组卷区出现 ───────────
        print("\n▶ 选中题库")
        page.locator(".q-bank__go").first.click()
        try:
            page.wait_for_selector("#q-start", timeout=15000)
        except Exception:  # noqa: BLE001
            pass
        page.wait_for_timeout(400)
        check(page.locator("#q-start").count() > 0, "选中题库后出现「开始刷题」组卷区")
        check(page.locator("text=顺序练习").count() > 0, "组卷区里模式卡片都在")
        check(page.locator("text=按知识点筛选").count() > 0, "标签筛选下拉出现")

        # 结构检查：<input> 不能嵌在 <button> 里（非法 HTML，焦点行为不可靠）
        nested = page.evaluate("document.querySelectorAll('button input').length")
        check(nested == 0, f"没有 <input> 嵌在 <button> 里（找到 {nested} 个）")

        # 考试卡片应该独占整行
        exam_card = page.locator(".q-mode--wide")
        modes = page.locator(".q-modes")
        if exam_card.count() and modes.count():
            w_card = exam_card.first.bounding_box()["width"]
            w_modes = modes.first.bounding_box()["width"]
            check(
                w_card > w_modes * 0.95,
                f"考试卡片独占整行（{w_card:.0f} / {w_modes:.0f}px）",
            )
        else:
            check(False, "没找到考试模式卡片")

        page.screenshot(path=OUT / "02b-home-selected.png", full_page=True)

        # ─────────── 4. 进入练习 ───────────
        print("\n▶ 开始刷题")
        page.locator("text=顺序练习").first.click()
        # ⚠️ 等**页面真的进了练习**，而不是等固定毫秒：
        #    板子慢的时候 1600ms 会不够，然后就报"跳到刷题页（url=/）"这种假失败。
        try:
            page.wait_for_selector(".q-pv", timeout=15000)
        except Exception:  # noqa: BLE001
            pass
        page.wait_for_timeout(500)
        check("/practice" in page.url, f"跳到刷题页（url={page.url.split('#')[-1]}）")
        stem = page.locator(".q-qc__stem").first
        check(stem.count() > 0, "题干渲染出来了")
        check(page.locator(".q-opt").count() >= 2, "选项渲染出来了")
        check(page.locator(".q-sheet").count() > 0, "右侧答题卡在桌面端显示")
        check(page.locator(".q-pbar").count() > 0, "顶部工具条渲染出来了")
        check(
            page.locator(".q-qc__stem .q-blank").count() > 0,
            "题干填空渲染成下划线，而不是被折叠成 ()",
        )
        stem_text = stem.inner_text()[:40] if stem.count() else ""
        page.screenshot(path=OUT / "03-practice.png", full_page=True)

        # ─────────── 4. 故意答错，看反馈 ───────────
        print("\n▶ 答错反馈")
        page.locator(".q-opt").nth(1).click()  # 第 1 题答案其实是 A，点 B
        page.wait_for_timeout(900)
        got_verdict = page.locator(".q-qc__verdict").count() > 0
        check(got_verdict, "作答后出现判定条")
        has_wrong = page.locator(".q-opt.is-wrong").count() > 0
        has_correct = page.locator(".q-opt.is-correct, .q-opt.is-missed").count() > 0
        check(has_wrong, "选错的选项标红")
        check(has_correct, "正确选项被标出来")
        check(page.locator(".q-sheet__cell.is-bad").count() > 0, "答题卡上出现红色错题格")
        page.screenshot(path=OUT / "04-practice-wrong.png", full_page=True)

        # ─────────── 5. 键盘快捷键 ───────────
        print("\n▶ 键盘操作")
        page.keyboard.press("Enter")  # 下一题
        page.wait_for_timeout(600)
        pos = page.locator(".q-pbar__pos b").inner_text()
        check(pos.strip() == "2", f"Enter 翻到第 2 题（当前 {pos.strip()}）")
        page.keyboard.press("A")  # 用键盘选 A（第 2 题答案是 C，所以会判错——正好验证按键真的生效）
        page.wait_for_timeout(800)
        check(
            page.locator(".q-qc__verdict").count() > 0,
            "键盘按 A 触发了判定（单选题按键即判）",
        )
        vsub = page.locator(".q-qc__verdict-sub").first.inner_text().replace("\n", " ")
        check("你的答案 A" in vsub, f"判定条里记录的作答确实是 A（{vsub.strip()[:56]}）")
        page.keyboard.press("ArrowLeft")
        page.wait_for_timeout(500)
        pos = page.locator(".q-pbar__pos b").inner_text()
        check(pos.strip() == "1", f"← 回到第 1 题（当前 {pos.strip()}）")

        # ─────────── 5b. 音效（真·发声验证）───────────
        print("\n▶ 音效")

        def goto_unanswered():
            """用答题卡的「未做」筛选跳一道没做过的题（已判定的题点了不会发声）"""
            page.locator(".q-sheet__filter", has_text="未做").first.click()
            page.wait_for_timeout(300)
            page.locator(".q-sheet__cell").first.click()
            page.wait_for_timeout(500)

        probe = page.evaluate("window.__sfx || null")
        check(probe is not None, "AudioContext 已被探针接管（说明页面确实在用 WebAudio）")

        goto_unanswered()
        check(page.locator(".q-qc__verdict").count() == 0, "已跳到一道未作答的题")

        before = page.evaluate("window.__sfx.oscillators")
        page.locator(".q-opt").first.click()
        page.wait_for_timeout(700)
        after = page.evaluate("window.__sfx.oscillators")
        check(after > before, f"答题真的发声了（振荡器 {before} → {after}）")

        # 收藏（键盘 S）也要有声
        before = after
        page.keyboard.press("S")
        page.wait_for_timeout(600)
        after = page.evaluate("window.__sfx.oscillators")
        check(after > before, f"收藏也发声（{before} → {after}）")

        # 多选/考试里点选项 → 轻点声
        goto_unanswered()
        before = after
        page.locator(".q-opt").first.click()
        page.wait_for_timeout(600)
        after = page.evaluate("window.__sfx.oscillators")
        check(after > before, f"再次答题继续发声（{before} → {after}）")

        # 关掉音效后，答题就不该再有任何发声
        page.evaluate(
            "localStorage.setItem('quiz:v1:settings', "
            "JSON.stringify({theme:'dark',stemSize:19,sound:false}))"
        )
        page.reload(wait_until="load")
        page.wait_for_timeout(1700)
        goto_unanswered()
        before = page.evaluate("window.__sfx.oscillators")
        page.locator(".q-opt").first.click()
        page.wait_for_timeout(800)
        after = page.evaluate("window.__sfx.oscillators")
        check(after == before, f"关掉音效后完全静音（{before} → {after}）")

        # 设置面板里的「试听」按钮：即使开关是关的，主动点也应该出声
        page.locator(".q-iconbtn").last.click()  # 打开设置抽屉
        page.wait_for_timeout(900)
        check(page.locator("text=答题音效").count() > 0, "设置里有「答题音效」开关")

        sound_row = page.locator(".q-set__row", has_text="答题音效").first
        sound_row.locator(".el-switch").click()  # 把音效打开
        page.wait_for_timeout(600)
        check(page.locator(".q-try__btn").count() >= 4, "音效打开后出现「试听」按钮组")

        before = page.evaluate("window.__sfx.oscillators")
        page.locator(".q-try__btn", has_text="答对").first.click()
        page.wait_for_timeout(700)
        after = page.evaluate("window.__sfx.oscillators")
        check(after > before, f"试听按钮能出声（{before} → {after}）")
        page.screenshot(path=OUT / "11-sound-settings.png")

        # 关抽屉用关闭按钮，别用 Esc —— Esc 是应用里的「退出刷题」快捷键。
        # 用 :visible 是因为页面里还有一个（没打开过的）答题卡抽屉，它的关闭按钮也在 DOM 里。
        page.locator(".el-drawer__close-btn:visible").first.click()
        page.wait_for_timeout(500)

        # ─────────── 5c. 笔记 ───────────
        print("\n▶ 笔记")

        # 清掉进度和笔记，换一个完全确定的起点。
        # 注意：只改 hash 的 goto 不会重新加载文档，所以必须 reload 才能让 store 重读 localStorage。
        page.evaluate(
            "['progress','session','notes'].forEach(k => "
            "localStorage.removeItem(`quiz:v1:${k}:maogai`))"
        )
        page.reload(wait_until="load")
        page.wait_for_timeout(1700)
        check(page.locator("text=还没有开始练习").count() > 0, "清掉进度后回到空态")
        page.locator("text=去选题库").first.click()
        page.wait_for_timeout(1400)
        page.locator("text=顺序练习").first.click()
        page.wait_for_timeout(1700)
        check(page.locator(".q-qc__verdict").count() == 0, "笔记测试起点：第 1 题未作答")

        note_text = "笔记测试：关键在「归根到底是」后面，别选成单个『马克思主义行』"

        page.keyboard.press("N")
        page.wait_for_timeout(700)
        check(page.locator(".q-note-edit textarea").count() > 0, "按 N 打开了笔记编辑器")
        check(
            page.evaluate(
                "document.activeElement && document.activeElement.tagName === 'TEXTAREA'"
            ),
            "编辑器自动获得焦点（ref 挂在 DOM 上才对）",
        )

        page.locator(".q-note-edit textarea").fill(note_text)
        page.keyboard.press("Control+Enter")  # 快捷键保存
        page.wait_for_timeout(800)
        check(page.locator(".q-qc__noteread").count() > 0, "保存后题目下方出现笔记卡片")
        check(page.locator(".q-qc__act.is-note").count() > 0, "右上角笔记按钮变成「已有笔记」态")
        check(page.locator(".q-sheet__dot").count() > 0, "答题卡上这一题出现笔记小圆点")

        # 还没作答时笔记必须是收起的 —— 否则自己的笔记就把答案剧透了
        check(
            page.locator(".q-qc__noteread-body").count() == 0,
            "★ 未作答时笔记默认收起（不剧透答案）",
        )
        page.locator(".q-qc__noteread-head").first.click()
        page.wait_for_timeout(400)
        check(page.locator(".q-qc__noteread-body").count() > 0, "点一下能展开看笔记正文")
        shown = page.locator(".q-qc__noteread").first.inner_text()
        check(note_text[:10] in shown, f"笔记正文显示正确（{shown.replace(chr(10), ' ')[:40]}）")

        # 作答（故意答错，让错题本里至少有一条，后面的错题本用例才有东西看）
        page.locator(".q-opt").nth(1).click()
        page.wait_for_timeout(700)
        check(page.locator(".q-qc__verdict").count() > 0, "作答后出现判定条")

        # 刷新后还在（说明真的落到了 localStorage）
        page.reload(wait_until="load")
        page.wait_for_timeout(1800)
        check(page.locator(".q-qc__noteread").count() > 0, "刷新后笔记仍然在")

        # 复习本 → 笔记标签页
        page.goto(BASE + "/#/review", wait_until="load")
        page.wait_for_timeout(1500)
        note_tab = page.locator(".q-rv__tab", has_text="笔记")
        check(note_tab.count() > 0, "复习本里多了「笔记」标签页")
        note_tab.first.click()
        page.wait_for_timeout(700)
        check(page.locator(".q-rv__note").count() > 0, "笔记标签页列出了这条笔记")
        badge = note_tab.first.locator("em").inner_text().strip()
        check(badge == "1", f"笔记计数为 1（实际 {badge}）")

        # 按笔记正文搜索（不是只搜题干）
        page.locator(".q-rv__search input").fill("归根到底")
        page.wait_for_timeout(700)
        check(page.locator(".q-rv__item").count() == 1, "按笔记正文能搜到")
        page.locator(".q-rv__search input").fill("")
        page.wait_for_timeout(500)
        page.screenshot(path=OUT / "12-notes.png", full_page=True)

        # 在笔记页里直接改
        page.locator(".q-rv__item-head").first.click()
        page.wait_for_timeout(700)
        check(page.locator(".q-rv__notewrap").count() > 0, "展开后有笔记编辑入口")
        page.locator(".q-rv__notewrap .el-button").first.click()
        page.wait_for_timeout(600)
        check(page.locator(".q-rv__notewrap textarea").count() > 0, "笔记页里能直接编辑")
        page.locator(".q-rv__notewrap textarea").fill("改过的笔记内容")
        page.keyboard.press("Control+Enter")
        page.wait_for_timeout(800)
        changed = page.locator(".q-rv__note").first.inner_text()
        check("改过的笔记内容" in changed, "在笔记页改完立刻生效")

        # 导出 Markdown
        page.locator(".q-rv__bar-actions .el-button", has_text="复制 Markdown").first.click()
        page.wait_for_timeout(900)
        check(page.locator(".el-message").count() > 0, "导出按钮给出反馈提示")

        # 回到刷题页，笔记依然显示
        page.goto(BASE + "/#/practice", wait_until="load")
        page.wait_for_timeout(1500)
        check(page.locator(".q-qc__noteread").count() > 0, "回到刷题页笔记依然显示")

        # ─────────── 5d. 知识图谱（力导向 + 弱点热力 + 点节点筛选刷题）───────────
        print("\n▶ 知识图谱")

        def canvas_ink() -> int:
            """数画布上的不透明像素。

            为什么不用 DOM 断言：力导向布局是画在 <canvas> 上的，节点/边在 DOM 里
            **根本不存在**，`locator` 数不到。只断言"canvas 元素存在"等于没验 ——
            画布全空也满足。数像素才能证明"真的画出来了"。
            """
            return page.evaluate(
                """() => {
                    const c = document.querySelector('.q-gp__canvas');
                    if (!c) return -1;
                    const g = c.getContext('2d');
                    if (!g) return -1;
                    const d = g.getImageData(0, 0, c.width, c.height).data;
                    let n = 0;
                    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
                    return n;
                }"""
            )

        page.goto(BASE + "/#/graph", wait_until="load")
        page.reload(wait_until="load")
        try:
            page.wait_for_selector(".q-gp__title", timeout=20000)
        except Exception:  # noqa: BLE001
            pass
        check(page.locator(".q-gp__title").count() > 0, "图谱页渲染出来了")
        check(page.locator(".q-gp__canvas").count() > 0, "力导向画布（canvas）在")

        # 图例：未做过 + 4 个弱点等级 + 有错题红环
        check(
            page.locator(".q-gp__legend .q-gp__dot").count() >= 5,
            f"图例 5 档弱点色（未做过 + 4 级），实际 {page.locator('.q-gp__legend .q-gp__dot').count()}",
        )
        check(page.locator(".q-gp__legend .q-gp__ring").count() > 0, "图例有「有错题」红环")

        # 没生成前：空态盖在画布上，画布工具全禁用（这些是负向断言，证明状态是自洽的）
        check(page.locator(".q-gp__stage-empty").count() > 0, "未生成时是空态（不是白屏、不报错）")
        disabled = page.locator(".q-gp__tools .el-button.is-disabled").count()
        check(disabled >= 4, f"未生成时画布工具禁用（{disabled} 个）")
        ink_before = canvas_ink()
        check(ink_before == 0, f"未生成时画布是空的（不透明像素 {ink_before}）")
        check(
            page.locator(".q-gp__side .q-gp__box-title").count() >= 2,
            "侧栏有「点一个知识点」和「最该补的知识点」两块",
        )
        page.screenshot(path=OUT / "15-graph-empty.png", full_page=True)

        backend_ok = page.evaluate(
            "() => fetch('/api/quiz/status/', {credentials: 'same-origin'})"
            ".then(r => r.ok).catch(() => false)"
        )
        print(f"  · 后端可用：{backend_ok}（不可用时这页只显示空态，这是设计）")

        # 真调 AI 生成。⚠️ 默认不开：会花云端额度，而且「先本机」策略下
        # 本机模型要算几十秒到几分钟。要做完整验收就设 QUIZ_SHOOT_AI=1。
        if not backend_ok:
            print("  · 跳过生成：没有后端，图谱是 AI 接口")
        elif (os.environ.get("QUIZ_SHOOT_AI") or "").strip() != "1":
            print("  · 跳过生成：设 QUIZ_SHOOT_AI=1 才会真调 AI（会花额度、可能要几分钟）")
        else:
            print("  · 正在调 AI 归纳（先本机 → 不合格才升云端，可能要几分钟）…")
            page.locator(".q-gp__panel .el-button", has_text="生成").first.click()
            generated = True
            try:
                page.locator(".q-gp__stage-empty").wait_for(state="detached", timeout=420000)
            except Exception:  # noqa: BLE001
                generated = False
            check(generated, "AI 归纳成功，空态消失（超时 420s）")
            if generated:
                page.wait_for_timeout(2500)  # 让力模拟跑几十帧，别在 t=0 就数像素
                ink_after = canvas_ink()
                check(ink_after > 2000, f"画布真的画出了节点/边（不透明像素 {ink_after}）")
                check(
                    page.locator(".q-gp__tools .el-button.is-disabled").count() == 0,
                    "生成后画布工具全部可用",
                )
                check(
                    page.locator(".q-gp__error").count() == 0,
                    "没有错误提示条",
                    page.locator(".q-gp__error").first.inner_text() if page.locator(".q-gp__error").count() else "",
                )
                warns = page.locator(".q-gp__warn li").count()
                print(f"  · 后端丢弃警告 {warns} 条（模型给的边有悬空时会有）")
                page.screenshot(path=OUT / "16-graph.png", full_page=True)

                # ── 用**真实鼠标**点一下画布上的节点。
                # 节点画在 canvas 里、DOM 里根本不存在，所以「点节点」这条路
                # 只能真点。布局是力模拟跑出来的、帧数不定，不能猜坐标 ——
                # 改成先从像素里**找一个节点**：横向连续不透明 ≥26px、且该列
                # 纵向不透明 ≥22px 的实心块（节点半径 13~32，边是细线不满足），
                # 再按 canvas 内部尺寸↔CSS 尺寸的比例换算成页面坐标。
                def find_node_px():
                    """从画布像素里找一个节点的位置（内部像素坐标）。

                    节点画在 canvas 里、DOM 里根本不存在，所以「点节点」只能真点。
                    布局是力模拟跑出来的，没有 DOM 可查，所以从**像素**反推：
                    横向连续不透明 ≥26px、且该列纵向不透明 ≥22px 的实心块
                    （节点半径 13~32；边是细线、文字不成块，都不满足）。
                    """
                    return page.evaluate(
                        """() => {
                            const c = document.querySelector('.q-gp__canvas');
                            const g = c.getContext('2d');
                            const W = c.width, H = c.height;
                            const d = g.getImageData(0, 0, W, H).data;
                            const solid = (x, y) => d[(y * W + x) * 4 + 3] > 200;
                            for (let y = 4; y < H - 4; y += 2) {
                                let run = 0, start = 0;
                                for (let x = 0; x <= W; x++) {
                                    if (x < W && solid(x, y)) { if (!run) start = x; run++; continue; }
                                    if (run >= 26) {
                                        const cx = Math.round(start + run / 2);
                                        let col = 0;
                                        for (let yy = 0; yy < H; yy++) if (solid(cx, yy)) col++;
                                        if (col >= 22) return {px: cx, py: y, w: W, h: H};
                                    }
                                    run = 0;
                                }
                            }
                            return null;
                        }"""
                    )

                # ⚠️ 不能只赌一次：力模拟还在收敛，扫完像素到点下去之间节点会漂走
                # （实测：同一份代码在 14 节点的图上过、在别的图上失败）。
                # 改成「扫一次 → 点一次 → 检查」，最多试 6 轮，让布局先稳下来。
                box = page.locator(".q-gp__canvas").bounding_box()
                hit_canvas_node = False
                for attempt in range(6):
                    spot = find_node_px()
                    if not spot or not box:
                        break
                    page.mouse.click(
                        box["x"] + spot["px"] * box["width"] / spot["w"],
                        box["y"] + spot["py"] * box["height"] / spot["h"],
                    )
                    page.wait_for_timeout(350)
                    if page.locator(".q-gp__metrics .q-gp__metric").count() == 3:
                        hit_canvas_node = True
                        print(f"  · 第 {attempt + 1} 轮扫到并点中了节点")
                        break
                    page.wait_for_timeout(300)
                if not spot or not box:
                    print("  · 跳过画布点选：没能从像素里定位到节点")
                else:
                    check(
                        hit_canvas_node,
                        "在画布上用真实鼠标点一下节点就选中了（指针命中检测通了）",
                    )

                # 点节点 → 侧栏出指标 + 「刷这个知识点（N 题）」
                # 画布里的节点点不到（没有 DOM），所以走侧栏「最该补的知识点」——
                # 它调的是**同一个** selectNode，等价于点了画布上的节点。
                weak = page.locator(".q-gp__weak-item")
                if weak.count() == 0:
                    print(
                        "  · 跳过「点节点筛选刷题」：侧栏弱项列表为空"
                        "（需要图谱节点名对上题目标签、且该知识点有作答记录）"
                    )
                else:
                    weak.first.click()
                    page.wait_for_timeout(700)
                    check(
                        page.locator(".q-gp__metrics .q-gp__metric").count() == 3,
                        "选中节点后侧栏出 3 个指标（正确率/做过/错题）",
                    )
                    practice_btn = page.locator(".q-gp__acts .el-button").first
                    label = practice_btn.inner_text().strip().replace("\n", " ")
                    check("刷这个知识点" in label, f"出现「刷这个知识点」按钮：{label[:30]}")
                    imported = int("".join(ch for ch in label if ch.isdigit()) or 0)
                    if imported == 0:
                        print("  · 跳过进入练习：这个知识点没筛到题（按钮是禁用的）")
                    else:
                        practice_btn.click()
                        page.wait_for_timeout(1800)
                        check(
                            page.locator(".q-qc, .q-pv").count() > 0,
                            f"点一下真的进了练习（该知识点筛出 {imported} 题）",
                        )
                        page.screenshot(path=OUT / "17-graph-practice.png", full_page=True)
                page.evaluate("window.scrollTo(0, 0)")

        # ─────────── 5e. 图笔记（draw.io 式画布 + Mermaid 导出/导入）───────────
        print("\n▶ 图笔记")

        def exported_shape() -> tuple[int, int]:
            """从导出的 Mermaid 里数节点和边。

            为什么不读界面上那个计数：那是视图自己算的，**用它验它自己**等于没验。
            导出文本是 `toMermaid` 按真实数据生成的，而且导出→导入往返是用户
            真正会用的路径，所以拿它当基准更硬。
            """
            text = page.locator(".q-dg__mermaid-text").input_value()
            nodes = edges = 0
            for line in text.splitlines():
                s = line.strip()
                if not s or s.startswith("flowchart"):
                    continue
                # 节点声明单独一行（n1["文本"] / n2(("文本")) …），边是 a --> b
                if "-->" in s:
                    edges += 1
                else:
                    nodes += 1
            return nodes, edges

        page.goto(BASE + "/#/diagram", wait_until="load")
        page.reload(wait_until="load")
        try:
            page.wait_for_selector(".q-dg", timeout=20000)
        except Exception:  # noqa: BLE001
            pass
        check(page.locator(".q-dg").count() > 0, "图笔记页渲染出来了")
        check(page.locator(".q-dg__canvas").count() > 0, "画布在")
        check(page.locator(".q-dg__count").count() > 0, "有节点/边计数显示")
        check(page.locator(".q-dg__empty").count() > 0, "还没有图时是空态（不是白屏）")
        check(exported_shape() == (0, 0), f"空态下导出是空图 {exported_shape()}")

        dbox = page.locator(".q-dg__canvas").bounding_box()
        if not dbox:
            check(False, "拿到画布尺寸")
        else:
            # 双击空白处新建节点（约定的交互）
            page.mouse.dblclick(dbox["x"] + 130, dbox["y"] + 110)
            page.wait_for_timeout(600)
            page.mouse.dblclick(dbox["x"] + 430, dbox["y"] + 280)
            page.wait_for_timeout(600)
            made = exported_shape()
            check(made[0] >= 2, f"双击空白处能建节点（导出里 {made[0]} 个）")
            page.screenshot(path=OUT / "18-diagram.png", full_page=True)

            head = (page.locator(".q-dg__mermaid-text").input_value() or "").strip().splitlines()
            check(head and head[0].startswith("flowchart"), f"导出以 flowchart 开头：{head[0] if head else '(空)'}")
            check("[" in "\n".join(head) or "(" in "\n".join(head), "导出里有节点声明（括号形状）")

            page.locator("button", has_text="复制 Mermaid").first.click()
            page.wait_for_timeout(800)
            check(page.locator(".el-message").count() > 0, "「复制 Mermaid」给出反馈提示")

            # 撤销 / 重做
            page.locator("button", has_text="撤销").first.click()
            page.wait_for_timeout(600)
            undone = exported_shape()[0]
            check(undone == made[0] - 1, f"撤销少了一个节点（{made[0]} → {undone}）")
            page.locator("button", has_text="重做").first.click()
            page.wait_for_timeout(600)
            check(exported_shape()[0] == made[0], f"重做回来了（{exported_shape()[0]}）")

            # 导入 Mermaid → 还原成图；含三种形状和一条带标签的边
            page.locator(".q-dg__import-text").fill(
                'flowchart TD\n  A[甲概念] -->|"指向"| B(乙概念)\n  B --> C{丙判断}'
            )
            page.locator("button", has_text="导入").first.click()
            page.wait_for_timeout(900)
            imported = exported_shape()
            check(imported == (3, 2), f"导入 Mermaid 还原成 3 节点 2 边（实际 {imported}）")
            text2 = page.locator(".q-dg__mermaid-text").input_value()
            check(
                "甲概念" in text2 and "乙概念" in text2 and "丙判断" in text2,
                "导入的文本能原样再导出（往返一致）",
            )
            check("指向" in text2, "边标签也保住了")
            page.screenshot(path=OUT / "19-diagram-mermaid.png", full_page=True)

            # 刷新后图还在（持久化到 localStorage）
            page.reload(wait_until="load")
            page.wait_for_timeout(1400)
            check(exported_shape() == (3, 2), f"刷新后图还在（{exported_shape()}）")

        # ─────────── 5f. PDF 一键转题库（真 PDF，走板子后端）───────────
        # 这是给「不知道 JSON 是什么」的人准备的主路径，必须端到端验一遍：
        # 浏览器 pdf.js 抽文字 → 板子上的规则解析 → 直接变成能刷的题库。
        # 用环境变量指定真 PDF：$env:QUIZ_TEST_PDF="D:\...\题库.pdf"
        pdf_path = (os.environ.get("QUIZ_TEST_PDF") or "").strip()
        print("\n▶ PDF 一键转题库")
        if not pdf_path or not Path(pdf_path).is_file():
            print(f"  · 跳过（没给 QUIZ_TEST_PDF，或文件不存在：{pdf_path or '未设置'}）")
        else:
            page.goto(BASE + "/#/", wait_until="load")
            page.wait_for_timeout(1600)
            check(page.locator(".q-tools").count() > 0, "首页出现「题库工具」面板")

            status_text = page.locator(".q-tools__status").inner_text().strip()
            print(f"  · 后端状态：{status_text}")
            # 纯静态部署（比如本地项目的 /test/index/、或直接起个 http.server）
            # 是没有后端的。那种情况下 PDF 走不通是**正确行为**，
            # 但必须验「降级是否体面」：提示是不是人话、.json 是不是仍然能用。
            offline = "连不上后端" in status_text

            # 切到「导入 PDF / JSON」页签
            page.locator(".q-tools__tab", has_text="导入 PDF").first.click()
            page.wait_for_timeout(400)

            before_cards = page.locator(".q-bank").count()
            page.set_input_files(".q-tools__drop input[type=file]", pdf_path)

            # 抽文字 + 解析，最多等 100 秒（板子走 Tailscale，慢）
            deadline = 100
            waited = 0
            while waited < deadline:
                page.wait_for_timeout(1000)
                waited += 1
                if page.locator(".q-tools__result").count() > 0:
                    break
                if page.locator(".el-message--error").count() > 0:
                    break

            err = page.locator(".el-message--error").count()
            if offline:
                check(err > 0, "没有后端时，拖 PDF 会明确报错（而不是默默失败）")
                if err:
                    err_text = page.locator(".el-message--error").first.inner_text()
                    print(f"  · 降级提示：{err_text.strip()[:100]}")
                    check("JSON" in err_text, "提示里给出了可行替代（.json 仍可本地导入）")
                # 关键：没有后端，JSON 导入必须照常可用
                sample = TMP / "no-backend.json"
                sample.write_text(
                    json.dumps(
                        [{"题目": "无后端测试题", "选项": ["甲", "乙"], "正确答案": "B"}],
                        ensure_ascii=False,
                    ),
                    encoding="utf-8",
                )
                page.set_input_files(".q-tools__drop input[type=file]", str(sample))
                page.wait_for_timeout(1800)
                check(
                    page.locator(".q-bank").count() > before_cards,
                    "★ 没有后端时 .json 导入照常可用（本地解析不依赖服务器）",
                )
            elif err:
                check(False, f"导入报错：{page.locator('.el-message--error').first.inner_text()[:120]}")
            else:
                check(page.locator(".q-tools__result").count() > 0, f"导入完成（用了 {waited}s）")
                if page.locator(".q-tools__result").count():
                    summary = page.locator(".q-tools__result").first.inner_text().replace("\n", " ")
                    print(f"  · 结果：{summary[:120]}")
                    check("224" in summary, f"识别出 224 道题（{summary[:50]}）")
                    check("规则解析" in summary, "走的是规则解析（没花 AI 的钱）")
                check(
                    page.locator(".q-bank").count() > before_cards,
                    f"题库列表多了一套（{before_cards} → {page.locator('.q-bank').count()}）",
                )
                check(page.locator(".q-bank.is-current").count() > 0, "导入的题库标成了「当前」")
                # 导入后它就是当前题库，直接能开刷
                page.locator("#q-start").scroll_into_view_if_needed()
                page.wait_for_timeout(400)
                page.locator("text=顺序练习").first.click()
                page.wait_for_timeout(1700)
                check(page.locator(".q-qc__stem").count() > 0, "导入的 PDF 题库能进入刷题")
                page.screenshot(path=OUT / "13-pdf-import.png", full_page=True)

        # ─────────── 5e. 学习报告 ───────────
        print("\n▶ 学习报告")
        # 上一步导入的 PDF 题库变成了当前题库，而它**还没有作答历史** ——
        # 报告是「按题库」统计的，所以先切回前面一直在刷的内置题库。
        # （这不是 bug：新导入的题库报告为空是正确行为，只是测试要固定住前提。）
        page.evaluate("localStorage.setItem('quiz:v1:lastBank', JSON.stringify('maogai'))")
        page.goto(BASE + "/#/report", wait_until="load")
        page.reload(wait_until="load")
        # 只改 hash 的跳转不会重载文档，路由是异步加载组件的 ——
        # 必须显式等元素出现，不能靠固定 sleep（踩过：偶尔还没挂载完就断言，误报失败）
        try:
            page.wait_for_selector(".q-rp__title", timeout=20000)
        except Exception:  # noqa: BLE001
            pass
        check(page.locator(".q-rp__title").count() > 0, "报告页渲染出来了")

        has_data = page.locator(".q-rp__stats").count() > 0
        check(has_data, "前面答过题，所以显示统计而不是空态")
        if has_data:
            overview = [
                s.replace("\n", " ") for s in page.locator(".q-rp__stat").all_inner_texts()
            ]
            print(f"  · 总览：{' | '.join(overview)}")

            total_text = page.locator(".q-rp__stat b").first.inner_text().strip()
            check(total_text.isdigit() and int(total_text) > 0, f"累计作答 = {total_text}（> 0）")

            # 热力图：26 周 × 7 天
            cells = page.locator(".q-rp__heat rect").count()
            check(cells >= 26 * 7, f"热力图格子数 {cells} ≥ 182（26 周 × 7 天）")

            # 趋势图：柱 + 点；折线要至少两天数据才画得出来（今天全做完也只有一天）
            check(page.locator(".q-rp__trend").count() > 0, "趋势图 SVG 画出来了")
            check(page.locator(".q-rp__dot").count() > 0, "正确率有数据点（至少画成了点）")
            check(page.locator(".q-rp__bar").count() > 0, "题量柱状在")
            check(page.locator(".q-rp__ref").count() > 0, "60% 参考线在")
            dots = page.locator(".q-rp__dot").count()
            line = page.locator(".q-rp__line").count()
            print(f"  · 趋势图：{dots} 个数据点，折线{'已' if line else '未'}绘制（<2 天时按设计不画线）")
            check(line > 0 or dots < 2, f"折线与数据点自洽（点 {dots} / 线 {line}）")

            # 弱项排行 / 题型 / 耗时
            check(page.locator(".q-rp__types li").count() > 0, "题型统计有内容")
            check(page.locator(".q-rp__timing div").count() == 3, "耗时三项（中位数/平均/样本数）都在")
            check(
                page.locator(".q-rp__ranks li, .q-rp__hint").count() > 0,
                "弱项排行区有内容（或有「样本不够」的说明）",
            )
            page.screenshot(path=OUT / "14-report.png", full_page=True)

        # 清空学习记录 → 应回到空态（而不是画一堆 0）
        page.evaluate("localStorage.removeItem('quiz:v1:history:maogai')")
        page.reload(wait_until="load")
        try:
            page.wait_for_selector(".q-rp__title", timeout=20000)
        except Exception:  # noqa: BLE001
            pass
        check(page.locator("text=还没有作答记录").count() > 0, "清空学习记录后回到空态")

        # ─────────── 5f. 题库修正（改答案 / 改解析 / 恢复） ───────────
        print("\n▶ 题库修正（答案/解析可改）")
        page.evaluate("localStorage.setItem('quiz:v1:lastBank', JSON.stringify('maogai'))")
        page.goto(BASE + "/#/", wait_until="load")
        page.reload(wait_until="load")
        page.wait_for_selector(".q-bank", timeout=20000)
        # 进顺序练习，点「不会，看答案」→ 判错（这样才有判定条和修改入口）
        page.locator(".q-mode", has_text="顺序练习").first.click()
        page.wait_for_selector(".q-qc", timeout=20000)
        page.wait_for_timeout(600)
        page.locator("button", has_text="看答案").first.click()
        page.wait_for_timeout(900)

        check(page.locator(".q-qc__fix").count() > 0, "判定后出现「题库修正」工具条")
        for label in ("改答案", "改解析", "重新生成解析"):
            check(page.locator(".q-qc__fixbtn", has_text=label).count() > 0, f"工具条里有「{label}」")

        # 读出判定条上的正确答案
        correct = page.locator(".q-qc__verdict-sub b").first.inner_text().strip()
        print(f"  · 判定条上的正确答案：{correct}")
        page.locator(".q-qc__fixbtn", has_text="改答案").first.click()
        page.wait_for_timeout(500)
        keys = page.locator(".q-qc__keys .q-qc__key")
        check(keys.count() > 0, "答案编辑器给出了可点选的选项")
        # 编辑器应该**预先把当前答案勾上**（不然用户得自己猜现在是什么）
        check(
            page.locator(".q-qc__keys .q-qc__key.is-on").count() > 0,
            "编辑器预勾了当前正确答案",
        )

        # 挑一个**不是**当前答案的键，改成它 —— 正确答案显示必须跟着变
        all_keys = [k.strip() for k in keys.all_inner_texts()]
        other = next((k for k in all_keys if correct not in k), None)
        check(other is not None, f"有别的选项可选（{all_keys}）")
        if other:
            page.locator(".q-qc__keys .q-qc__key", has_text=other).first.click()
            page.locator("button", has_text="保存并重判").first.click()
            page.wait_for_timeout(1000)
            after = page.locator(".q-qc__verdict-sub b").first.inner_text().strip()
            check(after != correct, f"★ 改答案后判定条上的正确答案跟着变了（{correct} → {after}）")
            check(page.locator(".q-qc__fixmark").count() > 0, "出现「已修正」标记")
            check(
                page.locator(".q-qc__fixbtn", has_text="恢复题库原文").count() > 0,
                "出现「恢复题库原文」入口",
            )

        # 改解析
        page.locator(".q-qc__fixbtn", has_text="改解析").first.click()
        page.wait_for_timeout(500)
        box = page.locator(".q-qc__fixbox textarea").first
        check(box.count() > 0, "解析编辑器（textarea）出现了")
        box.fill("浏览器验收写入的解析")
        page.locator("button", has_text="保存").first.click()
        page.wait_for_timeout(800)
        check(
            "浏览器验收写入的解析" in page.locator(".q-qc__analysis").first.inner_text(),
            "手写解析保存后立刻显示在解析区",
        )

        # 刷新后仍在（存的是 localStorage）
        page.reload(wait_until="load")
        page.wait_for_selector(".q-qc", timeout=20000)
        page.wait_for_timeout(900)
        check(
            "浏览器验收写入的解析" in page.locator(".q-qc__analysis").first.inner_text(),
            "刷新后手写解析仍在",
        )

        # 恢复题库原文
        page.locator(".q-qc__fixbtn", has_text="恢复题库原文").first.click()
        page.wait_for_timeout(900)
        check(
            page.locator(".q-qc__verdict-sub b").first.inner_text().strip() == correct,
            "恢复后正确答案回到题库原文",
        )
        check(page.locator(".q-qc__fixmark").count() == 0, "恢复后「已修正」标记消失")
        page.screenshot(path=OUT / "15-fix-question.png", full_page=True)

        # ─────────── 5g. 可切换背景 ───────────
        print("\n▶ 可切换背景")
        page.locator(".q-iconbtn").last.click()  # 打开设置抽屉
        page.wait_for_timeout(700)
        check(page.locator("text=背景").count() > 0, "设置里有「背景」这一项")
        check(page.locator(".q-bg").count() > 0, "背景层挂载在页面上")

        def pick_bg(label):
            page.locator(".q-seg__item", has_text=label).first.click()
            page.wait_for_timeout(900)

        # 极光：纯 CSS，不建 canvas
        pick_bg("极光")
        check(page.locator(".q-bg--aurora").count() > 0, "切到极光：背景层变成 aurora")
        check(page.locator(".q-bg__canvas").count() == 0, "极光不需要 canvas（纯 CSS 省性能）")

        # 星点：要建 canvas 并真的往上画东西
        pick_bg("星点")
        check(page.locator(".q-bg--stars .q-bg__canvas").count() > 0, "切到星点：出现 canvas")
        painted = page.evaluate(
            """() => {
              const c = document.querySelector('.q-bg__canvas');
              if (!c || !c.width) return 0;
              const ctx = c.getContext('2d');
              const d = ctx.getImageData(0, 0, c.width, c.height).data;
              let n = 0;
              for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
              return n;
            }"""
        )
        check(painted > 0, f"星点真的画上去了（非透明像素 {painted} 个）")

        # 背景不能挡住点击 —— 这条比好不好看重要
        blocked = page.evaluate(
            """() => {
              const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
              return !!(el && el.closest('.q-bg'));
            }"""
        )
        check(not blocked, "★ 背景层不吃点击（命中测试落在正文上）")

        # 星云：拿不到 WebGL 时应该自动退回极光，而不是留块黑
        pick_bg("星云")
        kind = page.evaluate("() => document.querySelector('.q-bg').className")
        check(
            "q-bg--webgl" in kind or "q-bg--aurora" in kind,
            f"星云模式：要么上了 WebGL，要么优雅退回极光（实际 {kind}）",
        )

        # 回到「无」：canvas 必须销毁，别留着空转烧电
        pick_bg("无")
        check(page.locator(".q-bg__canvas").count() == 0, "切回「无」后 canvas 被移除（不再烧电）")
        page.screenshot(path=OUT / "16-backgrounds.png", full_page=True)
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)

        # ── 「到底看不看得出来」——这才是这次的回归重点 ──────────────────
        # 上面那些断言（背景层在、canvas 在、不吃点击）**全都通过**，
        # 但用户的反馈是「开了跟没开一样」。根因：`blendFunc` 把 alpha 系数
        # 也用在 alpha 通道上，目标 alpha 变成 a²（0.34 → 0.116），
        # 再被 `.q-bg__veil` 压掉三成 —— 整屏与"无背景"只差 7/255。
        # 结构断言抓不到这种"在但看不见"，所以这里加**像素级**断言。
        if not HAS_PIL:
            print("  · 跳过背景可见度断言：没装 Pillow（pip install pillow 后重跑）")
        else:

            def bg_shot(mode, wait=2200):
                # 走 localStorage + 刷新，而不是一路点 UI：要连着切 5 次模式，
                # 每次开关设置抽屉容易和遮罩打架（抽屉会压住右下角元素，实测踩到）。
                page.evaluate(
                    """(m) => {
                        const k = 'quiz:v1:settings';
                        const cur = JSON.parse(localStorage.getItem(k) || '{}');
                        cur.background = m;
                        cur.backgroundIntensity = 1;
                        localStorage.setItem(k, JSON.stringify(cur));
                    }""",
                    mode,
                )
                page.reload(wait_until="load")
                page.wait_for_timeout(wait)  # 等动画跑几帧，别截到第一帧
                path = TMP / f"bgvis-{mode}.png"
                page.screenshot(path=str(path))
                return path

            # ⚠️ 先回到首页再测。这一步是必需的：此刻流程正停在**练习页**，
            # 那里大部分面积被不透明的题目/答题卡盖住，能露出背景的地方很少，
            # 实测丝缎只有 8.7%（首页是 55%）—— 紧贴下限、余量太小，容易变成偶发失败。
            # 固定到首页之后，背景可见面积大且各次一致，量出来的数才可比。
            page.goto(BASE + "/#/", wait_until="load")
            page.wait_for_timeout(1200)

            blank = bg_shot("none")

            # ── 懒加载：不玩背景的人不该为 three（约 750KB）买单 ──
            # 这条是"架构约束"而不是"好不好看"，所以单独断言。
            idle_res = page.evaluate("() => performance.getEntriesByType('resource').map((e) => e.name)")
            check(
                not any(("three" in u) or ("vanta" in u) for u in idle_res),
                "★ 没选 Vanta 时不加载 three/vanta（不玩背景的人不付这个体积）",
            )
            # 下限是照着"修好之后"的实测值放宽定的（修好：极光 10.5% / 丝缎 55% /
            # 星点 19.5% / 星云 54.5%；出 bug 时：10.5% / 5.2% / 0.0% / 0.1%）。
            # 所以这四个下限**确实能抓住那次回归**，又留了足够的机型差异余量。
            for mode, label, floor in (
                ("aurora", "极光", 3.0),
                ("aurora2", "极光·帘", 10.0),
                ("silk", "丝缎", 8.0),
                ("stars", "星点", 3.0),
                ("sparkles", "星芒", 8.0),
                ("wavy", "波浪", 5.0),
                ("webgl", "星云", 8.0),
            ):
                shot = bg_shot(mode)
                mean, pct = diff_stat(blank, shot)
                print(f"  · {label}: 与「无」平均差 {mean:.1f}/255，明显不同 {pct:.1f}%")
                check(pct >= floor, f"★ {label}背景真的看得出来（{pct:.1f}% ≥ {floor}%）")

            # ── Vanta 的五个 3D 效果 ──
            # 它们要**懒加载 three（约 750KB）**，所以等得久一点。
            # 下限按**两种主题里较差的那个**再放宽定（浅色 10.5%~57%，
            # 深色 18.4%~54%）—— 这一段流程跑在深色主题下（第 2 步设的），
            # 而深色恰恰是 Vanta 最容易"贴底看不见"的主题，所以按深色定。
            for mode, label, floor in (
                ("vanwaves", "海浪", 20.0),
                ("vanfog", "迷雾", 10.0),
                ("vanclouds", "云海", 20.0),
                ("vannet", "网格", 5.0),
                ("vancells", "细胞", 20.0),
            ):
                shot = bg_shot(mode, wait=5200)
                mean, pct = diff_stat(blank, shot)
                print(f"  · {label}: 与「无」平均差 {mean:.1f}/255，明显不同 {pct:.1f}%")
                check(pct >= floor, f"★ {label}（Vanta 3D）真的看得出来（{pct:.1f}% ≥ {floor}%）")

            # 选了 Vanta 之后，three/vanta 的 chunk 必须**真的**被拉下来了
            # （上面那条断言说"不选就不加载"，这条说"选了就加载"—— 两条都要，
            #   否则把功能整个删掉也能让上面那条通过）
            vanta_res = page.evaluate("() => performance.getEntriesByType('resource').map((e) => e.name)")
            check(
                any("three" in u for u in vanta_res) and any("vanta" in u for u in vanta_res),
                "★ 选了 Vanta 后确实懒加载了 three + vanta 的独立 chunk",
            )

            # ── 「减少动态效果」下也必须画得出东西 ──────────────────────
            # 这是用户实际报上来的 bug：系统开了「减少动态效果」时，代码在
            # **创建画布之前**就 `return` 了 —— 于是所有 canvas/WebGL 背景
            # **整屏纯白**（实测可见度 0.0%），而设置里还显示着"已选中"。
            # 正确的做法是画**一帧定格**（时间 uniform 给常量、不挂 rAF），
            # 而不是干脆不画。所以这里用一个 reduced_motion="reduce" 的独立
            # 上下文再量一遍 —— 不加这一段，这个 bug 永远不会被自动化发现。
            rm_ctx = browser.new_context(
                viewport={"width": 1280, "height": 800},
                locale="zh-CN",
                reduced_motion="reduce",
            )
            try:
                rm_page = rm_ctx.new_page()
                rm_page.goto(BASE + "/#/", wait_until="load")
                rm_page.wait_for_timeout(900)

                def rm_shot(mode):
                    rm_page.evaluate(
                        """(m) => {
                            const k = 'quiz:v1:settings';
                            const cur = JSON.parse(localStorage.getItem(k) || '{}');
                            cur.background = m;
                            cur.backgroundIntensity = 1;
                            localStorage.setItem(k, JSON.stringify(cur));
                        }""",
                        mode,
                    )
                    rm_page.reload(wait_until="load")
                    rm_page.wait_for_timeout(1800)
                    path = TMP / f"bgrm-{mode}.png"
                    rm_page.screenshot(path=str(path))
                    return path

                rm_blank = rm_shot("none")
                for mode, label, floor in (
                    ("silk", "丝缎", 20.0),
                    ("webgl", "星云", 20.0),
                    ("stars", "星点", 5.0),
                    ("wavy", "波浪", 5.0),
                ):
                    mean, pct = diff_stat(rm_blank, rm_shot(mode))
                    print(f"  · [少动效] {label}: 平均差 {mean:.1f}/255，明显不同 {pct:.1f}%")
                    check(
                        pct >= floor,
                        f"★ 开了「减少动态效果」时 {label} 仍有静态画面（{pct:.1f}% ≥ {floor}%）",
                    )
            finally:
                rm_ctx.close()

            # 留在极光（后面截图好看一点），强度回默认
            page.evaluate(
                """() => {
                    const k = 'quiz:v1:settings';
                    const cur = JSON.parse(localStorage.getItem(k) || '{}');
                    cur.background = 'aurora';
                    cur.backgroundIntensity = 0.6;
                    localStorage.setItem(k, JSON.stringify(cur));
                }"""
            )
            page.reload(wait_until="load")
            page.wait_for_timeout(1200)

        # ─────────── 5h. 网易云播放器 ───────────
        print("\n▶ 网易云播放器")
        page.locator(".q-iconbtn").last.click()  # 打开设置抽屉
        page.wait_for_timeout(700)
        check(page.locator("text=网易云播放器").count() > 0, "设置里有「网易云播放器」开关")
        # 默认必须是关的（突然出声很烦人，也会被浏览器拦）
        check(page.locator(".q-music").count() == 0, "默认不显示播放器（不是默认开）")

        # 打开开关 → 填一个 ID → 播放器出现
        page.locator(".q-set__row", has_text="网易云播放器").locator(".el-switch").first.click()
        page.wait_for_timeout(600)
        page.locator(".q-set__row", has_text="ID").locator("input").first.fill("186016")
        page.wait_for_timeout(600)
        check(page.locator(".q-music").count() > 0, "打开后右下角出现播放器入口")

        # ⚠️ 必须先关掉设置抽屉：它宽 380px 且贴右边，正好压住右下角的播放器按钮，
        # 不关的话 Playwright 会判定"元素被遮挡"而点不动（实测踩到）。
        page.keyboard.press("Escape")
        page.wait_for_timeout(600)

        # ── 拖动：这个按钮原来是 right/bottom 钉死的，**根本拖不动**（用户明确反馈过）──
        fab = page.locator(".q-music__fab").first
        box0 = fab.bounding_box()
        check(bool(box0) and box0["x"] > 500 and box0["y"] > 400, "播放器按钮默认在右下角")

        def drag_fab(to_x, to_y):
            b = fab.bounding_box()
            cx, cy = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
            page.mouse.move(cx, cy)
            page.mouse.down()
            page.mouse.move(to_x, to_y, steps=12)
            page.mouse.up()
            page.wait_for_timeout(450)
            nb = fab.bounding_box()
            return nb["x"] + nb["width"] / 2, nb["y"] + nb["height"] / 2

        tx = box0["x"] + box0["width"] / 2 - 380
        ty = box0["y"] + box0["height"] / 2 - 300
        nx, ny = drag_fab(tx, ty)
        check(abs(nx - tx) < 14 and abs(ny - ty) < 14, f"★ 按住能拖到放手的位置（落在 {nx:.0f},{ny:.0f}）")
        check(page.locator(".q-music__frame").count() == 0, "★ 拖完不会误触展开（拖动和单击分得开）")
        stored = page.evaluate(
            "() => JSON.parse(localStorage.getItem('quiz:v1:settings') || '{}').musicPos || null"
        )
        check(bool(stored and "rx" in stored), f"拖动后的位置落了盘（{stored}）")

        page.reload(wait_until="load")
        page.wait_for_timeout(1100)
        fab = page.locator(".q-music__fab").first
        rb = fab.bounding_box()
        check(
            abs(rb["x"] + rb["width"] / 2 - nx) < 16 and abs(rb["y"] + rb["height"] / 2 - ny) < 16,
            "★ 刷新后位置还在（存的是比例而不是像素，换窗口大小也不会跑丢）",
        )

        # 拖到上半屏：面板必须改成向下展开，否则会顶出屏幕
        drag_fab(rb["x"] + rb["width"] / 2, 70)

        # 展开 → iframe 出现，src 必须是对的官方外链、且是 https
        page.locator(".q-music__fab").first.click()
        page.wait_for_timeout(900)
        check(page.locator(".q-music.is-flipped").count() > 0, "★ 按钮在上半屏时面板向下展开（不顶出屏幕）")
        frame = page.locator(".q-music__frame")
        check(frame.count() > 0, "展开后出现嵌入的 iframe")
        if frame.count():
            src = frame.first.get_attribute("src") or ""
            print(f"  · src = {src}")
            check(src.startswith("https://music.163.com/outchain/player"), "用的是网易云官方外链")
            check("id=186016" in src, "ID 传对了")
            check("auto=0" in src, "★ auto=0：绝不自动播放")

        # 收起。⚠️ 必须按 title 精确定位：面板里现在有两个 .q-music__close ——
        # 一个「复位到右下角」、一个「收起」，而复位那个排在前面，
        # 用 .first 会点到复位（位置变了但面板没关），断言就会莫名其妙地失败。
        page.locator(".q-music__close[title='收起']").first.click()
        page.wait_for_timeout(500)
        check(page.locator(".q-music__frame").count() == 0, "点收起后 iframe 被移除（不后台挂着）")
        page.screenshot(path=OUT / "17-music.png", full_page=True)

        # 关掉开关，恢复原状（后面截图干净一点）
        page.locator(".q-iconbtn").last.click()
        page.wait_for_timeout(700)
        page.locator(".q-set__row", has_text="网易云播放器").locator(".el-switch").first.click()
        page.wait_for_timeout(500)
        check(page.locator(".q-music").count() == 0, "关掉开关后播放器消失")
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)

        # ─────────── 5i. 庆祝特效（彩花 / 连对）───────────
        # ⚠️ 这段刻意做得**最小侵入**：只验"不该爆的时候不爆"和硬性样式约束。
        # "答对旧错题要爆"的判定逻辑由引擎测试 C18/C19 覆盖得更严（10 条断言，
        # 包括连对 3 不爆、5/10/20 分三级、陈旧状态不能串场）。
        # 在浏览器里模拟"答对"需要先知道答案，而那会让测试读题库走后门 ——
        # 不如把这段留给确定的负向断言。
        print("\n▶ 庆祝特效")
        # ⚠️ 这段**刻意不答任何题**：一旦作答就会改动错题本，
        # 后面「错题本」那段的前提（"有 1 道错题"）就被破坏了（实测踩到：
        # 后面的 .q-rv__item-head 直接超时）。所以这里只验不会改变状态的东西。
        page.locator(".q-iconbtn").last.click()
        page.wait_for_timeout(700)
        check(page.locator("text=答题庆祝特效").count() > 0, "设置里有「答题庆祝特效」开关")
        page.keyboard.press("Escape")
        page.wait_for_timeout(500)
        check(
            page.locator(".q-celebrate-canvas").count() == 0,
            "没有触发时不存在粒子层（不会常驻后台）",
        )
        print("  · redeem / streak 的触发判定见引擎测试 C18/C19：")
        print("    答对旧错题→redeem；连对 5/10/20 分三级；连对 3 不爆；陈旧状态不串场")
        page.screenshot(path=OUT / "18-celebrate.png", full_page=True)

        # ─────────── 6. 错题本 ───────────
        print("\n▶ 错题本")
        # 把当前题库切回内置那套（PDF 那套是刚导入的，错题本是空的）。
        # 注意 lastBank 是 JSON 存的（save() 会 JSON.stringify），
        # 所以这里必须写成带引号的 JSON 字符串 —— 直接塞裸的 maogai 会让
        # JSON.parse 抛异常、然后这一项被清掉，等于没设。
        page.evaluate("localStorage.setItem('quiz:v1:lastBank', JSON.stringify('maogai'))")
        page.goto(BASE + "/#/review", wait_until="load")
        page.reload(wait_until="load")  # 只改 hash 不会重载文档，必须显式 reload
        page.wait_for_timeout(1800)
        check(
            "毛泽东思想和中国特色" in page.locator(".q-top__bank").first.inner_text(),
            "当前题库已切回内置那套",
        )
        check(page.locator("text=错题本").count() > 0, "错题本页面渲染")
        wrong_items = page.locator(".q-rv__item").count()
        check(wrong_items >= 1, f"错题本里有 {wrong_items} 道题")
        # 展开看解析
        page.locator(".q-rv__item-head").first.click()
        page.wait_for_timeout(600)
        check(page.locator(".q-rv__detail").count() > 0, "点击能展开题目详情")
        page.screenshot(path=OUT / "05-review.png", full_page=True)

        # ─────────── 7. 拖入一份「脏」JSON ───────────
        print("\n▶ 导入脏 JSON（最随意的写法）")
        messy = [
            {"题目": "导入测试：中国的武装斗争以谁为主体？", "选项": ["工人", "农民", "小资产阶级"], "正确答案": "B"},
            {"stem": "导入测试：五四运动促进了马克思主义传播。", "answer": "正确"},
            {"question": "导入测试：多选", "options": {"A": "甲", "B": "乙", "C": "丙"}, "answer": "AC"},
        ]
        sample = TMP / "messy-sample.json"
        sample.write_text(json.dumps(messy, ensure_ascii=False), encoding="utf-8")
        page.goto(BASE + "/#/", wait_until="load")
        page.wait_for_timeout(1200)
        page.set_input_files("input[type=file]", str(sample))
        page.wait_for_timeout(2000)
        check(
            page.locator(".q-bank", has_text="messy-sample").count() > 0,
            "导入的题库出现在首页",
        )
        check(
            page.locator("text=3 道题").count() > 0
            or page.locator(".q-bank__total", has_text="3").count() > 0,
            "识别出 3 道题（中文键名/判断题/映射选项都能吃）",
        )
        page.screenshot(path=OUT / "06-imported.png", full_page=True)

        # 用导入的题库刷一题，验证判断题 / 映射选项也能刷
        page.locator(".q-bank", has_text="messy-sample").locator(".q-bank__go").click()
        page.wait_for_timeout(1500)
        check(page.locator("#q-start").count() > 0, "导入的题库自动变成当前题库（组卷区出现）")
        page.locator("text=顺序练习").first.click()
        page.wait_for_timeout(1500)
        check("/practice" in page.url, "导入的题库也能进入刷题")
        check(page.locator(".q-qc__stem").count() > 0, "导入的题有题干")
        page.screenshot(path=OUT / "07-imported-practice.png", full_page=True)

        # ─────────── 8. 手机尺寸 ───────────
        print("\n▶ 移动端")
        page.set_viewport_size({"width": 400, "height": 860})
        page.wait_for_timeout(900)
        check(
            page.locator(".q-pv__side").is_visible() is False
            or page.locator(".q-sheet").count() == 0
            or not page.locator(".q-pv__side").is_visible(),
            "窄屏下右侧答题卡收起（改用抽屉）",
        )
        check(page.locator(".q-pbar__sheet").is_visible(), "窄屏出现「答题卡」按钮")
        page.screenshot(path=OUT / "08-mobile-practice.png", full_page=True)

        # ─────────── 9. 考试模式 ───────────
        print("\n▶ 模拟考试")
        page.set_viewport_size({"width": 1440, "height": 920})
        page.goto(BASE + "/#/", wait_until="load")
        page.wait_for_timeout(1300)
        page.locator("text=模拟考试").first.click()
        page.wait_for_timeout(1600)
        check("/practice" in page.url, "进入考试模式")
        check(page.locator(".q-pbar__timer").count() > 0, "考试倒计时显示出来了")
        timer = page.locator(".q-pbar__timer").inner_text().strip()
        check(":" in timer, f"倒计时格式正常（{timer}）")
        page.locator(".q-opt").first.click()
        page.wait_for_timeout(700)
        check(
            page.locator(".q-qc__verdict").count() == 0,
            "考试中作答不揭示答案（没有判定条）",
        )
        check(
            page.locator("text=考试模式").count() > 0,
            "考试中显示「交卷后才显示对错」的提示",
        )
        page.screenshot(path=OUT / "09-exam.png", full_page=True)

        # ─────────── 9b. 交卷 → 成就页 ───────────
        # 直接接着上面那场考试真交一次卷，走**真实路径**触发成就页 ——
        # 往 localStorage 里塞一个假会话当然更省事，但那样就没有验到
        # "交卷 → 成绩单 → 成就页"这条链本身。
        print("\n▶ 交卷后的成就页")
        page.locator(".q-pbar .el-button", has_text="交卷").first.click()
        page.wait_for_timeout(800)
        # 交卷确认弹窗
        page.locator(".el-message-box__btns .el-button--primary").first.click()
        # 彩花是"建了又回收"的（粒子衰亡后 canvas 会被 remove），所以要**等它出现**
        confetti = False
        try:
            page.wait_for_selector("canvas.q-celebrate-canvas", timeout=6000)
            confetti = True
        except Exception:  # noqa: BLE001
            pass
        page.wait_for_timeout(500)

        check(page.locator(".q-ach").count() == 1, "★ 交卷后成就页自动弹出来")
        if page.locator(".q-ach").count():
            title = page.locator(".q-ach__title").inner_text().strip()
            print(f"  · 评价：{title}")
            check(bool(title), "成就页有评价标题")
            check(page.locator(".q-ach__ring-value").count() == 1, "有正确率环")
            check(
                "%" in page.locator(".q-ach__ring-text b").inner_text(),
                "环上显示正确率",
            )
            tiles = page.locator(".q-ach__stats li")
            check(tiles.count() == 4, f"四项数据格（实际 {tiles.count()}）")
            check(confetti, "★ 弹出来时放了彩花")

            # ⚠️ 遮罩必须真的盖住顶栏。踩过：正文容器自己有 z-index:1 形成层叠上下文，
            # 遮罩写在里面时 z-index 再高也只在那一层里比大小，顶栏照样浮在上面。
            # 用命中测试验。
            # ⚠️ 探测点选**顶栏左侧**：刚交完卷会弹一个 ElMessage 提示，
            # 它固定在屏幕顶部居中 —— 探正中会探到那个提示，断言就会假失败。
            covered = page.evaluate(
                """() => {
                    const nav = document.querySelector('.q-top');
                    if (!nav) return null;
                    const r = nav.getBoundingClientRect();
                    const el = document.elementFromPoint(r.left + 40, r.top + r.height / 2);
                    return { cls: el ? String(el.className) : '', inAch: !!(el && el.closest('.q-ach')) };
                }"""
            )
            print(f"  · 顶栏左侧命中：{covered}")
            check(covered and covered["inAch"], "★ 遮罩真的盖住了顶栏（没被层叠上下文困住）")

            page.screenshot(path=OUT / "18-achievement.png", full_page=True)

            # 关掉之后成绩单还在下面（不是一起没了）
            page.locator(".q-ach__acts .el-button", has_text="先看解析").first.click()
            page.wait_for_timeout(600)
            check(page.locator(".q-ach").count() == 0, "关掉后成就页消失")
            check(page.locator(".q-res__actions").count() > 0, "★ 关掉后成绩单还在下面")

            # 成绩单上能重开
            page.locator(".q-res__actions .el-button", has_text="看成就页").first.click()
            page.wait_for_timeout(800)
            check(page.locator(".q-ach").count() == 1, "★ 点「看成就页」能重新打开")
            page.locator(".q-ach__acts .el-button", has_text="先看解析").first.click()
            page.wait_for_timeout(500)
            # 只弹一次：刷新后不该又弹（标记存在 session 里）
            page.reload(wait_until="load")
            page.wait_for_timeout(1400)
            check(page.locator(".q-ach").count() == 0, "★ 刷新后不再弹（看过就记住了）")
            check(page.locator(".q-res__actions").count() > 0, "刷新后看到的是成绩单")

        # ─────────── 10. file:// 实测（只记录事实，不作断言）───────────
        print("\n▶ file:// 直接打开 dist/index.html（实测，仅记录）")
        dist_index = (OUT.parent / "frontend" / "dist" / "index.html").resolve()
        if not dist_index.exists():
            print(f"  · 没找到构建产物 {dist_index}，跳过")
        else:
            probe = browser.new_context(viewport={"width": 1280, "height": 880}, locale="zh-CN")
            pp = probe.new_page()
            probe_errors: list[str] = []
            pp.on("console", lambda m: probe_errors.append(m.text) if m.type == "error" else None)
            pp.on("pageerror", lambda e: probe_errors.append(str(e)))
            pp.goto(dist_index.as_uri(), wait_until="load")
            pp.wait_for_timeout(2200)
            mounted = pp.locator(".q-brand").count() > 0
            n_banks = pp.locator(".q-bank").count()
            print(f"  · 应用挂载：{mounted}    首页题库卡片：{n_banks}")
            for e in probe_errors[:3]:
                print(f"  · 控制台：{e[:160]}")
            if mounted and n_banks:
                print("  · 结论：file:// 下可直接双击打开使用 ✓")
            else:
                print("  · 结论：浏览器不允许 file:// 加载 ES module，dist 需要用 http 提供")
                print("    （npm run preview / python -m http.server / nginx 都行）")
            probe.close()

        browser.close()

    # ─────────── 汇总 ───────────
    print("\n" + "═" * 56)
    bad = [l for okk, l in results if not okk]
    if errors:
        print(f"控制台/页面报错 {len(errors)} 条：")
        for e in errors[:25]:
            print("  " + e)
    else:
        print("控制台零报错 ✓")
    if not_found:
        uniq = sorted(set(not_found))
        print(f"404 的资源 {len(not_found)} 次 / {len(uniq)} 个不同 URL：")
        for u in uniq[:12]:
            print("  " + u.replace(BASE, ""))
    if bad:
        print(f"❌ 视觉验收失败：{len(results) - len(bad)} 通过 / {len(bad)} 失败")
        for l in bad:
            print("   - " + l)
        return 1
    print(f"✅ 视觉验收全部通过：{len(results)} 项")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
