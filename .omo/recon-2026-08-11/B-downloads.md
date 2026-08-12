# 侦查记录 B — 下载页

来源：explore agent `bg_58f5e013`（只读，未改动文件）

## 结论先行：三个「缺失按钮」其实都已存在，速度也已经在渲染

用户报告的三项功能均已实现并接线完毕，真正待办只有**间距**与**按钮尺寸统一**，以及 **HLS 任务速度恒为 0**。

## DOM 结构

`src/renderer/index.html:272-294`，整页是 `.downloads-wrap` 里的单个 `.tool-card`：

```
276  .tool-card-title            下载管理
277  .tip-line.pad0              提示文案
278  .search-bar > #dl-uri       链接输入框
281  .wall-row (style="margin-top:8px")   ← 工具栏行
282    #dl-add          md-btn md-btn-filled          新建下载
283    #dl-add-file     md-btn md-btn-tonal           种子文件
284    #dl-open-dir     md-btn md-btn-sm md-btn-tonal 打开下载目录
285    #dl-speed        .dl-speed (display:none)
286    .dl-spacer
287    #dl-clear-failed md-btn md-btn-sm md-btn-tonal 删除失败下载
288    #dl-clear        md-btn md-btn-sm md-btn-tonal 清除已完成
290  #dl-tip .tip-line (display:none)
291  #dl-list .dl-list
```

卡片模板（渲染器生成）`downloads.js:197-201`：`.dl-item` > `.dl-item-top`（`.dl-name` + `.dl-status`）、`.dl-bar` > `.dl-bar-fill`、`.dl-item-bottom`。

### 相关 CSS（全在 `src/renderer/css/ui.css`，唯一样式表，`index.html:9`）

- `ui.css:604` `.wall-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px; }`
- `ui.css:631-635` `.tool-card { padding:18px 20px; margin-bottom:16px; border-radius:16px; }`
- `ui.css:743-744` `.search-bar { display:flex; gap:12px; margin-bottom:8px; }`，`.md-input` 高 48px
- `ui.css:1086` `.downloads-wrap { max-width:980px; margin:0 auto; }`
- `ui.css:1087` `.downloads-wrap .search-bar { margin-bottom:6px; }`
- `ui.css:1093` `.dl-spacer { flex:1; }`
- `ui.css:1095` `.dl-speed { font-size:13px; font-weight:600; color:var(--md-primary); }`
- `ui.css:1096` `.dl-list { display:flex; flex-direction:column; gap:10px; }`
- `ui.css:1097` `.dl-item { background:var(--md-surface-container); border:1px solid var(--md-outline-variant); border-radius:14px; padding:12px 16px; }`
- `ui.css:1098` `.dl-item-top`、`ui.css:1104` `.dl-bar`、`ui.css:1106` `.dl-item-bottom`、`ui.css:1107` 卡内按钮高 28px

## 重合的真实原因

排除项（均已核查、均不成立）：

- 下载路径上无 `position: sticky/absolute/fixed`；唯一 `position` 是 `.md-btn { position:relative }`（`ui.css:155`）供自身 ripple `::after`（`ui.css:160-167`）使用，并被 `overflow:hidden`（`ui.css:156`）裁剪
- 下载区无任何 `z-index`
- 全文件除 `@keyframes sslide`（`ui.css:761`）外无负 margin

**真实缺陷是零垂直间距**：`.wall-row` 有 `margin-top:8px` 但**没有 `margin-bottom`**（`ui.css:604`）；`#dl-tip` 是 `display:none` 不占位；`.dl-list` **没有 `margin-top`**（`ui.css:1096` 只设了 display/flex-direction/gap）。于是第一张 `.dl-item`（1px 边框、14px 圆角、与卡片同底色）紧贴在 40px 高按钮行的下边缘，间距 0px——两个圆角带边框的同色面板贴在一起，视觉上就是重合。界面缩放设成小数时（`common.js:770-772` 会写 `html { zoom:1.1 }` 之类）还会出现真实 1px 渗色，因为 40px 按钮高度对齐 flush 卡片边缘时子像素取整不保证落在设备像素上。

加剧因素：该行混用 40px 与 32px 两种按钮，`align-items:center` 使 32px 的居中，整行视觉重心相对 8px 上边距偏低。

**修复面**：`ui.css:1096` 给 `.dl-list` 加 `margin-top:12px`（或给 `.wall-row` 加 `margin-bottom`）。`index.html` 无需改动。

## 按钮清单与处理器

全部在 `downloads.js:30-36` 的 `init()` 内绑定（首次 `enter()` 时懒执行一次）：

| id | 文案 | html | 处理器 | 后端 |
|---|---|---|---|---|
| `dl-add` | 新建下载 | `index.html:282` | `downloads.js:71-86 addUri()` | `vpc:dl` action `add`/`addHls`（m3u8 嗅探 `downloads.js:76`）→ `index.js:1079`/`1099` |
| `dl-add-file` | 种子文件 | `index.html:283` | `downloads.js:88-92 addFile()` | `vpc:dl` `addFile` → `index.js:1119` |
| `dl-open-dir` | 打开下载目录 | `index.html:284` | `downloads.js:62-69 openDir()` | `vpc:dl-open-dir` → `index.js:1194` |
| `dl-clear-failed` | 删除失败下载 | `index.html:287` | `downloads.js:102-108 clearFailed()` | `vpc:dl` `clearFailed` → `index.js:1159`（同时删残留分片） |
| `dl-clear` | 清除已完成 | `index.html:288` | `downloads.js:94-99 clearDone()` | `vpc:dl` `clear` → `index.js:1175` |

卡内动态按钮 `downloads.js:187-196`，由 `onAction()`（`downloads.js:110-121`）按 `data-act`/`data-gid` 分派：`pause`、`unpause`、`play`、`remove`。`remove` 与两个清除动作都过 `confirmDialog`（`downloads.js:96,103,117`）。

`打开下载目录` 链路确认使用 `shell.openPath`：`preload.js:65 openDir()` → `index.js:1193-1201`（目录取 `dl.dir || settings.get('dlDir') || app.getPath('downloads')`）。

设置 → 下载 里还有一个重复的「打开下载目录」：`index.html:568`（`#set_dl_open`），处理器 `panels.js:1097-1102`，走同一 channel。

## 下载速度

**aria2c 走 JSON-RPC，不解析 stdout**。进程以 `stdio:'ignore'` 启动（`downloader.js:90`），进度来自 `aria2.tellActive/tellWaiting/tellStopped`（`downloader.js:119-146,188-191`）。

`downloader.js:196-218 flatten(s)` 定义发往渲染器的确切载荷：

```
gid, status, name, total(totalLength), done(completedLength),
percent, speed(downloadSpeed 字节/秒),
connections(numSeeders 存在时为 "connections/numSeeders"),
errorMessage, files
```

未发送：**`eta`**（aria2 不返回，需自算 `(total-done)/speed`）、`uploadSpeed`、`uploadLength`、`dir`、`numPieces`、`bitfield`。

**HLS 路径速度恒为 0**：`hls-downloader.js:271-277 _flatten()` 硬编码 `total:0, done:0, speed:0, connections:''`。唯一进度信号是 ffmpeg stderr 的 `time=HH:MM:SS.xx`（`hls-downloader.js:200-207`）对预探测时长求百分比。若要 HLS 速度，需读同一行被丢弃的 `size=` 字段并做时间差分，再经 `_flatten` 暴露。

恢复的历史记录也强制 `speed:0`（`index.js:1013`）。

**渲染器已经在两处显示速度**（并非缺失）：

- `downloads.js:140-142` 聚合读数写入 `#dl-speed`：仅当存在 `active` 任务且 `speed>0` 时 `.show()`，否则 `.hide()`
- `downloads.js:184-185` 每卡一行：`已下/总量 · 百分比 · N MB/s · 连线 x`

`fmtSize` 在 `common.js:412-418`（二进制单位 B→TB）。`#dl-speed` 默认 `display:none`（`index.html:285`），所以纯 HLS 或空闲页面永远不显示速度——这最可能是用户认为「没有速度显示」的原因。

## 新建下载按钮尺寸

`index.html:282` → `md-btn md-btn-filled`。

`ui.css:139-158`（基础）+ `ui.css:186-190`（filled）：
**高 40px、padding 0 24px、font-size 14px、line-height 20px、border-radius 20px、font-weight 500**，另有 `white-space:nowrap`、`flex-shrink:0`、`position:relative`、`overflow:hidden`。

`种子文件`（`index.html:283`）已匹配。不匹配的三个只因多带 `md-btn-sm`（`ui.css:199`：高 32px / padding 0 16px / radius 16px / 13px）。删掉这三处的 `md-btn-sm` 即完全一致，无需改 CSS。≥2000px 时两种变体已同步放大（`ui.css:1462-1463`：`.md-btn`→48px/16px、`.md-btn-sm`→40px/15px），故 4K 下仍一致。另有按容器覆写尺寸的先例：`ui.css:596`（`.settings-grid .md-btn`）。

## 列表刷新机制（速度读数的挂载点）

推送式，1 秒间隔，完全由主进程驱动。`index.js:1019-1042 startDlPoll()`：

- `index.js:1022-1028` 启动即立刻推一次（空闲自停下进入下载页仍能立即看到历史任务）
- `index.js:1029` `setInterval(..., 1000)`
- `index.js:1037-1039` **空闲自停**：无 `active/waiting/paused` 任务时 `clearInterval`

完整链路：

1. `app.js:29` `showView('downloads')` → `Downloads.enter()` → `init()` 一次（`downloads.js:24-26`）
2. `downloads.js:38` 订阅 `window.vpc.download.onList` → `preload.js:67` `ipcRenderer.on('vpc:dl-list')`；主进程 `send()` 在 `index.js:165-167`
3. `downloads.js:45` `control('init')` → `index.js:1052-1061` 调 `startDlPoll()`；`pickDir`/`add`/`addHls`/`addFile`（`index.js:1076,1096,1116,1133`）也会重新拉起
4. 载荷 `buildDlList(items, hlsItems)`（`index.js:1005-1017`）合并实时 aria2 任务 + HLS 任务 + `DlRecordStore.all()` 持久历史（`dl-record.js:69-72`，文件 `<userData>/dl-records.json`，上限 200 条 `dl-record.js:15`）
5. `Downloads.render()`（`downloads.js:137-166`）做指纹 diff；`_fp`（`downloads.js:170`）**已含 `speed`**，故单卡速度变化会触发该卡 `outerHTML` 替换（`downloads.js:159`）而不重建列表

两条约束：

- **全局读数必须写在提前返回之前**。`render()` 在 `downloads.js:144-148`（空列表）与 `downloads.js:155`（指纹全未变）会 bail；现有 `#dl-speed` 更新（`downloads.js:140-142`）刻意放在两者之上
- **空闲时不再有 tick**。`index.js:1037-1039` 停表后渲染器完全收不到 `vpc:dl-list`，所以不要依赖持续 tick 来清零读数，应在收到的最后一个载荷里清

另有一次性事件 channel `vpc:dl-event`（`preload.js:69`，主进程 `index.js:1227/1232/1243/1248`），载荷 `{type:'completed'|'error', task}`，仅用于 toast（`downloads.js:39-42`）与系统通知，不是进度通道。

## 建议改动（最小化）

1. 重合：`ui.css:1096` `.dl-list` 加 `margin-top:12px`
2. 按钮等大：删除 `index.html:284,287,288` 的 `md-btn-sm`；或按 `ui.css:596` 先例加作用域规则
3. 速度常显：去掉 `downloads.js:141` 的 `speed > 0` 条件，空闲渲染 `总速度 0 B/s`
4. HLS 速度需改 `hls-downloader.js:202` 正则捕获 `size=` 并在 `:274` 暴露——这是主进程实质改动，不只是 CSS
5. `删除失败下载` 会真删磁盘文件（`index.js:1167`），可考虑用现成的 `md-btn-danger-tonal`（`ui.css:208`）

注：以上重合诊断基于 CSS 盒模型阅读，未实际运行 Electron 截图确认。
