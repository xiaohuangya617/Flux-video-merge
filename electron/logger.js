/**
 * 任务日志
 *
 * 存在的理由：这个工具会调 ffmpeg、可能中途失败，之前却**完全不落盘日志** ——
 * 用户从桌面快捷方式启动，控制台看不见，出了问题双方都是瞎子。
 * 现在每次合并写一个日志文件，失败时能直接看出是哪一步、哪条断言、哪条 ffmpeg 命令。
 *
 * 写日志失败绝不允许影响合并本身，所以所有写操作都吞异常。
 */
const fs = require('fs')
const path = require('path')

const KEEP_LOGS = 60          // 只保留最近这么多个日志文件
const STDERR_TAIL = 8000      // 失败时写进日志的 ffmpeg stderr 尾部长度

let logDir = null

// 版本号直接从 package.json 读，避免两处各写一份
let APP_VERSION = '?'
try { APP_VERSION = require('../package.json').version || '?' } catch { /* 忽略 */ }

function init(userDataDir) {
  try {
    logDir = path.join(userDataDir, 'logs')
    fs.mkdirSync(logDir, { recursive: true })
  } catch {
    logDir = null
  }
  return logDir
}

function getLogDir() { return logDir }

/**
 * 惰性自初始化。
 * 只靠 main.js 显式调 init() 有个隐患：任何没走到那一步的场景（比如测试、
 * 或者以后新增的调用方）都会**静默不写日志** —— 而这恰恰是最需要日志的时候。
 * 所以这里自己兜底：没初始化过就自己按 userData 建目录。
 */
function ensureDir() {
  if (logDir) return logDir
  try {
    const { app } = require('electron')
    if (!app || typeof app.getPath !== 'function') return null
    return init(app.getPath('userData'))
  } catch {
    return null
  }
}

// 启动时清理旧日志，避免无限堆积
function prune() {
  if (!logDir) return 0
  try {
    const files = fs.readdirSync(logDir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => ({ f, t: fs.statSync(path.join(logDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    let removed = 0
    for (const { f } of files.slice(KEEP_LOGS)) {
      try { fs.rmSync(path.join(logDir, f), { force: true }); removed++ } catch { /* 忽略 */ }
    }
    return removed
  } catch {
    return 0
  }
}

class TaskLog {
  constructor(task) {
    this.file = null
    this.stream = null
    try {
      if (!ensureDir()) return
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const shortId = String(task.id || 'notask').slice(0, 8)
      this.file = path.join(logDir, `${ts}_${shortId}.log`)
      this.stream = fs.createWriteStream(this.file, { flags: 'a' })
      this.write(`视频拼接器 v${APP_VERSION} — 合并任务日志`)
      this.write(`时间: ${new Date().toLocaleString()}`)
      this.write(`任务 ID: ${task.id}`)
      this.write(`输出: ${task.outputDir}\\${task.outputName}.${task.outputFormat}  (格式 ${task.outputFormat}, 画质 ${task.quality})`)
      this.write(`文件数: ${task.files.length}`)
      for (let i = 0; i < task.files.length; i++) {
        const f = task.files[i]
        this.write(`  [${i}] ${f.fileName}  ${(f.fileSize / 1048576).toFixed(1)}MB  ${f.width}x${f.height}  ${f.rFrameRate}  ${((f.duration || 0)).toFixed(2)}s`)
      }
    } catch {
      this.stream = null
    }
  }

  write(line) {
    try { if (this.stream) this.stream.write(String(line) + '\n') } catch { /* 忽略 */ }
  }

  section(title) { this.write(`\n----- ${title} -----`) }

  // 记录实际执行的 ffmpeg 命令（排查时最有用的一条）
  command(label, bin, args) {
    const quoted = args.map((a) => (/\s/.test(a) ? `"${a}"` : a))
    this.write(`[cmd:${label}] ${bin} ${quoted.join(' ')}`)
  }

  // 记录 ffmpeg 失败时的 stderr 尾部
  stderr(label, text) {
    const t = String(text || '')
    if (!t) return
    this.write(`[stderr:${label}] (共 ${t.length} 字节，下面是尾部)`)
    this.write(t.slice(-STDERR_TAIL))
  }

  close() {
    try { if (this.stream) this.stream.end() } catch { /* 忽略 */ }
    try { if (this.stream) this.stream.close() } catch { /* 忽略 */ }
    this.stream = null
  }
}

module.exports = { init, prune, getLogDir, TaskLog }
