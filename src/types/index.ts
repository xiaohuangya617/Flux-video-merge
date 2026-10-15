// ===== 视频参数（完整 30 项检测） =====
export interface VideoParam {
  id: string
  filePath: string
  fileName: string
  fileSize: number
  duration: number
  videoDuration: number   // 视频轨时长（秒）— 用于接缝裁齐判断
  audioDuration: number   // 音频轨时长（秒）— 比 videoDuration 长会在拼接处重叠
  frameCount: number      // 视频帧数 — 产物校验用
  frameCountEstimated?: boolean // 帧数是估算的（容器没写 nb_frames），校验时放宽容差
  firstFrameIsKeyframe?: boolean  // 首帧是否关键帧，否则无损拼接的接缝处会花屏

  // 视频流 V1-V18
  videoCodec: string
  width: number
  height: number
  pixelFormat: string
  rFrameRate: string
  avgFrameRate: string
  videoTimeBase: string
  sampleAspectRatio: string
  displayAspectRatio: string
  videoProfile: string
  videoLevel: string
  colorRange: string
  colorSpace: string
  colorTransfer: string
  colorPrimaries: string
  fieldOrder: string
  codecTagString: string
  hasBFrames: number

  // 音频流 A1-A7
  hasAudio: boolean
  audioCodec: string
  sampleRate: number
  channels: number
  channelLayout: string
  sampleFormat: string
  audioProfile: string
  audioTimeBase: string

  // 容器 C1-C5
  containerFormat: string
  videoTrackTimescale: number
  startTime: string
  isCFR: boolean
  streamCount: number

  // 状态
  status: 'pending' | 'parsing' | 'ready' | 'error'
  errorMessage?: string
}

// ===== 对齐配置（转码目标） =====
export interface AlignConfig {
  videoCodec: string
  width: number
  height: number
  pixelFormat: string
  rFrameRate: string
  avgFrameRate: string      // 与 rFrameRate 不一致说明是 VFR —— 必须转码归一
  isCFR: boolean            // 恒定帧率标志
  videoTimeBase: string
  sampleAspectRatio: string
  displayAspectRatio: string
  colorRange: string
  colorSpace: string
  colorTransfer: string
  colorPrimaries: string

  audioCodec: string
  sampleRate: number
  channels: number
  channelLayout: string
  audioTimeBase: string     // 音频时间基 —— 可无损统一（重封装）

  containerFormat: string
  videoTrackTimescale: number
  startTime: string         // 每段的时间轴原点，不一致会累积成音画偏移 —— 可无损归零
  streamCount: number       // 流布局，不一致会让拼接按流序号错位 —— 可无损丢流
}

// ===== 参数差异 =====
export interface ParamDiff {
  key: string
  label: string
  category: 'video' | 'audio' | 'container'
  values: string[]
  uniqueValues: string[]
  isDifferent: boolean
  alignTarget: string
  fixed?: boolean          // 结构性字段，由工具自动归一，不允许手选目标
}

// ===== 合并任务 =====
export interface MergeTask {
  id: string
  files: VideoParam[]
  alignConfig: AlignConfig
  // v1 仅支持 mp4/mkv/mov；WebM 需要 VP9+Opus，与本工具统一转码到 H.264/AAC 的策略冲突
  outputFormat: 'mp4' | 'mkv' | 'mov'
  quality: 'high' | 'medium' | 'low'
  outputDir: string
  outputName: string
}

// ===== 任务进度 =====
export interface MergeProgress {
  taskId: string
  phase: 'checking' | 'normalizing' | 'transcoding' | 'merging' | 'verifying' | 'cleanup' | 'done' | 'error'
  percent: number
  currentFile?: string
  stepText: string
  remainingSeconds?: number   // 剩余时间估算（秒）；不确定时不给，界面也就不显示
}

// ===== 合并路径（三级） =====
// direct    : 参数完全一致，直接 concat -c copy（零损失，最快）
// remux     : 只有可无损修复的差异，逐个 -c copy 规整后拼接（零损失）
// transcode : 存在必须重编码的差异，转码归一后拼接（有损，最稳）
export type MergePath = 'direct' | 'remux' | 'transcode'

// ===== 合并结果 =====
export interface MergeResult {
  taskId: string
  success: boolean
  cancelled?: boolean      // 用户选择了「取消任务」，不是错误
  outputPath?: string
  outputSize?: number
  outputDuration?: number
  transcodedFiles: string[]
  totalFiles: number
  errorMessage?: string

  // 质量控制
  mergePath?: MergePath
  normalizedFiles?: string[]   // 做过无损规整的文件
  escalated?: boolean          // 无损尝试未过校验，已升级重拼
  verified?: boolean           // 产物校验是否通过
  verifyNotes?: string[]       // 校验结论（UI 一行字用）
}

// ===== 输出文件冲突选择 =====
export type OutputExistsChoice = 'overwrite' | 'rename' | 'cancel'

// ===== 队列任务（v1.2） =====
// 入队时把"这一趟"的完整配置冻结进来：文件列表（含顺序）+ 对齐配置 +
// 输出名/目录/格式/画质。入队后不可修改，只能排序或删除。
export type QueuedTaskStatus = 'waiting' | 'running' | 'done' | 'error'

export interface QueuedTask extends MergeTask {
  status: QueuedTaskStatus
  errorMessage?: string
  outputPath?: string
  outputSize?: number
  mergePath?: MergePath
  escalated?: boolean
}

// 队列跑完后的汇总（只弹一次）
export interface QueueSummary {
  total: number
  succeeded: QueuedTask[]
  failed: QueuedTask[]
  cancelled: boolean
}
