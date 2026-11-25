// 提示词 A/B（有效版）：每轮建**两张同规格卡**，各派一个专家（提示词只差一段），并行跑，比结果。
//
//   node tools/prompt-ab.mjs --variant '...'                       # 只看计划（免费）
//   node tools/prompt-ab.mjs --variant '...' --setup-only          # 建/删专家验通路（免费）
//   node tools/prompt-ab.mjs --variant '...' --rounds 3 --run      # 真跑 3 轮（每轮 2 次会话）
//
// 判据：任务分支上的提交数、卡最终停在哪一列、代码事实核对、耗时。
// 完成判定读宿主 session 日志的 turn/end（/agents 不报手动派单）。
//
// 关于鉴权：`/studio-api` 过宿主的信任栅栏，没有已认证的浏览器会话一律 401。
// 脚本没有浏览器，得用 dsh web 的启动 token 换 cookie —— 所以现在还要给 STUDIO_TOKEN：
//   STUDIO_TOKEN=<dsh web 启动 token> STUDIO_BASE=http://<host>:18080 node tools/prompt-ab.mjs --variant '...'
import { Client } from 'ssh2'
import { launchTokenFromEnv, studioFetch } from './lib/studio-auth.mjs'
const BASE = process.env.STUDIO_BASE ?? 'http://192.168.120.218:18080'
const api = studioFetch(BASE, launchTokenFromEnv())
const SSH = { host: process.env.DSH_DEPLOY_HOST ?? '192.168.120.218', username: process.env.DSH_DEPLOY_USER ?? 'lyf', password: process.env.DSH_DEPLOY_PASSWORD ?? '1234', readyTimeout: 15000 }
const REPO = process.env.AB_REPO ?? '/home/lyf/repos/admin-portal'
const argv = process.argv.slice(2)
const flag = (name) => argv.includes('--' + name)
const value = (name, fallback) => { const at = argv.indexOf('--' + name); return at >= 0 ? String(argv[at + 1] ?? '') : fallback }
const VARIANT = value('variant', '')
const ROUNDS = Math.max(1, Math.min(5, Number(value('rounds', '1')) || 1))
const RUN = flag('run')
const SETUP_ONLY = flag('setup-only')
const TIMEOUT_MS = Number(value('timeout', '1800')) * 1000
const SPEC = value('spec', '给订单列表页加一列「备注」，只读展示 orders.note（GET /api/orders 已返回该字段）。改完跑 pnpm test。')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const post = async (path, body) => {
  const res = await api('/studio-api' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  return res.json().catch(() => ({}))
}
const state = async () => (await (await api('/studio-api/state')).json()).state
const ssh = (command) => new Promise((resolve, reject) => {
  const client = new Client()
  client.on('ready', () => client.exec(command, (err, stream) => {
    if (err) { client.end(); reject(err); return }
    let out = ''
    stream.on('data', (d) => { out += d })
    stream.stderr.on('data', (d) => { out += d })
    stream.on('close', () => { client.end(); resolve(out) })
  })).on('error', reject)
  client.connect(SSH)
})
if (VARIANT === '') { console.error('用法：--variant "要对比的那段提示词" [--rounds 3] [--run]'); process.exit(2) }
if (!RUN && !SETUP_ONLY) {
  console.log(JSON.stringify({
    design: '每轮两张同规格卡，各自 worktree、各自专家，并行跑',
    rounds: ROUNDS,
    spec: SPEC,
    variant: VARIANT,
    judgedBy: ['任务分支提交数', '卡最终列', '代码事实核对', '耗时'],
    cost: '每轮 2 次真实会话，合计 ' + (ROUNDS * 2) + ' 次',
  }, null, 2))
  console.log('\n这是 dry-run：没有建专家、没有派单、没有花 token。')
  process.exit(0)
}
const knownExperts = new Set(((await state()).config.experts ?? []).map(item => item.id))
const stamp = Date.now().toString(36).slice(-4)
const makeExpert = async (name, prompt) => {
  const known = new Set(((await state()).config.experts ?? []).map(item => item.id))
  const saved = await post('/experts/save', { expert: { name, role: 'dev', description: 'A/B 临时专家', prompt, enabled: true } })
  const list = saved.experts ?? saved.state?.config?.experts ?? []
  const created = list.find(item => !known.has(item.id))
  if (created === undefined) throw new Error('建专家失败')
  return String(created.id)
}
const delExpert = async (id) => { await post('/experts/delete', { id, confirm: 'DELETE' }) }
const basePrompt = String((((await state()).config.experts ?? []).find(item => item.role === 'dev') ?? {}).prompt ?? '')
const expertA = await makeExpert('AB-base-' + stamp, basePrompt)
const expertB = await makeExpert('AB-var-' + stamp, basePrompt + '\n\n' + VARIANT)
console.log('专家：基线=' + expertA + ' 变体=' + expertB)
if (SETUP_ONLY) { await delExpert(expertA); await delExpert(expertB); console.log('--setup-only：通路验证完成，已删除。'); process.exit(0) }
const sessionFile = async (taskId, expertId) => (await ssh('ls -1t /home/lyf/.dsh/sessions/*/studio-' + taskId + '-' + expertId + '/session.v4.jsonl.zstd 2>/dev/null | head -1')).trim()
const waitTurn = async (taskId, expertId, started) => {
  let file = ''
  for (let attempt = 0; attempt < 10 && file === ''; attempt += 1) { await sleep(3000); file = await sessionFile(taskId, expertId) }
  if (file === '') return { ok: false, error: '没有会话日志', ms: Date.now() - started }
  while (Date.now() - started < TIMEOUT_MS) {
    await sleep(10000)
    const turns = Number((await ssh('zstd -dc ' + file + ' 2>/dev/null | grep -c turn/end')).trim() || '0')
    if (turns > 0) return { ok: true, ms: Date.now() - started, turns }
  }
  return { ok: false, error: '超时未收尾', ms: Date.now() - started }
}
const measure = async (taskId) => {
  const snapshot = await state()
  const card = (snapshot.tasks ?? []).find(item => item.id === taskId) ?? {}
  const candidates = ['task/' + taskId, 'task/' + (card.code === '' ? taskId : card.code) + '-' + taskId.slice(-8)]
  let branch = candidates[0]
  let commits = 0
  for (const candidate of candidates) {
    const count = Number((await ssh('cd ' + REPO + ' && git rev-list --count master..' + candidate + ' 2>/dev/null || echo 0')).trim() || '0')
    if (count > 0) { branch = candidate; commits = count; break }
  }
  return { status: card.status, commits, verified: card.coding?.verified?.ok === true, branch }
}
const results = []
for (let round = 1; round <= ROUNDS; round += 1) {
  console.log('\n第 ' + round + '/' + ROUNDS + ' 轮')
  const created = []
  for (const label of ['A', 'B']) {
    const saved = await post('/task/create', { title: 'AB-' + stamp + '-' + round + label + ' ' + SPEC.slice(0, 40), type: 'requirement', status: 'dev', priority: 'normal', project: 'admin-portal', requirement: SPEC })
    created.push({ label, id: String(saved.task?.id ?? '') })
  }
  const pairs = [[created[0], expertA, '基线'], [created[1], expertB, '变体']]
  for (const [card, expert] of pairs) {
    await post('/task/update', { id: card.id, expert })
  }
  const started = Date.now()
  for (const [card, expert] of pairs) await post('/agents/run', { id: card.id, expert })
  const waits = await Promise.all(pairs.map(([card, expert]) => waitTurn(card.id, expert, started)))
  for (let index = 0; index < pairs.length; index += 1) {
    const [card, expert, label] = pairs[index]
    await post('/agents/stop', { id: card.id })
    const result = await measure(card.id)
    const row = { round, label, side: label === 'A' ? '基线' : '变体', ok: waits[index].ok, secs: Math.round(waits[index].ms / 1000), commits: result.commits, status: result.status, verified: result.verified, error: waits[index].error }
    results.push(row)
    console.log([label, 'ok=' + row.ok, row.commits + ' 提交', '列=' + row.status, '核对=' + row.verified, row.secs + 's', row.error ?? ''].join('  '))
    const branch = result.branch
    await ssh('cd ' + REPO + ' && git worktree remove --force /tmp/studio-wt-test/' + card.id + ' 2>/dev/null; git branch -D ' + branch + ' 2>&1 | head -1')
    await post('/task/delete', { id: card.id, confirm: 'DELETE' })
  }
}
await delExpert(expertA); await delExpert(expertB)
const group = (side) => {
  const rows = results.filter(item => item.side === side)
  const avg = (key) => rows.length === 0 ? 0 : Math.round(rows.reduce((sum, item) => sum + Number(item[key] ?? 0), 0) / rows.length * 10) / 10
  return { rows: rows.length, commits: avg('commits'), seconds: avg('secs'), done: rows.filter(item => item.status === 'test' || item.status === 'review' || item.status === 'done').length }
}
const a = group('基线'), b = group('变体')
console.log('\n基线：' + JSON.stringify(a))
console.log('变体：' + JSON.stringify(b))
console.log('\n差异：提交 ' + (b.commits - a.commits) + ' / 推进 ' + (b.done - a.done) + ' / 耗时 ' + (b.seconds - a.seconds) + 's（样本 ' + ROUNDS + ' 轮，n 小，只当信号）')