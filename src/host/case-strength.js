/* 用例强度（纯函数）：一条用例到底能不能"验"。
 *
 * 背景（会诊共识）：现在的用例生成是字符串模板 —— 一条验收条件 = 一个用例标题，
 * 没有验收条件就给一条"主流程"。于是「用例全绿」不代表验过，门禁强度是虚高的。
 *
 * 这里不做生成（那需要模型），只做**度量与判定**：
 * 一条用例只有带可执行断言（http / shell / db）才算"能验"，否则只是草稿。
 * 产品定义第 8 条要求带可执行断言的用例占比 ≥ 60%，这张尺子就是它。
 */

/** 这条用例带没带可执行的断言。 */
export function isExecutable(testCase) {
  const item = testCase ?? {}
  const http = item.http
  if (http !== null && typeof http === 'object') {
    if (String(http.url ?? '').trim() !== '') return true
    /* 多步用例常常只写 steps、不写顶层 url（顶层只是第一步的重复）。
       以前这种直接判成草稿 —— 明明跑得动、也会真开缺陷卡，覆盖率却不认它。 */
    const steps = Array.isArray(http.steps) ? http.steps : []
    if (steps.length > 0 && steps.every(step => String(step?.url ?? '').trim() !== '')) return true
  }
  const shell = item.shell
  if (shell !== null && typeof shell === 'object' && String(shell.command ?? '').trim() !== '') return true
  if (item.db !== null && item.db !== undefined && typeof item.db === 'object') return true
  // 浏览器用例：有地址就算能跑（真开页面断言看得见的东西）
  const browser = item.browser
  if (browser !== null && typeof browser === 'object' && String(browser.url ?? '').trim() !== '') return true
  return false
}

/** 一批用例的强度：总数、可执行数、占比（没有用例时是 null，不是 0）。 */
export function coverageStrength(cases) {
  const list = Array.isArray(cases) ? cases : []
  const executable = list.filter(isExecutable).length
  return {
    total: list.length,
    executable,
    draft: list.length - executable,
    rate: list.length === 0 ? null : executable / list.length,
  }
}

/** 产品定义第 8 条的门槛。 */
export const COVERAGE_TARGET = 0.6

/** 是否达到门槛。没有用例时返回 null —— 「没数据」和「不达标」必须分开。 */
export function meetsCoverageTarget(cases, target = COVERAGE_TARGET) {
  const strength = coverageStrength(cases)
  if (strength.rate === null) return null
  return strength.rate >= target
}

/** 用例结果：**没有可执行定义就不许标 pass** —— 跑不起来的用例点成通过就是假绿。
 *  规则放这里而不是 domain.js：那边有 2000 行上限，规则也该跟其他判定放一起。 */
export function resolveCaseResult(rawResult, raw) {
  const value = String(rawResult ?? 'pending')
  if (value !== 'pass') return value
  return isExecutable(raw) ? 'pass' : 'pending'
}

/** 去掉标题里的「可执行」标记：`a1 正常除法（可执行）` → `a1 正常除法`。 */
export function stripExecutableMarker(text) {
  return String(text ?? '')
    .trim()
    .replace(/^可执行(?:断言)?[：:]\s*/u, '')
    .replace(/\s*[（(]\s*可执行(?:断言)?\s*[)）]\s*$/u, '')
    .replace(/\s*[-—·]\s*可执行(?:断言)?\s*$/u, '')
    .trim()
}

/** 用例标题归一：判断「这条可执行用例是不是在补一条同名草稿」用。
 *  去掉「可执行」标记、空白和大小写差异；不做模糊匹配，避免把不同断言误合并。 */
export function normalizeCaseTitle(text) {
  return stripExecutableMarker(text).replace(/\s+/gu, '').toLowerCase()
}

/** 从验收条件推断用例：能推断出可执行断言就给出断言，推断不出就标 draft。
 *
 * 以前是「一条验收条件 = 一个只有标题的用例」，全库 101 条里 0 条能跑。
 * 这里做三件不依赖模型的事：
 *   1. 条件里出现 URL（http/https）→ 生成接口用例（GET，断言状态码 200）
 *   2. 条件里出现明显的命令行（以 $ 开头或 含 --flag）→ 生成 shell 用例（需 allowShell）
 *   3. 都不是 → 生成 draft，**不计入覆盖率**
 */
export function draftCasesFromCriteria(criteria, options = {}) {
  const allowShell = options.allowShell === true
  const list = Array.isArray(criteria) ? criteria : []
  const cases = []
  for (const [index, raw] of list.entries()) {
    const text = String(raw ?? '').trim()
    if (text === '') continue
    const title = text.slice(0, 80)
    const url = (text.match(/https?:\/\/[^\s，。；、）)】]+/) ?? [])[0] ?? ''
    if (url !== '') {
      cases.push({
        title: title.slice(0, 60),
        expected: text.slice(0, 300),
        http: { method: 'GET', url, expectStatus: 200, expectContains: '' },
        draft: false,
      })
      continue
    }
    const command = (text.match(/(?:^|\s)\$\s*([^\n]+)/) ?? [])[1] ?? (/(--[a-z][\w-]*)/i.test(text) ? text : '')
    if (allowShell && command !== '') {
      cases.push({
        title: title.slice(0, 60),
        expected: text.slice(0, 300),
        shell: { command: String(command).slice(0, 500), expectExit: 0 },
        draft: false,
      })
      continue
    }
    // 推断不出断言：留着当草稿，但**明确标记**，不冒充已覆盖
    cases.push({ title: title.slice(0, 60), expected: text.slice(0, 300), draft: true, index })
  }
  return cases
}
