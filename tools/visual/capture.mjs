#!/usr/bin/env node
/**
 * README 截图生成器（npm run shots）：造一套**演示数据**，用真实 client.js 渲染面板，逐页截图到 docs/images/。
 *
 * 需要 STUDIO_TOKEN（dsh web 的启动 token）：`/studio-api` 过宿主信任栅栏，没有已认证的浏览器会话
 * 一律 401，脚本得先换一次 cookie。面板本身只依赖 /studio-api，这里用最小假宿主把它挂起来，
 * 再把 /studio-api/* 反代到正在跑的实例（所以图里是真实渲染 + 真实的交互状态）。
 *
 *   npm run shots -- --base http://127.0.0.1:<dsh 端口>
 *
 * 为什么要脚本而不是手工截：README 是用户第一眼看到的东西，界面一改截图就过期
 * （2026-11-20 那批截图停在 11-18，中间左栏、闸门、BoardUI 全变了）。
 * 现在重跑一次就能全部刷新，尺寸/主题/演示数据都一致。
 *
 * 演示数据一律带「演示」前缀，跑完删干净（含云盘目录）。
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchTokenFromEnv, studioFetch } from '../lib/studio-auth.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const base = argOf('base', process.env.STUDIO_BASE ?? '')
if (base === '') {
  console.error('用法：npm run shots -- --base http://127.0.0.1:<dsh 端口>')
  process.exit(2)
}
/* `/studio-api` 过宿主信任栅栏：没有已认证的浏览器会话的请求一律 401。脚本没有浏览器，
   用 dsh web 的启动 token 换 cookie —— api() 与假宿主代理层共用这一份会话（见 tools/lib/studio-auth.mjs）。 */
const authedFetch = studioFetch(base, launchTokenFromEnv())
const OUT = join(repo, 'docs', 'images')
mkdirSync(OUT, { recursive: true })

const require = createRequire(import.meta.url)
let puppeteer
try { puppeteer = require('puppeteer-core') } catch { console.log('跳过：没装 puppeteer-core'); process.exit(0) }
const CHROME = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome'].filter(Boolean).find(p => existsSync(p))
if (CHROME === undefined) { console.log('跳过：找不到 Chrome/Edge'); process.exit(0) }

const api = async (path, body) => {
  const res = await authedFetch('/studio-api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

// ---------------------------------------------------------------- 假宿主（静态 + 反代）
const HARNESS_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>shots</title>
<style>html,body,#root{height:100%;margin:0}body{font-family:system-ui,"Microsoft YaHei",sans-serif}</style></head>
<body><div id="root"></div><pre id="boot-error" style="color:#b91c1c;font:13px monospace"></pre>
<script src="/react.js"></script><script src="/react-dom.js"></script>
<script>window.__ModuleLoader__ = { load(config) { window.__studioFactory = config.factory } }</script>
<script src="/client.js"></script>
<script>
  try {
    const React = window.React, ReactDOM = window.ReactDOM
    const mod = window.__studioFactory(n => { if (n === 'react') return React; throw new Error(n) })
    const captured = {}
    const ctx = { slots: { inject: (n, fn) => fn(), register: (slot, c) => { captured[(slot.name ?? '')] = c; return () => {} } }, effect: fn => (typeof fn === 'function' ? fn() : () => {}) }
    if (typeof mod.apply === 'function') mod.apply(ctx)
    if (captured.main === undefined) throw new Error('没有拿到 main 槽')
    window.__pageMounted = true
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(captured.main, {}))
  } catch (error) { window.__bootFailed = String(error && error.message ? error.message : error) }
</script></body></html>`

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname.startsWith('/studio-api/')) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    try {
      const upstream = await authedFetch(url.pathname + url.search, {
        method: req.method,
        headers: { 'content-type': 'application/json' },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : (chunks.length > 0 ? Buffer.concat(chunks) : undefined),
      })
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
      res.end(await upstream.text())
    } catch (error) { res.writeHead(502); res.end(String(error?.message ?? error)) }
    return
  }
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HARNESS_HTML); return }
  const files = {
    '/client.js': join(repo, 'client.js'),
    '/react.js': join(repo, 'web/node_modules/react/umd/react.development.js'),
    '/react-dom.js': join(repo, 'web/node_modules/react-dom/umd/react-dom.development.js'),
  }
  const file = files[url.pathname]
  if (file === undefined || !existsSync(file)) { res.writeHead(404); res.end('not found'); return }
  res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
  res.end(readFileSync(file))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

// ---------------------------------------------------------------- 演示数据
const made = { cards: [], requirements: [], release: '', project: '' }
const seed = async () => {
  const project = await api('/projects/save', { project: { name: '演示·订单中心', key: 'ORD', description: '演示数据：下单、支付与库存', baseBranch: 'main' } })
  made.project = project.json.project?.id ?? ''
  const requirement = await api('/requirement/save', {
    requirement: {
      title: '演示·积分抵扣',
      description: '下单时用积分抵扣金额：**每 100 积分抵 1 元**，最多抵订单金额的 30%。',
      project: made.project,
      priority: 'normal',
      discovery: { server: '有', auth: '服务端', boundary: '包含前端与测试' },
      points: [
        { id: 'p1', title: '抵扣计算', acceptance: [{ id: 'a1', text: '100 积分抵 1 元' }, { id: 'a2', text: '最多抵 30%' }] },
        { id: 'p2', title: '失败回滚', acceptance: [{ id: 'a3', text: '支付失败积分退回' }] },
      ],
    },
  })
  const requirementId = requirement.json.requirement?.id ?? ''
  made.requirements.push(requirementId)
  const second = await api('/requirement/save', {
    requirement: { title: '演示·退款流水', description: '退款单与流水对账。', project: made.project, discovery: { server: '有', auth: '服务端', boundary: '后端' } },
  })
  made.requirements.push(second.json.requirement?.id ?? '')
  await api('/requirement/review', { id: requirementId, decision: 'approve', by: '演示·产品经理', note: '范围清楚，可以拆卡' })

  const make = async (spec) => {
    const out = await api('/task/create', { ...spec, requirementId, project: made.project })
    const id = out.json.task?.id ?? ''
    if (id !== '') made.cards.push(id)
    return id
  }
  const clarify = await make({ title: '演示·澄清抵扣规则', type: 'requirement', role: 'product', status: 'clarify', pointId: 'p1' })
  const design = await make({ title: '演示·抵扣技术方案', type: 'design', role: 'architect', status: 'design', pointId: 'p1' })
  const dev = await make({ title: '演示·实现抵扣与回滚', type: 'dev', role: 'dev', status: 'dev', pointId: 'p1', dueAt: Date.now() + 2 * 86400000 })
  const review = await make({ title: '演示·抵扣接口评审', type: 'design', role: 'architect', status: 'review', pointId: 'p2' })
  const test = await make({ title: '演示·抵扣用例验证', type: 'test', role: 'qa', status: 'test', pointId: 'p1' })
  const accept = await make({ title: '演示·抵扣上线验收', type: 'ops', role: 'product', status: 'accept', pointId: 'p1' })
  const done = await make({ title: '演示·回滚链路自测', type: 'test', role: 'qa', status: 'done', pointId: 'p2' })
  void clarify

  // 设计：两稿 + 定案
  await api('/task/design', { id: design, status: 'approved', drafts: [{ id: 'd1', name: '方案 A：下单时算', link: 'https://example.com/a', note: '改动小，但支付失败要补回滚' }, { id: 'd2', name: '方案 B：支付后算', link: 'https://example.com/b', note: '不用回滚，但要多一次查询' }], chosenId: 'd2', by: '演示·架构师', note: '选 B，少一条失败路径' })
  // 研发：执行记录 + 交付物
  await api('/task/coding', { id: dev, action: 'update', agent: '演示·研发工程师', branch: 'feat/points-deduct', files: [{ path: 'src/points.js', change: 'added' }, { path: 'src/order.js', change: 'modified' }], commits: [{ sha: 'a1b2c3d', message: 'feat: 积分抵扣' }], testsTotal: 6, testsPassed: 6 })
  await api('/task/coding', { id: dev, action: 'review', status: 'approved', by: '演示·架构师', reviewNote: '接口有幂等，可以' })
  await api('/task/artifact', { id: dev, action: 'add', artifact: { kind: 'requirement', title: '演示·需求说明', content: '## 目标\n\n下单可用积分抵扣，最多抵 30%。\n\n## 不做\n\n不做跨订单合并抵扣。', status: 'delivered' }, by: '演示·产品经理' })
  await api('/task/artifact', { id: design, action: 'add', artifact: { kind: 'design', title: '演示·技术方案', content: '## 方案\n\n支付成功后按实付金额计算抵扣，失败无需回滚。', status: 'delivered' }, by: '演示·架构师' })
  await api('/task/artifact', { id: test, action: 'add', artifact: { kind: 'report', title: '演示·测试报告', content: '## 结论\n\n6/6 通过，边界（30% 上限、余额不足）已覆盖。', status: 'delivered' }, by: '演示·测试工程师' })
  // 用例：两条可执行（一条已通过）+ 一条草稿
  await api('/task/case', { id: test, action: 'add', cases: [
    { title: '演示·100 积分抵 1 元', expected: '返回抵扣 1 元', http: { method: 'POST', url: 'https://example.com/api/deduct', expectStatus: 200 }, result: 'pass', pointId: 'p1', acceptanceId: 'a1' },
    { title: '演示·超过 30% 被截断', expected: '抵扣不超过订单 30%', http: { method: 'POST', url: 'https://example.com/api/deduct', expectStatus: 200 }, result: 'pass', pointId: 'p1', acceptanceId: 'a2' },
    { title: '演示·支付失败积分退回', expected: '积分退回原余额', result: 'pending', pointId: 'p2', acceptanceId: 'a3' },
  ], by: '演示·测试工程师' })
  await api('/task/comment', { id: test, body: '@演示·研发工程师 30% 上限那条用例我按金额口径验了，没问题。', author: '演示·测试工程师', kind: 'agent' })
  // 验收清单 + 完成卡签字
  await api('/task/checklist', { id: done, action: 'add', text: '演示·自测通过' })
  const release = await api('/release/save', { release: { version: 'v9.9.9', name: '演示·积分抵扣首发', project: made.project, owner: '演示·产品经理', status: 'candidate' } })
  made.release = release.json.release?.id ?? ''
  void review
  void accept
}

const cleanup = async () => {
  for (const id of made.cards) await api('/task/delete', { id, confirm: 'DELETE' }).catch(() => {})
  for (const id of made.requirements) await api('/requirement/delete', { id, confirm: 'DELETE', deleteFolder: true }).catch(() => {})
  if (made.release !== '') await api('/release/delete', { id: made.release, confirm: 'DELETE' }).catch(() => {})
  if (made.project !== '') await api('/projects/delete', { id: made.project, confirm: 'DELETE' }).catch(() => {})
}

// ---------------------------------------------------------------- 截图
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
const shots = []
try {
  await seed()
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', error => errors.push(String(error?.message ?? error)))
  page.on('console', message => { const text = message.text(); if (message.type() === 'error' && !/favicon|404 (Not Found)/.test(text)) errors.push('console: ' + text.slice(0, 200)) })

  const harnessUrl = `http://127.0.0.1:${server.address().port}`
  await page.goto(harnessUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__pageMounted === true || window.__bootFailed !== undefined, { timeout: 20000 })
  await new Promise(resolve => setTimeout(resolve, 1500))

  const clickBy = async (label, { prefix = false } = {}) => {
    const hit = await page.evaluate((target, usePrefix) => {
      const nodes = [...document.querySelectorAll('button, [role="tab"], [role="tab"] span')]
      const norm = item => String(item.textContent ?? '').replace(/\s+/g, ' ').trim()
      const node = nodes.find(item => (usePrefix ? norm(item).startsWith(target) : norm(item) === target))
      if (node === undefined) return false
      node.click()
      return true
    }, label, prefix)
    await new Promise(resolve => setTimeout(resolve, 700))
    return hit
  }
  const clickExact = label => clickBy(label)
  const shot = async (name, { full = false } = {}) => {
    await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: full })
    shots.push(name)
    console.log('📸', name)
  }

  // 1. 工作台
  await shot('workbench')
  // 2. 看板
  await clickExact('看板')
  await shot('board')
  // 3. 卡片抽屉：点「演示·抵扣用例验证」，切到测试页签
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('[data-kanban-card]')].find(node => String(node.textContent ?? '').includes('演示·抵扣用例验证'))
    if (card !== undefined) card.click()
  })
  await new Promise(resolve => setTimeout(resolve, 900))
  await clickExact('测试')
  await shot('drawer')
  await clickExact('关闭')
  // 4. 需求（含可追溯矩阵）
  await clickExact('需求')
  await shot('requirements')
  // 5. 用例
  await clickExact('用例')
  await shot('cases')
  // 6. 效能
  await clickExact('效能')
  await shot('quality')
  // 7. 版本
  await clickExact('版本')
  await shot('releases')
  // 8-11. 设置：测试执行 / 成本预算 / 专家 / 列的负责人（两道闸门）/ 技能库
  await clickExact('设置')
  for (const [label, file] of [['测试执行', 'settings-execution'], ['成本与预算', 'settings-cost'], ['专家', 'settings-experts'], ['列的负责人', 'settings-gates'], ['技能库', 'settings-skills']]) {
    const ok = await clickBy(label, { prefix: true })
    if (ok) await shot(file)
    else console.log('（跳过，没找到设置分区）', label)
  }

  console.log(errors.length === 0 ? '页面无报错' : '页面报错：' + errors.slice(0, 3).join(' | '))
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
  await cleanup()
  console.log(`完成：${shots.length} 张，写入 docs/images/`)
}
