// dsh-studio · 集成层：GitLab / 飞书 / 平台健康
// 从 index.js 拆出（P1 第三步）。本模块不 import index.js，宿主级能力由 configureIntegrations() 注入。

import { randomBytes } from 'node:crypto'
import { STATUSES, mergeCoding } from './domain.js'
import { MERGE_GATE_NAME, mergeGateFor, mergeGateLine, mergeGateNeedsRefresh, sanitizeMergeGate } from './merge-gate.js'
import { emitEvent } from './events.js'
import { withClarifyHistoryItem } from './acceptance.js'

let host = { newTaskId: () => '', serviceOf: () => null, getStore: () => null }

/** 由 index.js 在 mount 时注入宿主能力（不反向 import，避免成环）。 */
export function configureIntegrations(services) {
  host = { ...host, ...(services ?? {}) }
}


/** Last outcome of the GitLab / Feishu side calls, for the panel. */
export const INTEGRATION = { lastError: '', lastAt: 0, lastSyncError: '', lastPushError: '' }

/**
 * 外部集成的健康度。以前这些失败只写日志，人看不到；现在每条通道都记
 * 「最近一次成功 / 失败 / 连续失败次数」，面板上直接亮红。
 */
const CHANNELS = {
  feishu: { label: '飞书群通知', hint: '卡片状态变化往群里发消息的 webhook' },
  gitlab: { label: 'GitLab', hint: '拉 Issue、回写评论、对 MR' },
  drive: { label: '飞书云盘归档', hint: '需求文件夹与产物文档（lark-cli）' },
  /* WeKnora 出口以前不进健康面板：填错了只能等第一次归档才炸，面板上永远是绿的。 */
  weknora: { label: 'WeKnora 知识库', hint: '交付物投递到知识库（retrieve 能力）' },
  worktree: { label: '代码隔离', hint: 'git worktree 的创建与回收' },
  webhook: { label: '出站 webhook', hint: '卡片流转/用例失败/门禁/回归结果推给外部系统' },
}
const HEALTH = new Map()
export function healthState(channel) {
  if (!HEALTH.has(channel)) {
    HEALTH.set(channel, {
      channel,
      label: CHANNELS[channel]?.label ?? channel,
      hint: CHANNELS[channel]?.hint ?? '',
      ok: null,
      at: 0,
      lastOkAt: 0,
      lastErrorAt: 0,
      lastError: '',
      failures: 0,
      attempts: 0,
      skipped: 0,
    })
  }
  return HEALTH.get(channel)
}

/**
 * 集成健康不是看板数据：放 meta 的 side 键，重启后还在，但既不动 revision 也不追加快照。
 * 每几秒变一次的计数要是进 state，客户端会以为业务数据变了。
 */
const HEALTH_KEY = 'integration-health'
let flushTimer = null

/** 把内存里的健康表写回库；同一批变化只落一次盘。 */
function flushHealth() {
  const store = host.getStore?.()
  if (store === undefined || store === null || typeof store.writeSide !== 'function') return
  const saved = {}
  for (const [channel, entry] of HEALTH) saved[channel] = { ...entry }
  void store.writeSide(HEALTH_KEY, saved)
}

function scheduleHealthFlush() {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => { flushTimer = null; flushHealth() }, 2000)
  flushTimer.unref?.()
}

/** 启动时读回上一次的健康表：重启不该让四条通道全部回到「还没用过」。 */
export function restoreHealth() {
  const store = host.getStore?.()
  if (store === undefined || store === null || typeof store.readSide !== 'function') return
  void Promise.resolve(store.readSide(HEALTH_KEY)).then(saved => {
    if (saved === null || typeof saved !== 'object') return
    for (const [channel, entry] of Object.entries(saved)) {
      if (entry === null || typeof entry !== 'object') continue
      HEALTH.set(channel, { ...healthState(channel), ...entry, channel })
    }
  }).catch(() => { /* 读不回来就按全新启动 */ })
}

/** Record one integration attempt. Never throws: health tracking must not break the caller. */
export function markHealth(channel, outcome, detail = '') {
  try {
    const entry = healthState(channel)
    const at = Date.now()
    entry.at = at
    if (outcome === 'skip') {
      entry.skipped += 1
      return
    }
    entry.attempts += 1
    if (outcome === 'ok') {
      entry.ok = true
      entry.lastOkAt = at
      entry.failures = 0
      entry.lastError = ''
    } else {
      entry.ok = false
      entry.failures += 1
      entry.lastErrorAt = at
      entry.lastError = String(detail ?? '').slice(0, 300)
      escalateHealth(channel, entry)
    }
    scheduleHealthFlush()
  } catch {
    /* ignore */
  }
}

/**
 * 连着坏到阈值就升级到另一个群（或同群的机器人）：只在跨过阈值的那一次发，避免刷屏。
 * 用独立的 escalateWebhook，和日常通知分开，坏消息不会淹在状态流里。
 */
export function escalateHealth(channel, entry) {
  try {
    const state = host.getStore()?.snapshot()
    if (state === undefined) return
    const hook = String(state.config.feishu.escalateWebhook ?? '').trim()
    const after = Math.max(1, Number(state.config.feishu.escalateAfter) || 3)
    if (hook === '' || entry.failures !== after) return
    const label = CHANNELS[channel]?.label ?? channel
    void feishuPush(hook, `【集成异常升级】${label} 已连续失败 ${entry.failures} 次\n最近错误：${entry.lastError}\n最近时间：${new Date(entry.lastErrorAt).toLocaleString('zh-CN')}\n去「设置 → 集成健康」看一眼，或人工确认是否可以继续。`)
  } catch {
    /* 升级失败只能算了，不能反过来污染健康表 */
  }
}

/** Snapshot for the panel: only the channels that were actually used. */
export function healthReport() {
  const channels = []
  for (const [channel, meta] of Object.entries(CHANNELS)) {
    const entry = HEALTH.get(channel) ?? {
      channel,
      label: meta.label,
      hint: meta.hint,
      ok: null,
      at: 0,
      lastOkAt: 0,
      lastErrorAt: 0,
      lastError: '',
      failures: 0,
      attempts: 0,
      skipped: 0,
    }
    channels.push({
      channel,
      label: entry.label,
      hint: entry.hint,
      ok: entry.ok,
      at: entry.at,
      lastOkAt: entry.lastOkAt,
      lastErrorAt: entry.lastErrorAt,
      lastError: entry.lastError,
      failures: entry.failures,
      attempts: entry.attempts,
      skipped: entry.skipped,
      state: entry.ok === null ? 'idle' : entry.ok ? 'ok' : 'error',
    })
  }
  const broken = channels.filter(item => item.state === 'error')
  return { channels, broken: broken.length, checkedAt: Date.now() }
}


/** Auto-sync timer for GitLab; created in apply(), read by the status route. */

/** The live dispatcher, so tools can fan a mention out to an expert. */
/** 健康表在 emit 时需要读配置（升级 webhook 与阈值），这里留一个可空引用。 */

export function projectReady(config, project) {
  if (project === undefined) return false
  const url = project.url || config.gitlab.url
  const token = project.token || config.gitlab.token
  return url.length > 0 && token.length > 0 && project.project.length > 0
}

export function gitlabReady(config) {
  return (config.gitlab.projects ?? []).some(project => projectReady(config, project))
}

/** One GitLab REST call against one configured repository. */
export async function gitlabRequest(config, project, path, init) {
  const { quiet, ...rest } = init ?? {}
  const base = (project.url || config.gitlab.url).replace(/\/+$/, '')
  const token = project.token || config.gitlab.token
  const slug = encodeURIComponent(project.project)
  const headers = { 'PRIVATE-TOKEN': token }
  if (rest?.body !== undefined) headers['content-type'] = 'application/json'
  let response
  try {
    response = await fetch(`${base}/api/v4/projects/${slug}${path}`, { ...rest, headers })
  } catch (error) {
    if (quiet !== true) markHealth('gitlab', 'fail', `连不上 GitLab：${error?.message ?? error}`)
    throw error
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    // quiet 的调用（可选端点：changes / commits / test_report …）失败不该把整条通道判成不可用，
    // 否则一个没开 CI 的仓库会把「GitLab 已接通」直接翻成故障。
    if (quiet !== true) markHealth('gitlab', 'fail', `HTTP ${response.status} ${detail}`)
    throw new Error(`GitLab ${response.status}: ${detail}`)
  }
  if (quiet !== true) markHealth('gitlab', 'ok')
  if (response.status === 204) return null
  return await response.json()
}

/**
 * Pull open issues in as cards, one repository at a time. A card keeps the
 * project it came from (`gitlabProject`) and is matched on (project, iid) so
 * two repositories can both have issue #12.
 */
/** 一条 MR 的流水线、逐条提交、真实改动与 CI 单测结果（拿不到就当没有，不算失败）。 */
export async function gitlabMergeRequestDetail(config, project, iid) {
  const detail = { pipeline: null, changes: null, commits: [], ci: null }
  try {
    const pipelines = await gitlabRequest(config, project, `/merge_requests/${iid}/pipelines`, { quiet: true })
    const latest = Array.isArray(pipelines) ? pipelines[0] : undefined
    if (latest !== undefined) {
      detail.pipeline = {
        id: Number(latest.id) || 0,
        status: String(latest.status ?? ''),
        ref: String(latest.ref ?? ''),
        url: String(latest.web_url ?? ''),
        at: Date.now(),
      }
    }
  } catch { /* 没开 CI 或没权限，不算错 */ }
  try {
    const payload = await gitlabRequest(config, project, `/merge_requests/${iid}/changes`, { quiet: true })
    const list = Array.isArray(payload?.changes) ? payload.changes : []
    detail.changes = {
      files: list.slice(0, 300).map((entry, index) => ({
        id: `f${index + 1}`,
        path: String(entry.new_path ?? entry.old_path ?? '').slice(0, 300),
        change: entry.new_file === true ? 'added' : entry.deleted_file === true ? 'deleted' : 'modified',
        additions: 0,
        deletions: 0,
      })),
      commits: Number(payload?.commits_count) || 0,
    }
  } catch { /* 同上 */ }
  // 逐条提交：「自报 3 个提交」和「这 3 个提交真的在这个 MR 里」是两件事，后者要 sha 对得上。
  try {
    const list = await gitlabRequest(config, project, `/merge_requests/${iid}/commits?per_page=100`, { quiet: true })
    if (Array.isArray(list)) {
      detail.commits = list.slice(0, 100).map((entry, index) => ({
        id: String(entry?.id ?? entry?.short_id ?? `c${index + 1}`).slice(0, 60),
        sha: String(entry?.short_id ?? entry?.id ?? '').slice(0, 40),
        title: String(entry?.title ?? entry?.message ?? '').split('\n')[0].slice(0, 160),
        author: String(entry?.author_name ?? '').slice(0, 60),
      }))
    }
  } catch { /* 同上 */ }
  /* GitLab 15.3（极狐 CE 实测）的 /changes **不再返回 commits_count**：字段列表里有
     changes_count / overflow，没有提交数。以前只认 commits_count，于是「自报 1 个提交、MR 里 1 个」
     被判成「MR 里是 0 个」——真机上直接误伤。commits 端点已经拿到了逐条提交，用它兜底。 */
  if (detail.changes !== null && detail.changes.commits === 0 && detail.commits.length > 0) {
    detail.changes.commits = detail.commits.length
  }
  // 单测结果：GitLab 的 test_report 就是流水线跑出来的测试汇总；仓库没产出报告就退一步数 job 成败。
  if (detail.pipeline !== null && detail.pipeline.id > 0) {
    try {
      const report = await gitlabRequest(config, project, `/pipelines/${detail.pipeline.id}/test_report`, { quiet: true })
      const total = Number(report?.total_count) || 0
      if (total > 0) {
        detail.ci = {
          total,
          passed: Number(report.success_count) || 0,
          failed: Number(report.failed_count) || 0,
          skipped: (Number(report.skipped_count) || 0) + (Number(report.error_count) || 0),
          source: 'test_report',
        }
      }
    } catch { /* 老版本 GitLab 或权限不够 */ }
    if (detail.ci === null) {
      try {
        const jobs = await gitlabRequest(config, project, `/pipelines/${detail.pipeline.id}/jobs?per_page=100`, { quiet: true })
        if (Array.isArray(jobs) && jobs.length > 0) {
          detail.ci = {
            total: jobs.length,
            passed: jobs.filter(job => job?.status === 'success').length,
            failed: jobs.filter(job => job?.status === 'failed').length,
            skipped: jobs.filter(job => job?.status === 'skipped' || job?.status === 'canceled').length,
            source: 'jobs',
          }
        }
      } catch { /* 同上 */ }
    }
  }
  return detail
}

/**
 * 把 MR 和卡对上：先按「分支名里带卡号」认（一卡一 worktree 时分支就是 task/DEV-001），
 * 再按 issue 的 related_merge_requests 兜一次。对上之后记流水线状态与真实改动文件，
 * 开发中的卡一旦有打开的 MR 就自动进「待评审」——评审不是靠人盯着看。
 */
export async function gitlabSyncMergeRequests(store, config, project) {
  const state = store.snapshot()
  const byCode = new Map()
  for (const task of state.tasks) {
    const code = String(task.code ?? '').toLowerCase()
    if (code.length > 0) byCode.set(code, task)
  }
  const seen = new Map()
  let listed = []
  try {
    listed = await gitlabRequest(config, project, '/merge_requests?state=opened&per_page=50&order_by=updated_at')
  } catch { listed = [] }
  for (const mr of Array.isArray(listed) ? listed : []) {
    const iid = Number(mr.iid) || 0
    if (iid === 0) continue
    const branch = String(mr.source_branch ?? '').toLowerCase()
    const direct = state.tasks.find(task => String(task.gitlabProject ?? '') === project.id && (task.gitlabMR?.iid ?? 0) === iid)
    const hit = direct ?? [...byCode.entries()].find(([code]) => branch.includes(code))?.[1]
    if (hit === undefined) continue
    seen.set(hit.id, mr)
  }
  const candidates = state.tasks
    .filter(task => String(task.gitlabProject ?? '') === project.id)
    .filter(task => Number.isFinite(Number(task.gitlabIid)) && Number(task.gitlabIid) > 0)
    .filter(task => !seen.has(task.id))
    .filter(task => task.status === 'dev' || task.status === 'review' || (task.gitlabMR?.iid ?? 0) === 0)
    .slice(0, 12)
  for (const task of candidates) {
    const list = await gitlabRequest(config, project, `/issues/${Number(task.gitlabIid)}/related_merge_requests`).catch(() => [])
    if (!Array.isArray(list) || list.length === 0) continue
    const mr = list.find(item => item.state === 'opened') ?? list[0]
    if (Number(mr?.iid) > 0) seen.set(task.id, mr)
  }
  let matched = 0
  for (const [taskId, mr] of seen) {
    const task = state.tasks.find(entry => entry.id === taskId)
    if (task === undefined) continue
    const iid = Number(mr.iid) || 0
    const next = {
      iid,
      url: String(mr.web_url ?? ''),
      title: String(mr.title ?? '').slice(0, 200),
      state: String(mr.state ?? ''),
      sourceBranch: String(mr.source_branch ?? ''),
      targetBranch: String(mr.target_branch ?? ''),
      updatedAt: Date.now(),
    }
    const headSha = String(mr.sha ?? '')   // MR 的头提交：合并门禁的状态要挂在它上面
    const detail = await gitlabMergeRequestDetail(config, project, iid)
    if (detail.pipeline !== null) next.pipeline = detail.pipeline
    const same = (task.gitlabMR?.iid ?? 0) === iid
      && (task.gitlabMR?.state ?? '') === next.state
      && (task.gitlabMR?.pipeline?.id ?? 0) === (next.pipeline?.id ?? 0)
      && (task.gitlabMR?.pipeline?.status ?? '') === (next.pipeline?.status ?? '')
    if (same) {
      // 状态/流水线都没动，但换了新提交：门禁要跟着走（只在真的变了时才会重发）
      await refreshMergeGate(store, taskId, headSha)
      continue
    }
    await store.mutate(draft => {
      const target = draft.tasks.find(entry => entry.id === taskId)
      if (target === undefined) return
      target.gitlabMR = { ...(target.gitlabMR ?? { iid: 0, state: '' }), ...next }
      target.updatedAt = Date.now()
      // MR 里改了哪些文件 = 研发自报之外的真实证据；研发没登记就自动补上。
      if (detail.changes !== null && ((target.coding?.files ?? []).length === 0)) {
        target.coding = mergeCoding(target.coding ?? null, {
          branch: next.sourceBranch,
          files: detail.changes.files,
          commits: Array.from({ length: Math.min(detail.changes.commits, 20) }, (_, index) => ({
            id: `g${index + 1}`,
            sha: '',
            message: `MR !${iid} 的提交 ${index + 1}`,
            at: 0,
            files: 0,
            additions: 0,
            deletions: 0,
          })),
        })
      }
      if (next.state === 'opened' && target.status === 'dev') {
        const from = target.status
        target.status = 'review'
        target.role = 'architect'
        target.expert = ''
        target.history = [...(target.history ?? []), { at: Date.now(), by: 'gitlab', status: 'review', note: `MR !${iid} 已提交，转待评审` }]
        target.comments = [...(target.comments ?? []), {
          id: `${Date.now()}-${randomBytes(3).toString('hex')}`,
          at: Date.now(),
          author: 'GitLab',
          kind: 'agent',
          body: `MR !${iid} 关联到这张卡：${next.title}\n${next.url}\n\n开发阶段结束，已自动推进到「待评审」（原列：${from}）。${next.pipeline === undefined ? '' : `\n流水线：${next.pipeline.status}`}`,
        }]
      } else if (next.state === 'merged' && (target.status === 'dev' || target.status === 'review')) {
        const from = target.status
        target.status = 'test'
        target.role = 'qa'
        target.expert = ''
        target.history = [...(target.history ?? []), { at: Date.now(), by: 'gitlab', status: 'test', note: `MR !${iid} 已合并，转待测试` }]
        target.comments = [...(target.comments ?? []), {
          id: `${Date.now()}-${randomBytes(3).toString('hex')}`,
          at: Date.now(),
          author: 'GitLab',
          kind: 'agent',
          body: `MR !${iid} 已合并（原列：${from}），自动推进到「待测试」：现在应该在测试环境跑用例，通过后再收口。`,
        }]
      }
      if (next.pipeline?.status === 'failed') {
        target.comments = [...(target.comments ?? []), {
          id: `${Date.now()}-${randomBytes(3).toString('hex')}`,
          at: Date.now(),
          author: 'GitLab',
          kind: 'agent',
          body: `流水线失败：pipeline #${next.pipeline.id}（${next.pipeline.ref}）\n${next.pipeline.url}`,
        }]
      }
    })
    await refreshMergeGate(store, taskId, headSha)
    matched += 1
  }
  return { matched }
}

/**
 * 同步时顺手刷新合并门禁：GitLab 的提交状态挂在 commit 上，推了新提交旧结论就不代表这段代码。
 * 只在「头提交变了 / 结论变了 / 上次发失败」时重发（见 mergeGateNeedsRefresh），否则每 60 秒
 * 同步一轮会往 MR 页面灌一堆一模一样的状态。失败不打断同步。
 */
async function refreshMergeGate(store, taskId, sha) {
  try {
    const state = store.snapshot()
    const task = state.tasks.find(entry => entry.id === taskId)
    if (task === undefined) return
    if (Number(task.gitlabMR?.iid ?? 0) <= 0) return
    const gate = mergeGateFor(state, task)
    if (gate.applicable !== true) return
    if (mergeGateNeedsRefresh(task, { sha, ready: gate.ready }) !== true) return
    await publishMergeGate(store, taskId, { by: 'GitLab 同步' })
  } catch { /* 顺手发个状态而已，不能把整轮同步带红 */ }
}

/** 合并门禁的结果写回卡片（发布失败也写：面板要能区分「没发」和「发挂了」）。 */
async function writeMergeGate(store, taskId, record) {
  await store.mutate(state => {
    const target = state.tasks.find(entry => entry.id === taskId)
    if (target === undefined) return
    target.mergeGate = record
    target.updatedAt = Date.now()
  })
}

/**
 * 把这张卡的合并门禁发布成 GitLab 的提交状态（`studio/merge-gate`）。
 *
 * 为什么发提交状态而不是只在自己这边拦：真正的合并动作发生在 GitLab 上。
 * 仓库开了「状态检查必须通过（Status checks must succeed）」时，这条状态就是合并按钮上的灯——
 * failed 就是红的、合不了。没开那个设置时它至少是一条可核对的记录，比只写在评论里强。
 *
 * 状态必须挂在 **MR 的头提交** sha 上：挂在旧提交上，合并按钮显示的是上一次的结论。
 * 拿不到 sha 就明确报错，不发一个「挂在错地方」的状态。
 */
export async function publishMergeGate(store, taskId, { by = 'agent' } = {}) {
  const state = store.snapshot()
  const task = state.tasks.find(entry => entry.id === taskId)
  if (task === undefined) throw new Error(`no task ${taskId}`)
  const iid = Number(task.gitlabMR?.iid ?? 0)
  if (iid <= 0) throw new Error('这张卡还没关联 MR：先把 !iid 填进卡片的 GitLab 区块')
  const config = state.config
  const projects = config.gitlab?.projects ?? []
  const project = projects.find(item => item.id === task.gitlabProject) ?? projects[0]
  if (project === undefined) throw new Error('还没配 GitLab 项目（设置 → 代码仓库）')
  const gate = mergeGateFor(state, task)
  const description = mergeGateLine(gate).slice(0, 200)
  let mr = null
  try {
    mr = await gitlabRequest(config, project, `/merge_requests/${iid}`)
  } catch { /* MR 拉不到不致命：卡上可能已经有提交记录，用它兜底 */ }
  const sha = String(mr?.sha ?? '')
    || String(task.coding?.gitlab?.commitList?.[0]?.sha ?? '')
    || String((task.coding?.commits ?? []).at(-1)?.sha ?? '')
  const base = {
    at: Date.now(),
    by: String(by ?? 'agent').slice(0, 40),
    state: gate.ready ? 'success' : 'failed',
    name: MERGE_GATE_NAME,
    sha,
    iid,
    description,
    blockers: gate.blockers,
    error: '',
  }
  if (sha === '') {
    const record = sanitizeMergeGate({ ...base, state: 'failed', error: '拿不到 MR 的头提交 sha' })
    await writeMergeGate(store, taskId, record)
    throw new Error('拿不到 MR 的头提交 sha：GitLab 没返回 sha，卡上也还没有提交记录（先提交代码并推到 MR 分支）')
  }
  try {
    await gitlabRequest(config, project, `/statuses/${sha}`, {
      method: 'POST',
      body: JSON.stringify({ state: base.state, name: MERGE_GATE_NAME, description }),
    })
  } catch (error) {
    const record = sanitizeMergeGate({ ...base, state: 'failed', error: String(error?.message ?? error) })
    await writeMergeGate(store, taskId, record)
    throw error
  }
  const record = sanitizeMergeGate(base)
  await writeMergeGate(store, taskId, record)
  return { gate, status: record }
}

/**
 * 真的去 GitLab 合并这个 MR。
 *
 * 为什么要有这一步：GitLab CE 没有「外部状态检查」能力（极狐 15.3 实测：approvals 接口 404），
 * 提交状态只能当可见记录，拦不住人直接点合并。所以要让门禁**真的生效**，就得由平台自己执行合并：
 * 门禁过了才调 merge API，没过就拒绝。人绕开平台去 GitLab 点合并仍然可能，但那是绕过工具，
 * 不是工具没做——台账上这张卡不会记成「已合并」。
 */
export async function mergeMergeRequest(store, taskId, { by = 'agent' } = {}) {
  const state = store.snapshot()
  const task = state.tasks.find(entry => entry.id === taskId)
  if (task === undefined) throw new Error(`no task ${taskId}`)
  const iid = Number(task.gitlabMR?.iid ?? 0)
  if (iid <= 0) throw new Error('这张卡还没关联 MR：先把 !iid 填进卡片的 GitLab 区块')
  const config = state.config
  const projects = config.gitlab?.projects ?? []
  const project = projects.find(item => item.id === task.gitlabProject) ?? projects[0]
  if (project === undefined) throw new Error('还没配 GitLab 项目（设置 → 代码仓库）')
  const gate = mergeGateFor(state, task)
  if (gate.ready !== true) throw new Error(`合并门禁没过：${gate.blockers.join('；')}`)

  let mr
  try {
    mr = await gitlabRequest(config, project, `/merge_requests/${iid}/merge`, {
      method: 'PUT',
      body: JSON.stringify({ should_remove_source_branch: true }),
    })
  } catch (error) {
    // 405 / 406 是 GitLab 的「现在合不了」：把它的原话带回去（冲突、pipeline、审批没满足都在这里）
    throw new Error('GitLab 拒绝合并：' + String(error?.message ?? error).slice(0, 300))
  }
  const mergedSha = String(mr?.merge_commit_sha ?? mr?.squash_commit_sha ?? mr?.sha ?? '')
  const at = Date.now()
  await store.mutate(draft => {
    const target = draft.tasks.find(entry => entry.id === taskId)
    if (target === undefined) return
    target.gitlabMR = { ...(target.gitlabMR ?? {}), iid, state: String(mr?.state ?? 'merged'), url: String(mr?.web_url ?? target.gitlabMR?.url ?? '') }
    target.coding = mergeCoding(target.coding ?? null, { mergedBy: String(by).slice(0, 40), mergedAt: at })
    target.history = [...(target.history ?? []), {
      at, by: String(by).slice(0, 40), status: target.status,
      note: `已在 GitLab 合并 MR !${iid}${mergedSha === '' ? '' : `（merge commit ${mergedSha.slice(0, 8)}）`}`,
    }]
    target.updatedAt = at
  })
  emitEvent('task/merged', { taskId, iid, sha: mergedSha, by })
  return { iid, state: String(mr?.state ?? 'merged'), sha: mergedSha, task: store.snapshot().tasks.find(entry => entry.id === taskId) }
}

export async function gitlabSync(store, projectId) {
  const config = store.snapshot().config
  const projects = (config.gitlab.projects ?? []).filter(project => projectId === undefined || project.id === projectId)
  const ready = projects.filter(project => projectReady(config, project))
  if (ready.length === 0) throw new Error('GitLab 未配置：请先在设置里添加至少一个项目（地址 / 项目路径 / 访问令牌）')
  const summary = []
  for (const project of ready) {
    const params = new URLSearchParams({ state: 'opened', per_page: '50', order_by: 'updated_at' })
    if (project.syncLabel.length > 0) params.set('labels', project.syncLabel)
    try {
      const issues = await gitlabRequest(config, project, `/issues?${params.toString()}`)
      const created = []
      await store.mutate(state => {
        const known = new Set(
          state.tasks
            .filter(task => String(task.gitlabProject ?? '') === project.id)
            .map(task => Number(task.gitlabIid))
            .filter(Number.isFinite),
        )
        for (const issue of issues) {
          if (known.has(Number(issue.iid))) continue
          const now = Date.now()
          const labels = Array.isArray(issue.labels) ? issue.labels.map(String) : []
          // 带 bug 标签的 Issue 直接建成缺陷卡，P0~P3 标签顺便当严重级别。
          const isBug = labels.some(label => /^(bug|defect|缺陷|故障)$/i.test(label.trim()))
          const severityLabel = labels.map(label => label.trim().toLowerCase()).find(label => /^p[0-3]$/.test(label))
          const entryStatus = isBug ? 'dev_ready' : 'clarify'
          // 从 GitLab 拉进来的卡也照模板铺验收清单，不然它一进流程就是个没有「做完」定义的空卡。
          const template = state.config.templates[isBug ? 'bug' : 'requirement'] ?? []
          // GitLab 导入是另一条建卡路径：漏了它，导进来的澄清卡就没有这道门禁（REQ-2026-001 / p3）。
          const checklist = withClarifyHistoryItem(
            template.map((text, index) => ({ id: `c${index + 1}`, text, done: false, by: '', at: 0, note: '' })),
            entryStatus,
          )
          state.tasks.unshift({
            id: host.newTaskId(),
            title: `#${issue.iid} ${issue.title}`.slice(0, 200),
            type: isBug ? 'bug' : 'requirement',
            status: entryStatus,
            role: isBug ? 'dev' : 'product',
            severity: isBug ? (severityLabel ?? 'p2') : '',
            expert: isBug ? 'dev' : 'product',
            priority: isBug && severityLabel === 'p0' ? 'urgent' : 'normal',
            requirement: String(issue.description ?? '').slice(0, 20000),
            gitlabIssue: String(issue.web_url ?? ''),
            gitlabIid: Number(issue.iid),
            gitlabProject: project.id,
            gitlabMR: { iid: 0, url: '', title: '', state: '' },
            feishuThread: '',
            owner: '',
            project: '',
            iteration: '',
            parent: '',
            dueAt: 0,
            blocked: null,
            blockedReason: '',
            artifacts: [],
            checklist,
            cases: [],
            tags: labels.slice(0, 12),
            createdAt: now,
            updatedAt: now,
            comments: [],
            history: [{ at: now, by: 'gitlab', status: entryStatus }],
          })
          created.push(project.id)
        }
        const record = state.config.gitlab.projects.find(entry => entry.id === project.id)
        if (record !== undefined) {
          record.lastSyncAt = Date.now()
          record.lastSyncError = ''
        }
      })
      summary.push({ project: project.id, name: project.name, fetched: issues.length, created: created.length })
      const mrs = await gitlabSyncMergeRequests(store, config, project).catch(error => ({ matched: 0, error: String(error?.message ?? error).slice(0, 200) }))
      if (mrs.matched > 0 || mrs.error !== undefined) summary.push({ project: project.id, mergeRequests: mrs })
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 300)
      await store.mutate(state => {
        const record = state.config.gitlab.projects.find(entry => entry.id === project.id)
        if (record !== undefined) record.lastSyncError = message
      }).catch(() => {})
      summary.push({ project: project.id, name: project.name, error: message })
    }
  }
  const firstError = summary.find(entry => entry.error !== undefined)
  INTEGRATION.lastSyncError = firstError?.error ?? ''
  return { projects: summary }
}

/** Post one text message through one Feishu custom-bot webhook. */
/** 通知正文：字符串直接用，对象取 text/content。以前两种写法混用，导致群里收到「[object Object]」。 */
export function feishuText(body) {
  if (typeof body === 'string') return body.slice(0, 4000)
  const value = body !== null && typeof body === 'object' ? body.text ?? body.content ?? '' : ''
  return String(value).slice(0, 4000)
}

export async function feishuPush(webhook, body) {
  if (typeof webhook !== 'string' || webhook.length === 0) {
    markHealth('feishu', 'skip')
    return { ok: false, skipped: true }
  }
  const text = feishuText(body)
  if (text.trim() === '') return { ok: false, skipped: true, error: '通知正文是空的' }
  let lastError = null
  // 群里掉一条消息没人会发现，所以发两次；仍失败才算真的失败。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msg_type: 'text', content: { text } }),
      })
      const payload = (await response.text()).slice(0, 300)
      if (!response.ok) throw new Error(`飞书 ${response.status}: ${payload}`)
      // 飞书 webhook 失败时也可能回 200，真正的结果在 body 里。
      try {
        const parsed = JSON.parse(payload)
        const code = Number(parsed?.code ?? parsed?.StatusCode ?? 0)
        if (code !== 0) throw new Error(`飞书返回 code=${code} ${String(parsed?.msg ?? '').slice(0, 120)}`)
      } catch (error) {
        if (error instanceof SyntaxError) {
          /* 不是 JSON，就按 HTTP 状态算成功 */
        } else {
          throw error
        }
      }
      markHealth('feishu', 'ok')
      return { ok: true, payload }
    } catch (error) {
      lastError = error
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 400))
    }
  }
  markHealth('feishu', 'fail', lastError?.message ?? String(lastError))
  throw lastError ?? new Error('飞书推送失败')
}

/** 每个群想收哪些事件由 bot.events 决定：change / sla / bug / release。 */
export function botWants(bot, kind) {
  if (bot === null || typeof bot !== 'object') return false
  if (bot.enabled === false) return false
  if (String(bot.webhook ?? '') === '') return false
  const events = bot.events !== null && typeof bot.events === 'object' ? bot.events : null
  if (events === null) return kind === 'change' ? bot.notifyOnChange !== false : true
  if (kind === 'change' && bot.notifyOnChange === false) return false
  return events[kind] !== false
}

/** Send one message to every enabled bot that subscribes to this event kind. */
export async function feishuBroadcast(config, body, kind = 'change') {
  const bots = (config.feishu.bots ?? []).filter(bot => botWants(bot, kind))
  const results = []
  for (const bot of bots) {
    try {
      const result = await feishuPush(bot.webhook, body)
      results.push({ bot: bot.id, ok: result.ok })
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 300)
      INTEGRATION.lastPushError = message
      results.push({ bot: bot.id, ok: false, error: message })
    }
  }
  return results
}

/** The repository a card came from, when it came from one. */
export function projectOf(config, task) {
  const id = String(task.gitlabProject ?? '')
  if (id.length > 0) {
    const found = (config.gitlab.projects ?? []).find(project => project.id === id)
    if (found !== undefined) return found
  }
  // 卡上没记来源仓时，用「服务 → 关联仓库」兜一次（一个项目多个服务时按服务走）。
  const service = host.serviceOf(config, task)
  if (service !== undefined && String(service.repoId ?? '').length > 0) {
    return (config.gitlab.projects ?? []).find(project => project.id === service.repoId)
  }
  return undefined
}

/**
 * Fan one board change out to the outside world: a message to every configured
 * Feishu group and, for a card that came from GitLab, a note on its issue. Both
 * are best effort — a failure is recorded instead of failing the board write.
 */
export function broadcastChange(store, task, from, to, by, kind) {
  const config = store.snapshot().config
  INTEGRATION.lastAt = Date.now()
  const fromLabel = STATUSES.find(entry => entry.id === from)?.label ?? from
  const toLabel = STATUSES.find(entry => entry.id === to)?.label ?? to
  const headline = kind === 'blocked'
    ? `【阻塞】${task.title}\n停在「${toLabel}」，原因：${task.blocked?.reason || '未填写'}\n操作人：${by}`
    : kind === 'unblocked'
      ? `【解除阻塞】${task.title}\n继续在「${toLabel}」\n操作人：${by}`
      : `【需求&任务工作空间】${task.title}\n${fromLabel} → ${toLabel}\n操作人：${by}`
  const line = kind === 'blocked' || kind === 'unblocked' ? headline : headline
  feishuBroadcast(config, line).catch(error => {
    INTEGRATION.lastPushError = String(error?.message ?? error).slice(0, 300)
  })
  const project = projectOf(config, task)
  if (project !== undefined && projectReady(config, project) && Number.isFinite(Number(task.gitlabIid))) {
    const note = kind === 'blocked'
      ? `阻塞：停在「${toLabel}」，原因：${task.blocked?.reason || '未填写'}（${by}）`
      : kind === 'unblocked'
        ? `解除阻塞：继续在「${toLabel}」（${by}）`
        : `需求&任务工作空间：${fromLabel} → ${toLabel}（${by}）`
    gitlabRequest(config, project, `/issues/${Number(task.gitlabIid)}/notes`, {
      method: 'POST',
      body: JSON.stringify({ body: note }),
    }).catch(error => { INTEGRATION.lastPushError = String(error?.message ?? error).slice(0, 300) })
  }
  // 有 MR 的卡，状态变化也写回 MR 讨论区——评审的人在 MR 里就能看到卡走到哪了。
  if (project !== undefined && projectReady(config, project) && Number(task.gitlabMR?.iid ?? 0) > 0) {
    const mrNote = kind === 'blocked'
      ? `看板：这张 MR 对应的卡被标阻塞，停在「${toLabel}」，原因：${task.blocked?.reason || '未填写'}（${by}）`
      : kind === 'unblocked'
        ? `看板：阻塞已解除，继续在「${toLabel}」（${by}）`
        : `看板：${fromLabel} → ${toLabel}（${by}）`
    gitlabRequest(config, project, `/merge_requests/${Number(task.gitlabMR.iid)}/notes`, {
      method: 'POST',
      body: JSON.stringify({ body: mrNote }),
    }).catch(error => { INTEGRATION.lastPushError = String(error?.message ?? error).slice(0, 300) })
  }
}
