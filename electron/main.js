const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron')
const path = require('path')
const { probeVideo, getFreeSpace } = require('./ffmpeg')
const { MergeOrchestrator, cleanupOrphanTempDirs } = require('./merger')
const logger = require('./logger')

const isDev = !app.isPackaged
let mainWindow = null
const activeTasks = new Map()

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: '视频拼接器',
    backgroundColor: '#eaf2ff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: true,
    },
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => { mainWindow = null })
}

// ===== IPC: 文件对话框 =====
ipcMain.handle('select-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择视频文件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '视频文件', extensions: ['mp4', 'mkv', 'mov'] },
    ],
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择文件夹',
    properties: ['openDirectory'],
  })
  return result.canceled ? '' : result.filePaths[0]
})

ipcMain.handle('select-output-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择输出目录',
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? '' : result.filePaths[0]
})

// 交给 Electron shell 的路径必须先归一化。
// shell.trashItem / shell.openPath 解析不了正斜杠：传 "E:/a/b.mp4" 会报
// "Failed to parse path" 且什么都不做。输出目录是用户手输的框，
// 敲 "E:/videos" 完全可能，所以这里统一转成原生路径。
function normalizePath(p) {
  try { return path.resolve(String(p)) } catch { return String(p) }
}

ipcMain.handle('open-folder', async (_e, folderPath) => {
  shell.openPath(normalizePath(folderPath))
})

// 把源文件移入系统回收站（不是直接删除，用户可还原）
ipcMain.handle('trash-files', async (_e, paths) => {
  const ok = []
  const failed = []
  for (const p of paths || []) {
    const target = normalizePath(p)
    try {
      await shell.trashItem(target)
      ok.push(target)
    } catch (err) {
      failed.push({ path: target, error: err.message })
    }
  }
  return { ok, failed }
})

// 扫描路径：文件直接返回，文件夹递归扫描视频文件
// v1 支持格式：mp4 / mkv / mov（webm 因输出编码器冲突移出，见 merger.js OUTPUT_FORMATS）
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mov'])
ipcMain.handle('scan-paths', async (_e, paths) => {
  const fs = require('fs')
  const results = []
  function scan(p) {
    try {
      const stat = fs.statSync(p)
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(p, { withFileTypes: true })
        for (const entry of entries) {
          scan(path.join(p, entry.name))
        }
      } else if (VIDEO_EXTS.has(path.extname(p).toLowerCase())) {
        results.push(p)
      }
    } catch { /* 跳过无法访问的路径 */ }
  }
  for (const p of paths) scan(p)
  return results
})

// ===== IPC: 视频处理 =====
ipcMain.handle('probe-video', async (_e, filePath) => {
  return probeVideo(filePath)
})

ipcMain.handle('get-free-space', async (_e, dirPath) => {
  return getFreeSpace(dirPath)
})

// ===== IPC: 合并任务 =====
ipcMain.handle('start-merge', async (_e, task) => {
  console.log('[merge] start-merge called, taskId:', task.id, 'files:', task.files.length)
  const orchestrator = new MergeOrchestrator(
    task,
    // 进度回调
    (progress) => { mainWindow?.webContents.send('merge-progress', progress) },
    // 完成回调
    (result) => { console.log('[merge] complete:', result); mainWindow?.webContents.send('merge-complete', result); activeTasks.delete(task.id) },
    // 错误回调
    (err) => { console.error('[merge] error:', err); mainWindow?.webContents.send('merge-error', err); activeTasks.delete(task.id) },
    // 输出已存在回调
    (data) => { console.log('[merge] output exists:', data); mainWindow?.webContents.send('output-exists', data) },
  )
  activeTasks.set(task.id, orchestrator)
  orchestrator.run().catch((e) => { console.error('[merge] run exception:', e) })
})

ipcMain.handle('cancel-merge', async (_e, taskId) => {
  const orchestrator = activeTasks.get(taskId)
  if (orchestrator) {
    orchestrator.cancel()
    activeTasks.delete(taskId)
  }
})

ipcMain.handle('resolve-output-exists', async (_e, { taskId, choice }) => {
  const orchestrator = activeTasks.get(taskId)
  if (orchestrator) {
    orchestrator.resolveOutputExists(choice)
  }
})

// ===== 应用生命周期 =====
app.whenReady().then(() => {
  Menu.setApplicationMenu(null)  // 去掉菜单栏
  // 日志目录：%APPDATA%\video-merger\logs\，每次合并一个文件，只保留最近若干个。
  // 之前完全不落盘，用户从快捷方式启动时控制台看不见，出了问题无从排查。
  const logDir = logger.init(app.getPath('userData'))
  const pruned = logger.prune()
  console.log('[app] 日志目录:', logDir, pruned ? `(清理了 ${pruned} 个旧日志)` : '')
  cleanupOrphanTempDirs()        // 清理上次崩溃残留的转码临时目录
  createWindow()
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
