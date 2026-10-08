# 更新日志

本项目所有显著变更记录于此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.0] - 2026-10-08

### Changed

- **屏蔽词（全局番剧屏蔽）功能上线**：设置 → 屏蔽过滤 新分类——按片名关键词屏蔽番剧，首页/分类/聚合与 Kazumi 与 Bangumi 搜索/推荐/时间表/收藏/历史全列表生效（「包含」语义、NFKC 归一化忽略大小写与标点差异），搜索时直接跳过不占结果位；词表经 settingsSet 持久化 + WebDAV 同步/恢复（已入恢复白名单），变更后各列表页订阅失效就地重渲（词表预归一化缓存，匹配零额外开销）；屏蔽只作用于展示，收藏与历史数据不动，关开关/删词立即恢复。新增 block-words/block-words-pages 单测 30+ 例。
- **详情页快照体系（A 系列优化）落地**：DetailSnap 列表卡快照（pic/name/remarks/year 四字段白名单 + 2h TTL，六类入口写入）半渲染垫场 + 整页覆盖；设置快照层 settings-snapshot.js（90s 快照 + change 委托失效 + 写穿透 fence + 程序化写入失效不变量，起播主链路 IPC 三并零）；缓存池双池（小池 1.5MB/大池 3MB）+ singleflight 并发去重 + guardedLoad 世代守卫（请求同代 AbortController）；首页启动预发（boot prefetch，站点缓存就绪时 /sites 前预拉 feed，接管/作废令牌防串台）；详情页骨架屏（卡片/简介/集网格三形态，2000px 大屏断点对齐）。
- **播放链路与主进程健壮性批次**：目录列举 worker 池三缺陷修复（复用空闲 worker 未撤 120s 回收定时器、exit 后不补拉替补、Worker 构造失败计数虚高）；保存图片四项加固（空 Content-Type 放行、SVG 拒收、私网/本机地址拦截、响应体早返回统一取消）；exe 元数据门禁 sanitizeFileName 归一化 + win x64 目录断言；after-pack 非 win 平台剔除分支改显式白名单（宁漏剔不误删）；worker 预热去重键改首个站点对象身份（热重载不被误判重复）+ start 失败回滚占位。
- **后端聚合搜索缓存一致性**：payload 超 mem_cache 单值上限时不再「静默丢弃但登记索引」（重放误报 error）；deadline 收敛缺源不再被当完整答案落缓存（按产出源数判完整性，不足整词失效）；'spider:aggsearch' 命名空间单点化为 mem_cache.NS_SPIDER_AGGSEARCH 常量（config/server 双写收敛）。
- **Bangumi 鉴权归因修正**：CF 挑战页/网关 403 不再被误报为「Token 无效」（挑战页单独识别、鉴权关键词收窄为明确语义短语，镜像故障正确归因 network 引导换基址而不是误导重取 token）。
- **验证码视觉识别与划词翻译解析口径同源**：探测侧兼容（content 分段数组/reasoning_content 兜底）下沉为 translate.extract_vision_text 共用函数，思考型模型「测试通过、线上失败」消除；data URL MIME 按图片魔数嗅探（JPEG/GIF/WebP 不再被写死 PNG 拒收）。
- **验证码训练/评估工具健壮化**：train_captcha_real.py 默认路径引用未导出常量的 AttributeError 修复（几何字面量与 forward 同构 12/24/256）；eval_captcha_real.py 空数据集早退；sample_captcha_site.py 缺 ddddocr 时清晰降级。
- **2026-10-08 全仓代码审查修复（83 条发现 → 77 条落地）**：OCR（open-code-review/deepseek-v4-flash）审查 + 本地 deepseek-v4.1-flash 逐条交叉验证 + 主流程仲裁。覆盖：Python 后端 14 项（warmup/aggsearch 一致性/鉴权归因/解析同源/常量收敛等）、主进程 13 项（worker 池/保存图片 SSRF 面/元数据门禁/平台白名单等）、渲染端 30 项（屏蔽词接线/快照失效世代/单飞对齐/死代码清理/CSS 骨架对齐等）、构建脚本 4 项；另 4 项经核实不成立（含 mpv pendingSeekSec 逐集复用——position 承载来源与原生队列互斥，深挖裁定不改码）；LICENSES.chromium.html 经用户裁决改为**随包保留**（它是 Chromium 及其第三方依赖的许可证义务汇总，LICENSE.electron.txt 不能替代；剔除函数降级为 no-op，体积代价 ~20MB，安装包体积门禁不受影响——其校准对象是 python-dist 后端产物）。回归：JS 2347/2347、Python run_all 全 stage PASS。

- **Bangumi 详情 hero 二次闪现修复（入场动画重播）**：快照半渲染上屏后 `bangumiInfo` 到达的整页覆盖此前不带参数重 render——封面 URL 沿用解决了图片重载，但整个 hero DOM 重建后 `.detail-page-anim` 三级入场（hero/页签/内容从 `opacity:0` 上浮 300ms）被重播，视觉上封面/评分/操作行集体再闪一下。现快照半渲染在显示时（openBangumi 快照路径 / CatVod `load()` SWR 与详情路径的 `snapHeroWasShown`）整页覆盖传 `skipPageAnim`（A-26 嵌套返回既有机制）：新内容原位就位零动画，仅页签内容保留 `.tab-enter` 淡入；无快照路径维持完整入场（骨架→内容形态切换，入场动画正是该场景的过渡反馈）。回归：detail-bgm-snap.test.js ④a 组（覆盖带 skipPageAnim / 无快照照播）。
- **Bangumi 详情封面「显示→占位→恢复」闪变修复**：快照半渲染上屏后 `bangumiInfo` 到达整页 render 会把封面 URL 从「列表卡正在显示的直连 URL」换成 `/kazumi/cover` 代理链 large 口径——URL 变了浏览器要重新请求代理（后端磁盘缓存 miss 时再回源图床），期间新 img 基态 `opacity:0` 且旧 hero 已被 innerHTML 替换，视觉上「有图 → 占位 → 恢复」。现 render 内做快照封面沿用：半渲染期记下封面 URL（`_snapCoverShown`，入口处重置防跨片残留），完整 render 时结果封面与快照封面同 URL（时间表/推荐卡直连 origin 的常态）则继续直连零闪变；不同 URL（Kazumi 搜索卡代理快照等）不沿用，照常走代理链。回归：detail-bgm-snap.test.js ⑤ 组（同 URL 沿用/异 URL 不沿用/基准防跨片残留）。
- **「选集讨论」页签首开提速（两段串行网络 → 零等待）**：页签打开此前要现拉「分集列表 → 评论」两段串行网络（next.bgm 往返各 0.5-2s）才见内容。现 openBangumi 主信息 render 后的分集预取**接续预取第 1 集（正片优先）评论**（`_epCommentsPreload`，带 sid/eid 归属 + 世代守卫），页签首开默认集直接消费预取结果——两段网络全部等在打开详情的那几秒里，点开页签即成品；切别的集/预取未回/换番剧走原请求路径（sid/eid 双校验防串台，`_resetEpComments` 换番剧作废预取）。回归：detail-bgm-snap.test.js ⑥ 组（预取写入/消费命中/切集回退/换番剧作废）。
- **Bangumi 详情页封面/标题即时上屏（打开即显示，恢复既有加载速度）**：openBangumi 此前冷态要先 `await Kazumi.bangumiInfo()`（1-3s 网络往返）才第一次 render——hero 封面/标题全部白等，加上封面 img 的 `/kazumi/cover` 代理链再叠加一层等待，表现为「打开详情页半天不出封面」。现把 CatVod 路径既有的 A-01 DetailSnap 快照半渲染手法接到 Bangumi 路径：bgmInfo 的 30min localStorage 缓存未命中时（新增 `Kazumi.peekCachedBangumiInfo` 同步窥探判断，缓存命中本就毫秒级出完整版面，不引入垫场）读列表快照，立即以 hasBgm 版面渲染 hero——封面 URL 就是列表卡此刻正在显示的那张图（`Home._snapFieldsFromCard` 原样捕获，浏览器 HTTP 缓存必然命中、零网络秒出），标题/页签栏照常上屏，页签内容区垫简介形态骨架，不叠全局转圈；半渲染期 `_loadBgmExtra`/收藏对账延后到 bangumiInfo 到达后的完整 render（防四路请求 ×2 与世代错乱），并按 large 变体后台预热大图（lain 域名封面推导变体，完整版面上屏时大图多已进浏览器缓存，无缝续显零闪变）。快照写入点补齐六处入口：时间表/推荐（既有）、Bangumi 搜索结果卡、收藏页 Bangumi 卡、历史页 Kazumi 匹配卡、搜索页 Kazumi 结果两路（缓存匹配 + 现场搜索）、详情页关联卡嵌套跳转。`bangumiInfo` 返回后整页覆盖（结果优先，快照字段不落实例态污染下游）。回归：`tests/js/detail-bgm-snap.test.js`（21 测），全量 jsunit 2242+ 通过。

- **验证码自动解题代理失败直连回退**：solve_captcha 的独立验证会话此前只按解析出的系统代理发请求，代理软件退出但系统代理设置残留（如 Clash 类退出后 WinINET 仍指 127.0.0.1:7897）时 ProxyError 直接 `session_init_failed`——同一时刻主搜索链路因 `http_client._request` 有「代理连接失败→直连重试」兜底照常 200，表现为「搜索正常但自动解题失败」，自动解题白丢给人工窗口。现 solve 请求统一走 `_site_request` 包装：单次请求遇 `ProxyError` 且配置过代理时去代理直连重发一次，回退为会话级（代理真挂时每跳都失败，逐次重试只会双倍烧超时，后续请求直接裸连）；未配置代理时 ProxyError 原样上抛不做无意义重试。与主链路容灾口径对齐。回归：`test_proxy_error_falls_back_to_direct`（代理拒连→直连 solve 全程成功）与 `test_proxy_error_without_proxy_config_propagates`（无代理配置时不重试），Session 桩升级为统一 `request(method,…)` 口径并支持异常步回放。
- **验证码识别链重定版：ddddocr 移除（省 ~200MB），tiny-CNN 真实数据重训 + 视觉大模型兜底**：识别链改为「tiny-CNN（numpy 纯推理，~3MB 权重随应用打包）→ 视觉 LLM（用户配置的 OpenAI 兼容多模态接口）→ 人工验证窗口」。①依赖与体积：ddddocr + onnxruntime + opencv-python 移出 requirements/锁文件/PyInstaller hidden-import，体积门禁 360→180MB（实测回落 ~135MB）；②tiny-CNN 定向重训：新「站点判题」采样器（`tools/sample_captcha_site.py`——ddddocr 候选标注后由站点 verify_check code==1 判卷，错标率≈0）采集 mutefun/mgnacg/girigirilove 三站 5700 张零错标真实验证码，混合训练器（`tools/train_captcha_real.py`，真实为主 + 合成为辅 + 仿射增强/ dropout/权重衰减）重训后真实留出集 all4 由合成版 ~0% 提至 ~37%（v1 几何容量瓶颈，四轮 2.7 倍扩数据实证），`assets/captcha_cnn.npz` 已替换，简单形变样本不再触发 LLM；③视觉 LLM 兜底：`translate.py` 新增 `llm_vision_recognize_captcha`（多模态 image_url 块，temperature=0、max_tokens=16、4 位数字提取），三站盲测 10/12 全对（83%，套 3 轮换图重试端到端 ≈99.5%）；④**独立配置**：设置页「验证码视觉识别」区块（`captchaLLM{Enable,Base,Key,Model}` 四键，与划词翻译 LLM 完全两套——翻译走文本模型、验证码需要视觉模型，服务商可不同；Key 同样 safeStorage 加密落盘 + 按次传后端不持久化，入主进程 settings-set 白名单与 WebDAV 恢复表（key 除外）），solve/SSE 搜索/单源重查/章节页四条链路凭据透传（`_captcha_llm_cfg_from_form`），`ocrAvailable` 探测含 LLM 配置态；未配置 LLM 时行为 = tiny-CNN（37%）+ 3 轮重试 ≈75% 端到端 + 人工窗口，已配置 ≈99.5%。测试：captcha 链路单测全部重写对齐新链（tiny-CNN 探测双检锁/LLM 兜底次序/结果校验/异常吞没），JS 2210 单测 + 官方 run_all 回归通过（q7-fault-injection 单独失败为 WinError 10013 本机端口权限环境问题，基线同环境失败更多，与本次改动无关）。
- **「↗ Bangumi 页」条目页跳转可跟随镜像**：详情页该按钮此前始终打开官方 bgm.tv，镜像用户（官方站直连不通）点出去经常打不开。现设置 → 网络 新增「条目页跳转跟随镜像」开关（新设置键 `enableBangumiWebMirror`，默认关，已入主进程 settings-set 白名单与 WebDAV 恢复表）：开启后按钮在系统浏览器打开镜像站条目页 `{镜像根域名}/subject/{id}`——bgm.tv 无子域名，镜像侧对应根域名本身（api/next/lain 那种子域映射在此不适用，实测 bangumi.vip/subject/N 可达；手动替换镜像根域名后即时生效）；关闭始终官方 bgm.tv——镜像站登录态与官方不互通，收藏/吐槽等账号操作以开关为准。`common.js` 新增 `bangumiWebUrl(sid)` 统一取域（sid 数字白名单校验仍在 detail.js 点击处），kazumi.js `_prefillMirror` 启动回填开关并同步 common.js 全局，设置页开关变更即存即生效。
- **Electron 31 → 44 升级**：桌面宿主从 31.7.7（Chromium 126 / Node 20.18）升到 44.4.5（Chromium 152 / Node 24.21 / V8 15.2），跨 13 个大版本。唯一代码适配点：`index.js` 渲染端日志监听 `console-message` 自 Electron 35 起事件参数由位置参数 `(event, level, message, line, sourceId)` 改为 `(event, details)` 对象（`level` 数字变字符串、`line` 更名 `lineNumber`），已按新签名改写，语义不变（仍只落盘 warning/error）。其余主进程 API（session/代理/缓存清理/safeStorage/Tray/Notification 等 73 条 IPC 频道）经 32–44 破坏性变更清单逐项核对均无影响；无原生模块依赖，渲染端零改动。CI 两个 workflow 的 Node 20 → 22（electron@44 的 npm 包 engines 要求 ≥ 22.12）。全量 1929 个 JS 单测通过。注意：Electron 42 起二进制不再随 postinstall 下载，改为首次运行时自动下载（`node node_modules/electron/install.js` 可手动触发，网络不畅时可用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`）。顺带 `npm audit fix` 收敛运行时审计基线 1 high → 0（js-yaml 4.3.1 → 4.3.2，electron-updater 链）。
- **详情页收藏状态按钮状态图标化**：收藏单按钮（Bangumi `#detail-col-current` 与本地收藏 `#detail-local-col-current`）由「纯文字 + 小 ▾ 字符」改为「状态图标在文字左侧 + 文字」，原下标箭头移除——图标完全对齐 Kazumi CollectButton 官方映射（在看=实心心、想看=圆角星、搁置=待办时钟、看过=对勾、抛弃=碎心、未收藏=空心心；SVG path 取自 Material Icons Round 字体字形，`currentColor` 随按钮着色；Kazumi 内部编号与 Bangumi API 编号不同，按状态语义对齐到本项目口径）；六态下拉菜单内每个状态按钮同款图标置于文字左侧，状态一眼可辨。「★ 评分 / 吐槽」按钮的文字星号同步换成批注笔图标（对齐 Kazumi 评分对话框主图标 `Icons.edit_note_rounded`，与收藏图标同规格 14px / currentColor）。图标映射（本地 tag 与 Bangumi type 双口径）由 detail.js 顶部 `detailColStateIcon` 统一提供，`_refreshLocalCol` 与 kazumi.js `_applyBangumiColState` 两条回填路径随文案同步换图标。
- **每页影片数量默认值分页校准 + 改后回到页面即生效**：默认值从六项统一 20 改为按页面各自校准——首页 24、搜索 24、收藏 10、历史 24、直播 120、推荐 36（`common.js` `pageSizeOf` 新增 `PAGE_SIZE_DEFAULTS` 按键兜底，未设置/非法值/升级用户走各自默认；设置页六处下拉 `selected` 与各页兜底常量同步）。同时修复两处「改完设置不立即生效」：①「我的→收藏」页签在数据无变更时直接复用旧网格，不检查条数设置——现 `My.enter` 重读 `pageSizeFavorites` 并与上次渲染值比对，变更即置脏强制重渲；②搜索页「Bangumi」页签此前完全没有 onViewShown 钩子，服务端分页改条数后要重新搜索才生效——现 `BangumiSearch.onViewShown` 在已有结果且条数变化时静默重拉当前页（`Search.onViewShown` 转发）。其余页面（首页 T80 脏标记、聚合/Kazumi 搜索重切、直播/推荐 enter 比对、历史每次进页重渲）此前已覆盖；设置页保存提示由「下次进入对应页面生效」改为「回到对应页面即生效」。
- **「已登记的片头/片尾标记 + 清除全部按钮」合并为「保存已登记的片头/片尾记录」开关**（设置 → 播放，行为项）：设置页此前对片头/片尾登记只有一条展示行加「清除全部」按钮，现改为一个开关（新设置键 `opEdSave`，默认开，已入主进程 settings-set 白名单）——开启时右键菜单登记的片头/片尾记录照常保存；关闭时**立即清空全部已登记记录**（`AdSkip.clearAllOpEd`，toast 报告清除条数），且播放器登记/清除入口同步停用（`Player.setOpEdSaveEnabled` 热同步 + `play()` 起播缓存，提示「保存片头/片尾记录已关闭」），再次开启后重新登记即可。误登记积累后的放弃入口由显式按钮变为关开关一气呵成。
- **杀软误报治理二批（360「风险程序」拦截 v0.2.6 安装包的后续加固）**：① package.json 补 `author` 字段——缺失时 electron-builder 不写 `CompanyName`，YuKi.exe 一直保留 Electron 预编译二进制的原始值「GitHub, Inc.」，未签名程序冒用大公司名义是杀软启发式评分的显著扣分项（解析产物 PE VERSION_INFO 实证，v0.2.7 起 CompanyName=「Arimayuki03」）；② `nsis.packElevateHelper: false` 不再打包 `resources/elevate.exe`——无签名第三方提权助手（2007 年 Johannes Passing 版）是「风险程序」类检测的经典命中项，YuKi 纯 per-user 安装不需要它，electron-updater 仅在 EACCES/UNKNOWN 降级时调用且另有 shell.openPath 兜底；③ afterPack 新增可执行体版本信息门禁（CompanyName 缺失/仍为 GitHub、ProductName 缺失即构建失败）与 elevate.exe 兜底剔除，防将来回归。配合 9 月 28 日已入库的一批治理（dex-tools/dexdeps 移出安装包、系统同名 DLL 剔除），0.2.7 安装包请重新走误报申诉通道并附新产物。
- **直播频道入场动画扩展到全部全量渲染场景与全部频道**：此前仅切分组/翻页播卡片错峰入场、且错峰延迟只写死前 10 张（其余同帧跳出），现进页首渲、切换直播源、手动刷新、每页数量变更重排同口径播放，错峰改由 JS 按「可见序号」内联 `animation-delay`（30ms/张）覆盖当页全部频道，CSS `nth-child` 上限规则移除；后台探测分批刷新与异常回滚仍不播（防列表反复重播闪烁）。毛玻璃/`no-anim`/`prefers-reduced-motion` 等既有动画豁免不受影响。
- **可见滚动区滚动条主题化**：此前只有一处横向 chips 用系统默认 thin 滚动条，日志查看器、Kazumi 规则源弹窗、颜文字面板等可见滚动区全是 Chromium 原生灰条——深色模式下白底黑条刺眼、与整体 MD3 视觉割裂。现统一为 8px 细条 + 圆角 + 半透明滑块（浅色深灰 `rgba(17,17,20,.22)` / 深色浅白 `rgba(235,236,240,.22)` 随 `html.dark` 切换，悬停加深到 0.40 给可拖拽反馈，轨道透明），新增 `--scrollbar-thumb/-hover` 主题变量。只用 `::-webkit-scrollbar` 一套机制——Chromium 121+ 标准属性 `scrollbar-width/color` 非 auto 时会整体禁用 webkit 伪元素样式，混用会让圆角/hover 全部失效（本应用纯 Electron 无 Firefox 目标）；`html` 上补 `color-scheme: light/dark` 联动，原生滚动区（select 弹层等）同步深浅色。主视图/弹窗体等 11 处刻意隐藏滚动条的无感滚动区域规则位于全局规则之后按源码顺序覆盖，行为零变化。

### Added

- **划词翻译（应用内文本）**：选中界面文字（简介/评论/搜索结果/收藏备注等 DOM 文本）后弹出 Material 3 风格翻译气泡——设置页新增「翻译」分类：启用开关（**默认关**，设置页显式开启后划词才生效）、触发方式（「译」按钮确认 / **选中即译（默认）**）、目标语言（简体中文/繁體/English/日本語）；翻译请求收口 Python 后端新端点 `POST /translate`（token 鉴权、JSON body、5000 字上限），免费通道 **Edge（edge.microsoft.com 免 key）主 + Google（translate_a/single）备** 自动互切（429/网络失败即降级，响应段数校验），可选 **LLM 优先**（OpenAI 兼容 /chat/completions，baseURL/Key/Model 在设置页配置，Key 经 safeStorage 加密落盘、按次传后端不持久化；LLM 失败自动回落免费通道）；后端结果按内容 hash 缓存 24h（mem_cache `translate` 命名空间），同文本重复划词不出网。气泡 UI 全走 `--md-*` 主题 token（亮/暗色与自定义主题色/毛玻璃自动联动，译文区滚动条同颜文字悬浮窗主题化细滚条），z-index 1400 压过对话框遮罩；定位移植 auto-translate 的 `placeFixedInViewport` 两点采样反解仿射映射（宿主 zoom/transform 下 fixed 不漂移），译文就位后按最终高度重定位（防底部溢出视口被裁）；防误触——仅吞掉落在选区矩形内的那次 click（防搜索卡片划字误跳详情），点击页面其他位置放行并折叠残留选区，气泡自身 UI 优先豁免，输入框内选中文本不触发；关闭路径三线齐发（点击气泡外/Escape/页面滚动 rAF 节流，气泡内滚动不关）。纯逻辑移植自本人项目 auto-translate（MIT，见 docs/THIRD_PARTY.md 致谢）。
- **Kazumi 搜索进详情页「开始观看」默认用该源播放**：搜索页（聚合/Kazumi 页签）点 Kazumi 结果卡进入 Bangumi 详情页后，源上下文此前被丢弃——「开始观看」只能重新打开全源选源弹窗再检索一遍。现在搜索结果携带的来源（`site=kazumi:规则名` + 结果页 URL）以 `kazumiOrigin` 一路透传（search.js 卡片点击 → `Kazumi.openBangumiInfoPage` → `Detail.openBangumi` 存为详情页一次性状态，嵌套跳转快照/恢复保留、CatVod 详情 `open()` 重置防残留），点「开始观看」直接走既有 `kazumi: 前缀直达分支` 解析该源剧集选集播放，与搜索结果点击的直连路径同款体验；其他入口（时间表/推荐/收藏/Bangumi 搜索）不携带来源，行为不变。顺带修直达分支的两个既有问题：选集视图「← 返回选源」此前因 `_dlgState` 未初始化静默无响应（现预建全源卡片状态，返回后可「重新检索/手动检索」）；单源重查结果也因同因被丢弃（现正常上卡）。
- **评分/吐槽对话框内置颜文字快捷面板**：吐槽输入框下方新增单个「颜文字 ▾」按钮，悬停即向上展开悬浮面板（3 列网格、限高 240px 内滚动，覆盖在吐槽框上方不挤动布局），点击按钮可固定面板（触屏/键盘友好），点击面板外或再点按钮收起；面板内点选颜文字即在正文光标处插入（有选区则替换、未定位光标则追加文末）且面板保持打开，方便连续插入。清单为 42 个纯文本颜文字，按 开心/爱·萌/无语·淡定/流泪·伤心/震惊·暴走 五组情绪排列（可直接进 Bangumi 收藏备注）；悬停离开带 150ms 延时收起容忍指针跨越间隙，展开态每次打开对话框复位。文案与 data 属性均经 escHtml 转义，面板视觉与对话框面板同口径（surface 变量承载，毛玻璃模式自然半透明）。吐槽输入框可纵向拉伸但封顶 240px（防拉伸盖过标签区/挤爆弹窗），超高内容框内滚动（走全局主题化细滚动条），右下角拉伸把手保留。
- **Kazumi 图片验证码自动识别（ddddocr 主链，独立会话协议）**：搜索命中验证码的源此前只能打开人工验证窗口，现支持一键自动解题——点击验证码提示行，后端以独立会话（先访问搜索页建会话，取图/提交/复验共享同一 PHPSESSID；共享 Session 禁 Cookie 落地，原每次陌生会话答案必错）取验证码图（规则 `captchaImage` XPath 或 MacCMS 约定端点）→ **ddddocr**（MIT、模型内置、专为中文站点字符验证码训练；真实站花体/斜体艺术字实测直接命中，自研合成模型分布外全错——故弃自训主链改用现成轮子，自研 tiny-CNN `captcha_cnn.py` 降为数字域兜底）识别 → **POST** `verify_check` 提交（表单 `type=search&verify=<码>`，与站点 JS 'post' 口径一致）→ 以响应 **code==1** 为成功标准（不用「复验页不再检出验证码」——答案错误时站点回「请勿频繁操作」提示页，无 captchaImage 节点会被检测器误判为放行；提示页等 2.5s 重试）→ 验证会话 Cookie 落盘 cookie_jar（与人工窗口同一生效链路，重启免重验）；成功直接重搜，失败/无能力自动回落人工验证窗口（原路径始终可用）。边界不变：只做 MacCMS 图片验证码、只在搜索环节；每跳过 `_guard_hop` SSRF 守卫；搜索主链路零网络请求契约原样保持；SSE payload 新增 `ocrAvailable`。onnxruntime/opencv 进锁文件（打包增重约 200MB）。真实站验证：四个启用反爬的源全部 code==1 通过，solve 后搜索出真实结果。
- **推荐页封面悬停徽章（话数 + 收藏状态）**：推荐页影片卡片封面左下角新增话数徽章（「N/总话数」或「已完结」，完结判定与详情页口径一致：放送日 + eps 周 + 3 天余量）与收藏状态徽标（想看/在看/看过/搁置/抛弃六态着色，与时间表页同款），两者默认隐藏，鼠标悬停/键盘聚焦卡片时显形——话数徽章淡入、收藏徽标从话数徽章右侧滑入展开（只动 transform/opacity/max-width，不触发布局；`prefers-reduced-motion` 下自动关闭动画）。实现完全复用时间表页刚落的徽章管线（`Timeline._attachFavBadges/_attachEpBadges` 与 `.vod-fav-row/.vod-fav-badge` CSS，零新增样式）：`_attachEpBadges` 新增 `itemsFull` 快捷分支——推荐页趋势/标签榜单接口响应自带 `eps/air_date` 字段，整页徽章免逐条回源详情接口（时间表日历条目无总话数，仍走原回源路径）；收藏映射由 Popular 自建（`kazumiBangumiCollections all=1` 全量 + 本地收藏标记合并、账号态优先，不做过滤桶故不与时间表缓存互相污染失效时机），首屏渲染先于映射就绪时到手后补挂当前网格；订阅 FavHub 收藏变更事件实时重读映射刷新徽标；Timeline 对象缺席（测试沙箱）时静默降级零影响。
- **视觉验证码识别的 4 位数字提取修复（中文回复漏提取，生产链与测试同源）**：视觉模型回复的答案提取原用 `\b(\d{4})\b`——Python 的 `\w` 匹配汉字，中文多模态模型最常见回复形态「验证码是1797」「图片中的数字是1797」在汉字与数字之间**没有词边界**，正则整体漏匹配。用户实测暴露为两层同一根因：设置页「测试识别」显示「识别为『空』，应为『1797』」（模型其实读对了）；生产识别链 `llm_vision_recognize_captcha` 同款正则把读对的回复判为识别失败、白白降级人工窗口。修复：`translate.extract_captcha_digits()` 共享提取口径——①全角数字归一（１７９７ → 1797，qwen 系偶发全角输出）；②4 位数字用「两侧非数字」`(?<!\d)\d{4}(?!\d)` 界定（汉字紧邻数字可命中，且 5 位串不截取、宁空勿错）；③一级失败再试空格分位（「1 7 9 7」去空格同口径重试，「12 34」不会产生假答案）。生产链与探测链同时改走该函数（同源契约：同一回复两侧必须同一答案，否则「测试通过、线上失败」）。回归：`test_kazumi_translate.py` 新增 TestExtractCaptchaDigits（10 测：中文前缀/全角/空格分位/数字组边界/None）+ 端到端中文回复提取；`test_kazumi_captcha_probe.py` 新增中文/全角/空格回复提取与「探测-生产同源」断言（3 测）。
- **「测试识别」对空/异形回复的兜底加固与原文展示**：探测链对视觉模型回复的三类「显示为空」形态兜住——①content 为分段数组（部分网关把多模态 content 回成 `[{'type':'text','text':…}]`，原 `str()` 化直接得到列表字符串提取不出）；②思考型模型正文在 `reasoning_content`、`content` 空；③`finish_reason=length`（max_tokens=16 装不下带前缀回复/思考型烧完预算）且无 4 位数字时放宽到 64 重发一次。结果行在「识别为空」时附**模型回复原文**（`llm.raw` 截 64 字符），空内容/前缀形态/模型拒答一眼可辨；生产识别链（llm_vision_recognize_captcha）的 ①② 形态同理兜住（截断重发仅探测侧——生产链在解题计时链上，多一次往返的代价高于直接降级人工窗口）。回归：test_kazumi_captcha_probe.py 26 测（+4：数组形态/reasoning 兜底/截断重发预算快照/raw 暴露）。
- **设置页「验证码视觉识别」新增「测试识别」按钮**：此前该区块只有三个输入框，配完无从验证（对比「划词翻译」卡有「测试连接」），配错服务商/模型只能等到真撞验证码失败才发现。现点按钮即跑一次内置验证码图的识别链诊断（`kazumi/captcha_probe.py` + `/kazumi/action do=kazumiCaptchaProbe`）：内置小模型报**可用/不可用与耗时**，视觉大模型报**连通性 + 是否支持图片输入 + 读得对不对 + 耗时**，并按错误码给出可读分类（鉴权失败 / 频率受限 / 服务端错误 / 配置不完整 / 网络不可达）。取当前表单值即时测（未保存也能测），探测图后端现场合成、不碰任何站点、不消耗用户站点请求；未启用兜底时不携带凭据（不悄悄烧 API 额度）。**注意口径**：内置小模型的结果**只报可用性、不判对错**——探测图是合成图，不在小模型的真实站点训练分布内（实测仓库内权重：合成样本整图 9%、干净印刷体 2%，而真实站点样本 55%，近乎随机基线的合成图判分会把「素材不在分布内」误报成「识别失败」），故结果行如实标注「不代表线上识别率」；视觉大模型判对错才是有效的（纯文本模型会在此以 4xx 暴露——不支持图片输入是验证码场景最常见的配置错误，也是本按钮的主要诊断价值）。回归：`test_kazumi_captcha_probe.py`（22 测：探测图可辨性护栏 4 个分离字形团 + 字高下限、字体退化放弃合成、小模型段不得出现 correct 字段、LLM 错误分类与多模态带图断言）与 `tests/js/captcha-probe-ui.test.js`（11 测：凭据透传/分级渲染/按钮防重/结果行揭 hidden）。
- **BT/磁链公共 tracker 列表自动刷新**（downloader.js）：内置默认列表整体替换为 trackerslist.com `best_aria2.txt`（2026-09-28 拉取，71 条，按 http/https/udp/wss 分组）；引擎每次启动就绪后异步检查并每 24h 复查一次——缓存新鲜（<72h）直接复用不出网，过期则拉取最新列表，经逐条 scheme 校验（≥10 条有效才收编，防 CDN 错误页/截断）后热替换，aria2 运行中经 `changeGlobalOption('bt-tracker')` 即时生效、未运行则下次 spawn 随 CLI 生效；失败静默回退当前列表并记录 6h 退避期（持久化到 userData/tracker-cache.json，跨会话生效），拉取 15s 超时 + 3 次重定向跟随 + 1MB 响应上限，任何网络异常都不影响下载主链路。
- **评分/吐槽弹窗布局优化**：10 颗星级按钮等宽铺满单行（不再折行拥挤）、条目名与当前评分徽标同行两端对齐（徽标随「已评分」状态高亮，`:has()` 纯 CSS 联动）、星级行下新增操作提示行、标签编辑区卡片化（容器底色 + 与吐槽正文视觉分区，毛玻璃模式同口径半透明）、提交按钮统一 40px 常规规格（与其他弹窗主操作一致）；未评分时「清除评分」按钮自动隐藏。吐槽输入框拉伸交互重做——原生 resize 把手在 Windows Chromium 上是右下角斜纹三角（内容拉满后尤为突兀）且与主题化滚动条重叠互相遮挡，现改为 wrap 内右下角自定义拉伸条（中性色横条、hover/拖拽变主色），`resize:none` 关闭原生把手，Pointer Events 按住拖拽实时改高度（setPointerCapture 指针滑出把手持续跟踪，84~240px 钳制与 CSS min/max 同源，触屏可拖）；自定义标签输入框从基类 56px 压到与「添加」按钮同高 32px，输入行 stretch 等高对齐，两端平齐。
- **Bangumi 评分/吐槽对话框支持打标签**（对齐 Kazumi rating_review_dialog）：对话框新增个人标签编辑区——当前标签 chips（可删）、条目公共标签做热门建议（默认 6 个可展开、点击增删）、自定义输入（回车/按钮添加，最多 10 个、单个 ≤10 字）。标签随评分/吐槽经 `kazumiBangumiSyncApply` 单条透传提交（PATCH body 新增 `tags` 字段）；脏检查通过才携带 tags 键（不误清远端标签；空数组 = 清除全部）。后端 `_bangumi_set_one` / `bangumi_update_collection` / `bangumi_apply_sync_plan` 全链路支持，`normalize_bgm_tags` 边界校验（超限转单条失败不发请求）。
- **详情页「选集讨论」板块**（对齐 Kazumi EpisodeCommentsView）：详情页签新增「选集讨论」——集数选择器（全部分集含 SP/OP/ED 徽标）+ 最早/最新排序 + 评论列表（楼中楼缩进、BBCode 渲染，与吐槽页签同视觉口径）。数据走新后端端点 `kazumiBangumiEpisodeComments`（GET `next.bgm.tv/p1/episodes/{id}/comments`，只读免 token；后端 10 分钟 TTL 缓存 + 渲染层 localStorage 同级缓存）；分集列表与「分集」页签共用 `_bgmEps` 缓存，切番剧/切集均有世代守卫防串档。集数选择器统一为「第 N 集 / 共 M」纯文本按钮（标题行内、「⇅ 切正序」左侧，与切正序完全同规格同字号）+ 向下悬浮网格弹层：顶栏（集数总数提示 + 「↓ 倒序 / ↑ 正序」格网排列切换小图标）+ 集号跳转行（输入集号回车或点「跳转」直达，几百集长番免滚动翻找；inputmode=numeric 唤起数字键盘，无匹配/非法输入行内红字提示 2.5s 自动消退，不打断输入）+ 多列集数格子（限高内部滚轮滚动、当前集高亮），点选/跳转即切集并收起，点击弹层外自动收起（与收藏菜单同交互口径）——不分集数多少同一形态，不再有横排滚动条。选集记忆：`_epCommentsEpisodeId` 之外新增 `_epCommentsMemory`（{sid, eid} 带番剧归属）——`_resetEpComments`（重开详情/嵌套返回）会清实例选中态但保留记忆，`_renderEpComments` 按 sid 匹配恢复上次选中的集（「点完集数再打开没有记忆」的修复）；换番剧后 sid 不匹配记忆自动作废，不会串档。集号显示口径：季内集号 `ep` 优先，`sort` 是跨季绝对集号（不少番剧不按季重编号，8 集的季度 sort 可达 71..78），直接用会显示「第 78 集/共 8 集」——现按 ep→sort→位置序号回退链取号，标题/按钮/格子三处口径一致。格网点选改为委托在 `.ep-comments-grid-cells` 容器上：弹层内切方向整片重写格网 innerHTML 会把直接绑定一起丢掉（表现为重排后点格子讨论不更新），委托容器不动故重排后依旧生效；点选时 `pickEp` 同帧重写格网 cells 把高亮迁到新集——弹层只是 toggle 显隐（DOM 不重建），不重写的话下次点开仍是旧集高亮（「选中格子无变化」的修复），按钮文案与高亮统一按 `_epCommentsEpisodeId` 实时取。两个排序控件语义分离、互不干扰：外层「⇅ 切正/倒序」只管评论列表排序，弹层内小图标只管格网排列方向（独立状态 `_epGridDesc`），各改各的文案、不重写对方（修复初版共享状态源导致「点弹层图标、外层按钮文案跟着跳」的串联感）。弹层特意向下展开盖在评论列表上方：页签内容区因入场动画 fill:both 形成层叠上下文，向上展开会被吸顶页签栏截断（实测遮挡），向下则永不越过页签栏；`.ep-comments-head` 另提为堆叠上下文（z-index:2）——评论卡因 content-visibility:auto 隐式 contain:paint 各自成独立绘制层、按 DOM 序后绘制，会把弹层盖住（实测第二处遮挡），提层级后弹层整体置顶于评论卡。
- **Bangumi 详情页一键跳转 bgm.tv**：hero 操作行新增「↗ Bangumi 页」按钮，经系统浏览器打开 `https://bgm.tv/subject/{id}` 条目页（主进程 `setWindowOpenHandler` 统一 `shell.openExternal`；subjectId 数字白名单校验防注入）。
- **收藏来源分类切换**：「我的→收藏」与独立收藏页的筛选行新增「全部 / CatVod / Bangumi」来源页签——本地收藏（CatVod 源/本地文件/下载/直链/Kazumi 规则源）与 Bangumi 账号收藏分开查看。判定口径与卡片渲染的 Bangumi 托管判定统一（`isBangumiItem`：远端条目 + 详情页同步镜像），与既有标签筛选/搜索叠加生效，切换后回到第一页；无匹配时空态文案切换为「没有匹配的记录」。
- **修复同步后 Bangumi 收藏被跳过**：`mergeExtraRecords` 的去重口径从「本地条目带 bangumiId 即拦远端同 ID」收窄为仅本地「Bangumi 镜像」（site='bangumi'）拦截——此前普通源收藏（CatVod/本地文件）在收藏/同步时也会回写 bangumiId（时间表关联用），导致点「同步 Bangumi」后账号收藏全部被去重跳过、网格只剩本地源影片。现在同名不同源的收藏（本地源 + Bangumi 账号）各自成卡正常展示，靠来源分类区分。
- **收藏面板布局精简**：删除「我的→收藏」卡片顶部与内容重复的「我的收藏」标题行（搜索框上移补位）；来源分类页签与状态标签页签拆为两行显示，不再拥挤。
- **收藏卡片视觉统一**：CatVod 收藏卡不再渲染源站备注（「更新至第 N 集」等）与底部观看进度条（进度信息仍由集数徽章「N/M」承载），备注行保留为空占位——卡片高度与 Bangumi 收藏卡完全一致，混排网格不再参差。
- **修复部分 Bangumi 收藏卡不显示公共评分/排名**：收藏网格渲染后的评分/排名补齐链路有两个过滤漏洞——① 托管判定要求条目带 `bangumi` 标志，但详情页收藏/同步写入的本地镜像条目（site='bangumi'）不带该标志，整批被跳过、永远不补拉（改用与卡片渲染同口径的 `isBangumiItem` 判定，已看话数补齐同样修正）；② 补拉条件要求评分与排名**两字段都缺**才发请求，只缺其一的卡（远端缓存历史形态等）整卡跳过，缺的那一半永远补不上（改为逐字段判定，缺哪个补哪个）。顺带修 `bgmRank=0` 时渲染「#0」无效徽章的问题（排名 ≥1 才渲染；0 系从评分「0 也算有值」口径误抄）。
- **修复部分 Bangumi 收藏卡有观看进度却不显示集数徽章**：已看话数补齐链路两处修正——① 补拉集合原先只含「在看/看过」状态的条目，但状态标签可被本地循环切换（切回想看/搁置/抛弃后远端 `ep_status` 观看进度仍在），这批卡从此不再查询、徽章消失；现放开为全部 Bangumi 托管条目查询（`getBangumiCollection` 走 6h 本地缓存，不放大请求数，`ep_status=0` 的本来就不出徽章）。② 回源结果为 null 时不再直接判「无进度」——单条收藏状态缓存有 60 秒负缓存，无法区分「未收藏」与瞬时失败（401/网络抖动），且 6 小时正缓存可能未回写最近一次打点；条目带 `bgmEpStatus`（上次状态查询/打点记录的 ep_status）时用记录值兜底出徽章，回源有值仍以远端为准。
- **收藏卡封面徽章组重排 + 已看集数徽章**：状态徽章（想看/在看/看过…）从封面左上角绝对定位移入封面左下角徽章组（源徽章右侧）；徽章组顺序统一为 源 → 状态 → 已看集数。集数徽章双数据源——CatVod 收藏用本地观看进度（`progress.currentEp/totalEps`，播放器逐集记账），Bangumi 收藏渲染后按 subject_id 补查收藏状态（`getBangumiCollection` 回传的 `ep_status`，看到第 N 话）+ 番剧信息总话数（`bangumiInfo.eps`，30 分钟缓存）回填 `N/总` 徽章；仅在看/看过状态的 Bangumi 卡发请求（想看/搁置/抛弃无进度语义免请求），无 Token/未收藏/失败静默保持无徽章。
- **搜索页 Kazumi 源卡片样式对齐 Bangumi 搜索卡**：Kazumi 页签结果卡复用 `bangumiCard` 的视觉口径——备注行从固定「Kazumi 规则源」改为「⭐评分 · 播出日期」（无匹配数据时保留原文案兜底）、封面右上角补 `#N` 排名角标（与左上角源名徽章并存）。数据随 Bangumi 封面匹配缓存（`_bgmMetaOf` 提取 score/rank/air_date，远端可控数值 Number 归一）一并写入：封面补拉管线（common.js `_coverFillOne`）在补上封面时同步刷新角标与备注（历史页 Kazumi 卡备注带真实内容时不覆盖）；搜索点击回填 `cacheBangumiMatch` 支持第四参 meta 透传；localStorage 持久化读侧对旧版本脏数据重归一。
- **详情页观看进度显示补全**：① **CatVod 详情页新增本地观看进度条**——播放信息下方新增细进度条 + 「N/M」文案（数据源为通用观看进度表 `watchProgress`，播放器逐集记账 `Favorites.updateProgress` 写入，不依赖收藏——未收藏影片也有进度；条宽按集数比例、集数未知退单集观看百分比；无进度时整条隐藏），订阅 FavHub 广播，播放中每集看完实时刷新；② **Bangumi 详情页进度对账**——`_applyBangumiColState` 新增 force 选项，详情页打开/嵌套返回时除缓存即时回填外再强制回源对账一次（6h 收藏缓存内的 `ep_status` 可能落后：他设备打点、本机打点未走缓存更新路径），回源后重写缓存并重算进度条；进度写入按 subjectId 归一限定当前详情页，弹窗复用不再串档。两种详情页的进度均为统计区/播放信息区内的独立进度条行（细轨道 + 主色填充 + 右侧「N/M」短文案），不再插在操作按钮之间。
- **「看完」判定改为观看比例**：连播推进与 Bangumi 看完自动上报的「看完」口径从「退出时剩余 <8s」改为「已看时长 / 总时长 ≥70%」——固定 8s 对长视频过苛（45 分钟的番要拖到片尾最后 8 秒才认定看完，片尾曲拖一下进度就漏计）；比例口径下看到 70% 即算看完，短视频阈值自然收紧。进度取不到时仍回退 ended 事件 10s 兜底；断流重连分支的「剩余 ≥8s 才重连」是另一套语义（避免对即将播完的集做无谓重连），保持不变。

### Fixed

- **评分/吐槽弹窗打开提速（补查等待加 4 秒保险丝）**：详情页「评分 / 吐槽」按钮点击后先 `await fetchCurrent` 补查当前评分/吐槽/标签（取 Token → 后端转发 Bangumi 收藏接口，一次完整网络往返），请求返回才打开对话框——弱网下按钮要转圈数秒才能看到弹窗，且等待无上限。现保留点击转圈的交互（spinner + 防连点不变），但补查等待加 **4 秒竞速保险丝**（`RATE_FETCH_TIMEOUT_MS`）：正常返回带预填开窗（行为与原先完全一致）；超过 4 秒（弱网/接口挂起）不再苦等——先无预填开窗，同一次在途补查晚到后经新增的 `BgmRate.mergeFetched` 合并进已打开的对话框并重渲（不重发请求）。合并两道守卫：条目不匹配（详情页已切到别的番剧）或对话框已关时丢弃不串档；用户在数据到达前已做任何编辑（打星/清除评分/加删标签/颜文字插入/吐槽框与标签输入框打字——后者经新增 `input` 监听置 `_touched`）时丢弃晚到的远端数据，不覆盖用户输入。超时分支预填语义 rate=null/comment=''/tags=undefined = 「未知」而非「已确认无评分」，不会误清星级或标签。回归：`tests/js/bgm-rate.test.js` 新增 mergeFetched 套件 6 例（合并落 _ctx 并重渲、条目不匹配/已关丢弃、_touched 四交互入口+跨会话复位、缺省字段不覆盖、input 监听绑定契约、超时无预填开窗后晚到合并语义），detail.js 入口断言改为「race 超时竞速 + 超时分支 mergeFetched 合并在途请求」。
- **修复详情页封面「占位 → 显示 → 闪一下」(A-30)**：Bangumi 条目打开时，列表卡（快照来源）用 `card`/`common` 变体（`/r/400/pic/cover/l/…`），详情 hero 用 `large` 变体（`/pic/cover/l/…`，无 `r` 前缀）——两者**逐字必然不同**。A-01 那套「快照封面沿用」防闪机制（`_snapCoverShown`）只做 URL 全等比较，于是**在 Bangumi 主路径上从未生效**：每次 `bangumiInfo` 到达的整页 render 都判为「异 URL」→ 改走 `bangumiCoverImg` 代理链 → 新 `<img>` 以 `opacity:0` 重新加载一个不同 URL → 视觉上占位→显示→闪一下。修复：新增 `_detailSameCoverPicture(a, b)`，把 lain 图床 URL 归一化成「图的身份指纹」（先剥 `/r/{宽}/` 前缀、再剥 lain 主机（兼容官方/镜像域）、尺寸段统一为 `l`），判定放宽为「同一张图的不同尺寸变体」即沿用；沿用分支渲染**快照 URL 本身**（浏览器 HTTP 缓存必然命中，零网络零重绘），并补 `data-big` 指向 large 变体——点击放大仍拿大图，不因沿用降到 400px。非 lain 域名（CatVod 源/第三方图床）无尺寸变体语义，一律按不等处理，行为不变。`bangumiResizeUrl` 走防御式调用（单测沙箱可能未注入该全局），绝不让它炸掉整页 render。回归：`tests/js/detail-bgm-snap.test.js` ⑤b 组 4 例（card 400 vs large 沿用直连 / data-big 升大图 / 不同图恢复代理链 / 归一化判定含镜像域与非 lain 边界），回退判定后 2 例失败确证有效。
- **修复详情页「角色 / 制作 / 关联」页签大数据条目显示「暂无数据」**：三个页签此前共用一个 `_bgmExtraLoaded` 标志，而该标志在**吐槽路**到达（最快，通常 ~1s）时即无条件置真；角色路要并发补全每个角色的中文名（N 个角色 = N 次 `/v0/characters/{id}` 详情请求），长番剧实测慢得多。共用标志期间切到这三个页签会穿过骨架判定、而数组仍是空的 → 渲染成「暂无角色信息 / 暂无制作人员信息 / 暂无关联番剧」，数据随后到达也只在页签内重绘一次。条目角色/关联越多越容易命中，表现为「数据太多反而显示暂无」。两端修复：①**前端逐路 settle 标志** `_bgmExtraRouteLoaded`（新 `_bgmRouteSettled(route)` 判定），每页签等到自己那一路真正 settle（成功或判失败）才出内容——慢路只影响自己、快路照常秒出，真无数据时仍维持「暂无…」文案，换片/重试/partial 缓存空占位均按各自语义复位或保持骨架；②**后端补全有上限** `_CHAR_NAME_CN_ENRICH_LIMIT`（60 个角色，并发 6→8）：列表按主角→配角→闲角排序，前 60 个正是用户会看的主要人物（实测 273 角色条目仍有 37 个拿到中文名），超出的闲角保留原名渲染。实测端到端：名侦探柯南（subject 899，273 角色 / 1028 制作 / 258 关联）角色路 **8~22s → 1.3~2.2s**，三页签均正常出内容。回归：`tests/js/detail-bgm-extra-per-route.test.js`（5 例：吐槽先到时角色页签骨架而非「暂无」、制作/关联同口径、真无数据维持空态、换片与重试复位、partial 空占位不误显），`tests/test_kazumi.py` 3 例（补全条数截断/跳过已有中文名/单角色失败保留原名）；全量 jsunit 2299 通过、Python `run_all.py` 全阶段 PASS。
- **源卡片「进行验证」按钮接入自动识别**：「开始观看」→ 选源弹窗里验证码源卡片的「进行验证」按钮此前直接打开人工验证窗口（三处验证码入口中唯一跳过自动解题的一处），现与搜索页「需验证」标签、章节页自动解题同口径——先调 `kazumiCaptchaSolve` 自动识别（后端取图 → ddddocr/小模型识别 → verify_check 提交 → 复验落 Cookie），成功直接重查该源上结果；失败/请求异常/无识别能力才回落原人工验证窗口。识别期间卡片体显示「正在自动识别验证码…」占位（操作按钮随占位收敛，天然防连点），结束后复位；solve 端点不依赖 captchaUrl（后端按规则 captchaImage XPath 或 MacCMS 约定端点自行取图），故无链接的源也先试自动，仅「自动失败且无链接」才提示无入口。

### Tests

- 章节页/源卡验证码自动解题：`tests/js/kazumi-chapter-captcha.test.js` 扩至 9 例（既有 4 例章节页链路 + 新增 5 例源卡「进行验证」——solve 成功带 plugin 重查该源并解除占位、失败且 captchaUrl 在回落人工窗口且验证后重查、失败且无链接提示不开窗、solve 请求异常按失败口径回落、识别中置 searching/solveHint 占位与结束清空）。修复该文件两处既有缺陷：① kazumi.js 在 vm 沙箱执行，沙箱字面量对象的原型是沙箱 realm 的 `Object.prototype`，`assert.deepStrictEqual` 校验原型导致跨 realm 整对象比较必败——改为逐字段取原始值比较；② 「solve 失败回落人工窗口」用例的窗口桩同步触发 onDone 会在「解析→captcha→solve→回落」闭环里无限循环挂死测试进程——桩改为只记录不触发 onDone。
- 划词翻译：新增 `tests/js/translate-bubble.test.js` 9 例（气泡定位 clamp 数学：下方 8px/翻转上方/左右越界；选区判定：折叠/短文本/输入框内不触发；捕获阶段 click 抑制；3 秒去重窗口；`/translate` 请求体契约含 LLM 字段注入与 5000 截断；`placeFixedInViewport` 无布局直写与 zoom=0.5 缩放反解）+ 新增 `python-backend/tests/test_kazumi_translate.py` 19 例（HTML 转义往返、微软/Google 双语言码归一、三 provider 响应解析与错误分类、段数不符、failover 次序、缓存命中不出网、LLM 鉴权失败分类）。
- 「看完」比例判定：`tests/js/player-watch.test.js` isDone 用例扩为比例判定矩阵（95%/70% 整/69.96%/50%/0%/进度缺失六档，含 45 分钟长视频场景）。
- 详情页本地观看进度行：新增 `tests/js/detail-local-progress.test.js` 9 例（通用进度表命中渲染、未收藏影片进度显示、旧版收藏条目字段回退、无进度/currentEp=0 隐藏、totalEps 缺失回退线路集数、Bangumi 匹配详情不渲染本地进度容器、组件缺失静默降级、FavHub 广播实时刷新联动）。
- Kazumi 搜索来源直达播放：新增 `tests/js/kazumi-origin-play.test.js` 10 例（search.js 两条 Bangumi 匹配路径携带 kazumiOrigin、未匹配回落 openSourceDialog 入参口径不变；detail.js openBangumi 校验/清洗 origin、open() 重置防残留、嵌套快照保留、#detail-kazumi-start 点击按 origin 分叉；kazumi.js openBangumiInfoPage 透传、openSourceDialog 直达分支预建 _dlgState 且返回选源可回、非直达路径行为不变）。
- tracker 自动刷新：`tests/js/downloader-internals.test.js` 扩至 72 例（新增 tracker 刷新套件 9 例——parseTrackerList 混合格式解析/去重/坏行剔除与 10 条收编阈值、无缓存拉取成功热更新 + RPC changeGlobalOption 断言、缓存 72h TTL 内不出网、失败 6h 退避期不重试且过期恢复、非 2xx/坏列表/网络错三场景回退内置列表不写缓存、scheduleTrackerRefresh 立即触发 + stop 清定时器、start 就绪自动挂调度、addUri 磁链使用刷新后列表；loadDownloader 提升至文件顶层并支持 https/electron 桩注入）。
- 新增 `tests/js/bgm-episode-comments.test.js`（21 例：选集讨论页签注册/派发/渲染/排序/世代守卫/跨番剧复位、bgm.tv 跳转按钮与守卫、kazumi.js 封装与缓存、后端 do 分支/端点/tags 链路契约、Python 纯逻辑跨语言断言；集数选择器统一形态 8 例——集数不分多少统一渲染按钮+悬浮网格（无 chips 容器、无 ⌄ 下标、弹层默认收起）、选集按钮位于切正序左侧且两按钮同 md-btn-sm 规格的布局契约、弹层向下展开+限高滚轮的 CSS 契约（防吸顶页签栏遮挡回归，chips 旧样式删除断言）、弹层内排序切换小图标（只切格网方向的独立状态 _epGridDesc、格网重排倒序最大集在前/正序第 1 集在前、不重写外层切正序按钮文案且评论排序状态不变——两控件互不干扰）、连续编号番剧按季内集号 ep 显示（第二季 8 集 sort=71..78/ep=1..8 场景标题与按钮显示「第 8 集/共 8 集」而非「第 78 集」，ep 缺失回退 sort 再回退位置序号）、选集跨会话记忆（重开同番剧 _resetEpComments 清实例态后按 _epCommentsMemory sid 匹配恢复上次选中集并带高亮，换番剧 sid 不匹配自动作废回退第 1 集不串档）、弹层集号跳转（300 集长番输入 250 回车直达 id=1249 并收起弹层、格网重写高亮迁移、无效集号行内提示「没有第 999 集」且不切集、跳转写入选集记忆）、网格点选交互（委托绑定在 grid-cells 容器防重排掉绑定、收起弹层/标题与按钮文案刷新/重复点选不重拉、pickEp 同帧重写 cells 断言重写后仅新集带 active 高亮——弹层显隐 toggle 不重建 DOM，再点开即见选中态））；`tests/js/bgm-rate.test.js` 扩至 23 例（normalizeTags/normalizeTagInput/标签 payload 语义/脏检查/收藏 GET tags 归一化/UI 集成形态，新增颜文字套件 5 例：清单口径（非空/去重/纯文本/长度）、全量渲染进悬浮面板（无折叠按钮）、面板状态机（悬停展开/离开延时收起/点击钉住/再点收起/点外 dismiss/悬停清除延时器）、_insertKamoji 光标插入/选区替换/文末追加/空串忽略、index.html 按钮+面板结构与绝对定位契约；吐槽框拉伸套件 1 例：wrap+把手结构与 resize:none 关闭原生把手、pointerdown 拖拽绑定与 setPointerCapture、84~240px 钳制与 CSS min/max 同源、标签输入行 stretch 等高 32px 对齐）；`tests/js/player-internals.test.js` fetchCurrent 用例随返回值扩展同步。Python 侧 `test_kazumi_bgm_rating.py` 扩至 57 例（normalize_bgm_tags 边界、update_collection/apply_sync_plan 的 tags 通道、空数组清除语义、分集评论多形态兼容与错误降级）。
- 收藏来源分类：`tests/js/my-about-ui-state.test.js` 扩至 108 例（catvod/bangumi 分类过滤与同步镜像归属、同步后同名不同源各自成卡、_src 清空恢复全部、与标签/搜索叠加、页签点击写态与未知值钳制、无匹配空态文案、无 Kazumi 环境补齐静默跳过）；`tests/js/records.test.js` 扩至 26 例（合并去重收窄为仅 Bangumi 镜像拦截远端、历史视图不参与来源筛选、收藏视图默认全部、状态徽章入徽章组次序断言、CatVod 本地 progress 集数徽章 3/12 与 5/? 形态、历史卡同名去重计数口径不变）。
- 直播入场动画扩展：`tests/js/live.test.js` 扩至 31 例——renderList 挂/摘 `.anim-cards` 语义、错峰延迟内联覆盖当页全部频道（30ms/张递增、无前 N 张上限、非动画渲染不带延迟）、进页首渲/切源/手动刷新/缓存命中路径播动画、探测分批刷新与异常回滚不播、enter 每页数量变更重排播动画（jQuery 桩 `toggleClass` 补记录、新增 `probeUrls` 桩与 `$.lastAnim` 断言口）。
- 推荐页悬停徽章：新增 `tests/js/popular-badges.test.js` 7 例（_renderGrid 后徽章挂载联动、Timeline 缺席静默降级、_ensureColState 无 token 仅本地标记/账号态优先不被本地覆盖/嵌套 subject.id 与字符串 type 脏数据兼容、refreshBadges 未开启零开销、与真实 timeline.js 跨文件联调挂 .vod-fav-row）；`tests/js/timeline.test.js` 扩至 20 例（_attachEpBadges itemsFull 快捷分支——条目自带 eps 免回源 bangumiInfo、缺 eps 仍回源兜底）。
- 全量回归：JS 单元 1876/1876（after-pack.test.js 扩至 12 例：elevate.exe 剔除、PE VERSION_INFO 解析以 electron.exe 真实样本实证、非 PE/无版本资源降级、元数据门禁 fail-build、win/darwin 平台分叉）、check-js 50 文件 0 错、ESLint 0 error（既有 warning 不变）。

## [0.2.6] - 2026-09-24

本轮包含 2026-09-22 发布 v0.2.5 之后的四个批次：全项目代码审查修复、功能增强批次与大规模测试补齐，并修复 CI 慢机上的 flaky 测试。

### Added

- **跳过片头片尾功能补全**（用户报告三项缺陷的一次性修复）：① **连播不跳片头**——原生队列的 `pendingSeekSec` 此前带 `seekApplied` 一次性标记只在首集装载后 seek 一次，第 2 集起片头跳过静默失效；现改为逐集判定（每次 file-loaded 读 time-pos 守卫后 seek，watch-later 已自行续播的本集仍不覆盖），同片名各集按「片名+线路」记录正常复用；② **本地文件不能标记**——本地播放由主进程 `yuki:file-push`/`dl-play` 直起，渲染层 `_curMeta` 为空导致右键菜单登记报「当前没有正在播放的影片」；主进程 oped-record 信号现附带会话标题（`mpv.getSessionTitle()`，单集为文件名、本地批量连播为首集文件名），渲染层登记/清除按它兜底建键；③ **取消入口**——右键菜单新增「清除片头/片尾标记」（复用 oped-record 信号通道传 `clear`，`AdSkip.clearOpEd` 删除当前影片记录，kind 缺省整条删），设置 → 播放新增「跳过片头片尾」开关（`opEdSkip` 此前只存在于设置白名单无 UI）与「清除全部」按钮（`AdSkip.clearAllOpEd` 返回清除条数）。
- **Bangumi 评分/吐槽对话框**：详情页可直接为番组提交星级评分与吐槽（复用 `bangumiBangumiSyncApply` 端点透传，含提交状态与失败提示）。
- **CatVod 详情页「开始播放」一键直达**：详情页在解析出选集后提供一键起播按钮，免二次点击。
- **HLS 广告段过滤引擎**：`python-backend/ad_filter.py` 基于 `#EXT-X-DISCONTINUITY` + 跨 host + 路径特征词的组合启发式识别广告分片（宁漏勿错杀），供 HLS 下载链路调用；当前未挂载到在线播放。
- **Kazumi 图片验证码识别模块骨架**：`python-backend/kazumi/captcha.py`（ddddocr 优先、可降级），预留接口暂未挂载。
- **IPC 可信发送方判定加固**：`senderFrame` 判定加 `sender.getURL()` 兜底，拒绝日志携带双 URL 现场便于排查。

### Fixed

- **2026-09-28 未暂存区全量代码审查修复**（OCR delegate 文件选择 + 13 个审查子代理交叉审查，47 文件 +4328/-623 全覆盖）：验证确认并修复 4 项 critical/high、12 项 medium 与一批 low 问题，明细见 `docs/CODE_REVIEW_2026-09-28.md`。要点：
  - **jar_bridge 按需下载布局错误（打包模式主路径必然失败）**：上游 dex-tools-v2.4.zip 顶层即 `dex-tools-v2.4/`（实测无外层 `dex-tools/` 包装），原实现按错误布局解压定位恒失败；现按真实布局落位 `cache/dex-tools/dex-tools-v2.4/` 与 vendor 一致。同时修复「主 jar 已在即跳过 dexdeps 补全」的快路径（依赖缺失曾永不重试）、补全循环可达性、依赖写盘 tmp+replace 原子化 + 已存在文件哈希复核、下载失败负缓存（10 分钟冷却，防弱网下每次转换请求重跑完整下载链拖死调用方）。
  - **detail.js CatVod meta 行 XSS 回归**：hero 重构时 `metaLine` 各段（type_name/vod_year/vod_area/vod_remarks，第三方 CMS 源回传）漏转义直接进 `.html()`，恢复整体 `escHtml`。
  - **file-manager delMany 先删后确认**：文件在目录确认框弹出前已被删除，用户在主进程框点「取消」意图全不删、文件却已删且 toast 显示「已取消删除」；现改为防线（根目录剔除/在写互斥/原生确认框）全部通过后才统一删除，根目录拒绝提前到确认框之前（与 delFolder 口径一致）。
  - **本地多选单条目外部播放器 VLC 不播**：`yuki:file-push-many` 单有效条目直传正斜杠盘符路径绕过 `toExternalLocalUrl`（VLC 静默拒载只拉窗口），现单条目先过 `toExternalLocalUrl` 再直启（与 file-push/dl-play 同口径）。
  - **download-binaries downloadDextools 首次安装必然 ENOENT**：`rmSync(dest)` 后 `renameSync` 前缺 `ensureDir(dest)`（父目录被删），实测复现并修复。
  - **server.py 分集评论缓存形同虚设**：`kazumiBangumiEpisodeComments` 的上游请求写在 `_cached_bangumi` builder 之外，缓存命中也先回源一次；网络调用移入 builder 与其余 7 个端点同构。
  - **downloader fetchText 畸形 Location 卡死刷新锁**：3xx 重定向的 `new URL(...)` 在事件回调内同步 throw 会让 Promise 永不 settle、`_trackerRefreshing` 永久为 true；改 try/catch reject + `rsp.resume()` 排空响应归还连接池。
  - **收藏状态标签不可点（CSS 回归）**：`.rec-cover-badges` 的 `pointer-events:none` 可继承到 `.rec-tag`，状态循环切换交互死亡；补 `.rec-cover-badges .rec-tag { pointer-events:auto; }`。
  - **收藏卡徽章渲染口径**：「我的 N★」与「#N 排名」右上角重叠补互斥（排名优先）；bgmScore 公共评分首渲路径补齐（无播放行时拼到日期行行首，v3 缓存新增字段不再落空）。
  - **kazumi.js 匹配缓存读写不对称**：读侧 `_bgmMetaOf` 不认写侧扁平 `score/rank` 字段，重启后评分/排名清零被回写永久丢失；读侧兼容两种形态。收藏状态 null 负缓存 6h 改 60s（上游 401/网络失败不再冻结「未收藏」展示）、乐观合并补 token 校验（换号不串数据）、`Detail._bgmColCache` 死写移除。
  - **bgm-rate.js 交互细节**：调星级不再清空正在输入的标签草稿（`_renderTags(preserveInput)`）；草稿非法（重复/超限）降级为提示不阻断评分提交；仅改标签提交成功文案改「标签已更新」不再误报「吐槽已提交」。
  - **panels.js 多选模式**：`selectFile`/`enterDir` 补 `_selMode` 守卫（多选时点条目主体转勾选，与帮助文案一致）；「全选/反选」范围收窄为当前页切片（与可见勾选框一致，防整库误删感知偏差）；中文集号锚点字符类补「零」。
  - **测试侧修复与新增**：live.test.js「缓存命中不探测」恒真断言改真实 probeUrls 计数桩；detail-start-button 死断言补有效内容断言；file-manager-ipc 5 处临时目录补 try/finally 清理 + 新增「取消/互斥时不删文件」回归断言；player-internals T80 源码正则死代码用例重写为真实 submit 行为测试；bgm-episode-comments 硬编码 venv python 改 existsSync 回退 + skip 显形（CI js job 不再 ENOENT）并补跳转守卫源码锚点；my-about-ui-state 用例名与断言对齐；新增 `python-backend/tests/test_dextools_on_demand.py` 10 例（此前 150 行按需下载逻辑零覆盖——vendor/缓存解析顺序、真实布局落位、dexdeps 补全/哈希/原子写、失败负缓存冷却与恢复）并接入 run_all。
  - **.opencodereview/ 加入 .gitignore**：目录内 config.json 含 LLM 网关 api_key 明文，防止随 `git add .` 入库泄露。
  - **文档同步**：ad-skip.js 登记入口注释对齐 mpv 右键菜单迁移、download-binaries.js 注释对齐实际触发路径、index.html CSP 注释哈希计数 41→42、ui.css 死规则 `.detail-stat-eps` 清理、detail.js `_epCommentsEpisode` 死字段移除、director 正则重复分支清理、my.js globals 注释残留清理、mpv-player 嵌套三元与 kazumi/bgm-rate 宽松等号规范化。
- **capability_router：省略 type 的 csp_/JAR 仓整仓判死**：TVBox 手写仓常见「不写 type 但 api 为 csp_ 前缀/指向 JAR」的条目此前被归入未知类型直接跳过，现按 JAR 路由修复菜妮丝等仓不可用的问题；`config.py` 同步支持 spider 列表/分号多值写法解析。
- **jar_bridge 非字典 JSON 帧致读线程死亡**：`_on_line` 对非 dict 帧补 `isinstance` 校验，防止一个坏帧杀死读线程、后续 pending 调用全部被误拒。
- **hls-downloader completed 监听器异常兜底**：监听器异常不再冒泡崩溃、不再误判失败触发重下。
- **pan-qr-window 建窗失败残留**：初始化失败时清理残留窗口与定时器、复位可重试。
- **mpv-player**：弹幕轨装载门控保持默认关、watch-later 续播位置守卫、在线源统一预缓冲。
- **renderer/search**：快速搜索未展示时的失败/不可用提示改走 warnToast（不再静默）。

### Security

- 代码审查收口批次（d16d35f，17 条 High 与主要 Medium/Low）：go_proxy 分段流强制 206+Content-Range 校验与截断、kazumi 规则引擎逐跳 SSRF 守卫与重定向逐跳重派生 Cookie、cookie 仅同域附带、http_client 云元数据红线、JAR 默认强制 https+md5 校验（`YUKI_JAR_INSECURE_SOURCES` 可放宽）、`/proxy` 强制 token、supervisor 淘汰有界扫描（修复 while True 霸锁死锁）、弱引用 LRU、熔断区分排队超时、site_worker 方法白名单、DNS rebinding 二次解析缓解、WebDAV 恢复显式允许表、js-engine 多行 import 与循环依赖 fixup 等后端与 Electron 侧成批加固；明细见 `docs/CODE_REVIEW_2026-09-22.md`。

### Tests

- **跳过片头片尾补全配套测试**：`ad-skip.test.js` 新增 `clearOpEd`（单字段清/整条删/幂等/隔离）与 `clearAllOpEd`（条数返回/清空后可再登记）、本地文件标题兜底登记与缺省拒绝、`_onOpEdClear` 整条清除共 6 例；`mpv-player.test.js` 原生队列首集 seek 用例改写为逐集判定（第二集照常 seek、不再依赖 seekApplied 一次性标记）并新增回归用例，全文件 64/64。
- **大规模测试补齐**（93d9689）：新增 Python 后端 16 个测试文件（jar-bridge/runtime/spider/cache/http-client/go-proxy/pan-login/site-manager 等内部逻辑与黑盒用例）+ JS 侧 24 个测试文件（主进程下载器/播放器/IPC/推流/同步播放、渲染页面与 preload 契约等），并统一 run_all 阶段编排。全量回归：`run_all.py` 74 阶段 ALL PASS、编译 264 文件 0 error、JS 单元 1717/1717、check-js 50 文件 0 错、ESLint 0 error（74 条既有 warning 不变）、Ruff 全过。
- **CI flaky 修复**：`test_runtime_supervisor.py` 五十源聚合搜索用例第二轮搜索前把被强杀的 10 个无限循环 Worker 重新 init 预热——CI 双核 runner 上第二轮冷 spawn 风暴会挤占 CPU，把健康源的管道往返拖出预算（观测 14/40，run 35647959954）；预热后第二轮与首轮对称，被测语义（第二轮不被上一批遗留协调线程/Worker 占满）不变。

## [0.2.5] - 2026-09-22

本轮为三份独立安全审查（hy4 / ds / glm）交叉验证后的第二轮修复：合并去重确认 P1×5、P2×19、P3×24，按文件域并行修复并补齐回归测试。三份审查报告属临时文档，验证完成后已删除。

### Changed

- **会话级 TTL 内存缓存提速**：新增 `python-backend/mem_cache.py` 会话级 TTL 内存缓存，服务端热点数据（含 Kazumi 规则与 Spider 内容缓存）改经统一内存层供数，减少重复解析与磁盘往返；配套 `test_mem_cache.py`、`test_spider_content_cache.py`、`test_kazumi_cache.py` 三个回归阶段接入 run_all。

### Security

- **主 token 明文落盘播放缓存（P1-2）**：`_is_ephemeral_play_result` 的本地 host 短路位于 volatile 参数检查之前，任何带 `?token=<主token>` 的本地 URL 一律判「稳定」写入 `~/.yuki/cache/play-cache/`（TTL 2h），本机低权限进程读文件即得 40 位 hex 主 token，可经 `/action` 完成全部控制面操作。现把 volatile 检查前置（`proxytype=go` 早退保持原位），任何带 token/sign/expires 等参数的 URL 无论 host 一律不落盘；解析异常与残缺响应同时改为 fail-closed。
- **失败播放结果被持久化 2 小时（P2-10）**：`{"url":"","error":…}` 因「url 为空 → 判稳定」被落盘，重开剧集在 TTL 内直接吃到失败结果。现落盘条件对齐「url 非空且 error 为空」。
- **`do=pan` 网盘取流免鉴权（P1-3）**：`do=pan` 分支在 `?url=` 通道 token 门禁之前 return，本机任意进程一条 GET 即可读夸克分享、把第三方分享转存进用户网盘（账号侧写操作）、并拿到内嵌主 token 的 HLS 重写地址。现与 `?url=` 通道同权鉴权（无效返回 401）；`_hls_proxy_wrap` 只在本次请求已通过校验时才把 token 附到重写后的 HLS 分片；jar_spider 快路径与 proxy_gateway 回退两个构造点补齐 token，server 侧对 jar 硬编码的 `do=pan` 地址统一附加。
- **JVM 强杀后网盘 Cookie 明文残留（P1-4）**：SpiderRunner 把 quark/uc/bili/189/diy 五个网盘 Cookie 明文写进 `~/.yuki/jar-cache/TVBox/*_cookie.txt`，优雅退出靠 Java shutdown hook 清理，但 Windows TerminateProcess 不执行 hook——超时/写失败/崩溃重启等全部强杀路径后登录态永久残留用户主目录。现 jar_bridge 侧在所有强杀路径后补删 `TVBox/*_cookie.txt`（幂等、只删 cookie 文件、不动内容寻址 jar 缓存、绝不影响主流程）。
- **Worker 进程 hoststate 全空（P1-5）**：python/cms 分支的 spec 不带 `proxy_port`，Worker 侧从未 configure，hoststate 默认 port:0/token:''——第三方 Python spider 的 KV 打到 `http://127.0.0.1:0/cache` 全部失败、`getProxyUrl()` 产出坏地址且被本地判断落盘（与 P1-2 叠加）、JVM 地址 token 为空。现 spec 全分支统一注入 `proxy_port`/`proxy_token`/`data_dir`，Worker 构建时 `hoststate.configure` 灌入（先于任何 spider 模块导入）。
- **浏览器防御不校验 Host 头（P2-1）**：`_browser_origin_rejected` 与 go_proxy `_reject_browser` 只查 Origin/Sec-Fetch-Site，DNS rebinding 下浏览器可打到 `/cache`、`/health`。两处各加 Host 白名单（剥端口后须为 127.0.0.1/localhost；缺失放行兼容非浏览器蜘蛛），`/health` 免 token 端点单独加同款校验。
- **`/health` 免 token 返回全部 Kazumi 规则源（P2-14）**：含 api/baseURL/searchURL 的完整规则列表对无 token 调用方开放。改为只返回规则数量（全仓确认无真实消费方）。
- **严格 SSRF 边界三处不一致（P2-11）**：`_native_http` 只守首跳（重定向不逐跳复检）、`base.Spider.fetch/post` 无守卫且 `verify` 可被 spider 关 TLS、ESM 子模块抓取自任信任根。三处统一复用 `http_client._guard_hop`：重定向手动逐跳复检、严格模式下 TLS 强制开启、子模块抓取走配置层同一套守卫。
- **`ipcMain.handle` 无 senderFrame 校验（P2-6）**：约百个特权通道对任意渲染上下文开放。统一注册包装校验可信发送方（本应用仅主窗挂 preload，可信页面即主窗加载的本应用 index.html，判定与导航白名单一致；帧销毁 fail-closed）；`download.control` 的 `deleteFiles` 同步从默认删文件收紧为显式 opt-in（字段省略不再静默删除已下载媒体）。
- **`delFolder` 可递归删除下载根下任意子树（P2-7）**：渲染层一次误传即删整个媒体库。现加三道防线：拒绝删根、原生确认框二次确认（列出将删除的绝对路径）、目录内存在进行中下载任务时拒绝删除（在写互斥）。
- **after-pack 门禁 fail-open（P2-8）**：asar 清单解析失败时返回占位字符串、不匹配任何敏感正则，静默跳过扫描（`@electron/asar` 未声明依赖，pnpm 布局下正是真实触发路径）。现 catch 改为抛错终止构建（fail-closed），`@electron/asar` 提为 devDependencies；`build-python.js` 快照拷贝排除 `FM/` 与 `.test-runtime/`（杜绝凭据再次进包），符号链接/junction 改为解引用拷贝（修复 venv 含 junction 时冻结包不完整）。
- **解析/验证码/扫码窗口无权限处理器（P2-12）**：加载远程内容的会话对通知/定位/剪贴板等权限默认放行，主流程还引导用户复制整行 Cookie。parse-<slot> 与 quark-pan-login 等全部会话注册全拒处理器。
- **退出不取消定时关机（P2-13）**：`shutdown /s /t 60` 已下发后退出应用，60s 宽限期内机器照样关机（不可逆）。`runQuitCleanup` 首行统一撤销（含 `shutdown /a`），`app.exit(0)` 路径同受覆盖。
- **CSP 桥接放行任意 window 全局函数（P2-2）**：按函数名解析 window 任意属性（含 `eval` 可达）。改为显式函数白名单（6 个实际消费的函数名），新增消费点须显式登记。
- **kazumi `info.id` 两处未转义（P2-3）**：恶意/被劫持 Bangumi 镜像可注入（后端对镜像响应原样透传）。两行转义修复；`bangumiInfo` localStorage 持久化同时改为字段白名单净化，恶意 payload 不再借缓存短暂存活于渲染。
- **WebDAV 设置同步上传敏感键（P2-5）**：bangumiToken/dandanAppSecret 等被上传远端，启动 5s 静默恢复可改写 `lastConfigUrl`。上传侧补敏感键排除表，恢复侧改为显式允许表（64 个纯数据键，默认拒绝）。
- **HLS 下载续传不校验分片完整性（P2-16）**：崩溃/强杀残留的截断分片被静默复用，产物损坏仍标 complete。现记录每分片写入字节数，续传按期望大小校验，未知大小一律重下。
- **playlist-proxy `_resolve` 无异常保护（P2-17）**：后端抖动时裸抛 502（无 Content-Type 且 `onEntryError` 不触发），连播静默卡死。解析链统一折叠为失败对象，走与正常失败相同的应答路径。
- **动态监听端口不在 token 白名单（P2-9）**：此类 jar 播放地址永远 401。`listening_ports()` 纳入 `_extra_servers` 动态端口。
- **本地文件播放失败静默重试（P2-18）**：删除 500ms 无提示重试分支，失败立即 toast；「播放器启动超时」提示不再被重试分支消费而不可达。

### Fixed

- **ffmpeg 锁定源下线导致构建失败（发布阻断）**：原锁定的 gyan.dev 版本化包 `ffmpeg-9.0.1-essentials_build.zip` 已从服务器移除（HTTP 404），CI 构建在「下载第三方二进制」一步失败。现迁移至 [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) 的版本化资产 `ffmpeg-n9.0-latest-win64-gpl-9.0.zip`（mpv 官方 wiki 推荐构建渠道之一；GitHub release 资产自带服务端官方 digest 可核对，sha256 已本地下载复验一致）；`binaries.lock.json`、构建脚本兜底常量、主进程运行时自动下载兜底与许可声明文档同步更新。另修复 `build-python.js` 的 `COPY_EXCLUDE_NAMES` 定义位于首次调用之后的暂时性死区问题（本地有旧产物时被掩盖，CI 全新 checkout 首次执行拷贝即崩溃）。
- **缓存统计目录写错（P2-15）**：统计与「清理缓存」指向 `%APPDATA%\yuki\logs`（恒 0），真实日志在 `~/.yuki/logs`。两者一并指向真实目录；parse-*/quark-pan-login 内存会话的磁盘遍历死分支删除；local-thumbs 加条目数上限淘汰（签名直链 key 无限增长的收敛点）。
- **Popular.load 无请求令牌（P3-16）**：`_loading` 旗标下切标签新请求被直接丢弃、旧数据照常回写。改世代令牌模式，迟到响应整体丢弃。
- **data-* 反查选择器失配（P3-17）**：属性经 escHtml 写入、选择器又用 escHtml 后的值查找，源含 `&/'/"/<>` 时处理器静默绑不上。反查统一改 `CSS.escape(原始值)`，与 DOM 解码后的属性值恒匹配。
- **控制面 token 用 `!=` 比较（P3-1）**：与数据面一致改 `hmac.compare_digest`。
- **`_SHARE_CACHE` 无锁（P3-2）/ `play_cache._store` 单例无锁（P3-3）**：补锁，消除并发记账脱节。
- **Kazumi 规则 Cookie 明文落盘（P3-5）**：`~/.yuki/kazumi/cookies.json` 复用 pan_cookies 的 DPAPI/AES-GCM 加密口径，旧明文文件启动时自动迁移重写。
- **`jar_patch` zip 条目名无校验（P3-4）**：拒绝 `..` 段/绝对路径/盘符条目（防御性，原实现不构成实际穿越）。
- **`_DNS_CACHE` 无上限（P3-13）**：512 条触顶重置。**go_proxy 日志输出 file_id 前 80 字符（P3-14）**：改为长度+前 8 字符。
- **`yuki:push-url` 无协议白名单（P3-8）**：file:// 等可直达 mpv，加与 `yuki:play` 同款白名单。**`yuki:pick-cache-dir` 接受任意回传目录（P3-9）**：拒绝 UNC/相对路径并做可写探针。
- **Anime4K 运行时下载仅子串校验（P3-10）**：升级为按 binaries.lock.json 的 sha256 强校验，不符不落盘换镜像；ghfast.top 加速代理保留但置于校验之后。**外部播放器按裸 PID 强杀（P3-11）**：taskkill 前经 PowerShell 校验进程名与启动配置一致，防 PID 复用误杀。
- **SyncPlay TLS 校验可关（P3-7）**：默认 `rejectUnauthorized:true`，自签场景显式 opt-in。**pan-qr.js 死代码删除（P3-23）**：含「把完整 Set-Cookie 打进控制台」的复活即泄露点，删除前 grep 确认零引用。
- **配置轮询堆叠（P3-24）**：`do=configTask` 加快路径（只读状态字典，不进 spider 信号量），信号量被慢源占满时轮询不再堆叠 30s；渲染侧 watchConfigTask 加单飞旗标。**pan_login 回退分支域名过滤**：curl_cffi cookie 收集按 quark/uc 域白名单过滤。**游离定时器清理**：afterPlay/删除重试/空目录清理/kazumi WebDAV 启动拉取/live 状态条等 timer 收拢到可取消持有者，退出统一清理；**ASS 弹幕临时文件**（`%TEMP%/yuki-danmaku-*.ass`，含观看文本）播放结束与退出时清理；**ext-playlists 启动时补一次清理**；**`_notified` 只增不减**随任务移除清理。
- **重试按钮防抖**：播放失败「重试当前线路」600ms 防抖（play() 本身已自带并发自取消）。
- **假绿测试修复（P3-19）**：`test_kazumi_cover_proxy.py`/`test_proxy_http.py` 引用已删除的 `_go_proxy_started`（抑制从未生效，独立跑会真绑 9978/7944/1314）改为真实 stub go_proxy 监听器；`test_q7_fault_injection.py` 端口冲突用例从「测 OS socket 语义」改为真实注入 `start_go_proxy` 启动路径；`test_r8_release_gates.py` 迁移用例从测试体内自证改为走真实 `pan_cookies` 迁移路径；`smoke.py` 顶层 hoststate.configure 收进主入口守卫（spawn 子进程复跑曾掩盖 P1-5），并新增 Worker hoststate 注入断言。
- **新增 `test_security_regressions.py`（33 用例，接入 run_all）**：覆盖 P1-2/P2-10 落盘判定、P1-3 门禁与 HLS token 纪律、P1-4 清理语义、P1-5 注入、P2-1 Host 白名单。
- **`test_runtime_supervisor.py` 慢机余量**：`_call` 默认 deadline 1s→5s（含 Worker 冷启动；高负载下启动屏障超时会覆盖预期错误码），两处墙钟断言接入 `_BUDGET_ASSERT_SLACK` 余量。HEAD 基线即随机复现，与功能修复无关。
- **dex2jar 生命周期测试补桩（CI 假绿）**：`test_dex2jar_lifecycle.py` 在 CI 无 vendor 工具的环境补 `DEX2JAR_JAR` 桩，修复跳过逻辑失效导致的假绿。

## [0.2.4] - 2026-09-18

本轮为全项目代码审查（6 个子代理分模块审查 + 逐条复核）后的修复，共 3 项安全风险、17 项缺陷，并补齐相应的回归门禁。

### Security

- **发版安装包内含真实网盘 Cookie**：`build.files` 以 `python-backend/**/*` 全量收纳，而 electron-builder **不读 `.gitignore`**——被标注「含 cookie 敏感文件，禁止入库」的蜘蛛运行态（`FM/.quark`、`FM/.uc` 含真实夸克/UC 登录 Cookie）与 `.test-runtime/pan_cookies.json` 被原样打进 `app.asar`；asar 不加密，取出无需权限、无需运行程序。打包后后端实际只读 `extraResources` 的 PyInstaller 产物，asar 内那份纯属冗余，现把 `files` 收窄为运行时真正读取的 5 项。afterPack 同时新增敏感文件门禁（按 asar 条目名精确匹配，命中即终止构建，不随 `YUKI_KEEP_SYSTEM_DLLS` 逃生口豁免）——实测对旧泄露产物命中 4 项、对旧 asar 全 1423 条目零误报。**泄露过的 Cookie 需由账号侧吊销，此前产物不应继续分发。**
- **ffmpeg 二进制无完整性校验（供应链）**：`binaries.lock.json` 中 ffmpeg 的 `sha256` 为 `null`，且 `verifyDownload` 在期望值为空时静默跳过，下载后直接解压使用。现锁定 gyan.dev 版本化不可变包（`ffmpeg-9.0.1-essentials_build.zip`，与滚动 `release-essentials` 当前指向一致，故不改变新构建的实际产物）并填入官方哈希；构建脚本与**主进程运行时自动下载**两条路径都改为强制校验、不匹配即删档，缺哈希由静默放行改为硬失败。顺带修正运行时解压未走 System32 bsdtar、PATH 含 Git Bash 时把 `C:\` 盘符冒号误解析成远程主机语法的问题。
- **主窗导航守卫放行任意 http(s)**：`will-navigate` 与自身注释及 `setWindowOpenHandler` 一律 deny 的意图矛盾——主窗是 `file://` 本地页面，渲染层一旦被注入即可把窗口源换成远程站点。改为只放行本应用页面（`parse-window` 加载的就是远程页，两者策略本就应相反）。

### Fixed

- **定时关机入参零校验可致整机立即强制关机**：`yuki:shutdown-timer` 只判 `!minutes || minutes <= 0`，对 `{}` / `'abc'` 恒为 false（NaN 比较永不成立），延时算成 NaN 被 Node 当 1ms → 立刻停播放并下发 `shutdown`；`minutes ≥ 35792` 时延时超过 `2^31-1` 同样被钳成 1ms（设得越远越早关）。现做类型/有限性校验 + 24 小时硬上限，并补 `shutdown /a` 取消通道（原命令一旦下发即无可撤 handle）。
- **播放失败弹窗的两个自助按钮永久无效**：`player.js` 调用的 `openSettingsPanel()` 全仓从未定义（`panels.js` 导出的是 `initSettingsPanel`），且传入的 `'pan'`/`'player'` 也不是合法分类名（实际为 `source`/`system`）；`typeof === 'function'` 守卫让缺失时静默无操作、零日志。网盘 Cookie 过期正是播放失败最常见原因，这等于废掉最关键的自助入口。现补齐实现与分类别名映射，缺失时显式告警，并新增「渲染层 `/* global */` 声明 ↔ 真实定义」一致性门禁（eslint 的 `no-undef` 正是被这类文件头声明采信的）。
- **声明 GBK/GB2312 的苹果 CMS 站点全部失效**：`_parse_xml` 把已按 `apparent_encoding` 解码的 str 再 `encode('utf-8')` 交给 ElementTree，后者仍按文档声明用 GBK 去解 UTF-8 字节，实测抛 `ValueError: multi-byte encodings are not supported`。改为直接传 str（bytes 入参按声明编码解码）。
- **HTTP 重定向响应从不释放，连接池 slot 泄漏**：`fetch_follow_redirects` 以 `stream=True` 取得 3xx 后既不读 body 也不 `close()`，连接永不归还 `pool_maxsize=16` 的池；TVBox 源大量 302 到镜像，命中率高。改为取完 Location 立即关闭，且早于 SSRF 逐跳校验（否则被拦下时又漏一次）。
- **`settings.json` 非原子写可致用户数据整体丢失**：`writeFileSync` 是「truncate → 写入」两阶段，中间崩溃即留下截断的非法 JSON，而 `_load` 的 `catch { return {} }` 把「文件损坏」静默降级成「全新安装」——收藏/历史/统计消失且无从得知。改为 tmp + fsync + rename，解析失败另存 `.corrupt-<ts>` 留证并告警。
- **退出清理遗漏播放列表代理**：`PlaylistProxy.close()`（http.Server + keep-alive agent 池 + sweeper）已实现却全仓零调用，`unref()` 只撤销 event-loop 引用、socket 与监听并未关闭。现接入统一清理序列，并把 `window-all-closed` 的手写子集改为走同一函数（原漏 `hls.cleanup()` 与 `dlTimer`）。
- **SyncPlay ping 定时器只建不销**：全文件 `clearInterval` 出现 0 次，`disconnect()` 与 socket `close` 均不回收，重连 N 次即并行残留 N 个 5s 循环且旧句柄不可追。
- **站点诊断快照并发下自相矛盾**：`SiteHealth` 是每站点一个、进程级共享的可变对象却全字段无锁，实测 12000 次快照采样出现 364 次矛盾组合（`healthy=True` 同时 `consecutiveFailures>0` 等），直接打到诊断页与前端提示。改为 RLock（`mark_healthy` 会转调 `record_failure`，需可重入）+ 一致快照。
- **慢源被熔断器无限冻结**：半开探测**失败**时重新计满 `open_seconds`，与同一函数里取消分支刻意「不重计满窗口」的语义自相矛盾；实际链条是 3 次失败 → 冻 60s → 放行 1 探测 → 又超时 → 再冻 60s，用户浏览期间几乎打不开该源。改为短退避（默认 5s）。
- **Worker 回收失败进入不可恢复活锁**：`_dispose_locked` 杀进程失败后把半死句柄塞回 `self._process`，而 `_connection` 已置 None，于是每次请求都重试杀同一个杀不掉的进程。改为请求路径快速失败（计入熔断自动降温），句柄留给 `destroy()`/atexit 做最后一次回收，残留 pid 暴露到诊断快照。
- **同站点并发请求互相污染诊断标识**：`Runner`/`SupervisedRunner` 把 `last_request_id` 存成 Site 级单例的普通实例属性，「最后写入者获胜」与任何在执行中的请求无关（A 超时后按它排障会指到 B）。改为线程本地记录。
- **夸克扫码登录在打包版静默不可用**：`curl_cffi`/`qrcode`（及其 PNG 工厂所需 `pillow`）被生产代码 import 却未进锁文件，本地靠 venv 残留才「看起来正常」，CI 全新构建的产物会缺包；而三者都是惰性 import + 缺失即优雅降级，打包期根本不报错。现补入锁文件、纳入构建导入守卫，并显式 `--hidden-import qrcode.image.pil`（entry-point 动态工厂，PyInstaller 静态分析抓不到）。
- **mpv 一次瞬时错误即让整会话无法播放**：单次 ENOENT/EACCES（杀软占用、文件锁、UAC 抖动）就把 `binary` 永久置 null，唯一恢复点是用户手开设置页。改为延迟重探自愈。
- **推送服务超限请求挂死**：请求体超 64KB 时只 `req.destroy()`，`end` 不再触发、响应永不写出。改为先回 413 再断开。
- **聚合搜索离开页面后 SSE 不关闭**：`Search.stop()` 已实现却零调用，用户在结果未返回完时切走，仍会向隐藏容器追加卡片并触发封面补拉。接入新增的视图离开钩子；点到详情页属「看一眼再返回」主流程，特意不掐流以免逼用户重搜。
- 另含 `showSetCat` 缺判空（抛错会连带吞掉快捷键回填等后续初始化）、`_bgmMatchCache` 无容量上限（持久化侧早有 `slice(-500)`，唯独内存 Map 只增不减）、`_SAVE_CACHE_MAX` 定义后全文件零引用致缓存无界增长且每次写入全量落盘、JS 模块二级缓存无上限无锁（×8 Worker 进程放大）等修复。
- **重启/更新后自定义下载目录失效（表现为「被还原」）**：下载页轮询的 `listAll` 曾在引擎尚未启动时以空目录拉起 aria2，`Downloader.start` 对空目录回退系统「下载」目录并缓存就绪句柄，其后按设置目录的启动调用被直接复用忽略——整个会话的下载都落回系统下载目录（设置值本身并未丢失，更新重启恰好触发该场景）。现在 `listAll` 不再代拉未启动的引擎，仅保留崩溃自愈的原位重拉；「新建下载」「种子文件」两处引擎拉起也补上设置目录兜底。
- **下载产物文件名带影片名**：番剧子目录布局的文件名从「第N集.mp4」改为「剧名 - 第N集.mp4」（仅新任务生效，存量文件不动）——产物离开 `<剧名>/` 子目录（复制、移动、外部播放器历史记录）后不再丢失影片名；集名本身已含剧名或单集影片不重复前缀，下载列表展示判重同步适配。超长剧名触到段长上限时只截短剧名前缀、保留尾部集名，避免同剧多集被截成同名互相覆盖；剧名+连接符完全放不下时放弃前缀保住集名。

### Tests

- **`api-contract.test.js` 从同义反复改写为真实契约测试**：原 19 条用例全部在断言测试自己内联的常量/正则/假实现（零 require 任何 `src/` 模块）——白名单被放宽、路径遍历校验改成恒真，它们依然 100% 通过，回归发现能力为零。现 18 条全部作用在真实源码行为上：vm 加载 `index.js` 并桩化 electron 与本地服务后调用真实 IPC handler（54 个 handler 注册进桩）、直接 require `settings`/`downloader`/`hls-downloader`/`file-manager` 实测落盘与路径遍历、vm 加载 `player.js` 裸调真实 `_onExit` 验证 quit 语义。每条断言都做了突变测试验收（禁用真实校验 → 对应用例变红）。删除 2 条无真实承载者的用例（`watchStats` 初始结构属渲染层 UI 内部对象、`TOKEN_EXEMPT` 属 Python 侧管辖），去向在文件尾注释说明。运行时行为零改动（`src/` 无该任务产生的 diff）。
- 4 个从未接入回归的 Python 测试（`test_circuit` / `test_all_runtimes_contract` / `test_quark_session_refresh` / `test_config_compat_offline`）注册进 `run_all.py`，并新增 `_check_stage_coverage()` 门禁：`tests/test_*.py` 既未接入 STAGES 又不在 `EXEMPT_TESTS` 即判失败（`run_all.py` 本就写着「不接入的话文件损坏不会惊动任何人——2026-09 就发生过一次」，现改为机器检查）。编译门禁不再排除整个 `tests/`，覆盖 **110 → 175** 文件。
- `download-remove.test.js` 的断言原先写在**未被 await 的 `.then()`** 里，用例永远打 ✔（实测把期望值改成错误字符串仍报 pass）；改为 async + await，并新增静态门禁拦截同类写法（按花括号配对取回调体、剥离注释与字符串，避免把 `return ...then()` 这种 node:test 会等待的正常用法误判）。
- 5 处「环境不满足即 `return`」的静默跳过（唯一验证真杀 ffmpeg 进程的 `hls-cleanup` 用例在 CI 上必然不跑却计为通过等）改为 node:test `skip`，并在 `run-jsunit.js` 汇总中显式告警跳过数。
- CI 补 `npm run lint`（此前 CI 从不跑 eslint，`no-undef` 形同虚设）、`permissions: contents: read`、`concurrency`、`timeout-minutes`；`pnpm-workspace.yaml` 的 `allowBuilds` 是无效字段（pnpm 静默忽略）改为 `onlyBuiltDependencies`。
- 新增 `test_health_concurrency.py`（含无锁孪生对照实现，锁被删除时会变红）、`test_cms_xml_encoding.py`、`renderer-globals-contract.test.js`、`test-effectiveness.test.js`；`test_circuit.py` 补半开退避语义用例。JS 用例 534 → 541，Python 阶段 51 → 57。

## [0.2.4-rev1] - 2026-09-17

继续消除安装过程杀软拦截：安装包不再随带任何系统同名 DLL 副本。

### Changed

- **杀软拦截面清零**：在 v0.2.3 剔除 `vulkan-1.dll` 的基础上，afterPack 同时剔除 PyInstaller 捆绑的 `VCRUNTIME140.dll` / `VCRUNTIME140_1.dll`——未签名安装包向用户目录写入系统同名 DLL 是火绒/360 行为拦截的高频触发点（v0.2.3 安装时仍被拦截的正是这两个文件）。后端 `python314.dll` 对 VC++ 2015-2022 运行库的真实依赖改为使用系统安装副本。

### Fixed

- **运行库缺失引导**：打包版 Windows 启动后端前预检系统 `vcruntime140*.dll`；缺失时不再 spawn 后端（避免 Windows「找不到 DLL」系统错误弹窗与退避重启死循环），改为弹窗引导从微软官方地址安装 VC++ 运行库，安装后重启应用自动恢复。

## [0.2.3] - 2026-09-17

修复 v0.2.2 发布产物问题：安装包内后端缺依赖导致无法启动、安装过程杀软拦截误报面。

### Fixed

- **安装包后端缺运行时依赖（打开即报 `ModuleNotFoundError: No module named 'fastapi'`）**：CI 发布流水线在全新 venv 里只安装 PyInstaller 工具链、未安装后端运行时依赖，PyInstaller 对缺失导入只告警不失败，冻结产物静默缺包。`build-python` 现按 `requirements-build.txt` 与 `requirements.txt` 双锁文件校准构建环境，并在打包前用同一解释器做导入守卫（缺包立即失败，不再产出坏包）。
- **安装过程杀软拦截**：未签名安装包写入系统同名 DLL 触发杀软（如火绒）行为拦截。afterPack 新增剔除 Electron 自带的冗余 `vulkan-1.dll`（Windows 上 ANGLE 默认走 D3D11，应用代码零引用），与既有 d3dcompiler/UCRT 剔除同策略；`VCRUNTIME140*.dll` 为 `python314.dll` 真实导入且系统不保证自带，仍保留（被拦截时回退系统副本，不影响运行）。

## [0.2.2] - 2026-09-17

规划特性落地（RM-1/2/4/5）、Bangumi 镜像域切换与安全加固，并修复安装包杀软误报与下载列表展示名。

### Added

- **Bangumi 镜像域名手动替换**：设置 → 系统「网络」新增「Bangumi 镜像域名」输入与保存——镜像站域名失效时填入新的根域名即可整体切换（子域自动映射：`api.bgm.tv` → `api.<根域名>`，`lain`/`next`/`fast`/`doujin` 同理），封面兜底镜像与鉴权接口基址即时生效；支持粘贴完整 URL 自动归一化，非法域名拒绝保存；根域名随本地设置与 `%APPDATA%/yuki/kazumi/mirror.json` 持久化，后端重启自动恢复。
- **Bangumi 观看进度自动上报**（RM-5）：看完一集自动把该集在 Bangumi 标记「看过」，未收藏/想看的条目自动加入「在看」，看完全部本篇分集自动把收藏升级「看过」（搁置/抛弃不改动），对标 Animeko 云同步进度——逐集会话与原生连播队列两条看完链路全覆盖，跳看/中途退出/外部播放器不上报。设置 → Kazumi 规则 → Bangumi 同步新增「看完自动上报观看进度」开关（默认关）；分集匹配按集数（第N集/EP N/Episode N/纯数字）优先、分集名精确兜底，只认本篇分集，匹配不到宁缺勿错标；无 Token / 匹配不到条目静默跳过，失败提醒 5 分钟节流，上报全程不阻塞播放。
- **解析结果持久缓存**（RM-4）：重开同一集或重启应用后跳过查源直接起播（单次解析实测 2~5s），对标 Animeko 6.1.0「在线源查询缓存」——`playerContent` 稳定结果按「站点+线路+集」落盘持久缓存（TTL 2h、容量 16MB），与既有 60s 内存缓存、播放列表代理会话缓存构成三级供数；带签名时效的网盘/CDN 地址不入缓存（读写双侧过滤）；「立即重试」等 refresh 请求同时淘汰内存与持久层，保证拿到重新查源的结果。配套失效自愈：播放地址起播即失败时自动刷新重解析一次，TTL 内源站侧失效的缓存直链不再表现为播放失败。缓存随「设置 → 缓存 → 清理缓存」一并清空，占用计入缓存统计。
- **应用内 GitHub 检测更新**（RM-2）：打包版应用内可检测 GitHub Releases 新版本——设置 → 系统「软件更新」卡片提供当前版本、自动下载开关（默认关：启动静默检查发现新版本仅提醒、手动下载；开：静默下载 + 退出安装）、「更新通知」开关（默认开：启动检查发现新版本时弹窗提示并可一键下载，自动下载更新开启时为静默下载、不弹窗）、立即检查/下载更新/重启并安装按钮与状态行（更新失败原因只截断展示首行，不再整串透传）；新增手动检查/下载/安装 IPC（开发模式返回明确 development 语义）；package.json 补 GitHub publish 配置，release CI 随安装包上传 `latest.yml` 与 `.exe.blockmap` 更新元数据（Draft Release publish 后才对用户可见）。
- **下载自动创建番剧文件夹**（RM-1）：同一部作品的下载集数自动落「下载目录/番剧名/」子文件夹、文件以集名命名，不再全部平铺在下载根目录——aria2 直链/磁链任务经任务级 `dir` 选项落子目录，m3u8 合成产物与分片临时目录一并入内；边下边播逐集链此前所有集共用「剧名.ext」文件名会互相覆盖，现也改为集名入夹。设置 → 下载新增「按番剧创建文件夹」开关（默认开，仅新任务生效、存量文件不迁移）；番剧名/集名经 Windows 路径段清洗（非法字符、保留设备名、尾点尾空格、80 字符截断）；更换下载目录迁移保持两级结构、断点续传（`.aria2` 控制文件随迁）与重启后恢复入队均落回原子目录；删除任务后空的番剧子目录自动清理；无剧名上下文的下载页手输 URL 维持平铺。

### Changed

- **Bangumi 镜像根域名切换 bangumi.pro → bangumi.vip**：bangumi.pro 域名已失效，全域名反代镜像整体切换为 bangumi.vip（`api.bgm.tv` → `api.bangumi.vip`、`next.bgm.tv` → `next.bangumi.vip`，lain/next/fast/doujin 子域一一对应）；封面兜底镜像同步切至 `lain.bangumi.vip`，历史镜像 `lain.bangumi.pro` 保留在封面代理白名单中以兼容存量记录（失败自动落到当前镜像域）。实测镜像各子域均在 Cloudflare 后且拦截程序化 UA（okhttp/裸应用 UA 一律 403 挑战页），Bangumi 请求 UA 统一改为浏览器前缀 + 应用标识（`…Chrome/126.0 Safari/537.36 yuki/0.1.0`，官方与镜像双兼容），封面代理转发同步携带该 UA。
- **Bangumi 同步开关改名**：设置 → Bangumi 同步的「非 Kazumi 源详情页自动匹配 Bangumi 数据」更名为「CatVod 源详情页自动匹配 Bangumi 数据」，仅界面文案调整，功能与设置键（`catvodBgmMatch`）不变。

### Security

- **局域网推送 token 改用加密随机源**：推送接收服务的 token 由 `Math.random()`（可预测）改为 `crypto.randomBytes` 生成，避免局域网内猜测 token 后向本机播放器推送任意 URL。
- **验证码窗口补齐导航守卫**：验证码验证窗口与隐藏解析窗口对齐——非 http(s) scheme 的页内跳转（如 `intent://`）一律拦截不再移交系统，新开窗口改为 http(s) 转系统浏览器、其余拒绝，堵住验证页脚本拉起外部协议的口子。
- **远程代码源完整性告警**：jar 与 Python spider 源为明文 http 或未附带 md5 校验时记醒目告警日志（该类内容会被当代码执行，存在被篡改/MITM 风险；不拒绝加载以兼容存量配置；同一源每进程只记一次，避免几十个站点共用一个 jar 时刷屏）。

### Fixed

- **下载列表卡片恢复显示影片名**：RM-1 番剧子目录布局上线后，下载产物改为 `<下载目录>/剧名/第N集.mp4` 落盘，而下载列表/完成通知只显示文件名，卡片因此只剩「第N集」看不出是哪部作品。现列表推送、完成/失败通知与系统通知按产物所在番剧子目录推导展示名「剧名 - 第N集」（纯展示层补全：磁盘文件名、去重、断点续传与重启恢复入队均不受影响）；单集影片（文件主名 === 剧名）与集名缺失时落进子目录的旧「剧名 - xxx」命名不重复前缀，平铺任务与 BT 多级目录保持原名。
- **安装包剔除系统自带冗余 DLL（杀软误报源）**：360 等杀软会在安装时对包内两类文件报「程序试图修改关键程序 DLL」（已知误报）——Electron 自带的 `d3dcompiler_47.dll`，与 PyInstaller 后端捆绑的 UCRT（`yuki-backend/_internal/` 下的 `ucrtbase.dll` 及 44 个 `api-ms-win-*` API-Set 转发器）。二者在 Win10+ 均由系统 System32 / API Set 加载器直接提供，包内副本仅为 Win7/8 兼容存在（Electron 31 本就不支持）；而 `VCRUNTIME140*.dll` 系统不保证自带、`python314.dll` 为解释器本体，均保留——新增 electron-builder `afterPack` 钩子（`scripts/after-pack.js`）在 NSIS 打包前剔除前两类（共 44 个、约 7MB），安装包不再含杀软误报源；`YUKI_KEEP_SYSTEM_DLLS=1` 可保留全部便于诊断对比。
- **Bangumi 网络引导空态样式统一**：推荐/时间表页「暂无内容（网络无法访问 Bangumi）」引导原本是三段兄弟节点直接落进卡片网格——各占一个 172px 窄列、12/13px 字号混用、正文色与次级色混用、对齐方式也不一致。现改为单根节点 `.bangumi-net-guide` 占满网格一行，渲染成与其它「暂无内容」空态一致的虚线卡，三段文案统一 12px 次级色（大屏随既有规则放大），隐私说明段左对齐并以分隔线区分，开关名仅加粗强调。同类修正：本地文件页「尚未选择根目录」引导的提示与按钮对齐方式统一为居中，夸克扫码弹窗「正在打开登录窗口…」占位字号对齐同弹窗提示行的 12px。
- **测试宿主端口向 spawn 子进程的确定性传递**：smoke/test_phase3 的随机端口回退（8321/8322 被占用或落入 Windows 保留区间时改绑系统空闲端口）会在 multiprocessing spawn 的 worker 子进程重跑模块顶层时**重新求值**，worker 侧 hoststate 被配成与宿主不同的端口，demo spider 的 HTTP 回环（setCache/getCache/proxy）全部打到死端口导致 smoke 阶段必挂。现改为父进程选定端口后写入 `YUKI_PORT`，子进程重跑顶层时优先复用继承的环境变量，端口父子确定一致。
- **Python spider 落盘原子写**：删除无调用方的宿主内加载入口 `_load_python_spider`（连带其中已废弃的 `load_module` 用法）；建站 materialize 改为临时文件 + `os.replace` 原子写，杜绝并发 materialize / 子进程 import 读到半成品文件（内容 sha256 目录隔离为既有机制，保持不变）。
- **播放列表清单缓存惰性清理**：`playlist-proxy` 清单缓存改为写入时顺手淘汰过期项（命中 TTL 与淘汰阈值统一为 `MANIFEST_CACHE_TTL_MS`），修复长会话反复切集时缓存单调增长。

## [0.2.1] - 2026-08-31

角色卡片 CV 展示、时间表加载遮罩与下载完成通知开关。

### Added

- **角色卡片加入 CV**：详情页角色卡片与 Kazumi 角色列表在名字下方新增 CV（声优）一行——Bangumi v0 接口按 `actors` 数组取中文名（无译名回落原名），多位用「/」连接，兼容部分镜像的 `actor` 字符串字段；无 CV 不渲染该行，窄窗下与角色名共用溢出兜底。
- **时间表加载遮罩**：时间表页无缓存命中时弹出加载遮罩（对齐首页防闪现模式：延迟 300ms 弹出，响应快则直接上屏不闪）；缓存命中仍即时上屏、后台静默刷新不打断已见内容。
- **下载完成通知开关**：「设置 → 下载」新增「下载完成通知」开关（默认开）——关闭后 aria2 与 m3u8 合成完成不再弹系统通知，下载页内的完成提示不受影响；同时修复设置写入键白名单遗漏 `dlNotify` 导致开关静默失效的问题。

## [0.2.0] - 2026-08-26

UI 视觉系统升级、壁纸自定义与网盘源播放策略收敛。

### Added

- **背景图自定义调整**：选择背景图片后弹出自定义弹窗——预览框按住拖动定位、缩放/透明度/模糊三滑杆即时联动（预览与实际壁纸层共用同一套 CSS 变量数学，所见即所得），保存才落盘生效；遮罩强度新增「极弱（接近透明）」档位，滑杆值恰为离散档位时自动归位到下拉选项。
- **外部播放器观看统计与历史**：PotPlayer/VLC 等外部播放进程退出后按运行时长（墙钟秒数，口径同 mpv 的 wallWatched）计入观看统计、最近观看与播放历史（≥15s 记一次，短播/VLC 单实例秒退不计）；主播放链（整季 m3u 队列/单集）、播放弹窗按钮与直链播放三条入口全覆盖，统计写入复用渲染层 `_writeWatch` 单一出处（隐身模式/统计开关照常生效）
- **原生队列 × 边下边播**：队列模式下每集解析成功即静默入队下载（去重键与手动一致，Kazumi 自动携带规则头）；开启边下边播不再让路，队列起播失败仍自动回退逐集模式
- **Kazumi 勾选集播放**：Bangumi 分集页签勾选 → 选源选线路后，播放器队列仅包含勾选子集（Bangumi 集名优先、规则 identifier 兜底）
- **外部 mpv 原生配置模式**：组件状态手动指定的自定义 mpv（如 mpv.lite）不注入 YuKi 外观资源（提示脚本/生成键位/中文菜单/字体），OSD 完全使用其自身配置；恢复默认自动切回引擎样式
- **原生播放列表与边下边播**：在线整季映射为本地按需解析代理地址（`playlist-proxy`，mpv 打开哪一集才解析哪一集，302 交给真实 CDN，直链零过期），静态直链批量走 mpv 进程内原生连播；观看统计/历史改为队列逐集 `ended` 记账（每集独立观看链）。
- **同源同集下载去重**：以「站点 | 剧名 | 集名」为稳定 key 登记（`dl-dedupe`），手动下载命中进行中/已完成任务时跳过并提示，边下边播注册静默去重，修复重播/续播重复建下载任务。
- **mpv 右键中文菜单**：译制 `menu.conf` 注入内置播放器（mpv 官方不做界面本地化），播放/打开/轨道/输出等右键项全部中文。
- **Anime4K 快捷键**：`K` 键循环三档位、右键菜单勾选态同步；档位切换运行时替换着色器链（无需重启播放器），持久化设置并与设置页控件双向同步。
- **上/下一集快捷键**：`PGUP` / `PGDWN` 在逐集会话中按当前线路推集。
- **夸克会话自动续期**：捕获服务端 `Set-Cookie` 轮换并在清 jar 前合并回加密存储；低频（6h ± 抖动）保活探针维持会话活跃，412 风控自愈评估。
- **Bangumi 分页聚合**：收藏/时间表拉取自动翻页补足单次总量（页间限速防风控，单页钳制 50），修复每页数量 60/120 设置下整页空白。

### Changed

- **UI 视觉系统升级**：按新增的 [DESIGN.md](DESIGN.md) 视觉契约整体重制 `ui.css`——中性灰阶做骨架、主题色只做点睛（默认绿改祖母绿系），一切派生色用 `color-mix` 现场计算（自定义取色器照常生效）；圆角/描边/阴影/动效令牌化，渐变底 + 微噪点质感；卡片入场错峰、悬浮抬升与按压反馈动效；网格空态 CSS 骨架屏。动画只动 transform/opacity，尊重 `prefers-reduced-motion` 与应用内动画开关。
- **壁纸渲染层重构**：壁纸图改经 `--wall-url` 变量只进 `body.has-wallpaper::before` 单层按视口缩放绘制，修复旧版 body 平铺铺图在大分辨率视口下「壁纸没铺满屏幕」；`wallpaperAdjust`（定位/缩放/模糊/透明度）纳入设置持久化与 WebDAV 同步白名单。
- **WebDAV 同步远程目录默认值**：`kazumiSync` → `YuKiSync`（后端 `WEBDAV_SYNC_ROOT` 与设置页文案同步）。**升级提示**：旧版本备份位于远程 `/kazumiSync`，升级后如需继续读写旧备份，请在「设置 → WebDAV → 远程目录」手动填回 `kazumiSync`；新备份默认写入 `/YuKiSync`。

### Fixed

- **夸克网盘「转存失败」**：接口身份统一为夸克 PC 客户端 UA——写操作（sharepage/save 转存）按客户端签名做风控，普通 Chrome UA 读接口可过、转存必回 HTTP 403；取流下载与签名请求保持同一 UA 防止 412；分享接口域名切 `drive-pc.quark.cn`。新增 `_QuarkSaveDenied` 语义化拒绝：HTTP 401/403（业务码 ≠41020）判不可自愈硬拒绝立即上抛不再重试（避免密集 save 把临时风控打成持续 403），code=41020「token 校验异常」识别为快照令牌过期走实时目录树换新令牌重转存；失败响应带语义化中文提示（今日转存额度/风控）。
- **网盘源播放策略收敛**：网盘类源（夸克/UC/阿里/115/123/天翼/移动等）全局禁用原生播放列表——新增 `src/main/pan-source.js` 统一判定（主进程拒建队 → 渲染层静默回退逐集连播，外部主播放器整季 m3u 同源拦截自然退化为单条目直启；Kazumi 规则引擎豁免防误伤），并对网盘源禁用自动线路回退——网盘解析失败多为 Cookie 失效/夸克风控，自动换线只会叠加完整链路重试放大风控。
- **直播外部播放器误报失败**：外部主播放器起播成功返回 `{launched:true, viaExternal:true}`（分离进程无回执可校验），直播页按 launched 判定不再落入失败分支弹「直播播放失败」，提示改为「已交外部播放器播放」。
- 全部窗口关闭输入框拼写检查红波浪线（主窗口/网盘扫码登录窗/解析窗口 `spellcheck:false`）；网盘 Cookie 与 WebDAV 密码的眼睛图标随明文状态切换。
- **播放列表标题与集数**：Bangumi 跨季全局序号改用每季集数字段（修复“第101集”）；抓流/清单临时文件名混入集名时统一回落「第N集」；窗口标题改为装载时经 IPC 直写并强制 `force-media-title`（不再被流内嵌 metadata 覆盖成片名）。
- **外部 mpv 播放 Kazumi**：交给外部播放器的本地抓流清单改为代理直读回传（此前 302 会被 mpv 当播放列表二次展开，分片变条目、标题全是文件名）。
- **首页加载遮罩闪现**：缓存命中路径延迟 250ms 上遮罩并可取消，秒开场景不再短暂显示“加载中”。
- **临时清单清理**：启动时无条件清扫 %TEMP% 下队列/抓流残留 m3u8，杜绝旧文件被当作集数展开。
- **WebDAV 恢复假成功**：后端逐文件吞异常、空数据恒当成功——改为返回 `{files, ok, error}` 结构化结果，连接错误/非 404 HTTP 错误判失败并透出原因。
- **历史页 Kazumi 封面拉取失败**：搜索点击回填的残缺匹配条目被当完整命中永久短路且跨重启持久化——完整命中要求 id+封面齐全，残缺条目按 id 自愈并过滤毒缓存。
- **切换分类报 L3 运行时错误**：前端切分类时中止在途请求（原令牌只丢弃渲染结果，请求风暴触发上游限流），失败包络 800ms 后自动重试一次；后端对连接类瞬时错误退避重试。
- **打包版资源定位**：冻结入口/只读目录下的 Python 后端与二进制发现修复（宿主状态探测模块 + 资源根解析），覆盖安装后冷启动路径。
- **下载管理**：任务卡片稳定排序（aria2 分组拼接序抖动）、排序下拉持久化、删除任务三选弹窗、完成播放文件未找到多级兜底、更换/恢复目录迁移在途任务断点续传。

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

- 移除画中画入口；界面统一使用系统字体；「关于」迁入设置一级分类。
- （0.1.0 时移除的 MiSans 动态下载已于 0.2.x T61 改回为**打包内置**，运行时按 `useMisansFont` 开关注入，默认开，无网络下载。）

### 已知边界

- macOS / Linux 打包与安装后冷启动尚未验证，当前仅保证 Windows 平台体验。
- 弹幕界面与播放时弹幕加载处于停用状态；仓库中的 DanDanPlay API 与 ASS 相关代码仅为兼容基础，不代表弹幕功能可用。
- SyncPlay 同步播放与 DLNA 投屏的主进程模块与 IPC 已接线，渲染层界面入口未开放。
- drpy 运行时已实现后又移除（能力路由固定标记不支持），type 15/16 站点（N3 阶段）未实现；需要 Android / Dex 的 JAR 站点在 PC 上不可用。
- 应用内自动更新已接入并随 v0.2.2 起的 Release 流水线生效。
- P2P/P3P、ed2k、thunder 协议不在支持范围。

[unreleased]: https://github.com/Arimayuki03/YuKi/compare/v0.2.5...HEAD
[0.2.5]: https://github.com/Arimayuki03/YuKi/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/Arimayuki03/YuKi/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/Arimayuki03/YuKi/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/Arimayuki03/YuKi/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Arimayuki03/YuKi/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Arimayuki03/YuKi/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Arimayuki03/YuKi/releases/tag/v0.1.0
