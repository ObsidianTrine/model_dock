import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { biJoin, commandOnPath, commandOnPathSandbox, homeDir, t } from '../util/index.js'
import { debugLog, debugOn } from '../gateway/state/debuglog.js'
import type { BiValue } from '../util/i18n.js'

export type AppPresent = boolean | 'unknown'

/**
 * 客户端「本体探测」：安装判定 = 配置文件 + 程序本体双信号。配置目录（~/.claude、~/.zcode、
 * %APPDATA% 下的应用数据等）不随卸载删除，只认配置文件会把「已卸载有残留」误报成已安装，
 * 还可能对残留文件执行一键接入改写（zcode 实测踩坑）。
 *
 * 测试钩子：`MODELRDOCK_FAKE_<ID 大写下划线>_PRESENT`（如 MODELRDOCK_FAKE_ZCODE_PRESENT /
 * MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT）置 '1'/'0' 可强制按已安装/未安装判定，
 * 让单测与宿主机真实安装状态解耦。
 */
export function fakePresence(id: string): AppPresent | null {
  const v = process.env[`MODELRDOCK_FAKE_${id.toUpperCase().replace(/-/g, '_')}_PRESENT`]
  if (v === '1') return true
  if (v === '0') return false
  return null
}

/** CLI 形态本体：命令在 PATH 上即在场。commandOnPath 纯文件探测（PATH 逐目录 + Windows
 *  %APPDATA%\npm 与 PATHEXT 后缀 + macOS/Linux Homebrew/nvm 等常见位置兜底扫描），不 spawn 子进程。
 *  opts.sandboxIsolated：可装进沙箱的 npm 类客户端传 true——FAKE_HOME 下只认沙箱内命中，
 *  宿主真机的同名命令不算数（沙箱是独立的「全新机器」）；桌面/脚本类客户端只有真机一份
 *  拷贝，必须保持并集（否则沙箱里永远无法接入）。 */
export function cliPresent(cmd: string, id: string, opts: { sandboxIsolated?: boolean } = {}): boolean {
  const forced = fakePresence(id)
  if (forced === true) return true
  if (forced === false) return false
  return opts.sandboxIsolated ? commandOnPathSandbox(cmd) : commandOnPath(cmd)
}

function execText(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs }, (err, stdout) => {
      // debug 探针（2026-11-07 事故补课）：探测失败此前完全静默，排障无线索。args 无敏感值
      //（--version / reg query 搜索词），err 只留尾部防刷屏
      if (debugOn()) {
        debugLog('spawn', 'exec', {
          cmd: args.length ? `${cmd} ${args.join(' ')}` : cmd,
          ms: Date.now() - t0,
          ok: !err,
          ...(err ? { err: String((err as Error).message ?? err).slice(0, 200) } : {}),
        })
      }
      resolve(err ? '' : String(stdout))
    })
  })
}

/** CLI 版本探测 memo（与 regMemo 同思路）：接入计划 / 路由切换重烙会反复调 planAttach，
 *  每次都 spawn `--version` 没必要；版本只有升级才会变，60s 记忆足够新鲜。
 *  FAKE_HOME（测试/沙箱）下绕过：沙箱内装/卸必须即时可见（与 dirMemo 同款豁免）。 */
const VER_TTL = 60_000
const verMemo = new Map<string, { at: number; ver: string | undefined }>()

/** CLI 客户端版本探测：spawn `<cmd> --version`，从输出抽第一个 x.y.z。Windows 全局命令是
 *  .cmd 包装，execFile 不认，需 shell: true（参数是固定字面量，无注入面）。探测失败 / 输出
 *  不可解析返回 undefined，调用方按「功能门控不满足」处理（宁可降级到兼容路径，不假装新版）。
 *
 *  2026-11-07 生产事故：Windows 下不得用 args 数组 + shell 组合（DEP0190）——该组合触发 Node
 *  向 stderr 写弃用警告，托盘拉起的 daemon 在 stdio 句柄损坏形态下这条写入即进程死亡点（接入
 *  计划全链路唯一 spawn，死亡零痕迹，见 crash.ts 与 shared.defuseStdioErrors）。改为无 args 的
 *  单串命令行：DEP0190 只拦 args+shell 组合，解析语义不变（仍经 shell 查 PATH/PATHEXT）。
 *
 * 测试钩子：`MODELRDOCK_FAKE_<ID 大写下划线>_VERSION` 显式指定版本（置空串模拟探测失败）；
 * 未显式指定但 fakePresence 置了在场时，默认视为现代版本（假在场 = 假一台装好新版的机器，
 * 存量测试不必逐个补版本桩）。 */
export async function cliVersion(cmd: string, id: string, timeoutMs = 5000): Promise<string | undefined> {
  const fake = process.env[`MODELRDOCK_FAKE_${id.toUpperCase().replace(/-/g, '_')}_VERSION`]
  if (fake !== undefined) return fake === '' ? undefined : fake
  if (fakePresence(id) === true) return FAKE_PRESENT_VERSION
  const useMemo = !process.env.MODELRDOCK_FAKE_HOME
  const memo = verMemo.get(cmd)
  if (useMemo && memo && Date.now() - memo.at < VER_TTL) return memo.ver
  const out = await new Promise<string>((resolve) => {
    const winShell = process.platform === 'win32'
    const t0 = Date.now()
    execFile(winShell ? `${cmd} --version` : cmd, winShell ? [] : ['--version'], { windowsHide: true, timeout: timeoutMs, shell: winShell }, (err, stdout) => {
      // debug 探针：版本门控降级（如 claude < 2.1.243 回退档位槽）排障常需要知道「探测到了什么」
      if (debugOn()) {
        debugLog('spawn', 'cli_version', {
          cmd: winShell ? `${cmd} --version` : cmd,
          ms: Date.now() - t0,
          ok: !err,
          ver: /(\d+\.\d+\.\d+)/.exec(String(stdout))?.[1] ?? null,
          ...(err ? { err: String((err as Error).message ?? err).slice(0, 200) } : {}),
        })
      }
      resolve(err ? '' : String(stdout))
    })
  })
  const ver = /(\d+\.\d+\.\d+)/.exec(out)?.[1]
  if (useMemo) verMemo.set(cmd, { at: Date.now(), ver })
  return ver
}

/** 假在场（MODELRDOCK_FAKE_*_PRESENT=1）时的默认版本：取支持的现代版号——只用于测试钩子链，
 *  生产探测走真实 --version */
export const FAKE_PRESENT_VERSION = '2.1.316'

/** Windows 卸载表三种视图：HKCU（per-user 安装，如 Xiaomi MiMo / WorkBuddy 实测登记处）、
 *  HKLM 64 位、HKLM WOW6432Node（32 位安装器） */
const REG_UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]

// overview 每 5 秒轮询会对每个桌面客户端调一次 status，reg /s 递归全树查询不能每次都跑：
// 按应用名做 60s 记忆。安装/卸载后最多延迟 1 分钟反映（「重新检测」同延迟，可接受）
const REG_TTL = 60_000
const regMemo = new Map<string, { at: number; hit: boolean }>()

/** 卸载表三视图并行查询的聚合：keys 各自 exec（超时由 exec 内部兜底），三条全程并发，
 *  任一输出含 appName 即判定在场（Promise.all 不省并发，无「命中短路」）。相比原串行实现，
 *  未命中时把三次最坏超时（各 8s）重叠为单次窗口。
 *  独立成注入 exec 的纯函数以便跨平台单测：CI 三平台都不起 Windows reg，真实调用由测试
 *  传入的 exec 桩替代。调用方 registryHas 以真实 execText 传参，等价于原先的串行命中判定。 */
export async function regQueryAny(
  exec: (cmd: string, args: string[], timeoutMs: number) => Promise<string>,
  keys: readonly string[],
  appName: string,
  timeoutMs: number
): Promise<boolean> {
  const outs = await Promise.all(
    keys.map((k) => exec('reg', ['query', k, '/s', '/f', appName, '/d'], timeoutMs))
  )
  return outs.some((o) => o.toLowerCase().includes(appName.toLowerCase()))
}

async function registryHas(appName: string): Promise<boolean> {
  const memo = regMemo.get(appName)
  if (memo && Date.now() - memo.at < REG_TTL) return memo.hit
  // /d 只搜数据值（DisplayName 等）；/s /f 全树递归且大小写不敏感，无匹配时 reg 退出码非 0、输出为空
  const hit = await regQueryAny(execText, REG_UNINSTALL_KEYS, appName, 8000)
  regMemo.set(appName, { at: Date.now(), hit })
  return hit
}

// 目录安装痕迹探测 memo（与 regMemo 同思路）：overview 每 5s 轮询会对每个桌面客户端重复
// readdir 同几个目录（/Applications、%LOCALAPPDATA%\Programs 等），目录内容只有装卸才会变。
// 「重新检测」与装卸后最多延迟 TTL 反映，与 regMemo 的既定取舍一致。FAKE_HOME（测试/沙箱）
// 下绕过：沙箱内装/卸状态必须对 detect/status 即时可见（与 fsx PATH memo 同款豁免）
const DIR_TTL = 60_000
const dirMemo = new Map<string, { at: number; hit: boolean }>()

/** 目录下任一子项名字含关键字（不区分大小写）即视为安装痕迹；目录不存在/不可读视为无 */
async function dirHasEntry(dir: string, keywords: string[]): Promise<boolean> {
  const useMemo = !process.env.MODELRDOCK_FAKE_HOME
  const key = dir + '\0' + keywords.join('\0')
  if (useMemo) {
    const memo = dirMemo.get(key)
    if (memo && Date.now() - memo.at < DIR_TTL) return memo.hit
  }
  let hit = false
  try {
    for (const e of await fsp.readdir(dir)) {
      const lc = e.toLowerCase()
      if (keywords.some((k) => lc.includes(k))) {
        hit = true
        break
      }
    }
  } catch {
    /* 目录不存在或不可读 */
  }
  if (useMemo) dirMemo.set(key, { at: Date.now(), hit })
  return hit
}

/**
 * 桌面应用本体探测（Electron/安装器类客户端，如 MiMo 桌面端、WorkBuddy、ZCode）：
 * - Windows：注册表卸载项（HKCU/HKLM/WOW6432Node）或常见安装目录（%LOCALAPPDATA%\Programs、
 *   Program Files 两档）里有应用目录。注册表是主判据——用户可自选安装盘（实测 D:\Programs\Xiaomi MiMo），
 *   固定目录扫描覆盖不到。
 * - macOS：/Applications 与 ~/Applications 下的 .app。
 * - 其他平台或探测自身出错：返回 'unknown'，调用方回退为按配置文件判定——宁可维持旧行为，
 *   也不把装好的客户端误报成未安装。
 */
export async function desktopPresent(appNames: string[], id: string): Promise<AppPresent> {
  const forced = fakePresence(id)
  if (forced !== null) return forced
  try {
    if (process.platform === 'win32') {
      const keywords = appNames.map((n) => n.toLowerCase())
      // 多 app 并行查注册表（registryHas 自带 60s memo，结果与逐个短路等价）；串行在慢盘机器上逐 app 累加
      const hits = await Promise.all(appNames.map((name) => registryHas(name)))
      if (hits.some(Boolean)) return true
      const bases = [
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : null,
        process.env['ProgramFiles'],
        process.env['ProgramFiles(x86)'],
      ]
      for (const base of bases) {
        if (base && (await dirHasEntry(base, keywords))) return true
      }
      return false
    }
    if (process.platform === 'darwin') {
      const keywords = appNames.map((n) => n.toLowerCase())
      for (const base of ['/Applications', path.join(homeDir(), 'Applications')]) {
        if (await dirHasEntry(base, keywords)) return true
      }
      return false
    }
  } catch {
    return 'unknown'
  }
  return 'unknown'
}

/** detect/status 通用语义：配置在而本体缺席 → 未安装（卸载残留），附可操作提示。
 *  六适配器（claude-code/codex/zcode/workbuddy/provider-json/mimo-desktop）统一走这里。 */
export function residueNote(configFiles: string[], what: BiValue): string {
  return t(
    '检测到 {what} 配置残留（{files}），但未找到程序本体——{what} 可能已卸载；若仍在使用，请重新安装并启动一次后点「重新检测」',
    'Found leftover {what} config ({files}) but the app itself is missing — {what} may have been uninstalled; if you still use it, reinstall, launch it once, then click Re-detect',
    { what, files: biJoin('、', ', ', configFiles) }
  )
}
