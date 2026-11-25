#!/usr/bin/env node
/**
 * 无障碍树探针（L1）：不看像素，直接看浏览器交给读屏的那棵树。
 *
 *   STUDIO_TOKEN=… STUDIO_BASE=http://<host>:18080 npm run verify:ax
 *
 * 用 CDP 的 Accessibility.getFullAXTree 拿全量节点，检查四类"读屏会念错/念不出来"的问题：
 *   1. 交互节点没有可访问名称（读屏只念「按钮」）
 *   2. 可聚焦却被 ignored（键盘能 Tab 到，读屏走不到 —— 最阴的一类）
 *   3. 标题层级跳跃（h2 后面直接 h4）
 *   4. 对话框没有名称
 *
 * 它能替代的：结构/命名/顺序类问题。
 * 它不能替代的：真实播报的啰嗦程度、标点停顿、朗读时机、快捷键交互 —— 那些要真读屏（NVDA/VoiceOver）。
 */
import { createRequire } from 'node:module'

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
if (token === '' || baseUrl === '') {
  console.error('需要 STUDIO_TOKEN 与 STUDIO_BASE')
  process.exit(2)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// 读屏能"操作"的角色：这些角色没有名字就是硬伤
const INTERACTIVE = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'textbox', 'searchbox',
  'combobox', 'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'option', 'spinbutton', 'slider', 'dialog', 'alertdialog',
])

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width: 1600, height: 1000 },
})
const page = await browser.newPage()
/* 宿主登录也可能只认 cookie（?token= 是 agent 面板的入口）。STUDIO_COOKIE 支持
   「name=value; name2=value2」，在做登录的实例上跑探针时用（值从浏览器 cookie 里取）。 */
const cookieSpec = String(process.env.STUDIO_COOKIE ?? "").trim()
if (cookieSpec !== "") {
  const origin = new URL(baseUrl)
  const parsed = cookieSpec.split(";").map(part => part.trim()).filter(Boolean).map(part => {
    const at = part.indexOf("=")
    return at > 0 ? { name: part.slice(0, at), value: part.slice(at + 1), domain: origin.hostname, path: "/" } : null
  }).filter(Boolean)
  if (parsed.length > 0) await page.setCookie(...parsed)
}
const pageErrors = []
page.on('pageerror', error => pageErrors.push(String(error).slice(0, 160)))
const cdp = await page.createCDPSession()
await cdp.send('Accessibility.enable')
await cdp.send('DOM.enable')

async function axSnapshot() {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree')
  return nodes.map(node => {
    const role = node.role?.value ?? ''
    const name = String(node.name?.value ?? '').trim()
    const props = new Map((node.properties ?? []).map(item => [item.name, item.value?.value]))
    return {
      backendDOMNodeId: node.backendDOMNodeId,
      role,
      name,
      ignored: node.ignored === true,
      ignoredReason: node.ignoredReasons?.[0]?.name ?? '',
      focusable: props.get('focusable') === true,
      level: Number(props.get('level')) || 0,
      description: String(node.description?.value ?? '').slice(0, 60),
    }
  })
}

/** 把一批节点判成四类问题。 */
function audit(nodes, scope) {
  const findings = { unnamed: [], focusableIgnored: [], headingJumps: [], namelessDialog: [] }
  for (const node of nodes) {
    if (node.ignored) {
      if (node.focusable) findings.focusableIgnored.push({ scope, role: node.role, name: node.name, reason: node.ignoredReason })
      continue
    }
    if (INTERACTIVE.has(node.role) && node.name === '') {
      findings.unnamed.push({ scope, role: node.role, backendDOMNodeId: node.backendDOMNodeId })
    }
    if ((node.role === 'dialog' || node.role === 'alertdialog') && node.name === '') {
      findings.namelessDialog.push({ scope, role: node.role })
    }
  }
  // 标题层级：按树里的出现顺序检查，跳级就记一笔
  const headings = nodes.filter(node => !node.ignored && node.role === 'heading' && node.level > 0)
  let previous = 0
  for (const heading of headings) {
    if (previous > 0 && heading.level > previous + 1) {
      findings.headingJumps.push({ scope, from: previous, to: heading.level, name: heading.name.slice(0, 30) })
    }
    previous = heading.level
  }
  return findings
}

/** 把无障碍节点翻回 DOM 属性，方便定位（否则只看到「有个 textbox 没名字」）。 */
async function describeNode(backendDOMNodeId) {
  if (backendDOMNodeId === undefined) return '(无 id)'
  try {
    const { node } = await cdp.send('DOM.describeNode', { backendNodeId: backendDOMNodeId })
    const attrs = (node.attributes ?? [])
    const map = new Map()
    for (let index = 0; index + 1 < attrs.length; index += 2) map.set(attrs[index], attrs[index + 1])
    const pick = ['id', 'type', 'class', 'placeholder', 'aria-label', 'aria-labelledby', 'role', 'name']
      .filter(key => map.has(key))
      .map(key => key + '=' + String(map.get(key)).slice(0, 40))
      .join(' ')
    return node.nodeName.toLowerCase() + ' ' + pick
  } catch (error) {
    return '(取 DOM 失败：' + String(error?.message ?? error).slice(0, 60) + ')'
  }
}

const report = { tabs: {}, dialogs: {}, pageErrors, error: null }

try {
  await page.goto(`${baseUrl}/?token=${token}`, { waitUntil: 'networkidle2', timeout: 60000 })
  await sleep(2500)
  await page.evaluate(() => {
    const node = [...document.querySelectorAll('*')].find(el => el.children.length === 0 && (el.textContent || '').trim() === '需求&任务工作空间')
    node?.closest('button,a,li,[role="button"],[tabindex]')?.click()
  })
  await page.waitForSelector('[data-dsh-studio]', { timeout: 30000 })
  await sleep(1500)

  const tabs = await page.$$eval('[data-dsh-studio] [data-head-tabs] button', nodes => nodes.map(node => node.textContent.trim()))
  for (const name of tabs) {
    for (const tab of await page.$$('[data-dsh-studio] [data-head-tabs] button')) {
      if (((await tab.evaluate(node => node.textContent)) || '').trim() === name) { await tab.click(); break }
    }
    await sleep(1500)
    const nodes = await axSnapshot()
    const findings = audit(nodes, name)
    // 空名称的节点当场翻成 DOM 属性（浏览器还开着才行）
    for (const bad of findings.unnamed) {
      bad.where = await describeNode(bad.backendDOMNodeId)
    }
    report.tabs[name] = { total: nodes.length, ...findings }
  }

  // 卡片抽屉（打开态的无障碍树才看得到对话框）
  for (const tab of await page.$$('[data-dsh-studio] [data-head-tabs] button')) {
    if (((await tab.evaluate(node => node.textContent)) || '').trim() === '看板') { await tab.click(); break }
  }
  await sleep(1200)
  await page.evaluate(() => { const card = document.querySelector('[data-dsh-studio] [data-kanban-card]'); if (card !== null) card.click() })
  await sleep(1200)
  const drawerNodes = await axSnapshot()
  const drawerDialog = drawerNodes.find(node => !node.ignored && (node.role === 'dialog' || node.role === 'alertdialog'))
  report.dialogs.drawer = {
    found: drawerDialog !== undefined,
    role: drawerDialog?.role ?? '',
    name: drawerDialog?.name ?? '',
    ...audit(drawerNodes, '卡片抽屉'),
  }
  await page.keyboard.press('Escape')
  await sleep(500)
} catch (error) {
  report.error = String(error?.message ?? error).slice(0, 200)
} finally {
  await browser.close()
}

// ---- 汇总 ----
const flat = Object.values(report.tabs)
const unnamed = flat.reduce((sum, item) => sum + item.unnamed.length, 0)
const focusableIgnored = flat.reduce((sum, item) => sum + item.focusableIgnored.length, 0)
const headingJumps = flat.reduce((sum, item) => sum + item.headingJumps.length, 0)
const drawer = report.dialogs.drawer ?? { found: false }
const drawerProblems = (drawer.unnamed?.length ?? 0) + (drawer.focusableIgnored?.length ?? 0) + (drawer.found === true && drawer.name === '' ? 1 : 0)

console.log('== 无障碍树（6 个页签） ==')
console.log(`节点数：${flat.reduce((sum, item) => sum + item.total, 0)}`)
console.log(unnamed === 0 ? 'ok   交互节点都有可访问名称' : `FAIL ${unnamed} 个交互节点没有名字`)
for (const [tab, item] of Object.entries(report.tabs)) {
  for (const bad of item.unnamed.slice(0, 4)) {
    console.log(`  [${tab}] <${bad.role}> 空名称 —— ${bad.where ?? '(未解析)'}`)
  }
}
console.log(focusableIgnored === 0 ? 'ok   可聚焦节点都没有被 ignored' : `FAIL ${focusableIgnored} 个可聚焦节点被 ignored（键盘能到、读屏到不了）`)
for (const [tab, item] of Object.entries(report.tabs)) {
  for (const bad of item.focusableIgnored.slice(0, 4)) console.log(`  [${tab}] <${bad.role}> ${bad.name || '(空)'} —— ${bad.reason}`)
}
console.log(headingJumps === 0 ? 'ok   标题层级没有跳级' : `FAIL ${headingJumps} 处标题跳级`)
for (const [tab, item] of Object.entries(report.tabs)) {
  for (const bad of item.headingJumps.slice(0, 4)) console.log(`  [${tab}] h${bad.from} → h${bad.to}（${bad.name}）`)
}
console.log('')
console.log('== 卡片抽屉（打开态） ==')
console.log(drawer.found === true
  ? `ok   有 ${drawer.role}，名称「${drawer.name || '(空)'}」`
  : 'FAIL 打开抽屉后在无障碍树里找不到 dialog 角色')
console.log(drawerProblems === 0 ? 'ok   抽屉内没有命名/焦点问题' : `FAIL 抽屉内有 ${drawerProblems} 处问题`)
console.log('')
console.log('== pageerror ==', pageErrors.length === 0 ? 'ok 空' : pageErrors)

const failures = []
if (report.error !== null) failures.push('探针中断：' + report.error)
if (unnamed > 0) failures.push(`${unnamed} 个交互节点没有名称`)
if (focusableIgnored > 0) failures.push(`${focusableIgnored} 个可聚焦节点被 ignored`)
if (headingJumps > 0) failures.push(`${headingJumps} 处标题跳级`)
if (drawer.found !== true) failures.push('抽屉在无障碍树里不是 dialog')
if (drawerProblems > 0) failures.push(`抽屉内 ${drawerProblems} 处命名/焦点问题`)

console.log('')
console.log(failures.length === 0
  ? `无障碍树检查通过：${Object.keys(report.tabs).length} 个页签 + 卡片抽屉，没有命名/静默/跳级问题`
  : `无障碍树检查不通过：${failures.join('；')}`)
process.exit(failures.length === 0 ? 0 : 1)
