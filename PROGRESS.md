# 影视 PC — 开发总纲（跨会话续作唯一入口）

> 续作开发只需读本文件。本文档已整合原 `重构方案.md`、`PHASE0_依赖矩阵.md`、`BUILD.md`、`FEATURES.md`、`PROGRESS.md` 五份文档，其余 md 已删除。
> 约定：改动架构/链路前先更新「§4 架构决策」；新增功能后在「§7 功能清单」补一行；收尾跑 `npm run test:all` 全绿。
> 行号锚点目录（编辑后若漂移，grep `^##` 重新定位）：§1 项目概述 L9 · §2 Phase 总览 L17 · §3 环境与命令 L33 · §4 架构决策 L57（子节：进程通信 L59 / 插件爬虫 L66 / 前端UI L77 / 文件管理 L86 / 下载 L91 / 推送设置解析 L99）· §5 Spider 契约 L130 · §6 构建打包 L145 · §7 前端注意与功能 L165（注意事项 L167 / 功能概览 L177）· §8 已知坑位 L188 · §8.7 待完成 L208 · §8.8 进行中任务 L215

---

## 1. 项目概述

将 Android TV 盒子视频源聚合应用（CatVod 架构）重构为 PC 桌面端。Phase 0~8 已全部完成。

- **源应用**：Leanback 原生 UI + WebView 辅助面板 + Chaquopy Python 3.10 后端 + QuickJS JS 爬虫 + mpv/FFmpeg + 迅雷 SDK（逆向产物在 `../apk_analysis/`）。
- **目标架构（已实现）**：Electron 31（JS 非 TS）+ 独立 Python 后端进程（FastAPI，Python 3.14 venv）+ mpv 独立窗口 + quickjs-ng JS 引擎 + aria2c 下载 + ffmpeg（HLS 合成/抓帧）。
- **本期不做**：直播 UI 已实装基础版；DLNA 投屏、P2P/P3P、ed2k/thunder 协议不做；自动更新未接（见 §8.7）。

## 2. Phase 总览（全部完成 ✅）

| Phase | 内容 | 验证 |
|---|---|---|
| 0 | 资产提取与源码恢复 | 4 个核心 py 高保真重建，TOTAL DIFF: 0 |
| 1 | Electron + Python 宿主骨架 | 冒烟 13/13 |
| 2 | 主 UI（首页/搜索/详情/播放入口） | 前端链路 11/11 |
| 3 | 爬虫引擎（Py/JS spider、ESM、CMS、config、SSE 聚合搜索） | 测试 23/23 |
| 4 | mpv 播放器（独立窗口 + ASS 弹幕基建 + 连播） | 集成测试全绿 |
| 5 | 文件管理（白名单根 + 防穿越 + 本地播放） | 26/26 |
| 6 | 下载（aria2c JSON-RPC + UI + 通知） | 13/13 |
| 7 | 推送/设置/VIP 解析隐藏窗口 | 14/14 + 7/7 |
| 8 | 打包（Windows NSIS 安装包已出） | exe 已生成 |

单人开发顺序记录：0 → 1 → 3 → 2 → 4 → 5 → 6 → 7 → 8。

## 3. 环境快照与常用命令

**环境**（2026-08-07 验证）：Python 3.14.4 + venv（fastapi 0.141 / uvicorn 0.52 / lxml 6.1.1 / requests 2.34 / quickjs-ng 0.16）；Node v24.18.1 + Electron 31.7.7；mpv v0.41.0（shinchiro 构建）；aria2c v1.37.0；ffmpeg 由启动时 ensureFfmpeg 自动下载。

```powershell
# 工作目录 video-pc；PowerShell 用 ; 不用 &&
# 后端冒烟（无需 Electron）
python-backend\.venv\Scripts\python.exe python-backend\tests\smoke.py
# Phase 3 全链路测试（Py/JS 双源 config + SSE）
python-backend\.venv\Scripts\python.exe python-backend\tests\test_phase3.py
# 单独跑后端
python-backend\.venv\Scripts\python.exe python-backend\server.py
# 启动完整应用
npm start
# 手动下载二进制（mpv/aria2 通常由脚本覆盖；ffmpeg 约 90MB）
node scripts\download-binaries.js mpv
node scripts\download-binaries.js aria2
node scripts\download-binaries.js ffmpeg
# 一键回归（smoke + phase3 + py 编译 + src js 语法检查）
npm run test:all
# 打包 Python 后端 + Windows 安装包（见 §6）
npm run build:py
```

## 4. 架构决策（续作时遵守，改前先更新本节）

### 进程与通信
1. **进程模型**：Electron 主进程 spawn Python 子进程；后端打印 `VPC_BACKEND_READY port=<p> token=<t>` 到 stdout，python-bridge 解析后经 IPC 给渲染层。
2. **鉴权**：服务绑 `127.0.0.1` + 随机端口 + 一次性 token（`VPC_TOKEN` 环境变量可固定）。`/health`、`/cache`、`/proxy` 免 token（spider 回环调用不带 token）；其余端点须 `?token=` 或 `X-Token` 头。
3. **缓存协议**：`/cache?do=get|set|del&key=`，value 原样字符串存取；`expiresAt` 过期判断在 spider 侧（保持原版语义），存储层不做过期；文件层按 sha1(key) 命名。
4. **代理协议**：`/proxy?do=py&...` → `runner.localProxy(param_dict)`；结果支持 `[code, mime, body]` / `[code, mime, body, headers]` / 字符串(302) / dict。
5. **数据目录**：`~/.video-pc/`（cache / cache/py / logs），由 `hoststate.ensure_dirs()` 创建。缓存目录可自定义（决策 48）。

### 插件与爬虫
6. **插件加载**：本地文件走 `SiteManager.load_local`（SourceFileLoader）；http/内联源码走 `SiteManager.load_api` → 恢复版 `app.spider()`（下载到 `~/.video-pc/cache/py`）。插件约定：顶层类名 `Spider`，继承 `base.spider.Spider`，必须实现 `init`。
7. **兼容层**：`compat.py` 为 3.12+ 补回 `SourceFileLoader.load_module`（3.12 已移除），保证恢复源码零改动。venv 在 `python-backend/.venv`。
8. **JS 引擎选 quickjs-ng**（PyPI 包名，import 名 `quickjs`；cp310-abi3 轮子兼容 py3.14）。原生回调只能传/收标量 → HTTP 桥返回 JSON 字符串。
9. **ESM 处理**：quickjs-ng `ctx.module()` 仅支持匿名单参模块，故用 `esm_to_script()` 把 export 收集到 `globalThis.<ns>`、import 注释掉，当普通脚本 eval。多模块 spider 经 `module_resolver.py` 递归抓依赖（上限 40）+ 逐模块 IIFE 隔离执行。
10. **方法调用桥**：`__VPC_CALL__(method, argsJson)`；异步方法返回 `'__PROMISE__'`，Python 侧 `execute_pending_job()` 泵微任务（上限 10 万次）后 `__VPC_FETCH_RESULT__()` 取结果。
11. **JsSpider 动态子类**：base Spider 按类隔离单例，多 JS 站点必须 `type(f'JsSpider_{key}', ...)` 各自建类。
12. **config 热更新协议**：`do=setting&name=config&text=<URL或JSON>` → ConfigManager.load，立即返回 `{code:202}`，后台线程执行，`do=configTask` 查状态（loading/done/error）。热更新必须"先纯构建（_prepare）后一次性热换（_apply）"，禁止先 destroy_all。另提供 `do=loadConfig`、`GET /sites`。
13. **站点类型支持面**：type=3 Python（http .py / 内联）、type=4 与 type=3+http .js 直链（JS spider）、type=0/1 CMS（苹果 CMS JSON/XML，`cms_spider.py` 纯 HTTP）。api 相对路径按配置 URL urljoin。TVBox jar 型源（api=csp_XXX）与 drpy 源识别后跳过，勿当 Python 源码执行；spider.jar 依赖 Android API，勿尝试 JRE。多仓 config（顶层 `urls`）按序预检兜底（上限 12 条），首个 `sites>0` 生效。
14. **JS init 双协议**：CatVod 单文件收字符串（`init_protocol='string'`）；TVBox/FongMi 多模块源收对象 `{skey, stype, ext}`（`'fongmi'`）。

### 前端与 UI
15. **Electron 用 JS 非 TS**：省去构建步骤；后续可迁 TS。
16. **主 UI 布局**：左侧主导航（首页/搜索/直播/收藏/历史/直链播放/下载/工具面板/设置）+ 右侧视图区；工具面板为源配置/本地文件两页签；公共逻辑在 `js/common.js`，`panels.js` 暴露 `initAuxPanels()` 由 `app.js` 启动时调用一次。设置已拆为侧栏独立视图 view-settings（决策 53）。
17. **播放源解析**：`vod_play_from` 按 `$$$` 分源、`vod_play_url` 按 `$$$` 对齐、每源内 `#` 分集、集内 `$` 分名址。选集点击走 `do=playerContent` 得 `{url, parse}`。
18. **播放 IPC 契约**：`window.vpc.playUrl(url, meta)` → 主进程 `vpc:play` 返回 `{ok, reason, anime4k}`；mpv 缺失返回 `{ok:false, reason:'mpv-missing'}`，渲染层提示后走 `<video>` 预览（m3u8 不给内嵌预览，只留复制地址）。
19. **Esc 派发**：`common.js dispatchEsc()` 先关对话框栈，再自顶向下调用视图 `registerEsc` 处理器；全局仅一处 keydown 监听（`app.js`）。
20. **弹幕链路已移除**（用户要求）：面板页签/设置项/主进程轮询全删；后端 `/danmaku` 端点与 mpv ASS 基建保留但无人调用。**新增功能勿再引入弹幕。**
21. **经典脚本全局词法陷阱**：渲染层顶层 `const X` 不会成为 window 属性。跨脚本全局对象一律 `typeof X !== 'undefined'` 判断后直接用标识符，**禁止 window.X 探测**。

### 文件管理
22. **本地文件走主进程**：浏览/上传/删除全部 IPC + `file-manager.js`，后端无该组端点；相对路径经 `resolveSafe()` 规范化后必须仍在白名单根内，拒绝 `..`/绝对路径/盘符跳转；根目录持久化 `<userData>/file-manager.json`，未设置默认=下载目录（决策 75）；前端只见相对路径。
23. **上传实现**：主进程系统对话框选源 + `fs.copyFileSync`（不经渲染层 FormData）。
24. **本地播放链路**：`vpc:file-push` 校验白名单 + isMedia（视频+音频）后直接 mpv.play。

### 下载
25. **下载引擎**：`downloader.js` 惰性 spawn `aria2c --enable-rpc`（随机端口 + secret）；渲染层经 `vpc:dl` 单通道 action 分发；主进程 1s 轮询 tellActive/Waiting/Stopped 聚合推 `vpc:dl-list`，渲染层无状态只渲染。aria2 参数：`--seed-time=0 --max-concurrent-downloads=3 --continue=true --file-allocation=none`（并发数 settings.dlConcurrency，changeGlobalOption 即时生效）。
26. **aria2 删除语义**：`remove` 只对 active/waiting/paused 有效；stopped 任务需 `removeDownloadResult`（downloader.purge）。
27. **完成通知链路**：downloader emit completed（gid 去重）→ Notification + `vpc:dl-event` toast；一键播放 `vpc:dl-play` 直接播产出文件（不受白名单限制）。
28. **下载目录**：默认系统 Downloads，键 `dlDir`；换目录走 `vpc:dl pickDir` → dl.stop()+dl.start(newDir)（引擎重启，任务可续传）；种子档经对话框选文件 → base64 → addTorrent/addMetalink。
29. **系统代理任务级注入**（决策 79）：代理不能烘焙进 CLI 参数；addUri/addTorrent/addMetalink 时经 `system-proxy.js` 读实时代理写入任务级 options（WinINET 注册表/环境变量，5s TTL）。三通道：aria2 任务级、ffmpeg 子进程 http_proxy、m3u8 探测走 net.fetch。
30. **m3u8 下载走 ffmpeg 通道**（决策 71）：`hls-downloader.js`，ffmpeg -c copy 拉流合成（AES-128 内嵌 KEY 自动解密，bsf 失败不带 bsf 重试一次）；进度=先抓播放列表估时长、stderr time= 折算；gid 前缀 `hls-`；任务结构 kind:'hls' 与 aria2 对齐。**临时文件名必须保留 .mp4 扩展名**（如 xxx.mp4.incomplete.mp4，ffmpeg 按扩展名推断容器）。

### 推送/设置/解析
31. **推送链路**：面板手动推送与局域网推送共用主进程 playPushedUrl（mpv + 通知 + `vpc:push-received`）；push-server 绑 0.0.0.0 随机端口 + token，仅收 http(s)，GET `/` 有说明页；非直链页面用 parse-window `captureDirect` 抓媒体请求；后端不处理 do=push。
32. **设置持久化**：`settings.js` 存 `<userData>/settings.json`，键 camelCase。约定键：lastConfigUrl / playerVolume / customLives / dlDir / configHistory / favorites / history / theme / wallpaper / colorMode / fontSize / textSize / textColor / wallpaperDim / blockedSites / probedSites / playerHotkeys / navCollapsed / playerSpeed / autoNext / resumePos / bgPlay / animEnabled / closeAction / incognito / cacheDir / dlConcurrency 等。自定义数据键（customLives、lastConfigUrl、favorites、history、dlDir、cacheDir、configHistory）在 `settings.reset()` 中显式保留。
33. **配置自动重载**：setting(name=config) 成功后渲染层存 URL 与历史；启动时主进程在 backend ready 后 POST do=setting 自动重载，成功发 `vpc:config-reloaded`，前端 Home/Live 刷新。
34. **配置重载状态机**（修首屏）：主进程 `configReload = {reloading, url}`，backend ready 进入重载时同步置位，所有收尾路径经 `finishReload(ok, sites)` 复位并发 `vpc:config-reloaded`；渲染层经 `vpc:config-state` IPC 取权威状态，app.js waitConfigDone 双状态轮询。改动启动链路时保持该状态机。
35. **VIP 解析**（决策 38/33）：parses 来自 config（/sites）。parse=1 全自动起播流程：地址已是媒体直链 → 直接 mpv；否则 type=1 JSON 接口优先直接 fetch（兼容 url/data.url/vurl/play_url 多字段，抓返回里的 Referer/UA 交 mpv，解出 .html 视为失败）→ 失败再 iframe 型隐藏 BrowserWindow（partition 'parse' 独立 session，webRequest.onBeforeRequest 捕获 resourceType=media 或媒体扩展名）→ 再失败 `vpc:capture-direct`（隐藏窗口直开链接抓页面自身播放器请求）。每接口 20s 超时按序尝试。解析窗口 sandbox=true + nodeIntegration=false + contextIsolation=true，用后即 destroy。mpv 经 `--http-header-fields` 注入 Referer。
36. **缓存统计**：`do=cacheSize` 返回 `{bytes, items}`（KV 目录 + js_local.json + cache/dl）；`do=clearCache` 返回释放字节数；设置页签清理按钮先展示再清理。
37. **直播 mpv 健壮性**：TXT 源频道行多地址解析为 `fallbackUrls`；起播后 `mpvStartedOk()` 用 core-idle 轮询 8s 判断真实开播，未开播自动切备用线路并推 `vpc:play-retry`，全失败推 `vpc:play-failed`。
38. **连播统一为渲染层驱动**（决策 70，替代旧队列/接力双方案）：每次只交 mpv 单集（**不传 playlist**），Player._seq 保存 `{site, flag, title, episodes, index}` 上下文；`vpc:player-exit` 附退出进度 `{pos, duration}`；「看完」双判据：剩余 < 8 秒，或 IPC 抢不到进度时 10 秒内收到过 ended 事件；看完且队列有下一集则 play() 递归推进，用户提前关闭则 _seq=null 终止链。教训：IPC 负载嵌套字段必须双端对齐校验（曾误读 payload.playlist 致连播恒单集）。
39. **播放会话制**（决策 78）：mpv 每次起播分配自增会话号，随 playUrl 返回并附在 exit 事件；渲染层仅处理与当前会话匹配的退出，防切集时旧进程延迟退出误推进、本地/推送播放（noSeq 负号）干扰连播、exit 处理期间又起新播（_playToken 双保险）。断流重连由主进程直接 mpv.play 起新会话，经 `vpc:player-session` 同步，重连集播完仍可续连播；「开播≥15s 且剩余≥8s 的媒体直链」退出不置空 _seq 等待重连。
40. **断流自动重连**（决策 59）：proc exit 回调趁 IPC 未拆除抢读 time-pos/duration（Promise.race 400ms），剩余 ≥8s 视为断流 → 重播当前集一次（watch-later 自动续位）+ 系统通知；剩余 <8s 是正常播完，开播 <15s 退出是起播失败（另有直播备用线路），均不重试；_stallRetried 每会话一次。
41. **mpv 播放偏好注入**（决策 47）：续播用 mpv 原生 watch-later（--save-position-on-quit + --watch-later-directory，userData/mpv-watch-later），直播地址 meta.fallbackUrls 存在则 resume=false 不记录；默认倍速 --speed；音轨/字幕语言 --alang/--slang（playerAlang/playerSlang）；偏好变更经 `vpc:update-player-prefs` 下次起播生效。
42. **mpv 快捷键自定义**（决策 45）：settings.playerHotkeys 步长 → 主进程 writeMpvAssets 生成 userData/mpv-scripts/input.conf + lua 提示脚本；起播经 --input-conf / --scripts 加载；`vpc:update-hotkeys` 修改后重写（下次起播生效）。
43. **详情页下载**（决策 50）：选集勾选（.ep-check 阻止冒泡）或悬停单集图标；下载前逐集 playerContent 判断 parse，parse=1 走 vpc:parse 解直链（带 Referer）。vpc:dl add 扩展 out/header：out=「片名 - 集名 + URL 扩展名」（非法字符替换 _）；m3u8 切片流 aria2 无法下载单独计数提示；批量串行解析避免隐藏窗口并发冲突。多选集播放复用连播机制（勾选集按序作为 episodes 交 Player.play）。
44. **选集倒序只翻展示不动下标**（决策 77）：Detail._epDesc 仅翻转渲染顺序，data-idx 始终为原下标，连播/勾选下载不受影响。
45. **线路记忆 + 失败自动换线**（决策 83）：切线路持久化 `settings.lastSourceMap`（键 `site|vodId`）；`Player.play()` 返回 `{ok, reason}`；失败自动循环尝试下一线路（mpv 缺失不换线），全失败恢复最初线路。
46. **收藏/历史**（决策 39/81）：条目结构一致（site/vodId/name/pic/remarks/ts），存 settings 各上限 200 最新在前；records.js makeRecordView 工厂共用；历史在 Detail.open 自动写入（隐身模式 incognito 除外），**历史按片名去重合并**（跨源同名合并置顶，保留原显示名）；想看/已看 tag 三态（want/seen/''，normTag 归一，决策 74），详情按钮与收藏卡徽章双通道共写（setFavTag/getFavTag 唯一读写口，决策 66）。
47. **空源自动探测屏蔽**（决策 41）：首屏就绪后异步探测未探过站点（probedSites 防重复），homeContent 推荐位有内容即过，否则复查首分类；空/错记入 blockedSites 过滤首页下拉（不打断当前选中源，被屏蔽自动切首源），并发 4；仅过滤首页下拉，搜索 SSE 仍全源聚合；源配置「屏蔽源」卡片可恢复重探、查看屏蔽源列表。
48. **首页/分类渐进加载**（决策 51）：首屏数据一到立即 renderGrid + hideLoading，剩余铺满量后台逐页 _appendGrid 增量追加；_loadToken 令牌防串流（切源/切分类/翻页后旧循环回来先比令牌）；自适应目标 36~120；resize 补拉沿用当前令牌。首页搜索只走当前源自身 searchContent（决策 65），不走聚合 SSE。
49. **搜索结果分组分页**（决策 80）：每源分组默认展示前 30 条（SEARCH_PAGE_SIZE=30），超出折叠，「展开全部 N 条」/「收起」；来源筛选纯前端 toggle src-group 不重发请求（决策 58）。
50. **直播源**：config `lives` 三形态（{name,url} 直链 / {group,channels} 嵌套 / proxy://do=live&ext=base64），live.js normalizeLive 统一归一化；频道文本经后端 do=fetchText 拉取（渲染层直 fetch 会被 CORS 拦），支持 txt(#genre#)/m3u；自定义源存 settings.customLives（TVBox 式导入：txt/m3u 地址、粘贴配置 JSON、.json 配置地址，展平嵌套 channels，上限 30，决策 52）；中文域名需 punycode；customLives 增删置 Live._dirty 强制重载（决策 42）。
51. **换肤**（决策 40/73）：主题色 6 套内置（html[data-color] 覆写 MD3 变量）+ 自定义单基色 HSL 推导浅深两套（html.theme-custom，customColor 与 theme 互斥）；明暗 auto/light/dark 由 common.js applySkin 挂 html.dark 类（废弃 @media）；壁纸 vpc:pick-wallpaper 写 settings.wallpaper，渲染层 toFileUrl 铺 body + --wall-veil 遮罩三档；界面缩放 60~200 写 html.style.zoom，字体大小 80~200 注入临时样式表按基准字号等比（决策 55），change 钳制回写。
52. **托盘驻留与关闭行为**（决策 46）：closeAction 三态 tray(默认)/exit/ask；托盘图标代码生成 16x16 PNG 免资源；bgPlay 开启时选退出但 mpv 在播也转托盘保播；isQuitting 区分真退出与托盘驻留；恢复默认设置只清偏好保留数据类键后 relaunch。
53. **缓存位置自定义**（决策 48）：hoststate 统一管理 cache_dir（kv/dl/py），主进程经 python-bridge.extraEnv 注入 VPC_CACHE_DIR，server.py main() 读取后 configure 再 ensure_dirs；换目录需重启后端（端口/令牌变），渲染层 onBackendReady → setBackendInfo 刷新连接信息；旧目录缓存不迁移。
54. **Anime4K 超分**（决策 60/69/64）：不内置 glsl；download-binaries.js anime4k 从 bloc97/Anime4K 拉 v4.1 Mode A 链 6 个 glsl（仓库按 Restore/Upscale/Experimental-Effects 分子目录，扁平存 vendor/anime4k）；启动 ensureAnime4k fetch 补齐缺失；文件齐全才 buildAnime4kChain 拼链（win 分隔符 ';'）注入 --glsl-shaders，缺文件静默降级；从未设置过开关默认开启（手动关过保持关）；**状态以起播反馈为准**：vpc:play 返回 anime4k 标志，toast 明示「超分已生效」。
55. **ffmpeg 内置化**（决策 72）：m3u8 合成与本地预览图共用；启动 ensureFfmpeg 幂等下载 gyan.dev essentials（约 90MB）→ vendor/ffmpeg，失败静默降级、其次探测 PATH；缩略图 5s 处抓帧缩 480 宽 jpg，md5(路径|mtime|大小) 缓存 userData/local-thumbs，并发 4。
56. **鼠标侧键导航**（决策 63/67）：视图级两栈 _navStack/_navForward（showView 入栈同顶去重，新跳转清前进链，栈底不弹）；app-command 与 mousedown button 3/4 双通道，400ms 时间戳去重防双跳。
57. **确认对话框**（决策 54）：全部 confirm 用 common.js confirmDialog（md-dialog 风格，Promise<boolean>，Esc/遮罩=取消）；_confirmResolve 持有待决回调，closeDialog 未决按取消 resolve(false) 防挂死；done 先置空再 closeDialog 防双重 resolve；okText/cancelText 可定制。
58. **二进制存放与路径适配**（决策 84）：vendor/{mpv,aria2,ffmpeg,anime4k}（.gitignore 忽略）；开发模式 ROOT=`path.join(__dirname,'..','..')`，打包模式 `process.resourcesPath`；`index.js` 统一 `RESOURCES_ROOT = app.isPackaged ? process.resourcesPath : ROOT`；python-bridge 打包后启动 PyInstaller exe。
59. **mpv 二进制来源**：shinchiro/mpv-winbuild-cmake latest release 动态取 tag（官方 mpv 无 Windows 发行）；.7z 用 Windows 内置 tar 解（勿用 unzip）。

## 5. Spider 引擎契约（Phase 0 固化结论，勿重做）

- 源码来自 `apk_analysis/extracted/assets/chaquopy/app.imy`（**实为标准 ZIP**）内 Python 3.10 `.pyc` 高保真重建，校验脚本 `../apk_analysis/verify_recovered.py`（TOTAL DIFF: 0）。重建源在 `../apk_analysis/recovered_python/`，已复制进 `python-backend/`：`app.py` / `runner.py` / `trigger.py` **原样未动**；`base/spider.py` 仅替换 3 处 Android API：
  | # | 方法 | PC 端替换 |
  |---|---|---|
  | 1 | `loadModule` 的 getCacheDir | `os.path.join(APP_DATA_DIR, 'cache')` |
  | 2 | `getProxyUrl` | `http://127.0.0.1:{port}/proxy` |
  | 3 | `getCache/setCache/delCache` | 本地 `/cache` 端点（expiresAt 过期语义保留） |
- **app.py 模块级入口**（第一参数 `ru` 为 Runner 实例，返回均为 JSON 字符串）：spider(cache, api) / getDependence / getName / init(ru, extend) / homeContent(ru, filter) / homeVideoContent / categoryContent(ru, tid, pg, filter, extend) / detailContent(ru, array) / searchContent(ru, key, quick, pg='1') / playerContent(ru, flag, id, vipFlags) / liveContent / localProxy / action / destroy。入参 array/vipFlags/extend/param 先 `str2json`。
- **字节码细节陷阱**：① Spider 单例（`__new__` + `_instance`），`init` 是 abstractmethod 子类必须实现；② `str2json/json2str` 原版未写 self，按类方法语义用，勿"修复"；③ fetch/post 默认 `timeout=5, verify=True, stream=False, allow_redirects=True`，响应强制 utf-8，勿改默认值；④ getCache 过期自动 delCache 返回 None，setCache 把 int/float 转 str、dict/list 转 JSON；⑤ app.spider() 支持 http 地址（递归跟 Location）与内联源码（str.encode 直写）两种 api；⑥ cleanText emoji 正则含字面 emoji，文件必须 UTF-8；⑦ 插件加载用 SourceFileLoader（3.12+ 经 compat.py）。
- **pip 依赖**（requirements 已锁定）：requests 2.34.2 / lxml 5.3+ / pycryptodome 3.21 / beautifulsoup4 4.15 / pyquery 2.1 / cssselect / cachetools / certifi 等传递依赖；ujson 无 3.14 轮子未收录。
- **quickjs 宿主须提供 TVBox 全局**：`local`（key+kv 两级 KV，落盘 `~/.video-pc/js_local.json`）、`md5X`、`js2Proxy`、`TextEncoder/TextDecoder`；HTTP 响应同时带 `content` 与 `data` 字段。缺任何一个，jadehh 系源报 "xxx is not defined"。
- **Spider 返回值契约**：必须返回 dict（app.py 包装层统一 json.dumps）；返回 JSON 字符串会被二次序列化致前端取不到 list。
- **CMS 适配要点**：XML（type=0）子标签无 vod_ 前缀，`_xml_video` 负责映射 + $$$ 拼多线路；JSON（type=1）vod_id 为整数，接收 ids 的入口一律先 `str(i)` 再 join。

## 6. 构建与打包

```powershell
# 开发模式：npm install → node scripts\download-binaries.js → npm start
# 打包：
npm install                                    # 首次
python-backend\.venv\Scripts\pip.exe install pyinstaller   # 首次
npm run build:py                               # → python-dist/video-pc-backend.exe（约 50MB）+ 数据目录 js-engine/spiders/base
# Windows 安装包（国内需镜像；PowerShell 用 $env:VAR=... 语法）
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
$env:CSC_IDENTITY_AUTO_DISCOVERY="false"
npx electron-builder --win --publish=never --config.directories.output="C:/temp/vpc-dist"
```

- **产物**：`影视 PC Setup 0.1.0.exe`（NSIS，约 175 MB）+ `win-unpacked/`（约 1.7 GB）；macOS/Linux 预留未测。
- **electron-builder 配置**在 `package.json` 的 `"build"` 字段：extraResources `python-dist/` → `resources/python-backend/`、`vendor/` → `resources/vendor/`；files 排除 `.venv/`、`__pycache__/`、`.pyc`、`tests/`；NSIS 可选安装路径 + 快捷方式 + 中英文。
- **打包后目录**：`resources/app.asar` + `resources/python-backend/`（video-pc-backend.exe + js-engine/spiders/base）+ `resources/vendor/`（mpv/aria2/ffmpeg/anime4k）。
- **已知问题**：① Windows Defender 锁文件 → 用外部输出目录 C:/temp/vpc-dist；② winCodeSign macOS dylib 符号链接报错不影响安装器生成；③ 自定义图标已配置（assets/icon.png → .ico，8.7.3 完成）；④ 无代码签名（CSC_LINK/CSC_KEY_PASSWORD 未配）；⑤ PyInstaller 警告 tzdata hidden import not found（非关键）。

## 7. 前端修改注意事项与功能清单

### 修改注意事项（必读）
1. **滚动容器**是 `.view` 元素（overflow-y:auto），回顶部用 `$('#view-xxx').scrollTop(0)` 而非 window.scrollTo。
2. **mpv 全屏状态追踪**：退出时 IPC 查询 fullscreen 不可靠（mpv 先退全屏），必须 observe_property 实时追踪用缓存值。
3. **异步取消**用 token 模式（_loadToken / _probeToken / _playToken）防过期回调。
4. **确认操作**用 confirmDialog，不用原生 confirm。
5. **播放器功能联动文件链**：`mpv-player.js`（核心）→ `index.js`（IPC + 启动初始化）→ `preload.js`（桥接）→ 渲染层 JS + `index.html`（UI）。
6. **UI 文案统一简体中文**：新增文案勿用繁体/台式用词（视窗→窗口、资料夹→文件夹、档案→文件、侦测→检测、支援→支持、视讯→视频、搜寻→搜索、重新整理→刷新、影片→视频）。
7. **不要重新引入已回滚功能**：弹幕功能。（2026-08 解禁）视频缓存到硬盘切换与直播源后台探测已应用户要求恢复为正式功能（见 §8.8 T1/T3）；二者历史上曾回滚，重新实现须保证：探测全程静默无阻塞、换缓存路径必须清理旧目录且防误删。
8. **封面防盗链**：所有 `<img>` 加 `referrerpolicy="no-referrer"`；`//` 开头补 https（common.js normalizePic，非 http(s)/data 协议视为无封面走占位）；兜底图 assets/cover-fallback.svg，onerror=null 防循环。

### 已实现功能概览（U 批次 U1~U115 摘要，细节见对应决策号）
- **启动与配置**：首屏配置重载状态机（U1/37）、历史源/直播历史源卡片（U22/75/81）、自动屏蔽空源（U20/41）、缓存大小清理（U7/35）、版本号（U21→U72 移至系统卡）。
- **首页/分类/搜索**：渐进加载铺满（U4/12/34/64/51）、搜索封面修复（U5/33）、搜索来源筛选（U80/58）、分组分页折叠（决策 80）、首页当前源搜索（U94/65）、历史按片名去重（决策 81）。
- **详情页**：简介段落化（U3/11/107）、封面放大单例浮层滚轮缩放（U15/58/60）、收藏/想看已看（U16/89/95/106/74/66）、线路记忆+自动换线（决策 83）、选集倒序（U107/77）、多选集播放/下载（U59/91/50/62）。
- **播放**：mpv 基础控制 lua OSD（U27）、快捷键自定义（U32/45）、全屏倍速延续（FEATURES#3，observe_property）、记忆播放（U44/47）、自动连播开关（U45）、默认倍速/语言偏好（U48/104）、断流自动重连（U86/59）、连播重写渲染层驱动（U106/70）、会话制防竞态（U109⑦/78）、Anime4K 超分（U85/93/99/60/69/64）。
- **直播**：mpv 健康检测备用线路（U2/36）、TVBox 式导入（U65/52）、频道可用性探测（2026-08 起改静默后台探测，见 §8.8 T1）、IDN punycode（U36）。
- **下载**：并发数设置（U42）、系统代理感知（U110/79）、m3u8 ffmpeg 合成（U102/103/71/72）、合成与删除修复（U111）、删除失败下载清理产物（U112）、打开下载目录（U74）、设置归位（U66/53）。
- **收藏/历史**：视图工厂共用（U16/17/39）、搜索+标签（U89/61）、多选删除（U63）、编辑标题（U41/57）、源标识徽章化（U29/69/78/57）、跨源去重（决策 81）。
- **外观**：主题色/自定义色（U19/101/73）、明暗/缩放/字号数值化（U26/35/71/55）、壁纸遮罩（U19/76）、字体颜色大小（U31）、动画开关（U46/39）、弹窗 flex 居中修复（U113/54）、隐藏滚动条（U62）、4K 自适应（U56）、圆角统一（U52/54）、设置布局（U53/87/114）、占位封面资产（U51/68/56）。
- **系统**：托盘驻留/后台播放（U43/46）、隐身模式（U47）、恢复默认（U50）、缓存目录自定义（U49/48）、资产状态卡（决策 82）、mpv 自定义路径（FEATURES#6）、鼠标侧键导航（U92/97/63/67）、本地文件卡片网格预览图分页（U105/114/115/112）、直链播放视图（U18/37）、侧栏收缩（U38）、回到顶部（U40）、自定义应用图标（8.7.3）。

## 8. 已知坑位（踩过的，别再踩）

- PowerShell 不支持 `&&`，用 `;`；中文输出经 `Out-File` 易乱码，脚本输出用 ASCII。
- `SourceFileLoader.load_module()` 3.12+ 不存在 → 必须经 `compat.py`（server.py 已 import）。
- lxml 6.1.1 支持 py3.14；测试用 python 必须在 `python-backend\.venv`（系统 python 无 fastapi/pytest）。
- quickjs-ng：`add_callable` 只能收/返标量，返回 dict 报错 → 一律 JSON 字符串桥接；`ctx.get('obj')` 返回 Object 无属性访问 → 方法调用走 eval/`__VPC_CALL__`；JS spider 无 destroy 方法打 "js destroy error" 日志属正常。
- `js-engine` 目录名含连字符非合法包名 → sys.path 注入后 `from quickjs_host import`。
- 多模块 ESM spider：module_resolver 上限 40 模块；新增 `export class` 形态需在 `esm_transform.py` 补规则，兜底 `_RE_EXPORT_RESIDUAL` 清除残留 export 前缀。
- config 异步任务：同步阻塞会卡住 /action 分钟级（多仓扫描），前端 fetch 加 30s 超时兜底。
- 启动自动重载两个竞态：① READY 行早于 uvicorn 监听，收到 READY 立即 POST 会 connection refused → 先轮询 /health；② `vpc:config-reloaded` 可能早于渲染层监听注册丢失 → app.js bootstrap 另加 configTask 轮询兜底。
- mpv 未开始播放（core-idle=true）时 get_property 报 "property available"，判播放状态用 core-idle 轮询而非 time-pos。
- Google Storage 样片本机不可达，demo 样片用 media.w3.org 与 vjs.zencdn.net。
- Grep 输出的缩进不可信（可能去掉行首空格），SearchReplace 前先 Read 目标行段。
- Node EventEmitter：`emit('error')` 无监听器抛 ERR_UNHANDLED_ERROR，自定义类须在构造器兜底 noop 监听（downloader.js 已做）。
- aria2 `--continue=true` 要求服务器支持 Range；测试服务器不返 206 报 "No URI available."；`writeHead` 头值 undefined 直接报错。
- Electron：最后一个窗口 destroy 触发 window-all-closed 默认退出；无界面测试脚本须 `app.on('window-all-closed', e => e.preventDefault())`。
- Chromium 启动 `WSALookupServiceBegin failed with: 10108` 为良性日志。
- session webRequest 每 session 仅一份且全局生效 → 解析窗口用独立 partition，结束 onBeforeRequest(null) 清理。
- mpv 不能直接播 HTML 页面，推送非直链走 captureDirect 抓媒体请求，抓不到返 resolve-failed。

## 8.7 待完成

- [ ] 8.7.1 macOS / Linux 平台实际打包测试
- [ ] 8.7.2 安装后首次启动验证（冷启动时间、资源路径、后端拉取）
- [x] 8.7.3 自定义应用图标（assets/icon.png 已配置并嵌入 Windows 安装器）
- [ ] 8.7.4 electron-updater 自动更新（可选，GitHub Releases）

## 8.8 进行中任务批次（T1~T5，2026-08）

| 批次 | 任务 | 状态 |
|---|---|---|
| T1 | 直播静默探测与自动刷新（HEAD→GET 回退防误杀） | 待派发 |
| T2 | mpv 本地配置兼容（scripts-append + input.conf 合并）+ Anime4K 多镜像下载加固 | 待派发 |
| T3 | 视频缓冲缓存设置（内存默认/硬盘 + 路径选择/还原/换路径清缓存） | 待派发 |
| T4 | UI 按钮/组件/字体布局检查清单式优化 | 待派发 |
| T5 | Kazumi XPath 规则引擎适配（独立排期，待用户确认） | 待确认 |
