<template>
  <el-dialog
    v-model="visible"
    class="doc-review"
    width="min(1360px, 96vw)"
    top="4vh"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    append-to-body
    @closed="onClosed"
  >
    <template #header>
      <div class="dr-head">
        <span class="dr-title">扫描件校对台</span>
        <span class="dr-sub">
          识别出来的每一行都要有人看过才有资格变成题目 —— 尤其代码（代码认错一个字，期望输出就是错的）
        </span>
      </div>
    </template>

    <div class="dr-summary">
      <span class="dr-chip">{{ model.pages.length }} 页</span>
      <span class="dr-chip">{{ stats.blocks }} 块</span>
      <span class="dr-chip">代码 {{ stats.codeBlocks }}</span>
      <span class="dr-chip">表 {{ stats.tables }} · 图 {{ stats.figures }}</span>
      <span class="dr-chip dr-dropped">已剔除版面行 {{ stats.droppedLines }}（水印/页眉页脚/行号栏）</span>
      <!--
        ⚠️ 这个计数**跨页**：校对台一次只渲染当前页的项，而高风险项常常分布在好几页。
        站主实测的困惑是「我把这一页的红框都点了，按钮还是灰的，像点了没用」——
        所以计数要能说出**在哪一页**，点一下就跳过去（见 remainingHighByPage 的注释）。
      -->
      <button
        class="dr-chip dr-chip--jump"
        :class="highLeft ? 'dr-bad' : 'dr-good'"
        :title="highLeft ? '跳到还没核对的那一页' : '可以继续了'"
        @click="jumpNextHigh"
      >
        {{ highLeft ? `还有 ${highLeft} 处要核对${nextHighPage ? `（在第 ${nextHighPage} 页，点这里过去）` : ''}` : '必须核对的地方都过了' }}
      </button>
      <span v-if="ackedCount" class="dr-chip dr-acked">已核对 {{ ackedCount }} 处</span>
      <span v-if="excludedCount" class="dr-chip dr-dropped">已排除出题 {{ excludedCount }} 块</span>
      <!--
        逐条打勾才是**真的看过**；但真实样张上高风险项有 80+ 条（小语言包在代码清单上
        就是读成这样），一条条点完人会放弃 —— 放弃了就变成"绕过校对台"，
        比没有校对台更糟。所以给一个**显式**的总确认：仍然是人的动作，但不需要点 80 次。
      -->
      <!-- 连续长卷 / 一页一屏：默认连着看。翻页被切开的代码在长卷里就是一整段 -->
      <button
        class="dr-mini"
        :title="continuous ? '切成一次只看一页' : '把相邻页接起来连着看（页与页之间只隔一条页标）'"
        @click="continuous = !continuous"
      >
        {{ continuous ? '连续长卷' : '一页一屏' }}
      </button>
      <button v-if="highLeft" class="dr-mini" title="所有页的高风险项一次性确认（仍然是你的动作）" @click="ackAllHigh">
        全部标记为已核对
      </button>
    </div>

    <div class="dr-body">
      <!-- 左：页码 -->
      <div class="dr-pages">
        <button
          v-for="pg in model.pages"
          :key="pg.page"
          class="dr-pagebtn"
          :class="{ on: pg.page === current }"
          @click="goPage(pg.page)"
        >
          <span>第 {{ pg.page }} 页</span>
          <em v-if="pageHigh(pg.page)" class="dr-dot">{{ pageHigh(pg.page) }}</em>
        </button>
      </div>

      <!-- 中：页图（**跟着你正在改的那一块滚**，并框出位置 —— 校对时要对着原书看） -->
      <div ref="imageBox" class="dr-image">
        <div v-if="!imageUrl" class="dr-imgwait">正在渲染这一页…</div>
        <div v-else class="dr-imwrap">
          <img :src="imageUrl" :alt="`第 ${current} 页`" />
          <div
            v-if="band"
            class="dr-band"
            :style="{ top: `${band.topPct}%`, height: `${band.heightPct}%` }"
          />
        </div>
      </div>

      <!-- 右：识别文本 -->
      <div ref="textPane" class="dr-text">
        <!-- ★ 连续长卷：页与页之间**只隔一条页标**，内容连着流下来。
             为什么必须这样：站主原话「我要的合并代码功能呢，页和页之间现在仍是孤岛」——
             一段代码被翻页切开时，原来"一页一屏"的界面里它就是两截，看得见也连不上。
             连起来之后，被切开的清单就是**连贯的一整段**（能连着看、连着改、连着跑）。 -->
        <div
          v-for="block in flow"
          :key="`${block.page}-${block.id}`"
          :id="block.kind === '__page' ? `pg-${block.page}` : `blk-${block.page}-${block.id}`"
          class="dr-block"
          :class="[
            `k-${block.kind}`,
            { 'is-excluded': block.excluded, 'dr-pagebreak': block.kind === '__page' },
          ]"
        >
          <div v-if="block.kind === '__page'" class="dr-pagebreak__inner">
            第 {{ block.page }} 页
            <em v-if="pageHigh(block.page)">{{ pageHigh(block.page) }} 处待核对</em>
          </div>
          <template v-else>
          <div class="dr-bhead">
            <span class="dr-kind">{{ kindLabel(block) }}</span>
            <span v-if="block.section" class="dr-sec">{{ block.section }}</span>
            <span v-if="block.lowConfidence" class="dr-tag dr-tag-warn">有低置信行</span>
            <span v-if="block.missingLines && block.missingLines.length" class="dr-tag dr-tag-bad">
              漏了第 {{ block.missingLines.join('、') }} 行
            </span>
            <span v-if="block.columnsLost" class="dr-tag dr-tag-bad">列关系已丢，要对着原书核对</span>
            <span v-if="block.excluded" class="dr-tag dr-tag-off">已排除：不参与出题</span>
            <!-- 跨页合并：这块是"上一页 + 下一页"接起来的（见 core/merge.js）。
                 要说清楚，否则人会以为这一段在书上一整块就在这一页。 -->
            <span
              v-if="block.pages && block.pages.length > 1"
              class="dr-tag dr-tag-merge"
              :title="`书翻页把这一段切开了，已接回：第 ${block.pages.join('、')} 页`"
            >
              跨页合并 · 第 {{ block.pages.join('–') }} 页
            </span>
            <span class="dr-grow" />
            <!--
              ⚠️ 这里原来只有**代码块**能改（`v-if="block.kind === 'code'"`）——
              站主实测反馈"有些错误的地方没有交互按钮改不了"：
              图里的文字、表格里的字、正文认花的字全都没有入口。
              现在**每种块都能改**（正文一行一行改，代码整段改），
              另外给两种"不用改也能往下走"的动作：
                · 这一块没问题 → 只确认这一块（比逐条打勾快）
                · 不用于出题   → 图里的乱码这种，直接排除，送后端的文字里就没有它了
            -->
            <button class="dr-mini" @click="toggleEdit(block.id)">
              {{ editing.has(block.id) ? '收起' : (block.kind === 'code' ? '改这一块' : '改这几行') }}
            </button>
            <button
              v-if="blockItems(block).length && !blockAllAcked(block)"
              class="dr-mini dr-mini--ok"
              @click="ackBlock(block)"
            >
              这一块没问题
            </button>
            <button
              class="dr-mini"
              :class="{ 'dr-mini--off': block.excluded }"
              :title="block.excluded ? '点一下恢复：这一块重新参与出题' : '这一块不参与出题（图里的文字、装饰、认花的段落）'"
              @click="toggleExclude(block)"
            >
              {{ block.excluded ? '恢复出题' : '不用于出题' }}
            </button>
          </div>

          <!-- 代码块用带高亮/补全的编辑器（站主：「让他们在校验的时候就提前熟悉代码」）；
               非代码块仍然是普通 textarea —— 那是成段的文字，高亮没有意义。 -->
          <CodeEditor
            v-if="editing.has(block.id) && block.kind === 'code'"
            :model-value="editText(block)"
            :lang="blockLang(block)"
            :words="blockWords(block)"
            :theme="quiz.settings.codeTheme"
            @update:model-value="applyEdit(block, $event)"
          />
          <textarea
            v-else-if="editing.has(block.id)"
            class="dr-edit"
            :value="editText(block)"
            rows="6"
            spellcheck="false"
            @input="applyEdit(block, $event.target.value)"
          />
          <pre v-else-if="block.kind === 'code'" class="dr-code">{{ block.text }}</pre>

          <!-- 代码块就地能跑（站主：「扫描件出结果复核的时候更能学到东西，那简直就是活的代码排错」）。
               Java 走服务器真跑（片段自动补壳），JS/Vue 走浏览器沙箱。
               ⚠️ 对外只说"当前不可用"，不提提权、不给敲键序列 —— 见 SnippetRunner.vue 的注释。 -->
          <SnippetRunner
            v-if="block.kind === 'code'"
            class="dr-run"
            :code="editText(block)"
            :lang="blockLang(block)"
          />
          <div v-else class="dr-lines">
            <div v-for="(line, i) in block.lines" :key="i" class="dr-line" :class="{ low: line.lowConfidence }">
              <span class="dr-linetext">{{ line.text }}</span>
              <span v-if="line.lowConfidence" class="dr-conf" :title="'OCR 置信度 ' + line.confidence.toFixed(0)">
                {{ line.confidence.toFixed(0) }}
              </span>
            </div>
          </div>

          <!-- 这一块上的待核对项 -->
          <div v-if="blockItems(block).length" class="dr-items">
            <label
              v-for="item in blockItems(block)"
              :key="item.idx"
              class="dr-item"
              :class="[`lv-${item.level}`, { done: acked.has(item.idx) }]"
            >
              <input type="checkbox" :checked="acked.has(item.idx)" @change="toggleAck(item.idx)" />
              <span class="dr-item__msg">{{ item.message }}</span>
              <em v-if="acked.has(item.idx)" class="dr-item__done">已核对</em>
            </label>
          </div>
          </template>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="dr-foot">
        <span class="dr-footnote">
          改过的地方只影响本次导入；代码清单的自动纠错（拿 javac 当判据）不在这一步
        </span>
        <el-button @click="cancel">取消导入</el-button>
        <!-- 文案必须说清"为什么不能点"+**还差在哪一页**（原来只说总数，人会以为点了没用） -->
        <el-button type="primary" :disabled="highLeft > 0" @click="confirm">
          {{ highLeft > 0 ? `还有 ${highLeft} 处没核对${nextHighPage ? `（在第 ${nextHighPage} 页）` : ''}` : '确认无误，继续生成' }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup>
/**
 * DocReview.vue —— **扫描件校对台**（"书本扫描件 → 交互式教学"批 1 的第 3 件）
 * ============================================================================
 * 它接的是 `core/docmodel.js` 建出来的文档模型。为什么必须有这一步：
 *   改之前，OCR 完直接把文字丢给后端出题，界面上只有一句"代码容易认错，请核对"，
 *   然后**照样拿没核对的文字去出题**。真实样张实测：小模型把
 *   `resp.setHeader(` 认成 `resp,setHeadqer (`、`PrintWriter pw = resp.getWriter();`
 *   认成 `PrintNWriter PW = resPp,dgetNriter () :;` —— 这种文字拿去出代码题，
 *   期望输出必然是错的，而学生看不出来。
 *
 * 所以这一页做三件事（都不花额度）：
 *   ① 页图与识别文本**并排**：人可以一眼比对，不用来回切窗口
 *   ② 低置信 / 漏行 / 代码可疑串**高亮**，并给一份"要你看哪里"的清单
 *   ③ **有 high 级待核对项时不给往下走** —— 逐条打勾才放行（canProceed 那一套）
 *
 * 约定：`model` 是**响应式对象**，编辑代码块会就地改 `block.lines[].text`，
 * 父组件随后用 `docModelToPages(model)` 取文字（一处真值，不做第二份副本）。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { remainingHighByPage } from '@/core/docmodel'
import { completionWords, guessLang } from '@/core/editor'
import { useQuizStore } from '@/stores/quiz'
import CodeEditor from '@/components/CodeEditor.vue'
import SnippetRunner from '@/components/SnippetRunner.vue'

// 代码块配色（设置页可选；见 core/code-theme.js）
const quiz = useQuizStore()

const props = defineProps({
  /** `core/docmodel.js` 的模型 */
  model: { type: Object, required: true },
  /** `(page:number) => Promise<string>` 返回该页图片的 URL（data URL 也行） */
  pageImage: { type: Function, default: null },
})
const emit = defineEmits(['confirm', 'cancel'])

const visible = ref(true)
const current = ref(props.model.pages[0]?.page || 1)
const imageUrl = ref('')
const editing = ref(new Set())
const acked = ref(new Set())
const textPane = ref(null)
const imageBox = ref(null)

const stats = computed(() => props.model.stats || {})

/** 待核对项带上在 model.review 里的下标（勾选状态用它当键） */
const items = computed(() => (props.model.review || []).map((r, idx) => ({ ...r, idx })))
const highLeft = computed(() => items.value.filter((r) => r.level === 'high' && !acked.value.has(r.idx)).length)
const ackedCount = computed(() => items.value.filter((r) => acked.value.has(r.idx)).length)
const excludedCount = computed(() =>
  props.model.pages.reduce((n, pg) => n + pg.blocks.filter((b) => b.excluded).length, 0),
)

/**
 * 还没核对的高风险项**分布在哪几页**（纯函数在 core/docmodel.js 里，可离线断言）。
 * `nextHighPage` 就是"下一步该去哪一页" —— 计数跨页，不说清页码人就会以为控件坏了。
 */
const highByPage = computed(() => remainingHighByPage(props.model, acked.value))
const nextHighPage = computed(() => {
  const pages = [...highByPage.value.keys()].filter((p) => p > 0).sort((a, b) => a - b)
  if (!pages.length) return 0
  // 优先停在"当前页还有"的那一页（人正看着它），否则去最近的一页
  if (highByPage.value.has(current.value)) return current.value
  return pages[0]
})

const currentBlocks = computed(() => {
  const here = props.model.pages.find((p) => p.page === current.value)?.blocks || []
  // ★ 跨页合并出来的块挂在**起始页**上，却有内容在这一页。不补进来的话，
  //   翻到第二页会以为"下半段没了"，于是把半段当成完整的核对过去 ——
  //   站主提的正是这件事（"如果只有上一页是不完整的"）。
  const spanning = (props.model.pages || [])
    .filter((p) => p.page !== current.value)
    .flatMap((p) => p.blocks || [])
    .filter((b) => (b.pages || []).includes(current.value))
  return [...spanning, ...here]
})

/** 视图模式：`true` = 连续长卷（默认，页与页连着看）；`false` = 一页一屏 */
const continuous = ref(true)

/**
 * 文本栏里要渲染的**流**（连续长卷 = 页标 + 块）。
 *
 * 为什么页标做成"伪块"（`kind: '__page'`）：这样块的模板一行都不用改，
 * 但页与页之间只隔一条标，内容连着流下来 —— **被翻页切开的代码在这里就是一整段**。
 * 站主原话：「页和页之间现在仍是孤岛」。
 *
 * ⚠️ 这里只走每一页**自己的**块。跨页合并出来的块挂在起始页上，
 *    长卷里出现一次就够；再按 `pages` 补一遍会把同一段显示两遍。
 */
const flow = computed(() => {
  if (!continuous.value) return currentBlocks.value
  const out = []
  for (const pg of props.model.pages || []) {
    out.push({ id: `__page${pg.page}`, kind: '__page', page: pg.page })
    for (const b of pg.blocks || []) out.push(b)
  }
  return out
})

function blockItems(block) {
  return items.value.filter((r) => r.page === block.page && r.blockId === block.id)
}
function pageHigh(page) {
  return items.value.filter((r) => r.page === page && r.level === 'high').length
}
/** 这一块的项是不是都确认过了（"这一块没问题"按钮用它决定要不要出现） */
function blockAllAcked(block) {
  const mine = blockItems(block)
  return mine.length > 0 && mine.every((r) => acked.value.has(r.idx))
}
function kindLabel(block) {
  return (
    {
      code: block.caption ? `代码清单 · ${block.caption}` : '代码清单',
      table: '表格',
      figure: '图',
      heading: '标题',
      list: '列表',
      para: '正文',
    }[block.kind] || block.kind
  )
}

let token = 0
async function loadImage(page) {
  if (!props.pageImage) return
  const mine = ++token
  imageUrl.value = ''
  try {
    const url = await props.pageImage(page)
    if (mine === token) imageUrl.value = url
  } catch {
    if (mine === token) imageUrl.value = ''
  }
}

function goPage(page) {
  current.value = page
  band.value = null // 换页了，上一页的高亮框就不该留着
  // 连续长卷下"换页"= 滚到那一页的页标；一页一屏下就是切页（原来的行为）
  if (continuous.value) {
    setTimeout(() => {
      textPane.value?.querySelector(`#pg-${page}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }, 30)
  }
}
function toggleEdit(id) {
  const next = new Set(editing.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  editing.value = next
  // 打开编辑时，把**页图滚到这一块**并框出来 —— 校对代码时要对着原书那一行看
  if (next.has(id)) {
    const blk = currentBlocks.value.find((b) => b.id === id)
    if (blk) showBand(blk)
  } else {
    band.value = null
  }
}

/* ------------------------- 页图与块的位置对应 ------------------------- */
/**
 * 页图与"正在看的那一块"联动。
 *
 * 为什么值得做：这一页的存在意义就是**让人对着原书把认花的字改回来**
 * （扫描件的代码 OCR 认花得厉害）。原来页图只是一根长条，人要自己找那一块在哪 ——
 * 代码块动辄在第 2/3 屏，来回滚很费神。现在打开编辑就滚过去并画个框。
 *
 * ⚠️ 用**百分比**定位（`y / page.height`），不用像素：页图是按宽度自适应缩放的，
 *    百分比在窗口变化后依然对得上（写像素的话 Resize 之后框就跑了）。
 */
const band = ref(null)

function showBand(block) {
  const pg = props.model.pages.find((p) => p.page === block.page)
  const h = Number(pg?.height) || 0
  if (!h) {
    band.value = null
    return
  }
  const ys = (block.lines || []).map((l) => Number(l.y)).filter((v) => Number.isFinite(v))
  const y0 = Number(block.bbox?.y0 ?? (ys.length ? Math.min(...ys) : NaN))
  const y1 = Number(block.bbox?.y1 ?? (ys.length ? Math.max(...ys) + 40 : NaN))
  if (!Number.isFinite(y0) || !Number.isFinite(y1) || y1 <= y0) {
    band.value = null
    return
  }
  band.value = {
    topPct: (y0 / h) * 100,
    heightPct: Math.max(((y1 - y0) / h) * 100, 0.5),
  }
  // 等这一帧渲染出来再滚（band 是刚设的）
  nextTick(() => {
    const box = imageBox.value
    const wrap = box?.querySelector('.dr-imwrap')
    if (!box || !wrap || !band.value) return
    const target = (band.value.topPct / 100) * wrap.clientHeight
    box.scrollTop = Math.max(0, target - box.clientHeight / 3)
  })
}
function toggleAck(idx) {
  const next = new Set(acked.value)
  if (next.has(idx)) next.delete(idx)
  else next.add(idx)
  acked.value = next
}
/** 一次性确认**这一块**的项（比逐条点快，又比"全部"精确） */
function ackBlock(block) {
  const next = new Set(acked.value)
  for (const item of blockItems(block)) next.add(item.idx)
  acked.value = next
}
/** 一次性确认所有高风险项（仍然是**人**的动作，只是不用点 80 次） */
function ackAllHigh() {
  const next = new Set(acked.value)
  for (const item of items.value) if (item.level === 'high') next.add(item.idx)
  acked.value = next
}
/** 跳到下一个还有高风险项的页（并滚到那一条） */
function jumpNextHigh() {
  const page = nextHighPage.value
  if (!page) return
  current.value = page
  const first = items.value.find((r) => r.level === 'high' && !acked.value.has(r.idx) && (r.page || 0) === page)
  if (first) setTimeout(() => jump(first), 60)
}

/** 编辑框里的文本：代码块用整段，其他块把行拼起来（都是一处真值 block.lines） */
function editText(block) {
  if (block.kind === 'code') return block.text ?? block.lines.map((l) => l.text).join('\n')
  return block.lines.map((l) => l.text).join('\n')
}
/** 代码块的语言（教材扫描件猜出来的，只为高亮；猜不准按 js 高亮，括号/字符串照样分得开） */
function blockLang(block) {
  return guessLang(block.text || block.lines.map((l) => l.text).join('\n'))
}
/** 代码块的补全词表：就用这一块自己的词（校对时看到的是"这一段里有什么"） */
function blockWords(block) {
  return completionWords(block.text || block.lines.map((l) => l.text).join('\n'), blockLang(block))
}
/**
 * 排除 / 恢复"这一块参与出题"。
 *
 * 为什么要这个按钮：图里的文字、装饰性文字、彻底认花的段落 —— 这些**改也没意义**，
 * 但原来它们和别的块一样只能"确认"，人只能被迫点"没问题"。排除之后
 * `docModelToPages()` 不再把这些行送给后端（见 core/docmodel.js），
 * 于是"别拿图里的乱码出题"变成了一个**动作**，而不是一句提示。
 * （同时把它记成已核对：排除本身就是"人看过并做了决定"。）
 */
function toggleExclude(block) {
  block.excluded = !block.excluded
  if (block.excluded) ackBlock(block)
}

/** 就地改一个块：整段文本拆回每一行（行的置信度/坐标保留） */
function applyEdit(block, text) {
  const lines = String(text).split('\n')
  const old = block.lines
  block.lines = lines.map((t, i) => ({
    text: t,
    confidence: old[i]?.confidence ?? 100,
    y: old[i]?.y ?? 0,
    x0: old[i]?.x0 ?? 0,
    x1: old[i]?.x1 ?? 0,
    lowConfidence: false,
    gutters: old[i]?.gutters || [],
  }))
  block.text = lines.join('\n')
  block.lowConfidence = block.lines.some((l) => l.lowConfidence)
  // ★ 人**动手改过**就是核对过了：不自动确认的话，会出现"我把它改对了、
  //   按钮却还是灰的"这种更让人火大的状态。边打第一个字边确认。
  ackBlock(block)
}

watch(current, (page) => loadImage(page), { immediate: true })

function confirm() {
  visible.value = false
  emit('confirm')
}
function cancel() {
  visible.value = false
  emit('cancel')
}
function onClosed() {
  // 用户点右上角关掉 = 取消（不能默认当成"确认过了"）
  if (visible.value === false && !settled) cancel()
}
let settled = false
watch(visible, (v) => {
  if (v === false) settled = true
})

/** 跳到某一条待核对项所在的块 */
function jump(item) {
  current.value = item.page
  editing.value = new Set(editing.value)
  // 等这一页渲染出来再滚
  setTimeout(() => {
    // ⚠️ 块 id 是**每页各编一套**的（`b1` 在每页都有），所以定位必须带上页号，
    //    只写 `#blk-${id}` 会滚到"另一页同号的那个块"去（真实样张上就这么错过）。
    const el = textPane.value?.querySelector(`#blk-${item.page}-${item.blockId}`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    // 页图也跟过去（同一块，两边一起看）
    const blk = (props.model.pages.find((p) => p.page === item.page)?.blocks || []).find(
      (b) => b.id === item.blockId,
    )
    if (blk) showBand(blk)
  }, 60)
}
defineExpose({ jump, acked, highLeft })
</script>

<style scoped>
.doc-review :deep(.el-dialog__body) {
  padding-top: 6px;
}
.dr-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dr-title {
  font-size: 17px;
  font-weight: 600;
}
.dr-sub {
  font-size: 12px;
  opacity: 0.7;
}
.dr-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}
.dr-chip {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--el-fill-color-light);
}
.dr-dropped {
  opacity: 0.75;
}
.dr-bad {
  background: var(--el-color-danger-light-8);
  color: var(--el-color-danger);
}
.dr-good {
  background: var(--el-color-success-light-8);
  color: var(--el-color-success);
}
.dr-body {
  display: grid;
  grid-template-columns: 108px minmax(260px, 1fr) minmax(360px, 1.35fr);
  gap: 10px;
  height: min(66vh, 720px);
}
.dr-pages {
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow: auto;
}
.dr-pagebtn {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  font-size: 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}
.dr-pagebtn.on {
  border-color: var(--el-color-primary);
  color: var(--el-color-primary);
}
.dr-dot {
  font-style: normal;
  font-size: 11px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--el-color-danger);
  color: #fff;
}
.dr-image {
  overflow: auto;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-fill-color-lighter);
  display: flex;
  align-items: flex-start;
  justify-content: center;
}
.dr-image img {
  width: 100%;
  height: auto;
  display: block;
}
/* 页图外面包一层：高亮框用**百分比**定位在这上面（缩放后依然对得上） */
.dr-imwrap {
  position: relative;
  width: 100%;
}
.dr-band {
  position: absolute;
  left: 0;
  right: 0;
  pointer-events: none;
  border: 2px solid var(--el-color-primary);
  border-radius: 4px;
  background: color-mix(in srgb, var(--el-color-primary) 14%, transparent);
  box-shadow: 0 0 0 9999px color-mix(in srgb, #000 22%, transparent);
}
.dr-imgwait {
  padding: 24px;
  font-size: 13px;
  opacity: 0.7;
}
.dr-text {
  overflow: auto;
  padding-right: 4px;
}
.dr-block {
  border-left: 3px solid transparent;
  padding: 6px 8px;
  margin-bottom: 6px;
  border-radius: 4px;
  background: var(--el-fill-color-blank);
}
.dr-block.k-code {
  border-left-color: var(--el-color-primary);
  background: var(--el-fill-color-light);
}
.dr-block.k-table {
  border-left-color: var(--el-color-warning);
}
.dr-block.k-figure {
  border-left-color: var(--el-color-info);
}
.dr-bhead {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 4px;
}
.dr-kind {
  font-size: 12px;
  font-weight: 600;
}
.dr-sec {
  font-size: 11px;
  opacity: 0.6;
}
.dr-grow {
  flex: 1;
}
.dr-tag {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 8px;
}
.dr-tag-warn {
  background: var(--el-color-warning-light-8);
  color: var(--el-color-warning);
}
.dr-tag-bad {
  background: var(--el-color-danger-light-8);
  color: var(--el-color-danger);
}
/* 跨页合并：用"信息"色，不是警告色 —— 这是正常现象（书翻页而已），别吓人 */
.dr-tag-merge {
  background: var(--el-color-primary-light-8);
  color: var(--el-color-primary);
}
/* ── 连续长卷的页标：页与页之间**只隔这一条**，内容连着流下来 ──
   它复用了 `.dr-block` 那套模板（页标做成"伪块"），所以这里要把块的框和底色去掉，
   只留一条虚线，否则每一页看起来还是被一个方框隔开的"孤岛"。 */
.dr-pagebreak {
  background: transparent;
  border: 0;
  border-top: 1px dashed var(--el-border-color);
  border-radius: 0;
  padding: 6px 0 2px;
}
.dr-pagebreak__inner {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.dr-pagebreak__inner em {
  font-style: normal;
  color: var(--el-color-warning);
}
.dr-mini {
  font-size: 11px;
  padding: 1px 6px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}
.dr-code,
.dr-edit {
  margin: 0;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
.dr-edit {
  width: 100%;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  padding: 6px;
  background: var(--el-fill-color-blank);
  color: inherit;
}
.dr-line {
  font-size: 13px;
  line-height: 1.6;
  display: flex;
  gap: 6px;
  align-items: baseline;
}
.dr-line.low .dr-linetext {
  background: var(--el-color-warning-light-9);
  border-bottom: 1px dashed var(--el-color-warning);
}
.dr-conf {
  font-size: 10px;
  color: var(--el-color-warning);
}
.dr-items {
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dr-item {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  font-size: 12px;
  line-height: 1.45;
  padding: 3px 6px;
  border-radius: 4px;
  cursor: pointer;
}
.dr-item:hover {
  outline: 1px solid var(--el-border-color);
}
.dr-item.lv-high {
  background: var(--el-color-danger-light-9);
}
.dr-item.lv-warn {
  background: var(--el-color-warning-light-9);
}
/* ★ 勾选之后**必须一眼看得出来**：原来只有那个 12px 的原生小方框变了，
   行本身一点变化都没有 —— 站主就是这么得出"点了没用"的。
   现在整行变绿 + 灰掉 + 打勾 + 划掉，点一下就知道成了。 */
.dr-item input[type='checkbox'] {
  margin-top: 2px;
  width: 14px;
  height: 14px;
  flex: none;
  cursor: pointer;
  accent-color: var(--el-color-success);
}
.dr-item.done {
  background: var(--el-color-success-light-9);
  color: var(--el-text-color-secondary);
}
.dr-item.done .dr-item__msg {
  text-decoration: line-through;
  text-decoration-color: var(--el-color-success);
}
.dr-item__done {
  flex: none;
  font-style: normal;
  font-size: 11px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--el-color-success);
  color: #fff;
}
/* 被排除出题的块：整块灰掉，一眼看出"它不会进题库" */
.dr-block.is-excluded {
  opacity: 0.55;
}
.dr-block.is-excluded .dr-code,
.dr-block.is-excluded .dr-lines {
  text-decoration: line-through;
  text-decoration-color: var(--el-text-color-disabled);
}
.dr-tag-off {
  background: var(--el-fill-color);
  color: var(--el-text-color-secondary);
}
.dr-mini--ok {
  color: var(--el-color-success);
  border-color: var(--el-color-success-light-5);
}
.dr-mini--off {
  color: var(--el-text-color-secondary);
}
.dr-chip--jump {
  border: 1px dashed currentColor;
  cursor: pointer;
  font: inherit;
}
.dr-acked {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success);
}
.dr-foot {
  display: flex;
  align-items: center;
  gap: 10px;
}
.dr-footnote {
  flex: 1;
  text-align: left;
  font-size: 12px;
  opacity: 0.65;
}
</style>
