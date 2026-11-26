/* 派单会话的「执行播报」落库：一个会话只占一条评论，后续增量更新同一条。
 *
 * 以前每个 flush（15 秒 / 每轮结束）都 append 一条，长会话能把卡的讨论区刷到几十上百条
 * （2026-11-26 真机 64 条），真正的讨论被埋掉。现在：
 *   · 第一次：建一条评论，记住它的 id；
 *   · 之后：updateTaskComment 更新同一条，正文按 `---` 分段累积（上限 12000 字，超了留尾部）。
 * 播报仍带「派单会话自动播报」标记，不冒充人的讨论。
 */

export const FEED_BODY_CAP = 12000

/**
 * @param {object} deps
 * @param {object} deps.store            StudioStore（只用 snapshot）
 * @param {Function} deps.postComment    commentTask(store, taskId, body, author, kind)
 * @param {Function} deps.updateTaskComment updateTaskComment(store, taskId, commentId, body, by)
 * @returns {(sessionId: string, snapshot: { taskId: string, expertId: string, body: string }) => void}
 */
export function createFeedComments({ store, postComment, updateTaskComment, cap = FEED_BODY_CAP }) {
  const seen = new Map()
  return (sessionId, snapshot) => {
    if (snapshot === null || snapshot === undefined || String(snapshot.taskId ?? '') === '') return
    const experts = store.snapshot()?.config?.experts ?? []
    const expert = experts.find(entry => entry.id === snapshot.expertId)
    const author = String(expert?.name ?? snapshot.expertId ?? 'AI')
    const previous = seen.get(sessionId)
    const merged = previous === undefined ? snapshot.body : `${previous.body}\n\n---\n\n${snapshot.body}`
    const body = merged.length > cap ? `…（前面省略）\n\n${merged.slice(-cap)}` : merged
    if (previous === undefined) {
      void postComment(store, snapshot.taskId, body, author, 'agent').then(result => {
        const created = (result?.task?.comments ?? []).slice(-1)[0]
        if (created !== undefined) seen.set(sessionId, { taskId: snapshot.taskId, id: created.id, body })
      }).catch(() => {})
      return
    }
    void updateTaskComment(store, previous.taskId, previous.id, body, author).then(() => {
      seen.set(sessionId, { ...previous, body })
    }).catch(() => {
      /* 评论被删/改了：下一条重新建，不在这里反复重试。 */
      seen.delete(sessionId)
    })
  }
}
