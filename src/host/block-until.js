/* 条件型阻塞：阻塞时记下「在等什么」，条件满足就由系统自动解除。
 *
 * 以前 `blocked` 只有 `{ by, at, reason }`，原因是一段自由文本。于是「等人工签字」
 * 「先收口子卡」这类**可机器判断**的等待，人签完了、子卡全完了，标记还挂着，必须人再
 * 点一次「解除」（2026-11-26 真机：BUG-001 人工签完仍被判「还挂着阻塞标记」）。
 *
 * 现在：阻塞可带 `until` 条件码；只有 `by` 是 agent / 系统 的阻塞才会自动解除 ——
 * 人亲手挂的阻塞（`by` 是一个人名）永远等人自己点，平台不替人做决定。
 * 老数据没有 `until` 时按 reason 关键字补判一次，不改存量记录。
 */

export const BLOCK_UNTIL = ['human-signoff', 'sub-cards-done']

export const BLOCK_UNTIL_LABEL = {
  'human-signoff': '人工验收签字',
  'sub-cards-done': '子卡全部完成',
}

const AUTO_BY = ['agent', '系统']

/** 从 reason 里认出条件（老数据没有 until 时的一次性补判；宁可认不出，也不误自动解除）。 */
const INFER = [
  [/人工签字|人工验收签字|AI 签字|准出只认人/i, 'human-signoff'],
  [/先收口子卡|子卡没完成|子卡未完成|子卡还没/i, 'sub-cards-done'],
]

/** 这条阻塞在等什么？没写条件就是 ''（纯人工判断，不自动解除）。 */
export function blockUntilOf(task) {
  const explicit = String(task?.blocked?.until ?? '')
  if (BLOCK_UNTIL.includes(explicit)) return explicit
  const reason = String(task?.blocked?.reason ?? '')
  for (const [pattern, code] of INFER) {
    if (pattern.test(reason)) return code
  }
  return ''
}

/** 自动解除只对 agent / 系统 挂的阻塞生效；人挂的阻塞一律返回 false。 */
export function autoUnblockEligible(task) {
  const by = String(task?.blocked?.by ?? '')
  return AUTO_BY.includes(by)
}

/** 等待条件现在满足了吗？ */
export function blockUntilMet(task, tasks = []) {
  const code = blockUntilOf(task)
  if (code === '') return false
  if (code === 'human-signoff') {
    const sign = task?.signoff ?? null
    /* 只认 actorKind=human：AI 代签（agent）不算，与准出门禁同一口径。 */
    return sign !== null && String(sign.actorKind ?? '') === 'human'
  }
  if (code === 'sub-cards-done') {
    const children = (Array.isArray(tasks) ? tasks : []).filter(item => item?.parent === task?.id)
    return children.length > 0 && children.every(item => item.status === 'done')
  }
  return false
}

/** 该不该自动解除？（条件码存在 + agent/系统 挂的 + 条件已满足） */
export function shouldAutoUnblock(task, tasks = []) {
  if (task?.blocked === null || task?.blocked === undefined) return false
  if (!autoUnblockEligible(task)) return false
  return blockUntilMet(task, tasks)
}

/** 自动解除时写进历史的说明。 */
export function autoUnblockNote(task) {
  const code = blockUntilOf(task)
  if (code === '') return '系统自动解除阻塞：等待条件已满足'
  return `系统自动解除阻塞：${BLOCK_UNTIL_LABEL[code] ?? code}已满足`
}
