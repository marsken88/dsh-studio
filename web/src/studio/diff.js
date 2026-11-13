/* 需求基线对比用的行级 diff。纯函数，不进 React，方便单测。 */

const LIMIT = 800

/** 拆行；顺手吃掉文本框末尾多出来的那个空行。 */
export function splitLines(text) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n')
  if (raw === '') return []
  const lines = raw.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 行级 diff（LCS）。返回 [{ kind: 'same' | 'add' | 'del', text }]。
 * 文件太大就只给个整体说明——O(n*m) 的 DP 在长文上会把页面卡住。
 */
export function diffLines(before, after) {
  const a = splitLines(before)
  const b = splitLines(after)
  if (a.length > LIMIT || b.length > LIMIT) {
    return [
      { kind: 'del', text: `（原基线 ${a.length} 行，超过 ${LIMIT} 行的对比上限）` },
      { kind: 'add', text: `（当前文档 ${b.length} 行）` },
    ]
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const rows = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { rows.push({ kind: 'same', text: a[i] }); i += 1; j += 1; continue }
    if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ kind: 'del', text: a[i] }); i += 1; continue }
    rows.push({ kind: 'add', text: b[j] })
    j += 1
  }
  while (i < a.length) { rows.push({ kind: 'del', text: a[i] }); i += 1 }
  while (j < b.length) { rows.push({ kind: 'add', text: b[j] }); j += 1 }
  return rows
}

/** 只数增删，给标题行用。 */
export function diffSummary(rows) {
  const list = Array.isArray(rows) ? rows : []
  return {
    added: list.filter(row => row.kind === 'add').length,
    removed: list.filter(row => row.kind === 'del').length,
    same: list.filter(row => row.kind === 'same').length,
  }
}
