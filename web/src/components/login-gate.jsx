// shadcn/ui login card.
//
// Same props contract as the hand-written LoginGate in client.js, so the legacy
// panel can mount either one: { config, theme, message, onDone, onClose, overlay }.
//
// Sizing follows the studio scale (12–13px text, 36px controls) instead of
// shadcn's default 14px: this card sits inside a dense application panel, and a
// gauge larger than the rest of the page reads as "misaligned".
import * as React from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Input as BoarduiInput, Button as BoarduiButton } from '../boardui/index'
import { Label } from './base/input/label'
import { PillTabList, PillTab } from './base/tabs/pill-tab'

const SESSION_KEY = 'dsh-studio:session'
const AUTH_USER_KEY = 'dsh-studio:auth-user'
const USER_KEY = 'dsh-studio:user'

function put(key, value) {
  try {
    if (value === null || value === undefined || value === '') window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch { /* 隐私模式 */ }
}

async function postLogin(payload) {
  const response = await fetch('/studio-api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.ok !== true) {
    throw new Error(String(data.error ?? `登录失败（HTTP ${response.status}）`))
  }
  return data
}

export function ShadcnLoginGate({ config, theme, message, onDone, onClose, overlay }) {
  const localName = String(config?.localAuth?.username ?? 'admin')
  const localReady = config?.localAuth?.enabled !== false
  const ldapReady = config?.ldap?.enabled === true
  const [mode, setMode] = React.useState(ldapReady ? 'ldap' : 'local')
  const [username, setUsername] = React.useState(ldapReady ? '' : localName)
  const [password, setPassword] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(String(message ?? ''))
  const [showPass, setShowPass] = React.useState(false)
  const passwordRef = React.useRef(null)
  const accountRef = React.useRef(null)

  React.useEffect(() => {
    // Radix Tabs moves focus to the trigger after a switch; focus the field on the
    // next frame so the user can just start typing.
    const id = window.setTimeout(() => {
      // BoardUI 的 Input 不收 ref，直接按 id 聚焦（同一屏只有一个登录卡）
      if (mode === 'local') document.getElementById('studio-pass')?.focus()
      else document.getElementById('studio-account')?.focus()
    }, 30)
    return () => window.clearTimeout(id)
  }, [mode])

  const switchMode = (next) => {
    if (next === mode) return
    setMode(next)
    setError('')
    setPassword('')
    setUsername(next === 'local' ? localName : '')
  }

  const submit = async (event) => {
    if (event) event.preventDefault()
    if (busy) return
    if (username.trim() === '' || password === '') {
      setError(mode === 'local' ? '本地账号和密码都要填' : '域账号和密码都要填')
      return
    }
    setBusy(true)
    setError('')
    try {
      // 中文输入法可能把 admin 打成全角 ａｄｍｉｎ；先归一，服务端也会再归一一次。
      const payload = await postLogin({ username: username.trim().normalize('NFKC'), password: password.normalize('NFKC'), mode })
      put(SESSION_KEY, payload.token)
      put(AUTH_USER_KEY, JSON.stringify(payload.user ?? null))
      put(USER_KEY, String(payload.user?.name ?? payload.user?.id ?? username.trim()))
      setPassword('')
      onDone()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const title = String(config?.board?.title ?? '工作空间')
  const ldapHint = /LDAP|域|目录|连不上/.test(error)

  const card = (
    <div className="w-[380px] shrink-0 overflow-hidden rounded-2xl border border-separator-border bg-background-primary-default py-0 shadow-dropdown">
      <div className="flex flex-col gap-2 px-5 pb-4 pt-5">
        <div className="flex items-center gap-2">
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary text-[13px] leading-none text-primary-foreground"
            aria-hidden
          >
            ◈
          </span>
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold leading-tight text-text-primary">{title}</div>
            <div className="text-[12px] leading-tight text-muted-foreground">需求与任务工作空间</div>
          </div>
        </div>
      </div>

      <div className="px-5 pb-0">
        <PillTabList className="w-full">
          {ldapReady ? (
            <PillTab isSelected={mode === 'ldap'} onSelect={() => switchMode('ldap')}>
              LDAP 账号
            </PillTab>
          ) : null}
          {localReady ? (
            <PillTab isSelected={mode === 'local'} onSelect={() => switchMode('local')}>
              本地超管
            </PillTab>
          ) : null}
        </PillTabList>

        <p className="mb-3 mt-3 text-[12px] leading-relaxed text-muted-foreground">
          {mode === 'ldap'
            ? '用公司目录账号登录，登录后写操作与审计都记在这个名字下。'
            : `用平台自带的超管账号登录。默认 ${localName} / admin，改过之后用新口令。`}
        </p>

        <form className="grid w-full max-w-full gap-3" onSubmit={submit}>
          <div className="grid min-w-0 gap-2">
            <Label htmlFor="studio-account" className="text-[12px] text-muted-foreground">
              {mode === 'local' ? '超管账号' : '域账号'}
            </Label>
            <BoarduiInput
              id="studio-account"
              name="studio-account"
              autoComplete="off"
              spellCheck={false}
              value={username}
              placeholder={mode === 'local' ? localName : '域账号'}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>

          <div className="grid min-w-0 gap-2">
            <Label htmlFor="studio-pass" className="text-[12px] text-muted-foreground">
              密码
            </Label>
            <div className="relative min-w-0">
              <BoarduiInput
                id="studio-pass"
                type={showPass ? 'text' : 'password'}
                name="studio-pass"
                autoComplete="new-password"
                value={password}
                placeholder={mode === 'local' ? '默认口令 admin' : '域密码'}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                aria-label={showPass ? '隐藏密码' : '显示密码'}
                title={showPass ? '隐藏密码' : '显示密码（看清是不是被输入法打成了全角）'}
                onClick={() => setShowPass((prev) => !prev)}
                className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          {error === '' ? null : (
            <div className="flex items-start gap-2 rounded-md border border-destructive/35 bg-destructive/5 px-2 py-2 text-[12px] leading-relaxed text-destructive">
              <span aria-hidden>!</span>
              <span className="min-w-0 break-words">{error}</span>
            </div>
          )}
          {ldapHint ? (
            <div className="text-[12px] leading-relaxed text-muted-foreground">
              连不上目录服务时，切到「本地超管」用平台账号进来；网络打通后再用域账号。
            </div>
          ) : null}

          <BoarduiButton type="submit" disabled={busy} className="w-full">
            {busy ? '登录中…' : (mode === 'local' ? '登录（本地超管）' : '登录（LDAP）')}
          </BoarduiButton>
        </form>
      </div>

      <div className="mt-4 flex flex-col items-stretch gap-2 border-t border-separator-border px-5 py-3">
        <div className="truncate text-[12px] leading-relaxed text-muted-foreground" title={
          mode === 'ldap' ? `${config?.ldap?.url ?? '—'} · BASE ${config?.ldap?.baseDN ?? '—'}` : ''
        }>
          {mode === 'ldap'
            ? `${config?.ldap?.url ?? '—'} · BASE ${config?.ldap?.baseDN ?? '—'}`
            : '口令以 scrypt 哈希存在服务端，改密码在「设置 → 统一登录（LDAP）」'}
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-muted-foreground">
            {mode === 'local' ? '回车即登录' : '账号是域账号，不是邮箱'}
          </span>
          {typeof onClose === 'function' ? (
            <BoarduiButton type="button" variant="ghost" size="sm" onClick={() => onClose()}>
              先不登录
            </BoarduiButton>
          ) : null}
        </div>
      </div>
    </div>
  )

  if (overlay === true) {
    return (
      <div className="fixed inset-0 z-[90] flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm">
        {card}
      </div>
    )
  }
  // Full-page variant: this div *is* the slot content, so it carries the theme
  // scope and the grow behaviour itself; Tailwind classes sit on an inner div
  // because every generated selector is scoped under [data-dsh-studio].
  return (
    <div data-dsh-studio="" data-theme={theme} className="dsh-studio-fill">
      <div className="flex min-h-full w-full items-center justify-center px-6 py-10">
        {card}
      </div>
    </div>
  )
}
