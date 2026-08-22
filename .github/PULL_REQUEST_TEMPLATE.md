## 变更说明

（做了什么、为什么做。如有关联 Issue 请写 `Fixes #123` 或 `Refs #123`）

## 变更类型

- [ ] 缺陷修复
- [ ] 新功能
- [ ] 重构 / 性能
- [ ] 文档
- [ ] 测试 / CI
- [ ] 其他

## 测试证据

- [ ] 本地 `npm run test:all` 全绿（粘贴输出摘要）
- [ ] 或附 CI 运行链接

```
（粘贴 test:all 输出摘要）
```

## 自查清单

- [ ] 遵守架构约束（CatVod/Kazumi 隔离、配置原子热更新、解析窗口隔离、本地文件白名单等）
- [ ] 涉及依赖变更时已同步 `docs/THIRD_PARTY.md`
- [ ] 涉及状态变化时已更新 `PROGRESS.md`；架构变化先改 `docs/ARCHITECTURE.md`
- [ ] 日志与文档中不含敏感信息（cookie/token/账号）
