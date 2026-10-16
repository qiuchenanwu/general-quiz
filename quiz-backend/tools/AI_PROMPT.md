# 把题库 PDF 变成刷题 JSON —— 给 AI 的提示词

这个项目有**两条路**，先挑对的那条：

| 情况 | 用哪条路 |
|---|---|
| PDF 是「电子版」（能选中文字、复制得出来），排版规整 | **走 `pdf_to_json.py` 规则解析**，不用 AI。可复现、可校验、不会瞎编答案。 |
| PDF 是扫描件 / 图片 / 排版乱到规则啃不动 | **走 AI**，用下面的提示词。 |

> ⚠️ 先试规则解析。`python tools/pdf_to_json.py 题库.pdf --dry-run` 会告诉你解析到多少题、
> 有没有题号缺失、有没有答案越界。如果报告是 ✅，就别再让 AI 重做一遍了 ——
> AI 有概率**改动题干甚至编错答案**，而规则解析不会。

---

## 路线 A：规则解析（推荐，本仓库已用这条路跑通 224 题）

```powershell
# 先看报告，不写文件
python tools/pdf_to_json.py "题库.pdf" --dry-run

# 确认无误后产出 JSON
python tools/pdf_to_json.py "题库.pdf" -o frontend/src/banks/我的题库.json `
  --id mybank --title "我的题库" --subject "某某概论"
```

产出的 JSON 直接丢进 `frontend/src/banks/` 就算上架了 —— 前端启动时会自动扫描这个目录，
不需要再登记任何清单。开发模式（`npm run dev`）下刷新即可，出构建产物则再跑一次
`npm run build`。

---

## 路线 B：交给 AI（扫描件 / 排版混乱 / 想顺便生成解析）

### 步骤 1：先把 PDF 变成纯文本

```powershell
python -c "import fitz,sys; d=fitz.open(sys.argv[1]); open('dump.txt','w',encoding='utf-8').write('\n'.join(p.get_text() for p in d))" 题库.pdf
# 扫描件抽不出文字的话，先用 OCR（例如微信/QQ 截图识字、或 pip install rapidocr-onnxruntime）
```

扫描件分批喂给 AI：一次 20~40 题，太多它会开始偷懒/串行。

### 步骤 2：把下面整段提示词连同文本一起给 AI

```text
你是一个题库结构化助手。请把我给你的题库文本转成严格符合下面 JSON Schema 的 JSON。

【输出要求】
1. 只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码围栏。
2. 顶层结构固定为 {"meta": {...}, "questions": [...]}。
3. 绝对不要修改题干、选项的原始文字（除下面的清洗规则外），不要自己编题、删题。
4. 答案必须来自原文的「答案：」标注；原文没写答案的题目，整题丢弃，不要猜。
5. 题干里的换行和因排版产生的多余空格要合并；填空处统一写成 「(  )」。
6. 判断题：type 用 "judge"，answer 用 "T"（正确）或 "F"（错误），options 可以省略。
7. 选择题：type 用 "single"（单选）或 "multiple"（多选，答案 2 个及以上字母）。
   选项写成 [{"key":"A","text":"..."}] 的形式，key 必须从 A 连续排下来。
8. answer 统一用字符串数组：单选 ["A"]，多选 ["A","B","C"]，判断 ["T"]。
9. 如果原文给了「解析 / 答案解析」，放到 analysis 字段；没有就省略这个字段。
10. meta.id 用英文小写字母数字和短横线（如 "maogai"）。
    meta.title 用原文标题。meta.counts 里填各题型数量。
11. 输出前自己检查一遍：questions 里每一题的 answer 里每个字母，
    都必须在该题的 options 里存在；题号不要重复、不要跳号。

【JSON Schema】
（把本仓库 tools/schema.json 的内容整段粘在这里）

【题库文本】
（把你的 dump.txt 内容粘在这里，一次 20~40 题）
```

### 步骤 3：别信 AI，验一遍

```powershell
# 结构校验 + 体检
python tools/check_bank.py frontend/src/banks/我的题库.json
```

`check_bank.py` 会告诉你题号连不连续、题干空不空、答案有没有越界。
发现 AI 编的答案，就回原文核对。

### 步骤 4：也可以完全不做格式转换

前端的**容错归一化层**（`frontend/src/core/normalize.js`）能吃下很随意的结构：

```json
[
  { "题目": "中国的武装斗争是无产阶级领导下的以( )为主体的革命战争。",
    "选项": ["工人", "农民", "城市小资产阶级", "知识分子"],
    "正确答案": "B" }
]
```

字段名支持中英文别名（`stem/question/题干/题目`、`options/choices/选项`、
`answer/correct/正确答案/答案`、`analysis/explanation/解析`），
选项支持字符串数组 / 对象数组 / `{"A":"..."}` 映射，
答案支持 `"A"`、`"AB"`、`"A,B"`、`["A","B"]`、`"正确"`、`true`、`1`（序号）。

**所以最省事的路径是**：随便让 AI 输出一个「题目+选项+答案」的数组，
存成 `.json`，直接拖到刷题首页的虚线框里 —— 不用管 schema。
