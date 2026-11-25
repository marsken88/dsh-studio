// 派单会话的模型漂移：配置是 Flash 但会话还按创建时的 Pro 跑——判定与路径推算。
import assert from 'node:assert/strict'
import test from 'node:test'

import { driftNote, isModelDrift, sessionDirOf, sessionWorkspaceSlug } from '../src/host/model-drift.js'

const flash = { provider: 'deepseek-official', model: 'deepseek-v4.1-flash' }
const pro = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }

test('isModelDrift：型号不同就是漂移（真机：配 flash、会话跑 pro）', () => {
  assert.equal(isModelDrift(pro, flash), true)
  assert.equal(isModelDrift(flash, flash), false)
})

test('isModelDrift：provider 只在配置里写了才比', () => {
  assert.equal(isModelDrift({ model: 'm', provider: 'a' }, { model: 'm', provider: 'b' }), true)
  assert.equal(isModelDrift({ model: 'm', provider: 'a' }, { model: 'm' }), false, '配置没写 provider = 借宿主默认')
})

test('isModelDrift：判断不出来的情况不当漂移（不误杀）', () => {
  assert.equal(isModelDrift(null, flash), false, '会话还没发过请求')
  assert.equal(isModelDrift(pro, null), false, '没有配置')
  assert.equal(isModelDrift(pro, { model: '' }), false, '配置为空')
})

test('sessionWorkspaceSlug：DSH 的会话目录命名', () => {
  assert.equal(sessionWorkspaceSlug('C:\\Users\\hp\\dsh-workspace'), '--C-Users-hp-dsh-workspace--')
  assert.equal(sessionWorkspaceSlug('/home/lyf/dsh-workspace'), '--home-lyf-dsh-workspace--')
  assert.equal(sessionWorkspaceSlug(''), '')
})

test('sessionDirOf：home + slug + 会话名；缺参数返回空串（调用方据此跳过归档）', () => {
  assert.equal(
    sessionDirOf('/home/lyf', '/home/lyf/dsh-workspace', 'studio-t-1-dev'),
    '/home/lyf/.dsh/sessions/--home-lyf-dsh-workspace--/studio-t-1-dev',
  )
  assert.equal(sessionDirOf('/home/lyf', '', 'studio-t-1-dev'), '')
  assert.equal(sessionDirOf('/home/lyf', '/tmp/x', ''), '')
})

test('driftNote：写明实际型号、期望型号和已经采取的动作', () => {
  const note = driftNote(pro, flash)
  assert.match(note, /deepseek-official\/deepseek-v4-pro/)
  assert.match(note, /deepseek-official\/deepseek-v4\.1-flash/)
  assert.match(note, /归档旧会话并按配置重建/)
})

// ---------------------------------------------------------------- 重建路径
// 2026-11-25 真机：guardModelDrift 用「当前派单目录」算旧会话路径，卡换了目录后
// rename 扑空 → create 撞「已存在」→ 回退 resume，评论写着「已归档并重建」，
// 实际还在用 pro 跑（最后 503 No available channel）。这两条把真实路径与失败分支钉住。
import { readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Dispatcher, configureDispatcher } from '../src/host/dispatcher.js'

function driftHarness({ locationPath, models }) {
  const comments = []
  configureDispatcher({ commentTask: async (_store, id, body) => { comments.push({ id, body }) } })
  const store = { snapshot: () => ({ config: {}, tasks: [], requirements: [] }), mutate: async fn => fn({}) }
  const ctx = {
    agents: { get: () => undefined },
    get: key => (key === 'sessionPersistence'
      ? { stat: async id => ({ header: { id }, location: locationPath === '' ? undefined : { kind: 'file', path: locationPath(id) } }) }
      : undefined),
  }
  const dispatcher = new Dispatcher(ctx, store)
  return { dispatcher, comments }
}

const handleFor = (model, state = {}) => ({
  agent: { session: { requestContext: () => ({ provider: model.provider, model: model.model }) } },
  dispose: async () => { state.disposed = true },
})

test('漂移重建：按 sessionPersistence 给的真实目录归档（不再用当前 cwd 硬算）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-drift-'))
  const sessionId = 'studio-t-drift1-dev'
  const realDir = join(root, '--home-old-workspace--', sessionId)
  await mkdir(realDir, { recursive: true })
  try {
    const { dispatcher, comments } = driftHarness({
      locationPath: id => join(root, '--home-old-workspace--', id),
      models: {},
    })
    const state = {}
    const rebuiltHandle = handleFor(flash, state)
    let opened = 0
    const out = await dispatcher.guardModelDrift({
      handle: handleFor(pro, state),
      sessionId,
      dir: join(root, 'repo-current'), // 当前派单目录已经变了，按它算会扑空
      agentOptions: flash,
      task: { id: 't-drift1' },
      openSession: async () => { opened += 1; return rebuiltHandle },
    })
    assert.equal(out, rebuiltHandle, '重建成功要返回新会话')
    assert.equal(opened, 1)
    assert.equal(state.disposed, true, '旧会话要先 dispose')
    const stillThere = await stat(realDir).then(() => true).catch(() => false)
    assert.equal(stillThere, false, '旧会话目录要真的被 rename 走，而不是原地留着')
    const entries = readdirSync(join(root, '--home-old-workspace--'))
    assert.equal(entries.some(name => name.startsWith(sessionId + '.stale-')), true, '归档目录要带 .stale- 后缀')
    assert.equal(comments.length, 1, '重建成功也要在卡上留一条（写明归档了哪条目录）')
    assert.match(comments[0].body, /已按配置重建/)
    assert.match(comments[0].body, new RegExp(sessionId))
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {})
  }
})

test('漂移重建失败：旧会话归档不了、重建后仍是旧型号 → 明确失败，不许拿旧型号硬跑', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-drift2-'))
  try {
    const { dispatcher, comments } = driftHarness({ locationPath: () => '', models: {} })
    await assert.rejects(
      () => dispatcher.guardModelDrift({
        handle: handleFor(pro),
        sessionId: 'studio-t-drift2-dev',
        dir: join(root, 'repo-current'),
        agentOptions: flash,
        task: { id: 't-drift2' },
        openSession: async () => handleFor(pro),
      }),
      error => {
        assert.match(String(error.message), /会话模型仍是 deepseek-official\/deepseek-v4-pro/)
        assert.match(String(error.message), /重建后型号没变/)
        return true
      },
    )
    assert.equal(comments.length, 1)
    assert.match(comments[0].body, /归档失败/)
    assert.match(comments[0].body, /这一轮不再开跑/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {})
  }
})

test('没漂移就不动：不 dispose、不重建、不留言', async () => {
  const { dispatcher, comments } = driftHarness({ locationPath: () => '', models: {} })
  const handle = handleFor(flash)
  const out = await dispatcher.guardModelDrift({
    handle,
    sessionId: 'studio-t-ok-dev',
    dir: '/tmp/x',
    agentOptions: flash,
    task: { id: 't-ok' },
    openSession: async () => { throw new Error('不该重建') },
  })
  assert.equal(out, handle)
  assert.equal(comments.length, 0)
})
