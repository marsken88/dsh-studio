import { launchTokenFromEnv, studioFetch } from './lib/studio-auth.mjs'

const BASE = 'http://192.168.120.218:18080'
const api = studioFetch(BASE, launchTokenFromEnv())
const post = async (p, b) => { const res = await api('/studio-api' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }); return { status: res.status, body: await res.json().catch(() => ({})) } }
const state = async () => (await (await api('/studio-api/state')).json()).state
const ok = (label, good, detail) => console.log((good ? 'ok   ' : 'FAIL ') + label + (detail === undefined ? '' : ' — ' + detail))
const stamp = new Date().toISOString().slice(5, 10)

// A) 反向探针：说「有后端」但功能点全是界面 → 应该给警告
const warnReq = await post('/requirement/save', { requirement: {
  title: '（探针）说有后端但只写界面 ' + Date.now().toString(36), project: 'admin-portal',
  discovery: { server: '有，node:sqlite', auth: '服务端 403', boundary: '前后端' },
  points: [{ id: 'p1', title: '列表页加一列', description: '只是界面', priority: 'normal', status: 'draft', acceptance: [] }],
} })
const wr = warnReq.body.requirement
await post('/requirement/review', { id: wr.id, decision: 'submit', by: '产品' })
await post('/requirement/review', { id: wr.id, decision: 'approve', by: '架构师', note: 'ok' })
const warned = await post('/requirement/split', { id: wr.id })
ok('说有大后端但只写界面 → 有警告', (warned.body.warnings ?? []).length === 1, (warned.body.warnings ?? [])[0] ?? '')
for (const card of (warned.body.created ?? [])) await post('/task/worktree', { id: card.id, action: 'remove' })
for (const card of (warned.body.created ?? [])) await post('/task/delete', { id: card.id, confirm: 'DELETE' })
await post('/requirement/delete', { id: wr.id, confirm: 'DELETE' })

// B) 纯前端需求：说「没有服务端」→ 不该有警告，且能走完
const points = [
  { id: 'p1', title: '导出按钮与本地 CSV 生成', description: '前端把当前页数据转 CSV，不请求后端', priority: 'p1', status: 'draft', acceptance: [] },
  { id: 'p2', title: '按钮的加载态与空态', description: '没有数据时按钮置灰并提示', priority: 'p2', status: 'draft', acceptance: [] },
]
const made = await post('/requirement/save', { requirement: {
  title: '订单列表导出 CSV（纯前端） ' + stamp,
  description: '列表页加「导出」按钮：把当前已加载的订单在浏览器里转成 CSV 下载，不新增后端接口。',
  project: 'admin-portal', domain: '订单',
  docs: [{ id: 'prd', kind: 'prd', title: 'PRD', version: 'v1.0', content: '目标：不依赖后端就能导出当前页。范围：按钮、CSV 生成、空态。验收：点击有文件下载、无数据时置灰。' }],
  pool: { reach: 120, impact: 1, confidence: 90, effort: 1 },
  discovery: { server: '没有，纯前端本地生成，刷新即还原（数据仍来自现有 /api/orders）', auth: '不改权限，导出的是当前角色本来就能看到的行', boundary: '只交付界面与前端工具函数，不动后端' },
  points,
} })
const req = made.body.requirement
ok('建纯前端需求', req !== undefined, req?.code + ' ' + req?.id)
await post('/requirement/review', { id: req.id, decision: 'submit', by: '产品' })
const approved = await post('/requirement/review', { id: req.id, decision: 'approve', by: '架构师', note: '确实不需要后端' })
ok('评审通过', approved.body.review?.status === 'approved', String(approved.body.review?.status))
const split = await post('/requirement/split', { id: req.id })
const cards = split.body.created ?? []
ok('拆卡', split.status === 200 && cards.length === points.length, cards.map(card => card.code).join('、'))
ok('没有后端也算合理（不警告）', (split.body.warnings ?? []).length === 0, JSON.stringify(split.body.warnings ?? []))

for (const card of cards) {
  const wt = await post('/task/worktree', { id: card.id, action: 'create' })
  const info = wt.body.worktree ?? {}
  await post('/task/coding', { id: card.id, action: 'update', coding: { agent: 'dev', branch: info.branch ?? '', files: [], commits: [], tests: { total: 7, passed: 7 } } })
  await post('/task/case', { id: card.id, action: 'add', cases: [
    { title: 'pnpm test', expected: '没有失败', shell: { command: 'pnpm test', expectExit: 0, expectContains: 'fail 0', timeoutMs: 180000 } },
    { title: 'pnpm build', expected: 'built in', shell: { command: 'pnpm build', expectExit: 0, expectContains: 'built in', timeoutMs: 180000 } },
  ] })
  for (const status of ['design', 'dev_ready', 'dev', 'review']) await post('/task/update', { id: card.id, status })
  await new Promise(r => setTimeout(r, 2200))
  const reviewed = (await state()).tasks.find(item => item.id === card.id)
  await post('/task/update', { id: card.id, status: 'test' })
  const run = await post('/task/case/run', { id: card.id })
  const parts = (await post('/task/parts', { id: card.id })).body
  for (const item of (parts.checklist ?? [])) await post('/task/checklist', { id: card.id, action: 'check', itemId: item.id, by: '产品' })
  // 门禁：没有 PRD 交付物时只能靠 override？这里先试正常签字（需求级门禁要看 PRD，已补）
  await post('/task/signoff', { id: card.id, by: '产品', note: '导出功能自测通过' })
  const done = await post('/task/update', { id: card.id, status: 'done' })
  ok('卡 ' + card.code, reviewed?.coding?.verified?.ok === true && run.body.run?.failed === 0 && done.body.task?.status === 'done',
    '核对=' + String(reviewed?.coding?.verified?.ok) + ' 用例=' + (run.body.run?.passed ?? 0) + '/' + (run.body.run?.total ?? 0))
}

const signed = await post('/requirement/signoff', { id: req.id, by: '产品', note: '纯前端导出交付，两张卡全绿' })
const after = (await state()).requirements.find(item => item.id === req.id)
ok('需求交付', after?.status === 'delivered', String(after?.status) + ' ' + String(signed.body.error ?? '').slice(0, 80))
const gate = await post('/requirement/get', { id: req.id })
ok('门禁通过', gate.body.progress?.gate?.ready === true, JSON.stringify(gate.body.progress?.gate?.blockers ?? []))
console.log('\n需求 ' + req.code + '（' + req.id + '）留在看板上')
