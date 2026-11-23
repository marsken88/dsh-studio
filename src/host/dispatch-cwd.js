// 派单会话跑在哪个目录、注册成什么名字的工作区。
//
// 为什么单独一个模块：DSH 的工作区是按会话的 canonical cwd 归属的，所以「会话跑在哪」
// 直接决定它出现在侧栏哪个工作区里。以前派单一律跑 `agents.workspaceDir`（默认
// ~/dsh-workspace）或工作区同级的 worktree 根，这两个目录都不属于任何项目工作区 ——
// 派出去的会话只能落在「未分组」里，人看不出这张卡在改哪个仓库。
//
// 现在的规则（服务优先、项目兜底、worktree 最优先）：
//   1. 这轮真的建了/复用了 worktree → 用它（它在仓库内 .agents/worktrees 下）
//   2. 项目或服务配了「本机代码目录」→ 就用那个仓库，会话因此落在项目工作区里
//   3. 都没有 → 退回 workspaceDir 的临时目录，工作区名固定为「Studio 工作区」
//
// 这里只有纯函数：建目录、注册工作区由 dispatcher.ensureSession 执行。

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { worktreeRoot } from './domain.js'

/** 没有项目仓库可用时，派单会话的兜底工作区名（别再叫「需求&任务工作空间」——那是看板标题）。 */
export const STUDIO_WORKSPACE_TITLE = 'Studio 工作区'

/**
 * worktree 建在哪：显式配了 worktreeRoot 就听配置；否则建在仓库内 `.agents/worktrees`；
 * 连仓库都没有时退回工作区同级的 dsh-worktrees（老行为）。
 *
 * 为什么不默认放仓库外：DSH 的工作区按会话 cwd 归属，worktree 在仓库外的话，
 * 这张卡的派单在侧栏里又是一个独立/未分组的工作区，人分不清它在改哪个仓库。
 */
export function worktreeBaseFor(config, repo) {
  const explicit = String(config?.agents?.worktreeRoot ?? '').trim()
  if (explicit.length > 0) return explicit
  const root = String(repo ?? '').trim()
  if (root.length > 0) return join(root, '.agents', 'worktrees')
  return worktreeRoot(config)
}

/**
 * 一张卡对应的业务项目与服务：卡上没挂项目时退回它所属需求的项目。
 * 服务按卡上的 service 找；项目只有一个服务时视为那张卡的服务。
 * 返回 undefined 的 project 表示这条卡不属于任何项目（不报错，调用方自己兜底）。
 */
export function projectContext(config, task, requirements = []) {
  const list = Array.isArray(requirements) ? requirements : []
  const projectId = String(task?.project ?? '').trim()
    || String(list.find(item => item.id === String(task?.requirementId ?? ''))?.project ?? '').trim()
  const project = (config?.projects ?? []).find(item => item.id === projectId)
  const services = Array.isArray(project?.services) ? project.services : []
  const service = services.find(item => item.id === String(task?.service ?? ''))
    ?? (services.length === 1 ? services[0] : undefined)
  return {
    projectId,
    project,
    service,
    projectName: String(project?.name ?? '').trim(),
    serviceName: String(service?.name ?? '').trim(),
    repoPath: String(service?.repoPath ?? '').trim() || String(project?.repoPath ?? '').trim(),
  }
}

/**
 * 这次派单的会话目录与工作区标题。
 *
 * - `worktree` 传 host.ensureWorktree() 的返回值（没建/被跳过时是 undefined 或 `{skipped}`）
 * - `context` 传 projectContext() 的结果
 * - `fallbackDir` 传 workspaceDir 解析出来的目录（配置为空时调用方给 ~/dsh-workspace）
 *
 * 标题只在「新建」工作区时生效：同一个路径已经注册过时 DSH 会复用旧标题，
 * 所以兜底目录的标题必须是固定的（不能带卡号），否则同一个目录会因为先派哪张卡而定名。
 */
export function dispatchDirFor({ task, worktree, context, fallbackDir } = {}) {
  const code = String(task?.code ?? '').trim() || String(task?.id ?? '').trim().slice(-8)
  const projectName = String(context?.projectName ?? '').trim()
  const repoPath = String(context?.repoPath ?? '').trim()
  const worktreePath = String(worktree?.path ?? '').trim()
  if (worktreePath !== '') {
    return {
      kind: 'worktree',
      dir: worktreePath,
      title: projectName !== '' ? `${projectName} · ${code}` : `${STUDIO_WORKSPACE_TITLE} · ${code}`,
    }
  }
  if (repoPath !== '') {
    return { kind: 'repo', dir: repoPath, title: projectName !== '' ? projectName : STUDIO_WORKSPACE_TITLE }
  }
  return { kind: 'scratch', dir: String(fallbackDir ?? '').trim(), title: STUDIO_WORKSPACE_TITLE }
}
