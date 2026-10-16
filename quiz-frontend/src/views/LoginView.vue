<script setup>
/**
 * LoginView —— 登录 / 注册。
 *
 * 这个页面要回答两个问题（顺序很重要）：
 *   ① **为什么要登录**：「进度跟着账号走」——换设备、换浏览器、清缓存都不丢。
 *      说不清这一点的登录页，学生只会觉得"又要我注册"。
 *   ② **不登录会怎样**：照常刷，只是进度留在这台浏览器里。
 *      刷题站从第一天起就是"没后端也能用"，登录不能变成一道墙。
 *
 * 密码只发给服务端（Django session 认证），前端**不做**任何"密码判断"。
 * 这里的 validateXxx 只是本地体验（别让人点提交才看到"不能有空格"），规则以后端为准。
 */
import { computed, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  auth,
  isLoggedIn,
  login,
  logout,
  register,
  validateNickname,
  validatePassword,
  validateUsername,
} from '@/core/auth'
import { stopSync, syncBank, syncLabel } from '@/core/sync'
import { useQuizStore } from '@/stores/quiz'

const route = useRoute()
const router = useRouter()
const quiz = useQuizStore()

const tab = ref('login')
const error = ref('')
const form = reactive({ username: '', password: '', confirm: '', nickname: '', key: '' })

const signupOpen = computed(() => !auth.signup?.closed)
const keyRequired = computed(() => !!auth.signup?.keyRequired)
const signupNote = computed(() => auth.signup?.note || '')

/** 登录/注册成功后回到"他本来想去的地方"（比如从错题本被弹过来的） */
function back() {
  const target = typeof route.query.redirect === 'string' ? route.query.redirect : ''
  router.replace(target || '/')
}

/**
 * 登录/注册成功之后的**必要动作**：把当前这套题库和账号对齐一次。
 *
 * 为什么必须做：学生之所以来登录，几乎都是因为"我换设备了/我进度丢了"。
 * 登录完不立刻同步，他就得自己去各页面点点看有没有回来 —— 那不叫同步。
 */
async function afterAuth(message) {
  let synced = null
  if (quiz.bankId) synced = await syncBank(quiz, { quiet: false })
  ElMessage.success(synced ? `${message} · 进度已同步` : message)
  back()
}

async function submitLogin() {
  error.value = validateUsername(form.username)
  if (!error.value && !form.password) error.value = '请填密码'
  if (error.value) return
  try {
    await login(form.username, form.password)
    await afterAuth(`欢迎回来，${auth.user?.nickname || auth.user?.username}`)
  } catch (e) {
    error.value = e.message
  }
}

async function submitRegister() {
  error.value =
    validateUsername(form.username) ||
    validatePassword(form.password) ||
    validateNickname(form.nickname)
  if (!error.value && form.password !== form.confirm) error.value = '两次输入的密码不一样'
  if (!error.value && keyRequired.value && !form.key.trim()) error.value = '请填邀请码'
  if (error.value) return
  try {
    await register({
      username: form.username,
      password: form.password,
      nickname: form.nickname,
      key: form.key,
    })
    await afterAuth('注册成功，已经登录')
  } catch (e) {
    error.value = e.message
  }
}

function switchTab(next) {
  tab.value = next
  error.value = ''
}

async function onLogout() {
  try {
    await ElMessageBox.confirm(
      '退出只是把账号从这台浏览器上摘下来，错题本和笔记都还在账号里；这台浏览器上的进度也留着。',
      '退出登录',
      { type: 'warning', confirmButtonText: '退出', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  stopSync()
  await logout()
  ElMessage.success('已退出登录')
}
</script>

<template>
  <div class="q-wrap lg-wrap">
    <section class="lg-hero">
      <h1 class="lg-hero__title">
        登录一个账号，<br /><span class="q-grad-text">进度就跟着你走</span>。
      </h1>
      <p class="lg-hero__sub">
        错题本、收藏、笔记、作答历史会存到账号里 —— 换台电脑、换个浏览器、清一次缓存都还在。
        <b>不登录也能照常刷</b>，只是进度只留在这台浏览器里。
      </p>
    </section>

    <!-- ─────────────── 已经登录 ─────────────── -->
    <section v-if="isLoggedIn()" class="q-card lg-card">
      <div class="lg-me">
        <span class="lg-me__avatar">{{ (auth.user.nickname || auth.user.username || '?').slice(0, 1) }}</span>
        <div class="lg-me__text">
          <strong>{{ auth.user.nickname || auth.user.username }}</strong>
          <em>@{{ auth.user.username }}</em>
        </div>
      </div>
      <p class="lg-note">{{ syncLabel() || '进度已跟着这个账号' }}</p>
      <div class="lg-actions">
        <el-button @click="back">回去刷题</el-button>
        <el-button type="primary" plain @click="onLogout">退出登录</el-button>
      </div>
    </section>

    <!-- ─────────────── 登录 / 注册 ─────────────── -->
    <section v-else class="q-card lg-card">
      <div class="lg-tabs">
        <button
          class="lg-tab"
          :class="{ 'is-on': tab === 'login' }"
          @click="switchTab('login')"
        >
          登录
        </button>
        <button
          v-if="signupOpen"
          class="lg-tab"
          :class="{ 'is-on': tab === 'register' }"
          @click="switchTab('register')"
        >
          注册
        </button>
      </div>

      <p v-if="tab === 'register'" class="lg-note">{{ signupNote }}</p>

      <form class="lg-form" @submit.prevent="tab === 'login' ? submitLogin() : submitRegister()">
        <label class="lg-field">
          <span class="lg-field__label">用户名</span>
          <el-input
            v-model="form.username"
            size="large"
            autocomplete="username"
            :placeholder="tab === 'register' ? '汉字、字母、数字都行，2~30 位' : '你的用户名'"
          />
        </label>

        <label class="lg-field">
          <span class="lg-field__label">密码</span>
          <el-input
            v-model="form.password"
            type="password"
            size="large"
            show-password
            :autocomplete="tab === 'login' ? 'current-password' : 'new-password'"
            :placeholder="tab === 'register' ? '至少 8 位，别用纯数字' : '你的密码'"
          />
        </label>

        <template v-if="tab === 'register'">
          <label class="lg-field">
            <span class="lg-field__label">再输一次密码</span>
            <el-input
              v-model="form.confirm"
              type="password"
              size="large"
              show-password
              autocomplete="new-password"
              placeholder="两次要一样"
            />
          </label>
          <label class="lg-field">
            <span class="lg-field__label">昵称<em class="lg-optional">（可以不填）</em></span>
            <el-input
              v-model="form.nickname"
              size="large"
              maxlength="24"
              placeholder="想显示成什么名字，默认用用户名"
            />
          </label>
          <label v-if="keyRequired" class="lg-field">
            <span class="lg-field__label">邀请码</span>
            <el-input v-model="form.key" size="large" placeholder="找老师要一个" />
          </label>
        </template>

        <p v-if="error" class="lg-error" role="alert">{{ error }}</p>

        <el-button
          type="primary"
          size="large"
          class="lg-submit"
          native-type="submit"
          :loading="auth.busy"
        >
          {{ tab === 'login' ? '登录' : '注册并开始刷' }}
        </el-button>
      </form>

      <p v-if="!signupOpen" class="lg-note lg-note--warn">
        现在只能登录，自助注册暂时关着 —— 要开号找老师。
      </p>
      <p v-else-if="tab === 'login'" class="lg-note">
        还没有账号？点上面的「注册」，只要用户名和密码，不用邮箱也不用手机号。
      </p>
    </section>
  </div>
</template>

<style scoped>
.lg-wrap {
  display: flex;
  flex-direction: column;
  gap: 26px;
  max-width: 560px;
}

.lg-hero__title {
  font-size: clamp(25px, 4vw, 38px);
  font-weight: 850;
  line-height: 1.25;
  letter-spacing: -0.015em;
  color: var(--q-text);
}
.lg-hero__sub {
  margin-top: 12px;
  font-size: 14px;
  line-height: 1.75;
  color: var(--q-text-2);
}
.lg-hero__sub b {
  color: var(--q-text);
}

.lg-card {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px 20px 22px;
}

.lg-me {
  display: flex;
  align-items: center;
  gap: 12px;
}
.lg-me__avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 14px;
  background: var(--q-grad);
  color: #fff;
  font-size: 19px;
  font-weight: 800;
  flex: 0 0 auto;
  box-shadow: var(--q-shadow-brand);
}
.lg-me__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.lg-me__text strong {
  font-size: 16px;
  font-weight: 750;
  color: var(--q-text);
}
.lg-me__text em {
  font-style: normal;
  font-size: 12.5px;
  color: var(--q-text-3);
}
.lg-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.lg-tabs {
  display: flex;
  gap: 8px;
  padding: 4px;
  border-radius: 12px;
  background: var(--q-surface-3);
}
.lg-tab {
  flex: 1;
  padding: 9px 0;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--q-text-2);
  font: inherit;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
  transition: all var(--q-dur) var(--q-ease);
}
.lg-tab.is-on {
  background: var(--q-surface);
  color: var(--q-brand-1);
  box-shadow: var(--q-shadow-sm);
}

.lg-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.lg-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.lg-field__label {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--q-text-3);
}
.lg-optional {
  font-style: normal;
  font-weight: 500;
}
.lg-submit {
  width: 100%;
  margin-top: 4px;
  font-weight: 750;
}
.lg-error {
  margin: 0;
  padding: 9px 12px;
  border-radius: 10px;
  background: var(--q-bad-bg);
  color: var(--q-bad);
  font-size: 13px;
  line-height: 1.6;
}
.lg-note {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--q-text-3);
}
.lg-note--warn {
  color: var(--q-star);
}
</style>
