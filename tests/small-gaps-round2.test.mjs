// 第二批小口子：署名、键盘可达、命令面板字段、并发输入框、WeKnora Key 撤销、KPI 可点、到期日校验。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { buildDocsConfig } from '../src/host/docs-config.js'

const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')

test('代码评审 / 项目检查 / 合并门禁 / 合并 都署当前登录人（不再写死「人」）', () => {
  const drawer = source('web/src/studio/drawer.js')
  for (const route of ['/task/coding', '/task/quality', '/task/merge-gate', '/task/merge']) {
    const line = drawer.split(/\r?\n/).find(text => text.includes(`api('${route}'`) && text.includes('by:')) ?? ''
    assert.ok(line.includes('currentUser()'), `${route} 的署名要取 currentUser()，实际：${line.trim()}`)
  }
  assert.ok(!/by: '人'/.test(drawer), '抽屉里不该再有写死的 by: 人')
})

test('看板卡片键盘可达（role/tabIndex/Enter·Space）', () => {
  const card = source('web/src/studio/card.js')
  assert.match(card, /role: 'button'/)
  assert.match(card, /tabIndex: 0/)
  assert.match(card, /event\.key !== 'Enter' && event\.key !== ' '/)
  assert.match(card, /'aria-label': `打开卡片/)
})

test('命令面板不再读不存在的字段：负责人是字符串，需求标题按 requirementId 回查', () => {
  const palette = source('web/src/studio/palette.js')
  assert.match(palette, /typeof task\.owner === 'string' \? task\.owner : \(task\.owner\?\.label \?\? ''\)/, '负责人两种形状都要认')
  assert.ok(!/task\.requirementTitle/.test(palette), '卡上没有 requirementTitle 字段')
  assert.match(palette, /requirementTitleOf\(task\.requirementId\)/)
})

test('整批跑用例的并发有界面（1–8，写回 config.testing.concurrency）', () => {
  const people = source('web/src/studio/panels/people.js')
  assert.match(people, /aria-label': '整批跑用例的并发'/)
  assert.match(people, /concurrency: value/)
  assert.match(people, /Math\.min\(8, Math\.max\(1,/)
})

test('WeKnora API Key 可以撤销：留空仍保留，clearApiKey=true 才清', () => {
  const base = {
    provider: 'both',
    perProject: {},
    weknora: { baseUrl: 'http://kb.example.com/api/v1', apiKey: 'real-key', tenantId: '1', knowledgeBaseId: 'kb-1' },
  }
  const kept = buildDocsConfig(base, { weknora: { baseUrl: 'http://kb.example.com/api/v1' } })
  assert.equal(kept.weknora.apiKey, 'real-key', '留空 = 不修改')

  assert.throws(() => buildDocsConfig(base, { weknora: { clearApiKey: true } }), /没配全/, '仍启用 WeKnora 时撤销要被拦住')

  const cleared = buildDocsConfig(base, { provider: 'feishu', weknora: { clearApiKey: true } })
  assert.equal(cleared.weknora.apiKey, '', '切回飞书后可以撤销')

  assert.throws(() => buildDocsConfig(base, { weknora: { clearApiKey: 'yes' } }), /not-boolean/)

  const panel = source('web/src/studio/panels/integrations.js')
  assert.match(panel, /'data-clear-weknora-key': ''/)
  assert.match(panel, /clearApiKey: true/)
})

test('工作台 KPI 卡可点（键盘也可）→ 去看板', () => {
  const page = source('web/src/studio/pages/insights.js')
  assert.match(page, /'data-kpi-link': label/)
  assert.match(page, /onClick: \(\) => onOpenBoard\(\)/)
  assert.match(page, /event\.key !== 'Enter' && event\.key !== ' '/)
})

test('期望完成填错不再静默变 0：当场红字', () => {
  const drawer = source('web/src/studio/drawer.js')
  assert.match(drawer, /'data-due-invalid': ''/)
  assert.match(drawer, /日期看不懂，请用 YYYY-MM-DD/)
  assert.match(drawer, /'aria-invalid': plan\.due\.trim\(\) !== ''/)
})
