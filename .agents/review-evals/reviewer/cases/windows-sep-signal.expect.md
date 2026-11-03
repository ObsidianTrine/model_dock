<!--
考点：Windows 不兼容双杀。①手写 '/' 分隔符；②SIGTERM 信号语义在 Windows 上是硬杀。
两个独立阻塞点，各自命中任一关键词即记命中。
-->

# 期望判定

clean: false

## 应抓（阻塞点）
- [P1] 关键词: 分隔符|path.join|path.sep|斜杠|win32|Windows — 手写 '/' 拼接与切分路径：违反 path.join()/path.resolve() 约定（AGENTS 工程硬性约定），Windows 侧输入行/路径分隔符不同会整类失配；正则/切分匹配分隔符应写 [\\/]
- [P1] 关键词: SIGTERM|信号|硬杀|taskkill — 依赖 SIGTERM「礼貌终止」：Windows 无信号语义，kill(pid,'SIGTERM') 是硬杀且管不到子进程树（停进程树用 taskkill /T /F），注释承诺的等 2s 再强杀不成立

## 不应抓（噪音）
- 关键词: 魔法数字|2000|常量提取 — 建议级提及可以，阻塞级报告算误报
- 「waitExit 是同步忙等」「建议 async 化」——函数体在 hunk 之外材料不足，阻塞级报告算误报
- 关键词: 命名|JSDoc — 风格类不报
