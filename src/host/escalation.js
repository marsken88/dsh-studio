/* 派单会话的提权审批：无人值守的会话里，DSH 的 approval 请求必须由平台代答。
 *
 * 为什么要有这一层：DSH 的 permission preset 拆成两件事 —— 沙箱档位（能碰什么）
 * 与审批策略（碰到边界时问不问人）。`workspace-write` 这一类预设默认 approval=ask，
 * 而派单会话没有人实时盯着审批：
 *   · 干等 = 整轮挂死（真机踩过：架构师会话卡在 plugin_manager 审批上三小时，
 *     界面显示「正在跑」、评论一片空白、abort 也解除不了）；
 *   · 一律拒绝 = 正常活也做不成（往工作区外写一个文件、装个插件都被拒，卡上只剩一句提权说明）。
 *
 * 所以由设置决定代答口径：
 *   allow（默认）= 自动批准，等于「始终允许完全访问」，每次放行都写成卡上的评论留痕；
 *   deny        = 自动拒绝，并把被拒的工具与理由写进卡上评论。
 * 沙箱选 read-only 时一律拒绝 —— 选了只读就不该被自动放行成可写。
 */

import { SANDBOX_MODES } from './domain.js'

/** 提权审批的两种口径（写进配置的是这两个值）。 */
export const ESCALATION_MODES = ['allow', 'deny']

/**
 * 这张卡 / 这次会话**实际**用的沙箱档位。
 *
 * 口径（2026-11-26 用户明确要求后改）：
 *   escalation = allow 的语义就是「始终允许完全访问」——那就别再用 workspace-write
 *   一处处边写边审批。DSH 的审批只有 `allowed-once`（逐次放行），
 *   于是无人值守会话每碰一次边界就被重新问一次，agent 自己都在评论里抱怨
 *   「the approval applies only to this call」。所以 allow 直接以 `danger-full-access` 运行。
 *   deny 才把沙箱当边界用（workspace-write / 只读），越界一律拒绝。
 *   只读永远优先：专家的沙箱显式选了 read-only 就不该被 allow 悄悄放大成可写。
 */
export function effectiveSandbox({ expertSandbox, globalSandbox, escalation } = {}) {
  const wanted = String(expertSandbox ?? '').trim() || String(globalSandbox ?? '').trim()
  const base = SANDBOX_MODES.includes(wanted) ? wanted : 'workspace-write'
  if (base === 'read-only') return 'read-only'
  return sanitizeEscalation(escalation) === 'allow' ? 'danger-full-access' : base
}

/** 清洗一个提权审批设置：认不出的值落到 fallback，fallback 也不认得就按 allow。 */
export function sanitizeEscalation(value, fallback = 'allow') {
  const text = String(value ?? '').trim().toLowerCase()
  if (ESCALATION_MODES.includes(text)) return text
  const back = String(fallback ?? '').trim().toLowerCase()
  return ESCALATION_MODES.includes(back) ? back : 'allow'
}

/**
 * 这张卡这一轮实际生效的提权口径。
 * 沙箱：专家自己的设置优先，否则跟随全局；提权：只认全局设置。
 * 只读沙箱一律 deny（自动放行会把「只读」悄悄变成可写）。
 */
export function escalationFor(config, expertId) {
  const agents = config?.agents ?? {}
  const experts = Array.isArray(config?.experts) ? config.experts : []
  const expert = experts.find(item => String(item?.id ?? '') === String(expertId ?? '')) ?? null
  const sandbox = String(expert?.sandbox ?? '').trim() || String(agents.sandbox ?? '').trim() || 'workspace-write'
  const configured = sanitizeEscalation(agents.escalation)
  if (sandbox === 'read-only') {
    return { mode: 'deny', configured, sandbox, reason: '沙箱是只读：提权一律拒绝' }
  }
  return { mode: configured, configured, sandbox, reason: '' }
}

/** DSH 的 approval 结论：allow 给 allowed-once（这一次放行），其余一律拒绝。 */
export function escalationOutcome(mode) {
  return sanitizeEscalation(mode) === 'allow' ? 'allowed-once' : 'rejected'
}
