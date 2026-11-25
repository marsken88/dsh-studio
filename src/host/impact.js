// 需求改版的影响面：哪些卡已经产出过东西、哪些用例要重跑。纯函数，方便单测。

/** 把受影响的卡上挂着的用例摊平，给需求变更记录用。 */
export function casesOfTasks(tasks, limit = 40) {
  const out = []
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (task === null || task === undefined) continue
    for (const item of Array.isArray(task.cases) ? task.cases : []) {
      if (out.length >= limit) return out
      out.push({
        taskId: String(task.id ?? ''),
        taskCode: String(task.code ?? ''),
        key: `${task.id}:${item.id}`,
        title: String(item.title ?? '').slice(0, 160),
        result: String(item.result ?? 'pending'),
        // 能自动跑的判断要和执行器一致：接口 / shell / 数据库任一都算。
        http: item.http !== null && item.http !== undefined,
        runnable: item.http != null || item.shell != null || item.db != null,
      })
    }
  }
  return out
}

/** 影响面小结：多少张卡、多少条用例、其中几条能自动跑。 */
export function impactSummary(tasks) {
  const cases = casesOfTasks(tasks, 500)
  return {
    cards: (Array.isArray(tasks) ? tasks : []).length,
    cases: cases.length,
    runnable: cases.filter(item => item.runnable === true).length,
    failing: cases.filter(item => item.result === 'fail').length,
  }
}

/**
 * 需求文档（PRD / 验收标准）最近一次变更时间；没有这类文档返回 0。
 * 文档改版后，之前"通过过"的用例不一定还成立 —— 这是「需复跑」的基准时间。
 */
export function requirementDocUpdatedAt(requirement) {
  const docs = Array.isArray(requirement?.docs) ? requirement.docs : []
  let at = 0
  for (const doc of docs) {
    const kind = String(doc?.kind ?? 'prd')
    if (kind !== 'prd' && kind !== 'acceptance') continue
    at = Math.max(at, Number(doc?.at) || 0)
  }
  return at
}

/**
 * 这条用例要不要在文档改版后复跑：
 *   只有「通过过」的用例才需要 —— 失败/没跑的本来就在待办里；
 *   最后一次执行（没有执行记录就用登记时间）早于文档更新时间 → 结果可能已经过时。
 */
export function caseNeedsRerun(item, docUpdatedAt) {
  if (!(Number(docUpdatedAt) > 0)) return false
  if (String(item?.result ?? '') !== 'pass') return false
  const ranAt = Number(item?.lastRun?.at) || Number(item?.at) || 0
  return ranAt > 0 && ranAt < Number(docUpdatedAt)
}
