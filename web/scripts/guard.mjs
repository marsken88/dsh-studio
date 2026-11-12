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
  ...walk(join(web, 'src'), ['.js', '.jsx', '.css']),
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
  }
}

if (failures.length > 0) {
  console.error(`✖ ui guard (${mode}) failed with ${failures.length} issue(s):`)
  for (const item of failures) console.error('  - ' + item)
  process.exit(1)
}

console.log(`✓ ui guard (${mode}) — ${sourceFiles.length} source files, ${portalCount} Radix portals`)
