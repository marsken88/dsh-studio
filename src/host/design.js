// 设计评审（一期）：卡上的设计状态 + 「进开发前必须评审过」的闸门。纯函数，方便单测。

export const DESIGN_STATUS = ['pending', 'approved', 'changes_requested']

/** 设计区：链接、评审状态、评审意见。没填过就是 null。 */
export function sanitizeDesign(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  const status = DESIGN_STATUS.includes(String(raw.status ?? '')) ? String(raw.status) : 'pending'
  return {
    link: String(raw.link ?? '').trim().slice(0, 500),
    status,
    note: String(raw.note ?? '').slice(0, 500),
    by: String(raw.by ?? '').slice(0, 40),
    at: Number(raw.at) || 0,
    // 设计还原度：tools/visual/design-diff.mjs 算出来的差异百分比（0 = 一模一样）。
    diff: raw.diff === null || raw.diff === undefined || typeof raw.diff !== 'object'
      ? null
      : {
        percent: Math.min(100, Math.max(0, Number(raw.diff.percent) || 0)),
        url: String(raw.diff.url ?? '').slice(0, 500),
        at: Number(raw.diff.at) || 0,
        by: String(raw.diff.by ?? '').slice(0, 40),
      },
  }
}

/** 还原度低于这个值就算没还原。 */
export const FIDELITY_TARGET = 95

/**
 * 把还原度写进验收清单：找到「设计还原度」那一行就更新，没有就补一行。
 * 低于 FIDELITY_TARGET 就留成未勾——验收时人一眼能看到差在哪。
 */
export function applyFidelityItem(checklist, percent) {
  const list = Array.isArray(checklist) ? checklist : []
  const score = Math.max(0, 100 - (Number(percent) || 0))
  const text = `设计还原度 ≥ ${FIDELITY_TARGET}%（当前 ${score.toFixed(1)}%）`
  const index = list.findIndex(item => String(item?.text ?? '').startsWith('设计还原度'))
  const item = { id: index >= 0 ? list[index].id : `k-fidelity-${Date.now().toString(36)}`, text, done: score >= FIDELITY_TARGET }
  if (index >= 0) list[index] = { ...list[index], ...item }
  else list.push(item)
  return list
}

/**
 * 进开发前的闸门：只有开了开关、且目标列在 columns 里才拦。
 * 返回 { needed, ready, blockers }；override 在调用方处理（填了原因就放行）。
 */
export function designGate(config, task, nextStatus) {
  const design = config?.design ?? {}
  const columns = Array.isArray(design.columns) && design.columns.length > 0 ? design.columns : ['dev']
  const needed = design.enabled === true && columns.includes(String(nextStatus ?? ''))
  if (needed !== true) return { needed: false, ready: true, blockers: [] }
  const state = String(task?.design?.status ?? '')
  if (state === 'approved') return { needed: true, ready: true, blockers: [] }
  const label = { pending: '还没评审', changes_requested: '评审要求修改' }[state] ?? '还没有设计记录'
  return { needed: true, ready: false, blockers: [`设计${label}：先把设计稿放进卡片并让评审通过（或填 override 说明原因）`] }
}
