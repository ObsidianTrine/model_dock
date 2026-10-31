import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { fakeHome } from './helpers.js'
import { emptyConfig } from '../src/config/types.js'
import { saveConfig } from '../src/config/store.js'
import { setSecret } from '../src/config/secrets.js'
import { cmdAttach, type AttachFlags } from '../src/cli/harness.js'
import { buildProgram } from '../src/cli/index.js'

// attach --port（CLI 旗标）：显式端口透传 planAttach.gatewayPort，跳过 resolveClientGatewayPort
// 的 8687 探测启发式（多实例语义见 attach-port.test.ts 与 ops.ts 注释）。此前只有内部 API 能显式
// 传端口——attach-cli.test.ts 头注释记载「cmdAttach 全链路在开发机不可测（探测触 8687 红线）」，
// 本 flag 补上口子：显式端口让 CLI 全链路在沙箱可跑且全程不触 8687。这里就跑全链路。
// 本文件刻意不用 vi.mock（跨文件 mock 雷区，isolate:false）。

/** 最小可接入种子：file 密钥后端 + 一个 openai provider/profile + dsh home（web profile） */
async function seedAttachable(home: string): Promise<void> {
  const cfg = emptyConfig()
  cfg.security = { store: 'file' }
  cfg.providers['pv'] = {
    name: 'pv',
    base_url: 'http://127.0.0.1:9/v1',
    protocol: 'openai',
    auth_style: 'bearer',
    key_ref: 'file:pv',
    models: { m1: { source: 'manual', context_window: 8192, max_output: 4096 } },
  }
  cfg.profiles['p1'] = { name: 'p1', provider: 'pv', default_model: 'm1' }
  cfg.active_profile = 'p1'
  await saveConfig(cfg)
  await setSecret('pv', 'sk-test-pv', 'file')
  const webDir = path.join(home, '.dsh', 'profiles', 'web')
  fs.mkdirSync(webDir, { recursive: true })
  fs.writeFileSync(path.join(webDir, 'cordis.patch.yml'), '[]\n')
}

describe('attach --port 显式网关端口（CLI 旗标）', () => {
  it('选项已注册：--port <n>，说明双语文案非空', () => {
    const prog = buildProgram()
    const attach = prog.commands.find((cmd) => cmd.name() === 'attach')
    expect(attach, 'attach 子命令应存在').toBeTruthy()
    const opt = attach!.options.find((o) => o.long === '--port')
    expect(opt, '--port 应注册').toBeTruthy()
    expect(opt!.description.trim().length).toBeGreaterThan(0)
  })

  it('全链路：--port 18903 写入的 baseURL 指向 18903（不进 8687 探测）', async () => {
    const h = fakeHome()
    try {
      await seedAttachable(h.home)
      const flags: AttachFlags = { mode: 'gateway', yes: true, port: '18903' }
      await cmdAttach('dsh', flags)

      const patchPath = path.join(h.home, '.dsh', 'profiles', 'web', 'cordis.patch.yml')
      const js = parse(fs.readFileSync(patchPath, 'utf8')) as any[]
      const root = Array.isArray(js) ? js.find((e) => e?.id === 'llm-pi-ai') : undefined
      expect(root, 'patch 应含 llm-pi-ai 条目').toBeTruthy()
      const md = root?.config?.providers?.modeldock
      expect(md, 'llm-pi-ai 下应有 modeldock provider').toBeTruthy()
      expect(md.baseURL).toBe('http://127.0.0.1:18903/v1')
      expect(md.apiKeyEnv).toBe('MODELDOCK_TOKEN')

      const creds = parse(fs.readFileSync(path.join(h.home, '.dsh', '.credentials.yaml'), 'utf8')) as any
      expect(typeof creds?.refs?.MODELDOCK_TOKEN).toBe('string')
      expect(creds.refs.MODELDOCK_TOKEN.length).toBeGreaterThan(0)
    } finally {
      h.restore()
    }
  })
})
