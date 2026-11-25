// WeKnora 出口：配置校验、两步调用（建文档 → reparse）、失败不抛。
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { uploadToWeknora, weknoraReady } from '../src/host/weknora-sink.js'

const sink = { baseUrl: 'http://127.0.0.1:1', apiKey: 'k', tenantId: '10000', knowledgeBaseId: 'kb1' }

test('配置校验：缺什么就说缺什么', () => {
  assert.deepEqual(weknoraReady({}), { ok: false, missing: ['baseUrl', 'apiKey', 'knowledgeBaseId'] })
  assert.equal(weknoraReady(sink).ok, true)
})

test('两步调用：先建 manual 文档，再触发 reparse，且带上鉴权头', async () => {
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, key: req.headers['x-api-key'], tenant: req.headers['x-tenant-id'], body })
      res.setHeader('Content-Type', 'application/json')
      if (req.url.endsWith('/knowledge/manual')) return res.end(JSON.stringify({ data: { id: 'k-1' } }))
      if (req.url.endsWith('/reparse')) return res.end(JSON.stringify({ success: true }))
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const result = await uploadToWeknora({
      sink: { ...sink, baseUrl: `http://127.0.0.1:${port}` },
      title: 'REQ-2026-001 定案',
      markdown: '# 定案\n内容',
    })
    assert.equal(result.ok, true)
    assert.equal(result.knowledgeId, 'k-1')
    assert.equal(result.warning, '')
    assert.equal(seen.length, 2, '建文档 + reparse 各一次')
    assert.equal(seen[0].method, 'POST')
    assert.match(seen[0].url, /\/knowledge-bases\/kb1\/knowledge\/manual$/)
    assert.equal(seen[0].key, 'k')
    assert.equal(seen[0].tenant, '10000')
    assert.equal(JSON.parse(seen[0].body).knowledge_type, 'manual')
    assert.match(seen[1].url, /\/knowledge\/k-1\/reparse$/)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('reparse 失败：文档算写进去了，但要把 warning 说清楚', async () => {
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      if (req.url.endsWith('/knowledge/manual')) return res.end(JSON.stringify({ data: { id: 'k-2' } }))
      res.statusCode = 500
      res.end(JSON.stringify({ message: 'boom' }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const result = await uploadToWeknora({ sink: { ...sink, baseUrl: `http://127.0.0.1:${port}` }, title: 't', markdown: 'm' })
    assert.equal(result.ok, true)
    assert.match(result.warning, /需要人工 reparse/)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('没配全 / 连不上：回 error，不抛', async () => {
  const missing = await uploadToWeknora({ sink: {}, title: 't', markdown: 'm' })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /没配全/)
  const down = await uploadToWeknora({ sink: { ...sink, baseUrl: 'http://127.0.0.1:1' }, title: 't', markdown: 'm', timeoutMs: 2000 })
  assert.equal(down.ok, false)
  assert.match(down.error, /建文档失败/)
})
test('幂等：给 previousKnowledgeId 时先删旧再建新，并回报 replaced', async () => {
  const seen = []
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      seen.push(req.method + ' ' + req.url)
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'DELETE') return res.end('{}')
      if (req.url.endsWith('/knowledge/manual')) return res.end(JSON.stringify({ data: { id: 'k-new' } }))
      if (req.url.endsWith('/reparse')) return res.end('{}')
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const result = await uploadToWeknora({
      sink: { ...sink, baseUrl: `http://127.0.0.1:${port}` },
      title: 't', markdown: 'm', previousKnowledgeId: 'k-old',
    })
    assert.equal(result.ok, true)
    assert.equal(result.replaced, true)
    assert.equal(seen[0], 'DELETE /knowledge/k-old', '先删旧文档')
    assert.equal(seen[1], 'POST /knowledge-bases/kb1/knowledge/manual')
    assert.equal(seen[2], 'POST /knowledge/k-new/reparse')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('幂等：旧文档已经不在了（404）也算删成功，继续建新的', async () => {
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'DELETE') { res.statusCode = 404; return res.end('{}') }
      if (req.url.endsWith('/knowledge/manual')) return res.end(JSON.stringify({ data: { id: 'k-2' } }))
      res.end('{}')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const result = await uploadToWeknora({ sink: { ...sink, baseUrl: `http://127.0.0.1:${port}` }, title: 't', markdown: 'm', previousKnowledgeId: 'gone' })
    assert.equal(result.ok, true)
    assert.equal(result.replaced, true)
    assert.equal(result.warning, '')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('幂等：建文档失败时也要回报 replaced（台账靠它判「旧文档是否已失效」）', async () => {
  // 删旧成功（200）+ 建新失败（500）：replaced 必须是 true。
  // 少了这个字段，doc-sync 分不清「旧文档真没了」和「删旧根本没跑成」，
  // 只能一律保锚 —— 或者更糟，像 BUG-001 那样一律抹掉。
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'DELETE') return res.end('{}')
      if (req.url.endsWith('/knowledge/manual')) { res.statusCode = 500; return res.end(JSON.stringify({ message: 'create boom' })) }
      res.end('{}')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const result = await uploadToWeknora({ sink: { ...sink, baseUrl: `http://127.0.0.1:${port}` }, title: 't', markdown: 'm', previousKnowledgeId: 'k-old' })
    assert.equal(result.ok, false)
    assert.equal(result.replaced, true, '旧文档删成功了，失败返回里也要如实带出来')
    assert.match(result.error, /建文档失败/)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('幂等：旧文档删不掉（500）时中止本轮入库，不建第二份（先失效再入库）', async () => {
  let posts = 0
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'DELETE') { res.statusCode = 500; return res.end(JSON.stringify({ message: 'nope' })) }
      if (req.url.endsWith('/knowledge/manual')) { posts += 1; return res.end(JSON.stringify({ data: { id: 'k-3' } })) }
      res.end('{}')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const result = await uploadToWeknora({ sink: { ...sink, baseUrl: `http://127.0.0.1:${port}` }, title: 't', markdown: 'm', previousKnowledgeId: 'stuck' })
    // 旧文档没被确认失效就入库 = 两份并存，台账只能记一个，另一份永远删不掉（BUG-001）。
    assert.equal(result.ok, false, '删旧失败要当场失败，不能「建成功就假装没事」')
    assert.equal(result.replaced, false)
    assert.match(result.error, /旧文档没删掉/)
    assert.match(result.error, /本轮未入库/, '要让人看出这轮根本没写进去')
    assert.equal(posts, 0, '删旧失败时不该再 POST 建新文档')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
