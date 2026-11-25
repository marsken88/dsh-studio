// 脚本侧的会话换成：没有浏览器，就得自己拿启动 token 换 cookie。
// 这一层错了的症状是「一堆 401，看起来像业务坏了」，所以错误文案与幂等都要锁住。
import assert from 'node:assert/strict'
import test from 'node:test'

import { launchTokenFromEnv, resetStudioCookie, studioCookie, studioFetch, studioJson } from '../tools/lib/studio-auth.mjs'

const fakeResponse = (status, setCookies) => ({
  status,
  headers: {
    getSetCookie: () => setCookies,
    get: name => (name.toLowerCase() === 'set-cookie' ? (setCookies[0] ?? null) : null),
  },
})

test('没有 token 时说清楚缺什么，而不是发一个必 401 的请求', async () => {
  resetStudioCookie()
  let called = 0
  await assert.rejects(
    () => studioCookie('http://127.0.0.1:1', '', async () => { called += 1; return fakeResponse(200, ['a=b']) }),
    /缺少 STUDIO_TOKEN/u,
  )
  assert.equal(called, 0, '缺 token 时不该真发请求')
})

test('换到 cookie 就回放它，同一个 base 只换一次', async () => {
  resetStudioCookie()
  let called = 0
  const fetchStub = async url => {
    called += 1
    assert.match(String(url), /\?token=tok-123$/u, 'token 要拼在 ?token= 上')
    return fakeResponse(200, ['dsh-auth-127.0.0.1:18080=abc.def; Path=/; HttpOnly'])
  }
  const first = await studioCookie('http://127.0.0.1:18080', 'tok-123', fetchStub)
  const second = await studioCookie('http://127.0.0.1:18080', 'tok-123', fetchStub)
  assert.equal(first, 'dsh-auth-127.0.0.1:18080=abc.def')
  assert.equal(second, first)
  assert.equal(called, 1, '同一个 base 不该反复换')
})

test('换不到 cookie 时抛错并点名 token / 鉴权，别让人误会成业务失败', async () => {
  resetStudioCookie()
  await assert.rejects(
    () => studioCookie('http://127.0.0.1:18080', 'stale', async () => fakeResponse(401, [])),
    /换不到会话 cookie（HTTP 401）/u,
  )
})

test('studioFetch / studioJson 带上 cookie 并拼对地址', async () => {
  resetStudioCookie()
  const seen = []
  const fetchStub = async (url, init) => {
    seen.push({ url: String(url), cookie: init?.headers?.cookie, method: init?.method })
    if (String(url).includes('?token=')) return fakeResponse(200, ['sid=1'])
    return { ok: true, status: 200, text: async () => '{"state":{"revision":7}}' }
  }
  const api = studioFetch('http://127.0.0.1:18080/', 'tok', fetchStub)
  const json = await studioJson(api, '/studio-api/state')
  assert.equal(json.state.revision, 7)
  const call = seen.find(item => item.url.includes('/studio-api/state'))
  assert.equal(call.cookie, 'sid=1', '业务请求必须带回会话 cookie')
  assert.equal(call.url, 'http://127.0.0.1:18080/studio-api/state', 'base 末尾的斜杠要去掉，别拼出双斜杠')
})

test('非 2xx 直接抛，正文摘要带在错误里', async () => {
  resetStudioCookie()
  const fetchStub = async url => (String(url).includes('?token=')
    ? fakeResponse(200, ['sid=1'])
    : { ok: false, status: 403, text: async () => '{"error":"跨站请求被拒绝"}' })
  const api = studioFetch('http://127.0.0.1:18080', 'tok', fetchStub)
  await assert.rejects(() => studioJson(api, '/studio-api/state'), /HTTP 403.*跨站请求被拒绝/u)
})

test('launchTokenFromEnv 只认 STUDIO_TOKEN，并去掉空白', () => {
  assert.equal(launchTokenFromEnv({ STUDIO_TOKEN: '  abc  ' }), 'abc')
  assert.equal(launchTokenFromEnv({}), '')
})
