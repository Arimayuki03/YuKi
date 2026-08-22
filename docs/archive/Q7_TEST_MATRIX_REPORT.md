# Q7 测试与验收体系报告 (Q7.1 ~ Q7.6)

## 1. Q7.1 确定性离线夹具套件
通过 `python-backend/tests/fixtures/q7_offline_fixtures.py` 和 `python-backend/tests/test_q7_offline_fixtures.py` 提供纯本地 loopback HTTP 模拟服务，覆盖：
- **JSON/XML CMS**：支持两类 CMS 解析、首页分类与详情获取。
- **直链 MP4 与 Range 206**：完整 GET 与 Range 分片请求、错误 Content-Range 容错。
- **Master/Variant HLS**：多码率 m3u8 与 TS 分片索引解析。
- **Referer/Cookie 校验与 302/307 重定向**：敏感头部跨跳转合并与鉴权验证。
- **HTML 假视频识别**：非流式网页自动重定向至二次解析。
- **解析器与故障流**：JSON/iframe 嗅探、慢响应超时、连接强断与已过期签名拦截。

## 2. Q7.2 运行时契约夹具
在 `python-backend/tests/test_q7_runtime_contracts.py` 中覆盖全运行时：
- **Python/JS/drpy/JAR**：正常调用、异常抛出、死循环强杀与 Supervisor 重启自愈。
- **Android Context / 二级 DEX / Native `.so`**：严格归类为 `L1/L2/L3` 并给出 `REQUIRES_ANDROID` 明确提示，严禁向 JVM 盲目回退。

## 3. Q7.3 公共仓兼容报告
基于 `python-backend/tests/test_config_compat.py`，区分离线确定性基线（`--offline`）与公网趋势语料（`--public`）。
公共仓失败严格归类为：
1. **上游不可达**（404/DNS/连接超时）；
2. **账号缺失/需认证**（401/403/扫码）；
3. **宿主兼容性归因**（C1 Android 专属/未实现特性），绝不将公网不可抗力混淆为代码回归。

## 4. Q7.4 故障注入与弹性恢复
在 `python-backend/tests/test_q7_fault_injection.py` 与 `tests/js/python-bridge-lifecycle.test.js` 中验证：
- **Worker 崩溃与死循环**：进程被 Supervisor 强杀并回收端口，下一次健康请求自动重拉。
- **半包/断连/端口冲突**：端口冲突检测与释放自愈。
- **mpv 缺失与首帧超时**：在 `tests/js/mpv-player.test.js` 中拦截为 `mpv-missing` 并提供优雅降级。

## 5. Q7.5 性能与资源基线
在 `python-backend/tests/test_q7_perf_metrics.py` 中记录基线指标：
- **配置管理器冷启动**：< 50ms。
- **10 站点并发初始化耗时**：< 1500ms。
- **播放直链解析与调度耗时**：< 100ms。
- 退出后所有子进程与临时端口 100% 释放。

## 6. Q7.6 实机矩阵（Windows 开发态与安装包）
- **Windows 开发态**：`npm run test:jsunit` (244 passed)、`python-backend/tests/run_all.py` (全套件 PASS)。
- **Windows 安装包实机矩阵**：开发态冷启动与进程树回收测试已通过；打包安装包（dist/win-unpacked）全特性实机验收将在发布阶段（M3/R8）统一执行。
