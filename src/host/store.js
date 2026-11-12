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
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[dsh-studio] could not read secrets file:', error?.message ?? error)
      this.cache = { gitlab: {}, feishu: {}, ldap: {}, legacy: {} }
    }
    return this.cache
  }

  async replace(next) {
    this.cache = {
      gitlab: next?.gitlab ?? {},
      feishu: next?.feishu ?? {},
      ldap: next?.ldap ?? {},
      legacy: next?.legacy ?? {},
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
      return rows.map(row => ({
        token: row.token,
        userId: row.user_id,
        name: row.name,
        role: row.role,
        source: row.source,
        at: row.at,
        expiresAt: row.expires_at,
        ip: row.ip,
      }))
    } catch (error) {
      console.warn('[dsh-studio] listSessions failed:', error?.message ?? error)
      return []
    }
  }

  saveSession(session) {
    if (this.db === null) return
    try {
      this.db
        .prepare('INSERT OR REPLACE INTO sessions (token, user_id, name, role, source, at, expires_at, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(session.token, session.userId, session.name, session.role, session.source, session.at, session.expiresAt, session.ip)
    } catch (error) {
      console.warn('[dsh-studio] saveSession failed:', error?.message ?? error)
    }
  }

  dropSession(token) {
    if (this.db === null) return
    try {
      this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
    } catch (error) {
      console.warn('[dsh-studio] dropSession failed:', error?.message ?? error)
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
      task.coding = sanitizeCoding(task.coding)
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
  }

  snapshot() {
    return this.state
  }

  /** Serialized mutation; resolves with the new snapshot. */
  async mutate(fn) {
    const run = this.chain.then(async () => {
      await this.ready
      fn(this.state)
      this.state.revision += 1
      this.state.updatedAt = Date.now()
      await this.#persist()
      return this.state
    })
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  /** 落盘前把密钥摘掉：库里只留「有没有配」，密钥在 600 权限的单独文件里。 */
  #serialize() {
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
    })
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
  }

  async #persist() {
    await mkdir(dirname(this.file), { recursive: true })
    const plain = this.#serialize()
    if (this.db === null) {
      const tmp = `${this.file}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(plain, null, 2), 'utf8')
      await rename(tmp, this.file)
      await this.#syncSecrets()
      return
    }
    const text = JSON.stringify(plain)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO snapshots (at, revision, bytes, blob) VALUES (?, ?, ?, ?)')
        .run(Date.now(), plain.revision, text.length, text)
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('state', text)
      this.db.prepare('DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT ?)')
        .run(this.snapshotLimit)
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* ignore */ }
      throw error
    }
    await this.#syncSecrets()
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

