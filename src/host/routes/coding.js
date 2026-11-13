import { CODING_REVIEW_STATUS, cleanId, mergeCoding, sanitizeCoding } from '../domain.js'
import { clearAgentFailure, noteAgentFailure } from '../dispatcher.js'
import { codingVerifyLine, runCommand, taskExitGate, verifyCodingRecord } from '../executor.js'
import { compareCodingFacts } from '../gitlab-facts.js'
const INJECTED = ["applyConfig","ensureWorktree","publicState","readJsonBody","removeWorktree","sendJson","serviceOf","upsertById","workProjectOf"]
let host = {
  applyConfig: () => {},
  ensureWorktree: () => {},
  publicState: () => {},
  readJsonBody: () => {},
  removeWorktree: () => {},
  sendJson: () => {},
  serviceOf: () => {},
  upsertById: () => {},
  workProjectOf: () => {},
}
/** 执行记录核对、Agent 失败重试、worktree 与项目配置。宿主能力由 configureCodingRoutes() 注入。 */
export function configureCodingRoutes(services) {
  host = { ...host, ...(services ?? {}) }
}

export async function handleCodingRoute({ method, route, req, res, store, url }) {
if (method === 'POST' && route === '/coding/gitlab') {
  // 从 GitLab 核对：拉 MR + changes，和卡上自报的文件数/提交数比一遍，结果记进 coding.gitlab。
  const body = await host.readJsonBody(req)
  const id = String(body.id ?? '')
  const snapshot = store.snapshot()
  const task = snapshot.tasks.find(t => t.id === id)
  if (task === undefined) throw new Error(`no task ${id}`)
  const iid = Number(task.gitlabMR?.iid ?? 0)
  if (iid <= 0) throw new Error('这张卡还没关联 MR：先提 MR，把 !iid 填进卡片的 GitLab 区块')
  const config = snapshot.config
  const projects = config.gitlab?.projects ?? []
  const project = projects.find(item => item.id === task.gitlabProject) ?? projects[0]
  if (project === undefined) throw new Error('还没配 GitLab 项目（设置 → 代码仓库）')
  const mr = await host.gitlabRequest(config, project, `/merge_requests/${iid}`)
  const detail = await host.gitlabMergeRequestDetail(config, project, iid)
  const facts = compareCodingFacts(task.coding, mr, detail)
  await store.mutate(state => {
    const target = state.tasks.find(t => t.id === id)
    if (target === undefined) return
    target.coding = { ...(target.coding ?? {}), gitlab: facts }
    target.updatedAt = Date.now()
  })
  host.sendJson(res, 200, { ok: true, facts, state: host.publicState(store) })
  return true
}
if (method === 'POST' && route === '/task/coding') {
  const body = await host.readJsonBody(req)
  const id = String(body.id ?? '')
  const action = String(body.action ?? 'update')
  const by = String(body.by ?? '人').slice(0, 40)
  const snapshot = await store.mutate(state => {
    const task = state.tasks.find(t => t.id === id)
    if (task === undefined) throw new Error(`no task ${id}`)
    if (action === 'clear') {
      task.coding = null
    } else if (action === 'review') {
      const base = sanitizeCoding(task.coding ?? {})
      const status = CODING_REVIEW_STATUS.includes(String(body.status)) ? String(body.status) : 'approved'
      task.coding = sanitizeCoding({
        ...base,
        review: { status, by, at: Date.now(), note: String(body.note ?? '').slice(0, 600) },
      })
    } else if (action === 'merge') {
      const base = sanitizeCoding(task.coding ?? {})
      task.coding = sanitizeCoding({ ...base, mergedBy: by, mergedAt: Date.now() })
    } else {
      const patch = body.coding ?? body.patch ?? body
      task.coding = mergeCoding(task.coding ?? null, patch)
    }
    task.updatedAt = Date.now()
    return task
  })
  const task = snapshot.tasks.find(entry => entry.id === id)
  host.sendJson(res, 200, { ok: true, task, state: host.publicState(store) })
  return true
}
if (method === 'POST' && route === '/task/coding/verify') {
  // 拿 worktree 里的 git 事实核对执行记录：agent 说改了哪些提交/文件，真的在分支上吗。
  const body = await host.readJsonBody(req)
  const id = String(body.id ?? '')
  const current = store.snapshot().tasks.find(entry => entry.id === id)
  if (current === undefined) throw new Error(`no task ${id}`)
  const report = await verifyCodingRecord(store.snapshot(), current)
  if (report.skipped === undefined) {
    await store.mutate(state => {
      const task = state.tasks.find(entry => entry.id === id)
      if (task !== undefined && task.coding !== null && task.coding !== undefined) {
        task.coding = sanitizeCoding({ ...task.coding, verified: report })
      }
      return task
    })
  }
  const state = store.snapshot()
  const task = state.tasks.find(entry => entry.id === id)
  host.sendJson(res, 200, {
    ok: true,
    report,
    line: codingVerifyLine(report),
    gate: taskExitGate(state, task),
    task,
    state: host.publicState(store),
  })
  return true
}
if (method === 'POST' && route === '/task/agent/fail') {
  // 记一次 AI 失败（真失败时由派单器调用；也可由 agent 自己上报）。
  const body = await host.readJsonBody(req)
  const id = String(body.id ?? '')
  const plan = await noteAgentFailure(store, id, String(body.error ?? 'AI 没有完成这一轮'), String(body.by ?? '系统').slice(0, 60))
  if (plan === undefined) throw new Error(`no task ${id}`)
  const state = store.snapshot()
  const task = state.tasks.find(entry => entry.id === id)
  host.sendJson(res, 200, { ok: true, plan, task, gate: taskExitGate(state, task), state: host.publicState(store) })
  return true
}
if (method === 'POST' && route === '/task/agent/retry') {
  const body = await host.readJsonBody(req)
  const id = String(body.id ?? '')
  const changed = await clearAgentFailure(store, id, String(body.by ?? '人').slice(0, 60))
  if (!changed) throw new Error(`no task ${id}`)
  const state = store.snapshot()
  const task = state.tasks.find(entry => entry.id === id)
  host.sendJson(res, 200, { ok: true, task, state: host.publicState(store) })
  return true
}
if (method === 'POST' && route === '/task/worktree') {
  const body = await host.readJsonBody(req)
  const id = String(body.id ?? '')
  const action = String(body.action ?? 'create')
  const snapshotNow = store.snapshot()
  const task = snapshotNow.tasks.find(entry => entry.id === id)
  if (task === undefined) throw new Error(`no task ${id}`)
  if (action === 'remove') {
    const result = await host.removeWorktree(store, task, snapshotNow.config)
    host.sendJson(res, 200, { ok: result.ok, result, state: host.publicState(store) })
    return true
  }
  if (action === 'list') {
    const service = host.serviceOf(snapshotNow.config, task)
    const project = host.workProjectOf(snapshotNow.config, task)
    const repo = String(service?.repoPath ?? project?.repoPath ?? '').trim()
    const listed = repo.length === 0
      ? { ok: false, stdout: '', stderr: '项目没配本机代码目录' }
      : await runCommand('git', ['-C', repo, 'worktree', 'list', '--porcelain'], 20000)
    host.sendJson(res, 200, { ok: listed.ok, output: String(listed.stdout ?? ''), error: String(listed.stderr ?? ''), state: host.publicState(store) })
    return true
  }
  const info = await host.ensureWorktree(store, task, snapshotNow.config)
  host.sendJson(res, 200, {
    ok: info?.path !== undefined,
    worktree: info ?? null,
    skipped: info?.skipped ?? '',
    state: host.publicState(store),
  })
  return true
}
if (method === 'POST' && route === '/projects/save') {
  const body = await host.readJsonBody(req)
  const incoming = body.project ?? body
  const existing = store.snapshot().config.projects
  const wantedId = cleanId(incoming.id ?? incoming.name ?? incoming.key, 'proj')
  const saved = existing.find(item => item.id === wantedId)
  const merged = { ...incoming, id: wantedId, iterations: incoming.iterations ?? saved?.iterations ?? [] }
  await host.applyConfig(store, { projects: host.upsertById(existing, merged) })
  host.sendJson(res, 200, { ok: true, projects: store.snapshot().config.projects, state: host.publicState(store) })
  return true
}
if (method === 'POST' && route === '/projects/delete') {
  const body = await host.readJsonBody(req)
  const id = cleanId(body.id, 'proj')
  await host.applyConfig(store, { projects: store.snapshot().config.projects.filter(entry => entry.id !== id) })
  host.sendJson(res, 200, { ok: true, state: host.publicState(store) })
  return true
}
if (method === 'POST' && route === '/projects/iteration') {
  const body = await host.readJsonBody(req)
  const action = String(body.action ?? 'save')
  const projectId = cleanId(body.project, 'proj')
  const projects = store.snapshot().config.projects.map(project => {
    if (project.id !== projectId) return project
    if (action === 'remove') {
      return { ...project, iterations: project.iterations.filter(item => item.id !== cleanId(body.iteration, 'iter')) }
    }
    const wantedId = cleanId(body.iteration ?? body.name, 'iter')
    const saved = project.iterations.find(item => item.id === wantedId)
    const merged = {
      ...saved,
      id: wantedId,
      name: String(body.name ?? saved?.name ?? wantedId).slice(0, 60),
      start: Number(body.start ?? saved?.start) || 0,
      due: Number(body.due ?? saved?.due) || 0,
      status: ['planned', 'active', 'closed'].includes(String(body.status)) ? String(body.status) : (saved?.status ?? 'planned'),
    }
    return { ...project, iterations: host.upsertById(project.iterations, merged) }
  })
  await host.applyConfig(store, { projects })
  host.sendJson(res, 200, { ok: true, state: host.publicState(store) })
  return true
}
  return false
}
