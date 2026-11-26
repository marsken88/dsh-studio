/* a3 的两条入口用例（方案 §13.2 E1/E2）：WeKnora 写入失败时**只落 doc.error**，
   交付物登记本身不许被拖下水 —— 「主从不许反转」在三个入口上都要成立。
   另外两个入口的证据在别处：路由 POST /task/artifact/sync 由 qa/ 的真 HTTP 探针覆盖，
   both 的主从语义由 tests/doc-sink-dispatch.test.mjs（both + WeKnora 500 不抛）覆盖。

   为什么入口层不测 both：both 必定走飞书分支，而 executor.syncArtifact 把 writeFeishu
   硬编码成真的 syncArtifactToFeishu（executor.js:1304，没有 io 注入口）。硬造 both 只会
   死在「测试 store 没配云盘根文件夹」或「没注入 markHealth」，再不然就真 spawn lark-cli
   去建外部目录 —— 三条路都验不到 WeKnora 语义。 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { syncRequirementArtifacts } from '../src/host/executor.js'
import { SecretStore, StudioStore } from '../src/host/store.js'
import { configureToolHost, registerTools } from '../src/host/tools.js'

/** 假知识库：建文档一律 500，专用于验「写失败」这条分支。 */
async function startFailingKnowledgeBase() {
  const calls = []
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      calls.push(`${req.method} ${req.url}`)
      res.setHeader('Content-Type', 'application/json')
      res.statusCode = 500
      res.end(JSON.stringify({ message: 'boom' }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, calls, baseUrl: `http://127.0.0.1:${server.address().port}` }
}

function closeServer(server) {
  server.closeAllConnections?.()
  return new Promise(resolve => server.close(resolve))
}

/** 一个配好 weknora 出口的临时 store。 */
async function openStore(t, baseUrl) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-studio-sink-entry-'))
  const store = new StudioStore(join(dir, 'state.json'), {
    dbFile: join(dir, 'state.db'),
    secrets: new SecretStore(join(dir, '.secrets.json')),
  })
  await store.ready
  await store.mutate(state => {
    state.config.docs = {
      provider: 'weknora',
      perProject: {},
      weknora: { baseUrl, apiKey: 'k', tenantId: '', knowledgeBaseId: 'kb1' },
    }
  })
  t.after(() => {
    store.db?.close?.()
    // Windows 上临时目录偶发删不干净（db 句柄还没落完），清理失败不该把结论变成假红。
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响断言 */ }
  })
  return store
}

function card(id, code, extra = {}) {
  return {
    id, code, title: `（自检）${code}`, type: 'requirement',
    status: 'dev', role: 'dev', comments: [], history: [], checklist: [], cases: [], artifacts: [],
    updatedAt: Date.now(), ...extra,
  }
}

function artifact(id, title) {
  return { id, kind: 'report', title, content: '正文', status: 'delivered', by: '自检', at: Date.now() }
}

/** 把 studio_task_artifact 这个工具从 registerTools 里捞出来。 */
function artifactTool(store) {
  const tools = []
  const ctx = { tools: { register: tool => { tools.push(tool); return () => {} } }, effect: () => () => {} }
  configureToolHost({
    toolOperator: () => '自检',
    toolLevel: () => 'write',
    checkToolAccess: () => ({ level: 'write', denial: null }),
    recordAudit: async () => {},
    getActiveDispatcher: () => undefined,
    getActiveSkills: () => undefined,
  })
  registerTools(ctx, store)
  return tools.find(tool => tool.name === 'studio_task_artifact')
}

test('E1 工具入口 studio_task_artifact：WeKnora 建文档 500 → 只回「归档失败」，交付物照留', async (t) => {
  const kb = await startFailingKnowledgeBase()
  t.after(() => closeServer(kb.server))
  const store = await openStore(t, kb.baseUrl)
  await store.mutate(state => { state.tasks.push(card('t-entry-1', 'DEV-900')) })

  const tool = artifactTool(store)
  assert.ok(tool !== undefined, '应该注册了 studio_task_artifact')

  // sync 不传 false → 走真分发（config.docs.provider=weknora）→ 真打假知识库
  const text = await tool.execute({ id: 't-entry-1', kind: 'report', title: '入口自检一', content: '正文', by: '自检' }, {})

  assert.match(String(text), /归档失败/, `①失败要说出「归档失败」，实际返回：${text}`)
  const saved = store.snapshot().tasks.find(item => item.id === 't-entry-1')
  assert.equal(saved.artifacts.length, 1, '②登记不许因为归档失败被回滚或丢掉')
  const record = saved.artifacts[0].docs.weknora
  assert.match(record.error, /建文档失败/, '③原因要能回读到卡上（doc.error）')
  assert.equal(record.replaced, false, '④没有旧锚点，不许标 replaced=true')
  assert.equal(record.knowledgeId, '', '没建成就不许有 knowledgeId，别留假地址')
  assert.equal(kb.calls.filter(line => line.includes('/knowledge/manual')).length, 1, '真的打了一次建文档接口')
})

test('E2 批量入口 syncRequirementArtifacts：需求下 2 件全失败 → 记账、不抛、两件都还在', async (t) => {
  const kb = await startFailingKnowledgeBase()
  t.after(() => closeServer(kb.server))
  const store = await openStore(t, kb.baseUrl)
  await store.mutate(state => {
    state.requirements.push({ id: 'req-entry', code: 'REQ-2026-900', title: '（自检）批量入口' })
    state.tasks.push(
      card('t-entry-2', 'DEV-901', { requirementId: 'req-entry', artifacts: [artifact('a-entry-1', '批量自检一')] }),
      card('t-entry-3', 'DEV-902', { requirementId: 'req-entry', artifacts: [artifact('a-entry-2', '批量自检二')] }),
    )
  })

  // 这一句抛了就说明「批量入口被从出口的失败拖挂了」——不包 try，让它直接红。
  const report = await syncRequirementArtifacts(store, 'req-entry')

  assert.deepEqual(
    { total: report.total, written: report.written, failed: report.failed },
    { total: 2, written: 0, failed: 2 },
    '①两件都记失败（不是「一件失败一件跳过」）',
  )
  assert.equal(report.errors.length, 2, '每件都要能说出原因')
  assert.match(report.errors[0], /建文档失败/, `②errors[] 要带原因，实际：${report.errors[0]}`)
  const state = store.snapshot()
  for (const id of ['t-entry-2', 't-entry-3']) {
    const saved = state.tasks.find(item => item.id === id)
    assert.equal(saved.artifacts.length, 1, `③${id} 的交付物必须还在`)
    assert.match(saved.artifacts[0].docs.weknora.error, /建文档失败/, `③${id} 的 doc.error 要落库`)
  }
})
