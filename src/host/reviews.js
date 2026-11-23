// 需求评审 / 设计评审 / 引用归一化：HTTP 路由和 studio_* 工具共用这一份。
//
// 为什么单独一个模块：这两件事以前只写在路由里，agent 只能绕 HTTP 去做（issue #9 第 4 条）。
// 抽出来之后工具与路由走同一条逻辑，行为不会两边漂。
import {
  applyFidelityItem,
  applySpecItem,
  pushDiffHistory,
  sanitizeDesign,
} from './design.js'
import { isSelfReview } from './quality.js'

/** 需求引用归一化：认内部 id（`req-078f16`）也认编号（`REQ-2026-001`）。
 *
 *  以前写路径不归一化：`requirementId:"REQ-2026-002"` 被原样存成外键，卡变成脏引用，
 *  需求汇总显示「卡 0/0」——不报错，只是统计悄悄错（issue #9 第 2 条）。
 */
export function resolveRequirement(state, ref) {
  const value = String(ref ?? '').trim()
  if (value === '') return undefined
  const list = Array.isArray(state?.requirements) ? state.requirements : []
  const lower = value.toLowerCase()
  return list.find(item => item.id === value)
    ?? list.find(item => String(item.code ?? '').toLowerCase() === lower)
    ?? undefined
}

/** 归一化失败时给人看的下一步：把可用的引用列出来，别只说「找不到」。 */
export function requirementRefHint(state, ref) {
  const list = (Array.isArray(state?.requirements) ? state.requirements : [])
    .slice(0, 8)
    .map(item => `${item.code || item.id}（${item.id}）`)
  return `找不到需求「${String(ref ?? '').trim()}」。可用的有：${list.join('、') || '（还没有需求）'}；`
    + '编号形如 REQ-2026-001，内部 id 形如 req-078f16 —— 两个都能传，会自动归一。'
}

/** 需求评审：submit（提交评审）/ approve（通过）/ reject（打回）。 */
export async function reviewRequirement(store, { id, decision = 'approve', by = '人', note = '' }) {
  const snapshot = store.snapshot()
  const target = resolveRequirement(snapshot, id)
  if (target === undefined) throw new Error(requirementRefHint(snapshot, id))
  const action = String(decision ?? 'approve')
  if (!['submit', 'approve', 'reject'].includes(action)) throw new Error('未知的评审动作：submit / approve / reject')
  if (action === 'reject' && String(note ?? '').trim() === '') throw new Error('打回要说清楚哪里不行，写一句评审意见')
  const actor = String(by ?? '人').slice(0, 60) || '人'
  await store.mutate(state => {
    const found = state.requirements.find(item => item.id === target.id)
    if (found === undefined) return
    const now = Date.now()
    if (action === 'submit') {
      found.status = 'review'
      found.review = { status: 'pending', by: actor, at: now, note: String(note ?? '').slice(0, 600) }
    } else if (action === 'approve') {
      found.status = found.status === 'closed' ? 'closed' : 'active'
      found.review = { status: 'approved', by: actor, at: now, note: String(note ?? '').slice(0, 600) }
    } else {
      found.status = 'draft'
      found.review = { status: 'changes_requested', by: actor, at: now, note: String(note ?? '').slice(0, 600) }
    }
    found.updatedAt = now
  })
  return store.snapshot().requirements.find(item => item.id === target.id)
}

/** 设计评审 / 多稿定案：合并而不是覆盖（只带 diff 的调用不该把 link/status 抹掉）。 */
export async function saveTaskDesign(store, taskId, incoming, by = '人') {
  const patch = incoming !== null && typeof incoming === 'object' ? { ...incoming } : {}
  const actor = String(by ?? '人').slice(0, 40)
  let design = null
  /* 每一稿的作者：新稿没写 by 就记成这次提交的人 —— 评审时才能判断是不是自审。 */
  if (Array.isArray(patch.drafts)) {
    patch.drafts = patch.drafts.map(item => (item !== null && typeof item === 'object' && String(item.by ?? '').trim() === ''
      ? { ...item, by: actor }
      : item))
  }
  const before = store.snapshot().tasks.find(entry => entry.id === String(taskId ?? ''))
  if (before === undefined) throw new Error(`no task ${taskId}`)
  /* 自审不能当评审通过：这次提交是在下 approved、而稿子全是同一个人放的，就直接拒绝。
     设计评审的价值在「另一个人看过」，自己写稿自己批等于没有评审（四棒接力真机踩过）。 */
  if (String(patch.status ?? '') === 'approved') {
    const current = sanitizeDesign(before.design)
    const drafts = patch.drafts !== undefined ? patch.drafts : (current?.drafts ?? [])
    const authors = [...new Set(drafts.map(item => String(item?.by ?? '').trim()).filter(Boolean))]
    if (authors.length > 0 && authors.every(name => isSelfReview(name, actor))) {
      throw new Error(`设计不能自审：这 ${drafts.length} 稿都是「${actor}」放的。评审结论要另一个专家或人来下（例如 @架构师 代评审，或用面板以「人」的身份通过），通过后再定案推进`)
    }
  }
  await store.mutate(state => {
    const task = state.tasks.find(entry => entry.id === String(taskId ?? ''))
    if (task === undefined) throw new Error(`no task ${taskId}`)
    const merged = sanitizeDesign({ ...(task.design ?? {}), ...patch, by: actor, at: Date.now() })
    if (merged !== null && merged.diff !== null) merged.diffHistory = pushDiffHistory(task.design?.diffHistory ?? [], merged.diff)
    const chosenBefore = String(task.design?.chosenId ?? '')
    design = merged
    task.design = design
    // 还原度顺手写进验收清单：验收时不用再回抽屉里找数字。
    if (design !== null && design.diff !== null) task.checklist = applyFidelityItem(task.checklist, design.diff.percent)
    if (design !== null && design.spec !== null) task.checklist = applySpecItem(task.checklist, design.spec)
    // 定案是一次决定，不只是改个字段：谁在哪天选了哪一稿要能查。
    if (design !== null && design.chosenId !== '' && design.chosenId !== chosenBefore) {
      const picked = (design.drafts ?? []).find(item => item.id === design.chosenId)
      task.history.push({ at: Date.now(), by: actor, status: task.status, note: `设计定案：${picked?.name ?? design.chosenId}` })
    }
    task.updatedAt = Date.now()
    task.history.push({ at: task.updatedAt, by: actor, status: task.status, note: `设计评审：${design?.status ?? 'pending'}` })
  })
  return design
}
