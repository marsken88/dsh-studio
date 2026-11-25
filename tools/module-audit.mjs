// 数据层逐模块体检：页面不崩 ≠ 数据对。这里检查各模块之间的引用是否断裂、
// 枚举值是否越界、必填项是否缺失。只读，不改任何东西。
//
// 用法：STUDIO_BASE=http://host:18080 STUDIO_TOKEN=<dsh web 启动 token> node tools/module-audit.mjs
//   `/studio-api` 过宿主的信任栅栏，没有已认证的浏览器会话就 401。以前这里发
//   `authorization: Bearer …`——宿主只认 cookie，那头发过去从来没被认过；现在由
//   studio-auth 用启动 token 换 cookie。
import { launchTokenFromEnv, studioFetch } from './lib/studio-auth.mjs'

const BASE = process.env.STUDIO_BASE ?? 'http://192.168.120.218:18080'
const api = studioFetch(BASE, launchTokenFromEnv())
const get = async path => {
  const res = await api(path)
  if (res.ok === false) throw new Error(`${path} → HTTP ${res.status}`)
  return res.json()
}

const state = (await get('/studio-api/state')).state
const statuses = new Set((state.statuses ?? []).map(s => s.id))
const tasks = state.tasks ?? []
const requirements = state.requirements ?? []
const releases = state.releases ?? []
const experts = state.config?.experts ?? []
const teams = state.config?.teams ?? []

const findings = []
const add = (module, severity, message, sample = '') => findings.push({ module, severity, message, sample })

/* -------------------------------------------------------------- 专家 --- */
const expertIds = new Set(experts.map(e => e.id))
for (const expert of experts) {
  if (String(expert.name ?? '').trim() === '') add('专家', '高', `专家 ${expert.id} 没有名字`, '')
  else if (expert.name === expert.id) add('专家', '中', `专家名字就是 id（面板里显示成 ${expert.id}）`, expert.id)
  if (expert.enabled !== false && String(expert.model ?? '').trim() === '' && String(state.config?.roles?.[expert.role]?.model ?? '').trim() === '') {
    add('专家', '中', `专家 ${expert.name} 既没配模型也没有角色默认模型`, expert.id)
  }
}
if (experts.length === 0) add('专家', '高', '一个专家都没有，派单无处可去')

/* -------------------------------------------------------------- 专家团 --- */
for (const team of teams) {
  for (const member of team.members ?? []) {
    if (!expertIds.has(member)) add('专家团', '高', `团「${team.name}」的成员 ${member} 不存在`, team.id)
  }
  if (team.lead !== undefined && team.lead !== '' && !expertIds.has(team.lead)) add('专家团', '高', `团「${team.name}」的团长 ${team.lead} 不存在`, team.id)
  if ((team.members ?? []).length === 0) add('专家团', '中', `团「${team.name}」没有成员`, team.id)
  if ((team.members ?? []).length > 0 && !(team.members ?? []).includes(team.lead) && team.lead !== '') {
    add('专家团', '低', `团「${team.name}」的团长不在成员里`, team.id)
  }
}

/* ---------------------------------------------------------------- 卡 --- */
const taskIds = new Set(tasks.map(t => t.id))
const requirementIds = new Set(requirements.map(r => r.id))
const codes = new Map()
for (const task of tasks) {
  if (!statuses.has(task.status)) add('卡片', '高', `${task.code || task.id} 的状态 ${task.status} 不在列定义里`, task.id)
  if (String(task.title ?? '').trim() === '') add('卡片', '高', `${task.id} 没有标题`, task.id)
  if (task.requirementId !== undefined && task.requirementId !== '' && !requirementIds.has(task.requirementId)) {
    add('卡片', '中', `${task.code || task.id} 挂的需求 ${task.requirementId} 不存在`, task.id)
  }
  if (task.parent !== undefined && task.parent !== '' && !taskIds.has(task.parent)) add('卡片', '中', `${task.code || task.id} 的父卡 ${task.parent} 不存在`, task.id)
  if (task.expert !== undefined && task.expert !== '' && !expertIds.has(task.expert) && !/^(product|architect|dev|qa)$/.test(task.expert)) {
    add('卡片', '中', `${task.code || task.id} 指派的负责人 ${task.expert} 不存在`, task.id)
  }
  if (task.project !== undefined && task.project !== '') {
    const projects = state.config?.projects ?? []
    if (!projects.some(p => p.id === task.project)) add('卡片', '中', `${task.code || task.id} 挂的项目 ${task.project} 不存在`, task.id)
  }
  if (task.code) codes.set(task.code, (codes.get(task.code) ?? 0) + 1)
  for (const item of task.checklist ?? []) {
    if (String(item.text ?? '').trim() === '') add('卡片', '低', `${task.code || task.id} 有一条空清单项`, task.id)
  }
  if (task.signoff && String(task.signoff.note ?? '').trim() === '') add('卡片', '低', `${task.code || task.id} 签字没有结论`, task.id)
}
for (const [code, count] of codes) if (count > 1) add('卡片', '中', `编号 ${code} 重复 ${count} 次`, '')

/* -------------------------------------------------------------- 需求 --- */
for (const req of requirements) {
  const mine = tasks.filter(t => t.requirementId === req.id)
  if (String(req.title ?? '').trim() === '') add('需求', '高', `需求 ${req.code || req.id} 没有标题`, req.id)
  if (mine.length === 0 && (req.status === 'active' || req.status === 'delivered')) {
    add('需求', '中', `需求 ${req.code || req.id} 是 ${req.status} 但一张卡都没有`, req.id)
  }
  if (req.status === 'delivered' && !req.signoff) add('需求', '低', `需求 ${req.code || req.id} 标了已交付但没有签字`, req.id)
}

/* -------------------------------------------------------------- 版本 --- */
const releaseIds = new Set(releases.map(r => r.id))
for (const release of releases) {
  if (release.project !== undefined && release.project !== '') {
    const projects = state.config?.projects ?? []
    if (!projects.some(p => p.id === release.project)) add('版本', '中', `版本 ${release.version} 挂的项目 ${release.project} 不存在`, release.id)
  }
  for (const cardId of release.cards ?? []) {
    if (!taskIds.has(cardId) && !tasks.some(t => t.code === cardId)) add('版本', '中', `版本 ${release.version} 引用的卡 ${cardId} 不存在`, release.id)
  }
}
for (const task of tasks) {
  if (task.releaseId !== undefined && task.releaseId !== '' && !releaseIds.has(task.releaseId) && !releases.some(r => r.version === task.releaseId)) {
    add('版本', '低', `${task.code || task.id} 挂的版本 ${task.releaseId} 不存在`, task.id)
  }
}

/* -------------------------------------------------------------- 用例 --- */
let cases = 0
for (const task of tasks) {
  for (const item of task.cases ?? []) {
    cases += 1
    if (String(item.title ?? '').trim() === '') add('用例', '中', `${task.code || task.id} 有一条没有标题的用例`, task.id)
    const hasHttp = Boolean(item.http?.url) || (Array.isArray(item.http?.steps) && item.http.steps.length > 0)
    if (item.result === 'pass' && hasHttp === false && String(item.command ?? '') === '' && item.browser === undefined && item.db === undefined) {
      add('用例', '中', `${task.code || task.id} 的用例「${item.title}」标了通过，但没有任何可执行的断言`, task.id)
    }
  }
}

/* -------------------------------------------------------------- 输出 --- */
const order = { 高: 0, 中: 1, 低: 2 }
findings.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3))
const byModule = new Map()
for (const finding of findings) {
  byModule.set(finding.module, (byModule.get(finding.module) ?? 0) + 1)
}

console.log(`数据面：${tasks.length} 卡 / ${requirements.length} 需求 / ${releases.length} 版本 / ${experts.length} 专家 / ${teams.length} 专家团 / ${cases} 用例`)
console.log(`问题：${findings.length} 条` + (findings.length === 0 ? '' : '（按模块：' + [...byModule.entries()].map(([m, n]) => `${m} ${n}`).join(' · ') + '）'))
for (const finding of findings) console.log(`  [${finding.severity}] ${finding.module}：${finding.message}${finding.sample === '' ? '' : `（${finding.sample}）`}`)
process.exit(findings.filter(f => f.severity === '高').length === 0 ? 0 : 1)
