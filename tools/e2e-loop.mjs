// 全闭环验收：澄清门禁 → 评审 → 拆卡 → 各列 → 代码事实 → 用例真跑 → 验收 → 版本发布。
//
//   STUDIO_BASE=http://<host>:18080 node tools/e2e-loop.mjs             # 跑 1 次
//   STUDIO_BASE=http://<host>:18080 node tools/e2e-loop.mjs --k 3       # 跑 3 次，看成功率
//   ... --keep                                                         # 保留数据看结果
//
// 每轮都真建一条需求和若干张卡，默认跑完自动删除。
// 需要：目标项目在主机上有 git 仓库、config.testing.allowShell 打开、shellCwd 指向仓库。
//
// 关于鉴权：`/studio-api` 过宿主的信任栅栏，没有已认证的浏览器会话一律 401。
// 脚本没有浏览器，得用 dsh web 的启动 token 换 cookie —— 所以现在还要给 STUDIO_TOKEN：
//   STUDIO_TOKEN=$(journalctl -u dsh-web -n 50 | grep -o 'token=[^&]*' | tail -1 | cut -d= -f2) \
//   STUDIO_BASE=http://<host>:18080 node tools/e2e-loop.mjs
import { launchTokenFromEnv, studioFetch } from './lib/studio-auth.mjs'

const BASE = process.env.STUDIO_BASE ?? 'http://192.168.120.218:18080'
const api = studioFetch(BASE, launchTokenFromEnv())
const PROJECT = process.env.E2E_PROJECT ?? 'admin-portal'
const SHELL_CWD = process.env.E2E_SHELL_CWD ?? '/home/lyf/repos/admin-portal'
const argv = process.argv.slice(2)
const kIndex = argv.indexOf('--k')
const ROUNDS = Math.max(1, Math.min(10, Number(kIndex >= 0 ? argv[kIndex + 1] : 1) || 1))
const keep = argv.includes('--keep')

const post = async (path, body) => {
  const res = await api('/studio-api' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}
const state = async () => (await (await api('/studio-api/state')).json()).state

async function runOnce(round) {
  const failures = []
  const step = (label, ok, detail) => {
    console.log('  ' + (ok ? 'ok   ' : 'FAIL ') + label + (detail === undefined ? '' : ' — ' + detail))
    if (!ok) failures.push(label)
  }
  const stamp = new Date().toISOString().slice(5, 16).replace('T', ' ') + ' #' + round
  const cfg = (await state()).config
  await post('/config', { testing: { ...cfg.testing, allowShell: true, shellCwd: SHELL_CWD } })

  const points = [
    { id: 'p1', title: '订单接口与建表', description: 'API + SQLite', priority: 'normal', status: 'draft', acceptance: [{ text: 'GET /api/orders 返回 200 且含 note 字段' }] },
    { id: 'p2', title: '可拆卡并建 worktree', description: '拆卡 + 分支', priority: 'normal', status: 'draft', acceptance: [{ text: '拆完卡能在 /tmp/studio-wt-test 下看到 worktree' }] },
  ]
  const saved = await post('/requirement/save', { requirement: { title: '全闭环自检 ' + stamp, description: 'tools/e2e-loop.mjs 生成', project: PROJECT, points } })
  const req = saved.body.requirement
  await post('/requirement/review', { id: req.id, decision: 'submit', by: '产品' })
  const approved = await post('/requirement/review', { id: req.id, decision: 'approve', by: '架构师', note: '范围清楚' })
  step('评审通过', approved.body.review?.status === 'approved', String(approved.body.review?.status))

  const blocked = await post('/requirement/split', { id: req.id })
  step('未答三问被拦', blocked.status === 400 && String(blocked.body.error ?? '').includes('澄清'), String(blocked.status))

  await post('/requirement/save', { requirement: { id: req.id, title: req.title, description: req.description, project: PROJECT, discovery: { server: '有，node:sqlite 持久化', auth: '服务端校验，viewer 写接口 403', boundary: '前后端都交付，含测试' }, points } })
  // 需求准出门禁要求有产品输出：先补一份 PRD 正文（真实流程也是这么走的）
  await post('/requirement/doc', { id: req.id, action: 'add', by: '产品', doc: { id: 'prd', kind: 'prd', title: 'PRD', version: 'v1.0', content: '自检用 PRD：范围与验收标准各一句。' } })
  await post('/requirement/pool', { id: req.id, pool: { reach: 100, impact: 1, confidence: 80, effort: 2 } })

  const split = await post('/requirement/split', { id: req.id })
  const created = split.body.created ?? []
  step('答完三问可拆卡', split.status === 200 && created.length > 0, created.length + ' 张')
  step('没有后端覆盖提示', (split.body.warnings ?? []).length === 0, JSON.stringify(split.body.warnings ?? []))

  const cards = (await state()).tasks.filter(t => t.requirementId === req.id)
  for (const card of cards) {
    const wt = await post('/task/worktree', { id: card.id, action: 'create' })
    const info = wt.body.worktree ?? {}
    await post('/task/coding', { id: card.id, action: 'update', coding: { agent: 'dev', branch: info.branch ?? '', files: [], commits: [], tests: { total: 16, passed: 16 } } })
    await post('/task/case', { id: card.id, action: 'add', cases: [
      { title: 'pnpm test', expected: '没有失败', shell: { command: 'pnpm test', expectExit: 0, expectContains: 'fail 0', timeoutMs: 180000 } },
      { title: 'pnpm build', expected: 'built in', shell: { command: 'pnpm build', expectExit: 0, expectContains: 'built in', timeoutMs: 180000 } },
    ] })
    /* 项目检查（本地质量命令）参与准出：配一条能过的命令 → 跑过；换成会挂的 → 准出被拦；最后还原。
       cwd 走这张卡的 worktree，所以必须在 ensureWorktree 之后跑。
       这一步是「唯一一处机器跑出来的证据」进准出的回归——它坏了说明门禁又退化成自报了。 */
    if (card === cards[0]) {
      const project = (await state()).config.projects.find(item => item.id === PROJECT)
      if (project === undefined) {
        step('项目检查', false, '项目 ' + PROJECT + ' 不存在，没法配检查命令')
      } else {
        const saveCmd = cmd => post('/projects/save', { project: { ...project, qualityCmd: cmd, qualityTimeoutMs: 60000 } })
        await saveCmd('node --version')
        const qualityOk = await post('/task/quality', { id: card.id, by: '产品', wait: true })
        step('项目检查：跑过了', qualityOk.body.quality?.ok === true && String(qualityOk.body.quality?.cmd ?? '') === 'node --version',
          '退出码 ' + String(qualityOk.body.quality?.exitCode) + ' · ' + String(qualityOk.body.quality?.ms ?? '?') + 'ms')
        await saveCmd('node -e "process.exit(3)"')
        const qualityBad = await post('/task/quality', { id: card.id, by: '产品', wait: true })
        const gateBlocked = (qualityBad.body.gate?.blockers ?? []).some(text => String(text).includes('项目检查不通过'))
        step('项目检查：跑挂了拦准出', qualityBad.body.quality?.ok === false && gateBlocked,
          JSON.stringify((qualityBad.body.gate?.blockers ?? []).slice(0, 2)))
        // 还原成能过的状态：这张卡后面还要推到「已完成」
        await saveCmd('node --version')
        await post('/task/quality', { id: card.id, by: '产品', wait: true })
        await saveCmd(String(project.qualityCmd ?? ''))
      }
    }
    for (const status of ['design', 'dev_ready', 'dev', 'review']) await post('/task/update', { id: card.id, status })
    await new Promise(r => setTimeout(r, 2500))
    const reviewed = (await state()).tasks.find(t => t.id === card.id)
    /* 评审：以前这条链从「待评审」直接跳到「待测试」，没人写下评审结论。
       现在合并门禁要求 review=approved，所以这里补上——真实流程也应该是这样。 */
    await post('/task/coding', { id: card.id, action: 'review', status: 'approved', by: '架构师', reviewNote: '自检：改的是本卡范围' })
    await post('/task/update', { id: card.id, status: 'test' })
    const run = await post('/task/case/run', { id: card.id })
    /* 合并门禁（只算不发）：评审、用例、项目检查、代码事实都齐了才该放行。
       需要 GitLab 的那一步（发提交状态）在单测里用本地桩验过，自检环境不一定配了 GitLab。 */
    const mergeGate = await post('/task/merge-gate', { id: card.id, publish: false })
    step('卡 ' + card.code + ' 合并门禁', mergeGate.body?.gate?.applicable === true && mergeGate.body?.gate?.ready === true,
      JSON.stringify((mergeGate.body?.gate?.blockers ?? []).slice(0, 3)))
    const parts = (await post('/task/parts', { id: card.id })).body
    for (const item of (parts.checklist ?? [])) await post('/task/checklist', { id: card.id, action: 'check', itemId: item.id, by: '产品' })
    await post('/task/update', { id: card.id, status: 'accept' })
    await post('/task/signoff', { id: card.id, by: '产品', note: '用例通过' })
    const done = await post('/task/update', { id: card.id, status: 'done' })
    step('卡 ' + card.code, reviewed?.coding?.verified?.ok === true && run.body.run?.failed === 0 && done.body.task?.status === 'done',
      'worktree=' + (info.base ?? '?') + ' 核对=' + String(reviewed?.coding?.verified?.ok) + ' 用例=' + String(run.body.run?.passed) + '/' + String(run.body.run?.total))
  }

  // 上下文洞察：占用率必须是引擎窗口算出来的，构成占比加起来要是 100
  const contexts = await post('/contexts', {})
  const rows = contexts.body?.rows ?? []
  const totals = contexts.body?.totals ?? {}
  step('上下文洞察', rows.length > 0 && Number(totals.window) > 0, rows.length + ' 位专家 · 窗口 ' + Math.round((Number(totals.window) || 0) / 1000) + 'k · 最高占用 ' + (totals.percent ?? 0) + '%')
  const worstPercent = rows.reduce((max, row) => Math.max(max, Number(row.percent ?? 0)), 0)
  step('占用率可信', worstPercent >= 0 && worstPercent <= 100, '最高 ' + worstPercent + '%')
  const firstExpert = String(rows[0]?.expert ?? '')
  if (firstExpert !== '') {
    const detail = await post('/contexts/session', { expert: firstExpert })
    const parts = detail.body?.breakdown?.parts ?? []
    const sum = parts.reduce((total, part) => total + Number(part.percent ?? 0), 0)
    step('构成占比自洽', parts.length >= 4 && sum >= 99 && sum <= 101, firstExpert + ' 五项合计 ' + sum + '%')
  }

  const fin = await post('/requirement/signoff', { id: req.id, by: '产品', note: '全闭环自检通过' })
  const after = (await state()).requirements.find(r => r.id === req.id)
  step('需求交付', (fin.body.requirement?.status ?? after?.status) === 'delivered', String(fin.body.requirement?.status ?? after?.status))

  const cardsNow = (await state()).tasks.filter(t => t.requirementId === req.id)
  /* 技能沉淀：拿一张做完的卡挖一条草稿（预览模式，不落库）。
     判据是「只搬证据」：有出处段、草稿是停用的、名字是 kebab-case。 */
  const mined = await post('/skill/mine', { taskId: cardsNow[0]?.id, save: false })
  step('技能沉淀（预览）', mined.status === 200 && mined.body?.skill?.enabled === false && String(mined.body?.skill?.content ?? '').includes('## 出处'),
    String(mined.body?.skill?.name ?? mined.body?.error ?? '').slice(0, 80))
  const rel = await post('/release/save', { release: { name: '全闭环自检版本 ' + stamp, version: '0.0.0-' + stamp.replace(/[^0-9]/g, ''), project: PROJECT, tagName: 'e2e-' + stamp.replace(/[^0-9]/g, ''), smoke: [{ text: '自检脚本跑通', done: true }] } })
  const release = rel.body.release ?? {}
  await post('/release/link', { id: release.id, taskIds: cardsNow.map(c => c.id) })
  /* 审批是发布门禁（release-model.js）：先审批，再发布。以前自检直接 publish，
     撞出「没审批 → 不许审批」的死锁（2026-11-24）。 */
  const releaseApproved = await post('/release/approve', { id: release.id, by: '自检产品', note: '全闭环自检：审批通过' })
  step('版本审批', releaseApproved.body.release?.status === 'approved', String(releaseApproved.body.release?.status ?? releaseApproved.body.error).slice(0, 60))
  const releaseRevoked = await post('/release/approve', { id: release.id, by: '自检产品', action: 'revoke' })
  step('撤销审批', releaseRevoked.body.release?.status === 'candidate', String(releaseRevoked.body.release?.status ?? releaseRevoked.body.error).slice(0, 60))
  const releaseReApproved = await post('/release/approve', { id: release.id, by: '自检产品', note: '自检：重新审批' })
  step('重新审批', releaseReApproved.body.release?.status === 'approved', String(releaseReApproved.body.release?.status ?? releaseReApproved.body.error).slice(0, 60))
  const published = await post('/release/publish', { id: release.id, by: '产品', confirm: 'PUBLISH' })
  step('版本发布', published.body.release?.status === 'released', String(published.body.release?.status ?? published.body.error).slice(0, 50))

  if (!keep) {
    // 卡删掉但 worktree/分支留着的话会越积越多（实测积了 27 个）
    for (const card of cardsNow) await post('/task/worktree', { id: card.id, action: 'remove' })
    for (const card of cardsNow) await post('/task/delete', { id: card.id, confirm: 'DELETE' })
    await post('/requirement/delete', { id: req.id, confirm: 'DELETE' })
    if (release.id !== undefined) await post('/release/delete', { id: release.id, confirm: 'DELETE' })
    const left = await state()
    step('清理', left.tasks.filter(t => t.requirementId === req.id).length === 0, '已删除自检数据')
  }
  return failures
}

/* 目标机开着自动派单时，派单器会把自检卡接走（改状态、写广播、abort 会话），
   断言就会时红时绿（2026-11-27 在 218 上「需求交付」红过一次，紧接着重跑又绿）。
   自检要确定性：整轮跑之前临时停用，结束恢复。 */
let restoreAgents = null
try {
  const liveAgents = (await state())?.config?.agents ?? {}
  if (liveAgents.enabled === true) {
    const out = await post('/config', { agents: { ...liveAgents, enabled: false } })
    if (out.status === 200) {
      restoreAgents = { enabled: true }
      console.log('ℹ 已临时停用自动派单（自检卡不该被派单器接走），结束时恢复')
    }
  }
} catch { /* 读不到就当没开自动派单 */ }

const started = Date.now()
const results = []
for (let round = 1; round <= ROUNDS; round += 1) {
  console.log('\n第 ' + round + '/' + ROUNDS + ' 轮')
  results.push(await runOnce(round))
}
const passed = results.filter(f => f.length === 0).length
if (restoreAgents !== null) {
  try {
    const nowAgents = (await state())?.config?.agents ?? {}
    await post('/config', { agents: { ...nowAgents, enabled: restoreAgents.enabled } })
    console.log('ℹ 已恢复自动派单')
  } catch { console.log('⚠ 恢复自动派单失败：请到 设置 → 自动派单 手动打开') }
}
console.log('\n' + (ROUNDS > 1 ? 'k=' + ROUNDS + '：' : '') + passed + '/' + results.length + ' 轮全绿（' + Math.round((Date.now() - started) / 1000) + ' 秒）')
if (passed !== results.length) console.log('失败明细：' + results.map((f, i) => (f.length === 0 ? '' : '第' + (i + 1) + '轮 ' + f.join('/'))).filter(Boolean).join('；'))
process.exit(passed === results.length ? 0 : 1)
