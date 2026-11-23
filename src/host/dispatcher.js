// ------------------------------------------------------------------ dispatcher
import { DEFAULT_ROLES, FALLBACK_AGENT_MODEL, ROLE_IDS, SANDBOX_MODES, STATUSES, codingSummary, normalizeStrategy, worktreeRoot } from './domain.js'
import { effectiveConcurrency } from './parallel-guard.js'
import { abandonedRetry } from './dispatch-state.js'
import { driftNote, isModelDrift, sessionDirOf } from './model-drift.js'
import { stripQuotedCode } from './mention-note.js'
import { handoffBlock } from './handoff.js'
import { planLine, testPlanSummary } from './test-plan.js'
import { emitEvent } from './events.js'
import { loadTeamMemory, teamMemoryBlock } from './team-memory.js'
import { STUDIO_WORKSPACE_TITLE, dispatchDirFor, projectContext } from './dispatch-cwd.js'
import { mkdir, rename, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
// 派单引擎：一卡一会话、槽位限流、幂等投递、SLA 升级。
// 需要宿主能力的少数几处走 configureDispatcher() 注入，避免这里反过来依赖 index.js。

let host = {}

export function configureDispatcher(services) {
  host = services ?? {}
}

// ---------------------------------------------------------------- dispatcher

/** Display labels for the four shipped roles. */

/** What each role is expected to do with the card it is handed. */
export const ROLE_BRIEF = {
  product: '澄清需求：补齐目标、范围、验收标准，写进 requirement 字段；能开工就把卡推进到「待方案」。',
  architect: '产出技术方案：改哪些模块、数据流、接口、风险与替代方案；结论写进评论并附关键文件路径；定稿后推进到「待开发」。',
  dev: '按方案实现代码：先读相关源码，改动小步可验证；需要时开分支提 MR 并把链接写进 gitlabMR；自测通过后推进到「待测试」。',
  qa: '按需求与方案设计用例并验证：正常路径、边界、异常；记录实际执行的命令与结果；通过推进到「待验收」，不通过退回「待开发」并写明原因。',
}

/** 一个角色位在本领域下的候选人：本领域优先，其次通用（没有领域归属），最后其他领域。 */
export function roleCandidates(config, role, domain) {
  const pool = (config.experts ?? []).filter(expert => expert.enabled !== false && (expert.role ?? '') === role)
  const want = String(domain ?? '').trim()
  const rank = expert => (want !== '' && expert.domain === want ? 2 : (expert.domain ?? '') === '' ? 1 : 0)
  return pool.slice().sort((a, b) => rank(b) - rank(a))
}

/** Resolve one column owner (`{kind,id}`) against the roster. */
export function resolveOwner(config, owner, domain) {
  if (owner === null || typeof owner !== 'object') return undefined
  // 这一列没人负责：卡停在这等人认领，不自动派。
  if (owner.kind === 'none') return undefined
  // 角色位：泳道配的是「产品经理/研发工程师」，具体落到哪位由卡的业务领域决定。
  if (owner.kind === 'role') {
    const role = String(owner.id ?? owner.role ?? '').trim()
    if (!ROLE_IDS.includes(role)) return undefined
    const picks = roleCandidates(config, role, domain)
    if (picks.length === 0) return undefined
    const expert = picks[0]
    return { kind: 'expert', expert, team: undefined, label: expert.name, viaRole: role }
  }
  if (owner.kind === 'team') {
    const team = (config.teams ?? []).find(entry => entry.id === owner.id)
    if (team === undefined || team.members.length === 0) return undefined
    const leadId = team.members.includes(team.lead) ? team.lead : team.members[0]
    const expert = (config.experts ?? []).find(entry => entry.id === leadId)
    if (expert === undefined) return undefined
    return { kind: 'team', team, expert, label: `专家团 · ${team.name}` }
  }
  const expert = (config.experts ?? []).find(entry => entry.id === owner.id)
  if (expert === undefined) return undefined
  return { kind: 'expert', expert, team: undefined, label: expert.name }
}

/** 卡片业务领域：卡上写了用卡的，没写就用它所属需求的。 */
export function taskDomain(task, state) {
  const own = String(task?.domain ?? '').trim()
  if (own !== '') return own
  const requirement = (state?.requirements ?? []).find(entry => entry.id === task?.requirementId)
  return String(requirement?.domain ?? '').trim()
}

/** Who owns a card right now: the column's owner, else the card's own expert. */
export function ownerFor(config, task, column, load, state) {
  const raw = config.columns?.[column.id]
  const domain = taskDomain(task, state)
  const candidates = columnCandidates(config, column, domain)
  let resolved = pickFromPool(candidates, raw, task, column, load)
  // 卡片标了业务领域、而挑出来的这位没有领域归属时，去全员里找同领域、角色位对得上的。
  if (domain.length > 0 && resolved?.kind !== 'team' && (resolved === undefined || (resolved.expert?.domain ?? '') === '')) {
    const sameDomain = (config.experts ?? []).filter(entry => entry.enabled !== false && entry.domain === domain)
    if (sameDomain.length > 0) {
      const byRole = sameDomain.find(entry => (entry.role ?? '') === (column?.role ?? ''))
      const pick = byRole ?? sameDomain[0]
      return { kind: 'expert', expert: pick, team: undefined, label: pick.name }
    }
  }
  if (resolved !== undefined) return resolved
  if (typeof task.expert === 'string' && task.expert.length > 0) {
    const fallback = resolveOwner(config, { kind: 'expert', id: task.expert })
    if (fallback !== undefined) return fallback
  }
  // 没人负责就没人负责：不再默认塞给产品经理，等人来指定。
  return undefined
}

/** 这一列的全部候选人（展开团队时取团长）。 */
export function columnCandidates(config, column, domain) {
  const raw = config.columns?.[column.id]
  if (raw === undefined || raw === null) return []
  // 角色位展开成「同角色的一组人」，再交给候选池策略挑。
  if (Array.isArray(raw.members)) {
    const out = []
    const seen = new Set()
    for (const member of raw.members) {
      if (member?.kind === 'role') {
        for (const expert of roleCandidates(config, String(member.id ?? ''), domain)) {
          if (seen.has(expert.id)) continue
          seen.add(expert.id)
          out.push({ kind: 'expert', expert, team: undefined, label: expert.name })
        }
        continue
      }
      const one = resolveOwner(config, member, domain)
      if (one === undefined) continue
      const key = one.expert?.id ?? ''
      if (key.length > 0 && seen.has(key)) continue
      if (key.length > 0) seen.add(key)
      out.push(one)
    }
    return out
  }
  const one = resolveOwner(config, raw, domain)
  return one === undefined ? [] : [one]
}

/** 按策略从候选池里挑一个：轮询看手上活多少，匹配看专长，或交给专家团团长。 */
export function pickFromPool(candidates, raw, task, column, load) {
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]
  const strategy = normalizeStrategy(raw?.strategy)
  if (strategy === 'lead') {
    const team = candidates.find(entry => entry.kind === 'team')
    return team ?? leastLoaded(candidates, load)
  }
  if (strategy === 'best_match') {
    const scored = candidates.map(entry => ({ entry, score: matchScore(entry, task, column) }))
    const top = Math.max(...scored.map(item => item.score))
    return leastLoaded(scored.filter(item => item.score === top).map(item => item.entry), load)
  }
  return leastLoaded(candidates, load)
}

export function leastLoaded(candidates, load) {
  if (load === undefined || typeof load.get !== 'function') return candidates[0]
  let best = candidates[0]
  let bestLoad = Number.POSITIVE_INFINITY
  for (const entry of candidates) {
    const count = load.get(entry.expert?.id ?? '') ?? 0
    if (count < bestLoad) { best = entry; bestLoad = count }
  }
  return best
}

export function matchScore(entry, task, column) {
  const expert = entry.expert
  if (expert === undefined) return 0
  let score = 0
  if (expert.domain && task.domain && expert.domain === task.domain) score += 50
  if ((column?.role ?? '') !== '' && (expert.role ?? '') === column.role) score += 20
  const text = `${task.title ?? ''} ${task.requirement ?? ''}`.toLowerCase()
  if (text.trim() !== '') {
    for (const skill of expert.skills ?? []) {
      const key = String(skill ?? '').trim().toLowerCase()
      if (key.length >= 2 && text.includes(key)) score += 5
    }
  }
  return score
}

/**
 * People (and the board) call an expert by writing `@名字` in a comment.
 * Sorting by length keeps `@架构师助理` from also firing `@架构师`.
 */
export function parseMentions(body, config) {
  /* 先剥掉代码块与行内代码：里面写的 @架构师 通常是在**引用**规则或别人的话，
     真机踩过——开发工程师在评论里转述「@开发工程师」的用法，平台又派了一轮单。 */
  const source = stripQuotedCode(body)
  if (source.length === 0) return []
  const candidates = [
    ...(config.experts ?? []).filter(expert => expert.enabled).map(expert => ({ kind: 'expert', id: expert.id, name: expert.name })),
    ...(config.teams ?? []).filter(team => team.enabled).map(team => ({ kind: 'team', id: team.id, name: team.name })),
  ].sort((a, b) => b.name.length - a.name.length)
  const hits = []
  const seen = new Set()
  for (const candidate of candidates) {
    if (candidate.name.length === 0) continue
    if (!source.includes(`@${candidate.name}`) && !source.includes(`@${candidate.id}`)) continue
    const key = `${candidate.kind}:${candidate.id}`
    if (seen.has(key)) continue
    seen.add(key)
    hits.push({ ...candidate, label: candidate.kind === 'team' ? `专家团 · ${candidate.name}` : candidate.name })
  }
  return hits
}

/** Deep-freeze a literal message object. */
export function frozen(value) {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) frozen(item)
    Object.freeze(value)
  }
  return value
}

/** Write the dispatcher record of one card without going through the tool patch filter. */
export async function markDispatch(store, id, dispatch) {
  await store.mutate(state => {
    const task = state.tasks.find(entry => entry.id === id)
    if (task !== undefined) task.dispatch = dispatch
  })
}

/**
 * Hands a card to its role agent: one Session per card, bounded concurrency,
 * and at most one delivery per (card, column) pair.
 */
/**
 * 一次派单 = 一次 AI 执行。这里留最近 300 条，用于「这个卡是谁、用哪个模型、
 * 哪一版提示词、跑了多久」的成本视图（宿主目前不回报 token，所以只统计次数与时长）。
 */
export const RUN_LOG = []

// 运行日志落盘：quality 的「派单次数 / 平均耗时」靠它，只放内存的话重启就归零。
// 同样走 side 键，不占 state、不涨 revision；写是去抖的，一次派单不会写一次盘。
const RUNS_KEY = 'agent-runs'
let runStore = null
let runTimer = null

/** 开机时把上次的派单日志读回来；store 没就绪也能调，readSide 自己会等。 */
export function attachRunLog(store) {
  if (store === null || store === undefined) return
  runStore = store
  void store.readSide(RUNS_KEY).then(saved => {
    if (!Array.isArray(saved) || saved.length === 0) return
    if (RUN_LOG.length > 0) return
    RUN_LOG.push(...saved.slice(0, 300))
  }).catch(() => { /* 读不回来就按空的重来 */ })
}

function flushRunLog() {
  if (runStore === null || runTimer !== null) return
  runTimer = setTimeout(() => {
    runTimer = null
    void runStore.writeSide(RUNS_KEY, RUN_LOG.slice(0, 300)).catch(() => {})
  }, 1500)
  runTimer.unref?.()
}

export function recordRun(entry) {
  RUN_LOG.unshift({ ...entry, at: Number(entry.at) || Date.now(), doneAt: 0, ms: 0 })
  if (RUN_LOG.length > 300) RUN_LOG.length = 300
  flushRunLog()
  return RUN_LOG[0]
}

export function settleRun(sessionId) {
  const entry = RUN_LOG.find(item => item.sessionId === sessionId && item.doneAt === 0)
  if (entry === undefined) return
  entry.doneAt = Date.now()
  entry.ms = Math.max(0, entry.doneAt - entry.at)
  flushRunLog()
}

export function runSummary() {
  const byExpert = new Map()
  const byModel = new Map()
  const byPrompt = new Map()
  const byDay = new Map()
  let finished = 0
  let totalMs = 0
  for (const run of RUN_LOG) {
    const bump = (map, key) => {
      const current = map.get(key) ?? { key, runs: 0, ms: 0 }
      current.runs += 1
      current.ms += run.ms
      map.set(key, current)
    }
    bump(byExpert, run.expertId || run.expert || run.expertName || '未记录')
    bump(byModel, run.model || '跟随默认')
    bump(byPrompt, run.promptVersion || '未记录')
    const day = new Date(run.at).toISOString().slice(0, 10)
    const currentDay = byDay.get(day) ?? { day, runs: 0 }
    currentDay.runs += 1
    byDay.set(day, currentDay)
    if (run.doneAt > 0) {
      finished += 1
      totalMs += run.ms
    }
  }
  const sort = map => [...map.values()].sort((a, b) => b.runs - a.runs)
  return {
    total: RUN_LOG.length,
    finished,
    avgMs: finished > 0 ? Math.round(totalMs / finished) : 0,
    byExpert: sort(byExpert),
    byModel: sort(byModel),
    byPromptVersion: sort(byPrompt),
    days: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-14),
    note: 'token 用量读自 studio-* 会话日志（每次模型调用都记一次）；钱要显示得先在「成本与预算」里配价目表，没配的模型会单独列出来。',
  }
}

/**
 * AI 派单失败的退避计划：第 1 次失败等 base，第 2 次等 base×factor……
 * 超过 max 次就不再自动重试，改成挂阻塞等人。
 */
export function agentRetryPlan(config, failures) {
  const retry = (config?.agents ?? {}).retry ?? {}
  const max = Math.max(0, Math.min(6, Number(retry.max ?? 2)))
  const base = Math.max(1000, Math.min(600000, Number(retry.baseMs ?? 60000)))
  const factor = Math.max(1, Math.min(6, Number(retry.factor ?? 2)))
  const exhausted = failures > max
  const delayMs = exhausted ? 0 : Math.min(Math.round(base * Math.pow(factor, Math.max(0, failures - 1))), 30 * 60000)
  return { max, base, factor, exhausted, delayMs }
}

/** 记一次 AI 失败：计数、退避时间、历史、通知；超过上限就挂阻塞。 */
export async function noteAgentFailure(store, taskId, error, by = '系统', opts = {}) {
  const state = store.snapshot()
  const task = state.tasks.find(entry => entry.id === taskId)
  if (task === undefined) return undefined
  const next = Math.max(0, Number(task.agentFailures) || 0) + 1
  const plan = agentRetryPlan(state.config, next)
  const now = Date.now()
  const message = String(error?.message ?? error ?? '未知错误').slice(0, 200)
  await store.mutate(draft => {
    const found = draft.tasks.find(entry => entry.id === taskId)
    if (found === undefined) return
    found.agentFailures = next
    found.retryAt = plan.exhausted ? 0 : now + plan.delayMs
    found.history = [...(found.history ?? []), {
      at: now,
      by,
      status: found.status,
      note: plan.exhausted
        ? `AI 第 ${next} 次失败，超过自动重试上限（${plan.max} 次），已挂阻塞等人处理：${message}`
        : `AI 第 ${next} 次失败，${Math.max(1, Math.round(plan.delayMs / 1000))} 秒后自动重试：${message}`,
    }]
    if (plan.exhausted) found.blocked = { reason: `AI 连续 ${next} 次失败：${message}`, at: now, by }
    found.updatedAt = now
  })
  if (opts.notify !== false) {
    const text = plan.exhausted
      ? `【AI 失败·已升级】${task.title}\n第 ${next} 次失败：${message}\n已挂起等人处理，修好后点「重新派单」`
      : `【AI 失败·将重试】${task.title}\n第 ${next} 次失败：${message}\n${Math.max(1, Math.round(plan.delayMs / 1000))} 秒后自动重试（上限 ${plan.max} 次）`
    host.feishuBroadcast(store.snapshot().config, text).catch(cause => {
      host.INTEGRATION.lastPushError = String(cause?.message ?? cause).slice(0, 300)
    })
  }
  emitEvent('agent/failed', { taskId, attempts: next, exhausted: plan.exhausted, error: message, by })
  return { failures: next, ...plan, message }
}

/** 重新派单：清掉失败计数、退避时间和系统挂的阻塞。 */
export async function clearAgentFailure(store, taskId, by = '人') {
  const now = Date.now()
  let changed = false
  await store.mutate(draft => {
    const found = draft.tasks.find(entry => entry.id === taskId)
    if (found === undefined) return
    const wasBlocked = found.blocked !== null && found.blocked !== undefined
    found.agentFailures = 0
    found.retryAt = 0
    if (wasBlocked && String(found.blocked?.by ?? '') === '系统') found.blocked = null
    found.history = [...(found.history ?? []), { at: now, by, status: found.status, note: '手动清掉 AI 失败计数，重新派单' }]
    found.updatedAt = now
    changed = true
  })
  return changed
}

/** 多实例部署时的派单租约锁：谁在 ttl 内续上租约，谁负责这一轮派单。 */
export const INSTANCE_ID = `${process.pid}-${randomBytes(3).toString('hex')}`

export function claimDispatchLock(store, ttlMs = 12_000) {
  const db = store?.db ?? null
  if (db === null) return true
  const now = Date.now()
  try {
    db.prepare('INSERT INTO locks (name, owner, at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, at = excluded.at WHERE locks.at < ?')
      .run('dispatch', INSTANCE_ID, now, now - ttlMs)
    const row = db.prepare('SELECT owner FROM locks WHERE name = ?').get('dispatch')
    return row !== undefined && row.owner === INSTANCE_ID
  } catch {
    return true
  }
}

export function dispatchLockInfo(store) {
  try {
    const row = store?.db?.prepare('SELECT owner, at FROM locks WHERE name = ?').get('dispatch')
    return row === undefined ? null : { owner: row.owner, at: Number(row.at) || 0, mine: row.owner === INSTANCE_ID }
  } catch {
    return null
  }
}

/** 目录存不存在：项目「本机代码目录」配错时，不能靠 mkdir 把空目录造出来再当成仓库用。 */
async function directoryExists(dir) {
  try {
    return (await stat(dir)).isDirectory()
  } catch {
    return false
  }
}

export class Dispatcher {
  constructor(ctx, store) {
    this.ctx = ctx
    this.store = store
    this.timer = undefined
    this.running = new Map()
    this.log = []
    this.lastTickAt = 0
    this.lastError = ''
    this.deliveryVia = ''
  }

  /** The live config (a card's dispatch policy is read at tick time). */
  config() {
    return this.store.snapshot().config
  }

  /** Ring-buffer one diagnostic line. */
  note(line) {
    this.log.unshift({ at: Date.now(), line: String(line).slice(0, 400) })
    if (this.log.length > 40) this.log.length = 40
  }

  start() {
    if (this.timer !== undefined) return
    // 上一次进程结束时正在跑的会话已经不在了，卡上的「AI 处理中」要跟着收掉。
    void this.reconcile()
    this.timer = setInterval(() => {
      this.tick().catch(error => { this.lastError = String(error?.message ?? error) })
    }, 5000)
    this.timer.unref?.()
  }

  /** 把上次进程留下的 running 印记改成 stopped，免得看板一直显示「AI 处理中」。 */
  async reconcile() {
    const state = this.store.snapshot()
    for (const task of state.tasks) {
      if (task.dispatch?.state !== 'running') continue
      /* 必须把 status 一起清掉：tick() 的判据是「dispatch.status === task.status 就跳过」，
         只改 state 会让这张卡永久停摆 —— 看着是"已停止"，实际再也不会被派单。
         清掉 status 之后，下一轮 tick 会重新拾起它（并把本轮记为一次 abandoned 尝试）。 */
      const retry = abandonedRetry(task.dispatch)
      await markDispatch(this.store, task.id, { state: 'stopped', at: Date.now(), status: '', attempts: retry.attempts })
      /* 这一轮是"进程没跑完就没了"，要留痕：事件 + 卡片历史。
         以前只静默清印记，事后完全看不出这张卡崩过几次（事件账本里也只有业务事件）。 */
      emitEvent('task/abandoned', {
        taskId: task.id,
        title: task.title,
        attempts: retry.attempts,
        exhausted: retry.exhausted,
        sessionId: String(task.dispatch?.sessionId ?? ''),
        reason: 'process-restart',
      })
      await this.store.mutate(state => {
        const target = state.tasks.find(entry => entry.id === task.id)
        if (target === undefined) return
        target.history = [...(target.history ?? []), {
          at: Date.now(),
          by: 'dispatcher',
          status: target.status,
          note: `abandoned：上次进程结束时这张卡还在跑（第 ${retry.attempts} 次尝试）`,
        }]
      }).catch(() => {})
      this.note(`清掉上次进程留下的派单印记，允许重新派单 ${task.id}（第 ${retry.attempts} 次尝试）`)
    }
  }

  stop() {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Drop a card from the running set once its agent goes idle. */
  settle(sessionId) {
    for (const [slot, info] of this.running) {
      if (info.sessionId !== sessionId) continue
      this.running.delete(slot)
      markDispatch(this.store, info.taskId, { ...info, state: 'idle', at: Date.now() }).catch(() => {})
      settleRun(sessionId)
      // 会话刚空闲：趁 session 还活着，把引擎自己的 token 计量取下来（真实构成，不是估算）
      void this.captureMeasurement(sessionId, info).catch(() => {})
      this.note(`${sessionId} went idle`)
      return
    }
  }

  /**
   * 宿主把 sessionProjections 暴露给插件，其中 tokenMeasurement 就是引擎的计量。
   * stateOf(session, key) 要的是**活会话对象**（传字符串会 session.snapshotEvents 报错），
   * 所以只能在会话还活着的时候取——会话空闲就是最后的机会。
   */
  async captureMeasurement(sessionId, info) {
    const service = host.sessionProjections
    if (service === null || service === undefined || typeof service.stateOf !== 'function') return
    const agent = this.ctx.agents?.get?.(sessionId)
    const session = agent?.session
    if (session === null || session === undefined) return
    const measured = service.stateOf(session, 'tokenMeasurement')
    if (measured === null || measured === undefined) return
    let data
    try { data = JSON.parse(JSON.stringify(measured)) } catch { return }
    await this.store.mutate(state => {
      const task = state.tasks.find(item => item.id === info.taskId)
      if (task === undefined) return
      task.insight = { source: 'tokenMeasurement', at: Date.now(), sessionId, data }
    }).catch(() => {})
    this.note('tokenMeasurement captured for ' + info.taskId)
  }

  /** Is any expert already working this card? */
  busy(taskId) {
    for (const info of this.running.values()) if (info.taskId === taskId) return true
    return false
  }

  /** Stop whatever an expert is doing on this card (still keeps its output). */
  abortTask(taskId, expertId) {
    let stopped = 0
    for (const [slot, info] of [...this.running]) {
      if (info.taskId !== taskId) continue
      if (typeof expertId === 'string' && expertId !== '' && info.expert !== expertId) continue
      this.running.delete(slot)
      markDispatch(this.store, info.taskId, { ...info, state: 'stopped', at: Date.now() }).catch(() => {})
      try { this.ctx.agents.get(info.sessionId)?.abort?.() } catch { /* best effort */ }
      this.note(`${info.sessionId} aborted`)
      stopped += 1
    }
    return stopped
  }

  /** 缺陷卡超过 SLA 还没关：记一次升级并推飞书，避免一直躺着没人管。 */
  async escalateOverdue() {
    const state = this.store.snapshot()
    const now = Date.now()
    for (const task of state.tasks) {
      const sla = host.bugSla(task, state.config)
      if (sla === null || sla.state !== 'overdue') continue
      if ((Number(task.escalatedAt) || 0) > 0) continue
      const overdueHours = Math.max(1, Math.round(-sla.remaining / 3_600_000))
      await this.store.mutate(draft => {
        const found = draft.tasks.find(item => item.id === task.id)
        if (found === undefined) return
        found.escalatedAt = now
        found.history = [...(found.history ?? []), { at: now, status: found.status, by: '系统', note: `SLA 超时 ${overdueHours} 小时，已升级提醒` }]
      })
      await host.feishuBroadcast(
        this.store.snapshot().config,
        `【SLA 超时】${task.code || task.id} ${task.title}\n严重度 ${String(sla.severity).toUpperCase()}，超时约 ${overdueHours} 小时`,
        'sla',
      ).catch(() => undefined)
      this.note(`SLA 超时升级 ${task.code || task.id}`)
    }
  }

  /** Diagnostics for the panel and for debugging the agent APIs. */
  status() {
    const cfg = this.store.snapshot().config.agents
    return {
      enabled: cfg.enabled,
      maxConcurrent: cfg.maxConcurrent,
      // 实际生效的并发（隔离不足时会低于 maxConcurrent），面板据此给出提示
      effectiveMaxConcurrent: effectiveConcurrency(cfg).limit,
      isolationWarning: effectiveConcurrency(cfg).reason,
      autoStatuses: cfg.autoStatuses,
      workspaceDir: cfg.workspaceDir,
      agentPreset: cfg.agentPreset,
      sandbox: cfg.sandbox ?? 'workspace-write',
      isolation: cfg.isolation ?? 'none',
      // 每张卡的 worktree 根按它自己的仓库算（仓库内 .agents/worktrees）；这里给的是没仓库时的兜底根。
      worktreeRoot: worktreeRoot(this.store.snapshot().config),
      cleanupWorktree: cfg.cleanupWorktree ?? 'manual',
      running: [...this.running.values()].map(info => ({ ...info })),
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
      deliveryVia: this.deliveryVia,
      instance: INSTANCE_ID,
      lock: dispatchLockInfo(this.store),
      log: this.log.slice(0, 20),
    }
  }

  /** One pass: hand every eligible card to its column owner, up to the cap. */
  async tick() {
    this.lastTickAt = Date.now()
    // 多实例部署时同一张卡只能被一个进程派出去：抢不到租约就跳过这一轮。
    if (!claimDispatchLock(this.store)) return
    await this.escalateOverdue()
    const state = this.store.snapshot()
    const cfg = state.config.agents
    if (!cfg.enabled) return
    // 卡被删掉后，替它跑着的槽位要自己收回来，否则并发名额会被幽灵会话占死。
    const alive = new Set(state.tasks.map(task => task.id))
    for (const [slot, info] of [...this.running.entries()]) {
      if (!alive.has(info.taskId)) {
        this.note(`drop ghost slot ${slot} (${info.taskId} 已删除)`)
        this.abortTask(info.taskId, info.expert)
      }
    }
    // 并发只有在「每张卡一个 worktree」时才安全：隔离是 none 时多张卡会在同一目录互相覆盖。
    // effectiveConcurrency 会把这种组合的有效并发降到 1，并把原因留在状态里（不静默）。
    const concurrency = effectiveConcurrency(cfg)
    const limit = concurrency.limit
    if (concurrency.capped === true && this.lastConcurrencyWarning !== concurrency.reason) {
      this.lastConcurrencyWarning = concurrency.reason
      this.note(concurrency.reason)
    }
    const auto = new Set(Array.isArray(cfg.autoStatuses) ? cfg.autoStatuses : [])
    // 完成的卡按策略回收它的 worktree（manual 就留着等人看 diff）。
    if (String(cfg.cleanupWorktree ?? 'manual') === 'on_done') {
      for (const task of state.tasks) {
        if (task.status !== 'done' || task.worktree === null || task.worktree === undefined) continue
        const result = await host.removeWorktree(this.store, task, state.config)
        this.note(`cleanup worktree ${task.code || task.id}: ${result.ok ? 'removed' : (result.error ?? result.skipped ?? 'failed')}`)
      }
    }
    for (const task of state.tasks) {
      if (this.running.size >= limit) break
      if (this.busy(task.id)) continue
      // 阻塞的卡停在原地等人处理，不自动往下派。
      if (task.blocked !== null && task.blocked !== undefined) continue
      // 上次失败还在退避窗口里：到点再试，别每 5 秒硬撞。
      if ((Number(task.retryAt) || 0) > Date.now()) continue
      if (!auto.has(task.status)) continue
      const column = STATUSES.find(entry => entry.id === task.status)
      if (column === undefined) continue
      // 这一列没人负责（或没匹配到领域专家）就停着，等人指派，不算失败。
      if (ownerFor(state.config, task, column, this.loadByExpert(), state) === undefined) continue
      // One hand-off per (card, column): after that the card waits for a human
      // or for the agent to move it on. "马上处理" is the way to run it again.
      if (task.dispatch?.status === task.status) continue
      const key = `${task.id}:${task.status}`
      await this.launch(task, column, key).then(async () => {
        // 派单成功：把失败计数清掉，避免历史失败影响下一次判断。
        if ((Number(task.agentFailures) || 0) > 0) {
          await this.store.mutate(draft => {
            const found = draft.tasks.find(entry => entry.id === task.id)
            if (found === undefined) return
            found.agentFailures = 0
            found.retryAt = 0
          })
        }
      }).catch(async error => {
        this.lastError = String(error?.message ?? error).slice(0, 400)
        this.note(`launch ${task.id} failed: ${this.lastError}`)
        await markDispatch(this.store, task.id, { key, status: task.status, state: 'failed', error: this.lastError, at: Date.now() })
        // 失败要退避重试；连续失败超过上限就升级成人处理。
        await noteAgentFailure(this.store, task.id, error).catch(() => {})
      })
    }
  }

  /** Force one card through the same path, used by the panel's "马上处理" button. */
  async launchNow(id, expertId) {
    const task = this.store.snapshot().tasks.find(entry => entry.id === id)
    if (task === undefined) throw new Error(`no task ${id}`)
    const column = STATUSES.find(entry => entry.id === task.status) ?? STATUSES[0]
    const key = `${task.id}:${task.status}:manual:${Date.now()}`
    if (typeof expertId === 'string' && expertId.length > 0) {
      await this.launch(task, column, key, { owner: { kind: 'expert', id: expertId } })
      return
    }
    await this.launch(task, column, key)
  }

  /** Hand a card to whoever a comment just @mentioned. */
  async dispatchMention(taskId, mention, instruction) {
    const task = this.store.snapshot().tasks.find(entry => entry.id === taskId)
    if (task === undefined) throw new Error(`no task ${taskId}`)
    const column = STATUSES.find(entry => entry.id === task.status) ?? STATUSES[0]
    await this.launch(task, column, `${task.id}:${task.status}:mention:${Date.now()}`, {
      owner: { kind: mention.kind, id: mention.id },
      instruction,
    })
  }

  /** 每个专家手上正在跑几张卡——轮询策略靠它挑人。 */
  loadByExpert() {
    const map = new Map()
    for (const info of this.running.values()) {
      const key = info.expert ?? ''
      if (key.length === 0) continue
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return map
  }

  async launch(task, column, key, extra = {}) {
    const config = this.store.snapshot().config
    const cfg = config.agents
    const resolved = extra.owner !== undefined
      ? resolveOwner(config, extra.owner)
      : ownerFor(config, task, column, this.loadByExpert(), this.store.snapshot())
    if (resolved === undefined) {
      throw new Error(`「${column.label}」这一列还没人负责：在卡上选一个专家，或到「设置 → 列的负责人」里指定`)
    }
    const expert = resolved.expert
    const sessionId = `studio-${task.id}-${expert.id}`
    const slot = `${task.id}#${expert.id}`
    this.running.set(slot, { taskId: task.id, sessionId, expert: expert.id, team: resolved.team?.id ?? '', at: Date.now(), state: 'running' })
    try {
      const agent = await this.ensureSession(sessionId, task, expert, cfg)
      await markDispatch(this.store, task.id, {
        key,
        status: task.status,
        expert: expert.id,
        team: resolved.team?.id ?? '',
        sessionId,
        state: 'running',
        at: Date.now(),
      })
      const requirement = this.store.snapshot().requirements.find(entry => entry.id === task.requirementId)
      // 团级记忆：这个团最近经手过什么，接活前先看一眼。
      let teamMemory = []
      if (resolved.team !== undefined) {
        const memory = await loadTeamMemory(this.store).catch(() => ({}))
        teamMemory = Array.isArray(memory[resolved.team.id]) ? memory[resolved.team.id] : []
      }
      const prompt = buildExpertPrompt(task, expert, column, config, resolved.team, extra.instruction, requirement, this.store.snapshot(), teamMemory)
      const via = await this.deliver(agent, sessionId, prompt)
      this.deliveryVia = via
      this.lastError = ''
      recordRun({
        taskId: task.id,
        taskCode: task.code || task.id,
        sessionId,
        expert: expert.id,
        // 卡上真正指派的专家 id：列负责人是「角色位」时，expert.id 是角色（dev），
        // 只按它统计会把同一个人的记录拆成两行（dev 有派单、expert-xxx 有卡）。
        expertId: String(task.expert ?? ''),
        expertName: expert.name,
        model: String(this.modelFor(expert)?.model ?? ''),
        promptVersion: String(expert.promptVersion ?? ''),
      })
      this.note(`dispatched ${task.id} → ${expert.name} via ${via}`)
    } catch (error) {
      this.running.delete(slot)
      throw error
    }
  }

  /**
   * 会话的模型是否和配置对不上；对不上就 abort + 归档目录 + 重建一次。
   * 只重建一次：重建后仍不一致说明宿主把型号固定在别处（例如 preset），
   * 那种情况给出明确提示让人重启 dsh，而不是无限重建把卡拖死。
   */
  async guardModelDrift({ handle, sessionId, dir, agentOptions, task, openSession }) {
    const readModel = candidate => candidate?.agent?.session?.requestContext?.()
    const current = readModel(handle)
    if (isModelDrift(current, agentOptions) === false) return handle
    this.note(driftNote(current, agentOptions))
    await this.commentDrift(task, driftNote(current, agentOptions))
    try { await handle.dispose?.() } catch (error) { this.note(`dispose 失败：${error?.message ?? error}`) }
    const from = sessionDirOf(homedir(), dir, sessionId)
    if (from !== '') {
      try { await rename(from, `${from}.stale-${Date.now()}`) } catch (error) { this.note(`归档旧会话失败：${error?.message ?? error}`) }
    }
    const rebuilt = await openSession()
    const after = readModel(rebuilt)
    if (isModelDrift(after, agentOptions)) {
      this.note(`重建后仍是 ${after?.provider ?? '?'}/${after?.model ?? '?'}：宿主可能把型号固定在别处，需要重启 dsh`)
    } else {
      this.note(`已按配置重建会话（${agentOptions?.provider ?? ''}/${agentOptions?.model ?? ''}）`)
    }
    return rebuilt
  }

  /** 漂移写进卡上：否则只有翻会话日志才知道「配置是 Flash、实际跑 Pro」。 */
  async commentDrift(task, note) {
    if (typeof host.commentTask !== 'function' || task === undefined) return
    try { await host.commentTask(this.store, task.id, note, '系统', 'agent') } catch { /* 留言失败不影响派单 */ }
  }

  /**
   * Open the card's Session through the Agent factory. `agents.create` starts
   * the driver loop, so a followup message actually wakes a turn; the session
   * controller alone only records the conversation.
   */
  async ensureSession(sessionId, task, expert, cfg) {
    const ctx = this.ctx
    const live = ctx.agents.get(sessionId)
    if (live !== undefined) return live
    const base = (cfg.workspaceDir ?? '').trim() || join(homedir(), 'dsh-workspace')
    // 一卡一 worktree：配了 project.repoPath 且 isolation=worktree 时，这个会话
    // 只看得到自己那张卡的分支，互不踩文件。
    let worktree
    try {
      worktree = await host.ensureWorktree(this.store, task, this.config())
    } catch (error) {
      this.note(`worktree: ${error?.message ?? error}`)
    }
    if (worktree?.skipped !== undefined) this.note(`worktree skipped: ${worktree.skipped}`)
    /* 会话跑在哪个目录，决定了它在 DSH 侧栏里属于哪个工作区（按 canonical cwd 归属）：
       项目配了「本机代码目录」就跑到那个仓库里，会话才落在项目工作区下；否则退回工作区目录。
       以前一律跑 workspaceDir 的临时目录，派出去的会话只能落在「未分组」。 */
    const context = projectContext(this.config(), task, this.store.snapshot().requirements)
    const plan = dispatchDirFor({ task, worktree, context, fallbackDir: base })
    let dir = plan.dir !== '' ? plan.dir : base
    let title = plan.title
    if (plan.kind === 'repo' && !(await directoryExists(dir))) {
      this.note(`项目代码目录不存在，退回工作区目录：${dir}`)
      dir = base
      title = STUDIO_WORKSPACE_TITLE
    }
    await mkdir(dir, { recursive: true })
    try {
      await ctx.workspaceRegistry.create(dir, title)
    } catch (error) {
      this.note(`workspace: ${error?.message ?? error}`)
    }
    this.note(`会话目录（${title}）：${dir}`)
    let agent
    // A session created by the factory carries no model unless we hand one in;
    // without it every turn ends with "agent has no provider/model".
    const agentOptions = this.modelFor(expert)
    // `meta.agentPreset` only snapshots the name — the tools/persona arrive
    // through the factory's setup callback, which mounts the preset into the
    // new agent's scope. Without it the card agent sees no shell and no fs.
    const composition = await this.composeSession(expert, cfg)
    const options = {
      sessionId,
      meta: { cwd: dir, ...(composition !== undefined ? { agentPreset: composition.agentPreset } : {}) },
      ...(composition !== undefined ? { setup: composition.setup } : {}),
      ...(agentOptions !== undefined ? { agentOptions } : {}),
    }
    /* 开一次会话：先 create，撞到同名会话就退回 resume。两条路都返回 handle ——
       漂移守卫要靠 handle.dispose() 才能真正把这轮会话换掉。 */
    const openSession = async () => {
      try {
        return await ctx.agents.create(options)
      } catch (error) {
        this.note(`create fell back to resume: ${error?.message ?? error}`)
        return await ctx.agents.resume({
          resumeSessionId: sessionId,
          ...(composition !== undefined ? { setup: composition.setup } : {}),
          ...(agentOptions !== undefined ? { agentOptions } : {}),
        })
      }
    }
    let handle = await openSession()
    /* 模型漂移守卫：宿主把模型固化在会话创建时，改专家设置不影响老会话；
       create 撞到老会话又会静默 resume。于是「配 Flash、实际跑 Pro」能一直存在，
       直到有人去解会话日志才发现。这里每次派单前比一次，不一致就归档旧会话重建。 */
    handle = await this.guardModelDrift({ handle, sessionId, dir, agentOptions, task, openSession })
    agent = handle.agent
    // 沙箱档位：专家自己的设置优先，否则跟随全局。解析不出可用档位时落到
    // workspace-write（安全默认）——绝不因为「没配」而悄悄全开。
    const wanted = String(expert?.sandbox ?? '').trim() || String(cfg.sandbox ?? '').trim()
    let sandbox = SANDBOX_MODES.includes(wanted) ? wanted : 'workspace-write'
    if (!SANDBOX_MODES.includes(wanted)) this.note(`sandbox "${wanted}" 不认识，按 workspace-write 执行`)
    // worktree 隔离时，提交要写主仓的 .git（在 worktree 之外），workspace-write 会直接拒绝并弹审批；
    // 无人值守的会话就卡死等审批（2026-11-16 实测：approval/asked 后再无动作）。
    // 所以 worktree 模式一律提权到 danger-full-access，并在卡上留一句解释。
    if (String(cfg.isolation ?? 'none') === 'worktree' && sandbox !== 'danger-full-access') {
      sandbox = 'danger-full-access'
      this.note('worktree 隔离需要写主仓 .git 才能提交，沙箱提到 danger-full-access')
    }
    try {
      ctx.permissionPresets.set(agent.session, sandbox)
    } catch (error) {
      this.note(`permission preset ${sandbox} failed: ${error?.message ?? error}`)
    }
    /* 审批策略显式设成 ask：有的部署把 workspace-write 这一档的 approval 配成 never，
       那样提权请求根本到不了平台手上（只能被静默拒绝），「自动批准」也就是摆设。
       danger-full-access 本来就不问人，跳过。真正怎么答由 index.js 的 approval/request 决定。 */
    if (sandbox !== 'danger-full-access') {
      try {
        this.ctx.get?.('approval')?.setPolicy?.(agent, 'ask')
      } catch (error) {
        this.note(`approval policy ask failed: ${error?.message ?? error}`)
      }
    }
    try {
      await ctx.sessionController.rename({ sessionId, title: `[${expert.name}] ${task.title}`.slice(0, 120) })
    } catch (error) {
      this.note(`rename failed: ${error?.message ?? error}`)
    }
    return agent
  }

  /**
   * Resolve the role's agent preset and return the composition the factory
   * needs: the preset id for the session header, plus a setup callback that
   * mounts its tools and persona into the new agent's scope.
   */
  async composeSession(expert, cfg) {
    const presets = this.ctx.get?.('agentPresets')
    if (presets === undefined) return undefined
    const wanted = String(expert.preset ?? '').trim() || cfg.agentPreset || 'standard'
    try {
      const resolved = await presets.resolve(wanted)
      return {
        agentPreset: resolved.id,
        setup: async scope => { await presets.mount(scope, resolved.id) },
      }
    } catch (error) {
      this.note(`preset "${wanted}" unavailable: ${error?.message ?? error}`)
      return undefined
    }
  }

  /**
   * Model for one role: the settings override ("provider/model" or a bare model
   * id, in which case the host default provider is borrowed), else the host
   * default selection. Returning undefined lets the factory decide.
   */
  modelFor(expert) {
    const current = this.ctx.agentDefaultModel?.currentSelection?.()
    const configured = String(expert?.model ?? '').trim() || this.store.snapshot().config.roles?.[expert?.id]?.model
    if (typeof configured === 'string' && configured.trim() !== '') {
      const spec = configured.trim()
      const slash = spec.indexOf('/')
      const provider = slash > 0 ? spec.slice(0, slash) : current?.provider
      const model = slash > 0 ? spec.slice(slash + 1) : spec
      if (provider !== undefined && provider !== '') {
        return { provider, model, ...(current?.reasoningEffort ? { reasoningEffort: current.reasoningEffort } : {}) }
      }
    }
    // 最后兜底不用宿主默认模型：宿主默认可能是当前不可用的型号（deepseek-v4-pro 在
    // distributor 上没有通道，整轮 turn/end 直接 503，表现为「派了但没讨论」）。
    return {
      provider: String(current?.provider ?? 'deepseek-official'),
      model: FALLBACK_AGENT_MODEL,
      ...(current?.reasoningEffort ? { reasoningEffort: current.reasoningEffort } : {}),
    }
  }

  /** Diagnostics: which card sessions are live and what the driver thinks. */
  async probePrompt() {
    const live = (this.ctx.agents.list?.() ?? []).map(agent => ({
      id: agent.id,
      status: agent.status,
    }))
    return { live, running: [...this.running.keys()] }
  }

  /**
   * Deliver the work order. `inject` stages framing without waking the driver,
   * `followup` queues the user turn and wakes it — both must carry a serializable
   * source listed in MessageSourceMap (`user` is the one every build has).
   */
  async deliver(agent, sessionId, text) {
    const stamp = Date.now()
    agent.inject({
      id: `studio:${sessionId}:${stamp}:frame`,
      role: 'user',
      content: [{ type: 'text', text: '【需求&任务工作空间派单】下面是看板发来的工作指令。完成后必须调用 studio_task_comment 记录结论，并调用 studio_task_update 把卡片推进到下一列。' }],
      source: { kind: 'user' },
    })
    agent.followup({
      id: `studio:${sessionId}:${stamp}:body`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    this.deliveryVia = 'followup'
    return 'followup'
  }
}

/** The work order one expert (or a whole team) receives. */
export function buildExpertPrompt(task, expert, column, config, team, instruction, requirement, state, teamMemory = []) {
  const recent = (task.comments ?? []).slice(-6).map(entry => `- [${entry.author}] ${entry.body}`).join('\n')
  const members = team === undefined
    ? ''
    : (team.members ?? [])
      .map(id => (config.experts ?? []).find(entry => entry.id === id))
      .filter(Boolean)
      .map(entry => `- @${entry.name}：${entry.description || ROLE_BRIEF[entry.id] || '按分工协作'}`)
      .join('\n')
  return [
    `你是「${expert.name}」，需求&任务工作空间里的一名专家。现在接手工作看板上的一张卡。`,
    expert.description ? `\n你的定位：${expert.description}` : '',
    expert.domain ? `\n业务领域：${expert.domain}（判断与取舍以这个领域的规范和风险偏好为准）` : '',
    (expert.skills ?? []).length > 0 ? (() => {
      /* 技能注入按「这个项目用得上吗」过滤：
         - 停用的技能不注入（它也没落成 SKILL.md，注入只会让 agent 去加载一个不存在的东西）；
         - 声明了 projects 的技能只在这些项目里注入，其余情况给一句「这个项目用不上」，避免救命技能被静默吞掉。
         注入还没就绪时必须容忍没有技能库（以前写成裸 activeSkills，一派单就 ReferenceError）。 */
      const library = host.getActiveSkills?.()
      const projectId = String(task.project ?? '').trim()
      const usable = []
      const skipped = []
      for (const name of expert.skills ?? []) {
        const known = library?.get?.(name)
        if (known === undefined) {
          usable.push(name)
          continue
        }
        if (known.enabled === false) {
          skipped.push(`${name}（已停用）`)
          continue
        }
        const scope = Array.isArray(known.projects) ? known.projects : []
        if (scope.length > 0 && !scope.includes(projectId)) {
          skipped.push(`${name}（只用于 ${scope.join(' / ')}）`)
          continue
        }
        usable.push(`${name}（${known.description}）`)
      }
      if (usable.length === 0) return skipped.length === 0 ? '' : `\n这个项目用不上的技能：${skipped.join('、')}`
      const tail = skipped.length === 0 ? '' : `\n这个项目用不上的技能：${skipped.join('、')}`
      return `\n你可以使用的技能：${usable.join('、')}。需要时调用 skill 工具加载对应技能，再按其说明操作。${tail}`
    })() : '',
    team !== undefined ? `\n你在「${team.name}」专家团里协作，本团成员：\n${members}` : '',
    /* 图里「选中交互稿与 PRD 交给研发」那根箭头：定案的那一稿要真的进派单提示词，
       否则研发只能照自己的理解做，设计评审就白评了。 */
    (() => {
      const design = task.design ?? null
      if (design === null) return ''
      const drafts = Array.isArray(design.drafts) ? design.drafts : []
      const picked = drafts.find(item => item.id === design.chosenId)
      if (picked !== undefined) {
        const others = drafts.length - 1
        return `\n设计定案（按这一稿实现，别按自己的理解改版）：${picked.name}${picked.link === '' ? '' : ` ${picked.link}`}${picked.note === '' ? '' : `（${picked.note}）`}${others > 0 ? `；另有 ${others} 稿未采用` : ''}`
      }
      if (design.link !== '') return `\n设计稿：${design.link}（还没定案，实现前先确认是哪一稿）`
      if (drafts.length > 0) return `\n设计有 ${drafts.length} 稿但还没定案：先确认用哪一稿，再动手`
      return ''
    })(),
    teamMemoryBlock(teamMemory),
    '',
    `任务号：${task.id}${task.code ? `（${task.code}）` : ''}`,
    `标题：${task.title}`,
    (() => {
      if (requirement === undefined) return ''
      const links = requirement.links ?? {}
      const extra = [links.prd ? `PRD ${links.prd}` : '', links.proto ? `原型 ${links.proto}` : '', links.acceptance ? `验收标准 ${links.acceptance}` : ''].filter(Boolean).join('；')
      return `所属需求：${requirement.code || requirement.id}｜${requirement.title}${extra ? `（${extra}）` : ''}`
    })(),
    /* 功能点的验收条件必须进提示词：以前任何角色都看不到「要验什么」，只能自己从标题猜。
       测试尤其需要逐条对：验收条件才是「测全面」的锚点，不是用例数量。 */
    (() => {
      if (requirement === undefined) return ''
      const points = Array.isArray(requirement.points) ? requirement.points : []
      if (points.length === 0) return ''
      const shown = points.slice(0, 8)
      const lines = shown.map(point => {
        const acceptance = (Array.isArray(point.acceptance) ? point.acceptance : [])
          .filter(item => String(item.text ?? '').trim() !== '')
          .slice(0, 4)
        const head = `- ${point.id} ${point.title}`
        if (acceptance.length === 0) return `${head}（还没写验收条件）`
        return `${head}\n${acceptance.map(item => `  · ${item.id} ${String(item.text).slice(0, 120)}`).join('\n')}`
      })
      const more = points.length > shown.length ? `\n（还有 ${points.length - shown.length} 个功能点没列出来，用 studio_requirement_get 看全）` : ''
      return `\n需求的功能点与验收条件（工作与验收都按这里逐条对，别自己另起一套口径）：\n${lines.join('\n')}${more}`
    })(),
    `当前列：${column.label}`,
    `优先级：${task.priority}`,
    task.project ? `所属项目：${(config.projects ?? []).find(entry => entry.id === task.project)?.name ?? task.project}${task.iteration ? ` · 迭代 ${(config.projects ?? []).find(entry => entry.id === task.project)?.iterations?.find(iter => iter.id === task.iteration)?.name ?? task.iteration}` : ''}` : '',
    task.dueAt > 0 ? `期望完成：${new Date(task.dueAt).toISOString().slice(0, 10)}` : '',
    (() => {
      const service = host.serviceOf(config, task)
      if (service === undefined) return ''
      const hasWorktree = task.worktree !== null && task.worktree !== undefined
      if (hasWorktree) return `服务：${service.name}（worktree 见下，别在服务主目录里改）`
      const base = String(service.baseBranch ?? '').trim() || 'main'
      return `服务：${service.name}${service.repoPath ? `（本机代码目录 ${service.repoPath}，基线分支 ${base}）` : '（这个服务还没配本机代码目录）'}`
    })(),
    (() => {
      const service = host.serviceOf(config, task)
      const project = host.workProjectOf(config, task)
      if (service === undefined || project === undefined) return ''
      const names = (service.dependsOn ?? [])
        .map(id => (project.services ?? []).find(one => one.id === id)?.name)
        .filter(name => name !== undefined)
      if (names.length === 0) return ''
      return `本服务依赖：${names.join('、')}（这些服务的改动先落地；如果本卡要改它们依赖的接口，先在评论里写清兼容方案，别直接改协议）`
    })(),
    (() => {
      const conflict = host.serviceConflicts(state ?? { config, tasks: [task] }, task)
      if (conflict === undefined) return ''
      return `同服务并行：这个服务上还有 ${conflict.count} 张卡在改（${conflict.tasks.map(item => item.code).join('、')}）。只改本卡范围，动公共文件前先看别人的分支，必要时在评论里打招呼，别把别人的改动顶掉。`
    })(),
    task.owner ? `业务负责人：${task.owner}` : '',
    task.expert ? `当前指派专家：${task.expert}` : '',
    (task.checklist ?? []).length > 0
      ? `\n这张卡的验收清单（做完一项就勾一项，没做完别勾）：\n${(task.checklist ?? []).map(item => `${item.done ? '☑' : '☐'} ${item.id} ${item.text}${item.note ? `（${item.note}）` : ''}`).join('\n')}`
      : '',
    (task.artifacts ?? []).length > 0
      ? `\n已登记的交付物：\n${(task.artifacts ?? []).map(item => `- [${item.kind}] ${item.title}${item.ref ? ` → ${item.ref}` : ''}（${item.status}）`).join('\n')}`
      : '',
    (task.cases ?? []).length > 0
      ? `\n已登记的测试用例：\n${(task.cases ?? []).map(item => `- ${item.result === 'pass' ? '✅' : item.result === 'fail' ? '❌' : item.result === 'skip' ? '⏭️' : '⬜'} ${item.id} ${item.title}${item.expected ? `（期望：${item.expected}）` : ''}${item.note ? ` — ${item.note}` : ''}`).join('\n')}`
      : '',
    /* 卡上有「跑不了」的用例时，不看列：谁接手谁负责补断言。
       以前只有测试列的提示词提这件事，于是别的列推进卡片时把 41 条空壳一路带到了待验收。 */
    (() => {
      /* 判「跑不了」要认四种执行方式：以前漏了 browser，浏览器用例被当成空壳，
         提示词反复让专家去补一条已经能跑的用例。 */
      const bare = (task.cases ?? []).filter(item => item.http == null && item.shell == null && item.db == null && item.browser == null)
      if (bare.length === 0) return ''
      const names = bare.slice(0, 5).map(item => item.title).join('、')
      return `\n这张卡上有 ${bare.length} 条用例没有可执行断言（跑不了，也不计入覆盖率）：${names}${bare.length > 5 ? ' 等' : ''}。
它们不能靠「标成通过」过关。你手上有对应的验证条件时，用 studio_task_add_cases 把断言补上（接口给 method + path + expectStatus，shell 给 command + expectExit，数据库给 db，浏览器给 browser；可带 tier=unit / integration / e2e），工具会当场试跑一条并把结果回给你；确实补不了就在评论里说明为什么，别留空壳。`
    })(),
    (task.gitlabMR?.iid ?? 0) > 0 ? `\n关联 MR：!${task.gitlabMR.iid} ${task.gitlabMR.title}（${task.gitlabMR.state}）${task.gitlabMR.url ? ` ${task.gitlabMR.url}` : ''}` : '',
    task.coding !== null && task.coding !== undefined && codingSummary(task.coding) !== ''
      ? `\n这一棒的 AI Coding 执行记录：${codingSummary(task.coding)}${task.coding.branch ? `（分支 ${task.coding.branch}）` : ''}${task.coding.review.status === 'changes_requested' && task.coding.review.note ? `\n评审意见：${task.coding.review.note}` : ''}`
      : '',
    task.reqBaseline ? `\n这张卡是按需求基线 ${task.reqBaseline.version}（${task.reqBaseline.title}）开的，改动要对着这一版。` : '',
    task.worktree !== null && task.worktree !== undefined
      ? `\n你的工作目录是这张卡专属的 git worktree：${task.worktree.path}${task.worktree.serviceName ? `（服务：${task.worktree.serviceName}）` : ''}\n分支 ${task.worktree.branch}（基线 ${task.worktree.base}），仓库 ${task.worktree.repo}。只在这个目录里改代码，提交到这条分支，不要动别人的 worktree 或主分支。`
      : '',
    /* 澄清 / 方案阶段先查历史：重复造轮子是这个阶段最贵的浪费，而且事后没人看得出查没查过。
       命中要贴回卡上，没命中也要留一句——否则「跳过」和「查了没找到」长得一模一样（REQ-2026-001 / p3）。 */
    column.id === 'clarify' || column.id === 'design'
      ? `\n这是澄清/方案阶段：**先查历史，再动笔**。
用会话里可用的知识库检索工具（例如 weknora 的 search / ask）拿这次需求的核心业务词查一遍——查「上次同类问题怎么定的」，不要拿需求标题去搜。
- 命中：在评论里写清查了什么、命中的是哪条需求（REQ 编号 / 文档名 / 段落）、你打算沿用还是推翻、为什么；
- 没命中：也要写一句「已检索，无命中」，不要沉默跳过；
- 会话里没有检索工具：写明「本会话没有知识库检索工具」，不要编造查过。
这条评论属于本阶段交付物的一部分：没有它，澄清/方案不算做完。`
      : '',
    column.id === 'dev' || column.id === 'dev_ready'
      ? `\n这是研发环节，做完必须留下可审计的执行记录：调用 studio_task_coding，如实填写 agent/model、分支、commits（sha + message + 改动文件数）、改动文件清单、单测总数与通过数，以及你依据的需求基线版本。没登记执行记录的「完成」不算完成。`
      : '',
    column.id === 'review'
      ? `\n这是评审环节：先读 MR 的改动（glab mr diff 或在 GitLab 上看），逐条对照方案、验收清单和执行记录里的 files / commits / 单测结果，把问题写清楚（文件、行、为什么、建议怎么改）。评完用 studio_task_coding action=review 写结论（approved / changes_requested + 说明）；没问题就说明通过理由，推进到「待测试」，有问题就 @ 开发同学，把卡退回「开发中」。`
      : '',
    task.requirement ? `\n需求描述：\n${task.requirement}` : '',
    column.id === 'test'
      ? (() => {
          const summary = testPlanSummary(task.cases ?? [], task.testPlan)
          const gaps = summary.gaps
          return [
            '\n这是测试环节：目标是**把这张卡验全面**，不是把用例点绿。按三条线走，能验的一条都不能漏。',
            '',
            '第一步先对齐验收口径：上面列出的需求功能点与验收条件、这张卡的验收清单、研发执行记录里的改动文件。把「改了什么 → 哪条验收条件 → 用哪条测试线验」列成一张小表写进评论，再动手写用例。',
            '',
            '三条线各自的落法（都用 studio_task_add_cases 登记，可显式给 tier；不给就按断言推断）：',
            '· 单元测试（tier=unit）：针对这次改动的新增/修改函数与分支，先跑仓库里已有的单测，再补边界值、异常分支、空输入。落成 shell 用例 {title, command, tier:"unit", expectExit:0, expectContains?, cwd}（需要管理员先开 allowShell），cwd 指到这张卡的 worktree；命令按仓库实际情况写（node --test tests/x.test.mjs / npm test / pnpm vitest run / pytest -q / go test ./... 等）。先跑通一条再批量登记。',
            '· 集成测试（tier=integration）：接口、数据库、服务间契约。多步接口用例用 steps：[{method,url,expectStatus,expectContains,extract}]（例如登录拿 token → 调业务接口 → 用返回的 id 查详情）；断言带业务码，别只断言状态码。数据库断言用 {db:{file, sql, expectColumn, expectValue}}（需要先开 allowDb）。',
            '· 端到端测试（tier=e2e）：真开浏览器，从用户入口走主流程与关键异常路径：{browser:{url, expectText, expectSelector, steps:[{click},{fill,text},{waitFor}]}}（需要先开 allowBrowser）。没有前端改动的卡，在测试计划里写明这一层不适用并给出理由。',
            '',
            '硬性要求：',
            '1. 每条用例必须能跑：studio_task_add_cases 会当场试跑第一条，跑不通就改断言/地址再调；只有标题没有断言的「用例」不许写（那是待办，不是用例）。真跑不了的（要人工操作、连设备、看第三方系统）用 studio_task_case 登记成描述型用例，自己执行后回填 result 并写清证据。',
            '2. 用 studio_test_run 让平台真的跑（发请求、比对状态码与响应体、写回结果、留执行记录）。**用例一旦判 fail，平台会自动开缺陷卡（挂同一需求、父任务指向本卡），不要手工再建、也不要重复建**。',
            '3. 三层收口：三条线要么有可执行用例并跑出结论，要么用 studio_task_test_plan 写明「不适用 + 理由」（例如本次只改后端接口、没有前端改动 → e2e 不适用）。准出按这个判定，缺一层会被拦。',
            '4. 登记测试报告（studio_task_artifact，kind=report）：每条线的用例数 / 通过 / 失败 / 未跑，失败项的实际结果与复现路径，遗留风险。',
            '5. 全通过 → 推进到「待验收」；有用例失败 → @ 开发同学退回「开发中」。',
            '',
            `这张卡当前的测试进度：${planLine(summary)}。`,
            gaps.length === 0
              ? '三条线都已有可执行用例。'
              : `缺口：${gaps.map(gap => `${gap.label}（${gap.why}）`).join('、')}——补能跑的用例，或用 studio_task_test_plan 写明不适用 + 理由。`,
            task.bugSource == null ? '' : `\n这张卡来自缺陷 ${task.bugSource.code || task.bugSource.taskId}（用例「${task.bugSource.caseTitle}」）。修复已进入待测试，平台把来源用例重置成了待执行：请复跑这一条，确认通过后把本卡推进到「待验收」，并通过就把缺陷关闭。`,
          ].join('\n')
        })()
      : '',
    task.type === 'bug'
      ? `\n这是一张缺陷卡（严重级别 ${String(task.severity || 'p2').toUpperCase()}），不是新需求，处理方式不同：
- 先复现：写清触发条件、环境、实际结果与期望结果；复现不了就说明缺什么信息。
- 再定位根因：指出是哪一层 / 哪个模块 / 哪次改动导致的，能用 git log、git blame 佐证的贴出来。
- 修复最小化，只动与缺陷相关的代码；评论里列出改动文件、影响范围、回归点。
- 修完推进到「待测试」，并把复现步骤和回归清单贴给测试同学。`
      : '',
    task.gitlabIssue ? `\nGitLab Issue：${task.gitlabIssue}` : '',
    task.blockedReason ? `\n上次阻塞原因：${task.blockedReason}` : '',
    /* 交接契约放在最近评论之前：评论是流水，决策/未决/风险才是下一棒先要看的结论面。 */
    handoffBlock(task.handoff),
    recent ? `\n最近评论：\n${recent}` : '',
    instruction ? `\n有人刚刚在看板上 @ 了你：\n${instruction}` : '',
    '',
    expert.prompt ? `工作要求（来自管理员配置）：\n${expert.prompt}` : `你的职责：${ROLE_BRIEF[expert.id] ?? '按卡上的要求推进工作。'}`,
    '',
    '工作方式：',
    `1. 先用 studio_task_get 读取这张卡的完整内容（id=${task.id}）。`,
    '2. 需要改代码时在工作目录内操作，改动要小步、可验证。',
    '3. 每一步结束用 studio_task_comment 留下证据：结论、改动文件、执行过的命令与结果。交接给下一棒之前，用 studio_task_update 的 handoff 写清决策 / 假设 / 未决 / 风险 / 影响面，别让下一棒只能翻评论猜。',
    `   调用时 author 一律填你自己的名字「${expert.name}」，看板靠它把人和 AI 的发言分开显示。`,
    '4. 产出物要登记：文档/MR/用例/报告用 studio_task_artifact 记一条（kind + title + ref + content 正文），系统会把正文写成飞书云盘「需求文件夹」下的 Markdown 文档；同时把要点写进 studio_task_update 的 artifacts 字段。',
    '5. 做完一项就 studio_task_check 勾一项（附证据），清单全勾完才算这一步真的完了。',
    `6. 完成后用 studio_task_update 把状态推进到下一列（当前列是「${column.label}」）；真的推进不了就调 studio_task_block 写清楚卡在哪，别自己硬凑。`,
    team !== undefined
      ? '7. 需要团里其他专家配合时，在评论里写 @对方名字 并写清要他做什么，看板会把活儿派给他。'
      : '7. 只处理这一张卡，不要顺手改别的卡；做完就停，不要空转。',
  ].filter(line => line !== '').join('\n')
}

