/* Radix portals mount outside the Studio subtree, where every scoped utility
   class (`[data-dsh-studio] .fixed`…) stops matching and the popup collapses
   into normal flow at the end of <body>. The scoping plugin also emits
   `[data-dsh-studio-portal] …` rules, so portals get their own container that
   carries the attribute plus the current theme.

   Kept in lib/ (not in a component) so both studio-ui.jsx and the vendored
   ui.jsx primitives can share it without an import cycle. */
export function portalRoot() {
  if (typeof document === 'undefined') return undefined
  const app = document.querySelector('[data-dsh-studio]:not([data-dsh-studio-portal])')
  const theme = app && app.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
  let node = document.querySelector('[data-dsh-studio-portal]')
  if (node === null) {
    node = document.createElement('div')
    node.setAttribute('data-dsh-studio-portal', '')
    // 同时挂上 data-dsh-studio：抽屉/弹窗里的 legacy 组件（.ds-btn/.ds-chip…）
    // 与手写 CSS 都以 [data-dsh-studio] 为前缀，缺这个属性就会退回浏览器默认样式。
    node.setAttribute('data-dsh-studio', '')
    document.body.appendChild(node)
  }
  node.setAttribute('data-dsh-studio', '')
  node.setAttribute('data-theme', theme)
  return node
}
