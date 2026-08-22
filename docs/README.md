# 文档索引

这里维护 YuKi 的当前实现、专项设计、运行问题、测试结果和历史记录。上游项目（Kazumi 等）仅作为对照参考，不在本仓库内。

## 推荐阅读顺序

1. [项目 README](../README.md)：项目用途、快速开始和总入口。
2. [当前开发状态](../PROGRESS.md)：当前完成范围、边界、约束和下一步。
3. [系统架构](ARCHITECTURE.md)：进程模型、双引擎、播放、下载和数据流。
4. 根据具体任务进入专项文档或执行计划。

## 核心维护文档

| 文档 | 用途 | 维护方式 |
|---|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | 当前系统架构、接口契约和安全边界 | 架构变化时更新 |
| [KAZUMI.md](KAZUMI.md) | Kazumi 规则引擎整合说明与原版差距对照 | 实现或差距变化时更新 |
| [RUNTIME_ISSUES.md](RUNTIME_ISSUES.md) | 运行异常、日志证据、修复和复测状态 | 按问题追加并更新结论 |
| [TEST_REPORT.md](TEST_REPORT.md) | 自动化测试、界面验收和用户实测清单 | 测试结果变化时更新 |
| [THIRD_PARTY.md](THIRD_PARTY.md) | 第三方组件与许可声明 | 依赖变化时更新 |
| [DEVELOPMENT_HISTORY.md](DEVELOPMENT_HISTORY.md) | Phase、U/T 批次、历史决策和踩坑记录 | 只追加或勘误 |

## 审查、计划与兼容性文档

| 文档 | 用途 | 使用建议 |
|---|---|---|
| [TVBox/FongMi 功能一致性详细任务书](TVBOX_FONGMI_PARITY_TASKS.md) | 运行时隔离、drpy、Android Worker、播放收敛与发布验收 | 当前唯一执行入口 |

## 文档状态优先级

不同文档出现冲突时，按以下顺序判断：

1. `RUNTIME_ISSUES.md` 中带时间和证据的最新运行结论。
2. 根目录 `PROGRESS.md` 中的当前范围、边界和待办。
3. `ARCHITECTURE.md` 及 Kazumi 专项文档中的现行设计。
4. 对应任务计划中的执行状态和验收记录。
5. `DEVELOPMENT_HISTORY.md` 中的历史记录。
6. 上游项目或对照仓库中的说明。

“Kazumi 整合完成”只表示YuKi 已完成既定接入范围，不代表与 Flutter 原版功能完全一致。

## 维护规则

- 当前状态只写入 `PROGRESS.md`，不要在历史文档中复制第二份总待办。
- 运行故障只在 `RUNTIME_ISSUES.md` 维护详细日志、根因和复测结论。
- 架构、接口或数据目录变化先更新 `ARCHITECTURE.md`，再改代码。
- Kazumi 规则、端点或解析流程变化同步更新 `KAZUMI.md`。
- 已完成批次和重要历史原因写入 `DEVELOPMENT_HISTORY.md`，避免把流水账塞回 `PROGRESS.md`。
- 计划文档保留“目标、当前状态、剩余验收项”三部分；完成后标明完成日期，并链接到测试证据。
- 新增长期维护文档优先放入 `docs/`；根目录只保留项目入口、当前状态和需要显眼访问的执行计划。
- 使用稳定标题和相对链接，避免依赖会漂移的源码行号。

## 不纳入项目文档索引的 Markdown

- `node_modules/`、Python 虚拟环境等依赖目录中的许可证和上游说明。
- `.omo/`、`.zcode/` 中的一次性侦查和代理工作记录；它们只用于追溯过程，不作为当前事实来源。
