import test from 'node:test'
import assert from 'node:assert/strict'

import { buildRequirementContext, requirementAssistPrompt } from '../src/host/requirement-assist.js'

const STATE = {
  config: {
    projects: [{
      id: 'p1', name: '示例管理后台', description: '公司内部运营后台',
      services: [{ name: 'admin-api' }, { name: 'admin-web' }],
      iterations: [{ name: '11-16' }],
    }],
  },
  requirements: [{
    id: 'r1', code: 'REQ-2026-007', title: '管理后台登录功能', status: 'delivered', project: 'p1', updatedAt: 2,
    description: '同一账号连续 5 次失败锁定 15 分钟',
    docs: [{ kind: 'prd', title: '登录锁定 PRD', content: '锁定期内正确密码也返回 423' }],
  }],
  tasks: [{ id: 't1', code: 'BUG-042', title: '锁定实现与需求不符', status: 'test', type: 'bug', project: 'p1', updatedAt: 3 }],
}

test('项目沉淀上下文：项目/已有需求/PRD/卡都能进上下文', () => {
  const context = buildRequirementContext(STATE, 'p1')
  assert.match(context, /示例管理后台/)
  assert.match(context, /admin-api/)
  assert.match(context, /REQ-2026-007 管理后台登录功能/)
  assert.match(context, /登录锁定 PRD/)
  assert.match(context, /BUG-042 锁定实现与需求不符/) 
})

test('项目沉淀上下文：未指定项目时明确说不编造', () => {
  const context = buildRequirementContext(STATE, '')
  assert.match(context, /未指定/)
  assert.match(context, /不要编造/)
})

test('chat 提示词：带上下文与对话，只问问题不出 PRD', () => {
  const prompt = requirementAssistPrompt({ mode: 'chat', context: '项目：示例', messages: [{ role: 'user', content: '想加登录锁定' }] })
  assert.match(prompt, /项目：示例/)
  assert.match(prompt, /用户：想加登录锁定/)
  assert.match(prompt, /只问接下来最关键的 1-3 个问题/)
})

test('draft 提示词：要求完整 PRD 分段且只输出正文', () => {
  const prompt = requirementAssistPrompt({ mode: 'draft', context: '项目：示例', messages: [{ role: 'user', content: '修 BUG-042' }] })
  assert.match(prompt, /背景 \/ 目标 \/ 用户与场景/)
  assert.match(prompt, /只输出这份 Markdown 正文/)
})
