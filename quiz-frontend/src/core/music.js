/**
 * music.js —— 音乐相关的**纯逻辑**（不碰 Vue / DOM / 网络）
 *
 * 为什么要单独抽出来：
 *   播放器有**两个界面**（右下角那颗常驻的小按钮 MusicPlayer.vue、
 *   刷完一轮后的成就页 AchievementPage.vue），但**只有一个音源**
 *   （stores/player.js 里的单例）。两边看到的歌词名、封面、进度必须是同一份数据，
 *   所以「播放列表怎么解析」「喂给系统媒体面板的信息怎么拼」「秒数怎么显示」
 *   这三件事都放在这里，组件和 store 都只是调用方。
 *   抽成纯函数还有个好处：`parseTracks` / `mediaInfo` / `gradeOf` / `formatClock`
 *   能在 Node 里逐条断言（见 tests/test_engine.mjs 的 G 段）。
 */

/**
 * 网易云官方外链播放器地址。
 *
 * 为什么用它而不是自己调 API：歌曲播放地址是加密 + 需要登录态的，
 * 第三方直连属于灰色地带且随时失效。官方 outchain 是给博客用的正规嵌入方式。
 * 代价是样式不可控 —— 只能在它外面套壳。
 *
 * @param {number} kind 2=单曲，0=歌单/专辑
 * @param {string} id   网易云地址栏里 id= 后面那串
 * @param {number} height iframe 高度（单曲官方最小 66，歌单要高得多）
 */
export function neteasePlayerSrc(kind, id, height) {
  const raw = String(id ?? '').trim()
  if (!raw) return ''
  const type = Number(kind ?? 2)
  return `https://music.163.com/outchain/player?type=${type}&id=${encodeURIComponent(raw)}&auto=0&height=${height}`
}

/** 官方外链播放器需要的高度：单曲只要一条，歌单/专辑要放列表 */
export function neteaseFrameHeight(kind) {
  return Number(kind ?? 2) === 2 ? 66 : 430
}

/** 在网易云网页版打开这首歌/这张歌单 */
export function neteasePageUrl(kind, id) {
  const type = Number(kind ?? 2) === 2 ? 'song' : 'playlist'
  return `https://music.163.com/#/${type}?id=${encodeURIComponent(String(id ?? '').trim())}`
}

/* ═══════════════════════ 地址分类：音频文件 / 网页 ═══════════════════════ */

/**
 * 已知的"这是**网页**、不是音频文件"的站点。
 *
 * 为什么要有这个：用户往「自己的音乐」里粘 `https://music.163.com/song?id=438456541`
 * 是最自然的事（他刚从网易云复制过来的），但这个地址返回的是 **HTML 页面**。
 * 上一版 `parseTracks` 只检查了"是不是 http(s)"就收下了，于是浏览器去解码一整页 HTML
 * → APlayer 弹一句 `An audio error has occurred`，用户完全看不懂发生了什么
 * （2026-10-08 用户截图报的就是这个）。
 *
 * 所以：**能认出来的网页地址必须在解析阶段就被识别出来**，并且要能一键转成正确的用法
 * （网易云的网页地址 = 用它的 id 走官方外链播放）。
 */
const PAGE_URL_RULES = [
  { re: /music\.163\.com|163cn\.tv/i, kind: 'netease' },
  { re: /y\.qq\.com/i, kind: 'qqmusic' },
  { re: /bilibili\.com|b23\.tv/i, kind: 'bilibili' },
  { re: /youtube\.com|youtu\.be/i, kind: 'youtube' },
  { re: /music\.apple\.com|spotify\.com/i, kind: 'streaming' },
]

/** 一眼就是音频文件的后缀。没有后缀也可能是音频（带签名的 CDN 地址常这样），所以只用来"加分" */
const AUDIO_EXT_RE = /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|webm|mp4|m3u8)(\?|#|$)/i

/**
 * 本站内的路径：`./demo/demo.wav` 或 `/demo/demo.wav`。
 *
 * 为什么**只认这两种前缀**、不认裸的 `a.mp3`：
 *   裸文件名会静默不播（相对于当前路由解析，hash 路由下还常常解析到错的地方），
 *   这是老代码里注释专门警告过的坑；而写 `./` 的人显然是有意指向站内文件
 *   （内置演示曲目就是这么写的）。
 */
const LOCAL_PATH_RE = /^(\.\/|\/)/

/** 能当音频源用的写法 */
function isAudioSource(text) {
  const s = String(text ?? '').trim()
  return /^https?:\/\//i.test(s) || LOCAL_PATH_RE.test(s)
}

/** 能当封面/歌词用的写法（相对路径也行，本站内的 .lrc 天然不受跨域限制） */
function isAssetSource(text) {
  return isAudioSource(text)
}

/**
 * @returns {'audio'|'page'}
 *   只在**能确定是网页**时才返回 'page'：宁可放过去让播放器报错（至少地址是用户自己给的），
 *   也不要把一个没后缀但确实是音频的 CDN 地址误杀。
 */
export function classifyUrl(url) {
  const text = String(url ?? '').trim()
  if (LOCAL_PATH_RE.test(text)) return 'audio' // 站内文件
  if (!/^https?:\/\//i.test(text)) return 'page'
  if (PAGE_URL_RULES.some((r) => r.re.test(text))) return 'page'
  return 'audio'
}

/**
 * 从网易云的各种网页地址里抠出 id。
 *
 * 认得的形态（都是用户实际会粘的）：
 *   https://music.163.com/song?id=438456541
 *   https://music.163.com/#/song?id=438456541
 *   https://music.163.com/m/song?id=438456541
 *   https://music.163.com/playlist?id=123456      → type 0
 *   https://music.163.com/#/my/m/music/playlist?id=123456
 *
 * @returns {{kind:number, id:string}|null}  kind 就是官方外链的 type（2=单曲，0=歌单）
 */
export function neteaseFromUrl(url) {
  const text = String(url ?? '').trim()
  if (!/music\.163\.com/i.test(text)) return null
  const m = text.match(/[?&#/](song|playlist|album|djradio|program)\?*[^0-9]*?id=(\d+)/i)
  const alt = text.match(/[?&]id=(\d+)/)
  const id = (m ? m[2] : alt ? alt[1] : '') || ''
  if (!id) return null
  const what = (m ? m[1] : 'song').toLowerCase()
  // album 也是 0（官方外链里专辑和歌单是同一个 type）
  return { kind: what === 'song' ? 2 : 0, id }
}

/**
 * 这个地址像不像"能直接播的音频"。
 * 给设置面板做即时提示用（粘进来就告诉他行不行，别等点了播放才发现）。
 */
export function looksLikeAudio(url) {
  const text = String(url ?? '').trim()
  if (!isAudioSource(text)) return false // 裸文件名不行：hash 路由下会解析到错的地方
  return classifyUrl(text) === 'audio'
}

/* ═══════════════════════════ 自己的播放列表 ═══════════════════════════ */

/**
 * 解析用户在设置里填的播放列表。一行一首，`|` 分段，后面两段可省：
 *
 *     https://example.com/a.mp3
 *     起个名字 | https://example.com/b.mp3
 *     起个名字 | https://example.com/c.mp3 | https://example.com/c.jpg | https://example.com/c.lrc
 *
 * 四段的含义依次是 **名字 | 地址 | 封面 | 歌词**（封面/歌词都填 URL）。
 * 只有前两段是必需品 —— 有了封面和歌词，播放器才有"正经播放器"的样子
 * （APlayer 会自己把封面画到唱片位、把 lrc 滚动起来）。
 *
 * 规则（都是"脏输入不能把页面搞崩"这一条推出来的）：
 *   · 空行、以 # 或 // 开头的整行 → 忽略（方便写注释）
 *   · 没有 `|` 时，整行就是地址，名字从**文件名**推（去掉扩展名、把 %20 还原成空格）
 *   · 有 `|` 时**第一段就是名字** —— 所以"只写地址和封面、不写名字"是不支持的写法：
 *     第一段是网址的行会被算作没认出来（宁可报错，也不要静默把封面图当音频放）
 *   · 名字里出现网址 → 同上（没有歌会叫 "https://..."）
 *   · 地址只认 http/https —— 相对路径在这里没有意义（音频是给 <audio> 用的，
 *     但写错成 `a.mp3` 会静默不播，不如直接丢掉并让 UI 提示数量对不上）
 *   · 封面/歌词不是 http(s) 时**只丢这两个字段**，歌本身留下（它们只是装饰，
 *     为一张写错的封面图丢掉整首歌不值得）
 *   · 同一地址只留第一条（重复粘两遍是常见手误）
 *
 * @returns {{tracks: Array<{name:string,url:string,cover?:string,lrc?:string}>,
 *            skipped: string[],
 *            pages: Array<{url:string, kind:string, netease?:{kind:number,id:string}}>}}
 *          skipped 是"看着像想加但没认出来"的行；pages 是**认出来的网页地址**
 *          （用户最常粘错的一类）——单独交出来，好在 UI 上一键转成正确用法
 */
export function parseTracks(text) {
  const tracks = []
  const skipped = []
  const pages = []
  const seen = new Set()

  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('//')) continue

    const parts = line.split('|').map((s) => s.trim())
    const named = parts.length > 1
    const namePart = named ? parts[0] : ''
    const urlPart = named ? parts[1] || '' : parts[0]

    // ★ 有 `|` 且**第一段本身就是个网址** → 用户八成是想"只写地址和封面"，
    //   把名字那段省了。这时第二段很可能是封面图（.jpg），照单全收会变成
    //   "标题是一个网址、内容是一张图片"的静默错误 —— 宁可判成没认出来，
    //   让 UI 提示他补个名字。
    if (named && /^https?:\/\//i.test(namePart)) {
      skipped.push(line)
      continue
    }
    if (!isAudioSource(urlPart)) {
      skipped.push(line)
      continue
    }
    if (seen.has(urlPart)) continue
    seen.add(urlPart)

    // ★ 认出"这是网页、不是音频"：**不要**塞进 tracks 让播放器去撞墙，
    //   而是单独交出来（见 classifyUrl 的注释：用户从网易云复制过来的就是这种）
    if (classifyUrl(urlPart) === 'page') {
      const nz = neteaseFromUrl(urlPart)
      pages.push({ url: urlPart, kind: nz ? 'netease' : 'page', ...(nz ? { netease: nz } : {}) })
      continue
    }

    const track = { name: namePart || nameFromUrl(urlPart), url: urlPart }
    // 封面 / 歌词：可选，且必须是正经地址，坏的就当没填
    if (isAssetSource(parts[2] || '')) track.cover = parts[2]
    if (isAssetSource(parts[3] || '')) track.lrc = parts[3]

    tracks.push(track)
  }
  return { tracks, skipped, pages }
}

/* ═══════════════════════ 系统媒体控制（媒体键 / 锁屏） ═══════════════════════ */

/**
 * 一首歌要喂给**系统媒体面板**的信息（`navigator.mediaSession.metadata`）。
 *
 * 抽成纯函数是为了能在 Node 里断言：这里拼错一个字段名，症状是
 * "耳机按键/锁屏上不显示歌名"，浏览器不会报任何错 —— 只能靠单测盯着。
 *
 * 刻意**不返回 MediaMetadata 实例**：那是个浏览器类，Node 里没有。
 * 构造放在 stores/player.js 里做。
 *
 * @returns {{title:string, artist:string, artwork?:Array<{src:string}>}}
 */
export function mediaInfo(track) {
  const title = String(track?.name ?? '').trim() || '未命名'
  const artist = String(track?.artist ?? '').trim() || '我的音乐'
  const info = { title, artist }
  const cover = String(track?.cover ?? '').trim()
  // 没封面就**不要**给 artwork —— 给个空数组会让系统面板显示一块灰方块
  if (cover) info.artwork = [{ src: cover }]
  return info
}

/**
 * 秒 → `1:05` / `1:01:01`。播放器进度条两侧的读数用它。
 *
 * 和 humanDuration 的分工：那个是「1 分 30 秒」给报告页看的；
 * 这个是「1:30」给播放器看 —— 播放器里必须是定宽的数字，不然每跳一秒
 * 整行都在抖。所以这里**不做单位换算**，只补零。
 */
export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/** 从地址里推一个像样的名字：取最后一段、去掉扩展名、解码百分号转义 */
export function nameFromUrl(url) {
  let tail = ''
  try {
    tail = new URL(url).pathname
  } catch {
    tail = String(url)
  }
  tail = tail.split('/').filter(Boolean).pop() || '未命名'
  try {
    tail = decodeURIComponent(tail)
  } catch {
    /* 转义坏了就用原样，别抛 */
  }
  return tail.replace(/\.[a-z0-9]{2,5}$/i, '') || '未命名'
}

/* ═══════════════════════════ 成就评价 ═══════════════════════════ */

/**
 * 一轮做完后的评价。
 *
 * level 决定彩花规模（1~3），所以它不能只看正确率 —— 只做 3 道题全对
 * 也不该放 132 颗彩花的"史诗级"庆祝（那会让真正的大胜利变得不值钱）。
 * 所以：**题目太少时把 level 压一级**。
 *
 * @returns {{level:number, title:string, note:string, emoji:string}}
 */
export function gradeOf({ accuracy = 0, graded = 0, total = 0 } = {}) {
  if (!graded) {
    return { level: 1, title: '这一轮没作答', note: '没关系，先看看解析，下一轮再来。', emoji: '🌱' }
  }

  let title = '需要再练'
  let note = '把错题过一遍，下一轮会明显不一样。'
  let emoji = '💪'
  if (accuracy >= 100) {
    title = '满分'
    note = '一道没错，这一轮可以收工了。'
    emoji = '🏆'
  } else if (accuracy >= 90) {
    title = '优秀'
    note = '只差一点点，错的那些多半是细节。'
    emoji = '🎉'
  } else if (accuracy >= 75) {
    title = '良好'
    note = '主干都拿下了，剩下的补一补就稳了。'
    emoji = '👏'
  } else if (accuracy >= 60) {
    title = '及格'
    note = '基础还在，重点是错题本里那几道。'
    emoji = '🙂'
  }

  let level = accuracy >= 90 ? 3 : accuracy >= 70 ? 2 : 1
  // 题量太少就别给最高档：3 道题全对不值得 132 颗彩花
  if (total < 5 && level > 1) level -= 1
  return { level, title, note, emoji }
}

/** 秒 → 「1 分 30 秒」/「45 秒」/「2 小时 5 分」。报告页和成就页共用同一套说法。 */
export function humanDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  const h = Math.floor(m / 60)
  return `${h} 小时 ${m % 60} 分`
}
