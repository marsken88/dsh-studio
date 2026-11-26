// 文档出口配置的写入层（REQ-2026-003 p3）：规则矩阵 + 进程内真 HTTP /config → /state + 源码守卫。
//
// 为什么 a1 的证据必须是真 HTTP：p1 踩过「纯函数全绿、/config 根本没接线」的真空绿。
// 这个文件自己起插件（临时 DSH_HOME + 假 ctx + http.Server），打真 /studio-api 接口。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, before } from 'node:test'

import { buildDocsConfig, DocsConfigError } from '../src/host/docs-config.js'
import { publicDocsConfig } from '../src/host/doc-sink.js'
import { weknoraReady } from '../src/host/weknora-sink.js'

const READY_SINK = { baseUrl: 'http://kb.example.com/api/v1', apiKey: 'sk-test', tenantId: '10000', knowledgeBaseId: 'kb1' }
const BASE = { provider: 'feishu', perProject: {}, weknora: { ...READY_SINK } }

const throwsDocs = (fn, predicate) => {
  assert.throws(fn, error => {
    assert.ok(error instanceof DocsConfigError, '必须抛 DocsConfigError（路由靠 code 映射 400）')
    assert.ok(error.code === 'docs_config_invalid' || error.code === 'docs_config_not_ready', 'code 必须是两个 400 码之一')
    return predicate(error)
  })
}

/* ── 一、纯函数矩阵：归一 / 合并 / 整表替换 / 非法 / 生效范围 ─────────── */

test('buildDocsConfig：合法输入归一 + 合并语义', () => {
  assert.equal(buildDocsConfig(BASE, { provider: ' BOTH ' }).provider, 'both', "' BOTH ' 归一为 both，不拒")
  const keepProject = buildDocsConfig({ ...BASE, perProject: { pjA: 'weknora' } }, { provider: 'both' })
  assert.equal(keepProject.perProject.pjA, 'weknora', 'patch 不带 perProject = 保留现状')
  const normalized = buildDocsConfig(BASE, { perProject: { ' pjA ': ' BOTH ' } })
  assert.deepEqual(normalized.perProject, { pjA: 'both' }, '项目 id 与值都归一')
  const replaced = buildDocsConfig({ ...BASE, perProject: { pjA: 'feishu' } }, { perProject: { pjB: 'feishu' } })
  assert.deepEqual(replaced.perProject, { pjB: 'feishu' }, 'perProject 是整表替换（没发的项目 = 取消覆盖）')
  const merged = buildDocsConfig(BASE, { weknora: { baseUrl: 'http://new.example.com/api/v1' } })
  assert.equal(merged.weknora.tenantId, '10000', 'weknora 字段级合并：只发 baseUrl 不冲掉 tenantId')
  assert.equal(merged.weknora.knowledgeBaseId, 'kb1', 'weknora 字段级合并：knowledgeBaseId 保留')
  const blankKey = buildDocsConfig(BASE, { weknora: { apiKey: '' } })
  assert.equal(blankKey.weknora.apiKey, 'sk-test', "apiKey:'' = 不修改（与其它字段的『空 = 清空』语义不同）")
  const clearUrl = buildDocsConfig(BASE, { weknora: { baseUrl: '' } })
  assert.equal(clearUrl.weknora.baseUrl, '', "baseUrl:'' = 清空")
  assert.equal(clearUrl.weknora.tenantId, '10000', '清空一个字段不影响同对象其它字段')
  const echo = buildDocsConfig(BASE, { weknora: { apiKeySet: true } })
  assert.equal(echo.weknora.baseUrl, READY_SINK.baseUrl, 'apiKeySet 是回读回声，忽略而不是 unknown-field')
  const cleared = buildDocsConfig(BASE, { perProject: {} })
  assert.deepEqual(cleared.perProject, {}, '显式 {} = 清空整表（降级路径）')
})

test('buildDocsConfig：apiKey 回读恒空 + apiKeySet 反映是否已配', () => {
  const readback = publicDocsConfig(buildDocsConfig(BASE, { provider: 'both' }))
  assert.equal(readback.weknora.apiKey, '', 'apiKey 永远不下发')
  assert.equal(readback.weknora.apiKeySet, true, '已配置时 apiKeySet=true')
  const empty = publicDocsConfig(buildDocsConfig({ provider: 'feishu', perProject: {}, weknora: {} }, { provider: 'feishu' }))
  assert.equal(empty.weknora.apiKeySet, false, '没配 apiKey 时 apiKeySet=false')
})

test('buildDocsConfig：非法输入一次列清（400 docs_config_invalid）', () => {
  throwsDocs(() => buildDocsConfig(BASE, { provider: 'nope' }), e => e.invalid[0].key === 'provider' && e.invalid[0].reason === 'unknown-provider')
  throwsDocs(() => buildDocsConfig(BASE, { provider: '' }), e => e.invalid[0].reason === 'unknown-provider')
  throwsDocs(() => buildDocsConfig(BASE, { provider: ['both'] }), e => e.invalid[0].reason === 'not-string')
  throwsDocs(() => buildDocsConfig(BASE, { perProject: { pjBad: 'nope' } }), e => e.invalid[0].key === 'perProject.pjBad')
  throwsDocs(() => buildDocsConfig(BASE, { perProject: ['both'] }), e => e.invalid[0].key === 'perProject' && e.invalid[0].reason === 'not-object')
  throwsDocs(() => buildDocsConfig(BASE, { perProject: null }), e => e.invalid[0].key === 'perProject' && e.invalid[0].reason === 'not-object')
  throwsDocs(() => buildDocsConfig(BASE, { perProject: { '  ': 'feishu' } }), e => e.invalid[0].reason === 'empty-key')
  throwsDocs(() => buildDocsConfig(BASE, { perProject: { ['p'.repeat(61)]: 'feishu' } }), e => e.invalid[0].reason === 'too-long')
  throwsDocs(() => buildDocsConfig(BASE, { perProject: { pjA: 'feishu', ' pjA ': 'both' } }), e => e.invalid.some(item => item.reason === 'duplicate-key'))
  throwsDocs(() => buildDocsConfig(BASE, { weknora: { knowledgeBaseId: 123 } }), e => e.invalid[0].key === 'weknora.knowledgeBaseId' && e.invalid[0].reason === 'not-string')
  throwsDocs(() => buildDocsConfig(BASE, { weknora: { baseUrl: 'x'.repeat(301) } }), e => e.invalid[0].reason === 'too-long')
  throwsDocs(() => buildDocsConfig(BASE, { foo: 1 }), e => e.invalid[0].key === 'docs.foo' && e.invalid[0].reason === 'unknown-field')
  throwsDocs(() => buildDocsConfig(BASE, null), e => e.invalid[0].key === 'docs' && e.invalid[0].reason === 'not-object')
  /* 多个问题一次报全：修一个再撞一个最烦人，也最容易改一半。 */
  throwsDocs(
    () => buildDocsConfig(BASE, { provider: 'nope', perProject: { pjBad: 'nope' }, nope: true }),
    e => e.invalid.length === 3 && e.message.includes('perProject.pjBad'),
  )
})

test('buildDocsConfig：8 种误写形态零回显（BUG-002 A 段，路径白名单）', () => {
  const SECRET = 'sk-LEAK-0123456789'
  /* 8 条全部来自 p3 验收探针实测：旧实现（key==='apiKey' 精确匹配才遮蔽）在这 6 条上回显原值。
     期望：invalid[].value 一律只给类型标签，响应体里连密钥前缀都找不到。 */
  const cases = [
    ['weknora 整块是字符串', { weknora: SECRET }, 'weknora', 'not-object', '（字符串）'],
    ['weknora 整块是数组', { weknora: [SECRET] }, 'weknora', 'not-object', '（数组）'],
    ['密钥误放在 docs 层', { apiKey: SECRET }, 'docs.apiKey', 'unknown-field', '（字符串）'],
    ['拼成 api_key', { weknora: { api_key: SECRET } }, 'weknora.api_key', 'unknown-field', '（字符串）'],
    ['拼成 apikey', { weknora: { apikey: SECRET, knowledgeBaseId: 'kb' } }, 'weknora.apikey', 'unknown-field', '（字符串）'],
    ['docs 整块是数组', [SECRET], 'docs', 'not-object', '（数组）'],
    ['正确字段 + 非字符串', { weknora: { apiKey: [SECRET] } }, 'weknora.apiKey', 'not-string', '（数组）'],
    ['正确字段 + 超长', { weknora: { apiKey: SECRET + 'x'.repeat(300) } }, 'weknora.apiKey', 'too-long', '（字符串）'],
  ]
  for (const [label, patch, key, reason, value] of cases) {
    let caught
    try { buildDocsConfig(BASE, patch) } catch (error) { caught = error }
    assert.ok(caught instanceof DocsConfigError, label + '：必须抛 DocsConfigError')
    assert.equal(caught.invalid[0].key, key, label + '：键名要保留（便于定位）')
    assert.equal(caught.invalid[0].reason, reason, label + '：原因不变')
    assert.equal(caught.invalid[0].value, value, label + '：白名单外的值只能给类型标签（不带内容、不带长度）')
    const payload = JSON.stringify({ error: caught.message, invalid: caught.invalid, missing: caught.missing, scopes: caught.scopes })
    assert.ok(!payload.includes('sk-LEAK'), label + '：400 响应体不许出现密钥：' + payload)
    assert.ok(!payload.includes('LEAK'), label + '：连片段都不许出现：' + payload)
  }
  /* 老约定里「weknora.* 任何字段都只给类型标签」也要钉住：非密钥字段同样不回显，
     因为 key 可能被误填进 baseUrl（下一行就是这种手误的形状）。 */
  let baseUrlError
  try { buildDocsConfig(BASE, { weknora: { baseUrl: 'x'.repeat(301) } }) } catch (error) { baseUrlError = error }
  assert.ok(baseUrlError instanceof DocsConfigError)
  assert.equal(baseUrlError.invalid[0].reason, 'too-long')
  assert.equal(baseUrlError.invalid[0].value, '（字符串）', 'weknora.* 任何字段都只给类型标签（契约 §A）')
})

test('buildDocsConfig：provider/perProject 的枚举手误仍带值（保留可用性）+ 非标量只给类型标签', () => {
  const SECRET = 'sk-LEAK-0123456789'
  /* 这两条是白名单内的唯一回显面：面板要能看出用户填了什么，才知道是改类型还是改值。 */
  let providerError
  try { buildDocsConfig(BASE, { provider: 'nope' }) } catch (error) { providerError = error }
  assert.equal(providerError.invalid[0].value, 'nope', "provider:'nope' 必须回显 nope（契约：保留定位能力）")

  let projectError
  try { buildDocsConfig(BASE, { perProject: { pjBad: 'nope' } }) } catch (error) { projectError = error }
  assert.equal(projectError.invalid[0].key, 'perProject.pjBad')
  assert.equal(projectError.invalid[0].value, 'nope', 'perProject 的枚举错也带值')

  /* 白名单以外的形状（非标量、形状错）一律标签。 */
  const shapes = [
    [{ provider: { apiKey: SECRET } }, 'provider', '（对象）'],
    [{ provider: [SECRET] }, 'provider', '（数组）'],
    [{ perProject: [SECRET] }, 'perProject', '（数组）'],
    [{ perProject: null }, 'perProject', '（null）'],
    [{ provider: SECRET + 'x'.repeat(250) }, 'provider', '（字符串）'],
  ]
  for (const [patch, key, value] of shapes) {
    let caught
    try { buildDocsConfig(BASE, patch) } catch (error) { caught = error }
    assert.ok(caught instanceof DocsConfigError, JSON.stringify(patch).slice(0, 40))
    assert.equal(caught.invalid[0].key, key)
    assert.equal(caught.invalid[0].value, value, '非标量 / 超长值只给类型标签')
    assert.ok(!JSON.stringify(caught.invalid).includes('LEAK'), '密钥片段不许出现在 invalid 里')
  }
  /* undefined（键在、没给值）要与 null 区分开：面板要能看出「没填」还是「填了 null」。 */
  let missingError
  try { buildDocsConfig(BASE, { foo: undefined }) } catch (error) { missingError = error }
  assert.equal(missingError.invalid[0].key, 'docs.foo')
  assert.equal(missingError.invalid[0].value, '（缺失）', 'undefined 值给「缺失」，不是 null')
})

test('buildDocsConfig：保存后全部 weknora-ish 生效范围都要配齐（Q6 裁定 A）', () => {
  const emptySink = { baseUrl: 'http://x/api/v1', apiKey: '', tenantId: '', knowledgeBaseId: 'kb' }
  throwsDocs(
    () => buildDocsConfig({ provider: 'feishu', perProject: {}, weknora: emptySink }, { provider: 'weknora' }),
    e => e.code === 'docs_config_not_ready' && e.missing.includes('apiKey') && e.scopes.join(',') === 'global',
  )
  throwsDocs(
    () => buildDocsConfig({ provider: 'feishu', perProject: {}, weknora: { baseUrl: 'http://x/api/v1', apiKey: 'k', tenantId: '', knowledgeBaseId: '' } }, { perProject: { pjA: 'both' } }),
    e => e.missing.includes('knowledgeBaseId') && e.scopes.join(',') === 'project:pjA',
  )
  throwsDocs(
    () => buildDocsConfig({ provider: 'feishu', perProject: {}, weknora: {} }, { provider: 'both', perProject: { pjA: 'weknora' } }),
    e => e.scopes.join(',') === 'global,project:pjA',
  )
  /* 降级要在同一次保存里把相关项目也改掉；只改总开关会被拦（有意为之，进发布说明）。 */
  const downgrade = buildDocsConfig({ provider: 'weknora', perProject: { pjA: 'both' }, weknora: {} }, { provider: 'feishu', perProject: { pjA: 'feishu' } })
  assert.equal(downgrade.provider, 'feishu')
  assert.equal(downgrade.perProject.pjA, 'feishu', '同批降级放行')
  throwsDocs(
    () => buildDocsConfig({ provider: 'weknora', perProject: { pjA: 'weknora' }, weknora: {} }, { provider: 'feishu' }),
    e => e.code === 'docs_config_not_ready' && e.scopes.join(',') === 'project:pjA',
  )
  /* 复用的 weknoraReady 与写入层判据必须同源：字段表只维护一份。 */
  assert.equal(weknoraReady({ baseUrl: 'x', apiKey: 'k', tenantId: 't', knowledgeBaseId: 'kb' }).ok, true)
})

test('buildDocsConfig：perProject 容量上限 200（too-many）', () => {
  const table = {}
  for (let index = 0; index < 201; index += 1) table['pj' + index] = 'feishu'
  throwsDocs(() => buildDocsConfig(BASE, { perProject: table }), e => e.invalid.some(item => item.reason === 'too-many'))
})

/* ── 二、进程内真 HTTP：/config 保存 → /state 回读（a1 的判据） ────────── */

const home = mkdtempSync(join(tmpdir(), 'dsh-docs-config-'))
process.env.DSH_HOME = home
let server
let base
const disposers = []

const api = async (path, body) => {
  const init = body === undefined
    ? { method: 'GET', headers: { 'x-studio-user': 'docs-config-test' } }
    : { method: 'POST', headers: { 'x-studio-user': 'docs-config-test', 'content-type': 'application/json' }, body: JSON.stringify(body) }
  const response = await fetch(base + path, init)
  let payload = {}
  try { payload = await response.json() } catch {}
  return { status: response.status, body: payload }
}
const readDocs = async () => (await api('/state')).body?.state?.config?.docs
const saveDocs = async docs => api('/config', { docs })

before(async () => {
  const handlers = []
  /* 假 ctx：只提供 index.js apply 需要的钩子，绝不碰 ~/.dsh 活库（DSH_HOME 已指向临时目录）。 */
  const ctx = {
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    inject(deps, cb) {
      if (deps.includes('webServer')) {
        cb({ webServer: { register(route) { handlers.push(route); return () => {} } } })
      } else if (deps.includes('agents')) {
        try {
          cb({
            on: () => () => {},
            sessionController: {},
            workspaceRegistry: { list: () => [] },
            permissionPresets: {},
            agentDefaultModel: { currentSelection: () => undefined },
            sessionProjections: {},
          })
        } catch { /* 派单器起不来不影响路由判据 */ }
      }
      return () => {}
    },
    get() { return undefined },
    provide() {},
    log() {},
  }
  const mod = await import('../index.js')
  mod.apply(ctx)
  assert.ok(handlers.length > 0 && typeof handlers[0]?.handler === 'function', '没拿到 /studio-api 路由处理器')
  server = createServer((req, res) => handlers[0].handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}/studio-api`
})

after(async () => {
  if (server !== undefined) await new Promise(resolve => server.close(resolve))
  for (const dispose of disposers.reverse()) { try { dispose() } catch {} }
  try { rmSync(home, { recursive: true, force: true }) } catch {}
})

test('真 HTTP AC1-6a：全局 weknora 但连接没配全 → 400 not_ready + missing[global]，回读不变', async () => {
  const before = await readDocs()
  assert.equal(before.provider, 'feishu', '临时实例默认 feishu')
  const res = await saveDocs({ provider: 'weknora' })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'docs_config_not_ready')
  assert.deepEqual(res.body.missing, ['baseUrl', 'apiKey', 'knowledgeBaseId'])
  assert.deepEqual(res.body.scopes, ['global'])
  assert.match(res.body.error, /WeKnora 出口没配全/)
  assert.deepEqual(await readDocs(), before, '400 之后一项都不许落库')
})

test('真 HTTP：保存合法 WeKnora 连接（apiKey 留空语义 + 掩码）', async () => {
  const res = await saveDocs({ weknora: READY_SINK })
  assert.equal(res.status, 200)
  const readback = res.body.state.config.docs
  assert.equal(readback.weknora.baseUrl, READY_SINK.baseUrl)
  assert.equal(readback.weknora.apiKey, '', 'apiKey 回读恒空')
  assert.equal(readback.weknora.apiKeySet, true, 'apiKeySet 表示已配置')
  const again = await saveDocs({ weknora: { apiKey: '', tenantId: '10001' } })
  assert.equal(again.status, 200, '只发部分字段 + apiKey 留空必须能存')
  const after = await readDocs()
  assert.equal(after.weknora.apiKeySet, true, 'apiKey 留空 = 不修改，不会把已配置的 key 冲掉')
  assert.equal(after.weknora.baseUrl, READY_SINK.baseUrl, '字段级合并不冲掉 baseUrl')
  assert.equal(after.weknora.tenantId, '10001', '本次字段生效')
})

test('真 HTTP AC1-1/AC1-2：改全局与新增项目覆盖，保存后回读一致', async () => {
  let res = await saveDocs({ provider: 'both' })
  assert.equal(res.status, 200)
  assert.equal(res.body.state.config.docs.provider, 'both', 'AC1-1 全局改后回读相等')

  res = await saveDocs({ perProject: { pjAlpha: 'both' } })
  assert.equal(res.status, 200)
  const docs = await readDocs()
  assert.deepEqual(docs.perProject, { pjAlpha: 'both' }, 'AC1-2 新增项目覆盖回读相等')
  assert.equal(docs.provider, 'both', 'AC1-2 只改项目表时全局默认不变')

  /* 归一也走真接口：' BOTH ' 必须 200（不能因为大小写/空格把正常输入打成 400）。 */
  res = await saveDocs({ perProject: { pjAlpha: ' BOTH ' } })
  assert.equal(res.status, 200)
  assert.equal((await readDocs()).perProject.pjAlpha, 'both')
})

test('真 HTTP AC1-3/AC1-4：整表替换（删一项不动别人）与只改全局保留项目表', async () => {
  let res = await saveDocs({ perProject: { pjAlpha: 'both', pjBeta: 'feishu' } })
  assert.equal(res.status, 200)

  res = await saveDocs({ perProject: { pjBeta: 'feishu' } })
  assert.equal(res.status, 200)
  let docs = await readDocs()
  assert.deepEqual(docs.perProject, { pjBeta: 'feishu' }, 'AC1-3 提交的完整表里没有 pjAlpha = 删除它')
  assert.equal(docs.perProject.pjBeta, 'feishu', 'AC1-3 其它项目不受影响')

  res = await saveDocs({ provider: 'feishu' })
  assert.equal(res.status, 200)
  docs = await readDocs()
  assert.equal(docs.provider, 'feishu', 'AC1-4 只改全局生效')
  assert.deepEqual(docs.perProject, { pjBeta: 'feishu' }, 'AC1-4 没发 perProject = 保留既有项目覆盖（回归保护）')
})

test('真 HTTP AC1-5：非法项 400 + invalid 指名，回读深等不变', async () => {
  const before = await readDocs()
  const res = await saveDocs({ perProject: { pjBad: 'nope' } })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'docs_config_invalid')
  assert.deepEqual(res.body.invalid, [{ key: 'perProject.pjBad', value: 'nope', reason: 'unknown-provider' }])
  assert.deepEqual(res.body.missing, [])
  assert.deepEqual(res.body.scopes, [])
  assert.deepEqual(await readDocs(), before, '非法保存必须 0 项落库')
})

test('真 HTTP AC1-5b：400 响应体不回显 apiKey（连前缀都不许）', async () => {
  const secret = 'sk-' + 'x'.repeat(250)
  const response = await fetch(base + '/config', {
    method: 'POST',
    headers: { 'x-studio-user': 'docs-config-test', 'content-type': 'application/json' },
    body: JSON.stringify({ docs: { weknora: { apiKey: secret } } }),
  })
  const text = await response.text()
  assert.equal(response.status, 400)
  const body = JSON.parse(text)
  assert.equal(body.code, 'docs_config_invalid')
  assert.equal(body.invalid[0].key, 'weknora.apiKey')
  assert.equal(body.invalid[0].value, '（字符串）', 'weknora.* 只给类型标签（契约 §A）')
  assert.ok(!text.includes('sk-'), '400 响应原文不许出现密钥前缀：' + text.slice(0, 300))
  assert.ok(!text.includes('xxxx'), '连密钥片段都不许出现：' + text.slice(0, 300))
})

test('真 HTTP BUG-002 A：8 种误写形态响应原文零回显；provider 枚举错仍带值', async () => {
  const secret = 'sk-LEAK-0123456789'
  const shapes = [
    ['weknora 整块字符串', { docs: { weknora: secret } }, 'weknora'],
    ['weknora 整块数组', { docs: { weknora: [secret] } }, 'weknora'],
    ['docs.apiKey（层级放错）', { docs: { apiKey: secret } }, 'docs.apiKey'],
    ['api_key（拼写变体）', { docs: { weknora: { api_key: secret } } }, 'weknora.api_key'],
    ['apikey（大小写变体）', { docs: { weknora: { apikey: secret } } }, 'weknora.apikey'],
    ['docs 整块数组', { docs: [secret] }, 'docs'],
    ['apiKey 非字符串', { docs: { weknora: { apiKey: [secret] } } }, 'weknora.apiKey'],
    ['apiKey 超长', { docs: { weknora: { apiKey: secret + 'x'.repeat(300) } } }, 'weknora.apiKey'],
  ]
  for (const [label, payload, key] of shapes) {
    const response = await fetch(base + '/config', {
      method: 'POST',
      headers: { 'x-studio-user': 'docs-config-test', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    /* 判据是**响应原文**：JSON.stringify 出来的 invalid 也可能被日志/代理转发。 */
    const text = await response.text()
    assert.equal(response.status, 400, label + '：必须 400')
    const body = JSON.parse(text)
    assert.equal(body.code, 'docs_config_invalid', label)
    assert.equal(body.invalid[0].key, key, label + '：键名保留')
    assert.ok(!text.includes('sk-LEAK'), label + '：400 响应原文不许出现密钥：' + text.slice(0, 300))
    assert.ok(!text.includes('LEAK'), label + '：连片段都不许出现：' + text.slice(0, 300))
  }
  /* 保留可用性：枚举写错仍要回显原值，否则面板无法判断是改类型还是改值。 */
  const nope = await saveDocs({ provider: 'nope' })
  assert.equal(nope.status, 400)
  assert.equal(nope.body.invalid[0].value, 'nope', "provider:'nope' 仍带值")
  const badProject = await saveDocs({ perProject: { pjBad: 'nope' } })
  assert.equal(badProject.status, 400)
  assert.equal(badProject.body.invalid[0].value, 'nope', 'perProject 枚举错仍带值')
})

test('真 HTTP AC2-3：项目级 both 缺 knowledgeBaseId → 保存即被拒，指名影响范围', async () => {
  const before = await readDocs()
  const res = await saveDocs({ perProject: { pjNeed: 'both' }, weknora: { knowledgeBaseId: '' } })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'docs_config_not_ready')
  assert.deepEqual(res.body.missing, ['knowledgeBaseId'])
  assert.deepEqual(res.body.scopes, ['project:pjNeed'])
  assert.deepEqual(await readDocs(), before, '半配置必须 0 项落库')
})

test('真 HTTP：清空项目覆盖（降级）与空表可用', async () => {
  const res = await saveDocs({ perProject: {} })
  assert.equal(res.status, 200)
  assert.deepEqual((await readDocs()).perProject, {}, '显式空表 = 清空覆盖（配合全局用）')
})

/* ── 二·b、/config 顶层键白名单（扁平键不许静默丢掉） ───────────────── */

test('真 HTTP：扁平键 agentsMaxConcurrent 被 400 拒绝，并指出正确的分组形状', async () => {
  const res = await api('/config', { agentsMaxConcurrent: 3 })
  assert.equal(res.status, 400, '扁平键以前是 200 但什么都不改')
  assert.equal(res.body.code, 'config_unknown_key')
  assert.ok(res.body.unknown.includes('agentsMaxConcurrent'), '要指出是哪个键')
  assert.match(res.body.error, /maxConcurrent/, '要给出正确的分组形状（{"agents":{"maxConcurrent":3}}）')
  const state = (await api('/state')).body.state
  assert.equal(state.config.agents.maxConcurrent, 2, '被拒时配置一项都不能改')
})

test('真 HTTP：分组形状照旧生效，请求元信息 by 不拦', async () => {
  const res = await api('/config', { agents: { maxConcurrent: 3 }, by: 'config-keys-test' })
  assert.equal(res.status, 200)
  assert.equal((await api('/state')).body.state.config.agents.maxConcurrent, 3)
  // 复原，别把 3 留给后面的用例
  await api('/config', { agents: { maxConcurrent: 2 } })
})

/* ── 三、源码守卫：行为对了但接线被改回去，也要在这里响 ───────────────── */

test('源码守卫：index.js 走 writeDocsConfig、admin.js 映射两个 400 码', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.ok(index.includes("from './src/host/docs-config.js'"), 'index.js 必须 import 新模块')
  assert.ok(index.includes('writeDocsConfig(config, patch.docs)'), 'index.js 必须调写入层校验')
  assert.ok(!index.includes('sanitizeDocsConfig(patch.docs'), 'index.js 不许再绕过校验直接 sanitize')
  const admin = readFileSync(new URL('../src/host/routes/admin.js', import.meta.url), 'utf8')
  assert.ok(admin.includes("'docs_config_invalid'"), 'admin.js 必须映射 docs_config_invalid')
  assert.ok(admin.includes("'docs_config_not_ready'"), 'admin.js 必须映射 docs_config_not_ready')
  assert.ok(admin.includes('invalid: error.invalid'), '400 体必须带 invalid/missing/scopes')
})
