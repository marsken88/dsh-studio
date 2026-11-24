// -------------------------------------------------- 执行记录与接口测试执行器（P4）
// 代码事实核对、用例执行、缺陷回流、健康检查。宿主级依赖通过 configureExecutor() 注入。

import { COVERAGE_TARGET, coverageStrength, draftCasesFromCriteria, isExecutable, normalizeCaseTitle, stripExecutableMarker } from './case-strength.js'
import { gapMessage, needsTierPlan, sanitizeTier, testPlanSummary } from './test-plan.js'
import { isAiSignoff } from './intervention.js'
import { reviewGate } from './quality.js'
import { overrideSummary } from './override.js'
import { CASE_HTTP_METHODS, CODE_PREFIX, ROLE_IDS, STATUS_IDS, STATUSES, nextRequirementCode, nextTaskCode, normalizePatch, sanitizeBaseline, sanitizeCase, sanitizeReqDoc, sanitizeRequirement, sanitizeTestRun, sanitizeUrl, text,
  canonicalAuthor,
  sanitizeCoding,
} from './domain.js'
import { qualityTargetFor, sanitizeQuality } from './card-quality.js'
import { requirementGate, requirementMatrix, requirementProgress } from './requirement-gate.js'
export { requirementGate, requirementMatrix, requirementProgress }
import { casesOfTasks, impactSummary } from './impact.js'
import { designGate, designGateOffNote } from './design.js'
import { requirementFolderNameOf } from './drive-folders.js'
import { larkUploadArgs } from './lark-upload.js'
import { commandArgs } from './cmd-args.js'
import { ensureKindFolder, ensureRequirementFolder } from './drive-sync.js'
import { isStalled } from './dispatch-state.js'
import { collectCodingFromWorktree } from './task-diff.js'
import { RUN_LOG, parseMentions } from './dispatcher.js'
import { appendTeamMemory } from './team-memory.js'
import { pickRunner, registerRunner } from './runners.js'
import { syncArtifact as syncArtifactImpl } from './doc-sync.js'
import { runDbCase, sanitizeDbCase } from './db-runner.js'
import { emitEvent } from './events.js'
import { runShellCase } from './shell-runner.js'
import { runQualityCommand } from './quality-runner.js'
import { sanitizeCaseBrowser, runBrowserCase } from './browser-runner.js'
import { hostAllowed, resolveAllowedUrl } from './url-guard.js'
import { parseFeishuDocFetch } from './lark-doc.js'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

let host = {}

export function configureExecutor(services) {
  host = services ?? {}
}

// ------------------------------------------------------- 执行记录与代码事实核对

/**
 * 核对执行记录和代码事实：agent 自报的提交/文件，分支上到底有没有。
 * 没有 worktree（隔离没开）或还没写执行记录时返回 skipped，不拦流程。
 */
/** 自动核对：进「待评审」时跑一次，把结果写回 coding.verified 并在 history 留痕。 */
export async function autoVerifyCoding(store, taskId) {
  const state = store.snapshot()
  const task = state.tasks.find(entry => entry.id === taskId)
  if (task === undefined || task.coding === null || task.coding === undefined) return null
  const report = await verifyCodingRecord(state, task)
  await store.mutate(draft => {
    const target = draft.tasks.find(entry => entry.id === taskId)
    if (target === undefined || target.coding === null || target.coding === undefined) return
    const skipped = report.skipped !== undefined
    target.coding = sanitizeCoding({ ...target.coding, verified: skipped ? null : report })
    const missingCommits = (report.missingCommits ?? []).length
    const missingFiles = (report.missingFiles ?? []).length
    target.history = [...(target.history ?? []), {
      at: Date.now(),
      by: '系统',
      status: target.status,
      note: skipped
        ? '代码事实没法核对：' + report.skipped
        : report.ok === true
          ? '代码事实核对通过'
          : '代码事实核对不通过：' + missingCommits + ' 个提交 / ' + missingFiles + ' 个文件在仓库里找不到',
    }]
  })
  if (report.ok !== true && report.skipped === undefined) {
    emitEvent('gate/blocked', { taskId, gate: 'coding', blockers: ['代码事实核对不通过'] })
  }
  return report
}
export async function verifyCodingRecord(state, task) {
  const coding = task?.coding ?? null
  if (coding === null || coding === undefined) return { ok: false, skipped: '这张卡还没有执行记录' }
  const info = task?.worktree ?? null
  if (info === null || String(info.path ?? '').trim() === '') {
    return { ok: false, skipped: '这张卡没有 worktree（隔离没开或还没建），读不到代码事实' }
  }
  const dir = String(info.path)
  const git = async (...args) => runCommand('git', ['-C', dir, ...args], 30000)
  const head = await git('rev-parse', '--abbrev-ref', 'HEAD')
  if (head.ok !== true) {
    const reason = (head.stderr || '').trim().split('\n')[0] ?? ''
    return { ok: false, skipped: `读不到这个 worktree 的 git 仓库${reason === '' ? '' : `：${reason}`}`.slice(0, 300) }
  }
  const branch = String(head.stdout ?? '').trim()
  const log = await git('log', '--format=%H', '-n', '200')
  const actualCommits = String(log.stdout ?? '').trim().split('\n').filter(item => item !== '')
  const base = String(info.base ?? 'main').trim() || 'main'
  const diff = await git('diff', '--name-only', `${base}...HEAD`)
  let actualFiles = String(diff.stdout ?? '').trim().split('\n').filter(item => item !== '')
  if (diff.ok !== true || actualFiles.length === 0) {
    // 基线分支名对不上时退回到「最近 20 次提交涉及的文件」，免得误报「一个文件都没改」。
    const fallback = await git('diff', '--name-only', 'HEAD~20', 'HEAD')
    if (fallback.ok === true) actualFiles = String(fallback.stdout ?? '').trim().split('\n').filter(item => item !== '')
  }
  const status = await git('status', '--porcelain')
  const dirty = String(status.stdout ?? '').trim().split('\n').filter(item => item !== '')
  const declaredBranch = String(coding.branch ?? '').trim()
  const declaredCommits = (coding.commits ?? []).map(item => String(item.sha ?? '').trim()).filter(item => item !== '')
  const declaredFiles = (coding.files ?? []).map(item => String(item.path ?? '').trim()).filter(item => item !== '')
  const commitHit = sha => actualCommits.some(full => full.startsWith(sha.toLowerCase()) || sha.toLowerCase().startsWith(full.slice(0, 8)))
  const fileHit = path => actualFiles.some(item => item === path || item.endsWith(`/${path}`) || path.endsWith(`/${item}`))
  const missingCommits = declaredCommits.filter(sha => commitHit(sha) !== true)
  const missingFiles = declaredFiles.filter(path => fileHit(path) !== true)
  const branchOk = declaredBranch === '' || declaredBranch === branch
  return {
    at: Date.now(),
    branch,
    declaredBranch,
    branchOk,
    commitCount: { declared: declaredCommits.length, actual: actualCommits.length },
    fileCount: { declared: declaredFiles.length, actual: actualFiles.length },
    missingCommits: missingCommits.slice(0, 10),
    missingFiles: missingFiles.slice(0, 20),
    dirty: dirty.slice(0, 10),
    ok: branchOk && missingCommits.length === 0 && missingFiles.length === 0,
  }
}

/**
 * 研发没登记执行记录时，从 worktree 的 git 事实补一条（平台采集，不做推断）。
 * 实现在 task-diff.js：那边同时管着「读什么算改动」的口径，避免两处各解析一遍 git 输出。
 */
export async function autoCollectCoding(store, taskId) {
  return collectCodingFromWorktree(store, taskId, {
    git: args => runCommand('git', args, 30_000),
    commentTask,
  })
}

/** 把核对结果写成一句人话。 */
export function codingVerifyLine(report) {
  if (report === null || report === undefined) return ''
  if (String(report.skipped ?? '') !== '') return String(report.skipped)
  const bits = [`分支 ${report.branch}`]
  if (report.branchOk !== true) bits.push(`记录里写的是 ${report.declaredBranch}`)
  bits.push(`提交 ${report.commitCount.actual} 个、改动 ${report.fileCount.actual} 个文件`)
  if ((report.missingCommits ?? []).length > 0) bits.push(`${report.missingCommits.length} 个记录的提交在分支上找不到`)
  if ((report.missingFiles ?? []).length > 0) bits.push(`${report.missingFiles.length} 个记录的文件没有实际改动`)
  if ((report.dirty ?? []).length > 0) bits.push(`还有 ${report.dirty.length} 处未提交的改动`)
  return bits.join('；')
}

// ------------------------------------------------------- 接口测试执行器（P4）

/** 允许打的 host：精确匹配，或 `*.example.com` 这种子域通配。
 *  规则搬到了 url-guard.js —— 浏览器用例也要用同一套，两边各写一份迟早不一致。 */
export { hostAllowed }

/** 把用例里的相对 URL 拼成绝对地址；不允许的 host 直接抛。 */
export function resolveCaseUrl(http, env, config) {
  const raw = String(http?.url ?? '').trim()
  if (raw.length === 0) throw new Error('这条用例没有配请求地址')
  return resolveAllowedUrl(raw, env.baseUrl, config.testing.allowHosts)
}

/**
 * 每一步实际发出的请求头 = 环境头 → 用例顶层 headers → 该步 headers（后者覆盖前者），
 * 三层都做变量替换。以前只认顶层 headers：多步用例里「登录步不该带业务 cookie」这类需求
 * 无解，写了 step.headers 也会被静默丢弃（sanitize 不收、执行器不读）。
 */
export function stepHeaders(envHeaders, caseHeaders, stepHeadersRaw, vars) {
  const out = {}
  for (const source of [envHeaders ?? {}, caseHeaders ?? {}, stepHeadersRaw ?? {}]) {
    for (const [key, value] of Object.entries(source)) {
      const name = String(key).trim()
      if (name === '') continue
      out[name] = substituteVars(value, vars)
    }
  }
  return out
}

/** 跑一条接口用例：发请求、比状态码、比响应体片段。 */
/** 把 {{变量}} 换成当前上下文里的值；没有的变量原样留着，方便一眼看出漏配。 */
export function substituteVars(text, vars) {
  return String(text ?? '').replace(/\{\{\s*([A-Za-z0-9_.-]{1,40})\s*\}\}/g, (whole, name) => (
    vars[name] === undefined || vars[name] === null ? whole : String(vars[name])
  ))
}

/** 从 JSON 响应里取一个值：`data.token`、`items.0.id`；`header:x-request-id` 取响应头。 */
export function pickJsonPath(payload, path) {
  const text = String(path ?? '').trim()
  if (text === '') return ''
  if (text.toLowerCase().startsWith('header:')) return ''
  let cursor = payload
  for (const part of text.split('.')) {
    if (part === '') continue
    if (cursor === null || cursor === undefined) return ''
    cursor = Array.isArray(cursor) ? cursor[Number(part)] : cursor[part]
  }
  return cursor === null || cursor === undefined ? '' : String(cursor)
}

/** 用哪个测试环境（纯函数）。
 *
 *  没配环境时不要直接判死：用宿主的自身地址跑一遍 —— 否则新装后测试专家一写用例，
 *  卡就永远过不了闸门（issue #5 第 7 条）。这条回退只对"从面板/接口触发"生效，
 *  因为只有那条路径知道请求落在哪个地址上（options.origin）。
 */
export function resolveTestingEnv(config, options = {}) {
  const envs = Array.isArray(config?.testing?.envs) ? config.testing.envs : []
  const envId = String(options.env ?? config?.testing?.defaultEnv ?? '')
  const configured = envs.find(item => item.id === envId) ?? envs[0]
  if (configured !== undefined) return { env: configured, fallback: false }
  const origin = String(options.origin ?? '').trim()
  if (origin !== '') return { env: { id: 'inline', name: '本机回退（未配置测试环境）', baseUrl: origin, inline: true }, fallback: true }
  return { env: undefined, fallback: false }
}

/**
 * 开跑之前先探一下环境。环境没起的时候，一整套用例会被刷成"失败"，
 * 需求准出还会因此被卡住——那不是用例坏了，是环境没开。
 * 任何 HTTP 响应（含 404/500）都算"活着"，只有连不上/超时才算不可达。
 */
export async function probeEnv(env, config, timeoutMs = 5000) {
  const baseUrl = String(env?.baseUrl ?? '').trim()
  const id = String(env?.id ?? '')
  if (baseUrl === '') return { ok: false, env: id, baseUrl: '', error: '环境没有填 baseUrl' }
  let url
  try {
    url = new URL(baseUrl)
  } catch {
    return { ok: false, env: id, baseUrl, error: 'baseUrl 不是合法地址' }
  }
  const allow = Array.isArray(config?.testing?.allowHosts) ? config.testing.allowHosts : []
  if (!hostAllowed(url.hostname, allow)) {
    return { ok: false, env: id, baseUrl, error: `域名 ${url.hostname} 不在白名单（设置 → 测试执行 → 允许访问的域名）` }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(Number(timeoutMs) || 5000, 15000)))
  const started = Date.now()
  try {
    const response = await fetch(baseUrl, { method: 'GET', signal: controller.signal, redirect: 'manual' })
    return { ok: true, env: id, baseUrl, status: response.status, ms: Date.now() - started }
  } catch (error) {
    const code = error?.cause?.code ?? error?.code ?? error?.name
    const reason = String(code ?? error?.message ?? error).slice(0, 120)
    return { ok: false, env: id, baseUrl, error: reason, ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 跑一条用例：怎么跑由注册表决定（runners.js）。这里只负责挑 runner 和兜底报错，
 * 以后加 DB / 浏览器执行器不用再改这个函数。
 */
export async function runOneCase(item, env, config, seedVars) {
  const runner = pickRunner(item)
  if (runner === null) {
    return { ok: false, status: 0, ms: 0, error: '这条用例没有可执行的定义：http / shell 都是空的（先补一个再跑）', preview: '' }
  }
  return runner.run(item, env, config, seedVars)
}

// 内置两种执行器：http（打接口）与 shell（跑命令）。后面的类型用 registerRunner 往这里加。
registerRunner('http', { match: item => item.http != null, run: (item, env, config, seedVars) => runHttpCase(item, env, config, seedVars) })
// shell 后注册 = 匹配优先级更高：两条都填的时候按 shell 跑（它是显式选择）。
registerRunner('shell', { match: item => item.shell != null, run: (item, env, config) => runShellCase(item, config) })
registerRunner('db', { match: item => item.db != null, run: (item, env, config) => runDbCase(item, config) })
// 浏览器最后注册 = 优先级最高：同时填了接口和浏览器时，按「真开页面」跑（它更接近用户看到的）
registerRunner('browser', { match: item => item.browser != null, run: (item, env, config) => runBrowserCase(item, env, config) })

async function runHttpCase(item, env, config, seedVars) {
  const started = Date.now()
  if (item.http == null) {
    return { ok: false, status: 0, ms: 0, error: '这条用例还没有可执行的请求定义（method/url）', preview: '' }
  }
  const vars = { ...(env.vars ?? {}), ...(item.http.vars ?? {}), ...(seedVars ?? {}) }
  const steps = (item.http.steps ?? []).length > 0
    ? item.http.steps
    : [{
        method: item.http.method,
        url: item.http.url,
        body: item.http.body,
        expectStatus: item.http.expectStatus,
        expectContains: item.http.expectContains,
        extract: {},
      }]
  const timeout = item.http.timeoutMs > 0 ? item.http.timeoutMs : config.testing.timeoutMs
  const stepResults = []
  let preview = ''
  let response = ''
  let status = 0
  let failure = ''
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    const stepStarted = Date.now()
    const renderedUrl = substituteVars(step.url, vars)
    const renderedBody = step.body === '' ? '' : substituteVars(step.body, vars)
    let url
    try {
      url = resolveCaseUrl({ url: renderedUrl }, env, config)
    } catch (error) {
      failure = `第 ${index + 1} 步：${error.message}`
      stepResults.push({ i: index + 1, method: step.method, url: renderedUrl, ok: false, status: 0, ms: Date.now() - stepStarted, error: error.message, preview: '' })
      break
    }
    const headers = stepHeaders(env.headers, item.http.headers, step.headers, vars)
    /* redirect: 'manual' —— 302 到 169.254.169.254 这类内网地址时不要把请求跟过去，
       直接把 3xx 当结果返回（用例自己判断）。 */
    const init = { method: step.method, headers, signal: AbortSignal.timeout(timeout), redirect: 'manual' }
    if (renderedBody !== '' && step.method !== 'GET' && step.method !== 'HEAD') {
      init.body = renderedBody
      if (Object.keys(headers).every(key => key.toLowerCase() !== 'content-type')) headers['content-type'] = 'application/json'
    }
    let resp
    let text = ''
    try {
      resp = await fetch(url, init)
      text = await resp.text()
    } catch (error) {
      const message = error?.name === 'TimeoutError' ? `超时（>${timeout}ms）` : `${error?.cause?.code ?? error?.message ?? error}`
      failure = `第 ${index + 1} 步：${message}`
      stepResults.push({ i: index + 1, method: step.method, url, ok: false, status: 0, ms: Date.now() - stepStarted, error: message, preview: '' })
      break
    }
    status = resp.status
    preview = text.slice(0, 600)
    response = text.slice(0, 2000)
    for (const [name, path] of Object.entries(step.extract ?? {})) {
      if (String(path).toLowerCase().startsWith('header:')) {
        vars[name] = resp.headers.get(String(path).slice(7)) ?? ''
        continue
      }
      let parsed = null
      try { parsed = JSON.parse(text) } catch { parsed = null }
      vars[name] = parsed === null ? '' : pickJsonPath(parsed, path)
    }
    const statusOk = step.expectStatus > 0 ? status === step.expectStatus : (status >= 200 && status < 400)
    const containsOk = step.expectContains === '' ? true : text.includes(step.expectContains)
    const reasons = []
    if (!statusOk) reasons.push(step.expectStatus > 0 ? `期望 ${step.expectStatus}，实际 ${status}` : `期望 2xx/3xx，实际 ${status}`)
    if (!containsOk) reasons.push(`响应里没有「${step.expectContains}」`)
    const stepOk = reasons.length === 0
    stepResults.push({
      i: index + 1,
      method: step.method,
      url,
      ok: stepOk,
      status,
      ms: Date.now() - stepStarted,
      error: reasons.join('；'),
      preview: text.slice(0, 300),
    })
    // 多步之间是有依赖的（下一步用这一步的 token/id），前一步废了就没有继续的意义。
    if (!stepOk) {
      failure = `第 ${index + 1} 步：${reasons.join('；')}`
      break
    }
  }
  const ok = failure === ''
  return {
    ok,
    status,
    ms: Date.now() - started,
    error: failure,
    preview,
    response,
    steps: stepResults,
  }
}

/**
 * 跑一张卡上的用例（不传 caseIds 就跑全部有请求定义的用例）：
 * 结果写回用例、追加一条执行记录、失败的用例自动开缺陷卡。
 */
export async function runTaskCases(store, taskId, options = {}) {
  const state = store.snapshot()
  const task = state.tasks.find(entry => entry.id === String(taskId ?? ''))
  if (task === undefined) throw new Error('任务不存在')
  const config = state.config
  const { env } = resolveTestingEnv(config, options)
  const wanted = Array.isArray(options.caseIds) && options.caseIds.length > 0
    ? new Set(options.caseIds.map(id => String(id)))
    : null
  const targets = (Array.isArray(task.cases) ? task.cases : [])
    /* 「哪些用例能跑」只有一个判据：isExecutable。以前这里手写 http/shell 两个条件——
       db 和浏览器用例建得出来、抽屉里也有 ▶ 了，却永远进不了这一层（AGENTS.md 记过的坑）。 */
    .filter(item => (wanted === null ? isExecutable(item) : wanted.has(item.id)))
  if (targets.length === 0) throw new Error('没有可执行的用例：接口用例要填 method + url，shell 要填 command，数据库要填 file + sql，浏览器要填 url（相对地址会拼测试环境 baseUrl）')

  // 需要测试环境的是「要打地址」的那两种；纯 shell / 数据库用例不该被「环境不可达」挡住。
  if (targets.some(item => item.http != null || (item.browser != null && /^https?:\/\//i.test(String(item.browser.url ?? '')) !== true))) {
    if (env === undefined) throw new Error('还没有配置测试环境（设置 → 测试执行）：加一个环境，或从面板里跑（会回退到宿主自身地址）')
    const probe = env.inline === true ? { ok: true } : await probeEnv(env, config)
    if (probe.ok !== true) {
      throw new Error(`测试环境「${env.name || env.id}」不可达（${probe.error}）：一条用例都没跑，先把 ${probe.baseUrl || 'baseUrl'} 起来`)
    }
  }

  const by = String(options.by ?? '系统').slice(0, 40)
  /* shell / db 用例不需要测试环境：env 可能是 undefined，落库时读 env.id 会直接 TypeError
     （整卡跑 shell 用例报 Cannot read properties of undefined (reading 'id')）。 */
  const envId = env === undefined ? '' : String(env.id ?? '')
  const results = []
  // 串行跑，环境不稳时并发只会让失败更难归因。
  for (const item of targets) {
    const outcome = await runOneCase(item, env, config)
    results.push({ id: item.id, title: item.title, ...outcome })
    if (outcome.ok !== true && item.flaky !== true) {
      emitEvent('case/failed', { taskId: task.id, code: task.code ?? '', caseId: item.id, title: item.title, error: String(outcome.error ?? '').slice(0, 200) })
    }
    await store.mutate(draft => {
      const card = draft.tasks.find(entry => entry.id === task.id)
      if (card === undefined) return
      card.cases = (Array.isArray(card.cases) ? card.cases : []).map(entry => {
        if (entry.id !== item.id) return entry
        const note = outcome.ok
          ? `${String(item.http?.method ?? 'GET')} ${String(item.http?.url ?? '')} → ${outcome.status}（${outcome.ms}ms）`
          : `${String(item.http?.method ?? 'GET')} ${String(item.http?.url ?? '')} → ${outcome.error}`
        return {
          ...entry,
          result: outcome.ok ? 'pass' : 'fail',
          note: note.slice(0, 400),
          by,
          at: Date.now(),
          lastRun: { at: Date.now(), ok: outcome.ok, status: outcome.status, ms: outcome.ms, error: outcome.error, preview: outcome.preview, response: outcome.response ?? '', env: envId, steps: outcome.steps ?? [] },
        }
      })
      card.updatedAt = Date.now()
    })
  }

  const run = sanitizeTestRun({
    id: `run-${randomBytes(3).toString('hex')}`,
    at: Date.now(),
    by,
    env: envId,
    results,
  })
  await store.mutate(draft => {
    const card = draft.tasks.find(entry => entry.id === task.id)
    if (card === undefined) return
    card.testRuns = [...(Array.isArray(card.testRuns) ? card.testRuns : []), run].slice(-10)
    card.updatedAt = Date.now()
  })

  // 失败即开缺陷：复用 P3 的去重逻辑（同一条用例重复失败只加评论）。
  const bugs = []
  for (const outcome of results) {
    if (outcome.ok) continue
    const latest = store.snapshot().tasks.find(entry => entry.id === task.id)
    const item = (latest?.cases ?? []).find(entry => entry.id === outcome.id)
    if (item === undefined) continue
    // 不稳定用例失败不自动建缺陷：环境抖动、脚本不稳、数据异常造成的红灯不该污染缺陷池。
    if (item.flaky === true) {
      bugs.push({ caseId: outcome.id, title: outcome.title, bug: '', created: false, skipped: 'flaky' })
      continue
    }
    try {
      const bug = await host.autoBugFromCase(store, latest, item, by)
      bugs.push({ caseId: outcome.id, title: outcome.title, bug: bug?.bug?.code || bug?.bug?.id || '', created: bug?.created === true, skipped: String(bug?.skipped ?? '') })
    } catch (error) {
      bugs.push({ caseId: outcome.id, title: outcome.title, bug: '', created: false, error: String(error?.message ?? error) })
    }
  }

  const passed = results.filter(item => item.ok).length
  await commentTask(
    store,
    task.id,
    `接口测试已在环境「${env === undefined ? '（未配置测试环境）' : (env.name || env.id)}」跑完：${results.length} 条，通过 ${passed}，不通过 ${results.length - passed}。`
      + (results.length - passed > 0 ? `\n\n不通过的：\n${results.filter(item => !item.ok).map(item => `- ${item.title}：${item.error}`).join('\n')}` : ''),
    by,
    'agent',
  )
  const envSummary = env === undefined ? { id: '', name: '', baseUrl: '' } : { id: env.id, name: env.name, baseUrl: env.baseUrl }
  return { run, env: envSummary, bugs, state: host.publicState(store) }
}

/**
 * 批量跑一批卡上的用例：卡与卡之间并发（互不依赖），同一张卡内部串行。
 * 默认对象是「待测试」列——测试这一列本来就该是流水线里最自动的一段。
 */
export async function runSuite(store, options = {}) {
  const state = store.snapshot()
  const ids = Array.isArray(options.taskIds) && options.taskIds.length > 0
    ? options.taskIds.map(String)
    : state.tasks.filter(task => task.status === 'test').map(task => task.id)
  const targets = ids.filter(id => state.tasks.some(task => task.id === id)).slice(0, 20)
  if (targets.length === 0) throw new Error('没有可跑的卡：传 taskIds，或者先让卡进入「待测试」列')
  const limit = Math.max(1, Math.min(Number(options.concurrency) || state.config.testing.concurrency || 4, 8))
  const results = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, targets.length) }, async () => {
    while (cursor < targets.length) {
      const mine = cursor
      cursor += 1
      const id = targets[mine]
      try {
        const outcome = await runTaskCases(store, id, { env: options.env, by: options.by })
        results.push({ taskId: id, ok: true, total: outcome.run.total, passed: outcome.run.passed, failed: outcome.run.failed, bugs: outcome.bugs.length })
      } catch (error) {
        results.push({ taskId: id, ok: false, error: String(error?.message ?? error).slice(0, 300) })
      }
    }
  })
  await Promise.all(workers)
  return { concurrency: limit, tasks: results, state: host.publicState(store) }
}

/** 新建或修改一条需求；编号只在新建时分配，之后不再变。 */
/** 功能点的指纹：只比能跟卡片对上号的几列，避免时间戳之类的噪音触发变更。 */
export function requirementPointsFingerprint(points) {
  return JSON.stringify((points ?? []).map(point => [point.id, point.text, point.priority, point.owner ?? '']))
}

/** 这张卡是不是已经产出过东西：到了测试/验收/完成、签过字、跑过用例、有提交。 */
export function requirementTaskTouched(task) {
  if (['test', 'accept', 'done'].includes(String(task.status))) return true
  if (task.signoff !== null && task.signoff !== undefined) return true
  if ((task.cases ?? []).some(item => item.result === 'pass')) return true
  if ((task.coding?.commits ?? []).length > 0) return true
  return false
}

export async function saveRequirement(store, input) {
  /* 链接写坏了不能静默变成空串：issue #9 第 1 条（prd 传相对路径 → 返回"已保存"，实际存成空串，
     要再读一遍库才发现）。只认 sanitizeUrl 允许的形态，其余直接报错并说明合法格式。 */
  const links = input?.links
  if (links !== null && links !== undefined && typeof links === 'object') {
    for (const [key, label] of [['prd', 'PRD'], ['proto', '原型'], ['acceptance', '验收标准']]) {
      const raw = String(links[key] ?? '').trim()
      if (raw !== '' && sanitizeUrl(raw) === '') {
        throw new Error(`${label}链接「${raw}」不合法：只认 http(s)://、mailto:、# 锚点，或以 / 开头的站内路径`)
      }
    }
  }
  // 部分更新（只带 id + 改动的字段）时，先把库里那条垫在下面，免得被判成「标题为空」。
  if (input.id !== undefined && input.id !== null) {
    const known = store.snapshot().requirements.find(item => item.id === String(input.id))
    if (known !== undefined) input = { ...known, ...input }
  }
  const draft = sanitizeRequirement({ ...input, id: input.id ?? '' })
  if (draft === undefined) throw new Error('需求的标题不能为空')
  let saved
  await store.mutate(state => {
    const existing = state.requirements.find(item => item.id === draft.id)
    if (existing === undefined) {
      const now = Date.now()
      /* 以前没有 PRD 的新需求会被自动置成 status=review + review.pending（by「系统」），
         但没有评审人、也没有自动流转 —— 需求永久卡在「评审中」，准出长期挂一条 blocker（issue #5 第 11 条）。
         现在落 draft：想进评审就显式点评审，评审人才会被记录。 */
      const created = {
        ...draft,
        status: draft.status === 'review' && String(draft.links?.prd ?? '').trim() === '' && (draft.docs ?? []).every(doc => String(doc.content ?? '').trim() === '') && draft.baseline === null
          ? 'draft'
          : draft.status,
        review: draft.review,
        code: draft.code.length > 0 ? draft.code : nextRequirementCode(state.requirements),
        createdAt: now,
        updatedAt: now,
      }
      state.requirements.unshift(created)
      saved = created
      return
    }
    // 变更影响面：先记下旧值，覆盖之后再比，才能说清楚「改了哪几处」。
    /* 留痕口径（issue #116）：以前只有路由盯 7 个标量字段，改功能点 / 文档链接 / 澄清三问 /
       依赖一个字都不记 —— 而这几项恰恰决定要不要让研发重做。这里在覆盖前后各拍一张快照。 */
    const snapshotOf = item => ({
      title: String(item.title ?? ''),
      description: String(item.description ?? ''),
      points: requirementPointsFingerprint(item.points),
      links: JSON.stringify(item.links ?? {}),
      discovery: JSON.stringify(item.discovery ?? {}),
      dependsOn: JSON.stringify(item.dependsOn ?? []),
      questions: JSON.stringify((item.questions ?? []).map(question => [question.text, question.status, question.answer])),
    })
    const before = snapshotOf(existing)
    const beforeText = { title: before.title, description: before.description }
    // 更新时的字段白名单：漏一个就会「保存成功但字段没变」（discovery 就是这样丢过一次）
    for (const key of ['title', 'description', 'project', 'iteration', 'owner', 'domain', 'priority', 'status', 'links', 'discovery', 'requester', 'source']) {
      existing[key] = draft[key]
    }
    // 排序与依赖单独处理：显式给了才覆盖，避免详情页保存别的字段时把它们清空。
    for (const key of ['order', 'dependsOn']) {
      if (input[key] !== undefined) existing[key] = draft[key]
    }
    // 功能点是需求的骨架：显式给了才覆盖，避免别的保存动作把矩阵清空。
    if (input.points !== undefined) existing.points = draft.points
    if (existing.code.length === 0) existing.code = nextRequirementCode(state.requirements)
    /* 逐字段写 history：from → to，by 用调用方给的名字（工具现在也传 by 了）。 */
    const after = snapshotOf(existing)
    const clipped = value => (String(value ?? '').length > 300 ? `${String(value).slice(0, 300)}…` : String(value ?? ''))
    const fieldLabel = { points: '功能点', links: '文档链接', discovery: '澄清三问', dependsOn: '依赖', title: '标题', description: '需求明细' }
    const historyRows = []
    for (const key of ['title', 'description', 'points', 'links', 'discovery', 'dependsOn']) {
      if (before[key] === after[key]) continue
      historyRows.push({ at: Date.now(), by: String(input.by ?? input.operator ?? '').trim().slice(0, 60) || '人', field: fieldLabel[key] ?? key, from: clipped(before[key]), to: clipped(after[key]) })
    }
    if (historyRows.length > 0) existing.history = [...(existing.history ?? []), ...historyRows].slice(-100)
    const changedParts = []
    if (existing.title !== beforeText.title) changedParts.push('标题')
    if (existing.description !== beforeText.description) changedParts.push('需求明细')
    if (requirementPointsFingerprint(existing.points) !== before.points) changedParts.push('功能点')
    if (JSON.stringify(existing.links ?? {}) !== before.links) changedParts.push('文档链接')
    if (changedParts.length > 0) {
      // 只有内容（标题/明细/功能点）变了才算影响交付；改个文档链接不动签字。
      const substantive = changedParts.some(part => part !== '文档链接')
      const touched = substantive
        ? state.tasks.filter(task => task.requirementId === existing.id && requirementTaskTouched(task))
        : []
      const hadSignoff = existing.signoff !== null && existing.signoff !== undefined
      existing.change = {
        at: Date.now(),
        by: String(input.by ?? input.operator ?? '').trim().slice(0, 60) || '人',
        parts: changedParts,
        affected: touched.slice(0, 60).map(task => ({ id: task.id, code: task.code, title: task.title, status: task.status })),
        // 用例跟卡走：需求改了，这些卡上的用例都得按新版重跑一遍。
        affectedCases: casesOfTasks(touched, 40),
        impact: impactSummary(touched),
        invalidated: substantive && hadSignoff,
      }
      // 卡还指着旧需求，签字就不作数了，要人重新确认一遍。
      if (existing.change.invalidated) existing.signoff = null
    }
    existing.updatedAt = Date.now()
    saved = existing
  })
  // 新建的需求顺手在云盘里建一个同名文件夹；失败只记录，不影响保存。
  if (saved !== undefined && String(saved.folder?.token ?? '').trim() === '') {
    try {
      await ensureReqFolder(store, saved.id)
    } catch {
      /* 文件夹建不出来时，需求详情里会显示原因，人补一次即可 */
    }
  }
  return saved
}

/** 一个需求的体检：按列/按类型分布、用例通过率、交付物、MR。 */
export function requirementRollup(state, id) {
  const requirement = state.requirements.find(item => item.id === id)
  if (requirement === undefined) return undefined
  const tasks = state.tasks.filter(task => task.requirementId === id)
  const byStatus = {}
  for (const status of STATUS_IDS) byStatus[status] = 0
  const byType = {}
  for (const task of tasks) {
    byStatus[task.status] = (byStatus[task.status] ?? 0) + 1
    byType[task.type] = (byType[task.type] ?? 0) + 1
  }
  const cases = { total: 0, pass: 0, fail: 0, pending: 0, skip: 0 }
  let checklistTotal = 0
  let checklistDone = 0
  const artifacts = []
  const mrs = []
  for (const task of tasks) {
    for (const item of task.cases ?? []) {
      cases.total += 1
      cases[item.result] = (cases[item.result] ?? 0) + 1
    }
    for (const item of task.checklist ?? []) {
      checklistTotal += 1
      if (item.done) checklistDone += 1
    }
    for (const artifact of task.artifacts ?? []) artifacts.push({ ...artifact, taskId: task.id, taskCode: task.code })
    if (task.gitlabMR !== undefined && task.gitlabMR !== null && String(task.gitlabMR.url ?? '').length > 0) {
      mrs.push({ ...task.gitlabMR, taskId: task.id, taskCode: task.code })
    }
  }
  return {
    requirement,
    tasks,
    artifacts,
    mrs,
    byStatus,
    byType,
    metrics: {
      total: tasks.length,
      blocked: tasks.filter(task => task.blocked !== undefined && task.blocked !== null).length,
      done: tasks.filter(task => task.status === 'done').length,
      bugs: tasks.filter(task => task.type === 'bug' && task.status !== 'done').length,
      checklist: { total: checklistTotal, done: checklistDone },
      cases,
      artifacts: artifacts.length,
      mrs: mrs.length,
    },
  }
}

// ------------------------------------------------------------ 项目检查（本地质量命令）

/**
 * 跑一次项目检查，把结果记到卡上（task.quality），并在 history 留一行。
 * 命令配在服务的 qualityCmd（项目级兜底）；没配就明确报错，不要假装跑过了。
 * cwd 优先卡的 worktree：检查的是这次要交的代码，不是主目录上的代码。
 */
export async function runTaskQuality(store, taskId, { by = 'agent' } = {}) {
  const state = store.snapshot()
  const task = state.tasks.find(entry => entry.id === taskId)
  if (task === undefined) throw new Error(`no task ${taskId}`)
  const target = qualityTargetFor(state.config, task, state.requirements ?? [])
  if (target === null) {
    throw new Error('这张卡所在的项目/服务还没配项目检查命令（设置 → 项目 → 项目检查，如 `npm run check`）')
  }
  if (target.cwd === '') {
    throw new Error(`配了项目检查命令（${target.cmd}），但没有代码目录：请给服务或项目填本机 git 路径`)
  }
  const result = await runQualityCommand(target)
  const quality = sanitizeQuality({ ...result, cmd: target.cmd, cwd: target.cwd, by, at: Date.now() })
  await store.mutate(draft => {
    const card = draft.tasks.find(entry => entry.id === taskId)
    if (card === undefined) return
    card.quality = quality
    const detail = quality.ok
      ? `项目检查通过：${target.cmd}（${(quality.ms / 1000).toFixed(1)}s）`
      : `项目检查不通过：${target.cmd}（${quality.timedOut ? '超时' : `退出码 ${quality.exitCode}`}，${(quality.ms / 1000).toFixed(1)}s）`
    card.history = [...(card.history ?? []), { at: Date.now(), by, status: card.status, note: detail }]
  })
  return { task: store.snapshot().tasks.find(entry => entry.id === taskId), target, quality }
}

/**
 * 卡上的项目检查结果（给面板用）：配了什么、跑过没有、通过没有。
 * 只读，方便抽屉和守卫共用同一份判断。
 */
export function qualitySummary(state, task) {
  const target = qualityTargetFor(state?.config ?? {}, task, state?.requirements ?? [])
  const quality = task?.quality ?? null
  return {
    configured: target !== null,
    cmd: target?.cmd ?? '',
    cwd: target?.cwd ?? '',
    service: target?.service ?? '',
    ran: quality !== null,
    ok: quality?.ok === true,
    at: quality?.at ?? 0,
    exitCode: quality?.exitCode ?? null,
    timedOut: quality?.timedOut === true,
    ms: quality?.ms ?? 0,
    stale: quality !== null && task?.coding !== null && task?.coding !== undefined && quality.at < (task.coding.updatedAt ?? 0),
  }
}

/**
 * 卡能不能进「已完成」：验收清单全勾、没有失败用例、不处在阻塞中、并且有人签字。
 * 没过就抛错，除非显式带 override 理由（会记进状态历史）。
 */
/** structuredClone 抛「Cannot clone object of unsupported type」时的兜底：
 *  展示用的那份快照不该把整次状态流转作废（issue #14）。 */
const safeClone = value => {
  try { return structuredClone(value) } catch { /* 落到 JSON 兜底 */ }
  try { return JSON.parse(JSON.stringify(value)) } catch { return null }
}

/**
 * 子卡闸门：一张卡只要有子卡（缺陷卡、拆出来的卡），就必须**所有子卡都完成并且都签过字**，
 * 才允许主卡验收签收。
 *
 * 真机场景（2026-11-23）：主卡 REQ-2026-007-4 被要求签字时，它的子卡 BUG-038 还在待验收、
 * 用例刚复跑通过、字也没签——用户签了主卡，等于在 bug 还开着的时候就验收了。
 * 规则改成：主卡的签字要等子卡全部收口。
 */
export function childSignoffBlockers(state, task) {
  const parentId = String(task?.id ?? '')
  if (parentId === '') return []
  const children = (state?.tasks ?? []).filter(item => String(item.parent ?? '') === parentId)
  if (children.length === 0) return []
  const name = item => item.code || item.id
  const blockers = []
  const pending = children.filter(item => item.status !== 'done')
  if (pending.length > 0) {
    blockers.push(`还有 ${pending.length} 张子卡没完成（${pending.slice(0, 3).map(name).join('、')}）：子卡没过不许签收主卡`)
  }
  const unsigned = children.filter(item => item.status === 'done' && (item.signoff === undefined || item.signoff === null))
  if (unsigned.length > 0) {
    blockers.push(`还有 ${unsigned.length} 张子卡没验收签字（${unsigned.slice(0, 3).map(name).join('、')}）：先签子卡再签主卡`)
  }
  return blockers
}

export function taskExitGate(state, task) {
  const blockers = []
  const warnings = []
  const checklist = task.checklist ?? []
  const unchecked = checklist.filter(item => item.done !== true)
  if (unchecked.length > 0) {
    blockers.push(`验收清单还有 ${unchecked.length} 项没勾：${unchecked.slice(0, 3).map(item => item.text).join('、')}`)
  }
  const cases = task.cases ?? []
  /* 「用例全绿」曾经是假的：全库 101 条用例里 0 条带可执行定义（http/shell/db），
     而门禁只把「没有用例」和「没跑」当 warning —— 于是 0/0 也能通过。
     现在：有用例但一条都跑不了、或跑得了但一条都没通过，都算阻断。 */
  const executable = cases.filter(item => isExecutable(item))
  const executablePassed = executable.filter(item => item.result === 'pass')
  if (cases.length > 0 && executable.length === 0) {
    blockers.push(`${cases.length} 条用例都只有标题，没有一条带可执行定义（http / shell / db）—— 无法判定是否验过`)
  } else if (executable.length > 0 && executablePassed.length === 0) {
    blockers.push(`${executable.length} 条可执行用例一条都没通过（当前通过 0 条）`)
  }
  const failed = cases.filter(item => item.result === 'fail')
  if (failed.length > 0) blockers.push(`${failed.length} 条用例不通过：${failed.slice(0, 3).map(item => item.title).join('、')}`)
  // CI 门禁：真跑过流水线且失败，不允许收口（没接 GitLab 时这个字段是空的，不会误伤）。
  if (task.gitlabMR?.pipeline?.status === 'failed') blockers.push(`CI 流水线没通过：${task.gitlabMR.pipeline.id ? `#${task.gitlabMR.pipeline.id}` : '最近一次运行'}`)
  if (task.blocked !== undefined && task.blocked !== null) blockers.push('这张卡还挂着阻塞标记')
  /* 子卡没完成 / 没签字时，主卡连「要人签字」都不该提——先收口子卡。 */
  blockers.push(...childSignoffBlockers(state, task))
  if (task.signoff === undefined || task.signoff === null) blockers.push('还没有验收签字')
  // AI 不能代签：自己验、自己签、自己推到完成，等于验收这一环没人看过。
  else if (isAiSignoff(task.signoff, state.config)) blockers.push(`验收签字是 AI 写的（${task.signoff.by}）：卡准出要人签。让人签一次，或者走 override 写明为什么这次可以例外`)
  if (cases.length === 0) {
    /* 用例闸门（config.caseGate，默认开）：代码/测试类的卡一条用例都没有，就不许收口。
       以前这里只是 warning —— 真机 20 张到过验收的卡里有 6 张零用例，门禁没拦，
       于是「门禁一次通过率」91%（产品定义里 >90% 说明这道门太松）。
       产品/设计/需求卡不适用：它们本来就不该被用例卡住。 */
    const codeLike = ['dev', 'test', 'bug'].includes(String(task.type ?? ''))
    if (codeLike && state?.config?.caseGate?.enabled !== false) {
      blockers.push('这张是代码/测试类卡，但一条测试用例都没有：至少补一条（http / shell / db / 浏览器任一可执行定义）并跑通')
    } else {
      warnings.push('这张卡没有测试用例，建议至少补一条主流程用例')
    }
  }
  else {
    const pending = cases.filter(item => item.result === 'pending' || item.result === 'skip').length
    if (pending > 0) warnings.push(`${pending} 条用例还没跑`)
  }
  /* 三层测试（单元 / 集成 / 端到端）：代码类卡上，每条线要么有可执行用例，要么由测试专家
     在测试计划里写明「不适用 + 理由」。以前一条打接口的用例就能让卡收口，
     代码分支与页面上的真实操作没人验，「测过了」只覆盖了集成这一层。 */
  if (needsTierPlan(task) && state?.config?.caseGate?.enabled !== false && state?.config?.caseGate?.tiers !== false && cases.length > 0) {
    const plan = testPlanSummary(cases, task.testPlan)
    if (plan.gaps.length > 0) blockers.push(gapMessage(plan.gaps))
  }
  const artifacts = task.artifacts ?? []
  // 核对过但没通过：给一句提醒（不拦准出：拦不拦是产品决定）。
  const coding = task.coding ?? null
  /* 代码评审进准出：有执行记录就必须有评审结论，且不能被评审为「要改」。
     以前 coding.review 完全不参与准出 —— pending 或 changes_requested 的卡照样能推到完成。 */
  if (coding !== null) {
    const reviewStatus = String(coding.review?.status ?? '')
    if (reviewStatus === '' || reviewStatus === 'pending') blockers.push('代码评审还没给出结论：让评审人用 studio_task_coding action=review 写 approved / changes_requested')
    else if (reviewStatus === 'changes_requested') blockers.push(`代码评审要改：${String(coding.review?.note ?? '').slice(0, 80) || '评审人要求修改'}`)
  }
  /* 项目检查（本地质量命令，如 `npm run check`）：配了就必须跑过。
     只对「有代码改动」的卡要求（coding !== null）—— 产品卡、设计卡不该被代码命令拦住。
     跑过但不通过一律拦：这是唯一一处「机器跑出来的证据」参与准出。 */
  const quality = qualitySummary(state, task)
  if (quality.configured === true) {
    if (quality.ran !== true) {
      if (coding !== null) blockers.push(`项目配了检查命令（${quality.cmd}），这张卡还没跑过：用 studio_task_quality 跑一次`)
    } else if (quality.ok !== true) {
      blockers.push(`项目检查不通过：${quality.cmd}（${quality.timedOut ? '超时' : `退出码 ${quality.exitCode}`}）`)
    }
  }
  if (coding?.verified !== null && coding?.verified !== undefined && coding.verified.ok !== true) {
    warnings.push('代码事实核对不通过：' + String((coding.verified.missingCommits ?? []).length) + ' 个提交 / ' + String((coding.verified.missingFiles ?? []).length) + ' 个文件在仓库里找不到')
  }
  if (artifacts.length === 0) warnings.push('没有登记任何交付物')
  else {
    const empty = artifacts.filter(item => String(item.content ?? '').trim() === '').length
    if (empty > 0) warnings.push(`${empty} 件交付物没有正文`)
  }
  // 服务依赖：上游服务还有没做完的卡时，这张卡先别收口（接口契约/联调顺序）。
  const deps = host.serviceDependencies(state, task)
  if (deps !== undefined && deps.pending > 0) {
    const waiting = deps.rows.filter(row => row.open > 0)
    blockers.push(`依赖服务还没完成：${waiting.map(row => `${row.name}（${row.open} 张：${row.titles.join('、')}）`).join('；')}`)
  }
  // 执行记录 vs 代码事实：agent 自报的提交/文件跟分支上的真实情况对不上，就不许收口。
  const verified = task.coding?.verified ?? null
  if (verified !== null && verified.ok !== true) {
    const bits = []
    if (verified.branchOk !== true) bits.push(`分支对不上（记录里是 ${verified.declaredBranch}，实际是 ${verified.branch}）`)
    if ((verified.missingCommits ?? []).length > 0) bits.push(`${verified.missingCommits.length} 个记录的提交在分支上找不到`)
    if ((verified.missingFiles ?? []).length > 0) bits.push(`${verified.missingFiles.length} 个记录的文件没有实际改动`)
    if (bits.length > 0) blockers.push(`执行记录和代码不一致：${bits.join('；')}`)
  } else if (verified === null && task.coding !== null && task.coding !== undefined && task.worktree !== null && task.worktree !== undefined) {
    warnings.push('执行记录还没和代码事实核对过（执行记录页里有「核对代码事实」）')
  }
  // 同服务并行：几张卡同时改一个服务，合并时要人盯着。
  const parallel = host.serviceConflicts(state, task)
  if (parallel !== undefined) {
    warnings.push(`同一个服务「${parallel.name}」还有 ${parallel.count} 张卡在改（${parallel.tasks.slice(0, 3).map(item => item.code).join('、')}），合并前先对齐，避免互相覆盖`)
  }
  return { ready: blockers.length === 0, blockers, warnings }
}

/**
 * 工作台：一眼看清「哪里着火了」。
 * 只做汇总，不改任何数据；列表最多各给 6 条，点进去看卡片。
 */
export function buildDashboard(state) {
  const now = Date.now()
  const tasks = state.tasks
  const open = tasks.filter(task => task.status !== 'done')
  const listOf = (items, limit = 6) => items.slice(0, limit).map(task => ({
    id: task.id,
    code: task.code,
    title: task.title,
    status: task.status,
    statusLabel: (STATUSES.find(entry => entry.id === task.status)?.label) ?? task.status,
    owner: task.owner || '',
    dueAt: task.dueAt || 0,
    sla: host.bugSla(task, state.config),
  }))

  const overdue = open.filter(task => task.dueAt > 0 && task.dueAt < now)
  const blocked = open.filter(task => task.blocked != null)
  /* 停摆 = 派单印记还挂在这一列，但会话已经不在跑（崩过 / 被中断）。
     这种卡不会自己恢复、也不会再被自动派单，界面上却和「排队中」长得一样 —— 必须单独数出来。 */
  const stalled = open.filter(task => isStalled(task))
  const slaOverdue = open.filter(task => task.type === 'bug' && host.bugSla(task, state.config).state === 'overdue')
  // 强制放行是逃生舱，用得越来越顺就该被看一眼：30 天内超过上限算风险。
  const overrideWindow = overrideSummary(state, { since: Date.now() - 30 * 86_400_000, config: state.config })
  const overrideMax = Number(state.config?.limits?.overrideMax) || 3
  const overrideOver = overrideWindow.total > overrideMax ? overrideWindow.total : 0
  const gateFailed = open.filter(task => {
    if (task.status !== 'test' && task.status !== 'accept') return false
    const gate = taskExitGate(state, task)
    return gate.blockers.length > 0
  })
  const pipelineFailed = open.filter(task => task.gitlabMR?.pipeline?.status === 'failed')

  const requirementBlocked = state.requirements.filter(item => {
    const progress = requirementProgress(state, item)
    return progress.derived !== 'delivered' && progress.derived !== 'closed' && progress.gate.blockers.length > 0
  })
  const releaseBlocked = state.releases.filter(item => item.status !== 'released' && item.status !== 'rolled_back' && !host.releaseGate(state, item).ready)

  const done = tasks.filter(task => task.status === 'done')
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const doneToday = done.filter(task => (task.updatedAt || 0) >= dayStart.getTime())
  const doneWeek = done.filter(task => (task.updatedAt || 0) >= now - 7 * 24 * 60 * 60 * 1000)
  const aiRunning = host.activeDispatcher === null ? 0 : host.activeDispatcher.running.size
  const runs = typeof RUN_LOG !== 'undefined' && Array.isArray(RUN_LOG) ? RUN_LOG : []

  return {
    at: now,
    scope: { tasks: tasks.length, open: open.length, requirements: state.requirements.length, releases: state.releases.length },
    risks: {
      overdue: overdue.length,
      blocked: blocked.length,
      stalled: stalled.length,
      slaOverdue: slaOverdue.length,
      gateFailed: gateFailed.length,
      pipelineFailed: pipelineFailed.length,
      requirementBlocked: requirementBlocked.length,
      releaseBlocked: releaseBlocked.length,
      overrideOver: overrideOver,
      overrideMax,
      integrationsBroken: host.healthReport().broken,
    },
    flow: {
      review: tasks.filter(task => task.status === 'review').length,
      test: tasks.filter(task => task.status === 'test').length,
      accept: tasks.filter(task => task.status === 'accept').length,
      doneToday: doneToday.length,
      doneWeek: doneWeek.length,
    },
    ai: { running: aiRunning, todayRuns: runs.filter(item => (item.at || 0) >= dayStart.getTime()).length },
    list: {
      overdue: listOf(overdue),
      blocked: listOf(blocked),
      stalled: listOf(stalled),
      slaOverdue: listOf(slaOverdue),
      gateFailed: listOf(gateFailed),
      pipelineFailed: listOf(pipelineFailed),
      overrideOver: overrideWindow.list.slice(0, 6),
      requirementBlocked: requirementBlocked.slice(0, 6).map(item => ({
        id: item.id,
        code: item.code,
        title: item.title,
        blockers: requirementProgress(state, item).gate.blockers.slice(0, 3),
      })),
      releaseBlocked: releaseBlocked.slice(0, 6).map(item => ({
        id: item.id,
        version: item.version,
        name: item.name,
        blockers: host.releaseGate(state, item).blockers.slice(0, 3),
      })),
    },
  }
}

/** 跑一个外部命令，有超时、不抛异常；lark-cli 之类没有时返回 ok:false。 */
export function runCommand(command, args, timeoutMs = 20000, options = {}) {
  return new Promise(resolvePromise => {
    let child
    // Windows 上 npm 装的 CLI（lark-cli）是 .cmd 壳，spawn 直接执行会 ENOENT，必须经 cmd.exe；
    // 而 cmd.exe 会把 & | < > ^ % 当语法字符，所以参数要逐个加引号（见 cmd-args.js，真机两次踩过）。
    const viaCmd = process.platform === 'win32' && command === 'lark-cli'
    try {
      const plan = viaCmd ? commandArgs(command, args) : { file: command, argv: args }
      // windowsVerbatimArguments：由我们自己给参数加引号（否则 Node 的转义会和 cmd 的语法打架，
      // 实测 `|` 仍然会被当管道 → 命令被截断）。非 cmd 路径保持默认。
      child = spawn(plan.file, plan.argv, { windowsHide: viaCmd, windowsVerbatimArguments: viaCmd, stdio: ['ignore', 'pipe', 'pipe'], cwd: options.cwd })
    } catch (error) {
      resolvePromise({ ok: false, code: -1, stdout: '', stderr: String(error?.message ?? error) })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => {
      clearTimeout(timer)
      resolvePromise({ ok: false, code: -1, stdout, stderr: String(error?.message ?? error) })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolvePromise({ ok: code === 0, code, stdout, stderr })
    })
  })
}

/** 从飞书文档拉正文；没有 lark-cli 就如实说明，让人改成粘贴。 */
export async function pullFeishuDoc(url) {
  const target = String(url ?? '').trim()
  if (target === '') return { ok: false, tool: false, text: '', error: '请先填飞书文档链接' }
  if (!/feishu\.cn|larksuite\.com/i.test(target)) return { ok: false, tool: false, text: '', error: '这不是飞书文档链接' }
  const probe = await runCommand('lark-cli', ['--version'], 8000)
  if (!probe.ok) {
    const hint = String(probe.stderr || probe.stdout || 'command not found').split('\n')[0].slice(0, 140)
    return {
      ok: false,
      tool: false,
      text: '',
      error: `服务器上没有可用的 lark-cli（${hint}）。可以自己打开文档，把正文粘进「文档正文」再保存。`,
    }
  }
  const pulled = await runCommand('lark-cli', ['docs', '+fetch', '--doc', target, '--doc-format', 'markdown'], 45000)
  if (!pulled.ok) {
    return { ok: false, tool: true, text: '', error: `拉取失败：${(pulled.stderr || pulled.stdout).slice(0, 300)}` }
  }
  // 解析（JSON / 裸 markdown / 报错）是纯函数，放在 lark-doc.js，坏输入不会抛。
  return { tool: true, ...parseFeishuDocFetch(pulled.stdout) }
}

/** lark-cli 探活：60 秒内复用结果，别每次调用都起进程。 */
export let larkProbeCache = { at: 0, ok: false, hint: '' }

/** Drops the cached probe so the next larkCliReady() shells out again. */
export function invalidateLarkProbe() {
  larkProbeCache = { at: 0, ok: false, hint: '' }
}

export async function larkCliReady() {
  const now = Date.now()
  if (now - larkProbeCache.at < 60000) return larkProbeCache
  const probe = await runCommand('lark-cli', ['--version'], 8000)
  larkProbeCache = {
    at: now,
    ok: probe.ok,
    hint: probe.ok ? '' : String(probe.stderr || probe.stdout || 'command not found').split('\n')[0].slice(0, 140),
  }
  return larkProbeCache
}

/** 以「用户身份」跑一条 lark-cli，返回解析后的 data；失败给一句人话。 */
export async function larkJson(args, timeoutMs = 45000, options = {}) {
  const probe = await larkCliReady()
  if (!probe.ok) {
    host.markHealth('drive', 'fail', `服务器上没有可用的 lark-cli（${probe.hint}）`)
    return { ok: false, error: `服务器上没有可用的 lark-cli（${probe.hint}）` }
  }
  const result = await runCommand('lark-cli', [...args, '--as', 'user', '--json'], timeoutMs, options)
  const raw = String(result.stdout || '').trim()
  if (raw === '') {
    const message = (result.stderr || 'lark-cli 没有输出').slice(0, 300)
    host.markHealth('drive', 'fail', message)
    return { ok: false, error: message }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    host.markHealth('drive', 'fail', `lark-cli 输出不是 JSON：${raw.slice(0, 160)}`)
    return { ok: false, error: raw.slice(0, 300) }
  }
  if (parsed.ok === false) {
    const message = `lark-cli 报错：${String(parsed.error?.message ?? '未知错误').slice(0, 260)}`
    host.markHealth('drive', 'fail', message)
    return { ok: false, error: message }
  }
  host.markHealth('drive', 'ok')
  return { ok: true, data: parsed.data ?? {} }
}

export const ARTIFACT_FILE_LABEL = {
  requirement: '需求', design: '方案', prototype: '原型', mr: '合并请求', cases: '用例', report: '报告',
  release: '发布', doc: '文档', screenshot: '截图', other: '交付物',
}

export function safeFileName(text) {
  return String(text ?? '').replace(/[\\/:*?"<>|\n\r\t]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120)
}

/** 交付物在云盘里的文件名：前缀 + 类型 + 标题，**截断后再补 .md**。
 *  以前是先拼 `.md` 再 slice(0,120)，长标题会把后缀截掉，lark-cli 报
 *  「--file must end with .md」——这类交付物永远归档失败（2026-11-23 真机 13 件）。 */
export function artifactFileName(task, artifact) {
  const prefix = String(task?.code ?? '').length > 0 ? `${task.code}-` : `${task?.id ?? ''}-`
  const label = ARTIFACT_FILE_LABEL[artifact?.kind] ?? '交付物'
  return `${safeFileName(`${prefix}${label}-${artifact?.title ?? ''}`)}.md`
}

/** 需求在云盘里的文件夹名：`REQ-2026-001 会员积分抵扣`。 */
export function requirementFolderName(requirement) {
  return requirementFolderNameOf(requirement)
}

/** 给需求建一个云盘文件夹；已经建过就直接返回。 */
export async function ensureReqFolder(store, requirementId) {
  return ensureRequirementFolder(store, requirementId, larkJson)
}

/** 把一条交付物渲染成 Markdown：谁、在哪个需求下、哪张卡、什么内容。 */
export function artifactMarkdown(task, artifact, requirement) {
  const lines = []
  lines.push(`# ${artifact.title}`)
  lines.push('')
  if (requirement !== undefined) lines.push(`- 需求：${requirement.code || requirement.id} · ${requirement.title}`)
  lines.push(`- 卡片：${task.code || task.id} · ${task.title}`)
  lines.push(`- 类型：${ARTIFACT_FILE_LABEL[artifact.kind] ?? artifact.kind}　状态：${artifact.status}`)
  if (String(artifact.by ?? '').length > 0) lines.push(`- 登记人：${artifact.by}`)
  if (Number(artifact.at) > 0) lines.push(`- 登记时间：${new Date(Number(artifact.at)).toISOString().slice(0, 16).replace('T', ' ')}`)
  if (String(artifact.ref ?? '').length > 0) lines.push(`- 参考：${artifact.ref}`)
  lines.push('')
  const body = String(artifact.content ?? '').trim()
  lines.push(body.length > 0 ? body : '_这条交付物还没有正文。补充正文后点「同步到云盘」，这份文档会被覆盖更新。_')
  lines.push('')
  return lines.join('\n')
}

/** 交付物正文：优先用登记的 content；没有就从 ref 指向的本地文件里读回来。 */
export async function artifactBody(task, artifact, config) {
  const inline = String(artifact.content ?? '').trim()
  if (inline.length > 0) return inline
  const raw = String(artifact.ref ?? '').trim()
  if (raw.length === 0) return ''
  const root = String(config?.agents?.workspaceDir ?? '').trim() || join(homedir(), 'dsh-workspace')
  const target = raw.startsWith('/') ? raw : resolve(root, raw)
  try {
    const info = await stat(target)
    if (!info.isFile() || info.size > 2_000_000) return ''
    const text = await readFile(target, 'utf8')
    return String(text).slice(0, 60000)
  } catch {
    return ''
  }
}

/** 没有挂需求的卡也要能归档：统一放进根目录下的「未挂需求的产物」。 */
export async function ensureArtifactFolder(store, task) {
  const state = store.snapshot()
  const requirement = state.requirements.find(item => item.id === task.requirementId)
  if (requirement !== undefined) {
    return { folder: await ensureReqFolder(store, requirement.id), requirement }
  }
  const cached = state.fallbackFolder ?? {}
  if (String(cached.token ?? '').trim().length > 0) return { folder: cached, requirement: undefined }
  const parent = String(state.config.feishu.driveFolder ?? '').trim()
  if (parent === '') throw new Error('还没配置飞书云盘根文件夹（设置 → 飞书 · 云盘根文件夹）')
  const name = '未挂需求的产物'
  const created = await larkJson(['drive', '+create-folder', '--folder-token', parent, '--name', name], 45000)
  if (!created.ok) throw new Error(created.error)
  const folder = {
    token: String(created.data.folder_token ?? ''),
    url: String(created.data.url ?? ''),
    name: String(created.data.name ?? name),
    at: Date.now(),
    error: '',
  }
  await store.mutate(draft => { draft.fallbackFolder = folder })
  return { folder, requirement: undefined }
}

/** 把一条交付物写进需求的云盘文件夹（首次创建、之后覆盖）。 */
async function syncArtifactToFeishu(store, taskId, artifactId) {
  const state = store.snapshot()
  const task = state.tasks.find(item => item.id === taskId)
  if (task === undefined) throw new Error(`no task ${taskId}`)
  const artifact = (task.artifacts ?? []).find(item => item.id === artifactId)
  if (artifact === undefined) throw new Error(`no artifact ${artifactId}`)
  /* 建文件夹失败必须落库（issue #113）：ensureArtifactFolder 自己会 throw
     （没配根文件夹 / lark 缺 scope 都走这条路），以前那条 throw 直接绕过下面的判空，
     artifact.doc.error 一直是空串，看板上跟「已归档」没区别。这里把两种失败都兜住。 */
  const markDocError = async reason => {
    const textReason = String(reason ?? '创建云盘文件夹失败').slice(0, 300)
    await store.mutate(draft => {
      const row = (draft.tasks.find(item => item.id === task.id)?.artifacts ?? []).find(item => item.id === artifact.id)
      if (row !== undefined) row.doc = { ...(row.doc ?? {}), token: '', url: '', name: '', at: Date.now(), error: textReason }
    })
    return textReason
  }
  let folder = null
  let requirement
  try {
    const ensured = await ensureArtifactFolder(store, task)
    folder = ensured.folder
    requirement = ensured.requirement
  } catch (error) {
    throw new Error(await markDocError(error?.message ?? error))
  }
  /* 建文件夹失败必须落库（issue #113）：以前只 throw，artifact.doc.error 留在空串，
     看板上这件交付物长得跟「已归档」一样，事后完全看不出它没进云盘。 */
  if (String(folder.token ?? '').trim() === '') {
    throw new Error(await markDocError(folder.error ?? '创建云盘文件夹失败'))
  }
  // 按产物类型落到子文件夹（01 需求文档 / 02 设计文档 …）；子文件夹没建好就退回需求根目录
  let target = folder
  let kindError = ''
  if (requirement !== undefined && String(artifact.kind ?? '') !== '') {
    try {
      const kindFolder = await ensureKindFolder(store, requirement.id, artifact.kind, larkJson)
      if (String(kindFolder.token ?? '').trim() !== '') target = { ...folder, ...kindFolder }
    } catch (error) {
      // 建子目录失败不该让整条交付物同步失败（退回需求根目录），但**原因必须留下**：
      // 以前这里是个空 catch，真机上「产物没进 01 需求文档」查了半天没头绪。
      kindError = String(error?.message ?? error).slice(0, 200)
    }
  }
  const name = artifactFileName(task, artifact)
  const filled = { ...artifact, content: await artifactBody(task, artifact, state.config) }
  const body = artifactMarkdown(task, filled, requirement)
  const tmpDir = join(host.dshHomePath('tmp'), `artifact-${artifact.id}`)
  await mkdir(tmpDir, { recursive: true })
  // lark-cli 用本地文件名当远端文件名（--name 在 --file 模式下会被忽略），
  // 所以这里把临时文件直接命名成最终文档名。
  const tmpFile = join(tmpDir, name)
  await writeFile(tmpFile, body, 'utf8')
  // lark-cli 只允许读写「当前工作目录子树」里的文件；传入绝对路径会被判成 unsafe file path。
  // 参数形状由 lark-upload.js 统一生成（cwd = 临时目录，--file 只给文件名）。
  const uploadFor = existing => larkUploadArgs({ dir: tmpDir, name, existing, folderToken: target.token })
  try {
    const existing = String(artifact.doc?.token ?? '').trim()
    const upload = uploadFor(existing)
    let result = await larkJson(upload.args, 45000, { cwd: upload.cwd })
    /* 缓存的文件夹 token 从不校验（ensureRequirementFolder 只看 token 非空就复用），
       文件夹在飞书那边被删掉之后，这里会一直撞 "parent node not exist"，归档永远失败。
       自愈：遇到这类「父节点不存在」就**作废缓存并重试一次**（重建文件夹再传）。 */
    if (!result.ok && /parent node not exist|1061044|not_found/i.test(String(result.error ?? ''))) {
      await store.mutate(draft => {
        const target = draft.requirements.find(item => item.id === task.requirementId)
        if (target !== undefined) target.folder = { token: '', url: '', name: '', at: 0, error: '文件夹已不存在，已作废缓存准备重建' }
        draft.fallbackFolder = null
      })
      const rebuilt = await ensureArtifactFolder(store, task)
      const retryTarget = rebuilt.folder
      if (String(retryTarget.token ?? '').trim() !== '') {
        target = retryTarget
        const retry = uploadFor(existing)
        result = await larkJson(retry.args, 45000, { cwd: retry.cwd })
      }
    }
    /* 覆盖失败也自愈：doc.token 指向的文件可能随文件夹一起被删了，
       这时 +overwrite 会一直报 unknown error。降级成「新建一份」并刷新 token。 */
    if (!result.ok && existing !== '') {
      const fresh = uploadFor('')
      const created = await larkJson(fresh.args, 45000, { cwd: fresh.cwd })
      if (created.ok) result = created
    }
    if (!result.ok) {
      await store.mutate(draft => {
        const target = draft.tasks.find(item => item.id === taskId)?.artifacts?.find(item => item.id === artifactId)
        if (target !== undefined) target.doc = { ...(target.doc ?? {}), error: result.error.slice(0, 300) }
      })
      throw new Error(result.error)
    }
    const doc = {
      token: String(result.data.file_token ?? existing),
      url: String(result.data.url ?? artifact.doc?.url ?? ''),
      name: String(result.data.file_name ?? artifact.doc?.name ?? name),
      at: Date.now(),
      error: kindError,
    }
    await store.mutate(draft => {
      const target = draft.tasks.find(item => item.id === taskId)?.artifacts?.find(item => item.id === artifactId)
      if (target !== undefined) {
        target.doc = doc
        // 正文是从 ref 文件读回来的话，落回交付物本身：
        // 看板上要能看到「正文 N 字」，下次同步也不必再读一次磁盘。
        if (String(target.content ?? '').trim() === '' && filled.content.trim() !== '') {
          target.content = filled.content.slice(0, 60000)
        }
      }
    })
    return doc
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}
/** 按出口配置投递一条交付物：分发在 doc-sync.js，这里只注入本地能力（默认 feishu，返回值与老版本一致）。 */
export function syncArtifact(store, taskId, artifactId) {
  const buildMarkdown = async (t, a, c, r) => artifactMarkdown(t, { ...a, content: await artifactBody(t, a, c) }, r)
  return syncArtifactImpl(store, taskId, artifactId, { writeFeishu: syncArtifactToFeishu, buildMarkdown })
}
/** 一条需求下所有没归档（或归档失败的）交付物，批量写进云盘。 */
export async function syncRequirementArtifacts(store, requirementId) {
  const state = store.snapshot()
  const tasks = state.tasks.filter(task => task.requirementId === requirementId)
  const report = { total: 0, written: 0, failed: 0, errors: [] }
  for (const task of tasks) {
    for (const artifact of task.artifacts ?? []) {
      report.total += 1
      try {
        await syncArtifact(store, task.id, artifact.id)
        report.written += 1
      } catch (error) {
        report.failed += 1
        if (report.errors.length < 5) report.errors.push(`${task.code || task.id} / ${artifact.title}：${String(error?.message ?? error).slice(0, 160)}`)
      }
    }
  }
  return report
}

/** 回滚时给文档版本号 +1：v1.0 → v1.1；已经是 -rN 的就继续 +1。 */
function bumpDocVersion(version) {
  const text = String(version ?? '').trim()
  const plain = /^v(\d+)\.(\d+)$/.exec(text)
  if (plain !== null) return 'v' + plain[1] + '.' + (Number(plain[2]) + 1)
  const rolled = /-r(\d+)$/.exec(text)
  if (rolled !== null) return text.replace(/-r\d+$/, '-r' + (Number(rolled[1]) + 1))
  return (text === '' ? 'v1.0' : text) + '-r1'
}

/** 需求文档的增删改与「评审通过、冻结为基线」。 */
export async function mutateReqDoc(store, body) {
  const requirementId = String(body.id ?? '')
  const action = String(body.action ?? 'add')
  const docId = String(body.docId ?? '')
  let saved
  await store.mutate(state => {
    const requirement = state.requirements.find(item => item.id === requirementId)
    if (requirement === undefined) throw new Error(`no requirement ${requirementId}`)
    if (!Array.isArray(requirement.docs)) requirement.docs = []
    if (action === 'add') {
      const doc = sanitizeReqDoc(body.doc ?? {}, requirement.docs.length)
      if (doc === undefined) throw new Error('文档要有标题')
      requirement.docs.push(doc)
    } else if (action === 'update') {
      const target = requirement.docs.find(item => item.id === docId)
      if (target === undefined) throw new Error(`no doc ${docId}`)
      Object.assign(target, sanitizeReqDoc({ ...target, ...(body.doc ?? {}), id: target.id }))
    } else if (action === 'remove') {
      requirement.docs = requirement.docs.filter(item => item.id !== docId)
      if (requirement.baseline !== null && requirement.baseline !== undefined && requirement.baseline.docId === docId) {
        requirement.baseline = null
      }
    } else if (action === 'baseline') {
      const target = requirement.docs.find(item => item.id === docId)
      if (target === undefined) throw new Error(`no doc ${docId}`)
      for (const doc of requirement.docs) doc.status = doc.id === docId ? 'baseline' : (doc.status === 'baseline' ? 'draft' : doc.status)
      requirement.baseline = sanitizeBaseline({
        docId: target.id,
        title: target.title,
        version: target.version,
        content: target.content,
        at: Date.now(),
        by: String(body.by ?? '人').slice(0, 40),
      })
      if (requirement.status === 'draft') requirement.status = 'active'
    } else if (action === 'rollback') {
      // 回到基线正文：版本号 +1、签字作废、留一条历史——回滚是实质变更，不能悄悄改。
      const baseline = requirement.baseline
      if (baseline === null || baseline === undefined) throw new Error('这条需求还没有基线，先挑一份文档「设为基线」再回滚')
      const target = requirement.docs.find(item => item.id === baseline.docId) ?? requirement.docs[0]
      if (target === undefined) throw new Error('基线对应的文档已经删了，没法回滚')
      const by = String(body.by ?? '人').trim().slice(0, 40) || '人'
      const previousVersion = String(target.version ?? '')
      target.content = baseline.content
      target.version = bumpDocVersion(target.version)
      target.status = 'baseline'
      target.at = Date.now()
      for (const doc of requirement.docs) if (doc.id !== target.id && doc.status === 'baseline') doc.status = 'draft'
      requirement.baseline = sanitizeBaseline({ ...baseline, version: target.version, content: target.content, at: Date.now(), by })
      const hadSignoff = requirement.signoff !== null && requirement.signoff !== undefined
      requirement.signoff = null
      requirement.history = [...(requirement.history ?? []), {
        at: Date.now(),
        by,
        field: 'PRD 回滚',
        from: previousVersion,
        to: baseline.version,
        note: hadSignoff ? '回滚到基线，原验收签字作废' : '回滚到基线',
      }]
    } else if (action === 'clear-baseline') {
      requirement.baseline = null
      for (const doc of requirement.docs) if (doc.status === 'baseline') doc.status = 'review'
    } else {
      throw new Error(`unknown action ${action}`)
    }
    requirement.updatedAt = Date.now()
    saved = safeClone(requirement)
  })
  return saved
}

/** 编辑版本冲突：调用方基于的版本已经不是最新的了。
 *
 *  为什么要有：以前两人同时改一张卡，后写的**静默覆盖**前一个——
 *  谁改的、改掉了什么，事后一点痕迹都没有（产品定义第 6 条验收标准）。 */
export class VersionConflictError extends Error {
  constructor(message, current) {
    super(message)
    this.name = 'VersionConflictError'
    this.code = 'version_conflict'
    this.current = current
  }
}

/** Update one task. */
export async function updateTask(store, id, patch) {
  const normalized = normalizePatch(patch)
  // 乐观锁：调用方给 ifVersion 就按「卡片的编辑版本」比对，不给就保持老行为（兼容面板与 agent）。
  const ifVersion = Number.isInteger(Number(patch?.ifVersion)) ? Number(patch.ifVersion) : null
  const blockFlag = normalized.blocked
  delete normalized.blocked
  const override = normalized.override ?? ''
  delete normalized.override
  const blockReason = text(patch.blockedReason, 500)
  if (normalized.status === 'done' && override === '') {
    const current = store.snapshot().tasks.find(entry => entry.id === id)
    if (current !== undefined) {
      const simulated = { ...current, ...normalized, blocked: current.blocked }
      const gate = taskExitGate(store.snapshot(), simulated)
      if (!gate.ready) {
        emitEvent('gate/blocked', { taskId: id, gate: 'exit', blockers: gate.blockers.slice(0, 3) })
        throw new Error(`准出没过：${gate.blockers.join('；')}。确实要收口就在推进时填 override 写明原因。`)
      }
    }
  }
  if (normalized.status !== undefined && override === '') {
    // 设计闸门：开了开关的项目，进开发列之前设计必须评审通过。
    const current = store.snapshot().tasks.find(entry => entry.id === id)
    if (current !== undefined) {
      const gate = designGate(store.snapshot().config, current, normalized.status)
      if (gate.needed === true && gate.ready !== true) {
        emitEvent('gate/blocked', { taskId: id, gate: 'design', blockers: gate.blockers.slice(0, 3) })
        throw new Error(`进开发被拦：${gate.blockers.join('；')}`)
      }
      // 闸门关着也要留痕（判定在 design.js 里，executor 这边只落一行历史）
      const offNote = designGateOffNote(store.snapshot().config, normalized.status, current.status)
      if (offNote !== '') current.history = [...(current.history ?? []), { at: Date.now(), by: text(patch.by, 60) ?? 'agent', status: normalized.status, note: offNote }]
      /* 评审闸门（默认开）：进「待测试」之前代码评审必须有结论。
         以前只有「已完成」的准出看 review，于是待评审→待测试直接放行（issue #9 第 3 条）。 */
      const review = reviewGate(store.snapshot().config, current, normalized.status)
      if (review.needed === true && review.ready !== true) {
        emitEvent('gate/blocked', { taskId: id, gate: 'review', blockers: review.blockers.slice(0, 3) })
        throw new Error(`进测试被拦：${review.blockers.join('；')}`)
      }
    }
  }
  let result
  let moved = null
  let blocking = null
  const by = text(patch.by, 60) ?? 'agent'
  await store.mutate(state => {
    const task = state.tasks.find(t => t.id === id)
    if (task === undefined) throw new Error(`no task ${id}`)
    if (ifVersion !== null && (Number(task.version) || 0) !== ifVersion) {
      throw new VersionConflictError(
        `这张卡已经被改过（当前版本 ${Number(task.version) || 0}，你基于 ${ifVersion}）：刷新后重做这次修改`,
        JSON.parse(JSON.stringify(task)),
      )
    }
    const previous = task.status
    const previousRequirement = task.requirementId ?? ''
    Object.assign(task, normalized)
    // 编辑版本：任何一次成功的 update 都 +1，供调用方下次带 ifVersion 做乐观锁。
    task.version = (Number(task.version) || 0) + 1
    task.updatedAt = Date.now()
    // 服务必须属于它挂的项目：换项目或服务被删掉时，把失效的服务 id 清掉。
    if (String(task.service ?? '') !== '') {
      const owner = (state.config.projects ?? []).find(entry => entry.id === task.project)
      if (owner === undefined || !(owner.services ?? []).some(entry => entry.id === task.service)) task.service = ''
    }
    // 换需求就要换编号：同一需求下 DEV-001 只出现一次。
    if (normalized.requirementId !== undefined && normalized.requirementId !== previousRequirement) {
      task.code = normalized.requirementId === ''
        ? ''
        : nextTaskCode(state.tasks, normalized.requirementId, CODE_PREFIX[task.type] ?? 'TASK')
    }
    if (blockFlag === true && (task.blocked === null || task.blocked === undefined)) {
      task.blocked = {
        at: task.updatedAt,
        by,
        reason: blockReason ?? text(task.blockedReason, 500) ?? '',
      }
      task.blockedReason = task.blocked.reason
      task.history.push({ at: task.updatedAt, by, status: task.status, note: 'blocked' })
      blocking = 'blocked'
    } else if (blockFlag === false && task.blocked !== null && task.blocked !== undefined) {
      task.blocked = null
      task.blockedReason = ''
      task.history.push({ at: task.updatedAt, by, status: task.status, note: 'unblocked' })
      blocking = 'unblocked'
    }
    // 换列时负责人会被这一列的默认负责人覆盖，团队记忆要用「换列前」的那个人去认团。
    const expertBefore = task.expert
    if (normalized.status !== undefined) {
      if (override !== '') task.override = { by, at: Date.now(), reason: String(override).slice(0, 300) }
    task.history.push({ at: task.updatedAt, by, status: normalized.status, ...(override !== '' ? { note: `override：${override}` } : {}) })
      // 缺陷从「已完成」被打回去 = 重开，重开次数是质量信号（谁的老毛病又犯了）。
      if (task.type === 'bug' && previous === 'done' && normalized.status !== 'done') {
        task.reopenCount = (Number(task.reopenCount) || 0) + 1
      }
      // 人把卡推进到别的列，就意味着「解除阻塞、继续走」。
      if (task.blocked !== null && task.blocked !== undefined) {
        task.blocked = null
        task.blockedReason = ''
        task.history.push({ at: task.updatedAt, by, status: normalized.status, note: 'unblocked' })
        blocking = 'unblocked'
      }
      // The role and the owning expert follow the column unless named explicitly.
      const column = STATUSES.find(entry => entry.id === normalized.status)
      if (column !== undefined) {
        if (normalized.role === undefined) task.role = column.role
        if (normalized.expert === undefined) {
          const owner = state.config.columns?.[column.id]
          // 列负责人是「候选池且没指定 id」时（现有八列全是这种），不要用空串覆盖卡上的人——
          // 否则每次换列都会把负责人清空，质量度量的「卡数」也跟着失真。
          if (owner !== undefined) {
            if (typeof owner.id === 'string' && owner.id !== '') task.expert = owner.id
            else if (owner.kind === 'none') task.expert = ''
          }
        }
      }
      if (previous !== task.status) {
        moved = { from: previous, to: task.status, task: safeClone(task), by, expertBefore }
        emitEvent('task/moved', { taskId: task.id, code: task.code ?? '', title: task.title, from: previous, to: task.status, by, expert: task.expert ?? '' })
      }
    }
    result = task
  })
  if (moved !== null) {
    // 卡进「完成」：把这条经验记进它所属专家团的团队记忆（下次派活会带进提示词）。
    if (moved.to === 'done') {
      try {
        const snapshot = store.snapshot()
        const owner = snapshot.config?.columns?.[moved.to] ?? {}
        const teams = snapshot.config?.teams ?? []
        const ownerId = owner.kind === 'team' ? String(owner.id ?? '') : ''
        const expertId = String(moved.expertBefore ?? result.expert ?? '')
        const hit = ownerId !== ''
          ? teams.find(team => team.id === ownerId)
          : teams.find(team => (team.members ?? []).includes(expertId) || team.lead === expertId)
        if (hit !== undefined) {
          await appendTeamMemory(store, hit.id, {
            taskId: result.id,
            title: result.title,
            outcome: result.type === 'bug' ? '修完的缺陷' : '做完的卡',
            note: String(result.signoff?.note ?? '').slice(0, 200),
          })
        }
      } catch {
        /* 记不下团队记忆不能影响卡推进 */
      }
    }
    try { host.broadcastChange(store, moved.task, moved.from, moved.to, moved.by) } catch (error) {
      host.INTEGRATION.lastPushError = String(error?.message ?? error).slice(0, 300)
    }
    // 缺陷卡修好进「待测试」＝触发回归：把来源用例重置成待执行。
    if (moved.to === 'test' && result.bugSource != null) {
      try { await host.resetOriginCase(store, result) } catch (error) {
        host.INTEGRATION.lastPushError = String(error?.message ?? error).slice(0, 300)
      }
    }
  }
  if (blocking !== null) {
    try { host.broadcastChange(store, result, result.status, result.status, by, blocking) } catch (error) {
      host.INTEGRATION.lastPushError = String(error?.message ?? error).slice(0, 300)
    }
  }
  // 卡进「待评审」时自动核对一次代码事实：AI 说改了什么，仓库里得真有。
  if (moved !== null && moved.to === 'review') {
    // 没登记执行记录就先从 git 补一条（否则「看不到改动的代码」永远修不好），再做事实核对。
    await autoCollectCoding(store, id).catch(() => {})
    await autoVerifyCoding(store, id).catch(() => {})
  }
  // 版本号在上面那次 mutate 里已经 +1（不再额外写一次盘）。
  return store.snapshot().tasks.find(t => t.id === id) ?? result
}

/** Append a comment and report who it @mentioned. */
/** 把「架构」「🏛️ 架构师」「研发」这类历史写法收敛成专家本名，老数据与新写入都受益。 */

export async function commentTask(store, id, body, author, kind) {
  const content = text(body, 20000)
  if (content === undefined) throw new Error('body is required')
  const explicit = kind === 'human' || kind === 'agent' ? kind : undefined
  let result
  let mentions = []
  await store.mutate(state => {
    const task = state.tasks.find(t => t.id === id)
    if (task === undefined) throw new Error(`no task ${id}`)
    const who = canonicalAuthor(text(author, 60) ?? 'agent', state.config)
    // 没显式声明来源时，按作者判断：命中专家名册或像角色名的是 AI，其余算人。
    const origin = explicit ?? ((state.config?.experts ?? []).some(entry => {
      const name = String(entry.name ?? '')
      return name !== '' && (name === who || who.includes(name) || name.includes(who))
    }) || /产品|架构|研发|开发|测试|运维|专家/.test(who) ? 'agent' : 'human')
    task.comments.push({
      id: `c-${randomBytes(3).toString('hex')}`,
      at: Date.now(),
      author: who,
      kind: origin,
      body: content,
    })
    task.updatedAt = Date.now()
    mentions = parseMentions(content, state.config)
    result = task
  })
  return { task: result, mentions }
}


// ------------------------------------------------- 用例生成：草稿 vs 可执行断言

/** 按需求的「功能点 + 验收条件」推导用例草稿。
 *  注意：这里只能推标题（没有断言），所以产出的都是 draft —— 真正的断言要模型在会话里写，
 *  通过 addAssertedCases 落库。见 docs/product.md §5.1。 */
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

/** 模板生成：一条验收条件 = 一条用例。断言靠规则推断，推不出来就标 draft。 */
export async function addDraftCases(store, taskId, by = '人') {
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
      /* 以前这里写死 http: null —— 生成的用例**永远不可执行**（全库 101 条 0 可执行就是这么来的）。
         现在从验收条件里推断：有 URL 就生成接口用例，允许 shell 且有命令行就生成 shell 用例，
         推不出来的明确标 draft（不计入覆盖率），而不是假装它是一条"用例"。 */
      const inferred = draftCasesFromCriteria([item.expected || item.title], { allowShell: state.config?.testing?.allowShell === true })[0] ?? {}
      entry.cases.push({
        id: `c-${randomBytes(3).toString('hex')}`,
        title: item.title,
        expected: item.expected,
        result: 'pending',
        note: '',
        pointId: item.pointId,
        by,
        at: Date.now(),
        http: inferred.http ?? null,
        shell: inferred.shell ?? null,
        draft: inferred.draft === true,
        lastRun: null,
      })
      added += 1
    }
    entry.updatedAt = Date.now()
  })
  const after = store.snapshot().tasks.find(item => item.id === taskId)
  return { added, total: (after?.cases ?? []).length, reason: '' }
}

/** 把专家写好的**可执行**用例落库，并当场试跑第一条。
 *
 * 为什么要在生成这一刻跑：「用例全绿」曾经什么都不代表 —— 全库 101 条用例 0 条带断言，
 * 谁也不知道哪一条真的验过。让写坏的用例当场失败，比攒成一百条草稿有用得多。
 *
 * 全有或全无：只要有一条不合法就整体拒绝并列出原因，不把能跑的和跑不了的混在一起存进去。
 * 地址支持相对路径（用测试环境 baseUrl 解析），存回去时保持原样，环境换了不用改用例。
 */
export async function addAssertedCases(store, taskId, rawCases, options = {}) {
  const by = text(options.by, 40) ?? '测试专家'
  const list = Array.isArray(rawCases) ? rawCases : []
  if (list.length === 0) throw new Error('cases 是空的：至少给一条带断言的用例')
  const before = store.snapshot()
  const task = before.tasks.find(item => item.id === String(taskId ?? ''))
  if (task === undefined) throw new Error(`no task ${taskId}`)
  const testing = before.config?.testing ?? {}
  const envs = Array.isArray(testing.envs) ? testing.envs : []
  const wanted = String(options.env ?? testing.defaultEnv ?? '')
  const env = envs.find(item => item.id === wanted) ?? envs[0]
  const allowShell = testing.allowShell === true

  const prepared = []
  const rejected = []
  for (const [index, raw] of list.entries()) {
    const item = raw !== null && typeof raw === 'object' ? raw : {}
    const title = text(item.title, 200)
    if (title === undefined) {
      rejected.push(`第 ${index + 1} 条没有标题`)
      continue
    }
    const expected = text(item.expected, 300) ?? title
    const expectContains = String(item.expectContains ?? '').trim().slice(0, 300)
    /* 测试层级：写就按写的（unit / integration / e2e / other），不写留空由 test-plan.js 按断言推断。 */
    const tier = sanitizeTier(item.tier)
    const path = String(item.path ?? item.url ?? '').trim()
    if (path !== '') {
      const method = String(item.method ?? '').trim().toUpperCase()
      if (!CASE_HTTP_METHODS.includes(method)) {
        rejected.push(`「${title}」的 method「${String(item.method ?? '')}」不认识：只认 ${CASE_HTTP_METHODS.join('/')}`)
        continue
      }
      const absolute = /^https?:\/\//i.test(path)
      if (!absolute && String(env?.baseUrl ?? '').trim() === '') {
        rejected.push(`「${title}」只给了相对地址 ${path}，但还没配测试环境 baseUrl：补上环境，或者写完整地址`)
        continue
      }
      if (!absolute) {
        try {
          const probe = new URL(path, String(env.baseUrl).trim())
          if (probe.protocol !== 'http:' && probe.protocol !== 'https:') throw new Error(probe.protocol)
        } catch {
          rejected.push(`「${title}」的地址 ${path} 拼上环境 baseUrl 也不是合法的 http(s) 地址`)
          continue
        }
      }
      const expectStatus = Number(item.expectStatus)
      if (!Number.isInteger(expectStatus) || expectStatus < 100 || expectStatus > 599) {
        rejected.push(`「${title}」必须给期望状态码 expectStatus（100–599）：不给的话跑完也判不出对错`)
        continue
      }
      prepared.push({
        title,
        expected,
        tier,
        pointId: String(item.pointId ?? '').slice(0, 24),
        acceptanceId: String(item.acceptanceId ?? '').slice(0, 24),
        http: { method, url: path.slice(0, 500), body: String(item.body ?? '').slice(0, 8000), expectStatus, expectContains, headers: item.headers },
      })
      continue
    }
    const browserSpec = sanitizeCaseBrowser(item.browser)
    if (browserSpec !== null) {
      if (testing.allowBrowser !== true) {
        rejected.push(`「${title}」是浏览器用例，但设置里没开 allowBrowser（设置 → 测试执行）`)
        continue
      }
      const target = String(browserSpec.url ?? '').trim()
      if (target === '') {
        rejected.push(`「${title}」是浏览器用例但没有地址（url / path）`)
        continue
      }
      if (!/^https?:\/\//i.test(target) && String(env?.baseUrl ?? '').trim() === '') {
        rejected.push(`「${title}」只给了相对地址 ${target}，但还没配测试环境 baseUrl：补上环境，或者写完整地址`)
        continue
      }
      prepared.push({ title, expected, tier, pointId: String(item.pointId ?? '').slice(0, 24), acceptanceId: String(item.acceptanceId ?? '').slice(0, 24), browser: browserSpec })
      continue
    }
    const dbSpec = sanitizeDbCase(item.db)
    if (dbSpec !== null) {
      if (testing.allowDb !== true) {
        rejected.push(`「${title}」是数据库用例，但设置里没开 allowDb（设置 → 测试执行）`)
        continue
      }
      prepared.push({ title, expected, tier, pointId: String(item.pointId ?? '').slice(0, 24), acceptanceId: String(item.acceptanceId ?? '').slice(0, 24), db: dbSpec })
      continue
    }
    const command = String(item.command ?? '').trim()
    if (command !== '') {
      if (!allowShell) {
        rejected.push(`「${title}」是 shell 用例，但设置里没开 allowShell（设置 → 测试执行）`)
        continue
      }
      // 字段名以 shell-case.js 为准：expectExit。老调用方写 expectExitCode 也认，避免再踩一次同名不同字的坑。
      const rawExit = item.expectExit ?? item.expectExitCode
      const expectExit = Number.isInteger(Number(rawExit)) ? Number(rawExit) : 0
      prepared.push({
        title,
        expected,
        tier,
        pointId: String(item.pointId ?? '').slice(0, 24),
        acceptanceId: String(item.acceptanceId ?? '').slice(0, 24),
        shell: {
          command: command.slice(0, 2000),
          cwd: String(item.cwd ?? '').slice(0, 300),
          expectExit,
          expectContains: String(item.expectContains ?? '').slice(0, 500),
          expectNotContains: String(item.expectNotContains ?? '').slice(0, 500),
        },
      })
      continue
    }
    rejected.push(`「${title}」既没有 path（接口）、command（shell）、db（数据库）也没有 browser（浏览器）：这条跑不了，等于又一条草稿`)
  }
  if (rejected.length > 0) {
    const shown = rejected.slice(0, 5).join('；')
    const more = rejected.length > 5 ? `；另有 ${rejected.length - 5} 条同样不合法` : ''
    throw new Error(`${rejected.length}/${list.length} 条用例不合法，一条都没写进去：${shown}${more}`)
  }

  const existingTitles = new Set((task.cases ?? []).map(item => String(item.title ?? '')))
  /* 没写 pointId 就继承卡的功能点：一个功能点通常多条用例，让调用方每条都重复写一遍纯属噪音。
     想看「这条用例到底覆盖哪个功能点」的人，读到的就是卡上的那个（issue #11）。 */
  for (const item of prepared) {
    if (String(item.pointId ?? '') === '') item.pointId = String(task.pointId ?? '')
  }
  /* 同名空壳**原地升级**，不再追加一条重复用例：以前只按标题完全相等去重，于是
     「a1 正常除法」和「a1 正常除法（可执行）」会并存 —— 真机四棒接力就这样在 15 条里塞了 7 条
     永远跑不了的草稿，把需求级「可执行覆盖率 ≥60%」拖到 53%。保留原 id / 功能点 / 验收条件。 */
  const draftByKey = new Map((task.cases ?? [])
    .filter(item => !isExecutable(item))
    .map(item => [normalizeCaseTitle(item.title), item]))
  const upgrades = []
  const fresh = []
  for (const item of prepared) {
    if (existingTitles.has(item.title)) continue
    const key = normalizeCaseTitle(item.title)
    const target = key === '' ? undefined : draftByKey.get(key)
    if (target !== undefined) {
      upgrades.push({ target, item })
      continue
    }
    fresh.push(item)
  }
  if (fresh.length === 0 && upgrades.length === 0) {
    return { added: 0, upgraded: 0, skipped: prepared.length, total: (task.cases ?? []).length, verified: null, env: null }
  }
  const ids = []
  const upgradedIds = []
  await store.mutate(state => {
    const entry = state.tasks.find(item => item.id === task.id)
    for (const { target, item } of upgrades) {
      upgradedIds.push(target.id)
      entry.cases = entry.cases.map(existing => {
        if (existing.id !== target.id) return existing
        return sanitizeCase({
          ...existing,
          title: stripExecutableMarker(item.title) || existing.title,
          expected: item.expected !== '' ? item.expected : existing.expected,
          result: 'pending',
          tier: item.tier !== '' ? item.tier : existing.tier,
          pointId: item.pointId !== '' ? item.pointId : existing.pointId,
          acceptanceId: item.acceptanceId !== '' ? item.acceptanceId : existing.acceptanceId,
          note: `由草稿升级为可执行（原结果 ${existing.result} 作废）`,
          draft: false,
          by,
          at: Date.now(),
          http: item.http ?? null,
          shell: item.shell ?? null,
          db: item.db ?? null,
          browser: item.browser ?? null,
          lastRun: null,
        }, 0)
      })
    }
    for (const [index, item] of fresh.entries()) {
      const id = `c-${randomBytes(3).toString('hex')}`
      ids.push(id)
      // 过一遍 sanitizeCase：写进内存的形状必须和重启后从磁盘读出来的形状一样，
      // 否则「跑一次对、重启后字段名变了」这类问题查起来极难（shell 的 expectExit 就是这么撞出来的）。
      const saved = sanitizeCase({
        id,
        title: item.title,
        expected: item.expected,
        result: 'pending',
        tier: item.tier ?? '',
        pointId: item.pointId,
        acceptanceId: item.acceptanceId ?? '',
        by,
        at: Date.now(),
        http: item.http ?? null,
        shell: item.shell ?? null,
        db: item.db ?? null,
        browser: item.browser ?? null,
      }, index)
      entry.cases.push(saved)
    }
    entry.updatedAt = Date.now()
  })

  // 当场试跑第一条：新用例优先，没有新的就试跑刚升级的那条。跑不通就在这里暴露，而不是等谁来点「▶ 跑」。
  const created = (store.snapshot().tasks.find(item => item.id === task.id)?.cases ?? []).filter(item => [...ids, ...upgradedIds].includes(item.id))
  const first = created[0]
  let verified = null
  if (first !== undefined) {
    const needsEnv = first.http != null || (first.browser != null && /^https?:\/\//i.test(String(first.browser.url ?? '')) !== true)
    if (needsEnv && env === undefined) {
      verified = { id: first.id, title: first.title, ok: false, status: 0, ms: 0, error: '还没有配置测试环境（设置 → 测试执行）' }
    } else {
      try {
        const outcome = await runOneCase(first, env, before.config)
        verified = {
          id: first.id,
          title: first.title,
          ok: outcome.ok === true,
          status: Number(outcome.status) || 0,
          ms: Number(outcome.ms) || 0,
          error: String(outcome.error ?? '').slice(0, 300),
        }
      } catch (error) {
        verified = { id: first.id, title: first.title, ok: false, status: 0, ms: 0, error: String(error?.message ?? error).slice(0, 300) }
      }
      const note = verified.ok
        ? `生成时试跑：${String(first.http?.method ?? 'shell')} ${String(first.http?.url ?? first.shell?.command ?? '')} → ${verified.status}（${verified.ms}ms）`
        : `生成时试跑失败：${verified.error}`
      await store.mutate(state => {
        const entry = state.tasks.find(item => item.id === task.id)
        if (entry === undefined) return
        entry.cases = entry.cases.map(c => (c.id === verified.id
          ? { ...c, result: verified.ok ? 'pass' : 'fail', note: note.slice(0, 400), by, at: Date.now(), lastRun: { at: Date.now(), ok: verified.ok, status: verified.status, ms: verified.ms, error: verified.error, preview: '', response: '', env: String(env?.id ?? ''), steps: [] } }
          : c))
        entry.updatedAt = Date.now()
      })
    }
  }

  const after = store.snapshot().tasks.find(item => item.id === task.id)
  const total = (after?.cases ?? []).length
  return {
    added: fresh.length,
    upgraded: upgrades.length,
    skipped: prepared.length - fresh.length - upgrades.length,
    total,
    verified,
    env: env === undefined ? null : { id: env.id, name: env.name, baseUrl: env.baseUrl },
    strength: coverageStrength(after?.cases ?? []),
    /* 三层测试的当前进度与缺口：工具回报里直接给，专家不用再猜「还差哪一层」。 */
    plan: testPlanSummary(after?.cases ?? [], after?.testPlan),
  }
}
