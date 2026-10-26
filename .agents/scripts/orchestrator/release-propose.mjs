// release-propose.mjs — 发版提案（release-please 形态的触发层，Phase 2 展望项落地）。
// 自动做三件事：盘点上个 tag..develop 的内容提交、按 conventional 前缀推 semver 档位、
// 核对 CHANGELOG「未发布」段找疑似漏记，产出提案文件（建议版本 + CHANGELOG 草稿 +
// 下一步指引）。**纯只读仓库**：不写 CHANGELOG.md、不提交、不打 tag——发布是不可逆的
// 公开动作（release.md 红线），版本号决定权永远在人：用户确认后说「发布 vX.Y.Z」，
// 由 release.md「代理发布」节代执行完整发布序。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { toIsoLocal } from './events.mjs';

// git 提交记录分隔符（\x1f/\x1e 是控制字符，正常提交信息不会出现，稳定切开）
const FS = '\x1f';
const RS = '\x1e';

const TYPE_LABELS = {
  feat: '新增',
  fix: '修复',
  perf: '变更',
  refactor: '变更',
  docs: '其他',
  chore: '其他',
  test: '其他',
  build: '其他',
  ci: '其他',
  style: '其他',
};

const SUBJECT_RE = /^(feat|fix|perf|refactor|docs|chore|test|build|ci|style)(\([^)]*\))?(!)?:\s*(.+)$/;

function git(repoRoot, args, opts = {}) {
  const r = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, cwd: repoRoot, ...opts });
  return (r || '').trim();
}

/** 最近已发布 tag（git tag 列表按版本号降序取首个——tag 对象在仓库内全局可见，
 *  不受当前分支可达性影响（release.md：develop 的 git describe 够不着 main 侧 tag）。 */
export function latestTag(repoRoot) {
  const out = git(repoRoot, ['tag', '--list', 'v*', '--sort=-v:refname']);
  const first = out.split('\n').map((l) => l.trim()).find(Boolean);
  return first && /^v\d+\.\d+\.\d+$/.test(first) ? first : null;
}

/**
 * 解析 origin 远端 → 仓库主页基址（版本链接表行用）。
 * 认得 https / ssh 两种 GitHub 形态；其他托管或无远端返回 null（提案降级为提示行，
 * 不猜 URL 形态——compare 路径各家 forge 不同）。
 */
export function githubRepoBase(repoRoot) {
  let url = '';
  try {
    url = git(repoRoot, ['remote', 'get-url', 'origin'], { timeout: 10_000 });
  } catch {
    return null;
  }
  const m = /github\.com[:/](.+?)\/(.+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

/** 解析单个提交：type（conventional 前缀，无前缀为 null）+ breaking 标记。
 *  body 的 breaking 只认 conventional footer 形态「BREAKING CHANGE: …」（含连字符变体、必须带冒号）——
 *  正文里提及「BREAKING CHANGE 识别」这类描述性字样不是声明，宽松匹配会把普通 feat 误判成
 *  breaking、直接顶到 major（实测踩中：本功能自身的提交信息）。 */
export function parseCommit(subject, body = '') {
  const m = SUBJECT_RE.exec(subject);
  return {
    subject,
    type: m ? m[1] : null,
    desc: m ? m[4].trim() : subject.trim(),
    breaking: Boolean(m?.[3]) || /^BREAKING[ -]CHANGES?:/im.test(body),
  };
}

/** semver 档位（release.md「版本号怎么定」）：breaking 在 0.x 按惯例走 minor；feat→minor；其余→patch。 */
export function bumpLevel(counts, baseTag) {
  if (counts.breaking > 0) return Number(baseTag[1]) === 0 ? 'minor' : 'major';
  if (counts.feat > 0) return 'minor';
  return 'patch';
}

/** v1.2.2 + minor → 1.3.0（返回不带 v 前缀——CHANGELOG 段名与 release-check 参数都不带）。 */
export function incVersion(tag, level) {
  const [maj, min, pat] = tag.slice(1).split('.').map(Number);
  if (level === 'major') return `${maj + 1}.0.0`;
  if (level === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function cmpVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** 提取 CHANGELOG「未发布」段（Keep a Changelog 格式：## [未发布] 到下一个 ## 之间）。 */
export function extractUnreleased(changelogText) {
  const m = /^## \[?未发布\]?[^\n]*$/m.exec(changelogText);
  if (!m) return null;
  const rest = changelogText.slice(m.index + m[0].length);
  const next = /^## /m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

/** 疑似漏记粗匹配：去前缀描述归一化（空白/标点折叠）后在未发布段文本里找。
 *  CHANGELOG 是用户视角改写，字面命中不代表已记、未命中也不一定漏——只做初筛，人工核对。 */
function mentionedInUnreleased(desc, unreleased) {
  if (!unreleased) return false;
  const norm = (s) => s.replace(/[\s，。、；：·（）()【】\[\]{}"'“”‘’*#>-]/g, '');
  return norm(unreleased).includes(norm(desc).slice(0, 12));
}

/**
 * 生成发版提案。opts.versionHint：用户口述版本（校验合法性与递增，跳过自动定档）。
 * 返回结构化结果（CLI 打印用）；throw = 可操作错误（无 tag / 无可发内容等）。
 */
export function proposeRelease(repoRoot, opts = {}) {
  const base = latestTag(repoRoot);
  if (!base) {
    throw new Error('仓库没有任何 v* 版本 tag，无法定位盘点基线。首个版本请按 .agents/workflows/release.md 人工发布。');
  }

  // 盘点：上个 tag..develop 的内容提交（merge 节点不算，与 release.md 步骤 1 同口径）
  const raw = git(repoRoot, ['log', `${base}..develop`, '--no-merges', `--format=%h${FS}%s${FS}%b${RS}`]);
  const commits = raw
    .split(RS)
    .map((rec) => rec.replace(/^\n+/, ''))
    .filter((rec) => rec.trim())
    .map((rec) => {
      const [hash, subject, body] = rec.split(FS);
      return { hash: (hash || '').trim(), ...parseCommit((subject || '').trim(), body || '') };
    });

  const changelogPath = path.join(repoRoot, 'CHANGELOG.md');
  const changelog = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
  const unreleased = extractUnreleased(changelog);

  if (!commits.length && !unreleased) {
    return { nothingToRelease: true, base };
  }

  const counts = {
    feat: commits.filter((c) => c.type === 'feat').length,
    fix: commits.filter((c) => c.type === 'fix').length,
    breaking: commits.filter((c) => c.breaking).length,
  };

  let suggested;
  let level;
  if (opts.versionHint) {
    if (!/^\d+\.\d+\.\d+$/.test(opts.versionHint)) {
      throw new Error(`指定版本 "${opts.versionHint}" 不是合法 semver（形如 1.3.0，不带 v 前缀）。`);
    }
    if (cmpVersion(opts.versionHint, base.slice(1)) <= 0) {
      throw new Error(`指定版本 ${opts.versionHint} 不大于最近已发布 ${base.slice(1)}——semver 只增不减，已发布版本号永不复用（release.md「版本号怎么定」）。`);
    }
    suggested = opts.versionHint;
    level = bumpLevel(counts, base);
  } else {
    level = bumpLevel(counts, base);
    suggested = incVersion(base, level);
  }

  // 占用检查：本地必查；远端尽力（离线降级为 unknown，不阻断提案——真正阻断在 release-check）
  const tag = `v${suggested}`;
  const localTaken = Boolean(git(repoRoot, ['tag', '-l', tag]));
  let remoteTaken = null;
  try {
    remoteTaken = git(repoRoot, ['ls-remote', '--tags', 'origin', tag], { timeout: 30000 }) !== '';
  } catch {
    remoteTaken = null; // 离线：查不到不代表没占用，提案里明说
  }

  // 提案文件（运行态产物，.gitignore 已排除 release-proposals/）
  const dir = path.join(repoRoot, '.agents', 'orchestrator', 'release-proposals');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = toIsoLocal().replace(/[-:T]/g, '').slice(0, 12); // YYYYMMDDHHmm
  const proposalPath = path.join(dir, `${tag}-proposal-${stamp}.md`);
  const repoBase = githubRepoBase(repoRoot);
  fs.writeFileSync(proposalPath, renderProposal({ base, tag, suggested, level, counts, commits, unreleased, localTaken, remoteTaken, repoBase }));

  return {
    base,
    suggested,
    level,
    counts,
    commits,
    unreleased,
    localTaken,
    remoteTaken,
    proposalPath,
  };
}

function renderProposal(p) {
  const lines = [];
  lines.push(`# 发版提案 ${p.tag}（release-propose 生成于 ${toIsoLocal()}）`);
  lines.push('');
  lines.push('> 版本号是建议，决定权在人。确认后对 agent 说「发布 ' + p.tag + '」，由 .agents/workflows/release.md「代理发布」节代执行；');
  lines.push('> 也可以只采纳草稿，人工完成收口。');
  lines.push('');
  lines.push('## 建议与依据');
  lines.push('');
  lines.push(`- 建议版本：${p.suggested}（${p.level}）——上个已发布 tag：${p.base}`);
  lines.push(`- 信号：feat ${p.counts.feat} 条、fix ${p.counts.fix} 条、breaking ${p.counts.breaking} 条`);
  if (p.counts.breaking > 0 && p.level === 'minor') lines.push('- ⚠ 存在 breaking 提交，但当前处于 0.x（惯例走 minor；升 1.0 前请人工确认）');
  const featFix = p.counts.feat + p.counts.fix;
  if (featFix === 0) lines.push('- ⚠ 无 feat/fix 提交（内容偏文档/杂务），是否值得发版请人工裁决');
  lines.push(`- 占用检查：本地 tag ${p.localTaken ? '已占用 ✗（换版本号）' : '未占用'}；远端 ${p.remoteTaken === null ? '查询失败（离线？发布门禁会复核）' : p.remoteTaken ? '已占用 ✗（换版本号）' : '未占用'}`);
  lines.push('');
  lines.push('## 盘点清单');
  lines.push('');
  if (p.commits.length) {
    lines.push(`（${p.base}..develop 共 ${p.commits.length} 条内容提交，merge 节点不算）`);
    lines.push('');
    const groups = new Map();
    for (const c of p.commits) {
      const label = c.type ? TYPE_LABELS[c.type] : '待人工归类';
      groups.set(label, [...(groups.get(label) ?? []), c]);
    }
    for (const [label, items] of groups) {
      lines.push(`### ${label}`);
      lines.push('');
      for (const c of items) lines.push(`- ${c.hash} ${c.subject}${c.breaking ? ' **[breaking]**' : ''}`);
      lines.push('');
    }
    const misses = p.commits.filter((c) => (c.type === 'feat' || c.type === 'fix') && !mentionedInUnreleased(c.desc, p.unreleased));
    if (p.unreleased && misses.length) {
      lines.push('### 疑似漏记（未发布段粗匹配未命中，人工核对后并入草稿）');
      lines.push('');
      for (const c of misses) lines.push(`- ${c.hash} ${c.desc}`);
      lines.push('');
    }
  } else {
    lines.push(`（${p.base}..develop 无内容提交——仅有 CHANGELOG「未发布」段内容，请人工确认这些改动的来源提交是否已全部入库）`);
    lines.push('');
  }
  lines.push('## CHANGELOG 草稿（收口时人工润色，规范见 .agents/conventions/docs-writing.md）');
  lines.push('');
  lines.push(`## [${p.suggested}] - ${toIsoLocal().slice(0, 10)}`);
  lines.push('');
  if (p.unreleased) {
    lines.push(p.unreleased);
  } else {
    lines.push('（CHANGELOG 尚无「未发布」段——按上方盘点清单逐条归纳：新增/变更/修复）');
  }
  lines.push('');
  lines.push('## 版本链接表行（CHANGELOG 文末追加）');
  lines.push('');
  lines.push(p.repoBase ? `[${p.suggested}]: ${p.repoBase}/compare/${p.base}...${p.tag}` : `- （未识别 GitHub 远端（origin），跳过链接表行；或按你的托管平台手工补 compare 链接）`);
  lines.push('');
  lines.push('## 下一步');
  lines.push('');
  lines.push(`1. 按草稿在 develop 上收口 CHANGELOG（未发布段归并为 [${p.suggested}] 段 + 链接表补行）`);
  lines.push(`2. 对 agent 说「发布 ${p.tag}」→ .agents/workflows/release.md「代理发布」执行序（门禁 → 合并 → CI → tag → 验证）`);
  lines.push('');
  return lines.join('\n');
}
