import { checkbox, confirm, search } from '@inquirer/prompts'
import { c, t } from '../util/index.js'
import { loadConfig, mutateConfig } from '../config/store.js'
import { allAdapters } from '../adapters/registry.js'
import { applyImport, scanSources } from '../import/sources.js'
import { gatewayLive } from './shared.js'
import { cmdProviderAdd } from './providers.js'
import { cmdAttach } from './harness.js'
import { cmdGatewayStart } from './gatewaycmd.js'

export async function cmdInit(opts: { yes?: boolean }): Promise<void> {
  console.log(c.bold(t('ModelDock 首启向导', 'ModelDock first-run wizard')))
  console.log(c.gray(t('全程可逆：所有文件改动都有快照，modeldock detach / restore 可还原', 'Fully reversible: every file change is backed up; restore with modeldock detach / restore')))
  console.log()

  let cfg = await loadConfig()
  if (Object.keys(cfg.providers).length > 0 && !opts.yes) {
    const goOn = await confirm({ message: t('检测到已有 provider 配置，继续 init？', 'Existing provider configs detected. Continue with init?') })
    if (!goOn) return
  }

  console.log(c.bold(t('① 检测本机 harness', '① Detect local harnesses')))
  const harnessAdapters = allAdapters(cfg).filter((a) => a.id !== 'generic-env')
  // 并行探测保序输出（diag.ts 同款）：Windows 桌面客户端逐个串行注册表探测最坏 8s/个，
  // 首屏会拖到数十秒
  const dets = await Promise.all(harnessAdapters.map((a) => a.detect()))
  harnessAdapters.forEach((a, i) => {
    const det = dets[i]
    console.log(
      det.installed
        ? `  ${c.green('✓')} ${a.label}${det.current ? c.gray(t('  当前 → {c}', '  current → {c}', { c: det.current })) : ''}`
        : `  ${c.gray('○')} ${a.label}${c.gray(t('（未安装，跳过）', ' (not installed, skipped)'))}`
    )
  })
  console.log()

  console.log(c.bold(t('② 收编现有 provider 配置（只读扫描，key 存入 ModelDock）', '② Collect existing provider configs (read-only scan; keys are stored in ModelDock)')))
  const cands = await scanSources('all')
  let chosen = cands.filter((x) => !x.skip_reason)
  if (cands.length > 0 && !opts.yes) {
    const selectable = chosen
    if (selectable.length > 0) {
      const ids = await checkbox({
        message: t('选择要导入的上游（原文件不会被改动）', 'Select upstreams to import (original files are not changed)'),
        choices: selectable.map((x) => ({
          name: `${x.suggest_id}  ${x.base_url}${x.key ? '' : t('  (无 key)', '  (no key)')}`,
          value: x.suggest_id,
          checked: true,
        })),
      })
      chosen = selectable.filter((x) => ids.includes(x.suggest_id))
    }
  } else if (opts.yes) {
    chosen = cands.filter((x) => !x.skip_reason)
  }
  for (const x of cands) {
    if (x.skip_reason) console.log(c.gray(t('  ○ {id}：{r}', '  ○ {id}: {r}', { id: x.suggest_id, r: x.skip_reason })))
  }
  if (chosen.length > 0) {
    const report = await mutateConfig((c2) => applyImport(c2, chosen, { withProfiles: true }))
    for (const p of report.providers) console.log(c.green(t('  ✓ 导入 {p}', '  ✓ Imported {p}', { p })))
  } else {
    console.log(c.gray(t('  （未导入任何现有配置）', '  (Nothing imported from existing configs)')))
  }
  console.log()

  cfg = await loadConfig()
  if (Object.keys(cfg.providers).length === 0) {
    console.log(c.bold(t('③ 从预设库添加 provider（url 已预填，只需粘贴 key）', '③ Add a provider from the preset library (URL prefilled; just paste the key)')))
    await cmdProviderAdd(undefined, { yes: opts.yes })
    console.log()
  }

  // 默认路由
  cfg = await loadConfig()
  if (!cfg.active_profile) {
    const names = Object.keys(cfg.profiles)
    if (names.length > 0) {
      let pick = names[0]
      if (!opts.yes && names.length > 1) {
        pick = await search({
          message: t('选择默认路由 profile', 'Pick the default route profile'),
          source: (term) =>
            Promise.resolve(names.filter((n) => !term || n.includes(term.toLowerCase())).map((n) => ({ name: n, value: n }))),
        })
      }
      await mutateConfig((c2) => {
        c2.active_profile = pick
      })
      console.log(c.green(t('✓ 默认路由：{p}', '✓ Default route: {p}', { p: pick })))
    }
  }
  console.log()

  console.log(c.bold(t('④ 启动网关（127.0.0.1）', '④ Start the gateway (127.0.0.1)')))
  const live = await gatewayLive()
  if (live) {
    console.log(c.gray(t('  已在运行：http://127.0.0.1:{port}', '  Already running: http://127.0.0.1:{port}', { port: live.port })))
  } else {
    if (opts.yes || (await confirm({ message: t('后台启动网关（--daemon）？', 'Start the gateway in the background (--daemon)?') }))) {
      await cmdGatewayStart({ daemon: true })
    } else {
      console.log(c.gray(t('  跳过（之后可 modeldock gateway start --daemon）', '  Skipped (run modeldock gateway start --daemon later)')))
    }
  }
  console.log()

  console.log(c.bold(t('⑤ 接管 harness（写入前展示 diff，自动快照）', '⑤ Attach harnesses (shows a diff before writing; automatic backups)')))
  cfg = await loadConfig()
  // 并行探测（与第①步同理由）：安装前逐个串行 detect 在 Windows 上可拖数十秒
  const attachAdapters = allAdapters(cfg).filter((a) => a.id !== 'generic-env')
  const dets2 = await Promise.all(attachAdapters.map((a) => a.detect()))
  const installed: string[] = attachAdapters.filter((a, i) => dets2[i].installed).map((a) => a.id)
  let toAttach: string[] = installed
  if (!opts.yes && installed.length > 0) {
    const ids = await checkbox({
      message: t('选择要接入网关的 harness', 'Select harnesses to attach to the gateway'),
      choices: installed.map((id) => ({ name: id, value: id, checked: id === 'claude-code' })),
    })
    toAttach = ids
  }
  for (const id of toAttach) {
    try {
      await cmdAttach(id, { yes: opts.yes })
    } catch (e) {
      console.error(c.yellow(t('  attach {id} 失败：{m}', '  attach {id} failed: {m}', { id, m: (e as Error).message })))
    }
  }
  console.log()

  console.log(c.bold(t('⑥ 完成', '⑥ Done')))
  console.log(c.gray(t('验证连通性：modeldock test', 'Check connectivity: modeldock test')))
  console.log(c.gray(t('整体体检：modeldock doctor', 'Full health check: modeldock doctor')))
  console.log(c.gray(t('切换 provider：modeldock profile use <name>（即时生效，无需改 harness）', 'Switch providers: modeldock profile use <name> (takes effect instantly, no harness changes needed)')))
}
