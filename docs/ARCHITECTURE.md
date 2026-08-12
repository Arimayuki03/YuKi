# 影视 PC 系统架构

> 更新时间：2026-08-09
>
> 本文描述当前有效架构。历史方案、详细批次和踩坑记录见 [DEVELOPMENT_HISTORY.md](DEVELOPMENT_HISTORY.md)。

## 1. 总体结构

```text
Electron 渲染层
  首页 / 搜索 / 详情 / 播放入口 / 下载 / 设置
              │ IPC
Electron 主进程
  窗口与托盘 / Python 生命周期 / mpv / aria2c / ffmpeg
  文件管理 / 隐藏解析窗口 / 局域网推送
              │ HTTP + token
FastAPI Python 后端
  /action         CatVod 引擎
  /kazumi/action  Kazumi 规则引擎
  /cache          Spider 缓存
  /proxy          Spider 本地代理
```

核心原则是让 CatVod 与 Kazumi 并行工作，而不是把一种规则强行适配成另一种规则。

## 2. 进程与鉴权

- Electron 主进程启动 Python 子进程。
- 后端通过标准输出发送 `VPC_BACKEND_READY port=<p> token=<t>`。
- 服务只监听 `127.0.0.1` 和随机端口。
- 除 `/health`、`/cache`、`/proxy` 外，端点需要查询参数 `token` 或请求头 `X-Token`。
- 配置自动重载由主进程维护权威状态，渲染层同时监听事件和轮询状态，避免启动竞态。

## 3. 双内容引擎

### CatVod

- `/action` 保持恢复源码的 Spider 调用契约。
- 支持 Python Spider、QuickJS JavaScript Spider 和苹果 CMS JSON/XML。
- 配置支持普通仓与多仓；多仓使用上次成功条目优先、失败重试和跨条目合并。
- 聚合搜索通过 SSE 返回，单源失败不能影响其他源。

### Kazumi

- `/kazumi/action` 使用独立的 PluginManager、RuleEngine 和持久化文件。
- 支持 XPath 与受限 JSONPath/API 两种规则模式。
- 规则只负责找到番剧详情页和剧集播放页，真实媒体地址由 Electron 隐藏窗口提取。
- 规则搜索、商店、编辑、测试、有效性检测、批量更新和 Bangumi 元数据均属于 Kazumi 子系统。

详细 schema 和端点见 [KAZUMI_INTEGRATION.md](KAZUMI_INTEGRATION.md)。

## 4. 播放数据流

```text
搜索或详情
  → CatVod playerContent / Kazumi chapterResult
  → 获得媒体直链或播放页面
  → 直链：直接交给 mpv
  → 页面：隐藏 BrowserWindow 提取真实流
       1. webRequest 拦截媒体请求
       2. 注入脚本轮询 video/audio currentSrc
       3. legacy 模式监听并跟随 iframe src
  → 合并 Referer/User-Agent
  → mpv 单集播放
  → 渲染层依据播放会话推进连播
```

关键约束：

- mpv 每次只播放一集，不使用播放列表承担业务连播。
- 每次播放分配会话号，旧会话退出不能影响当前会话。
- 断流自动重连只允许每个会话尝试一次。
- `ended` 事件携带会话号，渲染层「看完」兜底判定按会话匹配，避免旧集 ended 误判新集。
- 观看统计按「观看链」累计：断流重连经 `player-session` 复用旧链元信息，重连退出只补增量、不重复计次数/部数。
- 同地址解析使用 single-flight 去重；解析窗口使用独立 partition 槽位。
- HTML 页面不能直接交给 mpv。

## 5. 下载数据流

- 普通文件、种子和 Metalink 交给 aria2c JSON-RPC。
- M3U8 交给 ffmpeg 拉流和封装，支持 AES-128 与失败重试。
- HLS 广告过滤仅在下载路径重写播放列表；播放时实时过滤尚未实现。
- 下载列表由主进程聚合状态并推送，渲染层只负责展示。
- 完成/失败记录写入 `dl-records.json`，保证跨重启可见。
- 下载目录切换需要重启 aria2c，但保留续传语义。

## 6. 本地文件与安全边界

- 浏览、复制、删除和本地播放都通过主进程 IPC。
- 渲染层只看到相对白名单路径。
- 所有路径经规范化后必须仍位于配置根目录内。
- 拒绝 `..`、绝对路径、盘符跳转和非媒体文件播放。
- 删除、清空、恢复默认和目录切换等高影响操作使用统一确认对话框。

## 7. 数据与持久化

| 数据 | 位置 |
|---|---|
| Python 缓存、Spider 与日志 | `~/.video-pc/` |
| Kazumi 规则 | `~/.video-pc/kazumi/plugins.json` |
| Kazumi Cookie | `~/.video-pc/kazumi/cookies.json` |
| Electron 设置 | `<userData>/settings.json` |
| 文件管理根目录 | `<userData>/file-manager.json` |
| 下载记录 | `<userData>/dl-records.json` |
| mpv 续播 | `<userData>/mpv-watch-later/` |
| mpv 缓存 | 默认 `<userData>/mpv-cache/`，可配置 |

设置恢复默认时必须保留收藏、历史、配置历史、下载/缓存路径、观看统计和 Bangumi token 等用户数据键。

## 8. 前端状态与交互

- 视图滚动容器是 `.view`，不是 `window`。
- 异步加载使用 `_loadToken`、`_probeToken`、`_playToken` 或等价会话机制。
- Esc 由统一派发器先关闭对话框，再交给当前视图。
- 跨脚本经典全局对象不能依赖 `window.X` 探测顶层 `const`。
- 封面统一使用无 Referer、异步解码、占位图和错误兜底。
- 后台封面补拉优先级低于搜索和详情，并可被详情操作中止。

## 9. Spider 契约摘要

- 插件顶层类名为 `Spider`，继承 `base.spider.Spider` 并实现 `init`。
- Spider 返回值必须是 `dict`，不能返回已经序列化的 JSON 字符串。
- Python 3.12+ 通过 `compat.py` 提供旧版 `SourceFileLoader.load_module` 兼容。
- QuickJS 原生回调只传递标量，复杂值统一使用 JSON 字符串桥接。
- JavaScript Spider 动态创建独立子类，防止基类单例污染不同站点。
- 配置更新采用“完整准备后一次性替换”，不能先清空当前站点。

完整恢复背景、方法签名和字节码陷阱保留在 [DEVELOPMENT_HISTORY.md](DEVELOPMENT_HISTORY.md#5-spider-引擎契约phase-0-固化结论勿重做)。

## 10. 构建与验证

```powershell
npm run test:all
npm run build:py
npm run build:win
```

`test:all` 依次执行 Python 测试、Node 单元测试和 JavaScript 语法检查。Windows 已生成 NSIS 安装包；macOS/Linux 配置存在但尚未完成实机验证。
