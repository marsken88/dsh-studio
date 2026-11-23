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
import { SheetDrawer, SegGroup, TabsBar, Tip, ProgressBar, DialogBox } from './components/studio-ui.jsx'
import { Badge, Input, Textarea, Label } from './components/studio-ui.jsx'
import { Notification as BoarduiNotification } from './components/base/notification/notification'
import { Select as BoarduiSelect } from './boardui/index'
import { Toaster as BoarduiToaster, toast as boarduiToast } from './components/base/toast/toast'
import { portalRoot } from './lib/portal.js'

const STYLE_ID = 'dsh-studio-tw'

function injectStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = tailwindCss
  // Appended to <body> on purpose: the legacy panel injects its own <style>
  // (its hand-written rules) when the plugin applies, and equal-specificity
  // rules resolve in document order. Keeping ours last lets the token layer win.
  ;(document.body ?? document.head).appendChild(style)
}

/** 注册 id 必须等于**宿主给这个插件分配的模块 id**，否则工厂取不到：
 *   模块不实例化 → sidebar.panellist 不注册 → 侧栏没有入口（issue #3 的症状）。
 *
 *  这个 id 在不同安装方式下不一样：
 *   - npm / profile 安装：插件目录名就是包名，脚本地址是 /plugins/@marsken/dsh-studio/client.js
 *   - 本地目录挂载：目录名是 dsh-studio，脚本地址是 /plugins/dsh-studio/client.js
 *  所以运行时从自己的 script 地址里取，取不到再退回包名。写死任何一个都会在另一种安装方式下失效 ——
 *  0.9.0/0.9.1 写死短名，npm 装的用户面板整块不见。 */
function resolveModuleId() {
  /* 权威来源：宿主启动时写进页面的 window.__DSH_BOOT__.entries（每项是 { id, url, rev }）。
     id 就是宿主分配给插件的模块 id —— npm 装是包名，本地目录挂载是目录名，只有宿主知道。
     退路依次是：自己的 script 地址（/plugins/<id>/client.js）→ 包名。 */
  const boot = typeof window === 'undefined' ? null : window.__DSH_BOOT__
  const entries = Array.isArray(boot?.entries) ? boot.entries : []
  const tail = __STUDIO_PKG_NAME__.split('/').pop()
  const own = entries.find(entry => typeof entry?.url === 'string' && entry.url.includes('/' + tail + '/client.js'))
  if (own !== undefined && typeof own.id === 'string' && own.id !== '') return own.id

  const source = typeof document === 'undefined' ? '' : String(document.currentScript?.src ?? '')
  const at = source.indexOf('/plugins/')
  if (at < 0) return __STUDIO_PKG_NAME__
  // 地址形如 /plugins/??dsh-studio/client.js&rev=… 或 /plugins/??@scope/name/client.js&rev=…
  let rest = source.slice(at + '/plugins/'.length).replace(/^\?+/, '')
  const cut = rest.indexOf('/client.js')
  if (cut >= 0) rest = rest.slice(0, cut)
  if (rest.includes(',')) {
    const candidates = rest.split(',')
    rest = candidates.find(item => item.includes(tail)) ?? candidates[0]
  }
  rest = rest.replace(/^\/+/, '')
  return rest === '' ? __STUDIO_PKG_NAME__ : decodedURIComponentSafe(rest)
}

function decodedURIComponentSafe(value) {
  try { return decodeURIComponent(value) } catch { return value }
}

window.__ModuleLoader__.load({
  id: resolveModuleId(),
  factory(require) {
    injectStyles()

    const hostReact = require('react')
    // The legacy panel keeps using the React copy it was written against; that
    // copy ships inside this bundle, so hooks have a dispatcher even though the
    // host renders the bridge with its own React.
    // 原生 <select> → BoardUI Select：legacy 里还有 h('select', {...}, option…)
    // 这种写法（业务提单表单），补上之后全站就没有原生下拉了。
    const h = (type, props, ...children) => {
      if (type === 'select') {
        const options = []
        const collect = (nodes) => {
          React.Children.forEach(nodes, (child) => {
            if (!React.isValidElement(child)) return
            if (child.type === 'option') {
              options.push({ value: child.props.value ?? '', label: React.Children.toArray(child.props.children).join('') })
            } else if (child.type === 'optgroup') {
              collect(child.props.children)
            }
          })
        }
        collect(children)
        const { className, value, onChange, children: _children, ...restProps } = props ?? {}
        return React.createElement(BoarduiSelect, { ...restProps, className, options, value, onChange })
      }
      return React.createElement(type, props, ...children)
    }
    const studio = createStudio(React, h)
    // Hand the shadcn-based primitives to the legacy panel. It keeps its own
    // markup but swaps the high-traffic controls for the real components.
    const pushToast = (text, tone) => {
      const name = tone === 'error' ? 'error' : (tone === 'warn' || tone === 'warning') ? 'warning' : tone === 'info' ? 'info' : 'success'
      const fn = boarduiToast?.[name] ?? boarduiToast?.info ?? boarduiToast?.success
      if (typeof fn === 'function') fn(String(text))
    }
    const uiKit = { SegGroup, SheetDrawer, TabsBar, Tip, ProgressBar, DialogBox, Badge, Toaster: BoarduiToaster, portalRoot, pushToast, Input, Textarea, Label, Notification: BoarduiNotification }
    if (typeof studio.useUIKit === 'function') studio.useUIKit(uiKit)
    const StudioBridge = createBridge(studio, hostReact, { pageProps: { loginGate: ShadcnLoginGate, ui: uiKit } })

    return {
      inject: ['slots'],
      apply(ctx) {
        const disposers = []
        // 精选插件生态入口（与 legacy 手写半边的 installFeatured 同一份实现）：
        // 未装完整版时引导一键安装 dsh-featured，已装则让位，不会双 tab。
        if (typeof studio.installFeatured === 'function') {
          try { disposers.push(studio.installFeatured(ctx)) } catch (error) {
            console.error('[dsh-studio] featured entry failed to register', error)
          }
        }
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

// 原样引入的 BoardUI 组件（验证编译通道；后续按需替换 UI 时直接从这里 import）
import "./components/base/buttons/button";

// BoardUI 适配层（Button 等组件原样引入后在这里接线）
import "./boardui/index";

// 原样引入的 BoardUI 组件（验证编译通道）

import "./components/base/input/input";
import "./components/base/textarea/textarea";
import "./components/base/checkbox/checkbox";
