# YuKi 使用指南

> 从第一步，到得心应手。本指南仿照 [kazumi.app/docs](https://kazumi.app/docs) 的结构编写，内容基于 YuKi v0.2.5 的实际实现。
>
> 开发者文档请移步 [文档索引](README.md)：[系统架构](ARCHITECTURE.md) · [Kazumi 规则引擎](KAZUMI.md) · [文件结构](FILE_STRUCTURE.md)。

---

## 目录

**01 开始使用**

- [认识 YuKi](#认识-yuki)
- [软件界面](#软件界面)
- [功能模块](#功能模块)

**02 安装与排错**

- [下载与安装](#下载与安装)
- [首次启动配置](#首次启动配置)
- [常见问题（FAQ）](#常见问题faq)

**03 源与规则**

- [CatVod 配置源](#catvod-配置源)
- [Kazumi 规则](#kazumi-规则)
- [XPath 规则开发](#xpath-规则开发)
- [API 规则开发](#api-规则开发)

**04 原理与实现**

- [视频嗅探（真实流提取）](#视频嗅探真实流提取)
- [原生播放列表与边下边播](#原生播放列表与边下边播)
- [解析结果缓存](#解析结果缓存)

---

# 01 开始使用

## 认识 YuKi

YuKi 是一个**本地优先的影视聚合桌面应用**：用 Electron 提供界面与系统宿主，用独立的 FastAPI/Python 进程运行 **CatVod** 与 **Kazumi** 两套内容引擎，再用 **mpv**、**aria2c**、**ffmpeg** 完成播放与下载。

它和同类工具最大的不同在于三点：

1. **双内容引擎并行**。CatVod 配置源（Python / JavaScript / CMS 爬虫，兼容 TVBox 生态）和 Kazumi 规则（XPath / API）是两套完全独立的引擎，各自有独立的端点、存储和规则文件，互不干扰。同一个搜索里两边的源会一起返回。
2. **本地优先、无追踪**。收藏、历史、观看统计、配置全部只存在本机（`%APPDATA%/yuki` 与 `~/.yuki/`），无埋点、无统计、无崩溃上报、无广告 SDK。唯一的云同步是你自己配置的 Bangumi 账号与 WebDAV 服务器。
3. **原生 mpv 播放体验**。不是内嵌网页播放器，而是把解析出的视频流交给独立 mpv 进程：自动连播、续播、Anime4K 实时超分、截图、快捷键全部由 mpv 原生承载。

一句话总结能力边界：**YuKi 本身不提供任何影视内容**——所有可播放资源都来自你自己添加的配置源、规则或本地文件。请优先观看正版授权内容。

## 软件界面

安装启动后，左侧是主导航栏，从上到下依次是：

| 视图 | 用途 |
|---|---|
| **首页** | 浏览当前 CatVod 源的分类与影片，顶部可切换源、按源内搜索 |
| **搜索** | 聚合搜索 / Kazumi 源 / Bangumi / 以图搜番四个页签 |
| **推荐** | Bangumi 趋势榜单（按标签筛选，T62 榜单） |
| **时间表** | Bangumi 每日放送 + 历史季度检索 |
| **直播** | 直播源频道浏览（IPTV，txt / m3u 地址） |
| **历史** | 观看历史 |
| **我的** | 观看统计、我的收藏（想看 / 在看 / 看过状态筛选） |
| **直链播放** | 粘贴一个视频链接（http/https/rtmp）直接播放 |
| **下载管理** | aria2c / ffmpeg 下载任务列表 |
| **本地文件** | 白名单目录内的本地媒体浏览与播放 |
| **设置** | 外观 / 播放 / 快捷键 / 下载 / 缓存 / 源 / 规则 / 同步 / 系统 / 关于 |

顶部三张「快捷入口」式的心智模型（对应本指南的三条阅读路线）：

- 第一次使用 → 先读 [下载与安装](#下载与安装) 和 [首次启动配置](#首次启动配置)。
- 想加自己的内容源 → 直接跳 [CatVod 配置源](#catvod-配置源) 或 [Kazumi 规则](#kazumi-规则)。
- 遇到问题 → [常见问题（FAQ）](#常见问题faq)。

## 功能模块

### 搜索

搜索页有四个独立页签，各自保留关键词与结果，切页签不丢状态：

- **聚合搜索**：输入关键字，所有健康 CatVod 源并发搜索（SSE 流式返回，单源失败不影响其他源），结果按源分组展示。
- **Kazumi 源**：检索所有已启用的 Kazumi 规则源，每条结果卡片右上角标有来源规则名。
- **Bangumi**：番剧元数据搜索，支持 `tag:`、`sort:`、`season:` 等筛选语法。
- **以图搜番**：粘贴图片 URL 或选择本地图片，调用 trace.moe 识别番剧出处。

### 详情与播放

统一详情页会合并展示：Bangumi 的封面、简介、评分（番剧类内容），加上各源的播放线路。详情页的「开始观看」会：

1. 优先用 CatVod 源的线路直接播放；
2. 存在已启用 Kazumi 规则时，提供「选择 Kazumi 源」弹窗——每个源一张可折叠卡片，并发流式检索，首个有结果的源自动展开；
3. 点剧集后：CatVod 源走 `playerContent` 解析，Kazumi 源先取播放页再由隐藏窗口提取真实视频流，最后统一交给 mpv。

### 播放器（mpv 与外部播放器）

YuKi 默认播放器是独立 mpv 进程，默认快捷键：

| 按键 | 动作 | 按键 | 动作 |
|---|---|---|---|
| `Space` | 暂停 / 继续 | `f` | 全屏 |
| `←` / `→` | 快退 / 快进 5 秒 | `s` | 截图（PNG） |
| `↑` / `↓` | 音量 +5 / -5 | `o` | 显示进度 |
| `m` | 静音 | `i` | 文件信息 |
| `[` / `]` | 减速 / 加速 0.1x | `a` | 切换音轨 |
| `Backspace` | 倍速重置 | `v` | 字幕开关 |
| `,` / `.` | 逐帧 | `Ctrl+s` | 停止播放 |
| `PgUp` / `PgDn` | 上一集 / 下一集 | `K` | Anime4K 档位循环 |

全部键位可在 **设置 → 快捷键** 自定义；步长（秒数 / 音量 / 倍速增量）也可调。播放中右键有中文菜单（Anime4K 档位切换、截图等）。

其他播放能力：

- **自动连播**：在线整季经本地代理映射成播放列表交给 mpv 原生队列，播完自动下一集；网盘类源自动回退逐集连播。
- **续播**：同一影片下次播放自动跳到上次位置（可在设置关闭）。
- **Anime4K 超分**：三档位——均衡 / 细节增强 / 仅修复，`K` 键或右键菜单即时切换，着色器首次启动自动下载。
- **外部播放器**：可在「设置 → 系统 → 组件状态」指定 mpv / VLC / PotPlayer 接管播放。实测 PotPlayer 与 VLC 均能正常起播在线内容，且整季播放列表会写成 `.m3u` 交给播放器原生列表，**连播可用**（播放器内切集即逐集取流）。但 mpv 专属能力全部不可用：Anime4K 超分、应用内快捷键与右键中文菜单、截图、续播进度、弹幕均不生效——进度无法回传，历史条目进度显示 0%，观看统计按播放器运行时长（墙钟）计入。想要完整体验请使用内置 mpv。

### 下载

- **aria2c**：普通文件、种子、Metalink，直链多线程下载。
- **ffmpeg**：M3U8 拉流封装（支持 AES-128），合成下载时可选跳过 CUE-OUT/CUE-IN 广告分段。
- **边下边播**：播放时自动把当前集下载到下载目录（网盘资源不支持）。
- **自动去重**：同一「站点 | 剧名 | 集名」的重复下载任务自动跳过。
- **按番剧创建文件夹**：下载自动落「下载目录/番剧名/」子文件夹。
- 下载完成弹系统通知，可点击跳转下载页。

### 数据与同步

- **观看统计**：记录播放时长与次数（我的页面展示）。
- **收藏**：想看 / 在看 / 看过。
- **Bangumi 同步**：登录 Bangumi 账号后，评分、收藏、观看进度可自动双向同步；进度上报默认关闭，需在「设置 → 同步 → Bangumi 同步」开启。
- **WebDAV 备份**：把收藏、历史、观看统计、规则与应用设置同步到自己的 WebDAV 服务器（坚果云 / Nextcloud 等），支持定时自动同步与「从云端恢复」。
- **本地文件管理**：在授权白名单目录内浏览、复制、删除、播放本地媒体，路径经主进程校验防穿越。

---

# 02 安装与排错

## 下载与安装

1. 前往 [GitHub Releases](https://github.com/Arimayuki03/YuKi/releases/latest) 下载最新 Windows 安装包 `YuKi-Setup-x.y.z.exe`。
2. 双击安装。安装器是 NSIS x64，默认装到系统程序目录。
3. 应用内置自动更新（electron-updater），发布新版本后会提示升级，无需手动重装。

**系统要求**：Windows 10 及以上（x64）。macOS / Linux 打包（dmg / AppImage / deb）配置已就绪但尚未完成实机验证，暂不提供安装包。

**关于杀软误报**：安装包已剔除两类常见误报源（Electron 自带的 `d3dcompiler_47.dll` 和 PyInstaller 捆绑的 UCRT 转发器，Win10+ 系统自带这些运行库）。若仍被误报，可在杀软中加白并向上游提交误报申诉。

**组件就绪**：应用依赖 mpv（播放）、aria2c（下载）、ffmpeg（HLS 下载）三个外部二进制，安装包已内置。「设置 → 系统 → 组件状态」可查看就绪情况；mpv 缺失可点「下载内置播放器」一键补装，或指定本机已装的 mpv/VLC/PotPlayer。

## 首次启动配置

首次启动时应用会自动完成两件事：

1. **内置规则导入**：三个默认 Kazumi 规则（7sefun / DM84 / enlie）自动导入，开箱即用；此后重新安装不会覆盖你自己的规则。
2. **着色器与字体补齐**：Anime4K 着色器、MiSans 字体在启动时自动下载就位。

之后建议按顺序做三件事：

### 第一步：添加一个 CatVod 配置源

YuKi 的影视内容主要来自 CatVod 配置（TVBox 生态的仓库格式）。进入 **设置 → CatVod 源设置**：

- 在「载入视频源」粘贴一个配置 URL（或本地文件 / 内联 JSON），应用会做健康检查后加载；
- 只显示健康检查通过的站点；「站点诊断」卡片可查看未建成、初始化失败、需要 Android 运行时的站点及原因；
- 开启「后台自动检测源」后，空源和死源会被自动屏蔽并定期复查。

### 第二步：配置网盘账号（可选）

如果你要看的源是网盘类（夸克 / UC / 天翼 / 百度 / 123 / 迅雷等 JAR 源），需要先配置登录凭据：

- **夸克**：点「夸克扫码登录」，用夸克 App 扫码即可，登录后自动保存、会话过期自动续期；
- **其他网盘**：先在浏览器登录网盘网页 → F12 开发者工具 → 网络 → 刷新页面 → 点任意请求 → 复制请求头里完整的一行 Cookie（形如 `__puus=xxx; __pus=xxx; …`）粘贴到对应输入框保存。注意只粘贴 Cookie 内容本身，不要带 `Cookie:` 前缀，且必须是完整的「字段=值; 」组合。

未配置 Cookie 时详情页照常显示，但播放会快速失败并提示原因。

### 第三步：登录 Bangumi 账号（可选）

在「设置 → 同步 → Bangumi 同步」登录后，可以获得 Bangumi 的番剧封面、评分、每日放送、收藏与观看进度同步。默认直连官方 `api.bgm.tv`；官方域名不可达时可开启「Bangumi 镜像」（社区运营的反代镜像，技术上可见你的请求与 Token，建议仅在网络受限时开启）。

## 常见问题（FAQ）

### 安装类

**Q：双击安装包没反应 / 被杀软拦截？**
先在杀软中放行（见上文误报说明）。若安装器损坏，重新下载并校验文件大小。

**Q：macOS / Linux 能用吗？**
打包配置存在但未完成实机验证。技术上有能力的用户可以自行 `npm run build:mac` / `build:linux` 构建，风险自负。

### 源与搜索类

**Q：首页是空的 / 下拉里没有源？**
首页只显示健康检查通过的站点。打开「设置 → CatVod 源设置 → 站点诊断」看每个站点的未建成、初始化失败原因。常见原因：配置 URL 已失效、站点需要 Android 运行时（YuKi 当前支持上限为 C1，不回退 dex2jar/JVM）、源站 Cookie 缺失。

**Q：聚合搜索时个别源一直转圈 / 失败？**
聚合搜索按整体预算等待，超时源会被实际终止，单源失败不影响其他源的结果。个别站点自身不稳定属正常现象。

**Q：网盘源播放失败提示 Cookie / 403？**
按「首次启动配置 → 第二步」配置对应网盘的凭据。夸克建议直接扫码登录。Cookie 会过期，过期后重新粘贴或重新扫码。

**Q：网盘源为什么不能整季连播 / 自动换线路？**
这是刻意设计：网盘解析慢且依赖 Cookie 会话、直链短时效，整季装载与失败自动重试都会放大风控概率。网盘类源全局禁用原生播放列表与线路自动回退，回退为逐集连播。

### 播放类

**Q：起播失败 / 黑屏？**
YuKi 会在起播前校验视频流有效性（拦截 HTML / 403 / 过期链接）。偶发起播失败会自动以 refresh 重解析一次；持续失败通常是该线路的直链已失效，换一条线路或换一个源。

**Q：播放进度显示 0%？**
使用外部播放器（VLC / PotPlayer）时播放器不回传播放位置，历史条目进度显示 0%，观看统计按播放器运行时长计入，Anime4K 超分、快捷键、截图等 mpv 专属功能也不可用；连播不受影响（整季列表照常加载）。想要完整体验请使用内置 mpv。

**Q：弹幕为什么没有？**
产品当前不启用弹幕界面与播放时弹幕加载，仓库保留的 DanDanPlay API 代码仅为兼容基础。「设置 → 播放」中的弹幕开关为后续版本预留，当前不会产生效果。

**Q：Anime4K 开了没效果？**
确认三点：着色器是否下载完成（组件状态）、设置里的超分开关与档位、播放中的 `K` 键切换是否弹出 OSD 提示。Anime4K 只对动漫类低分辨率片源有肉眼可见的提升。

### 数据类

**Q：重装系统 / 换电脑，数据怎么迁移？**
两条路：① WebDAV 备份恢复（设置 → 同步）；② 手动复制数据目录 `%APPDATA%/yuki` 与 `~/.yuki/`。

**Q：如何彻底清除我的数据？**
删除 `%APPDATA%/yuki` 与 `~/.yuki/` 两个目录即可，无云端残留。

**Q：设置恢复默认会丢什么？**
不会丢收藏、历史、配置历史、下载/缓存路径、观看统计和 Bangumi token 等用户数据键，这些在恢复默认时被保留。

---

# 03 源与规则

## CatVod 配置源

CatVod 是 TVBox 生态的配置格式。YuKi 完整实现其 Spider 调用契约：

| 类型 | 说明 |
|---|---|
| Python Spider | `.py` 爬虫脚本，顶层类名 `Spider` |
| JavaScript Spider | `.js` 爬虫（QuickJS 沙箱执行） |
| drpy 规则 | 由独立 Node Worker 进程承载 |
| 苹果 CMS | JSON / XML 接口（type 0/1） |
| portable JAR | Java 爬虫（仅可移植 JAR，Android 专属 JAR 不支持） |

**配置结构**：支持普通仓与多仓。多仓按「清单哈希 | 选中子仓 | 子仓正文哈希」判断内容变化，第一个装配出站点的条目胜出，合并只增不删。

**加载事务**：新配置 prepare → validate → 原子替换。新配置加载失败时旧配置继续可用，站点不会被先清空。

**能力路由**：每个站点按类型自动路由到对应运行时；Android 专属信号（Dex / native API / DRM）会标记为 `requires_android` 并如实告知，不会静默回退。

**网盘 Provider**：JAR 网盘 Provider 是首选实现；夸克另有本机直连解析快路径（默认开启），会话自动保活、Cookie 自动滚动续期。

## Kazumi 规则

Kazumi 规则是 JSON 格式的番剧站点规则，YuKi 兼容 Kazumi v8 schema（`api` ≤ 8）。

### 导入规则

**设置 → Kazumi 规则 → 导入 Kazumi 规则**，支持两种方式：

- 直接粘贴规则 JSON；
- 粘贴 `kazumi://` 分享链接（自动 base64 解码）。

也可以点「规则商店」从在线仓库（KazumiRules，GitHub/GitCode 镜像）浏览、安装、更新规则。

已安装规则列表支持启用 / 禁用开关（禁用后不参与聚合搜索与详情页选源）与删除（有确认对话框）。

### 规则的字段

一条 XPath 规则的核心字段：

```json
{
  "api": 8,
  "name": "示例规则",
  "baseURL": "https://example.com",
  "searchURL": "https://example.com/search?wd=@keyword",
  "searchList": "//div[@class='item']",
  "searchName": "//h3/a/text()",
  "searchResult": "//a",
  "chapterRoads": "//div[@class='playlist']",
  "chapterResult": "//a",
  "searchMode": "xpath",
  "chapterMode": "xpath",
  "userAgent": "",
  "referer": ""
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `api` | 是 | schema 版本，> 8 拒绝导入 |
| `name` | 是 | 规则唯一名 |
| `baseURL` | 是 | 站点根 URL（注意大写 URL） |
| `searchURL` | XPath 模式必填 | 搜索页地址，`@keyword` 为关键词占位符；另可选声明 `@tag` / `@year` / `@sort` 接收筛选 |
| `searchList` | XPath 模式必填 | 搜索结果列表节点的 XPath |
| `searchName` | XPath 模式必填 | 以 `searchList` 节点为上下文，取标题 |
| `searchResult` | XPath 模式必填 | 以 `searchList` 节点为上下文，取详情页链接 |
| `chapterRoads` | XPath 模式必填 | 详情页线路（播放列表分组）的 XPath |
| `chapterResult` | XPath 模式必填 | 以线路节点为上下文，取各集播放页链接 |
| `searchMode` / `chapterMode` | 否 | `xpath` 或 `api`，可分别指定 |
| `usePost` | 否 | 搜索改用 POST：URL 去掉 query，query 部分转为表单 body |
| `userAgent` / `referer` | 否 | 播放与下载请求头 |

规则只要负责**找到番剧详情页和剧集播放页**；真实媒体地址由 YuKi 的隐藏窗口统一提取（见[视频嗅探](#视频嗅探真实流提取)），所以规则不需要处理视频直链。

## XPath 规则开发

### 工作原理

YuKi 用 lxml.html 解析页面，执行分两步：

1. **搜索**：请求 `searchURL`（`@keyword` 替换为关键词并编码）→ `root.xpath(searchList)` 得到结果节点列表 → 对每个节点以其为上下文执行 `searchName`（取文本）与 `searchResult`（取 `href` 属性或文本）。
2. **剧集**：请求详情页 → `chapterRoads` 找到所有线路节点 → 对每个线路节点执行 `chapterResult` 得到该线路的集列表。

所有取到的链接都会经过 `normalize_episode_url` 归一化（相对路径 urljoin、同站协议统一、去尾斜杠、去空 query），规则里不需要手工拼绝对地址。

**关于 `//` 前缀**：Kazumi 生态的规则习惯在 `searchName` / `searchResult` / `chapterResult` 里写文档级 `//` 查询，YuKi 与 Kazumi 一样会自动把它们归一化为节点相对查询（`//a` → `.//a`）——沿用上游规则的书写习惯即可，不必刻意改成 `.//`。

### 一个可跑的最小示例

以一个假想的番剧站为例：

```json
{
  "api": 8,
  "name": "MyAnimeDemo",
  "baseURL": "https://anime.example.org",
  "searchURL": "https://anime.example.org/search?q=@keyword",
  "searchList": "//ul[@id='result']/li",
  "searchName": "//a/span[@class='title']/text()",
  "searchResult": "//a",
  "chapterRoads": "//div[contains(@class,'play-list')]",
  "chapterResult": "//a"
}
```

对应的页面结构假设是：

```html
<!-- 搜索页 /search?q=关键词 -->
<ul id="result">
  <li><a href="/bangumi/123"><span class="title">某科学的超电磁炮</span></a></li>
</ul>

<!-- 详情页 /bangumi/123，可能有多个「线路」div -->
<div class="play-list">
  <a href="/play/123-1.html">第01集</a>
  <a href="/play/123-2.html">第02集</a>
</div>
```

要点：

- `searchList` 选到**列表项节点**（`li`），不是标题文本；
- `searchName` / `searchResult` 以每个 `searchList` 节点为上下文执行，`//` 前缀会被自动转为节点内查询；
- `searchResult` 直接选中 `<a>` 即可，YuKi 取它的 `href` 属性；
- 一个 `chapterRoads` 节点就是一条线路，多线路站点会自然得到多个线路分组；
- 集名从链接文本自动提取。

### 调试与排错

- 规则写完后，在「设置 → Kazumi 规则」确认已启用，然后到**搜索 → Kazumi 源**实际搜一次，观察是否返回结果；
- 结果为空时优先检查：站点是否需要 Cookie / 有反爬；`searchURL` 是否需要 POST（规则加 `"usePost": true`，引擎会把 URL 的 query 部分转为表单 body）；
- 站点弹出验证码时，源卡片会标「需验证」，点击打开可见验证窗口，手动过验证后 Cookie 会自动收割并重查该源；
- XPath 语法错误、节点缺名称或链接会被记入诊断并跳过，全部失败才报无结果。

## API 规则开发

当站点有结构化 JSON 接口时，API 模式比 XPath 更稳。YuKi 支持**受限 JSONPath**（仅 `$ . [index|*|key]`，禁止递归下降与过滤器，防止恶意规则拖死解析）。

规则中 `searchMode` / `chapterMode` 设为 `api`，并配置 `searchApiConfig` / `chapterApiConfig`（核心是其中的 `request` 与一组 JSONPath）：

```json
{
  "searchMode": "api",
  "searchApiConfig": {
    "request": {
      "url": "https://api.example.org/search?kw=@keyword",
      "method": "GET"
    },
    "listPath": "$.data.list[*]",
    "namePath": "$.name",
    "sourcePath": "$.url"
  }
}
```

模板变量：`request` 的 url / headers / query / body 都支持 `@variable` 占位符（如 `@keyword`，以及可选的 `@tag` / `@year` / `@sort` 筛选变量），URL 中的变量自动 URL 编码。

搜索解析三个 JSONPath 字段：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `listPath` | `$.data[*]` | 结果列表 |
| `namePath` | `$.name` | 单个结果的标题 |
| `sourcePath` | `$.url` | 单个结果的详情页链接 |

剧集解析支持两种响应格式：

- **nested**（JSON 树）：`roadsPath`（可选，线路列表）、`roadNamePath`（线路名）、`episodesPath`（默认 `$.episodes[*]`）、`episodeNamePath`（默认 `$.name`），集地址取 `episodeUrlPath`；没有独立集地址字段时用 `episodePage.url` 模板拼出播放页（可用 `@episodeUrl` / `@roadIndex` / `@episodeNumber` 等变量）。
- **delimited**（分隔字符串）：`roadNamesPath` / `roadEpisodesPath` 加 `roadSeparator` / `episodeSeparator` / `fieldSeparator` 三个分隔符，兼容 `$$$` / `#` / `$` 分隔的传统格式。

播放页 URL 同样经归一化后交给隐藏窗口提取真实流。

---

# 04 原理与实现

本章给想了解「YuKi 怎么做到的」的读者。深入细节见[系统架构](ARCHITECTURE.md)。

## 视频嗅探（真实流提取）

CatVod Spider 返回的可能是直链，也可能是一个网页地址；Kazumi 规则更是只给到播放页 URL。统一由 Electron 的**隐藏 BrowserWindow** 把网页变成视频流：

```
播放请求
  → 取播放页 URL（Kazumi 源先经 kazumiResolve 拿到 pageUrl 与 headers）
  → 隐藏窗口加载页面（独立 partition，按会话隔离）
  → webRequest 拦截媒体请求（m3u8 / mp4 等）
  → 注入脚本轮询 video/audio 的 currentSrc
  → legacy 模式监听并跟随 iframe src
  → 合并请求头（站点 header → Spider → 解析器 → 解析结果 → 页面 Cookie）
  → HEAD 探测；不确定时 GET Range bytes=0-1
  → 拒绝 HTML / JSON / 登录页 / 401 / 403 / 伪媒体
  → 直链交给 mpv
```

关键设计：

- **请求头合并**是分层的，优先级从低到高：站点 header → Spider `header` → Spider `headers` → 解析器配置 → 解析结果 → 页面最终 Cookie。大小写无关。
- **不盲信**。抓到的东西先探测再交给播放器：HTML、JSON、登录页、401/403、已过期签名地址一律拒绝；Spider 可用 `skipProbe` 标记真正一次性、探测即消耗的 URL。
- **会话隔离**。每次播放分配会话号；解析窗口和 partition 由 playSessionId/requestId 隔离，完成、失败、超时和取消都会清理 hook、窗口与 partition，旧会话不能影响当前会话。
- **验证码处理**。检测到验证码时在源卡标记「需验证」，用户手动过验证后自动收割 Cookie 复用。

## 原生播放列表与边下边播

在线整季的「自动连播」不是渲染层循环单集起播，而是把整季映射为 **mpv 原生播放列表**：

- `src/main/playlist-proxy.js` 把每一集映射成本地按需解析代理条目 `http://127.0.0.1:<port>/pl/<token>/<index>`；
- mpv 打开哪集才解析哪集（playerContent / Kazumi captureDirect 二段解析），302 交真实 CDN——**直链零过期**：不存在「整季解析完，播到一半全过期」的问题；
- `parse=1` / DRM / 空地址的集目返回 502 并提示停队；
- 网盘类源（站点/线路名或集地址命中夸克/网盘/云盘等特征）全局禁用原生播放列表，回退逐集连播，防止触发网盘风控。

外部播放器（VLC / PotPlayer）共用同一套按需解析代理条目：整季队列写成 `.m3u` 播放列表文件交给播放器原生列表加载，**连播同样可用**——播放器切到哪集，本地代理就实时解析哪集，直链零过期的特性不变。但 mpv 专属的 Anime4K 超分、快捷键/右键菜单、截图与进度回传在外部播放器中不可用。

**边下边播**：开启后播放当前集时自动把该集下载到下载目录（网盘资源始终跳过）；与下载管理的「同源同集去重」共用一套「站点 | 剧名 | 集名」稳定 key。

## 解析结果缓存

解析（查源）往往比播放更慢。YuKi 做了三级缓存：

| 层 | 位置 | TTL | 作用 |
|---|---|---|---|
| ① 内存 | Python 后端进程 | 60s | 会话内换线路往返 |
| ② 持久 | `~/.yuki/cache/play-cache/` | 2h | 跨重启生效，重开同一集跳过查源 |
| ③ 会话 | playlist-proxy 进程内 | 2h | 整季连播逐集取地址时复用 |

只缓存判定为「稳定」的结果——签名 CDN / 网盘一次性地址 / 显式过期标记不落盘，读侧复检防缓存中毒回流。失效兜底：「起播即失败」时自动以 refresh 重解析一次，TTL 内源站侧失效的缓存直链不再表现为用户可见的播放失败。

---

## 参与共创

- 问题与建议：[GitHub Issues](https://github.com/Arimayuki03/YuKi/issues)
- 代码贡献：先读 [CONTRIBUTING.md](../CONTRIBUTING.md) 与[行为准则](../CODE_OF_CONDUCT.md)
- 本指南位于 `docs/GUIDE.md`，欢迎 PR 补充与勘误

## 免责声明

YuKi 本身不提供、存储、托管或分发任何影视内容；所有可播放资源均来自用户自行添加的配置源（第三方网站、规则脚本）或本地文件。完整声明见 [README 免责声明](../README.md#-免责声明)。请在遵守所在地区法律法规的前提下使用，并优先支持正版。
