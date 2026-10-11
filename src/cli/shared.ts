import type { Config } from '../config/types.js'
import { DEFAULT_GATEWAY_PORT } from '../config/types.js'
import { loadConfig } from '../config/store.js'
import { gatewayLive, type GatewayStateFile } from '../gateway/state.js'
import { c, t } from '../util/index.js'

export { gatewayLive, DEFAULT_GATEWAY_PORT }

export async function loadCfg(): Promise<Config> {
  return loadConfig()
}

export async function requireGateway(): Promise<GatewayStateFile> {
  const live = await gatewayLive()
  if (!live) {
    console.error(c.red(t('网关未运行。先启动：modeldock gateway start（或 --daemon 后台运行）', 'Gateway is not running. Start it first: modeldock gateway start (or --daemon to run in the background)')))
    process.exit(1)
  }
  return live
}

export function exitWithError(msg: string, hint?: string): never {
  console.error(c.red(`✗ ${msg}`))
  if (hint) console.error(c.yellow(t('提示: {h}', 'Hint: {h}', { h: hint })))
  process.exit(1)
}
