// 让智能体真的参与：结构化需求描述 + 新建一张卡，派专家发言
import { launchTokenFromEnv, studioFetch } from './lib/studio-auth.mjs'

const BASE = process.env.STUDIO_BASE ?? 'http://192.168.120.218:18080'
const api = studioFetch(BASE, launchTokenFromEnv())
const post = async (p, b) => { const res = await api('/studio-api' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }); return { status: res.status, body: await res.json().catch(() => ({})) } }
const state = async () => (await (await api('/studio-api/state')).json()).state
const show = (label, ok, detail) => console.log((ok ? 'ok   ' : 'FAIL ') + label + (detail === undefined ? '' : ' — ' + detail))
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const description = [
  '## 背景',
  '管理后台现在只有一套密码登录（scrypt 校验 + HMAC 令牌），没有失败次数限制：密码错多少次都能继续试。',
  '',
  '## 目标',
  '同一账号连续登录失败达到阈值后锁定一段时间，并把失败原因明确告诉用户。',
  '',
  '## 范围',
  '- 登录接口增加失败计数与锁定判断（同一账号 5 次 / 10 分钟 → 锁 15 分钟）',
  '- 登录页在锁定时展示剩余时间，而不是笼统的「账号或密码不对」',
  '- 解锁：锁定到期自动解锁（本期不做管理员手工解锁）',
  '',
  '## 不做',
  '- 不做多设备登录记录、不做图形验证码、不做异地登录提醒',
  '',
  '## 验收',
  '- 连续 5 次密码错误后，第 6 次返回 423 并带剩余秒数',
  '- 锁定期间即使密码正确也拒绝，且不刷新 last_login',
  '- 到期后能正常登录；失败计数清零',
  '',
  '## 风险',
  '按账号计数可能被用来锁死他人账号（需评估是否改为 IP+账号组合）。',
].join('\n')

const current = (await state()).requirements.find(item => item.id === 'req-82f604')
const saved = await post('/requirement/save', { requirement: { id: current.id, title: current.title, description, project: current.project, domain: current.domain, points: current.points } })
show('需求描述写成结构化', saved.status === 200, '正文 ' + description.length + ' 字（原来 39 字）')

const card = await post('/task/create', {
  title: '登录失败次数限制与锁定',
  type: 'requirement',
  status: 'clarify',
  priority: 'normal',
  project: 'admin-portal',
  requirementId: 'req-82f604',
  pointId: 'p1',
  expert: 'expert-73ea5c',
  requirement: '按需求正文执行：连续 5 次失败锁 15 分钟，锁定期返回 423 并提示剩余时间，到期自动解锁。先出澄清结论，再给方案。',
})
const created = card.body.task ?? {}
show('建卡（挂在需求下）', created.id !== undefined, created.code + ' ' + created.id)

const launch = await post('/agents/run', { id: created.id, expert: 'expert-73ea5c' })
show('派单给产品专家', launch.body.ok === true, launch.body.ok === true ? 'launched' : JSON.stringify(launch.body).slice(0, 80))

// 等专家发言：轮询评论数
let comments = 0
for (let attempt = 0; attempt < 70; attempt += 1) {
  await sleep(15000)
  const fresh = (await state()).tasks.find(item => item.id === created.id)
  comments = (fresh?.comments ?? []).length
  if (comments > 0 && attempt > 2) break
}
const final = (await state()).tasks.find(item => item.id === created.id)
console.log('\n卡上评论数：' + (final?.comments ?? []).length)
for (const item of (final?.comments ?? []).slice(-3)) console.log('--- ' + item.author + '：' + String(item.body).slice(0, 300).replace(/\n/g, ' '))
console.log('\nCARD=' + created.id)
