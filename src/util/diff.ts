import { t } from './i18n.js'
/** 等值判定口径（与下方 unifiedDiff 的行切分同规）：归一化 \r\n → \n 后比较。
 *  仅用于「内容是否变化」的判定，不改变任何写入内容——Windows 编辑器保存的客户端配置常是
 *  CRLF，而本程序（yaml/toml 序列化）输出恒 LF，逐字节比较会把「仅行尾差异」误判为有变化，
 *  击穿稳态守卫（changeIfChanged / refreshBakedModelClients 的内容一致守卫），
 *  让周期 refresh / 稳态重接每次都整写盘 + 拍快照（2026-11-04 审查 P2）。 */
export function textEqualsIgnoreEol(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  return a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n')
}
/** 行级 unified diff（LCS），用于写入前预览；文件超大时降级为摘要 */
export function unifiedDiff(a: string, b: string, context = 3): string {
  // 统一 CRLF → LF 再比对：Windows 编辑器保存的配置是 CRLF，本程序序列化输出是 LF，
  // 不抹掉 \r 时每行行尾都不同，整个文件会被误报成全删全加
  const split = (s: string): string[] => (s.length ? s.replace(/\r\n/g, '\n').split('\n') : [])
  const al = split(a)
  const bl = split(b)
  // 配置文件 diff 用不到大矩阵：2M 格子 ≈ 8MB 内存，超过即降级摘要
  if (al.length * bl.length > 2_000_000) return t('(文件过大，diff 略)', '(file too large, diff skipped)')

  // LCS DP
  const n = al.length
  const m = bl.length
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = al[i] === bl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops: { t: '=' | '-' | '+'; s: string }[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (al[i] === bl[j]) {
      ops.push({ t: '=', s: al[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: '-', s: al[i] })
      i++
    } else {
      ops.push({ t: '+', s: bl[j] })
      j++
    }
  }
  while (i < n) ops.push({ t: '-', s: al[i++] })
  while (j < m) ops.push({ t: '+', s: bl[j++] })

  if (!ops.some((o) => o.t !== '=')) return ''

  // 聚合 hunks，保留上下文
  const out: string[] = []
  let idx = 0
  while (idx < ops.length) {
    if (ops[idx].t === '=') {
      idx++
      continue
    }
    let start = idx
    while (start > 0 && ops[start - 1].t === '=' && idx - start < context) start--
    let end = idx
    while (end < ops.length && ops[end].t !== '=') end++
    let ctxEnd = end
    while (ctxEnd < ops.length && ops[ctxEnd].t === '=' && ctxEnd - end < context) ctxEnd++
    out.push('@@ ... @@')
    for (let k = start; k < ctxEnd; k++) {
      const o = ops[k]
      out.push(o.t === '=' ? `  ${o.s}` : o.t === '-' ? `- ${o.s}` : `+ ${o.s}`)
    }
    idx = ctxEnd
  }
  return out.join('\n')
}

/** 在展示 diff 前抹掉敏感串 */
export function redact(text: string, secrets: (string | undefined)[]): string {
  let out = text
  for (const s of secrets) {
    if (s && s.length > 6) out = out.split(s).join('***REDACTED***')
  }
  return out
}
