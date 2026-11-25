// #127：清掉「卡已经不在台账里」的派单会话目录（幽灵会话），先报告、--apply 才删。
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdirSync, statSync, rmSync } from 'node:fs'
import { parseStudioSession } from '../src/host/agent-feed.js'
import { launchTokenFromEnv, studioFetch } from './lib/studio-auth.mjs'

const apply = process.argv.includes('--apply')
const BASE = process.env.STUDIO_BASE ?? 'http://192.168.120.218:18080'
/* `/studio-api` 过宿主的信任栅栏：没有已认证的浏览器会话就 401。以前这里发
   `authorization: Bearer …`——宿主只认 cookie，那头发过去从来没被认过。 */
const TOKEN = launchTokenFromEnv()
const state = TOKEN === ''
  ? null
  : (await (await studioFetch(BASE, TOKEN)('/studio-api/state')).json()).state
const alive = new Set((state?.tasks ?? []).map(task => task.id))
const sessionsRoot = join(homedir(), '.dsh', 'sessions')
let dirs = []
try {
  for (const workspace of readdirSync(sessionsRoot)) {
    const dir = join(sessionsRoot, workspace)
    try { if (!statSync(dir).isDirectory()) continue } catch { continue }
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('studio-')) continue
      const parsed = parseStudioSession(name)
      if (parsed === null) continue
      const size = dirSize(join(dir, name))
      dirs.push({ workspace, name, full: join(dir, name), taskId: parsed.taskId, expertId: parsed.expertId, size })
    }
  }
} catch { /* 没有 sessions 目录 */ }

function dirSize(target) {
  let total = 0
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const full = join(target, entry.name)
    if (entry.isDirectory()) total += dirSize(full)
    else { try { total += statSync(full).size } catch { /* ignore */ } }
  }
  return total
}

const ghosts = dirs.filter(item => state !== null && !alive.has(item.taskId))
const totalSize = ghosts.reduce((sum, item) => sum + item.size, 0)
console.log(`扫描 ${dirs.length} 个派单会话目录，其中「卡已不存在」的 ${ghosts.length} 个，共 ${(totalSize / 1024 / 1024).toFixed(1)} MB`)
for (const ghost of ghosts.sort((a, b) => b.size - a.size).slice(0, 20)) {
  console.log(`  ${ghost.name.padEnd(44)} ${(ghost.size / 1024 / 1024).toFixed(1)} MB  (卡 ${ghost.taskId} 不存在)`)
}
if (!apply) {
  console.log('（只预览；加 --apply 才会删。删之前确认这些卡确实不在台账里）')
  process.exit(0)
}
for (const ghost of ghosts) {
  try { rmSync(ghost.full, { recursive: true, force: true }); console.log(`已删 ${ghost.name}`) }
  catch (error) { console.log(`删不掉 ${ghost.name}: ${error.message}`) }
}
