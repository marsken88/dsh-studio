/* The @ expert picker shown above the comment box in the card drawer. */

import { filterRoster } from './roster.js'

export function createMentionPicker({ h, TextField }) {
function MentionPicker({ roster, query, active, onQuery, onActive, onPick, onClose }) {
  const hits = filterRoster(roster, query)
  const move = delta => {
    if (hits.length === 0) return
    onActive((active + delta + hits.length) % hits.length)
  }
  const onKeyDown = event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
    else if (event.key === 'Enter') { event.preventDefault(); if (hits[active] !== undefined) onPick(hits[active].name) }
    else if (event.key === 'Escape') { event.preventDefault(); onClose() }
  }
  return h('div', { className: 'ds-mention-pop', onKeyDown },
    h(TextField, {
      className: 'ds-mention-search', autoFocus: true, value: query,
      placeholder: '搜专家或专家团，Enter 选中，Esc 关闭',
      onChange: event => onQuery(event.target.value),
    }),
    h('div', { className: 'ds-mention-list' },
      hits.length === 0
        ? h('div', { className: 'ds-mention-empty' }, '没有匹配的专家或专家团')
        : hits.map((item, index) => {
          const first = index === 0 || hits[index - 1].group !== item.group
          return [
            first ? h('div', { key: item.group, className: 'ds-mention-group' }, item.group) : null,
            h('button', {
              key: item.key, className: 'ds-mention-item', 'data-active': index === active ? '1' : '0',
              onMouseEnter: () => onActive(index),
              onClick: () => onPick(item.name),
            }, h('span', null, item.emoji), h('span', null, item.name), h('span', { className: 'ds-hint' }, item.hint)),
          ]
        }).flat().filter(Boolean),
    ),
  )
}

  return MentionPicker
}
