// 一致性一批（issue #13 / #15 / #16 / #17 / #19）的回归。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { removeTaskComment, updateTaskComment } from '../src/host/comments.js'
import { isAiSignoff, signoffActorKind } from '../src/host/intervention.js'
import { SecretStore, StudioStore } from '../src/host/store.js'
import { configureToolHost, registerTools } from '../src/host/tools.js'

const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')

const card = () => ({
  id: 't-c1', code: 'DEV-001', title: '评论', status: 'dev', role: 'dev',
  comments: [{ id: 'c-111', at: 1, author: '测试工程师', kind: 'agent', body: '原来那句' }],
  checklist: [], artifacts: [], history: [], cases: [], blocked: null,
})

const withStore = async fn => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-consistency-'))
  const store = new StudioStore(join(dir, 'state.json'), { dbFile: join(dir, 'state.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  try {
    await store.ready
    return await fn(store)
  } finally {
    store.db?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('#19 评论能改：改完留历史；新正文与旧正文相同要报错', async () => {
  await withStore(async store => {
    await store.mutate(state => { state.tasks.push(card()) })
    await updateTaskComment(store, 't-c1', 'c-111', '改过的结论', '架构师')
    const task = store.snapshot().tasks.find(item => item.id === 't-c1')
    assert.equal(task.comments[0].body, '改过的结论')
    assert.equal(task.comments[0].editedBy, '架构师')
    assert.ok(task.comments[0].editedAt > 0)
    assert.ok(task.history.some(entry => String(entry.note ?? '').includes('改了评论 c-111')), '改要留历史')
    await assert.rejects(() => updateTaskComment(store, 't-c1', 'c-111', '改过的结论'), /一样/)
    await assert.rejects(() => updateTaskComment(store, 't-c1', 'c-404', 'x'), /no comment/)
  })
})

test('#19 评论能删：删了留历史，找不到就报错', async () => {
  await withStore(async store => {
    await store.mutate(state => { state.tasks.push(card()) })
    await removeTaskComment(store, 't-c1', 'c-111', '架构师')
    const task = store.snapshot().tasks.find(item => item.id === 't-c1')
    assert.equal(task.comments.length, 0)
    assert.ok(task.history.some(entry => String(entry.note ?? '').includes('删了评论 c-111')))
    await assert.rejects(() => removeTaskComment(store, 't-c1', 'c-111'), /no comment/)
  })
})

test('#15 签字口径统一：专家名算 AI，普通人算人，记录与闸门不再打架', () => {
  const config = { experts: [{ id: 'pm', name: '产品经理' }] }
  assert.equal(signoffActorKind('产品经理', config), 'ai', '专家名册里的名字 = AI')
  assert.equal(signoffActorKind('张三', config), 'human')
  assert.equal(signoffActorKind('studio-t-1-dev', config), 'ai', 'studio-* 会话名 = AI')
  assert.equal(signoffActorKind('', config), 'unknown')
  // 记录里写什么，闸门就按什么判：以前记录 human、闸门却因为名字在名册里判 AI
  assert.equal(isAiSignoff({ by: '产品经理', actorKind: signoffActorKind('产品经理', config) }, config), true)
  assert.equal(isAiSignoff({ by: '张三', actorKind: signoffActorKind('张三', config) }, config), false)
  assert.equal(isAiSignoff({ by: 'agent', actorKind: 'agent' }, config), true, '工具写死的 agent 仍然算 AI')
})

test('#13 评审结论两个入参都认，缺了或写错要报错（不再静默 pending）', async () => {
  await withStore(async store => {
    const registered = []
    const ctx = { tools: { register: tool => { registered.push(tool); return () => {} } }, effect: () => () => {} }
    configureToolHost({
      toolOperator: () => '自检', toolLevel: () => 'write',
      checkToolAccess: () => ({ level: 'write', denial: null }), recordAudit: async () => {},
      publicConfig: config => config, getActiveDispatcher: () => undefined, getActiveSkills: () => undefined,
    })
    registerTools(ctx, store)
    const coding = registered.find(tool => tool.name === 'studio_task_coding')
    await store.mutate(state => {
      state.tasks.push({ ...card(), coding: { agent: 'claude-code', branch: 'x', files: [], commits: [], review: { status: 'pending', by: '', at: 0, note: '' } } })
    })
    // 工具用 reviewStatus（老写法）
    await coding.execute({ id: 't-c1', action: 'review', reviewStatus: 'approved', by: '架构师' }, {})
    assert.equal(store.snapshot().tasks[0].coding.review.status, 'approved')
    // 也认 status（HTTP 的写法）
    await coding.execute({ id: 't-c1', action: 'review', status: 'changes_requested', by: '架构师' }, {})
    assert.equal(store.snapshot().tasks[0].coding.review.status, 'changes_requested')
    // 两个都不给 / 给错 → 报错，而不是落成 pending
    await assert.rejects(() => coding.execute({ id: 't-c1', action: 'review', by: '架构师' }, {}), /评审要给结论/)
    await assert.rejects(() => coding.execute({ id: 't-c1', action: 'review', status: 'looks-good', by: '架构师' }, {}), /不认识/)
  })
})

test('#16 删除不存在要报错（路由里有存在性校验），#17 只读路由不打 revision 标记', () => {
  const tasksRoute = source('src/host/routes/tasks.js')
  const releasesRoute = source('src/host/routes/releases.js')
  const codingRoute = source('src/host/routes/coding.js')
  const reqRoute = source('src/host/routes/requirements.js')
  assert.match(tasksRoute, /no expert \$\{id\}/)
  assert.match(tasksRoute, /no team \$\{id\}/)
  assert.match(tasksRoute, /no suite \$\{wanted\}/)
  assert.match(releasesRoute, /no release \$\{id\}/)
  assert.match(codingRoute, /no project \$\{id\}/)
  // #17：纯读路由要打只读标记（否则 /state 的 ETag 被自己的读操作打穿）
  assert.match(reqRoute, /route === '\/task\/gate'\) \{[\s\S]{0,200}__studioReadOnly = true/, 'task/gate 要标只读')
  assert.match(reqRoute, /route === '\/requirement\/matrix'\) \{[\s\S]{0,200}__studioReadOnly = true/, 'requirement/matrix 要标只读')
  assert.match(reqRoute, /route === '\/requirement\/impact'\) \{[\s\S]{0,200}__studioReadOnly = true/, 'requirement/impact 要标只读')
})

test('#18 幂等并发闸：同一 key 同时只放一个请求进去，释放后可重入', async () => {
  const { createIdempotencyGate } = await import('../src/host/idempotency.js')
  const gate = createIdempotencyGate()
  assert.equal(gate.claim('route:k1'), true)
  assert.equal(gate.claim('route:k1'), false, '并发第二个必须被挡回（以前两个都执行 → 写两条）')
  assert.equal(gate.claim('route:k2'), true, '不同 key 互不影响')
  gate.release('route:k1')
  assert.equal(gate.claim('route:k1'), true, '释放后同一个 key 可以再来（正常重试）')
  assert.equal(gate.claim(''), true, '空 scope 不参与抢锁')
})

test('抽屉反馈接线：toast 递给 createDrawer，推进按钮走带 override 的 advanceTo', () => {
  const drawer = source('web/src/studio/drawer.js')
  const client = source('client.src.js')
  assert.match(drawer, /export function createDrawer\(\{[^}]*MentionPicker, toast \}\)/, 'createDrawer 要接 toast')
  assert.match(drawer, /if \(typeof toast === 'function'\) toast\(String\(error\), 'error'\)/, '失败要有可见轻提示')
  assert.match(drawer, /const advanceTo = async/, '推进要有独立入口')
  assert.match(drawer, /advanceTo\(forward\.id, forward\.role\)/, '主推进按钮要能强推')
  assert.match(drawer, /advanceTo\(target\.id, target\.role\)/, '其它状态推进也要能强推')
  assert.match(client, /MentionPicker, toast \}\)/, '组合根要真的把 toast 传进去')
})

test('只读路由判定接在请求管线的权限判定之前（否则 action=get 永不生效）', () => {
  const index = source('index.js')
  assert.match(index, /import \{[^}]*isReadOnlyPost[^}]*\} from '\.\/src\/host\/access\.js'/)
  assert.match(index, /const readOnlyPost = isReadOnlyPost\(route, req\.__studioBody \?\? \{\}\)/)
  const order = index.indexOf('req.__studioBody = await readJsonBody(req)')
  const levelAt = index.indexOf('const level = route.startsWith')
  assert.ok(order > 0 && levelAt > order, 'body 必须先解析再算权限档位')
})
