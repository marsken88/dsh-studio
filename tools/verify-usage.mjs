// 用量自证：拿原始会话日志现算一遍 token，和 /costs 报的数字对一对。
// /costs 走的是 session-usage.js（zstd 解压 + 按 mtime 缓存 + 过滤会话名），这里走「ssh 取原文 + usage.js 解析」，
// 两条路径不同，对上才说明没有重复计、没有漏计。
//
// 关于鉴权：`/studio-api` 过宿主的信任栅栏，没有已认证的浏览器会话一律 401。
// 脚本没有浏览器，得用 dsh web 的启动 token 换 cookie —— 所以现在还要给 STUDIO_TOKEN：
//   STUDIO_TOKEN=<dsh web 启动 token> STUDIO_BASE=http://<host>:18080 node tools/verify-usage.mjs [taskId]
import { Client } from 'ssh2'
import { parseUsageLines, summarizeUsage } from '../src/host/usage.js'
import { launchTokenFromEnv, studioFetch } from './lib/studio-auth.mjs'

const BASE = process.env.STUDIO_BASE ?? 'http://192.168.120.218:18080'
const api = studioFetch(BASE, launchTokenFromEnv())
const HOST = process.env.DSH_DEPLOY_HOST ?? '192.168.120.218'
const USER = process.env.DSH_DEPLOY_USER ?? 'lyf'
const PASS = process.env.DSH_DEPLOY_PASSWORD ?? ''

const sshExec = (command) => new Promise((resolve, reject) => {
  const client = new Client()
  client.on('ready', () => {
    client.exec(command, (error, stream) => {
      if (error) { client.end(); reject(error); return }
      let out = ''
      stream.on('data', (chunk) => { out += chunk })
      stream.on('close', () => { client.end(); resolve(out) })
    })
  }).on('error', reject)
  client.connect({ host: HOST, username: USER, password: PASS, readyTimeout: 15000 })
})

const costs = await (await api('/studio-api/costs')).json()
const cards = costs.usage?.cards ?? []
if (cards.length === 0) { console.log('没有可核对的卡（/costs 没有 usage.cards）'); process.exit(1) }
const target = process.argv[2] ?? cards[0].taskId
const reported = cards.find((card) => card.taskId === target)
if (reported === undefined) { console.log('这张卡不在 /costs 的列表里：' + target); process.exit(1) }

console.log('核对卡：' + target + '（' + (reported.code || '无编号') + ' ' + String(reported.title).slice(0, 24) + '）')
const raw = await sshExec('zstd -dc ~/.dsh/sessions/*/studio-' + target + '-*/session.v4.jsonl.zstd 2>/dev/null | wc -c; echo ---; zstd -dc ~/.dsh/sessions/*/studio-' + target + '-*/session.v4.jsonl.zstd 2>/dev/null')
const [head, ...rest] = raw.split('---\n')
const body = rest.join('---\n')
if (body.trim() === '') { console.log('远端没有这张卡的会话日志（或 zstd 不可用）'); process.exit(1) }

const parsed = parseUsageLines(body.split('\n'))
const local = summarizeUsage(parsed)
const rows = [
  ['调用次数', local.calls, reported.calls],
  ['输入 token', local.input, reported.input],
  ['输出 token', local.output, reported.output],
  ['缓存读 token', local.cacheRead, reported.cacheRead],
  ['合计 token', local.total, reported.total],
]
let bad = 0
for (const [name, mine, theirs] of rows) {
  const ok = mine === theirs
  if (!ok) bad += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + name + '：现算 ' + mine + ' / 接口 ' + theirs)
}
console.log(bad === 0 ? '\n一致（日志 ' + Number(head.trim()).toLocaleString() + ' 字节）' : '\n不一致：' + bad + ' 项对不上')
process.exit(bad === 0 ? 0 : 1)
