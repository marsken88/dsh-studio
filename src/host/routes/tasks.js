import { randomBytes } from 'node:crypto'
import { collectCases, groupCaseKeys, loadSuites, resolveSuiteKeys, sanitizeSuite, saveSuites, summarizeRun } from '../cases.js'
import { clearTeamMemory, loadTeamMemory } from '../team-memory.js'
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
  sanitizeArtifact,
  sanitizeCaseHttp,
  sanitizeCases,
  text,
} from '../domain.js'
import { runSuite } from '../executor.js'

const INJECTED = ['sendJson', 'readJsonBody', 'createTask', 'updateTask', 'commentTask', 'runTaskCases', 'syncArtifact', 'getDispatcher', 'applyConfig', 'autoBugFromCase', 'publicState', 'upsertById']

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
      const out = await host.runTaskCases(store, taskId, { caseIds, env: options.env, by })
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
  return { results, regression: record }
}

export async function handleTaskRoute({ method, route, req, res, store, url }) {
  if (method === 'POST' && route === '/task/create') {
    const task = await host.createTask(store, await host.readJsonBody(req))
    host.sendJson(res, 200, { ok: true, task, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/task/update') {
    const body = await host.readJsonBody(req)
    const task = await host.updateTask(store, String(body.id ?? ''), body.patch ?? body)
    host.sendJson(res, 200, { ok: true, task, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/task/block') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    const reason = text(body.reason, 500) ?? ''
    if (reason === '') {
      host.sendJson(res, 400, { ok: false, error: '请写清楚卡在哪了，方便之后判断怎么继续' })
      return true
    }
    const task = await host.updateTask(store, id, {
      blocked: true,
      blockedReason: reason,
      by: text(body.by, 60) ?? '人',
    })
    // 卡住就停手：把这个专家正在跑的会话收掉，避免它继续往前走。
    host.getDispatcher()?.abortTask?.(id)
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
    const mention = { kind: body.kind === 'team' ? 'team' : 'expert', id: String(body.id ?? '') }
    await dispatcher.dispatchMention(String(body.taskId ?? ''), mention, String(body.instruction ?? ''))
    host.sendJson(res, 200, { ok: true, state: host.publicState(store), agents: dispatcher.status() })
    return true
  }
  if (method === 'POST' && route === '/experts/save') {
    const body = await host.readJsonBody(req)
    await host.applyConfig(store, { experts: host.upsertById(store.snapshot().config.experts, body.expert ?? body) })
    // 把保存后的集合一起返回：脚本 / 前端不用再猜刚存的是哪一条。
    host.sendJson(res, 200, { ok: true, experts: store.snapshot().config.experts, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/experts/delete') {
    const body = await host.readJsonBody(req)
    const id = cleanId(body.id, 'expert')
    await host.applyConfig(store, { experts: store.snapshot().config.experts.filter(expert => expert.id !== id) })
    host.sendJson(res, 200, { ok: true, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/teams/save') {
    const body = await host.readJsonBody(req)
    await host.applyConfig(store, { teams: host.upsertById(store.snapshot().config.teams, body.team ?? body) })
    host.sendJson(res, 200, { ok: true, teams: store.snapshot().config.teams, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/teams/delete') {
    const body = await host.readJsonBody(req)
    const id = cleanId(body.id, 'team')
    await host.applyConfig(store, { teams: store.snapshot().config.teams.filter(team => team.id !== id) })
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
    const status = String(body.status ?? '')
    if (!STATUS_SET.has(status)) throw new Error(`unknown status ${status}`)
    const columns = { ...store.snapshot().config.columns }
    if (Array.isArray(body.members)) {
      columns[status] = body.members.length === 0
        ? { kind: 'none', id: '' }
        : {
          kind: 'pool',
          id: '',
          members: body.members.map(entry => ({ kind: entry?.kind === 'team' ? 'team' : entry?.kind === 'role' ? 'role' : 'expert', id: String(entry?.id ?? '') })),
          strategy: body.strategy,
        }
    } else if (body.owner === null) {
      columns[status] = defaultColumns()[status]
    } else {
      const kind = body.kind === 'team' ? 'team' : body.kind === 'none' ? 'none' : 'expert'
      columns[status] = { kind, id: String(body.id ?? '') }
    }
    await host.applyConfig(store, { columns })
    host.sendJson(res, 200, { ok: true, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/task/delete') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    await store.mutate(state => {
      state.tasks = state.tasks.filter(t => t.id !== id)
    })
    // 卡没了，替它跑着的会话也要收摊，否则槽位一直被占着。
    host.getDispatcher()?.abortTask?.(id)
    host.sendJson(res, 200, { ok: true, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/cases/run') {
    // 跨卡回归：勾中的用例按卡分组，一张卡一轮（执行器本来就是按卡跑的），再汇总。
    const body = await host.readJsonBody(req)
    const keys = (Array.isArray(body.keys) ? body.keys : []).map(String).filter(key => key.length > 0).slice(0, 60)
    if (keys.length === 0) throw new Error('先勾几条用例再跑')
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
    const incoming = sanitizeSuite({ ...(body.suite ?? body), at: Date.now(), by: String(body.by ?? '人').slice(0, 40) })
    const index = list.findIndex(item => item.id === incoming.id)
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
    const next = list.filter(item => item.id !== String(body.id ?? ''))
    host.sendJson(res, 200, { ok: true, suites: await saveSuites(store, next) })
    return true
  }
  if (method === 'POST' && route === '/suite/run') {
    const body = await host.readJsonBody(req)
    const suites = await loadSuites(store)
    const suite = suites.find(item => item.id === String(body.id ?? ''))
    if (suite === undefined) throw new Error('套件不存在')
    const keys = resolveSuiteKeys(suite, collectCases(store.snapshot())).slice(0, 60)
    if (keys.length === 0) throw new Error(`套件「${suite.name}」里没有可跑的用例`)
    const out = await runCaseKeys(store, keys, { env: body.env, by: `套件：${suite.name}`.slice(0, 40) })
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
    host.sendJson(res, 200, { ok: true, cases: task.cases ?? [], checklist: task.checklist ?? [] })
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
        const created = sanitizeArtifact(body.artifact ?? body, task.artifacts.length)
        if (created === undefined) throw new Error('交付物至少要有标题')
        created.by = String(body.by ?? created.by ?? '')
        created.at = Date.now()
        task.artifacts = [...task.artifacts, created].slice(0, 40)
      } else if (action === 'remove') {
        task.artifacts = task.artifacts.filter(item => item.id !== String(body.artifactId ?? ''))
      } else if (action === 'update') {
        task.artifacts = task.artifacts.map(item => {
          if (item.id !== String(body.artifactId ?? '')) return item
          const merged = sanitizeArtifact({ ...item, ...(body.patch ?? body.artifact ?? {}) }, 0) ?? item
          merged.id = item.id
          return merged
        })
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
    host.sendJson(res, 200, { ok: true, task, state: host.publicState(store) })
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
        const added = sanitizeCases(raw.map(item => ({
          ...item,
          http: item.http ?? (item.url !== undefined && String(item.url).trim().length > 0
            ? { method: item.method, url: item.url, body: item.body, expectStatus: item.expectStatus, expectContains: item.expectContains }
            : undefined),
          by,
          at: Date.now(),
        })))
        for (const item of added) {
          if (list.length >= 60) break
          list.push({ ...item, id: `c${list.length + 1}-${randomBytes(2).toString('hex')}` })
        }
      } else if (action === 'remove') {
        task.cases = list.filter(item => item.id !== String(body.caseId ?? ''))
        task.updatedAt = Date.now()
        return task
      } else {
        const caseId = String(body.caseId ?? '')
        task.cases = list.map(item => {
          if (item.id !== caseId) return item
          const merged = { ...item }
          if (body.result !== undefined && CASE_RESULTS.includes(String(body.result))) merged.result = String(body.result)
          if (body.title !== undefined) merged.title = String(body.title).trim().slice(0, 200) || item.title
          if (body.expected !== undefined) merged.expected = String(body.expected).trim().slice(0, 300)
          if (body.note !== undefined) merged.note = String(body.note).trim().slice(0, 400)
          if (body.http !== undefined) merged.http = sanitizeCaseHttp(body.http)
          if (body.pointId !== undefined) merged.pointId = String(body.pointId).trim().slice(0, 24)
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
      task.cases = list.slice(0, 60)
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
      caseIds: Array.isArray(caseIds) ? caseIds : undefined,
      env: body.env,
      by: String(body.by ?? '测试').slice(0, 40),
    })
    host.sendJson(res, 200, { ok: true, run: result.run, env: result.env, bugs: result.bugs, state: result.state })
    return true
  }
  if (method === 'POST' && route === '/tests/run') {
    const body = await host.readJsonBody(req)
    const result = await runSuite(store, {
      taskIds: Array.isArray(body.taskIds) ? body.taskIds : undefined,
      env: body.env,
      by: String(body.by ?? '测试').slice(0, 40),
      concurrency: body.concurrency,
    })
    host.sendJson(res, 200, { ok: true, concurrency: result.concurrency, tasks: result.tasks, state: result.state })
    return true
  }
  return false
}
