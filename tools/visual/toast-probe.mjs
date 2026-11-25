/* toast 验收探针：接没接对，只看一件事 —— 触发之后 toast 有没有**真的出现在 portal 里**。
 *
 *   STUDIO_TOKEN=xxx node tools/visual/toast-probe.mjs
 *
 * 断言（任一不满足 → 退出码 1）：
 *   1 面板正常（页签渲染、无渲染失败、pageerror 为空）
 *   2 找到并点了一个**确定会 toast** 的按钮
 *      （用「设置 → 部署环境 → 保存环境」：people.js 里 `toast('已保存 N 个环境')`）
 *   3 [data-dsh-studio-portal] 里出现 role=region 的容器，且高度 > 0（真渲染出条目了）
 *   4 容器在视口内（scoped CSS 没把它甩到屏幕外）
 *   5 约 4 秒后自动消失
 */
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const requireFromRoot = createRequire(resolve(import.meta.dirname, '../..', 'package.json'))
const puppeteer = requireFromRoot('puppeteer-core')
const BASE = process.env.STUDIO_BASE ?? 'http://192.168.120.218:18080'
const TOKEN = process.env.STUDIO_TOKEN ?? ''
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails.push(label)
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1400, height: 900 } })
/* 宿主级别的噪声（不是本插件的错误）：DSH 的模块系统在批量入口/重复拦截时会抛
   client-modules: duplicate factory registration for "@deepseek-ai/…"。
   实测 0.9.1 与 0.9.2 的产物都出现，加载完成后面板正常 —— 单独计数，
   但**只放行 @deepseek-ai/ 开头的核心插件**；提到 dsh-studio 的一律照常报错。 */
const HOST_NOISE = /client-modules: duplicate factory registration for "@deepseek-ai\//
const hostNoise = []
const isHostNoise = text => HOST_NOISE.test(String(text))

const page = await browser.newPage()
/* 宿主只认 cookie 时用 STUDIO_COOKIE（name=value; ...）登录。 */
const cookieSpec = String(process.env.STUDIO_COOKIE ?? '').trim()
if (cookieSpec !== '') {
  const origin = new URL(BASE)
  const parsed = cookieSpec.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const at = part.indexOf('=')
    return at > 0 ? { name: part.slice(0, at), value: part.slice(at + 1), domain: origin.hostname, path: '/' } : null
  }).filter(Boolean)
  if (parsed.length > 0) await page.setCookie(...parsed)
}
const errors = []
page.on('pageerror', (e) => { if (isHostNoise(e)) { hostNoise.push(String(e).slice(0, 120)); return } errors.push(String(e).slice(0, 200)) })
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)) })

await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: 'networkidle2', timeout: 60000 })
await sleep(3000)
await page.evaluate(() => {
  const node = [...document.querySelectorAll('*')].find((el) => el.children.length === 0 && (el.textContent || '').trim() === '需求&任务工作空间')
  node?.closest('button,a,li,[role="button"],[tabindex]')?.click?.()
})
await page.waitForSelector('[data-dsh-studio] [role="tablist"]', { timeout: 45000 })
await sleep(1200)
check('面板正常挂载', true)

// 切到「设置」
await page.evaluate(() => {
  const tab = [...document.querySelectorAll('[data-dsh-studio] [role="tab"]')].find((n) => (n.textContent || '').trim() === '设置')
  tab?.click()
})
await sleep(1800)

// 左栏切到「部署环境」（people.js 的保存环境按钮就在这里）
await page.evaluate(() => {
  const item = [...document.querySelectorAll('[data-dsh-studio] [data-settings-nav] [data-settings-nav-item]')]
    .find((n) => (n.querySelector('span')?.textContent || '').trim() === '部署环境')
  item?.click()
})
await sleep(1800)

// 点「保存环境」——这一步必定调 toast('已保存 N 个环境')
const fired = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('[data-dsh-studio] button')]
  const btn = buttons.find((n) => (n.textContent || '').trim() === '保存环境')
    ?? buttons.find((n) => /保存环境/.test((n.textContent || '').trim()))
  if (btn === undefined) return null
  btn.click()
  return (btn.textContent || '').trim()
})
check('找到并点了「保存环境」（确定会 toast）', fired !== null, String(fired))
await sleep(1800)

const shown = await page.evaluate(() => {
  const portal = document.querySelector('[data-dsh-studio-portal]')
  if (portal === null) return { ok: false, why: '没有 portal 容器' }
  const region = portal.querySelector('[role="region"], [aria-live]')
  if (region === null) return { ok: false, why: 'portal 里没有 region' }
  const r = region.getBoundingClientRect()
  return {
    ok: true,
    text: (region.textContent || '').trim().slice(0, 40),
    h: Math.round(r.height),
    inViewport: r.width > 20 && r.height > 10 && r.bottom > 0 && r.top < window.innerHeight,
  }
})
check('toast 出现在 data-dsh-studio-portal 里', shown.ok === true, shown.why ?? shown.text)
if (shown.ok === true) {
  check('toast 真的渲染出了内容（高度 > 0）', shown.h > 10, `高 ${shown.h}px`)
  check('toast 在视口内（scoped CSS 没丢）', shown.inViewport === true)
  await sleep(4200)
  const gone = await page.evaluate(() => {
    const portal = document.querySelector('[data-dsh-studio-portal]')
    const region = portal === null ? null : portal.querySelector('[role="region"], [aria-live]')
    return region === null || region.getBoundingClientRect().height < 10
  })
  check('约 4 秒后自动消失', gone === true)
}

if (hostNoise.length > 0) console.log(`note 忽略宿主级噪声 ${hostNoise.length} 条（duplicate factory registration @deepseek-ai/…，与本插件无关）`)
  check('全程没有 pageerror / console error', errors.length === 0, errors.slice(0, 2).join(' | '))
await browser.close()

console.log(fails.length === 0 ? '\n全部通过（7 项）' : `\n${fails.length} 项失败（7 项）`)
process.exit(fails.length === 0 ? 0 : 1)
