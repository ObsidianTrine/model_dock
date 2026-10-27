---
id: doctor-hardened-checks
type: feature
created_at: 2026-10-27T00:00:00+08:00
created_by: human
files_hint:
  - src/cli/diag.ts
  - test/diag.test.ts
workflows:
  - feature-branch
gate: L3
---

# 目标
把历史踩坑模式沉淀为 `modeldock doctor` 检查项，用户少走手工排障路（doctor 机制已完备：ok/warn/bad/info + DoctorFix 可操作修复）。

# 验收标准
- 先核对 diag.ts 现有检查集（以下条目推测未覆盖，若已覆盖则不重复做，在交付说明里写明核对结论）
- 每个新检查项至少一正一反用例进 test/diag.test.ts；`--json` 输出同步更新；文案走 t() 双语
- `npm test` 全绿

# 新检查项
1. **沙箱自启残留**（known-issues CORRECT-05 遗留清理）：darwin 下 `launchctl print gui/$(id -u)/com.modeldock.gateway` 核对 program 路径是否指向沙箱路径或无效路径 → warn + `--fix` 代清理（bootout）；Windows/Linux 对应自启形态同理核查（若适用）
2. **钥匙环故障 vs 条目缺失区分**：secrets 层语义已修（REVIEW-19：44/空输出=不存在可缓存、故障上抛）——doctor 侧把"读取失败/钥匙环锁定"报 warn + 解锁 hint，不与"未配置密钥"混同
3. **跨机密文引用**：检测 config/secrets 中的异平台密文前缀引用（enc:mach: / enc:dpapi:，REVIEW-18 语义）→ 报"此配置含他机密文引用，请对相应服务重新 set-key"

# 红线
- `--fix` 的写操作遵守沙箱守卫（FAKE_HOME 下只作用沙箱自身）
- 不自动删除任何用户数据——清理动作必须 --fix 显式触发，且删前打印将删内容
