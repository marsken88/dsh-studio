/* 「先聊清楚」的模型提示词与项目沉淀。
 *
 * 只读：从现有 state 里挑与当前项目最相关的需求 / PRD 文档 / 卡，压成一段短上下文，
 * 让模型在追问前先知道「这个项目已经有什么、现在正在做什么」，避免问重复问题或写出冲突需求。
 */
const clip = (value, max) => String(value ?? '')
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/[#*`>|_~-]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max)

export function buildRequirementContext(state, projectId, limits = {}) {
  const project = (state?.projects ?? []).find(item => item.id === String(projectId ?? ''))
    ?? (state?.config?.projects ?? []).find(item => item.id === String(projectId ?? ''))
  const projectName = String(project?.name ?? '').trim()
  const projectDesc = clip(project?.description, 300)
  const services = Array.isArray(project?.services) ? project.services.map(item => item.name).filter(Boolean).slice(0, 6) : []
  const iterations = Array.isArray(project?.iterations) ? project.iterations.map(item => item.name).filter(Boolean).slice(0, 6) : []
  const projectIdSafe = String(project?.id ?? projectId ?? '')

  const requirements = (state?.requirements ?? [])
    .filter(item => projectIdSafe === '' || String(item.project ?? '') === projectIdSafe)
    .slice()
    .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
    .slice(0, limits.requirements ?? 8)
    .map(item => `- ${item.code || item.id} ${clip(item.title, 80)} [${item.status}]${item.description ? '：' + clip(item.description, 180) : ''}`)

  const docs = []
  for (const requirement of (state?.requirements ?? []).filter(item => projectIdSafe === '' || String(item.project ?? '') === projectIdSafe)) {
    for (const doc of requirement.docs ?? []) {
      if (docs.length >= (limits.docs ?? 4)) break
      if (doc.kind !== 'prd' && doc.kind !== 'acceptance') continue
      if (String(doc.content ?? '').trim() === '') continue
      docs.push(`- ${requirement.code || requirement.id} / ${clip(doc.title, 60)}：${clip(doc.content, 260)}`)
    }
    if (docs.length >= (limits.docs ?? 4)) break
  }

  const tasks = (state?.tasks ?? [])
    .filter(item => projectIdSafe === '' || String(item.project ?? '') === projectIdSafe)
    .slice()
    .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
    .slice(0, limits.tasks ?? 10)
    .map(item => `- ${item.code || item.id} ${clip(item.title, 70)} [${item.status}]${item.type === 'bug' ? '（缺陷）' : ''}`)

  const lines = []
  if (projectName !== '') {
    lines.push(`项目：${projectName}${projectDesc ? '。' + projectDesc : ''}`)
    if (services.length > 0) lines.push(`服务：${services.join('、')}`)
    if (iterations.length > 0) lines.push(`迭代：${iterations.join('、')}`)
  } else {
    lines.push('项目：未指定（只按通用产品经验澄清，不要编造项目事实）')
  }
  if (requirements.length > 0) lines.push('已有需求（最近）：', ...requirements)
  if (docs.length > 0) lines.push('已有 PRD / 验收文档（节选）：', ...docs)
  if (tasks.length > 0) lines.push('当前卡（最近）：', ...tasks)
  return lines.join('\n').slice(0, 6000)
}

export const REQUIREMENT_ASSIST_SYSTEM = [
  '你是一名资深产品经理，正在帮用户把还没想清楚的想法澄清成可交付的需求。',
  '你会拿到项目沉淀：已有需求、PRD/验收文档、当前卡。先检查是否与已有需求重复或冲突，再追问。',
  '规则：',
  '1. 不要编造项目里不存在的事实；不确定就写「待确认」。',
  '2. 聊天模式下只问最关键的 1-3 个问题，不要一次输出完整 PRD，也不要长篇解释。',
  '3. 用户明确要草稿/整理时，输出完整 PRD：背景、目标、用户与场景、范围（含不做什么）、功能点与验收、风险与依赖、待确认。',
  '4. 用中文；不要使用代码围栏。',
].join('\n')

export function requirementAssistPrompt({ mode = 'chat', messages = [], context = '', title = '' }) {
  const lines = [context, '']
  if (String(title ?? '').trim() !== '') lines.push(`用户给需求的暂定标题：${clip(title, 120)}`, '')
  lines.push('对话：')
  for (const message of messages.slice(-20)) {
    const role = message?.role === 'assistant' ? '助手' : '用户'
    lines.push(`${role}：${clip(message?.content, 1200)}`)
  }
  lines.push('')
  if (mode === 'draft') {
    lines.push('请根据以上对话与项目沉淀，整理出一份完整需求文档。')
    lines.push('第一行用 `# ` 给出需求标题，然后按「背景 / 目标 / 用户与场景 / 范围与不做什么 / 功能点与验收 / 风险与依赖 / 待确认」分段。')
    lines.push('只输出这份 Markdown 正文，不要解释你的整理过程。')
  } else {
    lines.push('请先判断是否与已有需求重复/冲突（一句话），然后只问接下来最关键的 1-3 个问题。')
    lines.push('不要输出 PRD，不要写「好的」「收到」这类客套话。')
  }
  return lines.join('\n')
}
