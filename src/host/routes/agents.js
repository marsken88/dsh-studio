import { ISOLATION_MODES, SANDBOX_MODES } from '../domain.js'
const INJECTED = ["getDispatcher","publicState","readJsonBody","sendJson"]
let host = {
  getDispatcher: () => undefined,
  publicState: () => {},
  readJsonBody: () => {},
  sendJson: () => {},
}
/** 派单运行态、策略与手动起停。宿主能力由 configureAgentsRoutes() 注入。 */
export function configureAgentsRoutes(services) {
  host = { ...host, ...(services ?? {}) }
}

export async function handleAgentsRoute({ method, route, req, res, store, url }) {
if (method === 'GET' && route === '/agents') {
  const dispatcher = host.getDispatcher()
  host.sendJson(res, 200, dispatcher === undefined
    ? { ok: false, error: 'dispatcher not available yet' }
    : { ok: true, ...dispatcher.status() })
  return true
}
if (method === 'GET' && route === '/agents/policy') {
  const dispatcher = host.getDispatcher()
  if (dispatcher === undefined) {
    host.sendJson(res, 200, { ok: false, error: 'dispatcher not available yet' })
    return true
  }
  const cfg = store.snapshot().config.agents
  const live = []
  for (const info of dispatcher.running.values()) {
    let current = ''
    try {
      const agent = dispatcher.ctx.agents.get(info.sessionId)
      current = String(dispatcher.ctx.permissionPresets.current(agent?.session))
    } catch (error) {
      current = `unknown: ${error?.message ?? error}`
    }
    live.push({ sessionId: info.sessionId, expert: info.expert, taskId: info.taskId, preset: current })
  }
  host.sendJson(res, 200, {
    ok: true,
    configured: {
      sandbox: SANDBOX_MODES.includes(String(cfg.sandbox ?? '')) ? cfg.sandbox : 'workspace-write',
      isolation: ISOLATION_MODES.includes(String(cfg.isolation ?? '')) ? cfg.isolation : 'none',
      worktreeRoot: String(cfg.worktreeRoot ?? ''),
      cleanupWorktree: String(cfg.cleanupWorktree ?? 'manual'),
    },
    isolation: cfg.isolation ?? 'none',
    live,
  })
  return true
}
if (method === 'POST' && route === '/agents/run') {
  const dispatcher = host.getDispatcher()
  if (dispatcher === undefined) throw new Error('dispatcher not available yet')
  const body = await host.readJsonBody(req)
  await dispatcher.launchNow(String(body.id ?? ''), String(body.expert ?? ''))
  host.sendJson(res, 200, { ok: true, state: host.publicState(store), agents: dispatcher.status() })
  return true
}
if (method === 'POST' && route === '/agents/stop') {
  const dispatcher = host.getDispatcher()
  if (dispatcher === undefined) throw new Error('dispatcher not available yet')
  const body = await host.readJsonBody(req)
  const id = String(body.id ?? '')
  dispatcher.abortTask(id, body.expert === undefined ? undefined : String(body.expert))
  host.sendJson(res, 200, { ok: true, state: host.publicState(store) })
  return true
}
  return false
}
