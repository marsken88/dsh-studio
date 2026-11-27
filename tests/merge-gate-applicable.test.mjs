// 合并门禁的 applicable 已经被丢过两次（面板分不清「不适用」和「已通过」），单独钉住。
import assert from 'node:assert/strict'
import test from 'node:test'

import { sanitizeMergeGate } from '../src/host/merge-gate.js'

test('sanitizeMergeGate 保留 applicable=false（不适用）', () => {
  const gate = sanitizeMergeGate({ at: 1, state: "pending", applicable: false, blockers: [] })
  assert.equal(gate.applicable, false)
})

test('sanitizeMergeGate 默认 applicable=true（老数据没有这个字段）', () => {
  const gate = sanitizeMergeGate({ at: 1, state: "success", blockers: [] })
  assert.equal(gate.applicable, true)
})

test('sanitizeMergeGate 往返不丢字段', () => {
  const first = sanitizeMergeGate({ at: 1, state: "success", applicable: false, blockers: ["x"], sha: "abc", iid: 7 })
  const second = sanitizeMergeGate(first)
  assert.deepEqual(second, first)
})
