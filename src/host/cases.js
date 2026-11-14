// dsh-studio · 跨卡用例的聚合与回归汇总（纯函数，不碰台账）
// 从 domain.js 拆出来：那边有 2000 行的硬上限（tests/repo.test.mjs 会拦）。

/** 一批回归跑完后的汇总记录（写给「最近回归」用，不占 state、不涨 revision）。 */
export function summarizeRun(results, by, at = Date.now()) {
  const rows = Array.isArray(results) ? results : []
  const sum = key => rows.reduce((n, item) => n + (Number(item[key]) || 0), 0)
  return {
    at,
    by: String(by ?? '').slice(0, 40),
    cards: rows.length,
    failedCards: rows.filter(item => item.ok === false).length,
    total: sum('total'),
    passed: sum('passed'),
    failed: sum('failed'),
    bugs: sum('bugs'),
  }
}

/** 把 "taskId:caseId" 的键按卡分组（跨卡回归就是这么拆成一轮一轮跑的）；坏键直接丢掉。 */
export function groupCaseKeys(keys) {
  const byTask = new Map()
  for (const key of Array.isArray(keys) ? keys : []) {
    const raw = String(key ?? '')
    const at = raw.indexOf(':')
    if (at <= 0 || at === raw.length - 1) continue
    const taskId = raw.slice(0, at)
    const caseId = raw.slice(at + 1)
    if (!byTask.has(taskId)) byTask.set(taskId, [])
    byTask.get(taskId).push(caseId)
  }
  return byTask
}

/** 跨卡用例总览：把每张卡上的用例摊成一张表，带上卡片与需求的上下文。纯函数，方便单测。 */
export function collectCases(state) {
  const requirementById = new Map((state?.requirements ?? []).map(item => [item.id, item]))
  const out = []
  for (const task of state?.tasks ?? []) {
    const requirement = requirementById.get(task.requirementId)
    for (const item of task.cases ?? []) {
      out.push({
        key: `${task.id}:${item.id}`,
        id: item.id,
        title: item.title ?? '',
        expected: item.expected ?? '',
        result: item.result ?? 'pending',
        type: item.type ?? 'functional',
        priority: item.priority ?? 'p2',
        pointId: item.pointId ?? '',
        http: item.http !== null && item.http !== undefined,
    shell: item.shell !== null && item.shell !== undefined,
    db: item.db !== null && item.db !== undefined,
    // 能跑的三种：接口 / shell / 数据库。以前界面只认 http，另外两种建得出来却跑不了。
    runnable: item.http != null || item.shell != null || item.db != null,
        lastRunAt: item.lastRun?.at ?? 0,
        // 失败时最想看的三样：错在哪、返回了什么、上一次的结论文案。
        lastError: String(item.lastRun?.error ?? '').slice(0, 300),
        lastStatus: Number(item.lastRun?.status) || 0,
        lastPreview: String(item.lastRun?.preview ?? '').slice(0, 400),
        note: String(item.note ?? '').slice(0, 300),
        taskId: task.id,
        taskTitle: task.title ?? '',
        taskCode: task.code ?? '',
        taskStatus: task.status ?? '',
        requirementId: task.requirementId ?? '',
        requirementTitle: requirement?.title ?? '',
        requirementCode: requirement?.code ?? '',
      })
    }
  }
  return out
}


// ---------------------------------------------------------------- 回归套件
// 套件 = 一组规则（需求 / 优先级 / 是否接口用例）+ 手工挑的用例键。
// 规则在跑的时候才解析成具体用例，所以新加的用例会自动进套件，不用回来改。

const SUITES_KEY = 'suites'

/** 建套件时的默认规则：只跑有 http 定义的，按卡串行。 */
export const SUITE_DEFAULTS = { rules: { requirementIds: [], priorities: [], httpOnly: true }, keys: [] }

/** 套件清洗：名字必有、规则白名单、手工键只留 "taskId:caseId" 形状的。 */
export function sanitizeSuite(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const rules = source.rules !== null && typeof source.rules === 'object' ? source.rules : {}
  const id = String(source.id ?? '').trim() || `suite-${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    name: String(source.name ?? '').trim().slice(0, 40) || '未命名套件',
    note: String(source.note ?? '').slice(0, 200),
    rules: {
      requirementIds: (Array.isArray(rules.requirementIds) ? rules.requirementIds : []).map(String).filter(Boolean).slice(0, 20),
      priorities: (Array.isArray(rules.priorities) ? rules.priorities : [])
        .map(item => String(item).toLowerCase())
        .filter(item => ['p0', 'p1', 'p2', 'p3'].includes(item))
        .slice(0, 4),
      httpOnly: rules.httpOnly !== false,
    },
    keys: (Array.isArray(source.keys) ? source.keys : []).map(String).filter(key => key.includes(':')).slice(0, 200),
    isDefault: source.isDefault === true,
    at: Number(source.at) || Date.now(),
    by: String(source.by ?? '').slice(0, 40),
  }
}

/** 套件解析成具体的用例键（去重）。 */
export function resolveSuiteKeys(suite, cases) {
  const rules = suite?.rules ?? {}
  const requirementIds = Array.isArray(rules.requirementIds) ? rules.requirementIds.map(String) : []
  const priorities = Array.isArray(rules.priorities) ? rules.priorities.map(String) : []
  const httpOnly = rules.httpOnly !== false
  const picked = new Set((Array.isArray(suite?.keys) ? suite.keys : []).map(String))
  const out = new Set()
  for (const row of Array.isArray(cases) ? cases : []) {
    if (picked.has(row.key)) { out.add(row.key); continue }
    if (httpOnly && row.http !== true) continue
    if (requirementIds.length > 0 && !requirementIds.includes(row.requirementId)) continue
    if (priorities.length > 0 && !priorities.includes(row.priority)) continue
    out.add(row.key)
  }
  return [...out]
}

export async function loadSuites(store) {
  const saved = await store.readSide(SUITES_KEY).catch(() => null)
  return Array.isArray(saved) ? saved.map(sanitizeSuite) : []
}

/** 存整套：同一个时刻只允许一个默认套件（夜间跑的就是它）。 */
export async function saveSuites(store, list) {
  const suites = (Array.isArray(list) ? list : []).map(sanitizeSuite)
  const firstDefault = suites.findIndex(item => item.isDefault === true)
  if (firstDefault >= 0) suites.forEach((item, index) => { item.isDefault = index === firstDefault })
  await store.writeSide(SUITES_KEY, suites).catch(() => {})
  return suites
}
