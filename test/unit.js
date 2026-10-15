/**
 * 纯函数单元测试（不跑 ffmpeg，秒出）
 *
 * 这些规则来自用户桌面的《视频转码对齐经验教训》，是踩过坑总结出来的，
 * 值得用测试钉死 —— 一旦被改坏，症状是"转码成功但平均帧率永远对不齐"，
 * 非常难查。
 */
const h = require('./helpers')
const { pickTimescale, x264Profile, x264Level, parseLastFfmpegTime, estimateRemaining, isBenignSeamMessage } = require('../electron/merger.js')

async function run() {
  const rep = h.makeReporter('单元测试：时间刻度 / profile 映射 / ffmpeg 进度解析 / 接缝消息过滤')

  // ---- 接缝抽检：只放过"已知无害"的消息，真错误必须仍然判失败 ----
  // 2026-09-16 用户实测：产物在接缝处报 null muxer 的时间戳提示，
  // 但全片 47880 个包 PTS 零重复、DTS 零回退、帧数完全正确 —— 文件是好的。
  {
    const benign = '[null @ 000001e94db86d40] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 23990 >= 23990'
    rep.check('null muxer 的时间戳提示被判定为无害（不因此拒绝交付）',
      isBenignSeamMessage(benign) === true, '已确认为无害')

    // 真正的解码错误绝不能被放过
    const bad = [
      '[h264 @ 0000] Error while decoding MB 12 34, bytestream -5',
      '[mov,mp4] moov atom not found',
      '[concat @ 0000] Unsafe file name',
      '[h264 @ 0000] Invalid NAL unit size',
    ]
    const missed = bad.filter((l) => isBenignSeamMessage(l))
    rep.check('真正的解码错误不会被误判为无害', missed.length === 0,
      missed.length ? `被错误放过: ${missed.join(' | ')}` : `${bad.length} 类错误全部仍会判失败`)
  }

  // ---- ffmpeg 进度解析：必须取最后一个 time= ----
  // 2026-09-16 的 bug：用不带 /g 的 match() 只能拿到第一个 time=，
  // 表现是进度条全程卡在开头（实测 120 秒素材全程只显示 3%）。
  {
    const stderr = 'frame=1 time=00:00:01.50 speed=1x\rframe=2 time=00:00:12.25 speed=1x\rframe=3 time=00:01:02.75 speed=1x'
    const got = parseLastFfmpegTime(stderr)
    rep.check('累加 stderr 里取最后一个 time=（不是第一个）', got === 62.75,
      `序列 1.5 → 12.25 → 62.75，解析出 ${got}（取第一个会得到 1.5，那就是进度卡住的根因）`)
    const two = parseLastFfmpegTime('time=00:00:03.00 time=00:00:09.00')
    rep.check('同一段里出现多次也只认最后一条', two === 9, `→ ${two}`)
    rep.check('没有 time= 时返回 null', parseLastFfmpegTime('nothing here') === null, '→ null')
    const hh = parseLastFfmpegTime('time=01:02:03.50')
    rep.check('小时位也能解析', hh === 3723.5, `→ ${hh}`)
  }

  // ---- 剩余时间估算：绝不能给出离谱值 ----
  // 旧实现用 elapsed×(100−p)/p 外推，进度一被卡住就得到 elapsed×32，
  // 十几分钟的任务显示"剩余十几小时"。现在改成按真实处理速率推算，
  // 且样本不足时**不给估算**。
  {
    const noSample = estimateRemaining({ mediaDone: 1, mediaTotal: 600, elapsedSec: 2 })
    rep.check('样本不足（只跑了 2 秒）时不给估算，而不是给个荒唐值',
      noSample === undefined, `→ ${noSample}`)

    const tinyProgress = estimateRemaining({ mediaDone: 0.5, mediaTotal: 600, elapsedSec: 60 })
    rep.check('已处理媒体太少时同样不给估算', tinyProgress === undefined, `→ ${tinyProgress}`)

    // 真实场景：600 秒素材，跑了 60 秒处理掉 120 秒（2 倍速），剩余应约 240 秒 + 尾巴
    const normal = estimateRemaining({ mediaDone: 120, mediaTotal: 600, elapsedSec: 60 })
    const sane = normal !== undefined && normal > 200 && normal < 350
    rep.check('正常样本给出合理估算（600s 素材 / 2 倍速 → 约 4 分钟）', sane,
      `→ ${normal === undefined ? 'undefined' : Math.round(normal) + ' 秒'}`)

    const done = estimateRemaining({ mediaDone: 600, mediaTotal: 600, elapsedSec: 300 })
    rep.check('已经处理完就不给估算', done === undefined, `→ ${done}`)

    // 最关键的回归：任何情况下都不能返回十几小时这种量级
    const scenarios = [
      { mediaDone: 1, mediaTotal: 3600, elapsedSec: 3 },
      { mediaDone: 2, mediaTotal: 3600, elapsedSec: 900 },
      { mediaDone: 10, mediaTotal: 7200, elapsedSec: 30 },
    ].map(estimateRemaining).filter((x) => x !== undefined)
    const absurd = scenarios.filter((x) => x > 3600 * 4)
    rep.check('不会出现"十几小时"级别的估算', absurd.length === 0,
      scenarios.length ? `样本: ${scenarios.map((x) => Math.round(x) + 's').join(', ')}` : '全部因样本不足而不给估算')
  }

  // ---- 教训 3：时间刻度必须让"一帧 = 整数 tick" ----
  // 一帧 tick 数 = timescale × den / num，必须整除
  const fits = (T, fps) => {
    const [n, d] = fps.split('/').map(Number)
    return Number.isInteger(T * d / n)
  }

  rep.check('30/1 配 90000 可用（一帧 3000 tick）', pickTimescale(90000, '30/1') === 90000,
    `→ ${pickTimescale(90000, '30/1')}`)

  rep.check('25/1 配 90000 可用（一帧 3600 tick）', pickTimescale(90000, '25/1') === 90000,
    `→ ${pickTimescale(90000, '25/1')}`)

  // 这条就是文档里的核心：23.976 + 90000 → 3753.75 tick，必须换刻度
  const t23976 = pickTimescale(90000, '24000/1001')
  rep.check('23.976 配 90000 不可整除 → 自动换成 24000', t23976 === 24000 && fits(t23976, '24000/1001'),
    `90000×1001/24000=${(90000 * 1001 / 24000).toFixed(2)} tick（非整数） → 改用 ${t23976}（一帧 ${t23976 * 1001 / 24000} tick）`)

  const t2997 = pickTimescale(90000, '30000/1001')
  rep.check('29.97(30000/1001) 配 90000 可整除，保持 90000', t2997 === 90000 && fits(t2997, '30000/1001'),
    `→ ${t2997}`)

  const t2997b = pickTimescale(90000, '2997/100')
  rep.check('29.97(2997/100) 会自动换成可整除刻度', fits(t2997b, '2997/100'),
    `→ ${t2997b}（一帧 ${t2997b * 100 / 2997} tick）`)

  // 所有常见帧率都不应选出不可整除的刻度
  const rates = ['24/1', '24000/1001', '25/1', '30/1', '30000/1001', '50/1', '60/1', '60000/1001', '2997/100', '23/1']
  const bad = rates.filter((f) => !fits(pickTimescale(90000, f), f))
  rep.check('常见帧率全部选出可整除的刻度', bad.length === 0, bad.length ? `不合格: ${bad.join(', ')}` : `${rates.length} 种帧率全部通过`)

  // ---- profile / level 映射（《视频参数合并标准》V10 / V11）----
  rep.check('h264 profile 映射', x264Profile('Main') === 'main' && x264Profile('High') === 'high'
    && x264Profile('High 4:4:4 Predictive') === 'high444' && x264Profile('莫名其妙') === '',
    'Main→main, High→high, 未知→空（不写）')
  rep.check('h264 level 映射', x264Level(31) === '31' && x264Level('40') === '40' && x264Level(0) === '' && x264Level(999) === '',
    '31→31, 0/999→空（不写，避免非法值）')

  return rep
}

module.exports = { run }
