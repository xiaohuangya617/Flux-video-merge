declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

interface ElectronAPI {
  probeVideo(filePath: string): Promise<any>
  startMerge(task: any): Promise<void>
  cancelMerge(taskId: string): Promise<void>
  checkOutputExists(path: string): Promise<boolean>
  getFreeSpace(dir: string): Promise<number>
  selectFiles(): Promise<string[]>
  selectFolder(): Promise<string>
  selectOutputDir(): Promise<string>
  openFolder(path: string): Promise<void>
  scanFolder(paths: string[]): Promise<string[]>
  onMergeProgress(cb: (p: any) => void): void
  onMergeComplete(cb: (r: any) => void): void
  onMergeError(cb: (e: { message: string }) => void): void
  onOutputExists(cb: (d: { path: string }) => void): void
}

interface Window {
  api: ElectronAPI
}
