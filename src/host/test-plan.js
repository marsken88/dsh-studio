/* 三层测试（单元 / 集成 / 端到端）的口径与判定（纯函数）。
 *
 * 背景：测试专家以前只被要求「写带断言的可执行用例」，于是绝大多数卡只有一条
 * 打接口的 http 用例 —— 代码里的分支（单元）和页面上的真实操作（端到端）没人验，
 * 「用例全绿」依旧不代表这张卡真的被全面验证过。
 *
 * 这里把「三条线」变成可计算的东西：
 *   1. 每条用例有一个 tier（单元 / 集成 / 端到端 / 其它），没写就按断言推断；
 *   2. 每条线的进度（总数 / 可执行 / 通过 / 失败 / 没跑）从用例算出，不另存一份；
 *   3. 三条线要么**有可执行用例**，要么由测试专家在测试计划里写明「不适用 + 理由」；
 *      两者都没有就是缺口，卡上看得见、准出也会被拦（config.caseGate.tiers === false 可关）。
 *
 * 为什么「不适用」要写理由：没有它，缺口和「考虑过但确实不需要」长得一模一样，
 * 门禁只会在不该拦的时候拦，然后被整条关掉。
 */
import { isExecutable } from './case-strength.js'

/** 用例的测试层级。other = 有可执行断言但不属于这三层的（例如一次性脚本探针）。 */
export const CASE_TIERS = ['unit', 'integration', 'e2e', 'other']

export const TIER_LABEL = {
  unit: '单元测试',
  integration: '集成测试',
  e2e: '端到端测试',
  other: '其它',
}

/** 参与「要么有用例、要么写明不适用」判定的三层。 */
export const REQUIRED_TIERS = ['unit', 'integration', 'e2e']

/** 显式 tier：只认四个值，其余一律当「没写」（交给推断）。 */
export function sanitizeTier(raw) {
  const value = String(raw ?? '').trim().toLowerCase()
  return CASE_TIERS.includes(value) ? value : ''
}

// 端到端优先判：`npm run test:e2e` 同时长得像单测命令，先命中 e2e 才不会被误判成单元。
const E2E_PATTERN = /(playwright|cypress|selenium|webdriver|puppeteer|testcafe|nightwatch|codecept|\be2e\b|端到端)/i
// 单元测试的常见跑法：命令里出现这些 runner 就按单元处理。
const UNIT_PATTERN = /(node\s+--test|jest|vitest|mocha|\bava\b|\btap\b|pytest|py\.test|unittest|go\s+test|cargo\s+test|mvn\s+[^&|]*test|gradle\s+[^&|]*test|dotnet\s+test|phpunit|rspec|mix\s+test|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+(run\s+)?test|bun\s+test|make\s+test|tox\b)/i
// 用 curl / http 打接口的 shell 用例，本质是集成。
const INTEGRATION_PATTERN = /(\bcurl\b|httpie|wget\s+.*--header|\bhttp\s+(GET|POST|PUT|PATCH|DELETE)\b)/i

/** 从用例的可执行定义推断层级：浏览器 → 端到端；接口/数据库 → 集成；shell 看命令。 */
export function inferTier(item) {
  const one = item !== null && typeof item === 'object' ? item : {}
  const browser = one.browser
  if (browser !== null && browser !== undefined && typeof browser === 'object' && String(browser.url ?? '').trim() !== '') return 'e2e'
  const http = one.http
  if (http !== null && http !== undefined && typeof http === 'object') {
    const steps = Array.isArray(http.steps) ? http.steps : []
    if (String(http.url ?? '').trim() !== '' || steps.length > 0) return 'integration'
  }
  if (one.db !== null && one.db !== undefined && typeof one.db === 'object') return 'integration'
  const command = String(one.shell?.command ?? '')
  if (command.trim() !== '') {
    if (E2E_PATTERN.test(command)) return 'e2e'
    if (UNIT_PATTERN.test(command)) return 'unit'
    if (INTEGRATION_PATTERN.test(command)) return 'integration'
  }
  return 'other'
}

/** 这条用例的层级：显式写的优先，没写按断言推断。 */
export function tierOf(item) {
  const explicit = sanitizeTier(item?.tier)
  return explicit === '' ? inferTier(item) : explicit
}

/** 每条线一行进度。顺序固定（单元 → 集成 → 端到端 → 其它），界面不用再排。 */
export function tierRows(cases) {
  const list = Array.isArray(cases) ? cases : []
  const rows = new Map(CASE_TIERS.map(tier => [tier, {
    tier,
    label: TIER_LABEL[tier],
    total: 0,
    executable: 0,
    pass: 0,
    fail: 0,
    pending: 0,
    skip: 0,
  }]))
  for (const item of list) {
    const row = rows.get(tierOf(item))
    if (row === undefined) continue
    row.total += 1
    if (isExecutable(item)) row.executable += 1
    const result = String(item?.result ?? 'pending')
    if (result === 'pass') row.pass += 1
    else if (result === 'fail') row.fail += 1
    else if (result === 'skip') row.skip += 1
    else row.pending += 1
  }
  return [...rows.values()]
}

/** 测试计划：哪一层确实不适用（必须是理由，不是空标记）。 */
export function sanitizeTestPlan(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  const excluded = {}
  const source = raw.excluded !== null && typeof raw.excluded === 'object' ? raw.excluded : {}
  for (const tier of REQUIRED_TIERS) {
    const reason = String(source[tier] ?? '').trim().slice(0, 300)
    if (reason !== '') excluded[tier] = reason
  }
  const by = String(raw.by ?? '').slice(0, 40)
  const at = Number(raw.at) || 0
  if (Object.keys(excluded).length === 0 && by === '' && at === 0) return null
  return { excluded, by, at }
}

/**
 * 三条线的完整进度：每层带上 applicable / reason，
 * 以及整体合计。判断用 `testPlanGaps`，展示用这里的数字。
 */
export function testPlanSummary(cases, plan) {
  const safePlan = sanitizeTestPlan(plan)
  const excluded = safePlan?.excluded ?? {}
  const tiers = tierRows(cases).map(row => {
    const reason = String(excluded[row.tier] ?? '')
    return {
      ...row,
      applicable: REQUIRED_TIERS.includes(row.tier) ? reason === '' : false,
      reason,
    }
  })
  const sum = key => tiers.reduce((total, row) => total + row[key], 0)
  const total = sum('total')
  const executable = sum('executable')
  const pass = sum('pass')
  const fail = sum('fail')
  return {
    tiers,
    total,
    executable,
    pass,
    fail,
    pending: sum('pending'),
    skip: sum('skip'),
    rate: total === 0 ? null : executable / total,
    gaps: testPlanGaps(tiers),
  }
}

/** 缺口：该有可执行用例、却没有的那几条线（不适用 = 没缺口，所以别把「没写」当「不适用」）。 */
export function testPlanGaps(tiers) {
  const list = Array.isArray(tiers) ? tiers : []
  return list
    .filter(row => REQUIRED_TIERS.includes(row.tier) && row.applicable === true && Number(row.executable ?? 0) === 0)
    .map(row => ({
      tier: row.tier,
      label: TIER_LABEL[row.tier] ?? row.tier,
      total: Number(row.total ?? 0),
      why: Number(row.total ?? 0) === 0
        ? '一条用例都没有'
        : `${row.total} 条用例都跑不了（只有标题，或没有可执行断言）`,
    }))
}

/** 一句话进度，给提示词与卡面用：`单元测试 1/2 · 集成测试 0/0 · 端到端测试 不适用（只改后端）`。 */
export function planLine(summary) {
  const rows = Array.isArray(summary?.tiers) ? summary.tiers : []
  return rows
    .filter(row => REQUIRED_TIERS.includes(row.tier))
    .map(row => (row.applicable === false
      ? `${TIER_LABEL[row.tier]} 不适用（${row.reason || '没写理由'}）`
      : `${TIER_LABEL[row.tier]} 通过 ${row.pass}/${row.total}${row.executable < row.total ? `（可执行 ${row.executable}）` : ''}`))
    .join(' · ')
}

/** 门禁用的一句话：缺哪几层、怎么补。 */
export function gapMessage(gaps) {
  const list = Array.isArray(gaps) ? gaps : []
  if (list.length === 0) return ''
  const names = list.map(gap => `${gap.label}（${gap.why}）`).join('、')
  return `三条测试线还有缺口：${names}。每条线要么用 studio_task_add_cases 补一条能跑的用例（tier=unit / integration / e2e），要么用 studio_task_test_plan 写明这一层为什么验不了`
}

/**
 * 把一串「哪一层不适用」的声明合到测试计划上（工具与 HTTP 路由共用这一份）。
 * 声明形如 [{tier:'e2e', applicable:false, reason:'只改后端接口'}]；
 * applicable=true 表示恢复为适用（清掉理由）。有一条不合法就整体不写，错误逐条返回。
 */
export function applyTierDeclarations(plan, declarations, meta = {}) {
  const current = sanitizeTestPlan(plan) ?? { excluded: {}, by: '', at: 0 }
  const excluded = { ...current.excluded }
  const errors = []
  let changed = 0
  for (const raw of Array.isArray(declarations) ? declarations : []) {
    const item = raw !== null && raw !== undefined && typeof raw === 'object' ? raw : {}
    const tier = String(item.tier ?? '').trim().toLowerCase()
    if (!CASE_TIERS.includes(tier)) {
      errors.push(`不认识的测试层级「${String(item.tier ?? '')}」：只认 ${CASE_TIERS.join(' / ')}`)
      continue
    }
    if (item.applicable === true) {
      if (excluded[tier] !== undefined) {
        delete excluded[tier]
        changed += 1
      }
      continue
    }
    if (!REQUIRED_TIERS.includes(tier)) {
      errors.push(`「${TIER_LABEL[tier] ?? tier}」本来就不在三条线里，不用声明不适用`)
      continue
    }
    const reason = String(item.reason ?? '').trim().slice(0, 300)
    if (reason === '') {
      errors.push(`「${TIER_LABEL[tier]}」声明不适用必须写理由：这一层为什么验不了（例如本次只改后端接口，没有前端改动）`)
      continue
    }
    if (excluded[tier] !== reason) {
      excluded[tier] = reason
      changed += 1
    }
  }
  if (errors.length > 0 || changed === 0) {
    return { plan: current, errors, changed: 0 }
  }
  return {
    plan: sanitizeTestPlan({ excluded, by: String(meta.by ?? current.by ?? '').slice(0, 40), at: Number(meta.at) || Date.now() }),
    errors,
    changed,
  }
}

/** 这张卡是不是「该测三层」的卡：产品/设计类的卡不受这条约束。 */
export function needsTierPlan(task) {
  return ['dev', 'test', 'bug'].includes(String(task?.type ?? ''))
}

/**
 * `/state` 用的用例摘要：总数 / 通过 / 失败 + 每层的小结（对象，不是数组）。
 * 放在这里而不是 domain.js：domain.js 有 2000 行闸门，而这个形状本来就是测试口径的一部分。
 * `caseTiers` 让卡面不点开抽屉也能显示「缺单元 / 缺端到端」。
 */
export function publicCases(task) {
  const cases = Array.isArray(task?.cases) ? task.cases : []
  const pass = cases.filter(item => item.result === 'pass').length
  const fail = cases.filter(item => item.result === 'fail').length
  const plan = testPlanSummary(cases, task?.testPlan)
  const caseTiers = Object.fromEntries(plan.tiers.map(row => [row.tier, {
    total: row.total,
    executable: row.executable,
    pass: row.pass,
    fail: row.fail,
    pending: row.pending,
    applicable: row.applicable,
    reason: row.reason,
  }]))
  return { caseSummary: { total: cases.length, pass, fail }, caseTiers }
}
