/* Page-level components lifted out of client.src.js; shared handles come from the studio context. */

import { client } from '../context.js'
import { BurnChart, ProgressField } from '../charts.js'
import { fmtTime } from '../format.js'
import { StatCard, ChartCard, BarRow } from '../../boardui/chart-card'
import { TaskList, TaskRow } from '../../boardui/task-list'
import { Button, Select } from '../../boardui/index'
import { EmptyState } from '../../boardui/empty-state'
import { Meter } from '../../components/base/meter/meter'
import { PAGE, PANEL, PANEL_HEAD, PANEL_BODY, STICKY } from './layout.js'

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
/* 正文用 text-secondary：text-tertiary 在浅色只有 2.58:1、深色 1.94:1，正文读不清（UI 评审 P0-2）。 */
const HINT = 'text-caption-1-regular text-text-secondary'
/* px-4：面板标题与正文都在 16px 处，分区标题以前贴边，每个分区都错一格左轨。 */
const SECTION = 'mt-4 flex flex-wrap items-baseline gap-2 border-t border-separator-border px-4 pt-3 text-body-2-medium text-text-secondary'
const FOOT = 'mt-2 border-t border-neutral-200 pt-2 text-caption-1-regular text-text-secondary dark:border-neutral-600'
const KV = 'flex items-baseline justify-between gap-3 border-b border-neutral-200 py-1 text-body-2-regular last:border-b-0 dark:border-neutral-700'
const ROW = 'flex min-w-0 flex-wrap items-center gap-2'
const GRID = 'grid grid-cols-1 gap-3 xl:grid-cols-12'
/* 告警线只有这一份：结论条与 KPI 卡的标红以前各写一次（还写得不一致——自动化率只有结论条判、
   卡片从不标红）。目标区间也放这里，文案里的「目标 40–70%」与判定用同一组数。 */
const ALARM = {
  coverage: { below: 0.6, target: '≥60%', label: '用例可执行覆盖' },
  rework: { above: 0.3, target: '≤30%', label: '返工率' },
  gate: { below: 0.3, above: 0.9, target: '40–70%', label: '验收一次通过率' },
  automation: { below: 0.5, target: '≥50%', label: '自动化率' },
}
/* 判定用**未取整的值**；显示值恰好落在告警线上（如 89.7% 显示成 90%）时补一位小数，
   否则会出现「界面上写着 90%，却不在告警里」的自相矛盾。 */
function alarmText(value, rule) {
  if (value === null || value === undefined) return '—'
  const percent = value * 100
  const rounded = Math.round(percent)
  const onLine = (rule.above !== undefined && rounded === Math.round(rule.above * 100))
    || (rule.below !== undefined && rounded === Math.round(rule.below * 100))
  return onLine ? percent.toFixed(1) + '%' : rounded + '%'
}
function alarmHit(value, rule) {
  if (value === null || value === undefined) return false
  if (rule.above !== undefined && value > rule.above) return true
  if (rule.below !== undefined && value < rule.below) return true
  return false
}
const KPI_GRID = 'grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5'
/* 四张卡就别用五列：以前右侧空出一整格（面板宽 20%），看着像少渲染了一张。 */
const KPI_GRID_4 = 'grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4'

export function AnalyticsPage({ state, onOpenTask, onFixPrices }) {
  const { h, React, api, ChipField } = client()
  const [days, setDays] = React.useState(30)
  /* 效能页分区：总览 / 交付效率 / AI 与成本 / 上下文。只切显示，数据仍一次加载。 */
  const [pane, setPane] = React.useState('overview')
  /* 切分区时把内容区滚回顶部：长页面里页签会被滚出视野，换了分区不滚回看起来像没反应。 */
  const pageRef = React.useRef(null)
  const [project, setProject] = React.useState('')
  const [data, setData] = React.useState(null)
  const [error, setError] = React.useState(null)
  /* 次数据（负载/燃尽/成本/质量）以前 catch(()=>{})，接口一挂就显示成「还没有数据」。
     现在记下失败原因，在页面上和「真的没数据」分开说。 */
  const [secondaryError, setSecondaryError] = React.useState(null)
  const [secondaryLoading, setSecondaryLoading] = React.useState(true)
  const [load, setLoad] = React.useState(null)
  const [burn, setBurn] = React.useState(null)
  const [costs, setCosts] = React.useState(null)
  // 价目表行数：/costs 的 budget 里带着 config.costs.prices —— 就是设置页里维护的那张表。
  const priceCount = Array.isArray(costs?.budget?.prices) ? costs.budget.prices.length : 0
  const [quality, setQuality] = React.useState(null)
  // 上下文洞察：每个专家的窗口占用峰值 / 回合 / 工具调用 / 重试（读会话日志，不额外花 token）
  const [contexts, setContexts] = React.useState(null)
  /* 上下文接口失败要单独记：以前被 catch 成空 rows，界面显示「还没有专家会话记录」——
     把「读不到」说成「没有数据」，排查方向全错。 */
  const [contextsError, setContextsError] = React.useState(null)
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
    /* 上下文接口挂了不该被说成「还没有会话记录」：错误与空态分开显示。 */
    api('/contexts', { project, days })
      .then(out => { if (alive) { setContexts(out); setContextsError(null) } })
      .catch(cause => {
        if (!alive) return
        setContexts({ rows: [], totals: { experts: 0, sessions: 0, peak: 1 } })
        setContextsError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => { alive = false }
  }, [state.revision])

  React.useEffect(() => {
    let alive = true
    const withProject = path => project === '' ? path : `${path}${path.includes('?') ? '&' : '?'}project=${encodeURIComponent(project)}`
    api(`/analytics?days=${days}${project === '' ? '' : `&project=${encodeURIComponent(project)}`}`)
      .then(out => { if (alive) { setData(out.analytics); setError(null) } })
      .catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)) })
    setSecondaryLoading(true)
    /* 四个次数据各取各的：以前用 Promise.all，一个接口挂了（例如价目表没配、会话日志读不到）
       整块负载/燃尽/成本/质量全空。现在分开收，失败的那一块单独说明，其余照常显示。 */
    const failed = []
    const settle = (path, apply) => api(path)
      .then(out => { if (alive) apply(out) })
      .catch(cause => { failed.push(`${path.split('?')[0]}：${cause instanceof Error ? cause.message : String(cause)}`) })
    Promise.all([
      settle(withProject('/workload'), out => setLoad(out.workload ?? null)),
      settle(withProject('/burndown?days=14'), out => setBurn(out.burndown ?? null)),
      settle(withProject('/costs'), out => setCosts({ ...(out.costs ?? {}), budget: out.budget ?? null, usage: out.usage ?? null, scope: out.scope ?? null })),
      settle(withProject('/quality'), out => setQuality(out.quality ?? null)),
    ])
      .then(() => { if (alive) setSecondaryError(failed.length === 0 ? null : `${failed.length} 项没取到：${failed.join('；')}`) })
      .finally(() => { if (alive) setSecondaryLoading(false) })
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
  /* 柱子是后端按 min(days,14) 出的：标题与日均都得跟柱子的数量走，不能写死 14。 */
  const throughputDays = (data.throughput ?? []).length || Math.min(days, 14)
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
      : contextsError !== null ? h('div', { className: 'text-caption-1-regular text-text-error-primary', 'data-contexts-error': '' }, `读不到会话日志：${contextsError}（这不是「没有数据」，是接口或日志读不出来）`)
        : rows.length === 0 ? h('div', { className: HINT }, '还没有专家会话记录。')
          : h('div', null, kpis, rows.map(renderContextRow))
    return h('div', { className: `${PANEL}`, 'data-analytics-panel': 'context' }, head, h('div', { className: PANEL_BODY }, body))
  }

  /* 「返工最多的卡」是质量指标，不是成本：以前它落在「成本」页签里，团队找卡点时没人会去那儿翻。 */
  const renderReworkPanel = () => (
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
            action: h(Button, { variant: 'ghost', size: 'sm', onClick: () => onOpenTask(item.id) }, '打开'),
          })),
        ),
      )
  )
  return h('div', { className: PAGE, 'data-analytics-page': '', 'data-analytics-pane': pane, ref: pageRef },
    secondaryError === null ? null : h('div', { className: 'mb-2 text-caption-1-regular text-text-error-primary' }, `部分数据没加载出来：${secondaryError}（负载 / 燃尽 / 成本 / 质量可能是空的或旧的）`),
    /* 筛选行不吸顶：它和下面的页签行曾经都是 sticky top-0，两层同 z 叠在一起，
       滚动后页签条把两个 Select 完全盖住（点不到）。同一时刻只允许一条吸顶行。 */
    h('div', { className: ROW },
      h('span', { className: HINT }, `统计口径：最近 ${data.days} 天 · ${data.scope.tasks} 张卡（${data.scope.done} 张已完成）`),
      project === ''
        ? null
        : h('span', { className: HINT, 'data-analytics-scope': project }, '（全站生效）'),
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
    (() => {
      /* 产品定义要求「先结论、再分区」：这条结论讲的是**整个区间**（不随页签变），
       所以放在页签之上，并显式写明这一点，免得切到「上下文」还以为它在说上下文。 */
      /* 每条越线项都带一个去向：点一下切到对应分区并回到顶部。
         以前这里是纯文本 —— 它说「最该看 自动化率 13%」，却带不你去任何地方。 */
      const focus = []
      const coverage = data.cases?.rate ?? null
      if (alarmHit(coverage, ALARM.coverage)) focus.push({ text: `用例可执行覆盖 ${alarmText(coverage, ALARM.coverage)}（目标 ${ALARM.coverage.target}）`, pane: 'overview', go: '用例缺口' })
      if (alarmHit(data.rework?.rate, ALARM.rework)) focus.push({ text: `返工率 ${alarmText(data.rework.rate, ALARM.rework)}（目标 ${ALARM.rework.target}）`, pane: 'quality', go: 'AI 质量与返工' })
      if (alarmHit(gate.rate, ALARM.gate)) focus.push({ text: `${ALARM.gate.label} ${alarmText(gate.rate, ALARM.gate)}（目标 ${ALARM.gate.target}）`, pane: 'rhythm', go: '交付节奏' })
      if (alarmHit(au.rate, ALARM.automation)) focus.push({ text: `${ALARM.automation.label} ${alarmText(au.rate, ALARM.automation)}（目标 ${ALARM.automation.target}）`, pane: 'overview', go: '自动化率' })
      if (dispatchData.weeks.length > 0 && dispatchData.latest < dispatchData.target) focus.push({ text: `派单周活 ${dispatchData.latest} 张（目标 ≥${dispatchData.target}）`, pane: 'rhythm', go: '交付节奏' })
      return h('div', {
        'data-analytics-focus': focus.length > 0 ? 'warn' : 'ok',
        className: 'flex min-w-0 flex-wrap items-baseline gap-2 rounded-xl border px-3 py-2 text-body-2-regular '
          + (focus.length > 0 ? 'border-status-yellow-text/40 bg-status-yellow-background/40 text-text-primary' : 'border-separator-border bg-background-secondary-default text-text-secondary'),
      },
        h('b', { className: 'text-body-2-semibold' }, focus.length > 0 ? '现在最该看' : '关键指标'),
        h('span', { className: HINT, 'data-analytics-focus-scope': '' }, '（整个区间，不随页签变）'),
        focus.length === 0
          ? h('span', null, '没有触发告警线：验收通过率、返工、覆盖、自动化率、派单周活都在目标区间内。')
          : h('span', { className: 'flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1' }, focus.map((item, index) => h('button', {
            key: item.text,
            className: 'rounded-md px-1 text-left underline decoration-dotted underline-offset-2 hover:bg-status-yellow-background/60',
            'data-focus-goto': item.pane,
            'aria-label': `${item.text}，去「${item.go}」看`,
            onClick: () => { setPane(item.pane); if (pageRef.current !== null && pageRef.current !== undefined) pageRef.current.scrollTop = 0 },
          }, item.text, h('span', { className: HINT }, ` 去「${item.go}」`), index < focus.length - 1 ? h('span', null, '·') : null))))
    })(),
    (() => {
      const tabs = [
        { id: 'overview', label: '总览' },
        { id: 'rhythm', label: '交付节奏' },
        { id: 'quality', label: 'AI 质量' },
        { id: 'cost', label: '成本' },
        { id: 'context', label: '上下文' },
      ]
      return h('div', { className: STICKY + ' gap-1 border-b border-separator-border', role: 'group', 'aria-label': '效能分区' },
        tabs.map(tab => h(Button, {
          key: tab.id, 'aria-pressed': pane === tab.id ? 'true' : 'false', 'data-analytics-tab': tab.id,
          variant: pane === tab.id ? 'secondary' : 'ghost', size: 'sm',
          onClick: () => { setPane(tab.id); if (pageRef.current !== null && pageRef.current !== undefined) pageRef.current.scrollTop = 0 },
        }, tab.label)))
    })(),
    h('div', { className: SECTION, 'data-analytics-panel': 'overview' },
      '质量',
      h('span', { className: HINT }, '产品定义第 4 节那五条可断言的指标'),
    ),
    h('div', { className: KPI_GRID, 'data-analytics-panel': 'overview' },
      kpi(ALARM.gate.label, gate.rate === null ? '—' : alarmText(gate.rate, ALARM.gate), gate.cards === 0 ? '还没有走到验收的卡' : `${gate.firstPass}/${gate.cards} 张第一次进待验收就完成 · 目标 ${ALARM.gate.target}`, alarmHit(gate.rate, ALARM.gate)),
      kpi(ALARM.automation.label, au.rate === null ? '—' : alarmText(au.rate, ALARM.automation), au.rate === null ? '还没有已交付的需求' : `零人工介入 ${au.untouched}/${au.delivered} 条已交付需求 · 目标 ${ALARM.automation.target}`, alarmHit(au.rate, ALARM.automation)),
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
      /* 清单只回 10 条，总量单独给：以前用 rows.length 当总数，11 张卡缺断言时会写「10 张卡」。 */
      const cardTotal = Number(cases.byCardTotal ?? rows.length)
      if (rows.length === 0) return null
      return h('div', { className: `${PANEL}`, 'data-analytics-panel': 'overview' },
        h('div', { className: PANEL_HEAD },
          '用例缺口',
          h('span', { className: HINT, style: { marginLeft: 'auto' } }, '点一行跳到那张卡去补可执行断言')),
        h('div', { className: PANEL_BODY },
          h('div', { className: FOOT },
            `可执行覆盖 ${cases.rate === null || cases.rate === undefined ? '—' : pct(cases.rate)}（目标 ≥60%）· 共 ${cardTotal} 张卡的用例还没有可执行断言${cardTotal > rows.length ? `（按缺口排序列出前 ${rows.length} 张）` : ''}`),
          rows.map(row => h('button', {
            key: row.id,
            className: 'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-background-primary-hover',
            onClick: () => onOpenTask(row.id),
          },
            h('span', { className: 'font-mono text-caption-1-medium text-text-secondary' }, row.code || row.id),
            h('span', { className: 'min-w-0 flex-1 truncate text-body-2-medium text-text-primary' }, row.title),
              h('span', { className: 'shrink-0 text-end tabular-nums text-caption-1-regular text-text-secondary', style: { minWidth: 84 } }, `${row.missing}/${row.total} 待补`),
          )),
        ),
      )
    })(),
    /* 以前这里是四张和主 KPI 同权的大卡，标题还是一句免责（「不进门槛，供参考」）——
       免责当作分区标题，读者只能把括号读进去。现在换成紧凑行：一行一个读数，
       「不参与准出」写进标题本身。 */
    h('div', { className: SECTION, 'data-analytics-panel': 'overview' },
      '诊断读数（找原因用，不参与准出门禁）',
      h('span', { className: HINT }, '与门槛指标不同权：定位「为什么慢」，不做准出判断'),
    ),
    h('div', { className: PANEL + ' mt-3', 'data-analytics-panel': 'overview', 'data-diagnostics': '' },
      h('div', { className: PANEL_BODY },
        h('div', { className: KV }, h('span', {}, '完成卡一次通过率'), h('b', { className: 'tabular-nums' }, pct(data.rework.firstPassRate)), h('span', { className: HINT }, '完成的卡里从没被退回过的比例')),
        h('div', { className: KV }, h('span', {}, '返工率'), h('b', { className: 'tabular-nums' }, pct(data.rework.rate)), h('span', { className: HINT }, data.rework.reworked + '/' + data.rework.moved + ' 张卡倒退过')),
        h('div', { className: KV }, h('span', {}, '中位周期'), h('b', { className: 'tabular-nums' }, fmtSpan(data.cycle.medianDays)), h('span', { className: HINT }, '平均 ' + fmtSpan(data.cycle.avgDays) + ' · P90 ' + fmtSpan(data.cycle.p90Days))),
        h('div', { className: KV }, h('span', {}, 'AI 交付物采纳率'), h('b', { className: 'tabular-nums' }, pct(data.ai.acceptedRate)), h('span', { className: HINT }, data.ai.accepted + '/' + data.ai.artifactsAi + ' 件已被验收 · 占全部交付物 ' + pct(data.ai.aiShare))),
      ),
    ),
    h('div', { className: `${PANEL}`, 'data-analytics-panel': 'overview' },
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
    h('div', { className: `${PANEL}`, 'data-analytics-panel': 'overview' },
      h('div', { className: PANEL_HEAD },
        '交付节奏',
        h('span', { className: HINT }, 'AI 每周碰到几张卡 · 需求从创建到签字花多久 · 验收第一次就过多少')),
      h('div', { className: PANEL_BODY },
        h('div', { className: FOOT }, `派单周活：本周 ${dispatchData.latest} 张卡有 AI 评论 · 目标 ${dispatchData.target} · 近 8 周均值 ${dispatchData.average.toFixed(1)}${dispatchData.meetsTarget ? '（达标）' : ''}`),
        /* 以前是一串「10/05 0 · 10/12 0 · …」，8 个数字挤成一行看不清趋势；这里用页内已有的 BarRow。 */
        (() => {
          const weeks = dispatchData.weeks ?? []
          if (weeks.length === 0) return h('div', { className: HINT }, '还没有派单记录。')
          const peak = Math.max(1, ...weeks.map(item => Number(item.cards) || 0))
          const fmt = week => new Date(week).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
          return h('div', { className: 'flex min-w-0 flex-col gap-1', 'data-dispatch-weeks': '' },
            weeks.map(item => h(BarRow, {
              key: String(item.week),
              label: fmt(item.week),
              ratio: (Number(item.cards) || 0) / peak,
              display: String(item.cards ?? 0),
              title: `${fmt(item.week)} 那周：${item.cards ?? 0} 张卡有 AI 评论`,
            })))
        })(),
        gate.rate === null
          ? h('div', { className: HINT }, '验收一次通过率：还没有走到验收的卡。')
          : h('div', { className: FOOT }, `被打回过 ${gate.cards - gate.firstPass} 张（分母 ${gate.cards} 张到过待验收）${gate.bounced.length > 0 ? '：' + gate.bounced.map(item => item.code || item.id).join('、') : ''}`),
        delivery.medianDays === null
          ? h('div', { className: HINT }, '需求交付时长：还没有签过字的需求。')
          : h('div', { className: FOOT }, `需求交付时长：中位 ${fmtSpan(delivery.medianDays)}、平均 ${fmtSpan(delivery.avgDays)}（${delivery.count} 条已签字需求）`),
      )),
    ov.total === 0
      ? null
      : (() => {
        /* 这一块曾经是「一堵 39 行、48px 行距的灰字墙」（占全页约一半），而 39 行多是同一类原因反复出现。
           现在按 UX 评审给的形态收：摘要 → 按原因聚合 → 5 条样本（可点）→ 展开全部（限高内滚）。 */
        const groups = new Map()
        for (const item of ov.list) {
          const key = item.reason === '' ? '（没写原因）' : String(item.reason)
          groups.set(key, (groups.get(key) ?? 0) + 1)
        }
        const topGroups = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        const samples = ov.list.slice(0, 5)
        const rest = ov.list.slice(5)
        const rowOf = (item, index) => h('div', {
          key: `${item.kind}:${item.id}:${index}`,
          className: FOOT + (item.kind === 'card' && typeof onOpenTask === 'function' ? ' cursor-pointer hover:text-text-primary' : ''),
          title: item.reason === '' ? '这次没写原因' : item.reason,
          ...(item.kind === 'card' && typeof onOpenTask === 'function'
            ? { role: 'button', tabIndex: 0, 'data-override-open': item.id, onClick: () => onOpenTask(item.id), onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenTask(item.id) } } }
            : {}),
        }, `${item.kind === 'card' ? '卡' : '需求'} ${item.code || item.id} ${item.title} · ${item.by || '（没记签名人）'} · ${fmtTime(item.at)} — ${item.reason === '' ? '（没写原因）' : item.reason}`)
        return h('div', { className: `${PANEL}`, 'data-analytics-panel': 'overview', 'data-override-panel': '' },
          h('div', { className: PANEL_HEAD },
            `${ov.overLimit ? '超限 · ' : ''}强制放行 ${ov.total} 次`,
            h('span', { className: HINT }, `卡 ${ov.cards} · 需求 ${ov.requirements}${ov.noReason > 0 ? ` · ${ov.noReason} 次没写原因` : ''}（区间内）`)),
          ov.overLimit
            ? h('div', { className: 'px-4 pt-2 text-caption-1-regular text-text-error-primary' }, `本区间已用 ${ov.total} 次，上限是每区间 ${ov.max} 次：这个口子用得太勤了，先看看下面每一次是不是真的必要`)
            : null,
          h('div', { className: PANEL_BODY },
            h('div', { className: FOOT + ' !mt-0' }, `AI 推 ${ov.byAgent ?? 0} 次 · 人推 ${ov.byHuman ?? 0} 次${(ov.byUnknown ?? 0) > 0 ? ` · 没记签名人 ${ov.byUnknown} 次` : ''}${(ov.byPerson ?? []).length > 0 ? ' · 谁放的：' + ov.byPerson.map(item => `${item.by} ${item.count} 次`).join('、') : ''}`),
            topGroups.length === 0
              ? null
              : h('div', { className: 'flex min-w-0 flex-wrap items-center gap-2', 'data-override-groups': '' },
                h('span', { className: HINT }, '按原因：'),
                topGroups.map(([reason, count]) => h(ChipField, { key: reason, variant: 'gray', title: reason }, `${reason.length > 28 ? reason.slice(0, 27) + '…' : reason} × ${count}`))),
            samples.length === 0 ? null : h('div', { className: 'flex min-w-0 flex-col', 'data-override-samples': '' }, samples.map(rowOf)),
            rest.length === 0
              ? null
              : h('details', { className: 'rounded-lg border border-separator-border px-3 py-2', 'data-override-rest': '' },
                h('summary', { className: 'cursor-pointer text-caption-1-regular text-text-secondary' }, `展开其余 ${rest.length} 条`),
                h('div', { className: 'mt-2 flex max-h-72 min-w-0 flex-col overflow-auto pr-1' }, rest.map((item, index) => rowOf(item, index + 5)))),
            ov.truncated === true || ov.list.length >= 50
              ? h('div', { className: HINT, 'data-override-truncated': '' }, `只显示前 ${ov.list.length} 条（后端最多给 50 条）；更早的记录请到卡上的历史里看`)
              : null,
          ),
        )
      })(),
    h('div', { className: SECTION, 'data-analytics-panel': 'rhythm' },
      '流程与产能',
      h('span', { className: HINT }, '完成的卡各花了多久 · 时间都卡在哪一列 · 最近每天完成几张'),
    ),
    h('div', { className: GRID, 'data-analytics-panel': 'rhythm' },
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
          h('div', { className: PANEL_HEAD }, `近 ${throughputDays} 天完成`, throughputDays < 14 ? h('span', { className: HINT }, `区间选择器当前是 ${days} 天；超过 14 天也只画 14 根柱`) : null),
          h('div', { className: PANEL_BODY },
            h('div', { className: 'flex h-20 items-end gap-1 border-b border-separator-border pt-2' },
              (data.throughput ?? []).map((point, index) => h('div', { key: point.day, className: 'flex h-full flex-1 flex-col items-center justify-end gap-1', title: `${point.day}：完成 ${point.count} 张` },
                h('div', { className: 'w-[70%] min-h-0.5 rounded-t bg-accent-500/70', style: { height: `${Math.round((point.count / Math.max(1, Math.max(...data.throughput.map(item => item.count)))) * 100)}%` } }),
                h('span', { className: 'h-3 whitespace-nowrap text-caption-1-regular text-text-tertiary' }, index % 2 === 0 ? point.day : ''),
              )),
            ),
            h('div', { className: FOOT }, `近 ${throughputDays} 天合计 ${done14} 张 · 日均 ${(done14 / Math.max(1, throughputDays)).toFixed(1)} 张 · 空着的日子是没卡完成，不是没数据`),
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
    h('div', { className: SECTION, 'data-analytics-panel': 'quality' },
      'AI 质量与返工',
      h('span', { className: HINT }, 'AI 交的东西被验收多少 · 哪些卡来回折腾 · 派单失败与缺陷重开'),
    ),
    h('div', { className: GRID, 'data-analytics-panel': 'quality' },
      h('div', { className: `${PANEL} xl:col-span-4` },
        h('div', { className: PANEL_HEAD }, '按专家看质量', h('span', { className: HINT }, '派单量来自运行日志（内存最近 300 条）')),
        h('div', { className: PANEL_BODY },
          quality === null
            ? h('div', { className: HINT }, secondaryLoading ? '正在算…' : '还没算出来')
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
      renderReworkPanel(),
    ),
    /* 团队负载与燃尽讲的是「节奏」，不是 AI 质量：跟周期分布、每列停留放一起。 */
    h('div', { className: GRID, 'data-analytics-panel': 'rhythm', 'data-rhythm-load': '' },
      h('div', { className: `${PANEL} xl:col-span-4` },
        h('div', { className: PANEL_HEAD }, '团队负载', h('span', { className: HINT, style: { marginLeft: 'auto' } }, `${load?.busy ?? 0} 位在跑`)),
        h('div', { className: PANEL_BODY },
          load === null
            ? h('div', { className: HINT }, secondaryLoading ? '正在加载团队负载…' : '负载数据没加载出来。')
            : (load.experts ?? []).filter(item => item.enabled).length === 0
            ? h(EmptyState, { title: '还没有启用的专家。' })
            : (load?.experts ?? []).filter(item => item.enabled).map(item => h('div', { key: item.id, className: 'grid grid-cols-[106px_minmax(0,1fr)_84px] items-center gap-2 py-1 text-body-2-regular' },
              h('span', { className: 'text-text-secondary' }, `${item.name}`),
              /* 负载是「容量占用」，用官方 Meter（role=meter）；完成率才用 ProgressBar。 */
              h(Meter, {
                value: Number(item.open) || 0,
                maxValue: Math.max(1, ...(load.experts ?? []).map(entry => Number(entry.open) || 0)),
                'aria-label': `${item.name} 在办 ${item.open} 张`,
                showValueLabel: false,
                size: 'sm',
                tone: Number(item.overdue) > 0 ? 'error' : 'accent',
                className: 'min-w-0',
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
    ),
    h('div', { className: SECTION, 'data-analytics-panel': 'cost' },
      '成本',
      h('span', { className: HINT }, '派单花了多少 · 钱是怎么算出来的 · 哪些模型还没配价目'),
    ),
    h('div', { className: GRID, 'data-analytics-panel': 'cost' },
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
              h(Meter, {
                value: Math.min(100, Math.max(costs.budget.runRate, costs.budget.hourRate)),
                maxValue: 100,
                'aria-label': '预算使用',
                showValueLabel: false,
                size: 'md',
                tone: costs.budget.level === 'over' ? 'error' : costs.budget.level === 'warn' ? 'warning' : 'accent',
              }),
              h('div', { className: HINT },
                `${costs.budget.runs}/${costs.budget.budgetRuns} 次 · ${costs.budget.hours}/${costs.budget.budgetHours} 小时 · ${costs.budget.hint}`),
            ),
        ),
      ),
    ),
    renderContextPanel(),
  )
}
