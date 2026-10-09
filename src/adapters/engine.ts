import { confirm } from '@inquirer/prompts'
import { readTextIfExists, atomicWrite, fileMode } from '../util/fsx.js'
import { unifiedDiff, redact } from '../util/diff.js'
import { c } from '../util/color.js'
import { t } from '../util/i18n.js'
import { snapshot, restoreSnapshot } from '../backup/snapshot.js'
import type { FileChange } from './types.js'

export interface ApplyOptions {
  /** 跳过确认（自动化场景；diff 仍会展示） */
  yes?: boolean
  /** diff 展示前要抹掉的敏感串（token、key 等） */
  redactions?: string[]
  /** 静默模式：只输出必要信息 */
  quiet?: boolean
}

/**
 * 落盘引擎：diff 预览 → 确认 → 快照 → 原子写 → 回读校验（失败回滚）→ 滚动清理。
 * 这是所有 harness 文件写入的唯一入口。
 */
export async function applyChanges(
  harness: string,
  operation: string,
  changes: FileChange[],
  opts: ApplyOptions = {}
): Promise<boolean> {
  if (changes.length === 0) {
    if (!opts.quiet) console.log(c.gray(t('无文件改动', 'No file changes')))
    return true
  }

  // 展示 diff（与磁盘当前内容比，而非 plan 时的旧内容，防止 plan→apply 之间文件被外部修改造成误导）
  const sections: string[] = []
  for (const ch of changes) {
    const current = (await readTextIfExists(ch.path)) ?? ''
    const diff = unifiedDiff(current, ch.after)
    const header = `${ch.path}${ch.note ? c.gray(`  — ${ch.note}`) : ''}`
    sections.push(
      diff
        ? `${c.bold(header)}\n${indentDiff(redact(diff, opts.redactions ?? []))}`
        : `${c.bold(header)}\n${c.gray(t('  （内容无变化）', '  (no content change)'))}`
    )
    // TOML 重建丢注释是格式固有限制：提前说破，别让用户事后才发现
    if (ch.path.toLowerCase().endsWith('.toml') && ch.before && /^\s*#/m.test(ch.before)) {
      sections.push(
        c.yellow(
          t(
            '  ⚠ {path} 含注释行；TOML 重写无法保留注释，原注释会丢失（原文已自动快照，可 restore 找回）',
            '  ⚠ {path} contains comment lines; rewriting TOML cannot preserve comments and they will be lost (the original is snapshotted automatically and can be restored)',
            { path: ch.path }
          )
        )
      )
    }
  }
  console.log(sections.join('\n\n'))

  if (!opts.yes) {
    const ok = await confirm({
      message: t(
        '写入以上改动？（写入前自动快照，可随时 restore/detach 还原）',
        'Write the changes above? (a snapshot is taken first; restore/detach anytime to roll back)'
      ),
    })
    if (!ok) {
      console.log(c.gray(t('已取消，未做任何改动', 'Cancelled; nothing was changed')))
      return false
    }
  }

  const manifest = await snapshot(harness, operation, changes.map((ch) => ch.path))
  if (!opts.quiet) {
    console.log(
      c.green(t('已创建快照 {id}（{count} 个文件）', 'Snapshot {id} created ({count} files)', { id: manifest.id, count: manifest.files.length }))
    )
  }

  for (const ch of changes) {
    // 乐观锁：写前重读，与 plan 时的内容比对。plan→apply 之间被外部改过的文件绝不静默覆盖
    const current = (await readTextIfExists(ch.path)) ?? ''
    if (current !== (ch.before ?? '')) {
      await restoreSnapshot(manifest)
      throw new Error(
        t(
          '{path} 在生成计划后被外部修改过，已中止写入并从快照回滚。请重新执行一次 attach/detach（会基于最新内容重新生成 diff）',
          '{path} was modified externally after the plan was generated; the write was aborted and rolled back from the snapshot. Run attach/detach again to regenerate the diff from the latest content',
          { path: ch.path }
        )
      )
    }
    const mode = await fileMode(ch.path)
    await atomicWrite(ch.path, ch.after, mode)
    const verify = await readTextIfExists(ch.path)
    if (verify !== ch.after) {
      await restoreSnapshot(manifest)
      throw new Error(t('写入后回读校验失败，已从快照回滚：{path}', 'Post-write verification failed and was rolled back from the snapshot: {path}', { path: ch.path }))
    }
  }
  return true
}

function indentDiff(diff: string): string {
  return diff
    .split('\n')
    .map((l) => {
      if (l.startsWith('+')) return c.green(l)
      if (l.startsWith('-')) return c.red(l)
      if (l.startsWith('@@')) return c.gray(l)
      return c.gray(`  ${l}`)
    })
    .join('\n')
}
