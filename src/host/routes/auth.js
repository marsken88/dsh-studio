import { hashLocalPassword, sanitizeLdap, sanitizeLocalAuth, verifyLocalPassword } from '../domain.js'

let host = {
  sendJson: () => {},
  readJsonBody: async () => ({}),
  recordAudit: async () => {},
  recordLogin: async () => {},
  issueSession: () => ({ token: '', expiresAt: 0 }),
  sessionOf: () => null,
  operatorOf: () => '',
  ldapAuthenticate: async () => ({ ok: false }),
  ldapLookup: async () => ({ ok: false, entries: [] }),
  ldapAttr: () => '',
  sessions: new Map(),
  dropSession: () => {},
  hasSessionStore: () => false,
  publicState: () => ({}),
}

/** 统一登录相关路由。宿主能力由 configureAuthRoutes() 注入。 */
export function configureAuthRoutes(services) {
  host = { ...host, ...(services ?? {}) }
}

export async function handleAuthRoute({ method, route, req, res, store, url }) {
  if (method === 'POST' && route === '/auth/login') {
    const body = await host.readJsonBody(req)
    const ip = String(req.socket?.remoteAddress ?? '')
    const config = store.snapshot().config
    const settings = sanitizeLdap(config.ldap ?? {})
    /* 中文输入法会把 admin 打成全角 ａｄｍｉｎ，NFKC 归一后再比对，免得
       用户明明敲对了却被告知口令不对（典型：口令框里混进全角字母/空格）。 */
    const username = String(body.username ?? body.user ?? '').trim().normalize('NFKC')
    const password = String(body.password ?? '').normalize('NFKC')
    const wideChar = /[\uFF01-\uFF5E\u3000]/.test(String(body.password ?? ''))
    // mode: local = 只试本地账号；ldap = 只试目录；'' = 先本地后目录（老调用方兼容）
    const mode = String(body.mode ?? '').trim().toLowerCase()

    /* 先试本地超管：没配 LDAP 时它是唯一账号，配了也能在目录故障时兜底。 */
    const local = mode === 'ldap' ? { ok: false, reason: 'skipped' } : verifyLocalPassword(config.localAuth, username, password)
    if (local.ok === true) {
      const localUser = sanitizeLocalAuth(config.localAuth)
      const user = { id: localUser.username, name: '超级管理员', role: 'admin', source: 'local', mail: '', dept: '' }
      const session = host.issueSession(user, ip)
      await host.recordAudit(store, { by: user.name, route, level: 'read', status: 200, ok: true, summary: `本地超管登录成功：${user.id}` })
      host.sendJson(res, 200, { ok: true, token: session.token, expiresAt: session.expiresAt, user, state: host.publicState(store) })
      return true
    }

    if (mode === 'local') {
      const localUser = sanitizeLocalAuth(config.localAuth)
      const hint =
        local.reason === 'nouser'
          ? `没有这个本地账号（本地超管是 ${localUser.username}）`
          : local.reason === 'form'
            ? '账号和密码都要填'
            : wideChar
              ? `口令里有全角字符（中文输入法打出来的），切到英文输入法再输一次；账号 ${localUser.username}${localUser.password === null ? '，默认口令是 admin' : ''}`
              : `本地超管的账号或口令不对（账号 ${localUser.username}${localUser.password === null ? '，还没改过口令就是默认的 admin' : ''}）`
      await host.recordAudit(store, { by: username === '' ? '匿名' : username.slice(0, 40), route, level: 'read', status: 401, ok: false, summary: `本地登录失败：${hint}` })
      host.sendJson(res, 401, { ok: false, code: 'local', error: hint })
      return true
    }

    const result = await host.ldapAuthenticate(settings, username, password)
    if (result.ok !== true) {
      const hint =
        result.code === 'disabled' && local.reason === 'badpass'
          ? `用户名或密码不对（本地超管账号是 ${sanitizeLocalAuth(config.localAuth).username}；LDAP 登录还没启用）`
          : result.message
      await host.recordAudit(store, { by: username === '' ? '匿名' : username.slice(0, 40), route, level: 'read', status: 401, ok: false, summary: `登录失败：${hint}` })
      host.sendJson(res, 401, { ok: false, code: result.code, error: hint })
      return true
    }
    await host.recordLogin(store, result.user, ip)
    const session = host.issueSession(result.user, ip)
    await host.recordAudit(store, { by: result.user.name, route, level: 'read', status: 200, ok: true, summary: `LDAP 登录成功：${result.user.id}` })
    const saved = (store.snapshot().config.users ?? []).find(item => item.id === result.user.id) ?? {}
    host.sendJson(res, 200, { ok: true, token: session.token, expiresAt: session.expiresAt, user: { ...result.user, ...saved }, state: host.publicState(store) })
    return true
  }
  if (method === 'POST' && route === '/auth/password') {
    const body = await host.readJsonBody(req)
    const config = store.snapshot().config
    const local = sanitizeLocalAuth(config.localAuth)
    const username = String(body.username ?? local.username).trim().toLowerCase().normalize('NFKC')
    const currentPassword = String(body.currentPassword ?? '').normalize('NFKC')
    const check = verifyLocalPassword(local, username, currentPassword)
    if (check.ok !== true) {
      host.sendJson(res, 401, { ok: false, code: check.reason, error: check.reason === 'nouser' ? '没有这个本地账号' : '当前密码不对' })
      return true
    }
    const next = String(body.newPassword ?? '').normalize('NFKC')
    if (body.reset !== true && next.length < 8) {
      host.sendJson(res, 400, { ok: false, error: '新密码至少 8 位' })
      return true
    }
    if (body.reset !== true && next === currentPassword) {
      host.sendJson(res, 400, { ok: false, error: '新密码和当前密码一样' })
      return true
    }
    await store.mutate(state => {
      const current = sanitizeLocalAuth(state.config.localAuth)
      state.config.localAuth =
        body.reset === true
          ? { ...current, password: null, mustChange: true, updatedAt: Date.now() }
          : { ...current, password: hashLocalPassword(next), mustChange: false, updatedAt: Date.now() }
    })
    await host.recordAudit(store, { by: host.operatorOf(req), route, level: 'admin', status: 200, ok: true, summary: body.reset === true ? '重置本地超管密码为默认' : '修改本地超管密码' })
    host.sendJson(res, 200, { ok: true, state: host.publicState(store) })
    return true
  }
  if (method === 'GET' && route === '/auth/me') {
    const found = host.sessionOf(req, store.snapshot().config)
    if (found === null) {
      host.sendJson(res, 401, { ok: false, error: '没有登录或会话已过期' })
      return true
    }
    host.sendJson(res, 200, { ok: true, user: found.user, expiresAt: found.session.expiresAt })
    return true
  }
  if (method === 'POST' && route === '/auth/logout') {
    const rawToken = req.headers['x-studio-session']
    const token = String((Array.isArray(rawToken) ? rawToken[0] : rawToken) ?? '').trim()
    if (token !== '') {
      host.sessions.delete(token)
      if (host.hasSessionStore()) host.dropSession(token)
    }
    host.sendJson(res, 200, { ok: true })
    return true
  }
  if (method === 'POST' && route === '/auth/ldap/test') {
    const body = await host.readJsonBody(req)
    const config = store.snapshot().config
    const settings = sanitizeLdap({ ...(config.ldap ?? {}), ...(body.ldap !== null && typeof body.ldap === 'object' ? body.ldap : {}) })
    if (String(body.bindPassword ?? '') !== '') settings.bindPassword = String(body.bindPassword)
    const steps = []
    const started = Date.now()
    const lookup = await host.ldapLookup(settings, String(body.username ?? '').trim() || '*')
    steps.push({ name: '服务账号绑定并查询', ok: lookup.ok === true, message: lookup.ok === true ? `查到 ${lookup.entries.length} 条` : lookup.message, ms: Date.now() - started })
    if (lookup.ok === true && lookup.entries.length > 0) {
      const entry = lookup.entries[0]
      steps.push({
        name: '第一个命中的账号',
        ok: true,
        message: `${host.ldapAttr(entry, 'sAMAccountName') || host.ldapAttr(entry, 'uid') || '(无 sAMAccountName)'} · ${host.ldapAttr(entry, settings.nameAttr) || host.ldapAttr(entry, 'cn') || '(无显示名)'} · ${entry.dn}`,
        ms: 0,
      })
    }
    const ok = steps.every(step => step.ok === true)
    host.sendJson(res, ok ? 200 : 400, { ok, steps, message: ok ? '连接正常，可以保存' : steps.find(step => step.ok !== true)?.message ?? '测试没通过' })
    return true
  }
  return false
}
