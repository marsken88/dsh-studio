/* The shared right-hand drawer. Radix Sheet when the host provides one,
   otherwise the legacy mask + panel markup with Escape-to-close. */

export function createSideDrawer({ h, kit }) {
    function SideDrawer({ title, hint, onClose, footer, children }) {
      const Sheet = kit('SheetDrawer')
      if (Sheet !== null) {
        return h(Sheet, { title, hint, onClose, footer }, children)
      }
      return h('div', {
        className: 'ds-side-wrap',
        onKeyDown: e => { if (e.key === 'Escape') onClose() },
      },
        h('div', { className: 'ds-side-mask', onClick: onClose }),
        h('div', { className: 'ds-side', role: 'dialog', 'aria-modal': 'true' },
          h('div', { className: 'ds-side-head' },
            h('div', {},
              h('div', { className: 'ds-side-title' }, title),
              hint === undefined || hint === null ? null : h('div', { className: 'ds-hint' }, hint),
            ),
            h('button', { className: 'ds-btn', onClick: onClose }, '关闭'),
          ),
          h('div', { className: 'ds-side-body' }, children),
          footer === undefined || footer === null ? null : h('div', { className: 'ds-side-foot' }, footer),
        ),
      )
    }

  return SideDrawer
}
