# 第三方组件与许可声明

本文档逐项列出 YuKi 安装包分发或构建时引入的第三方组件、其许可证与合规结论。YuKi 本体以 [GPLv3](../LICENSE) 许可发布；下列第三方组件各自按其许可证执行，本文档不改变其条款。YuKi 及其衍生作品的再分发须提供对应源码并保持同许可。

维护规则：新增依赖（npm / pip / vendored / 二进制）时同步更新本文件；二进制版本变更由 `scripts/binaries.lock.json` 锁定，更新后需复核对应条目。

## 一、随安装包分发的二进制

以下二进制由 `scripts/download-binaries.js` 下载并经 electron-builder 打入安装包资源（`vendor/` → 应用 resources），**随安装包再分发**。

| 组件 | 来源与锁定方式 | 许可证 | 合规结论 |
|---|---|---|---|
| mpv | [shinchiro/mpv-winbuild-cmake](https://github.com/shinchiro/mpv-winbuild-cmake) releases（mpv 官方推荐的 Windows 构建渠道）；`binaries.lock.json` 锁定 release tag 与 sha256 | **GPLv2+**（shinchiro 构建为 GPL 构建） | 允许再分发；分发时须随附 GPL 许可证文本并注明源码获取地址（上游 GitHub 仓库）。本仓库不修改 mpv 源码，仅原样打包 |
| ffmpeg | [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) `ffmpeg-release-essentials.zip`（滚动 release，无版本化摘要可锁，见 lock 说明） | **GPLv3**（gyan.dev essentials 为 GPL 构建，含 libx264 等 GPL 组件） | 允许再分发；须随附 GPLv3 许可证文本并提供对应源码获取途径。仅使用 ffmpeg.exe 命令行能力，未链接其库 |
| aria2c | [aria2/aria2](https://github.com/aria2/aria2) 官方 releases Windows x64 zip；lock 锁定 tag 与 sha256 | **GPLv2**（含 OpenSSL 例外条款） | 允许再分发；随附 GPL 许可证文本与上游源码地址 |
| Anime4K v4.1 着色器 | [bloc97/Anime4K](https://github.com/bloc97/Anime4K) `glsl/`（Restore / Upscale / Darken 共 6 个 .glsl 文件）；逐文件 sha256 锁定 | **MIT** | 允许再分发；保留版权声明即可（着色器文件头自带） |
| MiSans 字体子集 | npm 包 [misans@4.1.0](https://www.npmjs.com/package/misans)（dsrkafuu 基于 Noto Sans SC 码位范围做的 woff2 分片子集），经 jsdelivr 分发；逐文件 sha256 锁定 | 字体版权 © 小米科技，按小米官方 MiSans 字体许可协议**免费商用、无需授权、允许随软件再分发**；npm 打包代码 MIT | 允许再分发；在发布页与本文件中注明字体出处即可 |

> GPL 组件合规操作：发布 Release 时附带《GNU 通用公共许可证》文本（本仓库 `docs/licenses/` 目录提供 GPLv2 / GPLv3 全文副本），并在 Release Notes 中给出 mpv / ffmpeg / aria2 上游源码链接。若未来改用 LGPL 构建替换任一组件，需重新核实义务并更新本表。

## 二、内嵌前端库

| 库 | 版本 | 位置 | 许可证 |
|---|---|---|---|
| jQuery | v3.7.1 | `src/renderer/js/jquery.min.js`（文件头含版权声明） | MIT（© OpenJS Foundation） |

## 三、Node.js 依赖

| 包 | 版本要求 | 用途 | 许可证 |
|---|---|---|---|
| electron | ^31.0.0（实测 31.7.7） | 桌面宿主 | MIT |
| electron-builder | ^25.1.8 | 打包（devDependency） | MIT |
| electron-updater | ^6.6.2 | 自动更新基础链路 | MIT |

## 四、Python 后端依赖

来源：`python-backend/requirements.txt`（pip-compile 锁定）。许可证以本地 venv 安装元数据核对为准。

| 包 | 版本 | 许可证 |
|---|---|---|
| fastapi | 0.141.1 | MIT |
| starlette | 1.6.0 | BSD-3-Clause |
| pydantic / pydantic-core | 2.13.4 / 2.46.4 | MIT |
| annotated-types / annotated-doc / typing-inspection | — | MIT |
| typing-extensions | 4.16.0 | PSF-2.0 |
| anyio | 4.14.2 | MIT |
| uvicorn | 0.52.3 | BSD-3-Clause |
| h11 | 0.16.0 | MIT |
| click | 8.4.2 | BSD-3-Clause |
| colorama | 0.4.6 | BSD-3-Clause |
| requests | 2.34.2 | Apache-2.0 |
| urllib3 | 2.7.0 | MIT |
| certifi | 2026.7.22 | MPL-2.0 |
| idna | 3.18 | BSD-3-Clause |
| charset-normalizer | 3.5.1 | MIT |
| beautifulsoup4 / soupsieve | 4.15.0 / 2.9.2 | MIT |
| lxml | 6.1.1 | BSD-3-Clause |
| jsonpath-ng | 1.8.0 | Apache-2.0 |
| pycryptodome | 3.23.0 | BSD-3-Clause / Public Domain |
| python-multipart | 0.0.32 | Apache-2.0 |
| quickjs-ng | 0.16.0.1 | MIT |

## 五、依赖审计豁免记录

CI 中供应链审计（`npm audit --omit=dev || true`、`pip-audit --strict || true`）当前为观察模式。发现无法短期清零的高危项时，在此记录豁免理由与跟进计划；观察期结束（见 `docs/github.md` G10）后移除 `|| true` 使审计失败阻断合并。

| 审计日期 | 工具 | 高危项 | 豁免理由 | 跟进计划 |
|---|---|---|---|---|

（当前为空：首轮基线审计零漏洞，无豁免项。）

### 首轮基线审计快照

- 执行时间：2026-08-22
- `npm audit --omit=dev`（官方 registry）：**found 0 vulnerabilities**
- `pip-audit -r python-backend/requirements.txt --strict`：**No known vulnerabilities found**

运维备注：本机开发环境默认 registry 为 npmmirror.com，该镜像未实现 `/-/npm/v1/security/*` 审计端点，`npm audit` 需追加 `--registry=https://registry.npmjs.org` 才能获得真实结果。GitHub Actions 使用官方 registry，不受影响。

## 六、致谢与对照项目

YuKi 的实现参考并受益于以下上游项目：

- [Kazumi](https://github.com/Predidit/Kazumi) —— 规则引擎的数据模型与行为参照；
- [FongMi/TV](https://github.com/FongMi/TV) 与 CatVod 生态 —— TVBox 配置契约与爬虫生态参照；
- [bloc97/Anime4K](https://github.com/bloc97/Anime4K) —— 超分辨率着色器；
- [dsrkafuu/misans](https://github.com/dsrkafuu/misans) —— MiSans 字体子集化打包。

`../Kazumi-main/` 与 `TV-fongmi/` 仅为本地开发时的对照资料，**不在本仓库内**，也未复制其源码或文档入库。
