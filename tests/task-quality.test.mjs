// 项目检查（本地质量命令）的回归：数据形状、命令解析、真跑一次、准出门禁。
// 这一块的判据必须来自机器跑出来的东西，所以测试里也真的起子进程。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { qualityTargetFor, sanitizeQuality } from '../src/host/card-quality.js'
import { defaultConfig } from '../src/host/domain.js'
import { configureExecutor, runTaskQuality, taskExitGate } from '../src/host/executor.js'
import { runQualityCommand } from '../src/host/quality-runner.js'
import { SecretStore, StudioStore } from '../src/host/store.js'

// 门禁里会用到宿主能力（服务依赖/并行冲突）；这里给"没有"的最小实现。
configureExecutor(new Proxy({}, { get: () => () => undefined }))

const node = process.execPath
const runNode = script => `"${node}" -e "${script}"`

const project = (overrides = {}) => ({
  id: 'proj-1',
  name: '订单中心',
  key: 'ORD',
  repoPath: '',
  baseBranch: 'main',
  qualityCmd: '',
  qualityTimeoutMs: 120000,
  services: [],
  iterations: [],
  repos: [],
  ...overrides,
})

const card = (overrides = {}) => ({
  id: 't-q1',
  code: 'DEV-001',
  title: '（自检）项目检查参与准出',
  type: 'dev',
  status: 'test',
  role: 'dev',
  project: 'proj-1',
  service: 'svc-1',
  requirementId: '',
  checklist: [],
  // 一张能过用例闸门的卡：三条线各有一条可执行且通过的用例
  // （用例闸门默认开，dev 卡零用例会被拦；三层测试闸门要求单元/集成/端到端各有能跑的）
  cases: [
    { id: 'c1', title: '冒烟', http: { method: 'GET', url: 'http://127.0.0.1:9/health', expectStatus: 200 }, result: 'pass' },
    { id: 'c2', title: '单测', shell: { command: 'node --test', expectExit: 0 }, result: 'pass' },
    { id: 'c3', title: '页面', browser: { url: '/' }, result: 'pass' },
  ],
  artifacts: [],
  comments: [],
  history: [],
  blocked: null,
  signoff: { by: '张三', at: Date.now(), note: '验过了', actorKind: 'human', source: 'session' },
  coding: {
    agent: 'claude-code',
    model: 'deepseek-v4.1-flash',
    branch: 'feat/quality',
    unitTests: { total: 3, passed: 3 },
    review: { status: 'approved', by: '架构师', note: '可以' },
  },
  ...overrides,
})

test('sanitizeQuality：没跑过是 null，输出只留尾部，ok 只认 true', () => {
  assert.equal(sanitizeQuality(null), null)
  assert.equal(sanitizeQuality({ cmd: '   ' }), null)
  const long = 'x'.repeat(6000) + '尾部标记'
  const quality = sanitizeQuality({ cmd: 'npm run check', exitCode: 1, ok: 'yes', output: long })
  assert.equal(quality.ok, false, 'ok 只认布尔 true')
  assert.equal(quality.exitCode, 1)
  assert.ok(quality.output.length <= 4000, `输出应该被截断，实际 ${quality.output.length}`)
  assert.ok(quality.output.endsWith('尾部标记'), '截断要留尾部，不是开头')
  assert.equal(sanitizeQuality({ cmd: 'x', exitCode: 'boom' }).exitCode, null, '非数字退出码记为 null')
})

test('qualityTargetFor：服务命令优先，项目兜底；没配返回 null；cwd 优先 worktree', () => {
  const config = defaultConfig()
  config.projects = [
    project({
      qualityCmd: 'npm run check',
      services: [
        { id: 'svc-1', name: 'order-service', repoPath: '/srv/order', baseBranch: 'main', qualityCmd: 'pnpm test' },
        { id: 'svc-2', name: 'pay-service', repoPath: '/srv/pay', baseBranch: 'main', qualityCmd: '' },
      ],
    }),
  ]
  const svc1 = qualityTargetFor(config, card({ service: 'svc-1' }))
  assert.equal(svc1.cmd, 'pnpm test')
  assert.equal(svc1.source, 'service')
  assert.equal(svc1.cwd, '/srv/order')

  const svc2 = qualityTargetFor(config, card({ service: 'svc-2' }))
  assert.equal(svc2.cmd, 'npm run check', '服务没配就用项目的')
  assert.equal(svc2.source, 'project')
  assert.equal(svc2.cwd, '/srv/pay')

  const withWorktree = qualityTargetFor(config, card({ service: 'svc-1', worktree: { path: '/tmp/wt-1' } }))
  assert.equal(withWorktree.cwd, '/tmp/wt-1', '有 worktree 就检查 worktree，不检查主目录')

  // 卡没挂项目，但需求上挂了项目：也要找得到（拆卡时项目常常只写在需求上）
  const inherited = qualityTargetFor(config, card({ project: '', requirementId: 'req-1' }), [{ id: 'req-1', project: 'proj-1' }])
  assert.equal(inherited.service, 'order-service', '服务只有一个时兜底用它')

  // 谁都没配 = null（不是失败）
  const empty = defaultConfig()
  empty.projects = [project()]
  assert.equal(qualityTargetFor(empty, card()), null)

  // 超时夹紧
  const clamped = qualityTargetFor(config, card({ service: 'svc-1', project: 'proj-1' }))
  assert.equal(clamped.timeoutMs, 120000)
})

test('runQualityCommand：通过 / 失败 / 超时都如实回报，不抛异常', async () => {
  const okRun = await runQualityCommand({ cmd: runNode("console.log('all good')") })
  assert.equal(okRun.ok, true)
  assert.equal(okRun.exitCode, 0)
  assert.match(okRun.output, /all good/)

  const badRun = await runQualityCommand({ cmd: runNode('process.exit(3)') })
  assert.equal(badRun.ok, false)
  assert.equal(badRun.exitCode, 3)

  const missing = await runQualityCommand({ cmd: 'definitely-not-a-command-xyz' })
  assert.equal(missing.ok, false, '命令不存在也是一次不通过，不能假装通过')

  const slow = await runQualityCommand({ cmd: runNode('setTimeout(()=>{},10000)'), timeoutMs: 1200 })
  assert.equal(slow.ok, false)
  assert.equal(slow.timedOut, true, '超时要标出来，否则「卡住」会被读成「失败」')
  assert.equal(slow.exitCode, null)
})

test('准出：配了命令而没跑过要拦，跑挂了要拦，跑过且通过才放行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-studio-quality-'))
  const store = new StudioStore(join(dir, 'state.json'), { dbFile: join(dir, 'state.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  try {
    await store.ready
    await store.mutate(state => {
      state.config.projects = [
        project({
          services: [{ id: 'svc-1', name: 'order-service', repoPath: dir, baseBranch: 'main', qualityCmd: runNode("console.log('checked')"), qualityTimeoutMs: 30000 }],
        }),
      ]
      state.tasks.push(card())
    })
    const before = store.snapshot()
    const gateBefore = taskExitGate(before, before.tasks[0])
    assert.ok(gateBefore.blockers.some(text => text.includes('还没跑过')), `配了命令没跑过应该拦：${gateBefore.blockers.join('；')}`)

    const passed = await runTaskQuality(store, 't-q1', { by: '开发工程师' })
    assert.equal(passed.quality.ok, true)
    assert.equal(passed.target.service, 'order-service')
    const afterPass = store.snapshot()
    assert.equal(afterPass.tasks[0].quality.ok, true, '结果要落库')
    assert.equal(taskExitGate(afterPass, afterPass.tasks[0]).blockers.length, 0, `通过了就不该再有拦阻：${taskExitGate(afterPass, afterPass.tasks[0]).blockers.join('；')}`)

    // 换成一条会失败的命令：再跑一次必须拦
    await store.mutate(state => {
      state.config.projects[0].services[0].qualityCmd = runNode("console.log('boom'); process.exit(2)")
    })
    const failed = await runTaskQuality(store, 't-q1', { by: '开发工程师' })
    assert.equal(failed.quality.ok, false)
    assert.equal(failed.quality.exitCode, 2)
    const afterFail = store.snapshot()
    const blockers = taskExitGate(afterFail, afterFail.tasks[0]).blockers
    assert.ok(blockers.some(text => text.includes('项目检查不通过')), `跑挂了要拦：${blockers.join('；')}`)
    assert.ok(afterFail.tasks[0].history.some(entry => String(entry.note ?? '').includes('项目检查不通过')), '历史里要留痕')

    // 没配命令：明确报错，不是静默通过
    await store.mutate(state => { state.config.projects[0].services[0].qualityCmd = '' })
    await assert.rejects(() => runTaskQuality(store, 't-q1', { by: '开发工程师' }), /还没配项目检查命令/)
  } finally {
    store.db?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('准出：产品卡/设计卡（没有执行记录）不该被代码检查拦住', () => {
  const state = {
    tasks: [],
    config: { ...defaultConfig(), projects: [project({ qualityCmd: 'npm run check', services: [{ id: 'svc-1', name: 's', repoPath: '/srv/s', baseBranch: 'main' }] })] },
  }
  const design = card({ coding: null, type: 'design', role: 'architect' })
  const gate = taskExitGate(state, design)
  assert.ok(!gate.blockers.some(text => text.includes('项目检查')), `没有代码改动的卡不该被拦：${gate.blockers.join('；')}`)
})

test('准出：代码/测试类卡零用例要拦（用例闸门默认开），产品卡不拦', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-studio-casegate-'))
  const store = new StudioStore(join(dir, 'state.json'), { dbFile: join(dir, 'state.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  try {
    await store.ready
    await store.mutate(state => {
      state.tasks.push(card({ id: 't-dev', code: 'DEV-010', type: 'dev', cases: [] }))
      state.tasks.push(card({ id: 't-doc', code: 'REQ-010', type: 'requirement', cases: [] }))
    })
    const snapshot = store.snapshot()
    const devGate = taskExitGate(snapshot, snapshot.tasks.find(item => item.id === 't-dev'))
    assert.ok(devGate.blockers.some(text => text.includes('一条测试用例都没有')), `dev 卡零用例应该拦：${devGate.blockers.join('；')}`)

    const docGate = taskExitGate(snapshot, snapshot.tasks.find(item => item.id === 't-doc'))
    assert.equal(docGate.blockers.some(text => text.includes('一条测试用例都没有')), false, '产品/需求卡不该被用例闸门拦')

    // 闸门关掉就退回 warning
    await store.mutate(state => { state.config.caseGate = { enabled: false } })
    const off = store.snapshot()
    const offGate = taskExitGate(off, off.tasks.find(item => item.id === 't-dev'))
    assert.equal(offGate.blockers.some(text => text.includes('一条测试用例都没有')), false, '关掉闸门后不应再拦')
    assert.ok(offGate.warnings.some(text => text.includes('没有测试用例')), '关掉闸门仍要给 warning')
  } finally {
    store.db?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})
