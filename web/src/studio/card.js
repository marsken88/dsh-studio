/* A board card: title, requirement / project / service chips, owner chip and
*    drag handle. Rendering only — every action is a callback from the board.
 *
 * 外观迁到 BoardUI：表面 rounded-xl + border-separator-border + bg-background-primary-default，
 * 标题 text-body-2-semibold，元信息 text-caption-1-regular，状态色全走 token
 * （阻塞/逾期/缺陷 → text-text-error-primary / status-rose-*，不再有 hex）。
 * 拖拽没动：draggable、dataTransfer、onDragStart/onDragEnd 原样保留。
 * 定位只认 data-kanban-card（tools/visual/*.mjs 按它点开抽屉），不再挂手写类名。
 */

import { CASE_TIER_LABEL, PRIORITY_LABEL, ROLE_LABEL } from './labels.js'
import { statusDot, uiIcon } from './icons.js'
import { fmtDate, fmtTime } from './format.js'
import { artifactsWithoutBody, cardOwner, caseSummaryOf, checkSummaryOf, columnUnowned, commentCountOf } from './roster.js'

/** SLA 剩余时间换成人能读的量级：48 小时以内给小时，再往上给天。 */
function slaText(ms) {
  const hours = Math.max(1, Math.round(Math.abs(ms) / 3600000))
  return hours >= 48 ? `${Math.round(hours / 24)} 天` : `${hours}h`
}

/* 卡片表面 + 各种状态（紧急 / 正在跑 / 阻塞 / 缺正文）都用 data-* 变体表达，
   这样状态色不再依赖 legacy CSS 里那串 `[data-blocked="1"] { border-color:#e5484d80 }`。 */
const CARD = [
  'flex cursor-pointer flex-col gap-2 rounded-xl border border-separator-border bg-background-primary-default px-3 py-2 shadow-sm',
  'transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-accent-500 hover:shadow-md',
  'data-[dragging="1"]:opacity-60',
  'data-[urgent="1"]:border-l-[3px] data-[urgent="1"]:border-l-status-rose-text',
  'data-[running="1"]:border-accent-500',
  'data-[blocked="1"]:border-status-rose-text data-[blocked="1"]:border-l-[3px] data-[blocked="1"]:border-l-status-rose-text',
  'data-[nobody="1"]:border-status-rose-text',
].join(' ')
const TITLE = 'line-clamp-2 text-body-2-semibold text-text-primary'
const META = 'flex flex-wrap items-center gap-1 text-caption-1-regular text-text-tertiary'
const FOOT = 'flex flex-wrap items-center gap-x-2 gap-y-1 text-caption-1-regular text-text-tertiary'
/* 卡片底部的一项：**整项**换行，不让中文/分数在项内被拆开（以前 200px 列里「评论」「4/6」都会碎成两行）。 */
const META_ITEM = 'inline-flex shrink-0 items-center gap-1 whitespace-nowrap tabular-nums'
const DANGER = 'font-semibold text-text-error-primary'

/* 所有者的角色色：与列头的角色色条同一套 token（取值必须落在 BoardUI Chip 的 color 表里：
   orange / lime / rose / yellow / cyan / blue / purple / neutral / gray / soft）。
   自定义岗位没有专属色时回落到 neutral。 */
const ROLE_CHIP = { product: 'blue', architect: 'purple', dev: 'lime', qa: 'orange', ops: 'cyan' }

export function createCard({ h, ChipField }) {
function Card({ task, onOpen, config, requirements, onPickRequirement, onPickProject }) {
  const owner = cardOwner(task, config ?? {})
  const running = task.dispatch?.state === 'running'
  /* 崩溃后 reconcile 会把 state 改成 stopped，但印记仍匹配当前列 —— 这时卡既不在跑、
     也不会再被派单。以前这种卡和"排队中"长得一模一样，看板上看不出来。
     阶段：running（正在跑）/ stalled（停摆了，要人管）/ idle（人主动停止）/
          done（本轮已结束，没推进的会被催派）/ queued（排队中）。
     判据要和 src/host/dispatch-state.js 的 dispatchPhase 一致。 */
  const dispatchPhase = (() => {
    const dispatch = task.dispatch
    if (dispatch === null || dispatch === undefined || dispatch.status !== task.status) return 'queued'
    if (dispatch.state === 'running') return 'running'
    if (dispatch.state === 'stopped') return 'idle'
    if (dispatch.state === 'done' || dispatch.state === 'idle') return 'done'
    return 'stalled'
  })()
  const blocked = task.blocked ?? null
  const project = (config?.projects ?? []).find(entry => entry.id === task.project)
  const iteration = (project?.iterations ?? []).find(entry => entry.id === task.iteration)
  const service = (project?.services ?? []).find(entry => entry.id === task.service)
  const requirement = (requirements ?? []).find(entry => entry.id === task.requirementId)
  const check = checkSummaryOf(task)
  const caseRun = caseSummaryOf(task)
  const artifactCount = (task.artifacts ?? []).length
  const noBody = artifactsWithoutBody(task).length
  // 代码改动与评审结论：这是「研发干完活之后」人最先要看的两件事，以前只藏在抽屉的执行记录页签里。
  const coding = task.coding ?? null
  const codeFiles = Array.isArray(coding?.files) ? coding.files : []
  const codeAdditions = codeFiles.reduce((sum, item) => sum + (Number(item.additions) || 0), 0)
  const codeDeletions = codeFiles.reduce((sum, item) => sum + (Number(item.deletions) || 0), 0)
  const reviewStatus = String(coding?.review?.status ?? '')
  const reviewNote = String(coding?.review?.note ?? '').trim()
  const reviewTitle = reviewStatus === 'approved'
    ? `代码评审已通过${coding?.review?.by ? ` · ${coding.review.by}` : ''}${reviewNote === '' ? '' : `：${reviewNote.slice(0, 120)}`}`
    : `代码评审要求修改${coding?.review?.by ? ` · ${coding.review.by}` : ''}${reviewNote === '' ? '' : `：${reviewNote.slice(0, 120)}`}`
  const overdue = task.dueAt > 0 && task.dueAt < Date.now() && task.status !== 'done'
  return h('div', {
    className: CARD,
    'data-kanban-card': '',
    draggable: true,
    onDragStart: event => { event.dataTransfer.setData('text/plain', task.id); event.dataTransfer.effectAllowed = 'move'; event.currentTarget.setAttribute('data-dragging', '1') },
    onDragEnd: event => { event.currentTarget.removeAttribute('data-dragging') },
    'data-urgent': task.priority === 'urgent' ? '1' : '0',
    'data-running': running ? '1' : '0',
    'data-stalled': dispatchPhase === 'stalled' ? '1' : '0',
    'data-phase': dispatchPhase,
    'data-blocked': blocked === null ? '0' : '1',
    'data-nobody': noBody > 0 ? '1' : '0',
    onClick: () => onOpen(task.id),
    title: blocked === null ? (task.requirement || task.title) : `阻塞：${blocked.reason || '未填写原因'}`,
  },
    h('div', { className: TITLE }, task.title),
    h('div', { className: META },
      h('span', {
        className: task.priority === 'urgent'
          ? 'inline-block size-1.5 rounded-full bg-status-rose-text'
          : task.priority === 'relaxed' ? 'inline-block size-1.5 rounded-full bg-accent-300' : 'inline-block size-1.5 rounded-full bg-text-tertiary',
        'data-priority': task.priority,
        title: PRIORITY_LABEL[task.priority],
      }),
      task.code ? h(ChipField, { variant: 'soft', title: '卡编号：需求编号 + 需求内序号（如 REQ-2026-003-01）' }, task.code) : null,
      requirement !== undefined
        ? h(ChipField, {
            variant: 'purple',
            'data-req': '1',
            title: `需求 ${requirement.code || requirement.id}｜${requirement.title}${onPickRequirement === undefined ? '' : '（点一下只看这条需求）'}`,
            onClick: event => {
              if (onPickRequirement === undefined) return
              event.stopPropagation()
              onPickRequirement(requirement.id)
            },
          }, uiIcon(h, 'file'), ` ${requirement.code || requirement.title || '需求'}`)
        : h(ChipField, {
            variant: 'neutral',
            'data-req-missing': '1',
            title: '这张卡还没挂到需求上：点开卡片，在「计划」里选一条需求，编号会自动补',
            onClick: event => {
              event.stopPropagation()
              onOpen(task.id)
            },
          }, '未挂需求'),
      project !== undefined
        ? h(ChipField, {
            variant: 'blue',
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
        ? h(ChipField, { variant: 'neutral', 'data-iter': '1', title: `迭代 ${iteration.name}（${iteration.start || '未定'} → ${iteration.due || '未定'}）` }, uiIcon(h, 'clock'), ` ${iteration.name || iteration.id}`)
        : null,
      service !== undefined
        ? h(ChipField, { variant: 'neutral', 'data-svc': '1', title: `服务 ${service.name}${service.repoPath ? `｜${service.repoPath}` : ''}（worktree 从这里切）` }, uiIcon(h, 'suite'), ` ${service.name}`)
        : (task.service ?? '') !== ''
          ? h(ChipField, { variant: 'rose', 'data-svc-missing': '1', title: `卡上记的服务 ${task.service} 已经不在项目里了（服务被改名或删除），重新选一个` }, '服务已失效')
          : null,
      task.design === null || task.design === undefined || task.design.status === 'approved'
    ? null
    : h(ChipField, { variant: task.design.status === 'changes_requested' ? 'rose' : 'yellow', 'data-design': task.design.status }, task.design.status === 'changes_requested' ? '设计要改' : '设计待评审'),
  task.design?.diff === null || task.design?.diff === undefined
    ? null
    : h(ChipField, { variant: 'neutral', 'data-diff': task.design.diff.percent }, `还原度 ${Math.max(0, 100 - task.design.diff.percent).toFixed(1)}%${(() => {
        const history = task.design.diffHistory ?? []
        if (history.length < 2) return ''
        const delta = (history[0].percent - history[1].percent)
        return delta === 0 ? '（持平）' : delta > 0 ? `（−${delta.toFixed(1)}）` : `（+${Math.abs(delta).toFixed(1)}）`
      })()}`),
  task.design?.spec === null || task.design?.spec === undefined
    ? null
    : h(ChipField, {
      variant: task.design.spec.violations > 0 ? 'rose' : 'lime',
      'data-spec': task.design.spec.violations,
      title: (task.design.spec.top ?? []).map(item => `${item.value} ×${item.count}${item.sample === '' ? '' : ` — ${item.sample}`}`).join('\\n') || '没有野值',
    }, task.design.spec.violations > 0 ? `规范 ${task.design.spec.violations} 处` : '规范达标'),
  task.type === 'bug' ? h(ChipField, { variant: 'rose', 'data-sev': task.severity ?? 'p2' }, `BUG ${String(task.severity || 'p2').toUpperCase()}`) : null,
      // 改动的代码：卡面先给规模（多少文件、增删多少行），点开卡片能看逐行 diff。
      codeFiles.length > 0 || (coding?.commits ?? []).length > 0
        ? h(ChipField, {
          variant: 'neutral',
          'data-code': `${codeFiles.length}-${codeAdditions}-${codeDeletions}`,
          title: [
            `代码改动：${codeFiles.length} 个文件 +${codeAdditions} −${codeDeletions}`,
            (coding?.commits ?? []).length > 0 ? `${coding.commits.length} 次提交` : '',
            coding?.branch ? `分支 ${coding.branch}` : '',
            '点开卡片 → 执行记录 → 代码改动，看逐行 diff',
          ].filter(Boolean).join(' · '),
        }, codeFiles.length > 0 ? `代码 +${codeAdditions} −${codeDeletions}` : `${coding.commits.length} 次提交`)
        : null,
      // 评审结论：审批人、结论与意见摘要都放进 title，卡面一眼看到「过没过」。
      reviewStatus === 'approved'
        ? h(ChipField, { variant: 'lime', 'data-coding-review': 'approved', title: reviewTitle }, '评审通过')
        : reviewStatus === 'changes_requested'
          ? h(ChipField, { variant: 'rose', 'data-coding-review': 'changes_requested', title: reviewTitle }, '评审要改')
          : null,
      task.sla !== null && task.sla !== undefined && task.status !== 'done'
        ? h(ChipField, {
            variant: task.sla.state === 'overdue' ? 'rose' : task.sla.state === 'due_soon' ? 'yellow' : 'lime',
            'data-sla': task.sla.state,
            title: `SLA ${task.sla.hours} 小时，应修于 ${new Date(task.sla.dueAt).toLocaleString('zh-CN')}`,
          }, task.sla.state === 'overdue'
            ? `逾期 ${slaText(Math.abs(task.sla.remaining))}`
            : task.sla.state === 'due_soon' ? '快到时限' : `剩 ${slaText(task.sla.remaining)}`)
        : null,
      task.duplicateOf ? h(ChipField, { variant: 'neutral', 'data-duplicate': '1', title: '和另一张缺陷是同一件事' }, '重复') : null,
      (Number(task.reopenCount) || 0) > 0
        ? h(ChipField, { variant: 'yellow', 'data-reopen': task.reopenCount, title: `${task.reopenCount} 次修完又被打开` }, `重开 ${task.reopenCount}`)
        : null,
      blocked !== null ? h(ChipField, { variant: 'rose', 'data-blocked-chip': '1' }, '阻塞') : null,
      h(ChipField, {
        variant: owner.label === '未指派' ? 'neutral' : (ROLE_CHIP[owner.expert?.role || task.role] ?? 'neutral'),
        'data-role': owner.expert?.role || task.role,
        'data-open': owner.label === '未指派' ? '1' : '0',
        title: owner.note === undefined || owner.note === '' ? owner.label : `${owner.label} · ${owner.note}`,
      }, owner.label),
      task.domain ? h(ChipField, { variant: 'neutral' }, task.domain) : null,
      running ? h(ChipField, { variant: 'purple', 'data-ai': '1' }, 'AI 处理中') : null,

    ),
    blocked !== null ? h('div', { className: 'line-clamp-2 text-caption-1-regular text-text-error-primary', 'data-blocked-line': '' }, blocked.reason || '未填写原因') : null,
    /* 停摆用独立一行，不用 chip：Chip 适配层会把自定义类名吃掉（试过，DOM 里没有这个类）。
       这条必须一眼能看见 —— 停摆的卡不会再被自动派单，只会静静躺着。 */
    dispatchPhase === 'stalled'
      ? h('div', { className: 'rounded-md bg-status-yellow-background px-2 py-1 text-caption-1-regular text-status-yellow-text', 'data-stalled-line': '' }, 'AI 上次没有正常结束，这张卡不会再被自动派单 —— 需要手动「重新派单」')
      : null,
    h('div', { className: FOOT },
      task.dueAt > 0 ? h('span', { className: `${META_ITEM}${overdue ? ' ' + DANGER : ''}`, 'data-overdue': overdue ? '1' : '0', 'data-due': '' }, `${fmtDate(task.dueAt)}${overdue ? ' 逾期' : ''}`) : null,
      check.total > 0 ? h('span', { className: META_ITEM, title: '验收清单' }, uiIcon(h, 'checks'), ` ${check.done}/${check.total}`) : null,
      artifactCount > 0 ? h('span', { className: META_ITEM, title: '已登记交付物' }, uiIcon(h, 'attach'), ` ${artifactCount}`) : null,
      caseRun.total > 0 ? h('span', {
        className: `${META_ITEM}${caseRun.fail > 0 ? ' ' + DANGER : ''}`,
        'data-case': '1',
        title: `测试用例：通过 ${caseRun.pass}/${caseRun.total}${caseRun.fail > 0 ? `，不通过 ${caseRun.fail}` : ''}${(() => {
          const tiers = task.caseTiers ?? {}
          const rows = ['unit', 'integration', 'e2e'].map(tier => `${CASE_TIER_LABEL[tier]} ${tiers[tier]?.pass ?? 0}/${tiers[tier]?.total ?? 0}${tiers[tier]?.applicable === false ? '（不适用）' : ''}`)
          return rows.length > 0 ? `；${rows.join(' · ')}` : ''
        })()}`,
      }, uiIcon(h, caseRun.fail > 0 ? 'resultFail' : 'resultPass'), ` ${caseRun.pass}/${caseRun.total}`) : null,
      /* 三层测试缺口：代码类卡上三条线要各有能跑的用例（或写明不适用）。
         这是**缺口**不是结论，所以只在有缺口且卡上已经有测试动作时提示，避免新卡一片黄。 */
      (() => {
        if (!['dev', 'test', 'bug'].includes(String(task.type ?? ''))) return null
        const tiers = task.caseTiers ?? {}
        const missing = ['unit', 'integration', 'e2e'].filter(tier => (tiers[tier]?.applicable !== false) && (tiers[tier]?.executable ?? 0) === 0)
        if (missing.length === 0 || (caseRun.total === 0 && (tiers.unit?.total ?? 0) + (tiers.integration?.total ?? 0) + (tiers.e2e?.total ?? 0) === 0)) return null
        return h('span', {
          className: `${META_ITEM} text-status-yellow-text`,
          'data-tier-gap': missing.join(','),
          title: `三条测试线还缺：${missing.map(tier => CASE_TIER_LABEL[tier]).join('、')}。补能跑的用例，或在大模型会话里用 studio_task_test_plan 写明这一层为什么不适用`,
        }, '缺 ', missing.map(tier => CASE_TIER_LABEL[tier]).join('/'))
      })(),
      /* 本列没人负责：卡不会被自动派单，光看卡片看不出来（tick 静默跳过）。 */
      columnUnowned(config, task.status) && task.status !== 'done'
        ? h('span', { className: `${META_ITEM} ${DANGER}`, 'data-owner-missing': '1', title: '这一列还没配置负责人：这张卡不会被自动派单。到「设置 → 列的负责人」指派，或在卡上手动派单' }, statusDot(h, 'warn'), ' 等指派')
        : null,
      noBody > 0 ? h('span', { className: `${META_ITEM} ${DANGER}`, 'data-nobody-warn': '1', title: `${noBody} 件交付物还没写正文，云盘文档里只有标题` }, statusDot(h, 'warn'), ' 缺正文') : null,
      commentCountOf(task) > 0 ? h('span', { className: META_ITEM }, `${commentCountOf(task)} 评论`) : null,
      h('span', { className: 'ml-auto shrink-0 whitespace-nowrap tabular-nums' }, fmtTime(task.updatedAt)),
    ),
  )
}

  return Card
}
