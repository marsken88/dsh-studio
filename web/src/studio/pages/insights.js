/* Page-level components lifted out of client.src.js; shared handles come from the studio context. */

import { fmtTime, fmtDate } from '../format.js'
import { client } from '../context.js'

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
    return h('div', { className: 'ds-body' },
      h('div', { className: 'ds-hint' }, note === null ? '正在算今天该看什么…' : `算不出来：${note}`))
  }
  // 最近一次回归：昨晚的定时回归就跑在这里；有失败时整条标红。
  const regressionLine = regression === null ? null : (() => {
    const failed = (Number(regression.failed) || 0) + (Number(regression.failedCards) || 0) > 0
    return h('div', { className: 'ds-reg-banner', 'data-bad': failed ? '1' : '0' },
      h('span', null, `最近回归 · ${fmtTime(regression.at)} · ${regression.by || '人'}`),
      h('span', { className: 'ds-hint' },
        `${regression.cards} 张卡 / ${regression.total} 条：通过 ${regression.passed}${failed ? `，不通过 ${regression.failed}` : ''}${regression.bugs > 0 ? ` · 自动开缺陷 ${regression.bugs} 张` : ''}`),
      onOpenCases === undefined ? null : h('button', { className: 'ds-btn ds-btn-ghost', onClick: () => onOpenCases() }, '看用例'),
    )
  })()
  const risks = data.risks ?? {}
  const flow = data.flow ?? {}
  const ai = data.ai ?? {}
  const kpi = (label, value, hint, warn) => h('div', { className: 'ds-kpi', 'data-warn': warn === true ? '1' : '0' },
    h('div', { className: 'ds-kpi-value' }, String(value ?? 0)),
    h('div', { className: 'ds-kpi-label' }, label),
    h('div', { className: 'ds-kpi-hint' }, hint),
  )
  const taskRow = (item) => h('div', { key: item.id, className: 'ds-listrow' },
    h('div', { className: 'ds-listrow-main' },
      h('div', null, `${item.code || item.id} · ${item.title}`),
      h('div', { className: 'ds-hint' }, `${item.statusLabel}${item.dueAt > 0 ? ` · 截止 ${fmtDate(item.dueAt)}` : ''}${item.sla?.state === 'overdue' ? ' · 缺陷超时' : ''}`),
    ),
    h('div', { className: 'ds-listrow-actions' },
      h('button', { className: 'ds-btn ds-btn-ghost', onClick: () => onOpenTask(item.id) }, '打开'),
    ),
  )
  const block = (title, rows, empty, hint) => h('div', { className: 'ds-panel' },
    h('div', { className: 'ds-panel-head' }, h('span', null, title), h('span', { className: 'ds-hint' }, hint ?? '')),
    h('div', { className: 'ds-panel-body' }, rows.length === 0 ? h('div', { className: 'ds-hint' }, empty) : rows),
  )

  return h('div', { className: 'ds-body' },
    regressionLine,
    h('div', { className: 'ds-kpi-grid' },
      kpi('在办卡', data.scope.open, `共 ${data.scope.tasks} 张`),
      kpi('逾期', risks.overdue, '过了期望完成时间还没完成', risks.overdue > 0),
      kpi('阻塞', risks.blocked, '挂着阻塞标记等人决策', risks.blocked > 0),
      kpi('缺陷超时', risks.slaOverdue, '按 P0-P3 时限算', risks.slaOverdue > 0),
      kpi('准出被拦', risks.gateFailed, '待测试/待验收里过不了准出', risks.gateFailed > 0),
      kpi('流水线失败', risks.pipelineFailed, '最近一次 CI 没通过', risks.pipelineFailed > 0),
      kpi('集成异常', risks.integrationsBroken, '飞书/GitLab/云盘/隔离', risks.integrationsBroken > 0),
      kpi('AI 在跑', ai.running, `今天派单 ${ai.todayRuns} 次`),
    ),
    h('div', { className: 'ds-panel' },
      h('div', { className: 'ds-panel-head' }, h('span', null, '流程与产出'), h('span', { className: 'ds-hint' }, '需要人动手的地方')),
      h('div', { className: 'ds-panel-body ds-grid4' },
        h('div', { className: 'ds-field' }, h('div', { className: 'ds-label' }, '待评审'), h('div', null, String(flow.review ?? 0))),
        h('div', { className: 'ds-field' }, h('div', { className: 'ds-label' }, '待测试'), h('div', null, String(flow.test ?? 0))),
        h('div', { className: 'ds-field' }, h('div', { className: 'ds-label' }, '待验收'), h('div', null, String(flow.accept ?? 0))),
        h('div', { className: 'ds-field' }, h('div', { className: 'ds-label' }, '今天完成'), h('div', null, String(flow.doneToday ?? 0))),
        h('div', { className: 'ds-field' }, h('div', { className: 'ds-label' }, '近 7 天完成'), h('div', null, String(flow.doneWeek ?? 0))),
        h('div', { className: 'ds-field' }, h('div', { className: 'ds-label' }, '需求卡住'), h('div', null, String(risks.requirementBlocked ?? 0))),
        h('div', { className: 'ds-field' }, h('div', { className: 'ds-label' }, '版本卡住'), h('div', null, String(risks.releaseBlocked ?? 0))),
        h('div', { className: 'ds-field' },
          h('div', { className: 'ds-label' }, ''),
          h('button', { className: 'ds-btn ds-btn-ghost', onClick: () => onOpenBoard() }, '去看板'),
        ),
      ),
    ),
    block('逾期', (data.list?.overdue ?? []).map(taskRow), '没有逾期的卡。'),
    block('阻塞', (data.list?.blocked ?? []).map(taskRow), '没有卡在等人决策。'),
    block('缺陷超时', (data.list?.slaOverdue ?? []).map(taskRow), '缺陷都在时限内。'),
    block('准出被拦', (data.list?.gateFailed ?? []).map(taskRow), '没有卡被准出规则拦住。', '清单没勾完 / 用例不通过 / 已签过字但被打回'),
    block('流水线失败', (data.list?.pipelineFailed ?? []).map(taskRow), '没有 CI 失败的卡。'),
    block('需求与版本卡住', [
      ...(data.list?.requirementBlocked ?? []).map(item => h('div', { key: item.id, className: 'ds-listrow' },
        h('div', { className: 'ds-listrow-main' },
          h('div', null, `${item.code || item.id} · ${item.title}`),
          h('div', { className: 'ds-hint' }, `需求：${(item.blockers ?? []).join('；')}`),
        ),
      )),
      ...(data.list?.releaseBlocked ?? []).map(item => h('div', { key: item.id, className: 'ds-listrow' },
        h('div', { className: 'ds-listrow-main' },
          h('div', null, `${item.version || item.id} · ${item.name || ''}`),
          h('div', { className: 'ds-hint' }, `版本：${(item.blockers ?? []).join('；')}`),
        ),
      )),
    ], '需求与版本都还顺。'),
    h('div', { className: 'ds-hint' }, `统计时间 ${fmtTime(data.at)}，数字随看板变化实时算，不落库。`),
  )
}
