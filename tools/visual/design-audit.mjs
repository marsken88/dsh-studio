#!/usr/bin/env node
/**
 * 设计规范体检：把页面里**实际用到的**字号 / 间距 / 圆角 / 颜色抓出来，
 * 和一份 design-tokens.json 比对，列出「野值」（不在规范里的值）。
 *
 * 用法：
 *   node tools/visual/design-audit.mjs --url <页面> [--spec design-tokens.json] [--out report.json]
 *
 * 规范文件缺省时用内置的一套（够用来发现 13px/7px 这类偷偷加的值）。仓库根可以放一份真的覆盖掉。
 * 输出：{ checked, violations: [{ kind, value, count, allowed }], summary }
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf('--' + name)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}
const url = option('url', '')
const specPath = option('spec', 'design-tokens.json')
const out = option('out', '')
if (url === '') {
  console.error('缺少参数：--url <页面地址>')
  process.exit(2)
}

const DEFAULT_SPEC = {
  fontSize: ['12px', '13px', '14px', '16px', '18px', '20px', '24px', '28px', '32px'],
  radius: ['0px', '2px', '4px', '6px', '8px', '10px', '12px', '999px'],
  spacing: ['0px', '2px', '4px', '6px', '8px', '10px', '12px', '14px', '16px', '20px', '24px', '32px'],
}
const spec = existsSync(specPath) ? { ...DEFAULT_SPEC, ...JSON.parse(readFileSync(specPath, 'utf8')) } : DEFAULT_SPEC

let puppeteer
try {
  puppeteer = require('puppeteer-core')
} catch {
  console.error('需要依赖：pnpm add -D puppeteer-core')
  process.exit(2)
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width: Number(option('width', '1440')), height: Number(option('height', '900')) },
})
const page = await browser.newPage()
await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 })
await new Promise(resolve => setTimeout(resolve, 1500))
const collected = await page.evaluate(() => {
  const fonts = new Map()
  const radii = new Map()
  const spacing = new Map()
  let checked = 0
  const bump = (map, value) => { if (value === '') return; map.set(value, (map.get(value) ?? 0) + 1) }
  for (const el of document.querySelectorAll('*')) {
    const style = window.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    const box = el.getBoundingClientRect()
    if (box.width === 0 && box.height === 0) continue
    checked += 1
    bump(fonts, style.fontSize)
    bump(radii, style.borderRadius)
    for (const key of ['marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'gap']) {
      const value = style[key]
      if (value === 'normal' || value === 'auto') continue
      bump(spacing, value)
    }
  }
  const toList = map => [...map.entries()].map(([value, count]) => ({ value, count }))
  return { checked, fonts: toList(fonts), radii: toList(radii), spacing: toList(spacing) }
})
await browser.close()

const violations = []
for (const [kind, key] of [['fontSize', 'fonts'], ['radius', 'radii'], ['spacing', 'spacing']]) {
  const allowed = (spec[kind] ?? []).map(String)
  for (const item of collected[key]) {
    if (allowed.length > 0 && !allowed.includes(item.value)) violations.push({ kind, value: item.value, count: item.count, allowed })
  }
}
violations.sort((a, b) => b.count - a.count)
const report = {
  url,
  checked: collected.checked,
  summary: {
    fontSize: collected.fonts.length,
    radius: collected.radii.length,
    spacing: collected.spacing.length,
    violations: violations.length,
  },
  violations: violations.slice(0, 40),
}
if (out !== '') writeFileSync(out, JSON.stringify(report, null, 1))
console.log(JSON.stringify(report, null, 1).slice(0, 1500))
