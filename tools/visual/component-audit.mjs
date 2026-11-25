/* 组件盘点（运行时）：把面板里所有元素分成「官方 BoardUI」与「自研 ds-*」两堆，
 * 按出现次数排出来，看清还有哪些「长得像组件」的东西是手写的。
 *
 *   STUDIO_TOKEN=xxx node tools/visual/component-audit.mjs
 *
 * 判据：
 *   · 官方 = 元素或祖先带 data-rac / data-field / data-variant / data-input-size
 *   · 自研 = className 里带 ds-* 前缀（这是 legacy 的约定）
 * 只统计**叶子级或直接承担视觉**的元素（有文本或自己带样式），避免把容器重复计数。
 */
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const requireFromRoot = createRequire(resolve(import.meta.dirname, '../..', 'package.json'))
const puppeteer = requireFromRoot('puppeteer-core')
const BASE = process.env.STUDIO_BASE ?? 'http://192.168.120.218:18080'
const TOKEN = process.env.STUDIO_TOKEN ?? ''
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PAGES = ['工作台', '看板', '需求', '用例', '版本', '项目', '效能', '设置']

const COLLECT = () => {
  const roots = [...document.querySelectorAll('[data-dsh-studio], [data-dsh-studio-portal]')]
  const seen = new Set()
  const all = []
  for (const root of roots) for (const node of root.querySelectorAll('*')) if (!seen.has(node)) { seen.add(node); all.push(node) }
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 }
  const custom = new Map()
  const official = new Map()
  for (const el of all) {
    if (!vis(el)) continue
    const cls = (el.className || '').toString()
    const dsTokens = cls.split(/\s+/).filter((c) => /^ds-[a-z0-9-]+$/.test(c))
    if (dsTokens.length > 0) {
      // 只认第一个 ds- 类作为「这是个什么」
      const key = dsTokens[0]
      custom.set(key, (custom.get(key) || 0) + 1)
    } else if (el.closest('[data-rac]') !== null || el.hasAttribute('data-rac') || el.hasAttribute('data-field') || el.hasAttribute('data-variant')) {
      const key = el.getAttribute('data-field') ? `[data-field=${el.getAttribute('data-field')}]`
        : el.getAttribute('data-variant') ? `[data-variant=${el.getAttribute('data-variant')}]`
          : el.tagName.toLowerCase()
      official.set(key, (official.get(key) || 0) + 1)
    }
  }
  return {
    custom: [...custom.entries()].sort((a, b) => b[1] - a[1]),
    official: [...official.entries()].sort((a, b) => b[1] - a[1]),
    customTotal: [...custom.values()].reduce((s, n) => s + n, 0),
    officialTotal: [...official.values()].reduce((s, n) => s + n, 0),
  }
}

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
await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: 'networkidle2', timeout: 60000 })
await sleep(3200)
await page.evaluate(() => {
  const node = [...document.querySelectorAll('*')].find((el) => el.children.length === 0 && (el.textContent || '').trim() === '需求&任务工作空间')
  node?.closest('button,a,li,[role="button"],[tabindex]')?.click?.()
})
await page.waitForSelector('[data-dsh-studio] [role="tablist"]', { timeout: 45000 })
await sleep(1200)

const agg = { custom: new Map(), official: new Map(), customTotal: 0, officialTotal: 0 }
const merge = (r) => {
  for (const [k, n] of r.custom) agg.custom.set(k, (agg.custom.get(k) || 0) + n)
  for (const [k, n] of r.official) agg.official.set(k, (agg.official.get(k) || 0) + n)
  agg.customTotal += r.customTotal
  agg.officialTotal += r.officialTotal
}

const snap = async () => { await sleep(1700); merge(await page.evaluate(COLLECT)) }
for (const label of PAGES) {
  await page.evaluate((w) => [...document.querySelectorAll('[data-dsh-studio] [role="tab"]')].find((n) => (n.textContent || '').trim() === w)?.click(), label)
  await snap()
  if (label === '设置') {
    const panels = await page.evaluate(() => [...document.querySelectorAll('[data-dsh-studio] [data-settings-nav] [data-settings-nav-item]')].map((n) => (n.querySelector('span')?.textContent || '').trim()))
    for (const p of panels) {
      await page.evaluate((w) => [...document.querySelectorAll('[data-dsh-studio] [data-settings-nav] [data-settings-nav-item]')].find((n) => (n.querySelector('span')?.textContent || '').trim() === w)?.click(), p)
      await snap()
    }
  }
}
await browser.close()

const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
console.log('=== 官方 BoardUI 元素（按类型，前 12）===')
for (const [k, v] of top(agg.official, 12)) console.log(String(v).padStart(5), k)
console.log('小计:', agg.officialTotal)
console.log('\n=== 自研 ds-* 元素（按类名，前 25）===')
for (const [k, v] of top(agg.custom, 25)) console.log(String(v).padStart(5), k)
console.log('小计:', agg.customTotal)
console.log(`\n官方占比: ${(agg.officialTotal / Math.max(1, agg.officialTotal + agg.customTotal) * 100).toFixed(1)}%`)
