/**
 * dsh-studio — browser half.
 *
 * Registers the Studio panel (sidebar row + central page) through the official
 * slot service: the host owns visibility, navigation and the row chrome; this
 * module only supplies the glyph and the page body.
 *
 * Plain ESM class-free artifact: the ModuleLoader hands us React from the page's
 * own module table, so no bundler and no second React copy are involved.
 */
window.__ModuleLoader__.load({
  id: 'dsh-studio',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const PANEL_ID = 'studio'
    const API = '/studio-api'

    // shadcn/ui 基础组件（由打包后的 main.jsx 注入）；单文件版本里保持 null，
    // 所有用到它的地方都带 legacy 兜底，所以两种产物行为一致。
    let UIKIT = null
    function useUIKit(next) { UIKIT = next ?? null }
    function kit(name) { return UIKIT === null ? null : (UIKIT[name] ?? null) }

    /* 关键按钮的悬停说明：有 UIKIT 用 Radix Tooltip，同时保留原生 title 兜底。 */
    function tipOf(label, node) {
      if (node === null || node === undefined) return node
      const props = node.props ?? {}
      const child = props.title !== undefined ? node : h(node.type, { ...props, title: label })
      const Tip = kit('Tip')
      return Tip === null ? child : h(Tip, { key: node.key, label }, child)
    }

    /* 表单适配层与共享抽屉已经搬到 web/src/studio，这边只负责把 h / kit 递进去。 */
    const { TextField, TextAreaField, ChipField, CheckField, SelectField } = createFields({ h, kit, React })
    const SideDrawer = createSideDrawer({ h, kit })
    const Editor = createEditor({ h, React })
    const Card = createCard({ h, ChipField })
    const Board = createBoard({ h, React, Card, TextField, SelectField, CheckField, toast })
    /* 字段标签的悬停说明：只给「不看说明容易填错」的字段加，鼠标移上去出气泡。 */
    /* Markdown 内容字段：左编辑右预览（切换式），底部写清支持哪些语法。
       需求正文 / 文档正文 / 交付物正文 / 技能正文 / 任务需求 / 功能点说明 统一走这里。 */
    function MdField({ rows = 6, value, onChange, placeholder, className, ...rest }) {
      const [preview, setPreview] = React.useState(false)
      const text = String(value ?? '')
      return h('div', { className: 'ds-md-field' },
        h('div', { className: 'ds-md-bar' },
          h('span', { className: 'ds-hint' }, '支持 Markdown：标题 / 列表 / 粗体 / 代码块 / 表格'),
          h('button', { className: 'ds-btn ds-btn-ghost', type: 'button', onClick: () => setPreview(!preview) }, preview ? '回到编辑' : '预览渲染'),
        ),
        preview
          ? h('div', { className: 'ds-md-preview ds-req-desc ds-md' }, text.trim() === '' ? h('span', { className: 'ds-hint' }, '还没写内容。') : renderMarkdown(text))
          : h(TextAreaField, { className: className ?? 'ds-textarea', rows, value, onChange, placeholder, ...rest }),
      )
    }

    function tipLabel(text, hint) {
      const node = h('div', { className: 'ds-label', style: { cursor: 'help' } }, text)
      return hint === undefined || hint === null || hint === '' ? node : tipOf(hint, node)
    }

    /* 表单控件的 shadcn 适配层。
       legacy 代码全是 h(SelectField, { className:'ds-select', value, onChange(e) }, option…)
       这类写法；有了 UIKIT 就换成 Radix 版本，没有就原样用原生控件（单文件产物）。 */




/* 徽章。legacy 写法是 h(ChipField, { className: 'ds-chip', ...rest }, 内容)；
       有 UIKIT 就渲染成 shadcn Badge（variant 按语义映射），没有就还是 span.ds-chip。 */

    /* 布尔开关。legacy 写法是 h(CheckField, { checked, onChange(e) })， */
    /* 换了 UIKIT 就渲染成 Radix Switch，没有就还是原生 checkbox。 */

    /* 进度条：有 UIKIT 用 Radix Progress，没有就回落原来的自绘条。 */

    /* 确认 / 输入：不用浏览器原生 confirm/prompt，改成页面里的 shadcn 弹窗。
       没有 UIKIT（单文件产物）时退回原生实现，调用方行为一致。 */
    let DIALOG_STATE = null
    let DIALOG_LISTENER = null

    function dialogEmit(next) {
      DIALOG_STATE = next
      if (typeof DIALOG_LISTENER === 'function') DIALOG_LISTENER(next)
    }

    function confirmDialog(message, options) {
      const opts = options ?? {}
      const Box = kit('DialogBox')
      if (Box === null) return Promise.resolve(window.confirm(String(message)))
      return new Promise(resolve => {
        dialogEmit({
          kind: 'confirm',
          title: opts.title ?? '确认操作',
          message: String(message ?? ''),
          danger: opts.danger === true,
          okText: opts.okText ?? '确定',
          cancelText: opts.cancelText ?? '取消',
          resolve,
        })
      })
    }

    function promptDialog(message, options) {
      const opts = options ?? {}
      const Box = kit('DialogBox')
      if (Box === null) return Promise.resolve(window.prompt(String(message), opts.defaultValue ?? ''))
      return new Promise(resolve => {
        dialogEmit({
          kind: 'prompt',
          title: opts.title ?? '需要填写',
          message: String(message ?? ''),
          value: String(opts.defaultValue ?? ''),
          placeholder: opts.placeholder ?? '',
          okText: opts.okText ?? '确定',
          cancelText: '取消',
          resolve,
        })
      })
    }

    /* 弹窗宿主：订阅 DIALOG_STATE，渲染成 shadcn Dialog。 */
    function DialogHost() {
      const [request, setRequest] = React.useState(null)
      const [text, setText] = React.useState('')
      React.useEffect(() => {
        const listen = next => {
          setRequest(next)
          setText(next !== null && next.kind === 'prompt' ? next.value : '')
        }
        DIALOG_LISTENER = listen
        if (DIALOG_STATE !== null) listen(DIALOG_STATE)
        return () => { if (DIALOG_LISTENER === listen) DIALOG_LISTENER = null }
      }, [])
      const Box = kit('DialogBox')
      if (request === null || Box === null) return null
      const finish = result => {
        const done = request.resolve
        setRequest(null)
        DIALOG_STATE = null
        done(result)
      }
      return h(Box, {
        open: true,
        title: request.title,
        message: request.message,
        danger: request.danger === true,
        okText: request.okText,
        cancelText: request.cancelText,
        input: request.kind === 'prompt',
        value: text,
        placeholder: request.placeholder,
        onChange: next => setText(next),
        onOk: () => finish(request.kind === 'prompt' ? text.trim() : true),
        onCancel: () => finish(request.kind === 'prompt' ? null : false),
      })
    }

    // --------------------------------------------------------------- 轻提示
    // 保存/同步这类动作结果原本只写在各面板自己的小字里，面板一滚就看不见了。
    // 这里加一个右下角堆叠的轻提示：3.2 秒自动消失，点 × 可提前关。
    let TOAST_SEQ = 0
    let TOAST_ITEMS = []
    let TOAST_LISTENERS = []
    // 同一动作可能一瞬间连发两条（重复绑定、onBlur 与 onClick 各触发一次），600ms 内同文案吞掉。
    let TOAST_LAST = { text: '', at: 0 }
    function toastEmit() {
      const items = TOAST_ITEMS.slice()
      for (const listen of TOAST_LISTENERS.slice()) listen(items)
    }
    function toast(text, tone = 'success', ttl = 3200) {
      const message = String(text ?? '').trim()
      if (message === '') return null
      const now = Date.now()
      if (TOAST_LAST.text === message && now - TOAST_LAST.at < 600) return null
      TOAST_LAST = { text: message, at: now }
      const id = ++TOAST_SEQ
      TOAST_ITEMS = TOAST_ITEMS.concat([{ id, text: message, tone }])
      toastEmit()
      window.setTimeout(() => { dismissToast(id) }, ttl)
      return id
    }
    function dismissToast(id) {
      const next = TOAST_ITEMS.filter(item => item.id !== id)
      if (next.length === TOAST_ITEMS.length) return
      TOAST_ITEMS = next
      toastEmit()
    }
    const TOAST_ICON = { success: '✓', error: '!', info: 'i' }
    /* 轻提示宿主：挂在 StudioPage 根部，跟 DialogHost 一样只订阅不持有业务状态。 */
    function ToastHost() {
      const [items, setItems] = React.useState(() => TOAST_ITEMS.slice())
      React.useEffect(() => {
        TOAST_LISTENERS.push(setItems)
        return () => { TOAST_LISTENERS = TOAST_LISTENERS.filter(entry => entry !== setItems) }
      }, [])
      if (items.length === 0) return null
      return h('div', { className: 'ds-toasts', role: 'status', 'aria-live': 'polite' },
        items.map(item => h('div', { key: item.id, className: 'ds-toast', 'data-tone': item.tone },
          h('span', { className: 'ds-toast-icon', 'aria-hidden': 'true' }, TOAST_ICON[item.tone] ?? 'i'),
          h('span', { className: 'ds-toast-text' }, item.text),
          h('button', {
            type: 'button', className: 'ds-toast-close', 'aria-label': '关闭提示',
            onClick: () => dismissToast(item.id),
          }, '×'),
        )),
      )
    }

    // --------------------------------------------------------------- 我是谁
    // 单机时代每个人共用一张 cookie，靠这个名字区分别人。写操作都会带在请求头里。
    const USER_KEY = 'dsh-studio:user'

    function currentUser() {
      try {
        const value = window.localStorage.getItem(USER_KEY)
        if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 40)
      } catch { /* 隐私模式 */ }
      return '人'
    }

    function setUserName(next) {
      const name = String(next ?? '').trim().slice(0, 40) || '人'
      try { window.localStorage.setItem(USER_KEY, name) } catch { /* 隐私模式 */ }
      return name
    }

    // --------------------------------------------------------------- 显示模式
    // 明亮 / 黑暗 / 跟随系统。这套配色本来就是从 currentColor 派生的（线、底、卡片都是
    // color-mix(currentColor N%, transparent)），所以只要在根元素上定住 color 与 background，
    // 再把 --ds-surface、--ds-accent 换掉，整块面板就会跟着换肤，不用逐条改样式。
    const THEME_KEY = 'dsh-studio:theme'
    const THEMES = [['light', '☀ 明亮'], ['dark', '☾ 黑暗'], ['system', '跟随系统']]

    function systemDarkQuery() {
      return typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
    }

    // 「跟随系统」实际跟的是「宿主界面」：面板长在宿主页面里，宿主自己是深色、我们跟操作系统就会出现
    // 一面白一面黑的接缝。宿主没给出明确信号（背景透明/取不到）时再退回操作系统的 prefers-color-scheme。
    function hostScheme() {
      try {
        const color = window.getComputedStyle(document.body).backgroundColor
        const matched = /rgba?\(([^)]+)\)/.exec(String(color ?? ''))
        if (matched === null) return null
        const parts = matched[1].split(',').map(value => Number(value.trim()))
        const [r, g, b, a] = parts
        if (![r, g, b].every(value => Number.isFinite(value))) return null
        if (Number.isFinite(a) && a < 0.2) return null
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128 ? 'dark' : 'light'
      } catch {
        return null
      }
    }

    function currentTheme() {
      try {
        const value = window.localStorage.getItem(THEME_KEY)
        if (value === 'light' || value === 'dark' || value === 'system') return value
      } catch { /* 隐私模式 */ }
      return 'system'
    }

    function setThemeName(next) {
      const value = next === 'light' || next === 'dark' ? next : 'system'
      try { window.localStorage.setItem(THEME_KEY, value) } catch { /* 隐私模式 */ }
      return value
    }

    // --------------------------------------------------------------- 登录态
    // 统一登录（LDAP）开启后，服务端会给一个会话 token；放在 localStorage 里，
    // 每次请求带 x-studio-session。名字也一并记下来，用于「我是谁」和审计。
    const SESSION_KEY = 'dsh-studio:session'
    const AUTH_USER_KEY = 'dsh-studio:auth-user'

    function sessionToken() {
      try {
        const value = window.localStorage.getItem(SESSION_KEY)
        if (typeof value === 'string' && value.trim() !== '') return value.trim()
      } catch { /* 隐私模式 */ }
      return ''
    }

    function setSessionToken(next) {
      try {
        if (next === '' || next === null || next === undefined) window.localStorage.removeItem(SESSION_KEY)
        else window.localStorage.setItem(SESSION_KEY, String(next))
      } catch { /* 隐私模式 */ }
    }

    function authUser() {
      try {
        const raw = window.localStorage.getItem(AUTH_USER_KEY)
        if (typeof raw === 'string' && raw !== '') {
          const parsed = JSON.parse(raw)
          if (parsed !== null && typeof parsed === 'object') return parsed
        }
      } catch { /* 隐私模式 */ }
      return null
    }

    function setAuthUser(next) {
      try {
        if (next === null || next === undefined) window.localStorage.removeItem(AUTH_USER_KEY)
        else window.localStorage.setItem(AUTH_USER_KEY, JSON.stringify(next))
      } catch { /* 隐私模式 */ }
      return next ?? null
    }

    // ------------------------------------------------------------------ api

    async function api(path, body) {
      const headers = { 'x-studio-user': encodeURIComponent(currentUser()) }
      const token = sessionToken()
      if (token !== '') headers['x-studio-session'] = token
      if (body !== undefined) headers['content-type'] = 'application/json'
      const init = body === undefined
        ? { method: 'GET', headers }
        : { method: 'POST', headers, body: JSON.stringify(body) }
      const response = await fetch(API + path, init)
      let payload = {}
      try { payload = await response.json() } catch { /* non-JSON error page */ }
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error ?? `请求失败（HTTP ${response.status}）`)
      }
      return payload
    }

    // ---------------------------------------------------------------- style

    const GLOBAL_THEME_CSS = `
html[data-dsh-theme="dark"] body { background: #0e1014 !important; color: #e6e8ee }
html[data-dsh-theme="dark"] [class*="frame"],
html[data-dsh-theme="dark"] [class*="centerCol"],
html[data-dsh-theme="dark"] [class*="mainPanel"] { background: #0e1014 !important; color: #e6e8ee }
html[data-dsh-theme="dark"] [class*="sidebarCol"],
html[data-dsh-theme="dark"] [class*="rightbarCol"] { background: #0a0b0f !important; color: #d7dae0 !important; border-color: #22262e !important }
html[data-dsh-theme="dark"] [class*="sidebarCol"] a,
html[data-dsh-theme="dark"] [class*="sidebarCol"] button,
html[data-dsh-theme="dark"] [class*="sidebarCol"] span,
html[data-dsh-theme="dark"] [class*="sidebarCol"] div { color: inherit }
html[data-dsh-theme="dark"] [class*="handle"] { background: #22262e !important }
html[data-dsh-theme="light"] body { background: #ffffff !important; color: #1f2328 }
html[data-dsh-theme="light"] [class*="sidebarCol"],
html[data-dsh-theme="light"] [class*="rightbarCol"] { background: #fafafa !important; color: #1f2328 !important; border-color: #e4e4e7 !important }
`
    const CSS = `
[data-dsh-studio] { display:flex; flex-direction:column; height:100%; min-height:0; color:currentColor;
  --ds-line: color-mix(in srgb, currentColor 18%, transparent);
  --ds-line-soft: color-mix(in srgb, currentColor 9%, transparent);
  --ds-soft: color-mix(in srgb, currentColor 5%, transparent);
  --ds-soft2: color-mix(in srgb, currentColor 10%, transparent);
  --ds-bg: #ffffff;
  --ds-surface: #ffffff;
  --ds-surface-2: #ffffff;
  --ds-card: var(--ds-surface);
  --ds-shadow: none;
  --ds-accent: #2f6feb;
  font: 13px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
/* 三档显示模式：只换根元素的 color / background 与一组表面色，其余靠 color-mix 自动派生。
   color-scheme 必须一起改，否则 <select>/<input>/滚动条仍按操作系统的深浅色画。
   表面层次：--ds-bg（页面底）< --ds-surface-2（列/次级块）< --ds-surface（面板/卡片）。 */
[data-dsh-studio][data-theme="light"] {
  color-scheme:light; color:#1f2328; background:var(--ds-bg); --ds-accent:#2f6feb;
  --ds-bg:#eef1f5; --ds-surface:#ffffff; --ds-surface-2:#f6f8fb; --ds-card:#ffffff;
  --ds-line:#dbe1ea; --ds-line-soft:#e9edf3;
  --ds-shadow:0 1px 2px #0f172a0f;
}
[data-dsh-studio][data-theme="dark"] {
  color-scheme:dark; color:#e6e8ee; background:var(--ds-bg); --ds-accent:#7ba2ff;
  --ds-bg:#0e1014; --ds-surface:#181b22; --ds-surface-2:#1e222a; --ds-card:#181b22;
  --ds-line:#2c323d; --ds-line-soft:#232830;
  --ds-shadow:0 1px 2px #00000040;
}
[data-dsh-studio][data-theme="light"] .ds-chip[data-review="changes_requested"] { color:#b3282c; }
[data-dsh-studio][data-theme="dark"] .ds-chip[data-review="changes_requested"] { color:#ff9a9d; }
/* 深色下把几处「深色语义色」换成浅色版本：它们在白底上是 4.6:1，到了 #14161b 上只有 2.5–3.9:1，
   11–12px 的小字会糊。只改前景色，底色与边框仍由各规则自己算。 */
[data-dsh-studio][data-theme="dark"] .ds-blocked-line,
[data-dsh-studio][data-theme="dark"] .ds-blocked-box,
[data-dsh-studio][data-theme="dark"] .ds-chip-bug,
[data-dsh-studio][data-theme="dark"] .ds-chip-bug[data-sev="p1"],
[data-dsh-studio][data-theme="dark"] .ds-error,
[data-dsh-studio][data-theme="dark"] .ds-gate-item[data-kind="block"] { color:#ff9a9d; }
[data-dsh-studio][data-theme="dark"] .ds-chip-bug[data-sev="p0"] { color:#fff; }
[data-dsh-studio][data-theme="dark"] .ds-chip[data-review="approved"],
[data-dsh-studio][data-theme="dark"] .ds-chip[data-sla="ok"],
[data-dsh-studio][data-theme="dark"] .ds-ok { color:#6fdca4; }
[data-dsh-studio][data-theme="dark"] .ds-chip[data-sla="due_soon"],
[data-dsh-studio][data-theme="dark"] .ds-gate-item[data-kind="warn"] { color:#f0b552; }
[data-dsh-studio][data-theme="dark"] .ds-skilldesc { color:color-mix(in srgb, currentColor 62%, transparent); }
/* 键盘焦点：所有可聚焦元素统一用主题色描边（原来是浏览器默认蓝，深色下很跳）。 */
[data-dsh-studio] :focus-visible { outline:2px solid var(--ds-accent); outline-offset:2px; border-radius:4px; }
[data-dsh-studio] * { box-sizing:border-box; }
.ds-head { flex:none; border-bottom:1px solid var(--ds-line); padding:12px 18px 0;
  background:var(--ds-surface); box-shadow:var(--ds-shadow); }
.ds-head-top { display:flex; align-items:flex-start; gap:14px; padding-bottom:10px; }
.ds-brand { display:flex; align-items:center; gap:10px; min-width:0; }
.ds-brand-mark { width:26px; height:26px; border-radius:8px; flex:none; display:flex; align-items:center; justify-content:center;
  background:color-mix(in srgb, var(--ds-accent) 14%, transparent); color:var(--ds-accent); font-size:13px; }
.ds-head-actions { margin-left:auto; display:flex; align-items:center; gap:8px; flex:none; }
.ds-head-tabs { display:flex; align-items:center; flex-wrap:wrap; row-gap:6px; gap:10px; padding-bottom:9px; }
.ds-title { font-size:15px; font-weight:650; letter-spacing:.01em; }
.ds-sub { font-size:11.5px; opacity:.55; }
.ds-tabs { display:inline-flex; gap:2px; padding:3px; border-radius:9px; background:var(--ds-soft); border:1px solid var(--ds-line);
  max-width:100%; overflow-x:auto; scrollbar-width:none; }
.ds-tabs::-webkit-scrollbar { height:0; }
.ds-seg { display:inline-flex; gap:2px; padding:3px; border-radius:9px; background:var(--ds-soft); border:1px solid var(--ds-line); }
.ds-seg-btn { border:0; background:transparent; color:inherit; font:inherit; font-size:11.5px; padding:4px 9px; border-radius:6px;
  cursor:pointer; opacity:.7; white-space:nowrap; }
.ds-seg-btn:hover { opacity:1; background:var(--ds-soft2); }
.ds-seg-btn[data-on="1"] { opacity:1; font-weight:600; background:color-mix(in srgb, currentColor 14%, transparent); }
.ds-tab { border:0; background:transparent; color:inherit; font:inherit; font-size:12.5px; padding:4px 15px; border-radius:7px;
  cursor:pointer; opacity:.62; white-space:nowrap; flex:0 0 auto; }
.ds-tab:hover { opacity:.95; background:var(--ds-soft2); }
.ds-tab[data-on="1"] { opacity:1; background:var(--ds-surface); font-weight:600; box-shadow:0 1px 3px #00000026; }
.ds-grow { flex:1; }
.ds-btn { border:1px solid var(--ds-line); background:var(--ds-soft); color:inherit; font:inherit; padding:5px 12px; border-radius:7px; cursor:pointer; }
.ds-btn:hover { background:var(--ds-soft2); }
.ds-btn[disabled] { opacity:.45; cursor:default; }
.ds-btn-primary { background:var(--ds-accent); border-color:var(--ds-accent); color:#fff; }
.ds-btn-primary:hover { filter:brightness(1.08); background:var(--ds-accent); }
.ds-board-bar { display:flex; gap:8px; align-items:center; padding:9px 16px; flex-wrap:wrap; flex:none;
  border-bottom:1px solid var(--ds-line); }
.ds-board-bar .ds-input, .ds-board-bar .ds-select { height:28px; padding:0 8px; }
.ds-search { position:relative; display:inline-flex; }
.ds-search .ds-input { padding-left:24px; }
.ds-search::before { content:'⌕'; position:absolute; left:7px; top:50%; transform:translateY(-50%);
  opacity:.4; font-size:13px; pointer-events:none; }
.ds-stat { font-size:11.5px; opacity:.55; }
.ds-market-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }
.ds-market-card { display:flex; flex-direction:column; gap:8px; border:1px solid var(--ds-line); border-radius:12px;
  padding:14px; background:var(--ds-card); min-height:136px; }
.ds-mc-head { display:flex; align-items:center; gap:8px; }
.ds-mc-name { font-weight:600; font-size:13px; }
.ds-mc-desc { font-size:12px; opacity:.72; }
.ds-market-card code { font-size:11px; opacity:.55; word-break:break-all; }
.ds-chip[data-on="1"] { color:#0f9d58; border-color:#0f9d5855; }
.ds-board { display:flex; gap:12px; padding:12px 16px 16px; overflow-x:auto; overflow-y:hidden; flex:1; min-height:0; align-items:stretch; }
.ds-col { flex:0 0 282px; display:flex; flex-direction:column; min-height:0; border:1px solid var(--ds-line); border-radius:12px;
  background:var(--ds-surface-2); overflow:hidden; }
.ds-col[data-role="product"] { border-top:2px solid #2f6feb; }
.ds-col[data-role="architect"] { border-top:2px solid #8b5cf6; }
.ds-col[data-role="dev"] { border-top:2px solid #0f9d58; }
.ds-col[data-role="qa"] { border-top:2px solid #e08600; }
.ds-col-head { display:flex; align-items:center; gap:6px; padding:9px 11px; border-bottom:1px solid var(--ds-line); font-weight:600; font-size:12px; flex:none; background:var(--ds-card); }
.ds-count { margin-left:auto; min-width:20px; text-align:center; border-radius:999px; padding:0 7px; line-height:17px;
  background:var(--ds-soft2); border:1px solid var(--ds-line); font-weight:600; font-size:10.5px; font-variant-numeric:tabular-nums; }
.ds-count[data-zero="1"] { opacity:.4; }
.ds-col-owner { padding:0 11px 7px; font-size:10.5px; opacity:.55; flex:none; }
.ds-col-body { display:flex; flex-direction:column; gap:8px; padding:9px; overflow-y:auto; flex:1; min-height:0; }
.ds-card { border:1px solid var(--ds-line); border-radius:9px; background:var(--ds-surface); padding:9px 10px; cursor:pointer;
  box-shadow:var(--ds-shadow);
  display:flex; flex-direction:column; gap:6px; transition:transform .12s ease, border-color .12s ease, box-shadow .12s ease; }
.ds-card:hover { border-color:var(--ds-accent); transform:translateY(-1px); box-shadow:0 4px 14px #00000014; }
.ds-card[data-urgent="1"] { border-left:3px solid #e5484d; padding-left:8px; }
.ds-card[data-running="1"] { border-color:var(--ds-accent); }
.ds-card[data-blocked="1"] { border-color:#e5484d80; background:color-mix(in srgb, #e5484d 4%, var(--ds-surface)); box-shadow:inset 3px 0 0 #e5484d; }
.ds-blocked-line { font-size:11px; color:#c0392b; line-height:1.4; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.ds-blocked-box { border:1px solid #e5484d55; background:color-mix(in srgb, #e5484d 7%, transparent); border-radius:8px; padding:9px 11px; display:flex; flex-direction:column; gap:3px; font-size:12px; color:#c0392b; }
.ds-chip[data-proj="1"] { color:var(--ds-accent); border-color:color-mix(in srgb, var(--ds-accent) 40%, transparent); font-weight:600; cursor:pointer; }
.ds-chip[data-req="1"] { color:#7c4dff; border-color:color-mix(in srgb, #7c4dff 36%, transparent); background:color-mix(in srgb, #7c4dff 8%, transparent); cursor:pointer; }
.ds-chip[data-req-missing="1"] { border-style:dashed; opacity:.62; cursor:pointer; }
.ds-chip[data-iter="1"] { opacity:.8; }
.ds-check-progress { margin:2px 0 4px; }
.ds-code-box { border:1px solid var(--ds-line); border-radius:8px; padding:10px 12px; background:var(--ds-card); display:flex; flex-direction:column; gap:8px; }
.ds-code-head { display:flex; align-items:flex-start; gap:8px; }
.ds-code-line { font-size:12.5px; font-weight:600; }
.ds-code-list { display:flex; flex-direction:column; gap:3px; }
.ds-code-item { display:flex; align-items:center; gap:8px; font-size:11.5px; }
.ds-code-item code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; padding:1px 5px; border-radius:4px; background:var(--ds-soft2); color:inherit; }
.ds-code-files { display:flex; flex-wrap:wrap; gap:4px; }
.ds-code-file { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; padding:2px 6px; border-radius:5px; background:var(--ds-soft2); color:inherit; }
.ds-code-file[data-change="added"] { box-shadow:inset 2px 0 0 #0f9d58; }
.ds-code-file[data-change="deleted"] { box-shadow:inset 2px 0 0 #e5484d; }
.ds-code-file[data-change="modified"] { box-shadow:inset 2px 0 0 #d97706; }
.ds-code-note { font-size:12px; padding:6px 8px; border-radius:6px; background:color-mix(in srgb, #e5484d 8%, transparent); }
.ds-chip[data-review="approved"] { background:color-mix(in srgb, #0f9d58 16%, transparent); color:#0f6b3c; }
.ds-chip[data-review="changes_requested"] { background:color-mix(in srgb, #e5484d 16%, transparent); color:#a3282b; }
.ds-check-bar { height:6px; border-radius:999px; background:var(--ds-soft2); overflow:hidden; }
.ds-check-bar > span { display:block; height:100%; background:var(--ds-accent); transition:width .2s ease; }
.ds-check-bar[data-full="1"] > span { background:#0f9d58; }
.ds-check-row { display:flex; align-items:flex-start; gap:9px; padding:7px 0; border-bottom:1px solid var(--ds-line); }
.ds-check-row:last-of-type { border-bottom:none; }
.ds-check-row input[type="checkbox"] { margin-top:2px; width:14px; height:14px; accent-color:var(--ds-accent); flex:0 0 auto; }
.ds-check-text { font-size:12px; line-height:1.5; }
.ds-check-row[data-done="1"] .ds-check-text { text-decoration:line-through; opacity:.55; }
.ds-art-row { display:flex; align-items:center; gap:9px; padding:8px 0; border-bottom:1px solid var(--ds-line); }
.ds-art-row:last-of-type { border-bottom:none; }
.ds-art-row[data-result="fail"] { background: color-mix(in srgb, #e5484d 8%, transparent); border-left:3px solid #e5484d; }
.ds-art-row[data-result="pass"] { border-left:3px solid #0f9d58; }
.ds-art-row[data-result="pending"], .ds-art-row[data-result="skip"] { border-left:3px solid color-mix(in srgb, currentColor 22%, transparent); }
.ds-chip-case { font-size:10.5px; font-weight:600; padding:1px 6px; border-radius:9px; white-space:nowrap; border:1px solid; }
.ds-chip-case[data-r="pass"] { color:#0f9d58; border-color:#0f9d5855; background:#0f9d5812; }
.ds-chip-case[data-r="fail"] { color:#e5484d; border-color:#e5484d55; background:#e5484d12; }
.ds-chip-case[data-r="pending"], .ds-chip-case[data-r="skip"] { opacity:.6; }
.ds-art-title { font-size:12px; font-weight:600; line-height:1.4; }
.ds-art-ref { font-size:11px; opacity:.6; word-break:break-all; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
.ds-chip[data-kind="mr"] { color:#8b5cf6; border-color:#8b5cf655; }
.ds-chip[data-kind="cases"] { color:#e08600; border-color:#e0860055; }
.ds-chip[data-kind="design"] { color:#0f9d58; border-color:#0f9d5855; }
.ds-btn-ghost { background:transparent; border-color:transparent; color:inherit; opacity:.45; padding:2px 6px; }
.ds-btn-ghost:hover { opacity:.9; }
.ds-proj-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(330px,1fr)); gap:14px; }
.ds-proj-card { border:1px solid var(--ds-line); border-radius:10px; background:var(--ds-card); padding:14px 15px; display:flex; flex-direction:column; gap:10px; }
.ds-proj-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
.ds-proj-name { font-size:13.5px; font-weight:600; }
.ds-proj-stats { display:grid; grid-template-columns:repeat(3,1fr); gap:8px 12px; }
.ds-proj-stats > div { display:flex; flex-direction:column; }
.ds-proj-stats b { font-size:16px; font-weight:650; line-height:1.2; }
.ds-proj-stats b[data-warn="1"] { color:#e5484d; }
.ds-proj-stats span { font-size:11px; opacity:.6; }
.ds-proj-bar { margin-top:2px; }
.ds-card-title { font-size:12.5px; font-weight:600; line-height:1.45; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.ds-card-foot { display:flex; align-items:center; gap:6px; font-size:10.5px; opacity:.5; }
.ds-meta { display:flex; flex-wrap:wrap; gap:4px; align-items:center; font-size:10.5px; opacity:.75; }
.ds-chip { border:1px solid var(--ds-line); border-radius:999px; padding:0 6px; line-height:16px; }
.ds-chip-soft { background: var(--ds-soft2); border-color: transparent; margin-left: 6px; }
.ds-audit-row { display:grid; grid-template-columns: 64px 88px 120px minmax(0,1fr) 66px; align-items:center; gap:8px;
  padding:6px 0; border-bottom:1px solid var(--ds-line); font-size:12px; }
.ds-audit-row:last-child { border-bottom:none; }
.ds-audit-row[data-ok="0"] { background: color-mix(in srgb, #e5484d 5%, transparent); }
.ds-audit-time { color: color-mix(in srgb, currentColor 58%, transparent); font-variant-numeric: tabular-nums; }
.ds-audit-by { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ds-audit-what { color: color-mix(in srgb, currentColor 82%, transparent); }
.ds-audit-detail { color: color-mix(in srgb, currentColor 56%, transparent); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  font-family: ui-monospace, Menlo, monospace; font-size:11px; }
.ds-audit-status { text-align:right; font-size:11px; font-weight:600; color:#0f9d58; }
.ds-audit-status[data-ok="0"] { color:#e5484d; }
@media (max-width:760px) { .ds-audit-row { grid-template-columns: 60px 1fr 60px; } .ds-audit-what, .ds-audit-detail { display:none; } }
.ds-kpi-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
@media (max-width:900px) { .ds-kpi-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media (max-width:560px) { .ds-kpi-grid { grid-template-columns:minmax(0,1fr); } }
.ds-kpi { position:relative; overflow:hidden; border:1px solid var(--ds-line); border-radius:10px; padding:11px 13px 12px; background:var(--ds-card); box-shadow:var(--ds-shadow), inset 3px 0 0 color-mix(in srgb, var(--ds-accent) 55%, transparent); }
.ds-kpi[data-warn="1"] { border-color: color-mix(in srgb, #e5484d 40%, var(--ds-line)); box-shadow:inset 3px 0 0 color-mix(in srgb, #e5484d 70%, transparent); }
.ds-kpi-value { font-size:23px; font-weight:650; letter-spacing:-.02em; line-height:1.15; }
.ds-kpi[data-warn="1"] .ds-kpi-value { color:#e5484d; }
.ds-kpi-label { font-size:12px; font-weight:600; margin-top:1px; }
.ds-kpi-hint { font-size:11px; opacity:.6; margin-top:3px; line-height:1.45; }
/* 效能页：12 栅格显式排版。原来用 auto-fit 撑满，四块面板挤在一行、每块只有 290px，
   柱条被压成发丝、数字挤成一坨；现在每块自己声明占几列，窄屏逐级退成 6 → 12 列。 */
.ds-an-grid { display:grid; grid-template-columns:repeat(12,minmax(0,1fr)); gap:12px; align-items:start; }
.ds-an-grid > .ds-panel { display:flex; flex-direction:column; min-width:0; }
.ds-an-grid > .ds-panel > .ds-panel-body { flex:0 1 auto; }
.ds-span-3 { grid-column:span 3; }
.ds-span-4 { grid-column:span 4; }
.ds-span-5 { grid-column:span 5; }
.ds-span-6 { grid-column:span 6; }
.ds-span-7 { grid-column:span 7; }
.ds-span-8 { grid-column:span 8; }
.ds-span-9 { grid-column:span 9; }
.ds-span-12 { grid-column:span 12; }
@media (max-width:1180px) { .ds-span-3, .ds-span-4, .ds-span-5 { grid-column:span 6; } .ds-span-7, .ds-span-8, .ds-span-9 { grid-column:span 12; } }
@media (max-width:760px) { .ds-an-grid > .ds-panel { grid-column:span 12; } }
.ds-an-sec { display:flex; align-items:baseline; gap:10px; margin:6px 0 -2px; padding-bottom:2px; font-size:12px; font-weight:600; letter-spacing:.02em; opacity:.8; }
.ds-an-sec .ds-hint { margin-left:auto; font-weight:400; opacity:.75; }
/* 栅格里已由 gap 控制间距，panel 自带的 margin-bottom 会把行高顶歪 */
.ds-an-grid > .ds-panel { margin-bottom:0; }
/* 面板底部小注：贴底，用来把「多高都行」的面板补满，不至于下面留一大片空白 */
.ds-an-foot { margin-top:9px; padding-top:8px; border-top:1px dashed var(--ds-line); font-size:11.5px; opacity:.62; line-height:1.5; }
.ds-an-row { display:grid; grid-template-columns:106px minmax(0,1fr) 84px; align-items:center; gap:9px; padding:5px 0; font-size:12px; }
.ds-an-name { opacity:.8; }
.ds-an-track { height:8px; border-radius:999px; background:var(--ds-soft2); overflow:hidden; }
.ds-an-fill { height:100%; border-radius:999px; background:var(--ds-accent); }
.ds-an-fill-warn { background:#d97706; }
.ds-an-num { text-align:right; font-variant-numeric:tabular-nums; opacity:.75; }
.ds-an-kv { display:flex; align-items:baseline; justify-content:space-between; gap:10px; padding:4px 0; border-bottom:1px dashed var(--ds-line); font-size:12px; }
.ds-an-kv:last-child { border-bottom:none; }
.ds-an-kv b[data-warn="1"] { color:#e5484d; }
.ds-spark { display:flex; align-items:flex-end; gap:4px; height:78px; padding-top:6px; border-bottom:1px solid var(--ds-line); }
.ds-spark-col { flex:1 1 0; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; gap:4px; height:100%; }
.ds-spark-bar { width:70%; min-height:2px; border-radius:3px 3px 0 0; background:color-mix(in srgb, var(--ds-accent) 70%, transparent); }
.ds-spark-day { font-size:9.5px; opacity:.5; white-space:nowrap; height:12px; }
.ds-chip[data-role="product"] { color:#2f6feb; border-color:#2f6feb55; }
.ds-chip[data-role="architect"] { color:#8b5cf6; border-color:#8b5cf655; }
.ds-chip[data-role="dev"] { color:#0f9d58; border-color:#0f9d5855; }
.ds-chip[data-role="qa"] { color:#e08600; border-color:#e0860055; }
.ds-chip-ai { color:var(--ds-accent); border-color:var(--ds-accent); animation: ds-pulse 1.6s ease-in-out infinite; }
.ds-chip-blocked { color:#fff; background:#e5484d; border-color:#e5484d; font-weight:650; }
.ds-card-warn { color:#e5484d; font-size:10.5px; font-weight:600; white-space:nowrap; }
.ds-case-fail { color:#e5484d; font-weight:600; }
.ds-card[data-nobody="1"] .ds-card-warn { animation: ds-pulse 2.2s ease-in-out infinite; }
.ds-card[data-nobody="1"] { border-color: color-mix(in srgb, #e5484d 42%, var(--ds-line)); }
.ds-art-row[data-missing="1"] { background: color-mix(in srgb, #e5484d 5%, transparent); }
.ds-chip-bug { color:#c0392b; border-color:#c0392b66; background:color-mix(in srgb, #c0392b 8%, transparent); font-weight:650; }
.ds-chip-bug[data-sev="p0"] { color:#fff; background:#c0392b; border-color:#c0392b; }
.ds-chip-bug[data-sev="p1"] { color:#c0392b; background:color-mix(in srgb, #c0392b 16%, transparent); }
.ds-chip[data-sla="overdue"] { color:#fff; background:#e5484d; border-color:#e5484d; font-weight:650; }
.ds-chip[data-sla="due_soon"] { color:#b45309; border-color:#b4530966; background:color-mix(in srgb, #d97706 12%, transparent); }
.ds-chip[data-sla="ok"] { color:#137a4b; border-color:#137a4b55; background:color-mix(in srgb, #0f9d58 8%, transparent); }
.ds-smoke-done { color:color-mix(in srgb, currentColor 55%, transparent); text-decoration:line-through; }
@keyframes ds-pulse { 0%,100% { opacity:.45 } 50% { opacity:1 } }
.ds-dot { width:6px; height:6px; border-radius:50%; display:inline-block; }
.ds-dot[data-p="urgent"] { background:#e5484d; }
.ds-dot[data-p="normal"] { background:#8a8f98; }
.ds-dot[data-p="relaxed"] { background:#4b7bec55; }
.ds-empty { opacity:.4; font-size:11.5px; padding:14px 8px; text-align:center; border:1px dashed var(--ds-line); border-radius:8px; }
.ds-body { flex:1; min-height:0; overflow:auto; padding:16px 18px; }
.ds-panel { border:1px solid var(--ds-line); border-radius:10px; overflow:hidden; margin-bottom:14px; background:var(--ds-card);
  box-shadow:var(--ds-shadow); }
.ds-panel-head { padding:11px 15px; border-bottom:1px solid var(--ds-line); font-weight:600; font-size:12.5px; display:flex; align-items:center; gap:10px; justify-content:space-between; }
.ds-panel-head > .ds-hint { font-weight:400; }
/* Panel bodies stack by default: one field or one list row per line, never a mosaic. */
.ds-panel-body { padding:14px 15px; display:flex; flex-direction:column; gap:12px; min-width:0; }
.ds-panel-body > .ds-row { min-width:0; }
.ds-panel-body > .ds-row > .ds-field { min-width:0; }
/* Two-or-more column body, only where the content really is a set of short fields. */
.ds-panel-body.ds-grid2 { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px 18px; align-items:start; }
.ds-panel-body.ds-grid4 { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px 16px; align-items:start; }
@media (max-width: 1080px) { .ds-panel-body.ds-grid4 { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media (max-width: 660px) { .ds-panel-body.ds-grid2, .ds-panel-body.ds-grid4 { grid-template-columns:1fr; } }
.ds-panel-body.ds-grid2 > .ds-span, .ds-panel-body.ds-grid4 > .ds-span { grid-column:1 / -1; }
.ds-list { display:flex; flex-direction:column; gap:0; }
.ds-listrow { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; padding:11px 0;
  border-bottom:1px solid var(--ds-line); }
.ds-listrow:last-child { border-bottom:0; padding-bottom:2px; }
.ds-listrow-main { min-width:0; flex:1 1 auto; display:flex; flex-direction:column; gap:3px; }
.ds-listrow-main > div:first-child { font-size:12.5px; font-weight:600; display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.ds-listrow-actions { display:flex; gap:6px; flex:0 0 auto; align-items:center; }
/* Edit forms: keep the field grid readable instead of stretching inputs across the pane. */
.ds-pane-stack { display:flex; flex-direction:column; gap:12px; }
.ds-pane-stack > .ds-panel { margin-bottom:0; }
.ds-pane-stack > .ds-form-panel { order:-1; }
/* Right-side editor drawer: keep the list in view while editing one record. */
.ds-side-wrap { position:fixed; inset:0; z-index:80; display:flex; justify-content:flex-end; }
.ds-side-mask { position:absolute; inset:0; background:rgba(15,18,25,.42); }
.ds-side { position:relative; display:flex; flex-direction:column; width:min(760px,96vw); height:100%; background:var(--ds-surface); color:inherit; border-left:1px solid var(--ds-line); box-shadow:-18px 0 48px rgba(0,0,0,.18); }
.ds-side-head { flex:0 0 auto; display:flex; align-items:flex-start; justify-content:space-between; gap:12px; padding:14px 18px 12px; border-bottom:1px solid var(--ds-line); }
.ds-side-title { font-size:15px; font-weight:600; }
.ds-side-body { flex:1 1 auto; min-height:0; overflow-y:auto; padding:16px 18px 20px; display:flex; flex-direction:column; gap:16px; }
.ds-side-foot { flex:0 0 auto; display:flex; align-items:center; gap:8px; padding:12px 18px; border-top:1px solid var(--ds-line); background:var(--ds-card); }
.ds-side-note { margin-left:auto; }
.ds-emoji-preview { font-size:30px; line-height:1.2; padding:6px 0; text-align:center; background:var(--ds-soft); border:1px solid var(--ds-line); border-radius:8px; }
.ds-emojigrid { display:grid; grid-template-columns:repeat(auto-fill,minmax(36px,1fr)); gap:4px; }
.ds-emoji { font-size:17px; line-height:1; padding:6px 0; border:1px solid var(--ds-line); border-radius:8px; background:var(--ds-soft); cursor:pointer; }
.ds-emoji:hover { background:var(--ds-soft2); }
.ds-emoji[data-on="1"] { border-color:var(--ds-accent); background:color-mix(in srgb, var(--ds-accent) 12%, transparent); box-shadow:0 0 0 2px color-mix(in srgb, var(--ds-accent) 22%, transparent); }
@media (max-width:760px) { .ds-side { width:100%; } }
.ds-form-panel { max-width:880px; }
.ds-form-panel .ds-panel-body > .ds-row { align-items:flex-start; }
.ds-form-panel .ds-panel-body > .ds-row:last-child { border-top:1px solid var(--ds-line); padding-top:12px; margin-top:2px; }
.ds-form-panel .ds-panel-body > .ds-row:last-child .ds-btn-primary { min-width:88px; }
/* Settings: a fixed section rail plus one pane, instead of one long scroll. */
.ds-settings { display:grid; grid-template-columns:186px minmax(0,1fr); gap:18px; align-items:start; width:100%; }
.ds-settings-nav { position:sticky; top:8px; display:flex; flex-direction:column; gap:1px;
  border-right:1px solid var(--ds-line); padding:0 10px 10px 0; }
.ds-settings-nav-group { font-size:10px; letter-spacing:.08em; opacity:.45; padding:10px 10px 4px; }
.ds-nav-item { display:flex; align-items:center; gap:8px; width:100%; text-align:left; font:inherit; color:inherit;
  border:0; background:none; padding:7px 10px; border-radius:8px; cursor:pointer; font-size:12.5px; line-height:1.2; }
.ds-nav-item:hover { background:var(--ds-soft2); }
.ds-nav-item[data-active="1"] { background:var(--ds-accent); color:#fff; }
.ds-nav-item[data-active="1"] .ds-nav-count { opacity:.85; }
.ds-nav-count { margin-left:auto; font-size:10.5px; opacity:.5; font-variant-numeric:tabular-nums; }
.ds-settings-pane { min-width:0; width:100%; max-width:1060px; padding-bottom:24px; }
.ds-pane-head { margin:0 0 14px; display:flex; align-items:flex-end; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.ds-pane-title { font-size:13.5px; font-weight:650; letter-spacing:.01em; }
.ds-pane-desc { font-size:11px; opacity:.55; margin-top:3px; max-width:62ch; line-height:1.55; }
.ds-settings-pane > .ds-panel:last-child { margin-bottom:0; }
@media (max-width: 760px) {
  .ds-settings { grid-template-columns:1fr; gap:10px; }
  .ds-settings-nav { position:static; flex-direction:row; flex-wrap:wrap; gap:6px; border-right:0;
    border-bottom:1px solid var(--ds-line); padding:0 0 10px; }
  .ds-settings-nav-group { display:none; }
  .ds-nav-item { width:auto; }
}
.ds-field { display:flex; flex-direction:column; gap:4px; }
.ds-label { font-size:11px; opacity:.6; }
.ds-input, .ds-textarea, .ds-select { width:100%; font:inherit; color:inherit; background:var(--ds-soft); border:1px solid var(--ds-line);
  border-radius:7px; padding:6px 9px; outline:none; }
.ds-input:focus, .ds-textarea:focus, .ds-select:focus { border-color:var(--ds-accent); }
.ds-textarea { min-height:70px; resize:vertical; font-size:12px; }
.ds-hint { font-size:10.5px; opacity:.5; }
.ds-error { font-size:11px; color:#c0392b; }
.ds-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.ds-drawer-wrap { position:fixed; inset:0; background:#00000055; display:flex; justify-content:flex-end; z-index:60; }
.ds-modal-wrap { position:fixed; inset:0; background:#00000055; display:flex; align-items:center; justify-content:center;
  z-index:70; padding:24px; }
.ds-modal { width:min(560px,96vw); max-height:min(86vh,760px); overflow:auto; display:flex; flex-direction:column; gap:14px;
  background:var(--ds-surface); color:inherit; border:1px solid var(--ds-line); border-radius:14px; padding:20px 22px;
  box-shadow:0 24px 60px #0000003d; }
.ds-modal h3 { margin:0; font-size:15px; font-weight:650; }
.ds-modal-foot { display:flex; align-items:center; gap:10px; padding-top:2px; }
.ds-modal-foot .ds-grow { flex:1; }
.ds-modal-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.ds-drawer { width:min(980px,94vw); height:100%; max-height:100%; background:var(--ds-surface); color:inherit; border-left:1px solid var(--ds-line);
  display:flex; flex-direction:column; overflow:hidden; box-shadow:-16px 0 40px #0000002e; }
.ds-dw-head { display:flex; gap:10px; align-items:flex-start; padding:16px 20px 12px; border-bottom:1px solid var(--ds-line);
  flex:0 0 auto; background:linear-gradient(180deg, color-mix(in srgb, var(--ds-accent) 5%, transparent), transparent); }
.ds-dw-title { font-size:15.5px; font-weight:600; line-height:1.35; word-break:break-word; }
.ds-dw-sub { font-size:11.5px; opacity:.6; margin-top:4px; }
/* min-height:0 是关键：没有它，flex 子项不肯收缩，内容一长就把底部评论框顶到屏幕外 */
.ds-dw-body { flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain; padding:16px 20px 26px;
  display:flex; flex-direction:column; gap:18px; }
/* 详情按页签分组，这里只是包裹层，保持单列 */
.ds-dw-cols, .ds-dw-col { display:block; }
.ds-dw-tabs { display:flex; gap:4px; flex-wrap:wrap; padding:10px 20px 0; border-bottom:1px solid var(--ds-line); flex:0 0 auto; }
.ds-dw-tab {
  appearance:none; background:transparent; border:1px solid transparent; border-bottom:none; color:inherit;
  font-size:12.5px; padding:7px 12px 8px; border-radius:8px 8px 0 0; cursor:pointer; display:flex; align-items:center; gap:5px;
  opacity:.72; margin-bottom:-1px;
}
.ds-dw-tab:hover { opacity:1; background:color-mix(in srgb, currentColor 6%, transparent); }
.ds-dw-tab[data-on="1"] {
  opacity:1; font-weight:600; background:var(--ds-surface); border-color:var(--ds-line);
  border-bottom:1px solid var(--ds-surface); color:var(--ds-accent);
}
.ds-dw-tab-count {
  font-size:10.5px; line-height:1; padding:2px 5px; border-radius:8px; font-weight:600;
  background:color-mix(in srgb, currentColor 12%, transparent);
}
.ds-dw-foot { flex:0 0 auto; border-top:1px solid var(--ds-line); padding:10px 20px 14px; background:var(--ds-surface); position:relative; }
.ds-mention-bar { display:flex; align-items:center; gap:6px; margin-bottom:6px; flex-wrap:wrap; }
.ds-mention-pop {
  position:absolute; left:20px; right:20px; bottom:calc(100% - 4px);
  background:var(--ds-surface); border:1px solid var(--ds-line); border-radius:10px;
  box-shadow:0 12px 32px rgba(0,0,0,0.18); max-height:260px; display:flex; flex-direction:column;
  overflow:hidden; z-index:60; color:inherit;
}
.ds-mention-search { border:0; border-bottom:1px solid var(--ds-line); background:transparent; color:inherit; padding:8px 12px; font:inherit; font-size:12.5px; outline:none; }
.ds-mention-list { overflow:auto; padding:4px 0; }
.ds-mention-group { font-size:11px; color:color-mix(in srgb, currentColor 55%, transparent); padding:6px 12px 2px; }
.ds-mention-item {
  display:flex; align-items:center; gap:8px; width:100%; text-align:left; background:none; border:0;
  padding:6px 12px; font:inherit; font-size:12.5px; color:inherit; cursor:pointer;
}
.ds-mention-item:hover, .ds-mention-item[data-active='1'] { background:color-mix(in srgb, var(--ds-accent) 12%, transparent); }
.ds-mention-item .ds-hint { margin-left:auto; }
.ds-mention-empty { padding:10px 12px; font-size:12px; color:color-mix(in srgb, currentColor 55%, transparent); }
.ds-colrow { border-bottom:1px solid var(--ds-line); padding:10px 0; display:flex; flex-direction:column; gap:8px; }
.ds-colrow:last-of-type { border-bottom:0; }
.ds-colrow-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.ds-colrow-name { font-weight:600; font-size:12.5px; min-width:64px; }
.ds-chip-owner { display:inline-flex; align-items:center; gap:4px; }
.ds-chip-x { border:0; background:none; color:inherit; cursor:pointer; opacity:0.55; font-size:13px; line-height:1; padding:0 2px; }
.ds-chip-x:hover { opacity:1; color:#e5484d; }
.ds-skillbox { display:flex; flex-direction:column; gap:2px; max-height:190px; overflow-y:auto; border:1px solid var(--ds-line); border-radius:8px; padding:6px 8px; background:var(--ds-soft); }
.ds-skillopt { display:flex; align-items:center; gap:8px; padding:4px 2px; border-radius:6px; cursor:pointer; }
.ds-skillopt:hover { background:var(--ds-soft2); }
.ds-skillopt[data-on="1"] { background:color-mix(in srgb, var(--ds-accent) 10%, transparent); }
.ds-skillname { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px; }
.ds-skilldesc { flex:1 1 auto; min-width:0; color:var(--ds-muted, #6b7280); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ds-skillusers { flex:0 0 auto; font-size:10.5px; opacity:.6; }
.ds-chip[data-missing="1"] { border-color:color-mix(in srgb, #e5484d 45%, var(--ds-line)); }
.ds-colpick { border:1px solid var(--ds-line); border-radius:10px; max-height:220px; display:flex; flex-direction:column; overflow:hidden; background:var(--ds-surface); }
.ds-colpick-list { overflow:auto; padding:4px 0; }
.ds-sec { display:flex; flex-direction:column; gap:8px; margin-bottom:16px; }
.ds-sec:last-child { margin-bottom:0; }
.ds-sec-head { display:flex; align-items:center; gap:8px; font-size:12px; font-weight:600; }
.ds-sec-head .ds-hint { font-weight:400; }
.ds-sec-body { display:flex; flex-direction:column; gap:8px; }
/* 详情里不要套内层滚动条：外层 .ds-dw-body 已经能滚，再套一层会把内容「截一半」，让人以为丢了数据。 */
.ds-sec-body[data-scroll="1"] { padding-right:4px; }
.ds-comments { padding-right:4px; }
.ds-kv { display:grid; grid-template-columns:92px 1fr; gap:6px 12px; font-size:12px; margin:0; padding:10px 12px;
  border:1px solid var(--ds-line); border-radius:10px; background:var(--ds-soft); }
.ds-kv dt { opacity:.55; }
.ds-kv dd { margin:0; word-break:break-all; }
/* Comment thread: the human's words sit flush left on an accent surface,
   the agent's answer steps in behind a role-coloured rail. */
.ds-comments { display:flex; flex-direction:column; gap:2px; }
.ds-cm { display:grid; grid-template-columns:30px minmax(0,1fr); gap:10px; align-items:start;
  padding:9px 0; border-top:1px solid var(--ds-line); }
.ds-cm:first-child { border-top:0; }
.ds-cm-avatar { width:30px; height:30px; border-radius:50%; display:flex; align-items:center; justify-content:center;
  font-size:15px; line-height:1; border:1px solid var(--ds-line); background:var(--ds-card); }
.ds-cm[data-kind="human"] .ds-cm-avatar { background:var(--ds-accent); border-color:transparent; }
.ds-cm-initial { font-size:12px; font-weight:700; color:#fff; line-height:1; }
.ds-cm-head { display:flex; align-items:center; gap:7px; margin-bottom:5px; flex-wrap:wrap; }
.ds-cm-name { font-size:12px; font-weight:650; }
.ds-cm-kind { font-size:9.5px; letter-spacing:.06em; text-transform:uppercase; padding:0 5px; line-height:15px;
  border-radius:4px; border:1px solid currentColor; opacity:.75; }
.ds-cm[data-kind="human"] .ds-cm-kind { color:var(--ds-accent); }
.ds-cm[data-kind="agent"] .ds-cm-kind { opacity:.45; }
.ds-cm-meta { font-size:10.5px; opacity:.45; margin-left:auto; }
.ds-cm-bubble { font-size:12.5px; line-height:1.62; white-space:pre-wrap; border-radius:9px; padding:9px 12px;
  border:1px solid var(--ds-line); background:var(--ds-card); }
.ds-cm[data-kind="human"] .ds-cm-bubble { background:color-mix(in srgb, var(--ds-accent) 8%, transparent);
  border-color:color-mix(in srgb, var(--ds-accent) 38%, transparent); }
.ds-cm[data-kind="agent"] { margin-left:22px; }
.ds-cm[data-kind="agent"] .ds-cm-bubble { border-left-width:3px; border-left-color:var(--ds-line); background:transparent; }
.ds-cm[data-role="product"] .ds-cm-bubble { border-left-color:#2f6feb; }
.ds-cm[data-role="architect"] .ds-cm-bubble { border-left-color:#8b5cf6; }
.ds-cm[data-role="dev"] .ds-cm-bubble { border-left-color:#0f9d58; }
.ds-cm[data-role="qa"] .ds-cm-bubble { border-left-color:#e08600; }
.ds-cm-bubble > :first-child { margin-top:0; }
.ds-cm-bubble > :last-child { margin-bottom:0; }
.ds-md { white-space:normal; line-height:1.6; word-break:break-word; }
.ds-md > *:first-child { margin-top:0; }
.ds-md > *:last-child { margin-bottom:0; }
.ds-md p { margin:0 0 8px; }
.ds-md h3, .ds-md h4, .ds-md h5, .ds-md h6 { margin:12px 0 6px; line-height:1.35; }
.ds-md h3 { font-size:14px; } .ds-md h4 { font-size:13px; } .ds-md h5, .ds-md h6 { font-size:12.5px; }
.ds-md ul, .ds-md ol { margin:0 0 8px; padding-left:20px; }
.ds-md li { margin:2px 0; }
.ds-md code { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:11.5px;
  background:var(--ds-soft2); border:1px solid var(--ds-line); border-radius:4px; padding:0 4px; }
.ds-md pre { margin:0 0 10px; padding:10px 12px; overflow-x:auto; background:var(--ds-soft2); border:1px solid var(--ds-line); border-radius:8px; }
.ds-md pre code { background:none; border:0; padding:0; font-size:11.5px; line-height:1.55; }
.ds-md blockquote { margin:0 0 8px; padding:2px 0 2px 10px; border-left:3px solid var(--ds-line); opacity:.85; }
.ds-md a { color:var(--ds-accent); text-decoration:none; }
.ds-md a:hover { text-decoration:underline; }
.ds-md hr { border:0; border-top:1px solid var(--ds-line); margin:10px 0; }
.ds-md table { border-collapse:collapse; margin:0 0 10px; font-size:11.5px; width:100%; table-layout:fixed; }
.ds-md th, .ds-md td { border:1px solid var(--ds-line); padding:4px 8px; text-align:left; vertical-align:top; word-break:break-word; }
.ds-md th { background:var(--ds-soft2); font-weight:600; }
.ds-err { color:#e5484d; font-size:12px; }
.ds-ok { color:#0f9d58; font-size:12px; }
.ds-loading { padding:24px; opacity:.5; font-size:12.5px; }
/* ---- 需求页 ---- */
.ds-req-grid { display:grid; grid-template-columns:320px minmax(0,1fr); gap:16px; align-items:start; }
@media (max-width:980px) { .ds-req-grid { grid-template-columns:1fr; } }
.ds-req-list { display:flex; flex-direction:column; gap:6px; }
.ds-req-list-head { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:11.5px; opacity:.75; padding:0 2px 4px; }
.ds-req-item { border:1px solid var(--ds-line); border-radius:9px; padding:9px 11px; cursor:pointer; display:flex; flex-direction:column; gap:5px; }
.ds-req-item:hover { border-color:var(--ds-accent); }
.ds-req-item[data-on="1"] { border-color:var(--ds-accent); background:color-mix(in srgb, var(--ds-accent) 7%, transparent); }
.ds-req-item-title { font-size:12.5px; font-weight:600; line-height:1.35; }
.ds-req-item-meta { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.ds-req-detail { border:1px solid var(--ds-line); border-radius:10px; padding:16px 18px; min-height:220px; }
.ds-req-headline { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
.ds-req-code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px; opacity:.6; letter-spacing:.02em; }
.ds-req-name { font-size:16px; font-weight:650; margin-top:2px; line-height:1.35; }
.ds-req-actions { display:flex; align-items:center; gap:8px; flex:0 0 auto; }
.ds-req-actions .ds-select { width:auto; min-width:96px; height:28px; }
.ds-req-links { display:flex; gap:14px; flex-wrap:wrap; margin-top:10px; }
.ds-link { color:var(--ds-accent); font-size:12px; text-decoration:none; }
.ds-link:hover { text-decoration:underline; }
.ds-req-desc { margin-top:10px; font-size:12px; line-height:1.65; opacity:.92; }
.ds-req-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(96px,1fr)); gap:8px; margin-top:14px; }
.ds-stat-box { border:1px solid var(--ds-line); border-radius:9px; padding:8px 10px; display:flex; flex-direction:column; gap:2px; }
.ds-stat-box b { font-size:15px; font-weight:650; }
.ds-matrix { display:flex; flex-direction:column; gap:8px; margin-top:8px; }
.ds-matrix-sum { font-size:11.5px; opacity:.72; padding:6px 0 2px; }
.ds-pt-row { display:flex; align-items:flex-start; gap:14px; padding:10px 12px; border:1px solid var(--ds-line); border-left:3px solid color-mix(in srgb, currentColor 20%, transparent); border-radius:9px; }
.ds-pt-row[data-covered="1"] { border-left-color:#0f9d58; }
.ds-pt-main { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:3px; }
.ds-pt-title { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:12.5px; }
.ds-pt-meta { font-size:11px; opacity:.7; }
.ds-pt-loose { margin-top:10px; padding:10px 12px; border:1px dashed var(--ds-line); border-radius:9px; display:flex; flex-direction:column; gap:6px; }
.ds-pt-loose-row { display:flex; align-items:center; gap:8px; font-size:11.5px; }
.ds-pt-loose-title { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ds-chip[data-pt="covered"] { color:#0f9d58; border-color:color-mix(in srgb, #0f9d58 40%, transparent); }
.ds-chip[data-pt="open"] { color:#d97706; border-color:color-mix(in srgb, #d97706 40%, transparent); }
.ds-gate { border:1px solid var(--ds-line); border-radius:9px; padding:10px 12px; display:flex; flex-direction:column; gap:5px; }
.ds-gate[data-ready="1"] { border-color:color-mix(in srgb, #0f9d58 45%, transparent); }
.ds-gate-head { display:flex; align-items:center; justify-content:space-between; gap:10px; font-size:12.5px; }
.ds-gate-item { font-size:11.5px; line-height:1.55; }
.ds-gate-item[data-kind="block"] { color:#c0392b; }
.ds-gate-item[data-kind="warn"] { color:#b26a00; }
.ds-gate-sign { display:flex; align-items:center; gap:10px; flex-wrap:wrap; font-size:11.5px; padding:8px 10px; border-radius:9px; background:var(--ds-soft); }
.ds-stat-box span { font-size:11px; opacity:.6; }
.ds-stat-box[data-warn="1"] { border-color:#e5484d; }
.ds-stat-box[data-warn="1"] b { color:#e5484d; }
.ds-req-tasks { display:flex; flex-direction:column; }
.ds-req-task { cursor:pointer; }
.ds-req-task:hover { background:var(--ds-soft); }
.ds-req-task-title { display:flex; align-items:center; gap:7px; font-size:12.5px; font-weight:600; }
.ds-chip-code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10px; letter-spacing:.02em; border:1px solid var(--ds-line); border-radius:5px; padding:0 5px; opacity:.85; }
.ds-chip[data-req="active"] { color:#0f9d58; border-color:#0f9d58; }
.ds-chip[data-req="delivered"] { color:var(--ds-accent); border-color:var(--ds-accent); }
.ds-chip[data-req="closed"] { opacity:.55; }
/* ---- 需求文档与基线 ---- */
.ds-base-box { display:flex; align-items:center; justify-content:space-between; gap:12px; border:1px solid var(--ds-line); border-radius:9px; padding:9px 12px; margin-top:8px; background:color-mix(in srgb, #0f9d58 6%, transparent); }
.ds-base-box[data-empty="1"] { background:var(--ds-soft); color:inherit; }
.ds-base-main { display:flex; flex-direction:column; gap:3px; min-width:0; }
.ds-base-main b { font-size:12.5px; font-weight:650; }
.ds-base-main span { font-size:11.5px; opacity:.72; line-height:1.45; }
.ds-doc-list { display:flex; flex-direction:column; margin-top:6px; }
.ds-doc-row { display:flex; align-items:flex-start; gap:10px; padding:9px 0; border-bottom:1px solid var(--ds-line); }
.ds-doc-row:last-child { border-bottom:0; }
.ds-doc-main { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:3px; }
.ds-doc-title { display:flex; align-items:center; gap:7px; flex-wrap:wrap; font-size:12.5px; font-weight:600; }
.ds-doc-meta { font-size:11px; opacity:.6; }
.ds-chip[data-doc="prd"] { color:#2f6feb; border-color:#2f6feb; }
.ds-chip[data-doc="proto"] { color:#8b5cf6; border-color:#8b5cf6; }
.ds-chip[data-doc="acceptance"] { color:#0f9d58; border-color:#0f9d58; }
.ds-chip[data-docstatus="baseline"] { color:#0f9d58; border-color:#0f9d58; background:color-mix(in srgb, #0f9d58 12%, transparent); }
.ds-chip[data-docstatus="review"] { color:#d97706; border-color:#d97706; }
/* ---- 滚动条：跟着插件主题走，不跟系统 ---- */
[data-dsh-studio] { scrollbar-width:thin; scrollbar-color:color-mix(in srgb, currentColor 24%, transparent) transparent; }
[data-dsh-studio] ::-webkit-scrollbar { width:10px; height:10px; }
[data-dsh-studio] ::-webkit-scrollbar-track { background:transparent; }
[data-dsh-studio] ::-webkit-scrollbar-thumb { background:color-mix(in srgb, currentColor 22%, transparent); border-radius:8px; }
[data-dsh-studio] ::-webkit-scrollbar-thumb:hover { background:color-mix(in srgb, currentColor 38%, transparent); }
[data-dsh-studio] ::-webkit-scrollbar-corner { background:transparent; }

/* ---- 窄屏（平板竖屏 / 手机）：单列、卡片占满、按钮换行 ---- */
@media (max-width:760px) {
  .ds-head { padding:10px 12px 0; }
  .ds-head-top { flex-wrap:wrap; gap:8px; }
  .ds-head-actions { flex-wrap:wrap; gap:6px; margin-left:0; }
  .ds-head-tabs { gap:8px; }
  .ds-head-tabs .ds-grow { display:none; }
  .ds-stat { display:none; }
  .ds-tabs { flex:1 1 auto; min-width:0; flex-wrap:wrap; overflow:visible; }
  .ds-tab { padding:4px 10px; }
  .ds-board { gap:10px; padding:10px 12px 12px; }
  .ds-col { flex:0 0 min(86vw,300px); }
  .ds-panel-body { padding:12px; }
  .ds-kv { grid-template-columns:1fr; gap:2px 0; }
  .ds-kv dt { margin-top:6px; }
  .ds-an-row { grid-template-columns:76px minmax(0,1fr) 64px; }
  .ds-gate-head { flex-wrap:wrap; }
  .ds-audit-row { grid-template-columns:56px 1fr 56px; }
}
@media (max-width:520px) {
  .ds-col { flex:0 0 92vw; }
  .ds-tabs { overflow-x:auto; max-width:100%; }
  .ds-head-actions .ds-btn { padding:5px 9px; }
}

/* ---- 强制颜色（Windows 高对比度 / forced-colors）：选中态从底色改成边框 ---- */
@media (forced-colors: active) {
  .ds-panel, .ds-card, .ds-side, .ds-drawer, .ds-gate, .ds-stat-box, .ds-col, .ds-doc-row, .ds-tabs, .ds-seg { border:1px solid CanvasText; }
  .ds-btn, .ds-chip, .ds-seg-btn { border:1px solid ButtonText; }
  .ds-tab[data-on="1"], .ds-seg-btn[data-on="1"], .ds-chip[data-on="1"] { border:2px solid Highlight; }
  .ds-btn-primary { border:2px solid ButtonText; background:ButtonFace; color:ButtonText; }
  .ds-kpi[data-warn="1"], .ds-stat-box[data-warn="1"] { border:2px solid CanvasText; }
  .ds-chip[data-pt="covered"], .ds-chip[data-pt="open"], .ds-chip[data-req="active"], .ds-chip[data-req="delivered"] { border-color:Highlight; }
  [data-dsh-studio] :focus-visible { outline:2px solid Highlight; outline-offset:1px; }
}
/* ---- 登录页（统一登录要求登录、又还没有会话时盖的一层） ---- */
.ds-login-wrap { flex:1 1 auto; display:flex; align-items:center; justify-content:center; padding:24px; }
/* 已进入工作区后点「登录」时是浮层：固定盖住整页，别把下面的布局挤歪 */
.ds-login-wrap[data-overlay="1"] { position:fixed; inset:0; z-index:90; flex:none;
  background:color-mix(in srgb, var(--ds-surface) 76%, transparent); backdrop-filter:blur(2px); }
.ds-login { width:min(380px,100%); display:flex; flex-direction:column; gap:10px; padding:20px;
  border:1px solid var(--ds-line); border-radius:12px; background:var(--ds-surface);
  box-shadow:0 12px 32px color-mix(in srgb, currentColor 12%, transparent); }
.ds-login-wrap[data-overlay="1"] .ds-login { box-shadow:0 22px 60px color-mix(in srgb, currentColor 26%, transparent); }
.ds-login-brand { font-size:16px; font-weight:600; }
.ds-login-hint { font-size:12px; opacity:.75; line-height:1.6; }
.ds-login-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:2px; }
.ds-login-note { font-size:11px; opacity:.6; word-break:break-all; }

/* ======================================================================
   shadcn/ui 风格层（2026-11-09）
   对齐 https://ui.shadcn.com 的默认主题：一套 token + 统一圆角/描边/
   焦点环/间距，组件按 Button / Input / Card / Badge / Tabs / Dialog /
   Table 的默认外观重画。仍然零依赖、无构建，只追加规则覆盖旧样式。
   ====================================================================== */
[data-dsh-studio] {
  --radius:10px;
  --background:#fafafa; --foreground:#09090b;
  --card:#ffffff; --card-foreground:#09090b;
  --popover:#ffffff; --popover-foreground:#09090b;
  --primary:#18181b; --primary-foreground:#fafafa;
  --secondary:#f4f4f5; --secondary-foreground:#18181b;
  --muted:#f4f4f5; --muted-foreground:#71717a;
  --accent:#f4f4f5; --accent-foreground:#18181b;
  --destructive:#dc2626; --destructive-foreground:#fafafa;
  --border:#e4e4e7; --input:#e4e4e7; --ring:#a1a1aa;
  --ds-bg:var(--background); --ds-surface:var(--card); --ds-surface-2:var(--muted);
  --ds-card:var(--card); --ds-line:var(--border);
  --ds-line-soft:color-mix(in srgb, var(--border) 55%, transparent);
  --ds-soft:var(--muted); --ds-soft2:var(--secondary);
  --ds-accent:var(--primary); --ds-shadow:0 1px 2px rgb(9 9 11 / .05);
  background:var(--background); color:var(--foreground);
}
[data-dsh-studio][data-theme="light"] {
  color-scheme:light; color:var(--foreground); background:var(--background);
  --background:#fafafa; --foreground:#09090b;
  --card:#ffffff; --card-foreground:#09090b;
  --popover:#ffffff; --popover-foreground:#09090b;
  --primary:#18181b; --primary-foreground:#fafafa;
  --secondary:#f4f4f5; --secondary-foreground:#18181b;
  --muted:#f4f4f5; --muted-foreground:#71717a;
  --accent:#f4f4f5; --accent-foreground:#18181b;
  --destructive:#dc2626; --border:#e4e4e7; --input:#e4e4e7; --ring:#a1a1aa;
  --ds-bg:var(--background); --ds-surface:var(--card); --ds-surface-2:var(--muted);
  --ds-card:var(--card); --ds-line:var(--border);
  --ds-line-soft:color-mix(in srgb, var(--border) 55%, transparent);
  --ds-soft:var(--muted); --ds-soft2:var(--secondary);
  --ds-accent:var(--primary); --ds-shadow:0 1px 2px rgb(9 9 11 / .05);
}
[data-dsh-studio][data-theme="dark"] {
  color-scheme:dark; color:var(--foreground); background:var(--background);
  --background:#09090b; --foreground:#fafafa;
  --card:#111113; --card-foreground:#fafafa;
  --popover:#111113; --popover-foreground:#fafafa;
  --primary:#fafafa; --primary-foreground:#18181b;
  --secondary:#1b1b1f; --secondary-foreground:#fafafa;
  --muted:#1b1b1f; --muted-foreground:#a1a1aa;
  --accent:#1b1b1f; --accent-foreground:#fafafa;
  --destructive:#ef4444; --border:#27272a; --input:#27272a; --ring:#52525b;
  --ds-bg:var(--background); --ds-surface:var(--card); --ds-surface-2:var(--muted);
  --ds-card:var(--card); --ds-line:var(--border);
  --ds-line-soft:color-mix(in srgb, var(--border) 65%, transparent);
  --ds-soft:var(--muted); --ds-soft2:var(--secondary);
  --ds-accent:var(--primary); --ds-shadow:0 1px 2px rgb(0 0 0 / .45);
}
/* 焦点环：shadcn 的 ring-2 ring-ring ring-offset-2 */
[data-dsh-studio] :focus-visible { outline:2px solid var(--ring); outline-offset:2px; border-radius:calc(var(--radius) - 4px); }

/* 页头 / 页面底 */
[data-dsh-studio] .ds-head { background:var(--background); border-bottom:1px solid var(--border); padding:14px 20px 0; }
[data-dsh-studio] .ds-brand, [data-dsh-studio] .ds-title { letter-spacing:-.01em; }

/* 按钮：outline（默认）、primary、ghost 三态 */
[data-dsh-studio] .ds-btn { display:inline-flex; align-items:center; justify-content:center; gap:6px;
  height:32px; padding:0 12px; border:1px solid var(--input); border-radius:var(--radius);
  background:var(--card); color:var(--foreground); font-size:12.5px; font-weight:500; line-height:1;
  box-shadow:var(--ds-shadow); cursor:pointer; transition:background .12s ease, border-color .12s ease, box-shadow .12s ease; }
[data-dsh-studio] .ds-btn:hover { background:var(--muted); }
[data-dsh-studio] .ds-btn:active { transform:translateY(.5px); }
[data-dsh-studio] .ds-btn[disabled] { opacity:.5; cursor:not-allowed; box-shadow:none; }
[data-dsh-studio] .ds-btn-primary { background:var(--primary); border-color:var(--primary); color:var(--primary-foreground); box-shadow:none; }
[data-dsh-studio] .ds-btn-primary:hover { background:color-mix(in srgb, var(--primary) 88%, transparent); filter:none; }
[data-dsh-studio] .ds-btn-ghost { background:transparent; border-color:transparent; box-shadow:none; opacity:.7; height:26px; padding:0 8px; }
[data-dsh-studio] .ds-btn-ghost:hover { background:var(--muted); opacity:1; }

/* 输入类：Input / Select / Textarea */
[data-dsh-studio] .ds-input, [data-dsh-studio] .ds-select, [data-dsh-studio] .ds-textarea {
  width:100%; height:32px; padding:0 10px; font:inherit; font-size:12.5px; color:var(--foreground);
  background:var(--card); border:1px solid var(--input); border-radius:var(--radius);
  box-shadow:var(--ds-shadow); transition:border-color .12s ease, box-shadow .12s ease; }
[data-dsh-studio] .ds-textarea { height:auto; min-height:72px; padding:8px 10px; line-height:1.6; resize:vertical; }
[data-dsh-studio] .ds-select { padding-right:8px; }
[data-dsh-studio] .ds-input:hover, [data-dsh-studio] .ds-select:hover, [data-dsh-studio] .ds-textarea:hover { border-color:var(--ring); }
[data-dsh-studio] .ds-input:focus, [data-dsh-studio] .ds-select:focus, [data-dsh-studio] .ds-textarea:focus {
  border-color:var(--ring); outline:none; box-shadow:0 0 0 3px color-mix(in srgb, var(--ring) 35%, transparent); }
[data-dsh-studio] .ds-input::placeholder, [data-dsh-studio] .ds-textarea::placeholder { color:var(--muted-foreground); }
[data-dsh-studio] .ds-label { font-size:12px; font-weight:500; color:var(--foreground); }
[data-dsh-studio] .ds-hint, [data-dsh-studio] .ds-sub, [data-dsh-studio] .ds-pane-desc, [data-dsh-studio] .ds-empty { color:var(--muted-foreground); }

/* 卡片 / 面板 */
[data-dsh-studio] .ds-panel { background:var(--card); border:1px solid var(--border); border-radius:calc(var(--radius) + 2px);
  box-shadow:var(--ds-shadow); margin-bottom:16px; overflow:hidden; }
[data-dsh-studio] .ds-panel-head { background:transparent; border-bottom:1px solid var(--border); padding:12px 16px; font-size:13px; }
[data-dsh-studio] .ds-panel-body { padding:16px; gap:14px; }
[data-dsh-studio] .ds-card { background:var(--card); border:1px solid var(--border); border-radius:var(--radius);
  box-shadow:var(--ds-shadow); padding:10px 11px; transition:border-color .12s ease, box-shadow .12s ease, transform .12s ease; }
[data-dsh-studio] .ds-card:hover { border-color:var(--ring); transform:none; box-shadow:0 2px 8px rgb(9 9 11 / .08); }
[data-dsh-studio] .ds-kpi { background:var(--card); border:1px solid var(--border); border-radius:calc(var(--radius) + 2px);
  box-shadow:var(--ds-shadow), inset 0 0 0 0 transparent; padding:14px 16px; }
[data-dsh-studio] .ds-kpi-value { font-size:24px; font-weight:600; font-variant-numeric:tabular-nums; }
[data-dsh-studio] .ds-kpi-label { font-size:12px; font-weight:500; color:var(--muted-foreground); }
[data-dsh-studio] .ds-kpi-hint { font-size:11.5px; color:var(--muted-foreground); }
[data-dsh-studio] .ds-stat-box, [data-dsh-studio] .ds-proj-card, [data-dsh-studio] .ds-market-card,
[data-dsh-studio] .ds-req-item, [data-dsh-studio] .ds-gate, [data-dsh-studio] .ds-base-box {
  background:var(--card); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--ds-shadow); }

/* Badge（chip） */
[data-dsh-studio] .ds-chip { display:inline-flex; align-items:center; gap:4px; height:20px; padding:0 8px;
  border:1px solid var(--border); border-radius:999px; background:var(--muted); color:var(--secondary-foreground);
  font-size:11px; font-weight:500; line-height:1; white-space:nowrap; }
[data-dsh-studio] .ds-chip[data-on="1"] { background:var(--primary); border-color:var(--primary); color:var(--primary-foreground); }
[data-dsh-studio] .ds-chip-bug, [data-dsh-studio] .ds-chip[data-sla="overdue"] { background:color-mix(in srgb, var(--destructive) 12%, var(--card)); border-color:color-mix(in srgb, var(--destructive) 45%, var(--border)); color:var(--destructive); font-weight:600; }
[data-dsh-studio] .ds-chip[data-sla="due_soon"] { background:color-mix(in srgb, #d97706 12%, var(--card)); border-color:color-mix(in srgb, #d97706 45%, var(--border)); color:#b45309; }
[data-dsh-studio][data-theme="dark"] .ds-chip[data-sla="due_soon"] { color:#fbbf24; }

/* Tabs（shadcn: 灰底胶囊 + 选中项浮起） */
[data-dsh-studio] .ds-tabs { display:inline-flex; gap:4px; padding:4px; border-radius:calc(var(--radius) + 1px);
  background:var(--muted); border:1px solid var(--border); }
[data-dsh-studio] .ds-tab { border:0; background:transparent; color:var(--muted-foreground); font:inherit; font-size:12.5px;
  font-weight:500; padding:5px 12px; border-radius:calc(var(--radius) - 2px); white-space:nowrap; flex:0 0 auto; transition:background .12s ease, color .12s ease; }
[data-dsh-studio] .ds-tab:hover { background:color-mix(in srgb, var(--card) 60%, transparent); color:var(--foreground); opacity:1; }
[data-dsh-studio] .ds-tab[data-on="1"] { background:var(--card); color:var(--foreground); font-weight:600; box-shadow:var(--ds-shadow); }
[data-dsh-studio] .ds-seg { display:inline-flex; gap:3px; padding:3px; border-radius:calc(var(--radius) + 1px); background:var(--muted); border:1px solid var(--border); }
[data-dsh-studio] .ds-seg-btn { border:0; background:transparent; color:var(--muted-foreground); font:inherit; font-size:11.5px;
  padding:4px 10px; border-radius:calc(var(--radius) - 3px); white-space:nowrap; }
[data-dsh-studio] .ds-seg-btn[data-on="1"] { background:var(--card); color:var(--foreground); font-weight:600; box-shadow:var(--ds-shadow); opacity:1; }
[data-dsh-studio] .ds-dw-tabs { border-bottom:1px solid var(--border); gap:2px; }
[data-dsh-studio] .ds-dw-tab { border-radius:calc(var(--radius) - 4px) calc(var(--radius) - 4px) 0 0; }
[data-dsh-studio] .ds-dw-tab[data-on="1"] { background:var(--muted); border-bottom:2px solid var(--foreground); }

/* 看板列 */
[data-dsh-studio] .ds-col { background:color-mix(in srgb, var(--muted) 55%, transparent); border:1px solid var(--border);
  border-radius:calc(var(--radius) + 2px); }
[data-dsh-studio] .ds-col-head { background:transparent; border-bottom:1px solid var(--border); padding:10px 12px; font-size:12px; }

/* 抽屉 / 弹窗（Dialog） */
[data-dsh-studio] .ds-side, [data-dsh-studio] .ds-drawer { background:var(--card); border-left:1px solid var(--border);
  box-shadow:-24px 0 60px rgb(9 9 11 / .18); }
[data-dsh-studio] .ds-side-head, [data-dsh-studio] .ds-dw-head { border-bottom:1px solid var(--border); }
[data-dsh-studio] .ds-side-foot, [data-dsh-studio] .ds-dw-foot { background:var(--card); border-top:1px solid var(--border); }
[data-dsh-studio] .ds-modal { background:var(--card); border:1px solid var(--border); border-radius:calc(var(--radius) + 4px);
  box-shadow:0 24px 64px rgb(9 9 11 / .24); padding:20px; }
[data-dsh-studio] .ds-modal-wrap, [data-dsh-studio] .ds-drawer-wrap, [data-dsh-studio] .ds-side-mask { background:rgb(9 9 11 / .5); }

/* 表格化行 */
[data-dsh-studio] .ds-listrow, [data-dsh-studio] .ds-doc-row, [data-dsh-studio] .ds-audit-row,
[data-dsh-studio] .ds-art-row, [data-dsh-studio] .ds-pt-row { border-bottom:1px solid var(--border); }
[data-dsh-studio] .ds-listrow:hover, [data-dsh-studio] .ds-doc-row:hover, [data-dsh-studio] .ds-art-row:hover { background:var(--muted); }

/* 滚动条 */
[data-dsh-studio] { scrollbar-color:color-mix(in srgb, var(--foreground) 22%, transparent) transparent; }
[data-dsh-studio] ::-webkit-scrollbar-thumb { background:color-mix(in srgb, var(--foreground) 20%, transparent); }
[data-dsh-studio] ::-webkit-scrollbar-thumb:hover { background:color-mix(in srgb, var(--foreground) 32%, transparent); }

/* 登录卡（Card + 表单） */
[data-dsh-studio] .ds-login { border:1px solid var(--border); border-radius:calc(var(--radius) + 4px); background:var(--card); box-shadow:0 20px 48px rgb(9 9 11 / .18); }

/* ---- 第二遍：密度与层级微调（看板 / 卡片 / 工具栏） ---- */
[data-dsh-studio] .ds-board { gap:14px; padding:14px 20px 18px; }
[data-dsh-studio] .ds-board-bar { gap:8px; padding:12px 20px; flex-wrap:wrap; }
[data-dsh-studio] .ds-col { background:var(--muted); border:1px solid var(--border); }
[data-dsh-studio] .ds-col-head { padding:11px 12px; font-size:12.5px; font-weight:600; letter-spacing:-.005em; }
[data-dsh-studio] .ds-count { display:inline-flex; align-items:center; justify-content:center; min-width:20px; height:20px; padding:0 6px;
  border-radius:999px; background:var(--card); border:1px solid var(--border); color:var(--muted-foreground); font-size:11px; font-weight:600; }
[data-dsh-studio] .ds-col-owner { color:var(--muted-foreground); opacity:1; font-size:11px; }
[data-dsh-studio] .ds-col-body { padding:10px; gap:10px; }
[data-dsh-studio] .ds-card { padding:11px 12px; border-radius:var(--radius); }
[data-dsh-studio] .ds-card-title { font-size:13px; font-weight:600; line-height:1.4; }
[data-dsh-studio] .ds-card-foot { color:var(--muted-foreground); opacity:1; font-size:11px; }
[data-dsh-studio] .ds-card-body, [data-dsh-studio] .ds-meta { color:var(--muted-foreground); }
[data-dsh-studio] .ds-chip { height:21px; font-size:11px; padding:0 8px; background:var(--secondary); border-color:var(--border); }
[data-dsh-studio] .ds-chip-code { background:var(--muted); border-color:var(--border); color:var(--muted-foreground); }
[data-dsh-studio] .ds-chip[data-proj="1"] { background:color-mix(in srgb, var(--primary) 8%, var(--card)); border-color:color-mix(in srgb, var(--primary) 22%, var(--border)); color:var(--foreground); }
[data-dsh-studio] .ds-sec-head, [data-dsh-studio] .ds-an-sec { font-size:12px; font-weight:600; color:var(--muted-foreground); text-transform:none; letter-spacing:.01em; }
[data-dsh-studio] .ds-panel-head .ds-hint, [data-dsh-studio] .ds-head .ds-sub { font-size:11.5px; }
[data-dsh-studio] .ds-filters, [data-dsh-studio] .ds-check-bar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
`

    // ----------------------------------------------------------------- state

    function useStudio() {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState(null)
      /** 上一次渲染用的数据指纹：轮询拿回来的东西没变就不重渲染（每次 /state 600KB 上下，重渲染一次够卡好几帧）。 */
      const signature = React.useRef('')
      const reload = React.useCallback(async (force = false) => {
        if (typeof document !== 'undefined' && document.hidden === true) return
        try {
          const payload = await api('/state')
          // 服务端在「必须登录」又没带会话时只回 { locked: true, state: 精简版 }，
          // locked 得留着，否则登录框不会出现。
          const next = { ...(payload.state ?? {}), locked: payload.locked === true }
          const sig = [
            next.revision ?? '',
            (next.tasks ?? []).length,
            (next.requirements ?? []).length,
            (next.agents ?? []).length,
            next.locked === true ? 1 : 0,
          ].join('|')
          if (!force && sig === signature.current) { setError(null); return }
          signature.current = sig
          setState(next)
          setError(null)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }, [])
      React.useEffect(() => {
        let alive = true
        const tick = async () => { if (alive) await reload() }
        void tick()
        // 5s → 15s：状态没变时本来就不重渲染，但每次仍要传 600KB JSON；挂后台时直接停。
        const timer = setInterval(() => { void tick() }, 15000)
        const onVisible = () => { if (document.hidden !== true) void tick() }
        document.addEventListener('visibilitychange', onVisible)
        return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
      }, [reload])
      return { state, error, reload }
    }


    /** epoch 毫秒 ↔ <input type="date"> 的 yyyy-mm-dd。 */


    // ------------------------------------------------------------------ card

    /** 这张卡现在实际归谁：正在跑的那个 > 卡上指定的 > 本列负责人 > 没人。 */





    // ---------------------------------------------------------------- drawer

    // ------------------------------------------------------------ markdown

    const renderMarkdown = createMarkdown(h)


    /** @ 选择器：一列可搜的名单，代替原来平铺的一堆按钮。 */
    const MentionPicker = createMentionPicker({ h, TextField })
    const Drawer = createDrawer({ h, React, api, kit, currentUser, renderMarkdown, tipOf, tipLabel, confirmDialog, promptDialog, TextField, TextAreaField, ChipField, CheckField, SelectField, MdField, MentionPicker })
    const Palette = createPalette({ h, React })
    provideClient({ h, React, Editor, api, kit, toast, sessionToken, currentUser, confirmDialog, promptDialog, tipOf, tipLabel, renderMarkdown, SideDrawer, MentionPicker, Card, TextField, TextAreaField, ChipField, CheckField, SelectField, MdField })


    // -------------------------------------------------------------- market

    function Market({ state, onChanged }) {
      const [data, setData] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [form, setForm] = React.useState({ name: '', spec: '', description: '' })
      const [adding, setAdding] = React.useState(false)
      const [saving, setSaving] = React.useState(false)

      const load = React.useCallback(async () => {
        try { setData(await api('/market')) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
      }, [])
      React.useEffect(() => { void load() }, [load])

      const installed = new Set(data?.installed ?? [])
      const packageOf = spec => spec.replace(/^link:/, '').split('/').pop().replace(/^dsh-/, 'dsh-')

      const act = async (item, action) => {
        setBusy(item.id); setError(null); setNotice(null)
        try {
          const result = await api(`/market/${action}`, { id: item.id })
          if (result.ok === false) throw new Error((result.result?.output ?? '').slice(-300) || '安装失败')
          setNotice(action === 'install' ? '已安装，重启工作空间后生效' : '已移除，重启工作空间后生效')
          await load()
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(null) }
      }

      const addItem = async () => {
        if (form.name.trim() === '' || form.spec.trim() === '') return
        setSaving(true); setError(null)
        try {
          const items = [...(state.config.market.items ?? []), {
            id: `m-${Math.random().toString(16).slice(2, 10)}`,
            name: form.name.trim(), spec: form.spec.trim(), description: form.description.trim(),
          }]
          await api('/config', { market: { items } })
          setForm({ name: '', spec: '', description: '' })
          setAdding(false)
          await onChanged(); await load()
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setSaving(false) }
      }

      const removeItem = async (item) => {
        if (!(await confirmDialog(`从市场列表移除「${item.name}」？不会卸载已安装的插件。`, { title: '移除插件', danger: true, okText: '移除' }))) return
        const items = (state.config.market.items ?? []).filter(entry => entry.id !== item.id)
        await api('/config', { market: { items } }).catch(() => undefined)
        await onChanged(); await load()
      }

      const list = data?.items ?? state.config.market.items ?? []

      return h('div', null,
        h('div', { className: 'ds-row', style: { marginBottom: 12 } },
          h('div', { style: { fontSize: 13.5, fontWeight: 650 } }, data?.title ?? state.config.market.title),
          h('span', { className: 'ds-stat' }, `${list.length} 个条目 · profile ${state.profile ?? '—'}`),
          h('div', { className: 'ds-grow' }),
          h('button', { className: 'ds-btn', onClick: () => setAdding(!adding) }, adding ? '收起' : '＋ 添加条目'),
        ),
        error !== null ? h('div', { className: 'ds-err', style: { padding: '0 0 8px' } }, error) : null,
        notice !== null ? h('div', { className: 'ds-ok', style: { padding: '0 0 8px' } }, notice) : null,
        list.length === 0
          ? h('div', { className: 'ds-empty' }, '还没有条目。把公司内部的插件包加进来，同事就能一键安装。')
          : h('div', { className: 'ds-market-grid' },
            list.map(item => {
              const name = packageOf(item.spec)
              const isInstalled = installed.has(name) || installed.has(item.name)
              return h('div', { key: item.id, className: 'ds-market-card' },
                h('div', { className: 'ds-mc-head' },
                  h('span', { className: 'ds-mc-name ds-grow' }, item.name),
                  h(ChipField, { className: 'ds-chip', 'data-on': isInstalled ? '1' : '0' }, isInstalled ? '已安装' : '未安装'),
                ),
                item.description !== '' ? h('div', { className: 'ds-mc-desc' }, item.description) : null,
                h('code', null, item.spec),
                h('div', { className: 'ds-row', style: { marginTop: 'auto' } },
                  h('button', {
                    className: isInstalled ? 'ds-btn' : 'ds-btn ds-btn-primary',
                    disabled: busy === item.id,
                    onClick: async () => {
                    const ok = await confirmDialog(isInstalled ? `从 profile 移除「${name}」？` : `安装「${name}」到工作空间？`, { title: isInstalled ? '移除插件' : '安装插件', danger: isInstalled, okText: isInstalled ? '移除' : '安装' })
                    if (ok) void act(item, isInstalled ? 'uninstall' : 'install')
                  },
                  }, busy === item.id ? '处理中…' : isInstalled ? '移除' : '安装'),
                  h('button', { className: 'ds-btn', style: { marginLeft: 'auto', opacity: .7 }, onClick: () => void removeItem(item) }, '删条目'),
                ),
              )
            }),
          ),
        adding
          ? h('div', { className: 'ds-panel', style: { marginTop: 14 } },
            h('div', { className: 'ds-panel-head' }, '添加条目'),
            h('div', { className: 'ds-panel-body' },
              h('div', { className: 'ds-field' },
                h('div', { className: 'ds-label' }, '显示名'),
                h(TextField, { className: 'ds-input', value: form.name, placeholder: '代码评审助手', onChange: e => setForm({ ...form, name: e.target.value }) }),
              ),
              h('div', { className: 'ds-field' },
                h('div', { className: 'ds-label' }, '包名或路径'),
                h(TextField, { className: 'ds-input', value: form.spec, placeholder: '@company/dsh-reviewer 或 link:/home/lyf/pkgs/reviewer', onChange: e => setForm({ ...form, spec: e.target.value }) }),
              ),
              h('div', { className: 'ds-field' },
                h('div', { className: 'ds-label' }, '一句话说明'),
                h(TextField, { className: 'ds-input', value: form.description, placeholder: '自动跑 GitLab MR 的评审清单', onChange: e => setForm({ ...form, description: e.target.value }) }),
              ),
            ),
            h('div', { style: { padding: '0 14px 14px' } },
              h('button', { className: 'ds-btn ds-btn-primary', disabled: saving || form.name.trim() === '' || form.spec.trim() === '', onClick: () => void addItem() }, saving ? '添加中…' : '加入市场'),
            ),
          )
          : null,
      )
    }

    // -------------------------------------------------------------- settings

    // --------------------------------------------------- enterprise panels

    /** Shared little editor frame: a list of rows plus one open draft. */

    /** Shared right-side editor drawer: fixed head, scrollable form, fixed action bar. */


    /**
     * 统一登录（LDAP）：配置连接 + 测试连接 + 开不开「必须登录」。
     * 服务账号密码只往服务端写一次（存进 0600 的密钥文件），这里永远不回显。
     */


    const STRATEGIES = [
      { id: 'round_robin', label: '轮询：谁手上活少给谁' },
      { id: 'best_match', label: '按专长匹配：领域 / 角色位 / 技能' },
      { id: 'lead', label: '交给专家团团长分派' },
    ]

    const ACCESS_ROLE_OPTIONS = [
      { id: 'admin', label: '管理员', hint: '能改配置、删数据、发布版本' },
      { id: 'member', label: '成员', hint: '能建卡、推卡、评论、跑用例' },
      { id: 'viewer', label: '只读', hint: '只能看，不能动' },
    ]

    const ROUTE_LABEL = {
      '/config': '改配置',
      '/task/create': '新建卡',
      '/task/update': '改卡',
      '/task/delete': '删卡',
      '/task/block': '标记阻塞',
      '/task/unblock': '解除阻塞',
      '/task/comment': '评论',
      '/task/artifact': '登记交付物',
      '/task/artifact/sync': '归档交付物',
      '/task/checklist': '勾验收清单',
      '/task/case': '登记用例',
      '/task/case/run': '跑接口用例',
      '/task/coding': '登记 AI Coding',
      '/task/worktree': 'worktree 操作',
      '/mention': '点名派活',
      '/agents/run': '手动派单',
      '/agents/stop': '停止派单',
      '/experts/save': '存专家',
      '/experts/delete': '删专家',
      '/teams/save': '存专家团',
      '/teams/delete': '删专家团',
      '/skills/save': '存技能',
      '/skills/delete': '删技能',
      '/projects/save': '存项目',
      '/projects/delete': '删项目',
      '/release/save': '存版本',
      '/release/publish': '发布版本',
      '/release/rollback': '回滚版本',
      '/release/approve': '审批版本',
      '/requirement/save': '存需求',
      '/requirement/delete': '删需求',
      '/access/save': '改成员权限',
      '/access/delete': '删成员',
      '/audit/clear': '清空审计日志',
      '/market/install': '装插件',
      '/market/uninstall': '卸插件',
    }


    function Settings({ state, onChanged, initialSection, onSection }) {
      const config = state.config
      const [form, setForm] = React.useState({
        boardTitle: config.board.title,
        gitlabUrl: config.gitlab.url,
        gitlabGroup: config.gitlab.group,
        gitlabProject: config.gitlab.project,
        gitlabToken: '',
        feishuAppId: config.feishu.appId,
        feishuAppSecret: '',
        feishuChatId: config.feishu.chatId,
        feishuBaseToken: config.feishu.baseToken,
        feishuTableId: config.feishu.tableId,
        feishuWebhook: '',
        feishuNotify: config.feishu.notifyOnChange !== false,
        gitlabSyncEnabled: config.gitlab.syncEnabled === true,
        gitlabSyncLabel: config.gitlab.syncLabel ?? '',
        roles: JSON.parse(JSON.stringify(config.roles)),
        agentsEnabled: config.agents?.enabled === true,
        agentsMaxConcurrent: String(config.agents?.maxConcurrent ?? 2),
        agentsPreset: config.agents?.agentPreset ?? 'standard',
        agentsWorkspace: config.agents?.workspaceDir ?? '',
        agentsSandbox: config.agents?.sandbox ?? 'workspace-write',
        agentsIsolation: config.agents?.isolation ?? 'none',
        agentsWorktreeRoot: config.agents?.worktreeRoot ?? '',
        agentsCleanup: config.agents?.cleanupWorktree ?? 'manual',
        agentsAuto: Array.isArray(config.agents?.autoStatuses) ? config.agents.autoStatuses : ['design', 'dev_ready', 'test'],
      })
      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const save = async () => {
        setBusy(true); setError(null); setStatus(null)
        try {
          await api('/config', {
            board: { title: form.boardTitle },
            roles: form.roles,
            agents: {
              enabled: form.agentsEnabled,
              maxConcurrent: Number(form.agentsMaxConcurrent) || 2,
              agentPreset: form.agentsPreset,
              workspaceDir: form.agentsWorkspace,
              sandbox: form.agentsSandbox,
              isolation: form.agentsIsolation,
              worktreeRoot: form.agentsWorktreeRoot,
              cleanupWorktree: form.agentsCleanup,
              autoStatuses: form.agentsAuto,
            },
          })
          setStatus('已保存')
          await onChanged()
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
      }

      const field = (key, label, hint, type) => h('div', { className: 'ds-field', key },
        h('div', { className: 'ds-label' }, label),
        h(TextField, {
          className: 'ds-input',
          type: type ?? 'text',
          value: form[key],
          placeholder: hint ?? '',
          onChange: e => setForm({ ...form, [key]: e.target.value }),
        }),
      )

      const roleKeys = Object.keys(form.roles)
      const [section, setSection] = React.useState(initialSection ?? 'experts')

      React.useEffect(() => {
        if (typeof initialSection === 'string' && initialSection !== '') setSection(initialSection)
      }, [initialSection])

      const pickSection = next => {
        setSection(next)
        onSection?.(next)
      }

      const PANE_META = {
        projects: ['项目与迭代', '项目是看板的第一层分组：卡片挂项目、项目下面划迭代，之后按项目/迭代筛选和考核。'],
        experts: ['专家', '每个专家是一个能独立接活的工作单元。角色位决定它接哪一列，业务领域决定它懂哪块业务，角色提示词和技能决定它怎么做。'],
        teams: ['专家团', '团长负责拆活和汇总，成员各自干活；评论里 @团名 就交给团长。'],
        skills: ['技能库', '技能是一段可复用的做法。写进技能库后会落成 SKILL.md，专家在需要时自己加载，也可以自己新增。'],
        columns: ['列的负责人', '看板每一列默认派给谁。选「默认」用系统自带的那一位。'],
        gitlab: ['代码仓库', '一个仓库一条记录：地址、路径、令牌各自独立，同步时互不干扰。'],
        feishu: ['飞书机器人', '卡片状态变化时往群里发消息。可以按团队或项目建多个机器人。'],
        agents: ['自动派单', '卡片进入勾选的列时，自动把活派给该列的负责人；这里是全局开关与并发上限。'],
        models: ['模型', '每个角色位用哪个模型。单个专家还能在「专家」里单独覆盖。'],
        testing: ['测试执行', '接口用例跑在哪、能访问哪些域名、超时多少。执行器就跑在这台机器上（.218），不依赖外部 CI。'],
        costs: ['成本与预算', '一个月允许派多少次活、跑多少小时，超了在效能页亮黄亮红。'],
        environments: ['部署环境', '版本可以登记「上过哪个环境」，只留痕：平台不接 CD，不会触发任何部署。'],
        board: ['看板外观', '看板顶部显示的标题。'],
        access: ['权限与审计', '启用成员名单后，每个写操作都要认人：只读不能改，成员能推进卡，管理员才能改配置、删数据、发布版本。所有写操作都会进下面的审计日志。'],
        ldap: ['统一登录（LDAP）', '用公司账号登录平台：登录成功后服务端记住这个人，写操作和审计都挂在他的名字下。密码只存服务端密钥文件，不回显。'],
        storage: ['数据与备份', '台账存在哪、密钥存在哪，以及每次写操作留下的快照。改坏了可以回滚到上一版。'],
        health: ['集成健康', '飞书通知、GitLab、飞书云盘、代码隔离四条外部通道最近一次是成功还是失败。以前这些失败只写进日志，现在会在这里亮出来，坏了能看见、能补一次。'],
      }

      const saveBar = h('div', { className: 'ds-row', style: { gap: 10, marginTop: 2 } },
        h('button', { className: 'ds-btn ds-btn-primary', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存'),
        status !== null ? h('span', { className: 'ds-ok' }, status) : null,
        error !== null ? h('span', { className: 'ds-err' }, error) : null,
      )

      const nav = [
        { group: '团队' },
        { id: 'projects', label: '项目与迭代', count: (config.projects ?? []).length },
        { id: 'experts', label: '专家', count: (config.experts ?? []).length },
        { id: 'teams', label: '专家团', count: (config.teams ?? []).length },
        { id: 'skills', label: '技能库' },
        { id: 'columns', label: '列的负责人' },
        { group: '接入' },
        { id: 'gitlab', label: '代码仓库', count: (config.gitlab.projects ?? []).length },
        { id: 'feishu', label: '飞书机器人', count: (config.feishu.bots ?? []).length },
        { id: 'health', label: '集成健康', count: state.integrations?.broken ?? 0 },
        { group: '运行' },
        { id: 'agents', label: '自动派单' },
        { id: 'testing', label: '测试执行', count: (config.testing?.envs ?? []).length },
        { id: 'costs', label: '成本与预算' },
        { id: 'environments', label: '部署环境', count: (config.environments ?? []).length },
        { id: 'board', label: '看板外观' },
        { group: '安全' },
        { id: 'ldap', label: '统一登录（LDAP）', count: config.ldap?.enabled === true ? (config.ldap?.requireLogin === true ? '必须' : '开') : 0 },
        { id: 'access', label: '权限与审计', count: (config.access?.members ?? []).length },
        { id: 'storage', label: '数据与备份', count: state.storage?.snapshots ?? 0 },
      ]

      const paneFor = id => {
        if (id === 'projects') return h(BusinessPanel, { config, onChanged })
        if (id === 'experts') return h(ExpertsPanel, { config, onChanged })
        if (id === 'teams') return h(TeamsPanel, { config, onChanged })
        if (id === 'skills') return h(SkillsPanel, { config, onChanged })
        if (id === 'columns') return h(ColumnsPanel, { state, onChanged })
        if (id === 'testing') return h(TestingPanel, { config, onChanged })
        if (id === 'costs') return h(CostsPanel, { config, onChanged })
        if (id === 'environments') return h(EnvironmentsPanel, { config, onChanged })
        if (id === 'access') return h(AccessPanel, { state, config, onChanged })
        if (id === 'ldap') return h(LdapPanel, { config, onChanged })
        if (id === 'storage') return h(StoragePanel, { state, onChanged })
        if (id === 'gitlab') return h(ReposPanel, { config, onChanged })
        if (id === 'feishu') return h('div', null, h(BotsPanel, { config, onChanged }), h(EscalatePanel, { config, onChanged }))
        if (id === 'health') return h(HealthPanel, { state, config, onChanged })
        if (id === 'board') {
          return h('div', null,
            h('div', { className: 'ds-panel ds-form-panel' },
              h('div', { className: 'ds-panel-head' }, '看板'),
              h('div', { className: 'ds-panel-body' }, field('boardTitle', '看板标题', '需求&任务工作空间')),
            ),
            saveBar,
          )
        }
        if (id === 'models') {
          return h('div', null,
            h('div', { className: 'ds-panel ds-form-panel' },
              h('div', { className: 'ds-panel-head' }, '角色与模型'),
              h('div', { className: 'ds-panel-body ds-grid2' },
                roleKeys.map(role => h('div', { className: 'ds-field', key: role },
                  h('div', { className: 'ds-label' }, `${ROLE_LABEL[role] ?? role}`),
                  h(TextField, {
                    className: 'ds-input',
                    value: form.roles[role].model,
                    placeholder: 'deepseek-v4.1-flash',
                    onChange: e => setForm({ ...form, roles: { ...form.roles, [role]: { ...form.roles[role], model: e.target.value } } }),
                  }),
                )),
              ),
            ),
            h('div', { className: 'ds-hint', style: { margin: '-6px 0 12px' } }, '单个专家可以在「专家」里单独指定模型，优先级：专家模型 → 这里的角色模型 → 宿主默认。'),
            saveBar,
          )
        }
        // agents
        return h('div', null,
          h('div', { className: 'ds-panel ds-form-panel' },
            h('div', { className: 'ds-panel-head' }, '自动派单（专家 agent）'),
            h('div', { className: 'ds-panel-body' },
              h('div', { className: 'ds-field', style: { gridColumn: '1 / -1' } },
                h('label', { className: 'ds-row', style: { alignItems: 'center', gap: 8, cursor: 'pointer' } },
                  h(CheckField, { checked: form.agentsEnabled,
                    onChange: e => setForm({ ...form, agentsEnabled: e.target.checked }),
                  }),
                  h('span', {}, '卡片进入勾选的列时，自动派给该列的负责人'),
                ),
                h('div', { className: 'ds-hint' }, '关闭后仍可在卡片抽屉里点「马上处理」手动派单；派单结果会写回评论并推进卡片。'),
              ),
              h('div', { className: 'ds-field', style: { gridColumn: '1 / -1' } },
                h('div', { className: 'ds-label' }, '哪些列自动派单'),
                h('div', { className: 'ds-row', style: { flexWrap: 'wrap', gap: 14 } },
                  [['design', '待方案'], ['dev_ready', '待开发'], ['dev', '开发中'], ['test', '待测试']].map(([id, label]) =>
                    h('label', { className: 'ds-row', key: id, style: { alignItems: 'center', gap: 6, cursor: 'pointer' } },
                      h(CheckField, { checked: form.agentsAuto.includes(id),
                        onChange: e => setForm({
                          ...form,
                          agentsAuto: e.target.checked
                            ? [...form.agentsAuto, id]
                            : form.agentsAuto.filter(entry => entry !== id),
                        }),
                      }),
                      h('span', {}, label),
                    )),
                ),
                h('div', { className: 'ds-hint' }, '勾选的列在卡片进入时自动派给该列对应的负责人；其余列只能手动「马上处理」。'),
              ),
              field('agentsMaxConcurrent', '同时最多几个 agent', '2'),
              field('agentsPreset', 'Agent 预设', 'standard'),
              field('agentsWorkspace', '工作区目录', '/home/lyf/dsh-workspace'),
              h('div', { className: 'ds-hint', style: { gridColumn: '1 / -1' } }, '预设决定 agent 手里有哪些工具：standard 带 shell 与文件读写，minimal 只有基础工具。'),
              h('div', { className: 'ds-field', key: 'agentsSandbox' },
                h('div', { className: 'ds-label' }, '沙箱档位（这个会话能写哪、能跑什么）'),
                h(SelectField, {
                  className: 'ds-input',
                  value: form.agentsSandbox,
                  onChange: e => setForm({ ...form, agentsSandbox: e.target.value }),
                },
                  [['read-only', '只读：能看不能改'],
                    ['workspace-write', '只写工作区（推荐）：能改自己的目录，改不到系统别处'],
                    ['danger-full-access', '无沙箱：可以写任何地方（危险）']].map(([id, label]) =>
                    h('option', { key: id, value: id }, label)),
                ),
                h('div', { className: 'ds-hint' }, '由 DSH 的 permission preset 执行：read-only / workspace-write 走 bwrap 或 Landlock 隔离。单个专家可以在「专家」里覆盖。'),
              ),
              h('div', { className: 'ds-field', key: 'agentsIsolation' },
                h('div', { className: 'ds-label' }, '代码隔离'),
                h(SelectField, {
                  className: 'ds-input',
                  value: form.agentsIsolation,
                  onChange: e => setForm({ ...form, agentsIsolation: e.target.value }),
                },
                  [['none', '不隔离：所有卡共用一个工作区'],
                    ['worktree', '一卡一个 git worktree（推荐给多卡并行）']].map(([id, label]) =>
                    h('option', { key: id, value: id }, label)),
                ),
                h('div', { className: 'ds-hint' }, '开启后，卡要挂在配了「本机代码目录」的项目上，派单时会为它切一条 task/<编号> 分支。'),
              ),
              field('agentsWorktreeRoot', 'worktree 根目录', '留空 = 工作区同级的 dsh-worktrees'),
              h('div', { className: 'ds-field', key: 'agentsCleanup' },
                h('div', { className: 'ds-label' }, '卡完成时'),
                h(SelectField, {
                  className: 'ds-input',
                  value: form.agentsCleanup,
                  onChange: e => setForm({ ...form, agentsCleanup: e.target.value }),
                },
                  [['manual', '保留 worktree 和分支，等人看 diff'],
                    ['on_done', '自动删掉 worktree 和分支']].map(([id, label]) =>
                    h('option', { key: id, value: id }, label)),
                ),
              ),
            ),
          ),
          saveBar,
        )
      }

      return h('div', { className: 'ds-settings' },
        h('div', { className: 'ds-settings-nav' },
          nav.map((item, index) => item.group !== undefined
            ? h('div', { className: 'ds-settings-nav-group', key: `group-${index}` }, item.group)
            : tipOf(
              (PANE_META[item.id] ?? [item.label, ''])[1] || item.label,
              h('button', {
                key: item.id,
                className: 'ds-nav-item',
                'data-active': section === item.id ? '1' : '0',
                onClick: () => pickSection(item.id),
              },
                h('span', {}, item.label),
                item.count === undefined ? null : h('span', { className: 'ds-nav-count' }, String(item.count))))),
        ),
        h('div', { className: 'ds-settings-pane' },
          h('div', { className: 'ds-pane-head' },
            h('div', null,
              h('div', { className: 'ds-pane-title' }, (PANE_META[section] ?? ['设置'])[0]),
              h('div', { className: 'ds-pane-desc' }, (PANE_META[section] ?? ['', ''])[1]),
            ),
          ),
          paneFor(section)),
      )
    }

    // ------------------------------------------------------------------ page

    function NewTaskDialog({ state, onClose, onCreated }) {
      const projects = state?.config?.projects ?? []
      const [title, setTitle] = React.useState('')
      const [requirement, setRequirement] = React.useState('')
      const [type, setType] = React.useState('requirement')
      const [priority, setPriority] = React.useState('normal')
      const [severity, setSeverity] = React.useState('p2')
      const [domain, setDomain] = React.useState('')
      const requirements = state?.requirements ?? []
      const [requirementId, setRequirementId] = React.useState('')
      const [project, setProject] = React.useState(projects.length === 1 ? projects[0].id : '')
      const [iteration, setIteration] = React.useState('')
      const [owner, setOwner] = React.useState('')
      const [due, setDue] = React.useState('')
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const isBug = type === 'bug'
      const projectIterations = (projects.find(item => item.id === project)?.iterations ?? [])
      const submit = async () => {
        setBusy(true); setError(null)
        try {
          await api('/task/create', {
            title, requirement, type, priority, domain,
            severity: isBug ? severity : '',
            role: isBug ? 'dev' : 'product',
            status: isBug ? 'dev_ready' : 'clarify',
            project, iteration: project === '' ? '' : iteration,
            owner: owner.trim(), dueAt: fromDateInput(due),
            requirementId,
          })
          await onCreated()
          onClose()
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
      }
      return h('div', { className: 'ds-modal-wrap', onClick: e => { if (e.target === e.currentTarget) onClose() } },
        h('div', { className: 'ds-modal' },
          h('h3', {}, isBug ? '登记缺陷' : '新建任务'),
          h('div', { className: 'ds-field' },
            h('div', { className: 'ds-label' }, '标题'),
            h(TextField, {
              className: 'ds-input', autoFocus: true,
              placeholder: isBug ? '一句话说清什么坏了，例如「优惠券叠加后金额算错」' : '一句话说清要做什么',
              value: title,
              onChange: e => setTitle(e.target.value),
              onKeyDown: e => { if (e.key === 'Enter' && !e.isComposing) void submit() },
            }),
          ),
          h('div', { className: 'ds-field' },
            h('div', { className: 'ds-label' }, isBug ? '复现步骤 / 现象' : '需求 / 背景'),
            h(MdField, {
              className: 'ds-textarea', rows: 5,
              placeholder: isBug
                ? '复现步骤：1… 2…\n实际结果：\n期望结果：\n影响范围 / 环境（版本、账号、数据条件）：'
                : '背景、期望结果、验收口径。专家会照这段去开工。',
              value: requirement, onChange: e => setRequirement(e.target.value),
            }),
          ),
          h('div', { className: 'ds-modal-grid' },
            h('div', { className: 'ds-field' },
              h('div', { className: 'ds-label' }, '类型'),
              h(SelectField, { className: 'ds-select', value: type, onChange: e => setType(e.target.value) },
                Object.keys(TYPE_LABEL).map(v => h('option', { key: v, value: v }, TYPE_LABEL[v]))),
            ),
            isBug
              ? h('div', { className: 'ds-field' },
                h('div', { className: 'ds-label' }, '严重级别'),
                h(SelectField, { className: 'ds-select', value: severity, onChange: e => setSeverity(e.target.value) },
                  Object.keys(SEVERITY_LABEL).map(v => h('option', { key: v, value: v }, SEVERITY_LABEL[v]))),
              )
              : h('div', { className: 'ds-field' },
                h('div', { className: 'ds-label' }, '优先级'),
                h(SelectField, { className: 'ds-select', value: priority, onChange: e => setPriority(e.target.value) },
                  Object.keys(PRIORITY_LABEL).map(v => h('option', { key: v, value: v }, PRIORITY_LABEL[v]))),
              ),
            isBug
              ? h('div', { className: 'ds-field' },
                h('div', { className: 'ds-label' }, '优先级'),
                h(SelectField, { className: 'ds-select', value: priority, onChange: e => setPriority(e.target.value) },
                  Object.keys(PRIORITY_LABEL).map(v => h('option', { key: v, value: v }, PRIORITY_LABEL[v]))),
              )
              : null,
            h('div', { className: 'ds-field', style: { gridColumn: '1 / -1' } },
              h('div', { className: 'ds-label' }, '挂在哪个需求下'),
              requirements.length === 0
                ? h('div', { className: 'ds-hint', style: { fontSize: 11.5 } }, '还没有需求。到「需求」页先建一条，这张卡就能拿到 DEV-001 这样的编号。')
                : h(SelectField, { className: 'ds-select', value: requirementId, onChange: e => setRequirementId(e.target.value) },
                  h('option', { value: '' }, '暂不挂需求（编号留空）'),
                  requirements.map(item => h('option', { key: item.id, value: item.id }, `${item.code || item.id} · ${item.title}`)),
                ),
            ),
            h('div', { className: 'ds-field', style: { gridColumn: '1 / -1' } },
              h('div', { className: 'ds-label' }, '业务领域（选填）'),
              h(TextField, {
                className: 'ds-input', placeholder: '例如 支付 / 会员 / 履约，填了会自动派给同领域的专家',
                value: domain, onChange: e => setDomain(e.target.value),
              }),
            ),
            projects.length === 0
              ? null
              : h('div', { className: 'ds-field' },
                h('div', { className: 'ds-label' }, '业务项目'),
                h(SelectField, {
                  className: 'ds-select', value: project,
                  onChange: e => { setProject(e.target.value); setIteration('') },
                },
                  h('option', { value: '' }, '不属于任何项目'),
                  projects.map(item => h('option', { key: item.id, value: item.id }, `${item.key ? `${item.key} · ` : ''}${item.name}`)),
                ),
              ),
            projects.length === 0 || projectIterations.length === 0
              ? null
              : h('div', { className: 'ds-field' },
                h('div', { className: 'ds-label' }, '迭代'),
                h(SelectField, { className: 'ds-select', value: iteration, onChange: e => setIteration(e.target.value) },
                  h('option', { value: '' }, '不指定迭代'),
                  projectIterations.map(item => h('option', { key: item.id, value: item.id }, item.name))),
              ),
            h('div', { className: 'ds-field' },
              h('div', { className: 'ds-label' }, '业务负责人（选填）'),
              h(TextField, {
                className: 'ds-input', placeholder: '提需求的人，例如 张伟',
                value: owner, onChange: e => setOwner(e.target.value),
              }),
            ),
            h('div', { className: 'ds-field' },
              h('div', { className: 'ds-label' }, '期望完成（选填）'),
              h(TextField, { className: 'ds-input', type: 'date', value: due, onChange: e => setDue(e.target.value) }),
            ),
          ),
          isBug
            ? h('div', { className: 'ds-hint', style: { fontSize: 11.5 } },
              '缺陷卡会直接落到「待开发」，由研发先复现、定位根因再修，修完自动交给测试验证。')
            : null,
          h('div', { className: 'ds-modal-foot' },
            error !== null ? h('span', { className: 'ds-err' }, error) : null,
            h('div', { className: 'ds-grow' }),
            h('button', { className: 'ds-btn', onClick: onClose }, '取消'),
            h('button', { className: 'ds-btn ds-btn-primary', disabled: busy || title.trim() === '', onClick: () => void submit() },
              busy ? '创建中…' : (isBug ? '登记缺陷' : '创建')),
          ),
        ),
      )
    }

    function ProjectsOverview({ state, onOpenBoard }) {
      const [metrics, setMetrics] = React.useState(null)
      const [error, setError] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        api('/metrics')
          .then(out => { if (alive) setMetrics(out.metrics) })
          .catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)) })
        return () => { alive = false }
      }, [state.revision])

      if (error !== null) return h('div', { className: 'ds-body' }, h('div', { className: 'ds-err' }, error))
      if (metrics === null) return h('div', { className: 'ds-loading' }, '正在统计…')

      const card = (title, subtitle, data, key) => h('div', { className: 'ds-proj-card', key },
        h('div', { className: 'ds-proj-head' },
          h('div', null,
            h('div', { className: 'ds-proj-name' }, title),
            h('div', { className: 'ds-hint' }, subtitle),
          ),
          h('button', { className: 'ds-btn', onClick: () => onOpenBoard(key) }, '看这些卡'),
        ),
        h('div', { className: 'ds-proj-stats' },
          h('div', null, h('b', {}, data.inProgress), h('span', {}, '进行中')),
          h('div', null, h('b', { 'data-warn': data.blocked > 0 ? '1' : '0' }, data.blocked), h('span', {}, '阻塞')),
          h('div', null, h('b', { 'data-warn': data.overdue > 0 ? '1' : '0' }, data.overdue), h('span', {}, '逾期')),
          h('div', null, h('b', {}, data.done), h('span', {}, '已完成')),
          h('div', null, h('b', {}, `${data.checklistRate}%`), h('span', {}, '清单完成')),
          h('div', null, h('b', {}, data.artifacts), h('span', {}, '交付物')),
        ),
        h('div', { className: 'ds-proj-bar' },
          h('div', { className: 'ds-check-bar', 'data-full': data.checklistRate === 100 ? '1' : '0' },
            h('span', { style: { width: `${data.checklistRate}%` } }),
          ),
        ),
        data.cycleDays > 0 ? h('div', { className: 'ds-hint' }, `平均周期 ${data.cycleDays} 天 · 近 7 天完成 ${data.throughput7d} 张`) : h('div', { className: 'ds-hint' }, `近 7 天完成 ${data.throughput7d} 张`),
      )

      return h('div', { className: 'ds-body' },
        h('div', { className: 'ds-proj-grid' },
          (metrics.projects ?? []).map(project => card(
            `${project.key ? `[${project.key}] ` : ''}${project.name}`,
            `${(project.iterations ?? []).length} 个迭代`,
            project.metrics,
            project.id,
          )),
          metrics.unassigned !== null && metrics.unassigned.total > 0
            ? card('未归属项目', '还没挂到项目上的卡', metrics.unassigned, '')
            : null,
        ),
        (metrics.projects ?? []).length === 0 && (metrics.unassigned === null || metrics.unassigned.total === 0)
          ? h('div', { className: 'ds-empty' }, '还没有卡片。先去「设置 → 项目与迭代」建一个项目，再新建任务。')
          : null,
      )
    }


    /** 效能页：一次通过率、返工率、周期分布、每列停留、AI 采纳情况。 */
    /* 燃尽用折线 + 面积：柱状图在「剩余 0–2」时全被压成 2px 小横线，看不出趋势。 */


    /** 发布页：版本 = 一批卡 + 门禁 + 发布说明。 */


    /** 需求页：左侧需求清单，右侧一条需求的完整链路（卡 / 清单 / 用例 / 产物 / MR）。 */


    // ------------------------------------------------------------------ 工作台

    /** 工作台：先看风险，再看流程，最后是能点进去的清单。 */

    // ------------------------------------------------------------------ 主页面

    /* 键盘可达性 --------------------------------------------------------------
       这个界面里大量「按钮」其实是带 onClick 的 div/span（卡片、页签、chip、行内小按钮），
       Tab 聚焦不到、读屏也读不出来。与其改几百个调用点，不如在 DOM 层补一层：
       凡是计算样式 cursor:pointer 的元素都补上 tabindex / role=button / Enter·Space 激活，
       并把 data-on 同步成 aria-pressed。只处理新增节点，开销可控。 */
    const KB_TAG_SKIP = { INPUT: 1, TEXTAREA: 1, SELECT: 1, BUTTON: 1, A: 1, OPTION: 1 }
    // 只有「长得像可点东西」的节点才值得量一次 cursor：全量 getComputedStyle 会强制样式重算，
    // 275 个节点就要 600ms 以上（需求页切换时实测 685ms 长任务）。
    const KB_CANDIDATE = '[data-on],[data-role],[role="button"],[tabindex],[class*="ds-"]'
    // 读：只量 cursor，绝不改 DOM。批量调用时不会引发「读→写→读」的强制同步布局。
    function kbClickable(el) {
      if (el === null || el.nodeType !== 1) return false
      if (KB_TAG_SKIP[el.tagName] === 1) return false
      if (el.dataset.kb === '1') return false
      if (typeof el.className === 'string' && el.className.indexOf('mask') >= 0) return false
      if (el.getAttribute('contenteditable') === 'true') return false
      let cursor = ''
      try { cursor = window.getComputedStyle(el).cursor } catch (error) { cursor = '' }
      return cursor === 'pointer'
    }
    // 写：补键盘可达性。与读数分开调用，写完不再回读样式。
    function applyKeyboardSupport(el) {
      el.dataset.kb = '1'
      if (el.getAttribute('tabindex') === null) el.setAttribute('tabindex', '0')
      if (el.getAttribute('role') === null) el.setAttribute('role', 'button')
      const on = el.getAttribute('data-on')
      if (on !== null) el.setAttribute('aria-pressed', on === '1' ? 'true' : 'false')
      if (el.getAttribute('aria-label') === null) {
        const label = String(el.getAttribute('title') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80)
        if (label.length > 0) el.setAttribute('aria-label', label)
      }
      el.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        if (el.getAttribute('aria-disabled') === 'true') return
        event.preventDefault()
        el.click()
      })
    }
    // 看板横向滚动：滚轮默认滚页面，这里改成滚列（shift+滚轮保留给浏览器）。
// 必须用原生非 passive 监听，React 的 onWheel 在 root 上是 passive，preventDefault 会被忽略。
function installBoardWheel() {
  if (typeof document === 'undefined') return () => {}
  const handler = event => {
    const target = event.target
    const board = target instanceof Element ? target.closest('.ds-board') : null
    if (board === null) return
    if (board.scrollWidth <= board.clientWidth + 1) return
    if (event.shiftKey) return
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
    board.scrollLeft += event.deltaY
    event.preventDefault()
  }
  document.addEventListener('wheel', handler, { passive: false })
  return () => document.removeEventListener('wheel', handler)
}

function installKeyboardActivation() {
      if (typeof document === 'undefined') return () => undefined
      const patched = new WeakSet()
      const queue = []
      let scheduled = false
      const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
      const retried = new WeakSet()
      const retry = []
      let retryTimer = null
      const pump = () => {
        scheduled = false
        const deadline = now() + 6
        const batch = []
        while (queue.length > 0 && batch.length < 60 && now() < deadline) batch.push(queue.pop())
        // 阶段一：只读（不伴随写操作，不会逐节点强制重算样式）
        const hits = []
        const misses = []
        for (const el of batch) {
          if (el.isConnected === false) continue
          if (kbClickable(el)) hits.push(el)
          else misses.push(el)
        }
        // 阶段二：只写
        for (const el of hits) { patched.add(el); applyKeyboardSupport(el) }
        // 挂载瞬间样式可能还没生效（卡片先渲染、主题类后挂），400ms 后再看一次
        let fresh = false
        for (const el of misses) {
          if (retried.has(el)) continue
          retried.add(el)
          if (el.isConnected !== false) { retry.push(el); fresh = true }
        }
        if (fresh && retryTimer === null) {
          retryTimer = window.setTimeout(() => {
            retryTimer = null
            queue.push(...retry.splice(0))
            schedule()
          }, 400)
        }
        if (queue.length > 0) schedule()
      }
      const schedule = () => {
        if (scheduled === true) return
        scheduled = true
        if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(pump, { timeout: 300 })
        else window.setTimeout(pump, 16)
      }
      const scan = () => {
        const root = document.querySelector('[data-dsh-studio]')
        if (root === null) return
        // 只收候选节点，且把处理摊到空闲帧里，单帧最多占 6ms。
        for (const el of root.querySelectorAll(KB_CANDIDATE)) {
          if (patched.has(el) || retried.has(el) || el.dataset.kb === '1') continue
          queue.push(el)
        }
        if (queue.length > 0) schedule()
      }
      scan()
      let timer = null
      const observer = new MutationObserver(() => {
        if (timer !== null) return
        timer = window.setTimeout(() => { timer = null; scan() }, 200)
      })
      observer.observe(document.body, { childList: true, subtree: true })
      return () => observer.disconnect()
    }

    /**
     * 统一登录：服务端开了 requireLogin 又没带会话时，/state 会返回 locked，
     * 这里就盖一层登录框。用户名 = LDAP 账号（sAMAccountName / uid / mail 都试）。
     */
    function LoginGate({ config, theme, message, onDone, onClose, overlay }) {
      const localName = String(config?.localAuth?.username ?? 'admin')
      const localReady = config?.localAuth?.enabled !== false
      const ldapReady = config?.ldap?.enabled === true
      const [mode, setMode] = React.useState(ldapReady ? 'ldap' : 'local')
      const [username, setUsername] = React.useState(ldapReady ? '' : localName)
      const [password, setPassword] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(message ?? '')

      const switchMode = next => {
        if (next === mode) return
        setMode(next)
        setError('')
        setPassword('')
        setUsername(next === 'local' ? localName : '')
      }

      const submit = async () => {
        if (busy) return
        if (username.trim() === '' || password === '') {
          setError(mode === 'local' ? '本地账号和密码都要填' : '域账号和密码都要填')
          return
        }
        setBusy(true)
        setError('')
        try {
          const payload = await api('/auth/login', { username: username.trim(), password, mode })
          setSessionToken(payload.token)
          setAuthUser(payload.user ?? null)
          setUserName(String(payload.user?.name ?? payload.user?.id ?? username.trim()))
          setPassword('')
          onDone()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }

      const tabs = h('div', { className: 'ds-seg', style: { alignSelf: 'flex-start' } },
        h('button', {
          className: 'ds-seg-btn',
          type: 'button',
          'data-on': mode === 'ldap' ? '1' : '0',
          disabled: !ldapReady,
          title: ldapReady ? '用公司目录（LDAP）的账号登录' : 'LDAP 还没启用，先在设置里配好再用',
          onClick: () => switchMode('ldap'),
        }, 'LDAP 账号'),
        h('button', {
          className: 'ds-seg-btn',
          type: 'button',
          'data-on': mode === 'local' ? '1' : '0',
          disabled: !localReady,
          title: '用平台自带的超管账号登录',
          onClick: () => switchMode('local'),
        }, '本地超管'),
      )

      const hint = mode === 'ldap'
        ? h('div', { className: 'ds-login-hint' },
            '用公司账号登录（LDAP）。登录后会记下你的名字，写操作和审计都挂在这个名字下。')
        : h('div', { className: 'ds-login-hint' },
            `用平台自带的超管账号登录。默认账号 ${localName}，默认口令 admin（改过之后就用新口令）。`)

      const card = h('div', { className: 'ds-login' },
            h('div', { className: 'ds-login-brand' }, '◈ ', config?.board?.title ?? '工作空间'),
            tabs,
            hint,
            h('label', { className: 'ds-field' },
              h('span', null, mode === 'local' ? '超管账号' : '域账号'),
              h('input', {
                value: username,
                autoFocus: mode === 'ldap',
                name: 'studio-account',
                autoComplete: 'off',
                spellCheck: false,
                placeholder: mode === 'local' ? localName : '域账号',
                onChange: event => setUsername(event.target.value),
                onKeyDown: event => { if (event.key === 'Enter') void submit() },
              }),
            ),
            h('label', { className: 'ds-field' },
              h('span', null, '密码'),
              h('input', {
                type: 'password',
                value: password,
                autoFocus: mode === 'local',
                name: 'studio-pass',
                // 用 new-password 而不是 current-password：浏览器就不会把这里当成「可保存的登录表单」，
                // 也就不会在每次登录后弹保存密码/微软账户同步窗口（那是浏览器自己的行为，不是平台的）
                autoComplete: 'new-password',
                placeholder: mode === 'local' ? '默认口令 admin' : '域密码',
                onChange: event => setPassword(event.target.value),
                onKeyDown: event => { if (event.key === 'Enter') void submit() },
              }),
            ),
            error === '' ? null : h('div', { className: 'ds-error' }, error),
            error !== '' && /LDAP|域|目录|连不上/.test(error)
              ? h('div', { className: 'ds-login-note' }, '连不上目录服务时，切到「本地超管」用平台账号进来；等网络打通再用域账号。')
              : null,
            h('div', { className: 'ds-login-actions' },
              h('button', {
                className: 'ds-btn ds-btn-primary',
                disabled: busy,
                onClick: () => void submit(),
              }, busy ? '登录中…' : (mode === 'local' ? '登录（本地超管）' : '登录（LDAP）')),
              typeof onClose === 'function'
                ? h('button', { className: 'ds-btn ds-btn-ghost', onClick: () => onClose() }, '先不登录')
                : null,
            ),
            h('div', { className: 'ds-login-note' },
              mode === 'ldap'
                ? `${config?.ldap?.url ?? '—'} · BASE：${config?.ldap?.baseDN ?? '—'}`
                : `本地账号存在服务端密钥里（scrypt 哈希），改密码在「设置 → 统一登录（LDAP）」`),
        )
      const wrap = h('div', { className: 'ds-login-wrap', 'data-overlay': overlay === true ? '1' : '0' }, card)
      if (overlay === true) return wrap
      return h('div', { 'data-dsh-studio': '', 'data-theme': theme }, h('style', null, CSS), wrap)
    }

    function StudioPage(props) {
      // The bundled build swaps in the shadcn login card; the standalone artifact
      // (no build step) keeps the hand-written one below.
      const LoginGateView = props?.loginGate ?? LoginGate
      const { state, error, reload } = useStudio()
      const [tab, setTab] = React.useState('dashboard')
      const [settingsSection, setSettingsSection] = React.useState('experts')
      const [openId, setOpenId] = React.useState(null)
      const [creating, setCreating] = React.useState(false)
      /** 命令面板里「先选动作、再选卡」的动作真正落地。 */
      async function runPaletteAction(item) {
        const statuses = state?.statuses ?? []
        const statusLabel = id => (statuses.find(entry => entry.id === id)?.label ?? id)
        const card = (state?.tasks ?? []).find(entry => entry.id === item.cardId)
        const cardName = card === undefined ? item.cardId : ((card.code ?? '') + ' ' + card.title).trim()
        try {
          if (item.action === 'card-advance') {
            const next = nextStatusOf(state, item.cardId)
            if (next === null) { toast('这张卡已经在最后一列了', 'error'); return }
            await api('/task/update', { id: item.cardId, status: next })
            toast('已把「' + cardName + '」推进到「' + statusLabel(next) + '」')
            await reload(true)
            return
          }
          if (item.action === 'card-dispatch') {
            const expert = (state?.config?.experts ?? []).find(entry => entry.id === item.expertId)
            await api('/agents/run', { id: item.cardId, expert: item.expertId })
            toast('已派给 ' + (expert === undefined ? item.expertId : expert.emoji + expert.name))
            await reload(true)
            return
          }
          if (item.action === 'card-comment') {
            const body = await promptDialog('给「' + cardName + '」留一句话', { title: '卡片留言', placeholder: '例如：压测已通过，可以进评审' })
            if (body === null || String(body).trim() === '') return
            await api('/task/comment', { id: item.cardId, body: String(body).trim() })
            toast('留言已发到「' + cardName + '」')
            await reload(true)
          }
        } catch (cause) {
          toast(cause instanceof Error ? cause.message : String(cause), 'error')
        }
      }
      // 统一的「新建」入口：一个按钮弹出「需求 / 任务」两项，两个页面不再各放一个。
      const [newMenu, setNewMenu] = React.useState(false)
      const [newReq, setNewReq] = React.useState(0)
      React.useEffect(() => {
        if (!newMenu) return undefined
        const off = () => setNewMenu(false)
        document.addEventListener('click', off)
        return () => document.removeEventListener('click', off)
      }, [newMenu])
      const [theme, setTheme] = React.useState(currentTheme)
      const [hostTheme, setHostTheme] = React.useState(() => hostScheme() ?? (systemDarkQuery()?.matches ? 'dark' : 'light'))
      const [showLogin, setShowLogin] = React.useState(false)
      // 全局搜索：⌘K / Ctrl+K 打开，选到哪条就跳到哪条。
      const [paletteOpen, setPaletteOpen] = React.useState(false)
      const [focusReq, setFocusReq] = React.useState(null)
      React.useEffect(() => {
        const onKey = event => {
          if (!(event.metaKey || event.ctrlKey) || String(event.key).toLowerCase() !== 'k') return
          event.preventDefault()
          setPaletteOpen(value => !value)
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [])

      // 「跟随系统」实际跟宿主界面：系统深浅色变化、宿主自己换主题都要跟上（1.5s 轮询足够，成本可忽略）
      React.useEffect(() => {
        const read = () => {
          const next = hostScheme() ?? (systemDarkQuery()?.matches ? 'dark' : 'light')
          setHostTheme(previous => (previous === next ? previous : next))
        }
        read()
        const query = systemDarkQuery()
        const onChange = () => read()
        if (query !== null) query.addEventListener('change', onChange)
        const timer = window.setInterval(read, 1500)
        return () => {
          if (query !== null) query.removeEventListener('change', onChange)
          window.clearInterval(timer)
        }
      }, [])

      const resolvedTheme = theme === 'system' ? hostTheme : theme

      // 主题覆盖整个页面（含宿主侧栏/顶栏），不只是工作区子树。
      React.useEffect(() => {
        const root = document.documentElement
        root.setAttribute('data-dsh-theme', resolvedTheme)
        root.style.colorScheme = resolvedTheme
        let node = document.getElementById('dsh-studio-global-theme')
        if (node === null) {
          node = document.createElement('style')
          node.id = 'dsh-studio-global-theme'
          node.textContent = GLOBAL_THEME_CSS
          document.head.appendChild(node)
        }
        return () => {
          root.removeAttribute('data-dsh-theme')
          root.style.colorScheme = ''
        }
      }, [resolvedTheme])


      // 键盘可达性：挂载后给「可点的 div」补 tabindex/role，卸载时断开观察
      React.useEffect(() => installKeyboardActivation(), [])
  React.useEffect(() => installBoardWheel(), [])

      if (state === null) {
        return h('div', { 'data-dsh-studio': '', 'data-theme': resolvedTheme },
          h('style', null, CSS),
          h('div', { className: 'ds-loading' }, error === null ? '正在载入工作空间…' : `载入失败：${error}`),
        )
      }
      if (state.locked === true) {
        return h(LoginGateView, { config: state.config, theme: resolvedTheme, message: '', onDone: () => void reload() })
      }
      const openTask = openId === null ? null : state.tasks.find(t => t.id === openId) ?? null
      const counts = state.tasks.reduce((acc, task) => { acc[task.status] = (acc[task.status] ?? 0) + 1; return acc }, {})

      return h('div', { 'data-dsh-studio': '', 'data-theme': resolvedTheme },
        h('style', null, CSS),
        h(DialogHost, null),
        h(ToastHost, null),
        h('div', { className: 'ds-head' },
          h('div', { className: 'ds-head-top' },
            h('div', { className: 'ds-brand' },
              h('span', { className: 'ds-brand-mark' }, '◈'),
              h('div', null,
                h('div', { className: 'ds-title' }, state.config.board.title),
                h('div', { className: 'ds-sub' }, `${state.tasks.length} 个任务 · rev ${state.revision} · 更新于 ${fmtTime(state.updatedAt)}`),
              ),
            ),
            h('div', { className: 'ds-head-actions' },
              authUser() === null
                ? h(ChipField, {
                    className: 'ds-chip',
                    'data-on': '1',
                    title: '没配 LDAP 时平台默认以超管身份使用，不需要登录；写操作与审计都记在它名下',
                  }, `👤 超管 ${state.config.localAuth?.username ?? 'admin'}`)
                : h(ChipField, { className: 'ds-chip', title: `已登录：${authUser()?.id ?? ''}` }, `👤 ${authUser()?.name ?? authUser()?.id}`),
              authUser() === null
                ? h('button', { className: 'ds-btn ds-btn-ghost', title: '用域账号或本地超管账号登录', onClick: () => setShowLogin(true) }, '登录')
                : tipOf('退出当前账号（退出后回到超管身份）', h('button', {
                    className: 'ds-btn ds-btn-ghost',
                    onClick: async () => {
                      try { await api('/auth/logout', {}) } catch { /* 会话可能已过期 */ }
                      setSessionToken('')
                      setAuthUser(null)
                      setShowLogin(false)
                      void reload()
                    },
                  }, '退出登录')),
              (() => {
                const Seg = kit('SegGroup')
                const options = THEMES.map(([id, label]) => ({ id, label }))
                if (Seg !== null) {
                  return h(Seg, { value: theme, onChange: next => setTheme(setThemeName(next)), options })
                }
                return h('div', { className: 'ds-seg', title: '显示模式；「跟随系统」会先跟宿主界面的深浅色，宿主没给出信号时再跟操作系统' },
                  THEMES.map(([id, label]) => h('button', {
                    key: id,
                    className: 'ds-seg-btn',
                    'data-on': theme === id ? '1' : '0',
                    onClick: () => setTheme(setThemeName(id)),
                  }, label)),
                )
              })(),
              h('button', { className: 'ds-btn', onClick: () => void reload() }, '刷新'),
              h('a', {
                className: 'ds-btn ds-btn-ghost',
                style: { textDecoration: 'none' },
                href: '/studio-api/export/tasks.csv',
                title: '把看板上的卡导出成 CSV（Excel 可直接打开）',
              }, '导出卡'),
              h('a', {
                className: 'ds-btn ds-btn-ghost',
                style: { textDecoration: 'none' },
                href: '/studio-api/export/requirements.csv',
                title: '把需求与准出情况导出成 CSV',
              }, '导出需求'),
              (state.integrations?.broken ?? 0) > 0
                ? h('button', {
                    className: 'ds-btn ds-btn-ghost',
                    style: { color: '#e5484d', borderColor: 'color-mix(in srgb, #e5484d 40%, var(--ds-line))' },
                    title: (state.integrations.channels ?? []).filter(item => item.state === 'error').map(item => `${item.label}：${item.lastError}`).join('\n'),
                    onClick: () => { setTab('settings'); setSettingsSection('health') },
                  }, `⚠ 集成异常 ${state.integrations.broken}`)
                : null,
              h('div', { className: 'ds-newmenu', style: { position: 'relative' } },
                h('button', {
                  className: 'ds-btn ds-btn-primary',
                  'aria-haspopup': 'menu',
                  'aria-expanded': newMenu ? 'true' : 'false',
                  onClick: event => { event.stopPropagation(); setNewMenu(value => !value) },
                }, '＋ 新建'),
                newMenu
                  ? h('div', {
                    role: 'menu',
                    className: 'ds-menu',
                    style: { position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 80, minWidth: 232, padding: 6, background: 'var(--ds-surface)', border: '1px solid var(--ds-line)', borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,.22)' },
                    onClick: event => event.stopPropagation(),
                  },
                    h('button', { role: 'menuitem', className: 'ds-btn ds-btn-ghost', style: { display: 'block', width: '100%', textAlign: 'left', height: 'auto', padding: '9px 10px' }, title: '先建需求，再按功能点拆卡', onClick: () => { setNewMenu(false); setTab('requirements'); setNewReq(count => count + 1) } },
                      h('div', { style: { fontWeight: 600 } }, '新建需求'),
                      h('div', { className: 'ds-hint', style: { marginTop: 2 } }, '需求 → 功能点 → 拆成卡'),
                    ),
                    h('button', { role: 'menuitem', className: 'ds-btn ds-btn-ghost', style: { display: 'block', width: '100%', textAlign: 'left', height: 'auto', padding: '9px 10px', marginTop: 2 }, title: '直接在看板上建一张卡', onClick: () => { setNewMenu(false); setTab('board'); setCreating(true) } },
                      h('div', { style: { fontWeight: 600 } }, '新建任务'),
                      h('div', { className: 'ds-hint', style: { marginTop: 2 } }, '直接在看板上建一张卡'),
                    ),
                  )
                  : null,
              ),
            ),
          ),
          h('div', { className: 'ds-head-tabs' },
            (() => {
              const Tabs = kit('TabsBar')
              const TRoot = kit('Tabs')
              const TList = kit('TabsList')
              const TItem = kit('TabsTrigger')
              const items = [
                { id: 'dashboard', label: '工作台', hint: '今天该看什么：在办、逾期、阻塞、缺陷超时、准出被拦' },
                { id: 'board', label: '看板', hint: '按列推进卡片；点开卡片能看计划、交付物、测试、讨论' },
                { id: 'requirements', label: '需求', hint: '需求、功能点、可追溯矩阵与需求级准出' },
                { id: 'releases', label: '版本', hint: '版本清单、发布门禁、灰度与部署记录' },
                { id: 'projects', label: '项目', hint: '业务项目、迭代与每个服务对应的代码目录' },
                { id: 'analytics', label: '效能', hint: '周期分布、每列停留、团队负载、返工与 AI 成本' },
                { id: 'settings', label: '设置', hint: '列、模型、自动派单、集成、权限、备份' },
              ]
              if (TRoot !== null && TList !== null && TItem !== null) {
                return h(TRoot, { value: tab, onValueChange: next => setTab(next) },
                  h(TList, { className: '' },
                    items.map(item => h(TItem, {
                      key: item.id,
                      value: item.id,
                      title: item.hint,
                      className: '',
                    }, item.label))))
              }
              if (Tabs !== null) {
                return h(Tabs, { items, value: tab, onChange: next => setTab(next) })
              }
              return h('div', { className: 'ds-tabs' },
                items.map(item => h('button', {
                  key: item.id,
                  className: 'ds-tab',
                  'data-on': tab === item.id ? '1' : '0',
                  onClick: () => setTab(item.id),
                }, item.label)),
              )
            })(),
            h('div', { className: 'ds-grow' }),
            h('span', { className: 'ds-stat' },
              tab === 'dashboard'
                ? '今天该看什么：风险 · 流程 · 待办'
                : tab === 'board'
                ? `${(state.config.experts ?? []).filter(expert => expert.enabled !== false).length} 位专家 · ${(state.config.teams ?? []).length} 个专家团`
                : tab === 'requirements'
                  ? `${(state.requirements ?? []).length} 条需求 · ${state.tasks.filter(task => (task.requirementId ?? '') === '').length} 张卡未挂需求`
                  : tab === 'releases'
                    ? `${(state.releases ?? []).length} 个版本 · ${state.tasks.filter(task => (task.releaseId ?? '') !== '').length} 张卡已挂版本`
                  : tab === 'projects'
                    ? `${(state.config.projects ?? []).length} 个项目`
                    : tab === 'analytics'
                      ? '过程指标：通过率 · 返工 · 周期'
                    : tab === 'settings'
                      ? '改动即时生效，技能与专家保存在 ~/.dsh'
                      : '内部插件市场'),
          ),
        ),
        error !== null
          ? h('div', { className: 'ds-err', style: { padding: '6px 18px' } }, error)
          : null,
        tab === 'board'
          ? h(Board, { state, onWip: async (status, current) => { const raw = await promptDialog(`这一列的 WIP 上限（0 = 不限，最多 50）`, { title: 'WIP 上限', defaultValue: String(current) }); if (raw === null) return; const value = Math.min(50, Math.max(0, Math.trunc(Number(String(raw).trim()) || 0))); try { await api('/columns/wip', { status, wip: value }); toast(value === 0 ? '已取消 WIP 上限' : `WIP 上限设为 ${value}`); await reload() } catch (cause) { toast(cause instanceof Error ? cause.message : String(cause), 'error') } }, onMove: async (id, status) => { await api('/task/update', { id, status }); await reload() }, onOpen: setOpenId })
          : tab === 'dashboard'
            ? h(DashboardPage, { state, onOpenTask: setOpenId, onOpenBoard: () => setTab('board') })
          : tab === 'requirements'
            ? h(RequirementsPage, { state, onOpenTask: setOpenId, onChanged: reload, createSignal: newReq, focusReq })
            : tab === 'releases'
              ? h(ReleasesPage, { state, onOpenTask: setOpenId })
            : tab === 'projects'
              ? h(ProjectsOverview, { state, onOpenBoard: () => setTab('board') })
              : tab === 'analytics'
                ? h(AnalyticsPage, { state, onOpenTask: setOpenId })
              : tab === 'market'
                ? h('div', { className: 'ds-body' }, h(Market, { state, onChanged: reload }))
                : h('div', { className: 'ds-body' }, h(Settings, { state, onChanged: reload, initialSection: settingsSection, onSection: setSettingsSection })),
        paletteOpen
          ? h(Palette, {
              state,
              onClose: () => setPaletteOpen(false),
              onPick: item => {
                if (item.kind === 'run') { void runPaletteAction(item); return }
                if (item.kind === 'task') { setOpenId(item.id); return }
                if (item.kind === 'requirement') { setTab('requirements'); setFocusReq({ id: item.id, at: Date.now() }); return }
                if (item.kind === 'release') { setTab('releases'); return }
                if (item.kind === 'expert') { setTab('settings'); setSettingsSection('experts'); return }
                if (item.kind === 'team') { setTab('settings'); setSettingsSection('teams'); return }
                if (item.kind === 'project') { setTab('projects'); return }
                if (item.kind === 'skill') { setTab('settings'); setSettingsSection('skills'); return }
                if (item.kind !== 'action') return
                if (item.id === 'new-requirement') { setTab('requirements'); setNewReq(n => n + 1); return }
                if (item.id === 'new-task') { setTab('board'); setCreating(true); return }
                if (item.id.startsWith('tab:')) { setTab(item.id.slice(4)); return }
                if (item.id === 'export:tasks') { window.open('/studio-api/export/tasks.csv', '_blank'); return }
                if (item.id === 'export:requirements') { window.open('/studio-api/export/requirements.csv', '_blank'); return }
                if (item.id.startsWith('theme:')) { setTheme(setThemeName(item.id.slice(6))); return }
                if (item.id === 'refresh') { void reload(); return }
                if (item.id.startsWith('settings:')) { setTab('settings'); setSettingsSection(item.id.slice(9)) }
              },
            })
          : null,
        openTask !== null ? h(Drawer, { task: openTask, state, onClose: () => setOpenId(null), onChanged: reload }) : null,
        creating ? h(NewTaskDialog, { state, onClose: () => setCreating(false), onCreated: reload }) : null,
        showLogin && state.locked !== true
          ? h(LoginGateView, {
              config: state.config,
              theme: resolvedTheme,
              message: '',
              overlay: true,
              onDone: () => { setShowLogin(false); void reload() },
              onClose: () => setShowLogin(false),
            })
          : null,
      )
    }

    // ------------------------------------------------------------------ icon

    function StudioIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('rect', { x: 1.5, y: 2.5, width: 4, height: 11, rx: 1 }),
        h('rect', { x: 6, y: 2.5, width: 4, height: 7, rx: 1 }),
        h('rect', { x: 10.5, y: 2.5, width: 4, height: 9, rx: 1 }),
      )
    }

    // ----------------------------------------------------------------- mount

    return {
      inject: ['slots'],
      apply(ctx) {
        const disposers = []
        const page = StudioPage
        disposers.push(ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: PANEL_ID }, page,
        )))
        disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 12, label: () => '需求&任务工作空间' }, StudioIcon,
        )))
        const cleanup = () => { for (const dispose of disposers.splice(0).reverse()) dispose() }
        if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
        return cleanup
      },
    }
  },
})