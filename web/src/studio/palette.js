/* Command palette: one box that finds a card, a requirement or a release by
   code, title or owner. Pure helpers first (searchItems / filterItems) so they
   can be unit-tested without React; the component is a thin shell over them. */

import { fmtTime } from './format.js'

const clip = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text)

export function searchItems(state) {
  const items = []
  const statusLabel = new Map((state.statuses ?? []).map((entry) => [entry.id, entry.label]))
  for (const task of state.tasks ?? []) {
    items.push({
      key: 'task:' + task.id,
      kind: 'task',
      id: task.id,
      label: `${task.code ?? ''} ${task.title}`.trim(),
      hint: [statusLabel.get(task.status) ?? task.status, task.owner?.label ?? ''].filter(Boolean).join(' · '),
      search: [task.code, task.title, task.requirementTitle, task.id].filter(Boolean).join(' ').toLowerCase(),
    })
  }
  for (const requirement of state.requirements ?? []) {
    items.push({
      key: 'requirement:' + requirement.id,
      kind: 'requirement',
      id: requirement.id,
      label: `${requirement.code ?? ''} ${requirement.title}`.trim(),
      hint: ['需求', requirement.domain || '', requirement.owner || ''].filter(Boolean).join(' · '),
      search: [requirement.code, requirement.title, requirement.domain].filter(Boolean).join(' ').toLowerCase(),
    })
  }
  for (const release of state.releases ?? []) {
    items.push({
      key: 'release:' + release.id,
      kind: 'release',
      id: release.id,
      label: `${release.name ?? ''} ${release.tagName ?? ''}`.trim(),
      hint: ['版本', release.status ?? '', release.at ? fmtTime(release.at) : ''].filter(Boolean).join(' · '),
      search: [release.name, release.tagName, release.status].filter(Boolean).join(' ').toLowerCase(),
    })
  }
  return items
}

/** Things you can *do*, as opposed to records you can jump to. */
export const ACTION_ITEMS = [
  { id: 'new-requirement', label: '新建需求', hint: '需求 → 功能点 → 拆成卡', keys: '新建 需求 new requirement 提需求' },
  { id: 'new-task', label: '新建任务', hint: '直接在看板上建一张卡', keys: '新建 任务 卡片 new task 建卡' },
  { id: 'tab:board', label: '打开看板', hint: '八列泳道 · 拖拽换列', keys: '看板 board 泳道' },
  { id: 'tab:requirements', label: '打开需求', hint: '需求 · 功能点 · 文档 · 准出', keys: '需求 requirements prd' },
  { id: 'tab:releases', label: '打开版本', hint: '发布 · 灰度 · 部署记录', keys: '版本 release 发布 部署' },
  { id: 'tab:analytics', label: '打开效能', hint: '周期 · 返工 · AI 采纳', keys: '效能 analytics 度量 报表' },
  { id: 'tab:dashboard', label: '打开工作台', hint: '风险与今日待办', keys: '工作台 dashboard 风险 待办' },
  { id: 'export:tasks', label: '导出任务 CSV', hint: '看板上的卡，Excel 可直接打开', keys: '导出 csv 任务 export tasks 下载' },
  { id: 'export:requirements', label: '导出需求 CSV', hint: '需求与准出情况', keys: '导出 csv 需求 export requirements 下载' },
  { id: 'theme:light', label: '切换主题：明亮', hint: '浅色界面', keys: '主题 明亮 light theme 浅色' },
  { id: 'theme:dark', label: '切换主题：深色', hint: '深色界面', keys: '主题 深色 dark theme 夜间' },
  { id: 'theme:system', label: '切换主题：跟随系统', hint: '跟随宿主或操作系统的深浅色', keys: '主题 系统 system theme 自动' },
  { id: 'refresh', label: '刷新数据', hint: '重新拉一次看板与需求', keys: '刷新 refresh 重载 同步' },
]

export function actionItems() {
  return ACTION_ITEMS.map((action) => ({
    key: 'action:' + action.id,
    kind: 'action',
    id: action.id,
    label: action.label,
    hint: action.hint,
    search: (action.label + ' ' + action.hint + ' ' + action.keys).toLowerCase(),
  }))
}

export function paletteItems(state) {
  return [...actionItems(), ...searchItems(state)]
}

export function filterItems(items, query, limit = 20) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return items.slice(0, limit)
  const scored = []
  items.forEach((item, order) => {
    let score = 0
    let hit = true
    for (const word of words) {
      const at = item.search.indexOf(word)
      if (at < 0) { hit = false; break }
      score += at === 0 ? 3 : at < 8 ? 2 : 1
    }
    if (hit) scored.push({ item, score, order })
  })
  // 同分时保持来源顺序：操作项在 paletteItems() 里排在前面，所以「新建需求」永远比「新建任务」靠前
  scored.sort((a, b) => b.score - a.score || a.order - b.order)
  return scored.slice(0, limit).map((entry) => entry.item)
}

const KIND_LABEL = { task: '卡片', requirement: '需求', release: '版本', action: '操作' }

export function createPalette({ h, React }) {
  return function Palette({ state, onPick, onClose }) {
    const [query, setQuery] = React.useState('')
    const [active, setActive] = React.useState(0)
    const inputRef = React.useRef(null)
    const all = React.useMemo(() => paletteItems(state), [state])
    const list = React.useMemo(() => filterItems(all, query), [all, query])

    React.useEffect(() => { inputRef.current?.focus() }, [])
    React.useEffect(() => { setActive(0) }, [query])

    const pick = (item) => {
      if (item === undefined) return
      onPick(item)
      onClose()
    }

    const onKeyDown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.min(list.length - 1, index + 1)); return }
      if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(0, index - 1)); return }
      if (event.key === 'Enter') { event.preventDefault(); pick(list[active]) }
    }

    return h('div', { className: 'ds-palette-veil', onClick: onClose },
      h('div', {
        className: 'ds-palette',
        role: 'dialog',
        'aria-label': '全局搜索',
        'data-palette': '1',
        onClick: (event) => event.stopPropagation(),
      },
        h('input', {
          ref: inputRef,
          className: 'ds-palette-input',
          placeholder: '搜索卡片 / 需求 / 版本，或输入「新建」「导出」「主题」（↑↓ 选择，回车执行，Esc 关闭）',
          value: query,
          onChange: (event) => setQuery(event.target.value),
          onKeyDown,
          'data-palette-input': '1',
        }),
        h('div', { className: 'ds-palette-list' },
          list.length === 0
            ? h('div', { className: 'ds-hint', style: { padding: '10px 12px' } }, '没有匹配的内容')
            : list.map((item, index) => h('div', {
              key: item.key,
              className: 'ds-palette-item',
              'data-active': index === active ? '1' : '0',
              onMouseEnter: () => setActive(index),
              onClick: () => pick(item),
            },
              h('span', { className: 'ds-palette-kind', 'data-kind': item.kind }, KIND_LABEL[item.kind] ?? item.kind),
              h('span', { className: 'ds-palette-label' }, clip(item.label, 80)),
              item.hint === '' ? null : h('span', { className: 'ds-palette-hint' }, clip(item.hint, 40)),
            )),
        ),
      ),
    )
  }
}
