import {
  RELEASE_STATUSES,
  sanitizeRelease,
} from '../domain.js'
const INJECTED = ["publicState","readJsonBody","releaseDeploys","releaseGate","releaseNotes","releaseRequirements","releaseRuleViolations","sendJson"]
let host = {
  publicState: () => {},
  readJsonBody: () => {},
  releaseDeploys: () => {},
  releaseGate: () => {},
  releaseNotes: () => {},
  releaseRequirements: () => {},
  releaseRuleViolations: () => {},
  sendJson: () => {},
}
/** 发布（版本、审批、灰度、部署、回滚）相关路由。宿主能力由 configureReleasesRoutes() 注入。 */
export function configureReleasesRoutes(services) {
  host = { ...host, ...(services ?? {}) }
}
export async function handleReleasesRoute({ method, route, req, res, store, url }) {
  if (method === 'GET' && route === '/releases') {
    const state = store.snapshot()
    const releases = state.releases.map(item => {
      const gate = host.releaseGate(state, item)
      return { ...item, gate, counts: gate.stats }
    })
    host.sendJson(res, 200, { ok: true, releases, statuses: RELEASE_STATUSES })
    return true
  }
  if (method === 'POST' && route === '/release/get') {
    const body = await host.readJsonBody(req)
    const state = store.snapshot()
    const release = state.releases.find(item => item.id === String(body.id ?? ''))
    if (release === undefined) throw new Error('版本不存在')
    const tasks = state.tasks.filter(task => task.releaseId === release.id)
    host.sendJson(res, 200, {
      ok: true,
      release: { ...release, requirements: host.releaseRequirements(state, release), deploys: host.releaseDeploys(state, release) },
      gate: host.releaseGate(state, release),
      tasks,
    })
    return true
  }
  if (method === 'POST' && route === '/release/save') {
    const body = await host.readJsonBody(req)
    const raw = body.release ?? body
    // 部分更新（只带 id + 某几个字段）时，先把已有版本垫在下面，避免「只改 tag」被判成没填版本号。
    const known = raw.id === undefined
      ? undefined
      : store.snapshot().releases.find(item => item.id === String(raw.id))
    const incoming = sanitizeRelease(known === undefined ? raw : { ...known, ...raw })
    if (incoming === null) throw new Error('版本至少要填一个版本号或名字')
    let saved = null
    await store.mutate(state => {
      const existing = state.releases.find(item => item.id === incoming.id)
      if (existing === undefined) {
        saved = { ...incoming, createdAt: Date.now(), updatedAt: Date.now() }
        state.releases.push(saved)
        return true
      }
      // 已发布/已回滚的版本不允许改版本号，避免「同一个 tag 两套内容」。
      const locked = existing.status === 'released' || existing.status === 'rolled_back'
      saved = {
        ...existing,
        name: incoming.name,
        project: incoming.project,
        owner: incoming.owner,
        status: locked ? existing.status : incoming.status,
        plannedAt: incoming.plannedAt,
        notes: incoming.notes !== '' ? incoming.notes : existing.notes,
        tagName: incoming.tagName !== '' ? incoming.tagName : existing.tagName,
        commitSha: incoming.commitSha !== '' ? incoming.commitSha : existing.commitSha,
        smoke: incoming.smoke.length > 0 ? incoming.smoke : existing.smoke,
        updatedAt: Date.now(),
      }
      state.releases[state.releases.indexOf(existing)] = saved
    })
    host.sendJson(res, 200, { ok: true, release: saved, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/release/delete') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    await store.mutate(state => {
      state.releases = state.releases.filter(item => item.id !== id)
      for (const task of state.tasks) {
        if (task.releaseId === id) {
          task.releaseId = ''
          task.updatedAt = Date.now()
        }
      }
    })
    host.sendJson(res, 200, { ok: true, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/release/link') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    const action = String(body.action ?? 'add')
    const taskIds = Array.isArray(body.taskIds)
      ? body.taskIds.map(value => String(value))
      : [String(body.taskId ?? '')]
    await store.mutate(state => {
      if (!state.releases.some(item => item.id === id)) throw new Error('版本不存在')
      for (const task of state.tasks) {
        if (!taskIds.includes(task.id)) continue
        task.releaseId = action === 'remove' ? '' : id
        task.updatedAt = Date.now()
      }
    })
    host.sendJson(res, 200, { ok: true, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/release/smoke') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    const action = String(body.action ?? 'add')
    const by = String(body.by ?? '人').slice(0, 60)
    let release = null
    await store.mutate(state => {
      const found = state.releases.find(item => item.id === id)
      if (found === undefined) throw new Error('版本不存在')
      if (action === 'add') {
        const label = String(body.text ?? '').trim().slice(0, 200)
        if (label === '') throw new Error('冒烟项要有内容：写清楚发布前必须验证什么')
        found.smoke.push({ id: `s-${Math.random().toString(36).slice(2, 7)}`, text: label, done: false, by: '', at: 0 })
      } else if (action === 'toggle') {
        const item = found.smoke.find(entry => entry.id === String(body.itemId ?? ''))
        if (item === undefined) throw new Error('冒烟项不存在')
        item.done = body.done === undefined ? item.done !== true : body.done === true
        item.by = item.done ? by : ''
        item.at = item.done ? Date.now() : 0
      } else if (action === 'remove') {
        found.smoke = found.smoke.filter(entry => entry.id !== String(body.itemId ?? ''))
      }
      found.updatedAt = Date.now()
      release = { ...found }
    })
    host.sendJson(res, 200, { ok: true, release, gate: host.releaseGate(store.snapshot(), release), state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/release/notes') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    let release = null
    await store.mutate(state => {
      const found = state.releases.find(item => item.id === id)
      if (found === undefined) throw new Error('版本不存在')
      found.notes = host.releaseNotes(state, found)
      found.updatedAt = Date.now()
      release = { ...found }
    })
    host.sendJson(res, 200, { ok: true, release, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/release/approve') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    const by = String(body.by ?? '人').slice(0, 120)
    let release = null
    let gate = null
    await store.mutate(state => {
      const found = state.releases.find(item => item.id === id)
      if (found === undefined) throw new Error('版本不存在')
      gate = host.releaseGate(state, found)
      if (!gate.ready) throw new Error(`门禁没过：${gate.blockers.join('；')}`)
      found.status = 'approved'
      found.approveBy = by
      found.approveAt = Date.now()
      found.approvals = [...(found.approvals ?? []), {
        id: `ap-${Date.now().toString(36)}`,
        by,
        role: 'release',
        at: Date.now(),
        note: String(body.note ?? '').slice(0, 600),
      }].slice(-20)
      found.deployLog = [...(found.deployLog ?? []), {
        at: Date.now(), by, action: 'approve', note: String(body.note ?? '').slice(0, 600),
      }].slice(-200)
      found.updatedAt = Date.now()
      release = { ...found }
    })
    host.sendJson(res, 200, { ok: true, release, gate, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/release/publish') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    const by = String(body.by ?? '人').slice(0, 120)
    let release = null
    await store.mutate(state => {
      const found = state.releases.find(item => item.id === id)
      if (found === undefined) throw new Error('版本不存在')
      if (found.status === 'released') throw new Error('这个版本已经发布过了')
      const gate = host.releaseGate(state, found)
      if (!gate.ready) throw new Error(`门禁没过：${gate.blockers.join('；')}`)
      // 发布准入（可配）：没满足就走强制发布，但必须写原因，留在部署日志里。
      const violations = host.releaseRuleViolations(state, found)
      const forced = violations.length > 0
      const forceNote = String(body.forceNote ?? '').slice(0, 300)
      if (forced && body.force !== true) throw new Error(`发布准入没过：${violations.join('；')}。确实要发就勾上「强制发布」并写原因`)
      if (forced && forceNote.trim() === '') throw new Error('强制发布必须写清楚原因（会记进部署日志）')
      found.status = 'released'
      found.releasedAt = Date.now()
      found.approveBy = found.approveBy === '' ? by : found.approveBy
      found.approveAt = found.approveAt === 0 ? Date.now() : found.approveAt
      found.notes = found.notes === '' ? host.releaseNotes(state, found) : found.notes
      found.deployLog = [...(found.deployLog ?? []), {
        at: Date.now(),
        by,
        action: 'publish',
        note: `tag ${found.tagName || '—'}${found.commitSha === '' ? '' : ` · ${String(found.commitSha).slice(0, 8)}`}${forced ? ` · 强制发布（${violations.join('；')}）原因：${forceNote}` : ''}`,
      }].slice(-200)
      found.updatedAt = Date.now()
      release = { ...found }
    })
    host.sendJson(res, 200, { ok: true, release, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/release/gray') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    const action = String(body.action ?? 'add')
    const by = String(body.by ?? '人').slice(0, 120)
    const note = String(body.note ?? '').slice(0, 600)
    let release = null
    let gate = null
    await store.mutate(state => {
      const found = state.releases.find(item => item.id === id)
      if (found === undefined) throw new Error('版本不存在')
      const batches = found.grayBatches ?? []
      if (action === 'add') {
        if (batches.length >= 20) throw new Error('灰度批次最多 20 批')
        const percent = Math.max(0, Math.min(100, Number(body.percent) || 0))
        if (percent <= 0) throw new Error('灰度比例要大于 0，例如 10')
        batches.push({
          id: `g-${Date.now().toString(36)}`,
          name: String(body.name ?? '').slice(0, 120) || `第 ${batches.length + 1} 批 ${percent}%`,
          percent,
          status: 'pending',
          by,
          at: Date.now(),
          note,
        })
      } else {
        const target = batches.find(item => item.id === String(body.batchId ?? ''))
        if (target === undefined) throw new Error('找不到这一批灰度')
        if (action === 'advance') {
          if (target.status === 'passed') throw new Error('这一批已经走完了')
          target.status = 'passed'
          target.at = Date.now()
          target.note = note || target.note
        } else if (action === 'start') {
          target.status = 'running'
          target.at = Date.now()
        } else if (action === 'rollback') {
          if (note === '') throw new Error('灰度回滚要写原因')
          target.status = 'rolled_back'
          target.at = Date.now()
          target.note = note
          found.status = 'rolled_back'
          found.rollbackReason = `灰度「${target.name}」回滚：${note}`
        } else {
          throw new Error(`unknown gray action: ${action}`)
        }
        target.by = by
      }
      found.grayBatches = batches
      found.deployLog = [...(found.deployLog ?? []), {
        at: Date.now(), by, action: `gray-${action}`, note: note || `${batches.length} 批`,
      }].slice(-200)
      found.updatedAt = Date.now()
      release = { ...found }
      gate = host.releaseGate(state, found)
    })
    host.sendJson(res, 200, { ok: true, release, gate, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/release/deploy') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    const envId = String(body.env ?? '')
    const by = String(body.by ?? '人').slice(0, 120)
    const note = String(body.note ?? '').trim().slice(0, 600)
    let release = null
    let deploys = []
    await store.mutate(state => {
      const found = state.releases.find(item => item.id === id)
      if (found === undefined) throw new Error('版本不存在')
      const env = (state.config.environments ?? []).find(item => item.id === envId)
      if (env === undefined) throw new Error('先选一个部署环境（设置 → 环境里可以加）')
      // 只写一条记录，不碰任何部署系统：平台不触发 CD。
      found.deployLog = [...(found.deployLog ?? []), {
        at: Date.now(), by, action: 'deploy', env: env.id, note: note || `登记部署到「${env.name}」`,
      }].slice(-200)
      found.updatedAt = Date.now()
      deploys = host.releaseDeploys(state, found)
      release = { ...found, deploys }
    })
    host.sendJson(res, 200, { ok: true, release, deploys, mode: 'record-only', state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/release/rollback') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    const reason = String(body.reason ?? '').trim().slice(0, 600)
    if (reason === '') throw new Error('回滚要写清楚原因，之后复盘要用')
    let release = null
    await store.mutate(state => {
      const found = state.releases.find(item => item.id === id)
      if (found === undefined) throw new Error('版本不存在')
      if (found.status !== 'released') throw new Error('只有已发布的版本才能回滚')
      found.status = 'rolled_back'
      found.rollbackReason = reason
      found.deployLog = [...(found.deployLog ?? []), {
        at: Date.now(), by: String(body.by ?? '人').slice(0, 120), action: 'rollback', note: reason,
      }].slice(-200)
      found.updatedAt = Date.now()
      release = { ...found }
    })
    host.sendJson(res, 200, { ok: true, release, state: host.publicState(store) })
    return true
  }
  return false
}
