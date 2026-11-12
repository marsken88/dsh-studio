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


import { ACCESS_ROLE_LABEL, ACCESS_ROLES, ADMIN_ROUTES, ARTIFACT_KINDS, ARTIFACT_STATUS, CASE_HTTP_METHODS, CASE_PRIORITIES, CASE_RESULTS, CASE_TYPE_LABEL, CASE_TYPES, cleanId, CODE_PREFIX, CODING_FILE_CHANGES, CODING_REVIEW_STATUS, codingSummary, COLUMN_STRATEGIES, DEFAULT_ROLES, defaultColumns, defaultConfig, defaultDeployEnvs, defaultTemplates, DEPLOY_ENV_KINDS, FALLBACK_AGENT_MODEL, hashLocalPassword, INTAKE_HTML, ISOLATION_MODES, LEGACY_BLOCKED_STATUS, LEVEL_RANK, LOCAL_DEFAULT_PASSWORD, mergeCoding, mergeConfig, mergeSection, MINE_HTML, nextRequirementCode, nextTaskCode, normalizePatch, normalizeStrategy, PRIORITIES, ROLE_LABELS, canonicalAuthor, RELEASE_STATUSES, RELEASE_STATUS_LABEL, REQ_DOC_KIND_LABEL, REQ_DOC_KINDS, REQ_DOC_STATUS, REQ_REVIEW_LABEL, REQ_REVIEW_STATUS, REQ_STATUS_LABEL, REQ_STATUSES, ROLE_IDS, ROLE_LEVEL, SANDBOX_MODES, sanitizeAcceptanceItem, sanitizeAccess, sanitizeAllowHosts, sanitizeArtifact, sanitizeArtifacts, sanitizeBaseline, sanitizeBots, sanitizeBugSource, sanitizeCase, sanitizeCaseHttp, sanitizeCaseRun, sanitizeCases, sanitizeChangedFile, sanitizeChangedFiles, sanitizeChecklist, sanitizeChecklistItem, sanitizeCoding, sanitizeColumns, sanitizeCommit, sanitizeCommits, sanitizeCosts, sanitizeDeployEnvs, sanitizeEnvs, sanitizeExperts, sanitizeIterations, sanitizeLdap, sanitizeLocalAuth, sanitizeProjects, sanitizeReqDoc, sanitizeReqDocs, sanitizeRelease, sanitizeRequirement, sanitizeRequirementChange, sanitizeRequirementHistory, sanitizeRequirementPoint, sanitizeRequirementPoints, sanitizeRequirementPool, sanitizeRequirementQuestions, sanitizeRequirementReview, sanitizeRequirements, sanitizeServices, sanitizeSla, sanitizeTeams, sanitizeTemplates, sanitizeTesting, sanitizeTestRun, sanitizeTestRuns, sanitizeUsers, sanitizeWorkProjects, seedExperts, SEVERITIES, STATUS_HTML, STATUS_IDS, STATUS_SET, STATUSES, TASK_TYPES, text, verifyLocalPassword, worktreeRoot } from './src/host/domain.js'
import { Dispatcher, RUN_LOG, claimDispatchLock, clearAgentFailure, configureDispatcher, noteAgentFailure, parseMentions, runSummary } from './src/host/dispatcher.js'
import { buildDashboard, codingVerifyLine, commentTask, configureExecutor, ensureReqFolder, larkCliReady, invalidateLarkProbe, larkProbeCache, mutateReqDoc, pullFeishuDoc, requirementGate, requirementMatrix, requirementProgress, requirementRollup, runCommand, runSuite, runTaskCases, saveRequirement, syncArtifact, syncRequirementArtifacts, taskExitGate, updateTask, verifyCodingRecord } from './src/host/executor.js'
import { configureExportRoutes, handleExportRoute } from './src/host/routes/exports.js'
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
    tasks: state.tasks.map(task => ({ ...task, sla: bugSla(task, state.config) })),
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

/** Compile the author-facing parameter spec into a registry-ready tool. */
function defineStudioTool(spec) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec.parameters ?? {})) {
    const { required: isRequired, ...schema } = value
    properties[key] = schema
    if (isRequired === true) required.push(key)
  }
  const parameters = { type: 'object', properties }
  if (required.length > 0) parameters.required = required
  return {
    name: spec.name,
    description: spec.description,
    parameters,
    output: {
      schema: {},
      render(_args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
      },
    },
    execute: spec.execute,
  }
}

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
      if (method === 'POST' && route === '/auth/login') {
        const body = await readJsonBody(req)
        const ip = String(req.socket?.remoteAddress ?? '')
        const config = store.snapshot().config
        const settings = sanitizeLdap(config.ldap ?? {})
        /* 中文输入法会把 admin 打成全角 ａｄｍｉｎ，NFKC 归一后再比对，免得
           用户明明敲对了却被告知口令不对（典型：口令框里混进全角字母/空格）。 */
        const username = String(body.username ?? body.user ?? '').trim().normalize('NFKC')
        const password = String(body.password ?? '').normalize('NFKC')
        const wideChar = /[\uFF01-\uFF5E\u3000]/.test(String(body.password ?? ''))
        // mode: local = 只试本地账号；ldap = 只试目录；'' = 先本地后目录（老调用方兼容）
        const mode = String(body.mode ?? '').trim().toLowerCase()

        /* 先试本地超管：没配 LDAP 时它是唯一账号，配了也能在目录故障时兜底。 */
        const local = mode === 'ldap' ? { ok: false, reason: 'skipped' } : verifyLocalPassword(config.localAuth, username, password)
        if (local.ok === true) {
          const localUser = sanitizeLocalAuth(config.localAuth)
          const user = { id: localUser.username, name: '超级管理员', role: 'admin', source: 'local', mail: '', dept: '' }
          const session = issueSession(user, ip)
          await recordAudit(store, { by: user.name, route, level: 'read', status: 200, ok: true, summary: `本地超管登录成功：${user.id}` })
          sendJson(res, 200, { ok: true, token: session.token, expiresAt: session.expiresAt, user, state: publicState(store) })
          return
        }

        if (mode === 'local') {
          const localUser = sanitizeLocalAuth(config.localAuth)
          const hint =
            local.reason === 'nouser'
              ? `没有这个本地账号（本地超管是 ${localUser.username}）`
              : local.reason === 'form'
                ? '账号和密码都要填'
                : wideChar
                  ? `口令里有全角字符（中文输入法打出来的），切到英文输入法再输一次；账号 ${localUser.username}${localUser.password === null ? '，默认口令是 admin' : ''}`
                  : `本地超管的账号或口令不对（账号 ${localUser.username}${localUser.password === null ? '，还没改过口令就是默认的 admin' : ''}）`
          await recordAudit(store, { by: username === '' ? '匿名' : username.slice(0, 40), route, level: 'read', status: 401, ok: false, summary: `本地登录失败：${hint}` })
          sendJson(res, 401, { ok: false, code: 'local', error: hint })
          return
        }

        const result = await ldapAuthenticate(settings, username, password)
        if (result.ok !== true) {
          const hint =
            result.code === 'disabled' && local.reason === 'badpass'
              ? `用户名或密码不对（本地超管账号是 ${sanitizeLocalAuth(config.localAuth).username}；LDAP 登录还没启用）`
              : result.message
          await recordAudit(store, { by: username === '' ? '匿名' : username.slice(0, 40), route, level: 'read', status: 401, ok: false, summary: `登录失败：${hint}` })
          sendJson(res, 401, { ok: false, code: result.code, error: hint })
          return
        }
        await recordLogin(store, result.user, ip)
        const session = issueSession(result.user, ip)
        await recordAudit(store, { by: result.user.name, route, level: 'read', status: 200, ok: true, summary: `LDAP 登录成功：${result.user.id}` })
        const saved = (store.snapshot().config.users ?? []).find(item => item.id === result.user.id) ?? {}
        sendJson(res, 200, { ok: true, token: session.token, expiresAt: session.expiresAt, user: { ...result.user, ...saved }, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/auth/password') {
        const body = await readJsonBody(req)
        const config = store.snapshot().config
        const local = sanitizeLocalAuth(config.localAuth)
        const username = String(body.username ?? local.username).trim().toLowerCase().normalize('NFKC')
        const currentPassword = String(body.currentPassword ?? '').normalize('NFKC')
        const check = verifyLocalPassword(local, username, currentPassword)
        if (check.ok !== true) {
          sendJson(res, 401, { ok: false, code: check.reason, error: check.reason === 'nouser' ? '没有这个本地账号' : '当前密码不对' })
          return
        }
        const next = String(body.newPassword ?? '').normalize('NFKC')
        if (body.reset !== true && next.length < 8) {
          sendJson(res, 400, { ok: false, error: '新密码至少 8 位' })
          return
        }
        if (body.reset !== true && next === currentPassword) {
          sendJson(res, 400, { ok: false, error: '新密码和当前密码一样' })
          return
        }
        await store.mutate(state => {
          const current = sanitizeLocalAuth(state.config.localAuth)
          state.config.localAuth =
            body.reset === true
              ? { ...current, password: null, mustChange: true, updatedAt: Date.now() }
              : { ...current, password: hashLocalPassword(next), mustChange: false, updatedAt: Date.now() }
        })
        await recordAudit(store, { by: operatorOf(req), route, level: 'admin', status: 200, ok: true, summary: body.reset === true ? '重置本地超管密码为默认' : '修改本地超管密码' })
        sendJson(res, 200, { ok: true, state: publicState(store) })
        return
      }
      if (method === 'GET' && route === '/auth/me') {
        const found = sessionOf(req, store.snapshot().config)
        if (found === null) {
          sendJson(res, 401, { ok: false, error: '没有登录或会话已过期' })
          return
        }
        sendJson(res, 200, { ok: true, user: found.user, expiresAt: found.session.expiresAt })
        return
      }
      if (method === 'POST' && route === '/auth/logout') {
        const rawToken = req.headers['x-studio-session']
        const token = String((Array.isArray(rawToken) ? rawToken[0] : rawToken) ?? '').trim()
        if (token !== '') {
          SESSIONS.delete(token)
          if (SESSION_STORE !== null) SESSION_STORE.dropSession(token)
        }
        sendJson(res, 200, { ok: true })
        return
      }
      if (method === 'POST' && route === '/auth/ldap/test') {
        const body = await readJsonBody(req)
        const config = store.snapshot().config
        const settings = sanitizeLdap({ ...(config.ldap ?? {}), ...(body.ldap !== null && typeof body.ldap === 'object' ? body.ldap : {}) })
        if (String(body.bindPassword ?? '') !== '') settings.bindPassword = String(body.bindPassword)
        const steps = []
        const started = Date.now()
        const lookup = await ldapLookup(settings, String(body.username ?? '').trim() || '*')
        steps.push({ name: '服务账号绑定并查询', ok: lookup.ok === true, message: lookup.ok === true ? `查到 ${lookup.entries.length} 条` : lookup.message, ms: Date.now() - started })
        if (lookup.ok === true && lookup.entries.length > 0) {
          const entry = lookup.entries[0]
          steps.push({
            name: '第一个命中的账号',
            ok: true,
            message: `${ldapAttr(entry, 'sAMAccountName') || ldapAttr(entry, 'uid') || '(无 sAMAccountName)'} · ${ldapAttr(entry, settings.nameAttr) || ldapAttr(entry, 'cn') || '(无显示名)'} · ${entry.dn}`,
            ms: 0,
          })
        }
        const ok = steps.every(step => step.ok === true)
        sendJson(res, ok ? 200 : 400, { ok, steps, message: ok ? '连接正常，可以保存' : steps.find(step => step.ok !== true)?.message ?? '测试没通过' })
        return
      }
      if (method === 'GET' && route === '/agents/probe') {
        const dispatcher = getDispatcher()
        sendJson(res, 200, { ok: true, probe: dispatcher === undefined ? {} : await dispatcher.probePrompt() })
        return
      }
      if (method === 'GET' && route === '/models') {
        sendJson(res, 200, { ok: true, models: await listModels(ctx) })
        return
      }
      if (route.startsWith('/skills')) {
        if (activeSkills === undefined) throw new Error('技能库尚未就绪')
        if (method === 'GET' && route === '/skills') {
          sendJson(res, 200, { ok: true, root: skillsRoot(), skills: activeSkills.list(), onDisk: await activeSkills.visibleRoots() })
          return
        }
        if (method === 'POST' && route === '/skills/save') {
          const body = await readJsonBody(req)
          const { skill, file, warning } = await activeSkills.save(body.skill ?? body)
          sendJson(res, 200, { ok: true, skill, file, warning, skills: activeSkills.list() })
          return
        }
        if (method === 'POST' && route === '/skills/delete') {
          const body = await readJsonBody(req)
          await activeSkills.remove(String(body.name ?? ''))
          sendJson(res, 200, { ok: true, skills: activeSkills.list() })
          return
        }
        if (method === 'POST' && route === '/skills/sync') {
          const { written } = await activeSkills.syncAll()
          sendJson(res, 200, { ok: true, written, skills: activeSkills.list() })
          return
        }
        if (method === 'POST' && route === '/skills/upload') {
          const body = await readJsonBody(req)
          const fileName = String(body.fileName ?? body.name ?? '').trim()
          const encoded = String(body.dataBase64 ?? '')
          const plain = typeof body.text === 'string' ? body.text : ''
          let text = plain
          let sourceName = fileName
          if (encoded !== '') {
            const buffer = Buffer.from(encoded, 'base64')
            if (buffer.length === 0) throw new Error('上传的文件是空的')
            if (buffer.length > 1_400_000) throw new Error('文件太大：技能包请控制在 1.4MB 以内（正文本身上限 6 万字）')
            if (buffer.subarray(0, 2).toString('latin1') === 'PK') {
              const unzipped = await skillFromZip(buffer)
              if (!unzipped.ok) throw new Error(unzipped.error)
              text = unzipped.text
              sourceName = unzipped.fileName
            } else {
              text = buffer.toString('utf8')
            }
          }
          if (String(text).trim() === '') throw new Error('没读到内容：请上传 SKILL.md，或包含 SKILL.md 的 .zip')
          const draft = skillFromMarkdown(sourceName, text)
          if (!isSkillName(draft.name)) {
            throw new Error('从文件里推不出合法的技能名（kebab-case）：在 frontmatter 里加一行 name: my-skill 再传')
          }
          const existing = activeSkills.get(draft.name)
          if (existing !== undefined && body.overwrite !== true) {
            throw new Error(`技能「${draft.name}」已经在库里了：换个文件名，或勾上「覆盖同名技能」再传。`)
          }
          const { skill, file, warning } = await activeSkills.save(draft)
          sendJson(res, 200, { ok: true, skill, file, warning, overwritten: existing !== undefined, skills: activeSkills.list() })
          return
        }
      }
      if (method === 'POST' && route === '/config') {
        await applyConfig(store, await readJsonBody(req))
        sendJson(res, 200, { ok: true, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/access/save') {
        const body = await readJsonBody(req)
        const member = body.member !== null && typeof body.member === 'object' ? body.member : null
        await store.mutate(state => {
          const access = state.config.access ?? { enabled: false, agents: 'inherit', members: [] }
          const wasEnabled = access.enabled === true
          if (typeof body.enabled === 'boolean') access.enabled = body.enabled
          if (body.agents === 'inherit' || body.agents === 'bypass') access.agents = body.agents
          if (member !== null) {
            const name = String(member.name ?? '').trim()
            if (name !== '') {
              const key = name.toLowerCase()
              const rest = access.members.filter(item => item.name.toLowerCase() !== key)
              access.members = sanitizeAccess({ members: [...rest, member] }).members
            }
          }
          // 刚打开权限时，把现有专家按「成员」自动登记：否则所有 AI 会在下一张卡上被自己人拦死。
          if (wasEnabled !== true && access.enabled === true) {
            const known = new Set(access.members.map(item => item.name.toLowerCase()))
            for (const expert of state.config.experts ?? []) {
              if (expert.enabled === false) continue
              const name = String(expert.name ?? '').trim()
              if (name === '' || known.has(name.toLowerCase())) continue
              known.add(name.toLowerCase())
              access.members.push({ name, role: 'member' })
            }
          }
          state.config.access = access
        })
        sendJson(res, 200, { ok: true, access: store.snapshot().config.access, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/access/delete') {
        const body = await readJsonBody(req)
        const name = String(body.name ?? '').trim().toLowerCase()
        await store.mutate(state => {
          state.config.access.members = state.config.access.members.filter(item => item.name.toLowerCase() !== name)
        })
        sendJson(res, 200, { ok: true, access: store.snapshot().config.access, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/audit/clear') {
        await store.mutate(state => { state.audit = [] })
        sendJson(res, 200, { ok: true, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/access/explain') {
        const body = await readJsonBody(req)
        const config = store.snapshot().config
        const sessionId = String(body.sessionId ?? '')
        const tool = String(body.tool ?? '')
        const resolved = operatorFromSessionId(sessionId, config)
        const who = operatorOf(req)
        const operator = resolved ?? { id: who, name: who }
        const verdict = checkToolAccess(config, operator, tool)
        sendJson(res, 200, {
          ok: true,
          operator,
          tool,
          level: verdict.level,
          allowed: verdict.denial === null,
          reason: verdict.denial ?? '',
          mode: config?.access?.enabled === true ? (config.access.agents ?? 'inherit') : 'off',
        })
        return
      }
      if (method === 'GET' && route === '/snapshots') {
        sendJson(res, 200, { ok: true, storage: store.describe(), snapshots: store.snapshots() })
        return
      }
      if (method === 'POST' && route === '/snapshot/restore') {
        const body = await readJsonBody(req)
        await store.restoreSnapshot(String(body.id ?? ''))
        sendJson(res, 200, { ok: true, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/task/create') {
        const task = await createTask(store, await readJsonBody(req))
        sendJson(res, 200, { ok: true, task, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/task/update') {
        const body = await readJsonBody(req)
        const task = await updateTask(store, String(body.id ?? ''), body.patch ?? body)
        sendJson(res, 200, { ok: true, task, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/task/block') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        const reason = text(body.reason, 500) ?? ''
        if (reason === '') {
          sendJson(res, 400, { ok: false, error: '请写清楚卡在哪了，方便之后判断怎么继续' })
          return
        }
        const task = await updateTask(store, id, {
          blocked: true,
          blockedReason: reason,
          by: text(body.by, 60) ?? '人',
        })
        // 卡住就停手：把这个专家正在跑的会话收掉，避免它继续往前走。
        getDispatcher()?.abortTask?.(id)
        sendJson(res, 200, { ok: true, task, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/task/unblock') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        const by = text(body.by, 60) ?? '人'
        const action = String(body.action ?? 'resume')
        let task = await updateTask(store, id, { blocked: false, by })
        if (action === 'advance') {
          const index = STATUSES.findIndex(entry => entry.id === task.status)
          const next = STATUSES[Math.min(index + 1, STATUSES.length - 1)]
          task = await updateTask(store, id, { status: next.id, by })
        }
        const dispatcher = getDispatcher()
        const ran = []
        if (dispatcher !== undefined && action !== 'clear') {
          try {
            await dispatcher.launchNow(id, action === 'assign' ? String(body.expert ?? '') : undefined)
            ran.push(action === 'assign' ? `expert:${String(body.expert ?? '')}` : 'column-owner')
          } catch (error) {
            ran.push(`failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        sendJson(res, 200, { ok: true, task, ran, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/task/comment') {
        const body = await readJsonBody(req)
        const { task, mentions } = await commentTask(store, String(body.id ?? ''), body.body, body.author, body.kind)
        const dispatcher = getDispatcher()
        const dispatched = []
        if (dispatcher !== undefined) {
          for (const mention of mentions) {
            try {
              await dispatcher.dispatchMention(task.id, mention, String(body.body ?? ''))
              dispatched.push(`${mention.kind}:${mention.id}`)
            } catch (error) {
              dispatched.push(`${mention.kind}:${mention.id} failed: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        }
        sendJson(res, 200, { ok: true, task, mentions, dispatched, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/mention') {
        const dispatcher = getDispatcher()
        if (dispatcher === undefined) throw new Error('dispatcher not available yet')
        const body = await readJsonBody(req)
        const mention = { kind: body.kind === 'team' ? 'team' : 'expert', id: String(body.id ?? '') }
        await dispatcher.dispatchMention(String(body.taskId ?? ''), mention, String(body.instruction ?? ''))
        sendJson(res, 200, { ok: true, state: publicState(store), agents: dispatcher.status() })
        return
      }
      if (method === 'POST' && route === '/experts/save') {
        const body = await readJsonBody(req)
        await applyConfig(store, { experts: upsertById(store.snapshot().config.experts, body.expert ?? body) })
        // 把保存后的集合一起返回：脚本 / 前端不用再猜刚存的是哪一条。
        sendJson(res, 200, { ok: true, experts: store.snapshot().config.experts, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/experts/delete') {
        const body = await readJsonBody(req)
        const id = cleanId(body.id, 'expert')
        await applyConfig(store, { experts: store.snapshot().config.experts.filter(expert => expert.id !== id) })
        sendJson(res, 200, { ok: true, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/teams/save') {
        const body = await readJsonBody(req)
        await applyConfig(store, { teams: upsertById(store.snapshot().config.teams, body.team ?? body) })
        sendJson(res, 200, { ok: true, teams: store.snapshot().config.teams, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/teams/delete') {
        const body = await readJsonBody(req)
        const id = cleanId(body.id, 'team')
        await applyConfig(store, { teams: store.snapshot().config.teams.filter(team => team.id !== id) })
        sendJson(res, 200, { ok: true, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/columns/wip') {
        const body = await readJsonBody(req)
        const status = String(body.status ?? '')
        if (!STATUS_SET.has(status)) throw new Error(`unknown status ${status}`)
        const columns = { ...store.snapshot().config.columns }
        const wip = Math.min(50, Math.max(0, Math.trunc(Number(body.wip) || 0)))
        columns[status] = { ...(columns[status] ?? { kind: 'none', id: '' }), wip }
        await applyConfig(store, { columns })
        sendJson(res, 200, { ok: true, columns: store.snapshot().config.columns, state: publicState(store) })
        return
      }

      if (method === 'POST' && route === '/columns/save') {
        const body = await readJsonBody(req)
        const status = String(body.status ?? '')
        if (!STATUS_SET.has(status)) throw new Error(`unknown status ${status}`)
        const columns = { ...store.snapshot().config.columns }
        if (Array.isArray(body.members)) {
          columns[status] = body.members.length === 0
            ? { kind: 'none', id: '' }
            : {
              kind: 'pool',
              id: '',
              members: body.members.map(entry => ({ kind: entry?.kind === 'team' ? 'team' : entry?.kind === 'role' ? 'role' : 'expert', id: String(entry?.id ?? '') })),
              strategy: body.strategy,
            }
        } else if (body.owner === null) {
          columns[status] = defaultColumns()[status]
        } else {
          const kind = body.kind === 'team' ? 'team' : body.kind === 'none' ? 'none' : 'expert'
          columns[status] = { kind, id: String(body.id ?? '') }
        }
        await applyConfig(store, { columns })
        sendJson(res, 200, { ok: true, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/task/delete') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        await store.mutate(state => {
          state.tasks = state.tasks.filter(t => t.id !== id)
        })
        // 卡没了，替它跑着的会话也要收摊，否则槽位一直被占着。
        getDispatcher()?.abortTask?.(id)
        sendJson(res, 200, { ok: true, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/task/artifact') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        const action = String(body.action ?? 'add')
        const snapshot = await store.mutate(state => {
          const task = state.tasks.find(t => t.id === id)
          if (task === undefined) throw new Error(`no task ${id}`)
          if (action === 'add') {
            const created = sanitizeArtifact(body.artifact ?? body, task.artifacts.length)
            if (created === undefined) throw new Error('交付物至少要有标题')
            created.by = String(body.by ?? created.by ?? '')
            created.at = Date.now()
            task.artifacts = [...task.artifacts, created].slice(0, 40)
          } else if (action === 'remove') {
            task.artifacts = task.artifacts.filter(item => item.id !== String(body.artifactId ?? ''))
          } else if (action === 'update') {
            task.artifacts = task.artifacts.map(item => {
              if (item.id !== String(body.artifactId ?? '')) return item
              const merged = sanitizeArtifact({ ...item, ...(body.patch ?? body.artifact ?? {}) }, 0) ?? item
              merged.id = item.id
              return merged
            })
          } else {
            throw new Error(`unknown action ${action}`)
          }
          task.updatedAt = Date.now()
          return task
        })
        const task = snapshot.tasks.find(entry => entry.id === id)
        sendJson(res, 200, { ok: true, task, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/task/artifact/sync') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        const artifactId = String(body.artifactId ?? '')
        const task = store.snapshot().tasks.find(entry => entry.id === id)
        if (task === undefined) throw new Error(`no task ${id}`)
        const targets = (task.artifacts ?? []).filter(item => artifactId === '' || item.id === artifactId)
        if (targets.length === 0) throw new Error('这张卡还没有可归档的交付物')
        const written = []
        const errors = []
        for (const artifact of targets) {
          try {
            written.push({ id: artifact.id, doc: await syncArtifact(store, id, artifact.id) })
          } catch (error) {
            errors.push({ id: artifact.id, title: artifact.title, error: String(error?.message ?? error).slice(0, 200) })
          }
        }
        const fresh = store.snapshot().tasks.find(entry => entry.id === id)
        sendJson(res, 200, { ok: errors.length === 0, task: fresh, written, errors, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/task/checklist') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        const action = String(body.action ?? 'toggle')
        const by = String(body.by ?? '人').slice(0, 40)
        const snapshot = await store.mutate(state => {
          const task = state.tasks.find(t => t.id === id)
          if (task === undefined) throw new Error(`no task ${id}`)
          if (action === 'add') {
            const items = (Array.isArray(body.items) ? body.items : [body.text])
              .map(item => String(item ?? '').trim().slice(0, 200))
              .filter(item => item.length > 0)
            for (const text of items) {
              task.checklist.push({ id: `c${task.checklist.length + 1}-${randomBytes(2).toString('hex')}`, text, done: false, by: '', at: 0, note: '' })
            }
            task.checklist = task.checklist.slice(0, 30)
          } else if (action === 'remove') {
            task.checklist = task.checklist.filter(item => item.id !== String(body.itemId ?? ''))
          } else {
            const itemId = String(body.itemId ?? '')
            task.checklist = task.checklist.map(item => {
              if (item.id !== itemId) return item
              const done = typeof body.done === 'boolean' ? body.done : !item.done
              return { ...item, done, by: done ? by : '', at: done ? Date.now() : 0, note: String(body.note ?? item.note).slice(0, 400) }
            })
          }
          task.updatedAt = Date.now()
          return task
        })
        const task = snapshot.tasks.find(entry => entry.id === id)
        sendJson(res, 200, { ok: true, task, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/task/case') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        const action = String(body.action ?? 'add')
        const by = String(body.by ?? '人').slice(0, 40)
        const snapshot = await store.mutate(state => {
          const task = state.tasks.find(t => t.id === id)
          if (task === undefined) throw new Error(`no task ${id}`)
          const list = Array.isArray(task.cases) ? task.cases : []
          if (action === 'add') {
            const raw = Array.isArray(body.cases) ? body.cases : [body.case ?? body]
            const added = sanitizeCases(raw.map(item => ({
              ...item,
              http: item.http ?? (item.url !== undefined && String(item.url).trim().length > 0
                ? { method: item.method, url: item.url, body: item.body, expectStatus: item.expectStatus, expectContains: item.expectContains }
                : undefined),
              by,
              at: Date.now(),
            })))
            for (const item of added) {
              if (list.length >= 60) break
              list.push({ ...item, id: `c${list.length + 1}-${randomBytes(2).toString('hex')}` })
            }
          } else if (action === 'remove') {
            task.cases = list.filter(item => item.id !== String(body.caseId ?? ''))
            task.updatedAt = Date.now()
            return task
          } else {
            const caseId = String(body.caseId ?? '')
            task.cases = list.map(item => {
              if (item.id !== caseId) return item
              const merged = { ...item }
              if (body.result !== undefined && CASE_RESULTS.includes(String(body.result))) merged.result = String(body.result)
              if (body.title !== undefined) merged.title = String(body.title).trim().slice(0, 200) || item.title
              if (body.expected !== undefined) merged.expected = String(body.expected).trim().slice(0, 300)
              if (body.note !== undefined) merged.note = String(body.note).trim().slice(0, 400)
              if (body.http !== undefined) merged.http = sanitizeCaseHttp(body.http)
              if (body.pointId !== undefined) merged.pointId = String(body.pointId).trim().slice(0, 24)
              if (body.flaky !== undefined) merged.flaky = body.flaky === true
              if (body.type !== undefined && CASE_TYPES.includes(String(body.type))) merged.type = String(body.type)
              if (body.priority !== undefined && CASE_PRIORITIES.includes(String(body.priority).toLowerCase())) merged.priority = String(body.priority).toLowerCase()
              if (body.preconditions !== undefined) merged.preconditions = String(body.preconditions).slice(0, 800)
              if (body.steps !== undefined) {
                merged.steps = (Array.isArray(body.steps) ? body.steps : [])
                  .map(item => String(item ?? '').trim().slice(0, 200))
                  .filter(item => item !== '')
                  .slice(0, 20)
              }
              merged.by = by
              merged.at = Date.now()
              return merged
            })
            task.updatedAt = Date.now()
            return task
          }
          task.cases = list.slice(0, 60)
          task.updatedAt = Date.now()
          return task
        })
        const task = snapshot.tasks.find(entry => entry.id === id)
        // 用例判失败就自动开缺陷：Bug 不再是人工另建的一种「任务类型」。
        let autoBug = null
        let autoBugError = ''
        let autoBugSkipped = ''
        if (String(body.result ?? '') === 'fail' && task !== undefined) {
          const failed = (Array.isArray(task.cases) ? task.cases : []).find(item => item.id === String(body.caseId ?? ''))
          if (failed !== undefined && failed.flaky !== true) {
            try {
              const outcome = await autoBugFromCase(store, task, failed, by)
              autoBug = outcome.bug
              autoBugSkipped = String(outcome.skipped ?? '')
            } catch (error) {
              autoBugError = String(error?.message ?? error)
            }
          }
        }
        const latest = store.snapshot()
        sendJson(res, 200, {
          ok: true,
          task: latest.tasks.find(entry => entry.id === id),
          bug: autoBug,
          error: autoBugError,
          skipped: autoBugSkipped,
          state: publicState(store),
        })
        return
      }
      if (method === 'POST' && route === '/task/case/run') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        if (body.diag === true) {
          sendJson(res, 200, {
            ok: true,
            storeType: typeof store,
            hasSnapshot: typeof store?.snapshot,
            hasMutate: typeof store?.mutate,
            keys: Object.keys(store ?? {}).slice(0, 16),
            runType: typeof runTaskCases,
          })
          return
        }
        const caseIds = body.caseId !== undefined && String(body.caseId).length > 0 ? [String(body.caseId)] : body.caseIds
        const result = await runTaskCases(store, id, {
          caseIds: Array.isArray(caseIds) ? caseIds : undefined,
          env: body.env,
          by: String(body.by ?? '测试').slice(0, 40),
        })
        sendJson(res, 200, { ok: true, run: result.run, env: result.env, bugs: result.bugs, state: result.state })
        return
      }
      if (method === 'POST' && route === '/tests/run') {
        const body = await readJsonBody(req)
        const result = await runSuite(store, {
          taskIds: Array.isArray(body.taskIds) ? body.taskIds : undefined,
          env: body.env,
          by: String(body.by ?? '测试').slice(0, 40),
          concurrency: body.concurrency,
        })
        sendJson(res, 200, { ok: true, concurrency: result.concurrency, tasks: result.tasks, state: result.state })
        return
      }
      if (handleExportRoute({ method, route, url, res, store, sendJson })) return
      if (method === 'POST' && route === '/task/coding') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        const action = String(body.action ?? 'update')
        const by = String(body.by ?? '人').slice(0, 40)
        const snapshot = await store.mutate(state => {
          const task = state.tasks.find(t => t.id === id)
          if (task === undefined) throw new Error(`no task ${id}`)
          if (action === 'clear') {
            task.coding = null
          } else if (action === 'review') {
            const base = sanitizeCoding(task.coding ?? {})
            const status = CODING_REVIEW_STATUS.includes(String(body.status)) ? String(body.status) : 'approved'
            task.coding = sanitizeCoding({
              ...base,
              review: { status, by, at: Date.now(), note: String(body.note ?? '').slice(0, 600) },
            })
          } else if (action === 'merge') {
            const base = sanitizeCoding(task.coding ?? {})
            task.coding = sanitizeCoding({ ...base, mergedBy: by, mergedAt: Date.now() })
          } else {
            const patch = body.coding ?? body.patch ?? body
            task.coding = mergeCoding(task.coding ?? null, patch)
          }
          task.updatedAt = Date.now()
          return task
        })
        const task = snapshot.tasks.find(entry => entry.id === id)
        sendJson(res, 200, { ok: true, task, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/task/coding/verify') {
        // 拿 worktree 里的 git 事实核对执行记录：agent 说改了哪些提交/文件，真的在分支上吗。
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        const current = store.snapshot().tasks.find(entry => entry.id === id)
        if (current === undefined) throw new Error(`no task ${id}`)
        const report = await verifyCodingRecord(store.snapshot(), current)
        if (report.skipped === undefined) {
          await store.mutate(state => {
            const task = state.tasks.find(entry => entry.id === id)
            if (task !== undefined && task.coding !== null && task.coding !== undefined) {
              task.coding = sanitizeCoding({ ...task.coding, verified: report })
            }
            return task
          })
        }
        const state = store.snapshot()
        const task = state.tasks.find(entry => entry.id === id)
        sendJson(res, 200, {
          ok: true,
          report,
          line: codingVerifyLine(report),
          gate: taskExitGate(state, task),
          task,
          state: publicState(store),
        })
        return
      }
      if (method === 'POST' && route === '/task/agent/fail') {
        // 记一次 AI 失败（真失败时由派单器调用；也可由 agent 自己上报）。
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        const plan = await noteAgentFailure(store, id, String(body.error ?? 'AI 没有完成这一轮'), String(body.by ?? '系统').slice(0, 60))
        if (plan === undefined) throw new Error(`no task ${id}`)
        const state = store.snapshot()
        const task = state.tasks.find(entry => entry.id === id)
        sendJson(res, 200, { ok: true, plan, task, gate: taskExitGate(state, task), state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/task/agent/retry') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        const changed = await clearAgentFailure(store, id, String(body.by ?? '人').slice(0, 60))
        if (!changed) throw new Error(`no task ${id}`)
        const state = store.snapshot()
        const task = state.tasks.find(entry => entry.id === id)
        sendJson(res, 200, { ok: true, task, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/task/worktree') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        const action = String(body.action ?? 'create')
        const snapshotNow = store.snapshot()
        const task = snapshotNow.tasks.find(entry => entry.id === id)
        if (task === undefined) throw new Error(`no task ${id}`)
        if (action === 'remove') {
          const result = await removeWorktree(store, task, snapshotNow.config)
          sendJson(res, 200, { ok: result.ok, result, state: publicState(store) })
          return
        }
        if (action === 'list') {
          const service = serviceOf(snapshotNow.config, task)
          const project = workProjectOf(snapshotNow.config, task)
          const repo = String(service?.repoPath ?? project?.repoPath ?? '').trim()
          const listed = repo.length === 0
            ? { ok: false, stdout: '', stderr: '项目没配本机代码目录' }
            : await runCommand('git', ['-C', repo, 'worktree', 'list', '--porcelain'], 20000)
          sendJson(res, 200, { ok: listed.ok, output: String(listed.stdout ?? ''), error: String(listed.stderr ?? ''), state: publicState(store) })
          return
        }
        const info = await ensureWorktree(store, task, snapshotNow.config)
        sendJson(res, 200, {
          ok: info?.path !== undefined,
          worktree: info ?? null,
          skipped: info?.skipped ?? '',
          state: publicState(store),
        })
        return
      }
      if (method === 'POST' && route === '/projects/save') {
        const body = await readJsonBody(req)
        const incoming = body.project ?? body
        const existing = store.snapshot().config.projects
        const wantedId = cleanId(incoming.id ?? incoming.name ?? incoming.key, 'proj')
        const saved = existing.find(item => item.id === wantedId)
        const merged = { ...incoming, id: wantedId, iterations: incoming.iterations ?? saved?.iterations ?? [] }
        await applyConfig(store, { projects: upsertById(existing, merged) })
        sendJson(res, 200, { ok: true, projects: store.snapshot().config.projects, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/projects/delete') {
        const body = await readJsonBody(req)
        const id = cleanId(body.id, 'proj')
        await applyConfig(store, { projects: store.snapshot().config.projects.filter(entry => entry.id !== id) })
        sendJson(res, 200, { ok: true, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/projects/iteration') {
        const body = await readJsonBody(req)
        const action = String(body.action ?? 'save')
        const projectId = cleanId(body.project, 'proj')
        const projects = store.snapshot().config.projects.map(project => {
          if (project.id !== projectId) return project
          if (action === 'remove') {
            return { ...project, iterations: project.iterations.filter(item => item.id !== cleanId(body.iteration, 'iter')) }
          }
          const wantedId = cleanId(body.iteration ?? body.name, 'iter')
          const saved = project.iterations.find(item => item.id === wantedId)
          const merged = {
            ...saved,
            id: wantedId,
            name: String(body.name ?? saved?.name ?? wantedId).slice(0, 60),
            start: Number(body.start ?? saved?.start) || 0,
            due: Number(body.due ?? saved?.due) || 0,
            status: ['planned', 'active', 'closed'].includes(String(body.status)) ? String(body.status) : (saved?.status ?? 'planned'),
          }
          return { ...project, iterations: upsertById(project.iterations, merged) }
        })
        await applyConfig(store, { projects })
        sendJson(res, 200, { ok: true, state: publicState(store) })
        return
      }
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
        sendJson(res, 200, { ok: true, requirements })
        return
      }
      if (method === 'POST' && route === '/requirement/get') {
        const body = await readJsonBody(req)
        const rollup = requirementRollup(store.snapshot(), String(body.id ?? ''))
        if (rollup === undefined) throw new Error('需求不存在')
        const matrix = requirementMatrix(store.snapshot(), rollup.requirement)
        const progress = requirementProgress(store.snapshot(), rollup.requirement)
        sendJson(res, 200, { ok: true, ...rollup, matrix, progress })
        return
      }
      if (method === 'POST' && route === '/requirement/matrix') {
        const body = await readJsonBody(req)
        const requirement = store.snapshot().requirements.find(item => item.id === String(body.id ?? ''))
        if (requirement === undefined) throw new Error('需求不存在')
        sendJson(res, 200, { ok: true, requirement: { id: requirement.id, code: requirement.code, title: requirement.title }, matrix: requirementMatrix(store.snapshot(), requirement) })
        return
      }
      if (method === 'POST' && route === '/requirement/signoff') {
        const body = await readJsonBody(req)
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
        sendJson(res, 200, {
          ok: true,
          requirement,
          progress: requirementProgress(snapshot, requirement),
          signoff: requirement.signoff ?? null,
          state: publicState(store),
        })
        return
      }
      if (method === 'POST' && route === '/task/gate') {
        const body = await readJsonBody(req)
        const task = store.snapshot().tasks.find(entry => entry.id === String(body.id ?? ''))
        if (task === undefined) throw new Error('任务不存在')
        sendJson(res, 200, { ok: true, gate: taskExitGate(store.snapshot(), task), signoff: task.signoff ?? null })
        return
      }
      if (method === 'POST' && route === '/task/signoff') {
        const body = await readJsonBody(req)
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
        sendJson(res, 200, { ok: true, task: signed, gate: taskExitGate(store.snapshot(), signed), state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/requirement/save') {
        const body = await readJsonBody(req)
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
        sendJson(res, 200, { ok: true, requirement, progress: requirementProgress(snapshot, saved), state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/requirement/review') {
        const body = await readJsonBody(req)
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
        sendJson(res, 200, { ok: true, requirement, review: requirement.review ?? null, progress: requirementProgress(snapshot, requirement), state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/requirement/split') {
        const body = await readJsonBody(req)
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
          const task = await createTask(store, {
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
        sendJson(res, 200, { ok: true, created, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/requirement/pool') {
        const body = await readJsonBody(req)
        const id = cleanId(body.id, 'req')
        const pool = sanitizeRequirementPool(body.pool ?? body)
        let next = null
        await store.mutate(state => {
          const target = state.requirements.find(item => item.id === id)
          if (target !== undefined) { target.pool = pool; target.updatedAt = Date.now(); next = target }
        })
        if (next === null) throw new Error('没有这条需求')
        sendJson(res, 200, { ok: true, requirement: next, gate: requirementGate(store.snapshot(), next), state: publicState(store) })
        return
      }

      if (method === 'GET' && route === '/intake') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(INTAKE_HTML)
        return
      }
      if (method === 'POST' && route === '/intake/requirement') {
        const body = await readJsonBody(req)
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
        sendJson(res, 200, { ok: true, code: requirement.code, id: requirement.id })
        return
      }

      if (method === 'GET' && route === '/intake/mine') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(MINE_HTML)
        return
      }
      if (method === 'POST' && route === '/intake/mine/query') {
        const body = await readJsonBody(req)
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
        sendJson(res, 200, { ok: true, rows })
        return
      }
      if (method === 'GET' && route === '/intake/status') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(STATUS_HTML)
        return
      }
      if (method === 'POST' && route === '/intake/query') {
        const body = await readJsonBody(req)
        const code = String(body.code ?? '').trim().toUpperCase()
        const tail = String(body.contact ?? '').trim().replace(/\s+/g, '')
        if (code.length === 0 || tail.length < 4) throw new Error('请填写需求编号，以及联系方式的后四位')
        const hit = (store.snapshot().requirements ?? []).find(item => String(item.code ?? '').toUpperCase() === code)
        const contact = String(hit?.requester?.contact ?? '').replace(/\s+/g, '')
        if (hit === undefined || contact.length === 0 || !contact.endsWith(tail)) throw new Error('没查到：编号或联系方式对不上')
        const cards = (store.snapshot().tasks ?? []).filter(item => item.requirementId === hit.id)
        const open = (hit.questions ?? []).filter(item => item.status === 'open').length
        sendJson(res, 200, {
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
        return
      }

      if (method === 'POST' && route === '/requirement/request-prd') {
        const body = await readJsonBody(req)
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
        sendJson(res, 200, { ok: true, requirement, progress: requirementProgress(fresh, requirement), state: publicState(store) })
        return
      }

      if (method === 'POST' && route === '/requirement/questions') {
        const body = await readJsonBody(req)
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
        sendJson(res, 200, { ok: true, requirement: next, gate: requirementGate(store.snapshot(), next), state: publicState(store) })
        return
      }

      if (method === 'POST' && route === '/requirement/delete') {
        const body = await readJsonBody(req)
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
        sendJson(res, 200, { ok: true, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/requirement/doc') {
        const body = await readJsonBody(req)
        const result = await mutateReqDoc(store, body)
        sendJson(res, 200, { ok: true, requirement: result, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/requirement/pull') {
        const body = await readJsonBody(req)
        const result = await pullFeishuDoc(body.url ?? body.docUrl ?? '')
        sendJson(res, 200, { ok: true, ...result })
        return
      }
      if (method === 'POST' && route === '/requirement/folder') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        const folder = await ensureReqFolder(store, id)
        const requirement = store.snapshot().requirements.find(item => item.id === id)
        sendJson(res, 200, { ok: String(folder.token ?? '').length > 0, folder, requirement, error: folder.error ?? '', state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/requirement/sync') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        const report = await syncRequirementArtifacts(store, id)
        sendJson(res, 200, { ok: report.failed === 0, report, state: publicState(store) })
        return
      }
      if (method === 'GET' && route === '/releases') {
        const state = store.snapshot()
        const releases = state.releases.map(item => {
          const gate = releaseGate(state, item)
          return { ...item, gate, counts: gate.stats }
        })
        sendJson(res, 200, { ok: true, releases, statuses: RELEASE_STATUSES })
        return
      }
      if (method === 'POST' && route === '/release/get') {
        const body = await readJsonBody(req)
        const state = store.snapshot()
        const release = state.releases.find(item => item.id === String(body.id ?? ''))
        if (release === undefined) throw new Error('版本不存在')
        const tasks = state.tasks.filter(task => task.releaseId === release.id)
        sendJson(res, 200, {
          ok: true,
          release: { ...release, requirements: releaseRequirements(state, release), deploys: releaseDeploys(state, release) },
          gate: releaseGate(state, release),
          tasks,
        })
        return
      }
      if (method === 'POST' && route === '/release/save') {
        const body = await readJsonBody(req)
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
            return
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
        sendJson(res, 200, { ok: true, release: saved, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/release/delete') {
        const body = await readJsonBody(req)
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
        sendJson(res, 200, { ok: true, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/release/link') {
        const body = await readJsonBody(req)
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
        sendJson(res, 200, { ok: true, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/release/smoke') {
        const body = await readJsonBody(req)
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
        sendJson(res, 200, { ok: true, release, gate: releaseGate(store.snapshot(), release), state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/release/notes') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        let release = null
        await store.mutate(state => {
          const found = state.releases.find(item => item.id === id)
          if (found === undefined) throw new Error('版本不存在')
          found.notes = releaseNotes(state, found)
          found.updatedAt = Date.now()
          release = { ...found }
        })
        sendJson(res, 200, { ok: true, release, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/release/approve') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        const by = String(body.by ?? '人').slice(0, 120)
        let release = null
        let gate = null
        await store.mutate(state => {
          const found = state.releases.find(item => item.id === id)
          if (found === undefined) throw new Error('版本不存在')
          gate = releaseGate(state, found)
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
        sendJson(res, 200, { ok: true, release, gate, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/release/publish') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        const by = String(body.by ?? '人').slice(0, 120)
        let release = null
        await store.mutate(state => {
          const found = state.releases.find(item => item.id === id)
          if (found === undefined) throw new Error('版本不存在')
          if (found.status === 'released') throw new Error('这个版本已经发布过了')
          const gate = releaseGate(state, found)
          if (!gate.ready) throw new Error(`门禁没过：${gate.blockers.join('；')}`)
          // 发布准入（可配）：没满足就走强制发布，但必须写原因，留在部署日志里。
          const violations = releaseRuleViolations(state, found)
          const forced = violations.length > 0
          const forceNote = String(body.forceNote ?? '').slice(0, 300)
          if (forced && body.force !== true) throw new Error(`发布准入没过：${violations.join('；')}。确实要发就勾上「强制发布」并写原因`)
          if (forced && forceNote.trim() === '') throw new Error('强制发布必须写清楚原因（会记进部署日志）')
          found.status = 'released'
          found.releasedAt = Date.now()
          found.approveBy = found.approveBy === '' ? by : found.approveBy
          found.approveAt = found.approveAt === 0 ? Date.now() : found.approveAt
          found.notes = found.notes === '' ? releaseNotes(state, found) : found.notes
          found.deployLog = [...(found.deployLog ?? []), {
            at: Date.now(),
            by,
            action: 'publish',
            note: `tag ${found.tagName || '—'}${found.commitSha === '' ? '' : ` · ${String(found.commitSha).slice(0, 8)}`}${forced ? ` · 强制发布（${violations.join('；')}）原因：${forceNote}` : ''}`,
          }].slice(-200)
          found.updatedAt = Date.now()
          release = { ...found }
        })
        sendJson(res, 200, { ok: true, release, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/release/gray') {
        const body = await readJsonBody(req)
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
          gate = releaseGate(state, found)
        })
        sendJson(res, 200, { ok: true, release, gate, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/release/deploy') {
        const body = await readJsonBody(req)
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
          deploys = releaseDeploys(state, found)
          release = { ...found, deploys }
        })
        sendJson(res, 200, { ok: true, release, deploys, mode: 'record-only', state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/release/rollback') {
        const body = await readJsonBody(req)
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
        sendJson(res, 200, { ok: true, release, state: publicState(store) })
        return
      }
      if (method === 'GET' && route === '/metrics') {
        sendJson(res, 200, { ok: true, metrics: buildMetrics(store.snapshot()) })
        return
      }
      if (method === 'GET' && route === '/analytics') {
        const snapshot = store.snapshot()
        sendJson(res, 200, {
          ok: true,
          analytics: buildAnalytics(snapshot, {
            days: url.searchParams.get('days') ?? '',
            project: url.searchParams.get('project') ?? '',
          }),
        })
        return
      }
      if (method === 'GET' && route === '/dashboard') {
        sendJson(res, 200, { ok: true, dashboard: buildDashboard(store.snapshot()) })
        return
      }
      if (method === 'GET' && route === '/workload') {
        const dispatcher = getDispatcher()
        const running = dispatcher === undefined ? [] : [...dispatcher.running.values()]
        sendJson(res, 200, { ok: true, workload: workloadReport(store.snapshot(), running) })
        return
      }
      if (method === 'GET' && route === '/burndown') {
        sendJson(res, 200, {
          ok: true,
          burndown: burndownReport(store.snapshot(), {
            days: url.searchParams.get('days') ?? '',
            project: url.searchParams.get('project') ?? '',
          }),
        })
        return
      }
      if (method === 'GET' && route === '/costs') {
        const summary = runSummary()
        const budget = store.snapshot().config.costs
        const runs = summary.total
        const hours = Math.round(((summary.avgMs * summary.finished) / 3600_000) * 10) / 10
        const runRate = budget.budgetRuns > 0 ? Math.min(100, Math.round((runs / budget.budgetRuns) * 100)) : 0
        const hourRate = budget.budgetHours > 0 ? Math.min(100, Math.round((hours / budget.budgetHours) * 100)) : 0
        const level = Math.max(runRate, hourRate) >= 100
          ? 'over'
          : Math.max(runRate, hourRate) >= budget.warnAt ? 'warn' : 'ok'
        sendJson(res, 200, {
          ok: true,
          costs: summary,
          budget: {
            ...budget,
            runs,
            hours,
            runRate,
            hourRate,
            level,
            hint: level === 'over'
              ? '已经超出预算：要么调高预算，要么停下来看看是不是有卡在空转'
              : level === 'warn'
                ? `已用到 ${Math.max(runRate, hourRate)}%，超过 ${budget.warnAt}% 会在这里标黄`
                : '预算内',
          },
        })
        return
      }
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
      if (method === 'GET' && route === '/agents') {
        const dispatcher = getDispatcher()
        sendJson(res, 200, dispatcher === undefined
          ? { ok: false, error: 'dispatcher not available yet' }
          : { ok: true, ...dispatcher.status() })
        return
      }
      if (method === 'GET' && route === '/agents/policy') {
        const dispatcher = getDispatcher()
        if (dispatcher === undefined) {
          sendJson(res, 200, { ok: false, error: 'dispatcher not available yet' })
          return
        }
        const cfg = store.snapshot().config.agents
        const live = []
        for (const info of dispatcher.running.values()) {
          let current = ''
          try {
            const agent = dispatcher.ctx.agents.get(info.sessionId)
            current = String(dispatcher.ctx.permissionPresets.current(agent?.session))
          } catch (error) {
            current = `unknown: ${error?.message ?? error}`
          }
          live.push({ sessionId: info.sessionId, expert: info.expert, taskId: info.taskId, preset: current })
        }
        sendJson(res, 200, {
          ok: true,
          configured: {
            sandbox: SANDBOX_MODES.includes(String(cfg.sandbox ?? '')) ? cfg.sandbox : 'workspace-write',
            isolation: ISOLATION_MODES.includes(String(cfg.isolation ?? '')) ? cfg.isolation : 'none',
            worktreeRoot: String(cfg.worktreeRoot ?? ''),
            cleanupWorktree: String(cfg.cleanupWorktree ?? 'manual'),
          },
          isolation: cfg.isolation ?? 'none',
          live,
        })
        return
      }
      if (method === 'POST' && route === '/agents/run') {
        const dispatcher = getDispatcher()
        if (dispatcher === undefined) throw new Error('dispatcher not available yet')
        const body = await readJsonBody(req)
        await dispatcher.launchNow(String(body.id ?? ''), String(body.expert ?? ''))
        sendJson(res, 200, { ok: true, state: publicState(store), agents: dispatcher.status() })
        return
      }
      if (method === 'POST' && route === '/agents/stop') {
        const dispatcher = getDispatcher()
        if (dispatcher === undefined) throw new Error('dispatcher not available yet')
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        dispatcher.abortTask(id, body.expert === undefined ? undefined : String(body.expert))
        sendJson(res, 200, { ok: true, state: publicState(store) })
        return
      }
      if (method === 'GET' && route === '/market') {
        sendJson(res, 200, {
          ok: true,
          title: store.snapshot().config.market.title,
          items: store.snapshot().config.market.items,
          installed: await installedPackages(),
        })
        return
      }
      if (method === 'POST' && route === '/market/install') {
        const body = await readJsonBody(req)
        const item = store.snapshot().config.market.items.find(entry => entry.id === String(body.id ?? ''))
        if (item === undefined) throw new Error('unknown market item')
        const result = await runPluginCli(['add', item.spec])
        sendJson(res, 200, { ok: result.ok, result, installed: await installedPackages(), restartRequired: result.ok })
        return
      }
      if (method === 'POST' && route === '/market/uninstall') {
        const body = await readJsonBody(req)
        const item = store.snapshot().config.market.items.find(entry => entry.id === String(body.id ?? ''))
        const requested = String(body.pkg ?? '').trim()
        const pkg = requested.length > 0 ? requested : (item === undefined ? undefined : await resolvePackageName(item.spec))
        if (pkg === undefined) throw new Error('unknown market item')
        const result = await runPluginCli(['remove', pkg])
        sendJson(res, 200, { ok: result.ok, pkg, result, installed: await installedPackages(), restartRequired: result.ok })
        return
      }
      if (method === 'GET' && route === '/integrations') {
        const config = store.snapshot().config
        sendJson(res, 200, {
          ok: true,
          gitlab: {
            ready: gitlabReady(config),
            syncing: syncTimer !== undefined,
            projects: (config.gitlab.projects ?? []).map(project => ({
              id: project.id,
              ready: projectReady(config, project),
              lastSyncAt: project.lastSyncAt,
              lastSyncError: project.lastSyncError,
            })),
          },
          feishu: {
            ready: (config.feishu.bots ?? []).some(bot => bot.enabled && bot.webhook.length > 0),
            lastError: INTEGRATION.lastPushError,
          },
          health: healthReport(),
        })
        return
      }
      if (method === 'GET' && route === '/integrations/health') {
        sendJson(res, 200, { ok: true, ...healthReport() })
        return
      }
      if (method === 'POST' && route === '/gitlab/sync') {
        const body = await readJsonBody(req).catch(() => ({}))
        const summary = await gitlabSync(store, body.project === undefined ? undefined : String(body.project))
        sendJson(res, 200, { ok: true, summary, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/repos/save') {
        const body = await readJsonBody(req)
        // 老前端发 {project}，新脚本发 {repo}，两个都认。
        const incoming = body.repo ?? body.project ?? body
        if (String(incoming.name ?? incoming.project ?? '').trim() === '') {
          throw new Error('仓库至少要填一个名字（或者 GitLab 项目路径），否则存下来是一条空记录')
        }
        const existing = store.snapshot().config.gitlab.projects
        const wantedId = cleanId(incoming.id ?? incoming.name ?? incoming.project, 'repo')
        const saved = existing.find(item => item.id === wantedId)
        const merged = {
          ...incoming,
          id: wantedId,
          // An empty token field means "keep the one already stored".
          token: String(incoming.token ?? '').trim() || (saved?.token ?? ''),
        }
        await applyConfig(store, { gitlab: { projects: upsertById(existing, merged) } })
        // 只回公开视图：token 不能出现在响应里。
        const state = publicState(store)
        sendJson(res, 200, { ok: true, repos: state.config.gitlab.projects, state })
        return
      }
      if (method === 'POST' && route === '/repos/delete') {
        const body = await readJsonBody(req)
        const id = cleanId(body.id, 'repo')
        await applyConfig(store, { gitlab: { projects: store.snapshot().config.gitlab.projects.filter(entry => entry.id !== id) } })
        sendJson(res, 200, { ok: true, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/repos/test') {
        const body = await readJsonBody(req)
        const config = store.snapshot().config
        const project = config.gitlab.projects.find(entry => entry.id === cleanId(body.id, 'repo'))
        if (project === undefined) throw new Error('unknown project')
        if (!projectReady(config, project)) throw new Error('这个仓库还没填全：地址 / 项目路径 / 访问令牌')
        const info = await gitlabRequest(config, project, '/issues?per_page=1')
        sendJson(res, 200, { ok: true, reachable: true, sample: Array.isArray(info) ? info.length : 0 })
        return
      }
      if (method === 'POST' && route === '/bots/save') {
        const body = await readJsonBody(req)
        const incoming = body.bot ?? body
        const existing = store.snapshot().config.feishu.bots
        const wantedId = cleanId(incoming.id ?? incoming.name, 'bot')
        const saved = existing.find(item => item.id === wantedId)
        const merged = {
          ...incoming,
          id: wantedId,
          // An empty webhook field means "keep the one already stored".
          webhook: String(incoming.webhook ?? '').trim() || (saved?.webhook ?? ''),
        }
        await applyConfig(store, { feishu: { bots: upsertById(existing, merged) } })
        const state = publicState(store)
        sendJson(res, 200, { ok: true, bots: state.config.feishu.bots, state })
        return
      }
      if (method === 'POST' && route === '/bots/delete') {
        const body = await readJsonBody(req)
        const id = cleanId(body.id, 'bot')
        await applyConfig(store, { feishu: { bots: store.snapshot().config.feishu.bots.filter(entry => entry.id !== id) } })
        sendJson(res, 200, { ok: true, state: publicState(store) })
        return
      }
      if (method === 'POST' && route === '/feishu/test') {
        const body = await readJsonBody(req).catch(() => ({}))
        const config = store.snapshot().config
        const wanted = body.id === undefined ? '' : cleanId(body.id, 'bot')
        const bots = (config.feishu.bots ?? []).filter(bot => wanted.length === 0 || bot.id === wanted)
        const results = []
        for (const bot of bots) {
          try {
            const result = await feishuPush(bot.webhook, '【需求&任务工作空间】这是一条测试消息，收到即说明群通知已接通。')
            results.push({ bot: bot.id, name: bot.name, ...result })
          } catch (error) {
            results.push({ bot: bot.id, name: bot.name, ok: false, error: String(error?.message ?? error).slice(0, 200) })
          }
        }
        sendJson(res, 200, { ok: results.some(entry => entry.ok === true), results })
        return
      }
      if (method === 'POST' && route === '/reset') {
        await store.mutate(state => { state.tasks = [] })
        sendJson(res, 200, { ok: true, state: publicState(store) })
        return
      }
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
  const level = route.startsWith('/auth/') ? 'read' : accessLevelFor(route, method)
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
function registerTools(ctx, store) {
  const disposers = []
  const register = tool => {
    const body = tool.execute
    disposers.push(ctx.tools.register({
      ...tool,
      // 专家 agent 调工具也要过成员名单：读操作放行，写要成员、危险的只有管理员。
      async execute(args, exec) {
        await store.ready
        const config = store.snapshot().config
        const operator = toolOperator(store, exec)
        const { level, denial } = operator === null
          ? { level: toolLevel(tool.name), denial: null }
          : checkToolAccess(config, operator.name, tool.name)
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
              status: 200, ok: true, summary: auditSummary(args),
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
      await applyConfig(store, patch)
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
      const task = await createTask(store, args)
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
      const result = await addDraftCases(store, String(args.id ?? ''), String(args.by ?? '人').slice(0, 40))
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
      const dispatcher = activeDispatcher
      const running = dispatcher === undefined ? [] : [...dispatcher.running.values()]
      const report = workloadReport(store.snapshot(), running)
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
      const report = burndownReport(store.snapshot(), { days: args.days ?? '', project: args.project ?? '' })
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
        const gate = releaseGate(state, item)
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
      const gate = releaseGate(state, release)
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
        const gate = releaseGate(state, release)
        if (!gate.ready) throw new Error(`门禁没过：${gate.blockers.join('；')}`)
        release.status = 'released'
        release.releasedAt = Date.now()
        release.approveBy = release.approveBy === '' ? by : release.approveBy
        release.approveAt = release.approveAt === 0 ? Date.now() : release.approveAt
        release.notes = release.notes === '' ? releaseNotes(state, release) : release.notes
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
        gate = releaseGate(state, release)
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
      activeDispatcher?.abortTask?.(task.id)
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
      if (activeDispatcher !== undefined) {
        for (const mention of mentions) {
          try {
            await activeDispatcher.dispatchMention(task.id, mention, String(args.body ?? ''))
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
      await applyConfig(store, { projects: upsertById(existing, merged) })
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
      const metrics = buildMetrics(state)
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
      const analytics = buildAnalytics(store.snapshot(), { days: args?.days, project: args?.project })
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
      ref: { type: 'string', description: 'Path or URL (e.g. /home/lyf/dsh-workspace/docs/x.md or the MR link).' },
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
      if (activeSkills === undefined) throw new Error('技能库尚未就绪')
      const skills = activeSkills.list()
      if (skills.length === 0) return '技能库还是空的。可以用 studio_skill_save 把这次摸索出来的做法写成一条技能。'
      return [
        `技能库共 ${skills.length} 条（落盘在 ${skillsRoot()}/<名字>/SKILL.md）：`,
        ...skills.map(skill => `- ${skill.name}${skill.enabled === false ? '（已停用）' : ''}：${skill.description}${skill.tags.length > 0 ? `  [${skill.tags.join('/')}]` : ''}`),
      ].join('\n')
    },
  }))

  register(defineStudioTool({
    name: 'studio_skill_get',
    description: 'Read one skill body in full (the same text the skill tool would load).',
    parameters: { name: { type: 'string', required: true, description: 'Skill name, kebab-case.' } },
    async execute(args) {
      if (activeSkills === undefined) throw new Error('技能库尚未就绪')
      const skill = activeSkills.get(String(args.name ?? ''))
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
      if (activeSkills === undefined) throw new Error('技能库尚未就绪')
      const { skill, file } = await activeSkills.save(args)
      return `已保存技能 ${skill.name}${file === undefined ? '（已停用，未落盘）' : `，已写入 ${file}`}`
    },
  }))

  register(defineStudioTool({
    name: 'studio_skill_delete',
    description: 'Remove a skill from the company library and from disk. Only do this when the skill is obsolete or wrong — prefer fixing it with studio_skill_save.',
    parameters: { name: { type: 'string', required: true, description: 'Skill name.' } },
    async execute(args) {
      if (activeSkills === undefined) throw new Error('技能库尚未就绪')
      const { name } = await activeSkills.remove(String(args.name ?? ''))
      return `已删除技能 ${name}`
    },
  }))

  return disposers
}

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
