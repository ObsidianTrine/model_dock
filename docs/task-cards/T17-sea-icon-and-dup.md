---
id: sea-icon-and-dup
type: refactor
created_at: 2026-10-29T00:00:00+08:00
created_by: human
files_hint:
  - scripts/build-sea.mjs
workflows:
  - feature-branch
gate: L3
---

> **状态**：✅ 已完成——merged 9ccf9b8（2026-10-30 收口盘点）

# 目标
削减 build-sea.mjs 构建期纯计算浪费：mac 图标 SDF 渲染计算量降 4×，托盘 swiftc 与 win .ico 重复生成收敛。CI darwin 腿 10× 计费口径下这是该腿性价比最差的部分（每腿 10-40s 纯 JS）。

# 背景（行号基于 2026-10-29 develop，动手前核实）
- `ICON_MASTER = 4096`（build-sea.mjs:507）；renderIconMaster 逐像素取样 16.7M 像素（:576-588，每像素 4 段圆头 SDF + 径向柔光 + 多次数组分配）；generateIconset 7 尺寸盒式降采样 ≈1.17 亿次内层迭代（:590-622）。buildMacApp（:656-708）对每个 darwin target 各渲染一整套——**图标与 target 架构完全无关**，`--target all` 本地双份、CI darwin 两腿各一份。
- swiftc 托盘双编：ensureMacTray（:422-436，经 packageDistributions 调用 :359）与 buildMacApp 内（:684-696）对同一 target 各编一次；且 ensureMacTray 输出路径不含 arch，`--target all` 循环内靠重编覆盖。
- generateIco 在 win 流程被调 3 次（:283、:392、:971）。

# 实施要求
1. `ICON_MASTER` 4096 → 2048：1024px 最大尺寸（mac iconset 上限）仍有 2× 超采样，质量损失可忽略；文件内与图标质量相关的注释同步更正。
2. renderIconMaster / generateIconset 结果模块级缓存：同一进程内同参数第二次调用直接返回缓存（`--target all` 本地构建 2→1 次）。
3. buildMacApp 复用 ensureMacTray 产物：产物落点改为**按 target 区分文件名**（修掉现「不含 arch 靠重编覆盖」的隐患），buildMacApp 内改为 copy 复用而非重编；两条路径对产物的写入/清理逻辑保持一致，编译日志各 target 仍可辨。
4. generateIco 按输出路径 memo：同路径同参数第二次调用直接返回首次产物（三处调用点零改动）。

# 验收标准
- 本机（mac）`node scripts/build-sea.mjs --target <darwin-x64>` 跑通，产物结构完整；icns 用 `iconutil` 校验合法（如环境可用）。
- `--target all` 下日志/计时证明：icon master 渲染只发生一次、托盘 swiftc 每个 target 恰一次、ico 每路径一次。
- 与改动前产物对比：压缩包内除 icns/ico 二进制（2048 重采样所致）外字节一致；如实记录差异。
- `npm test` 全绿（build-sea 既有测试如有）。

# 红线
- 不改发布物形态与命名（压缩包 / SHA256SUMS / ModelDock.app / .dmg / *-setup.exe）；不动 SEA 注入、postject、Inno Setup 流程。
- 不采用「图标资产预生成入库」方案（需引入「改图标先重跑生成脚本」纪律，本轮明确不做，仿 dmg-hint.png 先例留待将来）。
- generateIco memo 不得改变首次生成行为；Windows 分支逻辑改动仅限 memo 化。
