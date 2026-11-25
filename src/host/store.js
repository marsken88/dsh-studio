import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  CODE_PREFIX,
  canonicalAuthor,
  DEFAULT_ROLES,
  LEGACY_BLOCKED_STATUS,
  ROLE_IDS,
  STATUS_IDS,
  defaultConfig,
  mergeConfig,
  nextRequirementCode,
  nextTaskCode,
  sanitizeArtifacts,
  sanitizeAudit,
  sanitizeBugSource,
  sanitizeCases,
  sanitizeChecklist,
  sanitizeCoding,
  sanitizeLdap,
  sanitizeReleases,
  sanitizeRequirements,
  sanitizeTestRuns,
  text,
} from './domain.js'
import { sanitizeQuality } from './card-quality.js'
import { sanitizeMergeGate } from './merge-gate.js'
import { sanitizeDesign } from './design.js'
import { sanitizeTestPlan } from './test-plan.js'
import { looksHashed, sessionTokenHash } from './sessions.js'

/** 持久化层：SQLite 台账（单写者 + 快照）与 0600 密钥文件。 */

/** File-backed work ledger + settings, single-writer per host process. */
/** 密钥单独放在 600 权限的文件里，台账只留「配没配」。 */
export class SecretStore {
  constructor(file) {
    this.file = file
    this.cache = null
    this.chain = Promise.resolve()
  }

  async load() {
    if (this.cache !== null) return this.cache
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      this.cache = {
        gitlab: typeof parsed.gitlab === 'object' && parsed.gitlab !== null ? parsed.gitlab : {},
        feishu: typeof parsed.feishu === 'object' && parsed.feishu !== null ? parsed.feishu : {},
        ldap: typeof parsed.ldap === 'object' && parsed.ldap !== null ? parsed.ldap : {},
        legacy: typeof parsed.legacy === 'object' && parsed.legacy !== null ? parsed.legacy : {},
        localAuth: typeof parsed.localAuth === 'object' && parsed.localAuth !== null ? parsed.localAuth : null,
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[dsh-studio] could not read secrets file:', error?.message ?? error)
      this.cache = { gitlab: {}, feishu: {}, ldap: {}, legacy: {}, localAuth: null }
    }
    return this.cache
  }

  async replace(next) {
    this.cache = {
      gitlab: next?.gitlab ?? {},
      feishu: next?.feishu ?? {},
      ldap: next?.ldap ?? {},
      legacy: next?.legacy ?? {},
      localAuth: next?.localAuth ?? null,
    }
    const run = this.chain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify({ version: 1, ...this.cache }, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, this.file)
      try { await chmod(this.file, 0o600) } catch { /* 非 POSIX 平台忽略 */ }
    })
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }
}

export class StudioStore {
  constructor(file, options = {}) {
    this.file = file
    this.dbFile = String(options.dbFile ?? file.replace(/\.json$/, '.db'))
    this.secrets = options.secrets ?? null
    this.snapshotLimit = Math.max(3, Math.min(100, Number(options.snapshotLimit) || 10))
    this.db = null
    this.engine = 'file'
    this.state = { revision: 1, updatedAt: Date.now(), config: defaultConfig(), tasks: [], requirements: [], releases: [], audit: [], fallbackFolder: null }
    this.chain = Promise.resolve()
    /** 本进程这一轮写所基于的 revision（单写者校验用）：落盘前比对磁盘上的是不是它。 */
    this.baseRevision = 0
    /** 口令哈希是否已经安全落在密钥文件里：是才允许从 state/快照里摘掉。 */
    this.secretsHaveLocalAuth = false
    this.ready = this.#boot()
  }

  /** 先开库（拿跨进程写锁），拿不到就退回单文件模式。 */
  /* ---- 登录会话（落库，服务重启不掉线） ---- */
  listSessions(now = Date.now()) {
    if (this.db === null) return []
    try {
      const rows = this.db
        .prepare('SELECT token, user_id, name, role, source, at, expires_at, ip FROM sessions WHERE expires_at > ?')
        .all(now)
      const out = []
      for (const row of rows) {
        const token = String(row.token ?? '')
        const hashed = looksHashed(token) ? token : sessionTokenHash(token)
        /* 升级前台账里是明文 token：第一次读到就改写成哈希，之后重启不需要用户重新登录。 */
        if (hashed !== token) {
          try {
            this.db.prepare('INSERT OR REPLACE INTO sessions (token, user_id, name, role, source, at, expires_at, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
              .run(hashed, row.user_id, row.name, row.role, row.source, row.at, row.expires_at, row.ip)
            this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
          } catch (error) {
            console.warn('[dsh-studio] session token migration failed:', error?.message ?? error)
          }
        }
        out.push({
          token: hashed,
          userId: row.user_id,
          name: row.name,
          role: row.role,
          source: row.source,
          at: row.at,
          expiresAt: row.expires_at,
          ip: row.ip,
        })
      }
      return out
    } catch (error) {
      console.warn('[dsh-studio] listSessions failed:', error?.message ?? error)
      return []
    }
  }

  saveSession(session) {
    if (this.db === null) return
    try {
      const key = sessionTokenHash(session.token)
      if (key === '') return
      this.db
        .prepare('INSERT OR REPLACE INTO sessions (token, user_id, name, role, source, at, expires_at, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(key, session.userId, session.name, session.role, session.source, session.at, session.expiresAt, session.ip)
    } catch (error) {
      console.warn('[dsh-studio] saveSession failed:', error?.message ?? error)
    }
  }

  dropSession(token) {
    if (this.db === null) return
    try {
      const key = sessionTokenHash(token)
      if (key === '') return
      this.db.prepare('DELETE FROM sessions WHERE token = ?').run(key)
    } catch (error) {
      console.warn('[dsh-studio] dropSession failed:', error?.message ?? error)
    }
  }

  /** 清空全部会话（改口令后调用：旧会话不能继续用旧口令的授权）。 */
  clearSessions() {
    if (this.db === null) return
    try {
      this.db.prepare('DELETE FROM sessions').run()
    } catch (error) {
      console.warn('[dsh-studio] clearSessions failed:', error?.message ?? error)
    }
  }

  pruneSessions(now = Date.now()) {
    if (this.db === null) return
    try {
      this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)
    } catch (error) {
      console.warn('[dsh-studio] pruneSessions failed:', error?.message ?? error)
    }
  }

  async #boot() {
    try {
      const { DatabaseSync } = await import('node:sqlite')
      await mkdir(dirname(this.dbFile), { recursive: true })
      const db = new DatabaseSync(this.dbFile)
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec('PRAGMA synchronous = FULL')
      db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      db.exec('CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, revision INTEGER NOT NULL, bytes INTEGER NOT NULL, blob TEXT NOT NULL)')
      db.exec('CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ip TEXT NOT NULL)')
      // 多实例派单互斥：同一时刻只有一个进程持有派单租约（见 claimDispatchLock）。
      db.exec('CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, owner TEXT NOT NULL, at INTEGER NOT NULL)')
      this.db = db
      this.engine = 'sqlite'
      /* 台账里有会话行、需求全文与审计，默认权限别让同机其他账号随便读；
         POSIX 上收紧到 0600。WAL/SHM 由 SQLite 自己建，能改就一起改。 */
      for (const file of [this.dbFile, `${this.dbFile}-wal`, `${this.dbFile}-shm`]) {
        try { await chmod(file, 0o600) } catch { /* 文件还不存在或非 POSIX 平台 */ }
      }
    } catch (error) {
      console.warn(`[dsh-studio] sqlite unavailable, falling back to ${this.file}:`, error?.message ?? error)
      this.db = null
      this.engine = 'file'
    }
    await this.#load()
  }

  async #load() {
    let saved = null
    let imported = false
    if (this.db !== null) {
      try {
        const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('state')
        if (row !== undefined && typeof row.value === 'string') saved = JSON.parse(row.value)
      } catch (error) {
        console.warn('[dsh-studio] could not read sqlite state:', error?.message ?? error)
      }
    }
    if (saved === null) {
      try {
        const raw = await readFile(this.file, 'utf8')
        saved = JSON.parse(raw)
        imported = this.db !== null
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          console.warn(`[dsh-studio] could not read ${this.file}; starting empty:`, error?.message ?? error)
        }
      }
    }
    if (saved !== null) {
      this.state = {
        revision: Number.isInteger(saved.revision) ? saved.revision : 1,
        updatedAt: Number.isInteger(saved.updatedAt) ? saved.updatedAt : Date.now(),
        config: mergeConfig(saved.config),
        tasks: Array.isArray(saved.tasks) ? saved.tasks.map(t => ({ ...t })) : [],
        requirements: sanitizeRequirements(saved.requirements),
        releases: sanitizeReleases(saved.releases),
        audit: sanitizeAudit(saved.audit),
        fallbackFolder: saved.fallbackFolder !== null && typeof saved.fallbackFolder === 'object'
          ? {
              token: String(saved.fallbackFolder.token ?? '').slice(0, 80),
              url: String(saved.fallbackFolder.url ?? '').slice(0, 500),
              name: String(saved.fallbackFolder.name ?? '').slice(0, 200),
              at: Number(saved.fallbackFolder.at) || 0,
              error: '',
            }
          : null,
      }
    }
    /* 加载完成就把本进程的基础版本对齐磁盘 —— 单写者校验拿它比对，
       没这一步第一次写就会误判成"被其它进程改过"。 */
    this.baseRevision = this.state.revision
    await this.#hydrateSecrets()
    if (imported) {
      await this.#persist()
      console.log(`[dsh-studio] imported ${this.file} into ${this.dbFile}`)
    }
    // 历史数据里的「阻塞」曾经是一列；现在它是卡上的标记。
    for (const task of this.state.tasks) {
      if (task.blocked === undefined) task.blocked = null
      if (task.status === LEGACY_BLOCKED_STATUS) {
        task.blocked = {
          at: Number(task.updatedAt) || Date.now(),
          by: '迁移',
          reason: String(task.blockedReason ?? '').slice(0, 500),
        }
        task.status = 'clarify'
      }
      // v1 的产物是纯字符串；v2 起每一件都是带类型/状态/来源阶段的记录。
      task.artifacts = sanitizeArtifacts(task.artifacts)
      task.checklist = sanitizeChecklist(task.checklist)
      task.cases = sanitizeCases(task.cases)
      task.testRuns = sanitizeTestRuns(task.testRuns)
      // 测试计划（三层里哪一层不适用 + 理由）：老库没有这个字段，补 null 而不是 undefined。
      task.testPlan = sanitizeTestPlan(task.testPlan)
      task.coding = sanitizeCoding(task.coding)
      // 项目检查（本地质量命令）的结果：老库没有这个字段，补 null 而不是 undefined。
      task.quality = sanitizeQuality(task.quality)
      /* 设计：老库里只有 design.link（没有 drafts）。不在这里归一的话，升级后所有
         「评审已通过」的老卡都会因为「一稿都没有」被设计闸门拦在开发之外。 */
      task.design = sanitizeDesign(task.design)
      // 合并门禁结果（发布到 GitLab 的提交状态）：老库没有，补 null。
      task.mergeGate = sanitizeMergeGate(task.mergeGate)
      if (task.bugSource === undefined) task.bugSource = null
      else task.bugSource = sanitizeBugSource(task.bugSource)
      if (task.reqBaseline === undefined) task.reqBaseline = null
      if (task.worktree === undefined) task.worktree = null
      if (typeof task.pointId !== 'string') task.pointId = ''
      if (task.signoff === undefined) task.signoff = null
      else if (task.worktree !== null && (typeof task.worktree !== 'object' || typeof task.worktree.path !== 'string')) task.worktree = null
      if (typeof task.gitlabMR !== 'object' || task.gitlabMR === null) task.gitlabMR = { iid: 0, url: '', title: '', state: '' }
      if (typeof task.project !== 'string') task.project = ''
      if (typeof task.iteration !== 'string') task.iteration = ''
      if (typeof task.service !== 'string') task.service = ''
      if (!Number.isFinite(Number(task.agentFailures))) task.agentFailures = 0
      if (!Number.isFinite(Number(task.retryAt))) task.retryAt = 0
      if (typeof task.parent !== 'string') task.parent = ''
      if (!Number.isFinite(task.dueAt)) task.dueAt = 0
      if (typeof task.requirementId !== 'string') task.requirementId = ''
      if (typeof task.releaseId !== 'string') task.releaseId = ''
      if (typeof task.code !== 'string') task.code = ''
      // 老评论的作者写成「架构」「🏛️ 支付架构师」这种，统一成专家本名，接口与界面都一致。
      for (const item of task.comments ?? []) {
        if (item === null || typeof item !== 'object') continue
        const next = canonicalAuthor(item.author, this.state.config)
        if (next !== item.author) item.author = next
      }
    }
    // 先给需求补编号，再给挂在需求下的老卡补编号：DEV-001 / TEST-001 各自递增。
    for (const req of this.state.requirements) {
      if (req.code.length === 0) req.code = nextRequirementCode(this.state.requirements)
    }
    for (const task of this.state.tasks) {
      if (task.code.length > 0 || task.requirementId.length === 0) continue
      task.code = nextTaskCode(this.state.tasks, task.requirementId, CODE_PREFIX[task.type] ?? 'TASK')
    }
    // v1 的「待澄清」硬塞给产品经理；待澄清交谁由人定，清空的配置一次就好。
    if (Number(this.state.config.schema ?? 1) < 2) {
      const clarify = this.state.config.columns?.clarify
      if (clarify !== undefined && clarify.kind === 'expert' && clarify.id === 'product') {
        this.state.config.columns.clarify = { kind: 'none', id: '' }
      }
      this.state.config.schema = 2
    }
    // v2 没有独立的评审列：研发一改完就直接到测试，等于跳过评审。补一列交给架构师。
    if (Number(this.state.config.schema ?? 1) < 3) {
      const columns = this.state.config.columns ?? {}
      if (columns.review === undefined) columns.review = { kind: 'expert', id: 'architect' }
      for (const task of this.state.tasks) {
        task.cases = sanitizeCases(task.cases)
        task.checklist = sanitizeChecklist(task.checklist)
      }
      this.state.config.schema = 3
    }
    // v3 的专家只有一句 description，角色提示词是空的——面板上看着像「没配」。
    // 补齐默认提示词：空的用内置角色说明（已经写过的保持不动）。
    if (Number(this.state.config.schema ?? 1) < 4) {
      for (const expert of this.state.config.experts ?? []) {
        if (String(expert.prompt ?? '').trim() !== '') continue
        const template = DEFAULT_ROLES[expert.role]?.prompt
        if (template === undefined) continue
        expert.prompt = expert.domain ? `你是${expert.domain}业务线的${DEFAULT_ROLES[expert.role].name}。\n${template}` : template
      }
      for (const expert of this.state.config.experts ?? []) {
        expert.promptVersion = createHash('sha1').update(String(expert.prompt ?? '')).digest('hex').slice(0, 8)
      }
      this.state.config.schema = 4
    }
    // v4 里「按业务领域批量生成」写的是 13 个字的一句话提示词，等于没配：换成完整版。
    if (Number(this.state.config.schema ?? 1) < 5) {
      for (const expert of this.state.config.experts ?? []) {
        const template = DEFAULT_ROLES[expert.role]?.prompt
        if (template === undefined) continue
        if (String(expert.prompt ?? '').trim().length >= 20) continue
        expert.prompt = `你是${expert.domain || ''}业务线的${DEFAULT_ROLES[expert.role].name}。\n${template}`
        expert.promptVersion = createHash('sha1').update(expert.prompt).digest('hex').slice(0, 8)
      }
      this.state.config.schema = 5
    }
    if (Number(this.state.config.schema ?? 1) < 6) {
      // 泳道负责人不该绑死在某位领域专家上：领域专家是为具体业务需求服务的，
      // 所以把「指定了领域专家」的列改写成同名的角色位，领域在卡上再解析。
      const columns = this.state.config.columns ?? {}
      const expertById = id => (this.state.config.experts ?? []).find(entry => entry.id === id)
      const toRole = expert => (expert !== undefined && (expert.domain ?? '') !== '' && ROLE_IDS.includes(expert.role)
        ? { kind: 'role', id: expert.role }
        : undefined)
      for (const status of STATUS_IDS) {
        const owner = columns[status]
        if (owner === null || typeof owner !== 'object') continue
        if (Array.isArray(owner.members)) {
          owner.members = owner.members.map(member => (member?.kind === 'expert' ? (toRole(expertById(member.id)) ?? member) : member))
          continue
        }
        if (owner.kind !== 'expert') continue
        const role = toRole(expertById(owner.id))
        if (role !== undefined) columns[status] = { ...owner, ...role }
      }
      this.state.config.schema = 6
    }
    if (Number(this.state.config.schema ?? 1) < 7) {
      // 「角色模板」（config.roles）已废弃：新建专家、派单提示词、种子数据都不读它，
      // 只剩一条按 expert.id 找角色模型的兜底——自定义专家的 id 是 slug/hash，永远命不中。
      // 迁走最后一点有用信息：没单独指定模型的专家，按它的角色位抄一份角色模型；
      // 之后这份配置就丢掉，专家的 model 成为唯一来源。
      const legacyRoles = saved?.config?.roles
      if (legacyRoles !== null && typeof legacyRoles === 'object') {
        for (const expert of this.state.config.experts ?? []) {
          if (String(expert.model ?? '').trim() !== '') continue
          const model = legacyRoles[expert.role]?.model
          if (typeof model !== 'string' || model.trim() === '') continue
          expert.model = model.trim().slice(0, 120)
        }
      }
      this.state.config.schema = 7
    }
  }

  snapshot() {
    return this.state
  }

  /** Serialized mutation; resolves with the new snapshot. */
  async mutate(fn) {
    const run = this.chain.then(async () => {
      await this.ready
      /* 落盘失败必须回滚内存：否则调用方收到 500 去重试，而这次"失败"的改动
         会在下一次成功的写里被一起落盘 —— 一次变更变两次（实测过）。 */
      const backup = JSON.parse(JSON.stringify(this.state))
      try {
        fn(this.state)
        this.state.revision = backup.revision + 1
        this.state.updatedAt = Date.now()
        await this.#persist()
        return this.state
      } catch (error) {
        this.state = backup
        throw error
      }
    })
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * 旁路数据（集成健康这类）：单独一个 meta 键，不进 state、不涨 revision、不占快照。
   * 它们每几秒就会变一次，混进 state 只会让面板误以为看板数据变了。
   */
  async readSide(key) {
    await this.ready
    if (this.db === null) return null
    try {
      const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('side:' + key)
      return row === undefined || row === null ? null : JSON.parse(row.value)
    } catch {
      return null
    }
  }

  async writeSide(key, value) {
    await this.ready
    if (this.db === null) return
    try {
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('side:' + key, JSON.stringify(value))
    } catch {
      /* 旁路数据写不进去也不能影响业务 */
    }
  }

  /** 落盘前把密钥摘掉：库里只留「有没有配」，密钥在 600 权限的单独文件里。 */
  #serialize(dropPassword = false) {
    const plain = {
      ...this.state,
      config: structuredClone(this.state.config ?? {}),
    }
    const gitlab = plain.config.gitlab ?? {}
    if (typeof gitlab.token === 'string') gitlab.token = ''
    for (const project of Array.isArray(gitlab.projects) ? gitlab.projects : []) {
      if (typeof project.token === 'string') project.token = ''
    }
    const feishu = plain.config.feishu ?? {}
    if (typeof feishu.webhook === 'string') feishu.webhook = ''
    for (const bot of Array.isArray(feishu.bots) ? feishu.bots : []) {
      if (typeof bot.webhook === 'string') bot.webhook = ''
    }
    const ldap = plain.config.ldap ?? {}
    if (typeof ldap.bindPassword === 'string') ldap.bindPassword = ''
    /* 口令哈希也不该进 state / 快照：只有确认密钥文件里已经写成功（dropPassword）
       才摘掉。摘掉时 mustChange 写 false —— 这个 null 表示「哈希在密钥文件里」，
       不是「还是默认口令」；加载时 #hydrateSecrets 会把哈希补回来。 */
    const localAuth = plain.config.localAuth ?? {}
    if (dropPassword && localAuth.password !== null && localAuth.password !== undefined) {
      localAuth.password = null
      localAuth.mustChange = false
    }
    return plain
  }

  /** 把内存里的密钥同步进密钥文件（有就写、没了就删）。 */
  async #syncSecrets() {
    if (this.secrets === null) return
    const gitlab = {}
    const gitlabConfig = this.state.config.gitlab ?? {}
    for (const project of Array.isArray(gitlabConfig.projects) ? gitlabConfig.projects : []) {
      const token = String(project.token ?? '').trim()
      if (token !== '') gitlab[project.id] = token
    }
    const feishu = {}
    const feishuConfig = this.state.config.feishu ?? {}
    for (const bot of Array.isArray(feishuConfig.bots) ? feishuConfig.bots : []) {
      const webhook = String(bot.webhook ?? '').trim()
      if (webhook !== '') feishu[bot.id] = webhook
    }
    const password = this.state.config.localAuth?.password
    const localAuth = password !== null && typeof password === 'object' && typeof password.hash === 'string'
      ? { salt: String(password.salt ?? ''), hash: String(password.hash), at: Number(password.at) || 0 }
      : null
    await this.secrets.replace({
      gitlab,
      feishu,
      ldap: (() => {
        const password = String(this.state.config.ldap?.bindPassword ?? '').trim()
        return password === '' ? {} : { bindPassword: password }
      })(),
      legacy: {
        gitlabToken: String(gitlabConfig.token ?? '').trim(),
        feishuWebhook: String(feishuConfig.webhook ?? '').trim(),
      },
      localAuth,
    })
    this.secretsHaveLocalAuth = localAuth !== null
  }

  /** 从密钥文件把密钥补回内存（库里存的是空串）。 */
  async #hydrateSecrets() {
    if (this.secrets === null) return
    const vault = await this.secrets.load()
    const gitlabConfig = this.state.config.gitlab ?? {}
    for (const project of Array.isArray(gitlabConfig.projects) ? gitlabConfig.projects : []) {
      const token = String(project.token ?? '').trim()
      if (token === '' && typeof vault.gitlab?.[project.id] === 'string') project.token = vault.gitlab[project.id]
    }
    const feishuConfig = this.state.config.feishu ?? {}
    for (const bot of Array.isArray(feishuConfig.bots) ? feishuConfig.bots : []) {
      const webhook = String(bot.webhook ?? '').trim()
      if (webhook === '' && typeof vault.feishu?.[bot.id] === 'string') bot.webhook = vault.feishu[bot.id]
    }
    const ldapConfig = this.state.config.ldap ?? (this.state.config.ldap = sanitizeLdap({}))
    if (String(ldapConfig.bindPassword ?? '').trim() === '' && typeof vault.ldap?.bindPassword === 'string') {
      ldapConfig.bindPassword = vault.ldap.bindPassword
    }
    if (String(gitlabConfig.token ?? '').trim() === '' && typeof vault.legacy?.gitlabToken === 'string') {
      gitlabConfig.token = vault.legacy.gitlabToken
    }
    if (String(feishuConfig.webhook ?? '').trim() === '' && typeof vault.legacy?.feishuWebhook === 'string') {
      feishuConfig.webhook = vault.legacy.feishuWebhook
    }
    /* 口令哈希：state 里被摘成 null（mustChange 也只是加载时 sanitize 的默认值），
       真正的哈希在密钥文件里。这里补回来，并把 mustChange 还原成「已设过口令」。 */
    const localAuth = this.state.config.localAuth ?? (this.state.config.localAuth = { enabled: true, username: 'admin', password: null, mustChange: true, updatedAt: 0 })
    if ((localAuth.password === null || localAuth.password === undefined) && vault.localAuth !== null && typeof vault.localAuth?.hash === 'string' && vault.localAuth.hash !== '') {
      localAuth.password = {
        salt: String(vault.localAuth.salt ?? '').slice(0, 64),
        hash: String(vault.localAuth.hash).slice(0, 256),
        at: Number(vault.localAuth.at) || 0,
      }
      localAuth.mustChange = false
      this.secretsHaveLocalAuth = true
    }
  }

  async #persist() {
    await mkdir(dirname(this.file), { recursive: true })
    /* 口令哈希必须先写进密钥文件，才允许从 state 里摘掉；密钥写失败就保留在 state 里，
       宁可这次落盘多带一份哈希，也不能让重启后登录不进。 */
    let dropPassword = false
    if (this.secrets !== null) {
      try {
        await this.#syncSecrets()
        dropPassword = this.secretsHaveLocalAuth
      } catch (error) {
        /* 密钥没写成功：这一轮绝不能把哈希从 state 里摘掉，否则重启后新口令就丢了。 */
        this.secretsHaveLocalAuth = false
        console.warn('[dsh-studio] secrets write failed; keeping password hash in state for this write:', error?.message ?? error)
      }
    }
    const plain = this.#serialize(dropPassword)
    if (this.db === null) {
      const tmp = `${this.file}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(plain, null, 2), 'utf8')
      await rename(tmp, this.file)
      return
    }
    const text = JSON.stringify(plain)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      /* 单写者校验：磁盘上的 revision 必须还是我们这一轮的基础版本。
         两个进程同时开着时，后写的那个会在这里报冲突 —— 而不是把对方的改动整包覆盖掉。 */
      const row = this.db.prepare("SELECT value FROM meta WHERE key = 'state'").get()
      if (row !== undefined && row !== null) {
        let stored = 0
        try { stored = Number(JSON.parse(row.value)?.revision ?? 0) } catch { stored = 0 }
        if (stored !== this.baseRevision) {
          throw new Error(`状态已被其它进程修改（磁盘 revision=${stored}，本进程基于 ${this.baseRevision}）：这次改动没有保存，请刷新后重试`)
        }
      }
      this.db.prepare('INSERT INTO snapshots (at, revision, bytes, blob) VALUES (?, ?, ?, ?)')
        .run(Date.now(), plain.revision, text.length, text)
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('state', text)
      this.db.prepare('DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT ?)')
        .run(this.snapshotLimit)
      this.db.exec('COMMIT')
      this.baseRevision = plain.revision
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* ignore */ }
      throw error
    }
  }

  /** 最近若干次落盘的快照（不含正文，列表用）。 */
  snapshots() {
    if (this.db === null) return []
    try {
      return this.db.prepare('SELECT id, at, revision, bytes FROM snapshots ORDER BY id DESC LIMIT 50').all()
        .map(row => ({ id: Number(row.id), at: Number(row.at), revision: Number(row.revision), bytes: Number(row.bytes) }))
    } catch (error) {
      console.warn('[dsh-studio] could not list snapshots:', error?.message ?? error)
      return []
    }
  }

  /** 回滚到某个快照（会先给当前状态再存一版，避免回滚本身丢数据）。 */
  async restoreSnapshot(id) {
    if (this.db === null) throw new Error('当前是单文件模式，没有快照可回滚')
    const row = this.db.prepare('SELECT blob FROM snapshots WHERE id = ?').get(Number(id))
    if (row === undefined) throw new Error(`没有快照 ${id}`)
    const saved = JSON.parse(String(row.blob))
    await this.#persist()
    this.state = {
      revision: this.state.revision + 1,
      updatedAt: Date.now(),
      config: mergeConfig(saved.config),
      tasks: Array.isArray(saved.tasks) ? saved.tasks.map(task => ({ ...task })) : [],
      requirements: sanitizeRequirements(saved.requirements),
      releases: sanitizeReleases(saved.releases),
      audit: sanitizeAudit(saved.audit),
      fallbackFolder: saved.fallbackFolder ?? null,
    }
    await this.#hydrateSecrets()
    await this.#persist()
    return this.state
  }

  /** 给面板看的存储信息。 */
  describe() {
    return {
      engine: this.engine,
      db: this.engine === 'sqlite' ? this.dbFile : this.file,
      legacyFile: this.file,
      snapshotLimit: this.snapshotLimit,
      snapshots: this.snapshots().length,
      secretsFile: this.secrets === null ? '' : this.secrets.file,
    }
  }
}

