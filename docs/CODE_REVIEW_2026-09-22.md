# YuKi 全项目代码审查报告

- 审查日期：2026-09-22
- 审查方式：29 个并行子代理分模块审查（open-code-review 委托模式精神，工作区无未提交 diff，故审全量源码）
- 覆盖范围：src/main（28 文件）、src/preload、src/renderer（HTML/CSS/19 个 JS）、python-backend（源码 + 66 个测试文件）、tests/js（58 文件）、scripts、docs（17 份文档）
- 基线：main @ 26a3d77

## 总览

子代理原始上报合计：**316 条**（critical 0 / high 30 / medium 115 / low 171）。本文 High 按 17 个条目呈现（部分相近发现合并，如同一模式多处、同域多文件）；Medium 按域分组收录全部要点；Low 择要收录。

| 严重度 | 原始数量 | 说明 |
|---|---|---|
| critical | 0 | 未发现 |
| high | 30 | 崩溃/功能失效/安全边界缺口/假测试 |
| medium | 115 | 竞态、泄漏、静默失败、性能 |
| low | 171 | 边界情况、死代码、可维护性 |

各模块子代理均做了上下游交叉验证；XSS 转义（escHtml）、IPC sender 校验、路径穿越防护、子进程 argv 传参等整体防线经多条线独立确认基本到位。

---

## High（17 条）

### 崩溃 / 主进程稳定性

1. **`src/main/hls-downloader.js:594-597`**（627-630、750-753、815-818 同模式）[bug] 合并完成后的 `fs.renameSync(part, task._dest)` 位于 ffmpeg 'exit' 回调内且无 try/catch：Windows 目标文件被占用（播放器在播旧文件）或保留设备名时 EPERM 直接打崩主进程 → 包 try/catch，失败保留 .incomplete 按错误终态处理。
2. **`src/main/python-bridge.js:98-148`** [bug] spawn 后端 exe 未挂 `proc.on('error')`：打包版后端缺失或开发机无 python 时 ENOENT 触发未处理 error 事件崩溃主进程 → 补 error 处理并入重启/状态上报。
3. **`scripts/download-binaries.js:104-131`** [bug] download() 未监听响应流 error：require 模式（主进程一键补装）下载中断打崩 Electron 主进程 → 补 `rsp.on('error', reject)` 并 destroy 流。

### 功能失效（播放/下载链路）

4. **`src/main/playlist-proxy.js:391-405`** [bug] 直链 403/410 重解析机制不可达：`_pipeRemote` 所有返回路径均已 writeHead，回到 `_serveResolved` 时 `headersSent` 恒 true，`_reresolveEntry` 整条修复链是死代码，播放中签名过期即断流 → 在 `_passthrough` 前判定状态码重试。
5. **`src/main/playlist-proxy.js:130-135`** [bug] 会话 TTL 2h 按 createdAt 硬删、无活跃续期：pipe 模式播放超 2 小时 `/pl`、`/seg` 全 404 静默断流 → 命中刷新 lastAccess，只清不活跃会话。
6. **`python-backend/go_proxy.py:1363-1374`** [bug] `_SegStream._dl` 接受 HTTP 200 且不按段长截断、不校验 206 Content-Range：上游忽略 Range 时输出 n 倍重复数据/字节错乱 → 对齐 `_stream_single` 要求 206+区间校验+截断。
7. **`python-backend/go_proxy.py:1669-1685,2031-2045`** [bug] HLS 重写仅在 total 未知分支执行：Range 探测返回 206+Content-Range 时（nginx CDN 常态）跳过 m3u8 重写直接透传，相对分片 404/缺凭据被拒 → 先判 `_is_hls_ctype` 再决定重写。
8. **`python-backend/js-engine/module_resolver.py:23,63-75`** [bug] `_RE_IMPORT_FROM` 无 DOTALL：多行命名 `import {...}` 匹配不到，esm_transform 剥掉 import 后运行时 ReferenceError，站点静默不可用 → 跨行匹配。

### 安全边界

9. **`python-backend/kazumi/rule_engine.py:142-172`** [security] 规则驱动的请求完全未过 SSRF 守卫（baseURL/searchURL/API url 可指内网，requests 自动跟 302 跳内网）→ 每跳套 `_guard_hop/guard_url`、手动跟跳。
10. **`python-backend/kazumi/cookie_jar.py:92-109`** [security] cookie_header() 按父域匹配任意 URL 附带 Cookie（含 webview 验证会话），配合规则可控 URL 可被第三方规则源窃取 → 仅对规则自身 base_url 同域附带。
11. **`python-backend/jar_bridge.py:519-543`** [security] JAR 在 JVM 内任意代码执行，现有校验仅魔数+可选 md5+明文 http 仅告警：MITM/篡改即 RCE，无签名/固定 → 严格模式强制 https+md5 或签名校验。
12. **`python-backend/http_client.py:168-177`** [security] get/post 基础入口无 SSRF 校验，唯一有守卫的 fetch_follow_redirects 默认也放行内网（allow_private_network 默认 True）→ 基础入口加守卫钩子，默认拒绝 loopback 高危端口。

### 前端数据错位

13. **`src/renderer/js/home.js:957-1001`** [bug] 切源后 feed 首拉失败包络早退返回上一源的 `_homeList` 直接渲染：显示旧源影片、详情用新 site+旧 vod_id 查询必错位 → loadHome 入口清空或记录归属 site。
14. **`src/renderer/js/timeline.js:409-491`** [bug] load/_loadCurrent/_loadSeason 无请求令牌：快速切换季度旧响应覆盖新数据，共享 `_maskShown` 的 finally 提前隐藏新请求遮罩 → 仿 home.js 加 `_loadToken`。

### 测试可信度（假测试，改坏全绿）

15. **`tests/js/timeline-filter.test.js:6-114`、`tests/js/hls-concurrent.test.js:8-135`、`tests/js/download-remove.test.js:12-84`** [test] 四组用例内联复刻被测逻辑，从不加载真实源码：`_parsePlaylist`/`_concatSegments`/`mergeLocalCollections`/`clearFailed` 等实现改坏测试依旧全绿 → vm 加载真实代码直测。
16. **`python-backend/tests/test_kazumi.py:514-526`** [bug] 还原目标写错：patch 的是 `http_client.get` 却还原到 `requests.get`，http_client.get 永久停在 fake 上且污染全局 → 修正还原目标或用 mock.patch。
17. **`docs/GUIDE.md:225-226` + `README.md:179`** [documentation] 文档称弹幕开关"预留无效/不发起弹幕网络请求"，实测该开关是真实功能：`player.js:642` 起播后 `_maybeLoadDanmaku` → `Kazumi.loadDanmaku`（kazumi.js:2488）→ 后端弹弹play API。但请求以凭据为门槛：后端 `_dandan_creds()`（plugin_manager.py:1703）无 AppId/Secret 时直接返回空且**不发出外网请求**，凭据由用户在设置页自填（无内置 key），经主进程注入环境变量（index.js:2414-2417）。准确口径应为："开关默认关闭；开启**且已在设置中填入 DanDanPlay AppId/AppSecret** 后，播放时会请求弹弹play API 加载弹幕"。

---

## Medium（68 条，按域分组）

### 主进程（Electron）

- `mpv-player.js:562-564,713-715` 旧会话延迟退出时 exit 处理器无条件删共享 assPath，快速 stop→play 弹幕文件被删且 sub-add 静默失败 → 按 sessionId 守卫。
- `mpv-player.js:435-455` nativeQueue 缺 url 条目被 buildM3u 跳过但下标/标题映射仍按原数组：错播集数/越界 → 按 m3u 实际条目重映射。
- `hls-downloader.js:144-155` migrateDir 跨盘移动走同步拷贝回退，GB 级视频冻结主进程数分钟 → 异步分批迁移。
- `hls-downloader.js:591-604` _concat exit 回调缺 `removed` 检查，remove 后重试链再 spawn 两个注定失败的 ffmpeg → 补 removed/gen 检查。
- `hls-downloader.js:335-350` 同名并发任务互覆盖 `_dest` 与 adfilter 临时文件 → adTemp 并入 gid、同名 add 检测。
- `hls-downloader.js:179-186` kill 后立即 renameSync，Windows 句柄未释放迁移失败 → 延迟/重试迁移。
- `downloader.js:371` flatten 的 decodeURIComponent 遇裸 `%` 抛 URIError，毒任务无法删除，下载页持续不可用 → try/catch 回退原串。
- `playlist-proxy.js:287-300,574-580` `/seg` 接受任意上游地址并无条件附带会话鉴权头（Cookie/Referer）→ 上游域名白名单、跨域剥离 Cookie。
- `playlist-proxy.js:411-456` isLocal 分支对源返回的 file:///盘符/UNC 无白名单即回读，可读本地任意文件 → 限定抓流产物目录前缀。
- `playlist-proxy.js:250-258` catvod 预取实际全量并发（注释称限流 4），最坏 ~25s 撞渲染层 20s 竞速 → 并发窗口。
- `playlist-proxy.js:193-195` MAX_SESSIONS 淘汰最旧不看活跃度，正在播的会话可被删断流 → 按最近访问淘汰。
- `python-bridge.js:176-181` 健康检查失败仅 proc.kill() 不杀进程树，周期重启累积孤儿 JVM/Worker → taskkill /T /F。
- `syncplay-client.js:169-181` TCP 流按单 chunk split 无跨包缓冲，消息被分片截断丢失 → 维护缓冲按 \r\n 切帧。
- `syncplay-client.js:56-85` 未先 disconnect 就重连、握手前 close 使 connect promise 永不 settle → 清旧 socket、reject。
- `ffmpeg.js:86-105` downloadFile 无 error/aborted 监听无超时：断连崩溃或 promise 永挂 → 补监听与超时。
- `ffmpeg.js:198-213,287-297` 抓帧失败遗留 0 字节 jpg，缓存命中只查 exists，永久返回损坏缩略图 → 失败删文件或校验 size>0。
- `ffmpeg.js:198-213` makeThumb 本地路径无超时，损坏容器占死并发队列 → 同 urlThumb 加超时。
- `dlna-caster.js:159-181` _sendSoap 无超时，设备失联 cast/stop 永挂 → req.setTimeout。
- `logger.js:120-133` 轮转 rename 失败仍重置 _size，日志可无限增长 → 仅成功才重置。
- `logger.js:83-89` redactSecrets 不匹配 JSON 引号键形态，`"password": "x"` 明文落盘 → 正则允许键名带引号。
- `logger.js:165-206` readRecentLogs 每次分页全量同步读 ~60MB 日志 → 倒序凑页即止。
- `pan-source.js:18-33` PAN_SOURCE_RE 过宽（`115|123`/`ali`/`pan` 误命中数字与普通词），正常源被误判网盘拒绝建队 → 加边界匹配。
- `pan-qr-window.js:110-113` clearStorageData 未 await 即建窗，二次登录用旧 Cookie 误判成功 → await 后再建窗。
- `index.js:1211,3605-3677` writeMpvAssets 先于 settings 创建，无 Anime4K/自定义 mpv 时自定义键位静默不生效 → settings 赋值后补调。
- `index.js:3988-4015` kill 旧外部播放器用 execFileSync 同步跑 powershell/taskkill，阻塞主进程 → 改异步。
- `preload/preload.js:51-54` onPlayerSession 监听的 `yuki:player-session` 主进程全库从不发送，断流重连连播兜底静默失效 → 补 send 或删死接口。

### 渲染层

- `kazumi.js:2625` webdavSync 上传可能为空的 `_rules`（启动时 kazumiList 瞬时失败），自动同步空规则覆盖云端备份 → 检查 `_rulesLoaded`。
- `kazumi.js:2677-2683` webdavRestore 逐条导入无容错无 Array 校验，单条抛错中断且提示误导 → 逐条 try/catch 汇总。
- `kazumi.js:2674-2676` 恢复直接 settingsSet 绕过 recSet，FavHub 不广播，订阅者旧数据 → 改 recSet。
- `kazumi.js:83-86,1612-1627` SSE 流仅弹窗按钮关闭时清理，Esc/选集播放关闭路径 EventSource 残留 → 统一关闭钩子。
- `kazumi.js:1944-1947` openBangumiDetail token 失效与 info 为空合并判断，旧回调覆盖新弹窗内容 → 拆分守卫。
- `kazumi.js:1604-1607` `plugins[r.name]` 普通对象当字典，规则名 `__proto__` 污染原型 → Object.create(null)/Map。
- `detail.js:293-306` _restore 未自增 _loadGen，嵌套打开番剧后返回被旧响应覆盖 → _restore 内 _loadGen++。
- `detail.js:1464` `(s.jobs || (...)).join` 未防字符串形态，镜像源返回字符串时 TypeError → 与 _staffJobRank 同口径兜底。
- `detail.js:1642-1717` 切线路不清 .ep-btn checked 类，批量播放/下载按下线路 data-idx 取错集 → 换源清空勾选。
- `home.js:878-950` 「全部」feed 刷新不失效合并窗口与页缓存，永远返回旧数据 → force 时 _catWinDelete。
- `home.js:913-915,978` homeContent 请求未传 abort signal，快速切源旧请求占满后端串行队列 → 补 signal。
- `home.js:1240-1260` 合并窗口深页跳转最多 200 次串行请求，最坏卡死数分钟 → 限深或并行预取。
- `player.js:795,837-1042` 原生队列起播失败静默回退时 `_currentPlayback` 已置 null 不恢复，断流重连/重试按钮失效 → 回退前恢复。
- `player.js:977-1038,1409-1437` 换集竞态：playUrl 返回后无 token/abort 校验，旧会话绑到新影片、观看记录错挂 → 出口校验。
- `live.js:193-247` loadChannels await 后未校验 `_probeToken`，慢源返回覆盖新源频道列表 → await 后 token 检查。
- `panels.js:910-913` 全局 Esc 只判 dirNavStack 非空不判视图激活，其它视图按 Esc 状态错乱 → 先判可见性。
- `panels.js:1160-1183` #pan_qr_refresh 永远 display:none，重新登录按钮死链 → 失败分支补 show()。
- `panels.js:1280,1300` settingsGet 回调持久化值直拼选择器，值异常抛 SyntaxError 被 .catch 吞掉，其后约百行设置回填静默跳过 → CSS.escape/分段 try。
- `records.js:576-705` 搜索框每键全量 render（IPC+grid 重建全链路）无防抖 → 200ms 防抖。
- `my.js:36-47` 每次收藏变更全量拉取 Bangumi 收藏，连续切换并发重复请求互相覆盖 → 去抖合并。

### Python 后端

- `server.py:88,1901-1937` `/proxy` 免 token 且仅带 token 时才校验，本地任意进程可匿名借代理抓任意 URL（SSRF 跳板）→ 无浏览器头默认拒绝或强制 token。
- `server.py:921,934-939` `_SPIDER_SEMAPHORE(16)` 排队发生在 40 线程池内，40 个并发 /action 占满线程池饿死 /proxy、/cache → 独立 executor 或超时快速失败。
- `server.py:2911-2914` kazumiImageSearch 无 scheme/host 白名单无大小上限（对照 kazumi_cover 有 8MB+白名单）→ 补齐。
- `config.py:650-665` 多仓路径 merge 阶段抛异常不 discard，已建 Worker/JVM 泄漏 → try/except + _discard。
- `config.py:214-216` 行内注释正则会把字符串值内 `//` 连收尾引号一起删掉损坏 JSON → 状态机扫描。
- `config.py:441-455`（另见 high # 总览对应 high）load() 用 `ctx = self._ctx` 读共享属性而非锁内局部对象，代际守卫被绕过 → 用局部变量。
- `app.py:9-18` 遗留 spider() 以 basename 作模块名，同名插件跨站串源且宿主进程直接 exec 远程代码 → 模块名掺路径摘要或删入口。
- `app.py:28-30` writeFile 非原子写，子进程可读半成品 → tmp+os.replace。
- `jar_bridge.py:1251-1289` destroy() 不取 _call_lock、清 _pending 不 reject 等待者，并发可破坏协议流/孤儿桥重生 → 先锁后逐个 reject。
- `jar_bridge.py:131-145` cleanup_jvm_cookie_files 删共享目录全部 cookie，多 jar 并存误删存活 JVM 登录态 → 按 jar 区分。
- `jar_bridge.py:627-634` / jar_patch.py:196-212 patched.jar 直接 'w' 写目标非原子，崩溃残留坏 jar 被 mtime 判新永久复用 → tmp+replace。
- `jar_patch.py:88-134` patch_methodref_class 常量池索引未补偿 long/double 双槽位，Methodref 错位补丁静默漏打 → 携带真实槽位索引。
- `jar_bridge.py:962-996` liveContent/action 等未纳入协议分派一律 ValueError→None，功能静默退化 → 补齐或显式短路。
- `base/spider.py:183-214` getCache/setCache 走 127.0.0.1 请求，严格 SSRF 模式下被守卫拒绝缓存全失效 → 回环豁免或进程内通道。
- `runtime/circuit.py:84-99` record_failure 不区分排队超时与真实调用失败，慢源排队超时把 half-open 打回 open → 仅统计准入请求失败。
- `runtime/site_worker.py:286-298` 调用成功后无条件读 spider.last_error，陈旧 last_error 把成功改写为失败并丢弃结果 → 调用前置空。
- `runtime/worker_base.py:67-73` 帧内 method 无白名单，getattr 可触达 Runner 任意属性 → 方法名白名单。
- `runtime/supervisor.py:50-113` _GLOBAL_LRU 持 Supervisor 强引用与 WeakSet 回收设计矛盾，Worker 泄漏到退出 → 弱引用或 dispose 确保移除。
- `runtime/supervisor.py:137-154,271-280` 全局淘汰竞态：victim 空闲判定后锁外销毁，窗口期接新请求被杀误报 CRASHED → 保持占用锁直到销毁完成。
- `runtime/config_security.py:117-146` 严格 SSRF 模式可被 DNS rebinding 绕过（guard 与连接两次解析，DNS 缓存无 TTL）→ 连接固定 IP 或校验对端。
- `runtime/config_snapshot.py:464-481` make_fetch_result 用 time.time() 减 monotonic()，elapsed_ms 恒为 ~1.8e12 垃圾值 → monotonic 算耗时。
- `http_client.py`（js_spider.py:83-99 同）js_spider._call 捕获全部异常返回 None，空 dict 可能被缓存 600s 固化 → 上抛或 error 标记。
- `cache_store.py:119-144` get() 与并发 set() 竞态可把新值覆盖成陈旧值 → 锁内复核或 setdefault 语义。
- `mem_cache.py:87-103` _evict_locked 每淘汰 1 条全命名空间重扫，最坏 O(n²) 持全局锁 → 单轮收集一批 victim。
- `pan/quark.py:147-160` _share_file_url 失败返回 '' 落入分享首集分支：多集分享点第 N 集播第 1 集 → elif 排除已带 file_id。
- `pan/quark.py:158-183` 用 except TypeError 区分新旧函数签名，桥内 TypeError 误判降参重试 → inspect.signature。
- `pan_cookies.py:250-276` 兜底 Cookie 收集按 cookie **名称** contains 'quark.cn'，永不生效 → 按名称白名单。
- `js-engine/quickjs_host.py:485-494` loader 以 `if (!globalThis.__JS_SPIDER__)` 守卫，重复 load_spider 新 spider 不生效 → 重载前重置。
- `js-engine/module_resolver.py:117-136` 循环依赖先 eval 模块 preamble 引用未定义命名空间 → 延迟取值 getter。
- `js-engine/esm_transform.py:24,56-63` `export * from`/`export const a=1,b=2`/解构导出不支持，直接 SyntaxError 或丢导出 → 补齐转换。

### 构建脚本

- `scripts/download-binaries.js:29-32` lock 解析失败静默返回 null → mpv/aria2 fail-open 未校验二进制照常执行 → 解析失败直接抛错。
- `scripts/binaries.lock.json:13-16` ffmpeg 锁 BtbN `latest` tag，固化 sha256 很快失配构建长期不可用 → 锁具体日期 tag。
- `scripts/build-python.js:81-84` --add-data 不经 COPY_EXCLUDE_NAMES，__pycache__/FM 等打进 _internal → 打包后清理。

### 测试

- `python-backend/tests/test_jar_phase.py:114-146` 夹具 jar 用真实域名 example.com（有 JDK 发真实公网请求）+ 条件断言 `if st['sites']` 空列表静默跳过 → fixture.invalid + 无条件断言。
- `python-backend/tests/test_all_runtimes_contract.py:92-93` URL 漏夹具端口打到本机 80 → 补端口。
- `python-backend/tests/test_r8_release_gates.py:123-169` uid 回填/损坏缓存两用例自测自证不触生产代码 → 导入真实实现。
- `python-backend/tests/test_q7_fault_injection.py:92-96` "磁盘写失败"用例无任何注入 → patch 落盘函数抛错。
- `scripts/run-jsunit.js:37-38` spawnSync 无 timeoutMs，任一用例挂死 CI 永久挂起 → 加超时。
- `python-backend/tests` 覆盖缺口：`jar_patch.py`（字节码补丁，正确性关键）零测试；`trigger.py`、`compat.py`、pan_login 主流程无覆盖。

### 文档

- `docs/DEVELOPMENT_HISTORY.md:84,177` "弹幕链路已移除勿再引入"与代码事实矛盾（设置项/IPC/后端端点均在）→ 勘误。
- `docs/ARCHITECTURE.md:165` mpv 缓存可配置一项已整体移除（--cache-on-disk=no 硬编码）→ 删除。
- `docs/THIRD_PARTY.md:18-19` dex-tools "随源码树入库"实际 vendor/ 整体 gitignore → 修正。
- `README.md:174` mirror.json 路径 %APPDATA% 实为 ~/.yuki → 更正。
- `docs/ARCHITECTURE.md:58` 等 3 处"64 键"实际 62；KAZUMI.md 3 处"并行度 5"实际 8；PROGRESS.md 指向不存在的 CHANGELOG [未发布] 段。

---

## Low（择要 30+ 条，完整见各模块原文）

代表性条目：

- `mpv-player.js:346/389/493/551` OSD 消息未剥 `$`、起播 speed 未夹取、startIndex 未非负夹取、queueLen 存实例级致跨会话误判。
- `mpv-player.js:83-87` buildM3u 未滤 url 中的换行，恶意 url 可注入 m3u 指令行。
- `index.js:1876-1905` yuki:settings-get 全量下发含 webDavPassword/dandanAppSecret/bangumiToken 明文凭据。
- `index.js:1911-1964` probe-urls 无内网限制可作内网扫描 oracle。
- `preload.js:55-61` onPlayRetry/onPlayFailed 死接口或落空事件。
- `css/ui.css:1690` `.kazumi-captcha-line` 的 `user-select:none var(--ease)` 非法声明整条被丢弃。
- `detail.js:311-314` 对 async Promise 做真值判断恒真，恢复失败守卫死代码。
- `records.js:352-388` file:/// 拼接未编码，含 #/% 的文件名帧图加载失败。
- `about.js:22-25` 版本兜底硬编码 '0.2.2'。
- `search.js:211-236` run() await pageSizeOf 后未复验 _searchToken，乱序时旧词覆盖新词。
- `player.js:646-650` 弹幕集数取集名首个数字，"2024…第3集"解析错集。
- `runtime/health.py:119-129` 用户取消请求把健康站点打成不健康。
- `runtime/config_cache.py:40-84` documents 不限量，load 全量读后才校验。
- `jar_bridge.py:595-604` proxyToken 以 -D 命令行注入，本机进程列表可读。
- `pan_login.py:155` service_ticket 前 16 字符入日志。
- `pan_cookies.py:74-107` 非 Windows 下 AES 密钥与密文同目录明文存放。
- `js-engine/quickjs_host.py:69-75` js_local.json 非原子写，崩溃损坏后静默清空。
- `cache_store.py:155-175` 崩溃残留 *.tmp* 永不回收。
- `server.py:2739-2896` 多处 int(form.get) 未捕获 ValueError 落 500 而非 400。
- `server.py:1757-1775` 每个搜索流请求新建 16/8 线程池无全局上限。
- `config.py:143-151` fetch 日志输出完整 URL（TVBox 配置常内嵌 token）未脱敏。
- `download-binaries.js:105-108` 重定向相对 Location 未处理抛 TypeError。
- `after-pack.js:83,109-111` 泄密门禁两套正则不一致，Windows 反斜杠路径漏检。
- `tests/js/api-contract.test.js:237-627` mkdtemp 临时目录从不清理。
- `run_all.py:149-154` 覆盖门禁正则扫全文，注释提一句文件名即假注册。
- `smoke.py:66` play_cache 测试目录 mkdtemp 从不清理。
- 大量死代码：detail.js:1064、kazumi.js:1904、runtime/worker_base.py ping/pong、supervisor.py:_global_alive_count、proxy_gateway.py:26-27 等。
- 巨型文件拆分建议：index.js（4428 行 whenReady 单回调 3460 行）、kazumi.js（2846）、panels.js（2440）、server.py（3073）、kazumi/plugin_manager.py（2000 行混 5 领域）、index.html（1538 行含 13 dialog）。

---

## 正向确认（多线独立验证到位的防线）

- XSS：escHtml 五实体转义+引号、CSS.escape 反查、.text() 写入——kazumi/panels/detail/home/player/live/records/搜索等所有网络数据入口均经净化，未发现可注入 sink。
- IPC：sender 校验、协议白名单、路径白名单 inside()、删除 opt-in；preload 66 个通道与主进程一一对齐。
- 进程：spawn 全 argv 数组无命令注入；Windows Job kill-on-close、熔断快速失败、快照哈希校验。
- 凭据：DPAPI/AES-GCM 加密、日志条数不落内容、WebDAV 恢复白名单排除凭据。
- QuickJS：三重限额 fail-closed；SSRF 逐跳守卫+32MB 响应上限（fetch_follow_redirects 路径）。
- 更新器：GitHub HTTPS + electron-updater SHA512。
- 配置写入：settings/cache 均为 tmp+fsync+rename 原子写。

## 建议修复顺序

1. 崩溃三连：hls renameSync、python-bridge error、download-binaries error（high #1-3）。
2. 播放断流链：playlist-proxy 重解析死代码+会话 TTL、go_proxy 分段 200/HLS 重写跳过（high #4-7）。
3. SSRF/凭据：kazumi 规则引擎守卫、cookie_jar 同域、/proxy 匿名面（high #9-12、server.py medium）。
4. 前端数据错位：home 切源、timeline 竞态、player 换集竞态（high #13-14、player medium）。
5. 测试可信度：4 个假测试文件改造 + run-jsunit 超时（high #15-16）。
6. 文档口径：弹幕三处 + ARCHITECTURE/THIRD_PARTY 等事实性错误（high #17、docs medium）。
