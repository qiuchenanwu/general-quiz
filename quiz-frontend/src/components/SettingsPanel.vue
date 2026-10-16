<script setup>
/**
 * 全局设置抽屉：外观、答题行为、数据清理。
 */
import { computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useQuizStore } from '@/stores/quiz'
import { useBankStore } from '@/stores/bank'
import { usePlayerStore } from '@/stores/player'
import { storageWorks } from '@/core/storage'
import { CODE_THEMES } from '@/core/code-theme'
import { previewSfx } from '@/core/feedback'
import { auth } from '@/core/auth'

const props = defineProps({ modelValue: Boolean })
const emit = defineEmits(['update:modelValue'])

const quiz = useQuizStore()
const bank = useBankStore()
// 音量要**同时**写设置和正在响的那个引擎，所以走 player store 的 setVolume
const player = usePlayerStore()

/* ------------------------------- 音乐：曲库辅助 ------------------------------- */

/** 曲库里认出来的网页地址里，第一条网易云链接（用来做"一键改成正确用法"） */
const firstNetease = computed(() => (quiz.myMusic.pages || []).find((p) => p.netease)?.netease || null)

/** 把粘错的网易云网页地址转成正确的 ID 配置（用户意图很清楚，别只报错） */
function useNeteaseLink() {
  const nz = firstNetease.value
  if (!nz) return
  quiz.setSetting('musicType', nz.kind)
  quiz.setSetting('musicId', nz.id)
  ElMessage.success('已经把 ID 填好了，改用官方外链播放器')
}

/**
 * 填入内置演示曲目。**追加而不是覆盖** —— 用户可能已经填了自己的歌，
 * 只是想试一下播放页长什么样，把他的列表冲掉是不可接受的。
 */
const DEMO_LINE = '演示音轨（内置） | ./demo/demo.wav | | ./demo/demo.lrc'
function fillDemo() {
  const cur = String(quiz.settings.musicList || '')
  if (cur.includes(DEMO_LINE)) {
    ElMessage.info('演示曲目已经在列表里了')
  } else {
    quiz.setSetting('musicList', cur.trim() ? `${cur.trim()}\n${DEMO_LINE}` : DEMO_LINE)
    ElMessage.success('已加入演示曲目（带歌词，打开右下角播放器或播放页就能听）')
  }
  quiz.setSetting('musicOn', true)
}

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

const THEMES = [
  { value: 'auto', label: '跟随系统', icon: 'Monitor' },
  { value: 'light', label: '浅色', icon: 'Sunny' },
  { value: 'dark', label: '深色', icon: 'Moon' },
]

/**
 * 背景模式。要和 components/AppBackground.vue 里认的那几个值一致。
 * 默认 none —— 省电、对比度最好；好看是加分，不能拿阅读体验换。
 *
 * ⚠️ 顺序有讲究，别乱调：
 *   · 「极光」必须排在「极光·帘」前面 —— tools/shoot.py 的 pick_bg() 是按
 *     **文字**找 .q-seg__item 再取 .first 的，`pick_bg("极光")` 会同时命中
 *     这两个（子串匹配），靠前面的那个先被选中才是原来的极光。
 *   · 「星点 / 星云 / 无」同理，新增的名字都刻意避开了这些子串
 *     （新的是「星芒」「波浪」「极光·帘」「旋涡」「黑洞」「神经网」）。
 *   · 11 个塞进 3 列网格会自动折成 4 行（.q-seg 本来就是 3 列 grid），
 *     实测每格约 110px 宽，最长的「极光·帘」也没被挤断 ——
 *     4 行只比 3 行高约 36px，抽屉是整屏高的，放得下，所以不动网格列数
 *     （改成 2 列会让「极光·帘」在 150px 格里换行，反而更乱）。
 *   · **新增的三项一律追加在末尾**：pick_bg() 取的是 .first，
 *     已有项的先后顺序一动就可能改掉截图脚本选中哪个背景。
 */
const BACKGROUNDS = [
  { value: 'none', label: '无' },
  { value: 'aurora', label: '极光' },
  { value: 'aurora2', label: '极光·帘' },
  { value: 'silk', label: '丝缎' },
  { value: 'stars', label: '星点' },
  { value: 'sparkles', label: '星芒' },
  { value: 'wavy', label: '波浪' },
  { value: 'webgl', label: '星云' },
  // 2026-10-08 新增三个（vortex / blackhole / neural）——
  // 名字都不含「极光 / 星点 / 星云 / 无」，所以 shoot.py 的子串匹配不受影响
  { value: 'vortex', label: '旋涡' },
  { value: 'blackhole', label: '黑洞' },
  { value: 'neural', label: '神经网' },
  // Vanta（MIT，github.com/tengbao/vanta）的 3D 效果。
  // ⚠️ 这六个会**懒加载 three.js**（约 750KB，独立 chunk）—— 只有真选中才下载，
  //    不玩背景的人一个字节都不付（实测主包只多了 3KB）。
  // ⚠️ 开了「减少动态效果」时会自动退回「极光·帘」：Vanta 只有"一直动"，
  //    没有"画一帧停住"的接口（详见 AppBackground.vue 里 VANTA_MODES 上的注释）。
  { value: 'vanwaves', label: '海浪' },
  { value: 'vanfog', label: '迷雾' },
  { value: 'vanclouds', label: '云海' },
  { value: 'vannet', label: '网格' },
  { value: 'vancells', label: '细胞' },
]

/** 试听按钮：名字要和 core/feedback.js 里的 SFX_NAMES 对上 */
const SOUND_TRIES = [
  { name: 'click', label: '选中', icon: 'Pointer' },
  { name: 'correct', label: '答对', icon: 'CircleCheckFilled' },
  { name: 'wrong', label: '答错', icon: 'CircleCloseFilled' },
  { name: 'star', label: '收藏', icon: 'StarFilled' },
  { name: 'finish', label: '完成', icon: 'Trophy' },
]

/**
 * 登录着的时候，清理动作**也会改账号里那份**（那是设计，不是副作用）。
 * 提示里必须说出来 —— 不然学生在 A 设备清空错题本、去 B 设备发现也空了，
 * 会以为"网站自己删我东西"。
 */
const accountNote = computed(() => (auth.user ? '\n账号里那份也会一起改（换台设备看到的结果一样）。' : ''))

async function clearWrong() {
  try {
    await ElMessageBox.confirm(
      `确定清空错题本里的 ${quiz.wrongCount} 道题吗？此操作不可撤销。${accountNote.value}`,
      '清空错题本',
      { type: 'warning', confirmButtonText: '清空', cancelButtonText: '取消' },
    )
    quiz.clearWrong()
    ElMessage.success('错题本已清空')
  } catch {}
}

async function resetAll() {
  const name = bank.meta?.title || '本套题库'
  try {
    await ElMessageBox.confirm(
      `将清空「${name}」的作答记录、错题本和收藏，题库本身不受影响。笔记会保留。确定吗？` +
        accountNote.value,
      '重置进度',
      { type: 'warning', confirmButtonText: '重置', cancelButtonText: '取消' },
    )
    quiz.resetProgress()
    ElMessage.success('进度已重置（笔记保留）')
  } catch {}
}

async function clearNotes() {
  const n = quiz.noteCount
  if (!n) return
  try {
    await ElMessageBox.confirm(
      `删除本套题库的全部 ${n} 条笔记？笔记是你自己写的，删了找不回来。\n` +
        '（建议先在「复习本 → 笔记」里导出成 Markdown 备份）' +
        accountNote.value,
      '清空笔记',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
    quiz.clearNotes()
    ElMessage.success('笔记已清空')
  } catch {}
}

async function clearLearningHistory() {
  const n = quiz.history.length
  if (!n) return
  try {
    await ElMessageBox.confirm(
      `清空本套题库的 ${n} 条作答历史？\n` +
        '学习报告里的热力图、正确率趋势、知识点弱项全部来自这份历史，清掉之后就归零了。\n' +
        '（作答对错、错题本、笔记都不受影响）' +
        accountNote.value,
      '清空学习记录',
      { type: 'warning', confirmButtonText: '清空', cancelButtonText: '取消' },
    )
    quiz.clearHistory()
    ElMessage.success('学习记录已清空')
  } catch {}
}
</script>

<template>
  <el-drawer v-model="visible" title="设置" size="380px" class="q-settings" :z-index="3000">
    <div class="q-set">
      <section class="q-set__sec">
        <h4 class="q-set__title">外观</h4>
        <div class="q-set__row q-set__row--col">
          <span class="q-set__label">主题</span>
          <div class="q-seg">
            <button
              v-for="t in THEMES"
              :key="t.value"
              class="q-seg__item"
              :class="{ 'is-active': quiz.settings.theme === t.value }"
              @click="quiz.setSetting('theme', t.value)"
            >
              <el-icon><component :is="t.icon" /></el-icon>
              <span>{{ t.label }}</span>
            </button>
          </div>
        </div>

        <div class="q-set__row q-set__row--col">
          <span class="q-set__label">代码块主题</span>
          <div class="q-seg">
            <button
              v-for="c in CODE_THEMES"
              :key="c.id"
              class="q-seg__item"
              :class="{ 'is-active': quiz.settings.codeTheme === c.id }"
              :title="c.hint"
              @click="quiz.setSetting('codeTheme', c.id)"
            >
              <span>{{ c.label }}</span>
            </button>
          </div>
          <p class="q-set__hint">
            代码输入框和展示的代码块都用这套配色，改完<b>立刻就变</b>（不用刷新）。
            默认「跟随站点」= 跟着上面的明暗主题走；后面几个是固定配色，
            选了之后不随明暗切换（<b>GitHub Light / Solarized Light</b> 是浅色的，
            白天或投屏更清楚）。
          </p>
        </div>

        <div class="q-set__row q-set__row--col">
          <span class="q-set__label">背景</span>
          <div class="q-seg">
            <button
              v-for="b in BACKGROUNDS"
              :key="b.value"
              class="q-seg__item"
              :class="{ 'is-active': quiz.settings.background === b.value }"
              @click="quiz.setSetting('background', b.value)"
            >
              <span>{{ b.label }}</span>
            </button>
          </div>
          <p class="q-set__hint">
            无最省电、看题最清楚；极光几乎不耗性能；星云 / 海浪 / 细胞这类最华丽但也最吃 GPU。<br />
            拿不到 WebGL 会自动退回极光；系统开了「<b>减少动态效果</b>」时，
            手写的几种会显示<b>静态定格</b>，而 Vanta 那几个（海浪/迷雾/云海/网格/细胞）
            会自动退回「极光·帘」—— 它们只有"一直动"这一种模式。
          </p>
          <p class="q-set__hint">
            底下五个（<b>海浪 / 迷雾 / 云海 / 网格 / 细胞</b>）是开源的 Vanta 3D 效果，
            首次选中时会下载约 750KB 的 three.js（之后走缓存）。
            <b>不选它们就一个字节都不下载</b> —— 不玩背景的人不用为它买单。
          </p>
        </div>

        <div v-if="quiz.settings.background !== 'none'" class="q-set__row">
          <span class="q-set__label">背景强度</span>
          <div class="q-set__ctrl">
            <el-slider
              :model-value="quiz.settings.backgroundIntensity"
              :min="0.1"
              :max="1"
              :step="0.05"
              @update:model-value="(v) => quiz.setSetting('backgroundIntensity', v)"
            />
            <span class="q-num q-dim">{{ Math.round(quiz.settings.backgroundIntensity * 100) }}%</span>
          </div>
        </div>

        <div class="q-set__row">
          <span class="q-set__label">网易云播放器</span>
          <div class="q-set__ctrl">
            <el-switch
              :model-value="quiz.settings.musicOn"
              @update:model-value="(v) => quiz.setSetting('musicOn', v)"
            />
          </div>
        </div>

        <template v-if="quiz.settings.musicOn">
          <div class="q-set__row">
            <span class="q-set__label">类型</span>
            <div class="q-seg">
              <button
                class="q-seg__item"
                :class="{ 'is-active': Number(quiz.settings.musicType) === 2 }"
                @click="quiz.setSetting('musicType', 2)"
              >
                <span>单曲</span>
              </button>
              <button
                class="q-seg__item"
                :class="{ 'is-active': Number(quiz.settings.musicType) === 0 }"
                @click="quiz.setSetting('musicType', 0)"
              >
                <span>歌单</span>
              </button>
            </div>
          </div>
          <div class="q-set__row">
            <span class="q-set__label">ID</span>
            <div class="q-set__ctrl">
              <el-input
                :model-value="quiz.settings.musicId"
                placeholder="如 186016"
                @update:model-value="(v) => quiz.setSetting('musicId', v)"
              />
            </div>
          </div>
          <div class="q-set__row">
            <span class="q-set__label">显示名</span>
            <div class="q-set__ctrl">
              <el-input
                :model-value="quiz.settings.musicNote"
                placeholder="可空，如 晴天"
                @update:model-value="(v) => quiz.setSetting('musicNote', v)"
              />
            </div>
          </div>
          <p class="q-set__hint">
            在网易云网页版打开歌曲（或歌单），地址栏里 <b>id=</b> 后面那串数字就是 ID。
            用的是官方外链播放器，播放键要你自己按 —— 不会自动出声。
            <br />
            下面是<b>降级路线</b>：只要「自己的音乐」里配了歌，就优先用那个完整播放器。
          </p>
        </template>

        <!-- ── 主播放器的曲库：自己的 mp3（配了就优先用它）── -->
        <div class="q-set__row">
          <span class="q-set__label">自己的音乐</span>
          <div class="q-set__ctrl">
            <span class="q-dim">
              {{ quiz.myMusic.tracks.length ? `已认到 ${quiz.myMusic.tracks.length} 首` : '未配置' }}
            </span>
          </div>
        </div>
        <el-input
          type="textarea"
          :rows="4"
          resize="vertical"
          :model-value="quiz.settings.musicList"
          placeholder="每行一首：&#10;https://example.com/a.mp3&#10;起个名字 | https://example.com/b.mp3&#10;起个名字 | https://example.com/c.mp3 | https://example.com/c.jpg | https://example.com/c.lrc"
          @update:model-value="(v) => quiz.setSetting('musicList', v)"
        />
        <p class="q-set__hint">
          填了这里，<b>右下角那个播放器面板</b>、<b>整页播放器（歌词）</b>和<b>成就页</b>都用完整播放器
          （封面 / 歌词 / 播放列表 / 系统媒体键，开源 APlayer，MIT）；
          留空才退回上面的网易云外链。
          <br />
          每行一首，<code>|</code> 分段，后两段可省：
          <b>名字 | 地址 | 封面 | 歌词</b>（封面和歌词都填图片/lrc 的网址）。
          地址只认 <b>http(s) 直链</b>（或本站内的 <code>./</code> 路径），<code>#</code> 开头的行当注释。
          <span v-if="quiz.myMusic.skipped.length" style="color: var(--q-warn)">
            有 {{ quiz.myMusic.skipped.length }} 行没认出来。
          </span>
        </p>

        <!--
          粘了**网页地址**（最常见的就是网易云歌曲页）时，必须当场说清楚 + 给一键修复。
          用户从网易云复制过来的就是 `music.163.com/song?id=…`，那玩意儿是 HTML 页面，
          当音频加载只会得到 APlayer 那句 `An audio error has occurred` —— 没人看得懂。
        -->
        <p v-if="quiz.myMusic.pages.length" class="q-set__hint" style="color: var(--q-warn)">
          有 {{ quiz.myMusic.pages.length }} 行是<b>网页地址</b>，不是音频文件（浏览器解不了，放不出声）：
          <code>{{ String(quiz.myMusic.pages[0].url).slice(0, 48) }}</code>
          <br />
          <template v-if="firstNetease">
            <el-button size="small" type="primary" plain @click="useNeteaseLink">
              用它填上面的 ID（{{ firstNetease.kind === 2 ? '单曲' : '歌单' }} {{ firstNetease.id }}）
            </el-button>
          </template>
          <template v-else>
            这种地址要先下成音频文件，或者换一个 mp3 直链。
          </template>
        </p>

        <div class="q-set__row">
          <span class="q-set__label">演示曲目</span>
          <div class="q-set__ctrl">
            <el-button size="small" text @click="fillDemo">
              填入内置演示音轨（20 秒，带歌词）
            </el-button>
          </div>
        </div>
        <div v-if="quiz.myMusic.tracks.length" class="q-set__row">
          <span class="q-set__label">音乐音量</span>
          <div class="q-set__ctrl">
            <el-slider
              :model-value="quiz.settings.musicVolume"
              :min="0"
              :max="1"
              :step="0.05"
              @update:model-value="(v) => player.setVolume(v)"
            />
            <span class="q-num q-dim">{{ Math.round(quiz.settings.musicVolume * 100) }}%</span>
          </div>
        </div>

        <div class="q-set__row">
          <span class="q-set__label">答题庆祝特效</span>
          <div class="q-set__ctrl">
            <el-switch
              :model-value="quiz.settings.celebrate"
              @update:model-value="(v) => quiz.setSetting('celebrate', v)"
            />
          </div>
        </div>
        <p class="q-set__hint">
          答对<b>以前做错的题</b>会爆彩花；连对达到 5 / 10 / 20 会有更盛大的效果。
          系统开了「减少动态效果」时自动不显示。
        </p>

        <div class="q-set__row">
          <span class="q-set__label">题干字号</span>
          <div class="q-set__ctrl">
            <el-slider
              :model-value="quiz.settings.stemSize"
              :min="15"
              :max="26"
              :step="1"
              size="small"
              style="width: 130px"
              @update:model-value="(v) => quiz.setSetting('stemSize', v)"
            />
            <span class="q-num q-dim">{{ quiz.settings.stemSize }}px</span>
          </div>
        </div>
      </section>

      <section class="q-set__sec">
        <h4 class="q-set__title">答题</h4>
        <div class="q-set__row">
          <div>
            <span class="q-set__label">背题模式</span>
            <p class="q-set__hint">进入每道题就直接显示答案，适合快速过一遍</p>
          </div>
          <el-switch
            :model-value="quiz.settings.revealFirst"
            @update:model-value="(v) => quiz.setSetting('revealFirst', v)"
          />
        </div>
        <div class="q-set__row">
          <div>
            <span class="q-set__label">答对自动下一题</span>
            <p class="q-set__hint">单选题答对后自动翻页，多选和答错时保持不动</p>
          </div>
          <el-switch
            :model-value="quiz.settings.autoNext"
            @update:model-value="(v) => quiz.setSetting('autoNext', v)"
          />
        </div>
        <div class="q-set__row" v-if="quiz.settings.autoNext">
          <span class="q-set__label">停留</span>
          <el-slider
            :model-value="quiz.settings.autoNextDelay"
            :min="300"
            :max="2000"
            :step="100"
            size="small"
            style="width: 130px"
            @update:model-value="(v) => quiz.setSetting('autoNextDelay', v)"
          />
        </div>
        <div class="q-set__row">
          <div>
            <span class="q-set__label">答对即移出错题本</span>
            <p class="q-set__hint">关闭后错题会一直留在错题本里</p>
          </div>
          <el-switch
            :model-value="quiz.settings.removeWrongOnCorrect"
            @update:model-value="(v) => quiz.setSetting('removeWrongOnCorrect', v)"
          />
        </div>
        <div class="q-set__row">
          <div>
            <span class="q-set__label">答题音效</span>
            <p class="q-set__hint">答对/答错/收藏/交卷都有提示音，纯 WebAudio 合成，不加载音频文件</p>
          </div>
          <el-switch
            :model-value="quiz.settings.sound"
            @update:model-value="(v) => quiz.setSetting('sound', v)"
          />
        </div>

        <template v-if="quiz.settings.sound">
          <div class="q-set__row">
            <span class="q-set__label">音量</span>
            <div class="q-set__ctrl">
              <el-slider
                :model-value="quiz.settings.soundVolume"
                :min="0"
                :max="1"
                :step="0.05"
                size="small"
                style="width: 130px"
                @update:model-value="(v) => quiz.setSetting('soundVolume', v)"
              />
              <span class="q-num q-dim">{{ Math.round(quiz.settings.soundVolume * 100) }}%</span>
            </div>
          </div>
          <div class="q-set__row q-set__row--col">
            <span class="q-set__label">试听</span>
            <div class="q-try">
              <button
                v-for="s in SOUND_TRIES"
                :key="s.name"
                class="q-try__btn"
                @click="previewSfx(s.name)"
              >
                <el-icon :size="13"><component :is="s.icon" /></el-icon>{{ s.label }}
              </button>
            </div>
            <p class="q-set__hint">
              浏览器要求先在页面上点一下才能出声，所以刚打开页面时的第一声可能会被吞掉；
              之后就一直正常了。<b>连对 3 题以上</b>会额外加一个音高递增的音。
            </p>
          </div>
        </template>

        <div class="q-set__row">
          <div>
            <span class="q-set__label">显示答题卡</span>
            <p class="q-set__hint">桌面端右侧的题号导航栏</p>
          </div>
          <el-switch
            :model-value="quiz.settings.showAnswerSheet"
            @update:model-value="(v) => quiz.setSetting('showAnswerSheet', v)"
          />
        </div>
      </section>

      <section class="q-set__sec">
        <h4 class="q-set__title">数据</h4>
        <p class="q-set__hint q-set__hint--block">
          进度、错题、收藏、笔记都只存在这台电脑的浏览器里（localStorage），不上传任何服务器。
          <template v-if="!storageWorks()">
            <br /><b style="color: var(--q-bad)">当前浏览器禁用了本地存储，进度无法保存。</b>
          </template>
        </p>
        <div class="q-set__actions">
          <el-button :disabled="!quiz.wrongCount" @click="clearWrong">清空错题本</el-button>
          <el-button :disabled="!quiz.noteCount" @click="clearNotes">
            清空笔记<span v-if="quiz.noteCount" class="q-num"> ({{ quiz.noteCount }})</span>
          </el-button>
          <el-button :disabled="!quiz.history.length" @click="clearLearningHistory">
            清空学习记录<span v-if="quiz.history.length" class="q-num"> ({{ quiz.history.length }})</span>
          </el-button>
          <el-button type="danger" plain @click="resetAll">重置本套题库进度</el-button>
        </div>
        <p class="q-set__hint q-set__hint--block">
          笔记、作答历史、AI 补的解析都是「记录」而不是「进度」，
          <b>「重置进度」不会动它们</b>，只能在上面对应的按钮里单独清。
        </p>
      </section>

      <section class="q-set__sec">
        <h4 class="q-set__title">快捷键</h4>
        <ul class="q-keys">
          <li><span class="q-kbd">A</span><span class="q-kbd">B</span><span class="q-kbd">C</span><span class="q-kbd">D</span><em>选择选项</em></li>
          <li><span class="q-kbd">1</span>~<span class="q-kbd">9</span><em>按序号选择</em></li>
          <li><span class="q-kbd">Enter</span><em>确认答案 / 下一题</em></li>
          <li><span class="q-kbd">←</span><span class="q-kbd">→</span><em>上一题 / 下一题</em></li>
          <li><span class="q-kbd">N</span><em>写笔记 / 编辑笔记</em></li>
          <li><span class="q-kbd">S</span><em>收藏本题</em></li>
          <li><span class="q-kbd">F</span><em>直接看答案</em></li>
          <li><span class="q-kbd">Esc</span><em>退出刷题</em></li>
        </ul>
        <p class="q-set__hint q-set__hint--block">
          在笔记编辑框里：<span class="q-kbd">Ctrl</span>+<span class="q-kbd">Enter</span> 保存，
          <span class="q-kbd">Esc</span> 取消。
        </p>
      </section>
    </div>
  </el-drawer>
</template>

<style scoped>
.q-set {
  display: flex;
  flex-direction: column;
  gap: 26px;
}
.q-set__sec {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.q-set__title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--q-text-3);
  padding-bottom: 8px;
  border-bottom: 1px solid var(--q-border);
}
.q-set__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}
.q-set__row--col {
  flex-direction: column;
  align-items: stretch;
  gap: 9px;
}
.q-set__label {
  font-size: 14px;
  font-weight: 600;
  color: var(--q-text);
}
.q-set__hint {
  margin-top: 3px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--q-text-3);
}
.q-set__hint--block {
  margin: 0;
}
.q-set__ctrl {
  display: flex;
  align-items: center;
  gap: 10px;
}
.q-set__actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

/* 三段式主题切换 */
.q-seg {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  padding: 5px;
  background: var(--q-surface-3);
  border-radius: var(--q-r-sm);
}
.q-seg__item {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 8px 4px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  font: 600 12.5px var(--q-font);
  color: var(--q-text-2);
  cursor: pointer;
  transition: all var(--q-dur) var(--q-ease);
}
.q-seg__item:hover {
  color: var(--q-text);
}
.q-seg__item.is-active {
  background: var(--q-surface);
  color: var(--q-brand-1);
  box-shadow: var(--q-shadow-sm);
}
html.dark .q-seg__item.is-active {
  color: #a5b0ff;
}

/* 试听按钮 */
.q-try {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.q-try__btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 7px 12px;
  border-radius: var(--q-r-full);
  border: 1px solid var(--q-border);
  background: var(--q-surface-2);
  font: 600 12.5px var(--q-font);
  color: var(--q-text-2);
  cursor: pointer;
  transition: all var(--q-dur) var(--q-ease);
}
.q-try__btn:hover {
  color: var(--q-brand-1);
  border-color: color-mix(in srgb, var(--q-brand-1) 45%, transparent);
  transform: translateY(-1px);
}
.q-try__btn:active {
  transform: translateY(0) scale(0.97);
}

.q-keys {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.q-keys li {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
}
.q-keys em {
  margin-left: 6px;
  font-style: normal;
  color: var(--q-text-2);
}
</style>
