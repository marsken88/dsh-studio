/* 审计日志表的验收：确认它已经是官方 Table + 官方分页，且旧 div 网格彻底消失。
 *
 *   STUDIO_TOKEN=xxx node tools/visual/audit-log-probe.mjs
 *
 * 断言：
 *   1 table.bui-table 存在，表头 5 列（时间/操作人/动作/详情/结果）
 *   2 每页行数 = 25（分页生效；权限页在 2026-11-24 从 50 调到 25），且没有旧的 div 网格残留（[data-audit-row] 只能是 <tr>）
 *   3 分页控件存在（上一页 / 下一页 / 页码）
 *   4 点「下一页」后内容真的换了
 *   5 全程无 pageerror
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

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1680, height: 1000 } })
const page = await browser.newPage()
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
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: 'networkidle2', timeout: 60000 })
await sleep(3200)
await page.evaluate(() => {
  const node = [...document.querySelectorAll('*')].find((el) => el.children.length === 0 && (el.textContent || '').trim() === '需求&任务工作空间')
  node?.closest('button,a,li,[role="button"],[tabindex]')?.click?.()
})
await page.waitForSelector('[data-dsh-studio] [role="tablist"]', { timeout: 45000 })
await sleep(1200)
await page.evaluate(() => [...document.querySelectorAll('[data-dsh-studio] [role="tab"]')].find((n) => (n.textContent || '').trim() === '设置')?.click())
await sleep(1500)
await page.evaluate(() => [...document.querySelectorAll('[data-dsh-studio] [data-settings-nav] [data-settings-nav-item]')].find((n) => (n.querySelector('span')?.textContent || '').trim() === '权限与审计')?.click())
await sleep(2000)

const first = await page.evaluate(() => {
  const scope = document.querySelector('[data-dsh-studio]')
  const table = scope.querySelector('table.bui-table')
  const pager = scope.querySelector('[aria-label="审计日志分页"]')
  return {
    table: table !== null,
    headers: table ? [...table.querySelectorAll('th')].map((n) => (n.textContent || '').trim()) : [],
    rows: table ? table.querySelectorAll('tbody tr').length : 0,
    firstRow: table ? (table.querySelector('tbody tr')?.textContent || '').trim().slice(0, 30) : '',
    oldRows: [...scope.querySelectorAll('[data-audit-row]')].filter((node) => node.tagName !== 'TR').length,
    tableRows: scope.querySelectorAll('tr[data-audit-row]').length,
    pager: pager !== null,
  }
})
check('审计日志是官方 Table', first.table === true)
check('表头 5 列', first.headers.length === 5, first.headers.join(' / '))
check('每页 25 行（分页生效）', first.rows === 25, `${first.rows} 行`)
check('审计行是真表格行（旧的 div 网格已消失）', first.oldRows === 0 && first.tableRows > 0, `非 tr 行=${first.oldRows} / tr 行=${first.tableRows}`)
check('分页控件存在', first.pager === true)

const flipped = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('[data-dsh-studio] button, [data-dsh-studio] [role="button"]')]
    .find((n) => (n.textContent || '').trim() === '下一页' || n.getAttribute('aria-label') === '下一页')
  btn?.click()
  return btn !== undefined
})
await sleep(1200)
const second = await page.evaluate(() => {
  const table = document.querySelector('[data-dsh-studio] table.bui-table')
  return { rows: table ? table.querySelectorAll('tbody tr').length : 0, firstRow: table ? (table.querySelector('tbody tr')?.textContent || '').trim().slice(0, 30) : '' }
})
check('点「下一页」能翻页', flipped === true)
check('翻页后内容变了', second.firstRow !== '' && second.firstRow !== first.firstRow, `${first.firstRow} → ${second.firstRow}`)
check('没有 pageerror', errors.length === 0, errors.slice(0, 2).join(' | '))

await browser.close()
console.log(fails.length === 0 ? '\n全部通过（7 项）' : `\n${fails.length} 项失败（7 项）`)
process.exit(fails.length === 0 ? 0 : 1)
