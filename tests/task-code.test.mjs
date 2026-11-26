// 卡片编号的三条硬规则：
//   1. 需求卡（拆卡产物，type=requirement）= 「需求编号-NN」，例如 `REQ-2026-003-01`。
//      老办法一：按「REQ-NN」编 → 每条需求下第一张卡都叫 REQ-001，7 条需求就有 7 张 REQ-001；
//      老办法二：卡号直接等于需求编号 → 同一需求拆出的卡全叫 REQ-2026-003，界面上分不清是哪一张，
//      云盘交付物文件名（`<卡编号>-<类型>-<标题>.md`）还会互相覆盖。现在两件事都要：卡号唯一 + 自带需求归属。
//   2. 其它类型按类型前缀在需求内递增：DEV-001 / TEST-001 / BUG-001 / DES-001 / OPS-001。
//   3. 同一需求内的编号在并发建卡时不能撞：临界区里要循环到真正的空位，
//      只补一次不够（一批自动缺陷会连着开几十张）。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CODE_PREFIX } from '../src/host/domain.js'
import {
  migrateRequirementTaskCodes,
  nextCodeForTask,
  nextRequirementTaskCode,
  nextTaskCode,
} from '../src/host/task-code.js'
import { SecretStore, StudioStore } from '../src/host/store.js'

test('nextTaskCode：同一需求内递增，跨需求各自从 001 开始（设计如此）', () => {
  const tasks = [
    { requirementId: 'req-a', code: 'BUG-001' },
    { requirementId: 'req-a', code: 'BUG-002' },
    { requirementId: 'req-a', code: 'DEV-001' },
    { requirementId: 'req-b', code: 'BUG-001' },
  ]
  assert.equal(nextTaskCode(tasks, 'req-a', 'BUG'), 'BUG-003')
  assert.equal(nextTaskCode(tasks, 'req-a', 'DEV'), 'DEV-002')
  assert.equal(nextTaskCode(tasks, 'req-b', 'BUG'), 'BUG-002')
  assert.equal(nextTaskCode(tasks, 'req-c', 'BUG'), 'BUG-001')
})

test('nextTaskCode：忽略别的需求的编号，不会被它们顶高', () => {
  const tasks = [{ requirementId: 'other', code: 'BUG-009' }]
  assert.equal(nextTaskCode(tasks, 'mine', 'BUG'), 'BUG-001')
})

test('nextRequirementTaskCode：需求编号 + 需求内两位序号', () => {
  const tasks = [
    { requirementId: 'req-a', code: 'REQ-2026-003-01' },
    { requirementId: 'req-a', code: 'REQ-2026-003-02' },
    { requirementId: 'req-a', code: 'BUG-001' }, // 别的类型不占用需求卡的序号
    { requirementId: 'req-b', code: 'REQ-2026-002-07' },
  ]
  assert.equal(nextRequirementTaskCode(tasks, 'req-a', 'REQ-2026-003'), 'REQ-2026-003-03')
  assert.equal(nextRequirementTaskCode(tasks, 'req-b', 'REQ-2026-002'), 'REQ-2026-002-08')
  assert.equal(nextRequirementTaskCode(tasks, 'req-c', 'REQ-2026-004'), 'REQ-2026-004-01', '新需求从 01 开始')
  // 别的需求下的同号不顶高本需求
  assert.equal(
    nextRequirementTaskCode([{ requirementId: 'other', code: 'REQ-2026-003-09' }], 'req-a', 'REQ-2026-003'),
    'REQ-2026-003-01',
  )
  assert.equal(nextRequirementTaskCode(tasks, 'req-a', ''), '', '没有需求编号就不造号')
  assert.equal(nextRequirementTaskCode(tasks, '', 'REQ-2026-003'), '', '没挂需求就没有编号')
})

test('nextRequirementTaskCode：老的「卡号=需求编号」「REQ-001」不参与序号计算', () => {
  const legacy = [
    { requirementId: 'req-a', code: 'REQ-2026-003' },
    { requirementId: 'req-a', code: 'REQ-001' },
  ]
  assert.equal(nextRequirementTaskCode(legacy, 'req-a', 'REQ-2026-003'), 'REQ-2026-003-01')
})

test('nextCodeForTask：需求卡按需求编号-NN，其它类型按类型前缀', () => {
  const tasks = [{ requirementId: 'req-a', code: 'BUG-001' }]
  assert.equal(nextCodeForTask(tasks, { requirementId: 'req-a', requirementCode: 'REQ-2026-003', type: 'requirement' }), 'REQ-2026-003-01')
  assert.equal(nextCodeForTask(tasks, { requirementId: 'req-a', requirementCode: 'REQ-2026-003', type: 'bug' }), 'BUG-002')
  assert.equal(nextCodeForTask(tasks, { requirementId: 'req-a', requirementCode: 'REQ-2026-003', type: 'test' }), 'TEST-001')
  assert.equal(nextCodeForTask(tasks, { requirementId: '', requirementCode: '', type: 'bug' }), '', '没挂需求就没有编号')
})

test('CODE_PREFIX：每种卡的前缀都在（需求卡实际用需求编号-NN，前缀只作兜底）', () => {
  for (const type of ['requirement', 'design', 'dev', 'test', 'bug', 'ops']) {
    assert.equal(typeof CODE_PREFIX[type], 'string', type)
    assert.ok(CODE_PREFIX[type].length > 0, type)
  }
  assert.equal(CODE_PREFIX.bug, 'BUG')
  assert.equal(CODE_PREFIX.dev, 'DEV')
})

test('migrateRequirementTaskCodes：按创建时间重排，保留已有序号，别的类型不碰，幂等', () => {
  const requirements = [
    { id: 'req-a', code: 'REQ-2026-001' },
    { id: 'req-b', code: 'REQ-2026-003' },
    { id: 'req-c', code: '' }, // 还没编号的需求：迁移不动它
  ]
  const tasks = [
    { id: 't3', type: 'requirement', requirementId: 'req-b', code: 'REQ-2026-003', createdAt: 300 },
    { id: 't1', type: 'requirement', requirementId: 'req-b', code: 'REQ-2026-003', createdAt: 100 },
    { id: 't2', type: 'requirement', requirementId: 'req-b', code: 'REQ-2026-003', createdAt: 200 },
    { id: 't7', type: 'requirement', requirementId: 'req-b', code: 'REQ-2026-003-07', createdAt: 350 },
    { id: 't4', type: 'requirement', requirementId: 'req-a', code: 'REQ-002', createdAt: 400 },
    { id: 't5', type: 'requirement', requirementId: 'req-a', code: 'REQ-001', createdAt: 500 },
    { id: 't6', type: 'bug', requirementId: 'req-b', code: 'BUG-001', createdAt: 50 },
    { id: 't8', type: 'requirement', requirementId: 'req-c', code: '', createdAt: 10 },
    { id: 't9', type: 'requirement', requirementId: '', code: '', createdAt: 20 },
  ]
  const byId = id => tasks.find(task => task.id === id)
  const changed = migrateRequirementTaskCodes(tasks, requirements)

  assert.deepEqual(changed.map(task => task.id).sort(), ['t1', 't2', 't3', 't4', 't5'])
  // req-b 已经有 -07：老卡从 08 接着编，顺序按 createdAt
  assert.equal(byId('t1').code, 'REQ-2026-003-08', '最早创建的排前面')
  assert.equal(byId('t2').code, 'REQ-2026-003-09')
  assert.equal(byId('t3').code, 'REQ-2026-003-10')
  assert.equal(byId('t7').code, 'REQ-2026-003-07', '已经符合格式的不动')
  // req-a 的老 REQ-001/REQ-002 换成需求编号-NN
  assert.equal(byId('t4').code, 'REQ-2026-001-01')
  assert.equal(byId('t5').code, 'REQ-2026-001-02')
  // 其它类型、没需求编号的需求、没挂需求的卡：原样
  assert.equal(byId('t6').code, 'BUG-001', '缺陷卡一根手指都不碰')
  assert.equal(byId('t8').code, '')
  assert.equal(byId('t9').code, '')

  assert.deepEqual(migrateRequirementTaskCodes(tasks, requirements), [], '第二次跑是空跑（幂等）')
})

test('撞号兜底逻辑：循环到空位时不会重复（模拟一批并发建卡）', () => {
  // 复刻 index.js createTask 临界区里那段：先按快照算号，撞了就按「当前真实列表」重算，直到空位
  for (const [type, requirementCode] of [['requirement', 'REQ-2026-003'], ['bug', 'REQ-2026-003']]) {
    const tasks = []
    const codes = []
    for (let index = 0; index < 30; index += 1) {
      // 一半的卡用「过期快照」（空列表）算号，制造撞号
      const snapshot = index % 2 === 0 ? [] : tasks.slice()
      let code = nextCodeForTask(snapshot, { requirementId: 'req-x', requirementCode, type })
      let guard = 0
      while (new Set(tasks.map(task => String(task.code ?? ''))).has(code) && guard < 1000) {
        code = nextCodeForTask(tasks, { requirementId: 'req-x', requirementCode, type })
        guard += 1
      }
      codes.push(code)
      tasks.push({ requirementId: 'req-x', code })
    }
    assert.equal(new Set(codes).size, codes.length, `${type} 编号撞了：${codes.join(',')}`)
  }
})

test('store 升级：老库里的需求卡编号迁成「需求编号-NN」，缺陷卡与未挂需求的卡不动', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-studio-cardcode-'))
  const file = join(dir, 'dsh-studio.json')
  const now = Date.now()
  const card = (id, type, requirementId, code, createdAt) => ({
    id, type, requirementId, code, title: `（自检）${id}`, status: 'dev', role: 'dev',
    createdAt, updatedAt: createdAt, checklist: [], cases: [], artifacts: [], comments: [], history: [],
  })
  writeFileSync(file, JSON.stringify({
    revision: 1,
    updatedAt: now,
    // schema 8 = 升级前的库：卡号还是「等于需求编号」或老的 REQ-00N
    config: { schema: 8 },
    requirements: [
      { id: 'req-a', code: 'REQ-2026-001', title: '老需求', status: 'active', points: [], docs: [], history: [], pool: null, review: null },
      { id: 'req-b', code: 'REQ-2026-003', title: '新需求', status: 'active', points: [], docs: [], history: [], pool: null, review: null },
    ],
    tasks: [
      card('t-a1', 'requirement', 'req-a', 'REQ-001', now - 5000),
      card('t-b1', 'requirement', 'req-b', 'REQ-2026-003', now - 3000),
      card('t-b2', 'requirement', 'req-b', 'REQ-2026-003', now - 2000),
      card('t-bug', 'bug', 'req-b', 'BUG-001', now - 1000),
      card('t-loose', 'requirement', '', '', now - 500),
    ],
    releases: [],
    audit: [],
  }), 'utf8')

  const store = new StudioStore(file, { dbFile: join(dir, 'dsh-studio.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  try {
    await store.ready
    const byId = id => store.snapshot().tasks.find(task => task.id === id)
    assert.equal(store.snapshot().config.schema, 9, 'schema 迁到 9')
    assert.equal(byId('t-a1').code, 'REQ-2026-001-01', '老的 REQ-001 也换成需求编号-NN')
    assert.equal(byId('t-b1').code, 'REQ-2026-003-01', '同一需求的两张卡不再同名')
    assert.equal(byId('t-b2').code, 'REQ-2026-003-02')
    assert.equal(byId('t-bug').code, 'BUG-001', '缺陷卡编号不受影响')
    assert.equal(byId('t-loose').code, '', '没挂需求的卡仍然没有编号')
  } finally {
    try { store.db?.close?.() } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('三个建号口都走 nextCodeForTask（建卡 / 换需求 / 老库补号），不再直接抄需求编号', () => {
  const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const executorSource = readFileSync(new URL('../src/host/executor.js', import.meta.url), 'utf8')
  const storeSource = readFileSync(new URL('../src/host/store.js', import.meta.url), 'utf8')

  assert.match(indexSource, /code: nextCodeForTask\(store\.snapshot\(\)\.tasks, \{ requirementId, requirementCode, type \}\)/, '建卡入口')
  assert.match(indexSource, /nextCodeForTask\(state\.tasks, \{ requirementId: task\.requirementId, requirementCode: requirementCodeNow, type: task\.type \}\)/, '并发撞号兜底')
  assert.doesNotMatch(indexSource, /\?\.code \?\? nextTaskCode\(store\.snapshot\(\)\.tasks, requirementId, 'REQ'\)/, '不再把需求编号直接当卡编号')
  assert.match(executorSource, /nextCodeForTask\(others, \{ requirementId: normalized\.requirementId/, '换需求时重新编号')
  assert.match(storeSource, /nextCodeForTask\(this\.state\.tasks, \{ requirementId: task\.requirementId/, '老库补号')
  assert.match(storeSource, /migrateRequirementTaskCodes\(this\.state\.tasks, this\.state\.requirements\)/, '启动时迁移老需求卡编号')
})

test('clearDeletedReferences：删卡后清掉别人指向它的父卡/重复标记', async () => {
  const { clearDeletedReferences } = await import('../src/host/domain.js')
  const tasks = [
    { id: 'a', parent: 'gone', duplicateOf: '' },
    { id: 'b', parent: '', duplicateOf: 'gone' },
    { id: 'c', parent: 'a', duplicateOf: '' },
  ]
  const touched = clearDeletedReferences(tasks, 'gone')
  assert.equal(touched.length, 2)
  assert.equal(tasks[0].parent, '', '父卡被删 → 清空')
  assert.equal(tasks[1].duplicateOf, '', '重复标记指向被删卡 → 清空')
  assert.equal(tasks[2].parent, 'a', '指向别人的不动')
  assert.deepEqual(clearDeletedReferences(tasks, ''), [], '空 id 不动任何东西')
})
