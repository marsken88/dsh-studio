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
import { searchItems, filterItems } from '../web/src/studio/palette.js'

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

test('palette: searchItems covers tasks, requirements and releases', () => {
  const state = {
    statuses: [{ id: 'dev', label: '开发中' }],
    tasks: [
      { id: 't1', code: 'DEV-001', title: '退款对账', status: 'dev', owner: { label: '🏛️ 支付架构师' } },
      { id: 't2', code: 'BUG-001', title: '并发超卖', status: 'dev' },
    ],
    requirements: [{ id: 'r1', code: 'REQ-2026-001', title: '会员积分抵扣', domain: '支付', owner: 'ken' }],
    releases: [{ id: 'v1', name: 'v1.0.0', tagName: 'v1.0.0', status: 'draft' }],
  }
  const items = searchItems(state)
  assert.deepEqual(items.map((item) => item.kind), ['task', 'task', 'requirement', 'release'])
  assert.equal(items[0].hint, '开发中 · 🏛️ 支付架构师')
  assert.equal(items[2].hint, '需求 · 支付 · ken')
  assert.ok(items[3].hint.startsWith('版本'))
})

test('palette: filterItems matches words, ranks prefixes first and stops when empty', () => {
  const items = [
    { key: 'a', label: 'DEV-001 退款', search: 'dev-001 退款' },
    { key: 'b', label: 'BUG-001 超卖', search: 'bug-001 超卖' },
    { key: 'c', label: 'REQ 退款需求', search: 'req-2026-001 退款需求' },
  ]
  assert.deepEqual(filterItems(items, 'BUG').map((item) => item.key), ['b'])
  assert.deepEqual(filterItems(items, 'bug 超卖').map((item) => item.key), ['b'])
  assert.deepEqual(filterItems(items, 'bug 退款'), [])
  assert.equal(filterItems(items, '').length, 3)
  assert.deepEqual(filterItems(items, '没有这个词'), [])
  const ranked = filterItems([...items, { key: 'd', label: '退款退款', search: '退款退款' }], '退款')
  assert.equal(ranked.length, 3)
})

test('palette: actions are searchable next to records', async () => {
  const { actionItems, paletteItems } = await import('../web/src/studio/palette.js')
  const actions = actionItems()
  assert.equal(actions.length, 29)
  assert.equal(new Set(actions.map((item) => item.id)).size, 29, 'action ids must be unique')
  for (const item of actions) {
    assert.equal(item.kind, 'action')
    assert.ok(item.label.length > 0 && item.search.length > 0)
  }
  const state = { tasks: [{ id: 't1', code: 'DEV-001', title: '退款对账', status: 'dev' }], requirements: [], releases: [], statuses: [{ id: 'dev', label: '开发中' }] }
  const all = paletteItems(state)
  assert.equal(all.length, 30, '29 actions + one task')
  assert.equal(filterItems(all, '新建需求')[0].id, 'new-requirement')
  assert.equal(filterItems(all, '导出')[0].kind, 'action')
  assert.equal(filterItems(all, '主题').length, 3)
  assert.equal(filterItems(all, 'DEV-001')[0].kind, 'task')
  assert.deepEqual(filterItems(all, '不存在的词'), [])
})

test('palette: experts, teams and projects are searchable too', async () => {
  const { searchItems, paletteItems, filterItems } = await import('../web/src/studio/palette.js')
  const state = {
    tasks: [], requirements: [], releases: [], statuses: [],
    config: {
      experts: [
        { id: 'architect', name: '架构师', emoji: '🏛️', role: 'architect', domain: '支付' },
        { id: 'expert-1', name: '支付产品经理', emoji: '💳', role: 'product', domain: '支付' },
      ],
      teams: [{ id: 'team-1', name: '支付方案组', members: [{ id: 'architect', name: '架构师' }] }],
      projects: [{ id: 'proj-1', name: '支付中心', services: [{ name: 'payment-api' }], iterations: [{ id: 'it-1' }] }],
    },
  }
  const records = searchItems(state)
  assert.deepEqual(records.map((item) => item.kind), ['expert', 'expert', 'team', 'project'])
  assert.equal(records[0].hint, '专家 · 架构 · 支付')
  assert.equal(records[1].label, '💳 支付产品经理')
  assert.equal(records[2].label, '👥 支付方案组')
  assert.equal(records[3].hint, '项目 · 1 个服务 · 1 个迭代')
  const all = paletteItems(state)
  assert.equal(filterItems(all, '支付产品')[0].kind, 'expert')
  assert.equal(filterItems(all, '支付中心')[0].kind, 'project')
  assert.equal(filterItems(all, 'payment-api')[0].kind, 'project')
  assert.equal(filterItems(all, '打开设置')[0].id, 'settings:projects')
  assert.equal(filterItems(all, '技能库').some((item) => item.id === 'settings:skills'), true)
})
