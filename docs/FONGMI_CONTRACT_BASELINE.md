# FongMi 契约基线

更新时间：2026-08-17

这是仓库内可重复的离线基线，记录 FongMi 代理、播放结果和 Provider 契约已经验证到的范围。它不替代用户账号和真实网盘资源验收。

## 已覆盖的夹具

| 夹具 | 验证内容 |
|---|---|
| `python-backend/tests/test_proxy_http.py` | FastAPI `/proxy` 与旧 7944/9978/1314 监听器共享 JS/Python 调度；合并 query、header、form/JSON body 和 token |
| `python-backend/tests/test_proxy_stream.py` | 上游 401/403 触发一次签名 URL 刷新；不可恢复的 416 原样返回 |
| `python-backend/tests/test_jar_proxy.py` | 标准 JAR 静态 `Proxy.proxy(Map)`、InputStream socket 流、headers 和请求帧 |
| `python-backend/tests/test_pan_cache.py` | URL 过期提前刷新、账号指纹隔离、single-flight |
| `python-backend/tests/test_pan_cookies.py` | Windows DPAPI（非 Windows 使用 AES-GCM 兜底）、旧明文迁移、清 Cookie 同步清理签名 URL 缓存 |
| `tests/js/parse-window-contract.test.js` | type=4 解析器并发尝试、显式 priority 选择；type 0/1/2/3 的路由由 `parse-window.js` 统一处理 |

`python-backend/tests/run_all.py` 会把测试缓存放进 `python-backend/.test-runtime/`，避免把夹具写入用户真实数据目录。当前受管环境的 Node 默认测试隔离会禁止子进程，`node --test`/`scripts/check-js.js` 可能报 `spawn EPERM`；使用 `node --test --test-isolation=none "tests/js/*.test.js"` 已验证 211/211，通过普通开发机也应复跑默认 `npm run test:jsunit`。

## 当前运行时保证

- Python、JS 和 JAR 生成的代理地址携带 `siteKey`（`do=pan` 除外，因为 `site` 是 Provider 名），显式站点请求不会依赖全局 recent loader。
- 签名播放 URL 只保存在进程内，缓存键只包含账号不可逆指纹，不写 Cookie 或短期 URL 到播放历史。
- Cookie 文件使用 Windows DPAPI 加密；迁移旧版本明文文件时会原子替换为密文。
- JAR 加载前给出 L0-L4 兼容性诊断：DEX、Android UI/WebView、原生库和 DRM/设备许可分别标记风险；高风险不会被静默当成完整支持。

## 尚需用户环境验收

- 夸克分享和个人 fid 的真实播放、失效 Cookie、mpv seek 和大文件 Range；
- 用户自己的 JAR、JS/Python 源在真实网络中的 Proxy 行为；
- UC、百度、天翼、123、迅雷的 JAR Provider；
- Android 原生 `.so`、WebView、DRM 依赖；
- 可选的远程网盘浏览 UI。
