import { openBlockedOf } from './blocked.js'
import { statusFlow } from './delivery.js'
/* 工作台汇总（从 executor.js 抬出来：那边有 2000 行闸门）。
 *
 * 只做汇总、不改数据。两个刻意的口径：
 *   - 列表每类最多 6 条（首屏放得下），但**总数**一起下发（listTotal），
 *     否则 KPI 写「逾期 12」、下面只列 6 行，剩下 6 张无从得知；
 *   - 停摆（stalled）不是「跑了很久」，而是「派单印记还挂在这一列、会话已经不在」——
 *     这种卡不会自己恢复，也不会被自动派单，必须单独数出来。
 *
 * 依赖（准出、SLA、发布门禁、集成健康、派单器）由调用方传入：这里不 import
 * 有宿主依赖的模块，避免和 executor 成环。
 *
 * 取名时不用被注入方的原名（下面统一读 deps.xxx 再起别名），是因为仓库里有一条契约测试
 * 专门查「用了别的模块导出的符号却没 import」——那些名字一旦裸着出现就会被判红。
 * @param deps  { taskExitGate, bugSla, releaseGate, healthReport, activeRunCount, runLog, stalledCtx }
 */
import { isStalled } from './dispatch-state.js'
import { overrideSummary } from './override.js'
import { requirementProgress } from './requirement-gate.js'
import { STATUSES } from './domain.js'

export function dashboardOf(state, deps = {}) {
  const exitGate = deps.taskExitGate ?? (() => ({ ready: true, blockers: [], warnings: [] }))
  const slaOf = deps.bugSla ?? (() => ({ state: 'ok' }))
  const gateOf = deps.releaseGate ?? (() => ({ ready: true, blockers: [] }))
  const healthOf = deps.healthReport ?? (() => ({ broken: 0 }))
  const activeRunCount = deps.activeRunCount ?? 0
  const runLog = deps.runLog ?? []
  const stalledCtx = deps.stalledCtx ?? {}
  const now = Date.now()
  const tasks = state.tasks
  const open = tasks.filter(task => task.status !== 'done')
  const listOf = (items, limit = 6) => items.slice(0, limit).map(task => ({
    id: task.id,
    code: task.code,
    title: task.title,
    status: task.status,
    statusLabel: (STATUSES.find(entry => entry.id === task.status)?.label) ?? task.status,
    owner: task.owner || '',
    dueAt: task.dueAt || 0,
    sla: slaOf(task, state.config),
  }))

  const overdue = open.filter(task => task.dueAt > 0 && task.dueAt < now)
  /* 口径只有一份：未完成且挂阻塞（见 src/host/blocked.js）。 */
  const blocked = openBlockedOf(open)
  const stalled = open.filter(task => isStalled(task, stalledCtx))
  const slaOverdue = open.filter(task => task.type === 'bug' && slaOf(task, state.config).state === 'overdue')
  // 强制放行是逃生舱，用得越来越顺就该被看一眼：30 天内超过上限算风险。
  const overrideWindow = overrideSummary(state, { since: Date.now() - 30 * 86_400_000, config: state.config })
  const overrideMax = Number(state.config?.limits?.overrideMax) || 3
  const overrideOver = overrideWindow.total > overrideMax ? overrideWindow.total : 0
  const gateFailed = open.filter(task => {
    if (task.status !== 'test' && task.status !== 'accept') return false
    const gate = exitGate(state, task)
    return gate.blockers.length > 0
  })
  const pipelineFailed = open.filter(task => task.gitlabMR?.pipeline?.status === 'failed')

  const requirementBlocked = state.requirements.filter(item => {
    const progress = requirementProgress(state, item)
    return progress.derived !== 'delivered' && progress.derived !== 'closed' && progress.gate.blockers.length > 0
  })
  const releaseBlocked = state.releases.filter(item => item.status !== 'released' && item.status !== 'rolled_back' && !gateOf(state, item).ready)

  const done = tasks.filter(task => task.status === 'done')
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  /* 「今天完成」以前用 updatedAt —— 一张上周完成的卡今天被人评论一句也会算进来。
     现在取 history 里**最后一次进入 done** 的时间；老数据没有状态流时退回 updatedAt。 */
  const doneAtOf = task => {
    const flow = statusFlow(task)
    for (let index = flow.length - 1; index >= 0; index -= 1) {
      if (flow[index].status === 'done' && flow[index].at > 0) return flow[index].at
    }
    return Number(task.updatedAt) || 0
  }
  const doneToday = done.filter(task => doneAtOf(task) >= dayStart.getTime())
  const doneWeek = done.filter(task => doneAtOf(task) >= now - 7 * 24 * 60 * 60 * 1000)
  const runs = Array.isArray(runLog) ? runLog : []

  return {
    at: now,
    scope: { tasks: tasks.length, open: open.length, requirements: state.requirements.length, releases: state.releases.length },
    risks: {
      overdue: overdue.length,
      blocked: blocked.length,
      stalled: stalled.length,
      slaOverdue: slaOverdue.length,
      gateFailed: gateFailed.length,
      pipelineFailed: pipelineFailed.length,
      requirementBlocked: requirementBlocked.length,
      releaseBlocked: releaseBlocked.length,
      overrideOver: overrideOver,
      overrideMax,
      integrationsBroken: Number(healthOf()?.broken ?? 0),
    },
    flow: {
      review: tasks.filter(task => task.status === 'review').length,
      test: tasks.filter(task => task.status === 'test').length,
      accept: tasks.filter(task => task.status === 'accept').length,
      doneToday: doneToday.length,
      doneWeek: doneWeek.length,
    },
    ai: { running: Number(activeRunCount) || 0, todayRuns: runs.filter(item => (item.at || 0) >= dayStart.getTime()).length },
    /* 每类清单只给 6 条（面板首屏要能放下），但**总数要一起给**：
       以前 KPI 写「逾期 12」、下面只列 6 行，剩下 6 张无从得知。 */
    listTotal: {
      overdue: overdue.length,
      blocked: blocked.length,
      stalled: stalled.length,
      slaOverdue: slaOverdue.length,
      gateFailed: gateFailed.length,
      pipelineFailed: pipelineFailed.length,
      overrideOver: overrideWindow.total,
      requirementBlocked: requirementBlocked.length,
      releaseBlocked: releaseBlocked.length,
    },
    list: {
      overdue: listOf(overdue),
      blocked: listOf(blocked),
      stalled: listOf(stalled),
      slaOverdue: listOf(slaOverdue),
      gateFailed: listOf(gateFailed),
      pipelineFailed: listOf(pipelineFailed),
      overrideOver: overrideWindow.list.slice(0, 6),
      requirementBlocked: requirementBlocked.slice(0, 6).map(item => ({
        id: item.id,
        code: item.code,
        title: item.title,
        blockers: requirementProgress(state, item).gate.blockers.slice(0, 3),
      })),
      releaseBlocked: releaseBlocked.slice(0, 6).map(item => ({
        id: item.id,
        version: item.version,
        name: item.name,
        blockers: gateOf(state, item).blockers.slice(0, 3),
      })),
    },
  }
}
