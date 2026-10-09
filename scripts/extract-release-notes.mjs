#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 提取指定版本的发布说明输出到 stdout——release.yml 用作 GitHub Release 正文。
 *
 * 用法：node scripts/extract-release-notes.mjs [--check] [tag]
 *   tag 形如 v1.1.0（缺省读 GITHUB_REF_NAME）；对应 CHANGELOG 的 `## [1.1.0]` 段，
 *   提取该标题之后、下一个 `## [` 之前的内容（标题本身不进正文——Release 标题已是版本号）。
 *   --check：校验模式——版本段存在则打印确认并退出 0，缺失则给出修复提示并退出 1
 *   （release.yml 的 preflight job 用，在五平台构建前拦下漏更 CHANGELOG 的 tag）。
 * 不带 --check 时找不到对应段不阻断发布，回落为「版本 + CHANGELOG 链接」占位正文。
 */
import fs from 'node:fs'

const REPO = 'ObsidianTrine/model_dock'
const args = process.argv.slice(2)
const check = args.includes('--check')
const tag = String(args.find((a) => a !== '--check') || process.env.GITHUB_REF_NAME || '').replace(/^v/, '')
const changelog = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function extractSection(ver) {
  const lines = changelog.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^## \\[${escapeRe(ver)}\\]`).test(l))
  if (start === -1) return null
  const body = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## \[/.test(lines[i])) break
    body.push(lines[i])
  }
  // 段尾的分隔线与空行不进正文
  while (body.length && (!body[body.length - 1].trim() || /^---\s*$/.test(body[body.length - 1]))) body.pop()
  return body.join('\n').trim()
}

const section = tag ? extractSection(tag) : null
if (check) {
  if (!section) {
    console.error(`CHANGELOG.md 中没有 [${tag}] 版本段（对应 tag v${tag}）。`)
    console.error('修复：补上该版本段并提交后，删除已推的 tag、在新提交上重打：')
    console.error(`  git push origin :refs/tags/v${tag} && git tag -d v${tag}`)
    console.error(`  git tag -a v${tag} -m "v${tag}" && git push origin v${tag}`)
    process.exit(1)
  }
  console.log(`✓ CHANGELOG.md 已有 [${tag}] 版本段`)
} else if (section) {
  console.log(section)
} else {
  console.log(`ModelDock ${tag ? `v${tag}` : ''}\n\n完整变更见 [CHANGELOG.md](https://github.com/${REPO}/blob/main/CHANGELOG.md)。`)
}
