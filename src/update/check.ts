/**
 * 自动更新 M1——GitHub Releases 发现与下载（实施基准：docs/design-auto-update.md §5）
 *
 * 检查 = GET /repos/{repo}/releases/latest（PAT 认证，私有仓库直连；该端点永不返回 draft/prerelease）；
 * 下载 = 同 api.github.com 的 assets/{id}（Accept: application/octet-stream），302 跟随到
 * objects.githubusercontent.com——检查流量全部留在连通性最好的 api.github.com 上。
 * SHA256 从发布物的 SHA256SUMS 资产解析，任何资产安装前强校验。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { t } from '../util/i18n.js'

const API_BASE = 'https://api.github.com'
const CHECK_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000

export class UpdateError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'UpdateError'
  }
}

export interface ReleaseAsset {
  name: string
  id: number
  size: number
}

export interface ReleaseManifest {
  /** 剥掉 v 前缀的 semver */
  version: string
  tagName: string
  notes: string
  htmlUrl: string
  assets: ReleaseAsset[]
}

function ghHeaders(token: string, accept = 'application/vnd.github+json'): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'modeldock-updater',
  }
}

function isSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(v)
}

/** 拉取最新正式发布并派生统一 manifest（apiBase 供测试注入本地服务） */
export async function fetchLatestRelease(repo: string, token: string, apiBase = API_BASE): Promise<ReleaseManifest> {
  let res: Response
  try {
    res = await fetch(`${apiBase}/repos/${repo}/releases/latest`, {
      headers: ghHeaders(token),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
  } catch (e) {
    throw new UpdateError(
      t(
        '无法访问 GitHub API：{m}。请检查网络或代理设置后重试',
        'Cannot reach the GitHub API: {m}. Check network or proxy settings and retry',
        { m: (e as Error).message }
      )
    )
  }
  if (res.status === 401 || res.status === 403) {
    throw new UpdateError(
      t(
        'GitHub 拒绝访问（{s}）：更新令牌无效或过期。到 GitHub → Settings → Developer settings → Fine-grained tokens 重新生成（仅本仓库、Contents 只读），然后执行 modeldock update --token <令牌>',
        'GitHub access denied ({s}): the update token is invalid or expired. Regenerate a fine-grained token (this repo only, Contents read-only) under GitHub → Settings → Developer settings, then run modeldock update --token <token>',
        { s: res.status }
      )
    )
  }
  if (res.status === 404) {
    throw new UpdateError(
      t(
        '找不到仓库 {repo} 的发布（404）：检查 config.toml [update] repo 是否写对（owner/name），且令牌对该仓库有 Contents 只读权限',
        'No release found for {repo} (404): check [update] repo in config.toml (owner/name) and that the token has read-only Contents access to it',
        { repo }
      )
    )
  }
  if (!res.ok) {
    throw new UpdateError(
      t('GitHub API 返回 {s}，稍后重试', 'GitHub API returned {s}; try again later', { s: res.status })
    )
  }
  const j = (await res.json()) as {
    tag_name?: string
    body?: string
    html_url?: string
    assets?: { name?: string; id?: number; size?: number }[]
  }
  const version = String(j.tag_name ?? '').replace(/^v/, '')
  if (!isSemver(version)) {
    throw new UpdateError(
      t(
        '最新发布 tag「{t}」不是 vX.Y.Z 形态，无法比较版本；请检查该发布',
        'The latest release tag "{t}" is not vX.Y.Z; cannot compare versions. Check that release',
        { t: String(j.tag_name ?? '') }
      )
    )
  }
  const assets = (j.assets ?? [])
    .filter((a): a is { name: string; id: number; size: number } => typeof a.name === 'string' && typeof a.id === 'number')
    .map((a) => ({ name: a.name, id: a.id, size: a.size ?? 0 }))
  return {
    version,
    tagName: String(j.tag_name),
    notes: String(j.body ?? '').slice(0, 2000),
    htmlUrl: String(j.html_url ?? ''),
    assets,
  }
}

/** 版本比较：>0 表示 a 更新。逐段数值比较（本项目 tag 均为 vX.Y.Z，无预发布段） */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export type InstallShape = 'mac-app' | 'bare' | 'win-setup' | 'win-bare'

/** 按安装形态与架构选出该下载的资产名（纯函数，测试锚定命名规则） */
export function selectAssetName(shape: InstallShape, platform: string, arch: string, version: string): string | null {
  const a = arch === 'arm64' ? 'arm64' : 'x64'
  if (shape === 'mac-app') return `modeldock-${version}-darwin-${a}-app.tar.gz`
  if (shape === 'win-setup') return `modeldock-${version}-win32-x64-setup.exe`
  if (shape === 'win-bare') return `modeldock-${version}-win32-x64.zip`
  if (platform === 'darwin') return `modeldock-${version}-darwin-${a}.tar.gz`
  return `modeldock-${version}-linux-${a}.tar.gz`
}

export function findAsset(m: ReleaseManifest, name: string): ReleaseAsset | null {
  return m.assets.find((a) => a.name === name) ?? null
}

/** 下载资产到目标目录，返回落盘路径。整文件重试 3 次（对象存储间歇断是大陆常态），失败清理半成品 */
export async function downloadAsset(
  repo: string,
  token: string,
  asset: ReleaseAsset,
  destDir: string,
  opts: { apiBase?: string; onProgress?: (received: number, total: number) => void; retryDelayMs?: number } = {}
): Promise<string> {
  const dest = path.join(destDir, asset.name)
  const url = `${opts.apiBase ?? API_BASE}/repos/${repo}/releases/assets/${asset.id}`
  const retryDelay = opts.retryDelayMs ?? 2000
  let lastErr: Error | null = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: ghHeaders(token, 'application/octet-stream'),
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        redirect: 'follow',
      })
      if (!res.ok || !res.body) {
        throw new UpdateError(
          t('下载 {n} 失败：HTTP {s}', 'Failed to download {n}: HTTP {s}', { n: asset.name, s: res.status })
        )
      }
      await fsp.mkdir(destDir, { recursive: true })
      const out = fs.createWriteStream(dest)
      let received = 0
      let lastReport = 0
      const reader = res.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          received += value.byteLength
          if (!out.write(Buffer.from(value))) {
            await new Promise<void>((resolve) => out.once('drain', resolve))
          }
          if (opts.onProgress && received - lastReport > 5 * 1024 * 1024) {
            lastReport = received
            opts.onProgress(received, asset.size)
          }
        }
      } finally {
        await new Promise<void>((resolve) => out.end(resolve))
      }
      if (asset.size > 0 && received !== asset.size) {
        throw new UpdateError(
          t(
            '下载 {n} 不完整（{r}/{t} 字节），已重试仍失败——请检查网络后重跑',
            'Download of {n} is incomplete ({r}/{t} bytes) even after retries — check the network and rerun',
            { n: asset.name, r: received, t: asset.size }
          )
        )
      }
      return dest
    } catch (e) {
      lastErr = e as Error
      await fsp.rm(dest, { force: true }).catch(() => {})
      if (attempt >= 3) break
      await new Promise((r) => setTimeout(r, retryDelay * attempt))
    }
  }
  throw lastErr ?? new UpdateError(t('下载失败', 'Download failed'))
}

/** 拉取并解析发布物的 SHA256SUMS（"哈希  文件名" 每行一条）；缺失返回 null（调用方决定是否放行） */
export async function fetchChecksums(
  repo: string,
  token: string,
  m: ReleaseManifest,
  opts: { apiBase?: string; retryDelayMs?: number } = {}
): Promise<Record<string, string> | null> {
  const sums = findAsset(m, 'SHA256SUMS')
  if (!sums) return null
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-sums-'))
  try {
    const file = await downloadAsset(repo, token, sums, tmpDir, opts)
    const text = await fsp.readFile(file, 'utf8')
    const map: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const mm = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/)
      if (mm) map[mm[2].trim()] = mm[1].toLowerCase()
    }
    return Object.keys(map).length ? map : null
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    const s = fs.createReadStream(file)
    s.on('data', (d) => h.update(d))
    s.on('end', () => resolve(h.digest('hex')))
    s.on('error', reject)
  })
}

/** 强校验：SUMS 名册存在但资产不在册/哈希不符 → 抛错并删除下载物。校验不过绝不进入安装。 */
export async function verifyChecksum(file: string, sums: Record<string, string> | null): Promise<void> {
  const name = path.basename(file)
  if (!sums) {
    throw new UpdateError(
      t('发布物缺少 SHA256SUMS 校验名单，无法安全安装；请到发布页人工核对后手动安装', 'The release is missing a SHA256SUMS manifest; refusing to install. Verify it manually on the release page instead')
    )
  }
  const expected = sums[name]
  if (!expected) {
    throw new UpdateError(
      t('{n} 不在 SHA256SUMS 名册中，拒绝安装', '{n} is not listed in SHA256SUMS; refusing to install', { n: name })
    )
  }
  const actual = await sha256File(file)
  if (actual !== expected.toLowerCase()) {
    await fsp.rm(file, { force: true }).catch(() => {})
    throw new UpdateError(
      t(
        '{n} 校验失败（SHA256 不符），已删除下载文件。可能是下载损坏或来源被篡改，请重跑；反复失败请到发布页人工核对',
        '{n} failed verification (SHA256 mismatch); the download was deleted. It may be corrupted or tampered with — rerun, or verify manually on the release page if it keeps failing',
        { n: name }
      )
    )
  }
}
