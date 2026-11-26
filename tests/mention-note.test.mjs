// 评审备注里的 @：以前只有「评论」解析 @，评审备注写的 @开发工程师 根本没人被叫起来。
import assert from 'node:assert/strict'
import test from 'node:test'

import { publishNoteMentions, stripQuotedCode } from '../src/host/mention-note.js'
import { parseMentions } from '../src/host/dispatcher.js'

const config = {
  experts: [
    { id: 'architect', name: '架构师', enabled: true },
    { id: 'dev', name: '开发工程师', enabled: true },
    { id: 'qa', name: '测试工程师', enabled: true },
  ],
  teams: [],
}

test('stripQuotedCode：围栏代码块与行内代码里的 @ 不算点名', () => {
  assert.equal(stripQuotedCode('看 @架构师').includes('@架构师'), true, '普通文本保留')
  assert.equal(stripQuotedCode('```\n@架构师\n```').includes('@架构师'), false, '围栏代码块要去掉')
  assert.equal(stripQuotedCode('`@架构师`').includes('@架构师'), false, '行内代码要去掉')
  assert.equal(stripQuotedCode('```\n未闭合的代码块 @架构师').includes('@架构师'), false, '未闭合也要去掉')
})

test('parseMentions：引用代码块里的 @ 不再触发派单（开发工程师踩过重复派单）', () => {
  assert.equal(parseMentions('请避免像 ```\n@开发工程师\n``` 这样写', config).length, 0)
  assert.equal(parseMentions('请避免像 `@开发工程师` 这样写', config).length, 0)
  assert.deepEqual(parseMentions('@开发工程师 这里要改', config).map(m => m.name), ['开发工程师'])
})

test('parseMentions：四位专家的名字都能命中，短写唯一命中、歧义不命中，全角 @ 也命中', () => {
  for (const expert of config.experts) {
    assert.equal(parseMentions(`@${expert.name} 看一下`, config).length, 1, expert.name)
  }
  /* 2026-11-26 放宽：短写只要**唯一**能对上某位专家的名字就算命中（真机 @产品经理 对 支付产品经理）。 */
  assert.deepEqual(parseMentions('@架构 看一下', config).map(m => m.name), ['架构师'], '短写唯一命中')
  /* issue #156：中文输入法默认打出来的就是全角 ＠，以前静默失效（只认半角）。 */
  assert.equal(parseMentions('＠架构师', config).length, 1, '全角 ＠ 也要命中')
  assert.equal(parseMentions('＠开发工程师 看下', config).length, 1, '全角 ＠ 也要命中')
  const ambiguous = { experts: [...config.experts, { id: 'arch2', name: '架构师助理', enabled: true }], teams: [] }
  assert.equal(parseMentions('@架构 看一下', ambiguous).length, 0, '命中多个就当歧义，不派')
})

const makeStore = () => ({ snapshot: () => ({ config }) })

test('publishNoteMentions：备注补成评论，并逐个派单', async () => {
  const comments = []
  const dispatched = []
  const out = await publishNoteMentions({
    store: makeStore(),
    commentTask: async (store, id, body, by) => { comments.push({ id, body, by }) },
    dispatcher: { dispatchMention: async (taskId, mention) => { dispatched.push(`${taskId}:${mention.name}`) } },
    parseMentions,
  }, { taskId: 't-1', note: '@开发工程师 这里要改：pointId 没继承', by: '架构师' })
  assert.equal(comments.length, 1, '评审意见要能在讨论区看到')
  assert.match(comments[0].body, /评审意见（架构师）/)
  assert.deepEqual(out.mentions.map(m => m.name), ['开发工程师'])
  assert.deepEqual(dispatched, ['t-1:开发工程师'])
})

test('publishNoteMentions：没有 @ 的普通备注也补成评论，但不派单', async () => {
  const dispatched = []
  const out = await publishNoteMentions({
    store: makeStore(),
    commentTask: async () => {},
    dispatcher: { dispatchMention: async () => { dispatched.push('x') } },
    parseMentions,
  }, { taskId: 't-1', note: '评审通过，可以进测试', by: '架构师' })
  assert.equal(out.commented, true)
  assert.equal(dispatched.length, 0)
})

test('publishNoteMentions：备注为空什么都不做（不刷空评论）', async () => {
  let called = false
  const out = await publishNoteMentions({
    store: makeStore(),
    commentTask: async () => { called = true },
    dispatcher: {},
    parseMentions,
  }, { taskId: 't-1', note: '   ', by: '架构师' })
  assert.equal(called, false)
  assert.deepEqual(out.mentions, [])
})

test('publishNoteMentions：派单失败要如实记下来，不吞掉', async () => {
  const out = await publishNoteMentions({
    store: makeStore(),
    commentTask: async () => {},
    dispatcher: { dispatchMention: async () => { throw new Error('额度不足') } },
    parseMentions,
  }, { taskId: 't-1', note: '@架构师 看一下', by: '开发工程师' })
  assert.equal(out.dispatched.length, 1)
  assert.match(out.dispatched[0], /failed.*额度不足/)
})

test('publishNoteMentions：commentMode=mentions 时，没 @ 就不补评论（签字/清单备注本来就在卡上）', async () => {
  let commented = false
  const out = await publishNoteMentions({
    store: makeStore(),
    commentTask: async () => { commented = true },
    dispatcher: {},
    parseMentions,
  }, { taskId: 't-1', note: '验收通过，功能符合预期', by: '张三', commentMode: 'mentions' })
  assert.equal(commented, false, '普通签字结论不该被复制成评论')
  assert.equal(out.commented, false)

  const withMention = await publishNoteMentions({
    store: makeStore(),
    commentTask: async () => { commented = true },
    dispatcher: { dispatchMention: async () => {} },
    parseMentions,
  }, { taskId: 't-1', note: '遗留：库存回滚没覆盖 @开发工程师 跟进', by: '张三', commentMode: 'mentions' })
  assert.equal(withMention.commented, true, '真 @ 了人才补评论')
  assert.deepEqual(withMention.mentions.map(m => m.name), ['开发工程师'])
})

test('publishNoteMentions：评论标题用调用方给的 label（签字不该被标成「评审意见」）', async () => {
  const bodies = []
  await publishNoteMentions({
    store: makeStore(),
    commentTask: async (store, id, body) => { bodies.push(body) },
    dispatcher: { dispatchMention: async () => {} },
    parseMentions,
  }, { taskId: 't-1', note: '@开发工程师 跟进', by: '张三', label: '验收签字' })
  assert.match(bodies[0], /验收签字（张三）/, '标题要跟着来源走')
  assert.equal(/评审意见/.test(bodies[0]), false)
})
