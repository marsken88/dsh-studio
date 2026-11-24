/* 抽屉内部页签的覆盖（之前只测了抽屉「打开后默认那一屏」）。
 *
 *   STUDIO_TOKEN=xxx node tools/visual/drawer-tabs.mjs
 *
 * 卡片详情抽屉里还有一层页签（详情 / 计划 / 交付物 / 用例 / 讨论…），
 * 每个页签渲染的是完全不同的表单，默认屏测不到。这里逐个点开，断言：
 *   · 没有「渲染失败」
 *   · 没有原生 <select>，所有 input/textarea 都在 react-aria 组件里
 *   · pageerror 为空
 */
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const requireFromRoot = createRequire(resolve(import.meta.dirname, '../..', 'package.json'))
const puppeteer = requireFromRoot('puppeteer-core')
const BASE = process.env.STUDIO_BASE ?? 'http://192.168.120.218:18080'
const TOKEN = process.env.STUDIO_TOKEN ?? ''
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1680, height: 1000 } })
const page = await browser.newPage()
/* 宿主只认 cookie 时用 STUDIO_COOKIE（name=value; ...）登录。 */
const cookieSpec = String(process.env.STUDIO_COOKIE ?? '').trim()
if (cookieSpec !== '') {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  const origin = new URL(BASE)
  const parsed = cookieSpec.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const at = part.indexOf('=')
    return at > 0 ? { name: part.slice(0, at), value: part.slice(at + 1), url: origin.origin } : null
  }).filter(Boolean)
  if (parsed.length > 0) await page.setCookie(...parsed)
}
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)))
await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: 'networkidle2', timeout: 60000 })
await sleep(3200)
await page.evaluate(() => {
  const node = [...document.querySelectorAll('*')].find((el) => el.children.length === 0 && (el.textContent || '').trim() === '需求&任务工作空间')
  node?.closest('button,a,li,[role="button"],[tabindex]')?.click?.()
})
await page.waitForSelector('[data-dsh-studio] [role="tablist"]', { timeout: 45000 })
await sleep(1000)
await page.evaluate(() => [...document.querySelectorAll('[data-dsh-studio] [role="tab"]')].find((n) => (n.textContent || '').trim() === '看板')?.click())
await sleep(1500)
await page.evaluate(() => document.querySelector('[data-dsh-studio] [data-kanban-card]')?.click())
await sleep(1800)

const SCOPE = '[data-dsh-studio-portal] [role="dialog"], [data-dsh-studio] [data-drawer]'
const tabs = await page.evaluate((sel) => {
  const root = document.querySelector(sel)
  if (!root) return null
  return [...root.querySelectorAll('[role="tab"]')].map((n) => (n.textContent || '').trim())
}, SCOPE)
if (tabs === null) {
  console.log('找不到卡片抽屉：探针无法进行')
  process.exit(1)
}
console.log('抽屉内页签: ' + JSON.stringify(tabs))

const audit = () => page.evaluate((sel) => {
  const root = document.querySelector(sel)
  const crashed = document.body.innerText.includes('渲染失败')
  const q = (s) => [...root.querySelectorAll(s)]
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4 }
  const nativeSelect = q('select').filter((el) => vis(el) && el.closest('[data-testid="hidden-select-container"]') === null).length
  const rawField = q('input, textarea').filter((el) => vis(el) && el.type !== 'hidden' && el.closest('[data-rac]') === null).length
  /* data-variant 现在是 BoardUI 适配层给 CSS 的钩子，不能再当「老按钮」标记；
     老按钮只认 ds-btn 这类手写类。 */
  const legacyBtn = q('button, a, label').filter((el) => vis(el) && /(^|\\s)ds-btn\\b/.test(String(el.className ?? ''))).length
  return { crashed, nativeSelect, rawField, legacyBtn, controls: q('[data-field="select"], [data-rac]').length }
}, SCOPE)

const fails = []
let index = 0
for (const label of tabs.length > 0 ? tabs : ['(无页签)']) {
  if (tabs.length > 0) {
    await page.evaluate(([want, sel]) => {
      const root = document.querySelector(sel)
      const tab = [...root.querySelectorAll('[role="tab"]')].find((n) => (n.textContent || '').trim() === want)
      tab?.click()
    }, [label, SCOPE])
    await sleep(1100)
  }
  const row = await audit()
  console.log(`${String(++index).padStart(2)} ${label.padEnd(10)} 原生select=${row.nativeSelect} 原生字段=${row.rawField} 老按钮=${row.legacyBtn} 组件=${row.controls}${row.crashed ? '  ⚠ 渲染失败' : ''}`)
  if (row.crashed) fails.push(`${label}: 渲染失败`)
  if (row.nativeSelect > 0) fails.push(`${label}: ${row.nativeSelect} 个原生 select`)
  if (row.rawField > 0) fails.push(`${label}: ${row.rawField} 个原生输入框`)
  if (row.legacyBtn > 0) fails.push(`${label}: ${row.legacyBtn} 个老按钮`)
}

await browser.close()
if (fails.length > 0 || errors.length > 0) {
  console.log('\n不通过：\n- ' + fails.join('\n- '))
  if (errors.length) console.log('pageerror: ' + errors.slice(0, 3).join(' | '))
  process.exit(1)
}
console.log(`\n抽屉内 ${tabs.length} 个页签全部通过（无渲染失败 / 无原生控件 / 无老按钮）`)
