// 端到端验证「MR 事实 vs 自报执行记录」：不依赖真实 GitLab。
// 前置：在跑 dsh 的那台机器上起打桩 —— node tools/mock-gitlab.mjs
//
// 关于鉴权：`/studio-api` 过宿主的信任栅栏，没有已认证的浏览器会话一律 401。
// 脚本没有浏览器，得用 dsh web 的启动 token 换 cookie —— 所以现在还要给 STUDIO_TOKEN：
//   STUDIO_TOKEN=<dsh web 启动 token> STUDIO_BASE=http://<host>:18080 node tools/verify-gitlab-facts.mjs
import { launchTokenFromEnv, studioFetch } from './lib/studio-auth.mjs'

const BASE = process.env.STUDIO_BASE ?? 'http://127.0.0.1:18080'
const api = studioFetch(BASE, launchTokenFromEnv())
const MOCK = process.env.MOCK_GITLAB ?? 'http://127.0.0.1:18098'
const IID = Number(process.env.MOCK_GITLAB_IID ?? 7)

const post = async (path, body) => {
  const res = await api('/studio-api' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}
const stateOf = async () => (await (await api('/studio-api/state')).json()).state

const before = await stateOf()
const gitlabBefore = before.config.gitlab ?? {}
const beforeIds = new Set(before.tasks.map((t) => t.id))
let failed = false
const check = (name, ok, detail) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail === undefined ? '' : ' — ' + detail))
  if (!ok) failed = true
}

try {
  await post('/config', {
    gitlab: { ...gitlabBefore, url: MOCK, projects: [{ id: 'mock', name: '演示仓库', project: 'demo/order' }] },
  })

  /* 现在的产品规则：卡必须挂在需求下（建卡路由会拒空 requirementId）。
     验证脚本自己建一条需求、跑完一起删。 */
  const reqSaved = await post('/requirement/save', { requirement: { title: '（验证用）GitLab 对账需求', status: 'draft' } })
  const requirementId = reqSaved.body.requirement?.id
  check('建需求', typeof requirementId === 'string' && requirementId !== '', String(reqSaved.body.error ?? requirementId))
  const card = await post('/task/create', { title: '（验证用）GitLab 对账', type: 'requirement', priority: 'normal', status: 'dev', requirementId })
  const id = card.body.task?.id
  check('建卡', typeof id === 'string' && id !== '', String(card.body.error ?? id))

  await post('/task/update', { id, gitlabMR: { iid: IID, title: 'feat: 库存预占（打桩）' } })
  await post('/task/coding', {
    id,
    action: 'update',
    coding: {
      agent: 'dev',
      branch: 'task/DEV-001',
      files: [{ path: 'src/a.js' }, { path: 'src/b.js' }],
      // 第一条真在 MR 里（前缀命中桩里的 a1b2c3d4），第二条是编的——要能被点出来
      commits: [{ sha: 'a1b2c3d4' }, { sha: 'deadbeef' }],
      // 桩里的 CI 报 11/12，自报 10/12 —— 单测数也要能被对上
      unitTests: { total: 12, passed: 10 },
    },
  })

  const out = await post('/coding/gitlab', { id })
  const facts = out.body.facts ?? {}
  check('接口返回 ok', out.body.ok === true, 'HTTP ' + out.status)
  check('文件数：自报 2 / MR 3', facts.files?.declared === 2 && facts.files?.actual === 3, JSON.stringify(facts.files))
  check('提交数：自报 2 / MR 3', facts.commits?.declared === 2 && facts.commits?.actual === 3, JSON.stringify(facts.commits))
  check('拉到逐条提交 3 条', Array.isArray(facts.commitList) && facts.commitList.length === 3, String(facts.commitList?.length))
  check('编造的提交被点出来', Array.isArray(facts.missingCommits) && facts.missingCommits.length === 1 && facts.missingCommits[0].startsWith('deadbeef'), JSON.stringify(facts.missingCommits))
  check('流水线取到 success', facts.pipeline === 'success', String(facts.pipeline))
  check('CI 单测 11/12', facts.ci?.source === 'test_report' && facts.ci?.total === 12 && facts.ci?.passed === 11, JSON.stringify(facts.ci))
  check('报出四处不一致', Array.isArray(facts.mismatches) && facts.mismatches.length === 4, JSON.stringify(facts.mismatches))

  const after = await stateOf()
  const saved = after.tasks.find((t) => t.id === id)
  check('结果写进卡片 coding.gitlab', saved?.coding?.gitlab?.files?.actual === 3, JSON.stringify(saved?.coding?.gitlab?.files))
  check('逐条提交与 CI 结果落库（没被白名单吃掉）',
    saved?.coding?.gitlab?.commitList?.length === 3 && saved?.coding?.gitlab?.ci?.total === 12,
    JSON.stringify({ commits: saved?.coding?.gitlab?.commitList?.length, ci: saved?.coding?.gitlab?.ci?.total }))

  for (const task of after.tasks) {
    if (!beforeIds.has(task.id)) await post('/task/delete', { id: task.id, confirm: 'DELETE' })
  }
  if (typeof requirementId === 'string' && requirementId !== '') await post('/requirement/delete', { id: requirementId, confirm: 'DELETE' })
  await post('/config', { gitlab: gitlabBefore })
  const final = await stateOf()
  console.log('清理完成：' + final.tasks.length + ' 张卡，gitlab 配置已还原')
} catch (error) {
  console.error('验证中断：' + (error?.message ?? error))
  failed = true
}

process.exit(failed ? 1 : 0)
