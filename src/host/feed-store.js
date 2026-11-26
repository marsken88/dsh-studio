/* 播报落点：feed（默认，卡上的「执行播报」）/ comment（旧行为，写评论）/ off。
 * 每次 flush 现读配置，所以设置里改完立刻生效，不用重启。 */
export function createBroadcast({ store, postComment }) {
  const toComments = createFeedComments({ store, postComment, updateTaskComment })
  const toTask = createFeedStore({ store })
  return (sessionId, snapshot) => {
    const mode = String(store.snapshot()?.config?.agents?.broadcast ?? 'feed')
    if (mode === 'off') return
    if (mode === 'comment') return toComments(sessionId, snapshot)
    return toTask(sessionId, snapshot)
  }
}

/* 派单会话的「执行播报」落到卡上（不进讨论区）。
 *
 * 为什么不再写评论：播报是**机器进度**（每 15 秒一次的工具/模型流水），不是人的讨论。
 * 2026-11-26 真机：一张卡的讨论区被播报占满（64 条），真正的人话被埋掉了。现在：
 *   · 播报写进 `task.feed`（有界数组，默认只留最近 20 条）；
 *   · 讨论区只留人和专家的评论；
 *   · `/state` 只下行最近几条（文本再截断），抽屉点开「执行记录 → 执行播报」看详情。
 * 想恢复旧行为（写评论）或彻底关掉，见 `config.agents.broadcast`（feed | comment | off）。
 */

import { updateTaskComment } from './comments.js'
import { createFeedComments } from './feed-comments.js'

export const FEED_KEEP = 20
export const FEED_TEXT_MAX = 2000

/**
 * @param {object} deps
 * @param {object} deps.store  StudioStore（只用 mutate）
 * @param {number} [deps.keep] 保留最近多少条
 * @returns {(sessionId: string, snapshot: { taskId: string, expertId: string, body: string }) => void}
 */
export function createFeedStore({ store, keep = FEED_KEEP, textMax = FEED_TEXT_MAX } = {}) {
  return (sessionId, snapshot) => {
    if (snapshot === null || snapshot === undefined) return
    const taskId = String(snapshot.taskId ?? '')
    if (taskId === '') return
    const text = String(snapshot.body ?? '').trim()
    if (text === '') return
    void store.mutate(state => {
      const task = state.tasks.find(item => item.id === taskId)
      if (task === undefined) return
      const list = Array.isArray(task.feed) ? task.feed : []
      list.push({
        at: Date.now(),
        session: String(sessionId ?? '').slice(0, 80),
        expert: String(snapshot.expertId ?? '').slice(0, 40),
        text: text.slice(0, textMax),
      })
      task.feed = list.slice(-keep)
      task.updatedAt = Date.now()
    }).catch(() => { /* 播报失败不能影响会话本身 */ })
  }
}

/** `/state` 下行的形状：只给最近几条 + 计数，文本再截一刀（75 张卡轮询不能搬几 MB）。 */
export function publicFeed(task, { show = 5, textMax = 600 } = {}) {
  const list = Array.isArray(task?.feed) ? task.feed : []
  return {
    feed: list.slice(-show).map(item => ({
      at: Number(item?.at) || 0,
      expert: String(item?.expert ?? ''),
      text: String(item?.text ?? '').slice(0, textMax),
    })),
    feedCount: list.length,
  }
}
