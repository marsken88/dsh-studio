// 验收条件这条线：拆卡继承 → 用例挂条件 → 矩阵逐条判。
// 以前的 bug：功能点里任意一条用例通过，就把所有验收条件标成 covered（"5/5" 可能只对应 1 条用例）。
import assert from 'node:assert/strict'
import test from 'node:test'

import { checklistFromAcceptance, appendPointAcceptance, pointAcceptanceGap } from '../src/host/acceptance.js'
import { requirementMatrix } from '../src/host/executor.js'
import { sanitizeCase } from '../src/host/domain.js'
import { caseNeedsRerun, requirementDocUpdatedAt } from '../src/host/impact.js'

const point = {
  id: 'p1',
  title: '登录失败锁定',
  acceptance: [
    { id: 'a1', text: '连续 5 次错误后第 6 次返回 423', done: false },
    { id: 'a2', text: '锁定期内正确密码也返回 423', done: false },
  ],
  status: 'active',
  priority: 'p1',
}
const requirement = { id: 'r1', code: 'REQ-1', title: '登录', points: [point], status: 'active' }

test('矩阵：证据型条件（声明 evidence.kind）按该功能点已交付的交付物判覆盖', () => {
  const evidencePoint = {
    id: 'p1',
    title: '登录失败锁定',
    acceptance: [
      { id: 'a1', text: '连续 5 次错误后第 6 次返回 423', done: false },
      { id: 'a2', text: 'QA 测试报告：三层收口结论', done: false, evidence: { kind: 'report', note: '过程证据，写不成用例' } },
    ],
  }
  const req = { id: 'r1', code: 'REQ-1', title: '登录', points: [evidencePoint], status: 'active' }
  const card = {
    id: 't1', code: 'DEV-001', title: '登录失败次数', requirementId: 'r1', pointId: 'p1', status: 'done',
    cases: [{ id: 'c1', title: '第 6 次 423', result: 'pass', acceptanceId: 'a1', pointId: 'p1' }],
    artifacts: [],
  }
  const withCase = requirementMatrix({ config: {}, requirements: [req], tasks: [card] }, req)
  const a2Before = withCase.points[0].acceptance.find(item => item.id === 'a2')
  assert.equal(a2Before.covered, false, '没有交付物时证据型条件不算覆盖')

  /* match 约束：同一功能点上有好几份报告时，只认标题里带这个词的那份 */
  const strictReq = {
    id: 'r1', code: 'REQ-1', title: '登录', status: 'active',
    points: [{
      id: 'p1', title: '登录失败锁定',
      acceptance: [{ id: 'a1', text: 'QA 测试报告：三层收口结论', evidence: { kind: 'report', match: '测试报告' } }],
    }],
  }
  const wrongReport = requirementMatrix({
    config: {}, requirements: [strictReq],
    tasks: [{ ...card, artifacts: [{ id: 'x2', kind: 'report', title: '产品验收报告', status: 'delivered' }] }],
  }, strictReq)
  assert.equal(wrongReport.points[0].acceptance[0].covered, false, '标题不带 match 词的报告不算')
  const rightReport = requirementMatrix({
    config: {}, requirements: [strictReq],
    tasks: [{ ...card, artifacts: [{ id: 'x3', kind: 'report', title: 'QA 测试报告：三层收口', status: 'delivered' }] }],
  }, strictReq)
  assert.equal(rightReport.points[0].acceptance[0].covered, true, '标题带 match 词才算')

  const withReport = requirementMatrix({
    config: {},
    requirements: [req],
    tasks: [{ ...card, artifacts: [{ id: 'x1', kind: 'report', title: 'QA 三层收口报告', status: 'delivered' }] }],
  }, req)
  const a2After = withReport.points[0].acceptance.find(item => item.id === 'a2')
  assert.equal(a2After.covered, true, '交付物已交付 → 覆盖')
  assert.match(String(a2After.evidenceHit ?? ''), /收口报告/, '要说清是哪份交付物')
  assert.equal(withReport.points[0].covered, true, '两条都覆盖，功能点算覆盖')
})

test('矩阵：只有挂在某条验收条件上的通过用例才算覆盖', () => {
  const state = {
    config: {},
    requirements: [requirement],
    tasks: [{
      id: 't1', code: 'DEV-001', title: '登录失败次数', requirementId: 'r1', pointId: 'p1', status: 'test',
      cases: [
        { id: 'c1', title: '第 6 次 423', result: 'pass', acceptanceId: 'a1', pointId: 'p1' },
        { id: 'c2', title: '锁定期正确密码', result: 'pending', acceptanceId: 'a2', pointId: 'p1' },
      ],
    }],
  }
  const matrix = requirementMatrix(state, requirement)
  const [line1, line2] = matrix.points[0].acceptance
  assert.equal(line1.covered, true, 'a1 有通过用例 → 覆盖')
  assert.equal(line2.covered, false, 'a2 只有 pending 用例 → 不算覆盖')
  assert.equal(matrix.points[0].unmappedCases, 0)
})

test('矩阵：没挂验收条件的通过用例不算任何条件的覆盖', () => {
  const state = {
    config: {},
    requirements: [requirement],
    tasks: [{
      id: 't1', code: 'DEV-001', title: '登录失败次数', requirementId: 'r1', pointId: 'p1', status: 'test',
      cases: [{ id: 'c1', title: '随手写的用例', result: 'pass', acceptanceId: '', pointId: 'p1' }],
    }],
  }
  const matrix = requirementMatrix(state, requirement)
  assert.equal(matrix.points[0].acceptance.every(item => item.covered === false), true, '一条都不算覆盖')
  assert.equal(matrix.points[0].unmappedCases, 1, '没挂条件的用例要单独数出来')
  assert.equal(matrix.points[0].covered, false, '功能点整体不能算覆盖')
})

test('用例形状：acceptanceId 能存下来（不然重启就丢了）', () => {
  const saved = sanitizeCase({ title: '第 6 次 423', acceptanceId: 'a1' }, 0)
  assert.equal(saved.acceptanceId, 'a1')
  assert.equal(sanitizeCase({ title: 'x' }, 0).acceptanceId, '')
})

test('拆卡：功能点的验收条件原样变成卡的验收清单（id 保持一致）', () => {
  const checklist = checklistFromAcceptance(point.acceptance)
  assert.equal(checklist.length, 2, '两条验收条件 → 两条清单项')
  assert.deepEqual(checklist.map(item => item.id), ['a1', 'a2'], 'id 要跟需求上的一致，矩阵才认得出')
  assert.match(checklist[0].text, /423/)
  assert.equal(checklist.every(item => item.done === false), true, '新拆出来的卡一项都没勾')
  assert.deepEqual(checklistFromAcceptance(undefined), [], '没有验收条件时返回空数组（路由会退回模板）')
  assert.deepEqual(checklistFromAcceptance(['纯文本条件']).map(item => item.text), ['纯文本条件'], '字符串也能收')
})

test('文档改版：只标「通过过、但最后一次执行早于文档更新」的用例', () => {
  const withDocs = {
    ...requirement,
    docs: [
      { id: 'd1', kind: 'prd', title: 'PRD', at: 2000, content: 'x' },
      { id: 'd2', kind: 'acceptance', title: '验收标准', at: 3000, content: 'y' },
      { id: 'd3', kind: 'other', title: '别的', at: 9000, content: 'z' },
    ],
  }
  assert.equal(requirementDocUpdatedAt(withDocs), 3000, '只认 PRD / 验收标准，其它文档不算')
  assert.equal(requirementDocUpdatedAt({ ...requirement, docs: [] }), 0)
  assert.equal(caseNeedsRerun({ result: 'pass', lastRun: { at: 2000 } }, 3000), true, '通过过且早于文档 → 需复跑')
  assert.equal(caseNeedsRerun({ result: 'pass', lastRun: { at: 4000 } }, 3000), false, '文档后又跑过 → 不用复跑')
  assert.equal(caseNeedsRerun({ result: 'pass', at: 1000 }, 3000), true, '没有执行记录就用登记时间比')
  assert.equal(caseNeedsRerun({ result: 'fail', lastRun: { at: 1000 } }, 3000), false, '失败用例本来就在待办里')
  assert.equal(caseNeedsRerun({ result: 'pass', lastRun: { at: 1000 } }, 0), false, '没有文档时间就不标')
})

test('矩阵：staleCases 按用例算，summary 汇总', () => {
  const withDocs = {
    ...requirement,
    docs: [{ id: 'd1', kind: 'prd', title: 'PRD', at: 3000, content: 'x' }],
  }
  const state = {
    config: {},
    requirements: [withDocs],
    tasks: [{
      id: 't1', code: 'DEV-001', title: '登录失败次数', requirementId: 'r1', pointId: 'p1', status: 'test',
      cases: [
        { id: 'c1', title: '旧口径', result: 'pass', acceptanceId: 'a1', pointId: 'p1', lastRun: { at: 2000 } },
        { id: 'c2', title: '新口径', result: 'pass', acceptanceId: 'a2', pointId: 'p1', lastRun: { at: 4000 } },
      ],
    }],
  }
  const matrix = requirementMatrix(state, withDocs)
  assert.equal(matrix.points[0].cases.stale, 1, '只有 c1 需要复跑')
  assert.equal(matrix.summary.staleCases, 1)
})

// 2026-11-26 真机：产品在卡上补了 8 条清单，需求里 p2 仍是 0 条验收，协作链标黄、需求级准出被拦。
// 卡与功能点是两处数据，得有回写与提醒。

test('回写功能点：卡上补的清单项也会进需求的 acceptance（重复不写）', () => {
  const state = { requirements: [{ id: 'req-1', points: [{ id: 'p2', acceptance: [] }] }] }
  const task = { id: 't-1', requirementId: 'req-1', pointId: 'p2' }
  assert.equal(appendPointAcceptance(state, task, '审批人要记录'), true)
  assert.equal(appendPointAcceptance(state, task, ' 审批人要记录 '), false, '去重（忽略空白）')
  assert.equal(appendPointAcceptance(state, task, '审批时间要记录'), true)
  assert.deepEqual(state.requirements[0].points[0].acceptance.map(item => item.text), ['审批人要记录', '审批时间要记录'])
  // 没挂功能点 / 没挂需求：静默不写
  assert.equal(appendPointAcceptance(state, { id: 't-2', requirementId: 'req-1' }, 'x'), false)
  assert.equal(appendPointAcceptance(state, { id: 't-3' }, 'x'), false)
})

test('功能点没验收条件时给一句提醒（准出 warning，不是 blocker）', () => {
  const state = { requirements: [{ id: 'req-1', points: [{ id: 'p2', acceptance: [] }, { id: 'p3', acceptance: [{ text: 'A1' }] }] }] }
  assert.match(pointAcceptanceGap(state, { requirementId: 'req-1', pointId: 'p2' }), /功能点 p2 在需求里还没有验收条件/)
  assert.equal(pointAcceptanceGap(state, { requirementId: 'req-1', pointId: 'p3' }), '')
  assert.equal(pointAcceptanceGap(state, { requirementId: 'req-1' }), '')
})
