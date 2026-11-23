// 交接契约：决策 / 假设 / 未决 / 风险 / 影响面 —— 数据形状、派单提示词、清空语义。
// 产品定义 V1 必做第 5 条：提示词先读契约，再看评论尾 6 条。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { handoffBlock, handoffFilled, sanitizeHandoff } from '../src/host/handoff.js'
import { normalizePatch } from '../src/host/domain.js'
import { buildExpertPrompt, configureDispatcher } from '../src/host/dispatcher.js'
import { updateTask } from '../src/host/executor.js'
import { configureTaskRoutes, handleTaskRoute } from '../src/host/routes/tasks.js'
import { configureToolHost, registerTools } from '../src/host/tools.js'
import { SecretStore, StudioStore } from '../src/host/store.js'

test('handoff: 五段清洗、空值归一成 null、每段有上限', () => {
  const clean = sanitizeHandoff({
    decision: '  用 SQLite 事务  ',
    assumptions: '',
    openQuestions: '要不要分表',
    risks: '锁竞争',
    impactScope: 'Inventory',
    by: ' 架构师 ',
  })
  assert.equal(clean.decision, '用 SQLite 事务')
  assert.equal(clean.openQuestions, '要不要分表')
  assert.equal(clean.by, '架构师')
  assert.equal(handoffFilled(clean), 4)
  assert.equal(sanitizeHandoff({ decision: '   ' }), null, '全空 = 没有契约')
  assert.equal(sanitizeHandoff(null), null)
  assert.equal(sanitizeHandoff('x'), null)
  assert.equal(sanitizeHandoff([]), null)
  const long = sanitizeHandoff({ decision: 'x'.repeat(2000) })
  assert.equal(long.decision.length, 1000, '单段截断，别把卡撑成文档')
})

test('handoff: normalizePatch 认 handoff，null 用来清空', () => {
  const patch = normalizePatch({ handoff: { decision: 'A', risks: 'B', by: '人' } })
  assert.equal(patch.handoff.decision, 'A')
  assert.equal(patch.handoff.risks, 'B')
  assert.equal(normalizePatch({ handoff: null }).handoff, null)
  assert.equal('handoff' in normalizePatch({ title: 'x' }), false, '不传就不动')
})

test('handoff: 派单提示词先读契约，再读最近评论', () => {
  configureDispatcher({
    serviceOf: () => undefined,
    workProjectOf: () => undefined,
    serviceConflicts: () => undefined,
  })
  const base = {
    id: 't-h1', code: 'DEV-001', title: '库存预占', status: 'dev', role: 'dev', priority: 'normal',
    requirementId: '', project: '', iteration: '', service: '', dueAt: 0, owner: '', expert: '',
    comments: [{ author: '产品', body: '最近一条评论' }], checklist: [], artifacts: [], cases: [],
    coding: null, worktree: null, design: null, gitlabMR: { iid: 0, title: '', state: '', url: '' },
    handoff: { decision: '用 SQLite 事务', assumptions: '单进程', openQuestions: '要不要分表', risks: '', impactScope: '', by: '架构师', at: 1 },
  }
  const expert = { id: 'dev', name: '开发', emoji: '🔧', skills: [] }
  const column = { id: 'dev', label: '开发中' }
  const config = { experts: [], projects: [] }
  const state = { config, tasks: [base] }
  const prompt = buildExpertPrompt(base, expert, column, config, undefined, '', undefined, state, [])
  assert.match(prompt, /交接契约/)
  assert.match(prompt, /决策：用 SQLite 事务/)
  assert.match(prompt, /未决：要不要分表/)
  assert.ok(prompt.indexOf('交接契约') < prompt.indexOf('最近评论'), '契约要排在评论之前')

  const bare = buildExpertPrompt({ ...base, handoff: null }, expert, column, config, undefined, '', undefined, { config, tasks: [{ ...base, handoff: null }] }, [])
  // 协作约定里始终会提「交接契约」这个词；这里要断言的是**卡上没有契约时不渲染契约内容**。
  assert.doesNotMatch(bare, /决策：用 SQLite 事务/)
  assert.doesNotMatch(bare, /未决：要不要分表/)
  assert.equal(handoffBlock(null), '')
})

test('handoff: updateTask 真的落库，传 null 清空', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-studio-handoff-'))
  const store = new StudioStore(join(dir, 'state.json'), {
    dbFile: join(dir, 'state.db'),
    secrets: new SecretStore(join(dir, '.secrets.json')),
  })
  try {
    await store.ready
    await store.mutate(state => {
      state.tasks.push({
        id: 't-h1', code: 'DEV-001', title: '交接契约', type: 'dev', status: 'dev', role: 'dev',
        priority: 'normal', requirementId: '', project: '', service: '', pointId: '',
        comments: [], history: [], checklist: [], cases: [], artifacts: [], version: 0,
        updatedAt: Date.now(),
      })
    })
    await updateTask(store, 't-h1', { handoff: { decision: 'A', risks: 'B', by: '架构师' } })
    const saved = store.snapshot().tasks.find(item => item.id === 't-h1')
    assert.equal(saved.handoff.decision, 'A')
    assert.equal(saved.handoff.risks, 'B')
    assert.equal(saved.handoff.by, '架构师')
    assert.ok(saved.handoff.at > 0)

    await updateTask(store, 't-h1', { handoff: null })
    assert.equal(store.snapshot().tasks.find(item => item.id === 't-h1').handoff, null)
  } finally {
    store.db?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('handoff: HTTP /task/update 与 studio_task_update 两个入口都接受 handoff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-studio-handoff-entry-'))
  const store = new StudioStore(join(dir, 'state.json'), {
    dbFile: join(dir, 'state.db'),
    secrets: new SecretStore(join(dir, '.secrets.json')),
  })
  try {
    await store.ready
    await store.mutate(state => {
      state.tasks.push({
        id: 't-h2', code: 'DEV-002', title: '交接入口', type: 'dev', status: 'dev', role: 'dev',
        priority: 'normal', requirementId: '', project: '', service: '', pointId: '',
        comments: [], history: [], checklist: [], cases: [], artifacts: [], version: 0,
        updatedAt: Date.now(),
      })
    })

    // HTTP 入口：/task/update 的 body 直接带 handoff（面板走这条）
    let sent = null
    configureTaskRoutes({
      sendJson: (_res, status, body) => { sent = { status, body } },
      readJsonBody: async () => ({ id: 't-h2', handoff: { decision: '路由写入', by: '人' } }),
      updateTask,
      publicState: () => ({}),
    })
    const handled = await handleTaskRoute({
      method: 'POST', route: '/task/update', req: {}, res: {}, store, url: new URL('http://localhost/task/update'),
    })
    assert.equal(handled, true)
    assert.equal(sent?.status, 200)
    assert.equal(store.snapshot().tasks.find(item => item.id === 't-h2').handoff.decision, '路由写入')

    // 工具入口：studio_task_update 的 handoff 字段（专家走这条）
    const tools = []
    configureToolHost({
      toolOperator: () => '自检',
      toolLevel: () => 'write',
      checkToolAccess: () => ({ level: 'write', denial: null }),
      recordAudit: async () => {},
      getActiveDispatcher: () => undefined,
      getActiveSkills: () => undefined,
    })
    registerTools({ tools: { register: tool => { tools.push(tool); return () => {} } }, effect: () => () => {} }, store)
    const updateTool = tools.find(tool => tool.name === 'studio_task_update')
    assert.ok(updateTool !== undefined)
    const out = await updateTool.execute({ id: 't-h2', handoff: { decision: '工具写入', openQuestions: '要不要灰度' } }, {})
    assert.match(String(out), /库里的记录/)
    const saved = store.snapshot().tasks.find(item => item.id === 't-h2')
    assert.equal(saved.handoff.decision, '工具写入')
    assert.equal(saved.handoff.openQuestions, '要不要灰度')
  } finally {
    store.db?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})
