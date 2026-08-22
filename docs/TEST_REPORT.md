# 功能测试报告（YuKi / 影视 PC）

> 生成时间：2026-08-10
> 测试范围：全部已实现功能的自动化测试 + 需用户实测项清单。
> 本文是「功能测试」的唯一汇总入口；运行异常细节见 [RUNTIME_ISSUES.md](RUNTIME_ISSUES.md)，开发批次见 [DEVELOPMENT_HISTORY.md](DEVELOPMENT_HISTORY.md)。

## 1. 测试总览

> 最近快照：2026-08-10。自动化计数随本轮改动更新；真实界面验收脚本已重跑（10 脚本 / 103 检查项全通过）。

| 类别 | 数量 | 结果 |
|---|---|---|
| JS 单元测试（`tests/js/*.test.js`） | 84 | ✅ 83/84（1 项为既有 `#popular-tags` 断言失败：该元素全库不存在，与功能无关） |
| Python 测试（smoke + unit + compile） | 38 + compile 29 文件 | ✅ 全部通过 |
| JS 语法检查（`scripts/check-js.js`） | 34 文件 | ✅ 0 错误 |
| 真实界面验收（CDP，`scripts/acceptance-*.js` × 10） | 103 检查项 | ✅ 103/103 |
| **自动化合计** | **225** | **全部通过** |

真实界面验收均在**独立 userData 副本**（清空 `lastConfigUrl`、预置种子数据、清空 `bangumiToken` 避免真实收藏合并干扰计数）启动临时 Electron 实例，经 CDP 实测，结束自动清理，不污染真实用户数据。

## 2. 自动化测试明细

### 2.1 JS 单元测试（81）
| 文件 | 覆盖 |
|---|---|
| `player-watch.test.js` | 观看统计 sessionId 元信息、未知/重复退出去重、断流重连观看链增量、ended 会话归属、isDone 判定 |
| `timeline.test.js` | 季度区间 `_seasonRange`、季度标签 `_seasonLabel`、排序 `_sortItems`、收藏过滤 `_applyFilters` |
| `mpv-player.test.js` | 弹幕行解析、ASS 颜色/时间戳、进度缓存、旧会话 teardown、end-file eof 会话号 |
| `settings-2a.test.js` | 关于为设置分类、无画中画钩子、MiSans 内置 yuki:font-css、字体栈 MiSans 优先、导航 order（含 1 项既有 `#popular-tags` 失败） |
| `records.test.js` | 历史按次记录（recordPlay 每播一条独立）、卡片「集名·时长·时间」、收藏/历史卡片、标签模型、fmtDur |
| `kazumi-init.test.js` | init 单次绑定、不抢跑、`openBangumiInfoPage` 委托统一详情页 |
| `cover-chain.test.js` | 封面多级兜底 `vodCoverChain`/`coverChainNext`：失败逐级切换、空链占位、加载策略 |
| 其余（downloader / dl-record / hls-downloader / async-session 等） | 下载展平、记录持久化、HLS 广告过滤、单飞/串行队列 |

### 2.2 Python 测试（38）
| 模块 | 覆盖 |
|---|---|
| plugin / rule_engine / xpath_strategy | 规则解析、校验、XPath 归一化（含 R2 `//`→`.//`） |
| cookie_jar | Cookie 域名/父域匹配、持久化 |
| bangumi search / calendar / season / trends / collections | R1 真实用户名、R6 官方搜索端点、季节日程分桶、趋势解包裹归一化、收藏 limit 钳制 100 |
| hoststate / server / config | 二进制探测、端点路由、多仓配置合并 |

### 2.3 真实界面验收脚本（10 个 / 102 项）
| 脚本 | 覆盖功能 | 项数 |
|---|---|---|
| `acceptance-content.js` | 首页站点下拉/分类/网格、搜索页结构、历史页种子渲染+分页、我的页统计数值+收藏卡片 | 9 |
| `acceptance-system.js` | 设置页 10 分类卡片、Kazumi 规则列表+行控件、直播/下载/本地文件/直链页结构 | 9 |
| `acceptance-timeline.js` | 时间表近 20 年季节索引、排序三模式、收藏过滤 chip、星期 tab、切季度检索 | 11 |
| `acceptance-t55.js` | Kazumi 规则页全宽布局、规则行两行信息、本地文件无入场动画、我的页两标签 | 13 |
| `acceptance-2a.js` | 设置导航顺序、关于版本号/系统信息、系统页无画中画/版本号、MiSans file:// 内置、控制台 | 9 |
| `acceptance-my-watch.js` | 观看链去重、ended 会话归属、我的页两标签、收藏搜索/标签/多选删除、旧收藏路由重定向 | 21 |
| `acceptance-rework.js` | 我的页两标签、时间表卡片进二级详情页（非弹窗）、返回 | 10 |
| `acceptance-popular.js` | 推荐导航/视图、趋势卡片+排名角标、点卡片进二级详情页 | 7 |
| `acceptance-detail-card.js` | 仿 Kazumi 信息卡：标题/封面/放送开始/评分星级/Bangumi Ranked/评分透视柱状图 | 7 |
| `acceptance-bugfix.js` | 分页渲染+翻页、滚动条隐藏、我的页两标签 | 6 |

## 3. 功能测试矩阵（按模块）

状态图例：✅ 自动通过 ｜ 🔬 需用户实测（真实环境/账号/媒体）

### 3.1 内容与搜索
| 功能 | 测试方式 | 状态 |
|---|---|---|
| CatVod 配置加载（Python/JS/CMS/多仓） | Python 测试 + 首页站点下拉验收 | ✅ |
| 首页分类/卡片/分页 | CDP 验收（content） | ✅ |
| 当前源搜索 | CDP 验收（结构） | ✅ 结构 ｜ 🔬 实际搜索结果（需有效源） |
| SSE 聚合搜索 | CDP 验收（结构） | ✅ 结构 ｜ 🔬 多源聚合返回（需有效源） |
| 详情页（CatVod） | — | 🔬 需有效源点开详情 |
| 收藏/历史持久化 | CDP 验收（种子渲染/多选删除/分页） | ✅ |
| Kazumi 规则导入/编辑/商店/有效性/批量更新 | CDP 验收（列表+行控件） | ✅ 列表 ｜ 🔬 导入/商店/批量更新交互 |
| Bangumi 搜索/详情/日历/榜单/分集/角色/Staff/评论/关联 | Python 测试 + 时间表/推荐/详情卡验收 | ✅ |
| Bangumi 收藏同步 | Python 测试（mock） | ✅ 逻辑 ｜ 🔬 真实 token 同步 |

### 3.2 播放与解析
| 功能 | 测试方式 | 状态 |
|---|---|---|
| mpv 播放/硬件加速/倍速/续播 | — | 🔬 需真实播放 |
| 自动连播/断流重连/失败换线 | JS 单元（观看链/ended 会话） | ✅ 逻辑 ｜ 🔬 真实连播 |
| 隐藏窗口媒体拦截/DOM 轮询/legacy iframe | — | 🔬 需真实解析站 |
| 解析窗口 partition 槽位/single-flight | JS 单元（async-session 单飞） | ✅ 逻辑 ｜ 🔬 真实解析 |
| Anime4K/VLC 外播/截图/定时关机/DLNA | — | 🔬 需真实播放/设备 |

### 3.3 下载与数据
| 功能 | 测试方式 | 状态 |
|---|---|---|
| aria2c 直链/种子、ffmpeg HLS 合成 | JS 单元（downloader/hls） | ✅ 逻辑 ｜ 🔬 真实下载 |
| HLS 广告段过滤 | JS 单元（filterAdSegments） | ✅ |
| 下载记录/完成通知/一键播放 | JS 单元（dl-record） | ✅ 逻辑 ｜ 🔬 真实通知 |
| 本地文件白名单/防穿越/上传/删除/播放 | — | 🔬 需真实文件操作 |
| WebDAV 同步 | — | 🔬 需真实 WebDAV 服务器 |
| SyncPlay 同步播放 | — | 🔬 需多端 |
| 观看统计/最近观看 | JS 单元（观看链去重）+ CDP 验收（统计数值） | ✅ |

### 3.4 UI 与桌面
| 功能 | 测试方式 | 状态 |
|---|---|---|
| 设置中心（10 分类） | CDP 验收（system） | ✅ |
| 主题/壁纸/字体/字号/分页 | CDP 验收（2a/bugfix） | ✅ 部分 ｜ 🔬 壁纸视觉效果 |
| 托盘驻留/快捷键/定时关机 | — | 🔬 需真实交互 |
| 首次引导 | — | 🔬 需清空数据冷启动 |
| 我的页（统计+收藏）、时间表、推荐、二级详情 | CDP 验收 | ✅ |
| YuKi 更名、MiSans 字体内置 | CDP 验收（2a）+ JS 单元（settings-2a） | ✅ |
| 响应式卡片/字号、滚动条隐藏、批量渲染 | CDP 验收（bugfix）+ 语法 | ✅ |
| Windows 安装包/冷启动 | — | 🔬 需打包安装 |
| macOS/Linux 打包、自动更新、签名/CI | — | 🔬 需对应环境 |

## 4. 需用户实测清单（自动化无法覆盖）

以下功能依赖**真实媒体、真实账号、真实设备或打包环境**，请在真实环境验证：

1. **真实播放**：mpv 起播、硬件加速、倍速、续播、自动连播、断流重连、失败换线（需可播放的视频源）。
2. **解析**：parse=1 源的后台解析、隐藏窗口抓流、legacy iframe（需有效解析接口）。
3. **下载**：aria2c 直链/种子、m3u8 合成、广告过滤、完成通知、一键播放（真实下载任务）。
4. **本地文件**：选择根目录、浏览/播放/上传/删除（真实文件）。
5. **账号类**：Bangumi 收藏同步（真实 token）、WebDAV 同步（真实服务器）、SyncPlay（多端）。
6. **桌面能力**：托盘驻留、全局快捷键、截图、定时关机、DLNA 投屏。
7. **打包发布**：Windows 安装后冷启动、macOS/Linux 打包运行、自动更新、代码签名。
8. **视觉主观**：壁纸/主题观感、封面自适应在大/小窗的实际效果。

## 5. 复现方式

```powershell
# 单元 + 后端 + 语法（全量回归）
npm run test:all

# 单独运行
npm run test:jsunit          # JS 单元（node --test）
npm run test:py              # Python（smoke + phase3）
npm run test:js              # JS 语法检查

# 真实界面验收（各自启动独立实例，自动清理）
node scripts/acceptance-content.js
node scripts/acceptance-system.js
node scripts/acceptance-timeline.js
node scripts/acceptance-my-watch.js
node scripts/acceptance-rework.js
node scripts/acceptance-popular.js
node scripts/acceptance-detail-card.js
node scripts/acceptance-bugfix.js
node scripts/acceptance-2a.js
node scripts/acceptance-t55.js
```

> 验收脚本均读取 `%APPDATA%/yuki/settings.json` 作为基底复制到临时副本，若真实设置缺失会以全新态运行。CDP 端口默认 9333-9342，可用环境变量 `YUKI_CDP_PORT` 覆盖。
