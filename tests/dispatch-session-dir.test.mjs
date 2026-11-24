// 派单会话落在哪个目录 —— 走真实的 Dispatcher.ensureSession，只把宿主的 agents /
// workspaceRegistry 换成桩：断言「会话 cwd」「注册的工作区名」「有没有挂进工作区名单」。
//
// 这条链决定派单会话出现在 DSH 侧栏的哪个工作区里：跑对目录只解决一半，
// 另一半是 workspace.attachSession()（宿主的成员资格是显式名单，只 bootstrap 一次）。
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Dispatcher, configureDispatcher } from '../src/host/dispatcher.js'

const EXPERT = { id: 'dev', name: '研发', role: 'dev', model: 'acme/flash' }

function harness({ config, worktree, attachFails = 0 }) {
  const calls = { workspaces: [], created: [], attached: [] }
  configureDispatcher({ ensureWorktree: async () => worktree })
  const store = {
    snapshot: () => ({ config, tasks: [], requirements: [] }),
    mutate: async fn => fn({}),
  }
  const failures = new Map()
  const workspaceFor = dir => ({
    id: `ws:${dir}`,
    path: dir,
    sessionIds: [],
    attachSession: async sessionId => {
      const already = failures.get(sessionId) ?? 0
      if (already < attachFails) {
        failures.set(sessionId, already + 1)
        calls.attached.push({ dir, sessionId, ok: false })
        throw new Error('会话头还没落盘')
      }
      calls.attached.push({ dir, sessionId, ok: true })
    },
  })
  const ctx = {
    agents: {
      get: () => undefined,
      create: async options => {
        calls.created.push(options)
        return { agent: { session: {} }, dispose: async () => {} }
      },
    },
    workspaceRegistry: {
      create: async (dir, title) => {
        calls.workspaces.push({ dir, title })
        return workspaceFor(dir)
      },
    },
    permissionPresets: { set: () => {} },
    sessionController: { rename: async () => {} },
    get: () => undefined,
  }
  return { dispatcher: new Dispatcher(ctx, store), calls }
}

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'studio-dispatch-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

test('项目配了代码目录：会话 cwd 是仓库、工作区叫项目名、会话挂进这个工作区', async t => {
  const repo = await tempDir(t)
  const scratch = join(repo, 'scratch')
  const { dispatcher, calls } = harness({
    config: {
      agents: { workspaceDir: scratch, isolation: 'none', agentPreset: 'standard' },
      projects: [{ id: 'p1', name: '订单中心', repoPath: repo }],
    },
  })
  const task = { id: 't-1', code: 'DEV-001', project: 'p1' }
  await dispatcher.ensureSession('studio-t-1-dev', task, EXPERT, dispatcher.config().agents)
  assert.equal(calls.created.length, 1)
  assert.equal(calls.created[0].meta.cwd, repo, '会话要跑在项目仓库里，否则侧栏里只能落「未分组」')
  assert.deepEqual(calls.workspaces, [{ dir: repo, title: '订单中心' }])
  assert.deepEqual(calls.attached, [{ dir: repo, sessionId: 'studio-t-1-dev', ok: true }], '注册了目录还不够，会话要在工作区名单里')
})

test('项目代码目录不存在：不把空目录造出来当仓库，退回兜底目录', async t => {
  const root = await tempDir(t)
  const missing = join(root, 'repo-that-does-not-exist')
  const scratch = join(root, 'scratch')
  const { dispatcher, calls } = harness({
    config: {
      agents: { workspaceDir: scratch, isolation: 'none' },
      projects: [{ id: 'p1', name: '订单中心', repoPath: missing }],
    },
  })
  await dispatcher.ensureSession('studio-t-2-dev', { id: 't-2', code: 'DEV-002', project: 'p1' }, EXPERT, dispatcher.config().agents)
  assert.equal(calls.created[0].meta.cwd, scratch)
  assert.deepEqual(calls.workspaces, [{ dir: scratch, title: 'Studio 工作区' }])
  assert.deepEqual(calls.attached, [{ dir: scratch, sessionId: 'studio-t-2-dev', ok: true }])
  assert.ok(dispatcher.log.some(entry => entry.line.includes('项目代码目录不存在')), '要留一行日志说明为什么退了')
})

test('worktree 已建好：会话跑在 worktree 里，工作区名带项目与卡号', async t => {
  const repo = await tempDir(t)
  const worktree = join(repo, '.agents', 'worktrees', 'DEV-001-t1')
  const { dispatcher, calls } = harness({
    config: {
      agents: { workspaceDir: join(repo, 'scratch'), isolation: 'worktree' },
      projects: [{ id: 'p1', name: '订单中心', repoPath: repo }],
    },
    worktree: { path: worktree, branch: 'task/DEV-001-t1', repo },
  })
  await dispatcher.ensureSession('studio-t-3-dev', { id: 't-3', code: 'DEV-001', project: 'p1' }, EXPERT, dispatcher.config().agents)
  assert.equal(calls.created[0].meta.cwd, worktree)
  assert.deepEqual(calls.workspaces, [{ dir: worktree, title: '订单中心 · DEV-001' }])
  assert.deepEqual(calls.attached, [{ dir: worktree, sessionId: 'studio-t-3-dev', ok: true }])
})

test('卡没挂项目：退回兜底目录，工作区名固定（不因先派哪张卡而定名）', async t => {
  const scratch = await tempDir(t)
  const { dispatcher, calls } = harness({
    config: { agents: { workspaceDir: scratch, isolation: 'none' }, projects: [] },
  })
  await dispatcher.ensureSession('studio-t-4-dev', { id: 't-4', code: 'DEV-004' }, EXPERT, dispatcher.config().agents)
  assert.equal(calls.created[0].meta.cwd, scratch)
  assert.deepEqual(calls.workspaces, [{ dir: scratch, title: 'Studio 工作区' }])
  assert.deepEqual(calls.attached, [{ dir: scratch, sessionId: 'studio-t-4-dev', ok: true }])
})

test('会话头还没落盘：重试后挂上去；一直失败只记日志、派单照常', async t => {
  const scratch = await tempDir(t)
  const flaky = harness({
    config: { agents: { workspaceDir: scratch, isolation: 'none' }, projects: [] },
    attachFails: 2,
  })
  await flaky.dispatcher.ensureSession('studio-t-5-dev', { id: 't-5', code: 'DEV-005' }, EXPERT, flaky.dispatcher.config().agents)
  assert.deepEqual(flaky.calls.attached.map(item => item.ok), [false, false, true], '前两次读不到会话头，第三次成功')

  const broken = harness({
    config: { agents: { workspaceDir: scratch, isolation: 'none' }, projects: [] },
    attachFails: 99,
  })
  const agent = await broken.dispatcher.ensureSession('studio-t-6-dev', { id: 't-6', code: 'DEV-006' }, EXPERT, broken.dispatcher.config().agents)
  assert.equal(broken.calls.created.length, 1, '挂不上工作区不影响会话建出来')
  assert.ok(agent !== undefined)
  assert.ok(broken.dispatcher.log.some(entry => entry.line.includes('未分组')), '要留一行日志说明侧栏里还会是「未分组」')
})

test('启动自愈：老会话的 cwd 已在工作区里、却不在名单上 → 补挂（只动 studio- 会话）', async () => {
  const calls = []
  const registry = {
    list: () => [
      { id: 'w-scratch', path: 'C:/scratch', sessionIds: [], attachSession: async id => { calls.push(['w-scratch', id]) } },
      { id: 'w-repo', path: 'C:/repo', sessionIds: ['studio-t-9-dev'], attachSession: async id => { calls.push(['w-repo', id]) } },
    ],
  }
  const persistence = {
    list: () => [
      { header: { id: 'studio-t-1-dev', cwd: 'C:/scratch' } },
      { header: { id: 'studio-t-9-dev', cwd: 'C:/repo' } },
      { header: { id: 'studio-t-2-dev', cwd: 'C:\\scratch\\' } },
      { header: { id: 'session-user-1', cwd: 'C:/scratch' } },
      { header: { id: 'studio-t-3-dev', cwd: 'C:/somewhere/else' } },
    ],
  }
  const ctx = {
    agents: { get: () => undefined },
    workspaceRegistry: registry,
    get: name => (name === 'sessionPersistence' ? persistence : undefined),
  }
  const store = { snapshot: () => ({ config: {}, tasks: [], requirements: [] }), mutate: async fn => fn({}) }
  const dispatcher = new Dispatcher(ctx, store)
  assert.equal(await dispatcher.healWorkspaceMembership(), 2)
  assert.deepEqual(calls, [['w-scratch', 'studio-t-1-dev'], ['w-scratch', 'studio-t-2-dev']])
})

test('启动自愈：宿主没给 sessionPersistence / 没给工作区列表时不炸', async () => {
  const store = { snapshot: () => ({ config: {}, tasks: [], requirements: [] }), mutate: async fn => fn({}) }
  const bare = new Dispatcher({ agents: { get: () => undefined }, get: () => undefined }, store)
  assert.equal(await bare.healWorkspaceMembership(), 0)

  const throwing = new Dispatcher({
    agents: { get: () => undefined },
    workspaceRegistry: { list: () => { throw new Error('registry not ready') } },
    get: () => ({ list: () => [] }),
  }, store)
  assert.equal(await throwing.healWorkspaceMembership(), 0)
  assert.ok(throwing.log.some(entry => entry.line.includes('读工作区列表失败')))
})
