import test from 'node:test'
import assert from 'node:assert/strict'

import { buildRequirementContext, clipUserText, feishuLinks, isSheetLink, requirementAssistPrompt } from '../src/host/requirement-assist.js'

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
    points: [{ id: 'p1', title: '连续失败锁定' }, { id: 'p2', title: '锁定期内正确密码也不放行' }],
    docs: [{ kind: 'prd', title: '登录锁定 PRD', content: '锁定期内正确密码也返回 423' }],
  }],
  tasks: [{ id: 't1', code: 'BUG-042', title: '锁定实现与需求不符', status: 'test', type: 'bug', project: 'p1', updatedAt: 3 }],
}

test('项目沉淀上下文：项目/已有需求/功能点/PRD/卡都能进上下文', () => {
  const context = buildRequirementContext(STATE, 'p1')
  assert.match(context, /示例管理后台/)
  assert.match(context, /admin-api/)
  assert.match(context, /REQ-2026-007 管理后台登录功能/)
  assert.match(context, /功能点：连续失败锁定/)
  assert.match(context, /登录锁定 PRD/)
  assert.match(context, /BUG-042 锁定实现与需求不符/)
})

test('项目沉淀上下文：未指定项目时明确说不编造', () => {
  const context = buildRequirementContext(STATE, '')
  assert.match(context, /未指定/)
  assert.match(context, /不要编造/)
})

test('项目沉淀上下文：PRD 不再只截 260 字，后面的结论也看得到', () => {
  const long = '开头' + '铺'.repeat(600) + '关键结论在很后面'
  const state = { ...STATE, requirements: [{ ...STATE.requirements[0], docs: [{ kind: 'prd', title: '长 PRD', content: long }] }] }
  const context = buildRequirementContext(state, 'p1')
  assert.match(context, /关键结论在很后面/)
})

test('chat 提示词：首轮查重 + 3-5 条待确认，不再每轮必问三个', () => {
  const prompt = requirementAssistPrompt({ mode: 'chat', context: '项目：示例', messages: [{ role: 'user', content: '想加登录锁定' }] })
  assert.match(prompt, /项目：示例/)
  assert.match(prompt, /用户：想加登录锁定/)
  assert.match(prompt, /这是第一轮/)
  assert.match(prompt, /查重/)
  assert.match(prompt, /3-5 条「待确认」/)
  assert.doesNotMatch(prompt, /只问接下来最关键的 1-3 个问题/)
})

test('chat 提示词：后续轮先写已确认，只补问没答的，够了就停', () => {
  const prompt = requirementAssistPrompt({
    mode: 'chat',
    context: '项目：示例',
    messages: [
      { role: 'user', content: '想加登录锁定' },
      { role: 'assistant', content: '不重复也不冲突：……' },
      { role: 'user', content: '同一账号 5 次失败锁 15 分钟' },
    ],
  })
  assert.match(prompt, /这是第 2 轮/)
  assert.match(prompt, /「已确认：」/)
  assert.match(prompt, /最多 2 条/)
  assert.match(prompt, /已经答过的不许再问/)
  assert.match(prompt, /信息够了，可以整理 PRD 草稿了/)
})

test('用户消息保留 URL 与连字符（否则模型看不到真实的目录名/字段名）', () => {
  const url = 'https://laiyifen.feishu.cn/sheets/WgMjsX9kOhUu4otlEricXfPsnee'
  const prompt = requirementAssistPrompt({
    mode: 'chat', context: '',
    messages: [{ role: 'user', content: `看这个 ${url} 和 venus-settlement-core-server 的字典取值` }],
  })
  assert.ok(prompt.includes(url), 'URL 不能被截断或改字')
  assert.ok(prompt.includes('venus-settlement-core-server'), '连字符要保留')
  assert.equal(clipUserText('a-b_c/d.e', 100), 'a-b_c/d.e')
})

test('飞书链接识别：只认飞书域名，表格单独标注', () => {
  const text = '见 https://x.feishu.cn/docx/AbC123，以及 https://example.com/a 和 https://x.feishu.cn/sheets/S1。'
  assert.deepEqual(feishuLinks(text), ['https://x.feishu.cn/docx/AbC123', 'https://x.feishu.cn/sheets/S1'])
  assert.equal(isSheetLink('https://x.feishu.cn/sheets/S1'), true)
  assert.equal(isSheetLink('https://x.feishu.cn/docx/AbC123'), false)
})

test('chat 提示词带附件：读不到的材料要注明，别让模型假装读过', () => {
  const prompt = requirementAssistPrompt({
    mode: 'chat', context: '',
    messages: [{ role: 'user', content: '看附件' }],
    attachments: ['- https://x.feishu.cn/sheets/S1：飞书表格暂不支持自动读取正文，请把关键字段 / 行贴进对话'],
  })
  assert.match(prompt, /平台已读取/)
  assert.match(prompt, /飞书表格暂不支持自动读取正文/)
})

test('draft 提示词：要求完整 PRD 分段且只输出正文', () => {
  const prompt = requirementAssistPrompt({ mode: 'draft', context: '项目：示例', messages: [{ role: 'user', content: '修 BUG-042' }] })
  assert.match(prompt, /背景 \/ 目标 \/ 用户与场景/)
  assert.match(prompt, /只输出这份 Markdown 正文/)
})
