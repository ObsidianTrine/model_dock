// ship-selfcheck 机器自检 runner 测试（2026-11-15 施工船复盘 A 方案）：
// 检查动作外置为可执行工件——grepZero/countAtLeast/tagBalance/jsSyntax/cssBraces/
// fileSize/noExternalRefs 七类检查 + 退出码契约（0 全绿 / 1 有 FAIL / 2 清单错误）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const scriptPath = new URL('../../.agents/scripts/ship-selfcheck.mjs', import.meta.url).pathname

function run(list: Record<string, unknown>, html: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-'))
  const listPath = path.join(dir, 'checklist.json')
  fs.writeFileSync(listPath, JSON.stringify(list))
  fs.writeFileSync(path.join(dir, list.file as string), html)
  return spawnSync(process.execPath, [scriptPath, listPath], { encoding: 'utf8', timeout: 60_000 })
}

const GOOD_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>测试页</title>
<style>
.stage { width: 100px; }
@keyframes slideX { to { transform: translateX(-50%); } }
@keyframes spin { to { transform: rotate(360deg); } }
.a { animation: slideX 4.6s linear infinite; }
.b { animation: spin 1.06s linear infinite; }
</style></head>
<body><main><div class="stage"><i class="a"></i><i class="b"></i><p>内容</p></div></main>
<script>(() => { 'use strict'; const x = document.querySelector('.a'); if (x) x.click(); })();</script>
</body></html>`

describe('ship-selfcheck > 机器自检 runner', () => {
  it('全绿清单：七类检查全过，退出码 0', () => {
    const r = run(
      {
        file: 'index.html',
        grepZero: ['兔', '醍'],
        countAtLeast: [{ pattern: '@keyframes (slideX|spin)\\b', atLeast: 2 }],
        countEqual: [{ pattern: '<i class="', equal: 2 }],
        tagBalance: ['div', 'i', 'p', 'main'],
        jsSyntax: true,
        cssBraces: true,
        fileSizeMaxKB: 45,
        noExternalRefs: true,
      },
      GOOD_HTML,
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('SELF-CHECK: ALL PASS')
    expect(r.stdout).toContain('PASS jsSyntax')
    expect(r.stdout).toContain('PASS noExternalRefs')
  })

  it('禁词命中与计数不足：逐项 FAIL，退出码 1', () => {
    const withForbidden = GOOD_HTML.replace('测试页', '醍测试页') // 注入禁词
    const r = run(
      {
        file: 'index.html',
        grepZero: ['醍'],
        countAtLeast: [{ pattern: '@keyframes legAT\\b', atLeast: 1 }],
        jsSyntax: true,
      },
      withForbidden,
    )
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('FAIL grepZero /醍/')
    expect(r.stdout).toContain('FAIL countAtLeast /@keyframes legAT\\b/')
    expect(r.stdout).toContain('SELF-CHECK: 2 FAIL')
    // PASS 项照常报告（不因部分失败丢信息）
    expect(r.stdout).toContain('PASS jsSyntax')
  })

  it('标签配对失衡与 JS 语法错：FAIL 定位', () => {
    const broken = GOOD_HTML.replace('</main>', '<div>') // 多一个未闭合 div
      .replace("const x = document.querySelector('.a');", 'const x = (') // JS 语法破坏
    const r = run(
      { file: 'index.html', tagBalance: ['div', 'main'], jsSyntax: true },
      broken,
    )
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('FAIL tagBalance <div>')
    expect(r.stdout).toContain('FAIL jsSyntax')
  })

  it('外部引用与体量超标：FAIL', () => {
    const withExternal = GOOD_HTML.replace('<style>', '<style>\n@import url("https://cdn.example.com/x.css");')
    const r1 = run({ file: 'index.html', noExternalRefs: true }, withExternal)
    expect(r1.status).toBe(1)
    expect(r1.stdout).toContain('FAIL noExternalRefs')
    const r2 = run({ file: 'index.html', fileSizeMaxKB: 1 }, GOOD_HTML + 'x'.repeat(3000))
    expect(r2.status).toBe(1)
    expect(r2.stdout).toMatch(/FAIL fileSize .+KB > 1KB/)
  })

  it('清单错误路径：退出码 2 不误报', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-'))
    const r1 = spawnSync(process.execPath, [scriptPath, path.join(dir, 'missing.json')], { encoding: 'utf8' })
    expect(r1.status).toBe(2)
    const r2 = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' })
    expect(r2.status).toBe(2)
    const bad = path.join(dir, 'bad.json')
    fs.writeFileSync(bad, '{ not json')
    const r3 = spawnSync(process.execPath, [scriptPath, bad], { encoding: 'utf8' })
    expect(r3.status).toBe(2)
  })

  it('清单项非法正则：不裸栈冒顶，落 bootstrap 文案按清单错误 exit 2', () => {
    // grepZero 非法正则（[ 未闭合）：旧实现 new RegExp 裸 SyntaxError exit 1，与 FAIL 不可区分
    const r1 = run({ file: 'index.html', grepZero: ['[未闭合'] }, GOOD_HTML)
    expect(r1.status).toBe(2)
    expect(r1.stderr).toContain('FAIL bootstrap — 清单错误')
    // countAtLeast 非法 pattern 同口径（多检查项共用 runItem 收口；*x = nothing to repeat）
    const r2 = run({ file: 'index.html', countAtLeast: [{ pattern: '*x', atLeast: 1 }] }, GOOD_HTML)
    expect(r2.status).toBe(2)
    expect(r2.stderr).toContain('FAIL bootstrap — 清单错误')
  })

  it('多 script 块逐块检查：第二块语法错 FAIL 并报告块序号；全好块 PASS 计块数', () => {
    // 旧实现只检第一个 <script> 块，第二块起的语法错漏检
    const twoBlocks = GOOD_HTML.replace('</body>', '<script>(() => { const y = ( })();</script></body>')
    const r = run({ file: 'index.html', jsSyntax: true }, twoBlocks)
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('FAIL jsSyntax')
    expect(r.stdout).toContain('第 2 块')
    // 对照组：两块全好 → PASS 且报出块数（证明逐块都检了）
    const twoGood = GOOD_HTML.replace('</body>', '<script>(() => { const y = 1; })();</script></body>')
    const rOk = run({ file: 'index.html', jsSyntax: true }, twoGood)
    expect(rOk.status).toBe(0)
    expect(rOk.stdout).toContain('PASS jsSyntax 2 块')
  })
})
