# YuKi（原影视 PC）

YuKi 是一个面向桌面的影视聚合应用，使用 Electron 作为界面与系统宿主，使用独立 FastAPI/Python 进程运行 CatVod 与 Kazumi 两套内容引擎，并通过 mpv、aria2c 和 ffmpeg 完成播放与下载。

当前版本为 `0.1.0`，主要开发和验证平台是 Windows。内部包名、数据目录与 IPC 前缀仍为 `video-pc`/`vpc`，仅显示名为 YuKi。

## 当前状态

- CatVod 配置、Python/JavaScript/CMS 爬虫、聚合搜索、详情与播放链路已经完成。
- Kazumi 规则导入、商店、编辑、测试、搜索、剧集解析和真实视频流提取已经接入。
- mpv 播放、自动连播、续播、Anime4K、截图、外部播放和 DLNA 已接入；画中画已在 2A 中移除。
- aria2c 直链下载、ffmpeg HLS 下载、下载记录与系统通知已接入。
- 收藏、历史、观看统计、Bangumi、WebDAV、SyncPlay 和本地文件管理已接入。
- Windows 安装包已生成；macOS/Linux 打包、安装后冷启动和自动更新仍待验证或实现。

产品当前不启用弹幕界面与播放时弹幕加载。仓库保留了部分 DanDanPlay API、ASS 和历史代码，仅作为兼容基础，不代表弹幕功能处于启用状态。

## 快速开始

开发环境需要 Node.js、Python 3.14，以及项目脚本管理的 mpv、aria2c、ffmpeg 等二进制资源。

```powershell
npm install
npm start
```

运行完整回归：

```powershell
npm run test:all
```

构建 Windows 安装包：

```powershell
npm run build:win
```

更完整的环境、架构与构建说明见 [开发状态](PROGRESS.md) 和 [架构说明](docs/ARCHITECTURE.md)。

## 文档

- [开发状态与续作入口](PROGRESS.md)
- [文档索引](docs/README.md)
- [系统架构](docs/ARCHITECTURE.md)
- [Kazumi 整合说明](docs/KAZUMI_INTEGRATION.md)
- [Kazumi 功能差距](docs/KAZUMI_GAP_ANALYSIS.md)
- [运行时问题](docs/RUNTIME_ISSUES.md)
- [功能测试报告](docs/TEST_REPORT.md)
- [历史开发记录](docs/DEVELOPMENT_HISTORY.md)

Kazumi Flutter 原版源码与文档位于同级目录 `../Kazumi-main/`，用于架构和行为对照，不是影视 PC 的开发入口。
