/**
 * /studio-api 信任栅栏的 HTTP 级验证：把 index.js 注册的**真实 handler** 挂在假宿主上，
 * 用一个按宿主真实规则实现的 requestRejection 驱动栅栏，然后发真 HTTP 请求。
 *
 *   node tools/verify-fence.mjs      # 或 npm run verify:fence
 *
 * 为什么要有它：单测只验纯函数，验不到「handler 里到底调没调、对不对」；真机探针要
 * 部署 + 启动 token，不适合每次改都跑。这一层夹在中间：真代码、假宿主、真 HTTP。
 * 判定规则照抄 dsh 的 isTrustedApiRequest / browserAuth（回环 Host 可信、
 * sec-fetch-site: cross-site 拒、Origin 必须与本机同源、没有会话 cookie → 401）。
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'studio-fence-'))

const { apply } = await import(new URL('../index.js', import.meta.url).href)

// ---------------------------------------------------------------- 宿主的判定规则（照 asar 里的实现）
const isLoopback = hostname => ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(String(hostname).toLowerCase())
function trustedHost(headers, trustedHosts) {
  const host = headers.host
  if (host === undefined) return false
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  if (!isLoopback(hostname) && !trustedHosts.includes(host)) return false
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === host } catch { return false }
}
const COOKIE = 'dsh-auth-127.0.0.1=valid'
const connection = {
  trustedHosts: ['127.0.0.1', '127.0.0.1:PORT'],
  requestRejection(req) {
    if (!trustedHost(req.headers, this.trustedHosts)) return 403
    const cookie = String(req.headers.cookie ?? '')
    return cookie.includes(COOKIE) ? undefined : 401
  },
}

// ---------------------------------------------------------------- 假宿主 ctx
let apiHandler = null
const noop = () => {}
const disposers = []
const fakeCtx = {
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => { if (typeof d === 'function') d() } },
  get(name) { return name === 'connection' ? connection : undefined },
  inject(names, callback) {
    if (names.includes('webServer')) {
      callback({ webServer: { register(options) { apiHandler = options.handler; return () => { apiHandler = null } } } })
      return () => {}
    }
    callback({
      agents: { create: async () => ({}), list: () => [] },
      sessionController: { on: noop },
      workspaceRegistry: {},
      permissionPresets: {},
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash' }) },
      sessionProjections: {},
      effect: fn => fn(),
      on: () => noop,
    })
    return () => {}
  },
  systemPrompt: { section: () => () => {} },
  tools: { register: () => () => {} },
}
apply(fakeCtx)
if (typeof apiHandler !== 'function') throw new Error('host did not register /studio-api')

const server = createServer((req, res) => { void apiHandler(req, res) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
connection.trustedHosts = [`127.0.0.1:${port}`]
const base = `http://127.0.0.1:${port}`

// ---------------------------------------------------------------- 断言
const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ' — ' + detail}`)
}
async function hit(path, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(base + path, { method, headers, body })
  return { status: res.status, text: await res.text() }
}
/* fetch 不许改 Host（forbidden header），DNS rebinding 那条只能发原始请求。 */
async function rawHit(path, { method = 'GET', headers = {}, body } = {}) {
  const { request } = await import('node:http')
  const payload = body === undefined ? undefined : Buffer.from(body)
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { ...headers, ...(payload === undefined ? {} : { 'content-length': payload.length }) } }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

// 1. 公开探活：无会话也能过
{
  const r = await hit('/studio-api/health')
  check('GET /health 无会话 → 200（运维探活不该要求登录）', r.status === 200 && r.text.includes('"ok":true'), `${r.status} ${r.text.slice(0, 60)}`)
}
// 2. 台账：无会话 401
{
  const r = await hit('/studio-api/state')
  check('GET /state 无会话 → 401 login_required（浏览器里的网页拿不到台账）', r.status === 401 && r.text.includes('login_required'), `${r.status} ${r.text.slice(0, 80)}`)
}
// 3. 台账：带会话 200，且是真数据
{
  const r = await hit('/studio-api/state', { headers: { cookie: COOKIE } })
  const parsed = (() => { try { return JSON.parse(r.text) } catch { return null } })()
  check('GET /state 带会话 → 200 且带 revision', r.status === 200 && typeof parsed?.state?.revision === 'number', `${r.status} revision=${parsed?.state?.revision}`)
}
// 4. DNS rebinding 的形状：Host 是攻击者域名
{
  const r = await rawHit('/studio-api/state', { headers: { host: 'evil.example.com', cookie: COOKIE } })
  check('GET /state 伪造 Host（DNS rebinding）→ 403 bad_origin', r.status === 403 && r.text.includes('bad_origin'), `${r.status} ${r.text.slice(0, 80)}`)
}
// 5. 跨站 POST：Origin 与 Host 不同
{
  const r = await hit('/studio-api/task/comments', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example.com', cookie: COOKIE }, body: '{"id":"nope"}' })
  check('POST 跨站 Origin → 403', r.status === 403 && r.text.includes('bad_origin'), `${r.status} ${r.text.slice(0, 80)}`)
}
// 6. 公开提单：匿名用户没会话也要能用（不能被栅栏顺手关掉）
{
  const r = await hit('/studio-api/intake/requirement', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '栅栏验证', description: '匿名提一张', requester: '验证', dept: 'QA', contact: 'x@example.com', priority: 'normal' }) })
  check('POST /intake/requirement 匿名 → 不是 401（公开提单功能保住）', r.status !== 401, `${r.status} ${r.text.slice(0, 100)}`)
}
// 7. 公开提单也不能被跨站打
{
  const r = await hit('/studio-api/intake/requirement', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' }, body: '{"title":"x"}' })
  check('POST /intake/requirement 跨站 → 403（公开 ≠ 谁都能调）', r.status === 403, `${r.status} ${r.text.slice(0, 80)}`)
}
// 8. 写接口无会话 401：这是最要紧的一条
{
  const r = await hit('/studio-api/task/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"x","status":"done"}' })
  check('POST /task/update 无会话 → 401（网页改不动卡）', r.status === 401, `${r.status} ${r.text.slice(0, 80)}`)
}

const failed = results.filter(item => !item.ok)
console.log(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 条失败`}（${results.length} 条断言）`)
/* 关掉服务、把插件挂的定时器都卸载，然后让进程自己退出。
   直接 process.exit() 会在 Windows 上撞 libuv 断言（0xC0000409），退出码看着像崩溃。 */
await new Promise(resolve => server.close(resolve))
for (const dispose of disposers.splice(0)) { try { dispose() } catch { /* 收尾失败不影响结论 */ } }
process.exitCode = failed.length === 0 ? 0 : 1
setTimeout(() => process.exit(process.exitCode), 500).unref()
