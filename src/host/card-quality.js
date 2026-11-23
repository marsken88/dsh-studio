// 项目检查（本地质量命令）的数据形状与命令解析。纯函数，不碰子进程 —— 执行在 quality-runner.js。
//
// 为什么单独一个模块：domain.js 已经贴着 2000 行上限（repo 契约测试硬性要求），
// 而这块是「卡上的检查结果 + 卡该跑哪条命令」的独立责任，放这里既好测也好改。
//
// 一条链路的三个点：
//   配置：项目/服务的 qualityCmd（qualityFields 负责清洗）
//   解析：qualityTargetFor —— 服务优先、项目兜底、cwd 优先卡的 worktree
//   结果：sanitizeQuality —— 退出码/耗时/输出尾部，截断规则只有一个地方

import { projectContext } from './dispatch-cwd.js'

/** 检查输出只留尾部这么多字：整段日志塞进 state 会让轮询和快照都变慢。 */
export const QUALITY_OUTPUT_LIMIT = 4000

/** 项目/服务上的检查配置：清洗后只留这两个键，写库与读库形状一致。 */
export function qualityFields(raw) {
  const input = raw !== null && raw !== undefined && typeof raw === 'object' ? raw : {}
  return {
    qualityCmd: String(input.qualityCmd ?? '').trim().slice(0, 500),
    qualityTimeoutMs: Math.max(10_000, Math.min(600_000, Number(input.qualityTimeoutMs) || 120_000)),
  }
}

/**
 * 一次项目检查的结果：谁跑的、跑在哪、哪条命令、退出码、耗时、输出尾部。
 * 没跑过就是 null —— 「没配」和「跑过没记」是两件事，别混成一个。
 */
export function sanitizeQuality(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  const cmd = String(raw.cmd ?? '').trim().slice(0, 500)
  if (cmd === '') return null
  const exitCode = Number(raw.exitCode)
  return {
    at: Number(raw.at) || 0,
    by: String(raw.by ?? '').slice(0, 40),
    cmd,
    cwd: String(raw.cwd ?? '').slice(0, 400),
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    ms: Math.max(0, Number(raw.ms) || 0),
    ok: raw.ok === true,
    timedOut: raw.timedOut === true,
    output: String(raw.output ?? '').slice(-QUALITY_OUTPUT_LIMIT),
  }
}

/**
 * 这张卡该跑哪条项目检查命令：服务优先，项目级兜底。
 * 返回 null 表示没配（不是失败）。`cwd` 优先用卡的 worktree —— 检查的应该是这次要交的代码，
 * 不是主目录上的代码。
 */
export function qualityTargetFor(config, task, requirements = []) {
  // 项目/服务的解析与「派单会话跑在哪个目录」共用一份（dispatch-cwd.js）：
  // 两处各写一遍，迟早会出现「检查跑在 A 仓库、会话跑在 B 目录」。
  const { project, service, repoPath } = projectContext(config, task, requirements)
  const cmd = String(service?.qualityCmd ?? '').trim() || String(project?.qualityCmd ?? '').trim()
  if (cmd === '') return null
  const worktree = task?.worktree !== null && typeof task?.worktree === 'object' ? String(task.worktree.path ?? '').trim() : ''
  const timeoutMs = Math.max(10_000, Math.min(600_000, Number(service?.qualityTimeoutMs) || Number(project?.qualityTimeoutMs) || 120_000))
  return {
    cmd,
    repoPath,
    worktree,
    cwd: worktree !== '' ? worktree : repoPath,
    timeoutMs,
    service: String(service?.name ?? ''),
    source: String(service?.qualityCmd ?? '').trim() !== '' ? 'service' : 'project',
  }
}
