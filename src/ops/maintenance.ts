import { t } from '../util/index.js'
import { loadConfig, mutateConfig } from '../config/store.js'
import { defaultStore, deleteSecret, getSecret, setSecret, parseKeyRef } from '../config/secrets.js'
import type { Config } from '../config/types.js'

/**
 * 将历史明文 file: 密钥引用迁移到当前平台的安全后端（macOS→Keychain / Linux→Secret Service），
 * 并在迁移成功后从明文文件删除。win32 的 file 后端内部已是 DPAPI 加密，无需迁移；无安全后端
 * 或没有明文引用时为无操作。网关启动时调用一次，单项失败不影响其余、不影响主流程。
 */
export async function migrateSecretsToSecure(): Promise<void> {
  const target = await defaultStore()
  if (target === 'file') return
  const cfg = await loadConfig()
  const providers = cfg.providers ?? {}
  const files = Object.entries(providers).filter(([, p]) => parseKeyRef(p.key_ref ?? '').scheme === 'file')
  if (files.length === 0) return
  let migrated = 0
  for (const [id, p] of files) {
    try {
      const plain = await getSecret(p.key_ref)
      if (plain == null) continue
      const newRef = await setSecret(id, plain, target)
      await mutateConfig((c) => {
        c.providers[id].key_ref = newRef
      })
      await deleteSecret(p.key_ref)
      migrated++
    } catch {
      // 单项失败不阻断其余，留待下次启动重试
    }
  }
  if (migrated > 0) {
    console.log(
      t('✓ 已迁移 {count} 个密钥到安全后端（{backend}）', '✓ Migrated {count} keys to the secure backend ({backend})', {
        count: migrated,
        backend: target,
      })
    )
  }
}

/**
 * 删除 provider 的级联清理（CLI provider rm 与 Web /service/delete 共用，两端口径一致）：
 * 删除引用它的 profile、清 active_profile 与 auto_route_provider，剔除各 profile 的
 * fallback 候选链与定时切换窗口里的悬空条目（"<id>" 与 "<id>:<model>" 两种形态）。
 * 返回被删除的 profile 名列表供调用方提示/审计；钉定保护与密钥删除由调用方负责。
 */
export function removeProviderCascade(c: Config, id: string): string[] {
  const usedBy = Object.entries(c.profiles).filter(([, pr]) => pr.provider === id).map(([k]) => k)
  delete c.providers[id]
  for (const k of usedBy) delete c.profiles[k]
  if (c.active_profile && usedBy.includes(c.active_profile)) delete c.active_profile
  if (c.gateway?.auto_route_provider === id) delete c.gateway.auto_route_provider
  // 「下一个切换」钉定同样要清：留着会成为悬空引用，控制台显示死 id、nextPinnedSkipped 误报
  //（转发侧 pickTarget 对未知 id 安全跳过，无请求级故障，但 UI 侧展示脏）
  if (c.gateway?.route_next === id) delete c.gateway.route_next
  for (const prof of Object.values(c.profiles)) {
    if (prof.fallback?.some((e) => e === id || e.startsWith(`${id}:`))) {
      prof.fallback = prof.fallback.filter((e) => e !== id && !e.startsWith(`${id}:`))
      if (prof.fallback.length === 0) delete prof.fallback
    }
  }
  if (c.gateway?.schedule?.windows?.length) {
    const sched = c.gateway.schedule
    const kept = sched.windows!.filter((w) => w.target.split(':')[0] !== id)
    if (kept.length !== sched.windows!.length) {
      if (kept.length === 0) delete sched.windows
      else sched.windows = kept
    }
  }
  // file 模式客户端自管路由，不沿网关转发：其 route 仅登记痕迹，服务删除后一并清掉，
  // 避免残留指向已删 profile 的悬空引用（删除守卫对 file 模式放行，见 server/service/delete）
  for (const he of Object.values(c.harness ?? {})) {
    if (he.mode === 'file' && he.route && usedBy.includes(he.route)) he.route = 'default'
  }
  return usedBy
}
