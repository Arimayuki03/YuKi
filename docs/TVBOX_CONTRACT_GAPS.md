# TVBox / FongMi 契约差距审计

更新时间：2026-08-17

本文只记录宿主契约层的差距，不把某个仓库或某个 JAR 的特例当成通用修复。FongMi 对照源码位于本仓库的 `TV-fongmi/`，运行时行为以配置随源携带、宿主只负责契约为准。

## 结论摘要

| 优先级 | 契约面 | 当前结论 | 影响 × 成本 | 后续动作 |
|---|---|---|---|---|
| P0 | `playerContent` 的 `parse=1` 与 `parses` 路由 | 已接入基本路由；无解析器/无匹配时已补 L4 错误，但 `type=1` 扩展解析和更复杂 `jx` 语义仍需实测 | 高 × 中 | 继续补 parse-window 行为样例 |
| P0 | 本地代理端口 | 9978/7944/1314 固定监听 + JAR 扫描 + 播放地址按需监听；行为回归已补 | 高 × 低 | 兼容套件中加入端口命中统计 |
| P1 | JAR / spider 覆盖优先级 | 已支持站点 `jar` 优先于顶层 `spider`；`spider` 仍只对 `csp_` 类名共享 | 高 × 中 | 录入带双层覆盖的配置样本 |
| P1 | QuickJS 宿主缺失全局 | 常用 `cheerio`、`CryptoJS`、`dayjs` 已注入；`ReferenceError` 已转为可检索警告 | 中 × 低 | 根据兼容报告补通用宿主 API |
| P1 | 配置 L1/L2/L3/L4 诊断 | 结构化摘要、分层 skipped 标签和前端摘要已接入 | 高 × 低 | 让兼容套件报告持续聚合标签 |
| P2 | `type=15/16` | 当前未实现，不能凭类型编号猜测契约 | 中 × 中 | 先收集真实样本，再按源码契约实现 |
| P2 | `drives`、`heat`、`hotList` | 尚未形成桌面端业务契约；`wallpaper` 已保留 | 中 × 中 | 确认产品范围后建数据模型 |

## 1. 站点类型矩阵

对照点：`TV-fongmi/app/src/main/java/com/fongmi/android/tv/bean/Site.java`、`TV-fongmi/app/src/main/java/com/fongmi/android/tv/api/config/VodConfig.java`。

当前 Python 宿主在 `python-backend/config.py::_build_site` 中处理：

- type `0/1`：CMS HTTP 源；
- type `3`：Python spider、HTTP `.js` spider 或 `csp_` JAR 类名；
- type `4`：QuickJS spider；
- type `3` 的站点级 `jar` 覆盖顶层共享 `spider`；
- type `15/16`：明确标记 `[L2:type]` 并跳过。

差距是 type `15/16` 的真实 FongMi 实现尚未在当前源码树中形成可运行桌面契约。后续不能简单把它们映射到 CMS；必须先拿到包含该类型的配置和对应 FongMi parser 行为。

## 2. per-site `jar` / `spider` 覆盖

对照点：`TV-fongmi/app/src/main/java/com/fongmi/android/tv/api/config/VodConfig.java` 的站点解析，以及 `TV-fongmi/app/src/main/java/com/fongmi/android/tv/bean/Site.java` 的 `spider` / `jar` 字段。

当前规则是：站点 `jar` 非空时优先；否则使用顶层 `spider`；`api=csp_XXX` 时将类名交给 JAR bridge。这个优先级已经在 `_build_site` 集中实现，避免把覆盖逻辑散落到 JAR 调用层。

待补样本：同一配置同时提供顶层 JAR、站点 JAR、站点 `spider` 字段时的冲突优先级；当前代码只显式读取站点 `jar`，对额外字段保持跳过并记录诊断。

## 3. `ext` 与相对路径

对照点：`TV-fongmi/app/src/main/java/com/fongmi/android/tv/api/config/VodConfig.java` 的配置加载；当前对应 `python-backend/config.py::_resolve_ext`。

相对 `api`、`jar`、`ext` 已按配置 URL 解析；伪装后缀的 JAR URL 不按扩展名过滤，而由下载内容校验。仍需实测的差距是：部分源把 `ext` 写成需要二次 HTTP 展开的配置 URL，当前宿主会把它作为字符串交给 spider，不会自动展开。

## 4. `parses`、`jx` 与播放路由

对照点：`TV-fongmi/app/src/main/java/com/fongmi/android/tv/api/config/VodConfig.java` 的 `parses`；`TV-fongmi/app/src/main/java/com/fongmi/android/tv/api/parser/ParseParser.java`（若上游版本提供该类）；当前对应 `src/main/parse-window.js` 和 `src/renderer/js/player.js`。

当前已覆盖：

- `playerContent` 返回 `parse=1` 时，渲染层通过 `resolveParse` 取配置 `parses`；
- 解析窗口支持 HTTP 解析接口、重定向、媒体请求嗅探和 legacy iframe 跟随；
- 没有解析器或没有匹配线路时，后端响应增加 `当前配置未含匹配该线路的解析接口（parse=1）`，前端保留原有友好提示；
- `url`、`header`、`playUrl` 的解析结果向播放器传递时仍需按更多真实配置复测。

未完成：FongMi type 1 扩展解析、`jx` 选择策略、混合解析器的优先级，以及需要登录态的 webview 解析页面。它们应进入行为样例，不应凭字段名直接宣称兼容。

## 5. `playerContent` 语义与 header

对照点：`TV-fongmi/catvod/src/main/java/com/github/catvod/crawler/Spider.java` 的六方法契约，以及 `TV-fongmi/app/src/main/java/com/fongmi/android/tv/bean/Result.java` 的 `playUrl` 字段。

Python `Runner` 保持六方法入口；JAR、JS、Python、CMS 均归一为 `url/parse/header` 结果。内置 mpv 支持 `Referer`、`User-Agent` 等请求头；外部播放器只在播放器类型支持时透传，并在不支持时返回 `headerDropped`。

待补：`playUrl` 的站点级前缀/模板语义、`vipFlags` 影响解析线路的完整矩阵，以及多 header 形式（字符串、对象、大小写变体）的实测。当前不要把“有字段”当成“全语义兼容”。

## 6. lives / liveContent

对照点：`TV-fongmi/app/src/main/java/com/fongmi/android/tv/api/parser/LiveParser.java`、`TV-fongmi/app/src/main/java/com/fongmi/android/tv/api/config/LiveConfig.java`。

配置的 `lives` 已保存并通过 `/sites` 暴露；JAR/JS/Python spider 的 `liveContent(url)` 已有统一入口。桌面端另有自定义 TXT/M3U 导入和本地播放链路。

差距：需要真实直播配置验证嵌套 `channels`、多线路、直播源重定向、EPG 与 `liveContent` 返回文本的编码/格式；目前没有将这些场景误标为完成。

## 7. JS 宿主环境

对照点：`TV-fongmi/quickjs/src/main/java/com/fongmi/quickjs/crawler/Spider.java`；当前对应 `python-backend/js-engine/host_bootstrap.js`、`quickjs_host.py`、`lib/cat.js`。

已注入常用 `cheerio/$`、`Crypto/CryptoJS`、`dayjs` 及若干 cat.js 工具。JS 加载或调用出现 `ReferenceError: xxx is not defined` 时，宿主会记录 `该 JS 源需要宿主未提供的全局 <xxx>`，并保留原错误路径。

未覆盖：drpy 专用 `pdfa/pdfh/pdft`、HikerWeb 等非 CatVod 全局。它们属于不同运行时契约，应该单独实现兼容层或明确跳过，不能静默注入空函数造成假成功。

## 8. 快捷字段

| 字段 | 当前状态 |
|---|---|
| `wallpaper` | 已读取并在设置/皮肤链路使用 |
| `drives` | 未实现桌面端网盘挂载契约 |
| `heat` | 未形成统一数据模型 |
| `hotList` | 未形成统一数据模型 |

`drives`、`heat`、`hotList` 的实现成本取决于产品是否要暴露入口；在范围确认前仅保留审计结论，不把未使用字段误报为兼容缺陷。

## 具体后续任务

1. 在兼容语料中加入：站点级 JAR 覆盖、`parse=1` 无解析器、`parse=1` 多 flag、HTTP `.js`、伪装 JAR URL 五类最小配置。
2. 为 `parse-window.js` 增加 type 0/type 1/`jx`/legacy iframe 的离线响应夹具。
3. 取得真实 type 15/16 配置和 FongMi 对应 parser 后，再实现 L2 契约，不按编号猜测。
4. 兼容套件报告继续按 `[L1:*]`、`[L2:*]`、`[L3:*]` 聚合 skipped 原因。
