import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ROLE_LABEL,
  CASE_RESULTS,
  CASE_RESULT_LABEL,
  REQ_STATUS_ORDER,
  REQ_STATUS_LABEL,
  RELEASE_STATUS_ORDER,
  RELEASE_STATUS_LABEL,
  DOC_KIND_ORDER,
  DOC_KIND_LABEL,
  DOC_STATUS_LABEL,
  PRIORITY_LABEL,
  STRATEGY_LABEL,
  TYPE_LABEL,
} from '../web/src/studio/labels.js'
import { buildRoster, ownerLabel, memberLabel, toDateInput, fromDateInput } from '../web/src/studio/roster.js'
import { fmtTime, fmtDate } from '../web/src/studio/format.js'

test('labels: every ordered status has a label', () => {
  for (const id of REQ_STATUS_ORDER) {
    assert.ok(REQ_STATUS_LABEL[id], `REQ_STATUS_LABEL is missing ${id}`)
  }
  for (const id of RELEASE_STATUS_ORDER) {
    assert.ok(RELEASE_STATUS_LABEL[id], `RELEASE_STATUS_LABEL is missing ${id}`)
  }
  for (const id of DOC_KIND_ORDER) {
    assert.ok(DOC_KIND_LABEL[id], `DOC_KIND_LABEL is missing ${id}`)
  }
  assert.deepEqual(Object.keys(REQ_STATUS_LABEL).sort(), [...REQ_STATUS_ORDER].sort(), 'REQ_STATUS_LABEL has the same keys as REQ_STATUS_ORDER')
  assert.deepEqual(Object.keys(DOC_STATUS_LABEL).sort(), ['baseline', 'draft', 'review'], 'DOC_STATUS_LABEL covers draft/review/baseline')
})

test('labels: role, case, priority, strategy and type tables are complete', () => {
  for (const role of ['product', 'architect', 'dev', 'qa']) {
    assert.ok(ROLE_LABEL[role], `ROLE_LABEL is missing ${role}`)
  }
  for (const result of CASE_RESULTS) {
    assert.ok(CASE_RESULT_LABEL[result], `CASE_RESULT_LABEL is missing ${result}`)
  }
  for (const table of [PRIORITY_LABEL, STRATEGY_LABEL, TYPE_LABEL]) {
    const values = Object.values(table)
    assert.ok(values.length > 0, 'label table must not be empty')
    assert.equal(new Set(values).size, values.length, 'label table values must be unique: ' + JSON.stringify(values))
  }
})

test('roster: owner labels cover role, team, expert and pool shapes', () => {
  const config = {
    experts: [
      { id: 'expert-a', name: '支付产品经理', emoji: '📦', role: 'product', domain: '支付' },
      { id: 'expert-b', name: '会员产品经理', emoji: '🎯', role: 'product' },
      { id: 'expert-qa', name: '测试工程师', emoji: '🧪', role: 'qa' },
    ],
    teams: [{ id: 'team-1', name: '支付小队' }],
  }
  assert.equal(ownerLabel(config, null), '')
  assert.equal(memberLabel(config, { kind: 'role', id: 'qa' }), '🎯 测试')
  assert.equal(memberLabel(config, { kind: 'team', id: 'team-1' }), '👥 支付小队')
  assert.equal(memberLabel(config, { kind: 'expert', id: 'expert-a' }), '📦 支付产品经理')
  assert.equal(ownerLabel(config, { kind: 'role', id: 'dev' }), '🎯 研发')
  assert.equal(
    ownerLabel(config, { kind: 'pool', members: [{ kind: 'role', id: 'product' }, { kind: 'expert', id: 'expert-qa' }] }),
    '🎯 产品 等 2 位',
  )
  assert.equal(ownerLabel(config, { kind: 'pool', members: [] }), '')
})

test('roster: buildRoster puts the four role slots first and skips disabled experts', () => {
  const config = {
    experts: [
      { id: 'expert-a', name: '支付产品经理', role: 'product', enabled: true },
      { id: 'expert-off', name: '停用的', role: 'dev', enabled: false },
    ],
  }
  const roster = buildRoster(config)
  assert.deepEqual(roster.slice(0, 4).map((item) => item.key), ['r:product', 'r:architect', 'r:dev', 'r:qa'])
  assert.ok(roster.some((item) => item.key === 'e:expert-a'), 'enabled expert is listed')
  assert.ok(!roster.some((item) => item.key === 'e:expert-off'), 'disabled expert is skipped')
  assert.equal(roster[0].group, '角色位')
})

test('roster: date helpers round-trip a local date', () => {
  assert.equal(toDateInput(0), '')
  assert.equal(toDateInput(null), '')
  const text = toDateInput(Date.parse('2026-11-13T10:20:00+08:00'))
  assert.match(text, /^2026-11-1[23]$/)
  assert.ok(fromDateInput(text) > 0, 'parsed back into a timestamp at end of day')
  assert.equal(fromDateInput(''), 0)
  assert.equal(fromDateInput('not-a-date'), 0)
})

test('format: time helpers never throw on empty input', () => {
  for (const value of [0, null, undefined, '']) {
    assert.equal(typeof fmtTime(value), 'string')
    assert.equal(typeof fmtDate(value), 'string')
  }
  assert.notEqual(fmtTime(Date.parse('2026-11-13T10:20:00+08:00')), '')
})
