# Release Notes v0.1.0（发布页文案草稿）

> 维护者使用：创建 GitHub 仓库并推送 tag 后，将本文件内容粘贴到 Draft Release（`.github/workflows/release.yml` 自动生成），核对后 publish。发布流程见 CONTRIBUTING.md「发布流程」。

---

## YuKi v0.1.0 · 首个公开发布

YuKi 是面向桌面的影视聚合应用：Electron 界面宿主 + FastAPI/Python 独立后端进程（CatVod 与 Kazumi 双引擎），mpv / aria2c / ffmpeg 完成播放与下载。本版本为首个公开发布版本，当前仅保证 Windows 平台体验。

### 新功能

- **双引擎内容聚合**：CatVod 配置与 Python/JavaScript/CMS 爬虫、多仓配置；Kazumi XPath/API 规则导入、商店、编辑、测试与真实视频流提取；SSE 聚合搜索。
- **Bangumi 集成**：搜索、详情、时间表（近 20 年季节索引）、榜单、分集、角色与 Staff、评论、收藏同步。
- **mpv 播放链路**：硬件加速、倍速、续播、自动连播、断流重连、失败换线；Anime4K 三档超分、截图、定时关机、DLNA、VLC 外部播放。
- **解析链路**：隐藏窗口媒体请求拦截提取真实视频流；3 个独立 partition 槽位，single-flight 合并并发请求。
- **下载**：aria2c 直链/种子下载、ffmpeg HLS 合成与广告段过滤、下载记录持久化、完成通知、一键播放。
- **数据**：收藏、历史、观看统计、WebDAV、SyncPlay、本地文件白名单管理。
- **TVBox 兼容基线**：统一运行时错误契约（L1–L6）与站点健康模型；可终止 Worker 进程隔离与熔断恢复；ConfigSnapshot 三层配置标准化、原子热更新、能力路由与安全边界。

### 已知问题

- macOS / Linux 打包与安装后冷启动尚未验证。
- 弹幕界面与播放时弹幕加载处于停用状态（仓库内相关代码仅为兼容基础）。
- drpy 运行时与 type 15/16 站点未实现；需要 Android/Dex 的 JAR 站点在 PC 上不可用。
- Windows 安装后的首次冷启动验证仍在计划中。

### 升级注意事项

- **首版没有自动升级路径**：electron-updater 基础链路已接入，但从旧版本（内部阶段）升级请直接重新安装。
- 安装包内置 mpv / ffmpeg / aria2c / Anime4K / MiSans 子集字体等第三方二进制，其许可证与出处见 [docs/THIRD_PARTY.md](THIRD_PARTY.md)（含 GPLv2/GPLv3 组件的源码获取说明）。
- 数据目录为 `~/.yuki/` 与 Electron userData，安装新版本不会清除观看数据。

### 校验

安装包由 GitHub Actions 在 tag `v0.1.0` 上构建（Windows Server 2022 runner），产物为 NSIS x64 安装程序。
