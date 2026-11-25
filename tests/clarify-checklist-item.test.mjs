// REQ-2026-001 / p3：澄清卡的「先检索历史」必须落成清单项。
// 为什么单独一条：派单提示词是软约束，准出闸门（taskExitGate）只拦清单里没勾的项——
// 只写提示词，模型跳过检索、卡也照样推得走。这条测的是「清单」这一半，另外守两处建卡入口的接线。
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { withClarifyHistoryItem, checklistFromAcceptance } from '../src/host/acceptance.js'

const HISTORY = '已检索历史结论'

test('澄清 + 空清单：补一条，文案点明「命中/没命中都要留痕」', () => {
  const next = withClarifyHistoryItem([], 'clarify')
  assert.equal(next.length, 1)
  assert.equal(next[0].id, 'c-history')
  assert.match(next[0].text, new RegExp(HISTORY))
  assert.match(next[0].text, /已检索，无命中/)
  assert.equal(next[0].done, false, '建卡时不能预勾，等真检索过再勾')
  assert.equal(next[0].by, '')
  assert.equal(next[0].note, '')
})

test('验收条件里已经写了检索项：不重复加（拆卡继承的 acceptance 优先）', () => {
  const inherited = checklistFromAcceptance([{ id: 'a1', text: '已检索历史结论并贴回卡上' }])
  const next = withClarifyHistoryItem(inherited, 'clarify')
  assert.equal(next.length, 1)
  assert.equal(next[0].id, 'a1')
})

test('非澄清列不加：方案 / 开发 / 评审 / 测试 / 缺陷都不塞', () => {
  for (const status of ['design', 'dev_ready', 'dev', 'review', 'test', 'accept', 'done', '', undefined, 'bug']) {
    assert.deepEqual(withClarifyHistoryItem([], status), [], `status=${String(status)} 不该加`)
  }
})

test('清单满 30 条不加：sanitizeChecklist 的上限就是 30，加了也会被截掉', () => {
  const full = Array.from({ length: 30 }, (_, i) => ({ id: `c${i + 1}`, text: `第 ${i + 1} 项`, done: false, by: '', at: 0, note: '' }))
  assert.equal(withClarifyHistoryItem(full, 'clarify').length, 30)
  const room = Array.from({ length: 29 }, (_, i) => ({ id: `c${i + 1}`, text: `第 ${i + 1} 项`, done: false, by: '', at: 0, note: '' }))
  assert.equal(withClarifyHistoryItem(room, 'clarify').length, 30, '29 条时还能加第 30 条')
})

test('返回新数组、不改入参：调用方可能还拿着原清单', () => {
  const input = [{ id: 'c1', text: '原有的一项', done: false, by: '', at: 0, note: '' }]
  const snapshot = JSON.stringify(input)
  const next = withClarifyHistoryItem(input, 'clarify')
  assert.notEqual(next, input, '必须是新数组')
  assert.equal(JSON.stringify(input), snapshot, '入参不能被改')
  assert.equal(next.length, 2)
})

test('已经有 id=c-history（比如用户手工加的）：不再塞第二项', () => {
  const next = withClarifyHistoryItem([{ id: 'c-history', text: '历史检索', done: true, by: '', at: 0, note: '' }], 'clarify')
  assert.equal(next.length, 1)
})

test('不是数组（null / 字符串）：当成空清单，不抛', () => {
  assert.equal(withClarifyHistoryItem(null, 'clarify').length, 1)
  assert.equal(withClarifyHistoryItem(null, 'dev').length, 0)
  assert.equal(withClarifyHistoryItem('oops', 'clarify').length, 1)
})

test('两个建卡入口都真的接了这个纯函数（只有函数不接线 = 没做）', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(index, /import \{[^}]*withClarifyHistoryItem[^}]*\} from '\.\/src\/host\/acceptance\.js'/, 'index.js 要导入')
  assert.match(index, /const seeded = withClarifyHistoryItem\(/, 'createTask 的 seeded 要过这一层')
  const integrations = readFileSync(new URL('../src/host/integrations.js', import.meta.url), 'utf8')
  assert.match(integrations, /import \{ withClarifyHistoryItem \} from '\.\/acceptance\.js'/, 'integrations.js 要导入')
  assert.match(integrations, /const checklist = withClarifyHistoryItem\(/, 'GitLab 导入路径要过这一层')
  assert.doesNotMatch(integrations, /checklist: template\.map\(/, '别只改一处、漏掉 GitLab 导入那条路')
})
