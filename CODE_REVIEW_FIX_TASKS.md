# 代码审查修复任务清单(详细步骤版)

> 配套文档: `CODE_REVIEW.md`(问题编号定义:H=高危 / M=中危 / L=低危)
> 更新日期: 2026-08-17 · **全部六个工作流（A/B/C/D/E/F，64 项）已完成收口**；2 项按计划有意跳过（L-2/L-33）,每项含:定位 → 现状代码 → 修改步骤(带 before/after)→ 验证 → 注意事项

---

## 一、总体进度

| 工作流 | 范围(文件归属) | 状态 |
|--------|----------------|------|
| A. go-proxy + server | `python-backend/go_proxy.py` `server.py` `base/spider.py` `cache_store.py` `pan_cookies.py` | ✅ **全部完成**(17 项,含并发/集成自测) |
| E. Electron 主进程 | `src/main/*` `src/preload/*` | 🟡 主体完成(13 项),**剩 L-3/L-4/L-7/L-8/L-9 共 5 项** |
| F. 渲染层 | `src/renderer/js/*` | ✅ **全部完成**(13 项，2026-08-17；2.2 H-7/2.3 M-29 已由 B2 轮 ESLint 修复提前完成；L-32 季度语义测试断言同步更新) |
| B. jar 桥系列 | `python-backend/jar_bridge.py` `jar_spider.py` `site_manager.py` `jar-runner/SpiderRunner.java` `jar_patch.py` | ✅ **全部完成**(12 项，2026-08-17；SpiderRunner 已重编译，行为级验证：destroy 词不杀 JVM、__shutdown 优雅退出、重启上限生效) |
| C. config + QuickJS | `python-backend/config.py` `app.py` `runner.py` `cms_spider.py` `js-engine/quickjs_host.py` | ✅ **全部完成**(9 项，2026-08-17；4.4/4.5 由 C1/C2 批次提前覆盖，行为级验证：死循环拦截/恶意 key 清洗/ENTITY 拒绝/GBK 回退/签名预检) |
| D. Kazumi 规则引擎 | `python-backend/kazumi/*` `scripts/build-python.js` | ✅ **全部完成**(6 项，2026-08-17；from_json 按 **kwargs 实际形态调整方案——非法记录显式 ValueError 由 _load 逐条跳过，行为级验证：坏记录不清空/路径注入双重中和/29 处 verify 收紧) |
| V. 全局收尾验证 | 全部 | ✅ 完成（2026-08-17：Python 133 项 + JS 206 项 + Ruff/ESLint 0 错误 + jar 行为级验证全绿） |

**当前已修改未提交的 14 个文件**:
`python-backend/{base/spider.py, cache_store.py, go_proxy.py, pan_cookies.py, server.py}`、`src/main/{downloader.js, hls-downloader.js, index.js, mpv-player.js, pan-qr-window.js, parse-window.js, push-server.js, python-bridge.js, settings.js}`

**有意跳过(不再执行)**:L-2 probe-urls(直播源可能含合法内网地址)、L-33 CSP(需先迁移全部内联事件,单独立项)。

---

## 二、已完成项备忘(勿重做)

<details>
<summary>展开查看 A / E 已完成清单与实现要点</summary>

### 工作流 A(go-proxy + server)— 全部完成
H-1、H-5、H-2(go_proxy 11 处 + server 2 处)、H-8、M-11、M-20、M-21、M-22、M-23、M-28、L-14、L-15、L-16、L-17、L-18、L-19、L-21。
要点:`_reject_browser()` 来源防御(恶意 Origin / `Sec-Fetch-Site: cross-site` → 403);`_cookie_host_allowed()` 夸克/UC 域名白名单;TOKEN_EXEMPT 精确匹配;`/cache` 配额(单值 1MB / 总量 512MB);无长度分支先发 200 + Content-Type;`_fetch` end=None 开放区间;三处原子写(同目录临时文件 + `os.replace`,Windows 并发已压测);SSE 改 `shutdown(wait=False)` + 超时仍发 done;`_qget/_qpost` 全局锁 + 每次响应后清 cookie jar。py_compile 全过。

### 工作流 E(Electron 主进程)— 已完成 13 项
- **M-1** settings-set 键白名单(`SETTINGS_SET_ALLOWED`;路径键 externalPlayerPath/playerCacheDir/dlDir 排除)——⚠️ 收尾仍需终核(见任务 6 第 2 步)
- **M-2** addHls/hls.add 协议白名单 `/^https?:\/\//i`
- **M-3** push-server 首页不回显 token
- **M-4** pan-qr-window `contextIsolation: true, sandbox: true`
- **M-5** 主窗口移除 `sandbox: false`
- **M-6** 弹幕 ASS 花括号转义
- **M-7** 直播备用线路代际退出(`mpv.controlGen`)
- **M-8** `runQuitCleanup()` 抽取共用
- **M-9** 边下边播扩展名补点号
- **M-10** hls 文件名 basename 校验 + `_segsDir` 带 gid
- **H-9** python-bridge / downloader exit 回调闭包守卫 + `_spawn` 前重置 `info`
- **L-1** vpc:play 协议白名单 + vpc:dl-play 路径限制
- **L-5** 敏感键 safeStorage 透明加解密
- **L-6** parse/capture-direct 超时取消传播(parse-window.js 支持 abort)

</details>

---

## 三、通用工作规范(每个执行者必读)

1. **串行执行**:子代理一次只跑一个任务(1→2→3→4→5→6),文件归属不得越界。
2. **先读后改**:动手前 Read 目标代码确认问题仍在;文中行号为快照,可能漂移 ±20 行,以"现状代码"特征定位为准。
3. **最小 diff**:不重排、不重格式化无关代码;新增注释一律简体中文,风格与项目一致。
4. **语法验证**:JS 改完执行 `node --check <file>`;Python 改完执行 `python-backend/.venv/Scripts/python.exe -m py_compile <file>`。
5. **不 git commit**;测试产生的临时文件用完即删。
6. 修改若与文档方案冲突(如实际代码已不同),以实际代码为准,报告中注明偏差。

---

## 四、任务 1:E 剩余 5 项(Electron 主进程)

> 可改文件:`src/main/*`。以下行号为 2026-08-16 当前快照。

### 1.1 L-3 dlna SOAP XML 注入 + controlUrl 任意端点

**定位**:`src/main/dlna-caster.js` — 30 行设备表 `this.devices = new Map(); // location -> { name, controlUrl }`;103-127 行 `cast()`;143 行起 `stop()`;两处 SOAP 报文模板中 `<CurrentURI>${mediaUrl}</CurrentURI>` 直接插值;`_sendSoap()`(~144)向任意 `controlUrl` 发 POST。

**现状代码**(cast 内):
```js
const soap = `<?xml version="1.0" encoding="utf-8"?>
...
      <CurrentURI>${mediaUrl}</CurrentURI>
```

**修改步骤**:
1. 文件顶部(http/https require 之后)新增工具函数:
   ```js
   /** XML 实体转义(L-3):SOAP 报文插值防注入。 */
   function escXml(s) {
       return String(s == null ? '' : s)
           .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
           .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
   }
   ```
2. `cast()` 报文中 `<CurrentURI>${mediaUrl}</CurrentURI>` → `<CurrentURI>${escXml(mediaUrl)}</CurrentURI>`(模板里若有其他远端值插值一并包裹;`CurrentURIMetaData` 当前为空标签不用动)。
3. `cast()` 的 Promise 构造器体首行加 controlUrl 校验:
   ```js
   // L-3:controlUrl 必须属于本次 SSDP search 发现的设备,拒绝向任意内网端点 POST
   const known = Array.from(this.devices.values()).some((d) => d && d.controlUrl === deviceControlUrl);
   if (!known) { reject(new Error('unknown dlna device')); return; }
   ```
4. `stop(deviceControlUrl)` 同样在发报文前校验,未知设备直接 `return Promise.reject(new Error('unknown dlna device'))`。

**验证**:`node --check src/main/dlna-caster.js`;人工核对——mediaUrl 含 `"`/`<` 时报文中出现 `&quot;`/`&lt;`;devices 为空或 controlUrl 不在表中时 cast/stop 拒绝。

**注意**:渲染层投屏流程是先 `search()` 再从设备列表选择 controlUrl,校验不影响正常路径;若存在"search 后未重新 search 直接投"的缓存流程,devices Map 常驻实例则仍命中。

### 1.2 L-4 PotPlayer 头值引号注入

**定位**:`src/main/index.js:2100-2104`(buildExternalPlayerArgs 内 PotPlayer 分支)。

**现状代码**:
```js
if (referer) args.push(`/referer="${referer}"`);
if (ua) args.push(`/user_agent="${ua}"`);
```

**修改(before → after)**:
```js
// L-4:头值转义引号("→""),防第三方源数据闭合参数注入 PotPlayer 开关
if (referer) args.push(`/referer="${String(referer).replace(/"/g, '""')}"`);
if (ua) args.push(`/user_agent="${String(ua).replace(/"/g, '""')}"`);
```

**验证**:`node --check src/main/index.js`;referer=`x" /newfile="c:\t` 时参数仍是单个带引号整体。

### 1.3 L-7 anime4k 下载前不建目录

**定位**:`src/main/index.js` — `downloadAnime4kOne` 110-127 行(`fs.writeFileSync(dest, buf)` 前无 mkdir);调用方 `ensureAnime4k` ~130 行起,持有 `const dir = path.join(RESOURCES_ROOT, 'vendor', 'anime4k');`。

**修改步骤**:在 `ensureAnime4k()` 取得 `dir` 之后、进入文件循环之前加一行:
```js
try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 只读目录时下载阶段自然失败并降级 */ }
```

**验证**:`node --check`;删除 `vendor/anime4k` 目录后启动应用,日志出现逐文件下载成功而非"全部镜像下载失败"。

### 1.4 L-8 HLS 任务重启恢复丢失请求头

**定位与现状**(三处配合):
- `src/main/hls-downloader.js:138` 任务对象已有 `header: header || null`;`list()`(540 行)经 `_flatten(t)` 输出——**先 grep `_flatten` 确认其返回字段是否包含 header,不含则补** `header: t.header || null`。
- `src/main/index.js:1449-1463` `persistInProgress`:`dlRecords.add({ gid, kind, name, files, size, done, percent, status, uri, completedAt })` — **未存 header**。
- `src/main/index.js:1627-1633` unpause 恢复:`hls.add({ url: rec.uri, out: rec.name, adFilter, concurrency })` — **未传 header**。
- `src/main/dl-record.js` `add(record)` 整对象入列表(unshift),**任意附加字段可持久化**,无需改 schema。

**修改步骤**:
1. `hls-downloader.js` 的 `_flatten`:确认/补上 `header: t.header || null`。
2. `persistInProgress` 的 `dlRecords.add({...})` 增加一行字段:
   ```js
   header: t.header || undefined,   // L-8:HLS 任务的 Referer/UA 随记录持久化,重启恢复不再 403
   ```
   (aria2 任务无此字段自然为 undefined,不落盘。)
3. unpause 恢复处 `hls.add({...})` 增加:
   ```js
   header: rec.header || undefined,
   ```
4. `grep -n "rec.uri" src/main/index.js` 检查是否还有其他恢复点漏传(有则一并补)。

**验证**:`node --check` 两个文件;带 Referer 的 m3u8 下载中重启应用 → 下载页 unpause → 任务恢复继续拉流(观察后端日志无 403)。

### 1.5 L-9 mpv command() 超时定时器不清理

**定位**:`src/main/mpv-player.js` — `command()` 415-430 行;应答处理 372-374 行;teardown 305 行。

**现状代码**(command 尾部):
```js
this._pending.set(id, { resolve, reject });
this.socket.write(JSON.stringify({ command: args, request_id: id }) + '\n');
setTimeout(() => {
    if (this._pending.has(id)) {
        this._pending.delete(id);
        reject(new Error('mpv ipc timeout'));
    }
}, 5000);
```

**修改步骤**:
1. `command()` 内改为持有 timer 并随 pending 存Map:
   ```js
   const timer = setTimeout(() => {
       if (this._pending.has(id)) {
           this._pending.delete(id);
           reject(new Error('mpv ipc timeout'));
       }
   }, 5000);
   this._pending.set(id, { resolve, reject, timer });
   this.socket.write(JSON.stringify({ command: args, request_id: id }) + '\n');
   ```
2. 应答处理(~372-374)在 delete 后补:
   ```js
   const p = this._pending.get(msg.request_id);
   this._pending.delete(msg.request_id);
   clearTimeout(p.timer);   // L-9:应答即清定时器,高频命令不累积
   ```
3. teardown(~305)拒绝 pending 时同步清:
   ```js
   for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error('mpv stopped')); }
   this._pending.clear();
   ```

**验证**:`node --check src/main/mpv-player.js`;播放中拖动进度条/连发变速命令,进程定时器句柄不增长(可用 `--inspect` 或长时间运行观察,人工复核代码逻辑即可)。

---

## 五、任务 2:F 渲染层 13 项(`src/renderer/js/*`)

> 这些文件自审查以来未被修改,审查报告中的行号与代码引用仍有效。

### 2.1 H-6 onerror 单引号注入(XSS)

**定位**:`common.js:64-66` escHtml;`kazumi.js:1527-1528`(选源弹窗 banner)、`kazumi.js:1624`(Bangumi 详情封面)。

**现状代码**(common.js):
```js
function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
```
(kazumi.js 两处均为:)
```js
<img ... onerror="if(!this.dataset.fb){this.dataset.fb=1;this.src='${escHtml(bangumiMirrorUrl(cover))}';}else{this.style.display='none'}">
```

**修改步骤**:
1. escHtml 链末追加单引号转义:
   ```js
   function escHtml(s) {
       return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
           .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
   }
   ```
2. 两处 img 改为**属性兜底链**,彻底去掉 JS 字符串拼接:
   ```html
   <img class="kazumi-bangumi-cover" src="${escHtml(cover)}" referrerpolicy="no-referrer"
        data-fb-src="${escHtml(bangumiMirrorUrl(cover))}"
        onerror="if(!this.dataset.fb){this.dataset.fb=1;this.src=this.dataset.fbSrc;}else{this.style.display='none'}">
   ```
   (1624 处 class 不同:`bangumi-info-cover`,外层 div 结构保持不变。`data-fb-src` 自动映射 `dataset.fbSrc`,无需额外 JS。)

**验证**:`node --check common.js kazumi.js`;构造 cover=`https://e/x';alert(1);'` 检查生成的 img 标签属性无逃逸、onerror 内无拼接字符串。

### 2.2 H-7 player.js `header` 未定义(parse=1 无法自动播放)

**定位**:`player.js:437`。

**修改(before → after)**:
```js
// before
const mergedHeader = {...header, ...(resolved.header || {})};
// after(CatVod 解析分支作用域内本无 header 变量,只保留解析器返回的头)
const mergedHeader = { ...(resolved.header || {}) };
```

**验证**:`node --check player.js`;找一个 parse=1 源播放,解析成功后 mpv 自动起播而非弹失败对话框。

### 2.3 M-29 detail.js `data` 出块作用域

**定位**:`detail.js:344-353`。

**修改步骤**:`let vod = ...` 同行级声明 `let data = null;`,块内改为赋值:
```js
let vod = _detailCacheGet(DETAIL_VOD_CACHE_PREFIX, cacheKey);
let data = null;
if (!vod) {
    data = await doAction('detailContent', { site: this.site, ids: JSON.stringify([this.vodId]) });
    vod = (data && data.list && data.list[0]) || null;
    if (vod) _detailCacheSet(DETAIL_VOD_CACHE_PREFIX, cacheKey, vod, DETAIL_CACHE_TTL);
}
if (!vod) {
    const err = data && data.error ? `（${String(data.error).slice(0, 120)}）` : '';
    ...
```

**验证**:`node --check detail.js`;断网/源失效时详情页显示"未取得详情(xxx 具体原因)"而非笼统失败。

### 2.4 M-30a search.js 聚合回调无令牌

**定位**:`search.js:265-279`(aggregateSearch 的 .then 回调)。

**修改步骤**:
1. 先读 `run()` 开头,若已有搜索令牌机制(如 `this._searchToken`)直接复用;否则在类中新增并在 `run()` 入口自增:
   ```js
   const myToken = ++this._searchToken;
   ```
2. `Kazumi.aggregateSearch(word).then((results) => {` 回调体首行加:
   ```js
   if (myToken !== this._searchToken) return; // M-30a:旧词在途回调不作数,防混入新词结果
   ```

**验证**:搜索 A 词,结果未回时立即搜 B 词;B 词页面不出现 A 词的 Kazumi 分组。

### 2.5 M-30b home.js 切源竞态写脏缓存

**定位**:`home.js` — `_fetchCat` 586-621、`_fetchHomeFeed` 400-444(两处同型);`_cachePut(this.site, ...)` 在 621 附近。

**修改步骤**(两个函数都做):
1. 函数入口(第一行)快照:
   ```js
   const site = this.site;
   const token = this._loadToken;   // M-30b:快照本次加载的源与令牌
   ```
2. `while` 循环体内**每个 `await` 之后**的第一行:
   ```js
   if (token !== this._loadToken || site !== this.site) return; // 切源即中止,旧窗口作废
   ```
3. 循环内 `doAction({ site: this.site, ... })` 与结尾 `_cachePut(this.site, ...)` 中的 `this.site` 全部替换为快照 `site`。
4. 对照 `loadCategory`(~563)已有的返回后令牌校验,确认语义衔接(返回后校验可保留作双保险)。

**验证**:`node --check home.js`;A 源分类加载途中切到 B 源,B 源同名 tid 不出现 A 源条目;后续浏览 B 源该 tid 缓存命中数据正确。

### 2.6 M-30c detail.js 评论/分集续拉无世代守卫

**定位**:`detail.js:1279-1295` `_loadMoreComments`;`687-690` `_renderBgmEpisodes` 内 `this._bgmEps = list`;世代标记 `_bgmExtraGen` 在 `_loadBgmExtra`(1229/1256 附近自增,先读确认)。

**修改步骤**:
1. `_loadMoreComments` 的 await 前记录、await 后校验:
   ```js
   const gen = this._bgmExtraGen;
   const more = await Kazumi.bangumiComments(...).catch(() => []);
   if (gen !== this._bgmExtraGen) return; // M-30c:已切到其他番剧,旧评论丢弃
   ```
2. `_renderBgmEpisodes` 中 `this._bgmEps = list` 赋值前同样校验(该函数若本身在 `_loadBgmExtra` 的世代保护内则确认保护覆盖到赋值行;不覆盖则补)。

**验证**:`node --check detail.js`;A 番吐槽页滚到底触发续拉后立刻点进 B 番,B 番吐槽列表不出现 A 的评论;勾选下载分集时 `_bgmEps` 均为本番。

### 2.7 M-30d panels.js listFile 无序号

**定位**:`panels.js:547-576`。

**修改步骤**:
1. 模块级(其他模块级变量旁)加 `let _listSeq = 0;`
2. `listFile` 入口:`const seq = ++_listSeq;`
3. `.then((info) => {` 回调首行:
   ```js
   if (seq !== _listSeq) { clearTimeout(loadingTimer); return; } // M-30d:旧目录迟到响应丢弃
   ```
   (注意旧响应分支也要清 loadingTimer,否则 loading 遮罩残留。)

**验证**:`node --check panels.js`;本地文件页快速连续进入两级目录再 Esc,界面目录与导航栈一致。

### 2.8 L-26 kazumi.js 委托处理器累积

**定位**:`kazumi.js:1671、1677、1691`(`_renderBangumiDetail` 内三处 `box.on('click', ...)`;box 为常驻 `#kazumi-dialog-body`)。

**修改步骤**:三处绑定改为命名空间,并在首处之前 off:
```js
box.off('.kbd');                                    // L-26:清上一轮弹窗的委托
box.on('click.kbd', '.kazumi-start-watch', (e) => { ... });   // 原 1671
box.on('click.kbd', '.kazumi-col-btn', async (e) => { ... }); // 原 1677
box.on('click.kbd', '.kazumi-tag', (e) => { ... });           // 原 1691
```
(保留各回调原逻辑不动;`_bindSheetEvents` 的 `.ks` 命名空间不受影响。)

**验证**:`node --check`;反复打开 Bangumi 详情弹窗 N 次,`box` 上的 click 委托数恒定(DevTools `getEventListeners` 或代码审阅确认)。

### 2.9 L-27 openEditorDialog 裸 await

**定位**:`kazumi.js:253-268`(`openEditorDialog`),及 `_editor_save` 内 `await window.vpc.settingsSet`(628 附近)。

**修改步骤**:
```js
let rsp = null;
try {
    rsp = await doAction('kazumiList', {}, '/kazumi/action');
} catch (e) { warnToast('规则列表读取失败'); return; }   // L-27:后端异常给出提示而非静默
```
`_editor_save` 的 settingsSet 调用外套 try/catch,失败 `warnToast('保存失败')` 并 return。

**验证**:`node --check`;停掉后端进程后点规则"✎",出现失败 toast。

### 2.10 L-28 数值字段未转义直插

**定位与修改**(四处,统一包 `escHtml(String(...))`):
```js
// common.js:277
data-id="${escHtml(String(item.id))}"
// kazumi.js:1730-1731
<span class="kazumi-detail-ep-no">${escHtml(String(ep.sort || ep.ep || ''))}</span>
// kazumi.js:1527
data-bangumi-id="${escHtml(String(info.id))}"
// kazumi.js:1646
data-id="${escHtml(String(info.id))}"
```

**验证**:`node --check`;grep 确认四处均已包裹。

### 2.11 L-29 FavHub 双重广播

**定位**:`records.js:28-30`(recSet,先读确认 favorites 时已调 `FavHub.changed`);`170-171`、`206-207` 两处显式调用。

**修改步骤**:确认 recSet 行为后,删除 170-171 与 206-207 两处显式 `FavHub.changed(...)` 调用(保留前面的 `await recSet(...)`)。

**验证**:`node --check`;点一次收藏,Network 面板中 Bangumi 收藏列表/时间表请求只发一轮。

### 2.12 L-30 封面补拉回写旧快照"复活"记录

**定位**:`records.js:585-592`(`onOne` 回调,`list` 为 render 开始时的快照)。

**修改(before → after)**:
```js
onOne: async (site, name, pic) => {
    if (!String(site).startsWith('kazumi:') || !name || !pic) return;
    // L-30:回写前重读当前记录再合并,防旧快照整体覆盖"复活"已删条目
    const cur = await recGet(storeKey).catch(() => []);
    const t = (cur || []).find((v) => v && !v.pic && String(v.site || '') === site && v.name === name);
    if (t) { t.pic = pic; recSet(storeKey, cur).catch(() => { }); }
},
```
(若 `fillMissingCovers` 的 onOne 不支持 async,改为同步入口 + 内部 fire-and-forget `(async () => {...})();`。)

**验证**:`node --check`;收藏含无封面条目 → 删除该条 → 等补拉完成,记录不复活。

### 2.13 L-31 warnToast 关键词过滤误伤汇总提示

**定位**:`common.js:659-681`(warnToast/errToast);受影响调用点 `my.js:65`、`kazumi.js:1981`(汇总类提示含"失败 N"字样)。

**修改步骤**:
1. warnToast 增加第二参,过滤只作用于普通调用:
   ```js
   function warnToast(msg, opts = {}) {
       // 错误提示开关只拦"错误语义"调用;汇总类(opts.summary)与强制提示不受过滤
       if (!_errorToastOn && !opts.summary && /(失败|无法|不能|未找到|出错|错误|无效)/.test(String(msg))) return;
       ...
   ```
2. my.js:65 与 kazumi.js:1981 的汇总调用改为 `warnToast(msg, { summary: true })`(先读两处上下文确认消息构造)。

**验证**:`node --check`;关闭"应用内错误提示"后,同步汇总"已同步 Bangumi:上传 3 · 失败 1"仍可见。

### 2.14 L-32 季度边界 off-by-one

**定位**:`bangumi-search.js:160-171` `seasonToDateRange`;对照 `timeline.js:13` `SEASON_MONTH_START = {1:'01-01', 2:'04-01', ...}`。

**现状代码**:
```js
const start = new Date(year, startMonth - 2, 1);
const end = new Date(year, startMonth + 1, 1);
```

**修改步骤**:保持函数签名,改为标准季度半开区间(读上下文:入参可能是 startMonth 或季度 q,按实际形态等价实现):
```js
// startMonth 为该季度首月(1-based):区间 = [首月1日, 首月+3月1日)
const start = new Date(year, startMonth - 1, 1);
const end = new Date(year, startMonth + 2, 1);
```

**验证**:`node --check`;同一"2026 Q1"在 timeline 与 bangumi 搜索中过滤区间一致(1/1–4/1)。

---

## 六、任务 3:B jar 桥系列 12 项

> 可改文件:`python-backend/jar_bridge.py`、`jar_spider.py`、`site_manager.py`、`jar-runner/SpiderRunner.java`、`jar_patch.py`。文件未被改过,审查行号有效。**改 SpiderRunner.java 后必须重新编译**(见 6.5 验证)。

### 3.1 H-2(部分) jar 下载 verify

**定位**:`jar_bridge.py:647-651`。

**修改**:`rsp = requests.get(url, allow_redirects=True, timeout=timeout, verify=False)` → `verify=True`。

### 3.2 M-12 重复 `__init__` + `_call_lock` 竞态

**定位**:`jar_bridge.py:96-108`(第一个 `__init__`,被覆盖的死代码)、`341-352`(第二个,实际生效、**没有** `_call_lock`)、`500-506`(call 内懒初始化)。

**修改步骤**:
1. Read 96-108 与 341-352,确认第一个 `__init__` 确为死代码(被第二个覆盖)且无其他引用差异。
2. 整段删除第一个 `__init__`。
3. 在生效的 `__init__`(341 起)初始化区加:
   ```python
   self._call_lock = threading.RLock()   # M-12:构造即建锁,消除懒初始化并发竞态
   ```
4. `call()` 内懒初始化段(~500-506):
   ```python
   # before
   lock = getattr(self, '_call_lock', None)
   if lock is None:
       lock = threading.RLock()
       self._call_lock = lock
   with lock:
   # after
   with self._call_lock:
   ```
   (若注释解释了"兼容旧 pyc",一并删注释。)

**验证**:py_compile;`grep -n "def __init__" jar_bridge.py` 只剩一个;`grep -n "_call_lock" jar_bridge.py` 无 getattr 懒初始化残留。

### 3.3 M-13 jar 缓存同名错用

**定位**:`jar_bridge.py:169-173`。

**修改(before → after)**:
```python
# before
fname = os.path.basename(jar_url.split('?')[0]) or f'{site_key or "spider"}.jar'
dest = os.path.join(jar_dir, fname)
# after(内容寻址:URL 哈希前缀,不同源同名 jar 不再互相顶替)
base = os.path.basename(jar_url.split('?')[0]) or f'{site_key or "spider"}.jar'
fname = hashlib.sha1(jar_url.encode('utf-8')).hexdigest()[:10] + '_' + base
dest = os.path.join(jar_dir, fname)
```
(`hashlib` 顶部已 import,确认即可。旧缓存文件无需迁移——md5 不匹配或类找不到时会按新名重新下载。)

**验证**:py_compile;两个不同 URL 的同名 spider.jar 各自落盘为 `<hash>_spider.jar`。

### 3.4 M-14 `-jvm.jar` 转换产物不刷新

**定位**:`jar_bridge.py:277-281`。

**修改**:复用缓存前加 mtime 校验(参考同文件 `apply_jar_patches` 251 行的同类做法):
```python
if os.path.isfile(jvm_path) and os.path.getmtime(jvm_path) >= os.path.getmtime(jar_path):
    return JarBridge.apply_jar_patches(jvm_path)
```

**验证**:py_compile;替换同 URL 的 DEX jar(改内容)后重新加载,`-jvm.jar` 重新生成。

### 3.5 M-15 SpiderRunner `"destroy"` 子串杀进程

**定位**:`SpiderRunner.java:65-76` 主循环(应答写出后)。

**现状代码**:
```java
out.write(resp);
out.write("\n");
out.flush();
seedPanState(null);
// destroy 是终态：应答后退出进程（Python 侧 destroy 语义）
if (line.indexOf("\"destroy\"") >= 0) {
    break;
}
```

**修改步骤**:先读主循环确认已解析出的 method 变量名(请求 JSON 的 `method` 字段),然后:
```java
// M-15/M-17:按解析后的 method 判断,子串匹配会把搜索词 "destroy" 误判为终态;
// spider 级 destroy 只调 spider 清理、不再退出进程,进程退出统一走 __shutdown
if ("__shutdown".equals(method)) {
    break;
}
```
(即:原 `line.indexOf("\"destroy\"")` 分支删除,destroy 作为普通方法照常执行;新增 `__shutdown` 终态。)

**验证**:与 3.7 联动;单独验证——发 `{"method":"searchContent","key":"destroy",...}` 进程不退出。

### 3.6 M-16 jsonEscape 控制字符

**定位**:`SpiderRunner.java:555-570` `jsonEscape` 的 `default` 分支。

**修改**:
```java
default:
    if (c < 0x20) { sb.append(String.format("\\u%04x", (int) c)); }  // M-16:控制字符合法化
    else { sb.append(c); }
```

**验证**:单测思路——main 或临时用例:输入含 `\b\f\u0000` 的串,输出可被 `json.loads` 解析。

### 3.7 M-17 destroy 语义拆分(共享 JVM)

**涉及三处**:
1. `SpiderRunner.java`(见 3.5,已含)。
2. `jar_bridge.py` 的 `destroy()`(先 Read 定位,现实现应是 `call('destroy')` 后等进程退出):
   ```python
   def destroy(self):
       """进程级关停(M-17):发 __shutdown 应答后退出;spider 级 destroy 不再杀进程。"""
       ...  # 保留现有锁/proc 处理,把发出的 method 从 'destroy' 改为 '__shutdown'
   ```
3. `jar_spider.py:138-145` `JarSpider.destroy()` 与 `site_manager.py:74-80` `destroy_all()`:
   - JarSpider.destroy 保持 `bridge.call('destroy', class_name=...)`(spider 级清理,进程不退);
   - `destroy_all` 之后追加**进程级**关停:grep `_jar_bridges`(全局缓存 dict)的维护点,对其中 bridge 逐一 `destroy()`(新语义=__shutdown)并从缓存清除。若 destroy_all 语义即"全部卸载"(单配置应用),直接全量关停即可;若存在多配置共存,改为按本配置涉及的 bridge 关停。
   - 同时检查 jar_bridge 内部哪里从 `_jar_bridges` 淘汰条目(若无淘汰点,补:destroy 后 `pop`)。

**验证**:py_compile + SpiderRunner 编译(见 6.5);热重载配置后,同 jar 其他站点请求不再"杀-重启-杀"(观察日志无异常 JVM 退出/重启风暴)。

### 3.8 M-27a `_kill_proc` 重置重启上限

**定位**:`jar_bridge.py:600-606` `_kill_proc` 与 `_ensure_alive`(先读其 3 次上限实现)。

**修改步骤**:
1. `__init__` 增加 `self._crash_count = 0`。
2. `_kill_proc` 删除 `self._started = False` 之外,不再触碰计数(保留 `_started=False` 若有其他依赖,或按实际逻辑重构)。
3. `_ensure_alive` 的上限判断改用 `self._crash_count`:异常退出路径 +1,`>=3` 抛"重启上限";**成功就绪后清零**;显式 `ensure()`/手动 `destroy()` 后重开时清零。

**验证**:py_compile;构造写 stdin 即失败的坏 jar,重启 3 次后不再无限循环(日志可见上限报错)。

### 3.9 M-27b `last_error` 并发串台

**定位**:`jar_spider.py:163-171`(`self.last_error = ''` / `= str(e)[:300]`)。

**修改步骤**:类中把实例属性改为线程局部 + 属性转发:
```python
def __init__(self, ...):
    ...
    self._tls = threading.local()   # M-27b:错误随线程走,并发不串台(server 同线程读取)
    super().__init__()  # 若有继承链,按现有结构放置

@property
def last_error(self):
    return getattr(self._tls, 'last_error', '')

@last_error.setter
def last_error(self, v):
    self._tls.last_error = v
```
(先 Read 类结构确定插入位置;`import threading` 顶部确认。server.py 的 `_attach_jar_error` 读取 `spider.last_error` 经属性透明兼容,**不要改 server.py**。)

**验证**:py_compile;聚合搜索多源并发时,成功站点响应不再附带别的站点的错误。

### 3.10 L-10 cookie 明文落共享临时目录

**定位**:`SpiderRunner.java:181-201` `seedCookieFiles`(写 `%TMP%/vpc-jar-cache/TVBox/*`)。

**修改步骤**(先探明消费方):
1. `grep -rn "vpc-jar-cache\|quark_cookie" python-backend/jar-runner/ --include=*.java`,确认这些文件由谁读取(stubs/SharedPreferencesImpl 或 SpiderRunner 自身)。
2. **若路径仅 SpiderRunner/stubs 内部使用**(自包含):根目录改为用户私有:
   ```java
   File root = new File(System.getProperty("user.home"), ".video-pc" + File.separator + "jar-cache");
   ```
   同步修改所有引用该根路径的读取点。
3. **若 jar 内第三方代码也按旧路径读**(不自包含):保守加固——写完每个文件后:
   ```java
   f.setReadable(false, false); f.setReadable(true, true);
   f.setWritable(false, false); f.setWritable(true, true);
   ```
   并在 main 退出处(Shutdown hook 或 `__shutdown` 分支)删除整目录。
4. 报告中注明选择了哪条路径与依据。

### 3.11 L-12 jar_patch 恒假条件

**定位**:`jar_patch.py:150`。

**修改步骤**:Read 前后 30 行确认意图——该函数替换常量池 UTF8 字符串:
- 若替换要求等长(常见:避免重排常量池偏移):`if len(old_b) != len(new_b) or len(new_b) > 65535:`
- 若允许变长:改为空值拒绝 `if not old_b or not new_b or len(new_b) > 65535:`
按上下文(是否重算长度字段/偏移)选择,报告说明依据。

### 3.12 L-26 jar_spider 拼 URL 未编码

**定位**:`jar_spider.py:95-99、110-114`。

**修改步骤**:
```python
from urllib.parse import quote   # 顶部补
...
return {'url': 'http://127.0.0.1:9978/proxy?do=pan&site=quark&fileId=%s' % quote(str(folder), safe='')}
```
(两处 folder/fileId 插值全部包 quote;go_proxy 侧已改为单次解码,配套正确。)

**验证**:py_compile;fid 含 `&`/`#`/中文时 go_proxy 收到的 fileId 与原始一致。

---

## 七、任务 4:C config + QuickJS 9 项

> 可改文件:`python-backend/config.py`、`app.py`、`runner.py`、`cms_spider.py`、`js-engine/quickjs_host.py`。

### 4.1 H-2(部分) verify=True
`app.py:112-118`(`_fetch`)、`cms_spider.py:128`;`grep -n "verify=False" python-backend/app.py python-backend/cms_spider.py python-backend/trigger.py` 逐处改 True。

### 4.2 H-3 QuickJS 资源限额

**定位**:`js-engine/quickjs_host.py:141-153`(`JsEngine.__init__`)。

**修改步骤**:
1. 先探测 venv 实际 API(名称/单位以探测为准):
   ```bash
   python-backend/.venv/Scripts/python.exe -c "import quickjs; c = quickjs.Context(); print([m for m in dir(c) if 'limit' in m or 'stack' in m])"
   ```
2. `__init__` 的 `self.ctx = quickjs.Context()` 之后加(方法名按探测结果调整):
   ```python
   # H-3:远程 JS 源不可信——同步执行路径必须限额,防 while(true) 冻结后端
   try:
       self.ctx.set_time_limit(30)                    # 单次 eval/call 30s 硬上限
       self.ctx.set_memory_limit(256 * 1024 * 1024)   # 256MB
       self.ctx.set_max_stack_size(1024 * 1024)       # 1MB 栈
   except AttributeError:
       logger.warning('quickjs-ng 缺少限额 API，跳过（建议升级 quickjs-ng）')
   ```
3. 若 `set_time_limit` 单位是毫秒则乘 1000(看探测到的 docstring)。

**验证**:临时脚本 `ctx.eval('while(true){}')` 在时限内抛异常返回;后端其他端点仍响应。

### 4.3 H-4 路径遍历 + Windows 非法文件名

**定位**:`config.py:587-591`(内联 py 站点);`app.py:7-12`(`spider()`)。

**修改步骤**:
1. config.py(顶部确认 `import re`):
   ```python
   # H-4:key 来自远端配置,白名单化防路径穿越(C:\、../、..\\ 等)
   safe_key = re.sub(r'[^\w.-]', '_', str(key))[:64] or 'site'
   path = os.path.join(hoststate.get_plugins_dir(), f'{safe_key}.py')
   # 纵深:最终路径必须仍在插件目录内
   if not os.path.realpath(path).startswith(os.path.realpath(hoststate.get_plugins_dir()) + os.sep):
       raise ValueError(f'bad site key: {key}')
   ```
2. app.py:
   ```python
   from urllib.parse import urlparse   # 顶部补(确认未引入)
   import re
   def spider(cache, api):
       # H-4:去 query/fragment 再取 basename,并清洗 Windows 非法字符
       name = os.path.basename(urlparse(str(api)).path) or 'spider.py'
       name = re.sub(r'[\\/:*?"<>|#%]', '_', name)
       path = os.path.join(cache, name)
       download(path, api)
       name = name.split('.')[0]
       return SourceFileLoader(name, path).load_module().Spider()
   ```

**验证**:py_compile;`key="../evil"` 构造的配置无法越界;`api=".../spider.py?ver=2"` 可正常加载。

### 4.4 M-24 QuickJS local KV 配额

**定位**:`quickjs_host.py:38-39`(`LOCAL_KV_FILE`)、`61-71`(`_native_local_set` / `_local_kv_save`)。

**修改步骤**:
1. `_native_local_set` 入口加单值配额:
   ```python
   if len(str(value)) > 256 * 1024:
       return False   # M-24:单值上限 256KB(返回值语义按现有 callable 约定调整)
   ```
2. `_local_kv_save` 写盘前加总量配额:
   ```python
   if os.path.isfile(LOCAL_KV_FILE) and os.path.getsize(LOCAL_KV_FILE) > 5 * 1024 * 1024:
       logger.warning('[js] local KV 超过 5MB，拒绝写入')
       return
   ```
3. 命名空间隔离:`grep -rn "_native_local_set\|local_set" python-backend/js-engine python-backend/js_spider.py` 看 key 构造——若已带 `\u0001` 分隔的站点前缀,Python 侧暂不做强校验(拿不到"当前站点"上下文时无法可靠判定),在报告中记为后续项;若调用处可传入站点上下文,则校验 key 首段。

**验证**:py_compile;写 >256KB 单值被拒;文件到 5MB 后 set 不再增长。

### 4.5 L-11 redirect 无深度上限

**定位**:`app.py:125-131`。

**修改**:
```python
def redirect(url, timeout=15, _depth=0):
    if _depth >= 10:
        return None                      # L-11:循环重定向防护
    rsp = _fetch(url, timeout=timeout)
    if rsp is None:
        return rsp
    loc = rsp.headers.get('Location')
    if loc:
        from urllib.parse import urljoin
        return redirect(urljoin(url, loc), timeout=timeout, _depth=_depth + 1)
    return rsp
```

### 4.6 L-20 TypeError 误判签名

**定位**:`runner.py:18-22`(`homeVideoContent`;同文件若有同型回退一并处理)。

**修改**:
```python
import inspect   # 顶部

def homeVideoContent(self, pg='1'):
    # L-20:用签名预检代替 except TypeError(业务 TypeError 不再被误判后二次调用)
    try:
        n = len(inspect.signature(self.spider.homeVideoContent).parameters)
    except (TypeError, ValueError):
        n = 1
    return self.spider.homeVideoContent(pg) if n >= 1 else self.spider.homeVideoContent()
```

### 4.7 L-22 配置热替换空窗

**定位**:`config.py:335-343` `_apply`。

**修改**:
```python
def _apply(self, prepared):
    # L-22:先整体原子替换(无 404 空窗),再销毁旧站点(M-17 后 destroy 不杀共享 JVM)
    old = list(self.sites.sites)
    self.sites.sites[:] = prepared['sites']
    for s in old:
        try:
            s.runner.destroy()
        except Exception:
            pass
```

### 4.8 L-23 GBK 配置回退

**定位**:`config.py:436`。

**修改**:
```python
if os.path.exists(s):
    with open(s, 'rb') as f:
        raw = f.read()
    for enc in ('utf-8', 'gbk'):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode('utf-8', errors='replace')   # L-23:Windows 记事本 GBK 兼容
```

### 4.9 L-24 XML 实体膨胀防护

**定位**:`cms_spider.py:139`(`ET.fromstring` 前)。

**修改**(不引第三方库):
```python
head = (text[:4096] if isinstance(text, str) else text[:4096].decode('utf-8', 'ignore')).lower()
if '<!doctype' in head or '<!entity' in head:
    raise ValueError('suspicious XML rejected (DOCTYPE/ENTITY)')   # L-24:billion-laughs 防护
```

---

## 八、任务 5:D Kazumi 规则引擎 6 项

> 可改文件:`python-backend/kazumi/*`、`scripts/build-python.js`。**不要改 server.py**(已完工)。

### 5.1 H-2(部分) verify=True
```bash
grep -rn "verify=False" python-backend/kazumi/
```
逐处改 `verify=True`(约 28 处,多集中在 plugin_manager.py;若集中在某个 fetch 封装里,改一处即可全生效)。

### 5.2 M-18 `dict(parsed.query)` 崩溃

**定位**:`kazumi/api_strategy.py:293`。

**修改**:
```python
# before
merged_query = {**dict(parsed.query), **{k: str(v) for k, v in rendered_query.items()}}
# after
from urllib.parse import parse_qsl   # 与文件顶部现有 urlparse import 合并
merged_query = {**dict(parse_qsl(parsed.query)), **{k: str(v) for k, v in rendered_query.items()}}
```

**验证**:py_compile;构造播放页 URL 模板自带 `?aid=123` 的规则,剧集不再全部消失。

### 5.3 M-19 单条坏记录清空全部规则

**定位**:`kazumi/plugin_manager.py:181-194`(`_load`)+ `kazumi/plugin.py:67`(`from_json`)。

**修改步骤**:
1. `_load` 改逐条容错:
   ```python
   with open(self._file, encoding='utf-8') as f:
       data = json.load(f)
   plugins = []
   for item in data:   # M-19:单条坏记录跳过,不再整体清空
       try:
           plugins.append(Plugin.from_json(item))
       except Exception as e:
           logger.warning('[kazumi] 跳过不兼容规则记录: %s', e)
   self._plugins = plugins
   ```
2. `Plugin.from_json` 过滤未知键(先读 `Plugin.__init__` 签名):
   ```python
   @classmethod
   def from_json(cls, data):
       import inspect
       known = set(inspect.signature(cls).parameters)   # cls 绑定后不含 self
       return cls(**{k: v for k, v in (data or {}).items() if k in known})
   ```

### 5.4 M-25 商店 name 路径注入

**定位**:`kazumi/plugin_manager.py:1608-1619` `fetch_shop_rule`。

**修改**:
```python
import re   # 顶部确认
name = os.path.basename(str(name).strip())
if not name or not re.match(r'^[\w\u4e00-\u9fa5.-]+$', name):
    raise ValueError(f'bad rule name: {name!r}')   # M-25:防 ../ 与特殊字符拼进镜像 URL
```
下载成功后、return 前补 `plugin.validate()`(方法名以 Plugin 实际定义为准,先 grep `def validate`)。

### 5.5 M-26 打包缺 kazumi/assets

**定位**:`scripts/build-python.js:52-67`。

**修改步骤**:
1. `--add-data` 列表(`'--add-data', '"js-engine;js-engine"'` 等)追加:
   ```js
   '--add-data', '"kazumi/assets;kazumi/assets"',
   ```
2. 若下方有 `dataDirs = ['js-engine', 'spiders', 'base']` 之类的复制列表,追加 `'kazumi/assets'`。
3. 注意该文件现有引号风格(外层单引号包双引号),保持一致。

**验证**:`node --check scripts/build-python.js`;跑一次 build(或检查 dist 产物)确认 `_MEIPASS/kazumi/assets` 存在。

### 5.6 L-25 logger 重复 + weekdays 越界

**定位**:`plugin_manager.py:23 与 29`(两行相同的 `logger = logging.getLogger('vpc.kazumi.manager')`)、`548`(weekdays 解析,位于 571 的 try 之外)。

**修改**:
1. 删除其中一个重复 logger 定义(保留 23 行处)。
2. 548 行 weekdays 解析移入 try 块内(或单独 try):
   ```python
   try:
       weekdays = sorted({int(w) for w in (weekdays or []) if str(w).strip()})
   except (TypeError, ValueError):
       weekdays = []
   ```

---

## 九、任务 6:V 全局收尾验证

按序执行,每步记录结果(通过/失败/跳过+原因):

1. **JS 语法全检**:
   ```bash
   for f in src/main/*.js src/preload/*.js src/renderer/js/*.js scripts/build-python.js; do node --check "$f" || echo "FAIL: $f"; done
   ```
2. **M-1 白名单终核**:提取渲染层实际使用的 key,与 `SETTINGS_SET_ALLOWED`(src/main/index.js)diff:
   ```bash
   grep -rhoE "settingsSet\('([^']+)'" src/renderer src/preload | sort -u
   ```
   差集里的合法键补进白名单(路径/危险键除外)。
3. **Python 语法全检**:
   ```bash
   for f in $(git diff --name-only | grep '\.py$'); do python-backend/.venv/Scripts/python.exe -m py_compile "$f" || echo "FAIL: $f"; done
   ```
4. **verify=False 残留检查**(应只剩 tests,如有):
   ```bash
   grep -rn "verify=False" python-backend --include=*.py | grep -v tests
   ```
5. **SpiderRunner 重新编译**(任务 3 改了 Java):
   ```bash
   cd python-backend/jar-runner && ../.venv/Scripts/python.exe build.py
   ```
   (环境不支持则人工逐行复核 3.5/3.6/3.10 的 diff。)
6. **Python 测试**:
   ```bash
   cd python-backend && .venv/Scripts/python.exe -m pytest tests/ -x -q
   ```
   (缺依赖/环境不符则记录跳过。)
7. **关键 diff 抽查**(重点正确性,非格式):
   - go_proxy:`_reject_browser` / `_cookie_host_allowed` / 无长度分支响应头(A 已自测,复核即可)
   - jar_bridge ↔ SpiderRunner 的 `__shutdown` 协议两侧一致(3.5 与 3.7 必须同批合入,**不可只改一侧**)
   - config.py H-4 清洗后 `SourceFileLoader(key, path)` 的第一个参数仍用原 key(模块名)或 safe_key 皆可,但两者要一致
8. **人工冒烟清单**(启动应用):
   - 夸克网盘:扫码登录 → 播放/下载(go_proxy 改动最大,重点回归)
   - 直播:播放 → 手动关窗,确认备用线路不再弹回(M-7)
   - 下载:添加 m3u8 任务 → 换下载目录 → 不报错(H-9);带 Referer 任务重启恢复(L-8)
   - 设置:恢复默认设置后任务管理器无残留 python/aria2c(M-8)
   - Kazumi:规则商店安装、聚合搜索 SSE 正常返回 done(M-20)
   - 源配置:导入内联 py 站点(H-4)与 TVBox 配置回归
9. **更新 `CODE_REVIEW.md`**:每个编号追加状态标记(✅已修复/⏭️跳过+理由),文末加"修复记录"章节引用本文件与提交号。

---

## 十、执行顺序

**任务 1(E 剩余)→ 任务 2(F 渲染层)→ 任务 3(B jar)→ 任务 4(C config)→ 任务 5(D Kazumi)→ 任务 6(V 收尾)**。
任务 1-5 文件互不相交、相互独立,可按序交给子代理**串行**执行(并发限制,一次一个);任务 3 内部 3.5 与 3.7 必须同批完成;任务 6 必须最后做。
