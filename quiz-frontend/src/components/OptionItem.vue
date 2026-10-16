<script setup>
/**
 * OptionItem —— 一个选项。视觉状态由 props 推导，父组件只管传数据。
 * 状态：idle | picked | correct | wrong | missed
 *   - correct：选了 且 是正确答案
 *   - missed ：没选 但 是正确答案（多选题里尤其重要，得告诉用户漏了哪个）
 *   - wrong  ：选了 但 不是正确答案
 */
import { computed } from 'vue'

const props = defineProps({
  option: { type: Object, required: true }, // { key, text }
  picked: { type: Boolean, default: false },
  revealed: { type: Boolean, default: false },
  isAnswer: { type: Boolean, default: false },
  judge: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['pick'])

const state = computed(() => {
  if (!props.revealed) return props.picked ? 'picked' : 'idle'
  if (props.isAnswer && props.picked) return 'correct'
  if (props.isAnswer && !props.picked) return 'missed'
  if (!props.isAnswer && props.picked) return 'wrong'
  return 'idle'
})

const statusIcon = computed(() => {
  switch (state.value) {
    case 'correct':
      return 'Select'
    case 'missed':
      return 'Check'
    case 'wrong':
      return 'CloseBold'
    default:
      return ''
  }
})

const statusText = computed(() => {
  switch (state.value) {
    case 'correct':
      return '答对'
    case 'missed':
      return '正确答案'
    case 'wrong':
      return '答错'
    default:
      return ''
  }
})

function onPick() {
  if (props.disabled) return
  emit('pick', props.option.key)
}
</script>

<template>
  <div
    class="q-opt"
    :class="[`is-${state}`, { 'q-opt--judge': judge, 'is-disabled': disabled }]"
    role="button"
    tabindex="0"
    :aria-pressed="picked"
    @click="onPick"
    @keydown.enter.prevent="onPick"
    @keydown.space.prevent="onPick"
  >
    <!-- 判断题：用大图标替代 A/B/C/D 字母 -->
    <span v-if="judge" class="q-opt__badge q-opt__badge--judge">
      <el-icon :size="20">
        <component :is="option.key === 'T' ? 'CircleCheckFilled' : 'CircleCloseFilled'" />
      </el-icon>
    </span>
    <span v-else class="q-opt__badge">{{ option.key }}</span>

    <span class="q-opt__text">{{ option.text }}</span>

    <transition name="q-opt-fade">
      <span v-if="statusIcon" class="q-opt__status" :class="`is-${state}`">
        <el-icon :size="13"><component :is="statusIcon" /></el-icon>
        <em>{{ statusText }}</em>
      </span>
    </transition>
  </div>
</template>

<style scoped>
.q-opt {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 13px;
  padding: 14px 16px;
  border: 1.5px solid var(--q-border);
  border-radius: var(--q-r-sm);
  background: var(--q-surface);
  cursor: pointer;
  user-select: none;
  transition: border-color var(--q-dur) var(--q-ease), background-color var(--q-dur) var(--q-ease),
    transform 0.16s var(--q-ease), box-shadow var(--q-dur) var(--q-ease);
}

.q-opt:focus-visible {
  outline: 2px solid var(--q-brand-1);
  outline-offset: 2px;
}

/* ---------- 悬停：轻微抬起 + 品牌色描边 ---------- */
.q-opt:hover:not(.is-disabled):not(.is-correct):not(.is-wrong):not(.is-missed) {
  border-color: color-mix(in srgb, var(--q-brand-1) 45%, transparent);
  background: var(--q-surface-2);
  transform: translateY(-1px);
}
.q-opt:active:not(.is-disabled) {
  transform: translateY(0) scale(0.995);
}

/* ---------- 已选（未揭示） ---------- */
.q-opt.is-picked {
  border-color: var(--q-brand-1);
  background: color-mix(in srgb, var(--q-brand-1) 9%, var(--q-surface));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--q-brand-1) 14%, transparent);
}

/* ---------- 答对 ---------- */
.q-opt.is-correct {
  border-color: var(--q-ok);
  background: var(--q-ok-bg);
}
.q-opt.is-correct .q-opt__badge {
  background: var(--q-ok);
  color: #fff;
  border-color: var(--q-ok);
}

/* ---------- 漏选的正确答案 ---------- */
.q-opt.is-missed {
  border-color: var(--q-ok);
  border-style: dashed;
  background: transparent;
}
.q-opt.is-missed .q-opt__badge {
  border-color: var(--q-ok);
  color: var(--q-ok);
  background: transparent;
}

/* ---------- 答错 ---------- */
.q-opt.is-wrong {
  border-color: var(--q-bad);
  background: var(--q-bad-bg);
  animation: q-shake 0.4s var(--q-ease);
}
.q-opt.is-wrong .q-opt__badge {
  background: var(--q-bad);
  color: #fff;
  border-color: var(--q-bad);
}
.q-opt.is-wrong .q-opt__text {
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--q-bad) 55%, transparent);
  text-decoration-thickness: 1.5px;
  opacity: 0.75;
}

.q-opt.is-disabled {
  cursor: default;
}

/* ---------- 字母徽标 ---------- */
.q-opt__badge {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  border: 1.5px solid var(--q-border-strong);
  background: var(--q-surface-3);
  font: 700 14px/1 var(--q-font);
  color: var(--q-text-2);
  transition: all var(--q-dur) var(--q-ease);
}
.q-opt.is-picked .q-opt__badge {
  background: var(--q-brand-1);
  border-color: var(--q-brand-1);
  color: #fff;
}
.q-opt__badge--judge {
  width: 34px;
  height: 34px;
  border-radius: 11px;
  color: var(--q-text-3);
}
.q-opt.is-picked .q-opt__badge--judge {
  color: #fff;
}

/* ---------- 正文 ---------- */
.q-opt__text {
  flex: 1 1 auto;
  font-size: var(--q-opt-size);
  line-height: 1.68;
  color: var(--q-text);
  padding-top: 3px;
  word-break: break-word;
  transition: color var(--q-dur) var(--q-ease);
}

/* ---------- 右侧状态 ---------- */
.q-opt__status {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  align-self: center;
  padding: 3px 9px;
  border-radius: var(--q-r-full);
  font-size: 11.5px;
  font-weight: 700;
  white-space: nowrap;
}
.q-opt__status em {
  font-style: normal;
}
.q-opt__status.is-correct,
.q-opt__status.is-missed {
  background: var(--q-ok);
  color: #fff;
}
.q-opt__status.is-missed {
  background: transparent;
  color: var(--q-ok);
  box-shadow: inset 0 0 0 1.5px var(--q-ok);
}
.q-opt__status.is-wrong {
  background: var(--q-bad);
  color: #fff;
}

.q-opt-fade-enter-active {
  transition: opacity 0.25s var(--q-ease), transform 0.25s var(--q-ease);
}
.q-opt-fade-enter-from {
  opacity: 0;
  transform: translateX(6px);
}

/* ---------- 判断题：两个大卡片并排 ---------- */
.q-opt--judge {
  flex: 1 1 0;
  align-items: center;
  gap: 10px;
  padding: 18px 16px;
}
.q-opt--judge .q-opt__text {
  padding-top: 0;
  font-size: calc(var(--q-opt-size) + 1px);
  font-weight: 650;
  text-align: left;
}

@media (max-width: 600px) {
  .q-opt {
    padding: 12px 13px;
    gap: 11px;
  }
  .q-opt__badge {
    width: 27px;
    height: 27px;
    font-size: 13px;
  }
  .q-opt__status em {
    display: none;
  }
}
</style>
