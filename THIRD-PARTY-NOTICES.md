# 第三方组件声明

本文件只声明本仓库直接使用或随发布包分发的主要第三方组件。各组件的完整许可证文本和源码提供义务以对应上游项目为准。

## FFmpeg / FFprobe

- 版本：7.1.1
- 来源：`bin/ffmpeg.exe`、`bin/ffprobe.exe`
- 构建标识：`full_build-www.gyan.dev`
- 上游项目：https://ffmpeg.org/
- 上游许可证说明：https://ffmpeg.org/legal.html

当前二进制的版本输出包含 `--enable-gpl --enable-version3`，因此重新分发时必须遵守该构建所适用的 GPL 和其他 FFmpeg 组件许可要求。FFmpeg 二进制不是本项目原创代码。

## Electron / Chromium

- 版本：Electron 28.3.3（由 `package.json` 开发依赖指定）
- 上游项目：https://www.electronjs.org/
- Electron 许可证和 Chromium 第三方声明随 Electron 发行包提供；目录版发布包中的 `LICENSE.electron.txt` 与 `LICENSES.chromium.html` 应保留。

## Vue / Pinia / Vite / TypeScript

这些 JavaScript/TypeScript 依赖由 `package.json` 和 `package-lock.json` 管理。安装或重新分发时请按各自 npm 包的许可证执行。
