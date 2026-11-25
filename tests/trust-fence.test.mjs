// 宿主信任栅栏：/studio-api 挂在宿主的端口上，谁连得上谁就能调 —— 这一层是把
// 「浏览器里的一个网页也能调」堵掉的地方。结论只有三种，处置绝不能混。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { PUBLIC_INTAKE_ROUTES, trustOutcomeFor, trustRejectionOutcome, trustUnavailableOutcome } from '../src/host/access.js'

const root = new URL('../', import.meta.url)
const source = path => readFileSync(new URL(path, root), 'utf8')

test('宿主放行（undefined）时不做任何处置', () => {
  for (const route of ['/state', '/task/update', '/intake/requirement', '/health']) {
    assert.equal(trustRejectionOutcome(undefined, route), null, `${route} 应放行`)
  }
})

test('403（Host/Origin 栅栏没过）谁都不豁免，公开提单页也不行', () => {
  for (const route of ['/state', '/intake', '/intake/requirement', '/intake/mine/query', '/health']) {
    const verdict = trustRejectionOutcome(403, route)
    assert.notEqual(verdict, null, `${route} 不该被豁免`)
    assert.equal(verdict.status, 403)
    assert.equal(verdict.code, 'bad_origin')
  }
})

test('401（没有已认证的会话）挡住台账，但不挡公开提单页与探活', () => {
  assert.equal(trustRejectionOutcome(401, '/state').status, 401)
  assert.equal(trustRejectionOutcome(401, '/state').code, 'login_required')
  assert.equal(trustRejectionOutcome(401, '/task/update').status, 401)
  assert.equal(trustRejectionOutcome(401, '/agents/run').status, 401)
  assert.equal(trustRejectionOutcome(401, '/intake/requirement'), null, '匿名提单是设计成公开的')
  assert.equal(trustRejectionOutcome(401, '/intake/mine/query'), null)
  assert.equal(trustRejectionOutcome(401, '/health'), null, '探活不该要求登录')
})

test('公开名单与自助提单页真正会调的地址一致（页面改了这里也要改）', () => {
  const html = source('src/host/intake-pages.js')
  const called = new Set()
  /* 页面里的地址有两种写法：字面量 '/intake/xxx' 和 replace(/\/intake\/mine$/) 拼出来的。
     只认「/intake/ + 至少一个字母」，免得把注释里的 /studio-api/intake/... 也算进来。 */
  for (const match of html.matchAll(/\/intake\/[a-z][a-z/]*/gu)) called.add(match[0].replace(/\/$/u, ''))
  assert.ok(called.size > 0, 'intake-pages 里应该有 /intake/* 调用')
  for (const route of called) {
    assert.ok(PUBLIC_INTAKE_ROUTES.has(route), `${route} 被页面调用，但不在公开名单里：豁免名单漏了就会 401 打不开页面`)
  }
})

test('宿主没有 requestRejection 时放行（可用性优先），但要在日志里看得见', () => {
  assert.equal(trustUnavailableOutcome(), null, '拿不到宿主名单时只信回环会把局域网用户挡成 403，改成放行')
  assert.equal(trustOutcomeFor(undefined, { url: '/x' }, '/state'), null, '没有 connection 时也放行')
  const access = source('src/host/access.js')
  assert.match(access, /console\.warn\('\[dsh-studio\] 宿主没有 connection\.requestRejection/u, '栅栏没生效要留下一行日志')
})

test('index.js 把栅栏接在路由分发与认身份之前，并把 connection 从 ctx 取来传进去', () => {
  const index = source('index.js')
  assert.match(index, /const distrust = trustOutcomeFor\(ctx\?\.get\?\.\('connection'\), req, route\)/u, 'handler 里要有栅栏调用')
  const fenceAt = index.indexOf("const distrust = trustOutcomeFor(ctx?.get?.('connection'), req, route)")
  const dispatchAt = index.indexOf('await core(req, res)')
  assert.ok(fenceAt > 0 && dispatchAt > fenceAt, '栅栏必须在路由分发之前')
  const actorAt = index.indexOf('const resolved = resolveActor(req, store.snapshot().config)')
  assert.ok(fenceAt < actorAt, '栅栏要在认身份之前：不认陌生请求，也不给他记审计')
})

test('trustOutcomeFor：以方法形式调用宿主接口（丢 this 会全盘 403），并如实翻译三种结论', () => {
  const calls = []
  const connection = {
    trustedHosts: ['host:18080'],
    requestRejection(req) {
      calls.push({ self: this, url: req.url })
      return req.rejection
    },
  }
  assert.equal(trustOutcomeFor(connection, { url: '/studio-api/state', rejection: undefined }, '/state'), null, 'undefined = 放行')
  assert.equal(trustOutcomeFor(connection, { url: '/x', rejection: 401 }, '/state').status, 401)
  assert.equal(trustOutcomeFor(connection, { url: '/x', rejection: 401 }, '/intake/requirement'), null, '公开提单页豁免 401')
  assert.equal(trustOutcomeFor(connection, { url: '/x', rejection: 403 }, '/intake/requirement').status, 403, '403 谁都不豁免')
  assert.equal(calls.length, 4)
  for (const call of calls) assert.equal(call.self, connection, '必须以方法形式调用：this 要指向连接本体')
})

test('trustOutcomeFor：宿主自己抛错按「栅栏没过」处理，不放行', () => {
  const connection = { requestRejection() { throw new TypeError('boom') } }
  const verdict = trustOutcomeFor(connection, { url: '/x' }, '/state')
  assert.equal(verdict.status, 403, '说不清的请求宁可拒掉')
})

test('探活只回 ok，不带台账', () => {
  const index = source('index.js')
  assert.match(index, /route === '\/health'\) \{ sendJson\(res, 200, \{ ok: true \}\); return \}/u)
  assert.match(index, /'\/health', '\/state'/u, '探活也要进登录白名单，否则开了统一登录部署脚本探不到')
})
