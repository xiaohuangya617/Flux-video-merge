const { spawn, execFile } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { FFMPEG, FFPROBE, getFreeSpace } = require('./ffmpeg')
const { TaskLog } = require('./logger')

// 画质映射
const QUALITY_MAP = {
  high: { crf: 18, preset: 'slow', audioBitrate: '192k' },
  medium: { crf: 23, preset: 'medium', audioBitrate: '128k' },
  low: { crf: 28, preset: 'fast', audioBitrate: '96k' },
}

// v1 支持的输出格式。webm 已排除（只接受 VP8/VP9/AV1 + Vorbis/Opus，与 H.264/AAC 策略冲突）
const OUTPUT_FORMATS = ['mp4', 'mkv', 'mov']

// 接缝裁齐相关
const TRIM_TOLERANCE = 0.005   // 音轨超出视频多少以内视为一致
// 裁齐时按"准确的视频时长"切，不减余量。
// 减余量（曾经用过 -0.05）虽然能让 ffmpeg 不打印告警，但 -t 作用于所有流，
// 会连带切掉跨越切点的那一帧视频 —— 实测每次裁齐丢 1 帧，得不偿失。
// 按准确时长切：视频一帧不丢，音轨只剩不到一个音频包的溢出（实测 17ms），
// ffmpeg 自行微调 1 个采样点，成品时间戳依然单调。
const TRIM_SAFETY = 0

// 产物校验阈值
// 音画时长差的来源：容器层面两条流的时长差 = 最后一个分段的音轨溢出（AAC 补零）
// + 拼接器对分段时间轴取整。实测健康文件 13~47ms。它**不是**同步漂移指标——
// 真正的漂移会同时表现为帧数缺失或时间戳异常，那些由别的断言独立把关。
// 所以这里取 100ms（约为健康值的 2 倍），既能放过正常的尾部误差，
// 又远小于人耳能察觉的音画脱节（一般 >150ms）。
const AV_SYNC_TOLERANCE = 0.1

/**
 * 接缝抽检里"已知无害"的输出，命中就不判失败。
 *
 * ⚠️ 「Application provided invalid, non monotonically increasing dts to muxer」
 * 是 **null muxer** 在抱怨"喂给它的解码帧时间戳没递增"，**不是文件的问题**。
 *
 * 判定依据（2026-09-16 用用户实际触发失败的产出逐个核实）：
 *   · 全片 47880 个包，PTS **零重复**；接缝区域 484 个包的 DTS **零回退、零重复**
 *   · 帧数 47880/47880 完全正确
 *   · 未拼接过的原始单文件全片解码干净；成品只在跨接缝时出现这一条
 *   · 报的数值 23990 换算回来正是接缝位置（991.65s），说明它源于接缝处
 *     两段之间 8.5ms 的"短帧"（一帧本该 41.3ms）——播放器会把前一段最后一帧
 *     少显示 33ms，属于**察觉不到的抖动**，远达不到"音画不同步/拖拽黑屏"的量级
 *
 * 真出现解码层面的错误（损坏、丢帧、无法解码）不会被这个过滤掉，照样判失败。
 */
const BENIGN_SEAM_MESSAGES = [
  /Application provided invalid, non monotonically increasing dts to muxer/,
]

// 单行是否属于"已知无害"（抽成函数便于单元测试钉死）
function isBenignSeamMessage(line) {
  return BENIGN_SEAM_MESSAGES.some((re) => re.test(String(line)))
}

/* =========================================================================
 * 参数分类
 *
 * 「必须转码」：差异落在比特流里（像素 / 时序 / 编码 / 色彩），-c copy 改不了。
 * 「可无损规整」：一次 -c copy 重封装就能修好，画面零损失。
 *
 * 这个划分是 2026-09-15 用真实反例实测出来的，不要凭直觉调整：
 *   - 流数量不同（多一条音轨）→ 只丢流仍有接缝丢帧风险，所以留给校验闸门升级
 *   - 起始时间不同 → -avoid_negative_ts make_zero 可无损归零，实测完全修好
 *   - VFR 伪装成 CFR → 帧时序改了比特流就变，只能转码
 * ========================================================================= */
const MUST_TRANSCODE = {
  videoCodec: '视频编码',
  width: '宽度',
  height: '高度',
  pixelFormat: '像素格式',
  rFrameRate: '标称帧率',
  avgFrameRate: '平均帧率',
  isCFR: '帧率模式',
  sampleAspectRatio: '像素宽高比',
  displayAspectRatio: '显示宽高比',
  colorRange: '色彩范围',
  colorSpace: '色彩空间',
  colorTransfer: '传输特性',
  colorPrimaries: '色彩原色',
  audioCodec: '音频编码',
  sampleRate: '采样率',
  channels: '声道数',
  channelLayout: '声道布局',
}

const REMUX_FIXABLE = {
  startTime: '起始时间',
  streamCount: '流数量',
  containerFormat: '容器格式',
  videoTimeBase: '视频时间基',
  videoTrackTimescale: '视频轨时间刻度',
  audioTimeBase: '音频时间基',
}

/* ============================ 小工具 ============================ */

function exec(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 128 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err) }
      resolve(stdout)
    })
  })
}

// 只要 stderr（接缝抽检用：`-v error` 下任何输出都算问题）
function execCapture(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 32 * 1024 * 1024 }, (err, _stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stderr: String(stderr || '') })
    })
  })
}

async function probeJson(filePath, extra = []) {
  const out = await exec(FFPROBE, [
    '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', ...extra, filePath,
  ])
  return JSON.parse(out)
}

// 解析帧率分数 "30/1" → 30.0
function fpsValue(fpsStr) {
  const [num, den] = String(fpsStr || '').split('/').map(Number)
  if (!den) return num || 30
  return num / den
}

// fps= 滤镜取值：分数原样透传，避免浮点误差
function fpsFilterValue(fpsStr) {
  const [num, den] = String(fpsStr || '').split('/').map(Number)
  if (num > 0 && den > 0) return `${num}/${den}`
  return String(fpsValue(fpsStr))
}

// 只保留 ffmpeg stderr 的尾部，避免长任务把内存吃光
const STDERR_KEEP = 16000

// 剩余时间估算的门槛
const ETA_MIN_ELAPSED = 5         // 至少跑满 5 秒才敢估算
const ETA_MIN_MEDIA_SEC = 2       // 且至少处理了 2 秒媒体
const ETA_MIN_MEDIA_RATIO = 0.02  // 或处理了总量的 2%

/**
 * 按「已处理媒体秒数 ÷ 真实秒数」推算剩余时间。
 *
 * **刻意不做百分比外推**：之前的算式是 elapsed×(100−p)/p，进度一被卡住
 * （见 parseLastFfmpegTime 的注释）就变成 elapsed×32，十几分钟的任务显示
 * "剩余十几小时"（2026-09-16 实测）。
 * 样本不足时返回 undefined —— 宁可不显示，也不给一个错的。
 */
function estimateRemaining({ mediaDone, mediaTotal, elapsedSec }) {
  if (!(mediaTotal > 0) || !(mediaDone > 0) || !(elapsedSec > 0)) return undefined
  if (elapsedSec < ETA_MIN_ELAPSED) return undefined
  if (mediaDone < Math.max(ETA_MIN_MEDIA_SEC, mediaTotal * ETA_MIN_MEDIA_RATIO)) return undefined
  if (mediaDone >= mediaTotal) return undefined
  const rate = mediaDone / elapsedSec        // 媒体秒 / 真实秒
  if (!(rate > 0)) return undefined
  const remain = (mediaTotal - mediaDone) / rate
  if (!Number.isFinite(remain)) return undefined
  // 后面还有规整 + 拼接 + 校验，粗估一个尾巴
  return Math.max(0, remain) + Math.max(5, elapsedSec * 0.15)
}

/**
 * 从 ffmpeg 的 stderr 里取**最后一个** time=，返回秒数。
 *
 * ⚠️ 必须取最后一个。stderr 是累加的，而 `text.match(/time=…/)` 不带 /g 时
 * **永远只返回第一个匹配** —— 表现就是进度条全程卡在开头。
 * 2026-09-16 实测：120 秒素材、preset slow，ffmpeg 一共输出 21 次 time=，
 * 取第一个 → 全程 3%；取最后一个 → 3/7/13/…/93/100 正常推进。
 */
function parseLastFfmpegTime(text) {
  const re = /time=(\d+):(\d+):(\d+\.\d+)/g
  let last = null
  let m
  while ((m = re.exec(text)) !== null) last = m
  if (!last) return null
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + parseFloat(last[3])
}

// SAR "1:1" → "1/1"（ffmpeg 的 setsar 用斜杠）
function sarValue(sar) {
  const m = String(sar || '').match(/^(\d+):(\d+)$/)
  if (!m) return ''
  if (m[1] === '0' || m[2] === '0') return ''
  return `${m[1]}/${m[2]}`
}

/**
 * 选一个能让「一帧 = 整数 tick」的容器时间刻度。
 *
 * 出自《视频转码对齐经验教训》教训 3：
 *   23.976(24000/1001) 配 timescale 90000 时，一帧 = 90000×1001/24000 = 3753.75 tick，
 *   时间戳只能取整 → avg_frame_rate 永远对不齐（实测会出现 2071980000/86418833 这种分数）。
 *   `fps=` + `fps_mode=cfr` 都消不掉这个数学事实，只能换时间刻度。
 *   23.976 的正确刻度是 24000（一帧 = 1001 tick，整除）。
 */
function pickTimescale(preferred, fpsStr) {
  const [num, den] = String(fpsStr || '').split('/').map(Number)
  const pref = Number(preferred) > 0 ? Number(preferred) : 90000
  if (!num || !den) return pref
  const fits = (T) => T > 0 && Number.isInteger(T * den / num)
  if (fits(pref)) return pref
  const gcd = (a, b) => (b ? gcd(b, a % b) : a)
  const base = num / gcd(num, den)      // 最小可用刻度的因子
  let T = base
  while (T < 1000) T += base
  return T
}

// ffprobe 的 h264 profile 名 → libx264 能接受的取值
const X264_PROFILE = {
  'Constrained Baseline': 'baseline',
  'Baseline': 'baseline',
  'Main': 'main',
  'High': 'high',
  'High 10': 'high10',
  'High 4:2:2': 'high422',
  'High 4:4:4 Predictive': 'high444',
}
function x264Profile(name) { return X264_PROFILE[String(name || '')] || '' }
// ffprobe 的 level 是整数（31 = 3.1），libx264 接受 "31" 这种写法
function x264Level(level) {
  const n = parseInt(level)
  return Number.isFinite(n) && n >= 1 && n <= 62 ? String(n) : ''
}

// 色彩范围 tv/pc → ffmpeg 的 limited/full
function rangeName(r) {
  if (r === 'tv' || r === 'limited') return 'limited'
  if (r === 'pc' || r === 'full' || r === 'jpeg') return 'full'
  return ''
}

// ffprobe 的色彩空间名 → colorspace 滤镜认识的名字
const COLORSPACE_SUPPORTED = new Set(['bt709', 'bt470m', 'bt470bg', 'smpte170m', 'smpte240m', 'film', 'bt2020'])
function colorName(v) {
  const s = String(v || '')
  if (s === 'bt2020nc' || s === 'bt2020c') return 'bt2020'
  return COLORSPACE_SUPPORTED.has(s) ? s : ''
}

// 音轨是否比视频长（拼接接缝会重叠）
function needsTailTrim(file) {
  if (!file.hasAudio) return false
  const v = file.videoDuration || 0
  const a = file.audioDuration || 0
  if (!v || !a) return false
  return a - v > TRIM_TOLERANCE
}

function alignHasAudio(target) {
  return !!String(target.audioCodec || '').trim()
}

// 单个文件相对基准的差异分类
function classifyFile(file, target) {
  const s = String
  const must = []
  const remux = []

  for (const [key, label] of Object.entries(MUST_TRANSCODE)) {
    // avgFrameRate 不做字符串级相等比较（见下方的可变帧率判断）
    if (key === 'avgFrameRate') continue
    if (s(file[key] ?? '') !== s(target[key] ?? '')) must.push(label)
  }

  // 可变帧率判断：
  // 《视频转码对齐经验教训》教训 3 说得很清楚 —— 在 23.976 + timescale 90000 下，
  // avg_frame_rate 在数学上就不可能字符串级对齐，所以**不能**拿它当"必须相等"的目标。
  // 它真正的用处是判断"这个文件是不是 VFR"（平均帧率明显偏离标称帧率）。
  const rfps = fpsValue(file.rFrameRate)
  const afps = fpsValue(file.avgFrameRate)
  if (rfps > 0 && afps > 0 && Math.abs(afps - rfps) / rfps > 0.02) {
    must.push('可变帧率')
  }

  for (const [key, label] of Object.entries(REMUX_FIXABLE)) {
    if (s(file[key] ?? '') !== s(target[key] ?? '')) remux.push(label)
  }

  // 音轨"有无"不一致：缺音轨可无损补静音轨（视频不重编码），多余音轨可无损丢弃
  const targetHasAudio = alignHasAudio(target)
  if (!!file.hasAudio !== targetHasAudio) {
    remux.push(targetHasAudio ? '缺音轨' : '多余音轨')
  }

  // 音轨尾部比视频长 → 拼接接缝处会音频重叠，必须裁齐（-c copy，画面零损失）
  if (needsTailTrim(file)) remux.push('音轨尾部溢出')

  // 首帧不是关键帧 → 无损拼接的接缝处会花屏，只能靠转码重建关键帧
  if (file.firstFrameIsKeyframe === false) must.push('首帧非关键帧')

  return { must, remux }
}

// 首帧是否为关键帧（只读第一个包，开销很小）
async function probeFirstFrameIsKeyframe(filePath) {
  try {
    const out = await exec(FFPROBE, [
      '-v', 'quiet', '-select_streams', 'v:0',
      '-show_entries', 'packet=flags', '-read_intervals', '%+#1',
      '-of', 'csv=p=0', filePath,
    ])
    const flags = String(out).trim().split('\n')[0] || ''
    return flags.includes('K')
  } catch {
    return true // 探测失败时不阻断，交给产物校验兜底
  }
}

// 统计视频包时间戳：回退次数 + 最大帧间隔
// 回退 = 接缝时间戳跳变；最大间隔 = 接缝处丢帧（相邻帧本该只隔 1/fps）
//
// ⚠️ 回退**必须按原始顺序**判断。曾经这里先 sort 再比较，排序后 arr[i] 永远不小于
// arr[i-1]，"时间戳单调"这条断言恒为真 —— 等于没校验。改动时务必保持原序比较。
async function inspectVideoTimeline(filePath, fps) {
  const out = await exec(FFPROBE, [
    '-v', 'quiet', '-select_streams', 'v:0',
    '-show_entries', 'packet=dts_time', '-of', 'csv=p=0', filePath,
  ])
  const raw = String(out).split('\n').filter(Boolean).map(Number)

  let back = 0
  for (let i = 1; i < raw.length; i++) if (raw[i] < raw[i - 1]) back++

  // 帧间隔看排序后的序列，避免 B 帧的解码顺序干扰
  const sorted = [...raw].sort((a, b) => a - b)
  let maxGap = 0
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1]
    if (gap > maxGap) maxGap = gap
  }
  const lastDts = sorted.length ? sorted[sorted.length - 1] : 0
  return { back, maxGap, total: raw.length, lastDts, frameInterval: fps > 0 ? 1 / fps : 0 }
}

/* ==================== 兼容旧接口 ==================== */

// 是否"完全一致、可直接拼"（不再用于决策，仅保留给外部调用/测试）
function isStrictMatch(file, target) {
  const { must, remux } = classifyFile(file, target)
  return must.length === 0 && remux.length === 0
}

/* ==================== 编排器 ==================== */

class MergeOrchestrator {
  constructor(task, onProgress, onComplete, onError, onOutputExists) {
    this.task = task
    this.onProgress = onProgress
    this.onComplete = onComplete
    this.onError = onError
    this.onOutputExists = onOutputExists
    this.cancelled = false
    this.currentProcess = null
    this.tempDir = path.join(os.tmpdir(), `video-merger-${task.id}`)
    this.outputExistsResolver = null
  }

  cancel() {
    this.cancelled = true
    if (this.currentProcess) {
      try { this.currentProcess.kill('SIGKILL') } catch { /* 可能已退出 */ }
      this.currentProcess = null
    }
    this.cleanupTemp()
  }

  resolveOutputExists(choice) {
    if (this.outputExistsResolver) {
      this.outputExistsResolver(choice)
      this.outputExistsResolver = null
    }
  }

  // 取消时必须回一次信：渲染进程是"等这个任务结束"的（队列尤其依赖），
  // 静默 return 会让它永远等下去。
  notifyCancelled() {
    if (this._cancelledNotified) return
    this._cancelledNotified = true
    try {
      this.onComplete({
        taskId: this.task.id, success: false, cancelled: true,
        transcodedFiles: [], totalFiles: this.task.files.length,
      })
    } catch { /* 忽略 */ }
  }

  /* ------------------------- 主流程 ------------------------- */

  async run() {
    const { task } = this
    this.log = new TaskLog(task)
    // 提到 try 外面：失败时要判断磁盘上那个产物是"完整但没通过校验"还是"根本没写完"
    let outputPath = null
    this.verificationFailed = false
    try {
      if (!OUTPUT_FORMATS.includes(task.outputFormat)) {
        throw new Error(`不支持的输出格式：${task.outputFormat}`)
      }

      console.log('[merge] run start, files:', task.files.length, 'outputDir:', task.outputDir)
      this.onProgress({ taskId: task.id, phase: 'checking', percent: 0, stepText: '检查就绪状态…' })

      // 统一容器时间刻度。
      // 《视频转码对齐经验教训》教训 3：23.976(24000/1001) 配 timescale 90000 时
      // 一帧 = 3753.75 tick（非整数），时间戳只能取整 → avg_frame_rate 永远对不齐。
      // 这里把基准刻度换成"能让一帧 = 整数 tick"的值，后面所有文件（含 direct 的）
      // 都用它，保证整批一致 —— 否则 direct 的文件跟规整过的文件刻度不同，拼接照样出问题。
      const rawTs = Number(task.alignConfig.videoTrackTimescale) || 0
      const effTs = pickTimescale(rawTs, task.alignConfig.rFrameRate)
      if (effTs !== rawTs) {
        console.log(`[merge] 时间刻度 ${rawTs} → ${effTs}（帧率 ${task.alignConfig.rFrameRate} 需要可整除的刻度，见经验教训 教训3）`)
        task.alignConfig.videoTrackTimescale = effTs
      }

      // 0. 就绪检查：源文件可读、输出目录存在且可写（DESIGN §10.3）
      //    早失败早报错，别等转码跑到一半才发现问题
      const missing = task.files.filter((f) => !fs.existsSync(f.filePath))
      if (missing.length) {
        throw new Error(`以下源文件不存在或不可访问：\n${missing.map((f) => f.filePath).join('\n')}`)
      }
      if (!fs.existsSync(task.outputDir)) {
        throw new Error(`输出目录不存在：${task.outputDir}`)
      }
      try {
        fs.accessSync(task.outputDir, fs.constants.W_OK)
      } catch {
        throw new Error(`输出目录不可写：${task.outputDir}`)
      }

      // 1. 输出文件冲突
      // 注意 outputPath 必须能在"生成新名称"分支里重算 —— 否则后面仍写回原路径，
      // 等于把用户明确要求避开的那个文件覆盖掉。
      // 文件名先净化，避免 "..\x" 这类写法把成品写到输出目录外面去。
      const safeName = String(task.outputName).replace(/[\\/:*?"<>|]/g, '_').trim() || 'merged_video'
      this.task.outputName = safeName
      outputPath = path.join(task.outputDir, `${safeName}.${task.outputFormat}`)
      if (fs.existsSync(outputPath)) {
        const choice = await new Promise((resolve) => {
          this.outputExistsResolver = resolve
          this.onOutputExists({ path: outputPath, taskId: task.id })
        })
        if (choice === 'cancel') {
          this.onComplete({
            taskId: task.id, success: false, cancelled: true,
            transcodedFiles: [], totalFiles: task.files.length,
          })
          return
        }
        if (choice === 'rename') {
          let n = 1
          let newPath
          do {
            newPath = path.join(task.outputDir, `${safeName}_${n}.${task.outputFormat}`)
            n++
          } while (fs.existsSync(newPath))
          this.task.outputName = path.basename(newPath, path.extname(newPath))
          outputPath = newPath
        }
      }

      // 2. 制定计划：每个文件走 direct / remux / transcode
      const plan = await this.buildPlan()
      const firstPath = this.worstPath(plan)
      console.log(`[merge] 首次尝试路径: ${firstPath}`)

      // 2.5 临时空间预算
      // 需要加工的文件会被**整份复制**到系统临时目录（remux/转码产物）。
      // 大批量 + 大文件时很容易撑爆 C 盘，而且会跑到一半才炸。
      // 提前算一笔账，不够就直接报错说清楚，别让用户等十分钟才看到失败。
      const toProcess = plan.filter((p) => p.action !== 'direct')
      const tempNeed = toProcess.reduce((s, p) => s + (p.file.fileSize || 0), 0)
      if (tempNeed > 0) {
        const tmpDir = os.tmpdir()
        const tmpFree = getFreeSpace(tmpDir)
        const gb = (n) => (n / 1073741824).toFixed(1)
        console.log(`[merge] 临时空间: 需要约 ${gb(tempNeed)} GB，${tmpDir} 可用 ${gb(tmpFree)} GB`)
        if (tmpFree > 0 && tmpFree < tempNeed * 1.1) {
          throw new Error(
            `系统临时目录空间不足：需要加工 ${toProcess.length} 个文件，`
            + `预计占用约 ${gb(tempNeed)} GB，当前可用仅 ${gb(tmpFree)} GB。\n`
            + `临时目录：${tmpDir}\n`
            + `请清理该磁盘空间后重试（临时文件合并完成后会自动删除）。`)
        }
      }

      // 3. 执行 + 校验；无损尝试未过则升级为转码重拼
      // 注意：无损规整本身也可能失败（比如源编码塞不进目标容器），
      // 那属于"这条路走不通"，同样应该升级到转码，而不是直接报错收工。
      let attempt
      try {
        attempt = await this.executeAttempt(plan, firstPath, outputPath)
      } catch (err) {
        console.warn('[merge] 首次尝试执行失败：', err.message)
        attempt = { ok: false, plan, path: firstPath, verifyNotes: [`执行失败：${err.message}`] }
      }
      if (this.cancelled) { this.notifyCancelled(); return }   // 用户已取消：不要再多跑一次转码
      let escalated = false

      if (!attempt.ok && firstPath !== 'transcode') {
        escalated = true
        console.warn('[merge] 首次尝试未通过，升级为转码重拼：')
        for (const n of attempt.verifyNotes) console.warn('  - ' + n)
        const strictPlan = plan.map((p) => ({
          ...p, action: 'transcode',
          reasons: { must: ['无损路径未通过'], remux: [] },
        }))
        attempt = await this.executeAttempt(strictPlan, 'transcode', outputPath)
        if (this.cancelled) { this.notifyCancelled(); return }
      }

      if (!attempt.ok) {
        // 注意：**校验没过时产物其实已经写在磁盘上了**（我们不删它）。
        // 措辞必须说清楚，否则用户会以为文件没生成 —— 实际上文件是好的、
        // 只是某条断言没过。同时附上日志路径，方便定位是哪条断言。
        this.verificationFailed = true
        const failed = attempt.verify?.failures || attempt.verifyNotes
        const logHint = this.log.file ? `\n\n详细日志：${this.log.file}` : ''
        throw new Error(
          `产物校验未通过${escalated ? '（无损尝试已升级转码后仍不过）' : ''}：\n`
          + failed.join('\n')
          + `\n\n文件已保留在：${outputPath}`
          + `\n（校验未通过不代表文件一定有问题，请自行播放确认）`
          + logHint)
      }

      // 4. 完成
      const stat = fs.statSync(outputPath)
      const usedPlan = attempt.plan
      this.log.section('产物校验')
      for (const n of attempt.verifyNotes) this.log.write('  ' + n)
      this.log.section('结果：成功')
      this.log.write(`  输出: ${outputPath}`)
      this.log.write(`  大小: ${stat.size} 字节`)
      this.log.write(`  路径: ${attempt.path}${escalated ? '（无损尝试未过，已升级转码）' : ''}`)
      this.onProgress({ taskId: task.id, phase: 'done', percent: 100, stepText: '完成' })
      this.onComplete({
        taskId: task.id,
        success: true,
        outputPath,
        outputSize: stat.size,
        outputDuration: attempt.verify.actualDuration,
        transcodedFiles: usedPlan.filter((p) => p.action === 'transcode').map((p) => p.file.fileName),
        normalizedFiles: usedPlan.filter((p) => p.action === 'remux').map((p) => p.file.fileName),
        totalFiles: task.files.length,
        mergePath: attempt.path,
        escalated,
        verified: true,
        verifyNotes: attempt.verifyNotes,
      })
    } catch (err) {
      this.cleanupTemp()
      if (this.cancelled) {
        this.log.section('结果：已取消')
        this.notifyCancelled()
      } else {
        console.error('[merge] failed:', err.message)
        this.log.section('结果：失败')
        this.log.write(err.message)
        if (err.stack) this.log.write(err.stack)

        // 两种"失败"要分开处理：
        //  · 校验未通过 → 文件是**完整的**，保留给用户自己确认（见上面的说明）
        //  · 执行失败（ffmpeg 中途退出）→ 文件**根本没写完**，必须删掉，
        //    否则用户会把它当成成品拿去用
        if (!this.verificationFailed && outputPath && fs.existsSync(outputPath)) {
          try {
            const size = fs.statSync(outputPath).size
            fs.rmSync(outputPath, { force: true })
            this.log.write(`产物未写完，已删除残缺文件（${size} 字节）：${outputPath}`)
            err.message += `\n\n（产物未写完，已自动删除残缺文件：${outputPath}）`
          } catch (e) {
            this.log.write(`残缺文件删除失败：${e.message}`)
            err.message += `\n\n（产物可能不完整，建议手动删除：${outputPath}）`
          }
        }

        this.onProgress({ taskId: task.id, phase: 'error', percent: 0, stepText: '失败' })
        this.onError({ message: err.message, taskId: task.id })
      }
    } finally {
      this.log.close()
    }
  }

  // 逐文件分类
  async buildPlan() {
    const { task } = this
    const plan = []
    for (let i = 0; i < task.files.length; i++) {
      const file = task.files[i]
      if (file.firstFrameIsKeyframe === undefined) {
        file.firstFrameIsKeyframe = await probeFirstFrameIsKeyframe(file.filePath)
      }
      const { must, remux } = classifyFile(file, task.alignConfig)
      const action = must.length ? 'transcode' : (remux.length ? 'remux' : 'direct')
      plan.push({ file, index: i, action, reasons: { must, remux } })
      const why = []
      if (must.length) why.push(`需转码(${must.join('/')})`)
      if (remux.length) why.push(`可无损规整(${remux.join('/')})`)
      console.log(`[merge] ${i} ${file.fileName}: ${action} ${why.join(' ')}`)
      this.log.write(`  [${i}] ${file.fileName} → ${action} ${why.join(' ')}`)
    }
    return plan
  }

  worstPath(plan) {
    if (plan.some((p) => p.action === 'transcode')) return 'transcode'
    if (plan.some((p) => p.action === 'remux')) return 'remux'
    return 'direct'
  }

  // 本次任务要写入的容器时间刻度。同一任务里所有文件必须用同一个值。
  // 不能直接用基准的 timescale —— 23.976 配 90000 会导致 avg_frame_rate 永远对不齐。
  effectiveTimescale() {
    const t = this.task.alignConfig
    return pickTimescale(t.videoTrackTimescale, t.rFrameRate)
  }

  /* -------------------- 一次完整尝试：加工 → 拼接 → 校验 -------------------- */

  async executeAttempt(plan, pathKind, outputPath) {
    this.cleanupTemp()
    fs.mkdirSync(this.tempDir, { recursive: true })

    const { task } = this
    const toTranscode = plan.filter((p) => p.action === 'transcode')
    const toNormalize = plan.filter((p) => p.action === 'remux')
    const filesToProcess = new Array(plan.length)

    const transcodeEnd = toTranscode.length ? 70 : 0
    const normalizeEnd = toNormalize.length ? (toTranscode.length ? 80 : 10) : transcodeEnd

    // ---- 剩余时间估算 ----
    // 只用「真实处理速率」做基准，**不做百分比外推**。
    // 之前用 elapsed×(100−p)/p，进度一被卡住就变成 elapsed×32，
    // 十几分钟的任务能显示"剩余十几小时"（2026-09-16 实测踩到）。
    // 现在：转码阶段按"已处理媒体秒数 ÷ 真实秒数"推算；规整/拼接阶段由各自字节速率给出。
    // **给不出可靠估算时就不给**（界面不显示），而不是给一个错的。
    const transcodeMediaTotal = toTranscode.reduce((s, p) => s + (p.file.duration || 0), 0)
    let tcMediaDone = 0
    let tcStartedAt = 0
    let smoothEta = null

    const emit = (phase, percent, stepText, currentFile, etaSec) => {
      let eta
      if (etaSec !== undefined) {
        eta = etaSec
      } else if (transcodeMediaTotal > 0 && tcMediaDone > 0 && tcStartedAt > 0) {
        eta = estimateRemaining({
          mediaDone: tcMediaDone,
          mediaTotal: transcodeMediaTotal,
          elapsedSec: (Date.now() - tcStartedAt) / 1000,
        })
      }
      if (eta !== undefined && Number.isFinite(eta) && eta >= 0) {
        smoothEta = smoothEta === null ? eta : smoothEta * 0.6 + eta * 0.4
        eta = Math.round(smoothEta)
      } else {
        smoothEta = null
        eta = undefined
      }
      this.onProgress({ taskId: task.id, phase, percent, currentFile, stepText, remainingSeconds: eta })
    }

    // 1) 转码（0 → 70）
    if (toTranscode.length) {
      const per = transcodeEnd / toTranscode.length
      let i = 0
      tcStartedAt = Date.now()
      for (const p of plan) {
        if (this.cancelled) return { ok: false, plan, path: pathKind, verifyNotes: ['已取消'] }
        if (p.action !== 'transcode') continue
        const tmp = path.join(this.tempDir, `${p.index}_aligned.${task.outputFormat}`)
        filesToProcess[p.index] = tmp
        const basePercent = i * per
        const stepText = `转码中… ${i + 1}/${toTranscode.length} — ${p.file.fileName}`
        const fileBase = tcMediaDone
        emit('transcoding', Math.round(basePercent), stepText, p.file.fileName)
        await this.transcode(p.file, tmp, task.alignConfig, task.quality, (pct) => {
          tcMediaDone = fileBase + (pct / 100) * (p.file.duration || 0)
          emit('transcoding', Math.round(basePercent + (pct / 100) * per), stepText, p.file.fileName)
        })
        tcMediaDone = fileBase + (p.file.duration || 0)
        // 转码后音轨仍可能比视频长（VFR 源经 fps 滤镜后视频会缩短），
        // 这会把音画偏差原样带进成品，所以再补一次无损裁齐
        await this.enforceSegmentAvSync(tmp)
        i++
      }
    }

    // 2) 无损规整（重封装，画面零损失）
    {
      const perNorm = toNormalize.length ? (normalizeEnd - transcodeEnd) / toNormalize.length : 0
      let ni = 0
      for (const p of plan) {
        if (this.cancelled) return { ok: false, plan, path: pathKind, verifyNotes: ['已取消'] }
        if (p.action !== 'remux') {
          if (p.action === 'direct') filesToProcess[p.index] = p.file.filePath
          continue
        }
        const tmp = path.join(this.tempDir, `${p.index}_norm.${task.outputFormat}`)
        const bandStart = transcodeEnd + ni * perNorm
        const stepText = `无损规整… ${p.file.fileName}（${p.reasons.remux.join('/')}）`
        await this.remuxNormalize(p.file, tmp, p, (pct, etaSec) => {
          emit('normalizing', Math.round(bandStart + (pct / 100) * perNorm), stepText, p.file.fileName, etaSec)
        })
        filesToProcess[p.index] = tmp
        ni++
      }
    }

    // 3) 拼接
    if (this.cancelled) return { ok: false, plan, path: pathKind, verifyNotes: ['已取消'] }
    const mergeBase = normalizeEnd
    const mergeRange = 95 - mergeBase
    // 拼接阶段已无可界定的"媒体进度"，改用输出大小推算剩余
    emit('merging', mergeBase, '拼接中…')

    const concatStats = await this.concat(filesToProcess, outputPath, (pct, etaSec) => {
      emit('merging', mergeBase + Math.round((pct / 100) * mergeRange), '拼接中…', undefined, etaSec)
    })

    // 4) 产物校验 —— 这是唯一的放行闸门
    emit('verifying', 96, '校验产物…')
    const verify = await this.verifyOutput(outputPath, plan, pathKind, concatStats.warnings)

    if (verify.ok) {
      this.onProgress({ taskId: task.id, phase: 'cleanup', percent: 98, stepText: '清理临时文件…' })
    }
    this.cleanupTemp()

    return { ok: verify.ok, plan, path: pathKind, verify, verifyNotes: verify.notes }
  }

  /* ------------------------- 无损规整 ------------------------- */

  // 只用 -c copy 重封装：归零时间轴、统一流布局、丢多余流、补静音轨、裁音轨尾部
  // onProgress：按"输出字节 / 输入字节"推算，让规整阶段进度条也能动
  remuxNormalize(file, outputPath, planItem, onProgress) {
    return new Promise((resolve, reject) => {
      const { task } = this
      const target = task.alignConfig
      const targetHasAudio = alignHasAudio(target)
      const isMp4Family = task.outputFormat === 'mp4' || task.outputFormat === 'mov'
      const sampleRate = target.sampleRate > 0 ? target.sampleRate : 48000
      const channels = target.channels > 0 ? target.channels : 2

      const args = ['-y', '-i', file.filePath]

      // 缺音轨但目标要有 → 补静音轨（视频仍是 copy，不重编码）
      if (!file.hasAudio && targetHasAudio) {
        args.push('-f', 'lavfi', '-i', `anullsrc=r=${sampleRate}:cl=${target.channelLayout || 'stereo'}`)
      }

      // 只保留一条视频 + 一条音轨，消除流布局差异
      args.push('-map', '0:v:0')
      if (targetHasAudio) args.push('-map', file.hasAudio ? '0:a:0' : '1:a:0')

      args.push('-c:v', 'copy')
      if (targetHasAudio) {
        if (file.hasAudio) {
          args.push('-c:a', 'copy')
        } else {
          args.push('-c:a', target.audioCodec || 'aac', '-ar', String(sampleRate), '-ac', String(channels))
        }
      } else {
        args.push('-an')
      }

      // 时间轴归零：起始时间不一致会累积成音画偏移
      args.push('-avoid_negative_ts', 'make_zero')

      // 统一容器时间刻度
      if (isMp4Family) {
        const ts = this.effectiveTimescale()
        if (ts > 0) args.push('-video_track_timescale', String(ts))
      }

      // 音轨尾部裁齐：音轨比视频长会在拼接接缝处重叠
      if (needsTailTrim(file)) {
        args.push('-t', Math.max(0.1, file.videoDuration - TRIM_SAFETY).toFixed(3))
      }
      if (isMp4Family) args.push('-movflags', '+faststart')
      if (!file.hasAudio && targetHasAudio) args.push('-shortest')
      args.push(outputPath)

      console.log('[merge] remuxNormalize:', path.basename(outputPath), '原因:', planItem.reasons.remux.join('/'))
      this.log.command(`规整 ${file.fileName}`, FFMPEG, args)
      const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      this.currentProcess = proc

      let inputSize = 0
      try { inputSize = fs.statSync(file.filePath).size } catch { /* 忽略 */ }
      let lastPct = 0
      const startedAt = Date.now()
      const timer = onProgress ? setInterval(() => {
        try {
          const outSize = fs.statSync(outputPath).size
          const pct = inputSize > 0 ? Math.min(95, (outSize / inputSize) * 100) : 50
          if (pct > lastPct) {
            lastPct = pct
            // 按已写字节速率外推剩余（规整是 -c copy，没有 time= 可读）
            let eta
            const elapsedMs = Date.now() - startedAt
            if (elapsedMs > 1500 && outSize > 0 && inputSize > outSize) {
              eta = Math.max(0, Math.round((inputSize - outSize) / (outSize / elapsedMs) / 1000))
            }
            onProgress(pct, eta)
          }
        } catch { /* 输出文件尚未创建 */ }
      }, 400) : null

      let stderr = ''
      proc.stderr.on('data', (d) => { stderr += d.toString() })
      proc.on('close', (code) => {
        if (timer) clearInterval(timer)
        this.currentProcess = null
        if (this.cancelled) return reject(new Error('已取消'))
        if (code !== 0) {
          this.log.stderr(`规整 ${file.fileName}`, stderr)
          return reject(new Error(`无损规整 ${file.fileName} 失败 (exit ${code}):\n${stderr.slice(-500)}`))
        }
        if (onProgress) onProgress(100)
        resolve()
      })
      proc.on('error', (err) => {
        if (timer) clearInterval(timer)
        this.currentProcess = null
        reject(new Error(`启动 ffmpeg 失败: ${err.message}`))
      })
    })
  }

  // 保证单个分段文件的音轨不长于视频轨。
  // 分段内部的音画差会原样传到成品上，实测 VFR 源转码后视频会缩短最多几十毫秒。
  async enforceSegmentAvSync(filePath) {
    try {
      const info = await probeJson(filePath)
      const v = (info.streams || []).find((s) => s.codec_type === 'video')
      const a = (info.streams || []).find((s) => s.codec_type === 'audio')
      if (!v || !a) return false
      const vd = Number(v.duration) || 0
      const ad = Number(a.duration) || 0
      if (vd <= 0 || ad - vd <= TRIM_TOLERANCE) return false

      console.log(`[merge] 分段音画不齐（视频 ${vd.toFixed(3)}s / 音频 ${ad.toFixed(3)}s），无损裁齐`)
      const tmp = `${filePath}.sync.${this.task.outputFormat}`
      await this.remuxTrimTo(filePath, tmp, vd - TRIM_SAFETY)
      fs.rmSync(filePath, { force: true })
      fs.renameSync(tmp, filePath)
      return true
    } catch (err) {
      console.warn('[merge] 分段音画裁齐失败，交给产物校验判定：', err.message)
      return false
    }
  }

  // 纯 -c copy 裁剪
  remuxTrimTo(src, dst, duration) {
    return new Promise((resolve, reject) => {
      const isMp4Family = this.task.outputFormat === 'mp4' || this.task.outputFormat === 'mov'
      const args = ['-y', '-i', src, '-map', '0', '-c', 'copy', '-t', Math.max(0.1, duration).toFixed(3)]
      if (isMp4Family) args.push('-movflags', '+faststart')
      args.push(dst)
      this.log.command('裁齐', FFMPEG, args)
      const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      this.currentProcess = proc
      let stderr = ''
      proc.stderr.on('data', (d) => { stderr += d.toString() })
      proc.on('close', (code) => {
        this.currentProcess = null
        if (this.cancelled) return reject(new Error('已取消'))
        if (code !== 0) return reject(new Error(`裁齐失败 (exit ${code}): ${stderr.slice(-300)}`))
        resolve()
      })
      proc.on('error', (err) => { this.currentProcess = null; reject(err) })
    })
  }

  /* ------------------------- 转码 ------------------------- */
  // 视频滤镜链：真实色彩转换 → lanczos 缩放补边 → 采样宽高比 → 帧率
  buildVideoFilter(file, target) {
    const parts = []

    // 色彩参数不一致时做真正的转换。只改标记不转换 = 谎报，
    // 播放器会按错的标准解读像素，画面发灰或发艳。
    const srcSpace = colorName(file.colorSpace) || colorName(file.colorPrimaries)
    const dstSpace = colorName(target.colorSpace) || colorName(target.colorPrimaries)
    const needColorConvert = srcSpace && dstSpace && (
      (file.colorSpace && target.colorSpace && file.colorSpace !== target.colorSpace)
      || (file.colorPrimaries && target.colorPrimaries && file.colorPrimaries !== target.colorPrimaries)
    )
    if (needColorConvert) parts.push(`colorspace=iall=${srcSpace}:all=${dstSpace}`)

    let scale = `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease:flags=lanczos`
    const srcRange = rangeName(file.colorRange)
    const dstRange = rangeName(target.colorRange)
    if (srcRange && dstRange && srcRange !== dstRange) {
      scale += `:in_range=${srcRange}:out_range=${dstRange}`
    }
    parts.push(scale)
    parts.push(`pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2`)

    const sar = sarValue(target.sampleAspectRatio)
    // 用显式写法 setsar=sar=X/Y：《视频转码对齐经验教训》教训 9 记录过
    // `setsar=113:160` 出现"转码完成但 SAR 没写进目标"的情况
    if (sar) parts.push(`setsar=sar=${sar}`)

    parts.push(`fps=${fpsFilterValue(target.rFrameRate)}`)
    return parts.join(',')
  }

  transcode(file, outputPath, target, quality, onFileProgress) {
    return new Promise((resolve, reject) => {
      const q = QUALITY_MAP[quality] || QUALITY_MAP.high
      const isMp4Family = this.task.outputFormat === 'mp4' || this.task.outputFormat === 'mov'
      const sampleRate = target.sampleRate > 0 ? target.sampleRate : 48000
      const channels = target.channels > 0 ? target.channels : 2

      const args = ['-y', '-i', file.filePath]
      if (!file.hasAudio) {
        args.push('-f', 'lavfi', '-i', `anullsrc=r=${sampleRate}:cl=${target.channelLayout || 'stereo'}`)
      }

      args.push(
        '-vf', this.buildVideoFilter(file, target),
        '-c:v', 'libx264',
        '-preset', q.preset,
        '-crf', String(q.crf),
        '-pix_fmt', target.pixelFormat || 'yuv420p',
      )

      // profile / level 是《视频参数合并标准》V10 / V11 明确要求一致的字段。
      // libx264 默认会按内容自己选（通常是 High），不显式指定的话
      // 转码产物的 profile 会和基准对不上 —— 等于没对齐。
      const prof = x264Profile(target.videoProfile)
      if (prof) args.push('-profile:v', prof)
      const lvl = x264Level(target.videoLevel)
      if (lvl) args.push('-level:v', lvl)

      args.push(
        '-c:a', target.audioCodec || 'aac',
        '-b:a', q.audioBitrate,
        '-ar', String(sampleRate),
        '-ac', String(channels),
      )
      // 音轨长度必须和视频轨对齐：apad 把音轨补成无限长，再由 -shortest 在视频轨结束时收尾。
      // 不这么做的话，源文件里"音轨比视频长"的偏差会被原样带进成品 → 音画不同步。
      if (file.hasAudio) args.push('-af', 'apad')
      args.push('-shortest')

      // 色彩标记：转换之后写就是诚实的
      if (target.colorRange) args.push('-color_range', target.colorRange)
      if (target.colorSpace) args.push('-colorspace', target.colorSpace)
      if (target.colorPrimaries) args.push('-color_primaries', target.colorPrimaries)
      if (target.colorTransfer) args.push('-color_trc', target.colorTransfer)

      if (isMp4Family) {
        args.push('-video_track_timescale', String(target.videoTrackTimescale || 90000))
        args.push('-movflags', '+faststart')
      }
      args.push(outputPath)

      this.log.command(`转码 ${file.fileName}`, FFMPEG, args)
      const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      this.currentProcess = proc

      let stderr = ''
      let timeTail = ''
      const totalDuration = file.duration || 1
      proc.stderr.on('data', (data) => {
        const s = data.toString()
        stderr = (stderr + s).slice(-STDERR_KEEP)      // 只留尾部，别让长任务吃光内存
        timeTail = (timeTail + s).slice(-4096)
        const t = parseLastFfmpegTime(timeTail)        // 取最后一个，不是第一个
        if (t !== null) onFileProgress(Math.min(100, (t / totalDuration) * 100))
      })
      proc.on('close', (code) => {
        this.currentProcess = null
        if (this.cancelled) return reject(new Error('已取消'))
        if (code !== 0) {
          this.log.stderr(`转码 ${file.fileName}`, stderr)
          return reject(new Error(`转码 ${file.fileName} 失败 (exit ${code}):\n${stderr.slice(-600)}`))
        }
        resolve()
      })
      proc.on('error', (err) => {
        this.currentProcess = null
        reject(new Error(`启动 ffmpeg 失败: ${err.message}`))
      })
    })
  }

  /* ------------------------- 拼接 ------------------------- */

  concat(filePaths, outputPath, onProgress) {
    return new Promise((resolve, reject) => {
      const missing = filePaths.findIndex((p) => !p || !fs.existsSync(p))
      if (missing >= 0) return reject(new Error(`第 ${missing + 1} 个待拼接文件不存在`))

      const listPath = path.join(this.tempDir, 'list.txt')
      // 文件名里可能出现单引号：concat 列表格式要求写成 '\'' ，
      // 否则整行解析会错位，ffmpeg 会报找不到文件或读到错误的段
      const esc = (p) => p.replace(/\\/g, '/').replace(/'/g, "'\\''")
      fs.writeFileSync(listPath, filePaths.map((p) => `file '${esc(p)}'`).join('\n'), 'utf8')

      let totalInputSize = 0
      for (const p of filePaths) {
        try { totalInputSize += fs.statSync(p).size } catch { /* 忽略 */ }
      }

      const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy']
      if (this.task.outputFormat === 'mp4' || this.task.outputFormat === 'mov') {
        args.push('-movflags', '+faststart')
      }
      args.push(outputPath)

      this.log.command('拼接', FFMPEG, args)
      const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      this.currentProcess = proc

      let stderr = ''
      let lastProgress = 0
      const progressStart = Date.now()
      const progressTimer = setInterval(() => {
        try {
          const outSize = fs.statSync(outputPath).size
          const pct = totalInputSize > 0 ? Math.min(95, (outSize / totalInputSize) * 100) : 50
          if (pct > lastProgress) {
            lastProgress = pct
            // 按已写字节的速度外推剩余时间（拼接阶段没有 time= 可读）
            let etaSec
            const elapsedMs = Date.now() - progressStart
            if (elapsedMs > 1500 && outSize > 0 && totalInputSize > outSize) {
              const bytesPerMs = outSize / elapsedMs
              etaSec = Math.max(0, Math.round((totalInputSize - outSize) / bytesPerMs / 1000))
            }
            if (onProgress) onProgress(pct, etaSec)
          }
        } catch { /* 输出文件尚未创建 */ }
      }, 500)

      proc.stderr.on('data', (data) => { stderr += data.toString() })

      proc.on('close', (code) => {
        clearInterval(progressTimer)
        this.currentProcess = null
        if (this.cancelled) return reject(new Error('已取消'))
        if (code !== 0) {
          this.log.stderr('拼接', stderr)
          return reject(new Error(`拼接失败 (exit ${code}):\n${stderr.slice(-600)}`))
        }
        const warnings = (stderr.match(/Non-monotonic DTS/g) || []).length
        if (onProgress) onProgress(100)
        resolve({ warnings })
      })
      proc.on('error', (err) => {
        clearInterval(progressTimer)
        this.currentProcess = null
        reject(new Error(`启动 ffmpeg 失败: ${err.message}`))
      })
    })
  }

  /* ------------------------- 产物校验（放行闸门） ------------------------- */

  async verifyOutput(outputPath, plan, pathKind, concatWarnings) {
    const target = this.task.alignConfig
    const targetHasAudio = alignHasAudio(target)
    const notes = []
    // 失败项单独存一份：错误提示里只该出现"没过的那几条"。
    // 之前用「不以 ✓ 结尾」来筛选，把 "帧数 47880/47880 ✓（容差 2）"
    // 这种其实是通过的条目也当成失败显示了，容易误导。
    const failures = []
    let ok = true
    const fail = (m) => { ok = false; failures.push(m); notes.push(m) }

    const info = await probeJson(outputPath)
    const streams = info.streams || []
    const videos = streams.filter((s) => s.codec_type === 'video')
    const audios = streams.filter((s) => s.codec_type === 'audio')
    const v = videos[0]
    const a = audios[0]

    if (!v) {
      return { ok: false, notes: ['产物里没有视频流'], failures: ['产物里没有视频流'], actualDuration: 0 }
    }

    // 断言 1：流布局
    if (videos.length !== 1) fail(`视频流数量 ${videos.length}（应为 1）`)
    if (targetHasAudio && audios.length !== 1) fail(`音频流数量 ${audios.length}（应为 1）`)
    if (!targetHasAudio && audios.length !== 0) fail(`出现了多余的音频流（${audios.length} 条）`)
    if (videos.length && audios.length) {
      const vi = streams.findIndex((s) => s.codec_type === 'video')
      const ai = streams.findIndex((s) => s.codec_type === 'audio')
      if (vi > ai) fail('视频流排在音频流之后，播放器可能错位')
    }

    // 先把时间轴扫出来：mkv 等容器不写流时长，后面的帧数与音画差都要靠它兜底
    const fps = fpsValue(target.rFrameRate)
    const tl = await inspectVideoTimeline(outputPath, fps)

    // 断言 2：帧数
    const actualFramesRaw = parseInt(v.nb_frames)
    // 回退顺序：nb_frames → 流时长 → 容器时长 → 包时间轴末尾
    // （mkv 前两者都没有，不兜底就会算成 0 帧，把好好的成品判成失败）
    const outSpan = Number(v.duration) || Number(info.format && info.format.duration) || 0
    const actualFrames = actualFramesRaw
      || Math.round(outSpan * fps)
      || (tl.lastDts > 0 ? Math.round((tl.lastDts + tl.frameInterval) * fps) : 0)
    let expectedFrames = 0
    for (const p of plan) {
      if (p.action === 'transcode') expectedFrames += Math.round((p.file.videoDuration || 0) * fps)
      else expectedFrames += (p.file.frameCount || Math.round((p.file.videoDuration || 0) * fps))
    }
    // 容差来源：
    //  · 经过加工的文件（规整/转码）每个容许 1 帧（接缝按设计裁切/重新计时）
    //  · 帧数是估算的（容器不写 nb_frames，如 mkv）再各容许 1 帧
    const tol = plan.filter((p) => p.action !== 'direct').length
      + plan.filter((p) => p.file.frameCountEstimated).length
      + (actualFramesRaw ? 0 : 1)
    if (actualFrames <= 0) {
      fail('无法测定产物帧数（容器未提供任何时长信息）')
    } else if (Math.abs(actualFrames - expectedFrames) > tol) {
      fail(`视频帧数 ${actualFrames}，预期 ${expectedFrames}（容差 ${tol}）`)
    } else {
      const mark = tol > 0 ? `（容差 ${tol}）` : ''
      notes.push(`帧数 ${actualFrames}/${expectedFrames} ✓${mark}`)
    }

    // 断言 3：恒定帧率未被破坏（目标本身是 CFR 时才断言）
    // 注意：不能拿 avg_frame_rate 和 r_frame_rate 做严格相等 —— 容器时长含音轨尾部，
    // 平均帧率会算成 29.966 这种值（实测），那是正常的。只有相对偏离超过 2% 才算 VFR。
    if (target.isCFR) {
      const targetFps = fpsValue(target.rFrameRate)
      const rFps = fpsValue(v.r_frame_rate)
      const aFps = fpsValue(v.avg_frame_rate)
      if (Math.abs(rFps - targetFps) > 0.001) {
        fail(`输出标称帧率 ${v.r_frame_rate} ≠ 目标 ${target.rFrameRate}`)
      } else if (rFps > 0 && Math.abs(aFps - rFps) / rFps > 0.02) {
        fail(`输出帧率不恒定：平均 ${v.avg_frame_rate} 偏离标称 ${v.r_frame_rate} 超过 2%`)
      } else {
        notes.push(`帧率恒定 ${v.r_frame_rate} ✓`)
      }
    }

    // 断言 4：输出参数回读
    // 《视频转码对齐经验教训》教训 10：「转码成功」≠「指纹一致」——
    // ffmpeg 返回 0 只说明命令跑完，必须用验收同一套字段回读核对。
    // 教训 1 更明确：time_base 才是最大的坑，验收必须包含它。
    {
      const isMp4Family = this.task.outputFormat === 'mp4' || this.task.outputFormat === 'mov'
      const effTs = this.effectiveTimescale()

      // 4.1 视频时间基 / 容器时间刻度（最大的坑）
      if (isMp4Family && effTs > 0) {
        const wantTb = `1/${effTs}`
        if (String(v.time_base || '') !== wantTb) {
          fail(`输出视频时间基 ${v.time_base} ≠ 期望 ${wantTb}`)
        } else {
          notes.push(`视频时间基 ${wantTb} ✓`)
        }
      }

      // 4.2 帧率分数必须逐字符一致（30/1 ≠ 30000/1001）
      if (target.rFrameRate && String(v.r_frame_rate || '') !== String(target.rFrameRate)) {
        fail(`输出标称帧率 ${v.r_frame_rate} ≠ 目标 ${target.rFrameRate}`)
      }

      // 4.3 像素格式 / 像素宽高比 / 视频编码 / profile / level
      if (target.pixelFormat && v.pix_fmt !== target.pixelFormat) {
        fail(`输出像素格式 ${v.pix_fmt} ≠ 目标 ${target.pixelFormat}`)
      }
      const wantSar = String(target.sampleAspectRatio || '')
      if (wantSar && wantSar !== '0:1' && String(v.sample_aspect_ratio || '') !== wantSar) {
        // 教训 9：SAR 曾出现"转码完成但没写进去"，所以必须回读
        fail(`输出像素宽高比 ${v.sample_aspect_ratio} ≠ 目标 ${wantSar}`)
      }
      if (target.videoCodec && v.codec_name !== target.videoCodec) {
        fail(`输出视频编码 ${v.codec_name} ≠ 目标 ${target.videoCodec}`)
      }
      if (target.videoProfile && v.profile && v.profile !== target.videoProfile) {
        fail(`输出编码档次 ${v.profile} ≠ 目标 ${target.videoProfile}`)
      }
      if (target.videoLevel && v.level && String(v.level) !== String(target.videoLevel)) {
        fail(`输出编码级别 ${v.level} ≠ 目标 ${target.videoLevel}`)
      }

      // 4.4 音频参数
      if (targetHasAudio && a) {
        if (target.audioCodec && a.codec_name !== target.audioCodec) {
          fail(`输出音频编码 ${a.codec_name} ≠ 目标 ${target.audioCodec}`)
        }
        if (target.sampleRate && Number(a.sample_rate) !== Number(target.sampleRate)) {
          fail(`输出采样率 ${a.sample_rate} ≠ 目标 ${target.sampleRate}`)
        }
        if (target.channels && Number(a.channels) !== Number(target.channels)) {
          fail(`输出声道数 ${a.channels} ≠ 目标 ${target.channels}`)
        }
        if (target.channelLayout && a.channel_layout && String(a.channel_layout) !== String(target.channelLayout)) {
          fail(`输出声道布局 ${a.channel_layout} ≠ 目标 ${target.channelLayout}`)
        }
      }

      // 4.5 色彩参数（只在目标有明确取值时要求）
      for (const [key, field] of [['colorRange', 'color_range'], ['colorSpace', 'color_space'],
        ['colorTransfer', 'color_transfer'], ['colorPrimaries', 'color_primaries']]) {
        const want = String(target[key] || '')
        if (want && v[field] && String(v[field]) !== want) {
          fail(`输出${key} ${v[field]} ≠ 目标 ${want}`)
        }
      }

      if (ok) notes.push('输出参数回读一致 ✓')
    }

    // 断言 5：音画时长差（音画不同步的直接指标）
    let actualDuration = Number(info.format && info.format.duration) || 0
    if (targetHasAudio && a) {
      // mkv 不写流时长 → 用「视频包时间轴末尾」和「容器时长」做代理，
      // 否则两边都是 0，这条断言会变成永远通过的摆设
      const vSpan = Number(v.duration) || (tl.lastDts > 0 ? tl.lastDts + tl.frameInterval : 0)
      const aSpan = Number(a.duration) || actualDuration
      if (vSpan > 0 && aSpan > 0) {
        const d = Math.abs(aSpan - vSpan)
        if (d > AV_SYNC_TOLERANCE) {
          fail(`音画时长差 ${(d * 1000).toFixed(0)}ms 超过 ${AV_SYNC_TOLERANCE * 1000}ms`)
        } else {
          notes.push(`音画时长差 ${(d * 1000).toFixed(0)}ms ✓`)
        }
      } else {
        notes.push('音画时长差：容器未提供时长信息，无法测定')
      }
    }

    // 断言 6：输出时间戳单调 + 无异常帧间隔（拖拽黑屏 / 接缝丢帧的直接指标）
    // 时间轴在上面已经扫过（tl），这里直接复用
    if (tl.back > 0) fail(`输出时间戳有 ${tl.back} 处回退（共 ${tl.total} 包）`)
    else notes.push('时间戳单调 ✓')
    if (tl.frameInterval > 0 && tl.maxGap > tl.frameInterval * 3) {
      fail(`检测到异常帧间隔 ${(tl.maxGap * 1000).toFixed(0)}ms（正常 ${(tl.frameInterval * 1000).toFixed(0)}ms）—— 接缝处可能丢帧`)
    }

    // 断言 7（提示级）：拼接过程中的接缝告警。
    // ffmpeg 会自动微调（实测偏差不到 1 个采样点），而"输出时间戳是否单调"
    // 已由断言 5 独立验证，所以这里只记录，不作为拒绝交付的理由。
    if (concatWarnings > 0) notes.push(`接缝告警 ${concatWarnings} 处（已自动微调，输出时间戳单调）`)
    else notes.push('无接缝告警 ✓')

    // 断言 8：无损路径下每段的首帧必须是关键帧
    if (pathKind !== 'transcode') {
      const bad = plan.filter((p) => p.file.firstFrameIsKeyframe === false)
      if (bad.length) fail(`有 ${bad.length} 个文件首帧不是关键帧：${bad.map((p) => p.file.fileName).join('、')}`)
    }

    // 断言 9：接缝抽检
    // 《视频参数合并标准》§6.3 的验收方式：对每个接缝前后各 5 秒做一次真实解码。
    // 这比只看包时间戳更接近"用户拖进度条"的真实场景 —— 能抓到解码器层面的问题。
    if (plan.length > 1) {
      const seamProblems = await this.probeSeams(outputPath, plan, notes)
      if (seamProblems.length) for (const p of seamProblems) fail(p)
      else notes.push(`接缝抽检 ${plan.length - 1} 处通过 ✓`)
    }

    return { ok, notes, failures, actualDuration, actualFrames, expectedFrames }
  }

  // 逐个接缝抽检：从接缝前 5 秒起解 10 秒，`-v error` 下有任何输出都算问题 ——
  // 除了下面 BENIGN_SEAM_MESSAGES 里那几条已知无害的。
  async probeSeams(outputPath, plan, notes) {
    const problems = []
    let acc = 0
    for (let i = 0; i < plan.length - 1; i++) {
      acc += plan[i].file.duration || 0
      const start = Math.max(0, acc - 5)
      const { code, stderr } = await execCapture(FFMPEG, [
        '-v', 'error', '-ss', start.toFixed(3), '-t', '10', '-i', outputPath, '-f', 'null', '-',
      ])
      const lines = stderr.trim().split('\n').filter(Boolean)
      const real = lines.filter((l) => !isBenignSeamMessage(l))
      const benign = lines.length - real.length

      if (benign > 0 && notes) {
        // 记进日志但不判失败：见 BENIGN_SEAM_MESSAGES 的说明
        notes.push(`接缝 ${acc.toFixed(2)}s：${benign} 条 null muxer 时间戳提示（已确认无害）`)
      }
      if (code !== 0 || real.length) {
        problems.push(`接缝 ${acc.toFixed(2)}s 附近解码异常（exit ${code}）：${(real[0] || '未知错误')}`)
      }
    }
    return problems
  }

  /* ------------------------- 清理 ------------------------- */

  cleanupTemp() {
    try {
      if (fs.existsSync(this.tempDir)) fs.rmSync(this.tempDir, { recursive: true, force: true })
    } catch { /* 忽略清理失败 */ }
  }
}

// 清理上次运行崩溃残留的临时目录
function cleanupOrphanTempDirs() {
  const tmp = os.tmpdir()
  let removed = 0
  try {
    for (const name of fs.readdirSync(tmp)) {
      if (!name.startsWith('video-merger-')) continue
      try { fs.rmSync(path.join(tmp, name), { recursive: true, force: true }); removed++ } catch { /* 仍被占用 */ }
    }
  } catch { /* 忽略 */ }
  if (removed > 0) console.log(`[merge] 清理了 ${removed} 个残留临时目录`)
}

module.exports = {
  MergeOrchestrator,
  isStrictMatch,
  classifyFile,
  needsTailTrim,
  cleanupOrphanTempDirs,
  probeFirstFrameIsKeyframe,
  inspectVideoTimeline,
  parseLastFfmpegTime,
  estimateRemaining,
  isBenignSeamMessage,
  pickTimescale,
  x264Profile,
  x264Level,
  OUTPUT_FORMATS,
  MUST_TRANSCODE,
  REMUX_FIXABLE,
}
