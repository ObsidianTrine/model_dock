import { t } from './i18n.js'
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
