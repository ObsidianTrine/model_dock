#!/usr/bin/env node
/**
 * ModelDock 一键打包：SEA 可执行文件 + npm tgz + SHA256SUMS
 * 跨平台（Windows / Linux / macOS），Node >= 22。
 * 用法：
 *   - Windows：双击 scripts/build.bat
 *   - Linux / macOS：终端 sh scripts/build.sh
 *
 * tgz 一律经 build:sea --pack 打出：npm pack 发生在版本号从 git tag 还原之前，
 * tgz 文件名与包内 CLI 版本才与 tag 一致（原先「先 build 后 pack」会打出旧版本号）。
 */
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const run = (cmd) => execSync(cmd, { cwd: ROOT, stdio: 'inherit' })

console.log('\n[1/1] 构建 SEA 产物 + npm tgz（npm run build:sea -- --pack）…')
run('npm run build:sea -- --pack')

console.log('\n✓ 打包完成，全部产物在 release/ 目录')
