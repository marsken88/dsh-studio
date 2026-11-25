// HTTP 路由的入参白名单。
//
// 为什么要有：工具层已经严格（多传字段直接拒，见 tools.js），但路由层一直是"挑自己认识的键，
// 其余静默忽略"。issue #9/#12/#13 全是这么来的——调用方拿到 200，字段却没落库。
//
// 和工具层的区别：路由有面板这个自家调用方，历史包袱更重（会整对象做部分更新）。
// 所以这里**只对入参形状明确的写路由**启用白名单：少数字段、自家调用方的 payload 已经对齐过。
// 复杂形状（如 /task/update 传整张卡）暂不启用 —— 那种要么改成显式字段，要么继续宽松。
const SHAPES = new Map()

/** 登记一条路由允许的字段。 */
export function declareRoute(route, fields) {
  SHAPES.set(route, Array.from(new Set(fields)))
  return SHAPES.get(route)
}

/** 校验：未知字段直接报错，并列出这个路由接受哪些字段。 */
export function rejectUnknownFields(route, body) {
  const allowed = SHAPES.get(route)
  if (allowed === undefined) return
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return
  const unknown = Object.keys(body).filter(key => !allowed.includes(key))
  if (unknown.length === 0) return
  throw new Error(
    `未知字段「${unknown.join('、')}」：${route} 只接受 ${allowed.join(' / ')}。` +
    '以前多传的字段会被静默忽略，所以这里直接拒绝 —— 要么改用接受的字段名，要么先提 issue 加参数',
  )
}

/* 已启用白名单的写路由。字段来自"面板实际发送的 payload"（已逐条 grep 过调用点），
   只收形状明确的：字段少、没有整对象部分更新。 */
declareRoute('/task/comment', ['id', 'body', 'author', 'kind', 'action', 'commentId', 'by'])
declareRoute('/task/checklist', ['id', 'action', 'text', 'itemId', 'done', 'note', 'by'])
declareRoute('/requirement/review', ['id', 'decision', 'note', 'by', 'operator'])
declareRoute('/requirement/signoff', ['id', 'action', 'note', 'by', 'override', 'operator'])
declareRoute('/task/merge-gate', ['id', 'by', 'publish', 'action'])
declareRoute('/task/merge', ['id', 'by'])
declareRoute('/requirement/split', ['id', 'pointIds', 'status'])
declareRoute('/requirement/pool', ['id', 'pool', 'reach', 'impact', 'confidence', 'effort'])
/* 列负责人与派单/会话：字段少、形状明确（issue #148 / #149 —— 不认识的字段不许静默忽略）。 */
declareRoute('/columns/save', ['status', 'kind', 'id', 'owner', 'members', 'strategy', 'dryRun'])
declareRoute('/agents/run', ['id', 'expert', 'instruction'])
declareRoute('/agents/chat', ['expert', 'team', 'member', 'topic', 'instruction', 'workdir'])
declareRoute('/agents/stop', ['id', 'expert', 'sessionId'])
declareRoute('/mention', ['taskId', 'kind', 'id', 'instruction'])

/** 诊断用：当前登记了哪些路由。 */
export function declaredRoutes() {
  return [...SHAPES.entries()].map(([route, fields]) => ({ route, fields }))
}
