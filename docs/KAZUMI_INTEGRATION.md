# Kazumi 规则引擎整合开发文档

> 版本：v1.0（2026-08-09）  
> 目标：将 Kazumi 的 XPath/API 规则引擎以插件形式整合进 video-pc，不破坏现有 CatVod 配置链路。  
> 阅读对象：glm5.2（主要代码实现）、前端 UI 由本助手完成。  
> 前置文档：先读 `PROGRESS.md` 第 4 节架构决策、第 5 节 Spider 契约，再读本文件。

---

## 1. 整合目标与边界

### 1.1 必须实现
- 支持 Kazumi 规则 JSON（Plugin schema，api 小于等于 8）的导入、保存、列表、删除、启用禁用。
- 规则两种模式：xpath（5 条 XPath 选择器）与 api（JSONPath 模板）。
- 聚合搜索：Kazumi 规则源与现有 CatVod 站点并行出现在搜索结果中，来源标记为 kazumi:规则名。
- 详情页：当 CatVod 源无播放线路或用户主动点击时，提供 Kazumi 源弹窗，列出已启用规则的搜索结果，用户选源后解析剧集并播放。
- 播放链路：复用现有 Player.play()，但 Kazumi 源需先经真实视频流提取（隐藏 BrowserWindow 抓 m3u8/mp4）。

### 1.2 本期不做
- 番剧元数据（Bangumi API）、时间表、追番同步、弹幕、WebDAV 同步。
- 验证码反爬（AntiCrawlerConfig）：本期仅识别并提示，不实现 WebView 验证流程。
- 规则商店在线更新：仅支持本地导入粘贴删除，不拉取 KazumiRules 仓库。
- Anime4K 超分：现有 CatVod 链路已支持，Kazumi 源直接复用。

### 1.3 兼容性红线
- 现有 CatVod 配置加载、搜索、详情、播放、下载、直播零改动。
- 所有新增代码必须放在独立模块，禁止修改 app.py、runner.py、base/spider.py（CatVod 字节码契约）。
- 新增 Python 依赖必须锁定版本并写入 requirements.txt；禁止引入需要编译的 C 扩展（除已存在的 lxml/quickjs-ng）。

---

## 2. 总体架构（双引擎并行）

```
渲染层
  首页/搜索/详情/设置（CatVod 链路）
       |
       +-- 详情页 Kazumi 源弹窗
       |
       +-- Player.play() 统一播放入口
             左路 CatVod: playerContent 解析后 mpv
             右路 Kazumi: kazumiResolve 后 captureDirect 再 mpv
                           |
后端（FastAPI）
  /action        CatVod Spider 引擎（现有，零改动）
  /kazumi/action Kazumi 规则引擎（新增模块）
       |
       +-- python-backend/kazumi/ 规则模型、XPath/API 策略、规则管理
```

关键决策：
- 独立端点：Kazumi 所有操作走 /kazumi/action，与 CatVod 的 /action 物理隔离，避免 do 参数冲突。
- 独立存储：Kazumi 规则存 ~/.video-pc/kazumi/plugins.json，与 CatVod 的 cache/py 插件目录分离。
- 无 Runner 复用：Kazumi 规则不继承 base.spider.Spider，不进入 SiteManager，避免单例污染。

---

## 3. 数据模型对齐

### 3.1 Kazumi Plugin JSON Schema（v8 兼容）
- api：规则 schema 版本，大于 8 拒绝导入。
- name：唯一标识，必填非空。
- baseURL：站点根 URL（注意大写 URL）。
- searchURL：含 @keyword 占位符。
- searchList/searchName/searchResult：XPath 搜索三件套。
- chapterRoads/chapterResult：XPath 剧集两件套。
- searchMode/chapterMode：xpath 或 api。
- searchApiConfig/chapterApiConfig：API 模式配置。
- userAgent/referer：播放下载请求头。

### 3.2 Python 内部模型
- SearchItem：name, src。
- Road：name, data（剧集 URL 列表）, identifier（剧集名称列表）。
- PluginSearchResponse：plugin_name, data。
- RuleExecutionConfig：plugin_name, base_url, use_post, search_mode, chapter_mode, search_url, search_list, search_name, search_result, chapter_roads, chapter_result, search_api_config, chapter_api_config, anti_crawler_config, user_agent, referer。

### 3.3 与 CatVod 模型映射
- Kazumi Plugin 对应 CatVod Site，但独立存储，key 为 kazumi:name。
- Kazumi SearchItem 无 vod_id/vod_pic，仅 name/src。
- Kazumi Road 对应播放线路，但 data 是播放页 URL，非直链。
- Kazumi 无 detailContent，详情页仅展示标题，无简介封面。

关键差异：Kazumi 规则没有详情页概念，searchResult 直接得到番剧详情页 URL，chapterResult 从详情页提取剧集播放页 URL。没有 vod_id/vod_pic/vod_content，只有标题和链接。

---

## 4. 后端改造（Python）

### 4.1 新增文件结构
```
python-backend/
  kazumi/
    __init__.py
    models.py          数据模型
    plugin.py          Plugin 类：序列化、执行入口
    xpath_strategy.py  XPath 策略（lxml）
    api_strategy.py    API 策略（受限 JSONPath）
    rule_engine.py     RuleEngine：搜索剧集编排
    plugin_manager.py  PluginManager：规则 CRUD、持久化
    utils.py           normalize_episode_url、UA 池、异常
  tests/
    test_kazumi.py     单元测试（glm5.2 编写）
```

### 4.2 PluginManager 规则管理
- 持久化：~/.video-pc/kazumi/plugins.json，单文件存储全部规则。
- 加载时机：server.py create_app 时初始化，与 SiteManager 并列。
- 线程安全：threading.Lock 保护规则列表读写。
- 导入校验：api 小于等于 8；name 非空唯一；模式必须为 xpath 或 api；XPath 模式五件套非空；API 模式 URL 非空且 JSONPath 合法。
- 启用禁用：增加 enabled 字段默认 true，禁用后不出现在聚合搜索与详情页弹窗。

### 4.3 RuleEngine 规则执行
- search(config, keyword, cancel_token) 返回 RuleSearchTrace。
- query_chapters(config, source_url) 返回 RuleChapterTrace。
- HTTP 执行器：requests，超时 10 秒，headers 带 referer 与 UA。
- 取消：threading.Event 软取消，超时丢弃结果。

### 4.4 XPathRuleStrategy
- 使用 lxml.html 解析。
- root.xpath(searchList) 得节点列表，逐节点 xpath(searchName) 与 xpath(searchResult)。
- 取链接 node.get(href)，取文本 node.text_content().strip()。
- 所有 href 必须经 normalize_episode_url(base_url, raw)。
- 错误处理：XPath 语法错误抛 XPathRuleFormatException；节点缺名称或链接记入 diagnostics 跳过；全部失败抛 NoResultException。

### 4.5 ApiRuleStrategy
- 受限 JSONPath：仅支持 $ . [index|*|key]，禁止递归下降与过滤器。
- 新增依赖 jsonpath-ng（锁定版本，写入 requirements.txt）。
- 模板渲染：URL/headers/query/body 支持 @variable 占位符，URL 中变量需 quote 编码。
- 剧集解析两种格式：nested（JSON 树）与 delimited（分隔字符串，兼容 $$$/#/$）。
- episodePage 模板：从响应变量构造播放页 URL。

### 4.6 URL 归一化
完全对齐 Kazumi Dart 实现：去空白、相对路径 urljoin、同站协议统一、去尾斜杠、去空 query、幂等。

### 4.7 新增 API 端点（/kazumi/action）
- kazumiList：列出全部规则。
- kazumiAdd：导入或更新规则（参数 json）。
- kazumiRemove：删除规则（参数 name）。
- kazumiToggle：启用禁用（参数 name, enabled）。
- kazumiSearch：聚合搜索全部启用规则（参数 keyword），并行查询，单规则异常不影响整体。
- kazumiChapters：解析剧集线路（参数 pluginName, src）。
- kazumiResolve：返回 pageUrl 与播放 headers（userAgent, referer），由前端 Player 走 captureDirect。

---

## 5. 前端改造（Electron 渲染层）

### 5.1 新增文件
- src/renderer/js/kazumi.js：规则管理、搜索、弹窗逻辑。

### 5.2 修改文件
- index.html：新增设置页 Kazumi 板块、详情页 Kazumi 源弹窗。
- panels.js：设置页导航注册。
- search.js：聚合搜索合并 Kazumi 结果。
- detail.js：详情页 Kazumi 源按钮与弹窗。
- player.js：Player.play 支持 kazumi: 前缀源。
- ui.css：新增弹窗样式（复用 md-dialog）。

### 5.3 设置页 Kazumi 规则管理
- 位置：设置页一级导航新增 Kazumi 规则，位于源设置之后系统之前。
- 导入规则卡片：textarea 粘贴规则 JSON 或 kazumi:// 分享链接，导入按钮，从剪贴板导入按钮，成功失败 toast。
- 已安装规则卡片：列表展示规则名、版本、启用开关、删除按钮，删除前 confirmDialog 确认，空态提示。

### 5.4 详情页 Kazumi 源弹窗
- 触发：详情页播放线路区下方新增一行按钮「选择 Kazumi 源」，仅当存在已启用规则时显示。
- 弹窗内容：标题、加载状态、按规则分组的结果列表（规则名、结果数、影片名列表）。
- 用户点击影片名后，调 kazumiChapters 解析剧集，弹窗切换为线路与剧集列表。
- 用户点击剧集后，关闭弹窗，调 Player.play(site='kazumi:规则名', flag='线路名', id='播放页 URL', ...)。
- Player.play 检测到 site 以 kazumi: 开头时，先调 kazumiResolve 取 pageUrl 与 headers，再调 vpc:captureDirect 抓真实流，最后交 mpv。

### 5.5 搜索页聚合
- 现有 CatVod 聚合搜索走 SSE /search/stream。
- Kazumi 搜索走 /kazumi/action do=kazumiSearch，并行执行。
- 前端同时发起两个请求，结果合并渲染：CatVod 结果在上，Kazumi 结果在下（或按到达顺序追加，来源标记 kazumi:规则名）。
- Kazumi 结果卡片无封面，显示占位图与规则名徽章。

---

## 6. 播放链路改造

### 6.1 渲染层 Player.play 改造
- 入参 site 为 kazumi:规则名 时，进入 Kazumi 播放分支。
- 先调 /kazumi/action do=kazumiResolve 取 pageUrl 与 headers。
- 再调 window.vpc.captureDirect(pageUrl) 抓真实视频流（主进程隐藏 BrowserWindow 拦截 m3u8/mp4）。
- 抓到直链后，与规则 headers 合并，交 mpv 播放。
- 连播：Kazumi 源同样支持渲染层驱动连播，episodes 列表由 kazumiChapters 返回的 data 与 identifier 组装。

### 6.2 主进程改造
- 无需新增 IPC，复用现有 vpc:capture-direct。
- 可选优化：captureDirect 增加自定义 UA/Referer 传入（当前版本从页面请求头抓 Referer）。

---

## 7. 规则管理 UI 详细设计

### 7.1 设置页导航
- 新增 data-cat=kazumi，文案 Kazumi 规则。
- 插入位置：源设置之后，系统之前。

### 7.2 导入规则卡片
- 标题：导入 Kazumi 规则。
- 说明：粘贴规则 JSON 或 kazumi:// 分享链接；规则需符合 Kazumi v8 schema。
- 输入：textarea，高 120px，占位符示例。
- 按钮行：导入规则（filled）、从剪贴板导入（tonal）、清空（text）。
- 导入流程：解析 JSON（或 base64 解码 kazumi:// 链接）→ 前端校验 name/api 版本 → 调 kazumiAdd → 成功刷新规则列表，失败显示错误原因。

### 7.3 已安装规则卡片
- 标题：已安装规则（N）。
- 列表行：左侧规则名与版本，中间启用开关，右侧删除按钮。
- 开关切换：调 kazumiToggle，立即生效。
- 删除：confirmDialog 确认后调 kazumiRemove，刷新列表。

---

## 8. 潜在 Bug 与预防措施

### 8.1 XPath 上下文错误
- 现象：搜索或剧集解析结果为空。
- 原因：Kazumi XPath 是相对节点查询，若在错误上下文执行会找不到节点。
- 预防：严格区分 root 查询与节点内查询；单元测试覆盖典型规则（enlie、DM84）。

### 8.2 URL 归一化不一致
- 现象：同一集在不同入口 URL 不同，导致历史记录或连播错乱。
- 预防：统一使用 normalize_episode_url；单元测试覆盖相对路径、协议混用、尾斜杠场景。

### 8.3 并发搜索锁竞争
- 现象：聚合搜索时 Kazumi 规则结果长时间不返回。
- 原因：与 CatVod 搜索共享线程池或锁。
- 预防：Kazumi 使用独立 ThreadPoolExecutor，max_workers 限制为 5，与 CatVod 搜索隔离。

### 8.4 JSONPath 注入或死循环
- 现象：恶意规则导致解析卡死或异常。
- 预防：受限 JSONPath 白名单校验，禁止递归下降与过滤器；jsonpath-ng 解析超时保护（虽库本身无超时，但表达式复杂度受限）。

### 8.5 播放页 URL 与直链混淆
- 现象：mpv 尝试播放 HTML 页面失败。
- 预防：Player.play 检测到 kazumi: 前缀时强制走 captureDirect；captureDirect 仅接受 http/https 且非媒体后缀页面。

### 8.6 规则持久化文件损坏
- 现象：plugins.json 损坏导致后端启动失败。
- 预防：加载时 try/catch，损坏时备份为 plugins.json.bak 并初始化为空列表；写入时用临时文件加原子替换。

### 8.7 前端弹窗状态残留
- 现象：关闭 Kazumi 源弹窗后再次打开显示旧数据。
- 预防：弹窗打开时清空上次结果；搜索与剧集解析用 token 防过期回调。

### 8.8 设置页导航冲突
- 现象：新增 Kazumi 板块后设置页布局错乱。
- 预防：复用现有 settings-nav 与 settings-grid 结构，新增 data-setcat 与卡片样式与现有板块一致。

---

## 9. 测试验收清单（glm5.2 负责编写）

### 9.1 后端单元测试（python-backend/tests/test_kazumi.py）
- Plugin JSON 序列化与反序列化（含缺失字段默认值）。
- XPath 策略：enlie 规则搜索解析、DM84 规则剧集解析。
- API 策略：nested 与 delimited 两种格式解析。
- URL 归一化：相对路径、绝对路径、协议混用、尾斜杠、空 query。
- PluginManager：导入、删除、启用禁用、持久化、损坏恢复。
- RuleEngine：并发搜索、单规则失败不影响其他、超时丢弃。

### 9.2 前端集成测试
- 设置页导入规则、删除规则、启用禁用。
- 详情页 Kazumi 源弹窗打开、搜索、选源、解析剧集、播放。
- 聚合搜索同时返回 CatVod 与 Kazumi 结果。
- 播放器对 kazumi: 前缀源正确走 captureDirect。

### 9.3 回归测试
- 现有 CatVod 配置加载、搜索、详情、播放、下载、直播全部正常。
- npm run test:all 全绿。

---

## 10. 交付物与验收标准

### 10.1 交付物
- python-backend/kazumi/ 目录全部 Python 模块。
- python-backend/tests/test_kazumi.py 单元测试。
- src/renderer/js/kazumi.js 前端模块。
- index.html、panels.js、search.js、detail.js、player.js、ui.css 修改。
- requirements.txt 新增依赖锁定。
- 本文件（KAZUMI_INTEGRATION.md）。

### 10.2 验收标准
- 可导入 Kazumi 规则并出现在规则列表。
- 详情页可通过 Kazumi 源播放影片。
- 聚合搜索结果包含 Kazumi 源。
- 现有 CatVod 功能零回归。
- 单元测试覆盖率大于 80%，集成测试全部通过。

---

## 11. 补充注意事项（根据用户描述追加）

### 11.1 文档先行
本文件是 glm5.2 编码的唯一依据，任何接口或数据结构变更必须先更新本文件，再改代码。

### 11.2 最小侵入
新增代码不得修改现有 CatVod 链路任何文件（app.py、runner.py、base/spider.py、config.py、site_manager.py 等），所有 Kazumi 逻辑放在独立模块。

### 11.3 错误隔离
Kazumi 规则解析失败不得影响 CatVod 站点；单条规则异常不得影响其他规则。

### 11.4 性能
Kazumi 聚合搜索并行度限制为 5，避免与 CatVod 搜索争抢后端线程池。

### 11.5 安全
规则 JSON 导入时校验 api 版本与必填字段，拒绝恶意或损坏规则；播放页 URL 必须经 captureDirect 验证为真实媒体流后才交 mpv。

### 11.6 日志规范（后端控制台）
Kazumi 引擎关键步骤（规则导入、搜索、剧集解析、播放解析）须输出日志到后端控制台，格式统一为 `[kazumi] <操作>: <详情>`，便于排查。

### 11.7 版本兼容（apiLevel 变更）
当前对齐 Kazumi v2.2.6（apiLevel 8），后续升级 apiLevel 时需同步更新校验逻辑与本文件；规则导入时若 api 大于 8 必须明确拒绝并提示用户。

### 11.8 依赖管理（requirements 锁定）
新增 Python 依赖 jsonpath-ng 必须锁定具体版本并写入 requirements.txt；安装前需验证与 Python 3.14 兼容性；禁止引入需要编译的 C 扩展（除已存在的 lxml/quickjs-ng）。

### 11.9 代码审查清单（强制，提交前逐项核对）
- [ ] 未修改 app.py、runner.py、base/spider.py、config.py、site_manager.py 等 CatVod 核心文件。
- [ ] 新增 Python 代码全部位于 python-backend/kazumi/ 目录。
- [ ] 新增前端代码全部位于 src/renderer/js/kazumi.js，修改文件仅限 index.html、panels.js、search.js、detail.js、player.js、ui.css。
- [ ] 新增依赖已锁定版本并写入 requirements.txt。
- [ ] 关键步骤已输出日志（规则导入、搜索、剧集解析、播放解析）。
- [ ] 规则持久化文件损坏时有备份与恢复逻辑。
- [ ] 单元测试覆盖率大于 80%，集成测试全部通过。
- [ ] 现有 CatVod 功能零回归（npm run test:all 全绿）。

### 11.10 回滚方案（备份/分支）
- 开发前在 master 分支打 tag 标记 pre-kazumi，便于快速回退。
- 每个模块完成后提交一次 commit，commit 信息前缀为 [kazumi]。
- 如出现严重问题，可执行 `git reset --hard pre-kazumi` 回退到整合前状态。
- 规则文件 plugins.json 每次写入前自动备份为 plugins.json.bak。

### 11.11 Git 版本控制（已确认策略）
- 直接在 master 分支开发，不新建 feature 分支。
- 开发前先提交现有未跟踪/未提交变更（PROGRESS.md 修改、docs/ 新增）。
- 按模块分步提交：后端 kazumi/ 包 → 后端 API 端点 → 前端 UI → 播放链路 → 测试。
- 每步完成后运行 npm run test:all 确认无回归。

### 11.12 开发顺序与分工（已确认）
- 按模块分步实施，每步可独立验收。
- 前端代码：kimi 负责 UI 布局/样式/交互，glm5.2 负责后端 API 与前端数据逻辑。
- 后端代码：glm5.2 负责全部实现。
- 测试代码：glm5.2 负责编写与执行。
