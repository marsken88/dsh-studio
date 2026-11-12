import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { feishuText, feishuPush, healthReport } from '../src/host/integrations.js'

test('notify: feishuText accepts strings and { text } objects alike', () => {
  assert.equal(feishuText('hello'), 'hello')
  assert.equal(feishuText({ text: 'from object' }), 'from object')
  assert.equal(feishuText({ content: 'from content' }), 'from content')
  assert.equal(feishuText(null), '')
  assert.equal(feishuText(undefined), '')
  assert.equal(feishuText({}), '')
  assert.equal(feishuText('x'.repeat(5000)).length, 4000)
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
