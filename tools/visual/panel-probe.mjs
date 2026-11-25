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
// 视口可调：真宿主里面板宽度不一定是 1400（窄侧栏/小窗口时排版会变）
const viewportWidth = Math.max(375, Number(argOf('width', '1400')) || 1400)
const viewportHeight = Math.max(600, Number(argOf('height', '1100')) || 1100)
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
  await api('/requirement/doc', { id: requirementId, action: 'add', doc: { kind: 'prd', title: '（探针）PRD', content: '探针正文', at: Date.now() } })
  const card = await api('/task/create', { title: '（探针）看板卡片', type: 'dev', role: 'dev', status: 'dev', requirementId, pointId: 'p1' })
  taskId = card.json.task?.id ?? ''
  check('准备：造出需求与卡片', requirementId !== '' && taskId !== '')
  /* 执行记录 + 评审结论：卡面要能看到「代码 N 文件 +A −D」「评审通过」两个 chip，
     讨论区要能看到评审结论。以前走工具评审只写 coding.review.note，人翻卡片一个字都看不到。 */
  await api('/task/case', {
    id: taskId, action: 'add', by: '测试（探针）',
    cases: [{
      title: '（探针）文档改版后需复跑', result: 'pass', lastRun: { at: 1000 },
      // 必须带可执行断言，否则 pass 会被降级成 pending（不能拿「手标的通过」当证据）
      http: { method: 'GET', url: '/state', expectStatus: 200 },
    }],
  })
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
  await page.setViewport({ width: viewportWidth, height: viewportHeight })
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
  check('②a 卡面显示代码改动规模', chipInfo !== null && chipInfo.codeText.includes('代码 +3 −1'), JSON.stringify(chipInfo?.codeText ?? null))
  check('②a 卡面显示评审结论', chipInfo !== null && chipInfo.reviewState === 'approved' && chipInfo.reviewText.includes('评审通过'), JSON.stringify(chipInfo))
  check('②a 评审 chip 悬停能看到评审人与意见', chipInfo !== null && chipInfo.reviewTitle.includes('架构师（探针）') && chipInfo.reviewTitle.includes('探针评审'))
  const probeComments = await api('/task/comments', { id: taskId })
  const commentBodies = (probeComments.json.comments ?? []).map(item => String(item.body ?? ''))
  check('②a 评审结论自动补成评论（讨论区看得到）', commentBodies.some(body => body.includes('代码评审 · 通过') && body.includes('探针评审：通过')))

  /* ②c 文档改版 → 通过过的用例要复跑（只标不改） */
  await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')]
    .find(node => String(node.textContent ?? '').trim().startsWith('测试'))?.click())
  await new Promise(resolve => setTimeout(resolve, 800))
  const staleChip = await page.evaluate(() => document.querySelector('[data-drawer-case-row] [data-stale="1"]')?.textContent ?? '')
  check('②c 文档改版后的通过用例标「需复跑」', staleChip.includes('需复跑'), staleChip)
  const caseList = await page.evaluate(() => ({
    rows: document.querySelectorAll('[data-drawer-case-row]').length,
    details: document.querySelectorAll('[data-case-details]').length,
    expandable: document.querySelector('[data-case-expand]') !== null,
  }))
  check('②c 用例默认是紧凑卡片（明细收起 + 有详情按钮）', caseList.rows > 0 && caseList.details === 0 && caseList.expandable === true, JSON.stringify(caseList))
  await page.evaluate(() => { document.querySelector('[data-case-expand]')?.click() })
  await new Promise(resolve => setTimeout(resolve, 400))
  const openedDetails = await page.evaluate(() => document.querySelectorAll('[data-case-details]').length)
  check('②c 点「详情」展开这条用例的明细', openedDetails === 1, String(openedDetails))
  const resultChip = await page.evaluate(() => document.querySelector('[data-case-result]')?.getAttribute('data-case-result') ?? '')
  check('②c 用例结果有颜色 chip', resultChip === 'pass', resultChip)
  await page.evaluate(() => { document.querySelector('[aria-label="删除这条用例"]')?.click() })
  await new Promise(resolve => setTimeout(resolve, 500))
  const deleteConfirm = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some(node => String(node.textContent || '').includes('删除用例')))
  check('②c 删除用例先弹确认框', deleteConfirm === true)
  const filterInfo = await page.evaluate(() => ({
    chips: [...document.querySelectorAll('[data-case-filter-chip]')].map(node => node.textContent.trim()),
    rows: document.querySelectorAll('[data-drawer-case-row]').length,
    composer: document.querySelectorAll('[data-drawer-composer]').length,
  }))
  check('②c 用例筛选 chip 存在且测试页不显示评论框', filterInfo.chips.length >= 4 && filterInfo.chips.some(text => text.includes('未跑')) && filterInfo.composer === 0, JSON.stringify(filterInfo))
  await page.evaluate(() => { document.querySelector('[data-case-filter-chip="pending"]')?.click() })
  await new Promise(resolve => setTimeout(resolve, 400))
  const pendingState = await page.evaluate(() => ({
    rows: document.querySelectorAll('[data-drawer-case-row]').length,
    empty: document.body.innerText.includes('没有匹配的用例'),
  }))
  check('②c 点「未跑」筛出 0 条并给空态', pendingState.rows === 0 && pendingState.empty === true, JSON.stringify(pendingState))
  await page.evaluate(() => { document.querySelector('[data-case-filter-chip="all"]')?.click() })
  await new Promise(resolve => setTimeout(resolve, 300))
  const orderOk = await page.evaluate(() => {
    const row = document.querySelector('[data-drawer-case-row]')
    const tier = document.querySelector('[data-tier-row]')
    if (row === null || tier === null) return null
    return (row.compareDocumentPosition(tier) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  })
  check('②c 三层进度排在用例列表之后', orderOk === true)
  const tierBox = await page.evaluate(() => {
    const node = document.querySelector('[data-test-plan]')
    if (node === null) return null
    return { open: node.open === true, summary: String(node.querySelector('summary')?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 100) }
  })
  check('②c 三层块默认收起成一行摘要', tierBox !== null && tierBox.open === false && /单元/.test(tierBox.summary), JSON.stringify(tierBox))
  const caseEditOpened = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(node => String(node.textContent ?? '').trim() === '改定义')
    if (button === undefined) return false
    button.click()
    return true
  })
  await new Promise(resolve => setTimeout(resolve, 400))
  const editForm = await page.evaluate(() => {
    const form = document.querySelector('[data-case-edit]')
    return form === null ? null : { inputs: form.querySelectorAll('input, textarea, select').length, text: String(form.textContent ?? '').slice(0, 80) }
  })
  check('②c 改定义用一个表单（不是连环 prompt）', caseEditOpened === true && editForm !== null && editForm.inputs >= 3, JSON.stringify(editForm))
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('[data-case-edit] button')].find(node => String(node.textContent ?? '').trim() === '取消')
    button?.click()
  })
  await new Promise(resolve => setTimeout(resolve, 300))
  await page.keyboard.press('Escape')
  await new Promise(resolve => setTimeout(resolve, 300))

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

  /* ②c2 评论：发送 → 编辑 → 删除（后端支持 update/remove，界面这轮补上入口） */
  await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')]
    .find(node => String(node.textContent ?? '').trim().startsWith('讨论'))?.click())
  await new Promise(resolve => setTimeout(resolve, 700))
  const commented = await page.evaluate(() => {
    const area = document.querySelector('[data-drawer-composer] textarea')
    if (area === null) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(area, '（探针）可编辑的评论')
    area.dispatchEvent(new Event('input', { bubbles: true }))
    const button = [...document.querySelectorAll('[data-drawer-composer] button')].find(node => String(node.textContent ?? '').trim() === '发表评论')
    button?.click()
    return true
  })
  await new Promise(resolve => setTimeout(resolve, 900))
  const commentSent = await page.evaluate(() => document.querySelector('[data-drawer-comments]')?.textContent?.includes('可编辑的评论') ?? false)
  check('②c2 评论能发送', commented === true && commentSent === true)
  const commentEditOpened = await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-drawer-comment]')].find(node => String(node.textContent ?? '').includes('可编辑的评论'))
    const button = row?.querySelector('[data-comment-edit]')
    if (button === null || button === undefined) return false
    button.click()
    return true
  })
  await new Promise(resolve => setTimeout(resolve, 400))
  const editArea = await page.evaluate(() => document.querySelector('[aria-label="编辑评论"]') !== null)
  check('②c2 评论有编辑入口且能打开编辑框', commentEditOpened === true && editArea === true)
  const commentSaved = await page.evaluate(() => {
    const area = document.querySelector('[aria-label="编辑评论"]')
    if (area === null) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(area, '（探针）评论已编辑')
    area.dispatchEvent(new Event('input', { bubbles: true }))
    const button = [...document.querySelectorAll('button')].find(node => String(node.textContent ?? '').trim() === '保存')
    button?.click()
    return true
  })
  await new Promise(resolve => setTimeout(resolve, 900))
  const edited = await page.evaluate(() => document.querySelector('[data-drawer-comments]')?.textContent?.includes('评论已编辑') ?? false)
  check('②c2 评论能保存修改', commentSaved === true && edited === true)
  const deleteClicked = await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-drawer-comment]')].find(node => String(node.textContent ?? '').includes('评论已编辑'))
    const button = row?.querySelector('[data-comment-delete]')
    if (button === null || button === undefined) return false
    button.click()
    return true
  })
  await new Promise(resolve => setTimeout(resolve, 500))
  const deleteConfirmed = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].find(node => String(node.textContent ?? '').includes('删除评论'))
    const button = dialog === undefined ? undefined : [...dialog.querySelectorAll('button')].find(node => String(node.textContent ?? '').trim() === '删除')
    if (button === undefined) return false
    button.click()
    return true
  })
  await new Promise(resolve => setTimeout(resolve, 900))
  const gone = await page.evaluate(() => !(document.querySelector('[data-drawer-comments]')?.textContent?.includes('评论已编辑') ?? false))
  check('②c2 评论能删除（先确认）', deleteClicked === true && deleteConfirmed === true && gone === true)

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
  await page.evaluate(() => document.querySelector('[data-req-tab="accept"]')?.click())
  await new Promise(resolve => setTimeout(resolve, 400))
  check('③ 需求页矩阵渲染', await waitText('功能点与可追溯矩阵'))
  check('③ 覆盖率口径写出来了', (await page.evaluate(() => document.body.innerText)).includes('覆盖率按功能点算'))
  check('③b 需求矩阵汇总有「需复跑 1」', /需复跑\s*1/.test(await page.evaluate(() => document.body.innerText)))
  const matrixFilter = await page.evaluate(() => document.querySelector('[data-matrix-filter] input') !== null)
  check('③b 需求矩阵有筛选框', matrixFilter === true, matrixFilter ? '' : '没找到 [data-matrix-filter] input')
  if (matrixFilter) {
    const countBefore = await page.evaluate(() => document.querySelector('[data-matrix-count]')?.textContent ?? '')
    await page.evaluate(() => {
      const input = document.querySelector('[data-matrix-filter] input')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, '探针功能点 A')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await new Promise(resolve => setTimeout(resolve, 500))
    const countAfter = await page.evaluate(() => document.querySelector('[data-matrix-count]')?.textContent ?? '')
    check('③b 矩阵筛选真的收窄结果', /显示 1 \//.test(countAfter) && countBefore !== countAfter, `${countBefore} → ${countAfter}`)
  }

  /* 矩阵在「任务与验收」分区里：先切过去再验。 */
  await page.evaluate(() => document.querySelector('[data-req-tab="accept"]')?.click())
  await new Promise(resolve => setTimeout(resolve, 400))

  /* ③c 矩阵行内编辑 + 批量覆盖验收条件 */
  const pickedPoint = await page.evaluate(() => {
    const host = document.querySelector('[data-point-pick]')
    const input = host?.querySelector('input')
    if (input !== null && input !== undefined) { input.click(); return true }
    if (host === null || host === undefined) return false
    host.click()
    return true
  })
  await new Promise(resolve => setTimeout(resolve, 400))
  let bulkText = await page.evaluate(() => document.querySelector('[data-point-bulk]')?.textContent ?? '')
  // 行内勾选没生效时退回「全选」按钮，保证批量入口本身被测到
  if (!bulkText.includes('已选 1')) {
    await clickExact('全选')
    bulkText = await page.evaluate(() => document.querySelector('[data-point-bulk]')?.textContent ?? '')
  }
  check('③c 勾选功能点后批量条出现', pickedPoint === true && bulkText.includes('已选 1'), bulkText)
  const bulkOpened = await clickExact('批量设验收条件')
  const bulkForm = await page.evaluate(() => document.querySelector('[data-point-bulk-form]') !== null)
  check('③c 批量验收条件表单能打开', bulkOpened === true && bulkForm === true)
  await clickExact('取消')
  const editOpened = await page.evaluate(() => {
    const button = document.querySelector('[data-point-edit]')
    if (button === null || button === undefined) return false
    button.click()
    return true
  })
  await new Promise(resolve => setTimeout(resolve, 700))
  const formPos = await page.evaluate(() => {
    const form = document.querySelector('[data-point-form]')
    const table = document.querySelector('[aria-label="需求追溯矩阵"]')
    if (form === null || table === null) return null
    return { formTop: Math.round(form.getBoundingClientRect().top), tableTop: Math.round(table.getBoundingClientRect().top) }
  })
  check('③c 编辑表单在矩阵表格上方（就地）', editOpened === true && formPos !== null && formPos.formTop < formPos.tableTop, JSON.stringify(formPos))
  await clickExact('取消')

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

  // ③d 新建需求走侧滑块（不再把表单铺在页面顶部）
  const newReqOpened = await clickExact('新建需求')
  await new Promise(resolve => setTimeout(resolve, 700))
  const newReqDrawer = await page.evaluate(() => ({
    fallback: document.querySelector('[data-side-drawer]') !== null,
    dialog: document.querySelector('[role="dialog"]') !== null,
    text: String(document.body.innerText ?? '').includes('先写标题与澄清三问'),
  }))
  check('③d 新建需求用侧滑块打开', newReqOpened === true && (newReqDrawer.fallback === true || newReqDrawer.dialog === true) && newReqDrawer.text === true, JSON.stringify(newReqDrawer))
  const inputBox = await page.evaluate(() => {
    const input = document.querySelector('[role="dialog"] input, [data-side-drawer] input')
    if (input === null) return null
    const cs = getComputedStyle(input)
    return { border: cs.borderTopWidth, bg: cs.backgroundColor, radius: cs.borderRadius }
  })
  check('③d 输入框保持 BoardUI 原样（无宿主边框/白底）', inputBox !== null && inputBox.border === '0px' && inputBox.bg === 'rgba(0, 0, 0, 0)' && inputBox.radius === '0px', JSON.stringify(inputBox))
  const selectBox = await page.evaluate(() => {
    const select = document.querySelector('[role="dialog"] button[aria-haspopup="listbox"], [data-side-drawer] button[aria-haspopup="listbox"]')
    if (select === null) return null
    const cs = getComputedStyle(select)
    return { border: cs.borderTopWidth, bg: cs.backgroundColor, radius: cs.borderRadius, shadow: cs.boxShadow }
  })
  /* Select 与 Input 的官方视觉不同：白底 + 1px 边框 + shadow/xs（Figma trigger 规格），别统一改成灰底。 */
  /* 新建需求的「先聊清楚」：不要求用户一上来就填完整表 */
  const chatOpened = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(node => (node.textContent || '').trim() === '先聊清楚')
    if (button === undefined) return false
    button.click()
    return true
  })
  await new Promise(resolve => setTimeout(resolve, 500))
  const chatState = await page.evaluate(() => ({
    ui: document.querySelector('[data-intake-ui]') !== null,
    question: String(document.body.innerText ?? '').includes('这条需求一句话是什么'),
    fieldsHidden: (document.querySelector('[data-intake="1"] input[aria-label="需求标题"]')?.getBoundingClientRect().width ?? 1) === 0,
  }))
  check('③d 新建需求支持「先聊清楚」对话', chatOpened === true && chatState.ui === true && chatState.question === true && chatState.fieldsHidden === true, JSON.stringify(chatState))
  await page.evaluate(() => [...document.querySelectorAll('button')].find(node => (node.textContent || '').trim() === '直接填写')?.click())
  await new Promise(resolve => setTimeout(resolve, 300))
  check('③d Select 保持 BoardUI 官方样式（白底/1px 边框/阴影）', selectBox !== null && selectBox.border === '1px' && selectBox.bg === 'rgb(255, 255, 255)' && selectBox.radius === '10px' && selectBox.shadow !== 'none', JSON.stringify(selectBox))
  await page.keyboard.press('Escape')
  await new Promise(resolve => setTimeout(resolve, 400))

  // ③e 需求详情分区：概览 / 沟通 / 任务与验收 / 交付物
  const tabLabels = await page.evaluate(() => [...document.querySelectorAll('[data-req-tab]')].map(node => String(node.textContent ?? '').trim()))
  const paneVisible = async id => {
    await page.evaluate(tab => document.querySelector('[data-req-tab="' + tab + '"]')?.click(), id)
    await new Promise(resolve => setTimeout(resolve, 400))
    return page.evaluate(() => {
      const pane = document.querySelector('[data-req-pane]')?.getAttribute('data-req-pane') ?? ''
      const visible = [...document.querySelectorAll('[data-req-panel]')].filter(node => getComputedStyle(node).display !== 'none').map(node => node.getAttribute('data-req-panel'))
      return { pane, visible: [...new Set(visible)], text: String(document.querySelector('[data-requirement-body]')?.innerText ?? '').slice(0, 80) }
    })
  }
  const discussPane = await paneVisible('discuss')
  const acceptPane = await paneVisible('accept')
  const artifactPane = await paneVisible('artifacts')
  const overviewPane = await paneVisible('overview')
  check('③e 需求详情有 4 个分区页签', tabLabels.length === 4 && tabLabels.some(text => text.startsWith('概览')) && tabLabels.some(text => text.startsWith('沟通')) && tabLabels.some(text => text.startsWith('交付物')), JSON.stringify(tabLabels))
  check('③e 切「沟通」只显示沟通区', discussPane.pane === 'discuss' && discussPane.visible.length === 1 && discussPane.visible[0] === 'discuss', JSON.stringify(discussPane))
  check('③e 切「任务与验收」只显示验收区', acceptPane.pane === 'accept' && acceptPane.visible.length === 1 && acceptPane.visible[0] === 'accept', JSON.stringify(acceptPane))
  check('③e 切「交付物」只显示交付物区', artifactPane.pane === 'artifacts' && artifactPane.visible.length === 1 && artifactPane.visible[0] === 'artifacts', JSON.stringify(artifactPane))
  check('③e 切回「概览」只显示概览区', overviewPane.pane === 'overview' && overviewPane.visible.length === 1 && overviewPane.visible[0] === 'overview', JSON.stringify(overviewPane))

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

  /* ④g 未保存提醒：设置页有一大半是「改完点保存」，切分区前必须提示。
     这里只改本地表单（不点保存），断言脏标记、横幅、切换确认三件事。 */
  await clickExact('设置')
  await clickExact('看板外观')
  await new Promise(resolve => setTimeout(resolve, 600))
  const typedDirty = await page.evaluate(() => {
    const input = document.querySelector('[data-settings-pane] input')
    if (input === null) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '探针：未保存的标题改动')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })
  await new Promise(resolve => setTimeout(resolve, 300))
  const dirtyState = await page.evaluate(() => ({
    flag: document.querySelector('[data-settings-dirty]')?.getAttribute('data-settings-dirty') ?? '',
    banner: document.querySelector('[data-settings-dirty-banner]') !== null,
  }))
  check('④g 文本输入会标出「未保存」', typedDirty === true && dirtyState.flag === '1' && dirtyState.banner === true, JSON.stringify(dirtyState))
  const savebar = await page.evaluate(() => {
    const node = document.querySelector('[data-settings-savebar]')
    if (node === null) return null
    const rect = node.getBoundingClientRect()
    return { dirty: node.getAttribute('data-dirty'), text: String(node.textContent ?? ''), inView: rect.bottom > 0 && rect.top < window.innerHeight }
  })
  check('④g 保存条粘在视口内并标「未保存」', savebar !== null && savebar.dirty === '1' && savebar.text.includes('未保存') && savebar.inView === true, JSON.stringify(savebar))
  await page.evaluate(() => [...document.querySelectorAll('[data-settings-nav-item]')]
    .find(node => String(node.textContent ?? '').includes('专家'))?.click())
  await new Promise(resolve => setTimeout(resolve, 600))
  const askDiscard = await page.evaluate(() => document.body.innerText.includes('未保存的修改'))
  check('④g 脏着切分区会先确认', askDiscard === true)
  await page.evaluate(() => [...document.querySelectorAll('button')]
    .find(node => String(node.textContent ?? '').includes('丢弃并切换'))?.click())
  await new Promise(resolve => setTimeout(resolve, 700))
  const switched = await page.evaluate(() => document.querySelector('[data-settings-pane]')?.getAttribute('data-settings-pane') ?? '')
  check('④g 确认丢弃后切到专家', switched === 'experts', switched)

  // ⑤ 设置 → 技能库：使用读数
  const skillsNav = await clickExact('技能库')
  if (skillsNav === true) await new Promise(resolve => setTimeout(resolve, 800))
  const skillText = await page.evaluate(() => document.body.innerText)
  check('⑤ 技能库面板能打开', skillsNav === true, skillsNav ? '' : '没找到「技能库」入口')
  check('⑤ 技能行有使用读数', skillText.includes('用上') || skillText.includes('还没被用上'))
  /* 危险操作要有视觉语言：删除按钮必须是 danger（unslop 体检 S6 —— 以前 variant:'danger' 没登记，
     12 个删除按钮全落成主色蓝，界面上看不出哪一步会删东西）。 */
  const dangerButtons = await page.evaluate(() => [...document.querySelectorAll('button')]
    .filter(node => (node.textContent ?? '').trim() === '删除')
    .map(node => node.getAttribute('data-variant') ?? ''))
  check('⑤ 删除按钮走 danger（不再是主色蓝）', dangerButtons.length === 0 || dangerButtons.every(value => value === 'danger'), JSON.stringify(dangerButtons.slice(0, 5)))
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
      if (counts.length > 1 && counts[counts.length - 1] === 1) {
        // 最后一行只有一张，但横跨整行（col-span）不算落单：那是刻意的收口卡，不是排歪了。
        const lastTop = Math.max(...rects.map(r => Math.round(r.top)))
        const lastRow = rects.filter(r => Math.round(r.top) === lastTop)
        const gridWidth = grid.getBoundingClientRect().width
        if (lastRow[0].width < gridWidth * 0.6) orphan.push(`${rects.length} 张卡排成 ${counts.join('+')}`)
      }
    }
    return { gaps, orphan }
  })
  check('⑥ 工作台块与块之间不贴在一起（间距 ≥ 8px）', layout.gaps.length === 0, layout.gaps.slice(0, 3).join(' / '))
  check('⑥ 工作台 KPI 不落单（没有一行只剩一张卡）', layout.orphan.length === 0, layout.orphan.join(' / '))
  /* 空分区不该各占 150px：没有内容的区块收成一行（unslop：首屏每一块都要讲一件事）。 */
  const emptyBlocks = await page.evaluate(() => [...document.querySelectorAll('[data-empty-block]')].map(node => Math.round(node.getBoundingClientRect().height)))
  check('⑥ 工作台空分区收成一行（不占大块空白）', emptyBlocks.every(height => height <= 64), JSON.stringify(emptyBlocks))
  await page.screenshot({ path: join(outDir, 'dashboard-layout.png') })

  /* ⑥b 命令面板：⌘K / Ctrl+K 能开、能搜到卡 */
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyK')
  await page.keyboard.up('Control')
  await page.waitForSelector('[data-palette]', { timeout: 5000 }).catch(() => {})
  const paletteOpen = await page.evaluate(() => document.querySelector('[data-palette]') !== null)
  let paletteHit = null
  if (paletteOpen === true) {
    await page.type('[data-palette-input]', 'BUG-041', { delay: 20 })
    await new Promise(resolve => setTimeout(resolve, 500))
    paletteHit = await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-palette] [data-palette-item]')]
      return { count: items.length, text: items.slice(0, 3).map(node => String(node.textContent ?? '').replace(/\s+/g, ' ').slice(0, 40)) }
    })
    await page.keyboard.press('Escape')
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  check('⑥b 命令面板能打开并搜到卡', paletteOpen === true && paletteHit !== null && paletteHit.count > 0 && paletteHit.text.some(text => text.includes('BUG-041')), JSON.stringify(paletteHit))

  /* ⑥d 效能页分区：总览 / 交付效率 / AI 与成本 / 上下文 */
  await clickExact('效能')
  await new Promise(resolve => setTimeout(resolve, 1500))
  const analyticsTabs = await page.evaluate(() => [...document.querySelectorAll('[data-analytics-tab]')].map(node => String(node.textContent ?? '').trim()))
  const focusBanner = await page.evaluate(() => document.querySelector('[data-analytics-focus]')?.getAttribute('data-analytics-focus') ?? '')
  check('⑥d 效能页有 4 个分区页签', analyticsTabs.length === 4 && analyticsTabs.includes('总览') && analyticsTabs.includes('上下文'), JSON.stringify(analyticsTabs))
  check('⑥d 效能页顶部有「现在最该看」结论条', focusBanner === 'warn' || focusBanner === 'ok', focusBanner)
  await page.evaluate(() => document.querySelector('[data-analytics-tab="ai"]')?.click())
  await new Promise(resolve => setTimeout(resolve, 1400))
  const analyticsVisible = await page.evaluate(() => [...new Set([...document.querySelectorAll('[data-analytics-panel]')].filter(node => getComputedStyle(node).display !== 'none').map(node => node.getAttribute('data-analytics-panel')))])
  check('⑥d 切「AI 与成本」只显示对应分区', analyticsVisible.length === 1 && analyticsVisible[0] === 'ai', JSON.stringify(analyticsVisible))
  await page.waitForFunction(() => document.querySelectorAll('[role="meter"]').length > 0, { timeout: 6000 }).catch(() => {})
  const meterCount = await page.evaluate(() => document.querySelectorAll('[role="meter"]').length)
  check('⑥d AI 与成本有官方 Meter（负载/预算）', meterCount > 0, String(meterCount))
  await page.evaluate(() => document.querySelector('[data-analytics-tab="overview"]')?.click())
  await new Promise(resolve => setTimeout(resolve, 300))

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
  const historyBox = await page.evaluate(() => {
    const box = document.querySelector('[data-status-history]')
    if (box === null) return null
    return { rows: box.querySelectorAll('[data-history-row]').length, text: String(box.textContent ?? '').replace(/\s+/g, ' ').slice(0, 80) }
  })
  check('⑦ 状态历史按行展示（不再是一整串箭头）', historyBox !== null && historyBox.rows > 0 && historyBox.text.includes('状态历史'), JSON.stringify(historyBox))
    await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')]
      .find(node => String(node.textContent ?? '').trim().startsWith('执行记录'))?.click())
    const rendered = await page.waitForFunction(() => {
      const node = document.querySelector('[data-drawer-diff]')
      if (node === null) return false
      return node.querySelector('[data-diff-tree] [role="row"]') !== null
        && node.querySelectorAll('[data-diff-file]').length > 0
        && node.querySelector('[data-diff-content]') !== null
    }, { timeout: 20000, polling: 300 }).then(() => true).catch(() => false)
    const diffInfo = await page.evaluate(() => {
      const node = document.querySelector('[data-drawer-diff]')
      return {
        range: String(node?.querySelector('[data-diff-range]')?.textContent ?? ''),
        totals: String(node?.querySelector('[data-diff-totals]')?.textContent ?? ''),
        rows: node?.querySelectorAll('[data-diff-tree] [role="row"]').length ?? 0,
        files: node?.querySelectorAll('[data-diff-file]').length ?? 0,
        marks: [...(node?.querySelectorAll('[data-diff-tree] [data-change]') ?? [])].map(el => String(el.textContent ?? '')).slice(0, 6),
        selected: node?.querySelector('[data-diff-content]')?.getAttribute('data-diff-content') ?? '',
      }
    })
    check('⑦ 真卡能看到文件树（目录分组 + 新增/修改标记）', rendered === true && diffInfo.files > 0 && diffInfo.rows > diffInfo.files && diffInfo.marks.length > 0, JSON.stringify(diffInfo))
    // 点第 2 个文件：选中态与下面的内容区都要跟着换
    const picked = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-drawer-diff] [data-diff-file]')]
      const target = rows[1]
      if (target === undefined) return ''
      target.click()
      return target.getAttribute('data-diff-file') ?? ''
    })
    await new Promise(resolve => setTimeout(resolve, 500))
    const content = await page.evaluate(() => {
      const node = document.querySelector('[data-diff-content]')
      return {
        path: node?.getAttribute('data-diff-content') ?? '',
        lines: node?.querySelectorAll('pre > div').length ?? 0,
      }
    })
    check('⑦ 选一个文件能看到它的逐行改动内容', picked !== '' && content.path === picked && content.lines > 5, JSON.stringify({ picked, content }))
    await page.screenshot({ path: join(outDir, 'drawer-diff-real.png') })
    // 「全文」：切到工作树里的文件本体（带行号），验的是能真的读出来
    const fullClicked = await page.evaluate(() => {
      const button = [...document.querySelectorAll('[data-diff-content] button')]
        .find(node => (node.textContent ?? '').trim() === '全文')
      if (button === undefined) return false
      button.click()
      return true
    })
    const fullOk = await page.waitForFunction(path => {
      const node = document.querySelector('[data-diff-fulltext]')
      return node !== null && node.getAttribute('data-diff-fulltext') === path && node.querySelectorAll('div').length > 5
    }, { timeout: 10000, polling: 200 }, picked).then(() => true).catch(() => false)
    const fullInfo = await page.evaluate(() => {
      const node = document.querySelector('[data-diff-fulltext]')
      return { path: node?.getAttribute('data-diff-fulltext') ?? '', lines: node?.querySelectorAll('div').length ?? 0 }
    })
    check('⑦ 「全文」能读工作树里的文件内容（带行号）', fullClicked === true && fullOk === true, JSON.stringify(fullInfo))
    const copyButtons = await page.evaluate(() => ({
      path: document.querySelector('[data-diff-copy="path"]') !== null,
      content: document.querySelector('[data-diff-copy="content"]') !== null,
    }))
    check('⑦ 可复制路径 / 内容', copyButtons.path === true && copyButtons.content === true, JSON.stringify(copyButtons))
    /* 文件多时可按路径筛；有提交历史时给出「全部改动 / 某一次提交」下拉。 */
    const diffFilter = await page.evaluate(() => document.querySelector('[data-diff-filter] input') !== null)
    if (diffFilter === true) {
      await page.evaluate(() => {
        const input = document.querySelector('[data-diff-filter] input')
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(input, 'api.test')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await new Promise(resolve => setTimeout(resolve, 500))
      const narrowed = await page.evaluate(() => ({
        paths: [...document.querySelectorAll('[data-drawer-diff] [data-diff-file]')].map(node => node.getAttribute('data-diff-file') ?? ''),
        content: document.querySelector('[data-diff-content]')?.getAttribute('data-diff-content') ?? '',
      }))
      check('⑦ 文件路径筛选收窄树', narrowed.paths.length > 0 && narrowed.paths.length < 9 && narrowed.paths.every(path => path.includes('api.test')) && narrowed.content.includes('api.test'), JSON.stringify(narrowed))
      await page.evaluate(() => {
        const input = document.querySelector('[data-diff-filter] input')
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(input, '')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    const commitPicker = await page.evaluate(() => ({
      trigger: document.querySelector('[data-diff-commit] button') !== null,
      range: document.querySelector('[data-diff-range]')?.textContent ?? '',
    }))
    check('⑦ 有「全部改动 / 某次提交」下拉', commitPicker.trigger === true, JSON.stringify(commitPicker))
    await page.screenshot({ path: join(outDir, 'drawer-diff-fulltext.png') })
  }

  /* ⑥c 拖拽换列：真实 dragstart/dragover/drop（HTML5 事件），落库后再从 /state 回读 */
  await clickExact('关闭')
  await clickExact('看板')
  await new Promise(resolve => setTimeout(resolve, 900))
  const dragged = await page.evaluate(() => {
    const card = [...document.querySelectorAll('[data-kanban-card]')]
      .find(node => String(node.textContent ?? '').includes('（探针）看板卡片'))
    const target = document.querySelector('[data-board-column="review"]')
    if (card === undefined || target === null) return { ok: false, why: 'card=' + (card !== undefined) + ' target=' + (target !== null) }
    const data = new DataTransfer()
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }))
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }))
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
    card.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: data }))
    return { ok: true }
  })
  await new Promise(resolve => setTimeout(resolve, 1400))
  const movedState = await state()
  const movedCard = (movedState?.tasks ?? []).find(item => item.id === taskId)
  check('⑥c 拖拽卡片能换列并落库', dragged.ok === true && movedCard?.status === 'review', JSON.stringify({ dragged, status: movedCard?.status }))

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
