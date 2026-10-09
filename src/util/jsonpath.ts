import { t } from './i18n.js'

/**
 * 极简 JSONPath 风格路径读写，供 L2 声明式 adapter 使用。
 * 支持 `$.a.b.c`、`$.a[0].b`、`$.a.*.b`（* 遍历对象全部键，至多一个）。
 */
interface Seg {
  key?: string
  index?: number
  star?: boolean
}

function tokenize(expr: string): Seg[] {
  const body = expr.replace(/^\$\.?/, '')
  const segs: Seg[] = []
  const re = /([^[.\]]+)|\[(\d+)\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    if (m[1] !== undefined) {
      if (m[1] === '*') segs.push({ star: true })
      else segs.push({ key: m[1] })
    } else {
      segs.push({ index: Number(m[2]) })
    }
  }
  return segs
}

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
  if (segs.length > 0) applySet(root, segs, value)
  return root
}

function applySet(cur: unknown, segs: Seg[], value: unknown): void {
  const [seg, ...rest] = segs
  if (seg.star) {
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
      for (const k of Object.keys(cur as Record<string, unknown>)) {
        const child = (cur as Record<string, unknown>)[k]
        if (rest.length === 0) {
          if (child && typeof child === 'object') continue
          ;(cur as Record<string, unknown>)[k] = value
        } else {
          applySet(child, rest, value)
        }
      }
    }
    return
  }
  if (rest.length === 0) {
    if (seg.key !== undefined) (cur as Record<string, unknown>)[seg.key] = value
    else {
      const arr = cur as unknown[]
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
    const arr = cur as unknown[]
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
  applySet(child, rest, value)
}
