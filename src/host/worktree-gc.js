/**
 * worktree 目录体检的纯逻辑（CLI 在 `tools/worktree-gc.mjs`，`npm run worktree:gc`）。
 *
 * 为什么要有：`.agents/worktrees/` 下面只有「已注册的 git worktree」才算活的；合并完
 * 用完 `git worktree remove` 之后，如果目录里还有没被清理的东西（node_modules 联接、
 * 构建产物、漏删的文件），目录会留在原地，`git worktree list` 里却看不到 —— 于是
 * 越攒越多，2026-11-27 本仓库攒了 19 个、148 MB，谁也不知道哪些能删。
 *
 * 判据只有一条：**不在 `git worktree list` 里 = 孤儿**。这里不猜、不看分支名，
 * 也不根据目录名推断归属；老化时间与体积由调用方量好传进来（fs 不进纯函数）。
 */

/**
 * @param {object} input
 * @param {Array<{ name: string, path?: string, ageDays?: number, sizeBytes?: number, hasSymlinkChildren?: boolean }>} input.dirs 扫到的目录
 * @param {string[]} input.registered `git worktree list --porcelain` 里的 worktree 路径
 * @param {number} [input.minAgeDays] 少于这么多天的孤儿先不动（防止刚删工作树、目录还没落定的情况）
 * @returns {{ orphans: object[], kept: object[], summary: { total: number, orphanBytes: number, removableBytes: number } }}
 */
export function classifyWorktrees({ dirs, registered, minAgeDays = 7 } = {}) {
  const list = Array.isArray(dirs) ? dirs : []
  const known = new Set((Array.isArray(registered) ? registered : []).map(normalizePath))
  const minAge = Math.max(0, Number(minAgeDays) || 0)
  const orphans = []
  const kept = []
  for (const dir of list) {
    const name = String(dir?.name ?? '')
    if (name === '') continue
    const path = normalizePath(dir.path ?? name)
    const entry = {
      name,
      path,
      ageDays: Number.isFinite(dir.ageDays) ? Math.max(0, Math.round(Number(dir.ageDays))) : 0,
      sizeBytes: Math.max(0, Number(dir.sizeBytes) || 0),
      hasSymlinkChildren: dir.hasSymlinkChildren === true,
      registered: known.has(path),
    }
    if (entry.registered) { kept.push(entry); continue }
    entry.removable = entry.ageDays >= minAge
    entry.reason = entry.removable ? '孤儿' : `孤儿但不到 ${minAge} 天`
    orphans.push(entry)
  }
  const sum = (rows, pick) => rows.reduce((total, row) => total + (pick(row) ? row.sizeBytes : 0), 0)
  return {
    orphans: orphans.sort((a, b) => b.sizeBytes - a.sizeBytes),
    kept: kept.sort((a, b) => a.name.localeCompare(b.name)),
    summary: {
      total: list.length,
      orphanBytes: sum(orphans, () => true),
      removableBytes: sum(orphans, row => row.removable),
    },
  }
}

/** 一行结论：CLI 与测试共用，免得两处文案各说各的。 */
export function worktreeGcLine(result, { apply = false, minAgeDays = 7 } = {}) {
  const summary = result?.summary ?? { total: 0, orphanBytes: 0, removableBytes: 0 }
  const orphans = (result?.orphans ?? []).length
  if (summary.total === 0) return '没有 worktree 目录，无需清理'
  if (orphans === 0) return `${summary.total} 个 worktree 目录都有登记，无需清理`
  const size = formatBytes(summary.orphanBytes)
  const head = `孤儿 ${orphans} / 共 ${summary.total} 个（${size}）`
  if (!apply) return `${head}：${formatBytes(summary.removableBytes)} 可清（超过 ${minAgeDays} 天），加 --apply 真删`
  return `${head}：已清理 ${formatBytes(summary.removableBytes)}`
}

export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0)
  if (value < 1024) return value + ' B'
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
  if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB'
  return (value / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

/** Windows 上 `git worktree list` 会给反斜杠，路径比较前统一成斜杠、去掉尾斜杠。 */
export function normalizePath(path) {
  return String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}
