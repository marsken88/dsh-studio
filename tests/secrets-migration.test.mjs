// 批 6（BUG-002 B 段）：文档出口的 WeKnora apiKey 也不许明文落 state/快照，只进 0600 密钥文件；
// 老库/老快照能一次性迁移且幂等；重启后上传仍能拿到 key；/state 形状不变。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { publicDocsConfig } from '../src/host/doc-sink.js'
import { hashLocalPassword, sanitizeLocalAuth, verifyLocalPassword } from '../src/host/domain.js'
import { SecretStore, StudioStore } from '../src/host/store.js'
import { uploadToWeknora } from '../src/host/weknora-sink.js'

const openStore = (dir, secrets) => new StudioStore(join(dir, 'state.json'), {
  dbFile: join(dir, 'state.db'),
  secrets: secrets ?? new SecretStore(join(dir, 'secrets.json')),
})

const closeAll = stores => {
  for (const store of stores) {
    try { store?.db?.close?.() } catch { /* 已关闭 */ }
  }
}

const cleanup = dir => rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 })

const stateRow = store => JSON.parse(store.db.prepare("SELECT value FROM meta WHERE key = 'state'").get().value)
const lastSnapshot = store => store.db.prepare('SELECT blob FROM snapshots ORDER BY id DESC LIMIT 1').get()?.blob ?? ''
const vaultOf = dir => JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'))

const setPassword = (store, password) => store.mutate(state => {
  state.config.localAuth = {
    ...sanitizeLocalAuth(state.config.localAuth),
    password: hashLocalPassword(password),
    mustChange: false,
  }
})

test('口令哈希：state 与快照不带，密钥文件带；重开后仍能登录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-studio-localauth-'))
  const stores = []
  try {
    const store = openStore(dir)
    stores.push(store)
    await store.ready
    await setPassword(store, 'newpass-123')

    const saved = stateRow(store)
    assert.equal(saved.config.localAuth.password, null, 'state 里不能留哈希')
    assert.equal(saved.config.localAuth.mustChange, false, '不要让界面误报「默认口令」')
    assert.doesNotMatch(lastSnapshot(store), /"password":\s*\{/, '快照里也不能留哈希')

    const vault = vaultOf(dir)
    assert.equal(typeof vault.localAuth?.hash, 'string', '密钥文件里要有哈希')
    assert.ok(!JSON.stringify(saved).includes(vault.localAuth.hash), '哈希不能同时出现在 state 里')

    const reopened = openStore(dir)
    stores.push(reopened)
    await reopened.ready
    const local = reopened.snapshot().config.localAuth
    assert.equal(typeof local.password?.hash, 'string', '重开后要把哈希补回内存')
    assert.equal(local.mustChange, false)
    assert.equal(verifyLocalPassword(local, 'admin', 'newpass-123').ok, true, '重开后新口令要能登录')
    assert.equal(verifyLocalPassword(local, 'admin', 'admin').ok, false)
  } finally {
    closeAll(stores)
    cleanup(dir)
  }
})

test('老库迁移：state 里已有哈希 + 密钥文件没有 → 下一次落盘迁走且不丢口令', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-studio-localauth-migrate-'))
  const stores = []
  try {
    const store = openStore(dir)
    stores.push(store)
    await store.ready
    await setPassword(store, 'oldpass-123')
    const legacyHash = store.snapshot().config.localAuth.password

    // 模拟升级前：哈希还在 state 里，密钥文件里没有 localAuth
    const saved = stateRow(store)
    saved.config.localAuth.password = legacyHash
    saved.config.localAuth.mustChange = false
    store.db.prepare("UPDATE meta SET value = ? WHERE key = 'state'").run(JSON.stringify(saved))
    const vault = vaultOf(dir)
    delete vault.localAuth
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify(vault))

    const reopened = openStore(dir)
    stores.push(reopened)
    await reopened.ready
    assert.equal(typeof reopened.snapshot().config.localAuth.password?.hash, 'string', '老库的哈希先在内存里')
    await reopened.mutate(state => { state.updatedAt = Date.now() })
    assert.equal(stateRow(reopened).config.localAuth.password, null, '下一次落盘要迁走')
    assert.equal(typeof vaultOf(dir).localAuth?.hash, 'string', '迁进密钥文件')

    const again = openStore(dir)
    stores.push(again)
    await again.ready
    assert.equal(verifyLocalPassword(again.snapshot().config.localAuth, 'admin', 'oldpass-123').ok, true, '迁移后老口令仍能登录')
  } finally {
    closeAll(stores)
    cleanup(dir)
  }
})

test('默认口令：state 与密钥文件都不带哈希，mustChange 仍为 true', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-studio-localauth-default-'))
  const stores = []
  try {
    const store = openStore(dir)
    stores.push(store)
    await store.ready
    await store.mutate(state => { state.updatedAt = Date.now() })
    const saved = stateRow(store)
    assert.equal(saved.config.localAuth.password, null)
    assert.equal(saved.config.localAuth.mustChange, true)
    assert.equal(vaultOf(dir).localAuth, null)

    const reopened = openStore(dir)
    stores.push(reopened)
    await reopened.ready
    assert.equal(reopened.snapshot().config.localAuth.password, null)
    assert.equal(reopened.snapshot().config.localAuth.mustChange, true)
  } finally {
    closeAll(stores)
    cleanup(dir)
  }
})

test('密钥文件写失败时：哈希留在 state 里，不能为了「干净」把口令弄丢', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-studio-localauth-fail-'))
  const stores = []
  try {
    const failing = {
      load: async () => ({ gitlab: {}, feishu: {}, ldap: {}, legacy: {}, localAuth: null }),
      replace: async () => { throw new Error('disk full') },
    }
    const store = openStore(dir, failing)
    stores.push(store)
    await store.ready
    await setPassword(store, 'keepme-123')
    assert.equal(typeof stateRow(store).config.localAuth.password?.hash, 'string', '密钥写失败就必须把哈希留在 state')
  } finally {
    closeAll(stores)
    cleanup(dir)
  }
})

/* ── BUG-002 B 段：文档出口 apiKey 的落盘面 ─────────────────────────── */

const DOCS_SINK = { baseUrl: 'http://127.0.0.1:1/api/v1', apiKey: '', tenantId: 't1', knowledgeBaseId: 'kb-bug002' }
const setDocsKey = (store, apiKey) => store.mutate(state => {
  state.config.docs = { ...state.config.docs, weknora: { ...state.config.docs.weknora, ...DOCS_SINK, apiKey } }
})
const vaultDocsKey = dir => vaultOf(dir).docs?.weknora?.apiKey
/* 假 WeKnora：只收建文档 + reparse，把鉴权头记下来（判「重启后上传仍拿到 key」）。 */
const startFakeWeKnora = async () => {
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      seen.push({ url: req.url, key: req.headers['x-api-key'] })
      res.setHeader('Content-Type', 'application/json')
      if (req.url.endsWith('/knowledge/manual')) return res.end(JSON.stringify({ data: { id: 'k-bug002' } }))
      if (req.url.endsWith('/reparse')) return res.end(JSON.stringify({ success: true }))
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { seen, port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) }
}

test('BUG-002 B：apiKey 不落 state/快照，只进密钥文件；重开后上传仍拿到 key；/state 形状不变', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-studio-docs-key-'))
  const stores = []
  const KEY = 'sk-test-bug002-hydrate-01'
  try {
    const store = openStore(dir)
    stores.push(store)
    await store.ready
    await setDocsKey(store, KEY)

    /* ① 磁盘两面：meta.state（sqlite 的 state.json 等价物）与 snapshots.blob */
    const saved = stateRow(store)
    assert.equal(saved.config.docs.weknora.apiKey, '', 'state 里不能留明文 apiKey')
    assert.ok(!JSON.stringify(saved).includes(KEY), 'meta.state 全文不许出现 key')
    assert.ok(!lastSnapshot(store).includes(KEY), 'snapshots.blob 不许出现 key')
    assert.equal(vaultDocsKey(dir), KEY, '密钥文件里必须有')
    assert.equal(store.snapshot().config.docs.weknora.apiKey, KEY, '内存保留（运行期上传要用）')

    /* ② /state 形状不变：apiKey 恒空 + apiKeySet */
    const pub = publicDocsConfig(store.snapshot().config.docs)
    assert.equal(pub.weknora.apiKey, '')
    assert.equal(pub.weknora.apiKeySet, true)

    /* ③ 幂等：再存一次不会把密钥文件写坏、也不会把明文写回 state */
    await setDocsKey(store, KEY)
    await store.mutate(state => { state.config.docs.weknora.tenantId = 't2' })
    assert.equal(stateRow(store).config.docs.weknora.apiKey, '')
    assert.equal(vaultDocsKey(dir), KEY, '重复保存后密钥文件仍是同一个值')

    /* ④ 重启：hydration 补回，并且真的能拿去上传 */
    const reopened = openStore(dir)
    stores.push(reopened)
    await reopened.ready
    const hydrated = reopened.snapshot().config.docs.weknora
    assert.equal(hydrated.apiKey, KEY, '重开后从密钥文件补回内存')
    const fake = await startFakeWeKnora()
    try {
      const result = await uploadToWeknora({
        sink: { ...hydrated, baseUrl: `http://127.0.0.1:${fake.port}` },
        title: 'BUG-002 自验',
        markdown: '# 自验',
      })
      assert.equal(result.ok, true, '上传应当成功：' + result.error)
      assert.equal(fake.seen[0]?.key, KEY, '重启后上传仍带上 hydration 回来的 key')
    } finally {
      await fake.close()
    }
  } finally {
    closeAll(stores)
    cleanup(dir)
  }
})

test('BUG-002 B：老库明文 + 历史快照明文一次性迁移，重复启动不重复搬、不覆盖新 key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-studio-docs-key-migrate-'))
  const stores = []
  const KEY = 'sk-test-bug002-migrate-01'
  try {
    const store = openStore(dir)
    stores.push(store)
    await store.ready
    await setDocsKey(store, KEY)

    /* 模拟升级前：meta.state 里是明文、密钥文件里没有 docs、历史快照里也躺着明文。 */
    const saved = stateRow(store)
    saved.config.docs.weknora.apiKey = KEY
    store.db.prepare("UPDATE meta SET value = ? WHERE key = 'state'").run(JSON.stringify(saved))
    const vault = vaultOf(dir)
    delete vault.docs
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify(vault))
    const legacyBlob = JSON.stringify(saved)
    store.db.prepare('INSERT INTO snapshots (at, revision, bytes, blob) VALUES (?, ?, ?, ?)')
      .run(Date.now(), saved.revision, legacyBlob.length, legacyBlob)
    const legacyId = store.db.prepare('SELECT MAX(id) AS id FROM snapshots').get().id
    assert.ok(String(store.db.prepare('SELECT blob FROM snapshots WHERE id = ?').get(legacyId).blob).includes(KEY), '布场：快照里确实有明文')

    const reopened = openStore(dir)
    stores.push(reopened)
    await reopened.ready
    assert.equal(reopened.snapshot().config.docs.weknora.apiKey, KEY, '老库里的明文先在内存里（上传要用）')
    assert.equal(vaultDocsKey(dir), KEY, '启动时先把它写进密钥文件')
    assert.ok(!String(reopened.db.prepare('SELECT blob FROM snapshots WHERE id = ?').get(legacyId).blob).includes(KEY), '历史快照里的明文要擦掉')

    await reopened.mutate(state => { state.updatedAt = Date.now() })
    assert.equal(stateRow(reopened).config.docs.weknora.apiKey, '', '下一次落盘把 state 里的明文剥离')
    assert.ok(!lastSnapshot(reopened).includes(KEY), '新快照不含明文')

    /* 幂等：再启动一次，不重复搬、不覆盖；已剥离的 state 从密钥文件补回。 */
    const again = openStore(dir)
    stores.push(again)
    await again.ready
    assert.equal(again.snapshot().config.docs.weknora.apiKey, KEY, '重开后仍能拿到 key')
    await again.mutate(state => { state.updatedAt = Date.now() })
    assert.equal(vaultDocsKey(dir), KEY, '再次启动不会把密钥文件里的值覆盖/清空')
    assert.equal(stateRow(again).config.docs.weknora.apiKey, '')
    assert.ok(!lastSnapshot(again).includes(KEY))
  } finally {
    closeAll(stores)
    cleanup(dir)
  }
})

test('BUG-002 B：单文件模式（sqlite 不可用）state.json 也不带明文，重开能补回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-studio-docs-key-file-'))
  const stores = []
  const KEY = 'sk-test-bug002-fileengine-01'
  try {
    /* 用一个同名文件挡住 dbFile 的父目录 → sqlite 起不来 → 回落单文件模式（生产上的兼容路径）。 */
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'x')
    const store = new StudioStore(join(dir, 'state.json'), {
      dbFile: join(blocked, 'state.db'),
      secrets: new SecretStore(join(dir, 'secrets.json')),
    })
    stores.push(store)
    await store.ready
    assert.equal(store.engine, 'file', '这条用例要的就是单文件模式')
    await setDocsKey(store, KEY)

    const raw = readFileSync(join(dir, 'state.json'), 'utf8')
    assert.ok(!raw.includes(KEY), 'state.json 原文不许出现 key')
    assert.equal(JSON.parse(raw).config.docs.weknora.apiKey, '')
    assert.equal(vaultDocsKey(dir), KEY)

    const reopened = new StudioStore(join(dir, 'state.json'), {
      dbFile: join(blocked, 'state.db'),
      secrets: new SecretStore(join(dir, 'secrets.json')),
    })
    stores.push(reopened)
    await reopened.ready
    assert.equal(reopened.snapshot().config.docs.weknora.apiKey, KEY, '单文件模式同样靠 hydration 补回')
    assert.ok(existsSync(join(dir, 'secrets.json')))
  } finally {
    closeAll(stores)
    cleanup(dir)
  }
})

test('BUG-002 B：密钥文件写失败时，明文留在 state 里（不能为了干净把 key 弄丢）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-studio-docs-key-fail-'))
  const stores = []
  const KEY = 'sk-test-bug002-fail-01'
  try {
    let fail = true
    const flaky = {
      load: async () => ({ gitlab: {}, feishu: {}, ldap: {}, legacy: {}, localAuth: null, docs: {} }),
      replace: async next => {
        if (fail) throw new Error('disk full')
        return next
      },
    }
    const store = openStore(dir, flaky)
    stores.push(store)
    await store.ready
    await setDocsKey(store, KEY)
    assert.equal(stateRow(store).config.docs.weknora.apiKey, KEY, '密钥文件写失败就必须把明文留在 state（否则重启后 key 没了）')
    fail = false
    await store.mutate(state => { state.updatedAt = Date.now() })
    assert.equal(stateRow(store).config.docs.weknora.apiKey, '', '恢复后下一次落盘再剥离')
  } finally {
    closeAll(stores)
    cleanup(dir)
  }
})
