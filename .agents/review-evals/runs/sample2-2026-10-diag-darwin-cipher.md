# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-diag-darwin-cipher — ✅ 审出

- 考题：跨机密文检测缺 darwin / 无加密形态分支——nativePrefix 为空（plain cipher）时任何 enc: 密文按异机报的判定缺失，macOS 上 secrets 表条目漏报
- 关键词：nativeprefix=中，enc:=中，darwin=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-RzKGJ4/2026-10-diag-darwin-cipher.output.txt

<details><summary>模型原文</summary>

```text
发现 3 个问题

**1.（即后来修复的真实 bug）`detectForeignCipherRefs` 在明文后端整类漏报异机密文 — src/cli/diag.ts:156**
`const nativePrefix = pickFileCipher().prefix`（147 行）在本平台 file 后端无加密时（darwin keychain 形态）返回空串 `''`，而 156 行判定 `v.startsWith('enc:') && !v.startsWith(nativePrefix)` 中 `!v.startsWith('')` **恒为假** → darwin/macOS 上 secrets.json 里任何 `enc:` 密文都判不出异机，`secrets.foreign_cipher` 永不触发，跨机拷贝后 401 无诊断。后续提交 53da3e2（补 `nativePrefix === '' ||` 分支）与 59f1aba（重构为 `if (nativePrefix && v.startsWith(nativePrefix)) continue`）正是修这个。

**2. `cmdEnv` 端口恒指向生产默认端口 8687 — src/cli/diag.ts:603**
`resolveClientGatewayPort(undefined, cfg.gateway?.port)` 内部（src/ops.ts:381）只要 8687 有存活网关且非沙箱环境就直接返回 8687，压过 `gatewayLive()` 的非默认端口实例与 `cfg.gateway.port`——用户起了非默认端口实例后 `eval "$(modeldock env)"` 会把 shell 指到 8687。后续提交 87b2106 改为 `gatewayLive() ?? cfg.gateway?.port ?? DEFAULT_GATEWAY_PORT`（与 cmdStatus 34 行同链）即修此。

**3. `cmdStatus` 缺 adapter 异常护栏，单个 adapter 抛错击穿整条 status — src/cli/diag.ts:38**
38 行 `Promise.all(... a.status(cfg, port))` 无 `.catch`；同文件 doctor 侧 431 行同款调用显式 `.catch((e) => e)` 并注释「单个 adapter 异常（如 pack 目标文件损坏）不应击穿整条体检」。任一 adapter（含 L2 pack，目标文件可损坏）抛错即 `Promise.all` reject，`modeldock status` 整体失败。当前 HEAD（`src/cli/diag.ts:38`）仍未修，属现行缺陷。

**存疑（证据不足，不立案）**
- 158 行 `v.indexOf(':', 4)` 为 -1 时 slice 得空串，仅影响展示，且畸形态本就异常。
- 604 行存量 `generic-env` 条目若无 `token` 字段会输出 `undefined`：未见能产生该形态的路径，缺证据。
```

</details>