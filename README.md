# 视频拼接器

## 小白用户直接下载

[下载 Windows 免安装版 v1.3.1](https://github.com/xiaohuangya617/Flux-video-merge/releases/download/v1.3.1/video-merger-v1.3.1-windows-x64.zip)

使用步骤：

1. 下载上面的压缩包。
2. 右键选择“解压全部”，不要只提取 EXE 文件。
3. 打开解压目录，双击 `视频拼接器.exe`。

这是 Windows 目录版，解压后需要保持文件夹结构不变。

## 功能

- 支持拖拽或选择多个 `mp4`、`mkv`、`mov` 视频。
- 支持选择文件夹并递归扫描视频。
- 自动读取视频参数，识别编码、分辨率、帧率、音频和时间基差异。
- 参数一致时优先无损拼接；可无损规整时先规整，必要时才转码。
- 支持 MP4、MKV、MOV 输出。
- 支持队列处理、输出文件重名处理、进度显示和结果校验。
- 可选将成功处理的源视频移入系统回收站，便于恢复。
- 内置 FFmpeg 和 FFprobe，普通用户不需要另外安装命令行工具。

## 源码运行

开发环境需要 Windows、Node.js 和 npm。源码运行依赖项目内的 `bin/ffmpeg.exe` 与 `bin/ffprobe.exe`。

```powershell
npm install
npm run dev
```

类型检查：

```powershell
npm run typecheck
```

生成 Windows 目录版：

```powershell
npm run electron:build
```

构建结果写入 `release/`。`node_modules/`、`dist/` 和 `release/` 均为本地生成目录，不应提交到源码仓库。

## 已知限制

- 仅支持 Windows。
- 输入和输出格式为 MP4、MKV、MOV；不支持 WebM。
- 多音轨场景只保留第一条音轨，其余音轨会被丢弃。
- MKV、MOV 已有参数和产物校验，但当前源码记录中没有完整的真实视频端到端验收记录，使用重要文件时请先用副本测试。
- 转码需要临时空间，磁盘空间预估属于运行前估算，极端情况下可能低估实际需求。
- 目前没有单实例锁，同时打开多个程序处理同一输出路径可能造成冲突。
- 取消任务时 Windows 可能暂时占用临时文件；程序启动时会尝试清理上次残留。
- Electron 当前使用本地页面并配置了 `contextIsolation: false`、`nodeIntegration: true`，不适合加载不可信远程页面。
- “移入回收站”仍属于有风险的文件操作，操作前请确认源文件已经备份。

## 发布内容

本仓库包含 Vue/TypeScript 渲染层、Electron 主进程、测试代码和运行所需的 FFmpeg/FFprobe 二进制。`test/fixtures/` 用于自动化测试；个人测试视频、构建目录、依赖目录和截图不随源码发布。

当前源码版本：`1.3.1`。

## 许可证

作者原创源码采用 [MIT License](LICENSE)，署名为 `xhy`。

FFmpeg、FFprobe、Electron、Chromium、Vue、Pinia、Vite 及其他依赖属于第三方组件，按照各自许可证执行。请阅读 [第三方组件声明](THIRD-PARTY-NOTICES.md)，重新分发时保留相应许可和声明。

## 免责声明

视频处理可能消耗大量磁盘空间和时间。请先备份重要视频，并在确认输出文件可播放后再处理源文件。
