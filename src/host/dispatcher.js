// ------------------------------------------------------------------ dispatcher
import { DEFAULT_ROLES, FALLBACK_AGENT_MODEL, ROLE_IDS, SANDBOX_MODES, STATUSES, codingSummary, normalizeStrategy, worktreeRoot } from './domain.js'
import { mkdir } from 'node:fs/promises'
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
    return { kind: 'expert', expert, team: undefined, label: `${expert.emoji} ${expert.name}`, viaRole: role }
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
  return { kind: 'expert', expert, team: undefined, label: `${expert.emoji} ${expert.name}` }
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
      return { kind: 'expert', expert: pick, team: undefined, label: `${pick.emoji} ${pick.name}` }
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
          out.push({ kind: 'expert', expert, team: undefined, label: `${expert.emoji} ${expert.name}` })
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
  const source = String(body ?? '')
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

export function recordRun(entry) {
  RUN_LOG.unshift({ ...entry, at: Number(entry.at) || Date.now(), doneAt: 0, ms: 0 })
  if (RUN_LOG.length > 300) RUN_LOG.length = 300
  return RUN_LOG[0]
}

export function settleRun(sessionId) {
  const entry = RUN_LOG.find(item => item.sessionId === sessionId && item.doneAt === 0)
  if (entry === undefined) return
  entry.doneAt = Date.now()
  entry.ms = Math.max(0, entry.doneAt - entry.at)
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
    bump(byExpert, run.expertName || run.expert || '未记录')
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
    note: '宿主没有回传 token 用量，这里统计的是派单次数与执行时长；成本按你们自己的模型单价乘次数即可。',
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
      await markDispatch(this.store, task.id, { ...task.dispatch, state: 'stopped', at: Date.now() })
      this.note(`清掉上次进程留下的派单印记 ${task.id}`)
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
      this.note(`${sessionId} went idle`)
      return
    }
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
      autoStatuses: cfg.autoStatuses,
      workspaceDir: cfg.workspaceDir,
      agentPreset: cfg.agentPreset,
      sandbox: cfg.sandbox ?? 'workspace-write',
      isolation: cfg.isolation ?? 'none',
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
    const limit = Math.max(1, Math.min(8, Number(cfg.maxConcurrent) || 2))
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
      const prompt = buildExpertPrompt(task, expert, column, config, resolved.team, extra.instruction, requirement, this.store.snapshot())
      const via = await this.deliver(agent, sessionId, prompt)
      this.deliveryVia = via
      this.lastError = ''
      recordRun({
        taskId: task.id,
        taskCode: task.code || task.id,
        sessionId,
        expert: expert.id,
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
    const dir = worktree?.path !== undefined ? worktree.path : base
    await mkdir(dir, { recursive: true })
    try {
      await ctx.workspaceRegistry.create(dir, '需求&任务工作空间')
    } catch (error) {
      this.note(`workspace: ${error?.message ?? error}`)
    }
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
    try {
      agent = (await ctx.agents.create(options)).agent
    } catch (error) {
      this.note(`create fell back to resume: ${error?.message ?? error}`)
      agent = (await ctx.agents.resume({
        resumeSessionId: sessionId,
        ...(composition !== undefined ? { setup: composition.setup } : {}),
        ...(agentOptions !== undefined ? { agentOptions } : {}),
      })).agent
    }
    // 沙箱档位：专家自己的设置优先，否则跟随全局。解析不出可用档位时落到
    // workspace-write（安全默认）——绝不因为「没配」而悄悄全开。
    const wanted = String(expert?.sandbox ?? '').trim() || String(cfg.sandbox ?? '').trim()
    let sandbox = SANDBOX_MODES.includes(wanted) ? wanted : 'workspace-write'
    if (!SANDBOX_MODES.includes(wanted)) this.note(`sandbox "${wanted}" 不认识，按 workspace-write 执行`)
    try {
      ctx.permissionPresets.set(agent.session, sandbox)
    } catch (error) {
      this.note(`permission preset ${sandbox} failed: ${error?.message ?? error}`)
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
export function buildExpertPrompt(task, expert, column, config, team, instruction, requirement, state) {
  const recent = (task.comments ?? []).slice(-6).map(entry => `- [${entry.author}] ${entry.body}`).join('\n')
  const members = team === undefined
    ? ''
    : (team.members ?? [])
      .map(id => (config.experts ?? []).find(entry => entry.id === id))
      .filter(Boolean)
      .map(entry => `- @${entry.name}：${entry.description || ROLE_BRIEF[entry.id] || '按分工协作'}`)
      .join('\n')
  return [
    `你是「${expert.emoji} ${expert.name}」，需求&任务工作空间里的一名专家。现在接手工作看板上的一张卡。`,
    expert.description ? `\n你的定位：${expert.description}` : '',
    expert.domain ? `\n业务领域：${expert.domain}（判断与取舍以这个领域的规范和风险偏好为准）` : '',
    (expert.skills ?? []).length > 0 ? `\n你可以使用的技能：${(expert.skills ?? []).map(name => {
      const known = activeSkills?.get(name)
      return known === undefined ? name : `${name}（${known.description}）`
    }).join('、')}。需要时调用 skill 工具加载对应技能，再按其说明操作。` : '',
    team !== undefined ? `\n你在「${team.name}」专家团里协作，本团成员：\n${members}` : '',
    '',
    `任务号：${task.id}${task.code ? `（${task.code}）` : ''}`,
    `标题：${task.title}`,
    (() => {
      if (requirement === undefined) return ''
      const links = requirement.links ?? {}
      const extra = [links.prd ? `PRD ${links.prd}` : '', links.proto ? `原型 ${links.proto}` : '', links.acceptance ? `验收标准 ${links.acceptance}` : ''].filter(Boolean).join('；')
      return `所属需求：${requirement.code || requirement.id}｜${requirement.title}${extra ? `（${extra}）` : ''}`
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
    (task.gitlabMR?.iid ?? 0) > 0 ? `\n关联 MR：!${task.gitlabMR.iid} ${task.gitlabMR.title}（${task.gitlabMR.state}）${task.gitlabMR.url ? ` ${task.gitlabMR.url}` : ''}` : '',
    task.coding !== null && task.coding !== undefined && codingSummary(task.coding) !== ''
      ? `\n这一棒的 AI Coding 执行记录：${codingSummary(task.coding)}${task.coding.branch ? `（分支 ${task.coding.branch}）` : ''}${task.coding.review.status === 'changes_requested' && task.coding.review.note ? `\n评审意见：${task.coding.review.note}` : ''}`
      : '',
    task.reqBaseline ? `\n这张卡是按需求基线 ${task.reqBaseline.version}（${task.reqBaseline.title}）开的，改动要对着这一版。` : '',
    task.worktree !== null && task.worktree !== undefined
      ? `\n你的工作目录是这张卡专属的 git worktree：${task.worktree.path}${task.worktree.serviceName ? `（服务：${task.worktree.serviceName}）` : ''}\n分支 ${task.worktree.branch}（基线 ${task.worktree.base}），仓库 ${task.worktree.repo}。只在这个目录里改代码，提交到这条分支，不要动别人的 worktree 或主分支。`
      : '',
    column.id === 'dev' || column.id === 'dev_ready'
      ? `\n这是研发环节，做完必须留下可审计的执行记录：调用 studio_task_coding，如实填写 agent/model、分支、commits（sha + message + 改动文件数）、改动文件清单、单测总数与通过数，以及你依据的需求基线版本。没登记执行记录的「完成」不算完成。`
      : '',
    column.id === 'review'
      ? `\n这是评审环节：先读 MR 的改动（glab mr diff 或在 GitLab 上看），逐条对照方案、验收清单和执行记录里的 files / commits / 单测结果，把问题写清楚（文件、行、为什么、建议怎么改）。评完用 studio_task_coding action=review 写结论（approved / changes_requested + 说明）；没问题就说明通过理由，推进到「待测试」，有问题就 @ 开发同学，把卡退回「开发中」。`
      : '',
    task.requirement ? `\n需求描述：\n${task.requirement}` : '',
    column.id === 'review'
      ? `\n这是评审环节：先读 MR 的改动（glab mr diff 或在 GitLab 上看），逐条对照方案与验收清单，把问题写清楚（文件、行、为什么、建议怎么改）。没问题就说明通过理由，推进到「待测试」；有问题就 @ 开发同学，把卡退回「开发中」。`
      : '',
    column.id === 'test'
      ? `\n这是测试环节：先用 studio_task_case 把用例登记到卡上（做什么、期望什么）；**能写成接口调用的，就把 method/url/expectStatus/expectContains 一起写上，用 studio_test_run 让平台真的去跑**（它会发请求、比对状态码与响应体、把结果写回用例并留下执行记录，失败的自动开缺陷卡）。只有跑不了的用例（要人工操作、要看 UI、要连设备）才自己执行并用 result 回填 pass/fail/skip，失败要写清环境与复现步骤。**用例一旦判 fail，平台会自动开一张缺陷卡（挂同一需求、父任务指向本卡），你不用再手工建 Bug，也不要重复建**。全部用例有结论后：有用例失败就 @ 开发同学退回「开发中」；全通过就推进到「待验收」，并登记一份测试报告（kind=cases）。` +
        (task.bugSource == null ? '' : `\n这张卡来自缺陷 ${task.bugSource.code || task.bugSource.taskId}（用例「${task.bugSource.caseTitle}」）。修复已进入待测试，平台把来源用例重置成了待执行：请复跑这一条，确认通过后把本卡推进到「待验收」，并通过就把缺陷关闭。`)
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
    recent ? `\n最近评论：\n${recent}` : '',
    instruction ? `\n有人刚刚在看板上 @ 了你：\n${instruction}` : '',
    '',
    expert.prompt ? `工作要求（来自管理员配置）：\n${expert.prompt}` : `你的职责：${ROLE_BRIEF[expert.id] ?? '按卡上的要求推进工作。'}`,
    '',
    '工作方式：',
    `1. 先用 studio_task_get 读取这张卡的完整内容（id=${task.id}）。`,
    '2. 需要改代码时在工作目录内操作，改动要小步、可验证。',
    '3. 每一步结束用 studio_task_comment 留下证据：结论、改动文件、执行过的命令与结果。',
    `   调用时 author 一律填你自己的名字「${expert.name}」，看板靠它把人和 AI 的发言分开显示。`,
    '4. 产出物要登记：文档/MR/用例/报告用 studio_task_artifact 记一条（kind + title + ref + content 正文），系统会把正文写成飞书云盘「需求文件夹」下的 Markdown 文档；同时把要点写进 studio_task_update 的 artifacts 字段。',
    '5. 做完一项就 studio_task_check 勾一项（附证据），清单全勾完才算这一步真的完了。',
    `6. 完成后用 studio_task_update 把状态推进到下一列（当前列是「${column.label}」）；真的推进不了就调 studio_task_block 写清楚卡在哪，别自己硬凑。`,
    team !== undefined
      ? '7. 需要团里其他专家配合时，在评论里写 @对方名字 并写清要他做什么，看板会把活儿派给他。'
      : '7. 只处理这一张卡，不要顺手改别的卡；做完就停，不要空转。',
  ].filter(line => line !== '').join('\n')
}

