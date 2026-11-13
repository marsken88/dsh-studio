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
  assert.match(bundle, /id:\s*"dsh-studio"/, 'bundle registers under an unexpected module id')
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
    { key: 't1:c1', http: true, requirementId: 'r1', priority: 'p0' },
    { key: 't1:c2', http: false, requirementId: 'r1', priority: 'p0' },
    { key: 't2:c1', http: true, requirementId: 'r2', priority: 'p2' },
    { key: 't3:c1', http: true, requirementId: 'r1', priority: 'p2' },
  ]
  assert.deepEqual(resolveSuiteKeys({ rules: { httpOnly: true } }, cases), ['t1:c1', 't2:c1', 't3:c1'])
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
  assert.deepEqual(trimmedCases.cases, [])
  assert.deepEqual(trimmedCases.caseSummary, { total: 3, pass: 1, fail: 1 })
  const trimmedCheck = publicChecklist(task)
  assert.deepEqual(trimmedCheck.checklist, [])
  assert.deepEqual(trimmedCheck.checkSummary, { done: 2, total: 3 })
  assert.equal(task.cases.length, 3, 'the stored task must not be stripped in place')
})

test('host: comments leave the poll as a count', async () => {
  const { publicComments } = await import('../src/host/domain.js')
  const task = { id: 't1', comments: [{ id: 'c1', body: '一' }, { id: 'c2', body: '二' }] }
  const slim = publicComments(task)
  assert.deepEqual(slim.comments, [], 'bodies must not travel with the poll')
  assert.equal(slim.commentCount, 2)
  assert.deepEqual(publicComments({ id: 't2' }), { comments: [], commentCount: 0 })
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
