// 派单会话落在哪个目录 —— 走真实的 Dispatcher.ensureSession，只把宿主的 agents /
// workspaceRegistry 换成桩：断言「会话 cwd」「注册的工作区名」两件事。
//
// 这条链决定派单会话出现在 DSH 侧栏的哪个工作区里，纯函数单测只盖到规则，
// 这里盖的是「规则真的接到了 agents.create 与 workspaceRegistry.create 上」。
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Dispatcher, configureDispatcher } from '../src/host/dispatcher.js'

const EXPERT = { id: 'dev', name: '研发', role: 'dev', model: 'acme/flash' }

function harness({ config, worktree }) {
  const calls = { workspaces: [], created: [] }
  configureDispatcher({ ensureWorktree: async () => worktree })
  const store = {
    snapshot: () => ({ config, tasks: [], requirements: [] }),
    mutate: async fn => fn({}),
  }
  const ctx = {
    agents: {
      get: () => undefined,
      create: async options => {
        calls.created.push(options)
        return { agent: { session: {} }, dispose: async () => {} }
      },
    },
    workspaceRegistry: {
      create: async (dir, title) => { calls.workspaces.push({ dir, title }) },
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

test('项目配了代码目录：会话 cwd 是仓库、工作区叫项目名', async t => {
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
})

test('卡没挂项目：退回兜底目录，工作区名固定（不因先派哪张卡而定名）', async t => {
  const scratch = await tempDir(t)
  const { dispatcher, calls } = harness({
    config: { agents: { workspaceDir: scratch, isolation: 'none' }, projects: [] },
  })
  await dispatcher.ensureSession('studio-t-4-dev', { id: 't-4', code: 'DEV-004' }, EXPERT, dispatcher.config().agents)
  assert.equal(calls.created[0].meta.cwd, scratch)
  assert.deepEqual(calls.workspaces, [{ dir: scratch, title: 'Studio 工作区' }])
})
