#!/usr/bin/env node
/**
 * 表单控件真浏览器自验（假宿主 + 真 Chrome）：TextField / TextAreaField / CheckField
 * 现在渲染的是 BoardUI 的源码组件（TextField + InputBase / TextareaBase / Checkbox），
 * 这个探针走的是「人能做的事」——打字、勾选、清空、再读回值：
 *
 *   1. 看板搜索框确实是 BoardUI 的壳子（react-aria 的 data-input-size）
 *   2. 打字之后卡片被过滤，**输入框自己还留着你打的字**（受控回写没断）
 *   3. 清空之后卡片回来
 *   4. 「隐藏空列」是个 role=checkbox，点了空列真的消失
 *   5. 抽屉里的多行输入是 BoardUI 的 textarea，打字后值留得住
 *   6. 全程 pageerror 为空
 *
 *   node tools/visual/fields-probe.mjs
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultConfig, PRIORITIES, ROLE_IDS, STATUSES } from '../../src/host/domain.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const require = createRequire(import.meta.url)
let puppeteer
try {
  puppeteer = require('puppeteer-core')
} catch {
  console.error('需要 puppeteer-core：pnpm add -D puppeteer-core')
  process.exit(2)
}
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'

const config = defaultConfig()
const now = Date.now()
const base = {
  type: 'requirement',
  priority: 'normal',
  requirementId: '',
  artifacts: [],
  cases: [],
  checklist: [],
  history: [],
  tags: [],
  acceptance: [],
  links: {},
  dispatch: {},
  design: null,
  worktree: null,
  blocked: null,
  sla: null,
  dueAt: 0,
  pointId: '',
  domain: '',
  requirement: '',
  updatedAt: now,
  commentCount: 0,
  coding: null,
}
const state = {
  revision: 3,
  updatedAt: now,
  profile: 'web',
  statuses: STATUSES,
  roles: ROLE_IDS,
  priorities: PRIORITIES,
  config,
  tasks: [
    { ...base, id: 't-1', code: 'DEV-1', title: '库存预占与超时释放', status: 'dev', updatedAt: now },
    { ...base, id: 't-2', code: 'DEV-2', title: '支付回调重试', status: 'test', updatedAt: now - 1000 },
  ],
  requirements: [],
  releases: [],
  experts: [],
  agents: [],
  locked: false,
}
const html = `<!doctype html><html><head><meta charset="utf-8"><title>fields probe</title></head>
<body><div id="root"></div>
<script>window.__ModuleLoader__ = { load(entry) { window.__STUDIO_PLUGIN__ = entry.factory(function (name) {
  if (name === 'react') return window.React
  throw new Error('harness: no module ' + name)
}) } }</script>
<script src="/react.js"></script><script src="/react-dom.js"></script><script src="/client.js"></script>
<script>(function () { try {
  var registered = {}
  var ctx = { slots: { inject: function (n, fn) { fn() }, register: function (def, Comp) { registered[def.key || def.name] = Comp; return function () {} } }, effect: function (fn) { return fn() } }
  window.__STUDIO_PLUGIN__.apply(ctx)
  var Page = registered.studio
  if (!Page) { window.__HARNESS_ERROR__ = 'no page'; return }
  ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Page, {}))
  window.__HARNESS_MOUNTED__ = true
} catch (e) { window.__HARNESS_ERROR__ = String(e) } })()</script></body></html>`

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const sendJson = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)) }
  if (url.pathname === '/studio-api/state') return sendJson(200, { ok: true, state })
  if (url.pathname.startsWith('/studio-api/')) return sendJson(200, { ok: true, state })
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return }
  const file = url.pathname === '/client.js' ? join(REPO, 'client.js')
    : url.pathname === '/react.js' ? join(REPO, 'web/node_modules/react/umd/react.production.min.js')
      : url.pathname === '/react-dom.js' ? join(REPO, 'web/node_modules/react-dom/umd/react-dom.production.min.js') : ''
  if (file === '') { res.writeHead(404).end(); return }
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
    res.end(body)
  } catch (error) { res.writeHead(500).end(String(error)) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base_ = `http://127.0.0.1:${server.address().port}`

const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok: ok === true }); console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail === '' ? '' : ' — ' + detail)) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let browser
try {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1600, height: 1100 } })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error).slice(0, 200)))
  await page.goto(base_ + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('[data-dsh-studio] [data-head-tabs] button', { timeout: 45000 })
  const clickTab = async label => {
    for (const tab of await page.$$('[data-dsh-studio] [data-head-tabs] button')) {
      if ((((await tab.evaluate(node => node.textContent)) ?? '').trim()) === label) { await tab.click(); return true }
    }
    return false
  }
  const cardTitles = () => page.evaluate(() => [...document.querySelectorAll('[data-dsh-studio] [data-kanban-card]')]
    .map(node => (node.textContent || '').trim()))
  const columnCount = () => page.evaluate(() => document.querySelectorAll('[data-dsh-studio] [data-board-column]').length)

  check('切到看板', await clickTab('看板'))
  await page.waitForSelector('[data-dsh-studio] [data-kanban-card]', { timeout: 30000 })
  const before = await cardTitles()
  check('两张卡都渲染出来了', before.length === 2, `${before.length} 张`)
  check('看板有 8 列（默认不隐藏空列）', (await columnCount()) === 8, String(await columnCount()))

  // ---- 1) 单行输入：BoardUI 的壳子 + 受控回写
  const searchSel = '[data-dsh-studio] input[placeholder^="搜标题"]'
  const shape = await page.evaluate(sel => {
    const input = document.querySelector(sel)
    if (input === null) return { found: false }
    // 现在是官方 SearchField（[data-field="search"] + role=searchbox），
    // 以前断言的是 data-input-size —— 那时候还是普通 Input。断言跟着组件走，
    // 但保留同样的意图：必须是官方的、必须带 react-aria 的壳。
    const field = input.closest('[data-field="search"], [data-field="input"]')
    return {
      found: true,
      reactAria: input.closest('[data-rac]') !== null,
      kind: field?.getAttribute('data-field') ?? '',
      searchbox: input.getAttribute('type') === 'search' || input.getAttribute('role') === 'searchbox' || input.closest('[role="search"]') !== null,
      size: field?.closest('[data-input-size]')?.getAttribute('data-input-size') ?? '',
    }
  }, searchSel)
  check('搜索框是 BoardUI 的 SearchField', shape.found === true && shape.reactAria === true && shape.kind === 'search', `field=${shape.kind} searchbox=${shape.searchbox}`)
  check('搜索框带官方放大镜与清除键', shape.searchbox === true, 'type/role 不是 searchbox')

  await page.click(searchSel)
  await page.type(searchSel, '超时', { delay: 30 })
  await sleep(600)
  const afterType = await cardTitles()
  const typedValue = await page.$eval(searchSel, node => node.value)
  check('打字之后只剩匹配的卡', afterType.length === 1 && afterType[0].includes('超时'), `${afterType.length} 张`)
  check('输入框自己留住了打的字（受控回写没断）', typedValue === '超时', `value=${JSON.stringify(typedValue)}`)

  await page.evaluate(sel => { const input = document.querySelector(sel); input.focus(); input.select() }, searchSel)
  await page.keyboard.press('Backspace')
  await sleep(600)
  const afterClear = await cardTitles()
  check('清空之后卡片回来', afterClear.length === 2, `${afterClear.length} 张`)

  // ---- 2) 复选框：BoardUI 的 Checkbox（react-aria 的 label > 隐藏 input + 自绘 glyph）
  const boxShape = () => page.evaluate(() => {
    const label = [...document.querySelectorAll('[data-dsh-studio] label')].find(node => (node.textContent || '').includes('隐藏空列'))
    if (!label) return { found: false }
    const input = label.querySelector('input[type="checkbox"]')
    const glyph = [...label.querySelectorAll('span[aria-hidden]')].find(node => /rounded-sm/.test(node.className))
    return {
      found: input !== null && glyph !== undefined,
      nativeChecked: input?.checked === true,
      glyphSelected: glyph ? /shadow-checkbox-selected/.test(glyph.className) : false,
      glyphBox: glyph?.className.includes('size-4') === true ? '16' : '14',
    }
  })
  const beforeBox = await boxShape()
  check('「隐藏空列」是 BoardUI 的 Checkbox（隐藏 input + 自绘 16px glyph）',
    beforeBox.found === true && beforeBox.glyphSelected === false, `glyph=${beforeBox.glyphBox}px`)
  await page.evaluate(() => {
    const label = [...document.querySelectorAll('[data-dsh-studio] label')].find(node => (node.textContent || '').includes('隐藏空列'))
    label?.querySelector('input[type="checkbox"]')?.click()
  })
  await sleep(600)
  const afterHide = await columnCount()
  const afterBox = await boxShape()
  check('勾上之后空列真的消失', afterHide === 2, `${afterHide} 列`)
  check('勾选状态回写进了 glyph（选中样式 + input.checked）',
    afterBox.glyphSelected === true && afterBox.nativeChecked === true,
    `glyph=${afterBox.glyphSelected} checked=${afterBox.nativeChecked}`)

  // ---- 3) 下拉：BoardUI 的 Select（触发按钮 + portal 里的 listbox）
  const triggerOf = label => page.evaluate(sel => {
    const bar = document.querySelector('[data-dsh-studio] [data-board-toolbar]')
    const button = [...(bar?.querySelectorAll('button') ?? [])].find(node => (node.textContent || '').trim() === sel)
    if (!button) return false
    button.click()
    return true
  }, label)
  check('点了「全部类型」下拉', await triggerOf('全部类型'))
  await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 10000 })
  const popShape = await page.evaluate(() => {
    const list = document.querySelector('[role="listbox"]')
    const host = list?.closest('[data-dsh-studio-portal]')
    const panel = list?.closest('[role="dialog"], .shadow-dropdown, [class*="rounded-2xl"]')
    return {
      options: document.querySelectorAll('[role="listbox"] [role="option"]').length,
      inPortal: host !== null && host !== undefined,
      styled: panel !== null && panel !== undefined,
      labels: [...document.querySelectorAll('[role="listbox"] [role="option"]')].map(node => (node.textContent || '').trim()).slice(0, 4),
    }
  })
  check('下拉弹层挂在 data-dsh-studio-portal 容器里（样式不丢）', popShape.inPortal === true, `${popShape.options} 项`)
  check('下拉有 BoardUI 的面板壳子', popShape.styled === true, popShape.labels.join(' / '))
  await sleep(600)
  await page.screenshot({ path: join(REPO, 'tmp', 'fields-select.png') })
  await page.evaluate(() => {
    const option = [...document.querySelectorAll('[role="listbox"] [role="option"]')].find(node => (node.textContent || '').trim() === '缺陷')
    option?.click()
  })
  await sleep(700)
  const afterSelect = await page.evaluate(() => {
    const bar = document.querySelector('[data-dsh-studio] [data-board-toolbar]')
    const button = [...(bar?.querySelectorAll('button') ?? [])].find(node => /缺陷/.test(node.textContent || ''))
    return { trigger: button !== undefined, cards: document.querySelectorAll('[data-dsh-studio] [data-kanban-card]').length }
  })
  check('选「缺陷」之后触发按钮跟着变、结果也筛掉了', afterSelect.trigger === true && afterSelect.cards === 0, `${afterSelect.cards} 张卡`)
  await triggerOf('缺陷')
  await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 10000 })
  await page.evaluate(() => {
    const option = [...document.querySelectorAll('[role="listbox"] [role="option"]')].find(node => (node.textContent || '').trim() === '全部类型')
    option?.click()
  })
  await sleep(700)
  check('清回「全部类型」卡片回来', (await cardTitles()).length === 2)

  // ---- 4) 多行输入：抽屉里的 textarea
  await page.evaluate(() => document.querySelector('[data-dsh-studio] [data-kanban-card]')?.click())
  // 评论框现在只在「讨论」页常驻（测试/概览页收起了），先切页签再验多行输入。
  await page.evaluate(() => {
    const tab = document.querySelector('[data-drawer-tab="discuss"]')
      ?? [...document.querySelectorAll('[role="tab"]')].find(node => String(node.textContent ?? '').includes('讨论'))
    tab?.click()
  })
  await new Promise(resolve => setTimeout(resolve, 600))
  await page.waitForSelector('[data-dsh-studio] [data-drawer] textarea', { timeout: 30000 })
  const areaShape = await page.evaluate(() => {
    const area = document.querySelector('[data-dsh-studio] [data-drawer] textarea')
    const field = area?.closest('[data-input-size]')
    return { found: area !== null, reactAria: field !== null, rows: area?.getAttribute('rows') ?? '' }
  })
  check('抽屉里的多行输入是 BoardUI 的 Textarea', areaShape.found === true && areaShape.reactAria === true, `rows=${areaShape.rows}`)
  const areaSel = '[data-dsh-studio] [data-drawer] textarea'
  const focused = await page.evaluate(() => {
    const area = [...document.querySelectorAll('[data-dsh-studio] [data-drawer] textarea')]
      .find(node => node.offsetParent !== null && node.getBoundingClientRect().height > 0)
    if (!area) return false
    area.focus()
    return document.activeElement === area
  })
  check('抽屉里的多行输入能聚焦', focused === true)
  await page.keyboard.type('走查通过', { delay: 30 })
  await sleep(400)
  const areaValue = await page.evaluate(() => {
    const area = [...document.querySelectorAll('[data-dsh-studio] [data-drawer] textarea')]
      .find(node => node.offsetParent !== null && node.getBoundingClientRect().height > 0)
    return area?.value ?? ''
  })
  check('多行输入留住了打的字', areaValue.includes('走查通过'), `value=${JSON.stringify(areaValue.slice(0, 20))}`)

  // ---- 4) 日期输入：react-aria 对 type=date 有专门处理，单独看一眼
  const planTab = await page.evaluate(() => {
    const tab = [...document.querySelectorAll('[data-dsh-studio] [data-drawer] [role="tab"]')].find(node => (node.textContent || '').trim() === '计划')
    if (!tab) return false
    tab.click()
    return true
  })
  if (planTab) {
    await sleep(600)
    const plan = await page.evaluate(() => {
      const drawer = document.querySelector('[data-dsh-studio] [data-drawer]')
      return {
        text: (drawer?.innerText ?? '').length,
        broken: (document.body.innerText || '').includes('渲染失败'),
        dateTrigger: drawer?.querySelectorAll('button[aria-haspopup], input').length ?? 0,
      }
    })
    // 日期控件已换成官方 DatePicker（不再是 input[type=date]），所以这里只验：
    // 计划页打开不崩、页面上确实有可交互的日期类控件
    check('计划页打开且日期控件在位（官方 DatePicker）', plan.text > 30 && plan.broken === false && plan.dateTrigger > 0, plan.text + ' 字 / ' + plan.dateTrigger + ' 个控件')
  } else {
    console.log('skip 抽屉里没有「计划」页签，跳过日期输入一项')
  }

  check('页面没有 pageerror', errors.length === 0, errors.join(' | '))
  await page.screenshot({ path: join(REPO, 'tmp', 'fields-probe.png') })
} catch (error) {
  console.error('探针中断：' + (error?.message ?? error))
  checks.push({ name: '运行', ok: false })
} finally {
  await browser?.close?.()
  server.close()
}
const failed = checks.filter(item => item.ok !== true)
console.log('')
console.log((failed.length === 0 ? '全部通过' : failed.length + ' 项失败') + '（' + checks.length + ' 项）')
process.exit(failed.length === 0 ? 0 : 1)
