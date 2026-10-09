import { confirm } from '@inquirer/prompts'
import { c, t } from '../util/index.js'
import { getSecret, setSecret, defaultStore } from '../config/secrets.js'
import { mutateConfig, loadConfig } from '../config/store.js'
import { DEFAULT_UPDATE_REPO } from '../config/types.js'
import { checkUpdate, cleanUpdateRemnants, runUpdate } from '../update/run.js'

/** PAT 在 secrets 里的固定 id（key_ref 存 config.toml [update].token_ref） */
export const UPDATE_TOKEN_SECRET_ID = 'update-token'

/** modeldock update：检查 → 确认 → 下载校验 → 替换 → 重启（实施基准 docs/design-auto-update.md §5.6） */
export async function cmdUpdate(opts: { check?: boolean; yes?: boolean; token?: string; clean?: boolean }): Promise<void> {
  // --clean 纯本地清理，不需要令牌与网络
  if (opts.clean) {
    await cleanUpdateRemnants(process.execPath)
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

  if (!token) {
    const ref = cfg.update?.token_ref
    token = ref ? await getSecret(ref) : null
  }
  if (!token) {
    console.error(
      c.red(
        t(
          '尚未配置更新令牌。到 GitHub → Settings → Developer settings → Fine-grained tokens 生成（仅本仓库、Contents 只读），然后执行：modeldock update --token <令牌>',
          'No update token configured. Generate a fine-grained token (this repo only, Contents read-only) under GitHub → Settings → Developer settings, then run: modeldock update --token <token>'
        )
      )
    )
    process.exitCode = 1
    return
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
