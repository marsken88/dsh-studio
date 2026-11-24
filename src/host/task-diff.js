/* 卡上的真实代码改动：把 git 的 numstat / 统一 diff 变成面板能直接画的数据。
 *
 * 为什么单独成模块：
 *   1. 「研发改了什么代码」以前只有 agent 自报的文件名列表，看板上看不到 patch ——
 *      人要看代码只能自己去仓库敲 git diff。这里把「读仓库事实」的解析部分拆成纯函数，
 *      单测不需要真仓库；IO（git 调用）在 routes/coding.js。
 *   2. 解析要能对付 git 的三种格式：numstat（- - 表示二进制）、统一 diff（按文件切）、
 *      status --porcelain（未提交改动）。写错一个字符，面板就会把「--」当成 0 行改动。
 *
 * 输出形状（buildDiffView）：
 *   { files: [{ path, additions, deletions, binary, patch, truncated }],
 *     totals: { files, additions, deletions }, omitted, truncated }
 * files 里带 patch 的才是能展开看的；超出预算的文件只计数不搬运，并如实标 truncated。
 *
 * 另外两个出口（同一份解析口径，别在别处再抄一遍）：
 *   readWorktreeFacts / collectCodingFromWorktree —— 卡进「待评审」时从 worktree 读事实，
 *   研发忘了登记执行记录时由平台补一条（agent 标成「git 自动采集」，不冒充研发自报）。
 */

import { sanitizeCoding } from './domain.js'

/** 一次最多搬多少 diff 到面板。宁可选大文件少几个，也不能把整仓 diff 塞进响应把面板卡死。 */
export const DIFF_LIMITS = {
  files: 30, // 最多展开多少个文件的 patch
  perFileBytes: 16_000,
  perFileLines: 400,
  totalBytes: 120_000,
}

/** git diff --numstat → [{ path, additions, deletions, binary }]；顺序保持 git 给的（按路径）。 */
export function parseNumstat(text) {
  const rows = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const [adds, dels, ...rest] = parts
    const path = rest.join('\t').trim()
    if (path === '') continue
    const binary = adds === '-' || dels === '-'
    rows.push({
      path,
      additions: binary ? 0 : Math.max(0, Number(adds) || 0),
      deletions: binary ? 0 : Math.max(0, Number(dels) || 0),
      binary,
    })
  }
  return rows
}

/** 统一 diff 按文件切开：key 取 `diff --git a/x b/y` 里的新路径。 */
export function splitPatch(text) {
  const map = new Map()
  const raw = String(text ?? '')
  const marks = [...raw.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)]
  for (const [index, mark] of marks.entries()) {
    const from = mark.index ?? 0
    const to = index + 1 < marks.length ? (marks[index + 1].index ?? raw.length) : raw.length
    map.set(mark[2].trim(), raw.slice(from, to))
  }
  return map
}

/** numstat 里的改名路径（`src/{a => b}.js` / `a.js => b.js`）对不上 patch 的 b 路径时，按右侧再试一次。 */
export function patchFor(chunks, path) {
  const direct = chunks.get(path)
  if (direct !== undefined) return direct
  if (path.includes('=>')) {
    const right = path.slice(path.lastIndexOf('=>') + 2).replace(/[{}]/g, '').trim()
    if (right !== '' && chunks.has(right)) return chunks.get(right)
  }
  // 改名简写 `src/{old => new}/x.js` 的正解在 b/ 侧：用文件名后缀兜底
  const tail = path.split('/').pop() ?? ''
  if (tail !== '') {
    for (const [key, value] of chunks) if (key.endsWith('/' + tail) || key === tail) return value
  }
  return ''
}

/** git status --porcelain → [{ path, state }]；state 归一成 added / modified / deleted / renamed / untracked。 */
export function parseStatusList(text) {
  const rows = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue
    const code = line.slice(0, 2)
    // 改名行是 `R  old -> new`：面板只关心新路径
    const raw = line.slice(3).trim()
    const path = raw.includes(' -> ') ? raw.slice(raw.lastIndexOf(' -> ') + 4) : raw
    if (path === '') continue
    const state = code === '??'
      ? 'untracked'
      : code.includes('R')
        ? 'renamed'
        : code.includes('D')
          ? 'deleted'
          : code.includes('A')
            ? 'added'
            : 'modified'
    rows.push({ path, state })
  }
  return rows
}

/** 把一个文件的 patch 截到面板能安全渲染的长度（按字节 + 行数两道闸）。 */
export function boundPatch(patch, limits = {}) {
  const cfg = { ...DIFF_LIMITS, ...(limits ?? {}) }
  let text = String(patch ?? '')
  let truncated = false
  if (text.length > cfg.perFileBytes) {
    text = text.slice(0, cfg.perFileBytes) + '\n…（这个文件的 diff 太长，已截断）'
    truncated = true
  }
  const lines = text.split('\n')
  if (lines.length > cfg.perFileLines) {
    text = lines.slice(0, cfg.perFileLines).join('\n') + '\n…（这个文件的 diff 太长，已截断）'
    truncated = true
  }
  return { patch: text, truncated }
}

/** numstat + 统一 diff → 面板形状（文件、逐文件 patch、总数、被省略的数量）。 */
export function buildDiffView({ numstat, patch, limits } = {}) {
  const cfg = { ...DIFF_LIMITS, ...(limits ?? {}) }
  const rows = parseNumstat(numstat)
  const chunks = splitPatch(patch)
  const files = []
  let budget = Math.max(0, Number(cfg.totalBytes) || 0)
  let omitted = 0
  let truncated = false
  for (const row of rows) {
    if (files.length >= cfg.files || budget <= 0) {
      omitted += 1
      continue
    }
    const bounded = boundPatch(patchFor(chunks, row.path), cfg)
    let text = bounded.patch
    if (text.length > budget) {
      text = text.slice(0, Math.max(0, budget)) + '\n…（改动太多，后面的文件不再展开）'
      truncated = true
    }
    budget -= text.length
    if (bounded.truncated || text.length < bounded.patch.length) truncated = true
    files.push({
      path: row.path,
      additions: row.additions,
      deletions: row.deletions,
      binary: row.binary,
      patch: text,
      truncated: bounded.truncated || text.length < bounded.patch.length,
    })
  }
  const totals = rows.reduce((sum, row) => ({
    files: sum.files + 1,
    additions: sum.additions + row.additions,
    deletions: sum.deletions + row.deletions,
  }), { files: 0, additions: 0, deletions: 0 })
  return { files, totals, omitted, truncated: truncated || omitted > 0 }
}

/** 一句话概括，给卡面 / 日志用：`3 个文件 +42 −7`。 */
export function diffSummaryLine(view) {
  const totals = view?.totals ?? { files: 0, additions: 0, deletions: 0 }
  if (totals.files === 0) return '没有代码改动'
  return `${totals.files} 个文件 +${totals.additions} −${totals.deletions}${view?.truncated === true ? '（已截断）' : ''}`
}

/** 从 worktree 读 git 事实：分支、基线、提交、改动文件。读不到就返回 null（不猜）。 */
export async function readWorktreeFacts({ git, dir, base }) {
  const at = `${dir}`
  const head = await git(['-C', at, 'rev-parse', '--abbrev-ref', 'HEAD'])
  if (head.ok !== true) return null
  const branch = String(head.stdout ?? '').trim()
  const wanted = String(base ?? '').trim() || 'main'
  const resolved = await git(['-C', at, 'rev-parse', '--verify', '--quiet', `${wanted}^{commit}`])
  if (resolved.ok !== true) return null
  const log = await git(['-C', at, 'log', '--format=%h%x09%s', `${wanted}..HEAD`, '-n', '50'])
  const commits = String(log.stdout ?? '').trim().split(/\r?\n/).filter(line => line.trim() !== '').map(line => {
    const [sha, ...rest] = line.split('\t')
    return { sha: String(sha ?? '').trim(), message: rest.join('\t').trim(), files: '' }
  })
  const numstat = await git(['-C', at, 'diff', '--numstat', `${wanted}...HEAD`])
  const files = parseNumstat(numstat.stdout).map(row => ({
    path: row.path,
    change: row.additions > 0 && row.deletions === 0 ? 'added' : row.additions === 0 && row.deletions > 0 ? 'deleted' : 'modified',
    additions: row.additions,
    deletions: row.deletions,
  }))
  if (commits.length === 0 && files.length === 0) return null
  return { branch, base: wanted, commits, files }
}

/**
 * 研发没登记执行记录时，从 worktree 的 git 事实补一条（平台采集，不做推断）。
 *
 * 为什么要有：看板上「看不到改动的代码」最常见的根因不是界面，而是**记录根本没写** ——
 * agent 干完活忘了调 studio_task_coding，卡上就只剩一句「已完成」的评论。卡进「待评审」时
 * 从分支读提交与改动文件补一条，agent 写成「git 自动采集」，和自报记录能区分开；
 * 研发自己登记过的字段一个都不覆盖，只补空着的部分。
 *
 * store / git / commentTask 都由调用方注入（executor 提供 runCommand 与 commentTask），
 * 这样这里不必反向 import executor，也能用桩单测。
 */
export async function collectCodingFromWorktree(store, taskId, deps = {}) {
  const git = deps.git
  const addComment = deps.commentTask
  if (typeof git !== 'function' || typeof store?.mutate !== 'function') return null
  const state = store.snapshot()
  const task = state.tasks.find(entry => entry.id === taskId)
  if (task === undefined) return null
  const info = task.worktree ?? null
  const dir = String(info?.path ?? '').trim()
  if (dir === '') return null
  const existing = task.coding ?? null
  const hasCommits = (existing?.commits ?? []).length > 0
  const hasFiles = (existing?.files ?? []).length > 0
  if (hasCommits && hasFiles) return null
  const facts = await readWorktreeFacts({ git, dir, base: info?.base })
  if (facts === null) return null
  const note = existing === null
    ? `平台从 git 自动采集执行记录：分支 ${facts.branch}（基线 ${facts.base}）· ${facts.commits.length} 提交 · ${facts.files.length} 个文件`
    : `平台从 git 补全执行记录：分支 ${facts.branch}（基线 ${facts.base}）· ${facts.commits.length} 提交 · ${facts.files.length} 个文件`
  await store.mutate(draft => {
    const target = draft.tasks.find(entry => entry.id === taskId)
    if (target === undefined) return
    const current = target.coding ?? {}
    target.coding = sanitizeCoding({
      ...current,
      branch: String(current.branch ?? '').trim() || facts.branch,
      context: String(current.context ?? '').trim() || `基线 ${facts.base}（平台从 git 采集）`,
      agent: String(current.agent ?? '').trim() || 'git 自动采集（研发没登记执行记录）',
      commits: (current.commits ?? []).length > 0 ? current.commits : facts.commits,
      files: (current.files ?? []).length > 0 ? current.files : facts.files,
    })
    target.history = [...(target.history ?? []), { at: Date.now(), by: '系统', status: target.status, note }]
  })
  if (typeof addComment === 'function') {
    try {
      await addComment(store, taskId, `**${note}**\n\n研发没登记 studio_task_coding，平台从这张卡的 worktree 直接读了分支与改动文件补上；数字来自 git，不是猜的。`, '系统', 'agent')
    } catch { /* 自动采集的评论失败不影响推进 */ }
  }
  return { branch: facts.branch, base: facts.base, commits: facts.commits.length, files: facts.files.length }
}
