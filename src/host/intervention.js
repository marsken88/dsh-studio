/* 人工介入统计（纯函数）。
 *
 * 为什么需要：产品定义里第 13、14 条验收标准是「自动化率」和「按需求的平均交付时长」，
 * 而这两项**今天算不出来** —— 审计只到路由级、没有需求维度；评论不区分人和 AI；
 * 派单日志只在内存 300 条、重启清零。
 *
 * 好消息是「人有没有介入」这件事**已经能从现有数据里读出来**，不需要新增埋点：
 *   - 评论的 by 字段：AI 会话写的是 studio-<task>-<expert>，人写的是名字
 *   - 卡片 history：换列/改负责人/签字都会留痕
 *   - 签字记录：agent 签的 vs 人签的
 *
 * 所以这里只做「把已有事实读出来」，不加新表、不改写路径。
 */

/* 实测发现：history / 评论里的"非人"写法不止一种 ——
   会话痕迹是 studio-<taskId>-<expertId>，而系统自己记账写成 agent / 系统 / system。
   只认 studio- 会把 agent 和系统算成"人"，于是自动化率一直是 0%（看起来像没人用 AI，
   实际是统计口径错了）。这里把已知的非人写法都列进来。 */
const AI_ACTOR = /^(studio-|agent$|system$|ai$|系统$)/i

export function isAiActor(name) {
  return AI_ACTOR.test(String(name ?? '').trim())
}

/** 人 vs AI：空值算「未知」，不计入任何一边（宁可少算，不要算错）。 */
/** 签字记录：可能是单个对象，也可能是数组，统一成数组处理。 */
function listOf(one, many) {
  const list = []
  if (one !== null && typeof one === 'object') list.push(one)
  if (Array.isArray(many)) for (const item of many) if (item !== null && typeof item === 'object') list.push(item)
  return list
}

/** 签字是谁签的：优先读写入时记下的 actorKind，没有才回落到按名字判断。 */
function signKind(sign, config = null) {
  const kind = String(sign?.actorKind ?? '')
  // 'ai' 是早期写法，统一按 agent 对待：签字只分「人签的」和「AI 签的」。
  if (kind === 'ai' || kind === 'agent') return 'agent'
  if (kind === 'human') return 'human'
  // 回落到名字判断时也走同一个函数（不再有第二套口径）
  return signoffActorKind(sign?.by, config) === 'ai' ? 'agent' : 'human'
}

export function actorKind(name) {
  const text = String(name ?? '').trim()
  if (text === '') return 'unknown'
  return isAiActor(text) ? 'ai' : 'human'
}

/** 专家名册里的名字：派单出去的 AI 用的就是这些名字。 */
export function expertNames(config) {
  return (config?.experts ?? []).map(item => String(item?.name ?? '').trim()).filter(name => name !== '')
}

/** 这个签字算不算 AI 签的。
 *
 * 三道判断，命中任一即算 AI：
 *   1. 写入时明确记了 agent / ai（0.3.8 起工具就这么写）
 *   2. 签字人名字是会话痕迹（studio-…）或系统名
 *   3. **签字人名字在专家名册里** —— 兜住历史数据：早期按名字猜来源，
 *      「测试工程师」这种名字被误判成 human，AI 自助验收的记录一直挂着 human。
 */
/**
 * 一条签字是谁签的：**写入口与判据共用这一个函数**。
 *
 * 以前两套口径：写入口用 actorKind(name)（只认 studio-* 这类名字），闸门用
 * expertNames(config).includes(by) —— 于是「产品经理」这类专家名被记成 human，
 * 闸门却判 AI，记录与结论互相矛盾（issue #15）。
 */
export function signoffActorKind(name, config) {
  const text = String(name ?? '').trim()
  if (text === '') return 'unknown'
  if (isAiActor(text)) return 'ai'
  if (expertNames(config).includes(text)) return 'ai'
  return 'human'
}

export function isAiSignoff(sign, config) {
  if (sign === null || sign === undefined) return false
  const kind = String(sign.actorKind ?? '')
  if (kind === 'agent' || kind === 'ai') return true
  // 名字兜底也走同一个函数：这样「记录里是什么」和「闸门怎么判」永远一致
  return signoffActorKind(sign.by, config) === 'ai'
}

/** 一条记录是谁做的：显式 kind > 会话痕迹 > 专家名册 > 其余算人。
 *
 *  和 isAiSignoff 同一套口径。以前这里只看名字长得像不像 \`studio-*\`，
 *  于是 AI 用「测试工程师」这类专家名发的评论被算成人的介入，自动化率被压到 0。
 */
/* 角色名：派单时用角色命名，人手动改状态时也可能只留一个角色。两种都出现过，
   所以这些名字**既不能算人也不能算 AI**，只能记成「来源不明」——
   宁可少算一次介入，也不要把 AI 的活算成人的（那会把自动化率做成假的 0%）。 */
const ROLE_LABELS = new Set(['产品', '产品经理', '架构师', '开发', '开发工程师', '测试', '测试工程师', '设计', '运维', '运营', '运营工程师', '超管'])

export function actorOf(name, kind, config) {
  const text = String(name ?? '').trim()
  const declared = String(kind ?? '').trim()
  // 名字的证据优先于「显式写了 human」这条：早期把专家名判成 human 的记录都挂在这里，
  // 否则 AI 自己签的字、自己发的评论会一直冒充人工介入（和 isAiSignoff 保持一致）。
  if (text !== '' && (isAiActor(text) || expertNames(config).includes(text))) return 'ai'
  if (declared === 'agent' || declared === 'ai') return 'ai'
  if (declared === 'human') return 'human'
  if (text === '') return 'unknown'
  // 只有角色名、名册里又对不上：来源不明，既不算人也不算 AI
  if (ROLE_LABELS.has(text)) return 'unknown'
  return 'human'
}

/** 一张卡上的人工介入点：人写的评论 + 人动过的列 + 人签的字。 */
export function cardInterventions(task, config) {
  const points = []
  let unknown = 0
  for (const comment of task?.comments ?? []) {
    const who = actorOf(comment?.by, comment?.kind, config)
    if (who === 'human') points.push({ kind: 'comment', by: comment.by, at: Number(comment.at) || 0 })
    else if (who === 'unknown') unknown += 1
  }
  for (const entry of task?.history ?? []) {
    // history 里凡是有人名的都算人动过；系统自己写的（dispatcher/tick）没有 by
    const who = actorOf(entry?.by, undefined, config)
    if (who === 'human') points.push({ kind: String(entry.action ?? 'update'), by: entry.by, at: Number(entry.at) || 0 })
    else if (who === 'unknown') unknown += 1
  }
  /* 签字是单个对象（task.signoff），不是数组 —— 第一版按 signoffs 读，等于把签字全漏了。
     优先用记录里的 actorKind（写的时候已经判过），没有才回落到按名字猜。 */
  for (const sign of listOf(task?.signoff, task?.signoffs)) {
    const who = actorOf(sign?.by, sign?.actorKind, config)
    if (who === 'human') points.push({ kind: 'signoff', by: sign.by, at: Number(sign.at) || 0 })
    else if (who === 'unknown') unknown += 1
  }
  // 挂在数组上往外传（不可枚举）：调用方照旧读 points，需要的人能拿到「来源不明」的条数。
  Object.defineProperty(points, 'unknown', { value: unknown, enumerable: false })
  return points
}

/** 一条需求的汇总：卡上的介入点 + 需求自身的签字。 */
export function requirementInterventions(state, requirement, config) {
  const tasks = (state?.tasks ?? []).filter(task => task.requirementId === requirement?.id)
  const points = []
  let unknown = 0
  for (const task of tasks) {
    const cardPoints = cardInterventions(task, config)
    for (const point of cardPoints) points.push({ ...point, taskId: task.id })
    // 角色名写的评论/换列：不算人工介入，但要如实报出来（不计进 interventions）。
    unknown += cardPoints.unknown ?? 0
  }
  for (const sign of listOf(requirement?.signoff, requirement?.signoffs)) {
    const who = actorOf(sign?.by, sign?.actorKind, config)
    if (who === 'human') points.push({ kind: 'requirement-signoff', by: sign.by, at: Number(sign.at) || 0 })
    else if (who === 'unknown') unknown += 1
  }
  const taskIds = tasks.map(task => task.id)
  return {
    requirementId: String(requirement?.id ?? ''),
    tasks: taskIds.length,
    interventions: points.length,
    unknown,
    byKind: points.reduce((acc, point) => { acc[point.kind] = (acc[point.kind] ?? 0) + 1; return acc }, {}),
    actors: [...new Set(points.map(point => point.by))],
    points,
  }
}

/** 自动化率：已交付需求里，**零人工介入**走完的占比。
 *  「已交付」= 需求状态是 done 或 released（不由这里判断业务口径，调用方传进来）。 */
export function automationRate(state, deliveredIds, config) {
  const delivered = new Set(Array.isArray(deliveredIds) ? deliveredIds : [])
  const requirements = (state?.requirements ?? []).filter(item => delivered.has(item.id))
  if (requirements.length === 0) return { delivered: 0, untouched: 0, rate: null, perRequirement: [] }
  const perRequirement = requirements.map(item => {
    const summary = requirementInterventions(state, item, config ?? state?.config)
    return { id: item.id, code: item.code ?? '', tasks: summary.tasks, interventions: summary.interventions, unknown: summary.unknown ?? 0 }
  })
  const untouched = perRequirement.filter(item => item.interventions === 0).length
  return {
    delivered: requirements.length,
    untouched,
    rate: untouched / requirements.length,
    // 来源不明的介入点（旧数据只记了角色名）：不计入人工介入，但要让人知道这个数靠不靠得住。
    unknown: perRequirement.reduce((sum, item) => sum + item.unknown, 0),
    perRequirement,
  }
}
