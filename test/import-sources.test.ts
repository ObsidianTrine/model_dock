import { describe, expect, it } from 'vitest'
import { dedupeCandidates, scanSources, type ImportCandidate } from '../src/import/sources.js'

/** 只补 import-scan.test.ts 没覆盖的部分：迁移导入的按地址去重，以及 scanSources 的入参守卫。
 *
 *  两个坑别再踩：
 *  ① scanSources(source: ImportSource | 'all') 收的是**单个源名**，不是数组——传 [] 只会
 *     因为「什么都不匹配」返回空数组，看着绿其实什么都没测；
 *  ② ImportSource 是字符串联合类型（'claude' | 'dsh' | …），不是带 id/name 的对象，
 *     照对象构造出来的「类型结构正确」用例纯属自证。
 *  normalizeBaseUrl / isLocalBaseUrl / stripApiEndpoint / applyImport 已在 import-scan.test.ts
 *  用真实扫描数据覆盖，此处不重复。 */

function cand(over: Partial<ImportCandidate> = {}): ImportCandidate {
  return {
    source: 'claude',
    suggest_id: 'p',
    name: 'P',
    base_url: 'https://api.example.com/v1',
    protocol: 'openai',
    auth_style: 'bearer',
    key: null,
    ...over,
  }
}

describe('import sources · dedupeCandidates（同一服务只导一条）', () => {
  it('同地址不同写法（尾斜杠 / 主机大小写）合并为一条', () => {
    const out = dedupeCandidates([
      cand({ suggest_id: 'a', base_url: 'https://API.Example.com/v1/' }),
      cand({ suggest_id: 'b', base_url: 'https://api.example.com/v1' }),
    ])
    expect(out.map((c) => c.suggest_id)).toEqual(['a'])
  })

  it('同地址保留「使用中」的那条，且与出现顺序无关', () => {
    const older = cand({ suggest_id: 'old' })
    const current = cand({ suggest_id: 'cur', is_current: true })
    expect(dedupeCandidates([older, current]).map((c) => c.suggest_id)).toEqual(['cur'])
    expect(dedupeCandidates([current, older]).map((c) => c.suggest_id)).toEqual(['cur'])
  })

  it('同地址不同 key 也只留一条（迁移时同地址多为同一配置的历史 key，多账号请导入后另加服务）', () => {
    const out = dedupeCandidates([
      cand({ suggest_id: 'k1', key: 'sk-1' }),
      cand({ suggest_id: 'k2', key: 'sk-2' }),
    ])
    expect(out).toHaveLength(1)
  })

  it('不同地址全部保留（含端口/路径差异）', () => {
    const out = dedupeCandidates([
      cand({ suggest_id: 'a', base_url: 'https://api.example.com/v1' }),
      cand({ suggest_id: 'b', base_url: 'https://api.example.com/v2' }),
      cand({ suggest_id: 'c', base_url: 'http://api.example.com:8080/v1' }),
    ])
    expect(out).toHaveLength(3)
  })

  it('带 skip_reason 的占位诊断项（无地址）不参与去重、不被丢弃', () => {
    const diag = cand({ suggest_id: 'diag', base_url: '', skip_reason: '本机无 sqlite3' })
    const out = dedupeCandidates([diag, cand({ suggest_id: 'a' }), cand({ suggest_id: 'a' })])
    expect(out.map((c) => c.suggest_id)).toEqual(['a', 'diag'])
  })

  it('无地址也无 skip_reason 的条目直接丢弃（没有 base_url 无法落库）', () => {
    expect(dedupeCandidates([cand({ base_url: '' })])).toEqual([])
  })
})

describe('import sources · scanSources 入参守卫', () => {
  it('oneapi 缺站点凭据 → 可操作报错（提示 --url / --token），不静默返回空列表', async () => {
    await expect(scanSources('oneapi')).rejects.toThrow(/--url/)
    await expect(scanSources('oneapi')).rejects.toThrow(/--token/)
  })
})
