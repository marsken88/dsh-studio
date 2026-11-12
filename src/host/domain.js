/**
 * dsh-studio — domain layer.
 *
 * Board columns, card / requirement / release shapes, their sanitizers, the
 * default settings, and the code-number generators. Pure data and validation:
 * no filesystem, no host services, no HTTP. Everything here is unit-testable.
 *
 * @module dsh-studio/src/host/domain
 */
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Board columns, in render order. */
export const STATUSES = [
  { id: 'clarify', label: '待澄清', role: 'product' },
  { id: 'design', label: '待方案', role: 'architect' },
  { id: 'dev_ready', label: '待开发', role: 'dev' },
  { id: 'dev', label: '开发中', role: 'dev' },
  { id: 'review', label: '待评审', role: 'architect' },
  { id: 'test', label: '待测试', role: 'qa' },
  { id: 'accept', label: '待验收', role: 'product' },
  { id: 'done', label: '已完成', role: 'product' },
]

/** 阻塞不是车道，是卡上的一个标记：卡留在原列，等人决定怎么继续。 */
export const LEGACY_BLOCKED_STATUS = 'blocked'

export const STATUS_IDS = STATUSES.map(s => s.id)
/** 解析时接受历史数据里的 blocked，但它永远不会被当成一列渲染。 */
export const STATUS_SET = new Set([...STATUS_IDS, LEGACY_BLOCKED_STATUS])
export const ROLE_IDS = ['product', 'architect', 'dev', 'qa']
export const PRIORITIES = ['urgent', 'normal', 'relaxed']
/** 卡片类型：需求与缺陷走同一条流水线，但派单提示词和默认落列不同。 */
export const TASK_TYPES = ['requirement', 'bug', 'design', 'dev', 'test', 'ops']
/** 缺陷严重级别，P0 最高。 */
export const SEVERITIES = ['p0', 'p1', 'p2', 'p3']

/** 交付物的种类：一张卡干完，得留下能给人看的东西。 */
export const ARTIFACT_KINDS = ['requirement', 'design', 'mr', 'cases', 'report', 'release', 'doc', 'screenshot', 'other']
/** 交付物状态：draft 草稿 / delivered 已交付 / accepted 已验收。 */
export const ARTIFACT_STATUS = ['draft', 'delivered', 'accepted']

/**
 * 沙箱档位来自 DSH 的 permission preset（read-only / workspace-write /
 * danger-full-access），是操作系统级边界：卡会话能写哪、能跑什么。
 */
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access']
/** 隔离档位：一卡一会话，是否再给一张卡一个独立的 git worktree。 */
export const ISOLATION_MODES = ['none', 'worktree']

/**
 * 成员角色：管理员能改配置与删除，成员能推进卡，只读只能看。
 * 没启用成员权限时所有人按管理员算（向后兼容单机用法）。
 */
export const ACCESS_ROLES = ['admin', 'member', 'viewer']
export const ACCESS_ROLE_LABEL = { admin: '管理员', member: '成员', viewer: '只读' }
export const ROLE_LEVEL = { viewer: 0, member: 1, admin: 2 }
export const LEVEL_RANK = { read: 0, write: 1, admin: 2 }

/** 只有管理员能碰的动作：改全局配置、删东西、发布/回滚、装插件。 */
export const ADMIN_ROUTES = new Set([
  '/config', '/access/save', '/access/delete',
  '/task/delete', '/experts/delete', '/teams/delete', '/skills/delete',
  '/projects/delete', '/repos/delete', '/bots/delete', '/requirement/delete',
  '/release/delete', '/release/approve', '/release/publish', '/release/rollback',
  '/market/install', '/market/uninstall', '/audit/clear', '/snapshot/restore',
])

/**
 * 需求（REQ）是整个交付链路的锚点：卡、产物、用例、缺陷、MR、发布都挂在它下面。
 * 需求一旦「active」，下游每小时都在拿它当唯一真相，所以它自己也要有状态机。
 */
export const REQ_STATUSES = ['draft', 'review', 'active', 'delivered', 'closed']
export const REQ_STATUS_LABEL = { draft: '草稿', review: '待评审', active: '进行中', delivered: '已交付', closed: '已关闭' }
/** 需求评审结论：提交评审 → 通过 / 打回。 */
export const REQ_REVIEW_STATUS = ['pending', 'approved', 'changes_requested']
export const REQ_REVIEW_LABEL = { pending: '待评审', approved: '已通过', changes_requested: '已打回' }
/** 卡片编号前缀：同一需求下 DEV-001、TEST-001、BUG-001 各自递增。 */
export const CODE_PREFIX = { requirement: 'REQ', design: 'DES', dev: 'DEV', test: 'TEST', bug: 'BUG', ops: 'OPS' }

/** 每种卡片默认要交什么，建卡时铺成验收清单（可在设置里改）。 */
export function defaultTemplates() {
  return {
    requirement: ['需求说明写清楚背景、目标与边界', '验收标准可逐条验证', '影响范围与数据口径说明'],
    design: ['技术方案（含接口与数据改动）', '改动边界与回滚方案', '风险与依赖列清楚'],
    dev: ['代码已提交并提 MR', '自测通过（附命令与结果）', '必要文档与注释已更新'],
    review: ['MR 已关联到这张卡', '改动说明与影响范围写清楚', '评审意见已处理或明确记录'],
    test: ['测试用例覆盖主流程与边界', '执行记录（环境、版本、结果）', '缺陷已登记、复现步骤齐全'],
    bug: ['复现步骤与影响面', '根因定位结论', '修复验证与回归点'],
    ops: ['变更步骤与回滚预案', '执行记录', '监控与告警确认'],
  }
}

// 卡上 agent 的兜底模型：宿主默认型号可能没有可用通道（deepseek-v4-pro 会 503），
// 所以不配模型时一律落到这个可用的默认值。
export const FALLBACK_AGENT_MODEL = 'deepseek-v4.1-flash'

/** The four shipped personas; also the seed for a fresh expert roster. */
export const DEFAULT_ROLES = {
  product: {
    label: '产品',
    name: '产品经理',
    emoji: '📋',
    model: 'deepseek-v4.1-flash',
    brief: '把模糊需求变成清晰的需求说明、边界与验收标准。',
    prompt: [
      '你是产品经理，负责把一句话的诉求变成能开工的需求。',
      '动手前先读：需求页上的 PRD/原型文档、同一需求下已有的卡与评论、相关领域的历史卡。信息不足就明确列出「需要业务确认的问题」，不要自己编业务规则。',
      '产出必须包含：目标用户与场景、主流程、异常与边界、业务规则（含参数与阈值）、验收口径（可判定的条件）。',
      '需求要拆成功能点（每个功能点带验收条件），一条功能点对应一张或几张可交付的卡。',
      '不确定优先级时按「影响客户/影响金额/上线时间」排序并写明理由。',
      '收口前自检：卡上的验收清单是否可验证、是否留了交付物（文档正文）、是否需要找架构师确认技术可行性（要就 @架构师）。',
    ].join('\n'),
  },
  architect: {
    label: '架构',
    name: '架构师',
    emoji: '🏛️',
    model: 'deepseek-v4.1-flash',
    brief: '出技术方案、拆任务、定接口与改动边界。',
    prompt: [
      '你是架构师，负责技术方案、接口契约与改动边界。',
      '先读现有代码与配置再下判断：用 ls/grep 找到相关模块、看已有约定，不要凭空设计。',
      '方案必须给出：数据模型与迁移方式、接口契约（路径/入参/出参/错误码）、失败与回滚、并发与幂等、性能与容量估算、兼容性与灰度策略。',
      '把方案拆成研发可以直接开工的步骤，每步写清改哪些文件、怎么自验。',
      '明确列出「不做/遗留」的边界，以及需要业务或研发确认的风险点。',
      '评审别人的 MR 时按「正确性→边界与异常→可读性与一致性→性能」四层给结论；要求修改必须给出可执行的修改点。',
    ].join('\n'),
  },
  dev: {
    label: '研发',
    name: '开发工程师',
    emoji: '🛠️',
    model: 'deepseek-v4.1-flash',
    brief: '按方案实现代码，自己先跑通，交可验证的改动。',
    prompt: [
      '你是开发工程师，负责把方案落成可验证的代码。',
      '在卡专属的 worktree/目录里工作，只改这张卡需要的文件；动手前先看你将要改的函数和它被谁调用。',
      '改动要小步：先跑通最小路径，再补异常分支；不顺手重构无关代码，不引入未评估的依赖。',
      '自验：能跑测试就跑测试，把命令与结果贴进评论；跑不了就写清为什么没跑、需要谁在什么环境验证。',
      '必须用 studio_task_coding 登记执行记录（Coding Agent、模型、分支、提交、改动文件、单测通过数），再用 studio_task_artifact 登记交付物（带正文）。',
      '推卡前自检验收清单，逐条勾并附证据；做不到的项不要勾，直接说明卡在哪并 studio_task_block 写清原因。',
    ].join('\n'),
  },
  qa: {
    label: '测试',
    name: '测试工程师',
    emoji: '🧪',
    model: 'deepseek-v4.1-flash',
    brief: '设计用例、执行验证、给出可复现的缺陷与结论。',
    prompt: [
      '你是测试工程师，负责验证交付是否真的可用。',
      '用例来源：需求的验收条件、功能点的验收口径、上一次缺陷的复现路径。每个功能点至少覆盖正常流、边界值、异常流；接口类用例写成可执行的请求（method/url/期望状态码/期望响应片段），并用 studio_test_run 真跑。',
      '结果只写实测：通过写实际状态码与关键字段，失败写请求、响应、期望与实际、可复现步骤。',
      '判失败就如实判：平台会自动开缺陷卡并挂回这张卡，不要手工再建一张重复的。',
      '不稳定（环境/数据导致）的用例标 flaky，不要为了绿灯把断言改松；真的缺陷不许标 flaky。',
      '测试结论要给出准出建议：通过哪些、遗留哪些风险、是否建议发布。',
    ].join('\n'),
  },
}

/** Column → who owns the work when a card lands there. */
export function defaultColumns() {
  return {
    // 待澄清没有默认负责人：需求/缺陷的类型不同，交给谁由人来定（设置里可改）。
    clarify: { kind: 'none', id: '' },
    design: { kind: 'expert', id: 'architect' },
    dev_ready: { kind: 'expert', id: 'dev' },
    dev: { kind: 'expert', id: 'dev' },
    review: { kind: 'expert', id: 'architect' },
    test: { kind: 'expert', id: 'qa' },
    accept: { kind: 'expert', id: 'product' },
    done: { kind: 'expert', id: 'product' },
  }
}

/** The four shipped experts, used until the company edits them. */
export function seedExperts(roles) {
  return ROLE_IDS.map(role => {
    const seed = DEFAULT_ROLES[role]
    return {
      id: role,
      name: roles?.[role]?.label !== undefined && roles[role].label !== DEFAULT_ROLES[role].label
        ? String(roles[role].label)
        : seed.name,
      emoji: seed.emoji,
      role,
      domain: '',
      skills: [],
      description: seed.brief,
      prompt: String(roles?.[role]?.prompt ?? '') || String(seed.prompt ?? ''),
      model: String(roles?.[role]?.model ?? seed.model),
      preset: '',
      enabled: true,
    }
  })
}

/** Fresh default settings. */
export function defaultConfig() {
  return {
    schema: 6,
    board: { title: '需求&任务工作空间' },
    experts: seedExperts(DEFAULT_ROLES),
    teams: [],
    columns: defaultColumns(),
    /** 业务项目：一个项目可以盯多个 GitLab 仓库，里面按迭代分组卡片。 */
    projects: [],
    /** 每种卡片的默认验收清单模板。 */
    templates: defaultTemplates(),
    gitlab: { url: '', token: '', group: '', project: '', syncEnabled: false, syncLabel: '', lastSyncAt: 0, lastSyncError: '', projects: [] },
    feishu: { appId: '', appSecret: '', chatId: '', baseToken: '', tableId: '', webhook: '', notifyOnChange: true, bots: [], driveFolder: 'IuJPfTCtWlDrzwdCFmLc71aynbg', autoSyncArtifacts: true, escalateWebhook: '', escalateAfter: 3 },
    /** 成本闸门：只统计「跑了多少次、花了多少机上时间」，宿主没把 token 用量回传给插件。 */
    costs: { budgetRuns: 500, budgetHours: 80, warnAt: 80 },
    roles: {
      product: { label: '产品', model: 'deepseek-v4.1-flash', prompt: '' },
      architect: { label: '架构', model: 'deepseek-v4.1-flash', prompt: '' },
      dev: { label: '研发', model: 'deepseek-v4.1-flash', prompt: '' },
      qa: { label: '测试', model: 'deepseek-v4.1-flash', prompt: '' },
    },
    /** The company catalogue: entries are npm specs or local bundle paths. */
    market: { title: '公司内部市场', items: [] },
    /** Automatic hand-off of a card to its role agent when it enters a column. */
    agents: {
      enabled: false,
      maxConcurrent: 2,
      workspaceDir: '',
      /** Agent preset that gives the card session its real tools (shell, fs). */
      agentPreset: 'standard',
      autoStatuses: ['design', 'dev_ready', 'test'],
      /** 沙箱：卡会话的操作系统级文件/命令边界（DSH 的 permission preset）。 */
      sandbox: 'workspace-write',
      /** 隔离：none = 所有卡共用 workspaceDir；worktree = 每张卡一个 git worktree。 */
      isolation: 'none',
      worktreeRoot: '',
      /** on_done = 卡进「已完成」时回收 worktree；manual = 留着等人看。 */
      cleanupWorktree: 'manual',
      /** AI 失败重试：失败后按 baseMs × factor^n 退避，超过 max 次升级成人处理。 */
      retry: { max: 2, baseMs: 60000, factor: 2 },
    },
    /** 发布准入：需要的话可以要求「上过预发」「需求签过字」才能发布。 */
    releaseRules: { requireStaging: false, requireRequirementSignoff: false },
    /** 测试执行：接口测试用（环境、超时、允许打的域名）。 */
    testing: {
      envs: [],
      defaultEnv: '',
      timeoutMs: 15000,
      allowHosts: ['127.0.0.1', 'localhost'],
      concurrency: 4,
    },
    /** 权限：启用成员名单后，写操作要认人，删除/配置/发布要管理员。 */
    access: { enabled: false, members: [] },
    /** 缺陷 SLA：按严重级别给小时数，超时在卡上看红点。 */
    sla: { p0: 4, p1: 24, p2: 72, p3: 168 },
    /** 部署环境：只用来登记「哪个版本上过哪个环境」，平台不触发部署。 */
    environments: defaultDeployEnvs(),
    /** 统一登录：LDAP。bindPassword 只进密钥文件，落库时清空。 */
    ldap: {
      enabled: false,
      url: 'ldap://ldap.laiyifen.com:389',
      baseDN: 'DC=LYF,DC=COM',
      bindDN: 'cn=root',
      bindPassword: '',
      userFilter: '(|(sAMAccountName={user})(uid={user})(mail={user}))',
      nameAttr: 'displayName',
      mailAttr: 'mail',
      deptAttr: 'department',
      defaultRole: 'member',
      requireLogin: false,
      timeoutMs: 6000,
    },
    /**
     * 本地超管账号：没配 LDAP 时平台直接以它身份使用（不要求登录），
     * 配了 LDAP 也能用它兜底。password 为 null 表示「还是默认口令 admin」。
     */
    localAuth: { enabled: true, username: 'admin', password: null, mustChange: true, updatedAt: 0 },
    /** 登录过的人（LDAP 身份 + 最近登录情况），用于归属与审计。 */
    users: [],
  }
}

/** LDAP 设置：只收白名单字段，URL 必须是 ldap(s)://，过滤器里的 {user} 由调用方替换。 */
export function sanitizeLdap(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const url = String(input.url ?? '').trim().slice(0, 200)
  const baseDN = String(input.baseDN ?? '').trim().slice(0, 200)
  const bindDN = String(input.bindDN ?? '').trim().slice(0, 200)
  const filterRaw = String(input.userFilter ?? '').trim().slice(0, 300)
  const userFilter = filterRaw.includes('{user}') ? filterRaw : '(|(sAMAccountName={user})(uid={user})(mail={user}))'
  const timeout = Number(input.timeoutMs)
  return {
    enabled: input.enabled === true,
    url: /^ldaps?:\/\/[^\s]+$/i.test(url) ? url : 'ldap://ldap.laiyifen.com:389',
    baseDN: baseDN === '' ? 'DC=LYF,DC=COM' : baseDN,
    bindDN: bindDN === '' ? 'cn=root' : bindDN,
    bindPassword: String(input.bindPassword ?? '').trim().slice(0, 200),
    userFilter,
    nameAttr: String(input.nameAttr ?? 'displayName').trim().slice(0, 60) || 'displayName',
    mailAttr: String(input.mailAttr ?? 'mail').trim().slice(0, 60) || 'mail',
    deptAttr: String(input.deptAttr ?? 'department').trim().slice(0, 60) || 'department',
    defaultRole: ACCESS_ROLES.includes(input.defaultRole) ? input.defaultRole : 'member',
    requireLogin: input.requireLogin === true,
    timeoutMs: Number.isFinite(timeout) ? Math.max(1000, Math.min(Math.round(timeout), 30000)) : 6000,
  }
}

/** 本地超管：默认账号 admin、默认口令 admin；口令用 scrypt + 随机盐存，不落明文。 */
export const LOCAL_DEFAULT_PASSWORD = 'admin'

export function sanitizeLocalAuth(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const username = String(input.username ?? 'admin').trim().toLowerCase().slice(0, 40) || 'admin'
  const stored = input.password !== null && typeof input.password === 'object' ? input.password : null
  const password =
    stored !== null && typeof stored.salt === 'string' && typeof stored.hash === 'string'
      ? { salt: String(stored.salt).slice(0, 64), hash: String(stored.hash).slice(0, 256), at: Number(stored.at) || 0 }
      : null
  return {
    enabled: input.enabled !== false,
    username,
    password,
    mustChange: password === null ? true : input.mustChange === true,
    updatedAt: Number(input.updatedAt) || 0,
  }
}

export function hashLocalPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(String(password), salt, 64).toString('hex')
  return { salt, hash, at: Date.now() }
}

/** 校验本地超管：用户名大小写不敏感；没设过口令时比对默认口令。 */
export function verifyLocalPassword(localAuth, username, password) {
  const local = sanitizeLocalAuth(localAuth)
  if (local.enabled !== true) return { ok: false, reason: 'disabled' }
  if (String(username ?? '').trim().toLowerCase() !== local.username) return { ok: false, reason: 'nouser' }
  const given = String(password ?? '')
  if (local.password === null) {
    return { ok: given === LOCAL_DEFAULT_PASSWORD, reason: given === LOCAL_DEFAULT_PASSWORD ? '' : 'badpass' }
  }
  const hash = scryptSync(given, local.password.salt, 64).toString('hex')
  const stored = Buffer.from(local.password.hash, 'hex')
  const computed = Buffer.from(hash, 'hex')
  const ok = stored.length === computed.length && timingSafeEqual(stored, computed)
  return { ok, reason: ok ? '' : 'badpass' }
}

/** 登录过的人：最多 500 条，id 统一小写，按最近登录排序。 */
export function sanitizeUsers(raw) {
  const list = Array.isArray(raw) ? raw : []
  const out = []
  const seen = new Set()
  for (const item of list) {
    if (out.length >= 500) break
    if (item === null || typeof item !== 'object') continue
    const id = String(item.id ?? item.name ?? '').trim().toLowerCase().slice(0, 80)
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name: String(item.name ?? id).trim().slice(0, 80) || id,
      mail: String(item.mail ?? '').trim().slice(0, 160),
      dept: String(item.dept ?? '').trim().slice(0, 120),
      dn: String(item.dn ?? '').trim().slice(0, 400),
      role: ACCESS_ROLES.includes(item.role) ? item.role : 'member',
      source: item.source === 'ldap' ? 'ldap' : 'local',
      firstLoginAt: Number(item.firstLoginAt) || 0,
      lastLoginAt: Number(item.lastLoginAt) || 0,
      loginCount: Math.max(0, Math.round(Number(item.loginCount) || 0)),
      lastIp: String(item.lastIp ?? '').trim().slice(0, 60),
    })
  }
  return out.sort((a, b) => b.lastLoginAt - a.lastLoginAt)
}

/** Shallow-merge one section of a saved settings object over the defaults. */
export function mergeSection(defaults, saved) {
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return defaults
  const out = { ...defaults }
  for (const key of Object.keys(defaults)) {
    const value = saved[key]
    if (value === undefined || value === null) continue
    if (typeof defaults[key] === 'object' && !Array.isArray(defaults[key])) {
      out[key] = mergeSection(defaults[key], value)
    } else if (typeof value === typeof defaults[key]) {
      out[key] = value
    }
  }
  return out
}

/** Merge a whole saved config over the defaults. */
export function mergeConfig(saved) {
  const base = defaultConfig()
  if (saved === null || typeof saved !== 'object') return base
  const experts = sanitizeExperts(saved.experts)
  const roster = experts.length > 0 ? experts : base.experts
  const gitlab = { ...mergeSection(base.gitlab, saved.gitlab), projects: sanitizeProjects(saved.gitlab?.projects) }
  const feishu = { ...mergeSection(base.feishu, saved.feishu), bots: sanitizeBots(saved.feishu?.bots) }
  // A settings file written before multi-project/multi-bot support carries the
  // single connection in the legacy fields; fold it into the new lists once.
  if (gitlab.projects.length === 0 && gitlab.project.length > 0) {
    gitlab.projects.push({
      id: 'default',
      name: gitlab.project.split('/').pop() ?? gitlab.project,
      url: gitlab.url,
      project: gitlab.project,
      token: '',
      group: gitlab.group,
      syncEnabled: gitlab.syncEnabled,
      syncLabel: gitlab.syncLabel,
      lastSyncAt: gitlab.lastSyncAt,
      lastSyncError: gitlab.lastSyncError,
    })
  }
  if (feishu.bots.length === 0 && feishu.webhook.length > 0) {
    feishu.bots.push({ id: 'default', name: '默认群', webhook: feishu.webhook, chatId: feishu.chatId, notifyOnChange: feishu.notifyOnChange, enabled: true })
  }
  return {
    schema: Number.isInteger(saved.schema) ? saved.schema : 1,
    board: mergeSection(base.board, saved.board),
    experts: roster,
    teams: sanitizeTeams(saved.teams, roster),
    columns: sanitizeColumns(saved.columns, roster, sanitizeTeams(saved.teams, roster)),
    projects: sanitizeWorkProjects(saved.projects),
    templates: sanitizeTemplates(saved.templates),
    gitlab,
    feishu,
    roles: mergeSection(base.roles, saved.roles),
    market: mergeSection(base.market, saved.market),
    agents: mergeSection(base.agents, saved.agents),
    testing: sanitizeTesting(saved.testing),
    access: sanitizeAccess(saved.access),
    sla: sanitizeSla(saved.sla),
    costs: sanitizeCosts(saved.costs),
    environments: (() => {
      const list = sanitizeDeployEnvs(saved.environments)
      return list.length > 0 ? list : defaultDeployEnvs()
    })(),
    releaseRules: mergeSection(base.releaseRules, saved.releaseRules),
    ldap: sanitizeLdap(saved.ldap),
    localAuth: sanitizeLocalAuth(saved.localAuth),
    users: sanitizeUsers(saved.users),
  }
}

/** 缺陷 SLA：每个严重级别给一个修复时限（小时）。 */
export function sanitizeSla(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const out = { p0: 4, p1: 24, p2: 72, p3: 168 }
  for (const key of Object.keys(out)) {
    const value = Number(input[key])
    if (Number.isFinite(value) && value > 0) out[key] = Math.min(Math.round(value), 24 * 60)
  }
  return out
}

/** 成本预算：跑多少轮、机上多少小时，超过 warnAt% 就在界面标黄。 */
export function sanitizeCosts(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const budgetRuns = Number(input.budgetRuns)
  const budgetHours = Number(input.budgetHours)
  const warnAt = Number(input.warnAt)
  return {
    budgetRuns: Number.isFinite(budgetRuns) && budgetRuns > 0 ? Math.min(Math.round(budgetRuns), 100000) : 500,
    budgetHours: Number.isFinite(budgetHours) && budgetHours > 0 ? Math.min(Math.round(budgetHours), 100000) : 80,
    warnAt: Number.isFinite(warnAt) && warnAt > 0 ? Math.max(10, Math.min(Math.round(warnAt), 100)) : 80,
  }
}
export function cleanId(value, prefix) {
  const text = String(value ?? '').trim()
  const ascii = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  // 太短的 slug（比如中文名里只剩一个「2」）当 id 既难看又容易撞，干脆走哈希。
  if (ascii.length >= 3) return ascii.slice(0, 40)
  // 纯中文（或其它非 ASCII）名字没法拼 slug：用名字的哈希做后缀，
  // 保证「用同一个名字再保存一次」命中的是同一条，而不是又新建一条。
  if (text.length > 0) return `${prefix}-${createHash('sha1').update(text).digest('hex').slice(0, 8)}`
  return `${prefix}-${randomBytes(3).toString('hex')}`
}

/** Coerce whatever is in the settings file into a valid expert roster. */
export function sanitizeExperts(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const raw of input.slice(0, 80)) {
    if (raw === null || typeof raw !== 'object') continue
    const id = cleanId(raw.id ?? raw.name, 'expert')
    if (seen.has(id)) continue
    seen.add(id)
    const name = String(raw.name ?? id).trim().slice(0, 40) || id
    out.push({
      id,
      name,
      emoji: String(raw.emoji ?? '🤖').trim().slice(0, 4) || '🤖',
      role: ROLE_IDS.includes(String(raw.role ?? '')) ? String(raw.role) : (ROLE_IDS.includes(id) ? id : ''),
      domain: String(raw.domain ?? '').trim().slice(0, 40),
      description: String(raw.description ?? '').slice(0, 600),
      prompt: String(raw.prompt ?? '').slice(0, 8000),
      /** 提示词指纹：改了角色提示词，历史派单能看出当时用的是哪一版。 */
      promptVersion: createHash('sha1').update(String(raw.prompt ?? '')).digest('hex').slice(0, 8),
      skills: (Array.isArray(raw.skills) ? raw.skills : String(raw.skills ?? '').split(/[,，\s]+/))
        .map(skill => String(skill ?? '').trim().slice(0, 60))
        .filter(skill => skill.length > 0)
        .filter((skill, index, all) => all.indexOf(skill) === index)
        .slice(0, 12),
      model: String(raw.model ?? '').trim().slice(0, 120),
      preset: String(raw.preset ?? '').trim().slice(0, 80),
      /** 该专家自己的沙箱档位；空 = 跟随「设置 → 自动派单」的全局档位。 */
      sandbox: SANDBOX_MODES.includes(String(raw.sandbox ?? '')) ? String(raw.sandbox) : '',
      enabled: raw.enabled !== false,
    })
  }
  return out
}

/** Teams reference experts by id; unknown members are dropped. */
export function sanitizeTeams(input, experts) {
  if (!Array.isArray(input)) return []
  const known = new Set(experts.map(expert => expert.id))
  const seen = new Set()
  const out = []
  for (const raw of input.slice(0, 40)) {
    if (raw === null || typeof raw !== 'object') continue
    const id = cleanId(raw.id ?? raw.name, 'team')
    if (seen.has(id)) continue
    seen.add(id)
    const members = (Array.isArray(raw.members) ? raw.members : [])
      .map(member => cleanId(member, 'expert'))
      .filter(member => known.has(member))
      .filter((member, index, all) => all.indexOf(member) === index)
      .slice(0, 12)
    const lead = cleanId(raw.lead ?? members[0] ?? '', 'expert')
    out.push({
      id,
      name: String(raw.name ?? id).trim().slice(0, 40) || id,
      emoji: String(raw.emoji ?? '👥').trim().slice(0, 4) || '👥',
      description: String(raw.description ?? '').slice(0, 600),
      members,
      lead: members.includes(lead) ? lead : (members[0] ?? ''),
      enabled: raw.enabled !== false,
    })
  }
  return out
}

/** Column owners, validated against the roster. Unknown columns are ignored. */
export function sanitizeColumns(input, experts, teams) {
  const base = defaultColumns()
  const out = { ...base }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return out
  const expertIds = new Set(experts.map(expert => expert.id))
  const teamIds = new Set(teams.map(team => team.id))
  for (const status of STATUS_IDS) {
    const raw = input[status]
    if (raw === null || typeof raw !== 'object') continue
    // 候选池：一列可以挂多个人，进来时按策略挑一个。
    if (Array.isArray(raw.members)) {
      const members = []
      const seen = new Set()
      for (const entry of raw.members.slice(0, 12)) {
        if (entry === null || typeof entry !== 'object') continue
        // 候选池里可以写「角色位」（product/architect/dev/qa）：派单时按卡的业务领域
        // 解析成对应的领域专家；也可以写具体专家或专家团。
        const kind = entry.kind === 'team' ? 'team' : entry.kind === 'role' ? 'role' : 'expert'
        const id = String(entry.id ?? '').trim()
        if (kind === 'role' ? !ROLE_IDS.includes(id) : kind === 'team' ? !teamIds.has(id) : !expertIds.has(id)) continue
        const key = `${kind}:${id}`
        if (seen.has(key)) continue
        seen.add(key)
        members.push({ kind, id })
      }
      if (members.length > 0) {
        out[status] = { kind: 'pool', id: '', members, strategy: normalizeStrategy(raw.strategy) }
        continue
      }
    }
    const kind = raw.kind === 'team' ? 'team' : raw.kind === 'none' ? 'none' : raw.kind === 'role' ? 'role' : 'expert'
    if (kind === 'none') { out[status] = { kind: 'none', id: '' }; continue }
    const id = String(raw.id ?? raw.role ?? '').trim()
    if (kind === 'role' && ROLE_IDS.includes(id)) out[status] = { kind: 'role', id, ...(out[status]?.wip !== undefined ? { wip: out[status].wip } : {}) }
    else if (kind === 'team' && teamIds.has(id)) out[status] = { kind: 'team', id }
    else if (kind === 'expert' && expertIds.has(id)) out[status] = { kind: 'expert', id }
  }
  /* 每列的 WIP 上限：0 表示不限；超出只提示，不阻止推进。 */
  for (const status of STATUS_IDS) {
    const raw = input[status]
    if (raw === null || typeof raw !== 'object') continue
    const wip = Number(raw.wip)
    if (Number.isFinite(wip) && out[status] !== undefined) out[status].wip = Math.min(50, Math.max(0, Math.trunc(wip)))
  }
  return out
}

/** 候选池的分派策略。 */
export const COLUMN_STRATEGIES = ['round_robin', 'best_match', 'lead']
export function normalizeStrategy(value) {
  return COLUMN_STRATEGIES.includes(value) ? value : 'round_robin'
}

/** GitLab connections: one per repository the board watches. */
export function sanitizeProjects(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const raw of input.slice(0, 40)) {
    if (raw === null || typeof raw !== 'object') continue
    const id = cleanId(raw.id ?? raw.project ?? raw.name, 'repo')
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name: String(raw.name ?? raw.project ?? id).trim().slice(0, 80) || id,
      url: String(raw.url ?? '').trim().slice(0, 500),
      project: String(raw.project ?? '').trim().slice(0, 300),
      group: String(raw.group ?? '').trim().slice(0, 300),
      token: String(raw.token ?? '').trim().slice(0, 400),
      syncEnabled: raw.syncEnabled === true,
      syncLabel: String(raw.syncLabel ?? '').trim().slice(0, 100),
      lastSyncAt: Number(raw.lastSyncAt) || 0,
      lastSyncError: String(raw.lastSyncError ?? '').slice(0, 300),
    })
  }
  return out
}

/** Feishu custom-bot webhooks: one card change can notify several groups. */
export function sanitizeBots(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const raw of input.slice(0, 40)) {
    if (raw === null || typeof raw !== 'object') continue
    const id = cleanId(raw.id ?? raw.name, 'bot')
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name: String(raw.name ?? id).trim().slice(0, 60) || id,
      webhook: String(raw.webhook ?? '').trim().slice(0, 500),
      chatId: String(raw.chatId ?? '').trim().slice(0, 200),
      notifyOnChange: raw.notifyOnChange !== false,
      enabled: raw.enabled !== false,
    })
  }
  return out
}

// ------------------------------------------------- 项目 / 迭代 / 交付物 / 清单

/** 迭代（里程碑）：一个项目里的排期单位。 */
export function sanitizeIterations(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const raw of input.slice(0, 60)) {
    if (raw === null || typeof raw !== 'object') continue
    const id = cleanId(raw.id ?? raw.name, 'iter')
    if (seen.has(id)) continue
    seen.add(id)
    const status = ['planned', 'active', 'closed'].includes(String(raw.status)) ? String(raw.status) : 'planned'
    out.push({
      id,
      name: String(raw.name ?? id).trim().slice(0, 60) || id,
      start: Number(raw.start) || 0,
      due: Number(raw.due) || 0,
      status,
    })
  }
  return out
}

/** 业务项目：卡片挂项目，项目盯一个或多个 GitLab 仓库。 */
export function sanitizeServices(raw, legacyPath) {
  const out = []
  const seen = new Set()
  const list = Array.isArray(raw) ? raw : []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const id = cleanId(item.id ?? item.name, 'svc')
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name: String(item.name ?? id).trim().slice(0, 80) || id,
      repoId: String(item.repoId ?? '').trim().slice(0, 60),
      repoPath: String(item.repoPath ?? '').trim().slice(0, 400),
      baseBranch: String(item.baseBranch ?? '').trim().slice(0, 120) || 'main',
      /** 本服务依赖哪些服务先完成（同一项目里的服务 id，不跨项目）。 */
      dependsOn: (Array.isArray(item.dependsOn) ? item.dependsOn : [])
        .map(dep => String(dep ?? '').trim().slice(0, 60))
        .filter(dep => dep.length > 0),
    })
    if (out.length >= 20) break
  }
  // 依赖只能指向同一项目里存在的服务、不能指向自己，也不能成环（A→B→A 会让两张卡互相等）。
  const known = new Map(out.map(one => [one.id, one]))
  for (const one of out) {
    one.dependsOn = one.dependsOn
      .filter(dep => dep !== one.id && known.has(dep))
      .filter((dep, index, all) => all.indexOf(dep) === index)
      .slice(0, 10)
  }
  const reaches = (from, to, seen) => {
    if (from === to) return true
    if (seen.has(from)) return false
    seen.add(from)
    return (known.get(from)?.dependsOn ?? []).some(next => reaches(next, to, seen))
  }
  for (const one of out) {
    // 加一条 one→dep 之前先看 dep 是不是已经（间接）依赖 one，是就丢掉这条边。
    one.dependsOn = one.dependsOn.filter(dep => !reaches(dep, one.id, new Set()))
  }
  // 老数据只有项目级 repoPath：折成一个默认服务，行为不变。
  if (out.length === 0 && String(legacyPath ?? '').trim().length > 0) {
    out.push({ id: 'svc-default', name: '默认服务', repoId: '', repoPath: String(legacyPath).trim().slice(0, 400), baseBranch: 'main', dependsOn: [] })
  }
  return out
}

export function sanitizeWorkProjects(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const raw of input.slice(0, 60)) {
    if (raw === null || typeof raw !== 'object') continue
    const id = cleanId(raw.id ?? raw.name, 'proj')
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name: String(raw.name ?? id).trim().slice(0, 80) || id,
      key: String(raw.key ?? '').trim().toUpperCase().slice(0, 12),
      description: String(raw.description ?? '').slice(0, 600),
      lead: String(raw.lead ?? '').trim().slice(0, 40),
      status: String(raw.status) === 'archived' ? 'archived' : 'active',
      repos: (Array.isArray(raw.repos) ? raw.repos : [])
        .map(repo => String(repo ?? '').trim().slice(0, 60))
        .filter(repo => repo.length > 0)
        .filter((repo, index, all) => all.indexOf(repo) === index)
        .slice(0, 20),
      iterations: sanitizeIterations(raw.iterations),
      /** 项目里的服务：一个服务一个本机 git 路径，card.service 指向其中一条。 */
      services: sanitizeServices(raw.services, raw.repoPath),
      /** 这个项目的代码在本机哪个目录（worktree 隔离从这里切分支）。 */
      repoPath: String(raw.repoPath ?? '').trim().slice(0, 400),
      baseBranch: String(raw.baseBranch ?? '').trim().slice(0, 120) || 'main',
    })
  }
  return out
}

/** 需求：整条交付链路的锚点，所有下游产物都挂在它下面。 */
export const REQ_DOC_KINDS = ['prd', 'proto', 'acceptance', 'other']
export const REQ_DOC_KIND_LABEL = { prd: 'PRD', proto: '原型', acceptance: '验收标准', other: '其它' }
export const REQ_DOC_STATUS = ['draft', 'review', 'baseline']

export function sanitizeReqDoc(raw, index) {
  if (raw === null || typeof raw !== 'object') return undefined
  const title = String(raw.title ?? '').trim().slice(0, 200)
  if (title.length === 0) return undefined
  const now = Date.now()
  return {
    id: cleanId(raw.id ?? '', `doc${index}`),
    kind: REQ_DOC_KINDS.includes(String(raw.kind)) ? String(raw.kind) : 'prd',
    title,
    url: String(raw.url ?? '').trim().slice(0, 500),
    version: String(raw.version ?? '').trim().slice(0, 20) || 'v1.0',
    status: REQ_DOC_STATUS.includes(String(raw.status)) ? String(raw.status) : 'draft',
    content: String(raw.content ?? '').slice(0, 60000),
    by: String(raw.by ?? '').trim().slice(0, 40),
    at: Number(raw.at) || now,
  }
}

export function sanitizeReqDocs(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  input.slice(0, 40).forEach((raw, index) => {
    const doc = sanitizeReqDoc(raw, index)
    if (doc === undefined || seen.has(doc.id)) return
    seen.add(doc.id)
    out.push(doc)
  })
  return out
}

export function sanitizeBaseline(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const version = String(raw.version ?? '').trim().slice(0, 20)
  if (version === '') return null
  return {
    docId: String(raw.docId ?? '').slice(0, 60),
    title: String(raw.title ?? '').slice(0, 200),
    version,
    content: String(raw.content ?? '').slice(0, 60000),
    at: Number(raw.at) || Date.now(),
    by: String(raw.by ?? '').trim().slice(0, 40),
  }
}

export function sanitizeAcceptanceItem(raw, index) {
  if (raw === null || raw === undefined) return undefined
  const source = typeof raw === 'string' ? { text: raw } : raw
  const text = String(source.text ?? '').trim().slice(0, 300)
  if (text.length === 0) return undefined
  return {
    id: String(source.id ?? `a${index + 1}`).trim().slice(0, 24) || `a${index + 1}`,
    text,
    done: source.done === true,
  }
}

/** 需求里的「功能点」：可追溯矩阵的锚点，卡与用例都挂到它上面。 */
export function sanitizeRequirementPoint(raw, index) {
  if (raw === null || typeof raw !== 'object') return undefined
  const title = String(raw.title ?? '').trim().slice(0, 200)
  if (title.length === 0) return undefined
  const acceptance = Array.isArray(raw.acceptance)
    ? raw.acceptance.map((item, i) => sanitizeAcceptanceItem(item, i)).filter(item => item !== undefined).slice(0, 30)
    : []
  return {
    id: String(raw.id ?? '').trim().slice(0, 24) || `p${index + 1}`,
    title,
    description: String(raw.description ?? '').slice(0, 2000),
    priority: PRIORITIES.includes(String(raw.priority)) ? String(raw.priority) : 'normal',
    status: ['draft', 'ready', 'done'].includes(String(raw.status)) ? String(raw.status) : 'draft',
    acceptance,
  }
}

export function sanitizeRequirementPoints(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const raw of input.slice(0, 60)) {
    const point = sanitizeRequirementPoint(raw, out.length)
    if (point === undefined) continue
    let id = point.id
    let n = 2
    while (seen.has(id)) { id = `${point.id}-${n}`; n += 1 }
    seen.add(id)
    out.push({ ...point, id })
  }
  return out
}

/**
 * 需求变更影响面：改了哪几处（标题/需求明细/功能点/文档链接）、影响哪些已经产出过的卡、
 * 原来签过的字是不是已经作废。没改过就是 null。
 */
export function sanitizeRequirementChange(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  const parts = (Array.isArray(raw.parts) ? raw.parts : [])
    .map(item => String(item).trim().slice(0, 20))
    .filter(item => item !== '')
    .slice(0, 8)
  if (parts.length === 0) return null
  return {
    at: Number(raw.at) || Date.now(),
    by: String(raw.by ?? '').trim().slice(0, 60),
    parts,
    affected: (Array.isArray(raw.affected) ? raw.affected : []).slice(0, 60).map(item => ({
      id: String(item?.id ?? '').slice(0, 60),
      code: String(item?.code ?? '').slice(0, 40),
      title: String(item?.title ?? '').slice(0, 200),
      status: String(item?.status ?? '').slice(0, 20),
    })),
    invalidated: raw.invalidated === true,
  }
}

/** 需求评审记录：结论 + 人 + 时间 + 意见。没评审过就是 null。 */
export function sanitizeRequirementReview(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  const status = REQ_REVIEW_STATUS.includes(String(raw.status)) ? String(raw.status) : 'pending'
  return {
    status,
    by: String(raw.by ?? '').trim().slice(0, 60),
    at: Number(raw.at) || 0,
    note: String(raw.note ?? '').slice(0, 600),
  }
}

export const MINE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>我提过的需求</title>
<style>body{font-family:system-ui,sans-serif;margin:0;background:#fafafa;color:#18181b}main{max-width:640px;margin:40px auto;padding:24px;background:#fff;border:1px solid #e4e4e7;border-radius:12px}h1{font-size:18px;margin:0 0 6px}p.hint{color:#71717a;font-size:13px;margin:0 0 14px}input{width:100%;box-sizing:border-box;height:36px;padding:4px 12px;border:1px solid #e4e4e7;border-radius:8px;font-size:14px}button{margin-top:12px;height:36px;padding:0 18px;border:0;border-radius:8px;background:#18181b;color:#fafafa;font-size:14px;cursor:pointer}#msg{margin-top:10px;font-size:13px;color:#b91c1c}.row{padding:12px 0;border-top:1px solid #f4f4f5;font-size:13px;line-height:1.6}.row b{font-size:14px}.tag{display:inline-block;padding:0 6px;border:1px solid #e4e4e7;border-radius:999px;font-size:11px;color:#52525b;margin-left:6px}.kv{color:#71717a;font-size:12px}</style></head>
<body><main><h1>我提过的需求</h1><p class="hint">输入提交时留的联系方式，只看得到你自己提的单。</p>
<input id="contact" placeholder="手机号或飞书"><button id="go">查询</button><div id="msg"></div><div id="list"></div></main>
<script>document.getElementById('go').onclick=async()=>{const msg=document.getElementById('msg');const list=document.getElementById('list');msg.textContent='';list.innerHTML='查询中…';try{const r=await fetch(location.pathname.replace(/\/intake\/mine$/,'')+'/intake/mine/query',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contact:document.getElementById('contact').value})});const j=await r.json();if(!r.ok)throw new Error(j.error||'查询失败');if(j.rows.length===0){list.innerHTML='<p class="kv">没有查到记录，确认联系方式与提交时一致。</p>';return}list.innerHTML=j.rows.map(v=>'<div class="row"><b>'+v.code+'</b><span class="tag">'+v.statusLabel+'</span><br>'+v.title+'<br><span class="kv">待确认问题 '+v.openQuestions+' 条 · 已拆卡 '+v.cards+' 张（完成 '+v.doneCards+'）· 最近更新 '+new Date(v.updatedAt||Date.now()).toLocaleString()+'</span></div>').join('')}catch(e){msg.textContent=e.message;list.innerHTML=''}}</script></body></html>`

export const STATUS_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>需求进度</title>
<style>body{font-family:system-ui,sans-serif;margin:0;background:#fafafa;color:#18181b}main{max-width:560px;margin:40px auto;padding:24px;background:#fff;border:1px solid #e4e4e7;border-radius:12px}h1{font-size:18px;margin:0 0 6px}p.hint{color:#71717a;font-size:13px;margin:0 0 16px}label{display:block;font-size:12px;color:#52525b;margin:12px 0 6px}input{width:100%;box-sizing:border-box;height:36px;padding:4px 12px;border:1px solid #e4e4e7;border-radius:8px;font-size:14px}button{margin-top:16px;height:36px;padding:0 18px;border:0;border-radius:8px;background:#18181b;color:#fafafa;font-size:14px;cursor:pointer}#out{margin-top:16px;font-size:13px;line-height:1.7}#out b{font-size:15px}#out[data-bad="1"]{color:#b91c1c}.kv{color:#52525b}</style></head>
<body><main><h1>查需求进度</h1><p class="hint">用提交时拿到的需求编号，加联系方式的后四位。</p>
<label>需求编号</label><input id="code" placeholder="REQ-2026-001">
<label>联系方式后四位</label><input id="contact" maxlength="8" placeholder="0000">
<button id="go">查询</button><div id="out"></div></main>
<script>document.getElementById('go').onclick=async()=>{const out=document.getElementById('out');out.textContent='查询中…';try{const r=await fetch(location.pathname.replace(/\/intake\/status$/,'')+'/intake/query',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:document.getElementById('code').value,contact:document.getElementById('contact').value})});const j=await r.json();if(!r.ok)throw new Error(j.error||'查询失败');out.removeAttribute('data-bad');out.innerHTML='<b>'+j.code+'</b><br>'+j.title+'<br><span class="kv">状态：'+j.statusLabel+(j.reviewStatus==='pending'?'（评审中）':j.reviewStatus==='changes_requested'?'（评审打回）':'')+'<br>待确认问题：'+j.openQuestions+' 条<br>已拆卡：'+j.cards+' 张（完成 '+j.doneCards+'）<br>最近更新：'+new Date(j.updatedAt||Date.now()).toLocaleString()+'</span>'}catch(e){out.setAttribute('data-bad','1');out.textContent=e.message}}</script></body></html>`

export const INTAKE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>提需求</title>
<style>body{font-family:system-ui,sans-serif;margin:0;background:#fafafa;color:#18181b}main{max-width:640px;margin:40px auto;padding:24px;background:#fff;border:1px solid #e4e4e7;border-radius:12px}h1{font-size:18px;margin:0 0 6px}p.hint{color:#71717a;font-size:13px;margin:0 0 18px}label{display:block;font-size:12px;color:#52525b;margin:14px 0 6px}input,textarea,select{width:100%;box-sizing:border-box;height:36px;padding:4px 12px;border:1px solid #e4e4e7;border-radius:8px;font-size:14px}textarea{height:140px;padding:8px 12px;resize:vertical}button{margin-top:18px;height:36px;padding:0 18px;border:0;border-radius:8px;background:#18181b;color:#fafafa;font-size:14px;cursor:pointer}#msg{margin-top:12px;font-size:13px;color:#0f766e}#msg[data-bad="1"]{color:#b91c1c}</style></head>
<body><main><h1>提交需求</h1><p class="hint">写清楚背景和期望结果即可，产品会来接洽澄清。提交后会生成 REQ 编号。</p>
<label>需求标题</label><input id="title" maxlength="200" placeholder="一句话说清要解决的问题">
<label>需求描述</label><textarea id="description" placeholder="现状怎么做的、希望变成什么样、有什么硬约束（时间/合规/系统）"></textarea>
<div style="display:flex;gap:12px"><div style="flex:1"><label>您的姓名</label><input id="requester" placeholder="张三"></div><div style="flex:1"><label>部门</label><input id="dept" placeholder="财务部"></div></div>
<label>联系方式</label><input id="contact" placeholder="手机或飞书">
<label>紧急程度</label><select id="priority"><option value="normal">一般</option><option value="urgent">紧急</option><option value="relaxed">不急</option></select>
<button id="send">提交需求</button><div id="msg"></div></main>
<script>document.getElementById('send').onclick=async()=>{const msg=document.getElementById('msg');const body={title:document.getElementById('title').value,description:document.getElementById('description').value,requester:document.getElementById('requester').value,dept:document.getElementById('dept').value,contact:document.getElementById('contact').value,priority:document.getElementById('priority').value};try{const r=await fetch(location.pathname.replace(/\/intake$/,'')+'/intake/requirement',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.error||'提交失败');msg.removeAttribute('data-bad');msg.textContent='已提交，需求编号 '+j.code+'。产品会尽快接洽。'}catch(e){msg.setAttribute('data-bad','1');msg.textContent=e.message}}</script></body></html>`

/** 变更历史：需求每次被改，记下字段级 diff，追得到「谁在什么时候把验收口径改了」。 */
export function sanitizeRequirementHistory(raw) {
  if (!Array.isArray(raw)) return []
  return raw.slice(-100).map(entry => (entry !== null && typeof entry === 'object') ? {
    at: Number(entry.at) > 0 ? Number(entry.at) : 0,
    by: String(entry.by ?? '').slice(0, 40),
    field: String(entry.field ?? '').slice(0, 40),
    from: String(entry.from ?? '').slice(0, 300),
    to: String(entry.to ?? '').slice(0, 300),
  } : null).filter(Boolean)
}

/** 需求池打分：RICE = Reach×Impact×Confidence/Effort，score 后端算，前端只填四项。 */
export function sanitizeRequirementPool(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return { reach: 0, impact: 0, confidence: 0, effort: 0, score: 0 }
  const num = (value, max) => { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : 0 }
  const reach = Math.round(num(raw.reach, 100000))
  const impact = num(raw.impact, 3)
  const confidence = num(raw.confidence, 100)
  const effort = num(raw.effort, 365)
  const score = effort <= 0 ? 0 : Math.round((reach * impact * (confidence / 100) / effort) * 10) / 10
  return { reach, impact, confidence, effort, score }
}

/** 待确认清单：需求澄清时沿用「问题 / 谁答 / 答了什么」三件事。 */
export function sanitizeRequirementQuestions(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw.slice(0, 50)) {
    if (entry === null || typeof entry !== 'object') continue
    const text = String(entry.text ?? '').trim().slice(0, 300)
    if (text.length === 0) continue
    out.push({
      id: cleanId(entry.id, 'q'),
      text,
      status: entry.status === 'answered' ? 'answered' : 'open',
      owner: String(entry.owner ?? '').trim().slice(0, 40),
      answer: String(entry.answer ?? '').trim().slice(0, 1000),
      at: Number(entry.at) > 0 ? Number(entry.at) : Date.now(),
      answeredAt: Number(entry.answeredAt) > 0 ? Number(entry.answeredAt) : 0,
    })
  }
  return out
}

export function sanitizeRequirement(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const title = String(raw.title ?? '').trim().slice(0, 200)
  if (title.length === 0) return undefined
  const now = Date.now()
  const links = raw.links !== null && typeof raw.links === 'object' ? raw.links : {}
  const folderRaw = raw.folder !== null && typeof raw.folder === 'object' ? raw.folder : {}
  return {
    id: cleanId(raw.id ?? '', 'req'),
    code: String(raw.code ?? '').trim().toUpperCase().slice(0, 40),
    title,
    description: String(raw.description ?? '').slice(0, 20000),
    project: String(raw.project ?? '').trim().slice(0, 60),
    iteration: String(raw.iteration ?? '').trim().slice(0, 60),
    owner: String(raw.owner ?? '').trim().slice(0, 40),
    /** 业务领域：卡没写领域时继承它，用来把卡路由给同领域专家。 */
    domain: String(raw.domain ?? '').trim().slice(0, 40),
    priority: PRIORITIES.includes(String(raw.priority)) ? String(raw.priority) : 'normal',
    status: REQ_STATUSES.includes(String(raw.status)) ? String(raw.status) : 'draft',
    links: {
      prd: String(links.prd ?? '').trim().slice(0, 500),
      proto: String(links.proto ?? '').trim().slice(0, 500),
      acceptance: String(links.acceptance ?? '').trim().slice(0, 500),
    },
    folder: {
      token: String(folderRaw.token ?? '').trim().slice(0, 80),
      url: String(folderRaw.url ?? '').trim().slice(0, 500),
      name: String(folderRaw.name ?? '').trim().slice(0, 200),
      at: Number(folderRaw.at) || 0,
      error: String(folderRaw.error ?? '').slice(0, 300),
    },
    docs: sanitizeReqDocs(raw.docs),
    points: sanitizeRequirementPoints(raw.points),
    baseline: sanitizeBaseline(raw.baseline),
    /** 排序权重：数字小的排前面，同权重按编号。 */
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 0,
    /** 依赖的需求：被依赖的还没交付，这条需求就不该签字收口。 */
    dependsOn: (Array.isArray(raw.dependsOn) ? raw.dependsOn : []).map(item => String(item).trim()).filter(item => item !== '').slice(0, 20),
    // 需求级验收签字：整条需求交付前的最后一道人工确认，和卡级 signoff 分开。
    source: String(raw.source ?? '').slice(0, 20),
    requester: (raw.requester === null || raw.requester === undefined || typeof raw.requester !== 'object') ? null : {
      name: String(raw.requester.name ?? '').slice(0, 40),
      dept: String(raw.requester.dept ?? '').slice(0, 40),
      contact: String(raw.requester.contact ?? '').slice(0, 80),
      at: Number(raw.requester.at) > 0 ? Number(raw.requester.at) : 0,
    },
    questions: sanitizeRequirementQuestions(raw.questions),
    pool: sanitizeRequirementPool(raw.pool),
    history: sanitizeRequirementHistory(raw.history),
    signoff: raw.signoff === null || raw.signoff === undefined
      ? null
      : {
        by: String(raw.signoff.by ?? '').slice(0, 60),
        at: Number(raw.signoff.at) || now,
        note: String(raw.signoff.note ?? '').slice(0, 600),
      },
    // 需求评审：谁在什么时候看了这版需求、结论是什么。通过之前不往下拆卡。
    review: sanitizeRequirementReview(raw.review),
    // 需求变更影响面：改完标题/明细/功能点之后，已经产出过的卡要复核，签字作废。
    change: sanitizeRequirementChange(raw.change),
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now,
  }
}

export function sanitizeRequirements(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const raw of input.slice(0, 500)) {
    const req = sanitizeRequirement(raw)
    if (req === undefined || seen.has(req.id)) continue
    seen.add(req.id)
    out.push(req)
  }
  return out
}

/** 同一需求下，DEV-001 / TEST-001 各自递增。 */
export function nextTaskCode(tasks, requirementId, prefix) {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`)
  let max = 0
  for (const task of tasks) {
    if ((task.requirementId ?? '') !== requirementId) continue
    const match = pattern.exec(String(task.code ?? ''))
    if (match !== null) max = Math.max(max, Number(match[1]))
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`
}

/** 需求编号按年递增：REQ-2026-001。 */
export function nextRequirementCode(requirements) {
  const year = new Date().getFullYear()
  const pattern = new RegExp(`^REQ-${year}-(\\d+)$`)
  let max = 0
  for (const req of requirements) {
    const match = pattern.exec(String(req.code ?? ''))
    if (match !== null) max = Math.max(max, Number(match[1]))
  }
  return `REQ-${year}-${String(max + 1).padStart(3, '0')}`
}

/** 验收清单的一条：写了什么、谁勾的、什么时候。 */
export function sanitizeChecklistItem(raw, index) {
  if (raw === null || typeof raw !== 'object') return undefined
  const text = String(raw.text ?? '').trim().slice(0, 200)
  if (text.length === 0) return undefined
  const id = String(raw.id ?? '').trim() || `c${index + 1}-${randomBytes(2).toString('hex')}`
  return {
    id,
    text,
    done: raw.done === true,
    by: String(raw.by ?? '').slice(0, 40),
    at: Number(raw.at) || 0,
    note: String(raw.note ?? '').slice(0, 400),
  }
}

/** 验收清单：最多 30 条，去重。 */
export function sanitizeChecklist(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const [index, raw] of input.slice(0, 30).entries()) {
    const item = sanitizeChecklistItem(raw, index)
    if (item === undefined || seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

/** 交付物：老数据可能是纯字符串，统一升级成一条记录。 */
export function sanitizeArtifact(raw, index) {
  if (typeof raw === 'string') {
    const title = raw.trim().slice(0, 200)
    if (title.length === 0) return undefined
    return { id: `a${index + 1}-${randomBytes(2).toString('hex')}`, kind: 'other', title, ref: '', stage: '', status: 'delivered', by: '', at: 0 }
  }
  if (raw === null || typeof raw !== 'object') return undefined
  const rawTitle = String(raw.title ?? raw.ref ?? '').trim().slice(0, 200)
  // 老数据里 title 常常是文件路径，看板上显示成「docs/t-xxx-...」很难读，
  // 这里退化成文件名（去扩展名、连字符换空格）。
  let title = rawTitle
  let ref = String(raw.ref ?? '').trim().slice(0, 500)
  if (/\.[a-z0-9]{1,8}$/i.test(rawTitle) && (rawTitle.includes('/') || rawTitle.includes('\\'))) {
    // 路径变成了标题，但 ref 是空的：把路径留在 ref 里，归档时才能回读正文。
    if (ref === '') ref = rawTitle.slice(0, 500)
    const base = rawTitle.split(/[\\/]/).filter(Boolean).pop() ?? rawTitle
    const cleaned = base.replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[-_]+/g, ' ').trim()
    if (cleaned.length >= 2) title = cleaned.slice(0, 200)
  }
  if (title.length === 0) return undefined
  const kind = ARTIFACT_KINDS.includes(String(raw.kind)) ? String(raw.kind) : 'other'
  const status = ARTIFACT_STATUS.includes(String(raw.status)) ? String(raw.status) : 'delivered'
  const stage = STATUS_IDS.includes(String(raw.stage)) ? String(raw.stage) : ''
  const docRaw = raw.doc !== null && typeof raw.doc === 'object' ? raw.doc : {}
  return {
    id: String(raw.id ?? '').trim() || `a${index + 1}-${randomBytes(2).toString('hex')}`,
    kind,
    title,
    ref: ref,
    content: String(raw.content ?? '').slice(0, 60000),
    stage,
    status,
    by: String(raw.by ?? '').slice(0, 40),
    at: Number(raw.at) || 0,
    doc: {
      token: String(docRaw.token ?? '').trim().slice(0, 80),
      url: String(docRaw.url ?? '').trim().slice(0, 500),
      name: String(docRaw.name ?? '').trim().slice(0, 200),
      at: Number(docRaw.at) || 0,
      error: String(docRaw.error ?? '').slice(0, 300),
    },
  }
}

/** 交付物清单：一张卡最多 40 件。 */
export function sanitizeArtifacts(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const [index, raw] of input.slice(0, 40).entries()) {
    const item = sanitizeArtifact(raw, index)
    if (item === undefined || seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

/** 用例执行结果：还没跑 / 通过 / 不通过 / 不适用。 */
export const CASE_RESULTS = ['pending', 'pass', 'fail', 'skip']
/** 用例的类型与优先级：让测试计划能按类型/优先级挑，而不是只有一句标题。 */
export const CASE_TYPES = ['functional', 'api', 'ui', 'performance', 'security', 'other']
export const CASE_TYPE_LABEL = { functional: '功能', api: '接口', ui: '界面', performance: '性能', security: '安全', other: '其它' }
export const CASE_PRIORITIES = ['p0', 'p1', 'p2', 'p3']

/** 第一版执行器只跑 HTTP 请求：方法白名单里没有的按 GET 处理。 */
export const CASE_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']

/**
 * 一条用例的可执行定义。相对 URL 拼环境里的 baseUrl，绝对 URL 必须命中允许的 host
 * （执行器跑在服务器上，不能让它变成打内网的跳板）。
 */
export function sanitizeCaseHttp(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const url = String(raw.url ?? '').trim().slice(0, 500)
  const headers = {}
  if (raw.headers !== null && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
    for (const [key, value] of Object.entries(raw.headers).slice(0, 20)) {
      const name = String(key).trim().slice(0, 60)
      if (name.length === 0) continue
      headers[name] = String(value ?? '').slice(0, 500)
    }
  }
  const method = String(raw.method ?? 'GET').trim().toUpperCase()
  const pickVars = input => {
    const out = {}
    if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
      for (const [key, value] of Object.entries(input).slice(0, 20)) {
        const name = String(key).trim().slice(0, 40)
        if (name.length === 0) continue
        out[name] = String(value ?? '').slice(0, 500)
      }
    }
    return out
  }
  // 多步用例：登录拿 token → 用 token 调业务接口 → 用返回的 id 查详情，一条用例串起来。
  const steps = Array.isArray(raw.steps)
    ? raw.steps.slice(0, 20).map(step => {
        const target = step !== null && typeof step === 'object' ? step : {}
        const stepMethod = String(target.method ?? 'GET').trim().toUpperCase()
        return {
          method: CASE_HTTP_METHODS.includes(stepMethod) ? stepMethod : 'GET',
          url: String(target.url ?? '').trim().slice(0, 500),
          body: String(target.body ?? '').slice(0, 8000),
          expectStatus: Number.isInteger(Number(target.expectStatus)) ? Math.max(0, Math.min(599, Number(target.expectStatus))) : 0,
          expectContains: String(target.expectContains ?? '').slice(0, 300),
          extract: pickVars(target.extract),
        }
      }).filter(step => step.url !== '')
    : []
  if (url.length === 0 && steps.length === 0) return null
  return {
    method: CASE_HTTP_METHODS.includes(method) ? method : 'GET',
    url,
    headers,
    body: String(raw.body ?? '').slice(0, 8000),
    /** 0 = 任意 2xx/3xx 都算通过。 */
    expectStatus: Number.isInteger(Number(raw.expectStatus)) ? Math.max(0, Math.min(599, Number(raw.expectStatus))) : 0,
    /** 响应体里必须出现的字符串，空则不比。 */
    expectContains: String(raw.expectContains ?? '').slice(0, 300),
    timeoutMs: Math.max(0, Math.min(120000, Number(raw.timeoutMs) || 0)),
    steps,
    vars: pickVars(raw.vars),
  }
}

/** 一条测试用例：做什么、期望什么、实际结果，以及最近一次执行的样子。 */
export function sanitizeCase(raw, index) {
  if (typeof raw === 'string') {
    const title = raw.trim().slice(0, 200)
    if (title.length === 0) return undefined
    return {
      id: `c${index + 1}-${randomBytes(2).toString('hex')}`,
      title,
      expected: '',
      pointId: '',
      result: 'pending',
      type: 'functional',
      priority: 'p2',
      preconditions: '',
      steps: [],
      note: '',
      by: '',
      at: 0,
      http: null,
      lastRun: null,
    }
  }
  if (raw === null || typeof raw !== 'object') return undefined
  const title = String(raw.title ?? '').trim().slice(0, 200)
  if (title.length === 0) return undefined
  const result = CASE_RESULTS.includes(String(raw.result)) ? String(raw.result) : 'pending'
  const type = CASE_TYPES.includes(String(raw.type)) ? String(raw.type) : 'functional'
  const priority = CASE_PRIORITIES.includes(String(raw.priority).toLowerCase()) ? String(raw.priority).toLowerCase() : 'p2'
  return {
    id: String(raw.id ?? '').trim() || `c${index + 1}-${randomBytes(2).toString('hex')}`,
    title,
    expected: String(raw.expected ?? '').trim().slice(0, 300),
    pointId: String(raw.pointId ?? '').trim().slice(0, 24),
    result,
    /** 用例类型：功能 / 接口 / 界面 / 性能 / 安全。 */
    type,
    /** 用例优先级：p0 必测、p3 有余力再测。 */
    priority,
    /** 前置条件：跑这条用例之前系统该是什么状态。 */
    preconditions: String(raw.preconditions ?? '').slice(0, 800),
    /** 操作步骤：一行一步，最多 20 步。 */
    steps: (Array.isArray(raw.steps) ? raw.steps : [])
      .map(item => String(item ?? '').trim().slice(0, 200))
      .filter(item => item !== '')
      .slice(0, 20),
    /** 不稳定用例：失败时不自动开缺陷，避免把环境抖动当成产品缺陷。 */
    flaky: raw.flaky === true,
    note: String(raw.note ?? '').trim().slice(0, 400),
    by: String(raw.by ?? '').slice(0, 40),
    at: Number(raw.at) || 0,
    http: sanitizeCaseHttp(raw.http),
    lastRun: sanitizeCaseRun(raw.lastRun),
  }
}

/** 一次用例执行的结果摘要（放在用例上，最多保留这几个字段）。 */
export function sanitizeCaseRun(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const steps = Array.isArray(raw.steps) ? raw.steps.slice(0, 20).map((step, index) => ({
    i: Number(step?.i) || index + 1,
    method: String(step?.method ?? 'GET').slice(0, 10),
    url: String(step?.url ?? '').slice(0, 500),
    ok: step?.ok === true,
    status: Number(step?.status) || 0,
    ms: Number(step?.ms) || 0,
    error: String(step?.error ?? '').slice(0, 300),
    preview: String(step?.preview ?? '').slice(0, 300),
  })) : []
  return {
    at: Number(raw.at) || 0,
    ok: raw.ok === true,
    status: Number(raw.status) || 0,
    ms: Number(raw.ms) || 0,
    error: String(raw.error ?? '').slice(0, 400),
    preview: String(raw.preview ?? '').slice(0, 600),
    response: String(raw.response ?? '').slice(0, 2000),
    env: String(raw.env ?? '').slice(0, 40),
    steps,
  }
}

/** 一次批量执行：哪张卡、哪个环境、跑了几条、几条不过。 */
export function sanitizeTestRun(raw, index) {
  if (raw === null || typeof raw !== 'object') return undefined
  const results = (Array.isArray(raw.results) ? raw.results : []).slice(0, 60).map(item => ({
    id: String(item?.id ?? '').slice(0, 60),
    title: String(item?.title ?? '').slice(0, 200),
    ok: item?.ok === true,
    status: Number(item?.status) || 0,
    ms: Number(item?.ms) || 0,
    error: String(item?.error ?? '').slice(0, 400),
  }))
  return {
    id: String(raw.id ?? '').trim() || `r${index + 1}-${randomBytes(2).toString('hex')}`,
    at: Number(raw.at) || 0,
    by: String(raw.by ?? '').slice(0, 40),
    env: String(raw.env ?? '').slice(0, 40),
    total: results.length,
    passed: results.filter(item => item.ok).length,
    failed: results.filter(item => item.ok !== true).length,
    results,
  }
}

/** 一张卡最多保留 10 次执行记录。 */
export function sanitizeTestRuns(input) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const [index, raw] of input.slice(-10).entries()) {
    const item = sanitizeTestRun(raw, index)
    if (item !== undefined) out.push(item)
  }
  return out
}

/** 测试环境：一个名字 + baseUrl + 默认请求头。 */
export function sanitizeEnvs(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const raw of input.slice(0, 12)) {
    if (raw === null || typeof raw !== 'object') continue
    const name = String(raw.name ?? '').trim().slice(0, 40)
    const baseUrl = String(raw.baseUrl ?? '').trim().slice(0, 300)
    if (name.length === 0 || baseUrl.length === 0) continue
    const id = cleanId(raw.id ?? name, 'env')
    if (seen.has(id)) continue
    seen.add(id)
    const headers = {}
    if (raw.headers !== null && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
      for (const [key, value] of Object.entries(raw.headers).slice(0, 20)) {
        const head = String(key).trim().slice(0, 60)
        if (head.length === 0) continue
        headers[head] = String(value ?? '').slice(0, 500)
      }
    }
    out.push({ id, name, baseUrl, headers })
  }
  return out
}

/**
 * 部署环境：只是「记录发布去过哪」的清单，平台不触发任何部署。
 * dev / staging / prod 是出厂默认，名字、说明都能改，id 用来挂部署记录。
 */
export const DEPLOY_ENV_KINDS = ['dev', 'staging', 'prod', 'other']

export function defaultDeployEnvs() {
  return [
    { id: 'dev', name: '开发', kind: 'dev', note: '开发自测环境' },
    { id: 'staging', name: '预发', kind: 'staging', note: '上线前最后一关' },
    { id: 'prod', name: '生产', kind: 'prod', note: '真实用户' },
  ]
}

export function sanitizeDeployEnvs(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const raw of input.slice(0, 12)) {
    if (raw === null || typeof raw !== 'object') continue
    const id = cleanId(raw.id ?? raw.name, 'env')
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name: String(raw.name ?? '').trim().slice(0, 40) || id,
      kind: DEPLOY_ENV_KINDS.includes(String(raw.kind)) ? String(raw.kind) : 'other',
      note: String(raw.note ?? '').slice(0, 200),
    })
  }
  return out
}

/** 执行器只允许打这些 host（防止被提示词带着去扫内网）。 */
export function sanitizeAllowHosts(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(/[,，\s]+/)
  const out = []
  for (const raw of list.slice(0, 40)) {
    const host = String(raw ?? '').trim().toLowerCase().slice(0, 120)
    if (host.length === 0) continue
    if (!/^[a-z0-9.*-]+$/.test(host)) continue
    if (!out.includes(host)) out.push(host)
  }
  return out
}

/** 测试执行配置：环境、默认环境、超时、允许的域名。 */
export function sanitizeTesting(raw) {
  const base = { envs: [], defaultEnv: '', timeoutMs: 15000, allowHosts: ['127.0.0.1', 'localhost'], concurrency: 4 }
  if (raw === null || typeof raw !== 'object') return base
  const envs = sanitizeEnvs(raw.envs)
  const defaultEnv = String(raw.defaultEnv ?? '').trim()
  return {
    envs,
    defaultEnv: envs.some(env => env.id === defaultEnv) ? defaultEnv : (envs[0]?.id ?? ''),
    timeoutMs: Math.max(1000, Math.min(120000, Number(raw.timeoutMs) || base.timeoutMs)),
    allowHosts: sanitizeAllowHosts(raw.allowHosts ?? base.allowHosts),
    concurrency: Math.max(1, Math.min(8, Number(raw.concurrency) || base.concurrency)),
  }
}


/** 一张卡最多 60 条用例。 */
export function sanitizeCases(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const [index, raw] of input.slice(0, 60).entries()) {
    const item = sanitizeCase(raw, index)
    if (item === undefined || seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

// ------------------------------------------------------- Bug 自动闭环（用例失败 → 缺陷卡）

/** 缺陷卡的「来源」：哪张测试卡、哪条用例、当时的证据。 */
export function sanitizeBugSource(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const taskId = String(raw.taskId ?? '').trim()
  if (taskId === '') return null
  return {
    taskId: taskId.slice(0, 60),
    code: String(raw.code ?? '').trim().slice(0, 40),
    caseId: String(raw.caseId ?? '').trim().slice(0, 60),
    caseTitle: String(raw.caseTitle ?? '').trim().slice(0, 200),
    expected: String(raw.expected ?? '').trim().slice(0, 300),
    note: String(raw.note ?? '').trim().slice(0, 400),
    by: String(raw.by ?? '').slice(0, 40),
    at: Number(raw.at) || 0,
  }
}

// ---------------------------------------------------------------- AI Coding 执行记录

export const CODING_REVIEW_STATUS = ['pending', 'approved', 'changes_requested']
export const CODING_FILE_CHANGES = ['added', 'modified', 'deleted']

/** 一次提交：谁改的、改了哪些文件、多少行。 */
export function sanitizeCommit(raw, index) {
  if (raw === null || typeof raw !== 'object') return undefined
  const sha = String(raw.sha ?? '').trim().slice(0, 64)
  if (sha === '') return undefined
  return {
    id: `${sha.slice(0, 12)}-${index}`,
    sha,
    message: String(raw.message ?? '').trim().slice(0, 300),
    at: Number(raw.at) || Date.now(),
    files: Math.max(0, Math.min(9999, Number(raw.files) || 0)),
    additions: Math.max(0, Number(raw.additions) || 0),
    deletions: Math.max(0, Number(raw.deletions) || 0),
  }
}

export function sanitizeCommits(input) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const [index, raw] of input.slice(0, 60).entries()) {
    const item = sanitizeCommit(raw, index)
    if (item !== undefined) out.push(item)
  }
  return out
}

/** 一个被改动的文件。 */
export function sanitizeChangedFile(raw, index) {
  if (raw === null || typeof raw !== 'object') return undefined
  const path = String(raw.path ?? '').trim().slice(0, 300)
  if (path === '') return undefined
  return {
    id: `${path}-${index}`.slice(0, 340),
    path,
    change: CODING_FILE_CHANGES.includes(String(raw.change)) ? String(raw.change) : 'modified',
    additions: Math.max(0, Number(raw.additions) || 0),
    deletions: Math.max(0, Number(raw.deletions) || 0),
  }
}

export function sanitizeChangedFiles(input) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const [index, raw] of input.slice(0, 300).entries()) {
    const item = sanitizeChangedFile(raw, index)
    if (item !== undefined) out.push(item)
  }
  return out
}

/**
 * AI Coding 执行记录：这一棒到底是谁、照着哪版需求、改了哪些代码、单测过没过、谁准的合并。
 * 文档里「AI 执行记录」列的正是这七项。
 */
export function sanitizeCoding(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  const tests = raw.unitTests !== null && typeof raw.unitTests === 'object' ? raw.unitTests : {}
  const review = raw.review !== null && typeof raw.review === 'object' ? raw.review : {}
  const total = Math.max(0, Math.min(99999, Number(tests.total) || 0))
  const passed = Math.max(0, Math.min(total, Number(tests.passed) || 0))
  const failed = Math.max(0, Math.min(total - passed, Number(tests.failed) || (total - passed)))
  return {
    agent: String(raw.agent ?? '').trim().slice(0, 80),
    model: String(raw.model ?? '').trim().slice(0, 80),
    branch: String(raw.branch ?? '').trim().slice(0, 200),
    context: String(raw.context ?? '').slice(0, 4000),
    commits: sanitizeCommits(raw.commits),
    files: sanitizeChangedFiles(raw.files),
    unitTests: { total, passed, failed, at: Number(tests.at) || 0 },
    review: {
      status: CODING_REVIEW_STATUS.includes(String(review.status)) ? String(review.status) : 'pending',
      by: String(review.by ?? '').slice(0, 40),
      at: Number(review.at) || 0,
      note: String(review.note ?? '').slice(0, 600),
    },
    mergedBy: String(raw.mergedBy ?? '').slice(0, 40),
    mergedAt: Number(raw.mergedAt) || 0,
    // 最近一次「执行记录 vs 代码事实」的核对结果；没核对过就是 null。
    verified: raw.verified === null || raw.verified === undefined || typeof raw.verified !== 'object'
      ? null
      : {
        at: Number(raw.verified.at) || 0,
        branch: String(raw.verified.branch ?? '').slice(0, 200),
        declaredBranch: String(raw.verified.declaredBranch ?? '').slice(0, 200),
        branchOk: raw.verified.branchOk === true,
        commitCount: {
          declared: Math.max(0, Number(raw.verified.commitCount?.declared) || 0),
          actual: Math.max(0, Number(raw.verified.commitCount?.actual) || 0),
        },
        fileCount: {
          declared: Math.max(0, Number(raw.verified.fileCount?.declared) || 0),
          actual: Math.max(0, Number(raw.verified.fileCount?.actual) || 0),
        },
        missingCommits: (Array.isArray(raw.verified.missingCommits) ? raw.verified.missingCommits : []).map(item => String(item).slice(0, 80)).slice(0, 10),
        missingFiles: (Array.isArray(raw.verified.missingFiles) ? raw.verified.missingFiles : []).map(item => String(item).slice(0, 300)).slice(0, 20),
        dirty: (Array.isArray(raw.verified.dirty) ? raw.verified.dirty : []).map(item => String(item).slice(0, 300)).slice(0, 10),
        ok: raw.verified.ok === true,
      },
    updatedAt: Number(raw.updatedAt) || Date.now(),
  }
}

/** 把外部传进来的 patch 合到已有记录上（数组整段替换，不追加重叠）。 */
export function mergeCoding(current, patch) {
  const base = sanitizeCoding(current ?? {}) ?? sanitizeCoding({})
  const merged = { ...base, ...(patch ?? {}), updatedAt: Date.now() }
  if (patch?.commits !== undefined) merged.commits = patch.commits
  if (patch?.files !== undefined) merged.files = patch.files
  if (patch?.unitTests !== undefined) merged.unitTests = { ...base.unitTests, ...patch.unitTests }
  if (patch?.review !== undefined) merged.review = { ...base.review, ...patch.review }
  return sanitizeCoding(merged)
}

/** 单测通过率文案。 */
export function codingSummary(coding) {
  if (coding === null || coding === undefined) return ''
  const parts = []
  if (coding.agent !== '') parts.push(coding.agent)
  if (coding.files.length > 0) parts.push(`${coding.files.length} 个文件`)
  if (coding.commits.length > 0) parts.push(`${coding.commits.length} 次提交`)
  if (coding.unitTests.total > 0) parts.push(`单测 ${coding.unitTests.passed}/${coding.unitTests.total}`)
  if (coding.review.status === 'approved') parts.push('评审通过')
  else if (coding.review.status === 'changes_requested') parts.push('评审待改')
  if (coding.mergedAt > 0) parts.push(`已合并 ${coding.mergedBy || ''}`.trim())
  return parts.join(' · ')
}

/** 清单模板：每种卡片类型一组条目。 */
export function sanitizeTemplates(input) {
  const base = defaultTemplates()
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return base
  const out = { ...base }
  for (const type of TASK_TYPES) {
    const raw = input[type]
    if (!Array.isArray(raw)) continue
    const items = raw
      .map(item => String(item ?? '').trim().slice(0, 200))
      .filter(item => item.length > 0)
      .slice(0, 12)
    out[type] = items
  }
  return out
}

/** Replace the entry with the same id, or append a new one. */

export function sanitizeAccess(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const members = []
  const seen = new Set()
  if (Array.isArray(input.members)) {
    for (const item of input.members) {
      if (members.length >= 50) break
      const entry = item !== null && typeof item === 'object' ? item : {}
      const name = String(entry.name ?? '').trim().slice(0, 40)
      if (name === '') continue
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const id = String(entry.id ?? entry.name ?? '').trim().slice(0, 60)
      members.push({ id, name, role: ACCESS_ROLES.includes(entry.role) ? entry.role : 'member' })
    }
  }
  return {
    enabled: input.enabled === true,
    agents: input.agents === 'bypass' ? 'bypass' : 'inherit',
    members,
  }
}

export function worktreeRoot(config) {
  const explicit = String(config?.agents?.worktreeRoot ?? '').trim()
  if (explicit.length > 0) return explicit
  const workspace = String(config?.agents?.workspaceDir ?? '').trim() || join(homedir(), 'dsh-workspace')
  return join(dirname(workspace), 'dsh-worktrees')
}

export function text(value, max = 2000) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed.slice(0, max)
}

/** Coerce one arbitrary input object into a well-formed task patch. */
export function normalizePatch(input) {
  const patch = {}
  if (input.title !== undefined) {
    const title = text(input.title, 200)
    if (title === undefined) throw new Error('title must not be empty')
    patch.title = title
  }
  if (input.requirement !== undefined) patch.requirement = text(input.requirement, 20000) ?? ''
  if (input.type !== undefined) {
    const type = String(input.type)
    if (!TASK_TYPES.includes(type)) throw new Error(`unknown type ${type}`)
    patch.type = type
  }
  if (input.severity !== undefined) {
    const severity = String(input.severity).toLowerCase()
    patch.severity = severity === '' ? '' : (SEVERITIES.includes(severity) ? severity : 'p2')
  }
  if (input.role !== undefined) {
    const role = String(input.role)
    if (!ROLE_IDS.includes(role)) throw new Error(`unknown role ${role}`)
    patch.role = role
  }
  if (input.status !== undefined) {
    const status = String(input.status)
    if (!STATUS_SET.has(status)) throw new Error(`unknown status ${status}`)
    // 旧客户端仍把「阻塞」当一列：翻译成标记，车道保持不动。
    if (status === LEGACY_BLOCKED_STATUS) patch.blocked = true
    else patch.status = status
  }
  if (input.blocked !== undefined) patch.blocked = input.blocked === true
  if (input.priority !== undefined) {
    const priority = String(input.priority)
    if (!PRIORITIES.includes(priority)) throw new Error(`unknown priority ${priority}`)
    patch.priority = priority
  }
  for (const key of ['gitlabIssue', 'gitlabMR', 'owner', 'blockedReason', 'feishuThread']) {
    if (input[key] !== undefined) patch[key] = text(input[key], 500) ?? ''
  }
  if (input.expert !== undefined) patch.expert = text(input.expert, 40) ?? ''
  if (input.domain !== undefined) patch.domain = text(input.domain, 40) ?? ''
  if (input.gitlabProject !== undefined) patch.gitlabProject = text(input.gitlabProject, 60) ?? ''
  for (const key of ['project', 'iteration', 'parent', 'service']) {
    if (input[key] !== undefined) patch[key] = text(input[key], 60) ?? ''
  }
  if (input.requirementId !== undefined) patch.requirementId = text(input.requirementId, 60) ?? ''
  if (input.pointId !== undefined) patch.pointId = text(input.pointId, 24) ?? ''
  if (input.override !== undefined) patch.override = text(input.override, 300) ?? ''
  if (input.releaseId !== undefined) patch.releaseId = text(input.releaseId, 60) ?? ''
  if (input.dueAt !== undefined) {
    const dueAt = Number(input.dueAt)
    patch.dueAt = Number.isFinite(dueAt) && dueAt > 0 ? dueAt : 0
  }
  if (input.artifacts !== undefined) {
    patch.artifacts = sanitizeArtifacts(Array.isArray(input.artifacts) ? input.artifacts : [])
  }
  if (input.checklist !== undefined) {
    patch.checklist = sanitizeChecklist(Array.isArray(input.checklist) ? input.checklist : [])
  }
  if (input.cases !== undefined) {
    patch.cases = Array.isArray(input.cases)
      ? sanitizeCases(input.cases.map(item => ({
        ...item,
        http: item?.http ?? (item?.url !== undefined && String(item.url).trim().length > 0
          ? { method: item.method, url: item.url, body: item.body, expectStatus: item.expectStatus, expectContains: item.expectContains }
          : undefined),
      })))
      : []
  }
  if (input.tags !== undefined) {
    patch.tags = Array.isArray(input.tags) ? input.tags.map(t => String(t).slice(0, 40)).slice(0, 20) : []
  }
  if (input.bugSource !== undefined) patch.bugSource = sanitizeBugSource(input.bugSource)
  return patch
}

