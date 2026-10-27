/** dsh 导入源（旧 ~/.dsh/settings.yaml + 新 profiles/<名称>/cordis.patch.yml，凭据在 .credentials.yaml refs） */
import path from 'node:path'
import { readTextIfExists, slugify } from '../../util/index.js'
import { t } from '../../util/i18n.js'
import { credFile, dshLayout, providersOf } from '../../adapters/dsh.js'
import { parseDocument } from 'yaml'
import { isLocalBaseUrl, placeholder, type ImportCandidate } from './common.js'
import type { Protocol } from '../../config/types.js'

export async function scanDsh(): Promise<ImportCandidate[]> {
  // 两种布局：旧 ~/.dsh/settings.yaml，新版 profiles/<名称>/cordis.patch.yml（settings.yaml 被 dsh 迁移改名后即为后者）
  const layout = await dshLayout()
  const files: { file: string; kind: 'legacy' | 'patch' }[] = []
  if (layout.legacyExists) files.push({ file: layout.legacyFile, kind: 'legacy' })
  for (const f of layout.patchFiles) files.push({ file: f, kind: 'patch' })
  if (files.length === 0) return []

  const credsText = await readTextIfExists(credFile())
  let refs: Record<string, string> = {}
  if (credsText) {
    try {
      refs = (parseDocument(credsText).toJS() as any)?.refs ?? {}
    } catch {
      /* refs 读不到就只导入 url */
    }
  }
  const out: ImportCandidate[] = []
  const seen = new Set<string>()
  for (const { file, kind } of files) {
    let js: any
    try {
      js = parseDocument((await readTextIfExists(file)) ?? '').toJS()
    } catch {
      out.push(placeholder('dsh', t('{file} 存在但解析失败（YAML 语法错误），无法读取', '{file} exists but failed to parse (YAML syntax error); cannot read it', { file: path.basename(file) })))
      continue
    }
    const providers = providersOf(js, kind) ?? {}
    for (const [id, raw] of Object.entries<any>(providers)) {
      if (seen.has(id)) continue
      seen.add(id)
      const base = raw?.baseURL
      if (typeof base !== 'string' || base === '') continue
      if (isLocalBaseUrl(base)) continue // 已指向本地网关（如 modeldock attach 过），无需导入
      const protocol: Protocol = raw?.api === 'openai-completions' ? 'openai' : 'anthropic'
      const envName = typeof raw?.apiKeyEnv === 'string' ? raw.apiKeyEnv : undefined
      const key = envName ? (refs[envName] ?? null) : null
      out.push({
        source: 'dsh',
        suggest_id: `dsh-${slugify(id)}`,
        name: `dsh · ${id}`,
        base_url: base,
        protocol,
        auth_style: 'bearer',
        key,
        key_note: envName ? t('来自 .credentials.yaml refs.{env}', 'From .credentials.yaml refs.{env}', { env: envName }) : undefined,
        // 旧布局 models 为字符串数组；新布局为 {id, name, ...} 对象数组
        models: Array.isArray(raw?.models)
          ? raw.models
              .map((m: any) => (typeof m === 'string' ? m : typeof m?.id === 'string' ? m.id : null))
              .filter((x: any): x is string => typeof x === 'string')
          : undefined,
      })
    }
  }
  return out
}
