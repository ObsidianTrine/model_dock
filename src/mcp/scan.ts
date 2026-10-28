import path from 'node:path'
import { homeDir, readTextIfExists, t } from '../util/index.js'
import { parse as tomlParse } from 'smol-toml'

/**
 * MCP 服务器盘点（phase 1，只读）：扫描本机各 AI 客户端的 MCP 配置，聚合成统一清单。
 * 覆盖（用户级配置；各仓库工作区配置不在扫描范围，见 usage 文案）：
 *   claude-code  ~/.claude.json 顶层 mcpServers（user）+ projects.<path>.mcpServers（project）
 *   codex        ~/.codex/config.toml 的 [mcp_servers.<name>]
 *   zcode        ~/.zcode/cli/config.json 的 mcp.servers；缺省时回退 ~/.agents/mcp.json 顶层 mcpServers
 *                （回退规则同 ZCode 官方文档：同 scope 下 .zcode 有 MCP 配置则 .agents/mcp.json 整体忽略）
 *   opencode     ~/.config/opencode/opencode.json 的 mcp 键
 * 安全边界：env / headers 一律只收集变量名，绝不收集值——盘点结果可能进控制台与日志。
 */

export type McpTransport = 'stdio' | 'http' | 'sse'

export interface McpServerEntry {
  /** 服务器名（客户端配置里的 key） */
  name: string
  /** 来源客户端（adapter id） */
  harness: string
  transport: McpTransport
  /** stdio = 完整命令行；http/sse = URL */
  target: string
  scope: 'user' | 'project'
  /** project scope：所属项目路径 */
  project?: string
  /** 引用的环境变量名（只记名字，值绝不收集） */
  envKeys: string[]
  /** 环境变量值——仅 scanMcpServersDetailed（本机安检）携带；盘点出口（scanMcpServers）一律剥离，
   *  盘点结果会进控制台与日志，值绝不出本机 */
  envValues?: Record<string, string>
  /** 配置来源文件（绝对路径） */
  sourceFile: string
}

export interface McpScanError {
  /** 来源标识（文件路径或「文件路径 · 服务器名」） */
  source: string
  message: string
}

export interface McpScanResult {
  entries: McpServerEntry[]
  errors: McpScanError[]
}

/** 客户端展示名（proper noun，不走 t()） */
export const MCP_HARNESS_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  zcode: 'ZCode',
  opencode: 'OpenCode',
}

interface ServerRaw {
  command?: unknown
  args?: unknown
  env?: unknown
  /** opencode 用 environment 承载环境变量 */
  environment?: unknown
  url?: unknown
  type?: unknown
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 命令行展示：command（字符串或数组）+ args 拼一行；路径分隔符无关（这是给用户看的命令行） */
function commandTarget(command: unknown, args: unknown): string | null {
  const cmd = typeof command === 'string' ? command : Array.isArray(command) ? command.filter((c) => typeof c === 'string').join(' ') : null
  if (!cmd) return null
  const rest = Array.isArray(args) ? args.filter((a) => typeof a === 'string' || typeof a === 'number') : []
  return [cmd, ...rest.map(String)].join(' ')
}

/** 归一化单条服务器配置；形态无法识别返回 null（调用方记录错误）。
 *  env 只留变量名；keepEnvValues 时额外带值（仅本机安检路径，见 McpServerEntry.envValues）。 */
function normalizeServer(
  name: string,
  raw: unknown,
  meta: { harness: string; sourceFile: string; scope: 'user' | 'project'; project?: string },
  keepEnvValues = false
): McpServerEntry | null {
  if (!isPlainObject(raw)) return null
  const s = raw as ServerRaw
  const envSrc = isPlainObject(s.env) ? s.env : isPlainObject(s.environment) ? s.environment : null
  const envKeys = envSrc ? Object.keys(envSrc) : []
  const base = {
    name,
    harness: meta.harness,
    envKeys,
    ...(keepEnvValues && envSrc
      ? { envValues: Object.fromEntries(Object.entries(envSrc).filter(([, v]) => typeof v === 'string')) as Record<string, string> }
      : {}),
    sourceFile: meta.sourceFile,
    scope: meta.scope,
    ...(meta.project ? { project: meta.project } : {}),
  }
  if (typeof s.url === 'string' && s.url) {
    return { ...base, transport: s.type === 'sse' ? 'sse' : 'http', target: s.url }
  }
  const target = commandTarget(s.command, s.args)
  if (target) return { ...base, transport: 'stdio', target }
  return null
}

function recordServers(
  map: unknown,
  meta: { harness: string; sourceFile: string; scope: 'user' | 'project'; project?: string },
  out: McpServerEntry[],
  errors: McpScanError[],
  keepEnvValues = false
): void {
  if (!isPlainObject(map)) return
  for (const [name, raw] of Object.entries(map)) {
    const entry = normalizeServer(name, raw, meta, keepEnvValues)
    if (entry) out.push(entry)
    else errors.push({ source: `${meta.sourceFile} · ${name}`, message: t('配置形态无法识别（既无 command 也无 url）', 'Unrecognized shape (neither command nor url)') })
  }
}

/** 解析一个 JSON 文件；缺失返回 undefined，损坏记错误返回 undefined */
async function readJson(file: string, errors: McpScanError[]): Promise<Record<string, unknown> | undefined> {
  const text = await readTextIfExists(file)
  if (text === null) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : undefined
  } catch (e) {
    errors.push({ source: file, message: t('JSON 解析失败：{m}', 'Failed to parse JSON: {m}', { m: (e as Error).message }) })
    return undefined
  }
}

async function scanClaudeCode(out: McpServerEntry[], errors: McpScanError[], keepEnvValues: boolean): Promise<void> {
  const file = path.join(homeDir(), '.claude.json')
  const root = await readJson(file, errors)
  if (!root) return
  // user scope：顶层 mcpServers（该文件同时存会话状态等私有数据，只取需要的键）
  recordServers(root.mcpServers, { harness: 'claude-code', sourceFile: file, scope: 'user' }, out, errors, keepEnvValues)
  // project scope：projects.<项目路径>.mcpServers
  if (isPlainObject(root.projects)) {
    for (const [proj, pc] of Object.entries(root.projects)) {
      if (!isPlainObject(pc)) continue
      recordServers((pc as Record<string, unknown>).mcpServers, { harness: 'claude-code', sourceFile: file, scope: 'project', project: proj }, out, errors, keepEnvValues)
    }
  }
}

async function scanCodex(out: McpServerEntry[], errors: McpScanError[], keepEnvValues: boolean): Promise<void> {
  const file = path.join(homeDir(), '.codex', 'config.toml')
  const text = await readTextIfExists(file)
  if (text === null) return
  let root: unknown
  try {
    root = tomlParse(text)
  } catch (e) {
    errors.push({ source: file, message: t('TOML 解析失败：{m}', 'Failed to parse TOML: {m}', { m: (e as Error).message }) })
    return
  }
  if (!isPlainObject(root)) return
  recordServers((root as Record<string, unknown>).mcp_servers, { harness: 'codex', sourceFile: file, scope: 'user' }, out, errors, keepEnvValues)
}

async function scanZcode(out: McpServerEntry[], errors: McpScanError[], keepEnvValues: boolean): Promise<void> {
  const zcFile = path.join(homeDir(), '.zcode', 'cli', 'config.json')
  const zc = await readJson(zcFile, errors)
  // 回退规则（ZCode 官方文档）：~/.zcode/cli/config.json 没有任何 MCP 服务器时才读 ~/.agents/mcp.json
  const mcpSection = zc && isPlainObject((zc as Record<string, unknown>).mcp) ? (zc as Record<string, unknown>).mcp : null
  const servers = mcpSection && isPlainObject((mcpSection as Record<string, unknown>).servers) ? (mcpSection as Record<string, unknown>).servers : null
  if (servers && Object.keys(servers).length > 0) {
    recordServers(servers, { harness: 'zcode', sourceFile: zcFile, scope: 'user' }, out, errors, keepEnvValues)
    return
  }
  const fbFile = path.join(homeDir(), '.agents', 'mcp.json')
  const fb = await readJson(fbFile, errors)
  if (!fb) return
  recordServers((fb as Record<string, unknown>).mcpServers, { harness: 'zcode', sourceFile: fbFile, scope: 'user' }, out, errors, keepEnvValues)
}

async function scanOpencode(out: McpServerEntry[], errors: McpScanError[], keepEnvValues: boolean): Promise<void> {
  const file = path.join(homeDir(), '.config', 'opencode', 'opencode.json')
  const root = await readJson(file, errors)
  if (!root) return
  recordServers((root as Record<string, unknown>).mcp, { harness: 'opencode', sourceFile: file, scope: 'user' }, out, errors, keepEnvValues)
}

/** 扫描全部来源；单个来源损坏不影响其余（错误随结果返回）。文件缺失 = 该客户端未配置，静默跳过。 */
export async function scanMcpServers(): Promise<McpScanResult> {
  const { entries, errors } = await scanMcpServersDetailed()
  // 盘点出口剥离 env 值：结果会进控制台与日志，值绝不出本机
  return { entries: entries.map(({ envValues: _v, ...rest }) => rest), errors }
}

/** 同 scanMcpServers，但条目携带 env 值（McpServerEntry.envValues）——仅供本机安检（mcp/security.ts），
 *  不得进任何输出/日志面 */
export async function scanMcpServersDetailed(): Promise<McpScanResult> {
  const entries: McpServerEntry[] = []
  const errors: McpScanError[] = []
  for (const scan of [scanClaudeCode, scanCodex, scanZcode, scanOpencode]) {
    try {
      await scan(entries, errors, true)
    } catch (e) {
      errors.push({ source: 'scan', message: (e as Error).message })
    }
  }
  return { entries, errors }
}

/** 同名服务器出现在多个客户端/项目（换 key 或改命令容易漏一处）；返回按名排序的重复名单 */
export function findDuplicateNames(entries: McpServerEntry[]): string[] {
  const seen = new Map<string, number>()
  for (const e of entries) seen.set(e.name, (seen.get(e.name) ?? 0) + 1)
  return [...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name).sort()
}
