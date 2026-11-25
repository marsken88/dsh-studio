import { readFileSync } from 'node:fs'
import { COVERAGE_TARGET, coverageStrength } from '../src/host/case-strength.js'
import { launchTokenFromEnv, studioFetch } from './lib/studio-auth.mjs'

/* 现场算用例强度：多少条能真的验、多少条只是标题。
 *
 *   node tools/report-case-strength.mjs http://<host>:18080      # 直接打接口（推荐）
 *   node tools/report-case-strength.mjs <cases.json>             # 用 /cases 的返回存成的文件
 *
 * 打接口那一支要带 STUDIO_TOKEN（`/studio-api` 过宿主的信任栅栏，脚本得用 dsh web 的启动 token 换 cookie）；
 * 读本地 json 文件不需要：
 *   STUDIO_TOKEN=<dsh web 启动 token> node tools/report-case-strength.mjs http://<host>:18080
 *
 * 注意：**不能**拿 /state 里的 task.cases 算 —— 那是空数组，正文不随轮询下发
 * （见 domain.js 的 publicCases：只给 caseSummary 计数，抽屉打开时才取正文）。
 * 第一版就是这么读的，得出「全库 0 条用例」的错误结论。真正的数据源是 POST /cases。
 */
const target = process.argv[2] ?? process.env.STUDIO_BASE ?? ''
if (target === '') {
  console.error('用法：node tools/report-case-strength.mjs http://<host>:18080  或  <cases.json>')
  process.exit(2)
}

let payload
if (/^https?:\/\//.test(target)) {
  const api = studioFetch(target.replace(/\/$/, ''), launchTokenFromEnv())
  const response = await api('/studio-api/cases', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  if (!response.ok) {
    console.error(`取用例失败：HTTP ${response.status}`)
    process.exit(1)
  }
  payload = await response.json()
} else {
  payload = JSON.parse(readFileSync(target, 'utf8'))
}

const cases = payload.cases ?? []
const strength = coverageStrength(cases)
console.log(`跨卡用例 ${strength.total} 条：可执行 ${strength.executable}、只有标题 ${strength.draft}`)
console.log(strength.rate === null
  ? '强度：无数据'
  : `强度：${(strength.rate * 100).toFixed(1)}%（门槛 ${(COVERAGE_TARGET * 100).toFixed(0)}% → ${strength.rate >= COVERAGE_TARGET ? '达标' : '不达标'}）`)

const byTask = new Map()
for (const item of cases) {
  const key = item.taskId ?? item.task ?? '(未知)'
  const bucket = byTask.get(key) ?? []
  bucket.push(item)
  byTask.set(key, bucket)
}
const worst = [...byTask.entries()]
  .map(([taskId, list]) => ({ taskId, ...coverageStrength(list) }))
  .sort((a, b) => b.draft - a.draft)
  .slice(0, 6)
if (worst.length > 0) {
  console.log('\n只有标题最多的卡：')
  for (const item of worst) console.log(` ${String(item.taskId).padEnd(16)} 用例 ${String(item.total).padStart(2)} · 可执行 ${String(item.executable).padStart(2)} · 草稿 ${String(item.draft).padStart(2)}`)
}
