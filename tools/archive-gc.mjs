#!/usr/bin/env node
/* 清理 `~/.dsh/sessions-archive` 里的派单归档会话目录。
 *
 *   node tools/archive-gc.mjs                    # 只打印计划（dry-run）
 *   node tools/archive-gc.mjs --apply            # 真删
 *   node tools/archive-gc.mjs --days 7 --keep 50 --apply
 *
 * 只动 `*.stale-<时间戳>`：那是 dispatcher 自己搬进去的名字；其它目录一律不碰。
 */
import { lstat, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { archivePlan } from '../src/host/archive-gc.js'

const argv = process.argv.slice(2)
const numberArg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = Number(argv[index + 1])
  return Number.isFinite(value) ? value : fallback
}
const root = process.env.STUDIO_ARCHIVE_ROOT ?? join(homedir(), '.dsh', 'sessions-archive')
const apply = argv.includes('--apply')
const keepDays = numberArg('days', 30)
const keepCount = numberArg('keep', 200)

const entries = []
try {
  for (const name of await readdir(root)) {
    const info = await lstat(join(root, name))
    if (info.isDirectory()) entries.push({ name, mtime: info.mtimeMs })
  }
} catch (error) {
  if (error?.code === 'ENOENT') {
    console.log(`归档目录不存在，无需清理：${root}`)
    process.exit(0)
  }
  throw error
}

const plan = archivePlan(entries, { keepDays, keepCount })
console.log(`归档目录：${root}`)
console.log(`共 ${entries.length} 个目录；保留 ${plan.keep.length}，待删 ${plan.remove.length}（keepDays=${keepDays} keepCount=${keepCount}${apply ? '' : '，dry-run'}）`)
for (const item of plan.remove.slice(0, 10)) console.log(`  - ${item.name}（${item.ageDays} 天）`)
if (plan.remove.length > 10) console.log(`  … 还有 ${plan.remove.length - 10} 个`)

if (!apply) {
  console.log('这是预览。加 --apply 才会真删。')
  process.exit(0)
}
let removed = 0
for (const item of plan.remove) {
  try {
    await rm(join(root, item.name), { recursive: true, force: true })
    removed += 1
  } catch (error) {
    console.log(`  删除失败 ${item.name}：${String(error?.message ?? error)}`)
  }
}
console.log(`已删除 ${removed}/${plan.remove.length} 个归档目录`)
