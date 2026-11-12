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

export function filterItems(items, query, limit = 20) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return items.slice(0, limit)
  const scored = []
  for (const item of items) {
    let score = 0
    let hit = true
    for (const word of words) {
      const at = item.search.indexOf(word)
      if (at < 0) { hit = false; break }
      score += at === 0 ? 3 : at < 8 ? 2 : 1
    }
    if (hit) scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label))
  return scored.slice(0, limit).map((entry) => entry.item)
}

const KIND_LABEL = { task: '卡片', requirement: '需求', release: '版本' }

export function createPalette({ h, React }) {
  return function Palette({ state, onPick, onClose }) {
    const [query, setQuery] = React.useState('')
    const [active, setActive] = React.useState(0)
    const inputRef = React.useRef(null)
    const all = React.useMemo(() => searchItems(state), [state])
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
          placeholder: '搜索卡片 / 需求 / 版本（↑↓ 选择，回车打开，Esc 关闭）',
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
              h('span', { className: 'ds-palette-kind' }, KIND_LABEL[item.kind] ?? item.kind),
              h('span', { className: 'ds-palette-label' }, clip(item.label, 80)),
              item.hint === '' ? null : h('span', { className: 'ds-palette-hint' }, clip(item.hint, 40)),
            )),
        ),
      ),
    )
  }
}
