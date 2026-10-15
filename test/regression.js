/**
 * 反例回归
 *
 * 这 5 组是 2026-09-15 实测出来的真实反例，其中前 3 组曾经能骗过
 * "18 项参数比较"并产出坏文件（丢帧、音画偏差放大 2.5 倍、恒定帧率被破坏）。
 * 每次改动合并逻辑都要跑这一套：
 *   · REF / A / B 必须走**无损**路径（不许退化成转码，那等于白掉画质）
 *   · D3 / E 必须走转码
 *   · 全部必须通过产物校验
 */
const path = require('path')
const fs = require('fs')
const h = require('./helpers')

const CASES = [
  {
    id: 'REF', title: '健康对照（两个完全相同的文件）',
    files: ['base.mp4', 'base.mp4'], expectPath: 'direct',
    why: '参数完全一致应直接拼，零处理零损失',
  },
  {
    id: 'A', title: 'A 多一条音轨（流数量 2 → 3）',
    files: ['base.mp4', 'A_two_audio.mp4'], expectPath: 'remux',
    why: '丢多余流是无损操作，不该退化成转码',
  },
  {
    id: 'B', title: 'B 时间戳整体偏移 0.976 秒',
    files: ['base.mp4', 'B_start_offset.mp4'], expectPath: 'remux',
    why: '时间轴归零是无损操作，不该退化成转码',
  },
  {
    id: 'D3', title: 'D3 VFR 伪装成 CFR（可比字段全部抹平）',
    files: ['base.mp4', 'D3_vfr_clean.mp4'], expectPath: 'transcode',
    why: '帧时序改了比特流就变，只能重编码',
  },
  {
    id: 'E', title: 'E 分辨率 / 帧率 / 音轨有无全不同',
    files: ['m1_640x480_25fps_noaudio.mp4', 'm2_1280x720_30fps_aac48k_mono.mp4'], expectPath: 'transcode',
    why: '必须转码，且无音轨文件要被补上静音轨',
  },
]

async function run() {
  const rep = h.makeReporter('反例回归：参数比较 + 三级路径 + 产物校验闸门')
  h.resetTmp()

  for (const c of CASES) {
    const paths = c.files.map(h.fixture)
    const res = await h.mergePaths(c.id.toLowerCase(), paths, { name: 'out-' + c.id })
    const outPath = h.tmpFile('out-' + c.id + '.mp4')

    if (!res.success) {
      rep.check(`${c.title}`, false, (res.errorMessage || '').split('\n')[0])
      continue
    }

    const pathOk = res.mergePath === c.expectPath
    const verified = res.verified === true
    const o = fs.existsSync(outPath) ? h.probeOut(outPath) : null
    const layoutOk = o && o.layout === 'v+a'
    const avDelta = o && o.audio ? Math.abs(Number(o.audio.duration) - Number(o.video.duration)) : null

    rep.check(c.title, pathOk && verified && layoutOk,
      `路径=${res.mergePath}${pathOk ? '' : `（期望 ${c.expectPath}）`} 升级重拼=${!!res.escalated} 校验=${verified} 流=${o ? o.layout : 'n/a'}`)
    rep.note(c.why)
    if (res.verifyNotes && res.verifyNotes.length) rep.note(res.verifyNotes.join(' | '))
    if (avDelta !== null) rep.note(`音画时长差 ${(avDelta * 1000).toFixed(0)}ms`)
  }

  return rep
}

module.exports = { run }
