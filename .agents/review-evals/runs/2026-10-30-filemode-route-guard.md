# 2026-10-filemode-route-guard — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent（与 8/8 基线的 deepseek-v4-pro 评分器不同）
- 关键词：file=中，悬空=中
- 结论：发现 4 个问题。问题 1 即目标缺陷——两处删除守卫（profiles.ts:128、providers.ts:244-248）对 `he.route === name` 无 mode 过滤：file 模式（自管路由、route 仅登记痕迹）被误拦（报错断言「该客户端请求 503」对 file 模式不成立）+ 删除成功后留悬空登记引用；引 77fa6b8 修复佐证（加 `he.mode !== 'file'` + route 复位 default）
- **评测循环产出的活 bug（当前版仍在）**：问题 2 = cmdProviderAdd「共 N 个」取过期快照必错（正确写法就在同文件 cmdModelRefresh）；问题 3 = cmdProviderRm 先不可逆删密钥、后做可失败的配置写——失败即丢凭据（同文件 add 路径有对称回滚，删除路径缺）；问题 4 = ensureProfile 重名误报「已创建」

## 目标缺陷证据（摘）

> - profiles.ts:128（cmdProfileRm）：`he.route === name` 无任何 mode 过滤。file 模式客户端自管路由、不经网关转发，route 只是登记痕迹：
>   误拦——仅被 file 模式「钉定」时删除被拒，报错断言「该客户端请求 503」对 file 模式不成立；
>   残留——删除成功后 file 模式 harness 的 route 仍指向已删 profile（mutateConfig 不清理 route）。
> - providers.ts:244-248（cmdProviderRm）同类，无 mode 过滤。
> - 真实修复：77fa6b8 两处加 `he.mode !== 'file'`，并在删除事务与 removeProviderCascade 中把 file 模式 route 复位 'default'。
