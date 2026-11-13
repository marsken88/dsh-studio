/* The board itself: filters, eight columns, drag & drop and WIP limits.
   Data comes in as props; every mutation is a callback from the panel. */

import { ROLE_LABEL, TYPE_LABEL } from './labels.js'
import { artifactsWithoutBody, buildRoster, filterRoster, ownerLabel } from './roster.js'

/** 每列先渲染这么多张；上千张卡时 DOM 会先炸，而不是服务端。 */
const COLUMN_PAGE = 40

export function createBoard({ h, React, Card, TextField, SelectField, CheckField, toast }) {
function Board({ state, onOpen, onMove, onWip }) {
  const config = state.config ?? {}
  const experts = config.experts ?? []
  const [query, setQuery] = React.useState('')
  const [expertFilter, setExpertFilter] = React.useState('')
  const [typeFilter, setTypeFilter] = React.useState('')
  const [projectFilter, setProjectFilter] = React.useState('')
  const [iterationFilter, setIterationFilter] = React.useState('')
  const [serviceFilter, setServiceFilter] = React.useState('')
  const [requirementFilter, setRequirementFilter] = React.useState('')
  const [hideEmpty, setHideEmpty] = React.useState(false)
  const [onlyBlocked, setOnlyBlocked] = React.useState(false)
  const [onlyNoBody, setOnlyNoBody] = React.useState(false)
  // 每列当前渲染到第几张；点「显示更多」一页一页加。
  const [shown, setShown] = React.useState({})
  const projects = config.projects ?? []
  const activeProject = projects.find(item => item.id === projectFilter)
  const byStatus = React.useMemo(() => {
    const keyword = query.trim().toLowerCase()
    const map = new Map()
    for (const column of state.statuses) map.set(column.id, [])
    for (const task of state.tasks) {
      if (onlyBlocked && (task.blocked ?? null) === null) continue
      if (onlyNoBody && artifactsWithoutBody(task).length === 0) continue
      if (typeFilter !== '' && (task.type ?? 'requirement') !== typeFilter) continue
      if (projectFilter !== '' && task.project !== projectFilter) continue
      if (iterationFilter !== '' && task.iteration !== iterationFilter) continue
      if (serviceFilter !== '' && (task.service ?? '') !== serviceFilter) continue
      if (requirementFilter !== '' && (task.requirementId ?? '') !== requirementFilter) continue
      if (expertFilter !== '' && task.expert !== expertFilter && task.dispatch?.expert !== expertFilter) continue
      if (keyword !== '' && !`${task.title} ${task.requirement} ${task.domain} ${task.id}`.toLowerCase().includes(keyword)) continue
      if (!map.has(task.status)) map.set(task.status, [])
      map.get(task.status).push(task)
    }
    const weight = { urgent: 0, normal: 1, relaxed: 2 }
    for (const list of map.values()) {
      list.sort((left, right) => (weight[left.priority] ?? 1) - (weight[right.priority] ?? 1) || right.updatedAt - left.updatedAt)
    }
    return map
  }, [state, query, expertFilter, typeFilter, projectFilter, iterationFilter, serviceFilter, requirementFilter, onlyBlocked, onlyNoBody])
  const total = [...byStatus.values()].reduce((sum, list) => sum + list.length, 0)
  const bugCount = [...byStatus.values()].reduce((sum, list) => sum + list.filter(task => task.type === 'bug').length, 0)
  const designPending = (tasks ?? []).filter(task => task.design !== null && task.design !== undefined && task.design.status !== 'approved').length
  const blockedCount = state.tasks.filter(task => (task.blocked ?? null) !== null).length
  const noBodyCount = state.tasks.filter(task => artifactsWithoutBody(task).length > 0).length
  const columns = state.statuses.filter(column => !hideEmpty || (byStatus.get(column.id) ?? []).length > 0)
  const filtering = query !== '' || expertFilter !== '' || typeFilter !== '' || onlyBlocked || onlyNoBody || projectFilter !== '' || iterationFilter !== '' || serviceFilter !== '' || requirementFilter !== ''
  return h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
    h('div', { className: 'ds-board-bar' },
      h('span', { className: 'ds-search' },
        h(TextField, {
          className: 'ds-input', style: { width: 200, fontSize: 12 }, value: query, placeholder: '搜标题 / 需求 / 领域 / 编号',
          onChange: event => setQuery(event.target.value),
        }),
      ),
      projects.length > 0
        ? h(SelectField, {
          className: 'ds-select', style: { width: 150, fontSize: 12 }, value: projectFilter,
          onChange: event => { setProjectFilter(event.target.value); setIterationFilter(''); setServiceFilter('') },
        },
          h('option', { value: '' }, `全部项目（${projects.filter(item => item.status !== 'archived').length}）`),
          projects.map(item => h('option', { key: item.id, value: item.id }, `${item.key ? `${item.key} · ` : ''}${item.name}`)),
        )
        : null,
      activeProject !== undefined && (activeProject.iterations ?? []).length > 0
        ? h(SelectField, {
          className: 'ds-select', style: { width: 132, fontSize: 12 }, value: iterationFilter,
          onChange: event => setIterationFilter(event.target.value),
        },
          h('option', { value: '' }, '全部迭代'),
          activeProject.iterations.map(item => h('option', { key: item.id, value: item.id }, item.name)),
        )
        : null,
      activeProject !== undefined && (activeProject.services ?? []).length > 0
        ? h(SelectField, {
          className: 'ds-select', style: { width: 150, fontSize: 12 }, value: serviceFilter,
          onChange: event => setServiceFilter(event.target.value),
        },
          h('option', { value: '' }, `全部服务（${(activeProject.services ?? []).length}）`),
          activeProject.services.map(item => h('option', { key: item.id, value: item.id }, item.name || item.id)),
        )
        : null,
      (state.requirements ?? []).length > 0
        ? h(SelectField, {
          className: 'ds-select', style: { width: 190, fontSize: 12 }, value: requirementFilter,
          title: '只看某条需求下的卡（需求是整条链路的锚点）',
          onChange: event => setRequirementFilter(event.target.value),
        },
          h('option', { value: '' }, `全部需求（${(state.requirements ?? []).length}）`),
          (state.requirements ?? []).map(item =>
            h('option', { key: item.id, value: item.id }, `${item.code || item.id} ${item.title}`)),
        )
        : null,
      h(SelectField, {
        className: 'ds-select', style: { width: 108, fontSize: 12 }, value: typeFilter,
        onChange: event => setTypeFilter(event.target.value),
      },
        h('option', { value: '' }, '全部类型'),
        ['requirement', 'bug', 'design', 'dev', 'test', 'ops'].map(value =>
          h('option', { key: value, value }, TYPE_LABEL[value] ?? value)),
      ),
      h(SelectField, {
        className: 'ds-select', style: { width: 158, fontSize: 12 }, value: expertFilter,
        onChange: event => setExpertFilter(event.target.value),
      },
        h('option', { value: '' }, '全部专家'),
        experts.filter(expert => expert.enabled !== false).map(expert =>
          h('option', { key: expert.id, value: expert.id }, `${expert.emoji} ${expert.name}`)),
      ),
      h('label', { className: 'ds-row', style: { gap: 5, fontSize: 12, cursor: 'pointer', opacity: .8 } },
        h(CheckField, { checked: hideEmpty, onChange: event => setHideEmpty(event.target.checked) }),
        h('span', {}, '隐藏空列'),
      ),
      blockedCount > 0
        ? h('label', {
          className: 'ds-row', style: { gap: 5, fontSize: 12, cursor: 'pointer', color: '#c0392b' },
          title: '只看被标记为阻塞的卡（它们停在原列，等人决定怎么继续）',
        },
          h(CheckField, { checked: onlyBlocked, onChange: event => setOnlyBlocked(event.target.checked) }),
          h('span', {}, `只看阻塞 ${blockedCount}`),
        )
        : null,
      noBodyCount > 0
        ? h('label', {
          className: 'ds-row', style: { gap: 5, fontSize: 12, cursor: 'pointer', color: '#e5484d' },
          title: '只看有交付物但没写正文的卡（云盘文档里只有标题，等于没交付）',
        },
          h(CheckField, { checked: onlyNoBody, onChange: event => setOnlyNoBody(event.target.checked) }),
          h('span', {}, `只看缺正文 ${noBodyCount}`),
        )
        : null,
      filtering
        ? h('button', {
          className: 'ds-btn', style: { padding: '4px 10px' },
          onClick: () => { setQuery(''); setExpertFilter(''); setTypeFilter(''); setOnlyBlocked(false); setOnlyNoBody(false); setProjectFilter(''); setIterationFilter(''); setServiceFilter(''); setRequirementFilter('') },
        }, '清除筛选')
        : null,
      h('span', { className: 'ds-stat', style: { marginLeft: 'auto' } },
        `${total} 张卡 · ${designPending > 0 ? `${designPending} 个设计待评审 · ` : ''}${bugCount > 0 ? `${bugCount} 个缺陷` : `${columns.length} 列`}`),
    ),
    h('div', {
      className: 'ds-board',
      tabIndex: 0,
      'aria-label': '看板列，左右滚动或用方向键',
    },
      columns.map(column => {
        const tasks = byStatus.get(column.id) ?? []
        const owner = ownerLabel(config, config.columns?.[column.id])
        return h('div', {
          className: 'ds-col', key: column.id, 'data-col': column.id, 'data-role': column.role,
          onDragOver: event => { event.preventDefault(); if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'; event.currentTarget.setAttribute('data-drag-over', '1') },
          onDragLeave: event => event.currentTarget.removeAttribute('data-drag-over'),
          onDrop: event => { event.preventDefault(); event.currentTarget.removeAttribute('data-drag-over'); const id = event.dataTransfer === null ? '' : event.dataTransfer.getData('text/plain'); if (id === '' || id === undefined) return; const wip = Number(config.columns?.[column.id]?.wip) || 0; const filled = (byStatus.get(column.id) ?? []).length; if (wip > 0 && filled >= wip) { toast(`「${column.label}」已到 WIP 上限 ${wip}，先把列里的卡往前推`, 'error'); return } void onMove(id, column.id) },
        },
          h('div', { className: 'ds-col-head' },
            h('div', { className: 'ds-col-title' },
              h('span', { className: 'ds-col-name' }, column.label),
              (() => {
                const wip = Number(config.columns?.[column.id]?.wip) || 0
                const over = wip > 0 && tasks.length > wip
                return h('span', { className: 'ds-count', 'data-zero': tasks.length === 0 ? '1' : '0', 'data-over': over ? '1' : '0', onClick: event => { event.stopPropagation(); if (typeof onWip === 'function') onWip(column.id, wip) }, title: wip > 0 ? `WIP 上限 ${wip} 张，当前 ${tasks.length} 张${over ? '（已超出，先消化再加）' : ''}` : '这一列没有设 WIP 上限' }, wip > 0 ? `${tasks.length}/${wip}` : String(tasks.length))
              })(),
            ),
            h('div', { className: 'ds-col-owner', 'data-empty': owner.length === 0 ? '1' : '0', title: '这一列的默认负责人：卡推进到本列后由它接手' },
              h('span', { className: 'ds-col-owner-label' }, '负责人'),
              owner.length === 0 ? h('span', { className: 'ds-col-owner-name' }, '未配置') : h('span', { className: 'ds-col-owner-name' }, owner),
            ),
          ),
          h('div', { className: 'ds-col-body' },
            tasks.length === 0
              ? h('div', { className: 'ds-empty' }, query !== '' || expertFilter !== '' ? '没有匹配的卡' : '暂无任务')
              : tasks.slice(0, shown[column.id] ?? COLUMN_PAGE).map(task => h(Card, {
                  key: task.id,
                  task,
                  onOpen,
                  config,
                  requirements: state.requirements ?? [],
                  onPickRequirement: id => setRequirementFilter(current => (current === id ? '' : id)),
                  onPickProject: id => { setProjectFilter(current => (current === id ? '' : id)); setIterationFilter('') },
                })),
            tasks.length > (shown[column.id] ?? COLUMN_PAGE)
              ? h('button', {
                className: 'ds-btn ds-btn-ghost',
                style: { width: '100%', marginTop: 6, fontSize: 12 },
                onClick: () => setShown(previous => ({ ...previous, [column.id]: (previous[column.id] ?? COLUMN_PAGE) + COLUMN_PAGE })),
              }, `显示更多（还有 ${tasks.length - (shown[column.id] ?? COLUMN_PAGE)} 张）`)
              : null,
          ),
        )
      }),
    ),
  )
}

  return Board
}
