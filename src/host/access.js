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

/* --------------------------------------------------------------- 宿主信任栅栏 ---
   `/studio-api` 挂在 DSH 的 webServer 上，于是它**继承宿主的端口**：任何能连到
   这个端口的人都能调。宿主的 connection.requestRejection() 是 Host/Origin 栅栏
   加「已认证的浏览器会话」，结论只有三种：403（栅栏没过）、401（没有会话）、
   undefined（放行）。这里负责把结论翻成我们的处置，以及替调用方拿住连接本体
   （见 trustOutcomeFor；connection 由 index.js 从 ctx 取来传进来）。 */

/** 对外公开的自助提单面：业务方不登录也能提交与查询（README 的「自助提单」）。
 *  它们是**设计成公开**的，所以只豁免「没有会话」这一条，绝不豁免 Host/Origin 栅栏
 *  ——否则随便一个网页就能借 DNS rebinding 往里灌需求。
 *  名单必须与 intake-pages.js 里页面真正会调的地址一致（页面只调这三个 POST）。 */
export const PUBLIC_INTAKE_ROUTES = new Set([
  '/intake',
  '/intake/requirement',
  '/intake/status',
  '/intake/query',
  '/intake/mine',
  '/intake/mine/query',
  /* 运维探活：只看得到「活着」，看不到任何台账。部署脚本靠它判断服务起没起。 */
  '/health',
])

/** requestRejection 的结论 → 我们的处置。返回 null 表示放行，否则是 { status, code, error }。
 *
 *  为什么按值分开处置：宿主把「没有会话」和「Host 不对」压成两个不同的状态码，
 *  而我们的公开提单页只该被第一条挡住。写成 `rejection !== undefined` 一把拒，
 *  等于顺手把匿名提单功能关掉；写成只认 403，等于没做会话校验。 */
export function trustRejectionOutcome(rejection, route) {
  if (rejection === undefined || rejection === null) return null
  if (rejection === 403) {
    return {
      status: 403,
      code: 'bad_origin',
      error: '这不是本机的同源请求（Host/Origin 栅栏没过）：跨站网页与 DNS rebinding 都调不动这些接口。',
    }
  }
  if (rejection === 401 && PUBLIC_INTAKE_ROUTES.has(route)) return null
  return {
    status: 401,
    code: 'login_required',
    error: '需要已登录的 DSH 浏览器会话：从 dsh web 启动时打印的那个 URL 打开面板（脚本用 tools/lib/studio-auth.mjs 换 cookie）。',
  }
}

/** 宿主没提供 connection.requestRejection 时的说明（**不拦**）。
 *
 *  为什么是放行而不是「只信回环」：这个插件声明兼容的是 dsh 0.2.2-rc.1+，而
 *  requestRejection 从 0.1.5-alpha.1 就存在——拿不到它，说明是宿主的服务名换了或
 *  某种非标准宿主。这种情况下**只信回环**会把局域网里正常打开面板的人一起挡成 403
 *  （可用性事故），而我们又没有宿主那份可信 Host 名单，判断不出「谁该被信」。
 *  所以这里放行，由 trustOutcomeFor 记一行日志，让「栅栏没生效」在日志里看得见。
 *  真正支持的宿主上这条分支永远不会走到。 */
export function trustUnavailableOutcome() {
  return null
}

let trustUnavailableWarned = false

/** 宿主信任栅栏的实际调用：`connection` 从 ctx 取来传进来（可能没有）。
 *
 *  `requestRejection` **必须以方法形式调用**：宿主那边是类方法，内部读
 *  `this.trustedHosts` / `this.browserAuth`，抽成裸函数调用会丢 this → TypeError
 *  （dsh-pocket 的 issue #117 就是这么全盘 403 的）。所以这里拿到连接本体直接 call。
 *
 *  宿主自己抛错时按「栅栏没过」处理：宁可回 403，也不放一个说不清的请求进去。 */
export function trustOutcomeFor(connection, req, route) {
  if (typeof connection?.requestRejection === 'function') {
    let rejection
    try {
      rejection = connection.requestRejection(req)
    } catch {
      rejection = 403
    }
    return trustRejectionOutcome(rejection, route)
  }
  if (!trustUnavailableWarned) {
    trustUnavailableWarned = true
    console.warn('[dsh-studio] 宿主没有 connection.requestRejection：/studio-api 的信任栅栏本次未生效（同源/会话都没校验）。请升级 dsh。')
  }
  return trustUnavailableOutcome()
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
