/* Page-level components lifted out of client.src.js; shared handles come from the studio context. */

import { client } from '../context.js'
import { BurnChart, ProgressField } from '../charts.js'
import { fmtTime } from '../format.js'
import { StatCard, ChartCard, BarRow } from '../../boardui/chart-card'
import { TaskList, TaskRow } from '../../boardui/task-list'
import { Button, Select } from '../../boardui/index'
import { EmptyState } from '../../boardui/empty-state'

/* 分类色只用 BoardUI 的 chart token（浅/深主题各自一套），不再写死 hex。 */
const CTX_COLORS = ['var(--color-chart-1)', 'var(--color-chart-2)', 'var(--color-chart-3)', 'var(--color-chart-4)', 'var(--color-chart-5)']
const CTX_NUM = { width: 56, textAlign: 'right', fontSize: 12, flexShrink: 0 }
const CTX_ROW = 'flex min-w-0 cursor-pointer items-center gap-3 border-t border-separator-border py-2'
const CTX_DETAIL = 'flex min-w-0 flex-col gap-2 border-t border-dashed border-separator-border px-2 pb-3 pt-2'
const CTX_STACK = { display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', background: 'var(--color-separator-border)', margin: '4px 0 10px' }
const CTX_LEGEND = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px', fontSize: 12 }
const CTX_CHIP = 'flex min-w-[84px] flex-col gap-1 rounded-lg border border-separator-border bg-background-primary-default px-3 py-2'

/* 页面级样式：全部走 BoardUI token + Tailwind 工具类（4px 档位）。 */
/* [&>*]:shrink-0 —— 纵向 flex 默认会压缩子项：内容高于视口时每个分区被压扁，
   而分区自己 overflow-hidden，里面的内容就被裁掉（工作台出现「空条」的根因）。 */
const PAGE = 'flex min-w-0 flex-col gap-4 overflow-auto p-4 [&>*]:shrink-0'
const PANEL = 'flex min-w-0 flex-col overflow-hidden rounded-xl border border-separator-border bg-background-primary-default'
const PANEL_HEAD = 'flex flex-wrap items-center gap-2 border-b border-separator-border px-4 py-3 text-body-2-medium text-text-primary'
const PANEL_BODY = 'flex min-w-0 flex-col gap-3 p-4'
const HINT = 'text-caption-1-regular text-text-tertiary'
const SECTION = 'mt-4 flex flex-wrap items-baseline gap-2 text-caption-1-medium text-text-tertiary'
const FOOT = 'mt-2 border-t border-dashed border-separator-border pt-2 text-caption-1-regular text-text-tertiary'
const KV = 'flex items-baseline justify-between gap-3 border-b border-dashed border-separator-border py-1 text-body-2-regular last:border-b-0'
const ROW = 'flex min-w-0 flex-wrap items-center gap-2'
const GRID = 'grid grid-cols-1 gap-3 xl:grid-cols-12'
const KPI_GRID = 'grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5'

export function AnalyticsPage({ state, onOpenTask, onFixPrices }) {
  const { h, React, api } = client()
  const [days, setDays] = React.useState(30)
  const [project, setProject] = React.useState('')
  const [data, setData] = React.useState(null)
  const [error, setError] = React.useState(null)
  /* 次数据（负载/燃尽/成本/质量）以前 catch(()=>{})，接口一挂就显示成「还没有数据」。
     现在记下失败原因，在页面上和「真的没数据」分开说。 */
  const [secondaryError, setSecondaryError] = React.useState(null)
  const [load, setLoad] = React.useState(null)
  const [burn, setBurn] = React.useState(null)
  const [costs, setCosts] = React.useState(null)
  // 价目表行数：/costs 的 budget 里带着 config.costs.prices —— 就是设置页里维护的那张表。
  const priceCount = Array.isArray(costs?.budget?.prices) ? costs.budget.prices.length : 0
  const [quality, setQuality] = React.useState(null)
  // 上下文洞察：每个专家的窗口占用峰值 / 回合 / 工具调用 / 重试（读会话日志，不额外花 token）
  const [contexts, setContexts] = React.useState(null)
  const [ctxDetail, setCtxDetail] = React.useState(null)
  const [ctxOpen, setCtxOpen] = React.useState('')
  // 折线：每轮 input+cacheRead 的相对高度（0-56 的 viewBox）
  const trendPointsOf = (trend) => {
    const list = Array.isArray(trend) ? trend : []
    if (list.length === 0) return ''
    const max = Math.max(1, ...list)
    return list.map((value, index) => `${(index / Math.max(1, list.length - 1)) * 560},${56 - (value / max) * 50}`).join(' ')
  }
  const openContext = async (expert) => {
    if (ctxOpen === expert) { setCtxOpen(''); return }
    setCtxOpen(expert)
    setCtxDetail(null)
    try { setCtxDetail(await api('/contexts/session', { expert })) } catch (cause) { setCtxDetail({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }) }
  }

  React.useEffect(() => {
    let alive = true
    api('/contexts', {})
      .then(out => { if (alive) setContexts(out) })
      .catch(() => { if (alive) setContexts({ rows: [], totals: { experts: 0, sessions: 0, peak: 1 } }) })
    return () => { alive = false }
  }, [state.revision])

  React.useEffect(() => {
    let alive = true
    const query = `/analytics?days=${days}${project === '' ? '' : `&project=${encodeURIComponent(project)}`}`
    api(query)
      .then(out => { if (alive) { setData(out.analytics); setError(null) } })
      .catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)) })
    const suffix = project === '' ? '' : `&project=${encodeURIComponent(project)}`
    Promise.all([api('/workload'), api(`/burndown?days=14${suffix}`), api('/costs'), api('/quality')])
      .then(([loadOut, burnOut, costOut, qualityOut]) => {
        if (!alive) return
        setLoad(loadOut.workload ?? null)
        setBurn(burnOut.burndown ?? null)
        setCosts({ ...(costOut.costs ?? {}), budget: costOut.budget ?? null, usage: costOut.usage ?? null })
        setQuality(qualityOut.quality ?? null)
        setSecondaryError(null)
      })
      .catch(cause => { if (alive) setSecondaryError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { alive = false }
  }, [days, project, state.revision])

  if (error !== null) return h('div', { className: PAGE, 'data-analytics-page': '' }, h('div', { className: 'text-caption-1-regular text-text-error-primary' }, error))
  if (data === null) return h('div', { className: PAGE + ' text-body-2-regular text-text-tertiary', 'data-analytics-page': '' }, '正在统计…')

  const pct = value => `${Math.round((value ?? 0) * 100)}%`
  const fmtSpan = value => {
    const days = Number(value) || 0
    if (days <= 0) return '0'
    if (days * 1440 < 60) return `${Math.max(1, Math.round(days * 1440))} 分钟`
    if (days < 1) return `${(days * 24).toFixed(1)} 小时`
    return `${days.toFixed(1)} 天`
  }
  // KPI 方块换成我们自己写的 StatCard（BoardUI 的 stats 卡是 Pro，按公开行为自研）
  const kpi = (label, value, hint, warn) => h(StatCard, { label, value, hint, warn: warn === true })
  /* 强制放行：门禁说不行、有人（或某个 agent）硬推的每一次。
     这些不是 bug，是必须被看见的例外 —— 以前只写进 history 一句话，效能页完全看不到。 */
  const ov = data.overrides ?? { total: 0, cards: 0, requirements: 0, noReason: 0, byPerson: [], list: [] }
  /* 自动化率：已交付需求里「一次人工介入都没有」的占比。没人介入不代表质量好，但它是产品定义第 13 条。 */
  const au = data.automation ?? { rate: null, untouched: 0, delivered: 0, perRequirement: [] }
  const gate = data.gate ?? { cards: 0, firstPass: 0, rate: null, bounced: [] }
  const dispatchData = data.dispatch ?? { weeks: [], latest: 0, target: 15, meetsTarget: false, average: 0 }
  const delivery = data.delivery ?? { count: 0, medianDays: null, avgDays: null, rows: [] }

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
  const projectOptions = [
    { value: '', label: '全部项目' },
    ...(state.config.projects ?? []).map(item => ({ value: item.id, label: `${item.key ? `[${item.key}] ` : ''}${item.name}` })),
  ]
  const dayOptions = [
    { value: '7', label: '近 7 天' },
    { value: '30', label: '近 30 天' },
    { value: '90', label: '近 90 天' },
  ]

  // 上下文洞察面板：数据已经算好，这里只负责画（内联样式，避免再引一套 CSS）
  const renderContextDetail = () => {
    if (ctxDetail === null) return h('div', { className: `${HINT} ${CTX_DETAIL}` }, '正在算这次会话的上下文构成…')
    if (ctxDetail.ok !== true) return h('div', { className: `${HINT} ${CTX_DETAIL}` }, ctxDetail.error ?? '读不到')
    const data = ctxDetail.breakdown ?? {}
    const parts = Array.isArray(data.parts) ? data.parts : []
    const head = '最近一次会话 ' + fmtTime(Math.round(data.at)) + ' · 峰值 ' + Math.round(data.peak / 1000) + 'k / 窗口 ' + Math.round((data.window ?? 0) / 1000) + 'k（' + (data.percent ?? 0) + '%）· 全程约 ' + Math.round(data.approxTokens / 1000) + 'k token'
    const stack = h('div', { style: CTX_STACK }, parts.map((part, index) => h('span', { key: part.key, title: part.label + ' ' + part.percent + '%', style: { width: Math.max(part.percent, 0.5) + '%', background: CTX_COLORS[index % CTX_COLORS.length] } })))
    const legend = h('div', { style: CTX_LEGEND }, parts.map((part, index) => h('div', { key: part.key, style: { display: 'flex', alignItems: 'center', gap: 8 } },
      h('span', { style: { width: 8, height: 8, borderRadius: 2, flexShrink: 0, background: CTX_COLORS[index % CTX_COLORS.length] } }),
      h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, part.label),
      h('span', { style: { width: 34, textAlign: 'right' } }, part.percent + '%'),
      h('span', { className: HINT, style: { width: 58, textAlign: 'right' } }, Math.round(part.chars / 1000) + 'k 字'))))
    const trend = Array.isArray(data.trend) ? data.trend : []
    const drops = Array.isArray(data.drops) ? data.drops : []
    // 压缩点：曲线掉下去的那一轮画一条竖虚线 + 一个点，标出掉了多少
    const marks = drops.map((drop, index) => h('line', {
      key: 'drop-' + index,
      x1: (drop.index / Math.max(1, trend.length - 1)) * 560,
      y1: 0,
      x2: (drop.index / Math.max(1, trend.length - 1)) * 560,
      y2: 56,
      stroke: 'var(--color-status-yellow-text)',
      strokeWidth: 1,
      strokeDasharray: '3 3',
      vectorEffect: 'non-scaling-stroke',
    }))
    const trendSummary = trend.length === 0
      ? '上下文占用趋势：暂无数据'
      : `上下文占用趋势：最近 ${trend.length} 次会话，峰值占用 ${Math.round(Math.max(...trend) / 1000)}k token`
    const chart = h('svg', {
      style: { display: 'block', width: '100%', height: 52 },
      viewBox: '0 0 560 60',
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': trendSummary,
    },
      h('title', null, trendSummary),
      h('polygon', { points: '0,60 ' + trendPointsOf(trend) + ' 560,60', fill: CTX_COLORS[0], opacity: 0.12 }),
      h('polyline', { points: trendPointsOf(trend), fill: 'none', stroke: CTX_COLORS[0], strokeWidth: 1.6, vectorEffect: 'non-scaling-stroke' }),
      marks)
    const engine = ctxDetail.engine ?? null
    const engineLine = engine === null
      ? null
      : h('div', { className: HINT, style: { marginTop: 4 } }, '引擎计量（派单收尾取自宿主 tokenMeasurement）：total ' + Math.round(engine.total / 1000) + 'k · 输入 ' + Math.round(engine.input / 1000) + 'k · 缓存读 ' + Math.round(engine.cacheRead / 1000) + 'k · 输出 ' + Math.round(engine.output / 1000) + 'k')
    return h('div', { className: CTX_DETAIL }, h('div', { className: HINT, style: { marginBottom: 8 } }, head), stack, legend, engineLine,
      h('div', { className: HINT, style: { margin: '10px 0 2px' } }, '每轮上下文增长'), chart,
      h('div', { className: HINT }, trend.length + ' 个采样点 · ' + (drops.length === 0 ? '全程没有压缩' : '压缩 ' + drops.length + ' 次（虚线处掉了 ' + drops.map(drop => drop.drop + '%').join(' / ') + '）')))
  }
  const renderContextRow = (row) => {
    const share = Math.max(2, Math.round((row.peak / Math.max(1, contexts?.totals?.peak ?? 1)) * 100))
    const open = ctxOpen === row.expert
    const main = h('div', { onClick: () => void openContext(row.expert), className: CTX_ROW },
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { style: { fontWeight: 600, fontSize: 13 } }, row.expert),
        h('div', { className: HINT, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          (row.model === '' ? '模型未知' : row.model) + ' · ' + row.sessions + ' 个会话 · 最近 ' + fmtTime(Math.round(row.lastAt)))),
      h('div', { style: { width: 130, height: 6, background: 'var(--color-separator-border)', borderRadius: 3, overflow: 'hidden', flexShrink: 0 } },
        h('span', { style: { display: 'block', height: '100%', width: Math.max(2, row.percent) + '%', background: row.percent >= 80 ? 'var(--color-status-rose-text)' : 'var(--color-accent-500)' } })),
      h('div', { style: CTX_NUM }, Math.round(row.peak / 1000) + 'k'),
      h('div', { style: { ...CTX_NUM, width: 44, color: row.percent >= 80 ? 'var(--color-status-rose-text)' : 'inherit' } }, (row.window > 0 ? row.percent + '%' : '—')),
      h('div', { style: { ...CTX_NUM, color: row.retries > 100 ? 'var(--color-status-yellow-text)' : 'inherit' } }, '重试 ' + row.retries),
      h('div', { style: { ...CTX_NUM, color: row.alert === '' ? 'inherit' : 'var(--color-status-yellow-text)' } }, '工具 ' + row.toolShare + '%'),
      h('div', { style: { width: 12, textAlign: 'right', fontSize: 11, opacity: 0.6 } }, open ? '▲' : '▼'))
    return h('div', { key: row.expert }, main, open ? renderContextDetail() : null)
  }
  const renderContextPanel = () => {
    const totals = contexts?.totals ?? {}
    const rows = Array.isArray(contexts?.rows) ? contexts.rows : []
    const head = h('div', { className: PANEL_HEAD }, '上下文洞察（每个专家）',
      h('span', { className: HINT, style: { marginLeft: 'auto' } }, contexts === null ? '正在读会话日志…' : '点开一行看这次会话被什么占满'))
    const chip = (label, text, warn) => h('div', { className: CTX_CHIP },
      h('span', { className: HINT, style: { fontSize: 11 } }, label),
      h('span', { style: { fontSize: 15, fontWeight: 600, color: warn ? 'var(--color-status-rose-text)' : 'inherit' } }, text))
    const kpis = h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', paddingBottom: 10 } },
      chip('专家', String(totals.experts ?? 0)), chip('会话', String(totals.sessions ?? 0)),
      chip('最高窗口', Math.round((totals.peak ?? 0) / 1000) + 'k', false),
      chip('最高占用', (totals.percent ?? 0) + '%', (totals.percent ?? 0) >= 80),
      chip('工具喂胖', String(totals.alerts ?? 0), (totals.alerts ?? 0) > 0))
    const body = contexts === null ? h('div', { className: HINT }, '正在读会话日志…')
      : rows.length === 0 ? h('div', { className: HINT }, '还没有专家会话记录。')
        : h('div', null, kpis, rows.map(renderContextRow))
    return h('div', { className: `${PANEL} mt-3` }, head, h('div', { className: PANEL_BODY }, body))
  }

  return h('div', { className: PAGE, 'data-analytics-page': '' },
    secondaryError === null ? null : h('div', { className: 'mb-2 text-caption-1-regular text-text-error-primary' }, `部分数据没加载出来：${secondaryError}（负载 / 燃尽 / 成本 / 质量可能是空的或旧的）`),
    h('div', { className: ROW },
      h('span', { className: HINT }, `统计口径：最近 ${data.days} 天 · ${data.scope.tasks} 张卡（${data.scope.done} 张已完成）`),
      h(Select, {
        className: 'w-52', value: project, options: projectOptions,
        'aria-label': '按项目筛选',
        onChange: event => setProject(event.target.value),
      }),
      h(Select, {
        className: 'w-32', value: String(days), options: dayOptions,
        'aria-label': '统计区间',
        onChange: event => setDays(Number(event.target.value)),
      }),
    ),
    h('div', { className: SECTION },
      '质量',
      h('span', { className: HINT }, '产品定义第 4 节那五条可断言的指标：门禁一次通过率、自动化率、需求交付时长、用例覆盖强度、派单周活'),
    ),
    h('div', { className: KPI_GRID },
      kpi('门禁一次通过率', gate.rate === null ? '—' : pct(gate.rate), gate.cards === 0 ? '还没有走到验收的卡' : `${gate.firstPass}/${gate.cards} 张第一次进待验收就完成 · 目标 40–70%`, gate.rate !== null && (gate.rate < 0.3 || gate.rate > 0.9)),
      kpi('自动化率', au.rate === null ? '—' : pct(au.rate), au.rate === null ? '还没有已交付的需求' : `零人工介入 ${au.untouched}/${au.delivered} 条已交付需求`),
      kpi('需求交付时长', delivery.medianDays === null ? '—' : fmtSpan(delivery.medianDays), delivery.count === 0 ? '还没有签过字的需求' : `中位 ${delivery.count} 条需求 · 创建到签字`),
      (() => {
        const cases = data.cases ?? { total: 0, executable: 0, rate: null }
        const rate = cases.rate
        return kpi('用例可执行覆盖', rate === null ? '—' : pct(rate), cases.total === 0 ? '还没有用例' : `${cases.executable}/${cases.total} 条带可执行断言 · 目标 ≥60%`, rate !== null && rate < 0.6)
      })(),
      (() => {
        const weeks = data.dispatch?.weeks ?? []
        const thisWeek = weeks.length > 0 ? (weeks[weeks.length - 1].cards ?? 0) : 0
        const avg = weeks.length > 0 ? Math.round(weeks.reduce((sum, item) => sum + (item.cards ?? 0), 0) / weeks.length) : 0
        return kpi('派单周活', weeks.length === 0 ? '—' : String(thisWeek), weeks.length === 0 ? '还没有派单记录' : `本周有 AI 评论的卡 · 近 ${weeks.length} 周平均 ${avg}（目标 ≥15）`, weeks.length > 0 && thisWeek < 15)
      })(),
    ),
    (() => {
      const cases = data.cases ?? {}
      const rows = Array.isArray(cases.byCard) ? cases.byCard : []
      if (rows.length === 0) return null
      return h('div', { className: `${PANEL} mt-3` },
        h('div', { className: PANEL_HEAD },
          '用例缺口',
          h('span', { className: HINT, style: { marginLeft: 'auto' } }, '点一行跳到那张卡去补可执行断言')),
        h('div', { className: PANEL_BODY },
          h('div', { className: FOOT },
            `可执行覆盖 ${cases.rate === null || cases.rate === undefined ? '—' : pct(cases.rate)}（目标 ≥60%）· ${rows.length} 张卡的用例还没有可执行断言`),
          rows.map(row => h('button', {
            key: row.id,
            className: 'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-background-primary-hover',
            onClick: () => onOpenTask(row.id),
          },
            h('span', { className: 'font-mono text-caption-1-medium text-text-secondary' }, row.code || row.id),
            h('span', { className: 'min-w-0 flex-1 truncate text-body-2-medium text-text-primary' }, row.title),
            h('span', { className: HINT }, `${row.missing}/${row.total} 条待补`),
          )),
        ),
      )
    })(),
    h('div', { className: SECTION }, h('span', {}, '其它读数（不进门槛，供参考）')),
    h('div', { className: KPI_GRID },
      kpi('一次通过率', pct(data.rework.firstPassRate), '完成的卡里，从没被退回过的比例', data.rework.firstPassRate < 0.6),
      kpi('返工率', pct(data.rework.rate), `${data.rework.reworked}/${data.rework.moved} 张卡倒退过`, data.rework.rate > 0.3),
      kpi('中位周期', fmtSpan(data.cycle.medianDays), `平均 ${fmtSpan(data.cycle.avgDays)} · P90 ${fmtSpan(data.cycle.p90Days)}`),
      kpi('AI 交付物采纳率', pct(data.ai.acceptedRate), `${data.ai.accepted}/${data.ai.artifactsAi} 件已被验收 · 占全部交付物 ${pct(data.ai.aiShare)}`),
    ),
    h('div', { className: `${PANEL} mt-3` },
      h('div', { className: PANEL_HEAD },
        '自动化率',
        h('span', { className: HINT }, '已交付需求里，全程没有人工介入（评论/换列/签字）的占比')),
      h('div', { className: PANEL_BODY },
        au.rate === null
          ? h('div', { className: HINT }, '还没有已交付的需求，算不出来。')
          : [
            h('div', { className: FOOT }, `零人工介入 ${au.untouched}/${au.delivered} 条 · ${pct(au.rate)}（AI 用专家名发的评论不算人工介入）`),
            (au.unknown ?? 0) > 0
              ? h('div', { className: HINT }, `另有 ${au.unknown} 个介入点来源不明（旧记录只写了角色名，既算不了人也不算 AI）——这个百分比只对「能归因」的部分负责`)
              : null,
            ...(au.perRequirement ?? []).slice(0, 6).map(item => h('div', { key: item.id, className: FOOT, title: item.interventions === 0 ? '全程没人工介入' : '有人工介入点' },
              `${item.code || item.id} · 卡 ${item.tasks} 张 · 人工介入 ${item.interventions} 次${item.interventions === 0 ? '（零介入）' : ''}`)),
          ])),
    h('div', { className: `${PANEL} mt-3` },
      h('div', { className: PANEL_HEAD },
        '交付节奏',
        h('span', { className: HINT }, 'AI 每周碰到几张卡 · 需求从创建到签字花多久 · 验收第一次就过多少')),
      h('div', { className: PANEL_BODY },
        h('div', { className: FOOT }, `派单周活：本周 ${dispatchData.latest} 张卡有 AI 评论 · 目标 ${dispatchData.target} · 近 8 周均值 ${dispatchData.average.toFixed(1)}${dispatchData.meetsTarget ? '（达标）' : ''}`),
        h('div', { className: FOOT },
          '近 8 周：' + (dispatchData.weeks ?? []).map(item => `${new Date(item.week).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${item.cards}`).join(' · ')),
        gate.rate === null
          ? h('div', { className: HINT }, '门禁一次通过率：还没有走到验收的卡。')
          : h('div', { className: FOOT }, `门禁一次通过率 ${pct(gate.rate)}：${gate.cards} 张到过待验收，其中 ${gate.cards - gate.firstPass} 张被打回过${gate.bounced.length > 0 ? '（' + gate.bounced.map(item => item.code || item.id).join('、') + '）' : ''}`),
        delivery.medianDays === null
          ? h('div', { className: HINT }, '需求交付时长：还没有签过字的需求。')
          : h('div', { className: FOOT }, `需求交付时长：中位 ${fmtSpan(delivery.medianDays)}、平均 ${fmtSpan(delivery.avgDays)}（${delivery.count} 条已签字需求）`),
      )),
    ov.total === 0
      ? null
      : h('div', { className: `${PANEL} mt-3` },
        h('div', { className: PANEL_HEAD },
          `${ov.overLimit ? '超限 · ' : ''}强制放行 ${ov.total} 次`,
          h('span', { className: HINT }, `卡 ${ov.cards} · 需求 ${ov.requirements}${ov.noReason > 0 ? ` · ${ov.noReason} 次没写原因` : ''}（区间内）`)),
        ov.overLimit
          ? h('div', { className: 'text-caption-1-regular text-text-error-primary' }, `超过上限 ${ov.max} 次：这个口子用得太勤了，先看看下面每一次是不是真的必要`)
          : null,
        h('div', { className: FOOT }, `AI 推 ${ov.byAgent ?? 0} 次 · 人推 ${ov.byHuman ?? 0} 次${(ov.byUnknown ?? 0) > 0 ? ` · 没记签名人 ${ov.byUnknown} 次` : ''}`),
        h('div', { className: PANEL_BODY },
          ov.byPerson.length === 0
            ? null
            : h('div', { className: FOOT }, '谁放的：' + ov.byPerson.map(item => `${item.by} ${item.count} 次`).join(' · ')),
          ov.list.map(item => h('div', {
            key: `${item.kind}:${item.id}`,
            className: FOOT,
            title: item.reason === '' ? '这次没写原因' : item.reason,
          }, `${item.kind === 'card' ? '卡' : '需求'} ${item.code || item.id} ${item.title} · ${item.by || '（没记签名人）'} · ${fmtTime(item.at)} — ${item.reason === '' ? '（没写原因）' : item.reason}`)),
        )),
    h('div', { className: SECTION },
      '流程与产能',
      h('span', { className: HINT }, '完成的卡各花了多久 · 时间都卡在哪一列 · 最近每天完成几张'),
    ),
    h('div', { className: GRID },
      h('div', { className: 'xl:col-span-4', style: { display: 'grid', gap: 12, gridTemplateRows: 'auto 1fr', alignContent: 'stretch' } },
        h(ChartCard, {
          title: '周期分布',
          aside: `${cycleTotal} 张已完成`,
          hint: cycleTotal === 0 ? '这个区间里还没有完成的卡。' : '',
          footer: `平均 ${fmtSpan(data.cycle.avgDays)} · 中位 ${fmtSpan(data.cycle.medianDays)} · P90 ${fmtSpan(data.cycle.p90Days)}`,
        },
          (data.cycle.buckets ?? []).map(bucket => h(BarRow, {
            key: bucket.id,
            label: bucket.label,
            ratio: bucket.count / peak,
            display: `${bucket.count}`,
            title: `${bucket.label}：${bucket.count} 张`,
          })),
        ),
        h('div', { className: PANEL },
          h('div', { className: PANEL_HEAD }, '近 14 天完成'),
          h('div', { className: PANEL_BODY },
            h('div', { className: 'flex h-20 items-end gap-1 border-b border-separator-border pt-2' },
              (data.throughput ?? []).map((point, index) => h('div', { key: point.day, className: 'flex h-full flex-1 flex-col items-center justify-end gap-1', title: `${point.day}：完成 ${point.count} 张` },
                h('div', { className: 'w-[70%] min-h-0.5 rounded-t bg-accent-500/70', style: { height: `${Math.round((point.count / Math.max(1, Math.max(...data.throughput.map(item => item.count)))) * 100)}%` } }),
                h('span', { className: 'h-3 whitespace-nowrap text-caption-1-regular text-text-tertiary' }, index % 2 === 0 ? point.day : ''),
              )),
            ),
            h('div', { className: FOOT }, `近 14 天合计 ${done14} 张 · 日均 ${(done14 / 14).toFixed(1)} 张 · 空着的日子是没卡完成，不是没数据`),
          ),
        ),
      ),
      h('div', { className: 'xl:col-span-8' },
        h(ChartCard, {
          title: '每列停留（平均）',
          aside: slowestColumn === null ? '' : `最慢：${slowestColumn.label} ${fmtSpan(slowestColumn.avgDays)}`,
          footer: slowestColumn === null ? '还没有数据。' : `最慢的是「${slowestColumn.label}」：平均 ${fmtSpan(slowestColumn.avgDays)}，时间主要压在这一列。`,
        },
          (data.columns ?? []).map(column => h(BarRow, {
            key: column.status,
            label: column.label,
            ratio: column.avgDays / maxDwell,
            display: fmtSpan(column.avgDays),
            tone: 'warn',
            title: `${column.label}：平均停留 ${fmtSpan(column.avgDays)} · 当前 ${column.cards} 张`,
          })),
        ),
      ),
    ),
    h('div', { className: SECTION },
      '交付、成本与返工',
      h('span', { className: HINT }, 'AI 交的东西被验收多少 · 谁手上压得最多 · 派单花了多少 · 哪些卡来回折腾'),
    ),
    h('div', { className: GRID },
      h('div', { className: `${PANEL} xl:col-span-4` },
        h('div', { className: PANEL_HEAD }, '按专家看质量', h('span', { className: HINT }, '派单量来自运行日志（内存最近 300 条）')),
        h('div', { className: PANEL_BODY },
          quality === null
            ? h('div', { className: HINT }, '还没算出来')
            : (quality.experts ?? []).length === 0
              ? h('div', { className: HINT }, '还没有派出过活')
              : h('div', null,
                (quality.experts ?? []).slice(0, 8).map(item => h('div', { className: KV, key: item.expert },
                  h('span', {}, `${item.label} · ${item.dispatched} 次`),
                  h('b', { className: item.reworkRate !== null && item.reworkRate >= 40 ? 'text-text-error-primary' : undefined },
                    `${item.done}/${item.cards} 完成 · 一次过 ${item.firstPassRate === null ? '—' : item.firstPassRate + '%'}`),
                )),
                h('div', { className: HINT, style: { marginTop: 8 } },
                  `合计：派单 ${quality.totals.dispatched} 次 · 平均耗时 ${quality.totals.avgMs > 0 ? Math.round(quality.totals.avgMs / 1000) + ' 秒' : '—'} · 返工率 ${quality.totals.reworkRate === null ? '—' : quality.totals.reworkRate + '%'} · AI 失败 ${quality.totals.failures} 次 · 缺陷重开 ${quality.totals.reopens} 次`),
                h('div', { className: HINT }, quality.cost?.note ?? ''),
              ),
        ),
      ),
      h('div', { className: `${PANEL} xl:col-span-4` },
        h('div', { className: PANEL_HEAD }, 'AI 产出质量'),
        h('div', { className: PANEL_BODY },
          h('div', { className: KV }, h('span', {}, '交付物由专家登记'), h('b', {}, `${data.ai.artifactsAi} / ${data.ai.artifactsTotal}`)),
          h('div', { className: KV }, h('span', {}, '其中被人验收'), h('b', {}, `${data.ai.accepted}（${pct(data.ai.acceptedRate)}）`)),
          h('div', { className: KV }, h('span', {}, '缺正文（只有标题）'), h('b', { className: data.ai.emptyBody > 0 ? 'text-text-error-primary' : undefined }, `${data.ai.emptyBody}`)),
          h('div', { className: KV }, h('span', {}, '写码卡有执行记录'), h('b', {}, `${data.ai.codingTasks}`)),
          h('div', { className: KV }, h('span', {}, '评审通过 / 要求修改'), h('b', {}, `${data.ai.codingApproved} / ${data.ai.codingChanges}`)),
          h('div', { className: KV }, h('span', {}, '单测通过'), h('b', {}, `${data.ai.unitPassed}/${data.ai.unitTests}（${pct(data.ai.unitPassRate)}）`)),
          h('div', { className: KV }, h('span', {}, '已合并'), h('b', {}, `${data.ai.merged}`)),
        ),
      ),
      h('div', { className: `${PANEL} xl:col-span-4` },
        h('div', { className: PANEL_HEAD }, '团队负载', h('span', { className: HINT, style: { marginLeft: 'auto' } }, `${load?.busy ?? 0} 位在跑`)),
        h('div', { className: PANEL_BODY },
          (load?.experts ?? []).filter(item => item.enabled).length === 0
            ? h(EmptyState, { title: '还没有启用的专家。' })
            : (load?.experts ?? []).filter(item => item.enabled).map(item => h('div', { key: item.id, className: 'grid grid-cols-[106px_minmax(0,1fr)_84px] items-center gap-2 py-1 text-body-2-regular' },
              h('span', { className: 'text-text-secondary' }, `${item.name}`),
              // 这里原来是自己画的轨道/填充 —— 同一页里出现了两条进度条实现
              // （另一条走 kit('ProgressBar')）。统一交给 ProgressField，它渲染官方 Meter。
              h(ProgressField, {
                value: Math.round((item.open / Math.max(1, ...(load.experts ?? []).map(entry => entry.open))) * 100),
              }),
              h('span', { className: 'text-right tabular-nums text-text-secondary' }, `在办 ${item.open}${item.running > 0 ? ` · 跑 ${item.running}` : ''}${item.overdue > 0 ? ` · 逾期 ${item.overdue}` : ''}`),
            )),
          h('div', { className: FOOT },
            `${enabledExperts.length} 位在岗，手上合计 ${loadOpen} 张${loadOverdue > 0 ? `，其中 ${loadOverdue} 张逾期` : '，没有逾期的'}`),
        ),
      ),
      h('div', { className: `${PANEL} xl:col-span-4` },
        h('div', { className: PANEL_HEAD }, '燃尽（近 14 天剩余）', h('span', { className: HINT, style: { marginLeft: 'auto' } }, `现在还剩 ${burn?.now?.remaining ?? 0} 张`)),
        h('div', { className: PANEL_BODY },
          h(BurnChart, { series: burn?.series ?? [] }),
          h('div', { className: FOOT },
            burnTail === null
              ? '还没有数据。'
              : `累计建 ${burnTail.created} · 累计完成 ${burnTail.done} · 现在还剩 ${burnTail.remaining} 张`),
        ),
      ),
      h('div', { className: `${PANEL} xl:col-span-4` },
        h('div', { className: PANEL_HEAD }, 'AI 执行成本', h('span', { className: HINT, style: { marginLeft: 'auto' } }, `${costs?.total ?? 0} 次派单`)),
        h('div', { className: PANEL_BODY },
          costs?.usage?.totals === null || costs?.usage?.totals === undefined
            ? null
            : h('div', { className: KV }, h('span', {}, 'token 用量'),
              h('b', {}, (costs.usage.totals.total / 1000).toFixed(1) + 'k'),
              h('span', { className: HINT, style: { marginLeft: 8 } },
                '入 ' + (costs.usage.totals.input / 1000).toFixed(1) + 'k · 出 ' + (costs.usage.totals.output / 1000).toFixed(1) + 'k · 缓存 ' + (costs.usage.totals.cacheRead / 1000).toFixed(1) + 'k')),
          costs?.usage?.totals === null || costs?.usage?.totals === undefined
            ? null
            : h('div', { className: KV }, h('span', {}, '预估花费'),
              h('b', {}, costs.usage.totals.cost === null ? '未知（价目表没配）' : '¥' + Number(costs.usage.totals.cost).toFixed(2)),
              (costs.usage.totals.unknownCalls ?? 0) > 0
                ? h('span', { className: HINT, style: { marginLeft: 8 } }, costs.usage.totals.unknownCalls + ' 次无价目')
                : null),
          h('div', { className: KV }, h('span', {}, '平均执行时长'), h('b', {}, `${Math.round((costs?.avgMs ?? 0) / 1000)} 秒`)),
          (costs?.byModel ?? []).slice(0, 3).map(item => h('div', { key: `m-${item.key}`, className: KV }, h('span', {}, `模型 ${item.key}`), h('b', {}, `${item.runs} 次`))),
          (costs?.byPromptVersion ?? []).slice(0, 3).map(item => h('div', { key: `p-${item.key}`, className: KV }, h('span', {}, `提示词 ${item.key}`), h('b', {}, `${item.runs} 次`))),
          // 钱是怎么来的，得写在钱旁边：币种、单位、价目表在哪维护、配了几个模型。
          h('div', { className: HINT, 'data-price-source': String(priceCount) },
            `币种 ¥（元）· 单位：元 / 百万 token · 价目来源：设置 →「成本与预算」的价目表（已配 ${priceCount} 个模型）` +
            (priceCount === 0 ? '，现在只统计 token、不算钱' : '')),
          (costs?.usage?.unpricedModels ?? []).length === 0
            ? null
            : h('div', { className: HINT, 'data-unpriced': String(costs.usage.unpricedModels.length) },
              '未配价目的模型：' + costs.usage.unpricedModels.map(item => item.model + ' ×' + item.calls).join('、'),
              typeof onFixPrices === 'function'
                ? h(Button, {
                  variant: 'ghost', size: 'xs', className: 'ms-2',
                  title: '把缺价目的模型带进设置页的价目表，填好单价保存即可算钱',
                  onClick: () => onFixPrices(costs.usage.unpricedModels.map(item => item.model)),
                }, '补价目')
                : null),
          h('div', { className: HINT }, costs?.note ?? ''),
          costs?.budget === null || costs?.budget === undefined
            ? null
            : h('div', { style: { marginTop: 8 } },
              h('div', { className: KV },
                h('span', {}, '预算使用'),
                h('b', { style: { color: costs.budget.level === 'over' ? 'var(--color-text-error-primary)' : costs.budget.level === 'warn' ? 'var(--color-status-yellow-text)' : undefined } },
                  `${Math.max(costs.budget.runRate, costs.budget.hourRate)}%`),
              ),
              h(ProgressField, {
                value: Math.min(100, Math.max(costs.budget.runRate, costs.budget.hourRate)),
                tone: costs.budget.level,
              }),
              h('div', { className: HINT },
                `${costs.budget.runs}/${costs.budget.budgetRuns} 次 · ${costs.budget.hours}/${costs.budget.budgetHours} 小时 · ${costs.budget.hint}`),
            ),
        ),
      ),
      h('div', { className: 'xl:col-span-8' },
        h(TaskList, {
          title: '返工最多的卡',
          aside: `评审打回 ${data.rework.reviewRework} 次 · 测试打回 ${data.rework.testRework} 次`,
          empty: '没有卡倒退过，挺好。',
        },
          (data.rework.worst ?? []).map(item => h(TaskRow, {
            key: item.id,
            title: `${item.code === '' ? '' : `${item.code} `}${item.title}`,
            hint: `倒退 ${item.backward} 次 · 现在在「${(state.statuses.find(entry => entry.id === item.status) ?? {}).label ?? item.status}」`,
            action: h(Button, { variant: 'ghost', size: 'small', onClick: () => onOpenTask(item.id) }, '打开'),
          })),
        ),
      ),
    ),
    renderContextPanel(),
  )
}
