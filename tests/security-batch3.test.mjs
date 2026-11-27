// 第三批安全边界：权限档位、超管匹配、公开页转义、发版记录。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { ADMIN_ROUTES, LEVEL_RANK, ROLE_LEVEL } from '../src/host/domain.js'
import { accessLevelFor, checkAccess, DESTRUCTIVE_ROUTES, isReadOnlyPost, READ_ONLY_POST_ROUTES } from '../src/host/access.js'
import { toolLevel } from '../src/host/tool-access.js'
import { INTAKE_HTML, MINE_HTML, STATUS_HTML } from '../src/host/intake-pages.js'

const accessConfig = { access: { enabled: true, members: [] } }

test('access: 超管豁免只认完全相同的名字（LDAP 里叫「超级管理员（外包）」不能提权）', () => {
  assert.equal(checkAccess(accessConfig, '超级管理员', 'write', true), null, '本地超管要放行')
  assert.notEqual(checkAccess(accessConfig, '超级管理员（外包）', 'write', true), null, '子串不算超管')
  assert.notEqual(checkAccess(accessConfig, '超级管理员', 'write', false), null, '不可信身份不能靠名字豁免')
  // 「小admin」这类后缀同样不能匹配
  assert.notEqual(checkAccess(accessConfig, '小admin', 'admin', true), null)
})

test('access: 配置类与破坏性路由升到 admin 档', () => {
  for (const route of ['/projects/save', '/experts/save', '/teams/save', '/skills/upload', '/task/merge', '/release/gray', '/reset']) {
    assert.ok(ADMIN_ROUTES.has(route), `${route} 应该是 admin 路由`)
    assert.equal(accessLevelFor(route, 'POST'), 'admin', `${route} 的 POST 档位`)
  }
  assert.equal(accessLevelFor('/task/comment', 'POST'), 'write', '普通写操作仍是 write')
  assert.equal(toolLevel('studio_project_save'), 'admin', '工具层与路由层保持一致')
})

test('access: 凭证与可执行内容只有管理员能改（改仓库 URL 会带着旧 token 发请求）', () => {
  for (const route of ['/repos/save', '/bots/save', '/skills/save', '/skills/sync', '/team/memory/clear', '/suite/delete']) {
    assert.ok(ADMIN_ROUTES.has(route), `${route} 应该是 admin 路由`)
    assert.equal(accessLevelFor(route, 'POST'), 'admin', `${route} 的 POST 档位`)
  }
})

test('access: 只读 POST 按动作判定（取交付物正文 / worktree list / 设计只读 / 准出）', () => {
  assert.equal(isReadOnlyPost('/task/artifact', { id: 't-1', action: 'get' }), true, '取正文是读')
  assert.equal(isReadOnlyPost('/task/artifact', { id: 't-1', action: 'add' }), false, '登记交付物是写')
  assert.equal(isReadOnlyPost('/task/worktree', { id: 't-1', action: 'list' }), true, '列 worktree 是读')
  assert.equal(isReadOnlyPost('/task/worktree', { id: 't-1', action: 'remove' }), false, '回收 worktree 是写')
  assert.equal(isReadOnlyPost('/task/design', { id: 't-1' }), true, '只带 id = 读设计')
  assert.equal(isReadOnlyPost('/task/design', { id: 't-1', design: { status: 'approved' } }), false, '带设计变更 = 写')
  assert.equal(isReadOnlyPost('/task/gate', { id: 't-1' }), true, '算准出是读')
  assert.equal(isReadOnlyPost('/task/update', { id: 't-1', status: 'done' }), false, '推进是写')
})

test('access: 同一工具的动作可以更严——merge 是 admin，publish 仍是 write', () => {
  assert.equal(toolLevel('studio_merge_gate'), 'write', '默认动作仍然给评审/测试用')
  assert.equal(toolLevel('studio_merge_gate', { action: 'publish' }), 'write')
  assert.equal(toolLevel('studio_merge_gate', { action: 'merge' }), 'admin', '真合并必须是管理员')
})

test('access: 只读 POST 不再误判成写操作（只读成员可用）', () => {
  for (const route of ['/release/get', '/requirement/get', '/requirement/matrix', '/requirement/impact', '/requirement/assist', '/agents/policy', '/contexts', '/contexts/session', '/access/explain']) {
    assert.ok(READ_ONLY_POST_ROUTES.has(route), `${route} 应该是只读 POST`)
    assert.ok(!ADMIN_ROUTES.has(route), `${route} 不该同时是 admin`)
  }
})

test('access: 合并 MR 是破坏性操作，要带 confirm', () => {
  assert.equal(DESTRUCTIVE_ROUTES.get('/task/merge'), 'MERGE')
  const frontend = readFileSync(new URL('../web/src/studio/destructive.js', import.meta.url), 'utf8')
  assert.match(frontend, /'\/task\/merge': 'MERGE'/, '前端也要知道这个确认词')
})

test('intake 公开页：动态字段一律转义，不能再拼裸 HTML', () => {
  for (const [name, html] of [['mine', MINE_HTML], ['status', STATUS_HTML]]) {
    assert.match(html, /const esc=s=>String\(s\?\?''\)/, `${name} 页要有 esc`)
    assert.match(html, /esc\(v\.title\)|esc\(j\.title\)/, `${name} 页标题要转义`)
    assert.doesNotMatch(html, /\+v\.title\+|\+j\.title\+/, `${name} 页不能直接拼标题`)
  }
  // 提单页只用 textContent 回显，不拼 innerHTML
  assert.doesNotMatch(INTAKE_HTML, /innerHTML\s*=\s*['"][^'"]*\+/, '提单页不应该用 innerHTML 拼动态值')
})

test('changelog: 0.9.55 已发布，不能再写「待发布」', () => {
  const log = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  assert.doesNotMatch(log, /## \[0\.9\.55\] — 待发布/, '已打 tag 的版本要写实际日期')
  assert.match(log, /## \[0\.9\.55\] — \d{4}-\d{2}-\d{2}/)
  assert.match(log, /knowledgeId/, '0.9.55 的 WeKnora 幂等修复要记进更新日志')
})

test('access: 角色档位常量没被改坏（member < admin）', () => {
  assert.ok((ROLE_LEVEL.admin ?? 0) > (ROLE_LEVEL.member ?? 0))
  assert.ok((LEVEL_RANK.admin ?? 0) > (LEVEL_RANK.write ?? 0))
})
