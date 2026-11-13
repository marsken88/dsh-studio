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
  assert.equal(actions.length, 35)
  assert.equal(actions.some((item) => item.id === 'clear-recents'), true, 'a way out of the recent list must exist')
  assert.equal(new Set(actions.map((item) => item.id)).size, 35, 'action ids must be unique')
  for (const item of actions) {
    assert.equal(item.kind, 'action')
    assert.ok(item.label.length > 0 && item.search.length > 0)
  }
  const state = { tasks: [{ id: 't1', code: 'DEV-001', title: '退款对账', status: 'dev' }], requirements: [], releases: [], statuses: [{ id: 'dev', label: '开发中' }] }
  const all = paletteItems(state)
  assert.equal(all.length, 36, '35 actions + one task')
  assert.equal(filterItems(all, '新建需求')[0].id, 'new-requirement')
  assert.equal(filterItems(all, '导出')[0].kind, 'action')
  assert.equal(filterItems(all, '主题').length, 3)
  assert.equal(filterItems(all, 'DEV-001')[0].kind, 'task')
  assert.deepEqual(filterItems(all, '不存在的词'), [])
})

test('palette: recently used actions move to the top and stay bounded', async () => {
  const { sortByRecent, rememberAction, RECENT_LIMIT, actionItems } = await import('../web/src/studio/palette.js')
  const actions = actionItems()
  const first = actions[0].id
  const second = actions[1].id
  const sorted = sortByRecent(actions, [second, first])
  assert.equal(sorted[0].id, second)
  assert.equal(sorted[1].id, first)
  assert.equal(sorted.length, actions.length)
  assert.equal(sortByRecent(actions, []).map((item) => item.id).join(), actions.map((item) => item.id).join())
  assert.equal(sortByRecent(actions, ['no-such-action']).length, actions.length)

  assert.deepEqual(rememberAction([], 'refresh'), ['refresh'])
  assert.deepEqual(rememberAction(['refresh', 'new-task'], 'refresh'), ['refresh', 'new-task'])
  assert.deepEqual(rememberAction(['a', 'b', 'c'], 'd', 3), ['d', 'a', 'b'])
  const overflow = Array.from({ length: RECENT_LIMIT + 3 }, (_, index) => 'id-' + index).reduce((acc, id) => rememberAction(acc, id), [])
  assert.equal(overflow.length, RECENT_LIMIT)
})

test('palette: card flows resolve the next column and stop at the last one', async () => {
  const { nextStatusOf } = await import('../web/src/studio/palette.js')
  const state = {
    statuses: [{ id: 'dev', label: '开发中' }, { id: 'review', label: '待评审' }, { id: 'done', label: '已完成' }],
    tasks: [{ id: 't-1', status: 'dev' }, { id: 't-2', status: 'done' }, { id: 't-3' }],
  }
  assert.equal(nextStatusOf(state, 't-1'), 'review')
  assert.equal(nextStatusOf(state, 't-2'), null)
  assert.equal(nextStatusOf(state, 't-3'), null)
  assert.equal(nextStatusOf(state, 'missing'), null)
})

test('palette: forgetting recents clears only the stored key', async () => {
  const { forgetRecents, RECENT_ACTIONS_KEY } = await import('../web/src/studio/palette.js')
  const removed = []
  const previous = globalThis.localStorage
  globalThis.localStorage = { removeItem: (key) => removed.push(key), getItem: () => null, setItem: () => {} }
  try {
    forgetRecents()
    assert.deepEqual(removed, [RECENT_ACTIONS_KEY])
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
})

test('palette: a column plan lists its cards and the next column', async () => {
  const { columnPlan } = await import('../web/src/studio/palette.js')
  const state = {
    statuses: [
      { id: 'clarify', label: '待澄清' },
      { id: 'design', label: '待方案' },
      { id: 'done', label: '已完成' },
    ],
    tasks: [
      { id: 't-1', status: 'design' },
      { id: 't-2', status: 'design' },
      { id: 't-3', status: 'clarify' },
    ],
  }
  const middle = columnPlan(state, 'design')
  assert.equal(middle.column.label, '待方案')
  assert.equal(middle.next.label, '已完成')
  assert.deepEqual(middle.ids, ['t-1', 't-2'])
  assert.equal(middle.total, 2)

  const last = columnPlan(state, 'done')
  assert.equal(last.next, null)
  assert.deepEqual(last.ids, [])
  assert.equal(last.total, 0)

  assert.equal(columnPlan(state, 'no-such-column'), null)
})

test('palette: advancing a column moves every card and reports failures', async () => {
  const { advanceColumn } = await import('../web/src/studio/palette.js')
  const state = {
    statuses: [
      { id: 'design', label: '待方案' },
      { id: 'dev_ready', label: '待开发' },
    ],
    tasks: [
      { id: 't-1', code: 'DEV-001', title: '退款对账', status: 'design' },
      { id: 't-2', code: 'DEV-002', title: '积分抵扣', status: 'design' },
    ],
  }
  const calls = []
  const api = async (path, body) => {
    calls.push({ path, body })
    if (body.id === 't-2') throw new Error('准出没过：清单还有 2 项没勾')
    return { ok: true }
  }
  const result = await advanceColumn({ api, state, columnId: 'design', confirm: async () => true })
  assert.equal(result.moved, 1)
  assert.equal(result.nextLabel, '待开发')
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].startsWith('DEV-002 积分抵扣'), true)
  assert.deepEqual(calls.map((entry) => entry.body), [
    { id: 't-1', status: 'dev_ready' },
    { id: 't-2', status: 'dev_ready' },
  ])

  const canceled = await advanceColumn({ api, state, columnId: 'design', confirm: async () => false })
  assert.equal(canceled.canceled, true)

  const empty = await advanceColumn({ api, state, columnId: 'dev_ready', confirm: async () => true })
  assert.equal(empty.error, '「待开发」已经是最后一列了')

  const last = await advanceColumn({
    api,
    state: { statuses: [{ id: 'design', label: '待方案' }], tasks: [{ id: 't-1', status: 'design' }] },
    columnId: 'design',
    confirm: async () => true,
  })
  assert.equal(last.error, '「待方案」已经是最后一列了')
})

test('palette: skills from the library are searchable and open the right pane', async () => {
  const { searchItems, paletteItems, filterItems } = await import('../web/src/studio/palette.js')
  const state = {
    tasks: [], requirements: [], releases: [], statuses: [], config: { experts: [], teams: [], projects: [] },
    skills: [
      { name: 'gitlab-mr-review', description: '按团队规范审 MR', tags: ['gitlab', 'review'], enabled: true, users: 1 },
      { name: 'qa-bugfix-verification', description: '缺陷复现与回归', tags: ['qa'], enabled: false, users: 2 },
    ],
  }
  const records = searchItems(state)
  assert.deepEqual(records.map((item) => item.kind), ['skill', 'skill'])
  assert.equal(records[0].label, '🧩 gitlab-mr-review')
  assert.equal(records[0].hint, '技能 · 已启用 · 1 位专家在用')
  assert.equal(records[1].hint, '技能 · 已停用 · 2 位专家在用')

  const all = paletteItems(state)
  assert.equal(filterItems(all, 'mr-review')[0].kind, 'skill')
  assert.equal(filterItems(all, '回归')[0].id, 'qa-bugfix-verification')
  assert.equal(filterItems(all, 'gitlab')[0].kind, 'skill')
  assert.equal(filterItems(all, '不存在的技能').length, 0)
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
test('palette: Ctrl/⌘+Alt shortcuts map to the right action and ignore foreign keys', async () => {
  const { paletteShortcut, isTypingTarget, SHORTCUTS } = await import('../web/src/studio/palette.js')
  const key = (over) => ({ ctrlKey: true, metaKey: false, altKey: true, shiftKey: false, key: 'n', code: 'KeyN', target: null, ...over })

  assert.equal(paletteShortcut(key()), 'new-requirement')
  assert.equal(paletteShortcut(key({ code: 'KeyT', key: 't' })), 'new-task')
  assert.equal(paletteShortcut(key({ code: 'KeyD', key: 'd' })), 'card-dispatch')
  assert.equal(paletteShortcut(key({ ctrlKey: false, metaKey: true, code: 'KeyT', key: 't' })), 'new-task')

  // 组合不对、键位不在表里、事件为空，都不认
  assert.equal(paletteShortcut(key({ altKey: false })), null)
  assert.equal(paletteShortcut(key({ shiftKey: true })), null)
  assert.equal(paletteShortcut(key({ ctrlKey: false, metaKey: false })), null)
  assert.equal(paletteShortcut(key({ code: 'KeyZ', key: 'z' })), null)
  assert.equal(paletteShortcut(null), null)
  assert.equal(paletteShortcut(undefined), null)

  // 在输入框里打字不触发；面板自己的输入框例外（面板开着时也要能切动作）
  assert.equal(paletteShortcut(key({ target: { tagName: 'TEXTAREA' } })), null)
  assert.equal(paletteShortcut(key({ target: { tagName: 'DIV', isContentEditable: true } })), null)
  const paletteInput = { tagName: 'INPUT', getAttribute: (name) => (name === 'data-palette-input' ? '1' : null) }
  assert.equal(paletteShortcut(key({ target: paletteInput })), 'new-requirement')

  // 物理键位优先：macOS 上 Option+字母会变成变音字符，event.key 不可靠
  assert.equal(paletteShortcut(key({ key: 'Dead', code: 'KeyN' })), 'new-requirement')

  // 标签必须和真正认的组合一致，别写着 Ctrl+Shift 却只认 Ctrl+Alt
  assert.equal(SHORTCUTS.length, 3)
  for (const entry of SHORTCUTS) assert.match(entry.label, /^Ctrl\/⌘\+Alt\+[A-Z]$/)
  assert.equal(isTypingTarget(null), false)
  assert.equal(isTypingTarget({ tagName: 'input' }), true)
})

test('palette: actions carry their shortcut so a row can print it', async () => {
  const { actionItems, filterItems } = await import('../web/src/studio/palette.js')
  const items = actionItems()
  const byId = new Map(items.map((item) => [item.id, item]))
  assert.equal(byId.get('new-requirement').shortcut, 'Ctrl/⌘+Alt+N')
  assert.equal(byId.get('new-task').shortcut, 'Ctrl/⌘+Alt+T')
  assert.equal(byId.get('card-dispatch').shortcut, 'Ctrl/⌘+Alt+D')
  assert.equal(byId.get('tab:board').shortcut, undefined)
  // 快捷键也要能被搜到，输 "alt" 能命中带快捷键的动作
  assert.ok(filterItems(items, 'alt').some((item) => item.id === 'new-task'))
})

