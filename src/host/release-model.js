/* 版本的纯逻辑：门禁与发布说明。从 index.js 抬出来，给 2700 行上限留空间，
 * 也让「审批是门禁」这条能被单测直接断言（不用起整个宿主）。
 */

/** 审批这条 blocker：发布要它，但「点审批」本身不能被它挡住（否则永远批不了）。 */
export const RELEASE_APPROVAL_BLOCKER = '还没有发布审批：先在版本上点「审批通过」并写结论'

/** 一个版本能不能发：卡全做完、没阻塞、缺陷关闭、用例没有失败、有人在版本上审批过。
 *  options.ignoreApproval 只在「审批动作」里用：其它门禁都过了就该允许批。 */
export function releaseGate(state, release, options = {}) {
  const tasks = state.tasks.filter(task => task.releaseId === release.id)
  const open = tasks.filter(task => task.status !== 'done')
  const blocked = tasks.filter(task => task.blocked !== null && task.blocked !== undefined)
  const bugs = tasks.filter(task => task.type === 'bug' && task.status !== 'done')
  const failing = []
  const emptyArtifacts = []
  for (const task of tasks) {
    for (const item of task.cases ?? []) {
      if (item.result === 'fail') failing.push({ taskId: task.id, code: task.code, title: item.title })
    }
    for (const item of task.artifacts ?? []) {
      if (String(item.content ?? '').trim() === '') emptyArtifacts.push({ taskId: task.id, code: task.code, title: item.title })
    }
  }
  const blockers = []
  const smoke = release.smoke ?? []
  const smokeOpen = smoke.filter(item => item.done !== true)
  if (tasks.length === 0) blockers.push('这个版本还没有关联任何卡片')
  if (open.length > 0) blockers.push(`${open.length} 张卡还没完成：${open.slice(0, 4).map(task => task.code || task.id).join('、')}`)
  if (blocked.length > 0) blockers.push(`${blocked.length} 张卡处于阻塞`)
  if (bugs.length > 0) blockers.push(`${bugs.length} 个缺陷未关闭`)
  if (failing.length > 0) blockers.push(`${failing.length} 条用例仍是失败状态`)
  if (String(release.tagName ?? '').trim() === '') blockers.push('还没有填发布标签（tag）：发布要能对应到一段确定的代码')
  if (smokeOpen.length > 0) blockers.push(`${smokeOpen.length} 项冒烟还没过：${smokeOpen.slice(0, 3).map(item => item.text).join('、')}`)
  /* 审批是门禁，不是提示：没有人在版本上点过「审批通过」，就不许发。 */
  if ((release.approvals ?? []).length === 0) blockers.push(RELEASE_APPROVAL_BLOCKER)
  const warnings = []
  if (emptyArtifacts.length > 0) warnings.push(`${emptyArtifacts.length} 件交付物缺正文`)
  if (tasks.length > 0 && tasks.every(task => (task.artifacts ?? []).length === 0)) warnings.push('这批卡一件交付物都没登记')
  const gray = release.grayBatches ?? []
  const grayPending = gray.filter(item => item.status === 'pending' || item.status === 'running')
  if (gray.length === 0) warnings.push('没有灰度批次：将一次性全量发布')
  if (gray.length > 0 && grayPending.length > 0 && release.status === 'released') {
    warnings.push(`还有 ${grayPending.length} 批灰度没走完`)
  }
  // approvable：除了「还没审批」之外没有别的 blocker —— 面板据此决定「审批通过」按钮是否可点。
  const blockingWithoutApproval = blockers.filter(item => item !== RELEASE_APPROVAL_BLOCKER)
  const approvable = blockingWithoutApproval.length === 0 && release.status !== 'released'
  /* 审批动作（ignoreApproval）只看「除审批外」的门禁；发布（默认）仍然要求审批。
     2026-11-24 e2e 自检抓到：只算 approvable、不改 ready，审批接口还是会说「还没有发布审批」。 */
  const effective = options.ignoreApproval === true ? blockingWithoutApproval : blockers
  return {
    ready: effective.length === 0 && release.status !== 'released',
    approvable,
    blockers,
    warnings,
    stats: {
      tasks: tasks.length,
      done: tasks.length - open.length,
      open: open.length,
      blocked: blocked.length,
      bugs: bugs.length,
      failing: failing.length,
      artifacts: tasks.reduce((sum, task) => sum + (task.artifacts ?? []).length, 0),
      emptyArtifacts: emptyArtifacts.length,
      smoke: { total: smoke.length, done: smoke.length - smokeOpen.length },
      approvals: (release.approvals ?? []).length,
      gray: { total: gray.length, passed: gray.filter(item => item.status === 'passed').length },
    },
  }
}

/** 发布说明：按类型分组，编号 + 标题，人可以直接贴到群里。 */
export function releaseNotes(state, release) {
  const tasks = state.tasks.filter(task => task.releaseId === release.id)
  const groups = [
    ['requirement', '需求'],
    ['design', '设计'],
    ['dev', '研发'],
    ['bug', '缺陷修复'],
    ['test', '测试'],
    ['ops', '运维'],
  ]
  const lines = [`# ${release.version || '未编号'} ${release.name}`.trim(), '']
  const when = release.releasedAt > 0 ? release.releasedAt : release.plannedAt
  if (when > 0) lines.push(`- 时间：${new Date(when).toISOString().slice(0, 10)}`)
  if (release.owner !== '') lines.push(`- 负责人：${release.owner}`)
  lines.push(`- 关联卡片：${tasks.length} 张`)
  lines.push('')
  // 版本 ↔ 需求：从卡片上的 requirementId 反查，发版说明里能直接看到这次交付了哪几条需求。
  const reqIds = [...new Set(tasks.map(task => String(task.requirementId ?? '')).filter(id => id !== ''))]
  const reqs = reqIds.map(id => state.requirements.find(item => item.id === id)).filter(item => item !== undefined)
  if (reqs.length > 0) {
    lines.push(`## 需求（${reqs.length} 条）`)
    for (const req of reqs) lines.push(`- ${req.code === '' ? req.id : req.code} ${req.title}`)
    lines.push('')
  }
  let any = false
  for (const [type, label] of groups) {
    const list = tasks.filter(task => (task.type ?? 'requirement') === type)
    if (list.length === 0) continue
    any = true
    lines.push(`## ${label}`)
    for (const task of list) {
      const code = task.code === '' ? task.id : task.code
      lines.push(`- ${code} ${task.title}`)
    }
    lines.push('')
  }
  if (!any) lines.push('（这个版本还没有关联卡片）')
  return lines.join('\n').slice(0, 60000)
}
