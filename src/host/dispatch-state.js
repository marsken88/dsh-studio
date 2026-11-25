/* 派单阶段的状态判定（纯函数）。
 *
 * 为什么要单独抽出来：`tick()` 判「这张卡这一列派过没有」的依据是
 *
 *     if (task.dispatch?.status === task.status) continue
 *
 * 而 `reconcile()` 以前只把 dispatch.state 改成 stopped、保留 dispatch.status，
 * 于是重启后那张卡的 dispatch.status 等于当前列 → 永远跳过 → **永久停摆**，
 * 界面上却显示「已停止」，看着像正常状态（2026-11-18 后端架构师实测）。
 *
 * 「重新派单」按钮当时也一样：只清失败计数、不清 dispatch 印记，所以按下去永不重派。
 *
 * 这两个 bug 的共同点是「状态形状看着对、语义不对」，只能靠断言而不是肉眼防住。
 * 所以把判定抽成纯函数，并在这里写死五种阶段的定义。
 */

/** 派单阶段。
 *  running  正在跑（会话活着）
 *  stalled  印记还在、但已经不在跑 —— 这就是「永久停摆」的形状，必须能被识别出来
 *  queued   没有被本列派过（或印记已清），下一轮 tick 会拾起它
 *  done     本列这一轮的活**正常跑完了**（agent 正常结束），不再无条件重派
 *  idle     人主动按了「停止」：保留列名，等人决定怎么继续
 */
/* 2026-11-22 补第三种坑：**state 写着 running，会话其实早就没了**。
   本机实测：派单记录 status=review / state=running，会话文件只有头，18 分钟没有任何输出。
   因为 state 仍是 running，既不算 stalled（不提示）、也不会被下一轮 tick 拾起（永不重派）——
   比「stopped 停摆」更隐蔽。

   2026-11-25 补第四种坑（用户实测「卡正常跑完就再也不动了 / 或者反过来一直自己重跑」）：
   `settle()` 以前把整条印记换成 `{...info, state:'idle'}`，**把 status 一起写没了**，
   于是下一轮 tick 认为「这一列没派过」→ 同一个 agent 立刻再跑一遍，无限循环；
   而 reset 之前派过的印记匹配当前列时，又永远不再派。现在正常结束写成
   `state:'done'` + 保留 status + `advanced`（这一轮结束时卡有没有换列）：
   没换列 → 冷却后「催一次」（有次数上限，用完挂阻塞），换列 → 交给下一列。
   是否催派由 handoffRetry 判，判据与 tick、/columns 预览共用。

   ctx（可不传，不传就按 10 分钟兜底）：
     now               当前时间戳
     runningTimeoutMs  running 多久没动静算挂死
     isLive(sessionId) 会话是否真的活着；传了就以它为准（真会话表比时间戳可靠）
 */
export const RUNNING_TIMEOUT_MS = 10 * 60 * 1000

/** 「跑完但没推进」催派：默认冷却 60 秒、最多催到第 3 次（含首轮）。
 *  dispatcher 会按 config.agents.retry 覆盖（max + 1 次、baseMs 冷却）。 */
export const HANDOFF_COOLDOWN_MS = 60 * 1000
export const HANDOFF_MAX_ATTEMPTS = 3

export function dispatchPhase(task, ctx = {}) {
  const dispatch = task?.dispatch ?? null
  if (dispatch === null || typeof dispatch !== 'object') return 'queued'
  if (dispatch.status !== task?.status) return 'queued'
  /* 主动停止（面板/工具点了停止，dispatcher.abortTask 写的）不是故障：
     它保留列名、只把 state 置成 stopped。崩溃恢复那条路会把 status 清空，
     所以「stopped 且列名匹配」只可能是人主动停的——当成 stalled 会让看板永远挂一个
     假的「停摆 N 张」红点（2026-11-23 真机就是这个）。 */
  if (dispatch.state === 'stopped') return 'idle'
  /* 正常结束：agent 这一轮跑完了（settle 写的）。这一列该不该再催，看 advanced / attempts，
     由 handoffRetry 判；这里只回答「它在不在跑」。老数据里的 state:'idle' 也是这个意思。 */
  if (dispatch.state === 'done' || dispatch.state === 'idle') return 'done'
  if (dispatch.state !== 'running') return 'stalled'
  const isLive = typeof ctx.isLive === 'function' ? ctx.isLive : null
  if (isLive !== null) return isLive(dispatch.sessionId) ? 'running' : 'stalled'
  const now = Number(ctx.now ?? Date.now())
  const timeout = Number(ctx.runningTimeoutMs ?? RUNNING_TIMEOUT_MS)
  const at = Number(dispatch.at ?? 0)
  if (timeout > 0 && at > 0 && now - at > timeout) return 'stalled'
  return 'running'
}

/** 停摆判定：印记匹配当前列，但会话已经不在跑。
 *  看板上出现任何一张这样的卡都算异常 —— 它们不会自己恢复，也不会再被派单。 */
export function isStalled(task, ctx = {}) {
  return dispatchPhase(task, ctx) === 'stalled'
}

/** 统计停摆的卡（给探针与工作台用）。 */
export function countStalled(tasks, ctx = {}) {
  const list = Array.isArray(tasks) ? tasks : []
  return list.filter(task => isStalled(task, ctx)).length
}

/** 进程重启把「跑着的派单」收掉时，这张卡该记成第几次尝试。
 *
 *  注释里一直写着「并把本轮记为一次 abandoned 尝试」，但代码只是原样保留 attempts ——
 *  崩过的这一轮不进计数，重试上限就永远判不到（CTO 评审点名的"注释与代码不一致"）。
 *  返回新的 attempts 与是否已经用尽（用尽就不该再自动派）。 */
export function abandonedRetry(dispatch, maxAttempts = 3) {
  const previous = Number(dispatch?.attempts ?? 0) || 0
  const attempts = previous + 1
  const limit = Number(maxAttempts) > 0 ? Number(maxAttempts) : 3
  return { attempts, previous, exhausted: attempts >= limit }
}

/** 上一轮正常结束、但卡片没有换列：还要不要再派一次？
 *
 *  形状（settle 写的）：{ state:'done', status:<跑的那一列>, attempts:N, advanced:false, at }
 *  返回 { attempts, max, exhausted, waitMs }：
 *    exhausted  已经催满上限 —— 该挂阻塞等人，不再自动派
 *    waitMs     还要等多久（冷却窗口内 > 0）
 *
 *  为什么要冷却：agent 正常说完话就结束，tick 每 5 秒一轮；没有冷却的话
 *  「跑完→立刻再派」会在几十秒里把同一个会话连开十几轮（真机 2026-11-22 实测 20 秒一轮）。
 */
export function handoffRetry(dispatch, options = {}) {
  const attempts = Number(dispatch?.attempts ?? 0) || 0
  const rawMax = Number(options.maxAttempts)
  const max = Number.isFinite(rawMax) && rawMax > 0 ? Math.trunc(rawMax) : HANDOFF_MAX_ATTEMPTS
  const rawCooldown = Number(options.cooldownMs)
  const cooldownMs = Number.isFinite(rawCooldown) && rawCooldown >= 0 ? Math.trunc(rawCooldown) : HANDOFF_COOLDOWN_MS
  const now = Number(options.now ?? Date.now())
  const at = Number(dispatch?.at ?? 0) || 0
  const waitMs = at > 0 ? Math.max(0, at + cooldownMs - now) : 0
  return { attempts, max, exhausted: attempts >= max, waitMs }
}

/** 重启时要不要「接着派这张卡」。
 *  两种形状要接：① 进程结束时还在跑（state running，被 reconcile 收成 queued+resume）；
 *  ② 正常结束但没推进列（done/idle + advanced !== true）。人主动停的不接。 */
export function restartResume(dispatch) {
  if (dispatch === null || typeof dispatch !== 'object') return false
  if (dispatch.state === 'stopped') return false
  if (dispatch.state === 'running') return true
  if (dispatch.state === 'done' || dispatch.state === 'idle') return dispatch.advanced !== true
  return false
}
