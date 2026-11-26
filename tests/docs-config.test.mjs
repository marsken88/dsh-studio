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

test('buildDocsConfig：apiKey 永不回显（400 invalid[] 只给遮蔽符）', () => {
  const longKey = 'sk-' + 'x'.repeat(250)
  const cases = [
    [{ weknora: { apiKey: longKey } }, 'too-long'],
    [{ weknora: { apiKey: 12345 } }, 'not-string'],
    [{ weknora: { apiKey: { value: longKey } } }, 'not-string'],
  ]
  for (const [patch, reason] of cases) {
    let caught
    try { buildDocsConfig(BASE, patch) } catch (error) { caught = error }
    assert.ok(caught instanceof DocsConfigError, '必须抛 DocsConfigError')
    assert.equal(caught.invalid[0].key, 'weknora.apiKey')
    assert.equal(caught.invalid[0].reason, reason)
    assert.equal(caught.invalid[0].value, '（已隐藏）', 'apiKey 的非法值只能给遮蔽符')
    const payload = JSON.stringify({ error: caught.message, invalid: caught.invalid, missing: caught.missing, scopes: caught.scopes })
    assert.ok(!payload.includes('sk-'), '400 响应体不许出现密钥前缀：' + payload)
    assert.ok(!payload.includes('xxxx'), '连片段都不许出现：' + payload)
  }
  /* 遮蔽只针对 apiKey：其它字段不是密钥，保留前缀才好定位是哪个值错了。 */
  let baseUrlError
  try { buildDocsConfig(BASE, { weknora: { baseUrl: 'x'.repeat(301) } }) } catch (error) { baseUrlError = error }
  assert.ok(baseUrlError instanceof DocsConfigError)
  assert.notEqual(baseUrlError.invalid[0].value, '（已隐藏）', '非密钥字段不该被一起抹掉')
  assert.ok(String(baseUrlError.invalid[0].value).startsWith('xxxxxxxxxxxx'), '非密钥字段保留前缀便于定位')
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
  assert.equal(body.invalid[0].value, '（已隐藏）', '响应体里 apiKey 只能给遮蔽符')
  assert.ok(!text.includes('sk-'), '400 响应原文不许出现密钥前缀：' + text.slice(0, 300))
  assert.ok(!text.includes('xxxx'), '连密钥片段都不许出现：' + text.slice(0, 300))
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
