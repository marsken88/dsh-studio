/* 需求的准出判定：可追溯矩阵、准出门禁、需求进度。
 * 从 executor.js 抬出来，给 2000 行闸门留余量；这三个函数都是纯函数，
 * 也方便直接对「60% 覆盖拦截 / 审批 / 签字」写单测。
 */
import { COVERAGE_TARGET, coverageStrength } from './case-strength.js'
import { isAiSignoff } from './intervention.js'
import { caseNeedsRerun, requirementDocUpdatedAt } from './impact.js'

/**
 * 可追溯矩阵：需求的功能点 → 卡片（含状态）→ 用例（通过/失败/没跑）→ 交付物。
 * 一条需求做没做完，看的就是这张表，而不是“我印象里做过了”。
 */
export function requirementMatrix(state, requirement) {
  const tasks = state.tasks.filter(task => task.requirementId === requirement.id)
  // 需求文档（PRD / 验收标准）最近一次改版的时间：用来标「通过过、但文档改版后还没复跑」的用例。
  const docUpdatedAt = requirementDocUpdatedAt(requirement)
  const points = (requirement.points ?? []).map(point => {
    const cards = tasks.filter(task => task.pointId === point.id)
    const cardIds = new Set(cards.map(card => card.id))
    const cases = []
    for (const card of cards) {
      for (const item of card.cases ?? []) {
        /* 用例没写 pointId 时**继承卡的**功能点（issue #108 的根因之一）：
           以前 undefined !== '' 成立，这类用例被整条丢掉，卡挂了 p1 也没用，需求覆盖永远 0。 */
        const casePoint = String(item.pointId ?? '').trim() === '' ? String(card.pointId ?? '').trim() : String(item.pointId).trim()
        if (casePoint !== '' && casePoint !== point.id) continue
        cases.push({ ...item, taskId: card.id, taskCode: card.code || card.id, taskTitle: card.title, stale: caseNeedsRerun(item, docUpdatedAt) })
      }
    }
    // 用例可能挂在别的卡上（比如测试卡），按 pointId 全局找一遍。
    for (const card of tasks) {
      if (cardIds.has(card.id)) continue
      for (const item of card.cases ?? []) {
        if (item.pointId !== point.id) continue
        cases.push({ ...item, taskId: card.id, taskCode: card.code || card.id, taskTitle: card.title, stale: caseNeedsRerun(item, docUpdatedAt) })
      }
    }
    const artifacts = cards.flatMap(card => (card.artifacts ?? []).map(item => ({ ...item, taskCode: card.code || card.id })))
    /* 逐条判覆盖：某条验收条件只有**挂在它自己身上**（acceptanceId 相符）的通过用例才算覆盖。
       以前是「这个功能点任意一条用例通过 → 所有验收条件都标 covered」，
       于是矩阵上「5/5 覆盖」可能只对应 1 条用例。 */
    const acceptance = (point.acceptance ?? []).map(item => {
      /* 证据型条件（评审结论 / 测试报告 / 产品验收记录…）：由**该功能点上已交付的同类交付物**判覆盖。
         这类条件天生写不出可执行用例，以前永远算不覆盖，需求画像长期偏低（REQ-2026-003 p1 的 8 条）。 */
      const evidenceKind = String(item.evidence?.kind ?? '').trim()
      if (evidenceKind !== '') {
        const hit = artifacts.find(entry => String(entry.kind ?? '') === evidenceKind
          && ['delivered', 'accepted'].includes(String(entry.status ?? '')))
        return { ...item, covered: hit !== undefined, evidenceHit: hit === undefined ? '' : (hit.title || hit.taskCode || '') }
      }
      const matched = cases.filter(entry => entry.result === 'pass' && String(entry.acceptanceId ?? '') === item.id)
      return { ...item, covered: matched.length > 0 }
    })
    // 没挂验收条件的用例单独数出来：它们不进任何条件的覆盖，也不该被当成覆盖
    const unmapped = cases.filter(entry => String(entry.acceptanceId ?? '') === '').length
    const pass = cases.filter(item => item.result === 'pass').length
    const fail = cases.filter(item => item.result === 'fail').length
    const pending = cases.length - pass - fail
    const doneCards = cards.filter(card => card.status === 'done').length
    const covered = acceptance.length === 0
      ? pass > 0
      : acceptance.every(item => item.covered)
    return {
      id: point.id,
      title: point.title,
      description: point.description,
      priority: point.priority,
      status: point.status,
      acceptance,
      unmappedCases: unmapped,
      cards: cards.map(card => ({ id: card.id, code: card.code, title: card.title, status: card.status, date: card.status === 'done' ? card.updatedAt : 0 })),
      cases: { total: cases.length, pass, fail, pending, stale: cases.filter(item => item.stale === true).length },
      artifacts: artifacts.length,
      doneCards,
      covered,
    }
  })
  const loose = tasks.filter(task => task.pointId === '' || (requirement.points ?? []).every(point => point.id !== task.pointId))
  const summary = {
    points: points.length,
    coveredPoints: points.filter(point => point.covered).length,
    /** 一个用例都没有的功能点：覆盖率最容易漏的口子。 */
    pointsWithoutCases: points.filter(point => point.cases.total === 0).length,
    cards: tasks.length,
    looseCards: loose.length,
    cases: points.reduce((sum, point) => sum + point.cases.total, 0),
    pass: points.reduce((sum, point) => sum + point.cases.pass, 0),
    fail: points.reduce((sum, point) => sum + point.cases.fail, 0),
    /* 文档改版后要复跑的用例：通过过、但最后一次执行早于文档更新时间。 */
    staleCases: points.reduce((sum, point) => sum + (point.cases.stale ?? 0), 0),
    artifacts: points.reduce((sum, point) => sum + point.artifacts, 0),
  }
  /* 需求文档（requirement.docs）也是「这一棒产出的文档」：矩阵的交付物数要一起算，
     否则「PRD 写在 docs 里」的需求在矩阵上显示 0 件交付物（issue #129）。 */
  summary.docArtifacts = (requirement.docs ?? []).filter(doc => String(doc.content ?? '').trim() !== '').length
  summary.artifacts += summary.docArtifacts
  summary.passRate = summary.cases === 0 ? 0 : Math.round((summary.pass / summary.cases) * 100)
  /* 两个口径，以前都叫「覆盖率」，于是同一份数据里同时出现 coverageRate=100 与 coveredPoints=0（issue #109）：
     · pointsWithCasesRate：有多少功能点**至少有一条用例**（哪怕还没跑）
     · coverageRate：有多少功能点**被通过的用例逐条覆盖了验收条件**（= coveredPoints/points）
     后者才是签字闸门认的口径，coverageRate 现在就是它；前者保留新名字。 */
  summary.pointsWithCasesRate = summary.points === 0 ? 0 : Math.round(((summary.points - summary.pointsWithoutCases) / summary.points) * 100)
  summary.coverageRate = summary.points === 0 ? 0 : Math.round((summary.coveredPoints / summary.points) * 100)
  return {
    points,
    loose: loose.map(card => ({ id: card.id, code: card.code, title: card.title, status: card.status })),
    summary,
  }
}

/**
 * 一条需求能不能算「交付完成」：卡全完成、功能点全覆盖、没有阻塞/未结缺陷/失败用例，
 * 并且有人做过需求级验收签字。这是需求维度的门禁，和单卡的 taskExitGate 分开。
 */
export function requirementGate(state, requirement) {
  const tasks = state.tasks.filter(task => task.requirementId === requirement.id)
  const matrix = requirementMatrix(state, requirement)
  const blockers = []
  const warnings = []
  const pool = requirement.pool ?? { score: 0 }
  if (!(pool.score > 0)) warnings.push('还没做需求池打分（RICE）：影响面、影响度、置信度、成本填一下就能排序')
  const openQuestions = (requirement.questions ?? []).filter(item => item.status === 'open')
  const docs = requirement.docs ?? []
  const docOfKind = kind => docs.some(doc => String(doc.kind ?? '') === kind && String(doc.content ?? '').trim() !== '')
  const artifactOfKind = kind => tasks.some(task => (task.artifacts ?? []).some(item => String(item.kind ?? '') === kind))
  if (String(requirement.links?.prd ?? '').trim() === '' && docs.every(doc => String(doc.content ?? '').trim() === '') && requirement.baseline === null && !artifactOfKind('requirement')) {
    blockers.push('需求还没有产品输出：先补 PRD 链接或正文，再拆卡')
  }
  /* 原型以前**不参与任何判断**（issue #128）：links.proto 填不填对流程毫无影响。
     这里给一条 warning：有前端类的功能点时，提醒补原型（真正的「有没有前端」由澄清三问里的交付边界判断）。 */
  const hasProto = String(requirement.links?.proto ?? '').trim() !== '' || docOfKind('proto') || artifactOfKind('prototype')
  if (!hasProto && requirement.discovery?.boundary !== undefined && String(requirement.discovery.boundary).trim() !== '') {
    warnings.push('还没有原型：交付边界写了要做界面时，产品应该给原型（links.proto / 需求文档 kind=proto / 卡交付物 kind=prototype 任一处）')
  }
  if (openQuestions.length > 0) blockers.push(`还有 ${openQuestions.length} 个待确认问题没回答：${openQuestions.slice(0, 3).map(item => item.text.slice(0, 18)).join('、')}`)
  if (tasks.length === 0) blockers.push('这条需求下还没有任何任务卡')
  if ((requirement.points ?? []).length === 0) warnings.push('还没有拆功能点，可追溯矩阵是空的')
  const open = tasks.filter(task => task.status !== 'done')
  if (open.length > 0) {
    const names = open.slice(0, 5).map(task => task.code || task.id).join('、')
    blockers.push(`${open.length} 张卡还没完成：${names}${open.length > 5 ? ' 等' : ''}`)
  }
  const blocked = tasks.filter(task => task.blocked !== null && task.blocked !== undefined)
  if (blocked.length > 0) blockers.push(`${blocked.length} 张卡还卡在阻塞：${blocked.slice(0, 3).map(task => task.code || task.id).join('、')}`)
  // 绕过门禁完成的卡：不拦（override 本来就是有意开的逃生舱），但交付时必须被看见。
  // 协作：光有「测试跑完了」这种自动汇总不算协作过——必须有产品或架构专家在卡上说话。
  const roleOf = new Map((state.config?.experts ?? []).map(expert => [String(expert.name ?? ''), String(expert.role ?? '')]))
  const spokenRoles = new Set()
  for (const task of tasks) {
    for (const comment of task.comments ?? []) {
      const role = roleOf.get(String(comment.author ?? ''))
      if (role !== undefined && role !== '') spokenRoles.add(role)
    }
  }
  if (tasks.length > 0 && !spokenRoles.has('product') && !spokenRoles.has('architect')) {
    warnings.push('这条需求没有经过澄清与方案：卡上没有产品/架构专家的讨论（只有自动跑用例的汇总）')
  }
  // 协作：完成的卡上一条评论都没有，说明它多半是被脚本直接推过来的，没过专家。
  const silent = tasks.filter(task => task.status === 'done' && (task.comments ?? []).length === 0)
  if (silent.length > 0) {
    warnings.push(silent.length + ' 张卡完成的卡上没有任何讨论：' + silent.slice(0, 3).map(task => task.code || task.id).join('、') + (silent.length > 3 ? ' 等' : '') + '（真实需求要派专家做，不是直接改状态）')
  }
  const overridden = tasks.filter(task => task.status === 'done' && task.override !== null && task.override !== undefined)
  if (overridden.length > 0) {
    warnings.push(overridden.length + ' 张卡是绕过准出完成的：' + overridden.slice(0, 3).map(task => (task.code || task.id) + (task.override?.reason ? '（' + String(task.override.reason).slice(0, 40) + '）' : '')).join('、'))
  }
  const bugs = tasks.filter(task => task.type === 'bug' && task.status !== 'done')
  if (bugs.length > 0) blockers.push(`还有 ${bugs.length} 个缺陷没关闭：${bugs.slice(0, 3).map(task => task.code || task.id).join('、')}`)
  const failing = []
  for (const task of tasks) {
    for (const item of task.cases ?? []) {
      if (item.result === 'fail') failing.push(`${task.code || task.id}·${item.title}`)
    }
  }
  if (failing.length > 0) blockers.push(`${failing.length} 条用例不通过：${failing.slice(0, 3).join('；')}`)
  const pendingDeps = (requirement.dependsOn ?? [])
    .map(id => state.requirements.find(item => item.id === id))
    .filter(item => item !== undefined && item.status !== 'delivered' && item.status !== 'closed')
  if (pendingDeps.length > 0) {
    blockers.push(`依赖的需求还没交付：${pendingDeps.map(item => item.code || item.title).join('、')}`)
  }
  const uncovered = matrix.points.filter(point => !point.covered)
  if (uncovered.length > 0) warnings.push(`${uncovered.length} 个功能点还没有通过的用例覆盖：${uncovered.slice(0, 3).map(point => point.id).join('、')}`)
  if (matrix.summary.pointsWithoutCases > 0) warnings.push(`${matrix.summary.pointsWithoutCases} 个功能点还没有任何用例（有用例的功能点占 ${matrix.summary.pointsWithCasesRate}%）`)
  if (matrix.summary.looseCards > 0) warnings.push(`${matrix.summary.looseCards} 张卡还没归到功能点`)
  // 证据：整条需求下**一条跑过的用例都没有**就不许交付——"做完了"和"验过了"是两件事。
  // 只要求"跑过"（pass/fail 都算），不要求全绿：失败会走上面那条 blockers。
  const ranCases = tasks.reduce((sum, task) => sum + (task.cases ?? []).filter(item => item.result === 'pass' || item.result === 'fail').length, 0)
  if (ranCases === 0) blockers.push('这条需求下没有任何跑过的用例：交付没有可复现的证据')
  // 跑过一条就算有证据，但「一半用例从没跑过」同样不该被当成验过：分开点名 pending 与 skip。
  const unrun = []
  const skipped = []
  for (const task of tasks) {
    for (const item of task.cases ?? []) {
      const key = (task.code || task.id) + '·' + String(item.title ?? '')
      if (item.result === 'pending') unrun.push(key)
      if (item.result === 'skip') skipped.push(key)
    }
  }
  if (unrun.length > 0) warnings.push(unrun.length + ' 条用例还没跑过：' + unrun.slice(0, 3).join('、') + (unrun.length > 3 ? ' 等' : ''))
  /* 可执行用例占比（产品定义第 8 条，目标 60%）。
     以前这把尺子只有单测在用：门禁只问「有没有跑过的用例」，不问「跑得起来的有几条」——
     于是 12 条标题式用例 + 1 条真用例也算"验过"。这里把它读出来，数字给到人。
     只提示不拦：存量需求里草稿居多，一刀切会把已经在交付的需求全卡住。 */
  const allCases = tasks.flatMap(task => task.cases ?? [])
  const strength = coverageStrength(allCases)
  if (strength.rate !== null && strength.rate < COVERAGE_TARGET) {
    blockers.push(
      `可执行用例只有 ${strength.executable}/${strength.total}（${Math.round(strength.rate * 100)}%），低于 ${Math.round(COVERAGE_TARGET * 100)}% 的目标：` +
      '只有标题的用例跑不起来，也不算验过——把它们改成带断言的（接口 / shell / 数据库 / 浏览器）再签字',
    )
  }
  // 「通过」有两种来源：跑出来的（有 lastRun）和人手标的（没有）。后者不能当验证证据。
  const typed = []
  for (const task of tasks) {
    for (const item of task.cases ?? []) {
      if (item.result === 'pass' && (item.lastRun === null || item.lastRun === undefined)) typed.push((task.code || task.id) + '·' + String(item.title ?? ''))
    }
  }
  if (typed.length > 0) warnings.push(typed.length + ' 条用例的「通过」是手工标的、没有执行记录：' + typed.slice(0, 3).join('、') + (typed.length > 3 ? ' 等' : '') + '（跑一次才算验证过）')
  if (skipped.length > 0) warnings.push(skipped.length + ' 条用例被标成跳过：' + skipped.slice(0, 3).join('、') + (skipped.length > 3 ? ' 等' : '') + '（跳过要有理由）')
  /* 交付物口径（issue #129）：卡上的 artifacts 与需求级 docs 都是「这一棒产出的文档」。
     以前只数 artifacts，于是「PRD 写在 docs 里」的需求会显示「还没有登记任何交付物」。 */
  const taskArtifacts = tasks.reduce((sum, task) => sum + (task.artifacts ?? []).length, 0)
  const docArtifacts = (requirement.docs ?? []).filter(doc => String(doc.content ?? '').trim() !== '').length
  const artifacts = taskArtifacts + docArtifacts
  /* 验收条件逐条判覆盖：没被任何**通过**用例挂上的条件要单独点出来。
     以前矩阵是"功能点任意一条用例通过 = 所有条件都覆盖"，所以这条提醒以前根本不会出现。 */
  const acceptanceLines = matrix.points.flatMap(item => item.acceptance ?? [])
  const uncoveredLines = acceptanceLines.filter(item => item.covered !== true)
  if (acceptanceLines.length > 0 && uncoveredLines.length > 0) {
    warnings.push(`${uncoveredLines.length}/${acceptanceLines.length} 条验收条件没有对应的通过用例：` + uncoveredLines.slice(0, 3).map(item => String(item.text).slice(0, 30)).join('、') + (uncoveredLines.length > 3 ? ' 等' : ''))
  }
  if (artifacts === 0) warnings.push('这条需求下还没有登记任何交付物')
  else {
    const empty = tasks.reduce((sum, task) => sum + (task.artifacts ?? []).filter(item => String(item.content ?? '').trim() === '').length, 0)
    if (empty > 0) warnings.push(`${empty} 件交付物还没有正文`)
  }
  if (requirement.signoff === null || requirement.signoff === undefined) blockers.push('还没有需求级验收签字')
  else if (isAiSignoff(requirement.signoff, state.config)) blockers.push(`需求验收签字是 AI 写的（${requirement.signoff.by}）：交付前要人签（产品定义第 3 条：AI 只把草稿写好，人做审稿）`)
  // 评审没通过的草稿/待评审需求不该往下拆卡：先过评审，再干活。
  const review = requirement.review ?? null
  const reviewApproved = review !== null && review.status === 'approved'
  const started = requirement.status === 'active' || requirement.status === 'delivered' || requirement.status === 'closed'
  if (!reviewApproved && !started) {
    blockers.push(requirement.status === 'review'
      ? '需求还在评审中：等评审人给出结论（通过之后才能拆卡）'
      : '需求还没评审通过：先点「提交评审」，评审通过后再拆卡')
  }
  if (review !== null && review.status === 'changes_requested') {
    blockers.push(`需求评审被打回${review.note === '' ? '' : `：${review.note.slice(0, 80)}`}`)
  }
  // 需求中途改过内容：已经产出过的卡是按旧版做的，签字作废、必须重新走一遍确认。
  const change = requirement.change ?? null
  if (change !== null && change.invalidated) {
    /* affected 里存的是**变更当时**的编号快照；卡片编号之后可能被重排（0.9.87 的撞号重排就干过），
       直接显示旧编号会让人拿着「REQ-003」去找一张现在叫 REQ-2026-007-3 的卡。按 id 现查当前编号。 */
    const currentCode = item => {
      const live = (state.tasks ?? []).find(task => task.id === item.id)
      return (live !== undefined && String(live.code ?? '') !== '') ? live.code : (item.code || item.id)
    }
    const names = change.affected.slice(0, 3).map(currentCode).join('、')
    blockers.push(`需求改过（${change.parts.join('、')}）：${change.affected.length} 张已产出的卡要复核${names === '' ? '' : `（${names}）`}，验收签字已作废`)
  } else if (change !== null && change.affected.length > 0) {
    warnings.push(`需求上一次变更影响 ${change.affected.length} 张卡，建议逐张复核再签字`)
  }
  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    stats: {
      cards: tasks.length,
      done: tasks.length - open.length,
      open: open.length,
      blocked: blocked.length,
      bugs: bugs.length,
      failing: failing.length,
      points: matrix.points.length,
      coveredPoints: matrix.summary.coveredPoints,
      cases: matrix.summary.cases,
      pass: matrix.summary.pass,
      artifacts,
      signoff: requirement.signoff !== null && requirement.signoff !== undefined,
    },
  }
}

/**
 * 需求进度：给列表和详情共用。derived 是**算出来的**状态，
 * 手动状态只在「关闭」时优先（人明确关掉的需求不该被自动拉回进行中）。
 */
export function requirementProgress(state, requirement) {
  const tasks = state.tasks.filter(task => task.requirementId === requirement.id)
  const gate = requirementGate(state, requirement)
  const done = tasks.filter(task => task.status === 'done').length
  const blocked = tasks.filter(task => task.blocked !== null && task.blocked !== undefined).length
  const progress = tasks.length === 0 ? 0 : Math.round((done / tasks.length) * 100)
  const derived = requirement.status === 'closed'
    ? 'closed'
    : (tasks.length > 0 && done === tasks.length && gate.ready ? 'delivered' : (tasks.length > 0 ? 'active' : 'draft'))
  return {
    gate,
    /* 可执行覆盖率：给列表/详情直接显示「可执行 1/4」，不用点开准出才知道为什么被拦。 */
    coverage: coverageStrength(tasks.flatMap(task => task.cases ?? [])),
    cards: { total: tasks.length, done, open: tasks.length - done, blocked },
    progress,
    derived,
    review: requirement.review ?? null,
    reviewStatus: (requirement.review ?? {}).status ?? 'none',
  }
}
