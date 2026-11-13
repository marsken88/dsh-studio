// 专家团的团队记忆：跨卡的经验沉淀。存在 SQLite 的 side 键里——
// 不占 state、不涨 revision、不抢快照；读不到就当没有。

const KEY = 'team-memory'
const PER_TEAM = 20
const IN_PROMPT = 5

/** 全部团的记忆：{ [teamId]: [{ at, taskId, title, outcome, note }] } */
export async function loadTeamMemory(store) {
  const saved = await store.readSide(KEY).catch(() => null)
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return {}
  return saved
}

/** 记一条；同一个团最多留 PER_TEAM 条。 */
export async function appendTeamMemory(store, teamId, entry) {
  const id = String(teamId ?? '')
  if (id === '') return null
  const all = await loadTeamMemory(store)
  const list = Array.isArray(all[id]) ? all[id] : []
  const row = {
    at: Number(entry?.at) || Date.now(),
    taskId: String(entry?.taskId ?? '').slice(0, 60),
    title: String(entry?.title ?? '').slice(0, 120),
    outcome: String(entry?.outcome ?? '').slice(0, 40),
    note: String(entry?.note ?? '').slice(0, 300),
  }
  all[id] = [row, ...list].slice(0, PER_TEAM)
  await store.writeSide(KEY, all).catch(() => {})
  return row
}

/** 清空某个团的记忆（人从面板上点）。 */
export async function clearTeamMemory(store, teamId) {
  const all = await loadTeamMemory(store)
  delete all[String(teamId ?? '')]
  await store.writeSide(KEY, all).catch(() => {})
}

/** 拼进专家提示词的那一段；纯函数，方便单测。 */
export function teamMemoryBlock(entries, limit = IN_PROMPT) {
  const list = Array.isArray(entries) ? entries.slice(0, Math.max(0, limit)) : []
  if (list.length === 0) return ''
  const lines = list.map(item => `- ${item.outcome || '经手'}：${item.title}${item.note ? `（${item.note}）` : ''}`)
  return `\n这个团最近经手过的卡（先看有没有踩过的坑，别重复犯）：\n${lines.join('\n')}`
}
