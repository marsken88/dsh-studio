#!/usr/bin/env node
/* 三层测试的端到端自验：真宿主（apply(ctx) + 真路由 + 真 SQLite）+ 真 client.js + 真 Chrome。
 *
 * 不碰用户数据：DSH_HOME 指到临时目录，跑完删掉。
 * 验的是：
 *   1. /state 的 caseTiers、/task/parts 的 plan/tierEffective、卡片正面的缺层提示
 *   2. 抽屉「测试」页的三层进度块、跑这层、不适用/恢复适用
 *   3. /task/test-plan 路由：空理由要 400，合法声明后缺口消失
 *   4. 全程 pageerror 为空
 *
 *   npm run verify:tiers        （= node tools/visual/tiers-probe.mjs）
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const require = createRequire(import.meta.url)

const home = mkdtempSync(join(tmpdir(), 'studio-tiers-'))
process.env.DSH_HOME = home

const { apply } = await import(new URL('../../index.js', import.meta.url).href)

// ---------------------------------------------------------------- fake host ctx
const registeredTools = []
const disposers = []
let apiHandler = null
const noop = () => {}
const fakeCtx = {
  effect (fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  },
  inject (names, callback) {
    if (names.includes('webServer')) {
      callback({
        webServer: {
          register (options) {
            apiHandler = options.handler
            return () => { apiHandler = null }
          },
        },
      })
      return () => {}
    }
    callback({
      agents: { create: async () => ({}), list: () => [] },
      sessionController: { on: noop },
      workspaceRegistry: {},
      permissionPresets: {},
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash' }) },
      sessionProjections: {},
      on: () => noop,
    })
    return () => {}
  },
  systemPrompt: { section: () => () => {} },
  tools: {
    register (tool) {
      registeredTools.push(tool)
      return () => {}
    },
  },
}
apply(fakeCtx)
if (typeof apiHandler !== 'function') throw new Error('host did not register /studio-api')

const tool = name => {
  const found = registeredTools.find(item => item.name === name)
  if (found === undefined) throw new Error(`no tool ${name}`)
  return found
}
const callTool = async (name, args) => tool(name).execute(args, {})

// ---------------------------------------------------------------- harness server
const html = `<!doctype html><html><head><meta charset="utf-8"><title>tiers harness</title></head>
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
  if (url.pathname.startsWith('/studio-api/')) {
    try {
      await apiHandler(req, res)
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
    }
    return
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, from: 'harness' }))
    return
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
    return
  }
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

const post = async (path, body) => {
  const res = await fetch(base + '/studio-api' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}
const getState = async () => {
  const res = await fetch(base + '/studio-api/state')
  const json = await res.json().catch(() => null)
  if (json?.state === undefined) throw new Error(`state 取不到：status=${res.status} body=${JSON.stringify(json).slice(0, 300)}`)
  return json.state
}

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: ok === true })
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail === '' ? '' : ' — ' + detail))
}

try {
  // ------------------------------------------------------------ seed through the real tool layer
  const reqResult = await callTool('studio_requirement_save', {
    title: '（自检）三层测试端到端',
    description: '验单元 / 集成 / 端到端三条线的进度与门禁',
    status: 'active',
    points: [
      { id: 'p1', title: '登录锁定', acceptance: [{ id: 'a1', text: '第 5 次失败返回 429' }] },
    ],
    discovery: { server: '有服务端', auth: '已有登录', boundary: '后端接口' },
  })
  const seededReq = (await getState()).requirements.find(item => item.title === '（自检）三层测试端到端')
  const requirementId = seededReq?.id
  check('建需求成功', typeof requirementId === 'string' && requirementId !== '', String(requirementId ?? reqResult).slice(0, 60))

  const created = await callTool('studio_task_create', {
    title: '（自检）登录锁定测试卡',
    type: 'dev',
    role: 'dev',
    status: 'test',
    priority: 'normal',
    requirementId,
    pointId: 'p1',
    requirement: '验登录失败锁定：接口、单测命令、浏览器三层',
  })
  const seededTask = (await getState()).tasks.find(item => item.title === '（自检）登录锁定测试卡')
  const taskId = seededTask?.id
  check('建卡成功', typeof taskId === 'string' && taskId !== '', String(taskId ?? created).slice(0, 60))

  // 测试执行配置：开 shell / db / 浏览器，配一个指向 harness 的环境
  const configured = await post('/config', {
    testing: { envs: [{ id: 'self', name: '自检环境', baseUrl: base }], defaultEnv: 'self', allowShell: true, allowDb: true, allowBrowser: true, allowHosts: ['127.0.0.1', 'localhost'], timeoutMs: 8000, concurrency: 2, shellCwd: REPO },
  })
  check('测试执行配置写入成功', configured.status === 200 && configured.json?.ok === true, String(configured.json?.error ?? ''))

  // 先只加一条集成用例：此时单元 / 端到端都应该是缺口
  const added = await callTool('studio_task_add_cases', {
    id: taskId,
    by: '测试工程师',
    cases: [
      { title: '接口健康检查', method: 'GET', path: base + '/health', expectStatus: 200, expectContains: 'harness', tier: 'integration' },
    ],
  })
  check('加集成用例并当场试跑通过', /试跑通过/.test(String(added)), String(added).split('\n')[1] ?? '')

  // ------------------------------------------------------------ host-level API assertions
  const stateWithGap = await getState()
  const cardWithGap = (stateWithGap.tasks ?? []).find(item => item.id === taskId)
  check('/state 带 caseTiers（对象，不是数组）', cardWithGap !== undefined && cardWithGap.caseTiers !== undefined && Array.isArray(cardWithGap.caseTiers) === false)
  check('/state 分层计数正确', cardWithGap?.caseTiers?.unit?.total === 0 && cardWithGap?.caseTiers?.integration?.total === 1 && cardWithGap?.caseTiers?.e2e?.total === 0, JSON.stringify(cardWithGap?.caseTiers ?? {}))

  const partsWithGap = (await post('/task/parts', { id: taskId })).json
  check('/task/parts 给出分层计划与缺口', partsWithGap?.plan?.gaps?.length === 2, JSON.stringify((partsWithGap?.plan?.gaps ?? []).map(gap => gap.tier)))
  check('/task/parts 的用例带 tierEffective', partsWithGap?.cases?.[0]?.tierEffective === 'integration', String(partsWithGap?.cases?.[0]?.tierEffective ?? ''))

  const badPlan = await post('/task/test-plan', { id: taskId, tiers: [{ tier: 'e2e', applicable: false, reason: '' }] })
  check('/task/test-plan 空理由要 400', badPlan.status === 400 && /必须写理由/.test(String(badPlan.json?.error ?? '')), String(badPlan.json?.error ?? ''))

  // ------------------------------------------------------------ UI assertions
  let puppeteer
  try {
    puppeteer = require('puppeteer-core')
  } catch {
    console.error('需要 puppeteer-core：pnpm add -D puppeteer-core')
    process.exit(2)
  }
  const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  let browser
  try {
    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1600, height: 1000 } })
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(String(error?.stack ?? error).slice(0, 1200)))
    // 单文件产物没有 UIKIT：prompt/confirm 会退回原生弹窗，这里给确定答案。
    await page.evaluateOnNewDocument(() => {
      window.__PROMPT_ANSWER__ = '本次只改后端接口，没有前端改动'
      window.prompt = () => window.__PROMPT_ANSWER__
      window.confirm = () => true
    })
    await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForSelector('[data-dsh-studio]', { timeout: 45000 })
    await sleep(1200)

    const clickText = async (selector, text) => page.evaluate((sel, want) => {
      const node = [...document.querySelectorAll(sel)].find(item => (item.textContent || '').trim().includes(want))
      if (!node) return false
      node.click()
      return true
    }, selector, text)

    /* 单文件产物里 confirm/prompt 走 bundle 内的 DialogBox（role=dialog）：
       真键盘输入（React 的受控输入只认真实事件），再点「确定」。 */
    const answerDialog = async value => {
      const handle = await page.evaluateHandle(() => {
        const dialogs = [...document.querySelectorAll('[role="dialog"]')]
        const dialog = dialogs.reverse().find(node => node.querySelector('textarea') !== null)
        return dialog?.querySelector('textarea') ?? null
      })
      const field = handle.asElement()
      if (field === null) return false
      await field.click()
      await page.keyboard.type(value, { delay: 5 })
      return page.evaluate(() => {
        const dialogs = [...document.querySelectorAll('[role="dialog"]')]
        const dialog = dialogs.reverse().find(node => node.querySelector('textarea') !== null)
        const buttons = [...(dialog?.querySelectorAll('button') ?? [])]
        const ok = buttons.find(node => (node.textContent || '').trim() === '确定')
        if (!ok) return false
        ok.click()
        return true
      })
    }

    // 面板默认落在「工作台」，先切到看板
    check('切到看板', await clickText('[data-head-tabs] button', '看板'))
    await sleep(900)
    if (await page.evaluate(() => document.querySelector('[data-kanban-card]') === null)) {
      console.error('看板没有卡片；页面文本：' + (await page.evaluate(() => (document.body.innerText ?? '').slice(0, 600))).replace(/\s+/g, ' '))
      await page.screenshot({ path: join(REPO, 'tmp', 'tiers-harness-no-card.png') })
    }

    check('卡片正面出现缺层提示（unit,e2e）', await page.evaluate(() => document.querySelector('[data-tier-gap]')?.getAttribute('data-tier-gap') === 'unit,e2e'),
      await page.evaluate(() => document.querySelector('[data-tier-gap]')?.getAttribute('data-tier-gap') ?? 'none'))

    check('点开卡片', await clickText('[data-kanban-card]', '登录锁定测试卡'))
    await page.waitForSelector('[data-drawer]', { timeout: 15000 })
    await sleep(600)
    const chain = await page.evaluate(() => ({
      block: document.querySelector('[data-role-chain]') !== null,
      rows: [...document.querySelectorAll('[data-role-row]')].map(row => ({
        key: row.getAttribute('data-role-row'),
        state: row.getAttribute('data-role-state'),
      })),
    }))
    check('抽屉概览有协作链（产品/架构/研发/测试四行）', chain.block === true && chain.rows.map(row => row.key).join(',') === 'product,architect,dev,qa', chain.rows.map(row => `${row.key}:${row.state}`).join(' '))
    await page.evaluate(() => document.querySelector('[data-drawer-tab="test"]')?.click())
    await sleep(900)
    await page.waitForSelector('[data-test-plan]', { timeout: 15000 })

    const shape = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-tier-row]')].map(row => ({
        tier: row.getAttribute('data-tier-row'),
        state: row.getAttribute('data-tier-state'),
        text: (row.textContent || '').trim(),
      }))
      return {
        block: document.querySelector('[data-test-plan]') !== null,
        rows,
        gap: document.querySelector('[data-drawer] [data-test-gap]')?.getAttribute('data-test-gap') ?? '',
      }
    })
    check('抽屉「测试」页有三层进度块', shape.block === true)
    check('三层各有一行且顺序固定', shape.rows.map(row => row.tier).join(',') === 'unit,integration,e2e', shape.rows.map(row => row.tier).join(','))
    check('单元/端到端标成缺口，集成已覆盖', shape.rows[0].state === 'missing' && shape.rows[2].state === 'missing' && shape.rows[1].state === 'ok', shape.rows.map(row => `${row.tier}:${row.state}`).join(' '))
    check('进度块顶部提示缺 单元/端到端', shape.gap === 'unit,e2e', shape.gap)

    // 单元这一层：点「不适用」→ 原生 prompt 给理由 → 变成 excluded
    const clickedExclude = await page.evaluate(() => {
      const row = document.querySelector('[data-tier-row="unit"]')
      const button = [...(row?.querySelectorAll('button') ?? [])].find(node => (node.textContent || '').includes('不适用'))
      if (!button) return false
      window.__CLICK_DEBUG__ = { disabled: button.disabled === true, text: (button.textContent || '').trim() }
      button.click()
      return true
    })
    check('单元这一行有「不适用」按钮', clickedExclude === true)
    await sleep(600)
    check('点「不适用」弹出理由输入框并提交', await answerDialog('本次只改后端接口，没有前端改动'))
    await sleep(2000)
    const afterExclude = await page.evaluate(() => {
      const row = document.querySelector('[data-tier-row="unit"]')
      return {
        state: row?.getAttribute('data-tier-state') ?? '',
        text: (row?.textContent ?? '').trim(),
        gap: document.querySelector('[data-drawer] [data-test-gap]')?.getAttribute('data-test-gap') ?? '',
      }
    })
    check('声明不适用后该层变成 excluded 且带理由', afterExclude.state === 'excluded' && afterExclude.text.includes('本次只改后端接口'), afterExclude.text.slice(0, 80))
    check('缺口只剩端到端', afterExclude.gap === 'e2e', afterExclude.gap)

    // 恢复适用
    const clickedRestore = await page.evaluate(() => {
      const row = document.querySelector('[data-tier-row="unit"]')
      const button = [...(row?.querySelectorAll('button') ?? [])].find(node => (node.textContent || '').includes('恢复适用'))
      if (!button) return false
      button.click()
      return true
    })
    check('有「恢复适用」按钮', clickedRestore === true)
    await sleep(1500)

    // 服务端补上单元 / 端到端用例（模拟测试专家用 studio_task_add_cases）
    await callTool('studio_task_add_cases', {
      id: taskId,
      by: '测试工程师',
      cases: [
        { title: '单测：登录锁定', command: 'node --test tests/test-plan.test.mjs', expectExit: 0, tier: 'unit' },
        { title: '端到端：看板能打开', browser: { path: '/', expectText: '需求' }, tier: 'e2e' },
      ],
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-dsh-studio]', { timeout: 45000 })
    await sleep(1200)
    check('三层补齐后卡片正面不再提示缺层', await page.evaluate(() => document.querySelector('[data-tier-gap]') === null))

    check('切回看板', await clickText('[data-head-tabs] button', '看板'))
    await sleep(900)
    check('重新点开卡片', await clickText('[data-kanban-card]', '登录锁定测试卡'))
    await page.waitForSelector('[data-drawer]', { timeout: 15000 })
    await page.evaluate(() => document.querySelector('[data-drawer-tab="test"]')?.click())
    await sleep(900)
    const filled = await page.evaluate(() => ({
      states: [...document.querySelectorAll('[data-tier-row]')].map(row => row.getAttribute('data-tier-state')).join(','),
      gap: document.querySelector('[data-drawer] [data-test-gap]')?.getAttribute('data-test-gap') ?? '',
      rows: document.querySelectorAll('[data-tier-row]').length,
    }))
    check('三层都有可执行用例后全部 ok', filled.states === 'ok,ok,ok', filled.states)
    check('进度块显示三条线齐全', filled.gap === '0', filled.gap)

    // 「跑这层」：集成层真打 /health
    const clickedRun = await page.evaluate(() => {
      const row = document.querySelector('[data-tier-row="integration"]')
      const button = [...(row?.querySelectorAll('button') ?? [])].find(node => (node.textContent || '').includes('跑这层'))
      if (!button) return false
      button.click()
      return true
    })
    check('集成这一行有「跑这层」按钮', clickedRun === true)
    await sleep(3000)
    const runNote = await page.evaluate(() => document.querySelector('[data-drawer]')?.textContent ?? '')
    check('跑这层有执行结果回显', /跑了 1 条：通过 1/.test(runNote), (runNote.match(/跑了 \d+ 条[^，]*[^\n]{0,20}/) ?? [''])[0])
    check('无 pageerror', errors.length === 0, errors.join(' | '))
    await page.screenshot({ path: join(REPO, 'tmp', 'tiers-harness.png'), fullPage: false })
  } finally {
    await browser?.close?.()
  }

  // 服务端最终状态：三条线都有可执行用例，门禁不再报缺层
  const finalParts = (await post('/task/parts', { id: taskId })).json
  check('最终计划无缺口', (finalParts?.plan?.gaps ?? []).length === 0, JSON.stringify(finalParts?.plan?.gaps ?? []))
  const finalState = await getState()
  const finalCard = (finalState.tasks ?? []).find(item => item.id === taskId)
  check('最终 caseTiers 三层都有可执行用例', ['unit', 'integration', 'e2e'].every(tier => (finalCard?.caseTiers?.[tier]?.executable ?? 0) > 0), JSON.stringify(finalCard?.caseTiers ?? {}))
} catch (error) {
  console.error('自验中断：' + (error?.stack ?? error?.message ?? error))
  checks.push({ name: '运行', ok: false })
} finally {
  await new Promise(resolve => server.close(resolve))
  try { rmSync(home, { recursive: true, force: true }) } catch { /* 临时目录，删不掉不影响结论 */ }
}

const failed = checks.filter(item => item.ok !== true)
console.log('')
console.log((failed.length === 0 ? '全部通过' : failed.length + ' 项失败') + '（' + checks.length + ' 项）')
process.exit(failed.length === 0 ? 0 : 1)
