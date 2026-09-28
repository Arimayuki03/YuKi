# YuKi 未暂存区代码审查报告（2026-09-28）

- 审查日期：2026-09-28
- 审查方式：OCR（open-code-review）delegate 模式负责文件选择与规则解析，实际审查由 13 个并行子代理执行（第一波 10 个审源码、第二波 3 个审测试），宿主（ZCode）逐条验证问题真实性后统一修复
- 覆盖范围：OCR `delegate preview` 识别的 27 个审查文件（+9685/-623）+ 20 个被 OCR 默认路径排除、但项目规则（`.opencodereview/rule.json`：审查所有文件包括测试）要求纳入的测试文件；共 47 个改动文件全覆盖
- 基线：main @ e24b238，工作区未暂存改动（v0.2.6 之后的 Kazumi 对齐批次 + tracker 自动刷新 + 本地多选播放列表等）

## 总览

子代理原始上报合计 **41 条**（critical 2 / high 9 / medium 14 / low 16，同域相近发现合并后取主要条目）。宿主对全部 critical/high/medium 逐条对照源码验证，**17 项主要发现全部属实**；已修复 4 critical/high、12 medium 与全部可安全落地的 low。

| 严重度 | 数量 | 处理 |
|---|---|---|
| critical | 2 | 全部修复 |
| high | 7 | 全部修复 |
| medium | 12 | 全部修复 |
| low | ~15 | 择要修复，剩余为记录性说明 |

---

## Critical（2 条）

### 1. `.opencodereview/config.json:5` [security]
**LLM 网关 api_key 明文入库风险**。目录整体为 untracked 状态，`git add .` 即随仓库提交，而 package.json publish 指向公开仓库。
→ 修复：`.opencodereview/` 加入 `.gitignore`；建议网关侧轮换该 key。

### 2. `src/renderer/js/detail.js:611` [security]
**CatVod 详情 meta 行 XSS 回归**：hero 重构时 meta 构造改为 bgm/CatVod 双分支，bgm 分支各段均 `escHtml`，但 CatVod 分支 `this.metaLine(vod)` 直接 join `vod.type_name/vod_year/vod_area/vod_remarks`（第三方 CMS 源回传字段）进 `.html()` 插入点。HEAD 版此处有转义，属本次改动引入的回归。
→ 修复：非 bgm 分支恢复整体 `escHtml(this.metaLine(vod || {}))`。

## High（7 条）

1. **`python-backend/jar_bridge.py:305-342` [bug] 按需下载布局错误——打包模式主路径必然失败**：`_locate_dex2jar` 找 `stage/dex-tools/dex-tools-v2.4/...`，但上游 zip 顶层即 `dex-tools-v2.4/`（子代理实测下载 sha256 固定的上游 zip，`dex-tools/` 条目数为 0）。0.2.7 起打包不随附 dex-tools，该缺陷使任何含 classes.dex 的 jar 蜘蛛在打包版中无论网络好坏都无法转换；且 JS 侧 `downloadDextools` 布局正确、两套实现互相矛盾。测试桩掉了 `_dex2jar_jar`，不可捕获。
   → 修复：按真实布局落位 `cache/dex-tools/dex-tools-v2.4/`（与 vendor 一致），并补 10 例直接覆盖（见测试段）。
2. **`src/main/file-manager.js:173-205` [bug] delMany 先删后确认**：文件在分类循环里即删，之后才做在写互斥与原生确认框；用户在主进程框点「取消」（意图全不删）时文件已被删且 toast 显示「已取消删除」，已删项的结果随 throw 丢失。
   → 修复：先分类并过完全部防线（含根目录剔除提前到确认框前、与 delFolder 口径一致），防线通过后统一删除；补「取消/互斥时不删文件」回归断言。
3. **`src/main/index.js:1819-1823` [bug] 单条目外部播放器 VLC 不播**：`yuki:file-push-many` 单有效项时本地正斜杠盘符路径直传 `launchExternalPlayerItems`，绕过 `toExternalLocalUrl`（VLC 把 `C:/...` 当未知 URI 静默拒载，R21 同根因；同仓 `yuki:file-push`/`yuki:dl-play` 均已修）。
   → 修复：外部分支按 items.length 分流，单条目先过 `toExternalLocalUrl(abs, externalPlayerKind(extPrimary))`。
4. **`scripts/download-binaries.js:449-453` [bug] downloadDextools 首次安装必然 ENOENT**：`ensureDir(vendor/dex-tools)` 建的空目录被 `fs.rmSync(dest)` 删掉后，`fs.renameSync` 缺父目录直接抛 ENOENT（宿主用 Node 复现 mkdir→rm→rename 稳定失败），60MB 下载白费且 stage 残留。
   → 修复：rename 前补 `ensureDir(dest)`。
5. **`src/renderer/css/ui.css:2539-2541` [bug] 收藏状态标签不可点**：`.rec-cover-badges` 新增 `pointer-events:none`（可继承），`.rec-tag` 无 `pointer-events:auto` 恢复，状态循环切换委托（records.js:658）永远收不到点击，本地卡「想看→在看→…」整条交互死亡。
   → 修复：补 `.rec-cover-badges .rec-tag { pointer-events:auto; }`。
6. **`python-backend/jar_bridge.py:277-280、320-337` [bug] dexdeps 快路径跳过补全**：主 jar 已在即 return，dexdeps 任一瞬时失败后缺失依赖永不重试；且依赖写盘非 tmp+replace，崩溃残留的半截 jar 被永久当作已就绪。
   → 修复：快路径校验 `DEXDEPS_FILES` 全部落盘；已存在文件哈希复核；写盘 tmp+`os.replace` 原子落位。
7. **`tests/js/live.test.js:536` [test] 恒真断言（假通过）**：「缓存命中不再探测」过滤的是 `doActions`，但探测走 `yuki.probeUrls`，断言恒为空；缺省桩不记录调用，回归会被静默放过。
   → 修复：缺省 probeUrls 桩加 `state.probes` 计数，断言改真实计数。

## Medium（12 条）

1. **`python-backend/server.py:2864-2868` [performance] 缓存形同虚设**：`kazumiBangumiEpisodeComments` 的上游 HTTP 请求写在 `_cached_bangumi` builder 之外，缓存命中也先回源（其余 7 个端点均 builder 内）。→ 移入 builder。
2. **`python-backend/jar_bridge.py:269-304` [performance] 下载失败无负缓存**：离线/弱网下每次转换请求都在锁内重跑 6 连发请求链，拖死同桥全部站点；`_dex_tools_checked` 注释与行为不符（仅日志去重）。→ 失败记时间戳，10 分钟冷却内直接返回；注释对齐。
3. **`src/main/downloader.js:152-175` [bug] fetchText 畸形 Location 卡死刷新锁**：`new URL(...)` 在事件回调内同步 throw（非 Promise executor），异常冒成 uncaughtException，Promise 永不 settle，`_trackerRefreshing` 永久 true，tracker 自动刷新静默失效至重启。→ try/catch reject + `rsp.resume()` 排空响应归还连接池（附带 low 项一并修）。
4. **`src/renderer/js/detail.js:2031-2045` [bug] 分集列表世代守卫误伤**：`_ensureBgmEpisodes` 借用 `_bgmExtraGen`，同番剧吐槽提交后 3 秒重拉会自增该世代，误杀在途分集请求致页签显示「暂无分集」。→ 改用 `_bgmId` 快照比对（与 `onBgmCommentSubmitted` 同口径）。
5. **`src/renderer/js/panels.js:610/634/876-880` [bug] 多选模式条目主体仍触发原动作**：与注释及 index.html 帮助文案「进入多选模式后点击条目勾选」直接矛盾——点视频卡弹播放框、点文件夹切目录并清空勾选。→ `selectFile`/`enterDir` 入口补 `_selMode` 守卫转 `toggleSel`。
6. **`src/renderer/js/panels.js:712-722` [bug] 全选范围越界**：「全选/反选」作用在未分页全量列表，千项目录下第 1 页点全选即选中整库，而可见勾选框只回显当前页——「删除所选」感知与实际集合严重不符。→ 收窄为当前页切片；反选从清空全集合改为仅剔除当前页。
7. **`src/renderer/js/kazumi.js:1359-1368` [bug] 匹配缓存读写不对称**：写侧 `cacheBangumiMatch` 存扁平 `score/rank` 字段，读侧 `_bgmMetaOf` 只认 `rating.score/rank`，重启后旧匹配评分/排名归零且被回写永久丢失（搜索页 Kazumi 卡 ⭐/#N 徽章消失）。→ 读侧兼容扁平字段回退。
8. **`src/renderer/js/kazumi.js:1189-1194` [bug] 收藏查询失败被当「未收藏」缓存 6 小时**：服务端对 404/401/网络异常统一返回 `collection:null`，`null` 以完整 TTL 落盘，一次瞬时失败冻结展示 6 小时。→ null 只写 60 秒短负缓存（`_bgmColCacheNegTTL`），非空才写长 TTL。
9. **`src/renderer/js/kazumi.js:787-789` [bug] 乐观合并缺 token 校验**：`setBangumiCollection` 合并旧缓存条目不比对 token，换号后旧账号 `ep_status/rate` 借乐观写入带到新账号缓存。→ 合并前加 `prev.token === String(token)` 守卫。
10. **`src/renderer/js/bgm-rate.js:225/255-269` [bug] 调星级清空标签草稿**：`_pickRate`/`_clearRate` 触发整对话框重渲，`_renderTags` 无条件清空自定义输入框。→ `_renderTags(opts.preserveInput)` 参数化，星级交互路径保留草稿。
11. **`src/renderer/js/bgm-rate.js:292-300、316-319` [bug] 草稿阻断提交与误报文案**：草稿非法（重复/超限）时整个评分/吐槽无法提交（须手动清输入框）；仅改标签提交成功误报「吐槽已提交」。→ 草稿失败降级为框内提示不阻断；成功文案补「标签已更新」分支。
12. **`src/renderer/js/records.js:310-316、326-343` [bug] 收藏卡徽章渲染**：①「我的 N★」与「#N 排名」右上角同点位并存重叠（注释声称互斥但无实现）→ 排名优先互斥；② bgmScore 公共评分首渲无展示面（`playDurLine` 要求 `isPlay && lastDuration`，收藏卡恒不满足；异步补齐的 pending 过滤恰好把已带 bgmScore 的条目排除）→ 无播放行时 scoreText 拼到日期行行首。

## Low（择要）

- **死代码清理**：`jar_bridge._sha256_file`（无调用方）删除；`detail.js _epCommentsEpisode` 死字段（三处只写不读）删除；`kazumi.js Detail._bgmColCache` 死写与 `bangumiComments` 归一化链第三死分支删除；`bgm-rate.js` 死变量 `tags` 删除；`common.js bangumiCard` 的 `data-tags` 死属性移除（无任何消费方，测试断言同步反转）；`ui.css .detail-stat-eps` 死规则删除。
- **注释/文档失真**：`_locate_dex2jar` docstring 兜底描述与实现不符；`download-binaries.js` 「主进程一键补装（yuki:download-dextools）」描述的接线不存在；`ad-skip.js` 两处登记入口描述未随 Shift+O/E → mpv 右键菜单迁移更新；`index.html` CSP 注释哈希计数 41→42；`my.js` globals 注释残留 `BgmRate`。
- **风格规范化**：`mpv-player.js` 嵌套三元展平；`kazumi.js`/`bgm-rate.js` 宽松等号（`!=`/`==`）改严格等价；`panels.js markRe` 中文字符类补「零」（与 `parseEpNum` 校验类对齐）；`timeline.js _attachEpBadges` 调用补 `.catch` 防 rejection 外溢；`detail.js` director 正则重复 `演出` 分支清理。
- **测试质量**：`detail-start-button` 死断言（`void epsHtml; assert.ok(true)`）补有效内容断言；`file-manager-ipc` 5 处 mkdtemp 补 try/finally 清理；`player-internals` T80 源码正则死代码用例重写为真实 submit 行为测试（VM realm 对象断言逐字段比较）；`my-about-ui-state` 用例名与断言对齐并补历史视图断言；`test_kazumi_bgm_rating` UA 断言从键存在强化为值等于 `BANGUMI_UA`；`bgm-episode-comments` 硬编码 venv python 改 existsSync 回退 + skip 显形（CI js job 无 venv 会 ENOENT 必炸）并补 bgm.tv 跳转守卫的源码级锚点（原复刻式用例测的是测试自己的副本，删守卫不会红）。

## 未采纳/记录在案

- `fetchText` 不走系统代理（`getProxyUrl()`）：与 aria2 下载链路代理行为不一致，但 tracker 刷新有 6h 退避兜底、失败可观测；涉及 CONNECT 隧道改造，留待后续评估。
- `toggleSel` 整页重渲导致缩略图闪烁：优化需按 `data-sel-rel` 定点更新勾选框，涉及交互面回归测试，留待后续。
- 组列表连播起始集恒为第 1 集：需 `yuki:file-push-many` 增加 startIndex 透传链（preload/main/mpv 三层），属产品语义确认项。
- `bangumiComments` 乐观行在 `_loadMoreComments` 场景不合并：仅索引延迟 >3 秒且继续下拉加载时出现重复行，重进详情页自愈。
- `file-push-many`/`file-del-many` 无入参数量上限：`resolveSafe` 白名单已到位，仅缺规模上限，与既有 handler 同口径，统一处理时一并补。

## 测试与回归

- 新增 `python-backend/tests/test_dextools_on_demand.py`（10 例）：此前 150 行按需下载逻辑零覆盖（两个测试文件仅桩函数替换，无直接断言）。覆盖 vendor/缓存解析顺序与不触网断言、真实上游布局落位、zip/依赖哈希不符拒绝、dexdeps 补全可达性（快路径回归点）、tmp+replace 无残留、失败负缓存冷却与恢复；已接入 `run_all.py`（`dextools-on-demand` stage，coverage-self-check 由 FAIL 转 PASS）。
- 修复侧测试：live/detail-start/file-manager-ipc/player-internals/my-about/bgm-rate/bgm-episode-comments 7 个测试文件修正（恒真断言、死断言、临时目录泄漏、假覆盖、环境必炸项各归各）。
- 全量回归：JS 87 个测试文件逐个执行 0 fail（含全部新增用例）；Python `tests/run_all.py` 75 阶段 ALL PASS（含编译门禁 289 文件 0 error）。
