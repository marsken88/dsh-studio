import { launchTokenFromEnv, studioFetch } from './lib/studio-auth.mjs'

const BASE = 'http://192.168.120.218:18080'
const api = studioFetch(BASE, launchTokenFromEnv())
const post = async (p, b) => { const res = await api('/studio-api' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }); return { status: res.status, body: await res.json().catch(() => ({})) } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const taskId = process.argv[2]
const expert = process.argv[3]
const launch = await post('/agents/run', { id: taskId, expert })
console.log('launch: ' + launch.status + ' ' + JSON.stringify(launch.body).slice(0, 120))
let last = 0
for (let attempt = 0; attempt < 60; attempt += 1) {
  await sleep(15000)
  const state = (await (await api('/studio-api/state')).json()).state
  const task = state.tasks.find(item => item.id === taskId)
  const count = (task?.comments ?? []).length
  if (count > 0 && count === last) { console.log('comments stable at ' + count); break }
  last = count
  if (attempt % 4 === 0) console.log('waiting… ' + (attempt * 15) + 's comments=' + count)
}
const final = (await (await api('/studio-api/state')).json()).state.tasks.find(item => item.id === taskId)
console.log('FINAL comments=' + (final?.comments ?? []).length)
for (const item of (final?.comments ?? []).slice(-2)) console.log('--- ' + item.author + ' | ' + String(item.body).slice(0, 500).replace(/\n/g, ' '))
