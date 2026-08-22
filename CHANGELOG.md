# 更新日志

本项目所有显著变更记录于此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-08-22

首个公开发布版本。Electron 桌面影视聚合应用：CatVod + Kazumi 双内容引擎，mpv 播放链路，aria2c / ffmpeg 下载。

### Added

- **内容聚合**：CatVod 引擎支持 Python / JavaScript / CMS 爬虫与多仓配置；首页、分类、源内搜索、SSE 聚合搜索、详情、收藏与观看历史。
- **Kazumi 规则**：XPath / API 规则导入、编辑、测试、商店、有效性检测、批量更新与真实视频流提取。
- **Bangumi**：搜索、详情、时间表（完整季节索引、封面排名角标、排序与收藏过滤）、榜单、分集、角色与 Staff、评论、关联及收藏同步。
- **播放**：mpv 独立窗口播放，硬件加速、倍速、续播、自动连播、断流重连、失败换线；Anime4K 三档超分、VLC 外部播放、截图、定时关机。
- **解析**：隐藏窗口媒体请求拦截提取真实视频流（DOM 轮询与 legacy iframe 跟随）；3 个独立 partition 槽位，single-flight 合并同地址并发请求。
- **下载**：aria2c 直链 / 种子下载、ffmpeg HLS 合成下载与广告段过滤、下载记录持久化、完成系统通知、一键播放。
- **数据管理**：本地文件白名单管理（防路径穿越、上传、删除、本地播放）、WebDAV、观看统计。
- **TVBox / FongMi 兼容基线**：
  - G0：统一运行时契约（`RuntimeRequest` / `RuntimeResponse`、L1–L6 `RuntimeError`）与站点健康模型；
  - S1：可终止 Worker 进程隔离、绝对 deadline、聚合取消与熔断恢复；
  - C2：ConfigSnapshot 三层配置标准化（下载 / 解析 / 运行）、原子热更新、`ext` 语义对齐 FongMi、能力路由与配置安全边界（scheme 白名单、体积 / 跳转 / 递归深度限制、私网守卫）。
- **桌面能力**：设置中心、主题与壁纸、托盘驻留、快捷键、自定义缓存路径、首次引导；Windows NSIS 安装包。

### Changed

- 移除画中画入口与 MiSans 运行时动态下载/注入，界面统一使用系统字体；「关于」迁入设置一级分类。

### 已知边界

- macOS / Linux 打包与安装后冷启动尚未验证，当前仅保证 Windows 平台体验。
- 弹幕界面与播放时弹幕加载处于停用状态；仓库中的 DanDanPlay API 与 ASS 相关代码仅为兼容基础，不代表弹幕功能可用。
- SyncPlay 同步播放与 DLNA 投屏未实现。
- drpy 运行时与 type 15/16 站点（N3 阶段）未实现；需要 Android / Dex 的 JAR 站点在 PC 上不可用。
- 自动更新已接入 electron-updater 基础链路，但首版没有自动升级路径，升级需重新安装。
- P2P/P3P、ed2k、thunder 协议不在支持范围。

[unreleased]: https://github.com/OWNER/YuKi/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OWNER/YuKi/releases/tag/v0.1.0
