# 影视 PC — 开发总纲（跨会话续作唯一入口）

> 续作开发只需读本文件。本文档已整合原 `重构方案.md`、`PHASE0_依赖矩阵.md`、`BUILD.md`、`FEATURES.md`、`PROGRESS.md` 五份文档，其余 md 已删除。
> 约定：改动架构/链路前先更新「§4 架构决策」；新增功能后在「§7 功能清单」补一行；收尾跑 `npm run test:all` 全绿。
> 行号锚点目录（编辑后若漂移，grep `^##` 重新定位）：§1 项目概述 L9 · §2 Phase 总览 L17 · §3 环境与命令 L33 · §4 架构决策 L57（子节：进程通信 L59 / 插件爬虫 L66 / 前端UI L77 / 文件管理 L86 / 下载 L91 / 推送设置解析 L99）· §5 Spider 契约 L132 · §6 构建打包 L147 · §7 前端注意与功能 L167（注意事项 L169 / 功能概览 L179）· §8 已知坑位 L199 · §8.7 待完成 L222 · §8.8 进行中任务 L229

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
13. **站点类型支持面**：type=3 Python（http .py / 内联）、type=4 与 type=3+http .js 直链（JS spider）、type=0/1 CMS（苹果 CMS JSON/XML，`cms_spider.py` 纯 HTTP）。api 相对路径按配置 URL urljoin。TVBox jar 型源（api=csp_XXX）与 drpy 源识别后跳过，勿当 Python 源码执行；spider.jar 依赖 Android API，勿尝试 JRE。多仓 config（顶层 `urls`）优先上次成功条目（last_repo.txt，T40），首个 `sites>0` 的条目作主仓；命中后并行补拉其余条目跨仓合并（T44）：lives 按 url 去重（嵌套 channels 展平）、sites 按 key 去重追加，主仓优先只增不删；偏好条目首次失败自动重试一次。
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
32. **设置持久化**：`settings.js` 存 `<userData>/settings.json`，键 camelCase。约定键：lastConfigUrl / playerVolume / customLives / dlDir / configHistory / favorites / history / theme / wallpaper / colorMode / fontSize / textSize / textColor / wallpaperDim / blockedSites / probedSites / playerHotkeys / navCollapsed / playerSpeed / autoNext / resumePos / bgPlay / animEnabled / closeAction / incognito / cacheDir / dlConcurrency / playerCacheMode / playerCacheDir 等。自定义数据键（customLives、lastConfigUrl、favorites、history、dlDir、cacheDir、playerCacheMode、playerCacheDir、configHistory）在 `settings.reset()` 中显式保留。
33. **配置自动重载**：setting(name=config) 成功后渲染层存 URL 与历史；启动时主进程在 backend ready 后 POST do=setting 自动重载，成功发 `vpc:config-reloaded`，前端 Home/Live 刷新。
34. **配置重载状态机**（修首屏）：主进程 `configReload = {reloading, url}`，backend ready 进入重载时同步置位，所有收尾路径经 `finishReload(ok, sites)` 复位并发 `vpc:config-reloaded`；渲染层经 `vpc:config-state` IPC 取权威状态，app.js waitConfigDone 双状态轮询。改动启动链路时保持该状态机。
35. **VIP 解析**（决策 38/33）：parses 来自 config（/sites）。parse=1 全自动起播流程：地址已是媒体直链 → 直接 mpv；否则 type=1 JSON 接口优先直接 fetch（兼容 url/data.url/vurl/play_url 多字段，抓返回里的 Referer/UA 交 mpv，解出 .html 视为失败）→ 失败再 iframe 型隐藏 BrowserWindow（partition 'parse' 独立 session，webRequest.onBeforeRequest 捕获 resourceType=media 或媒体扩展名）→ 再失败 `vpc:capture-direct`（隐藏窗口直开链接抓页面自身播放器请求）。每接口 20s 超时按序尝试。解析窗口 sandbox=true + nodeIntegration=false + contextIsolation=true，用后即 destroy。mpv 经 `--http-header-fields` 注入 Referer。
36. **缓存统计**：`do=cacheSize` 返回 `{bytes, items}`（KV 目录 + js_local.json + cache/dl）；`do=clearCache` 返回释放字节数；设置页签清理按钮先展示再清理。
37. **直播 mpv 健壮性**：TXT 源频道行多地址解析为 `fallbackUrls`；起播后 `mpvStartedOk()` 用 core-idle 轮询 8s 判断真实开播，未开播自动切备用线路并推 `vpc:play-retry`，全失败推 `vpc:play-failed`。
38. **连播统一为渲染层驱动**（决策 70，替代旧队列/接力双方案）：每次只交 mpv 单集（**不传 playlist**），Player._seq 保存 `{site, flag, title, episodes, index}` 上下文；`vpc:player-exit` 附退出进度 `{pos, duration}`；「看完」双判据：剩余 < 8 秒，或 IPC 抢不到进度时 10 秒内收到过 ended 事件；看完且队列有下一集则 play() 递归推进，用户提前关闭则 _seq=null 终止链。教训：IPC 负载嵌套字段必须双端对齐校验（曾误读 payload.playlist 致连播恒单集）。
39. **播放会话制**（决策 78）：mpv 每次起播分配自增会话号，随 playUrl 返回并附在 exit 事件；渲染层仅处理与当前会话匹配的退出，防切集时旧进程延迟退出误推进、本地/推送播放（noSeq 负号）干扰连播、exit 处理期间又起新播（_playToken 双保险）。断流重连由主进程直接 mpv.play 起新会话，经 `vpc:player-session` 同步，重连集播完仍可续连播；「开播≥15s 且剩余≥8s 的媒体直链」退出不置空 _seq 等待重连。
40. **断流自动重连**（决策 59）：proc exit 回调趁 IPC 未拆除抢读 time-pos/duration（Promise.race 400ms），剩余 ≥8s 视为断流 → 重播当前集一次（watch-later 自动续位）+ 系统通知；剩余 <8s 是正常播完，开播 <15s 退出是起播失败（另有直播备用线路），均不重试；_stallRetried 每会话一次。
41. **mpv 播放偏好注入**（决策 47）：续播用 mpv 原生 watch-later（--save-position-on-quit + --watch-later-directory，userData/mpv-watch-later），直播地址 meta.fallbackUrls 存在则 resume=false 不记录；默认倍速 --speed；音轨/字幕语言 --alang/--slang（playerAlang/playerSlang）；偏好变更经 `vpc:update-player-prefs` 下次起播生效。
42. **mpv 快捷键自定义**（决策 45）：settings.playerHotkeys 步长 → 主进程 writeMpvAssets 生成 userData/mpv-scripts/input.conf + lua 提示脚本；起播经 --input-conf / --scripts-append 加载（scripts-append 不覆盖 mpv 默认 scripts 目录）；生成 input.conf 合并用户全局 input.conf（WIN `%APPDATA%\mpv\input.conf` / POSIX `~/.config/mpv/input.conf`）——`--input-conf` 会取代而非追加默认 input.conf，故必须把用户键位带进生成文件，用户已绑定的键不写入应用段、同键冲突以用户为准；`vpc:update-hotkeys` 修改后重写（下次起播生效）。T8 增强：键位可自定义（playerHotkeys.keys 11 个动作，设置页按键捕获+恢复默认+冲突红标；捕获用捕获阶段监听防全局 Esc 抢发）；动作附中文 show-text 反馈，暂停状态由 lua observe_property 中文提示；补齐逐帧 , . 绑定（--input-conf 取代默认键位后原本丢失）；lua 起播提示随自定义键位动态生成。
43. **详情页下载**（决策 50）：选集勾选（.ep-check 阻止冒泡）或悬停单集图标；下载前逐集 playerContent 判断 parse，parse=1 走 vpc:parse 解直链（带 Referer）。vpc:dl add 扩展 out/header：out=「片名 - 集名 + URL 扩展名」（非法字符替换 _）；m3u8 切片流 aria2 无法下载单独计数提示；批量串行解析避免隐藏窗口并发冲突。多选集播放复用连播机制（勾选集按序作为 episodes 交 Player.play）。
44. **选集倒序只翻展示不动下标**（决策 77）：Detail._epDesc 仅翻转渲染顺序，data-idx 始终为原下标，连播/勾选下载不受影响。
45. **线路记忆 + 失败自动换线**（决策 83）：切线路持久化 `settings.lastSourceMap`（键 `site|vodId`）；`Player.play()` 返回 `{ok, reason}`；失败自动循环尝试下一线路（mpv 缺失不换线），全失败恢复最初线路。
46. **收藏/历史**（决策 39/81）：条目结构一致（site/vodId/name/pic/remarks/ts），存 settings 各上限 200 最新在前；records.js makeRecordView 工厂共用；历史在 Detail.open 自动写入（隐身模式 incognito 除外），**历史按片名去重合并**（跨源同名合并置顶，保留原显示名）；想看/已看 tag 三态（want/seen/''，normTag 归一，决策 74），详情按钮与收藏卡徽章双通道共写（setFavTag/getFavTag 唯一读写口，决策 66）。
47. **空源自动探测屏蔽**（决策 41）：首屏就绪后异步探测未探过站点（probedSites 防重复），homeContent 推荐位有内容即过，否则复查首分类；空/错记入 blockedSites 过滤首页下拉（不打断当前选中源，被屏蔽自动切首源），并发 4；仅过滤首页下拉，搜索 SSE 仍全源聚合；源配置「屏蔽源」卡片可恢复重探、查看屏蔽源列表。
48. **首页/分类渐进加载**（决策 51）：首屏数据一到立即 renderGrid + hideLoading，剩余铺满量后台逐页 _appendGrid 增量追加；_loadToken 令牌防串流（切源/切分类/翻页后旧循环回来先比令牌）；自适应目标 36~120；resize 补拉沿用当前令牌。首页搜索只走当前源自身 searchContent（决策 65），不走聚合 SSE。
49. **搜索结果分组分页**（决策 80，T6 改版）：每源分组内部统一分页器翻页，每页 30 条（SEARCH_PAGE_SIZE=30，纯前端切片）；来源筛选纯前端 toggle src-group 不重发请求（决策 58）。分类/当前源搜索一页一次请求 + 源+分类 LRU 页缓存；无 pagecount 的源暂报 pg+1、拉到空页修正（短页不当末页）。
50. **直播源**：config `lives` 三形态（{name,url} 直链 / {group,channels} 嵌套 / proxy://do=live&ext=base64），live.js normalizeLive 统一归一化；频道文本经后端 do=fetchText 拉取（渲染层直 fetch 会被 CORS 拦），支持 txt(#genre#)/m3u；自定义源存 settings.customLives（TVBox 式导入：txt/m3u 地址、粘贴配置 JSON、.json 配置地址，展平嵌套 channels，上限 30，决策 52）；中文域名需 punycode；customLives 增删置 Live._dirty 强制重载（决策 42）。
51. **换肤**（决策 40/73）：主题色 6 套内置（html[data-color] 覆写 MD3 变量）+ 自定义单基色 HSL 推导浅深两套（html.theme-custom，customColor 与 theme 互斥）；明暗 auto/light/dark 由 common.js applySkin 挂 html.dark 类（废弃 @media）；壁纸 vpc:pick-wallpaper 写 settings.wallpaper，渲染层 toFileUrl 铺 body + --wall-veil 遮罩三档；界面缩放 60~200 写 html.style.zoom，字体大小 80~200 注入临时样式表按基准字号等比（决策 55），change 钳制回写。
52. **托盘驻留与关闭行为**（决策 46）：closeAction 三态 tray(默认)/exit/ask；托盘图标代码生成 16x16 PNG 免资源；bgPlay 开启时选退出但 mpv 在播也转托盘保播；isQuitting 区分真退出与托盘驻留；恢复默认设置只清偏好保留数据类键后 relaunch。
53. **缓存位置自定义**（决策 48）：hoststate 统一管理 cache_dir（kv/dl/py），主进程经 python-bridge.extraEnv 注入 VPC_CACHE_DIR，server.py main() 读取后 configure 再 ensure_dirs；换目录需重启后端（端口/令牌变），渲染层 onBackendReady → setBackendInfo 刷新连接信息；旧目录缓存不迁移。
54. **Anime4K 超分**（决策 60/69/64）：不内置 glsl；download-binaries.js anime4k 从 bloc97/Anime4K 拉 v4.1 Mode A 链 6 个 glsl（仓库按 Restore/Upscale/Experimental-Effects 分子目录，扁平存 vendor/anime4k）；启动 ensureAnime4k 多镜像补齐缺失（raw.githubusercontent → jsdelivr CDN → ghfast.top 代理，镜像返回内容须过大小+头部版权行校验拦错误页）；文件齐全才 buildAnime4kChain 拼链（win 分隔符 ';'）注入 --glsl-shaders，缺文件静默降级；从未设置过开关默认开启（手动关过保持关）；**状态以起播反馈为准**：vpc:play 返回 anime4k 标志，toast 明示「超分已生效」。T8 增强：三档位 anime4kMode（a 均衡 Mode A 链/aa 细节增强 A+A 链/restore 仅修复不升频），所需着色器均在下载清单内无需新增；设置页档位下拉，lua 起播提示附当前档位名。
55. **ffmpeg 内置化**（决策 72）：m3u8 合成与本地预览图共用；启动 ensureFfmpeg 幂等下载 gyan.dev essentials（约 90MB）→ vendor/ffmpeg，失败静默降级、其次探测 PATH；缩略图 5s 处抓帧缩 480 宽 jpg，md5(路径|mtime|大小) 缓存 userData/local-thumbs，并发 4。
56. **鼠标侧键导航**（决策 63/67）：视图级两栈 _navStack/_navForward（showView 入栈同顶去重，新跳转清前进链，栈底不弹）；app-command 与 mousedown button 3/4 双通道，400ms 时间戳去重防双跳。
57. **确认对话框**（决策 54）：全部 confirm 用 common.js confirmDialog（md-dialog 风格，Promise<boolean>，Esc/遮罩=取消）；_confirmResolve 持有待决回调，closeDialog 未决按取消 resolve(false) 防挂死；done 先置空再 closeDialog 防双重 resolve；okText/cancelText 可定制。
58. **二进制存放与路径适配**（决策 84）：vendor/{mpv,aria2,ffmpeg,anime4k}（.gitignore 忽略）；开发模式 ROOT=`path.join(__dirname,'..','..')`，打包模式 `process.resourcesPath`；`index.js` 统一 `RESOURCES_ROOT = app.isPackaged ? process.resourcesPath : ROOT`；python-bridge 打包后启动 PyInstaller exe。
59. **mpv 二进制来源**：shinchiro/mpv-winbuild-cmake latest release 动态取 tag（官方 mpv 无 Windows 发行）；.7z 用 Windows 内置 tar 解（勿用 unzip）。
60. **mpv 视频缓冲缓存**（决策 85）：设置 `playerCacheMode`（memory/disk，默认 memory）+ `playerCacheDir`（默认 `<userData>/mpv-cache`）；disk 模式起播注入 `--cache=yes --cache-on-disk=yes --demuxer-cache-dir=<dir>`（**mpv v0.41 目录选项是 `--demuxer-cache-dir`，`--cache-dir` 非法**）。mpv 平铺写 `mpv-cache-<hex>.dat`，默认 `--demuxer-cache-unlink-files=immediate` 播完即删，仅被杀/崩溃时残留；清理只删该文件名模式（防误删自选目录里的无关文件）、逐文件 try/catch 跳过正被占用者。IPC：`vpc:pick-folder`（通用选目录）→ `vpc:set-player-cache(mode, dir)`（切内存/换路径自动清旧目录残留，返回 `cleanedBytes`；未传目录沿用已记忆目录=还原）+ `vpc:clear-player-cache`（只清不换）。两键均入 settings.reset 保留清单。
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
- mpv `--input-conf` 是取代而非追加默认 input.conf → 应用自定义 input.conf 必须合并用户全局键位（writeMpvAssets），否则用户自定义快捷键在起播时静默失效。
- mpv v0.41 硬盘缓存目录选项是 `--demuxer-cache-dir`（传 `--cache-dir` 会报 "option not found" 直接退出）；缓存文件平铺为 `mpv-cache-<hex>.dat`，Windows 下 mpv 以共享删除方式打开（播放中可删，但空间延迟到句柄关闭才释放），默认 `--demuxer-cache-unlink-files=immediate` 播完即删——清理目录按该文件名模式匹配（防误删用户自选目录里的无关文件），逐文件 try/catch 跳过占用。
- Google Storage 样片本机不可达，demo 样片用 media.w3.org 与 vjs.zencdn.net。
- Grep 输出的缩进不可信（可能去掉行首空格），SearchReplace 前先 Read 目标行段。
- Node EventEmitter：`emit('error')` 无监听器抛 ERR_UNHANDLED_ERROR，自定义类须在构造器兜底 noop 监听（downloader.js 已做）。
- aria2 `--continue=true` 要求服务器支持 Range；测试服务器不返 206 报 "No URI available."；`writeHead` 头值 undefined 直接报错。
- Electron：最后一个窗口 destroy 触发 window-all-closed 默认退出；无界面测试脚本须 `app.on('window-all-closed', e => e.preventDefault())`。
- Chromium 启动 `WSALookupServiceBegin failed with: 10108` 为良性日志。
- session webRequest 每 session 仅一份且全局生效 → 解析窗口用独立 partition，结束 onBeforeRequest(null) 清理。
- mpv 不能直接播 HTML 页面，推送非直链走 captureDirect 抓媒体请求，抓不到返 resolve-failed。
- 多仓条目托管于 raw.githubusercontent / jsdelivr，网络抖动频繁（偶发超时/404）：T44 已用「偏好条目失败重试一次 + 跨条目合并」兼顾，新增多仓功能勿假设单条目必达；Windows 控制台 GBK 无法打印条目名 emoji（🈲），脚本输出前 `.encode('ascii','replace')`。

## 8.7 待完成

- [ ] 8.7.1 macOS / Linux 平台实际打包测试
- [ ] 8.7.2 安装后首次启动验证（冷启动时间、资源路径、后端拉取）
- [x] 8.7.3 自定义应用图标（assets/icon.png 已配置并嵌入 Windows 安装器）
- [ ] 8.7.4 electron-updater 自动更新（可选，GitHub Releases）

## 8.8 进行中任务批次（T1~T45，2026-08）

| 批次 | 任务 | 状态 |
|---|---|---|
| T1 | 直播静默探测与自动刷新（HEAD→GET 回退防误杀）：已实现静默分批探测 + HEAD→GET 回退 | 已完成 |
| T2 | mpv 本地配置兼容（scripts-append + input.conf 合并）+ Anime4K 多镜像下载加固 | 已完成 |
| T3 | 视频缓冲缓存设置（内存默认/硬盘 + 路径选择/还原/换路径清缓存） | 已完成 |
| T4 | UI 按钮/组件/字体布局检查清单式优化：工具栏 select/input/btn 高度对齐 40px + gap 10px；新增 .md-btn-danger-text 并应用到删除/清空/恢复默认等按钮；#live-status 右对齐样式移入 CSS；全局字号 14px + tip-line 12px + dark 资产状态色对比；:focus-visible 轮廓 2px/1px；pill 间距统一 6px；输入框/下载项/文件行补 hover | 已完成 |
| T5 | Kazumi XPath 规则引擎适配（独立排期，待用户确认） | 待确认 |
| T6 | 翻页架构重设计：废除分类"自适应铺满"连拉多页，改一页一次请求 + 每页条数限制（设置项 listPageSize 自动/24/36/60/120）；统一分页器 renderPagerBox（页码±2+首尾省略号+跳转输入）；按 源+分类 LRU 页缓存（32 分类×10 页，命中即显+后台静默刷新，切源清理）；当前源搜索真分页；聚合搜索组内翻页替代展开全部；收藏/历史客户端分页 | 已完成 |
| T7 | UI 布局与说明系统重设计：ⓘ 信息点展开组件（.info-tip/.info-dot 全局委托切换，10 处长说明收入 info-detail，短说明保持内联）；设置页卡片网格显式列数响应式（默认 2 列/≤760px 单列/≥1500px 3 列）；设置页 tip-line 字号层级 13px；本地文件卡说明并入信息点 | 已完成 |
| T8 | mpv 播放器设置增强：键位自定义（11 动作按键捕获 UI + 恢复默认键位 + 冲突红标，存 playerHotkeys.keys 写 input.conf）、Anime4K 三档位（均衡 Mode A/细节 A+A/仅修复，anime4kMode）、中文化（窗口标题模板 video-pc · 片名、--osd-font 微软雅黑、动作中文 show-text 反馈、暂停中文 OSD、补齐逐帧键位） | 已完成 |
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
