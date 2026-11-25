/* 改列负责人之前，先算一遍「这一改会让哪些卡在下一轮 tick 被派出去」。
 *
 * 为什么需要（issue #149 现象二）：改列负责人不只是改配置 —— 它是一台起动机。
 * `tick()` 每 5 秒扫一遍自动列，列 owner 一旦能解析，存量卡就被派出去；
 * 而调用方（人点面板 / 脚本打 `/columns/save`）完全无法预判会波及哪些卡、派给谁。
 * 真机踩过：把 test 列从「专家 qa」改成「角色位 qa」，一分钟内 test 列最老的一张卡自己起了会话。
 *
 * 这里只做纯计算：把「改之前 / 改之后」的 owner 解析函数注入进来，
 * 复用的判据与 dispatcher.tick() 保持一致（阻塞 / 在跑 / 本轮已派过 / 退避中 / 是否自动列）。
 * 纯函数，单测在 tests/issues-148-150.test.mjs。
 */

/** 一个 owner（resolveOwner 的返回值）压成面板能显示的三元组。 */
export function describeOwner(owner) {
  if (owner === null || owner === undefined) return undefined
  const expert = owner.expert
  return {
    kind: String(owner.kind ?? 'expert'),
    id: String(expert?.id ?? ''),
    name: String(expert?.name ?? ''),
    team: String(owner.team?.id ?? ''),
    teamName: String(owner.team?.name ?? ''),
    role: String(owner.viaRole ?? ''),
  }
}

/**
 * 下一轮 tick 会派给谁。
 *
 * @param {object} input
 * @param {Array}  input.tasks         全部卡
 * @param {string} input.status        要看的那一列
 * @param {Array}  input.autoStatuses  自动派单的列（config.agents.autoStatuses）
 * @param {Array}  input.running       正在跑的卡 id
 * @param {Function} input.before      改之前的 owner 解析：task → owner | undefined
 * @param {Function} input.after       改之后的 owner 解析：task → owner | undefined
 * @param {number} input.now           现在（退避窗口判定用；测试可注入）
 * @returns {{status:string, auto:boolean, count:number, cards:Array}}
 */
export function dispatchPreview({ tasks, status, autoStatuses, running, before, after, now = Date.now() }) {
  const list = Array.isArray(tasks) ? tasks : []
  const auto = Array.isArray(autoStatuses) && autoStatuses.includes(status)
  const busy = new Set((Array.isArray(running) ? running : []).map(id => String(id ?? '')))
  const cards = []
  for (const task of list) {
    if (String(task?.status ?? '') !== status) continue
    // tick 的判据：阻塞、在跑、这一列已经派过一轮、还在失败退避窗口里——都不会派。
    if (task.blocked !== null && task.blocked !== undefined) continue
    if (busy.has(String(task.id ?? ''))) continue
    if (String(task.dispatch?.status ?? '') === status) continue
    if ((Number(task.retryAt) || 0) > now) continue
    const next = typeof after === 'function' ? after(task) : undefined
    if (next === undefined) continue
    const previous = typeof before === 'function' ? before(task) : undefined
    cards.push({
      id: String(task.id ?? ''),
      code: String(task.code ?? ''),
      title: String(task.title ?? ''),
      owner: describeOwner(next),
      // 以前没人负责、改完有人了：这就是「改配置把卡带走了」的那批。
      wasUnassigned: previous === undefined,
      willDispatch: auto,
    })
  }
  return {
    status: String(status ?? ''),
    auto,
    count: cards.filter(card => card.willDispatch).length,
    cards,
  }
}

/**
 * 预览要不要拦一下人：自动列 + 至少一张卡会被带走 → 面板先确认。
 * 纯函数，前端用同一条判据（见 web/src/studio/panels/governance.js）。
 */
export function previewWarning(preview) {
  if (preview === null || preview === undefined) return ''
  if (preview.auto !== true || preview.count <= 0) return ''
  const names = preview.cards.filter(card => card.willDispatch).slice(0, 5).map(card => card.code || card.id)
  const tail = preview.count > names.length ? ` 等 ${preview.count} 张` : ''
  return `这次改动会让 ${preview.count} 张卡在下一轮自动派单里被派出去：${names.join('、')}${tail}`
}
