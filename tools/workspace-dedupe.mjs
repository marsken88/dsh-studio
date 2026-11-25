#!/usr/bin/env node
/**
 * 清理侧栏里同名的重复工作区注册（会话日志不删，只是把分组注册删掉）。
 *
 *   node tools/workspace-dedupe.mjs --base http://192.168.120.218:18080            # 只列计划
 *   node tools/workspace-dedupe.mjs --base ... --apply --yes                       # 真删
 *
 * 背景：DSH 工作区按会话 cwd 精确归属；以前一卡一 worktree，同一个需求会建出
 * 多个同名 `项目 · REQ` 文件夹。分组改成 requirement 后新派单不再重复，但旧注册
 * 需要清一次。保留规则：
 *   1. 同名组里会话最多的那个；
 *   2. 一样多时，优先路径以 REQ-* 结尾的（需求级 worktree）；
 *   3. 只删路径里带 /worktrees/ 或 studio 的注册，仓库根/未知路径一律不碰。
 */
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const base = String(arg('base', process.env.STUDIO_BASE ?? '')).replace(/\/+$/, '')
const token = String(process.env.STUDIO_TOKEN ?? arg('token', '')).trim()
const apply = argv.includes('--apply')
const yes = argv.includes('--yes')
if (base === '') {
  console.error('用法：node tools/workspace-dedupe.mjs --base http://<host>:18080 [--apply --yes]')
  process.exit(2)
}
if (apply && !yes) {
  console.error('--apply 需要同时带 --yes（这是删侧栏注册，先看一遍计划）')
  process.exit(2)
}

const post = async (path, body) => {
  const response = await fetch(base + '/studio-api' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token === '' ? {} : { 'x-studio-session': token }) },
    body: JSON.stringify(body ?? {}),
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

const listed = await post('/workspace/list')
if (listed.status !== 200 || listed.body.ok !== true) {
  console.error('拿不到工作区列表：HTTP ' + listed.status + ' ' + JSON.stringify(listed.body).slice(0, 200))
  process.exit(1)
}
const workspaces = Array.isArray(listed.body.workspaces) ? listed.body.workspaces : []
const groups = new Map()
for (const item of workspaces) {
  const key = String(item.title ?? '').trim() || '(无标题)'
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(item)
}

const protectedPath = path => /\/worktrees\/|studio-wt-test|\/dsh-worktrees\//i.test(String(path ?? ''))
const requirementLike = item => /REQ-\d{4}-\d{3}\/?$/i.test(String(item.path ?? ''))

const plan = []
for (const [title, list] of groups.entries()) {
  if (list.length <= 1) continue
  const sorted = [...list].sort((a, b) => {
    if (b.sessions !== a.sessions) return b.sessions - a.sessions
    if (requirementLike(a) !== requirementLike(b)) return requirementLike(a) ? -1 : 1
    return String(a.createdAt).localeCompare(String(b.createdAt))
  })
  const keep = sorted[0]
  for (const item of sorted.slice(1)) {
    if (!protectedPath(item.path)) continue
    plan.push({ title, keep, drop: item })
  }
}

console.log(`工作区 ${workspaces.length} 个，同名分组 ${[...groups.values()].filter(list => list.length > 1).length} 个，计划删除 ${plan.length} 个注册`)
for (const entry of plan) {
  console.log(`- 「${entry.title}」保留 ${entry.keep.sessions} 会话 @ ${entry.keep.path}\n  删除 ${entry.drop.sessions} 会话 @ ${entry.drop.path}`)
}
if (plan.length === 0) {
  console.log('没有需要清理的重复注册。')
  process.exit(0)
}
if (!apply) {
  console.log('\n（只列计划；确认后加 --apply --yes 真删）')
  process.exit(0)
}
let removed = 0
for (const entry of plan) {
  const out = await post('/workspace/delete', { id: entry.drop.id, confirm: 'DELETE' })
  if (out.status === 200 && out.body.ok === true) {
    removed += 1
    console.log('已删除 ' + entry.drop.path)
  } else {
    console.error('删除失败 ' + entry.drop.path + '：' + JSON.stringify(out.body).slice(0, 160))
  }
}
console.log(`\n完成：删除 ${removed}/${plan.length} 个重复注册（会话日志未删）`)
process.exit(removed === plan.length ? 0 : 1)
