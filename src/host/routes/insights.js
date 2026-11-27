import {
  buildDashboard,
} from '../executor.js'
import { runSummary } from '../dispatcher.js'
import { collectSessionUsage, aggregateUsage } from '../session-usage.js'
import { aggregateContext, breakdownContext } from '../context-insight.js'
import { costOf } from '../usage.js'
import { queryLedger, EVENT_LEDGER_SIDE_KEY } from '../event-ledger.js'
const INJECTED = ['readJsonBody', 'getDispatcher', "buildAnalytics","buildMetrics","burndownReport","sendJson","workloadReport"]
let host = {
  getDispatcher: () => undefined,
  readJsonBody: async () => ({}),
  buildAnalytics: () => {},
  buildMetrics: () => {},
  burndownReport: () => {},
  sendJson: () => {},
  workloadReport: () => {},
}
/** 度量与工作台（指标、分析、工作量、燃尽、成本）相关路由。宿主能力由 configureInsightsRoutes() 注入。 */
import { buildQuality } from '../quality.js'

export function configureInsightsRoutes(services) {
  host = { ...host, ...(services ?? {}) }
}

/** 按项目筛派单日志：RUN_LOG 里有 taskId，项目从卡上取。
 *  效能页的项目筛选必须对每个面板口径一致 —— 以前只作用于 /analytics 与 /burndown，
 *  团队负载 / 按专家质量 / AI 成本仍是全公司数字，紧挨着看出不来差别。 */
function scopedRuns(store, url) {
  const project = String(url?.searchParams?.get('project') ?? '').trim()
  if (project === '') return {}
  const ids = new Set((store.snapshot().tasks ?? []).filter(task => task.project === project).map(task => String(task.id)))
  return { taskIds: ids }
}

export async function handleInsightsRoute({ method, route, req, res, store, url }) {
if (method === 'POST' && route === '/contexts') {
    // 每个专家会话的上下文洞察：窗口峰值、回合、工具调用、重试
    const body = await host.readJsonBody(req).catch(() => ({}))
    /* 项目 / 区间过滤：会话按 taskId 归属项目（派单会话名里带卡 id），
       没有 taskId 的是无卡会话（/agents/chat），选了项目就不该算进来。 */
    const project = String(body?.project ?? '').trim()
    const days = Number(body?.days) || 0
    const since = days > 0 ? Date.now() - days * 86400000 : 0
    let sessions = await collectSessionUsage()
    if (project !== '') {
      const ids = new Set((store.snapshot().tasks ?? []).filter(task => task.project === project).map(task => String(task.id)))
      sessions = sessions.filter(session => ids.has(String(session?.taskId ?? '')))
    }
    if (since > 0) sessions = sessions.filter(session => (Number(session?.at) || 0) >= since)
    // threshold 可传：默认 60%，调小可以在真实数据上验证告警链路
    const threshold = Number(body?.threshold)
    const aggregated = aggregateContext(sessions, Number.isFinite(threshold) && threshold > 0 ? threshold : undefined)
    host.sendJson(res, 200, { ok: true, ...aggregated, threshold: Number.isFinite(threshold) && threshold > 0 ? threshold : 60, at: Date.now() })
    return true
  }
  if (method === 'POST' && route === '/contexts/session') {
    // 单个专家的最近一次会话：峰值窗口 + 四类内容的体积占比（系统提示来自平台配置，其余按日志体积估算）
    const body = await host.readJsonBody(req)
    const expert = String(body.expert ?? '')
    const sessions = await collectSessionUsage()
    const mine = sessions.filter(item => item.expert === expert).sort((a, b) => Number(b.at) - Number(a.at))
    if (mine.length === 0) {
      host.sendJson(res, 200, { ok: false, error: '这个专家还没有会话记录' })
      return true
    }
    const expertConfig = (store.snapshot().config.experts ?? []).find(item => item.id === expert) ?? {}
    // 派单收尾时抓到的引擎计量（tokenMeasurement）优先给真实数字
    const card = (store.snapshot().tasks ?? []).find(item => item.id === mine[0].taskId)
    const anchor = card?.insight?.data?.anchor?.usage ?? null
    host.sendJson(res, 200, {
      ok: true,
      expert,
      sessions: mine.length,
      breakdown: breakdownContext(mine[0], String(expertConfig.prompt ?? '').length),
      engine: anchor === null ? null : { total: Number(anchor.totalTokens ?? 0), input: Number(anchor.inputTokens ?? 0), output: Number(anchor.outputTokens ?? 0), cacheRead: Number(anchor.cacheReadTokens ?? 0), at: Number(card?.insight?.at ?? 0) },
    })
    return true
  }
  /* 事件账本：webhook 投出去的每个 seq 都要能在这里查回来（产品定义第 7 条）。 */
  if (method === 'GET' && route === '/events') {
    const raw = await store.readSide(EVENT_LEDGER_SIDE_KEY)
    host.sendJson(res, 200, {
      ok: true,
      ...queryLedger(raw, {
        since: Number(url.searchParams.get('since') ?? 0),
        limit: Number(url.searchParams.get('limit') ?? 100),
        type: url.searchParams.get('type') ?? '',
      }),
    })
    return true
  }
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
  if (method === 'GET' && route === '/quality') {
    // AI 质量：派单量 / 一次通过率 / 返工率 / 平均耗时；成本见 /costs 的 usage（读会话日志 + 价目表）。
    // `project` 与 /analytics 同口径：筛选了项目，这张表也只算那个项目的卡。
    host.sendJson(res, 200, {
      ok: true,
      quality: buildQuality(store.snapshot(), runSummary(scopedRuns(store, url)), { project: url.searchParams.get('project') ?? '' }),
    })
    return true
  }
  if (method === 'GET' && route === '/workload') {
    const dispatcher = host.getDispatcher()
    const running = dispatcher === undefined ? [] : [...dispatcher.running.values()]
    host.sendJson(res, 200, {
      ok: true,
      workload: host.workloadReport(store.snapshot(), running, { project: url.searchParams.get('project') ?? '' }),
    })
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
    const project = String(url.searchParams.get('project') ?? '').trim()
    const only = project === '' ? null : new Set((store.snapshot().tasks ?? []).filter(task => task.project === project).map(task => String(task.id)))
    const summary = runSummary(only === null ? {} : { taskIds: only })
    const budget = store.snapshot().config.costs
    const runs = summary.total
    const hours = Math.round(((summary.avgMs * summary.finished) / 3600_000) * 10) / 10
    const runRate = budget.budgetRuns > 0 ? Math.min(100, Math.round((runs / budget.budgetRuns) * 100)) : 0
    const hourRate = budget.budgetHours > 0 ? Math.min(100, Math.round((hours / budget.budgetHours) * 100)) : 0
    const level = Math.max(runRate, hourRate) >= 100
      ? 'over'
      : Math.max(runRate, hourRate) >= budget.warnAt ? 'warn' : 'ok'
    // 真实 token 用量：读 studio-* 会话日志，按卡 / 按专家汇总；价目表为空时只给 token。
    // 选了项目就只算那个项目下的卡（无卡会话仍进总量：它不属于任何项目，抹掉会让人以为钱变少了）。
    const allTasks = store.snapshot().tasks ?? []
    const scopedSessions = only === null
      ? await collectSessionUsage()
      : (await collectSessionUsage()).filter(session => session.adHoc === true || only.has(String(session.taskId ?? '')))
    const usage = aggregateUsage(scopedSessions, allTasks, budget.prices ?? [], costOf)
    host.sendJson(res, 200, {
      ok: true,
      costs: summary,
      usage,
      /* 说清这个面板算的是哪些卡：选了项目却没生效会被一眼看出来。 */
      scope: { project, cards: only === null ? allTasks.length : only.size },
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
