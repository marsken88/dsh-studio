/* The shared right-hand drawer. Radix Sheet when the host provides one,
   otherwise the legacy mask + panel markup with Escape-to-close.
 *
 * 兜底分支只走自家标记（桌面客户端需要整体避开窗口标题栏，宿主的 SheetDrawer
 * 挪不动），外观走 BoardUI token：
 *   - 遮罩：bg-black/40，定位仍然是「贴着标题栏下沿的 fixed 覆盖层」
 *   - 面板：bg-background-primary-default + border-separator-border + 大阴影
 * 覆盖层的 fixed / top 下沉 / z-index / no-drag 用内联样式写死 —— 这几条是 issue #4
 * 的修复点，不能依赖会被删掉的 legacy 侧滑层规则。
 */

import { Button } from '../boardui/index'

/** 当前需要的标题栏下沉量（px）；Web 版没有标题栏，是 0。 */
function titlebarFloor() {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--ds-titlebar-floor')
    const value = Number.parseFloat(raw)
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

export function createSideDrawer({ h, kit }) {
    function SideDrawer({ title, hint, onClose, footer, children }) {
      const Sheet = kit('SheetDrawer')
      /* 桌面客户端有窗口标题栏，覆盖层要整体下沉（issue #4）。宿主的 SheetDrawer 是它自己的 DOM，
         我们没法保证它的 top 能被我们的 CSS 改到 —— 实测用户截图里它就压在窗口按钮上。
         所以：需要下沉时（--ds-titlebar-floor > 0）用自家标记，和卡片抽屉走同一套定位规则。 */
      if (Sheet !== null && titlebarFloor() === 0) {
        return h(Sheet, { title, hint, onClose, footer }, children)
      }
      return h('div', {
        className: 'flex justify-end bg-black/40',
        'data-side-drawer': '',
        style: {
          position: 'fixed',
          inset: 0,
          top: 'max(env(titlebar-area-height, 0px), var(--ds-titlebar-floor, 0px))',
          zIndex: 80,
          WebkitAppRegion: 'no-drag',
        },
        onKeyDown: e => { if (e.key === 'Escape') onClose() },
      },
        h('div', { className: 'absolute inset-0', 'data-side-mask': '', onClick: onClose }),
        h('div', {
          className: 'relative z-10 flex h-full w-[min(760px,96vw)] flex-col border-l border-separator-border bg-background-primary-default shadow-2xl',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': typeof title === 'string' && title !== '' ? title : '侧边抽屉',
        },
          h('div', { className: 'flex flex-none items-start justify-between gap-3 border-b border-separator-border px-5 pt-4 pb-3' },
            h('div', { className: 'flex min-w-0 flex-col gap-1' },
              h('div', { className: 'truncate text-headline-medium text-text-primary' }, title),
              hint === undefined || hint === null ? null : h('div', { className: 'text-caption-1-regular text-text-tertiary' }, hint),
            ),
            h(Button, { variant: 'secondary', size: 'sm', onClick: onClose }, '关闭'),
          ),
          h('div', { className: 'flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4' }, children),
          footer === undefined || footer === null
            ? null
            : h('div', { className: 'flex flex-none items-center gap-2 border-t border-separator-border bg-background-secondary-default px-5 py-3' }, footer),
        ),
      )
    }

  return SideDrawer
}
