/* Roster helpers: turn the configured expert list into pickable items and
   render an owner chip for a column or card. Pure data-in / string-out —
   callers pass the live config, nothing here touches the store. */

import { ROLE_LABEL } from './labels.js'

export function toDateInput(value) {
  if (typeof value !== 'number' || value === 0) return ''
  const date = new Date(value)
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function fromDateInput(text) {
  if (typeof text !== 'string' || text.trim() === '') return 0
  const at = new Date(`${text.trim()}T23:59:00`).getTime()
  return Number.isFinite(at) ? at : 0
}

export function memberLabel(config, member) {
  if (member === undefined || member === null) return ''
  if (member.kind === 'role') return `🎯 ${ROLE_LABEL[member.id] ?? member.id}`
  if (member.kind === 'team') {
    const team = (config.teams ?? []).find(entry => entry.id === member.id)
    return team === undefined ? '' : `👥 ${team.name}`
  }
  const expert = (config.experts ?? []).find(entry => entry.id === member.id)
  return expert === undefined ? (ROLE_LABEL[member.id] ?? String(member.id ?? '')) : `${expert.emoji} ${expert.name}`
}

export function ownerLabel(config, owner) {
  if (owner === undefined || owner === null) return ''
  if (owner.kind === 'pool') {
    const names = (owner.members ?? []).map(member => memberLabel(config, member)).filter(name => name !== '')
    if (names.length === 0) return ''
    return names.length === 1 ? names[0] : `${names[0]} 等 ${names.length} 位`
  }
  return memberLabel(config, owner)
}

export function buildRoster(config) {
  const items = []
  // 角色位放最前面：泳道默认按「产品经理 / 研发工程师」配，具体落到哪位
  // 领域专家由卡片所属业务领域决定。
  for (const role of ['product', 'architect', 'dev', 'qa']) {
    items.push({
      key: 'r:' + role,
      name: '角色 · ' + (ROLE_LABEL[role] ?? role),
      emoji: '🎯',
      hint: '按角色位派单，具体人按卡片业务领域挑',
      group: '角色位',
    })
  }
  for (const expert of config?.experts ?? []) {
    if (expert.enabled === false) continue
    items.push({
      key: 'e:' + expert.id,
      name: expert.name,
      emoji: expert.emoji ?? '🤖',
      hint: [expert.description, expert.domain ? `${expert.domain} · ${ROLE_LABEL[expert.role] ?? expert.role}` : ROLE_LABEL[expert.role] ?? expert.role].filter(Boolean).join(' · '),
      group: '专家',
    })
  }
  for (const team of config?.teams ?? []) {
    items.push({
      key: 't:' + team.id,
      name: team.name,
      emoji: team.emoji ?? '👥',
      hint: `团长 ${config?.experts?.find(expert => expert.id === team.lead)?.name ?? '未设'} · ${(team.members ?? []).length} 位成员`,
      group: '专家团',
    })
  }
  return items
}

export function filterRoster(roster, query) {
  const needle = String(query ?? '').trim().toLowerCase()
  if (needle === '') return roster
  return roster.filter(item => `${item.name} ${item.hint}`.toLowerCase().includes(needle))
}
