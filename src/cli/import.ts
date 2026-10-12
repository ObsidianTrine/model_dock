import { checkbox, input } from '@inquirer/prompts'
import { c, maskSecret, printTable, t } from '../util/index.js'
import { mutateConfig } from '../config/store.js'
import { applyImport, scanSources, type ImportScanOptions, type ImportSource } from '../import/sources.js'

const SOURCES: (ImportSource | 'all')[] = [
  'all',
  'cc-switch',
  'claude',
  'dsh',
  'zcode',
  'codex',
  'opencode',
  'mimocode',
  'workbuddy',
  'ccr',
  'crush',
  'gemini',
  'oneapi',
]

export async function cmdImport(opts: { from?: string; yes?: boolean; withProfiles?: boolean; url?: string; token?: string }): Promise<void> {
  const from = (opts.from ?? 'all') as ImportSource | 'all'
  if (!SOURCES.includes(from)) {
    console.error(c.red(t('✗ 未知来源 {f}（可选 {list}）', '✗ Unknown source {f} (choose {list})', { f: from, list: SOURCES.join('/') })))
    process.exit(1)
  }
  let scanOpts: ImportScanOptions = {}
  if (from === 'oneapi') {
    const url = opts.url?.trim() || (await input({ message: t('one-api / new-api 站点地址（如 https://api.example.com）', 'one-api / new-api site URL (e.g. https://api.example.com)') })).trim()
    const token =
      opts.token?.trim() ||
      (await input({
        message: t('系统访问令牌（one-api「个人设置 → 系统访问令牌」）', 'System access token (one-api "Personal settings → System access token")'),
      })).trim()
    if (!url || !token) {
      console.error(c.red(t('✗ 站点地址与系统访问令牌都不能为空', '✗ Both the site URL and the system access token are required')))
      process.exit(1)
    }
    scanOpts = { oneapi: { url, token } }
    console.log(c.gray(t('正在从 one-api / new-api 拉取渠道（只读，不会改动站点配置）…', 'Fetching channels from one-api / new-api (read-only; the site is not changed)…')))
  } else {
    console.log(c.gray(t('扫描现有 harness 配置（只读，不会改动原文件）…', 'Scanning existing harness configs (read-only; original files are not touched)…')))
  }
  let cands
  try {
    cands = await scanSources(from, scanOpts)
  } catch (e) {
    console.error(c.red(t('✗ {msg}', '✗ {msg}', { msg: (e as Error).message })))
    process.exit(1)
  }
  if (cands.length === 0) {
    console.log(c.yellow(t('未发现可导入的 provider 配置', 'No importable provider configs found')))
    return
  }
  printTable(
    cands.map((c2) => ({
      source: c2.source,
      id: c2.suggest_id,
      base_url: c2.base_url,
      key: c2.key ? maskSecret(c2.key) : t('(无)', '(none)'),
      note: c2.skip_reason ?? '',
    })),
    ['source', 'id', 'base_url', 'key', 'note']
  )
  console.log()

  const selectable = cands.filter((x) => !x.skip_reason)
  if (selectable.length === 0) {
    console.log(c.yellow(t('所有发现项均不可导入（见上表 note）', 'None of the found items can be imported (see the note column above)')))
    return
  }
  let chosen = selectable
  if (!opts.yes) {
    const ids = await checkbox({
      message: t('选择要导入的 provider（key 会存入 ModelDock，原文件不动）', 'Select providers to import (keys are stored in ModelDock; original files are untouched)'),
      choices: selectable.map((x) => ({
        name: `${x.suggest_id}  ${x.base_url}${x.key ? '' : t('  (无 key，导入后需 set-key)', '  (no key; run set-key after import)')}`,
        value: x.suggest_id,
        checked: true,
      })),
    })
    chosen = selectable.filter((x) => ids.includes(x.suggest_id))
  }
  if (chosen.length === 0) {
    console.log(c.gray(t('未选择任何项', 'Nothing selected')))
    return
  }

  const report = await mutateConfig((cfg) => applyImport(cfg, chosen, { withProfiles: opts.withProfiles ?? true }))
  for (const p of report.providers) console.log(c.green(t('✓ 导入 provider：{p}', '✓ Imported provider: {p}', { p })))
  for (const p of report.profiles) console.log(c.green(t('✓ 创建 profile：{p}', '✓ Created profile: {p}', { p })))
  for (const s of report.skipped) console.log(c.gray(t('○ 跳过 {id}：{r}', '○ Skipped {id}: {r}', { id: s.id, r: s.reason })))
  console.log(c.gray(t('下一步：modeldock profile use <name> 选默认路由；modeldock attach <harness> 接管客户端', 'Next: pick the default route with modeldock profile use <name>; attach clients with modeldock attach <harness>')))
}
