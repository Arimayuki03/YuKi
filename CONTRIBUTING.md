# 贡献指南

感谢关注 YuKi。本文档帮助你在本地跑起来项目并提交合格的贡献。行为准则见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | 20+（开发机实测 24.18） | 主进程 / 渲染层 / 构建脚本 |
| Python | 3.14（开发机实测 3.14.4） | 后端 FastAPI 独立进程 |
| Windows | 10/11 x64 | 当前唯一验证平台；macOS/Linux 打包尚未验证 |
| mpv / aria2c / ffmpeg / Anime4K | 由脚本管理 | `vendor/` 目录，不入库；应用启动会自动补齐，也可手动下载 |

## 本地开发

```powershell
# 1. 安装依赖（postinstall 会尝试下载 Anime4K 着色器，失败不阻塞）
npm install

# 2. 准备 Python 虚拟环境与依赖
python -m venv python-backend/.venv
python-backend\.venv\Scripts\python.exe -m pip install -r python-backend/requirements.txt
python-backend\.venv\Scripts\python.exe -m pip install ruff

# 3. 启动完整应用（后端由 Electron 自动拉起）
npm start

# 如需单独调试后端：
npm run backend
```

第三方二进制手动下载（通常不需要，应用启动会自动补齐）：

```powershell
node scripts/download-binaries.js all   # mpv / aria2c / anime4k / ffmpeg / misans
```

## 质量门禁

提交 PR 前，以下命令必须全绿：

```powershell
npm run test:all
# 等价于依次执行：test:py → test:jsunit → test:js → lint → lint:py
```

- **Python 回归**：`python-backend/tests/run_all.py`（smoke、phase3、kazumi、jar 等；无 JDK 时 jar-e2e 自动跳过）
- **JS 单测**：`tests/js/*.test.js`（node --test）；**语法门禁**：`scripts/check-js.js`
- **Lint**：ESLint（配置 `eslint.config.js`）+ Ruff（配置 `ruff.toml`）

冒烟测试（需要后端可启动）：`npm run smoke`

## 代码风格与约定

- JS 遵循 ESLint 规则；Python 遵循 Ruff 规则；两者均为 CI 门禁。
- 新增 UI 文案使用简体中文。
- 关键架构约束（务必遵守，详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)）：
  - CatVod 与 Kazumi 保持物理隔离：CatVod 走 `/action`，Kazumi 走 `/kazumi/action`；
  - 配置热更新必须先完整构建新状态再一次性替换，禁止先销毁当前可用配置；
  - 解析窗口使用隔离 partition，用后销毁并清理 `webRequest` 监听；
  - 本地文件操作必须通过主进程白名单根，任何解析结果再次校验路径未越界。

## 文档维护规则

遵守 [docs/README.md](docs/README.md) 的约定：

- 当前状态只写根目录 `PROGRESS.md`，不要另建第二份总待办；
- 运行故障只进 `docs/RUNTIME_ISSUES.md`（带时间、证据、复测结论）；
- 架构 / 接口变化先改 `docs/ARCHITECTURE.md` 再改代码；
- Kazumi 行为变化同步 `docs/KAZUMI_INTEGRATION.md`；
- 第三方依赖变化同步 `docs/THIRD_PARTY.md`。

## Issue 与 PR 流程

1. **Issue**：优先搜索既有 Issue 避免重复；Bug 报告请使用 Bug 模板并附日志（注意脱敏 cookie/token）。
2. **PR**：
   - 一个 PR 聚焦一件事；大改动建议先开 Issue 讨论；
   - 使用 PR 模板填写变更说明与测试证据（CI 链接或本地 `test:all` 输出摘要）；
   - CI（`.github/workflows/ci.yml`）全绿是合并前提。
3. **发布**：由维护者按下方流程执行，普通贡献者无需操作。

## 发布流程（维护者）

1. 更新 `CHANGELOG.md`（Keep a Changelog 格式），确认 `package.json` 版本号；
2. 提交并推送主分支；
3. 打附注标签并推送：`git tag -a vX.Y.Z -m "Release vX.Y.Z" && git push origin vX.Y.Z`；
4. GitHub Actions 会触发 `.github/workflows/release.yml`：Windows runner 上构建 NSIS 安装包并创建 **draft Release** 并挂载产物；
5. 检查 draft Release：核对产物可用性，把 `CHANGELOG.md` 对应条目提炼为 Release Notes，然后 publish。
