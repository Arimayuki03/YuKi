# 文档索引

本目录只维护影视 PC 当前实现、专项设计、运行问题和历史记录。Kazumi Flutter 原版文档位于 `../../Kazumi-main/`，仅供对照。

## 阅读顺序

1. [项目 README](../README.md)：项目用途、快速开始和文档入口。
2. [当前开发状态](../PROGRESS.md)：当前完成范围、边界、约束和下一步。
3. [系统架构](ARCHITECTURE.md)：进程模型、双引擎、播放、下载和数据流。
4. 按任务进入专项文档。

## 专项文档

| 文档 | 用途 | 状态 |
|---|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | 当前系统架构与不可破坏的契约 | 持续维护 |
| [KAZUMI_INTEGRATION.md](KAZUMI_INTEGRATION.md) | Kazumi 规则系统的数据模型、接口和实现 | 当前实现说明 |
| [KAZUMI_GAP_ANALYSIS.md](KAZUMI_GAP_ANALYSIS.md) | 与 Kazumi v2.2.6 的功能差距和产品取舍 | 当前对比 |
| [RUNTIME_ISSUES.md](RUNTIME_ISSUES.md) | 运行日志发现的问题、根因、修复和复测状态 | 实时维护 |
| [TEST_REPORT.md](TEST_REPORT.md) | 全量功能测试矩阵、自动化测试结果与需用户实测清单 | 实时维护 |
| [DEVELOPMENT_HISTORY.md](DEVELOPMENT_HISTORY.md) | Phase、U/T 批次、历史决策和踩坑记录 | 只追加或勘误 |

## 状态优先级

文档描述发生冲突时，依次采用：

1. `RUNTIME_ISSUES.md` 中带时间和证据的最新运行状态。
2. 根目录 `PROGRESS.md` 中的当前范围和待办。
3. `ARCHITECTURE.md` 与 Kazumi 专项文档中的现行设计。
4. `DEVELOPMENT_HISTORY.md` 中的历史记录。
5. `Kazumi-main` 中的上游实现说明。

“Kazumi 整合完成”仅表示影视 PC 已完成既定 Kazumi 接入范围，不代表与 Flutter 原版功能完全相同。

## 维护规则

- 当前状态只写入 `PROGRESS.md`，不要在历史文档中创建第二份待办清单。
- 运行故障只在 `RUNTIME_ISSUES.md` 维护详细日志和复测结论。
- 架构、接口或数据目录变化先更新 `ARCHITECTURE.md`，再改代码。
- Kazumi schema、端点或解析流程变化同步更新 `KAZUMI_INTEGRATION.md`。
- 与上游的功能差距发生变化时更新 `KAZUMI_GAP_ANALYSIS.md`。
- 已完成批次和重要历史原因写入 `DEVELOPMENT_HISTORY.md`，避免把流水账重新塞回 `PROGRESS.md`。
- 避免依赖容易漂移的行号；使用稳定标题和相对链接。
