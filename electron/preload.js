const { ipcRenderer } = require('electron')

// contextIsolation: false 时必须直接挂到 window，不能用 contextBridge
window.api = {
  // 文件对话框
  selectFiles: () => ipcRenderer.invoke('select-files'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectOutputDir: () => ipcRenderer.invoke('select-output-dir'),
  openFolder: (path) => ipcRenderer.invoke('open-folder', path),
  trashFiles: (paths) => ipcRenderer.invoke('trash-files', paths),

  // 路径扫描（文件夹递归找视频）
  scanPaths: (paths) => ipcRenderer.invoke('scan-paths', paths),

  // 视频处理
  probeVideo: (filePath) => ipcRenderer.invoke('probe-video', filePath),
  getFreeSpace: (dir) => ipcRenderer.invoke('get-free-space', dir),

  // 合并任务
  startMerge: (task) => ipcRenderer.invoke('start-merge', task),
  cancelMerge: (taskId) => ipcRenderer.invoke('cancel-merge', taskId),
  resolveOutputExists: (data) => ipcRenderer.invoke('resolve-output-exists', data),

  // 事件监听
  onMergeProgress: (cb) => ipcRenderer.on('merge-progress', (_e, p) => cb(p)),
  onMergeComplete: (cb) => ipcRenderer.on('merge-complete', (_e, r) => cb(r)),
  onMergeError: (cb) => ipcRenderer.on('merge-error', (_e, e) => cb(e)),
  onOutputExists: (cb) => ipcRenderer.on('output-exists', (_e, d) => cb(d)),
}
