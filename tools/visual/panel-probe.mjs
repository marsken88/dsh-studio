#!/usr/bin/env node
/**
 * 面板渲染探针：把**真实的 client.js** 挂在一个最小假宿主上，用 puppeteer 跑起来逐页断言。
 *
 * 为什么需要它：
 *   接口测试和单元测试只验数据，验不到「渲染在哪个面板里」。0.9.36 就把「评审闸门」开关
 *   插进了「数据与备份」面板——所有测试都是绿的，设置页里却根本看不到它。
 *   这个探针把那类问题变成可断言的：组件是否渲染、在哪个页签、文案是否正确、有没有报错。
 *
 * 它验的是**真数据**：探针自己起一个静态服务，把 /studio-api/* 反向代理到正在运行的 dsh 实例，
 * 所以页面里看到的是这个实例真实的看板与设置。跑完会删掉自己造的数据（标题带「（探针）」）。
 *
 *   node tools/visual/panel-probe.mjs --base http://127.0.0.1:55222
 *   node tools/visual/panel-probe.mjs --base http://127.0.0.1:55222 --keep   # 保留数据看现场
 *   npm run probe:panel -- --base http://127.0.0.1:55222
 *
 * 依赖 puppeteer-core（devDependency，不进插件运行时）。没有它或没有 Chrome 时**跳过而不是判红**：
 * CI 里不装依赖，这条只在本地/发版前跑。
 */
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { formRowIndex, isProbeCard, normalizePointValue } from '../lib/panel-selectors.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const base = argOf('base', process.env.STUDIO_BASE ?? '')
const keep = argv.includes('--keep')
/* 目标机开了登录时，探针也要带身份：STUDIO_TOKEN = 登录拿到的会话令牌（/auth/login 返回的 token，
   或浏览器 cookie `dsh-auth-*` 的值）。本机免登录的实例不用设。 */
const studioToken = String(process.env.STUDIO_TOKEN ?? '').trim()
if (base === '') {
  console.error('用法：node tools/visual/panel-probe.mjs --base http://127.0.0.1:<dsh 端口> [--keep]')
  process.exit(2)
}

// ---------------------------------------------------------------- 依赖探测（缺了就跳过）
const require = createRequire(import.meta.url)
let puppeteer
try {
  puppeteer = require('puppeteer-core')
} catch {
  console.log('跳过：没装 puppeteer-core（devDependency，只在本地/发版前跑）')
  process.exit(0)
}
const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean).find(path => existsSync(path))
if (CHROME === undefined) {
  console.log('跳过：找不到 Chrome/Edge（可用 CHROME_PATH 指定）')
  process.exit(0)
}

const api = async (path, body) => {
  const res = await fetch(base + '/studio-api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(studioToken === '' ? {} : { 'x-studio-session': studioToken }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}
const state = async () => (await api('/state')).json.state

// ---------------------------------------------------------------- 假宿主（静态 + 代理）
const HARNESS_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>panel probe</title>
<style>html,body,#root{height:100%;margin:0}body{font-family:system-ui,"Microsoft YaHei",sans-serif}</style></head>
<body><div id="root"></div><pre id="boot-error" style="color:#b91c1c;font:13px monospace"></pre>
<script src="/react.js"></script><script src="/react-dom.js"></script>
<script>
  window.__ModuleLoader__ = { load(config) { window.__studioFactory = config.factory } }
</script>
<script src="/client.js"></script>
<script>
  try {
    const React = window.React, ReactDOM = window.ReactDOM
    const mod = window.__studioFactory(name => { if (name === 'react') return React; throw new Error('没有提供模块：' + name) })
    const captured = {}
    const ctx = { slots: { inject: (n, fn) => fn(), register: (slot, component) => { captured[(slot.name ?? '') + ':' + (slot.key ?? slot.id ?? '')] = component; return () => {} } }, effect: fn => { try { return fn() } catch { return () => {} } } }
    if (typeof mod.apply === 'function') mod.apply(ctx)
    const key = Object.keys(captured).find(k => k.startsWith('main:'))
    if (key === undefined) throw new Error('没有拿到 main 槽页面：' + Object.keys(captured).join(','))
    window.__pageMounted = true
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(captured[key], {}))
  } catch (error) {
    document.getElementById('boot-error').textContent = 'BOOT ERROR: ' + (error && error.stack ? error.stack : error)
    window.__bootFailed = String(error && error.message ? error.message : error)
  }
</script></body></html>`

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname.startsWith('/studio-api/')) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    try {
      const upstream = await fetch(base + url.pathname + url.search, {
        method: req.method,
        headers: {
          'content-type': req.headers['content-type'] ?? 'application/json',
          ...(studioToken === '' ? {} : { 'x-studio-session': studioToken }),
        },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : (chunks.length > 0 ? Buffer.concat(chunks) : undefined),
      })
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
      res.end(await upstream.text())
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
    }
    return
  }
  const staticFiles = {
    '/': null,
    '/client.js': join(repo, 'client.js'),
    '/react.js': join(repo, 'web/node_modules/react/umd/react.development.js'),
    '/react-dom.js': join(repo, 'web/node_modules/react-dom/umd/react-dom.development.js'),
  }
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HARNESS_HTML); return }
  const file = staticFiles[url.pathname]
  if (file === undefined || !existsSync(file)) { res.writeHead(404); res.end('not found'); return }
  res.writeHead(200, { 'content-type': extname(file) === '.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream' })
  res.end(await readFile(file))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const harnessUrl = `http://127.0.0.1:${server.address().port}`

// ---------------------------------------------------------------- 造数据（自检标记 + 跑完清理）
const rows = []
const check = (name, ok, detail = '') => {
  rows.push({ name, ok: ok === true })
  console.log(`${ok === true ? '✓' : '✗'} ${name}${detail === '' ? '' : ` — ${String(detail).slice(0, 120)}`}`)
}
let requirementId = ''
let taskId = ''
let browser
const outDir = join(repo, 'tmp', 'probe')
try {
  await mkdir(outDir, { recursive: true })
  const requirement = await api('/requirement/save', {
    requirement: {
      title: '（探针）面板渲染自检',
      description: 'panel-probe 造的临时数据，跑完会删掉',
      discovery: { server: '有', auth: '服务端', boundary: '含测试' },
      points: [{ id: 'p1', title: '探针功能点 A' }, { id: 'p2', title: '探针功能点 B' }],
    },
  })
  requirementId = requirement.json.requirement?.id ?? ''
  const card = await api('/task/create', { title: '（探针）看板卡片', type: 'dev', role: 'dev', status: 'dev', requirementId, pointId: 'p1' })
  taskId = card.json.task?.id ?? ''
  check('准备：造出需求与卡片', requirementId !== '' && taskId !== '')
  /* 执行记录 + 评审结论：卡面要能看到「代码 N 文件 +A −D」「评审通过」两个 chip，
     讨论区要能看到评审结论。以前走工具评审只写 coding.review.note，人翻卡片一个字都看不到。 */
  await api('/task/coding', {
    id: taskId,
    coding: {
      agent: '开发工程师（探针）', model: 'deepseek-v4.1-flash', branch: 'task/probe',
      commits: [{ sha: 'abc1234', message: '探针提交', files: '2' }],
      files: [{ path: 'src/probe.js', change: 'modified', additions: 3, deletions: 1 }],
    },
  })
  await api('/task/coding', { id: taskId, action: 'review', status: 'approved', note: '探针评审：通过', by: '架构师（探针）' })

  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1400, height: 1100 })
  const errors = []
  page.on('pageerror', error => errors.push('pageerror: ' + String(error?.message ?? error)))
  page.on('console', message => { if (message.type() === 'error' && !/favicon|404/.test(message.text())) errors.push('console: ' + message.text().slice(0, 140)) })

  const clickExact = async label => {
    const hit = await page.evaluate(target => {
      const nodes = [...document.querySelectorAll('button, [role="tab"]')]
      const node = nodes.find(item => String(item.textContent ?? '').trim() === target)
      if (node === undefined) return false
      node.click()
      return true
    }, label)
    await new Promise(resolve => setTimeout(resolve, 700))
    return hit
  }
  const waitText = async (needle, timeout = 6000) => {
    try { await page.waitForFunction(t => document.body.innerText.includes(t), { timeout, polling: 200 }, needle); return true } catch { return false }
  }

  await page.goto(harnessUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__pageMounted === true || window.__bootFailed !== undefined, { timeout: 20000 })
  check('面板能在假宿主里挂起来', await page.evaluate(() => window.__pageMounted === true), await page.evaluate(() => window.__bootFailed ?? ''))
  await waitText('看板', 8000)

  // ① 看板：卡片 + 闸门关闭提示
  await clickExact('看板')
  check('① 看板渲染出探针卡片', await waitText('（探针）看板卡片'))
  const gateOff = await page.evaluate(() => document.querySelector('[data-gate-off]')?.textContent ?? null)
  const gates = (await state()).gates
  check('① 闸门关闭时看板顶部有提示', (gates?.design?.enabled !== true) === (gateOff !== null), gateOff ?? '(闸门都开着，应该没有提示)')
  await page.screenshot({ path: join(outDir, 'board.png') })

  // ①b 顶栏运行托盘：1.5 秒轻轮询 /agents，点开能看明细（产品定义 V1 必做第 7 条）
  const tray = await page.evaluate(() => {
    const node = document.querySelector('[data-run-tray]')
    if (node === null) return null
    node.querySelector('summary')?.click()
    return {
      running: node.getAttribute('data-run-tray'),
      stalled: node.getAttribute('data-stalled'),
      text: String(node.textContent ?? ''),
    }
  })
  check('①b 顶栏有运行托盘', tray !== null, tray === null ? '没找到 [data-run-tray]' : `running=${tray.running} stalled=${tray.stalled}`)
  check('①b 运行托盘能展开并说明状态', tray !== null && (tray.text.includes('AI') || tray.text.includes('停摆') || tray.text.includes('没有正在跑')))
  await page.evaluate(() => document.querySelector('[data-run-tray] summary')?.click())

  // ①c 默认口令提示：mustChange=true 时页头要能看见「默认口令」
  const localAuth = (await state()).config?.localAuth ?? {}
  const showsDefaultHint = (await page.evaluate(() => document.body.innerText)).includes('默认口令')
  check('①c 默认口令有可见提示', (localAuth.mustChange === true) === showsDefaultHint, `mustChange=${localAuth.mustChange} 页面可见=${showsDefaultHint}`)

  // ② 抽屉：用例归功能点
  // 这条断言以前「量错了对象」，红出来的值是别人的卡 / 别人的用例（2026-11-22 用真浏览器逐条复现）：
  //   a) 找不到探针卡就退化成点第一张卡 → 读到的是别的卡。实测打开 pointId=p3 那张卡，
  //      读到的正是 {"value":"p3","hint":true}：看起来像「默认值没继承」，其实是样本换人了。
  //   b) 「第一个带『不归功能点』的下拉」也不是新用例表单：卡上每条既有用例自己有归属下拉，
  //      排在表单前面（真机 3 条用例 = 4 个下拉，第 1 个是用例的），读到的是某条用例的功能点。
  // 所以判据分两步：先证明点开的是探针卡（找不到就算红，不许换样本），再只认「这条用例算在」那一行。
  const cardTexts = await page.evaluate(() => [...document.querySelectorAll('[data-kanban-card]')].map(node => String(node.textContent ?? '')))
  const probeIndex = cardTexts.findIndex(text => isProbeCard(text))
  const openedProbeCard = probeIndex < 0
    ? false
    : await page.evaluate(index => {
      const card = document.querySelectorAll('[data-kanban-card]')[index]
      if (card === undefined) return false
      card.click()
      return true
    }, probeIndex)
  check('② 点开的是探针自己造的那张卡（p1）', openedProbeCard, openedProbeCard ? '' : '看板上找不到「（探针）看板卡片」：不许拿别人的卡当样本，先修数据再跑')
  await new Promise(resolve => setTimeout(resolve, 900))
  const sections = await page.evaluate(() => [...document.querySelectorAll('[data-drawer-section]')].map(node => String(node.textContent ?? '')))
  check('② 抽屉打开且有分区', sections.length > 0, `${sections.length} 个分区`)
  check('② 抽屉里有「测试用例」区', sections.some(text => text.includes('测试用例')))
  /* 新用例表单那一行用 [data-case-point-row] 认（当前面板的 DOM 钩子），不再取第一个带「不归功能点」的下拉：
     卡上每条既有用例自己有归属下拉，排在表单前面，读到的是某条用例的功能点（真机 3 条用例 = 4 个下拉）。
     formRowIndex 仍按「这条用例算在」认行，避免以后 DOM 顺序再变时又量错对象。 */
  const drawerRows = await page.evaluate(() => [...document.querySelectorAll('[data-case-point-row], [data-drawer-case-row]')].map(node => ({
    text: String(node.textContent ?? ''),
    value: node.querySelector('select')?.value ?? null,
  })))
  const formRow = drawerRows[formRowIndex(drawerRows.map(row => row.text))] ?? null
  const casePoint = formRow === null || formRow.value === null
    ? null
    : { value: formRow.value, empty: normalizePointValue(formRow.value) === '', hint: formRow.text.includes('默认跟卡上的功能点') }
  check('② 新用例表单的功能点选择器默认继承卡（p1）', casePoint !== null && casePoint.value === 'p1', JSON.stringify(casePoint))
  check('② 选择器旁有「默认跟卡上的功能点」说明', casePoint?.hint === true)

  /* ②a 卡面要看到「改了什么代码、评审过没过」：
     研发干完活、架构评审完，人第一眼看的是卡片，而不是翻抽屉执行记录页签。 */
  const chipInfo = await page.evaluate(() => {
    const card = [...document.querySelectorAll('[data-kanban-card]')]
      .find(node => String(node.textContent ?? '').includes('（探针）看板卡片'))
    if (card === undefined) return null
    const code = card.querySelector('[data-code]')
    const review = card.querySelector('[data-coding-review]')
    return {
      codeText: String(code?.textContent ?? ''),
      reviewText: String(review?.textContent ?? ''),
      reviewState: review?.getAttribute('data-coding-review') ?? '',
      reviewTitle: review?.getAttribute('title') ?? '',
    }
  })
  check('②a 卡面显示代码改动规模', chipInfo !== null && /代码 1 文件/.test(chipInfo.codeText) && chipInfo.codeText.includes('+3') && chipInfo.codeText.includes('−1'), JSON.stringify(chipInfo?.codeText ?? null))
  check('②a 卡面显示评审结论', chipInfo !== null && chipInfo.reviewState === 'approved' && chipInfo.reviewText.includes('评审通过'), JSON.stringify(chipInfo))
  check('②a 评审 chip 悬停能看到评审人与意见', chipInfo !== null && chipInfo.reviewTitle.includes('架构师（探针）') && chipInfo.reviewTitle.includes('探针评审'))
  const probeComments = await api('/task/comments', { id: taskId })
  const commentBodies = (probeComments.json.comments ?? []).map(item => String(item.body ?? ''))
  check('②a 评审结论自动补成评论（讨论区看得到）', commentBodies.some(body => body.includes('代码评审 · 通过') && body.includes('探针评审：通过')))

  /* ②a2 执行记录 → 代码改动：真实 git diff 的入口。
     探针卡没配代码目录，这里验两件事：区块在、而且说清了为什么读不到（不空着不报错）。 */
  await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')]
    .find(node => String(node.textContent ?? '').trim().startsWith('执行记录'))?.click())
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-drawer-diff]')
    if (node === null) return false
    return node.querySelector('[data-diff-range]') !== null || /没配代码目录|不是可用的 git 仓库|找不到基线分支/.test(String(node.textContent ?? ''))
  }, { timeout: 8000, polling: 200 }).catch(() => {})
  const diffSection = await page.evaluate(() => document.querySelector('[data-drawer-diff]')?.textContent ?? null)
  check('②a2 执行记录里有「代码改动」区', diffSection !== null, diffSection === null ? '没找到 [data-drawer-diff]' : '')
  check('②a2 读不到仓库时说清原因（不空着不报错）', diffSection !== null && /没配代码目录|不是可用的 git 仓库|找不到基线分支/.test(diffSection), String(diffSection ?? '').slice(0, 120))
  await page.screenshot({ path: join(outDir, 'drawer-diff.png') })

  // ②b 交接契约：从抽屉写入 → 回读 /task/get（能创建的东西必须有能用的路径）
  await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')]
    .find(node => (node.textContent ?? '').trim() === '交接')?.click())
  await new Promise(resolve => setTimeout(resolve, 400))
  const filled = await page.evaluate(() => {
    const area = document.querySelector('[data-handoff-field="decision"] textarea')
    if (area === null) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(area, '探针决策：先写契约再交接')
    area.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })
  await new Promise(resolve => setTimeout(resolve, 300))
  const saved = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(node => (node.textContent ?? '').trim() === '保存交接')
    if (button === undefined) return false
    button.click()
    return true
  })
  await new Promise(resolve => setTimeout(resolve, 1200))
  const gotHandoff = (await api('/task/get', { id: taskId })).json.task?.handoff ?? null
  check('②b 交接契约面板有五段且能提交', filled === true && saved === true, filled === true ? '' : '没找到 [data-handoff-field="decision"] textarea')
  /* 回读要目标机已经是这批代码。还没部署时后端会忽略 handoff（200 但不落库），
     这里只提示、不判红；部署后同一个探针会自动变成真正的端到端断言。 */
  if (gotHandoff?.decision === '探针决策：先写契约再交接') {
    check('②b 契约写入后能从 /task/get 回读', true)
  } else {
    console.log('ℹ ②b 回读跳过：目标机后端还没接受 handoff（部署这批后会自动断言）')
  }
  if (gotHandoff === null) {
    console.log('ℹ ②b 页签的 ✓ 标记跳过：契约还没落库（旧后端），部署后才有')
  } else {
    check('②b 交接页签有已填写标记', await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')]
      .some(node => (node.textContent ?? '').includes('交接') && (node.textContent ?? '').includes('✓'))))
  }
  await page.screenshot({ path: join(outDir, 'drawer.png') })

  // ③ 需求页：覆盖率口径
  // 先关掉抽屉：不关的话设置页截图会被挡住一半，看不出左栏的样式
  await clickExact('关闭')
  await new Promise(resolve => setTimeout(resolve, 400))
  await clickExact('需求')
  check('③ 需求页矩阵渲染', await waitText('功能点与可追溯矩阵'))
  check('③ 覆盖率口径写出来了', (await page.evaluate(() => document.body.innerText)).includes('覆盖率按功能点算'))

  // ③b 需求页搜索与来源筛选是真的（以前只写 localStorage + dispatchEvent('resize')，列表不变）
  const typedQuery = await page.evaluate(() => {
    const input = [...document.querySelectorAll('[data-dsh-studio] input')].find(node => String(node.placeholder ?? '').includes('搜编号'))
    if (input === undefined) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '面板渲染自检')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })
  await new Promise(resolve => setTimeout(resolve, 500))
  const matchedRows = await page.evaluate(() => [...document.querySelectorAll('[data-requirement-row]')].map(node => String(node.textContent ?? '')).join('|'))
  check('③b 需求页搜索能筛出探针需求', typedQuery === true && matchedRows.includes('面板渲染自检'), matchedRows.slice(0, 80))

  await page.evaluate(() => {
    const input = [...document.querySelectorAll('[data-dsh-studio] input')].find(node => String(node.placeholder ?? '').includes('搜编号'))
    if (input === null || input === undefined) return
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await new Promise(resolve => setTimeout(resolve, 400))
  const sourceLabel = () => page.evaluate(() => [...document.querySelectorAll('button')]
    .find(node => (node.textContent ?? '').startsWith('来源：'))?.textContent ?? '')
  const beforeSource = await sourceLabel()
  await page.evaluate(() => [...document.querySelectorAll('button')].find(node => (node.textContent ?? '').startsWith('来源：'))?.click())
  await new Promise(resolve => setTimeout(resolve, 400))
  const afterSource = await sourceLabel()
  check('③b 来源筛选点一下就变（不再依赖 resize）', beforeSource !== afterSource, `${beforeSource} → ${afterSource}`)
  // 还原成「全部」，别影响后面的探针
  let guard = 0
  while (guard < 3 && (await sourceLabel()) !== '来源：全部') {
    guard += 1
    await page.evaluate(() => [...document.querySelectorAll('button')].find(node => (node.textContent ?? '').startsWith('来源：'))?.click())
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  await page.screenshot({ path: join(outDir, 'requirement.png') })

  // ④ 设置 → 列的负责人：两道闸门开关
  await clickExact('设置')
  await clickExact('列的负责人')
  await waitText('每一列由谁负责')
  const gateButtons = await page.evaluate(() => ({
    design: document.querySelector('[data-design-gate]')?.getAttribute('data-design-gate') ?? null,
    review: document.querySelector('[data-review-gate]')?.getAttribute('data-review-gate') ?? null,
    reviewText: document.querySelector('[data-review-gate]')?.textContent ?? null,
    tiers: document.querySelector('[data-tier-gate]')?.getAttribute('data-tier-gate') ?? null,
    requirement: document.querySelector('[data-requirement-gate]')?.getAttribute('data-requirement-gate') ?? null,
  }))
  check('④ 设置页有设计闸门开关', gateButtons.design !== null, gateButtons.design ?? '')
  check('④ 设置页有评审闸门开关（在「列的负责人」里）', gateButtons.review !== null, gateButtons.reviewText ?? '没找到 [data-review-gate]')
  check('④ 评审闸门默认开启', gateButtons.review === 'on', gateButtons.reviewText ?? '')
  check('④ 设置页有三层测试闸门开关（默认开启）', gateButtons.tiers === 'on', gateButtons.tiers ?? '没找到 [data-tier-gate]')
  check('④ 设置页有拆卡验收条件闸门开关（默认开启）', gateButtons.requirement === 'on', gateButtons.requirement ?? '没找到 [data-requirement-gate]')
  await page.screenshot({ path: join(outDir, 'settings-gates.png') })

  // ④b 设置 → 文档出口：出口选择真的渲染出来了（能建的东西必须有能用的路径）
  // 带计数徽标的导航项按文本精确匹配点不到（文本是「文档出口0」），这里按前缀找。
  const docsNav = await page.evaluate(() => {
    const el = [...document.querySelectorAll('button, [role="button"], a')]
      .find(node => (node.textContent ?? '').trim().startsWith('文档出口'))
    if (el === undefined || el === null) return false
    el.click()
    return true
  })
  if (docsNav === true) await new Promise(resolve => setTimeout(resolve, 700))
  const docsPane = await page.evaluate(() => ({
    provider: document.querySelector('[data-docs-sink]')?.getAttribute('data-docs-sink') ?? null,
    text: document.body.innerText,
  }))
  check('④b 设置页有「文档出口」面板', docsNav === true && docsPane.provider !== null, docsPane.provider ?? '没找到 [data-docs-sink]')
  check('④b 文档出口写清了主从关系', docsPane.text.includes('WeKnora 失败只记 error'))
  await page.screenshot({ path: join(outDir, 'docs-sink.png') })

  // ④c 面板写路径：改出口 → 点保存 → 切走再切回 → 回读属性（渲染对了不等于存得进去）
  const saveOnce = async value => page.evaluate(async next => {
    const root = document.querySelector('[data-docs-sink]')
    if (root === null) return { ok: false, reason: 'no-panel' }
    const select = root.querySelector('select')
    if (select === null) return { ok: false, reason: 'no-select' }
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(select, next)
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 300))
    const button = [...document.querySelectorAll('button')].find(node => (node.textContent ?? '').includes('保存'))
    if (button === undefined) return { ok: false, reason: 'no-save-button' }
    button.click()
    await new Promise(resolve => setTimeout(resolve, 1500))
    return { ok: true }
  }, value)
  const providerBefore = docsPane.provider
  const providerTarget = providerBefore === 'weknora' ? 'feishu' : 'weknora'
  const writeAttempt = await saveOnce(providerTarget)
  await clickExact('集成健康')
  const backOk = await page.evaluate(() => {
    const el = [...document.querySelectorAll('button, [role="button"], a')].find(node => (node.textContent ?? '').trim().startsWith('文档出口'))
    if (el === undefined || el === null) return false
    el.click()
    return true
  })
  await new Promise(resolve => setTimeout(resolve, 1200))
  const providerAfter = await page.evaluate(() => document.querySelector('[data-docs-sink]')?.getAttribute('data-docs-sink') ?? null)
  check('④c 文档出口「保存」真的写进 config.docs', writeAttempt.ok === true && backOk === true && providerAfter === providerTarget, `期望 ${providerTarget}，回读 ${providerAfter}${writeAttempt.ok === true ? '' : '（' + writeAttempt.reason + '）'}`)
  await saveOnce(providerBefore)
  await new Promise(resolve => setTimeout(resolve, 800))

  // ④d 设置 → 角色与模型：面板能从导航进得去。
  // 0.9.55 之前 paneFor 里有 models 分支，导航数组却没这一项，面板永远打不开。
  const modelsNav = await page.evaluate(() => {
    const el = [...document.querySelectorAll('button, [role="button"], a')]
      .find(node => (node.textContent ?? '').trim().startsWith('角色与模型'))
    if (el === undefined || el === null) return false
    el.click()
    return true
  })
  if (modelsNav === true) await new Promise(resolve => setTimeout(resolve, 700))
  const modelsPane = await page.evaluate(() => ({
    text: document.body.innerText,
    inputs: document.querySelectorAll('[data-dsh-studio] input[placeholder="deepseek-v4.1-flash"]').length,
  }))
  check('④d 设置页有「角色与模型」入口', modelsNav === true, modelsNav ? '' : '导航里没有这一项')
  check('④d 角色与模型面板真的渲染', modelsPane.text.includes('角色与模型') && modelsPane.inputs >= 4, `inputs=${modelsPane.inputs}`)
  await page.screenshot({ path: join(outDir, 'role-models.png') })

  // ④e 设置 → 自动派单：会话跑在哪个目录要写清楚（决定它落在侧栏哪个工作区）。
  // 以前这一项叫「工作区目录」，看不出会话会跑在 ~/dsh-workspace 里、落在「未分组」。
  const agentsNav = await clickExact('自动派单')
  if (agentsNav === true) await new Promise(resolve => setTimeout(resolve, 700))
  const agentsText = await page.evaluate(() => document.body.innerText)
  const agentsPaneOk = agentsNav === true && agentsText.includes('兜底工作目录') && agentsText.includes('本机代码目录')
  check(
    '④e 设置页自动派单讲清了会话目录',
    agentsPaneOk,
    agentsPaneOk ? '' : `nav=${agentsNav} 兜底=${agentsText.includes('兜底工作目录')} 本机代码目录=${agentsText.includes('本机代码目录')}`,
  )
  await page.screenshot({ path: join(outDir, 'agents.png') })

  // ④f 设置 → 自动派单 → 提权审批：用户要的「始终允许完全访问」必须有地方配。
  // 判据按 DOM 量：这个面板里得有一个带两个口径（allow/deny）的下拉，
  // 而不是只在别处出现一句文案。
  const escalation = await page.evaluate(() => {
    const pane = document.querySelector('[data-settings-pane="agents"]')
    if (pane === null) return { pane: false, labels: [], options: [] }
    const selects = [...pane.querySelectorAll('select')]
    const hit = selects.find(sel => String(sel.innerText ?? '').includes('始终允许完全访问'))
    return {
      pane: true,
      labels: selects.map(sel => String(sel.getAttribute('aria-label') ?? '').slice(0, 24)),
      options: hit === undefined ? [] : [...hit.options].map(option => option.value),
    }
  })
  check(
    '④f 设置页自动派单能改提权审批（allow / deny 两个口径）',
    escalation.pane === true && escalation.options.includes('allow') && escalation.options.includes('deny'),
    JSON.stringify(escalation),
  )

  // ⑤ 设置 → 技能库：使用读数
  const skillsNav = await clickExact('技能库')
  if (skillsNav === true) await new Promise(resolve => setTimeout(resolve, 800))
  const skillText = await page.evaluate(() => document.body.innerText)
  check('⑤ 技能库面板能打开', skillsNav === true, skillsNav ? '' : '没找到「技能库」入口')
  check('⑤ 技能行有使用读数', skillText.includes('用上') || skillText.includes('还没被用上'))
  await page.screenshot({ path: join(outDir, 'skills.png') })

  // ⑥ 工作台排版：块与块之间不许压在一起，KPI 不许落单（2026-11-20 真机踩过）
  //    真机症状：两组 KPI 各 5 张卡按 4 列排，第 5 张落到第二行，「整体情况」那一节的底边
  //    又是 0 距离，于是落单的「AI 在跑」卡片直接压在「流程与产出」面板上边线上。
  //    这里量的是几何：正文直接子块的垂直间距，以及 KPI 最后一行的张数。
  await clickExact('工作台')
  await new Promise(resolve => setTimeout(resolve, 900))
  const layout = await page.evaluate(() => {
    const root = document.querySelector('[data-dsh-studio]')
    if (root === null) return { gaps: [], orphan: [] }
    const body = root.querySelector('[data-settings-page], [data-market-page]')
    const gaps = []
    if (body !== null) {
      const kids = [...body.children].filter(el => {
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.position === 'absolute' || cs.visibility === 'hidden') return false
        const r = el.getBoundingClientRect()
        return r.width > 8 && r.height > 8
      })
      let prev = null
      for (const el of kids) {
        const r = el.getBoundingClientRect()
        if (prev !== null) {
          const pr = prev.getBoundingClientRect()
          if (!(r.left >= pr.right - 2 || pr.left >= r.right - 2)) {
            const gap = Math.round(r.top - pr.bottom)
            if (gap < 8) gaps.push(`${prev.className.split(' ')[0]} → ${el.className.split(' ')[0]} = ${gap}px`)
          }
        }
        prev = el
      }
    }
    const orphan = []
    for (const section of root.querySelectorAll('[data-stat-section]')) {
      const grid = section.lastElementChild
      if (grid === null) continue
      const rects = [...grid.children].map(el => el.getBoundingClientRect()).filter(r => r.width > 0)
      if (rects.length < 2) continue
      const byTop = new Map()
      for (const r of rects) byTop.set(Math.round(r.top), (byTop.get(Math.round(r.top)) ?? 0) + 1)
      const counts = [...byTop.values()]
      if (counts.length > 1 && counts[counts.length - 1] === 1) orphan.push(`${rects.length} 张卡排成 ${counts.join('+')}`)
    }
    return { gaps, orphan }
  })
  check('⑥ 工作台块与块之间不贴在一起（间距 ≥ 8px）', layout.gaps.length === 0, layout.gaps.slice(0, 3).join(' / '))
  check('⑥ 工作台 KPI 不落单（没有一行只剩一张卡）', layout.orphan.length === 0, layout.orphan.join(' / '))
  await page.screenshot({ path: join(outDir, 'dashboard-layout.png') })

  /* ⑦ 可选：打开一张**真卡**（已经跑过研发、有 worktree）看逐文件 diff。
     探针自己造的卡没有仓库，只能验空态；真 diff 的渲染要靠这条（STUDIO_DIFF_CARD=标题片段）。 */
  const diffCardTitle = String(process.env.STUDIO_DIFF_CARD ?? '').trim()
  if (diffCardTitle !== '') {
    await clickExact('看板')
    const opened = await page.evaluate(title => {
      const card = [...document.querySelectorAll('[data-kanban-card]')]
        .find(node => String(node.textContent ?? '').includes(title))
      if (card === undefined) return false
      card.click()
      return true
    }, diffCardTitle)
    check('⑦ 打开指定的真卡', opened === true, diffCardTitle)
    await new Promise(resolve => setTimeout(resolve, 900))
    const drawerTabs = await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].map(node => String(node.textContent ?? '').trim()))
    check('⑦ 真卡的抽屉打开了', drawerTabs.some(label => label.includes('执行记录')), drawerTabs.join(' / ').slice(0, 160))
    await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')]
      .find(node => String(node.textContent ?? '').trim().startsWith('执行记录'))?.click())
    const rendered = await page.waitForFunction(() => {
      const node = document.querySelector('[data-drawer-diff]')
      if (node === null) return false
      return node.querySelector('[data-diff-range]') !== null && node.querySelectorAll('[data-diff-file]').length > 0
    }, { timeout: 20000, polling: 300 }).then(() => true).catch(() => false)
    const diffInfo = await page.evaluate(() => {
      const node = document.querySelector('[data-drawer-diff]')
      return {
        range: String(node?.querySelector('[data-diff-range]')?.textContent ?? ''),
        totals: String(node?.querySelector('[data-diff-totals]')?.textContent ?? ''),
        files: node?.querySelectorAll('[data-diff-file]').length ?? 0,
        text: String(node?.textContent ?? '').slice(0, 200),
      }
    })
    check('⑦ 真卡能看到逐文件 diff（分支 ← 基线 + 每个文件 +N −M）', rendered === true && diffInfo.files > 0, JSON.stringify(diffInfo))
    const expanded = await page.evaluate(() => {
      const row = document.querySelector('[data-drawer-diff] [data-diff-file] [role="button"]')
      if (row === null) return false
      row.click()
      return true
    })
    await new Promise(resolve => setTimeout(resolve, 400))
    const patchLines = await page.evaluate(() => document.querySelector('[data-drawer-diff] pre')?.querySelectorAll('div')?.length ?? 0)
    check('⑦ 展开文件能看到逐行 patch', expanded === true && patchLines > 5, `patchLines=${patchLines}`)
    await page.screenshot({ path: join(outDir, 'drawer-diff-real.png') })
  }

  check('全程没有 pageerror / console 错误', errors.length === 0, errors.slice(0, 3).join(' | '))
} finally {
  if (browser !== undefined) await browser.close()
  await new Promise(resolve => server.close(resolve))
  if (keep !== true) {
    try {
      if (taskId !== '') await api('/task/delete', { id: taskId, confirm: 'DELETE' })
      // 连云盘目录一起删：不删的话每跑一次探针就在云盘根下多一个同名文件夹（真的发生过 200 个）
      if (requirementId !== '') await api('/requirement/delete', { id: requirementId, confirm: 'DELETE', deleteFolder: true })
    } catch { /* 清理失败不影响结论 */ }
  }
  const left = keep === true ? '' : ` 清理：${taskId === '' ? '' : '卡片已删 '}${requirementId === '' ? '' : '需求已删'}`
  if (left !== '') console.log(left.trim())
}

const failed = rows.filter(row => row.ok !== true)
console.log(`\n${rows.length - failed.length}/${rows.length} 通过（截图：tmp/probe/）`)
process.exitCode = failed.length === 0 ? 0 : 1
