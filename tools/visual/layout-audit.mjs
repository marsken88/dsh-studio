/* 排版与组件一致性巡检（只读）：逐页 + 逐设置面板收集可量化的「不对劲」。
 *   STUDIO_TOKEN=xxx node tools/visual/layout-audit.mjs
 *   LAYOUT_SHOTS=1 时同时存 tmp/layout/<名字>.png
 * 检的是一眼看不出来、但会叠成「越用越歪」的东西：
 *   · 横向溢出（内容撑破容器 / 该滚动却没滚动）
 *   · 小于 11px 的字（可读性下限）
 *   · 内联硬编码颜色（深色主题必翻车）
 *   · 还留在 DOM 里的手写 legacy 类（已清零）与 BoardUI 控件覆盖（[data-variant]）
 *   · 每页用到的字号档位数量（越多越不像一套设计）
 */
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const requireFromRoot = createRequire(resolve(import.meta.dirname, '../..', 'package.json'))
const puppeteer = requireFromRoot('puppeteer-core')
const BASE = process.env.STUDIO_BASE ?? 'http://192.168.120.218:18080'
const TOKEN = process.env.STUDIO_TOKEN ?? ''
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
const SHOTS = process.env.LAYOUT_SHOTS === '1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PAGES = ['工作台', '看板', '需求', '用例', '版本', '项目', '效能', '设置']

const MEASURE = () => {
  const roots = [...document.querySelectorAll('[data-dsh-studio], [data-dsh-studio-portal]')]
  const seen = new Set()
  const all = []
  for (const root of roots) for (const node of root.querySelectorAll('*')) if (!seen.has(node)) { seen.add(node); all.push(node) }
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(el).visibility !== 'hidden' }
  const shown = all.filter(vis)

  // 只有「静态流转的子元素撑破容器」才算溢出；position:absolute/fixed 的装饰层
  // （焦点环、光晕、动画蒙层）故意超出父级，不算问题 —— 上一版就是在这里误报的。
  const decorated = (el) => [...el.children].some((child) => {
    const cs = getComputedStyle(child)
    return cs.position === 'absolute' || cs.position === 'fixed'
  })
  const overflow = shown.filter((el) => el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX === 'visible' && el.children.length > 0 && !decorated(el) && !['absolute', 'fixed'].includes(getComputedStyle(el).position))
    .slice(0, 4)
    .map((el) => `${el.tagName.toLowerCase()}.${(el.className || '').toString().trim().split(/\s+/).slice(0, 2).join('.')} ${el.scrollWidth}>${el.clientWidth}`)

  const tiny = shown.filter((el) => el.children.length === 0 && (el.textContent || '').trim() !== '' && parseFloat(getComputedStyle(el).fontSize) < 11)
    .slice(0, 4)
    .map((el) => `${getComputedStyle(el).fontSize} "${(el.textContent || '').trim().slice(0, 14)}"`)

  // 内联写死的颜色（#rrggbb / rgb() / 具名色）
  // mask-image / conic-gradient 里的 rgb() 是遮罩用的不透明色，不是主题色，不算
  const inlineColor = shown.filter((el) => {
    const style = (el.getAttribute('style') || '').replace(/mask-image:[^;]*;?/gi, '')
    return /#[0-9a-fA-F]{3,8}|rgb\(|hsl\(/.test(style)
  }).length

  // 手写 legacy 类已清空（全仓 0 处），这里改成数 BoardUI 控件：Button 适配层输出 data-variant。
  // 这个数越大越说明控件走的是 BoardUI；和溢出/小字/内联色那些「越小越好」的指标不是一类。
  const boardui = shown.filter((el) => el.hasAttribute('data-variant')).length

  const sizes = new Set(shown.filter((el) => el.children.length === 0 && (el.textContent || '').trim() !== '').map((el) => getComputedStyle(el).fontSize))
  return { overflow, tiny, inlineColor, boardui, sizeSteps: [...sizes].sort()[0], sizeCount: sizes.size, total: shown.length }
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
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)))
await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: 'networkidle2', timeout: 60000 })
await sleep(3200)
await page.evaluate(() => {
  const node = [...document.querySelectorAll('*')].find((el) => el.children.length === 0 && (el.textContent || '').trim() === '需求&任务工作空间')
  node?.closest('button,a,li,[role="button"],[tabindex]')?.click?.()
})
await page.waitForSelector('[data-dsh-studio] [role="tablist"]', { timeout: 45000 })
await sleep(1200)

const rows = []
const snap = async (name) => {
  await sleep(1700)
  const m = await page.evaluate(MEASURE)
  rows.push({ name, ...m })
  if (SHOTS) await page.screenshot({ path: `tmp/layout/${name.replace(/[^\w\u4e00-\u9fa5]+/g, '_')}.png` })
}

for (const label of PAGES) {
  await page.evaluate((want) => {
    [...document.querySelectorAll('[data-dsh-studio] [role="tab"]')].find((n) => (n.textContent || '').trim() === want)?.click()
  }, label)
  await snap(label)
}

// 设置里 16 个面板
const panels = await page.evaluate(() => [...document.querySelectorAll('[data-dsh-studio] [data-settings-nav] [data-settings-nav-item]')].map((n) => (n.querySelector('span')?.textContent || '').trim()))
for (const label of panels) {
  await page.evaluate((want) => {
    [...document.querySelectorAll('[data-dsh-studio] [data-settings-nav] [data-settings-nav-item]')].find((n) => (n.querySelector('span')?.textContent || '').trim() === want)?.click()
  }, label)
  await snap(`设置/${label}`)
}

await browser.close()

console.log('模块'.padEnd(22) + '字号档'.padStart(7) + '最小字'.padStart(8) + '内联色'.padStart(8) + 'BoardUI'.padStart(8))
for (const r of rows) {
  const flag = r.overflow.length > 0 ? '  ⚠溢出' : ''
  console.log(r.name.padEnd(22) + String(r.sizeCount).padStart(7) + r.sizeSteps.padStart(8) + String(r.inlineColor || '·').padStart(8) + String(r.boardui || '·').padStart(8) + flag)
  for (const o of r.overflow) console.log('     ↳ 溢出 ' + o)
  for (const t of r.tiny) console.log('     ↳ 小字 ' + t)
}
const overflowTotal = rows.reduce((sum, r) => sum + r.overflow.length, 0)
const inlineTotal = rows.reduce((sum, r) => sum + r.inlineColor, 0)
const boarduiTotal = rows.reduce((sum, r) => sum + r.boardui, 0)
console.log(`\n${rows.length} 个模块：溢出 ${overflowTotal} 处、内联硬编码颜色 ${inlineTotal} 处、BoardUI 控件 ${boarduiTotal} 个、pageerror ${errors.length}`)
if (errors.length) console.log('pageerror: ' + errors.slice(0, 3).join(' | '))
