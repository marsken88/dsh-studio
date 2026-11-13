#!/usr/bin/env node
/**
 * 设计还原度：把设计稿和实现页面截图的差异算成一个百分比。
 *
 * 用法：
 *   node tools/visual/design-diff.mjs --url <页面地址> --design <设计稿.png> [--out diff.png] [--width 1280 --height 900]
 *
 * 两个前提，写清楚免得白跑：
 *   1) 设计稿必须是**同尺寸**的 PNG（宽度/高度和截图一致），工具不做缩放。
 *   2) 需要 puppeteer-core（devDependency）+ 一个系统 Chrome（CHROME_PATH 可指定）。
 *
 * 输出：{ percent, changed, total, out } —— percent 是差异像素占比（保留两位小数）。
 * 退出码：0 永远成功；差异大不大由调用方判断（比如 >5% 就算没还原）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf('--' + name)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}
const url = option('url', '')
const designPath = option('design', '')
const out = option('out', '')
const width = Number(option('width', '1280'))
const height = Number(option('height', '900'))
if (url === '' || designPath === '') {
  console.error('缺少参数：--url <页面地址> --design <设计稿.png>')
  process.exit(2)
}

let puppeteer
let PNG
let pixelmatch
try {
  puppeteer = require('puppeteer-core')
  ;({ PNG } = require('pngjs'))
  // pixelmatch v6 是纯 ESM，只能 import()；pngjs 还是 CJS。
  pixelmatch = (await import('pixelmatch')).default
} catch (error) {
  console.error('需要依赖：pnpm add -D puppeteer-core pngjs pixelmatch ——', error?.message ?? error)
  process.exit(2)
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width, height },
})
const page = await browser.newPage()
await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 })
await new Promise(resolve => setTimeout(resolve, 1500))
const shot = await page.screenshot({ type: 'png' })
await browser.close()

const mine = PNG.sync.read(Buffer.from(shot))
const design = PNG.sync.read(readFileSync(designPath))
if (mine.width !== design.width || mine.height !== design.height) {
  console.error(`尺寸不一致：页面 ${mine.width}x${mine.height}，设计稿 ${design.width}x${design.height}。请先统一尺寸（工具不缩放）。`)
  process.exit(2)
}
const diff = new PNG({ width: mine.width, height: mine.height })
const changed = pixelmatch(mine.data, design.data, diff.data, mine.width, mine.height, { threshold: 0.12 })
const total = mine.width * mine.height
const percent = Math.round((changed / total) * 10000) / 100
if (out !== '') writeFileSync(out, PNG.sync.write(diff))
console.log(JSON.stringify({ percent, changed, total, out: out === '' ? null : pathToFileURL(out).pathname }))
