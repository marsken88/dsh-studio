// 密钥撤销通道：/repos/save 与 /bots/save 认 clearToken / clearWebhook，界面有按钮。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { configureConnectRoutes, handleConnectRoute } from '../src/host/routes/connect.js'
import { SecretStore, StudioStore } from '../src/host/store.js'

const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')

const withStore = async fn => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-secret-clear-'))
  const store = new StudioStore(join(dir, 'state.json'), { dbFile: join(dir, 'state.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  try {
    await store.ready
    return await fn(store)
  } finally {
    store.db?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
}

const callRoute = async (store, route, body) => {
  const res = {}
  let payload = null
  configureConnectRoutes({
    readJsonBody: async () => body,
    sendJson: (r, status, out) => { payload = { status, out } },
    publicState: () => ({ config: store.snapshot().config }),
    applyConfig: async (target, patch) => target.mutate(state => {
      if (patch.gitlab?.projects !== undefined) state.config.gitlab.projects = patch.gitlab.projects
      if (patch.feishu?.bots !== undefined) state.config.feishu.bots = patch.feishu.bots
    }),
    upsertById: (list, item) => {
      const rest = (Array.isArray(list) ? list : []).filter(entry => entry.id !== item.id)
      return [...rest, item]
    },
    installedPackages: async () => [],
    runPluginCli: async () => ({ ok: true }),
    getSyncTimer: () => null,
  })
  await handleConnectRoute({ method: 'POST', route, req: {}, res, store, url: new URL('http://x' + route) })
  return payload
}

test('/repos/save：空 token 保留旧值，clearToken 才真的清掉', async () => {
  await withStore(async store => {
    await callRoute(store, '/repos/save', { project: { name: '订单', project: 'ns/order', url: 'https://g.example.com', token: 'glpat-old' } })
    let repo = store.snapshot().config.gitlab.projects[0]
    assert.equal(repo.token, 'glpat-old')

    // 只改名字、token 留空 → 保留
    await callRoute(store, '/repos/save', { project: { ...repo, name: '订单2', token: '' } })
    repo = store.snapshot().config.gitlab.projects[0]
    assert.equal(repo.name, '订单2')
    assert.equal(repo.token, 'glpat-old', '留空表示不修改')

    // 显式清除
    await callRoute(store, '/repos/save', { project: { ...repo, token: '', clearToken: true } })
    repo = store.snapshot().config.gitlab.projects[0]
    assert.equal(repo.token, '', 'clearToken 要把令牌真的清掉，而不是被「保留旧值」兜住')
    assert.equal(Object.prototype.hasOwnProperty.call(repo, 'clearToken'), false, 'clearToken 是动作标记，不该存进记录')
  })
})

test('/bots/save：clearWebhook 能撤销机器人地址', async () => {
  await withStore(async store => {
    await callRoute(store, '/bots/save', { bot: { name: '研发群', webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc' } })
    let bot = store.snapshot().config.feishu.bots[0]
    assert.match(bot.webhook, /hook\/abc/)

    await callRoute(store, '/bots/save', { bot: { ...bot, webhook: '' } })
    bot = store.snapshot().config.feishu.bots[0]
    assert.match(bot.webhook, /hook\/abc/, '留空不修改')

    await callRoute(store, '/bots/save', { bot: { ...bot, webhook: '', clearWebhook: true } })
    bot = store.snapshot().config.feishu.bots[0]
    assert.equal(bot.webhook, '')
  })
})

test('面板：仓库抽屉里给了「清除已保存的 Token」入口（走 clearToken，不是清全局）', () => {
  const panel = source('web/src/studio/panels/integrations.js')
  assert.match(panel, /const clearToken = async \(\) =>/)
  assert.match(panel, /api\('\/repos\/save', \{ project: \{ \.\.\.draft, token: '', clearToken: true \} \}\)/, '要发 clearToken 给这个仓库')
  assert.match(panel, /data-clear-token/)
  assert.match(panel, /确认对话框|confirmDialog\('清掉这个仓库已保存的令牌/, '撤销是不可逆动作，要先确认')
})

test('面板：机器人 Webhook 与 LDAP 服务账号密码也能清除', () => {
  const panel = source('web/src/studio/panels/integrations.js')
  const platform = source('web/src/studio/panels/platform.js')
  assert.match(panel, /clearWebhook: true/, '机器人要能清 webhook')
  assert.match(panel, /data-clear-webhook/)
  assert.match(platform, /const clearBindPassword = async \(\) =>/)
  assert.match(platform, /api\('\/config', \{ ldap: \{ clearBindPassword: true \} \}\)/)
  assert.match(platform, /data-clear-bind-password/)
})
