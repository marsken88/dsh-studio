/* The board itself: filters, eight columns, drag & drop and WIP limits.
   Data comes in as props; every mutation is a callback from the panel.
 *
 * 外观整块交给 BoardUI（Tailwind v4 + token + 4px 档位），一个手写类名都不留：
 * 定位只认 data-* 钩子 —— data-board / data-board-toolbar / data-board-column /
 * data-board-column-body / data-wip-count，探针按这些钩子取列、筛选条与计数。
 */

import { ROLE_LABEL, TYPE_LABEL } from './labels.js'
import { artifactsWithoutBody, buildRoster, filterRoster, ownerLabel } from './roster.js'
import { Button } from '../boardui/index'
import { EmptyState } from '../boardui/empty-state'

/** 每列先渲染这么多张；上千张卡时 DOM 会先炸，而不是服务端。 */
const COLUMN_PAGE = 40

/* 4px 档位：gap-1=4 / gap-2=8 / gap-3=12 / p-2=8 / px-3=12。 */
const ROOT = 'flex min-h-0 flex-1 flex-col'
const TOOLBAR = 'flex flex-none flex-wrap items-center gap-2 border-b border-separator-border px-4 py-2'
/* 列宽两档，照抄 index.css 里「看板列宽策略」那两条规则的实际行为：
   · 默认 flex 1 1 200px，列宽在 200–360 之间自适应（列多就先横向滚）；
   · 勾上「适应宽度」压到 flex 1 1 0 / min 160，一屏放下全部列。
   用 arbitrary 的 flex 简写，避免 w-[282px] 与 flex-1 同时在场时谁赢说不清。 */
const COLUMN_BASE = 'flex flex-col overflow-hidden rounded-2xl border border-separator-border bg-background-secondary-default data-[drag-over="1"]:border-accent-500 data-[drag-over="1"]:bg-accent-50'
const COLUMN_FIXED = 'w-auto min-w-[200px] max-w-[360px] flex-[1_1_200px]'
const COLUMN_FIT = 'min-w-[160px] max-w-none flex-[1_1_0]'
const COLUMN_HEAD = 'flex flex-none items-center gap-2 border-b border-separator-border bg-background-primary-default px-3 py-2'
const COLUMN_TITLE = 'min-w-0 truncate text-body-2-semibold text-text-primary'
const COLUMN_COUNT = 'ml-auto min-w-6 shrink-0 rounded-full bg-background-secondary-default px-2 text-center text-caption-1-medium tabular-nums text-text-secondary data-[zero="1"]:opacity-50 data-[over="1"]:bg-status-rose-background data-[over="1"]:text-status-rose-text'
const COLUMN_OWNER = 'flex-none truncate px-3 pb-2 text-caption-1-regular text-text-tertiary'
const COLUMN_BODY = 'flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2'
const BOARD_ROW = 'flex min-h-0 flex-1 items-stretch gap-3 overflow-x-auto overflow-y-hidden p-3'
const HINT = 'text-caption-1-regular text-text-tertiary'
const LABEL_ROW = 'flex cursor-pointer items-center gap-1 text-caption-1-regular text-text-secondary'
const LABEL_ROW_WARN = 'flex cursor-pointer items-center gap-1 text-caption-1-regular text-text-error-primary'
const STAT = 'ml-auto shrink-0 text-caption-1-regular tabular-nums text-text-tertiary'

/** 每列一条色条：原先 index.css 按 [data-col] 给 --col-accent 写死 8 个 hex，
    这里改成 token 工具类，同色系、不写死颜色。认不出列 id 时退回角色色。 */
const COLUMN_ACCENT = {
  clarify: 'border-t-2 border-t-zinc-400',
  design: 'border-t-2 border-t-purple-500',
  dev_ready: 'border-t-2 border-t-blue-500',
  dev: 'border-t-2 border-t-cyan-500',
  review: 'border-t-2 border-t-yellow-500',
  test: 'border-t-2 border-t-orange-500',
  accept: 'border-t-2 border-t-emerald-500',
  done: 'border-t-2 border-t-zinc-600',
}

const ROLE_ACCENT = {
  product: 'border-t-2 border-t-accent-500',
  architect: 'border-t-2 border-t-purple-500',
  dev: 'border-t-2 border-t-green-500',
  qa: 'border-t-2 border-t-orange-500',
}

export function createBoard({ h, React, Card, TextField, SearchField, SelectField, CheckField, toast }) {
function Board({ state, onOpen, onMove, onWip, onCreate }) {
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
  // 列多时默认给可读列宽、横向滚；打开这个把列压到一屏看全（记在本地）
  /* 横向滚动的边缘阴影：列多时让人一眼看出「右边还有列」。 */
  const rowRef = React.useRef(null)
  const [edges, setEdges] = React.useState({ left: false, right: false })
  const syncEdges = event => {
    const el = event?.currentTarget ?? rowRef.current
    if (el === null || el === undefined) return
    const max = el.scrollWidth - el.clientWidth
    setEdges({ left: el.scrollLeft > 4, right: max > 4 && el.scrollLeft < max - 4 })
  }
  React.useEffect(() => {
    syncEdges()
    const onResize = () => syncEdges()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [state.statuses?.length, state.config?.columns])
  const [fitWidth, setFitWidth] = React.useState(() => {
    try {
      const saved = window.localStorage.getItem('studio.boardFit')
      if (saved === '1' || saved === '0') return saved === '1'
    } catch { /* 隐私模式读不到就按默认算 */ }
    /* 没存过偏好：列多或屏窄时先压成一屏（默认 8 列在 1440 下会横向滚、第 8 列看不全）；
       宽屏且列不多时保持可读列宽。用户勾/取消后记在本地，不再走这里。 */
    const columnCount = Array.isArray(state?.statuses) ? state.statuses.length : 8
    const width = typeof window === 'undefined' ? 0 : window.innerWidth
    // 桌面宽屏才有意义：1280 以下压 8 列会把列压到 100px 出头，宁可横向滚。
    return width >= 1280 && width < 1920 && columnCount * 240 + 120 > width
  })
  const [onlyBlocked, setOnlyBlocked] = React.useState(false)
  const [onlyNoBody, setOnlyNoBody] = React.useState(false)
  // 每列当前渲染到第几张；点「显示更多」一页一页加。
  const [shown, setShown] = React.useState({})
  // 筛选后视角常停在最左边的空列：自动滚到第一个有卡的列（只在开启筛选时做，别打断正常浏览）
  React.useEffect(() => {
    const filtering = query !== '' || expertFilter !== '' || typeFilter !== '' || projectFilter !== '' || iterationFilter !== '' || serviceFilter !== '' || requirementFilter !== '' || onlyBlocked === true || onlyNoBody === true
    if (!filtering) return undefined
    const timer = setTimeout(() => {
      const columns = [...document.querySelectorAll('[data-dsh-studio] [data-board-column]')]
      // 空列里也有一行「暂无任务」，所以要看真正的卡片，不能数子节点
      const first = columns.find(node => (node.querySelectorAll('[data-board-column-body] [data-kanban-card]').length) > 0)
      if (first !== undefined && typeof first.scrollIntoView === 'function') first.scrollIntoView({ block: 'nearest', inline: 'start' })
    }, 150)
    return () => clearTimeout(timer)
  }, [query, expertFilter, typeFilter, projectFilter, iterationFilter, serviceFilter, requirementFilter, onlyBlocked, onlyNoBody])

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
  const designPending = state.tasks.filter(task => task.design !== null && task.design !== undefined && task.design.status !== 'approved').length
  const blockedCount = state.tasks.filter(task => (task.blocked ?? null) !== null).length
  const noBodyCount = state.tasks.filter(task => artifactsWithoutBody(task).length > 0).length
  const columns = state.statuses.filter(column => !hideEmpty || (byStatus.get(column.id) ?? []).length > 0)
  /* 一张卡都没有时给一条「从零到一」的路，而不是让 8 列各写一句「暂无任务」。
     注意顺序：filtering 必须先声明。以前它写在 boardEmpty 后面，靠 && 短路侥幸不触发 ——
     空看板（新装用户）第一条就为 true，于是去读还没初始化的 filtering：
     `Cannot access 're' before initialization`（issue #6，macOS 桌面版首次打开看板）。 */
  const filtering = query !== '' || expertFilter !== '' || typeFilter !== '' || onlyBlocked || onlyNoBody || projectFilter !== '' || iterationFilter !== '' || serviceFilter !== '' || requirementFilter !== ''
  const boardEmpty = (state.tasks ?? []).length === 0 && filtering === false
  return h('div', { className: ROOT, 'data-board': '' },
    /* 闸门关掉时要一眼看见：数据来自 /state.gates（服务端算好的按钮态），不是前端猜配置 */
    (() => {
      const gates = state.gates ?? {}
      const off = []
      if (gates.design !== undefined && gates.design.enabled !== true) off.push('设计闸门')
      if (gates.review !== undefined && gates.review.enabled === false) off.push('评审闸门')
      if (off.length === 0) return null
      return h('div', { className: `px-5 pt-1 ${HINT}`, 'data-gate-off': '1' },
        off.join(' / ') + ' 已关闭：卡可以跳过对应的评审直接推进。要打开在「设置 → 每一列由谁负责」。')
    })(),
    boardEmpty && typeof onCreate === 'function'
      ? h('div', { className: 'px-5 pt-4' },
        h(EmptyState, {
          title: '还没有任何卡。先建一张卡，再把需求、用例、版本挂上去。',
          hint: '需求是整条链路的锚点：建卡时可以顺手选一条需求，编号会自动补。',
          action: h(Button, { variant: 'primary', size: 'sm', onClick: () => onCreate() }, '建第一张卡'),
        }))
      : null,
    h('div', { className: TOOLBAR, 'data-board-toolbar': '' },
      /* 搜索用官方 SearchField：放大镜与清除键都是组件自带的，以前是给普通 Input 用 ::before 画了个假放大镜。 */
      h(SearchField, {
        style: { width: 200 }, value: query, placeholder: '搜标题 / 需求 / 领域 / 编号',
        onChange: event => setQuery(event.target.value),
      }),
      projects.length > 0
        ? h(SelectField, {
          style: { width: 150 }, value: projectFilter,
          onChange: event => { setProjectFilter(event.target.value); setIterationFilter(''); setServiceFilter('') },
        },
          h('option', { value: '' }, `全部项目（${projects.filter(item => item.status !== 'archived').length}）`),
          projects.map(item => h('option', { key: item.id, value: item.id }, `${item.key ? `${item.key} · ` : ''}${item.name}`)),
        )
        : null,
      activeProject !== undefined && (activeProject.iterations ?? []).length > 0
        ? h(SelectField, {
          style: { width: 132 }, value: iterationFilter,
          onChange: event => setIterationFilter(event.target.value),
        },
          h('option', { value: '' }, '全部迭代'),
          activeProject.iterations.map(item => h('option', { key: item.id, value: item.id }, item.name)),
        )
        : null,
      activeProject !== undefined && (activeProject.services ?? []).length > 0
        ? h(SelectField, {
          style: { width: 150 }, value: serviceFilter,
          onChange: event => setServiceFilter(event.target.value),
        },
          h('option', { value: '' }, `全部服务（${(activeProject.services ?? []).length}）`),
          activeProject.services.map(item => h('option', { key: item.id, value: item.id }, item.name || item.id)),
        )
        : null,
      (state.requirements ?? []).length > 0
        ? h(SelectField, {
          style: { width: 190 }, value: requirementFilter,
          title: '只看某条需求下的卡（需求是整条链路的锚点）',
          onChange: event => setRequirementFilter(event.target.value),
        },
          h('option', { value: '' }, `全部需求（${(state.requirements ?? []).length}）`),
          (state.requirements ?? []).map(item =>
            h('option', { key: item.id, value: item.id }, `${item.code || item.id} ${item.title}`)),
        )
        : null,
      h(SelectField, {
        style: { width: 108 }, value: typeFilter,
        onChange: event => setTypeFilter(event.target.value),
      },
        h('option', { value: '' }, '全部类型'),
        ['requirement', 'bug', 'design', 'dev', 'test', 'ops'].map(value =>
          h('option', { key: value, value }, TYPE_LABEL[value] ?? value)),
      ),
      h(SelectField, {
        style: { width: 158 }, value: expertFilter,
        onChange: event => setExpertFilter(event.target.value),
      },
        h('option', { value: '' }, '全部专家'),
        experts.filter(expert => expert.enabled !== false).map(expert =>
          h('option', { key: expert.id, value: expert.id }, expert.name)),
      ),
      h('label', { className: LABEL_ROW },
        h(CheckField, { checked: hideEmpty, onChange: event => setHideEmpty(event.target.checked) }),
        h('span', {}, '隐藏空列'),
      ),
      h('label', {
        className: LABEL_ROW,
        title: '把每列压到能一屏看全：列多的时候比横向滚动快，代价是卡片标题会换行',
      },
        h(CheckField, {
          checked: fitWidth,
          onChange: event => {
            const next = event.target.checked
            setFitWidth(next)
            try { window.localStorage.setItem('studio.boardFit', next ? '1' : '0') } catch { /* 隐私模式下写不进去就算了 */ }
          },
        }),
        h('span', {}, '适应宽度'),
      ),
      blockedCount > 0
        ? h('label', {
          className: LABEL_ROW_WARN,
          title: '只看被标记为阻塞的卡（它们停在原列，等人决定怎么继续）',
        },
          h(CheckField, { checked: onlyBlocked, onChange: event => setOnlyBlocked(event.target.checked) }),
          h('span', {}, `只看阻塞 ${blockedCount}`),
        )
        : null,
      noBodyCount > 0
        ? h('label', {
          className: LABEL_ROW_WARN,
          title: '只看有交付物但没写正文的卡（云盘文档里只有标题，等于没交付）',
        },
          h(CheckField, { checked: onlyNoBody, onChange: event => setOnlyNoBody(event.target.checked) }),
          h('span', {}, `只看缺正文 ${noBodyCount}`),
        )
        : null,
      filtering
        ? h(Button, {
          variant: 'secondary', size: 'xs',
          onClick: () => { setQuery(''); setExpertFilter(''); setTypeFilter(''); setOnlyBlocked(false); setOnlyNoBody(false); setProjectFilter(''); setIterationFilter(''); setServiceFilter(''); setRequirementFilter('') },
        }, '清除筛选')
        : null,
      h('span', { className: STAT, 'data-board-stat': '' },
        `${total} 张卡 · ${designPending > 0 ? `${designPending} 个设计待评审 · ` : ''}${bugCount > 0 ? `${bugCount} 个缺陷` : `${columns.length} 列`}`),
    ),
    h('div', { className: 'relative flex min-h-0 min-w-0 flex-1' },
    h('div', {
      ref: rowRef,
      className: BOARD_ROW,
      'data-fit': fitWidth ? '1' : '0',
      tabIndex: 0,
      'aria-label': '看板列，左右滚动或用方向键',
      onScroll: syncEdges,
      onKeyDown: event => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault()
          event.currentTarget.scrollBy({ left: event.key === 'ArrowRight' ? 240 : -240, behavior: 'smooth' })
        }
      },
    },
      columns.map(column => {
        const tasks = byStatus.get(column.id) ?? []
        const owner = ownerLabel(config, config.columns?.[column.id])
        const roleAccent = COLUMN_ACCENT[column.id] ?? ROLE_ACCENT[column.role] ?? ''
        return h('div', {
          className: `${COLUMN_BASE} ${fitWidth ? COLUMN_FIT : COLUMN_FIXED} ${roleAccent}`.trim(), key: column.id,
          'data-col': column.id, 'data-board-column': column.id, 'data-role': column.role,
          onDragOver: event => { event.preventDefault(); if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'; event.currentTarget.setAttribute('data-drag-over', '1') },
          onDragLeave: event => event.currentTarget.removeAttribute('data-drag-over'),
          onDrop: event => { event.preventDefault(); event.currentTarget.removeAttribute('data-drag-over'); const id = event.dataTransfer === null ? '' : event.dataTransfer.getData('text/plain'); if (id === '' || id === undefined) return; /* 拖回原列是空操作：不能当作一次推进 —— 那会重跑设计/评审/准出门禁（要人填 override），还会把阻塞标记清掉。 */ const moved = state.tasks.find(task => task.id === id); if (moved !== undefined && moved.status === column.id) return; const wip = Number(config.columns?.[column.id]?.wip) || 0; /* 用**全量**任务数判定 WIP：byStatus 是筛选后的结果，拿它计数会让「开着筛选就能绕过上限」 */
            const filled = state.tasks.filter(task => task.status === column.id).length; if (wip > 0 && filled >= wip) { toast(`「${column.label}」已到 WIP 上限 ${wip}，先把列里的卡往前推`, 'error'); return } void onMove(id, column.id) },
        },
          h('div', { className: COLUMN_HEAD },
            h('div', { className: 'flex min-w-0 flex-1 items-center gap-2' },
              h('span', { className: COLUMN_TITLE }, column.label),
              (() => {
                const wip = Number(config.columns?.[column.id]?.wip) || 0
                const over = wip > 0 && tasks.length > wip
                return h('span', { className: COLUMN_COUNT, 'data-wip-count': '', 'data-zero': tasks.length === 0 ? '1' : '0', 'data-over': over ? '1' : '0', onClick: event => { event.stopPropagation(); if (typeof onWip === 'function') onWip(column.id, wip) }, title: wip > 0 ? `WIP 上限 ${wip} 张，当前 ${tasks.length} 张${over ? '（已超出，先消化再加）' : ''}` : '这一列没有设 WIP 上限' }, wip > 0 ? `${tasks.length}/${wip}` : String(tasks.length))
              })(),
            ),
          ),
          h('div', { className: COLUMN_OWNER, 'data-col-owner': '', 'data-empty': owner.length === 0 ? '1' : '0', title: '这一列的默认负责人：卡推进到本列后由它接手' },
            h('span', { className: owner.length === 0 ? 'min-w-0 truncate rounded-full border border-dashed border-separator-border px-2' : 'min-w-0 truncate rounded-full bg-background-secondary-default px-2' },
              owner.length === 0
                ? (tasks.length > 0 ? `未配置负责人 · ${tasks.length} 张卡不会自动派` : '未配置负责人')
                : owner),
          ),
          h('div', { className: COLUMN_BODY, 'data-board-column-body': '' },
            tasks.length === 0
              ? h(EmptyState, { title: query !== '' || expertFilter !== '' ? '没有匹配的卡' : '暂无任务' })
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
              ? h('div', { className: 'pt-1' },
                h(Button, {
                  variant: 'ghost', size: 'xs',
                  onClick: () => setShown(previous => ({ ...previous, [column.id]: (previous[column.id] ?? COLUMN_PAGE) + COLUMN_PAGE })),
                }, `显示更多（+${tasks.length - (shown[column.id] ?? COLUMN_PAGE)}）`))
              : null,
          ),
        )
      }),
    ),
      edges.left ? h('div', {
        className: 'pointer-events-none absolute inset-y-0 left-0 w-8',
        style: { background: 'linear-gradient(to right, var(--color-background-primary-default), transparent)' },
        'data-board-fade': 'left',
      }) : null,
      edges.right ? h('div', {
        className: 'pointer-events-none absolute inset-y-0 right-0 w-8',
        style: { background: 'linear-gradient(to left, var(--color-background-primary-default), transparent)' },
        'data-board-fade': 'right',
      }) : null,
    ),
  )
}

  return Board
}
