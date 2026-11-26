import { INTAKE_HTML, MINE_HTML, STATUS_HTML } from '../intake-pages.js'
import { checklistFromAcceptance } from '../acceptance.js'
import { resolveRequirement, requirementRefHint, reviewRequirement } from '../reviews.js'
import { splitRequirement } from '../split.js'
import { childSignoffBlockers } from '../executor.js'
import { appendRequirementComment, removeRequirementComment, updateRequirementComment } from '../requirement-comments.js'
import { resolveSigner } from '../access.js'
import { rejectUnknownFields } from '../route-contract.js'
import { signoffActorKind } from '../intervention.js'
import { publishNoteMentions } from '../mention-note.js'
import { parseMentions } from '../dispatcher.js'
import {
  REQ_STATUS_LABEL,
  cleanId,
  sanitizeRequirementPool,
  text,
} from '../domain.js'
import { backendCoverageWarning, discoveryGaps, frontendOnlyWarning, vaguePointsWarning } from '../discovery.js'
import { caseNeedsRerun, casesOfTasks, impactSummary, requirementDocUpdatedAt } from '../impact.js'
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
import { assistMessages, buildRequirementContext, feishuLinks, isSheetLink, requirementAssistPrompt, streamAssistReply } from '../requirement-assist.js'
const INJECTED = ["commentTask","createTask","deleteRequirementFolder","getDefaultModel","getDispatcher","getLlm","publicState","readJsonBody","sendJson"]
let host = {
  createTask: () => {},
  deleteRequirementFolder: async () => ({}),
  getDefaultModel: () => undefined,
  getLlm: () => undefined,
  publicState: () => {},
  readJsonBody: () => {},
  sendJson: () => {},
}
/** 需求（含交付物、文档、飞书同步）相关路由。宿主能力由 configureRequirementRoutes() 注入。 */
/** /intake/query 的失败计数（IP → 最近失败时间戳）。进程内即可，重启丢失无所谓。 */
const INTAKE_QUERY_FAILS = new Map()
/** /intake/mine/query 的请求计数：按完整联系方式查单本来就不该被穷举。 */
const INTAKE_MINE_HITS = new Map()

export function configureRequirementRoutes(services) {
  host = { ...host, ...(services ?? {}) }
}
/** 需求引用 → 内部 id：编号（REQ-2026-001）和 id 都认；找不到时给出可用的引用。 */
const reqRef = (store, ref) => {
  const snapshot = store.snapshot()
  const found = resolveRequirement(snapshot, ref)
  if (found === undefined) throw new Error(requirementRefHint(snapshot, ref))
  return found.id
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
    const rollup = requirementRollup(store.snapshot(), reqRef(store, body.id))
    if (rollup === undefined) throw new Error('需求不存在')
    const matrix = requirementMatrix(store.snapshot(), rollup.requirement)
    const progress = requirementProgress(store.snapshot(), rollup.requirement)
    host.sendJson(res, 200, { ok: true, ...rollup, matrix, progress })
    return true
  }
  if (method === 'POST' && route === '/requirement/matrix') {
    /* 纯读：不写审计、不推 revision（否则 /state 的 ETag 被自己的读操作打穿 —— issue #17）。 */
    req.__studioReadOnly = true

    const body = await host.readJsonBody(req)
    const requirement = store.snapshot().requirements.find(item => item.id === reqRef(store, body.id))
    if (requirement === undefined) throw new Error('需求不存在')
    host.sendJson(res, 200, { ok: true, requirement: { id: requirement.id, code: requirement.code, title: requirement.title }, matrix: requirementMatrix(store.snapshot(), requirement) })
    return true
  }
  if (method === 'POST' && route === '/requirement/signoff') {
    const body = await host.readJsonBody(req)
    rejectUnknownFields('/requirement/signoff', body)
    const id = reqRef(store, body.id)
    const action = body.action === 'clear' ? 'clear' : 'sign'
    const note = String(body.note ?? '').trim().slice(0, 600)
    /* 签字人必须是服务端认定的身份：会话 > 反代注入头 > 请求体（免登录单机模式才轮到自报）。 */
    const { by, source } = resolveSigner({
      session: req.studioActor ?? '',
      header: req.headers['x-studio-user'] ?? '',
      body: body.by ?? '',
    })
    /* override 必须声明在函数作用域：下面 store.mutate 里要用它写 override 记录。
       以前它声明在 if (action === 'sign') 块里，mutate 里引用 → 每次签字都 ReferenceError（400），
       也就是说需求签字从 0.4.0 起就没成功过，而当时没有任何测试覆盖这条路径。 */
    const override = String(body.override ?? '').trim()
    if (action === 'sign' && note === '') throw new Error('需求验收签字要写一句结论：交付了什么、遗留什么')
    // 准出门禁必须在签字前生效：否则「需求自己说没准备好，人却点了签字」会直接变成已交付。
    if (action === 'sign') {
      // 用「假设这次签字已经生效」的副本算门禁：否则「还没有签字」会把自己挡住，永远签不上。
      const current = store.snapshot().requirements.find(item => item.id === id) ?? {}
      const gate = requirementGate(store.snapshot(), { ...current, signoff: { by, at: Date.now(), note } })
      if (gate.ready !== true && override === '') {
        throw new Error('这条需求还过不了准出：' + gate.blockers.join('；') + '（确实要提前签，传 override 写一句原因）')
      }
    }
    const snapshot = await store.mutate(state => {
      const target = state.requirements.find(item => item.id === id)
      if (target === undefined) throw new Error('需求不存在')
      if (action === 'sign') {
        target.signoff = { by, at: Date.now(), note, actorKind: signoffActorKind(by, store.snapshot().config), source }
        // 带着 override 强签的，把「谁、为什么」留下来：以前只在这一次请求里生效，事后查不到。
        if (override !== '') target.override = { by, at: Date.now(), reason: override.slice(0, 300) }
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
    /* 纯读：不写审计、不推 revision（否则 /state 的 ETag 被自己的读操作打穿 —— issue #17）。 */
    req.__studioReadOnly = true

    const body = await host.readJsonBody(req)
    const task = store.snapshot().tasks.find(entry => entry.id === String(body.id ?? ''))
    if (task === undefined) throw new Error('任务不存在')
    host.sendJson(res, 200, { ok: true, gate: taskExitGate(store.snapshot(), task), signoff: task.signoff ?? null })
    return true
  }
  if (method === 'POST' && route === '/task/signoff') {
    const body = await host.readJsonBody(req)
    const id = String(body.id ?? '')   // 卡 id，不是需求引用（批量归一化时误伤过）
    const action = String(body.action ?? 'sign')
    const by = text(body.by, 40) ?? '人'
    const note = text(body.note, 600) ?? ''
    const task = await store.mutate(state => {
      const entry = state.tasks.find(item => item.id === id)
      if (entry === undefined) throw new Error('任务不存在')
      /* 子卡（缺陷卡/拆出来的卡）没全部完成并签过字的，主卡不许签收：
         「bug 还开着就让人签主卡」等于在没修完的时候验收（2026-11-23 真机踩到）。 */
      if (action !== 'clear') {
        const childBlockers = childSignoffBlockers(state, entry)
        if (childBlockers.length > 0) throw new Error('先收口子卡再签主卡：' + childBlockers.join('；'))
      }
      if (action === 'clear') {
        entry.signoff = null
        entry.history.push({ at: Date.now(), by, status: entry.status, note: 'signoff-cleared' })
      } else {
        if (note.length === 0) throw new Error('验收签字要写一句结论：验了什么、遗留什么')
        /* 已经有一条签字（多半是 AI 代签）：人工直接覆盖，不用先「取消签字」——
           前一条写进历史，两条都能追溯（真机 2026-11-26：人签前必须先取消 AI 那条，多一次点击）。 */
        if (entry.signoff !== null && entry.signoff !== undefined) {
          entry.history.push({
            at: Date.now(), by, status: entry.status,
            note: `signoff-override：覆盖前一次签字（${entry.signoff.by} / ${entry.signoff.actorKind ?? '未知'}）：${String(entry.signoff.note ?? '').slice(0, 40)}`,
          })
        }
        entry.signoff = { by, at: Date.now(), note, actorKind: signoffActorKind(by, store.snapshot().config) }
        entry.history.push({ at: Date.now(), by, status: entry.status, note: `signoff：${note.slice(0, 80)}` })
      }
      entry.updatedAt = Date.now()
    })
    void task
    const signed = store.snapshot().tasks.find(item => item.id === id)
    /* 签字备注里 @某人（例如「遗留问题 @开发工程师」）也要能叫起人。
       签字结论本来就会显示在卡上，所以只在真的 @ 了某人的时候才补评论。 */
    const noteOut = action === 'sign'
      ? await publishNoteMentions(
        { store, commentTask: host.commentTask, dispatcher: typeof host.getDispatcher === 'function' ? host.getDispatcher() : undefined, parseMentions },
        { taskId: id, note, by, commentMode: 'mentions', label: '验收签字' },
      )
      : { mentions: [], dispatched: [], commented: false }
    host.sendJson(res, 200, { ok: true, task: signed, gate: taskExitGate(store.snapshot(), signed), ...noteOut, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/requirement/save') {
    const body = await host.readJsonBody(req)
    const incoming = { ...(body.requirement ?? body) }
    /* 顶层 prd / proto / acceptance 映射成 links：以前这两个字段被静默忽略，
       调用方以为存进去了（issue #9 第 1 条）。工具里早有这段映射，路由缺。 */
    if (incoming.prd !== undefined || incoming.proto !== undefined || incoming.acceptance !== undefined) {
      incoming.links = { ...(incoming.links ?? {}), prd: incoming.prd ?? incoming.links?.prd ?? '', proto: incoming.proto ?? incoming.links?.proto ?? '', acceptance: incoming.acceptance ?? incoming.links?.acceptance ?? '' }
    }
    if (incoming.id !== undefined && String(incoming.id).trim() !== '') incoming.id = reqRef(store, incoming.id)
    const beforeRecord = typeof incoming.id === 'string' ? store.snapshot().requirements.find(item => item.id === incoming.id) : undefined
    /* 字段级历史统一由 saveRequirement 写（issue #116：原来这里只盯 7 个标量字段）。 */
    const requirement = await saveRequirement(store, incoming)
    /* 「先聊清楚」生成的新需求：把正文顺手落成一份 PRD 草稿文档，用户不用再手工建。 */
    if (body.intake === true && beforeRecord === undefined && String(requirement.description ?? '').trim() !== '') {
      await mutateReqDoc(store, {
        id: requirement.id, action: 'add', by: '需求澄清',
        doc: { kind: 'prd', title: `${requirement.title} PRD`, version: 'v1.0', content: requirement.description },
      })
    }
    const snapshot = store.snapshot()
    const saved = snapshot.requirements.find(item => item.id === requirement.id) ?? requirement
    host.sendJson(res, 200, { ok: true, created: beforeRecord === undefined, requirement, progress: requirementProgress(snapshot, saved), state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/requirement/assist') {
    /* 需求对话澄清：模型 + 项目沉淀。只读 state，不写库；provider/model 由宿主默认或请求指定。 */
    const body = await host.readJsonBody(req)
    const llm = host.getLlm()
    if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
      host.sendJson(res, 503, { ok: false, error: '宿主没有可用的 llm 服务，先用「直接填写」或问答向导' })
      return true
    }
    const messages = assistMessages(body.messages)
    if (messages.length === 0) {
      host.sendJson(res, 400, { ok: false, error: '先说一句你大概想做什么' })
      return true
    }
    const snapshot = store.snapshot()
    const context = buildRequirementContext(snapshot, body.project)
    const mode = String(body.mode ?? 'chat') === 'draft' ? 'draft' : 'chat'
    /* 用户贴的飞书文档：平台先拉正文再交给模型（读不到就写清楚，别让它假装读过）。
       链接从**原始正文**里找（messages 已被截到 2000 字，长粘贴末尾的链接会被切掉）；
       只看最后一轮用户消息，最多 2 条；表格链接 lark-cli 拉不了，如实标注。 */
    const rawMessages = Array.isArray(body.messages) ? body.messages : []
    const lastRawUser = [...rawMessages].reverse().find(item => String(item?.role ?? 'user') !== 'assistant')
    const attachments = []
    for (const url of (lastRawUser === undefined ? [] : feishuLinks(lastRawUser.content)).slice(0, 2)) {
      if (isSheetLink(url)) {
        attachments.push(`- ${url}：飞书表格暂不支持自动读取正文，请把关键字段 / 行贴进对话`)
        continue
      }
      const pulled = await pullFeishuDoc(url)
      attachments.push(pulled.ok === true
        ? `- ${url}${String(pulled.title ?? '') === '' ? '' : `（${pulled.title}）`}：\n${String(pulled.text ?? '').slice(0, 3000)}`
        : `- ${url}：读取失败（${String(pulled.error ?? '未知原因').slice(0, 160)}）；不要假装读过，需要时请用户贴关键内容`)
    }
    const prompt = requirementAssistPrompt({ mode, messages, context, title: body.title, attachments })
    const selection = host.getDefaultModel() ?? {}
    const provider = String(body.provider ?? selection.provider ?? 'deepseek-official')
    const model = String(body.model ?? selection.model ?? 'deepseek-v4.1-flash')
    // 与 studio_requirement_assist 工具共用同一份调用与拼装（issue #148 第 5 条）。
    const out = await streamAssistReply({ llm, prompt, mode, provider, model })
    if (out.ok !== true) {
      host.sendJson(res, 502, { ok: false, error: out.failure, provider, model })
      return true
    }
    host.sendJson(res, 200, { ok: true, reply: out.reply, provider, model, mode })
    return true
  }
  if (method === 'POST' && route === '/requirement/review') {
    const body = await host.readJsonBody(req)
    rejectUnknownFields('/requirement/review', body)
    // 逻辑与 studio_requirement_review 工具共用一份（src/host/reviews.js），编号/内部 id 都认
    const requirement = await reviewRequirement(store, {
      id: body.id,
      decision: String(body.decision ?? 'approve'),
      by: String(body.by ?? '').trim() || '人',
      note: String(body.note ?? ''),
    })
    const snapshot = store.snapshot()
    host.sendJson(res, 200, { ok: true, requirement, review: requirement.review ?? null, progress: requirementProgress(snapshot, requirement), state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/requirement/split') {
    const body = await host.readJsonBody(req)
    rejectUnknownFields('/requirement/split', body)
    // 逻辑与 studio_requirement_split 共用（src/host/split.js），免得工具与路由行为漂移
    const { created, warnings } = await splitRequirement(store, body, host.createTask)
    host.sendJson(res, 200, { ok: true, created, warnings, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/requirement/pool') {
    const body = await host.readJsonBody(req)
    rejectUnknownFields('/requirement/pool', body)
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
    /* 限流键：有联系方式就按联系方式，没有就按来源 IP —— 以前只在"填了联系方式"时
       才限流，省略 contact 就能无限灌需求（会把 /state 和看板一起撑爆）。 */
    const contactKey = String(body.contact ?? '').trim()
    const limitKey = contactKey.length > 0 ? 'contact:' + contactKey : 'ip:' + String(req.socket?.remoteAddress ?? 'unknown')
    {
      const since = Date.now() - 10 * 60 * 1000
      const recent = (store.snapshot().requirements ?? []).filter(item => item.source === 'business'
        && (String(item.requester?.limitKey ?? '') === limitKey
          || (contactKey.length > 0 && String(item.requester?.contact ?? '').trim() === contactKey))
        && Number(item.requester?.at ?? 0) > since)
      if (recent.length >= 3) throw new Error('同一联系方式/IP 10 分钟内最多提交 3 条，请稍后再试')
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
      requester: { name: requester, dept: String(body.dept ?? '').slice(0, 40), contact: String(body.contact ?? '').slice(0, 80), limitKey, at: Date.now() },
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
    /* 这个接口按完整联系方式返回整批需求；不限流就能拿手机号段穷举别人的单。 */
    const source = String(req.socket?.remoteAddress ?? 'unknown')
    const now = Date.now()
    const hits = (INTAKE_MINE_HITS.get(source) ?? []).filter(at => now - at < 10 * 60 * 1000)
    if (hits.length >= 30) {
      host.sendJson(res, 429, { ok: false, error: '查询太频繁，请 10 分钟后再试' })
      return true
    }
    INTAKE_MINE_HITS.set(source, [...hits, now].slice(-60))
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
    /* 编号顺序递增、联系方式只比后四位 —— 不限流就能穷举出别人的需求。按来源 IP 记失败次数。 */
    const source = String(req.socket?.remoteAddress ?? 'unknown')
    const now = Date.now()
    const recent = (INTAKE_QUERY_FAILS.get(source) ?? []).filter(at => now - at < 10 * 60 * 1000)
    if (recent.length >= 20) {
      host.sendJson(res, 429, { ok: false, error: '查询太频繁，请 10 分钟后再试' })
      return true
    }
    INTAKE_QUERY_FAILS.set(source, recent)
    const body = await host.readJsonBody(req)
    const code = String(body.code ?? '').trim().toUpperCase()
    const tail = String(body.contact ?? '').trim().replace(/\s+/g, '')
    if (code.length === 0 || tail.length < 4) throw new Error('请填写需求编号，以及联系方式的后四位')
    const hit = (store.snapshot().requirements ?? []).find(item => String(item.code ?? '').toUpperCase() === code)
    const contact = String(hit?.requester?.contact ?? '').replace(/\s+/g, '')
    if (hit === undefined || contact.length === 0 || !contact.endsWith(tail)) {
      INTAKE_QUERY_FAILS.set(source, [...(INTAKE_QUERY_FAILS.get(source) ?? []), now].slice(-40))
      throw new Error('没查到：编号或联系方式对不上')
    }
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
    const id = reqRef(store, body.id).trim()
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

  if (method === 'POST' && route === '/requirement/comment') {
    /* 需求级评论（issue #115）：卡片有 comments，需求以前没有——讨论只能覆盖正文或散到卡上。 */
    const body = await host.readJsonBody(req)
    const requirementId = reqRef(store, body.id)
    const action = String(body.action ?? 'add')
    const by = String(body.by ?? '人').slice(0, 60)
    let list = []
    await store.mutate(state => {
      const requirement = state.requirements.find(item => item.id === requirementId)
      if (requirement === undefined) throw new Error(`no requirement ${requirementId}`)
      if (action === 'update') requirement.comments = updateRequirementComment(requirement.comments, { commentId: body.commentId, body: body.body, by })
      else if (action === 'remove') {
        requirement.comments = removeRequirementComment(requirement.comments, body.commentId)
        requirement.history = [...(requirement.history ?? []), { at: Date.now(), by, field: '评论', from: String(body.commentId ?? ''), to: '已删除' }]
      } else requirement.comments = appendRequirementComment(requirement.comments, { body: body.body, by })
      requirement.updatedAt = Date.now()
      list = requirement.comments
    })
    host.sendJson(res, 200, { ok: true, comments: list, state: host.publicState(store) })
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
    const id = reqRef(store, body.id)
    /* deleteFolder=true 时连带删掉云盘目录。默认不动：删台账和删文件是两件事，不能顺手把别人的文档删了。 */
    if (body.deleteFolder === true) await host.deleteRequirementFolder(store, id).catch(() => {})
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
  if (method === 'POST' && route === '/requirement/impact') {
    /* 纯读：不写审计、不推 revision（否则 /state 的 ETag 被自己的读操作打穿 —— issue #17）。 */
    req.__studioReadOnly = true

  // 需求一改，这条需求下面的卡和用例就要重看。这里只算、不改数据。
  const body = await host.readJsonBody(req)
  const id = reqRef(store, body.id)
  const snapshot = store.snapshot()
  const requirement = (snapshot.requirements ?? []).find(item => item.id === id)
  if (requirement === undefined) throw new Error(`no requirement ${id}`)
  const tasks = (snapshot.tasks ?? []).filter(task => task.requirementId === id)
  const summary = impactSummary(tasks)
  const cases = casesOfTasks(tasks, 60)
  /* 文档改版后「通过过但没复跑」的用例：只标出来，不改结果。 */
  const docUpdatedAt = requirementDocUpdatedAt(requirement)
  const markedCases = cases.map(item => ({ ...item, stale: caseNeedsRerun(item, docUpdatedAt) }))
  summary.staleCases = markedCases.filter(item => item.stale === true).length
  summary.docUpdatedAt = docUpdatedAt
  host.sendJson(res, 200, {
    ok: true,
    summary,
    cases: markedCases,
    cards: tasks.map(task => ({ id: task.id, code: task.code ?? '', title: task.title ?? '', status: task.status ?? '' })),
  })
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
    const id = reqRef(store, body.id)
    const folder = await ensureReqFolder(store, id)
    const requirement = store.snapshot().requirements.find(item => item.id === id)
    host.sendJson(res, 200, { ok: String(folder.token ?? '').length > 0, folder, requirement, error: folder.error ?? '', state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/requirement/sync') {
    const body = await host.readJsonBody(req)
    const id = reqRef(store, body.id)
    const report = await syncRequirementArtifacts(store, id)
    host.sendJson(res, 200, { ok: report.failed === 0, report, state: host.publicState(store) })
    return true
  }
  return false
}
