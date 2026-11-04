// 测试进程全局降 PBKDF2 迭代数（产品套件与工作流套件共用本 setup）。
// 依据（2026-11-03 实测）：600k 轮单次派生约 270ms，sync 全链路每次 collect/apply/导入导出
// 都真派生——是本机产品套件最大单一慢源（5 个最慢 sync 文件 63s→18s）。1000 轮安全性不受影响：
// seal 经 SyncKeys.iter、open 经信封 kdf.iter 各自携带派生时的真实迭代数，seal/open 配对与
// 全局值解耦（envelopeIter 回读见 src/sync/crypto.ts）。本进程只跑测试、从不跑生产路径。
// 个别用例要验证真实 600k 行为时，用例内 setPbkdf2IterForTests(null) 显式还原。
import { setPbkdf2IterForTests } from '../src/sync/crypto.js'

setPbkdf2IterForTests(1000)

// 测试进程全局禁 models.dev 目录网络刷新（refreshCatalog 首行短路，任何 timer 触发都 no-op）。
// 依据（2026-11-04 v1.6.0 release 五腿实测踩中）：网关 server 默认注册 90s 后的目录刷新
// timer（createGatewayServer autoCatalogRefresh），close 挂起时 timer 跨用例存活到点真跑——
// 网络成功回写缓存后 catalogBaseMemo 按 mtime 重建、flat 表被缓存覆盖快照，价目中途漂移，
// usage-cost E2E 同用例内「开头查价命中 / 聚合查价 miss」分裂（win32/darwin-arm64 红、
// ubuntu/darwin-x64 绿，纯网络竞速 flaky，同提交 test.yml 同平台也时绿时红）。
// 测试进程从不出网；个别用例要验证刷新提示语时（cli-providers-more）用例内 set/restore
// 同名 env，与全局 '1' 语义兼容，无泄漏。
process.env.MODELRDOCK_DISABLE_CATALOG_FETCH = '1'
