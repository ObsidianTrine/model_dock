import { loadConfig, mutateConfig } from './store.js'
import { getSecret, parseKeyRef, setSecret } from './secrets.js'

/**
 * 沙箱（MODELRDOCK_FAKE_HOME）密钥引用落地：把配置里的外部存储引用（keychain/secret-service）
 * 改写为沙箱本地 file 引用，值从外部存储只读取出、写进沙箱 secrets.json。
 *
 * 为什么需要：dev-seed 从生产复制配置时 key 原样照搬，沙箱由此持有指向生产钥匙环的引用；
 * 外部存储是机器级全局、不随 home 隔离，沙箱后续的改/删（控制台改 key、reset、uninstall）
 * 会直接作用在生产条目上。落地后沙箱与生产钥匙环彻底解耦。幂等：全部改写后再次调用为无操作。
 *
 * 仅网关启动路径调用（调用方已判定 FAKE_HOME）；单项失败跳过不影响其余，
 * 未迁移的引用由 deleteSecret 的沙箱守卫兜底（不删外部条目）。
 */
export async function migrateSandboxKeyRefsToLocal(): Promise<string[]> {
  const cfg = await loadConfig()
  const migrated: string[] = []

  const isExternal = (ref: string | undefined): ref is string => {
    if (!ref) return false
    const s = parseKeyRef(ref).scheme
    return s === 'keychain' || s === 'secret-service'
  }

  const providerRefs = Object.entries(cfg.providers ?? {}).filter(([, p]) => isExternal(p.key_ref))
  const tokenRef = cfg.update?.token_ref
  if (providerRefs.length === 0 && !isExternal(tokenRef) && !isExternal(cfg.security?.store as string | undefined)) {
    return []
  }

  const okProviderIds: string[] = []
  for (const [id, p] of providerRefs) {
    try {
      const val = await getSecret(p.key_ref)
      // 读不到（外部条目缺失/钥匙环读取失败）：不落空 key、引用保持原样由守卫兜底——
      // 此前 val ?? '' 会把原本可用的生产 keychain 引用永久替换成指向空 key 的 file 引用
      if (val == null) continue
      await setSecret(id, val, 'file')
      migrated.push(id)
      okProviderIds.push(id)
    } catch { /* 单项失败不阻断：引用保持原样，deleteSecret 沙箱守卫兜底 */ }
  }
  let okTokenId: string | null = null
  if (isExternal(tokenRef)) {
    try {
      const parsed = parseKeyRef(tokenRef)
      const val = await getSecret(tokenRef)
      if (val != null) {
        await setSecret(parsed.id, val, 'file')
        migrated.push(`update:${parsed.id}`)
        okTokenId = parsed.id
      }
    } catch { /* 同上 */ }
  }

  await mutateConfig((c2) => {
    // 只改写「值已成功落进沙箱 secrets.json」的引用：读失败的条目保留外部引用（守卫兜底），
    // 不然引用翻转后指向不存在的 file 条目，比保留外部引用更糟
    for (const id of okProviderIds) {
      if (c2.providers[id]) c2.providers[id].key_ref = `file:${id}`
    }
    const tr = c2.update?.token_ref
    if (okTokenId && isExternal(tr) && parseKeyRef(tr).id === okTokenId) {
      c2.update = { ...c2.update, token_ref: `file:${okTokenId}` }
    }
    const st = c2.security?.store as string | undefined
    if (st === 'keychain' || st === 'secret-service') {
      c2.security = { ...c2.security, store: 'file' }
    }
  })
  return migrated
}
