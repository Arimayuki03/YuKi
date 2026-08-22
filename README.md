<p align="center">
  <img src="assets/icon.png" width="128" height="128" alt="YuKi Logo" />
</p>

<h1 align="center">YuKi</h1>

<p align="center">
  聚合 · 本地优先的影视探索桌面
</p>

<p align="center">
<!-- TODO: GitHub 仓库创建后，将下方徽章中的 OWNER 替换为实际用户名/组织名 -->
<a href="https://github.com/Arimayuki03/YuKi/actions/workflows/ci.yml"><img src="https://github.com/Arimayuki03/YuKi/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
<a href="https://github.com/Arimayuki03/YuKi/actions/workflows/release.yml"><img src="https://github.com/Arimayuki03/YuKi/actions/workflows/release.yml/badge.svg" alt="Release" /></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/License-GPLv3-blue.svg" alt="License: GPL v3" /></a>
<a href="https://github.com/Arimayuki03/YuKi/releases"><img src="https://img.shields.io/github/v/release/Arimayuki03/YuKi" alt="GitHub Release" /></a>
</p>

YuKi 是一个面向桌面的影视聚合应用，使用 Electron 作为界面与系统宿主，使用独立 FastAPI/Python 进程运行 CatVod 与 Kazumi 两套内容引擎，并通过 mpv、aria2c 和 ffmpeg 完成播放与下载。

当前版本为 `0.1.0`，主要开发和验证平台是 Windows。内部包名、数据目录与 IPC 前缀仍为 `yuki`/`yuki`，仅显示名为 YuKi。

## 当前状态

- CatVod 配置、Python/JavaScript/CMS 爬虫、聚合搜索、详情与播放链路已经完成。
- Kazumi 规则导入、商店、编辑、测试、搜索、剧集解析和真实视频流提取已经接入。
- mpv 播放、自动连播、续播、Anime4K、截图、外部播放已接入；画中画已在 2A 中移除。
- aria2c 直链下载、ffmpeg HLS 下载、下载记录与系统通知已接入。
- 收藏、历史、观看统计、Bangumi、WebDAV 和本地文件管理已接入。
- Windows 安装包已生成；macOS/Linux 打包、安装后冷启动和自动更新仍待验证或实现。
- TVBox 兼容性基础能力已接入，但 21 仓全量回归、FongMi 契约审计和分层诊断验收仍在计划中，详见[功能一致性任务书](docs/TVBOX_FONGMI_PARITY_TASKS.md)。

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

更完整的环境、架构与构建说明见 [开发状态](PROGRESS.md)、[架构说明](docs/ARCHITECTURE.md)与[文件结构](docs/FILE_STRUCTURE.md)。

## 文档导航

先看 [文档索引](docs/README.md)，再按任务进入对应文档。

| 目的 | 文档 |
|---|---|
| 了解当前状态、边界和下一步 | [PROGRESS.md](PROGRESS.md) |
| 了解项目文档层级和维护规则 | [docs/README.md](docs/README.md) |
| 了解进程、接口、数据流和安全边界 | [系统架构](docs/ARCHITECTURE.md) |
| 了解 Kazumi 当前实现与差距 | [Kazumi 规则引擎](docs/KAZUMI.md) |
| 查看最新运行异常与复测证据 | [运行时问题](docs/RUNTIME_ISSUES.md) |
| 查看自动化测试和用户实测清单 | [功能测试报告](docs/TEST_REPORT.md) |
| 查看历史批次和设计决策 | [历史开发记录](docs/DEVELOPMENT_HISTORY.md) |
| 参与贡献 / 行为准则 / 发布流程 | [CONTRIBUTING.md](CONTRIBUTING.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) |
| 查看版本变更记录 | [CHANGELOG.md](CHANGELOG.md) |
| 查看随安装包分发的第三方组件许可 | [第三方组件与许可声明](docs/THIRD_PARTY.md) |

### 工程审查与执行计划

- [代码审查报告](CODE_REVIEW.md) · 安全问题、缺陷和审查基线
- [代码审查修复任务清单](CODE_REVIEW_FIX_TASKS.md) · 修复步骤与验收记录
- [改进优化任务清单](IMPROVEMENT_PLAN.md) · 工程化、性能和发布待办
- [TVBox/FongMi 功能一致性任务书](docs/TVBOX_FONGMI_PARITY_TASKS.md) · 运行时隔离、播放收敛与发布验收（当前唯一执行入口）

## 免责声明

> 请在使用前仔细阅读本节。继续使用 YuKi 即视为已理解并同意以下条款。

1. **内容来源**：YuKi 本身不提供、存储、托管或分发任何影视内容。所有可播放资源均来自用户自行添加的 CatVod / Kazumi 配置源（第三方网站、规则脚本）或本地文件。内容的可用性、准确性、合法性与版权归属均由源站方负责，与 YuKi 开发者无关。

2. **仅供学习与技术研究**：本项目为开源聚合播放器框架，用于研究 Electron + Python 双进程架构、爬虫规则解析与多媒体工具链整合。开发者未对任何源的版权合规性进行背书，不鼓励、不支持任何侵犯版权或违反当地法律法规的使用行为。

3. **用户责任**：用户需自行确保所添加的源与观看行为符合所在国家/地区法律法规及源站服务条款。因使用第三方源产生的版权纠纷、账号封禁、隐私泄露或财产损失，由用户自行承担。

4. **无担保**：软件按“现状”（AS IS）提供，不附带任何明示或暗示担保（见 `LICENSE` 第 15–16 条）。包括但不限于可用性、稳定性、源可访问性、解析成功率、下载完整性。开发者不对因使用本软件造成的直接或间接损失负责。

5. **第三方服务风险**：部分源可能包含广告、跳转、Cookie 验证或 JS 执行逻辑；解析过程在受限的 Worker / 隐藏窗口中隔离执行，但仍建议用户审慎添加来源不明的配置，对需要登录的源自行评估风险。

6. **合规使用建议**：请优先观看正版授权内容；若发现某源提供侵权内容，请停止使用该源并通过正版渠道支持创作者。

如不同意上述声明，请勿使用本软件。

## 隐私政策

YuKi 坚持 **本地优先、无追踪** 原则：

| 事项 | 说明 |
|---|---|
| **数据存储** | 所有个人数据（收藏、历史、观看统计、配置、本地文件索引、日志）仅保存在本机：`%APPDATA%/yuki`（Electron `userData`）与 `~/.yuki/`。不上传至开发者服务器，无云端账号体系。可随时在“设置 → 缓存”或文件管理器中查看/清理。 |
| **遥测与追踪** | **无埋点、无统计、无崩溃上报、无广告 SDK**。不会收集设备指纹、观看行为或个人信息并对外发送。 |
| **网络请求** | 仅在以下情形发起出站请求：① 用户触发的搜索/详情/播放解析请求，目标为用户已配置的源地址；② 用户主动使用的“以图搜番”将图片上传至 `api.trace.moe` 进行识别；③ 用户主动配置并授权的 Bangumi 同步（`api.bgm.tv`）与 WebDAV 备份（用户指定的自建地址）；④ 构建时下载的受信二进制（mpv/ffmpeg/aria2/Anime4K/MiSans，见 `docs/THIRD_PARTY.md`）。除此之外不主动连接任何第三方服务。 |
| **Cookie / Token** | 部分源的 Cookie、Bangumi `access_token`、WebDAV 账号密码仅明文/加密保存在本地配置文件中，用于后续请求鉴权，不会回传给 YuKi 作者。卸载或删除数据目录即可彻底清除。 |
| **本地文件访问** | “本地文件”功能仅在用户授予的白名单根目录内读写，通过主进程校验防路径穿越，不会扫描或上传目录外文件。 |
| **日志** | 应用日志（`~/.yuki/logs/`）仅存于本地，用于问题排查；提交 Issue 时请自行脱敏后再贴出。 |
| **第三方源隐私** | 聚合源返回的内容与隐私实践由源站决定，YuKi 无法控制。建议仅添加可信来源，并定期审查已添加配置。 |

## 致谢

YuKi 的实现站在诸多开源项目的肩膀上，衷心感谢：

- **上游对照与生态**：[Kazumi](https://github.com/Predidit/Kazumi)（规则引擎与 Bangumi 体验参考）、[FongMi / TV](https://github.com/FongMi/TV) 与 CatVod 生态（TVBox 配置契约与爬虫生态）。
- **播放与处理**：[mpv](https://mpv.io/)（GPLv2+）、[FFmpeg](https://ffmpeg.org/)（GPLv3, gyan.dev 构建）、[aria2](https://aria2.github.io/)（GPLv2）。
- **超分与识图**：[bloc97/Anime4K](https://github.com/bloc97/Anime4K)（MIT，v4.1 实时动漫超分着色器，YuKi 三档位均衡 / 细节 / 仅修复）、[trace.moe](https://trace.moe/)（以图搜番，YuKi “以图搜番”功能后端通过 `api.trace.moe/search` 实现）。
- **字体与前端**：[MiSans](https://hyperos.mi.com/font)（小米免费商用）via [dsrkafuu/misans](https://github.com/dsrkafuu/misans)、[jQuery](https://jquery.com/)（MIT）。
- **宿主与后端**：[Electron](https://www.electronjs.org/) / [electron-builder](https://www.electron.build/) / [electron-updater](https://github.com/electron-userland/electron-updater)、[FastAPI](https://fastapi.tiangolo.com/) / [Uvicorn](https://www.uvicorn.org/) / [Pydantic](https://docs.pydantic.dev/)。
- **数据与社区**：[Bangumi](https://bgm.tv/) 提供的番组数据与 API、以及所有提交 Issue、贡献代码与完善文档的贡献者。

完整第三方组件清单与许可证见 [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md)。

## 许可证

本项目代码以 [GPLv3](LICENSE) 许可证发布（见根目录 LICENSE）。衍生与再分发须遵循 GPLv3 条款并提供对应源码。随安装包分发的第三方二进制（mpv GPLv2+ / ffmpeg GPLv3 / aria2c GPLv2 / Anime4K MIT / MiSans 免费商用等）各自按其原始许可证执行，逐项出处与合规结论见[第三方组件与许可声明](docs/THIRD_PARTY.md)。
