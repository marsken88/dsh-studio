/* `/studio-api` 的脚本侧鉴权：用 dsh web 的启动 token 换一个浏览器会话 cookie。
 *
 * 为什么需要：`/studio-api` 现在过宿主的 `connection.requestRejection()` —— Host/Origin
 * 不对回 403，没有已认证的浏览器会话回 401。浏览器打开面板时，那条 `?token=…` 的 URL
 * 会把 cookie 种进浏览器；脚本（e2e-loop / 部署探活 / 用量核对）没有浏览器，得自己换一次。
 *
 * token 从哪来：`dsh web` 启动时打印的 URL，或目标机上
 *   sudo journalctl -u dsh-web -n 50 | grep -o 'token=[A-Za-z0-9_-]*' | tail -1
 * 也就是部署文档里那个 `STUDIO_TOKEN`。
 *
 * 用法：
 *   import { studioFetch, launchTokenFromEnv } from './lib/studio-auth.mjs'
 *   const api = studioFetch('http://127.0.0.1:18080', launchTokenFromEnv())
 *   const res = await api('/studio-api/state')
 *
 * 换不到就**抛**，并且把「缺 token / token 不对」说清楚：静默变成一堆 401 会让人
 * 以为是业务坏了，排查方向全错（2026-11 就有人这么浪费过一轮）。
 */

const COOKIE_CACHE = new Map()

/** 环境变量里的启动 token；没设就返回空串（调用方自己决定报错文案）。 */
export function launchTokenFromEnv(env = process.env) {
  return String(env.STUDIO_TOKEN ?? '').trim()
}

/** 从 Set-Cookie 里取出能回放的 cookie 串（`a=b; c=d`）。 */
function cookiesOf(response) {
  const lines = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(value => value !== null && value !== '')
  const pairs = []
  for (const line of lines) {
    for (const part of String(line).split(/,(?=[^;]+?=)/u)) {
      const pair = part.split(';')[0].trim()
      if (pair.includes('=') && !pair.startsWith('=')) pairs.push(pair)
    }
  }
  return pairs.join('; ')
}

/**
 * 用启动 token 换会话 cookie（同 base 只换一次）。
 * @param base - 例如 `http://127.0.0.1:18080`
 * @param token - `dsh web` 打印的启动 token
 * @param fetchImpl - 注入用（测试拿桩，不真发请求）
 */
export async function studioCookie(base, token, fetchImpl = fetch) {
  const trimmed = String(token ?? '').trim()
  const key = String(base)
  const cached = COOKIE_CACHE.get(key)
  if (cached !== undefined) return cached
  if (trimmed === '') {
    throw new Error('缺少 STUDIO_TOKEN：`/studio-api` 现在要求已认证的浏览器会话，脚本要用 dsh web 的启动 token 换 cookie（目标机上 journalctl -u dsh-web | grep -o \'token=[^&]*\'）')
  }
  const url = new URL(String(base))
  const res = await fetchImpl(`${url.origin}/?token=${encodeURIComponent(trimmed)}`, { redirect: 'manual' })
  const cookie = cookiesOf(res)
  if (cookie === '') {
    throw new Error(`换不到会话 cookie（HTTP ${res.status}）：token 不对，或这个 dsh 没开浏览器鉴权。启动 token 每次 dsh web 重启都会变，去 journalctl 重新取一条。`)
  }
  COOKIE_CACHE.set(key, cookie)
  return cookie
}

/** 清掉缓存（token 换过、或要验证「没登录会 401」时用）。 */
export function resetStudioCookie(base) {
  if (base === undefined) COOKIE_CACHE.clear()
  else COOKIE_CACHE.delete(String(base))
}

/**
 * 造一个带会话的 fetch：`api('/studio-api/state')`、`api('/studio-api/task/update', { method:'POST', body })`。
 * GET/POST 都走它，脚本里原来的 `fetch(BASE + '/studio-api' + path, …)` 换成 `api('/studio-api' + path, …)` 即可。
 */
export function studioFetch(base, token, fetchImpl = fetch) {
  return async function api(path, init = {}) {
    const cookie = await studioCookie(base, token, fetchImpl)
    const headers = { ...(init.headers ?? {}), cookie }
    return fetchImpl(String(base).replace(/\/$/u, '') + path, { ...init, headers })
  }
}

/** 常用形状：GET 一个 JSON 接口，非 2xx 直接抛（带状态码与响应正文摘要）。 */
export async function studioJson(api, path, init = {}) {
  const res = await api(path, init)
  const text = await res.text()
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → HTTP ${res.status}：${text.slice(0, 200)}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${init.method ?? 'GET'} ${path} 返回的不是 JSON：${text.slice(0, 120)}`)
  }
}
