import {
  buildDashboard,
} from '../executor.js'
import { runSummary } from '../dispatcher.js'
const INJECTED = ['getDispatcher', "buildAnalytics","buildMetrics","burndownReport","sendJson","workloadReport"]
let host = {
  getDispatcher: () => undefined,
  buildAnalytics: () => {},
  buildMetrics: () => {},
  burndownReport: () => {},
  sendJson: () => {},
  workloadReport: () => {},
}
/** 度量与工作台（指标、分析、工作量、燃尽、成本）相关路由。宿主能力由 configureInsightsRoutes() 注入。 */
export function configureInsightsRoutes(services) {
  host = { ...host, ...(services ?? {}) }
}
export async function handleInsightsRoute({ method, route, req, res, store, url }) {
  if (method === 'GET' && route === '/metrics') {
    host.sendJson(res, 200, { ok: true, metrics: host.buildMetrics(store.snapshot()) })
    return true
  }
  if (method === 'GET' && route === '/analytics') {
    const snapshot = store.snapshot()
    host.sendJson(res, 200, {
      ok: true,
      analytics: host.buildAnalytics(snapshot, {
        days: url.searchParams.get('days') ?? '',
        project: url.searchParams.get('project') ?? '',
      }),
    })
    return true
  }
  if (method === 'GET' && route === '/dashboard') {
    // 最近一次回归（定时或人跑的）也一起给工作台，早上打开就知道昨晚跑成什么样。
    const regressions = await store.readSide('regressions').catch(() => null)
    host.sendJson(res, 200, {
      ok: true,
      dashboard: buildDashboard(store.snapshot()),
      regression: Array.isArray(regressions) && regressions.length > 0 ? regressions[0] : null,
    })
    return true
  }
  if (method === 'GET' && route === '/workload') {
    const dispatcher = host.getDispatcher()
    const running = dispatcher === undefined ? [] : [...dispatcher.running.values()]
    host.sendJson(res, 200, { ok: true, workload: host.workloadReport(store.snapshot(), running) })
    return true
  }
  if (method === 'GET' && route === '/burndown') {
    host.sendJson(res, 200, {
      ok: true,
      burndown: host.burndownReport(store.snapshot(), {
        days: url.searchParams.get('days') ?? '',
        project: url.searchParams.get('project') ?? '',
      }),
    })
    return true
  }
  if (method === 'GET' && route === '/costs') {
    const summary = runSummary()
    const budget = store.snapshot().config.costs
    const runs = summary.total
    const hours = Math.round(((summary.avgMs * summary.finished) / 3600_000) * 10) / 10
    const runRate = budget.budgetRuns > 0 ? Math.min(100, Math.round((runs / budget.budgetRuns) * 100)) : 0
    const hourRate = budget.budgetHours > 0 ? Math.min(100, Math.round((hours / budget.budgetHours) * 100)) : 0
    const level = Math.max(runRate, hourRate) >= 100
      ? 'over'
      : Math.max(runRate, hourRate) >= budget.warnAt ? 'warn' : 'ok'
    host.sendJson(res, 200, {
      ok: true,
      costs: summary,
      budget: {
        ...budget,
        runs,
        hours,
        runRate,
        hourRate,
        level,
        hint: level === 'over'
          ? '已经超出预算：要么调高预算，要么停下来看看是不是有卡在空转'
          : level === 'warn'
            ? `已用到 ${Math.max(runRate, hourRate)}%，超过 ${budget.warnAt}% 会在这里标黄`
            : '预算内',
      },
    })
    return true
  }
  return false
}
