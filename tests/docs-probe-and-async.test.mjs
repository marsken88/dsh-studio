// 下一批：WeKnora 探活（含集成健康通道）+ 整批回归改后台执行。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { probeWeknora } from '../src/host/weknora-sink.js'
import { healthReport } from '../src/host/integrations.js'

const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')
const SINK = { baseUrl: 'http://kb.example.com/api/v1', apiKey: 'k1', tenantId: '10000', knowledgeBaseId: 'kb-1' }

const stubFetch = reply => {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    const { status = 200, body = '{}' } = reply
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }
  }
  return { fn, calls }
}

test('probeWeknora：配全 + 列表里能找到知识库 → ok', async () => {
  const { fn, calls } = stubFetch({ status: 200, body: { data: [{ id: 'kb-1', name: '交付物' }] } })
  const out = await probeWeknora({ sink: SINK, fetchImpl: fn })
  assert.equal(out.ok, true)
  assert.equal(out.knowledgeBaseFound, true)
  assert.equal(calls[0].url, 'http://kb.example.com/api/v1/knowledge-bases', '只读列表，不写任何东西')
  assert.equal(calls[0].init.headers['X-API-Key'], 'k1')
  assert.equal(calls[0].init.headers['X-Tenant-ID'], '10000')
})

test('probeWeknora：401 说清是 Key 的问题；知识库不在列表里也如实说', async () => {
  const denied = await probeWeknora({ sink: SINK, fetchImpl: stubFetch({ status: 401, body: { message: 'invalid api key' } }).fn })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /API Key/)

  const missing = await probeWeknora({ sink: SINK, fetchImpl: stubFetch({ status: 200, body: { data: [{ id: 'kb-2' }] } }).fn })
  assert.equal(missing.ok, true, '地址与 Key 能用就算连通')
  assert.equal(missing.knowledgeBaseFound, false, '但要说清看不见目标知识库')
  assert.match(missing.error, /看不见知识库 kb-1/)
})

test('probeWeknora：没配全时不发请求', async () => {
  const { fn, calls } = stubFetch({ status: 200, body: {} })
  const out = await probeWeknora({ sink: { baseUrl: '', apiKey: '', knowledgeBaseId: '' }, fetchImpl: fn })
  assert.equal(out.ok, false)
  assert.match(out.error, /没配全/)
  assert.equal(calls.length, 0)
})

test('集成健康里有 WeKnora 通道（以前填错了面板永远是绿的）', () => {
  const report = healthReport()
  const channels = (report.channels ?? report.rows ?? []).map(item => item.channel)
  assert.ok(channels.includes('weknora'), `通道列表里要有 weknora：${channels.join(',')}`)
})

test('/docs/test：探活结果要写进集成健康，响应不打印 Key', () => {
  const route = source('src/host/routes/connect.js')
  assert.match(route, /import \{ probeWeknora \} from '\.\.\/weknora-sink\.js'/)
  assert.match(route, /markHealth\('weknora', healthy \? 'ok' : 'fail'/)
  assert.match(route, /host\.sendJson\(res, 200, \{ ok: healthy, \.\.\.result \}\)/)
})

test('文档出口面板有「测试连接」，并说明测的是已保存的连接', () => {
  const panel = source('web/src/studio/panels/integrations.js')
  assert.match(panel, /'data-docs-test': ''/)
  assert.match(panel, /api\('\/docs\/test', \{\}\)/)
  assert.match(panel, /先保存再测/)
  assert.match(panel, /'data-docs-test-note': ''/)
})

test('/tests/run：默认 202 后台跑，wait:true 才同步（与 /task/quality 同口径）', () => {
  const route = source('src/host/routes/tasks.js')
  assert.match(route, /if \(body\.wait !== true\) \{/)
  assert.match(route, /host\.sendJson\(res, 202, \{ ok: true, queued: true/)
  assert.match(route, /void runSuite\(store, options\)\.catch\(/)
  assert.match(route, /const result = await runSuite\(store, options\)/, 'wait:true 仍走同步')
})
