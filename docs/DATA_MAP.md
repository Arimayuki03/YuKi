# YuKi 数据地图

更新时间：2026-08-17

本文盘点当前代码真实使用的数据位置，作为后续把业务数据从渲染层迁移到主进程/后端时的基线。

## 渲染层 localStorage

| 键 | 读写位置 | 用途 | 性质 |
|---|---|---|---|
| `yuki_home_empty_classes` | `src/renderer/js/home.js` | 各源空分类探测结果及 TTL | 派生缓存，可清理 |
| `kazumi_bgm_cover` | `src/renderer/js/kazumi.js`、`panels.js` | Bangumi 封面搜索结果缓存 | 派生缓存，可清理 |
| `popular_cache` | `src/renderer/js/popular.js`、`panels.js` | 首页推荐数据缓存 | 派生缓存，可清理 |

当前收藏、历史、观看统计、最近观看和配置历史不直接写 `localStorage`，而是通过 preload 的 `settingsGet/settingsSet` 写入 Electron `userData/settings.json`。因此，渲染层 localStorage 已收敛为 UI/派生缓存范围；下一步可把三类派生缓存改成统一 cache API，但不影响业务数据一致性。

## Electron userData

| 文件/目录 | 读写方 | 内容 |
|---|---|---|
| `settings.json` | `src/main/settings.js` + preload | 收藏、历史、观看统计、最近观看、源 URL/历史、主题/播放/分页等设置 |
| `dl-records.json` | `src/main/dl-record.js` | aria2/HLS 下载记录 |
| `logs/` | `src/main/logger.js` | 主进程与渲染层日志 |
| `mpv-watch-later/` | `src/main/index.js`、mpv | mpv 续播位置 |
| `vendor/` | 主进程资产下载器 | 用户级 mpv/ffmpeg/aria2/着色器补装产物 |

## 后端 `~/.yuki` 或自定义缓存目录

| 路径 | 读写方 | 内容 |
|---|---|---|
| `cache/kv/` | `cache_store.py` | spider KV 缓存，带 TTL 与容量上限 |
| `cache/js_local.json` | `js-engine/quickjs_host.py` | JS spider 的 `local` 存储，按站点隔离 |
| `cache/py/` | `config.py` | 远程 Python spider 落盘缓存 |
| `cache/jar/` | `jar_bridge.py` | 下载的 JAR 与校验信息 |
| `cache/jar-runtime/` | `jar_bridge.py` | JAR JVM 的 Cookie/运行时状态，避免写仓库根目录 |
| `logs/python-backend.log` | `server.py` | Python 后端日志 |
| `last_repo.txt` | `config.py` | 多仓上次成功条目偏好 |

## 关键写入约束

- 所有 Electron 设置写入必须经过 `settings` 白名单和 preload IPC；渲染层不直接操作主进程 JSON 文件。
- 后端 Cookie、JAR 运行时目录不能落到仓库根目录；JAR JVM cwd 固定为 `cache/jar-runtime`，并兼容迁移历史遗留目录。
- 配置热更新先构建完整新状态，再一次替换 `SiteManager.sites`；旧站点随后销毁，避免请求看到空窗。
- 派生缓存可以清理，业务数据不能随“清空缓存”删除。

## M-30 竞态复测矩阵

| 场景 | 当前防护 | 仍需真实界面复测 |
|---|---|---|
| 快速连续搜索/换词 | 搜索 token / SSE 会话号 | 是 |
| 快速切源/配置热载入 | config 原子替换、页面会话 token | 是 |
| 收藏与观看统计同时写入 | settings IPC 串行写穿透缓存 | 是 |
| 下载完成、删除与记录落盘并发 | `DlRecordStore` 单进程写入与文件重读 | 是 |
