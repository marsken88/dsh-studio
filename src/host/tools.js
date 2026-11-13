import { randomBytes } from 'node:crypto'
import {
  CASE_RESULTS, CODING_REVIEW_STATUS, RELEASE_STATUS_LABEL, REQ_STATUS_LABEL, ROLE_IDS, STATUSES, STATUS_IDS,
  TASK_TYPES, cleanId, codingSummary, defineStudioTool, mergeCoding, sanitizeArtifact, sanitizeCaseHttp,
  sanitizeCases, sanitizeCoding, sanitizeRelease, text,
} from './domain.js'
import {
  buildDashboard, commentTask, ensureReqFolder, requirementMatrix, requirementProgress, requirementRollup,
  runSuite, runTaskCases, saveRequirement, syncArtifact, syncRequirementArtifacts, taskExitGate, updateTask,
} from './executor.js'
import { runSummary } from './dispatcher.js'
const INJECTED = ["activeDispatcher","activeSkills","addDraftCases","applyConfig","auditSummary","buildAnalytics","buildMetrics","burndownReport","checkToolAccess","createTask","releaseGate","releaseNotes","skillsRoot","taskLine","toolLevel","toolOperator","upsertById","workloadReport"]
let host = {
  activeDispatcher: () => {},
  activeSkills: () => {},
  addDraftCases: () => {},
  applyConfig: () => {},
  auditSummary: () => {},
  buildAnalytics: () => {},
  buildMetrics: () => {},
  burndownReport: () => {},
  checkToolAccess: () => {},
  createTask: () => {},
  releaseGate: () => {},
  releaseNotes: () => {},
  skillsRoot: () => {},
  taskLine: () => {},
  toolLevel: () => {},
  toolOperator: () => {},
  upsertById: () => {},
  workloadReport: () => {},
  getActiveDispatcher: () => undefined,
  getActiveSkills: () => undefined,
}
/** Agent-facing tools. 宿主能力由 configureToolHost() 注入（避免反向 import index.js 成环）。 */
export function configureToolHost(services) {
  host = { ...host, ...(services ?? {}) }
}

/** 注册 39 个 studio_* 工具。 */
export function registerTools(ctx, store) {
  const disposers = []
  const register = tool => {
    const body = tool.execute
    disposers.push(ctx.tools.register({
      ...tool,
      // 专家 agent 调工具也要过成员名单：读操作放行，写要成员、危险的只有管理员。
      async execute(args, exec) {
        await store.ready
        const config = store.snapshot().config
        const operator = host.toolOperator(store, exec)
        const { level, denial } = operator === null
          ? { level: host.toolLevel(tool.name), denial: null }
          : host.checkToolAccess(config, operator.name, tool.name)
        if (denial !== null) {
          await recordAudit(store, {
            by: `${operator.name}(AI)`, route: `tool:${tool.name}`, level,
            status: 403, ok: false, summary: denial,
          })
          throw new Error(`权限不足：${denial}`)
        }
        try {
          const value = await body(args, exec)
          // 只给写操作留痕，读太多会把审计刷成流水账。
          if (operator !== null && level !== 'read') {
            await recordAudit(store, {
              by: `${operator.name}(AI)`, route: `tool:${tool.name}`, level,
              status: 200, ok: true, summary: host.auditSummary(args),
            })
          }
          return value
        } catch (error) {
          if (operator !== null && level !== 'read') {
            await recordAudit(store, {
              by: `${operator.name}(AI)`, route: `tool:${tool.name}`, level,
              status: 500, ok: false, summary: String(error?.message ?? error).slice(0, 200),
            })
          }
          throw error
        }
      },
    }))
  }

  register(defineStudioTool({
    name: 'studio_config_get',
    description: 'Read the Studio settings (GitLab / Feishu endpoints and the role→model mapping). Secrets are returned as presence flags, never values.',
    parameters: {},
    async execute() {
      await store.ready
      return { ok: true, config: publicConfig(store.snapshot().config), statuses: STATUSES, roles: ROLE_IDS }
    },
  }))

  register(defineStudioTool({
    name: 'studio_config_set',
    description: 'Update Studio settings. Only the fields you pass change; an empty token/secret leaves the stored secret untouched. Use clearToken / clearAppSecret to erase one.',
    parameters: {
      gitlabUrl: { type: 'string', description: 'GitLab base URL, e.g. https://gitlab.example.com' },
      gitlabToken: { type: 'string', description: 'GitLab personal/project access token (written once, never returned).' },
      gitlabGroup: { type: 'string', description: 'Default GitLab group or namespace.' },
      gitlabProject: { type: 'string', description: 'Default GitLab project path (group/name).' },
      feishuAppId: { type: 'string', description: 'Feishu self-built app App ID.' },
      feishuAppSecret: { type: 'string', description: 'Feishu app secret (written once, never returned).' },
      feishuChatId: { type: 'string', description: 'Default Feishu chat id for notifications.' },
      roleModels: {
        type: 'object',
        additionalProperties: true,
        description: 'Role → model overrides, e.g. {"dev":"deepseek-v4.1-flash","qa":"deepseek-v4.1-flash"}',
      },
    },
    async execute(args) {
      const patch = { gitlab: {}, feishu: {}, roles: {} }
      if (args.gitlabUrl !== undefined) patch.gitlab.url = args.gitlabUrl
      if (args.gitlabToken !== undefined) patch.gitlab.token = args.gitlabToken
      if (args.gitlabGroup !== undefined) patch.gitlab.group = args.gitlabGroup
      if (args.gitlabProject !== undefined) patch.gitlab.project = args.gitlabProject
      if (args.feishuAppId !== undefined) patch.feishu.appId = args.feishuAppId
      if (args.feishuAppSecret !== undefined) patch.feishu.appSecret = args.feishuAppSecret
      if (args.feishuChatId !== undefined) patch.feishu.chatId = args.feishuChatId
      if (args.roleModels !== undefined && typeof args.roleModels === 'object') {
        for (const [role, model] of Object.entries(args.roleModels)) {
          if (ROLE_IDS.includes(role) && typeof model === 'string') patch.roles[role] = { model }
        }
      }
      await host.applyConfig(store, patch)
      return { ok: true, config: publicConfig(store.snapshot().config) }
    },
  }))

  register(defineStudioTool({
    name: 'studio_requirement_list',
    description: 'List product requirements (REQ-...). A requirement is the anchor of the whole delivery chain: every task, artifact, test case, bug and MR hangs under it. Filter by project or status.',
    parameters: {
      project: { type: 'string', description: '业务项目 id。' },
      status: { type: 'string', description: `draft | active | delivered | closed` },
    },
    async execute(args) {
      await store.ready
      const state = store.snapshot()
      const rows = state.requirements
        .filter(req => args.project === undefined || req.project === args.project)
        .filter(req => args.status === undefined || req.status === args.status)
      if (rows.length === 0) return '还没有登记任何需求。用 studio_requirement_save 建一条。'
      const lines = rows.map(req => {
        const tasks = state.tasks.filter(task => task.requirementId === req.id)
        const done = tasks.filter(task => task.status === 'done').length
        return `${req.code || req.id}｜${req.title}｜${REQ_STATUS_LABEL[req.status] ?? req.status}｜卡 ${done}/${tasks.length}｜${req.owner || '未指定负责人'}`
      })
      return [`共 ${rows.length} 条需求：`, ...lines].join('\n')
    },
  }))

  register(defineStudioTool({
    name: 'studio_requirement_get',
    description: 'Read one requirement with its full rollup: tasks by column and type, checklist progress, test cases, artifacts and merge requests.',
    parameters: { id: { type: 'string', required: true, description: '需求 id' } },
    async execute(args) {
      await store.ready
      const rollup = requirementRollup(store.snapshot(), args.id)
      if (rollup === undefined) throw new Error(`no requirement ${args.id}`)
      return {
        ...rollup,
        matrix: requirementMatrix(store.snapshot(), rollup.requirement),
        progress: requirementProgress(store.snapshot(), rollup.requirement),
      }
    },
  }))

  register(defineStudioTool({
    name: 'studio_requirement_save',
    description: 'Create or update a requirement (PRD anchor). Omit id to create one; its code REQ-YYYY-NNN is assigned automatically.',
    parameters: {
      id: { type: 'string', description: '需求 id（省略则新建）。' },
      title: { type: 'string', description: '需求标题。' },
      description: { type: 'string', description: '需求正文 / PRD 摘要。' },
      project: { type: 'string', description: '业务项目 id。' },
      iteration: { type: 'string', description: '迭代 id。' },
      service: { type: 'string', description: '服务 id（决定 worktree 用哪个 git 路径）。' },
      owner: { type: 'string', description: '业务负责人。' },
      priority: { type: 'string', description: 'urgent | normal | relaxed' },
      status: { type: 'string', description: 'draft | active | delivered | closed' },
      prd: { type: 'string', description: 'PRD 文档链接（如飞书云文档）。' },
      proto: { type: 'string', description: '原型链接。' },
      acceptance: { type: 'string', description: '验收标准链接。' },
    },
    async execute(args) {
      const input = { ...args }
      if (args.prd !== undefined || args.proto !== undefined || args.acceptance !== undefined) {
        input.links = { prd: args.prd ?? '', proto: args.proto ?? '', acceptance: args.acceptance ?? '' }
      }
      const requirement = await saveRequirement(store, input)
      return `已保存需求 ${requirement.code}（${REQ_STATUS_LABEL[requirement.status] ?? requirement.status}）：${requirement.title}`
    },
  }))

  register(defineStudioTool({
    name: 'studio_requirement_signoff',
    description: 'Sign off (or clear) a requirement after delivery review; the note is the acceptance conclusion.',
    parameters: {
      id: { type: 'string', required: true, description: '需求 id。' },
      note: { type: 'string', description: '验收结论：交付了什么、遗留什么（签字时必填）。' },
      by: { type: 'string', description: '签字人。' },
      action: { type: 'string', description: 'sign（默认）| clear' },
    },
    async execute(args) {
      const id = String(args.id ?? '')
      const action = args.action === 'clear' ? 'clear' : 'sign'
      const note = String(args.note ?? '').trim().slice(0, 600)
      if (action === 'sign' && note === '') throw new Error('需求验收签字要写一句结论：交付了什么、遗留什么')
      const snapshot = await store.mutate(state => {
        const target = state.requirements.find(item => item.id === id)
        if (target === undefined) throw new Error('需求不存在')
        if (action === 'sign') {
          target.signoff = { by: String(args.by ?? 'agent').slice(0, 60), at: Date.now(), note }
          const open = state.tasks.filter(task => task.requirementId === id && task.status !== 'done').length
          const total = state.tasks.filter(task => task.requirementId === id).length
          if (open === 0 && total > 0) target.status = 'delivered'
        } else {
          target.signoff = null
          if (target.status === 'delivered') target.status = 'active'
        }
        target.updatedAt = Date.now()
      })
      const requirement = snapshot.requirements.find(item => item.id === id)
      const progress = requirementProgress(snapshot, requirement)
      const head = action === 'sign' ? `已给 ${requirement.code} 签字` : `已取消 ${requirement.code} 的签字`
      const tail = progress.gate.ready
        ? '需求准出：通过'
        : `需求准出还差：${progress.gate.blockers.join('；')}`
      return `${head}｜${tail}（进度 ${progress.progress}%：${progress.cards.done}/${progress.cards.total} 张卡已完成）`
    },
  }))

  register(defineStudioTool({
    name: 'studio_requirement_folder',
    description: 'Create (or reuse) the Feishu Drive folder of a requirement and optionally sync every deliverable under it into that folder as Markdown documents.',
    parameters: {
      id: { type: 'string', required: true, description: '需求 id 或编号（REQ-2026-001）。' },
      sync: { type: 'boolean', description: '是否顺便把所有交付物写进这个文件夹（默认 true）。' },
    },
    async execute(args) {
      const state = store.snapshot()
      const key = String(args.id ?? '')
      const requirement = state.requirements.find(item => item.id === key || item.code === key)
      if (requirement === undefined) throw new Error(`no requirement ${key}`)
      const folder = await ensureReqFolder(store, requirement.id)
      if (String(folder.token ?? '').length === 0) {
        return `建文件夹失败：${folder.error ?? '未知原因'}`
      }
      const lines = [`需求 ${requirement.code} 的云盘文件夹：${folder.name}`, folder.url]
      if (args.sync !== false) {
        const report = await syncRequirementArtifacts(store, requirement.id)
        lines.push(`交付物归档：共 ${report.total} 件，成功 ${report.written} 件，失败 ${report.failed} 件。`)
        for (const message of report.errors) lines.push(`- ${message}`)
      }
      return lines.join('\n')
    },
  }))

  register(defineStudioTool({
    name: 'studio_task_list',
    description: 'List work-board tasks, newest first. Filter by status or role. Read this before claiming work; the board is the shared truth between product, architect, developer and QA agents.',
    parameters: {
      status: { type: 'string', description: `Filter by status: ${STATUS_IDS.join(' / ')}` },
      role: { type: 'string', description: `Filter by role: ${ROLE_IDS.join(' / ')}` },
      type: { type: 'string', description: `Filter by type: ${TASK_TYPES.join(' / ')}` },
      project: { type: 'string', description: 'Filter by 业务项目 id.' },
      requirementId: { type: 'string', description: 'Filter by 需求 id（只看一条需求下的卡）。' },
      limit: { type: 'number', description: 'Max tasks to return (default 50).' },
    },
    async execute(args) {
      await store.ready
      const tasks = store.snapshot().tasks
        .filter(t => args.status === undefined || t.status === args.status)
        .filter(t => args.role === undefined || t.role === args.role)
        .filter(t => args.type === undefined || t.type === args.type)
        .filter(t => args.project === undefined || t.project === args.project)
        .filter(t => args.requirementId === undefined || t.requirementId === '' || t.requirementId === args.requirementId)
        .slice(0, Number.isFinite(args.limit) ? Math.max(1, Math.min(200, args.limit)) : 50)
      if (tasks.length === 0) return '工作看板暂无匹配任务。'
      return [`工作看板共 ${store.snapshot().tasks.length} 条，匹配 ${tasks.length} 条：`, ...tasks.map(taskLine)].join('\n')
    },
  }))

  register(defineStudioTool({
    name: 'studio_task_get',
    description: 'Read one work-board task in full: requirement, artifacts, GitLab links, comments and status history.',
    parameters: { id: { type: 'string', required: true, description: 'Task id, e.g. t-1a2b3c4d' } },
    async execute(args) {
      await store.ready
      const task = store.snapshot().tasks.find(t => t.id === args.id)
      if (task === undefined) throw new Error(`no task ${args.id}`)
      return task
    },
  }))

  register(defineStudioTool({
    name: 'studio_task_create',
    description: 'Create a work-board task. Use one task per unit of work a role agent can finish and be reviewed on.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short imperative title.' },
      requirement: { type: 'string', description: 'What the task involves: background, acceptance criteria, links.' },
      type: { type: 'string', description: `requirement | bug | design | dev | test | ops (default requirement). Use bug for a defect: it starts in 待开发 and the owning agent is told to reproduce, find the root cause and fix it.` },
      severity: { type: 'string', description: 'For bug tasks: p0 | p1 | p2 | p3 (default p2, p0 auto-sets urgency to urgent).' },
      role: { type: 'string', description: 'Owning role: product | architect | dev | qa (default product)' },
      status: { type: 'string', description: `Initial status (default clarify): ${STATUS_IDS.join(' / ')}` },
      priority: { type: 'string', description: 'urgent | normal | relaxed (default normal)' },
      gitlabIssue: { type: 'string', description: 'Related GitLab issue URL or iid.' },
      domain: { type: 'string', description: '业务领域（如 支付 / 风控 / 会员），用于把卡路由给同领域专家。' },
      owner: { type: 'string', description: 'Human or agent accountable for the next step.' },
      project: { type: 'string', description: '业务项目 id（studio_project_list 可查）。多项目并行时每张卡都要挂项目。' },
      iteration: { type: 'string', description: '迭代 id（属于上面那个项目）。' },
      service: { type: 'string', description: '服务 id：一个项目里有多个服务时指定这次改哪个服务（决定用哪个 git 路径切 worktree）。' },
      parent: { type: 'string', description: '父任务 id：缺陷挂到它发现自的那张卡上。' },
      requirementId: { type: 'string', description: '挂到哪条需求（REQ 的 id）。挂上后自动分配编号 DEV-001 / TEST-001 等。' },
      pointId: { type: 'string', description: '挂到需求的哪个功能点 id（可追溯矩阵靠它对齐）。' },
      dueAt: { type: 'number', description: '期望完成时间（epoch 毫秒）。' },
    },
    async execute(args) {
      const task = await host.createTask(store, args)
      return `已创建 ${task.id}：${task.title}（${task.status}，${task.role}）`
    },
  }))

  register(defineStudioTool({
    name: 'studio_task_update',
    description: 'Move a task forward: change status, owning role, priority, artifacts or GitLab links, or flag it as blocked. A blocked card stays in its column and waits for a human; every change is recorded in the task history.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      status: { type: 'string', description: `New column: ${STATUS_IDS.join(' / ')}` },
      role: { type: 'string', description: 'New owning role.' },
      priority: { type: 'string', description: 'urgent | normal | relaxed' },
      blocked: { type: 'boolean', description: 'true = 干不下去了，把卡标成阻塞（留在原列，等人处理）；false = 解除阻塞。' },
      blockedReason: { type: 'string', description: 'Why the work cannot continue (used together with blocked=true).' },
      gitlabIssue: { type: 'string', description: 'GitLab issue URL or iid.' },
      gitlabMR: { type: 'string', description: 'GitLab merge-request URL or iid.' },
      artifacts: { type: 'array', items: { type: 'string' }, description: '交付物：路径、文档或链接（也可以用 studio_task_artifact 单独登记）。' },
      project: { type: 'string', description: '业务项目 id。' },
      iteration: { type: 'string', description: '迭代 id。' },
      service: { type: 'string', description: '服务 id（决定 worktree 用哪个 git 路径）。' },
      parent: { type: 'string', description: '父任务 id。' },
      requirementId: { type: 'string', description: '改挂到另一条需求（会自动重新分配编号）。' },
      pointId: { type: 'string', description: '挂到需求的哪个功能点（可追溯矩阵靠它对齐）。' },
      override: { type: 'string', description: '推到「已完成」但准出没过时，写清原因（会记进状态历史）。' },
      dueAt: { type: 'number', description: '期望完成时间（epoch 毫秒）。' },
      releaseId: { type: 'string', description: '挂到哪个版本（版本 id；空字符串 = 脱离版本）。' },
      title: { type: 'string', description: 'Replace the title.' },
    },
    async execute(args) {
      const { id, ...rest } = args
      const task = await updateTask(store, id, { ...rest, by: rest.by })
      return `已更新 ${task.id}：${task.status}｜${task.title}`
    },
  }))

  register(defineStudioTool({
    name: 'studio_task_signoff',
    description: 'Sign off acceptance for a card (or clear a previous sign-off). A card cannot reach 已完成 without a sign-off unless a human overrides with a reason.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      note: { type: 'string', description: '验收结论：验了什么、结果如何、遗留什么（签字必填）。' },
      action: { type: 'string', description: 'sign（默认）| clear' },
      by: { type: 'string', description: '谁验的（人）。' },
    },
    async execute(args) {
      const id = String(args.id ?? '')
      const action = String(args.action ?? 'sign')
      const by = String(args.by ?? '人').slice(0, 40)
      const note = String(args.note ?? '').slice(0, 600)
      await store.mutate(state => {
        const entry = state.tasks.find(item => item.id === id)
        if (entry === undefined) throw new Error(`no task ${id}`)
        if (action === 'clear') {
          entry.signoff = null
          entry.history.push({ at: Date.now(), by, status: entry.status, note: 'signoff-cleared' })
        } else {
          if (note.trim() === '') throw new Error('验收签字要写一句结论：验了什么、遗留什么')
          entry.signoff = { by, at: Date.now(), note }
          entry.history.push({ at: Date.now(), by, status: entry.status, note: `signoff：${note.slice(0, 80)}` })
        }
        entry.updatedAt = Date.now()
      })
      const task = store.snapshot().tasks.find(item => item.id === id)
      const gate = taskExitGate(store.snapshot(), task)
      return `已${action === 'clear' ? '取消签字' : '签字'} ${task.code || task.id}｜准出：${gate.ready ? '通过' : `还差 ${gate.blockers.join('；')}`}`
    },
  }))

  register(defineStudioTool({
    name: 'studio_task_generate_cases',
    description: '按需求的「功能点 + 验收条件」为这张卡生成测试用例草稿（按标题去重，不覆盖已有用例）。',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      by: { type: 'string', description: '谁生成的，默认人。' },
    },
    async execute(args) {
      const result = await host.addDraftCases(store, String(args.id ?? ''), String(args.by ?? '人').slice(0, 40))
      if (result.added === 0 && result.reason !== '') return `没生成用例：${result.reason}`
      return `已生成 ${result.added} 条用例，这张卡现在共 ${result.total} 条。`
    },
  }))

  register(defineStudioTool({
    name: 'studio_bug_duplicate',
    description: '把一张缺陷标成另一张的重复（targetId 传空则取消重复标记）。',
    parameters: {
      id: { type: 'string', required: true, description: '重复的那张缺陷。' },
      targetId: { type: 'string', description: '保留的主缺陷 id。' },
      by: { type: 'string', description: '谁判断的。' },
    },
    async execute(args) {
      const task = await markDuplicate(store, String(args.id ?? ''), String(args.targetId ?? ''), String(args.by ?? '人').slice(0, 40))
      return task.duplicateOf === '' ? `${task.code || task.id} 已取消重复标记。` : `${task.code || task.id} 标为重复，主缺陷是 ${task.duplicateOf}。`
    },
  }))

  register(defineStudioTool({
    name: 'studio_dashboard',
    description: '工作台体检：逾期、阻塞、缺陷超时、准出被拦、流水线失败、需求/版本卡住、集成异常，一次看全。',
    parameters: {},
    async execute() {
      const board = buildDashboard(store.snapshot())
      const risks = board.risks
      const lines = [
        `在办 ${board.scope.open} 张 / 共 ${board.scope.tasks} 张；待评审 ${board.flow.review}、待测试 ${board.flow.test}、待验收 ${board.flow.accept}；今天完成 ${board.flow.doneToday}、近 7 天 ${board.flow.doneWeek}。`,
        `风险：逾期 ${risks.overdue} · 阻塞 ${risks.blocked} · 缺陷超时 ${risks.slaOverdue} · 准出被拦 ${risks.gateFailed} · 流水线失败 ${risks.pipelineFailed} · 需求卡住 ${risks.requirementBlocked} · 版本卡住 ${risks.releaseBlocked} · 集成异常 ${risks.integrationsBroken}`,
        `AI 正在跑 ${board.ai.running} 个会话，今天派单 ${board.ai.todayRuns} 次。`,
      ]
      for (const [key, label] of [['overdue', '逾期'], ['blocked', '阻塞'], ['slaOverdue', '缺陷超时'], ['gateFailed', '准出被拦'], ['pipelineFailed', '流水线失败']]) {
        const items = board.list[key] ?? []
        if (items.length === 0) continue
        lines.push(`${label}：${items.map(item => `${item.code || item.id} ${item.title}`).join('；')}`)
      }
      return lines.join('\n')
    },
  }))

  register(defineStudioTool({
    name: 'studio_workload',
    description: '每个专家手上还有多少活：正在跑、在办、近 7 天完成、逾期缺陷。',
    parameters: {},
    async execute() {
      const dispatcher = host.getActiveDispatcher()
      const running = dispatcher === undefined ? [] : [...dispatcher.running.values()]
      const report = host.workloadReport(store.snapshot(), running)
      const lines = report.experts.filter(item => item.enabled).map(item => `${item.emoji} ${item.name}：在跑 ${item.running} · 在办 ${item.open} · 近7天完成 ${item.done7d}${item.overdue > 0 ? ` · 逾期缺陷 ${item.overdue}` : ''}`)
      return lines.length === 0 ? '还没有配置专家。' : [`同时有 ${report.busy} 位专家在跑。`, ...lines].join('\n')
    },
  }))

  register(defineStudioTool({
    name: 'studio_burndown',
    description: '近 N 天每天的剩余卡数（按创建与完成时间回推），带项目过滤。',
    parameters: {
      days: { type: 'string', description: '7 / 14 / 30，默认 14。' },
      project: { type: 'string', description: '业务项目 id，留空看全部。' },
    },
    async execute(args) {
      const report = host.burndownReport(store.snapshot(), { days: args.days ?? '', project: args.project ?? '' })
      const lines = report.series.map(point => `${point.day}：还剩 ${point.remaining}（累计建 ${point.created} · 累计完成 ${point.done}）`)
      return lines.join('\n')
    },
  }))

  register(defineStudioTool({
    name: 'studio_costs',
    description: 'AI 执行成本：派单次数、平均时长、按专家/模型/提示词版本分组（宿主不回 token，按次数计时）。',
    parameters: {},
    async execute() {
      const summary = runSummary()
      if (summary.total === 0) return '还没有派单记录。'
      const lines = [
        `共 ${summary.total} 次派单（${summary.finished} 次已结束），平均 ${Math.round(summary.avgMs / 1000)} 秒。`,
        `按专家：${summary.byExpert.map(item => `${item.key} ${item.runs}`).join(' · ')}`,
        `按模型：${summary.byModel.map(item => `${item.key} ${item.runs}`).join(' · ')}`,
        `按提示词版本：${summary.byPromptVersion.map(item => `${item.key} ${item.runs}`).join(' · ')}`,
      ]
      return lines.join('\n')
    },
  }))

  register(defineStudioTool({
    name: 'studio_release_list',
    description: 'List releases with their gate status (can it ship? what is still open). Use this before publishing anything.',
    parameters: {},
    async execute() {
      const state = store.snapshot()
      if (state.releases.length === 0) return '还没有版本。先建一个版本，再把卡挂上去。'
      const lines = state.releases.map(item => {
        const gate = host.releaseGate(state, item)
        const label = RELEASE_STATUS_LABEL[item.status] ?? item.status
        const head = `${item.version || item.id} ${item.name}｜${label}｜卡 ${gate.stats.done}/${gate.stats.tasks}`
        const tail = gate.blockers.length > 0 ? `｜阻塞项：${gate.blockers.join('；')}` : '｜门禁通过'
        return `- ${head}${tail}`
      })
      return lines.join('\n')
    },
  }))

  register(defineStudioTool({
    name: 'studio_release_get',
    description: 'One release in detail: its cards, gate blockers and the generated release notes.',
    parameters: {
      id: { type: 'string', required: true, description: 'Release id or version.' },
    },
    async execute(args) {
      const state = store.snapshot()
      const wanted = String(args.id ?? '')
      const release = state.releases.find(item => item.id === wanted || item.version === wanted)
      if (release === undefined) throw new Error(`no release ${wanted}`)
      const gate = host.releaseGate(state, release)
      const tasks = state.tasks.filter(task => task.releaseId === release.id)
      const lines = [
        `${release.version || release.id} ${release.name}｜${RELEASE_STATUS_LABEL[release.status] ?? release.status}`,
        `卡 ${tasks.length} 张：${tasks.map(task => `${task.code || task.id}(${task.status})`).join('、') || '无'}`,
        gate.blockers.length === 0 ? '门禁：通过' : `门禁：不通过 —— ${gate.blockers.join('；')}`,
        gate.warnings.length === 0 ? '' : `提醒：${gate.warnings.join('；')}`,
        release.notes === '' ? '发布说明：还没生成' : `发布说明：\n${release.notes.slice(0, 2000)}`,
      ].filter(line => line !== '')
      return lines.join('\n')
    },
  }))

  register(defineStudioTool({
    name: 'studio_release_save',
    description: 'Create or update a release (version). Version strings are locked once released or rolled back.',
    parameters: {
      id: { type: 'string', description: 'Existing release id (omit to create).' },
      version: { type: 'string', description: '例如 v1.3.0' },
      name: { type: 'string', description: '版本名，例如 积分抵扣首个版本' },
      project: { type: 'string', description: '属于哪个业务项目（项目 id）。' },
      owner: { type: 'string', description: '发布负责人。' },
      plannedAt: { type: 'number', description: '计划发布时间（epoch 毫秒）。' },
      status: { type: 'string', description: `draft | candidate | approved（${RELEASE_STATUS_LABEL.draft} / ${RELEASE_STATUS_LABEL.candidate} / ${RELEASE_STATUS_LABEL.approved}）` },
    },
    async execute(args) {
      const incoming = sanitizeRelease({ ...args, id: args.id ?? args.version ?? args.name })
      if (incoming === null) throw new Error('版本至少要填 version 或 name')
      let saved = null
      await store.mutate(state => {
        const existing = state.releases.find(item => item.id === incoming.id)
        if (existing === undefined) {
          saved = { ...incoming, createdAt: Date.now(), updatedAt: Date.now() }
          state.releases.push(saved)
          return
        }
        existing.name = incoming.name === '' ? existing.name : incoming.name
        existing.project = incoming.project
        existing.owner = incoming.owner
        existing.plannedAt = incoming.plannedAt
        if (existing.status !== 'released' && existing.status !== 'rolled_back') existing.status = incoming.status
        existing.updatedAt = Date.now()
        saved = { ...existing }
      })
      return `已保存版本 ${saved.version || saved.id}（${RELEASE_STATUS_LABEL[saved.status] ?? saved.status}）`
    },
  }))

  register(defineStudioTool({
    name: 'studio_release_publish',
    description: 'Publish a release. Refuses when the gate is not clean: open cards, blocked cards, open bugs or failing cases all block it.',
    parameters: {
      id: { type: 'string', required: true, description: 'Release id or version.' },
      by: { type: 'string', description: 'Who publishes it.' },
    },
    async execute(args) {
      const wanted = String(args.id ?? '')
      const by = String(args.by ?? 'agent').slice(0, 120)
      let saved = null
      await store.mutate(state => {
        const release = state.releases.find(item => item.id === wanted || item.version === wanted)
        if (release === undefined) throw new Error(`no release ${wanted}`)
        if (release.status === 'released') throw new Error('这个版本已经发布过了')
        const gate = host.releaseGate(state, release)
        if (!gate.ready) throw new Error(`门禁没过：${gate.blockers.join('；')}`)
        release.status = 'released'
        release.releasedAt = Date.now()
        release.approveBy = release.approveBy === '' ? by : release.approveBy
        release.approveAt = release.approveAt === 0 ? Date.now() : release.approveAt
        release.notes = release.notes === '' ? host.releaseNotes(state, release) : release.notes
        release.deployLog = [...(release.deployLog ?? []), {
          at: Date.now(), by, action: 'publish', note: `tag ${release.tagName || '—'}`,
        }].slice(-200)
        release.updatedAt = Date.now()
        saved = { ...release }
      })
      return `已发布 ${saved.version || saved.id}：\n${saved.notes.slice(0, 1500)}`
    },
  }))

  register(defineStudioTool({
    name: 'studio_release_gray',
    description: 'Manage gradual rollout batches on a release: add a batch (percent), mark one as running/passed, or roll a batch back (which rolls the whole release back). Use it instead of claiming "灰度中" without a record.',
    parameters: {
      id: { type: 'string', required: true, description: 'Release id or version.' },
      action: { type: 'string', enum: ['add', 'start', 'advance', 'rollback'], description: 'add a batch / mark it running / mark it passed / roll back.' },
      batchId: { type: 'string', description: 'Target batch id (needed except when adding).' },
      name: { type: 'string', description: 'Batch name when adding, e.g. 内测用户 10%.' },
      percent: { type: 'number', description: 'Traffic percent when adding (1-100).' },
      note: { type: 'string', description: 'Conclusion or rollback reason.' },
      by: { type: 'string', description: 'Who did it.' },
    },
    async execute(args) {
      const wanted = String(args.id ?? '')
      const action = String(args.action ?? 'add')
      const by = String(args.by ?? 'agent').slice(0, 120)
      const note = String(args.note ?? '').slice(0, 600)
      let saved = null
      let gate = null
      await store.mutate(state => {
        const release = state.releases.find(item => item.id === wanted || item.version === wanted)
        if (release === undefined) throw new Error(`no release ${wanted}`)
        const batches = release.grayBatches ?? []
        if (action === 'add') {
          if (batches.length >= 20) throw new Error('灰度批次最多 20 批')
          const percent = Math.max(0, Math.min(100, Number(args.percent) || 0))
          if (percent <= 0) throw new Error('灰度比例要大于 0，例如 10')
          batches.push({
            id: `g-${Date.now().toString(36)}`,
            name: String(args.name ?? '').slice(0, 120) || `第 ${batches.length + 1} 批 ${percent}%`,
            percent,
            status: 'pending',
            by,
            at: Date.now(),
            note,
          })
        } else {
          const target = batches.find(item => item.id === String(args.batchId ?? ''))
          if (target === undefined) throw new Error('找不到这一批灰度')
          if (action === 'advance') {
            target.status = 'passed'
            target.at = Date.now()
          } else if (action === 'start') {
            target.status = 'running'
            target.at = Date.now()
          } else if (action === 'rollback') {
            if (note === '') throw new Error('灰度回滚要写原因')
            target.status = 'rolled_back'
            target.at = Date.now()
            target.note = note
            release.status = 'rolled_back'
            release.rollbackReason = `灰度「${target.name}」回滚：${note}`
          } else {
            throw new Error(`unknown gray action: ${action}`)
          }
          target.by = by
        }
        release.grayBatches = batches
        release.deployLog = [...(release.deployLog ?? []), {
          at: Date.now(), by, action: `gray-${action}`, note: note || `${batches.length} 批`,
        }].slice(-200)
        release.updatedAt = Date.now()
        saved = { ...release }
        gate = host.releaseGate(state, release)
      })
      return [
        `${saved.version || saved.id}：灰度 ${saved.grayBatches.length} 批（已过 ${saved.grayBatches.filter(item => item.status === 'passed').length}）`,
        ...saved.grayBatches.map(item => `- ${item.name} ${item.percent}% · ${item.status}`),
        gate.warnings.length > 0 ? `提醒：${gate.warnings.join('；')}` : '门禁无提醒',
      ].join('\n')
    },
  }))

  register(defineStudioTool({
    name: 'studio_task_block',
    description: 'Flag a task as blocked: it stays in its current column, stops being auto-dispatched, and waits for a human to decide how to continue. Always give a concrete reason.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      reason: { type: 'string', required: true, description: 'What exactly is blocking this (missing info, permission, dependency, failing test...).' },
    },
    async execute(args) {
      const reason = text(args.reason, 500) ?? ''
      if (reason === '') throw new Error('reason is required')
      const task = await updateTask(store, args.id, { blocked: true, blockedReason: reason, by: 'agent' })
      host.getActiveDispatcher()?.abortTask?.(task.id)
      return `已标记阻塞 ${task.id}（停在「${STATUSES.find(s => s.id === task.status)?.label ?? task.status}」）：${reason}`
    },
  }))

  register(defineStudioTool({
    name: 'studio_task_unblock',
    description: 'Clear the blocked flag after a human decided how to continue.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      note: { type: 'string', description: 'How to continue, for the record.' },
    },
    async execute(args) {
      const task = await updateTask(store, args.id, { blocked: false, by: 'agent' })
      return `已解除阻塞 ${task.id}：${task.title}`
    },
  }))

  register(defineStudioTool({
    name: 'studio_task_comment',
    description: 'Append a comment to a task: progress notes, review findings, hand-off details. Comments are the durable conversation between role agents and humans.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      body: { type: 'string', required: true, description: 'Comment text (markdown).' },
      author: { type: 'string', description: 'Author label, e.g. 研发 or 张三 (default agent).' },
    },
    async execute(args) {
      const { task, mentions } = await commentTask(store, args.id, args.body, args.author, 'agent')
      const dispatched = []
      if (host.getActiveDispatcher() !== undefined) {
        for (const mention of mentions) {
          try {
            await host.getActiveDispatcher().dispatchMention(task.id, mention, String(args.body ?? ''))
            dispatched.push(`${mention.kind}:${mention.id}`)
          } catch (error) {
            dispatched.push(`${mention.kind}:${mention.id} failed: ${error?.message ?? error}`)
          }
        }
      }
      const tail = dispatched.length > 0 ? ` 已通知 ${dispatched.join('、')}。` : ''
      return `已评论 ${task.id}，当前 ${task.comments.length} 条评论。${tail}`
    },
  }))

  register(defineStudioTool({
    name: 'studio_project_save',
    description: 'Create or update a business project and its services. A project groups cards; a service is one deployable thing with its own local git path and base branch, and a card picks a service so its worktree is cut from that service. Partial update: only the fields you pass are changed. Pass services to replace the whole service list (each needs a name; repoPath is the local checkout used for worktrees).',
    parameters: {
      id: { type: 'string', description: 'Project id; omit when creating (derived from the name).' },
      name: { type: 'string', description: 'Project name, e.g. 订单中心.' },
      key: { type: 'string', description: 'Short code shown on cards, e.g. ORD.' },
      description: { type: 'string', description: 'What this project does, for whom.' },
      lead: { type: 'string', description: 'Business owner.' },
      status: { type: 'string', description: 'active | archived.' },
      repoPath: { type: 'string', description: 'Default local git path when cards do not pick a service.' },
      baseBranch: { type: 'string', description: 'Default base branch, e.g. main.' },
      services: {
        type: 'array',
        description: 'Replace the service list. Example: [{"name":"order-service","repoPath":"/srv/repos/order","baseBranch":"main"}].',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Service name, e.g. order-service.' },
            repoPath: { type: 'string', description: 'Local git checkout for this service (worktree base).' },
            baseBranch: { type: 'string', description: 'Base branch, default main.' },
            repoId: { type: 'string', description: 'Optional GitLab project id from the code-repo settings.' },
            dependsOn: {
              type: 'array',
              description: 'Service ids in this project that must be finished first, e.g. ["order-service"]. Cards on this service cannot pass the exit gate while those services still have open cards.',
              items: { type: 'string' },
            },
          },
          required: ['name'],
        },
      },
    },
    async execute(args) {
      await store.ready
      const input = args ?? {}
      const existing = store.snapshot().config.projects ?? []
      const wantedId = cleanId(input.id ?? input.name, 'proj')
      const before = existing.find(item => item.id === wantedId)
      const merged = {
        ...(before ?? {}),
        id: wantedId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.key !== undefined ? { key: input.key } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.lead !== undefined ? { lead: input.lead } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.repoPath !== undefined ? { repoPath: input.repoPath } : {}),
        ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
        ...(Array.isArray(input.services) ? { services: input.services } : {}),
      }
      if (before === undefined && (merged.name === undefined || String(merged.name).trim() === '')) {
        throw new Error('新建项目要给 name')
      }
      await host.applyConfig(store, { projects: host.upsertById(existing, merged) })
      const saved = (store.snapshot().config.projects ?? []).find(item => item.id === wantedId)
      const lines = [`已保存项目 ${saved?.id} ${saved?.name}（${saved?.key || '无代号'}）`]
      const services = saved?.services ?? []
      if (services.length === 0) lines.push(`服务：无（worktree 用默认目录 ${saved?.repoPath || '未配置'}）`)
      else {
        lines.push(`服务（${services.length}）：`)
        for (const service of services) {
          lines.push(`- ${service.id} ${service.name}：${service.repoPath || '未配路径'} · 基线 ${service.baseBranch}${service.repoId ? ` · GitLab ${service.repoId}` : ''}${(service.dependsOn ?? []).length > 0 ? ` · 依赖 ${(service.dependsOn ?? []).join('、')}` : ''}`)
        }
      }
      return lines.join('\n')
    },
  }))

  register(defineStudioTool({
    name: 'studio_project_list',
    description: 'List the company projects (with their iterations) and the per-project workload: how many cards in each column, how many blocked, overdue, open defects, checklist progress and average cycle time. Read this when you need to know which project a card belongs to or how loaded a project is.',
    parameters: {},
    async execute() {
      await store.ready
      const state = store.snapshot()
      const metrics = host.buildMetrics(state)
      const lines = ['业务项目：']
      for (const item of metrics.projects) {
        const m = item.metrics
        const iters = (item.iterations ?? []).map(iter => `${iter.name}${iter.status === 'active' ? '(进行中)' : ''}`).join('、') || '无'
        const svcs = (item.services ?? []).map(svc => `${svc.name}${svc.repoPath ? `→${svc.repoPath}` : '(未配路径)'}`).join('、') || (item.repoPath ? `默认目录 ${item.repoPath}` : '无')
        lines.push(`- ${item.id} ${item.name}${item.key ? ` [${item.key}]` : ''}：${m.total} 张卡（待澄清 ${m.byStatus.clarify}/待方案 ${m.byStatus.design}/待开发 ${m.byStatus.dev_ready}/开发中 ${m.byStatus.dev}/待测试 ${m.byStatus.test}/待验收 ${m.byStatus.accept}/已完成 ${m.byStatus.done}）· 阻塞 ${m.blocked} · 逾期 ${m.overdue} · 未结缺陷 ${m.bugs} · 清单 ${m.checklist.done}/${m.checklist.total} · 平均周期 ${m.avgCycleMs > 0 ? `${Math.round(m.avgCycleMs / 3600000)} 小时` : '—'} · 迭代：${iters} · 服务：${svcs}`)
      }
      if (metrics.projects.length === 0) lines.push('（还没有配置项目，所有卡都在「未分配项目」里）')
      lines.push(`未分配项目：${metrics.unassigned.total} 张卡`)
      return lines.join('\n')
    },
  }))

  register(defineStudioTool({
    name: 'studio_analytics',
    description: 'Read the delivery analytics: first-pass rate, rework rate (how often cards go backwards), cycle-time distribution and median/p90, how long cards sit in each column, throughput of the last 14 days, and how much AI output was accepted (deliverables accepted vs registered, coding reviews approved, unit-test pass rate). Use it when someone asks how the team is doing, not for a single card.',
    parameters: {
      days: { type: 'number', description: 'Window in days: 7, 30 or 90. Default 30.' },
      project: { type: 'string', description: 'Business project id; omit for the whole board.' },
    },
    async execute(args) {
      await store.ready
      const analytics = host.buildAnalytics(store.snapshot(), { days: args?.days, project: args?.project })
      const lines = [
        `统计口径：最近 ${analytics.days} 天${analytics.project === '' ? '' : ` · 项目 ${analytics.project}`}，${analytics.scope.tasks} 张卡（${analytics.scope.done} 张已完成）`,
        `一次通过率：${Math.round(analytics.rework.firstPassRate * 100)}%（已完成卡里从没倒退过的比例）`,
        `返工率：${Math.round(analytics.rework.rate * 100)}%（${analytics.rework.reworked}/${analytics.rework.moved} 张卡倒退过；评审打回 ${analytics.rework.reviewRework} 次、测试打回 ${analytics.rework.testRework} 次）`,
        `周期：平均 ${analytics.cycle.avgDays.toFixed(1)} 天 · 中位 ${analytics.cycle.medianDays.toFixed(1)} 天 · P90 ${analytics.cycle.p90Days.toFixed(1)} 天`,
        `周期分布：${analytics.cycle.buckets.map(bucket => `${bucket.label} ${bucket.count} 张`).join(' / ')}`,
        `AI 交付物：${analytics.ai.artifactsAi}/${analytics.ai.artifactsTotal} 件由专家登记（${Math.round(analytics.ai.aiShare * 100)}%），其中 ${Math.round(analytics.ai.acceptedRate * 100)}% 已被人验收；缺正文 ${analytics.ai.emptyBody} 件`,
        `AI Coding：${analytics.ai.codingTasks} 张卡有执行记录，评审通过 ${analytics.ai.codingApproved} 张、要求修改 ${analytics.ai.codingChanges} 张、已合并 ${analytics.ai.merged} 张；单测 ${analytics.ai.unitPassed}/${analytics.ai.unitTests}`,
        `列停留（平均）：${analytics.columns.filter(column => column.cards > 0).map(column => `${column.label} ${column.avgDays.toFixed(1)} 天`).join(' / ')}`,
      ]
      if (analytics.rework.worst.length > 0) {
        lines.push(`返工最多的卡：${analytics.rework.worst.map(item => `${item.code || item.id}（倒退 ${item.backward} 次）`).join('；')}`)
      }
      return lines.join('\n')
    },
  }))

  register(defineStudioTool({
    name: 'studio_task_artifact',
    description: 'Register or update a deliverable on a task: the design doc, the MR, the test report, the release note. Every stage must leave something the next person can open and check.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      action: { type: 'string', description: 'add | update | remove (default add)' },
      artifactId: { type: 'string', description: 'Required for update / remove.' },
      kind: { type: 'string', description: `requirement | design | mr | cases | report | release | doc | screenshot | other` },
      title: { type: 'string', description: 'What this deliverable is.' },
      ref: { type: 'string', description: 'Path or URL (e.g. ~/dsh-workspace/docs/x.md or the MR link).' },
      content: { type: 'string', description: '交付物正文（Markdown）。写到云盘文档里的就是这段；不填就只有标题和元信息。' },
      by: { type: 'string', description: '登记人：填你自己的专家名字（例如「架构师」）。看板靠它区分 AI 产出和人手工登记。' },
      sync: { type: 'boolean', description: '登记后是否立刻同步到飞书云盘（需求文件夹下的 .md 文档）。默认 true。' },
      stage: { type: 'string', description: `Which column produced it: ${STATUS_IDS.join(' / ')}` },
      status: { type: 'string', description: 'draft | delivered | accepted' },
    },
    async execute(args) {
      const action = String(args.action ?? 'add')
      const artifact = {
        kind: args.kind,
        title: args.title,
        ref: args.ref,
        content: args.content,
        stage: args.stage,
        status: args.status,
        by: String(args.by ?? 'agent'),
      }
      const task = await store.mutate(state => {
        const target = state.tasks.find(t => t.id === args.id)
        if (target === undefined) throw new Error(`no task ${args.id}`)
        if (action === 'add') {
          const created = sanitizeArtifact({ ...artifact, at: Date.now() }, target.artifacts.length)
          if (created === undefined) throw new Error('交付物至少要有标题')
          created.at = Date.now()
          target.artifacts = [...target.artifacts, created].slice(0, 40)
        } else if (action === 'remove') {
          target.artifacts = target.artifacts.filter(item => item.id !== args.artifactId)
        } else {
          target.artifacts = target.artifacts.map(item => (item.id === args.artifactId ? { ...item, ...sanitizeArtifact({ ...item, ...artifact }, 0) } : item))
        }
        target.updatedAt = Date.now()
        return target
      })
      const wanted = action === 'remove' ? [] : (task.artifacts ?? []).filter(item => args.artifactId === undefined || item.id === args.artifactId)
      if (args.sync !== false && wanted.length > 0) {
        const notes = []
        for (const item of wanted) {
          try {
            const doc = await syncArtifact(store, task.id, item.id)
            notes.push(`已归档到云盘：${doc.url}`)
          } catch (error) {
            notes.push(`归档失败：${String(error?.message ?? error).slice(0, 160)}`)
          }
        }
        return [`已更新 ${task.id} 的交付物，当前 ${task.artifacts.length} 件。`, ...notes].join('\n')
      }
      return `已更新 ${task.id} 的交付物，当前 ${task.artifacts.length} 件。`
    },
  }))

  register(defineStudioTool({
    name: 'studio_task_check',
    description: 'Tick off (or reopen) an item on the task acceptance checklist, and add new items. Do this as you actually produce each deliverable — the checklist is what "done" means.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      action: { type: 'string', description: 'toggle | add (default toggle)' },
      itemId: { type: 'string', description: 'Checklist item id (from studio_task_get).' },
      text: { type: 'string', description: 'For action=add: the item text.' },
      done: { type: 'boolean', description: 'Explicit state; omit to toggle.' },
      note: { type: 'string', description: 'Evidence: command output, file path, test result.' },
      by: { type: 'string', description: 'Who ticked it (your expert name).' },
    },
    async execute(args) {
      const action = String(args.action ?? 'toggle')
      const snapshot = await store.mutate(state => {
        const target = state.tasks.find(t => t.id === args.id)
        if (target === undefined) throw new Error(`no task ${args.id}`)
        if (action === 'add') {
          const text = String(args.text ?? '').trim().slice(0, 200)
          if (text.length === 0) throw new Error('text is required')
          target.checklist.push({ id: `c${target.checklist.length + 1}-${randomBytes(2).toString('hex')}`, text, done: false, by: '', at: 0, note: '' })
        } else {
          target.checklist = target.checklist.map(item => {
            if (item.id !== args.itemId) return item
            const done = typeof args.done === 'boolean' ? args.done : !item.done
            return { ...item, done, by: done ? String(args.by ?? 'agent') : '', at: done ? Date.now() : 0, note: String(args.note ?? item.note ?? '').slice(0, 400) }
          })
        }
        target.updatedAt = Date.now()
        return target
      })
      const task = snapshot.tasks.find(entry => entry.id === args.id)
      const done = task.checklist.filter(item => item.done).length
      return `${task.id} 验收清单 ${done}/${task.checklist.length}：\n${task.checklist.map(item => `${item.done ? '☑' : '☐'} ${item.id} ${item.text}${item.note ? `（${item.note}）` : ''}`).join('\n')}`
    },
  }))

  register(defineStudioTool({
    name: 'studio_task_coding',
    description: 'Record the AI-coding execution record on a task: which coding agent/model, which branch, the commits, the changed files, unit-test results, and the review decision. Call this when you finish implementing (dev column) and when you finish reviewing (review column) — the board shows it as the coding trail, and "done" without it is not auditable.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      action: { type: 'string', description: 'update (default) | review | merge | clear' },
      agent: { type: 'string', description: 'Coding agent you used, e.g. "claude-code", "deepseek-v4.1-flash 直接改文件".' },
      model: { type: 'string', description: 'Model name if different from the agent.' },
      branch: { type: 'string', description: 'Git branch, e.g. feat/member-points-deduct.' },
      context: { type: 'string', description: 'Which requirement baseline / technical context you worked from (file paths, design doc).' },
      commits: {
        type: 'array',
        description: 'Commits you made (newest first).',
        items: {
          type: 'object',
          properties: {
            sha: { type: 'string', description: 'Commit sha (short or full).' },
            message: { type: 'string', description: 'Commit message.' },
            files: { type: 'string', description: 'How many files changed.' },
            additions: { type: 'string', description: 'Added lines.' },
            deletions: { type: 'string', description: 'Deleted lines.' },
          },
        },
      },
      files: {
        type: 'array',
        description: 'Changed files (send the important ones if there are many).',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Repo-relative path.' },
            change: { type: 'string', description: 'added | modified | deleted' },
            additions: { type: 'string', description: 'Added lines.' },
            deletions: { type: 'string', description: 'Deleted lines.' },
          },
        },
      },
      testsTotal: { type: 'string', description: 'How many unit tests ran.' },
      testsPassed: { type: 'string', description: 'How many passed.' },
      reviewStatus: { type: 'string', description: 'For action=review: approved | changes_requested | pending' },
      reviewNote: { type: 'string', description: 'For action=review: what you checked and what still needs fixing.' },
      by: { type: 'string', description: 'Who changed it (your expert name).' },
    },
    async execute(args) {
      const action = String(args.action ?? 'update')
      const by = String(args.by ?? 'agent').slice(0, 40)
      const snapshot = await store.mutate(state => {
        const task = state.tasks.find(t => t.id === args.id)
        if (task === undefined) throw new Error(`no task ${args.id}`)
        if (action === 'clear') {
          task.coding = null
        } else if (action === 'review') {
          const base = sanitizeCoding(task.coding ?? {})
          task.coding = sanitizeCoding({
            ...base,
            review: {
              status: CODING_REVIEW_STATUS.includes(String(args.reviewStatus)) ? String(args.reviewStatus) : 'approved',
              by,
              at: Date.now(),
              note: String(args.reviewNote ?? '').slice(0, 600),
            },
          })
        } else if (action === 'merge') {
          const base = sanitizeCoding(task.coding ?? {})
          task.coding = sanitizeCoding({ ...base, mergedBy: by, mergedAt: Date.now() })
        } else {
          const patch = {}
          for (const key of ['agent', 'model', 'branch', 'context']) {
            if (args[key] !== undefined) patch[key] = String(args[key]).slice(0, key === 'context' ? 4000 : 200)
          }
          if (Array.isArray(args.commits)) patch.commits = args.commits
          if (Array.isArray(args.files)) patch.files = args.files
          if (args.testsTotal !== undefined || args.testsPassed !== undefined) {
            patch.unitTests = { total: Number(args.testsTotal) || 0, passed: Number(args.testsPassed) || 0, at: Date.now() }
          }
          task.coding = mergeCoding(task.coding ?? null, patch)
        }
        task.updatedAt = Date.now()
        return task
      })
      const task = snapshot.tasks.find(entry => entry.id === args.id)
      const summary = codingSummary(task.coding)
      return `${task.id} 执行记录：${summary === '' ? '（空）' : summary}`
    },
  }))

  register(defineStudioTool({
    name: 'studio_task_case',
    description: 'Record test cases on a task and their execution results. Test engineers write cases here before running them, then set each result to pass/fail/skip with evidence — this is the test deliverable the board shows.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      action: { type: 'string', description: 'add | update | remove (default add)' },
      cases: {
        type: 'array',
        description: 'For action=add: one or more cases.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'What you do, e.g. 用错误密码登录 5 次' },
            expected: { type: 'string', description: 'Expected result, e.g. 第 5 次返回 429 并锁定 10 分钟' },
            pointId: { type: 'string', description: 'Optional: 对应的需求功能点 id（可追溯矩阵靠它对齐）。' },
            method: { type: 'string', description: 'Optional HTTP method so the platform can run this case itself: GET | POST | PUT | PATCH | DELETE | HEAD.' },
            url: { type: 'string', description: 'Optional request path (relative to the test env baseUrl) or absolute URL on an allowed host.' },
            body: { type: 'string', description: 'Optional request body (JSON string) for POST/PUT/PATCH.' },
            expectStatus: { type: 'number', description: 'Optional expected HTTP status; 0 or omitted means any 2xx/3xx passes.' },
            expectContains: { type: 'string', description: 'Optional substring the response body must contain.' },
          },
        },
      },
      caseId: { type: 'string', description: 'For update/remove: the case id from studio_task_get.' },
      result: { type: 'string', description: 'pending | pass | fail | skip' },
      title: { type: 'string', description: 'For update: new case title.' },
      expected: { type: 'string', description: 'For update: new expected result.' },
      note: { type: 'string', description: 'Evidence or failure detail: command, output, environment.' },
      by: { type: 'string', description: 'Who recorded it (your expert name).' },
    },
    async execute(args) {
      const action = String(args.action ?? 'add')
      const by = String(args.by ?? 'agent').slice(0, 40)
      const http = args.url !== undefined && String(args.url).trim().length > 0
        ? { method: args.method, url: args.url, body: args.body, expectStatus: args.expectStatus, expectContains: args.expectContains }
        : undefined
      const snapshot = await store.mutate(state => {
        const target = state.tasks.find(t => t.id === args.id)
        if (target === undefined) throw new Error(`no task ${args.id}`)
        const list = Array.isArray(target.cases) ? target.cases : []
        if (action === 'remove') {
          target.cases = list.filter(item => item.id !== String(args.caseId ?? ''))
        } else if (action === 'update') {
          target.cases = list.map(item => {
            if (item.id !== String(args.caseId ?? '')) return item
            const merged = { ...item, by, at: Date.now() }
            if (args.result !== undefined && CASE_RESULTS.includes(String(args.result))) merged.result = String(args.result)
            if (args.title !== undefined) merged.title = String(args.title).trim().slice(0, 200) || item.title
            if (args.expected !== undefined) merged.expected = String(args.expected).trim().slice(0, 300)
            if (args.note !== undefined) merged.note = String(args.note).trim().slice(0, 400)
            if (http !== undefined) merged.http = sanitizeCaseHttp(http)
            return merged
          })
        } else {
          const raw = Array.isArray(args.cases) ? args.cases : (args.title !== undefined ? [args] : [])
          if (raw.length === 0) throw new Error('cases is required for action=add')
          for (const item of sanitizeCases(raw.map(entry => ({
            ...entry,
            http: entry.http ?? (entry.url !== undefined && String(entry.url).trim().length > 0
              ? { method: entry.method, url: entry.url, body: entry.body, expectStatus: entry.expectStatus, expectContains: entry.expectContains }
              : undefined),
            by,
            at: Date.now(),
          })))) {
            if (list.length >= 60) break
            list.push({ ...item, id: `c${list.length + 1}-${randomBytes(2).toString('hex')}` })
          }
          target.cases = list.slice(0, 60)
        }
        target.updatedAt = Date.now()
        return target
      })
      const task = snapshot.tasks.find(entry => entry.id === args.id)
      const total = task.cases.length
      const passed = task.cases.filter(item => item.result === 'pass').length
      const failed = task.cases.filter(item => item.result === 'fail').length
      return [
        `${task.id} 测试用例 ${total} 条（通过 ${passed} / 不通过 ${failed} / 未跑 ${total - passed - failed}）：`,
        ...task.cases.map(item => {
          const mark = item.result === 'pass' ? '✅' : item.result === 'fail' ? '❌' : item.result === 'skip' ? '⏭️' : '⬜'
          return `${mark} ${item.id} ${item.title}${item.expected ? `（期望：${item.expected}）` : ''}${item.note ? ` — ${item.note}` : ''}`
        }),
      ].join('\n')
    },
  }))

  register(defineStudioTool({
    name: 'studio_test_suite',
    description: 'Run the HTTP test cases for a batch of cards at once (defaults to every card in the test column). Cards run in parallel, cases inside one card run in sequence. Use it for regression before a release.',
    parameters: {
      taskIds: { type: 'string', description: 'Comma separated task ids; omit to run every card sitting in the test column.' },
      env: { type: 'string', description: 'Test env id or name; omit to use the default env.' },
      concurrency: { type: 'number', description: 'How many cards to run at once (1-8).' },
      by: { type: 'string', description: 'Who triggered the run (your expert name).' },
    },
    async execute(args) {
      const ids = typeof args.taskIds === 'string' && args.taskIds.trim() !== ''
        ? args.taskIds.split(',').map(item => item.trim()).filter(item => item !== '')
        : undefined
      const result = await runSuite(store, { taskIds: ids, env: args.env, by: String(args.by ?? 'agent'), concurrency: args.concurrency })
      const totalCases = result.tasks.reduce((sum, item) => sum + (item.total ?? 0), 0)
      const passCases = result.tasks.reduce((sum, item) => sum + (item.passed ?? 0), 0)
      const bugs = result.tasks.reduce((sum, item) => sum + (item.bugs ?? 0), 0)
      return [
        `并发 ${result.concurrency}，跑了 ${result.tasks.length} 张卡：用例 ${totalCases} 条，通过 ${passCases}，开缺陷 ${bugs} 张`,
        ...result.tasks.map(item => item.ok
          ? `- ${item.taskId}：${item.passed}/${item.total} 通过${item.failed > 0 ? `，${item.failed} 条失败` : ''}${item.bugs > 0 ? `，开缺陷 ${item.bugs} 张` : ''}`
          : `- ${item.taskId}：跑挂了——${item.error}`),
      ].join('\n')
    },
  }))

  register(defineStudioTool({
    name: 'studio_test_run',
    description: 'Run the HTTP test cases on a task for real: the platform sends the requests, compares status/body, writes the results back, records a run, and opens a bug card for every failing case. Use this instead of guessing whether the API works.',
    parameters: {
      id: { type: 'string', required: true, description: 'Test task id.' },
      caseId: { type: 'string', description: 'Run just this case; omit to run every case that has a request definition.' },
      env: { type: 'string', description: 'Test env id or name; omit to use the default env.' },
      by: { type: 'string', description: 'Who triggered the run (your expert name).' },
    },
    async execute(args) {
      const result = await runTaskCases(store, String(args.id ?? ''), {
        caseIds: args.caseId !== undefined && String(args.caseId).length > 0 ? [String(args.caseId)] : undefined,
        env: args.env,
        by: String(args.by ?? 'agent').slice(0, 40),
      })
      const run = result.run
      return [
        `环境 ${result.env.name}（${result.env.baseUrl}）：${run.total} 条，通过 ${run.passed}，不通过 ${run.failed}`,
        ...run.results.map(item => `${item.ok ? '✅' : '❌'} ${item.title}${item.status > 0 ? ` → ${item.status}` : ''}${item.error !== '' ? `：${item.error}` : ''}（${item.ms}ms）`),
        ...result.bugs.map(item => `${item.created ? '已开缺陷' : '已有缺陷'} ${item.bug}：${item.title}`),
      ].join('\n')
    },
  }))

  register(defineStudioTool({
    name: 'studio_skill_list',
    description: 'List the company skill library: every skill you can load with the skill tool. Check this before inventing a procedure, and after saving a new one.',
    parameters: {},
    async execute() {
      if (host.getActiveSkills() === undefined) throw new Error('技能库尚未就绪')
      const skills = host.getActiveSkills().list()
      if (skills.length === 0) return '技能库还是空的。可以用 studio_skill_save 把这次摸索出来的做法写成一条技能。'
      return [
        `技能库共 ${skills.length} 条（落盘在 ${host.skillsRoot()}/<名字>/SKILL.md）：`,
        ...skills.map(skill => `- ${skill.name}${skill.enabled === false ? '（已停用）' : ''}：${skill.description}${skill.tags.length > 0 ? `  [${skill.tags.join('/')}]` : ''}`),
      ].join('\n')
    },
  }))

  register(defineStudioTool({
    name: 'studio_skill_get',
    description: 'Read one skill body in full (the same text the skill tool would load).',
    parameters: { name: { type: 'string', required: true, description: 'Skill name, kebab-case.' } },
    async execute(args) {
      if (host.getActiveSkills() === undefined) throw new Error('技能库尚未就绪')
      const skill = host.getActiveSkills().get(String(args.name ?? ''))
      if (skill === undefined) throw new Error(`no skill ${args.name}`)
      return `# ${skill.name}\n\n${skill.description}\n\n${skill.content}`
    },
  }))

  register(defineStudioTool({
    name: 'studio_skill_save',
    description: 'Create or update a skill in the company library. Saving writes ~/.dsh/skills/<name>/SKILL.md, so every agent can load it with the skill tool from the next session on. Use it to keep hard-won procedures instead of rediscovering them.',
    parameters: {
      name: { type: 'string', required: true, description: 'Kebab-case skill name, e.g. gitlab-mr-review.' },
      description: { type: 'string', required: true, description: 'One line: when should an agent load this?' },
      content: { type: 'string', required: true, description: 'Markdown body: the actual procedure, commands and pitfalls.' },
      whenToUse: { type: 'string', description: 'Extra routing guidance, e.g. 收到 MR 评审任务时。' },
      tags: { type: 'array', items: { type: 'string' }, description: 'A few tags: gitlab / review / feishu …' },
    },
    async execute(args) {
      if (host.getActiveSkills() === undefined) throw new Error('技能库尚未就绪')
      const { skill, file } = await host.getActiveSkills().save(args)
      return `已保存技能 ${skill.name}${file === undefined ? '（已停用，未落盘）' : `，已写入 ${file}`}`
    },
  }))

  register(defineStudioTool({
    name: 'studio_skill_delete',
    description: 'Remove a skill from the company library and from disk. Only do this when the skill is obsolete or wrong — prefer fixing it with studio_skill_save.',
    parameters: { name: { type: 'string', required: true, description: 'Skill name.' } },
    async execute(args) {
      if (host.getActiveSkills() === undefined) throw new Error('技能库尚未就绪')
      const { name } = await host.getActiveSkills().remove(String(args.name ?? ''))
      return `已删除技能 ${name}`
    },
  }))

  return disposers
}
