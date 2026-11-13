/* Roster helpers: turn the configured expert list into pickable items and
   render an owner chip for a column or card. Pure data-in / string-out —
   callers pass the live config, nothing here touches the store. */

import { ROLE_LABEL, STRATEGY_LABEL } from './labels.js'

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

export function cardOwner(task, config) {
  const experts = config.experts ?? []
  if (task.dispatch?.state === 'running' && task.dispatch?.expert) {
    const running = experts.find(expert => expert.id === task.dispatch.expert)
    if (running !== undefined) return { label: `${running.emoji} ${running.name}`, note: '正在处理', expert: running }
  }
  const assigned = experts.find(expert => expert.id === task.expert)
  if (assigned !== undefined) return { label: `${assigned.emoji} ${assigned.name}`, note: '卡上指派', expert: assigned }
  const owner = config.columns?.[task.status]
  if (owner !== undefined && Array.isArray(owner.members) && owner.members.length > 0) {
    if (owner.members.length === 1) {
      const only = owner.members[0]
      const text = ownerLabel(config, { ...only, kind: only.kind })
      if (text !== '') {
        const expert = only.kind === 'expert' ? experts.find(entry => entry.id === only.id) : undefined
        return { label: text, note: '本列候选人', expert }
      }
    }
    const strategy = STRATEGY_LABEL[owner.strategy ?? 'round_robin'] ?? '轮询'
    return { label: `候选池 ${owner.members.length} 人`, note: `本列候选：${owner.members.map(member => ownerLabel(config, member)).join('、')}（${strategy}）`, expert: undefined }
  }
  if (owner !== undefined && owner.kind !== 'none') {
    const text = ownerLabel(config, owner)
    if (text !== '') {
      const expert = owner.kind === 'expert' ? experts.find(entry => entry.id === owner.id) : undefined
      return { label: text, note: '本列负责人', expert }
    }
  }
  return { label: '未指派', note: '等人认领', expert: undefined }
}

/** 正文可能没随轮询下发（只给 contentLength），两种形状都要能判断「有没有正文」。 */
export function artifactsWithoutBody(task) {
  return (task.artifacts ?? []).filter(item => {
    const content = String(item.content ?? '')
    if (content !== '') return content.trim() === ''
    return (typeof item.contentLength === 'number' ? item.contentLength : 0) === 0
  })
}
