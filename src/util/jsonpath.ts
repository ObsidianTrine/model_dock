import { t } from './i18n.js'

/**
 * 极简 JSONPath 风格路径读写，供 L2 声明式 adapter 使用。
 * 支持 `$.a.b.c`、`$.a[0].b`、`$.a.*.b`（* 遍历对象全部键，至多一个）。
 * 表达式必须被完整解析：含引号键 / 负数下标 / 未闭合括号等不支持句式一律抛可操作双语错误
 * （CORRECT-08——L2 pack 的路径来自用户手写，宽容解析会把值静默写进错误的位置）。
 */
interface Seg {
  key?: string
  index?: number
  star?: boolean
}

function tokenize(expr: string): Seg[] {
  const body = expr.replace(/^\$\.?/, '')
  const segs: Seg[] = []
  // 前缀 \.? 把段间分隔符一并连续消费：首版把「.」排除出可匹配字符却不消费它，m.index 永远停在
  // 点号上、多段点句式（$.a.b.c）全部被「不连续」误判——worktree 全量实测 12 例红的回归修复
  const re = /\.?([^[.\]]+)|\[(\d+)\]/g
  let m: RegExpExecArray | null
  let consumed = 0
  while ((m = re.exec(body))) {
    // 匹配段必须首尾相接：exec 会跳过无法解析的字符（引号键/负数下标/未闭合括号等），
    // 靠「消费位置不连续」检测，不满足即抛错（CORRECT-08 缺陷①：原实现静默吞字/改写）
    if (m.index !== consumed) break
    consumed += m[0].length
    if (m[1] !== undefined) {
      if (m[1] === '*') segs.push({ star: true })
      else segs.push({ key: m[1] })
    } else {
      segs.push({ index: Number(m[2]) })
    }
  }
  if (consumed !== body.length) {
    const ch = body[consumed] ?? ''
    throw new Error(
      t(
        '路径 {expr} 无法解析：第 {pos} 个字符「{ch}」不支持（仅支持 $.a.b、$.a.*.b、$.a[0] 点/下标句式；不支持引号键、负数下标与未闭合括号）',
        'Path {expr} cannot be parsed: character {pos} ("{ch}") is not supported (only $.a.b, $.a.*.b, $.a[0] dot/index syntax; quoted keys, negative indexes and unclosed brackets are not supported)',
        { expr, pos: consumed + 1, ch }
      )
    )
  }
  return segs
}

/** 读路径：与写入共用严格 tokenize（表达式无法完整解析即抛错）——取舍：L2 pack 的读写路径是
 *  同一份用户手写表达式，读侧宽容只会把「写错位置」推迟到更难排查的下游，宁可早报错。 */
export function getPath(root: unknown, expr: string): unknown {
  let cur: unknown = root
  for (const seg of tokenize(expr)) {
    if (seg.star) return undefined // star 仅用于写入
    if (cur == null) return undefined
    if (seg.key !== undefined) cur = (cur as Record<string, unknown>)[seg.key]
    else cur = (cur as unknown[])[seg.index as number]
  }
  return cur
}

/** 路径表达式 → 段数组（yaml Document.setIn 等需要）；不支持 star */
export function toSegments(expr: string): Array<string | number> {
  return tokenize(expr).map((seg) => {
    if (seg.star) throw new Error(t('路径 {expr} 不支持 *', 'Path {expr} does not support *', { expr }))
    return seg.key !== undefined ? seg.key : (seg.index as number)
  })
}

/** 原地写入；容器按需创建。返回 root 便于链式调用 */
export function setPath<T>(root: T, expr: string, value: unknown): T {
  const segs = tokenize(expr)
  if (segs.length > 0) applySet(root, segs, value, expr)
  return root
}

function applySet(cur: unknown, segs: Seg[], value: unknown, expr: string): void {
  const [seg, ...rest] = segs
  if (seg.star) {
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
      for (const k of Object.keys(cur as Record<string, unknown>)) {
        const child = (cur as Record<string, unknown>)[k]
        if (rest.length === 0) {
          if (child && typeof child === 'object') continue
          ;(cur as Record<string, unknown>)[k] = value
        } else {
          // 非 object 子节点 skip：与上方 leaf 分支「不覆盖已有 object」同口径——
          // star 遍历的语义是改写同类叶子，静默把标量改造成容器（或裸崩）都不对（CORRECT-08 缺陷②）
          if (!child || typeof child !== 'object') continue
          applySet(child, rest, value, expr)
        }
      }
    }
    return
  }
  if (rest.length === 0) {
    if (seg.key !== undefined) (cur as Record<string, unknown>)[seg.key] = value
    else {
      // 下标段 × 对象容器：显式报错，不再静默落字符串键 "0"（CORRECT-08 缺陷③——
      // 序列化形态与路径语义不符，pack 作者视角即「写进去了但读不到」）
      if (!Array.isArray(cur)) {
        throw new Error(
          t(
            '路径 {expr}：下标段只能用于数组，容器是对象（想往对象写键请用 $.a.b 点句式）',
            'Path {expr}: index segments only apply to arrays but the container is an object (use $.a.b dot syntax to write object keys)',
            { expr }
          )
        )
      }
      const arr = cur
      const idx = seg.index as number
      // 越界写入会制造稀疏数组（序列化成一串 null），明确报错比静默产出坏数据好
      if (idx > arr.length) {
        throw new Error(
          t(
            '路径越界：数组长度 {len}，无法写入下标 {idx}（只允许改写已有元素或追加到末尾）',
            'Path out of bounds: array length is {len}, cannot write index {idx} (only rewriting existing elements or appending at the end is allowed)',
            { len: arr.length, idx }
          )
        )
      }
      arr[idx] = value
    }
    return
  }
  const next = rest[0]
  let child: unknown
  if (seg.key !== undefined) {
    const rec = cur as Record<string, unknown>
    child = rec[seg.key]
    if (typeof child !== 'object' || child === null) {
      child = next.index !== undefined ? [] : {}
      rec[seg.key] = child
    }
  } else {
    // 中段下标 × 对象容器：同上显式报错（CORRECT-08 缺陷③）
    if (!Array.isArray(cur)) {
      throw new Error(
        t(
          '路径 {expr}：下标段只能用于数组，容器是对象（想往对象写键请用 $.a.b 点句式）',
          'Path {expr}: index segments only apply to arrays but the container is an object (use $.a.b dot syntax to write object keys)',
          { expr }
        )
      )
    }
    const arr = cur
    const idx = seg.index as number
    child = arr[idx]
    if (typeof child !== 'object' || child === null) {
      if (idx > arr.length) {
        throw new Error(
          t('路径越界：数组长度 {len}，无法写入下标 {idx}', 'Path out of bounds: array length is {len}, cannot write index {idx}', {
            len: arr.length,
            idx,
          })
        )
      }
      child = next.index !== undefined ? [] : {}
      arr[idx] = child
    }
  }
  applySet(child, rest, value, expr)
}
