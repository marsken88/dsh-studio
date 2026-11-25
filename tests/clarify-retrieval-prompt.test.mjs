// p3 回归：澄清 / 方案阶段的派单提示词必须要求「先查历史」，而且没命中也要留痕。
import assert from 'node:assert/strict'
import test from 'node:test'

import { buildExpertPrompt, configureDispatcher } from '../src/host/dispatcher.js'

configureDispatcher(new Proxy({}, { get: () => () => undefined }))

const expert = { id: 'e-1', name: '产品经理', emoji: '📋', role: 'product', skills: [] }
const base = { id: 't-1', code: 'REQ-001', title: '知识沉淀', comments: [], cases: [], project: '' }
const cfg = { experts: [expert], projects: [] }
const build = column => String(buildExpertPrompt({ ...base }, expert, column, cfg, undefined, '', undefined, {}, []))

test('澄清阶段：提示词要求先检索历史，并说明命中/未命中都要留痕', () => {
  const prompt = build({ id: 'clarify', label: '待澄清' })
  assert.match(prompt, /先查历史/)
  assert.match(prompt, /REQ 编号/)
  assert.match(prompt, /已检索，无命中/, '没命中也要留一句话，否则看不出查没查过')
  assert.match(prompt, /不要编造查过/, '没有检索工具时不许假装查过')
  assert.match(prompt, /weknora_search/, '工具名要写注册名，少一次调错')
  assert.match(prompt, /报错原文/, '工具报错不能被写成「无命中」')
})

test('方案阶段：同一条要求也生效', () => {
  const prompt = build({ id: 'design', label: '待方案' })
  assert.match(prompt, /先查历史/)
})

test('研发阶段不塞这段：研发该看的是执行记录要求', () => {
  const prompt = build({ id: 'dev', label: '开发中' })
  assert.doesNotMatch(prompt, /先查历史/)
  assert.match(prompt, /studio_task_coding/)
})

test('未知列（只有 label 没有 id）不受影响，不误伤', () => {
  const prompt = build({ label: '自定义列' })
  assert.doesNotMatch(prompt, /先查历史/)
})
