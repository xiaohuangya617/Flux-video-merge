const { execFile } = require('child_process')
const path = require('path')
const fs = require('fs')
const { app } = require('electron')
const os = require('os')

// ffmpeg/ffprobe 路径：开发时用 bin/，打包后用 resources/
function getBinaryPath(name) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, name)
  }
  return path.join(__dirname, '..', 'bin', name)
}

const FFMPEG = getBinaryPath('ffmpeg.exe')
const FFPROBE = getBinaryPath('ffprobe.exe')

// 检查 ffmpeg 是否存在
function checkFfmpegExists() {
  return fs.existsSync(FFMPEG) && fs.existsSync(FFPROBE)
}

// ffprobe 解析视频参数（完整 30 项）
function probeVideo(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]
    execFile(FFPROBE, args, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`ffprobe 失败: ${err.message}`))
      try {
        const data = JSON.parse(stdout)
        resolve(parseProbeData(filePath, data))
      } catch (e) {
        reject(new Error(`解析 ffprobe 输出失败: ${e.message}`))
      }
    })
  })
}

function parseProbeData(filePath, data) {
  const videoStream = data.streams.find(s => s.codec_type === 'video')
  const audioStream = data.streams.find(s => s.codec_type === 'audio')
  const format = data.format || {}

  if (!videoStream) {
    throw new Error('文件中没有视频流')
  }

  const id = require('crypto').randomUUID()

  return {
    id,
    filePath,
    fileName: path.basename(filePath),
    fileSize: parseInt(format.size) || 0,
    duration: parseFloat(format.duration) || 0,

    // 分轨时长：用于判断拼接接缝是否需要裁齐音轨（见 merger.js needsTailTrim）
    // 容器不提供 stream duration 时回退到容器时长，此时两者相等 → 不触发裁齐
    videoDuration: parseFloat(videoStream.duration) || parseFloat(format.duration) || 0,
    audioDuration: audioStream
      ? (parseFloat(audioStream.duration) || parseFloat(format.duration) || 0)
      : 0,

    // 视频帧数：产物校验要用它断言"一帧不多一帧不少"
    // 部分容器（如 mkv）不写 nb_frames，此时按 时长 × 帧率 估算。
    // frameCountEstimated 标记"这个数是估的"，校验时据此放宽容差，
    // 否则 mkv 源会因为估算误差被误判成丢帧。
    frameCount: parseInt(videoStream.nb_frames)
      || Math.round((parseFloat(videoStream.duration) || parseFloat(format.duration) || 0)
        * (() => { const [n, d] = String(videoStream.r_frame_rate || '').split('/').map(Number); return d ? n / d : 30 })()),
    frameCountEstimated: !parseInt(videoStream.nb_frames),

    // 视频流 V1-V18
    videoCodec: videoStream.codec_name || '',
    width: videoStream.width || 0,
    height: videoStream.height || 0,
    pixelFormat: videoStream.pix_fmt || '',
    rFrameRate: videoStream.r_frame_rate || '',
    avgFrameRate: videoStream.avg_frame_rate || '',
    videoTimeBase: videoStream.time_base || '',
    sampleAspectRatio: videoStream.sample_aspect_ratio || '0:1',
    displayAspectRatio: videoStream.display_aspect_ratio || '0:1',
    videoProfile: videoStream.profile || '',
    videoLevel: String(videoStream.level || ''),
    colorRange: videoStream.color_range || '',
    colorSpace: videoStream.color_space || '',
    colorTransfer: videoStream.color_transfer || '',
    colorPrimaries: videoStream.color_primaries || '',
    fieldOrder: videoStream.field_order || '',
    codecTagString: videoStream.codec_tag_string || '',
    hasBFrames: videoStream.has_b_frames || 0,

    // 音频流 A1-A7
    hasAudio: !!audioStream,
    audioCodec: audioStream?.codec_name || '',
    sampleRate: parseInt(audioStream?.sample_rate) || 0,
    channels: audioStream?.channels || 0,
    channelLayout: audioStream?.channel_layout || '',
    sampleFormat: audioStream?.sample_fmt || '',
    audioProfile: audioStream?.profile || '',
    audioTimeBase: audioStream?.time_base || '',

    // 容器 C1-C5
    containerFormat: format.format_name || '',
    videoTrackTimescale: parseInt(videoStream.time_base?.split('/')[1]) || 0,
    startTime: format.start_time || '0',
    // 恒定帧率判断用**容差**，不做字符串相等。
    // 《视频转码对齐经验教训》教训 3：23.976(24000/1001) 配 timescale 90000 时，
    // 一帧 = 3753.75 tick，时间戳只能取整，平均帧率会变成 2071980000/86418833 这种分数，
    // 与标称帧率字符串永不相等 —— 那是数学必然，不是 VFR。
    isCFR: (() => {
      const [rn, rd] = String(videoStream.r_frame_rate || '').split('/').map(Number)
      const [an, ad] = String(videoStream.avg_frame_rate || '').split('/').map(Number)
      const r = rd ? rn / rd : 0
      const av = ad ? an / ad : 0
      if (!r || !av) return false
      return Math.abs(av - r) / r <= 0.02
    })(),
    streamCount: data.streams?.length || 0,

    status: 'ready',
  }
}

// 获取磁盘可用空间
// 用 fs.statfs 直接问文件系统：不启动子进程，不会阻塞主进程几百毫秒，
// 也不受盘符假设影响（网络路径、挂载点都能算）。
function getFreeSpace(dirPath) {
  try {
    const st = fs.statfsSync(dirPath)
    const free = Number(st.bavail) * Number(st.bsize)
    return Number.isFinite(free) && free > 0 ? free : 0
  } catch {
    return 0   // 取不到就返回 0，调用方按"未知"处理，不拦截
  }
}

module.exports = { probeVideo, getFreeSpace, checkFfmpegExists, FFMPEG, FFPROBE }
