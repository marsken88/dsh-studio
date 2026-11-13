import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { feishuText, feishuPush, feishuBroadcast, botWants, healthReport } from '../src/host/integrations.js'
import { sanitizeBots } from '../src/host/domain.js'
import { probeEnv } from '../src/host/executor.js'

test('notify: feishuText accepts strings and { text } objects alike', () => {
  assert.equal(feishuText('hello'), 'hello')
  assert.equal(feishuText({ text: 'from object' }), 'from object')
  assert.equal(feishuText({ content: 'from content' }), 'from content')
  assert.equal(feishuText(null), '')
  assert.equal(feishuText(undefined), '')
  assert.equal(feishuText({}), '')
  assert.equal(feishuText('x'.repeat(5000)).length, 4000)
})

test('executor: an environment that is down is reported before any case runs', async () => {
  const config = { testing: { allowHosts: ['127.0.0.1'] } }
  assert.equal((await probeEnv({ id: 'demo', baseUrl: '' }, config)).ok, false)
  assert.equal((await probeEnv({ id: 'demo', baseUrl: 'not-a-url' }, config)).ok, false)
  const blocked = await probeEnv({ id: 'demo', baseUrl: 'http://example.com' }, config)
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /白名单/)

  const server = http.createServer((req, res) => { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('down') })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const alive = await probeEnv({ id: 'demo', baseUrl: `http://127.0.0.1:${port}` }, config)
  assert.equal(alive.ok, true, 'any HTTP answer counts as reachable')
  assert.equal(alive.status, 503)

  await new Promise((resolve) => server.close(resolve))
  const dead = await probeEnv({ id: 'demo', baseUrl: `http://127.0.0.1:${port}` }, config, 1500)
  assert.equal(dead.ok, false)
  assert.ok(dead.error.length > 0)
})

test('notify: feishuPush posts content.text and records the healthy channel', async () => {
  const received = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      received.push(JSON.parse(body))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0, msg: 'ok' }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const result = await feishuPush(`http://127.0.0.1:${port}/hook`, { text: '【新缺陷】BUG-001' })
    assert.equal(result.ok, true)
    assert.equal(received.length, 1)
    assert.equal(received[0].msg_type, 'text')
    assert.equal(received[0].content.text, '【新缺陷】BUG-001')
    const health = healthReport()
    const feishu = (health.channels ?? []).find((channel) => channel.channel === 'feishu')
    assert.equal(feishu.ok, true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('notify: an empty body is skipped instead of pushing "[object Object]"', async () => {
  const result = await feishuPush('http://127.0.0.1:9/hook', {})
  assert.equal(result.ok, false)
  assert.equal(result.skipped, true)
})

test('notify: bot events default to everything subscribed and honour notifyOnChange', () => {
  const [legacy, muted, custom] = sanitizeBots([
    { id: 'legacy', name: '老数据', webhook: 'https://example.invalid/hook' },
    { id: 'muted', name: '只关状态变化', webhook: 'https://example.invalid/hook', notifyOnChange: false },
    { id: 'custom', name: '只收缺陷', webhook: 'https://example.invalid/hook', events: { change: false, sla: true, bug: true, release: false } },
  ])
  assert.deepEqual(legacy.events, { change: true, sla: true, bug: true, release: true })
  assert.equal(muted.events.change, false)
  assert.equal(muted.events.bug, true)
  assert.deepEqual(custom.events, { change: false, sla: true, bug: true, release: false })
  assert.equal(custom.notifyOnChange, false)
})

test('notify: botWants filters by event kind, legacy bots fall back to notifyOnChange', () => {
  const all = { id: 'a', enabled: true, webhook: 'https://x', events: { change: true, sla: true, bug: true, release: true } }
  const bugsOnly = { id: 'b', enabled: true, webhook: 'https://x', events: { change: false, sla: false, bug: true, release: false } }
  const legacy = { id: 'c', enabled: true, webhook: 'https://x', notifyOnChange: false }
  const off = { id: 'd', enabled: false, webhook: 'https://x' }
  const noHook = { id: 'e', enabled: true, webhook: '' }

  for (const kind of ['change', 'sla', 'bug', 'release']) assert.equal(botWants(all, kind), true)
  assert.equal(botWants(bugsOnly, 'bug'), true)
  assert.equal(botWants(bugsOnly, 'release'), false)
  assert.equal(botWants(legacy, 'change'), false)
  assert.equal(botWants(legacy, 'release'), true)
  assert.equal(botWants(off, 'bug'), false)
  assert.equal(botWants(noHook, 'bug'), false)
  assert.equal(botWants(null, 'bug'), false)
})

test('notify: feishuBroadcast reaches only the bots that subscribe to that kind', async () => {
  const hits = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      hits.push({ url: req.url, text: JSON.parse(body).content.text })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0 }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const url = (path) => `http://127.0.0.1:${port}${path}`
  const config = {
    feishu: {
      bots: [
        { id: 'dev', name: '研发群', webhook: url('/dev'), chatId: '', notifyOnChange: true, enabled: true, events: { change: false, sla: false, bug: true, release: false } },
        { id: 'pm', name: '产品群', webhook: url('/pm'), chatId: '', notifyOnChange: true, enabled: true, events: { change: true, sla: false, bug: false, release: true } },
        { id: 'quiet', name: '静默群', webhook: url('/quiet'), chatId: '', notifyOnChange: false, enabled: true, events: { change: false, sla: false, bug: false, release: false } },
      ],
    },
  }
  try {
    const bug = await feishuBroadcast(config, '【新缺陷】BUG-002', 'bug')
    assert.deepEqual(bug.map((item) => item.bot), ['dev'])
    const release = await feishuBroadcast(config, '【版本发布】v1.2.0', 'release')
    assert.deepEqual(release.map((item) => item.bot), ['pm'])
    const change = await feishuBroadcast(config, '卡片状态变化', 'change')
    assert.deepEqual(change.map((item) => item.bot), ['pm'])
    const sla = await feishuBroadcast(config, '【SLA 超时】', 'sla')
    assert.deepEqual(sla, [])
    assert.deepEqual(hits.map((item) => item.url).sort(), ['/dev', '/pm', '/pm'])
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
