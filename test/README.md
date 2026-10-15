# 测试

```bash
npm test                  # 全部（先自动 vite build，约 40 秒）
npm run test:unit         # 纯函数单元测试（秒出）
npm run test:consistency  # 字段清单一致性（静态，秒出）
npm run test:regression   # 反例回归
npm run test:functional   # 功能验证
npm run test:ui           # 界面端到端（任务队列）
```

必须在 Electron 里跑（合并逻辑依赖 electron 的 `app` 解析 ffmpeg 路径）。
`npm test` 会先构建 dist —— 界面端到端套件跑的是构建产物，
不先构建就会测到旧代码（这个坑踩过）。

## 为什么要有这一套

这个项目连续两轮代码审查，都在"主流程全绿"的前提下翻出严重问题：

| 轮次 | 问题 | 当时为什么没测出来 |
|------|------|-------------------|
| 第一轮 | 选「生成新名称」**覆盖了原文件** | 5 组反例全走"参数不一致"路径，没有一组碰输出冲突 |
| 第二轮 | **mkv 输出被产物校验自己封死** | 校验断言上线后只回归了 mp4 |
| 更早 | `audioTimeBase` 只加进 merger 没加进 store | 主流程照跑，只是每个文件都白规整一遍 |

共同点：**问题都在分支路径和边界上**。所以这套测试的重点不是"主流程能跑"，
而是把分支和边界钉住。

## 三个套件

### 1. `consistency.js` — 一致性检查（静态分析）

同一个"字段清单"散落在三处：`merger.js` 的 `MUST_TRANSCODE` / `REMUX_FIXABLE`、
store 的 `COMPARE_DEFS`、store 的 `AUDIO_KEYS` / `AUDIO_DEFAULTS`。
**只改一处**是历史上重复踩的坑（`audioTimeBase` 就是这么漏的）。

这个套件直接读 `src/stores/video.ts` 的源码解析出清单，和 `merger.js` 导出的表逐一比对：

- 23 个判定字段两边必须完全一致
- 所有音频类字段必须纳入音频样本范围（否则无音轨文件的空值会赢得多数派）
- 每个 `AUDIO_KEY` 必须有默认值兜底（否则基准会变成 `undefined`，**全量误判**）
- 结构性字段必须锁定，不允许用户手选

`test/helpers.js` 里的字段清单**直接从 merger 导出推导**，不手抄，避免测试自己成为第三份真相。

### 2. `regression.js` — 反例回归

5 组真实反例，前 3 组曾经能骗过"18 项参数比较"并产出坏文件。断言不只是"能成功"，
而是**路径必须正确**：

- REF / A / B 必须走**无损**路径（退化成转码 = 白掉画质，算失败）
- D3 / E 必须走转码
- 全部必须通过产物校验

### 3. `functional.js` — 功能验证

覆盖边界与三种输出格式：

- 磁盘空间查询不能退化回子进程（曾用 PowerShell 阻塞主进程几百毫秒）
- **mov / mkv 输出**（mkv 曾被校验封死）
- 文件名含单引号（曾拼坏 concat 列表）
- 源文件丢失 / 输出目录无效 → 必须**提前**报错
- 输出名净化（防 `..\..\` 目录穿越）
- 画质档位真实生效（低档产物应明显更小）

### 4. `ui.js` — 界面端到端（任务队列）

队列逻辑在渲染进程的 Pinia store 里，主进程测不到，只能开真窗口驱动。
做法是：先 `require` 真实主进程（注册全部 IPC handler 并建窗口），
**再把那个窗口的页面换成构建好的 `dist/index.html`** —— 复用同一个窗口实例，
主进程推的 `merge-progress` / `merge-complete` 事件才会送到它身上。

覆盖：入队冻结配置并清空列表 / 队列项可排序可删除 / 串行执行且各自走对路径
（direct、transcode、remux）/ 产物真的生成 / 跑完只弹一次汇总 /
失败跳过继续 / 队列能正常结束并复位状态。

## 语料

`fixtures/` 里的 9 个 mp4 共 1.87 MB，是造出来专门触发各类缺陷的：

| 文件 | 用途 |
|------|------|
| `base.mp4` | 基准：640×480 / 30fps / aac 44100 stereo |
| `A_two_audio.mp4` | 视频+**两条**音轨 —— 流布局不一致 |
| `B_start_offset.mp4` | 起始时间偏移 0.976s —— 时间轴原点不一致 |
| `C_vfr.mp4` / `D3_vfr_clean.mp4` | VFR（后者把所有可比字段抹平，伪装成 CFR） |
| `D2_vfr_masq.mp4` / `D_vfr_withaudio.mp4` | VFR 的中间试验品 |
| `m1_...` / `m2_...` | 分辨率、帧率、音轨有无全不同 —— 强制走转码 |

重新生成语料的方法见 `LESSONS.md`；核心手法是 `-copyts` / `-output_ts_offset` /
拼接不同帧率的两段。
