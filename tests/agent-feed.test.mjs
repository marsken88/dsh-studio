// 执行播报的纯逻辑：会话名解析 / 内容抽取 / 节流 / 正文拼装 / 审批说明。
import assert from 'node:assert/strict'
import test from 'node:test'

import { approvalNote, createFeedBuffer, feedBody, parseStudioSession, readAssistantMessage, shouldFlush } from '../src/host/agent-feed.js'
import { createFeedComments } from '../src/host/feed-comments.js'

test('parseStudioSession：只认 studio-<taskId>-<expertId>', () => {
  assert.deepEqual(parseStudioSession('studio-t-1ba8dfdc-architect'), { taskId: 't-1ba8dfdc', expertId: 'architect' })
  assert.deepEqual(parseStudioSession('studio-t-104613e5-dev'), { taskId: 't-104613e5', expertId: 'dev' })
  assert.equal(parseStudioSession('some-other-session'), null)
  assert.equal(parseStudioSession('studio-onlyone'), null)
  assert.equal(parseStudioSession(''), null)
  assert.equal(parseStudioSession(undefined), null)
})

test('readAssistantMessage：抽出思考 / 回复 / 工具 / 实际模型', () => {
  const read = readAssistantMessage({
    role: 'assistant',
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4.1-flash' },
    content: [
      { type: 'reasoning', text: '先看卡片要求' },
      { type: 'text', text: '我按 A 方案实现' },
      { type: 'tool-call', id: 'c1', name: 'ops_bash', arguments: '{}' },
    ],
  })
  assert.deepEqual(read.reasonings, ['先看卡片要求'])
  assert.deepEqual(read.texts, ['我按 A 方案实现'])
  assert.deepEqual(read.tools, ['ops_bash'])
  assert.equal(read.provider, 'deepseek-official')
  assert.equal(read.model, 'deepseek-v4.1-flash')
})

test('feedBody：把实际模型写进正文（这是排查 Flash/Pro 的唯一实证）', () => {
  const body = feedBody({ reasonings: ['想了想'], texts: ['做完了'], tools: ['ops_bash', 'ops_bash'], model: 'deepseek-v4.1-flash', provider: 'deepseek-official' })
  assert.equal(/思考：/.test(body), false, '播报不再贴思考推理')
  assert.match(body, /做完了/)
  assert.match(body, /工具：ops_bash/, '工具要去重')
  assert.match(body, /模型：deepseek-official\/deepseek-v4\.1-flash/)
  assert.match(body, /派单会话自动播报/)
})

test('feedBody：没有实质内容返回空串（不刷空评论）', () => {
  assert.equal(feedBody({ texts: [], reasonings: [], tools: [] }), '')
  assert.equal(feedBody(null), '')
})

test('shouldFlush：默认 15 秒节流，本轮结束强制发', () => {
  const buffer = { texts: ['x'], reasonings: [], tools: [], lastFlush: 0, model: '' }
  assert.equal(shouldFlush(buffer, 1000), false, '刚发过不该再发')
  assert.equal(shouldFlush(buffer, 16000, { minMs: 15000 }), true)
  assert.equal(shouldFlush({ ...buffer, lastFlush: 1000, texts: [] }, 999999), false, '空内容不发')
  assert.equal(shouldFlush({ ...buffer, lastFlush: 1000 }, 1200, { final: true }), true, '结束要强制发')
})

test('createFeedBuffer：攒事件 → 发一条 → 清空；turn/end 立刻发并带结束标记', () => {
  const posted = []
  const feed = createFeedBuffer((sessionId, snapshot) => posted.push({ sessionId, ...snapshot }))

  feed.push('studio-t-1-dev', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一步' }], source: { provider: 'p', model: 'm1' } } } }, { taskId: 't-1', expertId: 'dev' })
  assert.equal(posted.length, 0, '刚收事件不该立刻发（节流）')
  assert.equal(feed.modelOf('studio-t-1-dev'), 'p/m1')

  const snapshot = feed.take('studio-t-1-dev', Date.now())
  assert.equal(snapshot.taskId, 't-1')
  assert.match(snapshot.body, /第一步/)
  assert.equal(feed.take('studio-t-1-dev', Date.now()), null, '发过一次就清空')

  feed.push('studio-t-1-dev', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '收尾' }], source: { provider: 'p', model: 'm1' } } } }, { taskId: 't-1', expertId: 'dev' })
  feed.push('studio-t-1-dev', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, { taskId: 't-1', expertId: 'dev' })
  assert.equal(posted.length, 1, 'turn/end 要立刻发')
  assert.match(posted[0].body, /本轮结束/)
})

test('createFeedBuffer：flushAll 只发攒够的会话', () => {
  const posted = []
  const feed = createFeedBuffer((sessionId, snapshot) => posted.push({ sessionId, ...snapshot }))
  feed.push('studio-t-2-dev', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'A' }], source: {} } } }, { taskId: 't-2', expertId: 'dev' })
  feed.flushAll(Date.now())
  assert.equal(posted.length, 0, '没到 15 秒不发')
  feed.flushAll(Date.now() + 20_000)
  assert.equal(posted.length, 1)
  assert.equal(feed.sessions().length, 1)
  feed.drop('studio-t-2-dev')
  assert.equal(feed.size(), 0)
})

test('approvalNote：解释为什么拒绝，并告诉人怎么放行', () => {
  const note = approvalNote({ toolName: 'plugin_manager', reason: 'escalate sandbox to danger-full-access' })
  assert.match(note, /plugin_manager/)
  assert.match(note, /自动拒绝/)
  assert.match(note, /escalate sandbox/)
  assert.match(note, /设置 → 自动派单|手动跑/, '要给出放行办法')
})

test('执行播报：一个会话只建一条评论，后续更新同一条', async () => {
  const added = []
  const updated = []
  const store = { snapshot: () => ({ config: { experts: [{ id: 'dev', name: '研发' }] } }) }
  const commentTask = async (s, taskId, body, author, kind) => {
    added.push(body)
    const created = { id: 'c-feed1', body, author, kind }
    return { task: { comments: [created] } }
  }
  const updateTaskComment = async (s, taskId, id, body) => { updated.push({ id, body }) }
  const push = createFeedComments({ store, commentTask, updateTaskComment })
  push('s1', { taskId: 't1', expertId: 'dev', body: '第一段' })
  await new Promise(resolve => setTimeout(resolve, 10))
  push('s1', { taskId: 't1', expertId: 'dev', body: '第二段' })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(added.length, 1, '只建一条')
  assert.equal(updated.length, 1, '后续更新同一条')
  assert.equal(updated[0].id, 'c-feed1')
  assert.match(updated[0].body, /第一段[\s\S]*第二段/)
})
