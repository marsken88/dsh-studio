import { readFileSync } from 'node:fs'
import { automationRate, requirementInterventions } from '../src/host/intervention.js'

/* 现场算一遍：人工介入点与自动化率。
 *   node tools/report-intervention.mjs [state.json]
 * 不给文件就读 STUDIO_STATE 指向的文件；都没有就提示用法。 */
const file = process.argv[2] ?? process.env.STUDIO_STATE ?? ''
if (file === '') {
  console.error('用法：node tools/report-intervention.mjs <state.json>\n       （state.json 是 GET /studio-api/state 的响应。该接口要求已登录的浏览器会话，\n        裸 curl 会 401；脚本可用 tools/lib/studio-auth.mjs 换 cookie 再取）')
  process.exit(2)
}

const raw = JSON.parse(readFileSync(file, 'utf8'))
const state = raw.state ?? raw
const requirements = state.requirements ?? []
const delivered = requirements
  .filter(requirement => ['done', 'released', 'delivered'].includes(String(requirement.status ?? '')))
  .map(requirement => requirement.id)

console.log(`需求 ${requirements.length} 条 · 已交付 ${delivered.length} 条 · 卡 ${(state.tasks ?? []).length} 张\n`)
for (const requirement of requirements.slice(0, 10)) {
  const summary = requirementInterventions(state, requirement, state.config)
  const who = summary.actors.slice(0, 3).join('、') || '—'
  console.log(
    ` ${String(requirement.code ?? requirement.id).padEnd(14)} ${String(requirement.status ?? '').padEnd(10)}`
    + ` 卡 ${String(summary.tasks).padStart(2)} · 人工介入 ${String(summary.interventions).padStart(3)} · ${who}`,
  )
}

const rate = automationRate(state, delivered, state.config)
console.log('')
console.log(rate.rate === null
  ? '自动化率：无数据（还没有已交付的需求）'
  : `自动化率：${(rate.rate * 100).toFixed(0)}%（${rate.untouched}/${rate.delivered} 条需求零人工介入）`)
if ((rate.unknown ?? 0) > 0) {
  console.log(`另有 ${rate.unknown} 个介入点来源不明（旧记录只写了角色名，既算不了人也不算 AI）`)
}
