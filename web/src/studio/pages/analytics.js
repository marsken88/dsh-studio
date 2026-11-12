/* Page-level components lifted out of client.src.js; shared handles come from the studio context. */

import { client } from '../context.js'
import { BurnChart, ProgressField } from '../charts.js'

export function AnalyticsPage({ state, onOpenTask }) {
  const { h, React, api, SelectField } = client()
  const [days, setDays] = React.useState(30)
  const [project, setProject] = React.useState('')
  const [data, setData] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [load, setLoad] = React.useState(null)
  const [burn, setBurn] = React.useState(null)
  const [costs, setCosts] = React.useState(null)

  React.useEffect(() => {
    let alive = true
    const query = `/analytics?days=${days}${project === '' ? '' : `&project=${encodeURIComponent(project)}`}`
    api(query)
      .then(out => { if (alive) { setData(out.analytics); setError(null) } })
      .catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)) })
    const suffix = project === '' ? '' : `&project=${encodeURIComponent(project)}`
    Promise.all([api('/workload'), api(`/burndown?days=14${suffix}`), api('/costs')])
      .then(([loadOut, burnOut, costOut]) => {
        if (!alive) return
        setLoad(loadOut.workload ?? null)
        setBurn(burnOut.burndown ?? null)
        setCosts({ ...(costOut.costs ?? {}), budget: costOut.budget ?? null })
      })
      .catch(() => {})
    return () => { alive = false }
  }, [days, project, state.revision])

  if (error !== null) return h('div', { className: 'ds-body' }, h('div', { className: 'ds-err' }, error))
  if (data === null) return h('div', { className: 'ds-loading' }, '正在统计…')

  const pct = value => `${Math.round((value ?? 0) * 100)}%`
  const fmtSpan = value => {
    const days = Number(value) || 0
    if (days <= 0) return '0'
    if (days * 1440 < 60) return `${Math.max(1, Math.round(days * 1440))} 分钟`
    if (days < 1) return `${(days * 24).toFixed(1)} 小时`
    return `${days.toFixed(1)} 天`
  }
  const kpi = (label, value, hint, warn) => h('div', { className: 'ds-kpi', 'data-warn': warn === true ? '1' : '0' },
    h('div', { className: 'ds-kpi-value' }, value),
    h('div', { className: 'ds-kpi-label' }, label),
    h('div', { className: 'ds-kpi-hint' }, hint),
  )

  const cycleTotal = (data.cycle.buckets ?? []).reduce((sum, bucket) => sum + bucket.count, 0)
  const peak = Math.max(1, ...(data.throughput ?? []).map(point => point.count), ...(data.cycle.buckets ?? []).map(bucket => bucket.count))
  const maxDwell = Math.max(0.001, ...(data.columns ?? []).map(column => column.avgDays))
  // 面板底部的小注：把每块面板补满（等高栅格里不会被撑出一片空白），顺带给一句「所以呢」
  const slowestColumn = (data.columns ?? []).reduce((best, column) => (best === null || column.avgDays > best.avgDays ? column : best), null)
  const done14 = (data.throughput ?? []).reduce((sum, point) => sum + point.count, 0)
  const enabledExperts = (load?.experts ?? []).filter(item => item.enabled)
  const loadOpen = enabledExperts.reduce((sum, item) => sum + item.open, 0)
  const loadOverdue = enabledExperts.reduce((sum, item) => sum + (item.overdue ?? 0), 0)
  const burnSeries = burn?.series ?? []
  const burnTail = burnSeries.length === 0 ? null : burnSeries[burnSeries.length - 1]

  return h('div', { className: 'ds-body' },
    h('div', { className: 'ds-board-bar' },
      h('span', { className: 'ds-hint' }, `统计口径：最近 ${data.days} 天 · ${data.scope.tasks} 张卡（${data.scope.done} 张已完成）`),
      h(SelectField, {
        className: 'ds-select', value: project, style: { width: 'auto', minWidth: 130 },
        onChange: event => setProject(event.target.value),
      },
      h('option', { value: '' }, '全部项目'),
      (state.config.projects ?? []).map(item => h('option', { key: item.id, value: item.id }, `${item.key ? `[${item.key}] ` : ''}${item.name}`))),
      h(SelectField, {
        className: 'ds-select', value: String(days), style: { width: 'auto', minWidth: 96 },
        onChange: event => setDays(Number(event.target.value)),
      },
      h('option', { value: '7' }, '近 7 天'),
      h('option', { value: '30' }, '近 30 天'),
      h('option', { value: '90' }, '近 90 天')),
    ),
    h('div', { className: 'ds-an-sec' },
      '质量',
      h('span', { className: 'ds-hint' }, '先看这四个数：返工多不多、多久能做完、AI 交的东西有多少被人验收'),
    ),
    h('div', { className: 'ds-kpi-grid' },
      kpi('一次通过率', pct(data.rework.firstPassRate), '完成的卡里，从没被退回过的比例', data.rework.firstPassRate < 0.6),
      kpi('返工率', pct(data.rework.rate), `${data.rework.reworked}/${data.rework.moved} 张卡倒退过`, data.rework.rate > 0.3),
      kpi('中位周期', fmtSpan(data.cycle.medianDays), `平均 ${fmtSpan(data.cycle.avgDays)} · P90 ${fmtSpan(data.cycle.p90Days)}`),
      kpi('AI 交付物采纳率', pct(data.ai.acceptedRate), `${data.ai.accepted}/${data.ai.artifactsAi} 件已被验收 · 占全部交付物 ${pct(data.ai.aiShare)}`),
    ),
    h('div', { className: 'ds-an-sec' },
      '流程与产能',
      h('span', { className: 'ds-hint' }, '完成的卡各花了多久 · 时间都卡在哪一列 · 最近每天完成几张'),
    ),
    h('div', { className: 'ds-an-grid' },
      h('div', { className: 'ds-span-4', style: { display: 'grid', gap: 12, gridTemplateRows: 'auto 1fr', alignContent: 'stretch' } },
        h('div', { className: 'ds-panel' },
          h('div', { className: 'ds-panel-head' }, '周期分布', h('span', { className: 'ds-hint', style: { marginLeft: 'auto' } }, `${cycleTotal} 张已完成`)),
          h('div', { className: 'ds-panel-body' },
            (data.cycle.buckets ?? []).map(bucket => h('div', { key: bucket.id, className: 'ds-an-row' },
              h('span', { className: 'ds-an-name' }, bucket.label),
              h('div', { className: 'ds-an-track', 'data-empty': (bucket.count === 0 ? '1' : '0') }, h('div', { className: 'ds-an-fill', style: { width: `${Math.round((bucket.count / peak) * 100)}%` } })),
              h('span', { className: 'ds-an-num' }, `${bucket.count}`),
            )),
            cycleTotal === 0 ? h('div', { className: 'ds-hint' }, '这个区间里还没有完成的卡。') : null,
            h('div', { className: 'ds-an-foot' }, `平均 ${fmtSpan(data.cycle.avgDays)} · 中位 ${fmtSpan(data.cycle.medianDays)} · P90 ${fmtSpan(data.cycle.p90Days)}`),
          ),
        ),
        h('div', { className: 'ds-panel' },
          h('div', { className: 'ds-panel-head' }, '近 14 天完成'),
          h('div', { className: 'ds-panel-body' },
            h('div', { className: 'ds-spark' },
              (data.throughput ?? []).map((point, index) => h('div', { key: point.day, className: 'ds-spark-col', title: `${point.day}：完成 ${point.count} 张` },
                h('div', { className: 'ds-spark-bar', style: { height: `${Math.round((point.count / Math.max(1, Math.max(...data.throughput.map(item => item.count)))) * 100)}%` } }),
                h('span', { className: 'ds-spark-day' }, index % 2 === 0 ? point.day : ''),
              )),
            ),
            h('div', { className: 'ds-an-foot' }, `近 14 天合计 ${done14} 张 · 日均 ${(done14 / 14).toFixed(1)} 张 · 空着的日子是没卡完成，不是没数据`),
          ),
        ),
      ),
      h('div', { className: 'ds-panel ds-span-8' },
        h('div', { className: 'ds-panel-head' }, '每列停留（平均）'),
        h('div', { className: 'ds-panel-body' },
          (data.columns ?? []).map(column => h('div', { key: column.status, className: 'ds-an-row' },
            h('span', { className: 'ds-an-name' }, column.label),
            h('div', { className: 'ds-an-track', 'data-empty': (column.avgDays === 0 ? '1' : '0') }, h('div', { className: 'ds-an-fill ds-an-fill-warn', style: { width: `${Math.round((column.avgDays / maxDwell) * 100)}%` } })),
            h('span', { className: 'ds-an-num' }, fmtSpan(column.avgDays)),
          )),
          h('div', { className: 'ds-an-foot' },
            slowestColumn === null ? '还没有数据。' : `最慢的是「${slowestColumn.label}」：平均 ${fmtSpan(slowestColumn.avgDays)}，时间主要压在这一列。`),
        ),
      ),
    ),
    h('div', { className: 'ds-an-sec' },
      '交付、成本与返工',
      h('span', { className: 'ds-hint' }, 'AI 交的东西被验收多少 · 谁手上压得最多 · 派单花了多少 · 哪些卡来回折腾'),
    ),
    h('div', { className: 'ds-an-grid' },
      h('div', { className: 'ds-panel ds-span-4' },
        h('div', { className: 'ds-panel-head' }, 'AI 产出质量'),
        h('div', { className: 'ds-panel-body' },
          h('div', { className: 'ds-an-kv' }, h('span', {}, '交付物由专家登记'), h('b', {}, `${data.ai.artifactsAi} / ${data.ai.artifactsTotal}`)),
          h('div', { className: 'ds-an-kv' }, h('span', {}, '其中被人验收'), h('b', {}, `${data.ai.accepted}（${pct(data.ai.acceptedRate)}）`)),
          h('div', { className: 'ds-an-kv' }, h('span', {}, '缺正文（只有标题）'), h('b', { 'data-warn': data.ai.emptyBody > 0 ? '1' : '0' }, `${data.ai.emptyBody}`)),
          h('div', { className: 'ds-an-kv' }, h('span', {}, '写码卡有执行记录'), h('b', {}, `${data.ai.codingTasks}`)),
          h('div', { className: 'ds-an-kv' }, h('span', {}, '评审通过 / 要求修改'), h('b', {}, `${data.ai.codingApproved} / ${data.ai.codingChanges}`)),
          h('div', { className: 'ds-an-kv' }, h('span', {}, '单测通过'), h('b', {}, `${data.ai.unitPassed}/${data.ai.unitTests}（${pct(data.ai.unitPassRate)}）`)),
          h('div', { className: 'ds-an-kv' }, h('span', {}, '已合并'), h('b', {}, `${data.ai.merged}`)),
        ),
      ),
      h('div', { className: 'ds-panel ds-span-4' },
        h('div', { className: 'ds-panel-head' }, '团队负载', h('span', { className: 'ds-hint', style: { marginLeft: 'auto' } }, `${load?.busy ?? 0} 位在跑`)),
        h('div', { className: 'ds-panel-body' },
          (load?.experts ?? []).filter(item => item.enabled).length === 0
            ? h('div', { className: 'ds-empty' }, '还没有启用的专家。')
            : (load?.experts ?? []).filter(item => item.enabled).map(item => h('div', { key: item.id, className: 'ds-an-row' },
              h('span', { className: 'ds-an-name' }, `${item.emoji} ${item.name}`),
              h('div', { className: 'ds-an-track' },
                h('div', {
                  className: 'ds-an-fill',
                  style: { width: `${Math.round((item.open / Math.max(1, ...(load.experts ?? []).map(entry => entry.open))) * 100)}%` },
                })),
              h('span', { className: 'ds-an-num' }, `在办 ${item.open}${item.running > 0 ? ` · 跑 ${item.running}` : ''}${item.overdue > 0 ? ` · 逾期 ${item.overdue}` : ''}`),
            )),
          h('div', { className: 'ds-an-foot' },
            `${enabledExperts.length} 位在岗，手上合计 ${loadOpen} 张${loadOverdue > 0 ? `，其中 ${loadOverdue} 张逾期` : '，没有逾期的'}`),
        ),
      ),
      h('div', { className: 'ds-panel ds-span-4' },
        h('div', { className: 'ds-panel-head' }, '燃尽（近 14 天剩余）', h('span', { className: 'ds-hint', style: { marginLeft: 'auto' } }, `现在还剩 ${burn?.now?.remaining ?? 0} 张`)),
        h('div', { className: 'ds-panel-body' },
          h(BurnChart, { series: burn?.series ?? [] }),
          h('div', { className: 'ds-an-foot' },
            burnTail === null
              ? '还没有数据。'
              : `累计建 ${burnTail.created} · 累计完成 ${burnTail.done} · 现在还剩 ${burnTail.remaining} 张`),
        ),
      ),
      h('div', { className: 'ds-panel ds-span-4' },
        h('div', { className: 'ds-panel-head' }, 'AI 执行成本', h('span', { className: 'ds-hint', style: { marginLeft: 'auto' } }, `${costs?.total ?? 0} 次派单`)),
        h('div', { className: 'ds-panel-body' },
          h('div', { className: 'ds-an-kv' }, h('span', {}, '平均执行时长'), h('b', {}, `${Math.round((costs?.avgMs ?? 0) / 1000)} 秒`)),
          (costs?.byModel ?? []).slice(0, 3).map(item => h('div', { key: `m-${item.key}`, className: 'ds-an-kv' }, h('span', {}, `模型 ${item.key}`), h('b', {}, `${item.runs} 次`))),
          (costs?.byPromptVersion ?? []).slice(0, 3).map(item => h('div', { key: `p-${item.key}`, className: 'ds-an-kv' }, h('span', {}, `提示词 ${item.key}`), h('b', {}, `${item.runs} 次`))),
          h('div', { className: 'ds-hint' }, costs?.note ?? ''),
          costs?.budget === null || costs?.budget === undefined
            ? null
            : h('div', { style: { marginTop: 8 } },
              h('div', { className: 'ds-an-kv' },
                h('span', {}, '预算使用'),
                h('b', { style: { color: costs.budget.level === 'over' ? '#e5484d' : costs.budget.level === 'warn' ? '#d97706' : undefined } },
                  `${Math.max(costs.budget.runRate, costs.budget.hourRate)}%`),
              ),
              h(ProgressField, {
                value: Math.min(100, Math.max(costs.budget.runRate, costs.budget.hourRate)),
                tone: costs.budget.level,
              }),
              h('div', { className: 'ds-hint' },
                `${costs.budget.runs}/${costs.budget.budgetRuns} 次 · ${costs.budget.hours}/${costs.budget.budgetHours} 小时 · ${costs.budget.hint}`),
            ),
        ),
      ),
      h('div', { className: 'ds-panel ds-span-8' },
      h('div', { className: 'ds-panel-head' },
        '返工最多的卡',
        h('span', { className: 'ds-hint', style: { marginLeft: 'auto' } }, `评审打回 ${data.rework.reviewRework} 次 · 测试打回 ${data.rework.testRework} 次`),
      ),
      h('div', { className: 'ds-panel-body' },
        (data.rework.worst ?? []).length === 0
          ? h('div', { className: 'ds-hint' }, '没有卡倒退过，挺好。')
          : data.rework.worst.map(item => h('div', { key: item.id, className: 'ds-listrow' },
            h('div', { className: 'ds-listrow-main' },
              h('div', null, `${item.code === '' ? '' : `${item.code} `}${item.title}`),
              h('div', { className: 'ds-hint' }, `倒退 ${item.backward} 次 · 现在在「${(state.statuses.find(entry => entry.id === item.status) ?? {}).label ?? item.status}」`),
            ),
            h('div', { className: 'ds-listrow-actions' },
              h('button', { className: 'ds-btn ds-btn-ghost', onClick: () => onOpenTask(item.id) }, '打开'),
            ),
          )),
        ),
      ),
    ),
  )
}
