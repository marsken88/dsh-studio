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
  for (const file of ['web/src/studio/markdown.js', 'web/src/studio/format.js']) {
    assert.ok(existsSync(path(file)), file + ' missing')
  }
  const lines = read('client.src.js').split(/\r?\n/).length
  assert.ok(lines < 8100, 'client.src.js is ' + lines + ' lines; keep lifting helpers into web/src/studio')
  const maker = read('web/scripts/make-legacy.mjs')
  for (const spec of ['./studio/markdown.js', './studio/format.js']) {
    assert.ok(maker.includes(spec), 'make-legacy must keep importing ' + spec)
  }
  assert.ok(read('web/src/legacy.js').includes("from './studio/markdown.js'"), 'generated legacy module lost its imports')
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
