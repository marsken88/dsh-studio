// 出口分发：按 config.docs 决定投递到哪儿；WeKnora 为主时失败要抛，both 时只记 error。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { sanitizeDocsConfig } from '../src/host/doc-sink.js'
import { syncArtifact as syncArtifactWith } from '../src/host/doc-sync.js'

const stubWeknora = ({ manualStatus = 200 } = {}) => {
  const calls = []
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      calls.push(req.url)
      res.setHeader('Content-Type', 'application/json')
      if (req.url.endsWith('/knowledge/manual')) {
        if (manualStatus !== 200) {
          res.statusCode = manualStatus
          return res.end(JSON.stringify({ error: { message: 'boom' } }))
        }
        return res.end(JSON.stringify({ data: { id: 'k-9' } }))
      }
      if (req.url.endsWith('/reparse')) return res.end(JSON.stringify({ success: true }))
      res.statusCode = 404
      res.end('{}')
    })
  })
  return { server, calls }
}

/* 有状态的假知识库：记录「当前库里活着哪些文档」。
   并发测试要靠它判「有没有留下没人认领的孤儿」，只数请求次数是看不出来的。 */
const stubWeknoraKb = () => {
  const calls = []
  const live = new Set()
  let seq = 0
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const url = String(req.url)
      calls.push(`${req.method} ${url}`)
      res.setHeader('Content-Type', 'application/json')
      const byId = /^\/knowledge\/([^/]+)$/.exec(url)
      if (req.method === 'DELETE' && byId !== null) {
        const id = decodeURIComponent(byId[1])
        if (!live.has(id)) {
          res.statusCode = 404
          return res.end('{}')
        }
        live.delete(id)
        return res.end(JSON.stringify({ ok: true }))
      }
      if (req.method === 'POST' && url.endsWith('/knowledge/manual')) {
        seq += 1
        const id = `k-${seq}`
        live.add(id)
        return res.end(JSON.stringify({ data: { id } }))
      }
      if (req.method === 'POST' && url.endsWith('/reparse')) return res.end(JSON.stringify({ success: true }))
      res.statusCode = 404
      res.end('{}')
    })
  })
  return { server, calls, live }
}

/** 造一个带「需求 + 卡 + 一件交付物」的临时库，三个分发用例共用（省得每个都抄 20 行）。 */
const makeStore = async (docs, prefix = 'dsh-docsink-f-') => {
  const { SecretStore, StudioStore } = await import('../src/host/store.js')
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const store = new StudioStore(join(dir, 'state.json'), { dbFile: join(dir, 'state.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  await store.ready
  await store.mutate(state => {
    state.config.docs = sanitizeDocsConfig(docs)
    state.requirements.push({ id: 'r1', code: 'REQ-1', title: '需求一' })
    state.tasks.push({
      id: 't1', code: 'DEV-001', title: '交付物卡', type: 'dev', status: 'dev', role: 'dev', requirementId: 'r1',
      checklist: [], comments: [], history: [], cases: [],
      artifacts: [{ id: 'a1', kind: 'design', title: '方案定稿', ref: '', content: '# 方案\n正文', stage: 'design', status: 'delivered', at: 0 }],
    })
  })
  return { store, dir }
}
const dropDir = dir => { try { rmSync(dir, { recursive: true, force: true }) } catch {} }

const FEISHU_DOC = {
  token: 'f-1',
  url: 'https://laiyifen.feishu.cn/docx/f-1',
  name: 'DEV-001 方案定稿.md',
  at: 1795627000000,
  error: '',
}

test('provider=weknora：只写知识库，台账落在 artifact.docs.weknora', async () => {
  const { SecretStore, StudioStore } = await import('../src/host/store.js')
  const { syncArtifact } = await import('../src/host/executor.js')
  const { server, calls } = stubWeknora()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-docsink-'))
  const store = new StudioStore(join(dir, 'state.json'), { dbFile: join(dir, 'state.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  try {
    await store.ready
    await store.mutate(state => {
      state.config.docs = sanitizeDocsConfig({
        provider: 'weknora',
        weknora: { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', tenantId: '10000', knowledgeBaseId: 'kb1' },
      })
      state.requirements.push({ id: 'r1', code: 'REQ-1', title: '需求一' })
      state.tasks.push({
        id: 't1', code: 'DEV-001', title: '交付物卡', type: 'dev', status: 'dev', role: 'dev',
        requirementId: 'r1', checklist: [], comments: [], history: [], cases: [], artifacts: [
          { id: 'a1', kind: 'design', title: '方案定稿', ref: '', content: '# 方案\n正文', stage: 'design', status: 'delivered', at: 0 },
        ],
      })
    })
    const out = await syncArtifact(store, 't1', 'a1')
    assert.equal(out.provider, 'weknora')
    assert.equal(out.primary, 'weknora')
    assert.equal(out.sinks.weknora.ok, true)
    assert.match(String(out.url), /\/knowledge\/k-9$/, '只写知识库时也要给消费方一个链接')
    assert.equal(out.token, '', 'token 空串，与老形状兼容')
    assert.deepEqual(calls.map(url => url.split('/').slice(-1)[0]), ['manual', 'reparse'])
    const card = store.snapshot().tasks.find(item => item.id === 't1')
    assert.equal(card.artifacts[0].docs.weknora.knowledgeId, 'k-9')
    assert.equal(card.artifacts[0].docs.weknora.error, '')
  } finally {
    await new Promise(resolve => server.close(resolve))
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('provider=weknora 但连不上：主出口失败要抛，不能假装写成功', async () => {
  const { SecretStore, StudioStore } = await import('../src/host/store.js')
  const { syncArtifact } = await import('../src/host/executor.js')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-docsink-fail-'))
  const store = new StudioStore(join(dir, 'state.json'), { dbFile: join(dir, 'state.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  try {
    await store.ready
    await store.mutate(state => {
      state.config.docs = sanitizeDocsConfig({ provider: 'weknora', weknora: { baseUrl: 'http://127.0.0.1:1', apiKey: 'k', knowledgeBaseId: 'kb1' } })
      state.requirements.push({ id: 'r1', code: 'REQ-1', title: '需求一' })
      state.tasks.push({
        id: 't1', code: 'DEV-001', title: '卡', type: 'dev', status: 'dev', role: 'dev', requirementId: 'r1',
        checklist: [], comments: [], history: [], cases: [],
        artifacts: [{ id: 'a1', kind: 'design', title: '方案', content: 'x', stage: '', status: 'delivered', at: 0 }],
      })
    })
    await assert.rejects(() => syncArtifact(store, 't1', 'a1'), /WeKnora 入库失败/)
    const card = store.snapshot().tasks.find(item => item.id === 't1')
    assert.match(card.artifacts[0].docs.weknora.error, /建文档失败/)
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

// —— 飞书分发（a1 的回归网）——
// 这三条是「doc.token/url 语义不变」的唯一机器证据：以前全仓没有一条用例走飞书分发分支，
// artifact-tool.test.mjs 全是 sync:false，drive-tree.test.mjs 只测文件夹与上传参数形状。
// 注意：这里注入桩、不接真 lark-cli —— 「桩验证」证明的是分发层不吞不改飞书结果，
// 真机 doc.token/url 仍要靠准出时的一条真实云盘证据。

test('provider=feishu：飞书结果原样返回，token/url 语义不变', async () => {
  const { store, dir } = await makeStore({ provider: 'feishu' })
  const order = []
  const writeFeishu = async (s, taskId, artifactId) => {
    order.push(`feishu:${taskId}:${artifactId}`)
    return { ...FEISHU_DOC }
  }
  const buildMarkdown = async () => {
    order.push('markdown')
    return '# 不该被渲染'
  }
  try {
    const out = await syncArtifactWith(store, 't1', 'a1', { writeFeishu, buildMarkdown })
    assert.equal(out.provider, 'feishu')
    assert.equal(out.primary, 'feishu')
    // 老消费方（tools.js / routes/tasks.js）读的就是这三个字段，一个字都不能变。
    assert.equal(out.token, FEISHU_DOC.token, 'doc.token 语义不变')
    assert.equal(out.url, FEISHU_DOC.url, 'doc.url 语义不变')
    assert.equal(out.name, FEISHU_DOC.name)
    assert.equal(out.at, FEISHU_DOC.at)
    assert.equal(out.error, '')
    assert.equal(out.sinks.feishu.token, FEISHU_DOC.token, 'sinks 里带着飞书那份原物')
    assert.deepEqual(order, ['feishu:t1:a1'], '只配 feishu 时不该去碰知识库，也不该渲染 Markdown')
  } finally {
    dropDir(dir)
  }
})

test('both + WeKnora 500：不抛，url 仍取飞书链接，失败只记在 docs.weknora.error', async () => {
  const { server, calls } = stubWeknora({ manualStatus: 500 })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const { store, dir } = await makeStore({
    provider: 'both',
    weknora: { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', tenantId: '10000', knowledgeBaseId: 'kb1' },
  }, 'dsh-docsink-both-')
  const order = []
  try {
    const out = await syncArtifactWith(store, 't1', 'a1', {
      buildMarkdown: async () => { order.push('weknora'); return '# 方案\n正文' },
      writeFeishu: async () => { order.push('feishu'); return { ...FEISHU_DOC } },
    })
    // 主从关系：WeKnora 是「从」，它失败不许挡住飞书这条主出口。
    assert.equal(out.provider, 'both')
    assert.equal(out.primary, 'feishu')
    assert.equal(out.token, FEISHU_DOC.token, '副出口失败不能污染主出口的 token')
    assert.equal(out.url, FEISHU_DOC.url, 'url 仍取飞书链接')
    assert.equal(out.sinks.weknora.ok, false)
    assert.match(out.sinks.weknora.error, /建文档失败（HTTP 500/, '失败原因要能被看见')
    assert.deepEqual(order, ['weknora', 'feishu'], '顺序是契约：先知识库后飞书')
    assert.equal(calls.length, 1, '500 之后不该再打 reparse')
    const card = store.snapshot().tasks.find(item => item.id === 't1')
    assert.match(card.artifacts[0].docs.weknora.error, /建文档失败/, '台账上留下失败原因')
  } finally {
    await new Promise(resolve => server.close(resolve))
    dropDir(dir)
  }
})

test('both + 飞书抛：主出口失败要抛，但知识库台账已经落库（孤儿可见、重试可替换）', async () => {
  const { server } = stubWeknora()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const { store, dir } = await makeStore({
    provider: 'both',
    weknora: { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', tenantId: '10000', knowledgeBaseId: 'kb1' },
  }, 'dsh-docsink-bothfail-')
  try {
    await assert.rejects(
      () => syncArtifactWith(store, 't1', 'a1', {
        buildMarkdown: async () => '# 方案\n正文',
        writeFeishu: async () => { throw new Error('飞书 403 缺 scope') },
      }),
      /飞书 403 缺 scope/,
      '主出口（飞书）失败必须让人看到，不能假装归档成功',
    )
    const card = store.snapshot().tasks.find(item => item.id === 't1')
    // Q2 认的「孤儿可自愈」就靠这一条：knowledgeId 已落，下次重试会先删旧再建新，而不是再堆一份。
    assert.equal(card.artifacts[0].docs.weknora.knowledgeId, 'k-9', '台账要先落，重试才能替换而不是新增')
    assert.equal(card.artifacts[0].doc, undefined, '飞书失败不该留下半个 doc')
  } finally {
    await new Promise(resolve => server.close(resolve))
    dropDir(dir)
  }
})

test('并发同步同一交付物：per-key 串行，知识库里只留一份（不加串行会留永久孤儿）', async () => {
  const { server, live } = stubWeknoraKb()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const { store, dir } = await makeStore({
    provider: 'weknora',
    weknora: { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', tenantId: '10000', knowledgeBaseId: 'kb1' },
  }, 'dsh-docsink-race-')
  try {
    const io = { buildMarkdown: async () => '# 方案\n正文' }
    const results = await Promise.all([
      syncArtifactWith(store, 't1', 'a1', io),
      syncArtifactWith(store, 't1', 'a1', io),
    ])
    assert.equal(live.size, 1, `知识库最后只该有 1 份，实际 ${live.size} 份（并发各建一份 = 永久孤儿）`)
    // 第二棒必须看到第一棒的台账，走「替换」而不是「新增」。
    assert.equal(results[1].sinks.weknora.replaced, true, '排队的那一路应当命中上一轮的 knowledgeId')
    const card = store.snapshot().tasks.find(item => item.id === 't1')
    assert.equal(card.artifacts[0].docs.weknora.knowledgeId, [...live][0], '台账指向唯一活在库里的那份')
  } finally {
    await new Promise(resolve => server.close(resolve))
    dropDir(dir)
  }
})
