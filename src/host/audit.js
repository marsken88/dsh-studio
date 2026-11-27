/* 审计条目的数据形状：只留摘要，不记正文与密钥。从 domain.js 抬出来。 */

export function sanitizeAuditEntry(raw, index) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const route = String(input.route ?? '').slice(0, 120)
  if (route === '') return null
  return {
    id: String(input.id ?? `au-${index}`).slice(0, 60),
    at: Number.isFinite(input.at) ? Number(input.at) : 0,
    by: String(input.by ?? '').slice(0, 40) || '人',
    route,
    level: ['read', 'write', 'admin'].includes(input.level) ? input.level : 'write',
    status: Number.isFinite(input.status) ? Number(input.status) : 0,
    ok: input.ok === true,
    summary: String(input.summary ?? '').slice(0, 200),
  }
}

export function sanitizeAudit(input) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const raw of input.slice(-1000)) {
    const item = sanitizeAuditEntry(raw, out.length)
    if (item !== null) out.push(item)
  }
  return out
}

/** 审计摘要：从请求体里挑几个「能定位到是哪件事」的字段，**不记正文、不记密钥**。
 *  以前住在 index.js；index.js 有 2700 行棘轮，纯形状函数本来就该在这里。 */
export function auditSummary(body) {
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
