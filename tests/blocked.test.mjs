// 「阻塞」口径只有一份：未完成且挂阻塞标记。
import assert from 'node:assert/strict'
import test from 'node:test'

import { isOpenBlocked, isStaleBlocked, openBlockedOf, staleBlockedOf } from '../src/host/blocked.js'

const card = (status, blocked) => ({ id: `t-${status}-${blocked === null ? 'no' : 'yes'}`, status, blocked })

test('未完成且挂阻塞 = 阻塞；已完成的不算', () => {
  assert.equal(isOpenBlocked(card('dev', { reason: '等接口' })), true)
  assert.equal(isOpenBlocked(card('done', { reason: '等接口' })), false, '已完成的卡不再卡住任何人')
  assert.equal(isOpenBlocked(card('dev', null)), false)
  assert.equal(isOpenBlocked(null), false)
})

test('已完成却还挂着标记 = 残留（要提示清掉，不拦路）', () => {
  assert.equal(isStaleBlocked(card('done', { reason: 'x' })), true)
  assert.equal(isStaleBlocked(card('dev', { reason: 'x' })), false)
  assert.equal(isStaleBlocked(card('done', null)), false)
})

test('openBlockedOf / staleBlockedOf 一起用同一套判据', () => {
  const tasks = [card('dev', {}), card('test', null), card('done', {})]
  assert.equal(openBlockedOf(tasks).length, 1)
  assert.equal(staleBlockedOf(tasks).length, 1)
  assert.equal(openBlockedOf(tasks).length + staleBlockedOf(tasks).length, tasks.filter(task => task.blocked !== null).length)
})

test('自定义完成列也认（doneStatuses 参数）', () => {
  const tasks = [{ id: 'a', status: 'closed', blocked: { reason: 'x' } }]
  assert.equal(openBlockedOf(tasks).length, 1, '不传自定义列时 closed 仍算未完成')
  assert.equal(openBlockedOf(tasks, ['closed']).length, 0)
  assert.equal(staleBlockedOf(tasks, ['closed']).length, 1)
})

test('发布门禁只用 openBlockedOf：已完成的阻塞不再拦发布', () => {
  const tasks = [card('done', {}), card('done', null)]
  assert.equal(openBlockedOf(tasks).length, 0, '3/3 卡完成、阻塞 1 → 现在不拦发布')
})
