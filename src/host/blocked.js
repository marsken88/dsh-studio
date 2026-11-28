// 「阻塞」只保留一个口径：**未完成且挂着阻塞标记**。
//
// 为什么要单独一个模块：同一份快照里这个数曾经有 3 个口径 ——
//   工作台只算未完成（0）、看板算全量（1，把已完成的卡也算进来）、
//   发布门禁算全量（1）→ 出现「3/3 卡完成、未完成 0、阻塞 1」这种永远发不出去的版本。
// 「阻塞」是「这活儿卡住了」，已完成的卡不再卡住任何人；残留在已完成卡上的标记应当提示清掉，而不是拦路。

/** 这张卡是不是「未完成且挂阻塞」。任务已完成（done）不算。 */
export function isOpenBlocked(task) {
  if (task === null || task === undefined) return false
  if (task.blocked === null || task.blocked === undefined) return false
  return String(task.status ?? '') !== 'done'
}

/** 卡上还挂着阻塞标记、但任务已经完成 —— 不拦路，值得提示清掉。 */
export function isStaleBlocked(task) {
  if (task === null || task === undefined) return false
  if (task.blocked === null || task.blocked === undefined) return false
  return String(task.status ?? '') === 'done'
}

/** 给出「未完成且挂阻塞」的卡；doneStatuses 兼容自定义完成列。 */
export function openBlockedOf(tasks, doneStatuses = ['done']) {
  const done = new Set(doneStatuses.map(String))
  return (Array.isArray(tasks) ? tasks : []).filter(task =>
    task !== null && task !== undefined
    && task.blocked !== null && task.blocked !== undefined
    && !done.has(String(task.status ?? '')))
}

/** 已完成却还挂着阻塞标记的卡。 */
export function staleBlockedOf(tasks, doneStatuses = ['done']) {
  const done = new Set(doneStatuses.map(String))
  return (Array.isArray(tasks) ? tasks : []).filter(task =>
    task !== null && task !== undefined
    && task.blocked !== null && task.blocked !== undefined
    && done.has(String(task.status ?? '')))
}

export const STALE_BLOCKED_NOTE = '已完成卡上还挂着阻塞标记，不拦路，建议清掉'
