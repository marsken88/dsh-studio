// 会话归档目录的清理规则：只动 dispatcher 自己命名的 *.stale-<ts>，其它一律保留。
import assert from 'node:assert/strict'
import test from 'node:test'

import { archivePlan, archiveStamp } from '../src/host/archive-gc.js'

const day = 86_400_000
const now = new Date(2026, 10, 26).getTime()

test('archiveStamp：只认 *.stale-<时间戳>', () => {
  assert.equal(archiveStamp('dsh-workspace.stale-1795684000000'), 1795684000000)
  assert.equal(archiveStamp('foo.stale-abc'), null)
  assert.equal(archiveStamp('plain-dir'), null)
  assert.equal(archiveStamp(''), null)
})

test('archivePlan：超期且超出保留数量的才删，别人的目录不碰', () => {
  const entries = [
    { name: 'a.stale-1'.replace('1', String(now - 40 * day)), mtime: now - 40 * day },
    { name: 'b.stale-1'.replace('1', String(now - 1 * day)), mtime: now - 1 * day },
    { name: 'someone-else', mtime: now - 400 * day },
  ]
  const plan = archivePlan(entries, { now, keepDays: 30, keepCount: 200 })
  assert.equal(plan.remove.length, 1, '只删那条 40 天前、我们自己命名的')
  assert.match(plan.remove[0].name, /^a\.stale-/)
  assert.ok(plan.keep.some(item => item.name === 'someone-else'), '别人的目录必须保留')
  assert.ok(plan.keep.some(item => item.name.startsWith('b.stale-')), '最近的要保留')
})

test('archivePlan：数量上限按时间倒序保留最近 N 个', () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({
    name: `x${index}.stale-${now - index * day}`,
    mtime: now - index * day,
  }))
  const plan = archivePlan(entries, { now, keepDays: 3650, keepCount: 2 })
  assert.equal(plan.keep.length, 2, 'keepCount=2 只留最近两个')
  assert.equal(plan.remove.length, 3)
  assert.deepEqual(plan.keep.map(item => item.name).sort(), ['x0.stale-' + now, 'x1.stale-' + (now - day)].sort())
})

test('archivePlan：空目录 / 非法入参不炸', () => {
  assert.deepEqual(archivePlan([], { now }).remove, [])
  assert.deepEqual(archivePlan(null, { now }).remove, [])
})
