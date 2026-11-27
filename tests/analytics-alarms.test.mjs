// P0 批效益测试：告警表、吸顶唯一性、用例缺口总数。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const analytics = () => readFileSync(new URL('../web/src/studio/pages/analytics.js', import.meta.url), 'utf8')
const host = () => readFileSync(new URL('../index.js', import.meta.url), 'utf8')

test('告警线只有一份（ALARM），结论条与 KPI 都读它', () => {
  const s = analytics()
  assert.ok(s.includes('const ALARM = {'), '要有阈值表')
  const uses = s.split('alarmHit(').length - 1
  assert.ok(uses >= 5, '结论条四条 + KPI 两条都要走 alarmHit，现在 ' + uses + ' 处')
  assert.ok(!s.includes('< 0.3 || gate.rate > 0.9'), '不能再有散落的阈值判定')
})

test('显示值落在告警线上时补一位小数（89.7% 不能显示成 90% 却不报警）', () => {
  const s = analytics()
  assert.ok(s.includes('function alarmText('), '要有 alarmText')
  assert.ok(s.includes('percent.toFixed(1)'), '落在线上要补小数')
})

test('同一时刻只有一条吸顶行（筛选行不再 sticky）', () => {
  const s = analytics()
  assert.ok(!s.includes("ROW + ' ' + STICKY"), '筛选行不能再吸顶（会和页签条互相盖住）')
  assert.ok(s.includes("STICKY + ' gap-1 border-b border-separator-border'"), '页签行吸顶并带下边界')
})

test('用例缺口的总数来自 byCardTotal，不是列出来的条数', () => {
  const s = analytics()
  assert.ok(s.includes('const cardTotal = Number(cases.byCardTotal ?? rows.length)'), '要读总数')
  assert.ok(s.includes('共 ${cardTotal} 张卡'), '文案要用总数')
})

test('后端把 byCardTotal 一起下发（清单仍只回 10 条）', () => {
  const s = host()
  assert.ok(s.includes('byCard: byCard.slice(0, 10), byCardTotal: byCard.length'), '要显式给总数')
})
