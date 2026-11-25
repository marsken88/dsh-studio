// 「跑完就停在原地」与「重启后不接着跑」两条真机问题（2026-11-25 用户反馈）的回归测试。
//
// 背景：settle() 以前把 dispatch.status 一起写没了 —— tick 认为「这一列没派过」，
// 同一个会话立刻再跑一遍；而重启 reconcile 只收 state=running，且 tick 还卡在
// autoStatuses 白名单上，于是 dev / review / accept 列里被中断的卡重启后一张都不动。
//
// 这里用真实的 Dispatcher + 假宿主（不连 dsh、不花 token），断言四种形状：
//   ① 正常结束不立刻重派；② 冷却后催一次；③ 催满挂阻塞；④ 重启续跑不受自动列白名单限制。
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Dispatcher, configureDispatcher, nudgeInstruction } from '../src/host/dispatcher.js'
import { configureExecutor, updateTask } from '../src/host/executor.js'
import { SecretStore, StudioStore } from '../src/host/store.js'

const EXPERTS = [
  { id: 'product', name: '产品', role: 'product', enabled: true, model: 'acme/flash' },
  { id: 'dev', name: '研发', role: 'dev', enabled: true, model: 'acme/flash' },
  { id: 'qa', name: '测试', role: 'qa', enabled: true, model: 'acme/flash' },
]

function makeStore(state) {
  return {
    snapshot: () => state,
    mutate: async fn => { fn(state); return state },
    readSide: async () => undefined,
    writeSide: async () => undefined,
  }
}

function task(overrides = {}) {
  return {
    id: 't-1',
    code: 'DEV-001',
    title: '一张卡',
    status: 'test',
    role: 'qa',
    expert: '',
    blocked: null,
    retryAt: 0,
    agentFailures: 0,
    dispatch: null,
    comments: [],
    history: [],
    requirements: [],
    coding: null,
    ...overrides,
  }
}

async function harness(t, { tasks, autoStatuses = [], worktree = undefined } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'studio-continue-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const deliveries = []
  const state = {
    config: {
      roles: ['product', 'architect', 'dev', 'qa'],
      experts: EXPERTS,
      teams: [],
      columns: {
        dev: { kind: 'role', id: 'dev' },
        test: { kind: 'role', id: 'qa' },
        accept: { kind: 'role', id: 'product' },
      },
      agents: {
        enabled: true,
        maxConcurrent: 1,
        autoStatuses,
        isolation: 'none',
        sandbox: 'workspace-write',
        workspaceDir: dir,
        retry: { max: 2, baseMs: 60_000, factor: 2 },
      },
      projects: [],
      requirements: [],
    },
    tasks: tasks.map(entry => task(entry)),
    requirements: [],
  }
  const store = makeStore(state)
  configureDispatcher({
    ensureWorktree: async () => worktree,
    commentTask: async () => {},
    feishuBroadcast: async () => {},
    bugSla: () => null,
    broadcastChange: () => {},
    serviceOf: () => undefined,
    workProjectOf: () => undefined,
    serviceConflicts: () => undefined,
    listWorkspaces: () => [],
  })
  const live = new Set()
  const ctx = {
    agents: {
      get: id => (live.has(id) ? { abort: () => {} } : undefined),
      create: async () => {
        const agent = {
          session: { requestContext: () => ({ provider: 'acme', model: 'flash' }) },
          inject: () => {},
          followup: () => { deliveries.push(state.tasks[0]?.id) },
          abort: () => {},
          dispose: async () => {},
        }
        return { agent, dispose: async () => {} }
      },
    },
    workspaceRegistry: {
      create: async path => ({ id: `ws:${path}`, path, sessionIds: [], attachSession: async () => {} }),
    },
    permissionPresets: { set: () => {} },
    sessionController: { rename: async () => {} },
    get: () => undefined,
  }
  const dispatcher = new Dispatcher(ctx, store)
  return { dispatcher, state, store, deliveries, live, dir }
}

/** 把「上一次派单」的时间拨到冷却窗口之外（tick 用 Date.now()）。 */
function ageDispatch(state, ms = 90_000) {
  if (state.tasks[0].dispatch === null || state.tasks[0].dispatch === undefined) return
  state.tasks[0].dispatch.at = Date.now() - ms
}

test('正常结束不再立刻重派：settle 保留列名，tick 在冷却窗口内不投递', async t => {
  const { dispatcher, state, deliveries } = await harness(t, { tasks: [{}], autoStatuses: ['test'] })
  await dispatcher.tick()
  assert.equal(deliveries.length, 1, '第一轮派出去')
  assert.equal(state.tasks[0].dispatch.state, 'running')

  dispatcher.settle('studio-t-1-qa')
  const dispatch = state.tasks[0].dispatch
  assert.equal(dispatch.state, 'done', '正常结束记成 done，不是把 status 抹掉的 idle')
  assert.equal(dispatch.status, 'test', 'status 必须留着，否则 tick 会当成「这一列没派过」')
  assert.equal(dispatch.advanced, false, '卡没换列')

  await dispatcher.tick()
  assert.equal(deliveries.length, 1, '冷却窗口内不许再派（以前 5 秒一轮无限重跑）')
})

test('跑完没推进：冷却过后催一次，指令写明「必须推进或阻塞」', async t => {
  const { dispatcher, state, deliveries } = await harness(t, { tasks: [{}], autoStatuses: ['test'] })
  await dispatcher.tick()
  dispatcher.settle('studio-t-1-qa')
  ageDispatch(state, 90_000)
  await dispatcher.tick()
  assert.equal(deliveries.length, 2, '冷却过后自动再派一次')
  assert.equal(state.tasks[0].dispatch.state, 'running')
  assert.equal(state.tasks[0].dispatch.attempts, 2, 'attempts 在原有次数上 +1')
  const instruction = nudgeInstruction({ label: '待测试' }, { attempts: 1 })
  assert.match(instruction, /待测试/, '催派指令要带列名')
  assert.match(instruction, /studio_task_update/, '要明确让它推进列')
  assert.match(instruction, /studio_task_block/, '推不动就阻塞，别只解释一句')
})

test('催满上限：挂阻塞等人，不再空转', async t => {
  const { dispatcher, state, deliveries } = await harness(t, { tasks: [{}], autoStatuses: ['test'] })
  // 形状 = 已经派过 3 轮（retry.max 2 → 上限 3），最后一轮跑完没推进
  state.tasks[0].dispatch = {
    key: 't-1:test', status: 'test', expert: 'qa', sessionId: 'studio-t-1-qa',
    state: 'done', advanced: false, attempts: 3, at: Date.now() - 200_000,
  }
  await dispatcher.tick()
  assert.equal(deliveries.length, 0, '用完了就不该再派')
  assert.ok(state.tasks[0].blocked !== null, '要挂阻塞，否则人不知道要介入')
  assert.equal(state.tasks[0].blocked.by, '系统')
  assert.match(state.tasks[0].blocked.reason, /没有推进/)
  assert.ok(state.tasks[0].history.some(entry => /没有推进/.test(entry.note)), '卡片历史要留痕')
})

test('换了列：印记记 advanced=true，下一列按新的一棒派（attempts 重新从 1 开始）', async t => {
  const { dispatcher, state, deliveries } = await harness(t, {
    tasks: [{}],
    autoStatuses: ['test', 'dev'],
  })
  await dispatcher.tick()
  assert.equal(state.tasks[0].dispatch.attempts, 1)
  // agent 在跑的时候把卡推进到「开发中」
  state.tasks[0].status = 'dev'
  state.tasks[0].role = 'dev'
  dispatcher.settle('studio-t-1-qa')
  assert.equal(state.tasks[0].dispatch.state, 'done')
  assert.equal(state.tasks[0].dispatch.advanced, true, '换过列')
  await dispatcher.tick()
  assert.equal(deliveries.length, 2, '新列要派出去')
  assert.equal(state.tasks[0].dispatch.status, 'dev')
  assert.equal(state.tasks[0].dispatch.attempts, 1, '换列 = 新的一棒，次数重新算')
})

test('重启：进程结束时还在跑的卡，即使不在自动列也重新派一次', async t => {
  const { dispatcher, state, deliveries, live } = await harness(t, {
    tasks: [{ status: 'accept' }],
    autoStatuses: ['design', 'dev_ready', 'test'],
  })
  state.tasks[0].dispatch = {
    key: 't-1:accept', status: 'accept', expert: 'dev', sessionId: 'studio-t-1-dev',
    state: 'running', attempts: 0, at: Date.now() - 3 * 60_000,
  }
  live.clear() // 新进程里老会话都不在了
  await dispatcher.reconcile()
  assert.equal(state.tasks[0].dispatch.status, '', '收掉印记，允许重派')
  assert.equal(state.tasks[0].dispatch.resume, true, '打上续跑标记：不受自动列白名单限制')
  await dispatcher.tick()
  assert.equal(deliveries.length, 1, 'accept 不在自动列里，也要接着跑')
})

test('重启：上一轮正常结束但没推进的卡，也接着派一次', async t => {
  const { dispatcher, state, deliveries } = await harness(t, {
    tasks: [{ status: 'dev' }],
    autoStatuses: ['design', 'dev_ready', 'test'],
  })
  state.tasks[0].dispatch = {
    key: 't-1:dev', status: 'dev', expert: 'dev', sessionId: 'studio-t-1-dev',
    state: 'done', advanced: false, attempts: 1, at: Date.now() - 3600_000,
  }
  await dispatcher.reconcile()
  assert.equal(state.tasks[0].dispatch.resume, true)
  await dispatcher.tick()
  assert.equal(deliveries.length, 1, '重启后接着派，不受自动列白名单限制')
  assert.equal(state.tasks[0].dispatch.attempts, 2, '续跑算同一棒的下一次')
})

test('重启：人主动「停止」的卡不动（那是人的意图）', async t => {
  const { dispatcher, state, deliveries } = await harness(t, {
    tasks: [{ status: 'test' }],
    autoStatuses: ['test'],
  })
  state.tasks[0].dispatch = {
    key: 't-1:test', status: 'test', expert: 'qa', sessionId: 'studio-t-1-qa',
    state: 'stopped', attempts: 1, at: Date.now() - 10 * 60_000,
  }
  await dispatcher.reconcile()
  assert.equal(state.tasks[0].dispatch.state, 'stopped', '不许把「停止」改成续跑')
  await dispatcher.tick()
  assert.equal(deliveries.length, 0, '人停的卡重启后也不自己跑')
})

test('不在自动列、也没有续跑标记：tick 不派', async t => {
  const { dispatcher, deliveries } = await harness(t, {
    tasks: [{ status: 'dev' }],
    autoStatuses: ['test'],
  })
  await dispatcher.tick()
  assert.equal(deliveries.length, 0)
})

// ------------------------------------------------------------------ 换列 / 解除阻塞
// 换列 = 新的一棒：旧印记必须清掉，否则卡被打回原来那一列时会被当成「已经派过」，永远不动。

async function realStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'studio-continue-store-'))
  const store = new StudioStore(join(dir, 'dsh-studio.json'), {
    dbFile: join(dir, 'dsh-studio.db'),
    secrets: new SecretStore(join(dir, '.secrets.json')),
  })
  await store.ready
  t.after(async () => {
    try { store?.db?.close?.() } catch { /* already closed */ }
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {})
  })
  configureExecutor(new Proxy({}, { get: () => () => undefined }))
  // 闸门在这条测试里无关，先关掉，免得「进开发被拦」把断言带偏。
  await store.mutate(state => {
    state.config.design = { enabled: false, columns: ['dev'] }
    state.config.reviewGate = { enabled: false, columns: ['test'] }
    state.tasks.push({
      id: 't-move1', code: 'DEV-009', title: '换列重置印记', type: 'dev', status: 'test',
      priority: 'normal', requirementId: '', pointId: '', comments: [], history: [], checklist: [],
      cases: [], artifacts: [], tags: [], links: {}, acceptance: [],
      dispatch: { status: 'test', state: 'done', advanced: true, attempts: 3, at: Date.now() },
    })
  })
  return store
}

test('换列时清掉旧印记：卡被打回原来那一列也能重新派', async t => {
  const store = await realStore(t)
  await updateTask(store, 't-move1', { status: 'dev', by: '人' })
  const task = store.snapshot().tasks.find(entry => entry.id === 't-move1')
  assert.equal(task.status, 'dev')
  assert.equal(task.dispatch.status, '', '旧列的印记要清掉')
  assert.equal(task.dispatch.attempts, 0, '新的一棒重新计数')
  assert.equal(task.dispatch.state, 'queued')
})

test('解除阻塞时把催派次数清零：否则一解除就又到上限、再被系统挂起', async t => {
  const store = await realStore(t)
  await store.mutate(state => {
    const task = state.tasks.find(entry => entry.id === 't-move1')
    task.blocked = { by: '系统', at: Date.now(), reason: 'AI 连续 3 轮没有推进' }
    task.dispatch = { status: 'test', state: 'done', advanced: false, attempts: 3, at: Date.now() }
  })
  await updateTask(store, 't-move1', { blocked: false, by: '人' })
  const task = store.snapshot().tasks.find(entry => entry.id === 't-move1')
  assert.equal(task.blocked, null)
  assert.equal(task.dispatch.attempts, 0, '解除阻塞 = 接着走，次数重新算')
})

test('「已完成」列永远不派：就算被勾进自动派单也不派', async t => {
  const { dispatcher, deliveries } = await harness(t, {
    tasks: [{ status: 'done' }],
    autoStatuses: ['done', 'test'],
  })
  await dispatcher.tick()
  assert.equal(deliveries.length, 0, '完成的卡不该再叫 AI 跑一遍')
})
