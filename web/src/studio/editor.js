/* Small list editor: a title, a hint, add button and a per-row renderer. */

export function createEditor({ h, React }) {
function Editor({ title, hint, rows, onAdd, addLabel, render, empty }) {
  return h('div', { className: 'ds-panel' },
    h('div', { className: 'ds-panel-head' },
      h('span', {}, title),
      h('button', { className: 'ds-btn', onClick: onAdd }, addLabel ?? '新增'),
    ),
    h('div', { className: 'ds-panel-body' },
      hint !== undefined ? h('div', { className: 'ds-hint' }, hint) : null,
      rows.length === 0 ? h('div', { className: 'ds-hint' }, empty ?? '还没有内容。') : null,
      rows.map(render),
    ),
  )
}

  return Editor
}
