import { REQ_STATUS_LABEL, STATUSES } from '../domain.js'

let host = { sendCsv: () => {}, requirementProgress: () => null, sessions: new Map() }

/** 导出类路由（CSV）。宿主能力由 configureExportRoutes() 注入，避免反向 import index.js。 */
export function configureExportRoutes(services) {
  host = { ...host, ...(services ?? {}) }
}

export function handleExportRoute({ method, route, url, res, store, sendJson }) {
  if (method === 'GET' && route === '/export/tasks.csv') {
    const snapshot = store.snapshot()
    const rows = [['编号', '标题', '类型', '状态', '负责人', '需求', '项目', '迭代', '版本', '阻塞', '截止', '用例通过', '用例总数', '交付物', '更新时间']]
    for (const task of snapshot.tasks) {
      const requirement = snapshot.requirements.find(item => item.id === task.requirementId)
      const project = snapshot.config.projects.find(item => item.id === task.project)
      const iteration = project?.iterations.find(item => item.id === task.iteration)
      const release = snapshot.releases.find(item => item.id === task.releaseId)
      const cases = task.cases ?? []
      rows.push([
        task.code || task.id,
        task.title,
        task.type,
        STATUSES.find(item => item.id === task.status)?.label ?? task.status,
        task.owner ?? '',
        requirement === undefined ? '' : `${requirement.code} ${requirement.title}`.trim(),
        project?.name ?? '',
        iteration?.name ?? '',
        release?.version ?? '',
        task.blocked === null || task.blocked === undefined ? '' : `是：${String(task.blocked.reason ?? '').slice(0, 60)}`,
        task.dueAt > 0 ? new Date(task.dueAt).toISOString().slice(0, 10) : '',
        cases.filter(item => item.result === 'pass').length,
        cases.length,
        (task.artifacts ?? []).length,
        new Date(task.updatedAt).toISOString().slice(0, 19).replace('T', ' '),
      ])
    }
    host.sendCsv(res, rows, 'tasks.csv')
    return true
  }
  if (method === 'GET' && route === '/export/requirements.csv') {
    const snapshot = store.snapshot()
    const rows = [['需求编号', '标题', '状态', '负责人', '项目', '功能点', '已覆盖', '卡数', '已完成', '用例通过', '用例总数', '交付物', '签字', '更新时间']]
    for (const requirement of snapshot.requirements) {
      const progress = host.requirementProgress(snapshot, requirement)
      rows.push([
        requirement.code,
        requirement.title,
        REQ_STATUS_LABEL[requirement.status] ?? requirement.status,
        requirement.owner ?? '',
        snapshot.config.projects.find(item => item.id === requirement.project)?.name ?? '',
        progress.gate.stats.points,
        progress.gate.stats.coveredPoints,
        progress.cards.total,
        progress.cards.done,
        progress.gate.stats.pass,
        progress.gate.stats.cases,
        progress.gate.stats.artifacts,
        requirement.signoff === null ? '' : `${requirement.signoff.by} ${new Date(requirement.signoff.at).toISOString().slice(0, 10)}`,
        new Date(requirement.updatedAt).toISOString().slice(0, 19).replace('T', ' '),
      ])
    }
    host.sendCsv(res, rows, 'requirements.csv')
    return true
  }
  if (method === 'GET' && route === '/audit/export.csv') {
    const snapshot = store.snapshot()
    const cfg = snapshot.config
    if (cfg?.ldap?.enabled === true && cfg?.ldap?.requireLogin === true) {
      const token = String(url.searchParams.get('token') ?? '')
      const session = token === '' ? null : host.sessions.get(token)
      if (session === null || (Number(session.expiresAt) || 0) <= Date.now()) {
        sendJson(res, 401, { ok: false, error: '导出审计日志要先登录' })
        return
      }
    }
    const by = String(url.searchParams.get('by') ?? '').trim()
    const keyword = String(url.searchParams.get('q') ?? '').trim().toLowerCase()
    const onlyFailed = url.searchParams.get('failed') === '1'
    const list = (snapshot.audit ?? []).filter(item => (by === '' || item.by === by)
      && (onlyFailed === false || item.ok === false)
      && (keyword === '' || `${item.route} ${item.by} ${item.summary}`.toLowerCase().includes(keyword)))
    const csvRows = [['时间', '操作人', '动作', '详情', '结果']]
    for (const item of list.slice(0, 5000)) {
      csvRows.push([
        new Date(item.at).toISOString().slice(0, 19).replace('T', ' '),
        item.by,
        item.route,
        item.summary,
        item.ok ? '成功' : `失败 ${item.status}`,
      ])
    }
    host.sendCsv(res, csvRows, `audit-${new Date().toISOString().slice(0, 10)}.csv`)
    return true
  }
  if (method === 'GET' && route === '/export/dispatch.csv') {
    const snapshot = store.snapshot()
    const cfg = snapshot.config
    if (cfg?.ldap?.enabled === true && cfg?.ldap?.requireLogin === true) {
      const token = String(url.searchParams.get('token') ?? '')
      const session = token === '' ? null : host.sessions.get(token)
      if (session === null || (Number(session.expiresAt) || 0) <= Date.now()) {
        sendJson(res, 401, { ok: false, error: '导出派单日志要先登录' })
        return
      }
    }
    const keyword = String(url.searchParams.get('q') ?? '').trim().toLowerCase()
    const onlyFailed = url.searchParams.get('failed') === '1'
    const list = (snapshot.agents?.log ?? []).filter(entry => {
      const line = String(entry?.line ?? '')
      if (onlyFailed && !/失败|错误|异常|拦|拒绝/.test(line)) return false
      return keyword === '' || line.toLowerCase().includes(keyword)
    })
    const csvRows = [['时间', '内容']]
    for (const entry of list.slice(0, 2000)) {
      csvRows.push([new Date(Number(entry.at) || 0).toISOString().slice(0, 19).replace('T', ' '), String(entry.line ?? '')])
    }
    host.sendCsv(res, csvRows, `dispatch-${new Date().toISOString().slice(0, 10)}.csv`)
    return true
  }
  return false
}
