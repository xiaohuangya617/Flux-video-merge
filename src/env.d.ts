/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

interface Window {
  api: {
    // 路径扫描
    scanPaths: (paths: string[]) => Promise<string[]>

    // 文件操作
    selectFiles: () => Promise<string[]>
    selectFolder: () => Promise<string>
    selectOutputDir: () => Promise<string>
    openFolder: (path: string) => Promise<void>
    trashFiles: (paths: string[]) => Promise<{ ok: string[]; failed: { path: string; error: string }[] }>

    // 视频处理
    probeVideo: (filePath: string) => Promise<import('./types').VideoParam>
    getFreeSpace: (dir: string) => Promise<number>
    startMerge: (task: import('./types').MergeTask) => Promise<void>
    cancelMerge: (taskId: string) => Promise<void>
    resolveOutputExists: (data: { taskId: string; choice: 'overwrite'|'rename'|'cancel' }) => Promise<void>

    // 事件监听
    onMergeProgress: (cb: (p: import('./types').MergeProgress) => void) => void
    onMergeComplete: (cb: (r: import('./types').MergeResult) => void) => void
    onMergeError: (cb: (e: { message: string; taskId: string }) => void) => void
    onOutputExists: (cb: (d: { path: string; taskId: string }) => void) => void
  }
}
