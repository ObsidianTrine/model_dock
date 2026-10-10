import fs from 'node:fs'
import type { AuthStyle, ModelMeta, Protocol } from '../config/types.js'
import { presetsJsonPath } from '../util/paths.js'
import { t, type Bilingual } from '../util/i18n.js'

export interface PresetModel {
  id: string
  display_name?: string
  context_window?: number
  max_output?: number
  capabilities?: string[]
}

export interface ProviderPreset {
  id: string
  label: string
  vendor: string
  base_url: string
  protocol: Protocol
  auth_style: AuthStyle
  docs_url?: string
  /** 国外上游，默认建议走环境代理 */
  needs_proxy?: boolean
  /** 该厂商支持的其他协议端点（默认协议见 base_url/protocol；如 anthropic 厂商同时提供 openai /v1 地址） */
  endpoints?: Partial<Record<Protocol, string>>
  /** 内置模型目录（已知经典模型；未收录的靠自动拉取/手动补） */
  models?: PresetModel[]
}

function m(
  id: string,
  context_window?: number,
  max_output?: number,
  capabilities?: string[],
  display_name?: string | Bilingual
): PresetModel {
  if (display_name === undefined || typeof display_name === 'string') {
    return { id, context_window, max_output, capabilities, display_name }
  }
  return { id, context_window, max_output, capabilities, get display_name() { return t(display_name.zh, display_name.en) } }
}

const TOOLS = ['tools']
const TOOLS_REASON = ['tools', 'reasoning']
const TOOLS_REASON_VISION = ['tools', 'reasoning', 'vision']
const TOOLS_VISION = ['tools', 'vision']
/** 只有展示名、无可靠上下文/输出元数据的模型（如 plan 套餐清单，档位不同权益不同，留空由用户补）。
 *  display 传 Bilingual 时经 getter 懒求值（展示在 UI/CLI 时按当前语言渲染，模块加载期不固化语言） */
function md(id: string, display?: string | Bilingual): PresetModel {
  if (display === undefined) return { id }
  if (typeof display === 'string') return { id, display_name: display }
  return { id, get display_name() { return t(display.zh, display.en) } }
}

/**
 * 火山方舟 Coding / Agent Plan 共用模型清单（2026-10 官方套餐概览；output_name 经用户 team 账号实测核对）。
 * 上下文/最大输出为官方公布值；auto（智能调度）与 doubao-seed-2-0-lite（官方未公布长度）维持 md() 留空。
 * output_name 随版本换代（日期后缀变化），旧 id 形态在 known.ts 同值收录，保证存量配置展示兜底。
 */
const ARK_PLAN_MODELS: PresetModel[] = [
  md('auto', { zh: 'auto（智能调度，无固定限额）', en: 'auto (smart routing, no fixed limits)' }),
  m('doubao-seed-evolving', 1048576, 262144, TOOLS_REASON, { zh: 'doubao-seed-evolving（Coding/Agent，周级升级）', en: 'doubao-seed-evolving (coding/agent, weekly updates)' }),
  m('doubao-seed-2-1-pro-260915', 1048576, 262144, TOOLS_REASON, 'doubao-seed-2-1-pro'),
  m('doubao-seed-2-1-lite-260915', 1048576, 262144, TOOLS_REASON, 'doubao-seed-2-1-lite'),
  m('doubao-seed-2-0-mini-260428', 262144, 131072, TOOLS_REASON, { zh: 'doubao-seed-2-0-mini（极速）', en: 'doubao-seed-2-0-mini (turbo)' }),
  m('doubao-seed-2-1-turbo-260628', 262144, 65536, TOOLS_REASON_VISION, { zh: 'doubao-seed-2-1-turbo（即将下线）', en: 'doubao-seed-2-1-turbo (retiring)' }),
  md('doubao-seed-2-0-lite-260215', { zh: 'doubao-seed-2.0-lite（即将下线，官方未公布长度）', en: 'doubao-seed-2.0-lite (retiring; no official limits)' }),
  m('minimax-m3', 1048576, 131072, TOOLS_REASON_VISION, 'minimax-m3'),
  m('kimi-k2.7-code', 262144, 32768, TOOLS_REASON_VISION, 'kimi-k2.7-code'),
  m('kimi-k2-8-preview', 1048576, 1048576, TOOLS_REASON, 'kimi-k2-8-preview'),
  m('kimi-k3', 1048576, 131072, TOOLS_REASON_VISION, { zh: 'kimi-k3（1M 上下文+视觉）', en: 'kimi-k3 (1M context + vision)' }),
  m('glm-5.3', 1048576, 131072, TOOLS_REASON, { zh: 'glm-5.3（1M 上下文）', en: 'glm-5.3 (1M context)' }),
  m('glm-5-3-flash-260828', 1048576, 131072, TOOLS_REASON_VISION, 'glm-5-3-flash'),
  m('deepseek-v4-flash-ga-260731', 1048576, 393216, TOOLS_REASON, 'deepseek-v4-flash'),
  m('deepseek-v4-pro-ga-260813', 1048576, 393216, TOOLS_REASON, 'deepseek-v4-pro'),
  m('deepseek-v4-1-flash-260910', 1048576, 393216, TOOLS_REASON_VISION, 'deepseek-v4-1-flash'),
]

/**
 * 内置预设。模型元数据为已知经典模型的保守默认值，用户可随时修改。
 * 各厂商现行清单核对于 2026-10（官方文档/定价页）：DeepSeek=deepseek-flash + deepseek-v4-pro（chat/reasoner 已下线）、
 * OpenAI=GPT-5.1 系、Anthropic=Claude 5.5 系（1M/128K）、Kimi=kimi-k3 系（k2 及更早已退役）、智谱=GLM-5.3 系。
 * 火山方舟 plan 套餐的模型清单走 OpenAPI（ListArkAgentPlanModel/ListArkCodingPlanModel，仅支持 AK/SK 签名），
 * Ark API Key 拉不了 /v1/models（404），故内置套餐已知模型表供拉取失败时兜底（2026-10 官方清单，见 ARK_PLAN_MODELS）。
 */
const BUILTIN_PRESETS: ProviderPreset[] = [
  {
    id: 'custom',
    get label() { return t('自定义', 'Custom') },
    get vendor() { return t('自定义', 'Custom') },
    base_url: '',
    protocol: 'openai',
    auth_style: 'bearer',
    docs_url: 'https://platform.openai.com/docs/api-reference/making-requests',
  },
  {
    id: 'ark-coding-plan',
    get label() { return t('火山方舟 · Coding Plan', 'Volcengine Ark · Coding Plan') },
    get vendor() { return t('火山引擎', 'Volcengine') },
    base_url: 'https://ark.cn-beijing.volces.com/api/coding',
    protocol: 'anthropic',
    auth_style: 'bearer',
    docs_url: 'https://www.volcengine.com/docs/82379',
    endpoints: { openai: 'https://ark.cn-beijing.volces.com/api/coding/v3', responses: 'https://ark.cn-beijing.volces.com/api/coding/v3' },
    models: ARK_PLAN_MODELS,
  },
  {
    id: 'ark-agent-plan',
    get label() { return t('火山方舟 · Agent Plan', 'Volcengine Ark · Agent Plan') },
    get vendor() { return t('火山引擎', 'Volcengine') },
    base_url: 'https://ark.cn-beijing.volces.com/api/plan',
    protocol: 'anthropic',
    auth_style: 'bearer',
    docs_url: 'https://www.volcengine.com/docs/82379',
    endpoints: { openai: 'https://ark.cn-beijing.volces.com/api/plan/v3', responses: 'https://ark.cn-beijing.volces.com/api/plan/v3' },
    models: ARK_PLAN_MODELS,
  },
  {
    id: 'deepseek-anthropic',
    // 主预设不带协议后缀（同 bigmodel-anthropic 先例）：预设自带三协议端点，名字标协议反而误导
    get label() { return t('DeepSeek', 'DeepSeek') },
    vendor: 'DeepSeek',
    base_url: 'https://api.deepseek.com/anthropic',
    protocol: 'anthropic',
    endpoints: { openai: 'https://api.deepseek.com', responses: 'https://api.deepseek.com' },
    auth_style: 'bearer',
    docs_url: 'https://api-docs.deepseek.com/guides/anthropic_api',
    models: [
      // 2026-10 核对：deepseek-chat/reasoner 已下线，现行 = deepseek-flash（V4.1-Flash，多模态）+ deepseek-v4-pro
      m('deepseek-flash', 1048576, 393216, TOOLS_REASON_VISION, 'DeepSeek Flash（V4.1）'),
      m('deepseek-v4-pro', 1048576, 393216, TOOLS_REASON, 'DeepSeek V4 Pro'),
    ],
  },
  {
    id: 'deepseek-openai',
    get label() { return t('DeepSeek（OpenAI 兼容）', 'DeepSeek (OpenAI-compatible)') },
    vendor: 'DeepSeek',
    base_url: 'https://api.deepseek.com',
    protocol: 'openai',
    auth_style: 'bearer',
    docs_url: 'https://api-docs.deepseek.com',
    endpoints: { responses: 'https://api.deepseek.com' },
    models: [
      m('deepseek-flash', 1048576, 393216, TOOLS_REASON_VISION, 'DeepSeek Flash（V4.1）'),
      m('deepseek-v4-pro', 1048576, 393216, TOOLS_REASON, 'DeepSeek V4 Pro'),
    ],
  },
  {
    id: 'bigmodel-anthropic',
    get label() { return t('智谱 GLM · bigmodel', 'Zhipu GLM · bigmodel') },
    get vendor() { return t('智谱', 'Zhipu') },
    base_url: 'https://open.bigmodel.cn/api/anthropic',
    protocol: 'anthropic',
    endpoints: { openai: 'https://open.bigmodel.cn/api/paas/v4' },
    auth_style: 'bearer',
    docs_url: 'https://docs.bigmodel.cn/cn/guide/develop/claude/introduction.md',
    models: [
      m('glm-5.3', 1048576, 131072, TOOLS_REASON, { zh: 'GLM-5.3（旗舰）', en: 'GLM-5.3 (flagship)' }),
      m('glm-5.3-flash', 1048576, 131072, TOOLS_VISION, 'GLM-5.3-Flash'),
      m('glm-5.3-flashx', 1048576, 131072, TOOLS_VISION, 'GLM-5.3-FlashX'),
    ],
  },
  {
    id: 'bigmodel-openai',
    get label() { return t('智谱 GLM · bigmodel（OpenAI 兼容）', 'Zhipu GLM · bigmodel (OpenAI-compatible)') },
    get vendor() { return t('智谱', 'Zhipu') },
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'openai',
    auth_style: 'bearer',
    docs_url: 'https://docs.bigmodel.cn',
    models: [
      m('glm-5.3', 1048576, 131072, TOOLS_REASON, { zh: 'GLM-5.3（旗舰）', en: 'GLM-5.3 (flagship)' }),
      m('glm-5.3-flash', 1048576, 131072, TOOLS_VISION, 'GLM-5.3-Flash'),
      m('glm-5.3-flashx', 1048576, 131072, TOOLS_VISION, 'GLM-5.3-FlashX'),
    ],
  },
  {
    id: 'zai-anthropic',
    get label() { return t('智谱 z.ai', 'Zhipu z.ai') },
    get vendor() { return t('智谱', 'Zhipu') },
    base_url: 'https://api.z.ai/api/anthropic',
    protocol: 'anthropic',
    endpoints: { openai: 'https://api.z.ai/api/paas/v4' },
    auth_style: 'bearer',
    docs_url: 'https://docs.z.ai',
    models: [
      m('glm-5.3', 1048576, 131072, TOOLS_REASON, { zh: 'GLM-5.3（旗舰）', en: 'GLM-5.3 (flagship)' }),
      m('glm-5.3-flash', 1048576, 131072, TOOLS_VISION, 'GLM-5.3-Flash'),
    ],
  },
  {
    id: 'kimi-openai-cn',
    get label() { return t('Kimi / Moonshot（国内 · OpenAI 兼容）', 'Kimi / Moonshot (CN · OpenAI-compatible)') },
    vendor: 'Moonshot',
    base_url: 'https://api.moonshot.cn/v1',
    protocol: 'openai',
    auth_style: 'bearer',
    docs_url: 'https://platform.moonshot.cn',
    endpoints: { responses: 'https://api.moonshot.cn/v1' },
    models: [
      // 2026-10 核对：k2 系全部退役（2026-05-25），现行 = kimi-k3 旗舰 + K2.7-Code + K2.6
      m('kimi-k3', 1048576, 1048576, TOOLS_REASON_VISION, { zh: 'Kimi K3（旗舰）', en: 'Kimi K3 (flagship)' }),
      m('kimi-k2.7-code', 262144, undefined, TOOLS, 'Kimi K2.7 Code'),
      m('kimi-k2.7-code-highspeed', undefined, undefined, TOOLS, 'Kimi K2.7 Code Highspeed'),
      m('kimi-k2.6', 262144, undefined, TOOLS_VISION, 'Kimi K2.6'),
    ],
  },
  {
    id: 'kimi-anthropic-cn',
    get label() { return t('Kimi / Moonshot（国内）', 'Kimi / Moonshot (CN)') },
    vendor: 'Moonshot',
    base_url: 'https://api.moonshot.cn/anthropic',
    protocol: 'anthropic',
    endpoints: { openai: 'https://api.moonshot.cn/v1', responses: 'https://api.moonshot.cn/v1' },
    auth_style: 'bearer',
    docs_url: 'https://platform.moonshot.cn',
    models: [
      m('kimi-k3', 1048576, 1048576, TOOLS_REASON_VISION, { zh: 'Kimi K3（旗舰）', en: 'Kimi K3 (flagship)' }),
      m('kimi-k2.7-code', 262144, undefined, TOOLS, 'Kimi K2.7 Code'),
      m('kimi-k2.6', 262144, undefined, TOOLS_VISION, 'Kimi K2.6'),
    ],
  },
  {
    id: 'kimi-anthropic-global',
    get label() { return t('Kimi / Moonshot（国际）', 'Kimi / Moonshot (Global)') },
    vendor: 'Moonshot',
    base_url: 'https://api.moonshot.ai/anthropic',
    protocol: 'anthropic',
    endpoints: { openai: 'https://api.moonshot.ai/v1', responses: 'https://api.moonshot.ai/v1' },
    auth_style: 'bearer',
    needs_proxy: true,
    docs_url: 'https://platform.kimi.ai',
    models: [
      m('kimi-k3', 1048576, 1048576, TOOLS_REASON_VISION, { zh: 'Kimi K3（旗舰）', en: 'Kimi K3 (flagship)' }),
      m('kimi-k2.7-code', 262144, undefined, TOOLS, 'Kimi K2.7 Code'),
      m('kimi-k2.6', 262144, undefined, TOOLS_VISION, 'Kimi K2.6'),
    ],
  },
  {
    id: 'mimo-token-plan-cn',
    get label() { return t('小米 MiMo · Token Plan', 'Xiaomi MiMo · Token Plan') },
    get vendor() { return t('小米', 'Xiaomi') },
    base_url: 'https://token-plan-cn.xiaomimimo.com/anthropic',
    protocol: 'anthropic',
    endpoints: { openai: 'https://token-plan-cn.xiaomimimo.com/v1', responses: 'https://token-plan-cn.xiaomimimo.com/v1' },
    auth_style: 'bearer',
  },
  {
    id: 'mimo-api',
    get label() { return t('小米 MiMo（普通 API）', 'Xiaomi MiMo (standard API)') },
    get vendor() { return t('小米', 'Xiaomi') },
    base_url: 'https://api.xiaomimimo.com/anthropic',
    protocol: 'anthropic',
    endpoints: { openai: 'https://api.xiaomimimo.com/v1', responses: 'https://api.xiaomimimo.com/v1' },
    auth_style: 'bearer',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    vendor: 'OpenAI',
    base_url: 'https://api.openai.com/v1',
    protocol: 'openai',
    auth_style: 'bearer',
    needs_proxy: true,
    docs_url: 'https://platform.openai.com/docs',
    endpoints: { responses: 'https://api.openai.com/v1' },
    models: [
      // 2026-10 二次核对（官方模型页）：GPT-6 代已上线（Astra 旗舰 / Sol 编程智能体性价比款），GPT-5.1 系已属上代
      m('gpt-6-sol', 1050000, 128000, TOOLS_REASON_VISION, { zh: 'GPT-6 Sol（编程/智能体）', en: 'GPT-6 Sol (coding/agentic)' }),
      m('gpt-6-astra', 1050000, 128000, TOOLS_REASON_VISION, { zh: 'GPT-6 Astra（旗舰）', en: 'GPT-6 Astra (flagship)' }),
      m('gpt-5.5', 1000000, 128000, TOOLS_REASON_VISION, 'GPT-5.5'),
    ],
  },
  {
    id: 'anthropic',
    get label() { return t('Anthropic 官方', 'Anthropic (official)') },
    vendor: 'Anthropic',
    base_url: 'https://api.anthropic.com',
    protocol: 'anthropic',
    auth_style: 'x-api-key',
    needs_proxy: true,
    docs_url: 'https://docs.anthropic.com',
    models: [
      // 2026-10 二次核对（官方文档）：Claude 5.5 系 + Fable 5.1（最强）；无日期后缀的新版 id；1M 上下文 / 128K 输出
      m('claude-sonnet-5-5', 1048576, 128000, TOOLS_REASON_VISION, 'Claude Sonnet 5.5'),
      m('claude-opus-5-5', 1048576, 128000, TOOLS_REASON_VISION, 'Claude Opus 5.5'),
      m('claude-fable-5-1', 1048576, 128000, TOOLS_REASON_VISION, { zh: 'Claude Fable 5.1（最强）', en: 'Claude Fable 5.1 (strongest)' }),
      m('claude-haiku-4-5', 204800, 64000, TOOLS_REASON_VISION, { zh: 'Claude Haiku 4.5（轻量）', en: 'Claude Haiku 4.5 (light)' }),
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    vendor: 'OpenRouter',
    base_url: 'https://openrouter.ai/api/v1',
    protocol: 'openai',
    auth_style: 'bearer',
    needs_proxy: true,
    docs_url: 'https://openrouter.ai/docs',
  },
  {
    id: 'groq',
    label: 'Groq',
    vendor: 'Groq',
    base_url: 'https://api.groq.com/openai/v1',
    protocol: 'openai',
    auth_style: 'bearer',
    needs_proxy: true,
    docs_url: 'https://console.groq.com/docs',
  },
  {
    id: 'siliconflow',
    get label() { return t('SiliconFlow 硅基流动', 'SiliconFlow') },
    vendor: 'SiliconFlow',
    base_url: 'https://api.siliconflow.cn/v1',
    protocol: 'openai',
    auth_style: 'bearer',
    docs_url: 'https://docs.siliconflow.cn',
  },
  {
    id: 'dashscope-openai',
    get label() { return t('阿里云百炼 DashScope', 'Alibaba Cloud DashScope') },
    get vendor() { return t('阿里云', 'Alibaba Cloud') },
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    protocol: 'openai',
    auth_style: 'bearer',
    docs_url: 'https://help.aliyun.com/zh/dashscope/',
  },
  {
    id: 'gemini-openai',
    label: 'Google Gemini',
    vendor: 'Google',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    protocol: 'openai',
    auth_style: 'bearer',
    needs_proxy: true,
    docs_url: 'https://ai.google.dev',
  },
]

// ─── 运行时预设 = 内置库 + 用户自定义覆盖（~/.modeldock/presets.json） ───────
// 扩展性入口：把公司内部网关/模型注册成"一等公民"预设，只需在配置目录写一个
// presets.json。同名 id 的自定义条目覆盖内置预设；新 id 追加。改动后重启网关生效
// （长驻进程内可直接调用 reloadPresets()）。文件缺失视为无自定义；格式错误则抛可操作报错。

export const PRESETS: ProviderPreset[] = []

/** 合并规则：用户同名 id 覆盖内置，其余内置保留，用户新 id 按文件顺序追加 */
export function applyUserPresets(user: ProviderPreset[]): ProviderPreset[] {
  const out: ProviderPreset[] = []
  if (!user.length) {
    out.push(...BUILTIN_PRESETS)
    return out
  }
  const over = new Map(user.map((p) => [p.id, p]))
  for (const p of BUILTIN_PRESETS) if (!over.has(p.id)) out.push(p)
  for (const p of user) out.push(p)
  return out
}

function userPresetsPath(): string {
  return presetsJsonPath()
}

/** 读用户自定义预设文件，逐条校验；文件不存在返回 []，格式错误抛可操作报错 */
export function readUserPresets(): ProviderPreset[] {
  const fp = userPresetsPath()
  let text: string
  try {
    text = fs.readFileSync(fp, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw new Error(t('读取自定义预设 {file} 失败：{err}', 'Failed to read the custom presets file {file}: {err}', { file: fp, err: (e as Error).message }))
  }
  const PROTOCOLS: Protocol[] = ['anthropic', 'openai', 'responses']
  const AUTH: AuthStyle[] = ['bearer', 'x-api-key']
  let arr: unknown
  try {
    const doc: unknown = JSON.parse(text)
    arr =
      Array.isArray(doc)
        ? doc
        : typeof doc === 'object' && doc !== null && Array.isArray((doc as Record<string, unknown>).presets)
          ? (doc as Record<string, unknown>).presets
          : null
    if (arr === null) {
      throw new Error(t('顶层应为数组，或 { "presets": [...] }', 'The top level must be an array, or { "presets": [...] }'))
    }
  } catch (e) {
    throw new Error(
      t(
        '自定义预设 {file} 格式错误：{err}（修复后重启网关即可）',
        'Invalid format in the custom presets file {file}: {err} (fix it and restart the gateway)',
        { file: fp, err: (e as Error).message }
      )
    )
  }
  return (arr as unknown[]).map((raw, i) => {
    const o = (raw ?? {}) as Record<string, unknown>
    const id = String(o.id ?? '').trim()
    if (!id) {
      throw new Error(
        t('自定义预设 {file} 第 {n} 条缺少 id', 'Entry {n} in the custom presets file {file} is missing id', { file: fp, n: i + 1 })
      )
    }
    const protocol = (PROTOCOLS as string[]).includes(String(o.protocol)) ? (o.protocol as Protocol) : 'openai'
    const auth_style = (AUTH as string[]).includes(String(o.auth_style)) ? (o.auth_style as AuthStyle) : 'bearer'
    const endpoints: ProviderPreset['endpoints'] = {}
    if (o.endpoints && typeof o.endpoints === 'object') {
      for (const [k, v] of Object.entries(o.endpoints as Record<string, unknown>)) {
        if ((PROTOCOLS as string[]).includes(k) && typeof v === 'string' && v.trim()) endpoints[k as Protocol] = v.trim()
      }
    }
    const models: PresetModel[] | undefined = Array.isArray(o.models)
      ? (o.models as unknown[])
          .map((m) => {
            const mo = (m ?? {}) as Record<string, unknown>
            const mid = String(mo.id ?? '').trim()
            if (!mid) {
              throw new Error(
                t(
                  '自定义预设 {file}「{id}」中有缺失 id 的模型条目',
                  'Preset "{id}" in the custom presets file {file} has a model entry missing id',
                  { file: fp, id }
                )
              )
            }
            const pm: PresetModel = { id: mid }
            if (typeof mo.display_name === 'string') pm.display_name = mo.display_name
            if (typeof mo.context_window === 'number' && mo.context_window > 0 && !Number.isNaN(mo.context_window)) pm.context_window = mo.context_window
            if (typeof mo.max_output === 'number' && mo.max_output > 0 && !Number.isNaN(mo.max_output)) pm.max_output = mo.max_output
            if (Array.isArray(mo.capabilities)) pm.capabilities = mo.capabilities.map(String)
            return pm
          })
      : undefined
    const out: ProviderPreset = {
      id,
      label: String(o.label ?? id),
      vendor: String(o.vendor ?? id),
      base_url: String(o.base_url ?? '').trim(),
      protocol,
      auth_style,
      needs_proxy: o.needs_proxy === true,
      docs_url: typeof o.docs_url === 'string' && o.docs_url ? o.docs_url : undefined,
      endpoints: Object.keys(endpoints).length ? endpoints : undefined,
      models,
    }
    return out
  })
}

PRESETS.push(...applyUserPresets(readUserPresets()))

/** 重读用户自定义预设并合并进运行时列表（改文件后调用；正常使用无需——重启网关即生效） */
export function reloadPresets(): void {
  PRESETS.length = 0
  PRESETS.push(...applyUserPresets(readUserPresets()))
}

export function findPreset(id: string): ProviderPreset | undefined {
  return PRESETS.find((p) => p.id === id)
}

/** 预设模型表 → config 的模型目录初始数据 */
export function presetModels(preset: ProviderPreset): Record<string, ModelMeta> | undefined {
  if (!preset.models?.length) return undefined
  const out: Record<string, ModelMeta> = {}
  for (const pm of preset.models) {
    out[pm.id] = {
      display_name: pm.display_name,
      context_window: pm.context_window,
      max_output: pm.max_output,
      capabilities: pm.capabilities,
      source: 'preset',
    }
  }
  return out
}

/** 按 base_url 的 host 匹配预设，返回该厂商已知模型（含 display/context/max，source:'preset'），供拉取失败时兜底 */
export function knownModelsForBaseUrl(baseUrl: string): Record<string, ModelMeta> {
  let host = ''
  try { host = new URL(baseUrl).host } catch { return {} }
  const out: Record<string, ModelMeta> = {}
  for (const p of PRESETS) {
    let ph = ''
    try { ph = new URL(p.base_url).host } catch { continue }
    if (ph.toLowerCase() !== host.toLowerCase() || !p.models?.length) continue
    Object.assign(out, presetModels(p) ?? {})
  }
  return out
}
