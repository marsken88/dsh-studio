// 用「管理后台登录功能」走一遍完整链路（真数据，会留在看板上）
import { launchTokenFromEnv, studioFetch } from './lib/studio-auth.mjs'

const BASE = process.env.STUDIO_BASE ?? 'http://192.168.120.218:18080'
const api = studioFetch(BASE, launchTokenFromEnv())
const post = async (path, body) => {
  const res = await api('/studio-api' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}
const state = async () => (await (await api('/studio-api/state')).json()).state
const show = (label, ok, detail) => console.log((ok ? 'ok   ' : 'FAIL ') + label + (detail === undefined ? '' : ' — ' + detail))

const points = [
  { id: 'p1', title: '登录接口与密码校验', description: 'POST /api/auth/login：scrypt 校验密码，错误返回 401，成功返回 access + refresh token', priority: 'p0', status: 'draft', acceptance: [{ text: '错误密码返回 401 且提示「账号或密码不对」' }, { text: '正确密码返回 token 与 refreshToken，expiresIn>0' }] },
  { id: 'p2', title: '角色区分与前端路由守卫', description: 'admin / operator / viewer 三档权限；未登录访问受保护页面跳登录页', priority: 'p1', status: 'draft', acceptance: [{ text: '未登录打开 /dashboard 会跳到 /login' }, { text: 'viewer 登录后看不到「＋新建」按钮' }] },
  { id: 'p3', title: '刷新令牌与自动续期', description: '访问令牌过期时 /api/auth/refresh 换新并重放一次请求', priority: 'p1', status: 'draft', acceptance: [{ text: '刷新令牌能换到新的访问令牌' }, { text: '拿访问令牌当刷新令牌用会被拒（401）' }] },
]

// 1) 建需求（先不答三问）
const created = await post('/requirement/save', { requirement: {
  title: '管理后台登录功能 ' + new Date().toISOString().slice(5, 10),
  description: '账号密码登录、角色区分、令牌续期。演示/内部使用，密码统一 123456。',
  project: 'admin-portal', domain: '订单',
  docs: [{ id: 'prd', kind: 'prd', title: 'PRD', version: 'v1.0', content: '目标：能登录并按角色区分能力。范围：登录接口、路由守卫、刷新令牌。验收：三条功能点各自的验收标准。' }],
  pool: { reach: 60, impact: 2, confidence: 90, effort: 2 },
  points,
} })
const req = created.body.requirement
show('建需求', req !== undefined, req?.code + ' ' + (req?.id ?? ''))

// 2) 门禁一：三问没答，拆卡必须被拦
await post('/requirement/review', { id: req.id, decision: 'submit', by: '产品' })
const approved = await post('/requirement/review', { id: req.id, decision: 'approve', by: '架构师', note: '登录是既有功能的强化，范围清楚' })
show('需求评审通过', approved.body.review?.status === 'approved', String(approved.body.review?.status))
const blocked = await post('/requirement/split', { id: req.id })
show('门禁·三问未答被拦', blocked.status === 400 && String(blocked.body.error ?? '').includes('澄清'), String(blocked.body.error ?? '').slice(0, 50))

// 3) 答完三问再拆
await post('/requirement/save', { requirement: {
  id: req.id, title: req.title, description: req.description, project: 'admin-portal', domain: '订单', points,
  discovery: {
    server: '有，后端 node:sqlite 已有 /api/auth/login 与 /api/auth/refresh',
    auth: '服务端校验：密码 scrypt、令牌 HMAC 签名，角色权限在服务端判定，前端隐藏按钮只是体验',
    boundary: '前后端都交付，含 pnpm test（11 条服务端 + 7 条前端）',
  },
} })
const split = await post('/requirement/split', { id: req.id })
const cards = split.body.created ?? []
show('门禁·答完可拆卡', split.status === 200 && cards.length === points.length, cards.map(card => card.code).join('、'))
show('拆卡体检三条都不响', (split.body.warnings ?? []).length === 0, JSON.stringify(split.body.warnings ?? []))

// 4) 每张卡走完：worktree → 执行记录 → 真跑用例 → 各列 → 清单 → 签字 → 完成
for (const card of cards) {
  const wt = await post('/task/worktree', { id: card.id, action: 'create' })
  const info = wt.body.worktree ?? {}
  await post('/task/coding', { id: card.id, action: 'update', coding: { agent: 'dev', branch: info.branch ?? '', files: [], commits: [], tests: { total: 18, passed: 18 } } })
  await post('/task/case', { id: card.id, action: 'add', cases: [
    { title: 'pnpm test（登录相关 11 条）', expected: '没有失败', shell: { command: 'pnpm test', expectExit: 0, expectContains: 'fail 0', timeoutMs: 240000 } },
    { title: 'pnpm build', expected: 'built in', shell: { command: 'pnpm build', expectExit: 0, expectContains: 'built in', timeoutMs: 240000 } },
  ] })
  for (const status of ['design', 'dev_ready', 'dev', 'review']) await post('/task/update', { id: card.id, status })
  await new Promise(r => setTimeout(r, 2200))
  const reviewed = (await state()).tasks.find(item => item.id === card.id)
  await post('/task/update', { id: card.id, status: 'test' })
  const run = await post('/task/case/run', { id: card.id })
  const parts = (await post('/task/parts', { id: card.id })).body
  for (const item of (parts.checklist ?? [])) await post('/task/checklist', { id: card.id, action: 'check', itemId: item.id, by: '产品' })
  await post('/task/update', { id: card.id, status: 'accept' })
  await post('/task/signoff', { id: card.id, by: '产品', note: '登录相关用例全过' })
  const done = await post('/task/update', { id: card.id, status: 'done' })
  show('卡 ' + card.code, reviewed?.coding?.verified?.ok === true && run.body.run?.failed === 0 && done.body.task?.status === 'done',
    '核对=' + String(reviewed?.coding?.verified?.ok) + ' 用例=' + (run.body.run?.passed ?? 0) + '/' + (run.body.run?.total ?? 0))
}

// 5) 需求准出 + 交付
const gate = await post('/requirement/get', { id: req.id })
const g = gate.body.progress?.gate ?? {}
show('需求准出无拦截', (g.blockers ?? []).length === 0, JSON.stringify(g.blockers ?? []))
show('准出提示（应只剩交付物/RICE 之类）', true, JSON.stringify(g.warnings ?? []))
const signed = await post('/requirement/signoff', { id: req.id, by: '产品', note: '登录功能交付：接口、角色区分、令牌续期，用例全绿' })
const after = (await state()).requirements.find(item => item.id === req.id)
show('需求交付', after?.status === 'delivered', String(after?.status) + ' ' + String(signed.body.error ?? '').slice(0, 60))

// 6) 发布
const rel = await post('/release/save', { release: { name: '登录功能 v0.1.0', version: '0.1.0-login', project: 'admin-portal', tagName: 'login-' + Date.now().toString(36).slice(-4), smoke: [{ text: '登录页能打开且无报错', done: true }] } })
const release = rel.body.release ?? {}
const finalCards = (await state()).tasks.filter(item => item.requirementId === req.id)
await post('/release/link', { id: release.id, taskIds: finalCards.map(card => card.id) })
const published = await post('/release/publish', { id: release.id, by: '产品' })
show('版本发布', published.body.release?.status === 'released', String(published.body.release?.tagName ?? '') + ' ' + String(published.body.release?.status ?? ''))
console.log('\n需求 ' + req.code + '（' + req.id + '）已留在看板上')
