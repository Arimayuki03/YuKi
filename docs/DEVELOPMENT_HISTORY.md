# 影视 PC — 历史开发记录

> 本文档归档 Phase 0~8、U/T 批次、历史架构决策和踩坑记录，不再作为当前待办入口。
> 当前状态请读 [../PROGRESS.md](../PROGRESS.md)，现行架构请读 [ARCHITECTURE.md](ARCHITECTURE.md)。历史内容原则上只追加或勘误。
> 本文曾整合原 `重构方案.md`、`PHASE0_依赖矩阵.md`、`BUILD.md`、`FEATURES.md` 和旧 `PROGRESS.md`，因此保留了部分历史措辞与当时状态。

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
# 工作目录 yuki；PowerShell 用 ; 不用 &&
# 后端冒烟（无需 Electron）
python-backend\.venv\Scripts\python.exe python-backend\tests\smoke.py
# Phase 3 全链路测试（Py/JS 双源 config + SSE）
python-backend\.venv\Scripts\python.exe python-backend\tests\test_phase3.py
# 单独跑后端
python-backend\.venv\Scripts\python.exe python-backend\server.py
# 启动完整应用
npm start
# 手动下载二进制（mpv/aria2 通常由脚本覆盖；ffmpeg 约 90MB；misans 为内置 UI 字体）
node scripts\download-binaries.js mpv
node scripts\download-binaries.js aria2
node scripts\download-binaries.js ffmpeg
node scripts\download-binaries.js misans
# 一键回归（smoke + phase3 + py 编译 + src js 语法检查）
npm run test:all
# 打包 Python 后端 + Windows 安装包（见 §6）
npm run build:py
```

## 4. 架构决策（续作时遵守，改前先更新本节）

### 进程与通信
1. **进程模型**：Electron 主进程 spawn Python 子进程；后端打印 `YUKI_BACKEND_READY port=<p> token=<t>` 到 stdout，python-bridge 解析后经 IPC 给渲染层。
2. **鉴权**：服务绑 `127.0.0.1` + 随机端口 + 一次性 token（`YUKI_TOKEN` 环境变量可固定）。`/health`、`/cache`、`/proxy` 免 token（spider 回环调用不带 token）；其余端点须 `?token=` 或 `X-Token` 头。
3. **缓存协议**：`/cache?do=get|set|del&key=`，value 原样字符串存取；`expiresAt` 过期判断在 spider 侧（保持原版语义），存储层不做过期；文件层按 sha1(key) 命名。
4. **代理协议**：`/proxy?do=py&...` → `runner.localProxy(param_dict)`；结果支持 `[code, mime, body]` / `[code, mime, body, headers]` / 字符串(302) / dict。
5. **数据目录**：`~/.yuki/`（cache / cache/py / logs），由 `hoststate.ensure_dirs()` 创建。缓存目录可自定义（决策 48）。

### 插件与爬虫
6. **插件加载**：本地文件走 `SiteManager.load_local`（SourceFileLoader）；http/内联源码走 `SiteManager.load_api` → 恢复版 `app.spider()`（下载到 `~/.yuki/cache/py`）。插件约定：顶层类名 `Spider`，继承 `base.spider.Spider`，必须实现 `init`。
7. **兼容层**：`compat.py` 为 3.12+ 补回 `SourceFileLoader.load_module`（3.12 已移除），保证恢复源码零改动。venv 在 `python-backend/.venv`。
8. **JS 引擎选 quickjs-ng**（PyPI 包名，import 名 `quickjs`；cp310-abi3 轮子兼容 py3.14）。原生回调只能传/收标量 → HTTP 桥返回 JSON 字符串。
9. **ESM 处理**：quickjs-ng `ctx.module()` 仅支持匿名单参模块，故用 `esm_to_script()` 把 export 收集到 `globalThis.<ns>`、import 注释掉，当普通脚本 eval。多模块 spider 经 `module_resolver.py` 递归抓依赖（上限 40）+ 逐模块 IIFE 隔离执行。
10. **方法调用桥**：`__YUKI_CALL__(method, argsJson)`；异步方法返回 `'__PROMISE__'`，Python 侧 `execute_pending_job()` 泵微任务（上限 10 万次）后 `__YUKI_FETCH_RESULT__()` 取结果。
11. **JsSpider 动态子类**：base Spider 按类隔离单例，多 JS 站点必须 `type(f'JsSpider_{key}', ...)` 各自建类。
12. **config 热更新协议**：`do=setting&name=config&text=<URL或JSON>` → ConfigManager.load，立即返回 `{code:202}`，后台线程执行，`do=configTask` 查状态（loading/done/error）。热更新必须"先纯构建（_prepare）后一次性热换（_apply）"，禁止先 destroy_all。另提供 `do=loadConfig`、`GET /sites`。
13. **站点类型支持面**：type=3 Python（http .py / 内联）、type=4 与 type=3+http .js 直链（JS spider）、type=0/1 CMS（苹果 CMS JSON/XML，`cms_spider.py` 纯 HTTP）。api 相对路径按配置 URL urljoin。TVBox jar 型源（api=csp_XXX）与 drpy 源识别后跳过，勿当 Python 源码执行；spider.jar 依赖 Android API，勿尝试 JRE。多仓 config（顶层 `urls`）优先上次成功条目（last_repo.txt，T40），首个 `sites>0` 的条目作主仓；命中后并行补拉其余条目跨仓合并（T44）：lives 按 url 去重（嵌套 channels 展平）、sites 按 key 去重追加，主仓优先只增不删；偏好条目首次失败自动重试一次。
14. **JS init 双协议**：CatVod 单文件收字符串（`init_protocol='string'`）；TVBox/FongMi 多模块源收对象 `{skey, stype, ext}`（`'fongmi'`）。

### 前端与 UI
15. **Electron 用 JS 非 TS**：省去构建步骤；后续可迁 TS。
16. **主 UI 布局**：左侧主导航（首页/搜索/直播/收藏/历史/直链播放/下载/工具面板/设置）+ 右侧视图区；工具面板为源配置/本地文件两页签；公共逻辑在 `js/common.js`，`panels.js` 暴露 `initAuxPanels()` 由 `app.js` 启动时调用一次。设置已拆为侧栏独立视图 view-settings（决策 53）。
17. **播放源解析**：`vod_play_from` 按 `$$$` 分源、`vod_play_url` 按 `$$$` 对齐、每源内 `#` 分集、集内 `$` 分名址。选集点击走 `do=playerContent` 得 `{url, parse}`。
18. **播放 IPC 契约**：`window.yuki.playUrl(url, meta)` → 主进程 `yuki:play` 返回 `{ok, reason, anime4k}`；mpv 缺失返回 `{ok:false, reason:'mpv-missing'}`，渲染层提示后走 `<video>` 预览（m3u8 不给内嵌预览，只留复制地址）。
19. **Esc 派发**：`common.js dispatchEsc()` 先关对话框栈，再自顶向下调用视图 `registerEsc` 处理器；全局仅一处 keydown 监听（`app.js`）。
20. **弹幕链路已移除**（用户要求）：面板页签/设置项/主进程轮询全删；后端 `/danmaku` 端点与 mpv ASS 基建保留但无人调用。**新增功能勿再引入弹幕。**
21. **经典脚本全局词法陷阱**：渲染层顶层 `const X` 不会成为 window 属性。跨脚本全局对象一律 `typeof X !== 'undefined'` 判断后直接用标识符，**禁止 window.X 探测**。

### 文件管理
22. **本地文件走主进程**：浏览/上传/删除全部 IPC + `file-manager.js`，后端无该组端点；相对路径经 `resolveSafe()` 规范化后必须仍在白名单根内，拒绝 `..`/绝对路径/盘符跳转；根目录持久化 `<userData>/file-manager.json`，未设置默认=下载目录（决策 75）；前端只见相对路径。
23. **上传实现**：主进程系统对话框选源 + `fs.copyFileSync`（不经渲染层 FormData）。
24. **本地播放链路**：`yuki:file-push` 校验白名单 + isMedia（视频+音频）后直接 mpv.play。

### 下载
25. **下载引擎**：`downloader.js` 惰性 spawn `aria2c --enable-rpc`（随机端口 + secret）；渲染层经 `yuki:dl` 单通道 action 分发；主进程 1s 轮询 tellActive/Waiting/Stopped 聚合推 `yuki:dl-list`，渲染层无状态只渲染。aria2 参数：`--seed-time=0 --max-concurrent-downloads=3 --continue=true --file-allocation=none`（并发数 settings.dlConcurrency，changeGlobalOption 即时生效）。
26. **aria2 删除语义**：`remove` 只对 active/waiting/paused 有效；stopped 任务需 `removeDownloadResult`（downloader.purge）。
27. **完成通知链路**：downloader emit completed（gid 去重）→ Notification + `yuki:dl-event` toast；一键播放 `yuki:dl-play` 直接播产出文件（不受白名单限制）。
28. **下载目录**：默认系统 Downloads，键 `dlDir`；换目录走 `yuki:dl pickDir` → dl.stop()+dl.start(newDir)（引擎重启，任务可续传）；种子档经对话框选文件 → base64 → addTorrent/addMetalink。
29. **系统代理任务级注入**（决策 79）：代理不能烘焙进 CLI 参数；addUri/addTorrent/addMetalink 时经 `system-proxy.js` 读实时代理写入任务级 options（WinINET 注册表/环境变量，5s TTL）。三通道：aria2 任务级、ffmpeg 子进程 http_proxy、m3u8 探测走 net.fetch。
30. **m3u8 下载走 ffmpeg 通道**（决策 71）：`hls-downloader.js`，ffmpeg -c copy 拉流合成（AES-128 内嵌 KEY 自动解密，bsf 失败不带 bsf 重试一次）；进度=先抓播放列表估时长、stderr time= 折算；gid 前缀 `hls-`；任务结构 kind:'hls' 与 aria2 对齐。**临时文件名必须保留 .mp4 扩展名**（如 xxx.mp4.incomplete.mp4，ffmpeg 按扩展名推断容器）。

### 推送/设置/解析
31. **推送链路**：面板手动推送与局域网推送共用主进程 playPushedUrl（mpv + 通知 + `yuki:push-received`）；push-server 绑 0.0.0.0 随机端口 + token，仅收 http(s)，GET `/` 有说明页；非直链页面用 parse-window `captureDirect` 抓媒体请求；后端不处理 do=push。
32. **设置持久化**：`settings.js` 存 `<userData>/settings.json`，键 camelCase。约定键：lastConfigUrl / playerVolume / customLives / dlDir / configHistory / favorites / history / theme / wallpaper / colorMode / fontSize / textSize / textColor / wallpaperDim / blockedSites / probedSites / playerHotkeys / navCollapsed / playerSpeed / autoNext / resumePos / bgPlay / animEnabled / closeAction / incognito / cacheDir / dlConcurrency / simulDownload / hlsAdFilter / watchStats / recentWatches / bangumiToken 等（playerCacheMode / playerCacheDir 已废弃，启动时由 `migratePlayerCache()` 删除，见决策 85）。自定义数据键（customLives、lastConfigUrl、favorites、history、dlDir、cacheDir、configHistory、watchStats、recentWatches、bangumiToken）在 `settings.reset()` 中显式保留。
33. **配置自动重载**：setting(name=config) 成功后渲染层存 URL 与历史；启动时主进程在 backend ready 后 POST do=setting 自动重载，成功发 `yuki:config-reloaded`，前端 Home/Live 刷新。
34. **配置重载状态机**（修首屏）：主进程 `configReload = {reloading, url}`，backend ready 进入重载时同步置位，所有收尾路径经 `finishReload(ok, sites)` 复位并发 `yuki:config-reloaded`；渲染层经 `yuki:config-state` IPC 取权威状态，app.js waitConfigDone 双状态轮询。改动启动链路时保持该状态机。
35. **VIP 解析**（决策 38/33）：parses 来自 config（/sites）。parse=1 全自动起播流程：地址已是媒体直链 → 直接 mpv；否则 type=1 JSON 接口优先直接 fetch（兼容 url/data.url/vurl/play_url 多字段，抓返回里的 Referer/UA 交 mpv，解出 .html 视为失败）→ 失败再 iframe 型隐藏 BrowserWindow（partition 'parse' 独立 session，webRequest.onBeforeRequest 捕获 resourceType=media 或媒体扩展名）→ 再失败 `yuki:capture-direct`（隐藏窗口直开链接抓页面自身播放器请求）。每接口 20s 超时按序尝试。解析窗口 sandbox=true + nodeIntegration=false + contextIsolation=true，用后即 destroy。mpv 经 `--http-header-fields` 注入 Referer。
36. **缓存统计**：`do=cacheSize` 返回 `{bytes, items}`（KV 目录 + js_local.json + cache/dl）；`do=clearCache` 返回释放字节数；设置页签清理按钮先展示再清理。
37. **直播 mpv 健壮性**：TXT 源频道行多地址解析为 `fallbackUrls`；起播后 `mpvStartedOk()` 用 core-idle 轮询 8s 判断真实开播，未开播自动切备用线路并推 `yuki:play-retry`，全失败推 `yuki:play-failed`。
38. **连播统一为渲染层驱动**（决策 70，替代旧队列/接力双方案）：每次只交 mpv 单集（**不传 playlist**），Player._seq 保存 `{site, flag, title, episodes, index}` 上下文；`yuki:player-exit` 附退出进度 `{pos, duration}`；「看完」双判据：剩余 < 8 秒，或 IPC 抢不到进度时 10 秒内收到过 ended 事件；看完且队列有下一集则 play() 递归推进，用户提前关闭则 _seq=null 终止链。教训：IPC 负载嵌套字段必须双端对齐校验（曾误读 payload.playlist 致连播恒单集）。
39. **播放会话制**（决策 78）：mpv 每次起播分配自增会话号，随 playUrl 返回并附在 exit 事件；渲染层仅处理与当前会话匹配的退出，防切集时旧进程延迟退出误推进、本地/推送播放（noSeq 负号）干扰连播、exit 处理期间又起新播（_playToken 双保险）。断流重连由主进程直接 mpv.play 起新会话，经 `yuki:player-session` 同步，重连集播完仍可续连播；「开播≥15s 且剩余≥8s 的媒体直链」退出不置空 _seq 等待重连。
40. **断流自动重连**（决策 59）：proc exit 回调趁 IPC 未拆除抢读 time-pos/duration（Promise.race 400ms），剩余 ≥8s 视为断流 → 重播当前集一次（watch-later 自动续位）+ 系统通知；剩余 <8s 是正常播完，开播 <15s 退出是起播失败（另有直播备用线路），均不重试；_stallRetried 每会话一次。
41. **mpv 播放偏好注入**（决策 47）：续播用 mpv 原生 watch-later（--save-position-on-quit + --watch-later-directory，userData/mpv-watch-later），直播地址 meta.fallbackUrls 存在则 resume=false 不记录；默认倍速 --speed；音轨/字幕语言 --alang/--slang（playerAlang/playerSlang）；偏好变更经 `yuki:update-player-prefs` 下次起播生效。
42. **mpv 快捷键自定义**（决策 45）：settings.playerHotkeys 步长 → 主进程 writeMpvAssets 生成 userData/mpv-scripts/input.conf + lua 提示脚本；起播经 --input-conf / --scripts-append 加载（scripts-append 不覆盖 mpv 默认 scripts 目录）；生成 input.conf 合并用户全局 input.conf（WIN `%APPDATA%\mpv\input.conf` / POSIX `~/.config/mpv/input.conf`）——`--input-conf` 会取代而非追加默认 input.conf，故必须把用户键位带进生成文件，用户已绑定的键不写入应用段、同键冲突以用户为准；`yuki:update-hotkeys` 修改后重写（下次起播生效）。T8 增强：键位可自定义（playerHotkeys.keys 11 个动作，设置页按键捕获+恢复默认+冲突红标；捕获用捕获阶段监听防全局 Esc 抢发）；动作附中文 show-text 反馈，暂停状态由 lua observe_property 中文提示；补齐逐帧 , . 绑定（--input-conf 取代默认键位后原本丢失）；lua 起播提示随自定义键位动态生成。
43. **详情页下载**（决策 50）：选集勾选（.ep-check 阻止冒泡）或悬停单集图标；下载前逐集 playerContent 判断 parse，parse=1 走 yuki:parse 解直链（带 Referer）。yuki:dl add 扩展 out/header：out=「片名 - 集名 + URL 扩展名」（非法字符替换 _）；m3u8 切片流 aria2 无法下载单独计数提示；批量串行解析避免隐藏窗口并发冲突。多选集播放复用连播机制（勾选集按序作为 episodes 交 Player.play）。
44. **选集倒序只翻展示不动下标**（决策 77）：Detail._epDesc 仅翻转渲染顺序，data-idx 始终为原下标，连播/勾选下载不受影响。
45. **线路记忆 + 失败自动换线**（决策 83）：切线路持久化 `settings.lastSourceMap`（键 `site|vodId`）；`Player.play()` 返回 `{ok, reason}`；失败自动循环尝试下一线路（mpv 缺失不换线），全失败恢复最初线路。
46. **收藏/历史**（决策 39/81）：条目结构一致（site/vodId/name/pic/remarks/ts），存 settings 各上限 200 最新在前；records.js makeRecordView 工厂共用；历史在 Detail.open 自动写入（隐身模式 incognito 除外），**历史按片名去重合并**（跨源同名合并置顶，保留原显示名）；想看/已看 tag 三态（want/seen/''，normTag 归一，决策 74），详情按钮与收藏卡徽章双通道共写（setFavTag/getFavTag 唯一读写口，决策 66）。
47. **空源自动探测屏蔽**（决策 41）：首屏就绪后异步探测未探过站点（probedSites 防重复），homeContent 推荐位有内容即过，否则复查首分类；空/错记入 blockedSites 过滤首页下拉（不打断当前选中源，被屏蔽自动切首源），并发 4；仅过滤首页下拉，搜索 SSE 仍全源聚合；源配置「屏蔽源」卡片可恢复重探、查看屏蔽源列表。
48. **首页/分类渐进加载**（决策 51）：首屏数据一到立即 renderGrid + hideLoading，剩余铺满量后台逐页 _appendGrid 增量追加；_loadToken 令牌防串流（切源/切分类/翻页后旧循环回来先比令牌）；自适应目标 36~120；resize 补拉沿用当前令牌。首页搜索只走当前源自身 searchContent（决策 65），不走聚合 SSE。
49. **搜索结果分组分页**（决策 80，T6 改版）：每源分组内部统一分页器翻页，每页 30 条（SEARCH_PAGE_SIZE=30，纯前端切片）；来源筛选纯前端 toggle src-group 不重发请求（决策 58）。分类/当前源搜索一页一次请求 + 源+分类 LRU 页缓存；无 pagecount 的源暂报 pg+1、拉到空页修正（短页不当末页）。
50. **直播源**：config `lives` 三形态（{name,url} 直链 / {group,channels} 嵌套 / proxy://do=live&ext=base64），live.js normalizeLive 统一归一化；频道文本经后端 do=fetchText 拉取（渲染层直 fetch 会被 CORS 拦），支持 txt(#genre#)/m3u；自定义源存 settings.customLives（TVBox 式导入：txt/m3u 地址、粘贴配置 JSON、.json 配置地址，展平嵌套 channels，上限 30，决策 52）；中文域名需 punycode；customLives 增删置 Live._dirty 强制重载（决策 42）。
51. **换肤**（决策 40/73）：主题色 6 套内置（html[data-color] 覆写 MD3 变量）+ 自定义单基色 HSL 推导浅深两套（html.theme-custom，customColor 与 theme 互斥）；明暗 auto/light/dark 由 common.js applySkin 挂 html.dark 类（废弃 @media）；壁纸 yuki:pick-wallpaper 写 settings.wallpaper，渲染层 toFileUrl 铺 body + --wall-veil 遮罩三档；界面缩放 60~200 写 html.style.zoom，字体大小 80~200 注入临时样式表按基准字号等比（决策 55），change 钳制回写。
52. **托盘驻留与关闭行为**（决策 46）：closeAction 三态 tray(默认)/exit/ask；托盘图标代码生成 16x16 PNG 免资源；bgPlay 开启时选退出但 mpv 在播也转托盘保播；isQuitting 区分真退出与托盘驻留；恢复默认设置只清偏好保留数据类键后 relaunch。
53. **缓存位置自定义**（决策 48）：hoststate 统一管理 cache_dir（kv/dl/py），主进程经 python-bridge.extraEnv 注入 YUKI_CACHE_DIR，server.py main() 读取后 configure 再 ensure_dirs；换目录需重启后端（端口/令牌变），渲染层 onBackendReady → setBackendInfo 刷新连接信息；旧目录缓存不迁移。
54. **Anime4K 超分**（决策 60/69/64）：不内置 glsl；download-binaries.js anime4k 从 bloc97/Anime4K 拉 v4.1 Mode A 链 6 个 glsl（仓库按 Restore/Upscale/Experimental-Effects 分子目录，扁平存 vendor/anime4k）；启动 ensureAnime4k 多镜像补齐缺失（raw.githubusercontent → jsdelivr CDN → ghfast.top 代理，镜像返回内容须过大小+头部版权行校验拦错误页）；文件齐全才 buildAnime4kChain 拼链（win 分隔符 ';'）注入 --glsl-shaders，缺文件静默降级；从未设置过开关默认开启（手动关过保持关）；**状态以起播反馈为准**：yuki:play 返回 anime4k 标志，toast 明示「超分已生效」。T8 增强：三档位 anime4kMode（a 均衡 Mode A 链/aa 细节增强 A+A 链/restore 仅修复不升频），所需着色器均在下载清单内无需新增；设置页档位下拉，lua 起播提示附当前档位名。
55. **ffmpeg 内置化**（决策 72）：m3u8 合成与本地预览图共用；启动 ensureFfmpeg 幂等下载 gyan.dev essentials（约 90MB）→ vendor/ffmpeg，失败静默降级、其次探测 PATH；缩略图 5s 处抓帧缩 480 宽 jpg，md5(路径|mtime|大小) 缓存 userData/local-thumbs，并发 4。
56. **鼠标侧键导航**（决策 63/67）：视图级两栈 _navStack/_navForward（showView 入栈同顶去重，新跳转清前进链，栈底不弹）；app-command 与 mousedown button 3/4 双通道，400ms 时间戳去重防双跳。
57. **确认对话框**（决策 54）：全部 confirm 用 common.js confirmDialog（md-dialog 风格，Promise<boolean>，Esc/遮罩=取消）；_confirmResolve 持有待决回调，closeDialog 未决按取消 resolve(false) 防挂死；done 先置空再 closeDialog 防双重 resolve；okText/cancelText 可定制。
58. **二进制存放与路径适配**（决策 84）：vendor/{mpv,aria2,ffmpeg,anime4k}（.gitignore 忽略）；开发模式 ROOT=`path.join(__dirname,'..','..')`，打包模式 `process.resourcesPath`；`index.js` 统一 `RESOURCES_ROOT = app.isPackaged ? process.resourcesPath : ROOT`；python-bridge 打包后启动 PyInstaller exe。
59. **mpv 二进制来源**：shinchiro/mpv-winbuild-cmake latest release 动态取 tag（官方 mpv 无 Windows 发行）；.7z 用 Windows 内置 tar 解（勿用 unzip）。
60. **mpv 视频缓冲缓存 = 只走内存**（决策 85；硬盘缓存能力已整体移除）：参数由 `mpv-player.js _cacheArgs(isNet)` 生成，**无条件带 `--cache-on-disk=no`**（本地文件也带；命令行优先级高于用户 `mpv.conf`，杜绝 conf 里 `cache-on-disk=yes` 把在线流写进磁盘），在线流另加 `--cache=yes --demuxer-max-bytes=512MiB --demuxer-readahead-secs=60 --demuxer-max-back-bytes=128MiB`（纯 RAM，峰值约 640MiB）+ `--network-timeout=120`。**移除原因（重要教训：改默认值压不住已持久化的键）**：原设计用设置键 `playerCacheMode`(memory/disk) + `playerCacheDir` 控制是否落盘，但这两个键**没有任何 UI 入口**（`setPlayerCache` 在 preload 暴露却零调用者，`playerCacheMode` 也不在 `SETTINGS_SET_ALLOWED` 白名单），一旦被历史版本写成 `disk`，用户再也关不掉，且启动时 `applyPlayerCache()` 读它压过代码默认值——表现为「默认已改成内存，实测仍在写盘」。现已删除 `applyPlayerCache()`、`yuki:set-player-cache`、`yuki:clear-player-cache`、`Settings.defaultCacheDir()`、preload 的 `setPlayerCache`/`clearPlayerCache`、`yuki:cache-size`&`yuki:clear-app-caches` 的 mpvCache 分项、settings.reset 保留清单里的两键；启动时跑一次 `migratePlayerCache()`（index.js 模块级）：复用 `clearDiskCache` 清 `mpv-cache-*.dat` 残留（只匹配该模式，不碰用户曾自选目录里的无关文件）+ `settings.delete` 两个键；两键都不存在即直接返回，故幂等、不需要迁移标记键。`yuki:pick-folder` 保留为通用选目录。
61. **封面补拉优先级体系**（决策 86）：优先级 = 点开详情 > 搜索拉页 > 封面补拉。实现四件套（common.js）：① 世代制 `_coverFillGen` + `abortCoverFill()`（Detail.open/源切换时中止）；② IntersectionObserver 只入队可见卡（rootMargin 300px，120s 超时自退）；③ worker 池并发 10（T45 从 5 提档）；④ 补拉经 `detailContent` 取详情封面，`data-cover-missing` 标记 + 防抖不重复入队。屏蔽确认弹窗后补拉恢复入口：首页 load done/refresh、search done、detail render 后。

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
- **quickjs 宿主须提供 TVBox 全局**：`local`（key+kv 两级 KV，落盘 `~/.yuki/js_local.json`）、`md5X`、`js2Proxy`、`TextEncoder/TextDecoder`；HTTP 响应同时带 `content` 与 `data` 字段。缺任何一个，jadehh 系源报 "xxx is not defined"。
- **Spider 返回值契约**：必须返回 dict（app.py 包装层统一 json.dumps）；返回 JSON 字符串会被二次序列化致前端取不到 list。
- **CMS 适配要点**：XML（type=0）子标签无 vod_ 前缀，`_xml_video` 负责映射 + $$$ 拼多线路；JSON（type=1）vod_id 为整数，接收 ids 的入口一律先 `str(i)` 再 join。

## 6. 构建与打包

```powershell
# 开发模式：npm install → node scripts\download-binaries.js → npm start
# 打包：
npm install                                    # 首次
python-backend\.venv\Scripts\pip.exe install pyinstaller   # 首次
npm run build:py                               # → python-dist/yuki-backend.exe（约 50MB）+ 数据目录 js-engine/spiders/base
# Windows 安装包（国内需镜像；PowerShell 用 $env:VAR=... 语法）
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
$env:CSC_IDENTITY_AUTO_DISCOVERY="false"
npx electron-builder --win --publish=never --config.directories.output="C:/temp/yuki-dist"
```

- **产物**：`影视 PC Setup 0.1.0.exe`（NSIS，约 175 MB）+ `win-unpacked/`（约 1.7 GB）；macOS/Linux 预留未测。
- **electron-builder 配置**在 `package.json` 的 `"build"` 字段：extraResources `python-dist/` → `resources/python-backend/`、`vendor/` → `resources/vendor/`；files 排除 `.venv/`、`__pycache__/`、`.pyc`、`tests/`；NSIS 可选安装路径 + 快捷方式 + 中英文。
- **打包后目录**：`resources/app.asar` + `resources/python-backend/`（yuki-backend.exe + js-engine/spiders/base）+ `resources/vendor/`（mpv/aria2/ffmpeg/anime4k）。
- **已知问题**：① Windows Defender 锁文件 → 用外部输出目录 C:/temp/yuki-dist；② winCodeSign macOS dylib 符号链接报错不影响安装器生成；③ 自定义图标已配置（assets/icon.png → .ico，8.7.3 完成）；④ 无代码签名（CSC_LINK/CSC_KEY_PASSWORD 未配）；⑤ PyInstaller 警告 tzdata hidden import not found（非关键）。

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
- **播放**：mpv 基础控制 lua OSD（U27）、快捷键自定义（U32/45）、全屏倍速延续（FEATURES#3，observe_property）、记忆播放（U44/47）、自动连播开关（U45）、默认倍速/语言偏好（U48/104）、断流自动重连（U86/59）、连播重写渲染层驱动（U106/70）、会话制防竞态（U109⑦/78）、Anime4K 超分（U85/93/99/60/69/64）、mpv 本地配置兼容（scripts-append + input.conf 合并用户键位，T2）、Anime4K 多镜像下载加固（T2）、视频缓冲缓存内存/硬盘切换（T3/决策85）。
- **直播**：mpv 健康检测备用线路（U2/36）、TVBox 式导入（U65/52）、频道可用性探测（2026-08 起改静默后台探测，见 §8.8 T1）、IDN punycode（U36）。
- **下载**：并发数设置（U42）、系统代理感知（U110/79）、m3u8 ffmpeg 合成（U102/103/71/72）、合成与删除修复（U111）、删除失败下载清理产物（U112）、打开下载目录（U74）、设置归位（U66/53）。
- **收藏/历史**：视图工厂共用（U16/17/39）、搜索+标签（U89/61）、多选删除（U63）、编辑标题（U41/57）、源标识徽章化（U29/69/78/57）、跨源去重（决策 81）。
- **外观**：主题色/自定义色（U19/101/73）、明暗/缩放/字号数值化（U26/35/71/55）、壁纸遮罩（U19/76）、字体颜色大小（U31）、动画开关（U46/39）、弹窗 flex 居中修复（U113/54）、隐藏滚动条（U62）、4K 自适应（U56）、圆角统一（U52/54）、设置布局（U53/87/114）、占位封面资产（U51/68/56）、UI 清单式优化（T4：工具栏控件对齐 / danger 按钮 / 焦点轮廓 / 字体间距 hover 统一）。
- **系统**：托盘驻留/后台播放（U43/46）、隐身模式（U47）、恢复默认（U50）、缓存目录自定义（U49/48）、资产状态卡（决策 82）、mpv 自定义路径（FEATURES#6）、鼠标侧键导航（U92/97/63/67）、本地文件卡片网格预览图分页（U105/114/115/112）、直链播放视图（U18/37）、侧栏收缩（U38）、回到顶部（U40）、自定义应用图标（8.7.3）。
- **T9~T20 批次**（细节见 §8.8 表）：边下边播开关（T9）、dlTimer 空闲自停防泄漏（T10）、按钮去透明化（T11/T16）、设置二级菜单+字号 6 档（T12/T17）、收藏/历史工具条对齐首页（T13）、封面淡入防闪烁（T14）、下载页卡片化+总网速（T15）、侧栏去 brand（T18）、详情页全选栏上移+集数胶囊+倒序紧邻（T19）、文案精简（T20）。
- **T21~T35 批次**（细节见 §8.8 表）：倒序按钮归位+收藏按钮间距（T21）、动画改下拉筛选框（T22）、snackbar 跳移修复（T23）、资产→扩展改名+系统置底（T24）、配置重载后屏蔽源筛选修复（T25/_probeToken）、外观卡布局统一（T26）、缓存两卡等高（T27）、直链改名+本地文件独立板块（T28）、源配置迁入设置一级菜单（T29）、动画体验整体优化 M3 loading/退场/错峰入场（T30）、设置页非全屏适配+性能+封面 img 收口 vodCoverImg（T31）、背景区按钮重排（T32）、删除类二次确认补全（T33）、直播频道分页（T34）、直播可用性本地缓存 liveProbeCache（T35）。
- **T36~T39 批次**（细节见 §8.8 表）：扩展卡并入全宽组+搜索每源多页拉取+条数全站对齐（T36）、「自动」分页上限收 24+新增 20 条选项（T37）、分页体系定稿：收藏/历史固定 20 条、搜索全部视图限 20 条点来源进单源翻页、后端拉全部页、「自动铺满」模式移除（T38）、设置卡宽度归组+每页条数拆四项独立设置 pageSizeOf(key)+直播铺满一屏 liveFitPageSize+搜索来源筛选 bug（T39）。
- **T40 批次**：屏蔽逻辑改逐分类探测（任一分类有资源即不屏蔽，此前只查首个分类会误屏蔽）+ 屏蔽列表弹窗去滚动条；收藏多选拆删除/标记想看/标记已看三操作并删清空按钮，历史多选移除全选；下载新建空输入给反馈；本地文件刷新内容无变化不重渲防闪烁；每页影片数量去注释改两列网格布局（非全屏不再挤行）；移除背景/恢复主题/恢复字体颜色/恢复快捷键/清理缓存五处补二次确认；直播源消失根治：多仓配置载入优先上次成功条目（last_repo.txt 跨重启持久化）防不同次命中不同仓致 lives 漂移。
- **T41 批次**：横屏封面也算有封面：coverFadeIn 检出横图加 landscape 类，卡片改 object-fit:contain 完整显示（此前固定竖版框裁中间细条看似没封面）；修复搜索进行中点单源筛选后往下滑看到其他源影片（后到 SSE 组未按 _curSrc 隐藏）；修复壁纸遮罩选项与描述相反（low/high 的 veil 数值写反互换）；屏蔽源弹窗恢复 max-height:50vh 滚轮滚动。
- **T42 批次**：封面补拉：列表无 vod_pic 但详情有的卡片，后台逐个 detailContent 补封面（fillMissingCovers 并发 3/每次渲染上限 24，卡片标 data-cover-missing，vodCard 增 data-source，绑定加载令牌切页中止）；屏蔽源弹窗保留滚轮滑动但隐藏滚动条。
- **T43 批次**：搜索中点详情转圈久修复（优先级划分：点开详情 > 搜索拉页 > 封面补拉）：Detail.open 先 abortCoverFill 中止后台补拉让路（根因：同一 JS 源共享 QuickJS 上下文，JsEngine.call 持锁串行，详情排在补拉/拉页后面）；详情就绪后恢复补拉；搜索流式期间暂缓补拉待 done 后统一补；封面补拉改只补当前屏幕可见卡片（IntersectionObserver 上下预热 300px），并发改 5。
- **T44 批次**：直播源消失/视频源变少根治（多仓跨条目合并）：根因是偏好仓 supermeguo18（6 个直播源）偶发超时，回退仓 bizhangjie🐶1 只有 1 条无效 lives（无 url）且站点 key 不同触发重新探测屏蔽。修复：多仓命中主条目后并行补拉其余条目，lives 按 url 去重合并（嵌套 channels 展平、无 url 丢弃），sites 按 key 去重合并（主条目优先，只增不删）；偏好条目首次失败自动重试一次防偶发超时仓漂移。
- **T45 批次**：封面补拉并发 5→10（_coverFillPump，可见卡才入队+详情让路机制不变，提速不阻塞用户操作）；文档整理：§7 功能清单 T9~T39 流水账压缩为三行摘要（细节统一查 §8.8 表，消除双份维护），决策 13 同步 T44 多仓合并机制，TOC 锚点行号重新校准。
- **T46 批次**：Kazumi 规则系统补全——安装/更新时间追踪（installed_at/updated_at 持久化）、有效性检测（后台 4 并发搜索测试关键词标记 valid/invalid/captcha，列表徽标）、批量更新（后台 4 并发商店检查+版本比较+更新，保留安装时间）。（细节见 §8.8 表）
- **T47 批次**：下载与播放增强——下载记录持久化（dl-records.json 跨重启恢复，删除/清空同步）、mpv 截图（快捷键 s 截图存图片/yuki，原生 s 键与 IPC 双通道，设置页打开截图目录）。（细节见 §8.8 表）
- **T48 批次**：「我的」页面——观看统计（累计时长/次数/部数 + 近 7 天条形图）与最近观看（卡片点击回详情），埋点在 mpv 退出时累计。（细节见 §8.8 表）
- **T49 批次**：爬虫健壮性——Cookie 持久化（解析会话 Cookie 落盘，规则引擎自动带上）、视频源解析池（3 槽位独立 partition 并发解析）、HLS 广告过滤（m3u8 下载前剔除广告分段，设置开关）。（细节见 §8.8 表）
- **T50 批次**：视频流提取三机制 + 组件测试 + 旧解析器 + MiSans 字体——webRequest 拦截 + JS 轮询 video 元素 + legacy iframe 监听；node --test 27 个 JS 单测；useLegacyParser 贯通；MiSans 内置子集化字体（download-binaries misans，未就绪回退系统字体）。（细节见 §8.8 表）
- **T51 批次**：异步会话 + 关于页——AsyncSingleFlight/AsyncSerialQueue 并发控制（接入 captureDirect 去重，7 例单测）；独立「关于」视图（标识/版本/技术栈/致谢/系统信息）。（细节见 §8.8 表）
- **T52 批次**：Bangumi 收藏同步 + 域名镜像迁移（2026-08-09 已按用户要求改回官方 api.bgm.tv / next.bgm.tv）——用户收藏同步（token 管理/测试连接/我的收藏/详情弹窗追番）；8 例单测。（细节见 §8.8 表）

## 8. 已知坑位（踩过的，别再踩）

- PowerShell 不支持 `&&`，用 `;`；中文输出经 `Out-File` 易乱码，脚本输出用 ASCII。
- `SourceFileLoader.load_module()` 3.12+ 不存在 → 必须经 `compat.py`（server.py 已 import）。
- lxml 6.1.1 支持 py3.14；测试用 python 必须在 `python-backend\.venv`（系统 python 无 fastapi/pytest）。
- quickjs-ng：`add_callable` 只能收/返标量，返回 dict 报错 → 一律 JSON 字符串桥接；`ctx.get('obj')` 返回 Object 无属性访问 → 方法调用走 eval/`__YUKI_CALL__`；JS spider 无 destroy 方法打 "js destroy error" 日志属正常。
- `js-engine` 目录名含连字符非合法包名 → sys.path 注入后 `from quickjs_host import`。
- 多模块 ESM spider：module_resolver 上限 40 模块；新增 `export class` 形态需在 `esm_transform.py` 补规则，兜底 `_RE_EXPORT_RESIDUAL` 清除残留 export 前缀。
- config 异步任务：同步阻塞会卡住 /action 分钟级（多仓扫描），前端 fetch 加 30s 超时兜底。
- 启动自动重载两个竞态：① READY 行早于 uvicorn 监听，收到 READY 立即 POST 会 connection refused → 先轮询 /health；② `yuki:config-reloaded` 可能早于渲染层监听注册丢失 → app.js bootstrap 另加 configTask 轮询兜底。
- mpv 未开始播放（core-idle=true）时 get_property 报 "property available"，判播放状态用 core-idle 轮询而非 time-pos。
- mpv `--input-conf` 是取代而非追加默认 input.conf → 应用自定义 input.conf 必须合并用户全局键位（writeMpvAssets），否则用户自定义快捷键在起播时静默失效。
- mpv 硬盘缓存能力已移除（缓存只走内存，见决策 85），以下留作排查经验：v0.41 的目录选项是 `--demuxer-cache-dir`（传 `--cache-dir` 会报 "option not found" 直接退出）；缓存文件平铺为 `mpv-cache-<hex>.dat`，默认 `--demuxer-cache-unlink-files=immediate`——**文件建好即 unlink、播完消失，所以"磁盘持续写入但目录里找不到文件"是落盘缓存开启的典型表象**，别据此排除 mpv 自身。清理这类残留按该文件名模式匹配（防误删用户自选目录里的无关文件），逐文件 try/catch 跳过占用（Windows 下 mpv 以共享删除方式打开，播放中可删但空间延迟到句柄关闭才释放）。
- mpv `--screenshot-template` 的 `%w` **必须紧跟子格式字符**（`%wH/%wM/%wS/%ws/%wf/%wT`）：写成 `yuki-%w-%03n` 里 `%w-` 属未知转义，mpv `create_fname` 判整个模板非法 → 报 "Invalid screenshot filename template" 并**放弃截图**（选项本身能通过启动校验，播放照常，故很难发现）。而 input.conf 的 `show-text "已截图"` 与 `screenshot` 是两条独立命令，截图失败照旧弹提示 → 表现为「提示已截图但目录里没有图」。模板只用 `%tX`（strftime）+ `%0Xn`（序号，重名自增避让；无 `%n` 且同名文件已存在时 mpv 直接报错不覆盖）。另：mpv 默认 `--screenshot-format=jpg`，要 PNG 必须显式指定（IPC 的 `screenshot-to-file` 反之按扩展名推断）。
- Google Storage 样片本机不可达，demo 样片用 media.w3.org 与 vjs.zencdn.net。
- Grep 输出的缩进不可信（可能去掉行首空格），SearchReplace 前先 Read 目标行段。
- Node EventEmitter：`emit('error')` 无监听器抛 ERR_UNHANDLED_ERROR，自定义类须在构造器兜底 noop 监听（downloader.js 已做）。
- aria2 `--continue=true` 要求服务器支持 Range；测试服务器不返 206 报 "No URI available."；`writeHead` 头值 undefined 直接报错。
- Electron：最后一个窗口 destroy 触发 window-all-closed 默认退出；无界面测试脚本须 `app.on('window-all-closed', e => e.preventDefault())`。
- Chromium 启动 `WSALookupServiceBegin failed with: 10108` 为良性日志。
- session webRequest 每 session 仅一份且全局生效 → 解析窗口用独立 partition，结束 onBeforeRequest(null) 清理。
- mpv 不能直接播 HTML 页面，推送非直链走 captureDirect 抓媒体请求，抓不到返 resolve-failed。
- 多仓条目托管于 raw.githubusercontent / jsdelivr，网络抖动频繁（偶发超时/404）：T44 已用「偏好条目失败重试一次 + 跨条目合并」兼顾，新增多仓功能勿假设单条目必达；Windows 控制台 GBK 无法打印条目名 emoji（🈲），脚本输出前 `.encode('ascii','replace')`。

## 8.7 当时记录的待完成项

> 本节是历史快照，当前待办以 [../PROGRESS.md](../PROGRESS.md) 为准。

- [ ] 8.7.1 macOS / Linux 平台实际打包测试
- [ ] 8.7.2 安装后首次启动验证（冷启动时间、资源路径、后端拉取）
- [x] 8.7.3 自定义应用图标（assets/icon.png 已配置并嵌入 Windows 安装器）
- [ ] 8.7.4 electron-updater 自动更新（可选，GitHub Releases）

## 8.8 历史任务批次（T1~T52，2026-08）

| 批次 | 任务 | 状态 |
|---|---|---|
| T1 | 直播静默探测与自动刷新（HEAD→GET 回退防误杀）：已实现静默分批探测 + HEAD→GET 回退 | 已完成 |
| T2 | mpv 本地配置兼容（scripts-append + input.conf 合并）+ Anime4K 多镜像下载加固 | 已完成 |
| T3 | 视频缓冲缓存设置（内存默认/硬盘 + 路径选择/还原/换路径清缓存） | 已完成 |
| T4 | UI 按钮/组件/字体布局检查清单式优化：工具栏 select/input/btn 高度对齐 40px + gap 10px；新增 .md-btn-danger-text 并应用到删除/清空/恢复默认等按钮；#live-status 右对齐样式移入 CSS；全局字号 14px + tip-line 12px + dark 资产状态色对比；:focus-visible 轮廓 2px/1px；pill 间距统一 6px；输入框/下载项/文件行补 hover | 已完成 |
| T5 | Kazumi XPath 规则引擎适配（原计划项，后由 T46~T50 完成并扩展） | 已完成 |
| T6 | 翻页架构重设计：废除分类"自适应铺满"连拉多页，改一页一次请求 + 每页条数限制（设置项 listPageSize 自动/24/36/60/120）；统一分页器 renderPagerBox（页码±2+首尾省略号+跳转输入）；按 源+分类 LRU 页缓存（32 分类×10 页，命中即显+后台静默刷新，切源清理）；当前源搜索真分页；聚合搜索组内翻页替代展开全部；收藏/历史客户端分页 | 已完成 |
| T7 | UI 布局与说明系统重设计：ⓘ 信息点展开组件（.info-tip/.info-dot 全局委托切换，10 处长说明收入 info-detail，短说明保持内联）；设置页卡片网格显式列数响应式（默认 2 列/≤760px 单列/≥1500px 3 列）；设置页 tip-line 字号层级 13px；本地文件卡说明并入信息点 | 已完成 |
| T8 | mpv 播放器设置增强：键位自定义（11 动作按键捕获 UI + 恢复默认键位 + 冲突红标，存 playerHotkeys.keys 写 input.conf）、Anime4K 三档位（均衡 Mode A/细节 A+A/仅修复，anime4kMode）、中文化（窗口标题模板 yuki · 片名、--osd-font 微软雅黑、动作中文 show-text 反馈、暂停中文 OSD、补齐逐帧键位） | 已完成 |
| T9 | 边下边播：设置开关 simulDownload（默认关）；起播成功后静默追加下载——m3u8 走 hls 合成通道、其余走 aria2，任务名「片名·集名」去非法字符；失败静默跳过不影响播放；返回 r.simulDl 由渲染层 toast 提示 | 已完成 |
| T10 | 内存泄漏审计与优化：渲染层 11 处监听器均有 _inited/单例守卫无泄漏；主进程 dlTimer 1s 轮询改空闲自停（aria2 无 active/waiting/paused 且 hls 无 active 时 clearInterval），启动即推一次列表 | 已完成 |
| T11 | 按钮去透明化：下载页删除/继续/清除、工具面板源配置/本地文件按钮改 md-btn-tonal 不透明底；下载空态引导文案删除（空列表留白） | 已完成 |
| T12 | 设置二级菜单：settings-wrap 改左侧导航（外观/播放与快捷键/下载/缓存/系统/资产，settingsCat 持久化）+ 内容区按 data-setcat 分类显隐；switch/tip 文案短语化、长说明转 title 悬停提示；字体大小/界面缩放改 6 档下拉（80/90/100/110/125/150，snapSizeTier 吸附旧数值） | 已完成 |
| T13 | 收藏/历史工具条对齐首页：搜索框并入顶部 view-toolbar（与首页 home-search 同规格 40px 高/≤300px 宽/胶囊圆角），按钮靠右；收藏标签筛选行保留 | 已完成 |
| T14 | 封面刷新闪烁优化：卡片/详情封面 img 初始透明，加载完成经 coverFadeIn 加 loaded 淡入（0.25s），加载期间由占位底色托底，兼容缓存命中 complete 直加 | 已完成 |
| T15 | 下载页仿直链播放卡片样式（标题+说明+输入行）+ 总网速显示（dl-speed 汇总 active 任务速度，render 时刷新） | 已完成 |
| T16 | 透明按钮全量去透明化：新增 .md-btn-danger-tonal（error-container 底）替换全部 md-btn-danger-text（清空收藏/历史、删除勾选×2、恢复默认）；弹窗 md-dialog-btn 补 surface 底色 | 已完成 |
| T17 | 设置页再整理：一级导航加大（15px/200px 列）；字体颜色移至主题色下；壁纸区改名「背景」且选图/移除按钮前置遮罩后置；界面动画改普通复选框（.set-check，T22 再改下拉筛选框）；快捷键（步长+键位）拆独立一级板块 hotkey；卡片内 select 统一 240px 宽 | 已完成 |
| T18 | 侧栏移除「影视 PC」brand 文字（首页本就首位，同步清理 .brand 相关 CSS） | 已完成 |
| T19 | 详情页选集区重排：全选/勾选操作栏移至视频源按钮下方；共 X 集改胶囊框；倒序按钮移至集数旁紧邻 | 已完成 |
| T20 | 举一反三文案精简：直链播放去 mpv 术语、本地文件说明短语化 | 已完成 |
| T21 | 详情页倒序按钮移至播放勾选集左侧（同 md-btn-tonal/sm 样式大小一致）；收藏/想看/已看按钮行改 flex gap 12px 加大间距 | 已完成 |
| T22 | 界面动画改下拉筛选框（开启/关闭，与遮罩下拉同款；animEnabled 持久化不变） | 已完成 |
| T23 | 修复设置 toast 弹出后向右跳移：snackbar 入场动画 viewIn 末态 transform:none 覆盖居中 translateX(-50%)，改专用 snackIn keyframes 末态保留居中位移 | 已完成 |
| T24 | 设置一级菜单「资产」改「扩展」（卡片标题扩展状态/安装方式）；系统移至导航最底；mpv 状态行长路径超格修复（路径只进悬停 title，hint 仅显示已就绪 + asset-hint 省略号保护） | 已完成 |
| T25 | 启动时屏蔽源未筛选修复：配置自动重载后源 key 集变化，旧 probedSites/blockedSites 不再匹配致新源不被过滤；loadSites 检测 key 集变化则重置记录并重新探测，_probeToken 世代校验使进行中的旧探测写入作废 | 已完成 |
| T26 | 外观卡布局/字号统一：界面动画原用无样式定义的 .settings-item 致裸排错位，统一改 tip-line(13px)+控件模式与卡内其余项一致 | 已完成 |
| T27 | 缓存页两卡等高：.settings-grid .tool-card[data-setcat=cache] 加 align-self:stretch，同排时框一样大 | 已完成 |
| T28 | 侧栏「直链播放」改「直链」；「工具面板」改「本地文件」独立板块：删顶部页签（含本地文件切换按钮）直显本地文件卡，showToolPanel 删改 ensureLocalPanel 首次进入懒加载（app.js showView tools 挂钩）；tools-tabs/set-check 死 CSS 清理 | 已完成 |
| T29 | 源配置迁入设置一级菜单「源设置」（导航位置：扩展与系统之间）：载入视频源/视频历史源/直播源/直播历史源/屏蔽源五卡整体迁入 settings-grid（data-setcat=source，控件 id 与卡片内样式不变，绑定维持原位）；home/player/live 引导文案同步改「设置→源设置」 | 已完成 |
| T30 | 动画体验整体优化：loading 升级 M3 变弧 spinner（md-dash 弧长伸缩）+ scrim 淡入/关闭淡出 + 「载入中…」文案；warnToast 退场淡出（snackOut）；弹窗退场动画（dlg-out 淡出缩小 150ms 延迟隐藏，重开清 timer 防误藏 + pointer-events 禁点）；vod-card 前 10 张错峰入场（30ms/张）；view/card/dialog/snackbar easing 统一 cubic-bezier(.2,.7,.3,1)；panels.js 12 处 loadingToast 直引改 show/hideLoading 统一淡出；no-anim 开关自动兼容（过渡被禁不影响隐藏时机） | 已完成 |
| T31 | 设置页非全屏适配 + 性能 + 可维护性：①适配：settings-grid 单列断点 760→900（与 settings-wrap 导航横排断点对齐）；外观/播放/快捷键/源设置高内容分类 grid-column 横跨全宽限 max-width:880px，下载/扩展/系统短卡限宽 680px，全屏 3 列时全宽分类 span 2 保持层级一致 ②性能：封面 img 增 decoding=async（异步解码降主线程卡顿）；下载列表渲染改指纹增量（gid 序列不变时只换变化条目，全同直接跳过，避免每秒全量 DOM 重建） ③可维护性：vodPlaceholder/coverFadeIn 从 home.js 迁至 common.js，新增 vodCoverImg 统一生成封面标签（lazy/async/no-referrer/淡入/兜底），home/records/detail 三处手写 img 收口（detail 缺 lazy/decoding 的参数漂移根治）；ui.css 文件头增板块索引注释（关键词定位不带行号防漂移） | 已完成 |
| T32 | 外观设置背景区重排：遮罩强度下拉置顶，选择本地图片/移除背景两按钮移至其下方单独一行（wall-row 拆两行） | 已完成 |
| T33 | 删除类操作二次确认补全：下载页「清除已完成」（clearDone）、源设置历史源✕（removeConfigHistory）、直播源✕（removeLiveSource）三处补 confirmDialog；其余删除入口（收藏/历史单条+多选+清空、下载单删+清失败、本地文件/文件夹、缓存清理、恢复默认）盘点确认已有确认 | 已完成 |
| T34 | 直播频道列表分页：新增 #live-pager 容器 + renderPagerBox（同首页/收藏历史规格）；每页频道数 = 每页影片数×3（频道行紧凑，至少 60），切分组/切源回第一页，探测过滤后当前页自动 clamp；索引保留完整 channels 位置（点击播放不受分页影响）；搜索页（源内 30 条/页）与收藏/历史（listPageSize 客户端分页）盘点确认已有分页无需改 | 已完成 |
| T35 | 直播可用性本地缓存：探测结果按源 URL 存 settings.liveProbeCache（{ts, dead:[不可用频道 url]}，最多 20 个源超出丢最旧）；进页/切源默认按缓存过滤不再探测（状态栏提示「已按缓存结果过滤 N 个 · 点刷新重新检测」，5s 自隐）；仅手动点「刷新」重新全量探测并更新缓存；首次无缓存仍探测一次建缓存；探测异常不写缓存保留旧值 | 已完成 |
| T36 | 用户反馈三连修复：①扩展状态卡非全屏半宽内容挤窄 → 从短卡限宽组移入全宽组（grid-column:1/-1 限 880px，与外观/播放/快捷键/源设置同规格） ②搜索每源只见 20 条：根因非前端分页而是 CMS 源搜索接口服务端分页（limit=20）且聚合搜索只拉 pg=1 → server.py 新增 _search_source_pages 每源拉前 3 页合并去重（遇空页/短页即停，异常不抛），aggregate_search 与 SSE /search/stream 均接入，前端每源最多可见 60 条并正常翻页 ③每页条数全站对齐首页：新增 common.js adaptivePageSize（首页 _adaptiveTarget 收口于此），收藏/历史 render、搜索 run/_renderGrpPage、直播 _pageSize 的「自动」回退从固定 36 改自适应估算；搜索页每页条数从固定 30 改为跟随「每页影片数量」设置 | 已完成 |
| T37 | 收藏/历史超过 20 几条不出分页器修复：根因是「自动」模式 adaptivePageSize 按大窗口估算 36~120，记录数少于估算值时 pagecount=1 不渲染分页器 → 收藏/历史 render 与搜索 run 的「自动」回退改 adaptivePageSize(24) 上限 24（超 24 条即分页）；设置「每页影片数量」新增「20 条」选项（listPageSize 白名单同步加 20）；首页分类保持铺满窗口自适应不变（源数据量大本来就有分页器） | 已完成 |
| T38 | 分页体系定稿（用户四连要求）：①收藏/历史移除「自动」模式，固定每页 20 条（RECORDS_PAGE_SIZE）超过即出底部分页器 ②搜索后端取消最大页数限制：_search_source_pages 从拉前 3 页改拉全部页（空页/短页/整页无新增即停防伪分页死循环，max_pages=50 仅作防护上限），aggregate_search 超时 15s→60s、SSE as_completed 30s→120s 且超时异常仍发 done 事件防前端挂死 ③搜索页「全部」视图每组限显前 20 条不出分页器（附提示行），点来源标签进单源视图才启用分页器翻看全部（_paintGrp 按 _curSrc 判 focused） ④「自动（铺满窗口）」模式整体移除：删 common.js adaptivePageSize，新增 pageSizeSync 同步版，listPageSize 空/非法默认 20，首页 _pageSize/_adaptiveTarget 与直播 _pageSize 改直取设置值，设置下拉移除自动选项文案改「每页影片数量（首页/直播）」 | 已完成 |
| T39 | 设置宽度 + 分页面条数 + 搜索筛选 bug（用户四连）：①ui.css 下载/系统卡从 680px 限宽组移入全宽组（非全屏 grid-column:1/-1 限 880px 与扩展状态同宽，全屏 ≥1500px span 2 与扩展同宽） ②每页条数拆四项独立设置：common.js listPageSize/pageSizeSync 改 pageSizeOf(key)（pageSizeHome/pageSizeSearch/pageSizeFavorites/pageSizeHistory，按 key 缓存，首页回退旧键 listPageSize 兼容迁移），index.html 单下拉改四下拉（首页/搜索/收藏/历史各 20~120 五档），panels.js load/change 同步四项，home _pageSize/_adaptiveTarget（改 async + await）、search run 恢复 _size、records 工厂加 pageSizeKey 参数（Favorites/HistoryView 各自传键） ③直播改铺满一屏后翻页：live.js 新增 liveFitPageSize（#live-list 宽÷230 列数 × 可见高÷55 行数）替代原设置×3 ④修复搜索页点来源标签不筛选：根因 jQuery .each(function) 内 this 是 DOM 元素却被 .bind(this) 覆盖成 Search 对象 → 改闭包变量 cur | 已完成 |
| T40 | 用户反馈十三连：①屏蔽源查看弹窗去滚动条（blocked_list 删 max-height/overflow 内联样式） ②屏蔽逻辑改逐分类探测：home.js _probeSites 推荐位空后逐分类 categoryContent，任一分类有资源即不屏蔽（此前只查首个分类），单分类出错跳过继续 ③收藏多选拆三操作：工具栏新增标记想看/标记已看按钮（tagChecked 批量写 tag），入口按钮改「多选」，删「清空收藏」按钮（清空仅历史保留） ④历史多选删全选（checkall 仅 withTags 视图绑定/同步） ⑤下载新建空输入给 toast 反馈并聚焦输入框 ⑥本地文件刷新防闪烁：listFile 加 silent 参数，目录指纹（路径+条目 dir/名/时间）不变跳过重渲提示「目录内容无变化」 ⑦每页影片数量去注释文案 ⑧非全屏布局优化：四项改 .pagesize-grid 两列网格（标签定宽右对齐 + 下拉等宽 110px，≤700px 折单列） ⑨移除背景/恢复主题/恢复字体颜色/恢复快捷键/清理缓存五处补 confirmDialog（panels.js global 补声明） ⑩直播源消失根治：config.py 多仓载入优先上次成功条目（last_repo_name 存 data_dir/last_repo.txt 跨重启持久化，sorted 置顶），/sites state 增 repo 字段供排查 | 已完成 |
| T41 | 用户反馈四连：①横屏封面也算有封面：coverFadeIn 加载完成后检出 naturalWidth>naturalHeight 加 landscape 类，ui.css .vod-cover img.landscape 改 object-fit:contain 完整显示（此前固定 160/220 竖版框 + cover 裁中间细条，看似没封面） ②修复搜索进行中点单源筛选后往下滑看到其他源影片：search.js renderGroup 末尾按 _curSrc 隐藏后到的非目标源组（此前仅切换时对存量组 toggle，SSE 后到组直接按「全部」模式追加） ③修复壁纸遮罩选项与描述相反：ui.css data-dim low/high 的 --wall-veil 数值互换（低=62% 背景更醒目，高=90% 内容更清晰） ④屏蔽源弹窗恢复滚轮滚动：blocked_list 加回 max-height:50vh;overflow-y:auto（T40 曾整体移除） | 已完成 |
| T42 | 用户反馈二连：①封面补拉：common.js 新增 fillMissingCovers（找容器内 data-cover-missing 占位图卡片，并发 3 逐个 doAction detailContent 取 vod_pic 换入，每次渲染上限 24 张，写入前校验 isValid 与卡片仍在 DOM）；vodCoverImg 无封面时给 img 标 data-cover-missing，home.js vodCard 增 src 参数写 data-source（首页/分类/源内搜索渲染后挂 _fillCovers 绑定 _loadToken 中止），search.js _paintGrp 同挂（卡片本就注入 data-source） ②屏蔽源弹窗可滚轮滑动但隐藏滚动条：ui.css #blocked_list scrollbar-width:none + ::-webkit-scrollbar display:none（保留 T41 内联 max-height/overflow） | 已完成 |
| T43 | 搜索中点详情转圈久 + 封面补收紧（优先级：点开详情 > 搜索拉页 > 封面补拉）：根因同一 JS 源共享 QuickJS 上下文、JsEngine.call 持锁串行，详情请求排在后台补拉/搜索拉页后面 → ①common.js 补拉重写为世代制：abortCoverFill（世代自增+清队列+断开观察器），fillMissingCovers 改 IntersectionObserver 只补屏幕可见卡（rootMargin 上下 300px，入视口才入队），worker 池并发改 5（_coverFillPump/_coverFillWorker），同容器旧观察器先断开防累积，120s 安全释放 ②detail.js open 入口先 abortCoverFill 让路；load 成功后恢复补拉（搜索仍在流式时只补首页区不碰搜索区） ③search.js 流式期间 _paintGrp 暂缓补拉（!this.es 才补），done/error 收尾后 _fillAllCovers 统一补各组 | 已完成 |
| T44 | 直播源消失/视频源变少根治（多仓跨条目合并）：根因偏好仓 supermeguo18（6 直播源）raw.githubusercontent 超时回退 bizhangjie🐶1（仅 1 条无 url 的无效 lives），且仓间站点 key 不同触发探测重新屏蔽 → ①config.py 多仓命中主条目后 _merge_repo_extras 并行补拉其余条目（ThreadPoolExecutor ≤4）：_merge_lives 按 url 去重合并（_iter_live_urls 嵌套 channels 展平，无 url 条目丢弃，主条目优先），_merge_sites 按 key 去重追加构建（主条目优先只增不删），summary 计数同步更新 ②偏好条目首次拉取失败自动重试一次（防偶发超时仓漂移） | 已完成 |
| T45 | 封面补拉提档 + 文档整理：①common.js _coverFillPump 并发上限 5→10（只补可见卡+Detail.open abortCoverFill 让路机制不变，提速不阻塞用户操作） ②PROGRESS.md 整理：§7 功能清单 T9~T39 十行流水账压缩为三行批次摘要（细节统一查 §8.8 表消除双份维护漂移），决策 13 同步 T40/T44 多仓偏好与跨仓合并机制，TOC 锚点行号重新校准 | 已完成 |
| T46 | Kazumi 规则系统补全：①安装/更新时间追踪（Plugin 增 installed_at/updated_at，add() 新装记 installed、更新保 installed 记 updated，内置规则导入也盖章，列表行悬停展示）②有效性检测（后台 4 并发按启用规则搜索测试关键词「海贼王」标记 valid/invalid/captcha，写回 validity_checked_at，列表徽标绿/红/橙，kazumiCheckValidity/kazumiValidityStatus 端点，前端轮询）③批量更新（后台 4 并发 fetch_shop_rule 拉最新版，版本数字段比较 _should_update，较新则 add() 覆盖保留安装时间，kazumiBatchUpdate/kazumiUpdateStatus 端点，前端 confirmDialog+轮询汇总 toast）④test_kazumi.py 增 9 用例（41 全绿），npm run test:all 全绿 | 已完成 |
| T47 | 下载与播放增强：①下载记录持久化（新 dl-record.js 存 userData/dl-records.json 上限 200，完成/失败落盘，buildDlList 合并推送时按 gid 补回跨会话记录避免与实时任务重复，删除/清空/清失败同步删记录防复活，HLS 与 aria2 同一链路）②mpv 截图（mpv-player 增 screenshot() screenshot-to-file subtitles 模式 + 起播注入 --screenshot-directory/--screenshot-template 使原生 s 键也存图，HK 新增 screenshot 动作默认 s 键+lua 提示+绑定，设置页快捷键卡加「打开截图目录」按钮，yuki:mpv-screenshot/yuki:mpv-screenshot-dir IPC 截图到图片/yuki 并弹通知） | 已完成 |
| T48 | 「我的」页面（观看统计 + 最近观看）：①埋点 player.js 新增 _curMeta + _recordWatch，mpv 退出时（pos≥15s 计有效观看）累计 totalSeconds/sessionCount/titles 去重/daily 近 30 天分布，并 upsert recentWatches（site\|vodId 去重，无 id 按标题）上限 50 ②新增视图 my.js + 侧栏「我的」导航（历史后）+ #view-my 区块：三统计卡（累计时长/观看次数/观看部数）+ 近 7 天条形图（my-bar-chart）+ 最近观看网格（自定义卡片带时长角标与进度条，分页 24/页，有 site\|vodId 点击进详情，无则 toast）③ui.css 增 my-stats/my-bar/my-watch-dur 样式，index.html 增 script 引入 | 已完成 |
| T49 | 爬虫健壮性：①Cookie 持久化（新 kazumi/cookie_jar.py 落盘 kazumi/cookies.json，CookieJar.set_domain_cookies/cookie_header 域名+父域匹配；RuleEngine 增 cookie_jar 参数 _do_request 自动带 Cookie 头；server.py kazumiCookieSet/List/Clear 端点；parse-window.js 捕获结束后读会话 Cookie 按域名回传后端；设置页 Kazumi 区加 Cookie 管理卡查看/清除；test_kazumi.py 增 CookieJar 5 例 + RuleEngine 带 Cookie 1 例）②视频源解析池（parse-window.js 改 3 独立 partition parse-0/1/2 槽位池 _acquire/_release，并发解析互不冲突——原共用 partition 的 session.webRequest 单例会被后注册者覆盖致并发丢请求）③HLS 广告过滤（hls-downloader.js 增 adFilter 参数 + filterAdSegments 重写播放列表：CUE-OUT/CUE-IN 之间分段 + DATERANGE ad 行 + /ad/、/ads/、/adbreak/、adsegment 路径特征分段剔除，相对地址解析绝对化，写临时 .m3u8 交 ffmpeg 后清理；设置项 hlsAdFilter 开关，addHls 读取） | 已完成 |
| T50 | 真实视频流提取三机制 + 组件测试 + 旧解析器 + MiSans 字体：①parse-window.js 视频流提取补齐三机制（webRequest 拦截媒体请求 + JS 注入轮询 <video>/<audio> 元素拿 currentSrc/src + legacy 旧解析器 iframe src 监听：注入 MutationObserver 记 window.__yuki_iframe_src，媒体直链即命中、非媒体页跟随加载限深 2 防环；captureDirect/_tryIframe/resolve 增 legacy 参数，yuki:capture-direct 兼容 {url,legacy}，kazumiResolve 返回 useLegacyParser 前端透传）②组件测试（新 tests/js/ 4 个 node --test 单测 27 例：downloader.flatten / mpv-player 静态助手 parseDanmaku·_assColor·_ts / hls-downloader filterAdSegments·isAdUri（新增导出）/ dl-record（构造器改可注入路径）；npm 增 test:jsunit 并入 test:all）③旧解析器（同上 legacy 分支，Plugin.use_legacy_parser 贯通）④MiSans 内置字体（download-binaries.js 增 misans 目标：拉 misans@4.1.0 lib/Normal 的 Regular+Bold .min.css + 按 url() 解析分片 woff2 并发 8 下载幂等；新 src/main/misans.js ensureMisans 后台跑脚本 + fontCssUrls 返回 file:// URL；index.js 启动 ensure 就绪发 yuki:font-ready + yuki:font-css IPC；preload fontCss/onFontReady；app.js 启动注入 <link> 并在就绪后重注入；ui.css font-family 置 MiSans 于系统字体前，缺字回退） | 已完成 |
| T51 | 异步会话 + 关于页：①新 src/main/async-session.js（AsyncSingleFlight.run 同 key 并发只执行一次其余复用 Promise、成功失败均释放；AsyncSerialQueue.push FIFO 串行、前一个失败不阻断后续），接入 parse-window.captureDirect 按 legacy\|url 去重合并并发捕获；tests/js/async-session.test.js 7 例（34 全绿）②关于页完整化（独立视图）：侧栏导航「关于」（设置后）+ #view-about 区块（应用 SVG 标识/名称/版本/简介 + 技术栈 chips + 致谢列表 mpv/aria2c/ffmpeg/Anime4K/MiSans/Bangumi/弹弹 play/trace.moe/Kazumi + 系统信息行）；主进程 yuki:app-info IPC 返回 version/platform/arch/electron/chromium/node/v8，preload appInfo 暴露，about.js 渲染，app.js 接线，ui.css 样式 | 已完成 |
| T52 | Bangumi 收藏同步 + 域名镜像迁移：①2026-06 曾因 bgm.tv 被屏蔽切 api.bangumi.lol / next.bangumi.lol 镜像，**2026-08-09 按用户要求改回官方 api.bgm.tv / next.bgm.tv**（docstring 同步，KAZUMI_INTEGRATION.md 更新；注：`/p1/search/subjects` 与 `/v0/users/-/collections` 端点路径经查与官方 API 不符，见 docs/RUNTIME_ISSUES.md R1/R6）②plugin_manager.py 增用户收藏同步：bangumi_me（GET /v0/me 验 token）/bangumi_user_collections（GET /v0/users/-/collections）/bangumi_collection（GET 单条）/bangumi_update_collection（PUT 失败回退 POST，type 0想看 1看过 2在看 3搁置 4抛弃）/bangumi_delete_collection；server.py 增 kazumiBangumiMe/Collections/CollectionGet/CollectionSet/CollectionDel 端点 ③前端：设置页 Kazumi 区加「Bangumi 同步」卡（token 输入保存/测试连接/我的收藏列表可删，token 存 settings.bangumiToken 仅本机）；Bangumi 详情弹窗 banner 下加「Bangumi 收藏」下拉（未收藏/想看/在看/看过/搁置/抛弃）同步按钮，打开时回填当前状态 ④bangumiToken 入 settings 约定键与 reset 保留清单 ⑤test_kazumi.py 增 TestBangumiSync 8 例（mock requests + 域名回归断言，55 全绿） | 已完成 |
| T53 | 「我的」页收藏整合 + 观看统计会话修复：①「我的」页三标签整合收藏：records.js makeRecordView 增 containerSel 参数（默认 #${viewName}），my.js 以 #my-panel-favorites 容器实例化收藏视图（复用搜索/标签筛选/分页/多选删除/批量标记/编辑，不复制逻辑）；app.js showView 旧收藏路由重定向到「我的 → 我的收藏」（删独立 Favorites.enter('favorites') 无效调用）；detail.js 收藏提示改「我的 → 我的收藏」；kazumi.js WebDAV 恢复后同步刷新新面板 ②观看统计按观看链去重：player.js 新增 _watchChain/_watchChainMax/_watchChainCounted，_rememberSession 为显式起播开新链（meta.chainId），断流重连经 player-session 提取为 _adoptSession 复用旧链，_writeWatch 按「链内最大进度 − 已计进度」只补增量，重连会话不再重复计 sessionCount/titles；最近观看进度取链内最新 ③ended 会话归属：mpv-player end-file eof 的 ended 事件附带 sessionId（活动会话 id），player.js _onEnded 按会话记录 _endedSessions，提取 _isDone 按会话匹配兜底判定（旧会话延迟 ended 不污染新会话），play() 起播重置 _endedAt/_endedSessions ④回归：player-watch.test.js +8 例（重连增量/回退不叠加/次数去重/ended 会话/isDone）、mpv-player.test.js +2 例（end-file eof 会话号），test:jsunit 52/52、test:js 33 文件全绿 ⑤真实界面验收：scripts/acceptance-my-watch.js 独立实例 + CDP 实测 24/24 通过 | 已完成 |
| T54 | 本地文件页背景模糊闪烁修复：根因 .view.active 的 viewIn（opacity+translateY）入场动画作用在含 backdrop-filter 视图的祖先上，Chromium 合成时模糊采样抖动闪烁；次因 renderLocalPage 逐条 addFile append 于模糊卡内反复重栅格化 → ①ui.css 入场动画选择器改 .view.active:not(#view-tools):not(#view-detail)，模糊卡保留 blur(8px) ②panels.js renderLocalPage 改先拼串再一次 .html() 写入，删除逐条 addFile 死函数。真实界面验收确认 #view-tools 无入场动画、模糊保留、首页对照仍有 viewIn | 已完成 |
| T55 | Kazumi 规则设置布局优化：①Kazumi 分类卡并入全宽组（ui.css grid-column:1/-1 max-width:880px，≥1500px span 2），解决半宽列过挤与多卡参差 ②规则行改两行主块（.kazumi-rule-main 名称+版本 / 安装·更新时间 .kazumi-rule-times 可见化，替代纯 tooltip），右侧徽标/编辑/开关/删除跨行对齐；覆盖 history-item 误导 cursor:pointer 与 history-url break-all 折名（word-break:normal + overflow-wrap:anywhere）；编辑钮 hover 改次级容器色与删除红区分；版本号内联样式收敛 .kazumi-subver；开关去重内联 margin ③导入卡按钮层级：导入规则(filled)+从剪贴板(tonal)+商店/新建(tonal) 前置，清空降级 md-btn-danger-tonal 置后 | 已完成 |
| T56 | 软件显示名全面改为 YuKi：窗口标题/关闭确认/托盘 tooltip 与菜单/通知/定时关机注释/mpv osd-playing-msg/index.html title/关于 about-name/引导页文案/build.productName/shortcutName 全部改 YuKi；内部兼容键保留 name=yuki、appId=com.yuki.app、数据目录 ~/.yuki/、Electron userData（AppData/Roaming/yuki，由 package name 决定、不受 productName 影响，未加顶层 productName 防数据目录漂移）、IPC 前缀 yuki:*。真实界面验收 title/关于均为 YuKi | 已完成 |
| T57 | 时间表完整复刻（对齐 Kazumi TimelinePage）：①后端 plugin_manager.py 新增 bangumi_season_calendar(start,end)（POST v0/search/subjects 按 air_date 区间 sort=rank 多页拉取、按 id 去重、_normalize_calendar_item 归一化、_season_weekday 按播出星期分桶为 7 星期桶）+ server.py kazumiBangumiSeason 端点（沿用 calendar 键）②timeline.js 重写：近 20 年季节索引（_buildSeasonOptions 按年 optgroup + 「本周（在播）」，_seasonRange/_seasonLabel 季度键算区间与标签）、current/season 双数据流（_loadCurrent/_loadSeason）、排序（_sortItems 热度 rating.total/评分 rating.score/播出 air_date）、收藏过滤（_loadColSets 经 Kazumi._getBangumiToken 拉 kazumiBangumiCollections 建 dropped/watched/watching 集合，_applyFilters 裁剪，无 token 置灰降级）、星期默认今天、卡片排名角标（rating.rank）+ 评分/日期③ui.css 排名角标/过滤 chip/排序下拉样式④kazumi.js 详情弹窗 banner 补 Ranked #N⑤测试：test_kazumi.py TestBangumiSeason 4 例 + tests/js/timeline.test.js 8 例⑥真实界面验收 scripts/acceptance-timeline.js 11/11（本周 14 卡 8 排名角标） | 已完成 |
| T58 | 返工两项（按用户最新要求）：①「我的」页移除「最近观看」标签与面板（与左侧历史页重复）：index.html 删 data-my-tab="recent" 与 #my-panel-recent，my.js 删 _renderRecent/_recentCard/recent 分支与 _page/_size，保留 观看统计+我的收藏 两标签（selectTab 白名单改 stats/favorites）②时间表卡片点击改进入仿 Kazumi 二级详情页（非弹窗）：index.html 新增 #view-bangumi-info（back-btn + #bangumi-info-body），kazumi.js 新增 openBangumiInfoPage（App.showView('bangumi-info') + scrollTop(0) + 渲染）、_renderBangumiDetail 重构为容器化（第 3 参 $box，默认 #kazumi-dialog-body；tabs/content 由 id=bangumi-detail-tabs/-content 改 class=bangumi-detail-tabs/-content 防弹窗/二级页双实例 id 冲突，_loadBangumiTab 增 $content 参），init 绑 #bangumi-info-back 回时间表，timeline.js 卡片点击由 openBangumiDetail 改 openBangumiInfoPage，ui.css #bangumi-info-body 限宽 880px。Kazumi 源弹窗流程（openBangumiDetail）不受影响仍走弹窗。真实界面验收 scripts/acceptance-rework.js 10/10 | 已完成 |
| T59 | Bug 清理（前项）：①搜索封面立即加载：common.js vodCoverImg(pic,eager)/home.js vodCard(v,src,eager) 增 eager 参，search.js _paintGrp 传 eager=true（含 Kazumi 卡模板），搜索当前页封面 loading=eager 不再等懒加载②内嵌滚动区统一隐藏滚动条：ui.css 补 .md-dialog-body/.bangumi-detail-content/.detail-desc/#view-direct 的 scrollbar-width:none + ::-webkit-scrollbar③修复 bangumi_user_collections limit 钳制 100（时间表收藏过滤请求 limit=200 触发 Bangumi API 400，日志验证时发现）④验证日志功能有效（~/.yuki/logs 三日志正常写入 + RotatingLogWriter 轮转） | 已完成 |
| T60 | Bug 清理（后项）：①搜索页隐藏无结果的源：search.js renderGroup 对 total=0 提前 return（不出分组卡/来源筛选标签），onmessage 与 Kazumi 聚合的源计数只统计有结果源②首页屏蔽无影片分类：home.js 增 _emptyCls/_clsProbed 字段与 _probeClasses（后台并发 4 逐个 categoryContent pg=1 探测，确认空的分类加入 site 级空集，loadHome 末尾 fire-and-forget 触发，同源只探一次、出错保留分类、激活分类不隐藏、_loadToken/源集合变更作废），renderClass 过滤空分类③分页实测：scripts/acceptance-bugfix.js 预置 25 收藏验证分页器渲染与翻页（6/6），分页代码经核查无缺陷 | 已完成 |
| T61 | MiSans 字体打包内置（方向由 2A 移除改为内置）：①misans.js 重写——去运行时下载（删 spawn download-binaries），ensureMisans 仅探测内置字体就绪，fontCssUrls 返回 vendor/misans CSS 的 file:// URL②恢复主进程→渲染层注入链路：index.js require misans + ipcMain yuki:font-css + 启动 ensureMisans 探测，preload fontCss，app.js bootstrap 头部注入 <link>③ui.css 字体栈改 MiSans 优先回退 system-ui④package.json build:* 前置 node scripts/download-binaries.js misans（幂等）保证打包随附字体（vendor gitignore，构建时补齐）⑤更新 settings-2a.test.js 与 acceptance-2a.js 断言（由「无 MiSans」改为「file:// 内置加载、无运行时下载就绪事件」）。真实验收 acceptance-2a.js 9/9（MiSans file:// 打包内置、非网络下载） | 已完成 |
| T62 | Kazumi 首页推荐页（对齐 Kazumi PopularPage）：①后端 bangumi_trends 归一化——/p1/trending/subjects 条目为 {subject:{...}} 包裹，取 subject 复用 _normalize_calendar_item 补 name_cn/air_date，返回 {items,total}；server kazumiBangumiTrends 透传 limit/offset（钳制 limit≤50）②common.js 新增共享 bangumiCard（封面+排名角标+片名+评分/播出日期），timeline._renderCard 复用之，CSS 角标类 timeline-rank-badge 改名 bangumi-rank-badge③新 popular.js（Popular 对象：懒加载 enter、load(page) 分页、renderPagerBox、卡片点击进二级详情 openBangumiInfoPage）+ index.html 推荐导航项与 #view-popular 视图 + app.js showView 接线 + Popular 全局④测试：test_kazumi TestBangumiTrends 2 例（解包裹归一化/失败空返回）；真实验收 scripts/acceptance-popular.js | 已完成 |
| T63 | 影片详情页仿 Kazumi 视觉优化：_renderBangumiDetail 顶部横幅 kazumi-bangumi-banner 升级为仿 Kazumi InfoPage 信息卡 bangumi-info-card——大号标题 + 横向布局（封面 150px / 放送开始日期 / N 人评分 + 5 星填充星级 score/10 / 「Bangumi Ranked #N」/ 评分透视柱状图 rating.count 1-10 分人数分布 10 柱）+ 简介 stripHtml 后 pre-line；弹窗与二级页复用同一渲染（T58 容器化）；ui.css 新增 bangumi-info-card/bi-label/bi-value/bi-stars(底层灰星+顶层金星宽度裁剪)/bi-hist 系列样式，窄窗(≤700px)隐藏柱状图。真实验收 scripts/acceptance-detail-card.js；acceptance-rework/popular 的 banner 选择器同步改 .bangumi-info-card | 已完成 |
| T65 | 性能·列表批量渲染：home.js renderGrid/_appendGrid/renderClass、live.js renderList/renderGroups/源选项、records.js 收藏历史 render、timeline.js 季节选项，全部由「forEach 逐条 append」改为「map 拼串后单次 html()/append()」，减少大列表 N 次 DOM 重排 | 已完成 |
| T66 | UI·响应式卡片/字号：ui.css 增媒体查询——≥1800px 卡片列宽 minmax 168px、标题 14px/备注 12px；≤1000px 列宽 minmax 120px、标题 12px/备注 10px（默认 140px/13px/11px），卡片网格与文字随窗口宽度自适应 | 已完成 |
| T67 | 全量功能测试：新增 scripts/acceptance-content.js（首页/搜索/历史/我的页统计+收藏，9 项）与 scripts/acceptance-system.js（设置 10 分类/Kazumi 规则列表/直播/下载/本地文件/直链，9 项）；汇总 10 个 CDP 验收脚本共 102 检查项 + JS 单元 60 + Python 38 + 语法 34 文件，全部通过（200 项）；新建 docs/TEST_REPORT.md 记录功能测试矩阵（按内容/播放/下载/UI 模块分 ✅ 自动通过 与 🔬 需用户实测）、自动化明细、复现方式，并纳入 docs/README 与 PROGRESS §2/§7、根 README 文档列表 | 已完成 |
## 8.9 2026-08-09 2A 收口记录

- 2A 已完成代码修改：统一系统字体；移除 MiSans 运行时动态下载、注入和字体切换；删除画中画设置、preload API、主进程 IPC 与小窗逻辑；删除系统页版本号；关于内容迁入设置一级分类并保留关于页版本号；设置固定在左侧功能项底部。
- 回归验证：Python 全量 38 项通过；JavaScript 单元测试 45/45 通过；33 个 JavaScript 文件语法检查通过。
- 界面验收（2026-08-09 补）：经临时调试实例（独立 userData 副本清空 `lastConfigUrl`）+ CDP 实测全部通过——设置位于左侧功能项末尾（order 98）、收缩按钮在其下并贴导航底（order 99）、左侧无独立关于入口/视图、系统页无画中画与版本号、关于分类渲染版本号与系统信息、页面无 MiSans 动态注入、控制台无错误。验收脚本 `scripts/acceptance-2a.js`。此前的临时调试实例因控制连接中断未计为通过，本轮以独立实例重测补齐。
- 未完成：2B 的直播分页设置、下载页打开本地文件夹、本地文件背景模糊闪烁仍待确认后实施。当前有效状态与后续任务以 `../PROGRESS.md` 为准。

## 8.10 2026-08-10 「我的」页收藏整合与观看统计修复记录

- 收藏入口整合：左侧独立收藏入口已删除，收藏并入「我的 → 我的收藏」页签；`records.js` 的 `makeRecordView` 增 `containerSel` 容器参数供内嵌面板复用事件委托根，避免复制收藏逻辑造成双份漂移。旧 `#view-favorites` 独立区块与 `Favorites` 实例仍保留（player.js 观看进度、kazumi.js WebDAV 恢复仍引用其 store 方法），由 `app.js` 路由重定向兜底。
- 观看统计去重：修复断流重连导致同一次观看被按两段绝对进度重复累计（totalSeconds/sessionCount 双计）——改按观看链（chainId）取链内最大进度、只补增量；观看次数与部数每条链只计一次。
- ended 会话归属：`ended` 事件附带会话号，`_isDone` 按会话匹配「看完」兜底判定，起播时重置上一集 ended 时间戳与会话记录，避免旧集 ended 在 IPC 断开且无进度时把新集误判为看完并错误连播。
- 回归验证：JavaScript 单元测试 52/52 通过；33 个 JavaScript 文件语法检查通过；真实界面验收（独立实例 + CDP，`scripts/acceptance-my-watch.js`）24/24 通过，含观看链增量/次数去重、ended 会话归属、收藏搜索/标签/多选删除、最近观看、统计数值与旧收藏路由重定向。
- 未完成：本地文件页背景模糊闪烁、Kazumi 规则页布局、Kazumi 独立首页推荐、时间表完整复刻、影片详情页视觉优化、MiSans 打包内置、软件更名 YuKi、Windows 冷启动实测等，见 `../PROGRESS.md`。

## 8.11 2026-08-10 问题清单批处理 + SourceSheet 选源重构 + 统一详情页记录

- **收藏 404（R9）**：`bangumi_update_collection`/`bangumi_delete_collection` 重写为全矩阵尝试 `{POST, PUT} × {`-` 通配, 真实用户名} × {官方 api.bgm.tv, 镜像 api.bangumi.lol}`，首个 2xx 即成功；鉴权类 401/403 优先返回。对齐 Kazumi 原版 POST `/v0/users/-/collections/{id}`。
- **以图搜番（R10 + 显示修复）**：trace.moe URL 直传返回 403，改为后端先下载图片字节再原始上传；`Content-Type` 按文件头识别；补浏览器 UA；失败返回 `error` 字段前端 toast。结果卡片封面改用 `vodCoverChain` 多级兜底（AniList 封面 → trace.moe 匹配帧 → 占位图），修复原 `onerror=display:none` 在封面被墙时留灰底空框的问题。
- **历史按次记录**：`recordPlay` 每次播放新增独立 `kind:'play'` 记录（不再累加「已播几集」）；`addHistory` 标 `kind:'view'`；卡片显示「集名 · 时长 · 播放时间」；历史 Kazumi 源封面从 Bangumi 拉取并缓存。
- **搜索页 Kazumi 流式**：新增后端 SSE `/search/kazumi-stream`，`_runKazumi` 边搜边渲染；验证码源分组提示点击打开可见验证窗口。
- **搜索进度提示优化**：`#search-status` 由纯文字改为 spinner + 进度条 + 源/结果计数组件；后端 `/search/stream` 先发 `meta`（总源数）使进度条确定填充；搜索启动立即显示消除空档。
- **SourceSheet 选源重构（T74，完整对齐 Kazumi）**：`openSourceDialog` 改为并发流式弹窗——每启用源一张可折叠卡片 + 状态徽标（检索中/N 条/需验证/检索失败/无结果），首个有结果源自动展开；点结果解析选集（带「← 返回选源」）；每源补救操作（重试/进行验证/手动检索/浏览器打开）；后端 `kazumiSearch` 支持 `plugin` 过滤 + 丰富状态。
- **统一详情页（T74）**：新增 `Detail.openBangumi` 复用 `#view-detail`，CatVod 源/Bangumi-only 自适应（评分/收藏同步/开始观看/标签/分集）；`openBangumiInfoPage` 委托统一页；移除 `#view-bangumi-info` 视图与 `_backFromInfo`。
- **验证码可见窗口（T74）**：主进程 `yuki:captcha-verify` + `ParseWindow.captchaVerify`（可见 BrowserWindow，关闭收割 Cookie 推后端），选源弹窗/搜索页验证码源点击打开，完成后自动重查该源。
- **缓存（T74）**：`detailContent` 10 分钟缓存、`Kazumi.bangumiInfo` 30 分钟缓存、详情页 Bangumi 匹配走 `getBangumiMatch`（复用 T73 封面缓存）。
- **其余**：每页数量 10/16 选项、界面动画开关与 MiSans 统一、设置页删外部播放器/合并缓存板块、下载页按钮排一行、规则按钮避让、代理关闭 `mode:'system'` 还原、Token 链接跳系统浏览器、卡片标题 2 行限行。
- 回归验证：JavaScript 单元测试 80/81 通过（唯一失败为既有 `#popular-tags` 断言，元素全库不存在，与功能无关）；34 个 JS 文件语法 0 错误；Python 后端（smoke + unit + compile）全部通过；真实界面验收 10 脚本 / 103 检查项全部通过（`scripts/acceptance-*.js`，更新了 detail-card/popular/rework 断言为统一详情页、content/bugfix/my-watch 清空种子 bangumiToken、t55 卡数 5→7）。


## 8.12 2026-08-11 首页空分类隐藏加固（T60 续）

- **空分类结果持久化（含时间戳）**：`_emptyCls`/`_okCls` 按 site 落盘到 `localStorage['yuki_home_empty_classes']`（`{ site: { ts, empty, ok } }`，兼容旧数组格式视为过期），`Home.init()` 载入——再次载入该源/重启后首屏即隐藏已知空分类（无「先渲染全部分类再后台隐藏」的闪现）；源集合变更时清空持久化。
- **探测不丢进度（非丢进度版）**：结果按 site 键隔离记录，不随 token/换源丢弃——探测期间切分类/切源不再丢失已探测分类；`unclassified===0`（全部分类确认）才标记 `_clsProbed[site]`，出错留待下次载入重试且只探测未知分类；`_clsBusy[site]` 防并发重复探测；`_persistEmptyClasses` 在循环后先行落盘，中断前的部分确认也不丢失。
- **全源后台探测（_probeAllClasses）**：为所有未探测分类的活跃源补齐类别空态探测（站点级并发 2、分类级并发 6，`_probeToken` 世代校验、配置重载作废），切换任意源即可直接过滤空分类；数据新鲜（`EMPTY_CLS_TTL`=24h）的源跳过不重复探测，过期/缺失才补探，避免每次启动全量重探。
- **`renderClass` 归一化**：激活分类判断 `String(c.type_id) !== String(activeTid)`，防数字型 type_id 与字符串 activeTid 比较误隐藏激活分类；曾判空分类恢复内容则移出空集并重渲（重新显示）。
- **单元测试**：新增 `tests/js/home-probe.test.js` 19 例（vm 加载 home.js + localStorage Map 桩），覆盖空/有内容分类、同源只探一次、在途防并发、中断不丢进度、换源不重渲、出错重试只探未知、曾判空恢复内容、renderClass 过滤与归一化、持久化往返/旧格式兼容/新鲜跳过/过期重探/全源扫描。
- **真实界面验收**：新增 `scripts/acceptance-empty-class.js`（独立 userData 副本 + CDP，利用内置离线 demo 源）6/6 通过——双空分类（电影/剧集）探测后分类栏仅「全部」、持久化 demo=[movie,serie]、桩 doAction 令剧集有内容后重探测分类栏为「全部+剧集」、持久化更新 demo=[movie]、无 home.js 控制台错误。
- **真实源诊断**：`scripts/diag-real-app.js`（保留用户真实 lastConfigUrl，切 量子资源/新浪资源/豆瓣资源）7/7 通过——后台扫描自动探测 ≥5 个未选中源、持久化多源落盘、量子资源（电影资讯/新闻资讯/娱乐新闻/演员等 4 个空分类全部从分类栏消失）+ 新浪资源 + 豆瓣资源探测完成且空分类全部隐藏、无 home.js 控制台错误。
- 回归验证：`npm run test:jsunit`（102 通过，唯一失败为既有 `#popular-tags` 断言）、`npm run test:js`（34 文件 0 错误）、`scripts/acceptance-empty-class.js`、`scripts/diag-real-app.js` 全部通过。

## 8.13 2026-08-11 推荐页切换卡顿修复

- **卡顿根因**：`popular.js` 的 `Popular.enter()` 首次进入推荐页时 `await load(1)` 同步等 `kazumiBangumiTrends` 网络请求（真实源 CDP 实测 ~1.9s，命中 api.bgm.tv），期间 `#popular-grid` 空白 → 感知为「切换卡顿」；showView 同步切换本身仅 4ms、切走再切回因内存 `_items` 复用为 0ms（即仅每次重启后首次点推荐卡）。
- **修复**：①本地缓存 `localStorage['popular_cache']`（热门番组/趋势落地视图；标签视图不覆盖）——`enter()` 内存无数据时先命中缓存立即上屏，再后台静默刷新；无缓存才等网络 ②启动时 `App.showView(startupView)` 后后台 `Popular.preload()`（`load(1, true)` 静默）填充内存 + 刷新缓存，点开推荐页即时显示 ③`load(page, silent)` 静默模式不弹 loading/失败不 toast；会话内已加载则 enter 直接复用。
- **测试**：新增 `tests/js/popular-cache.test.js` 5 例（vm 加载 popular.js + localStorage 桩）——缓存命中同步上屏并后台刷新、无缓存加载后写缓存、会话内已加载不重复拉取、silent 不弹 loading/失败不 toast、标签视图不覆盖缓存。
- **真实应用 CDP 实测**（`scripts/diag-popular.js`）：点开推荐页网格填充耗时 **1906ms → 6ms**、showView 同步 0ms、无长任务；预载后 `Popular._items` 已满 24 条且缓存已写。
- 回归验证：`npm run test:jsunit`、`npm run test:js`、`scripts/acceptance-empty-class.js` 全部通过。

## 8.14 2026-08-11 每页影片数量超过 20 不生效修复（T75）

- **根因**（真实源 CDP 实测，pageSizeHome=36）：①首页填充 `_extendHome` 只拉 `classes[0]`（首个分类）——量子资源首个分类「电影片」仅 1 条，首页推荐位也只有 1 条、填充上不去，`_homeList` 停在 1；②分类页 `_fetchCat` 只取源返回的一页（CMS 源每页 ~20 条）再 `slice(0, size)`——设置 36/60/120 也显示 20；首页 `_fillPg<3` 上限 + 首个分类耗尽即 break，不换分类。
- **首页填充修复**：`_extendHome` 改为逐分类逐页推进——拉完一个分类的空页/短页（<10 条，无助于填满）或拉满 3 页即换下一个分类，直到 `_homeList` 达到每页条数目标；加 `idx<0`/全部分类耗尽 break 防环、总请求护栏 `max(60, target*2)`；`_onResize` 补拉沿用新逻辑。
- **分类页合并修复**：新增 `_catWin` 源页合并窗口（Map LRU，key `site|tid` → `{items, seen, sourcePg, total, perPage}`）——`_fetchCat` 连续拉取源页合并去重直到覆盖 `pg*size` 条，`_catItems = slice((pg-1)*size, pg*size)`；应用 pagecount = `ceil(源总量/每页条数)`（total 未知则按已拉条数/暂允下一页）；翻页复用窗口不重复请求；force 刷新/`_cacheDropSite`/配置变更作废窗口。
- **测试**：`tests/js/home-probe.test.js` +3 例（合并 2 源页得 36 条且 pagecount=ceil(total/36)、翻页只补缺失源页 [1,2,3,4]、首个分类短页自动换下个分类填满目标）。
- **真实源 CDP 实测**（`scripts/diag-pagesize.js`，pageSizeHome=36）：首页填充 1→46 卡（≥36，跨分类推进）；分类页(动作片)显示 36 条、pagecount 137（原 247 源页）、翻第 2 页内容不同（`pagesDiffer=true`）；`scripts/diag-real-app.js` 空分类隐藏 7/7 仍通过。
- 回归验证：`npm run test:jsunit`、`npm run test:js`、`scripts/acceptance-empty-class.js` 全部通过（唯一失败为既有 `#popular-tags` 断言）。

## 8.15 2026-08-11 「全部」标签分页（T76）

- **问题**：「全部」标签即首页自适应视图（`loadHome()`：推荐位 + 各分类铺满每页条数），末尾 `$('#home-pager').empty()` 明确清空分页器——设计上单页，无法翻页浏览源全部内容；具体分类才带分页器。
- **后端**：`homeVideoContent` 支持分页——`cms_spider.py` 改为 `{page, pagecount, limit, total, list}`（`{ac: videolist, pg}` 不带分类 t，即源全部/最新 feed）；`server.py do=homeVideoContent`、`app.py homeVideoContent(ru, pg='1')`、`runner.py homeVideoContent(self, pg='1')` 透传 pg（runner 对不接受 pg 的旧爬虫 `try/except TypeError` 回退无参调用，保持原契约兼容）。
- **前端**：`loadHome(pg)`——第 1 页保持自适应首页（推荐位+分类铺满），第 2 页起走源总览 feed：新增 `_fetchHomeFeed(pg, size)`（复用 `_catWin` 合并窗口，key `site|__all__`，连续拉取 homeVideoContent 源页合并去重直到覆盖 `(pg-1)*size` 条，`_homeList=slice((pg-2)*size,(pg-1)*size)`，翻页只补缺失源页）；`_probeHomeFeedTotal`（第 1 页载入后后台取 feed 首页定总页数并 `renderPager`，总页数 = 1 自适应首页 + ceil(源总量/每页条数)，源无 feed 则单页不出分页器）；`renderPager` mode=home 跳转 `loadHome(pg)`；刷新按钮保留当前页（`loadHome(this.page)`）。
- **测试**：`tests/js/home-probe.test.js` +4 例（feed 第 2 页合并 2 源页得 36 条且总页数含自适应首页、翻页只补源页 [1,2,3,4]、第 1 页 `_probeHomeFeedTotal` 定总页数并渲染分页器、源无 feed 单页不出分页器）。
- **真实源 CDP 实测**（`scripts/diag-all-pager.js`，pageSizeHome=36，量子资源）：「全部」第 1 页出分页器（pagecount 4138，feed total 148923）；真实点击「下一页」→ 第 2 页显示 36 条 feed、网格 36 卡；第 3 页正常（窗口 40→80 条，sourcePg 2→4）；页间内容不同；后端 `homeVideoContent pg=2` 返回 20 条。`diag-real-app.js` 空分类隐藏 7/7 仍通过。
- **回归**：顺带修复既有 phase3 SSE 测试未随 T74 `event: meta` 更新导致的失败（data_events 4→5、source 提取跳过 meta）。`npm run test:py`、`test:jsunit`、`test:js`、`scripts/acceptance-empty-class.js` 全部通过（JS 唯一失败为既有 `#popular-tags` 断言）。

## 8.16 2026-08-11 修改配置/每页条数后回到页面不立即生效修复（T77）

- **问题**：重新载入源配置（改分类）或改每页条数后，回到分类页仍显示旧缓存内容，需手动点刷新（force 清缓存）才生效。
- **根因**：`_pageCache`（分类页 LRU 缓存）与 `_catWin`（源页合并窗口）在配置重载/改每页条数时未作废——`loadSites` 的源集合变更分支只重置空分类探测状态（`_emptyCls`/`_clsProbed`/`_clsTs`/`_catWin`），未清 `_pageCache`；且同 key 配置重载（sig 不变）连 `_catWin` 也不清。改每页条数仅 `invalidatePageSizeCache()` 清 `pageSizeOf` 缓存，未清分类内容缓存 → 缓存页是旧尺寸/旧内容。
- **修复**：新增 `Home.invalidatePageCaches()`（清 `_pageCache` + `_catWin`）；`loadSites()` 开头调用（覆盖配置重载/屏蔽源变更/启动，含同 key 重载）；`common.js` 的 `invalidatePageSizeCache()` 改每页条数时联动 `Home.invalidatePageCaches()`。回到页面即命中新数据。
- **测试**：`tests/js/home-probe.test.js` +1 例（invalidatePageCaches 作废两缓存）。
- **实测**：真实应用 CDP——`Home.loadSites()` 后 `_catWin` 2→0（修复前为 3 不清）；离线 demo 源验证 `invalidatePageSizeCache()` 清空 Home 内容缓存 + `pageSizeOf` 缓存。
- 回归验证：`npm run test:jsunit`、`test:js`、`scripts/acceptance-empty-class.js`、`diag-real-app.js` 全部通过（JS 唯一失败为既有 `#popular-tags` 断言）。

## 8.17 2026-08-11 「全部」标签按设置每页条数显示（T78）

- **问题**：设每页条数后，「全部」第 1 页（自适应首页：推荐位 + 各分类逐页铺满）显示条数与设置不符——首个分类内容少/源限流时分类填充极慢（真实源实测 30s 仍未到目标，量子资源 `_homeList` 停在 6 条），而第 2 页起的 feed 正常（严格 = 设置条数）。根因：T76 把第 1 页定为自适应分类填充（逐分类爬取慢、且 `_extendHome` 需多轮请求），仅第 2 页起用 feed。
- **修复**：「全部」所有页统一用源总览 feed（`homeVideoContent` 合并源页填满每页条数）：`loadHome(pg)` 第 1 页也走 `_fetchHomeFeed`；`_fetchHomeFeed` 改为 `need = pg*size`、`_homeList = win.items.slice((pg-1)*size, pg*size)`、总页数 `ceil(源总量/每页条数)`（去掉第 1 页自适应首页的 +1 偏移）；源不支持 homeVideoContent（feed 空）时第 1 页回退自适应首页（推荐位 + 分类铺满）、单页不分页；删除冗余 `_probeHomeFeedTotal`。
- **测试**：`tests/js/home-probe.test.js` 更新 T76 用例（第 1 页 = feed 前 size 条且 `slice(36,72)` 第 2 页从第 36 条开始、总页数无 +1、翻页只补源页、无 feed 返回空触发回退）。
- **真实源 CDP 实测**：PS=24 ——「全部」第 1 页 `_homeList` 24/24 条（原 6 条）、第 2/3 页 24 条；PS=36 —— 第 1 页 36 卡、pagecount 4137（无 +1）、分页器 8 按钮、真实点「下一页」→ 36 卡；`diag-real-app.js` 空分类隐藏 7/7 仍通过。
- 回归验证：`npm run test:py`（ALL PASS）、`test:jsunit`、`test:js`、`scripts/acceptance-empty-class.js`、`diag-real-app.js` 全部通过（JS 唯一失败为既有 `#popular-tags` 断言）。

## 8.18 2026-08-11 「全部」底部分页器消失修复（T79）

- **问题**：T78 后「全部」标签分页器在部分源上消失。真实源 CDP 复现：默认源（zp059）feed 返回 20 条但 total=0（源不返回总量），`_fetchHomeFeed` 总页数逻辑走 `Math.max(1, pg)=1` → `renderPagerBox` pagecount≤1 不渲染（分页按钮 0）；T76 的 `_probeHomeFeedTotal` 在此情形会设 pagecount=2。
- **修复**：`_fetchHomeFeed` 总页数逻辑对齐分类页「未知总量暂允试下一页」——`win.total>0` → `ceil(total/size)`；`win.items.length < need`（源已拉空）→ `ceil(实际条数/size)`；否则 → `max(this.pagecount||1, pg+1)`，保证 feed 有内容就有分页器可向前翻页（翻到空页再按实际修正）。
- **测试**：`tests/js/home-probe.test.js` +1 例（feed 有内容无总量 → pagecount 2、翻页 pagecount 3）。
- **实测**：离线 demo 源 + 桩 doAction 确定性验证——`homeVideoContent` 返回有内容无总量时，「全部」`_homeList` 20、pagecount 2、分页器 6 按钮。
- 回归验证：`npm run test:jsunit`、`test:js`、`scripts/acceptance-empty-class.js` 全部通过（JS 唯一失败为既有 `#popular-tags` 断言）。

## 8.19 2026-08-11 设置改每页条数后回页面不更新修复（T80）

- **问题**：设置里改完每页影片数量，返回对应页面（首页/分类）每页条数没更新，需手动切换页面或点刷新。根因：改页数只清了 `_pageSizeCache`（`pageSizeOf` 缓存）和分类内容缓存（`_pageCache`/`_catWin`），但 `showView('home')` 不会重渲染当前模式——分类/「全部」视图仍显示内存里的旧列表与旧分页器，须切分类/点刷新（force）才重新走 `loadCategory`/`loadHome`。
- **修复**：①`Home.invalidatePageCaches()` 末尾置 `_pageSizeDirty = true`（T77 已把改页数接进来）；②新增 `Home.onViewShown()`——回到首页视图时若脏，按当前模式自动重载：`mode=category → loadCategory(this.tid, this.page)`、`mode=search → searchCurrent`、`mode=home → loadHome(this.page)`，并清标记；③`app.js showView` 对 `name==='home'` 调用 `Home.onViewShown()`；④`loadHome` 完整重载后清 `_pageSizeDirty`（避免 loadSites 后误触发）。
- **测试**：`tests/js/home-probe.test.js` +2 例（invalidatePageCaches 置脏、onViewShown 分类/全部模式重载且未脏不重载）。
- **实测**（离线 demo 源 + CDP）：改每页条数 20→36 → `Home._pageSizeDirty` true → 切设置再回首页 → 脏标记 false、`_loadToken` 变化（确已重载）、`pageSizeOf`=36。
- 回归验证：`npm run test:jsunit`、`test:js`、`scripts/acceptance-empty-class.js` 全部通过（JS 唯一失败为既有 `#popular-tags` 断言）。

## 8.20 2026-08-11 首页探测进度条（T81）

- **需求**（与用户商量确认）：启动/配置重载后的后台源探测在首页显示进度条——合并两个探测（`_probeSites` 屏蔽无内容源 + `_probeAllClasses` 隐藏空分类）为总进度；**超过约 1 秒才显示**（避免快速探测闪现）；**完成显示「已完成」约 1.5 秒后淡出隐藏**。
- **实现**（home.js + index.html + ui.css）：`_probeBar` 状态 + `_startProbe(total)`（记入总进度、1s showTimer）/`_probeOneDone()`（单源完成）/`_endProbe()`（全部完成→完成态+1.5s doneTimer 隐藏）/`_updateProbeBar()`/`_hideProbeBar()`；`_probeSites` 与 `_probeAllClasses` 各自 `_startProbe(pending.length)` 并在 finally `_endProbe()`，单源 `_probeOneDone()`，合并成一条总进度「正在探测源… X/Y」；total≤0 不计入（快速/无待探测不闪现）；首页 `#home-probe-bar` 复用搜索进度条 `.search-status`/`.ss-*` 样式（spinner+进度条+计数），CSS 补 `#home-probe-bar{margin-top:8px}`。
- **测试**：`tests/js/home-probe.test.js` +3 例（合并两探测总进度 active/done、已显示则完成态延迟 1.5s 隐藏、total≤0 不计入）。
- **实测**（离线 demo 源 + CDP 直接驱动）：开始不显示 → 超 1s 显示「正在探测源…0/100」→ 逐个完成态「已完成100/100」（`.done`）→ 1.5s 后隐藏。
- 回归验证：`npm run test:jsunit`、`test:js`、`scripts/acceptance-empty-class.js` 全部通过（JS 唯一失败为既有 `#popular-tags` 断言）。

## 8.21 2026-08-11 搜索进度条卡顿修复 + 显示逻辑统一（T82）

- **问题**：搜索时进度条 spinner 旋转动画卡顿——`search.js _setStatus` 每次源完成（SSE 事件）都用 `.html()` 重建整个进度条（含 `.ss-spinner` 元素），CSS 旋转动画（`sspin`）从第 0 帧重新开始；源多（141+）时更新频繁 → 持续卡顿。且搜索一开始就显示进度条（与首页「超 1s 才显示」不一致）。
- **修复**（与用户商量确认：稳定 spinner 元素 / 首个结果或超 1s 显示 / 完成态 1.5s 后隐藏）：①`common.js` 新增共享 `renderStatusBar($el, opts)`——结构（spinner+text+bar+count）只创建一次，后续只更新 `.ss-text` 文本、`.ss-fill` 宽度、`.ss-count` 计数，spinner 元素保持稳定 → 动画不中断；支持 total>0 定宽 / 无总量 indeterminate、done 态（`.done` 类隐藏 spinner、宽 100%）、unit 单位后缀、items 结果计数。②`search.js _setStatus` 重写——显示逻辑同首页：recv=0 时不显示并调度 1s 定时器，有首个结果（recv>0）或超 1s 才显示；完成态约 1.5s 后淡出隐藏（快速搜索未显示过则不闪现完成态）；`run`/`stop` 重置 `_statusShown/_statusTimer/_statusDoneTimer/_lastStatus` 并隐藏。③`home.js _updateProbeBar` 改用 `renderStatusBar`（修同样的潜在卡顿）。
- **实测**（离线 demo + CDP）：spinner 元素跨多次更新引用不变（不重建）；搜索 recv=0 立即不显示 → 超 1s 显示「0/50」→ 计数更新 7/50 → 完成态「已完成」（`.done`）→ 1.5s 后隐藏；home `renderStatusBar` 完成态宽 100%。
- 回归验证：`npm run test:jsunit`、`test:js`、`scripts/acceptance-empty-class.js` 全部通过（JS 唯一失败为既有 `#popular-tags` 断言）。

## 8.22 2026-08-11 搜索页签切换进度条凭空出现/常驻修复（T83）

- **问题**：点击聚合搜索/Kazumi 源页签，进度条会重新出现并常驻。根因：`search.js` 页签切换第 47 行 `$('#search-filters, #search-status, #search-results').toggle(!isImage)`——切到聚合/Kazumi（`!isImage`=true）时 `.toggle(true)` **无条件显示 `#search-status`**，即使没有任何搜索在进行；无搜索就不会触发隐藏逻辑（没有 done 定时器/新搜索）→ 常驻。
- **修复**：①第 47 行拆开——`#search-filters, #search-results` 仍按页签显隐，`#search-status` 改为 `$('#search-status').toggle(!isImage && this._statusShown)`（只在有进行中的搜索状态时才随页签显示）；②`_setStatus` 显示路径（recv>0 立即显示 / 1s 定时器）加 `_stab !== 'image'` 守卫——切到「以图搜番」页签时搜索仍在后台跑，但进度条不显示。
- **实测**（离线 demo + CDP）：无搜索时切聚合/Kazumi 进度条隐藏（修复前会显示并常驻）；有搜索（`_statusShown=true`）按页签显隐——聚合/Kazumi 显示、以图搜番隐藏、切回聚合显示；以图搜番页签下 `_setStatus(recv>0)` 不把状态显示出来。
- 回归验证：`npm run test:jsunit`、`test:js`、`scripts/acceptance-empty-class.js` 全部通过（JS 唯一失败为既有 `#popular-tags` 断言）。
