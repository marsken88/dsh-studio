/* 权限判定（纯函数）：HTTP 面板与工具层共用同一张成员名单、同一套档位。
   原来住在 index.js 里，被「index.js < 2700 行」的契约测试逼着要搬家；
   这些都是没有宿主依赖的纯逻辑，本来就该待在这里。 */
import { ACCESS_ROLE_LABEL, ADMIN_ROUTES, LEVEL_RANK, ROLE_LEVEL } from './domain.js'

/** 只是读、但走 POST 的入口（前端只有一处 api() 封装，固定发 POST）。 */
export const READ_ONLY_POST_ROUTES = new Set(['/task/comments', '/task/parts', '/task/diff', '/task/file', '/cases', '/team/memory', '/suite/list', '/release/get', '/requirement/get', '/requirement/assist', '/requirement/matrix', '/requirement/impact', '/contexts', '/contexts/session', '/agents/policy', '/access/explain', '/workspace/list'])

/** 这个请求需要什么权限：读、写、还是管理员。 */
export function accessLevelFor(route, method) {
  if (method !== 'POST') return 'read'
  return ADMIN_ROUTES.has(route) ? 'admin' : 'write'
}

/** 权限判定，返回 null 表示放行，否则返回给人看的原因。
 *  `trusted` = 这个 operator 是服务端认定的身份（登录会话 / 本地超管）还是请求头自报的。
 *  只有可信身份才认「超级管理员」豁免，否则加个 x-studio-user 头就能过全部写权限；
 *  名字也必须是完全相同的匹配，不能用后缀（叫「小admin」不该匹配到 admin）。 */
export function checkAccess(config, operator, level, trusted = false) {
  const access = config?.access ?? { enabled: false, members: [] }
  if (access.enabled !== true) return null
  const raw = String(operator ?? '').trim()
  if (trusted === true && raw === '超级管理员') return null
  const name = raw.toLowerCase()
  const member = access.members.find((item) => {
    const ids = [item.id, item.name].map((value) => String(value ?? '').trim().toLowerCase()).filter(Boolean)
    return ids.includes(name)
  })
  if (member === undefined) {
    // 名单外的人还能看（否则名字对不上就直接进不去），但一个写操作都不许做。
    if (level === 'read') return null
    return `「${operator}」不在成员名单里：让管理员到「设置 → 权限与审计」把你加进去，或用页头的「我是…」换个名字`
  }
  const rank = ROLE_LEVEL[member.role] ?? 0
  if ((LEVEL_RANK[level] ?? 0) > rank) {
    const need = level === 'admin' ? '管理员' : '成员'
    return `「${operator}」是${ACCESS_ROLE_LABEL[member.role] ?? member.role}，这一步需要${need}权限`
  }
  return null
}

/* ------------------------------------------------------------------ 来源限制 ---
   权限模型默认没开（access.enabled=false）。这种部署下，凡是「真能造成不可逆损害」
   的操作只允许服务器本机执行，其余管理操作照旧（否则管理员在自己浏览器里什么都改不了，
   策略就会被绕过）。导出类虽然是 GET，但内容是操作人姓名，同样按敏感处理。 */

export const DANGEROUS_ADMIN_ROUTES = new Set(['/market/install', '/market/uninstall', '/snapshot/restore'])
export const SENSITIVE_EXPORT_ROUTES = new Set(['/audit/export.csv', '/export/dispatch.csv'])

/** 这个请求是否只允许回环来源（未启用登录时）。 */
export function needsLocalSource(route, level, config) {
  if ((config?.access ?? {}).enabled === true) return false
  if (level === 'admin' && DANGEROUS_ADMIN_ROUTES.has(route)) return true
  return SENSITIVE_EXPORT_ROUTES.has(route)
}

/** 请求是否来自本机（IPv4/IPv6/映射形式都算）。 */
export function isLoopbackRequest(req) {
  const address = String(req?.socket?.remoteAddress ?? '')
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** 跨站 POST 判定（CSRF）：带了 Origin 且与目标站点不同即为跨站。
 *  curl / 服务端互调没有 Origin 头，同源请求的 Origin 与 Host 相同 —— 都放行。
 *  恶意网页用 no-cors 的简单请求（content-type: text/plain）也能触发写操作，
 *  而 readJsonBody 不校验 content-type，所以只能靠这条拦。 */
export function isCrossSiteRequest(req) {
  const origin = String(req?.headers?.origin ?? '')
  const host = String(req?.headers?.host ?? '')
  if (origin === '' || host === '') return false
  try {
    return new URL(origin).host !== host
  } catch {
    return false
  }
}

/** 签字人身份：**服务端认定的会话身份优先**，其次反代注入的头，最后才是请求体自报。
 *
 *  以前直接取 body.by，于是开了 LDAP 也能用别人的名字签字 —— 门禁唯一的责任锚点成了自由文本。
 *  返回 { by, source }：source = session / header / body / none，会一起写进签字记录。 */
export function resolveSigner({ session = '', header = '', body = '', fallback = '人' } = {}) {
  const s = String(session ?? '').trim()
  const h = String(header ?? '').trim()
  const b = String(body ?? '').trim()
  if (s !== '') return { by: s.slice(0, 60), source: 'session' }
  if (h !== '') return { by: h.slice(0, 60), source: 'header' }
  if (b !== '') return { by: b.slice(0, 60), source: 'body' }
  return { by: String(fallback).slice(0, 60), source: 'none' }
}

/** 破坏性路由：会删数据、清审计、改权限、动发布。
 *
 *  以前它们和普通写路由一样，未开登录时任何能连到端口的人（包括同机页面里的脚本）都能直接打：
 *  实测 `POST /studio-api/audit/clear {}` 就把 58 条审计删了（issue #5 第 3 条）。
 *  现在要求请求体带 `confirm`，值必须是下面这个词（大写），否则 400。
 *  这不是权限系统，是"别手滑"和"别被随便打"的护栏；真正的鉴权仍然靠 access + 登录。
 */
export const DESTRUCTIVE_ROUTES = new Map([
  ['/audit/clear', 'CLEAR'],
  ['/team/memory/clear', 'CLEAR'],
  ['/task/delete', 'DELETE'],
  ['/requirement/delete', 'DELETE'],
  ['/release/delete', 'DELETE'],
  ['/projects/delete', 'DELETE'],
  ['/repos/delete', 'DELETE'],
  ['/bots/delete', 'DELETE'],
  ['/experts/delete', 'DELETE'],
  ['/teams/delete', 'DELETE'],
  ['/suite/delete', 'DELETE'],
  ['/skills/delete', 'DELETE'],
  ['/access/delete', 'DELETE'],
  ['/workspace/delete', 'DELETE'],
  ['/snapshot/restore', 'RESTORE'],
  ['/market/install', 'INSTALL'],
  ['/market/uninstall', 'UNINSTALL'],
  ['/release/publish', 'PUBLISH'],
  ['/task/merge', 'MERGE'],
  ['/release/rollback', 'ROLLBACK'],
  ['/reset', 'RESET'],
  ['/access/save', 'SAVE ACCESS'],
])

/** 这条路由要求的确认词；不需要确认返回 null。 */
export function confirmWordFor(route) {
  return DESTRUCTIVE_ROUTES.get(String(route ?? '')) ?? null
}

/** 缺确认 / 确认词不对时返回该提示的确认词，通过时返回 null。 */
export function needsConfirm(route, method, body) {
  const word = confirmWordFor(route)
  if (word === null) return null
  if (String(method ?? '').toUpperCase() !== 'POST') return null
  const given = String(body?.confirm ?? '').trim().toUpperCase()
  return given === word ? null : word
}
