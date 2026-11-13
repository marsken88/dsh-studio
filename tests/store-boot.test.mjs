// Boots the real StudioStore against a throwaway directory. Catches the class of
// runtime ReferenceErrors (a moved helper, a forgotten import) that `node --check`
// cannot see and that only show up when a live process loads the layer.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
