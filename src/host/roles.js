/* 角色位（岗位）白名单：谁算「产品 / 架构 / 研发 / 测试 / 运营」，以及公司自己加的岗位。
 *
 * 为什么单独成模块：
 *   1. domain.js 有 2000 行闸门，角色规则是**命中规则**不是数据形状，放这里更清楚；
 *   2. 角色白名单要同时被 domain（专家/列的清洗）、dispatcher（列负责人解析）、
 *      executor（卡片 role 校验）、面板（下拉选项）读，放在一处才不会再出现「三处各写一份」。
 *
 * 历史教训（issue #150）：白名单以前写死成四个（product/architect/dev/qa），
 * 写 `role:'ops'` 会被 sanitizeExperts 静默清空成 ''，于是运营岗永远进不了任何角色位候选池；
 * 而且 200 返回、没有警告，配的人以为配好了。现在：
 *   - 白名单是 config.roles（默认四岗 + 运营），公司可以加 finance / support 之类；
 *   - 非法值由调用方**报错并列出可选值**，不再静默丢弃。
 */
import { DEFAULT_ROLES } from './role-playbooks.js'

/** 默认角色位：四个交付岗 + 运营（ops）。缺省白名单，也是 config.roles 的兜底。 */
export const ROLE_IDS = ['product', 'architect', 'dev', 'qa', 'ops']

/** 角色 id 的合法形状：自定义岗位（finance / ops-lead…）也按这个校验。 */
export const ROLE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/**
 * 角色白名单：config.roles 优先，非法值丢弃；一个都不剩就退回默认（四岗 + 运营）。
 * 所有「这个 role 认不认识」的判断都应该过这里，别再各自写 ROLE_IDS.includes。
 */
export function sanitizeRoles(input) {
  const list = (Array.isArray(input) ? input : [])
    .map(raw => String(raw ?? '').trim().toLowerCase())
    .filter(id => ROLE_ID_PATTERN.test(id))
    .filter((id, index, all) => all.indexOf(id) === index)
    .slice(0, 12)
  return list.length > 0 ? list : [...ROLE_IDS]
}

/** 一组角色 id（或一份配置）→ 白名单数组。传 config 时读 config.roles。 */
export function roleIdsOf(source) {
  if (Array.isArray(source)) return sanitizeRoles(source)
  const list = source !== null && typeof source === 'object' ? source.roles : undefined
  return sanitizeRoles(list)
}

/** 列负责人（含候选池）里用到的角色位 id：删角色/改白名单前先看还在不在用。 */
export function rolesInColumns(columns) {
  const out = new Set()
  for (const raw of Object.values(columns ?? {})) {
    if (raw === null || typeof raw !== 'object') continue
    if (raw.kind === 'role' && String(raw.id ?? '') !== '') out.add(String(raw.id))
    if (Array.isArray(raw.members)) {
      for (const member of raw.members) {
        if (member?.kind === 'role' && String(member.id ?? '') !== '') out.add(String(member.id))
      }
    }
  }
  return [...out]
}

/**
 * 角色展示名：内置角色有文案；config.roles 里新加的自定义岗位没有内置文案时显示 id 本身，
 * 不再因为 DEFAULT_ROLES 里查不到而抛错（以前是 `DEFAULT_ROLES[role].label`，自定义角色直接炸）。
 */
export const ROLE_LABELS = Object.fromEntries(
  [...new Set([...ROLE_IDS, ...Object.keys(DEFAULT_ROLES)])].map(role => [role, DEFAULT_ROLES[role]?.label ?? role]),
)

/** 按配置里的角色白名单生成「id → 展示名」，给面板与派单文案用。 */
export function roleLabelsFor(roles) {
  const out = { ...ROLE_LABELS }
  for (const role of roleIdsOf(roles)) if (out[role] === undefined) out[role] = role
  return out
}
