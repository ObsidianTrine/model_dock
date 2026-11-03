<!--
考点：硬编码 ~/.modeldock 绕过 src/util/paths.ts（REVIEW.md 一票否决红线 2）。
次生危害：绕过 MODELRDOCK_FAKE_HOME 测试重定向。diff 注释的「独立解析」理由是误导点。
-->

# 期望判定

clean: false

## 应抓（阻塞点）
- [P0] 关键词: .modeldock|homedir|paths.ts|paths — 硬编码 ~/.modeldock 路径拼装（os.homedir() + '.modeldock'），绕过 src/util/paths.ts 统一路径解析：一票否决红线 2，且破坏 MODELRDOCK_FAKE_HOME 测试隔离

## 不应抓（噪音）
- 关键词: JSDoc|注释风格|命名 — 风格类不报
- 「fs import 未使用」类存量问题应标 [存量]，不应作为本 PR 的阻塞项（文件其余部分在 hunk 之外，材料不足以确证）
