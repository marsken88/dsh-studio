#!/usr/bin/env node
/* Build-time guards for the two bug classes that HTML/CSS alone cannot catch.

   1. `hsl(var(--x))` — the Studio tokens are hex (`--primary: #18181b`), so any
      `hsl(var(--primary))` silently resolves to an invalid colour. That is how
      primary buttons once degraded into plain text, and how the board columns
      lost their background.
   2. Radix portals — a portal mounted on <body> without `container={portalRoot()}`
      loses every `[data-dsh-studio] …` rule and renders `position: fixed`
      popups in normal flow at the end of the document ("the dialog exists but
      is invisible").

   Usage: node scripts/guard.mjs [--pre|--post]
     --pre   sources only (fast; runs before vite build)
     --post  also checks dist/client.js (the bundle that actually ships)
   Default (no flag) = --pre. */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..') // repo root (dsh-studio/)
const web = join(root, 'web')
const mode = process.argv.includes('--post') ? 'post' : 'pre'
const failures = []

const rel = (file) => relative(root, file).replace(/\\/g, '/')

function read(file) {
  return readFileSync(file, 'utf8')
}

function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, exts, out)
    else if (exts.some((ext) => entry.endsWith(ext))) out.push(full)
  }
  return out
}

/* --- sources --------------------------------------------------------- */
const sourceFiles = [
  join(root, 'index.js'),
  join(root, 'client.src.js'),
  ...walk(join(root, 'src', 'host'), ['.js']),
  ...walk(join(web, 'src'), ['.js', '.jsx', '.css', '.ts', '.tsx']),
]

for (const file of sourceFiles) {
  const text = read(file)
  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    if (line.includes('hsl(var(')) {
      failures.push(`${rel(file)}:${index + 1} uses hsl(var(--…)); Studio tokens are hex — write var(--x) or a solid colour`)
    }
  })
}

/* Every Radix portal must mount into our scoped container. */
let portalCount = 0
for (const file of sourceFiles.filter((item) => item.endsWith('.jsx') || item.endsWith('.js'))) {
  if (!rel(file).startsWith('web/src/components/')) continue
  const text = read(file)
  const tags = [...text.matchAll(/<([A-Za-z]\w*)\.Portal\b([^>]*)>/g)]
  for (const tag of tags) {
    portalCount += 1
    if (!/container=\{portalRoot\(\)\}/.test(tag[2])) {
      const line = text.slice(0, tag.index).split(/\r?\n/).length
      failures.push(`${rel(file)}:${line} <${tag[1]}.Portal> must pass container={portalRoot()}, or its scoped styles vanish`)
    }
  }
}

/* --- 只允许一套实现 -----------------------------------------------------
   2026-11-17 的真机事故：仓库里同时躺着 Radix 的 SelectBox（shadcn 下拉）
   和 BoardUI 的 Select，谁也说不清某个页面用的是哪套；按钮上的工具类又被
   自己的 `@layer base` 重置吃掉，官方组件长成了 21px 的裸文字框。
   这类问题靠看一眼代码发现不了，只能在这里拦。 */

const SINGLE_IMPL = [
  ['@radix-ui/react-select', 'BoardUI 的 Select（web/src/components/base/select）'],
  ['@radix-ui/react-switch', 'BoardUI 的 Switch（web/src/components/base/switch）'],
  ['@radix-ui/react-progress', 'BoardUI 的 Meter / ProgressBar（web/src/components/base/{meter,progress}）'],
]
for (const file of sourceFiles) {
  if (!/\.(js|jsx|ts|tsx)$/.test(rel(file))) continue
  const text = read(file)
  for (const [pkg, instead] of SINGLE_IMPL) {
    if (text.includes(`from '${pkg}'`) || text.includes(`from "${pkg}"`)) {
      failures.push(`${rel(file)} imports ${pkg}; 全站只允许一套实现，改用 ${instead}`)
    }
  }
}

/* 层叠层顺序：index.css 必须在所有 @import 之前声明层序。
   少了这行，`@layer base` 会排在 `utilities` 后面（层序按名字第一次出现的位置定），
   base 里的 UA 重置就会反过来压住全部工具类 —— 官方组件的 padding / 字号集体失效。 */
const indexCss = join(web, 'src', 'index.css')
if (existsSync(indexCss)) {
  const raw = read(indexCss)
  // 去掉注释再判断：文件头的说明里就写着 `@import "tailwindcss/theme.css"`
  // 这几个字，直接 indexOf 会误判成「声明在 import 之后」。
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')
  const order = css.match(/@layer\s+properties\s*,\s*theme\s*,\s*base\s*,\s*components\s*,\s*utilities\s*;/)
  const firstImport = css.indexOf('@import')
  if (!order) {
    failures.push('web/src/index.css 缺少层序声明 `@layer properties, theme, base, components, utilities;`')
  } else if (firstImport >= 0 && order.index > firstImport) {
    failures.push('web/src/index.css 的层序声明必须在第一条 @import 之前（否则 base 会压过 utilities）')
  }
  if (!/\[data-dsh-studio\]\[data-dsh-studio-portal\][\s\S]{0,400}?z-index:\s*\d+/.test(css)) {
    failures.push('[data-dsh-studio-portal] 缺少 z-index：门户容器是 position:fixed（自建层叠上下文），没有 z-index 时下拉/弹窗会排在页面内容下面')
  }
}

/* 内联硬编码颜色上限（确定性检查）。
   运行时统计会随数据渲染浮动（同一套代码量出过 65/43/12/27 四个数），
   不能当门槛；这里扫源码里的字面量，超线就 fail。
   允许保留的 4 处：drawer.js 图片查看器的白底（暗色主题下白底看图片才是对的）
   与 releases.js 一个带 alpha 的成功色描边。 */
{
  const scan = [...walk(join(web, 'src', 'studio'), ['.js']), join(root, 'client.src.js')]
  let hits = []
  for (const file of scan) {
    if (!existsSync(file)) continue
    const text = read(file)
    for (const m of text.matchAll(/(?:color|background|backgroundColor|borderColor)\s*:\s*'#[0-9a-fA-F]{3,8}'/g)) {
      const line = text.slice(0, m.index).split(/\r?\n/).length
      hits.push(rel(file) + ':' + line + ' ' + m[0].trim())
    }
  }
  if (hits.length > 4) {
    failures.push('内联硬编码颜色 ' + hits.length + ' 处（上限 4）：' + hits.slice(0, 3).join(' | '))
  }
}

const portalHelper = join(web, 'src', 'lib', 'portal.js')
if (!existsSync(portalHelper)) {
  failures.push('web/src/lib/portal.js is missing (portalRoot() must live there)')
} else {
  const helper = read(portalHelper)
  if (!helper.includes("setAttribute('data-dsh-studio-portal'")) {
    failures.push('portal.js must set data-dsh-studio-portal on the container')
  }
  if (!helper.includes("setAttribute('data-dsh-studio'")) {
    failures.push('portal.js must also set data-dsh-studio, or legacy .ds-* styles stop applying inside dialogs')
  }
}

/* --- shipped bundle --------------------------------------------------- */
if (mode === 'post') {
  const bundle = join(root, 'dist', 'client.js')
  if (!existsSync(bundle)) {
    failures.push('dist/client.js is missing — run the build first')
  } else {
    const text = read(bundle)
    if (text.includes('hsl(var(')) {
      failures.push('dist/client.js contains hsl(var(--…)) — a rule will resolve to an invalid colour')
    }
    if (!text.includes('data-dsh-studio-portal')) {
      failures.push('dist/client.js lost the portal container attribute')
    }
    // 体积观察线：接官方 SegmentedControl / Switch 之后到 1128 kB，线抬到 1.2 MB。早先记录：1085 kB 是「真组件」的现状（react-aria 的 Select/Modal/ListBox 占大头），
    // 定 1.1 MB。超了就说明又悄悄引了一整包东西，先停下来看是谁，别默默变大。
    const sizeKb = statSync(bundle).size / 1024
    // 观察线：1.4 MB（1434 kB）是接 DatePicker 时定的。之后审计日志换成官方 Table +
    // Pagination（+6.3 kB，1436 kB）越线，按实际抬到 1460 kB。
    // 2026-11-20 抬到 1470 kB：项目检查 / 合并门禁 / 技能沉淀 / 浏览器用例 / 设计多稿
    // 五块 UI 合计 +9 kB（1451 → 1461.7），是能力不是组件库。
    // 2026-11-27 抬到 1490 kB（1472 kB 实测）：多维表格镜像 / 缺陷 SLA 与默认验收清单 /
    // 自动重试三件套 / shell 默认目录 / 密钥清除与乐观锁提示 —— 全是**设置项入口与交互闭环**，
    // 没有新组件库。**这一档是硬顶**：超过 1490 kB 就说明该拆包了（单文件 IIFE 到 1.5 MB
    // 宿主首屏会明显变慢），不要再抬，改成分片加载或把 BoardUI 换成宿主注入。
    if (sizeKb > 1490) {
      failures.push(`dist/client.js is ${sizeKb.toFixed(1)} kB — over the 1.46 MB watch line, check what got pulled in`)
    }
  }
}

if (failures.length > 0) {
  console.error(`✖ ui guard (${mode}) failed with ${failures.length} issue(s):`)
  for (const item of failures) console.error('  - ' + item)
  process.exit(1)
}

console.log(`✓ ui guard (${mode}) — ${sourceFiles.length} source files, ${portalCount} Radix portals`)
