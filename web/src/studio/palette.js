/* Command palette: one box that finds a card, a requirement or a release by
   code, title or owner. Pure helpers first (searchItems / filterItems) so they
   can be unit-tested without React; the component is a thin shell over them. */

import { fmtTime } from './format.js'
import { ROLE_LABEL } from './labels.js'

const clip = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text)

export function searchItems(state) {
  const items = []
  const statusLabel = new Map((state.statuses ?? []).map((entry) => [entry.id, entry.label]))
  for (const task of state.tasks ?? []) {
    items.push({
      key: 'task:' + task.id,
      kind: 'task',
      id: task.id,
      label: `${task.code ?? ''} ${task.title}`.trim(),
      hint: [statusLabel.get(task.status) ?? task.status, task.owner?.label ?? ''].filter(Boolean).join(' · '),
      search: [task.code, task.title, task.requirementTitle, task.id].filter(Boolean).join(' ').toLowerCase(),
    })
  }
  for (const requirement of state.requirements ?? []) {
    items.push({
      key: 'requirement:' + requirement.id,
      kind: 'requirement',
      id: requirement.id,
      label: `${requirement.code ?? ''} ${requirement.title}`.trim(),
      hint: ['需求', requirement.domain || '', requirement.owner || ''].filter(Boolean).join(' · '),
      search: [requirement.code, requirement.title, requirement.domain].filter(Boolean).join(' ').toLowerCase(),
    })
  }
  for (const release of state.releases ?? []) {
    items.push({
      key: 'release:' + release.id,
      kind: 'release',
      id: release.id,
      label: `${release.name ?? ''} ${release.tagName ?? ''}`.trim(),
      hint: ['版本', release.status ?? '', release.at ? fmtTime(release.at) : ''].filter(Boolean).join(' · '),
      search: [release.name, release.tagName, release.status].filter(Boolean).join(' ').toLowerCase(),
    })
  }

  for (const expert of state.config?.experts ?? []) {
    items.push({
      key: 'expert:' + expert.id,
      kind: 'expert',
      id: expert.id,
      label: `${expert.emoji ?? ''} ${expert.name}`.trim(),
      hint: ['专家', ROLE_LABEL[expert.role] ?? expert.role ?? '', expert.domain ?? ''].filter(Boolean).join(' · '),
      search: [expert.name, expert.id, expert.domain, expert.description, ROLE_LABEL[expert.role]].filter(Boolean).join(' ').toLowerCase(),
    })
  }
  for (const team of state.config?.teams ?? []) {
    items.push({
      key: 'team:' + team.id,
      kind: 'team',
      id: team.id,
      label: `👥 ${team.name}`.trim(),
      hint: ['专家团', (team.members ?? []).length + ' 位成员'].join(' · '),
      search: [team.name, team.id, team.description, ...(team.members ?? []).map((member) => member.name ?? member.id)].filter(Boolean).join(' ').toLowerCase(),
    })
  }
  for (const project of state.config?.projects ?? []) {
    items.push({
      key: 'project:' + project.id,
      kind: 'project',
      id: project.id,
      label: project.name,
      hint: ['项目', (project.services ?? []).length + ' 个服务', (project.iterations ?? []).length + ' 个迭代'].filter(Boolean).join(' · '),
      search: [project.name, project.id, project.description, ...(project.services ?? []).map((service) => service.name ?? service.repoPath)].filter(Boolean).join(' ').toLowerCase(),
    })
  }
  for (const skill of state.skills ?? []) {
    items.push({
      key: 'skill:' + skill.name,
      kind: 'skill',
      id: skill.name,
      label: '🧩 ' + skill.name,
      hint: ['技能', skill.enabled === false ? '已停用' : '已启用', (skill.users ?? 0) + ' 位专家在用'].join(' · '),
      search: [skill.name, skill.description, ...(skill.tags ?? [])].filter(Boolean).join(' ').toLowerCase(),
    })
  }
  return items
}

/** Things you can *do*, as opposed to records you can jump to. */
const SETTINGS_PANES = [
  { id: 'projects', label: '项目与迭代' },
  { id: 'experts', label: '专家' },
  { id: 'teams', label: '专家团' },
  { id: 'skills', label: '技能库' },
  { id: 'columns', label: '列的负责人' },
  { id: 'gitlab', label: '代码仓库' },
  { id: 'feishu', label: '飞书机器人' },
  { id: 'health', label: '集成健康' },
  { id: 'agents', label: '自动派单' },
  { id: 'testing', label: '测试执行' },
  { id: 'costs', label: '成本与预算' },
  { id: 'environments', label: '部署环境' },
  { id: 'board', label: '看板外观' },
  { id: 'ldap', label: '统一登录' },
  { id: 'access', label: '权限与审计' },
  { id: 'storage', label: '数据与备份' },
]

/** 面板之外也能用的全局快捷键。为什么不是 Ctrl/⌘+Shift：那一档被浏览器占了
 *  （Ctrl+Shift+N 无痕窗口、Ctrl+Shift+T 重开标签页、Ctrl+Shift+D 收藏所有标签页），
 *  页面 preventDefault() 拦不住，按下去等于按了浏览器的；Ctrl/⌘+Alt 在 Chrome / Edge /
 *  Firefox 上都不冲突。 */
export const SHORTCUTS = [
  { id: 'new-requirement', key: 'n', label: 'Ctrl/⌘+Alt+N' },
  { id: 'new-task', key: 't', label: 'Ctrl/⌘+Alt+T' },
  { id: 'card-dispatch', key: 'd', label: 'Ctrl/⌘+Alt+D' },
]

const shortcutById = new Map(SHORTCUTS.map((entry) => [entry.id, entry.label]))

/** 事件是否发生在输入框里（在输入框里打字不该触发离场动作）。 */
export function isTypingTarget(target) {
  if (target === null || target === undefined) return false
  const tag = String(target.tagName ?? '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable === true
}

/** 面板自己的输入框：在它里面按快捷键要能切动作，所以不算「正在打字」。 */
function inPaletteInput(target) {
  if (target === null || target === undefined) return false
  if (typeof target.getAttribute !== 'function') return false
  return target.getAttribute('data-palette-input') === '1'
}

/** 从键盘事件解析出要执行的面板动作；不是快捷键、或在别的输入框里打字时返回 null。 */
export function paletteShortcut(event) {
  if (event === null || event === undefined) return null
  if (!(event.ctrlKey === true || event.metaKey === true) || event.altKey !== true || event.shiftKey === true) return null
  if (!inPaletteInput(event.target) && isTypingTarget(event.target)) return null
  // 优先用物理键位（event.code）：macOS 上 Option+字母会变成变音字符，event.key 不可靠
  const physical = /^Key([A-Z])$/.exec(String(event.code ?? ''))
  const key = physical === null ? String(event.key ?? '').toLowerCase() : physical[1].toLowerCase()
  const hit = SHORTCUTS.find((entry) => entry.key === key)
  return hit === undefined ? null : hit.id
}

export const ACTION_ITEMS = [
  { id: 'new-requirement', shortcut: shortcutById.get('new-requirement'), label: '新建需求', hint: '需求 → 功能点 → 拆成卡', keys: '新建 需求 new requirement 提需求' },
  { id: 'new-task', shortcut: shortcutById.get('new-task'), label: '新建任务', hint: '直接在看板上建一张卡', keys: '新建 任务 卡片 new task 建卡' },
  { id: 'tab:board', label: '打开看板', hint: '八列泳道 · 拖拽换列', keys: '看板 board 泳道' },
  { id: 'tab:requirements', label: '打开需求', hint: '需求 · 功能点 · 文档 · 准出', keys: '需求 requirements prd' },
  { id: 'tab:releases', label: '打开版本', hint: '发布 · 灰度 · 部署记录', keys: '版本 release 发布 部署' },
  { id: 'tab:analytics', label: '打开效能', hint: '周期 · 返工 · AI 采纳', keys: '效能 analytics 度量 报表' },
  { id: 'tab:dashboard', label: '打开工作台', hint: '风险与今日待办', keys: '工作台 dashboard 风险 待办' },
  { id: 'export:tasks', label: '导出任务 CSV', hint: '看板上的卡，Excel 可直接打开', keys: '导出 csv 任务 export tasks 下载' },
  { id: 'export:requirements', label: '导出需求 CSV', hint: '需求与准出情况', keys: '导出 csv 需求 export requirements 下载' },
  { id: 'theme:light', label: '切换主题：明亮', hint: '浅色界面', keys: '主题 明亮 light theme 浅色' },
  { id: 'theme:dark', label: '切换主题：深色', hint: '深色界面', keys: '主题 深色 dark theme 夜间' },
  { id: 'theme:system', label: '切换主题：跟随系统', hint: '跟随宿主或操作系统的深浅色', keys: '主题 系统 system theme 自动' },
  { id: 'card-advance-note', label: '推进并留言', hint: '选一张卡 → 写一句 → 推进到下一列', keys: '推进 留言 advance note 交接 换列 card' },
  { id: 'card-advance', label: '把卡片推进到下一列', hint: '选一张卡 → 推进到下一状态', keys: '推进 advance 下一列 换列 移动 move card' },
  { id: 'card-dispatch', shortcut: shortcutById.get('card-dispatch'), label: '把卡片派给专家', hint: '选一张卡 → 选一位专家跑起来', keys: '派单 dispatch assign 执行 run 专家 expert card' },
  { id: 'card-comment', label: '给卡片留言', hint: '选一张卡 → 写一句讨论', keys: '留言 comment 讨论 评论 card' },
  { id: 'clear-recents', label: '忘掉最近用过的动作', hint: '清空这台电脑上记的最近动作顺序', keys: '清除 清空 忘掉 重置 最近 recent clear reset' },
  { id: 'column-advance', label: '整列推进一列', hint: '选一列 → 把这一列的卡批量推进到下一列', keys: '整列 批量 批量推进 column batch advance' },
  { id: 'refresh', label: '刷新数据', hint: '重新拉一次看板与需求', keys: '刷新 refresh 重载 同步' },
  ...SETTINGS_PANES.map((pane) => ({ id: 'settings:' + pane.id, label: '打开设置：' + pane.label, hint: '设置 → ' + pane.label, keys: '设置 settings 配置 ' + pane.label + ' ' + pane.id })),
]

export function actionItems() {
  return ACTION_ITEMS.map((action) => ({
    key: 'action:' + action.id,
    kind: 'action',
    id: action.id,
    label: action.label,
    hint: action.hint,
    shortcut: action.shortcut,
    search: (action.label + ' ' + action.hint + ' ' + action.keys + ' ' + (action.shortcut ?? '')).toLowerCase(),
  }))
}

/** 最近用过的动作置顶，其余保持原顺序；recents 里不存在的 id 直接忽略。 */
export function sortByRecent(items, recents) {
  if (!Array.isArray(recents) || recents.length === 0) return items.slice()
  const rank = new Map()
  recents.forEach((id, index) => { if (!rank.has(id)) rank.set(id, index) })
  const front = []
  const rest = []
  for (const item of items) {
    const hit = item.kind === 'action' ? rank.get(item.id) : undefined
    if (hit === undefined) rest.push(item)
    else front.push({ item, hit })
  }
  front.sort((a, b) => a.hit - b.hit)
  return [...front.map((entry) => entry.item), ...rest]
}

export const RECENT_ACTIONS_KEY = 'dsh-studio:recent-actions'
export const RECENT_LIMIT = 6

/** 把刚用过的动作记到最前面（保持去重与上限）。 */
/** 清空本机记录的最近动作；localStorage 不可用时静默跳过。 */
export function forgetRecents() {
  try {
    globalThis.localStorage?.removeItem(RECENT_ACTIONS_KEY)
  } catch {
    // 隐身模式或存储被禁用时忽略
  }
}

export function rememberAction(recents, id, limit = RECENT_LIMIT) {
  const next = [id, ...(Array.isArray(recents) ? recents : []).filter((entry) => entry !== id)]
  return next.slice(0, limit)
}

export function paletteItems(state) {
  return [...actionItems(), ...searchItems(state)]
}

export function filterItems(items, query, limit = 20) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return items.slice(0, limit)
  const scored = []
  items.forEach((item, order) => {
    let score = 0
    let hit = true
    for (const word of words) {
      const at = item.search.indexOf(word)
      if (at < 0) { hit = false; break }
      score += at === 0 ? 3 : at < 8 ? 2 : 1
    }
    if (hit) scored.push({ item, score, order })
  })
  // 同分时保持来源顺序：操作项在 paletteItems() 里排在前面，所以「新建需求」永远比「新建任务」靠前
  scored.sort((a, b) => b.score - a.score || a.order - b.order)
  return scored.slice(0, limit).map((entry) => entry.item)
}

const KIND_LABEL = { task: '卡片', requirement: '需求', release: '版本', expert: '专家', team: '专家团', project: '项目', skill: '技能', action: '操作' }

const CARD_FLOWS = {
  'card-advance': { step: 'card', title: '推进到下一列' },
  'card-advance-note': { step: 'card', title: '推进并留言' },
  'card-dispatch': { step: 'card', title: '派给专家' },
  'card-comment': { step: 'card', title: '给卡片留言' },
  'column-advance': { step: 'column', title: '整列推进' },
}

/** 卡片在状态序列里的下一列；已经是最后一列时返回 null。 */
/** 某一列的计划：这一列有哪些卡、下一列是什么；已经是最后一列时 next 为 null。 */
export function columnPlan(state, columnId) {
  const statuses = state.statuses ?? []
  const index = statuses.findIndex((entry) => entry.id === columnId)
  if (index < 0) return null
  const ids = (state.tasks ?? []).filter((task) => task.status === columnId).map((task) => task.id)
  return {
    column: statuses[index],
    next: index + 1 >= statuses.length ? null : statuses[index + 1],
    total: ids.length,
    ids,
  }
}

/** 命令面板里「先选动作、再选卡」的动作真正落地；返回的 effect 由调用方执行（刷新 / 打开抽屉）。 */
export async function runPaletteAction(item, ctx) {
  const { api, state, confirm, prompt, notify } = ctx
  const statuses = state?.statuses ?? []
  const statusLabel = (id) => statuses.find((entry) => entry.id === id)?.label ?? id
  const card = (state?.tasks ?? []).find((entry) => entry.id === item.cardId)
  const cardName = card === undefined ? item.cardId : ((card.code ?? '') + ' ' + card.title).trim()
  try {
    if (item.action === 'card-advance') {
      const next = nextStatusOf(state, item.cardId)
      if (next === null) { notify('这张卡已经在最后一列了', 'error'); return {} }
      await api('/task/update', { id: item.cardId, status: next })
      notify('已把「' + cardName + '」推进到「' + statusLabel(next) + '」')
      return { refresh: true, open: item.cardId }
    }
    if (item.action === 'card-advance-note') {
      const next = nextStatusOf(state, item.cardId)
      if (next === null) { notify('这张卡已经在最后一列了', 'error'); return {} }
      const note = await prompt('推进「' + cardName + '」到「' + statusLabel(next) + '」并留一句话', { title: '推进并留言', placeholder: '例如：评审通过，转测试' })
      if (note === null || String(note).trim() === '') return {}
      await api('/task/comment', { id: item.cardId, body: String(note).trim() })
      await api('/task/update', { id: item.cardId, status: next })
      notify('已推进到「' + statusLabel(next) + '」并留言')
      return { refresh: true, open: item.cardId }
    }
    if (item.action === 'card-dispatch') {
      const expert = (state?.config?.experts ?? []).find((entry) => entry.id === item.expertId)
      await api('/agents/run', { id: item.cardId, expert: item.expertId })
      notify('已派给 ' + (expert === undefined ? item.expertId : expert.emoji + expert.name))
      return { refresh: true }
    }
    if (item.action === 'card-comment') {
      const body = await prompt('给「' + cardName + '」留一句话', { title: '卡片留言', placeholder: '例如：压测已通过，可以进评审' })
      if (body === null || String(body).trim() === '') return {}
      await api('/task/comment', { id: item.cardId, body: String(body).trim() })
      notify('留言已发到「' + cardName + '」')
      return { refresh: true }
    }
    if (item.action === 'column-advance') {
      const result = await advanceColumn({ api, state, columnId: item.columnId, confirm })
      if (result.error !== undefined) { notify(result.error, 'error'); return {} }
      if (result.canceled === true) return {}
      if (result.failed.length === 0) notify('已把 ' + result.moved + ' 张卡推进到「' + result.nextLabel + '」')
      else notify('推进 ' + result.moved + ' 张，' + result.failed.length + ' 张没动：' + result.failed[0], 'error')
      return { refresh: true }
    }
  } catch (cause) {
    notify(cause instanceof Error ? cause.message : String(cause), 'error')
  }
  return {}
}

/** 把某一列的卡批量推进到下一列；确认、请求与失败收集都在这里，调用方只管提示。 */
export async function advanceColumn({ api, state, columnId, confirm }) {
  const plan = columnPlan(state, columnId)
  if (plan === null) return { error: '没找到这一列' }
  if (plan.next === null) return { error: '「' + plan.column.label + '」已经是最后一列了' }
  if (plan.total === 0) return { error: '「' + plan.column.label + '」这一列没有卡' }
  const ok = await confirm('把「' + plan.column.label + '」里的 ' + plan.total + ' 张卡一起推进到「' + plan.next.label + '」？', { title: '整列推进', okText: '推进 ' + plan.total + ' 张' })
  if (ok !== true) return { canceled: true }
  let moved = 0
  const failed = []
  for (const id of plan.ids) {
    try {
      await api('/task/update', { id, status: plan.next.id })
      moved += 1
    } catch (cause) {
      const task = (state.tasks ?? []).find((entry) => entry.id === id)
      failed.push(((task?.code ?? '') + ' ' + (task?.title ?? id)).trim() + '：' + (cause instanceof Error ? cause.message : String(cause)))
    }
  }
  return { moved, failed, nextLabel: plan.next.label }
}

export function nextStatusOf(state, taskId) {
  const statuses = state.statuses ?? []
  const task = (state.tasks ?? []).find((entry) => entry.id === taskId)
  if (task === undefined) return null
  const index = statuses.findIndex((entry) => entry.id === task.status)
  if (index < 0 || index + 1 >= statuses.length) return null
  return statuses[index + 1].id
}

export function createPalette({ h, React }) {
  return function Palette({ state, onPick, onClose, initialAction, initialSeq }) {
    const [query, setQuery] = React.useState('')
    const [active, setActive] = React.useState(0)
    const [flow, setFlow] = React.useState(null)
    const [recents, setRecents] = React.useState(() => {
      try {
        const stored = window.localStorage.getItem(RECENT_ACTIONS_KEY)
        const parsed = stored === null ? [] : JSON.parse(stored)
        return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []
      } catch (error) {
        return []
      }
    })
    const remember = (item) => {
      if (item === null || item === undefined || item.kind !== 'action') return
      const next = rememberAction(recents, item.id)
      setRecents(next)
      try { window.localStorage.setItem(RECENT_ACTIONS_KEY, JSON.stringify(next)) } catch (error) { /* 隐私模式下写不进去，忽略 */ }
    }
    const inputRef = React.useRef(null)
    const all = React.useMemo(() => paletteItems(state), [state])
    const cards = React.useMemo(() => searchItems(state).filter((item) => item.kind === 'task'), [state])
    const experts = React.useMemo(() => searchItems(state).filter((item) => item.kind === 'expert'), [state])
    const columns = React.useMemo(() => (state.statuses ?? []).map((column) => ({
      key: 'column:' + column.id,
      kind: 'column',
      id: column.id,
      label: column.label,
      hint: (state.tasks ?? []).filter((task) => task.status === column.id).length + ' 张卡',
      search: String(column.label ?? '').toLowerCase(),
    })), [state.statuses, state.tasks])

    const list = React.useMemo(() => {
      if (flow === null) return sortByRecent(filterItems(all, query), query === '' ? recents : [])
      if (flow.step === 'expert') return filterItems(experts, query)
      if (flow.step === 'column') return filterItems(columns, query)
      return filterItems(cards, query)
    }, [flow, all, cards, columns, experts, query, recents])

    React.useEffect(() => { inputRef.current?.focus() }, [])

    // 用快捷键打开时直接进到对应动作（跳到选卡那一步，或立刻执行）。
    // 依赖 initialSeq：面板已经开着时再按另一个快捷键也要切过去，不能只认第一次。
    React.useEffect(() => {
      if (initialAction === undefined || initialAction === null) return
      const item = all.find((entry) => entry.id === initialAction)
      if (item === undefined) return
      if (item.kind === 'action' && CARD_FLOWS[item.id] !== undefined) { start(item.id); return }
      onPick(item)
      onClose()
    }, [initialSeq])
    React.useEffect(() => { setActive(0) }, [query])

    const start = (action) => {
      setFlow({ action, step: CARD_FLOWS[action].step })
      setQuery('')
      setActive(0)
    }

    const pick = (item) => {
      if (item === undefined) return
      if (flow === null) {
        // 「忘掉最近用过」自己不进最近记录，否则刚清完又冒出来
        if (item.id === 'clear-recents') { forgetRecents(); onClose(); return }
        remember(item)
        if (item.kind === 'action' && CARD_FLOWS[item.id] !== undefined) { start(item.id); return }
        onPick(item)
        onClose()
        return
      }
      if (flow.step === 'column') {
        onPick({ kind: 'run', action: flow.action, columnId: item.id })
        onClose()
        return
      }
      if (flow.step === 'card') {
        if (flow.action === 'card-dispatch') {
          setFlow({ action: flow.action, cardId: item.id, step: 'expert' })
          setQuery('')
          setActive(0)
          return
        }
        onPick({ kind: 'run', action: flow.action, cardId: item.id })
        onClose()
        return
      }
      onPick({ kind: 'run', action: flow.action, cardId: flow.cardId, expertId: item.id })
      onClose()
    }

    const back = () => {
      if (flow === null) { onClose(); return }
      setFlow(flow.step === 'expert' ? { action: flow.action, step: 'card' } : null)
      setQuery('')
      setActive(0)
    }

    const onKeyDown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); back(); return }
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.min(list.length - 1, index + 1)); return }
      if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(0, index - 1)); return }
      if (event.key === 'Enter') { event.preventDefault(); pick(list[active]) }
    }

    const placeholder = flow === null
      ? '搜索卡片 / 需求 / 版本 / 专家 / 技能，或输入「新建」「导出」「推进」（↑↓ 选择，回车执行，Esc 关闭）'
      : flow.step === 'expert'
        ? '选一位专家（输入过滤，Esc 返回）'
        : flow.step === 'column'
          ? '选一列（输入过滤，Esc 返回）'
          : '选一张卡片（输入过滤，Esc 返回）'

    const banner = flow === null
      ? null
      : h('div', { className: 'ds-palette-flow', 'data-flow': flow.step },
        CARD_FLOWS[flow.action].title + (flow.step === 'expert' ? ' → 选一位专家' : flow.step === 'column' ? ' → 选一列' : ' → 选一张卡片'))

    return h('div', { className: 'ds-palette-veil', onClick: onClose },
      h('div', {
        className: 'ds-palette',
        role: 'dialog',
        'aria-label': '全局搜索',
        'data-palette': '1',
        onClick: (event) => event.stopPropagation(),
      },
        banner,
        h('input', {
          ref: inputRef,
          className: 'ds-palette-input',
          placeholder,
          value: query,
          onChange: (event) => setQuery(event.target.value),
          onKeyDown,
          'data-palette-input': '1',
        }),
        h('div', { className: 'ds-palette-list' },
          list.length === 0
            ? h('div', { className: 'ds-hint', style: { padding: '10px 12px' } },
              flow === null ? '没有匹配的内容' : flow.step === 'expert' ? '没有匹配的专家' : '没有匹配的卡片')
            : list.map((item, index) => h('div', {
              key: item.key,
              className: 'ds-palette-item',
              'data-active': index === active ? '1' : '0',
              onMouseEnter: () => setActive(index),
              onClick: () => pick(item),
            },
              h('span', { className: 'ds-palette-kind', 'data-kind': item.kind }, KIND_LABEL[item.kind] ?? item.kind),
              h('span', { className: 'ds-palette-label' }, clip(item.label, 80)),
              item.hint === '' ? null : h('span', { className: 'ds-palette-hint' }, clip((item.kind === 'action' && query === '' && recents.includes(item.id) ? '最近用过 · ' : '') + item.hint, 40)),
              item.shortcut === undefined || item.shortcut === null
                ? null
                : h('span', { className: 'ds-palette-key', title: '全局快捷键' }, item.shortcut),
            )),
        ),
      ),
    )
  }
}
