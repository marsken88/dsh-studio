/* 协作链「产品」行的口径。
 *
 * 以前按整条需求聚合：卡片已经走到「待验收」，只要同一需求下别的功能点缺验收条件、
 * 或需求三问没填，这张卡上仍显示黄色「待补齐」——被误读成阻塞（2026-11-26 真机：
 * t-9bf92908 本卡 p3 有 10 条验收，却显示「缺验收：p1/p2 · 缺三问」）。
 *
 * 现在的口径：只认**本卡挂的功能点**。
 *   - 本卡功能点缺验收 → 才是「待补齐」（黄）；
 *   - 同需求其它功能点缺验收 → 只作灰字补充，不再把这张卡标黄；
 *   - 需求三问未填 → 也只作补充说明（它不影响这张卡已经验过的交付）。
 * 没挂功能点（或需求里找不到）时退回需求级判断，行为与以前一致。
 */

export const DISCOVERY_FIELDS = [
  ['server', '有没有服务端'],
  ['auth', '谁做鉴权'],
  ['boundary', '交付边界'],
]

const acceptanceCount = point => (Array.isArray(point?.acceptance) ? point.acceptance : [])
  .filter(item => String(item?.text ?? '').trim() !== '').length

export function productChainRow({ task, requirement, parent = null }) {
  if (requirement === null || requirement === undefined) {
    return { tone: 'missing', chip: '未挂需求', detail: '先建需求并把卡挂上' }
  }
  const points = Array.isArray(requirement.points) ? requirement.points : []
  const acceptance = points.map(point => ({ point, count: acceptanceCount(point) }))
  const total = acceptance.reduce((sum, item) => sum + item.count, 0)
  const detail = `${requirement.code || requirement.id} · 功能点 ${points.length} · 验收条件 ${total} 条`
  const discovery = requirement.discovery ?? {}
  const missingDiscovery = DISCOVERY_FIELDS
    .filter(([key]) => String(discovery[key] ?? '').trim() === '')
    .map(([, label]) => label)
  /* bug 卡是从用例失败派生的，自己没有 pointId —— 继承父卡挂的功能点，
     否则会退回需求级判断，把「同需求别的功能点缺验收」算到这张卡头上。 */
  const ownId = String(task?.pointId ?? '') || String(parent?.pointId ?? '')
  const own = ownId === ''
    ? null
    : acceptance.find(item => String(item.point?.id ?? '') === ownId) ?? null
  if (own !== null) {
    if (own.count === 0) {
      const gaps = [`缺验收：${own.point.id}`]
      if (missingDiscovery.length > 0) gaps.push(`缺三问：${missingDiscovery.join('、')}`)
      return { tone: 'warn', chip: '待补齐', detail: `${detail} · ${gaps.join(' · ')}` }
    }
    const others = acceptance.filter(item => item !== own && item.count === 0).map(item => item.point.id)
    const notes = [`本卡功能点 ${own.point.id} 有 ${own.count} 条验收`]
    if (others.length > 0) notes.push(`同需求还有 ${others.join('/')} 缺验收`)
    if (missingDiscovery.length > 0) notes.push(`需求三问未填：${missingDiscovery.join('、')}`)
    return { tone: 'ok', chip: '本卡可验收', detail: `${detail} · ${notes.join(' · ')}` }
  }
  const bare = acceptance.filter(item => item.count === 0).map(item => item.point.id)
  if (bare.length > 0) {
    const gaps = [`缺验收：${bare.join('/')}`]
    if (missingDiscovery.length > 0) gaps.push(`缺三问：${missingDiscovery.join('、')}`)
    return { tone: 'warn', chip: '待补齐', detail: `${detail} · ${gaps.join(' · ')}` }
  }
  const suffix = missingDiscovery.length > 0 ? ` · 需求三问未填：${missingDiscovery.join('、')}` : ''
  return { tone: 'ok', chip: '需求可验收', detail: `${detail}${suffix}` }
}
