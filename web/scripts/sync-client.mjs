// Copies the built browser bundle to the plugin root.
//
// The plugin's client entry is `./client.js` at the package root (see the
// "./client" export in package.json), while Vite writes to web/dist/client.js.
// Keeping the two in sync means a fresh clone is installable as-is, and the
// deployed layout stays `client.js` next to `index.js`.
import { copyFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const from = resolve(here, '../../dist/client.js')
const to = resolve(here, '../../client.js')

copyFileSync(from, to)
console.log(`sync-client: ${statSync(to).size} bytes -> client.js`)
