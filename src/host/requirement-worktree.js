/* 需求级 worktree：同一个需求的所有角色共用一个目录，会话因此落在同一个侧栏工作区。
 * 研发卡并发时 dispatcher 仍会给它单独建卡级 worktree（见 ensureWorktree），这里只做共享那份。
 * 纯 IO + 注入的 git/项目解析，放在模块里避免 index.js 继续膨胀（index 有行数棘轮）。
 */
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { worktreeBaseFor } from './dispatch-cwd.js'

export async function ensureRequirementWorktree({ store, task, config, workProjectOf, serviceOf, runCommandFn }) {
  const enabled = String(config?.agents?.isolation ?? 'none') === 'worktree'
  if (!enabled) return { skipped: 'isolation=none' }
  const requirement = (store.snapshot().requirements ?? []).find(item => item.id === String(task?.requirementId ?? ''))
  const reqCode = String(requirement?.code ?? '').trim() || String(requirement?.id ?? '').trim()
  if (reqCode === '') return { skipped: '卡没挂需求' }
  const project = workProjectOf(config, task)
  if (project === undefined) return { skipped: '卡没挂业务项目' }
  const service = serviceOf(config, task)
  const repo = String(service?.repoPath ?? '').trim() || String(project.repoPath ?? '').trim()
  if (repo.length === 0) return { skipped: '项目没配本机代码目录' }
  const probe = await runCommandFn('git', ['-C', repo, 'rev-parse', '--is-inside-work-tree'], 20000)
  if (!probe.ok) return { skipped: `${repo} 不是 git 仓库`.slice(0, 300) }
  const branch = `task/${reqCode}`
  const path = join(worktreeBaseFor(config, repo), reqCode)
  const alive = await runCommandFn('git', ['-C', repo, 'worktree', 'list', '--porcelain'], 20000)
  if (alive.ok && String(alive.stdout).includes(`worktree ${path}`)) {
    return { path, branch, repo, base: '', service: String(service?.id ?? ''), serviceName: String(service?.name ?? project.name ?? ''), at: Date.now(), shared: true }
  }
  await mkdir(dirname(path), { recursive: true })
  let base = String(service?.baseBranch ?? project.baseBranch ?? '').trim()
  const branchOk = async name => name !== '' && (await runCommandFn('git', ['-C', repo, 'rev-parse', '--verify', 'refs/heads/' + name], 20000)).ok
  if (!(await branchOk(base))) {
    const current = await runCommandFn('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], 20000)
    base = (current.ok ? String(current.stdout).trim() : '') || base || 'main'
  }
  const branches = await runCommandFn('git', ['-C', repo, 'branch', '--list', branch], 20000)
  const exists = branches.ok && String(branches.stdout).trim().length > 0
  const added = exists
    ? await runCommandFn('git', ['-C', repo, 'worktree', 'add', path, branch], 60000)
    : await runCommandFn('git', ['-C', repo, 'worktree', 'add', '-b', branch, path, base], 60000)
  if (!added.ok) {
    const message = (added.stderr || added.stdout || '').trim().split('\n')[0] ?? ''
    return { skipped: `需求 worktree 失败：${message}`.slice(0, 300) }
  }
  return { path, branch, repo, base, service: String(service?.id ?? ''), serviceName: String(service?.name ?? project.name ?? ''), at: Date.now(), shared: true }
}
