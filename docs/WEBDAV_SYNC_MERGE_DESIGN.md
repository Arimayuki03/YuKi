# WebDAV 同步冲突策略与双向合并 · 设计文档（暂缓实现）

> 状态：**合并/冲突策略仅设计，未排期**；「载荷版本标识 + 同步内容范围」已于 2026-10 落地
> （见「载荷版本与同步内容范围」节，其后各节仍为未实现设计）。
> 本文档是多设备数据一致性（冲突策略/双向合并）的唯一设计来源；实现前如需调整策略，
> 先改这里再动代码。

## 目标

多设备（如台式机 + 笔记本）通过同一 WebDAV 地址同步时，解决当前「上传即覆盖云端、恢复即覆盖本地」造成的静默丢数据问题：

- 设备 A 新收藏的影片不被设备 B 的定时上传覆盖掉云端记录；
- 设备 B 能拿到设备 A 最近新增的收藏/历史，而不是只在手动「从云端恢复」时整份替换；
- 合并过程可预期：同一条目两端都改过时有明确的胜负规则。

## 当前行为（2026-08 实现；2026-09/2026-10 安全语义与内容范围修订）

| 操作 | 行为 | 数据丢失场景 |
|---|---|---|
| 同步到云端（含定时自动同步） | 本地全量快照 PUT 覆盖云端。**0.2.5 起**上传侧排除敏感键（bangumiToken、dandanAppSecret 等不进云端快照）。**2026-10 起**上传后追加写版本文件 `_meta.json`（见下节） | B 设备定时器触发时，用旧数据覆盖 A 刚上传的新数据 |
| 从云端恢复（含启动时自动恢复） | 云端快照覆盖本地（覆盖前有本机备份）。**0.2.5 起（P2-5）**恢复落盘收敛为**显式允许表**（默认拒绝）；**2026-10 起**允许表扩到 85 个纯数据键并新增「已知但故意不恢复」表（共三张表，见下节）。`lastConfigUrl` 等链接类键不再可被云端改写 | 本地未同步过的独有修改被清掉 |
| 子开关 | 控制哪些数据文件参与传输 | 不涉及冲突判定 |

已有但与合并无关的安全垫：恢复前自动备份到本机设置键 `webDavRestoreBackup`（2026-10 起覆盖设置通道的全部将写键，不再只有收藏/历史/统计）；「测试连接」可提前发现配置错误。

> **实现注意（2026-09）**：双向合并落地时，写入路径同样必须收敛到 0.2.5 的「上传排除表 + 恢复允许表」语义（`kazumi.js` `WEBDAV_SETTINGS_EXCLUDE` 与 settings 白名单），不得回退为整文件无差别覆盖。

## 载荷版本与同步内容范围（2026-10 已实现）

本节记录「同步内容对齐软件最新数据模型」这一版的落地口径。**不含任何合并/删除语义**——
双向合并与冲突策略仍按下文「策略设计」暂缓，本节内容与之正交。

### 载荷版本标识：独立 `_meta.json`（schemaVersion）

远程目录里每个数据键仍是 `<name>.json`（顶层形态不变），额外多一个 `_meta.json`：

```json
{ "app": "YuKi", "schemaVersion": 2, "appVersion": "…", "createdAt": "…Z",
  "files": ["favorites", "history", "kazumiRules", "settings", "watchStats"] }
```

- **为什么不把版本塞进每个数据文件**：塞进去就要给 payload 加一层信封，老版本客户端读
  `favorites.json` 会拿到一个对象而非数组（`Array.isArray` 判定失败 → 报「数据格式不正确」），
  新旧备份双向可读性直接断掉。独立文件则让数据文件保持原样，老客户端顶多不认识这个新文件。
- **写入顺序**：数据文件先写、`_meta.json` 最后写（PUT）。中途失败时云端不会出现
  「元信息自称新版、数据文件却残缺」的错配。
- **版本号语义**：`1` = 旧版载荷（没有 `_meta.json`）；`2` = 本版载荷。
- **兼容策略（硬约束）**：读取侧把「`_meta.json` 缺失（404）、读取异常、JSON 非法、结构异常、
  `schemaVersion` 非法」全部视为 **v1**，只记 warning，恢复照常进行——用户的历史备份必须继续
  可用，绝不因为读不到版本就拒绝恢复。`schemaVersion` 高于本机（如 99）时**也照常恢复**，
  仅在结果里提示「更高版本生成，本机不认识的数据项会被忽略」（拒绝会让用户彻底拿不到数据）。
  `_meta.json` 永不进 `files`：它不是可恢复的数据项，混进去会让「云端全 404 却提示恢复成功」
  的老问题复发。
- **appVersion 来源**：后端读环境变量 `YUKI_APP_VERSION`（未注入时为空串），只作诊断用，
  不参与任何判定。

### 三张表（`src/renderer/js/kazumi.js`）

| 表 | 用途 | 判定顺序 |
|---|---|---|
| `WEBDAV_SETTINGS_EXCLUDE` | 上传侧：设置快照**不带**这些键 | 组快照时 |
| `WEBDAV_RESTORE_ALLOWED` | 恢复侧：**只**恢复表内键（85 键） | 第一档 |
| `WEBDAV_RESTORE_DENIED` | 恢复侧：已知但**故意**不恢复（静默忽略，不计数上报） | 第二档；都不在 = 未知键 |

一致性约束（`tests/js/kazumi-webdav-payload.test.js` 静态断言）：

1. `ALLOWED ∩ EXCLUDE = ∅`、`ALLOWED ∩ DENIED = ∅`（交集=死键或自相矛盾）；
2. `ALLOWED ⊆ SETTINGS_SET_ALLOWED`（主进程白名单，否则 `settingsSet` 被静默 ignored，
   恢复看着成功实则没落盘——H-1 同类）；
3. `SETTINGS_SET_ALLOWED` 的每个键都落在三表之一 —— 否则恢复自己的备份会冒出
   「N 项本机不识别已忽略」的假警报（第三张表就是为此存在）。

### 本版纳入/排除的键（逐个决策）

| 键 | 决策 | 理由 |
|---|---|---|
| `searchHistory` | 恢复允许 | 搜索历史，纯用户数据 |
| `kazumiAliasMap` | 恢复允许 | Kazumi 别名检索表，用户手工沉淀；写侧已收敛到 500 键 |
| `favoritesSort`/`favoritesFilter`/`historySort`/`historyFilter` | 恢复允许 | 排序/筛选偏好：属用户配置、体量小（一字符串 + 一小对象）、无 URL/凭据风险 |
| `opEdSkip`/`opEdSave` | 恢复允许（补漏） | 此前上传了却不在允许表 → 「云端有值、恢复后开关不生效」 |
| `translateEnable`/`Trigger`/`Target`、`translateLLMEnable`/`Model`、`kazumiAutoUpdateOnStart` | 恢复允许（补漏） | 同上，均为无 URL/无凭据的本地偏好；`translateLLMBase`/`captchaLLMBase` 属 URL 类，仍不放行 |
| `bangumiLastSyncAt` | **上传+恢复双排除** | 「本机与远端上次对齐的时刻」：跨设备恢复会让另一台机器的增量判定错位（明明没同步过却以为已对齐，跳过应传的改动），属机器相关键 |
| `webDavEnable` 及全部 `webDav*` | **上传+恢复双排除** | 本机「同步哪些内容、怎么连远端」的配置；随快照走等于让拿到快照的人改写本机连接行为。此前只排除了 Url/Username/Password，本版补齐 |
| `mpvPath`/`externalPlayerPath`/`onboarded`/`logLastCleanupAt` | 上传+恢复双排除 | 本机绝对路径 / 本机首启状态与日志水位 |
| `proxyUrl`/`proxyEnable`/`lastConfigUrl`/`configHistory`/`probeSourceUrl`/`proxyTestUrl`/`bangumiMirrorRoot`/`captchaLLMBase`/`translateLLMBase` | 恢复拒绝（上传保留或排除） | 连接目标类：恢复即等于让云端快照改写本机把凭据发往哪里、下次启动加载哪个配置源 |
| `dlConcurrency`/`dlSplitConcurrency`/`panFastPath`/`logLevel`/`logAutoCleanup`/`logCleanupDays` | 恢复拒绝 | 与另一台机器的带宽/磁盘/调试需求强相关 |

注：`opEd` 的**片头/片尾记录本体**存在 localStorage（`yuki_oped_skip_v1`），不走 settings
快照通道，本版只同步两个开关；记录跨设备迁移是后续独立课题。

### 恢复容错口径（本版加强）

- **缺键保留本地**：只遍历云端携带的键，云端没带的键保持本机现状（绝不用 `undefined` 覆盖）。
- **未知键**→ 忽略并计入报告（键名列表）；**已知拒绝键** → 静默忽略（只进明细日志）。
- **类型/结构不符** → 跳过该键并给出可诊断原因（`期望数组，实际是对象` 等），不影响其余键；
  形态表只对「错了会真出错」的容器键硬校验（数组/对象/标量槽位），宁可少拦也不误拦。
- **单键失败不拖垮整批**：每个设置键、每条规则、每个独立通道各自 try/catch；主进程返回
  `{ignored:true}`（白名单未放行）也升级为「写入失败」上报，而不是静默成功。
- **结果上报**：toast 只放计数（「N 项类型不符已跳过 / N 项本机不识别已忽略 / N 项写入失败」），
  明细（键名+原因+版本号）进 console 与 `Kazumi._lastWebdavRestoreReport`。

### 服务端请求地址策略

- 只允许 `http`/`https`：`file://`、`ftp://`、`dict://` 等一律拒绝并给出中文原因（这些 scheme
  在 requests 里没有适配器，放行只会抛英文 `InvalidSchema`）。渲染层先校验一次（省掉注定失败的
  往返），后端 `_webdav_sync_dir` 再校验一次（防绕过）。
- **环回/私有/保留地址全部放行**（本场景主流用法就是自建 NAS/内网 WebDAV），只在 UI/日志给出
  可理解的提示（内网地址、明文 http、地址内嵌凭据）。取舍与理由见交付报告。

### 本次明确不做（边界）

- 不做自动删除 / 墓碑（删除仍不参与同步，与下文硬约束一致）；
- 不做双向合并、不做冲突裁决、不引入 `webDavConflictStrategy`；
- 不做远端变更探测（无 ETag/If-Match/版本向量）；
- 不做「检测到云端更新自动拉取」。版本标识只解决「这个备份是哪一版格式」，
  不承担「谁的数据更新」的判定——那是合并设计的事。

## 数据结构与合并键（实测自现行代码）

| 数据 | 云端文件 | 条目结构要点 | 天然去重键 | 时间戳 |
|---|---|---|---|---|
| 收藏 favorites | favorites.json | `{uid, site, siteName, vodId, name, pic, remarks, tag, ts, bangumiId?}`，上限 200 | `site` + `vodId`（字符串化比较） | `ts`（毫秒） |
| 历史 history | history.json | 浏览卡 `kind:'view'` 与播放日志卡 `kind:'play'`（每次播放独立成条）；播放统计字段 `playCount/lastPlayTs/lastEpisode/lastDuration`；上限 200 | view 卡按片名小写去重（现行 addHistory 规则）；play 卡按 `uid` 全局唯一 | `ts` / `lastPlayTs` |
| 观看统计 watchStats | watchStats.json | `{totalSeconds, sessionCount, titles:{}, daily:{}, bySite:{}}`，纯计数器 | 键本身（titles 片名 / daily 日期 / bySite 源名） | 无（不可比新旧） |
| Kazumi 规则 kazumiRules | kazumiRules.json | `Plugin` 对象：`name` 必填唯一、`version`、`enabled`、`updated_at`（ISO-8601）、`validity` 等 | `name`（小写比较，与 plugin_manager toggle/remove 一致） | `updated_at` |
| 设置快照 settings | settings.json | 全量设置减去 `WEBDAV_SETTINGS_EXCLUDE`；2026-10 起含搜索历史、别名表、收藏/历史排序筛选、观看进度等（逐键决策见前一节） | 键本身 | 无（逐键讨论） |
| 版本标识 _meta | \\_meta.json | `{app, schemaVersion, appVersion, createdAt, files}`；路由与合并无关，仅用于兼容读取 | — | `createdAt` |

## 硬约束（决定方案边界）

1. **无墓碑（tombstone）**：favorites/history 均无删除标记。「A 设备删除了条目」与「B 设备新增了条目」在数据上无法区分。因此合并只能做**并集优先**——删除不参与同步；要支持删除同步需引入墓碑表或版本向量，成本高，本期不做。
2. **全量快照上传无版本对抗**：PUT 直接覆盖云端对象，无 If-Match/ETag 检查。两台设备同时上传时后写者胜，中间那次写会丢。家庭规模（2~3 台设备、分钟级间隔）下概率低，接受该窗口，不在本期引入版本向量/版本对抗。
   （2026-10 补注）本期已引入 `_meta.json` 版本**文件**，但它只标识「备份格式版本」（schemaVersion=1 旧 / 2 新），用于兼容读取旧备份，不参与冲突判定、不做版本向量——与本条约束不冲突。
3. **200 条上限**：favorites/history 合并后仍须截断到 200，截断规则必须确定性（按 ts 降序保留），否则两设备各自截断结果不同，下一轮合并又产生漂移。
4. **观看统计是近似值**：计数器求和意味着两端都看过同一影片时会双计。watchStats 定位是趣味统计而非账本，接受近似并在 UI 文案注明。

## 策略设计

### 策略选择（新增设置键 `webDavConflictStrategy`）

| 值 | 含义 | 适用 |
|---|---|---|
| `'merge'`（默认） | 双向并集合并，冲突按数据类型取新 | 多设备日常使用 |
| `'cloud'` | 以云端为准 = 现 restore 语义 | 换机迁移、以某台设备为权威源 |
| `'local'` | 以本地为准 = 现 sync 语义 | 单设备用户、刻意回滚 |

UI 形态：WebDAV 卡片内下拉框（替代隐式行为），文案「冲突处理」。子开关继续控制哪些数据参与传输，两者正交。

### 各数据类型合并算法（strategy='merge' 时）

合并发生在渲染层（数据读写都在 settings），后端仅传输字节，不改接口。

```
mergeUpAndDown(cloud, local):
    merged = merge(local, cloud)
    写回本地 merged            # 合并对本地也生效，保证两端口径一致
    PUT merged 到云端          # 上传的是合并结果，不是本地原样
```

即「同步到云端」「从云端恢复」「定时自动同步」「启动时自动恢复」四个入口在 merge 策略下全部走同一函数，只是触发方式与提示强度不同。

#### favorites（收藏）

```
key(it)      = String(site) + '\u0000' + String(vodId)
newer(a, b)  = (a.ts||0) >= (b.ts||0) ? a : b
merged       = 并集：两端所有 key
               两端都有 → newer 胜（tag/name/pic 整条取新，不做字段级融合）
               排序     → 按 ts 降序；超 200 截断
```

不做字段级融合的理由：tag 变更伴随 ts 刷新（setFavTag 会更新吗？见「待确认项」），整条取新可保证 tag/name/pic 不出现跨版本拼接。

#### history（历史）

```
view 卡：key = name.trim().toLowerCase()   # 与现行 addHistory 去重口径完全一致
         两端都有 → ts 新者胜，playCount 等统计随整条走
play 卡：key = uid                          # genUid 全局唯一，天然并集
         按 ts 降序排列，超 200 截断（view/play 混合统一排序）
```

注意：recordPlay 会清同片名 view 卡。合并后可能出现「一端 view + 另一端 play 同片名」共存——按现行语义 play 优先，合并时若同名 play 卡存在则丢弃另一端的 view 卡。

#### watchStats（观看统计）

```
totalSeconds / sessionCount        → 相加
titles / daily / bySite            → 按键求和（数值字段逐键相加）
```

已知失真：两端看同一影片双计。可选缓解（本期不做）：daily 只取 max。

#### kazumiRules（规则）

```
key(r)        = r.name.trim().toLowerCase()
conflict      → updated_at 新者胜；updated_at 缺失/相等 → 本地胜（保守，避免远端坏规则覆盖本地可用规则）
导入路径不变   → 仍逐条走 kazumiAdd（后端做校验与持久化），合并逻辑只决定"送哪些条"
```

### 备份与回退

- merge 策略下同样先写 `webDavRestoreBackup`（现机制复用，把「将被合并覆盖的本地原值」存档），toast 提示保持一致。
- 合并是幂等的：对相同输入重复执行结果不变，重试安全。

## 设置与 UI 变更清单（实现时）

- 设置键：`webDavConflictStrategy`（'merge' 默认 / 'cloud' / 'local'），进主进程 `SETTINGS_SET_ALLOWED` 白名单；**不加入** `WEBDAV_SETTINGS_EXCLUDE`（策略本身应随设置同步，两端口径一致才不抖）。
  （2026-10 更新）：本版已把**全部** `webDav*` 键排除出快照（机器绑定配置）。该键落地时需显式二选一：
  换成不带 `webDav` 前缀的键名，或在排除表里为它开例外并在注释里写明「策略需随同步走」的理由——
  否则会先被上传侧排除、再被恢复侧拒绝，表现为「换设备后策略又回默认」。
- index.html WebDAV 卡片：子开关区之后加「冲突处理」下拉框，说明文案更新。
- kazumi.js：新增 `_webdavMerge(cloudData, localSettings)` 纯函数 + 四个入口改走它；`WEBDAV_SETTINGS_EXCLUDE`、payload 组装不动。

## 待确认项（实现前核实）

1. `setFavTag` 更新已有条目 tag 时是否刷新 `ts`（影响收藏 tag 冲突能否用 ts 正确裁决；若不刷新，需要先补一行 `it.ts = Date.now()` 再上线合并）。
2. Kazumi 规则 `updated_at` 在「编辑规则」路径是否可靠刷新（同上同理）。
3. 启动自动恢复 + 定时上传同时开启时，首轮合并的先后顺序（建议：启动拉取完成前挂起下一次自动上传，避免拉取中途上传半成品——渲染层单线程串行 await 天然满足，确认无并行入口即可）。

## 剩余验收项（实现完成的定义）

- [ ] 三策略单测：favorites 同 key 异 tag/ts、history view/play 混合、watchStats 求和、rules updated_at 裁决，各至少 2 用例（放 `tests/js/`，沿用现有 jsunit 风格）。
- [ ] 双端回环手测清单写入 TEST_REPORT.md：A 加 B 删（删除不同步，符合预期）、A/B 同时改同一收藏 tag（ts 新者胜）、B 离线一天后上线（并集完整）。
- [ ] 「冲突处理」下拉切换后立即生效且随设置同步到另一端。
- [ ] 后端回归 run_all ALL PASS（本次改动不应触及 python-backend，若有触及需说明原因）。
