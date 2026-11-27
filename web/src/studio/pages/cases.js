/* Cross-card case library: one table over every case that lives on a card, so
   "what cases do we have and what did they do last time" is answerable without
   opening twenty drawers. Read-only for now; the regression runner is next.

   表现层是 BoardUI：表格用 components/base/table（真 <table>），动作按钮用
   boardui/index 的 Button，筛选用 SearchInput / Select，空态用 boardui/empty-state。 */

import { uiIcon } from '../icons.js'
import { client } from '../context.js'
import { Table, TableHeader, TableColumn, TableBody, TableRow, TableCell } from '../../components/base/table/table'
import { CASE_RESULTS, CASE_RESULT_LABEL } from '../labels.js'
import { Button, SearchInput, Select, Chip } from '../../boardui/index'
import { EmptyState } from '../../boardui/empty-state'
import { fmtTime } from '../format.js'
import { PAGE, PANEL, PANEL_HEAD, PANEL_BODY } from './layout.js'

/* [&>*]:shrink-0 —— 纵向 flex 默认会压缩子项：内容高于视口时每个分区被压扁，
   而分区自己 overflow-hidden，里面的内容就被裁掉（工作台出现「空条」的根因）。 */
const HINT = 'text-caption-1-regular text-text-tertiary'
const ROW = 'flex min-w-0 flex-wrap items-center gap-2'

export function CasesPage({ state, onOpenTask, onOpenBoard }) {
  const { h, React, api, toast, confirmDialog, promptDialog, currentUser } = client()
  const [rows, setRows] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [query, setQuery] = React.useState('')
  const [requirement, setRequirement] = React.useState('__all__')
  const [result, setResult] = React.useState('__all__')
  /* 可跑 / 无断言：41 条用例里有一批只有标题，跑不了也不计入覆盖率。
     以前它们混在列表里、类型列还显示成「手工」，看起来像是有人故意做的人工用例。 */
  const [kind, setKind] = React.useState('__all__')
  const [selected, setSelected] = React.useState(() => new Set())
  const [running, setRunning] = React.useState(false)
  const [suites, setSuites] = React.useState([])
  const [suiteCounts, setSuiteCounts] = React.useState({})
  const [suiteKeys, setSuiteKeys] = React.useState({})
  const [suiteFilter, setSuiteFilter] = React.useState(null)
  const [note, setNote] = React.useState('')
  const [regressions, setRegressions] = React.useState([])
  const [openDetail, setOpenDetail] = React.useState(null)
  /* 用例库不分页时一次渲染全部行，上千条会卡；排序也只在「最近执行」之外补两种。 */
  const [sortBy, setSortBy] = React.useState('recent')
  const [page, setPage] = React.useState(1)
  const PAGE_SIZE = 50

  const refresh = React.useCallback(async () => {
    try {
      const out = await api('/cases', {})
      setRows(Array.isArray(out.cases) ? out.cases : [])
      setRegressions(Array.isArray(out.regressions) ? out.regressions : [])
      setSuites(Array.isArray(out.suites) ? out.suites : [])
      setSuiteCounts(Object.fromEntries((out.counts ?? []).map(item => [item.id, item.count])))
      setSuiteKeys(Object.fromEntries((out.counts ?? []).map(item => [item.id, item.keys ?? []])))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setRows([])
    }
  }, [])

  // 卡片上的用例计数一变（跑了一条、加了一条、生成了一批）就重新拉一次。
  const fingerprint = (state.tasks ?? []).reduce((sum, task) => {
    const one = task.caseSummary ?? { total: 0, pass: 0, fail: 0 }
    return sum + one.total * 7 + one.pass * 13 + one.fail * 17
  }, 0)
  React.useEffect(() => { void refresh() }, [refresh, fingerprint])

  const list = React.useMemo(() => {
    const text = query.trim().toLowerCase()
    const only = suiteFilter === null ? null : new Set(suiteKeys[suiteFilter] ?? [])
    return (rows ?? []).filter(row => {
      if (only !== null && !only.has(row.key)) return false
      if (requirement !== '__all__' && row.requirementId !== requirement) return false
      if (result !== '__all__' && row.result !== result) return false
      if (kind === 'runnable' && row.runnable !== true) return false
      if (kind === 'bare' && row.runnable === true) return false
      if (text === '') return true
      return `${row.id} ${row.title} ${row.taskTitle} ${row.requirementTitle} ${row.pointId}`.toLowerCase().includes(text)
    })
  }, [rows, query, requirement, result, kind, suiteFilter, suiteKeys])

  const counts = React.useMemo(() => {
    const pass = list.filter(row => row.result === 'pass').length
    const fail = list.filter(row => row.result === 'fail').length
    const skip = list.filter(row => row.result === 'skip').length
    return { pass, fail, skip, rest: list.length - pass - fail - skip }
  }, [list])

  const sorted = React.useMemo(() => {
    const copy = [...list]
    if (sortBy === 'title') copy.sort((left, right) => String(left.title ?? '').localeCompare(String(right.title ?? ''), 'zh'))
    else if (sortBy === 'result') {
      const rank = { fail: 0, pending: 1, skip: 2, pass: 3 }
      copy.sort((left, right) => (rank[left.result] ?? 9) - (rank[right.result] ?? 9))
    } else copy.sort((left, right) => (Number(right.lastRunAt) || 0) - (Number(left.lastRunAt) || 0))
    return copy
  }, [list, sortBy])
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const currentPage = Math.min(Math.max(1, page), totalPages)
  const pageRows = sorted.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  React.useEffect(() => { setPage(1) }, [query, requirement, result, kind, suiteFilter, sortBy])

  const requirements = state.requirements ?? []
  const runnable = list.filter(row => row.runnable === true)
  const bareCount = list.filter(row => row.runnable !== true).length
  const picked = runnable.filter(row => selected.has(row.key))

  const toggle = key => setSelected(previous => {
    const next = new Set(previous)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  const selectAllRunnable = () => setSelected(new Set(runnable.map(row => row.key)))
  const clearSelection = () => setSelected(new Set())
  const runRows = async (rowsToRun) => {
    if (rowsToRun.length === 0) { setNote('先勾几条带接口定义的用例再跑（手工用例没有 http，跑不了）'); return }
    setRunning(true)
    setNote('')
    try {
      const out = await api('/cases/run', { keys: rowsToRun.map(row => row.key), by: '回归' })
      const results = out?.results ?? []
      const sum = key => results.reduce((n, item) => n + (Number(item[key]) || 0), 0)
      const broke = results.filter(item => item.ok === false)
      const parts = [`跑了 ${results.length} 张卡 / ${sum('total')} 条：通过 ${sum('passed')}，不通过 ${sum('failed')}`]
      if (sum('bugs') > 0) parts.push(`自动开缺陷 ${sum('bugs')} 张`)
      if (broke.length > 0) parts.push(`${broke.length} 张卡报错：${broke[0].error ?? ''}`)
      setNote(parts.join('，'))
      setSelected(new Set())
      await refresh()
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRunning(false)
    }
  }
  const noteFor = out => {
    const results = out?.results ?? []
    const sum = key => results.reduce((n, item) => n + (Number(item[key]) || 0), 0)
    const broke = results.filter(item => item.ok === false)
    const parts = [`跑了 ${results.length} 张卡 / ${sum('total')} 条：通过 ${sum('passed')}，不通过 ${sum('failed')}`]
    if (sum('bugs') > 0) parts.push(`自动开缺陷 ${sum('bugs')} 张`)
    if (broke.length > 0) parts.push(`${broke.length} 张卡报错：${broke[0].error ?? ''}`)
    if (out?.truncated !== undefined) parts.push(`套件共 ${out.truncated.total} 条，本次只跑了前 ${out.truncated.ran} 条`)
    return parts.join('，')
  }
  const runSuite = async suite => {
    setRunning(true)
    setNote('')
    try {
      const out = await api('/suite/run', { id: suite.id })
      setNote(noteFor(out))
      await refresh()
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRunning(false)
    }
  }
  const saveSuite = async () => {
    const name = await promptDialog('套件名字（按当前需求筛选；接口 / shell / 数据库 / 浏览器用例都会进，草稿除外）', { title: '新建回归套件', defaultValue: '默认回归' })
    if (name === null || String(name).trim() === '') return
    try {
      await api('/suite/save', {
        suite: {
          name: String(name).trim().slice(0, 40),
          /* httpOnly:false = 四种能跑的用例都进套件。以前写死 true，
             抽屉里建的 shell / 数据库 / 浏览器用例永远进不了回归（AGENTS §4 的同类坑）。 */
          rules: { requirementIds: requirement === '__all__' ? [] : [requirement], httpOnly: false },
          keys: [],
          isDefault: suites.length === 0,
        },
        by: currentUser(),
      })
      toast('已保存套件')
      await refresh()
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error')
    }
  }
  const makeDefault = async suite => {
    try {
      await api('/suite/save', { suite: { ...suite, isDefault: true }, by: currentUser() })
      toast(`夜间回归改跑「${suite.name}」`)
      await refresh()
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error')
    }
  }
  const removeSuite = async suite => {
    if (!(await confirmDialog(`删除套件「${suite.name}」？用例本身不受影响。`, { title: '删除套件', danger: true, okText: '删除' }))) return
    try {
      await api('/suite/delete', { id: suite.id })
      await refresh()
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error')
    }
  }
  const failedRunnable = list.filter(row => row.runnable === true && row.result === 'fail')
  const runSelected = () => runRows(picked)
  // 回归最常用的动作：只补跑上次失败的那几条。
  const runFailed = () => runRows(failedRunnable)

  const requirementOptions = [
    { value: '__all__', label: '全部需求' },
    ...requirements.map(item => ({ value: item.id, label: `${item.code || item.id} ${item.title}` })),
  ]
  const resultOptions = [
    { value: '__all__', label: '全部结果' },
    ...CASE_RESULTS.map(value => ({ value, label: CASE_RESULT_LABEL[value] })),
  ]
  const kindOptions = [
    { value: '__all__', label: '全部用例' },
    { value: 'runnable', label: '只可跑' },
    { value: 'bare', label: `只看无断言 ${bareCount}` },
  ]
  const sortOptions = [
    { value: 'recent', label: '最近执行' },
    { value: 'title', label: '标题' },
    { value: 'result', label: '结果（失败在前）' },
  ]

  return h('div', { className: PAGE, 'data-cases-page': '' },
    h('div', { className: PANEL },
      h('div', { className: PANEL_HEAD },
        h('span', null, '用例总览'),
        h('span', { className: HINT }, '全公司的用例按卡片汇总：点一行跳回那张卡；用例本身仍在卡片的「测试」里维护'),
        h(Chip, { color: 'gray', className: 'ms-auto' }, `${list.length} 条 · 通过 ${counts.pass} · 不通过 ${counts.fail}${counts.skip > 0 ? ` · 跳过 ${counts.skip}` : ''}${counts.rest > 0 ? ` · 没跑 ${counts.rest}` : ''}`),
        h(Button, { variant: 'ghost', size: 'sm', onClick: () => void refresh() }, '刷新'),
      ),
      h('div', { className: PANEL_BODY },
        h('div', { className: ROW },
          h(SearchInput, {
            className: 'w-60', value: query,
            placeholder: '搜用例 / 卡片 / 需求 / 功能点',
            onChange: event => setQuery(event.target.value),
          }),
          h(Select, {
            className: 'w-56', value: requirement, options: requirementOptions,
            'aria-label': '按需求筛选',
            onChange: event => setRequirement(event.target.value),
          }),
          h(Select, {
            className: 'w-36', value: result, options: resultOptions,
            'aria-label': '按结果筛选',
            onChange: event => setResult(event.target.value),
          }),
          h(Select, {
            className: 'w-40', value: kind, options: kindOptions,
            'aria-label': '按用例类型筛选',
            onChange: event => setKind(event.target.value),
          }),
        ),
        h('div', { className: ROW },
          h(Button, { variant: 'secondary', size: 'sm', disabled: running || runnable.length === 0, onClick: selectAllRunnable }, `全选可跑的 ${runnable.length} 条`),
          h(Button, { variant: 'secondary', size: 'sm', disabled: running || selected.size === 0, onClick: clearSelection }, '清空选择'),
          h(Button, { variant: 'primary', size: 'sm', disabled: running || picked.length === 0, onClick: () => void runSelected() }, running ? '跑着…' : [uiIcon(h, 'run'), ` 跑选中的 ${picked.length} 条`]),
          h(Button, { variant: 'secondary', size: 'sm', disabled: running || failedRunnable.length === 0, title: '只补跑上次不通过、且有接口定义的用例', onClick: () => void runFailed() }, [uiIcon(h, 'retry'), ` 只跑上次失败的 ${failedRunnable.length} 条`]),
          h('span', { className: HINT }, `按卡串行跑，每张卡一轮；失败的照旧自动开缺陷（最多一次 60 条）。${bareCount > 0 ? `另有 ${bareCount} 条没有可执行断言，跑不了也不计入覆盖率。` : ''}`),
        ),
        h('div', { className: ROW },
          h('span', { className: HINT }, '回归套件：'),
          suites.length === 0
            ? h('span', { className: HINT }, '还没有套件。把当前筛选存成套件，夜间就自动跑它。')
            : suites.map(suite => h('span', {
              key: suite.id,
              className: 'inline-flex min-w-0 items-center gap-1 rounded-lg border border-separator-border bg-background-secondary-default px-2 py-1',
              'data-suite': suite.id,
              'data-default': suite.isDefault ? '1' : '0',
            },
              h('span', {
                className: 'cursor-pointer text-caption-1-medium text-text-secondary',
                title: '点一下只看这个套件里的用例，再点一次取消',
                onClick: () => setSuiteFilter(current => (current === suite.id ? null : suite.id)),
              }, `${suite.name}${suite.isDefault ? ' · 默认' : ''} · ${suiteCounts[suite.id] ?? 0} 条${suiteFilter === suite.id ? '（只看中）' : ''}`),
              h(Button, { variant: 'ghost', size: 'xs', disabled: running || (suiteCounts[suite.id] ?? 0) === 0, onClick: () => void runSuite(suite) }, uiIcon(h, 'run'), ' 跑'),
              suite.isDefault ? null : h(Button, { variant: 'ghost', size: 'xs', onClick: () => void makeDefault(suite) }, '设为默认'),
              h(Button, { variant: 'ghost', size: 'xs', onClick: () => void removeSuite(suite) }, '删除'),
            )),
          h(Button, { variant: 'ghost', size: 'sm', onClick: () => void saveSuite() }, '＋ 存为套件'),
        ),
        h('div', { className: 'flex min-w-0 flex-wrap items-center gap-2' },
          h('span', { className: HINT }, `共 ${sorted.length} 条 · 第 ${currentPage}/${totalPages} 页`),
          h(Select, {
            className: 'w-32', value: sortBy, options: sortOptions,
            'aria-label': '排序方式',
            onChange: event => setSortBy(event.target.value),
          }),
          h(Button, { variant: 'ghost', size: 'sm', disabled: currentPage <= 1, onClick: () => setPage(currentPage - 1) }, '上一页'),
          h(Button, { variant: 'ghost', size: 'sm', disabled: currentPage >= totalPages, onClick: () => setPage(currentPage + 1) }, '下一页'),
        ),
        note === '' ? null : h('div', { className: HINT }, note),
        regressions.length === 0 ? null : h('div', { className: 'flex min-w-0 flex-wrap items-center gap-2', 'data-regression-list': '' },
          h('span', { className: HINT }, '最近回归：'),
          regressions.slice(0, 4).map(item => h('span', {
            key: String(item.at),
            className: (Number(item.failed) || 0) + (Number(item.failedCards) || 0) > 0
              ? 'rounded-md bg-background-tertiary-error px-2 py-1 text-caption-1-regular text-text-error-primary'
              : 'rounded-md bg-background-secondary-default px-2 py-1 text-caption-1-regular text-text-secondary',
            'data-bad': (Number(item.failed) || 0) + (Number(item.failedCards) || 0) > 0 ? '1' : '0',
            title: `${new Date(item.at).toLocaleString('zh-CN')} · ${item.by || '人'}`,
          }, `${fmtTime(item.at)} ${item.by || ''} · ${item.cards} 卡 / ${item.total} 条 · 通过 ${item.passed} · 不通过 ${item.failed}${item.bugs > 0 ? ` · 缺陷 ${item.bugs}` : ''}`)),
        ),
        error !== null ? h('div', { className: 'text-caption-1-regular text-text-error-primary' }, error) : null,
        rows === null
          ? h('div', { className: `${HINT} py-3` }, '载入用例…')
          : list.length === 0
            ? h(EmptyState, {
              title: '没有符合条件的用例。用例登记在卡片详情的「测试」里。',
              action: typeof onOpenBoard === 'function'
                ? h(Button, { variant: 'secondary', size: 'sm', onClick: () => onOpenBoard() }, '去看板开一张卡')
                : null,
            })
            : h('div', { className: 'flex min-w-0 flex-col', 'data-cases-table': '' },
              /* 官方 Table：react-aria 的 Table + Column/Row/Cell，产出真 <table>/<th>/<td>，
                 行选择与键盘导航由组件负责。原来是一串 div 拼的 8 列网格。
                 RAC 的 collection 组件不能被自定义组件包住（官方 table.tsx 注释也写了），
                 所以这里直接用它的再导出。 */
              h(Table, {
                size: 'sm',
                'aria-label': '用例库',
                selectionMode: 'multiple',
                selectedKeys: selected,
                onSelectionChange: keys => setSelected(new Set(keys)),
                onRowAction: key => {
                  const target = sorted.find(item => item.key === key)
                  if (target !== undefined) onOpenTask(target.taskId)
                },
              },
                h(TableHeader, null,
                  h(TableColumn, { id: 'result', isRowHeader: true }, '结果'),
                  h(TableColumn, { id: 'title' }, '用例'),
                  h(TableColumn, { id: 'meta' }, '所属卡片 / 需求'),
                  h(TableColumn, { id: 'kind' }, '类型'),
                  h(TableColumn, { id: 'priority' }, '优先级'),
                  h(TableColumn, { id: 'at' }, '最近执行'),
                  h(TableColumn, { id: 'more' }, '明细'),
                ),
                h(TableBody, null,
                  /* 不能用 isDisabled 表达"不可跑"：它同时禁掉行激活，手工用例就点不开所属卡片了。
               选择按 row.runnable 在 selection 层控制（见 selectedKeys 的计算）。 */
              pageRows.map(row => h(TableRow, { key: row.key, id: row.key, isDisabled: running === true, 'data-case-row': row.key },
                    h(TableCell, null, CASE_RESULT_LABEL[row.result] ?? row.result),
                    h(TableCell, null, row.title),
                    h(TableCell, null, `${row.taskCode || row.taskId} · ${row.requirementTitle || '未挂需求'}${row.pointId ? ' · ' + row.pointId : ''}`),
                    h(TableCell, null, row.http
                      ? '接口'
                      : row.shell
                        ? 'shell'
                        : row.db
                          ? '数据库'
                          : row.browser
                            ? '浏览器'
                            : h('span', { className: HINT, title: '没有可执行断言：跑不了，也不计入可执行覆盖率' }, row.draft ? '草稿' : '无断言')),
                    h(TableCell, null, row.priority),
                    h(TableCell, null, row.lastRunAt > 0 ? fmtTime(row.lastRunAt) : '没跑过'),
                    h(TableCell, null,
                      h(Button, {
                        variant: 'ghost',
                        size: 'sm',
                        onClick: () => setOpenDetail(openDetail === row.key ? null : row.key),
                      }, openDetail === row.key ? '收起' : '明细'),
                    ),
                  )),
                ),
              ),
              // 明细面板放在表格下面：RAC 的行不支持内联展开，展开内容挪到表外，行为与原来一致。
              openDetail === null
                ? null
                : (() => {
                  const row = sorted.find(item => item.key === openDetail)
                  if (row === undefined) return null
                  return h('div', { className: 'mt-3 flex min-w-0 flex-col gap-2 rounded-xl border border-separator-border bg-background-secondary-default p-3', 'data-case-detail': row.key },
                    h('div', { className: 'text-body-2-regular text-text-primary' }, `期望：${row.expected || '—'}`),
                    h('div', { className: 'text-body-2-regular text-text-secondary' }, `最近一次：${row.note || (row.lastRunAt > 0 ? '只有结果，没有记录' : '还没跑过')}`),
                    row.lastError === '' ? null : h('div', { className: 'text-caption-1-regular text-text-error-primary' }, `错误：${row.lastError}`),
                    row.lastPreview === '' ? null : h('pre', { className: 'overflow-x-auto rounded-lg border border-separator-border bg-background-primary-default p-3 font-mono text-caption-1-regular text-text-secondary' }, row.lastPreview),
                    h('div', { className: HINT }, `用例编号 ${row.id} · 所属卡片 ${row.taskCode || row.taskId}`),
                  )
                })(),
            ),
      ),
    ),
  )
}
