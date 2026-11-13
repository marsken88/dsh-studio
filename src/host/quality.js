// 相 ai 的质量度量：一次通过率、返工率、耗时。纯函数，口径写在 README「AI 质量的口径」一节。
//
// 三个信号都来自台账本身，不猜：
//   派单次数 / 平均耗时 —— dispatcher 的 RUN_LOG（内存里最近 300 条，重启就清零，见 README 已知限制）
//   卡数 / 完成数     —— task.expert（换列时会被列负责人覆盖，所以只有「当前负责」的卡能算）
//   返工              —— 列往回退过、AI 失败过、缺陷重开过，任一命中就算这张卡返工了

import { STATUS_IDS } from './domain.js'

const order = new Map(STATUS_IDS.map((id, index) => [id, index]))

/** 这张卡有没有返工，以及为什么。 */
export function taskRework(task) {
  const reasons = []
  const history = Array.isArray(task?.history) ? task.history : []
  let backwards = 0
  for (let index = 1; index < history.length; index += 1) {
    const from = order.get(String(history[index - 1]?.status ?? ''))
    const to = order.get(String(history[index]?.status ?? ''))
    if (from === undefined || to === undefined) continue
    if (to < from) backwards += 1
  }
  // 返工只认「列往回退」——和效能页那个「一次通过率」KPI 用同一条定义（index.js 的 taskTimeline.backward），
  // 两处数字必须能对上。AI 失败与缺陷重开单独给出来，但不进返工率。
  if (backwards > 0) reasons.push(`被打回 ${backwards} 次`)
  return {
    rework: backwards > 0,
    backwards,
    failures: Number(task?.agentFailures) || 0,
    reopens: Number(task?.reopenCount) || 0,
    reasons,
  }
}

const rate = (part, total) => (total > 0 ? Math.round((part / total) * 100) : null)

/**
 * 按专家汇总质量。runs 传 runSummary() 的结果（含 byExpert）。
 * 只统计「有专家」的卡；没派过的卡不进分母。
 */
export function buildQuality(state, runs) {
  const tasks = Array.isArray(state?.tasks) ? state.tasks : []
  const perExpert = new Map()
  const touch = key => {
    if (!perExpert.has(key)) perExpert.set(key, { key, cards: 0, done: 0, rework: 0, firstPass: 0 })
    return perExpert.get(key)
  }
  for (const task of tasks) {
    const expertId = String(task.expert ?? task.dispatch?.expert ?? '')
    if (expertId === '') continue
    const row = touch(expertId)
    row.cards += 1
    const done = String(task.status) === 'done'
    const { rework } = taskRework(task)
    if (done) row.done += 1
    if (rework) row.rework += 1
    if (done && !rework) row.firstPass += 1
  }
  const runRows = (runs?.byExpert ?? []).map(item => ({ name: String(item.key ?? ''), runs: Number(item.runs) || 0, ms: Number(item.ms) || 0 }))
  const runByName = new Map(runRows.map(item => [item.name.toLowerCase(), item]))
  const experts = [...perExpert.values()].map(row => {
    const info = (state?.config?.experts ?? []).find(item => item.id === row.key)
    const label = info === undefined ? row.key : `${info.emoji ?? ''} ${info.name}`.trim()
    const run = runByName.get(String(info?.name ?? row.key).toLowerCase())
    return {
      expert: row.key,
      label,
      dispatched: run?.runs ?? 0,
      avgMs: run !== undefined && run.runs > 0 ? Math.round(run.ms / run.runs) : 0,
      cards: row.cards,
      done: row.done,
      rework: row.rework,
      firstPass: row.firstPass,
      firstPassRate: rate(row.firstPass, row.done),
      reworkRate: rate(row.rework, row.cards),
    }
  }).sort((a, b) => (b.dispatched - a.dispatched) || (b.cards - a.cards))

  const sum = key => experts.reduce((total, item) => total + (item[key] ?? 0), 0)
  const done = sum('done')
  const firstPass = sum('firstPass')
  const cards = sum('cards')
  return {
    experts,
    totals: {
      dispatched: sum('dispatched'),
      cards,
      done,
      rework: sum('rework'),
      firstPass,
      firstPassRate: rate(firstPass, done),
      reworkRate: rate(sum('rework'), cards),
      failures: tasks.reduce((total, task) => total + (Number(task.agentFailures) || 0), 0),
      reopens: tasks.reduce((total, task) => total + (Number(task.reopenCount) || 0), 0),
      avgMs: (() => {
        const totalMs = runRows.reduce((total, item) => total + item.ms, 0)
        const totalRuns = runRows.reduce((total, item) => total + item.runs, 0)
        return totalRuns > 0 ? Math.round(totalMs / totalRuns) : 0
      })(),
    },
    cost: {
      wired: false,
      note: '成本还没接真实 token usage：平台目前只记录派单次数与耗时，没有按卡/按项目记账。接上 usage 之后这里才会有数字。',
    },
  }
}
