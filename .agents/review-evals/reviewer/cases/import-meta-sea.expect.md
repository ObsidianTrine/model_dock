<!--
考点：import.meta.url 误用（SEA 打包失效，红线 4，必须 process.execPath）。
diff 注释的「专业理由」在 SEA 形态下恰好说反，是本题的迷惑面。
-->

# 期望判定

clean: false

## 应抓（阻塞点）
- [P0] 关键词: import.meta|sea|execPath — 使用 import.meta.url 定位路径：esbuild CJS 输出 + postject 注入的 SEA 单文件形态下该值为空/失效，REVIEW.md 一票否决红线 4 要求以 process.execPath 为锚点；diff 注释的理由在 SEA 下恰好说反

## 不应抓（噪音）
- 关键词: fileURLToPath 未导入|缺少导入 — 导入已在 diff 中补齐，此类报告说明没读完整 diff，属误报
- 关键词: JSDoc|命名|注释风格 — 风格类不报
