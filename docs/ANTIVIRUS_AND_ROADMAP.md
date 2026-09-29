# 杀软误报应对指引（2026-09-26 落地批次一；2026-09-28 补批次二与实证结论）

## 背景与已落地措施

**现象**：安装 `YuKi-Setup-0.2.5.exe` / `0.2.6.exe` 时被杀软以「风险程序」拦截（目标 `%LocalAppData%\Programs\YuKi\YuKi.exe`）。2026-09-28 实证：本机 SecurityCenter2 注册的主动杀软为 **360 安全卫士**（Windows Defender 未运行），拦截方为 360。

**根因调查结论**（按可能性排序）：
1. **产物完全未签名 + 零发布信誉**——安装器/YuKi.exe/包内所有 exe 均无证书，新应用无 SmartScreen/杀软云信誉积累（PUA/Riskware/Generic 泛型检测的第一诱因）；
2. **YuKi.exe 的 CompanyName 曾为「GitHub, Inc.」**（2026-09-28 新实证）——package.json 缺 `author` 字段时 electron-builder 不写 CompanyName，YuKi.exe 保留 Electron 预编译二进制的原始值；未签名程序冒用大公司名义是启发式评分的显著扣分项。**v0.2.7 起补齐 author，CompanyName=Arimayuki03**，afterPack 门禁防回归；
3. **resources/elevate.exe 未签名提权助手**（2026-09-28 新实证）——electron-builder 默认打包的 2007 年第三方工具（Johannes Passing Elevate，无签名），「风险程序」类检测的经典命中项。**v0.2.7 起 `nsis.packElevateHelper: false` 不再打包**（纯 per-user 安装不需要；electron-updater 的 EACCES 降级路径另有 shell.openPath 兜底）；
4. **vendor 内嵌 dex2jar 逆向工具链**——`d2j-apk-sign.bat`、`d2j-decrypt-string.bat`、`d2j-baksmali.bat` 等 20+ 个 .bat 命名是「HackTool」静态启发式的教科书特征，安装期全盘扫描必命中；
5. 安装过程向用户可写目录展开大量未签名可执行体（PyInstaller `yuki-backend.exe`、mpv/ffmpeg/aria2c）；
6. 运行时「下载 exe 落盘」行为（一键补装 mpv，下载源含第三方加速镜像）属 dropper 形态行为启发式；
7. 大体积 assisted NSIS 安装器本身扫描窗口长。

**已做的代码侧修复**：
- ✅ **批次一（2026-09-28 提交 f863d9f）**：dex-tools / dexdeps 移出安装包（extraResources 排除；改双获取途径：`node scripts/download-binaries.js dextools` 或 jar 蜘蛛源含 DEX 时运行时按需下载到缓存目录，sha256 与上游官方产物实证一致）。回归测试 `tests/js/dextools-unbundle.test.js` 锁定。
- ✅ 系统同名 DLL 剔除（after-pack.js：d3dcompiler_47 / vulkan-1 / UCRT+VC++ 运行库）。
- ✅ **批次二（2026-09-28，v0.2.7）**：package.json 补 `author`（CompanyName 修复）；`nsis.packElevateHelper: false`（elevate.exe 剔除）；afterPack 新增可执行体版本信息门禁（CompanyName 缺失/仍为 GitHub、ProductName 缺失即 fail build）与 elevate.exe 兜底剔除。回归测试 `tests/js/after-pack.test.js` 扩至 12 例锁定。

## 下一步：用户可做的免费申诉（见效快，0 代码风险）

**先确认拦截你的是哪家杀软**（拦截记录里应有厂商名；Windows Defender / 360 / 火绒 / 腾讯电脑管家 / 其他）。按厂商走对应误报通道：

| 杀软 | 申诉入口 | 说明 |
|---|---|---|
| **Microsoft Defender** | <https://www.microsoft.com/en-us/wdsi/filesubmission> | 选「Submit a file for malware analysis」→「Software developer」通道，上传 `YuKi-Setup-0.2.6.exe`（0.2.7 起用新版）+ 项目链接；通常 1–3 天生效，结论同时下发给 SmartScreen 信誉库 |
| **360 安全卫士** | <https://open.soft.360.cn/>（360 软件安全开放平台）| 开发者误报申诉，需注册账号上传样本 |
| **火绒** | 官网「安全软件」页 → 误报申诉邮箱 / <https://www.huorong.cn/complaint.html> | 邮件附安装包 + 误报截图 + GitHub 仓库链接 |
| **腾讯电脑管家** | <https://guanjia.qq.com/complaint.html> | 在线误报反馈 |

申诉要点（照抄可用，0.2.7 起适用）：
> 该程序为开源动漫聚合播放工具（GitHub: Arimayuki03/YuKi，GPLv3），安装器由 electron-builder NSIS 生成，包含 Python 后端与开源播放器组件（mpv/ffmpeg/aria2，均附许可证）。自 v0.2.7 起已移除可能被静态启发式误判的 dex2jar 逆向工具链与未签名提权助手 elevate.exe（前者改为运行时按需下载且已锁定与上游官方产物一致的 sha256），并修正了主程序版本信息（CompanyName 此前误为 Electron 默认值）。程序无任何恶意行为，恳请复核解除误报。

## 中期方案：代码签名（推荐 Azure Trusted Signing）

- **Azure Trusted Signing**：约 $9.99/月（含 5000 次签名），个人开发者身份验证即可，效果接近 EV 证书（SmartScreen 几乎零误报）。CI 集成：`Azure/signtool` + GitHub Action `azure/trusted-signing-action`。
- **替代**：OV 证书（¥1500–2500/年，需企业主体）或 EV 证书（$300–400/年）。开源项目也可评估 [SignPath](https://signpath.org)（对开源项目免费，但审批较严）。
- 签名后收益：① SmartScreen/Defender 泛型误报大幅收敛；② 用户安装时不再有「未知发布者」红屏；③ 信誉随版本积累，长期收敛误报。
- 接入位点：`.github/workflows/release.yml` 在 `npx electron-builder` 前导出证书/配置 signtool，electron-builder 对 win 目标会自动调用签名（`build.win.sign` 或环境变量）。

## 不要做的事（均治标不治本或有害）

- ❌ 给杀软交「白名单费用」/ 找第三方「过杀软」服务——属灰色产业且不可持续；
- ❌ 加密/加壳压缩 exe 以「躲避」检测——反而提高启发式评分；
- ❌ 关闭 after-pack 的系统 DLL 剔除（v0.2.2–0.2.3 的历史误报主因，已解决别回退）。

---

# 批次二开工清单（方案已定案，随时可动工）

## A. 在线播放跳广告（animeko 式 m3u8 清单过滤，默认开）

**机制定案**：拉原始 m3u8 → 按 `#EXT-X-DISCONTINUITY` 分组跑启发式（路径含 `/ad/`、夹在长组间的短组、重复短组等）→ 本地代理只改写清单、删广告分片，分片由播放器直连远端。只对 HLS 源生效（mp4 直链无法过滤）；播放与下载共用 `hlsAdFilter` 设置键（文案改「m3u8 广告过滤（播放与下载）」）。

**现成资产**：
- `src/main/hls-downloader.js`：`filterAdSegments`（CUE-OUT/CUE-IN + DATERANGE 标准标记）+ `filterAdBlocks`（DISCONTINUITY 启发式，30% 安全阀），已挂下载合成链路；
- `python-backend/ad_filter.py`：同款 Python 版（纯库，零调用方）；
- `src/main/playlist-proxy.js`：播放代理插入点（在线播放主链路当前**无任何过滤**——这是核心缺口）。

**待动工**：
1. 播放代理（playlist-proxy.js / proxy_gateway.py）挂清单重写：起播 URL 过过滤后再交 mpv；
2. 「已过滤 N 段广告」toast 报告（`AdFilterReport` 结构现成）；
3. **时间轴对齐挂账**：过滤后播放时间轴 ≠ 源站原始时间轴，本地登记的片头片尾秒数（T81 OP/ED）可能偏移——需换算或在广告过滤开启时标注登记值失效；
4. 默认开启 + 误删护栏验证（30% 安全阀、多证据叠加）。

## B. 验证码自动识别（ddddocr 主链已落地，animeko 边界）

**边界定案**：只做 MacCMS 系**图片验证码**（4 位数字）+ 只在**搜索环节**自动识别；识别失败刷新重试最多 3 次 → 回落现有人工验证窗口（`captchaVerify`，parse-window.js:651，Cookie 自动回流）。Cloudflare/Turnstile/滑块只留人工通道。

**已落地（2026-09-29，两轮复盘定案）**：
- **主识别器 ddddocr**（MIT，模型内置 pip 包）：真实站验证码是花体/斜体艺术字（2kdm 系 0 呈 ∞ 形），自研合成模型分布外全错、ddddocr 实测直接命中——弃「合成训练换真实泛化」的幻想，直接用现成轮子。onnxruntime/opencv 进锁文件（打包增重 ~200MB），Python 3.14 轮子可用性已实测；
- **兜底链自研 tiny-CNN**（`captcha_cnn.py` + assets 权重）：ddddocr 结果被 3-8 位门槛拒绝时兜底；训练管线 `tools/train_captcha_cnn.py` 保留（合成样本含花体斜切增强）；
- **solve_captcha 会话与判定协议**（三源全败复盘修复）：
  - 独立 `requests.Session` 持验证会话（共享 Session 挂 _NoStoreCookiePolicy 不落地 Cookie，原实现每次陌生会话→答案必错）；先 GET 搜索页建会话，取图/提交/复验共享 PHPSESSID；每跳过 `_guard_hop` SSRF 守卫；
  - 提交走 **POST** `/index.php/ajax/verify_check`（表单 `type=search&verify=<码>`，与站点 JS 的 MAC.Ajax 'post' 一致）；
  - 成功标准 = 提交响应 **code==1**（绝不以「复验页不再检出验证码」判定——答案错误时站点回「请勿频繁操作」提示页，无 captchaImage 节点，会被检测器误判为放行）；频率提示页等 2.5s 重试；失败必到 3 轮上限后明确返回，前端回落人工窗口；
  - 成功后验证会话 Cookie 显式落盘 cookie_jar（重启免重验）。
- **真实站验证**（2026-09-29）：mutefun/mgnacg/giriGiriLove/dalvdm 四源 solve 全部 code==1 通过；前三源 solve 后真实搜索出结果（dalvdm 的 403 是其规则 searchURL 形态与站点不符的独立问题）。

**待观察**：ddddocr 对个别字形仍会错（如 1/7 尾位混淆），3 轮换图重试 + 人工窗口兜底；打包体积增重 ~200MB 需在发版说明标注。

**注意**：animeko 是 **AGPL-3.0**——机制/规则参数/模型契约可借鉴，代码与模型文件不可直接搬用（会传染许可证）。ddddocr 路线恰好是独立实现。
