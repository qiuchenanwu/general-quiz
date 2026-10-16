import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import * as ElIcons from '@element-plus/icons-vue'

import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './styles/theme.css'

import App from './App.vue'
import router from './router'
import { installAudioUnlock } from './core/feedback'

// 浏览器的自动播放策略要求 AudioContext 必须在用户手势里解锁。
// 这里挂一次性监听：用户第一次点屏幕/敲键盘就把音频唤醒，
// 之后答题音效才出得来（否则第一声总是被吞掉）。
installAudioUnlock()

const app = createApp(App)

// 图标全量注册：<el-icon><Check /></el-icon> 和 <component :is="'Check'" /> 都能用
for (const [name, comp] of Object.entries(ElIcons)) {
  app.component(name, comp)
}

app.use(createPinia())
app.use(router)
app.use(ElementPlus, { locale: zhCn })
app.mount('#app')
