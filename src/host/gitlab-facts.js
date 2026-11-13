// AI Coding 执行记录「自报值 vs 仓库事实」的对账。纯函数，方便单测；
// 取数（MR / changes / commits）在 integrations 里，这里只管比。

/** 把自报的文件数、提交数和 MR 里的事实比一遍，返回可以直接写进 card.coding.gitlab 的结果。 */
export function compareCodingFacts(coding, mr, detail, now = Date.now()) {
  const declaredFiles = Array.isArray(coding?.files) ? coding.files.length : 0
  const declaredCommits = Array.isArray(coding?.commits) ? coding.commits.length : 0
  const actualFiles = Array.isArray(detail?.changes?.files) ? detail.changes.files.length : 0
  const actualCommits = Number(detail?.changes?.commits) || 0
  const mismatches = []
  if (declaredFiles !== actualFiles) mismatches.push(`自报 ${declaredFiles} 个文件，MR 里是 ${actualFiles} 个`)
  if (declaredCommits !== actualCommits) mismatches.push(`自报 ${declaredCommits} 个提交，MR 里是 ${actualCommits} 个`)
  return {
    at: now,
    state: String(mr?.state ?? ''),
    title: String(mr?.title ?? '').slice(0, 200),
    pipeline: detail?.pipeline === null || detail?.pipeline === undefined ? null : String(detail.pipeline.status ?? ''),
    files: { declared: declaredFiles, actual: actualFiles },
    commits: { declared: declaredCommits, actual: actualCommits },
    mismatches: mismatches.slice(0, 6),
  }
}
