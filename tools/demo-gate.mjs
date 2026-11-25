// 演示：一条新需求怎么被门禁一步步推着走完（真数据，会留在看板上）
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
  { id: 'p1', title: '库存接口与阈值表', description: 'GET /api/stock 返回 storeId/skuId/availableQty/safetyStock；新增 stock 表', priority: 'p0', status: 'draft', acceptance: [] },
  { id: 'p2', title: '预警列表页（低库存排序）', description: '前端页面，按缺口比例排序，空态与加载态', priority: 'p1', status: 'draft', acceptance: [] },
  { id: 'p3', title: '阈值可配置并持久化', description: '改 safetyStock 后刷新不丢', priority: 'p1', status: 'draft', acceptance: [] },
]

// 1) 建需求（故意先不填澄清三问）
const created = await post('/requirement/save', { requirement: {
  title: '门店库存预警看板 ' + new Date().toISOString().slice(5, 10),
  description: '门店按 SKU 看可用库存，低于安全库存时高亮；店长能改安全库存阈值。',
  project: 'admin-portal',
  domain: '零售',
  points,
} })
const req = created.body.requirement
show('建需求', req !== undefined, req?.code + ' ' + (req?.id ?? ''))
await post('/requirement/review', { id: req.id, decision: 'submit', by: '产品' })
const approved = await post('/requirement/review', { id: req.id, decision: 'approve', by: '架构师', note: '范围清楚' })
show('需求评审通过', approved.body.review?.status === 'approved', String(approved.body.review?.status))

// 2) 门禁一：三问没答，拆卡必须被拦
const blocked = await post('/requirement/split', { id: req.id })
show('门禁·三问未答被拦', blocked.status === 400 && String(blocked.body.error ?? '').includes('澄清'), String(blocked.body.error ?? '').slice(0, 60))

// 3) 答完三问再拆
await post('/requirement/save', { requirement: {
  id: req.id, title: req.title, description: req.description, project: 'admin-portal', domain: '零售', points,
  discovery: { server: '有，后端已有 node:sqlite 与 /api/orders，库存表新增', auth: '服务端校验角色：viewer 只读，operator 可改阈值', boundary: '前后端都交付，含 pnpm test' },
} })
const split = await post('/requirement/split', { id: req.id })
const cards = split.body.created ?? []
show('门禁·答完可拆卡', split.status === 200 && cards.length === points.length, cards.length + ' 张：' + cards.map(card => card.code).join('、'))
show('拆卡体检无后端缺口', (split.body.warnings ?? []).length === 0, JSON.stringify(split.body.warnings ?? []))

// 4) 每张卡走完：worktree → 执行记录 → 用例 → 各列 → 签字 → 完成
const seq = ['design', 'dev_ready', 'dev', 'review']
for (const card of cards) {
  const wt = await post('/task/worktree', { id: card.id, action: 'create' })
  const info = wt.body.worktree ?? {}
  await post('/task/coding', { id: card.id, action: 'update', coding: { agent: 'dev', branch: info.branch ?? '', files: [], commits: [], tests: { total: 16, passed: 16 } } })
  await post('/task/case', { id: card.id, action: 'add', cases: [
    { title: 'pnpm test', expected: '没有失败', shell: { command: 'pnpm test', expectExit: 0, expectContains: 'fail 0', timeoutMs: 180000 } },
    { title: 'pnpm build', expected: 'built in', shell: { command: 'pnpm build', expectExit: 0, expectContains: 'built in', timeoutMs: 180000 } },
  ] })
  for (const status of seq) await post('/task/update', { id: card.id, status })
  await new Promise(r => setTimeout(r, 2200))
  const reviewed = (await state()).tasks.find(item => item.id === card.id)
  await post('/task/update', { id: card.id, status: 'test' })
  const run = await post('/task/case/run', { id: card.id })
  const parts = (await post('/task/parts', { id: card.id })).body
  for (const item of (parts.checklist ?? [])) await post('/task/checklist', { id: card.id, action: 'check', itemId: item.id, by: '产品' })
  // 门禁二：没签字不许完成
  const early = await post('/task/update', { id: card.id, status: 'done' })
  await post('/task/signoff', { id: card.id, by: '产品', note: '用例通过、代码事实核对一致' })
  const done = await post('/task/update', { id: card.id, status: 'done' })
  show('卡 ' + card.code, reviewed?.coding?.verified?.ok === true && run.body.run?.failed === 0 && done.body.task?.status === 'done',
    '核对=' + String(reviewed?.coding?.verified?.ok) + ' 用例=' + (run.body.run?.passed ?? 0) + '/' + (run.body.run?.total ?? 0) + ' 未签字时完成被拦=' + (early.status === 400))
}

// 5) 门禁三：需求准出（没签字不许交付）
const earlyReq = await post('/requirement/signoff', { id: req.id, by: '产品', note: '' })
const signed = await post('/requirement/signoff', { id: req.id, by: '产品', note: '三张卡全绿，交付预警看板' })
const after = (await state()).requirements.find(item => item.id === req.id)
show('需求交付', after?.status === 'delivered', String(after?.status) + ' · 空签字被拦=' + (earlyReq.status !== 200))

// 6) 发布：门禁四
const release = await post('/release/save', { release: {
  name: '库存预警 v0.1.0', version: '0.1.0-' + Date.now().toString(36).slice(-4), project: 'admin-portal',
  tagName: 'stock-' + Date.now().toString(36).slice(-4), smoke: [{ text: '看板打开无报错', done: true }],
} })
const rel = release.body.release ?? {}
const finalCards = (await state()).tasks.filter(item => item.requirementId === req.id)
await post('/release/link', { id: rel.id, taskIds: finalCards.map(card => card.id) })
const published = await post('/release/publish', { id: rel.id, by: '产品' })
show('版本发布', published.body.release?.status === 'released', String(published.body.release?.tagName ?? '') + ' · ' + String(published.body.release?.status ?? published.body.error))

console.log('\n需求 ' + req.code + ' = ' + BASE + '/studio-api/state（看板上留着，你随时可以点开看）')
