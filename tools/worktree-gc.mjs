#!/usr/bin/env node
/**
 * worktree 目录体检与清理（`npm run worktree:gc`）。
 *
 *   npm run worktree:gc                          # 只体检（本仓库 .agents/worktrees）
 *   npm run worktree:gc -- --days 3              # 3 天以上的孤儿才算可清
 *   npm run worktree:gc -- --apply               # 真删（只删「没登记且超龄」的）
 *   npm run worktree:gc -- --strict              # 有孤儿就退出码 1（给定时任务用）
 *
 * 判据在 `src/host/worktree-gc.js`（纯函数，有单测）：**只认「不在 git worktree list 里」**。
 * 不按目录名猜、不看分支，也不碰 `.agents/worktrees` 以外的任何路径。
 *
 * 为什么需要：合并完 `git worktree remove` 之后，目录里若还有 node_modules 联接或漏删的文件，
 * 目录会留下、但已不在 worktree 名单里 —— 越攒越多（2026-11-27 本仓库 19 个 / 148 MB）。
 * Windows 上删除前必须先把 `node_modules` 联接**摘掉**再删目录，否则 rm -rf 会顺着联接
 * 把主仓库的依赖一起删掉（真踩过）。
 */
import { execFileSync } from 'node:child_process'
import { lstatSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyWorktrees, formatBytes, worktreeGcLine } from '../src/host/worktree-gc.js'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = name => argv.includes(`--${name}`)
const value = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const apply = flag('apply')
const strict = flag('strict')
const minAgeDays = Number(value('days', 7)) || 7
const root = join(repo, '.agents', 'worktrees')

const registered = (() => {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })
    return out.split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length).trim())
  } catch {
    console.error('读不到 git worktree list（这不是 git 仓库？）')
    process.exit(2)
  }
})()

const dirSize = dir => {
  let total = 0
  let hasSymlinkChildren = false
  const walk = current => {
    let entries = []
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(current, entry.name)
      let info
      try { info = lstatSync(full) } catch { continue }
      if (info.isSymbolicLink()) { hasSymlinkChildren = true; continue }
      if (info.isDirectory()) { walk(full); continue }
      total += info.size
    }
  }
  walk(dir)
  return { sizeBytes: total, hasSymlinkChildren }
}

let dirs = []
try {
  dirs = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const full = join(root, entry.name)
      let ageDays = 0
      try { ageDays = (Date.now() - statSync(full).mtimeMs) / 86400000 } catch { ageDays = 0 }
      return { name: entry.name, path: full, ageDays, ...dirSize(full) }
    })
} catch {
  console.log('没有 .agents/worktrees 目录，无需清理')
  process.exit(0)
}

const result = classifyWorktrees({ dirs, registered, minAgeDays })
console.log(worktreeGcLine(result, { apply, minAgeDays }))
for (const row of result.orphans) {
  console.log(`  ${row.removable ? '✗' : '·'} ${row.name.padEnd(28)} ${formatBytes(row.sizeBytes).padStart(9)}  ${row.ageDays} 天  ${row.reason}`)
}
for (const row of result.kept) {
  console.log(`  ✓ ${row.name.padEnd(28)} ${formatBytes(row.sizeBytes).padStart(9)}  （已登记，保留）`)
}

if (apply) {
  let removed = 0
  for (const row of result.orphans) {
    if (!row.removable) continue
    // 先摘联接：Windows 上 rmSync(recursive) 会顺着目录联接把主仓库依赖删掉
    for (const child of ['node_modules', join('web', 'node_modules')]) {
      const target = join(row.path, child)
      try {
        if (lstatSync(target).isSymbolicLink()) unlinkSync(target)
      } catch { /* 没有就算了 */ }
    }
    try { rmSync(row.path, { recursive: true, force: true }); removed += 1 } catch (error) {
      console.error(`  删除失败 ${row.name}：${String(error?.message ?? error).slice(0, 120)}`)
    }
  }
  console.log(`已删除 ${removed} 个孤儿目录`)
}

if (strict && result.orphans.length > 0) process.exit(1)
