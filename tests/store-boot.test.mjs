// Boots the real StudioStore against a throwaway directory. Catches the class of
// runtime ReferenceErrors (a moved helper, a forgotten import) that `node --check`
// cannot see and that only show up when a live process loads the layer.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SecretStore, StudioStore } from '../src/host/store.js'

test('store: boots, persists and reloads a state file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-studio-store-'))
  let store, again
  try {
    const file = join(dir, 'dsh-studio.json')
    store = new StudioStore(file, { dbFile: join(dir, 'dsh-studio.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
    await store.ready
    const first = store.snapshot()
    const rev0 = Number(first.revision)
    assert.ok(first.config.columns !== undefined, 'default columns exist')
    assert.equal(first.tasks.length, 0)

    await store.mutate(state => {
      state.tasks.push({ id: 't-test0001', title: 'boot guard', status: 'clarify', history: [], comments: [], checklist: [], cases: [], artifacts: [], tags: [] })
      state.audit.push({ at: Date.now(), by: '张三', route: '/task/create', level: 'write', status: 200, ok: true, summary: 'boot guard' })
    })
    assert.equal(store.snapshot().tasks.length, 1)
    assert.ok(store.snapshot().revision > rev0)
    await store.chain

    again = new StudioStore(file, { dbFile: join(dir, 'dsh-studio.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
    await again.ready
    assert.equal(again.snapshot().tasks.length, 1, 'state survives a restart')
    assert.equal(again.snapshot().audit.length, 1, 'audit entries survive the sanitizers')

    const raw = await readFile(file, 'utf8').catch(() => '')
    assert.ok(raw === '' || raw.includes('t-test0001') || raw === '', 'legacy file either exists or is irrelevant')
    assert.ok(store.describe().engine === 'sqlite' || store.describe().engine === 'file')
  } finally {
    try { store?.db?.close?.() } catch { /* already closed */ }
    try { again?.db?.close?.() } catch { /* already closed */ }
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {})
  }
})

test('store: rolling back restores the baseline text and voids the signoff', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { StudioStore, SecretStore } = await import('../src/host/store.js')
  const { saveRequirement, mutateReqDoc } = await import('../src/host/executor.js')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-studio-rollback-'))
  const store = new StudioStore(join(dir, 'dsh-studio.json'), { dbFile: join(dir, 'dsh-studio.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  try {
    await store.ready
    const req = await saveRequirement(store, { title: '需求回滚', docs: [{ id: 'd1', title: 'PRD', content: 'v1 原始正文', version: 'v1.0' }] })
    const docId = req.docs[0].id
    await mutateReqDoc(store, { id: req.id, action: 'baseline', docId, by: '产品' })
    await mutateReqDoc(store, { id: req.id, action: 'update', docId, doc: { content: 'v2 改坏的正文' } })
    await store.mutate((state) => {
      const found = state.requirements.find((item) => item.id === req.id)
      found.signoff = { by: '产品', at: 1, note: '已验收' }
    })
    await mutateReqDoc(store, { id: req.id, action: 'rollback', by: '产品' })
    const after = store.snapshot().requirements.find((item) => item.id === req.id)
    assert.equal(after.docs[0].content, 'v1 原始正文', '正文回到基线')
    assert.equal(after.docs[0].version, 'v1.1', '版本号 +1')
    assert.equal(after.signoff, null, '回滚是实质变更，签字作废')
    assert.ok(after.history.some((entry) => entry.field === 'PRD 回滚'), '历史留一条回滚记录')
    assert.equal(after.baseline.version, 'v1.1', '基线跟着指向恢复后的版本')
  } finally {
    try { store.db?.close?.() } catch { /* already closed */ }
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {})
  }
})

test('store: saving a requirement twice keeps the answers added later', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { StudioStore, SecretStore } = await import('../src/host/store.js')
  const { saveRequirement } = await import('../src/host/executor.js')
  const { discoveryGaps } = await import('../src/host/discovery.js')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-studio-req-'))
  const store = new StudioStore(join(dir, 'dsh-studio.json'), { dbFile: join(dir, 'dsh-studio.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  try {
    await store.ready
    const first = await saveRequirement(store, { title: '管理后台' })
    assert.equal(discoveryGaps(first).length, 3, '新需求三问都空')
    const second = await saveRequirement(store, { id: first.id, discovery: { server: 'node:sqlite', auth: '服务端 403', boundary: '前后端' } })
    assert.equal(discoveryGaps(second).length, 0, '补答之后要存下来')
    const reread = store.snapshot().requirements.find(item => item.id === first.id)
    assert.equal(reread.discovery.auth, '服务端 403')
  } finally {
    try { store.db?.close?.() } catch { /* already closed */ }
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {})
  }
})

test('store: an agent failure emits agent/failed', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { StudioStore, SecretStore } = await import('../src/host/store.js')
  const { noteAgentFailure } = await import('../src/host/dispatcher.js')
  const { subscribe } = await import('../src/host/events.js')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-studio-agentfail-'))
  const store = new StudioStore(join(dir, 'dsh-studio.json'), { dbFile: join(dir, 'dsh-studio.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  const seen = []
  const off = subscribe(event => { if (event.type === 'agent/failed') seen.push(event.payload) })
  try {
    await store.ready
    await store.mutate(state => {
      state.tasks.push({ id: 't-fail', title: '出错的卡', status: 'dev', history: [], agentFailures: 0, createdAt: Date.now() })
    })
    await noteAgentFailure(store, 't-fail', new Error('模型通道 503'), '系统', { notify: false })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].taskId, 't-fail')
    assert.equal(seen[0].attempts, 1)
    assert.match(seen[0].error, /503/)
  } finally {
    off()
    try { store.db?.close?.() } catch { /* already closed */ }
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {})
  }
})

test('store: recordRun actually writes the run log to disk', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { StudioStore, SecretStore } = await import('../src/host/store.js')
  const { attachRunLog, recordRun, RUN_LOG } = await import('../src/host/dispatcher.js')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-studio-runs-write-'))
  const store = new StudioStore(join(dir, 'dsh-studio.json'), { dbFile: join(dir, 'dsh-studio.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  try {
    await store.ready
    RUN_LOG.length = 0
    attachRunLog(store)
    recordRun({ taskId: 't-write-1', expert: 'dev', expertName: '开发工程师', model: 'm', at: Date.now() })
    // 写盘是去抖的（1.5s），等它落下去——这条测试专门盯「写入」这一步。
    await new Promise(resolve => setTimeout(resolve, 1900))
    const saved = await store.readSide('agent-runs')
    assert.equal(Array.isArray(saved), true, 'runs must be written')
    assert.equal(saved.length, 1)
    assert.equal(saved[0].taskId, 't-write-1')
    assert.equal(saved[0].expertName, '开发工程师')
  } finally {
    RUN_LOG.length = 0
    try { store.db?.close?.() } catch { /* already closed */ }
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {})
  }
})

test('store: the dispatch run log restores from its side key', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { StudioStore, SecretStore } = await import('../src/host/store.js')
  const { attachRunLog, RUN_LOG } = await import('../src/host/dispatcher.js')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-studio-runs-'))
  const store = new StudioStore(join(dir, 'dsh-studio.json'), { dbFile: join(dir, 'dsh-studio.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  try {
    await store.ready
    await store.writeSide('agent-runs', [{ taskId: 't-run-1', expert: 'dev', at: 1, doneAt: 2, ms: 1 }])
    RUN_LOG.length = 0
    attachRunLog(store)
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(RUN_LOG.length, 1, 'runs come back after a restart')
    assert.equal(RUN_LOG[0].taskId, 't-run-1')
  } finally {
    RUN_LOG.length = 0
    try { store.db?.close?.() } catch { /* already closed */ }
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {})
  }
})

test('store: suites round-trip and keep exactly one default', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { loadSuites, saveSuites } = await import('../src/host/cases.js')
  const { StudioStore, SecretStore } = await import('../src/host/store.js')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-studio-suite-'))
  const store = new StudioStore(join(dir, 'dsh-studio.json'), { dbFile: join(dir, 'dsh-studio.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  try {
    await store.ready
    const rev = store.snapshot().revision
    const saved = await saveSuites(store, [
      { id: 'a', name: '全量', isDefault: true, rules: { httpOnly: true } },
      { id: 'b', name: '冒烟', isDefault: true, rules: { priorities: ['p0'] } },
    ])
    assert.deepEqual(saved.map(item => item.isDefault), [true, false], 'only the first default wins')
    const again = await loadSuites(store)
    assert.equal(again.length, 2)
    assert.equal(again[1].name, '冒烟')
    assert.equal(store.snapshot().revision, rev, 'suites must not bump the revision')
  } finally {
    try { store.db?.close?.() } catch { /* already closed */ }
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {})
  }
})

test('store: team memory appends, caps and clears through the side key', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { appendTeamMemory, clearTeamMemory, loadTeamMemory } = await import('../src/host/team-memory.js')
  const { StudioStore, SecretStore } = await import('../src/host/store.js')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-studio-team-'))
  const store = new StudioStore(join(dir, 'dsh-studio.json'), { dbFile: join(dir, 'dsh-studio.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  try {
    await store.ready
    const rev = store.snapshot().revision
    await appendTeamMemory(store, 'team-1', { taskId: 't1', title: '第一张卡', outcome: '做完的卡' })
    await appendTeamMemory(store, 'team-1', { taskId: 't2', title: '第二张卡', outcome: '修完的缺陷' })
    const all = await loadTeamMemory(store)
    assert.equal(all['team-1'].length, 2)
    assert.equal(all['team-1'][0].title, '第二张卡', 'newest first')
    assert.equal(store.snapshot().revision, rev, 'team memory must not bump the revision')
    await clearTeamMemory(store, 'team-1')
    assert.deepEqual(await loadTeamMemory(store), {})
  } finally {
    try { store.db?.close?.() } catch { /* already closed */ }
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {})
  }
})

test('store: side values survive a restart without bumping the revision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-studio-side-'))
  let store, again
  try {
    const file = join(dir, 'dsh-studio.json')
    const options = { dbFile: join(dir, 'dsh-studio.db'), secrets: new SecretStore(join(dir, '.secrets.json')) }
    store = new StudioStore(file, options)
    await store.ready
    const rev = store.snapshot().revision
    await store.writeSide('integration-health', { feishu: { ok: false, failures: 3, lastError: 'webhook 404' } })
    assert.equal(store.snapshot().revision, rev, 'side data must not bump the board revision')
    assert.deepEqual(await store.readSide('integration-health'), { feishu: { ok: false, failures: 3, lastError: 'webhook 404' } })
    assert.equal(await store.readSide('nope'), null)

    again = new StudioStore(file, options)
    await again.ready
    const restored = await again.readSide('integration-health')
    assert.equal(restored?.feishu?.failures, 3, 'health survives a restart')
  } finally {
    try { store?.db?.close?.() } catch { /* already closed */ }
    try { again?.db?.close?.() } catch { /* already closed */ }
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {})
  }
})

test('store: schema 7 drops the retired role templates and keeps their models on the experts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-studio-roles-'))
  let store
  try {
    const file = join(dir, 'dsh-studio.json')
    /* 老库：schema 6 + 角色模板，专家里一个有模型、一个没有。 */
    await writeFile(file, JSON.stringify({
      revision: 5,
      updatedAt: Date.now(),
      config: {
        schema: 6,
        experts: [
          { id: 'product', name: '产品经理', role: 'product', model: '', prompt: '你是产品经理' },
          { id: 'expert-a1', name: '支付架构', role: 'architect', model: 'deepseek-v4.1-flash', prompt: '你是架构师' },
          { id: 'expert-b2', name: '测试工程师', role: 'qa', model: '', prompt: '你是测试工程师' },
        ],
        roles: {
          product: { label: '产品', model: 'deepseek-v4-pro', prompt: '旧的模板提示词' },
          architect: { label: '架构', model: 'deepseek-v4-pro', prompt: '' },
          qa: { label: '测试', model: 'deepseek-v4.1-flash', prompt: '' },
        },
      },
      tasks: [],
      requirements: [],
      releases: [],
      audit: [],
    }), 'utf8')
    store = new StudioStore(file, { dbFile: join(dir, 'dsh-studio.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
    await store.ready
    const config = store.snapshot().config
    assert.equal(config.schema, 8, 'schema bumps to 8（schema 7 搬角色模板，schema 8 扩自动派单默认列）')
    /* schema 7 起 `config.roles` 换了个意思：从「角色模板对象」变成「角色位白名单数组」。
       旧库里的模板对象不许漏进 state（模板的模型已经抄到专家上了，见下面几条），
       而新的白名单要按默认值补上 —— 旧库读进来不会缺这个键。 */
    assert.deepEqual(config.roles, ['product', 'architect', 'dev', 'qa', 'ops'], '旧的角色模板对象不会漏进角色白名单，旧库补默认白名单')
    const byId = id => config.experts.find(expert => expert.id === id)
    assert.equal(byId('product').model, 'deepseek-v4-pro', 'an expert with no model inherits the role template model')
    assert.equal(byId('expert-b2').model, 'deepseek-v4.1-flash', '匹配按角色位（role），不是按专家 id')
    assert.equal(byId('expert-a1').model, 'deepseek-v4.1-flash', '专家自己的模型不被模板覆盖')
    assert.equal(byId('product').prompt, '你是产品经理', '模板提示词从来不进专家——迁移也不补')
  } finally {
    try { store?.db?.close?.() } catch { /* already closed */ }
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {})
  }
})

test('store: schema 8 把「旧默认自动派单列」扩成除已完成外全部，自定义过的保持原样', async () => {
  const bootstrap = async (autoStatuses) => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-studio-auto-'))
    const file = join(dir, 'dsh-studio.json')
    await writeFile(file, JSON.stringify({
      revision: 3,
      updatedAt: Date.now(),
      config: { schema: 7, agents: { enabled: true, autoStatuses } },
      tasks: [],
      requirements: [],
      releases: [],
      audit: [],
    }), 'utf8')
    const store = new StudioStore(file, { dbFile: join(dir, 'dsh-studio.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
    await store.ready
    const config = store.snapshot().config
    return { config, cleanup: async () => {
      try { store?.db?.close?.() } catch { /* already closed */ }
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {})
    } }
  }
  const legacy = await bootstrap(['design', 'dev_ready', 'test'])
  try {
    assert.equal(legacy.config.schema, 8)
    assert.deepEqual(
      legacy.config.agents.autoStatuses,
      ['clarify', 'design', 'dev_ready', 'dev', 'review', 'test', 'accept'],
      '旧默认的三个列扩成「除已完成外全部」：卡停在开发中/待评审/待验收时不该再也不动',
    )
    assert.equal(legacy.config.agents.autoStatuses.includes('done'), false, '「已完成」永远不自动派单')
  } finally { await legacy.cleanup() }

  const custom = await bootstrap(['design', 'test'])
  try {
    assert.deepEqual(custom.config.agents.autoStatuses, ['design', 'test'], '用户自己收窄过的不许被迁移改掉')
  } finally { await custom.cleanup() }
})
