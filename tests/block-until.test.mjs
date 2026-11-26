// 条件型阻塞（2026-11-26 真机）：BUG-001 人工签完字，阻塞标记还挂着，必须人再点「解除」。
// 口径：只有 agent / 系统 挂的、且写了可判断条件的阻塞才自动解除；人挂的永远手动。

import assert from 'node:assert/strict'
import test from 'node:test'

import { autoUnblockNote, blockUntilMet, blockUntilOf, shouldAutoUnblock } from '../src/host/block-until.js'

const blocked = (over = {}) => ({ blocked: { by: 'agent', at: 1, reason: '准出只差人工签字', ...over } })

test('显式 human-signoff：人工签字到了就满足', () => {
  const task = { ...blocked({ until: 'human-signoff' }), signoff: { by: '张三', actorKind: 'human', note: 'ok' } }
  assert.equal(blockUntilOf(task), 'human-signoff')
  assert.equal(blockUntilMet(task, []), true)
  assert.equal(shouldAutoUnblock(task, []), true)
})

test('AI 代签不算（与准出门禁同一口径）', () => {
  const task = { ...blocked({ until: 'human-signoff' }), signoff: { by: '支付产品经理', actorKind: 'agent', note: 'ok' } }
  assert.equal(blockUntilMet(task, []), false)
  assert.equal(shouldAutoUnblock(task, []), false)
  const none = { ...blocked({ until: 'human-signoff' }), signoff: null }
  assert.equal(blockUntilMet(none, []), false)
})

test('老数据没写 until：按 reason 认出条件；认不出就不自动解除', () => {
  assert.equal(blockUntilOf(blocked({ reason: '准出只差人工签字：AI 签字 actorKind=agent 不计入' })), 'human-signoff')
  assert.equal(blockUntilOf(blocked({ reason: '先收口子卡再签主卡：还有 1 张子卡没完成' })), 'sub-cards-done')
  assert.equal(blockUntilOf(blocked({ reason: '准出只差**人工两签**：①先关子卡 BUG-001…②再签本卡' })), 'sub-cards-done', '先关子卡优先：子卡关了就先解这个条件')
  assert.equal(blockUntilOf(blocked({ reason: '①先关子卡 BUG-001 ②再签本卡' })), 'sub-cards-done')
  assert.equal(blockUntilOf(blocked({ reason: '等上游接口对接' })), '')
  const unknown = { ...blocked({ reason: '等上游接口对接' }), signoff: { by: '张三', actorKind: 'human' } }
  assert.equal(blockUntilMet(unknown, []), false)
})

test('sub-cards-done：子卡全完成才满足；没有子卡不解', () => {
  const task = { id: 'p', ...blocked({ until: 'sub-cards-done' }) }
  assert.equal(blockUntilMet(task, [{ id: 'c1', parent: 'p', status: 'done' }, { id: 'c2', parent: 'p', status: 'accept' }]), false)
  assert.equal(blockUntilMet(task, [{ id: 'c1', parent: 'p', status: 'done' }, { id: 'c2', parent: 'p', status: 'done' }]), true)
  assert.equal(blockUntilMet(task, [{ id: 'x', parent: 'other', status: 'done' }]), false)
})

test('人挂的阻塞永不自动解除（就算条件满足）', () => {
  const task = { ...blocked({ by: '张三', until: 'human-signoff' }), signoff: { by: '李四', actorKind: 'human' } }
  assert.equal(blockUntilMet(task, []), true, '条件本身是满足的')
  assert.equal(shouldAutoUnblock(task, []), false, '但人挂的必须人点')
})

test('系统挂的（AI 连续不推进）没有条件码，不会被自动解除', () => {
  const task = { ...blocked({ by: '系统', reason: 'AI 连续 3 轮没有推进' }) }
  assert.equal(blockUntilOf(task), '')
  assert.equal(shouldAutoUnblock(task, []), false)
  assert.match(autoUnblockNote(blocked({ until: 'human-signoff' })), /人工验收签字/)
})
