import { randomBytes } from 'node:crypto'
import { appendPointAcceptance } from '../acceptance.js'
import { readArtifactImage } from '../artifact-image.js'
import { artifactInputFromBody, clearDeletedReferences } from '../domain.js'
import { designPatchFrom } from '../design.js'
import { rejectUnknownFields } from '../route-contract.js'
import { resolveRequirement, requirementRefHint, saveTaskDesign } from '../reviews.js'
import { publishNoteMentions } from '../mention-note.js'
import { parseMentions, ownerFor, resolveDispatchTarget } from '../dispatcher.js'
import { dispatchPreview, previewWarning } from '../column-preview.js'
import { emitEvent } from '../events.js'
import { collectCases, groupCaseKeys, loadSuites, resolveSuiteKeys, sanitizeSuite, saveSuites, summarizeRun } from '../cases.js'
import { clearTeamMemory, loadTeamMemory } from '../team-memory.js'
import { sanitizeCaseShell } from '../shell-case.js'
import { sanitizeDbCase } from '../db-runner.js'
import { sanitizeCaseBrowser } from '../browser-runner.js'
import { applyTierDeclarations, sanitizeTier, testPlanSummary, tierOf } from '../test-plan.js'
import {
  CASE_HTTP_METHODS,
  CASE_PRIORITIES,
  CASE_TYPES,
  ROLE_IDS,
  STATUSES,
  STATUS_SET,
  CASE_RESULTS,
  cleanId,
  defaultColumns,
  roleIdsOf,
  sanitizeArtifact,
  sanitizeCaseHttp,
  sanitizeCases,
  sanitizeColumns,
  text } from '../domain.js'
import { runSuite } from '../executor.js'
import { caseNeedsRerun, requirementDocUpdatedAt } from '../impact.js'

/** 请求落在哪个地址上（用于"没配测试环境时回退到宿主自身"）。 */
function originOf(req) {
  const proto = String(req?.headers?.['x-forwarded-proto'] ?? 'http').split(',')[0].trim() || 'http'
  const host = String(req?.headers?.host ?? '').trim()
  return host === '' ? '' : `${proto}://${host}`
}

const INJECTED = ['sendJson', 'readJsonBody', 'recordAudit', 'createTask', 'updateTask', 'commentTask', 'runTaskCases', 'syncArtifact', 'getDispatcher', 'applyConfig', 'autoBugFromCase', 'publicState', 'upsertById']

let host = {
  sendJson: () => {},
  readJsonBody: async () => ({}),
  createTask: () => ({}),
  updateTask: () => ({}),
  commentTask: () => ({}),
  runTaskCases: async () => ({}),
  syncArtifact: async () => ({}),
  getDispatcher: () => undefined,
  applyConfig: async () => {},
  autoBugFromCase: () => null,
  publicState: () => ({}),
  upsertById: () => [],
}

/** 卡片（任务 / 专家 / 列）相关路由。宿主能力由 configureTaskRoutes() 注入。 */
export function configureTaskRoutes(services) {
  host = { ...host, ...(services ?? {}) }
}

/**
 * 跑一批用例键：先探环境，再按卡分组一轮一轮跑，最后记一笔「最近回归」。
 * /cases/run 与 /suite/run 共用这段——两处逻辑必须完全一致，否则套件和历史记录会对不上。
 */
async function runCaseKeys(store, keys, options = {}) {
  const grouped = groupCaseKeys(keys)
  if (grouped.size === 0) throw new Error('没有可跑的用例')
  const snapshot = store.snapshot()
  const testing = snapshot.config.testing ?? {}
  const envs = Array.isArray(testing.envs) ? testing.envs : []
  const env = envs.find(item => item.id === String(options.env ?? testing.defaultEnv ?? '')) ?? envs[0]
  if (env !== undefined) {
    const probe = await host.probeEnv(env, snapshot.config)
    if (probe.ok !== true) throw new Error(`测试环境「${env.name || env.id}」不可达（${probe.error}）：一条用例都没跑`)
  }
  const by = String(options.by ?? '回归').slice(0, 40)
  const results = []
  for (const [taskId, caseIds] of grouped) {
    try {
      const out = await host.runTaskCases(store, taskId, { caseIds, env: options.env, by, origin: options.origin })
      const card = store.snapshot().tasks.find(entry => entry.id === taskId)
      results.push({
        taskId,
        taskCode: card?.code ?? '',
        taskTitle: card?.title ?? '',
        ok: true,
        total: out.run.total,
        passed: out.run.passed,
        failed: out.run.failed,
        bugs: (out.bugs ?? []).filter(item => item.created === true).length,
      })
    } catch (error) {
      results.push({ taskId, ok: false, error: String(error?.message ?? error).slice(0, 200) })
    }
  }
  const record = summarizeRun(results, by)
  try {
    const previous = await store.readSide('regressions')
    const list = Array.isArray(previous) ? previous : []
    await store.writeSide('regressions', [record, ...list].slice(0, 20))
  } catch {
    /* 记不下来不影响这次跑的结果 */
  }
  emitEvent('regression/finished', { by: record.by, cards: record.cards, total: record.total, passed: record.passed, failed: record.failed, bugs: record.bugs ?? 0, truncated: options.truncated ?? null })
  return { results, regression: record }
}

export async function handleTaskRoute({ method, route, req, res, store, url }) {
  if (method === 'POST' && route === '/task/create') {
    const body = await host.readJsonBody(req)
    /* 以前不传 requirementId 也能建卡：得到的卡 requirementId/code 都是空的，
       需求侧永远看不到它，卡片显示「未挂需求」（issue #5 第 6 条）。
       现在需求卡必须挂需求；缺陷可以例外（缺陷常常还没有需求）。 */
    const createType = String(body.type ?? 'requirement')
    if (createType !== 'bug' && String(body.requirementId ?? '').trim() === '') {
      throw new Error('建卡要挂到一条需求上：先选或新建需求（缺陷可以不挂）')
    }
    /* 需求编号要归一成内部 id 再存外键：以前把 REQ-2026-002 原样存进去，
       卡就成了脏引用，需求汇总显示「卡 0/0」还不报错（issue #9 第 2 条）。 */
    const snapshotNow = store.snapshot()
    if (String(body.requirementId ?? '').trim() !== '') {
      const target = resolveRequirement(snapshotNow, body.requirementId)
      if (target === undefined) throw new Error(requirementRefHint(snapshotNow, body.requirementId))
      body.requirementId = target.id
    }
    const task = await host.createTask(store, body)
    host.sendJson(res, 200, { ok: true, task, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/task/design') {
    // 设计评审：链接 / 状态 / 意见。不走通用 patch，避免被白名单挡掉。
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    const by = String(body.by ?? '人').slice(0, 40)
    /* 只带 id = 读：不写、不加 revision、不记历史（issue #5 第 5 条）。 */
    const incoming = designPatchFrom(body)
    if (incoming === null) {
      const task = store.snapshot().tasks.find(entry => entry.id === id)
      if (task === undefined) throw new Error(`no task ${id}`)
      req.__studioReadOnly = true   // 让请求管线的审计跳过这条（读请求不该推 revision）
      host.sendJson(res, 200, { ok: true, design: task.design ?? null, readOnly: true })
      return true
    }
    // 评审/定案逻辑与 studio_task_design 工具共用一份（src/host/reviews.js）
    const design = await saveTaskDesign(store, id, incoming, by)
    /* 设计评审备注里的 @ 同样要能叫起人（以前只有评论解析 @）。 */
    const noteOut = await publishNoteMentions(
      { store, commentTask: host.commentTask, dispatcher: host.getDispatcher(), parseMentions },
      { taskId: id, note: String(incoming.note ?? ''), by, label: '设计评审' },
    )
    host.sendJson(res, 200, { ok: true, design, ...noteOut, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/task/update') {
    const body = await host.readJsonBody(req)
    // ifVersion 是「我基于哪个版本改的」：顶层或 patch 里都认。
    const patchBody = { ...(body.patch ?? body) }
    const ifVersion = body.ifVersion ?? body.patch?.ifVersion
    if (ifVersion !== undefined && ifVersion !== null) patchBody.ifVersion = ifVersion
    const task = await host.updateTask(store, String(body.id ?? ''), patchBody)
    host.sendJson(res, 200, { ok: true, task, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/task/block') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    /* 想「解除」却打到 /task/block 的（写 blocked:false 或干脆不带 reason）：按解除处理，
       别回一句「请写清楚卡在哪了」让人以为接口坏了（真机 2026-11-26）。 */
    if (body.blocked === false) {
      const task = await host.updateTask(store, id, { blocked: false, by: text(body.by, 60) ?? '人' })
      host.sendJson(res, 200, { ok: true, task, state: host.publicState(store) })
      return true
    }
    const reason = text(body.reason, 500) ?? ''
    if (reason === '') {
      host.sendJson(res, 400, { ok: false, error: '请写清楚卡在哪了，方便之后判断怎么继续（要解除阻塞请传 blocked:false 或打 /task/unblock）' })
      return true
    }
    const task = await host.updateTask(store, id, {
      blocked: true,
      blockedReason: reason,
      by: text(body.by, 60) ?? '人',
    })
    // 卡住就停手：把这个专家正在跑的会话收掉，避免它继续往前走。
    host.getDispatcher()?.abortTask?.(id, undefined, '人')
    host.sendJson(res, 200, { ok: true, task, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/task/unblock') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    const by = text(body.by, 60) ?? '人'
    const action = String(body.action ?? 'resume')
    let task = await host.updateTask(store, id, { blocked: false, by })
    if (action === 'advance') {
      const index = STATUSES.findIndex(entry => entry.id === task.status)
      const next = STATUSES[Math.min(index + 1, STATUSES.length - 1)]
      task = await host.updateTask(store, id, { status: next.id, by })
    }
    const dispatcher = host.getDispatcher()
    const ran = []
    if (dispatcher !== undefined && action !== 'clear') {
      try {
        await dispatcher.launchNow(id, action === 'assign' ? String(body.expert ?? '') : undefined)
        ran.push(action === 'assign' ? `expert:${String(body.expert ?? '')}` : 'column-owner')
      } catch (error) {
        ran.push(`failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    host.sendJson(res, 200, { ok: true, task, ran, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/task/comment') {
    const body = await host.readJsonBody(req)
    rejectUnknownFields('/task/comment', body)
    const action = String(body.action ?? 'add')
    /* 评论以前只能增（issue #19）：写错/重复/过时的只能留着误导下一个人。 */
    if (action === 'update') {
      const out = await host.updateTaskComment(store, String(body.id ?? ''), body.commentId, body.body, String(body.by ?? body.author ?? '人'))
      host.sendJson(res, 200, { ok: true, task: out.task, state: host.publicState(store) })
      return true
    }
    if (action === 'remove') {
      const out = await host.removeTaskComment(store, String(body.id ?? ''), body.commentId, String(body.by ?? body.author ?? '人'))
      host.sendJson(res, 200, { ok: true, task: out.task, state: host.publicState(store) })
      return true
    }
    const { task, mentions } = await host.commentTask(store, String(body.id ?? ''), body.body, body.author, body.kind)
    const dispatcher = host.getDispatcher()
    const dispatched = []
    if (dispatcher !== undefined) {
      for (const mention of mentions) {
        try {
          await dispatcher.dispatchMention(task.id, mention, String(body.body ?? ''))
          dispatched.push(`${mention.kind}:${mention.id}`)
        } catch (error) {
          dispatched.push(`${mention.kind}:${mention.id} failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    host.sendJson(res, 200, { ok: true, task, mentions, dispatched, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/mention') {
    const dispatcher = host.getDispatcher()
    if (dispatcher === undefined) throw new Error('dispatcher not available yet')
    const body = await host.readJsonBody(req)
    rejectUnknownFields('/mention', body)
    /* kind 以前只认 team/expert，role 被静默降级成 expert（与 #149 同一段代码模式，issue #148 评论）。
       现在三条路都认，但**先按白名单校验**：不认识的角色/专家/团直接 400，不再降级。 */
    const kind = body.kind === 'team' ? 'team' : body.kind === 'role' ? 'role' : 'expert'
    const id = String(body.id ?? '').trim()
    if (kind === 'role') {
      const roles = roleIdsOf(store.snapshot().config)
      if (!roles.includes(id)) throw new Error(`角色「${id}」不在 config.roles 里（可选：${roles.join(' / ')}）`)
    } else {
      const target = resolveDispatchTarget(store.snapshot().config, id)
      if (target.error !== undefined) throw new Error(target.error)
    }
    await dispatcher.dispatchMention(String(body.taskId ?? ''), { kind, id }, String(body.instruction ?? ''))
    host.sendJson(res, 200, { ok: true, state: host.publicState(store), agents: dispatcher.status() })
    return true
  }
  if (method === 'POST' && route === '/experts/save') {
    const body = await host.readJsonBody(req)
    const incoming = body.expert ?? body
    if (String(incoming.name ?? '').trim() === '') throw new Error('专家名称不能为空')
    /* 传了不认识的 role 就 400 并列出可选值：以前 sanitizeExperts 静默清空，
       200 + role:"" 让人以为配好了，实际这个人永远进不了任何角色位候选池（issue #150）。 */
    const roles = roleIdsOf(store.snapshot().config)
    const wantedRole = String(incoming.role ?? '').trim()
    if (wantedRole !== '' && !roles.includes(wantedRole)) {
      throw new Error(`角色「${wantedRole}」不在 config.roles 里：可选 ${roles.join(' / ')}；要新增岗位先到「设置 → 角色位」把它加上`)
    }
    await host.applyConfig(store, { experts: host.upsertById(store.snapshot().config.experts, incoming) })
    // 把保存后的集合一起返回：脚本 / 前端不用再猜刚存的是哪一条。
    const saved = store.snapshot().config.experts
    const record = saved.find(entry => entry.id === cleanId(incoming.id ?? incoming.name, 'expert')) ?? saved[saved.length - 1]
    host.sendJson(res, 200, { ok: true, expert: record, experts: saved, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/experts/delete') {
    const body = await host.readJsonBody(req)
    const id = cleanId(body.id, 'expert')
    const existing = store.snapshot().config.experts
    if (!existing.some(expert => expert.id === id)) throw new Error(`no expert ${id}`)
    await host.applyConfig(store, { experts: existing.filter(expert => expert.id !== id) })
    host.sendJson(res, 200, { ok: true, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/teams/save') {
    const body = await host.readJsonBody(req)
    const incoming = body.team ?? body
    if (String(incoming.name ?? '').trim() === '') throw new Error('专家团名称不能为空')
    await host.applyConfig(store, { teams: host.upsertById(store.snapshot().config.teams, incoming) })
    host.sendJson(res, 200, { ok: true, teams: store.snapshot().config.teams, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/teams/delete') {
    const body = await host.readJsonBody(req)
    const id = cleanId(body.id, 'team')
    const existing = store.snapshot().config.teams
    if (!existing.some(team => team.id === id)) throw new Error(`no team ${id}`)
    await host.applyConfig(store, { teams: existing.filter(team => team.id !== id) })
    host.sendJson(res, 200, { ok: true, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/columns/wip') {
    const body = await host.readJsonBody(req)
    const status = String(body.status ?? '')
    if (!STATUS_SET.has(status)) throw new Error(`unknown status ${status}`)
    const columns = { ...store.snapshot().config.columns }
    const wip = Math.min(50, Math.max(0, Math.trunc(Number(body.wip) || 0)))
    columns[status] = { ...(columns[status] ?? { kind: 'none', id: '' }), wip }
    await host.applyConfig(store, { columns })
    host.sendJson(res, 200, { ok: true, columns: store.snapshot().config.columns, state: host.publicState(store) })
    return true
  }

  if (method === 'POST' && route === '/columns/save') {
    const body = await host.readJsonBody(req)
    rejectUnknownFields('/columns/save', body)
    const status = String(body.status ?? '')
    if (!STATUS_SET.has(status)) throw new Error(`unknown status ${status}`)
    const snapshot = store.snapshot()
    const config = snapshot.config
    const roles = roleIdsOf(config)
    const expertIds = new Set((config.experts ?? []).map(entry => entry.id))
    const teamIds = new Set((config.teams ?? []).map(entry => entry.id))
    const columns = { ...config.columns }
    if (Array.isArray(body.members)) {
      /* 候选池里的每一项都要真存在：以前非法项被 sanitizeColumns 静默丢掉，
         调用方拿到 200 还以为配上了（issue #149 现象一）。 */
      const members = body.members.map((entry, index) => {
        const kind = entry?.kind === 'team' ? 'team' : entry?.kind === 'role' ? 'role' : 'expert'
        const id = String(entry?.id ?? '').trim()
        if (kind === 'role' && !roles.includes(id)) throw new Error(`${index + 1} 项的角色「${id}」不在 config.roles 里（可选：${roles.join(' / ')}）`)
        if (kind === 'team' && !teamIds.has(id)) throw new Error(`${index + 1} 项的专家团「${id}」不存在：先到「设置 → 专家团」建一个`)
        if (kind === 'expert' && !expertIds.has(id)) throw new Error(`${index + 1} 项的专家「${id}」不存在：核对「设置 → 专家」里的 id`)
        return { kind, id }
      })
      columns[status] = members.length === 0
        ? { kind: 'none', id: '' }
        : { kind: 'pool', id: '', members, strategy: body.strategy }
    } else if (body.owner === null) {
      // 重置成默认负责人：默认值也要按当前角色白名单算（删掉的角色位不能指回去）。
      columns[status] = defaultColumns(roles)[status]
    } else {
      /* 三条写路径必须同一种语义：`kind:'role'` 就是角色位，不许静默降级成「绑死某个专家」。
         issue #149 现象一：面板/脚本按角色位配置，落库变成 kind:'expert'，域路由直接失效。 */
      const kind = body.kind === 'team' ? 'team' : body.kind === 'none' ? 'none' : body.kind === 'role' ? 'role' : 'expert'
      const id = String(body.id ?? '').trim()
      if (kind === 'role' && !roles.includes(id)) throw new Error(`角色「${id}」不在 config.roles 里（可选：${roles.join(' / ')}）：先到「设置 → 角色位」加上，或换一个角色`)
      if (kind === 'team' && !teamIds.has(id)) throw new Error(`专家团「${id}」不存在：先到「设置 → 专家团」建一个`)
      if (kind === 'expert' && !expertIds.has(id)) throw new Error(`专家「${id}」不存在：核对「设置 → 专家」里的 id`)
      columns[status] = { kind, id, ...(columns[status]?.wip !== undefined ? { wip: columns[status].wip } : {}) }
    }
    const next = sanitizeColumns(columns, config.experts, config.teams, roles)
    /* 改列负责人是一台起动机：列 owner 一旦能解析，下一轮 tick 就把存量卡派出去。
       先把「会让哪些卡被带走」算出来（issue #149 现象二）——dryRun 只看不写，真落库也带回 affected。 */
    const dispatcher = host.getDispatcher()
    const column = STATUSES.find(entry => entry.id === status)
    const affected = column === undefined ? undefined : dispatchPreview({
      tasks: snapshot.tasks,
      status,
      autoStatuses: config.agents?.autoStatuses,
      handoff: {
        maxAttempts: Math.max(1, Math.trunc(Number(config.agents?.retry?.max ?? 2)) + 1),
        cooldownMs: Math.max(0, Number(config.agents?.retry?.baseMs ?? 60_000)),
      },
      running: dispatcher === undefined ? [] : [...dispatcher.running.values()].map(info => info.taskId),
      before: task => ownerFor(config, task, column, dispatcher?.loadByExpert?.() ?? new Map(), snapshot),
      after: task => ownerFor({ ...config, columns: next }, task, column, dispatcher?.loadByExpert?.() ?? new Map(), snapshot),
    })
    if (body.dryRun === true) {
      host.sendJson(res, 200, {
        ok: true,
        dryRun: true,
        status,
        column: next[status],
        affected,
        warning: previewWarning(affected),
      })
      return true
    }
    await host.applyConfig(store, { columns: next })
    host.sendJson(res, 200, {
      ok: true,
      status,
      // 回读实际落库的那一列：调用方不用再猜「我刚配的到底是 role 还是 expert」。
      column: store.snapshot().config.columns[status],
      affected,
      warning: previewWarning(affected),
      columns: store.snapshot().config.columns,
      state: host.publicState(store),
    })
    return true
  }
  if (method === 'POST' && route === '/task/delete') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    await store.mutate(state => {
      state.tasks = state.tasks.filter(t => t.id !== id)
      /* 删掉的卡可能还有子卡/重复标记指向它：不清掉就是死链（模块体检会报「父卡不存在」）。 */
      for (const touched of clearDeletedReferences(state.tasks, id)) {
        touched.task.updatedAt = Date.now()
        touched.task.history = [...(touched.task.history ?? []), {
          at: Date.now(), by: '系统', status: touched.task.status,
          note: `引用的卡 ${id} 已被删除，已清掉 ${touched.field === 'parent' ? '父卡' : '重复标记'}`,
        }]
      }
    })
    // 卡没了，替它跑着的会话也要收摊，否则槽位一直被占着。
    host.getDispatcher()?.abortTask?.(id, undefined, '人')
    host.sendJson(res, 200, { ok: true, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/cases/run') {
    // 跨卡回归：勾中的用例按卡分组，一张卡一轮（执行器本来就是按卡跑的），再汇总。
    const body = await host.readJsonBody(req)
    const allKeys = (Array.isArray(body.keys) ? body.keys : []).map(String).filter(key => key.length > 0)
    if (allKeys.length === 0) throw new Error('先勾几条用例再跑')
    const maxRun = store.snapshot().config.limits?.runKeys ?? 60
    if (allKeys.length > maxRun) throw new Error(`一次最多跑 ${maxRun} 条（这次勾了 ${allKeys.length} 条）：分两次跑，或者把它存成套件`)
    const keys = allKeys
    const out = await runCaseKeys(store, keys, { env: body.env, by: String(body.by ?? '回归') })
    host.sendJson(res, 200, { ok: true, ...out, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/suite/list') {
    const suites = await loadSuites(store)
    const cases = collectCases(store.snapshot())
    host.sendJson(res, 200, {
      ok: true,
      suites,
      counts: suites.map(suite => ({ id: suite.id, count: resolveSuiteKeys(suite, cases).length, keys: resolveSuiteKeys(suite, cases) })),
    })
    return true
  }
  if (method === 'POST' && route === '/suite/save') {
    const body = await host.readJsonBody(req)
    const list = await loadSuites(store)
    const rawSuite = body.suite ?? body
    if (String(rawSuite?.name ?? '').trim() === '') throw new Error('套件名称不能为空')
    const incoming = sanitizeSuite({ ...rawSuite, at: Date.now(), by: String(body.by ?? '人').slice(0, 40) })
    const index = list.findIndex(item => item.id === incoming.id)
    /* 「设为默认」要真的换过去：同一时刻只允许一个默认套件，
       所以新设的默认必须把其它套件的 isDefault 清掉。以前只写自己这一条，
       而 saveSuites 保留的是**数组里第一个**默认 —— 目标排在旧默认后面时就永远设不上。 */
    if (incoming.isDefault === true) {
      for (const item of list) if (item.id !== incoming.id) item.isDefault = false
    }
    if (index >= 0) list[index] = incoming
    else list.push(incoming)
    const saved = await saveSuites(store, list)
    const cases = collectCases(store.snapshot())
    host.sendJson(res, 200, { ok: true, suites: saved, counts: saved.map(suite => ({ id: suite.id, count: resolveSuiteKeys(suite, cases).length })) })
    return true
  }
  if (method === 'POST' && route === '/suite/delete') {
    const body = await host.readJsonBody(req)
    const list = await loadSuites(store)
    const wanted = String(body.id ?? '')
    if (!list.some(item => item.id === wanted)) throw new Error(`no suite ${wanted}`)
    const next = list.filter(item => item.id !== wanted)
    host.sendJson(res, 200, { ok: true, suites: await saveSuites(store, next) })
    return true
  }
  if (method === 'POST' && route === '/suite/run') {
    const body = await host.readJsonBody(req)
    const suites = await loadSuites(store)
    const suite = suites.find(item => item.id === String(body.id ?? ''))
    if (suite === undefined) throw new Error('套件不存在')
    const allKeys = resolveSuiteKeys(suite, collectCases(store.snapshot()))
    if (allKeys.length === 0) throw new Error(`套件「${suite.name}」里没有可跑的用例`)
    const keys = allKeys.slice(0, 60)
    const out = await runCaseKeys(store, keys, { env: body.env, by: `套件：${suite.name}`.slice(0, 40) })
    // 套件超过上限不报错（夜间要能跑完），但把截断这件事说出来，别让人以为全跑了。
    if (allKeys.length > keys.length) out.truncated = { ran: keys.length, total: allKeys.length }
    host.sendJson(res, 200, { ok: true, ...out, suite: { id: suite.id, name: suite.name }, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/team/memory') {
    // 团级记忆是 side 键，单独取；纯读。
    host.sendJson(res, 200, { ok: true, memory: await loadTeamMemory(store) })
    return true
  }
  if (method === 'POST' && route === '/team/memory/clear') {
    const body = await host.readJsonBody(req)
    await clearTeamMemory(store, String(body.teamId ?? ''))
    host.sendJson(res, 200, { ok: true, memory: await loadTeamMemory(store) })
    return true
  }
  if (method === 'POST' && route === '/cases') {
    // 跨卡用例总览：从台账现算，不落第二份数据。纯读。
    const regressions = await store.readSide('regressions').catch(() => null)
    const cases = collectCases(store.snapshot())
    const suites = await loadSuites(store)
    host.sendJson(res, 200, {
      ok: true,
      cases,
      regressions: Array.isArray(regressions) ? regressions : [],
      suites,
      counts: suites.map(suite => ({ id: suite.id, count: resolveSuiteKeys(suite, cases).length, keys: resolveSuiteKeys(suite, cases) })),
    })
    return true
  }
  if (method === 'POST' && route === '/task/parts') {
    // 用例与清单正文不随 /state 下发，抽屉打开时按卡取一次；纯读。
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    const task = store.snapshot().tasks.find(t => t.id === id)
    if (task === undefined) throw new Error(`no task ${id}`)
    /* 用例正文、清单、执行批次、测试计划一起给：抽屉里的「测试」页要一次画完
       （三层进度 + 每层哪几条 + 最近几次执行的结果），分开取会闪。
       tierEffective 是「显式 tier 或按断言推断」的结果，界面按它分组，不用自己再推一遍。 */
    /* 需求文档改版后，之前通过过的用例要复跑：按「文档更新时间 vs 用例最后一次执行」标 stale，
       只标不改（不改结果、不重置状态），测试看到就能重跑。 */
    const requirement = (store.snapshot().requirements ?? []).find(item => item.id === task.requirementId)
    const docUpdatedAt = requirementDocUpdatedAt(requirement)
    const decoratedCases = (task.cases ?? []).map(item => ({
      ...item,
      tierEffective: tierOf(item),
      stale: caseNeedsRerun(item, docUpdatedAt),
    }))
    host.sendJson(res, 200, {
      ok: true,
      docUpdatedAt,
      staleCount: decoratedCases.filter(item => item.stale === true).length,
      cases: decoratedCases,
      checklist: task.checklist ?? [],
      /* 执行批次只给摘要（最近 5 次）：抽屉只显示「什么时候、过了几条」，
         每条 run 的逐条 results 最多 60 条，全下发会让这个接口白白翻几倍。 */
      testRuns: (task.testRuns ?? []).slice(-5).map(run => ({
        id: run.id, at: run.at, by: run.by, env: run.env, total: run.total, passed: run.passed, failed: run.failed,
      })),
      testPlan: task.testPlan ?? null,
      plan: testPlanSummary(task.cases ?? [], task.testPlan),
    })
    return true
  }
  if (method === 'POST' && route === '/task/comments') {
    // 评论正文不随 /state 下发，抽屉打开时按卡取一次；纯读，不改台账。
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    const task = store.snapshot().tasks.find(t => t.id === id)
    if (task === undefined) throw new Error(`no task ${id}`)
    host.sendJson(res, 200, { ok: true, comments: task.comments ?? [] })
    return true
  }
  if (method === 'POST' && route === '/task/artifact') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    const action = String(body.action ?? 'add')
    // 只读取正文，不动台账：轮询已经把 content 清空，抽屉展开某条交付物时才来这里取。
    if (action === 'get') {
      const task = store.snapshot().tasks.find(t => t.id === id)
      if (task === undefined) throw new Error(`no task ${id}`)
      const artifact = (task.artifacts ?? []).find(item => item.id === String(body.artifactId ?? ''))
      if (artifact === undefined) throw new Error('找不到这条交付物')
      host.sendJson(res, 200, { ok: true, artifact })
      return true
    }
    const snapshot = await store.mutate(state => {
      const task = state.tasks.find(t => t.id === id)
      if (task === undefined) throw new Error(`no task ${id}`)
      if (action === 'add') {
        /* body.artifact 没给时别把整个请求体当交付物：请求体顶层的 id 是**卡 id**，
         直接透传会把交付物 id 写成卡 id（issue #112）。只取交付物自己的字段。 */
      const created = sanitizeArtifact(artifactInputFromBody(body), task.artifacts.length)
        if (created === undefined) throw new Error('交付物至少要有标题')
        created.by = String(body.by ?? created.by ?? '')
        created.at = Date.now()
        const maxArtifacts = store.snapshot().config.limits?.artifactsPerTask ?? 40
        if (task.artifacts.length >= maxArtifacts) throw new Error(`一张卡最多 ${maxArtifacts} 个交付物：先删掉过期的再加`)
        task.artifacts = [...task.artifacts, created]
      } else if (action === 'remove') {
        const wantedArtifact = String(body.artifactId ?? '')
        if (!(task.artifacts ?? []).some(item => item.id === wantedArtifact)) throw new Error(`找不到交付物「${wantedArtifact}」`)
        task.artifacts = task.artifacts.filter(item => item.id !== wantedArtifact)
      } else if (action === 'update') {
        /* 顶层字段也认：以前把 content 放在顶层 → 200 但正文没变，什么都不说（issue #9 第 1 条）。
           找不到目标交付物也直接报错，不再静默返回 ok。 */
        const patch = { ...(body.patch ?? body.artifact ?? {}) }
        for (const key of ['title', 'content', 'kind', 'ref', 'status', 'stage']) {
          if (body[key] !== undefined && patch[key] === undefined) patch[key] = body[key]
        }
        let hit = false
        task.artifacts = task.artifacts.map(item => {
          if (item.id !== String(body.artifactId ?? '')) return item
          hit = true
          const merged = sanitizeArtifact({ ...item, ...patch }, 0) ?? item
          merged.id = item.id
          return merged
        })
        if (hit !== true) throw new Error(`找不到交付物「${String(body.artifactId ?? '')}」：先用 action=get 或 studio_task_get 看清 id`)
      } else {
        throw new Error(`unknown action ${action}`)
      }
      task.updatedAt = Date.now()
      return task
    })
    const task = snapshot.tasks.find(entry => entry.id === id)
    host.sendJson(res, 200, { ok: true, task, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/task/artifact/image') {
    // 截图预览：只读、只认白名单目录下的图片，读成 data URL 回去（不暴露静态文件系统）
    const body = await host.readJsonBody(req)
    const task = store.snapshot().tasks.find(t => t.id === String(body.id ?? ''))
    if (task === undefined) throw new Error('no task ' + String(body.id ?? ''))
    const artifact = (task.artifacts ?? []).find(item => item.id === String(body.artifactId ?? ''))
    if (artifact === undefined) throw new Error('找不到这条交付物')
    const out = await readArtifactImage(artifact.ref)
    host.sendJson(res, out.ok === true ? 200 : 400, out)
    return true
  }
  if (method === 'POST' && route === '/task/artifact/sync') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    const artifactId = String(body.artifactId ?? '')
    const task = store.snapshot().tasks.find(entry => entry.id === id)
    if (task === undefined) throw new Error(`no task ${id}`)
    const targets = (task.artifacts ?? []).filter(item => artifactId === '' || item.id === artifactId)
    if (targets.length === 0) throw new Error('这张卡还没有可归档的交付物')
    const written = []
    const errors = []
    for (const artifact of targets) {
      try {
        written.push({ id: artifact.id, doc: await host.syncArtifact(store, id, artifact.id) })
      } catch (error) {
        errors.push({ id: artifact.id, title: artifact.title, error: String(error?.message ?? error).slice(0, 200) })
      }
    }
    const fresh = store.snapshot().tasks.find(entry => entry.id === id)
    host.sendJson(res, 200, { ok: errors.length === 0, task: fresh, written, errors, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/task/checklist') {
    const body = await host.readJsonBody(req)
    rejectUnknownFields('/task/checklist', body)
    const id = String(body.id ?? '')
    const action = String(body.action ?? 'toggle')
    const by = String(body.by ?? '人').slice(0, 40)
    const snapshot = await store.mutate(state => {
      const task = state.tasks.find(t => t.id === id)
      if (task === undefined) throw new Error(`no task ${id}`)
      if (action === 'add') {
        const items = (Array.isArray(body.items) ? body.items : [body.text])
          .map(item => String(item ?? '').trim().slice(0, 200))
          .filter(item => item.length > 0)
        for (const text of items) {
          task.checklist.push({ id: `c${task.checklist.length + 1}-${randomBytes(2).toString('hex')}`, text, done: false, by: '', at: 0, note: '' })
          /* 卡和功能点各写各的会脱节：卡上补的清单项顺手回写到需求的功能点（重复不写）。 */
          appendPointAcceptance(state, task, text)
        }
        task.checklist = task.checklist.slice(0, 30)
      } else if (action === 'remove') {
        task.checklist = task.checklist.filter(item => item.id !== String(body.itemId ?? ''))
      } else {
        const itemId = String(body.itemId ?? '')
        task.checklist = task.checklist.map(item => {
          if (item.id !== itemId) return item
          const done = typeof body.done === 'boolean' ? body.done : !item.done
          return { ...item, done, by: done ? by : '', at: done ? Date.now() : 0, note: String(body.note ?? item.note).slice(0, 400) }
        })
      }
      task.updatedAt = Date.now()
      return task
    })
    const task = snapshot.tasks.find(entry => entry.id === id)
    /* 勾/取消清单时写的备注里 @某人（例如「这条 @开发工程师 补一下」）也要能叫起人。
       备注本身会挂在清单项上，所以只在真的 @ 了某人的时候才补评论。 */
    const noteOut = action === 'toggle' && String(body.note ?? '').trim() !== ''
      ? await publishNoteMentions(
        { store, commentTask: host.commentTask, dispatcher: host.getDispatcher(), parseMentions },
        { taskId: id, note: String(body.note ?? ''), by, commentMode: 'mentions', label: '清单备注' },
      )
      : { mentions: [], dispatched: [], commented: false }
    host.sendJson(res, 200, { ok: true, task, ...noteOut, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/task/case') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    const action = String(body.action ?? 'add')
    const by = String(body.by ?? '人').slice(0, 40)
    const snapshot = await store.mutate(state => {
      const task = state.tasks.find(t => t.id === id)
      if (task === undefined) throw new Error(`no task ${id}`)
      const list = Array.isArray(task.cases) ? task.cases : []
      if (action === 'add') {
        const raw = Array.isArray(body.cases) ? body.cases : [body.case ?? body]
        /* testing.allowShell 关着时，即使请求里带了 shell 定义也不落库 ——
           否则「关了开关」只是不能跑，但用例还是建得出来，安全边界是假的。 */
        const allowShell = store.snapshot().config?.testing?.allowShell === true
        const added = sanitizeCases(raw.map(item => ({
          ...item,
          http: item.http ?? (item.url !== undefined && String(item.url).trim().length > 0
            ? { method: item.method, url: item.url, body: item.body, expectStatus: item.expectStatus, expectContains: item.expectContains }
            : undefined),
          by,
          at: Date.now(),
          // 开关关着就把 shell 定义丢掉（其它字段照常保存）
          shell: allowShell ? item.shell : undefined,
        })))
        // 一条都没加进去就别报成功：以前传错 payload（比如漏了 title）会静默返回 200，调用方以为建好了。
        if (added.length === 0) throw new Error('没有用例被加进去：每条用例至少要有标题（title）')
        for (const item of added) {
          if (list.length >= 60) break
          list.push({ ...item, id: `c${list.length + 1}-${randomBytes(2).toString('hex')}` })
        }
      } else if (action === 'remove') {
        /* 找不到就报错（issue #164）：以前 filter 对不存在的 id 是恒等操作，返回 200 但什么都没写。 */
        if (list.some(item => item.id === String(body.caseId ?? '')) === false) {
          throw new Error(`no case ${String(body.caseId ?? '')} on task ${task.id}${list.length === 0 && String(task.parent ?? '') !== '' ? `；这张卡自己没有用例，来源用例可能挂在父卡 ${task.parent} 上` : ''}`)
        }
        task.cases = list.filter(item => item.id !== String(body.caseId ?? ''))
        task.updatedAt = Date.now()
        return task
      } else {
        const caseId = String(body.caseId ?? '')
        if (list.some(item => item.id === caseId) === false) {
          throw new Error(`no case ${caseId} on task ${task.id}${list.length === 0 && String(task.parent ?? '') !== '' ? `；这张卡自己没有用例，来源用例可能挂在父卡 ${task.parent} 上` : ''}`)
        }
        if (body.result !== undefined && CASE_RESULTS.includes(String(body.result)) === false) {
          throw new Error(`result 只认 ${CASE_RESULTS.join(' / ')}，收到「${String(body.result)}」（issue #164）`)
        }
        task.cases = list.map(item => {
          if (item.id !== caseId) return item
          const merged = { ...item }
          if (body.result !== undefined && CASE_RESULTS.includes(String(body.result))) merged.result = String(body.result)
          if (body.title !== undefined) merged.title = String(body.title).trim().slice(0, 200) || item.title
          if (body.expected !== undefined) merged.expected = String(body.expected).trim().slice(0, 300)
          if (body.note !== undefined) merged.note = String(body.note).trim().slice(0, 400)
          if (body.http !== undefined) merged.http = sanitizeCaseHttp(body.http)
          /* 另外三种执行方式也要能改：以前只认 http，写错命令/SQL/地址只能删了重建，
             历史与 lastRun 一起丢。开关没开时不许改定义，避免「跑不了还改得挺欢」。 */
          if (body.shell !== undefined) {
            if (body.shell !== null && store.snapshot().config?.testing?.allowShell !== true) throw new Error('shell 用例开关没开（testing.allowShell）：先在 设置 → 测试执行 打开「允许 shell 用例」')
            if (body.shell !== null && sanitizeCaseShell(body.shell) === null) throw new Error('shell 用例至少要有 command')
            merged.shell = sanitizeCaseShell(body.shell)
          }
          if (body.db !== undefined) {
            if (body.db !== null && store.snapshot().config?.testing?.allowDb !== true) throw new Error('数据库用例开关没开（testing.allowDb）：先在 设置 → 测试执行 打开「允许数据库用例」')
            if (body.db !== null && sanitizeDbCase(body.db) === null) throw new Error('数据库用例至少要有 file 与 sql')
            merged.db = sanitizeDbCase(body.db)
          }
          if (body.browser !== undefined) {
            if (body.browser !== null && store.snapshot().config?.testing?.allowBrowser !== true) throw new Error('浏览器用例开关没开（testing.allowBrowser）：先在 设置 → 测试执行 打开「允许浏览器用例」')
            if (body.browser !== null && sanitizeCaseBrowser(body.browser) === null) throw new Error('浏览器用例至少要有 url')
            merged.browser = sanitizeCaseBrowser(body.browser)
          }
          if (body.pointId !== undefined) merged.pointId = String(body.pointId).trim().slice(0, 24)
          /* 工具侧一直能改 acceptanceId（studio_task_case 的 update 分支），路由漏了这一段：
             面板与脚本想给用例补「验的是哪条验收条件」只能删了重建。 */
          if (body.acceptanceId !== undefined) merged.acceptanceId = String(body.acceptanceId).trim().slice(0, 24)
          if (body.tier !== undefined) merged.tier = sanitizeTier(body.tier)
          if (body.flaky !== undefined) merged.flaky = body.flaky === true
          if (body.type !== undefined && CASE_TYPES.includes(String(body.type))) merged.type = String(body.type)
          if (body.priority !== undefined && CASE_PRIORITIES.includes(String(body.priority).toLowerCase())) merged.priority = String(body.priority).toLowerCase()
          if (body.preconditions !== undefined) merged.preconditions = String(body.preconditions).slice(0, 800)
          if (body.steps !== undefined) {
            merged.steps = (Array.isArray(body.steps) ? body.steps : [])
              .map(item => String(item ?? '').trim().slice(0, 200))
              .filter(item => item !== '')
              .slice(0, 20)
          }
          merged.by = by
          merged.at = Date.now()
          return merged
        })
        task.updatedAt = Date.now()
        return task
      }
      const maxCases = store.snapshot().config.limits?.casesPerTask ?? 60
      if (list.length > maxCases) throw new Error(`一张卡最多 ${maxCases} 条用例（这次是 ${list.length} 条）：先删掉不用的再加，别让它被静默截断`)
      task.cases = list
      task.updatedAt = Date.now()
      return task
    })
    const task = snapshot.tasks.find(entry => entry.id === id)
    // 用例判失败就自动开缺陷：Bug 不再是人工另建的一种「任务类型」。
    let autoBug = null
    let autoBugError = ''
    let autoBugSkipped = ''
    if (String(body.result ?? '') === 'fail' && task !== undefined) {
      const failed = (Array.isArray(task.cases) ? task.cases : []).find(item => item.id === String(body.caseId ?? ''))
      if (failed !== undefined && failed.flaky !== true) {
        try {
          const outcome = await host.autoBugFromCase(store, task, failed, by)
          autoBug = outcome.bug
          autoBugSkipped = String(outcome.skipped ?? '')
        } catch (error) {
          autoBugError = String(error?.message ?? error)
        }
      }
    }
    const latest = store.snapshot()
    host.sendJson(res, 200, {
      ok: true,
      task: latest.tasks.find(entry => entry.id === id),
      bug: autoBug,
      error: autoBugError,
      skipped: autoBugSkipped,
      state: host.publicState(store),
    })
    return true
  }
  if (method === 'POST' && route === '/task/test-plan') {
    /* 测试计划：单元 / 集成 / 端到端里哪一层不适用（带理由）。
       不传 tiers 只读回进度；声明不合法整条拒绝（和工具层同一份 applyTierDeclarations）。 */
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    const by = String(body.by ?? '测试').slice(0, 40)
    const tiers = Array.isArray(body.tiers) ? body.tiers : []
    const before = store.snapshot().tasks.find(item => item.id === id)
    if (before === undefined) throw new Error(`no task ${id}`)
    const applied = applyTierDeclarations(before.testPlan, tiers, { by, at: Date.now() })
    if (applied.errors.length > 0) throw new Error(applied.errors.join('；'))
    if (applied.changed > 0) {
      await store.mutate(state => {
        const task = state.tasks.find(item => item.id === id)
        if (task === undefined) return
        task.testPlan = applied.plan
        task.updatedAt = Date.now()
      })
    }
    const latest = store.snapshot().tasks.find(item => item.id === id)
    host.sendJson(res, 200, {
      ok: true,
      task: latest,
      plan: testPlanSummary(latest.cases ?? [], latest.testPlan),
      state: host.publicState(store),
    })
    return true
  }
  if (method === 'POST' && route === '/task/case/run') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    if (body.diag === true) {
      host.sendJson(res, 200, {
        ok: true,
        storeType: typeof store,
        hasSnapshot: typeof store?.snapshot,
        hasMutate: typeof store?.mutate,
        keys: Object.keys(store ?? {}).slice(0, 16),
        runType: typeof host.runTaskCases,
      })
      return true
    }
    const caseIds = body.caseId !== undefined && String(body.caseId).length > 0 ? [String(body.caseId)] : body.caseIds
    const result = await host.runTaskCases(store, id, {
      origin: originOf(req),
      caseIds: Array.isArray(caseIds) ? caseIds : undefined,
      env: body.env,
      by: String(body.by ?? '测试').slice(0, 40),
    })
    host.sendJson(res, 200, { ok: true, run: result.run, env: result.env, bugs: result.bugs, state: result.state })
    return true
  }
  if (method === 'POST' && route === '/tests/run') {
    const body = await host.readJsonBody(req)
    const options = {
      taskIds: Array.isArray(body.taskIds) ? body.taskIds : undefined,
      env: body.env,
      by: String(body.by ?? '测试').slice(0, 40),
      concurrency: body.concurrency,
    }
    /* 整批回归可能跑几分钟（一条用例最长 600s）：同步等会被反代 60s 断连，
       面板报错而用例还在跑。默认「提交即返回 202」，结果写回各自的卡，靠 /state 轮询看；
       脚本要同步结果就传 wait:true（与 /task/quality 同一套口径）。 */
    if (body.wait !== true) {
      host.sendJson(res, 202, { ok: true, queued: true, note: '已提交后台执行：跑完结果写回各张卡（刷新可见）' })
      void runSuite(store, options).catch(error => {
        host.recordAudit?.(store, { by: options.by, route: '/tests/run', level: 'write', status: 500, ok: false, summary: `整批回归没跑成：${String(error?.message ?? error).slice(0, 120)}` })
      })
      return true
    }
    const result = await runSuite(store, options)
    host.sendJson(res, 200, { ok: true, concurrency: result.concurrency, tasks: result.tasks, state: result.state })
    return true
  }
  return false
}
