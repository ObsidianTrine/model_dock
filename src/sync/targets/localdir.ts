/** localdir 同步目标：目录内直接读写，配合 iCloud/OneDrive/坚果云等同步盘（详设 §6.1/§6.2） */
import path from 'node:path'
import { atomicWrite, ensureDir, readTextIfExists } from '../../util/fsx.js'
import { expandHome } from '../../util/paths.js'
import { t } from '../../util/i18n.js'
import { SYNC_DIRNAME, parseManifest, type SyncManifest, type SyncTarget } from './types.js'

export function createLocaldirTarget(dir: string): SyncTarget {
  const root = path.join(expandHome(dir), SYNC_DIRNAME)
  const blobPath = (ref: string): string => {
    const full = path.resolve(root, ref)
    if (full !== path.resolve(root) && !full.startsWith(path.resolve(root) + path.sep)) {
      throw new Error(t('同步目标返回的 blob 路径非法：{ref}', 'Invalid blob path from the sync target: {ref}', { ref }))
    }
    return full
  }
  return {
    async readManifest(): Promise<SyncManifest | null> {
      const text = await readTextIfExists(path.join(root, 'manifest.json'))
      return text === null ? null : parseManifest(text)
    },
    async writeBlob(rev, devid, envelope) {
      await ensureDir(path.join(root, 'blobs'))
      await atomicWrite(blobPath(`blobs/${rev}-${devid}.msync`), envelope, 0o600)
    },
    async writeManifest(m, baseRev) {
      const cur = await readTextIfExists(path.join(root, 'manifest.json'))
      if (cur !== null && parseManifest(cur).rev !== baseRev) return 'conflict'
      await ensureDir(root)
      await atomicWrite(path.join(root, 'manifest.json'), JSON.stringify(m, null, 2) + '\n', 0o600)
      return 'ok'
    },
    async readBlob(ref) {
      const text = await readTextIfExists(blobPath(ref))
      if (text === null) {
        throw new Error(t('同步历史包缺失（{ref}）：同步目标上的 blobs 目录被清理过？', 'Sync blob missing ({ref}): was the blobs folder cleaned up on the target?', { ref }))
      }
      return text
    },
  }
}
