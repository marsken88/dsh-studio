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
