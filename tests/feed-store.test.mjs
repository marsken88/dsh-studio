// 执行播报不再写评论：落到 task.feed（有界），/state 只下行最近几条。
import assert from 'node:assert/strict'
import test from 'node:test'

import { createBroadcast, createFeedStore, publicFeed } from '../src/host/feed-store.js'

const makeStore = initial => {
  const state = { config: { agents: { broadcast: 'feed' } }, tasks: initial }
  return {
    state,
    snapshot: () => state,
    mutate: async fn => { fn(state); return state },
  }
}

test('createFeedStore：写进 task.feed 并只保留最近 N 条', async () => {
  const store = makeStore([{ id: 't1', feed: [] }])
  const push = createFeedStore({ store, keep: 3 })
  for (let i = 0; i < 5; i += 1) push('studio-t1-x', { taskId: 't1', expertId: 'e1', body: `第 ${i} 段` })
  const feed = store.state.tasks[0].feed
  assert.equal(feed.length, 3, '超出 keep 的丢掉')
  assert.match(feed[2].text, /第 4 段/)
  assert.equal(feed[2].expert, 'e1')
  assert.ok(feed[2].at > 0)
})

test('createFeedStore：没有正文 / 卡不存在时什么都不写（不抛）', async () => {
  const store = makeStore([{ id: 't1', feed: [] }])
  const push = createFeedStore({ store })
  push('s', { taskId: 't1', expertId: 'e', body: '   ' })
  push('s', { taskId: 'nope', expertId: 'e', body: 'x' })
  assert.deepEqual(store.state.tasks[0].feed, [])
})

test('createBroadcast：mode=feed 不进评论 / comment 走评论 / off 两边都不写', async () => {
  const comments = []
  const store = makeStore([{ id: 't1', feed: [] }])
  const commentTask = async (_s, id, body, author) => { comments.push({ id, body, author }) }
  const broadcast = createBroadcast({ store, postComment: commentTask })
  broadcast('s1', { taskId: 't1', expertId: 'e', body: 'feed 模式' })
  assert.equal(comments.length, 0, 'feed 模式不该写评论')
  assert.equal(store.state.tasks[0].feed.length, 1)

  store.state.config.agents.broadcast = 'comment'
  broadcast('s2', { taskId: 't1', expertId: 'e', body: 'comment 模式' })
  assert.equal(comments.length, 1, 'comment 模式仍然写评论')

  store.state.config.agents.broadcast = 'off'
  broadcast('s3', { taskId: 't1', expertId: 'e', body: 'off 模式' })
  assert.equal(comments.length, 1, 'off 模式不再写评论')
})

test('publicFeed：只下行最近几条并截断文本，另给总数', () => {
  const task = {
    feed: Array.from({ length: 9 }, (_, i) => ({ at: i + 1, expert: '支付产品经理', text: 'x'.repeat(2000) })),
  }
  const out = publicFeed(task)
  assert.equal(out.feed.length, 5, '默认只给最近 5 条')
  assert.equal(out.feedCount, 9)
  assert.equal(out.feed[0].text.length, 600, '文本截到 600')
  assert.deepEqual(publicFeed({}).feed, [], '没有播报时是空数组')
})
