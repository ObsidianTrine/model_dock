#!/usr/bin/env node
// dev 沙箱「首次使用」种子化：从生产配置复制服务/路由，但剥离客户端接管登记（[harness.*]）。
//
// 供 run_dev.sh / run_dev.bat 首次启动时调用（两者只做环境变量设置，实际复制逻辑统一收口到这里）。
//
// 为什么剥离 harness：
//  1. 生产侧的 [harness.dsh] 等登记带 mode/route/files——原样拷进沙箱后，沙箱会误以为该客户端
//     已接入/钉定：gateway/direct 模式登记会被删除守卫拦下（「有客户端钉定/直连在该服务的路由上」），
//     控制台也会把从未在沙箱里写入过的客户端显示成「已接入」，断开/切模式操作的都是沙箱里
//     不存在的客户端文件，状态错乱。
//  2. 登记里的 files 指向真实客户端文件路径（如 ~/.dsh/...），沙箱内的快照/还原若沿这些路径
//     操作，可能碰到生产客户端文件。
//  生产配置本身不拷贝时原样保留，这里只剥离 harness 段（provider/profile/key 照搬，沙箱里
//  需接入的客户端在沙箱内自行 attach，写的是沙箱自己的客户端目录）。
//
// 幂等：沙箱已有 config.toml 则跳过（不覆盖用户在沙箱里的改动）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sandboxHome = process.env.MODELRDOCK_FAKE_HOME || ''
const realHome = os.homedir()
if (!sandboxHome) {
  console.error('[dev-seed] MODELRDOCK_FAKE_HOME 未设置（应由 run_dev 传沙箱目录）')
  process.exit(1)
}
const sbMdk = path.join(sandboxHome, '.modeldock')
const sbCfg = path.join(sbMdk, 'config.toml')
const sbSecrets = path.join(sbMdk, 'secrets.json')
const prodCfg = path.join(realHome, '.modeldock', 'config.toml')
const prodSecrets = path.join(realHome, '.modeldock', 'secrets.json')

if (fs.existsSync(sbCfg)) process.exit(0) // 沙箱已初始化，跳过
if (!fs.existsSync(prodCfg)) process.exit(0) // 生产无配置，无种子来源
fs.mkdirSync(sbMdk, { recursive: true })

const stripped = stripHarnessSections(fs.readFileSync(prodCfg, 'utf8'))
fs.writeFileSync(sbCfg, stripped, 'utf8')
if (fs.existsSync(prodSecrets)) fs.copyFileSync(prodSecrets, sbSecrets)
console.log('[dev] 已复制生产服务配置到沙箱（已剥离客户端接管登记）；两边此后互不影响')

/** 去掉 TOML 中的 [harness] 与 [harness.*] 段（连同其键值行）。行首 `[` 即段首。 */
function stripHarnessSections(toml) {
  const isHarnessHeader = (l) => /^\[harness(\..*)?\]/.test(l)
  let inHarness = false
  return toml
    .split(/\r?\n/)
    .filter((line) => {
      if (line.startsWith('[')) inHarness = isHarnessHeader(line)
      return !inHarness
    })
    .join('\n')
}
