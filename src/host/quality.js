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
export function buildQuality(state, runs, options = {}) {
  /* 项目筛选与效能页其它面板同口径：只看这个项目的卡，别让「按专家看质量」
     在选了项目之后还报全公司数字。 */
  const project = String(options?.project ?? '').trim()
  const all = Array.isArray(state?.tasks) ? state.tasks : []
  const tasks = project === '' ? all : all.filter(task => task.project === project)
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
  // 老的派单日志记的是「角色位」（dev），卡上记的是专家 id。一个角色只有一位专家时直接归并，
  // 否则同一个人会在表里出现两行（一行有派单没卡、一行有卡没派单）。
  const byRole = new Map()
  for (const expert of state?.config?.experts ?? []) {
    const role = String(expert.role ?? '')
    if (role === '') continue
    byRole.set(role, [...(byRole.get(role) ?? []), String(expert.id ?? '')])
  }
  const runRows = (runs?.byExpert ?? []).map(item => {
    const key = String(item.key ?? '')
    const holders = byRole.get(key) ?? []
    return {
      name: holders.length === 1 ? holders[0] : key,
      runs: Number(item.runs) || 0,
      ms: Number(item.ms) || 0,
    }
  })
  const runByName = new Map(runRows.map(item => [item.name.toLowerCase(), item]))
  const runById = new Map(runRows.map(item => [item.name, item]))
  const experts = [...perExpert.values()].map(row => {
    const info = (state?.config?.experts ?? []).find(item => item.id === row.key)
    const label = info === undefined ? row.key : String(info.name ?? row.key)
    // 先按 id 认领（派单日志里带了 expertId），再退回名字。
    const run = runById.get(row.key) ?? runByName.get(String(info?.name ?? row.key).toLowerCase())
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
      note: '成本按真实 token 用量算：读 studio-* 会话日志，按卡 / 按专家汇总；价目表没配时只给 token，花费显示未知。',
    },
    /* 让面板说清「这些数字算的是哪些卡」：选了项目却没生效，一眼能看出来。 */
    scope: { project, cards: tasks.length },
  }
}

/** 是不是自评：执行记录的作者和评审人是同一个人（或名字互相包含，比如「开发」vs「开发工程师」）。 */
export function isSelfReview(author, reviewer) {
  const a = String(author ?? '').trim()
  const b = String(reviewer ?? '').trim()
  if (a === '' || b === '') return false
  return a === b || a.includes(b) || b.includes(a)
}

/** 评审结论文案：评论标题、面板提示统一取这一份，别一处写「通过」一处写「已通过」。 */
export const CODING_REVIEW_VERDICT = { approved: '通过', changes_requested: '要求修改', pending: '待定' }

/** 评审结论怎么定：显式给了合法状态就按它，否则一律 pending。
 *
 *  以前工具与 HTTP 两条路都默认写成 approved —— "看一眼就算通过"，评审没有意义。
 *  两条入口必须用同一个函数，否则改一条漏一条（这一版就是先只改了工具、面板照旧默认 approved）。 */
export function reviewDecision(rawStatus, allowed) {
  const value = String(rawStatus ?? '').trim()
  return Array.isArray(allowed) && allowed.includes(value) ? value : 'pending'
}

/**
 * 评审闸门：进「待测试」之前，代码评审必须已经通过。
 *
 * 以前只有「已完成」的准出会看 `coding.review`，于是「待评审 → 待测试」直接放行，
 * review 还 pending 就能进测试（issue #9 第 3 条）。这个闸门默认**开**，
 * 因为闸门的价值就是挡住错误动作，默认关等于不存在；要关就显式 `reviewGate.enabled = false`。
 */
export function reviewGate(config, task, nextStatus) {
  const gate = config?.reviewGate ?? {}
  const enabled = gate.enabled !== false
  const columns = Array.isArray(gate.columns) && gate.columns.length > 0 ? gate.columns : ['test']
  const needed = enabled === true && columns.includes(String(nextStatus ?? ''))
  if (needed !== true) return { needed: false, ready: true, blockers: [] }
  const status = String(task?.coding?.review?.status ?? '')
  if (status === 'approved') return { needed: true, ready: true, blockers: [] }
  return {
    needed: true,
    ready: false,
    blockers: [
      status === 'changes_requested'
        ? '代码评审要求修改：改完再推进到待测试'
        : '代码评审还没通过：进「待测试」之前要评审人用 studio_task_coding action=review 给结论（或用 override 说明原因）',
    ],
  }
}
