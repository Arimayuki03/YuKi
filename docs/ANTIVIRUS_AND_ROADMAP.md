# 杀软误报应对指引（2026-09-26，随批次一改动生效）

## 背景与已落地措施

**现象**：安装 `YuKi-Setup-0.2.5.exe` 时被杀软以「风险程序」拦截（目标 `%LocalAppData%\Programs\YuKi\YuKi.exe`）。

**根因调查结论**（按可能性排序）：
1. **产物完全未签名 + 零发布信誉**——安装器/YuKi.exe/包内所有 exe 均无证书，新应用无 SmartScreen/杀软云信誉积累（PUA/Riskware/Generic 泛型检测的第一诱因）；
2. **vendor 内嵌 dex2jar 逆向工具链**——`d2j-apk-sign.bat`、`d2j-decrypt-string.bat`、`d2j-baksmali.bat` 等 20+ 个 .bat 命名是「HackTool」静态启发式的教科书特征，安装期全盘扫描必命中；
3. 安装过程向用户可写目录展开大量未签名可执行体（PyInstaller `yuki-backend.exe`、mpv/ffmpeg/aria2c、`elevate.exe`）；
4. 运行时「下载 exe 落盘」行为（一键补装 mpv，下载源含第三方加速镜像）属 dropper 形态行为启发式；
5. 大体积 assisted NSIS 安装器本身扫描窗口长。

**批次一已做的代码侧修复**：
- ✅ **dex-tools / dexdeps 移出安装包**（`package.json` extraResources 排除；改双获取途径：`node scripts/download-binaries.js dextools` 或 jar 蜘蛛源含 DEX 时运行时按需下载到缓存目录，sha256 与上游官方产物实证一致）。回归测试 `tests/js/dextools-unbundle.test.js` 锁定。
- ✅ 系统同名 DLL 剔除（早前已做，after-pack.js）。

## 下一步：用户可做的免费申诉（见效快，0 代码风险）

**先确认拦截你的是哪家杀软**（拦截记录里应有厂商名；Windows Defender / 360 / 火绒 / 腾讯电脑管家 / 其他）。按厂商走对应误报通道：

| 杀软 | 申诉入口 | 说明 |
|---|---|---|
| **Microsoft Defender** | <https://www.microsoft.com/en-us/wdsi/filesubmission> | 选「Submit a file for malware analysis」→「Software developer」通道，上传 `YuKi-Setup-0.2.6.exe`（0.2.7 起用新版）+ 项目链接；通常 1–3 天生效，结论同时下发给 SmartScreen 信誉库 |
| **360 安全卫士** | <https://open.soft.360.cn/>（360 软件安全开放平台）| 开发者误报申诉，需注册账号上传样本 |
| **火绒** | 官网「安全软件」页 → 误报申诉邮箱 / <https://www.huorong.cn/complaint.html> | 邮件附安装包 + 误报截图 + GitHub 仓库链接 |
| **腾讯电脑管家** | <https://guanjia.qq.com/complaint.html> | 在线误报反馈 |

申诉要点（照抄可用）：
> 该程序为开源动漫聚合播放工具（GitHub: Arimayuki03/YuKi，GPLv3），安装器由 electron-builder NSIS 生成，包含 Python 后端与开源播放器组件（mpv/ffmpeg/aria2，均附许可证）。自 v0.2.7 起已移除可能被静态启发式误判的 dex2jar 逆向工具链（改为运行时按需下载，且已锁定与上游官方产物一致的 sha256）。程序无任何恶意行为，恳请复核解除误报。

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

## B. 验证码自动识别（ddddocr 先行，animeko 边界）

**边界定案**：只做 MacCMS 系**图片验证码**（4 位数字）+ 只在**搜索环节**自动识别；识别失败刷新重试最多 3 次 → 回落现有人工验证窗口（`captchaVerify`，parse-window.js:651，Cookie 自动回流）。Cloudflare/Turnstile/滑块只留人工通道。

**现成资产**：
- `python-backend/kazumi/captcha.py`：`recognize_captcha_bytes`（ddddocr 懒加载 + 3-8 位合法性检查）已写好但**零调用**；
- `python-backend/kazumi/rule_engine.py`：`search_with_captcha_retry` 已能返回 `{captcha_required, captcha_url, captcha_url_classified, ocr_available}`（当前零网络请求设计）；
- 检测分类器：`xpath_strategy.py _detects_captcha`（搜索环节命中即抛 `CaptchaRequiredException`）。

**待动工**：
1. **前置验证**：`pip install ddddocr` 在 Python 3.14 实测兼容性（onnxruntime 1.30.0 已声明支持 3.14，但需实测轮子可用性）；查证 ddddocr 许可证与内置模型再分发条款；
2. 自动提交流程：抓验证码图 → ddddocr 识别 → POST 提交 → 复验搜索页（MacCMS：`GET /index.php/verify/index.html` 建会话 → `POST /index.php/ajax/verify_check?type=search&verify=XXXX`）；
3. 失败降级链：识别失败/置信度低 → 刷新图重试（≤3 次）→ 回落人工 `captchaVerify` 窗口；
4. 体积评估：ddddocr + onnxruntime 对后端 exe 的增量（onnxruntime 数十 MB 级），超阈值则转自训小模型（参考 animeko `captcha-v1.0.onnx` 契约：灰度 32×96 → 4×10 logits，机制可借鉴、模型文件不可搬——animeko 是 AGPL-3.0）。

**注意**：animeko 是 **AGPL-3.0**——机制/规则参数/模型契约可借鉴，代码与模型文件不可直接搬用（会传染许可证）。ddddocr 路线恰好是独立实现。
