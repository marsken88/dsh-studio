// ------------------------------------------------------------------ dispatcher
import { DEFAULT_ROLES, FALLBACK_AGENT_MODEL, ROLE_IDS, SANDBOX_MODES, STATUSES, codingSummary, normalizeStrategy, worktreeRoot } from './domain.js'
import { effectiveConcurrency } from './parallel-guard.js'
import { abandonedRetry, dispatchPhase, handoffRetry, restartResume } from './dispatch-state.js'
import { effectiveSandbox, sanitizeEscalation } from './escalation.js'
import { driftNote, isModelDrift, sessionDirOf } from './model-drift.js'
import { stripQuotedCode } from './mention-note.js'
import { handoffBlock } from './handoff.js'
import { planLine, testPlanSummary } from './test-plan.js'
import { COLLABORATION_BRIEF, rolePlaybookFor } from './role-playbooks.js'
import { emitEvent } from './events.js'
import { loadTeamMemory, teamMemoryBlock } from './team-memory.js'
import { STUDIO_WORKSPACE_TITLE, dispatchDirFor, projectContext, workspaceAttachPlan } from './dispatch-cwd.js'
import { mkdir, readdir, rename, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
// 派单引擎：一卡一会话、槽位限流、幂等投递、SLA 升级。
// 需要宿主能力的少数几处走 configureDispatcher() 注入，避免这里反过来依赖 index.js。

let host = {}

/* 挂进工作区的重试间隔：刚 create 的会话头部落盘有个先后，第一次读不到就等一会儿再试。 */
const WORKSPACE_ATTACH_DELAYS = [0, 150, 400]

/** setTimeout 的 promise 版（参数顺序固定，省得每处都写一遍 new Promise）。 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

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
  ops: '把交付变成用得起来的东西：操作手册、知识库条目、变更与回滚预案；与产品一起收口需求，结论写进交付物（kind=doc）。',
}

/** 「跑完但卡片没换列」时追加的派单指令（tick 的催派分支用）。
 *  为什么写得这么硬：agent 正常结束、只回一句结论就把卡留在原列，
 *  是 2026-11-25 用户看到「卡停着不动」的直接原因。 */
export function nudgeInstruction(column, plan = {}) {
  const label = String(column?.label ?? '当前列')
  const attempt = Math.max(1, Math.trunc(Number(plan.attempts ?? 0)) + 1)
  return [
    `这张卡上一轮已经结束，但仍停在「${label}」列没有推进（第 ${attempt} 次接手）。`,
    '请接着把这一列该做的活做完，结束时必须调用 studio_task_update 把卡片推进到下一列；',
    '如果确实推进不了（缺信息 / 要人拍板 / 被门禁挡住），调用 studio_task_block 写明原因——不要只解释一下就结束。',
  ].join('')
}

/** 这个角色在当前配置下认不认识（config.roles 优先，默认四岗 + 运营）。 */
export function isKnownRole(config, role) {
  const wanted = String(role ?? '').trim()
  if (wanted === '') return false
  const list = Array.isArray(config?.roles) && config.roles.length > 0 ? config.roles : ROLE_IDS
  return list.includes(wanted)
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
    if (!isKnownRole(config, role)) return undefined
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

/**
 * 直接把「派给谁」解析成一个 mention 目标（不走 `@名字` 文本解析）。
 * 给工具 studio_task_mention 用：agent 让另一位专家接手时，不必写评论碰运气（issue #148 评论第 1 条）。
 * target 接受专家/专家团的名字或 id；kind 可以限定 expert / team / role。
 */
export function resolveMentionTarget(config, rawTarget, kind = '') {
  const raw = String(rawTarget ?? '').trim().replace(/^[@＠]/u, '').trim()
  const wantKind = String(kind ?? '').trim().toLowerCase()
  if (raw === '') return { error: '没说派给谁：target 传专家名 / 专家 id / 专家团名 / 专家团 id' }
  if (wantKind === 'role') {
    const roles = Array.isArray(config?.roles) && config.roles.length > 0 ? config.roles : ROLE_IDS
    if (!roles.includes(raw)) return { error: `角色「${raw}」不在 config.roles 里（可选：${roles.join(' / ')}）` }
    return { mention: { kind: 'role', id: raw }, label: `角色位 ${raw}` }
  }
  const candidates = [
    ...(config?.experts ?? []).filter(entry => entry.enabled !== false).map(entry => ({ kind: 'expert', id: entry.id, name: entry.name })),
    ...(config?.teams ?? []).filter(entry => entry.enabled !== false).map(entry => ({ kind: 'team', id: entry.id, name: entry.name })),
  ]
  const pool = wantKind === '' ? candidates : candidates.filter(entry => entry.kind === wantKind)
  const hit = pool.find(entry => entry.id === raw || entry.name === raw)
  if (hit === undefined) {
    const names = pool.slice(0, 12).map(entry => `${entry.name}（${entry.kind === 'team' ? '团' : '专家'} ${entry.id}）`).join(' / ')
    return { error: `没有名字或 id 为「${raw}」的${wantKind === 'team' ? '专家团' : wantKind === 'expert' ? '专家' : '专家/专家团'}${names === '' ? '' : `；现有：${names}`}` }
  }
  return { mention: { kind: hit.kind, id: hit.id }, label: hit.kind === 'team' ? `专家团 · ${hit.name}` : hit.name }
}

/**
 * 无卡会话由谁接话：专家就是它本人；专家团默认团长，也可以用 `member` 指定团里的某一位
 * （issue #148：「和团队聊」实际上常常只想找团队里的某个人）。
 * 纯函数，路由 / 工具 / dispatcher 共用；解析不出就返回 error。
 */
export function resolveChatSpeaker(config, target, member) {
  const wanted = String(member ?? '').trim()
  if (target === undefined || target === null) return { error: '没说找谁：传 expert（专家 id 或专家团 id）' }
  if (target.error !== undefined) return { error: target.error }
  const experts = config?.experts ?? []
  const team = target.team
  if (team === undefined) {
    if (wanted !== '') return { error: `「${target.expert?.name ?? ''}」是专家不是专家团：member 只用于专家团` }
    return { expert: target.expert, team: undefined }
  }
  const members = Array.isArray(team.members) ? team.members : []
  if (wanted === '') {
    const leadId = members.includes(team.lead) ? team.lead : (members[0] ?? '')
    const lead = experts.find(entry => entry.id === leadId)
    return lead === undefined ? { error: `专家团「${team.name}」里没有可用成员` } : { expert: lead, team }
  }
  if (!members.includes(wanted)) {
    const names = members.map(id => experts.find(entry => entry.id === id)?.name ?? id).join(' / ')
    return { error: `「${wanted}」不在专家团「${team.name}」的成员里（成员：${names || '无'}）` }
  }
  const picked = experts.find(entry => entry.id === wanted)
  return picked === undefined ? { error: `专家「${wanted}」不在名册里（团里挂着但已被删）` } : { expert: picked, team }
}

/**
 * 「手动派单 / 发起会话」的目标：既认专家 id，也认专家团 id（团派给团长）。
 *
 * 以前 `/agents/run` 只把字符串原样塞进 `{kind:'expert'}`，于是
 * 「卡不存在」「专家 id 写错」「传的是团」三种原因都落到同一句
 * 「这一列还没人负责」（issue #148 第 3 条），而那句指向的设置面板根本解决不了问题。
 * 这里把三种情况分开，返回 { owner } 或 { error }，路由与工具共用。
 */
export function resolveDispatchTarget(config, rawId) {
  const id = String(rawId ?? '').trim()
  if (id === '') return { error: '没说派给谁：传 expert（专家 id 或专家团 id）' }
  const expert = (config?.experts ?? []).find(entry => entry.id === id)
  if (expert !== undefined) {
    if (expert.enabled === false) return { error: `专家「${expert.name}」已停用：先到「设置 → 专家」启用，或换一位` }
    return { owner: { kind: 'expert', id: expert.id }, expert, team: undefined }
  }
  const team = (config?.teams ?? []).find(entry => entry.id === id)
  if (team !== undefined) {
    if (team.enabled === false) return { error: `专家团「${team.name}」已停用：先到「设置 → 专家团」启用` }
    const members = Array.isArray(team.members) ? team.members : []
    if (members.length === 0) return { error: `专家团「${team.name}」没有成员：先到「设置 → 专家团」给它加人（团长 = 第一个成员）` }
    return { owner: { kind: 'team', id: team.id }, expert: undefined, team }
  }
  const hint = (config?.experts ?? []).filter(entry => entry.enabled !== false).slice(0, 8).map(entry => entry.id).join(' / ')
  return {
    error: `没有 id 为「${id}」的专家或专家团${hint === '' ? '' : `（现有专家：${hint}）`}：核对「设置 → 专家 / 专家团」里的 id，不是名字`,
  }
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
  let resolved = pickFromPool(candidates, raw, task, column, load, domain)
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
export function pickFromPool(candidates, raw, task, column, load, domain = '') {
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]
  const strategy = normalizeStrategy(raw?.strategy)
  if (strategy === 'lead') {
    const team = candidates.find(entry => entry.kind === 'team')
    return team ?? leastLoaded(candidates, load)
  }
  if (strategy === 'best_match') {
    // 打分按「有效领域」（含从需求继承的那一份），与 columnCandidates 展开候选池的口径一致（issue #155）。
    const scored = candidates.map(entry => ({ entry, score: matchScore(entry, task, column, domain) }))
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

export function matchScore(entry, task, column, domain = '') {
  const expert = entry.expert
  if (expert === undefined) return 0
  let score = 0
  // domain 是「有效领域」：调用方传了就信它（通常是 taskDomain 的结果，含需求继承），
  // 不传才退回卡自己的 domain（老调用方/tests 兼容）。
  const wanted = String(domain ?? '').trim() || String(task?.domain ?? '').trim()
  if (expert.domain && wanted && expert.domain === wanted) score += 50
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
  /* 全角 ＠ → 半角 @：中文输入法默认打出来的就是全角，以前静默失效（issue #156）。 */
  const text = source.replace(/\uFF20/g, '@')
  const candidates = [
    ...(config.experts ?? []).filter(expert => expert.enabled).map(expert => ({ kind: 'expert', id: expert.id, name: expert.name })),
    ...(config.teams ?? []).filter(team => team.enabled).map(team => ({ kind: 'team', id: team.id, name: team.name })),
  ].sort((a, b) => b.name.length - a.name.length)
  /** 这段文字里这个候选人的第一次命中（不与已命中的更长候选重叠）。 */
  const hitOf = (needle, used) => {
    const token = String(needle ?? '')
    if (token.length === 0) return null
    const ascii = /^[A-Za-z0-9_-]+$/.test(token)
    let from = 0
    while (from <= text.length) {
      const at = text.indexOf(token, from)
      if (at < 0) return null
      const end = at + token.length
      // @dev 不能命中 @developer：ASCII 名字/ID 后面紧跟字母数字时不算命中。
      const next = text.charAt(end)
      const boundaryOk = !ascii || next === '' || !/[A-Za-z0-9_-]/.test(next)
      const overlap = used.some(([start, stop]) => at < stop && end > start)
      if (boundaryOk && !overlap) return [at, end]
      from = at + 1
    }
    return null
  }
  const hits = []
  const seen = new Set()
  const used = []
  for (const candidate of candidates) {
    if (candidate.name.length === 0 && candidate.id.length === 0) continue
    const spot = hitOf(`@${candidate.name}`, used) ?? hitOf(`@${candidate.id}`, used)
    if (spot === null) continue
    used.push(spot)
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
    /* 无卡会话（/agents/chat）的运行态：不占卡槽位，但要能在 /agents 里看见、能被 /agents/stop 收掉。
       只活在内存里：进程重启后会话本身也不在了，没有需要恢复的。 */
    this.chats = new Map()
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
    // 老会话补挂工作区：以前只注册目录不 attach，这些会话永远停在侧栏「未分组」。
    void this.healWorkspaceMembership().catch(error => { this.lastError = String(error?.message ?? error) })
    this.timer = setInterval(() => {
      this.tick().catch(error => { this.lastError = String(error?.message ?? error) })
    }, 5000)
    this.timer.unref?.()
  }

  /**
   * 开机收尾：把上次进程留下的「跑着」印记改成可续跑的形状，别让看板一直显示「AI 处理中」。
   *
   * 两种卡要接（用户 2026-11-25 反馈「重启后卡不会自己接着跑」）：
   *  ① 进程结束时还在跑：清掉本列印记（status 置空）+ 打 resume（不看自动列白名单也要派一次）；
   *  ② 上一轮正常结束、但卡片没换列：同样打 resume —— 否则它永远停在原列，
   *     要么等人点「马上处理」，要么要等下一次重启。
   * 人主动「停止」的（stopped）不动：那是人的意图，重启不该改。
   */
  async reconcile() {
    const state = this.store.snapshot()
    for (const task of state.tasks) {
      const dispatch = task.dispatch
      if (dispatch === null || typeof dispatch !== 'object') continue
      const sameColumn = String(dispatch.status ?? '') === String(task.status ?? '')
      if (dispatch.state === 'running') {
        /* 必须把 status 一起清掉：tick() 的判据是「dispatch.status === task.status 就跳过」，
           只改 state 会让这张卡永久停摆 —— 看着是"已停止"，实际再也不会被派单。
           清掉 status 之后，下一轮 tick 会重新拾起它（并把本轮记为一次 abandoned 尝试）。 */
        const retry = abandonedRetry(dispatch)
        await markDispatch(this.store, task.id, {
          ...dispatch,
          state: 'stopped',
          status: '',
          attempts: retry.attempts,
          resume: true,
          at: Date.now(),
        })
        /* 这一轮是"进程没跑完就没了"，要留痕：事件 + 卡片历史。
           以前只静默清印记，事后完全看不出这张卡崩过几次（事件账本里也只有业务事件）。 */
        emitEvent('task/abandoned', {
          taskId: task.id,
          title: task.title,
          attempts: retry.attempts,
          exhausted: retry.exhausted,
          sessionId: String(dispatch.sessionId ?? ''),
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
        continue
      }
      /* 上一轮正常结束、没换列：重启后接着派一次。
         人主动停的（stopped）不碰；换过列的记录 status 与当前列已经不同，交给正常派单。 */
      if (sameColumn && restartResume(dispatch) && dispatch.advanced !== true) {
        /* 不清 at：它同时是「上一轮什么时候结束」和催派冷却的起点。
           reconcile 把它改成现在，等于重启后又白等一个冷却周期。 */
        await markDispatch(this.store, task.id, { ...dispatch, resume: true }).catch(() => {})
        await this.appendHistory(task.id, '重启：上一轮结束后卡片没有推进，重新派一次（人不用从头再点）')
        this.note(`重启续跑 ${task.id}：上一轮结束但没有推进`)
      }
    }
  }

  stop() {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Drop a card from the running set once its agent goes idle.
   *
   * 这里写的是「这一列的这一轮跑完了」：state=done + **保留 status** + advanced（有没有换列）。
   * 以前把 info 整条铺进去、state 改成 idle，status 顺势丢了 —— 下一轮 tick 就当成
   * 「这一列没派过」立刻再派一遍，同一个会话 20 秒一轮无限循环（2026-11-22 真机）。
   * 现在没换列的卡由 tick 按 handoffRetry 冷却后「催一次」，换列的直接交给下一列。 */
  settle(sessionId) {
    for (const [slot, info] of this.running) {
      if (info.sessionId !== sessionId) continue
      this.running.delete(slot)
      const task = this.store.snapshot().tasks.find(entry => entry.id === info.taskId)
      const advanced = task !== undefined && String(task.status ?? '') !== String(info.status ?? '')
      markDispatch(this.store, info.taskId, { ...info, state: 'done', advanced, at: Date.now() }).catch(() => {})
      settleRun(sessionId)
      // 会话刚空闲：趁 session 还活着，把引擎自己的 token 计量取下来（真实构成，不是估算）
      void this.captureMeasurement(sessionId, info).catch(() => {})
      this.note(`${sessionId} went idle${advanced ? '（已换列）' : '（没有换列）'}`)
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

  /**
   * 停掉一个无卡会话（`/agents/stop {sessionId}` 的分支）。
   * 它会 abort 驱动器并清掉运行态；会话本身留在 DSH 侧栏（transcript 不删）。
   */
  abortSession(sessionId) {
    const id = String(sessionId ?? '').trim()
    if (id === '') return false
    const info = this.chats.get(id)
    this.chats.delete(id)
    try { this.ctx.agents.get(id)?.abort?.() } catch { /* best effort */ }
    if (info !== undefined) this.note(`chat ${id} aborted`)
    return info !== undefined
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
      chats: [...this.chats.values()].map(info => ({ ...info })),
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
    /* 「跑完但没推进」催一次的档位：复用失败重试的配置 —— retry.max 次失败重试 + 首轮，
       retry.baseMs 就是两次催派之间的冷却。没有冷却的话 tick 每 5 秒一轮，
       会把「跑完→立刻再派」连成一条永不停的链（2026-11-22 真机 20 秒一轮）。 */
    const retryCfg = cfg.retry ?? {}
    const handoff = {
      maxAttempts: Math.max(1, Math.trunc(Number(retryCfg.max ?? 2)) + 1),
      cooldownMs: Math.max(0, Number(retryCfg.baseMs ?? 60_000)),
    }
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
      // 「已完成」永远不派：就算有人把 done 勾进 autoStatuses，也不该再叫 AI 跑一遍。
      if (task.status === 'done') continue
      // 阻塞的卡停在原地等人处理，不自动往下派。
      if (task.blocked !== null && task.blocked !== undefined) continue
      // 上次失败还在退避窗口里：到点再试，别每 5 秒硬撞。
      if ((Number(task.retryAt) || 0) > Date.now()) continue
      const dispatch = task.dispatch ?? null
      /* 重启续跑（dispatch.resume）的卡不受「自动派单列」白名单限制：
         它本来就是被上次进程打断（或被重启接上的），人的意图是「接着跑完」——
         以前这里只看白名单，于是 dev / review / accept 列里的中断卡重启后一张都不动。 */
      if (!auto.has(task.status) && dispatch?.resume !== true) continue
      const column = STATUSES.find(entry => entry.id === task.status)
      if (column === undefined) continue
      // 这一列没人负责（或没匹配到领域专家）就停着，等人指派，不算失败。
      if (ownerFor(state.config, task, column, this.loadByExpert(), state) === undefined) continue
      /* 本列已经有印记：先判它处于什么阶段（判据与工作台「停摆」同一份，见 dispatch-state.js）。 */
      if (dispatch !== null && typeof dispatch === 'object' && String(dispatch.status ?? '') === String(task.status ?? '')) {
        const phase = dispatchPhase(task, { isLive: sessionId => this.hasLiveSession(sessionId) })
        if (phase === 'stalled') {
          /* 「印记说在跑、会话其实早就没了」（issue #157）：收回来，下一轮重派。
             清 status 之后 tick 才会重新拾起；resume 让它不受自动列白名单限制。 */
          const minutes = Math.max(1, Math.round((Date.now() - (Number(dispatch.at) || Date.now())) / 60000))
          const retry = abandonedRetry(dispatch)
          await markDispatch(this.store, task.id, {
            ...dispatch,
            state: 'stopped',
            status: '',
            attempts: retry.attempts,
            resume: true,
            at: Date.now(),
          })
          await this.appendHistory(task.id, `派单印记已收回：会话 ${String(dispatch.sessionId ?? '')} 约 ${minutes} 分钟前就没有在跑了，下一轮会重新派单`)
          this.note(`reclaim stale dispatch ${task.id}（${minutes} 分钟）`)
          continue
        }
        if (phase === 'done') {
          /* 正常跑完但卡片没换列（advanced 由 settle 记录）。
             换过列的不会走到这里（status 已经不同了）；没换列的冷却后催一次，
             最多 retry.max + 1 次，用完挂阻塞等人 —— 既不无限空转，也不会「跑完就再也不动」。 */
          if (dispatch.advanced === true) continue
          const plan = handoffRetry(dispatch, { ...handoff, now: Date.now() })
          if (plan.exhausted) {
            await this.parkHandoff(task, column, plan)
            continue
          }
          if (plan.waitMs > 0) continue
          await this.dispatchCard(task, column, `${task.id}:${task.status}:nudge:${plan.attempts + 1}`, {
            nudge: true,
            instruction: nudgeInstruction(column, plan),
          })
          continue
        }
        // running（会话活着）/ idle（人主动停止）：都不该再派。
        continue
      }
      await this.dispatchCard(task, column, `${task.id}:${task.status}`, {})
    }
  }

  /** 派一次并把成败记进卡：tick 的首轮与「催派」共用这一段。 */
  async dispatchCard(task, column, key, extra = {}) {
    if (extra.nudge === true) {
      await this.appendHistory(task.id, `AI 上一轮结束了但卡片没换列，冷却时间到，再派一次（第 ${Number(task.dispatch?.attempts ?? 0) + 1} 次）`)
    }
    await this.launch(task, column, key, extra).then(async () => {
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

  /** 催派次数用完：把卡挂成阻塞，等人补一句更具体的指令再「马上处理」。
   *  不挂阻塞的话，下次 tick 还会在同一张卡上循环判「已用尽」，看不出来需要人介入。 */
  async parkHandoff(task, column, plan) {
    const reason = `AI 连续 ${plan.attempts} 轮跑完都没有推进这张卡（还停在「${column.label}」），先停下等人：看看卡上缺什么，补一条更具体的指令后点「马上处理」`
    let parked = false
    await this.store.mutate(draft => {
      const found = draft.tasks.find(entry => entry.id === task.id)
      if (found === undefined) return
      if (found.blocked !== null && found.blocked !== undefined) return
      found.blocked = { by: '系统', at: Date.now(), reason }
      found.blockedReason = reason
      found.history = [...(found.history ?? []), { at: Date.now(), by: '系统', status: found.status, note: reason }]
      parked = true
    }).catch(() => {})
    if (parked !== true) return
    this.note(`催派用完，挂阻塞 ${task.id}`)
    emitEvent('agent/failed', { taskId: task.id, attempts: plan.attempts, exhausted: true, error: reason, by: '系统' })
    if (typeof host.feishuBroadcast === 'function') {
      host.feishuBroadcast(this.store.snapshot().config, `【AI 没推进】${task.code || task.id} ${task.title}\n${reason}`)
        .catch(() => undefined)
    }
  }

  /**
   * Force one card through the same path, used by the panel's "马上处理" button.
   * `expertId` 可以是专家 id，也可以是专家团 id（派给团长）；`instruction` 会拼进提示词。
   * 三种失败分开报：卡不存在 / 目标不存在（或停用、团没成员）/ 这一列没人负责。
   */
  async launchNow(id, expertId, instruction) {
    const state = this.store.snapshot()
    const task = state.tasks.find(entry => entry.id === id)
    if (task === undefined) throw new Error(`卡 ${id} 不存在：看板里没有这张卡（可能已被删除），核对卡 id`)
    const column = STATUSES.find(entry => entry.id === task.status) ?? STATUSES[0]
    const key = `${task.id}:${task.status}:manual:${Date.now()}`
    if (typeof expertId === 'string' && expertId.trim().length > 0) {
      const target = resolveDispatchTarget(state.config, expertId)
      if (target.error !== undefined) throw new Error(target.error)
      await this.launch(task, column, key, { owner: target.owner, instruction, manual: true })
      return
    }
    await this.launch(task, column, key, { instruction, manual: true })
  }

  /** Hand a card to whoever a comment just @mentioned. */
  async dispatchMention(taskId, mention, instruction) {
    const task = this.store.snapshot().tasks.find(entry => entry.id === taskId)
    if (task === undefined) throw new Error(`no task ${taskId}`)
    const column = STATUSES.find(entry => entry.id === task.status) ?? STATUSES[0]
    await this.launch(task, column, `${task.id}:${task.status}:mention:${Date.now()}`, {
      owner: { kind: mention.kind, id: mention.id },
      instruction,
      manual: true,
    })
  }

  /**
   * 和一位专家 / 一个专家团「发起一次会话」——不带卡。
   *
   * 为什么要有（issue #148）：会话以前是卡的副产物（`sessionId = studio-<task>-<expert>`），
   * 「先聊清楚再建卡」被逼成「先建卡 → 等 5 秒 tick 派单」，而且对话会把评论区灌满。
   * 这里造一个 `studio-chat-<expert>-<hex>` 会话：跑在 workdir（或工作区目录），
   * 用**对话模式**的提示词（不派工、不改代码、不往任何卡写评论），transcript 就是普通会话。
   * 专家团默认由团长接话；`member` 可以指定团里的某一位（见 resolveChatSpeaker）。
   */
  async startChat({ expert, member, topic, instruction, workdir } = {}) {
    const state = this.store.snapshot()
    const cfg = state.config.agents
    const target = resolveDispatchTarget(state.config, expert)
    if (target.error !== undefined) throw new Error(target.error)
    const speaker = resolveChatSpeaker(state.config, target, member)
    if (speaker.error !== undefined) throw new Error(speaker.error)
    const team = speaker.team
    const who = speaker.expert
    if (who === undefined) throw new Error(`「${String(expert ?? '')}」解析不到具体的人：专家团里没有可用成员`)
    const said = String(topic ?? '').trim().slice(0, 500)
    const note = String(instruction ?? '').trim().slice(0, 2000)
    if (said === '' && note === '') throw new Error('先说一句想聊什么（topic）：没有话题的会话只会空转')
    const sessionId = `studio-chat-${who.id}-${randomBytes(4).toString('hex')}`
    const dir = await this.chatDir(workdir, cfg)
    let workspace
    try {
      workspace = await this.ctx.workspaceRegistry.create(dir, STUDIO_WORKSPACE_TITLE)
    } catch (error) {
      this.note(`workspace: ${error?.message ?? error}`)
    }
    this.note(`会话目录：${dir}`)
    const title = `[${who.name}] 会话：${said.slice(0, 60) || '未命名话题'}`
    let agent
    try {
      agent = await this.mountAgentSession({ sessionId, expert: who, cfg, dir, workspace, title, task: undefined })
      const prompt = buildChatPrompt({ expert: who, team, topic: said, instruction: note, config: state.config })
      await this.deliverChat(agent, sessionId, prompt)
    } catch (error) {
      // 会话起来了但投递失败：别把它留成一个「看着在跑、其实一句话没发出去」的幽灵会话。
      try { await this.ctx.agents.get(sessionId)?.dispose?.() } catch { /* best effort */ }
      try { this.ctx.agents.get(sessionId)?.abort?.() } catch { /* best effort */ }
      throw error
    }
    this.chats.set(sessionId, {
      sessionId,
      expert: who.id,
      expertName: who.name,
      team: team?.id ?? '',
      topic: said,
      workdir: dir,
      at: Date.now(),
    })
    this.note(`chat ${sessionId} → ${who.name}`)
    return {
      ok: true,
      sessionId,
      expert: { id: who.id, name: who.name },
      team: team === undefined ? null : { id: team.id, name: team.name, lead: team.members.includes(team.lead) ? team.lead : (team.members[0] ?? '') },
      workdir: dir,
      topic: said,
      // 会话在哪接着聊：DSH 侧栏里按这个名字找（已挂进工作区，不会落在「未分组」）。
      hint: `会话已建好：在 DSH 侧栏打开「${title}」继续聊；它不会往任何卡写评论。`,
    }
  }

  /** 无卡会话跑在哪个目录：显式 workdir 优先（必须存在），否则工作区目录。 */
  async chatDir(workdir, cfg) {
    const wanted = String(workdir ?? '').trim().replace(/^~(?=$|[/\\])/, homedir())
    if (wanted !== '') {
      if (!(await directoryExists(wanted))) throw new Error(`工作目录不存在：${wanted}（先建好目录，或留空用工作区目录）`)
      return wanted
    }
    const base = (cfg?.workspaceDir ?? '').trim() || join(homedir(), 'dsh-workspace')
    await mkdir(base, { recursive: true })
    return base
  }

  /** 对话模式的投递：没有「完成后推进卡片」那套工位要求（那是派单，不是聊天）。 */
  async deliverChat(agent, sessionId, text) {
    const stamp = Date.now()
    agent.inject({
      id: `studio:${sessionId}:${stamp}:frame`,
      role: 'user',
      content: [{ type: 'text', text: '【需求&任务工作空间 · 会话】这是一次对话，不是派单：不要开工、不要改代码、不要建卡或写看板评论，除非人明确要求。' }],
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

  /** 会话是否真的还活着：先看本进程的槽位，再问宿主（issue #157 的判定靠它）。 */
  hasLiveSession(sessionId) {
    const id = String(sessionId ?? '')
    if (id === '') return false
    for (const info of this.running.values()) if (String(info.sessionId ?? '') === id) return true
    try { return this.ctx?.agents?.get?.(id) !== undefined } catch { return false }
  }

  /** 卡片历史里补一句（列没变，但要让后翻的人看到发生过什么）。 */
  async appendHistory(taskId, note) {
    const text = String(note ?? '').slice(0, 400)
    if (text === '') return
    try {
      await this.store.mutate(state => {
        const found = state.tasks.find(item => item.id === taskId)
        if (found === undefined) return
        found.history = [...(found.history ?? []), { at: Date.now(), status: found.status, by: '系统', note: text }]
      })
    } catch { /* 历史写不进去不影响派单决策 */ }
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
    /* 这是这一列的第几次尝试（催派 / 崩溃续跑的计数，上限见 config.agents.retry.max）：
       - 人手动派的（马上处理 / @ 派活）：重新计数，别让人被 AI 的失败次数挡住；
       - 同一列再来一次（催派）或重启续跑：在原有次数上 +1；
       - 换了一列（正常推进）：从 1 开始。 */
    const prior = task.dispatch ?? null
    const sameColumn = prior !== null && typeof prior === 'object'
      && String(prior.status ?? '') === String(task.status ?? '')
    const previousAttempts = Number(prior?.attempts) || 0
    const attempts = extra.manual === true
      ? 1
      : ((sameColumn || prior?.resume === true) ? previousAttempts + 1 : 1)
    this.running.set(slot, {
      taskId: task.id,
      sessionId,
      expert: expert.id,
      team: resolved.team?.id ?? '',
      at: Date.now(),
      status: task.status,
      attempts,
      key,
      state: 'running',
    })
    try {
      const agent = await this.ensureSession(sessionId, task, expert, cfg)
      await markDispatch(this.store, task.id, {
        key,
        status: task.status,
        expert: expert.id,
        team: resolved.team?.id ?? '',
        sessionId,
        state: 'running',
        attempts,
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
   * 那种情况**直接放弃这一轮**并写明原因 —— 继续拿旧型号跑只会烧 token、撞 503
   * （2026-11-25 真机：评论写着「已归档并重建」，实际还在用 pro 跑了 16 轮才 503）。
   */
  async guardModelDrift({ handle, sessionId, dir, agentOptions, task, openSession }) {
    const readModel = candidate => candidate?.agent?.session?.requestContext?.()
    const current = readModel(handle)
    if (isModelDrift(current, agentOptions) === false) return handle
    const note = driftNote(current, agentOptions)
    this.note(note)
    try { await handle.dispose?.() } catch (error) { this.note(`dispose 失败：${error?.message ?? error}`) }
    /* 旧会话目录是按「创建时的 cwd」分 slug 存的，卡的派单目录后来会变
       （兜底目录 → 项目仓库 / 需求分组）。以前直接用当前 dir 算路径，
       rename 扑空 → create 又撞「已存在」→ 回退 resume，重建等于没做。 */
    const from = await this.locateSessionDir(sessionId, dir)
    let archived = false
    let archiveError = ''
    let archivedTo = ''
    if (from !== '') {
      /* 归档必须挪到 sessions/ **之外**：宿主启动时会扫 sessions/<slug>/* 并校验每个目录头里的
         id/cwd，原地留一个 .stale-* 会被判「corrupt session log」，整个 workspace 服务起不来
         （2026-11-26 .218 实测：重启后 /studio-api 全部挂起）。 */
      archivedTo = join(this.archiveRoot(), basename(dirname(from)), `${basename(from)}.stale-${Date.now()}`)
      try {
        await mkdir(dirname(archivedTo), { recursive: true })
        await rename(from, archivedTo)
        archived = true
      } catch (error) {
        archiveError = String(error?.message ?? error)
        this.note(`归档旧会话失败（${from}）：${archiveError}`)
      }
    } else {
      archiveError = '找不到旧会话目录'
      this.note(`归档旧会话失败：${archiveError}（${sessionId}）`)
    }
    const rebuilt = await openSession()
    const after = readModel(rebuilt)
    if (isModelDrift(after, agentOptions)) {
      const still = `${after?.provider ?? '?'}/${after?.model ?? '?'}`
      const detail = `重建后仍是 ${still}：宿主可能把型号固定在别处`
      this.note(detail)
      await this.commentDrift(task, `${note} 但旧会话${archived ? `已归档（${archivedTo}）` : `归档失败（${archiveError}）`}，${detail}；这一轮不再开跑（继续跑只会拿旧型号撞 503）。先重启 dsh，或手工删掉旧会话目录再派。`)
      throw new Error(`会话模型仍是 ${still}，配置要的是 ${agentOptions?.provider ?? ''}/${agentOptions?.model ?? ''}：旧会话${archived ? '已归档' : `归档失败（${archiveError}）`}，重建后型号没变`)
    }
    await this.commentDrift(task, `${note}${from === '' ? '（没找到旧会话目录）' : `（旧会话 ${from}，${archived ? `已归档到 ${archivedTo}` : '未归档'}）`}，已按配置重建。`)
    this.note(`已按配置重建会话（${agentOptions?.provider ?? ''}/${agentOptions?.model ?? ''}）`)
    return rebuilt
  }

  /** 归档目录：故意放在 `~/.dsh/sessions-archive`，不参与宿主的工作区扫描。测试可覆盖。 */
  archiveRoot() {
    return join(homedir(), '.dsh', 'sessions-archive')
  }

  /**
   * 旧会话的真实目录。
   *
   * 宿主的会话目录是 `<home>/.dsh/sessions/<cwd-slug>/<sessionId>`，slug 来自**创建时**的 cwd；
   * 卡的派单目录后来会变（项目仓库 / 兜底目录 / 需求分组），按当前 dir 硬算会找不到。
   * 顺序：当前 dir 推算 → 宿主 sessionPersistence.stat 的 location → 扫 sessions 下每个 slug。
   * 都找不到返回空串，调用方据此走「归档失败」的真实分支。
   */
  async locateSessionDir(sessionId, dir) {
    const id = String(sessionId ?? '')
    if (id === '') return ''
    const preferred = sessionDirOf(homedir(), dir, id)
    if (preferred !== '' && await directoryExists(preferred)) return preferred
    const location = await this.sessionLocationPath(id)
    if (location !== '') {
      if (await directoryExists(location)) return location
      // 有的后端给的是会话文件路径：目录名通常就是 sessionId。
      const parent = dirname(location)
      if (parent.includes(id) && await directoryExists(parent)) return parent
    }
    const root = join(homedir(), '.dsh', 'sessions')
    try {
      for (const slug of await readdir(root)) {
        const candidate = join(root, slug, id)
        if (await directoryExists(candidate)) return candidate
      }
    } catch { /* 没有会话目录就按找不到处理 */ }
    return ''
  }

  /** 宿主持久化里这条会话的位置（老后端可能没有 location，返回空串）。 */
  async sessionLocationPath(sessionId) {
    const persistence = this.ctx?.get?.('sessionPersistence')
    if (persistence === undefined || typeof persistence?.stat !== 'function') return ''
    try {
      const snapshot = await persistence.stat(sessionId)
      return String(snapshot?.location?.path ?? '')
    } catch {
      return ''
    }
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
    const cfgNow = this.config()
    const snapshot = this.store.snapshot()
    /* 工作区分组：card = 一卡一 worktree；requirement = 一个需求一个文件夹。
       requirement 模式下产品/架构/测试跑需求共享 worktree；同一需求有多张研发卡在
       dev/review 时，研发卡仍各自建卡级 worktree（用户要的文件级隔离）。 */
    const grouping = String(cfgNow?.agents?.workspaceGrouping ?? 'card') === 'requirement' ? 'requirement' : 'card'
    const requirement = (snapshot.requirements ?? []).find(item => item.id === String(task.requirementId ?? ''))
    const isDevRole = String(task.role ?? '') === 'dev'
    let worktree
    let requirementWorktree
    try {
      if (grouping === 'requirement' && requirement !== undefined) {
        const concurrentDev = isDevRole && (snapshot.tasks ?? []).some(other => other.id !== task.id
          && String(other.requirementId ?? '') === String(task.requirementId ?? '')
          && String(other.role ?? '') === 'dev'
          && ['dev', 'review'].includes(String(other.status ?? '')))
        if (concurrentDev) {
          worktree = await host.ensureWorktree(this.store, task, cfgNow)
        } else if (typeof host.ensureRequirementWorktree === 'function') {
          requirementWorktree = await host.ensureRequirementWorktree(this.store, task, cfgNow, host.listWorkspaces)
          if (requirementWorktree?.skipped !== undefined) this.note(`requirement worktree skipped: ${requirementWorktree.skipped}`)
          if (isDevRole && String(requirementWorktree?.path ?? '') !== '') {
            worktree = requirementWorktree
            try {
              await this.store.mutate(draft => {
                const target = draft.tasks.find(entry => entry.id === task.id)
                if (target !== undefined) target.worktree = requirementWorktree
              })
            } catch (error) { this.note(`record shared worktree: ${error?.message ?? error}`) }
          }
        }
      } else {
        worktree = await host.ensureWorktree(this.store, task, cfgNow)
      }
    } catch (error) {
      this.note(`worktree: ${error?.message ?? error}`)
    }
    if (worktree?.skipped !== undefined) this.note(`worktree skipped: ${worktree.skipped}`)
    /* 会话跑在哪个目录，决定了它在 DSH 侧栏里属于哪个工作区（按 canonical cwd 归属）：
       项目配了「本机代码目录」就跑到那个仓库里，会话才落在项目工作区下；否则退回工作区目录。
       以前一律跑 workspaceDir 的临时目录，派出去的会话只能落在「未分组」。 */
    const context = projectContext(cfgNow, task, snapshot.requirements)
    const plan = dispatchDirFor({ task, worktree, context, fallbackDir: base, grouping, requirement, requirementWorktree })
    let dir = plan.dir !== '' ? plan.dir : base
    let title = plan.title
    if (plan.kind === 'repo' && !(await directoryExists(dir))) {
      this.note(`项目代码目录不存在，退回工作区目录：${dir}`)
      dir = base
      title = STUDIO_WORKSPACE_TITLE
    }
    await mkdir(dir, { recursive: true })
    /* 注册目录（create）只保证这个路径在工作区列表里；会话要不要显示在它下面，
       看的是工作区名单（sessionIds）。两件事分开做，缺了后者就只剩「未分组」。 */
    let workspace
    try {
      workspace = await ctx.workspaceRegistry.create(dir, title)
    } catch (error) {
      this.note(`workspace: ${error?.message ?? error}`)
    }
    this.note(`会话目录（${title}）：${dir}`)
    /* 会话本体（模型/预设/漂移守卫/工作区/沙箱/改名）与无卡会话共用，见 mountAgentSession。 */
    return await this.mountAgentSession({
      sessionId,
      expert,
      cfg,
      dir,
      workspace,
      task,
      // 卡派单在 worktree 隔离下要提权写主仓 .git；无卡会话没有 worktree，不提权。
      escalateForWorktree: String(cfg.isolation ?? 'none') === 'worktree',
    })
  }

  /**
   * 会话的公共部分：卡派单与 `/agents/chat`（无卡会话）共用。
   *
   * 为什么抽出来：无卡会话要的是一模一样的会话（同一个模型、同一个预设、同一个沙箱口径），
   * 只是没有卡、目录与标题不同。复制一份的逻辑迟早会漂：一边改了审批策略、另一边忘掉，
   * 表现就是「卡上能跑、会话里跑不动」。
   */
  async mountAgentSession({ sessionId, expert, cfg, dir, workspace, title = '', task, escalateForWorktree = false }) {
    const ctx = this.ctx
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
    /* 会话落进了工作区目录还不够：DSH 之后不再按 cwd 自动归组，必须显式 attach，
       否则侧栏里它仍然在「未分组」里躺着（这一条 2026-11-23 那轮只做了一半）。 */
    await this.joinWorkspace({ workspace, dir, sessionId })
    agent = handle.agent
    /* 沙箱档位：专家自己的设置优先，否则跟随全局；再叠一层「提权审批」口径：
       allow（默认）= 始终允许完全访问 → 直接以 danger-full-access 运行，不再逐次审批；
       deny = 把沙箱当边界用（workspace-write / 只读）。只读永远优先。
       以前 allow 只是「审批时答 allowed-once」，而 DSH 只有逐次放行，
       于是无人值守会话每碰一次边界就被重问一次（agent 会停下来等、甚至整轮挂死）。 */
    const wanted = String(expert?.sandbox ?? '').trim() || String(cfg.sandbox ?? '').trim()
    let sandbox = effectiveSandbox({ expertSandbox: expert?.sandbox, globalSandbox: cfg.sandbox, escalation: cfg.escalation })
    if (!SANDBOX_MODES.includes(wanted) && wanted !== '') this.note(`sandbox "${wanted}" 不认识，按 workspace-write 执行`)
    const escalationMode = sanitizeEscalation(cfg.escalation)
    if (escalationMode === 'allow' && sandbox === 'danger-full-access' && wanted !== 'danger-full-access') {
      this.note('提权审批 = 自动批准：会话直接以 danger-full-access 运行（不再逐次审批）')
    }
    // worktree 隔离时，提交要写主仓的 .git（在 worktree 之外），workspace-write 会直接拒绝并弹审批；
    // 无人值守的会话就卡死等审批（2026-11-16 实测：approval/asked 后再无动作）。
    // 所以 worktree 模式一律提权到 danger-full-access，并在卡上留一句解释。
    if (escalateForWorktree === true && sandbox !== 'danger-full-access') {
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
    const sessionTitle = task === undefined
      ? (String(title ?? '') !== '' ? String(title) : `[${expert.name}] 会话`)
      : `[${expert.name}] ${task.title}`
    try {
      await ctx.sessionController.rename({ sessionId, title: sessionTitle.slice(0, 120) })
    } catch (error) {
      this.note(`rename failed: ${error?.message ?? error}`)
    }
    return agent
  }

  /**
   * 把一个刚建好的会话挂进它所属的工作区名单。
   *
   * 宿主的归组规则：`workspaceRegistry` 只在**首次初始化**时按会话头的 canonical cwd
   * 做一次性 bootstrap；之后 `sessionIds` 是显式名单，只有 `attachSession()` 会往里加。
   * 所以「会话跑在项目目录里」不自动等于「它显示在项目工作区下」—— 少了这一步，
   * 派单会话会一直留在侧栏「未分组」里，人从侧栏看不出这张卡在改哪个仓库。
   *
   * 刚 create 出来的会话，头部可能还没落进持久化快照（attach 会读它校验 cwd），
   * 所以给几次重试；仍然失败只记一行日志，不影响派单本身。
   */
  async joinWorkspace({ workspace, dir, sessionId }) {
    const registry = this.ctx?.workspaceRegistry
    let target = workspace
    if (target === undefined && typeof registry?.resolveByPath === 'function') {
      try { target = await registry.resolveByPath(dir) } catch (error) { this.note(`workspace lookup: ${error?.message ?? error}`) }
    }
    if (target === undefined || typeof target.attachSession !== 'function') return false
    let last
    for (const wait of WORKSPACE_ATTACH_DELAYS) {
      if (wait > 0) await sleep(wait)
      try {
        await target.attachSession(sessionId)
        return true
      } catch (error) { last = error }
    }
    this.note(`会话没能挂进工作区（侧栏会显示「未分组」）：${last?.message ?? last}`)
    return false
  }

  /**
   * 开机自愈：把「cwd 就在某个已注册工作区里、却不在它的名单上」的老会话补挂进去。
   *
   * 以前只 `workspaceRegistry.create()` 了目录、没 attach，于是那些派单会话虽然跑在
   * 正确的目录里，却一直停在「未分组」。只动 `studio-` 开头的会话：别人的会话不归我们管。
   * @returns 实际补挂的数量（0 表示没有要修的）。
   */
  async healWorkspaceMembership() {
    const registry = this.ctx?.workspaceRegistry
    const persistence = this.ctx?.get?.('sessionPersistence')
    if (typeof registry?.list !== 'function' || typeof persistence?.list !== 'function') return 0
    const entities = new Map()
    const workspaces = []
    try {
      for (const entity of registry.list()) {
        entities.set(String(entity.id), entity)
        workspaces.push({ id: entity.id, path: entity.path, sessionIds: entity.sessionIds })
      }
    } catch (error) {
      this.note(`读工作区列表失败：${error?.message ?? error}`)
      return 0
    }
    let sessions = []
    try {
      sessions = (await persistence.list())
        .map(snapshot => snapshot?.header)
        .filter(header => header !== undefined && String(header.id ?? '').startsWith('studio-'))
        .map(header => ({ id: String(header.id), cwd: String(header.cwd ?? '') }))
    } catch (error) {
      this.note(`读会话头失败：${error?.message ?? error}`)
      return 0
    }
    const plan = workspaceAttachPlan({ sessions, workspaces })
    let attached = 0
    for (const item of plan) {
      const entity = entities.get(item.workspaceId)
      if (entity === undefined) continue
      try {
        await entity.attachSession(item.sessionId)
        attached += 1
      } catch (error) {
        this.note(`补挂 ${item.sessionId} 失败：${error?.message ?? error}`)
      }
    }
    if (attached > 0) this.note(`把 ${attached} 个老派单会话补挂进工作区（它们原来在「未分组」里）`)
    return attached
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
   * Model for one expert: its own setting ("provider/model" or a bare model id,
   * in which case the host default provider is borrowed), else the fallback.
   * 专家的 model 是唯一来源——旧的「角色模板」兜底已删（键是 expert.id，自定义
   * 专家永远命不中，等于死代码）。
   */
  modelFor(expert) {
    const current = this.ctx.agentDefaultModel?.currentSelection?.()
    const configured = String(expert?.model ?? '').trim()
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

/**
 * 无卡会话的提示词（issue #148）：对话模式，不是工位派单。
 * 与 buildExpertPrompt 的分工：那边是「接手一张卡、干完推进列」，这边是「和人聊清楚再决定建不建卡」。
 */
export function buildChatPrompt({ expert, team, topic, instruction, config }) {
  const members = team === undefined
    ? ''
    : (team.members ?? [])
      .map(id => (config?.experts ?? []).find(entry => entry.id === id))
      .filter(Boolean)
      .map(entry => `- @${entry.name}：${entry.description || ROLE_BRIEF[entry.role] || '按分工协作'}`)
      .join('\n')
  return [
    `你是「${expert.name}」，需求&任务工作空间里的一名专家。现在是在和人对话，不是在接工单。`,
    expert.description ? `\n你的定位：${expert.description}` : '',
    expert.domain ? `\n业务领域：${expert.domain}（判断与取舍以这个领域的规范和风险偏好为准）` : '',
    (expert.skills ?? []).length > 0 ? `\n你可以使用的技能：${(expert.skills ?? []).join('、')}（需要时用 skill 工具加载）` : '',
    team !== undefined ? `\n你在「${team.name}」专家团里，这次由你先接话（你是团长）。本团成员：\n${members}\n需要成员接手时，在回复里写「@名字 + 要他做什么」，人会决定要不要转给他。` : '',
    '',
    '这次会话的规矩：',
    '1) 这是讨论，不是开工：不要改代码、不要建卡、不要往看板写评论，除非人明确让你做。',
    '2) 先给取舍与风险，再给建议；不确定就说不确定，并写清要谁来定（谁拍板、什么时候要）。',
    '3) 需要事实（现有实现、历史卡、文档）就自己读，不凭印象下结论。',
    '4) 聊到能落地时，给人一段可直接复制的需求/卡描述：标题 + 背景一句话 + 验收要点（可判定），由人决定建不建。',
    '',
    `话题：${topic}`,
    String(instruction ?? '') !== '' ? `\n补充说明：${instruction}` : '',
  ].join('\n')
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
    /* 四棒共用的协作约定：先读上游交接、逐条回应未决、给下一棒三句话、要谁配合就 @谁。
       放在需求口径之后、角色手册之前：先知道「和谁协作」，再看「自己这一棒做什么」。 */
    COLLABORATION_BRIEF,
    /* 角色手册按卡当前所在的列注入（产品/架构/研发/评审各一份，测试在下面单独生成），
       里面带当前事实：功能点缺不缺验收、设计定没定案、执行记录与项目检查跑没跑。 */
    rolePlaybookFor(column.id, task, requirement),
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
            '1. 每条用例必须能跑：studio_task_add_cases 会当场试跑第一条，跑不通就改断言/地址再调；只有标题没有断言的「用例」不许写（那是待办，不是用例）。卡上已有同名空壳时，工具会**原地升级**成可执行（不会新增重复），补齐断言重新调用即可。真跑不了的（要人工操作、连设备、看第三方系统）用 studio_task_case 登记成描述型用例，自己执行后回填 result 并写清证据。',
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
    /* 空提示词时退内置职责：按**角色位**取，不是按 expert.id —— 自建专家的 id 是
       slug/hash，以前永远查不到，只会拿到一句「按卡上的要求推进工作」。 */
    expert.prompt ? `工作要求（来自管理员配置）：\n${expert.prompt}` : `你的职责：${ROLE_BRIEF[expert.role] ?? ROLE_BRIEF[expert.id] ?? '按卡上的要求推进工作。'}`,
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

