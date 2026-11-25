#!/usr/bin/env node
/**
 * 状态/交互审计：补 `audit:ui`（静态首屏）与 `audit:overlays`（浮层）没覆盖的四块。
 *
 *   node tools/visual/state-audit.mjs --base http://127.0.0.1:<端口> --mode empty
 *   node tools/visual/state-audit.mjs --base ... --mode locked      # 登录页
 *   node tools/visual/state-audit.mjs --base ... --mode scale       # 大数据量
 *   node tools/visual/state-audit.mjs --base ... --mode mobile      # 375 宽
 *   node tools/visual/state-audit.mjs --base ... --mode interact    # 焦点/禁用/悬停/拖拽
 *
 * 三种模式都靠**改写 /studio-api/state 的响应**实现，不往真库里写任何东西：
 *   empty  → 把 tasks/requirements/releases/projects 清空（刚装好的样子）
 *   locked → 返回 { locked: true }，面板会渲染登录页
 *   scale  → 合成 96 张卡 / 40 条需求 / 12 个版本（看密度与溢出）
 *
 * 截图写到 tmp/state-audit/，指标打到 stdout。
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchTokenFromEnv, studioFetch } from '../lib/studio-auth.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const argv = process.argv.slice(2)
const argOf = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback }
const base = argOf('base', process.env.STUDIO_BASE ?? '')
const mode = argOf('mode', 'empty')
const width = Number(argOf('width', mode === 'mobile' ? '375' : '1440'))
if (base === '') { console.error('用法：node tools/visual/state-audit.mjs --base http://127.0.0.1:<端口> --mode empty|locked|scale|mobile|interact'); process.exit(2) }
/* `/studio-api` 过宿主信任栅栏：没有已认证的浏览器会话的请求一律 401。脚本没有浏览器，
   用 dsh web 的启动 token 换 cookie —— 真状态读取与假宿主代理层共用这一份会话（见 tools/lib/studio-auth.mjs）。 */
const api = studioFetch(base, launchTokenFromEnv())

const require = createRequire(import.meta.url)
let puppeteer
try { puppeteer = require('puppeteer-core') } catch { console.log('跳过：没装 puppeteer-core'); process.exit(0) }
const CHROME = [process.env.CHROME_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].filter(Boolean).find(path => existsSync(path))
if (CHROME === undefined) { console.log('跳过：找不到 Chrome/Edge'); process.exit(0) }
const OUT = join(repo, 'tmp', 'state-audit')
mkdirSync(OUT, { recursive: true })

// ---------------------------------------------------------------- 真状态（只读）
const realJson = await api('/studio-api/state').then(res => res.json()).catch(() => null)
const real = realJson?.state ?? null
if (real === null) { console.error('拉不到 /state'); process.exit(1) }

const COLUMNS = (real.statuses ?? []).map(item => item.id)
const stamp = Date.now()
const synth = {
  tasks: Array.from({ length: 96 }, (_, index) => ({
    id: `scale-t${index}`,
    code: `DEV-${String(index + 1).padStart(3, '0')}`,
    title: `压测卡片 ${index + 1}：一段够长的标题，用来看看卡片在窄列里会不会把布局撑坏或者被截断得看不清`,
    type: ['requirement', 'dev', 'bug', 'test'][index % 4],
    status: COLUMNS[index % Math.max(1, COLUMNS.length)],
    role: ['product', 'dev', 'qa', 'architect'][index % 4],
    priority: ['normal', 'urgent', 'relaxed'][index % 3],
    checklist: Array.from({ length: index % 4 }, (_, k) => ({ id: `c${k}`, text: `清单项 ${k}`, done: k % 2 === 0 })),
    checkSummary: { done: Math.floor((index % 4) / 2), total: index % 4 },
    caseSummary: { total: index % 5, pass: index % 3, fail: index % 2 },
    artifacts: index % 3 === 0 ? [{ id: 'a1', kind: 'design', title: '交付物' }] : [],
    comments: [],
    commentCount: index % 6,
    createdAt: stamp - index * 3600_000,
    updatedAt: stamp - index * 60_000,
    blocked: index % 13 === 0 ? { reason: '等外部依赖' } : null,
    dueAt: index % 7 === 0 ? stamp + 86400_000 : 0,
    dispatch: null,
    signoff: index % 4 === 0 ? { by: '张三', at: stamp - 7200_000, note: '验过' } : null,
    history: [],
    coding: null,
    design: null,
    sla: null,
    requirementId: '',
  })),
  requirements: Array.from({ length: 40 }, (_, index) => ({
    id: `scale-r${index}`,
    code: `REQ-2026-${String(index + 1).padStart(3, '0')}`,
    title: `压测需求 ${index + 1}：一条足够长的需求标题，用来测列表项在窄屏下是否溢出`,
    status: ['draft', 'active', 'delivered'][index % 3],
    priority: 'normal',
    points: [],
    review: { status: 'approved' },
    updatedAt: stamp - index * 600_000,
    createdAt: stamp - index * 3600_000,
  })),
  releases: Array.from({ length: 12 }, (_, index) => ({
    id: `scale-rel${index}`,
    version: `v9.9.${index + 1}`,
    name: `压测版本 ${index + 1}`,
    status: 'draft',
    tasks: [],
    batches: [],
    createdAt: stamp - index * 86400_000,
    updatedAt: stamp,
  })),
}

const stateFor = () => {
  if (mode === 'locked') return { ...real, locked: true }
  if (mode === 'empty') {
    return { ...real, tasks: [], requirements: [], releases: [], projects: [], suites: [], analytics: null, metrics: null, dashboard: null, insight: null }
  }
  if (mode === 'scale') {
    return {
      ...real,
      tasks: synth.tasks,
      requirements: synth.requirements,
      releases: synth.releases,
      config: { ...real.config, projects: real.config?.projects ?? [] },
    }
  }
  return real
}

const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}</style></head>
<body><div id="root"></div><pre id="err" style="color:#b91c1c"></pre>
<script src="/react.js"></script><script src="/react-dom.js"></script>
<script>window.__ModuleLoader__={load(c){window.__studioFactory=c.factory}}</script>
<script src="/client.js"></script>
<script>
try{
  const React=window.React, ReactDOM=window.ReactDOM
  const mod=window.__studioFactory(n=>{if(n==='react')return React;throw new Error(n)})
  const cap={}
  const ctx={slots:{inject:(n,f)=>f(),register:(s,c)=>{cap[(s.name??'')]=c;return()=>{}}},effect:f=>(typeof f==='function'?f():()=>{})}
  mod.apply(ctx); window.__mounted=true
  ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(cap.main,{}))
}catch(e){window.__bootFailed=String(e&&e.message?e.message:e);document.getElementById('err').textContent='BOOT '+window.__bootFailed}
</script></body></html>`

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/studio-api/state') {
    const body = JSON.stringify({ ok: true, state: stateFor() })
    res.writeHead(200, { 'content-type': 'application/json', etag: `"state-${mode}-${width}"`, 'cache-control': 'no-store' })
    res.end(body)
    return
  }
  if (url.pathname.startsWith('/studio-api/')) {
    try {
      const upstream = await api(url.pathname + url.search)
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
      res.end(await upstream.text())
    } catch { res.writeHead(502); res.end('{}') }
    return
  }
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return }
  const files = { '/client.js': join(repo, 'client.js'), '/react.js': join(repo, 'web/node_modules/react/umd/react.development.js'), '/react-dom.js': join(repo, 'web/node_modules/react-dom/umd/react-dom.development.js') }
  const file = files[url.pathname]
  if (file === undefined || !existsSync(file)) { res.writeHead(404); res.end('x'); return }
  res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
  res.end(readFileSync(file))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

const MEASURE = () => {
  const root = document.querySelector('[data-dsh-studio]') ?? document.body
  const visible = el => { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return false; const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 }
  const all = [...root.querySelectorAll('*')].filter(visible)
  const sizes = {}; const off = {}
  for (const el of all) {
    const cs = getComputedStyle(el)
    sizes[cs.fontSize] = (sizes[cs.fontSize] ?? 0) + 1
    for (const prop of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'rowGap', 'columnGap']) {
      const v = Math.round(parseFloat(cs[prop]))
      if (!Number.isFinite(v) || v === 0 || v <= 2) continue
      if (v % 4 !== 0) off[prop + '=' + v] = (off[prop + '=' + v] ?? 0) + 1
    }
  }
  const emoji = new Set()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walker.nextNode() !== null) for (const ch of String(walker.currentNode.textContent ?? '').match(/\p{Extended_Pictographic}/gu) ?? []) emoji.add(ch)
  const clipped = [...root.querySelectorAll('*')].filter(el => visible(el) && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && getComputedStyle(el).overflow !== 'auto').length
  return {
    fonts: Object.keys(sizes).sort(),
    offGrid: Object.keys(off).length,
    emoji: [...emoji],
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
    docHeight: document.documentElement.scrollHeight,
    clipped,
    text: String(root.innerText ?? '').replace(/\n{2,}/g, '\n').slice(0, 400),
  }
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
const rows = []
try {
  const page = await browser.newPage()
  await page.setViewport({ width, height: mode === 'mobile' ? 812 : 900 })
  const errors = []
  page.on('pageerror', e => errors.push(String(e?.message ?? e)))
  page.on('console', m => { if (m.type() === 'error' && !/favicon|404 \(Not Found\)/.test(m.text())) errors.push('console: ' + m.text().slice(0, 140)) })
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__mounted === true || window.__bootFailed !== undefined, { timeout: 20000 })
  await new Promise(r => setTimeout(r, 1500))

  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const clickText = async (label, { prefix = false } = {}) => {
    const hit = await page.evaluate((target, usePrefix) => {
      const norm = n => String(n.textContent ?? '').replace(/\s+/g, ' ').trim()
      const node = [...document.querySelectorAll('[data-dsh-studio] button, [role="tab"], a')].find(n => (usePrefix ? norm(n).startsWith(target) : norm(n) === target))
      if (node === undefined) return false
      node.click(); return true
    }, label, prefix)
    await sleep(800)
    return hit
  }
  const shot = async name => {
    const data = await page.evaluate(MEASURE)
    await page.screenshot({ path: join(OUT, `${name}-${mode}${mode === 'mobile' ? '-375' : ''}.png`), fullPage: false })
    rows.push({ name, ...data })
    console.log(`· ${name.padEnd(18)} 字阶 ${data.fonts.join('/')}｜非网格 ${data.offGrid}｜emoji ${data.emoji.length}｜横向溢出 ${data.overflowX ? '有' : '无'}｜截断 ${data.clipped}`)
  }

  if (mode === 'locked') {
    await shot('login')
  } else if (mode === 'interact') {
    // 焦点环：Tab 五次，看 activeElement 有没有可见轮廓
    await clickText('看板')
    const focus = []
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('Tab')
      await sleep(120)
      focus.push(await page.evaluate(() => {
        const el = document.activeElement
        if (el === null) return null
        const cs = getComputedStyle(el)
        return { tag: el.tagName, outline: cs.outlineWidth + ' ' + cs.outlineStyle, shadow: cs.boxShadow !== 'none' }
      }))
    }
    const visible = focus.filter(item => item !== null && (item.shadow || (item.outline.split(' ')[0] !== '0px' && !item.outline.includes('none')))).length
    console.log(`· 焦点环       6 次 Tab 中 ${visible} 次有可见轮廓`)
    rows.push({ name: 'focus-ring', visible, total: focus.length })
    // 禁用态
    const disabled = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('[data-dsh-studio] button[disabled]')][0]
      if (btn === undefined) return null
      const cs = getComputedStyle(btn)
      return { opacity: cs.opacity, cursor: cs.cursor }
    })
    console.log('· 禁用态       ', disabled === null ? '页面上没有 disabled 按钮' : `opacity=${disabled.opacity} cursor=${disabled.cursor}`)
    rows.push({ name: 'disabled', ...(disabled ?? {}) })
    // 悬停
    const hover = await page.evaluate(() => {
      const card = document.querySelector('[data-dsh-studio] [data-kanban-card]')
      if (card === null) return null
      return { before: getComputedStyle(card).boxShadow }
    })
    const cardBox = await page.evaluate(() => {
      const card = document.querySelector('[data-dsh-studio] [data-kanban-card]')
      if (card === null) return null
      const r = card.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })
    if (cardBox !== null) {
      await page.mouse.move(cardBox.x, cardBox.y); await sleep(300)
      const after = await page.evaluate(() => getComputedStyle(document.querySelector('[data-dsh-studio] [data-kanban-card]')).boxShadow)
      console.log(`· 悬停         shadow ${hover.before === after ? '没有变化（⚠）' : '有变化'}`)
      rows.push({ name: 'hover', changed: hover.before !== after })
      // 拖拽：按下 → 移动 → 看 data-dragging，然后松开
      await page.mouse.down(); await page.mouse.move(cardBox.x + 80, cardBox.y, { steps: 6 }); await sleep(250)
      const dragging = await page.evaluate(() => document.querySelectorAll('[data-dsh-studio] [data-dragging="1"]').length)
      await page.mouse.up(); await sleep(300)
      console.log(`· 拖拽         data-dragging 命中 ${dragging}`)
      rows.push({ name: 'drag', dragging })
    }
    await shot('board-interact')
  } else {
    const tabs = mode === 'mobile' ? ['看板', '需求', '设置'] : ['工作台', '看板', '需求', '用例', '版本', '项目', '效能']
    for (const label of tabs) {
      if (!(await clickText(label))) { console.log('  （找不到页签）', label); continue }
      await shot(label)
    }
    if (mode === 'scale') {
      // 需求页：列表密度
      await clickText('需求'); await sleep(600); await shot('需求-列表')
    }
  }

  writeFileSync(join(OUT, `summary-${mode}.json`), JSON.stringify({ base, mode, width, rows, errors }, null, 2))
  console.log(`\n${mode} 完成，${rows.length} 条；页面错误：${errors.slice(0, 3).join(' | ') || '无'}`)
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
}
