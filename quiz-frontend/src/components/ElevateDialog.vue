<script setup>
/**
 * ElevateDialog.vue —— 提权对话框（密码 → 短期通行证）
 * ============================================================================
 * ★ 它不是安全边界，只是"门把手"。
 *   敲键序列在公开的 bundle 里，谁都看得到；密码框弹不弹出来不重要，
 *   **服务端校验密码**才是那道门（apps/quizgen/elevate.py）。
 *   所以这个组件里**不能**出现任何"判断密码对不对"的逻辑 —— 只负责把密码送出去。
 *
 * 通行证存 sessionStorage（见 core/elevate.js 的解释）：会话级授权，关标签页即失效。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Lock, Key } from '@element-plus/icons-vue'
import { elevate as apiElevate } from '@/core/api'
import { clearToken, loadToken, remainingMs, saveToken } from '@/core/elevate'

const props = defineProps({
  /** 是否显示。父组件（App）管着敲键序列，凑齐了就把这个打开 */
  modelValue: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

const password = ref('')
const busy = ref(false)
const errorText = ref('')
/** 现在是"已提权"状态吗（用来显示剩余时间 + 退出按钮） */
const leftMs = ref(remainingMs())

let tick = 0
watch(visible, (open) => {
  if (open) {
    password.value = ''
    errorText.value = ''
    leftMs.value = remainingMs()
    clearInterval(tick)
    // 每秒刷新剩余时间：提权是"会话级"的，得让用户看得见它什么时候到期
    tick = setInterval(() => {
      leftMs.value = remainingMs()
    }, 1000)
  } else {
    clearInterval(tick)
  }
})

const elevated = computed(() => leftMs.value > 0)
const leftText = computed(() => {
  const total = Math.ceil(leftMs.value / 1000)
  if (total <= 0) return ''
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m} 分 ${String(s).padStart(2, '0')} 秒` : `${s} 秒`
})

async function submit() {
  if (busy.value || !password.value) return
  busy.value = true
  errorText.value = ''
  try {
    const payload = await apiElevate(password.value)
    saveToken(payload.token, payload.expiresIn)
    leftMs.value = remainingMs()
    password.value = ''
    ElMessage.success('已提权。危险操作（比如 Java 真跑）现在可用，过期后自动失效。')
  } catch (error) {
    // 服务端只回"密码不对"，不区分原因（别当预言机）—— 这里原样转达
    errorText.value = error?.message || '提权失败。'
  } finally {
    busy.value = false
  }
}

function drop() {
  clearToken()
  leftMs.value = 0
  ElMessage.info('已退出提权。')
}
</script>

<template>
  <el-dialog v-model="visible" title="站内提权" width="420px" append-to-body>
    <div class="q-el">
      <p class="q-el__lead">
        <el-icon><Lock /></el-icon>
        有些操作会在服务器上执行代码（比如 Java 真跑），所以默认关闭。
        输入提权密码换取一张短期通行证。
      </p>

      <div v-if="elevated" class="q-el__status is-on">
        <el-icon><Key /></el-icon>
        已提权，剩余 <b>{{ leftText }}</b>
        <el-button size="small" text type="danger" @click="drop">立即退出</el-button>
      </div>

      <el-input
        v-model="password"
        type="password"
        show-password
        placeholder="提权密码"
        autocomplete="off"
        :disabled="busy"
        @keyup.enter="submit"
      />

      <p v-if="errorText" class="q-el__err">{{ errorText }}</p>
      <p class="q-el__tip">
        通行证只存在这个标签页里（sessionStorage），关掉页面就没了。
        密码只发给服务器校验，前端不保存。
      </p>
    </div>

    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
      <el-button type="primary" :loading="busy" :disabled="!password" @click="submit">解锁</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.q-el__lead {
  display: flex;
  gap: 7px;
  align-items: flex-start;
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--q-text-2);
}
.q-el__status {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 10px;
  padding: 7px 10px;
  border-radius: var(--q-r-sm);
  font-size: 12.5px;
  background: color-mix(in srgb, var(--q-ok) 12%, transparent);
  border-left: 3px solid var(--q-ok);
  color: var(--q-text-2);
}
.q-el__status b {
  color: var(--q-ok);
}
.q-el__err {
  margin: 8px 0 0;
  font-size: 12.5px;
  color: var(--q-bad);
}
.q-el__tip {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--q-dim);
}
</style>
