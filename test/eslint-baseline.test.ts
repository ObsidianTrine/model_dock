import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

/**
 * ESLint 棘轮基线门禁：eslint-baseline.json 登记 src/** 每条规则的存量 warn 计数，
 * 只降不升——新增违规 = 本测试红，逼先修复；清掉存量后应顺手下调基线数字。
 * 基线文件格式 { "规则名": 违规数 }，规则集见 eslint.config.mjs（全 warn 级，退出码恒 0，
 * 因此本测试是唯一机器门禁）。
 *
 * 耗时动机：type-aware lint（projectService）全量 src 实测 Windows 本机约 34~45s
 * （2026-11-08，129 处 warn，冷/热 OS cache 有波动）；CI 冷启动 + npm cache 未热时更慢，
 * testTimeout 放宽到 180s 防误杀。本测试给 npm test 增加约 35~90s 运行时（视平台），
 * 这是棘轮门禁的固定成本。
 *
 * 子进程钦定模式：绝不 import eslint 模块进测试进程（vitest isolate:false 全进程共享模块
 * 注册表，见 AGENTS.md「vitest 隔离模型」），一律 spawnSync 跑 eslint CLI 拿 JSON。
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = path.join(REPO_ROOT, 'src')
const BASELINE_PATH = path.join(REPO_ROOT, 'eslint-baseline.json')

// eslint 10 的 exports 不放行 './bin/eslint.js'（ERR_PACKAGE_PATH_NOT_EXPORTED），故借
// exports 白名单里的 './package.json' 定位包目录再拼 bin 入口；不用 .bin/.cmd 包装（Git Bash
// 下 node 直调 js 入口最稳，三平台一致）。
const ESLINT_BIN = path.join(
  path.dirname(createRequire(import.meta.url).resolve('eslint/package.json')),
  'bin',
  'eslint.js'
)

interface EslintMessage {
  severity: 1 | 2
  ruleId: string | null
  message: string
  line: number
  column: number
}
interface EslintJsonResult {
  filePath: string
  messages: EslintMessage[]
}

describe('ESLint 棘轮基线门禁', () => {
  it(
    '错误级违规为 0，且每条规则 warn 数不超过 eslint-baseline.json 基线（只降不升）',
    async () => {
      expect(fs.existsSync(ESLINT_BIN), `eslint 未安装（缺 ${ESLINT_BIN}），先 npm install`).toBe(true)
      expect(fs.existsSync(BASELINE_PATH), `基线文件缺失：${BASELINE_PATH}`).toBe(true)

      const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Record<string, number>
      expect(Object.keys(baseline).length > 0, '基线为空：请先跑 npm run lint 登记 warn 计数').toBe(true)

      const res = spawnSync(process.execPath, [ESLINT_BIN, '--format', 'json', SRC_DIR], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        // 129 处 warn 的 JSON 报告约数百 KB，留足余量防 maxBuffer 截断
        maxBuffer: 64 * 1024 * 1024,
        // 略小于本用例 testTimeout：eslint 卡死时拿到 ETIMEDOUT 报错而不是整个测试被杀
        timeout: 170_000,
      })

      let results: EslintJsonResult[]
      try {
        results = JSON.parse(res.stdout ?? '') as EslintJsonResult[]
      } catch {
        throw new Error(
          `eslint 子进程未产出合法 JSON（status=${res.status}）。\n` +
            `stdout 尾部：${(res.stdout ?? '').slice(-500) || '(空)'}\n` +
            `stderr 尾部：${(res.stderr ?? '').slice(-500) || '(空)'}\n` +
            `排查：本地跑 npm run lint 看真实报错（exit 2 = 配置/执行错误，非违规）`
        )
      }

      const counts: Record<string, number> = {}
      const errors: string[] = []
      for (const file of results) {
        const rel = path.relative(REPO_ROOT, file.filePath)
        for (const m of file.messages) {
          if (m.severity === 2) {
            errors.push(`${rel}:${m.line}:${m.column} [${m.ruleId ?? '(parse)'}] ${m.message}`)
            continue
          }
          const rule = m.ruleId ?? '(unknown)'
          counts[rule] = (counts[rule] ?? 0) + 1
        }
      }

      // 断言 1：错误级违规必须为 0（warn 才走基线棘轮）
      expect(
        errors.length,
        `发现 ${errors.length} 处错误级 lint 违规（错误级不走基线，必须修复）：\n${errors.slice(0, 20).join('\n')}`
      ).toBe(0)

      // 断言 2：warn 棘轮——逐规则对照基线，只降不升
      const violations: string[] = []
      for (const [rule, count] of Object.entries(counts)) {
        if (!(rule in baseline)) {
          violations.push(
            `规则 ${rule} 产生 ${count} 处 warn 但不在基线中：若为 eslint.config.mjs 新增规则，` +
              `请评估后把 { "${rule}": ${count} } 登记进 eslint-baseline.json（附理由）；若为存量规则漏登记，同样补登记`
          )
          continue
        }
        if (count > baseline[rule]) {
          violations.push(
            `规则 ${rule} warn 数 ${count} > 基线 ${baseline[rule]}（超 ${count - baseline[rule]} 处）。` +
              `修复：跑 npm run lint 看新增违规位置并逐一修复；若确认无需修复（如依赖升级导致规则判定漂移），` +
              `把 eslint-baseline.json 中 "${rule}" 下调为 ${count} 并在提交说明里给理由`
          )
        }
      }
      expect(
        violations.length,
        `ESLint 棘轮基线被突破（${violations.length} 条）：\n${violations.join('\n')}`
      ).toBe(0)
    },
    180_000
  )
})
