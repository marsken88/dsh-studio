import {
  INTAKE_HTML,
  MINE_HTML,
  REQ_STATUS_LABEL,
  STATUS_HTML,
  cleanId,
  sanitizeRequirementPool,
  text,
} from '../domain.js'
import {
  ensureReqFolder,
  mutateReqDoc,
  pullFeishuDoc,
  requirementGate,
  requirementMatrix,
  requirementProgress,
  requirementRollup,
  saveRequirement,
  syncRequirementArtifacts,
  taskExitGate,
} from '../executor.js'
import { randomBytes } from 'node:crypto'
const INJECTED = ["createTask","publicState","readJsonBody","sendJson"]
let host = {
  createTask: () => {},
  publicState: () => {},
  readJsonBody: () => {},
  sendJson: () => {},
}
/** 需求（含交付物、文档、飞书同步）相关路由。宿主能力由 configureRequirementRoutes() 注入。 */
export function configureRequirementRoutes(services) {
  host = { ...host, ...(services ?? {}) }
}
export async function handleRequirementRoute({ method, route, req, res, store, url }) {
  if (method === 'GET' && route === '/requirements') {
    const state = store.snapshot()
    const requirements = state.requirements.map(item => {
      const progress = requirementProgress(state, item)
      return {
        ...item,
        counts: {
          tasks: state.tasks.filter(task => task.requirementId === item.id).length,
          done: state.tasks.filter(task => task.requirementId === item.id && task.status === 'done').length,
          bugs: state.tasks.filter(task => task.requirementId === item.id && task.type === 'bug' && task.status !== 'done').length,
        },
        progress,
      }
    })
    requirements.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.code).localeCompare(String(b.code)))
    host.sendJson(res, 200, { ok: true, requirements })
    return true
  }
  if (method === 'POST' && route === '/requirement/get') {
    const body = await host.readJsonBody(req)
    const rollup = requirementRollup(store.snapshot(), String(body.id ?? ''))
    if (rollup === undefined) throw new Error('需求不存在')
    const matrix = requirementMatrix(store.snapshot(), rollup.requirement)
    const progress = requirementProgress(store.snapshot(), rollup.requirement)
    host.sendJson(res, 200, { ok: true, ...rollup, matrix, progress })
    return true
  }
  if (method === 'POST' && route === '/requirement/matrix') {
    const body = await host.readJsonBody(req)
    const requirement = store.snapshot().requirements.find(item => item.id === String(body.id ?? ''))
    if (requirement === undefined) throw new Error('需求不存在')
    host.sendJson(res, 200, { ok: true, requirement: { id: requirement.id, code: requirement.code, title: requirement.title }, matrix: requirementMatrix(store.snapshot(), requirement) })
    return true
  }
  if (method === 'POST' && route === '/requirement/signoff') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    const action = body.action === 'clear' ? 'clear' : 'sign'
    const note = String(body.note ?? '').trim().slice(0, 600)
    const by = String(body.by ?? req.headers['x-studio-user'] ?? '').trim().slice(0, 60) || '人'
    if (action === 'sign' && note === '') throw new Error('需求验收签字要写一句结论：交付了什么、遗留什么')
    const snapshot = await store.mutate(state => {
      const target = state.requirements.find(item => item.id === id)
      if (target === undefined) throw new Error('需求不存在')
      if (action === 'sign') {
        target.signoff = { by, at: Date.now(), note }
        const open = state.tasks.filter(task => task.requirementId === id && task.status !== 'done').length
        const total = state.tasks.filter(task => task.requirementId === id).length
        // 签完字且卡全完成，需求自动落到「已交付」；否则留在进行中，等卡收口。
        if (open === 0 && total > 0) target.status = 'delivered'
      } else {
        target.signoff = null
        if (target.status === 'delivered') target.status = 'active'
      }
      target.updatedAt = Date.now()
    })
    const requirement = snapshot.requirements.find(item => item.id === id)
    host.sendJson(res, 200, {
      ok: true,
      requirement,
      progress: requirementProgress(snapshot, requirement),
      signoff: requirement.signoff ?? null,
      state: host.publicState(store),
    })
    return true
  }
  if (method === 'POST' && route === '/task/gate') {
    const body = await host.readJsonBody(req)
    const task = store.snapshot().tasks.find(entry => entry.id === String(body.id ?? ''))
    if (task === undefined) throw new Error('任务不存在')
    host.sendJson(res, 200, { ok: true, gate: taskExitGate(store.snapshot(), task), signoff: task.signoff ?? null })
    return true
  }
  if (method === 'POST' && route === '/task/signoff') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    const action = String(body.action ?? 'sign')
    const by = text(body.by, 40) ?? '人'
    const note = text(body.note, 600) ?? ''
    const task = await store.mutate(state => {
      const entry = state.tasks.find(item => item.id === id)
      if (entry === undefined) throw new Error('任务不存在')
      if (action === 'clear') {
        entry.signoff = null
        entry.history.push({ at: Date.now(), by, status: entry.status, note: 'signoff-cleared' })
      } else {
        if (note.length === 0) throw new Error('验收签字要写一句结论：验了什么、遗留什么')
        entry.signoff = { by, at: Date.now(), note }
        entry.history.push({ at: Date.now(), by, status: entry.status, note: `signoff：${note.slice(0, 80)}` })
      }
      entry.updatedAt = Date.now()
    })
    void task
    const signed = store.snapshot().tasks.find(item => item.id === id)
    host.sendJson(res, 200, { ok: true, task: signed, gate: taskExitGate(store.snapshot(), signed), state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/requirement/save') {
    const body = await host.readJsonBody(req)
    const incoming = body.requirement ?? body
    const beforeRecord = typeof incoming.id === 'string' ? store.snapshot().requirements.find(item => item.id === incoming.id) : undefined
    const watch = ['title', 'description', 'priority', 'status', 'owner', 'project', 'iteration']
    const before = beforeRecord === undefined ? null : Object.fromEntries(watch.map(key => [key, String(beforeRecord[key] ?? '')]))
    const requirement = await saveRequirement(store, incoming)
    if (before !== null) {
      const diffs = watch
        .map(key => ({ field: key, from: before[key], to: String(requirement[key] ?? '') }))
        .filter(item => item.from !== item.to)
      if (diffs.length > 0) {
        const by = String(incoming.by ?? incoming.operator ?? '人').slice(0, 40)
        await store.mutate(state => {
          const target = state.requirements.find(item => item.id === requirement.id)
          if (target === undefined) return
          const clipped = value => value.length > 300 ? `${value.slice(0, 300)}…` : value
          target.history = [...(target.history ?? []), ...diffs.map(item => ({ at: Date.now(), by, field: item.field, from: clipped(item.from), to: clipped(item.to) }))].slice(-100)
        })
      }
    }
    const snapshot = store.snapshot()
    const saved = snapshot.requirements.find(item => item.id === requirement.id) ?? requirement
    host.sendJson(res, 200, { ok: true, requirement, progress: requirementProgress(snapshot, saved), state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/requirement/review') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    const decision = String(body.decision ?? 'approve')
    if (!['submit', 'approve', 'reject'].includes(decision)) throw new Error('未知的评审动作：submit / approve / reject')
    const by = String(body.by ?? '').trim().slice(0, 60) || '人'
    const note = String(body.note ?? '').slice(0, 600)
    if (decision === 'reject' && note.trim() === '') throw new Error('打回要说清楚哪里不行，写一句评审意见')
    let saved
    await store.mutate(state => {
      const found = state.requirements.find(item => item.id === id)
      if (found === undefined) throw new Error(`no requirement ${id}`)
      const now = Date.now()
      if (decision === 'submit') {
        found.status = 'review'
        found.review = { status: 'pending', by, at: now, note }
      } else if (decision === 'approve') {
        found.status = found.status === 'closed' ? 'closed' : 'active'
        found.review = { status: 'approved', by, at: now, note }
      } else {
        found.status = 'draft'
        found.review = { status: 'changes_requested', by, at: now, note }
      }
      found.updatedAt = now
      saved = found
    })
    const snapshot = store.snapshot()
    const requirement = snapshot.requirements.find(item => item.id === id) ?? saved
    host.sendJson(res, 200, { ok: true, requirement, review: requirement.review ?? null, progress: requirementProgress(snapshot, requirement), state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/requirement/split') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    const requested = (Array.isArray(body.pointIds) ? body.pointIds : []).map(item => String(item))
    const column = String(body.status ?? 'clarify')
    const before = store.snapshot()
    const requirement = before.requirements.find(item => item.id === id)
    if (requirement === undefined) throw new Error(`no requirement ${id}`)
    const approved = (requirement.review ?? null)?.status === 'approved'
    const started = ['active', 'delivered', 'closed'].includes(requirement.status)
    if (!approved && !started) throw new Error('需求还没评审通过，先过评审再拆卡')
    const points = (requirement.points ?? []).filter(point => requested.length === 0 || requested.includes(point.id))
    const uncovered = points.filter(point => !before.tasks.some(task => task.requirementId === id && task.pointId === point.id))
    if (uncovered.length === 0) throw new Error('这些功能点都已经有卡了')
    const created = []
    for (const point of uncovered) {
      const task = await host.createTask(store, {
        title: `${point.id} ${point.title}`.slice(0, 200),
        type: 'requirement',
        requirementId: id,
        pointId: point.id,
        project: requirement.project,
        iteration: requirement.iteration,
        priority: requirement.priority,
        status: column,
        requirement: point.description ?? point.title,
      })
      created.push(task)
    }
    host.sendJson(res, 200, { ok: true, created, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/requirement/pool') {
    const body = await host.readJsonBody(req)
    const id = cleanId(body.id, 'req')
    const pool = sanitizeRequirementPool(body.pool ?? body)
    let next = null
    await store.mutate(state => {
      const target = state.requirements.find(item => item.id === id)
      if (target !== undefined) { target.pool = pool; target.updatedAt = Date.now(); next = target }
    })
    if (next === null) throw new Error('没有这条需求')
    host.sendJson(res, 200, { ok: true, requirement: next, gate: requirementGate(store.snapshot(), next), state: host.publicState(store) })
    return true
  }

  if (method === 'GET' && route === '/intake') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(INTAKE_HTML)
    return true
  }
  if (method === 'POST' && route === '/intake/requirement') {
    const body = await host.readJsonBody(req)
    const title = String(body.title ?? '').trim().slice(0, 200)
    const description = String(body.description ?? '').trim().slice(0, 20000)
    const requester = String(body.requester ?? '').trim().slice(0, 40)
    if (title.length === 0) throw new Error('请填写需求标题')
    if (requester.length === 0) throw new Error('请填写您的姓名')
    if (description.length < 10) throw new Error('请把需求描述写得具体一些（至少 10 个字）')
    const contactKey = String(body.contact ?? '').trim()
    if (contactKey.length > 0) {
      const since = Date.now() - 10 * 60 * 1000
      const recent = (store.snapshot().requirements ?? []).filter(item => item.source === 'business'
        && String(item.requester?.contact ?? '').trim() === contactKey
        && Number(item.requester?.at ?? 0) > since)
      if (recent.length >= 3) throw new Error('同一联系方式 10 分钟内最多提交 3 条，请稍后再试')
    }
    const requirement = await saveRequirement(store, {
      title,
      description,
      status: 'draft',
      priority: String(body.priority ?? 'normal'),
    project: String(body.project ?? ''),
    iteration: String(body.iteration ?? ''),
    links: { prd: String(body.links?.prd ?? body.prd ?? ''), proto: String(body.links?.proto ?? body.proto ?? ''), acceptance: String(body.links?.acceptance ?? body.acceptance ?? '') },
      source: 'business',
      requester: { name: requester, dept: String(body.dept ?? '').slice(0, 40), contact: String(body.contact ?? '').slice(0, 80), at: Date.now() },
    })
    host.sendJson(res, 200, { ok: true, code: requirement.code, id: requirement.id })
    return true
  }

  if (method === 'GET' && route === '/intake/mine') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(MINE_HTML)
    return true
  }
  if (method === 'POST' && route === '/intake/mine/query') {
    const body = await host.readJsonBody(req)
    const contact = String(body.contact ?? '').trim()
    if (contact.length < 4) throw new Error('请填写提交时留的联系方式（至少 4 位）')
    const rows = (store.snapshot().requirements ?? [])
      .filter(item => item.source === 'business' && String(item.requester?.contact ?? '').trim() === contact)
      .sort((left, right) => (Number(right.requester?.at ?? 0) - Number(left.requester?.at ?? 0)) || (Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0)))
      .slice(0, 50)
      .map(item => {
        const cards = (store.snapshot().tasks ?? []).filter(task => task.requirementId === item.id)
        return {
          code: item.code,
          title: item.title,
          status: item.status,
          statusLabel: REQ_STATUS_LABEL[item.status] ?? item.status,
          updatedAt: item.updatedAt,
          openQuestions: (item.questions ?? []).filter(question => question.status === 'open').length,
          cards: cards.length,
          doneCards: cards.filter(task => task.status === 'done').length,
        }
      })
    host.sendJson(res, 200, { ok: true, rows })
    return true
  }
  if (method === 'GET' && route === '/intake/status') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(STATUS_HTML)
    return true
  }
  if (method === 'POST' && route === '/intake/query') {
    const body = await host.readJsonBody(req)
    const code = String(body.code ?? '').trim().toUpperCase()
    const tail = String(body.contact ?? '').trim().replace(/\s+/g, '')
    if (code.length === 0 || tail.length < 4) throw new Error('请填写需求编号，以及联系方式的后四位')
    const hit = (store.snapshot().requirements ?? []).find(item => String(item.code ?? '').toUpperCase() === code)
    const contact = String(hit?.requester?.contact ?? '').replace(/\s+/g, '')
    if (hit === undefined || contact.length === 0 || !contact.endsWith(tail)) throw new Error('没查到：编号或联系方式对不上')
    const cards = (store.snapshot().tasks ?? []).filter(item => item.requirementId === hit.id)
    const open = (hit.questions ?? []).filter(item => item.status === 'open').length
    host.sendJson(res, 200, {
      ok: true,
      code: hit.code,
      title: hit.title,
      status: hit.status,
      statusLabel: REQ_STATUS_LABEL[hit.status] ?? hit.status,
      reviewStatus: hit.review?.status ?? '',
      updatedAt: hit.updatedAt,
      openQuestions: open,
      cards: cards.length,
      doneCards: cards.filter(item => item.status === 'done').length,
    })
    return true
  }

  if (method === 'POST' && route === '/requirement/request-prd') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '').trim()
    const by = String(body.by ?? body.operator ?? '').trim() || '人'
    if (id.length === 0) throw new Error('缺少需求 id')
    const now = Date.now()
    await store.mutate(state => {
      const item = state.requirements.find(entry => entry.id === id)
      if (item === undefined) throw new Error('没有这条需求')
      item.review = { status: 'pending', by, at: now, note: String(body.note ?? '').trim().slice(0, 600) || '业务提单：等产品补 PRD' }
      if (item.status === 'draft') item.status = 'review'
      item.history = [...(item.history ?? []), { at: now, by, field: 'review', from: '', to: '申请产品补 PRD（待评审）' }].slice(-100)
      item.updatedAt = now
    })
    const fresh = store.snapshot()
    const requirement = (fresh.requirements ?? []).find(entry => entry.id === id)
    host.sendJson(res, 200, { ok: true, requirement, progress: requirementProgress(fresh, requirement), state: host.publicState(store) })
    return true
  }

  if (method === 'POST' && route === '/requirement/questions') {
    const body = await host.readJsonBody(req)
    const id = cleanId(body.id, 'req')
    const action = String(body.action ?? 'add')
    const requirement = store.snapshot().requirements.find(item => item.id === id)
    if (requirement === undefined) throw new Error('没有这条需求')
    let questions = Array.isArray(requirement.questions) ? requirement.questions.slice() : []
    const now = Date.now()
    if (action === 'add') {
      const text = String(body.text ?? '').trim().slice(0, 300)
      if (text.length === 0) throw new Error('问题不能为空')
      questions.push({ id: `q-${randomBytes(3).toString('hex')}`, text, status: 'open', owner: String(body.owner ?? '').trim().slice(0, 40), answer: '', at: now, answeredAt: 0 })
    } else if (action === 'answer') {
      const target = questions.find(item => item.id === String(body.questionId ?? ''))
      if (target === undefined) throw new Error('没有这个问题')
      const answer = String(body.answer ?? '').trim().slice(0, 1000)
      if (answer.length === 0) throw new Error('回答不能为空')
      target.answer = answer
      target.status = String(body.status ?? 'answered') === 'open' ? 'open' : 'answered'
      target.answeredAt = target.status === 'answered' ? now : 0
      if (body.by !== undefined) target.answeredBy = String(body.by).slice(0, 40)
    } else if (action === 'delete') {
      questions = questions.filter(item => item.id !== String(body.questionId ?? ''))
    } else {
      throw new Error(`unknown action ${action}`)
    }
    await store.mutate(state => {
      const target = state.requirements.find(item => item.id === id)
      if (target !== undefined) { target.questions = questions; target.updatedAt = now }
    })
    const next = store.snapshot().requirements.find(item => item.id === id)
    host.sendJson(res, 200, { ok: true, requirement: next, gate: requirementGate(store.snapshot(), next), state: host.publicState(store) })
    return true
  }

  if (method === 'POST' && route === '/requirement/delete') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    await store.mutate(state => {
      state.requirements = state.requirements.filter(item => item.id !== id)
      // 卡不删，只是脱离需求；人可以看到它们变成「未归属」。
      for (const task of state.tasks) {
        if (task.requirementId === id) {
          task.requirementId = ''
          task.code = ''
          task.updatedAt = Date.now()
        }
      }
    })
    host.sendJson(res, 200, { ok: true, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/requirement/doc') {
    const body = await host.readJsonBody(req)
    const result = await mutateReqDoc(store, body)
    host.sendJson(res, 200, { ok: true, requirement: result, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/requirement/pull') {
    const body = await host.readJsonBody(req)
    const result = await pullFeishuDoc(body.url ?? body.docUrl ?? '')
    host.sendJson(res, 200, { ok: true, ...result })
    return true
  }
  if (method === 'POST' && route === '/requirement/folder') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    const folder = await ensureReqFolder(store, id)
    const requirement = store.snapshot().requirements.find(item => item.id === id)
    host.sendJson(res, 200, { ok: String(folder.token ?? '').length > 0, folder, requirement, error: folder.error ?? '', state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/requirement/sync') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')
    const report = await syncRequirementArtifacts(store, id)
    host.sendJson(res, 200, { ok: report.failed === 0, report, state: host.publicState(store) })
    return true
  }
  return false
}
