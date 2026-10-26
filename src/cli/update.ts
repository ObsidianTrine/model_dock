import { confirm } from '@inquirer/prompts'
import { c, t } from '../util/index.js'
import { getSecret, setSecret, defaultStore } from '../config/secrets.js'
import { mutateConfig, loadConfig } from '../config/store.js'
import { DEFAULT_UPDATE_REPO } from '../config/types.js'
import { checkUpdate, cleanUpdateRemnants, runUpdate } from '../update/run.js'
import { acquireUpdateLock } from '../update/lock.js'

/** PAT 在 secrets 里的固定 id（key_ref 存 config.toml [update].token_ref） */
export const UPDATE_TOKEN_SECRET_ID = 'update-token'

/** modeldock update：检查 → 确认 → 下载校验 → 替换 → 重启（实施基准 docs/design-auto-update.md §5.6）。
 *  公开仓库匿名即可更新；--token 可选——私有仓库兼容模式或提升匿名限流（60 次/时 → 5000 次/时） */
export async function cmdUpdate(opts: { check?: boolean; yes?: boolean; token?: string; clean?: boolean }): Promise<void> {
  // --clean 纯本地清理，不需要令牌与网络；但必须持更新锁——恰逢另一 update 在 rename dance
  // （旧 exe 已改名 .old、新 exe 未落位）或 mac 回滚窗口时，裸删 .old 会让失败回滚无从执行
  if (opts.clean) {
    const release = await acquireUpdateLock()
    try {
      await cleanUpdateRemnants(process.execPath)
    } finally {
      release()
    }
    return
  }

  const cfg = await loadConfig()

  // --token：先存令牌（secrets.json / keychain，config 只存引用），随后直接用
  let token: string | null = null
  if (opts.token) {
    const backend = cfg.security?.store ?? (await defaultStore())
    const ref = await setSecret(UPDATE_TOKEN_SECRET_ID, opts.token, backend)
    await mutateConfig((c2) => {
      c2.update = { ...c2.update, token_ref: ref }
    })
    token = opts.token
    console.log(c.green(t('✓ 更新令牌已保存', '✓ Update token saved')))
  }

  // 未显式给 --token 时读已存的；都没有就走匿名（公开仓库 releases 匿名可读）
  if (!token) {
    const ref = cfg.update?.token_ref
    token = ref ? await getSecret(ref) : null
  }

  const repo = cfg.update?.repo ?? DEFAULT_UPDATE_REPO
  const confirmFn = opts.yes ? async () => true : (message: string) => confirm({ message })

  try {
    if (opts.check) {
      await checkUpdate(repo, token)
      return
    }
    await runUpdate({ repo, token, yes: opts.yes === true, confirm: confirmFn })
  } catch (e) {
    console.error(c.red(`✗ ${(e as Error).message}`))
    process.exitCode = 1
  }
}
