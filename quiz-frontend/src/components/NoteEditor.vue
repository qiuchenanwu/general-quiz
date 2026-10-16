<script setup>
/**
 * NoteEditor —— 一道题的笔记编辑器。
 * 练习页和笔记页共用它，保证两处的编辑体验一致。
 *
 * 快捷键：Ctrl/Cmd + Enter 保存，Esc 取消
 */
import { nextTick, onMounted, ref, watch } from 'vue'

const props = defineProps({
  /** 已存在的笔记内容（没有就传空串） */
  modelValue: { type: String, default: '' },
  /** 题干摘要，放在编辑器上方提醒你正在给哪道题写 */
  label: { type: String, default: '' },
  autofocus: { type: Boolean, default: true },
})

const emit = defineEmits(['save', 'remove', 'cancel'])

const draft = ref(props.modelValue || '')
const box = ref(null)

watch(
  () => props.modelValue,
  (v) => {
    draft.value = v || ''
  },
)

onMounted(async () => {
  if (!props.autofocus) return
  await nextTick()
  const ta = box.value?.querySelector?.('textarea')
  if (ta) {
    ta.focus()
    // 光标放到末尾，接着上次写
    ta.setSelectionRange(ta.value.length, ta.value.length)
  }
})

function save() {
  emit('save', draft.value)
}

/** 有内容才算"脏"，避免点取消时误判 */
function onKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault()
    save()
    return
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    emit('cancel')
  }
}
</script>

<template>
  <div class="q-note-edit" @keydown="onKeydown">
    <div v-if="label" class="q-note-edit__label">
      <el-icon :size="12"><Memo /></el-icon>{{ label }}
    </div>

    <!-- ref 必须挂在普通元素上：挂到 <el-input> 上拿到的是组件实例，
         它没有 querySelector，会直接抛 TypeError（自动聚焦就废了） -->
    <div ref="box" class="q-note-edit__field">
      <el-input
        v-model="draft"
        type="textarea"
        :autosize="{ minRows: 3, maxRows: 12 }"
        resize="vertical"
        maxlength="2000"
        show-word-limit
        placeholder="写点什么…比如：为什么错、易混点、口诀、老师强调过的坑"
      />
    </div>

    <div class="q-note-edit__bar">
      <span class="q-note-edit__hint">
        <span class="q-kbd">Ctrl</span>+<span class="q-kbd">Enter</span> 保存 ·
        <span class="q-kbd">Esc</span> 取消
      </span>
      <span class="q-note-edit__btns">
        <el-button
          v-if="modelValue"
          text
          type="danger"
          @click="emit('remove')"
        >
          <el-icon style="margin-right: 4px"><Delete /></el-icon>删除笔记
        </el-button>
        <el-button @click="emit('cancel')">取消</el-button>
        <el-button type="primary" @click="save">
          <el-icon style="margin-right: 4px"><Select /></el-icon>保存
        </el-button>
      </span>
    </div>
  </div>
</template>

<style scoped>
.q-note-edit {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.q-note-edit__label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--q-brand-2);
}
.q-note-edit__field {
  width: 100%;
}
.q-note-edit__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.q-note-edit__hint {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--q-text-3);
}
.q-note-edit__btns {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
</style>
