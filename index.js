/**
 * dsh-studio — host half.
 *
 * Owns three things and nothing else:
 *   1. the studio settings file (GitLab / Feishu / role→model mapping),
 *   2. the work ledger (tasks + comments + status history),
 *   3. the `/studio-api` HTTP surface used by the browser panel, plus the
 *      `studio_*` agent tools used by the role agents.
 *
 * No @deepseek-ai runtime imports: the published copy must never resolve a
 * mirror SDK package from the profile's node_modules.
 *
 * @module dsh-studio
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Cordis plugin name. */
export const name = 'dsh-studio'

/** Required host services. */
export const inject = ['tools', 'systemPrompt']

// ------------------------------------------------------------------ domain


import { ACCESS_ROLE_LABEL, ACCESS_ROLES, ADMIN_ROUTES, ARTIFACT_KINDS, ARTIFACT_STATUS, CASE_HTTP_METHODS, CASE_PRIORITIES, CASE_RESULTS, CASE_TYPE_LABEL, CASE_TYPES, cleanId, CODE_PREFIX, CODING_FILE_CHANGES, CODING_REVIEW_STATUS, codingSummary, COLUMN_STRATEGIES, DEFAULT_ROLES, defaultColumns, defaultConfig, defaultDeployEnvs, defaultTemplates, DEPLOY_ENV_KINDS, FALLBACK_AGENT_MODEL, hashLocalPassword, INTAKE_HTML, ISOLATION_MODES, LEGACY_BLOCKED_STATUS, LEVEL_RANK, LOCAL_DEFAULT_PASSWORD, mergeCoding, mergeConfig, mergeSection, MINE_HTML, nextRequirementCode, nextTaskCode, normalizePatch, normalizeStrategy, publicArtifact, PRIORITIES, ROLE_LABELS, canonicalAuthor, RELEASE_STATUSES, RELEASE_STATUS_LABEL, REQ_DOC_KIND_LABEL, REQ_DOC_KINDS, REQ_DOC_STATUS, REQ_REVIEW_LABEL, REQ_REVIEW_STATUS, REQ_STATUS_LABEL, REQ_STATUSES, ROLE_IDS, ROLE_LEVEL, SANDBOX_MODES, sanitizeAcceptanceItem, sanitizeAccess, sanitizeAllowHosts, sanitizeArtifact, sanitizeArtifacts, sanitizeBaseline, sanitizeBots, sanitizeBugSource, sanitizeCase, sanitizeCaseHttp, sanitizeCaseRun, sanitizeCases, sanitizeChangedFile, sanitizeChangedFiles, sanitizeChecklist, sanitizeChecklistItem, sanitizeCoding, sanitizeColumns, sanitizeCommit, sanitizeCommits, sanitizeCosts, sanitizeDeployEnvs, sanitizeEnvs, sanitizeExperts, sanitizeIterations, sanitizeLdap, sanitizeLocalAuth, sanitizeProjects, sanitizeReqDoc, sanitizeReqDocs, sanitizeRelease, sanitizeRequirement, sanitizeRequirementChange, sanitizeRequirementHistory, sanitizeRequirementPoint, sanitizeRequirementPoints, sanitizeRequirementPool, sanitizeRequirementQuestions, sanitizeRequirementReview, sanitizeRequirements, sanitizeServices, sanitizeSla, sanitizeTeams, sanitizeTemplates, sanitizeTesting, sanitizeTestRun, sanitizeTestRuns, sanitizeUsers, sanitizeWorkProjects, seedExperts, SEVERITIES, STATUS_HTML, STATUS_IDS, STATUS_SET, STATUSES, TASK_TYPES, text, verifyLocalPassword, worktreeRoot } from './src/host/domain.js'
import { Dispatcher, RUN_LOG, claimDispatchLock, clearAgentFailure, configureDispatcher, noteAgentFailure, parseMentions, runSummary } from './src/host/dispatcher.js'
import { buildDashboard, codingVerifyLine, commentTask, configureExecutor, ensureReqFolder, larkCliReady, invalidateLarkProbe, larkProbeCache, mutateReqDoc, pullFeishuDoc, requirementGate, requirementMatrix, requirementProgress, requirementRollup, runCommand, runSuite, runTaskCases, saveRequirement, syncArtifact, syncRequirementArtifacts, taskExitGate, updateTask, verifyCodingRecord } from './src/host/executor.js'
import { configureAuthRoutes, handleAuthRoute } from './src/host/routes/auth.js'
import { configureExportRoutes, handleExportRoute } from './src/host/routes/exports.js'
import { configureTaskRoutes, handleTaskRoute } from './src/host/routes/tasks.js'
import { configureRequirementRoutes, handleRequirementRoute } from './src/host/routes/requirements.js'
import { configureReleasesRoutes, handleReleasesRoute } from './src/host/routes/releases.js'
import { configureAgentsRoutes, handleAgentsRoute } from './src/host/routes/agents.js'
import { configureCodingRoutes, handleCodingRoute } from './src/host/routes/coding.js'
import { configureToolHost, registerTools } from './src/host/tools.js'
import { configureConnectRoutes, handleConnectRoute } from './src/host/routes/connect.js'
import { configureInsightsRoutes, handleInsightsRoute } from './src/host/routes/insights.js'
import { configureAdminRoutes, handleAdminRoute } from './src/host/routes/admin.js'
import { configureSkillsRoutes, handleSkillsRoute } from './src/host/routes/skills.js'
import { INTEGRATION, markHealth, escalateHealth, healthReport, projectReady, gitlabReady, gitlabRequest, gitlabSync, feishuPush, feishuBroadcast, broadcastChange, configureIntegrations } from './src/host/integrations.js'
import { SecretStore, StudioStore } from './src/host/store.js'

function upsertById(list, incoming) {
  const arrivals = Array.isArray(list) ? [...list] : []
  if (incoming === null || typeof incoming !== 'object') return arrivals
  const id = String(incoming.id ?? '').trim()
  if (id.length === 0) return [...arrivals, incoming]
  const index = arrivals.findIndex(entry => entry.id === id)
  if (index >= 0) arrivals[index] = { ...arrivals[index], ...incoming }
  else arrivals.push(incoming)
  return arrivals
}

/** DSH home, honouring DSH_HOME. */
function dshHomePath(...segments) {
  const override = process.env.DSH_HOME
  const home = resolve(override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh'))
  return join(home, ...segments)
}

// ------------------------------------------------------------- skill library

/**
 * Where the agent runtime looks for skills: `<DSH_HOME>/skills/<name>/SKILL.md`.
 * Writing here makes a skill real — every agent's `skill` tool can load it,
 * which is what turns this panel from a text box into a working capability.
 */
function skillsRoot() {
  return dshHomePath('skills')
}

/** The skill-name grammar the DSH registry validates against (kebab-case). */
function isSkillName(value) {
  const name = String(value ?? '')
  return name.length > 0 && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
}

/** Coerce whatever the caller sent into a storable skill row. */
function sanitizeSkill(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const name = String(raw.name ?? '').trim().toLowerCase()
  if (!isSkillName(name)) return undefined
  const content = String(raw.content ?? '')
  const description = (String(raw.description ?? '').trim() || content.trim().split('\n')[0] || name).slice(0, 300)
  const tags = (Array.isArray(raw.tags) ? raw.tags : String(raw.tags ?? '').split(/[,，\s]+/))
    .map(tag => String(tag ?? '').trim().slice(0, 30))
    .filter(tag => tag.length > 0)
    .filter((tag, index, all) => all.indexOf(tag) === index)
    .slice(0, 8)
  return {
    name,
    description,
    whenToUse: String(raw.whenToUse ?? '').trim().slice(0, 400),
    content: content.slice(0, 60_000),
    tags,
    enabled: raw.enabled !== false,
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt.length > 0 ? raw.updatedAt : new Date().toISOString(),
  }
}

/** Coerce a saved library file into skill rows. */
function sanitizeSkills(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const raw of input.slice(0, 200)) {
    const skill = sanitizeSkill(raw)
    if (skill === undefined || seen.has(skill.name)) continue
    seen.add(skill.name)
    out.push(skill)
  }
  return out
}

/** The SKILL.md text (YAML frontmatter + body) for one library row. */
function skillMarkdown(skill) {
  const lines = ['---', `name: ${skill.name}`, `description: ${skill.description.replace(/\n/g, ' ')}`]
  if (skill.whenToUse.length > 0) lines.push(`whenToUse: ${skill.whenToUse.replace(/\n/g, ' ')}`)
  if (skill.tags.length > 0) lines.push(`tags: ${skill.tags.join(', ')}`)
  lines.push('---', '', skill.content.trim(), '')
  return lines.join('\n')
}

/** Split `---` frontmatter into `{fields, body}`; no frontmatter → all body. */
function splitFrontmatter(source) {
  const text = String(source ?? '').replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (match === null) return { fields: {}, body: text }
  const fields = {}
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()
    if (value.length >= 2) {
      const first = value[0]
      const last = value[value.length - 1]
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1)
    }
    if (key.length > 0) fields[key] = value
  }
  return { fields, body: match[2] }
}

/** kebab-case slug from arbitrary text; non-ASCII text falls back to a hash. */
function slugifySkill(value) {
  const ascii = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  if (ascii.length >= 2) return ascii
  return `skill-${createHash('sha1').update(String(value ?? '')).digest('hex').slice(0, 6)}`
}

/**
 * Turn an uploaded `SKILL.md` into a library row.
 *
 * Precedence for the name: frontmatter `name` → filename → heading → hash, so
 * a skill exported by another tool keeps its identity on the way in.
 */
function skillFromMarkdown(fileName, source) {
  const { fields, body } = splitFrontmatter(source)
  const base = String(fileName ?? '').split('/').pop().replace(/\.(md|markdown|txt)$/i, '')
  const declared = String(fields.name ?? '').trim().toLowerCase()
  const name = isSkillName(declared) ? declared : slugifySkill(declared || base)
  const heading = (body.match(/^#\s+(.+)$/m) ?? [])[1] ?? ''
  const description = String(fields.description ?? '').trim() || heading.trim() || name
  return {
    name,
    description,
    whenToUse: String(fields.whenToUse ?? fields.when_to_use ?? '').trim(),
    content: body.trim(),
    tags: String(fields.tags ?? '').replace(/[[\]]/g, '').split(/[,，\s]+/).filter(Boolean),
    enabled: true,
  }
}

/**
 * Pull `SKILL.md` out of an uploaded `.zip`.
 *
 * Uses the system `unzip`; when it is missing we say so instead of failing
 * with a stack trace, because a single Markdown file always works.
 */
async function skillFromZip(buffer) {
  const tmp = join(dshHomePath('tmp'), `skill-upload-${randomBytes(4).toString('hex')}.zip`)
  await mkdir(dirname(tmp), { recursive: true })
  await writeFile(tmp, buffer)
  try {
    const listing = await runCommand('unzip', ['-Z1', tmp], 15000)
    if (!listing.ok) {
      const hint = String(listing.stderr || '').split('\n')[0].slice(0, 120)
      return { ok: false, error: `服务器上解不了 .zip（${hint || 'unzip 不可用'}）。可以直接上传 SKILL.md。` }
    }
    const entries = listing.stdout.split('\n').map(line => line.trim()).filter(Boolean)
    const target = entries.find(entry => /(^|\/)SKILL\.md$/i.test(entry))
    if (target === undefined) return { ok: false, error: '压缩包里没有 SKILL.md：技能包应该把 SKILL.md 放在根目录或同名子目录里。' }
    const dump = await runCommand('unzip', ['-p', tmp, target], 15000)
    if (!dump.ok) return { ok: false, error: `解压失败：${String(dump.stderr).split('\n')[0].slice(0, 160)}` }
    return { ok: true, fileName: target, text: dump.stdout }
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

/**
 * The company skill catalogue.
 *
 * Kept in its own file rather than inside the settings blob: skill bodies are
 * long, and the panel polls `/studio-api/state` every few seconds.
 * Every write is mirrored to `<DSH_HOME>/skills/<name>/SKILL.md` so the runtime
 * skill registry picks it up for the next agent session.
 */
class SkillLibrary {
  constructor(file) {
    this.file = file
    this.state = { version: 1, skills: [], synced: [] }
    this.chain = Promise.resolve()
    this.ready = this.load()
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'))
      this.state = {
        version: 1,
        skills: sanitizeSkills(raw?.skills),
        synced: Array.isArray(raw?.synced) ? raw.synced.filter(name => typeof name === 'string') : [],
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  snapshot() {
    return this.state
  }

  list() {
    return this.state.skills.map(skill => ({ ...skill }))
  }

  get(name) {
    return this.state.skills.find(skill => skill.name === name)
  }

  /** Serialize every mutation behind one chain so two saves cannot interleave. */
  async mutate(change) {
    const run = this.chain.then(async () => {
      await this.ready
      const draft = {
        version: 1,
        skills: this.state.skills.map(skill => ({ ...skill })),
        synced: [...this.state.synced],
      }
      const result = await change(draft)
      await this.persist(draft)
      this.state = draft
      return result
    })
    this.chain = run.catch(() => {})
    return run
  }

  async persist(next) {
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
    await rename(tmp, this.file)
  }

  /** Write one skill to disk; returns the absolute SKILL.md path. */
  async materialize(skill) {
    if (skill.enabled === false) {
      await this.forget(skill.name)
      return undefined
    }
    const dir = join(skillsRoot(), skill.name)
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'SKILL.md')
    await writeFile(file, skillMarkdown(skill), 'utf8')
    return file
  }

  /** Remove a materialized skill directory we own. */
  async forget(name) {
    await rm(join(skillsRoot(), name), { recursive: true, force: true }).catch(() => {})
  }

  /**
   * Write every enabled skill to disk and drop directories this library
   * created but no longer declares. Directories it never created are left
   * alone, so hand-written skills in the same root survive.
   */
  async syncAll() {
    return this.mutate(async draft => {
      const written = []
      const keep = new Set()
      for (const skill of draft.skills) {
        if (skill.enabled === false) continue
        keep.add(skill.name)
        try {
          await this.materialize(skill)
          written.push(skill.name)
        } catch {
          // A single unwritable skill must not abort the rest of the library.
        }
      }
      for (const name of draft.synced) {
        if (!keep.has(name)) await this.forget(name)
      }
      draft.synced = [...keep]
      return { written }
    })
  }

  /** Create or replace one skill and push it to disk. */
  async save(input) {
    const skill = sanitizeSkill({ ...input, updatedAt: new Date().toISOString() })
    if (skill === undefined) throw new Error('技能名必须是 kebab-case（小写字母、数字、连字符），例如 release-checklist')
    return this.mutate(async draft => {
      const index = draft.skills.findIndex(entry => entry.name === skill.name)
      if (index === -1) draft.skills.push(skill)
      else draft.skills[index] = skill
      if (!draft.synced.includes(skill.name)) draft.synced.push(skill.name)
      let file
      let warning
      try {
        file = await this.materialize(skill)
      } catch (error) {
        // Keep the row: the body is still worth keeping, and the next boot
        // sync will retry the write.
        warning = `技能已存库，但写入 SKILL.md 失败：${error instanceof Error ? error.message : String(error)}`
      }
      return { skill, file, warning }
    })
  }

  /** Delete one skill from the library and from disk. */
  async remove(name) {
    return this.mutate(async draft => {
      const index = draft.skills.findIndex(entry => entry.name === name)
      if (index === -1) throw new Error(`no skill ${name}`)
      draft.skills.splice(index, 1)
      draft.synced = draft.synced.filter(entry => entry !== name)
      await this.forget(name)
      return { name }
    })
  }

  /** Names of skills the runtime can currently see, for a live cross-check. */
  async visibleRoots() {
    try {
      const entries = await readdir(skillsRoot(), { withFileTypes: true })
      return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }
}

/** The library the HTTP routes and tools share. Set in `apply()`. */
let activeSkills

/** A short, readable task id. */
function newTaskId() {
  return `t-${randomBytes(4).toString('hex')}`
}

/** Trimmed string or undefined. */
// -------------------------------------------------------------------- http

/** Write one CSV response (Excel 友好：带 BOM，逗号字段加引号转义)。 */
function sendCsv(res, rows, filename) {
  const escape = value => {
    const text = String(value ?? '')
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const payload = Buffer.from(`\uFEFF${rows.map(row => row.map(escape).join(',')).join('\r\n')}\r\n`, 'utf8')
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
    'content-length': payload.length,
  })
  res.end(payload)
}

/** Write one JSON response. */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Read and parse a JSON request body. */
async function readJsonBody(req) {
  if (req.__studioBody !== undefined) return req.__studioBody
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 2_000_000) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object')
  return parsed
}

/** Settings as the browser may see them: secrets replaced by presence flags. */
function publicConfig(config) {
  return {
    board: config.board,
    experts: config.experts,
    teams: config.teams,
    columns: config.columns,
    gitlab: {
      url: config.gitlab.url,
      group: config.gitlab.group,
      project: config.gitlab.project,
      tokenSet: config.gitlab.token.length > 0,
      syncEnabled: config.gitlab.syncEnabled,
      syncLabel: config.gitlab.syncLabel,
      lastSyncAt: config.gitlab.lastSyncAt,
      lastSyncError: config.gitlab.lastSyncError,
      projects: config.gitlab.projects.map(project => ({
        id: project.id,
        name: project.name,
        url: project.url,
        project: project.project,
        group: project.group,
        tokenSet: project.token.length > 0,
        syncEnabled: project.syncEnabled,
        syncLabel: project.syncLabel,
        lastSyncAt: project.lastSyncAt,
        lastSyncError: project.lastSyncError,
      })),
    },
    feishu: {
      appId: config.feishu.appId,
      chatId: config.feishu.chatId,
      baseToken: config.feishu.baseToken,
      tableId: config.feishu.tableId,
      appSecretSet: config.feishu.appSecret.length > 0,
      webhookSet: config.feishu.webhook.length > 0,
      notifyOnChange: config.feishu.notifyOnChange,
      driveFolder: config.feishu.driveFolder,
      autoSyncArtifacts: config.feishu.autoSyncArtifacts,
      escalateWebhookSet: String(config.feishu.escalateWebhook ?? '').length > 0,
      escalateAfter: config.feishu.escalateAfter,
      larkReady: larkProbeCache.ok,
      bots: config.feishu.bots.map(bot => ({
        id: bot.id,
        name: bot.name,
        chatId: bot.chatId,
        webhookSet: bot.webhook.length > 0,
        webhookHint: bot.webhook.length > 8 ? `…${bot.webhook.slice(-6)}` : '',
        events: bot.events,
        notifyOnChange: bot.notifyOnChange,
        enabled: bot.enabled,
      })),
    },
    roles: config.roles,
    projects: config.projects,
    templates: config.templates,
    market: config.market,
    agents: config.agents,
    testing: config.testing,
    access: config.access,
    sla: config.sla,
    costs: config.costs,
    /** 部署环境：只用于登记「版本上过哪个环境」，不触发部署。 */
    environments: config.environments ?? defaultDeployEnvs(),
    /** 发布准入规则：要求先上预发 / 要求需求签字。 */
    releaseRules: config.releaseRules ?? { requireStaging: false, requireRequirementSignoff: false },
    /** 统一登录：只回配置和「密码有没有存过」，密码本身永远不出服务端。 */
    ldap: (() => {
      const ldap = sanitizeLdap(config.ldap ?? {})
      return {
        enabled: ldap.enabled,
        url: ldap.url,
        baseDN: ldap.baseDN,
        bindDN: ldap.bindDN,
        userFilter: ldap.userFilter,
        nameAttr: ldap.nameAttr,
        mailAttr: ldap.mailAttr,
        deptAttr: ldap.deptAttr,
        defaultRole: ldap.defaultRole,
        requireLogin: ldap.requireLogin,
        timeoutMs: ldap.timeoutMs,
        bindPasswordSet: String(ldap.bindPassword ?? '').length > 0,
      }
    })(),
    /** 本地超管账号（口令永远不下发，只告诉有没有设过）。 */
    localAuth: (() => {
      const local = sanitizeLocalAuth(config.localAuth)
      return {
        enabled: local.enabled,
        username: local.username,
        hasPassword: local.password !== null,
        mustChange: local.mustChange,
        updatedAt: local.updatedAt,
      }
    })(),
    /** 登录过的人（LDAP 同步 + 最近登录情况）。 */
    users: config.users ?? [],
  }
}

/** 一个项目的进度体检：每列多少卡、多少阻塞/逾期、缺陷、清单完成度、周期。 */
function projectMetrics(tasks, now) {
  const byStatus = {}
  for (const status of STATUS_IDS) byStatus[status] = 0
  let blocked = 0
  let overdue = 0
  let bugs = 0
  let done = 0
  let checkTotal = 0
  let checkDone = 0
  let artifacts = 0
  let cycleSum = 0
  let cycleCount = 0
  let throughput = 0
  let codingTasks = 0
  let filesChanged = 0
  let testsTotal = 0
  let testsPassed = 0
  let reviewed = 0
  let merged = 0
  const week = 7 * 24 * 3600 * 1000
  for (const task of tasks) {
    if (byStatus[task.status] !== undefined) byStatus[task.status] += 1
    if (task.blocked !== null && task.blocked !== undefined) blocked += 1
    if (task.dueAt > 0 && task.dueAt < now && task.status !== 'done') overdue += 1
    if (task.type === 'bug' && task.status !== 'done') bugs += 1
    if (task.status === 'done') {
      done += 1
      if (task.updatedAt > now - week) throughput += 1
      cycleSum += Math.max(0, task.updatedAt - task.createdAt)
      cycleCount += 1
    }
    for (const item of task.checklist ?? []) {
      checkTotal += 1
      if (item.done) checkDone += 1
    }
    artifacts += (task.artifacts ?? []).length
    if (task.coding !== null && task.coding !== undefined) {
      codingTasks += 1
      filesChanged += task.coding.files.length
      if (task.coding.unitTests.total > 0) { testsTotal += task.coding.unitTests.total; testsPassed += task.coding.unitTests.passed }
      if (task.coding.review.status === 'approved') reviewed += 1
      if (task.coding.mergedAt > 0) merged += 1
    }
  }
  const inProgress = tasks.filter(task => task.status !== 'done').length
  return {
    total: tasks.length,
    byStatus,
    inProgress,
    blocked,
    overdue,
    bugs,
    done,
    checklist: { total: checkTotal, done: checkDone },
    checklistRate: checkTotal > 0 ? Math.round((checkDone / checkTotal) * 100) : 0,
    artifacts,
    avgCycleMs: cycleCount > 0 ? Math.round(cycleSum / cycleCount) : 0,
    cycleDays: cycleCount > 0 ? Math.round((cycleSum / cycleCount / DAY) * 10) / 10 : 0,
    throughput7d: throughput,
    coding: { tasks: codingTasks, files: filesChanged, tests: testsTotal, testsPassed, reviewed, merged },
  }
}

/** 按项目汇总，外加「没挂项目」的那一堆。 */
function buildMetrics(state) {
  const now = Date.now()
  const projects = state.config.projects.map(project => {
    const tasks = state.tasks.filter(task => task.project === project.id)
    return {
      id: project.id,
      name: project.name,
      key: project.key,
      status: project.status,
      iterations: project.iterations,
      metrics: projectMetrics(tasks, now),
    }
  })
  const assigned = new Set(state.config.projects.map(project => project.id))
  const loose = state.tasks.filter(task => task.project === '' || !assigned.has(task.project))
  return { projects, unassigned: projectMetrics(loose, now), all: projectMetrics(state.tasks, now) }
}

// --------------------------------------------------------------- analytics
// 效能看的是「过程和返工」，不是卡片数：一次通过率、返工率、周期分布、
// 每一列停留多久、AI 交付物被人采纳多少。

const ANALYTICS_DAYS = [7, 30, 90]

function percentile(values, ratio) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))
  return sorted[index]
}

const DAY = 86_400_000

/** 把一张卡的历史折成「走过哪些列、倒退过几次、每列待了多久」。 */
function taskTimeline(task) {
  const history = Array.isArray(task.history) ? task.history : []
  const steps = []
  for (const entry of history) {
    const status = String(entry?.status ?? '')
    if (status === '' || !STATUS_IDS.includes(status)) continue
    if (steps.length > 0 && steps[steps.length - 1].status === status) {
      // 同一列重复记录（比如阻塞/解除）合并，但保留最后一次时间
      steps[steps.length - 1].at = Number(entry.at) || steps[steps.length - 1].at
      continue
    }
    steps.push({ status, at: Number(entry.at) || 0, by: String(entry?.by ?? ''), note: String(entry?.note ?? '') })
  }
  if (steps.length === 0) {
    steps.push({ status: task.status, at: Number(task.createdAt) || 0, by: '', note: '' })
  }
  const rank = status => STATUS_IDS.indexOf(status)
  let backward = 0
  let reviewBack = 0
  let testBack = 0
  const dwell = {}
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    const next = steps[index + 1]
    const until = next === undefined ? Date.now() : next.at
    const span = Math.max(0, until - step.at)
    dwell[step.status] = (dwell[step.status] ?? 0) + span
    if (next === undefined) continue
    if (rank(next.status) < rank(step.status)) {
      backward += 1
      if (step.status === 'review') reviewBack += 1
      if (step.status === 'test' || step.status === 'accept') testBack += 1
    }
  }
  const doneStep = steps.find(step => step.status === 'done')
  return {
    steps,
    backward,
    reviewBack,
    testBack,
    dwell,
    doneAt: doneStep === undefined ? 0 : doneStep.at,
    columns: steps.length,
  }
}

function buildAnalytics(state, options = {}) {
  const now = Date.now()
  const requested = Number(options.days)
  const days = ANALYTICS_DAYS.includes(requested) ? requested : 30
  const since = now - days * DAY
  const project = String(options.project ?? '').trim()
  const inScope = state.tasks.filter(task => {
    if (project !== '' && task.project !== project) return false
    const createdAt = Number(task.createdAt) || 0
    return createdAt >= since || task.status !== 'done'
  })

  const expertNames = new Set((state.config.experts ?? []).map(expert => expert.name))
  let moved = 0
  let reworked = 0
  let reviewRework = 0
  let testRework = 0
  let done = 0
  let doneFirstPass = 0
  const cycleValues = []
  const buckets = { fast: 0, normal: 0, slow: 0, verySlow: 0 }
  const dwellTotals = {}
  const dwellCounts = {}
  const worst = []

  for (const task of inScope) {
    const timeline = taskTimeline(task)
    if (timeline.steps.length > 1) moved += 1
    if (timeline.backward > 0) {
      reworked += 1
      worst.push({ id: task.id, code: task.code ?? '', title: task.title, backward: timeline.backward, status: task.status })
    }
    if (timeline.reviewBack > 0) reviewRework += 1
    if (timeline.testBack > 0) testRework += 1
    for (const [status, span] of Object.entries(timeline.dwell)) {
      if (span <= 0) continue
      dwellTotals[status] = (dwellTotals[status] ?? 0) + span
      dwellCounts[status] = (dwellCounts[status] ?? 0) + 1
    }
    if (timeline.doneAt > 0 && timeline.doneAt >= since) {
      done += 1
      const cycle = Math.max(0, timeline.doneAt - (Number(task.createdAt) || timeline.doneAt))
      cycleValues.push(cycle)
      if (timeline.backward === 0) doneFirstPass += 1
      const cycleDays = cycle / DAY
      if (cycleDays <= 1) buckets.fast += 1
      else if (cycleDays <= 3) buckets.normal += 1
      else if (cycleDays <= 7) buckets.slow += 1
      else buckets.verySlow += 1
    }
  }

  // AI 产出：交付物是谁登记的、有没有被人验收；Coding 记录评审通过率。
  let artifactsTotal = 0
  let artifactsAi = 0
  let artifactsAiAccepted = 0
  let artifactsAiEmpty = 0
  let artifactsEmpty = 0
  let codingTasks = 0
  let codingApproved = 0
  let codingChanges = 0
  let testsTotal = 0
  let testsPassed = 0
  let merged = 0
  for (const task of inScope) {
    for (const artifact of task.artifacts ?? []) {
      if (typeof artifact !== 'object' || artifact === null) continue
      artifactsTotal += 1
      const by = String(artifact.by ?? '')
      const empty = String(artifact.content ?? '').trim() === ''
      if (empty) artifactsEmpty += 1
      const isAi = expertNames.has(by) || by.trim().toLowerCase() === 'agent'
      if (!isAi) continue
      artifactsAi += 1
      if (artifact.status === 'accepted') artifactsAiAccepted += 1
      if (empty) artifactsAiEmpty += 1
    }
    const coding = task.coding
    if (coding !== null && typeof coding === 'object') {
      codingTasks += 1
      if (coding.review?.status === 'approved') codingApproved += 1
      if (coding.review?.status === 'changes_requested') codingChanges += 1
      testsTotal += Number(coding.unitTests?.total) || 0
      testsPassed += Number(coding.unitTests?.passed) || 0
      if (coding.mergedAt > 0) merged += 1
    }
  }

  const throughput = []
  for (let offset = Math.min(days, 14) - 1; offset >= 0; offset -= 1) {
    const start = new Date(now - offset * DAY)
    start.setHours(0, 0, 0, 0)
    const from = start.getTime()
    const to = from + DAY
    let count = 0
    for (const task of inScope) {
      const timeline = taskTimeline(task)
      if (timeline.doneAt >= from && timeline.doneAt < to) count += 1
    }
    throughput.push({ day: `${start.getMonth() + 1}-${String(start.getDate()).padStart(2, '0')}`, from, count })
  }

  const columnDwell = STATUS_IDS.map(status => ({
    status,
    label: STATUSES.find(entry => entry.id === status)?.label ?? status,
    avgDays: dwellCounts[status] > 0 ? dwellTotals[status] / dwellCounts[status] / DAY : 0,
    cards: dwellCounts[status] ?? 0,
  }))

  const rate = (value, total) => (total > 0 ? value / total : 0)

  return {
    days,
    project,
    generatedAt: now,
    scope: { tasks: inScope.length, moved, done },
    cycle: {
      count: cycleValues.length,
      avgDays: cycleValues.length > 0 ? cycleValues.reduce((sum, value) => sum + value, 0) / cycleValues.length / DAY : 0,
      medianDays: percentile(cycleValues, 0.5) / DAY,
      p90Days: percentile(cycleValues, 0.9) / DAY,
      buckets: [
        { id: 'fast', label: '≤1 天', count: buckets.fast },
        { id: 'normal', label: '1–3 天', count: buckets.normal },
        { id: 'slow', label: '3–7 天', count: buckets.slow },
        { id: 'verySlow', label: '>7 天', count: buckets.verySlow },
      ],
    },
    rework: {
      moved,
      reworked,
      rate: rate(reworked, moved),
      reviewRework,
      testRework,
      firstPassRate: rate(doneFirstPass, done),
      worst: worst.sort((a, b) => b.backward - a.backward).slice(0, 8),
    },
    columns: columnDwell,
    throughput,
    ai: {
      artifactsTotal,
      artifactsAi,
      artifactsEmpty,
      aiShare: rate(artifactsAi, artifactsTotal),
      accepted: artifactsAiAccepted,
      acceptedRate: rate(artifactsAiAccepted, artifactsAi),
      emptyBody: artifactsEmpty,
      aiEmptyBody: artifactsAiEmpty,
      codingTasks,
      codingApproved,
      codingChanges,
      codingApprovedRate: rate(codingApproved, codingTasks),
      unitTests: testsTotal,
      unitPassed: testsPassed,
      unitPassRate: rate(testsPassed, testsTotal),
      merged,
    },
  }
}

// ------------------------------------------------------------ releases
// 版本不是「打个 tag」：它把一批卡、它们的验收结果、缺陷状态捆在一起，
// 只在门禁通过时才能发布，发布后还能回滚并留下原因。


/** 冒烟清单：发布前必须亲手过一遍的那几条。 */




/**
 * 成员名单：谁是谁之后才能谈权限。enabled=false 时所有人按管理员算，
 * 这样单机用法完全不受影响。
 */

/** 审计条目：谁、什么时候、动了哪个接口、成没成。只留摘要，不留正文与密钥。 */


/** 一个版本能不能发：卡全做完、没阻塞、缺陷关闭、用例没有失败。 */
function releaseGate(state, release) {
  const tasks = state.tasks.filter(task => task.releaseId === release.id)
  const open = tasks.filter(task => task.status !== 'done')
  const blocked = tasks.filter(task => task.blocked !== null && task.blocked !== undefined)
  const bugs = tasks.filter(task => task.type === 'bug' && task.status !== 'done')
  const failing = []
  const emptyArtifacts = []
  for (const task of tasks) {
    for (const item of task.cases ?? []) {
      if (item.result === 'fail') failing.push({ taskId: task.id, code: task.code, title: item.title })
    }
    for (const item of task.artifacts ?? []) {
      if (String(item.content ?? '').trim() === '') emptyArtifacts.push({ taskId: task.id, code: task.code, title: item.title })
    }
  }
  const blockers = []
  const smoke = release.smoke ?? []
  const smokeOpen = smoke.filter(item => item.done !== true)
  if (tasks.length === 0) blockers.push('这个版本还没有关联任何卡片')
  if (open.length > 0) blockers.push(`${open.length} 张卡还没完成：${open.slice(0, 4).map(task => task.code || task.id).join('、')}`)
  if (blocked.length > 0) blockers.push(`${blocked.length} 张卡处于阻塞`)
  if (bugs.length > 0) blockers.push(`${bugs.length} 个缺陷未关闭`)
  if (failing.length > 0) blockers.push(`${failing.length} 条用例仍是失败状态`)
  if (String(release.tagName ?? '').trim() === '') blockers.push('还没有填发布标签（tag）：发布要能对应到一段确定的代码')
  if (smokeOpen.length > 0) blockers.push(`${smokeOpen.length} 项冒烟还没过：${smokeOpen.slice(0, 3).map(item => item.text).join('、')}`)
  const warnings = []
  if (emptyArtifacts.length > 0) warnings.push(`${emptyArtifacts.length} 件交付物缺正文`)
  if (tasks.length > 0 && tasks.every(task => (task.artifacts ?? []).length === 0)) warnings.push('这批卡一件交付物都没登记')
  if ((release.approvals ?? []).length === 0) warnings.push('还没有审批记录：发布前应该有人在版本上点「审批通过」并写结论')
  const gray = release.grayBatches ?? []
  const grayPending = gray.filter(item => item.status === 'pending' || item.status === 'running')
  if (gray.length === 0) warnings.push('没有灰度批次：将一次性全量发布')
  if (gray.length > 0 && grayPending.length > 0 && release.status === 'released') {
    warnings.push(`还有 ${grayPending.length} 批灰度没走完`)
  }
  return {
    ready: blockers.length === 0 && release.status !== 'released',
    blockers,
    warnings,
    stats: {
      tasks: tasks.length,
      done: tasks.length - open.length,
      open: open.length,
      blocked: blocked.length,
      bugs: bugs.length,
      failing: failing.length,
      artifacts: tasks.reduce((sum, task) => sum + (task.artifacts ?? []).length, 0),
      emptyArtifacts: emptyArtifacts.length,
      smoke: { total: smoke.length, done: smoke.length - smokeOpen.length },
      approvals: (release.approvals ?? []).length,
      gray: { total: gray.length, passed: gray.filter(item => item.status === 'passed').length },
    },
  }
}

/** 发布说明：按类型分组，编号 + 标题，人可以直接贴到群里。 */
function releaseNotes(state, release) {
  const tasks = state.tasks.filter(task => task.releaseId === release.id)
  const groups = [
    ['requirement', '需求'],
    ['design', '设计'],
    ['dev', '研发'],
    ['bug', '缺陷修复'],
    ['test', '测试'],
    ['ops', '运维'],
  ]
  const lines = [`# ${release.version || '未编号'} ${release.name}`.trim(), '']
  const when = release.releasedAt > 0 ? release.releasedAt : release.plannedAt
  if (when > 0) lines.push(`- 时间：${new Date(when).toISOString().slice(0, 10)}`)
  if (release.owner !== '') lines.push(`- 负责人：${release.owner}`)
  lines.push(`- 关联卡片：${tasks.length} 张`)
  lines.push('')
  // 版本 ↔ 需求：从卡片上的 requirementId 反查，发版说明里能直接看到这次交付了哪几条需求。
  const reqIds = [...new Set(tasks.map(task => String(task.requirementId ?? '')).filter(id => id !== ''))]
  const reqs = reqIds.map(id => state.requirements.find(item => item.id === id)).filter(item => item !== undefined)
  if (reqs.length > 0) {
    lines.push(`## 需求（${reqs.length} 条）`)
    for (const req of reqs) lines.push(`- ${req.code === '' ? req.id : req.code} ${req.title}`)
    lines.push('')
  }
  let any = false
  for (const [type, label] of groups) {
    const list = tasks.filter(task => (task.type ?? 'requirement') === type)
    if (list.length === 0) continue
    any = true
    lines.push(`## ${label}`)
    for (const task of list) {
      const code = task.code === '' ? task.id : task.code
      lines.push(`- ${code} ${task.title}`)
    }
    lines.push('')
  }
  if (!any) lines.push('（这个版本还没有关联卡片）')
  return lines.join('\n').slice(0, 60000)
}

/** 版本 ↔ 需求：按卡上的 releaseId 反查，这版到底交付了哪几条需求。 */
/**
 * 发布准入（可配）：是否要求先上过预发、需求是否签过字。
 * 这两条默认关闭，打开后发布必须满足，否则要走「强制发布」并写原因。
 */
function releaseRuleViolations(state, release) {
  const rules = state.config?.releaseRules ?? {}
  const violations = []
  if (rules.requireStaging === true) {
    const staging = (state.config.environments ?? []).filter(env => env.kind === 'staging').map(env => env.id)
    const deployed = (release.deployLog ?? []).filter(entry => entry.action === 'deploy' && staging.includes(String(entry.env ?? '')))
    if (staging.length === 0) violations.push('还没配「预发」环境（设置 → 部署环境里把某个环境设成 staging）')
    else if (deployed.length === 0) violations.push('这个版本还没登记过预发部署（版本详情 → 登记部署）')
  }
  if (rules.requireRequirementSignoff === true) {
    const reqs = releaseRequirements(state, release)
    const unsigned = reqs.filter(item => {
      const found = state.requirements.find(req => req.id === item.id)
      return found !== undefined && (found.signoff === null || found.signoff === undefined)
    })
    if (unsigned.length > 0) violations.push(`关联需求还没验收签字：${unsigned.map(item => item.code || item.title).join('、')}`)
  }
  return violations
}

function releaseRequirements(state, release) {
  const ids = [...new Set(state.tasks
    .filter(task => task.releaseId === release.id)
    .map(task => String(task.requirementId ?? ''))
    .filter(id => id !== ''))]
  return ids
    .map(id => state.requirements.find(item => item.id === id))
    .filter(item => item !== undefined)
    .map(item => ({ id: item.id, code: item.code, title: item.title, derived: requirementProgress(state, item).derived }))
}

/**
 * 某个版本在哪些环境里出现过：只读 deployLog，最后一条「部署/回滚」记到哪个环境就算到哪。
 * 平台从不触发部署，这里纯粹是时间线的投影。
 */
function releaseDeploys(state, release) {
  const envs = Array.isArray(state.config?.environments) ? state.config.environments : []
  const latest = new Map()
  for (const entry of release.deployLog ?? []) {
    const id = String(entry.env ?? '')
    if (id === '') continue
    if (entry.action !== 'deploy' && entry.action !== 'rollback') continue
    latest.set(id, entry)
  }
  return envs.map(env => {
    const hit = latest.get(env.id)
    return {
      id: env.id,
      name: env.name,
      kind: env.kind,
      at: hit === undefined ? 0 : Number(hit.at) || 0,
      action: hit === undefined ? '' : String(hit.action),
      by: hit === undefined ? '' : String(hit.by ?? ''),
      note: hit === undefined ? '' : String(hit.note ?? ''),
    }
  })
}

/** 一条需求的上线足迹：把挂在这条需求上的卡所在的版本，按环境合成一条时间线。 */
function requirementDeploys(state, requirement) {
  const releaseIds = [...new Set(state.tasks
    .filter(task => task.requirementId === requirement.id)
    .map(task => String(task.releaseId ?? ''))
    .filter(id => id !== ''))]
  const out = new Map()
  for (const id of releaseIds) {
    const release = state.releases.find(item => item.id === id)
    if (release === undefined) continue
    for (const item of releaseDeploys(state, release)) {
      if (item.at === 0) continue
      const prev = out.get(item.id)
      if (prev === undefined || item.at > prev.at) out.set(item.id, { ...item, releaseId: release.id, releaseName: release.name })
    }
  }
  return [...out.values()].sort((a, b) => a.at - b.at)
}

/** Everything the panel needs in one poll. */
function publicState(store) {
  const state = store.snapshot()
  return {
    revision: state.revision,
    updatedAt: state.updatedAt,
    profile: hostProfile || 'web',
    statuses: STATUSES,
    roles: ROLE_IDS,
    priorities: PRIORITIES,
    config: publicConfig(state.config),
    tasks: state.tasks.map(task => ({
      ...task,
      sla: bugSla(task, state.config),
      // 正文太占地方，轮询只下发长度；抽屉点「阅读 / 正文」时走 /task/artifact 的 get 单独取。
      artifacts: (task.artifacts ?? []).map(publicArtifact),
    })),
    fallbackFolder: state.fallbackFolder ?? null,
    releases: (state.releases ?? []).map(release => ({
      ...release,
      // 版本 ↔ 需求：按卡上的 releaseId 反查，不用人再维护一遍关联表。
      requirements: releaseRequirements(state, release),
      // 这个版本上过哪些环境（只看部署记录，不触发任何部署）。
      deploys: releaseDeploys(state, release),
    })),
    releaseStatuses: RELEASE_STATUSES,
    audit: (state.audit ?? []).slice(0, 200),
    integrations: healthReport(),
    // 技能库在磁盘上是另一份数据，但命令面板要能搜到它，所以顺带下发精简版（含"几位专家在用"）。
    skills: activeSkills === undefined
      ? []
      : activeSkills.list().map(skill => ({
        name: skill.name,
        description: skill.description ?? '',
        tags: skill.tags ?? [],
        enabled: skill.enabled !== false,
        users: (state.config.experts ?? []).filter(expert => (expert.skills ?? []).includes(skill.name)).length,
      })),
    storage: typeof store.describe === 'function' ? store.describe() : null,
    requirements: state.requirements.map(item => ({
      ...item,
      // 正文可能很长，轮询不做搬运；只给长度，点开编辑时再单独取全文。
      docs: (item.docs ?? []).map(doc => ({
        ...doc,
        content: '',
        contentLength: String(doc.content ?? '').length,
      })),
      baseline: item.baseline === null || item.baseline === undefined
        ? null
        : { ...item.baseline, content: '', contentLength: String(item.baseline.content ?? '').length },
      // 需求级门禁在每次状态轮询里一起下发：列表和详情都靠它显示「还差几项 / 能不能签字」。
      progress: requirementProgress(state, item),
      // 这条需求对应的版本上过哪些环境（上线足迹，只登记不触发）。
      deploys: requirementDeploys(state, item),
    })),
    reqStatuses: REQ_STATUSES,
  }
}

/** Apply a settings patch from the browser or a tool. */
async function applyConfig(store, patch) {
  return store.mutate(state => {
    const config = state.config
    if (patch.board !== undefined && typeof patch.board === 'object') {
      if (typeof patch.board.title === 'string' && patch.board.title.trim().length > 0) {
        config.board.title = patch.board.title.trim().slice(0, 120)
      }
    }
    if (patch.experts !== undefined) {
      const next = sanitizeExperts(patch.experts)
      if (next.length > 0) config.experts = next
      // A column whose expert disappeared falls back to the shipped default.
      config.columns = sanitizeColumns(config.columns, config.experts, config.teams)
    }
    if (patch.teams !== undefined) {
      config.teams = sanitizeTeams(patch.teams, config.experts)
      config.columns = sanitizeColumns(config.columns, config.experts, config.teams)
    }
    if (patch.columns !== undefined && typeof patch.columns === 'object') {
      config.columns = sanitizeColumns({ ...config.columns, ...patch.columns }, config.experts, config.teams)
    }
    if (patch.projects !== undefined) {
      config.projects = sanitizeWorkProjects(patch.projects)
      // 服务被删/改名后，卡上残留的服务 id 一律清掉（卡还在，只是不再指向任何路径）。
      const byId = new Map(config.projects.map(item => [item.id, item]))
      for (const task of state.tasks ?? []) {
        const service = String(task.service ?? '')
        if (service === '') continue
        const project = byId.get(String(task.project ?? ''))
        if (project === undefined || !(project.services ?? []).some(item => item.id === service)) task.service = ''
      }
    }
    if (patch.templates !== undefined) {
      config.templates = sanitizeTemplates(patch.templates)
    }
    if (patch.access !== undefined && typeof patch.access === 'object') {
      const a = patch.access
      if (Array.isArray(a.members)) config.access.members = sanitizeAccess({ ...config.access, members: a.members }).members
      if (typeof a.enabled === 'boolean') config.access.enabled = a.enabled
    }
    if (patch.gitlab !== undefined && typeof patch.gitlab === 'object') {
      const g = patch.gitlab
      if (Array.isArray(g.projects)) config.gitlab.projects = sanitizeProjects(g.projects)
      if (typeof g.url === 'string') config.gitlab.url = g.url.trim().slice(0, 500)
      if (typeof g.group === 'string') config.gitlab.group = g.group.trim().slice(0, 300)
      if (typeof g.project === 'string') config.gitlab.project = g.project.trim().slice(0, 300)
      if (typeof g.token === 'string' && g.token.trim().length > 0) config.gitlab.token = g.token.trim()
      if (g.clearToken === true) config.gitlab.token = ''
      if (typeof g.syncEnabled === 'boolean') config.gitlab.syncEnabled = g.syncEnabled
      if (typeof g.syncLabel === 'string') config.gitlab.syncLabel = g.syncLabel.trim().slice(0, 100)
    }
    if (patch.feishu !== undefined && typeof patch.feishu === 'object') {
      const f = patch.feishu
      if (Array.isArray(f.bots)) config.feishu.bots = sanitizeBots(f.bots)
      for (const key of ['appId', 'chatId', 'baseToken', 'tableId', 'webhook']) {
        if (typeof f[key] === 'string') config.feishu[key] = f[key].trim().slice(0, 500)
      }
      if (typeof f.appSecret === 'string' && f.appSecret.trim().length > 0) config.feishu.appSecret = f.appSecret.trim()
      if (f.clearAppSecret === true) config.feishu.appSecret = ''
      if (typeof f.notifyOnChange === 'boolean') config.feishu.notifyOnChange = f.notifyOnChange
      if (typeof f.driveFolder === 'string') config.feishu.driveFolder = f.driveFolder.trim().slice(0, 200)
      if (typeof f.autoSyncArtifacts === 'boolean') config.feishu.autoSyncArtifacts = f.autoSyncArtifacts
      if (typeof f.escalateWebhook === 'string') config.feishu.escalateWebhook = f.escalateWebhook.trim().slice(0, 500)
      if (Number.isFinite(Number(f.escalateAfter))) config.feishu.escalateAfter = Math.max(1, Math.min(Math.round(Number(f.escalateAfter)), 20))
    }
    if (patch.costs !== undefined) config.costs = sanitizeCosts({ ...config.costs, ...patch.costs })
    if (patch.ldap !== undefined && typeof patch.ldap === 'object') {
      const ld = patch.ldap
      const password = typeof ld.bindPassword === 'string' ? ld.bindPassword.trim() : ''
      const merged = sanitizeLdap({
        ...(config.ldap ?? {}),
        ...ld,
        // 空串 / 不传 = 沿用已保存的密码；clearBindPassword 才真清掉。
        bindPassword: password !== '' ? password : (config.ldap?.bindPassword ?? ''),
      })
      if (ld.clearBindPassword === true) merged.bindPassword = ''
      config.ldap = merged
    }
    if (patch.users !== undefined) config.users = sanitizeUsers(patch.users)
    if (patch.localAuth !== undefined && typeof patch.localAuth === 'object') {
      const current = sanitizeLocalAuth(config.localAuth)
      const incoming = patch.localAuth
      const next = {
        ...current,
        enabled: incoming.enabled === undefined ? current.enabled : incoming.enabled === true,
        username: incoming.username === undefined ? current.username : incoming.username,
      }
      config.localAuth = sanitizeLocalAuth(next)
    }
    if (patch.roles !== undefined && typeof patch.roles === 'object') {
      for (const role of ROLE_IDS) {
        const incoming = patch.roles[role]
        if (incoming === undefined || incoming === null || typeof incoming !== 'object') continue
        const target = config.roles[role]
        if (typeof incoming.label === 'string' && incoming.label.trim().length > 0) target.label = incoming.label.trim().slice(0, 40)
        if (typeof incoming.model === 'string') target.model = incoming.model.trim().slice(0, 120)
        if (typeof incoming.prompt === 'string') target.prompt = incoming.prompt.slice(0, 4000)
      }
    }
    if (patch.market !== undefined && typeof patch.market === 'object') {
      const m = patch.market
      if (typeof m.title === 'string' && m.title.trim().length > 0) {
        config.market.title = m.title.trim().slice(0, 60)
      }
      if (Array.isArray(m.items)) {
        config.market.items = m.items
          .filter(item => item !== null && typeof item === 'object')
          .map(item => ({
            id: String(item.id ?? randomBytes(4).toString('hex')).slice(0, 60),
            name: String(item.name ?? '').trim().slice(0, 80),
            spec: String(item.spec ?? '').trim().slice(0, 300),
            description: String(item.description ?? '').slice(0, 400),
          }))
          .filter(item => item.name.length > 0 && item.spec.length > 0)
          .slice(0, 200)
      }
    }
    if (patch.agents !== undefined && typeof patch.agents === 'object') {
      const a = patch.agents
      if (typeof a.enabled === 'boolean') config.agents.enabled = a.enabled
      if (typeof a.maxConcurrent === 'number' && Number.isFinite(a.maxConcurrent)) {
        config.agents.maxConcurrent = Math.max(1, Math.min(8, Math.trunc(a.maxConcurrent)))
      }
      if (typeof a.workspaceDir === 'string') config.agents.workspaceDir = a.workspaceDir.trim().slice(0, 400)
      if (typeof a.agentPreset === 'string') config.agents.agentPreset = a.agentPreset.trim().slice(0, 80) || 'standard'
      if (SANDBOX_MODES.includes(String(a.sandbox ?? ''))) config.agents.sandbox = String(a.sandbox)
      if (ISOLATION_MODES.includes(String(a.isolation ?? ''))) config.agents.isolation = String(a.isolation)
      if (typeof a.worktreeRoot === 'string') config.agents.worktreeRoot = a.worktreeRoot.trim().slice(0, 400)
      if (['on_done', 'manual'].includes(String(a.cleanupWorktree ?? ''))) config.agents.cleanupWorktree = String(a.cleanupWorktree)
      if (Array.isArray(a.autoStatuses)) {
        config.agents.autoStatuses = a.autoStatuses.filter(id => STATUS_SET.has(id)).slice(0, 8)
      }
      if (a.retry !== undefined && typeof a.retry === 'object') {
        const r = a.retry
        if (typeof r.max === 'number' && Number.isFinite(r.max)) config.agents.retry.max = Math.max(0, Math.min(6, Math.trunc(r.max)))
        if (typeof r.baseMs === 'number' && Number.isFinite(r.baseMs)) config.agents.retry.baseMs = Math.max(1000, Math.min(600000, Math.trunc(r.baseMs)))
        if (typeof r.factor === 'number' && Number.isFinite(r.factor)) config.agents.retry.factor = Math.max(1, Math.min(6, r.factor))
      }
    }
    if (patch.releaseRules !== undefined && typeof patch.releaseRules === 'object') {
      const r = patch.releaseRules
      if (config.releaseRules === undefined || config.releaseRules === null) {
        config.releaseRules = { requireStaging: false, requireRequirementSignoff: false }
      }
      if (typeof r.requireStaging === 'boolean') config.releaseRules.requireStaging = r.requireStaging
      if (typeof r.requireRequirementSignoff === 'boolean') config.releaseRules.requireRequirementSignoff = r.requireRequirementSignoff
    }
    if (patch.testing !== undefined && typeof patch.testing === 'object') {
      config.testing = sanitizeTesting({ ...config.testing, ...patch.testing })
    }
    if (patch.sla !== undefined && typeof patch.sla === 'object') {
      config.sla = sanitizeSla({ ...config.sla, ...patch.sla })
    }
    if (patch.environments !== undefined) {
      const next = sanitizeDeployEnvs(patch.environments)
      // 空列表没有意义（部署记录要挂在环境上），至少留默认三档。
      config.environments = next.length > 0 ? next : defaultDeployEnvs()
    }
  })
}

/** Create a task from a normalized input object. */
async function createTask(store, input) {
  const title = text(input.title, 200)
  if (title === undefined) throw new Error('title is required')
  const patch = normalizePatch(input)
  const now = Date.now()
  // 缺陷默认直接进「待开发」，需求默认从「待澄清」开始。
  const initialStatus = patch.status ?? (patch.type === 'bug' ? 'dev_ready' : 'clarify')
  const initialRole = patch.role ?? (STATUSES.find(item => item.id === initialStatus)?.role ?? 'product')
  const type = patch.type ?? 'requirement'
  // 建卡时按模板铺一张验收清单：这一行活到底要交什么，一开始就写清楚。
  const template = store.snapshot().config.templates[type] ?? []
  const seeded = patch.checklist ?? template.map((text, index) => ({
    id: `c${index + 1}`,
    text,
    done: false,
    by: '',
    at: 0,
    note: '',
  }))
  const requirementId = patch.requirementId ?? ''
  // 卡片的业务领域默认跟随所属需求：泳道按角色位派单时靠它挑对应领域专家。
  const inheritedDomain = (() => {
    const own = String(patch.domain ?? '').trim()
    if (own !== '') return own
    const requirement = store.snapshot().requirements.find(entry => entry.id === requirementId)
    return String(requirement?.domain ?? '').trim()
  })()
  // 记住这张卡是照着哪一版需求基线做的，需求改版后能看出谁需要返工。
  const baseline = requirementId === ''
    ? null
    : (store.snapshot().requirements.find(item => item.id === requirementId)?.baseline ?? null)
  const task = {
    id: newTaskId(),
    title,
    type,
    code: requirementId === '' ? '' : nextTaskCode(store.snapshot().tasks, requirementId, CODE_PREFIX[type] ?? 'TASK'),
    requirementId,
    pointId: patch.pointId ?? '',
    releaseId: patch.releaseId ?? '',
    reqBaseline: baseline === null ? null : { version: baseline.version, at: baseline.at, title: baseline.title },
    worktree: null,
    signoff: null,
    status: initialStatus,
    role: initialRole,
    priority: patch.priority ?? (patch.type === 'bug' && (patch.severity ?? '') === 'p0' ? 'urgent' : 'normal'),
    severity: (patch.type ?? 'requirement') === 'bug' ? (patch.severity ?? 'p2') : '',
    requirement: patch.requirement ?? '',
    expert: patch.expert ?? '',
    domain: inheritedDomain,
    project: patch.project ?? '',
    iteration: patch.iteration ?? '',
    service: patch.service ?? '',
    parent: patch.parent ?? '',
    dueAt: patch.dueAt ?? 0,
    gitlabIssue: patch.gitlabIssue ?? '',
    gitlabMR: patch.gitlabMR ?? { iid: 0, url: '', title: '', state: '' },
    feishuThread: patch.feishuThread ?? '',
    owner: patch.owner ?? '',
    blockedReason: patch.blockedReason ?? '',
    /** AI 派单连续失败次数与下次允许重试的时间（退避窗口）。 */
    agentFailures: 0,
    retryAt: 0,
    artifacts: patch.artifacts ?? [],
    checklist: seeded,
    cases: patch.cases ?? [],
    testRuns: [],
    coding: sanitizeCoding(patch.coding ?? null),
    bugSource: patch.bugSource ?? null,
    /** 缺陷去重：这张卡看起来和哪张缺陷是同一件事（人再判断要不要合并）。 */
    duplicateOf: '',
    tags: patch.tags ?? [],
    createdAt: now,
    updatedAt: now,
    comments: [],
    history: [{ at: now, by: 'agent', status: task_status_of(patch) }],
  }
  // 建缺陷卡时顺手查一遍「是不是已经有人报过同一件事」：只做提示，不替人合并。
  if (type === 'bug') {
    const twin = findDuplicateBug(store.snapshot(), title, task.bugSource?.caseId ?? '')
    if (twin !== undefined) {
      task.duplicateOf = twin.id
      task.tags = [...new Set([...task.tags, '疑似重复'])]
    }
  }
  // 服务必须属于所选项目：传了不对的服务就当没选（不要让卡挂着一个不存在的路径）。
  if (task.service !== '') {
    const owner = (store.snapshot().config.projects ?? []).find(entry => entry.id === task.project)
    if (owner === undefined || !(owner.services ?? []).some(entry => entry.id === task.service)) task.service = ''
  }
  await store.mutate(state => {
    // 编号必须在临界区里再校验一次：并发开卡（一次跑多条用例）时，快照里算出的编号会撞号。
    if (task.code !== '' && state.tasks.some(entry => entry.requirementId === task.requirementId && entry.code === task.code)) {
      task.code = nextTaskCode(state.tasks, task.requirementId, CODE_PREFIX[task.type] ?? 'TASK')
    }
    state.tasks.unshift(task)
  })
  if (task.duplicateOf !== '') {
    const twin = store.snapshot().tasks.find(entry => entry.id === task.duplicateOf)
    if (twin !== undefined) {
      await commentTask(store, twin.id, `又收到一张疑似重复的缺陷：${task.code === '' ? task.id : task.code}「${task.title}」。如果是同一件事，在缺陷上标一下重复并关掉一张。`, '系统', 'agent')
    }
  }
  return task
}

/** 标题归一后比较：把 emoji、标点、空格都去掉，再看有没有同名在办缺陷。 */
function bugTitleKey(title) {
  return String(title ?? '')
    .replace(/^\[用例失败\]\s*/, '')
    .replace(/[\s，,。.、:：;；!！?？"'“”‘’()（）[\]【】<>《》-]/g, '')
    .toLowerCase()
}

function findDuplicateBug(state, title, caseId = '') {
  const key = bugTitleKey(title)
  if (key === '') return undefined
  return state.tasks.find(entry => entry.type === 'bug'
    && entry.status !== 'done'
    && bugTitleKey(entry.title) === key
    && (caseId === '' || entry.bugSource?.caseId !== caseId))
}

/** Status chosen at creation time (kept as a helper for readable history). */
function task_status_of(patch) {
  return patch.status ?? 'clarify'
}

/**
 * 环境/连接类失败不该污染缺陷池：跑不起来 ≠ 实现有错。
 * 只认「连不上/超时/DNS/网关」这类信号；404 不在此列——路径写错往往就是真缺陷。
 */
function isEnvFailure(text) {
  const value = String(text ?? '')
  if (value === '') return false
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|ESOCKETTIMEDOUT|socket hang up|getaddrinfo|connect ECONN|connection refused|Network Error|network error|timed out|timeout of \d+|502 Bad Gateway|504 Gateway|Bad Gateway|ENV_UNAVAILABLE|连不上|连接被拒绝|不可达|服务未就绪|环境不可用|环境没起来|baseUrl 没配/i.test(value)
}

/**
 * 用例失败 → 自动开一张缺陷卡，挂同一个需求、同一个项目/迭代，父任务是这张测试卡。
 * 同一张卡的同一用例只会开一次；重新标失败只是更新证据。
 */
async function autoBugFromCase(store, task, item, by) {
  const snapshot = store.snapshot()
  const existing = snapshot.tasks.find(entry => entry.bugSource != null
    && entry.bugSource.taskId === task.id
    && entry.bugSource.caseId === item.id)
  const requirement = snapshot.requirements.find(entry => entry.id === task.requirementId)
  if (existing !== undefined) {
    await commentTask(store, existing.id, [
      `用例再次失败（${new Date(item.at || Date.now()).toLocaleString('zh-CN')}）。`,
      item.note === '' ? '' : `实际：${item.note}`,
    ].filter(Boolean).join('\n'), by, 'agent')
    return { bug: existing, created: false }
  }
  const evidence = [item.note, item.actual, item.error].map(value => String(value ?? '')).filter(value => value !== '').join(' · ')
  if (isEnvFailure(evidence)) {
    await commentTask(store, task.id, [
      `用例「${item.title}」判为失败，但失败信息像是环境/连接问题，按规则**不开缺陷**（先修环境再复跑）。`,
      evidence === '' ? '' : `证据：${evidence}`,
    ].filter(Boolean).join('\n'), by, 'agent')
    return { bug: null, created: false, skipped: 'env' }
  }
  const bug = await createTask(store, {
    title: `[用例失败] ${item.title}`,
    type: 'bug',
    severity: 'p2',
    status: 'dev_ready',
    priority: 'normal',
    requirement: [
      `来源：${task.code === '' ? task.id : task.code}「${task.title}」的测试用例`,
      `用例：${item.title}`,
      item.expected === '' ? '' : `期望：${item.expected}`,
      item.note === '' ? '' : `实际：${item.note}`,
      requirement === undefined ? '' : `所属需求：${requirement.code} ${requirement.title}`,
    ].filter(line => line !== '').join('\n'),
    requirementId: task.requirementId,
    project: task.project,
    iteration: task.iteration,
    parent: task.id,
    domain: task.domain,
    bugSource: {
      taskId: task.id,
      code: task.code,
      caseId: item.id,
      caseTitle: item.title,
      expected: item.expected,
      note: item.note,
      by,
      at: item.at || Date.now(),
    },
  })
  await commentTask(store, task.id, `用例「${item.title}」判为失败，已自动登记缺陷 ${bug.code === '' ? bug.id : bug.code}（父任务挂了本卡）。`, '系统', 'agent')
  await commentTask(store, bug.id, [
    '自动化用例失败后自动创建。',
    `复现：执行 ${task.code === '' ? task.id : task.code} 的用例「${item.title}」。`,
    item.expected === '' ? '' : `期望结果：${item.expected}`,
    item.note === '' ? '' : `实际结果：${item.note}`,
  ].filter(line => line !== '').join('\n'), '系统', 'agent')
  // 自动开出来的缺陷要有人看见：群里推一条，别让它躺在待开发列里没人领。
  feishuBroadcast(
    store.snapshot().config,
    `【新缺陷】${bug.code || bug.id} ${bug.title}\n来源用例：${item.title}\n从「${task.code === '' ? task.id : task.code} ${task.title}」自动开出，去「待开发」看一眼。`,
    'bug',
  ).catch(() => undefined)
  return { bug, created: true }
}

/** 缺陷卡修好进入「待测试」时，把它来源的那条用例重置成待执行，等着回归。 */
async function resetOriginCase(store, bug) {
  const source = bug.bugSource
  if (source == null) return null
  let changed = false
  await store.mutate(state => {
    const task = state.tasks.find(entry => entry.id === source.taskId)
    if (task === undefined) return
    task.cases = (Array.isArray(task.cases) ? task.cases : []).map(item => {
      if (item.id !== source.caseId) return item
      changed = true
      return { ...item, result: 'pending', note: `回归中（${bug.code === '' ? bug.id : bug.code} 已修复待验证）`, by: '系统', at: Date.now() }
    })
    if (changed) task.updatedAt = Date.now()
  })
  if (changed) {
    await commentTask(store, source.taskId, `${bug.code === '' ? bug.id : bug.code} 已进入待测试，原用例「${source.caseTitle}」已重置为待执行，请复跑确认。`, '系统', 'agent')
    await commentTask(store, bug.id, `已把来源用例「${source.caseTitle}」重置为待执行，测试复跑通过后本卡即可关闭。`, '系统', 'agent')
  }
  return changed ? source : null
}

// ------------------------------------------------- 沙箱与 git worktree 隔离（P5）

/** worktree 根目录：没配就用 workspaceDir 的同级兄弟目录。 */

/** 卡对应的业务项目（worktree 的仓库与基线分支都来自它）。 */
function workProjectOf(config, task) {
  const id = String(task?.project ?? '').trim()
  if (id.length === 0) return undefined
  return (config?.projects ?? []).find(project => project.id === id)
}

/** 卡上的服务：一个业务项目里可以有多个服务，每个服务一个 git 路径。 */
function serviceOf(config, task) {
  const id = String(task?.service ?? '').trim()
  if (id.length === 0) return undefined
  const project = workProjectOf(config, task)
  if (project === undefined) return undefined
  return (project.services ?? []).find(service => service.id === id)
}

/**
 * 服务依赖：这个服务依赖哪些服务、它们各自还有多少张没完成的卡。
 * 只在本项目内生效；没配依赖、或卡没挂服务时返回 undefined。
 */
function serviceDependencies(state, task) {
  const config = state?.config ?? {}
  const service = serviceOf(config, task)
  const project = workProjectOf(config, task)
  if (service === undefined || project === undefined) return undefined
  const wanted = Array.isArray(service.dependsOn) ? service.dependsOn : []
  if (wanted.length === 0) return undefined
  const rows = wanted
    .map(id => (project.services ?? []).find(one => one.id === id))
    .filter(dep => dep !== undefined)
    .map(dep => {
      const open = (state.tasks ?? []).filter(one => one.service === dep.id && one.project === project.id && one.status !== 'done')
      return { id: dep.id, name: dep.name, open: open.length, titles: open.slice(0, 2).map(one => one.code || one.title) }
    })
    .filter(row => row !== undefined)
  if (rows.length === 0) return undefined
  return { project: project.id, service: service.id, rows, pending: rows.reduce((sum, row) => sum + row.open, 0) }
}

/**
 * 同服务并行：同一个服务上还有别的卡在改代码（开发中/待评审/待测试），
 * 合并时会互相踩。返回 undefined 表示没有并行的同类卡。
 */
function serviceConflicts(state, task) {
  const config = state?.config ?? {}
  const service = serviceOf(config, task)
  if (service === undefined) return undefined
  const others = (state.tasks ?? []).filter(other => other.id !== task.id
    && other.service === service.id
    && (other.project ?? '') === (task.project ?? '')
    && ['dev', 'review', 'test'].includes(other.status))
  if (others.length === 0) return undefined
  return {
    service: service.id,
    name: service.name,
    count: others.length,
    tasks: others.slice(0, 6).map(other => ({ id: other.id, code: other.code || other.id, title: other.title, status: other.status })),
  }
}

/** 一卡一分支名：优先用卡号（DEV-001），没编号就用 id。 */
function worktreeBranch(task) {
  const label = String(task?.code ?? '').trim() || String(task?.id ?? '').trim()
  return `task/${label}`.slice(0, 120)
}

/**
 * 给一张卡准备独立的 git worktree。
 * 返回 { path, branch, repo, base, at }；没配仓库或建不出来时返回 undefined
 * （并给出原因，调用方负责记日志）。
 */
async function ensureWorktree(store, task, config) {
  const enabled = String(config?.agents?.isolation ?? 'none') === 'worktree'
  if (!enabled) return { skipped: 'isolation=none' }
  const project = workProjectOf(config, task)
  if (project === undefined) return { skipped: '卡没挂业务项目' }
  const service = serviceOf(config, task)
  const repo = String(service?.repoPath ?? '').trim() || String(project.repoPath ?? '').trim()
  if (repo.length === 0) {
    return { skipped: service === undefined ? `项目「${project.name}」没配本机代码目录` : `服务「${service.name}」没配本机代码目录` }
  }
  const probe = await runCommand('git', ['-C', repo, 'rev-parse', '--is-inside-work-tree'], 20000)
  if (!probe.ok) return { skipped: `${repo} 不是 git 仓库（${(probe.stderr || '').trim().split('\n')[0] ?? ''}）`.slice(0, 300) }
  const existing = task?.worktree
  if (existing !== undefined && existing !== null && String(existing.path ?? '').length > 0) {
    const alive = await runCommand('git', ['-C', repo, 'worktree', 'list', '--porcelain'], 20000)
    if (alive.ok && String(alive.stdout).includes(`worktree ${existing.path}`)) return existing
  }
  const branch = worktreeBranch(task)
  const path = join(worktreeRoot(config), String(task?.code ?? '').trim() || String(task?.id ?? 'card'))
  await mkdir(dirname(path), { recursive: true })
  const base = String(service?.baseBranch ?? project.baseBranch ?? '').trim() || 'main'
  const branches = await runCommand('git', ['-C', repo, 'branch', '--list', branch], 20000)
  const exists = branches.ok && String(branches.stdout).trim().length > 0
  const added = exists
    ? await runCommand('git', ['-C', repo, 'worktree', 'add', path, branch], 60000)
    : await runCommand('git', ['-C', repo, 'worktree', 'add', '-b', branch, path, base], 60000)
  if (!added.ok) {
    const message = (added.stderr || added.stdout || '').trim().split('\n')[0] ?? ''
    markHealth('worktree', 'fail', message || 'git worktree add 失败')
    return { skipped: `git worktree 失败：${message}`.slice(0, 300) }
  }
  markHealth('worktree', 'ok')
  const info = {
    path, branch, repo, base,
    service: String(service?.id ?? ''),
    serviceName: String(service?.name ?? project.name ?? ''),
    at: Date.now(),
  }
  try {
    await store.mutate(draft => {
      const target = draft.tasks.find(entry => entry.id === task.id)
      if (target !== undefined) target.worktree = info
      return draft
    })
  } catch (error) {
    // 落库失败不影响这一轮工作，worktree 已经建好了
  }
  return info
}

/** 回收 worktree（卡已完成且策略是 on_done 时调用）。 */
async function removeWorktree(store, task, config) {
  const info = task?.worktree
  if (info === undefined || info === null) return { ok: false, skipped: '没有 worktree' }
  const repo = String(info.repo ?? '').trim()
  if (repo.length === 0) return { ok: false, skipped: 'worktree 记录里没有仓库' }
  const removed = await runCommand('git', ['-C', repo, 'worktree', 'remove', '--force', String(info.path)], 60000)
  await runCommand('git', ['-C', repo, 'branch', '-D', String(info.branch)], 20000)
  try {
    await store.mutate(draft => {
      const target = draft.tasks.find(entry => entry.id === task.id)
      if (target !== undefined) target.worktree = null
      return draft
    })
  } catch (error) {
    // ignore
  }
  return { ok: removed.ok, error: removed.ok ? '' : (removed.stderr || '').trim().split('\n')[0] }
}

// ------------------------------------------------------------------- tools


/** A one-line task summary for tool output. */
function taskLine(task) {
  const status = STATUSES.find(s => s.id === task.status)
  const kind = task.type === 'bug' ? `[BUG ${String(task.severity || 'p2').toUpperCase()}] ` : ''
  const flags = []
  if (task.blocked !== null && task.blocked !== undefined) flags.push('⛔阻塞')
  if ((Number(task.reopenCount) || 0) > 0) flags.push(`重开${task.reopenCount}次`)
  const checkTotal = (task.checklist ?? []).length
  if (checkTotal > 0) flags.push(`清单 ${(task.checklist ?? []).filter(item => item.done).length}/${checkTotal}`)
  if ((task.artifacts ?? []).length > 0) flags.push(`产物 ${task.artifacts.length}`)
  const cases = task.cases ?? []
  if (cases.length > 0) {
    const bad = cases.filter(item => item.result === 'fail').length
    flags.push(`用例 ${cases.filter(item => item.result === 'pass').length}/${cases.length}${bad > 0 ? `（${bad} 不通过）` : ''}`)
  }
  if ((task.gitlabMR?.iid ?? 0) > 0) flags.push(`MR !${task.gitlabMR.iid}${task.gitlabMR.state === 'merged' ? '已合并' : ''}`)
  const coding = task.coding ?? null
  if (coding !== null && (coding.files.length > 0 || coding.commits.length > 0)) {
    const ut = coding.unitTests
    flags.push(`代码 ${coding.files.length} 文件/${coding.commits.length} 提交${ut.total > 0 ? `/单测 ${ut.passed}/${ut.total}` : ''}${coding.review.status === 'approved' ? '/评审通过' : coding.review.status === 'changes_requested' ? '/评审待改' : ''}`)
  }
  if (task.dueAt > 0) flags.push(`截止 ${new Date(task.dueAt).toISOString().slice(0, 10)}`)
  if (task.bugSource != null) flags.push(`来源用例 ${task.bugSource.code || task.bugSource.taskId}`)
  if (String(task.duplicateOf ?? '') !== '') flags.push(`重复于 ${task.duplicateOf}`)
  const runs = Array.isArray(task.testRuns) ? task.testRuns : []
  const lastRun = runs.length > 0 ? runs[runs.length - 1] : null
  if (lastRun !== null) flags.push(`最近执行 ${lastRun.passed}/${lastRun.total}${lastRun.failed > 0 ? `（${lastRun.failed} 失败）` : ''}`)
  const suffix = flags.length > 0 ? ` · ${flags.join(' · ')}` : ''
  const project = task.project !== undefined && task.project.length > 0 ? ` {${task.project}}` : ''
  const code = task.code !== undefined && task.code.length > 0 ? `${task.code} ` : ''
  return `- ${code}${task.id}${project} [${status?.label ?? task.status}] ${kind}${task.title}${suffix}`
}

// --------------------------------------------------------------------- api

// ------------------------------------------------------------------ market

/** The profile this plugin runs in — the market installs into its own profile. */
function profileFromArgv() {
  if (process.env.DSH_PROFILE) return process.env.DSH_PROFILE
  const argv = process.argv
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--profile' && argv[i + 1]) return argv[i + 1]
    if (a.startsWith('--profile=')) return a.slice('--profile='.length)
  }
  return undefined
}

/**
 * argv 里没有 --profile（宿主可能把它吃掉了）时，去 profiles 目录里认领：
 * 优先选装了本插件（dsh-studio）的那个 profile，再退到最近改过的那个。
 */
async function detectProfile() {
  const fromArgv = profileFromArgv()
  if (fromArgv !== undefined && fromArgv !== '') return fromArgv
  const root = dshHomePath('profiles')
  let names = []
  try {
    names = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return 'web'
  }
  for (const name of names) {
    try {
      const parsed = JSON.parse(await readFile(join(root, name, 'package.json'), 'utf8'))
      const bundles = parsed?.dsh?.profile?.bundles ?? []
      const deps = parsed.dependencies ?? {}
      if (deps['dsh-studio'] !== undefined || bundles.includes('dsh-studio')) return name
    } catch { /* 跳过坏 profile */ }
  }
  return names.includes('web') ? 'web' : (names[0] ?? 'web')
}

let profileCache
let hostProfile = ''
async function currentProfile() {
  if (profileCache === undefined) profileCache = await detectProfile()
  return profileCache
}

/** Package names currently installed in the profile. */
async function installedPackages() {
  try {
    const raw = await readFile(dshHomePath('profiles', await currentProfile(), 'package.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return Object.keys(parsed.dependencies ?? {})
  } catch {
    return []
  }
}

/**
 * Install one catalogue entry into the profile by delegating to the DSH CLI,
 * which is the supported path (it keeps pnpm's lockfile and the profile's
 * bundle list consistent). Resolves with the CLI output.
 */
async function runPluginCli(args) {
  const profile = await currentProfile()
  return new Promise(resolvePromise => {
    const child = spawn('dsh', ['plugin', '--profile', profile, ...args], {
      cwd: homedir(),
      env: { ...process.env, HOME: homedir() },
      timeout: 180_000,
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', error => resolvePromise({ ok: false, error: error.message, output }))
    child.on('close', code => resolvePromise({ ok: code === 0, code, output: output.slice(-2000) }))
  })
}

/**
 * Turn a catalogue spec into the package name `dsh plugin remove` expects.
 * `pnpm remove` takes a name, not a spec, so `link:/path` has to be read back
 * from the package it points at.
 */
async function resolvePackageName(spec) {
  const trimmed = String(spec ?? '').trim()
  if (trimmed.length === 0) return undefined
  if (/^(link|file):/.test(trimmed)) {
    const dir = trimmed.replace(/^(link|file):/, '')
    try {
      const raw = await readFile(join(dir, 'package.json'), 'utf8')
      const name = JSON.parse(raw).name
      if (typeof name === 'string' && name.trim().length > 0) return name.trim()
    } catch {}
    return undefined
  }
  const match = trimmed.match(/^((?:@[^/@]+\/)?[^@/]+)(?:@.*)?$/)
  return match?.[1]
}

/** 这次请求算谁：有会话就用会话身份；没锁门（没开必须登录）时算本地超管；否则算匿名。 */
function resolveActor(req, config) {
  const session = sessionOf(req, config)
  if (session !== null) return String(session.user.name ?? session.user.id ?? '').slice(0, 40)
  const ldap = config?.ldap ?? {}
  const locked = ldap.enabled === true && ldap.requireLogin === true
  if (locked) return ''
  const local = sanitizeLocalAuth(config?.localAuth)
  return local.username === 'admin' ? '超管 admin' : local.username
}

/** 谁能操作：先看这次请求算出来的身份（会话 / 超管），再看请求头 x-studio-user，最后当「人」。 */
function operatorOf(req) {
  const actor = typeof req?.studioActor === 'string' ? req.studioActor.trim() : ''
  if (actor !== '') return actor.slice(0, 40)
  const raw = req.headers['x-studio-user']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string' || value.trim() === '') return '人'
  try {
    const text = decodeURIComponent(value).trim().slice(0, 40)
    return text === '' ? '人' : text
  } catch {
    return value.trim().slice(0, 40) || '人'
  }
}

// ---------------------------------------------------------------- 统一登录

/** 登录会话放内存：12 小时有效；服务重启后重新登录（会话不落盘，避免 token 泄漏）。 */
const SESSIONS = new Map()
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
/* 会话要跨重启存活，所以除了内存 Map 还写 SQLite；store 就绪后把未过期的会话读回内存。 */
let SESSION_STORE = null

function attachSessionStore(store) {
  /* registerRoutes 同步执行时 #boot 还没打开数据库，此时挂上会把 "已挂载" 变成
     永久状态却一条会话都读不到；db 为空就直接返回，让第一次请求再试一次。 */
  if (store.db === null) return
  SESSION_STORE = store
  try {
    store.pruneSessions()
    for (const row of store.listSessions()) SESSIONS.set(row.token, row)
  } catch (error) {
    console.warn('[dsh-studio] restore sessions failed:', error?.message ?? error)
  }
}

/** LDAP 过滤器里的特殊字符要转义，否则用户名能改写查询。 */
function ldapEscape(value) {
  return String(value).replace(/[\\*()\u0000]/g, ch => `\\${ch.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

/** 解析 ldapsearch 的 LDIF 输出：返回 [{ dn, attrs: { 属性名: [值…] } }]。 */
function parseLdif(text) {
  const entries = []
  let current = null
  let lastKey = ''
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim() === '') {
      if (current !== null) entries.push(current)
      current = null
      lastKey = ''
      continue
    }
    if (line.startsWith('#')) continue
    if (line.startsWith(' ')) {
      if (current !== null && lastKey !== '') {
        const list = current.attrs[lastKey]
        if (Array.isArray(list) && list.length > 0) list[list.length - 1] += line.slice(1)
      }
      continue
    }
    const index = line.indexOf(':')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    // RFC 2849：`attr:: <base64>` 表示值用了 base64（AD 的中文 displayName 就是这样）
    const rest = line.slice(index + 1)
    const encoded = rest.startsWith(':')
    const raw = encoded ? rest.slice(1).trim() : rest.trim()
    let value = raw
    if (encoded) {
      try { value = Buffer.from(raw, 'base64').toString('utf8') } catch { value = raw }
    }
    if (key.toLowerCase() === 'dn') {
      current = { dn: value, attrs: {} }
      continue
    }
    if (current === null) continue
    const name = key.toLowerCase()
    if (!Array.isArray(current.attrs[name])) current.attrs[name] = []
    current.attrs[name].push(value)
    lastKey = name
  }
  if (current !== null) entries.push(current)
  return entries
}

/** 取第一个属性值。 */
function ldapAttr(entry, name) {
  const list = entry?.attrs?.[String(name).toLowerCase()]
  return Array.isArray(list) && list.length > 0 ? String(list[0]) : ''
}

/** 把 ldapsearch 的报错翻成一句人话。 */
function ldapProblemMessage(result) {
  const stderr = String(result?.stderr ?? '')
  if (/Can't contact LDAP server/i.test(stderr)) return '连不上 LDAP 服务器：检查地址、端口和网络（这台机器能不能访问到）；现在可以先用本地超管账号登录'
  if (/Invalid credentials/i.test(stderr) || /\(49\)/.test(stderr)) return '账号或密码不对'
  if (/No such object/i.test(stderr)) return 'BASE DN 下找不到这个条目：检查 BASE DN 和过滤器'
  if (/No such file|ENOENT/i.test(stderr)) return '这台机器上没有 ldapsearch：先装 ldap-utils'
  // 被 runCommand 超时杀掉时拿不到退出码，也没有 stderr —— 多半是网络不通（包被丢）
  if (result?.code === null || result?.code === undefined) return '连不上 LDAP 服务器：超时没响应，先确认这台机器能访问它的地址和端口；现在可以先用本地超管账号登录'
  const tail = stderr.split('\n').map(line => line.trim()).filter(Boolean).slice(-2).join(' ')
  return (tail === '' ? `ldapsearch 退出码 ${result?.code ?? '未知'}` : tail).slice(0, 200)
}

/**
 * 跑一次 ldapsearch。密码只写进 0600 的临时文件（-y），不会出现在进程参数里，
 * 用完就删；超时由 runCommand 负责。
 */
async function runLdapsearch(settings, options) {
  const dir = join(dshHomePath('tmp'), `ldap-${randomBytes(6).toString('hex')}`)
  await mkdir(dir, { recursive: true })
  const pwFile = join(dir, 'pw')
  try {
    await writeFile(pwFile, String(options.password ?? ''), { encoding: 'utf8', mode: 0o600 })
    const args = ['-x', '-LLL', '-H', settings.url, '-o', 'ldif-wrap=no', '-o', `nettimeout=${Math.max(2, Math.ceil(Number(settings.timeoutMs) / 1000))}`]
    if (String(options.bindDN ?? '') !== '') args.push('-D', options.bindDN)
    args.push('-y', pwFile, '-b', String(options.base ?? settings.baseDN), '-s', String(options.scope ?? 'sub'), '-z', String(options.sizeLimit ?? 2))
    // ldapsearch 的用法是 `[filter [attributes...]]`：过滤器必须排在属性前面，
    // 否则它会被当成属性名，搜索退化成 (objectClass=*)。
    args.push(String(options.filter ?? '(objectClass=*)'))
    if (Array.isArray(options.attributes) && options.attributes.length > 0) args.push(...options.attributes)
    const result = await runCommand('ldapsearch', args, Math.max(3000, Number(settings.timeoutMs) + 1500))
    return { ok: result.ok === true && result.code === 0, entries: parseLdif(result.stdout), stderr: String(result.stderr ?? ''), stdout: String(result.stdout ?? ''), code: result.code }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 用服务账号查人：返回 LDAP 条目（含 dn 与属性）。 */
async function ldapLookup(settings, username) {
  const filter = String(settings.userFilter).split('{user}').join(ldapEscape(username))
  const attributes = ['cn', 'sAMAccountName', 'uid', 'mail', 'displayName', 'department', 'title',
    settings.nameAttr, settings.mailAttr, settings.deptAttr]
  const result = await runLdapsearch(settings, {
    bindDN: settings.bindDN,
    password: settings.bindPassword,
    filter,
    sizeLimit: 2,
    attributes: [...new Set(attributes.filter(name => name !== ''))],
  })
  if (!result.ok) return { ok: false, message: ldapProblemMessage(result), entries: [] }
  return { ok: true, entries: result.entries }
}

/** 用「用户自己的 DN + 密码」再绑一次：这才是验密码。 */
async function ldapVerifyPassword(settings, dn, password) {
  const result = await runLdapsearch(settings, {
    bindDN: dn,
    password,
    base: dn,
    scope: 'base',
    sizeLimit: 1,
    attributes: ['dn'],
  })
  if (result.ok) return { ok: true }
  const stderr = String(result.stderr ?? '')
  if (/Invalid credentials/i.test(stderr) || /\(49\)/.test(stderr)) return { ok: false, message: '账号或密码不对' }
  return { ok: false, message: ldapProblemMessage(result) }
}

/** 完整登录：服务账号查人 → 用户 DN 验密码 → canonical 用户名。 */
async function ldapAuthenticate(settings, username, password) {
  if (settings.enabled !== true) return { ok: false, code: 'disabled', message: '统一登录没有开启（设置 → 统一登录）' }
  if (String(settings.bindPassword ?? '').trim() === '') return { ok: false, code: 'nobind', message: '服务账号密码还没保存（设置 → 统一登录 → 保存）' }
  const name = String(username ?? '').trim()
  if (name === '' || String(password ?? '') === '') return { ok: false, code: 'empty', message: '用户名和密码都要填' }
  const lookup = await ldapLookup(settings, name)
  if (!lookup.ok) return { ok: false, code: 'directory', message: lookup.message }
  if (lookup.entries.length === 0) return { ok: false, code: 'notfound', message: `LDAP 里没有「${name}」这个账号` }
  const entry = lookup.entries[0]
  const verified = await ldapVerifyPassword(settings, entry.dn, password)
  if (!verified.ok) return { ok: false, code: 'badpass', message: verified.message }
  const id = (ldapAttr(entry, 'sAMAccountName') || ldapAttr(entry, 'uid') || name).trim().toLowerCase()
  return {
    ok: true,
    user: {
      id,
      name: ldapAttr(entry, settings.nameAttr) || ldapAttr(entry, 'cn') || id,
      mail: ldapAttr(entry, settings.mailAttr) || ldapAttr(entry, 'mail'),
      dept: ldapAttr(entry, settings.deptAttr) || ldapAttr(entry, 'department'),
      dn: entry.dn,
    },
  }
}

/** 清掉过期的会话。 */
function pruneSessions() {
  const now = Date.now()
  for (const [token, item] of SESSIONS) if (Number(item.expiresAt) <= now) SESSIONS.delete(token)
  if (SESSION_STORE !== null) SESSION_STORE.pruneSessions(now)
}

function issueSession(user, ip) {
  pruneSessions()
  const token = randomBytes(24).toString('hex')
  const at = Date.now()
  const expiresAt = at + SESSION_TTL_MS
  const session = {
    userId: String(user.id),
    name: String(user.name),
    role: String(user.role ?? 'member').slice(0, 20),
    source: String(user.source ?? 'ldap').slice(0, 20),
    at,
    expiresAt,
    ip: String(ip ?? '').slice(0, 60),
  }
  SESSIONS.set(token, session)
  if (SESSION_STORE !== null) SESSION_STORE.saveSession({ token, ...session })
  return { token, expiresAt }
}

/** 从请求头 x-studio-session 认人；没有或过期返回 null。 */
function sessionOf(req, config) {
  const raw = req.headers['x-studio-session']
  const token = String((Array.isArray(raw) ? raw[0] : raw) ?? '').trim()
  if (token === '') return null
  const session = SESSIONS.get(token)
  if (session === undefined) return null
  if (Number(session.expiresAt) <= Date.now()) {
    SESSIONS.delete(token)
    if (SESSION_STORE !== null) SESSION_STORE.dropSession(token)
    return null
  }
  /* 本地超管不在 config.users 里，会话本身就带名字与角色，不再依赖名单。 */
  const stored = (config?.users ?? []).find(item => item.id === session.userId)
  const user = stored ?? {
    id: session.userId,
    name: session.name,
    role: session.role,
    source: session.source,
    mail: '',
    dept: '',
  }
  return { token, user, session }
}

/** 登录成功：记到 config.users（首次登录建档，之后只更新最近登录情况）。 */
async function recordLogin(store, user, ip) {
  const at = Date.now()
  await store.mutate(state => {
    if (!Array.isArray(state.config.users)) state.config.users = []
    const id = String(user.id).toLowerCase()
    let entry = state.config.users.find(item => item.id === id)
    if (entry === undefined) {
      entry = { id, name: user.name, mail: '', dept: '', dn: '', role: 'member', source: 'ldap', firstLoginAt: at, lastLoginAt: at, loginCount: 0, lastIp: '' }
      state.config.users.push(entry)
    }
    if (String(user.name ?? '') !== '') entry.name = user.name
    if (String(user.mail ?? '') !== '') entry.mail = user.mail
    if (String(user.dept ?? '') !== '') entry.dept = user.dept
    if (String(user.dn ?? '') !== '') entry.dn = user.dn
    entry.source = 'ldap'
    entry.firstLoginAt = Number(entry.firstLoginAt) || at
    entry.lastLoginAt = at
    entry.loginCount = (Number(entry.loginCount) || 0) + 1
    entry.lastIp = String(ip ?? '').slice(0, 60)
    state.config.users = sanitizeUsers(state.config.users)
  })
}

/** 这个请求需要什么权限：读、写、还是管理员。 */
function accessLevelFor(route, method) {
  if (method !== 'POST') return 'read'
  return ADMIN_ROUTES.has(route) ? 'admin' : 'write'
}

/** 权限判定，返回 null 表示放行，否则返回给人看的原因。 */
function checkAccess(config, operator, level) {
  const access = config?.access ?? { enabled: false, members: [] }
  if (access.enabled !== true) return null
  // 本地超管永远放行：开权限时最怕的是管理员把自己关在门外。
  const raw = String(operator).trim()
  if (raw.includes('超级管理员')) return null
  const name = raw.toLowerCase()
  const member = access.members.find(item => {
    const ids = [item.id, item.name].map(value => String(value ?? '').trim().toLowerCase()).filter(Boolean)
    return ids.includes(name) || ids.some(value => name.endsWith(value) || name.includes(` ${value}`))
  })
  if (member === undefined) {
    // 名单外的人还能看（否则名字对不上就直接进不去），但一个写操作都不许做。
    if (level === 'read') return null
    return `「${operator}」不在成员名单里：让管理员到「设置 → 权限与审计」把你加进去，或用页头的「我是…」换个名字`
  }
  const rank = ROLE_LEVEL[member.role] ?? 0
  if ((LEVEL_RANK[level] ?? 0) > rank) {
    const need = level === 'admin' ? '管理员' : '成员'
    return `「${operator}」是${ACCESS_ROLE_LABEL[member.role] ?? member.role}，这一步需要${need}权限`
  }
  return null
}

/**
 * 每个工具要求的权限档位。没列出来的一律按「写」处理——收紧是默认，
 * 放松要显式写在这里，避免新工具默默变成后门。
 */
const TOOL_ACCESS = {
  studio_config_get: 'read',
  studio_requirement_list: 'read',
  studio_requirement_get: 'read',
  studio_task_list: 'read',
  studio_task_get: 'read',
  studio_project_list: 'read',
  studio_release_list: 'read',
  studio_release_get: 'read',
  studio_analytics: 'read',
  studio_skill_list: 'read',
  studio_skill_get: 'read',
  studio_config_set: 'admin',
  studio_release_publish: 'admin',
  studio_release_save: 'admin',
  studio_skill_delete: 'admin',
}

function toolLevel(name) {
  return TOOL_ACCESS[name] ?? 'write'
}

/** 会话名形如 `studio-<taskId>-<expertId>`，从里面认出是哪个专家在调用。 */
function operatorFromSessionId(sessionId, config) {
  const match = /^studio-(t-[0-9a-z]+)-(.+)$/.exec(String(sessionId))
  if (match === null) return null
  const expertId = match[2]
  const expert = (config?.experts ?? []).find(item => item.id === expertId)
  return { id: expertId, name: String(expert?.name ?? expertId) }
}

/** 工具调用的身份：优先从会话名解析，解析不出再问派单器。 */
function toolOperator(store, exec) {
  const agent = exec?.agent
  const rawSession = agent?.session ?? exec?.sessionId
  const sessionId = String(
    rawSession !== null && typeof rawSession === 'object'
      ? (rawSession.id ?? rawSession.sessionId ?? '')
      : (rawSession ?? ''),
  )
  if (sessionId === '') return null
  const config = store.snapshot().config
  const parsed = operatorFromSessionId(sessionId, config)
  if (parsed !== null) return { ...parsed, sessionId }
  const dispatcher = activeDispatcher
  if (dispatcher !== undefined && dispatcher?.running instanceof Map) {
    for (const info of dispatcher.running.values()) {
      if (info.sessionId !== sessionId) continue
      const expert = (config?.experts ?? []).find(item => item.id === info.expert)
      return { id: info.expert, name: String(expert?.name ?? info.expert), sessionId }
    }
  }
  return { id: '', name: 'AI', sessionId }
}

/**
 * 工具层的权限判定：和 HTTP 面板用同一张成员名单、同一套档位。
 * `access.agents === 'bypass'` 时只记审计不拦（给「全交给 AI」的团队留一个开关）。
 */
function checkToolAccess(config, operator, toolName) {
  const level = toolLevel(toolName)
  // operator 既可能是名字字符串，也可能是 {id,name}；统一取名字再判。
  const name = typeof operator === 'string' ? operator : String(operator?.name ?? operator?.id ?? '')
  if (config?.access?.enabled !== true) return { level, denial: null }
  if (config.access.agents === 'bypass') return { level, denial: null }
  return { level, denial: checkAccess(config, name, level) }
}

/** 记一条审计：只留摘要，不记正文、不记密钥。写失败不影响主流程。 */async function recordAudit(store, entry) {
  try {
    await store.mutate(state => {
      if (!Array.isArray(state.audit)) state.audit = []
      const at = Date.now()
      state.audit.unshift({
        id: `au-${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        at,
        by: entry.by,
        route: entry.route,
        level: entry.level,
        status: entry.status,
        ok: entry.ok === true,
        summary: String(entry.summary ?? '').slice(0, 200),
      })
      if (state.audit.length > 1000) state.audit.length = 1000
    })
  } catch {
    /* 审计写不进去不能挡住业务 */
  }
}

/** 审计摘要：只留几个识别字段，不搬正文、不搬 token。 */
function auditSummary(body) {
  if (body === null || typeof body !== 'object') return ''
  const parts = []
  for (const key of ['id', 'taskId', 'name', 'title', 'version', 'status', 'action', 'reason', 'project', 'requirementId', 'releaseId', 'expertId']) {
    const value = body[key]
    if (typeof value === 'string' && value.trim() !== '') parts.push(`${key}=${value.trim().slice(0, 40)}`)
  }
  for (const key of ['taskIds', 'caseIds', 'members']) {
    if (Array.isArray(body[key]) && body[key].length > 0) parts.push(`${key}=${body[key].length}`)
  }
  return parts.join(' ').slice(0, 200)
}

/** Register the /studio-api routes. Returns a disposer. */
/* ── 交付闭环增强：用例生成 / 缺陷 SLA / 重复缺陷 / 负载 / 燃尽 ───────────── */

/**
 * 用例不再靠人一条条敲：按需求的「功能点 + 验收条件」推导一遍。
 * 一个功能点有几条验收条件就出几条用例，一条都没有时退化成「主流程」一条。
 */
function draftCases(state, task) {
  const requirement = state.requirements.find(item => item.id === task.requirementId)
  if (requirement === undefined) return { cases: [], reason: '这张卡没挂需求，没有验收标准可以推导用例' }
  const points = (requirement.points ?? []).filter(point => task.pointId === '' || point.id === task.pointId)
  if (points.length === 0) return { cases: [], reason: '这个需求还没拆功能点：先去需求页加功能点与验收条件' }
  const cases = []
  for (const point of points) {
    const lines = (point.acceptance ?? []).filter(item => String(item.text ?? '').trim() !== '')
    if (lines.length === 0) {
      cases.push({ title: `${point.title} 主流程`.slice(0, 200), expected: String(point.description || point.title).slice(0, 300), pointId: point.id })
      continue
    }
    for (const line of lines) {
      cases.push({ title: `${point.title}：${line.text}`.slice(0, 200), expected: String(line.text).slice(0, 300), pointId: point.id })
    }
  }
  return { cases, reason: '' }
}

async function addDraftCases(store, taskId, by = '人') {
  const before = store.snapshot()
  const task = before.tasks.find(item => item.id === taskId)
  if (task === undefined) throw new Error(`no task ${taskId}`)
  const draft = draftCases(before, task)
  if (draft.cases.length === 0) return { added: 0, total: (task.cases ?? []).length, reason: draft.reason }
  const existing = new Set((task.cases ?? []).map(item => item.title))
  let added = 0
  await store.mutate(state => {
    const entry = state.tasks.find(item => item.id === taskId)
    for (const item of draft.cases) {
      if (existing.has(item.title)) continue
      existing.add(item.title)
      entry.cases.push({
        id: `c-${Math.random().toString(36).slice(2, 7)}`,
        title: item.title,
        expected: item.expected,
        result: 'pending',
        note: '',
        pointId: item.pointId,
        by,
        at: Date.now(),
        http: null,
        lastRun: null,
      })
      added += 1
    }
    entry.updatedAt = Date.now()
  })
  const after = store.snapshot().tasks.find(item => item.id === taskId)
  return { added, total: (after?.cases ?? []).length, reason: '' }
}

/** 缺陷 SLA：按严重级别算应修时限，返回预期、剩余与状态。 */
function bugSla(task, config) {
  if (task === null || typeof task !== 'object' || task.type !== 'bug') return null
  const table = sanitizeSla(config?.sla)
  const severity = SEVERITIES.includes(task.severity) ? task.severity : 'p2'
  const hours = table[severity]
  const dueAt = (Number(task.createdAt) || 0) + hours * 3600 * 1000
  const closedAt = task.status === 'done' ? (Number(task.updatedAt) || Date.now()) : 0
  const end = closedAt > 0 ? closedAt : Date.now()
  const remaining = dueAt - end
  let state = 'ok'
  if (closedAt > 0) state = closedAt <= dueAt ? 'met' : 'late'
  else if (remaining < 0) state = 'overdue'
  else if (remaining < hours * 3600 * 1000 * 0.25) state = 'due_soon'
  return { severity, hours, dueAt, closedAt, remaining, state }
}

/** 每个专家手上还有多少活：在办卡、正在跑、近 7 天完成、逾期缺陷。 */
function workloadReport(state, runningList = []) {
  const now = Date.now()
  const week = 7 * 86_400_000
  const runningBy = new Map()
  for (const info of runningList) runningBy.set(info.expert, (runningBy.get(info.expert) ?? 0) + 1)
  const experts = (state.config.experts ?? []).map(expert => {
    let open = 0
    let done7d = 0
    let overdue = 0
    for (const task of state.tasks) {
      const owner = task.dispatch?.expert || task.expert || ''
      if (owner !== expert.id) continue
      if (task.status === 'done') {
        if (now - (Number(task.updatedAt) || 0) <= week) done7d += 1
        continue
      }
      open += 1
      const sla = bugSla(task, state.config)
      if (sla !== null && sla.state === 'overdue') overdue += 1
    }
    return {
      id: expert.id,
      name: expert.name,
      emoji: expert.emoji,
      domain: expert.domain,
      enabled: expert.enabled !== false,
      running: runningBy.get(expert.id) ?? 0,
      open,
      done7d,
      overdue,
    }
  })
  return { experts: experts.sort((a, b) => (b.running - a.running) || (b.open - a.open)), busy: experts.filter(item => item.running > 0).length }
}

/** 燃尽：近 N 天每天结束时的剩余卡数（按创建/完成时间回推）。 */
function burndownReport(state, options = {}) {
  const days = [7, 14, 30].includes(Number(options.days)) ? Number(options.days) : 14
  const project = String(options.project ?? '').trim()
  const tasks = state.tasks.filter(task => project === '' || task.project === project)
  const end = Date.now()
  const start = end - (days - 1) * 86_400_000
  const doneAt = task => {
    const step = (task.history ?? []).find(item => item.status === 'done')
    return step === undefined ? 0 : Number(step.at) || 0
  }
  const series = []
  for (let index = 0; index < days; index += 1) {
    const dayStart = start + index * 86_400_000
    const dayEnd = dayStart + 86_400_000
    const created = tasks.filter(task => (Number(task.createdAt) || 0) < dayEnd).length
    const finished = tasks.filter(task => {
      const at = doneAt(task)
      return at > 0 && at < dayEnd
    }).length
    series.push({
      day: new Date(dayEnd - 1).toISOString().slice(5, 10),
      at: dayEnd,
      created,
      done: finished,
      remaining: Math.max(0, created - finished),
    })
  }
  return { days, project, series, now: { remaining: series[series.length - 1]?.remaining ?? 0 } }
}

/** 把一张缺陷标成另一张的重复（人决定的，不是脚本猜的）。 */
async function markDuplicate(store, id, targetId, by = '人') {
  const state = store.snapshot()
  const task = state.tasks.find(item => item.id === id)
  const target = targetId === '' ? undefined : state.tasks.find(item => item.id === targetId)
  if (task === undefined) throw new Error(`no task ${id}`)
  await store.mutate(current => {
    const entry = current.tasks.find(item => item.id === id)
    entry.duplicateOf = target === undefined ? '' : target.id
    entry.tags = target === undefined ? entry.tags.filter(tag => tag !== '疑似重复') : [...new Set([...entry.tags, '重复'])].filter(tag => tag !== '疑似重复')
    entry.updatedAt = Date.now()
  })
  if (target !== undefined) {
    await commentTask(store, id, `标记为重复：${target.code === '' ? target.id : target.code}「${target.title}」。`, by, 'human')
    await commentTask(store, target.id, `${task.code === '' ? task.id : task.code}「${task.title}」被标成了这张的重复。`, by, 'human')
  }
  return store.snapshot().tasks.find(item => item.id === id)
}

function registerRoutes(webCtx, store, ctx, getDispatcher = () => undefined) {
  attachSessionStore(store)
  const core = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://studio.local')
      const route = url.pathname.replace(/^\/studio-api/, '') || '/'
      const method = (req.method ?? 'GET').toUpperCase()
      await store.ready
      /* registerRoutes 是同步调用的，那时 #boot 还没跑完（db 还是 null），
         所以第一次请求到达、store 真正就绪之后再恢复会话。 */
      if (SESSION_STORE === null) attachSessionStore(store)

      // 统一登录：开了 requireLogin 之后，除了登录相关的几个接口，其余都要带会话。
      // 没开的时候（默认）平台直接以本地超管身份运行，不会要求登录。
      {
        const configNow = store.snapshot().config
        const ldapNow = configNow.ldap ?? {}
        const localNow = sanitizeLocalAuth(configNow.localAuth)
        const locked = ldapNow.enabled === true && ldapNow.requireLogin === true
        const openRoutes = new Set(['/intake', '/intake/requirement', '/intake/status', '/intake/query', '/intake/mine', '/intake/mine/query', '/auth/login', '/auth/me', '/auth/logout', '/auth/password', '/auth/ldap/test', '/audit/export.csv', '/export/dispatch.csv', '/state', '/'])
        const session = sessionOf(req, configNow)
        if (session !== null) {
          req.studioActor = String(session.user.name ?? session.user.id ?? '').slice(0, 40)
        } else if (!locked) {
          req.studioActor = localNow.username === 'admin' ? '超管 admin' : localNow.username
        }
        if (locked && !openRoutes.has(route) && session === null) {
          sendJson(res, 401, { ok: false, code: 'login_required', error: '需要登录（统一登录已开启）' })
          return
        }
        if (locked && (route === '/state' || route === '/') && session === null) {
          sendJson(res, 200, { ok: true, locked: true, state: { revision: Number(store.snapshot().revision) || 1, config: publicConfig(configNow), tasks: [], requirements: [], releases: [] } })
          return
        }
      }

      if (method === 'GET' && (route === '/' || route === '/state')) {
        const dispatcher = getDispatcher()
        const state = publicState(store)
        sendJson(res, 200, { ok: true, state: dispatcher === undefined ? state : { ...state, agents: dispatcher.status() } })
        return
      }
      if (await handleAuthRoute({ method, route, req, res, store, url })) return
      if (method === 'GET' && route === '/agents/probe') {
        const dispatcher = getDispatcher()
        sendJson(res, 200, { ok: true, probe: dispatcher === undefined ? {} : await dispatcher.probePrompt() })
        return
      }
      if (method === 'GET' && route === '/models') {
        sendJson(res, 200, { ok: true, models: await listModels(ctx) })
        return
      }
      if (await handleSkillsRoute({ method, route, req, res, store, url })) return
      if (await handleAdminRoute({ method, route, req, res, store, url })) return
      if (await handleTaskRoute({ method, route, req, res, store, url })) return
      if (handleExportRoute({ method, route, url, res, store, sendJson })) return
      if (await handleCodingRoute({ method, route, req, res, store, url })) return
      if (await handleRequirementRoute({ method, route, req, res, store, url })) return
      if (await handleReleasesRoute({ method, route, req, res, store, url })) return
      if (await handleInsightsRoute({ method, route, req, res, store, url })) return
      if (method === 'POST' && route === '/task/cases/generate') {
        const body = await readJsonBody(req)
        const task = store.snapshot().tasks.find(entry => entry.id === body.id)
        if (task === undefined) {
          sendJson(res, 404, { ok: false, error: 'no such task' })
          return
        }
        const result = await addDraftCases(store, task.id, operatorOf(req))
        sendJson(res, 200, { ok: true, ...result, task: store.snapshot().tasks.find(entry => entry.id === task.id), state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/task/duplicate') {
        const body = await readJsonBody(req)
        const task = await markDuplicate(store, body.id, String(body.targetId ?? ''), operatorOf(req))
        sendJson(res, 200, { ok: true, task, state: publicState(store) })
        return
      }
      if (await handleAgentsRoute({ method, route, req, res, store, url })) return
      if (await handleConnectRoute({ method, route, req, res, store, url })) return
      sendJson(res, 404, { ok: false, error: `no route ${method} ${route}` })
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? String(error.stack ?? '').split('\n').slice(0, 6).join(' | ') : '',
      })
    }
  }
  const handler = async (req, res) => {
    await store.ready
    const url = new URL(req.url ?? '/', 'http://studio.local')
    const route = url.pathname.replace(/^\/studio-api/, '') || '/'
    const method = (req.method ?? 'GET').toUpperCase()
    const resolved = resolveActor(req, store.snapshot().config)
    if (resolved !== '') req.studioActor = resolved
    const operator = operatorOf(req)
    // 登录/登出/改密绝不能受权限名单影响，否则一旦开启权限就再也登不进来。
  // 取交付物正文走的是 POST（同一个入口的 get 动作），但它只是读：别被写档位挡住只读成员。
  const level = route.startsWith('/auth/')
    ? 'read'
    : (route === '/task/artifact' && String(req.__studioBody?.action ?? '') === 'get')
      ? 'read'
      : accessLevelFor(route, method)
    let summary = ''
    if (method === 'POST') {
      try {
        req.__studioBody = await readJsonBody(req)
        summary = auditSummary(req.__studioBody)
      } catch {
        /* 坏 JSON 交给下面的 core 去报 400 */
      }
    }
    const denied = checkAccess(store.snapshot().config, operator, level)
    if (denied !== null) {
      await recordAudit(store, { by: operator, route, level, status: 403, ok: false, summary: `${denied}${summary === '' ? '' : ` | ${summary}`}` })
      sendJson(res, 403, { ok: false, error: denied })
      return
    }
    try {
      await core(req, res)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
    if (method === 'POST') {
      await recordAudit(store, {
        by: operator,
        route,
        level,
        status: res.statusCode ?? 200,
        ok: (res.statusCode ?? 200) < 400,
        summary,
      })
    }
  }
  return webCtx.webServer.register({ kind: 'prefix', path: '/studio-api', handler })
}

/** Best-effort model catalogue from the llm service. */
async function listModels(ctx) {
  try {
    const llm = ctx.get?.('llm')
    if (llm === undefined || typeof llm.listProviders !== 'function') return []
    const providers = llm.listProviders()
    const out = []
    for (const provider of providers) {
      try {
        // llm.listModels(provider) 是异步的；旧写法 llm.models?.() 不存在，永远拿不到模型。
        const models = typeof llm.listModels === 'function' ? await llm.listModels(provider.id) : []
        for (const model of models ?? []) out.push({ provider: provider.id, model: model.id ?? model, name: model.name ?? '' })
      } catch { /* skip provider */ }
    }
    return out
  } catch {
    return []
  }
}

/** Agent-facing tools. */

/** The agent-facing protocol section. */
const PROTOCOL = `# Studio 工作看板协议

本环境有一个跨角色的工作看板（工具前缀 studio_）。专家（产品、架构、研发、测试，以及公司自己配置的其他专家）和专家团通过它交接工作，人通过 Web 端「需求&任务工作空间」面板查看同一份数据。

- 接活前先 studio_task_list 找到指派给自己或待处理的卡，再 studio_task_get 读全量与评论。多项目并行时先看卡上的 project 字段，别把两个项目的事混在一起。
- **需求是链路的锚点**：每张卡都应该挂在一个需求（REQ-YYYY-NNN）下，卡上会带一个编号（DEV-001 / TEST-001 / BUG-001）。开新卡时用 requirementId 挂到对应需求；用 studio_requirement_get 能看到这条需求下面的全部卡片、产物、用例和 MR。找不到对应需求就先 studio_requirement_save 建一条，别让卡悬空。
- **需求要收到完工才算交付**：一条需求的所有卡都完成、功能点都有通过用例覆盖、没有阻塞和未结缺陷后，用 studio_requirement_signoff 写上验收结论签字；签字前 requirement_get 返回的 progress.gate.blockers 会列出还差什么。
- 状态推进：待澄清 → 待方案 → 待开发 → 开发中 → 待评审 → 待测试 → 待验收 → 已完成；卡住时用 studio_task_block 打阻塞标记（卡留在原列，不自动往下派，等人来定怎么继续），能继续了再由人解除。
- 研发提了 MR 就会被同步到卡上（gitlabMR），并自动进入「待评审」；架构师评审通过才放行到「待测试」，不通过就 @ 开发退回「开发中」。
- **研发必须留执行记录**：改完代码调 studio_task_coding 登记 agent/model、分支、commits、改动文件、单测结果；评审的人在同一张卡上 action=review 写结论。谁照着哪版需求改了什么，靠这份记录回答。
- 测试环节用 studio_task_case 把用例登记到卡上（做什么、期望什么）。**能写成接口调用的用例，就把 method/url/expectStatus/expectContains 一起写上**，然后用 studio_test_run 真的跑一遍——平台发请求、比对结果、写回状态、留下执行记录；跑不了的（需要人工操作、看 UI、连设备）才自己执行并回填 result。**用例判 fail 平台会自动开缺陷卡（父任务指向测试卡），不要手工重复建 Bug**；缺陷卡修好进「待测试」时，平台会自动把来源用例重置为待执行，测试复跑通过即可关闭缺陷。
- 每完成一步用 studio_task_comment 留下证据（方案要点、改动文件、测试命令与结果、MR 链接），不要只改状态。
- **交付物要落到卡上，并归档到云盘**：每做完一件能给人看的东西（需求说明、方案文档、MR、用例集、测试报告、发布说明），就用 studio_task_artifact 登记一条（kind + title + ref + **content 正文**）。登记时默认会把它写成飞书云盘里「该需求文件夹」下的一份 Markdown 文档（同名会覆盖更新）。只在评论里说"已经完成"不算交付。需求文件夹用 studio_requirement_folder 查看或补建。
- **验收清单就是"做完"的定义**：用 studio_task_check 勾掉你实际做完的条目，附证据（命令输出、文件路径、测试结果）。没做完的不要勾。
- 评论里用 @专家名 或 @专家团名 可以点名让某个专家接着做——被 @ 的专家会收到这条评论并开始工作。需要别的角色配合时，在评论里 @ 对方，而不是自己代做。
- 专家团协作时由团长拆活、给成员派活、汇总结论；成员之间用 @ 互相接棒。
- 评审不通过时把卡退回上一状态并说明原因，不要新建重复卡。发现缺陷时新开一张 type=bug 的卡，并用 parent 指回它来自的那张需求卡。
- 一次只推进一张卡；不要把无关工作塞进同一张卡。
- 技能库：用 studio_skill_list 看公司积累的技能，studio_skill_get 读全文，skill 工具加载后照着做。这次摸索出可复用的做法（命令、坑、检查清单）就用 studio_skill_save 写成一条技能，下次别的专家直接能用——不要让它停留在这次对话里。`

let syncTimer
let activeDispatcher
let activeStore = null

// ------------------------------------------------------------------- mount

/**
 * Mount the host half.
 * @param ctx - plugin context carrying tools + systemPrompt.
 */
export function apply(ctx) {
  const store = new StudioStore(dshHomePath('dsh-studio.json'), {
    dbFile: dshHomePath('dsh-studio.db'),
    secrets: new SecretStore(dshHomePath('dsh-studio.secrets.json')),
    snapshotLimit: 10,
  })
  const skills = new SkillLibrary(dshHomePath('dsh-studio-skills.json'))
  activeStore = store
  activeSkills = skills

  // 记住自己跑在哪个 profile：市场装卸与「profile xxx」展示都靠它。
  ctx.effect(() => {
    let alive = true
    void currentProfile().then(name => { if (alive) hostProfile = name })
    return () => { alive = false }
  }, 'dsh-studio: host profile')

  // Materialize the library once at boot so a wiped ~/.dsh/skills heals itself.
  ctx.effect(() => {
    skills.syncAll().catch(() => {})
    return () => { activeSkills = undefined }
  }, 'dsh-studio: skill library boot sync')

  // lark-cli 探活：启动探一次，之后每 5 分钟刷新，面板上的「飞书授权」状态靠它。
  ctx.effect(() => {
    let alive = true
    void larkCliReady()
    const timer = setInterval(() => {
      if (!alive) return
      invalidateLarkProbe()
      void larkCliReady()
    }, 300000)
    timer.unref?.()
    return () => { alive = false; clearInterval(timer) }
  }, 'dsh-studio: lark probe')

  const disposeSection = ctx.systemPrompt.section({ name: 'studio-protocol', order: 70, text: PROTOCOL })
  ctx.effect(() => disposeSection, 'dsh-studio: protocol section')

  configureToolHost({
    addDraftCases, applyConfig, auditSummary, buildAnalytics, buildMetrics, burndownReport, checkToolAccess, createTask,
    releaseGate, releaseNotes, skillsRoot, taskLine, toolLevel, toolOperator, upsertById, workloadReport,
    getActiveDispatcher: () => activeDispatcher, getActiveSkills: () => activeSkills,
  })
  const disposeTools = registerTools(ctx, store)
  ctx.effect(() => () => { for (const dispose of disposeTools.splice(0)) dispose() }, 'dsh-studio: tools')

  ctx.effect(() => {
    syncTimer = setInterval(() => {
      const config = store.snapshot().config
      const due = (config.gitlab.projects ?? []).filter(project => project.syncEnabled === true && projectReady(config, project))
      if (due.length === 0) return
      for (const project of due) {
        gitlabSync(store, project.id).catch(error => {
          const message = String(error?.message ?? error).slice(0, 300)
          INTEGRATION.lastSyncError = message
          store.mutate(state => {
            const row = state.config.gitlab.projects.find(entry => entry.id === project.id)
            if (row !== undefined) row.lastSyncError = message
          }).catch(() => {})
        })
      }
    }, 60_000)
    syncTimer.unref?.()
    return () => {
      if (syncTimer !== undefined) clearInterval(syncTimer)
      syncTimer = undefined
    }
  }, 'dsh-studio: gitlab sync timer')

  /** Set once the host services the dispatcher needs are available. */
  let dispatcher

  configureExecutor({
    autoBugFromCase,
    publicState,
    serviceDependencies,
    serviceConflicts,
    bugSla,
    releaseGate,
    get activeDispatcher() { return activeDispatcher },
    healthReport,
    markHealth,
    dshHomePath,
    broadcastChange,
    INTEGRATION,
    resetOriginCase,
  })

  ctx.inject(['webServer'], webCtx => {
    const disposeRoutes = registerRoutes(webCtx, store, ctx, () => dispatcher)
    return () => disposeRoutes()
  })

  ctx.inject(['agents', 'sessionController', 'workspaceRegistry', 'permissionPresets', 'agentDefaultModel'], dispatcherCtx => {
    configureDispatcher({ feishuBroadcast, INTEGRATION, bugSla, removeWorktree, ensureWorktree, serviceOf, workProjectOf, serviceConflicts })
    configureIntegrations({ newTaskId, serviceOf, getStore: () => activeStore })
    configureExportRoutes({ sendCsv, requirementProgress, sessions: SESSIONS })
    configureCodingRoutes({ applyConfig, ensureWorktree, publicState, readJsonBody, removeWorktree, sendJson, serviceOf, upsertById, workProjectOf })
    configureAgentsRoutes({ publicState, readJsonBody, sendJson, getDispatcher: () => activeDispatcher })
    configureConnectRoutes({ applyConfig, installedPackages, publicState, readJsonBody, resolvePackageName, runPluginCli, sendJson, upsertById, getSyncTimer: () => syncTimer })
    configureAdminRoutes({ applyConfig, checkToolAccess, operatorFromSessionId, operatorOf, publicState, readJsonBody, sendJson })
    configureSkillsRoutes({ isSkillName, readJsonBody, sendJson, skillFromMarkdown, skillFromZip, skillsRoot, getSkills: () => activeSkills })
    configureInsightsRoutes({ getDispatcher: () => activeDispatcher, sendJson, buildMetrics, buildAnalytics, workloadReport, burndownReport })
    configureReleasesRoutes({ sendJson, readJsonBody, publicState, releaseGate, releaseNotes, releaseRequirements, releaseRuleViolations, releaseDeploys })
    configureRequirementRoutes({ sendJson, readJsonBody, createTask, publicState })
    configureTaskRoutes({
      sendJson,
      readJsonBody,
      createTask,
      updateTask,
      commentTask,
      runTaskCases,
      syncArtifact,
      applyConfig,
      getDispatcher: () => activeDispatcher,
      autoBugFromCase,
      publicState,
      upsertById,
    })
    configureAuthRoutes({ sendJson, readJsonBody, recordAudit, recordLogin, issueSession, sessionOf, operatorOf, ldapAuthenticate, ldapLookup, ldapAttr, sessions: SESSIONS, dropSession: token => SESSION_STORE?.dropSession?.(token), hasSessionStore: () => SESSION_STORE !== null, publicState })
    dispatcher = new Dispatcher(dispatcherCtx, store)
    activeDispatcher = dispatcher
    dispatcher.start()
    const offStatus = dispatcherCtx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') dispatcher?.settle(agent.id)
    })
    return () => {
      dispatcher?.stop()
      dispatcher = undefined
      activeDispatcher = undefined
      offStatus?.()
    }
  })
}
