import { confirm, input, search } from '@inquirer/prompts'
import { c, printTable, t } from '../util/index.js'
import { mutateConfig } from '../config/store.js'
import { refreshBakedModelClients } from '../ops.js'
import { loadCfg } from './shared.js'

function parseAliases(spec?: string): Record<string, string> | undefined {
  if (!spec) return undefined
  const out: Record<string, string> = {}
  for (const pair of spec.split(',')) {
    const [k, v] = pair.split('=').map((s) => s.trim())
    if (k && v) out[k] = v
    else console.error(c.yellow(t('提示: 忽略格式错误的别名条目「{e}」（应为 别名=模型名）', 'Hint: ignoring malformed alias entry "{e}" (expected alias=model)', { e: pair })))
  }
  return Object.keys(out).length ? out : undefined
}

async function pickModel(providerId: string, providerModels: string[]): Promise<string> {
  if (providerModels.length === 0) {
    return input({ message: t('该 provider 暂无模型目录，输入默认模型名', 'This provider has no model catalog yet. Type the default model name') })
  }
  return search({
    message: t('选择默认模型（可过滤）', 'Pick the default model (type to filter)'),
    source: (term) => {
      const t = (term ?? '').toLowerCase()
      return Promise.resolve(
        providerModels
          .filter((m) => !t || m.toLowerCase().includes(t))
          .map((m) => ({ name: m, value: m }))
      )
    },
  })
}

export async function cmdProfileAdd(
  nameArg: string | undefined,
  opts: { provider?: string; model?: string; aliases?: string; defaultModel?: string }
): Promise<void> {
  const cfg = await loadCfg()
  const providerIds = Object.keys(cfg.providers)
  if (providerIds.length === 0) {
    console.error(c.red(t('✗ 还没有 provider，先 modeldock provider add', '✗ No providers yet. Run modeldock provider add first')))
    process.exit(1)
  }

  let providerId = opts.provider
  if (!providerId) {
    providerId = await search({
      message: t('选择 provider', 'Pick a provider'),
      source: (term) =>
        Promise.resolve(
          providerIds
            .filter((p) => !term || p.includes(term.toLowerCase()))
            .map((p) => ({ name: `${p}${cfg.providers[p].name ? `  ${c.gray(cfg.providers[p].name!)}` : ''}`, value: p }))
        ),
    })
  }
  if (!cfg.providers[providerId]) {
    console.error(c.red(t('✗ provider「{id}」不存在', '✗ provider "{id}" does not exist', { id: providerId })))
    process.exit(1)
  }

  const modelList = Object.keys(cfg.providers[providerId].models ?? {})
  const defaultModel = opts.model ?? opts.defaultModel ?? (await pickModel(providerId, modelList))

  let name = nameArg
  if (!name) {
    name = await input({ message: t('profile 名称', 'Profile name'), default: providerId })
  }
  if (cfg.profiles[name]) {
    console.error(c.red(t('✗ profile「{n}」已存在', '✗ profile "{n}" already exists', { n: name })))
    process.exit(1)
  }

  const aliases = parseAliases(opts.aliases)
  await mutateConfig((c2) => {
    c2.profiles[name!] = { name, provider: providerId, default_model: defaultModel, aliases }
  })
  console.log(c.green(t('✓ profile「{n}」已创建：{p} / {m}{a}', '✓ profile "{n}" created: {p} / {m}{a}', { n: name, p: providerId, m: defaultModel, a: aliases ? t(' + {n} 条别名', ' + {n} aliases', { n: Object.keys(aliases).length }) : '' })))
  if (!cfg.active_profile) console.log(c.gray(t('设为默认路由：modeldock profile use {n}', 'Set it as the default route: modeldock profile use {n}', { n: name })))
}

export async function cmdProfileUse(name: string): Promise<void> {
  const cfg = await loadCfg()
  if (!cfg.profiles[name]) {
    console.error(c.red(t('✗ profile「{n}」不存在', '✗ profile "{n}" does not exist', { n: name })))
    console.error(c.gray(t('现有：{list}', 'Existing: {list}', { list: Object.keys(cfg.profiles).join(', ') || t('(无)', '(none)') })))
    process.exit(1)
  }
  await mutateConfig((c2) => {
    c2.active_profile = name
  })
  console.log(c.green(t('✓ 默认路由已切换为「{n}」', '✓ Default route switched to "{n}"', { n: name })))
  // dsh/workbuddy/zcode 的模型列表烙在客户端文件里，切全局后需重写才跟随
  const baked = await refreshBakedModelClients()
  for (const id of baked.refreshed) console.log(c.gray(t('· {id} 的模型列表已按新路由重写（重启该客户端生效）', '· {id}: model list rewritten for the new route (restart the client to apply)', { id })))
  for (const w of baked.warnings) console.warn(c.yellow(t('提示: {w}', 'Hint: {w}', { w })))
  console.log(c.gray(t('网关模式下立即生效（新请求即走新路由）；file 模式的 harness 需重新 attach。', 'Takes effect immediately in gateway mode (new requests use the new route); harnesses in file mode need to be attached again.')))
}

export async function cmdProfileList(): Promise<void> {
  const cfg = await loadCfg()
  const names = Object.keys(cfg.profiles)
  if (names.length === 0) {
    console.log(c.gray(t('暂无 profile；modeldock profile add 创建', 'No profiles yet. Create one: modeldock profile add')))
    return
  }
  const rows = names.map((n) => {
    const p = cfg.profiles[n]
    return {
      profile: n === cfg.active_profile ? `${n} *` : n,
      provider: p.provider,
      default_model: p.default_model ?? '',
      aliases: String(Object.keys(p.aliases ?? {}).length),
    }
  })
  printTable(rows, ['profile', 'provider', 'default_model', 'aliases'])
  console.log(c.gray(t('* = active profile（route=default 的 harness 跟随它）', '* = the active profile (harnesses with route=default follow it)')))
}

export async function cmdProfileRm(name: string): Promise<void> {
  const cfg = await loadCfg()
  if (!cfg.profiles[name]) {
    console.error(c.red(t('✗ profile「{n}」不存在', '✗ profile "{n}" does not exist', { n: name })))
    process.exit(1)
  }
  // 钉定保护：删掉会留下悬空 route（该客户端请求 503），先解除再删。
  // file 模式客户端自管路由、不沿网关转发，route 仅登记痕迹，不拦截；删除时一并复位。
  const pinnedBy = Object.entries(cfg.harness ?? {}).filter(([, he]) => he.route === name && he.mode !== 'file').map(([hid]) => hid)
  if (pinnedBy.length > 0) {
    console.error(c.red(t('✗ profile「{n}」仍被 {c} 个客户端钉定：{ids}', '✗ profile "{n}" is still pinned by {c} client(s): {ids}', { n: name, c: pinnedBy.length, ids: pinnedBy.join(', ') })))
    console.error(c.yellow(t('提示: 先解除钉定（modeldock harness route <id> default），再删除', 'Hint: unpin first (modeldock harness route <id> default), then delete')))
    process.exit(1)
  }
  if (cfg.active_profile === name) {
    const goOn = await confirm({ message: t('它是 active profile，删除后将没有默认路由，继续？', 'This is the active profile. Deleting it leaves no default route. Continue?') })
    if (!goOn) return
  }
  await mutateConfig((c2) => {
    delete c2.profiles[name]
    if (c2.active_profile === name) delete c2.active_profile
    for (const he of Object.values(c2.harness ?? {})) {
      if (he.mode === 'file' && he.route === name) he.route = 'default'
    }
  })
  console.log(c.green(t('✓ profile「{n}」已删除', '✓ profile "{n}" deleted', { n: name })))
}
