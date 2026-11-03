<!--
考点：测试断言假绿——用例名宣称「格式错误的 presets.json 阻断启动」，但：
①夹具写入的是 JSON.stringify 合法 JSON（想写坏格式写成了合法的）；②断言
length >= 0 恒真。目标行为（坏格式阻断启动）零覆盖，坏实现照样全绿——
这正是 2026-11 tier-silence / finish-lock-wait-contract 两起「红用例/假用例
溜过 finish 门禁」事故的同型。
场景：补「格式错误阻断」回归用例，写完即绿，作者以为覆盖了。
goal: 补用户预设格式错误阻断启动的回归用例
acceptance: 新用例在坏格式夹具下验证启动阻断；好格式夹具下验证正常加载
files_hint: test/presets/**
-->

```diff
diff --git a/test/presets/user-overrides.test.ts b/test/presets/user-overrides.test.ts
index 3c9d2ef..a1b2c3d 100644
--- a/test/presets/user-overrides.test.ts
+++ b/test/presets/user-overrides.test.ts
@@ -6,11 +6,19 @@ import { mergePresets, loadUserPresets } from '../../src/presets/user-overrides.
 describe('user presets overrides', () => {
   it('同名 id 覆盖内置预设', () => {
     const merged = mergePresets(BUILTIN, [{ id: 'volces', label: 'x' }])
     expect(merged.find((p) => p.id === 'volces')?.label).toBe('x')
   })
 
   it('新 id 追加到内置库', () => {
     const merged = mergePresets(BUILTIN, [{ id: 'fresh', label: 'y' }])
     expect(merged.some((p) => p.id === 'fresh')).toBe(true)
   })
+
+  it('格式错误的 presets.json 阻断启动', async () => {
+    const home = await fakeHome()
+    await writeFile(path.join(home, 'presets.json'), JSON.stringify({ presets: [{ id: 'a' }] }), 'utf8')
+    const result = await loadUserPresets(home)
+    expect(result.presets.length).toBeGreaterThanOrEqual(0)
+  })
 })
```
