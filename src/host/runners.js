// 用例执行器的注册表：谁认领这条用例、怎么跑，都挂在这里。
// 加一种新执行方式（DB 断言、浏览器、脚本）= 写一个模块 + registerRunner()，不用再动 runOneCase。
const registry = []

/** @param kind 名字（http / shell / 以后的自定义类型）
 *  @param match 判断这条用例归我跑
 *  @param run   真正执行，签名 (item, env, config, seedVars) => { ok, status, ms, error, preview }
 */
export function registerRunner(kind, { match, run }) {
  if (typeof match !== 'function' || typeof run !== 'function') throw new Error('registerRunner 需要 match 与 run')
  const at = registry.findIndex(entry => entry.kind === kind)
  const entry = { kind, match, run }
  if (at >= 0) registry[at] = entry
  else registry.unshift(entry)
  return entry
}

export function pickRunner(item) {
  return registry.find(entry => {
    try { return entry.match(item) === true } catch { return false }
  }) ?? null
}

export function runnerKinds() {
  return registry.map(entry => entry.kind)
}
