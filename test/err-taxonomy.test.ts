import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { fakeHome, REPO_ROOT, TSX_LOADER } from './helpers.js'
import { errorReply } from '../src/gateway/server.js'
import { ConfigError } from '../src/config/store.js'
import { SecretsError } from '../src/config/secrets.js'
import { AdapterError } from '../src/adapters/types.js'
import { UpstreamError } from '../src/gateway/relay.js'
import { UpdateError } from '../src/update/check.js'

// 错误类型体系统一（专家审查方案 P0-2）回归：
// ① 五类业务错误经网关 errorReply 映射出正确 status/hint；
// ② CLI 顶层 catch 对带 hint 的业务错误输出「✗ message + 提示: hint」两行（真实 CLI 子进程 + 独立沙箱，
//    配方与 test/reset.test.ts 一致：tsx loader + MODELRDOCK_FAKE_HOME，进程内零 mock，不踩共享注册表）。

describe('errorReply：业务错误类 → status/hint 映射', () => {
  it('ConfigError → 400 + hint', () => {
    expect(errorReply(new ConfigError('配置坏了', '运行 modeldock config edit 修复'))).toEqual({
      status: 400,
      message: '配置坏了',
      hint: '运行 modeldock config edit 修复',
    })
  })

  it('SecretsError → 400 + hint', () => {
    expect(errorReply(new SecretsError('密钥库损坏', '请备份后重新设置各密钥'))).toEqual({
      status: 400,
      message: '密钥库损坏',
      hint: '请备份后重新设置各密钥',
    })
  })

  it('AdapterError → 400 + hint', () => {
    expect(errorReply(new AdapterError('未找到 claude 命令', '请先安装 Claude Code 后再接入'))).toEqual({
      status: 400,
      message: '未找到 claude 命令',
      hint: '请先安装 Claude Code 后再接入',
    })
  })

  it('UpdateError → 500 + hint', () => {
    expect(errorReply(new UpdateError('GitHub API 返回 502', '稍后重试'))).toEqual({
      status: 500,
      message: 'GitHub API 返回 502',
      hint: '稍后重试',
    })
  })

  it('UpstreamError 保持 status 数值透出（如 413）并带 hint', () => {
    expect(errorReply(new UpstreamError(413, '请求体超限', '在 config.toml [gateway] 设置 max_body_mb'))).toEqual({
      status: 413,
      message: '请求体超限',
      hint: '在 config.toml [gateway] 设置 max_body_mb',
    })
  })

  it('不带 hint 的业务错误：hint 为 undefined，不产生「提示」形状', () => {
    expect(errorReply(new ConfigError('缺字段'))).toEqual({ status: 400, message: '缺字段', hint: undefined })
    expect(errorReply(new SecretsError('锁超时'))).toEqual({ status: 400, message: '锁超时', hint: undefined })
    expect(errorReply(new AdapterError('pack 无效'))).toEqual({ status: 400, message: 'pack 无效', hint: undefined })
    expect(errorReply(new UpdateError('下载失败'))).toEqual({ status: 500, message: '下载失败', hint: undefined })
  })

  it('裸 Error 带数值 status：按原状态透出（不吞成 500）', () => {
    expect(errorReply(Object.assign(new Error('too large'), { status: 413 }))).toEqual({
      status: 413,
      message: 'too large',
    })
  })

  it('未知错误 → 500「网关内部错误」，且裸 Error 上的 hint 不再被 duck 读逃逸', () => {
    const r = errorReply(new Error('boom'))
    expect(r.status).toBe(500)
    expect(r.message).toContain('网关内部错误')
    expect(r.message).toContain('boom')
    expect(r.hint).toBeUndefined()
    // duck-typing 逃逸口已移除：裸 Error 挂 hint 不再影响映射
    const r2 = errorReply(Object.assign(new Error('boom'), { hint: '假的提示' }))
    expect(r2.status).toBe(500)
    expect(r2.hint).toBeUndefined()
    // 非 Error 值也不炸
    expect(errorReply('plain string').status).toBe(500)
  })
})

describe('CLI 顶层出口：带 hint 的业务错误输出两行（真实子进程）', () => {
  const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli.ts')

  it('config.toml 解析失败（ConfigError 带 hint）：✗ message 与 提示: hint 分行透出，退出码 1', () => {
    const h = fakeHome()
    try {
      // 造一份解析必炸的 config.toml（未闭合的表头）
      fs.mkdirSync(path.join(h.home, '.modeldock'), { recursive: true })
      fs.writeFileSync(path.join(h.home, '.modeldock', 'config.toml'), 'version = 1\n[providers\n', 'utf8')

      const env = { ...process.env, MODELRDOCK_FAKE_HOME: h.home, MODELRDOCK_LANG: 'zh' }
      delete env.MODELRDOCK_HOME
      const r = spawnSync(process.execPath, ['--import', TSX_LOADER, CLI_ENTRY, 'provider', 'list'], {
        cwd: h.home,
        env,
        encoding: 'utf8',
        timeout: 120_000,
      })
      const output = `${r.stdout ?? ''}${r.stderr ?? ''}`
      const lines = output.split(/\r?\n/)

      expect(r.status, output).toBe(1)
      const errLine = lines.find((l) => l.startsWith('✗'))
      const hintLine = lines.find((l) => l.startsWith('提示: '))
      expect(errLine, output).toBeTruthy()
      expect(errLine).toContain('config.toml 解析失败')
      expect(errLine).not.toContain('config edit') // 建议已挪进 hint，message 保持简洁
      expect(hintLine, output).toBeTruthy()
      expect(hintLine).toContain('modeldock config edit')
      expect(hintLine).toContain('modeldock restore')
    } finally {
      h.restore()
    }
  })
})
