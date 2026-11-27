import { CODING_REVIEW_STATUS, cleanId, mergeCoding, sanitizeCoding } from '../domain.js'
import { CODING_REVIEW_VERDICT, isSelfReview, reviewDecision } from '../quality.js'
import { clearAgentFailure, noteAgentFailure } from '../dispatcher.js'
import { codingVerifyLine, qualitySummary, runCommand, runTaskQuality, taskExitGate, verifyCodingRecord } from '../executor.js'
import { compareCodingFacts } from '../gitlab-facts.js'
import { publishNoteMentions } from '../mention-note.js'
import { buildDiffView, parseStatusList } from '../task-diff.js'
import { parseMentions } from '../dispatcher.js'
import { mergeGateFor } from '../merge-gate.js'
import { rejectUnknownFields } from '../route-contract.js'
import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
const INJECTED = ["applyConfig","commentTask","deleteProjectFolder","ensureWorktree","getDispatcher","mergeMergeRequest","publicState","publishMergeGate","readJsonBody","recordAudit","removeWorktree","sendJson","serviceOf","upsertById","workProjectOf"]
let host = {
  applyConfig: () => {},
  commentTask: undefined,
  getDispatcher: () => undefined,
  deleteProjectFolder: async () => ({}),
  ensureWorktree: () => {},
  mergeMergeRequest: async () => ({}),
  publicState: () => {},
  publishMergeGate: async () => ({}),
  readJsonBody: () => {},
  removeWorktree: () => {},
  sendJson: () => {},
  serviceOf: () => {},
  upsertById: () => {},
  workProjectOf: () => {},
}
/** 执行记录核对、Agent 失败重试、worktree 与项目配置。宿主能力由 configureCodingRoutes() 注入。 */
export function configureCodingRoutes(services) {
  host = { ...host, ...(services ?? {}) }
}

export async function handleCodingRoute({ method, route, req, res, store, url }) {
if (method === 'POST' && route === '/coding/gitlab') {
  // 从 GitLab 核对：拉 MR + changes，和卡上自报的文件数/提交数比一遍，结果记进 coding.gitlab。
  const body = await host.readJsonBody(req)
  const id = String(body.id ?? '')
  const snapshot = store.snapshot()
  const task = snapshot.tasks.find(t => t.id === id)
  if (task === undefined) throw new Error(`no task ${id}`)
  const iid = Number(task.gitlabMR?.iid ?? 0)
  if (iid <= 0) throw new Error('这张卡还没关联 MR：先提 MR，把 !iid 填进卡片的 GitLab 区块')
  const config = snapshot.config
  const projects = config.gitlab?.projects ?? []
  const project = projects.find(item => item.id === task.gitlabProject) ?? projects[0]
  if (project === undefined) throw new Error('还没配 GitLab 项目（设置 → 代码仓库）')
  const mr = await host.gitlabRequest(config, project, `/merge_requests/${iid}`)
  const detail = await host.gitlabMergeRequestDetail(config, project, iid)
  const facts = compareCodingFacts(task.coding, mr, detail)
  await store.mutate(state => {
    const target = state.tasks.find(t => t.id === id)
    if (target === undefined) return
    target.coding = { ...(target.coding ?? {}), gitlab: facts }
    target.updatedAt = Date.now()
  })
  host.sendJson(res, 200, { ok: true, facts, state: host.publicState(store) })
  return true
}
/* 重新核对代码事实：进「待评审」时会自动跑一次，但基线/执行记录被人修好之后需要能重跑。
   真机 2026-11-26：REQ-001 的 worktree.base 为空导致误报「4 个文件没改」，
   以前只能把卡退回「待评审」再推一次才触发核对。 */
if (method === 'POST' && route === '/task/verify-coding') {
  const body = await host.readJsonBody(req)
  rejectUnknownFields('/task/verify-coding', body)
  const id = String(body.id ?? '')
  const task = store.snapshot().tasks.find(item => item.id === id)
  if (task === undefined) throw new Error(`no task ${id}`)
  const report = await host.autoVerifyCoding(store, id)
  const after = store.snapshot().tasks.find(item => item.id === id)
  host.sendJson(res, 200, { ok: true, report, verified: after?.coding?.verified ?? null, state: host.publicState(store) })
  return true
}
if (method === 'POST' && route === '/task/coding') {
  const body = await host.readJsonBody(req)
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
      /* 与 studio_task_coding 工具同一套规则：不传结论 → pending；作者不能给自己盖"通过"。
         以前这里默认 approved，面板点一下"评审通过"就完事，评审形同虚设。 */
      /* 两个入参都认：HTTP 一直用 status，工具用 reviewStatus；传错那个以前返回 200 但落库仍是 pending（issue #13）。 */
    const wanted = body.status ?? body.reviewStatus
    if (wanted === undefined || String(wanted).trim() === '') {
      throw new Error('评审要给结论：status 或 reviewStatus（approved / changes_requested / pending）')
    }
    if (!CODING_REVIEW_STATUS.includes(String(wanted).trim())) {
      throw new Error(`评审结论「${String(wanted)}」不认识：只认 ${CODING_REVIEW_STATUS.join(' / ')}`)
    }
    const status = reviewDecision(wanted, CODING_REVIEW_STATUS)
      const author = String(base.agent ?? '').trim()
      if (status === 'approved' && isSelfReview(author, by)) {
        throw new Error(`不能自评：这份执行记录的作者是「${author}」，评审人也是「${by}」。让另一个专家评审`)
      }
      task.coding = sanitizeCoding({
        ...base,
        review: { status, by, at: Date.now(), note: String(body.note ?? '').slice(0, 600) },
      })
    } else if (action === 'merge') {
      // 与工具同一条判据：门禁没过不许自报「已合并」。
      const gate = mergeGateFor(state, task)
      if (gate.ready !== true) throw new Error(`合并门禁没过：${gate.blockers.join('；')}`)
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
  /* 评审备注里的 @ 以前不生效（只有评论才解析）：评审不通过时写「@开发工程师 这里要改」
     对方根本收不到。现在把备注补成评论并逐个派单。
     forceComment：评审结论一定要进讨论区 —— 以前按关键词猜，通过结论（「LGTM，可以进测试」）
     不会留评论，人只看得到研发说了什么。 */
  const verdict = action === 'review' ? (CODING_REVIEW_VERDICT[String(task?.coding?.review?.status ?? '')] ?? '') : ''
  const noteOut = action === 'review'
    ? await publishNoteMentions({ store, commentTask: host.commentTask, dispatcher: host.getDispatcher(), parseMentions }, { taskId: id, note: String(body.note ?? ''), by, label: '代码评审', verdict, forceComment: true })
    : { mentions: [], dispatched: [], commented: false }
  host.sendJson(res, 200, { ok: true, task, ...noteOut, state: host.publicState(store) })
  return true
}
if (method === 'POST' && route === '/task/coding/verify') {
  // 拿 worktree 里的 git 事实核对执行记录：agent 说改了哪些提交/文件，真的在分支上吗。
  const body = await host.readJsonBody(req)
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
  host.sendJson(res, 200, {
    ok: true,
    report,
    line: codingVerifyLine(report),
    gate: taskExitGate(state, task),
    task,
    state: host.publicState(store),
  })
  return true
}
if (method === 'POST' && route === '/task/diff') {
  /* 这张卡到底改了什么代码：直接读仓库里的 git 事实（不是 agent 自报的文件名）。
     只读：不改库、不推 revision —— 否则人每点一次「看代码改动」就多一版快照。
     目录优先用卡的 worktree（隔离时那边才是真正在改的副本），否则回退到项目/服务的本机代码目录。
     基线同样从 worktree 记录里取（建树时记下的 base），没有就按服务/项目的 baseBranch。 */
  req.__studioReadOnly = true
  const body = await host.readJsonBody(req)
  const id = String(body.id ?? '')
  const snapshot = store.snapshot()
  const task = snapshot.tasks.find(entry => entry.id === id)
  if (task === undefined) throw new Error(`no task ${id}`)
  const config = snapshot.config
  const worktree = task.worktree ?? null
  const service = host.serviceOf(config, task)
  const project = host.workProjectOf(config, task)
  const dir = String(worktree?.path ?? '').trim()
    || String(service?.repoPath ?? '').trim()
    || String(project?.repoPath ?? '').trim()
  const firstLine = value => String(value ?? '').trim().split(/\r?\n/)[0] ?? ''
  if (dir === '') {
    host.sendJson(res, 200, { ok: true, skipped: '这张卡还没配代码目录：在项目或服务里填「本机代码目录」，或先建 worktree（执行记录 → 建 worktree）' })
    return true
  }
  const git = (...args) => runCommand('git', ['-C', dir, ...args], 30_000)
  const inside = await git('rev-parse', '--is-inside-work-tree')
  if (inside.ok !== true) {
    host.sendJson(res, 200, { ok: true, skipped: `${dir} 不是可用的 git 仓库：${firstLine(inside.stderr) || 'git 不可用'}` })
    return true
  }
  const head = await git('rev-parse', '--abbrev-ref', 'HEAD')
  const branch = String(worktree?.branch ?? '').trim() || String(head.stdout ?? '').trim()
  const wanted = String(body.base ?? worktree?.base ?? service?.baseBranch ?? project?.baseBranch ?? 'main').trim() || 'main'
  // 基线分支可能只在远端（origin/main）：按候选逐个验存在，别拿一个不存在的名字去 diff。
  const candidates = [wanted, `origin/${wanted}`, 'main', 'master'].filter((item, index, all) => item !== '' && all.indexOf(item) === index)
  let base = ''
  for (const candidate of candidates) {
    if ((await git('rev-parse', '--verify', '--quiet', `${candidate}^{commit}`)).ok === true) {
      base = candidate
      break
    }
  }
  if (base === '') {
    host.sendJson(res, 200, { ok: true, skipped: `找不到基线分支（试过 ${candidates.join(' / ')}）：这张卡的分支 ${branch || '(未知)'} 没法比出改动` })
    return true
  }
  /* 可选 commit：只看某一次提交的改动（前端「提交」下拉）。只认十六进制短/长 sha，
     先用 rev-parse 验它真的在这个仓库里，再按 <sha>^..<sha> 出 diff。 */
  const wantedCommit = String(body.commit ?? '').trim()
  let commitSha = ''
  let rangeRef = `${base}...HEAD`
  let rangeLabel = `${branch || '(无分支)'} ← ${base}`
  if (wantedCommit !== '') {
    if (/^[0-9a-f]{4,40}$/i.test(wantedCommit) !== true) {
      host.sendJson(res, 200, { ok: true, skipped: '提交号不合法：只认 4–40 位十六进制 sha' })
      return true
    }
    const verified = await git('rev-parse', '--verify', '--quiet', `${wantedCommit}^{commit}`)
    if (verified.ok !== true) {
      host.sendJson(res, 200, { ok: true, skipped: `找不到提交 ${wantedCommit}（可能不在这个仓库/分支上）` })
      return true
    }
    commitSha = String(verified.stdout ?? '').trim()
    rangeRef = `${commitSha}^..${commitSha}`
    rangeLabel = `提交 ${commitSha.slice(0, 8)}`
  }
  // 可选的提交列表：让面板能选「全部改动 / 某一次提交」。
  const log = await git('log', '--format=%h%x09%s', `${base}..HEAD`, '-n', '50')
  const commits = String(log.stdout ?? '').trim().split(/\r?\n/).filter(line => line.trim() !== '').map(line => {
    const [sha, ...rest] = line.split('\t')
    return { sha: String(sha ?? '').trim(), subject: rest.join('\t').trim() }
  }).filter(item => /^[0-9a-f]{4,40}$/i.test(item.sha))
  let numstat = await git('diff', '--numstat', rangeRef)
  if (numstat.ok !== true && commitSha !== '') {
    // 仓库的第一个提交没有父：退回 git show，仍然只出这一次提交的内容。
    numstat = await git('show', '--format=', '--numstat', commitSha)
  }
  if (numstat.ok !== true) {
    host.sendJson(res, 200, { ok: true, skipped: `读不到 ${rangeRef} 的改动：${firstLine(numstat.stderr)}` })
    return true
  }
  let patch = await git('diff', '--unified=3', rangeRef)
  if (patch.ok !== true && commitSha !== '') patch = await git('show', '--format=', '--unified=3', commitSha)
  // 改动类型（新增 / 修改 / 删除 / 改名）：面板的树形视图用它标每个文件。
  let nameStatus = patch.ok === true ? await git('diff', '--name-status', rangeRef) : { ok: false, stdout: '' }
  if (nameStatus.ok !== true && commitSha !== '') nameStatus = await git('show', '--format=', '--name-status', commitSha)
  const view = buildDiffView({ numstat: numstat.stdout, patch: patch.ok === true ? patch.stdout : '', nameStatus: nameStatus.stdout })
  // 还没提交的改动单独报：研发说「改完了」但忘了提交时，代码其实不在分支上。
  const status = await git('status', '--porcelain')
  const dirty = parseStatusList(status.stdout)
  const dirtyNumstat = await git('diff', '--numstat', 'HEAD')
  const dirtyTotals = buildDiffView({ numstat: dirtyNumstat.stdout, patch: '' }).totals
  host.sendJson(res, 200, {
    ok: true,
    at: Date.now(),
    dir,
    branch,
    base,
    commit: commitSha,
    rangeLabel,
    commits,
    ...view,
    patchUnavailable: patch.ok !== true,
    uncommitted: {
      total: dirty.length,
      files: dirty.slice(0, 20),
      additions: dirtyTotals.additions,
      deletions: dirtyTotals.deletions,
    },
  })
  return true
}
if (method === 'POST' && route === '/task/file') {
  /* 看某个文件的**全文**（面板「改动 / 全文」里的全文）：只读仓库里的文件，越界一律拒绝。
     只读路由：不推 revision、不记审计。读不到（已删除 / 新文件不在工作区）如实说原因。 */
  req.__studioReadOnly = true
  const body = await host.readJsonBody(req)
  const id = String(body.id ?? '')
  const wanted = String(body.path ?? '').trim()
  const snapshot = store.snapshot()
  const task = snapshot.tasks.find(entry => entry.id === id)
  if (task === undefined) throw new Error(`no task ${id}`)
  if (wanted === '') {
    host.sendJson(res, 200, { ok: true, skipped: '没给文件路径' })
    return true
  }
  const config = snapshot.config
  const worktree = task.worktree ?? null
  const service = host.serviceOf(config, task)
  const project = host.workProjectOf(config, task)
  const dir = String(worktree?.path ?? '').trim()
    || String(service?.repoPath ?? '').trim()
    || String(project?.repoPath ?? '').trim()
  if (dir === '') {
    host.sendJson(res, 200, { ok: true, skipped: '这张卡还没配代码目录：在项目或服务里填「本机代码目录」' })
    return true
  }
  const base = resolve(dir)
  const target = resolve(base, wanted)
  // 只允许读这个仓库/工作树里面的文件：`../`、绝对路径都要拒绝。
  if (target !== base && !target.startsWith(base + sep)) {
    host.sendJson(res, 200, { ok: true, skipped: '只能看仓库目录里的文件' })
    return true
  }
  try {
    const info = await stat(target)
    if (info.isFile() !== true) {
      host.sendJson(res, 200, { ok: true, skipped: '这不是一个文件' })
      return true
    }
    /* 符号链接也要拦住：仓库里放一个指向 /etc/passwd 的软链，字面路径仍在仓库内。 */
    const real = await realpath(target)
    const realBase = await realpath(base)
    if (real !== realBase && !real.startsWith(realBase + sep)) {
      host.sendJson(res, 200, { ok: true, skipped: '只能看仓库目录里的文件' })
      return true
    }
    const LIMIT = 200_000
    const buffer = await readFile(target)
    const capped = buffer.subarray(0, LIMIT)
    if (capped.includes(0)) {
      host.sendJson(res, 200, { ok: true, path: wanted, binary: true, bytes: info.size })
      return true
    }
    host.sendJson(res, 200, {
      ok: true,
      path: wanted,
      content: capped.toString('utf8'),
      bytes: info.size,
      truncated: info.size > capped.length,
      at: Date.now(),
    })
  } catch (error) {
    const reason = String(error?.message ?? error)
    host.sendJson(res, 200, { ok: true, skipped: /ENOENT/.test(reason) ? '这个文件不在工作区里（可能是新文件没落盘，或已删除）' : `读不到这个文件：${reason.slice(0, 120)}` })
  }
  return true
}
if (method === 'POST' && route === '/task/agent/fail') {
  // 记一次 AI 失败（真失败时由派单器调用；也可由 agent 自己上报）。
  const body = await host.readJsonBody(req)
  const id = String(body.id ?? '')
  const plan = await noteAgentFailure(store, id, String(body.error ?? 'AI 没有完成这一轮'), String(body.by ?? '系统').slice(0, 60))
  if (plan === undefined) throw new Error(`no task ${id}`)
  const state = store.snapshot()
  const task = state.tasks.find(entry => entry.id === id)
  host.sendJson(res, 200, { ok: true, plan, task, gate: taskExitGate(state, task), state: host.publicState(store) })
  return true
}
if (method === 'POST' && route === '/task/agent/retry') {
  const body = await host.readJsonBody(req)
  const id = String(body.id ?? '')
  const changed = await clearAgentFailure(store, id, String(body.by ?? '人').slice(0, 60))
  if (!changed) throw new Error(`no task ${id}`)
  /* 光清失败计数不够：tick() 见到 dispatch.status === task.status 就跳过，
     所以「重新派单」以前是个假按钮 —— 提示"下一轮自动接手"，实际永不重派。
     这里把派单印记一起清掉，下一次 tick 才会真的重新派。 */
  await store.mutate(state => {
    const task = state.tasks.find(entry => entry.id === id)
    if (task !== undefined) task.dispatch = null
  })
  const state = store.snapshot()
  const task = state.tasks.find(entry => entry.id === id)
  host.sendJson(res, 200, { ok: true, task, state: host.publicState(store) })
  return true
}
if (method === 'POST' && route === '/task/worktree') {
  const body = await host.readJsonBody(req)
  const id = String(body.id ?? '')
  const action = String(body.action ?? 'create')
  const snapshotNow = store.snapshot()
  const task = snapshotNow.tasks.find(entry => entry.id === id)
  if (task === undefined) throw new Error(`no task ${id}`)
  if (action === 'remove') {
    const result = await host.removeWorktree(store, task, snapshotNow.config)
    host.sendJson(res, 200, { ok: result.ok, result, state: host.publicState(store) })
    return true
  }
  if (action === 'list') {
    // 纯读：列 worktree 不改库，不该推 revision（issue #17）
    req.__studioReadOnly = true
    const service = host.serviceOf(snapshotNow.config, task)
    const project = host.workProjectOf(snapshotNow.config, task)
    const repo = String(service?.repoPath ?? project?.repoPath ?? '').trim()
    const listed = repo.length === 0
      ? { ok: false, stdout: '', stderr: '项目没配本机代码目录' }
      : await runCommand('git', ['-C', repo, 'worktree', 'list', '--porcelain'], 20000)
    host.sendJson(res, 200, { ok: listed.ok, output: String(listed.stdout ?? ''), error: String(listed.stderr ?? ''), state: host.publicState(store) })
    return true
  }
  const info = await host.ensureWorktree(store, task, snapshotNow.config)
  host.sendJson(res, 200, {
    ok: info?.path !== undefined,
    worktree: info ?? null,
    skipped: info?.skipped ?? '',
    state: host.publicState(store),
  })
  return true
}
if (method === 'POST' && route === '/task/merge') {
  /* 真的去 GitLab 合并：门禁在服务端判，没过就拒绝。
     GitLab CE 没有「外部状态检查」，提交状态只是可见记录 —— 要让门禁生效，合并必须由平台执行。 */
  const body = await host.readJsonBody(req)
  rejectUnknownFields('/task/merge', body)
  try {
    const merged = await host.mergeMergeRequest(store, String(body.id ?? ''), { by: String(body.by ?? '人').slice(0, 40) })
    host.sendJson(res, 200, { ok: true, merge: merged, state: host.publicState(store) })
  } catch (error) {
    host.sendJson(res, 400, { ok: false, error: String(error?.message ?? error).slice(0, 300) })
  }
  return true
}
if (method === 'POST' && route === '/task/merge-gate') {
  // 合并门禁：算一次「能不能合」，并把结论发成 GitLab 提交状态（仓库开了「状态检查必须通过」时这就是合并按钮）。
  const body = await host.readJsonBody(req)
  rejectUnknownFields('/task/merge-gate', body)
  const id = String(body.id ?? '')
  if (body.publish === false) {
    // 只出结论不发状态：没配 GitLab 的机器也能验门禁本身（自检脚本走这条路）。
    const snapshot = store.snapshot()
    const task = snapshot.tasks.find(entry => entry.id === id)
    if (task === undefined) throw new Error(`no task ${id}`)
    host.sendJson(res, 200, { ok: true, gate: mergeGateFor(snapshot, task), mergeGate: task.mergeGate ?? null, published: false })
    return true
  }
  try {
    const result = await host.publishMergeGate(store, id, { by: String(body.by ?? '人').slice(0, 40) })
    host.sendJson(res, 200, { ok: true, gate: result.gate, mergeGate: result.status, published: true, state: host.publicState(store) })
  } catch (error) {
    // 没配 GitLab / 没有 MR / 发不出去：都是「做不了」，用 400 说清原因，别让面板只看到 500
    host.sendJson(res, 400, { ok: false, error: String(error?.message ?? error).slice(0, 300) })
  }
  return true
}
if (method === 'POST' && route === '/task/quality') {
  // 项目检查：在这个项目/服务的代码目录（有 worktree 就用 worktree）里跑一次质量命令，
  // 结果写回卡片，准出会按它拦。触发方式：卡片抽屉的「跑一次」，或专家调 studio_task_quality。
  const body = await host.readJsonBody(req)
  const id = String(body.id ?? '')
  const by = String(body.by ?? '人').slice(0, 40)
  /* 质量命令默认超时 120s（编译类门禁实测 113s 贴顶），同步跑会把请求线程占住：
     反代 60s 就断连，面板报错而命令还在跑，用户无从判断到底跑没跑。
     所以这里改成「提交即返回 202」：后台跑完把结果写回卡（runTaskQuality 本来就会写），
     前端靠已有的 /state 轮询看到结果。`wait:true` 保留同步语义给脚本/工具用。 */
  if (body.wait !== true) {
    host.sendJson(res, 202, { ok: true, queued: true, note: '已提交后台执行：跑完结果会写回这张卡（刷新可见），不用等在这里' })
    void runTaskQuality(store, id, { by }).catch(error => {
      /* recordAudit 由 index.js 注入；问号只为兼容不注它的老测试桩，线上不该缺。 */
      host.recordAudit?.(store, { by, route: '/task/quality', level: 'write', status: 500, ok: false, summary: `质量命令没跑成：${String(error?.message ?? error).slice(0, 120)}` })
    })
    return true
  }
  const result = await runTaskQuality(store, id, { by })
  const snapshot = store.snapshot()
  host.sendJson(res, 200, {
    ok: true,
    quality: result.quality,
    summary: qualitySummary(snapshot, result.task),
    gate: taskExitGate(snapshot, result.task),
    state: host.publicState(store),
  })
  return true
}
if (method === 'POST' && route === '/projects/save') {
  const body = await host.readJsonBody(req)
  const incoming = body.project ?? body
  if (String(incoming.name ?? '').trim() === '') throw new Error('项目名称不能为空')
  const existing = store.snapshot().config.projects
  const wantedId = cleanId(incoming.id ?? incoming.name ?? incoming.key, 'proj')
  const saved = existing.find(item => item.id === wantedId)
  const merged = { ...incoming, id: wantedId, iterations: incoming.iterations ?? saved?.iterations ?? [] }
  await host.applyConfig(store, { projects: host.upsertById(existing, merged) })
  host.sendJson(res, 200, { ok: true, projects: store.snapshot().config.projects, state: host.publicState(store) })
  return true
}
if (method === 'POST' && route === '/projects/delete') {
  const body = await host.readJsonBody(req)
  const id = cleanId(body.id, 'proj')
  /* 不存在就报错：以前删不掉的也回 200 ok:true，调用方以为删了（issue #16）。 */
  const existing = store.snapshot().config.projects
  if (!existing.some(entry => entry.id === id)) throw new Error(`no project ${id}`)
  /* deleteFolder=true 时连带删掉这个项目的云盘目录。默认不动：删台账和删文件是两件事。 */
  if (body.deleteFolder === true) await host.deleteProjectFolder(store, id).catch(() => {})
  await host.applyConfig(store, { projects: existing.filter(entry => entry.id !== id) })
  host.sendJson(res, 200, { ok: true, state: host.publicState(store) })
  return true
}
if (method === 'POST' && route === '/projects/iteration') {
  const body = await host.readJsonBody(req)
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
    return { ...project, iterations: host.upsertById(project.iterations, merged) }
  })
  await host.applyConfig(store, { projects })
  host.sendJson(res, 200, { ok: true, state: host.publicState(store) })
  return true
}
  return false
}
