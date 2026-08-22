# YuKi GitHub 开源发布准备任务书

> 本文档是通用《GitHub 开源发布准备任务书》的 YuKi 专用改写版。原任务书中不适用于桌面应用的条目（Docker 支持、环境变量样例、Nginx 反向代理等服务器向内容）已移除或改写；已在本仓库完成的条目只保留结论作为基线，不再重复展开执行步骤。

**适用项目**：YuKi（原影视 PC）——Electron 桌面影视聚合应用；`src/` 为 Electron 主进程与渲染进程，`python-backend/` 为独立 Python 3.14 FastAPI 后端（CatVod + Kazumi 双引擎），mpv / aria2c / ffmpeg 完成播放与下载。

**执行对象**：AI 助手 / 自动化工具 / 开发者。

**任务目标**：补齐开源合规缺口（LICENSE、社区文件、第三方许可声明），完成敏感信息核查，建立 tag 驱动的发布流水线，并对外发布首个版本 `v0.1.0`。

**完成标准**：

- 根目录包含 `LICENSE`、`CHANGELOG.md`、`CONTRIBUTING.md`，`.github/` 下有 Issue/PR 模板；
- 敏感信息扫描通过，Git 全部历史无泄漏；
- `npm run test:all` 本地全绿，GitHub Actions CI 全绿；
- 推送 tag `v0.1.0` 后自动产出 Windows 安装包并生成 Release 草稿。

---

## 一、项目事实基线（执行任何任务前必读）

| 事实 | 内容 |
|---|---|
| 版本 | `package.json` 中 `0.1.0`，license 字段已声明 `MIT`，但根目录尚无 `LICENSE` 文件 |
| 二进制依赖 | mpv、aria2c、ffmpeg、Anime4K、MiSans 等由 `scripts/download-binaries.js` 管理，位于 `vendor/`（不入库） |
| 测试 | JS 单测 `tests/js/*.test.js`（`node --test`）；Python 回归 `python-backend/tests/run_all.py`；冒烟 `npm run smoke` |
| Lint | `npm run lint`（ESLint，配置 `eslint.config.js`）；`npm run lint:py`（Ruff，配置 `ruff.toml`） |
| 全量回归 | `npm run test:all` = test:py → test:jsunit → test:js → lint → lint:py |
| 打包 | electron-builder：`build:win`(NSIS x64)、`build:mac`(dmg)、`build:linux`(AppImage/deb)，产物输出 `dist/` |
| CI | `.github/workflows/ci.yml`：js job（单测+语法门禁+审计）、python job（回归+ruff+审计）、compat job（手动触发，21 仓语料） |
| 忽略规则 | `.gitignore` 已覆盖构建产物、运行时目录、网盘蜘蛛 cookie 目录（FM/DuoDuo/VOX/TV/TVBox）、`.omo/`、`.zcode/` 等 |

文档写作必须遵守 [docs/README.md](README.md) 的维护规则：当前状态只进 `PROGRESS.md`，架构变化先改 `docs/ARCHITECTURE.md`。本文档属于计划类文档，保留"目标、当前状态、剩余验收项"结构；每完成一项在 `PROGRESS.md` 记录状态变化并链接证据。

## 二、原任务书对照结论

对通用任务书 T01–T25 逐条核对后的结论如下，避免重复劳动：

| 原编号 | 任务 | 结论 | 说明 |
|---|---|---|---|
| T01 | 删除无用文件 | ✅ 基本完成 | `.gitignore` 完备；公开前按 G02 复核大文件即可 |
| T02 | 检查敏感信息 | ⬜ 未验证 | 公开前必须执行 → G01 |
| T03 | 配置 .gitignore | ✅ 完成 | 新增忽略项直接追加该文件 |
| T04 | 补充单元测试 | ✅ 完成 | `tests/js` + `python-backend/tests`，由 `test:all` 收口 |
| T05 | 编写测试用例 | ✅ 视为满足 | [docs/TEST_REPORT.md](TEST_REPORT.md) 维护自动化与实测清单 |
| T06 | 冒烟测试 | ✅ 完成 | `npm run smoke`（`python-backend/tests/smoke.py`） |
| T07 | 静态检查与规范 | ✅ 完成 | ESLint + Ruff，均已纳入 CI |
| T08 | 依赖安全审计 | 🔶 部分 | CI 已内置 `npm audit` / `pip-audit` 但 `|| true` 暂不拦截 → G10 |
| T09 | README.md | ✅ 完成 | 根 README.md，含快速开始与文档导航 |
| T10 | 项目结构说明 | 🔶 部分 | `docs/ARCHITECTURE.md` 已覆盖模块职责；独立结构文档可选，不单列任务 |
| T11 | 实现原理文档 | ✅ 完成 | ARCHITECTURE.md、KAZUMI_INTEGRATION.md、ADR-0001/0002 |
| T12 | 接口文档 | 🔶 复核 | 进程间 HTTP/IPC 契约在 ARCHITECTURE.md；公开前核对一遍即可 |
| T13 | 部署文档 | ♻️ 改写 | 桌面应用无服务端部署 → 改为打包分发，并入 G05 |
| T14 | 开发指南 | 🔶 并入 | README 快速开始已有；剩余内容并入 CONTRIBUTING.md（G07） |
| T15 | Changelog | ⬜ 未开始 | → G06 |
| T16 | License | ⚠️ 缺文件 | `package.json` 声明 MIT 但无 LICENSE 文件 → G03（最高优先） |
| T17 | 贡献指南 | ⬜ 未开始 | → G07 |
| T18 | 行为准则 | ⬜ 未开始 | → G08 |
| T19 | Issue/PR 模板 | ⬜ 未开始 | → G09 |
| T20 | 配置 CI/CD | ✅ 完成 | ci.yml 三 job；缺 tag 发布流水线 → G05 |
| T21 | Docker 支持 | ❌ 不适用 | 桌面应用，无容器化场景 |
| T22 | 环境变量样例 | ❌ 不适用 | 无服务端部署配置 |
| T23 | 版本号与 Tag | ⬜ 未执行 | → G11（首发 v0.1.0，不是 v1.0.0） |
| T24 | Release Notes | ⬜ 未开始 | → G11 |
| T25 | README 徽章 | ⬜ 未开始 | → G12 |

图例：✅ 完成 · 🔶 部分完成/待收敛 · ⬜ 未开始 · ⚠️ 有缺口 · ♻️ 改写 · ❌ 不适用

## 三、剩余任务清单

| 编号 | 任务 | 优先级 | 依赖 |
|---|---|---|---|
| G01 | 敏感信息扫描与 Git 历史核查 | 高 | 无 |
| G02 | 大文件与仓库体积复核 | 中 | 无 |
| G03 | 添加 LICENSE 文件（MIT） | 高 | 无 |
| G04 | 第三方组件与二进制许可声明 | 高 | G03 |
| G05 | Release 工作流（tag → 安装包） | 高 | G04 |
| G06 | CHANGELOG.md | 中 | 无 |
| G07 | CONTRIBUTING.md | 中 | 无 |
| G08 | CODE_OF_CONDUCT.md | 低 | 无 |
| G09 | Issue/PR 模板 | 中 | 无 |
| G10 | 依赖审计门槛收紧 | 中 | CI 观察期满 |
| G11 | v0.1.0 Tag 与 Release Notes | 高 | G01、G03、G05、G06 |
| G12 | README 徽章 | 低 | G05、G11 |

---

## 四、剩余任务详情

### G01 敏感信息扫描与 Git 历史核查

**任务描述**：公开前确认工作区与全部 Git 历史不含敏感信息。
**执行步骤**：
1. 扫描当前工作区：`gitleaks detect`、`trufflehog git file://.`（或同类工具）。
2. 重点核对本项目的敏感面：
   - 网盘蜘蛛运行时目录及 cookie：`FM/`、`DuoDuo/`、`VOX/`、`TV/`、`TVBox/`（已 ignore，确认未被历史跟踪）；
   - 本地编排器配置：`ha-orchestrator.config*.json`、`.omo/`、`.zcode/`；
   - jar-runner 构建产物：`python-backend/jar-runner/*.jar` 及 `test-build*/`；
   - 测试夹具派生文件：`single.json.gz`、`disguise.jpg/png`。
   执行 `git ls-files | grep -iE "cookie|token|secret|\.jar$"` 类检查确认未入库。
3. 本仓库历史可能包含未开源时期（影视 PC）提交，扫描必须覆盖完整历史；若发现泄漏，用 `git filter-repo --path <文件> --invert-paths` 清除后强推（公开前操作成本最低）。
**验收标准**：扫描零告警；`git log --all --diff-filter=A --name-only` 抽查无敏感文件曾被跟踪。

---

### G02 大文件与仓库体积复核

**执行步骤**：
1. `git ls-files` 列出全部被跟踪文件，按体积排序，确认无构建产物、二进制、压缩包误入库。
2. 核对 `.gitignore` 与 `package.json` 的 `build.files` 一致性：`python-dist/`、`vendor/`、`dist/`、`.venv/`、`__pycache__/` 均不入库也不入安装包源。
3. `python-backend/` 下散落的 `*-error.zip` 运行残留确认未被跟踪。
**验收标准**：被跟踪文件中不存在 >5MB 的非必要文件；`git status` 干净。

---

### G03 添加 LICENSE 文件（MIT）

**执行步骤**：
1. 在根目录创建 `LICENSE`，写入完整 MIT 许可证文本（与 `package.json` 的 `license: "MIT"` 保持一致）。
2. 版权行填写版权人（作者名或组织）与年份。
3. README 的 License 信息处注明 MIT 并链接该文件。
**验收标准**：GitHub 仓库页正确识别许可证为 MIT。

---

### G04 第三方组件与二进制许可声明

**任务描述**：桌面应用以安装包形式分发第三方二进制，必须逐项核实许可义务。
**执行步骤**：
1. 新建 `docs/THIRD_PARTY.md`（或 THIRD-PARTY-NOTICES），逐项列出并核实：
   - Electron（MIT）、electron-builder、electron-updater；
   - mpv、ffmpeg、aria2c：核实实际分发的构建版本采用 GPL 还是 LGPL 构建，二者再分发义务不同，按实际产物记录；
   - Anime4K、MiSans 字体：核实其许可证是否允许随安装包再分发；
   - Python 后端依赖：以 `python-backend/requirements.txt` 为准汇总主要许可证。
2. 致谢章节注明参考的上游项目：Kazumi、FongMi/TVBox、CatVod 生态；说明 `../Kazumi-main/` 与 `TV-fongmi/` 仅为本地对照资料，不在本仓库内。
3. README 添加"第三方组件与许可"小节指向该文档。
**验收标准**：每个随安装包分发的第三方组件都有许可证出处与合规结论；发布页附带声明文本。

---

### G05 Release 工作流（tag → 安装包）

**执行步骤**：
1. 新建 `.github/workflows/release.yml`：触发条件 `on: push: tags: ["v*"]`，runs-on `windows-latest`。
2. 步骤：checkout → setup-node(20) → `npm ci` → `npm run build:py` → `node scripts/download-binaries.js misans` → `npx electron-builder --win` → 上传 `dist/*.exe` 构件并创建 draft Release（可复用 ci.yml 中 B3 注释规划）。
3. macOS/Linux job 先注释占位：对应平台打包与冷启动验证仍在 [PROGRESS.md](../PROGRESS.md) 计划内，验证通过后再启用。
4. 在 README 或 CONTRIBUTING 说明发布流程：更新 CHANGELOG → 推 tag → 检查 draft Release → 附 Release Notes → publish。
**验收标准**：推送测试 tag 后 Actions 自动产出 NSIS 安装包并生成 Release 草稿。

---

### G06 CHANGELOG.md

**执行步骤**：
1. 根目录创建 `CHANGELOG.md`，遵循 [Keep a Changelog](https://keepachangelog.com/) 格式。
2. 首个条目 `0.1.0`：从 [PROGRESS.md](../PROGRESS.md) 与 [DEVELOPMENT_HISTORY.md](DEVELOPMENT_HISTORY.md) 提炼，按 Added / Changed / Fixed 分类；已知边界如实写入（macOS/Linux 待验证、弹幕功能停用等）。
3. 维护方式：每次发版前更新，已发布版本不再改动原文。
**验收标准**：v0.1.0 条目覆盖当前 README"当前状态"所列能力与边界。

---

### G07 CONTRIBUTING.md

**执行步骤**：
1. 创建 `CONTRIBUTING.md`，内容基于本项目现状：
   - 环境要求：Node.js 20+、Python 3.14、Windows 主开发平台；
   - 本地开发：`npm install` → `npm start`（后端由应用拉起，也可 `npm run backend` 单独调试）；
   - 质量门禁：提 PR 前 `npm run test:all` 必须通过；
   - 代码风格：ESLint（JS）+ Ruff（Python），配置在根目录 `eslint.config.js` / `ruff.toml`；
   - 文档要求：遵守 [docs/README.md](README.md) 维护规则（状态进 PROGRESS、故障进 RUNTIME_ISSUES、架构先行）；
   - Issue 与 PR 流程、行为准则链接。
2. README 指向该文件。
**验收标准**：新贡献者仅凭该文档可完成环境搭建并提交合格 PR。

---

### G08 CODE_OF_CONDUCT.md

**执行步骤**：采用 Contributor Covenant 模板；联系方式先留 GitHub Issues，不编造公开邮箱。README 提及。
**验收标准**：文件存在且模板完整。

---

### G09 Issue/PR 模板

**执行步骤**：
1. `.github/ISSUE_TEMPLATE/bug_report.md`：YuKi 版本、Windows 版本、复现步骤、预期/实际行为、相关日志（注意脱敏）。
2. `.github/ISSUE_TEMPLATE/feature_request.md`：场景、期望方案、替代方案。
3. `.github/PULL_REQUEST_TEMPLATE.md`：变更说明、测试证据（CI 链接或本地 `test:all` 输出）、关联 Issue。
**验收标准**：新建 Issue/PR 时自动加载模板。

---

### G10 依赖审计门槛收紧

**执行步骤**：
ci.yml 中两处审计目前不拦截：`npm audit --omit=dev || true` 与 `pip-audit --strict || true`。观察期满后移除 `|| true` 使高危漏洞阻断合并；短期无法清零的项在 `docs/THIRD_PARTY.md` 记录豁免理由与跟进计划。
**验收标准**：CI 中审计失败即红；无未记录的高危豁免。

---

### G11 v0.1.0 Tag 与 Release Notes

**执行步骤**：
1. 确认 `package.json` 版本为 `0.1.0` 且 G01–G06 全部通过。
2. 打附注标签：`git tag -a v0.1.0 -m "Release v0.1.0" && git push origin v0.1.0`。
3. Release Notes 从 CHANGELOG 提炼，如实包含：新功能（CatVod 引擎、Kazumi 规则、mpv 播放链路、下载、收藏/历史/WebDAV/SyncPlay、TVBox 兼容基础）、已知问题（macOS/Linux 待验证、弹幕界面停用）、升级注意事项（首版无自动升级路径）。
**验收标准**：Release 页面显示完整说明并挂载 Windows 安装包。

---

### G12 README 徽章

**执行步骤**：README 顶部添加 CI 徽章、License 徽章、Release 徽章（替换实际 `user/repo`）；如接入 Codecov 再加覆盖率徽章。
**验收标准**：徽章渲染正常且跳转有效。

---

## 五、执行顺序建议

1. **合规清理（公开前提）**：G01 → G02 → G03 → G04 —— 仓库可安全转为公开。
2. **社区与文档**：G06 → G07 → G08 → G09。
3. **发布流水线**：G05 → G10。
4. **首发**：G11 → G12 —— 成功发布 v0.1.0。

## 六、注意事项

- **Git 历史**：仓库包含未开源时期的提交，G01 必须覆盖全量历史；`filter-repo` 会改写历史，务必在公开前、协同开发开始前完成。
- **二进制许可**：mpv/ffmpeg 按 GPL/LGPL 不同构建有不同的再分发义务，G04 逐项核实后才可发布安装包；不得直接照抄上游声明。
- **对照资料**：`../Kazumi-main/` 与 `TV-fongmi/` 是本地对照资料，不在本仓库内；不要复制其源码或文档入库，致谢即可。
- **功能边界**：弹幕界面与播放时弹幕加载处于停用状态（见 README），对外文案与 Release Notes 如实描述，避免误导。
- **命令验证**：所有文档中的命令须在 Windows 主开发机实测；compat job 依赖外网且为手动触发，不作为常规门禁。
- **状态同步**：任一任务完成后在 `PROGRESS.md` 更新状态并链接证据；本文档只维护计划与验收项本身。
