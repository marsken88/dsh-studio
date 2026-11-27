// 发布门禁：审批现在是 blocker，不再是「提示一下」。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { configureReleasesRoutes, handleReleasesRoute } from '../src/host/routes/releases.js'
import { SecretStore, StudioStore } from '../src/host/store.js'
import { releaseGate, releaseNotes } from '../src/host/release-model.js'

const task = {
  id: 't-1', code: 'DEV-1', title: '库存预占', type: 'dev', status: 'done',
  releaseId: 'r-1', requirementId: 'req-1', blocked: null, cases: [{ id: 'c1', title: '接口', result: 'pass' }],
  artifacts: [{ id: 'a1', title: '方案', content: '正文' }],
}
const requirement = { id: 'req-1', code: 'REQ-2026-001', title: '库存预占', status: 'active' }
const state = { tasks: [task], requirements: [requirement], config: { environments: [], releaseRules: {} } }
const release = {
  id: 'r-1', version: 'v1.0.0', name: '库存预占上线', owner: '',
  tagName: 'v1.0.0', status: 'draft', plannedAt: 0, releasedAt: 0,
  smoke: [{ id: 's1', text: '核心链路冒烟', done: true }],
  approvals: [],
}

test('releaseGate：没审批就是 blocker，ready=false', () => {
  const gate = releaseGate(state, { ...release })
  assert.equal(gate.ready, false)
  assert.match(gate.blockers.join(' '), /发布审批/)
  assert.equal(gate.stats.approvals, 0)
})

test('releaseGate：有人审批且其它条件都满足才 ready', () => {
  const approved = { ...release, approvals: [{ id: 'ap-1', by: '产品负责人', role: 'release', at: 1, note: '验收通过' }] }
  const gate = releaseGate(state, approved)
  assert.deepEqual(gate.blockers, [], '审批补齐后不该还有 blocker：' + gate.blockers.join('；'))
  assert.equal(gate.ready, true)
  assert.equal(gate.stats.approvals, 1)
})

test('releaseGate：已发布的版本不再 ready（防止重复发布）', () => {
  const released = { ...release, status: 'released', approvals: [{ id: 'ap-1', by: '人', at: 1, note: '' }] }
  assert.equal(releaseGate(state, released).ready, false)
})

test('/release/save 不能手写「已发布 / 已回滚」：发布门禁只能由发布/回滚动作触发', async () => {
  configureReleasesRoutes({
    readJsonBody: async req => req.body ?? {},
    sendJson: (res, status, payload) => { res.status = status; res.body = payload },
    publicState: () => ({ revision: 1 }),
  })
  const dir = mkdtempSync(join(tmpdir(), 'dsh-release-status-'))
  const store = new StudioStore(join(dir, 'state.json'), { dbFile: join(dir, 'state.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  const call = body => {
    const res = {}
    return handleReleasesRoute({
      method: 'POST', route: '/release/save',
      req: { body }, res, store, url: new URL('http://x/release/save'),
    }).then(handled => ({ handled, res }))
  }
  try {
    await store.ready
    await assert.rejects(() => call({ release: { version: 'v9.9.9', name: '绕过', status: 'released' } }), /只能由「发布」或「回滚」动作写入/)
    await assert.rejects(() => call({ release: { version: 'v9.9.8', name: '绕过', status: 'rolled_back' } }), /只能由「发布」或「回滚」动作写入/)

    const created = await call({ release: { version: 'v9.9.9', name: '正常', status: 'draft' } })
    assert.equal(created.res.status, 200)
    const id = created.res.body.release.id
    await assert.rejects(() => call({ release: { id, status: 'released' } }), /只能由「发布」或「回滚」动作写入/)
    const approved = await call({ release: { id, status: 'approved' } })
    assert.equal(approved.res.body.release.status, 'approved', '草稿 → 已审批仍可保存')
  } finally {
    store.db?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('releaseNotes：按需求与卡类型分组，能直接贴群里', () => {
  const text = releaseNotes(state, release)
  assert.match(text, /^# v1\.0\.0 库存预占上线/m)
  assert.match(text, /## 需求（1 条）/)
  assert.match(text, /REQ-2026-001 库存预占/)
  assert.match(text, /## 研发/)
  assert.match(text, /DEV-1 库存预占/)
})

test('releaseGate：approvable 只看「除审批外」的门禁（审批动作不能死锁）', () => {
  const draft = releaseGate(state, { ...release })
  assert.equal(draft.approvable, true, '只缺审批时应该允许点审批')
  assert.equal(draft.ready, false, '但还不能发布')
  const openTask = releaseGate({ ...state, tasks: [{ ...task, status: 'dev' }] }, { ...release })
  assert.equal(openTask.approvable, false, '还有别的 blocker 时审批也该拦住')
  const approved = releaseGate(state, { ...release, approvals: [{ id: 'ap-1', by: '人', at: 1, note: '' }] })
  assert.equal(approved.approvable, true)
  const approveAction = releaseGate(state, { ...release }, { ignoreApproval: true })
  assert.equal(approveAction.ready, true, '审批动作只看除审批外的门禁，否则死锁')
  const approveWithOpen = releaseGate({ ...state, tasks: [{ ...task, status: 'dev' }] }, { ...release }, { ignoreApproval: true })
  assert.equal(approveWithOpen.ready, false, '其它门禁没过时审批也要拦')
})
