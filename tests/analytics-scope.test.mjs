// 第三批 B：四个指标 + 上下文洞察都跟「当前项目」走（以前只有负载/质量/成本跟）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { overrideSummary } from '../src/host/override.js'
import { requirementDelivery } from '../src/host/delivery.js'

const state = {
  requirements: [
    { id: 'r1', code: 'REQ-1', project: 'alpha', status: 'delivered', createdAt: 1000, signoff: { at: 3 * 86400000 + 1000 } },
    { id: 'r2', code: 'REQ-2', project: 'beta', status: 'delivered', createdAt: 1000, signoff: { at: 9 * 86400000 + 1000 } },
  ],
  tasks: [
    { id: 't1', code: 'DEV-001', title: '甲', project: 'alpha', override: { at: 5, by: 'lead', reason: '赶版本' } },
    { id: 't2', code: 'DEV-002', title: '乙', project: 'beta', override: { at: 6, by: 'lead', reason: '赶版本' } },
    { id: 't3', code: 'DEV-003', title: '丙', override: { at: 7, by: 'lead', reason: '没归属' } },
  ],
}

test('强制放行：给了 project 就只算这个项目（含需求侧），不给就是全公司', () => {
  const all = overrideSummary(state, { since: 0, project: '' })
  const alpha = overrideSummary(state, { since: 0, project: 'alpha' })
  const beta = overrideSummary(state, { since: 0, project: 'beta' })
  assert.equal(all.total, 3, '不选项目 = 全公司')
  assert.equal(alpha.total, 1)
  assert.equal(alpha.list[0].code, 'DEV-001')
  assert.equal(beta.total, 1)
  assert.equal(beta.list[0].code, 'DEV-002')
  assert.equal(alpha.total + beta.total, all.total - 1, '未归属项目的那张只在全公司口径里')
})

test('需求交付时长：按项目筛需求（同一份函数，两种口径）', () => {
  const all = requirementDelivery(state.requirements)
  const alpha = requirementDelivery(state.requirements.filter(item => item.project === 'alpha'))
  assert.equal(all.count, 2)
  assert.equal(alpha.count, 1)
  assert.ok(alpha.medianDays < all.medianDays, '只算 alpha 应该比混在一起短')
})

test('源码守卫：四个指标 + 上下文都用当前项目口径', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(index, /dispatch: dispatchWeekly\(inScope,/, '派单周活要用 inScope（以前是全量）')
  assert.match(index, /delivery: requirementDelivery\(scopedRequirements\)/, '交付时长要按项目收需求')
  assert.match(index, /scopedRequirements\.filter\(item => \['delivered', 'closed'\]/, '自动化率要用项目内的需求 id')
  assert.match(index, /overrides: overrideSummary\(state, \{ since, project,/, '强制放行要传 project')

  const route = readFileSync(new URL('../src/host/routes/insights.js', import.meta.url), 'utf8')
  assert.match(route, /const project = String\(body\?\.project/, '/contexts 要读 project')
  assert.match(route, /sessions\.filter\(session => ids\.has/, '/contexts 要按项目里的卡过滤会话')
  assert.match(route, /const since = days > 0 \? Date\.now\(\) - days \* 86400000 : 0/, '/contexts 要读 days')
})

