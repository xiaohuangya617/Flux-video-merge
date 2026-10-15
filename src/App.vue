<template>
  <div class="wrap">
    <!-- 头部 -->
    <div class="head">
      <div class="head-l">
        <div class="logo">拼</div>
        <div>
          <h1>视频拼接器</h1>
          <div class="sub">无损剪辑 · 参数对齐 · 批量合并</div>
        </div>
      </div>
      <span class="tag">v1.3.1</span>
    </div>

    <!-- ① 添加视频 -->
    <div class="card" style="display:flex;align-items:center;justify-content:space-between">
      <p class="st" style="margin:0">① 添加视频</p>
      <div class="add-hint">
        <span class="add-tip">可将 mp4 / mkv / mov 文件或文件夹拖入窗口任意位置</span>
        <button class="btn-ghost" @click="handleSelectFolder" :disabled="store.taskStatus==='running'">选文件夹</button>
        <button class="btn-add" @click="handleSelectFiles" title="选择文件批量添加">＋</button>
      </div>
    </div>

    <!-- 拖拽遮罩 -->
    <div class="drop-mask" :class="{ show: dragOver }">
      <div class="drop-mask-inner">松开鼠标，添加视频</div>
    </div>

    <!-- ② 视频列表 -->
    <div class="card">
      <div class="list-head">
        <p class="st" style="margin:0">② 视频列表</p>
        <button class="btn-ghost" @click="store.clearFiles()" :disabled="store.taskStatus==='running'">清空</button>
      </div>
      <div style="overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th class="grip-th"></th>
              <th style="width:44px">序号</th>
              <th class="fname-th">文件名</th>
              <th class="fix-w">大小</th>
              <th style="width:70px">时长</th>
              <th style="width:100px">分辨率</th>
              <th style="width:70px">状态</th>
              <th style="width:110px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(f, i) in store.files" :key="f.id" :class="{ 'drag-src': dragFrom === i }"
              @dragover.prevent="onRowDragOver($event, i)" @drop.prevent="onRowDrop(i)">
              <td class="grip" draggable="true" @dragstart="onDragStart($event, i)" @dragend="onDragEnd" title="按住拖动排序">⠿</td>
              <td>{{ i + 1 }}</td>
              <td class="fname">
                <div class="fname-scroll" :title="f.fileName" @click="copyFileName($event, f.fileName)">{{ f.fileName }}</div>
              </td>
              <td>{{ fmtSize(f.fileSize) }}</td>
              <td>{{ fmtDuration(f.duration) }}</td>
              <td>{{ f.width }}×{{ f.height }}</td>
              <td>
                <span class="badge" :class="statusClass(f.status)">{{ statusLabel(f.status) }}</span>
              </td>
              <td>
                <button class="rb" @click="store.moveFile(i, i-1)" :disabled="i===0 || store.taskStatus==='running'">↑</button>
                <button class="rb" @click="store.moveFile(i, i+1)" :disabled="i===store.files.length-1 || store.taskStatus==='running'">↓</button>
                <button class="rb" @click="store.removeFile(i)" :disabled="store.taskStatus==='running'">×</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="empty" v-if="!store.files.length">尚未添加视频——可拖入窗口任意位置，或点击右上角加号选择文件</div>
    </div>

    <!-- ③ 参数对齐（折叠） -->
    <div class="card" v-if="store.files.length >= 2">
      <p class="st">③ 参数对齐</p>
      <div class="align-collapse-bar">
        <div class="align-summary">
          <span v-if="store.hasDiff" class="diff-badge">检测到 {{ store.diffCount }} 处参数差异</span>
          <span v-else class="ok-badge">所有参数一致，可无损合并</span>
        </div>
        <button class="btn-toggle" @click="alignOpen = !alignOpen">{{ alignOpen ? '收起 ▴' : '展开详情 ▾' }}</button>
      </div>
      <div class="align-target-row">
        <label>基准文件</label>
        <select :value="store.baseFileIndex" :disabled="running"
          @change="store.setBaseFile(Number(($event.target as HTMLSelectElement).value))">
          <option :value="-1">自动（多数派）</option>
          <option v-for="(f, i) in store.files" :key="f.id" :value="i">第{{ i+1 }}个文件（{{ f.fileName }}）</option>
        </select>
        <span class="align-hint">默认按多数派自动对齐；选定某个文件后，所有差异项对齐到它</span>
      </div>
      <div class="align-detail" :class="{ open: alignOpen }">
        <div style="overflow-x:auto;margin-top:12px">
          <table class="align-table">
            <thead>
              <tr>
                <th style="width:32px"></th>
                <th style="width:110px">参数</th>
                <th>各文件取值</th>
                <th style="width:160px">对齐目标</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in store.paramDiffs" :key="d.key" :class="{ diff: d.isDifferent }">
                <td>
                  <span v-if="d.isDifferent" class="align-icon warn">⚠</span>
                  <span v-else class="align-icon ok">✓</span>
                </td>
                <td><b>{{ d.label }}</b></td>
                <td class="align-values">
                  <template v-for="(v, vi) in d.values" :key="vi">
                    <span v-if="vi > 0" style="color:#c9d9ee"> / </span>
                    <span :class="{ 'diff-val': d.isDifferent }">{{ v }}</span>
                  </template>
                </td>
                <td>
                  <span v-if="!d.isDifferent" class="align-tag ok">一致</span>
                  <span v-else-if="d.fixed" class="align-tag auto" title="结构性差异，由工具自动归一（时间轴归零 / 丢弃多余流 / 转恒定帧率）">自动归一</span>
                  <select v-else
                    :value="d.alignTarget" :disabled="running"
                    @change="store.setAlignTarget(d.key, ($event.target as HTMLSelectElement).value)"
                    style="width:150px;height:30px;font-size:12px">
                    <option v-for="uv in d.uniqueValues" :key="uv" :value="uv">{{ uv }}</option>
                  </select>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ④ 输出设置 -->
    <div class="card">
      <p class="st">④ 输出设置</p>
      <div class="cfg">
        <div class="citem grow" style="flex-basis:100%">
          <label>输出文件名</label>
          <input v-model="store.outputName" :disabled="running" placeholder="merged_video" style="width:100%">
        </div>
        <div class="cfg-row">
          <div class="citem grow">
            <label>输出目录</label>
            <div style="display:flex;gap:8px">
              <input v-model="store.outputDir" :disabled="running" style="flex:1;min-width:240px" @change="store.refreshFreeSpace()">
              <button class="btn-ghost" :disabled="running" @click="handleSelectOutputDir">浏览</button>
            </div>
          </div>
          <div class="citem">
            <label>输出格式</label>
            <select v-model="store.outputFormat" :disabled="running" style="width:120px">
              <option value="mp4">MP4</option>
              <option value="mkv">MKV</option>
              <option value="mov">MOV</option>
            </select>
          </div>
          <div class="citem">
            <label>转码画质</label>
            <select v-model="store.outputQuality" :disabled="running" style="width:100px">
              <option value="high">高</option>
              <option value="medium">中</option>
              <option value="low">低</option>
            </select>
          </div>
          <div class="citem">
            <label>合并后删除源文件</label>
            <div class="sw">
              <input type="checkbox" id="delSrc" v-model="store.deleteSource" :disabled="running">
              <label class="swbox" for="delSrc"></label>
              <span class="swtxt">{{ store.deleteSource ? '开' : '关' }}</span>
            </div>
          </div>
          <div class="foot-actions">
            <button class="btn-pri" :disabled="!store.canMerge" @click="handleStartMerge">▶ 开始合并</button>
            <button class="btn-ghost" :disabled="!store.canEnqueue" @click="store.enqueueCurrent()"
              title="把这一趟存进任务队列，稍后统一执行">进入队列</button>
            <button class="btn-ghost" v-if="store.busy" @click="store.cancelMerge()">取消</button>
          </div>
        </div>
        <div class="bar">
          <div class="pbar"><div class="pfill" :style="{ width: (store.progress?.percent || 0) + '%' }"></div></div>
          <span class="pct">{{ store.progress?.percent || 0 }}%</span>
          <span class="status">{{ store.progress?.stepText || '就绪' }}</span>
          <span class="eta" v-if="etaText">{{ etaText }}</span>
        </div>
        <div class="queue-now" v-if="store.queueRunning">
          队列执行中：第 {{ store.queueIndex }} / {{ store.queue.length }} 趟 · 共 {{ store.queue.filter(q => q.status === 'done').length }} 趟已完成
        </div>
        <div class="space-info" :class="{ ok: store.canMerge, bad: store.files.length>=2 && !store.canMerge && store.readinessMessage.includes('空间') }">
          {{ store.readinessMessage }}
          <template v-if="store.files.length >= 2"> ｜ 预计需要 {{ fmtSize(store.estimatedSize) }}</template>
          <template v-if="store.freeSpace > 0"> ｜ 当前可用 {{ fmtSize(store.freeSpace) }}</template>
        </div>
      </div>
    </div>
  </div>

  <!-- ⑤ 任务队列（有内容时才显示） -->
  <div class="card" v-if="store.queue.length">
    <div class="list-head">
      <p class="st" style="margin:0">⑤ 任务队列</p>
      <div class="q-actions">
        <span class="q-hint">队列里的参数已冻结，不可修改</span>
        <button class="btn-ghost" :disabled="store.busy" @click="store.clearQueue()">清空队列</button>
        <button class="btn-pri" :disabled="store.busy || !hasRunnable" @click="store.startQueue()">▶ 开始队列</button>
      </div>
    </div>
    <div style="overflow-x:auto">
      <table class="queue-table">
        <thead>
          <tr>
            <th style="width:44px">序号</th>
            <th>任务</th>
            <th style="width:70px">文件数</th>
            <th style="width:160px">输出文件名</th>
            <th style="width:80px">画质</th>
            <th style="width:90px">状态</th>
            <th style="width:110px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(q, i) in store.queue" :key="q.id" :class="{ 'q-row-running': q.status === 'running' }">
            <td>{{ i + 1 }}</td>
            <td class="q-name" :title="q.files.map(f => f.fileName).join('\n')">
              {{ q.files[0]?.fileName }}<span v-if="q.files.length > 1" class="q-more"> 等 {{ q.files.length }} 个</span>
            </td>
            <td>{{ q.files.length }}</td>
            <td class="q-out">{{ q.outputName }}.{{ q.outputFormat }}</td>
            <td>{{ qualityLabel(q.quality) }}</td>
            <td><span class="badge" :class="queueStatusClass(q.status)">{{ queueStatusLabel(q.status) }}</span></td>
            <td>
              <button class="rb" :disabled="store.busy || i === 0" @click="store.moveQueueItem(i, i - 1)">↑</button>
              <button class="rb" :disabled="store.busy || i === store.queue.length - 1" @click="store.moveQueueItem(i, i + 1)">↓</button>
              <button class="rb" :disabled="store.busy" @click="store.removeQueueItem(i)">×</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- 弹窗：输出文件已存在 -->
  <div class="modal-mask" :class="{ show: showOutputExists }">
    <div class="modal" style="width:520px">
      <h3>输出文件已存在</h3>
      <div class="modal-body">
        <p style="color:#5a7184;margin-bottom:10px">目标位置已有同名文件。建议生成新名称，避免覆盖原内容。</p>
        <div style="border:1px solid #F09595;background:#FCEBEB;border-radius:8px;padding:8px 12px">
          <div style="font-family:Consolas,monospace;color:#791F1F">{{ outputExistsPath }}</div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn-ghost" @click="handleOutputExists('cancel')">取消任务</button>
        <button class="btn-danger" @click="handleOutputExists('overwrite')">覆盖已有文件</button>
        <button class="btn-pri" @click="handleOutputExists('rename')">生成新名称</button>
      </div>
    </div>
  </div>

  <!-- 弹窗：完成报告 -->
  <div class="modal-mask" :class="{ show: showDone }">
    <div class="modal" style="width:520px">
      <h3>合并完成</h3>
      <div class="modal-body">
        <div class="stat-line"><span>输出文件</span><b>{{ store.lastResult?.outputPath }}</b></div>
        <div class="stat-line"><span>合并文件数</span><b>{{ store.lastResult?.totalFiles }} 个</b></div>
        <div class="stat-line"><span>输出大小</span><b>{{ fmtSize(store.lastResult?.outputSize || 0) }}</b></div>
        <div class="stat-line" v-if="store.lastResult?.mergePath">
          <span>拼接方式</span><b>{{ pathLabel(store.lastResult) }}</b>
        </div>
        <div class="stat-line" v-if="store.lastResult?.transcodedFiles?.length">
          <span>转码文件</span><b>{{ store.lastResult.transcodedFiles.length }} 个</b>
        </div>
        <p style="margin-top:10px;font-size:12px;color:#5a7184">提示：本次输出文件与原视频保持独立，原文件未被改动。</p>
      </div>
      <div class="modal-foot">
        <button class="btn-ghost" @click="handleOpenOutputFolder">打开输出目录</button>
        <button class="btn-pri" @click="handleCloseDone">知道了</button>
      </div>
    </div>
  </div>

  <!-- 弹窗：队列汇总（队列跑完只弹一次） -->
  <div class="modal-mask" :class="{ show: showQueueSummary }">
    <div class="modal" style="width:580px">
      <h3>队列执行完成</h3>
      <div class="modal-body">
        <div class="stat-line"><span>任务总数</span><b>{{ store.queueSummary?.total }} 个</b></div>
        <div class="stat-line"><span>成功</span><b style="color:#1E6B3A">{{ store.queueSummary?.succeeded.length }} 个</b></div>
        <div class="stat-line" v-if="store.queueSummary?.failed.length">
          <span>失败</span><b style="color:#A32D2D">{{ store.queueSummary?.failed.length }} 个</b>
        </div>
        <div class="stat-line" v-if="store.queueSummary?.cancelled">
          <span>状态</span><b style="color:#8A4B08">已被取消，剩余任务未执行</b>
        </div>
        <div class="q-results" v-if="store.queueSummary?.succeeded.length">
          <div v-for="q in store.queueSummary.succeeded" :key="q.id" class="q-result">
            <span class="q-result-name">{{ q.outputName }}.{{ q.outputFormat }}</span>
            <span class="q-result-path" :title="q.outputPath">{{ q.outputPath }}</span>
          </div>
        </div>
        <div class="q-results" v-if="store.queueSummary?.failed.length">
          <div v-for="q in store.queueSummary.failed" :key="q.id" class="q-result q-result-fail">
            <span class="q-result-name">{{ q.outputName }}.{{ q.outputFormat }}</span>
            <span class="q-result-path">{{ q.errorMessage }}</span>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn-ghost" :disabled="!store.queueSummary?.succeeded.length" @click="handleOpenQueueFolder">打开输出目录</button>
        <button class="btn-pri" @click="handleCloseQueueSummary">知道了</button>
      </div>
    </div>
  </div>

  <!-- 弹窗：删除源文件确认 -->
  <div class="modal-mask" :class="{ show: showDeleteConfirm }">
    <div class="modal" style="width:520px">
      <h3>删除源文件</h3>
      <div class="modal-body">
        <p style="color:#5a7184;margin-bottom:10px">以下源视频已合并完成。是否将其移入回收站？</p>
        <div style="border:1px solid #c9d9ee;background:#F0F6FF;border-radius:8px;padding:8px 12px">
          <div class="del-list">
            <div v-for="name in pendingDeleteNames" :key="name">{{ name }}</div>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn-ghost" @click="handleDeleteConfirm(false)">保留</button>
        <button class="btn-danger" @click="handleDeleteConfirm(true)">删除</button>
      </div>
    </div>
  </div>

  <!-- 弹窗：通用提示 -->
  <div class="modal-mask" :class="{ show: showMsg }">
    <div class="modal" style="width:480px">
      <h3>{{ msgTitle }}</h3>
      <div class="modal-body" v-html="msgBody"></div>
      <div class="modal-foot">
        <button class="btn-pri" @click="showMsg = false">知道了</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useVideoStore } from '@/stores/video'
import type { MergeResult } from '@/types'

const store = useVideoStore()

// 任务进行中：输入项一律禁用，避免"改了但没生效"的误解
const running = computed(() => store.taskStatus === 'running')

// ===== UI 状态 =====
const alignOpen = ref(false)
const dragOver = ref(false)
const dragFrom = ref(-1)
const dragTarget = ref(-1)
const dragPos = ref<'before'|'after'>('before')

const showOutputExists = ref(false)
const outputExistsPath = ref('')
const showDone = ref(false)
const showDeleteConfirm = ref(false)
const pendingDeleteNames = ref<string[]>([])
const pendingDeletePaths = ref<string[]>([])
const showQueueSummary = ref(false)
const showMsg = ref(false)
const msgTitle = ref('')
const msgBody = ref('')

const hasRunnable = computed(() => store.queue.some(q => q.status !== 'done'))

function qualityLabel(q: string) {
  return { high: '高', medium: '中', low: '低' }[q] || q
}
function queueStatusLabel(s: string) {
  return { waiting: '等待中', running: '进行中', done: '已完成', error: '失败' }[s] || s
}
function queueStatusClass(s: string) {
  if (s === 'error') return 'bad'
  if (s === 'waiting') return 'pending'
  if (s === 'running') return 'run'
  return ''
}

let dragDepth = 0

// ===== 格式化 =====
function fmtSize(b: number) {
  if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB'
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB'
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB'
  return b + ' B'
}

function fmtDuration(s: number) {
  if (!s) return '—'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
}

function statusLabel(s: string) {
  return { pending: '待检查', parsing: '解析中', ready: '就绪', error: '解析失败' }[s] || s
}
function statusClass(s: string) {
  if (s === 'ready') return ''
  if (s === 'error') return 'bad'
  return 'pending'
}

// 剩余时间估算：只在任务进行中、且估算值合理时显示
const etaText = computed(() => {
  const p = store.progress
  if (store.taskStatus !== 'running' || !p || p.remainingSeconds === undefined) return ''
  const s = Math.round(p.remainingSeconds)
  if (!Number.isFinite(s) || s < 3) return ''
  if (s < 60) return `预计剩余 ${s} 秒`
  const m = Math.floor(s / 60), r = s % 60
  if (m < 60) return `预计剩余 ${m} 分${r ? ' ' + r + ' 秒' : ''}`
  return `预计剩余 ${Math.floor(m / 60)} 小时 ${m % 60} 分`
})

// 完成弹窗里的「拼接方式」一行字
function pathLabel(r: MergeResult | null) {
  if (!r) return ''
  if (r.mergePath === 'direct') return '无损直接拼接 · 已校验'
  if (r.mergePath === 'remux') return '无损规整后拼接 · 已校验'
  if (r.mergePath === 'transcode') {
    return r.escalated ? '无损未通过校验，已自动转码 · 已校验' : '转码对齐后拼接 · 已校验'
  }
  return ''
}

// ===== 文件选择 =====
async function handleSelectFiles() {
  const paths = await window.api.selectFiles()
  if (paths.length) store.addFiles(paths)
}

// 选文件夹：递归扫描其中的视频（DESIGN §1.2 / §10.1 决策4）
async function handleSelectFolder() {
  const dir = await window.api.selectFolder()
  if (!dir) return
  const paths = await window.api.scanPaths([dir])
  if (paths.length) {
    store.addFiles(paths)
  } else {
    showDialog('没有找到视频', '该文件夹及其子文件夹里没有 mp4 / mkv / mov 文件。')
  }
}

async function handleSelectOutputDir() {
  const dir = await window.api.selectOutputDir()
  if (dir) {
    store.outputDir = dir
    store.refreshFreeSpace()
  }
}

// ===== 全局拖拽 =====
function hasFiles(e: DragEvent) {
  return e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
}

function onDragEnter(e: DragEvent) {
  if (hasFiles(e)) { e.preventDefault(); dragDepth++; dragOver.value = true }
}
function onDragOver(e: DragEvent) {
  if (hasFiles(e)) e.preventDefault()
}
function onDragLeave(e: DragEvent) {
  if (!hasFiles(e)) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragOver.value = false
}
async function onDrop(e: DragEvent) {
  if (hasFiles(e)) e.preventDefault()
  dragDepth = 0; dragOver.value = false
  const files = Array.from(e.dataTransfer?.files || [])
  const rawPaths = files.map((f: any) => f.path).filter(Boolean)
  if (!rawPaths.length) return
  const videoPaths = await window.api.scanPaths(rawPaths)
  if (videoPaths.length) store.addFiles(videoPaths)
}

// ===== 行拖拽排序 =====
function onDragStart(e: DragEvent, index: number) {
  if (store.taskStatus === 'running') { e.preventDefault(); return }
  dragFrom.value = index
  e.dataTransfer?.setData('text/plain', String(index))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}
function onRowDragOver(e: DragEvent, index: number) {
  if (dragFrom.value < 0) return
  e.preventDefault()
  const tr = (e.target as HTMLElement).closest('tr')
  if (!tr) return
  const rect = tr.getBoundingClientRect()
  const before = (e.clientY - rect.top) < rect.height / 2
  dragTarget.value = index
  dragPos.value = before ? 'before' : 'after'
  tr.classList.remove('drop-before', 'drop-after')
  tr.classList.add(before ? 'drop-before' : 'drop-after')
}
function onRowDrop(index: number) {
  if (dragFrom.value < 0) return
  if (dragTarget.value !== dragFrom.value) {
    let at = dragPos.value === 'before' ? dragTarget.value : dragTarget.value + 1
    if (dragFrom.value < at) at--
    store.moveFile(dragFrom.value, at)
  }
  onDragEnd()
}
function onDragEnd() {
  dragFrom.value = -1
  dragTarget.value = -1
  // 清除指示线
  document.querySelectorAll('.drop-before, .drop-after').forEach(el => {
    el.classList.remove('drop-before', 'drop-after')
  })
}

// ===== 点击复制 =====
function copyFileName(e: Event, name: string) {
  const el = e.target as HTMLElement
  const base = name.replace(/\.(mp4|mkv|mov|webm|avi|flv|wmv)$/i, '')
  navigator.clipboard?.writeText(base).then(() => {
    el.classList.add('copied')
    setTimeout(() => el.classList.remove('copied'), 1500)
  }).catch(() => {
    // 降级
    const ta = document.createElement('textarea')
    ta.value = base
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
    el.classList.add('copied')
    setTimeout(() => el.classList.remove('copied'), 1500)
  })
}

// ===== 合并 =====
function handleStartMerge() {
  store.startMerge()
}

function handleOutputExists(choice: 'overwrite'|'rename'|'cancel') {
  showOutputExists.value = false
  store.resolveOutputExists(choice)
}

function handleOpenOutputFolder() {
  if (store.lastResult?.outputPath) {
    const dir = store.lastResult.outputPath.replace(/[\\/][^\\/]+$/, '')
    window.api.openFolder(dir)
  }
}

function handleCloseDone() {
  showDone.value = false
  // 如果开了删除源文件
  if (store.deleteSource && store.lastResult?.success) {
    // 用本次合并真正用到的文件快照，而不是实时列表
    const paths = [...store.mergedFilePaths]
    pendingDeletePaths.value = paths
    pendingDeleteNames.value = paths.map(p => p.split(/[\\/]/).pop() || p)
    showDeleteConfirm.value = true
  } else {
    store.resetAfterDone()
  }
}

// 队列跑完后：如有成功任务且开了删除源文件，统一确认一次
function handleCloseQueueSummary() {
  showQueueSummary.value = false
  const paths = store.deleteSource && (store.queueSummary?.succeeded.length || 0) > 0
    ? store.queueSucceededSourcePaths()
    : []
  store.dismissQueueSummary()
  if (paths.length) {
    pendingDeletePaths.value = paths
    pendingDeleteNames.value = paths.map(p => p.split(/[\\/]/).pop() || p)
    showDeleteConfirm.value = true
  }
}

function handleOpenQueueFolder() {
  const first = store.queueSummary?.succeeded[0]?.outputPath
  if (first) window.api.openFolder(first.replace(/[\\/][^\\/]+$/, ''))
}

function handleDeleteConfirm(confirm: boolean) {
  showDeleteConfirm.value = false
  // resetAfterDone 会清空列表，先把清单取出来
  const paths = [...pendingDeletePaths.value]

  if (!confirm) {
    pendingDeletePaths.value = []
    store.resetAfterDone()
    return
  }
  if (paths.length === 0) {
    showDialog('没有可删除的文件', '本次合并的源文件清单为空，未执行删除。')
    pendingDeletePaths.value = []
    store.resetAfterDone()
    return
  }

  window.api.trashFiles(paths).then((res) => {
    if (res.failed.length) {
      showDialog('部分源文件未能删除',
        `成功移入回收站 ${res.ok.length} 个，失败 ${res.failed.length} 个：\n` +
        res.failed.map(f => `${f.path}\n  → ${f.error}`).join('\n'))
    } else {
      showDialog('删除完成', `已将 ${res.ok.length} 个源视频移入回收站（可从回收站还原）`)
    }
    pendingDeletePaths.value = []
    store.resetAfterDone()
  }).catch((err: any) => {
    showDialog('删除失败', err?.message || String(err))
    pendingDeletePaths.value = []
    store.resetAfterDone()
  })
}

function escapeHtml(s: string) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c])
}

function showDialog(title: string, body: string) {
  msgTitle.value = title
  msgBody.value = escapeHtml(body).replace(/\n/g, '<br>')
  showMsg.value = true
}

// ===== 生命周期 =====
onMounted(() => {
  document.addEventListener('dragenter', onDragEnter)
  document.addEventListener('dragover', onDragOver)
  document.addEventListener('dragleave', onDragLeave)
  document.addEventListener('drop', onDrop)

  // IPC 事件统一在 store 里注册一次，这里只 watch 状态
  store.initListeners()
})

// 输出文件已存在 → 弹窗等用户选择
watch(() => store.outputExistsInfo, (info) => {
  if (!info) return
  outputExistsPath.value = info.path
  showOutputExists.value = true
})

// 任务结束 → 成功弹完成报告，失败弹错误
// 队列运行期间不弹：每趟都弹一次会很吵，队列跑完统一弹汇总
watch(() => store.lastResult, (r) => {
  if (!r) return
  if (store.queueRunning) return
  if (r.success) {
    showDone.value = true
  } else if (r.errorMessage) {
    showDialog('出错了', r.errorMessage)
  }
})

// 队列跑完 → 弹一次汇总
watch(() => store.queueSummary, (s) => {
  if (s) showQueueSummary.value = true
})

onUnmounted(() => {
  document.removeEventListener('dragenter', onDragEnter)
  document.removeEventListener('dragover', onDragOver)
  document.removeEventListener('dragleave', onDragLeave)
  document.removeEventListener('drop', onDrop)
})
</script>
