# A4.1 Android Worker 可行性 Spike 报告

日期：2026-08-19  
结论：**No-Go；产品支持上限正式收敛为 C1。**  
范围：只完成 A4.1 的证据、探针和决策；没有实现 A4.2 及之后的 Android Worker。

## 1. 验收口径与环境

本轮不把“配置可导入”“对象已创建”“返回 URL”算作完成。每个真实样例必须连续通过：

- `init`：指定样例确实初始化；
- `home`：返回至少一个真实分类；
- `player`：从 `home → category → detail` 取得真实 episode id，播放结果能读到媒体首字节，且
  随包 mpv 能解出首帧；
- `proxy`：从真实 player 结果提取参数，得到 200/206、非空 MIME 和非空 body。

探针用独立进程执行每个方法，外层统一记录耗时和整棵进程树工作集，并负责超时/取消强杀。
`python-backend/runtime/android_worker_spike.py` 只是可复跑的可行性探针，不含 Android Worker。

本机环境盘点：Windows x64、JDK 21 可用；没有 Android SDK、`adb`、Android Emulator、
`sdkmanager`、可用 WSL、Docker、已配对 Android 设备或远程 Worker 地址。因此三种真实 Android
执行方案不能在本机伪造运行结果；唯一可执行对照是现有 dex2jar/JVM shim。

## 2. 三类真实样例

样例清单固定在 `python-backend/spike/android_worker_samples.json`；二进制只下载到忽略的
`.build-tmp/`，不进入产品或提交历史。

| 类别 | 真实样例与 SHA-256 | 已验证证据 | 限制 |
|---|---|---|---|
| Android Context DEX | `fxz250711.jar`，`4c8375db7eaf455db762a4e6420a142d30a04c33ede65810f3d9d5c94b7553f1` | 真 DEX；`Init.init(android.content.Context)`、`Application`、`Handler` | 无 Android runtime，不能把 stub 初始化当完整通过 |
| 动态二级 DEX | `app.jar`，`e39125ea77db1e0805abffa08bc1f40af37a74e940dfa8e6ede209e832021ca7` | 真 DEX；`DexFile.loadDex`、`classes2.dex`、`secondary-dexes`、`Context.getClassLoader()` | 宿主没有 `DexPathList`/Android ClassLoader 语义 |
| ARM native + 本地 Proxy | `分享者YD.jar`（缓存名 `share-yd.jar`），`914e2a8edf2e38e5f51b8ec075d934576ec16da4a66756b58f23ad8c4eafc924` | 真 DEX；按 `armeabi-v7a`/`arm64-v8a` 选择 `mediaProxy-v7a`/`mediaProxy-v8a`，下载后写文件；播放地址指向 `http://127.0.0.1:8944/?url=` | ARM 负载由 JAR 运行时下载而非嵌入 ZIP；上游负载实测 HTTP 403，所以 ELF 与 native 进程启动不能宣称已验证 |

第三类不是纯 Java 替代物。JAR 字节码明确包含 ARM ABI 分支、原生负载尺寸检查、下载写盘和
本地 Proxy 端口。作为交叉证据，上游 `TV-fongmi/app/libs/` 中的真实 AAR 含：

- `jianpian-release.aar`：`arm64-v8a/libjpa.so`、`armeabi-v7a/libjpa.so`；
- `thunder-release.aar`：两种 ARM ABI 的 `libxl_stat.so`、`libxl_thunder_sdk.so`；
- `forcetech-release.aar` / `tvbus-release.aar`：`armeabi-v7a` native 库。

这些 AAR 只证明 FongMi 原生依赖和 ABI 事实，**没有**拿来替代第三个 JAR 的运行验收。由于
YD 的真实 ARM 负载当前不可取得，第三类只完成静态执行路径验证，动态 ARM/Proxy 结果为失败。

## 3. init/home/player/proxy 实测

最终权威运行是 `jvm-shim-report.json` 对三个原始 DEX JAR做哈希验证后，使用其 dex2jar 产物
进入现有 JVM shim。每个方法均为冷进程；结果如下（耗时 / 峰值进程树工作集）：

| 样例 | init | home | player | proxy | 完整通过 |
|---|---|---|---|---|---|
| Context DEX | 通过，4861 ms / 142.7 MiB | 失败，返回 `null`，4647 ms / 142.2 MiB | 失败，真实播放链无法从 `home` 取得分类 | 失败，同上 | 否 |
| 二级 DEX | 通过，3983 ms / 98.2 MiB | 失败，返回 `null`，4108 ms / 131.7 MiB | 失败，真实播放链无法从 `home` 取得分类 | 失败，同上 | 否 |
| ARM + Proxy | 通过，3969 ms / 100.8 MiB | 失败，返回 `null`，4040 ms / 104.8 MiB | 失败，真实播放链无法从 `home` 取得分类 | 失败，同上；ARM 负载另有 403 | 否 |

`init` 通过只表示转换产物的方法没有立即抛错，不表示 Android Context、二级 DEX 或 ARM
native 已工作。最终完成数是 **0/3**，不是 3/3，也不是“有 URL 即成功”。

JVM shim 的冷启动范围为 3.97–4.86 秒，峰值工作集为 98.2–142.7 MiB。当前探针相关体积：

- runner + dexdeps + 三个转换产物：4.83 MiB；
- 本机完整 JDK 21 安装目录：327.9 MiB（产品裁剪 JRE 未测）；
- 随包 mpv：112.1 MiB，属于现有播放器，不是 A4 新增量。

## 4. 四种方案比较

### 打包 Android guest/emulator

- `init/home/player/proxy`：未运行；本机无 SDK、镜像、emulator，不能据此通过 2/3 门槛。
- 冷启动/内存/安装体积：未测，全部按 Go 门槛失败处理，不用行业估值代替产品实测。
- ARM ABI：FongMi 只构建 `arm64-v8a` / `armeabi-v7a`；x64 PC 需要 ARM 转译或 ARM guest。
- 网络命名空间：guest 的 `127.0.0.1` 属于 guest；本地 Proxy 应与 JAR 同处 guest，或设计
  guest→host 映射，不能直接套用桌面 loopback。
- 许可证/更新：FongMi 是 GPLv3；Android 镜像再分发、ARM 转译和第三方 native AAR 的权利
  未审完。还要维护镜像、SDK/安全补丁、ABI 转译、Worker 与桌面版本矩阵。
- 结论：兼容潜力最高，但本轮没有原型和实测成本，No-Go。

### 配套 Android 设备 Worker

- `init/home/player/proxy`：未运行；本机无 `adb` 和已授权设备。
- 冷启动/内存/安装体积：未测；成本主要转移到用户设备，不能算桌面单机方案已达标。
- ARM ABI：真 ARM 设备最接近样例，但仍需按设备 ABI、Android 版本和厂商限制建兼容矩阵。
- 网络命名空间：设备 `127.0.0.1` 是设备自身；桌面控制面需 ADB reverse、局域网或受认证隧道。
- 许可证/更新：FongMi GPLv3 义务仍在；APK/Worker 更新、USB/Wi-Fi 配对与设备离线恢复需要产品化。
- 结论：技术上最可能成功，但违背默认 PC 单机体验，且本轮无设备证据，No-Go。

### 自托管远程 Android Worker

- `init/home/player/proxy`：未运行；没有配置任何 endpoint。
- 冷启动/内存/安装体积：服务端全部未测，PC 增量也未测。
- ARM ABI：可选 ARM 主机，但需运营真实 Android 环境和 native 依赖。
- 网络命名空间：JAR 的 loopback 属于远端；媒体数据面必须通过受认证隧道或远端流代理。
- 隐私：只有用户/组织明确控制的自托管 endpoint 才可考虑；Cookie、播放 URL 不能上传到未知第三方。
- 许可证/更新：服务部署、可用性、带宽、版本回滚、日志脱敏和事故响应均成为持续成本。
- 结论：不是“只输入地址”的默认体验；没有原型、端点和隐私证明，No-Go。

### JVM Android shim

- `init/home/player/proxy`：已对三个真实 DEX 输入实测，完整通过 0/3。
- 冷启动/内存/体积：见上节；即使资源数字可接受，功能门槛先失败。
- ARM ABI：`supportsArmNative=false`；无法执行 Android ARM `.so`，也不能复现完整 Framework、
  `DexClassLoader`/`DexPathList`、Binder、WebView、DRM 或设备服务。
- 网络命名空间：与桌面同一 host，loopback 最简单，但这不能弥补 Android/native 缺失。
- 许可证/更新：dex2jar 与 stub API 会持续追赶混淆 JAR 和 Android API；假成功风险最高。
- 结论：只保留给已确认 portable 的 C1 JVM JAR；Android-only JAR 禁止回退此路径。

## 5. 许可证、隐私与更新审计

- FongMi 本地 `TV-fongmi/LICENSE.md` 是 GPLv3。复用或分发其代码需要满足 GPLv3；这只是工程
  识别，不是法律意见。
- `TV-fongmi/app/libs/` 有约 9.59 MiB 本地二进制 AAR，仓内除根 GPLv3 外未发现逐个 native
  二进制的 LICENSE/NOTICE。第三方 SDK 权属与再分发条件需要逐件法律审查。
- Android SDK/镜像条款、ARM 转译组件和最终安装包的组合分发未获批准，因此许可证 Go 门槛失败。
  计划核对的官方入口是 [Android SDK Terms](https://developer.android.com/studio/terms)、
  [Android Emulator release notes](https://developer.android.com/studio/releases/emulator) 和
  [Android Security Bulletins](https://source.android.com/docs/security/bulletin)。本轮在线抓取因
  系统代理不可达、直连超时而失败，不能把“网页没抓到”写成“许可证允许”。
- 三个样例只用于本地忽略目录中的 Spike，不随产品分发。公共 JAR 自身没有可依赖的许可证元数据。
- 本轮没有把 Cookie 或播放 URL发往未知 Worker；远程方案也没有 endpoint。若以后重开评估，
  endpoint 所有权、传输加密、日志脱敏和凭据删除是先决门槛。

## 6. Go/No-Go

| Go 门槛 | 结果 |
|---|---|
| 至少 2/3 样例完成 init/home/player/proxy | **失败：0/3** |
| Android 方案冷启动、体积、内存可接受 | **失败：未形成 Android 原型，不能用 JVM 数字替代** |
| Worker 启动、停止、更新可靠 | **失败：本轮没有 Worker，按范围也不应实现** |
| FongMi、镜像、ARM 转译、分发许可证审完 | **失败：仅确认 FongMi GPLv3，其余未批准** |
| 不向未知第三方上传 Cookie/播放地址 | 本轮本地探针满足；尚不足以挽救其他失败门槛 |

明确结论：**No-Go**。

产品策略已经落到生产代码：

1. `SUPPORT_CEILING = C1`，Android Worker 状态为 `NO_GO` 且未发布；环境变量不能越过政策开关；
2. Android-only JAR 固定为 C2 / `L2_SITE_REQUIRES_ANDROID`，绝不回退 dex2jar/JVM；
3. 用户提示固定为：
   `该源仅支持 Android；当前桌面版支持上限为 C1，不会回退到 dex2jar/JVM。请改用可移植的 CMS、Python、JS、drpy 或 JVM 源。`
4. A4.2–A4.5 不启动；若未来重开，必须作为新的产品决策，先补齐真实 Android 原型、三样例
   2/3 完整数据面证据和许可证批准，不能把本 Spike 的静态结果当 Go。

## 7. 可复跑命令与异常分类

```powershell
python-backend/.venv/Scripts/python.exe python-backend/tests/test_android_worker_spike.py
python-backend/.venv/Scripts/python.exe python-backend/spike/run_android_worker_spike.py `
  --artifact-dir .build-tmp/android-worker-spike
```

加入 `--adapter-json '["<python>","<jvm_android_shim_adapter.py>"]'` 可复跑 JVM 对照。CLI 不自动
下载、不修改 `TV-fongmi/`，所有 artifact 必须匹配清单 SHA-256。

代码失败：JVM shim 三样例完整契约 0/3。  
外部网络失败：YD ARM payload HTTP 403；Android 官方资料经失效 loopback 代理连接失败，绕过
代理后直连超时。两类失败分开记录，均没有被测试静默跳过。
