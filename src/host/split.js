// 把需求的功能点拆成卡：HTTP 路由与 studio_requirement_split 工具共用这一份。
//
// 为什么要共用：拆卡是「会话里聊完需求 → 开工」的最后一跳，以前只有 HTTP 有，
// agent 要自己拼 curl、记两套参数形状、还要知道服务端口（issue #21）。
//
// 门禁照旧（评审通过 + 澄清答完才让拆），因为那两道门才是这个流程的价值所在。
import { checklistFromAcceptance } from './acceptance.js'
import { backendCoverageWarning, discoveryGaps, frontendOnlyWarning, vaguePointsWarning } from './discovery.js'
import { resolveRequirement, requirementRefHint } from './reviews.js'

/** 拆卡前的提示（不拦）：说了有后端却没覆盖、说了没后端却要动接口、功能点太空。 */
export function splitWarnings(requirement) {
  return [backendCoverageWarning(requirement), frontendOnlyWarning(requirement), vaguePointsWarning(requirement)].filter(item => item !== null)
}

/**
 * 把功能点拆成卡。
 *
 * @param store      台账
 * @param input      { id（id 或编号）, pointIds?, status? }
 * @param createTask 建卡函数（路由与工具各自注入宿主实现）
 */
export async function splitRequirement(store, input, createTask) {
  const before = store.snapshot()
  const requirement = resolveRequirement(before, input?.id)
  if (requirement === undefined) throw new Error(requirementRefHint(before, input?.id))
  const requested = (Array.isArray(input?.pointIds) ? input.pointIds : []).map(item => String(item))
  const column = String(input?.status ?? 'clarify')

  const approved = (requirement.review ?? null)?.status === 'approved'
  const started = ['active', 'delivered', 'closed'].includes(requirement.status)
  if (!approved && !started) throw new Error('需求还没评审通过，先过评审再拆卡（studio_requirement_review decision=approve）')
  const gaps = discoveryGaps(requirement)
  if (gaps.length > 0) throw new Error('拆卡前先把澄清答完：' + gaps.join('；'))

  const points = (requirement.points ?? []).filter(point => requested.length === 0 || requested.includes(point.id))
  if (points.length === 0) throw new Error('这条需求没有可拆的功能点：先用 studio_requirement_save 的 points 写进去')
  const uncovered = points.filter(point => !before.tasks.some(task => task.requirementId === requirement.id && task.pointId === point.id))
  if (uncovered.length === 0) throw new Error('这些功能点都已经有卡了')

  /* 产品这一棒的价值在「把需求挖到能验收」：功能点没有可判定的验收条件就不许拆卡。
     没有验收条件的卡，研发只能猜、测试只能编，后面的门禁全是空转。
     确认不适用时可在设置里关 requirementGate.requireAcceptance。 */
  const gate = before.config?.requirementGate ?? {}
  if (gate.requireAcceptance !== false) {
    const bare = uncovered.filter(point => (Array.isArray(point.acceptance) ? point.acceptance : [])
      .every(item => String(item?.text ?? '').trim() === ''))
    if (bare.length > 0) {
      throw new Error('这些功能点还没有可判定的验收条件，先补上再拆卡：'
        + bare.map(point => `${point.id} ${point.title}`).join('、')
        + '（用 studio_requirement_save 的 points[].acceptance 写；确实不适用可在设置里关 requirementGate.requireAcceptance）')
    }
  }

  const created = []
  for (const point of uncovered) {
    const checklist = checklistFromAcceptance(point.acceptance)
    const task = await createTask(store, {
      title: `${point.id} ${point.title}`.slice(0, 200),
      type: 'requirement',
      requirementId: requirement.id,
      pointId: point.id,
      project: requirement.project,
      iteration: requirement.iteration,
      priority: requirement.priority,
      status: column,
      requirement: point.description ?? point.title,
      // 卡的验收清单 = 这个功能点的验收条件；没写才退回按类型的通用模板
      checklist: checklist.length > 0 ? checklist : undefined,
    })
    created.push(task)
  }
  return { requirement, created, warnings: splitWarnings(requirement) }
}

