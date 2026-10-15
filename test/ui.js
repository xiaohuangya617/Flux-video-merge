/**
 * 界面端到端测试：任务队列
 *
 * 队列逻辑在渲染进程的 store 里（Pinia），主进程测不到，只能开真窗口驱动。
 * 做法：先 require 真实主进程（注册全部 IPC handler 并建窗口），
 * 再把那个窗口的页面换成构建好的 dist/index.html —— 复用同一个窗口实例，
 * 这样主进程推的 merge-progress / merge-complete 事件才会送到它身上。
 *
 * 需要先 `npx vite build`（npm test 的 ui 套件会自己检查）。
 */
const path = require('path')
const fs = require('fs')
const { app, BrowserWindow } = require('electron')

const h = require('./helpers')

require(path.join(h.PROJ, 'electron', 'main.js'))

const DRIVE = `(async () => {
  const fs = require('fs')            // nodeIntegration 下可用，但不是全局变量
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('video')
  store.initListeners()
  store.deleteSource = false
  store.outputFormat = 'mp4'
  store.outputDir = __OUTDIR__

  const R = {}

  // 1) 入队会冻结配置并清空当前列表
  store.outputName = 'u1'
  await store.addFiles(['__F__/base.mp4', '__F__/base.mp4'])
  R.canEnqueue = store.canEnqueue
  store.enqueueCurrent()
  R.afterEnqueue = { queue: store.queue.length, files: store.files.length, outputName: store.outputName }

  // 2) 再入两个（分别走转码 / 无损规整）
  store.outputName = 'u2'
  await store.addFiles(['__F__/m1_640x480_25fps_noaudio.mp4', '__F__/m2_1280x720_30fps_aac48k_mono.mp4'])
  store.enqueueCurrent()
  store.outputName = 'u3'
  await store.addFiles(['__F__/base.mp4', '__F__/A_two_audio.mp4'])
  store.enqueueCurrent()
  R.names = store.queue.map(q => q.outputName)
  R.frozen = store.queue.every(q => Array.isArray(q.files) && q.files.length === 2 && !!q.alignConfig)

  // 3) 排序 + 删除
  store.moveQueueItem(2, 0)
  R.reordered = store.queue.map(q => q.outputName)
  store.moveQueueItem(0, 2)
  store.outputName = 'u4'
  await store.addFiles(['__F__/base.mp4', '__F__/base.mp4'])
  store.enqueueCurrent()
  store.removeQueueItem(3)
  R.afterRemove = store.queue.map(q => q.outputName)

  // 4) 串行执行
  await store.startQueue()
  R.ran = store.queue.map(q => ({ name: q.outputName, status: q.status, mergePath: q.mergePath,
    out: q.outputPath ? q.outputPath.split(/[\\\\/]/).pop() : null }))
  R.summary = store.queueSummary ? {
    total: store.queueSummary.total,
    succeeded: store.queueSummary.succeeded.length,
    failed: store.queueSummary.failed.length,
    cancelled: store.queueSummary.cancelled,
  } : null
  R.queueRunningAfter = store.queueRunning
  R.deleteCandidates = store.queueSucceededSourcePaths().length

  // 5) 失败跳过：入队后删掉源文件，中间那趟必失败
  store.clearQueue()
  const victim = __OUTDIR__ + '/victim.mp4'
  fs.copyFileSync('__F__/base.mp4', victim)
  store.outputName = 'v1'
  await store.addFiles(['__F__/base.mp4', '__F__/base.mp4'])
  store.enqueueCurrent()
  store.outputName = 'v2'
  await store.addFiles([victim, '__F__/base.mp4'])
  store.enqueueCurrent()
  store.outputName = 'v3'
  await store.addFiles(['__F__/base.mp4', '__F__/base.mp4'])
  store.enqueueCurrent()
  fs.rmSync(victim, { force: true })
  await store.startQueue()
  R.skip = store.queue.map(q => ({ name: q.outputName, status: q.status }))
  R.skipSummary = store.queueSummary ? {
    succeeded: store.queueSummary.succeeded.map(q => q.outputName),
    failed: store.queueSummary.failed.map(q => q.outputName),
  } : null
  return R
})()`

// 第二轮：勾选「删除源文件」时，队列跑完应只弹一次统一确认，并且真的删掉
// 注意：源文件用的是 TMP 里的替身副本，绝不碰 fixtures 里的原始素材
const DRIVE_DELETE = `(async () => {
  const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('video')
  const D = {}
  D.queueBeforeClear = store.queue.length
  D.queueRunningBefore = store.queueRunning
  store.clearQueue()
  D.queueAfterClear = store.queue.length
  store.deleteSource = true
  store.outputDir = __OUTDIR__
  store.outputName = 'del1'
  await store.addFiles([__OUTDIR__ + '/victimA.mp4', __OUTDIR__ + '/victimB.mp4'])
  D.files = store.files.length
  D.fileStatus = store.files.map(f => f.status)
  D.fileErrs = store.files.map(f => f.errorMessage || null)
  D.filePaths = store.files.map(f => f.filePath)
  D.canEnqueue = store.canEnqueue
  D.ready = store.readyToStart
  D.outputDir = store.outputDir
  D.outputName = store.outputName
  D.hasAlign = !!store.alignConfig
  D.freeSpace = store.freeSpace
  D.estimated = store.estimatedSize
  store.enqueueCurrent()
  D.queueAfterEnqueue1 = store.queue.length

  store.outputName = 'del2'
  await store.addFiles([__OUTDIR__ + '/victimA.mp4', __OUTDIR__ + '/victimB.mp4'])
  D.canEnqueue2 = store.canEnqueue
  store.enqueueCurrent()
  D.queueAfterEnqueue2 = store.queue.length

  await store.startQueue()
  return {
    ...D,
    succeeded: store.queueSummary ? store.queueSummary.succeeded.length : 0,
    candidates: store.queueSucceededSourcePaths().length,
    summaryModalShown: [...document.querySelectorAll('.modal-mask.show')]
      .some((m) => m.textContent.includes('队列执行完成')),
    statuses: store.queue.map((q) => ({
      n: q.outputName, s: q.status,
      e: q.errorMessage ? q.errorMessage.split('\\n')[0] : null,
    })),
  }
})()`

// 点击某个弹窗里的按钮
const clickModalButton = (modalText, buttonText) => `(() => {
  const m = [...document.querySelectorAll('.modal-mask.show')].find((x) => x.textContent.includes(${JSON.stringify(modalText)}))
  if (!m) return 'modal-not-found'
  const btn = [...m.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(buttonText)})
  if (!btn) return 'button-not-found'
  btn.click()
  return 'clicked'
})()`

// 读「删除源文件」弹窗里列出的文件名
const readDeleteModal = `(() => {
  const m = [...document.querySelectorAll('.modal-mask.show')].find((x) => x.textContent.includes('删除源文件'))
  if (!m) return { shown: false, names: [] }
  return { shown: true, names: [...m.querySelectorAll('.del-list div')].map((d) => d.textContent.trim()) }
})()`

async function run() {
  const rep = h.makeReporter('界面端到端：任务队列（驱动真实 store + 真实 IPC + 真实 ffmpeg）')
  const dist = path.join(h.PROJ, 'dist', 'index.html')
  if (!fs.existsSync(dist)) {
    rep.check('dist 已构建', false, '缺少 dist/index.html，请先执行 npx vite build')
    return rep
  }

  h.resetTmp()
  await new Promise((r) => setTimeout(r, 2500))

  const win = BrowserWindow.getAllWindows()[0]
  if (!win) { rep.check('能拿到主窗口', false, '主进程没有创建窗口'); return rep }

  // 复用的就是主进程那个窗口，事件才会推给它
  await win.loadFile(dist)
  await new Promise((r) => setTimeout(r, 1200))

  const mounted = await win.webContents.executeJavaScript(
    `!!(document.querySelector('#app') && document.querySelector('#app').__vue_app__)`, true)
  if (!mounted) { rep.check('界面已挂载', false, 'dist 页面没有挂上 Vue'); return rep }
  rep.check('界面已挂载', true, '复用主窗口加载 dist/index.html')

  const script = DRIVE
    .replace(/__OUTDIR__/g, JSON.stringify(h.TMP))
    .replace(/__F__/g, h.FIXTURES.replace(/\\/g, '/'))

  const R = await win.webContents.executeJavaScript(script, true)

  rep.check('入队后冻结配置并清空当前列表',
    R.afterEnqueue.queue === 1 && R.afterEnqueue.files === 0 && R.afterEnqueue.outputName === '',
    `队列 ${R.afterEnqueue.queue} 项，列表 ${R.afterEnqueue.files} 个文件，输出名已清空`)

  rep.check('队列项保存了完整快照（文件列表 + 对齐配置）', R.frozen === true,
    '每项都带 files 与 alignConfig')

  rep.check('顺序可调整', Array.isArray(R.reordered) && R.reordered[0] === 'u3',
    `${R.names.join(' → ')} 调整为 ${R.reordered.join(' → ')}`)

  rep.check('队列项可删除', R.afterRemove.length === 3 && !R.afterRemove.includes('u4'),
    R.afterRemove.join(', '))

  const paths = (R.ran || []).map((x) => `${x.name}=${x.mergePath}`).join('  ')
  rep.check('队列串行执行且各自走对路径',
    (R.ran || []).length === 3 && R.ran.every((x) => x.status === 'done')
    && R.ran[0].mergePath === 'direct' && R.ran[1].mergePath === 'transcode' && R.ran[2].mergePath === 'remux',
    paths)

  rep.check('产物文件都已生成',
    (R.ran || []).every((x) => x.out && fs.existsSync(path.join(h.TMP, x.out))),
    (R.ran || []).map((x) => x.out).join(', '))

  rep.check('跑完弹一次汇总',
    R.summary && R.summary.total === 3 && R.summary.succeeded === 3 && R.summary.failed === 0,
    JSON.stringify(R.summary))

  // 三趟共 6 条路径，但 base.mp4 被两趟用到 → 去重后 4 个
  rep.check('汇总后能给出统一的删除源文件清单（已去重）', R.deleteCandidates === 4, `${R.deleteCandidates} 个（去重后）`)

  rep.check('队列结束后状态复位', R.queueRunningAfter === false, 'queueRunning=false')

  const skipOk = (R.skip || []).map((x) => `${x.name}=${x.status}`).join('  ')
  rep.check('单个任务失败时跳过继续，其余照常完成',
    R.skip && R.skip[0].status === 'done' && R.skip[1].status === 'error' && R.skip[2].status === 'done',
    skipOk)
  rep.check('汇总正确区分成功与失败',
    R.skipSummary && R.skipSummary.failed.length === 1 && R.skipSummary.succeeded.length === 2,
    `成功=[${(R.skipSummary || {}).succeeded}] 失败=[${(R.skipSummary || {}).failed}]`)

  // 收掉上一轮留下的汇总弹窗
  await win.webContents.executeJavaScript(clickModalButton('队列执行完成', '知道了'), true)
  await new Promise((r) => setTimeout(r, 300))

  // ---------- 第二轮：删除源文件统一确认一次，并且真的删 ----------
  const victimA = path.join(h.TMP, 'victimA.mp4')
  const victimB = path.join(h.TMP, 'victimB.mp4')
  fs.copyFileSync(path.join(h.FIXTURES, 'base.mp4'), victimA)
  fs.copyFileSync(path.join(h.FIXTURES, 'base.mp4'), victimB)

  const D = await win.webContents.executeJavaScript(
    DRIVE_DELETE.replace(/__OUTDIR__/g, JSON.stringify(h.TMP)), true)

  rep.check('勾选删除源文件时，队列跑完先弹一次汇总（不是每趟弹一次）',
    D.summaryModalShown === true && D.succeeded === 2,
    `成功 ${D.succeeded} 趟 · 明细=${JSON.stringify(D.statuses)} · 诊断=${JSON.stringify({
      queueBeforeClear: D.queueBeforeClear, queueRunningBefore: D.queueRunningBefore,
      queueAfterClear: D.queueAfterClear, files: D.files, fileStatus: D.fileStatus,
      fileErrs: D.fileErrs, filePaths: D.filePaths,
      canEnqueue: D.canEnqueue, ready: D.ready, outputDir: D.outputDir, outputName: D.outputName,
      hasAlign: D.hasAlign, freeSpace: D.freeSpace, estimated: D.estimated,
      q1: D.queueAfterEnqueue1, canEnqueue2: D.canEnqueue2, q2: D.queueAfterEnqueue2,
    })}`)
  rep.check('汇总里能拿到全部成功任务的源文件（2 趟 × 2 个，去重后 2 个）', D.candidates === 2, `${D.candidates} 个（去重后）`)

  // 点「知道了」→ 应弹统一的删除确认
  const clickClose = await win.webContents.executeJavaScript(clickModalButton('队列执行完成', '知道了'), true)
  await new Promise((r) => setTimeout(r, 400))
  const delModal = await win.webContents.executeJavaScript(readDeleteModal, true)

  rep.check('关闭汇总后弹出统一的删除确认（只弹一次）',
    clickClose === 'clicked' && delModal.shown === true,
    `click=${clickClose} shown=${delModal.shown}`)
  rep.check('确认框里列出的源文件已去重（同一文件被多个任务用到也只出现一次）',
    delModal.names.length === 2 && delModal.names.every((n) => n === 'victimA.mp4' || n === 'victimB.mp4'),
    delModal.names.join(', '))

  // 点「删除」→ 真的移入回收站
  const clickDel = await win.webContents.executeJavaScript(clickModalButton('删除源文件', '删除'), true)

  // 轮询等待，不要固定 sleep：文件被移走 与 "删除完成" 弹窗出现之间有时间窗
  // （trashItem 先把文件移走、Promise 才 resolve），固定等待会撞上时序抖动
  const readModals = `(() => ({
    visibleModals: [...document.querySelectorAll('.modal-mask.show')].map((m) => m.querySelector('h3') ? m.querySelector('h3').textContent.trim() : '(无标题)'),
    bodyText: [...document.querySelectorAll('.modal-mask.show')].map((m) => m.textContent.replace(/\\s+/g, ' ').trim().slice(0, 100)),
  }))()`
  let afterDel = { visibleModals: [] }
  for (let i = 0; i < 30; i++) {
    afterDel = await win.webContents.executeJavaScript(readModals, true)
    if ((afterDel.visibleModals || []).length > 0 && !fs.existsSync(victimA)) break
    await new Promise((r) => setTimeout(r, 500))
  }

  rep.check('点删除后源文件真的被移走，且不报"部分失败"',
    clickDel === 'clicked' && !fs.existsSync(victimA) && !fs.existsSync(victimB)
    && (afterDel.visibleModals || []).includes('删除完成'),
    `A存在=${fs.existsSync(victimA)} B存在=${fs.existsSync(victimB)} 弹窗=${JSON.stringify(afterDel)}`)

  return rep
}

module.exports = { run }
