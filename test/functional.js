/**
 * 功能验证：边界路径与三种输出格式
 *
 * 这些用例覆盖的都是"主流程全绿但边界翻车"的地方 —— 历史上 mkv 输出
 * 曾被产物校验自己封死、单引号文件名会拼坏 concat 列表、输出名能目录穿越。
 * 主流程跑通不代表产品可用，必须把边界也钉住。
 */
const path = require('path')
const fs = require('fs')
const h = require('./helpers')
const { getFreeSpace, probeVideo } = require('../electron/ffmpeg.js')

async function run() {
  const rep = h.makeReporter('功能验证：输出格式 / 特殊文件名 / 异常输入 / 画质档位')
  h.resetTmp()
  const base = h.fixture('base.mp4')

  // 1. 磁盘空间：用 fs.statfs，不该再启动 PowerShell 子进程
  {
    const t0 = Date.now()
    const free = getFreeSpace(h.TMP)
    const ms = Date.now() - t0
    rep.check('磁盘空间查询（statfs，非子进程）', free > 1e9 && ms < 50, `${(free / 1e9).toFixed(1)} GB，耗时 ${ms}ms`)
  }

  // 2. mov 输出
  {
    const res = await h.mergePaths('mov', [base, base], { format: 'mov' })
    const out = h.tmpFile('mov.mov')
    if (!res.success) rep.check('mov 输出', false, (res.errorMessage || '').split('\n')[0])
    else {
      const o = h.probeOut(out)
      rep.check('mov 输出', o.format.includes('mov') && o.layout === 'v+a', `${o.format} 时长=${o.duration.toFixed(2)}s`)
      rep.note((res.verifyNotes || []).join(' | '))
    }
  }

  // 3. mkv 输出（帧数只能靠回退链估算 —— 这条曾经让 mkv 完全不可用）
  {
    const mkvSrc = h.tmpFile('src.mkv')
    h.ffmpeg(['-y', '-i', base, '-c', 'copy', mkvSrc])
    const res = await h.mergePaths('mkv', [mkvSrc, mkvSrc], { format: 'mkv' })
    const out = h.tmpFile('mkv.mkv')
    if (!res.success) rep.check('mkv 输出（帧数估算回退链）', false, (res.errorMessage || '').split('\n')[0])
    else {
      const o = h.probeOut(out)
      rep.check('mkv 输出（帧数估算回退链）', o.format.includes('matroska') && o.layout === 'v+a',
        `${o.format} 时长=${o.duration.toFixed(2)}s`)
      rep.note((res.verifyNotes || []).join(' | '))
    }
  }

  // 4. 文件名含单引号（concat 列表转义）
  {
    const weird = h.tmpFile("bad'name clip.mp4")
    fs.copyFileSync(base, weird)
    const res = await h.mergePaths('quote', [base, weird])
    rep.check('文件名含单引号', res.success === true,
      res.success ? `路径=${res.mergePath}，校验通过` : (res.errorMessage || '').split('\n')[0])
  }

  // 5. 源文件丢失 → 应该在动手前就报错
  {
    const real = await probeVideo(base)
    const ghost = { ...real, id: 'ghost', filePath: path.join(h.TMP, 'DOES_NOT_EXIST.mp4'), fileName: 'DOES_NOT_EXIST.mp4' }
    const res = await h.runTask('missing', [real, ghost], { name: 'missing' })
    rep.check('源文件丢失提前报错', res.success !== true && /不存在或不可访问/.test(res.errorMessage || ''),
      (res.errorMessage || '').split('\n')[0])
  }

  // 6. 输出目录不存在 → 同样提前报错
  {
    const res = await h.runTask('baddir', [await probeVideo(base), await probeVideo(base)],
      { outDir: path.join(h.TMP, 'no_such_dir'), name: 'baddir' })
    rep.check('输出目录无效提前报错', res.success !== true && /输出目录不存在/.test(res.errorMessage || ''),
      res.errorMessage || '')
  }

  // 7. 输出名净化（防目录穿越）
  {
    const res = await h.mergePaths('escape', [base, base], { name: '..\\..\\evil' })
    const inTmp = fs.readdirSync(h.TMP).filter((f) => f.includes('evil'))
    const escaped = fs.existsSync(path.join(h.PROJ, 'evil.mp4')) || fs.existsSync(path.join(h.TMP, '..', '..', 'evil.mp4'))
    rep.check('输出名净化（防目录穿越）', !escaped && inTmp.length > 0 && res.success === true,
      inTmp.length ? `落在输出目录：${inTmp.join(', ')}` : '未在输出目录找到产物')
  }

  // 8. 画质档位是否真的传到 ffmpeg（低档应明显更小）
  {
    const m1 = h.fixture('m1_640x480_25fps_noaudio.mp4')
    const m2 = h.fixture('m2_1280x720_30fps_aac48k_mono.mp4')
    const sizes = {}
    for (const q of ['high', 'low']) {
      const res = await h.mergePaths('q' + q, [m1, m2], { quality: q, name: 'q-' + q })
      sizes[q] = res.success ? fs.statSync(h.tmpFile('q-' + q + '.mp4')).size : null
    }
    const ok = sizes.high && sizes.low && sizes.low < sizes.high
    rep.check('画质档位真实生效', ok, ok
      ? `高=${(sizes.high / 1024).toFixed(0)}KB  低=${(sizes.low / 1024).toFixed(0)}KB（低档小 ${((1 - sizes.low / sizes.high) * 100).toFixed(0)}%）`
      : JSON.stringify(sizes))
  }

  // 9. 剩余时间估算：不该出现离谱值（旧版会算出"十几小时"）
  //    短任务刻意不给估算 —— 样本不足时宁可不显示，也不给一个错的（详见 unit 套件）
  {
    const m1 = h.fixture('m1_640x480_25fps_noaudio.mp4')
    const m2 = h.fixture('m2_1280x720_30fps_aac48k_mono.mp4')
    const seen = []
    const t0 = Date.now()
    const res = await h.mergePaths('eta', [m1, m2], {
      name: 'eta',
      onProgress: (p) => {
        if (p.remainingSeconds !== undefined) {
          seen.push({ pct: p.percent, eta: p.remainingSeconds, at: (Date.now() - t0) / 1000 })
        }
      },
    })
    // 离谱 = 非有限数 / 负数 / 超过「已用时间 × 20 + 60 秒」
    const absurd = seen.filter((s) => !Number.isFinite(s.eta) || s.eta < 0 || s.eta > s.at * 20 + 60)
    rep.check('剩余时间估算不出现离谱值',
      res.success === true && absurd.length === 0,
      seen.length
        ? `${seen.length} 次估算，例：${seen.slice(0, 3).map((s) => `${s.pct}%→${Math.round(s.eta)}s`).join('  ')}`
        : '小任务样本不足，未给估算（刻意行为，见 unit 套件）')
  }

  // 10. 23.976 + timescale 90000 —— 文档里的核心坑
  // 《视频转码对齐经验教训》教训 3：一帧 = 90000×1001/24000 = 3753.75 tick（非整数），
  // 时间戳只能取整 → 平均帧率永远对不齐（实测会变成 1430000/59643 这种分数）。
  // 正确做法是把容器时间刻度换成可整除的值（23.976 → 24000）。
  {
    const nt = h.fixture('nt23976_ts90000.mp4')
    const src = h.ffprobeJson(nt)
    const sv = src.streams.find((s) => s.codec_type === 'video')

    // 先确认素材确实是病态组合
    rep.check('素材确为 23.976 + time_base 1/90000',
      sv.r_frame_rate === '24000/1001' && sv.time_base === '1/90000',
      `r=${sv.r_frame_rate} tb=${sv.time_base} avg=${sv.avg_frame_rate}`)

    const res = await h.mergePaths('nt', [nt, nt], { name: 'nt' })
    const out = h.tmpFile('nt.mp4')
    if (!res.success) rep.check('23.976 自动换用可整除时间刻度', false, (res.errorMessage || '').split('\n')[0])
    else {
      const o = h.probeOut(out)
      const tb = o.video ? o.video.time_base : ''
      const avg = o.video ? o.video.avg_frame_rate : ''
      rep.check('23.976 自动换用可整除时间刻度', tb === '1/24000',
        `输出 time_base=${tb}（期望 1/24000）平均帧率=${avg} 路径=${res.mergePath}`)
      rep.note((res.verifyNotes || []).join(' | '))
    }
  }

  // 11. 日志落盘（v1.3 新增）：以前完全不落盘，出问题双方都是瞎子
  {
    const { getLogDir } = require('../electron/logger.js')
    const dir = getLogDir()
    const files = dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.log')) : []
    const newest = files
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0]
    const content = newest ? fs.readFileSync(path.join(dir, newest.f), 'utf8') : ''

    rep.check('每次合并都写了日志文件', files.length > 0 && content.length > 0,
      dir ? `${files.length} 个日志，最新 ${newest.f}（${content.length} 字节）` : '日志目录未初始化')
    rep.check('日志里有源文件清单', /\[0\]/.test(content) && content.includes('.mp4'), '')
    rep.check('日志里有每个文件的处理决定（direct/remux/transcode）',
      content.includes('→ direct') || content.includes('→ remux') || content.includes('→ transcode'),
      (content.match(/→ \w+/g) || []).slice(0, 3).join('  '))
    rep.check('日志里有实际执行的 ffmpeg 命令（排查时最有用）',
      content.includes('[cmd:'), (content.match(/\[cmd:[^\]]+\]/g) || []).slice(0, 3).join('  '))
    rep.check('日志里有产物校验结论', content.includes('产物校验'),
      (content.split('\n').filter((l) => l.trim().endsWith('✓')).slice(0, 2).join(' | ')))
  }

  // 12. 两种"失败"必须分开处理
  //   · 校验未通过 → 产物是完整的，保留给用户自己确认
  //   · 执行失败（ffmpeg 中途退出）→ 产物根本没写完，必须删掉，否则会被当成成品
  {
    const full = h.fixture('base.mp4')
    const mid = h.tmpFile('mid.mp4')
    const broken = h.tmpFile('broken.mp4')
    // moov 放到文件头，再截掉一半 —— 模拟"下载了一半"的文件：
    // ffprobe 能读出参数，但数据不全，拼的时候 ffmpeg 会失败
    h.ffmpeg(['-y', '-i', full, '-c', 'copy', '-movflags', '+faststart', mid])
    const buf = fs.readFileSync(mid)
    fs.writeFileSync(broken, buf.subarray(0, Math.floor(buf.length * 0.6)))

    const outPath = h.tmpFile('broken-out.mp4')
    fs.rmSync(outPath, { force: true })
    const res = await h.mergePaths('broken', [broken, full], { name: 'broken-out' })
    const msg = res.errorMessage || ''

    if (res.success) {
      rep.note('残缺源文件这次仍合并成功，未走到失败分支')
    } else if (/产物校验未通过/.test(msg)) {
      // 校验没过 = 文件是完整的，保留给用户自己判断（这是刻意行为）
      const kept = fs.existsSync(outPath)
      rep.check('【校验失败】产物完整，保留不删、并在提示里说清位置',
        kept && /文件已保留在/.test(msg),
        `产物存在=${kept} ｜ ${msg.split('\n').find((l) => l.includes('文件已保留在')) || msg.split('\n')[0]}`)
    } else {
      // 执行失败 = 文件根本没写完，必须删掉
      const gone = !fs.existsSync(outPath)
      rep.check('【执行失败】残缺产物已删除，不会留给用户当成品',
        gone && /已自动删除残缺文件/.test(msg),
        `产物存在=${!gone} ｜ ${msg.split('\n')[0]}`)
    }
  }

  return rep
}

module.exports = { run }
