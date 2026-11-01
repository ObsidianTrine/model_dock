/** 安装域：安装/卸载命令执行底座与端点（由 server.ts 拆出，T05，纯搬移零改写）。块序 = 原文件相对次序，未重排未删改。 */
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { AdminCtx, jsonRequestBody, sendError } from './admin-shared.js'
import { applyChanges } from '../adapters/engine.js'
import { allAdapters, requireAdapter } from '../adapters/registry.js'
import { isNpmGlobalInstall, resolveInstallCommand, type ClientInstall, type HarnessAdapter } from '../adapters/types.js'
import { engineWarningHint, ensureNodeRuntime, installChildEnv } from '../install/noderuntime.js'
import { clearCommandMemo, randomToken, readTextIfExists } from '../util/fsx.js'
import { DEFAULT_GATEWAY_PORT, type Config } from '../config/types.js'
import { sandboxNpmPrefix } from '../util/paths.js'
import { mutateGatewayState, reloadRuntime, type GatewayRuntime } from './state.js'
import { probePresent } from './install-internals.js'
import { bi, t } from '../util/i18n.js'
import { localIsoTs } from '../util/time.js'
/** 收集命令输出的上限（防止日志/响应被刷爆） */
export const INSTALL_OUTPUT_MAX = 4000

/** runShell 命令超时（安装/卸载挂死时端点曾永久挂起）；测试可注入短值 */
export const RUN_SHELL_TIMEOUT_MS = 10 * 60_000

export function runShell(cmd: string, onOut: (c: string) => void, env?: NodeJS.ProcessEnv, timeoutMs: number = RUN_SHELL_TIMEOUT_MS): Promise<number> {
  return new Promise((resolve) => {
    // timeout：安装/卸载命令（npm 全局安装，网络依赖）挂死时 hInstall/hUninstall 端点曾
    // 永久挂起、子进程留存（2026-11-02 复查 P2-4）。Node spawn 原生语义：超时发 killSignal
    // （win32 SIGTERM 即硬杀）并照常触发 close
    const child = spawn(cmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env, timeout: timeoutMs })
    // setEncoding：多字节中文跨 chunk 边界不再撕裂成替换符（engineWarningHint 的正则匹配与日志展示都依赖）
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d) => onOut(String(d)))
    child.stderr?.on('data', (d) => onOut(String(d)))
    child.on('error', (e) => {
      onOut(String(e.message))
      resolve(1)
    })
    child.on('close', (code) => resolve(code ?? 1))
  })
}

/** 子进程引导共步（安装/卸载的 env 构造 + Node 保障 + PATH 前置 + 执行）：installChildEnv 统一构造
 *  子进程 env，needsNode 时先 ensureNodeRuntime 并把托管 bin 前置 PATH，再 runShell 执行。
 *  返回未被截尾的原始输出数组与退出码；Node 保障失败时 exit 为 null、output 携带失败消息（调用方各自落失败态）。 */
export async function runInstallCommand(cmd: string, needsNode: boolean): Promise<{ exit: number | null; output: string[] }> {
  const output: string[] = []
  const env = installChildEnv(process.env)
  if (needsNode) {
    try {
      const nrt = await ensureNodeRuntime((l) => output.push(l + '\n'))
      env.PATH = nrt.binDir + path.delimiter + (env.PATH ?? '')
    } catch (e) {
      output.push((e as Error).message)
      return { exit: null, output }
    }
  }
  const exit = await runShell(cmd, (c) => output.push(c), env)
  return { exit, output }
}

/**
 * 客户端安装：有 install.command 则 shell 执行（npm 类 / 平台脚本类自动安装）→ 成功且声明 bootstrap
 * 则复用 applyChanges 补写空配置文件（自动快照 + 原子写，让 detect 生效、attach 可跑）；无 command
 * 的客户端（ZCode/WorkBuddy）不执行，仅返回指引。needsNode 的命令（npm 类）先 ensureNodeRuntime——
 * 本机无 Node 时下载托管运行时，其 bin 目录前置到子进程 PATH（系统 node 经 well-known 命中时同样
 * 前置：LaunchAgent 的 PATH 常缺 nvm 目录，不前置子进程找不到 npm）；子进程 env 经 installChildEnv
 * 统一构造（剥 npm_* 泄漏 + 注镜像 registry + 沙箱落点）。沙箱模式（MODELRDOCK_FAKE_HOME）只放行
 * 可重定向落点的 npm 全局安装——npm_config_prefix/cache 指进沙箱，不碰宿主全局 prefix；脚本类
 * 安装（curl|bash、irm|iex 等）落点无法重定向，拒绝并提示手动安装。声明 install.probe 的先探测：
 * 命令已在 PATH 就跳过安装——页面状态可能是旧的（用户在别处刚装好），而 npm 全局重装会先把现有
 * 安装目录与 shim 改名 retire 再重建，postinstall 一旦不成功就只剩报错桩，把本来可用的命令弄坏。
 */
export async function runClientInstall(
  adapter: HarnessAdapter,
  cfg: Config,
  port: number
): Promise<{ ok: boolean; auto: boolean; output: string; installed: boolean; skipped: boolean; blocked?: boolean }> {
  const inst = adapter.install
  const lines: string[] = []
  let skipped = false
  if (inst?.command) {
    if (inst.probe && probePresent(inst, inst.probe)) {
      skipped = true
      lines.push(t('已在 PATH 上检测到 {cmd} 命令，跳过安装步骤（不重跑 npm 全局安装）', 'Found {cmd} already on PATH, skipping install (npm global install not re-run)', { cmd: inst.probe }))
    } else {
      const cmd = resolveInstallCommand(inst.command)
      if (cmd === null) {
        // 类型上不可达（command 存在才有 cmd）；防御性兜底走指引分支
        lines.push(t('未配置可执行的安装命令', 'No executable install command configured'))
      } else if (sandboxNpmPrefix() && !isNpmGlobalInstall(cmd) && process.env.MODELRDOCK_INSTALL_ALLOW_ANY !== '1') {
        // MODELRDOCK_INSTALL_ALLOW_ANY=1 为单测桩命令（node -e 等）放行，受控环境专用
        lines.push(t(
          '沙箱环境不支持自动安装该客户端：其安装方式（{cmd}）会把程序写进真机，沙箱无法重定向其落点。请按页面安装指引手动安装（装好后点「重新检测」即可接入沙箱配置）',
          'Sandbox cannot auto-install this client: its install method ({cmd}) writes to the real machine and cannot be redirected. Install manually per the guide, then click Re-detect to attach the sandbox config',
          { cmd }
        ))
        return { ok: false, auto: true, output: tailText(lines), installed: false, skipped: false, blocked: true }
      } else {
        const { exit, output } = await runInstallCommand(cmd, !!inst.needsNode)
        if (exit === null) {
          // Node 保障失败：只报引导错误
          return { ok: false, auto: true, output: tailText(output), installed: false, skipped: false }
        }
        // npm 对 engines 不匹配默认只警告（EBADENGINE）不拦：钉死的托管 Node 过期后新客户端
        // 会「装成功、跑就崩」——把埋在日志里的警告提升为可操作提示，失败/成功路径都要可见
        const engineHint = inst.needsNode ? engineWarningHint(output.join('')) : null
        if (exit !== 0) {
          if (engineHint) output.push(engineHint)
          return { ok: false, auto: true, output: tailText(output), installed: false, skipped: false }
        }
        // 成功也带回子进程输出（npm 进度/下载占比），tailText 统一截尾
        const childOut = output.join('').trim()
        if (childOut) lines.push(childOut)
        if (engineHint) lines.push(engineHint)
        lines.push(t('已执行安装命令：{cmd}', 'Ran install command: {cmd}', { cmd }))
      }
    }
    if (inst.bootstrap && inst.bootstrap.path) {
      const bp = typeof inst.bootstrap.path === 'function' ? inst.bootstrap.path() : inst.bootstrap.path
      // bootstrap 语义是"补写空配置"，不是覆盖：文件已存在时原样保留（before:null 的写入会被引擎的乐观锁拦下）
      if ((await readTextIfExists(bp)) === null) {
        await applyChanges(adapter.id, 'install', [{ path: bp, before: null, after: inst.bootstrap.content }], { yes: true, quiet: true })
        lines.push(t('已写入空配置：{path}', 'Wrote empty config: {path}', { path: bp }))
      } else {
        lines.push(t('配置已存在，保留不动：{path}', 'Config already exists, left untouched: {path}', { path: bp }))
      }
    }
  }
  // 同一进程刚跑完安装命令就重查 status：PATH memo（PERF-07）可能仍缓存着安装前的 miss，
  // 不主动失效会让「装完立即可见」缩水为最多 memo TTL 的延迟（review_blockers 记）
  clearCommandMemo()
  const st = await adapter.status(cfg, port)
  return { ok: true, auto: !!inst?.command, output: tailText(lines), installed: st.installed, skipped }
}

/**
 * 客户端卸载：有 install.uninstall 则 shell 执行（仅 npm 类客户端声明），与安装共用同一套子进程
 * 环境（installChildEnv——沙箱下全局落点经 npm_config_prefix 重定向，只卸装进沙箱的副本；
 * needsNode 时先保障 node/npm 可用，托管 runtime 的 shim 在托管 bin 下、PATH 缺它找不到 npm）。
 * probe 未命中说明命令已不在（从未装或已手动卸载），跳过执行仅做 bootstrap 清理；未声明
 * uninstall 的客户端（脚本类安装器 / 桌面应用）拒绝并提示手动卸载。bootstrap 清理：文件内容
 * 恰为安装时写入的空配置（字节相等）才删除，让 detect 回到「未安装」；有用户内容一律保留。
 */
export async function runClientUninstall(
  adapter: HarnessAdapter,
  cfg: Config,
  port: number
): Promise<{ ok: boolean; output: string; installed: boolean; skipped: boolean }> {
  const inst = adapter.install
  const lines: string[] = []
  let skipped = false
  const cmd = resolveInstallCommand(inst?.uninstall)
  if (!cmd) {
    lines.push(t('该客户端未配置自动卸载方式，请按安装指引手动卸载', 'This client has no automated uninstall; please uninstall it manually per the install guide'))
    return { ok: false, output: tailText(lines), installed: (await adapter.status(cfg, port)).installed, skipped }
  }
  if (inst?.probe && !probePresent(inst, inst.probe)) {
    skipped = true
    lines.push(t('{cmd} 命令不在 PATH 上，无需卸载', '{cmd} is not on PATH; nothing to uninstall', { cmd: inst.probe }))
  } else {
    const { exit, output } = await runInstallCommand(cmd, !!inst?.needsNode)
    if (exit === null) {
      // Node 保障失败：只报引导错误
      return { ok: false, output: tailText(output), installed: (await adapter.status(cfg, port)).installed, skipped }
    }
    if (exit !== 0) {
      clearCommandMemo() // 卸载命令已执行（不排除部分删除），重查 status 前主动失效 PATH memo
      return { ok: false, output: tailText(output), installed: (await adapter.status(cfg, port)).installed, skipped }
    }
    const childOut = output.join('').trim()
    if (childOut) lines.push(childOut)
    lines.push(t('已执行卸载命令：{cmd}', 'Ran uninstall command: {cmd}', { cmd }))
  }
  if (inst?.bootstrap?.path) {
    const bp = typeof inst.bootstrap.path === 'function' ? inst.bootstrap.path() : inst.bootstrap.path
    if ((await readTextIfExists(bp)) === inst.bootstrap.content) {
      try {
        await fsp.unlink(bp)
        lines.push(t('已删除安装时写入的空配置：{path}', 'Removed the empty bootstrap config written at install time: {path}', { path: bp }))
      } catch { /* 删除失败不阻断卸载结果 */ }
    } else if (await readTextIfExists(bp) !== null) {
      lines.push(t('配置文件已含其他内容，保留不动：{path}', 'Config file has other content, left untouched: {path}', { path: bp }))
    }
  }
  // 同一进程刚跑完卸载命令就重查 status：主动失效 PATH memo，让「卸完立即可见」
  clearCommandMemo()
  const st = await adapter.status(cfg, port)
  return { ok: true, output: tailText(lines), installed: st.installed, skipped }
}

export function tailText(lines: string[], max = INSTALL_OUTPUT_MAX): string {
  const text = lines.join('\n').trim()
  return text.length > max ? text.slice(-max) : text
}

/** 沙箱内该客户端的自动安装能力：无 command → null（本就只展示指引，不执行）；
 *  npm 全局安装 → 'redirect'（落点可重定向进沙箱）；脚本类 → 'unsupported'（写真机，沙箱内拒绝）。
 *  非沙箱恒为 null——UI 与安装行为均维持原样。 */
export function sandboxInstallCapability(a: HarnessAdapter): 'redirect' | 'unsupported' | null {
  if (!sandboxNpmPrefix() || !a.install?.command) return null
  return isNpmGlobalInstall(resolveInstallCommand(a.install.command) ?? '') ? 'redirect' : 'unsupported'
}

export async function hInstall(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  const b = await jsonRequestBody(req)
  try {
    const a = await requireAdapter(String(b.harness ?? ''), rt.config)
    const port = rt.port ?? rt.config.gateway?.port ?? DEFAULT_GATEWAY_PORT
    const r = await runClientInstall(a, rt.config, port)
    audit(
      bi('安装并接入客户端', 'Install & attach client'),
      a.id,
      r.ok
        ? (r.skipped ? bi('命令已存在，跳过安装', 'Command already present, install skipped') : r.auto ? bi('自动安装完成', 'Auto-install finished') : bi('已提供安装指引', 'Install guide provided'))
        : r.blocked
          ? bi('沙箱内不支持自动安装（会写进真机），已提示手动安装', 'Auto-install not supported in sandbox (would write to the real machine); manual install suggested')
          : bi('安装失败', 'Install failed')
    )
    await reloadRuntime(rt)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: r.ok,
        auto: r.auto,
        skipped: r.skipped,
        output: r.output,
        installed: r.installed,
        guide: a.install?.guide ?? '',
        homepage: a.install?.homepage ?? null,
      })
    )
  } catch (e) {
    sendError(res, 400, (e as Error).message)
  }
  return
}

export async function hUninstall(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  const b = await jsonRequestBody(req)
  try {
    const a = await requireAdapter(String(b.harness ?? ''), rt.config)
    // 接入中的客户端先断开：卸载只删程序本体，配置还原是 detach 的职责，顺序反了会留下指向网关的孤儿配置
    if (rt.config.harness[a.id]) {
      throw new Error(t('该客户端仍处于接入状态，请先「断开并还原」再卸载', 'This client is still attached — detach & restore first, then uninstall'))
    }
    const port = rt.port ?? rt.config.gateway?.port ?? DEFAULT_GATEWAY_PORT
    const r = await runClientUninstall(a, rt.config, port)
    audit(
      bi('卸载客户端', 'Uninstall client'),
      a.id,
      r.ok ? (r.skipped ? bi('命令不在 PATH，无需卸载', 'Command not on PATH; nothing to uninstall') : bi('卸载完成', 'Uninstall finished')) : bi('卸载失败', 'Uninstall failed')
    )
    await reloadRuntime(rt)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: r.ok, skipped: r.skipped, output: r.output, installed: r.installed }))
  } catch (e) {
    sendError(res, 400, (e as Error).message)
  }
  return
}

