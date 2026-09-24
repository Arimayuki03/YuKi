# 更新日志

本项目所有显著变更记录于此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.6] - 2026-09-24

本轮包含 2026-09-22 发布 v0.2.5 之后的四个批次：全项目代码审查修复、功能增强批次与大规模测试补齐，并修复 CI 慢机上的 flaky 测试。

### Added

- **智能跳过片头/片尾**：播放器内 `Shift+O` / `Shift+E` 登记当前时刻为片头/片尾结束点（同片名自动复用），起播按登记位置自动 `--start` 跳过；登记入口与提示接入播放页。
- **Bangumi 评分/吐槽对话框**：详情页可直接为番组提交星级评分与吐槽（复用 `bangumiBangumiSyncApply` 端点透传，含提交状态与失败提示）。
- **CatVod 详情页「开始播放」一键直达**：详情页在解析出选集后提供一键起播按钮，免二次点击。
- **HLS 广告段过滤引擎**：`python-backend/ad_filter.py` 基于 `#EXT-X-DISCONTINUITY` + 跨 host + 路径特征词的组合启发式识别广告分片（宁漏勿错杀），供 HLS 下载链路调用；当前未挂载到在线播放。
- **Kazumi 图片验证码识别模块骨架**：`python-backend/kazumi/captcha.py`（ddddocr 优先、可降级），预留接口暂未挂载。
- **IPC 可信发送方判定加固**：`senderFrame` 判定加 `sender.getURL()` 兜底，拒绝日志携带双 URL 现场便于排查。

### Fixed

- **capability_router：省略 type 的 csp_/JAR 仓整仓判死**：TVBox 手写仓常见「不写 type 但 api 为 csp_ 前缀/指向 JAR」的条目此前被归入未知类型直接跳过，现按 JAR 路由修复菜妮丝等仓不可用的问题；`config.py` 同步支持 spider 列表/分号多值写法解析。
- **jar_bridge 非字典 JSON 帧致读线程死亡**：`_on_line` 对非 dict 帧补 `isinstance` 校验，防止一个坏帧杀死读线程、后续 pending 调用全部被误拒。
- **hls-downloader completed 监听器异常兜底**：监听器异常不再冒泡崩溃、不再误判失败触发重下。
- **pan-qr-window 建窗失败残留**：初始化失败时清理残留窗口与定时器、复位可重试。
- **mpv-player**：弹幕轨装载门控保持默认关、watch-later 续播位置守卫、在线源统一预缓冲。
- **renderer/search**：快速搜索未展示时的失败/不可用提示改走 warnToast（不再静默）。

### Security

- 代码审查收口批次（d16d35f，17 条 High 与主要 Medium/Low）：go_proxy 分段流强制 206+Content-Range 校验与截断、kazumi 规则引擎逐跳 SSRF 守卫与重定向逐跳重派生 Cookie、cookie 仅同域附带、http_client 云元数据红线、JAR 默认强制 https+md5 校验（`YUKI_JAR_INSECURE_SOURCES` 可放宽）、`/proxy` 强制 token、supervisor 淘汰有界扫描（修复 while True 霸锁死锁）、弱引用 LRU、熔断区分排队超时、site_worker 方法白名单、DNS rebinding 二次解析缓解、WebDAV 恢复显式允许表、js-engine 多行 import 与循环依赖 fixup 等后端与 Electron 侧成批加固；明细见 `docs/CODE_REVIEW_2026-09-22.md`。

### Tests

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
