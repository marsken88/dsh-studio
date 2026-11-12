#!/usr/bin/env node
/* Boot a copy of a real Studio database locally.

   Motivated by a stretch of deploys where the service 502'd only on the real
   data path (`sanitizeRelease` / `canonicalAuthor` / `ROLE_LABELS` were used
   before they were imported). `node --check` cannot see that class of bug, and
   an empty temp database does not exercise `#load()` deeply enough — this
   script copies the production `.db`/`-wal`/`-shm` trio into a scratch
   directory and runs the exact startup path against it.

   Usage:
     node scripts/smoke-store.mjs ~/.dsh/dsh-studio.db
     npm run smoke:store -- /tmp/dsh-studio-backup-20261111-231911.db

   Exits non-zero when the store cannot boot or reports no state. */

import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SecretStore, StudioStore } from '../src/host/store.js'

const given = process.argv[2]
if (!given) {
  console.error('usage: node scripts/smoke-store.mjs <path-to-dsh-studio.db|.json>')
  process.exit(2)
}

const source = resolve(given.replace(/^~(?=$|[\\/])/, homedir()))
const dbSource = source.endsWith('.json') ? source.replace(/\.json$/, '.db') : source
if (!existsSync(dbSource)) {
  console.error(`✖ database not found: ${dbSource}`)
  process.exit(2)
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-smoke-'))
const copied = []
try {
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${dbSource}${suffix}`
    if (!existsSync(from)) continue
    await copyFile(from, join(dir, `smoke.db${suffix}`))
    copied.push(`smoke.db${suffix}`)
  }

  const store = new StudioStore(join(dir, 'smoke.json'), {
    dbFile: join(dir, 'smoke.db'),
    secrets: new SecretStore(join(dir, 'smoke-secrets.json')),
  })
  await store.ready
  await store.chain

  const state = store.snapshot()
  const summary = {
    engine: typeof store.describe === 'function' ? store.describe().engine : store.engine,
    revision: state.revision,
    tasks: (state.tasks ?? []).length,
    requirements: (state.requirements ?? []).length,
    releases: (state.releases ?? []).length,
    audit: (state.audit ?? []).length,
    experts: (state.config?.experts ?? []).length,
    columns: Object.keys(state.config?.columns ?? {}).length,
    files: copied,
  }
  console.log(JSON.stringify(summary))

  if (!summary.tasks && !summary.requirements) {
    console.error('✖ store booted but carries no tasks or requirements — wrong database?')
    process.exitCode = 1
  } else {
    console.log(`✓ ${summary.engine} store booted from ${dbSource}`)
  }
  store.db?.close?.()
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}
