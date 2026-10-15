/**
 * 测试共用工具
 *
 * 关键设计：判定用的字段清单**直接从 electron/merger.js 导出推导**，不手抄。
 * 之前吃过两次亏（audioTimeBase 只加进 merger 没加进 store，导致每个文件
 * 都被误判），测试里再抄一份只会让同类问题更难发现。
 * 另外用 consistency 检查静态核对 store 与 merger 的字段清单是否一致。
 */
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

const { MUST_TRANSCODE, REMUX_FIXABLE, MergeOrchestrator } = require('../electron/merger.js')
const { probeVideo, FFPROBE } = require('../electron/ffmpeg.js')

const PROJ = path.join(__dirname, '..')
const FIXTURES = path.join(__dirname, 'fixtures')
const TMP = path.join(__dirname, '.tmp')

// 23 个判定字段：必须转码组 + 可无损规整组
const COMPARE_KEYS = [...Object.keys(MUST_TRANSCODE), ...Object.keys(REMUX_FIXABLE)]

// 与 store 保持一致的类型分类
const NUM_KEYS = ['width', 'height', 'sampleRate', 'channels', 'videoTrackTimescale', 'streamCount']
const BOOL_KEYS = ['isCFR']
// 音频参数只在"有音轨"的文件之间投票
const AUDIO_KEYS = ['audioCodec', 'sampleRate', 'channels', 'channelLayout', 'audioTimeBase']
const AUDIO_DEFAULTS = {
  audioCodec: 'aac', sampleRate: 48000, channels: 2, channelLayout: 'stereo', audioTimeBase: '',
}

// 复刻 store 的多数派算法（store 是 Vue/Pinia 的，测不了，只能复刻；
// 字段清单与音频样本范围由上方的 consistency 检查兜底）
function calcMajority(files) {
  const r = {}
  for (const key of COMPARE_KEYS) {
    const isAudio = AUDIO_KEYS.includes(key)
    const pool = isAudio ? files.filter((f) => f.hasAudio) : files
    if (isAudio && pool.length === 0) { r[key] = AUDIO_DEFAULTS[key]; continue }
    const counts = new Map()
    for (const f of pool) counts.set(String(f[key] ?? ''), (counts.get(String(f[key] ?? '')) || 0) + 1)
    let best = String(pool[0][key] ?? ''), bc = 0
    for (const [v, c] of counts) if (c > bc) { best = v; bc = c }
    r[key] = BOOL_KEYS.includes(key) ? best === 'true'
      : NUM_KEYS.includes(key) ? (parseInt(best) || 0) : best
  }
  return r
}

function fixture(name) { return path.join(FIXTURES, name) }

function resetTmp() {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(TMP, { recursive: true })
  return TMP
}

function tmpFile(name) { return path.join(TMP, name) }

// 用真实的 MergeOrchestrator 跑一次合并
function runTask(id, files, opts = {}) {
  const align = opts.align || calcMajority(files)
  return new Promise((resolve) => {
    const task = {
      id: 'test-' + id, files, alignConfig: align,
      outputFormat: opts.format || 'mp4', quality: opts.quality || 'high',
      outputDir: opts.outDir || TMP, outputName: opts.name || id,
    }
    let done = false
    const finish = (r) => { if (!done) { done = true; resolve(r) } }
    const orch = new MergeOrchestrator(task, opts.onProgress || (() => {}),
      (r) => finish(r),
      (e) => finish({ success: false, errorMessage: e.message }),
      () => orch.resolveOutputExists(opts.existsChoice || 'overwrite'))
    orch.run()
  })
}

async function mergePaths(id, paths, opts = {}) {
  const files = []
  for (const p of paths) files.push(await probeVideo(p))
  return runTask(id, files, opts)
}

function probeOut(p) {
  const j = JSON.parse(execFileSync(FFPROBE,
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', p], { encoding: 'utf8' }))
  return {
    format: j.format.format_name,
    duration: Number(j.format.duration),
    layout: j.streams.map((s) => s.codec_type[0]).join('+'),
    streamCount: j.streams.length,
    video: j.streams.find((s) => s.codec_type === 'video'),
    audio: j.streams.find((s) => s.codec_type === 'audio'),
  }
}

function ffmpeg(args) {
  execFileSync(path.join(PROJ, 'bin', 'ffmpeg.exe'), args, { stdio: 'ignore' })
}
function ffprobeJson(p) {
  return JSON.parse(execFileSync(FFPROBE,
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', p], { encoding: 'utf8' }))
}

// 简单记分板
function makeReporter(title) {
  let pass = 0, fail = 0
  const lines = []
  const out = (s) => { lines.push(s); console.log(s) }
  out(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`)
  return {
    check(name, ok, detail) {
      ok ? pass++ : fail++
      out(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? '  — ' + detail : ''}`)
    },
    note(msg) { out(`  ·  ${msg}`) },
    get pass() { return pass },
    get fail() { return fail },
    lines,
  }
}

module.exports = {
  PROJ, FIXTURES, TMP,
  COMPARE_KEYS, NUM_KEYS, BOOL_KEYS, AUDIO_KEYS, AUDIO_DEFAULTS,
  calcMajority, fixture, resetTmp, tmpFile,
  runTask, mergePaths, probeOut, ffmpeg, ffprobeJson,
  makeReporter, probeVideo,
}
