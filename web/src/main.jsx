// Bundled entry point.
//
// The shipped artifact must still look like the hand-written client.js to the
// host: `window.__ModuleLoader__.load({ id, factory })`. Everything else changed:
// React, Radix and Tailwind now come from this bundle instead of the page.
import * as React from 'react'
import tailwindCss from './index.css?inline'
import { createStudio } from './legacy.js'
import { createBridge } from './bridge.jsx'
import { ShadcnLoginGate } from './components/login-gate.jsx'
import { SheetDrawer, SegGroup, TabsBar, SelectBox, SwitchBox, Tip, ProgressBar, DialogBox } from './components/studio-ui.jsx'
import { Badge, Input, Textarea, Label, Tabs, TabsList, TabsTrigger } from './components/ui.jsx'

const STYLE_ID = 'dsh-studio-tw'

function injectStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = tailwindCss
  // Appended to <body> on purpose: the legacy panel injects its own <style>
  // (all the .ds-* rules) when the plugin applies, and equal-specificity rules
  // resolve in document order. Keeping ours last lets the token layer win.
  ;(document.body ?? document.head).appendChild(style)
}

window.__ModuleLoader__.load({
  id: 'dsh-studio',
  factory(require) {
    injectStyles()

    const hostReact = require('react')
    // The legacy panel keeps using the React copy it was written against; that
    // copy ships inside this bundle, so hooks have a dispatcher even though the
    // host renders the bridge with its own React.
    const studio = createStudio(React, React.createElement)
    // Hand the shadcn-based primitives to the legacy panel. It keeps its own
    // markup but swaps the high-traffic controls for the real components.
    const uiKit = { SegGroup, Tabs, TabsList, TabsTrigger, SheetDrawer, TabsBar, SelectBox, SwitchBox, Tip, ProgressBar, DialogBox, Badge, Input, Textarea, Label }
    if (typeof studio.useUIKit === 'function') studio.useUIKit(uiKit)
    const StudioBridge = createBridge(studio, hostReact, { pageProps: { loginGate: ShadcnLoginGate, ui: uiKit } })

    return {
      inject: ['slots'],
      apply(ctx) {
        const disposers = []
        disposers.push(ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: 'studio' }, StudioBridge,
        )))
        disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'studio', order: 12, label: () => '需求&任务工作空间' }, studio.StudioIcon,
        )))
        const cleanup = () => { for (const dispose of disposers.splice(0).reverse()) dispose() }
        if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
        return cleanup
      },
      StudioPage: studio.StudioPage,
      StudioIcon: studio.StudioIcon,
    }
  },
})
