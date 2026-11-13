import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
const require = createRequire('file:///E:/deepseekWorkSpace/super-agents/dsh-studio/tools/visual/x.mjs')
const puppeteer = require('puppeteer-core')
const b = await puppeteer.launch({ executablePath: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1280, height: 900 } })
const p = await b.newPage()
await p.goto('http://192.168.120.218:18080/?token=FNkPqwuciBaKx2H7oeu7_vWi3CwrRS6NEUawmyE7tuU', { waitUntil: 'networkidle2', timeout: 60000 })
await new Promise(r => setTimeout(r, 3000))
const shot = await p.screenshot({ type: 'png' })
writeFileSync('E:/deepseekWorkSpace/super-agents/tools/visual/tmp/design-baseline.png', shot)
console.log('saved', shot.length)
await b.close()
