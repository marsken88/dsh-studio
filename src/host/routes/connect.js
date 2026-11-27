import { INTEGRATION, feishuPush, gitlabReady, gitlabRequest, gitlabSync, healthReport, projectReady } from '../integrations.js'
import { cleanId } from '../domain.js'
const INJECTED = ['mirrorCardsToBitable', "applyConfig","installedPackages","publicState","readJsonBody","resolvePackageName","runPluginCli","sendJson","getSyncTimer","upsertById"]
let host = {
  mirrorCardsToBitable: () => ({ ok: false, error: '未注入' }),
  applyConfig: () => {},
  installedPackages: () => {},
  publicState: () => {},
  readJsonBody: () => {},
  resolvePackageName: () => {},
  runPluginCli: () => {},
  sendJson: () => {},
  getSyncTimer: () => undefined,
  upsertById: () => {},
}
/** 市场、集成健康、GitLab 同步、仓库与飞书机器人。宿主能力由 configureConnectRoutes() 注入。 */
export function configureConnectRoutes(services) {
  host = { ...host, ...(services ?? {}) }
}

export async function handleConnectRoute({ method, route, req, res, store, url }) {
if (method === 'GET' && route === '/market') {
  const market = store.snapshot().config.market
  host.sendJson(res, 200, {
    ok: true,
    title: market.title,
    items: market.items,
    installed: await host.installedPackages(),
    /* 目录是空的不是坏了：这一页的条目由公司自己维护（issue #5 第 10 条）。
       给一句能照着做的提示，比留一块白板强。 */
    hint: (market.items ?? []).length > 0
      ? ''
      : '市场目录还没配：面板里点「＋ 添加条目」，或 POST /studio-api/market/save { "item": { "name": "插件名", "spec": "@scope/dsh-xxx@0.1.0", "description": "一句话说明" } }',
  })
  return true
}
if (method === 'POST' && route === '/market/install') {
  const body = await host.readJsonBody(req)
  const item = store.snapshot().config.market.items.find(entry => entry.id === String(body.id ?? ''))
  if (item === undefined) throw new Error('unknown market item')
  const result = await host.runPluginCli(['add', item.spec])
  host.sendJson(res, 200, { ok: result.ok, result, installed: await host.installedPackages(), restartRequired: result.ok })
  return true
}
if (method === 'POST' && route === '/market/uninstall') {
  const body = await host.readJsonBody(req)
  const item = store.snapshot().config.market.items.find(entry => entry.id === String(body.id ?? ''))
  const requested = String(body.pkg ?? '').trim()
  const pkg = requested.length > 0 ? requested : (item === undefined ? undefined : await host.resolvePackageName(item.spec))
  if (pkg === undefined) throw new Error('unknown market item')
  const result = await host.runPluginCli(['remove', pkg])
  host.sendJson(res, 200, { ok: result.ok, pkg, result, installed: await host.installedPackages(), restartRequired: result.ok })
  return true
}
if (method === 'GET' && route === '/integrations') {
  const config = store.snapshot().config
  host.sendJson(res, 200, {
    ok: true,
    gitlab: {
      ready: gitlabReady(config),
      syncing: host.getSyncTimer() !== undefined,
      projects: (config.gitlab.projects ?? []).map(project => ({
        id: project.id,
        ready: projectReady(config, project),
        lastSyncAt: project.lastSyncAt,
        lastSyncError: project.lastSyncError,
      })),
    },
    feishu: {
      ready: (config.feishu.bots ?? []).some(bot => bot.enabled && bot.webhook.length > 0),
      lastError: INTEGRATION.lastPushError,
    },
    health: healthReport(),
  })
  return true
}
if (method === 'GET' && route === '/integrations/health') {
  host.sendJson(res, 200, { ok: true, ...healthReport() })
  return true
}
if (method === 'POST' && route === '/gitlab/sync') {
  const body = await host.readJsonBody(req).catch(() => ({}))
  const summary = await gitlabSync(store, body.project === undefined ? undefined : String(body.project))
  host.sendJson(res, 200, { ok: true, summary, state: host.publicState(store) })
  return true
}
if (method === 'POST' && route === '/repos/save') {
  const body = await host.readJsonBody(req)
  // 老前端发 {project}，新脚本发 {repo}，两个都认。
  const incoming = body.repo ?? body.project ?? body
  if (String(incoming.name ?? incoming.project ?? '').trim() === '') {
    throw new Error('仓库至少要填一个名字（或者 GitLab 项目路径），否则存下来是一条空记录')
  }
  const existing = store.snapshot().config.gitlab.projects
  const wantedId = cleanId(incoming.id ?? incoming.name ?? incoming.project, 'repo')
  const saved = existing.find(item => item.id === wantedId)
  const merged = {
    ...incoming,
    id: wantedId,
    /* 空 token = 「保留已存的」；要**撤销**就得显式 clearToken（令牌泄漏时界面得能撤掉，
       以前只能删项目或改库）。 */
    token: incoming.clearToken === true ? '' : (String(incoming.token ?? '').trim() || (saved?.token ?? '')),
  }
  delete merged.clearToken
  await host.applyConfig(store, { gitlab: { projects: host.upsertById(existing, merged) } })
  // 只回公开视图：token 不能出现在响应里。
  const state = host.publicState(store)
  host.sendJson(res, 200, { ok: true, repos: state.config.gitlab.projects, state })
  return true
}
if (method === 'POST' && route === '/repos/delete') {
  const body = await host.readJsonBody(req)
  const id = cleanId(body.id, 'repo')
  await host.applyConfig(store, { gitlab: { projects: store.snapshot().config.gitlab.projects.filter(entry => entry.id !== id) } })
  host.sendJson(res, 200, { ok: true, state: host.publicState(store) })
  return true
}
if (method === 'POST' && route === '/repos/test') {
  const body = await host.readJsonBody(req)
  const config = store.snapshot().config
  const project = config.gitlab.projects.find(entry => entry.id === cleanId(body.id, 'repo'))
  if (project === undefined) throw new Error('unknown project')
  if (!projectReady(config, project)) throw new Error('这个仓库还没填全：地址 / 项目路径 / 访问令牌')
  const info = await gitlabRequest(config, project, '/issues?per_page=1')
  host.sendJson(res, 200, { ok: true, reachable: true, sample: Array.isArray(info) ? info.length : 0 })
  return true
}
if (method === 'POST' && route === '/bots/save') {
  const body = await host.readJsonBody(req)
  const incoming = body.bot ?? body
  if (String(incoming.name ?? '').trim() === '') throw new Error('机器人名称不能为空')
  const existing = store.snapshot().config.feishu.bots
  const wantedId = cleanId(incoming.id ?? incoming.name, 'bot')
  const saved = existing.find(item => item.id === wantedId)
  const merged = {
    ...incoming,
    id: wantedId,
    /* 空 webhook = 「保留已存的」；要撤销用 clearWebhook（机器人被删/换群时省得删了重建）。 */
    webhook: incoming.clearWebhook === true ? '' : (String(incoming.webhook ?? '').trim() || (saved?.webhook ?? '')),
  }
  delete merged.clearWebhook
  await host.applyConfig(store, { feishu: { bots: host.upsertById(existing, merged) } })
  const state = host.publicState(store)
  host.sendJson(res, 200, { ok: true, bots: state.config.feishu.bots, state })
  return true
}
if (method === 'POST' && route === '/bots/delete') {
  const body = await host.readJsonBody(req)
  const id = cleanId(body.id, 'bot')
  await host.applyConfig(store, { feishu: { bots: store.snapshot().config.feishu.bots.filter(entry => entry.id !== id) } })
  host.sendJson(res, 200, { ok: true, state: host.publicState(store) })
  return true
}
if (method === 'POST' && route === '/feishu/mirror') {
    // 把卡片镜像进飞书多维表格；dryRun 只算条数不写
    const body = await host.readJsonBody(req)
    const result = await host.mirrorCardsToBitable(store, { requirementId: body.requirementId ?? '', dryRun: body.dryRun === true })
    host.sendJson(res, 200, { ok: result.ok === true, ...result, state: result.ok === true ? host.publicState(store) : undefined })
    return true
  }
if (method === 'POST' && route === '/feishu/test') {
  const body = await host.readJsonBody(req).catch(() => ({}))
  const config = store.snapshot().config
  const wanted = body.id === undefined ? '' : cleanId(body.id, 'bot')
  const bots = (config.feishu.bots ?? []).filter(bot => wanted.length === 0 || bot.id === wanted)
  const results = []
  for (const bot of bots) {
    try {
      const result = await feishuPush(bot.webhook, '【需求&任务工作空间】这是一条测试消息，收到即说明群通知已接通。')
      results.push({ bot: bot.id, name: bot.name, ...result })
    } catch (error) {
      results.push({ bot: bot.id, name: bot.name, ok: false, error: String(error?.message ?? error).slice(0, 200) })
    }
  }
  host.sendJson(res, 200, { ok: results.some(entry => entry.ok === true), results })
  return true
}
if (method === 'POST' && route === '/reset') {
  await store.mutate(state => { state.tasks = [] })
  host.sendJson(res, 200, { ok: true, state: host.publicState(store) })
  return true
}
  return false
}
