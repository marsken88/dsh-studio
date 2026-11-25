#!/usr/bin/env node
/**
 * 用例库探针（真机 + 真 Chrome）：草稿用例必须**看得见、筛得出来**。
 *
 * 为什么要有它：2026-11-19 普查发现全库 111 条用例里有 41 条只有标题、没有可执行断言
 * （跑不了，也不计入覆盖率），而它们在列表里跟「手工用例」长得一样，没人能一眼找出待补的那批。
 * 加完筛选之后，这个探针守住三件事：
 *   1. 用例库能出表（不是空白、也不是「渲染失败」）
 *   2. 有「只看无断言」筛选，选中后只剩草稿/无断言
 *   3. 切回「全部用例」行数复原（筛选不能把人困住）
 *
 * 用法（需要一台部署好的 dsh-web）：
 *   STUDIO_TOKEN=xxxx STUDIO_BASE=http://<host>:18080 npm run verify:cases
 *
 * 依赖 puppeteer-core（devDependency），浏览器用系统 Chrome，可用 CHROME_PATH 指定。
 */
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'

const require = createRequire(import.meta.url)
let puppeteer
try {
  puppeteer = require('puppeteer-core')
} catch {
  console.error('需要 puppeteer-core：pnpm add -D puppeteer-core')
  process.exit(2)
}

const token = String(process.env.STUDIO_TOKEN ?? '').trim()
const baseUrl = String(process.env.STUDIO_BASE ?? '').trim().replace(/\/+$/, '')
if (token === '') {
  console.error('缺少 STUDIO_TOKEN：从 journalctl 里取 http://host:18080/?token=xxxx 的那一段')
  process.exit(2)
}
if (baseUrl === '') {
  // 不猜默认地址：猜错会打到别的机器上，得到一个假通过/假失败。
  console.error('缺少 STUDIO_BASE（例：http://192.168.120.218:18080）')
  process.exit(2)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok: ok === true, detail }); return ok === true }

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width: 1600, height: 1000 },
})
/* 宿主级别的噪声（不是本插件的错误）：DSH 的模块系统在批量入口/重复拦截时会抛
   client-modules: duplicate factory registration for "@deepseek-ai/…"。
   实测 0.9.1 与 0.9.2 的产物都出现，加载完成后面板正常 —— 单独计数，
   但**只放行 @deepseek-ai/ 开头的核心插件**；提到 dsh-studio 的一律照常报错。 */
const HOST_NOISE = /client-modules: duplicate factory registration for "@deepseek-ai\//
const hostNoise = []
const isHostNoise = text => HOST_NOISE.test(String(text))

const page = await browser.newPage()
const cookieSpec = String(process.env.STUDIO_COOKIE ?? '').trim()
if (cookieSpec !== '') {
  const origin = new URL(baseUrl)
  const parsed = cookieSpec.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const at = part.indexOf('=')
    return at > 0 ? { name: part.slice(0, at), value: part.slice(at + 1), domain: origin.hostname, path: '/' } : null
  }).filter(Boolean)
  if (parsed.length > 0) await page.setCookie(...parsed)
}
const errors = []
page.on('pageerror', error => { if (isHostNoise(error)) { hostNoise.push(String(error).slice(0, 120)); return } errors.push(String(error).slice(0, 200)) })

try {
  await page.goto(`${baseUrl}/?token=${token}`, { waitUntil: 'networkidle2', timeout: 60000 })
  await sleep(2500)
  await page.evaluate(() => {
    const node = [...document.querySelectorAll('*')].find(el => el.children.length === 0 && (el.textContent || '').trim() === '需求&任务工作空间')
    node?.closest('button,a,li,[role="button"],[tabindex]')?.click()
  })
  await page.waitForSelector('[data-dsh-studio]', { timeout: 30000 })
  await sleep(1200)
  for (const tab of await page.$$('[data-dsh-studio] [data-head-tabs] button')) {
    if (((await tab.evaluate(node => node.textContent)) || '').trim() === '用例') { await tab.click(); break }
  }
  await sleep(2500)

  const rowsOf = () => page.$$eval('[data-dsh-studio] [data-cases-table] table tbody tr', nodes => nodes.length)
  const kindColumn = () => page.$$eval('[data-dsh-studio] [data-cases-table] table tbody tr', nodes => nodes.map(tr => (tr.children[3]?.textContent || '').trim()))
  const total = await rowsOf()
  check('用例库有行', total > 0, `${total} 行`)

  let kindSelect = null
  for (const handle of await page.$$('[data-dsh-studio] select')) {
    const options = await handle.evaluate(node => [...node.options].map(option => option.textContent.trim()))
    if (options.some(text => text.startsWith('只看无断言'))) { kindSelect = handle; break }
  }
  check('有「只看无断言」筛选', kindSelect !== null)

  if (kindSelect !== null) {
    const optionText = await kindSelect.evaluate(node => [...node.options].map(option => option.textContent.trim()).join(' | '))
    check('筛选选项齐全', optionText.includes('只可跑'), optionText)
    await kindSelect.select('bare')
    await sleep(1200)
    const bare = await rowsOf()
    const kinds = await kindColumn()
    check('筛选后行数变少', bare < total, `${total} → ${bare}`)
    check('筛选后只剩草稿/无断言', kinds.every(kind => kind === '草稿' || kind === '无断言'), kinds.slice(0, 5).join('/'))
    await mkdir('tmp/pages', { recursive: true })
    await page.screenshot({ path: 'tmp/pages/cases-drafts.png' })
    await kindSelect.select('__all__')
    await sleep(800)
    check('切回全部后行数复原', (await rowsOf()) === total)
  }

  const crash = await page.evaluate(() => {
    const text = document.body.innerText
    const at = text.indexOf('渲染失败')
    return at < 0 ? null : text.slice(Math.max(0, at - 10), at + 90).replace(/\s+/g, ' ')
  })
  check('面板没有渲染失败', crash === null, crash ?? '')
  if (hostNoise.length > 0) console.log(`note 忽略宿主级噪声 ${hostNoise.length} 条（duplicate factory registration @deepseek-ai/…，与本插件无关）`)
  check('pageerror 为空', errors.length === 0, errors.slice(0, 2).join(' | '))
} catch (error) {
  check('探针没跑完', false, String(error?.message ?? error).slice(0, 200))
} finally {
  await browser.close()
}

for (const item of checks) console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}${item.detail ? ' — ' + item.detail : ''}`)
const failed = checks.filter(item => item.ok !== true)
console.log(failed.length === 0 ? `用例库探针通过（${checks.length} 项）· 截图在 tmp/pages/cases-drafts.png` : `${failed.length} 项没通过`)
process.exit(failed.length === 0 ? 0 : 1)
