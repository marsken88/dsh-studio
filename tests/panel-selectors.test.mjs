// 面板探针 ② 的「选对元素」判据：这两条都是真机上量错对象踩出来的，不能靠肉眼。
import assert from 'node:assert/strict'
import test from 'node:test'

import { formRowIndex, isProbeCard, normalizePointValue } from '../tools/lib/panel-selectors.mjs'

test('探针卡判据：只认带（探针）标记的那张卡', () => {
  assert.equal(isProbeCard('（探针）看板卡片DEV-001 REQ-2026-002开发工程师'), true)
  // 真机上的真实卡：点开它是 p3 卡的默认值，看起来就像产品的默认值错了
  assert.equal(isProbeCard('p3 把「先检索历史」固化进澄清与方案流程REQ-003 REQ-2026-001'), false)
  assert.equal(isProbeCard('新用例表单的功能点选择器没有继承卡上的 pointIdBUG-002'), false)
  assert.equal(isProbeCard(undefined), false, '取不到文本时不能当成探针卡')
  assert.equal(isProbeCard('自定义标题', '自定义标题'), true, '标题可传，便于换文案')
})

test('新用例表单那一行：按「这条用例算在」认行，不能认成某条用例的归属下拉', () => {
  // 真机抽屉里 .ds-row 的顺序：既有用例的归属行在前，新用例表单那一行在后
  const rows = [
    '功能点p2',
    '功能点p3',
    '这条用例算在p1｜探针功能点 A默认跟卡上的功能点；改这里只影响新加的这条',
    '功能',
  ]
  const index = formRowIndex(rows)
  assert.equal(index, 2, '要选中表单那一行，不是第一条用例')
  assert.equal(rows[formRowIndex(rows)].includes('p1'), true)
  // 抽屉里没有表单（需求没拆功能点时整个表单不渲染）
  assert.equal(formRowIndex(['功能点p1', '功能']), -1)
  assert.equal(formRowIndex([]), -1)
  assert.equal(formRowIndex(undefined), -1, '不是数组也不能抛')
})

test('功能点下拉的取值归一：__empty__ 与空串是同一件事', () => {
  assert.equal(normalizePointValue('p1'), 'p1')
  assert.equal(normalizePointValue('__empty__'), '', 'react-aria 的空值哨兵要当成未选')
  assert.equal(normalizePointValue(''), '')
  assert.equal(normalizePointValue(undefined), '')
  // 判据本身：卡上没有 pointId 时，表单必须是「不归功能点」
  assert.equal(normalizePointValue('__empty__') === '', true)
  assert.equal(normalizePointValue('p3') === '', false)
})
