/* 会话归档目录的清理规则（纯函数）。
 *
 * 为什么需要：派单会话被模型漂移接管、卡被中止、进程重启时，dispatcher 会把旧会话目录
 * 搬到 `~/.dsh/sessions-archive`（故意不放在 sessions/ 下，免得宿主把它当工作区扫描）。
 * 但那里只增不减 —— 一天几十次派单，几个月就是几万个目录、几个 GB。
 *
 * 口径（宁可留多，不可误删）：
 *   · 只处理 `*.stale-<时间戳>` 这种**我们自己搬进去的**名字；
 *   · 其它名字（人手动放的、别的工具放的）一律保留；
 *   · 最近 `keepDays` 天内的保留（排障常常要回看上周的会话）；
 *   · 另按数量兜底：按时间倒序，前 `keepCount` 个保留。
 */

/** 归档目录名 → 时间戳（毫秒）；不是我们命名的返回 null。 */
export function archiveStamp(name) {
  const match = /\.stale-(\d{10,16})$/.exec(String(name ?? ''))
  if (match === null) return null
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * 决定删哪些。
 *
 * @param {Array<{name:string, mtime?:number}>} entries 归档目录下的条目
 * @param {{now?:number, keepDays?:number, keepCount?:number}} options
 * @returns {{remove:Array<{name:string, ageDays:number}>, keep:Array<{name:string, reason:string}>}}
 */
export function archivePlan(entries, options = {}) {
  const now = Number(options.now ?? Date.now())
  const keepDays = Number.isFinite(Number(options.keepDays)) ? Number(options.keepDays) : 30
  const keepCount = Number.isFinite(Number(options.keepCount)) ? Number(options.keepCount) : 200
  const list = Array.isArray(entries) ? entries : []
  const ours = []
  const keep = []
  for (const entry of list) {
    const name = String(entry?.name ?? '')
    const stamp = archiveStamp(name)
    if (stamp === null) {
      keep.push({ name, reason: '不是派单归档的命名，保留' })
      continue
    }
    ours.push({ name, stamp, mtime: Number(entry?.mtime ?? stamp) })
  }
  ours.sort((a, b) => b.mtime - a.mtime)
  const remove = []
  ours.forEach((entry, index) => {
    const ageDays = Math.max(0, (now - entry.mtime) / 86_400_000)
    if (index < keepCount && ageDays <= keepDays) {
      keep.push({ name: entry.name, reason: `最近 ${Math.round(ageDays)} 天 / 前 ${index + 1} 个，保留` })
      return
    }
    remove.push({ name: entry.name, ageDays: Math.round(ageDays * 10) / 10 })
  })
  return { remove, keep }
}
