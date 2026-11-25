#!/usr/bin/env node
/**
 * 无障碍巡检（真机 + 真 Chrome）：对比度、可访问名称、键盘可达、抽屉焦点圈。
 *
 *   STUDIO_TOKEN=… STUDIO_BASE=http://<host>:18080 npm run verify:a11y
 *
 * 为什么先量再写：ACCESSIBILITY.md 里如果写「已支持键盘操作 / 对比度达标」，
 * 那必须是量出来的，不能是愿望。这个探针只报事实，不自动修。
 *
 * 判据按 WCAG 2.2：
 *   - 正文对比度 ≥ 4.5:1，大字号（≥24px，或 ≥18.66px 且粗体）≥ 3:1
 *   - 交互元素必须有可访问名称（文字 / aria-label / title）
 *   - 图片必须有 alt（装饰性用 alt=""）
 *   - 焦点必须看得见（outline 或 box-shadow 变化）
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
const errors = []
page.on('pageerror', error => errors.push(String(error).slice(0, 160)))

/** 页面里跑的采集逻辑：对比度 + 可访问名称 + 图片 alt。 */
const collectAudit = () => {
  const parseColor = input => {
    const match = String(input).match(/rgba?\(([^)]+)\)/)
    if (match === null) return null
    const parts = match[1].split(',').map(part => Number(part.trim()))
    const [r, g, b] = parts
    const a = parts.length > 3 ? parts[3] : 1
    return { r, g, b, a }
  }
  const luminance = ({ r, g, b }) => {
    const channel = value => {
      const v = value / 255
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }
  const blend = (front, back) => ({
    r: front.r * front.a + back.r * (1 - front.a),
    g: front.g * front.a + back.g * (1 - front.a),
    b: front.b * front.a + back.b * (1 - front.a),
    a: 1,
  })
  const effectiveBackground = node => {
    let current = node
    let acc = null
    while (current !== null && current !== document.documentElement) {
      const found = parseColor(getComputedStyle(current).backgroundColor)
      if (found !== null && found.a > 0) acc = acc === null ? found : blend(acc, found)
      if (acc !== null && acc.a >= 1) return acc
      current = current.parentElement
    }
    const body = parseColor(getComputedStyle(document.body).backgroundColor)
    const fallback = { r: 255, g: 255, b: 255, a: 1 }
    return acc === null ? (body ?? fallback) : blend(acc, body ?? fallback)
  }

  const contrast = []
  const unnamed = []
  const images = []
  const root = document.querySelector('[data-dsh-studio]') ?? document.body

  for (const node of root.querySelectorAll('*')) {
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue
    const rect = node.getBoundingClientRect()
    if (rect.width < 4 || rect.height < 4) continue
    const ownText = [...node.childNodes]
      .filter(child => child.nodeType === 3)
      .map(child => child.textContent.trim())
      .join('')
      .trim()
    // 只看"自己直接带文字"的节点，避免祖先重复计
    if (ownText !== '') {
      const fg = parseColor(style.color)
      if (fg !== null) {
        const bg = effectiveBackground(node)
        const front = fg.a < 1 ? blend(fg, bg) : fg
        const l1 = luminance(front)
        const l2 = luminance(bg)
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
        const size = Number.parseFloat(style.fontSize)
        const bold = Number(style.fontWeight) >= 700
        const large = size >= 24 || (size >= 18.66 && bold)
        const need = large ? 3 : 4.5
        if (ratio + 0.01 < need) {
          contrast.push({
            text: ownText.slice(0, 40),
            ratio: Number(ratio.toFixed(2)),
            need,
            size,
            color: style.color,
            bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
            cls: String(node.className ?? '').slice(0, 40),
          })
        }
      }
    }
    const tag = node.tagName.toLowerCase()
    if (tag === 'button' || (tag === 'a' && node.hasAttribute('href')) || node.getAttribute('role') === 'button') {
      const name = (node.getAttribute('aria-label') ?? node.getAttribute('title') ?? node.textContent ?? '').trim()
      if (name === '') unnamed.push({ tag, cls: String(node.className ?? '').slice(0, 40), html: node.outerHTML.slice(0, 120) })
    }
    if (tag === 'img' && !node.hasAttribute('alt')) images.push(node.outerHTML.slice(0, 120))
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const id = node.getAttribute('id')
      const labelled = (id !== null && document.querySelector(`label[for="${CSS.escape(id)}"]`) !== null)
        || node.closest('label') !== null   // 包在 label 里的控件有隐式标签（HTML 规范），别误报
        || node.getAttribute('aria-label') !== null
        || node.getAttribute('aria-labelledby') !== null
        || node.getAttribute('title') !== null
      if (!labelled && node.getAttribute('type') !== 'hidden') unnamed.push({ tag, cls: String(node.className ?? '').slice(0, 40), html: node.outerHTML.slice(0, 120) })
    }
  }
  return {
    contrast: contrast.slice(0, 40),
    contrastCount: contrast.length,
    unnamed: unnamed.slice(0, 20),
    unnamedCount: unnamed.length,
    images: images.slice(0, 10),
    imagesCount: images.length,
  }
}

const report = { tabs: {}, keyboard: {}, drawer: {}, pageerrors: errors }

const theme = String(process.env.A11Y_THEME ?? '').trim()

async function enterPanel() {
  await page.goto(`${baseUrl}/?token=${token}`, { waitUntil: 'networkidle2', timeout: 60000 })
  await sleep(1500)
  if (theme === 'dark' || theme === 'light') {
    // 主题存在 localStorage 里（键名 dsh-studio:theme），写完重新加载才生效。
    await page.evaluate(key => localStorage.setItem('dsh-studio:theme', key), theme)
    await page.reload({ waitUntil: 'networkidle2', timeout: 60000 })
  }
  await sleep(2500)
  await page.evaluate(() => {
    const node = [...document.querySelectorAll('*')].find(el => el.children.length === 0 && (el.textContent || '').trim() === '需求&任务工作空间')
    node?.closest('button,a,li,[role="button"],[tabindex]')?.click()
  })
  await page.waitForSelector('[data-dsh-studio]', { timeout: 30000 })
  await sleep(1500)
}

try {
  await enterPanel()

  // 1) 每个页签的可访问性巡检
  const tabs = await page.$$eval('[data-dsh-studio] [data-head-tabs] button', nodes => nodes.map(node => node.textContent.trim()))
  for (const name of tabs) {
    for (const tab of await page.$$('[data-dsh-studio] [data-head-tabs] button')) {
      if (((await tab.evaluate(node => node.textContent)) || '').trim() === name) { await tab.click(); break }
    }
    await sleep(1800)
    report.tabs[name] = await page.evaluate(collectAudit)
  }

  // 1b) 设置页的 17 个面板逐屏扫（这页是最容易被漏掉的：左栏一堆导航 + 密集表单）
  const settingsTab = await page.$$eval('[data-dsh-studio] [data-head-tabs] button', nodes => nodes.map(node => node.textContent.trim()))
  if (settingsTab.includes('设置')) {
    for (const tab of await page.$$('[data-dsh-studio] [data-head-tabs] button')) {
      if (((await tab.evaluate(node => node.textContent)) || '').trim() === '设置') { await tab.click(); break }
    }
    await sleep(1500)
    const panels = await page.$$eval('[data-dsh-studio] [data-settings-nav] button', nodes => nodes.map(node => node.textContent.trim()).filter(Boolean))
    for (const name of panels.slice(0, 20)) {
      for (const button of await page.$$('[data-dsh-studio] [data-settings-nav] button')) {
        if (((await button.evaluate(node => node.textContent)) || '').trim() === name) { await button.click(); break }
      }
      await sleep(700)
      report.tabs['设置 · ' + name] = await page.evaluate(collectAudit)
    }

    // 命令面板（⌘K / Ctrl+K）
    await page.keyboard.down('Control')
    await page.keyboard.press('KeyK')
    await page.keyboard.up('Control')
    await sleep(900)
    report.tabs['命令面板'] = await page.evaluate(collectAudit)
    await page.keyboard.press('Escape')
    await sleep(400)
  }

  // 2) 键盘可达：Tab 走一圈，看焦点是否可见
  await page.evaluate(() => document.body.focus())
  const focusTrail = []
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press('Tab')
    await sleep(120)
    focusTrail.push(await page.evaluate(() => {
      const node = document.activeElement
      if (node === null || node === document.body) return { tag: 'body', name: '', visible: false }
      const style = getComputedStyle(node)
      const visible = (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0)
        || (style.boxShadow !== 'none' && style.boxShadow !== '')
      return {
        tag: node.tagName.toLowerCase(),
        name: (node.getAttribute('aria-label') ?? node.textContent ?? '').trim().slice(0, 30),
        visible,
      }
    }))
  }
  report.keyboard = { trail: focusTrail, invisible: focusTrail.filter(item => item.tag !== 'body' && item.visible !== true).length }

  // 3) 抽屉：能不能打开、焦点是否被困在里面、Esc 能不能关
  for (const tab of await page.$$('[data-dsh-studio] [data-head-tabs] button')) {
    if (((await tab.evaluate(node => node.textContent)) || '').trim() === '看板') { await tab.click(); break }
  }
  await sleep(1500)
  const opened = await page.evaluate(() => {
    const card = document.querySelector('[data-dsh-studio] [data-kanban-card]')
    if (card === null) return false
    card.click()
    return true
  })
  await sleep(1500)
  const drawer = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"], [data-dsh-studio-portal]')
    return {
      present: dialog !== null,
      inside: dialog !== null ? dialog.contains(document.activeElement) : false,
      role: dialog?.getAttribute('role') ?? '',
      label: dialog?.getAttribute('aria-label') ?? '',
    }
  })
  const focusInside = []
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press('Tab')
    await sleep(100)
    focusInside.push(await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"], [data-dsh-studio-portal]')
      return dialog === null ? null : dialog.contains(document.activeElement)
    }))
  }
  await page.keyboard.press('Escape')
  await sleep(800)
  const closed = await page.evaluate(() => document.querySelector('[role="dialog"]') === null)
  report.drawer = {
    opened,
    ...drawer,
    trapOk: focusTrail.length > 0 && focusInside.every(item => item !== false),
    escaped: focusInside.filter(item => item === false).length,
    closedByEscape: closed,
  }
  // 5) 重排（WCAG 1.4.10）：320px 宽不许横向滚动；1600→800 相当于 200% 缩放
  report.reflow = []
  for (const [label, width] of [['320px（窄屏）', 320], ['800px（≈200% 缩放）', 800]]) {
    await page.setViewport({ width, height: 900 })
    await sleep(900)
    const result = await page.evaluate(() => {
      const doc = document.documentElement
      const overflow = doc.scrollWidth - doc.clientWidth
      let widest = null
      if (overflow > 1) {
        let max = 0
        for (const node of document.querySelectorAll('[data-dsh-studio] *')) {
          const rect = node.getBoundingClientRect()
          if (rect.width > max && rect.right > doc.clientWidth + 1) {
            max = rect.width
            widest = { tag: node.tagName.toLowerCase(), cls: String(node.className ?? '').slice(0, 40), width: Math.round(rect.width) }
          }
        }
      }
      return { overflow, widest }
    })
    report.reflow.push({ label, width, ...result })
  }
  await page.setViewport({ width: 1600, height: 1000 })
  await sleep(600)

  // 6) prefers-reduced-motion：系统开了「减少动态效果」时过渡必须接近 0
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  await sleep(400)
  report.reducedMotion = await page.evaluate(() => {
    const sample = document.querySelector('[data-dsh-studio] [data-kanban-card], [data-dsh-studio] [data-variant], [data-dsh-studio] [data-settings-page], [data-market-page]')
    if (sample === null) return { supported: false }
    const style = getComputedStyle(sample)
    const toMs = value => {
      const number = Number.parseFloat(value || '0') || 0
      return String(value ?? '').includes('ms') ? number : number * 1000
    }
    const transition = toMs(style.transitionDuration)
    const animation = toMs(style.animationDuration)
    return { supported: true, transitionMs: transition, animationMs: animation, neutralized: transition <= 2 && animation <= 2 }
  })
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }])

  // 7) 弹窗（版本页的「删除」确认框：打开一次、量完就 Esc，不会真的删）
  try {
    report.dialogs = { opened: 0, audits: [], names: [] }
    for (const tab of await page.$$('[data-dsh-studio] [data-head-tabs] button')) {
      if (((await tab.evaluate(node => node.textContent)) || '').trim() === '版本') { await tab.click(); break }
    }
    await sleep(1500)
    // 版本详情要先选中一个版本
    await page.evaluate(() => { const row = document.querySelector('[data-dsh-studio] [data-release-row]'); if (row !== null) row.click() })
    await sleep(1200)
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('[data-dsh-studio] button')].find(node => (node.textContent || '').trim() === '删除')
      if (btn === undefined || btn.disabled === true) return false
      btn.click()
      return true
    })
    await sleep(900)
    const opened = await page.evaluate(() => document.querySelector('[data-dsh-studio-portal] [role="dialog"], [data-dsh-studio] [role="dialog"], [role="alertdialog"]') !== null)
    if (clicked === true && opened === true) {
      report.dialogs.opened += 1
      report.dialogs.names.push('删除版本确认框')
      const audit = await page.evaluate(collectAudit)
      report.dialogs.audits.push({ label: '删除版本确认框', contrastCount: audit.contrastCount, unnamedCount: audit.unnamedCount, contrast: audit.contrast.slice(0, 5), unnamed: audit.unnamed.slice(0, 5) })
    }
    await page.keyboard.press('Escape')
    await sleep(400)
  } catch (dialogError) {
    report.dialogs = { ...(report.dialogs ?? {}), error: String(dialogError?.message ?? dialogError).slice(0, 120) }
  }
} catch (error) {
  report.error = String(error?.message ?? error).slice(0, 200)
} finally {
  await browser.close()
}

// ---- 输出 ----
const allContrast = Object.entries(report.tabs).flatMap(([tab, data]) => (data.contrast ?? []).map(item => ({ tab, ...item })))
const allUnnamed = Object.entries(report.tabs).flatMap(([tab, data]) => (data.unnamed ?? []).map(item => ({ tab, ...item })))
console.log('== 对比度 ==')
console.log(allContrast.length === 0 ? 'ok   所有正文对比度都达到 WCAG AA' : `FAIL ${allContrast.length} 处低于 AA：`)
for (const item of allContrast.slice(0, 12)) console.log(`  [${item.tab}] ${item.ratio}:1（需 ${item.need}:1）${item.size}px ${item.color} on ${item.bg} —「${item.text}」`)
console.log('')
console.log('== 可访问名称 ==')
console.log(allUnnamed.length === 0 ? 'ok   每个交互元素都有名称' : `FAIL ${allUnnamed.length} 个没有名称：`)
for (const item of allUnnamed.slice(0, 8)) console.log(`  [${item.tab}] <${item.tag}> ${item.html}`)
console.log('')
console.log('== 键盘焦点 ==')
console.log(report.keyboard.invisible === 0 ? 'ok   焦点一路可见' : `FAIL ${report.keyboard.invisible} 次焦点不可见`)
console.log('  轨迹：' + (report.keyboard.trail ?? []).map(item => `${item.tag}${item.visible ? '' : '(无焦点环)'}`).join(' → '))
console.log('')
console.log('== 抽屉 ==')
console.log(`  present=${report.drawer.present} role=${report.drawer.role || '(无)'} 焦点进入=${report.drawer.inside} 圈内=${report.drawer.trapOk} 逃出 ${report.drawer.escaped} 次 Esc 关闭=${report.drawer.closedByEscape}`)
console.log('')
console.log('== 弹窗 ==')
const dialogContrast = (report.dialogs?.audits ?? []).reduce((sum, item) => sum + item.contrastCount, 0)
const dialogUnnamed = (report.dialogs?.audits ?? []).reduce((sum, item) => sum + item.unnamedCount, 0)
console.log(`  打开 ${report.dialogs?.opened ?? 0} 个弹窗（${(report.dialogs?.names ?? []).join('、') || '无'}）· 对比度不达标 ${dialogContrast} 处 · 无名称 ${dialogUnnamed} 个`)
console.log('')
console.log('== 重排 ==')
for (const item of report.reflow ?? []) {
  console.log(item.overflow <= 1
    ? `ok   ${item.label}：没有横向滚动`
    : `FAIL ${item.label}：横向溢出 ${item.overflow}px（最宽 ${item.widest?.tag ?? '?'} ${item.widest?.cls ?? ''} ${item.widest?.width ?? '?'}px）`)
}
console.log('')
console.log('== 减少动态效果 ==')
console.log(report.reducedMotion?.supported !== true
  ? 'FAIL 没找到可比对的元素'
  : report.reducedMotion.neutralized
    ? `ok   过渡 ${report.reducedMotion.transitionMs}ms · 动画 ${report.reducedMotion.animationMs}ms（已按系统设置关掉）`
    : `FAIL 过渡 ${report.reducedMotion.transitionMs}ms · 动画 ${report.reducedMotion.animationMs}ms（没关掉）`)
console.log('')
console.log('== pageerror ==', report.pageerrors.length === 0 ? 'ok 空' : report.pageerrors)
console.log('')
const summary = {
  theme: theme === '' ? 'current' : theme,
  contrast: allContrast.length,
  unnamed: allUnnamed.length,
  images: Object.values(report.tabs).reduce((sum, item) => sum + (item.imagesCount ?? 0), 0),
  focusInvisible: report.keyboard.invisible,
  drawer: report.drawer,
  reflow: report.reflow ?? [],
  reducedMotion: report.reducedMotion ?? null,
  dialogs: {
    opened: report.dialogs?.opened ?? 0,
    error: report.dialogs?.error ?? null,
    contrast: (report.dialogs?.audits ?? []).reduce((sum, item) => sum + item.contrastCount, 0),
    unnamed: (report.dialogs?.audits ?? []).reduce((sum, item) => sum + item.unnamedCount, 0),
  },
  error: report.error ?? null,
}
console.log(JSON.stringify(summary, null, 2))

/* 闸门只对自己"真的量到了"的东西负责：
   - 对比度 / 可访问名称 / 焦点 / 抽屉 / 重排 / 减少动态效果 —— 有数据就必须达标
   - 某一段因为页面状态没跑成（比如弹窗要点菜单），记为未覆盖，不假装通过也不误报失败
   这一段写死一点是故意的：无障碍闸门最容易变成"看着绿其实没测"。 */
const failures = []
if (summary.error !== null) failures.push('探针中断：' + summary.error)
if (summary.contrast > 0) failures.push(`对比度 ${summary.contrast} 处低于 AA`)
if (summary.unnamed > 0) failures.push(`${summary.unnamed} 个交互元素没有可访问名称`)
if (summary.focusInvisible > 0) failures.push(`${summary.focusInvisible} 次焦点不可见`)
if (summary.drawer?.present === true && summary.drawer.trapOk !== true) failures.push('抽屉焦点圈失效')
if (summary.drawer?.present === true && summary.drawer.closedByEscape !== true) failures.push('抽屉 Esc 关不掉')
const reflowBad = summary.reflow.filter(item => item.overflow > 1)
if (reflowBad.length > 0) failures.push(`重排横向溢出：${reflowBad.map(item => item.label + ' ' + item.overflow + 'px').join('、')}`)
if (summary.reducedMotion?.supported === true && summary.reducedMotion.neutralized !== true) failures.push('设置了减少动态效果但动画没关')
if (summary.dialogs.opened > 0 && (summary.dialogs.contrast > 0 || summary.dialogs.unnamed > 0)) failures.push(`弹窗里有 ${summary.dialogs.contrast} 处对比度不达标 / ${summary.dialogs.unnamed} 个无名称`)

console.log('')
console.log(failures.length === 0
  ? `无障碍巡检通过（${summary.theme}）：对比度 0 处 · 名称 0 缺失 · 焦点 0 次不可见 · 抽屉 ok · 重排 ok（${summary.reflow.length} 档） · 减少动态效果 ${summary.reducedMotion?.neutralized === true ? 'ok' : '未测到'} · 弹窗 ${summary.dialogs.opened > 0 ? `${summary.dialogs.opened} 个（零问题）` : '未覆盖'}`
  : `无障碍巡检不通过（${summary.theme}）：${failures.join('；')}`)
process.exit(failures.length === 0 ? 0 : 1)
