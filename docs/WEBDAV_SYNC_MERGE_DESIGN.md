# WebDAV 同步冲突策略与双向合并 · 设计文档（暂缓实现）

> 状态：**仅设计，未排期**。本文档是多设备数据一致性（冲突策略/双向合并）的唯一设计来源；
> 实现前如需调整策略，先改这里再动代码。

## 目标

多设备（如台式机 + 笔记本）通过同一 WebDAV 地址同步时，解决当前「上传即覆盖云端、恢复即覆盖本地」造成的静默丢数据问题：

- 设备 A 新收藏的影片不被设备 B 的定时上传覆盖掉云端记录；
- 设备 B 能拿到设备 A 最近新增的收藏/历史，而不是只在手动「从云端恢复」时整份替换；
- 合并过程可预期：同一条目两端都改过时有明确的胜负规则。

## 当前行为（2026-08 实现）

| 操作 | 行为 | 数据丢失场景 |
|---|---|---|
| 同步到云端（含定时自动同步） | 本地全量快照 PUT 覆盖云端 | B 设备定时器触发时，用旧数据覆盖 A 刚上传的新数据 |
| 从云端恢复（含启动时自动恢复） | 云端全量快照覆盖本地（覆盖前有本机备份） | 本地未同步过的独有修改被清掉 |
| 子开关 | 控制哪些数据文件参与传输 | 不涉及冲突判定 |

已有但与合并无关的安全垫：恢复前自动备份到本机设置键 `webDavRestoreBackup`；「测试连接」可提前发现配置错误。

## 数据结构与合并键（实测自现行代码）

| 数据 | 云端文件 | 条目结构要点 | 天然去重键 | 时间戳 |
|---|---|---|---|---|
| 收藏 favorites | favorites.json | `{uid, site, siteName, vodId, name, pic, remarks, tag, ts, bangumiId?}`，上限 200 | `site` + `vodId`（字符串化比较） | `ts`（毫秒） |
| 历史 history | history.json | 浏览卡 `kind:'view'` 与播放日志卡 `kind:'play'`（每次播放独立成条）；播放统计字段 `playCount/lastPlayTs/lastEpisode/lastDuration`；上限 200 | view 卡按片名小写去重（现行 addHistory 规则）；play 卡按 `uid` 全局唯一 | `ts` / `lastPlayTs` |
| 观看统计 watchStats | watchStats.json | `{totalSeconds, sessionCount, titles:{}, daily:{}, bySite:{}}`，纯计数器 | 键本身（titles 片名 / daily 日期 / bySite 源名） | 无（不可比新旧） |
| Kazumi 规则 kazumiRules | kazumiRules.json | `Plugin` 对象：`name` 必填唯一、`version`、`enabled`、`updated_at`（ISO-8601）、`validity` 等 | `name`（小写比较，与 plugin_manager toggle/remove 一致） | `updated_at` |

## 硬约束（决定方案边界）

1. **无墓碑（tombstone）**：favorites/history 均无删除标记。「A 设备删除了条目」与「B 设备新增了条目」在数据上无法区分。因此合并只能做**并集优先**——删除不参与同步；要支持删除同步需引入墓碑表或版本向量，成本高，本期不做。
2. **全量快照上传无版本对抗**：PUT 直接覆盖云端对象，无 If-Match/ETag 检查。两台设备同时上传时后写者胜，中间那次写会丢。家庭规模（2~3 台设备、分钟级间隔）下概率低，接受该窗口，不在本期引入版本文件。
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
