import test from 'node:test'
import assert from 'node:assert/strict'
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
  const names = [...read('index.js').matchAll(/name:\s*'(studio_[a-z_]+)'/g)].map((m) => m[1])
  assert.ok(names.length >= 30, `expected at least 30 studio tools, found ${names.length}`)
  assert.equal(new Set(names).size, names.length, 'duplicate studio tool name')
})

test('host: no model is hardcoded to a channel-less default', () => {
  for (const file of hostSources) {
    assert.ok(!/model:\s*'deepseek-v4-pro'|model:\s*"deepseek-v4-pro"/.test(read(file)), `${file} still assigns deepseek-v4-pro (503 No available channel)`)
  }
  assert.ok(hostText.includes('FALLBACK_AGENT_MODEL'), 'FALLBACK_AGENT_MODEL guard is missing')
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
  assert.ok(lines < 6900, `index.js is still ${lines} lines; keep splitting by domain`)
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
  const ui = read('web/src/components/studio-ui.jsx')
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
