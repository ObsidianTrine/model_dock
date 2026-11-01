#!/usr/bin/env node
// 生成 docs/config-reference.md 与 docs/en/config-reference.md：config.toml 全部可配键的权威参考（双语）。
// 键清单与类型从 src/config/types.ts 解析（唯一事实来源）；每键的语义/默认值/示例在本脚本 METAS 维护。
// 对拍纪律（同 gen-catalog-snapshot）：解析出的键与 METAS 必须一一对应，缺一条/多一条都拒绝生成——
// types.ts 新增键而没补说明时这里 loud fail，文档永不静默漂移。
// 用法：node scripts/gen-config-reference.mjs            # 重新生成两份文档
//       node scripts/gen-config-reference.mjs --check    # 只比对不落盘，漂移退出码 1（freshness 测试同源）
// 注意：typescript@7（tsgo）npm 包只有原生启动器、无 JS 编译器 API，故这里手写行解析
// （types.ts 为受控格式：interface 成员单行、JSDoc 规整）；解析失配会在对拍处暴露。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const TYPES_SRC = path.join(root, 'src', 'config', 'types.ts')
const I18N_SRC = path.join(root, 'src', 'util', 'i18n.ts')
const OUTS = {
  zh: path.join(root, 'docs', 'config-reference.md'),
  en: path.join(root, 'docs', 'en', 'config-reference.md'),
}

// ---------------------------------------------------------------- 解析 types.ts

const readSrc = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

/** 字面量联合类型别名（types.ts 的 export type X = 'a' | 'b' + i18n.ts 的 Lang） */
function parseAliases() {
  const types = readSrc(TYPES_SRC)
  const aliases = {}
  for (const m of types.matchAll(/^export type (\w+) = (.+?);?\s*$/gm)) aliases[m[1]] = m[2].trim()
  const i18n = readSrc(I18N_SRC)
  const lm = i18n.match(/^export type Lang = (.+?);?\s*$/m)
  if (!lm) throw new Error('无法从 src/util/i18n.ts 解析 Lang 类型（文档生成阻断）')
  aliases.Lang = lm[1].trim()
  return aliases
}

const cleanComment = (lines) =>
  lines
    .map((l) => l.replace(/^\s*\/\*\*/, '').replace(/\*\/\s*$/, '').replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean)
    .join(' ')

/** 解析全部 export interface：{ name, members: [{ name, opt, rawType, comment }] }（成员单行类型） */
function parseInterfaces(text) {
  const interfaces = {}
  let cur = null
  let comment = []
  let inComment = false
  for (const line of text.split('\n')) {
    const t = line.trim()
    const head = t.match(/^export interface (\w+) \{$/)
    if (head) {
      cur = { name: head[1], members: [] }
      comment = []
      inComment = false
      continue
    }
    if (!cur) continue
    if (t === '}') {
      interfaces[cur.name] = cur
      cur = null
      comment = []
      continue
    }
    if (inComment) {
      comment.push(line)
      if (t.endsWith('*/')) inComment = false
      continue
    }
    if (t.startsWith('/**')) {
      comment.push(line)
      if (!t.endsWith('*/')) inComment = true
      continue
    }
    if (t.startsWith('//') || t === '' || t.startsWith('export const') || t.startsWith('export function')) continue
    const mem = t.match(/^(\w+)(\?)?: (.+?)[,;]?$/)
    if (mem) {
      cur.members.push({ name: mem[1], opt: mem[2] === '?', rawType: mem[3].trim(), comment: cleanComment(comment) })
      comment = []
    }
  }
  return interfaces
}

/** 内联对象类型 `{ a?: X; b?: Y }` 拆成员（本文件内联类型无嵌套花括号） */
function splitInlineObject(raw) {
  const inner = raw.startsWith('{') && raw.endsWith('}') ? raw.slice(1, -1) : raw
  return inner
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^(\w+)(\?)?: (.+?)$/)
      if (!m) throw new Error(`无法解析内联类型成员：「${s}」（文档生成阻断）`)
      return { name: m[1], opt: m[2] === '?', rawType: m[3].trim(), comment: '' }
    })
}

// ---------------------------------------------------------------- 键树展开

/** map/array 键的占位 token（与 usage.md §7 示例的叫法一致） */
const TOKENS = { providers: '<id>', profiles: '<profile>', harness: '<client>', adapter_packs: '<pack>', models: '<model>' }

function classify(rawType, interfaces) {
  let m
  if ((m = rawType.match(/^Record<string,\s*(\w+)>$/)) && interfaces[m[1]]) return { kind: 'map', iface: m[1] }
  if ((m = rawType.match(/^(\w+)\[\]$/)) && interfaces[m[1]]) return { kind: 'array', iface: m[1] }
  if (interfaces[rawType]) return { kind: 'object', iface: rawType }
  if (rawType.startsWith('{') && rawType.endsWith('}')) return { kind: 'inline' }
  return { kind: 'leaf' }
}

function renderType(rawType, aliases) {
  return rawType.replace(/\b[A-Za-z_]\w*\b/g, (tok) => {
    const a = aliases[tok]
    return a && /^['"]/.test(a) ? a : tok
  })
}

function expand(members, prefix, interfaces, aliases, out) {
  for (const mem of members) {
    const p = prefix ? `${prefix}.${mem.name}` : mem.name
    const c = classify(mem.rawType, interfaces)
    if (c.kind === 'map') {
      const tok = TOKENS[mem.name] ?? '<id>'
      expand(interfaces[c.iface].members, `${p}.${tok}`, interfaces, aliases, out)
    } else if (c.kind === 'object') {
      expand(interfaces[c.iface].members, p, interfaces, aliases, out)
    } else if (c.kind === 'array') {
      expand(interfaces[c.iface].members, `${p}[]`, interfaces, aliases, out)
    } else if (c.kind === 'inline') {
      expand(splitInlineObject(mem.rawType), p, interfaces, aliases, out)
    } else {
      out.push({ path: p, required: !mem.opt, type: renderType(mem.rawType, aliases) })
    }
  }
}

/** 全量叶子键清单（含类型；对拍的事实来源） */
export function parseInventory() {
  const aliases = parseAliases()
  const interfaces = parseInterfaces(readSrc(TYPES_SRC))
  const configIface = interfaces.Config
  if (!configIface) throw new Error('src/config/types.ts 缺少 Config 接口（文档生成阻断）')
  const leaves = []
  expand(configIface.members, '', interfaces, aliases, leaves)
  const paths = leaves.map((l) => l.path)
  if (new Set(paths).size !== paths.length) throw new Error('解析出的键路径有重复：' + paths.join(', '))
  return { leaves, paths }
}

// ---------------------------------------------------------------- 每键元数据（语义/默认/示例——手工维护区）

// def: 默认值展示（双语同值写字符串；措辞不同用 [zh, en]）
// toml: 示例取值——纯值则渲染成 `键 = 值`；含 `=` 视为整行（点号路径如 endpoints.openai）原样使用
// managed: 程序维护（表格说明前置标记；示例中注释掉，noCommentExample = true 例外）
// typeOverride: 表格类型列覆盖
const M = (zh, en, def, toml, extra = {}) => ({ zh, en, def, toml, ...extra })

export const METAS = {
  // ---- 全局
  version: M('配置格式版本号，随程序升级自动迁移，请勿手改。', 'Config format version, migrated automatically as the program upgrades. Do not edit.', ['`1`（勿改）', '`1` (do not change)'], '1', { managed: true, noCommentExample: true }),
  language: M('界面语言：`zh` 中文、`en` 英文，作用于命令行输出、报错与网关日志消息。命令行 `--lang` 与环境变量 `MODELRDOCK_LANG` 可临时覆盖。', 'Interface language: `zh` Chinese, `en` English — applies to CLI output, errors and gateway log messages. The `--lang` flag and the `MODELRDOCK_LANG` env var override it temporarily.', ['`zh`', '`zh`'], '"zh"'),
  active_profile: M('当前生效的路由方案（`[profiles.*]` 里的一个 id），决定「跟随默认路由」的客户端实际走哪个服务。', 'The active profile (an id under `[profiles.*]`) — which service "follow default route" clients actually use.', ['无（未选定）', 'none (unset)'], '"ark-coding"'),

  // ---- providers.<id>
  'providers.<id>.name': M('服务显示名，缺省用 id；控制台与列表里展示。', 'Provider display name; defaults to the id.', ['同 id', 'same as id'], '"ACME"'),
  'providers.<id>.base_url': M('上游 API 基地址。', 'Upstream API base URL.', ['—', '—'], '"https://api.acme.com/v1"'),
  'providers.<id>.protocol': M('上游接口协议：`anthropic`（Anthropic 兼容）、`openai`（OpenAI 兼容对话接口）、`responses`（OpenAI Responses）。', 'Upstream protocol: `anthropic` (Anthropic-compatible), `openai` (OpenAI-compatible chat), `responses` (OpenAI Responses).', ['—', '—'], '"anthropic"'),
  'providers.<id>.auth_style': M('鉴权头风格：`bearer`（`Authorization: Bearer …`）或 `x-api-key`（`x-api-key: …`）。', 'Auth header style: `bearer` (`Authorization: Bearer …`) or `x-api-key` (`x-api-key: …`).', ['—', '—'], '"bearer"'),
  'providers.<id>.key_ref': M('上游 API Key 的引用：`file:<id>`（本地密钥文件）、`keychain:<id>`（系统钥匙环）、`env:<VAR>`（环境变量）；也可直接写明文，但强烈不建议。', 'Reference to the upstream API key: `file:<id>` (local secret file), `keychain:<id>` (OS keychain), `env:<VAR>` (environment variable); plaintext works but is strongly discouraged.', ['—', '—'], '"file:acme"'),
  'providers.<id>.proxy': M('出站代理：`direct` 直连；`env` 跟随系统环境变量代理；或写 `http://host:port` 指定代理。', 'Outbound proxy: `direct` (no proxy), `env` (follow proxy environment variables), or an explicit `http://host:port`.', ['`direct`', '`direct`'], '"direct"'),
  'providers.<id>.enabled': M('设 `false` 手动下线该服务：不再探测，也不参与自动路由与故障切换。', 'Set `false` to take the service offline manually: no probing, excluded from auto routing and failover.', ['`true`', '`true`'], 'true'),
  'providers.<id>.priority': M('自动路由候选排序权重，数值大者优先；仅在「程序自动选主」开启时生效。', 'Sorting weight for auto-routing candidates; higher wins. Only effective when "program picks the primary" is on.', ['`0`', '`0`'], '10'),
  'providers.<id>.endpoints': M('按协议覆盖基地址：同一服务商同时提供 anthropic / openai / responses 多协议端点、供不同客户端直连时使用；未写的协议回落 `base_url`。', 'Per-protocol base URL overrides: for vendors serving anthropic / openai / responses at different addresses; protocols without an entry fall back to `base_url`.', ['无', 'none'], 'endpoints.openai = "https://api.acme.com/openai"', { typeOverride: '{ anthropic?, openai?, responses? }' }),

  // ---- providers.<id>.models.<model>
  'providers.<id>.models.<model>.display_name': M('模型显示名，缺省用模型 id。', 'Model display name; defaults to the model id.', ['同模型 id', 'same as model id'], '"Fast Model"'),
  'providers.<id>.models.<model>.context_window': M('输入上下文窗口（tokens），控制台展示用。', 'Input context window in tokens, shown in the console.', ['无', 'none'], '131072'),
  'providers.<id>.models.<model>.max_output': M('最大输出（tokens）。', 'Maximum output in tokens.', ['无', 'none'], '8192'),
  'providers.<id>.models.<model>.capabilities': M('模型能力标签，控制台展示用（如 `tools`、`reasoning`）。', 'Capability tags for display (e.g. `tools`, `reasoning`).', ['无', 'none'], '["tools", "reasoning"]'),
  'providers.<id>.models.<model>.source': M('模型来源标记：`preset` 内置预设、`fetched` 从上游目录拉取、`manual` 手动添加（由程序维护）。', 'Where the model entry came from: `preset` (built-in preset), `fetched` (pulled from the upstream catalog), `manual` (added by hand; maintained by the program).', ['—', '—'], '"preset"'),

  // ---- profiles.<profile>
  'profiles.<profile>.name': M('路由方案显示名，缺省用 id。', 'Profile display name; defaults to the id.', ['同 id', 'same as id'], '"Coding"'),
  'profiles.<profile>.provider': M('该路由指向的服务 id（`[providers.*]` 里的一个）。', 'The provider id (under `[providers.*]`) this profile routes to.', ['—', '—'], '"acme"'),
  'profiles.<profile>.default_model': M('请求模型名未命中别名重写时使用的上游模型；不写则用上游自己的默认。', 'Upstream model used when the requested model name matches no alias; if unset, the upstream default applies.', ['无（用上游默认）', 'none (upstream default)'], '"fast-model"'),
  'profiles.<profile>.aliases': M('请求模型名 → 上游模型名的映射，支持 `*` 通配（如 `"claude-sonnet-*"`）；命中后按映射改写。', 'Mapping from requested model names to upstream model names; `*` wildcards supported (e.g. `"claude-sonnet-*"`).', ['无（不改写模型名）', 'none (no rewriting)'], '{ "claude-sonnet-*" = "fast-model" }'),
  'profiles.<profile>.fallback': M('手动备用链：主服务不可达时依次尝试。条目为 `"<服务id>"`（透传原模型名）或 `"<服务id>:<模型id>"`（改写为该模型）。', 'Manual failover chain, tried in order when the primary is unreachable. Entries: `"<providerId>"` (pass the model through) or `"<providerId>:<modelId>"` (rewrite the model).', ['无（不启用手动备用链）', 'none (no manual chain)'], '["backup", "backup:slow-model"]'),

  // ---- harness.<client>
  'harness.<client>.mode': M('接入模式：`gateway` 流量走本地网关；`file` 接管配置文件但客户端自管路由；`direct` 独立直连上游（不经网关）。', 'Attach mode: `gateway` traffic goes through the local gateway; `file` the config file is managed but the client routes itself; `direct` connects straight to the upstream (no gateway).', ['—', '—'], '"gateway"'),
  'harness.<client>.route': M('路由指向：`default` 跟随 active_profile；写具体 profile id 则钉死到它；`direct` 模式下为直连目标 profile。', 'Route: `default` follows the active profile; a concrete profile id pins the client to it; in `direct` mode, the direct target profile.', ['`default`（跟随当前路由方案）', '`default` (follows the active profile)'], '"default"'),
  'harness.<client>.direct_base': M('`direct` 模式实际写入客户端的直连地址（接入时写入）。', 'The direct URL actually written into the client in `direct` mode (written at attach).', ['接入时写入', 'written at attach'], '"https://api.acme.com/v1"', { managed: true }),
  'harness.<client>.token': M('该客户端访问网关用的令牌（接入时写入或指定）。', 'The token this client uses to reach the gateway (written at attach, or chosen by you).', ['接入时写入', 'written at attach'], '"mdk_..."'),
  'harness.<client>.attached_at': M('最近接入时间。', 'When the client was last attached.', ['接入时写入', 'written at attach'], '"2026-01-01T00:00:00.000Z"', { managed: true }),
  'harness.<client>.files': M('已接管的客户端配置文件列表（断开时据此还原）。', 'Client config files under management (restored on detach).', ['接入时写入', 'written at attach'], '["~/.claude/settings.json"]', { managed: true }),
  'harness.<client>.client_profiles': M('接入时选定的客户端自身配置档（如 dsh 的 desktop / web）；模式切换时按此范围重写。', "Client's own profiles selected at attach (e.g. dsh's desktop / web); mode switches rewrite within this scope.", ['接入时写入', 'written at attach'], '["desktop"]', { managed: true }),
  'harness.<client>.gateway_base': M('接入时写入的网关地址；断开时据此精确还原，不误删你自己的其他本地代理配置。', 'The gateway URL written at attach; detach matches on it precisely so your other local proxy settings are not touched.', ['接入时写入', 'written at attach'], '"http://127.0.0.1:8687"', { managed: true }),
  'harness.<client>.limits.rpm': M('数据面限流：该客户端每分钟最大请求数，超过返回 429（防失控客户端打爆上游；计数在网关内存，重启清零）。', 'Data-plane rate limit: max requests per minute for this client; excess requests get 429 (protects upstreams from a runaway client; counted in gateway memory, reset on restart).', ['不限', 'unlimited'], '60'),
  'harness.<client>.limits.daily_tokens': M('日花费上限：该客户端当日 token 用量（输入含缓存 + 输出）达到即返回 429，次日自动重置。', 'Daily spend cap: once this client\'s token usage for the day (input incl. cache + output) reaches it, requests get 429 until the next day.', ['不限', 'unlimited'], '5000000'),

  // ---- adapter_packs.<pack>
  'adapter_packs.<pack>.format': M('客户端配置文件格式：`json` / `toml` / `yaml`。', 'Client config file format: `json` / `toml` / `yaml`.', ['—', '—'], '"json"'),
  'adapter_packs.<pack>.config_file': M('客户端配置文件路径（支持 `~`）。', 'Path of the client config file (`~` supported).', ['—', '—'], '"~/.config/opencode/opencode.json"'),
  'adapter_packs.<pack>.detect.file_exists': M('探测条件（可选）：该文件存在才视为客户端已安装。', 'Detection (optional): the client counts as installed only if this file exists.', ['无', 'none'], 'true'),
  'adapter_packs.<pack>.detect.key_path': M('探测条件（可选）：客户端配置里该 JSONPath 能取到值才视为已接入。', 'Detection (optional): the client counts as attached only if this JSONPath resolves in its config.', ['无', 'none'], '"$.modeldock"'),
  'adapter_packs.<pack>.upsert': M('写入条目：配置路径表达式 → 值模板。模板变量 `{token}` `{port}` `{base_url}` `{base_url_openai}`。', 'Entries to write: config path expression → value template. Template variables: `{token}` `{port}` `{base_url}` `{base_url_openai}`.', ['—', '—'], '{ "$.provider.modeldock.baseURL" = "{base_url}", "$.provider.modeldock.apiKey" = "{token}" }'),

  // ---- gateway
  'gateway.port': M('网关监听端口，仅监听本机（127.0.0.1）；被占用自动 +1，并以实际端口写入客户端。', 'Gateway listen port, localhost only (127.0.0.1); if taken, auto-increments and clients get the actual port.', ['`8687`', '`8687`'], '8687'),
  'gateway.idle_timeout_ms': M('上游数据之间的最长等待间隔（毫秒）：流式回答超过该间隔没有新数据则中断。想容忍更久的停顿（长思考、慢上游）就调大。', 'Max gap between upstream data (ms): a streaming answer that stalls longer than this is cut off. Raise it to tolerate long pauses (long thinking, slow upstreams).', ['`600000`（10 分钟）', '`600000` (10 minutes)'], '600000'),
  'gateway.retries': M('上游连接失败时的重试次数（仅连接类错误重试，已发出的请求不重复）。', 'Retries when connecting to the upstream fails (connection errors only; an already-sent request is not re-sent).', ['`1`', '`1`'], '1'),
  'gateway.headers_timeout_ms': M('等待上游响应头的时限（毫秒）：非流式长推理可能超过 60 秒才回头，报超时时调大。', 'How long to wait for upstream response headers (ms). Non-streaming long generations can exceed 60s — raise this if you hit header timeouts.', ['`60000`', '`60000`'], '60000'),
  'gateway.max_body_mb': M('网关缓冲请求体的上限（MB）：模型别名改写需要完整读入请求体，超限返回 413；要发大 PDF / 多附件时上调。', 'Request body buffering limit (MB): model alias rewriting needs the full body, oversize gets 413. Raise it for large PDFs / many attachments.', ['`16`', '`16`'], '16'),
  'gateway.log_retention_days': M('请求日志按天文件保留的天数：更早的日志文件在网关启动时与每日定时自动删除；`0` = 永不清理。', 'How many days of daily request-log files to keep: older files are deleted at gateway startup and by a daily sweep; `0` = keep everything.', ['`30`', '`30`'], '30'),
  'gateway.auto_failover': M('「程序自动选主」开关：开启后按时段 / 优先级 / 实测耗时自动挑选主服务；关闭（默认）= 主服务由人工钉定或默认路由决定。主服务不可达时切备用始终可用，不受此开关影响。', 'Whether the program picks the primary automatically (time windows / priority / measured latency). Off (default) = the primary is whatever you pinned or the default route. Failing over when the primary is down always stays available regardless of this switch.', ['`false`（关）', '`false` (off)'], 'false'),
  'gateway.auto_route_provider': M('人工钉定的主服务 id：设置后路由优先走它（优先于程序自动与定时时段）；留空 = 程序按时段 / 默认路由选主。与控制台「当前」下拉同款。', 'Manually pinned primary provider id: routing prefers it (over program automation and time windows); empty = the program picks by window / default route. Same as the "Current" dropdown in the console.', ['空（自动）', 'empty (automatic)'], '"acme"'),
  'gateway.failover_status_codes': M('响应已开始送达后，仍允许切换备用服务的上游状态码白名单（如 `[429, 503]`）；缺省空 = 已送达的响应原样返回、不切换。', 'Upstream status codes that still allow switching to a backup after the response has started (e.g. `[429, 503]`); empty by default = a delivered response is passed through as-is, no switch.', ['`[]`（不切换）', '`[]` (no switch)'], '[429, 503]'),
  'gateway.route_next': M('人工钉定的「下一个切换」：主服务不可达时优先切到它（排到备用链首位）；留空按优先级 / 实测耗时自动排序。', 'Manually pinned "next in line": when the primary is down, this one is tried first (ahead of the backup chain); empty = ordered automatically by priority / measured latency.', ['空（自动排序）', 'empty (automatic order)'], '"backup"'),
  'gateway.auto_fallback': M('「自动备用链」开关：手动备用链之外，自动把其他已启用服务补进切换候选（按定时窗口 / 优先级 / 实测耗时排序，模型名透传）；仅显式 `false` 关闭。', 'Automatic backup chain: beyond your manual chain, other enabled services are added as failover candidates automatically (ordered by window / priority / measured latency, models passed through); only an explicit `false` turns it off.', ['`true`（开）', '`true` (on)'], 'true'),

  // ---- gateway.schedule
  'gateway.schedule.enabled': M('定时切换总开关：配了时段缺省即生效；设 `false` 临时停用全部时段（配置保留）。', 'Master switch for scheduled switching: effective by default once windows exist; `false` pauses all windows (config kept).', ['`true`（配了时段即生效）', '`true` (active once windows exist)'], 'true'),
  'gateway.schedule.windows[].start': M('窗口开始，本地时间 `HH:mm`（含）。', 'Window start, local time `HH:mm` (inclusive).', ['—', '—'], '"09:00"'),
  'gateway.schedule.windows[].end': M('窗口结束，本地时间 `HH:mm`（不含）；小于 start 表示跨午夜，后半夜归属窗口起始日。', "Window end, local time `HH:mm` (exclusive); less than start means overnight — the small hours belong to the window's start day.", ['—', '—'], '"18:00"'),
  'gateway.schedule.windows[].target': M('窗口目标：`"<服务id>"`（透传模型）或 `"<服务id>:<模型id>"`（改写为该模型）。', 'Window target: `"<providerId>"` (pass the model through) or `"<providerId>:<modelId>"` (rewrite to that model).', ['—', '—'], '"acme"'),
  'gateway.schedule.windows[].days': M('生效星期（1=周一 … 7=周日）；缺省不限；与 `dayFilter` 同时配置时取交集。', 'Days of week the window applies (1=Mon … 7=Sun); all by default; combined with `dayFilter` by intersection.', ['全部星期', 'every day'], '[1, 2, 3, 4, 5]'),
  'gateway.schedule.windows[].dayFilter': M('按日历日类型生效：`workday` 工作日（周一至五与调休补班日，不含法定假日）、`weekend` 周末、`holiday` 法定假日；缺省每天。节假日数据来自 holiday-cn。', 'Apply by calendar day type: `workday` (Mon–Fri plus makeup workdays, excluding public holidays), `weekend`, `holiday`; every day by default. Holiday data from holiday-cn.', ['每天', 'every day'], '"workday"'),
  'gateway.schedule.windows[].mode': M('窗口模式：`prefer`（缺省）= 时段内优先走 target；`avoid` = 时段内避开 target 服务（其余服务照常按优先级顺延；仅到服务粒度，模型部分被忽略）。', 'Window mode: `prefer` (default) prefer the target during the window; `avoid` steer away from the target provider (others proceed by priority; provider granularity only, model part ignored).', ['`prefer`', '`prefer`'], '"prefer"'),

  // ---- lan
  'lan.enabled': M('手机简版控制台开关（默认关）：开启后局域网内的手机可以访问只读状态页并做切换；第二监听器，与主网关互不影响。', 'Phone console switch (off by default): devices on the LAN get a read-only status page with switching; a second listener, independent of the main gateway.', ['`false`（关）', '`false` (off)'], 'true'),
  'lan.port': M('手机控制台监听端口；被占用自动 +1。', 'Phone console listen port; auto-increments if taken.', ['`8787`', '`8787`'], '8787'),

  // ---- security
  'security.store': M('密钥存储后端：`file`（本地文件；Windows 为系统级加密）/ `keychain`（系统钥匙环）。缺省按平台自动选择（macOS 钥匙环、Windows 加密文件、Linux 系统钥匙环、不可用时回退本地文件）；存量明文密钥会在启动时自动迁移，一般无需手改。', 'Secret storage backend: `file` (local file; OS-encrypted on Windows) / `keychain` (OS keychain). Chosen per platform automatically (macOS keychain, Windows encrypted file, Linux secret service falling back to file); existing plaintext secrets migrate automatically at startup. Rarely needs editing.', ['按平台自动', 'automatic per platform'], '"file"'),

  // ---- backup
  'backup.keep': M('每次改动前的自动快照滚动保留份数（最小 1）：超出后最旧的自动清除。', 'How many automatic before-change snapshots to keep (minimum 1); the oldest are pruned beyond that.', ['`20`', '`20`'], '20'),

  // ---- update
  'update.repo': M('检查更新的源仓库（owner/name）；默认公开主仓库，改指私有仓库时需配 `token_ref`。', 'Repository to check updates from (owner/name); the public main repo by default — pair `token_ref` when pointing at a private one.', ['公开主仓库', 'the public main repo'], '"ObsidianTrine/model_dock"'),
  'update.api_base': M('更新源 API 基地址（默认 GitHub API）；自建更新源时覆盖。', 'API base of the update feed (GitHub API by default); override for a self-hosted feed.', ['GitHub API', 'GitHub API'], '"https://api.github.com"'),
  'update.token_ref': M('访问更新源令牌的密钥引用（可选）：私有仓库必需；公开仓库配了可把匿名限流提高到登录额度。令牌本体存密钥库，不进 config 明文。', 'Key reference for the update-feed token (optional): required for private repos; on public repos it raises the anonymous rate limit to the authenticated quota. The token itself lives in the secret store, never in plaintext here.', ['无（匿名访问）', 'none (anonymous)'], '"file:github_pat"'),
  'update.mirror': M('下载镜像前缀列表，按序尝试；`[]` = 关闭镜像只走官方直连；缺省用内置镜像链。校验文件始终走官方源，防镜像篡改。', 'Download mirror prefixes, tried in order; `[]` = mirrors off, official direct only; a built-in mirror chain by default. The checksum file always comes from the official source to guard against mirror tampering.', ['内置镜像链', 'built-in mirror chain'], '["https://gh-proxy.com/", "https://ghfast.top/"]'),

  // ---- import
  'import.dismissed': M('一键导入里「暂不导入」过的候选地址：不再重复弹卡提醒；「添加服务 → 勾选导入」的手动入口不受影响。', 'Import candidates you dismissed: they stop re-appearing; the manual "add service → import" path is unaffected.', ['无（程序维护）', 'none (program-managed)'], '["https://api.example.com"]', { managed: true }),

  // ---- sync_assets
  'sync_assets.dirs': M('文本资产同步白名单：这些目录（home 相对路径）里的文本文件随同步包跨机收敛——远端有则写入、相同则跳过、本机多出的绝不删除，改动前自动快照。~/.modeldock 与 node_modules 永不入包，二进制自动跳过（单文件 ≤512KB、总量 ≤4MB、≤200 个文件）。管理命令：modeldock sync assets add / list / rm。', 'Text-asset sync whitelist: text files inside these home-relative directories converge across machines via the sync package — written when missing, skipped when identical, extra local files never deleted; a snapshot is taken before changes. ~/.modeldock and node_modules are never packaged; binaries are skipped (≤512KB per file, ≤4MB total, ≤200 files). Manage with modeldock sync assets add / list / rm.', ['无（不随包同步文本资产）', 'none (no text assets synced)'], '["skills"]'),
}

// ---------------------------------------------------------------- 分节（与 types.ts 结构对应）

// cut: 表格里「键」列显示路径时截掉的分节前缀长度
const SECTIONS = [
  { id: 'root', title: ['全局', 'Global'], cut: () => 0, intro: ['作用于整个 ModelDock 的顶层键，直接写在 config.toml 根层级。', 'Top-level keys that apply to ModelDock as a whole, written at the root of config.toml.'], pick: (p) => !p.includes('.') },
  { id: 'providers', title: ['服务（providers）', 'Providers (providers)'], cut: () => 'providers.<id>.'.length, intro: ['每个上游模型服务一段，`<id>` 是你起的服务名（小写字母、数字、下划线）。模型元数据（`models`）见下一节。', 'One block per upstream provider; `<id>` is a name you choose (lowercase letters, digits, underscore). Model metadata (`models`) is covered in the next section.'], pick: (p) => p.startsWith('providers.<id>.') && !p.startsWith('providers.<id>.models.') },
  { id: 'models', title: ['模型元数据（models）', 'Model metadata (models)'], cut: () => 'providers.<id>.models.<model>.'.length, intro: ['每个模型一条，记录展示用元信息；模型实际可用性由上游决定，这里不影响请求。', 'One entry per model, holding display metadata; actual availability is decided upstream — nothing here affects requests.'], pick: (p) => p.startsWith('providers.<id>.models.<model>.') },
  { id: 'profiles', title: ['路由方案（profiles）', 'Profiles (profiles)'], cut: () => 'profiles.<profile>.'.length, intro: ['路由方案 = 走哪个服务 + 默认模型 + 别名映射。客户端的 route 指向一个 profile id，或 `default` 跟随 active_profile。', "A profile = which provider + default model + alias mapping. A client's route points at a profile id, or `default` follows active_profile."], pick: (p) => p.startsWith('profiles.<profile>.') },
  { id: 'harness', title: ['客户端接入（harness）', 'Harness attachment (harness)'], cut: () => 'harness.<client>.'.length, intro: ['每个被接管的客户端一段（`<client>` 为客户端标识，如 claude-code）。接入 / 断开一般用 `modeldock attach` / `detach` 完成，这里用于查看与微调（`mode` / `route` / `token`）。', 'One block per attached client (`<client>` is the client id, e.g. claude-code). Attach / detach is normally done with `modeldock attach` / `detach`; use this section to inspect and tweak (`mode` / `route` / `token`).'], pick: (p) => p.startsWith('harness.<client>.') },
  { id: 'adapter_packs', title: ['声明式接入包（adapter_packs）', 'Declarative adapter packs (adapter_packs)'], cut: () => 'adapter_packs.<pack>.'.length, intro: ['零代码接入新客户端：描述「写哪个文件、写哪些键」，之后 `modeldock attach <pack>` 即可接管。', 'Onboard a new client with zero code: describe which file gets which keys, then `modeldock attach <pack>` takes over.'], pick: (p) => p.startsWith('adapter_packs.<pack>.') },
  { id: 'gateway', title: ['网关（gateway）', 'Gateway (gateway)'], cut: () => 'gateway.'.length, intro: ['网关监听、超时、日志与故障切换行为。定时切换（schedule）单独见下一节。', 'Gateway listening, timeouts, logs and failover behavior. Scheduled switching (`schedule`) has its own section below.'], pick: (p) => p.startsWith('gateway.') && !p.startsWith('gateway.schedule') },
  { id: 'schedule', title: ['定时切换（gateway.schedule）', 'Scheduled switching (gateway.schedule)'], cut: () => 'gateway.schedule.'.length, intro: ['时段内优先（或避开）某个服务，按本地时钟在每次请求时实时判定；法定节假日由日历数据（holiday-cn）判定。`windows[]` 是时段列表，每个时段一条。', 'Prefer (or avoid) a provider during time windows, evaluated per request against the local clock; public holidays come from calendar data (holiday-cn). `windows[]` is the list of windows, one entry each.'], pick: (p) => p.startsWith('gateway.schedule.') },
  { id: 'lan', title: ['手机控制台（lan）', 'Phone console (lan)'], cut: () => 'lan.'.length, intro: ['局域网内的手机简版控制台：只读状态 + 快捷切换，与主网关互不影响。', 'The phone-sized console on your LAN: read-only status plus quick switching, independent of the main gateway.'], pick: (p) => p.startsWith('lan.') },
  { id: 'security', title: ['密钥存储（security）', 'Secret storage (security)'], cut: () => 'security.'.length, intro: ['API Key 等敏感信息的存放方式。', 'Where sensitive material such as API keys is stored.'], pick: (p) => p.startsWith('security.') },
  { id: 'backup', title: ['快照（backup）', 'Snapshots (backup)'], cut: () => 'backup.'.length, intro: ['每次改动配置或接入 / 断开客户端前，ModelDock 会自动留一份快照供还原。', 'Before every config change or attach / detach, ModelDock keeps an automatic snapshot for restoring.'], pick: (p) => p.startsWith('backup.') },
  { id: 'update', title: ['自动更新（update）', 'Auto-update (update)'], cut: () => 'update.'.length, intro: ['新版本检查与下载安装的来源。', 'Where new releases are checked, downloaded and installed from.'], pick: (p) => p.startsWith('update.') },
  { id: 'import', title: ['导入状态（import）', 'Import state (import)'], cut: () => 'import.'.length, intro: ['一键导入（存量配置收编）的记忆数据，由程序维护。', 'Bookkeeping for one-click import of existing configs; program-managed.'], pick: (p) => p.startsWith('import.') },
  { id: 'sync_assets', title: ['文本资产同步（sync_assets）', 'Text-asset sync (sync_assets)'], cut: () => 'sync_assets.'.length, intro: ['多机同步时随包收敛的白名单目录清单（每台机器自选，清单本身不随包同步）。', 'Whitelisted directories converged via multi-machine sync (chosen per machine; the list itself does not sync).'], pick: (p) => p.startsWith('sync_assets.') },
]

// ---------------------------------------------------------------- 文档渲染

const esc = (s) => s.replace(/\|/g, '\\|')

function metaOf(leaf) {
  const m = METAS[leaf.path]
  if (!m) throw new Error(`键 ${leaf.path} 缺少文档元数据：请在 scripts/gen-config-reference.mjs 的 METAS 补充 zh/en 说明、默认值与示例（文档生成阻断）`)
  return m
}

/** 对拍：解析出的键与 METAS 一一对应；分节必须各自命中 */
function checkPairs(inventory) {
  const parsed = new Set(inventory.paths)
  const declared = new Set(Object.keys(METAS))
  const missing = [...parsed].filter((p) => !declared.has(p))
  const extra = [...declared].filter((p) => !parsed.has(p))
  if (missing.length) throw new Error('types.ts 里有键缺文档元数据（在 METAS 补上再生成）：\n  ' + missing.join('\n  '))
  if (extra.length) throw new Error('METAS 里的键在 types.ts 已不存在（删掉再生成）：\n  ' + extra.join('\n  '))
  const picked = new Set()
  for (const sec of SECTIONS) {
    const own = inventory.leaves.filter((l) => sec.pick(l.path))
    if (own.length === 0) throw new Error(`分节 ${sec.id} 没有命中任何键（分节定义与解析结果失配）`)
    for (const l of own) picked.add(l.path)
  }
  if (picked.size !== inventory.leaves.length) {
    const unpicked = inventory.leaves.filter((l) => !picked.has(l.path)).map((l) => l.path)
    throw new Error('以下键没有被任何分节覆盖：\n  ' + unpicked.join('\n  '))
  }
}

/** 段内示例：按 TOML 表分组；程序维护键注释掉 */
function renderExample(section, leaves, lang) {
  const managedNote = lang === 'zh' ? '程序维护，无需手改' : 'program-managed; no need to edit'
  const groups = []
  for (const leaf of leaves) {
    const m = metaOf(leaf)
    const tableParts = leaf.path.split('.').slice(0, -1)
    const isArrayTable = tableParts.length > 0 && tableParts[tableParts.length - 1].endsWith('[]')
    const tableKey = tableParts.join('.')
    let g = groups.find((x) => x.key === tableKey)
    if (!g) {
      g = { key: tableKey, isArrayTable, lines: [] }
      groups.push(g)
    }
    const line = m.toml.startsWith(`${leaf.path.split('.').pop()}.`) ? m.toml : `${leaf.path.split('.').pop()} = ${m.toml}`
    g.lines.push(m.managed && !m.noCommentExample ? `# ${line}  # ${managedNote}` : line)
  }
  const out = []
  for (const g of groups) {
    if (g.key) out.push(g.isArrayTable ? `[[${g.key.replace(/\[\]$/, '')}]]` : `[${g.key}]`)
    out.push(...g.lines, '')
  }
  while (out.length && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

function renderSection(idx, section, leaves, lang) {
  const t = (zh, en) => (lang === 'zh' ? zh : en)
  const out = []
  out.push(`## ${idx}. ${section.title[lang === 'zh' ? 0 : 1]}`)
  out.push('', section.intro[lang === 'zh' ? 0 : 1], '')
  out.push(`| ${t('键', 'Key')} | ${t('类型', 'Type')} | ${t('必填', 'Required')} | ${t('默认值', 'Default')} | ${t('说明', 'Description')} |`)
  out.push('|---|---|---|---|---|')
  for (const leaf of leaves) {
    const m = metaOf(leaf)
    const type = m.typeOverride ?? leaf.type
    const def = Array.isArray(m.def) ? m.def[lang === 'zh' ? 0 : 1] : m.def
    const managedMark = m.managed ? (lang === 'zh' ? '程序维护。' : 'Program-managed. ') : ''
    const rel = leaf.path.slice(section.cut(leaf.path))
    out.push(`| \`${rel}\` | \`${esc(type)}\` | ${t(leaf.required ? '是' : '否', leaf.required ? 'yes' : 'no')} | ${def} | ${managedMark}${esc(m[lang])} |`)
  }
  out.push('', t('示例：', 'Example:'), '', '```toml', renderExample(section, leaves, lang), '```', '')
  return out.join('\n')
}

const HEAD = {
  zh: {
    h1: 'config.toml 配置参考',
    switch: ['**简体中文** ｜ [English](en/config-reference.md)', '<!-- i18n-slot：新增语言时在上一行末尾追加链接（如 ｜ [日本語](ja/config-reference.md)），约定见 .agents/conventions/docs-writing.md -->'],
    lead: '`~/.modeldock/config.toml` 是 ModelDock 的主配置文件：模型服务、路由方案、客户端接入与网关行为都在这里，可以直接手编。本页逐项列出全部配置键的**类型、默认值与说明**，并附可直接粘贴的示例；日常操作与命令见[使用指南](usage.md)。',
    genNote: '本页由脚本根据程序内置的配置定义自动生成，与代码同源更新；请勿直接编辑本页，发现描述与实际行为不符时以实际行为为准并反馈。',
    genComment: '<!-- 由 scripts/gen-config-reference.mjs 生成（键清单源：src/config/types.ts，勿手改）；重新生成：node scripts/gen-config-reference.mjs -->',
    tipsTitle: '读前须知',
    tips: [
      '**手编入口**：`modeldock config edit` 起编辑器并在保存时校验；网关运行中改动 config.toml 会自动热加载，无需重启。',
      '**手写注释与排版不会保留**：通过 Web 控制台或命令修改配置时，ModelDock 会重写整个 config.toml，你手写的注释与排版不会保留（配置项本身不丢失）；需要长期保留的备注建议放在别处。<!-- 已知取舍：mutateConfig 整包重序列化（known-issues CORRECT-03 相邻） -->',
      '**占位符**：键名里的 `<id>` `<model>` `<profile>` `<client>` `<pack>` 是你自己起的条目名；示例取值均为示意。',
      '**「程序维护」**：该键由 ModelDock 写入与管理，列出仅为完整；误改可由快照还原。',
    ],
  },
  en: {
    h1: 'config.toml Configuration Reference',
    switch: ['**English** ｜ [简体中文](../config-reference.md)', '<!-- i18n-slot: append new-language links on the line above; convention: .agents/conventions/docs-writing.md -->'],
    lead: '`~/.modeldock/config.toml` is the main ModelDock config: model providers, routing profiles, client attachments and gateway behavior all live here, and it is safe to hand-edit. This page lists every config key with its **type, default and meaning**, plus paste-ready examples; for daily usage and commands see the [usage guide](usage.md).',
    genNote: 'This page is generated from the config definitions built into the program and updates with the code; please do not edit it directly. If a description disagrees with actual behavior, trust the behavior and report it.',
    genComment: '<!-- Generated by scripts/gen-config-reference.mjs (key inventory from src/config/types.ts; do not hand-edit). Regenerate: node scripts/gen-config-reference.mjs -->',
    tipsTitle: 'Before you start',
    tips: [
      '**Hand-editing**: `modeldock config edit` opens an editor and validates on save; while the gateway is running, changes to config.toml hot-reload automatically — no restart needed.',
      '**Hand-written comments and formatting are not preserved**: when the Web console or a command saves the config, ModelDock rewrites the whole config.toml — your comments and layout are lost (the settings themselves are not). Keep long-lived notes elsewhere.<!-- known tradeoff: mutateConfig reserializes the whole file; adjacent to known-issues CORRECT-03 -->',
      '**Placeholders**: `<id>` `<model>` `<profile>` `<client>` `<pack>` in key names stand for entry names you choose; example values are illustrative.',
      '**"Program-managed"**: the key is written and managed by ModelDock and listed for completeness; snapshots can restore accidental changes.',
    ],
  },
}

export function generateDocs() {
  const inventory = parseInventory()
  checkPairs(inventory)
  const docs = {}
  for (const lang of ['zh', 'en']) {
    const h = HEAD[lang]
    const out = [`# ${h.h1}`, '', h.switch[0], h.switch[1], '', `> ${h.lead}`, '', h.genNote, h.genComment, '', '---', '', `## ${h.tipsTitle}`, '']
    for (const tip of h.tips) out.push(`- ${tip}`)
    out.push('')
    let idx = 1
    for (const section of SECTIONS) {
      const leaves = inventory.leaves.filter((l) => section.pick(l.path))
      out.push(renderSection(idx, section, leaves, lang))
      idx++
    }
    docs[lang] = out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n'
  }
  return docs
}

// ---------------------------------------------------------------- CLI

const isCheck = process.argv.includes('--check')
const docs = generateDocs()
const norm = (s) => s.replace(/\r\n/g, '\n')
let drifted = false
for (const lang of ['zh', 'en']) {
  const file = OUTS[lang]
  const cur = fs.existsSync(file) ? norm(fs.readFileSync(file, 'utf8')) : null
  if (cur !== docs[lang]) {
    drifted = true
    if (isCheck) console.error(`[drift] ${path.relative(root, file)} 与生成结果不一致 → 运行 node scripts/gen-config-reference.mjs`)
  }
}
if (isCheck) {
  if (drifted) process.exit(1)
  console.log('config reference 双语文档均为最新')
} else {
  fs.mkdirSync(path.dirname(OUTS.en), { recursive: true })
  fs.writeFileSync(OUTS.zh, docs.zh)
  fs.writeFileSync(OUTS.en, docs.en)
  console.log(`已生成：${path.relative(root, OUTS.zh)}、${path.relative(root, OUTS.en)}（${Object.keys(METAS).length} 个键 × 2 语言）`)
}
