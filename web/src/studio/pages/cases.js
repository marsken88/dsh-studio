/* Cross-card case library: one table over every case that lives on a card, so
   "what cases do we have and what did they do last time" is answerable without
   opening twenty drawers. Read-only for now; the regression runner is next. */

import { client } from '../context.js'
import { CASE_RESULTS, CASE_RESULT_LABEL } from '../labels.js'
import { fmtTime } from '../format.js'

export function CasesPage({ state, onOpenTask }) {
  const { h, React, api, TextField, SelectField, ChipField } = client()
  const [rows, setRows] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [query, setQuery] = React.useState('')
  const [requirement, setRequirement] = React.useState('__all__')
  const [result, setResult] = React.useState('__all__')

  const refresh = React.useCallback(async () => {
    try {
      const out = await api('/cases', {})
      setRows(Array.isArray(out.cases) ? out.cases : [])
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
    return (rows ?? []).filter(row => {
      if (requirement !== '__all__' && row.requirementId !== requirement) return false
      if (result !== '__all__' && row.result !== result) return false
      if (text === '') return true
      return `${row.id} ${row.title} ${row.taskTitle} ${row.requirementTitle} ${row.pointId}`.toLowerCase().includes(text)
    })
  }, [rows, query, requirement, result])

  const counts = React.useMemo(() => {
    const pass = list.filter(row => row.result === 'pass').length
    const fail = list.filter(row => row.result === 'fail').length
    return { pass, fail, rest: list.length - pass - fail }
  }, [list])

  const requirements = state.requirements ?? []

  return h('div', { className: 'ds-body' },
    h('div', { className: 'ds-panel' },
      h('div', { className: 'ds-panel-head' },
        h('span', null, '用例总览'),
        h('span', { className: 'ds-hint' }, '全公司的用例按卡片汇总：点一行跳回那张卡；用例本身仍在卡片的「测试」里维护'),
        h(ChipField, { className: 'ds-chip', style: { marginLeft: 'auto' } }, `${list.length} 条 · ✅ ${counts.pass} · ❌ ${counts.fail} · ⬜ ${counts.rest}`),
        h('button', { className: 'ds-btn ds-btn-ghost', onClick: () => void refresh() }, '刷新'),
      ),
      h('div', { className: 'ds-panel-body' },
        h('div', { className: 'ds-row' },
          h(TextField, {
            className: 'ds-input', style: { width: 240 }, value: query,
            placeholder: '搜用例 / 卡片 / 需求 / 功能点',
            onChange: event => setQuery(event.target.value),
          }),
          h(SelectField, {
            className: 'ds-select', style: { width: 220 }, value: requirement,
            onChange: event => setRequirement(event.target.value),
          },
            h('option', { value: '__all__' }, '全部需求'),
            requirements.map(item => h('option', { key: item.id, value: item.id }, `${item.code || item.id} ${item.title}`)),
          ),
          h(SelectField, {
            className: 'ds-select', style: { width: 140 }, value: result,
            onChange: event => setResult(event.target.value),
          },
            h('option', { value: '__all__' }, '全部结果'),
            CASE_RESULTS.map(value => h('option', { key: value, value }, CASE_RESULT_LABEL[value])),
          ),
        ),
        error !== null ? h('div', { className: 'ds-err' }, error) : null,
        rows === null
          ? h('div', { className: 'ds-hint', style: { padding: '10px 2px' } }, '载入用例…')
          : list.length === 0
            ? h('div', { className: 'ds-empty' }, '没有符合条件的用例。用例登记在卡片详情的「测试」里。')
            : h('div', { className: 'ds-case-lib' },
              list.map(row => h('div', {
                key: row.key,
                className: 'ds-case-lib-row',
                'data-result': row.result,
                title: '打开所属卡片',
                onClick: () => onOpenTask(row.taskId),
              },
                h('span', { className: 'ds-case-lib-result' }, CASE_RESULT_LABEL[row.result] ?? row.result),
                h('span', { className: 'ds-case-lib-title' }, row.title),
                h('span', { className: 'ds-case-lib-meta' }, `${row.taskCode || row.taskId} · ${row.requirementTitle || '未挂需求'}${row.pointId ? ' · ' + row.pointId : ''}`),
                h('span', { className: 'ds-case-lib-meta' }, row.http ? '接口' : '手工'),
                h('span', { className: 'ds-case-lib-pri' }, row.priority),
                h('span', { className: 'ds-case-lib-at' }, row.lastRunAt > 0 ? fmtTime(row.lastRunAt) : '没跑过'),
              )),
            ),
      ),
    ),
  )
}
