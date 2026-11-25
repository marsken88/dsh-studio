#!/usr/bin/env node
/**
 * 空数据探针：把 /studio-api/state 换成一"刚装好、什么都没建"的样子，再走一遍所有页签。
 *
 *   STUDIO_TOKEN=… STUDIO_BASE=http://<host>:18080 npm run verify:empty
 *
 * 为什么要它：issue #6（空看板 `Cannot access 're'…`）就是因为我们的实例有 31 张卡，
 * 那条短路分支根本没走到。新装用户没有数据 —— 这是**完全不同的代码路径**，
 * 以前没有任何探针覆盖。
 *
 * 做法：真实拉一份 state，把集合清空（config 保留，页签才渲染得出来），用 CDP 拦截
 * /studio-api/state 的响应替换掉；不改服务器上的任何数据。
 */
import { createRequire } from 'node:module'
import { launchTokenFromEnv, studioFetch } from '../lib/studio-auth.mjs'

const require = createRequire(import.meta.url)
const puppeteer = require('puppeteer-core')

const token = String(process.env.STUDIO_TOKEN ?? '').trim()
const baseUrl = String(process.env.STUDIO_BASE ?? '').trim().replace(/\/+$/, '')
if (token === '' || baseUrl === '') {
  console.error('需要 STUDIO_TOKEN 与 STUDIO_BASE')
  process.exit(2)
}
/* `/studio-api` 过宿主信任栅栏：没有已认证的浏览器会话的请求一律 401。脚本没有浏览器，
   用 dsh web 的启动 token 换 cookie（见 tools/lib/studio-auth.mjs）。 */
const api = studioFetch(baseUrl, launchTokenFromEnv())
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 刚装好：没有卡、没有需求、没有版本、没有项目。config 保留（里面是专家/列/模板）。 */
function emptyStateOf(state) {
  return {
    ...state,
    tasks: [],
    requirements: [],
    releases: [],
    projects: [],
    suites: [],
    analytics: null,
    metrics: null,
    dashboard: null,
    insight: null,
  }
}

const real = await api('/studio-api/state', { headers: { 'x-studio-user': 'empty-probe' } })
const realJson = await real.json()
const state = realJson?.state ?? realJson
if (state === undefined || state === null) {
  console.error('拉不到 /state，无法构造空数据')
  process.exit(2)
}
const empty = emptyStateOf(state)
console.log(`空数据：tasks=${empty.tasks.length} requirements=${empty.requirements.length} releases=${empty.releases.length}`)

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width: 1600, height: 1000 },
})
const page = await browser.newPage()
/* 宿主登录也可能只认 cookie（?token= 是 agent 面板的入口）。STUDIO_COOKIE 支持
   「name=value; name2=value2」，在做登录的实例上跑探针时用（值从浏览器 cookie 里取）。 */
const cookieSpec = String(process.env.STUDIO_COOKIE ?? "").trim()
if (cookieSpec !== "") {
  const origin = new URL(baseUrl)
  const parsed = cookieSpec.split(";").map(part => part.trim()).filter(Boolean).map(part => {
    const at = part.indexOf("=")
    return at > 0 ? { name: part.slice(0, at), value: part.slice(at + 1), domain: origin.hostname, path: "/" } : null
  }).filter(Boolean)
  if (parsed.length > 0) await page.setCookie(...parsed)
}
const errors = []
const HOST_NOISE = /client-modules: duplicate factory registration for "@deepseek-ai\//
page.on('pageerror', error => { if (!HOST_NOISE.test(String(error))) errors.push(String(error).slice(0, 200)) })
page.on('console', message => {
  if (message.type() !== 'error') return
  const text = String(message.text() ?? '')
  if (HOST_NOISE.test(text)) return
  errors.push('console: ' + text.slice(0, 200))
})
await page.setRequestInterception(true)
page.on('request', async request => {
  const url = request.url()
  if (/\/studio-api\/state(\?|$)/.test(url)) {
    await request.respond({
      status: 200,
      contentType: 'application/json',
      headers: { etag: '"empty-probe"' },
      body: JSON.stringify({ ok: true, state: empty }),
    })
    return
  }
  await request.continue()
})

const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); return ok }
const crashed = async () => (await page.evaluate(() => document.body.innerText.includes('渲染失败')))

try {
  await page.goto(`${baseUrl}/?token=${token}`, { waitUntil: 'networkidle2', timeout: 60000 })
  await sleep(2500)
  await page.evaluate(() => {
    const node = [...document.querySelectorAll('*')].find(el => el.children.length === 0 && (el.textContent || '').trim() === '需求&任务工作空间')
    node?.closest('button,a,li,[role="button"],[tabindex]')?.click()
  })
  await page.waitForSelector('[data-dsh-studio]', { timeout: 30000 })
  await sleep(1500)

  const tabs = await page.$$eval('[data-dsh-studio] [data-head-tabs] button', nodes => nodes.map(node => node.textContent.trim()))
  check('面板能起来', tabs.length > 0, tabs.join('/'))

  for (const name of tabs) {
    for (const tab of await page.$$('[data-dsh-studio] [data-head-tabs] button')) {
      if (((await tab.evaluate(node => node.textContent)) || '').trim() === name) { await tab.click(); break }
    }
    await sleep(900)
    const isCrashed = await crashed()
    check(`[${name}] 空数据下不崩`, isCrashed === false, isCrashed ? '页面出现「渲染失败」' : '')
  }

  // 看板这一屏单独盯：issue #6 就发生在"0 张卡"这个分支
  for (const tab of await page.$$('[data-dsh-studio] [data-head-tabs] button')) {
    if (((await tab.evaluate(node => node.textContent)) || '').trim() === '看板') { await tab.click(); break }
  }
  await sleep(1000)
  const board = await page.evaluate(() => {
    const text = document.body.innerText
    return {
      hasEmptyCopy: text.includes('还没有任何卡'),
      crashed: text.includes('渲染失败'),
      cards: document.querySelectorAll('[data-dsh-studio] [data-kanban-card]').length,
    }
  })
  check('空看板给出「还没有任何卡」的引导', board.hasEmptyCopy === true, JSON.stringify(board))
  check('空看板没有卡片', board.cards === 0, String(board.cards))
} catch (error) {
  check('探针跑完', false, String(error?.message ?? error).slice(0, 160))
} finally {
  await browser.close()
}

for (const item of checks) console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}${item.detail ? ' — ' + item.detail : ''}`)
for (const error of errors.slice(0, 5)) console.log('FAIL pageerror — ' + error)
const failed = checks.filter(item => !item.ok).length + errors.length
console.log(failed === 0
  ? `\n空数据巡检通过：${checks.length} 项（空数据下所有页签不崩，空看板有引导）`
  : `\n空数据巡检不通过：${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
