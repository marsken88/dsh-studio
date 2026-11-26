/* 验收条件（纯函数）：功能点上的一行行「怎么算做到」，是整条链的锚点。
 *
 * 它连着三处：
 *   1. 拆卡 —— 功能点的验收条件要原样变成卡的验收清单（以前铺的是按类型的通用模板，勾完跟验收无关）
 *   2. 用例 —— 每条用例可以挂一条验收条件（acceptanceId）
 *   3. 矩阵 —— 只有挂在某条条件上的**通过**用例才算覆盖它
 *
 * 放在独立模块是为了不把 domain.js 顶过 2000 行闸门，也方便单测直接验这三段。
 */

export function sanitizeAcceptanceItem(raw, index) {
  if (raw === null || raw === undefined) return undefined
  const source = typeof raw === 'string' ? { text: raw } : raw
  const text = String(source.text ?? '').trim().slice(0, 300)
  if (text.length === 0) return undefined
  /* 证据型条件：有些验收条件天生没法写成可执行用例（评审结论、测试报告、产品验收记录…），
     它们由交付物证明。声明了 evidence.kind 的条件按「该功能点上有这种交付物且已交付」判覆盖；
     没声明的一律仍按「挂着它的通过用例」判，口径不变。 */
  const evidenceKind = String(source.evidence?.kind ?? source.evidenceKind ?? '').trim().slice(0, 24)
  const evidenceNote = String(source.evidence?.note ?? '').trim().slice(0, 200)
  const item = {
    id: String(source.id ?? `a${index + 1}`).trim().slice(0, 24) || `a${index + 1}`,
    text,
    done: source.done === true,
  }
  const evidenceMatch = String(source.evidence?.match ?? source.evidenceMatch ?? '').trim().slice(0, 60)
  if (evidenceKind !== '') {
    item.evidence = {
      kind: evidenceKind,
      /* match：交付物标题里必须出现的词（「架构评审」「测试报告」「产品验收」…）。
         不给 match 就只按 kind 判——同一功能点上报告有好几份时会一网打尽，所以能用就给。 */
      ...(evidenceMatch !== '' ? { match: evidenceMatch } : {}),
      ...(evidenceNote !== '' ? { note: evidenceNote } : {}),
    }
  }
  return item
}

/** 拆卡时用：把功能点的验收条件变成卡的验收清单（id 保持一致，矩阵才认得出）。 */
export function checklistFromAcceptance(acceptance) {
  const list = Array.isArray(acceptance) ? acceptance : []
  return list
    .map((item, index) => sanitizeAcceptanceItem(item, index))
    .filter(item => item !== undefined)
    .map(item => ({ id: item.id, text: item.text.slice(0, 200), done: false, by: '', at: 0, note: '' }))
}

/** 澄清卡固定要求「先检索历史」的那一项（REQ-2026-001 / p3）。
 *
 * 为什么必须落成清单项：派单提示词只是软约束，准出闸门（executor.taskExitGate）
 * 只拦「清单还有 N 项没勾」——只写提示词的话，模型跳过检索，卡也照样能推走。
 *
 * 三种情况不加：不是澄清列；清单里已经有人写了带「检索」的验收条件（拆卡继承的优先）；
 * 清单已到 30 条上限（sanitizeChecklist 的上限），加了也会被截掉。
 * 返回新数组，不改入参。
 */
export const CLARIFY_HISTORY_ITEM_ID = 'c-history'

export function withClarifyHistoryItem(checklist, status) {
  const list = Array.isArray(checklist) ? checklist : []
  const next = list.slice()
  if (status !== 'clarify') return next
  if (next.length >= 30) return next
  if (next.some(item => String(item?.id ?? '') === CLARIFY_HISTORY_ITEM_ID)) return next
  if (next.some(item => String(item?.text ?? '').includes('检索'))) return next
  next.push({
    id: CLARIFY_HISTORY_ITEM_ID,
    text: '已检索历史结论（命中写清沿用/推翻，没命中写「已检索，无命中」）',
    done: false,
    by: '',
    at: 0,
    note: '',
  })
  return next
}

/* 卡上的清单项与它挂的功能点（需求的 acceptance）是两处：拆卡时复制过去，之后各写各的。
   真机上就出现过产品在卡上补了 8 条清单、需求里 p2 仍然是 0 条验收——协作链如实标黄
   「产品待补齐」，需求级准出也被拦（2026-11-26 .218）。 */

const normText = value => String(value ?? '').replace(/\s+/g, '').toLowerCase()

/** 卡上新增的清单项回写到它挂的功能点。返回是否真的写进去了（重复/没挂功能点 → false）。 */
export function appendPointAcceptance(state, task, text) {
  const requirementId = String(task?.requirementId ?? '')
  const pointId = String(task?.pointId ?? '')
  const clean = String(text ?? '').trim().slice(0, 200)
  if (requirementId === '' || pointId === '' || clean === '') return false
  const requirement = (state?.requirements ?? []).find(item => String(item?.id ?? '') === requirementId)
  if (requirement === undefined) return false
  const point = (requirement.points ?? []).find(item => String(item?.id ?? '') === pointId)
  if (point === undefined) return false
  const list = Array.isArray(point.acceptance) ? point.acceptance : []
  if (list.some(item => normText(item?.text) === normText(clean))) return false
  point.acceptance = [...list, { id: `a${list.length + 1}`, text: clean }].slice(0, 30)
  requirement.updatedAt = Date.now()
  return true
}

/** 这张卡挂的功能点在需求里有没有验收条件？没有就返回一句提醒（准出 warning，不是 blocker）。 */
export function pointAcceptanceGap(state, task) {
  const requirementId = String(task?.requirementId ?? '')
  const pointId = String(task?.pointId ?? '')
  if (requirementId === '' || pointId === '') return ''
  const requirement = (state?.requirements ?? []).find(item => String(item?.id ?? '') === requirementId)
  const point = (requirement?.points ?? []).find(item => String(item?.id ?? '') === pointId)
  if (point === undefined) return ''
  const count = (Array.isArray(point.acceptance) ? point.acceptance : []).filter(item => String(item?.text ?? '').trim() !== '').length
  if (count > 0) return ''
  return `功能点 ${pointId} 在需求里还没有验收条件（协作链会标黄「产品待补齐」，需求级准出也会拦）：让产品在需求页补一条，或在本卡清单上补（会自动回写到功能点）`
}
