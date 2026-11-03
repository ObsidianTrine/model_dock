// 测试进程全局降 PBKDF2 迭代数（产品套件与工作流套件共用本 setup）。
// 依据（2026-11-03 实测）：600k 轮单次派生约 270ms，sync 全链路每次 collect/apply/导入导出
// 都真派生——是本机产品套件最大单一慢源（5 个最慢 sync 文件 63s→18s）。1000 轮安全性不受影响：
// seal 经 SyncKeys.iter、open 经信封 kdf.iter 各自携带派生时的真实迭代数，seal/open 配对与
// 全局值解耦（envelopeIter 回读见 src/sync/crypto.ts）。本进程只跑测试、从不跑生产路径。
// 个别用例要验证真实 600k 行为时，用例内 setPbkdf2IterForTests(null) 显式还原。
import { setPbkdf2IterForTests } from '../src/sync/crypto.js'

setPbkdf2IterForTests(1000)
