/**
 * 一致性检查（静态分析，不跑 ffmpeg）
 *
 * 存在的理由：同一个"字段清单"散落在三处 —— merger 的分类表、store 的
 * COMPARE_DEFS、store 的 AUDIO_KEYS/AUDIO_DEFAULTS。之前两次踩坑都是
 * "只改了一处"：audioTimeBase 加进 merger 却没加进 store，导致每个文件
 * 都被误判为不一致。这类问题跑合并测不出来（只是白干活），必须静态核对。
 */
const fs = require('fs')
const path = require('path')
const h = require('./helpers')

const STORE = path.join(h.PROJ, 'src', 'stores', 'video.ts')

function readStore() { return fs.readFileSync(STORE, 'utf8') }

// COMPARE_DEFS 里所有 key: 'xxx'
function storeCompareKeys(src) {
  const start = src.indexOf('const COMPARE_DEFS')
  if (start < 0) return null
  const end = src.indexOf('\n]', start)
  const block = src.slice(start, end)
  return [...block.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1])
}

// const NAME = ['a', 'b']  或  const NAME: T = ['a']
function storeStringArray(src, name) {
  const m = src.match(new RegExp(`const ${name}\\s*(?::[^=]+)?=\\s*\\[([\\s\\S]*?)\\]`))
  if (!m) return null
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

// const NAME: T = { a: ..., b: ... }（键可能写在同一行，不能要求行首）
function storeObjectKeys(src, name) {
  const m = src.match(new RegExp(`const ${name}\\s*(?::[^=]+)?=\\s*\\{([\\s\\S]*?)\\n\\}`))
  if (!m) return null
  // 先抹掉字符串字面量，避免把值里的冒号误当键
  const body = m[1].replace(/'[^']*'/g, "''")
  return [...body.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((x) => x[1])
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|')

async function run() {
  const rep = h.makeReporter('一致性检查：字段清单在 store 与 merger 之间是否对齐（静态）')
  const src = readStore()

  const mergerKeys = h.COMPARE_KEYS
  const storeKeys = storeCompareKeys(src)

  rep.check('能解析出 store 的 COMPARE_DEFS',
    Array.isArray(storeKeys) && storeKeys.length > 0,
    storeKeys ? `${storeKeys.length} 项` : '解析失败')

  if (storeKeys) {
    const onlyStore = storeKeys.filter((k) => !mergerKeys.includes(k))
    const onlyMerger = mergerKeys.filter((k) => !storeKeys.includes(k))
    rep.check('store.COMPARE_DEFS 与 merger 判定字段完全一致',
      onlyStore.length === 0 && onlyMerger.length === 0,
      onlyStore.length || onlyMerger.length
        ? `只在 store: [${onlyStore}] 只在 merger: [${onlyMerger}]`
        : `${mergerKeys.length} 项逐一对齐`)
  }

  const storeAudio = storeStringArray(src, 'AUDIO_KEYS')
  rep.check('能解析出 store 的 AUDIO_KEYS', Array.isArray(storeAudio), storeAudio ? storeAudio.join(', ') : '解析失败')

  if (storeAudio) {
    rep.check('store.AUDIO_KEYS 与测试预期一致',
      sameSet(storeAudio, h.AUDIO_KEYS),
      sameSet(storeAudio, h.AUDIO_KEYS) ? `${storeAudio.length} 项` : `store=[${storeAudio}] 预期=[${h.AUDIO_KEYS}]`)

    // 音频类字段必须全部落在 AUDIO_KEYS 里，否则无音轨文件的空值会赢得多数派
    const audioish = mergerKeys.filter((k) => /^(audio|sampleRate|channels|channelLayout)/.test(k))
    const missed = audioish.filter((k) => !storeAudio.includes(k))
    rep.check('所有音频类字段都纳入了音频样本范围', missed.length === 0,
      missed.length ? `漏了: ${missed.join(', ')}` : `${audioish.length} 项全覆盖`)
  }

  const storeDefaults = storeObjectKeys(src, 'AUDIO_DEFAULTS')
  rep.check('能解析出 store 的 AUDIO_DEFAULTS', Array.isArray(storeDefaults), storeDefaults ? storeDefaults.join(', ') : '解析失败')

  if (storeAudio && storeDefaults) {
    // 这条直接防住"默认值缺失 → target 变 undefined → 全量误判"
    const missing = storeAudio.filter((k) => !storeDefaults.includes(k))
    rep.check('每个 AUDIO_KEY 都有默认值兜底（防 undefined 污染基准）',
      missing.length === 0,
      missing.length ? `缺默认值: ${missing.join(', ')}` : `${storeDefaults.length} 个默认值齐全`)
  }

  const storeNum = storeStringArray(src, 'NUM_KEYS')
  if (storeNum) {
    rep.check('store.NUM_KEYS 与测试预期一致', sameSet(storeNum, h.NUM_KEYS),
      sameSet(storeNum, h.NUM_KEYS) ? `${storeNum.length} 项` : `store=[${storeNum}] 预期=[${h.NUM_KEYS}]`)
  }
  const storeBool = storeStringArray(src, 'BOOL_KEYS')
  if (storeBool) {
    rep.check('store.BOOL_KEYS 与测试预期一致', sameSet(storeBool, h.BOOL_KEYS),
      sameSet(storeBool, h.BOOL_KEYS) ? `${storeBool.length} 项` : `store=[${storeBool}] 预期=[${h.BOOL_KEYS}]`)
  }

  // 结构性字段不允许手选目标，必须在 FIXED_KEYS 里
  const storeFixed = storeStringArray(src, 'FIXED_KEYS') || []
  const structural = ['avgFrameRate', 'isCFR', 'startTime', 'streamCount']
  const notFixed = structural.filter((k) => !storeFixed.includes(k))
  rep.check('结构性字段禁止手选对齐目标', notFixed.length === 0,
    notFixed.length ? `未锁定: ${notFixed.join(', ')}` : structural.join(', '))

  return rep
}

module.exports = { run }
