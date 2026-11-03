<!--
考点：越界改动：files_hint 声明 src/presets/**，diff 混入 src/gateway/server.ts
无关风格调整。审「超出预期范围」而非审 String() 写法本身。
-->

# 期望判定

clean: false

## 应抓（阻塞点）
- [P1] 关键词: 越界|超出|范围|files_hint|无关|混入|scope — 改动超出 files_hint（src/presets/**）：src/gateway/server.ts 的日志写法调整与目标无关，属越界混入（scope_purity 纪律：范围失控不静默合并）

## 不应抓（噪音）
- 关键词: String()|包装多余|模板字符串 — server.ts 改动本身的问题就是「不该出现在这个 diff 里」，对其写法的二次风格评判属噪音
- 「tags 保留写法可以更直白」——merge.ts 的实现风格，建议级可以，阻塞级算误报
- 关键词: JSDoc|命名 — 风格类不报
