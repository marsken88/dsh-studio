// 合并门禁：这张卡的 MR 现在能不能合入。
//
// 和 taskExitGate 的区别（很重要，别合并成一个）：
//   准出 = 这张卡能不能进「已完成」：要清单全勾、要人签字、要看依赖服务 —— 那是**验收**；
//   合并 = 这段代码能不能合进主干：要评审通过、要用例跑过、要项目检查过、要代码事实对得上 —— 那是**证据**。
// 拿验收门禁去卡合并会出两个问题：没签字就合不了（现实中通常先合再验收），
// 以及合完才发现质量闸门没过（那时回滚成本已经上去了）。
//
// 这个函数的结果有两处消费：
//   1. 发布到 GitLab 的提交状态（studio/merge-gate）——开了「状态检查必须通过」的仓库，合并按钮会被真的拦住；
//   2. 卡上记「已合并」之前先过一遍，不许自报合并。
// 纯函数，方便单测；不碰网络（发状态在 integrations.js）。
import { isExecutable } from './case-strength.js'
import { qualityTargetFor } from './card-quality.js'

/** 状态检查的名字：GitLab 上看到的就是这个。改名等于让所有仓库的必需检查失效，别动。 */
export const MERGE_GATE_NAME = 'studio/merge-gate'

/**
 * 这张卡的合并门禁。
 * @returns {{applicable:boolean, ready:boolean, blockers:string[]}}
 *   applicable=false 表示这张卡没有代码改动（产品卡/设计卡），门禁不适用，不算拦。
 */
export function mergeGateFor(state, task) {
  const blockers = []
  const coding = task?.coding ?? null
  const cases = Array.isArray(task?.cases) ? task.cases : []
  const executable = cases.filter(item => isExecutable(item))
  const passed = executable.filter(item => item.result === 'pass')
  const failed = cases.filter(item => item.result === 'fail')
  const applicable = coding !== null || Number(task?.gitlabMR?.iid ?? 0) > 0
  if (applicable !== true) return { applicable: false, ready: true, blockers }

  if (task?.blocked !== null && task?.blocked !== undefined) blockers.push('这张卡还挂着阻塞标记')

  /* 用例：要么没有用例（这时只靠评审和项目检查），要么至少一条能跑、没有失败、且至少一条通过。
     只有标题的用例不能当合并依据——那正是「全绿但没验过」的老问题。 */
  if (failed.length > 0) {
    blockers.push(`${failed.length} 条用例不通过：${failed.slice(0, 3).map(item => String(item.title ?? '').trim()).join('、')}`)
  } else if (cases.length > 0 && executable.length === 0) {
    blockers.push(`${cases.length} 条用例都只有标题，没有一条带可执行定义（http / shell / db）：合并前至少要有能跑的断言`)
  } else if (executable.length > 0 && passed.length === 0) {
    blockers.push(`${executable.length} 条可执行用例一条都没通过`)
  }

  if (coding !== null) {
    const reviewStatus = String(coding.review?.status ?? '')
    if (reviewStatus !== 'approved') {
      blockers.push(reviewStatus === 'changes_requested'
        ? `代码评审要求修改：${String(coding.review?.note ?? '').slice(0, 80) || '评审人要求改'}`
        : '代码评审还没通过')
    }
  } else {
    /* 有 MR 就说明有代码改动；没有执行记录时评审、提交、改动文件全都没有可核对的依据。
       以前这里直接跳过评审检查，结果「只挂一个 gitlabMR、什么都不登记」也能过门禁（2026-11-22 真机抓到）。 */
    blockers.push('还没有执行记录（studio_task_coding）：有 MR 的卡必须登记编码代理、分支、提交与改动文件，否则无法对账')
  }

  // 执行记录 vs 代码事实：自报的提交/文件在分支上找不到，合并就是把没验过的东西合进去。
  const verified = coding?.verified ?? null
  if (verified !== null && verified.ok !== true) {
    const bits = []
    if (verified.branchOk !== true) bits.push('分支对不上')
    if ((verified.missingCommits ?? []).length > 0) bits.push(`${verified.missingCommits.length} 个自报提交不在分支上`)
    if ((verified.missingFiles ?? []).length > 0) bits.push(`${verified.missingFiles.length} 个自报文件没有实际改动`)
    blockers.push(`执行记录和代码对不上：${bits.join('；') || '核对没通过'}`)
  }

  // 项目检查：配了就必须跑过（和准出同一条判据，避免两边标准不一致）。
  const qualityTarget = qualityTargetFor(state?.config ?? {}, task, state?.requirements ?? [])
  if (qualityTarget !== null && coding !== null) {
    const quality = task.quality ?? null
    if (quality === null) blockers.push(`项目配了检查命令（${qualityTarget.cmd}），这张卡还没跑过`)
    else if (quality.ok !== true) blockers.push(`项目检查不通过：${qualityTarget.cmd}（${quality.timedOut === true ? '超时' : `退出码 ${quality.exitCode}`}）`)
  }

  // GitLab 上最近一次流水线失败：CI 都没过就别合。
  const pipeline = String(coding?.gitlab?.pipeline ?? task?.gitlabMR?.pipeline?.status ?? '')
  if (pipeline === 'failed') blockers.push('GitLab 流水线没通过')

  return { applicable: true, ready: blockers.length === 0, blockers }
}

/** 发布到 GitLab 的那条状态（写回卡上的形状）：谁发的、发在哪个 sha、结论是什么。 */
export function sanitizeMergeGate(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  const at = Number(raw.at) || 0
  if (at === 0) return null
  const state = ['success', 'failed', 'pending'].includes(String(raw.state)) ? String(raw.state) : 'pending'
  return {
    at,
    /* applicable 以前在这里被丢掉：面板只能看到 blockers 空，于是「不适用」被当成「已通过」。 */
    applicable: raw.applicable !== false,
    by: String(raw.by ?? '').slice(0, 40),
    state,
    name: String(raw.name ?? MERGE_GATE_NAME).slice(0, 40),
    sha: String(raw.sha ?? '').slice(0, 40),
    iid: Math.max(0, Number(raw.iid) || 0),
    description: String(raw.description ?? '').slice(0, 200),
    blockers: (Array.isArray(raw.blockers) ? raw.blockers : []).map(item => String(item).slice(0, 120)).slice(0, 8),
    /** 出错时也留一条记录：面板要能看出「没发出去」而不是「没配」。 */
    error: String(raw.error ?? '').slice(0, 300),
  }
}

/** 一句话说明门禁结论（面板与工具共用，别各写一套）。 */
export function mergeGateLine(gate) {
  if (gate.applicable !== true) return '这张卡没有代码改动，合并门禁不适用'
  return gate.ready ? '合并门禁通过：评审、用例、项目检查都过了' : `合并门禁没过：${gate.blockers.slice(0, 2).join('；')}${gate.blockers.length > 2 ? ` 等 ${gate.blockers.length} 条` : ''}`
}

/**
 * 自动刷新要不要重新发一次提交状态。
 *
 * GitLab 的提交状态是挂在 commit 上的：推了新提交，旧结论就不代表现在这段代码了。
 * 但每次同步（60 秒一轮）都发一条一模一样的会让 MR 页面刷屏，所以只在
 * **头提交变了 / 结论变了 / 上次发失败了** 这三种情况下才重发。
 *
 * @param task 卡上的任务（读 mergeGate 历史）
 * @param next { sha, ready } 这次算出来的结论
 */
export function mergeGateNeedsRefresh(task, next) {
  const last = task?.mergeGate ?? null
  if (last === null || last === undefined) return true
  const sha = String(next?.sha ?? '')
  const state = next?.ready === true ? 'success' : 'failed'
  if (String(last.error ?? '') !== '') return true       // 上次没发出去：重试
  if (String(last.sha ?? '') !== sha) return true         // 新提交
  return String(last.state ?? '') !== state               // 结论变了（评审过了 / 用例挂了）
}
