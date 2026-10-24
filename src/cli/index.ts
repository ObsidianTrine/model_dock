import { Command, Option } from 'commander'
import { VERSION } from '../version.js'
import { DEFAULT_GATEWAY_PORT } from '../config/types.js'
import { t } from '../util/i18n.js'

// 命令模块一律在 action 内动态 import（known-issues PERF-03）：静态 import 会把全部命令的模块图
// 拖进每次 CLI 启动——providers/adapters 链上的 789KB catalog snapshot 与 @inquirer 交互库，
// 连 --help / gateway stop 都要白付解析成本。选项注册保持同步，--help 与选项校验不受影响。
export function buildProgram(): Command {
  const prog = new Command()
  prog
    .name('modeldock')
    .description(t('本地模型配置托管中心 + API 网关：一份配置管住所有 AI harness', 'Local model config hub + API gateway: manage every AI harness with one config'))
    .version(VERSION)
    .addHelpText(
      'after',
      '\n' +
        t(
          '语言 / Language: modeldock --lang zh|en（任意位置可用；也可设环境变量 MODELRDOCK_LANG 或 config.toml language）',
          'Language: modeldock --lang zh|en (works anywhere; or set env MODELRDOCK_LANG, or config.toml language)'
        )
    )

  prog
    .command('init')
    .description(t('首启向导：检测 harness → 收编配置 → 预设添加 → 启动网关 → attach', 'First-run wizard: detect harnesses → import configs → add presets → start gateway → attach'))
    .option('--yes', t('全自动（导入全部发现项、默认选项）', 'Fully automatic (import everything found, default choices)'))
    .action(async (o) => (await import('./init.js')).cmdInit({ yes: o.yes }))

  prog
    .command('import')
    .description(t('只读收编存量配置（cc-switch / Claude Code / Codex / dsh / ZCode / OpenCode / MiMo / WorkBuddy / CCR / Crush / Gemini CLI；one-api / new-api 渠道用 --from oneapi）', 'Read-only import of existing configs (cc-switch / Claude Code / Codex / dsh / ZCode / OpenCode / MiMo / WorkBuddy / CCR / Crush / Gemini CLI; one-api / new-api channels via --from oneapi)'))
    .option('--from <source>', 'all | cc-switch | claude | dsh | zcode | codex | opencode | mimocode | workbuddy | ccr | crush | gemini | oneapi', 'all')
    .option('--url <url>', t('one-api / new-api 站点地址（--from oneapi 时用）', 'one-api / new-api site URL (with --from oneapi)'))
    .option('--token <token>', t('one-api / new-api 系统访问令牌（--from oneapi 时用）', 'one-api / new-api system access token (with --from oneapi)'))
    .option('--yes', t('跳过勾选，导入全部可导入项', 'Skip prompts, import everything importable'))
    .option('--no-with-profiles', t('不为导入项自动创建 profile', 'Do not auto-create profiles for imported items'))
    .action(async (o) => (await import('./import.js')).cmdImport(o))

  const provider = prog.command('provider').description(t('上游 provider 管理（url/key 集中保管）', 'Upstream provider management (central url/key storage)'))
  provider
    .command('add [presetId]')
    .description(t('添加 provider：不带参数进入交互（预设库模糊搜索，url 预填）', 'Add a provider: run without arguments for interactive mode (fuzzy preset search, url prefilled)'))
    .option('--name <name>')
    .option('--base-url <url>', t('跳过预设直接给 base_url', 'Skip presets and set base_url directly'))
    .option('--protocol <protocol>', 'anthropic | openai')
    .option('--auth <style>', 'bearer | x-api-key')
    .option('--key <key>', t('直接传 key（脚本用；"-" 从 stdin 读，避免进 shell history）', 'Pass key directly (for scripts; "-" reads stdin to keep it out of shell history)'))
    .option('--key-env <var>', t('从环境变量读 key', 'Read key from an environment variable'))
    .option('--no-fetch', t('添加后不自动拉取模型列表', 'Do not fetch the model list after adding'))
    .option('--yes', t('自动创建同名 profile 并设为默认路由', 'Auto-create a profile with the same name and set it as default route'))
    .action(async (presetId, o) => (await import('./providers.js')).cmdProviderAdd(presetId, o))
  provider.command('list').description(t('列出 providers（key 脱敏）', 'List providers (keys masked)')).action(async () => (await import('./providers.js')).cmdProviderList())
  provider
    .command('rm <id>')
    .description(t('删除 provider（连带 key 与引用它的 profile）', 'Delete a provider (along with its key and profiles referencing it)'))
    .action(async (id) => (await import('./providers.js')).cmdProviderRm(id))
  provider
    .command('set-key <id>')
    .description(t('更新 key（热生效）', 'Update key (takes effect immediately)'))
    .option('--key <key>')
    .option('--key-env <var>')
    .action(async (id, o) => (await import('./providers.js')).cmdProviderSetKey(id, o))

  const model = prog.command('model').description(t('模型目录（自动拉取 + 手动编辑上下文/输出上限）', 'Model catalog (auto-fetched + manual context/output limit editing)'))
  model.command('list [providerId]').description(t('查看模型目录', 'Show the model catalog')).action(async (id) => (await import('./providers.js')).cmdModelList(id))
  model
    .command('refresh <providerId>')
    .description(t('自动拉取上游 /v1/models 列表入库', 'Fetch the upstream /v1/models list into the catalog'))
    .action(async (id) => (await import('./providers.js')).cmdModelRefresh(id))
  model
    .command('set <providerId> <model>')
    .description(t('编辑模型元数据（默认填好，支持修改）', 'Edit model metadata (prefilled, editable)'))
    .option('--ctx <n>', t('输入上下文 tokens', 'Input context tokens'), Number)
    .option('--max-out <n>', t('最大输出 tokens', 'Max output tokens'), Number)
    .option('--display <name>', t('显示名', 'Display name'))
    .option('--cap <list>', t('能力，逗号分隔（tools,vision,reasoning）', 'Capabilities, comma-separated (tools,vision,reasoning)'))
    .action(async (pid, m, o) => (await import('./providers.js')).cmdModelSet(pid, m, o))
  const catalog = model.command('catalog').description(t('模型元数据目录（models.dev 社区数据，补未知模型的上下文/输出）', 'Model metadata catalog (models.dev community data; fills context/output for unknown models)'))
  catalog
    .command('refresh')
    .description(t('立即拉取目录到本地缓存（网关每 7 天自动刷新）', 'Fetch the catalog into the local cache now (the gateway auto-refreshes every 7 days)'))
    .action(async () => (await import('./providers.js')).cmdModelCatalogRefresh())

  const profile = prog.command('profile').description(t('路由 profile：用谁 + 用哪个模型 + 模型别名', 'Routing profile: which provider + which model + model aliases'))
  profile
    .command('add [name]')
    .description(t('创建 profile（交互选择 provider/模型）', 'Create a profile (pick provider/model interactively)'))
    .option('--provider <id>')
    .option('--model <model>', t('默认模型', 'Default model'))
    .option('--aliases <spec>', 'claude-sonnet-*=m1,claude-opus-*=m2')
    .action(async (name, o) => (await import('./profiles.js')).cmdProfileAdd(name, o))
  profile.command('use <name>').description(t('切换默认路由（网关模式即时生效）', 'Switch the default route (takes effect immediately in gateway mode)')).action(async (n) => (await import('./profiles.js')).cmdProfileUse(n))
  profile.command('list').description(t('列出 profiles', 'List profiles')).action(async () => (await import('./profiles.js')).cmdProfileList())
  profile.command('rm <name>').description(t('删除 profile', 'Delete a profile')).action(async (n) => (await import('./profiles.js')).cmdProfileRm(n))

  prog
    .command('attach <harness>')
    .description(t('接管 harness（diff 预览 + 自动快照）', 'Take over a harness (diff preview + automatic snapshot)'))
    // --mode 用 choices 约束，非法值在解析期报错而不是透传给 adapter
    .addOption(new Option('--mode <mode>', 'gateway | file').choices(['gateway', 'file']).default('gateway'))
    .option('--profile <name>', t('固定走某 profile（默认跟随 active_profile）', 'Pin to a profile (defaults to following active_profile)'))
    .option('--client-profile <names>', t('限定写入的客户端自身 profile（dsh 专用，逗号分隔，如 desktop / desktop,web；默认全部）', 'Limit which client-own profiles get written (dsh only, comma-separated, e.g. desktop / desktop,web; default all)'))
    .option('--set-default', t('同时切换该 harness 的默认 provider/model（codex/dsh）', 'Also switch the harness default provider/model (codex/dsh)'))
    .option('--takeover-models', t('把 Claude Code 的 DEFAULT_*_MODEL 映射迁入 profile 并删除', 'Migrate Claude Code DEFAULT_*_MODEL mappings into the profile and remove them'))
    .option('--yes', t('跳过确认（diff 仍展示）', 'Skip confirmation (diff is still shown)'))
    .option('--port <n>', t('显式网关端口（多实例下跳过 8687 探测启发式，避免解析到别的实例）', 'Explicit gateway port (skips the 8687 probe heuristic so multi-instance setups never resolve to another instance)'))
    .action(async (id, o) => (await import('./harness.js')).cmdAttach(id, o))
  prog
    .command('detach <harness>')
    .description(t('分离并还原 attach 前的配置（快照）', 'Detach and restore pre-attach config (snapshot)'))
    .option('--yes', t('跳过确认', 'Skip confirmation'))
    .action(async (id, o) => (await import('./harness.js')).cmdDetach(id, o))
  prog
    .command('token <harness>')
    .description(t('显示某 harness 的本地网关 token（敏感；codex/generic 接入要用）', 'Show a harness local gateway token (sensitive; needed for codex/generic attach)'))
    .action(async (id) => (await import('./harness.js')).cmdToken(id))

  const harnessCmd = prog.command('harness').description(t('已接入客户端的运行期管理（改完立即生效，客户端配置零改动）', 'Runtime management of attached clients (changes take effect immediately, client configs untouched)'))
  harnessCmd
    .command('route <id> [profile]')
    .description(t('查看/设置客户端路由：钉到某 profile 后不受全局切换影响；default = 恢复跟随全局', 'Show/set client route: pinned profiles ignore global switching; default = follow global again'))
    .action(async (id, p) => (await import('./harness.js')).cmdHarnessRoute(id, p))
  harnessCmd
    .command('direct <id> [profile]')
    .description(t('切换为独立直连：客户端配置直接写上游 url+真实 Key，不经网关（网关挂掉仍可用，作救援通道）', 'Switch to direct connect: write upstream url+real key straight into the client, bypassing the gateway (works even if the gateway is down; rescue channel)'))
    .action(async (id, p) => (await import('./harness.js')).cmdHarnessMode(id, 'direct', p))
  harnessCmd
    .command('gateway <id>')
    .description(t('切回网关接入（独立直连的客户端重新纳入统一管理；不要求网关存活）', 'Switch back to gateway attach (direct-connected clients rejoin unified management; gateway need not be running)'))
    .action(async (id) => (await import('./harness.js')).cmdHarnessMode(id, 'gateway'))
  prog
    .command('restore <harness> [snapshotId]')
    .description(t('从快照还原（不带 id 或 --list 列出快照）', 'Restore from a snapshot (no id, or --list to show snapshots)'))
    .option('--list', t('列出快照', 'List snapshots'))
    .option('--yes', t('跳过确认', 'Skip confirmation'))
    .action(async (id, sid, o) => (await import('./harness.js')).cmdRestore(id, sid, o))

  const gw = prog.command('gateway').description(t('本地网关（127.0.0.1:{port}）', 'Local gateway (127.0.0.1:{port})', { port: DEFAULT_GATEWAY_PORT }))
  gw.command('start')
    .description(t('启动网关（前台；--daemon 后台）', 'Start the gateway (foreground; --daemon for background)'))
    .option('--port <n>', t('覆盖端口', 'Override port'))
    .option('--daemon', t('后台运行', 'Run in background'))
    .action(async (o) => (await import('./gatewaycmd.js')).cmdGatewayStart(o))
  gw.command('stop').description(t('停止网关', 'Stop the gateway')).action(async () => (await import('./gatewaycmd.js')).cmdGatewayStop())
  gw.command('rotate-token').description(t('轮换管理令牌（旧令牌/cookie 立即失效）', 'Rotate the admin token (old tokens/cookies expire immediately)')).action(async () => (await import('./gatewaycmd.js')).cmdGatewayRotateToken())
  gw.command('status').description(t('网关运行状态', 'Gateway running status')).action(async () => (await import('./gatewaycmd.js')).cmdGatewayStatus())
  gw.command('install').description(t('开机自启：登录自动拉起网关，崩溃自动重启', 'Start at login: gateway auto-starts on login and restarts on crash')).action(async () => (await import('./gatewaycmd.js')).cmdGatewayInstall())
  gw.command('uninstall').description(t('移除开机自启（不影响当前运行的网关）', 'Remove start-at-login (does not stop the running gateway)')).action(async () => (await import('./gatewaycmd.js')).cmdGatewayUninstall())
  gw.command('log')
    .description(t('查看网关请求日志', 'Show gateway request logs'))
    .option('-n, --lines <n>', t('条数', 'Number of lines'), '30')
    .option('-f, --follow', t('跟随', 'Follow'))
    .option('--harness <id>', t('过滤 harness', 'Filter by harness'))
    .action(async (o) => (await import('./gatewaycmd.js')).cmdGatewayLog({ n: o.lines, follow: o.follow, harness: o.harness }))

  prog
    .command('ui')
    .description(t('打开本地 Web 控制台（自动登录；网关需在运行）', 'Open the local web console (auto-login; gateway must be running)'))
    .action(async () => (await import('./gatewaycmd.js')).cmdUi())

  prog
    .command('test [profile]')
    .description(t('端到端连通性自测：经网关对上游发一次最小请求', 'End-to-end connectivity check: send a minimal request upstream through the gateway'))
    .option('-m, --model <model>', t('覆盖默认模型', 'Override the default model'))
    .option('-t, --timeout <s>', t('超时秒数', 'Timeout seconds'), '90')
    .action(async (p, o) => (await import('./diag.js')).cmdTest(p, o))

  prog
    .command('doctor')
    .description(t('整体体检：配置/网关/上游/各 harness 指向，附修复命令', 'Full health check: config/gateway/upstream/harness targets, with fix commands'))
    .option('--fix', t('执行修复：安全项自动，敏感项逐项确认', 'Apply fixes: safe ones automatically, sensitive ones with per-item confirmation'))
    .option('--yes', t('跳过修复确认（配合 --fix）', 'Skip fix confirmations (with --fix)'))
    .option('--json', t('机器可读 JSON 输出', 'Machine-readable JSON output'))
    .action(async (o) => (await import('./diag.js')).cmdDoctor({ fix: o.fix, yes: o.yes, json: o.json }))
  prog.command('status').description(t('一眼总览：网关/active profile/各 harness 接管状态', 'At-a-glance overview: gateway/active profile/harness attach status')).action(async () => (await import('./diag.js')).cmdStatus())
  prog.command('env').description(t('输出 shell 环境变量（任意 harness 兜底接入）', 'Print shell env vars (fallback attach for any harness)')).action(async () => (await import('./diag.js')).cmdEnv())

  const adapter = prog.command('adapter').description(t('harness adapter 体系', 'Harness adapter system'))
  adapter.command('list').description(t('内置/声明式 adapter 及检测状态', 'Built-in/declarative adapters and detection status')).action(async () => (await import('./basic.js')).cmdAdapterList())

  const cfgCmd = prog.command('config').description(t('配置管理', 'Config management'))
  cfgCmd
    .command('edit')
    .description(t('在 $EDITOR 中打开 config.toml，保存后校验', 'Open config.toml in $EDITOR and validate on save'))
    .action(async () => (await import('./basic.js')).cmdConfigEdit())
  cfgCmd
    .command('export')
    .description(
      t(
        '导出加密配置包（.msync）：服务/路由/自定义预设/定时规则（含 key 明文）整体 AES-256-GCM 封装，供跨机器手动迁移',
        'Export an encrypted package (.msync): providers/profiles/custom presets/schedule rules (key plaintext included) sealed with AES-256-GCM for manual cross-machine migration'
      )
    )
    .option('-o, --out <file>', t('输出文件路径（默认 modeldock-config-<日期>-<时间>.msync）', 'Output file path (default: modeldock-config-<date>-<time>.msync)'))
    .option('--stdin-pass', t('口令经 stdin 读入（脚本/CI 用，不进 argv）', 'Read the passphrase from stdin (for scripts/CI; keeps it out of argv)'))
    .action(async (o) => (await import('./sync.js')).cmdConfigExport(o))
  cfgCmd
    .command('import <file>')
    .description(
      t(
        '导入配置包：先显示「将被替换/不受影响」清单，确认后整体替换可同步态（客户端接入等机器态不动，改动前自动快照）',
        'Import a sync package: shows what will be replaced vs untouched, then replaces all syncable state on confirm (machine state like client attaches is kept; snapshot taken first)'
      )
    )
    .option('--stdin-pass', t('口令经 stdin 读入（脚本/CI 用，不进 argv）', 'Read the passphrase from stdin (for scripts/CI; keeps it out of argv)'))
    .option('--yes', t('跳过确认', 'Skip confirmation'))
    .action(async (file, o) => (await import('./sync.js')).cmdConfigImport(file, o))

  const syncCmd = prog.command('sync').description(t('多机配置同步（WebDAV 网盘 / 本地同步盘；改动自动双向收敛）', 'Multi-machine config sync (WebDAV drive / local sync folder; changes converge automatically)'))
  syncCmd
    .command('setup')
    .description(
      t(
        '配置多机同步：选目标（WebDAV/本地同步盘）+ 设同步口令；目标已有配置时本机自动收敛到最新',
        'Set up multi-machine sync: pick a target (WebDAV/local sync folder) + set a sync passphrase; if the target already holds a config, this machine converges to it'
      )
    )
    .option('--target <kind>', t('目标类型：webdav | localdir（缺省交互选择）', 'Target kind: webdav | localdir (interactive if omitted)'))
    .option('--url <url>', t('WebDAV 地址', 'WebDAV URL'))
    .option('--dir <dir>', t('目标子目录', 'Target subdirectory'))
    .option('--username <user>', t('WebDAV 用户名', 'WebDAV username'))
    .option('--password <pass>', t('WebDAV 密码 / 应用密码', 'WebDAV password / app password'))
    .option('--stdin-pass', t('同步口令经 stdin 读入（脚本用）', 'Read the sync passphrase from stdin (for scripts)'))
    .action(async (o) => (await import('./sync.js')).cmdSyncSetup(o))
  syncCmd.command('status').description(t('查看同步状态：目标/版本/最近推拉/错误与冲突', 'Show sync status: target/rev/last push & pull/errors and conflicts')).action(async () => (await import('./sync.js')).cmdSyncStatus())
  syncCmd.command('pause').description(t('暂停本机的自动同步（不影响其他机器）', 'Pause automatic sync on this machine (other machines unaffected)')).action(async () => (await import('./sync.js')).cmdSyncPause())
  syncCmd
    .command('enroll')
    .description(
      t(
        '入网云端控制面：配对码 + 同步口令；入网后自动与云端收敛，手机控制台可远程切换本机服务',
        'Enroll with the cloud control plane: pair code + sync passphrase; converges with the cloud and enables remote switching from the phone console'
      )
    )
    .option('--server <url>', t('云端服务器地址', 'Cloud server URL'))
    .option('--code <code>', t('一次性配对码（云端控制台生成）', 'One-time pair code (from the cloud console)'))
    .option('--name <name>', t('设备显示名（默认主机名）', 'Device display name (defaults to hostname)'))
    .option('--stdin-pass', t('同步口令经 stdin 读入（脚本用）', 'Read the sync passphrase from stdin (for scripts)'))
    .action(async (o) => (await import('./sync.js')).cmdSyncEnroll(o))
  syncCmd.command('resume').description(t('恢复本机的自动同步', 'Resume automatic sync on this machine')).action(async () => (await import('./sync.js')).cmdSyncResume())

  prog.command('presets').description(t('预设库', 'Preset library')).command('update').description(t('更新内置预设库（M2）', 'Update the built-in preset library (M2)')).action(async () => (await import('./basic.js')).cmdPresetsUpdate())
  prog.command('usage').description(t('用量统计（M2）', 'Usage statistics (M2)')).action(async () => (await import('./basic.js')).cmdUsage())

  prog
    .command('update')
    .description(t('检查并安装 ModelDock 新版本：下载 → SHA256 校验 → 替换 → 重启网关', 'Check and install a new ModelDock version: download → SHA256 verify → swap → restart gateway'))
    .option('--check', t('只检查不安装', 'Check only, do not install'))
    .option('--yes', t('跳过确认', 'Skip confirmation'))
    .option('--token <pat>', t('可选。保存 GitHub 访问令牌（fine-grained，Contents 只读）——仅私有仓库必需，公开仓库匿名即可更新；配置后匿名限流 60 次/时提到 5000 次/时', 'Optional. Save the GitHub access token (fine-grained, Contents read-only) — only needed for private repos; a public repo updates anonymously, and a token raises the rate limit from 60/h to 5000/h'))
    .option('--clean', t('清理上一版残留（.old）', 'Remove previous-version leftovers (.old)'))
    .action(async (o) => (await import('./update.js')).cmdUpdate({ check: o.check, yes: o.yes, token: o.token, clean: o.clean }))

  prog
    .command('reset')
    .description(t('重置配置：还原 harness → 停网关 → 清空配置（保留快照和日志）', 'Reset config: restore harnesses → stop gateway → clear config (snapshots and logs kept)'))
    .option('--yes', t('跳过确认（托盘「清理数据」联动用）', 'Skip confirmation (used by the tray "Clean data" action)'))
    .option('--deep', t('连同日志、同步状态与本机缓存一起清除（快照仍保留）', 'Also clear logs, sync state and local caches (snapshots are still kept)'))
    .action(async (o) => (await import('./basic.js')).cmdReset({ yes: o.yes, deep: o.deep }))
  prog.command('uninstall').description(t('卸载程序：停网关并移除自启/命令行入口（保留配置，重装自动接回）', 'Uninstall: stop gateway and remove autostart/CLI entries (config kept; reinstall picks it back up)'))
    .option('--purge', t('连同配置、密钥一起彻底清除，并还原所有客户端到接管前', 'Also wipe config and keys, and restore all clients to pre-attach state'))
    .option('--yes', t('跳过确认（Windows 安装器卸载联动用）', 'Skip confirmation (used by the Windows installer uninstall flow)'))
    .action(async (o) => (await import('./basic.js')).cmdUninstall({ yes: o.yes, purge: o.purge }))

  return prog
}
