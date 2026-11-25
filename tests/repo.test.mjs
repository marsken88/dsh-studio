test('host: imported bindings are never assigned to', () => {
  const files = ['index.js', ...readdirSync('src/host').filter(f => f.endsWith('.js')).map(f => 'src/host/' + f)]
  const offenders = []
  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    const imported = new Set()
    for (const m of src.matchAll(/import\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()
        if (name) imported.add(name)
      }
    }
    for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) imported.add(m[1])
    for (const line of src.split(/\r?\n/)) {
      const assign = line.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:=(?![=>])|\+\+|--)/)
      const shadowed = assign !== null && new RegExp('(?:const|let|var|function|class)\\s+' + assign[1] + '\\b').test(src)
      if (assign && imported.has(assign[1]) && !shadowed) offenders.push(`${file}: ${line.trim().slice(0, 80)}`)
    }
  }
  assert.deepEqual(offenders, [], 'assigning to an imported binding throws "Assignment to constant variable" at runtime')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const path = (p) => join(ROOT, p)
const read = (p) => readFileSync(path(p), 'utf8')
const bytes = (p) => readFileSync(path(p))
const sha = (p) => createHash('sha256').update(bytes(p)).digest('hex')
const manifest = JSON.parse(read('package.json'))
const hostSources = [
  'index.js',
  ...readdirSync(path('src/host')).filter((name) => name.endsWith('.js')).map((name) => 'src/host/' + name),
  ...readdirSync(path('src/host/routes')).filter((name) => name.endsWith('.js')).map((name) => 'src/host/routes/' + name),
]
const hostText = hostSources.map((file) => read(file)).join('\n')

test('manifest: entry points exist and resolve', () => {
  for (const [key, value] of Object.entries(manifest.exports)) {
    if (value.includes('*')) continue
    assert.ok(existsSync(path(value)), `exports["${key}"] -> ${value} is missing`)
  }
  assert.equal(manifest.main, 'index.js')
  assert.ok(existsSync(path(manifest.main)))
})

test('manifest: dsh bundle patch and client declaration are present', () => {
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok(existsSync(path('cordis.patch.yml')), 'cordis.patch.yml missing')
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.equal(manifest.exports['./client'], './client.js')
})

test('manifest: bundle patch mounts the package by its real npm name', async () => {
  // issue（2026-11-19）：cordis.patch.yml 里写的是裸名 dsh-studio，而 npm 包叫
  // @marsken/dsh-studio。加载器把 name 当模块说明符去 profile 的 node_modules 里解析，
  // 于是从市场/NPM 装的人 100% 得到 ERR_MODULE_NOT_FOUND（Cannot find package 'dsh-studio'）。
  // 这条测试盯的就是「patch 里的名字必须和 package.json 一致」，含 scope。
  const { readFileSync } = await import('node:fs')
  const yml = readFileSync(path('cordis.patch.yml'), 'utf8')
  const names = [...yml.matchAll(/^\s+name:\s*"?([^"\n]+)"?\s*$/gm)].map(match => match[1].trim())
  assert.ok(names.length > 0, 'cordis.patch.yml 里没有 name 行')
  for (const name of names) {
    assert.equal(name, manifest.name, `patch 里的 name（${name}）必须等于 package.json 的 name（${manifest.name}）`)
  }
  const ids = [...yml.matchAll(/^\s+-\s*id:\s*(.+)$/gm)].map(match => match[1].trim())
  assert.ok(ids.length > 0, 'patch 里缺少 id（profile 内标识）')
})

test('manifest: files whitelist covers every shipped artifact', () => {
  const required = ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'AGENTS.md', 'dist/client.js', 'client.src.js']
  for (const entry of required) assert.ok(manifest.files.includes(entry), `files[] is missing ${entry}`)
  assert.ok(manifest.files.includes('locale/*.json'))
  assert.ok(manifest.files.includes('docs/*.md'))
})

test('manifest: dsh engine range and compatibility matrix are declared', () => {
  assert.match(String(manifest.engines?.dsh ?? ''), /0\.2\.2-rc\.1/)
  const releases = manifest.dsh?.compatibility?.dshReleases ?? {}
  assert.ok(Object.keys(releases).length > 0, 'dsh.compatibility.dshReleases must not be empty')
})

test('bundle: package root client.js is the built artifact', () => {
  assert.ok(statSync(path('client.js')).size > 300_000, 'root client.js looks like source, not the bundle')
  assert.equal(sha('client.js'), sha('dist/client.js'), 'root client.js drifted from dist/client.js — run `pnpm build` in web/')
})

test('bundle: client half registers through the harness module loader', () => {
  const bundle = read('client.js')
  assert.ok(bundle.includes('__ModuleLoader__.load('), 'bundle does not call __ModuleLoader__.load')
  // 注册 id 必须是运行时推导的（写死短名/写死包名都会在另一种安装方式下失效，issue #3）
  assert.ok(bundle.includes("/plugins/"), "bundle 应该从自己的 script 地址推导模块 id")
  assert.ok(bundle.includes('"react"') && bundle.includes('"react-dom"'), 'bundle must require the host React, not ship its own')
  assert.ok(!bundle.includes('@deepseek-ai/'), 'bundle must not import @deepseek-ai packages directly')
})

test('host: apply/inject contract', () => {
  const host = read('index.js')
  assert.match(host, /export function apply\(ctx\)/)
  assert.match(host, /export const inject = \[[^\]]*'tools'[^\]]*\]/)
  assert.match(host, /export const inject = \[[^\]]*'systemPrompt'[^\]]*\]/)
  assert.ok(host.includes("kind: 'prefix'") && host.includes('/studio-api'), 'web routes must mount under /studio-api')
})

test('host: studio tools are registered once each', () => {
  const names = [...hostText.matchAll(/name:\s*'(studio_[a-z_]+)'/g)].map((m) => m[1])
  assert.ok(names.length >= 30, `expected at least 30 studio tools, found ${names.length}`)
  assert.equal(new Set(names).size, names.length, 'duplicate studio tool name')
})

test('client: heavy helpers live in web/src/studio and client.src.js ratchets down', () => {
  for (const file of ['web/src/studio/markdown.js', 'web/src/studio/format.js', 'web/src/studio/labels.js', 'web/src/studio/roster.js', 'web/src/studio/fields.js', 'web/src/studio/shell.js', 'web/src/studio/card.js', 'web/src/studio/board.js']) {
    assert.ok(existsSync(path(file)), file + ' missing')
  }
  const lines = read('client.src.js').split(/\r?\n/).length
  assert.ok(lines < 2500, 'client.src.js is ' + lines + ' lines; keep lifting helpers into web/src/studio')
  const maker = read('web/scripts/make-legacy.mjs')
  for (const spec of ['./studio/markdown.js', './studio/format.js', './studio/labels.js', './studio/roster.js', './studio/fields.js', './studio/shell.js', './studio/card.js', './studio/board.js']) {
    assert.ok(maker.includes(spec), 'make-legacy must keep importing ' + spec)
  }
  const legacy = read('web/src/legacy.js')
  for (const spec of ['./studio/markdown.js', './studio/format.js', './studio/labels.js', './studio/roster.js']) {
    assert.ok(legacy.includes(spec), 'generated legacy module lost ' + spec)
  }
})
test('client: modules under web/src/studio do not call helpers left behind in client.src.js', () => {
  const strip = (code) => code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\u0060(?:\\[\s\S]|[^\u0060\\])*\u0060/g, ' ')
    .replace(/'(?:\\[\s\S]|[^'\\])*'/g, ' ')
    .replace(/"(?:\\[\s\S]|[^"\\])*"/g, ' ')
  const client = strip(read('client.src.js'))
  const declared = new Set([...client.matchAll(/^\s*function ([A-Za-z_$][\w$]*)\(/gm)].map((m) => m[1]))
  const walk = (dir) =>
    readdirSync(path(dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(dir + '/' + entry.name)
        : entry.name.endsWith('.js') ? [dir + '/' + entry.name] : [])
  const modules = walk('web/src/studio')
  const offenders = new Set()
  for (const name of modules) {
    const code = strip(read(name))
    const local = new Set([
      ...[...code.matchAll(/function ([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]),
      ...[...code.matchAll(/const ([A-Za-z_$][\w$]*) =/g)].map((m) => m[1]),
      ...[...code.matchAll(/import \{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((part) => part.trim().split(/\s+as\s+/).pop())),
      ...[...code.matchAll(/export function create\w+\(\{([^}]*)\}\)/g)].flatMap((m) => m[1].split(',').map((part) => part.trim())),
      ...[...code.matchAll(/export function create\w+\(([^){]*)\)/g)].flatMap((m) => m[1].split(',').map((part) => part.trim()).filter((part) => part !== '')),
      ...[...code.matchAll(/const \{([^}]*)\} = client\(\)/g)].flatMap((m) => m[1].split(',').map((part) => part.trim()).filter((part) => part !== '')),
      'createFields', 'createSideDrawer', 'createMarkdown',
    ])
    for (const match of code.matchAll(/(?<![\w$.#])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const called = match[1]
      if (declared.has(called) && !local.has(called)) offenders.add(name + ' calls ' + called)
    }
  }
  assert.deepEqual([...offenders], [], 'moved module calls a helper that still lives in client.src.js')
})

test('client: every studio export used by client.src.js is imported back by make-legacy', () => {
  const client = read('client.src.js')
  const maker = read('web/scripts/make-legacy.mjs')
  const walk = (dir) =>
    readdirSync(path(dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(dir + '/' + entry.name)
        : entry.name.endsWith('.js') ? [dir + '/' + entry.name] : [])
  const modules = walk('web/src/studio')
  const missing = []
  for (const name of modules) {
    const code = read(name)
    const relative = name.replace('web/src/studio/', '')
    const exports = [...code.matchAll(/export (?:async )?(?:function|const) ([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
    const line = maker.split(/\r?\n/).find((entry) => entry.includes("./studio/" + relative)) ?? ''
    for (const symbol of exports) {
      const used = new RegExp('(?<![\\w$.#])' + symbol + '\\s*\\(').test(client)
      if (used && !line.includes(symbol)) missing.push(name + ' exports ' + symbol + ' but make-legacy does not import it')
    }
  }
  assert.deepEqual(missing, [], 'client.src.js calls a studio export that is never imported into the generated module')
})

const stripCode = (code) => code
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ')
  .replace(/\u0060(?:\\[\s\S]|[^\u0060\\\n])*\u0060/g, ' ')
  .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, ' ')
  .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, ' ')

test('client: studio modules only use names they declare, import or receive', () => {
  // Names owned by client.src.js are collected from the raw source: stripping string
  // literals first used to swallow whole regions and hide real offenders.
  const clientRaw = read('client.src.js').replace(/^[ \t]*\/\/[^\n]*$/gm, '')
  const clientNames = new Set([
    ...[...clientRaw.matchAll(/^ {0,4}(?:async )?function ([A-Za-z_$][\w$]*)\(/gm)].map((m) => m[1]),
    ...[...clientRaw.matchAll(/^ {0,4}(?:const|let) ([A-Za-z_$][\w$]*) =/gm)].map((m) => m[1]),
  ])
  const walk = (dir) =>
    readdirSync(path(dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(dir + '/' + entry.name)
        : entry.name.endsWith('.js') ? [dir + '/' + entry.name] : [])
  const modules = walk('web/src/studio')
  const exportOwner = new Map()
  for (const name of modules) {
    const code = stripCode(read(name))
    for (const match of code.matchAll(/export (?:async )?(?:function|const) ([A-Za-z_$][\w$]*)/g)) {
      exportOwner.set(match[1], name)
    }
  }
  const provided = new Set([
    ...[...clientRaw.matchAll(/const \{([^}]*)\} = create\w+\(/g)].flatMap((m) =>
      m[1].split(',').map((part) => part.trim().split(':').pop().trim()).filter((part) => part !== ''),
    ),
  ])
  const known = new Set([...clientNames, ...exportOwner.keys(), ...provided])
  const offenders = new Set()
  for (const name of modules) {
    const rawCode = read(name).replace(/^\s*\/\/.*$/gm, ' ')
    const code = stripCode(rawCode)
    const own = new Set([
      ...[...rawCode.matchAll(/(?:function|const|let|var) ([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
      ...[...rawCode.matchAll(/import \{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((part) => part.trim().split(/\s+as\s+/).pop())),
      ...[...rawCode.matchAll(/export function create\w+\(\{([^}]*)\}\)/g)].flatMap((m) => m[1].split(',').map((part) => part.trim())),
      ...[...rawCode.matchAll(/export function create\w+\(([^){]*)\)/g)].flatMap((m) => m[1].split(',').map((part) => part.trim()).filter((part) => part !== '')),
      // 从 client() 或自己收到的 ctx 解构出来的名字都算「已有」
      ...[...rawCode.matchAll(/const \{([^}]*)\} = [A-Za-z_$][\w$]*(?:\([^)]*\))?/g)].flatMap((m) => m[1].split(',').map((part) => part.trim().split(':').pop().trim()).filter((part) => part !== '')),
    ])
    const check = (used) => {
      if (!known.has(used) || own.has(used)) return
      if (exportOwner.get(used) === name) return
      offenders.add(name + ' uses ' + used + ' (declared in ' + (exportOwner.get(used) ?? 'client.src.js') + ')')
    }
    for (const match of code.matchAll(/(?<![\w$.#])([A-Za-z_$][\w$]*)\s*\(/g)) check(match[1])
    for (const match of code.matchAll(/h\(\s*([A-Z][\w$]*)/g)) check(match[1])
  }
  assert.deepEqual([...offenders], [], 'studio module uses a name it never declared, imported or received')
  /* 工厂里的 `const API = '/studio-api'` 不在模块作用域里：面板要拼下载地址（CSV 导出）
     必须从 client() 拿 apiBase。2026-11-21 实测：审计/派单两个导出写 `${API}`，
     点击抛 ReferenceError，而上面那条 allowlist 把它当成「client.src.js 声明过」放行了。 */
  const bareApi = modules.filter((name) => /(?<![\w$.])API(?![\w$])/.test(stripCode(read(name))))
  assert.deepEqual(bareApi, [], 'studio modules must use apiBase from client(), not the factory-local API')
})

test('ui: settings panes that exist are reachable from the nav', () => {
  const source = read('client.src.js')
  /* 2026-11-21：paneFor 里有 models 分支、导航数组却没有它 —— 面板写好了永远打不开。
     verify:audit 会真点每个面板，这里再加一条便宜的兜底。
     2026-11-25：「角色模板 / 角色与模型」已删（专家是模型与提示词的唯一来源），
     这里反过来守一条 —— 导航里不该再出现 models。 */
  assert.doesNotMatch(source, /id: 'models'/, '角色与模型面板已删，导航里不该再有 models')
  for (const id of ['docs']) {
    assert.match(source, new RegExp("\\{ id: '" + id + "', label: "), 'settings nav is missing ' + id)
  }
})

test('ui: build-time guard rejects hsl(var( and unscoped portals', () => {
  const out = execFileSync(process.execPath, ['web/scripts/guard.mjs', '--pre'], { cwd: ROOT, encoding: 'utf8' })
  assert.match(out, /ui guard \(pre\)/)
  assert.match(out, /6 Radix portals|Radix portals/)
})
test('host: no model is hardcoded to a channel-less default', () => {
  for (const file of hostSources) {
    assert.ok(!/model:\s*'deepseek-v4-pro'|model:\s*"deepseek-v4-pro"/.test(read(file)), `${file} still assigns deepseek-v4-pro (503 No available channel)`)
  }
  assert.ok(hostText.includes('FALLBACK_AGENT_MODEL'), 'FALLBACK_AGENT_MODEL guard is missing')
})

test('host: export routes live in a module and are wired', () => {
  const index = readFileSync('index.js', 'utf8')
  const mod = readFileSync('src/host/routes/exports.js', 'utf8')
  assert.ok(index.includes("from './src/host/routes/exports.js'"), 'index.js imports the export routes module')
  assert.ok(index.includes('configureExportRoutes({'), 'index.js injects sendCsv/requirementProgress/sessions')
  assert.ok(!index.includes("route === '/export/tasks.csv'"), 'the CSV handlers moved out of index.js')
  assert.ok(mod.includes('export function handleExportRoute('), 'module exposes the handler')
})

test('host: auth routes live in a module and are wired', () => {
  const index = readFileSync('index.js', 'utf8')
  const mod = readFileSync('src/host/routes/auth.js', 'utf8')
  assert.ok(index.includes("from './src/host/routes/auth.js'"), 'index.js imports the auth routes module')
  assert.ok(index.includes('configureAuthRoutes({'), 'index.js injects session helpers')
  assert.ok(!index.includes("route === '/auth/login'"), 'the login handler moved out of index.js')
  assert.ok(mod.includes('export async function handleAuthRoute('), 'module exposes the handler')
  assert.ok(/return true/.test(mod), 'handled branches return true so the dispatcher stops')
})

test('host: domain layer lives in src/host and stays out of index.js', () => {
  assert.ok(existsSync(path('src/host/domain.js')), 'src/host/domain.js missing')
  const domain = read('src/host/domain.js')
  assert.ok(domain.includes('export const STATUSES'), 'domain must export the board columns')
  assert.ok(domain.includes('export function sanitizeRequirement('), 'domain must export requirement sanitizing')
  const index = read('index.js')
  assert.ok(index.includes("from './src/host/domain.js'"), 'index.js must import the domain layer')
  assert.ok(!/^function sanitizeRequirement\(/m.test(index), 'sanitizeRequirement must not be re-declared in index.js')
  const lines = index.split(/\r?\n/).length
  assert.ok(lines < 2700, `index.js is still ${lines} lines; keep splitting by domain`)
})

test('host: index.js imports every domain symbol it uses', () => {
  const domain = read('src/host/domain.js')
  const exported = [...domain.matchAll(/^export\s+(?:async\s+function|function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])
  const index = read('index.js')
  const blockLine = index.split(/\r?\n/).find((line) => /^import \{[^}]*\} from '\.\/src\/host\/domain\.js'/.test(line))
  assert.ok(blockLine, 'index.js must have a domain import block')
  const imported = new Set(blockLine.replace(/^import \{/, '').replace(/\} from .*$/, '').split(',').map((name) => name.trim()).filter(Boolean))
  const rest = index.replace(blockLine, '')
  const missing = exported.filter((name) => new RegExp('\\b' + name + '\\b').test(rest) && !imported.has(name))
  assert.deepEqual(missing, [], 'symbols used but not imported (runtime ReferenceError): ' + missing.join(', '))
})

test('host: cross-module symbols are imported wherever they are used', () => {
  const modules = hostSources.filter((file) => file !== 'index.js')
  const pool = new Map()
  for (const file of modules) {
    for (const m of read(file).matchAll(/^export\s+(?:async\s+function|function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm)) pool.set(m[1], file)
  }
  const offenders = []
  for (const file of hostSources) {
    const raw = read(file)
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/`(?:[^`\\]|\\.)*`/g, '``')
    const imported = new Set()
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()
        if (name) imported.add(name)
      }
    }
    const local = new Set()
    for (const m of src.matchAll(/(?:^|\s)(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1])
    for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/[=:]/)[0].trim()
        if (/^[A-Za-z_$][\w$]*$/.test(name)) local.add(name)
      }
    }
    for (const [name, home] of pool) {
      if (home === file || imported.has(name) || local.has(name)) continue
      const bare = new RegExp('(?<![.\\w$])' + name + '\\b(?!\\s*:)')
      if (bare.test(src)) offenders.push(`${file} uses ${name} (exported by ${home}) without importing it`)
    }
  }
  assert.deepEqual(offenders, [], 'missing imports throw ReferenceError only on the code path that uses them')
})

test('host: every host source stays under 2000 lines', () => {
  for (const file of hostSources) {
    if (file === 'index.js') continue
    const lines = read(file).split(/\r?\n/).length
    assert.ok(lines < 2000, `${file} is ${lines} lines; split it by responsibility`)
  }
})

test('host: node builtin calls in src/host are imported', () => {
  const names = ['mkdir', 'mkdtemp', 'rm', 'readFile', 'writeFile', 'readdir', 'stat', 'access', 'copyFile', 'chmod', 'utimes', 'randomBytes', 'randomUUID', 'createHash', 'homedir', 'tmpdir', 'platform', 'join', 'resolve', 'dirname', 'basename', 'spawn', 'execFile', 'exec']
  for (const file of hostSources.filter((entry) => entry.startsWith('src/host/'))) {
    const source = read(file)
    const imports = [...source.matchAll(/import \{([^}]*)\} from 'node:[^']+'/g)].map((m) => m[1]).join(',')
    const imported = new Set(imports.split(',').map((name) => name.trim()).filter(Boolean))
    for (const name of names) {
      if (!new RegExp('(^|[^\\w.$])' + name + '\\(').test(source)) continue
      assert.ok(imported.has(name), `${file} calls ${name}() without importing it`)
    }
  }
})

test('host: every src/host module evaluates without a ReferenceError', async () => {
  for (const file of hostSources.filter((entry) => entry.startsWith('src/host/'))) {
    await import(new URL('../' + file, import.meta.url).href)
  }
})

test('host: index.js shrinks over time (ratchet)', () => {
  const lines = read('index.js').split(/\r?\n/).length
  assert.ok(lines < 9500, `index.js grew to ${lines} lines; move new logic into src/host/*.js`)
})

test('state schema migration is versioned', () => {
  const host = hostText
  const version = Number(manifest.dsh?.stateSchema ?? 0)
  assert.match(host, /schema:\s*\d+/, 'defaultConfig must declare a schema version')
  assert.match(host, /schema[^\n]{0,48}<\s*\d+/, 'at least one ordered migration must exist')
  assert.ok(version >= 0)
})

test('client source: portal containers carry both scope attributes', () => {
  const ui = read('web/src/lib/portal.js')
  assert.ok(ui.includes('data-dsh-studio-portal'), 'portal root must be marked')
  assert.ok(ui.includes("setAttribute('data-dsh-studio'"), 'portal root must also join the [data-dsh-studio] scope')
})

test('docs: hand-off documents exist and are linked from the README', () => {
  for (const doc of ['AGENTS.md', 'docs/compatibility.md']) {
    assert.ok(existsSync(path(doc)), `${doc} missing`)
    assert.ok(statSync(path(doc)).size > 800, `${doc} looks empty`)
  }
  const readme = read('README.md')
  assert.ok(readme.includes('AGENTS.md') && readme.includes('docs/compatibility.md'), 'README must point at the operator docs')
})

test('locales: every locale file is valid JSON with a title', () => {
  const dir = path('locale')
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
  assert.ok(files.length >= 1)
  for (const name of files) {
    const dict = JSON.parse(read(join('locale', name)))
    assert.ok(String(dict?.meta?.title ?? '').length > 0, `${name} has no meta.title`)
  }
})

test('docs: AGENTS.md lists every host module', () => {
  const agents = readFileSync('AGENTS.md', 'utf8')
  for (const file of readdirSync('src/host').filter(f => f.endsWith('.js'))) {
    assert.ok(agents.includes(file), `AGENTS.md §1 must list src/host/${file}`)
  }
})

test('docs: compatibility.md covers the host entry points we depend on', () => {
  const doc = readFileSync('docs/compatibility.md', 'utf8')
  for (const needle of ['agents.create', 'presets.mount', 'followup', 'webServer.register', 'listModels', 'FALLBACK_AGENT_MODEL']) {
    assert.ok(doc.includes(needle), `docs/compatibility.md must document ${needle}`)
  }
  const index = readFileSync('index.js', 'utf8')
  const dispatcher = readFileSync('src/host/dispatcher.js', 'utf8')
  assert.ok(dispatcher.includes('agents.create'), 'src/host/dispatcher.js actually calls agents.create')
  assert.ok(index.includes('webServer'), 'index.js actually registers web routes')
})

test('host: artifacts leave the poll without their bodies', async () => {
  const { publicArtifact } = await import('../src/host/domain.js')
  const body = '# 技术方案\n' + 'x'.repeat(80)
  const artifact = { id: 'a1', title: '技术方案', content: body, status: 'delivered' }
  const slim = publicArtifact(artifact)
  assert.equal(slim.content, '', 'the body must not travel with the poll')
  assert.equal(slim.contentLength, body.length)
  assert.equal(slim.title, '技术方案')
  assert.equal(artifact.content, body, 'the stored artifact must not be stripped in place')
})

test('host: events fan out and webhook config is sanitized', async () => {
  const { subscribe, emitEvent, subscriberCount } = await import('../src/host/events.js')
  const { sanitizeWebhooks } = await import('../src/host/webhooks.js')
  const seen = []
  const off = subscribe(event => seen.push(event.type))
  const before = subscriberCount()
  emitEvent('task/moved', { taskId: 't1' })
  emitEvent('case/failed', { caseId: 'c1' })
  assert.deepEqual(seen, ['task/moved', 'case/failed'])
  off()
  assert.equal(subscriberCount(), before - 1)
  emitEvent('task/moved', {})
  assert.equal(seen.length, 2, 'unsubscribed handler stops receiving')
  // 一个坏订阅者不能影响其它订阅者
  const good = []
  const bad = subscribe(() => { throw new Error('boom') })
  const ok = subscribe(event => good.push(event.type))
  emitEvent('agent/failed', {})
  assert.deepEqual(good, ['agent/failed'])
  bad(); ok()
  assert.deepEqual(sanitizeWebhooks([{ url: '  ', events: [] }]), [], 'empty url dropped')
  const hooks = sanitizeWebhooks([{ url: 'http://x/hook', events: ['task/moved', 'nope'] }])
  assert.deepEqual(hooks[0].events, ['task/moved'])
  assert.equal(hooks[0].id, 'hook-1')
})

test('host: db cases are refused until enabled, then really run', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { DatabaseSync } = await import('node:sqlite')
  const { runDbCase, sanitizeDbCase } = await import('../src/host/db-runner.js')
  assert.equal(sanitizeDbCase({ sql: 'select 1' }), null, 'file is required')
  assert.equal(sanitizeDbCase({ file: '/tmp/x.db', sql: '  ' }), null)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-studio-db-'))
  const file = join(dir, 'probe.db')
  const seed = new DatabaseSync(file)
  seed.exec('create table t (id integer primary key, name text)')
  seed.exec("insert into t (name) values ('alpha')")
  seed.close()
  try {
    const item = { db: sanitizeDbCase({ file, sql: 'select name from t', expectRows: 1, expectColumn: 'name', expectValue: 'alpha' }) }
    const off = await runDbCase(item, { testing: {} })
    assert.equal(off.ok, false)
    assert.match(off.error, /没开数据库用例/)
    const on = await runDbCase(item, { testing: { allowDb: true } })
    assert.equal(on.ok, true, on.error)
    assert.match(on.preview, /alpha/)
    const bad = await runDbCase({ db: sanitizeDbCase({ file, sql: 'select name from t', expectRows: 2 }) }, { testing: { allowDb: true } })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /行数 1/)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {})
  }
})

test('host: runners register and are picked by their match', async () => {
  const { registerRunner, pickRunner, runnerKinds } = await import('../src/host/runners.js')
  registerRunner('http', { match: item => item.http != null, run: () => ({ ok: true, status: 200 }) })
  registerRunner('shell', { match: item => item.shell != null, run: () => ({ ok: true, status: 0 }) })
  assert.deepEqual([...runnerKinds()].sort(), ['browser', 'db', 'http', 'shell'], 'all built-ins stay registered')
  assert.equal(pickRunner({ shell: {} }).kind, 'shell')
  assert.equal(pickRunner({ http: {} }).kind, 'http')
  assert.equal(pickRunner({ http: {}, shell: {} }).kind, 'shell', 'shell wins when a case carries both')
  assert.equal(pickRunner({ browser: {} }).kind, 'browser', 'browser cases go to the browser runner')
  assert.equal(pickRunner({ http: {}, browser: {} }).kind, 'browser', 'browser wins over http: it opens a real page')
  assert.equal(pickRunner({}), null)
  registerRunner('probe-kind', { match: item => item.probe === true, run: () => ({ ok: true }) })
  assert.equal(pickRunner({ probe: true }).kind, 'probe-kind')
  assert.equal(pickRunner({ probe: false }), null)
})

test('host: shell cases are refused until enabled, then really run', async () => {
  const { runShellCase } = await import('../src/host/shell-runner.js')
  const item = { shell: { command: 'node -e "console.log(1)"', expectExit: 0, timeoutMs: 5000, expectContains: '', expectNotContains: '', cwd: '' } }
  const off = await runShellCase(item, { testing: {} })
  assert.equal(off.ok, false)
  assert.match(off.error, /没开 shell/)
  const hello = { shell: { command: 'node -e "console.log(\'hi\')"', expectExit: 0, timeoutMs: 10000, expectContains: 'hi', expectNotContains: '', cwd: '' } }
  const on = await runShellCase(hello, { testing: { allowShell: true } })
  assert.equal(on.ok, true, on.error)
  assert.match(on.preview, /hi/)
  const wrong = await runShellCase({ shell: { command: 'node -e "process.exit(3)"', expectExit: 0, timeoutMs: 5000, expectContains: '', expectNotContains: '', cwd: '' } }, { testing: { allowShell: true } })
  assert.equal(wrong.ok, false)
  assert.match(wrong.error, /退出码 3/)
})

test('host: the audit summary keeps the offending element', async () => {
  const { sanitizeDesign } = await import('../src/host/design.js')
  const design = sanitizeDesign({ spec: { checked: 218, violations: 17, top: [{ kind: 'fontSize', value: '13.3333px', count: 23, sample: 'span.brand' }] } })
  assert.equal(design.spec.top[0].sample, 'span.brand')
  assert.equal(design.spec.top[0].count, 23)
})

test('host: fidelity history keeps order, caps and skips repeats', async () => {
  const { pushDiffHistory } = await import('../src/host/design.js')
  const first = pushDiffHistory([], { percent: 10, url: 'u', at: 1 })
  assert.equal(first.length, 1)
  const second = pushDiffHistory(first, { percent: 5, url: 'u', at: 2 })
  assert.equal(second.length, 2)
  assert.equal(second[0].percent, 5)
  const same = pushDiffHistory(second, { percent: 5, url: 'u', at: 3 })
  assert.equal(same.length, 2, 'identical rerun does not pile up')
  let full = []
  for (let i = 0; i < 15; i += 1) full = pushDiffHistory(full, { percent: i, url: 'u', at: i })
  assert.equal(full.length, 10, 'capped at ten')
  assert.equal(full[0].percent, 14)
})

test('host: unverified code facts warn but do not block exit', async () => {
  const { configureExecutor, taskExitGate } = await import('../src/host/executor.js')
  configureExecutor({ serviceDependencies: () => [], serviceConflicts: () => undefined })
  const base = {
    status: 'accept',
    checklist: [],
    cases: [],
    artifacts: [{ id: 'a1', title: 'x' }],
    signoff: { by: '人', at: 1 },
    history: [],
  }
  const failed = taskExitGate({ config: {} }, { ...base, coding: { files: [], verified: { ok: false, missingCommits: ['a'], missingFiles: ['b', 'c'] } } })
  assert.ok(failed.warnings.some(item => item.includes('核对不通过')), failed.warnings.join('|'))
  assert.ok(failed.warnings.some(item => item.includes('2 个文件')), failed.warnings.join('|'))
  const clean = taskExitGate({ config: {} }, { ...base, coding: { files: [], verified: { ok: true, missingCommits: [], missingFiles: [] } } })
  assert.equal(clean.warnings.some(item => item.includes('核对不通过')), false)
  const none = taskExitGate({ config: {} }, { ...base })
  assert.equal(none.warnings.some(item => item.includes('核对不通过')), false)
})

test('host: role-keyed runs fold into the only expert with that role', async () => {
  const { buildQuality } = await import('../src/host/quality.js')
  const state = {
    config: { experts: [{ id: 'expert-1', name: '开发工程师', role: 'dev' }, { id: 'expert-2', name: '架构师', role: 'architect' }] },
    tasks: [{ expert: 'expert-1', status: 'dev', history: [] }],
  }
  const merged = buildQuality(state, { byExpert: [{ key: 'dev', runs: 3, ms: 6000 }] })
  assert.equal(merged.experts.length, 1)
  assert.equal(merged.experts[0].expert, 'expert-1')
  assert.equal(merged.experts[0].dispatched, 3)
  // 一个角色挂了两位专家时不能瞎认领：没有卡能对上，就不生成行（派单数只跟着有卡的专家走）
  const ambiguous = buildQuality({ config: { experts: [{ id: 'a', role: 'dev' }, { id: 'b', role: 'dev' }] }, tasks: [] }, { byExpert: [{ key: 'dev', runs: 2, ms: 0 }] })
  assert.equal(ambiguous.experts.length, 0)
})

test('host: a merge request survives the patch normalizer', async () => {
  const { normalizePatch } = await import('../src/host/domain.js')
  const fromObject = normalizePatch({ gitlabMR: { iid: 42, title: 'feat: x', state: 'opened', url: 'https://git/x/-/merge_requests/42' } })
  assert.equal(fromObject.gitlabMR.iid, 42)
  assert.equal(fromObject.gitlabMR.state, 'opened')
  const fromString = normalizePatch({ gitlabMR: '!7 https://git/x/-/merge_requests/7' })
  assert.equal(fromString.gitlabMR.iid, 7)
  const cleared = normalizePatch({ gitlabMR: null })
  assert.equal(cleared.gitlabMR, null)
})

test('config: every default key survives a merge round trip', async () => {
  const { defaultConfig, mergeConfig } = await import('../src/host/domain.js')
  const base = defaultConfig()
  const merged = mergeConfig(base)
  const missing = Object.keys(base).filter(key => merged[key] === undefined)
  assert.deepEqual(missing, [], 'mergeConfig 会抹掉没列进去的配置键（design 就是这样丢的）')
  // 改过的值也要能存活，不只是键存在
  const custom = mergeConfig({ ...base, design: { enabled: true, columns: ['accept'] } })
  assert.equal(custom.design.enabled, true)
  assert.deepEqual(custom.design.columns, ['accept'])
})

test('host: the token audit lands in the checklist too', async () => {
  const { applySpecItem } = await import('../src/host/design.js')
  const dirty = applySpecItem([], { violations: 17, top: [{ value: '13.3333px', count: 23 }, { value: '9px', count: 14 }] })
  assert.equal(dirty.length, 1)
  assert.match(dirty[0].text, /17 处待复核（13\.3333px×23、9px×14）/)
  assert.equal(dirty[0].done, false)
  const clean = applySpecItem(dirty, { violations: 0, top: [] })
  assert.equal(clean.length, 1, 'same row is updated')
  assert.equal(clean[0].id, dirty[0].id)
  assert.equal(clean[0].done, true)
})

test('host: fidelity lands in the checklist and fails below the target', async () => {
  const { applyFidelityItem } = await import('../src/host/design.js')
  const fresh = applyFidelityItem([], 1.01)
  assert.equal(fresh.length, 1)
  assert.match(fresh[0].text, /设计还原度 ≥ 95%（当前 99\.0%）/)
  assert.equal(fresh[0].done, true)
  const bad = applyFidelityItem([], 20)
  assert.equal(bad[0].done, false)
  // 第二次只更新那一行，不再堆一行
  const twice = applyFidelityItem(fresh, 30)
  assert.equal(twice.length, 1)
  assert.equal(twice[0].id, fresh[0].id)
  assert.equal(twice[0].done, false)
  const mixed = applyFidelityItem([{ id: 'k1', text: '别的项', done: true }], 0)
  assert.equal(mixed.length, 2)
  assert.equal(mixed[0].text, '别的项')
})

test('host: the design gate only blocks when it is switched on', async () => {
  const { designGate, sanitizeDesign } = await import('../src/host/design.js')
  const off = { design: { enabled: false } }
  assert.equal(designGate(off, {}, 'dev').needed, false)
  const on = { design: { enabled: true, columns: ['dev'] } }
  const pendingTask = { design: { status: 'pending' } }
  const gate = designGate(on, pendingTask, 'dev')
  assert.equal(gate.needed, true)
  assert.equal(gate.ready, false)
  assert.match(gate.blockers[0], /设计/)
  // 2026-11-20：闸门从「评审通过」升级为「评审通过 + 定案」。评审说"都行"但没指认一稿，
  // 研发很可能照错的那稿做，所以 approved 不再等于放行。
  assert.equal(designGate(on, { design: { status: 'approved' } }, 'dev').ready, false, 'approved 但一稿都没有：拦')
  assert.equal(
    designGate(on, { design: { status: 'approved', drafts: [{ id: 'a', link: 'https://x/a' }], chosenId: 'a' } }, 'dev').ready,
    true,
    '通过且定案：放行',
  )
  assert.equal(designGate(on, {}, 'review').needed, false, 'other columns are not gated')
  assert.equal(designGate(on, {}, 'dev').ready, false, 'no design record blocks too')
  assert.equal(sanitizeDesign(null), null)
  assert.equal(sanitizeDesign({ status: 'nonsense' }).status, 'pending')
  assert.equal(sanitizeDesign({ link: '  http://x  ', status: 'approved' }).link, 'http://x')
})

test('host: cards turn into bitable records and batch at 200', async () => {
  const { BATCH_LIMIT, cardToRecord, mirrorConfigGaps, recordsPayload } = await import('../src/host/bitable.js')
  const record = cardToRecord({ id: 't-1', code: 'DEV-001', title: '登录', status: 'dev', expert: 'dev', priority: 'urgent', requirementId: 'req-1', updatedAt: 1794757921042 })
  assert.equal(record['编号'], 'DEV-001')
  assert.equal(record['标题'], '登录')
  assert.equal(record['状态'], 'dev')
  assert.ok(record['更新时间'].startsWith('2026-'))
  assert.equal(record['编号'], 'DEV-001')
  assert.equal(cardToRecord({ id: 't-2', title: '没编号' })['编号'], 't-2', '没编号就用 id')
  const many = Array.from({ length: BATCH_LIMIT + 5 }, (_, index) => ({ id: 't-' + index, title: 'x' }))
  const batches = recordsPayload(many)
  assert.equal(batches.length, 2)
  assert.equal(batches[0].length, BATCH_LIMIT)
  assert.equal(batches[1].length, 5)
  assert.deepEqual(mirrorConfigGaps({}), ['baseToken（多维表格 app_token）', 'tableId（数据表 id）'])
  assert.deepEqual(mirrorConfigGaps({ feishu: { baseToken: 'b', tableId: 't' } }), [])
})

test('host: injected helpers are only called through host.', async () => {
  const { readFileSync } = await import('node:fs')
  for (const name of ['tools.js', 'routes/tasks.js', 'routes/requirements.js', 'routes/connect.js', 'routes/insights.js']) {
    const source = readFileSync(new URL('../src/host/' + name, import.meta.url), 'utf8')
    const injected = /const INJECTED = \[([\s\S]*?)\]/.exec(source)?.[1] ?? ''
    const names = [...injected.matchAll(/"([^"]+)"/g)].map(match => match[1])
    if (names.length === 0) continue
    // 去掉注释与字符串，剩下的才是真代码
    const code = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '')
    const bare = names.filter((name) => {
      const pattern = new RegExp('(?<![.\\w$])' + name.replace(/\$/g, '\\$') + '\\s*\\(', 'g')
      return pattern.test(code)
    })
    assert.deepEqual(bare, [], name + ' 里这些注入函数被直接调用（应该写成 host.xxx）')
  }
})

test('host: a falling trend marks where the context was compacted', async () => {
  const { contextDrops } = await import('../src/host/context-insight.js')
  assert.deepEqual(contextDrops([100, 200, 300]), [], '一路上升没有压缩')
  const drops = contextDrops([100, 400, 120, 500])
  assert.equal(drops.length, 1)
  assert.equal(drops[0].index, 2)
  assert.equal(drops[0].from, 400)
  assert.equal(drops[0].to, 120)
  assert.ok(drops[0].drop >= 70)
  assert.deepEqual(contextDrops([]), [])
  assert.deepEqual(contextDrops([0, 0]), [], '起点为 0 不算掉')
})

test('host: a requirement with no product or architect discussion gets flagged', async () => {
  const { requirementGate } = await import('../src/host/executor.js')
  const config = { experts: [{ id: 'qa', name: '测试工程师', role: 'qa' }, { id: 'pm', name: '产品经理', role: 'product' }] }
  const requirement = { id: 'r1', title: 'x', status: 'active', signoff: { by: '人', at: 1, note: 'ok' }, review: { status: 'approved' }, points: [], docs: [{ content: 'prd' }], pool: { score: 12 } }
  const card = { id: 't1', requirementId: 'r1', code: 'DEV-001', status: 'done', comments: [{ author: '测试工程师', body: '跑完了' }], cases: [{ id: 'c1', result: 'pass', lastRun: { ok: true } }], checklist: [] }
  const onlyQa = requirementGate({ config, tasks: [card], requirements: [requirement] }, requirement)
  assert.ok(onlyQa.warnings.some(item => item.includes('没有经过澄清与方案')), JSON.stringify(onlyQa.warnings))
  const withPm = requirementGate({ config, tasks: [{ ...card, comments: [{ author: '产品经理', body: '澄清：范围是…' }] }], requirements: [requirement] }, requirement)
  assert.ok(!withPm.warnings.some(item => item.includes('没有经过澄清与方案')), JSON.stringify(withPm.warnings))
})

test('host: an expert with skills does not crash the prompt builder', async () => {
  const { buildExpertPrompt, configureDispatcher } = await import('../src/host/dispatcher.js')
  // 提示词构建依赖不少注入（serviceOf / workProjectOf / 技能库…）；用一个「任何属性都是空函数」的桩，
  // 免得以后再加依赖就要改测试。注意 getActiveSkills 返回 undefined 时技能描述退化成名字。
  configureDispatcher(new Proxy({}, { get: () => () => undefined }))
  const expert = { id: 'dev', name: '开发工程师', emoji: '🛠️', role: 'dev', skills: ['lark-base', 'no-such-skill'] }
  const task = { id: 't-1', code: 'DEV-001', title: '登录失败限制', comments: [] }
  const column = { id: 'dev', label: '开发中' }
  // 注入缺失时也不能炸（以前是裸的 activeSkills，直接 ReferenceError）
  const prompt = buildExpertPrompt(task, expert, column, { experts: [expert] }, undefined, '', undefined, {}, [])
  assert.ok(String(prompt).includes('lark-base'), '技能名要出现在提示词里')
})

test('host: an expert without a prompt falls back to ROLE_BRIEF by role, not by id', async () => {
  const { buildExpertPrompt, configureDispatcher } = await import('../src/host/dispatcher.js')
  configureDispatcher(new Proxy({}, { get: () => () => undefined }))
  const column = { id: 'dev', label: '开发中' }
  const task = { id: 't-1', code: 'DEV-001', title: 'x', comments: [] }
  /* 自建专家的 id 是 slug/hash：以前按 expert.id 查 ROLE_BRIEF 永远查不到，
     空提示词只剩一句通用话；现在按角色位退该角色的职责。 */
  const custom = { id: 'expert-d3c58341', name: '支付开发', role: 'dev' }
  const prompt = String(buildExpertPrompt(task, custom, column, { experts: [custom] }, undefined, '', undefined, {}, []))
  assert.match(prompt, /按方案实现代码/, '填了角色位就退该角色的一句话职责')
  const noRole = { id: 'expert-x', name: '顾问', role: '' }
  const generic = String(buildExpertPrompt(task, noRole, column, { experts: [noRole] }, undefined, '', undefined, {}, []))
  assert.match(generic, /按卡上的要求推进工作/, '没填角色位才是通用兜底')
})

test('host: a card with unasserted cases asks the expert to fill assertions', async () => {
  const { buildExpertPrompt, configureDispatcher } = await import('../src/host/dispatcher.js')
  configureDispatcher(new Proxy({}, { get: () => () => undefined }))
  const expert = { id: 'dev', name: '开发工程师', emoji: '🛠️', role: 'dev' }
  const column = { id: 'dev', label: '开发中' }
  const draft = { id: 'c1', title: '登录失败 5 次后锁定', expected: '第 6 次返回 423', http: null, shell: null, db: null, result: 'pending' }
  const ok = { id: 'c2', title: '真能跑的那条', http: { method: 'GET', url: '/x', expectStatus: 200 }, result: 'pending' }
  const prompt = String(buildExpertPrompt({ id: 't-1', code: 'DEV-001', title: 'x', comments: [], cases: [draft, ok] }, expert, column, { experts: [expert] }, undefined, '', undefined, {}, []))
  assert.match(prompt, /1 条用例没有可执行断言/, '只数没有断言的那一条')
  assert.match(prompt, /studio_task_add_cases/, '要给出补断言用的工具名')
  assert.doesNotMatch(prompt, /没有可执行断言[^\n]*真能跑的那条/, '已经能跑的用例不该被点名')
  const clean = String(buildExpertPrompt({ id: 't-1', code: 'DEV-001', title: 'x', comments: [], cases: [ok] }, expert, column, { experts: [expert] }, undefined, '', undefined, {}, []))
  assert.doesNotMatch(clean, /没有可执行断言/, '全都能跑时不要多嘴')
})

test('host: a tool-heavy session gets a plain-language warning', async () => {
  const { breakdownContext, toolHeavyWarning, TOOL_HEAVY_THRESHOLD } = await import('../src/host/context-insight.js')
  const heavy = breakdownContext({ usage: [{ input: 100, cacheRead: 900 }], counts: { turns: 2 }, volume: { tool: 8000, assistant: 1000, user: 500, other: 500 } }, 300)
  assert.ok(heavy.parts.find(part => part.key === 'tool').percent >= TOOL_HEAVY_THRESHOLD)
  assert.match(toolHeavyWarning(heavy) ?? '', /工具结果占了/)
  const light = breakdownContext({ usage: [{ input: 100, cacheRead: 900 }], counts: {}, volume: { tool: 500, assistant: 8000, user: 500, other: 500 } }, 300)
  assert.equal(toolHeavyWarning(light), null, '工具占比不高就不提示')
  assert.equal(toolHeavyWarning(null), null)
})

test('host: a failing case files a bug at the severity of the case', async () => {
  const { bugSeverityFor } = await import('../src/host/bugs.js')
  assert.deepEqual(bugSeverityFor('p0', 'dev'), { severity: 'p0', priority: 'urgent', regression: false })
  assert.deepEqual(bugSeverityFor('p1', 'test'), { severity: 'p1', priority: 'normal', regression: false })
  assert.deepEqual(bugSeverityFor('p3', 'dev'), { severity: 'p3', priority: 'relaxed', regression: false })
  assert.deepEqual(bugSeverityFor(undefined, 'dev'), { severity: 'p2', priority: 'normal', regression: false }, '没填优先级按 p2')
  // 已完成/待验收的卡上失败 = 回归，升一级
  assert.deepEqual(bugSeverityFor('p2', 'done'), { severity: 'p1', priority: 'normal', regression: true })
  assert.deepEqual(bugSeverityFor('p0', 'done'), { severity: 'p0', priority: 'urgent', regression: true }, 'p0 封顶')
})

test('host: a requirement needs three answers before it can be split', async () => {
  const { discoveryGaps, sanitizeDiscovery } = await import('../src/host/discovery.js')
  const { sanitizeRequirement } = await import('../src/host/domain.js')
  assert.equal(discoveryGaps({}).length, 3, 'empty requirement misses all three')
  const saved = sanitizeRequirement({ title: '管理后台', discovery: { server: ' 有，node:sqlite ', auth: '', boundary: '' } })
  assert.equal(saved.discovery.server, '有，node:sqlite', 'trimmed')
  const gaps = discoveryGaps(saved)
  assert.equal(gaps.length, 2)
  assert.ok(gaps[0].includes('鉴权'), gaps.join('|'))
  const done = sanitizeRequirement({ title: '管理后台', discovery: { server: 'a', auth: 'b', boundary: 'c' } })
  assert.equal(discoveryGaps(done).length, 0)
  assert.deepEqual(sanitizeDiscovery(null), { server: '', auth: '', boundary: '' })
  const { backendCoverageWarning } = await import('../src/host/discovery.js')
  assert.equal(backendCoverageWarning({ discovery: { server: '没有，纯前端演示' }, points: [] }), null, '说没有就不提示')
  const warned = backendCoverageWarning({ discovery: { server: '有，node:sqlite' }, points: [{ title: '登录页' }] })
  assert.ok(warned !== null && warned.includes('后端'), String(warned))
  assert.equal(backendCoverageWarning({ discovery: { server: '有，node:sqlite' }, points: [{ title: '订单接口与建表' }] }), null)
  // 反向：说了没后端却要建表
  const { frontendOnlyWarning } = await import('../src/host/discovery.js')
  assert.equal(frontendOnlyWarning({ discovery: { server: '没有，纯前端' }, points: [{ title: '导出按钮' }] }), null, '纯前端功能点不提示')
  const reverse = frontendOnlyWarning({ discovery: { server: '没有，纯前端演示' }, points: [{ title: '新增库存表并写接口' }] })
  assert.ok(reverse !== null && reverse.includes('没有服务端'), String(reverse))
  assert.equal(frontendOnlyWarning({ discovery: { server: '有，node:sqlite' }, points: [{ title: '新增表' }] }), null, '说有后端就不归这条管')
  assert.equal(frontendOnlyWarning({}), null)
  // 功能点没有验收标准
  const { vaguePointsWarning } = await import('../src/host/discovery.js')
  assert.equal(vaguePointsWarning({ points: [] }), null)
  assert.equal(vaguePointsWarning({ points: [{ title: '有验收', acceptance: [{ text: '点了能下载' }] }] }), null)
  const vague = vaguePointsWarning({ points: [{ title: '库存预警' }, { title: '阈值配置', acceptance: [] }] })
  assert.ok(vague !== null && vague.includes('2 个功能点'), String(vague))
})

test('host: usage parsing takes one usage per message and prices what it can', async () => {
  const { costOf, isSubscriptionModel, parseUsageLines, priceOf, summarizeUsage } = await import('../src/host/usage.js')
  const lines = [
    '{"type":"session","version":4,"id":"studio-t-1-dev"}',
    '{"type":"assistant/message","time":100,"data":{"turn":1,"step":1,"message":{"role":"assistant"},"usage":{"inputTokens":1000,"outputTokens":200,"cacheReadTokens":5000,"cacheWriteTokens":0,"totalTokens":6200},"stream":[{"type":"chunk","chunk":{"type":"usage","usage":{"inputTokens":1000,"outputTokens":200}}}]}}',
    'not json at all',
    '{"type":"assistant/message","time":200,"data":{"turn":1,"step":2,"message":{"role":"assistant"},"usage":{"inputTokens":10,"outputTokens":5,"totalTokens":15}}}',
    '{"type":"turn/end","data":{"turn":1}}',
  ]
  const parsed = parseUsageLines(lines)
  assert.equal(parsed.length, 2, 'only assistant/message entries carry usage, one each')
  assert.equal(parsed[0].model, '', 'no model declared yet')
  const withModel = parseUsageLines([
    '{"type":"session/request/context","data":{"model":"deepseek-v4.1-flash"}}',
    '{"type":"assistant/message","data":{"usage":{"inputTokens":5,"outputTokens":1}}}',
  ])
  assert.equal(withModel[0].model, 'deepseek-v4.1-flash', 'model inherited from the request context')
  assert.equal(parsed[0].cacheRead, 5000)
  const totals = summarizeUsage(parsed)
  assert.deepEqual({ calls: totals.calls, input: totals.input, output: totals.output, cacheRead: totals.cacheRead }, { calls: 2, input: 1010, output: 205, cacheRead: 5000 })
  assert.equal(isSubscriptionModel('deepseek-v4.1-flash-coding'), true)
  assert.equal(isSubscriptionModel('deepseek-v4.1-flash'), false)
  const prices = [{ model: 'deepseek-v4.1-flash', input: 2, output: 8, cacheRead: 0.2 }]
  assert.equal(priceOf(prices, 'unknown-model'), null)
  const priced = costOf(prices, [{ model: 'deepseek-v4.1-flash', input: 1000000, output: 1000000, cacheRead: 1000000 }])
  assert.equal(priced.cost, 10.2, '2 + 8 + 0.2 per million')
  const unknown = costOf(prices, [{ model: 'mystery', input: 10, output: 10 }])
  assert.equal(unknown.cost, null, 'unknown model must not be reported as zero')
  const subscription = costOf(prices, [{ model: 'x-coding', input: 999999, output: 999999 }])
  assert.equal(subscription.cost, 0, 'subscription channels cost nothing extra')
  // 设置页「补价目」补进来的空行（四个单价都是 0）不能算命中：否则报表显示 ¥0.00，比「未知」更能骗人
  const blank = [{ model: 'deepseek-v4.1-pro', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }]
  assert.equal(priceOf(blank, 'deepseek-v4.1-pro'), null)
  assert.equal(costOf(blank, [{ model: 'deepseek-v4.1-pro', input: 1000, output: 1000 }]).cost, null)
})

test('host: impact counts shell and db cases as runnable', async () => {
  const { casesOfTasks, impactSummary } = await import('../src/host/impact.js')
  const tasks = [
    { id: 't1', code: 'DEV-1', cases: [
      { id: 'c1', title: 'a', result: 'pending', http: { method: 'GET', url: '/x' } },
      { id: 'c2', title: 'b', result: 'pass', shell: { command: 'echo 1' } },
      { id: 'c3', title: 'c', result: 'fail', db: { file: '/tmp/x.db', sql: 'select 1' } },
      { id: 'c4', title: 'd', result: 'pending', http: null },
    ] },
  ]
  const rows = casesOfTasks(tasks)
  assert.equal(rows.length, 4)
  assert.equal(rows.filter(item => item.runnable).length, 3, 'http + shell + db are runnable, manual is not')
  const summary = impactSummary(tasks)
  assert.equal(summary.runnable, 3)
  assert.equal(summary.failing, 1)
})

test('host: a requirement change lists the cases that must be re-run', async () => {
  const { casesOfTasks, impactSummary } = await import('../src/host/impact.js')
  const tasks = [
    { id: 't1', code: 'DEV-1', cases: [{ id: 'c1', title: '主流程', result: 'pass', http: true }, { id: 'c2', title: '异常', result: 'fail', http: true }] },
    { id: 't2', code: 'DEV-2', cases: [{ id: 'c3', title: '手工', result: 'skip', http: false }] },
    { id: 't3', code: 'DEV-3' },
  ]
  const cases = casesOfTasks(tasks, 40)
  assert.equal(cases.length, 3)
  assert.equal(cases[0].key, 't1:c1')
  assert.equal(cases[0].taskCode, 'DEV-1')
  assert.deepEqual(impactSummary(tasks), { cards: 3, cases: 3, runnable: 3, failing: 1 })
  assert.equal(casesOfTasks(tasks, 2).length, 2, 'limit holds')
})

test('host: coding facts compare the self-reported numbers with the MR', async () => {
  const { compareCodingFacts } = await import('../src/host/gitlab-facts.js')
  const coding = { files: [{ path: 'a.js' }, { path: 'b.js' }], commits: [{ sha: '1' }] }
  const mr = { state: 'opened', title: 'feat: x' }
  const detail = { pipeline: { status: 'success' }, changes: { files: [{ path: 'a.js' }], commits: 3 } }
  const facts = compareCodingFacts(coding, mr, detail, 1700000000000)
  assert.equal(facts.state, 'opened')
  assert.equal(facts.pipeline, 'success')
  assert.deepEqual(facts.files, { declared: 2, actual: 1 })
  assert.deepEqual(facts.commits, { declared: 1, actual: 3 })
  assert.equal(facts.mismatches.length, 2)
  assert.deepEqual(facts.commitList, [], '拿不到提交明细时是空数组，不是 undefined')
  assert.equal(facts.ci, null, '没有 CI 结果就是 null（未知），不编造成 0')
  const clean = compareCodingFacts({ files: [{ path: 'a.js' }], commits: [] }, mr, { pipeline: null, changes: { files: [{ path: 'a.js' }], commits: 0 } }, 1)
  assert.deepEqual(clean.mismatches, [])
  assert.equal(clean.pipeline, null)
})

test('host: commits and CI results are checked one by one, not just counted', async () => {
  const { compareCodingFacts, missingDeclaredCommits } = await import('../src/host/gitlab-facts.js')
  const actual = [{ id: 'x1', sha: 'a1b2c3d4', title: 'feat' }, { id: 'x2', sha: 'b2c3d4e5', title: 'test' }]
  assert.deepEqual(missingDeclaredCommits([{ sha: 'a1b2c3' }], actual), [], '前缀对得上就算同一个提交')
  assert.deepEqual(missingDeclaredCommits([{ sha: 'deadbeef' }], actual), ['deadbeef'], '编造的 sha 要能被点出来')
  assert.deepEqual(missingDeclaredCommits([], actual), [], '没自报提交就没什么可比的')
  assert.deepEqual(missingDeclaredCommits([{ sha: 'a1b2c3d4' }], []), ['a1b2c3d4'], 'MR 没给明细时，自报的提交算"对不上"')

  const coding = { files: [{ path: 'a.js' }], commits: [{ sha: 'a1b2c3d4' }, { sha: 'deadbeef' }], unitTests: { total: 12, passed: 10 } }
  const detail = {
    pipeline: { status: 'success' },
    changes: { files: [{ path: 'a.js' }], commits: 2 },
    commits: actual,
    ci: { total: 12, passed: 11, failed: 1, skipped: 0, source: 'test_report' },
  }
  const facts = compareCodingFacts(coding, { state: 'merged' }, detail, 5)
  assert.equal(facts.commitList.length, 2)
  assert.deepEqual(facts.missingCommits, ['deadbeef'])
  assert.equal(facts.ci.source, 'test_report')
  assert.equal(facts.mismatches.length, 2, '一处编造提交 + 一处单测数对不上')
  assert.ok(facts.mismatches.some(line => line.includes('单测')), '要点名单测差在哪，不能只说"有差异"')

  // jobs 口径是任务数不是用例数，拿它跟单测数比会冤枉人
  const jobsOnly = compareCodingFacts(coding, {}, { ...detail, ci: { total: 5, passed: 4, failed: 1, skipped: 0, source: 'jobs' } }, 5)
  assert.equal(jobsOnly.mismatches.length, 1)
  assert.ok(jobsOnly.mismatches[0].includes('MR 里找不到'))
})

test('host: /state answers 304 when nothing changed (a thousand cards must not be re-sent)', async () => {
  const { configureStateRoutes, handleStateRoute, stateEtag } = await import('../src/host/routes/state.js')
  const state = { revision: 42, tasks: [{ id: 'a' }, { id: 'b' }] }
  const sent = []
  configureStateRoutes({
    publicState: () => state,
    getDispatcher: () => undefined,
    sendJson: (res, code, body) => { sent.push({ code, body, headers: res.headers }) },
  })
  const makeRes = () => {
    const headers = {}
    const res = { headers, ended: false, setHeader: (key, value) => { headers[key] = value }, end: () => { res.ended = true } }
    return res
  }
  const etag = stateEtag(42, '李四')
  assert.match(etag, /^W\/"42-/, 'ETag 里要有版本号')
  assert.notEqual(stateEtag(42, '李四'), stateEtag(42, '王五'), '不同的人不能共用一份缓存')
  assert.notEqual(stateEtag(42, '李四'), stateEtag(43, '李四'), '版本变了 ETag 必须变')

  const first = makeRes()
  assert.equal(handleStateRoute({ method: 'GET', route: '/state', req: { studioActor: '李四', headers: {} }, res: first, store: {} }), true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].code, 200)
  assert.equal(sent[0].body.ok, true)
  assert.equal(sent[0].body.state, state, '整包状态原样下发')
  assert.equal(first.headers.etag, etag)
  assert.equal(first.headers['cache-control'], 'no-cache')

  // 第二次带上 ETag：一个字节都不发
  const second = makeRes()
  assert.equal(handleStateRoute({ method: 'GET', route: '/state', req: { studioActor: '李四', headers: { 'if-none-match': etag } }, res: second, store: {} }), true)
  assert.equal(sent.length, 1, '304 时不要再调 sendJson')
  assert.equal(second.ended, true)

  // 换了人：内容可见范围可能不同，必须重发
  const third = makeRes()
  handleStateRoute({ method: 'GET', route: '/state', req: { studioActor: '王五', headers: { 'if-none-match': etag } }, res: third, store: {} })
  assert.equal(sent.length, 2, '换人就不能用别人的 ETag')

  // 非 GET / 非 /state 不归它管
  assert.equal(handleStateRoute({ method: 'POST', route: '/state', req: { headers: {} }, res: makeRes(), store: {} }), false)
  assert.equal(handleStateRoute({ method: 'GET', route: '/tasks', req: { headers: {} }, res: makeRes(), store: {} }), false)
})

test('host: /state 304 时不再构建整包状态（每条需求的准出计算不该白跑）', async () => {
  const { configureStateRoutes, handleStateRoute, stateEtag } = await import('../src/host/routes/state.js')
  let built = 0
  configureStateRoutes({
    publicState: () => { built += 1; return { revision: 7 } },
    getDispatcher: () => undefined,
    sendJson: () => {},
  })
  const res = { setHeader: () => {}, end: () => {} }
  const store = { snapshot: () => ({ revision: 7 }) }
  assert.equal(handleStateRoute({
    method: 'GET', route: '/state', store, res,
    req: { studioActor: '李四', headers: { 'if-none-match': stateEtag(7, '李四') } },
  }), true)
  assert.equal(built, 0, '命中 ETag 就不该调 publicState')
})

test('host: feishu doc fetch output is parsed without throwing on junk', async () => {
  const { parseFeishuDocFetch } = await import('../src/host/lark-doc.js')
  const ok = parseFeishuDocFetch(JSON.stringify({ ok: true, data: { document: { content: '<title>库存预占 PRD</title>\n# 背景\n正文' } } }))
  assert.equal(ok.ok, true)
  assert.equal(ok.title, '库存预占 PRD', 'title 标签要拔出来，别当成正文')
  assert.equal(ok.text.startsWith('# 背景'), true)
  const denied = parseFeishuDocFetch(JSON.stringify({ ok: false, error: { message: 'no permission' } }))
  assert.equal(denied.ok, false)
  assert.match(denied.error, /no permission/, '要把 lark-cli 的原始报错透出来')
  assert.equal(parseFeishuDocFetch(JSON.stringify({ ok: true, data: { document: { content: '   ' } } })).ok, false, '空正文要算失败')
  const plain = parseFeishuDocFetch('# 直接是 markdown')
  assert.equal(plain.ok, true, '有的版本直接吐 markdown，原样当正文')
  assert.equal(plain.text, '# 直接是 markdown')
  assert.equal(parseFeishuDocFetch('').ok, false)
})

test('host: the requirement-doc chain keeps every entry the card asks for', async () => {
  // 这条链（拉正文 → 设为基线 → 对比 → 回滚）的每个入口都要真的接在页面上，
  // 光有后端路由不算数：以前「＋ 新建需求」就是绑了一个只写不读的 state，点了没反应。
  const page = read('web/src/studio/pages/requirements.js')
  for (const label of ['从链接拉正文', '设为基线', '对比基线', '回滚到基线', '取消基线']) {
    assert.ok(page.includes(label), `需求页少了「${label}」入口`)
  }
  assert.ok(page.includes("api('/requirement/pull'"), '拉正文要真调 /requirement/pull')
  assert.ok(page.includes("action: 'baseline'") && page.includes("action: 'rollback'"), '基线与回滚要走 /requirement/doc')
  const executor = read('src/host/executor.js')
  assert.ok(executor.includes("action === 'rollback'"), 'executor 必须真的处理 rollback')
  assert.ok(executor.includes('parseFeishuDocFetch'), '拉正文的解析走 lark-doc.js 的纯函数')
  const route = read('src/host/routes/requirements.js')
  assert.ok(route.includes('/requirement/pull') && route.includes('/requirement/doc'), '路由要在 requirements.js 里')
})

test('host: quality counts rework from backwards moves, failures and reopens', async () => {
  const { taskRework, buildQuality } = await import('../src/host/quality.js')
  assert.equal(taskRework({ history: [{ status: 'clarify' }, { status: 'dev' }] }).rework, false)
  const back = taskRework({ history: [{ status: 'dev' }, { status: 'review' }, { status: 'dev' }] })
  assert.equal(back.rework, true)
  assert.equal(back.backwards, 1)
  assert.equal(taskRework({ agentFailures: 2 }).rework, false, 'AI 失败单独统计，不算返工')
  assert.equal(taskRework({ agentFailures: 2 }).failures, 2)
  assert.equal(taskRework({ reopenCount: 1 }).reopens, 1)

  const state = {
    config: { experts: [{ id: 'dev', name: '开发', emoji: '🛠' }] },
    tasks: [
      { expert: 'dev', status: 'done', history: [{ status: 'dev' }, { status: 'done' }] },
      { expert: 'dev', status: 'done', history: [{ status: 'dev' }, { status: 'review' }, { status: 'dev' }] },
      { expert: 'dev', status: 'dev', agentFailures: 1 },
      { status: 'dev' },
    ],
  }
  const quality = buildQuality(state, { byExpert: [{ key: '开发', runs: 4, ms: 8000 }] })
  assert.equal(quality.experts.length, 1)
  assert.equal(quality.experts[0].dispatched, 4)
  assert.equal(quality.experts[0].avgMs, 2000)
  assert.equal(quality.experts[0].cards, 3)
  assert.equal(quality.experts[0].done, 2)
  assert.equal(quality.experts[0].firstPass, 1)
  assert.equal(quality.experts[0].firstPassRate, 50)
  assert.equal(quality.experts[0].reworkRate, 33, 'only backwards moves count as rework')
  assert.equal(quality.totals.failures, 1)
  assert.equal(quality.cost.wired, false)
})

test('host: a suite resolves to keys by rules and keeps hand-picked ones', async () => {
  const { resolveSuiteKeys, sanitizeSuite } = await import('../src/host/cases.js')
  const cases = [
    { key: 't1:c1', http: true, runnable: true, requirementId: 'r1', priority: 'p0' },
    { key: 't1:c2', http: false, runnable: true, requirementId: 'r1', priority: 'p0' },
    { key: 't1:c3', http: false, runnable: false, requirementId: 'r1', priority: 'p0' },
    { key: 't2:c1', http: true, runnable: true, requirementId: 'r2', priority: 'p2' },
    { key: 't3:c1', http: true, runnable: true, requirementId: 'r1', priority: 'p2' },
  ]
  assert.deepEqual(resolveSuiteKeys({ rules: { httpOnly: true } }, cases), ['t1:c1', 't2:c1', 't3:c1'])
  // httpOnly:false = 所有能跑的（接口 / shell / 数据库 / 浏览器）；草稿仍然排除
  assert.deepEqual(resolveSuiteKeys({ rules: { httpOnly: false } }, cases), ['t1:c1', 't1:c2', 't2:c1', 't3:c1'])
  assert.deepEqual(resolveSuiteKeys({ rules: { requirementIds: ['r1'] } }, cases), ['t1:c1', 't3:c1'])
  assert.deepEqual(resolveSuiteKeys({ rules: { priorities: ['p0'] } }, cases), ['t1:c1'])
  // 手工挑的用例即使不满足规则也要跑；重复键去重
  assert.deepEqual(resolveSuiteKeys({ rules: { requirementIds: ['r2'] }, keys: ['t1:c2', 't1:c2'] }, cases), ['t1:c2', 't2:c1'])
  const cleaned = sanitizeSuite({ name: '  ', rules: { priorities: ['P1', 'zz'] }, keys: ['坏键', 't1:c1'] })
  assert.equal(cleaned.name, '未命名套件')
  assert.deepEqual(cleaned.rules, { requirementIds: [], priorities: ['p1'], httpOnly: true })
  assert.deepEqual(cleaned.keys, ['t1:c1'])
  assert.equal(cleaned.isDefault, false)
  assert.ok(cleaned.id.length > 0)
})

test('host: the team memory block only lists what the team actually did', async () => {
  const { teamMemoryBlock } = await import('../src/host/team-memory.js')
  assert.equal(teamMemoryBlock([]), '')
  assert.equal(teamMemoryBlock(null), '')
  const block = teamMemoryBlock([
    { outcome: '做完的卡', title: '导出进度展示', note: '踩过 33.3% 取整的坑' },
    { outcome: '修完的缺陷', title: '库存超卖', note: '' },
  ])
  assert.match(block, /导出进度展示（踩过 33\.3% 取整的坑）/)
  assert.match(block, /库存超卖/)
  assert.equal(teamMemoryBlock([{ outcome: 'x', title: 'y' }], 0), '')
  // 反复出现的经验要变成约束，只出现一次的不算
  const { memoryLessons } = await import('../src/host/team-memory.js')
  const repeated = [
    { outcome: '完成', title: '卡1', note: '忘了跑 pnpm build 就提交' },
    { outcome: '完成', title: '卡2', note: '忘了跑 pnpm build  就提交' },
    { outcome: '完成', title: '卡3', note: '只跑了一次' },
  ]
  const lessons = memoryLessons(repeated)
  assert.equal(lessons.length, 1, '只有重复的那条算经验')
  assert.ok(lessons[0].hits >= 2)
  assert.match(teamMemoryBlock(repeated), /反复出过的问题/)
  assert.equal(memoryLessons([{ note: '只出现一次' }]).length, 0)
  // 措辞不同但意思相同（多了个「了」）也要算同一条
  const wordier = [
    { note: '提交前忘了跑 pnpm build' },
    { note: '提交前忘了跑 pnpm build 了' },
    { note: '这完全是一条不相干的经验' },
  ]
  const merged = memoryLessons(wordier)
  assert.equal(merged.length, 1, JSON.stringify(merged))
  assert.equal(merged[0].hits, 2)
})

test('host: a regression summary adds up the per-card results', async () => {
  const { summarizeRun } = await import('../src/host/cases.js')
  const record = summarizeRun([
    { taskId: 't1', ok: true, total: 4, passed: 3, failed: 1, bugs: 1 },
    { taskId: 't2', ok: false, error: '环境不可达' },
    { taskId: 't3', ok: true, total: 2, passed: 2, failed: 0, bugs: 0 },
  ], '定时回归', 1700000000000)
  assert.deepEqual(record, { at: 1700000000000, by: '定时回归', cards: 3, failedCards: 1, total: 6, passed: 5, failed: 1, bugs: 1 })
  assert.equal(summarizeRun(null, '').cards, 0)
})

test('host: case keys group by card and bad keys drop out', async () => {
  const { groupCaseKeys } = await import('../src/host/cases.js')
  const grouped = groupCaseKeys(['t1:c1', 't1:c2', 't2:c9', 'broken', ':c1', 't3:'])
  assert.deepEqual([...grouped.keys()], ['t1', 't2'])
  assert.deepEqual(grouped.get('t1'), ['c1', 'c2'])
  assert.deepEqual(grouped.get('t2'), ['c9'])
  assert.equal(groupCaseKeys([]).size, 0)
  assert.equal(groupCaseKeys(null).size, 0)
})

test('host: the case library flattens cards with their context', async () => {
  const { collectCases } = await import('../src/host/cases.js')
  const state = {
    requirements: [{ id: 'r1', title: '报表导出', code: 'REQ-001' }],
    tasks: [
      { id: 't1', title: '异步导出', code: 'REQ-001-01', status: 'test', requirementId: 'r1', cases: [
        { id: 'c1', title: '导出成功', result: 'pass', http: { method: 'GET', path: '/x' }, lastRun: { at: 1700000000000 } },
        { id: 'c2', title: '超时', result: 'fail', http: null },
      ] },
      { id: 't2', title: '裸卡', status: 'clarify', cases: [] },
    ],
  }
  const rows = collectCases(state)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].taskId, 't1')
  assert.equal(rows[0].requirementTitle, '报表导出')
  assert.equal(rows[0].requirementCode, 'REQ-001')
  assert.equal(rows[0].http, true)
  assert.equal(rows[0].lastRunAt, 1700000000000)
  assert.equal(rows[1].http, false)
  assert.equal(rows[1].result, 'fail')
  assert.deepEqual(collectCases({ tasks: [] }), [])
})

test('host: cases and checklist leave the poll as counts', async () => {
  const { publicCases, publicChecklist } = await import('../src/host/domain.js')
  const task = {
    cases: [{ result: 'pass' }, { result: 'fail' }, { result: 'skip' }],
    checklist: [{ done: true }, { done: true }, { done: false }],
  }
  const trimmedCases = publicCases(task)
  assert.equal('cases' in trimmedCases, false, '不再下发空数组：读 task.cases.length 的视图会永远看到 0')
  assert.deepEqual(trimmedCases.caseSummary, { total: 3, pass: 1, fail: 1 })
  const trimmedCheck = publicChecklist(task)
  assert.equal('checklist' in trimmedCheck, false)
  assert.deepEqual(trimmedCheck.checkSummary, { done: 2, total: 3 })
  assert.equal(task.cases.length, 3, 'the stored task must not be stripped in place')
})

test('host: comments leave the poll as a count', async () => {
  const { publicComments } = await import('../src/host/domain.js')
  const task = { id: 't1', comments: [{ id: 'c1', body: '一' }, { id: 'c2', body: '二' }] }
  const slim = publicComments(task)
  assert.equal('comments' in slim, false, '正文不下发，也不再下发空数组')
  assert.equal(slim.commentCount, 2)
  assert.deepEqual(publicComments({ id: 't2' }), { commentCount: 0 })
  assert.equal(task.comments.length, 2, 'the stored task must not be stripped in place')
})

test('client: every studio module pulls in what it borrows from its siblings', () => {
  const walk = (dir) =>
    readdirSync(path(dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(dir + '/' + entry.name)
        : entry.name.endsWith('.js') ? [dir + '/' + entry.name] : [])
  const stripComments = (code) =>
    code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  const modules = walk('web/src/studio')
  const owners = new Map()
  for (const name of modules) {
    const code = stripComments(read(name))
    for (const match of code.matchAll(/export (?:async )?(?:function|const) ([A-Za-z_$][\w$]*)/g)) {
      owners.set(match[1], name)
    }
  }
  const missing = []
  for (const name of modules) {
    const code = stripComments(read(name))
    const own = new Set([
      ...[...code.matchAll(/(?:export )?(?:async )?function ([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
      ...[...code.matchAll(/(?:export )?(?:const|let|var) ([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
      ...[...code.matchAll(/import \{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop())),
      ...[...code.matchAll(/const \{([^}]*)\} = client\(\)/g)].flatMap((m) => m[1].split(',').map((s) => s.trim())),
      ...[...code.matchAll(/(?:export )?function \w+\(\{([^}]*)\}\)/g)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(':').pop().trim())),
      ...[...code.matchAll(/(?:export )?function \w+\(([^)]*)\)/g)].flatMap((m) => m[1].split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z_$][\w$]*$/.test(s))),
    ])
    for (const [symbol, owner] of owners) {
      if (owner === name || own.has(symbol)) continue
      if (!new RegExp('(^|[^\\w$.' + "'" + '"])' + symbol + '\\b').test(code)) continue
      missing.push(name + ' borrows ' + symbol + ' from ' + owner + ' without importing it')
    }
  }
  assert.deepEqual(missing, [], 'studio module uses a sibling export without importing it')
})

test('client: components that use React. get React from client() or props', () => {
  const walk = (dir) =>
    readdirSync(path(dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(dir + '/' + entry.name)
        : entry.name.endsWith('.js') ? [dir + '/' + entry.name] : [])
  const missing = []
  for (const name of walk('web/src/studio')) {
    const code = read(name)
    const factoryProvidesReact = /\(\{[^}]*\bReact\b[^}]*\}\)/.test(code)
    // 每个组件块从 "function Name(" 到下一个顶层 "export function"/"function Name(" 之前
    const chunks = code.split(/\n(?=(?:export )?function [A-Z][\w$]*\()/)
    for (const chunk of chunks) {
      const head = chunk.match(/^(?:export )?function ([A-Z][\w$]*)\(/)?.[1]
      if (head === undefined) continue
      if (!/\bReact\./.test(chunk)) continue
      const received = /\{[^}]*\bReact\b[^}]*\}\s*=\s*client\(\)/.test(chunk)
        || /\{[^}]*\bReact\b[^}]*\}/.test(chunk.slice(0, chunk.indexOf('\n')))
      if (!received && !factoryProvidesReact) missing.push(name + ' :: ' + head)
    }
  }
  assert.deepEqual(missing, [], 'modules use React. without receiving it: ' + missing.join(', '))
})

test('host: index.js 能被真的 import 起来（模块搬走后导入断裂，node --check 查不出）', async () => {
  // 2026-11-19 实测事故：sanitizeAcceptanceItem 从 domain.js 搬到 acceptance.js 后，
  // index.js 还在从 domain.js 导入 —— 语法检查通过、164 条契约测试全绿，
  // 但插件在目标机上 import 失败，整个面板 405。
  const module = await import('../index.js')
  assert.equal(typeof module.apply, 'function', 'index.js 必须导出 apply')
  assert.ok(Array.isArray(module.inject), 'index.js 必须导出 inject 数组')
})

test('tooling: Release 正文的判据（按结构，不按措辞）', async () => {
  const { releaseBodyIssue } = await import('../tools/lib/release-notes.mjs')
  assert.match(String(releaseBodyIssue('')), /空的/)
  assert.match(String(releaseBodyIssue('   \n ')), /空的/)
  // 回退生成器打出来的形状：## v<version> + 提交列表
  assert.match(
    String(releaseBodyIssue('## v0.9.30\n\n这一版没有写更新日志，下面是它包含的提交（完成后对比完整 diff）：', '0.9.30')),
    /不是 CHANGELOG 的 0.9.30 这一版/,
  )
  // 版本对不上也算错（比如把上一版正文发出来了）
  assert.match(String(releaseBodyIssue('## [0.9.29] — 2026-11-20\n\n### 修复\n- x', '0.9.30')), /不是 CHANGELOG 的 0.9.30/)
  // 正文里正常引用「没写更新日志」不该被判红：0.9.29 / 0.9.30 都被这句话误伤过
  const quoting = '## [0.9.30] — 2026-11-20\n\n### 修复\n- 说明里提到「这一版没有写更新日志」这句话，但正文是完整的更新日志'
  assert.equal(releaseBodyIssue(quoting, '0.9.30'), null)
  assert.equal(releaseBodyIssue('## [0.9.30] — 2026-11-20\n\n### 修复\n- 修了点东西', 'v0.9.30'), null, 'v 前缀要归一')
})

test('tooling: registry 查询的 URL 编码（scoped 包的 / 必须编成 %2F）', async () => {
  const { packageSlug } = await import('../tools/lib/registry.mjs')
  assert.equal(packageSlug('@marsken/dsh-studio'), '%40marsken%2Fdsh-studio')
  assert.equal(packageSlug('plain-pkg'), 'plain-pkg')
})

test('state: 计数用原对象算，不许传给剥掉数组的 rest（issue #10 回归）', () => {
  const source = read('index.js')
  assert.match(source, /const \{ comments, checklist, cases, \.\.\.rest \} = task/, '应该先留原对象、再解构出 rest')
  assert.match(source, /\.\.\.publicComments\(task\)/, 'publicComments 要拿原对象')
  assert.ok(!/\.\.\.publicComments\(rest\)/.test(source), '不能把 rest 传给统计函数')
  assert.ok(!/\.\.\.publicChecklist\(rest\)/.test(source), '不能把 rest 传给统计函数')
})

test('config: reviewGate 四处齐活（默认值 / mergeConfig / publicConfig / applyConfig patch）', () => {
  const domain = read('src/host/domain.js')
  const index = read('index.js')
  assert.match(domain, /reviewGate: \{ enabled: true, columns: \['test'\] \}/, '默认配置里要有（否则默认关）')
  assert.match(domain, /reviewGate: sanitizeReviewGate\(/, 'mergeConfig 里要归一（否则重启被抹掉）')
  assert.match(index, /reviewGate: config\.reviewGate,/, 'publicConfig 要下发（否则面板看不到）')
  assert.match(index, /patch\.reviewGate !== undefined/, 'applyConfig 的 patch 白名单要认（否则 /config 返回 200 但什么都没改）')
})

test('governance 面板：评审闸门必须渲染在「列的负责人」里，不是别处（真机踩过）', () => {
  const source = read('web/src/studio/panels/governance.js')
  const columns = source.indexOf('export function ColumnsPanel')
  const storage = source.indexOf('export function StoragePanel')
  const review = source.indexOf("'data-review-gate'")
  assert.ok(columns >= 0 && storage >= 0, '两个面板函数都应该存在')
  assert.ok(columns < storage, 'ColumnsPanel 在前、StoragePanel 在后')
  assert.ok(review > columns && review < storage,
    `data-review-gate 应该落在 ColumnsPanel 里（${columns} < ${review} < ${storage}），`
    + '误插到 StoragePanel 时视野里根本看不到它，而 reviewEnabled 在那里还不存在')
})
