// 卡片编号的规则都在这里（纯函数，只依赖 domain.js 的 CODE_PREFIX）：
//
//   - 需求卡（拆卡产物，type=requirement）=「需求编号-NN」，例如 `REQ-2026-003-01`；
//   - 其它类型按类型前缀在需求内递增：`DEV-001` / `TEST-001` / `BUG-001` / `DES-001` / `OPS-001`；
//   - 老库里的需求卡编号（等于需求编号 / 老的 `REQ-001`）由 migrateRequirementTaskCodes 一次性迁过来。
//
// 三个建号口（建卡 index.js、换需求 executor.js、老库补号 store.js）都走 nextCodeForTask()：
// 规则只写一遍，免得三处各判一次 type、慢慢就长出两套编号（界面上一眼能看出不一致）。
import { CODE_PREFIX } from './domain.js'

/** 同一需求下，DEV-001 / TEST-001 各自递增。 */
export function nextTaskCode(tasks, requirementId, prefix) {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`)
  let max = 0
  for (const task of tasks) {
    if ((task.requirementId ?? '') !== requirementId) continue
    const match = pattern.exec(String(task.code ?? ''))
    if (match !== null) max = Math.max(max, Number(match[1]))
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`
}

/** 需求卡的编号：`<需求编号>-NN`，例如 `REQ-2026-003-01`。
 *
 *  为什么不是「REQ-NN」（老办法）：那样每条需求下第一张卡都叫 REQ-001，7 条需求就有 7 张 REQ-001。
 *  为什么不是「卡号 = 需求编号」（上一版的办法）：同一需求拆出的卡全叫 REQ-2026-003，
 *  界面上分不清是哪一张，云盘交付物文件名（`<卡编号>-<类型>-<标题>.md`）还会互相覆盖。
 *  现在把需求编号整段带上再追加两位序号：卡号唯一、自带需求归属、和需求编号本身一眼可分。 */
export function nextRequirementTaskCode(tasks, requirementId, requirementCode) {
  const base = String(requirementCode ?? '').trim()
  if (base === '' || String(requirementId ?? '') === '') return ''
  const pattern = requirementTaskCodePattern(base)
  let max = 0
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (String(task?.requirementId ?? '') !== String(requirementId)) continue
    const match = pattern.exec(String(task?.code ?? ''))
    if (match !== null) max = Math.max(max, Number(match[1]))
  }
  return `${base}-${String(max + 1).padStart(2, '0')}`
}

/** `<需求编号>-<序号>` 的匹配式（需求编号里可能有点号之类，先转义再拼）。 */
function requirementTaskCodePattern(base) {
  return new RegExp(`^${String(base).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`)
}

/** 一张新卡的编号：需求卡走「需求编号-NN」，其它类型走「TYPE-NNN」。 */
export function nextCodeForTask(tasks, { requirementId = '', requirementCode = '', type = 'requirement' } = {}) {
  if (String(requirementId ?? '') === '') return ''
  return type === 'requirement'
    ? nextRequirementTaskCode(tasks, requirementId, requirementCode)
    : nextTaskCode(tasks, requirementId, CODE_PREFIX[type] ?? 'TASK')
}

/**
 * 老数据迁移：把需求卡的编号从「等于需求编号」或老的 `REQ-001` 改成 `<需求编号>-NN`。
 *
 * - 只动 `type=requirement` 且挂着需求的卡；其它类型（DEV/TEST/BUG…）一根手指都不碰。
 * - 已经符合 `<需求编号>-NN` 的不动：第二次跑返回空数组（幂等），重启多少次结果都一样。
 * - 分配顺序按 `createdAt` 再按 `id`：同一份数据每次跑出来的编号一致，不会今天 A 卡 01、明天变 02。
 * - 返回本次真正改过编号的卡（调用方据此决定要不要提示/落盘）。
 */
export function migrateRequirementTaskCodes(tasks, requirements) {
  const codeOf = new Map()
  for (const req of Array.isArray(requirements) ? requirements : []) {
    const code = String(req?.code ?? '').trim()
    if (code !== '') codeOf.set(String(req?.id ?? ''), code)
  }
  const groups = new Map()
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (task?.type !== 'requirement') continue
    const requirementId = String(task.requirementId ?? '')
    if (!codeOf.has(requirementId)) continue
    if (!groups.has(requirementId)) groups.set(requirementId, [])
    groups.get(requirementId).push(task)
  }
  const changed = []
  for (const [requirementId, list] of groups) {
    const base = codeOf.get(requirementId)
    const pattern = requirementTaskCodePattern(base)
    let max = 0
    const pending = []
    for (const task of list) {
      const match = pattern.exec(String(task.code ?? ''))
      if (match === null) pending.push(task)
      else max = Math.max(max, Number(match[1]))
    }
    pending.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0) || String(a.id).localeCompare(String(b.id)))
    for (const task of pending) {
      max += 1
      task.code = `${base}-${String(max).padStart(2, '0')}`
      changed.push(task)
    }
  }
  return changed
}
