/**
 * 测试入口
 *
 *   npm test            # 全部
 *   npm run test:consistency
 *   npm run test:regression
 *   npm run test:functional
 *
 * 必须在 Electron 里跑（合并逻辑依赖 electron 的 app 对象解析 ffmpeg 路径）。
 */
const { app } = require('electron')
const fs = require('fs')
const path = require('path')

const SUITES = [
  ['unit', '单元测试（纯函数）', './unit'],
  ['consistency', '一致性检查（静态）', './consistency'],
  ['regression', '反例回归', './regression'],
  ['functional', '功能验证', './functional'],
  ['ui', '界面端到端（任务队列）', './ui'],
]

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const selected = only.length ? SUITES.filter(([k]) => only.includes(k)) : SUITES

app.whenReady().then(async () => {
  // merger 的 [merge] 日志很有用但太吵：先扣住，出问题时再倒出来
  const origLog = console.log
  const mergerLogs = []
  console.log = (...a) => {
    const s = String(a[0] ?? '')
    if (s.startsWith('[merge]')) { mergerLogs.push(s); return }
    origLog(...a)
  }

  let pass = 0, fail = 0
  const t0 = Date.now()
  const suiteReports = []
  try {
    for (const [, title, mod] of selected) {
      const suite = require(mod)
      const rep = await suite.run()
      pass += rep.pass
      fail += rep.fail
      suiteReports.push(rep)
    }
  } catch (e) {
    console.error('\n❌ 测试执行异常:', (e && e.stack) || e)
    fail++
  }

  // 清理临时产物
  try { fs.rmSync(path.join(__dirname, '.tmp'), { recursive: true, force: true }) } catch { /* 忽略 */ }

  console.log = origLog
  if (fail > 0 || process.env.TEST_VERBOSE === '1') {
    console.log(`\n----- 主进程 [merge] 日志（共 ${mergerLogs.length} 行）-----`)
    for (const l of mergerLogs) console.log(l)
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`\n${'='.repeat(72)}`)
  console.log(`总计：通过 ${pass}，失败 ${fail}，耗时 ${secs}s`)
  console.log(`${'='.repeat(72)}\n`)
  app.exit(fail === 0 ? 0 : 1)
})

setTimeout(() => { console.error('❌ 测试硬超时'); app.exit(3) }, 20 * 60 * 1000)
