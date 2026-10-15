import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import type {
  VideoParam, AlignConfig, ParamDiff, MergeTask, MergeProgress, MergeResult,
  QueuedTask, QueueSummary,
} from '@/types'

// 完整对比清单（23 项）。分「必须转码」与「可无损规整」两类的判定在
// electron/merger.js 里（决策只有一处来源），这里只负责采集与展示。
const COMPARE_DEFS: { key: keyof AlignConfig; label: string; category: 'video'|'audio'|'container' }[] = [
  // 视频流
  { key: 'videoCodec', label: '视频编码', category: 'video' },
  { key: 'width', label: '宽度', category: 'video' },
  { key: 'height', label: '高度', category: 'video' },
  { key: 'pixelFormat', label: '像素格式', category: 'video' },
  { key: 'rFrameRate', label: '标称帧率', category: 'video' },
  { key: 'avgFrameRate', label: '平均帧率', category: 'video' },
  { key: 'isCFR', label: '帧率模式', category: 'video' },
  { key: 'videoTimeBase', label: '视频时间基', category: 'video' },
  { key: 'sampleAspectRatio', label: '像素宽高比', category: 'video' },
  { key: 'displayAspectRatio', label: '显示宽高比', category: 'video' },
  { key: 'colorRange', label: '色彩范围', category: 'video' },
  { key: 'colorSpace', label: '色彩空间', category: 'video' },
  { key: 'colorTransfer', label: '传输特性', category: 'video' },
  { key: 'colorPrimaries', label: '色彩原色', category: 'video' },
  // 音频流
  { key: 'audioCodec', label: '音频编码', category: 'audio' },
  { key: 'sampleRate', label: '采样率', category: 'audio' },
  { key: 'channels', label: '声道数', category: 'audio' },
  { key: 'channelLayout', label: '声道布局', category: 'audio' },
  { key: 'audioTimeBase', label: '音频时间基', category: 'audio' },
  // 容器
  { key: 'containerFormat', label: '容器格式', category: 'container' },
  { key: 'videoTrackTimescale', label: '视频轨时间刻度', category: 'container' },
  { key: 'startTime', label: '起始时间', category: 'container' },
  { key: 'streamCount', label: '流数量', category: 'container' },
]

// 数值型字段（其余按字符串比较）
const NUM_KEYS = ['width', 'height', 'sampleRate', 'channels', 'videoTrackTimescale', 'streamCount']

// 布尔型字段
const BOOL_KEYS = ['isCFR']

// 结构性字段：由工具自动归一（时间轴归零 / 丢多余流 / CFR 化），不让用户手选目标
const FIXED_KEYS = ['avgFrameRate', 'isCFR', 'startTime', 'streamCount']

// 音频对齐：只在「有音轨」的文件之间取多数派。
// 无音轨文件不参与音频参数投票——它们会被转码补静音（DESIGN §10 决策1），
// 若让它们参与，多数派可能选出空编码/0 采样率，导致转码命令非法。
// audioTimeBase 也必须在列：否则无音轨文件的空值会赢得多数派，
// 反过来把有音轨的文件误判成"音频时间基不一致"（LESSONS.md 第 17 条）。
const AUDIO_KEYS = ['audioCodec', 'sampleRate', 'channels', 'channelLayout', 'audioTimeBase']
const AUDIO_DEFAULTS: Record<string, string | number> = {
  audioCodec: 'aac', sampleRate: 48000, channels: 2, channelLayout: 'stereo', audioTimeBase: '',
}

// 骨架帧率兜底。
// 《视频转码对齐经验教训》教训 4：多数派可能选出"坏目标"——
// 例：5 个文件标称 120fps、1 个标称 30fps，120 往往是封装异常，
// 拿它当目标会把整批转成 120fps。规则：多数票 >60fps 时，退回本批里 ≤60 的众数。
function fpsOf(s: string) {
  const [n, d] = String(s || '').split('/').map(Number)
  return d ? n / d : 0
}
function saneFrameRate(pool: VideoParam[], voted: string): string {
  if (fpsOf(voted) <= 60) return voted
  const counts = new Map<string, number>()
  for (const f of pool) {
    const v = String(f.rFrameRate || '')
    const fps = fpsOf(v)
    if (fps > 0 && fps <= 60) counts.set(v, (counts.get(v) || 0) + 1)
  }
  let best = ''
  let bestCount = 0
  for (const [v, c] of counts) if (c > bestCount) { best = v; bestCount = c }
  return best || voted
}

export const useVideoStore = defineStore('video', () => {
  // ===== 状态 =====
  const files = ref<VideoParam[]>([])
  const alignConfig = ref<AlignConfig | null>(null)
  // 基准文件：-1 = 自动（按多数派）。列表一变就回到 -1，
  // 否则下拉显示的"第N个文件"会和实际基准（多数派）对不上，等于骗用户。
  const baseFileIndex = ref(-1)
  const outputFormat = ref<'mp4'|'mkv'|'mov'>('mp4')
  const outputQuality = ref<'high'|'medium'|'low'>('high')
  const outputName = ref('')
  const outputDir = ref('')
  const deleteSource = ref(false)

  const taskStatus = ref<'idle'|'running'|'done'|'error'>('idle')
  const progress = ref<MergeProgress | null>(null)
  const lastResult = ref<MergeResult | null>(null)
  const freeSpace = ref(0)
  const currentTaskId = ref('')
  // 本次合并真正用到的源文件路径快照。
  // 「合并后删除源文件」必须按它来删，不能读实时列表 —— 否则用户在合并期间
  // 增删/重排过列表，就会删错或漏删。
  const mergedFilePaths = ref<string[]>([])
  // 主进程抛来「输出文件已存在」，UI 层据此弹窗
  const outputExistsInfo = ref<{ path: string; taskId: string } | null>(null)
  // IPC 监听只注册一次（组件重挂载/HMR 时不能重复叠加）
  let listenersReady = false

  // ===== 任务队列（v1.2）=====
  const queue = ref<QueuedTask[]>([])
  const queueRunning = ref(false)
  const queueIndex = ref(0)          // 正在跑第几趟（从 1 开始，给界面显示）
  const queueSummary = ref<QueueSummary | null>(null)
  // 等某个任务结束的兑现函数。按 taskId 登记，事件到达时兑现。
  const taskWaiters = new Map<string, (r: MergeResult) => void>()
  // 队列运行中用户点了取消
  let queueCancelRequested = false

  function settleWaiter(taskId: string, r: MergeResult) {
    const w = taskWaiters.get(taskId)
    if (w) { taskWaiters.delete(taskId); w(r) }
  }

  // ===== 参数差异检测 =====
  // 布尔字段转成人话再展示
  function displayValue(key: string, raw: unknown): string {
    if (key === 'isCFR') return raw ? '恒定' : '可变'
    return String(raw ?? '')
  }

  const paramDiffs = computed<ParamDiff[]>(() => {
    if (files.value.length < 2) return []
    return COMPARE_DEFS.map(({ key, label, category }) => {
      const rawValues = files.value.map(f => String(f[key] ?? ''))
      const values = files.value.map(f => displayValue(key as string, f[key]))
      const uniqueRaw = [...new Set(rawValues)]

      // 音频参数的候选对齐目标只列有音轨文件的取值：空编码/0 采样率不是合法目标
      const candidates = category === 'audio'
        ? values.filter(v => v !== '' && v !== '0')
        : values
      const uniqueValues = [...new Set(candidates.length ? candidates : values)]

      const targetRaw = alignConfig.value ? (alignConfig.value as any)[key] : undefined
      const alignTarget = targetRaw === undefined
        ? (values[0] || '')
        : displayValue(key as string, targetRaw)

      return {
        key: key as string,
        label,
        category,
        values,
        uniqueValues,
        isDifferent: uniqueRaw.length > 1,
        alignTarget,
        fixed: FIXED_KEYS.includes(key as string),
      }
    })
  })

  const diffCount = computed(() => paramDiffs.value.filter(d => d.isDifferent).length)

  const hasDiff = computed(() => diffCount.value > 0)

  // ===== 就绪检查 =====
  const estimatedSize = computed(() => {
    const total = files.value.reduce((s, f) => s + f.fileSize, 0)
    return Math.round(total * 1.2 * 1.05)
  })

  // 就绪检查（不含"是否正在跑"）
  const readyToStart = computed(() => {
    if (files.value.length < 2) return false
    if (files.value.some(f => f.status !== 'ready')) return false
    if (!outputDir.value) return false
    if (!outputName.value.trim()) return false
    if (!alignConfig.value) return false
    if (freeSpace.value > 0 && freeSpace.value < estimatedSize.value) return false
    return true
  })

  const busy = computed(() => queueRunning.value || taskStatus.value === 'running')

  const canMerge = computed(() => !busy.value && readyToStart.value)
  // 入队和直接合并的就绪条件一样，区别只在"现在跑"还是"存起来稍后跑"
  const canEnqueue = computed(() => !busy.value && readyToStart.value)

  const readinessMessage = computed(() => {
    if (files.value.length < 2) return '请先添加至少 2 个视频'
    if (files.value.some(f => f.status === 'error')) return '存在解析失败的文件，请移除后重试'
    if (files.value.some(f => f.status === 'parsing')) return '正在解析视频参数…'
    if (!outputDir.value) return '请选择输出目录'
    if (!outputName.value.trim()) return '请填写输出文件名'
    if (freeSpace.value > 0 && freeSpace.value < estimatedSize.value) return '磁盘可用空间不足'
    return hasDiff.value
      ? `检测到 ${diffCount.value} 处参数差异，将优先无损规整，必要时转码`
      : '所有参数一致，将无损拼接'
  })

  // ===== 多数派基准 =====
  function recalcMajorityAlign() {
    // 走多数派 = 不再对齐到某个具体文件，下拉同步回「自动」
    baseFileIndex.value = -1
    if (files.value.length === 0) { alignConfig.value = null; return }
    const result = {} as AlignConfig
    for (const { key } of COMPARE_DEFS) {
      const isAudio = AUDIO_KEYS.includes(key as string)
      const pool = isAudio ? files.value.filter(f => f.hasAudio) : files.value

      // 一个文件都没有音轨 → 用默认音频参数，保证转码命令合法
      if (isAudio && pool.length === 0) {
        ;(result as any)[key] = AUDIO_DEFAULTS[key]
        continue
      }

      const counts = new Map<string, number>()
      for (const f of pool) {
        const v = String(f[key] ?? '')
        counts.set(v, (counts.get(v) || 0) + 1)
      }
      let best = String(pool[0][key] ?? '')
      let bestCount = 0
      for (const [v, c] of counts) {
        if (c > bestCount) { best = v; bestCount = c }
      }
      // 帧率多数票 >60fps 时退回本批的常规帧率（见 saneFrameRate）
      if (key === 'rFrameRate') best = saneFrameRate(pool, best)
      if (BOOL_KEYS.includes(key as string)) {
        ;(result as any)[key] = best === 'true'
      } else if (NUM_KEYS.includes(key as string)) {
        ;(result as any)[key] = parseInt(best) || 0
      } else {
        ;(result as any)[key] = best
      }
    }
    alignConfig.value = result
  }

  // 文件列表变化时自动重算
  watch(() => files.value.length, () => { recalcMajorityAlign() })

  // ===== 文件操作 =====
  async function addFiles(paths: string[]) {
    const existing = new Set(files.value.map(f => f.filePath))
    const newPaths = paths.filter(p => !existing.has(p))
    if (newPaths.length === 0) return

    // 先加入 pending 状态
    const pendingItems: VideoParam[] = newPaths.map(p => ({
      id: crypto.randomUUID(),
      filePath: p,
      fileName: p.split(/[\\/]/).pop() || p,
      fileSize: 0,
      duration: 0,
      videoDuration: 0,
      audioDuration: 0,
      frameCount: 0,
      frameCountEstimated: false,
      videoCodec: '', width: 0, height: 0, pixelFormat: '',
      rFrameRate: '', avgFrameRate: '', videoTimeBase: '',
      sampleAspectRatio: '', displayAspectRatio: '',
      videoProfile: '', videoLevel: '',
      colorRange: '', colorSpace: '', colorTransfer: '', colorPrimaries: '',
      fieldOrder: '', codecTagString: '', hasBFrames: 0,
      hasAudio: false, audioCodec: '', sampleRate: 0, channels: 0,
      channelLayout: '', sampleFormat: '', audioProfile: '', audioTimeBase: '',
      containerFormat: '', videoTrackTimescale: 0, startTime: '0',
      isCFR: false, streamCount: 0,
      status: 'parsing',
    }))
    files.value.push(...pendingItems)

    // 逐个解析
    for (const item of pendingItems) {
      try {
        const param = await window.api.probeVideo(item.filePath)
        const idx = files.value.findIndex(f => f.id === item.id)
        if (idx >= 0) {
          files.value[idx] = { ...param, id: item.id, status: 'ready' }
        }
      } catch (err: any) {
        const idx = files.value.findIndex(f => f.id === item.id)
        if (idx >= 0) {
          files.value[idx].status = 'error'
          files.value[idx].errorMessage = err.message
        }
      }
    }
    recalcMajorityAlign()
    // 第一次添加文件时，把输出目录默认到源文件所在目录，省掉一次手动选择
    if (!outputDir.value && files.value.length) {
      outputDir.value = files.value[0].filePath.replace(/[\\/][^\\/]+$/, '')
    }
    refreshFreeSpace()
  }

  function removeFile(index: number) {
    files.value.splice(index, 1)
    recalcMajorityAlign()
  }

  function moveFile(from: number, to: number) {
    const item = files.value.splice(from, 1)[0]
    files.value.splice(to, 0, item)
    // 多数派平票时取第一个文件的值，所以重排会改变对齐基准，必须重算
    // （DESIGN §10.5：列表变化 → 重新计算多数派）
    recalcMajorityAlign()
  }

  function clearFiles() {
    files.value = []
    alignConfig.value = null
    recalcMajorityAlign()
  }

  // ===== 对齐操作 =====
  function setBaseFile(index: number) {
    // -1 = 自动（多数派）
    if (index < 0) { recalcMajorityAlign(); return }
    baseFileIndex.value = index
    if (index >= files.value.length) return
    const base = files.value[index]
    const result = {} as AlignConfig
    for (const { key } of COMPARE_DEFS) {
      // 基准文件没有音轨 → 音频参数用默认值，不把空编码/0 采样率带进对齐目标
      if (AUDIO_KEYS.includes(key as string) && !base.hasAudio) {
        ;(result as any)[key] = AUDIO_DEFAULTS[key]
        continue
      }
      if (BOOL_KEYS.includes(key as string)) {
        ;(result as any)[key] = !!base[key]
      } else if (NUM_KEYS.includes(key as string)) {
        ;(result as any)[key] = Number(base[key]) || 0
      } else {
        ;(result as any)[key] = String(base[key] ?? '')
      }
    }
    alignConfig.value = result
  }

  function setAlignTarget(key: string, value: string) {
    if (!alignConfig.value) return
    // 结构性字段由工具自动归一，不接受手动指定
    if (FIXED_KEYS.includes(key)) return
    if (BOOL_KEYS.includes(key)) {
      ;(alignConfig.value as any)[key] = value === 'true'
    } else if (NUM_KEYS.includes(key)) {
      ;(alignConfig.value as any)[key] = parseInt(value) || 0
    } else {
      ;(alignConfig.value as any)[key] = value
    }
  }

  // ===== 磁盘空间 =====
  async function refreshFreeSpace() {
    if (!outputDir.value) { freeSpace.value = 0; return }
    try {
      freeSpace.value = await window.api.getFreeSpace(outputDir.value)
    } catch { freeSpace.value = 0 }
  }

  // ===== 合并任务 =====

  /**
   * IPC 使用 V8 结构化克隆（ValueSerializer）序列化参数，而 Vue 的 reactive Proxy
   * 不在支持类型内 —— 直接把 store 里的对象丢给 ipcRenderer.invoke 会抛
   * "An object could not be cloned."。发送前必须先拍平成纯对象。
   */
  function toPlain<T>(value: T): T {
    return JSON.parse(JSON.stringify(value))
  }

  async function startMerge() {
    const task = snapshotCurrentTask()
    if (!task) {
      console.warn('[startMerge] blocked:', {
        canMerge: canMerge.value,
        hasAlign: !!alignConfig.value,
        files: files.value.length,
        outputDir: outputDir.value,
        outputName: outputName.value,
        taskStatus: taskStatus.value,
      })
      return
    }
    await dispatchTask(task)
  }

  // 把当前这一趟的完整配置冻结成一个任务对象（纯对象，可直接发 IPC）
  function snapshotCurrentTask(): MergeTask | null {
    if (!readyToStart.value || !alignConfig.value) return null
    return toPlain<MergeTask>({
      id: crypto.randomUUID(),
      files: files.value,
      alignConfig: alignConfig.value,
      outputFormat: outputFormat.value,
      quality: outputQuality.value,
      outputDir: outputDir.value,
      outputName: outputName.value.trim(),
    })
  }

  // 发一个任务给主进程，并等它真正结束（单次合并和队列都走这里）
  async function dispatchTask(task: MergeTask): Promise<MergeResult> {
    currentTaskId.value = task.id
    taskStatus.value = 'running'
    mergedFilePaths.value = task.files.map(f => f.filePath)
    progress.value = { taskId: task.id, phase: 'checking', percent: 0, stepText: '准备中…' }

    const done = new Promise<MergeResult>((resolve) => { taskWaiters.set(task.id, resolve) })

    try {
      await window.api.startMerge(task)
    } catch (err: any) {
      const msg = err?.message || String(err)
      console.error('[dispatchTask] IPC error:', err)
      taskStatus.value = 'error'
      progress.value = { taskId: task.id, phase: 'error', percent: 0, stepText: `启动失败：${msg}` }
      const r: MergeResult = {
        taskId: task.id, success: false, errorMessage: `无法启动合并任务：${msg}`,
        transcodedFiles: [], totalFiles: task.files.length,
      }
      lastResult.value = r
      settleWaiter(task.id, r)
    }
    return done
  }

  function cancelMerge() {
    if (queueRunning.value) queueCancelRequested = true
    if (currentTaskId.value) {
      window.api.cancelMerge(currentTaskId.value)
      taskStatus.value = 'idle'
      progress.value = null
    }
  }

  function resolveOutputExists(choice: 'overwrite'|'rename'|'cancel') {
    window.api.resolveOutputExists({ taskId: currentTaskId.value, choice })
    outputExistsInfo.value = null
  }

  // ===== 任务队列（v1.2）=====

  // 把当前这一趟冻结入队，并清空列表方便接着准备下一趟
  function enqueueCurrent() {
    const task = snapshotCurrentTask()
    if (!task) return
    queue.value.push({ ...task, status: 'waiting' })

    // 清空"这一趟"的东西；输出目录/格式/画质/删除开关保留，
    // 因为批量准备时通常沿用同一套输出设置
    files.value = []
    alignConfig.value = null
    baseFileIndex.value = -1
    outputName.value = ''
    taskStatus.value = 'idle'
    progress.value = null
    lastResult.value = null
    mergedFilePaths.value = []
  }

  function removeQueueItem(index: number) {
    if (queueRunning.value) return
    queue.value.splice(index, 1)
  }

  function moveQueueItem(from: number, to: number) {
    if (queueRunning.value) return
    if (from === to || to < 0 || to >= queue.value.length) return
    const item = queue.value.splice(from, 1)[0]
    queue.value.splice(to, 0, item)
  }

  function clearQueue() {
    if (queueRunning.value) return
    queue.value = []
    queueSummary.value = null
  }

  // 逐趟串行执行。单个任务失败**跳过继续**，跑完只弹一次汇总。
  async function startQueue() {
    if (queueRunning.value) return
    if (!queue.value.some(q => q.status !== 'done')) return

    queueRunning.value = true
    queueCancelRequested = false
    queueSummary.value = null
    // 重跑时把上次的失败状态清掉
    for (const q of queue.value) {
      if (q.status === 'error') { q.status = 'waiting'; q.errorMessage = undefined }
    }

    try {
      for (let i = 0; i < queue.value.length; i++) {
        const item = queue.value[i]
        if (item.status === 'done') continue
        if (queueCancelRequested) break

        queueIndex.value = i + 1
        item.status = 'running'
        const task = toPlain<MergeTask>({
          id: item.id,
          files: item.files,
          alignConfig: item.alignConfig,
          outputFormat: item.outputFormat,
          quality: item.quality,
          outputDir: item.outputDir,
          outputName: item.outputName,
        })
        const r = await dispatchTask(task)

        if (r.cancelled) {
          item.status = 'waiting'   // 没跑到，留在队列里下次还能跑
          queueCancelRequested = true
          break
        }
        if (r.success) {
          item.status = 'done'
          item.outputPath = r.outputPath
          item.outputSize = r.outputSize
          item.mergePath = r.mergePath
          item.escalated = r.escalated
        } else {
          item.status = 'error'
          item.errorMessage = r.errorMessage || '未知错误'
        }
      }
    } finally {
      queueRunning.value = false
      queueIndex.value = 0
      currentTaskId.value = ''
    }

    queueSummary.value = {
      total: queue.value.length,
      succeeded: queue.value.filter(q => q.status === 'done'),
      failed: queue.value.filter(q => q.status === 'error'),
      cancelled: queueCancelRequested,
    }
    queueCancelRequested = false
  }

  function dismissQueueSummary() { queueSummary.value = null }

  // 队列里成功跑完的任务，它们的源文件路径（供"合并后删除源文件"统一确认一次）。
  // 必须去重：同一批源文件可能被用于多个队列任务，重复的路径会让同一个文件被删两次，
  // 第二次必然失败，界面上就会弹出误导性的"部分源文件未能删除"。
  function queueSucceededSourcePaths(): string[] {
    const seen = new Set<string>()
    for (const q of queue.value) {
      if (q.status !== 'done') continue
      for (const f of q.files) seen.add(f.filePath)
    }
    return [...seen]
  }

  // ===== 初始化事件监听 =====
  // 全部 IPC 事件只在 store 里注册一次，UI 通过 watch 这些状态来响应，
  // 避免 store 和组件各注册一遍导致弹窗弹两次（见 LESSONS.md 第 2 条）。
  function initListeners() {
    if (listenersReady) return
    listenersReady = true

    // 事件是否有"等在它身上的任务"：取消后 currentTaskId 可能已被清空，
    // 但只要还有 waiter 就必须处理，否则队列会永远等下去。
    const isLive = (taskId: string) => taskId === currentTaskId.value || taskWaiters.has(taskId)

    window.api.onMergeProgress((p) => {
      if (p.taskId !== currentTaskId.value) return
      progress.value = p
    })

    window.api.onMergeComplete((r) => {
      if (!isLive(r.taskId)) return
      // 用户在「输出文件已存在」弹窗里选了取消，或合并被取消：静默回到空闲，不算失败
      if (r.cancelled) {
        taskStatus.value = 'idle'
        progress.value = null
        lastResult.value = null
        if (r.taskId === currentTaskId.value) currentTaskId.value = ''
        settleWaiter(r.taskId, r)
        return
      }
      taskStatus.value = r.success ? 'done' : 'error'
      lastResult.value = r
      progress.value = {
        taskId: r.taskId,
        phase: r.success ? 'done' : 'error',
        percent: r.success ? 100 : 0,
        stepText: r.success ? '完成' : '失败',
      }
      settleWaiter(r.taskId, r)
    })

    window.api.onMergeError((e) => {
      if (!isLive(e.taskId)) return
      taskStatus.value = 'error'
      progress.value = { taskId: e.taskId, phase: 'error', percent: 0, stepText: '失败' }
      const r: MergeResult = {
        taskId: e.taskId, success: false, errorMessage: e.message,
        transcodedFiles: [], totalFiles: 0,
      }
      lastResult.value = r
      settleWaiter(e.taskId, r)
    })

    window.api.onOutputExists((d) => {
      if (d.taskId !== currentTaskId.value) return
      outputExistsInfo.value = { path: d.path, taskId: d.taskId }
    })
  }

  // 完成后清空
  function resetAfterDone() {
    files.value = []
    alignConfig.value = null
    outputName.value = ''
    taskStatus.value = 'idle'
    progress.value = null
    lastResult.value = null
    outputExistsInfo.value = null
    currentTaskId.value = ''
    mergedFilePaths.value = []
    refreshFreeSpace()
  }

  return {
    files, alignConfig, baseFileIndex,
    outputFormat, outputQuality, outputName, outputDir, deleteSource,
    taskStatus, progress, lastResult, freeSpace, currentTaskId, outputExistsInfo, mergedFilePaths,
    paramDiffs, diffCount, hasDiff, canMerge, canEnqueue, readyToStart, busy,
    readinessMessage, estimatedSize,
    addFiles, removeFile, moveFile, clearFiles,
    setBaseFile, setAlignTarget, recalcMajorityAlign,
    refreshFreeSpace, startMerge, cancelMerge, resolveOutputExists,
    initListeners, resetAfterDone,
    // 队列
    queue, queueRunning, queueIndex, queueSummary,
    enqueueCurrent, removeQueueItem, moveQueueItem, clearQueue, startQueue,
    dismissQueueSummary, queueSucceededSourcePaths,
  }
})
