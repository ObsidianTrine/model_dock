import { sealEnvelope, openEnvelope } from './crypto.js'
import { applySyncdoc, collectSyncdoc, type SyncdocReport } from './collect.js'
import { validateSyncdoc, type Syncdoc } from './types.js'
import type { SecretBackend } from '../config/secrets.js'
import { atomicWrite, readTextIfExists } from '../util/fsx.js'
import { t } from '../util/i18n.js'
import { localIsoTs } from '../util/time.js'

/**
 * 导出包文件名：modeldock-config-YYYYMMDD-HHMMSS.msync（**本地时间**，与日志同口径）。
 * 精确到秒而非到天：真实用法是「导出 → 新机导入 → 发现不对（key 读不到/漏服务）→ 改完再导出」，
 * 全程几分钟，按天命名必撞；撞了以后浏览器只加 (1)(2)，看不出哪个新，转发/挪目录后更难分辨。
 * 只用数字与连字符——盘符/路径字符（: * ? " < > |）在三平台都可能非法，NTFS 上冒号尤其致命。
 * 来源机器与精确时刻不必进文件名：包内 created_by / created_at 已记录，导入预览会显示。
 */
export function exportFileName(d: Date = new Date()): string {
  return `modeldock-config-${localIsoTs(d).slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}.msync`
}

/** 可同步态全空时拒绝导出（CLI 与 /m 端点共用），给出可操作提示 */
export function assertExportable(report: SyncdocReport): void {
  if (report.providers.length === 0 && report.profiles.length === 0 && report.presetCount === 0 && report.scheduleRules === 0) {
    throw new Error(
      t(
        '本地没有可导出的同步内容：服务、路由、自定义预设、定时规则全为空。先用 modeldock provider add 添加服务后再导出',
        'Nothing to export: no providers, profiles, custom presets, or schedule rules are configured. Add a provider with modeldock provider add first'
      )
    )
  }
}

/** 导出：收集可同步态 → 密封 → 写 .msync 文件（0600）。内容全空时拒绝并给出可操作提示 */
export async function exportSyncdoc(filePath: string, passphrase: string): Promise<{ report: SyncdocReport }> {
  const { doc, report } = await collectSyncdoc()
  assertExportable(report)
  const env = sealEnvelope(doc, passphrase)
  await atomicWrite(filePath, JSON.stringify(env, null, 2) + '\n', 0o600)
  return { report }
}

/** 导入预览：拆封 → schema 校验（不写任何东西）。口令错误/包损坏/被篡改在此抛可操作报错 */
export async function previewImport(filePath: string, passphrase: string): Promise<{ doc: Syncdoc; report: SyncdocReport; meta: { createdBy: string; createdAt: string } }> {
  const text = await readTextIfExists(filePath)
  if (text === null) {
    throw new Error(t('文件不存在：{p}', 'File not found: {p}', { p: filePath }))
  }
  let env: unknown
  try {
    env = JSON.parse(text)
  } catch (e) {
    throw new Error(t('{p} 不是合法的配置同步包（JSON 解析失败：{err}）', '{p} is not a valid sync package (JSON parse failed: {err})', { p: filePath, err: (e as Error).message }))
  }
  const envelope = openEnvelope(env, passphrase)
  const doc = validateSyncdoc(envelope)
  const metaEnv = env as Record<string, unknown>
  return { doc, report: reportOfDoc(doc), meta: { createdBy: String(metaEnv.created_by ?? ''), createdAt: String(metaEnv.created_at ?? '') } }
}

/** 应用已预览确认的 syncdoc（替换全部可同步态、机器态不动）。仅应在 previewImport 之后调用 */
export async function applyImportedDoc(doc: Syncdoc, opts?: { backend?: SecretBackend }): Promise<SyncdocReport> {
  return applySyncdoc(doc, opts)
}

/** 从 doc 本身算导入侧摘要（key 明文是否随包、env/缺失引用清单）——CLI 预览与 /m 页预览共用 */
export function reportOfDoc(doc: Syncdoc): SyncdocReport {
  const envKeyRefs: string[] = []
  const missingKeys: string[] = []
  for (const [id, p] of Object.entries(doc.data.providers)) {
    if (typeof p.key === 'string' && p.key !== '') continue
    const scheme = (p.key_ref ?? '').split(':')[0]
    if (scheme === 'env') envKeyRefs.push(id)
    else missingKeys.push(id)
  }
  const up = doc.data.userPresets
  return {
    providers: Object.keys(doc.data.providers),
    profiles: Object.keys(doc.data.profiles),
    presetCount: up === undefined || up === null ? 0 : Array.isArray(up) ? up.length : up.presets.length,
    scheduleRules: doc.data.scheduleRules?.length ?? 0,
    envKeyRefs,
    missingKeys,
  }
}
