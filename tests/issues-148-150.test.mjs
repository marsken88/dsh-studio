// issue #148 / #149 / #150 的回归：
//   #150 角色位白名单可配置（默认四岗 + 运营），非法 role 不再被静默清空；
//   #149 /columns/save 接受 kind:'role'、非法值报错、返回实落库的列，并给出「下一轮 tick 会派走哪些卡」；
//   #148 无卡会话 /agents/chat（专家或专家团，说一句就开聊）+ 派单错误分流 + studio_session_start 工具。
//
// 这里跑的是真实模块（domain / roles / column-preview / dispatcher / 两个路由），
// 宿主能力全部用桩注入，不碰真实看板与磁盘数据。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { mergeConfig, normalizePatch, defaultColumns, sanitizeColumns, sanitizeExperts } from '../src/host/domain.js'
import { ROLE_IDS, ROLE_LABELS, rolesInColumns, sanitizeRoles } from '../src/host/roles.js'
import { buildRoster } from '../web/src/studio/roster.js'
import { configureToolHost, registerTools } from '../src/host/tools.js'
import { toolAccessTable } from '../src/host/tool-access.js'
import { describeOwner, dispatchPreview, previewWarning } from '../src/host/column-preview.js'
import { Dispatcher, buildChatPrompt, resolveChatSpeaker, resolveDispatchTarget, resolveOwner } from '../src/host/dispatcher.js'
import { parseStudioSession } from '../src/host/agent-feed.js'
import { parseSessionName } from '../src/host/session-usage.js'
import { configureTaskRoutes, handleTaskRoute } from '../src/host/routes/tasks.js'
import { configureAgentsRoutes, handleAgentsRoute } from '../src/host/routes/agents.js'
import { SecretStore, StudioStore } from '../src/host/store.js'

// ------------------------------------------------------------------ #150 角色位

test('#150 角色白名单：默认四岗 + 运营，自定义岗位能加、非法值丢弃、去重', () => {
  assert.deepEqual(ROLE_IDS, ['product', 'architect', 'dev', 'qa', 'ops'], '运营（ops）要是默认角色位')
  assert.equal(ROLE_LABELS.ops, '运营')
  assert.deepEqual(sanitizeRoles(undefined), ROLE_IDS, '没配就用默认')
  assert.deepEqual(sanitizeRoles([]), ROLE_IDS, '空数组也退回默认（否则所有角色位都会失效）')
  assert.deepEqual(sanitizeRoles(['product', 'finance', 'finance', '9bad', 'ops']), ['product', 'finance', 'ops'], '去重 + 形状校验（9bad 不是合法 id）')
})

test('#150 专家的 role 认 config.roles：运营不再被清空，自定义岗位也留得住', () => {
  const ops = sanitizeExperts([{ id: 'opssettle', name: '运营·结算', role: 'ops', domain: '促销返利结算' }])
  assert.equal(ops[0].role, 'ops', 'ops 以前不在白名单，会被静默清空成 ""')

  const custom = sanitizeExperts([{ id: 'fin', name: '财务', role: 'finance' }], ['product', 'finance'])
  assert.equal(custom[0].role, 'finance')

  // 不在给定白名单里的 role 仍然是空（但路由层会先报错，不会静默）
  const dropped = sanitizeExperts([{ id: 'x', name: 'x', role: 'finance' }], ['product'])
  assert.equal(dropped[0].role, '')
})

test('#150 mergeConfig 把 roles 当成白名单：自定义岗位在重启加载后仍然是 role，列负责人也留得住', () => {
  const merged = mergeConfig({
    roles: ['product', 'dev', 'finance'],
    experts: [{ id: 'fin', name: '财务', role: 'finance' }],
    columns: { design: { kind: 'role', id: 'finance' } },
  })
  assert.deepEqual(merged.roles, ['product', 'dev', 'finance'])
  assert.equal(merged.experts.find(item => item.id === 'fin').role, 'finance')
  assert.deepEqual(merged.columns.design, { kind: 'role', id: 'finance' })

  // 旧库（schema 7 以前的角色模板对象）不会漏进新白名单
  const legacy = mergeConfig({ roles: { product: { label: '产品', model: 'm' } } })
  assert.deepEqual(legacy.roles, ROLE_IDS, '对象形状不是白名单，退回默认')

  // 列里用到的角色能算出来（删角色前的「还在用」检查靠它）
  assert.deepEqual(rolesInColumns({ design: { kind: 'role', id: 'finance' }, test: { kind: 'pool', members: [{ kind: 'role', id: 'qa' }] } }).sort(), ['finance', 'qa'])
})

test('#150 卡片 role 校验跟配置走：不认识的岗位直接报错并列出可选值', () => {
  assert.equal(normalizePatch({ role: 'ops' }).role, 'ops', '默认白名单包含运营')
  assert.equal(normalizePatch({ role: 'finance' }, ['finance', 'dev']).role, 'finance')
  assert.throws(() => normalizePatch({ role: 'nope' }), /unknown role nope（可选：product \/ architect \/ dev \/ qa \/ ops）/)
})

test('#150 列负责人按角色位解析时也认自定义岗位', () => {
  const config = { roles: ['product', 'finance'], experts: [{ id: 'fin', name: '财务', role: 'finance', enabled: true }], teams: [] }
  const resolved = resolveOwner(config, { kind: 'role', id: 'finance' })
  assert.equal(resolved?.expert.id, 'fin')
  assert.equal(resolveOwner(config, { kind: 'role', id: 'qa' }), undefined, '不在白名单的角色位解析不出人')
})

test('#150 index.js：/state 的 roles 读 state.config（裸 config 是 ReferenceError，node --check 查不出）', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const start = source.indexOf('function publicState(')
  assert.ok(start > 0, 'index.js 里要有 publicState')
  const block = source.slice(start, start + 4000)
  assert.match(block, /roles: state\.config\.roles/, '白名单要从快照里读')
  assert.doesNotMatch(block, /\broles: config\.roles/, 'publicState 里没有 config 这个变量')
})

test('#150 index.js：applyConfig 支持 roles 补丁，且删还在用的角色会报错而不是静默清空', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /if \(patch\.roles !== undefined\)/)
  assert.match(source, /还在用（专家或列负责人）/, '删在用角色要拦下来')
})

test('#150 默认列负责人按角色位算：删掉的角色位退回「没人负责」，不指向解析不出的 id', () => {
  const base = defaultColumns()
  assert.deepEqual(base.design, { kind: 'role', id: 'architect' }, '默认挂角色位（按卡的业务领域挑人）')
  assert.deepEqual(base.test, { kind: 'role', id: 'qa' })
  assert.deepEqual(base.clarify, { kind: 'none', id: '' }, '澄清列仍然不默认负责人')
  const narrowed = defaultColumns(['product', 'dev'])
  assert.deepEqual(narrowed.design, { kind: 'none', id: '' }, '白名单里没有 architect 就退回没人负责')
  // 配置里剩下的无效角色位也要退回，而不是留着解析不出人
  const merged = mergeConfig({ roles: ['product', 'dev'], columns: { design: { kind: 'role', id: 'architect' } } })
  assert.deepEqual(merged.columns.design, { kind: 'none', id: '' })
})

test('#150 面板「加候选」的名册按 config.roles 出角色位（运营/自定义岗位选得到）', () => {
  const config = { roles: ['product', 'ops', 'finance'], experts: [], teams: [] }
  const keys = buildRoster(config).filter(item => item.group === '角色位').map(item => item.key)
  assert.deepEqual(keys, ['r:product', 'r:ops', 'r:finance'])
  // 没配 roles 时退回默认（含运营）
  const fallback = buildRoster({ experts: [], teams: [] }).filter(item => item.group === '角色位').map(item => item.key)
  assert.ok(fallback.includes('r:ops'))
})

test('#150 studio_config_get 的 roles 读当前配置；studio_requirement_assist 已注册且只读', async () => {
  await withStore(async store => {
    await store.mutate(state => { state.config.roles = ['product', 'ops', 'finance'] })
    const registered = []
    const ctx = { tools: { register: tool => { registered.push(tool); return () => {} } }, effect: () => () => {} }
    configureToolHost({
      toolOperator: () => '自检',
      toolLevel: () => 'read',
      checkToolAccess: () => ({ level: 'read', denial: null }),
      recordAudit: async () => {},
      publicConfig: config => config,
      getActiveDispatcher: () => undefined,
      getActiveSkills: () => undefined,
      getLlm: () => undefined,
      getDefaultModel: () => undefined,
    })
    registerTools(ctx, store)
    const configGet = registered.find(tool => tool.name === 'studio_config_get')
    const out = await configGet.execute({}, {})
    assert.deepEqual(out.roles, ['product', 'ops', 'finance'], '工具报的白名单要是当前配置，不是写死的默认值')
    assert.deepEqual(out.config.roles, ['product', 'ops', 'finance'])

    const assist = registered.find(tool => tool.name === 'studio_requirement_assist')
    assert.ok(assist !== undefined, '需求对话澄清要有工具入口（issue #148 第 5 条：agent 与人的能力要对等）')
    assert.equal(toolAccessTable().studio_requirement_assist, 'read', '只读：不写库，和面板的 /requirement/assist 一致')
    await assert.rejects(() => assist.execute({ message: '做个结算对账' }, {}), /宿主没有可用的 llm 服务/)
  })
})

// ------------------------------------------------------------------ #149 列负责人

const TASK = (id, status, extra = {}) => ({ id, code: id.toUpperCase(), title: `卡 ${id}`, status, blocked: null, retryAt: 0, ...extra })

test('#149 改列负责人前先算「下一轮会被派走哪些卡」：阻塞 / 在跑 / 已派过 / 退避中都不算', () => {
  const tasks = [
    TASK('t-a', 'test'),
    TASK('t-b', 'test', { blocked: { reason: '等人', at: 1 } }),
    TASK('t-c', 'test'),
    TASK('t-d', 'test', { dispatch: { status: 'test', state: 'running' } }),
    TASK('t-e', 'test', { retryAt: Date.now() + 60_000 }),
    TASK('t-f', 'dev'),
  ]
  const preview = dispatchPreview({
    tasks,
    status: 'test',
    autoStatuses: ['design', 'test'],
    running: ['t-c'],
    before: () => undefined,
    after: task => ({ kind: 'expert', expert: { id: 'qa', name: '测试工程师' } }),
    now: Date.now(),
  })
  assert.equal(preview.auto, true)
  assert.deepEqual(preview.cards.map(card => card.id), ['t-a'], '只有既没阻塞、没在跑、没派过、没退避的卡会被带走')
  assert.equal(preview.count, 1)
  assert.equal(preview.cards[0].wasUnassigned, true, '以前没人负责的卡要标出来（这正是「改配置把卡带走」的那批）')
  assert.match(previewWarning(preview), /会让 1 张卡在下一轮自动派单里被派出去/)
})

test('#149 不是自动列时只提示不派：affected 仍列出候选，但 count=0', () => {
  const preview = dispatchPreview({
    tasks: [TASK('t-a', 'accept')],
    status: 'accept',
    autoStatuses: ['design'],
    before: () => undefined,
    after: () => ({ kind: 'expert', expert: { id: 'product', name: '产品经理' } }),
  })
  assert.equal(preview.auto, false)
  assert.equal(preview.count, 0)
  assert.equal(previewWarning(preview), '')
})

test('#149 describeOwner 把 owner 压成面板能显示的形状', () => {
  assert.deepEqual(describeOwner({ kind: 'team', team: { id: 'team1', name: '结算团' }, expert: { id: 'lead', name: '团长' } }), {
    kind: 'team', id: 'lead', name: '团长', team: 'team1', teamName: '结算团', role: '',
  })
  assert.equal(describeOwner(undefined), undefined)
})

// ------------------------------------------------------------------ 路由桩

const RES = () => ({})

function stubTaskRoutes(store, { dispatcher } = {}) {
  configureTaskRoutes({
    readJsonBody: async req => req.body ?? {},
    sendJson: (res, status, payload) => { res.status = status; res.body = payload },
    publicState: () => ({ revision: 1 }),
    getDispatcher: () => dispatcher,
    // 真实现里 applyConfig 会在 store.mutate 里做同一套 sanitize；这里只落 columns/experts，够验路由的分支。
    applyConfig: async (target, patch) => {
      await target.mutate(state => {
        if (patch.columns !== undefined) state.config.columns = { ...state.config.columns, ...patch.columns }
        if (patch.experts !== undefined) state.config.experts = patch.experts
      })
    },
    upsertById: (list, incoming) => {
      const arrivals = [...(Array.isArray(list) ? list : [])]
      const id = String(incoming?.id ?? '').trim()
      const index = id === '' ? -1 : arrivals.findIndex(entry => entry.id === id)
      if (index >= 0) arrivals[index] = { ...arrivals[index], ...incoming }
      else arrivals.push(incoming)
      return arrivals
    },
  })
}

const callTask = async (store, route, body) => {
  const res = RES()
  const handled = await handleTaskRoute({ method: 'POST', route, req: { body }, res, store, url: new URL(`http://x${route}`) })
  return { handled, res }
}

async function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-issues-148-150-'))
  const store = new StudioStore(join(dir, 'state.json'), { dbFile: join(dir, 'state.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  try {
    await store.ready
    return await run(store)
  } finally {
    store.db?.close?.()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
}

test('#149 /columns/save 传 kind:role 就落成 role，不再静默降级成 expert', async () => {
  await withStore(async store => {
    stubTaskRoutes(store)
    const { handled, res } = await callTask(store, '/columns/save', { status: 'design', kind: 'role', id: 'architect' })
    assert.equal(handled, true)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.column, { kind: 'role', id: 'architect' }, '返回值要是实际落库的那一列')
    assert.deepEqual(store.snapshot().config.columns.design, { kind: 'role', id: 'architect' })
  })
})

test('#149 /columns/save 传不认识的 kind:role / 专家 / 团时直接报错，不静默降级', async () => {
  await withStore(async store => {
    stubTaskRoutes(store)
    await assert.rejects(() => callTask(store, '/columns/save', { status: 'design', kind: 'role', id: 'nobody' }), /角色「nobody」不在 config.roles 里/)
    await assert.rejects(() => callTask(store, '/columns/save', { status: 'design', kind: 'expert', id: 'ghost' }), /专家「ghost」不存在/)
    await assert.rejects(() => callTask(store, '/columns/save', { status: 'design', kind: 'team', id: 'ghost' }), /专家团「ghost」不存在/)
    await assert.rejects(() => callTask(store, '/columns/save', { status: 'design', members: [{ kind: 'expert', id: 'ghost' }] }), /1 项的专家「ghost」不存在/)
    assert.deepEqual(store.snapshot().config.columns.design, { kind: 'role', id: 'architect' }, '报错时不能改坏原配置（默认列按角色位）')
  })
})

test('#149 /columns/save dryRun 只看不写，并把「会被派走的卡」带回来', async () => {
  await withStore(async store => {
    const running = new Map()
    stubTaskRoutes(store, { dispatcher: { running, loadByExpert: () => new Map() } })
    await store.mutate(state => {
      state.config.columns.test = { kind: 'none', id: '' }
      state.config.agents.autoStatuses = ['test']
      state.tasks.push(TASK('t-0000abcd', 'test'))
    })
    const { res } = await callTask(store, '/columns/save', { status: 'test', kind: 'expert', id: 'qa', dryRun: true })
    assert.equal(res.body.dryRun, true)
    assert.deepEqual(res.body.column, { kind: 'expert', id: 'qa' })
    assert.equal(res.body.affected.count, 1, '这张卡以前没人负责，改完会被下一轮 tick 派出去')
    assert.equal(res.body.affected.cards[0].id, 't-0000abcd')
    assert.deepEqual(store.snapshot().config.columns.test, { kind: 'none', id: '' }, 'dryRun 不许落库')
    assert.equal(store.snapshot().tasks.length, 1)
  })
})

test('#149 /columns/save 真落库时也带回 affected：面板据此提示「这次会派走 N 张」', async () => {
  await withStore(async store => {
    stubTaskRoutes(store, { dispatcher: { running: new Map(), loadByExpert: () => new Map() } })
    await store.mutate(state => {
      state.config.columns.test = { kind: 'none', id: '' }
      state.config.agents.autoStatuses = ['test']
      state.tasks.push(TASK('t-0000abce', 'test'), TASK('t-0000abcf', 'dev'))
    })
    const { res } = await callTask(store, '/columns/save', { status: 'test', kind: 'role', id: 'qa' })
    assert.equal(res.status, 200)
    assert.equal(res.body.affected.count, 1)
    assert.match(res.body.warning, /会让 1 张卡/)
    assert.deepEqual(store.snapshot().config.columns.test, { kind: 'role', id: 'qa' }, 'role 位真的落库了')
  })
})

test('#150 /experts/save 传不认识的 role 直接 400 并列出可选值；ops 能存进去', async () => {
  await withStore(async store => {
    stubTaskRoutes(store)
    await assert.rejects(
      () => callTask(store, '/experts/save', { expert: { name: '运营·结算', role: 'nobody' } }),
      /角色「nobody」不在 config.roles 里：可选 product \/ architect \/ dev \/ qa \/ ops/,
    )
    const { res } = await callTask(store, '/experts/save', { expert: { name: '运营·结算', role: 'ops', domain: '促销返利结算' } })
    assert.equal(res.status, 200)
    assert.equal(res.body.expert.role, 'ops', '回读的那条就是落库的那条')
    assert.ok(store.snapshot().config.experts.some(entry => entry.role === 'ops' && entry.name === '运营·结算'))
  })
})

test('#148 /agents/run 把 instruction 传下去（以前没有地方传开场白）', async () => {
  await withStore(async store => {
    const calls = []
    const dispatcher = {
      running: new Map(),
      loadByExpert: () => new Map(),
      status: () => ({ running: [], log: [] }),
      launchNow: async (...args) => { calls.push(args) },
    }
    configureAgentsRoutes({
      readJsonBody: async req => req.body ?? {},
      sendJson: (res, status, payload) => { res.status = status; res.body = payload },
      publicState: () => ({ revision: 1 }),
      getDispatcher: () => dispatcher,
    })
    const call = body => handleAgentsRoute({ method: 'POST', route: '/agents/run', req: { body }, res: RES(), store, url: new URL('http://x/agents/run') })

    await call({ id: 't-1ade5b86', expert: 'dev', instruction: '先看下卡片' })
    assert.deepEqual(calls[0], ['t-1ade5b86', 'dev', '先看下卡片'], 'instruction 要能传下去（以前没有地方传）')
  })
})

test('#148 launchNow 的失败分开报：卡不存在与目标不存在不再共用「这一列没人负责」', async () => {
  await withStore(async store => {
    const dispatcher = new Dispatcher({}, store)
    await assert.rejects(() => dispatcher.launchNow('t-nosuch', 'dev'), /卡 t-nosuch 不存在：看板里没有这张卡/)
    await store.mutate(state => { state.tasks.push(TASK('t-0000abcd', 'dev')) })
    await assert.rejects(() => dispatcher.launchNow('t-0000abcd', 'nosuch'), /没有 id 为「nosuch」的专家或专家团/)
    await assert.rejects(() => dispatcher.launchNow('t-0000abcd', 'team-nope'), /没有 id 为「team-nope」的专家或专家团/)
  })
})

test('#148 resolveDispatchTarget 分得清专家 / 专家团 / 停用 / 团没成员 / 不存在', () => {
  const config = {
    experts: [
      { id: 'dev', name: '开发工程师', enabled: true },
      { id: 'off', name: '停用的专家', enabled: false },
    ],
    teams: [
      { id: 'team1', name: '结算团', lead: 'dev', members: ['dev'], enabled: true },
      { id: 'team0', name: '空团', lead: '', members: [], enabled: true },
    ],
  }
  assert.deepEqual(resolveDispatchTarget(config, 'dev').owner, { kind: 'expert', id: 'dev' })
  assert.deepEqual(resolveDispatchTarget(config, 'team1').owner, { kind: 'team', id: 'team1' })
  assert.match(resolveDispatchTarget(config, 'off').error, /已停用/)
  assert.match(resolveDispatchTarget(config, 'team0').error, /没有成员/)
  assert.match(resolveDispatchTarget(config, 'nosuch').error, /没有 id 为「nosuch」的专家或专家团/)
  assert.match(resolveDispatchTarget(config, 'nosuch').error, /现有专家：dev/, '要给出可用的 id，别只说找不到')
})

test('#148 无卡会话的提示词是「对话模式」：不派工、不改代码、不往看板写评论', () => {
  const prompt = buildChatPrompt({
    expert: { id: 'dev', name: '开发工程师', description: '按方案实现', domain: '结算', skills: ['gitlab-mr-review'] },
    team: { id: 'team1', name: '结算团', members: ['dev', 'qa'] },
    topic: '下个版本先做哪几张卡？',
    instruction: '预算只有两个人周',
    config: { experts: [{ id: 'dev', name: '开发工程师' }, { id: 'qa', name: '测试工程师', description: '验证' }] },
  })
  assert.match(prompt, /现在是在和人对话，不是在接工单/)
  assert.match(prompt, /不要改代码、不要建卡、不要往看板写评论/)
  assert.match(prompt, /话题：下个版本先做哪几张卡？/)
  assert.match(prompt, /补充说明：预算只有两个人周/)
  assert.match(prompt, /你在「结算团」专家团里/, '团要说明由团长接话 + 成员名单')
  assert.doesNotMatch(prompt, /studio_task_update/, '对话模式不该出现派单那套「推进卡片」要求')
})

test('#148 会话名：chat 会话不是派单会话，但用量统计认得出它是哪个专家', () => {
  assert.equal(parseStudioSession('studio-chat-dev-ab12cd34'), null, '没有卡，执行播报不能往一张叫 chat 的卡上灌评论')
  assert.deepEqual(parseStudioSession('studio-t-1ade5b86-dev'), { taskId: 't-1ade5b86', expertId: 'dev' }, '卡派单会话照旧')
  assert.deepEqual(parseSessionName('studio-chat-dev-ab12cd34'), { taskId: '', expert: 'dev', adHoc: true })
  assert.deepEqual(parseSessionName('studio-t-1ade5b86-dev'), { taskId: 't-1ade5b86', expert: 'dev' })
})

test('#148 会话出口：/agents/chat 认 expert 或 team，缺话题时报错，参数原样交给 startChat', async () => {
  await withStore(async store => {
    const calls = []
    const dispatcher = {
      running: new Map(),
      loadByExpert: () => new Map(),
      startChat: async args => {
        calls.push(args)
        return { ok: true, sessionId: 'studio-chat-dev-ab12cd34', expert: { id: 'dev', name: '开发工程师' }, team: null, workdir: '/tmp', topic: args.topic, hint: '去侧栏接着聊' }
      },
    }
    configureAgentsRoutes({
      readJsonBody: async req => req.body ?? {},
      sendJson: (res, status, payload) => { res.status = status; res.body = payload },
      publicState: () => ({ revision: 1 }),
      getDispatcher: () => dispatcher,
    })
    const call = async body => {
      const res = RES()
      const handled = await handleAgentsRoute({ method: 'POST', route: '/agents/chat', req: { body }, res, store, url: new URL('http://x/agents/chat') })
      return { handled, res }
    }

    const { res } = await call({ team: 'team1', topic: '先聊下个版本', workdir: '/tmp/x' })
    assert.equal(res.status, 200)
    assert.equal(res.body.sessionId, 'studio-chat-dev-ab12cd34')
    assert.deepEqual(calls[0], { expert: 'team1', member: '', topic: '先聊下个版本', instruction: '', workdir: '/tmp/x' }, 'team 也能开局（默认团长），workdir 要传下去')
    await call({ expert: 'team1', member: 'qa', topic: '找测试聊' })
    assert.equal(calls[1].member, 'qa', '专家团可以指定成员接话')
  })
})

test('#148 resolveChatSpeaker：专家就是本人，团默认团长，指定成员要在团里', () => {
  const config = {
    experts: [{ id: 'lead', name: '团长' }, { id: 'qa', name: '测试' }],
    teams: [{ id: 'team1', name: '结算团', lead: 'lead', members: ['lead', 'qa'] }],
  }
  const expertTarget = resolveDispatchTarget(config, 'qa')
  assert.equal(resolveChatSpeaker(config, expertTarget, '').expert.id, 'qa')
  assert.match(resolveChatSpeaker(config, expertTarget, 'lead').error, /是专家不是专家团/, 'member 只对专家团有意义')

  const teamTarget = resolveDispatchTarget(config, 'team1')
  assert.equal(resolveChatSpeaker(config, teamTarget, '').expert.id, 'lead', '默认团长')
  assert.equal(resolveChatSpeaker(config, teamTarget, 'qa').expert.id, 'qa', '指定成员')
  const bad = resolveChatSpeaker(config, teamTarget, 'ghost')
  assert.match(bad.error, /不在专家团「结算团」的成员里/)
  assert.match(bad.error, /团长 \/ 测试/, '要列出成员，别只说找不到')
})

test('#148 无卡会话进运行态、能被 /agents/stop 按 sessionId 停掉', async () => {
  await withStore(async store => {
    const aborted = []
    const dispatcher = new Dispatcher({ agents: { get: id => ({ abort: () => { aborted.push(id) } }) } }, store)
    dispatcher.chats.set('studio-chat-dev-ab12cd34', { sessionId: 'studio-chat-dev-ab12cd34', expert: 'dev', expertName: '开发工程师', team: '', topic: '聊两句', workdir: '/tmp', at: Date.now() })
    assert.equal(dispatcher.status().chats.length, 1, '/agents 要能看见无卡会话')
    assert.equal(dispatcher.status().running.length, 0, '但不能占卡的派单槽位')

    configureAgentsRoutes({
      readJsonBody: async req => req.body ?? {},
      sendJson: (res, status, payload) => { res.status = status; res.body = payload },
      publicState: () => ({ revision: 1 }),
      getDispatcher: () => dispatcher,
    })
    const res = RES()
    await handleAgentsRoute({ method: 'POST', route: '/agents/stop', req: { body: { sessionId: 'studio-chat-dev-ab12cd34' } }, res, store, url: new URL('http://x/agents/stop') })
    assert.equal(res.status, 200)
    assert.equal(res.body.stopped, true)
    assert.deepEqual(aborted, ['studio-chat-dev-ab12cd34'], '要真的 abort 那个会话')
    assert.equal(dispatcher.status().chats.length, 0, '停掉后运行态里不再有它')
    assert.equal(dispatcher.abortSession('studio-chat-nope-000000'), false, '不存在的会话返回 false，不抛')
  })
})
