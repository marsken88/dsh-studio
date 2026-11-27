// P1 三条的契约测试：评审进准出、禁自评、签字来源
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveSigner } from '../src/host/access.js'
import { isSelfReview } from '../src/host/quality.js'
import { configureExecutor, taskExitGate, updateTask } from '../src/host/executor.js'
import { SecretStore, StudioStore } from '../src/host/store.js'

configureExecutor(new Proxy({}, { get: () => () => undefined }))

const baseCard = {
  id: 't-1', code: 'DEV-001', title: '登录锁定', status: 'accept',
  cases: [{ id: 'c1', title: 'x', result: 'pass', http: { url: '/x', expectStatus: 200 } }],
  checklist: [], artifacts: [{ kind: 'doc', title: '报告', status: 'ready' }],
  blocked: null, gitlabMR: null,
  signoff: { by: '张三', at: 1, note: '人看过', actorKind: 'human' },
}
const gate = card => taskExitGate({ tasks: [card], config: { experts: [] } }, card)
const blocked = (result, keyword) => result.blockers.some(item => item.includes(keyword))

test('准出：代码评审没给结论就拦（以前 review 完全不参与准出）', () => {
  const pending = { ...baseCard, coding: { agent: '开发工程师', review: { status: 'pending', by: '', at: 0, note: '' } } }
  assert.equal(blocked(gate(pending), '代码评审还没给出结论'), true, 'pending 要拦')
  const empty = { ...baseCard, coding: { agent: '开发工程师', review: null } }
  assert.equal(blocked(gate(empty), '代码评审'), true, '没有评审记录也要拦')
  const rejected = { ...baseCard, coding: { agent: '开发工程师', review: { status: 'changes_requested', by: '架构师', at: 1, note: '接口没做幂等' } } }
  assert.equal(blocked(gate(rejected), '代码评审要改'), true, 'changes_requested 要拦')
  const approved = { ...baseCard, coding: { agent: '开发工程师', review: { status: 'approved', by: '架构师', at: 1, note: 'ok' } } }
  assert.equal(blocked(gate(approved), '代码评审'), false, 'approved 放行')
  const noCoding = { ...baseCard, coding: null }
  assert.equal(blocked(gate(noCoding), '代码评审'), false, '没有执行记录的卡不受这条影响')
})

test('禁自评：作者与评审人是同一个（或名字互相包含）就算自评', () => {
  assert.equal(isSelfReview('开发工程师', '开发工程师'), true)
  assert.equal(isSelfReview('开发', '开发工程师'), true, '名字互相包含也算')
  assert.equal(isSelfReview('开发工程师', '架构师'), false)
  assert.equal(isSelfReview('', '架构师'), false, '没有作者信息时不算（老记录）')
  assert.equal(isSelfReview('开发工程师', ''), false)
})

test('签字来源：登录会话优先于请求体自报', () => {
  assert.deepEqual(resolveSigner({ session: 'admin', body: '李四' }), { by: 'admin', source: 'session' })
  assert.deepEqual(resolveSigner({ header: 'proxy-user', body: '李四' }), { by: 'proxy-user', source: 'header' })
  assert.deepEqual(resolveSigner({ body: '李四' }), { by: '李四', source: 'body' }, '免登录单机模式才轮到自报')
  assert.deepEqual(resolveSigner({}), { by: '人', source: 'none' })
  assert.deepEqual(resolveSigner({ session: '  ', body: ' 李四 ' }), { by: '李四', source: 'body' }, '空白当没有')
})

test('签字路由：override 必须声明在 store.mutate 之前（0.4.0~0.9.0 之间这里一直是运行时 ReferenceError）', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../src/host/routes/requirements.js', import.meta.url), 'utf8')
  const declared = source.indexOf('const override = String(body.override')
  const used = source.indexOf('if (override !== \'\') target.override')
  assert.ok(declared > 0, '签字路由里应该有 override 声明')
  assert.ok(used > 0, '签字路由里应该用 override 写记录')
  assert.ok(declared < used, 'override 必须先声明再使用（以前声明在 if 块里，mutate 里用会 ReferenceError）')
})

// issue #9 第 3 条：评审闸门以前只在「已完成」检查，待评审→待测试直接放行。
test('评审闸门：进待测试之前代码评审必须有结论（默认开）', async () => {
  const { reviewGate } = await import('../src/host/quality.js')
  const pending = { coding: { review: { status: 'pending' } } }
  const approved = { coding: { review: { status: 'approved' } } }
  const changes = { coding: { review: { status: 'changes_requested', note: '接口没做幂等' } } }

  const on = { reviewGate: { enabled: true } }
  assert.equal(reviewGate(on, pending, 'test').needed, true)
  assert.equal(reviewGate(on, pending, 'test').ready, false)
  assert.match(reviewGate(on, pending, 'test').blockers.join(), /还没通过/)
  assert.equal(reviewGate(on, changes, 'test').ready, false)
  assert.match(reviewGate(on, changes, 'test').blockers.join(), /要求修改/)
  assert.equal(reviewGate(on, approved, 'test').ready, true, '评审通过就放行')
  assert.equal(reviewGate(on, pending, 'review').needed, false, '别的列不管')
  assert.equal(reviewGate(on, { coding: null }, 'test').ready, false, '没有执行记录也要拦')

  // 默认（配置里没写）= 开；显式 false 才关
  assert.equal(reviewGate({}, pending, 'test').needed, true, '默认就生效，不写配置不算关')
  assert.equal(reviewGate({ reviewGate: { enabled: false } }, pending, 'test').needed, false, '显式关掉才不拦')
  assert.equal(reviewGate({ reviewGate: { enabled: true, columns: ['accept'] } }, pending, 'test').needed, false, '换列也认')
})

test('评审闸门配置：默认开、显式 false 才关、columns 回落 test', async () => {
  const { sanitizeReviewGate } = await import('../src/host/domain.js')
  assert.deepEqual(sanitizeReviewGate(undefined), { enabled: true, columns: ['test'] })
  assert.deepEqual(sanitizeReviewGate(null), { enabled: true, columns: ['test'] })
  assert.equal(sanitizeReviewGate({ enabled: false }).enabled, false, '只有显式 false 才算关')
  assert.equal(sanitizeReviewGate({ enabled: 'false' }).enabled, true, '字符串不算关，免得配错静默关掉闸门')
  assert.deepEqual(sanitizeReviewGate({ columns: [] }).columns, ['test'], '空数组回落到默认列')
  assert.deepEqual(sanitizeReviewGate({ columns: ['accept', 'done'] }).columns, ['accept', 'done'])
})

test('设计闸门关着时，推进到闸门列要在历史里留痕（不拦，但不能没人知道）', async () => {
  const { updateTask, configureExecutor } = await import('../src/host/executor.js')
  const { StudioStore, SecretStore } = await import('../src/host/store.js')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  configureExecutor(new Proxy({ serviceDependencies: () => [], serviceConflicts: () => undefined }, { get: (t, k) => (k in t ? t[k] : () => undefined) }))
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gate-trace-'))
  const store = new StudioStore(join(dir, 'state.json'), { dbFile: join(dir, 'state.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  try {
    await store.ready
    await store.mutate(state => {
      state.config.design = { enabled: false, columns: ['dev'] }
      state.tasks.push({ id: 't-g1', code: 'DEV-001', title: 'x', status: 'design', role: 'architect', requirement: '', priority: 'normal', history: [], comments: [], checklist: [], cases: [], artifacts: [], blocked: null })
    })
    await updateTask(store, 't-g1', { status: 'dev', by: '架构师' })
    const task = store.snapshot().tasks.find(item => item.id === 't-g1')
    assert.ok((task.history ?? []).some(entry => String(entry.note ?? '').includes('设计闸门当时是关闭的')), '关着也要留痕')
  } finally {
    store.db?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('子卡没完成/没签字时，主卡不许签收（childSignoffBlockers）', async () => {
  const { childSignoffBlockers, taskExitGate } = await import('../src/host/executor.js')
  const parent = { id: 'p1', type: 'dev', status: 'accept', checklist: [], cases: [], signoff: null }
  const openBug = { id: 'b1', code: 'BUG-001', parent: 'p1', status: 'accept', signoff: null }
  const state = (tasks) => ({ tasks, config: {}, requirements: [] })

  // 子卡还在待验收 → 拦
  let blockers = childSignoffBlockers(state([parent, openBug]), parent)
  assert.equal(blockers.length, 1)
  assert.match(blockers[0], /1 张子卡没完成.*BUG-001/)

  // 子卡完成但没签字 → 也拦
  blockers = childSignoffBlockers(state([parent, { ...openBug, status: 'done', signoff: null }]), parent)
  assert.equal(blockers.length, 1)
  assert.match(blockers[0], /没验收签字/)

  // 子卡完成且签过 → 放行
  blockers = childSignoffBlockers(state([parent, { ...openBug, status: 'done', signoff: { by: '人', at: 1, note: 'ok' } }]), parent)
  assert.deepEqual(blockers, [])

  // 没有子卡 → 不拦
  assert.deepEqual(childSignoffBlockers(state([parent]), parent), [])

  // 准出门禁里也要出现这一条（agent 读到 gate 就知道该先收口子卡）
  const gate = taskExitGate(state([{ ...parent, signoff: { by: '人', at: 1, note: 'ok' } }, openBug]), parent)
  assert.ok(gate.blockers.some(line => /子卡没完成/.test(line)), JSON.stringify(gate.blockers))
})

test('同列提交不是一次推进：不清阻塞、不重跑设计/评审门禁', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-same-status-'))
  const store = new StudioStore(join(dir, 'state.json'), { dbFile: join(dir, 'state.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  try {
    await store.ready
    await store.mutate(state => {
      state.tasks.push({
        id: 't-same', code: 'DEV-009', title: '同列拖放', status: 'test', role: 'qa',
        requirementId: '', checklist: [], artifacts: [], comments: [], cases: [], history: [],
        blocked: { at: 1, by: '人', reason: '等环境' },
        coding: { agent: '', review: { status: 'pending', by: '', at: 0, note: '' } },
      })
    })
    // 目标列 = 当前列：评审门禁本来会拦（review pending），同列必须放过。
    const task = await updateTask(store, 't-same', { status: 'test', by: '人' })
    assert.equal(task.status, 'test')
    assert.notEqual(task.blocked, null, '同列提交不能顺手解除阻塞')
    assert.equal(task.history.some(entry => String(entry.note ?? '') === 'unblocked'), false, '不该写一条假的解除阻塞历史')

    // 真的换到待测试列：门禁照旧生效。
    await store.mutate(state => {
      state.tasks.push({
        id: 't-move', code: 'DEV-010', title: '真的换列', status: 'dev', role: 'dev',
        requirementId: '', checklist: [], artifacts: [], comments: [], cases: [], history: [], blocked: null,
        coding: { agent: '', review: { status: 'pending', by: '', at: 0, note: '' } },
      })
    })
    await assert.rejects(() => updateTask(store, 't-move', { status: 'test' }), /进测试被拦/)
  } finally {
    store.db?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})
