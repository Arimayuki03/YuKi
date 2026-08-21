# P5 播放链路验收矩阵

状态：2026-08-19 离线契约完成；真实夸克账户/公共网络样例单列，不以离线夹具替代。

本矩阵对应 `TVBOX_FONGMI_PARITY_TASKS.md` 的 P5.1～P5.6。所有 HTTP 场景使用
loopback 服务，正常、异常、超时和取消均为确定性测试；测试不会把 Cookie、Authorization
或短期签名 URL 写入日志和前端存储。

| 场景 | 正常 | 异常 | 超时 | 取消/换集 | 主要证据 |
|---|---|---|---|---|---|
| 统一 PlayResult | 保留 `url/parse/jx/playUrl/header/headers/format/subs/position/flag/drm/msg/code/proxy` 和未知字段 | 空 URL 不回退 HTML episode id；畸形 header 安全归一 | playerContent deadline 由 Runtime 控制 | requestId/playSessionId 取消 | `python-backend/tests/test_play_contract.py` |
| 直链 | HEAD 确认 `video/*` 后进入 mpv | HTML、JSON、登录页、401/403 拒绝 | 探测超时返回 L5，不启动 mpv | AbortSignal 中止探测 | `tests/js/media-probe.test.js` |
| HLS | 接受 MIME 或 `#EXTM3U` | 伪 HLS/HTML 拒绝 | 同探测超时 | 同探测取消 | `tests/js/media-probe.test.js` |
| Range | HEAD 不可判定时 GET `bytes=0-1`，识别媒体魔数 | 非媒体字节拒绝 | Range 请求超时 | Range 请求取消 | `tests/js/media-probe.test.js` |
| type 0 | BrowserWindow 嗅探媒体请求和 legacy iframe，请求头传入窗口 | 无媒体/窗口失败释放 hook、窗口和 partition | 定时器销毁窗口 | 播放会话取消销毁窗口 | `tests/js/parse-window-contract.test.js` |
| type 1 | JSON 嵌套 URL、header、重定向 | 无 URL/伪媒体尝试下一解析器 | JSON fetch 超时 | AbortSignal 中止 fetch | `tests/js/parse-window-contract.test.js` |
| type 2 | 后端 `parseExt` 调用可移植 JAR `Json<name>.parse` | JAR 错误进入下一解析器 | Runtime deadline 强杀 Worker | `/runtime/cancel` 传播 | `python-backend/tests/test_jar_e2e.py`、`tests/js/parse-window-contract.test.js` |
| type 4 | 并发执行候选，按配置 priority/order 选择 | 全失败返回 L4 | 每个候选受统一 deadline | 取消全部候选窗口/请求 | `tests/js/parse-window-contract.test.js` |
| `json:` / `parse:<name>` / 普通 `playUrl` / flags | 精确路由或 type 0 前缀；flag 过滤 | 指定解析器不存在时明确失败 | 沿用解析 deadline | 换集令旧 token 失效 | `tests/js/player-contract.test.js` |
| Cookie/header | 五类敏感 header 大小写无关，按站点→Spider `header`→Spider `headers`→解析配置→解析结果→窗口 Cookie 合并 | 外部播放器无法透传时返回 `headerDropped` | 窗口/解析超时清理会话 | 会话取消不串 Cookie | `test_play_contract.py`、`parse-window-contract.test.js` |
| 重定向 | 最多 5 跳，合并 `Set-Cookie`，使用最终 URL/header | 循环/超限/登录跳转拒绝 | 每跳共用剩余 deadline | 中止当前跳转 | `tests/js/media-probe.test.js` |
| 假视频 | — | HTML、JSON、登录页和 403 不交给 mpv | — | — | `tests/js/media-probe.test.js` |
| 过期 URL | 有效短链不长缓存 | 离线识别已过期签名；CDN 401/403/404/410/412 触发一次刷新 | 刷新受原 deadline | 用户退出停止刷新/重连 | `test_play_contract.py`、`test_proxy_stream.py`、`player-watch.test.js` |
| 网盘 | JAR `playerContent/proxy` 优先；native Quark 只在显式快路径开关下协议降级 | 未注册 Provider 明确不支持 | Provider/代理 deadline | 客户端断连取消上游 | `test_quark_pan.py`、`test_pan_provider.py`、`test_proxy_stream.py` |
| 首帧/离线 | mpv `file-loaded` 或 ready 后才 `ok=true` | 启动/退出错误为 L6；外部播放器仅标记 launched | 首帧超时主动 stop | 用户 close 取消一次重连和连播 | `tests/js/mpv-player.test.js`、`tests/js/player-watch.test.js` |

## 真实网络验收边界

- 本机检测到已加密保存的夸克 Cookie，但本轮没有输出、复制或记录其值。
- 只读夸克 API 验收在沙箱内因外部代理不可达失败；请求真实凭据出沙箱被安全策略拒绝，
  因而没有取得“Cookie 仍有效”或“真实文件首帧成功”的证据。
- 在用户明确授权把本机夸克 Cookie 发送到 `drive-pc.quark.cn`，并指定一个有权访问的稳定
  测试文件后，才可补做：只读目录验证 → 生成短期 URL → HEAD/Range → mpv `file-loaded`。
- UC、百度、天翼、123、迅雷未完成 portable JAR/C1 adapter 的真实端到端验收，产品不得列为
  已支持；Android-only 返回 `requires_android`，不使用 Android Worker 结果占位。

## 2026-08-19 执行记录

- `npm run test:jsunit`：241 passed，0 failed/skipped/cancelled。
- `npm run test:all`：Python `RUN_ALL: ALL PASS`、JS 单测/语法检查/ESLint 均通过；最终退出 1
  仅因本轮开始前已有的 drpy/spike/旧测试文件包含 32 个 Ruff F401。没有删除或改写这些
  用户未提交的范围外文件；本轮触及的 Python 文件单独 `ruff check` 全部通过。
- `python-backend/.venv/Scripts/python.exe python-backend/tests/test_jar_e2e.py`：5 passed，
  包括 type 2 `JsonDemo.parse`；测试 jar 可由版本化源码在干净工作区确定性重建。
- `git diff --check`、四个生产 JavaScript 文件的 `node --check`、本轮 Python 文件
  `py_compile`：全部通过。
