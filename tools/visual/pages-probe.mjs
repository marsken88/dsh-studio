#!/usr/bin/env node
/**
 * 六页回归（假宿主 + 真 Chrome）：把每个页签都点一遍，验三件事——
 *   1. 这一页真的渲染出了它该有的东西（不是空白、也不是「渲染失败」）
 *   2. 页面里没有 pageerror，边界里没有「工作空间渲染失败」
 *   3. 顺手截图到 tmp/pages/<页签>.png，方便肉眼对标
 *
 * 为什么要有它：换组件（BoardUI 那套）最容易整页崩，而 React 的错误边界会把异常
 * 吞在自己的渲染树里，pageerror 是空的（见 AGENTS.md §11）。所以必须看 innerText。
 *
 * 页签换成了 BoardUI 的胶囊（button[aria-pressed]），不再是 role=tab，
 * 所以这里按文案点 [data-head-tabs] 下的 button。
 *
 *   node tools/visual/pages-probe.mjs
 */
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultConfig, PRIORITIES, STATUSES } from '../../src/host/domain.js'

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

const now = Date.now()
const baseTask = {
  type: 'requirement', priority: 'normal', requirementId: '', artifacts: [], cases: [],
  checklist: [], history: [], tags: [], acceptance: [], links: {}, dispatch: {},
  design: null, worktree: null, blocked: null, sla: null, dueAt: 0, pointId: '',
  domain: '', requirement: '', updatedAt: now, commentCount: 0, coding: null,
}
const state = {
  revision: 3,
  updatedAt: now,
  profile: 'web',
  statuses: STATUSES,
  // 角色位白名单（issue #150）：假宿主也给一份含运营 + 自定义岗位的配置，
  // 用来断言「列的负责人 → 加候选」里真的能选到它们（写死四岗时这里会红）。
  roles: ['product', 'architect', 'dev', 'qa', 'ops', 'finance'],
  priorities: PRIORITIES,
  config: { ...defaultConfig(), roles: ['product', 'architect', 'dev', 'qa', 'ops', 'finance'] },
  tasks: [
    { ...baseTask, id: 't-1', code: 'DEV-1', title: '库存预占与超时释放', status: 'dev' },
    { ...baseTask, id: 't-2', code: 'DEV-2', title: '支付回调重试', status: 'test' },
  ],
  requirements: [],
  releases: [],
  experts: [],
  agents: [],
  locked: false,
}
// 效能页要的形状（照 index.js 的 buildAnalytics 给空数据版）
const analyticsBody = {
  ok: true,
  analytics: {
    days: 30, project: '', generatedAt: now, scope: { tasks: 2, moved: 0, done: 0 },
    cycle: { count: 0, avgDays: 0, medianDays: 0, p90Days: 0, buckets: [{ id: 'fast', label: '≤1 天', count: 0 }, { id: 'normal', label: '1–3 天', count: 0 }, { id: 'slow', label: '3–7 天', count: 0 }, { id: 'verySlow', label: '>7 天', count: 0 }] },
    rework: { moved: 0, reworked: 0, rate: 0, reviewRework: 0, testRework: 0, firstPassRate: 0, worst: [{ id: 't-1', code: 'DEV-1', title: '库存预占与超时释放', backward: 2, status: 'dev' }] },
    columns: STATUSES.map(item => ({ status: item.id, label: item.label, avgDays: 0, cards: 0 })),
    throughput: [],
    ai: { artifactsTotal: 0, artifactsAi: 0, artifactsEmpty: 0, aiShare: 0, accepted: 0, acceptedRate: 0, emptyBody: 0, aiEmptyBody: 0, codingTasks: 0, codingApproved: 0, codingChanges: 0, codingApprovedRate: 0, unitTests: 0, unitPassed: 0, unitPassRate: 0, merged: 0 },
  },
}
// 项目页要的形状（照 /studio-api/metrics 的真实回包给一份最小数据）
/* 工作台（/dashboard）的回包：以前这个路由落到「其它 studio-api 一律 ok+state」的分支上，
   页面永远拿不到 dashboard，于是永远停在「加载中」骨架——空态排版坏了也看不出来。
   这里按真机形状给一份**列表全空**的数据（正好走空态分支）。 */
const dashboardBody = {
  ok: true,
  regression: null,
  dashboard: {
    at: Date.now(),
    scope: { tasks: 5, open: 5 },
    risks: { overdue: 0, blocked: 0, stalled: 0, slaOverdue: 0, gateFailed: 4, pipelineFailed: 0, integrationsBroken: 1, overrideOver: 0, overrideMax: 3, requirementBlocked: 0, releaseBlocked: 0 },
    flow: { review: 1, test: 1, accept: 3, doneToday: 0, doneWeek: 2 },
    ai: { running: 0, todayRuns: 0 },
    list: { overdue: [], blocked: [], stalled: [], slaOverdue: [], gateFailed: [], pipelineFailed: [], requirementBlocked: [], releaseBlocked: [] },
  },
}

const metricsBody = {
  ok: true,
  metrics: {
    projects: [{
      id: 'p-1', key: 'PUR', name: '采购履约', iterations: [],
      metrics: { total: 2, inProgress: 1, blocked: 0, overdue: 0, done: 1, checklistRate: 50, artifacts: 1, cycleDays: 0, throughput7d: 1, created7d: 0 },
    }],
    unassigned: { total: 0 },
  },
}
const html = `<!doctype html><html><head><meta charset="utf-8"><title>pages probe</title></head>
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
  if (url.pathname === '/studio-api/analytics') return sendJson(200, analyticsBody)
  if (url.pathname === '/studio-api/dashboard') return sendJson(200, dashboardBody)
  if (url.pathname === '/studio-api/metrics') return sendJson(200, metricsBody)
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
const base = `http://127.0.0.1:${server.address().port}`

const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok: ok === true }); console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail === '' ? '' : ' — ' + detail)) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const AX_ROLES = new Set(['button','link','checkbox','radio','switch','textbox','searchbox','combobox','listbox','menuitem','menuitemcheckbox','menuitemradio','tab','option','spinbutton','slider','dialog','alertdialog'])

// 每页「该有的东西」：至少一个能证明它不是空白页的标记；
// 第三项是「必须真的存在」的组件标记（用来盯住新换的 BoardUI 组件，别被别的选择器蒙混）
const PAGES = [
  ['工作台', '[data-insights-page], [data-stat-section], [data-regression-banner], [data-empty-state]', ''],
  ['看板', '[data-board-column] [data-kanban-card], [data-board-column]', ''],
  ['需求', '[data-requirements-page], [data-requirement-row], [data-requirement-desc], [data-empty-state]', ''],
  ['用例', '[data-cases-page], [data-empty-state], [data-task-row]', ''],
  ['版本', '[data-releases-page], [data-empty-state], [data-task-row]', ''],
  ['项目', '[data-project-card], [data-empty-state], [data-projects-page]', ''],
  ['效能', '[data-stat-card], [data-chart-card]', '[data-task-row]'],
  ['设置', '[data-settings] [data-panel], [data-settings], [data-empty-state]', ''],
]

let browser
const outDir = join(REPO, 'tmp', 'pages')
try {
  await mkdir(outDir, { recursive: true })
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1600, height: 1000 } })
  const page = await browser.newPage()
  const axSession = await page.createCDPSession()
  const errors = []
  page.on('pageerror', error => errors.push(String(error).slice(0, 200)))
  await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('[data-dsh-studio] [data-head-tabs] [role="tab"]', { timeout: 45000 })

  for (const [label, marker, mustHave] of PAGES) {
    const clicked = await page.evaluate(sel => {
      const button = [...document.querySelectorAll('[data-dsh-studio] [data-head-tabs] [role="tab"]')]
        .find(node => (node.textContent || '').trim() === sel)
      if (!button) return false
      button.click()
      return true
    }, label)
    await sleep(900)
    const info = await page.evaluate((sel, required) => {
      const text = document.body.innerText || ''
      return {
        failed: text.includes('渲染失败'),
        failText: (text.match(/渲染失败[\s\S]{0,160}/) || [''])[0].replace(/\s+/g, ' '),
        marker: document.querySelector('[data-dsh-studio] ' + sel) !== null,
        required: required === '' ? true : document.querySelector('[data-dsh-studio] ' + required) !== null,
        length: text.length,
        selected: [...document.querySelectorAll('[data-dsh-studio] [data-head-tabs] [role="tab"]')]
          .filter(node => (node.getAttribute('aria-selected') || node.getAttribute('aria-pressed')) === 'true')
          .map(node => (node.textContent || '').trim()),
      }
    }, marker, mustHave)
    check(`切到「${label}」`, clicked === true)
    check(`「${label}」渲染出了内容（${marker}）`, info.marker === true && info.required === true && info.failed === false, `${info.length} 字${info.failed ? ' / ' + info.failText : ''}${info.required ? '' : ' / 缺 ' + mustHave}`)
    check(`「${label}」的页签是高亮状态`, info.selected.includes(label), info.selected.join(','))
    const axTree = await axSession.send('Accessibility.getFullAXTree')
    const unnamed = axTree.nodes.filter(node => !node.ignored && AX_ROLES.has(node.role?.value) && String(node.name?.value ?? '').trim() === '').map(node => node.role.value)
    check(`「${label}」交互节点都有可访问名称`, unnamed.length === 0, unnamed.slice(0, 6).join(','))
    const trapped = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('[data-dsh-studio] a[href],[data-dsh-studio] button,[data-dsh-studio] input,[data-dsh-studio] select,[data-dsh-studio] textarea,[data-dsh-studio] [tabindex]')]
      return nodes.filter(el => {
        if (el.disabled === true || el.tabIndex < 0) return false
        const box = el.getBoundingClientRect()
        if (box.width === 0 || box.height === 0) return false
        return el.closest('[aria-hidden="true"]') !== null
      }).length
    })
    check(`「${label}」没有可聚焦却被 aria-hidden 的节点`, trapped === 0, String(trapped))
    await page.screenshot({ path: join(outDir, `${label}.png`) })
  }

  /* 设置 → 列的负责人：角色位候选必须按 config.roles 出（issue #150）。
     以前 buildRoster 写死 product/architect/dev/qa，运营与自定义岗位在面板里根本选不到——
     接口能配、界面选不了，等于没修。这里点开「加候选」按 DOM 量候选文字。 */
  await page.evaluate(() => {
    [...document.querySelectorAll('[data-dsh-studio] [data-head-tabs] [role="tab"]')]
      .find(node => (node.textContent || '').trim() === '设置')?.click()
  })
  await sleep(900)
  const columnNav = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-settings-nav-item]')]
      .find(node => String(node.textContent ?? '').trim().startsWith('列的负责人'))
    if (el === undefined || el === null) return false
    el.click()
    return true
  })
  await sleep(800)
  const opened = await page.evaluate(() => {
    const row = document.querySelector('[data-column-row]')
    if (row === null) return false
    const button = [...row.querySelectorAll('button')].find(node => String(node.textContent ?? '').trim() === '加候选')
    if (button === undefined) return false
    button.click()
    return true
  })
  await sleep(600)
  const candidates = await page.evaluate(() => {
    const row = document.querySelector('[data-column-row]')
    if (row === null) return []
    return [...row.querySelectorAll('button')].map(node => String(node.textContent ?? '').trim())
  })
  const hasRole = name => candidates.some(text => text.startsWith(`角色 · ${name}`))
  check('设置 → 列的负责人能打开并按角色位出候选（运营）', columnNav === true && opened === true && hasRole('运营'), `nav=${columnNav} open=${opened} 运营=${hasRole('运营')}`)
  check('自定义岗位（finance）也出现在列候选里', hasRole('finance'), candidates.filter(text => text.startsWith('角色 · ')).join(' / '))

  /* 设置里那些「后端有、界面没有」的配置项，现在必须有入口。
     这一组判据盯的是「加完却没渲染出来」：面板崩掉时 pageerror 是空的（AGENTS §11），
     只有按 DOM 量控件才算数。 */
  const openSettingsSection = async prefix => {
    const ok = await page.evaluate(want => {
      const el = [...document.querySelectorAll('[data-settings-nav-item]')]
        .find(node => String(node.textContent ?? '').trim().startsWith(want))
      if (el === undefined || el === null) return false
      el.click()
      return true
    }, prefix)
    await sleep(700)
    return ok
  }
  const countIn = (selector, within) => page.evaluate((sel, scope) => {
    const root = scope === undefined || scope === null || scope === '' ? document : document.querySelector(scope)
    if (root === null) return 0
    return root.querySelectorAll(sel).length
  }, selector, within)
  const textHas = (needle, scope) => page.evaluate((want, sel) => {
    const root = sel === '' ? document : document.querySelector(sel)
    if (root === null) return false
    return String(root.textContent ?? '').includes(want)
  }, needle, scope)

  /* 列的负责人 → 缺陷 SLA 与默认验收清单 */
  await openSettingsSection('列的负责人')
  const slaSection = await countIn('[data-section="sla-templates"]')
  const slaInputs = await page.evaluate(() => [...document.querySelectorAll('[aria-label$="缺陷时限（小时）"]')].length)
  const templateBox = await countIn('[aria-label="开发卡的默认验收清单"]')
  check('列的负责人里有「缺陷 SLA 与默认验收清单」并能填', slaSection === 1 && slaInputs === 4 && templateBox === 1, 'section=' + slaSection + ' inputs=' + slaInputs + ' template=' + templateBox)

  /* 自动派单 → 重试三件套 */
  await openSettingsSection('自动派单')
  const retryMax = await countIn('[aria-label="自动重试最多几次"]')
  const retryBase = await countIn('[aria-label="第一次冷却（秒）"]')
  const retryFactor = await countIn('[aria-label="每次翻几倍"]')
  check('自动派单里有重试次数 / 冷却 / 倍率三个输入', retryMax === 1 && retryBase === 1 && retryFactor === 1, 'max=' + retryMax + ' base=' + retryBase + ' factor=' + retryFactor)

  /* 飞书机器人 → 多维表格镜像（baseToken / tableId / 演练 / 镜像） */
  await openSettingsSection('飞书机器人')
  const bitableSection = await countIn('[data-section="bitable"]')
  const hasMirror = await textHas('镜像到表格', '[data-section="bitable"]')
  const hasDryRun = await textHas('演练', '[data-section="bitable"]')
  check('飞书机器人里有「多维表格镜像」并能演练 / 真写', bitableSection === 1 && hasMirror === true && hasDryRun === true, 'section=' + bitableSection + ' mirror=' + hasMirror + ' dry=' + hasDryRun)

  /* 测试执行 → shell 用例默认工作目录 */
  await openSettingsSection('测试执行')
  const shellCwd = await countIn('[aria-label="shell 用例的默认工作目录"]')
  check('测试执行里能配 shell 用例的默认工作目录', shellCwd === 1, String(shellCwd))

  /* 设置 → 专家：角色位白名单要能在界面上加/删（issue #150）。
     没有这个入口时「加财务岗位」只能手打 POST /config —— 能力在接口里、界面不可达。 */
  const expertsNav = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-settings-nav-item]')]
      .find(node => String(node.textContent ?? '').trim().startsWith('专家') && !String(node.textContent ?? '').includes('团'))
    if (el === undefined || el === null) return false
    el.click()
    return true
  })
  await sleep(800)
  const rolesSection = await page.evaluate(() => {
    const section = document.querySelector('[data-section="roles"]')
    if (section === null) return { section: false }
    const chips = [...section.querySelectorAll('[data-role-chip]')].map(node => node.getAttribute('data-role-chip'))
    const input = section.querySelector('input[aria-label="新岗位 id"]')
    const addButton = [...section.querySelectorAll('button')].find(node => String(node.textContent ?? '').trim() === '加上岗位')
    return { section: true, chips, hasInput: input !== null, hasAdd: addButton !== undefined }
  })
  check('设置 → 专家有「角色位（岗位白名单）」并能加岗位', expertsNav === true && rolesSection.section === true && rolesSection.hasInput === true && rolesSection.hasAdd === true, `nav=${expertsNav} section=${rolesSection.section} input=${rolesSection.hasInput} add=${rolesSection.hasAdd}`)
  check('白名单 chip 按 config.roles 出（运营 + 自定义岗位都在）', (rolesSection.chips ?? []).includes('ops') && (rolesSection.chips ?? []).includes('finance'), (rolesSection.chips ?? []).join(','))

  /* 工作台（加载完成态）：空分区必须真的写出「没有逾期的卡」这类文字。
     2026-11-23 真机截图里几个分区只剩一个空框——因为假宿主以前永远给不到 dashboard，
     加载态从没被渲染过。 */
  await page.evaluate(() => { [...document.querySelectorAll('[data-dsh-studio] [data-head-tabs] [role="tab"]')].find(n => (n.textContent || '').trim() === '工作台')?.click() })
  await sleep(1500)
  const insights = await page.evaluate(() => {
    const root = document.querySelector('[data-dsh-studio] [data-insights-page]')
    if (!root) return { mounted: false }
    const emptyNodes = [...root.querySelectorAll('[data-empty-state]')]
    const panels = [...root.querySelectorAll('.rounded-xl.border')].length
    return {
      mounted: true,
      pending: root.getAttribute('data-insights-pending') !== null,
      emptyNodes: emptyNodes.length,
      emptyWithText: emptyNodes.filter(n => (n.innerText || '').trim().length > 0).length,
      panelCount: panels,
      text: (root.innerText || '').length,
    }
  })
  check('工作台加载完成（不是永远停在骨架）', insights.mounted === true && insights.pending === false, JSON.stringify(insights).slice(0, 120))
  check('工作台的空分区都写出了空态文字', insights.emptyNodes > 0 && insights.emptyWithText === insights.emptyNodes, `空态 ${insights.emptyNodes} 处 · 有字 ${insights.emptyWithText}`)
  /* 空态必须**画得出来**：以前分区在纵向 flex 里被 flex-shrink 压扁，
     空态框虽然还在 DOM 里、getBoundingClientRect 也有尺寸，但被外框 overflow-hidden 裁掉，
     截图里就是一条空条（真机 2026-11-23 截图）。这里量「空态框底边不超过分区底边」。 */
  const clipped = await page.evaluate(() => {
    const root = document.querySelector('[data-dsh-studio] [data-insights-page]')
    const bad = []
    for (const empty of root?.querySelectorAll('[data-empty-state]') ?? []) {
      let panel = empty.parentElement
      while (panel && getComputedStyle(panel).overflow !== 'hidden') panel = panel.parentElement
      if (!panel) continue
      const box = empty.getBoundingClientRect()
      const holder = panel.getBoundingClientRect()
      if (box.bottom > holder.bottom + 1 || box.height < 20) bad.push({ text: (empty.innerText || '').trim().slice(0, 12), emptyH: Math.round(box.height), holderH: Math.round(holder.height) })
    }
    return bad
  })
  check('工作台的空态没有被分区裁掉', clipped.length === 0, clipped.slice(0, 2).map(item => `「${item.text}」框高 ${item.emptyH} / 分区高 ${item.holderH}`).join(' | '))
  await page.screenshot({ path: join(outDir, '工作台-加载完成.png') })

  // 卡片抽屉：dialog 要有名字，里面的交互节点也要有名字（键盘/读屏都能用）
  await page.evaluate(() => { const tab = [...document.querySelectorAll('[data-dsh-studio] [data-head-tabs] [role="tab"]')].find(n => (n.textContent || '').trim() === '看板'); if (tab) tab.click() })
  await sleep(900)
  await page.evaluate(() => { const card = document.querySelector('[data-dsh-studio] [data-kanban-card]'); if (card) card.click() })
  await sleep(1200)
  const drawerAx = await axSession.send('Accessibility.getFullAXTree')
  const dialogs = drawerAx.nodes.filter(node => !node.ignored && (node.role?.value === 'dialog' || node.role?.value === 'alertdialog'))
  const drawerUnnamed = drawerAx.nodes.filter(node => !node.ignored && AX_ROLES.has(node.role?.value) && String(node.name?.value ?? '').trim() === '').map(node => node.role.value)
  check('卡片抽屉的 dialog 有名称', dialogs.length > 0 && String(dialogs[0].name?.value ?? '').trim() !== '', (dialogs[0]?.name?.value ?? '没有 dialog'))
  check('卡片抽屉交互节点都有可访问名称', drawerUnnamed.length === 0, drawerUnnamed.slice(0, 6).join(','))
  // 800px 回归：中窄屏顶栏动作区必须换行，页面不能横向溢出（920px 断点的守门）
  await page.setViewport({ width: 800, height: 1000 })
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('[data-dsh-studio] [data-head-tabs] [role="tab"]', { timeout: 45000 })
  await sleep(900)
  const narrow = await page.evaluate(() => {
    const brand = document.querySelector('[data-dsh-studio] [data-brand]')
    const actions = document.querySelector('[data-dsh-studio] [data-head-actions]')
    const b = brand === null ? null : brand.getBoundingClientRect()
    const a = actions === null ? null : actions.getBoundingClientRect()
    return {
      win: window.innerWidth,
      doc: document.documentElement.scrollWidth,
      brandBottom: b === null ? 0 : Math.round(b.bottom),
      actionsTop: a === null ? 0 : Math.round(a.top),
      hasActions: a !== null,
    }
  })
  check('800px 没有横向溢出', narrow.doc <= narrow.win + 1, `doc=${narrow.doc} win=${narrow.win}`)
  check('800px 顶栏动作区换行（不挤标题）', narrow.hasActions && narrow.actionsTop >= narrow.brandBottom - 1, `actionsTop=${narrow.actionsTop} brandBottom=${narrow.brandBottom}`)
  await page.screenshot({ path: join(outDir, '800-看板.png') })
  check('全程没有 pageerror', errors.length === 0, errors.join(' | '))
} catch (error) {
  console.error('探针中断：' + (error?.message ?? error))
  checks.push({ name: '运行', ok: false })
} finally {
  await browser?.close?.()
  server.close()
}
const failed = checks.filter(item => item.ok !== true)
console.log('')
console.log((failed.length === 0 ? '全部通过' : failed.length + ' 项失败') + '（' + checks.length + ' 项）· 截图在 tmp/pages/')
process.exit(failed.length === 0 ? 0 : 1)
