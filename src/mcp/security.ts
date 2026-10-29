import type { Config } from '../config/types.js'
import { t } from '../util/i18n.js'
import { findDuplicateNames, MCP_HARNESS_LABELS, scanMcpServersDetailed } from './scan.js'

/**
 * Agent 配置安全体检（只读，modeldock doctor 的发现来源之一）：
 *  ① MCP stdio 命令行里的「下载即执行」模式（curl|sh / irm|iex 等）——供应链风险；
 *  ② MCP env 中疑似凭据的明文值——点名服务器与变量名，值本身绝不输出；
 *  ③ 同名 MCP 服务器在多处重复配置（换 key / 改命令易漏一处）；
 *  ④ 独立直连的客户端：上游 key 明文写在客户端配置文件（设计如此，提示泄漏面与轮换时机）。
 * 全部只读，不提供 --fix：这些都是用户的显式选择，体检只负责把泄漏面说清。
 */

export interface ClientSecurityFinding {
  /** 稳定 id（doctor --json 消费） */
  id: 'mcp.risky_command' | 'mcp.env_plaintext' | 'mcp.duplicate_name' | 'client.direct_plaintext_key'
  level: 'warn' | 'info'
  msg: string
  hint?: string
}

/** 「下载管道进执行器」判定：curl/wget/irm 等取回的内容直接进 shell/解释器执行（含 sh -c "curl … | bash"
 *  与 bash -c "$(curl …)" 两种包裹形态）。只认「取内容→执行」的组合，避免把 npx 拉包（MCP 的正常
 *  打开方式）与「下载到文件」（curl -o …）误报。 */
export function isRiskyCommand(target: string): boolean {
  const low = target.toLowerCase()
  if (!/\b(curl|wget|irm|iwr|invoke-restmethod|invoke-webrequest)\b/.test(low)) return false
  if (/\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/.test(low)) return true
  if (/\|\s*(eval|iex|invoke-expression|python[23]?|node|perl|ruby)\b/.test(low)) return true
  // bash -c "$(curl …)" / eval "$(irm …)"：命令替换里取远程内容
  if (/^\s*(ba|z|da|k)?sh\s+-c\b|^\s*eval\b|^\s*iex\b/.test(low) && /\$\(\s*(curl|wget|irm|iwr|invoke-restmethod|invoke-webrequest)\b/.test(low)) return true
  return false
}

/** 疑似凭据的 env 值（名称含 key/token/secret/password，或值的形态像令牌）。只返回布尔，值不外传。 */
export function looksLikeCredential(name: string, value: string): boolean {
  if (value.length < 16 || /\s/.test(value)) return false
  if (/(key|token|secret|password|passwd|pwd)$/i.test(name.trim())) return true
  if (/^(sk|rk|pk)-|^sk-ant-|^(ghp|gho|ghu|ghs)_|^AKIA|^AIza|^xox[bpars]-/i.test(value)) return true
  return value.length >= 24 && /[A-Za-z]/.test(value) && /[0-9]/.test(value)
}

const labelOf = (harness: string): string => MCP_HARNESS_LABELS[harness] ?? harness

export async function collectClientSecurityFindings(cfg: Config): Promise<ClientSecurityFinding[]> {
  const F: ClientSecurityFinding[] = []
  const { entries } = await scanMcpServersDetailed()

  // ① 下载即执行的 stdio 命令
  const risky = entries.filter((e) => e.transport === 'stdio' && isRiskyCommand(e.target))
  if (risky.length > 0) {
    F.push({
      id: 'mcp.risky_command',
      level: 'warn',
      msg: t(
        '{n} 个 MCP 服务器的启动命令是「下载内容管道进 shell/解释器」：{list}',
        '{n} MCP server(s) launch via "download piped into a shell/interpreter": {list}',
        { n: risky.length, list: risky.map((e) => `${e.name}（${labelOf(e.harness)}）`).join(', ') }
      ),
      hint: t(
        '这类命令每次启动都在执行远端内容，源头被篡改就会直接进本机执行；建议换用固定版本安装（npm i -g 后写 node 路径）或人工核对脚本来源',
        'These commands execute remote content at every launch — a tampered source runs on this machine directly. Prefer a pinned install (npm i -g, then a node path) or review the script source yourself'
      ),
    })
  }

  // ② env 中的疑似明文凭据（只点名服务器与变量名，值绝不输出）
  const credHits: string[] = []
  for (const e of entries) {
    const names = Object.keys(e.envValues ?? {}).filter((k) => looksLikeCredential(k, e.envValues![k]))
    if (names.length > 0) credHits.push(`${e.name} · ${names.join(', ')}`)
  }
  if (credHits.length > 0) {
    F.push({
      id: 'mcp.env_plaintext',
      level: 'warn',
      msg: t(
        '{n} 个 MCP 服务器的环境变量带明文凭据（{list}）',
        '{n} MCP server(s) carry plaintext credentials in env vars ({list})',
        { n: credHits.length, list: credHits.join('; ') }
      ),
      hint: t(
        '客户端配置文件明文保存这些值（各家 MCP 都如此，属已知形态）：注意别把配置文件截图/分享出去，泄露或换机时记得轮换',
        'Client config files store these in plaintext (true of every MCP client today): avoid sharing/screenshotting config files, and rotate after a leak or when migrating machines'
      ),
    })
  }

  // ③ 同名 MCP 服务器多处配置
  const dups = findDuplicateNames(entries)
  if (dups.length > 0) {
    F.push({
      id: 'mcp.duplicate_name',
      level: 'info',
      msg: t('同名 MCP 服务器在多处重复配置：{list}', 'Same-named MCP servers configured in more than one place: {list}', { list: dups.join(', ') }),
      hint: t(
        '同一服务器在多个客户端各配一份是正常用法；但换命令或换 key 时容易漏一处（modeldock mcp list 可对照各处现状）',
        'Configuring the same server in several clients is normal; just remember to update every copy when changing a command or key (compare with modeldock mcp list)'
      ),
    })
  }

  // ④ 独立直连的客户端：上游 key 明文写在其配置文件（direct 的本质，提示泄漏面即可）
  const directIds = Object.entries(cfg.harness)
    .filter(([, h]) => h.mode === 'direct')
    .map(([id]) => id)
  if (directIds.length > 0) {
    F.push({
      id: 'client.direct_plaintext_key',
      level: 'info',
      msg: t(
        '{n} 个客户端以独立直连运行：{list}——上游 key 明文写在其配置文件里',
        '{n} client(s) run in direct mode: {list} — the upstream key is stored in plaintext in their config files',
        { n: directIds.length, list: directIds.map((id) => labelOf(id)).join(', ') }
      ),
      hint: t(
        '独立直连是救援通道，设计上就把真实 key 写进客户端配置：泄露或淘汰旧机时，先在 ModelDock 里轮换该服务的 key（modeldock provider set-key）',
        'Direct mode is the rescue channel and by design writes the real key into the client config: after a leak or when retiring a machine, rotate the key first (modeldock provider set-key)'
      ),
    })
  }

  return F
}
