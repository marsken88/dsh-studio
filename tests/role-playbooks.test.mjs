// 四棒工作手册（产品 / 架构 / 研发 / 评审）：角色提示词、列专属 playbook、协作约定，以及
// 「功能点没有可判定验收条件就不许拆卡」的闸门。这一组钉住「专家更像各司其职的专家」。
import assert from 'node:assert/strict'
import test from 'node:test'

import { COLLABORATION_BRIEF, DEFAULT_ROLES, rolePlaybookFor } from '../src/host/role-playbooks.js'
import { splitRequirement } from '../src/host/split.js'

test('默认角色提示词：每个角色都写清「负责什么 + 交付什么 + 和谁交接」', () => {
  assert.match(DEFAULT_ROLES.product.prompt, /六段/)
  assert.match(DEFAULT_ROLES.product.prompt, /可判定/)
  assert.match(DEFAULT_ROLES.product.prompt, /@架构师/)
  assert.match(DEFAULT_ROLES.architect.prompt, /接口契约/)
  assert.match(DEFAULT_ROLES.architect.prompt, /给测试的预习/)
  assert.match(DEFAULT_ROLES.dev.prompt, /改动映射/)
  assert.match(DEFAULT_ROLES.dev.prompt, /studio_task_coding/)
  assert.match(DEFAULT_ROLES.qa.prompt, /三条线/)
})

test('协作约定：先读上游、回应未决、给下一棒三句话、@对方而不是代做', () => {
  assert.match(COLLABORATION_BRIEF, /先读上游/)
  assert.match(COLLABORATION_BRIEF, /未决/)
  assert.match(COLLABORATION_BRIEF, /三句话/)
  assert.match(COLLABORATION_BRIEF, /@/)
  assert.match(COLLABORATION_BRIEF, /handoff/)
})

test('产品手册：带「当前需求缺什么」的事实，缺验收条件要点名', () => {
  const requirement = {
    code: 'REQ-2026-001',
    points: [
      { id: 'p1', title: '有验收', acceptance: [{ id: 'a1', text: '返回 200' }] },
      { id: 'p2', title: '没验收', acceptance: [] },
    ],
    discovery: { server: '有服务端', auth: '', boundary: '后端接口' },
    questions: [{ status: 'open', text: '锁定多久？' }],
  }
  const text = rolePlaybookFor('clarify', {}, requirement)
  assert.match(text, /六段/)
  assert.match(text, /可判定/)
  assert.match(text, /缺验收条件的功能点.*p2/)
  assert.match(text, /澄清三问还缺：谁做鉴权/)
  assert.match(text, /待确认问题 1 个/)
})

test('架构手册：方案要素 + 给测试的测试线建议 + 当前定案状态', () => {
  const task = { design: { status: 'approved', chosenId: 'd2', drafts: [{ id: 'd2', name: '方案二' }], note: '' } }
  const text = rolePlaybookFor('design', task, undefined)
  for (const keyword of ['改动边界', '数据模型与迁移', '接口契约', '失败与回滚', '并发与一致性', '性能与容量', '兼容与灰度', '备选方案']) {
    assert.match(text, new RegExp(keyword), `方案要素缺 ${keyword}`)
  }
  assert.match(text, /unit \/ integration \/ e2e/)
  assert.match(text, /定案「方案二」/)
})

test('研发手册：改动映射 + 分层自测 + 执行记录与当前执行状态', () => {
  const task = {
    design: { chosenId: 'd1', drafts: [{ id: 'd1', name: '方案一' }] },
    coding: { branch: 'feat/x', commits: [{ sha: 'abc' }], files: [{ path: 'a.js' }], unitTests: { total: 3, passed: 3 }, review: { status: 'pending' } },
    quality: { ok: true },
  }
  const text = rolePlaybookFor('dev', task, undefined)
  assert.match(text, /改动映射/)
  assert.match(text, /分层自测/)
  assert.match(text, /studio_task_coding/)
  assert.match(text, /分支 feat\/x/)
  assert.match(text, /单测 3\/3/)
  assert.match(text, /项目检查：通过/)
})

test('评审手册：四层检查 + 对照执行记录，给可执行结论', () => {
  const task = { coding: { branch: 'feat/x', commits: [{}, {}], files: [{}, {}], unitTests: { total: 4, passed: 4 } }, quality: { ok: false } }
  const text = rolePlaybookFor('review', task, undefined)
  assert.match(text, /正确性/)
  assert.match(text, /边界与异常/)
  assert.match(text, /可读性与一致性/)
  assert.match(text, /性能与安全/)
  assert.match(text, /2 提交 · 2 个文件/)
  assert.match(text, /项目检查：不通过/)
})

test('未知列不注入角色手册（不误伤自定义列）', () => {
  assert.equal(rolePlaybookFor('custom', {}, undefined), '')
})

// ---------------------------------------------------------------- 拆卡闸门
const baseRequirement = acceptance => ({
  id: 'req-1',
  code: 'REQ-2026-009',
  title: '测试需求',
  status: 'active',
  review: { status: 'approved' },
  discovery: { server: '有服务端', auth: '已有登录', boundary: '后端接口' },
  points: [{ id: 'p1', title: '登录锁定', acceptance }],
})

const fakeStore = (requirement, config = { requirementGate: { requireAcceptance: true } }) => ({
  snapshot: () => ({ config, tasks: [], requirements: [requirement] }),
})

test('拆卡闸门：功能点没有验收条件时拒绝拆卡，并点名是哪个功能点', async () => {
  const store = fakeStore(baseRequirement([]))
  await assert.rejects(
    splitRequirement(store, { id: 'req-1' }, async () => { throw new Error('不该建卡') }),
    /还没有可判定的验收条件.*p1 登录锁定/,
  )
})

test('拆卡闸门：有验收条件就放行（建卡拿到清单继承）', async () => {
  const store = fakeStore(baseRequirement([{ id: 'a1', text: '第 5 次失败返回 429' }]))
  const created = []
  const result = await splitRequirement(store, { id: 'req-1' }, async (_store, input) => {
    created.push(input)
    return { id: 't-1', ...input }
  })
  assert.equal(result.created.length, 1)
  assert.equal(result.created[0].pointId, 'p1')
  assert.deepEqual(result.created[0].checklist.map(item => item.text), ['第 5 次失败返回 429'])
})

test('拆卡闸门：显式关掉 requireAcceptance 时允许拆（存量需求逃生舱）', async () => {
  const store = fakeStore(baseRequirement([]), { requirementGate: { requireAcceptance: false } })
  const result = await splitRequirement(store, { id: 'req-1' }, async (_store, input) => ({ id: 't-1', ...input }))
  assert.equal(result.created.length, 1)
})
