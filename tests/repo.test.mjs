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
  for (const file of ['index.js', 'client.src.js']) {
    assert.ok(!/model:\s*'deepseek-v4-pro'|model:\s*"deepseek-v4-pro"/.test(read(file)), `${file} still assigns deepseek-v4-pro (503 No available channel)`)
  }
  assert.ok(read('index.js').includes('FALLBACK_AGENT_MODEL'), 'FALLBACK_AGENT_MODEL guard is missing')
})

test('state schema migration is versioned', () => {
  const host = read('index.js')
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
