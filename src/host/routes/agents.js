import { ISOLATION_MODES, SANDBOX_MODES } from '../domain.js'
import { effectiveSandbox, sanitizeEscalation } from '../escalation.js'
import { rejectUnknownFields } from '../route-contract.js'
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
if ((method === 'GET' || method === 'POST') && route === '/agents/policy') {
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
      // 实际生效的档位：提权审批=自动批准时直接是完全访问（与 dispatcher 落 preset 同一份判据）
      effectiveSandbox: effectiveSandbox({ globalSandbox: cfg.sandbox, escalation: cfg.escalation }),
      escalation: sanitizeEscalation(cfg.escalation),
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
  rejectUnknownFields('/agents/run', body)
  /* 失败原因分开报（issue #148 第 3 条）：卡不存在 / 目标不存在（或停用、团没人）/ 这一列没人负责。
     以前三种都落在「这一列还没人负责」，指向的设置面板还解决不了问题。
     `expert` 既认专家 id，也认专家团 id（派给团长）；`instruction` 会拼进提示词。 */
  await dispatcher.launchNow(String(body.id ?? ''), String(body.expert ?? ''), String(body.instruction ?? ''))
  host.sendJson(res, 200, { ok: true, state: host.publicState(store), agents: dispatcher.status() })
  return true
}
if (method === 'POST' && route === '/agents/chat') {
  /* 无卡会话（issue #148）：选一位专家或一个专家团，说一句想聊什么，开聊。
     会话 id 是 studio-chat-<expert>-<hex>，跑对话模式的提示词，不往任何卡写评论。 */
  const dispatcher = host.getDispatcher()
  if (dispatcher === undefined) throw new Error('dispatcher not available yet')
  const body = await host.readJsonBody(req)
  rejectUnknownFields('/agents/chat', body)
  const started = await dispatcher.startChat({
    expert: String(body.expert ?? body.team ?? ''),
    // 专家团可以指定由哪位成员接话（为空 = 团长）
    member: String(body.member ?? ''),
    topic: String(body.topic ?? ''),
    instruction: String(body.instruction ?? ''),
    workdir: String(body.workdir ?? ''),
  })
  host.sendJson(res, 200, { ok: true, ...started })
  return true
}
if (method === 'POST' && route === '/agents/stop') {
  const dispatcher = host.getDispatcher()
  if (dispatcher === undefined) throw new Error('dispatcher not available yet')
  const body = await host.readJsonBody(req)
  rejectUnknownFields('/agents/stop', body)
  // 无卡会话按 sessionId 停；卡派单按卡 id（+ 可选专家）停。
  const sessionId = String(body.sessionId ?? '').trim()
  if (sessionId !== '') {
    const stopped = dispatcher.abortSession(sessionId)
    host.sendJson(res, 200, { ok: true, stopped, sessionId })
    return true
  }
  const id = String(body.id ?? '')
  dispatcher.abortTask(id, body.expert === undefined ? undefined : String(body.expert), '人')
  host.sendJson(res, 200, { ok: true, state: host.publicState(store) })
  return true
}
  return false
}
