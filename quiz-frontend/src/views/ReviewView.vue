<script setup>
/**
 * ReviewView —— 复习本：错题本 / 收藏夹 / 笔记。
 * 列表可展开看选项和解析，也能一键开一轮「错题重做 / 收藏练习」。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useBankStore } from '@/stores/bank'
import { useQuizStore } from '@/stores/quiz'
import OptionItem from '@/components/OptionItem.vue'
import NoteEditor from '@/components/NoteEditor.vue'
import AnalysisBody from '@/components/AnalysisBody.vue'
import { TYPE_LABEL } from '@/core/normalize'
import { stemHtml } from '@/core/text'

const bank = useBankStore()
const quiz = useQuizStore()
const router = useRouter()

const tab = ref('wrong') // wrong | fav | note
const typeFilter = ref([])
const expanded = ref(new Set())
const keyword = ref('')
const editingNote = ref('') // 正在编辑笔记的 qid，空串表示没有

const TYPES = [
  { key: 'single', label: '单选' },
  { key: 'multiple', label: '多选' },
  { key: 'judge', label: '判断' },
]

const source = computed(() => {
  if (tab.value === 'note') return quiz.notedQuestions
  const map = tab.value === 'wrong' ? quiz.wrong : quiz.fav
  return bank.questions.filter((q) => map[q.id])
})

const list = computed(() => {
  let arr = source.value
  if (typeFilter.value.length) arr = arr.filter((q) => typeFilter.value.includes(q.type))
  const kw = keyword.value.trim()
  if (!kw) return arr
  // 笔记页连笔记正文一起搜，不然「我记得写过某个坑」就找不到了
  return arr.filter((q) => q.stem.includes(kw) || (quiz.notes[q.id]?.text || '').includes(kw))
})

/** 按题型分组统计，显示成筛选 chip 上的数字 */
const counts = computed(() => {
  const c = { single: 0, multiple: 0, judge: 0 }
  source.value.forEach((q) => (c[q.type] = (c[q.type] || 0) + 1))
  return c
})

const TABS = computed(() => [
  { key: 'wrong', label: '错题本', count: quiz.wrongCount, icon: 'WarningFilled', tone: 'bad' },
  { key: 'fav', label: '收藏夹', count: quiz.favCount, icon: 'StarFilled', tone: 'warn' },
  { key: 'note', label: '笔记', count: quiz.noteCount, icon: 'Memo', tone: 'note' },
])

const isNoteTab = computed(() => tab.value === 'note')

function toggleType(k) {
  const i = typeFilter.value.indexOf(k)
  if (i >= 0) typeFilter.value.splice(i, 1)
  else typeFilter.value.push(k)
}

function toggleExpand(id) {
  const s = new Set(expanded.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  expanded.value = s
}

function expandAll() {
  if (expanded.value.size >= list.value.length) expanded.value = new Set()
  else expanded.value = new Set(list.value.map((q) => q.id))
}

function recordOf(qid) {
  return quiz.answers[qid] || null
}

/** 高亮该选项在这个题里的角色 */
function optionRole(q, key) {
  const rec = recordOf(q.id)
  const picked = rec?.p || []
  return {
    picked: picked.includes(key),
    isAnswer: q.answer.includes(key),
  }
}

const KEY_TEXT = { T: '正确', F: '错误' }
function keysToText(q, keys) {
  if (!keys || !keys.length) return '未作答'
  // 代码题的答案不是字母：填空=原文片段、找错行=行号、修好它=运行输出。
  // 在这里也翻译成人话，否则"你的答案"那一栏会显示一串莫名其妙的内容。
  if (q.type === 'code') {
    if (q.mode === 'spot') return `第 ${keys[0]} 行`
    return keys.map((k) => String(k)).join(' | ')
  }
  return keys.map((k) => (q.type === 'judge' ? KEY_TEXT[k] || k : k)).join(' ')
}

/** 代码题在错题本里也要看得见代码（只有答案没有代码，回头根本想不起错在哪） */
const isCode = (q) => q?.type === 'code'

/* ------------------------------- 笔记 ------------------------------- */
function startEditNote(q) {
  editingNote.value = q.id
  expanded.value = new Set([...expanded.value, q.id])
}

function saveNote(q, text) {
  const saved = quiz.setNote(q.id, text)
  editingNote.value = ''
  ElMessage({ message: saved ? '笔记已保存' : '空笔记已删除', duration: 1200, grouping: true })
}

function removeNote(q) {
  quiz.removeNote(q.id)
  editingNote.value = ''
  ElMessage({ message: '笔记已删除', duration: 1200, grouping: true })
}

/** 复制成 Markdown：贴到 Word / 飞书 / 打印都行 */
async function copyNotes() {
  const md = quiz.exportNotesMarkdown()
  try {
    await navigator.clipboard.writeText(md)
    ElMessage.success(`已复制 ${quiz.noteCount} 条笔记（Markdown）`)
  } catch {
    downloadNotes()
    ElMessage.warning('浏览器不让写剪贴板，已改为下载文件')
  }
}

function downloadNotes() {
  const md = quiz.exportNotesMarkdown()
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${bank.meta?.title || '题库'}-笔记.md`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  ElMessage.success('笔记已导出为 Markdown')
}

/* ------------------------------- 批量操作 ------------------------------- */
async function startSession(mode) {
  const ok = quiz.startSession({ mode })
  if (!ok) {
    ElMessage.warning(mode === 'wrong' ? '错题本是空的' : '还没有收藏题目')
    return
  }
  router.push('/practice')
}

/** 把有笔记的题单独组一轮练习 */
async function practiceNotes() {
  const ids = new Set(quiz.noteIds)
  if (!ids.size) return
  const ok = quiz.startSession({ mode: 'seq' })
  if (!ok) return
  // 组好卷之后把队列收窄成「有笔记的题」，顺序保持题库原序
  quiz.session.queue = quiz.session.queue.filter((id) => ids.has(id))
  quiz.session.index = 0
  quiz.persistSession()
  router.push('/practice')
}

async function clearAll() {
  const n = source.value.length
  if (!n) return
  const isWrong = tab.value === 'wrong'
  const isNote = tab.value === 'note'
  try {
    await ElMessageBox.confirm(
      isNote
        ? `删除全部 ${n} 条笔记？笔记是你自己写的，删了找不回来。`
        : isWrong
          ? `清空全部 ${n} 道错题？答对后它们也会自动移出。`
          : `清空全部 ${n} 道收藏？`,
      isNote ? '清空笔记' : isWrong ? '清空错题本' : '清空收藏夹',
      { type: 'warning', confirmButtonText: '清空', cancelButtonText: '取消' },
    )
    if (isNote) quiz.clearNotes()
    else if (isWrong) quiz.clearWrong()
    else {
      quiz.fav = {}
      quiz.persist()
    }
    ElMessage.success('已清空')
  } catch {}
}

function removeOne(q) {
  if (tab.value === 'wrong') quiz.removeWrong(q.id)
  else if (tab.value === 'note') removeNote(q)
  else quiz.toggleFav(q.id)
}
</script>

<template>
  <div class="q-wrap q-rv">
    <!-- ─────────────── 头部 ─────────────── -->
    <header class="q-rv__head">
      <div>
        <h1 class="q-rv__title">复习本</h1>
        <p class="q-rv__sub q-dim">
          错题做对一次就会自动移出（可在设置里关掉）；收藏是手动标的，随时回看。
        </p>
      </div>
      <div class="q-rv__quick">
        <el-button
          type="danger"
          :disabled="!quiz.wrongCount"
          @click="startSession('wrong')"
        >
          <el-icon style="margin-right: 5px"><WarningFilled /></el-icon>
          重做错题<span v-if="quiz.wrongCount" class="q-num"> ({{ quiz.wrongCount }})</span>
        </el-button>
        <el-button
          type="warning"
          plain
          :disabled="!quiz.favCount"
          @click="startSession('fav')"
        >
          <el-icon style="margin-right: 5px"><StarFilled /></el-icon>
          刷收藏<span v-if="quiz.favCount" class="q-num"> ({{ quiz.favCount }})</span>
        </el-button>
        <el-button
          :disabled="!quiz.noteCount"
          plain
          @click="practiceNotes"
        >
          <el-icon style="margin-right: 5px"><Memo /></el-icon>
          刷有笔记的<span v-if="quiz.noteCount" class="q-num"> ({{ quiz.noteCount }})</span>
        </el-button>
      </div>
    </header>

    <!-- ─────────────── 没有题库 ─────────────── -->
    <section v-if="!bank.meta" class="q-card q-rv__empty">
      <el-icon :size="30"><Collection /></el-icon>
      <p>还没有选择题库</p>
      <el-button type="primary" @click="router.push('/')">去首页选题库</el-button>
    </section>

    <template v-else>
      <!-- 标签页 -->
      <div class="q-rv__tabs">
        <button
          v-for="t in TABS"
          :key="t.key"
          class="q-rv__tab"
          :class="[`is-${t.tone}`, { 'is-active': tab === t.key }]"
          @click="tab = t.key"
        >
          <el-icon :size="15"><component :is="t.icon" /></el-icon>
          <span>{{ t.label }}</span>
          <em class="q-num">{{ t.count }}</em>
        </button>
      </div>

      <!-- 筛选条 -->
      <div v-if="source.length" class="q-rv__bar q-card">
        <div class="q-rv__chips">
          <button
            class="q-chip q-clickable"
            :class="{ 'q-chip--brand': !typeFilter.length }"
            @click="typeFilter = []"
          >
            全部 <em class="q-dim">{{ source.length }}</em>
          </button>
          <button
            v-for="t in TYPES"
            :key="t.key"
            class="q-chip q-clickable"
            :class="{ 'q-chip--brand': typeFilter.includes(t.key) }"
            :disabled="!counts[t.key]"
            @click="toggleType(t.key)"
          >
            {{ t.label }} <em class="q-dim">{{ counts[t.key] || 0 }}</em>
          </button>
        </div>
        <el-input
          v-model="keyword"
          :placeholder="isNoteTab ? '搜题干或笔记内容' : '搜题干关键字'"
          clearable
          size="default"
          class="q-rv__search"
        >
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
        <div class="q-rv__bar-actions">
          <template v-if="isNoteTab">
            <el-button text @click="copyNotes">
              <el-icon style="margin-right: 4px"><DocumentCopy /></el-icon>复制 Markdown
            </el-button>
            <el-button text @click="downloadNotes">
              <el-icon style="margin-right: 4px"><Download /></el-icon>导出
            </el-button>
          </template>
          <el-button text @click="expandAll">
            {{ expanded.size >= list.length && list.length ? '全部收起' : '全部展开' }}
          </el-button>
          <el-button text type="danger" @click="clearAll">清空</el-button>
        </div>
      </div>

      <!-- 空态 -->
      <section v-if="!source.length" class="q-card q-rv__empty q-pop">
        <span
          class="q-rv__empty-icon"
          :class="tab === 'wrong' ? 'is-ok' : tab === 'note' ? 'is-note' : 'is-warn'"
        >
          <el-icon :size="32">
            <component :is="tab === 'wrong' ? 'CircleCheckFilled' : tab === 'note' ? 'Memo' : 'Star'" />
          </el-icon>
        </span>
        <h3>
          {{ tab === 'wrong' ? '错题本是空的' : tab === 'note' ? '还没有任何笔记' : '还没有收藏任何题目' }}
        </h3>
        <p class="q-dim">
          {{
            tab === 'wrong'
              ? '答错的题会自动进来，答对后自动移出。'
              : tab === 'note'
                ? '刷题时按 N 或点题目右上角的笔图标，就能给这道题写笔记。'
                : '在刷题时按 S 或点右上角星标就能收藏。'
          }}
        </p>
        <el-button @click="router.push('/')">回去刷题</el-button>
      </section>

      <section v-else-if="!list.length" class="q-card q-rv__empty">
        <p class="q-dim">当前筛选条件下没有题目</p>
      </section>

      <!-- 列表 -->
      <section v-else class="q-rv__list">
        <article
          v-for="q in list"
          :key="q.id"
          class="q-rv__item q-card"
          :class="{ 'is-open': expanded.has(q.id) }"
        >
          <header class="q-rv__item-head" @click="toggleExpand(q.id)">
            <span class="q-chip" :class="q.type === 'multiple' ? 'q-chip--warn' : 'q-chip--brand'">
              {{ TYPE_LABEL[q.type] }}
            </span>
            <span class="q-rv__no q-num q-dim">#{{ q.no }}</span>

            <p class="q-rv__stem" v-html="stemHtml(q.stem)"></p>

            <span class="q-rv__verdict">
              <span v-if="recordOf(q.id)" class="q-chip" :class="recordOf(q.id).ok ? 'q-chip--ok' : 'q-chip--bad'">
                {{ recordOf(q.id).ok ? '曾答对' : '曾答错' }}
              </span>
              <span v-else class="q-chip">{{ tab === 'fav' ? '未做过' : '未作答' }}</span>
            </span>

            <button
              class="q-rv__act"
              :title="tab === 'note' ? '删除笔记' : tab === 'wrong' ? '移出错题本' : '取消收藏'"
              @click.stop="removeOne(q)"
            >
              <el-icon :size="14">
                <component
                  :is="tab === 'wrong' ? 'Select' : tab === 'note' ? 'Delete' : 'StarFilled'"
                />
              </el-icon>
            </button>

            <el-icon class="q-rv__arrow" :size="14">
              <component :is="expanded.has(q.id) ? 'ArrowUp' : 'ArrowDown'" />
            </el-icon>
          </header>

          <!-- 笔记摘要：错题本/收藏夹里也顺手看一眼自己写过什么 -->
          <button
            v-if="quiz.notes[q.id]?.text && editingNote !== q.id"
            class="q-rv__note"
            @click="toggleExpand(q.id)"
          >
            <el-icon :size="12"><Memo /></el-icon>
            <span>{{ quiz.notes[q.id].text }}</span>
          </button>

          <transition name="q-exp">
            <div v-if="expanded.has(q.id)" class="q-rv__detail">
              <!-- 代码题：先给代码，再给答案。没有代码的那一栏"正确答案：ref"是看不懂的 -->
              <pre v-if="isCode(q)" class="q-rv__code"><code>{{ q.code }}</code></pre>
              <div v-if="!isCode(q)" class="q-rv__opts">
                <OptionItem
                  v-for="opt in q.options"
                  :key="opt.key"
                  :option="opt"
                  :judge="q.type === 'judge'"
                  :picked="optionRole(q, opt.key).picked"
                  :is-answer="optionRole(q, opt.key).isAnswer"
                  revealed
                  disabled
                />
              </div>

              <div class="q-rv__ans">
                <span>
                  {{ isCode(q) ? (q.mode === 'spot' ? '被改动的行' : q.mode === 'fix' ? '期望输出' : '正确答案') : '正确答案' }}
                  <b class="q-num" style="color: var(--q-ok)">{{ keysToText(q, q.answer) }}</b>
                </span>
                <span>
                  你的答案
                  <b class="q-num" :style="{ color: recordOf(q.id)?.ok ? 'var(--q-ok)' : 'var(--q-bad)' }">
                    {{ keysToText(q, recordOf(q.id)?.p) }}
                  </b>
                </span>
              </div>

              <!-- 解析走和题目卡片同一个 AnalysisBody：错题本里看到的样子要和做题时一致 -->
              <AnalysisBody v-if="q.analysis" class="q-rv__analysis" :text="q.analysis" />

              <div v-if="q.tags?.length" class="q-rv__tags">
                <span v-for="t in q.tags" :key="t" class="q-chip">{{ t }}</span>
              </div>

              <!-- 笔记：编辑或新建 -->
              <div class="q-rv__notewrap">
                <NoteEditor
                  v-if="editingNote === q.id"
                  :model-value="quiz.noteOf(q.id)"
                  :label="`第 ${q.no} 题 · 我的笔记`"
                  @save="(t) => saveNote(q, t)"
                  @remove="removeNote(q)"
                  @cancel="editingNote = ''"
                />
                <el-button v-else size="small" @click="startEditNote(q)">
                  <el-icon style="margin-right: 4px">
                    <component :is="quiz.notes[q.id]?.text ? 'EditPen' : 'Plus'" />
                  </el-icon>
                  {{ quiz.notes[q.id]?.text ? '编辑笔记' : '写笔记' }}
                </el-button>
              </div>
            </div>
          </transition>
        </article>
      </section>
    </template>
  </div>
</template>

<style scoped>
.q-rv {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* ---------- 头部 ---------- */
.q-rv__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
}
.q-rv__title {
  font-size: 26px;
  font-weight: 850;
  letter-spacing: -0.01em;
  color: var(--q-text);
}
.q-rv__sub {
  margin-top: 7px;
  font-size: 13px;
  max-width: 560px;
  line-height: 1.7;
}
.q-rv__quick {
  display: flex;
  gap: 9px;
  flex-wrap: wrap;
}

/* ---------- 空态 ---------- */
.q-rv__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 11px;
  padding: 48px 24px;
  text-align: center;
  color: var(--q-text-2);
}
.q-rv__empty h3 {
  font-size: 17px;
  font-weight: 750;
  color: var(--q-text);
}
.q-rv__empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border-radius: 20px;
  background: var(--q-surface-3);
  color: var(--q-text-3);
}
.q-rv__empty-icon.is-ok {
  background: var(--q-ok-bg);
  color: var(--q-ok);
}
.q-rv__empty-icon.is-warn {
  background: var(--q-warn-bg);
  color: var(--q-star);
}
.q-rv__empty-icon.is-note {
  background: color-mix(in srgb, var(--q-brand-2) 14%, transparent);
  color: var(--q-brand-2);
}

/* ---------- 标签页 ---------- */
.q-rv__tabs {
  display: flex;
  gap: 9px;
  flex-wrap: wrap;
}
.q-rv__tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 10px 17px;
  border-radius: var(--q-r-sm);
  border: 1px solid var(--q-border);
  background: var(--q-surface);
  font: 700 14px var(--q-font);
  color: var(--q-text-2);
  cursor: pointer;
  transition: all var(--q-dur) var(--q-ease);
}
.q-rv__tab em {
  font-style: normal;
  font-size: 12px;
  padding: 1px 7px;
  border-radius: 99px;
  background: var(--q-surface-3);
  color: var(--q-text-3);
}
.q-rv__tab:hover {
  transform: translateY(-1px);
  box-shadow: var(--q-shadow-sm);
}
.q-rv__tab.is-active.is-bad {
  border-color: color-mix(in srgb, var(--q-bad) 45%, transparent);
  background: var(--q-bad-bg);
  color: var(--q-bad);
}
.q-rv__tab.is-active.is-bad em {
  background: var(--q-bad);
  color: #fff;
}
.q-rv__tab.is-active.is-warn {
  border-color: color-mix(in srgb, var(--q-star) 45%, transparent);
  background: var(--q-warn-bg);
  color: var(--q-star);
}
.q-rv__tab.is-active.is-warn em {
  background: var(--q-star);
  color: #fff;
}
/* 笔记标签页 */
.q-rv__tab.is-active.is-note {
  border-color: color-mix(in srgb, var(--q-brand-2) 45%, transparent);
  background: color-mix(in srgb, var(--q-brand-2) 12%, transparent);
  color: var(--q-brand-2);
}
.q-rv__tab.is-active.is-note em {
  background: var(--q-brand-2);
  color: #fff;
}

/* ---------- 筛选条 ---------- */
.q-rv__bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  flex-wrap: wrap;
}
.q-rv__chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.q-rv__chips .q-chip {
  border: 0;
  cursor: pointer;
  height: 28px;
}
.q-rv__chips .q-chip em {
  font-style: normal;
  margin-left: 3px;
  font-size: 11px;
}
.q-rv__chips .q-chip:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.q-rv__search {
  width: 200px;
  margin-left: auto;
}
.q-rv__bar-actions {
  display: flex;
  gap: 2px;
}

/* ---------- 列表 ---------- */
.q-rv__list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.q-rv__item {
  overflow: hidden;
  transition: border-color var(--q-dur) var(--q-ease), box-shadow var(--q-dur) var(--q-ease);
}
.q-rv__item.is-open {
  border-color: color-mix(in srgb, var(--q-brand-1) 35%, transparent);
  box-shadow: var(--q-shadow-sm);
}
.q-rv__item-head {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 13px 15px;
  cursor: pointer;
  transition: background-color var(--q-dur) var(--q-ease);
}
.q-rv__item-head:hover {
  background: var(--q-surface-2);
}
.q-rv__no {
  font-size: 12px;
  flex: 0 0 auto;
}
.q-rv__stem {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--q-text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* 列表里的填空占位要比大题卡里小一号 */
.q-rv__stem :deep(.q-blank) {
  width: 2.2em;
  height: 0.85em;
  margin: 0 2px;
  vertical-align: -0.08em;
}
.q-rv__verdict {
  flex: 0 0 auto;
}
.q-rv__act {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: 0;
  background: transparent;
  color: var(--q-text-3);
  cursor: pointer;
  transition: all var(--q-dur) var(--q-ease);
}
.q-rv__act:hover {
  background: var(--q-ok-bg);
  color: var(--q-ok);
}
.q-rv__arrow {
  flex: 0 0 auto;
  color: var(--q-text-3);
}

/* ---------- 展开详情 ---------- */
.q-rv__detail {
  padding: 4px 15px 16px;
  display: flex;
  flex-direction: column;
  gap: 13px;
  border-top: 1px dashed var(--q-border);
}
.q-rv__opts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}
/* 代码题在错题本里也要看得见代码 */
.q-rv__code {
  margin: 12px 0 0;
  padding: 10px 12px;
  border-radius: var(--q-r-xs);
  background: var(--q-bg-deep);
  font-family: var(--q-mono);
  font-size: 12.5px;
  line-height: 1.75;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
}
.q-rv__ans {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
  font-size: 13px;
  color: var(--q-text-2);
}
.q-rv__ans b {
  font-size: 14px;
  font-weight: 800;
  letter-spacing: 0.04em;
}
/* 解析外框；正文排版（强调/行内代码/围栏）在 AnalysisBody 里 */
.q-rv__analysis {
  padding: 12px 14px;
  border-radius: var(--q-r-sm);
  background: var(--q-surface-2);
  border-left: 3px solid var(--q-brand-2);
  font-size: 13.5px;
}
.q-rv__tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

/* ---------- 笔记摘要（列表里显示自己写过什么） ---------- */
.q-rv__note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  width: 100%;
  padding: 0 15px 12px;
  border: 0;
  background: transparent;
  font: inherit;
  text-align: left;
  color: var(--q-brand-2);
  cursor: pointer;
}
.q-rv__note span {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--q-text-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  white-space: pre-wrap;
}
.q-rv__note .el-icon {
  margin-top: 3px;
  flex: 0 0 auto;
}

/* ---------- 笔记编辑区 ---------- */
.q-rv__notewrap {
  padding-top: 4px;
}

.q-exp-enter-active,
.q-exp-leave-active {
  transition: opacity 0.22s var(--q-ease), max-height 0.3s var(--q-ease);
  overflow: hidden;
}
.q-exp-enter-from,
.q-exp-leave-to {
  opacity: 0;
  max-height: 0;
}
.q-exp-enter-to,
.q-exp-leave-from {
  opacity: 1;
  max-height: 1200px;
}

@media (max-width: 700px) {
  .q-rv__search {
    width: 100%;
    margin-left: 0;
  }
  .q-rv__verdict {
    display: none;
  }
  .q-rv__quick :deep(.el-button) {
    flex: 1;
  }
}
</style>
