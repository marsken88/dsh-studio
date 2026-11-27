import { isAiSignoff } from './intervention.js'

// 绕过准出的记录：以前只写进 history 的一句话，需求准出看不到。
/** 绕过准出的清单：卡级 task.override + 需求级 requirement.override。
 *
 *  为什么单独拎出来：override 是「门禁说不行，人/agent 硬推」的逃生舱，它本身合法，
 *  但如果没人统计，就等于「绕过多少次、谁绕的、为什么」，平台自己都不知道。
 *  这里只读已有事实，不加埋点。 */
export function overrideSummary(state, options = {}) {
  const since = Number(options?.since) || 0
  /* project 给了就只算这个项目：卡看 task.project、需求看 requirement.project；
     两边都取不到时归「未归属」——全公司口径（project='') 里算进去，单选某个项目时不出现。 */
  const project = String(options?.project ?? '')
  const inProject = value => project === '' || String(value ?? '') === project
  const cards = []
  for (const task of state?.tasks ?? []) {
    const entry = task?.override
    if (entry === null || entry === undefined || typeof entry !== 'object') continue
    const at = Number(entry.at) || 0
    if (at < since) continue
    if (!inProject(task.project)) continue
    cards.push({
      kind: 'card',
      id: String(task.id ?? ''),
      code: String(task.code ?? ''),
      title: String(task.title ?? ''),
      status: String(task.status ?? ''),
      by: String(entry.by ?? ''),
      at,
      reason: String(entry.reason ?? ''),
    })
  }
  const requirements = []
  for (const requirement of state?.requirements ?? []) {
    /* requireProjectGuard: 需求侧同样按项目收 */
    if (!inProject(requirement.project)) continue
    const entry = requirement?.override
    if (entry === null || entry === undefined || typeof entry !== 'object') continue
    const at = Number(entry.at) || 0
    if (at < since) continue
    requirements.push({
      kind: 'requirement',
      id: String(requirement.id ?? ''),
      code: String(requirement.code ?? ''),
      title: String(requirement.title ?? ''),
      status: String(requirement.status ?? ''),
      by: String(entry.by ?? ''),
      at,
      reason: String(entry.reason ?? ''),
    })
  }
  const config = options?.config ?? options?.state?.config ?? options?.state ?? {}
  const list = [...cards, ...requirements].sort((a, b) => b.at - a.at)
  const counts = new Map()
  let byAgent = 0
  let byHuman = 0
  let byUnknown = 0
  for (const item of list) {
    const key = item.by.trim() === '' ? '（没记签名人）' : item.by
    counts.set(key, (counts.get(key) ?? 0) + 1)
    // 和签字同一套口径：专家名册里的名字算 AI，会话痕迹算 AI，其余算人。
    if (item.by.trim() === '') byUnknown += 1
    else if (isAiSignoff({ by: item.by }, config)) { item.ai = true; byAgent += 1 }
    else byHuman += 1
  }
  const max = Number(options?.max) > 0 ? Number(options.max) : 0
  return {
    total: list.length,
    cards: cards.length,
    requirements: requirements.length,
    noReason: list.filter(item => item.reason.trim() === '').length,
    byAgent,
    byHuman,
    byUnknown,
    max,
    overLimit: max > 0 && list.length > max,
    byPerson: [...counts.entries()].map(([by, count]) => ({ by, count })).sort((a, b) => b.count - a.count),
    list: list.slice(0, 50),
  }
}

/** 结构化 override：谁、什么时候、为什么跳过了门禁。null 表示清掉记录。 */
export function sanitizeOverride(raw) {
  if (raw === null) return null
  if (raw === undefined || typeof raw !== 'object') return undefined
  return {
    by: String(raw.by ?? '').trim().slice(0, 60),
    at: Number(raw.at) || Date.now(),
    reason: String(raw.reason ?? '').trim().slice(0, 300),
  }
}
