// issue #164–#167 的回归测试（2026-11-26 用户点名要修的四条）。
//
// #164 用例工具静默成功 / #165 shell 用例超时硬顶 120s / #166 白名单迁移只认 3 值旧默认 /
// #167 401 文案指向 npm 包里不存在的文件。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { sanitizeCaseShell } from '../src/host/shell-case.js'
import { SecretStore, StudioStore } from '../src/host/store.js'
import { configureToolHost, registerTools } from '../src/host/tools.js'

const withStore = async fn => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-studio-164-'))
  const store = new StudioStore(join(dir, 'state.json'), {
    dbFile: join(dir, 'state.db'),
    secrets: new SecretStore(join(dir, '.secrets.json')),
  })
  try {
    await store.ready
    return await fn({ store, dir })
  } finally {
    try { store.db?.close?.() } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

const withTools = async fn => {
  return withStore(async ({ store, dir }) => {
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
    const find = name => tools.find(tool => tool.name === name)
    return await fn({ store, dir, find })
  })
}

const makeCard = async (store, extra = {}) => {
  let id = ''
  await store.mutate(state => {
    id = `t-case-${Math.random().toString(16).slice(2, 8)}`
    state.tasks.push({
      id, code: 'BUG-900', title: '用例工具回归', status: 'test', type: 'bug', role: 'qa',
      requirementId: '', parent: '', checklist: [], artifacts: [], comments: [], history: [], cases: [], blocked: null,
      ...extra,
    })
  })
  return id
}

test('#164 update/remove 对不存在的 caseId 直接报错，不再静默成功', async () => {
  await withTools(async ({ store, find }) => {
    const id = await makeCard(store)
    const tool = find('studio_task_case')
    await assert.rejects(() => tool.execute({ id, action: 'update', caseId: 'c-nope', result: 'pass' }), /no case c-nope on task/)
    await assert.rejects(() => tool.execute({ id, action: 'remove', caseId: 'c-nope' }), /no case c-nope on task/)
  })
})

test('#164 非法 result 报错（拼错不再被静默忽略）', async () => {
  await withTools(async ({ store, find }) => {
    const id = await makeCard(store)
    const tool = find('studio_task_case')
    await tool.execute({ id, action: 'add', cases: [{ title: '一条用例', expected: 'ok' }] })
    const caseId = store.snapshot().tasks.find(t => t.id === id).cases[0].id
    await assert.rejects(() => tool.execute({ id, action: 'update', caseId, result: 'passed' }), /result 只认/)
    const out = await tool.execute({ id, action: 'update', caseId, result: 'pass', note: '已验' })
    assert.match(String(out), /已更新用例/, '要回显改了哪一条')
    assert.equal(store.snapshot().tasks.find(t => t.id === id).cases[0].result, 'pass')
  })
})

test('#164 缺陷卡自己没有用例时，报错要指出用例可能挂在父卡上', async () => {
  await withTools(async ({ store, find }) => {
    const id = await makeCard(store, { parent: 't-parent-1' })
    const tool = find('studio_task_case')
    await assert.rejects(
      () => tool.execute({ id, action: 'update', caseId: 'c-123456', result: 'pass' }),
      /挂在父卡 t-parent-1 上/,
    )
  })
})

test('#165 shell 用例 timeoutMs 上限抬到 600000（编译类门禁 113s 不再贴顶被杀）', () => {
  assert.equal(sanitizeCaseShell({ command: 'mvn -o compile', timeoutMs: 300000 }).timeoutMs, 300000)
  assert.equal(sanitizeCaseShell({ command: 'x', timeoutMs: 9999999 }).timeoutMs, 600000, '仍然有硬顶')
  assert.equal(sanitizeCaseShell({ command: 'x' }).timeoutMs, 30000, '默认不变')
})

test('#166 白名单迁移认 4 值旧默认（否则 dev/review/accept 永不自动派）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-studio-166-'))
  const open = async () => {
    const store = new StudioStore(join(dir, 'state.json'), {
      dbFile: join(dir, 'state.db'),
      secrets: new SecretStore(join(dir, '.secrets.json')),
    })
    await store.ready
    return store
  }
  try {
    const first = await open()
    await first.mutate(state => {
      state.config.schema = 7 // 模拟老库：迁移还没跑
      state.config.agents = { ...state.config.agents, autoStatuses: ['clarify', 'design', 'dev_ready', 'test'] }
    })
    first.db?.close?.()
    const second = await open()
    const auto = second.snapshot().config.agents.autoStatuses
    for (const id of ['dev', 'review', 'accept']) assert.ok(auto.includes(id), `迁移后要包含 ${id}：${JSON.stringify(auto)}`)
    second.db?.close?.()
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

test('#167 401 文案不再指向 npm 包里不存在的 tools/lib/studio-auth.mjs', () => {
  const access = readFileSync(new URL('../src/host/access.js', import.meta.url), 'utf8')
  assert.equal(access.includes('脚本用 tools/lib/studio-auth.mjs 换 cookie'), false, '文案不能把脚本指到仓库路径')
  assert.match(access, /dsh-auth cookie/, '要给出真实可用的路径：先登录拿 dsh-auth cookie')
})
