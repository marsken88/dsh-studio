/* 团队负载（从 index.js 抬出来：那边有 2700 行棘轮，而且这里是纯汇总）。
 *
 * 口径：一张卡算在「它现在归谁」名下 —— 优先派单印记（正在跑的专家），其次卡上登记的
 * 专家。项目筛选按 `task.project` 过滤，和效能页其它面板保持一致。
 */

/**
 * @param state 整份台账快照
 * @param runningList 派单器当前的 running 会话
 * @param deps { bugSla } 缺陷 SLA 判定由调用方注入（它要读 config，属于宿主能力）
 * @param options { project } 只看某个业务项目
 */
export function workloadOf(state, runningList = [], deps = {}, options = {}) {
  const now = Date.now()
  const week = 7 * 86_400_000
  const project = String(options.project ?? '').trim()
  const tasks = project === '' ? (state.tasks ?? []) : (state.tasks ?? []).filter(task => task.project === project)
  const runningBy = new Map()
  for (const info of runningList) runningBy.set(info.expert, (runningBy.get(info.expert) ?? 0) + 1)
  const experts = (state.config.experts ?? []).map(expert => {
    let open = 0
    let done7d = 0
    let overdue = 0
    for (const task of tasks) {
      const owner = task.dispatch?.expert || task.expert || ''
      if (owner !== expert.id) continue
      if (task.status === 'done') {
        if (now - (Number(task.updatedAt) || 0) <= week) done7d += 1
        continue
      }
      open += 1
      const sla = typeof deps.bugSla === 'function' ? deps.bugSla(task, state.config) : null
      if (sla !== null && sla !== undefined && sla.state === 'overdue') overdue += 1
    }
    return {
      id: expert.id,
      name: expert.name,
      emoji: expert.emoji,
      domain: expert.domain,
      enabled: expert.enabled !== false,
      running: runningBy.get(expert.id) ?? 0,
      open,
      done7d,
      overdue,
    }
  })
  const sorted = experts.sort((a, b) => (b.running - a.running) || (b.open - a.open))
  return {
    experts: sorted,
    busy: sorted.filter(item => item.running > 0).length,
    /* 让面板能说清「这些数字算的是哪些卡」，而不是让人猜项目筛选到底生效没有。 */
    scope: { project, tasks: tasks.length },
  }
}
