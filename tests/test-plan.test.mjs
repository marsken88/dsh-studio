// 三层测试（单元 / 集成 / 端到端）：层级推断、进度汇总、缺口判定、测试计划、准出门禁与提示词。
// 这一组是「测全面」的尺子：用例能跑但没有分层，等于只验了一条线。
import assert from 'node:assert/strict'
import test from 'node:test'

import { configureDispatcher, buildExpertPrompt } from '../src/host/dispatcher.js'
import { configureExecutor, taskExitGate } from '../src/host/executor.js'
import { publicCases, sanitizeCase } from '../src/host/domain.js'
import {
  applyTierDeclarations,
  inferTier,
  planLine,
  sanitizeTestPlan,
  testPlanGaps,
  testPlanSummary,
  tierOf,
  tierRows,
} from '../src/host/test-plan.js'

configureDispatcher(new Proxy({}, { get: () => () => undefined }))
configureExecutor(new Proxy({}, { get: () => () => undefined }))

const http = (extra = {}) => ({ http: { method: 'GET', url: '/health', expectStatus: 200 }, result: 'pass', ...extra })
const shell = (command, extra = {}) => ({ shell: { command, expectExit: 0 }, result: 'pass', ...extra })
const browser = (extra = {}) => ({ browser: { url: '/' }, result: 'pass', ...extra })
const db = (extra = {}) => ({ db: { file: '/tmp/x.db', sql: 'select 1' }, result: 'pass', ...extra })

test('层级推断：按可执行定义判断，不靠用例标题', () => {
  assert.equal(inferTier(browser()), 'e2e')
  assert.equal(inferTier(http()), 'integration')
  assert.equal(inferTier({ http: { method: 'POST', url: '', steps: [{ method: 'GET', url: '/a' }] } }), 'integration', '只写 steps 的多步用例也是集成')
  assert.equal(inferTier(db()), 'integration')
  assert.equal(inferTier(shell('node --test tests/login.test.mjs')), 'unit')
  assert.equal(inferTier(shell('npm test')), 'unit')
  assert.equal(inferTier(shell('pytest -q tests/')), 'unit')
  assert.equal(inferTier(shell('npm run test:e2e')), 'e2e', 'e2e 要先命中，不能被 npm test 抢走')
  assert.equal(inferTier(shell('npx playwright test')), 'e2e')
  assert.equal(inferTier(shell('curl -s http://127.0.0.1:8080/api/x')), 'integration', 'curl 打接口本质是集成')
  assert.equal(inferTier(shell('echo hello')), 'other')
  assert.equal(inferTier({ title: '只有标题的草稿' }), 'other', '跑不了的用例不进任何一层')
})

test('层级：显式 tier 优先于推断，非法值当没写', () => {
  assert.equal(tierOf({ ...shell('echo hi'), tier: 'e2e' }), 'e2e')
  assert.equal(tierOf({ ...http(), tier: 'nope' }), 'integration')
  const saved = sanitizeCase({ title: 'x', tier: 'E2E', http: { method: 'GET', url: '/x', expectStatus: 200 } }, 0)
  assert.equal(saved.tier, 'e2e', '大小写归一')
  assert.equal(sanitizeCase({ title: 'y', tier: 'smoke' }, 0).tier, '', '不认识的 tier 存空串（= 自动）')
})

test('分层进度：每条线各自数通过/失败/可执行，没断言的草稿不算可执行', () => {
  const rows = tierRows([
    { ...shell('node --test a.test.mjs'), result: 'pass' },
    { title: '草稿：边界值', result: 'pending' },
    { ...http(), result: 'fail' },
    { ...browser(), result: 'pending' },
    { ...db(), result: 'pass' },
  ])
  const byTier = Object.fromEntries(rows.map(row => [row.tier, row]))
  assert.deepEqual([byTier.unit.total, byTier.unit.executable, byTier.unit.pass], [1, 1, 1])
  assert.deepEqual([byTier.integration.total, byTier.integration.executable, byTier.integration.fail], [2, 2, 1])
  assert.deepEqual([byTier.e2e.total, byTier.e2e.pending], [1, 1])
  assert.deepEqual([byTier.other.total, byTier.other.executable], [1, 0], '标题草稿落在 other 且不计可执行')
  assert.deepEqual(rows.map(row => row.tier), ['unit', 'integration', 'e2e', 'other'], '顺序固定，界面不用再排')
})

test('缺口：该有可执行用例却没有的层才算缺口；「不适用」要有理由才算', () => {
  const onlyHttp = testPlanSummary([http()], null)
  assert.deepEqual(onlyHttp.gaps.map(gap => gap.tier), ['unit', 'e2e'])
  assert.match(planLine(onlyHttp), /单元测试 通过 0\/0/)

  const excluded = testPlanSummary([http()], { excluded: { e2e: '本次只改后端接口，没有前端改动' } })
  assert.deepEqual(excluded.gaps.map(gap => gap.tier), ['unit'])
  assert.match(planLine(excluded), /端到端测试 不适用（本次只改后端接口/)

  const all = testPlanSummary([shell('npm test'), http(), browser()], null)
  assert.deepEqual(all.gaps, [], '三条线都有可执行用例就没有缺口')

  const emptyReason = sanitizeTestPlan({ excluded: { e2e: '   ' } })
  assert.equal(emptyReason, null, '空理由等于没写，不能当成「不适用」')
})

test('测试计划：声明不合法整体拒绝；applicable=true 恢复适用', () => {
  const badTier = applyTierDeclarations(null, [{ tier: 'smoke', reason: 'x' }])
  assert.equal(badTier.changed, 0)
  assert.match(badTier.errors.join(), /不认识的测试层级/)

  const noReason = applyTierDeclarations(null, [{ tier: 'unit', applicable: false }])
  assert.match(noReason.errors.join(), /必须写理由/, '没理由的「不适用」和「忘了测」分不出来')

  const ok = applyTierDeclarations(null, [{ tier: 'unit', applicable: false, reason: '纯配置改动，没有可执行代码' }], { by: '测试工程师', at: 123 })
  assert.equal(ok.changed, 1)
  assert.deepEqual(ok.plan.excluded, { unit: '纯配置改动，没有可执行代码' })
  assert.equal(ok.plan.by, '测试工程师')

  const restored = applyTierDeclarations(ok.plan, [{ tier: 'unit', applicable: true }], { by: '测试工程师', at: 456 })
  assert.equal(restored.changed, 1)
  assert.deepEqual(restored.plan.excluded, {})
})

test('缺口文案点名怎么补：补用例或写明不适用', () => {
  const gaps = testPlanGaps([{ tier: 'unit', total: 0, executable: 0, applicable: true }])
  assert.equal(gaps.length, 1)
  assert.match(gaps[0].why, /一条用例都没有/)
  const summary = testPlanSummary([], null)
  assert.equal(summary.rate, null, '没有用例时覆盖率是 null，不是 0')
})

// 准出门禁：代码类卡三条线要各有可执行用例（或有理由的不适用）。
const devCard = {
  id: 't-1', code: 'DEV-001', title: '登录锁定', type: 'dev', status: 'accept',
  cases: [{ id: 'c1', title: '接口 200', result: 'pass', http: { method: 'GET', url: '/x', expectStatus: 200 } }],
  checklist: [], artifacts: [{ kind: 'report', title: '测试报告', status: 'delivered' }],
  blocked: null, gitlabMR: null, coding: null,
  signoff: { by: '张三', at: 1, note: '人看过', actorKind: 'human' },
}
const gateOf = (card, config = {}) => taskExitGate({ tasks: [card], config: { experts: [], ...config } }, card)
const has = (gate, keyword) => gate.blockers.some(item => item.includes(keyword))

test('准出：只有集成用例时，单元/端到端的缺口要拦', () => {
  const gate = gateOf(devCard)
  assert.equal(has(gate, '三条测试线还有缺口'), true)
  assert.equal(has(gate, '单元测试'), true)
  assert.equal(has(gate, '端到端测试'), true)
})

test('准出：写明不适用就不再拦（门禁认理由，不认沉默）', () => {
  const card = { ...devCard, testPlan: { excluded: { unit: '纯配置改动', e2e: '只改后端接口' }, by: '测试工程师', at: 1 } }
  assert.equal(has(gateOf(card), '三条测试线还有缺口'), false)
})

test('准出：三条线都有可执行用例就放行；产品卡不受这条约束', () => {
  const full = { ...devCard, cases: [shell('npm test'), http(), browser()] }
  assert.equal(has(gateOf(full), '三条测试线还有缺口'), false)
  const product = { ...devCard, type: 'requirement' }
  assert.equal(has(gateOf(product), '三条测试线还有缺口'), false)
  assert.equal(has(gateOf(devCard, { caseGate: { tiers: false } }), '三条测试线还有缺口'), false, '设置里关掉才不拦')
})

test('准出：一条用例都没有时仍走原来的「零用例」拦截，不重复报两层', () => {
  const gate = gateOf({ ...devCard, cases: [] })
  assert.equal(has(gate, '一条测试用例都没有'), true)
  assert.equal(has(gate, '三条测试线还有缺口'), false)
})

test('/state 摘要带上分层进度（对象，不是数组）', () => {
  const slim = publicCases({ cases: [shell('npm test'), http()] })
  assert.deepEqual(slim.caseSummary, { total: 2, pass: 2, fail: 0 })
  assert.equal(Array.isArray(slim.caseTiers), false, '/state 契约：不下发用例数组')
  assert.equal(slim.caseTiers.unit.total, 1)
  assert.equal(slim.caseTiers.integration.executable, 1)
  assert.equal(slim.caseTiers.e2e.total, 0)
})

test('测试提示词：三条线、真实命令、测试计划工具、需求验收条件都要在', () => {
  const expert = { id: 'e-qa', name: '测试工程师', emoji: '🧪', role: 'qa', skills: [] }
  const requirement = {
    id: 'req-1', code: 'REQ-001', title: '登录锁定',
    links: {},
    points: [{ id: 'p1', title: '失败次数限制', acceptance: [{ id: 'a1', text: '第 5 次失败返回 429 并锁定 10 分钟' }] }],
  }
  const task = { id: 't-1', code: 'TEST-001', title: '登录锁定测试', type: 'test', comments: [], project: '', checklist: [], artifacts: [], cases: [http({ title: '接口 200' })], requirement: '' }
  const prompt = String(buildExpertPrompt(task, expert, { id: 'test', label: '待测试' }, { experts: [expert], projects: [] }, undefined, '', requirement, {}, []))
  assert.match(prompt, /单元测试/)
  assert.match(prompt, /集成测试/)
  assert.match(prompt, /端到端测试/)
  assert.match(prompt, /studio_task_test_plan/, '要告诉专家怎么声明「这一层不适用」')
  assert.match(prompt, /node --test/, '单元线要给真实的跑法示例')
  assert.match(prompt, /第 5 次失败返回 429/, '需求的功能点与验收条件必须进提示词')
  assert.match(prompt, /缺口：.*单元测试/, '当前缺口要回显，专家才知道还差哪一层')
})
