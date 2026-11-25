// 派单会话跑在哪个目录、注册成什么工作区。
//
// 这条链是「派出去的智能体落在哪个工作区」的唯一判据：DSH 按会话 cwd 归属工作区，
// 跑在 ~/dsh-workspace 里的派单不属于任何项目工作区，侧栏里只能落在「未分组」。
// 所以这里把规则钉死：worktree > 项目代码目录 > 兜底目录。
import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { STUDIO_WORKSPACE_TITLE, dispatchDirFor, pathKey, projectContext, workspaceAttachPlan, worktreeBaseFor } from '../src/host/dispatch-cwd.js'

const CONFIG = {
  agents: { workspaceDir: '/tmp/ws', worktreeRoot: '' },
  projects: [
    {
      id: 'p1',
      name: '订单中心',
      repoPath: '/repos/order',
      services: [
        { id: 's1', name: 'order-api', repoPath: '/repos/order-api' },
        { id: 's2', name: 'order-web' },
      ],
    },
    { id: 'p2', name: '无仓库项目', services: [] },
  ],
}

const CARD = { id: 't-abc12345', code: 'DEV-001', project: 'p1', service: 's1' }

test('projectContext：卡上的项目与服务决定仓库，服务仓库优先于项目仓库', () => {
  const out = projectContext(CONFIG, CARD)
  assert.equal(out.projectId, 'p1')
  assert.equal(out.projectName, '订单中心')
  assert.equal(out.serviceName, 'order-api')
  assert.equal(out.repoPath, '/repos/order-api')
})

test('projectContext：卡没挂项目时退回它所属需求的项目', () => {
  const requirements = [{ id: 'req-1', project: 'p1' }]
  const out = projectContext(CONFIG, { id: 't-1', requirementId: 'req-1' }, requirements)
  assert.equal(out.projectName, '订单中心')
  assert.equal(out.repoPath, '/repos/order', '卡没指定服务、项目有两个服务时不猜，用项目级仓库')
})

test('projectContext：项目只有一个服务时视为这张卡的服务', () => {
  const config = { projects: [{ id: 'p3', name: '单品项目', services: [{ id: 'only', name: 'svc', repoPath: '/repos/only' }] }] }
  assert.equal(projectContext(config, { project: 'p3' }).repoPath, '/repos/only')
})

test('projectContext：不属于任何项目时 repoPath 为空（不报错，交给兜底）', () => {
  const out = projectContext(CONFIG, { id: 't-2' })
  assert.equal(out.project, undefined)
  assert.equal(out.repoPath, '')
})

test('派单目录：建了 worktree 就用它，工作区名带上卡号', () => {
  const plan = dispatchDirFor({ task: CARD, worktree: { path: '/repos/order-api/.agents/worktrees/DEV-001-abc12345' }, context: projectContext(CONFIG, CARD), fallbackDir: '/tmp/ws' })
  assert.equal(plan.kind, 'worktree')
  assert.equal(plan.dir, '/repos/order-api/.agents/worktrees/DEV-001-abc12345')
  assert.equal(plan.title, '订单中心 · DEV-001')
})

test('派单目录：没有 worktree 时跑在项目仓库里（会话才会落在项目工作区）', () => {
  const plan = dispatchDirFor({ task: CARD, context: projectContext(CONFIG, CARD), fallbackDir: '/tmp/ws' })
  assert.equal(plan.kind, 'repo')
  assert.equal(plan.dir, '/repos/order-api')
  assert.equal(plan.title, '订单中心', '仓库工作区用项目名，不再叫「需求&任务工作空间」')
})

test('派单目录：项目没配代码目录才退回兜底目录，标题固定（同一个目录不因先派哪张卡而定名）', () => {
  const card = { ...CARD, project: 'p2' }
  const first = dispatchDirFor({ task: card, context: projectContext(CONFIG, card), fallbackDir: '/tmp/ws' })
  const second = dispatchDirFor({ task: { ...card, id: 't-def67890', code: 'DEV-002' }, context: projectContext(CONFIG, card), fallbackDir: '/tmp/ws' })
  assert.equal(first.kind, 'scratch')
  assert.equal(first.dir, '/tmp/ws')
  assert.equal(first.title, STUDIO_WORKSPACE_TITLE)
  assert.equal(second.title, first.title)
  assert.notEqual(STUDIO_WORKSPACE_TITLE, '需求&任务工作空间', '看板标题不该被当成工作区名')
})

test('worktree 根：显式配置优先，否则建在仓库内 .agents/worktrees，没仓库才回落', () => {
  assert.equal(worktreeBaseFor({ agents: { worktreeRoot: '/mnt/wt' } }, '/repos/order'), '/mnt/wt')
  assert.equal(worktreeBaseFor(CONFIG, '/repos/order'), join('/repos/order', '.agents', 'worktrees'))
  assert.equal(worktreeBaseFor({ agents: { workspaceDir: '/tmp/ws' } }, ''), join('/tmp', 'dsh-worktrees'))
})

test('pathKey：分隔符、尾斜杠、大小写都不影响比较', () => {
  assert.equal(pathKey('C:\\Users\\hp\\dsh-workspace\\'), 'c:/users/hp/dsh-workspace')
  assert.equal(pathKey('C:/Users/hp/dsh-workspace'), 'c:/users/hp/dsh-workspace')
  assert.equal(pathKey('  /repos/order//  '), '/repos/order')
  assert.equal(pathKey(undefined), '')
})

test('补挂计划：cwd 落在某个工作区目录里、却不在名单上的会话才要补', () => {
  const workspaces = [
    { id: 'w1', path: 'C:\\Users\\hp\\dsh-workspace', sessionIds: ['studio-t-1-dev'] },
    { id: 'w2', path: '/repos/order', sessionIds: [] },
  ]
  const sessions = [
    { id: 'studio-t-1-dev', cwd: 'C:/Users/hp/dsh-workspace' }, // 已在名单里
    { id: 'studio-t-2-dev', cwd: 'C:\\Users\\hp\\dsh-workspace\\' }, // 同目录、不同写法
    { id: 'studio-t-3-dev', cwd: '/repos/order' },
    { id: 'studio-t-4-dev', cwd: '/somewhere/else' }, // 没有对应工作区
    { id: 'session-user-1', cwd: '/repos/order' }, // 调用方自己先筛掉别人的会话也行
    { id: '', cwd: '/repos/order' },
  ]
  assert.deepEqual(workspaceAttachPlan({ sessions, workspaces }), [
    { workspaceId: 'w1', sessionId: 'studio-t-2-dev' },
    { workspaceId: 'w2', sessionId: 'studio-t-3-dev' },
    { workspaceId: 'w2', sessionId: 'session-user-1' },
  ])
})

test('补挂计划：空输入、没工作区、会话头没 cwd 都不炸也不产出', () => {
  assert.deepEqual(workspaceAttachPlan(), [])
  assert.deepEqual(workspaceAttachPlan({ sessions: [{ id: 'studio-a', cwd: '/x' }], workspaces: [] }), [])
  assert.deepEqual(workspaceAttachPlan({ sessions: [{ id: 'studio-a' }, { id: 'studio-b', cwd: '' }], workspaces: [{ id: 'w', path: '/x' }] }), [])
})


test('派单目录：按需求分组时，产品/架构/测试与单张研发卡都落同一个需求 worktree', () => {
  const requirement = { id: 'r1', code: 'REQ-2026-001' }
  const requirementWorktree = { path: '/repos/order-api/.agents/worktrees/REQ-2026-001', shared: true }
  const plan = dispatchDirFor({
    task: CARD,
    context: projectContext(CONFIG, CARD),
    fallbackDir: '/tmp/ws',
    grouping: 'requirement',
    requirement,
    requirementWorktree,
  })
  assert.equal(plan.kind, 'requirement')
  assert.equal(plan.dir, requirementWorktree.path)
  assert.equal(plan.title, '订单中心 · REQ-2026-001', '同一需求的会话要落同一个侧栏文件夹')
})

test('派单目录：按需求分组但研发卡并发时，仍给研发卡单独的 worktree 隔离', () => {
  const requirement = { id: 'r1', code: 'REQ-2026-001' }
  const requirementWorktree = { path: '/repos/order-api/.agents/worktrees/REQ-2026-001', shared: true }
  const plan = dispatchDirFor({
    task: CARD,
    worktree: { path: '/repos/order-api/.agents/worktrees/DEV-001-abc12345' },
    context: projectContext(CONFIG, CARD),
    fallbackDir: '/tmp/ws',
    grouping: 'requirement',
    requirement,
    requirementWorktree,
  })
  assert.equal(plan.kind, 'worktree')
  assert.equal(plan.dir, '/repos/order-api/.agents/worktrees/DEV-001-abc12345')
  assert.equal(plan.title, '订单中心 · REQ-2026-001 · DEV-001', '并发研发卡的标题要能区分')
})
