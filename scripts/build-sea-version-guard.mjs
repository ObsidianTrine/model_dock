/**
 * build-sea 版本文件中断残留自愈（11-20 晨审 F6）。
 *
 * why：build-sea.mjs 构建期把 git tag 版本临时写进 src/version.ts + package.json，靠 main()
 * 的 finally 还原。优雅退出有兜底，但 err() 直调 process.exit(1)、kill / 断电 / 崩溃均绕过
 * finally——仓库会残留错误版本号，下次构建基于污染态进行。仓库不变式：两文件在无构建进行时
 * 与 git HEAD 一致（版本号唯一事实来源是 git tag，见 AGENTS.md）。
 *
 * 自愈口径（保守优先，绝不吞用户改动）：
 *   - 差异形状 = 仅版本号字段（version.ts 的 VERSION 常量字面量 / package.json 的 version 键）
 *     → 判定为上次构建残留，按 git HEAD 还原两文件并提示；
 *   - 差异形状超出版本号字段（用户真实未提交改动、文件损坏等）→ 不还原，fail-loud 中止构建，
 *     要求人工确认；
 *   - HEAD / 工作树任一不可读 → 无法区分残留与用户改动 → 同样 fail-loud。
 */

import { spawnSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'

export const VERSION_TS_REL = 'src/version.ts'
export const PKG_JSON_REL = 'package.json'

/** git blob 恒 LF；Windows 工作树可能 CRLF（autocrlf）——文本比较前必须拉平，否则纯换行差异会误判 foreign */
function normEol(s) {
  return s.replace(/\r\n/g, '\n')
}

/**
 * version.ts 差异形状判定：'clean' | 'residue' | 'foreign'。
 * 残留形状 = 只允许 VERSION 赋值的引号字面量不同（syncVersionFromTag 的唯一写法）；
 * 用占位符掩码比对，掩码只覆盖赋值处的字面量——文件其他任何位置的版本串改动（如注释）不会被误掩。
 * 掩码不带 /g（复审 P2-2）：只作用首个匹配——/g 会把注释里同模式的历史版本串一并抹平，
 * 掩盖注释本身的差异；非首个匹配处的差异留在掩码外照常判 foreign。
 */
export function classifyVersionTsDiff(head, cur) {
  if (normEol(cur) === normEol(head)) return 'clean'
  const mask = (s) =>
    normEol(s).replace(/(export const VERSION = )(['"])[^'"\n]*\2/, '$1$2<VER>$2')
  return mask(head) === mask(cur) ? 'residue' : 'foreign'
}

/**
 * package.json 差异形状判定：JSON 语义比较（解析后剥掉 version 键再深比较）。
 * why 不比文本：syncVersionFromTag 会重序列化整个 JSON，残留写入本身就会改变键间距之外的
 * 文本细节；只认语义差异才能既放过残留又不放过新增依赖等真实改动。版本键未变（含两侧均无）
 * 却内容有别 → 一律 foreign（保守：不猜格式化意图）。
 * 键序保守口径（复审 P2-1）：残留写入（parse 后原对象重序列化）永不改键序、增删键——
 * 键序或键集有任何不同即人工改动 → foreign，与「version 未变即 foreign」对称，
 * 杜绝「键序重排 + version 同变」被静默还原吞掉键序意图。
 */
export function classifyPkgJsonDiff(head, cur) {
  if (normEol(cur) === normEol(head)) return 'clean'
  let h, c
  try {
    h = JSON.parse(head)
    c = JSON.parse(cur)
  } catch {
    return 'foreign'
  }
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  if (!isObj(h) || !isObj(c)) return 'foreign'
  if (h.version === c.version) return 'foreign'
  if (JSON.stringify(Object.keys(h)) !== JSON.stringify(Object.keys(c))) return 'foreign'
  const { version: _hv, ...hRest } = h
  const { version: _cv, ...cRest } = c
  return deepEqual(hRest, cRest) ? 'residue' : 'foreign'
}

function deepEqual(a, b) {
  if (a === b) return true
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  if (a !== null && typeof a === 'object') {
    const ka = Object.keys(a).sort()
    const kb = Object.keys(b).sort()
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false
    return ka.every((k) => deepEqual(a[k], b[k]))
  }
  return false
}

/**
 * 四分支判定（纯函数，IO 注入，单测面）：
 *   - { action: 'none' }：两文件均与 HEAD 一致；
 *   - { action: 'restore', headVersionTs, headPkgJson }：仅版本号形状差异 → 按 HEAD 还原两文件
 *     （还原两文件而非只脏的那份：干净文件写回同内容 = no-op，少一次分支判定）；
 *   - { action: 'reject', reason }：超形状差异 / HEAD 或工作树不可读 → fail-loud。
 */
export function decideVersionResidue({ headVersionTs, headPkgJson, curVersionTs, curPkgJson }) {
  if (headVersionTs == null || headPkgJson == null) {
    const missing = [
      headVersionTs == null ? VERSION_TS_REL : null,
      headPkgJson == null ? PKG_JSON_REL : null,
    ]
      .filter(Boolean)
      .join(' / ')
    return { action: 'reject', reason: `无法读取 git HEAD 中的 ${missing}（无 HEAD？非 git 检出？）` }
  }
  if (curVersionTs == null || curPkgJson == null) {
    const missing = [
      curVersionTs == null ? VERSION_TS_REL : null,
      curPkgJson == null ? PKG_JSON_REL : null,
    ]
      .filter(Boolean)
      .join(' / ')
    return { action: 'reject', reason: `无法读取工作树文件 ${missing}` }
  }
  const clsTs = classifyVersionTsDiff(headVersionTs, curVersionTs)
  const clsPkg = classifyPkgJsonDiff(headPkgJson, curPkgJson)
  if (clsTs === 'foreign' || clsPkg === 'foreign') {
    const which = [clsTs === 'foreign' ? VERSION_TS_REL : null, clsPkg === 'foreign' ? PKG_JSON_REL : null]
      .filter(Boolean)
      .join(' / ')
    return { action: 'reject', reason: `${which} 与 git HEAD 的差异超出版本号字段（疑似人工改动）` }
  }
  if (clsTs === 'residue' || clsPkg === 'residue') {
    return { action: 'restore', headVersionTs, headPkgJson }
  }
  return { action: 'none' }
}

/**
 * 读 git HEAD 里的文件内容。直调 git（exe 非 .cmd 包装，三平台可 spawn，不走 shell 拼接）；
 * 任何失败（非 git 仓 / 无 HEAD / 文件不在 HEAD）一律返回 null，由判定层 fail-loud。
 */
export function readGitHeadFile(root, rel) {
  const r = spawnSync('git', ['-C', root, 'show', `HEAD:${rel}`], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  return r.status === 0 && typeof r.stdout === 'string' ? r.stdout : null
}

async function safeReadFile(p) {
  try {
    return await fsp.readFile(p, 'utf8')
  } catch {
    return null
  }
}

/**
 * 构建启动时（写版本前）调用：检测并自愈中断残留。action=restore 时写回 HEAD 内容（写法与
 * syncVersionFromTag 一致，fs 原生写）；action=reject 时 throw，由 main().catch → err() 收口
 * （不可用 err() 直调：会重蹈 process.exit 绕过 finally 的覆辙，且 throw 让调用方保留栈）。
 * warn 由调用方注入——本模块不耦合输出。
 */
export async function healVersionResidue(root, out = {}) {
  const warn = out.warn ?? (() => {})
  const verdict = decideVersionResidue({
    headVersionTs: readGitHeadFile(root, VERSION_TS_REL),
    headPkgJson: readGitHeadFile(root, PKG_JSON_REL),
    curVersionTs: await safeReadFile(path.join(root, VERSION_TS_REL)),
    curPkgJson: await safeReadFile(path.join(root, PKG_JSON_REL)),
  })
  if (verdict.action === 'restore') {
    await fsp.writeFile(path.join(root, VERSION_TS_REL), verdict.headVersionTs)
    await fsp.writeFile(path.join(root, PKG_JSON_REL), verdict.headPkgJson)
    warn('上次构建中断残留已还原：src/version.ts 与 package.json 已按 git HEAD 写回')
  }
  if (verdict.action === 'reject') {
    throw new Error(
      `版本文件存在超出版本号字段的未提交差异，已拒绝自动还原、构建中止：${verdict.reason}\n` +
        `请先人工确认（git diff src/version.ts package.json），提交或恢复差异后重新构建；你的文件未被改动。\n` +
        `Version files differ from git HEAD beyond the version field; auto-restore refused (uncommitted changes protected). ` +
        `Review with \`git diff src/version.ts package.json\`, commit or revert, then rebuild.`,
    )
  }
  return verdict
}
