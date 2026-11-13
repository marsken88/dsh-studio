/* A board card: title, requirement / project / service chips, owner chip and
   drag handle. Rendering only — every action is a callback from the board. */

import { PRIORITY_LABEL, ROLE_LABEL } from './labels.js'
import { fmtDate, fmtTime } from './format.js'
import { artifactsWithoutBody, cardOwner, caseSummaryOf, checkSummaryOf, commentCountOf } from './roster.js'

export function createCard({ h, ChipField }) {
function Card({ task, onOpen, config, requirements, onPickRequirement, onPickProject }) {
  const owner = cardOwner(task, config ?? {})
  const running = task.dispatch?.state === 'running'
  const blocked = task.blocked ?? null
  const project = (config?.projects ?? []).find(entry => entry.id === task.project)
  const iteration = (project?.iterations ?? []).find(entry => entry.id === task.iteration)
  const service = (project?.services ?? []).find(entry => entry.id === task.service)
  const requirement = (requirements ?? []).find(entry => entry.id === task.requirementId)
  const check = checkSummaryOf(task)
  const caseRun = caseSummaryOf(task)
  const artifactCount = (task.artifacts ?? []).length
  const noBody = artifactsWithoutBody(task).length
  const overdue = task.dueAt > 0 && task.dueAt < Date.now() && task.status !== 'done'
  return h('div', {
    className: 'ds-card',
    draggable: true,
    onDragStart: event => { event.dataTransfer.setData('text/plain', task.id); event.dataTransfer.effectAllowed = 'move'; event.currentTarget.setAttribute('data-dragging', '1') },
    onDragEnd: event => { event.currentTarget.removeAttribute('data-dragging') },
    'data-urgent': task.priority === 'urgent' ? '1' : '0',
    'data-running': running ? '1' : '0',
    'data-blocked': blocked === null ? '0' : '1',
    'data-nobody': noBody > 0 ? '1' : '0',
    onClick: () => onOpen(task.id),
    title: blocked === null ? (task.requirement || task.title) : `阻塞：${blocked.reason || '未填写原因'}`,
  },
    h('div', { className: 'ds-card-title' }, task.title),
    h('div', { className: 'ds-meta' },
      h('span', { className: 'ds-dot', 'data-p': task.priority, title: PRIORITY_LABEL[task.priority] }),
      task.code ? h(ChipField, { className: 'ds-chip ds-chip-code', title: '需求下的编号' }, task.code) : null,
      requirement !== undefined
        ? h(ChipField, {
            className: 'ds-chip',
            'data-req': '1',
            title: `需求 ${requirement.code || requirement.id}｜${requirement.title}${onPickRequirement === undefined ? '' : '（点一下只看这条需求）'}`,
            onClick: event => {
              if (onPickRequirement === undefined) return
              event.stopPropagation()
              onPickRequirement(requirement.id)
            },
          }, `📄 ${requirement.code || requirement.title || '需求'}`)
        : h(ChipField, {
            className: 'ds-chip',
            'data-req-missing': '1',
            title: '这张卡还没挂到需求上：点开卡片，在「计划」里选一条需求，编号会自动补',
            onClick: event => {
              event.stopPropagation()
              onOpen(task.id)
            },
          }, '未挂需求'),
      project !== undefined
        ? h(ChipField, {
            className: 'ds-chip',
            'data-proj': '1',
            title: `${project.name}${onPickProject === undefined ? '' : '（点一下只看这个项目）'}`,
            onClick: event => {
              if (onPickProject === undefined) return
              event.stopPropagation()
              onPickProject(project.id)
            },
          }, project.key || project.name)
        : null,
      iteration !== undefined
        ? h(ChipField, { className: 'ds-chip', 'data-iter': '1', title: `迭代 ${iteration.name}（${iteration.start || '未定'} → ${iteration.due || '未定'}）` }, `🗓 ${iteration.name || iteration.id}`)
        : null,
      service !== undefined
        ? h(ChipField, { className: 'ds-chip', 'data-svc': '1', title: `服务 ${service.name}${service.repoPath ? `｜${service.repoPath}` : ''}（worktree 从这里切）` }, `📦 ${service.name}`)
        : (task.service ?? '') !== ''
          ? h(ChipField, { className: 'ds-chip', 'data-svc-missing': '1', title: `卡上记的服务 ${task.service} 已经不在项目里了（服务被改名或删除），重新选一个` }, '📦 服务已失效')
          : null,
      task.design === null || task.design === undefined || task.design.status === 'approved'
    ? null
    : h(ChipField, { className: 'ds-chip', 'data-design': task.design.status }, task.design.status === 'changes_requested' ? '设计要改' : '设计待评审'),
  task.design?.diff === null || task.design?.diff === undefined
    ? null
    : h(ChipField, { className: 'ds-chip', 'data-diff': task.design.diff.percent }, `还原度 ${Math.max(0, 100 - task.design.diff.percent).toFixed(1)}%${(() => {
        const history = task.design.diffHistory ?? []
        if (history.length < 2) return ''
        const delta = (history[0].percent - history[1].percent)
        return delta === 0 ? '（持平）' : delta > 0 ? `（−${delta.toFixed(1)}）` : `（+${Math.abs(delta).toFixed(1)}）`
      })()}`),
  task.design?.spec === null || task.design?.spec === undefined
    ? null
    : h(ChipField, {
      className: 'ds-chip',
      'data-spec': task.design.spec.violations,
      title: (task.design.spec.top ?? []).map(item => `${item.value} ×${item.count}${item.sample === '' ? '' : ` — ${item.sample}`}`).join('\n') || '没有野值',
    }, task.design.spec.violations > 0 ? `规范 ${task.design.spec.violations} 处` : '规范达标'),
  task.type === 'bug' ? h(ChipField, { className: 'ds-chip ds-chip-bug', 'data-sev': task.severity ?? 'p2' }, `BUG ${String(task.severity || 'p2').toUpperCase()}`) : null,
      task.sla !== null && task.sla !== undefined && task.status !== 'done'
        ? h(ChipField, {
            className: 'ds-chip',
            'data-sla': task.sla.state,
            title: `SLA ${task.sla.hours} 小时，应修于 ${new Date(task.sla.dueAt).toLocaleString('zh-CN')}`,
          }, task.sla.state === 'overdue'
            ? `⏰ 逾期 ${Math.max(1, Math.round(Math.abs(task.sla.remaining) / 3600000))}h`
            : task.sla.state === 'due_soon' ? '⏰ 快到时限' : `⏰ 剩 ${Math.max(1, Math.round(task.sla.remaining / 3600000))}h`)
        : null,
      task.duplicateOf ? h(ChipField, { className: 'ds-chip', title: '和另一张缺陷是同一件事' }, '重复') : null,
      (Number(task.reopenCount) || 0) > 0
        ? h(ChipField, { className: 'ds-chip', title: `${task.reopenCount} 次修完又被打开` }, `重开 ${task.reopenCount}`)
        : null,
      blocked !== null ? h(ChipField, { className: 'ds-chip ds-chip-blocked' }, '⛔ 阻塞') : null,
      h(ChipField, {
        className: 'ds-chip',
        'data-role': owner.expert?.role || task.role,
        'data-open': owner.label === '未指派' ? '1' : '0',
        title: owner.note === undefined || owner.note === '' ? owner.label : `${owner.label} · ${owner.note}`,
      }, owner.label),
      task.domain ? h(ChipField, { className: 'ds-chip' }, task.domain) : null,
      running ? h(ChipField, { className: 'ds-chip ds-chip-ai' }, 'AI 处理中') : null,
    ),
    blocked !== null ? h('div', { className: 'ds-blocked-line' }, blocked.reason || '未填写原因') : null,
    h('div', { className: 'ds-card-foot' },
      h('span', {}, task.id),
      task.dueAt > 0 ? h('span', { 'data-overdue': overdue ? '1' : '0', style: overdue ? { color: '#e5484d', fontWeight: 600 } : null }, `· ${fmtDate(task.dueAt)}${overdue ? ' 逾期' : ''}`) : null,
      check.total > 0 ? h('span', { title: '验收清单' }, `· ☑ ${check.done}/${check.total}`) : null,
      artifactCount > 0 ? h('span', { title: '已登记交付物' }, `· 📎 ${artifactCount}`) : null,
      caseRun.total > 0 ? h('span', {
        className: caseRun.fail > 0 ? 'ds-case-fail' : '',
        title: `测试用例：通过 ${caseRun.pass}/${caseRun.total}${caseRun.fail > 0 ? `，不通过 ${caseRun.fail}` : ''}`,
      }, `· ${caseRun.fail > 0 ? '❌' : '✅'} ${caseRun.pass}/${caseRun.total}`) : null,
      noBody > 0 ? h('span', { className: 'ds-card-warn', title: `${noBody} 件交付物还没写正文，云盘文档里只有标题` }, '● 缺正文') : null,
      (task.coding?.files?.length ?? 0) > 0 ? h('span', { title: 'AI Coding 改动文件数' }, `· ⌥ ${task.coding.files.length}`) : null,
      commentCountOf(task) > 0 ? h('span', {}, `· ${commentCountOf(task)} 评论`) : null,
      h('span', { style: { marginLeft: 'auto' } }, fmtTime(task.updatedAt)),
    ),
  )
}

  return Card
}
