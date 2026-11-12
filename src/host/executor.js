// -------------------------------------------------- 执行记录与接口测试执行器（P4）
// 代码事实核对、用例执行、缺陷回流、健康检查。宿主级依赖通过 configureExecutor() 注入。

import { CODE_PREFIX, ROLE_IDS, STATUS_IDS, STATUSES, nextRequirementCode, nextTaskCode, normalizePatch, sanitizeBaseline, sanitizeReqDoc, sanitizeRequirement, sanitizeTestRun, text } from './domain.js'
import { RUN_LOG, parseMentions } from './dispatcher.js'
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

/** 允许打的 host：精确匹配，或 `*.example.com` 这种子域通配。 */
export function hostAllowed(host, allowHosts) {
  const target = String(host ?? '').toLowerCase()
  if (target.length === 0) return false
  for (const rule of allowHosts) {
    if (rule === '*') return true
    if (rule.startsWith('*.')) {
      const tail = rule.slice(1)
      if (target.endsWith(tail) && target.length > tail.length) return true
      continue
    }
    if (target === rule) return true
  }
  return false
}

/** 把用例里的相对 URL 拼成绝对地址；不允许的 host 直接抛。 */
export function resolveCaseUrl(http, env, config) {
  const raw = String(http?.url ?? '').trim()
  if (raw.length === 0) throw new Error('这条用例没有配请求地址')
  let url
  try {
    url = new URL(raw, env.baseUrl)
  } catch {
    throw new Error(`请求地址不合法：${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`只允许 http/https：${url.protocol}`)
  }
  if (!hostAllowed(url.hostname, config.testing.allowHosts)) {
    throw new Error(`host ${url.hostname} 不在允许列表里（设置 → 测试执行 → 允许访问的域名）`)
  }
  return url
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

export async function runOneCase(item, env, config, seedVars) {
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
    const headers = { ...env.headers }
    for (const [key, value] of Object.entries(item.http.headers ?? {})) headers[key] = substituteVars(value, vars)
    const init = { method: step.method, headers, signal: AbortSignal.timeout(timeout) }
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
  const envs = config.testing.envs
  if (envs.length === 0) throw new Error('还没有配置测试环境（设置 → 测试执行）')
  const envId = String(options.env ?? config.testing.defaultEnv ?? '')
  const env = envs.find(item => item.id === envId) ?? envs[0]
  const wanted = Array.isArray(options.caseIds) && options.caseIds.length > 0
    ? new Set(options.caseIds.map(id => String(id)))
    : null
  const targets = (Array.isArray(task.cases) ? task.cases : [])
    .filter(item => (wanted === null ? item.http != null : wanted.has(item.id)))
  if (targets.length === 0) throw new Error('没有可执行的用例：用例上要填 method + url（相对地址会拼环境 baseUrl）')

  const by = String(options.by ?? '系统').slice(0, 40)
  const results = []
  // 串行跑，环境不稳时并发只会让失败更难归因。
  for (const item of targets) {
    const outcome = await runOneCase(item, env, config)
    results.push({ id: item.id, title: item.title, ...outcome })
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
          lastRun: { at: Date.now(), ok: outcome.ok, status: outcome.status, ms: outcome.ms, error: outcome.error, preview: outcome.preview, response: outcome.response ?? '', env: env.id, steps: outcome.steps ?? [] },
        }
      })
      card.updatedAt = Date.now()
    })
  }

  const run = sanitizeTestRun({
    id: `run-${randomBytes(3).toString('hex')}`,
    at: Date.now(),
    by,
    env: env.id,
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
    `接口测试已在环境「${env.name}」跑完：${results.length} 条，通过 ${passed}，不通过 ${results.length - passed}。`
      + (results.length - passed > 0 ? `\n\n不通过的：\n${results.filter(item => !item.ok).map(item => `- ${item.title}：${item.error}`).join('\n')}` : ''),
    by,
    'agent',
  )
  return { run, env: { id: env.id, name: env.name, baseUrl: env.baseUrl }, bugs, state: host.publicState(store) }
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
      const needsProduct = String(draft.links?.prd ?? '').trim() === '' && (draft.docs ?? []).every(doc => String(doc.content ?? '').trim() === '') && draft.baseline === null
      const created = {
        ...draft,
        status: needsProduct === true ? 'review' : draft.status,
        review: needsProduct === true ? { status: 'pending', by: String(input.by ?? input.operator ?? '系统').slice(0, 40), at: now, note: '新建需求：保存后自动转产品补 PRD' } : draft.review,
        code: draft.code.length > 0 ? draft.code : nextRequirementCode(state.requirements),
        createdAt: now,
        updatedAt: now,
      }
      state.requirements.unshift(created)
      saved = created
      return
    }
    // 变更影响面：先记下旧值，覆盖之后再比，才能说清楚「改了哪几处」。
    const before = {
      title: existing.title,
      description: existing.description,
      points: requirementPointsFingerprint(existing.points),
      links: JSON.stringify(existing.links ?? {}),
    }
    for (const key of ['title', 'description', 'project', 'iteration', 'owner', 'domain', 'priority', 'status', 'links']) {
      existing[key] = draft[key]
    }
    // 排序与依赖单独处理：显式给了才覆盖，避免详情页保存别的字段时把它们清空。
    for (const key of ['order', 'dependsOn']) {
      if (input[key] !== undefined) existing[key] = draft[key]
    }
    // 功能点是需求的骨架：显式给了才覆盖，避免别的保存动作把矩阵清空。
    if (input.points !== undefined) existing.points = draft.points
    if (existing.code.length === 0) existing.code = nextRequirementCode(state.requirements)
    const changedParts = []
    if (existing.title !== before.title) changedParts.push('标题')
    if (existing.description !== before.description) changedParts.push('需求明细')
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

/**
 * 可追溯矩阵：需求的功能点 → 卡片（含状态）→ 用例（通过/失败/没跑）→ 交付物。
 * 一条需求做没做完，看的就是这张表，而不是“我印象里做过了”。
 */
export function requirementMatrix(state, requirement) {
  const tasks = state.tasks.filter(task => task.requirementId === requirement.id)
  const points = (requirement.points ?? []).map(point => {
    const cards = tasks.filter(task => task.pointId === point.id)
    const cardIds = new Set(cards.map(card => card.id))
    const cases = []
    for (const card of cards) {
      for (const item of card.cases ?? []) {
        if (item.pointId !== '' && item.pointId !== point.id) continue
        cases.push({ ...item, taskId: card.id, taskCode: card.code || card.id, taskTitle: card.title })
      }
    }
    // 用例可能挂在别的卡上（比如测试卡），按 pointId 全局找一遍。
    for (const card of tasks) {
      if (cardIds.has(card.id)) continue
      for (const item of card.cases ?? []) {
        if (item.pointId !== point.id) continue
        cases.push({ ...item, taskId: card.id, taskCode: card.code || card.id, taskTitle: card.title })
      }
    }
    const artifacts = cards.flatMap(card => (card.artifacts ?? []).map(item => ({ ...item, taskCode: card.code || card.id })))
    const acceptance = (point.acceptance ?? []).map(item => {
      const matched = cases.filter(entry => entry.result === 'pass')
      return { ...item, covered: matched.length > 0 }
    })
    const pass = cases.filter(item => item.result === 'pass').length
    const fail = cases.filter(item => item.result === 'fail').length
    const pending = cases.length - pass - fail
    const doneCards = cards.filter(card => card.status === 'done').length
    const covered = acceptance.length === 0
      ? pass > 0
      : acceptance.every(item => item.covered)
    return {
      id: point.id,
      title: point.title,
      description: point.description,
      priority: point.priority,
      status: point.status,
      acceptance,
      cards: cards.map(card => ({ id: card.id, code: card.code, title: card.title, status: card.status, date: card.status === 'done' ? card.updatedAt : 0 })),
      cases: { total: cases.length, pass, fail, pending },
      artifacts: artifacts.length,
      doneCards,
      covered,
    }
  })
  const loose = tasks.filter(task => task.pointId === '' || (requirement.points ?? []).every(point => point.id !== task.pointId))
  const summary = {
    points: points.length,
    coveredPoints: points.filter(point => point.covered).length,
    /** 一个用例都没有的功能点：覆盖率最容易漏的口子。 */
    pointsWithoutCases: points.filter(point => point.cases.total === 0).length,
    cards: tasks.length,
    looseCards: loose.length,
    cases: points.reduce((sum, point) => sum + point.cases.total, 0),
    pass: points.reduce((sum, point) => sum + point.cases.pass, 0),
    fail: points.reduce((sum, point) => sum + point.cases.fail, 0),
    artifacts: points.reduce((sum, point) => sum + point.artifacts, 0),
  }
  summary.passRate = summary.cases === 0 ? 0 : Math.round((summary.pass / summary.cases) * 100)
  summary.coverageRate = summary.points === 0 ? 0 : Math.round(((summary.points - summary.pointsWithoutCases) / summary.points) * 100)
  return {
    points,
    loose: loose.map(card => ({ id: card.id, code: card.code, title: card.title, status: card.status })),
    summary,
  }
}

/**
 * 一条需求能不能算「交付完成」：卡全完成、功能点全覆盖、没有阻塞/未结缺陷/失败用例，
 * 并且有人做过需求级验收签字。这是需求维度的门禁，和单卡的 taskExitGate 分开。
 */
export function requirementGate(state, requirement) {
  const tasks = state.tasks.filter(task => task.requirementId === requirement.id)
  const matrix = requirementMatrix(state, requirement)
  const blockers = []
  const warnings = []
  const pool = requirement.pool ?? { score: 0 }
  if (!(pool.score > 0)) warnings.push('还没做需求池打分（RICE）：影响面、影响度、置信度、成本填一下就能排序')
  const openQuestions = (requirement.questions ?? []).filter(item => item.status === 'open')
  if (String(requirement.links?.prd ?? '').trim() === '' && (requirement.docs ?? []).every(doc => String(doc.content ?? '').trim() === '') && requirement.baseline === null) {
    blockers.push('需求还没有产品输出：先补 PRD 链接或正文，再拆卡')
  }
  if (openQuestions.length > 0) blockers.push(`还有 ${openQuestions.length} 个待确认问题没回答：${openQuestions.slice(0, 3).map(item => item.text.slice(0, 18)).join('、')}`)
  if (tasks.length === 0) blockers.push('这条需求下还没有任何任务卡')
  if ((requirement.points ?? []).length === 0) warnings.push('还没有拆功能点，可追溯矩阵是空的')
  const open = tasks.filter(task => task.status !== 'done')
  if (open.length > 0) {
    const names = open.slice(0, 5).map(task => task.code || task.id).join('、')
    blockers.push(`${open.length} 张卡还没完成：${names}${open.length > 5 ? ' 等' : ''}`)
  }
  const blocked = tasks.filter(task => task.blocked !== null && task.blocked !== undefined)
  if (blocked.length > 0) blockers.push(`${blocked.length} 张卡还卡在阻塞：${blocked.slice(0, 3).map(task => task.code || task.id).join('、')}`)
  const bugs = tasks.filter(task => task.type === 'bug' && task.status !== 'done')
  if (bugs.length > 0) blockers.push(`还有 ${bugs.length} 个缺陷没关闭：${bugs.slice(0, 3).map(task => task.code || task.id).join('、')}`)
  const failing = []
  for (const task of tasks) {
    for (const item of task.cases ?? []) {
      if (item.result === 'fail') failing.push(`${task.code || task.id}·${item.title}`)
    }
  }
  if (failing.length > 0) blockers.push(`${failing.length} 条用例不通过：${failing.slice(0, 3).join('；')}`)
  const pendingDeps = (requirement.dependsOn ?? [])
    .map(id => state.requirements.find(item => item.id === id))
    .filter(item => item !== undefined && item.status !== 'delivered' && item.status !== 'closed')
  if (pendingDeps.length > 0) {
    blockers.push(`依赖的需求还没交付：${pendingDeps.map(item => item.code || item.title).join('、')}`)
  }
  const uncovered = matrix.points.filter(point => !point.covered)
  if (uncovered.length > 0) warnings.push(`${uncovered.length} 个功能点还没有通过的用例覆盖：${uncovered.slice(0, 3).map(point => point.id).join('、')}`)
  if (matrix.summary.pointsWithoutCases > 0) warnings.push(`${matrix.summary.pointsWithoutCases} 个功能点还没有任何用例（测试覆盖率 ${matrix.summary.coverageRate}%）`)
  if (matrix.summary.looseCards > 0) warnings.push(`${matrix.summary.looseCards} 张卡还没归到功能点`)
  const artifacts = tasks.reduce((sum, task) => sum + (task.artifacts ?? []).length, 0)
  if (artifacts === 0) warnings.push('这条需求下还没有登记任何交付物')
  else {
    const empty = tasks.reduce((sum, task) => sum + (task.artifacts ?? []).filter(item => String(item.content ?? '').trim() === '').length, 0)
    if (empty > 0) warnings.push(`${empty} 件交付物还没有正文`)
  }
  if (requirement.signoff === null || requirement.signoff === undefined) blockers.push('还没有需求级验收签字')
  // 评审没通过的草稿/待评审需求不该往下拆卡：先过评审，再干活。
  const review = requirement.review ?? null
  const reviewApproved = review !== null && review.status === 'approved'
  const started = requirement.status === 'active' || requirement.status === 'delivered' || requirement.status === 'closed'
  if (!reviewApproved && !started) {
    blockers.push(requirement.status === 'review'
      ? '需求还在评审中：等评审人给出结论（通过之后才能拆卡）'
      : '需求还没评审通过：先点「提交评审」，评审通过后再拆卡')
  }
  if (review !== null && review.status === 'changes_requested') {
    blockers.push(`需求评审被打回${review.note === '' ? '' : `：${review.note.slice(0, 80)}`}`)
  }
  // 需求中途改过内容：已经产出过的卡是按旧版做的，签字作废、必须重新走一遍确认。
  const change = requirement.change ?? null
  if (change !== null && change.invalidated) {
    const names = change.affected.slice(0, 3).map(item => item.code || item.id).join('、')
    blockers.push(`需求改过（${change.parts.join('、')}）：${change.affected.length} 张已产出的卡要复核${names === '' ? '' : `（${names}）`}，验收签字已作废`)
  } else if (change !== null && change.affected.length > 0) {
    warnings.push(`需求上一次变更影响 ${change.affected.length} 张卡，建议逐张复核再签字`)
  }
  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    stats: {
      cards: tasks.length,
      done: tasks.length - open.length,
      open: open.length,
      blocked: blocked.length,
      bugs: bugs.length,
      failing: failing.length,
      points: matrix.points.length,
      coveredPoints: matrix.summary.coveredPoints,
      cases: matrix.summary.cases,
      pass: matrix.summary.pass,
      artifacts,
      signoff: requirement.signoff !== null && requirement.signoff !== undefined,
    },
  }
}

/**
 * 需求进度：给列表和详情共用。derived 是**算出来的**状态，
 * 手动状态只在「关闭」时优先（人明确关掉的需求不该被自动拉回进行中）。
 */
export function requirementProgress(state, requirement) {
  const tasks = state.tasks.filter(task => task.requirementId === requirement.id)
  const gate = requirementGate(state, requirement)
  const done = tasks.filter(task => task.status === 'done').length
  const blocked = tasks.filter(task => task.blocked !== null && task.blocked !== undefined).length
  const progress = tasks.length === 0 ? 0 : Math.round((done / tasks.length) * 100)
  const derived = requirement.status === 'closed'
    ? 'closed'
    : (tasks.length > 0 && done === tasks.length && gate.ready ? 'delivered' : (tasks.length > 0 ? 'active' : 'draft'))
  return {
    gate,
    cards: { total: tasks.length, done, open: tasks.length - done, blocked },
    progress,
    derived,
    review: requirement.review ?? null,
    reviewStatus: (requirement.review ?? {}).status ?? 'none',
  }
}

/**
 * 卡能不能进「已完成」：验收清单全勾、没有失败用例、不处在阻塞中、并且有人签字。
 * 没过就抛错，除非显式带 override 理由（会记进状态历史）。
 */
export function taskExitGate(state, task) {
  const blockers = []
  const warnings = []
  const checklist = task.checklist ?? []
  const unchecked = checklist.filter(item => item.done !== true)
  if (unchecked.length > 0) {
    blockers.push(`验收清单还有 ${unchecked.length} 项没勾：${unchecked.slice(0, 3).map(item => item.text).join('、')}`)
  }
  const cases = task.cases ?? []
  const failed = cases.filter(item => item.result === 'fail')
  if (failed.length > 0) blockers.push(`${failed.length} 条用例不通过：${failed.slice(0, 3).map(item => item.title).join('、')}`)
  // CI 门禁：真跑过流水线且失败，不允许收口（没接 GitLab 时这个字段是空的，不会误伤）。
  if (task.gitlabMR?.pipeline?.status === 'failed') blockers.push(`CI 流水线没通过：${task.gitlabMR.pipeline.id ? `#${task.gitlabMR.pipeline.id}` : '最近一次运行'}`)
  if (task.blocked !== undefined && task.blocked !== null) blockers.push('这张卡还挂着阻塞标记')
  if (task.signoff === undefined || task.signoff === null) blockers.push('还没有验收签字')
  if (cases.length === 0) warnings.push('这张卡没有测试用例，建议至少补一条主流程用例')
  else {
    const pending = cases.filter(item => item.result === 'pending' || item.result === 'skip').length
    if (pending > 0) warnings.push(`${pending} 条用例还没跑`)
  }
  const artifacts = task.artifacts ?? []
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
  const slaOverdue = open.filter(task => task.type === 'bug' && host.bugSla(task, state.config).state === 'overdue')
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
      slaOverdue: slaOverdue.length,
      gateFailed: gateFailed.length,
      pipelineFailed: pipelineFailed.length,
      requirementBlocked: requirementBlocked.length,
      releaseBlocked: releaseBlocked.length,
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
      slaOverdue: listOf(slaOverdue),
      gateFailed: listOf(gateFailed),
      pipelineFailed: listOf(pipelineFailed),
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
export function runCommand(command, args, timeoutMs = 20000) {
  return new Promise(resolvePromise => {
    let child
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
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
  const raw = pulled.stdout.trim()
  let text = raw
  try {
    const parsed = JSON.parse(raw)
    if (parsed.ok === false) {
      const message = parsed.error?.message ?? '未知错误'
      return { ok: false, tool: true, text: '', error: `lark-cli 报错：${String(message).slice(0, 260)}（可能是这个应用还没被加进文档协作者）` }
    }
    text = String(parsed.data?.document?.content ?? '')
    if (text.trim() === '') return { ok: false, tool: true, text: '', error: '拉到了空正文：这个文档可能是空的，或者应用没有阅读权限' }
    const title = /<title>([\s\S]*?)<\/title>/.exec(text)?.[1]?.trim() ?? ''
    const body = text.replace(/<title>[\s\S]*?<\/title>\s*/, '')
    return { ok: true, tool: true, title, text: body.slice(0, 60000), error: '' }
  } catch {
    return { ok: true, tool: true, title: '', text: raw.slice(0, 60000), error: '' }
  }
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
export async function larkJson(args, timeoutMs = 45000) {
  const probe = await larkCliReady()
  if (!probe.ok) {
    host.markHealth('drive', 'fail', `服务器上没有可用的 lark-cli（${probe.hint}）`)
    return { ok: false, error: `服务器上没有可用的 lark-cli（${probe.hint}）` }
  }
  const result = await runCommand('lark-cli', [...args, '--as', 'user', '--json'], timeoutMs)
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
  requirement: '需求', design: '方案', mr: '合并请求', cases: '用例', report: '报告',
  release: '发布', doc: '文档', screenshot: '截图', other: '交付物',
}

export function safeFileName(text) {
  return String(text ?? '').replace(/[\\/:*?"<>|\n\r\t]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120)
}

/** 需求在云盘里的文件夹名：`REQ-2026-001 会员积分抵扣`。 */
export function requirementFolderName(requirement) {
  const code = String(requirement.code ?? '').trim()
  return safeFileName(`${code.length > 0 ? code : requirement.id} ${requirement.title}`.trim())
}

/** 给需求建一个云盘文件夹；已经建过就直接返回。 */
export async function ensureReqFolder(store, requirementId) {
  const state = store.snapshot()
  const requirement = state.requirements.find(item => item.id === requirementId)
  if (requirement === undefined) throw new Error(`no requirement ${requirementId}`)
  const current = requirement.folder ?? {}
  if (String(current.token ?? '').trim().length > 0) return current
  const parent = String(state.config.feishu.driveFolder ?? '').trim()
  if (parent === '') throw new Error('还没配置飞书云盘根文件夹（设置 → 飞书 · 云盘根文件夹）')
  const name = requirementFolderName(requirement)
  const created = await larkJson(['drive', '+create-folder', '--folder-token', parent, '--name', name], 45000)
  if (!created.ok) {
    await store.mutate(draft => {
      const target = draft.requirements.find(item => item.id === requirementId)
      if (target !== undefined) target.folder = { ...(target.folder ?? {}), error: created.error.slice(0, 300) }
    })
    return { token: '', url: '', name, at: 0, error: created.error.slice(0, 300) }
  }
  const folder = {
    token: String(created.data.folder_token ?? ''),
    url: String(created.data.url ?? ''),
    name: String(created.data.name ?? name),
    at: Date.now(),
    error: '',
  }
  await store.mutate(draft => {
    const target = draft.requirements.find(item => item.id === requirementId)
    if (target !== undefined) target.folder = folder
  })
  return folder
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
export async function syncArtifact(store, taskId, artifactId) {
  const state = store.snapshot()
  const task = state.tasks.find(item => item.id === taskId)
  if (task === undefined) throw new Error(`no task ${taskId}`)
  const artifact = (task.artifacts ?? []).find(item => item.id === artifactId)
  if (artifact === undefined) throw new Error(`no artifact ${artifactId}`)
  const { folder, requirement } = await ensureArtifactFolder(store, task)
  if (String(folder.token ?? '').trim() === '') throw new Error(folder.error ?? '创建云盘文件夹失败')
  const prefix = task.code.length > 0 ? `${task.code}-` : `${task.id}-`
  const name = safeFileName(`${prefix}${ARTIFACT_FILE_LABEL[artifact.kind] ?? '交付物'}-${artifact.title}.md`)
  const filled = { ...artifact, content: await artifactBody(task, artifact, state.config) }
  const body = artifactMarkdown(task, filled, requirement)
  const tmpDir = join(host.dshHomePath('tmp'), `artifact-${artifact.id}`)
  await mkdir(tmpDir, { recursive: true })
  // lark-cli 用本地文件名当远端文件名（--name 在 --file 模式下会被忽略），
  // 所以这里把临时文件直接命名成最终文档名。
  const tmpFile = join(tmpDir, name)
  await writeFile(tmpFile, body, 'utf8')
  try {
    const existing = String(artifact.doc?.token ?? '').trim()
    const result = existing.length > 0
      ? await larkJson(['markdown', '+overwrite', '--file-token', existing, '--file', tmpFile], 45000)
      : await larkJson(['markdown', '+create', '--folder-token', folder.token, '--file', tmpFile, '--name', name], 45000)
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
      error: '',
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
    } else if (action === 'clear-baseline') {
      requirement.baseline = null
      for (const doc of requirement.docs) if (doc.status === 'baseline') doc.status = 'review'
    } else {
      throw new Error(`unknown action ${action}`)
    }
    requirement.updatedAt = Date.now()
    saved = structuredClone(requirement)
  })
  return saved
}

/** Update one task. */
export async function updateTask(store, id, patch) {
  const normalized = normalizePatch(patch)
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
        throw new Error(`准出没过：${gate.blockers.join('；')}。确实要收口就在推进时填 override 写明原因。`)
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
    const previous = task.status
    const previousRequirement = task.requirementId ?? ''
    Object.assign(task, normalized)
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
    if (normalized.status !== undefined) {
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
          if (owner !== undefined && typeof owner.id === 'string') task.expert = owner.id
        }
      }
      if (previous !== task.status) moved = { from: previous, to: task.status, task: structuredClone(task), by }
    }
    result = task
  })
  if (moved !== null) {
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
  return result
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

