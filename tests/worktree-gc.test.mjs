// worktree 目录体检：只认「不在 git worktree list 里」= 孤儿；老化与体积由调用方量好传入。
import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyWorktrees, formatBytes, normalizePath, worktreeGcLine } from '../src/host/worktree-gc.js'

const dirs = [
  { name: 'alive', path: 'E:/repo/.agents/worktrees/alive', ageDays: 30, sizeBytes: 1000 },
  { name: 'old', path: 'E:/repo/.agents/worktrees/old', ageDays: 20, sizeBytes: 5_000_000 },
  { name: 'fresh', path: 'E:/repo/.agents/worktrees/fresh', ageDays: 2, sizeBytes: 3000, hasSymlinkChildren: true },
]

test('登记过的保留，没登记的算孤儿', () => {
  const result = classifyWorktrees({ dirs, registered: ['E:\\repo\\.agents\\worktrees\\alive'], minAgeDays: 7 })
  assert.deepEqual(result.kept.map(row => row.name), ['alive'], '反斜杠路径也算已登记')
  assert.deepEqual(result.orphans.map(row => row.name), ['old', 'fresh'], '按体积从大到小排')
  assert.equal(result.orphans[0].removable, true)
  assert.equal(result.orphans[1].removable, false, '不到 7 天不动')
  assert.match(result.orphans[1].reason, /不到 7 天/)
})

test('体积汇总：孤儿总量与「可清」量分开算', () => {
  const result = classifyWorktrees({ dirs, registered: [], minAgeDays: 7 })
  assert.equal(result.summary.total, 3)
  assert.equal(result.summary.orphanBytes, 1000 + 5_000_000 + 3000)
  assert.equal(result.summary.removableBytes, 1000 + 5_000_000, 'fresh 还没到 7 天，不算可清')
})

test('结论行说清「可清多少 / 要不要 --apply」', () => {
  const result = classifyWorktrees({ dirs, registered: ['E:/repo/.agents/worktrees/alive'], minAgeDays: 7 })
  const dry = worktreeGcLine(result, { apply: false, minAgeDays: 7 })
  assert.match(dry, /孤儿 2 \/ 共 3 个/)
  assert.match(dry, /可清/)
  assert.match(dry, /--apply/)
  const applied = worktreeGcLine(result, { apply: true, minAgeDays: 7 })
  assert.match(applied, /已清理/)
  assert.ok(!applied.includes('--apply'))
  assert.equal(worktreeGcLine({ orphans: [], kept: [], summary: { total: 0, orphanBytes: 0, removableBytes: 0 } }), '没有 worktree 目录，无需清理')
})

test('路径归一化与体积格式', () => {
  assert.equal(normalizePath('E:\\repo\\.agents\\'), 'e:/repo/.agents')
  assert.equal(normalizePath('E:/repo/.agents'), 'e:/repo/.agents', '大小写不敏感')
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3.00 GB')
})

test('空输入不炸（没有 .agents/worktrees 的机器）', () => {
  const result = classifyWorktrees({})
  assert.deepEqual(result.orphans, [])
  assert.deepEqual(result.kept, [])
  assert.equal(result.summary.total, 0)
})
