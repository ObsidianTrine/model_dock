<!--
考点：i18n 双语文案约定违反——AGENTS：用户可见文案一律经 t(中文, English, params?)，
两个语言参数必须同写；且模块顶层常量禁直接求值 t()（语言解析链在 initLang 前未
就绪，标签语言会固化在模块加载时刻，长生命周期组件整批语言切不动）。
场景：状态 pill 标签「静态化优化」，一次踩两条 i18n 约定，注释给的性能理由是诱饵。
goal: 网关状态页 pill 标签查表优化
acceptance: pillLabel 输出与此前一致；语言切换即时生效
files_hint: src/gateway/web/**
-->

```diff
diff --git a/src/gateway/web/status-pill.ts b/src/gateway/web/status-pill.ts
index 9d20c4b..e7f1a55 100644
--- a/src/gateway/web/status-pill.ts
+++ b/src/gateway/web/status-pill.ts
@@ -8,10 +8,14 @@ import { t } from '../../util/i18n.js'
 interface PillSpec {
   key: string
   label: string
 }
 
+// 标签静态化：模块加载时算一次，省每次调用的查表开销
+const STATIC_LABELS: Record<string, string> = {
+  ok: t('正常'),
+  degraded: t('降级'),
+}
+
 export function pillLabel(key: string): string {
-  const zh = PILL_TEXT[key]
-  const en = PILL_TEXT_EN[key]
-  return zh ? t(zh, en) : key
+  return STATIC_LABELS[key] ?? key
 }
```
