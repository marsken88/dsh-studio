/* 全站控件盘点（真机 + token）：**逐个功能模块**检查它用的是不是 BoardUI 组件。
 *
 *   STUDIO_TOKEN=xxx node tools/visual/audit.mjs
 *   STUDIO_TOKEN=xxx AUDIT_SHOTS=1 node tools/visual/audit.mjs     # 顺带截图留档
 *
 * 盘点的模块：8 个顶部页签 + 设置里 18 个面板 + 3 个抽屉。
 * 判据（全部为 0 才算通过，非 0 退出码 1）：
 *   · nativeSelect  可见的原生 <select>（react-aria 的隐藏 select 不算：它在 [data-rac] 里）
 *   · rawField      input / textarea 不在任何 react-aria 组件里（= 还是原生控件）
 *   · legacyBtn     button/a/label 上还挂着的手写 legacy 类（ds-*，迁移已清零；BoardUI 按钮走 data-variant 不算）
 *   · radixSelect   手写的 radix 下拉触发器（button[aria-haspopup=listbox] 但没 data-rac）
 *   · foreignTab    不在 .studio-tabs / BoardUI Tabs 里的 [role=tab]（第三种页签实现）
 *
 * 为什么以前漏了：老版本只数 <select>，而且作用域只有 [data-dsh-studio]、没有 portal，
 * 抽屉与弹层里的控件从来没被统计过；`scopes` 改了以后 `if (!scope)` 还会直接抛错。
 */
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const requireFromRoot = createRequire(resolve(import.meta.dirname, '../..', 'package.json'))
const puppeteer = requireFromRoot('puppeteer-core')
const BASE = process.env.STUDIO_BASE ?? 'http://192.168.120.218:18080'
const TOKEN = process.env.STUDIO_TOKEN ?? ''
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
const SHOTS = process.env.AUDIT_SHOTS === '1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PAGES = ['工作台', '看板', '需求', '用例', '版本', '项目', '效能', '设置']
const PANELS = ['项目与迭代', '专家', '专家团', '技能库', '列的负责人', '代码仓库', '飞书机器人', '文档出口', '集成健康',
  '自动派单', '测试执行', '成本与预算', '部署环境', '看板外观', '统一登录（LDAP）', '权限与审计', '数据与备份']

const COUNT = () => {
  const roots = [...document.querySelectorAll('[data-dsh-studio], [data-dsh-studio-portal]')]
  const seen = new Set()
  const all = []
  for (const root of roots) for (const node of root.querySelectorAll('*')) if (!seen.has(node)) { seen.add(node); all.push(node) }
  const vis = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'
  }
  const outside = (el) => el.closest('[data-rac]') === null && el.closest('[data-testid="hidden-select-container"]') === null
  const hits = (pred) => all.filter((el) => vis(el) && pred(el))
  const describe = (el) => {
    const text = (el.textContent || '').trim().slice(0, 24)
    const cls = (el.className || '').toString().trim().split(/\s+/).slice(0, 3).join('.')
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${text ? ' "' + text + '"' : ''}`
  }
  const nativeSelect = hits((el) => el.tagName === 'SELECT' && outside(el))
  const rawField = hits((el) => (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.type !== 'hidden' && outside(el))
  // 迁移完成后手写类应全站为 0：这里不再点名某个具体类，只查 button/a/label 上还有没有 ds-* 类
  // （BoardUI 自己的控件不挂 ds-*，它们走 data-variant / data-field）。
  const legacyBtn = hits((el) => ['BUTTON', 'A', 'LABEL'].includes(el.tagName) && /(^|\s)ds-[a-z]/.test((el.className || '').toString()))
  const radixSelect = hits((el) => el.tagName === 'BUTTON' && el.getAttribute('aria-haspopup') === 'listbox' && el.closest('[data-rac]') === null)
  const foreignTab = hits((el) => el.getAttribute('role') === 'tab' && el.closest('.studio-tabs') === null && el.closest('[data-boardui-tabs]') === null)
  const out = {
    nativeSelect: nativeSelect.length,
    rawField: rawField.length,
    legacyBtn: legacyBtn.length,
    radixSelect: radixSelect.length,
    foreignTab: foreignTab.length,
    meter: hits((el) => el.getAttribute('role') === 'meter' || el.getAttribute('role') === 'progressbar' && el.closest('[data-rac]') !== null).length,
    samples: [...nativeSelect, ...rawField, ...legacyBtn, ...radixSelect, ...foreignTab].slice(0, 5).map(describe),
  }
  return out
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
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)))
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
  // 800ms 对「效能」这类要等接口回来才画图的页面太短 —— 之前就是因此把 9 个
  // 官方计量条全漏掉了（meter 统计恒为 0）。1200ms 起步，页面自己再补。
  await sleep(1800)
  // 面板崩掉时 React 会把异常吞在自己树里，pageerror 是空的 —— 只能看 innerText
  const crashed = await page.evaluate(() => document.body.innerText.includes('渲染失败'))
  const counts = await page.evaluate(COUNT)
  rows.push({ name, crashed, ...counts })
  if (SHOTS) await page.screenshot({ path: `tmp/audit-${name.replace(/[^\w\u4e00-\u9fa5]+/g, '_')}.png` })
}

const clickTab = async (want) => {
  await page.evaluate((label) => {
    const tab = [...document.querySelectorAll('[data-dsh-studio] [role="tab"]')].find((n) => (n.textContent || '').trim() === label)
    tab?.click()
  }, want)
  await sleep(900)
}

for (const label of PAGES) {
  await clickTab(label)
  await snap(label)
  /* 效能页的 Meter（团队负载 / 预算使用）在「AI 与成本」分区里；
     默认总览看不见，旧审计因此误报「全站没有 meter」。 */
  if (label === '效能') {
    await page.evaluate(() => document.querySelector('[data-analytics-tab="ai"]')?.click())
    await snap('效能/AI 与成本')
    await page.evaluate(() => document.querySelector('[data-analytics-tab="overview"]')?.click())
  }
}

// 设置里的每个面板：左栏是 button[data-settings-nav-item]
await clickTab('设置')
await sleep(900)
const panels = await page.evaluate(() => [...document.querySelectorAll('[data-dsh-studio] [data-settings-nav] [data-settings-nav-item]')].map((n) => (n.querySelector('span')?.textContent || '').trim()))
for (const label of panels) {
  await page.evaluate((want) => {
    const btn = [...document.querySelectorAll('[data-dsh-studio] [data-settings-nav] [data-settings-nav-item]')]
      .find((n) => (n.querySelector('span')?.textContent || '').trim() === want)
    btn?.click()
  }, label)
  await snap(`设置/${label}`)
}

// 抽屉：新建需求 / 卡片详情 / 新增专家 / 项目设置
const openDrawer = async (name, run) => {
  await page.keyboard.press('Escape')
  await sleep(500)
  await run()
  await sleep(1500)
  await snap(name)
  await page.keyboard.press('Escape')
  await sleep(600)
}

await openDrawer('抽屉/新建需求', async () => {
  await clickTab('需求')
  await page.evaluate(() => [...document.querySelectorAll('[data-dsh-studio] button')].find((n) => /新建/.test((n.textContent || '').trim()))?.click())
})
await openDrawer('抽屉/卡片详情', async () => {
  await clickTab('看板')
  await page.evaluate(() => document.querySelector('[data-dsh-studio] [data-kanban-card]')?.click())
})
await openDrawer('抽屉/新增专家', async () => {
  await clickTab('设置')
  await sleep(700)
  await page.evaluate(() => [...document.querySelectorAll('[data-dsh-studio] button')].find((n) => (n.textContent || '').trim() === '新增专家')?.click())
})

await browser.close()

const KEYS = ['nativeSelect', 'rawField', 'legacyBtn', 'radixSelect', 'foreignTab']
const HEAD = ['模块'.padEnd(20), ...KEYS.map((k) => k.padStart(13))]
console.log(HEAD.join(''))
let bad = 0
for (const row of rows) {
  const cells = KEYS.map((k) => (row[k] ? String(row[k]) : '·').padStart(13))
  const flag = row.crashed ? '  ⚠ 渲染失败' : ''
  if (row.crashed) bad += 1
  if (KEYS.some((k) => row[k] > 0)) bad += 1
  console.log([row.name.padEnd(20), ...cells].join('') + flag)
  for (const s of row.samples) console.log('     ↳ ' + s)
}
const meterTotal = rows.reduce((sum, r) => sum + (r.meter || 0), 0)
if (meterTotal === 0) { console.log('⚠ 全站没有渲染出任何官方计量条（role=meter）——进度条可能退回自绘了'); bad += 1 }
const total = KEYS.reduce((sum, k) => sum + rows.reduce((s, r) => s + (r[k] || 0), 0), 0)
console.log(`\n盘点 ${rows.length} 个模块：违规 ${total} 处，异常模块 ${rows.filter((r) => r.crashed).length} 个，pageerror ${errors.length} 条`)
if (errors.length) console.log('pageerror: ' + errors.slice(0, 4).join(' | '))
if (SHOTS) console.log('截图在 tmp/audit-*.png')
process.exit(total > 0 || bad > 0 || errors.length > 0 ? 1 : 0)
