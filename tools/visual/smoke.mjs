#!/usr/bin/env node
/**
 * 部署后冒烟：进面板 → 看四个页签 → 看板有卡 → 用例页有行 → pageerror 必须为空。
 *
 * 用法：
 *   STUDIO_TOKEN=xxxx node tools/visual/smoke.mjs
 *   node tools/visual/smoke.mjs xxxx --base http://192.168.120.218:18080
 *
 * 需要 puppeteer-core（仓库故意不把它写进依赖）：
 *   pnpm add -D puppeteer-core
 * 或者用环境变量指过去：PUPPETEER_CORE=/path/to/puppeteer-core
 *
 * token 从哪来：dsh web 启动时会在 journal 里打印 http://host:18080/?token=xxxx
 *   echo 1234 | sudo -S journalctl -u dsh-web -n 50 | grep -o 'token=[A-Za-z0-9_-]*' | tail -1
 */
import { createRequire } from 'node:module'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf('--' + name)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}
const token = args.find(item => !item.startsWith('--') && item !== option('base', '')) ?? process.env.STUDIO_TOKEN ?? ''
const baseUrl = option('base', process.env.STUDIO_BASE ?? 'http://192.168.120.218:18080')
if (token === '') {
  console.error('缺少 token：STUDIO_TOKEN=xxxx node tools/visual/smoke.mjs（或作为第一个参数传）')
  process.exit(2)
}

const require = createRequire(import.meta.url)
let puppeteer
try {
  puppeteer = require('puppeteer-core')
} catch {
  try {
    puppeteer = require(process.env.PUPPETEER_CORE ?? 'puppeteer-core')
  } catch {
    console.error('需要 puppeteer-core：pnpm add -D puppeteer-core（或设 PUPPETEER_CORE 指向已装的目录）')
    process.exit(2)
  }
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
const page = await browser.newPage()
const errors = []
page.on('pageerror', error => errors.push(String(error).slice(0, 200)))

try {
  await page.goto(`${baseUrl}/?token=${token}`, { waitUntil: 'networkidle2', timeout: 60000 })
  await sleep(3000)
  check('dsh web 能打开', true)

  const clicked = await page.evaluate(() => {
    const node = [...document.querySelectorAll('*')].find(el => el.children.length === 0 && (el.textContent || '').trim() === '需求&任务工作空间')
    const target = node?.closest('button,a,li,[role="button"],[tabindex]')
    if (target === undefined || target === null) return false
    target.click()
    return true
  })
  check('侧栏能进「需求&任务工作空间」', clicked)

  await page.waitForSelector('[data-dsh-studio]', { timeout: 30000 })
  await sleep(1500)
  check('面板挂载（[data-dsh-studio]）', true)

  const tabs = await page.$$eval('[data-dsh-studio] [role="tab"]', nodes => nodes.map(n => n.textContent.trim()))
  check('六个页签都在', ['工作台', '看板', '需求', '用例', '版本', '项目'].every(name => tabs.includes(name)), tabs.join('/'))

  // Radix Tabs 不认 DOM .click()，必须用 elementHandle.click()
  for (const tab of await page.$$('[data-dsh-studio] [role="tab"]')) {
    if ((((await tab.evaluate(n => n.textContent)) || '').trim()) === '看板') { await tab.click(); break }
  }
  await sleep(1500)
  const cards = await page.$$eval('[data-dsh-studio] .ds-card', nodes => nodes.length)
  check('看板有卡', cards > 0, `${cards} 张`)

  for (const tab of await page.$$('[data-dsh-studio] [role="tab"]')) {
    if ((((await tab.evaluate(n => n.textContent)) || '').trim()) === '用例') { await tab.click(); break }
  }
  await sleep(2000)
  const rows = await page.$$eval('[data-dsh-studio] .ds-case-lib-row', nodes => nodes.length)
  check('用例库有行', rows > 0, `${rows} 行`)

  const suite = await page.$$eval('[data-dsh-studio] .ds-suite', nodes => nodes.length)
  check('回归套件渲染', suite > 0, `${suite} 个`)

  const crash = await page.evaluate(() => {
    const text = document.body.innerText
    const at = text.indexOf('渲染失败')
    return at < 0 ? null : text.slice(Math.max(0, at - 10), at + 90).replace(/\s+/g, ' ')
  })
  check('面板没有渲染失败', crash === null, crash ?? '')

  check('pageerror 为空', errors.length === 0, errors.slice(0, 2).join(' | '))
} catch (error) {
  check('冒烟没跑完', false, String(error?.message ?? error).slice(0, 200))
} finally {
  await browser.close()
}

const failed = checks.filter(item => item.ok !== true)
console.log(JSON.stringify({ baseUrl, checks, ok: failed.length === 0 }, null, 1))
process.exitCode = failed.length === 0 ? 0 : 1
