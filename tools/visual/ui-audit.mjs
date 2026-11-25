#!/usr/bin/env node
/**
 * UI 审视探针（unslop 口径）：把**真实的 client.js** 挂在最小假宿主上，逐面（8 个页签 +
 * 18 个设置分区 + 抽屉 + 命令面板 + 新建抽屉）做两件事：
 *
 *   1. 截图到 tmp/unslop-audit/<surface>.png（给人看的那份证据）
 *   2. 采 computed style 指标到 tmp/unslop-audit/metrics.json（能数出来的那份证据）
 *      spacing 是否在 4px 网格、字号/字重档位、颜色 token 与彩色面、渐变/发光/彩色阴影、
 *      表情符号、动效、圆角与胶囊、对比度、图标尺寸、行节奏、文案清单。
 *
 * 为什么要有指标：只看截图会把「15px padding 到处都是」当成"看起来还行"。
 * unslop 的九道 pass 里，spacing / color / type 都是可以量出来的。
 *
 *   node tools/visual/ui-audit.mjs --base http://127.0.0.1:<dsh 端口>
 *   node tools/visual/ui-audit.mjs --base ... --only board,settings   # 只跑几个面
 *
 * 会用「演示·」前缀造一套数据让界面上有内容，跑完自动删干净（和 tools/visual/capture.mjs 一致）。
 * 依赖 puppeteer-core + Chrome/Edge，缺了直接跳过。
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
const argOf = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const base = argOf('base', process.env.STUDIO_BASE ?? '')
if (base === '') {
  console.error('用法：node tools/visual/ui-audit.mjs --base http://127.0.0.1:<dsh 端口> [--only a,b]')
  process.exit(2)
}
const theme = argOf('theme', 'light')
const suffix = theme === 'dark' ? '-dark' : ''
const only = new Set(argOf('only', '').split(',').map(item => item.trim()).filter(Boolean))
/* `/studio-api` 过宿主信任栅栏：没有已认证的浏览器会话的请求一律 401。脚本没有浏览器，
   用 dsh web 的启动 token 换 cookie —— api() 与假宿主代理层共用这一份会话（见 tools/lib/studio-auth.mjs）。 */
const authedFetch = studioFetch(base, launchTokenFromEnv())

const require = createRequire(import.meta.url)
let puppeteer
try { puppeteer = require('puppeteer-core') } catch { console.log('跳过：没装 puppeteer-core'); process.exit(0) }
const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
].filter(Boolean).find(path => existsSync(path))
if (CHROME === undefined) { console.log('跳过：找不到 Chrome/Edge（可用 CHROME_PATH 指定）'); process.exit(0) }

const OUT = join(repo, 'tmp', 'unslop-audit')
mkdirSync(OUT, { recursive: true })

const api = async (path, body) => {
  const res = await authedFetch('/studio-api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

// ---------------------------------------------------------------- 假宿主（静态 + 反代）
const HARNESS_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>ui audit</title>
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
        headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
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
  res.writeHead(200, { 'content-type': extname(file) === '.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream' })
  res.end(readFileSync(file))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

// ---------------------------------------------------------------- 演示数据（跑完删干净）
const made = { cards: [], requirements: [], release: '', project: '' }
const seed = async () => {
  const project = await api('/projects/save', { project: { name: '演示·订单中心', key: 'ORD', description: '演示数据：下单、支付与库存', baseBranch: 'main', services: [{ name: 'order-service', repoPath: '/srv/repos/order', baseBranch: 'main' }] } })
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
  const second = await api('/requirement/save', { requirement: { title: '演示·退款流水', description: '退款单与流水对账。', project: made.project, discovery: { server: '有', auth: '服务端', boundary: '后端' } } })
  made.requirements.push(second.json.requirement?.id ?? '')
  await api('/requirement/review', { id: requirementId, decision: 'approve', by: '演示·产品经理', note: '范围清楚，可以拆卡' })

  const make = async spec => {
    const out = await api('/task/create', { ...spec, requirementId, project: made.project })
    const id = out.json.task?.id ?? ''
    if (id !== '') made.cards.push(id)
    return id
  }
  await make({ title: '演示·澄清抵扣规则', type: 'requirement', role: 'product', status: 'clarify', pointId: 'p1' })
  const design = await make({ title: '演示·抵扣技术方案', type: 'design', role: 'architect', status: 'design', pointId: 'p1' })
  const dev = await make({ title: '演示·实现抵扣与回滚', type: 'dev', role: 'dev', status: 'dev', pointId: 'p1', dueAt: Date.now() + 2 * 86400000 })
  await make({ title: '演示·抵扣接口评审', type: 'design', role: 'architect', status: 'review', pointId: 'p2' })
  const test = await make({ title: '演示·抵扣用例验证', type: 'test', role: 'qa', status: 'test', pointId: 'p1' })
  await make({ title: '演示·抵扣上线验收', type: 'ops', role: 'product', status: 'accept', pointId: 'p1' })
  const done = await make({ title: '演示·回滚链路自测', type: 'test', role: 'qa', status: 'done', pointId: 'p2' })
  await api('/task/design', { id: design, status: 'approved', drafts: [{ id: 'd1', name: '方案 A：下单时算', link: 'https://example.com/a', note: '改动小，但支付失败要补回滚' }, { id: 'd2', name: '方案 B：支付后算', link: 'https://example.com/b', note: '不用回滚，但要多一次查询' }], chosenId: 'd2', by: '演示·架构师', note: '选 B，少一条失败路径' })
  await api('/task/coding', { id: dev, action: 'update', agent: '演示·研发工程师', branch: 'feat/points-deduct', files: [{ path: 'src/points.js', change: 'added' }, { path: 'src/order.js', change: 'modified' }], commits: [{ sha: 'a1b2c3d', message: 'feat: 积分抵扣' }], testsTotal: 6, testsPassed: 6 })
  await api('/task/coding', { id: dev, action: 'review', status: 'approved', by: '演示·架构师', reviewNote: '接口有幂等，可以' })
  await api('/task/artifact', { id: dev, action: 'add', artifact: { kind: 'requirement', title: '演示·需求说明', content: '## 目标\n\n下单可用积分抵扣，最多抵 30%。\n\n## 不做\n\n不做跨订单合并抵扣。', status: 'delivered' }, by: '演示·产品经理' })
  await api('/task/artifact', { id: design, action: 'add', artifact: { kind: 'design', title: '演示·技术方案', content: '## 方案\n\n支付成功后按实付金额计算抵扣，失败无需回滚。', status: 'delivered' }, by: '演示·架构师' })
  await api('/task/artifact', { id: test, action: 'add', artifact: { kind: 'report', title: '演示·测试报告', content: '## 结论\n\n6/6 通过，边界（30% 上限、余额不足）已覆盖。', status: 'delivered' }, by: '演示·测试工程师' })
  await api('/task/case', { id: test, action: 'add', cases: [
    { title: '演示·100 积分抵 1 元', expected: '返回抵扣 1 元', http: { method: 'POST', url: 'https://example.com/api/deduct', expectStatus: 200 }, result: 'pass', pointId: 'p1', acceptanceId: 'a1' },
    { title: '演示·超过 30% 被截断', expected: '抵扣不超过订单 30%', http: { method: 'POST', url: 'https://example.com/api/deduct', expectStatus: 200 }, result: 'pass', pointId: 'p1', acceptanceId: 'a2' },
    { title: '演示·支付失败积分退回', expected: '积分退回原余额', result: 'pending', pointId: 'p2', acceptanceId: 'a3' },
  ], by: '演示·测试工程师' })
  await api('/task/comment', { id: test, body: '@演示·研发工程师 30% 上限那条用例我按金额口径验了，没问题。', author: '演示·测试工程师', kind: 'agent' })
  await api('/task/checklist', { id: done, action: 'add', text: '演示·自测通过' })
  const release = await api('/release/save', { release: { version: 'v9.9.9', name: '演示·积分抵扣首发', project: made.project, owner: '演示·产品经理', status: 'candidate' } })
  made.release = release.json.release?.id ?? ''
}
const cleanup = async () => {
  for (const id of made.cards) await api('/task/delete', { id, confirm: 'DELETE' }).catch(() => {})
  for (const id of made.requirements) await api('/requirement/delete', { id, confirm: 'DELETE', deleteFolder: true }).catch(() => {})
  if (made.release !== '') await api('/release/delete', { id: made.release, confirm: 'DELETE' }).catch(() => {})
  if (made.project !== '') await api('/projects/delete', { id: made.project, confirm: 'DELETE' }).catch(() => {})
}

// ---------------------------------------------------------------- 页面内的指标采集
const COLLECTOR = `(() => {
  const root = document.querySelector('[data-dsh-studio]')
  if (root === null) return { error: '面板根节点没挂上' }
  const nearest = (el, prop) => {
    let node = el
    while (node !== null) {
      const value = getComputedStyle(node)[prop]
      if (value !== '' && value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') return value
      node = node.parentElement
    }
    return 'rgb(255, 255, 255)'
  }
  const parseColor = value => {
    const match = String(value).match(/rgba?\\(([^)]+)\\)/)
    if (match === null) return null
    const parts = match[1].split(',').map(item => Number(item.trim()))
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] === undefined ? 1 : parts[3] }
  }
  const hsl = c => {
    const r = c.r / 255, g = c.g / 255, b = c.b / 255
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2
    let h = 0, s = 0
    if (max !== min) {
      const d = max - min
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
      h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? ((b - r) / d + 2) : ((r - g) / d + 4)
      h *= 60
    }
    return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) }
  }
  const lum = c => {
    const channel = v => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4) }
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
  }
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100 }
  // 半透明底要按 alpha 合到父层再算对比度：color-mix(…, transparent) 直接取 RGB 会得到假阳性
  const effectiveBg = el => {
    const layers = []
    let node = el
    while (node !== null) {
      const found = parseColor(getComputedStyle(node).backgroundColor)
      if (found !== null && found.a > 0) { layers.push(found); if (found.a >= 1) break }
      node = node.parentElement
    }
    let base = { r: 255, g: 255, b: 255, a: 1 }
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      const layer = layers[index]
      base = { r: Math.round(layer.r * layer.a + base.r * (1 - layer.a)), g: Math.round(layer.g * layer.a + base.g * (1 - layer.a)), b: Math.round(layer.b * layer.a + base.b * (1 - layer.a)), a: 1 }
    }
    return base
  }
  const visible = el => {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false
    if (el.closest('[aria-hidden="true"]') !== null) return false
    const r = el.getBoundingClientRect()
    return r.width > 2 && r.height > 2
  }
  const describe = el => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.') : ''
    const text = String(el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 34)
    return el.tagName.toLowerCase() + (cls === '' ? '' : '.' + cls) + (text === '' ? '' : ' «' + text + '»')
  }
  const all = [...root.querySelectorAll('*')].filter(visible)
  const result = {
    elements: all.length,
    offGrid: {}, offGridSamples: {}, onGrid: {},
    fontSizes: {}, fontWeights: {}, fontFamilies: {},
    textColors: {}, backgrounds: {}, borderColors: {},
    coloredSurfaces: [], gradients: [], gradientText: [], shadows: [], coloredShadows: [],
    emoji: [], animations: [], transitionAll: [], radii: {}, pills: 0,
    contrast: [], iconSizes: {}, strokes: {}, rowRhythm: [],
    tracking: [], uppercase: [], copy: { headings: [], buttons: [], hints: [] },
    smallControls: [], overflowY: document.documentElement.scrollHeight > window.innerHeight + 2,
    viewport: [window.innerWidth, window.innerHeight],
    docHeight: document.documentElement.scrollHeight,
  }
  const bump = (bag, key) => { bag[key] = (bag[key] ?? 0) + 1 }
  for (const el of all) {
    const cs = getComputedStyle(el)
    // ---- spacing：4px 网格
    for (const prop of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'rowGap', 'columnGap']) {
      const raw = cs[prop]
      if (raw === '' || raw === 'normal' || raw === 'auto' || raw === '0px') continue
      const value = Math.round(parseFloat(raw))
      if (!Number.isFinite(value) || value === 0) continue
      const grid = value % 4 === 0 ? 'onGrid' : 'offGrid'
      bump(result[grid], prop + '=' + value)
      if (grid === 'offGrid' && Object.keys(result.offGridSamples).length < 120) {
        const cls = typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
        const key = prop + '=' + value + ' ' + el.tagName.toLowerCase() + cls
        if (result.offGridSamples[key] === undefined) result.offGridSamples[key] = describe(el).slice(0, 80)
      }
    }
    // ---- type
    bump(result.fontSizes, cs.fontSize)
    if (cs.fontSize === '14px' && (result.font14 ??= []).length < 20) result.font14.push(describe(el).slice(0, 90))
    bump(result.fontWeights, cs.fontWeight)
    bump(result.fontFamilies, cs.fontFamily.split(',')[0].replace(/["']/g, '').trim())
    if (cs.textTransform === 'uppercase' || cs.textTransform === 'capitalize') {
      if (result.uppercase.length < 40) result.uppercase.push(describe(el) + ' [' + cs.textTransform + ' ' + cs.letterSpacing + ']')
    }
    if (cs.letterSpacing !== 'normal') {
      const ls = parseFloat(cs.letterSpacing), size = parseFloat(cs.fontSize)
      if (size <= 16 && (ls < 0 || ls > 0.6) && result.tracking.length < 30) result.tracking.push(describe(el) + ' size=' + size + ' tracking=' + cs.letterSpacing)
    }
    // ---- color
    bump(result.textColors, cs.color)
    const bg = parseColor(cs.backgroundColor)
    if (bg !== null && bg.a > 0) {
      bump(result.backgrounds, cs.backgroundColor)
      const h = hsl(bg)
      if (h.s > 8 && bg.a > 0.5 && result.coloredSurfaces.length < 40 && bg.a > 0.2) result.coloredSurfaces.push(describe(el) + ' ' + cs.backgroundColor + ' hsl(' + h.h + ',' + h.s + '%,' + h.l + '%)')
    }
    if (cs.borderTopWidth !== '0px' && cs.borderTopStyle !== 'none') bump(result.borderColors, cs.borderTopColor)
    // ---- gradients / glows
    if (/gradient/.test(cs.backgroundImage) && result.gradients.length < 25) result.gradients.push(describe(el) + ' :: ' + cs.backgroundImage.slice(0, 110))
    if (/text/.test(cs.webkitBackgroundClip || cs.backgroundClip) && /gradient/.test(cs.backgroundImage) && result.gradientText.length < 10) result.gradientText.push(describe(el))
    if (cs.boxShadow !== 'none') {
      const colors = cs.boxShadow.match(/rgba?\\([^)]+\\)/g) ?? []
      const colored = colors.some(item => { const c = parseColor(item); if (c === null) return false; const h = hsl(c); return c.a > 0.02 && h.s > 12 })
      if (colored && result.coloredShadows.length < 20) result.coloredShadows.push(describe(el) + ' :: ' + cs.boxShadow.slice(0, 90))
      else bump(result.shadows, cs.boxShadow.split(')')[0] + ')')
    }
    // ---- motion
    if (cs.animationName !== 'none' && result.animations.length < 25) result.animations.push(describe(el) + ' ' + cs.animationName + ' ' + cs.animationDuration + ' x' + cs.animationIterationCount)
    if (String(cs.transitionProperty).includes('all') && !result.transitionAll.includes(cs.transitionProperty + ' ' + cs.transitionDuration)) result.transitionAll.push(describe(el) + ' :: ' + cs.transitionProperty + ' ' + cs.transitionDuration)
    // ---- radii
    bump(result.radii, cs.borderTopLeftRadius)
    if (parseFloat(cs.borderTopLeftRadius) >= 99) result.pills += 1
    // ---- icons
    if (el.tagName === 'svg') {
      const r = el.getBoundingClientRect()
      bump(result.iconSizes, Math.round(r.width) + 'x' + Math.round(r.height))
      const stroke = el.getAttribute('stroke-width') ?? getComputedStyle(el).strokeWidth
      if (stroke !== null) bump(result.strokes, String(stroke))
    }
    // ---- controls
    if (['BUTTON', 'A', 'INPUT', 'SELECT'].includes(el.tagName)) {
      const r = el.getBoundingClientRect()
      if (r.height < 28 && r.height > 0 && result.smallControls.length < 25) result.smallControls.push(describe(el) + ' h=' + Math.round(r.height))
    }
    // ---- contrast（只测有文字的叶子）
    const ownText = [...el.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent.trim()).join('')
    if (ownText.length >= 2) {
      const fg = parseColor(cs.color)
      const rawBg = effectiveBg(el)
      const bgAlpha = (parseColor(cs.backgroundColor) ?? { a: 1 }).a
      const bgColor = { r: rawBg.r, g: rawBg.g, b: rawBg.b, a: 1 }
      if (fg !== null && bgColor !== null && fg.a > 0.5) {
        const size = parseFloat(cs.fontSize), weight = Number(cs.fontWeight) || 400
        const large = size >= 24 || (size >= 18.66 && weight >= 700)
        const need = large ? 3 : 4.5
        const fgSolid = { r: Math.round(fg.r * fg.a + bgColor.r * (1 - fg.a)), g: Math.round(fg.g * fg.a + bgColor.g * (1 - fg.a)), b: Math.round(fg.b * fg.a + bgColor.b * (1 - fg.a)), a: 1 }
        const value = ratio(fgSolid, bgColor)
        if (value < need && result.contrast.length < 30) result.contrast.push(describe(el) + ' ' + value + ':1 (need ' + need + ', ' + cs.fontSize + '/' + weight + ')')
      }
    }
    // ---- copy
    if (['H1', 'H2', 'H3', 'H4'].includes(el.tagName)) { const text = String(el.textContent ?? '').trim(); if (text !== '' && result.copy.headings.length < 25) result.copy.headings.push(el.tagName + ' ' + text) }
    if (el.tagName === 'BUTTON') { const text = String(el.textContent ?? '').replace(/\s+/g, ' ').trim(); if (text !== '' && result.copy.buttons.length < 60) result.copy.buttons.push(text.slice(0, 40)) }
    if (typeof el.className === 'string' && /hint/.test(el.className)) { const text = String(el.textContent ?? '').replace(/\s+/g, ' ').trim(); if (text !== '' && result.copy.hints.length < 25) result.copy.hints.push(text.slice(0, 90)) }
  }
  // ---- emoji（界面文字里的图形符号）
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const emojiSeen = new Set()
  while (walker.nextNode() !== null) {
    const node = walker.currentNode
    const text = node.textContent ?? ''
    // 用 Unicode 属性而不是窄字符集：以前写的是 1F300-1FAFF / 2600-27BF，
    // 把 ▶ ▼ ▲ ↔ 这类「几何符号当图标」全漏了（▶ 是 Extended_Pictographic 但不在那些区段里）。
    const hits = text.match(/\\p{Extended_Pictographic}/gu)
    if (hits === null) continue
    for (const hit of hits) {
      const key = hit + '|' + text.replace(/\s+/g, ' ').trim().slice(0, 24)
      if (emojiSeen.has(key)) continue
      emojiSeen.add(key)
      if (result.emoji.length < 40) result.emoji.push(hit + ' in «' + text.replace(/\s+/g, ' ').trim().slice(0, 60) + '»')
    }
  }
  // ---- 行节奏：同 class 的兄弟重复块高度是否一致
  const groups = new Map()
  for (const el of all) {
    if (typeof el.className !== 'string' || el.className.trim() === '') continue
    const key = el.parentElement === null ? '' : (el.parentElement.className || el.parentElement.tagName) + '>' + el.className.trim()
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(el)
  }
  for (const [key, list] of groups) {
    if (list.length < 4) continue
    const heights = list.map(el => Math.round(el.getBoundingClientRect().height)).filter(h => h > 8)
    if (heights.length < 4) continue
    const min = Math.min(...heights), max = Math.max(...heights)
    if (max - min > 2 && result.rowRhythm.length < 20) result.rowRhythm.push(key.split('>')[1] + ' x' + heights.length + ' heights ' + min + '..' + max)
  }
  const svgNodes = [...root.querySelectorAll('svg')].filter(el => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0 })
  result.icons = { total: svgNodes.length, sizes: svgNodes.reduce((bag, el) => { const box = el.getBoundingClientRect(); const key = Math.round(box.width) + 'x' + Math.round(box.height); bag[key] = (bag[key] ?? 0) + 1; return bag }, {}) }

  // ---- 几何：构图、留白、对齐、截断
  const rectOf = el => el.getBoundingClientRect()
  const main = root.querySelector('[data-settings-page], [data-market-page]') ?? root
  const mainRect = rectOf(main)
  const blocks = [...main.children].filter(visible).map(el => { const r = rectOf(el); return { el: describe(el).slice(0, 46), top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width), left: Math.round(r.left) } })
  const contentBottom = blocks.length === 0 ? 0 : Math.max(...blocks.map(b => b.top + b.h))
  const grids = [...root.querySelectorAll('*')].filter(el => getComputedStyle(el).display === 'grid' && visible(el)).slice(0, 14).map(el => {
    const cols = getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length
    const kids = [...el.children].filter(visible)
    return { el: describe(el).slice(0, 46), cols, kids: kids.length, lastRow: kids.length % cols === 0 ? cols : kids.length % cols }
  })
  const clipped = [...root.querySelectorAll('*')].filter(el => visible(el) && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0).slice(0, 20).map(el => describe(el) + ' ' + el.clientWidth + '→' + el.scrollWidth)
  const cols = [...root.querySelectorAll('[data-board-column]')].filter(visible).map(el => Math.round(rectOf(el).width))
  result.geometry = {
    viewport: [window.innerWidth, window.innerHeight],
    main: { left: Math.round(mainRect.left), width: Math.round(mainRect.width), padLeft: getComputedStyle(main).paddingLeft, padRight: getComputedStyle(main).paddingRight },
    blocks,
    contentBottom,
    deadBand: Math.max(0, window.innerHeight - contentBottom),
    grids,
    clipped,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
    columnWidths: cols,
  }
  return result
})()`

// ---------------------------------------------------------------- 逐面走查
const PAGES = [
  ['dashboard', '工作台'],
  ['board', '看板'],
  ['requirements', '需求'],
  ['cases', '用例'],
  ['releases', '版本'],
  ['projects', '项目'],
  ['analytics', '效能'],
]
const PANELS = [
  ['settings-projects', '项目与迭代'],
  ['settings-experts', '专家'],
  ['settings-teams', '专家团'],
  ['settings-skills', '技能库'],
  ['settings-columns', '列的负责人'],
  ['settings-gitlab', '代码仓库'],
  ['settings-feishu', '飞书机器人'],
  ['settings-docs', '文档出口'],
  ['settings-health', '集成健康'],
  ['settings-agents', '自动派单'],
  ['settings-testing', '测试执行'],
  ['settings-costs', '成本与预算'],
  ['settings-environments', '部署环境'],
  ['settings-board', '看板外观'],
  ['settings-ldap', '统一登录'],
  ['settings-access', '权限与审计'],
  ['settings-storage', '数据与备份'],
]

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
const results = {}
const errors = []
try {
  await seed()
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  page.on('pageerror', error => errors.push('pageerror: ' + String(error?.message ?? error)))
  page.on('console', message => { if (message.type() === 'error' && !/favicon|404/.test(message.text())) errors.push('console: ' + message.text().slice(0, 160)) })

  const harnessUrl = `http://127.0.0.1:${server.address().port}`
  await page.goto(harnessUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__pageMounted === true || window.__bootFailed !== undefined, { timeout: 20000 })
  await new Promise(resolve => setTimeout(resolve, 1500))

  const clickBy = async (label, { prefix = true } = {}) => {
    const hit = await page.evaluate((target, usePrefix) => {
      const nodes = [...document.querySelectorAll('button, [role="tab"], [role="tab"] span, a')]
      const norm = item => String(item.textContent ?? '').replace(/\s+/g, ' ').trim()
      const exact = nodes.find(item => norm(item) === target)
      const node = exact ?? (usePrefix ? nodes.find(item => norm(item).startsWith(target)) : undefined)
      if (node === undefined) return false
      node.click()
      return true
    }, label, prefix)
    await new Promise(resolve => setTimeout(resolve, 650))
    return hit
  }

  const surface = async (name, extra = {}) => {
    if (only.size > 0 && !only.has(name) && !only.has('all')) return
    const metrics = await page.evaluate(COLLECTOR)
    const text = await page.evaluate(() => String(document.querySelector('[data-dsh-studio]')?.innerText ?? '').replace(/\n{3,}/g, '\n\n').slice(0, 9000))
    await page.screenshot({ path: join(OUT, name + suffix + '.png'), fullPage: false })
    // 长页面再补一张整页图，便于看留白与节奏
    const tall = await page.evaluate(() => document.documentElement.scrollHeight)
    if (tall > 1100) await page.screenshot({ path: join(OUT, name + suffix + '-full.png'), fullPage: true })
    results[name] = { ...extra, metrics, text, scrollHeight: tall }
    const offGrid = Object.keys(metrics.offGrid ?? {}).length
    console.log(`· ${name.padEnd(22)} els=${String(metrics.elements ?? 0).padStart(4)} offGrid=${String(offGrid).padStart(3)} sizes=${Object.keys(metrics.fontSizes ?? {}).length} colors=${Object.keys(metrics.textColors ?? {}).length} emoji=${(metrics.emoji ?? []).length} grad=${(metrics.gradients ?? []).length} glowShadow=${(metrics.coloredShadows ?? []).length}`)
  }

  if (theme === 'dark') { const dark = await page.evaluate(() => { const hit = [...document.querySelectorAll('button')].find(node => String(node.textContent ?? '').includes('黑暗')); if (hit === undefined) return false; hit.click(); return true }); console.log(dark ? '主题：黑暗' : '（没切到黑暗）'); await new Promise(resolve => setTimeout(resolve, 700)) }

  // ① 八个页签
  await surface('dashboard')
  for (const [name, label] of PAGES.slice(1)) {
    const ok = await clickBy(label)
    if (!ok) { console.log('（找不到页签）', label); continue }
    await new Promise(resolve => setTimeout(resolve, 500))
    await surface(name)
  }

  // ② 设置：17 个分区
  const settingsOk = await clickBy('设置')
  if (settingsOk) {
    for (const [name, label] of PANELS) {
      const ok = await clickBy(label)
      if (!ok) { console.log('（找不到设置分区）', label); continue }
      await new Promise(resolve => setTimeout(resolve, 450))
      await surface(name)
    }
  } else console.log('（找不到设置页签）')

  // ③ 卡片抽屉 + 各页签
  await clickBy('看板')
  await new Promise(resolve => setTimeout(resolve, 700))
  const opened = await page.evaluate(() => {
    const card = [...document.querySelectorAll('[data-kanban-card]')].find(node => String(node.textContent ?? '').includes('演示·抵扣用例验证')) ?? document.querySelector('[data-kanban-card]')
    if (card === undefined || card === null) return false
    card.click()
    return true
  })
  if (opened) {
    await new Promise(resolve => setTimeout(resolve, 1200))
    await surface('drawer')
    for (const [name, label] of [['drawer-plan', '计划'], ['drawer-discuss', '讨论'], ['drawer-deliver', '交付'], ['drawer-test', '测试']]) {
      const ok = await clickBy(label)
      if (!ok) continue
      await new Promise(resolve => setTimeout(resolve, 700))
      await surface(name)
    }
    await clickBy('关闭')
  }

  // ④ 命令面板（⌘K）
  if (only.size === 0 || only.has('palette') || only.has('all')) {
    await page.keyboard.down('Control')
    await page.keyboard.press('KeyK')
    await page.keyboard.up('Control')
    await new Promise(resolve => setTimeout(resolve, 900))
    await surface('palette')
    await page.keyboard.press('Escape')
    await new Promise(resolve => setTimeout(resolve, 400))
  }

  // ⑤ 新建抽屉（＋ 新建 → 新建任务）
  if (only.size === 0 || only.has('new-task') || only.has('all')) {
    await clickBy('＋ 新建')
    const picked = await clickBy('新建任务')
    if (picked) {
      await new Promise(resolve => setTimeout(resolve, 900))
      await surface('new-task')
      await page.keyboard.press('Escape')
    } else console.log('（没找到「新建任务」菜单项）')
  }

  writeFileSync(join(OUT, 'metrics' + suffix + '.json'), JSON.stringify({ base, at: new Date().toISOString(), results, errors }, null, 2))
  console.log('\\n写入', OUT)
  if (errors.length > 0) console.log('页面报错：' + errors.slice(0, 5).join(' | '))
  else console.log('页面无报错')
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
  await cleanup()
}
