import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { addAssertedCases } from '../src/host/executor.js'
import { coverageStrength, isExecutable } from '../src/host/case-strength.js'

/* 用例入库的口子：写不出来的用例必须在**生成这一刻**失败。
 * 历史教训：全库 101 条用例 0 条带断言，谁也不知道哪条真的验过（docs/product.md §5.1）。 */

function fakeStore(config, tasks = [{ id: 't-1', title: '卡片', cases: [], updates: 0, updatedAt: 0 }]) {
  const state = { config, tasks }
  return {
    state,
    snapshot: () => state,
    async mutate(fn) {
      fn(state)
      for (const task of state.tasks) task.updates += 1
      return state
    },
  }
}

const testing = extra => ({ envs: [], defaultEnv: '', timeoutMs: 3000, allowHosts: ['127.0.0.1', 'localhost'], concurrency: 1, allowShell: false, ...extra })

test('用例入库：db 用例可以写进去（allowDb 开着）', async () => {
  const store = fakeStore({ testing: testing({ allowDb: true }) })
  const out = await addAssertedCases(store, 't-1', [{
    title: '库里有一行',
    db: { file: '/tmp/does-not-exist.db', sql: 'select 1 as n', expectColumn: 'n', expectValue: '1' },
  }])
  assert.equal(out.added, 1)
  const saved = store.state.tasks[0].cases[0]
  assert.equal(saved.db.sql, 'select 1 as n')
  assert.equal(isExecutable(saved), true, 'db 用例要算可执行')
})

test('用例入库：allowDb 没开时不收 db 用例', async () => {
  const store = fakeStore({ testing: testing({}) })
  await assert.rejects(
    () => addAssertedCases(store, 't-1', [{ title: 'db', db: { file: '/tmp/x.db', sql: 'select 1' } }]),
    /allowDb/,
  )
})

test('用例入库：不给断言的不收（不能又攒一条草稿）', async () => {
  const store = fakeStore({ testing: testing({}) })
  await assert.rejects(
    () => addAssertedCases(store, 't-1', [{ title: '登录看起来正常' }], { by: '测试专家' }),
    /跑不了/,
  )
  assert.equal(store.state.tasks[0].cases.length, 0, '不合格的用例一条都不该写进去')
})

test('用例入库：缺期望状态码的不收（跑完也判不出对错）', async () => {
  const store = fakeStore({ testing: testing({ envs: [{ id: 'e1', name: '本地', baseUrl: 'http://127.0.0.1:1' }], defaultEnv: 'e1' }) })
  await assert.rejects(
    () => addAssertedCases(store, 't-1', [{ title: '查健康', method: 'GET', path: '/health' }]),
    /expectStatus/,
  )
})

test('用例入库：只有相对地址又没配环境时不收', async () => {
  const store = fakeStore({ testing: testing({}) })
  await assert.rejects(
    () => addAssertedCases(store, 't-1', [{ title: '查健康', method: 'GET', path: '/health', expectStatus: 200 }]),
    /baseUrl/,
  )
})

test('用例入库：一条不合法就整体拒绝，能跑的也不写（全有或全无）', async () => {
  const store = fakeStore({ testing: testing({ envs: [{ id: 'e1', name: '本地', baseUrl: 'http://127.0.0.1:1' }], defaultEnv: 'e1' }) })
  await assert.rejects(
    () => addAssertedCases(store, 't-1', [
      { title: '查健康', method: 'GET', path: '/health', expectStatus: 200 },
      { title: '看着没问题' },
    ]),
    /1\/2 条用例不合法/,
  )
  assert.equal(store.state.tasks[0].cases.length, 0)
})

test('用例入库：合法用例写进去、算作可执行，并当场试跑', async () => {
  const server = createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, path: req.url }))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  try {
    const store = fakeStore({
      testing: testing({ envs: [{ id: 'e1', name: '本地桩', baseUrl: `http://127.0.0.1:${port}` }], defaultEnv: 'e1' }),
    })
    const result = await addAssertedCases(store, 't-1', [
      { title: '健康检查返回 200', method: 'GET', path: '/health', expectStatus: 200, expectContains: 'ok' },
    ], { by: '测试专家' })

    assert.equal(result.added, 1)
    assert.equal(result.total, 1)
    const saved = store.state.tasks[0].cases[0]
    assert.equal(isExecutable(saved), true, '写进去的用例必须算可执行')
    assert.equal(coverageStrength(store.state.tasks[0].cases).rate, 1)
    assert.equal(result.verified.ok, true, '当场试跑要真的打过去并成功')
    assert.equal(result.verified.status, 200)
    assert.equal(saved.result, 'pass', '试跑结果要落在用例上，不能只回个话')
    assert.match(saved.note, /生成时试跑/)
  } finally {
    await new Promise(done => server.close(done))
  }
})

test('用例入库：试跑打不通要说实话，不能报成已生成', async () => {
  const store = fakeStore({
    testing: testing({ envs: [{ id: 'e1', name: '打不通', baseUrl: 'http://127.0.0.1:1' }], defaultEnv: 'e1' }),
  })
  const result = await addAssertedCases(store, 't-1', [
    { title: '连不上也要如实回报', method: 'GET', path: '/health', expectStatus: 200 },
  ])
  assert.equal(result.verified.ok, false)
  assert.equal(store.state.tasks[0].cases[0].result, 'fail')
  assert.match(store.state.tasks[0].cases[0].note, /失败/)
})

test('用例入库：同名空壳会原地升级成可执行，不再追加重复', async () => {
  const store = fakeStore(
    { testing: testing({ allowShell: true }) },
    [{ id: 't-1', title: '卡片', cases: [{ id: 'c-draft', title: 'a1 正常除法', result: 'pending', note: '' }], updates: 0, updatedAt: 0 }],
  )
  const result = await addAssertedCases(store, 't-1', [
    { title: 'a1 正常除法（可执行）', command: 'node -e "process.exit(0)"', expectExit: 0 },
  ], { by: '测试专家' })
  assert.equal(result.added, 0, '不能再新增一条重复用例')
  assert.equal(result.upgraded, 1)
  assert.equal(store.state.tasks[0].cases.length, 1, '同名空壳要原地升级，数量不变')
  const saved = store.state.tasks[0].cases[0]
  assert.equal(saved.id, 'c-draft', 'id 要保留（历史/归属不丢）')
  assert.equal(saved.title, 'a1 正常除法', '「（可执行）」后缀要去掉')
  assert.equal(isExecutable(saved), true, '升级后必须算可执行')
  assert.equal(result.verified?.id, 'c-draft', '升级后也要当场试跑')
})

test('用例入库：重名的跳过但不重复写入', async () => {
  const store = fakeStore({ testing: testing({}) }, [{ id: 't-1', title: '卡片', cases: [{ id: 'c-old', title: '已有用例', result: 'pending' }], updates: 0, updatedAt: 0 }])
  const result = await addAssertedCases(store, 't-1', [
    { title: '已有用例', method: 'GET', path: 'http://127.0.0.1:1/x', expectStatus: 200 },
  ])
  assert.equal(result.added, 0)
  assert.equal(result.skipped, 1)
  assert.equal(store.state.tasks[0].cases.length, 1)
})

test('用例入库：shell 用例的字段名必须和 runner 读的一致（expectExit）', async () => {
  const store = fakeStore({ testing: testing({ allowShell: true }) })
  const result = await addAssertedCases(store, 't-1', [
    { title: '跑一条一定成功的命令', command: 'node -e "process.exit(0)"', expectExit: 0 },
  ], { by: '测试专家' })
  assert.equal(result.added, 1)
  const saved = store.state.tasks[0].cases[0]
  // 这一天踩过的坑：这里写成 expectExitCode，runner 读 shell.expectExit 得到 undefined，
  // 于是「退出码 0（期望 undefined）」→ 平台自动开了一张假缺陷卡。
  assert.equal(Object.hasOwn(saved.shell, 'expectExitCode'), false, '不该出现 expectExitCode 这个自造字段')
  assert.equal(saved.shell.expectExit, 0)
  assert.equal(result.verified.ok, true, '当场试跑要能真的跑通，字段名错了这里就会红')
})

test('用例入库：写进 state 的形状 = 从磁盘重新加载后的形状（sanitizeCase 一致）', async () => {
  const { sanitizeCase } = await import('../src/host/domain.js')
  const store = fakeStore({ testing: testing({}) })
  await addAssertedCases(store, 't-1', [
    { title: '形状一致', method: 'GET', path: 'http://127.0.0.1:1/x', expectStatus: 200, expectContains: 'ok' },
  ])
  const saved = store.state.tasks[0].cases[0]
  const reloaded = sanitizeCase(JSON.parse(JSON.stringify(saved)), 0)
  assert.deepEqual(Object.keys(saved).sort(), Object.keys(reloaded).sort(), '字段集合必须一致，否则重启后行为会变')
  assert.deepEqual(saved.http, reloaded.http)
})

test('用例库：草稿标记要能一路透到列表里（否则分不清草稿和手工用例）', async () => {
  const { sanitizeCase } = await import('../src/host/domain.js')
  const { collectCases } = await import('../src/host/cases.js')
  const kept = sanitizeCase({ title: '旧生成器留下的空壳', draft: true }, 0)
  assert.equal(kept.draft, true, 'sanitizeCase 不能把 draft 丢掉')
  assert.equal(sanitizeCase({ title: '正常人写的' }, 0).draft, false)
  const rows = collectCases({
    requirements: [],
    tasks: [{ id: 't-1', title: '卡', code: 'T-1', status: 'test', cases: [kept] }],
  })
  assert.equal(rows[0].draft, true, '用例库这一层也要带 draft')
  assert.equal(rows[0].runnable, false)
})

test('签字来源：AI 签的字过不了准出（含早期被误记成 human 的老记录）', async () => {
  const { configureExecutor, taskExitGate } = await import('../src/host/executor.js')
  // 门禁会用到不少注入（服务依赖、附件…）；给一个「任何属性都是空函数」的桩，免得以后再加依赖就要改测试。
  configureExecutor(new Proxy({}, { get: () => () => undefined }))
  const config = { experts: [{ id: 'expert-d3c58341', name: '测试工程师' }] }
  const base = {
    id: 't-1', code: 'DEV-001', status: 'accept', cases: [{ id: 'c1', title: 'x', result: 'pass', http: { url: '/x', expectStatus: 200 } }],
    checklist: [], artifacts: [{ kind: 'doc', title: '报告', status: 'ready' }], coding: null, blocked: null, gitlabMR: null,
  }
  const gateWith = signoff => taskExitGate({ tasks: [base], config }, { ...base, signoff })
  const blockedBecauseAi = gate => gate.blockers.some(item => item.includes('AI 写的'))

  assert.equal(blockedBecauseAi(gateWith({ by: '测试工程师', at: 1, note: 'ok', actorKind: 'agent' })), true, 'AI 签的必须拦')
  // 历史数据：早期按名字猜来源，把专家名判成了 human；现在按「名字在专家名册里」也能认出来。
  assert.equal(blockedBecauseAi(gateWith({ by: '测试工程师', at: 1, note: 'ok', actorKind: 'human' })), true, '老记录：专家名 = AI')
  assert.equal(blockedBecauseAi(gateWith({ by: '张三', at: 1, note: '人看过', actorKind: 'human' })), false, '人签的放行')
  assert.equal(blockedBecauseAi(gateWith(null)), false)
  assert.ok(gateWith(null).blockers.some(item => item.includes('还没有验收签字')), '没签字仍然是有各自的那条拦')
})


test('绕过准出：卡级与需求级的 override 都能统计出来', async () => {
  const { overrideSummary } = await import('../src/host/override.js')
  const now = Date.now()
  const state = {
    tasks: [
      { id: 't-1', code: 'DEV-001', title: '卡一', status: 'done', override: { by: '张三', at: now, reason: '客户等着上线' } },
      { id: 't-2', code: 'DEV-002', title: '卡二', status: 'done' },
    ],
    requirements: [
      { id: 'r-1', code: 'REQ-001', title: '需求一', status: 'delivered', override: { by: '', at: now - 1000, reason: '' } },
      { id: 'r-2', code: 'REQ-002', title: '需求二', status: 'active' },
    ],
  }
  const all = overrideSummary(state)
  assert.equal(all.total, 2, '两张卡里只有一张有 override，需求同理')
  assert.equal(all.cards, 1)
  assert.equal(all.requirements, 1)
  assert.equal(all.noReason, 1, '没写原因的要单独数出来')
  assert.deepEqual(all.byPerson.map(item => item.by), ['张三', '（没记签名人）'])
  assert.equal(all.list[0].id, 't-1', '按时间倒序，新的在前')
  assert.equal(overrideSummary(state, { since: now - 500 }).total, 1, '按区间过滤')
  assert.equal(overrideSummary({}).total, 0, '空状态不能炸')
})

test('绕过准出：区分 AI/人强推，超过上限要标出来', async () => {
  const { overrideSummary } = await import('../src/host/override.js')
  const now = Date.now()
  const config = { experts: [{ id: 'e1', name: '测试工程师' }] }
  const state = {
    config,
    tasks: [
      { id: 't-1', code: 'DEV-001', title: 'AI 强推', status: 'done', override: { by: '测试工程师', at: now, reason: '急' } },
      { id: 't-2', code: 'DEV-002', title: '人强推', status: 'done', override: { by: '张三', at: now - 10, reason: '客户要求' } },
      { id: 't-3', code: 'DEV-003', title: '没记人', status: 'done', override: { by: '', at: now - 20, reason: '' } },
    ],
    requirements: [],
  }
  const out = overrideSummary(state, { config, max: 2 })
  assert.equal(out.total, 3)
  assert.equal(out.byAgent, 1, '专家名册里的名字算 AI 推的')
  assert.equal(out.byHuman, 1)
  assert.equal(out.byUnknown, 1)
  assert.equal(out.overLimit, true, '3 > 上限 2')
  assert.equal(overrideSummary(state, { config, max: 5 }).overLimit, false)
  assert.equal(out.list.find(item => item.id === 't-1').ai, true)
})
