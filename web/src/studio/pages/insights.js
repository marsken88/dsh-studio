/* Page-level components lifted out of client.src.js; shared handles come from the studio context. */

/* 工作台：整页 BoardUI（Tailwind token + 4px 档位），不再用手写样式：
 *   - 板块外壳：rounded-xl + border-separator-border + bg-background-primary-default
 *   - 数字：StatCard（boardui/chart-card，data-stat-card 是稳定钩子）
 *   - 列表行：TaskRow（boardui/task-list，data-task-row）
 *   - 空态：boardui/empty-state
 *   - 动作：boardui/index 的 Button
 */
import { fmtTime, fmtDate } from '../format.js'
import { client } from '../context.js'
import { StatCard } from '../../boardui/chart-card'
import { TaskRow } from '../../boardui/task-list'
import { Button } from '../../boardui/index'
import { PAGE, PANEL, PANEL_HEAD, PANEL_BODY } from './layout.js'

/* [&>*]:shrink-0 —— 纵向 flex 默认会压缩子项：内容高于视口时每个分区被压扁，
   而分区自己 overflow-hidden，里面的内容就被裁掉（工作台出现「空条」的根因）。 */
const HINT = 'text-caption-1-regular text-text-tertiary'
const LABEL = 'text-caption-1-medium text-text-secondary'
/* 5 张卡：宽屏一排 5 张；窄一档时 2 列排不完，第 5 张横跨两列，
   避免「2+2+1」最后一行只剩一张窄卡（unslop：KPI 不许落单）。 */
const KPI_GRID = 'grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5 sm:[&>*:last-child]:col-span-2 xl:[&>*:last-child]:col-span-1'

export function DashboardPage({ state, onOpenTask, onOpenBoard, onOpenCases }) {
  const { h, React, api, toast } = client()
  const [data, setData] = React.useState(null)
  const [regression, setRegression] = React.useState(null)
  const [note, setNote] = React.useState(null)
  React.useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const json = await api('/dashboard')
        if (alive) { setData(json?.dashboard ?? null); setRegression(json?.regression ?? null) }
      } catch (cause) {
        if (alive) { const detail = cause instanceof Error ? cause.message : String(cause); setNote(detail); toast(detail, 'error') }
      }
    })()
    return () => { alive = false }
  }, [state.revision])

  if (data === null) {
    /* 载入中/接口没回 dashboard 时也把「今天要处理」的架子画出来：
       以前只有一行灰字，页面看起来是空的；现在用真 StatCard 占位（值给 —），
       数字一到就原地替换。 */
    const pending = (label) => h(StatCard, { key: label, label, value: '—', hint: note === null ? '正在统计…' : '读不到数据' })
    return h('div', { className: PAGE, 'data-insights-page': '', 'data-insights-pending': note === null ? 'loading' : 'error' },
      note === null ? null : h('div', { className: 'rounded-xl border border-border-error-default bg-background-tertiary-error px-4 py-3 text-caption-1-regular text-text-error-primary' }, `算不出来：${note}`),
      h('div', { className: 'flex min-w-0 flex-col gap-2' },
        h('div', { className: 'text-caption-1-medium text-text-tertiary' }, '今天要处理'),
        h('div', { className: KPI_GRID },
          ['逾期', '阻塞', '停摆', '缺陷超时', '准出被拦'].map(pending),
        ),
      ),
    )
  }
  // 最近一次回归：昨晚的定时回归就跑在这里；有失败时整条标红。
  const regressionLine = regression === null ? null : (() => {
    const failed = (Number(regression.failed) || 0) + (Number(regression.failedCards) || 0) > 0
    return h('div', {
      className: failed
        ? 'flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-border-error-default bg-background-tertiary-error px-4 py-3'
        : 'flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-separator-border bg-background-secondary-default px-4 py-3',
      'data-regression-banner': failed ? 'bad' : 'ok',
    },
      h('span', { className: 'text-body-2-medium text-text-primary' }, `最近回归 · ${fmtTime(regression.at)} · ${regression.by || '人'}`),
      h('span', { className: HINT },
        `${regression.cards} 张卡 / ${regression.total} 条：通过 ${regression.passed}${failed ? `，不通过 ${regression.failed}` : ''}${regression.bugs > 0 ? ` · 自动开缺陷 ${regression.bugs} 张` : ''}`),
      onOpenCases === undefined ? null : h(Button, { variant: 'ghost', size: 'sm', onClick: () => onOpenCases() }, '看用例'),
    )
  })()
  const risks = data.risks ?? {}
  const flow = data.flow ?? {}
  const ai = data.ai ?? {}
  // KPI 与任务行都是 BoardUI 的实现：与效能页共用同一套壳，不再和手写 KPI 卡混排。
  /* KPI 卡以前点了没反应（数字很刺眼但进不去）。现在整块可点、可键盘触发，落到看板。 */
  const kpi = (label, value, hint, warn) => onOpenBoard === undefined
    ? h(StatCard, { key: label, label, value: String(value ?? 0), hint, warn: warn === true })
    : h('div', {
      key: label,
      role: 'button',
      tabIndex: 0,
      'data-kpi-link': label,
      'aria-label': `${label}：${value}，点开看板`,
      className: 'min-w-0 cursor-pointer rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring',
      onClick: () => onOpenBoard(),
      onKeyDown: event => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onOpenBoard()
      },
    }, h(StatCard, { label, value: String(value ?? 0), hint, warn: warn === true }))
  const taskRow = (item) => h(TaskRow, {
    key: item.id,
    title: `${item.code || item.id} · ${item.title}`,
    hint: `${item.statusLabel}${item.dueAt > 0 ? ` · 截止 ${fmtDate(item.dueAt)}` : ''}${item.sla?.state === 'overdue' ? ' · 缺陷超时' : ''}`,
    action: h(Button, { variant: 'ghost', size: 'sm', onClick: () => onOpenTask(item.id) }, '打开'),
  })
  const flowCell = (label, value) => h('div', { className: 'flex min-w-0 flex-col gap-1' },
    h('div', { className: LABEL }, label),
    h('div', { className: 'text-title-2-semibold text-text-primary tabular-nums' }, String(value ?? 0)))
  /* 没有内容的区块收成一行：一块 150px 的空面板 × 六七块，首屏全在说「没有」。
     有内容时仍然是完整面板（表格行要空间）。（unslop：首屏每一块都要讲一件事，不拿空白占版面） */
  /* 每类清单后端只给 6 条（首屏放得下），但总数一起下发：
     以前 KPI 写「逾期 12」、下面只列 6 行，剩下 6 张无从得知。
     total 多于 rows 时在块头写「还有 N 张」，并给一个带筛选进看板的入口。 */
  const block = (title, rows, empty, hint, total) => {
    const rest = Number(total ?? rows.length) - rows.length
    const more = rest > 0
      ? h('span', { className: 'ml-auto flex items-center gap-2 text-caption-1-regular text-text-secondary', 'data-more-hint': title },
        h('span', null, `还有 ${rest} 张`),
        onOpenBoard === undefined ? null : h(Button, { variant: 'ghost', size: 'xs', onClick: () => onOpenBoard() }, '去看板'))
      : null
    return rows.length === 0
      ? h('div', {
        className: 'flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-separator-border bg-background-secondary-default px-4 py-2',
        'data-empty-block': title,
        // 收成一行仍然是「空态」：pages 探针靠 data-empty-state 断言每个空分区都写出了原因。
        'data-empty-state': '',
      },
        h('span', { className: 'text-caption-1-medium text-text-secondary' }, title),
        h('span', { className: HINT }, empty))
      : h('div', { className: PANEL },
        h('div', { className: PANEL_HEAD },
          h('span', null, title),
          h('span', { className: HINT }, hint ?? ''),
          more),
        h('div', { className: PANEL_BODY },
          h('div', { className: 'flex min-w-0 flex-col' }, rows)),
      )
  }

  return h('div', { className: PAGE, 'data-insights-page': '' },
    regressionLine,
    /* 以前 8 个指标平铺在一起（20px 与 18px 差 2px，眼睛读不出层级）。
       现在分两级：上面五个是「今天要动手」的，下面五个是「知道就行」的背景数字。 */
    h('div', { className: 'flex min-w-0 flex-col gap-2', 'data-stat-section': 'action' },
      h('div', { className: 'text-caption-1-medium text-text-tertiary' }, '今天要处理'),
      h('div', { className: KPI_GRID },
        kpi('逾期', risks.overdue, '过了期望完成时间还没完成', risks.overdue > 0),
        kpi('阻塞', risks.blocked, '挂着阻塞标记等人决策', risks.blocked > 0),
        kpi('停摆', risks.stalled ?? 0, '派单中断过、不会再自动派单，要人点「重新派单」', (risks.stalled ?? 0) > 0),
        kpi('缺陷超时', risks.slaOverdue, '按 P0-P3 时限算', risks.slaOverdue > 0),
        kpi('准出被拦', risks.gateFailed, '待测试/待验收里过不了准出', risks.gateFailed > 0),
      ),
    ),
    h('div', { className: 'flex min-w-0 flex-col gap-2', 'data-stat-section': 'background' },
      h('div', { className: 'text-caption-1-medium text-text-tertiary' }, '整体情况'),
      h('div', { className: KPI_GRID },
        kpi('在办卡', data.scope.open, `共 ${data.scope.tasks} 张`),
        kpi('流水线失败', risks.pipelineFailed, '最近一次 CI 没通过', risks.pipelineFailed > 0),
        kpi('集成异常', risks.integrationsBroken, '飞书/GitLab/云盘/隔离', risks.integrationsBroken > 0),
        // 强制放行是逃生舱：30 天内用超了就摆在这里，别让它变成默认操作。
        kpi('强制放行', risks.overrideOver ?? 0, `近 30 天 · 上限 ${risks.overrideMax ?? 3} 次`, (risks.overrideOver ?? 0) > 0),
        kpi('AI 在跑', ai.running, `今天派单 ${ai.todayRuns} 次`),
      ),
    ),
    h('div', { className: PANEL, 'data-flow-panel': '' },
      h('div', { className: PANEL_HEAD },
        h('span', null, '流程与产出'),
        h('span', { className: HINT }, '需要人动手的地方')),
      h('div', { className: `${PANEL_BODY} grid grid-cols-2 gap-3 lg:grid-cols-4` },
        flowCell('待评审', flow.review),
        flowCell('待测试', flow.test),
        flowCell('待验收', flow.accept),
        flowCell('今天完成', flow.doneToday),
        flowCell('近 7 天完成', flow.doneWeek),
        flowCell('需求卡住', risks.requirementBlocked),
        flowCell('版本卡住', risks.releaseBlocked),
        h('div', { className: 'flex min-w-0 flex-col justify-end' },
          h(Button, { variant: 'ghost', size: 'sm', onClick: () => onOpenBoard() }, '去看板')),
      ),
    ),
    block('逾期', (data.list?.overdue ?? []).map(taskRow), '没有逾期的卡。', undefined, data.listTotal?.overdue),
    block('阻塞', (data.list?.blocked ?? []).map(taskRow), '没有卡在等人决策。', undefined, data.listTotal?.blocked),
    block('停摆', (data.list?.stalled ?? []).map(taskRow), '没有停摆的卡。', undefined, data.listTotal?.stalled),
    block('缺陷超时', (data.list?.slaOverdue ?? []).map(taskRow), '缺陷都在时限内。', undefined, data.listTotal?.slaOverdue),
    block('准出被拦', (data.list?.gateFailed ?? []).map(taskRow), '没有卡被准出规则拦住。', '清单没勾完 / 用例不通过 / 已签过字但被打回', data.listTotal?.gateFailed),
    block('流水线失败', (data.list?.pipelineFailed ?? []).map(taskRow), '没有 CI 失败的卡。', undefined, data.listTotal?.pipelineFailed),
    block('需求与版本卡住', [
      ...(data.list?.requirementBlocked ?? []).map(item => h('div', { key: item.id, className: 'flex min-w-0 items-start justify-between gap-4 border-b border-separator-border py-3 last:border-b-0' },
        h('div', { className: 'flex min-w-0 flex-1 flex-col gap-1' },
          h('div', { className: 'text-body-2-medium text-text-primary' }, `${item.code || item.id} · ${item.title}`),
          h('div', { className: HINT }, `需求：${(item.blockers ?? []).join('；')}`),
        ),
      )),
      ...(data.list?.releaseBlocked ?? []).map(item => h('div', { key: item.id, className: 'flex min-w-0 items-start justify-between gap-4 border-b border-separator-border py-3 last:border-b-0' },
        h('div', { className: 'flex min-w-0 flex-1 flex-col gap-1' },
          h('div', { className: 'text-body-2-medium text-text-primary' }, `${item.version || item.id} · ${item.name || ''}`),
          h('div', { className: HINT }, `版本：${(item.blockers ?? []).join('；')}`),
        ),
      )),
    ], '需求与版本都还顺。', undefined, Number(data.listTotal?.requirementBlocked ?? 0) + Number(data.listTotal?.releaseBlocked ?? 0)),
    h('div', { className: HINT }, `统计时间 ${fmtTime(data.at)}，数字随看板变化实时算，不落库。`),
  )
}
