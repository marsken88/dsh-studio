// dsh-studio · 跨卡用例的聚合与回归汇总（纯函数，不碰台账）
// 从 domain.js 拆出来：那边有 2000 行的硬上限（tests/repo.test.mjs 会拦）。

/** 一批回归跑完后的汇总记录（写给「最近回归」用，不占 state、不涨 revision）。 */
export function summarizeRun(results, by, at = Date.now()) {
  const rows = Array.isArray(results) ? results : []
  const sum = key => rows.reduce((n, item) => n + (Number(item[key]) || 0), 0)
  return {
    at,
    by: String(by ?? '').slice(0, 40),
    cards: rows.length,
    failedCards: rows.filter(item => item.ok === false).length,
    total: sum('total'),
    passed: sum('passed'),
    failed: sum('failed'),
    bugs: sum('bugs'),
  }
}

/** 把 "taskId:caseId" 的键按卡分组（跨卡回归就是这么拆成一轮一轮跑的）；坏键直接丢掉。 */
export function groupCaseKeys(keys) {
  const byTask = new Map()
  for (const key of Array.isArray(keys) ? keys : []) {
    const raw = String(key ?? '')
    const at = raw.indexOf(':')
    if (at <= 0 || at === raw.length - 1) continue
    const taskId = raw.slice(0, at)
    const caseId = raw.slice(at + 1)
    if (!byTask.has(taskId)) byTask.set(taskId, [])
    byTask.get(taskId).push(caseId)
  }
  return byTask
}

/** 跨卡用例总览：把每张卡上的用例摊成一张表，带上卡片与需求的上下文。纯函数，方便单测。 */
export function collectCases(state) {
  const requirementById = new Map((state?.requirements ?? []).map(item => [item.id, item]))
  const out = []
  for (const task of state?.tasks ?? []) {
    const requirement = requirementById.get(task.requirementId)
    for (const item of task.cases ?? []) {
      out.push({
        key: `${task.id}:${item.id}`,
        id: item.id,
        title: item.title ?? '',
        expected: item.expected ?? '',
        result: item.result ?? 'pending',
        type: item.type ?? 'functional',
        priority: item.priority ?? 'p2',
        pointId: item.pointId ?? '',
        http: item.http !== null && item.http !== undefined,
        lastRunAt: item.lastRun?.at ?? 0,
        taskId: task.id,
        taskTitle: task.title ?? '',
        taskCode: task.code ?? '',
        taskStatus: task.status ?? '',
        requirementId: task.requirementId ?? '',
        requirementTitle: requirement?.title ?? '',
        requirementCode: requirement?.code ?? '',
      })
    }
  }
  return out
}

