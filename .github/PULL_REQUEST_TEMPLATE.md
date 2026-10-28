## 改动说明

<!-- 动机 + 做了什么 -->

## 关联 issue

<!-- 如有：Fixes #123 -->

## 测试方式

<!-- 怎么验证的：命令 + 关键输出 / 截图。Claude 可代填，但由发起改动的人签字确认。 -->

- [ ] `npm test` 全绿
- [ ] 新增 / 修改行为有测试覆盖（如适用）

## 风险等级

<!-- CI 按改动文件自动打 risk:* label（规则见 scripts/pr-risk-tier.mjs），与自评有出入时在此说明。 -->

- [ ] 低（文档 / 模板 / 纯注释）
- [ ] 中（常规产品改动）
- [ ] 高（网关核心 / 密钥 / CI / 发布面，见 .agents/workflow.json corePaths/releasePaths）

## 如何回滚

<!-- 一句话：revert 本 PR / 恢复某文件 / 走旧版安装包；高风险改动必填。 -->

## 检查清单

- [ ] 文档已同步：用户可见改动已按 [.agents/conventions/docs-writing.md](https://github.com/ObsidianTrine/model_dock/blob/main/.agents/conventions/docs-writing.md) 更新 CHANGELOG / README
- [ ] 无新增 native addon 依赖（SEA 打包前提）
- [ ] 测试未监听 8687（生产）/ 8890（dev）、未触碰生产实例
- [ ] AI 审查与安全审查的全部发现已处理（修复，或在线程里回复理由后 resolve）
