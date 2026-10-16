# public/ocr/ —— 浏览器 OCR 的自托管资源

这些文件是**站点自己发的**，不从任何第三方 CDN 拉。为什么要这样，见
`src/core/ocr.js` 顶部注释：tesseract.js 的默认 `workerPath` / `corePath`
都指向 `cdn.jsdelivr.net`，在国内经常不通，而这个仓库的既定取舍是**不依赖第三方 CDN**
（板子那条网络有被 DNS 劫持到 fake-ip 的历史）。

## 文件从哪来

| 文件 | 来源 | 大小 |
|---|---|---|
| `worker.min.js` | `tesseract.js@7/dist/worker.min.js` | 111 KB |
| `tesseract-core-simd-lstm.wasm.js` | `tesseract.js-core/` | 3.9 MB |
| `chi_sim.traineddata.gz` | `@tesseract.js-data/chi_sim/**4.0.0**/`（全量） | 19.2 MB |
| `eng.traineddata.gz` | `@tesseract.js-data/eng/4.0.0_best_int/`（精简） | 2.8 MB |

重新取一遍（例如升级 tesseract.js 时）：

```powershell
cd quiz\frontend
npm i tesseract.js "@tesseract.js-data/chi_sim" "@tesseract.js-data/eng" --registry=https://registry.npmmirror.com
Copy-Item node_modules\tesseract.js\dist\worker.min.js public\ocr\ -Force
Copy-Item node_modules\tesseract.js-core\tesseract-core-simd-lstm.wasm.js public\ocr\ -Force
# ⚠️ 中文那份是 **4.0.0 全量**，不是 4.0.0_best_int（为什么见下一节）
Copy-Item node_modules\@tesseract.js-data\chi_sim\4.0.0\chi_sim.traineddata.gz public\ocr\ -Force
Copy-Item node_modules\@tesseract.js-data\eng\4.0.0_best_int\eng.traineddata.gz public\ocr\ -Force
```

校验换上去的确实是那一份（和量过的那份逐字节相同）：

```powershell
(Get-FileHash public\ocr\chi_sim.traineddata.gz).Hash
# 59388039851E4D1293D729C183FD8C1FA9BBBB959EED996E945024671E68C1D6
```

## ★ 三个别踩的坑

1. **不要再多发一个 `tesseract-core-simd-lstm.wasm`**（独立那个 2.9MB 文件）。
   `.wasm.js` 是 Emscripten 的 SINGLE_FILE 构建，**wasm 已经内嵌在里面**。
   实测证据：真浏览器里只请求了 `.wasm.js`，从没请求那个独立的 `.wasm`。
   多发一份纯属浪费带宽（板子走 Tailscale relay，传得慢）。

2. **中文模型用 `4.0.0`（19.2MB），不是 `4.0.0_best_int`（1.6MB）**。
   ⚠️ 这一条**2026-10-10 推翻过**：原来这里写着"两套模型输出完全一致 → 发小的"，
   那是**共用语言缓存**造成的假测量（tesseract.js 的缓存只按语言名存，
   小模型那次命中了全量模型的缓存，两个 bench 产出**逐字节相同**）。分开缓存重测：

   | chi_sim | eng | 关键串命中 | 预习页能出的自测题 |
   |---|---|---|---|
   | best_int | best_int | 91% | 1 道 |
   | best_int | 4.0.0 | 91% | 1 道 |
   | **4.0.0** | best_int | **100%** | **12 道** |
   | 4.0.0 | 4.0.0 | 100% | 12 道 |

   —— 瓶颈是**中文模型**（这份教材是中文正文 + 拉丁代码，eng 换不换毫无差别），
   所以只换中文那份：质量拉满，又不白搭 7.6MB。
   ⚠️ 这只在**中文教材**上量过；以后有全英文材料，eng 那份要重新量。

3. **换模型必须同时改 `core/ocr.js` 里的 `OCR_CACHE_VERSION`** ——
   缓存键是 `` `${cachePath}/${lang}.traineddata` ``，**只认语言名**。
   只换这里的文件、不改版本号，老用户（包括早就导入过扫描件的站主）
   **会一直用缓存里的旧模型**，换模型变成静默假动作。
   （这是坑 77 在浏览器端的同一个陷阱：两处都栽在"缓存不看文件内容"上。）

## 许可证

- `tesseract.js` / `tesseract.js-core`：Apache-2.0
- `chi_sim.traineddata` / `eng.traineddata`：来自 tessdata（Apache-2.0）

## 失败时长什么样（记住这个，能省你半天）

**如果这些文件没部署上去**，请求它们**不会得到 404** —— Django 的 SPA 兜底路由
会把 `/quiz/ocr/worker.min.js` 当成前端路由，返回 **HTTP 200 + text/html（index.html）**。
于是 OCR 报出来的错跟"文件不存在"毫无关系。验收脚本里已经加了这条断言
（`/ocr/` 下的资源必须全部 200 **且不是 html**）。
