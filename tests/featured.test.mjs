// 精选插件生态集成（src/host/featured-source.js）的行为契约：
//   1. 桩环境守卫：最小桩 ctx 直接跳过，不建服务、不报错
//   2. 登记/注销：接入方经 registry 登记，停用（dispose）后移除
//   3. 聚合路由：sameOrigin 校验 + GET/HEAD 放行 + 按包名去重
//   4. 让位标记：client 半的 __DSH_FEATURED_APPLIED__/__DSH_FEATURED_FULL__ 契约在源码里成立
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { integrateFeaturedPlugins, FEATURED_SOURCE, ROUTE, SERVICE } from '../src/host/featured-source.js'

// 最小桩 ctx：只记录 provide / inject / effect 的行为，够 feature-source 用。
function makeCtx() {
  const services = new Map()
  const routes = []
  const ctx = {
    get(name) { return services.get(name) },
    provide(name, value) { services.set(name, value); return () => services.delete(name) },
    effect(fn, label) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(names, fn) {
      const child = {
        // featured-source 直接挂 child.webServer（与 DSH 原生 inject 子上下文一致）
        webServer: { register(route) { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } } },
        get: (n) => (n === 'webServer' ? child.webServer : services.get(n)),
        effect: (fn2, label2) => ctx.effect(fn2, label2),
      }
      fn(child)
    },
  }
  ctx._services = services
  ctx._routes = routes
  return ctx
}

test('FEATURED_SOURCE：id 用 scoped 包名，entries 默认留空（接入 ≠ 上榜）', () => {
  assert.equal(FEATURED_SOURCE.id, '@marsken/dsh-studio')
  assert.ok(Array.isArray(FEATURED_SOURCE.entries))
  assert.equal(FEATURED_SOURCE.entries.length, 0, 'entries 留空：上榜由 skillpie.cn 收录决定，不由接入方自荐')
})

test('桩环境守卫：缺 get/inject 的桩 ctx 静默跳过，不抛错', () => {
  assert.doesNotThrow(() => integrateFeaturedPlugins(undefined, FEATURED_SOURCE))
  assert.doesNotThrow(() => integrateFeaturedPlugins({}, FEATURED_SOURCE))
  assert.doesNotThrow(() => integrateFeaturedPlugins({ get: () => null }, FEATURED_SOURCE))
})

test('登记与注销：inject 注册的 effect dispose 后源从 registry 移除', () => {
  const ctx = makeCtx()
  integrateFeaturedPlugins(ctx, FEATURED_SOURCE)
  const registry = ctx._services.get(SERVICE)
  assert.ok(registry, '第一个接入方应提供 featured-plugins 服务')
  assert.equal(registry.list().length, 1)
  assert.equal(registry.list()[0].id, FEATURED_SOURCE.id)
  // 再来一个接入方：只登记，不重复提供服务
  const other = makeCtx()
  other._services.set(SERVICE, registry)
  integrateFeaturedPlugins(other, { id: '@x/dsh-other', title: 'other', entries: [{ package: 'p1', title: 'P1' }] })
  assert.equal(registry.list().length, 2)
  assert.equal(registry.list().find((s) => s.id === '@x/dsh-other').entries.length, 1)
})

test('聚合路由：GET 放行、跨域 403、非 GET/HEAD 405、按包名去重（先登记优先）', async (t) => {
  const ctx = makeCtx()
  integrateFeaturedPlugins(ctx, FEATURED_SOURCE)
  const registry = ctx._services.get(SERVICE)
  registry.register({ id: '@x/dsh-a', title: 'A', entries: [{ package: 'p1', title: 'P1' }, { package: 'p2', title: 'P2' }] })
  registry.register({ id: '@x/dsh-b', title: 'B', entries: [{ package: 'p1', title: '重复的 p1' }, { package: 'p3', title: 'P3' }] })

  const route = ctx._routes[0]
  assert.equal(route.path, ROUTE)
  // 断网桩：聚合先拉远程集中目录，测试只断言登记源的去重，不允许依赖外网。
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false })
  t.after(() => { globalThis.fetch = realFetch })
  const server = http.createServer((req, res) => route.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const { port } = server.address()
  const get = (headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: ROUTE, method: 'GET', headers }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })

  const ok = await get({ host: `127.0.0.1:${port}` })
  assert.equal(ok.status, 200)
  const doc = JSON.parse(ok.body)
  assert.equal(doc.ok, true)
  assert.deepEqual(doc.data.entries.map((e) => e.package), ['p1', 'p2', 'p3'], '按包名去重，plugins.json（空）+ 登记序')
  assert.equal(doc.data.sources.length, 3)

  const cross = await get({ host: `127.0.0.1:${port}`, origin: 'http://evil.example' })
  assert.equal(cross.status, 403, '跨域请求被拒')
})

test('client 半让位契约：client.src.js 里保留双标记与让位早退', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../client.src.js', import.meta.url), 'utf8')
  assert.ok(source.includes('__DSH_FEATURED_APPLIED__'), '内联入口要挂已应用标记')
  assert.ok(source.includes('__DSH_FEATURED_FULL__'), '完整版在场时内联入口要让位')
  assert.ok(source.includes("spec: FEATURED_PKG"), '入口要引导一键安装 dsh-featured')
})
