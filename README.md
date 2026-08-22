# YuKi（原影视 PC）

YuKi 是一个面向桌面的影视聚合应用，使用 Electron 作为界面与系统宿主，使用独立 FastAPI/Python 进程运行 CatVod 与 Kazumi 两套内容引擎，并通过 mpv、aria2c 和 ffmpeg 完成播放与下载。

当前版本为 `0.1.0`，主要开发和验证平台是 Windows。内部包名、数据目录与 IPC 前缀仍为 `yuki`/`yuki`，仅显示名为 YuKi。

## 当前状态

- CatVod 配置、Python/JavaScript/CMS 爬虫、聚合搜索、详情与播放链路已经完成。
- Kazumi 规则导入、商店、编辑、测试、搜索、剧集解析和真实视频流提取已经接入。
- mpv 播放、自动连播、续播、Anime4K、截图、外部播放和 DLNA 已接入；画中画已在 2A 中移除。
- aria2c 直链下载、ffmpeg HLS 下载、下载记录与系统通知已接入。
- 收藏、历史、观看统计、Bangumi、WebDAV、SyncPlay 和本地文件管理已接入。
- Windows 安装包已生成；macOS/Linux 打包、安装后冷启动和自动更新仍待验证或实现。
- TVBox 兼容性基础能力已接入，但 21 仓全量回归、FongMi 契约审计和分层诊断验收仍在计划中，详见 [TVBox 兼容性计划](docs/TVBOX_COMPAT_PLAN.md)。

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

## 文档导航

先看 [文档索引](docs/README.md)，再按任务进入对应文档。

| 目的 | 文档 |
|---|---|
| 了解当前状态、边界和下一步 | [PROGRESS.md](PROGRESS.md) |
| 了解项目文档层级和维护规则 | [docs/README.md](docs/README.md) |
| 了解进程、接口、数据流和安全边界 | [系统架构](docs/ARCHITECTURE.md) |
| 了解 Kazumi 当前实现 | [Kazumi 整合说明](docs/KAZUMI_INTEGRATION.md) |
| 查看 Kazumi 与原版的差距 | [Kazumi 功能差距](docs/KAZUMI_GAP_ANALYSIS.md) |
| 查看最新运行异常与复测证据 | [运行时问题](docs/RUNTIME_ISSUES.md) |
| 查看自动化测试和用户实测清单 | [功能测试报告](docs/TEST_REPORT.md) |
| 查看历史批次和设计决策 | [历史开发记录](docs/DEVELOPMENT_HISTORY.md) |

### 工程审查与执行计划

- [代码审查报告](CODE_REVIEW.md) · 安全问题、缺陷和审查基线
- [代码审查修复任务清单](CODE_REVIEW_FIX_TASKS.md) · 修复步骤与验收记录
- [改进优化任务清单](IMPROVEMENT_PLAN.md) · 工程化、性能和发布待办
- [TVBox 兼容性计划](docs/TVBOX_COMPAT_PLAN.md) · 兼容性收敛方案
- [当前未完成任务清单](docs/UNFINISHED_TASKS.md) · 跨文档汇总入口
- [TVBox 剩余工作计划](docs/TVBOX_COMPAT_PLAN_REMAINING.md) · 当前未完成项与执行顺序

Kazumi Flutter 原版源码与文档位于同级目录 `../Kazumi-main/`，用于架构和行为对照，不是影视 PC 的开发入口。
