#!/usr/bin/env node
// ship-selfcheck.mjs — 施工船交付前机器自检 runner。
// 设计（2026-11-15 施工船复盘）：检查动作外置为可执行工件——文字约束负责召回错误类别，
// 机器闸门判定对错（无外部反馈的自我纠错无效：arXiv 2310.01798；多指令堆叠遵守率衰减：
// arXiv 2309.11247）。施工船跑本脚本不自评；验船师独立重跑同一清单复核。
//
// 用法: node ship-selfcheck.mjs <checklist.json>
// 清单（与清单文件同目录解析相对路径）:
// {
//   "file": "index.html",
//   "grepZero": ["兔", "醍", "pelican"],                       // 命中必须为 0（旧主体名/禁词）
//   "countAtLeast": [{ "pattern": "@keyframes slideX\\b", "atLeast": 1, "flags": "g" }],
//   "countEqual":   [{ "pattern": "<div class=\"seg\"", "equal": 2 }],
//   "tagBalance": ["div", "i", "span", "button"],               // 开闭标签数一致
//   "jsSyntax": true,                                            // 提取 <script> 语法检查
//   "cssBraces": true,                                           // <style> 花括号平衡
//   "fileSizeMaxKB": 45,
//   "noExternalRefs": true                                       // 无 script src/link/@import/url(http)
// }
// 退出码: 0 全绿 / 1 有 FAIL / 2 清单或环境错误。输出逐行 PASS/FAIL，末尾汇总。

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (!args.length) {
  console.error('用法: node ship-selfcheck.mjs <checklist.json>');
  process.exit(2);
}
const listPath = path.resolve(args[0]);
if (!fs.existsSync(listPath)) {
  console.error(`FAIL bootstrap — 清单不存在: ${listPath}`);
  process.exit(2);
}
let list;
try {
  list = JSON.parse(fs.readFileSync(listPath, 'utf8'));
} catch (e) {
  console.error(`FAIL bootstrap — 清单 JSON 非法: ${e.message}`);
  process.exit(2);
}
if (!list.file) {
  console.error('FAIL bootstrap — 清单缺少 file 字段');
  process.exit(2);
}
const target = path.resolve(path.dirname(listPath), list.file);
if (!fs.existsSync(target)) {
  console.error(`FAIL bootstrap — 被检文件不存在: ${target}`);
  process.exit(2);
}
const html = fs.readFileSync(target, 'utf8');

let fails = 0;
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => {
  console.log(`FAIL ${name} — ${detail}`);
  fails += 1;
};

// 1. grepZero：禁词/旧主体名归零（全文含注释）
for (const pat of list.grepZero ?? []) {
  const re = new RegExp(pat, 'gu');
  const hits = [...html.matchAll(re)].length;
  if (hits === 0) pass(`grepZero /${pat}/ 归零`);
  else fail(`grepZero /${pat}/`, `命中 ${hits} 处（须为 0）`);
}

// 2. countAtLeast / countEqual：结构计数（keyframes、速度动画声明、组件实例等）
for (const c of list.countAtLeast ?? []) {
  const hits = [...html.matchAll(new RegExp(c.pattern, c.flags ?? 'g'))].length;
  if (hits >= c.atLeast) pass(`countAtLeast /${c.pattern}/ ${hits} >= ${c.atLeast}`);
  else fail(`countAtLeast /${c.pattern}/`, `命中 ${hits} < ${c.atLeast}`);
}
for (const c of list.countEqual ?? []) {
  const hits = [...html.matchAll(new RegExp(c.pattern, c.flags ?? 'g'))].length;
  if (hits === c.equal) pass(`countEqual /${c.pattern}/ = ${c.equal}`);
  else fail(`countEqual /${c.pattern}/`, `命中 ${hits} ≠ ${c.equal}`);
}

// 3. tagBalance：开闭标签数量一致
for (const tag of list.tagBalance ?? []) {
  const open = (html.match(new RegExp(`<${tag}(\\s|>)`, 'g')) ?? []).length;
  const close = (html.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
  if (open === close && open > 0) pass(`tagBalance <${tag}> ${open}/${close}`);
  else fail(`tagBalance <${tag}>`, `${open} 开 / ${close} 闭`);
}

// 4. jsSyntax：提取内联 <script> 做语法编译检查
if (list.jsSyntax) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) fail('jsSyntax', '未找到 <script> 块');
  else {
    try {
      new Function(m[1]);
      pass('jsSyntax');
    } catch (e) {
      fail('jsSyntax', e.message);
    }
  }
}

// 5. cssBraces：<style> 花括号平衡
if (list.cssBraces) {
  const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  const open = (css.match(/\{/g) ?? []).length;
  const close = (css.match(/\}/g) ?? []).length;
  if (open === close) pass(`cssBraces ${open}/${close}`);
  else fail('cssBraces', `${open} 个 { / ${close} 个 }`);
}

// 6. fileSizeMaxKB：体量上界
if (list.fileSizeMaxKB) {
  const kb = Buffer.byteLength(html, 'utf8') / 1024;
  if (kb <= list.fileSizeMaxKB) pass(`fileSize ${kb.toFixed(1)}KB <= ${list.fileSizeMaxKB}KB`);
  else fail('fileSize', `${kb.toFixed(1)}KB > ${list.fileSizeMaxKB}KB`);
}

// 7. noExternalRefs：零外部资源（外链 script/link/img、@import、url(http)）
if (list.noExternalRefs) {
  const ext =
    /<script[^>]+src=|<link\s+[^>]*href=|@import|url\(\s*['"]?https?:|<img[^>]+src=["']https?:/.test(html);
  if (!ext) pass('noExternalRefs');
  else fail('noExternalRefs', '发现外链引用（script src / link href / @import / url(http)）');
}

console.log(fails === 0 ? '\nSELF-CHECK: ALL PASS' : `\nSELF-CHECK: ${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
