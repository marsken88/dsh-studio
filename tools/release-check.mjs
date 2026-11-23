#!/usr/bin/env node
/* 发版前自检：文档有没有跟上代码。
 *
 *   node tools/release-check.mjs          # 本地跑
 *   npm run release:check
 *
 * 检查两件事：
 *   A. **一致性**：CHANGELOG 有没有当前版本的条目、docs/compatibility.md 的版本号是否等于
 *      package.json、README 里提到的探针脚本是否都真的存在。
 *   B. **新鲜度**：从上一个 tag 到现在，如果代码改了（index.js / client.src.js / web/src/**）
 *      但 README.md 没改 —— 直接失败。这条是「发布前必须更新 README」的可执行版本，
 *      不再依赖人和 AI 记得。
 *
 * 为什么需要 B：0.2.0~0.2.3 连着发四版，README 里还写着旧行为（安全边界、发版流程、
 * 探针清单全没有），版本号在三处文档里各说各的。那种情况下所有检查都是绿的。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const problems = []
const notes = []
const read = (path) => readFileSync(path, 'utf8')
const git = (argv) => execFileSync('git', argv, { encoding: 'utf8' }).trim()

const pkg = JSON.parse(read('package.json'))
const version = String(pkg.version)

/* ── A1. CHANGELOG 有当前版本条目 ────────────────────────────────────── */
if (!existsSync('CHANGELOG.md')) problems.push('CHANGELOG.md 不存在')
else if (!new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(read('CHANGELOG.md'))) {
  problems.push(`CHANGELOG.md 里没有 ${version} 的条目（每个版本都要一条，只写用户能感知的变化）`)
} else notes.push(`CHANGELOG 有 ${version}`)

/* ── A2. compatibility.md 版本号一致 ────────────────────────────────── */
if (existsSync('docs/compatibility.md')) {
  const compat = read('docs/compatibility.md')
  if (!compat.includes(`version: ${version}`)) {
    problems.push(`docs/compatibility.md 的版本号不是 ${version}（找到：${(compat.match(/version: [\d.]+/) ?? ['无'])[0]}）`)
  } else notes.push(`compatibility 版本号 ${version}`)
} else problems.push('docs/compatibility.md 不存在')

/* ── A3. README 里写的 npm 脚本都存在 ──────────────────────────────── */
const scripts = pkg.scripts ?? {}
const named = [...read('README.md').matchAll(/`npm run ([a-z:-]+[a-z])`/g)].map((m) => m[1])
const missing = [...new Set(named)].filter((name) => scripts[name] === undefined)
if (missing.length > 0) problems.push(`README 提到但 package.json 里没有的脚本：${missing.join('、')}`)
else notes.push(`README 提到的 ${new Set(named).size} 个脚本都存在`)

/* ── B. 代码改了、README 没改 ───────────────────────────────────────── */
const CODE_PATHS = ['index.js', 'client.src.js', 'src/host', 'web/src']
const DOC_PATHS = ['README.md', 'CHANGELOG.md', 'docs']
let lastTag = ''
try { lastTag = git(['describe', '--tags', '--abbrev=0']) } catch { lastTag = '' }

if (lastTag === '') {
  notes.push('没有上一个 tag，跳过「代码改了文档没改」检查')
} else {
  const committed = git(['diff', '--name-only', `${lastTag}..HEAD`]).split('\n').filter(Boolean)
  // 还要算上未提交的改动：文档常常是在构建/测试后才写，只看 HEAD 会误判成「没改文档」
  const working = git(['status', '--porcelain']).split('\n').filter(Boolean).map((line) => line.slice(3).trim())
  const changed = [...new Set([...committed, ...working])]
  const codeTouched = changed.filter((file) => CODE_PATHS.some((prefix) => file === prefix || file.startsWith(prefix + '/')))
  const docTouched = changed.filter((file) => DOC_PATHS.some((prefix) => file === prefix || file.startsWith(prefix + '/')))
  if (codeTouched.length > 0 && docTouched.length === 0) {
    problems.push(
      `自 ${lastTag} 以来改了 ${codeTouched.length} 个代码文件，但 README/CHANGELOG/docs 一个字都没动。\n` +
      `     这次发布涉及：${codeTouched.slice(0, 5).join('、')}${codeTouched.length > 5 ? ' 等' : ''}\n` +
      '     用户看的是 README 和 npm 页面 —— 先把「变了什么」写进去，再发版。',
    )
  } else if (codeTouched.length > 0) {
    notes.push(`自 ${lastTag} 以来改了 ${codeTouched.length} 个代码文件，文档也同步改了 ${docTouched.length} 个`)
  } else {
    notes.push(`自 ${lastTag} 以来没有代码改动`)
  }
}

/* ── D. 真机探针（--probes）────────────────────────────────────────────
   打 tag 之前先在真机上跑一遍关键探针：接口类改动最容易「本地测试全绿、发出去才发现
   面板坏了」（0.3.1 就是这么把「保存角色模板」打成 400 的）。CI 里没有部署和 token，
   所以默认不跑，只在本地发版前用 npm run release:preflight。 */
/* ── 镜像改写演练（每次都跑）────────────────────────────────────────
   GitHub Packages 的镜像 workflow 只在打 tag 时才跑，改坏了要等 tag 之后才知道
   （0.9.3 那次就是：产物里没有写死的注册名了，镜像还在做字符串替换 → 整条失败）。 */
try {
  const out = execFileSync(process.execPath, ['tools/mirror-dry-run.mjs'], { encoding: 'utf8' })
  notes.push('mirror-dry-run — ' + (out.trim().split('\n').pop() ?? ''))
} catch (error) {
  const out = String(error.stdout ?? '')
  problems.push('镜像改写演练失败：' + (out.trim().split('\n').pop() ?? String(error.message).slice(0, 160)))
}

/* ── TDZ 扫描（每次都跑）────────────────────────────────────────────
   "同作用域内先用后声明" 在浏览器里是 `Cannot access 'x' before initialization`，
   而 node --check 与契约测试都看不见（issue #6：空看板第一行就读了还没初始化的 filtering，
   平时靠 && 短路侥幸不触发）。这条扫描只要毫秒。 */
try {
  const out = execFileSync(process.execPath, ['tools/tdz-scan.mjs'], { encoding: 'utf8' })
  notes.push('tdz-scan — ' + (out.trim().split('\n').pop() ?? ''))
} catch (error) {
  const out = String(error.stdout ?? '')
  const detail = out.trim().split('\n').filter(line => line.includes('之前就被用了')).join(' | ')
  problems.push('TDZ 扫描失败：' + (detail || String(error.message).slice(0, 160)))
}

/* ── 打包后自检（每次都跑）──────────────────────────────────────────
   为什么放在这里而不是只在 CI：0.5.1 那次「装完不加载」的根因在 tarball 里才看得见，
   而当时所有校验都在源码树上做。这条不通过，后面写多少文档都没意义。 */
try {
  const out = execFileSync(process.execPath, ['tools/pack-check.mjs'], { encoding: 'utf8' })
  const last = out.trim().split('\n').pop() ?? ''
  notes.push('pack-check — ' + last)
} catch (error) {
  const out = String(error.stdout ?? '')
  const detail = out.trim().split('\n').filter(line => line.startsWith('FAIL')).join(' | ')
  problems.push('打包后自检失败：' + (detail || String(error.message).slice(0, 160)))
}

const wantProbes = process.argv.includes('--probes')
if (wantProbes) {
  const token = String(process.env.STUDIO_TOKEN ?? '').trim()
  if (token === '') {
    problems.push('--probes 需要 STUDIO_TOKEN（先在目标机上取一个），否则只能在 CI 里跑离线检查')
  } else {
    if (String(process.env.STUDIO_BASE ?? '').trim() === '') {
      problems.push('--probes 现在还会跑用例库探针，需要 STUDIO_BASE（例：STUDIO_BASE=http://192.168.120.218:18080），不猜默认地址免得打到别的机器上')
    }
    const probes = ['tools/visual/pages-probe.mjs', 'tools/visual/toast-probe.mjs', 'tools/visual/drawer-probe.mjs', 'tools/visual/cases-probe.mjs', 'tools/visual/tiers-probe.mjs', 'tools/visual/a11y-probe.mjs', 'tools/visual/empty-state-probe.mjs']
    /* 真机功能巡检。2026-11-23 的教训：假宿主夹具数据太简单，
       「设置页四个面板 PANE is not defined」这种崩只有真数据才暴露，
       而它一路过了 npm test、verify:pages，发到目标机才被 verify:sweep 抓到。
       所以发版前固定跑这几支（都要 STUDIO_TOKEN，缺失时本函数已经提前拒了）。 */
    const realHostProbes = ['tools/visual/smoke.mjs', 'tools/visual/sweep.mjs']
    probes.push(...realHostProbes)
    for (const probe of probes) {
      try {
        const out = execFileSync(process.execPath, [probe], { encoding: 'utf8', env: process.env })
        const last = out.trim().split('\n').pop() ?? ''
        notes.push(`${probe.split('/').pop()} — ${last}`)
      } catch (error) {
        const out = String(error.stdout ?? '')
        const last = out.trim().split('\n').filter(Boolean).slice(-2).join(' | ')
        problems.push(`真机探针失败：${probe} — ${last.slice(0, 200)}`)
      }
    }
  }
}

/* ── 输出 ───────────────────────────────────────────────────────────── */
for (const note of notes) console.log(`ok    ${note}`)
for (const problem of problems) console.log(`FAIL  ${problem}`)

if (problems.length > 0) {
  console.log(`\n发版自检不通过（${problems.length} 项）。修完再打 tag —— 顺序是：改代码 → 改文档 → npm test → 构建 → 提交 → 打 tag。`)
  process.exit(1)
}
console.log(`\n发版自检通过（${notes.length} 项）。`)
