import { c, printTable, t } from '../util/index.js'
import { findDuplicateNames, MCP_HARNESS_LABELS, scanMcpServers } from '../mcp/scan.js'

/** modeldock mcp list：聚合盘点各客户端本机 MCP 服务器配置（只读）。 */
export async function cmdMcpList(opts: { json?: boolean } = {}): Promise<void> {
  const { entries, errors } = await scanMcpServers()
  if (opts.json) {
    console.log(JSON.stringify({ servers: entries, errors }, null, 2))
    return
  }
  for (const e of errors) {
    console.log(c.yellow(t('! {src}：{msg}', '! {src}: {msg}', { src: e.source, msg: e.message })))
  }
  if (entries.length === 0) {
    console.log(t('未在本机发现任何 MCP 服务器配置。', 'No MCP server configs found on this machine.'))
    console.log(
      c.gray(
        t(
          '已扫描：~/.claude.json、~/.codex/config.toml、~/.zcode/cli/config.json（回退 ~/.agents/mcp.json）、~/.config/opencode/opencode.json',
          'Scanned: ~/.claude.json, ~/.codex/config.toml, ~/.zcode/cli/config.json (fallback ~/.agents/mcp.json), ~/.config/opencode/opencode.json'
        )
      )
    )
    return
  }
  const scopeLabel = (e: (typeof entries)[number]): string =>
    e.scope === 'project' ? t('项目', 'project') + (e.project ? ` · ${e.project}` : '') : t('全局', 'user')
  printTable(
    entries.map((e) => ({
      name: e.name,
      client: MCP_HARNESS_LABELS[e.harness] ?? e.harness,
      type: e.transport,
      target: e.target,
      scope: scopeLabel(e),
    })),
    ['name', 'client', 'type', 'target', 'scope']
  )
  const dups = findDuplicateNames(entries)
  if (dups.length) {
    console.log(
      c.yellow(
        t(
          '! 同名服务器在多处重复配置：{list}——改命令或换 key 时容易漏一处',
          '! Same-named servers configured in more than one place: {list} — easy to miss one when changing a command or key',
          { list: dups.join(', ') }
        )
      )
    )
  }
  console.log(
    c.gray(
      t(
        '只盘点用户级配置；各仓库工作区配置（<repo>/.mcp.json、<repo>/.zcode/config.json）不在此列。环境变量只记名字，不收集值。',
        'User-level configs only; per-repo workspace configs (<repo>/.mcp.json, <repo>/.zcode/config.json) are not included. Env vars are listed by name only — values are never collected.'
      )
    )
  )
}
