// 效能页口径 + 无 UI 配置项补入口。
// 纯函数直接驱动；面板接线用源码守卫（真渲染由 verify:pages / probe:panel 兜）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { buildQuality } from '../src/host/quality.js'
import { recordRun, runSummary } from '../src/host/dispatcher.js'
import { workloadOf } from '../src/host/workload.js'

const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')

const task = extra => ({
  id: 't-' + Math.random().toString(36).slice(2, 8),
  code: 'DEV-001', title: '卡', status: 'done', expert: 'dev', project: 'pj-a',
  checklist: [], artifacts: [], cases: [], history: [], comments: [], blocked: null,
  ...extra,
})

test('buildQuality：按项目筛选只算那个项目的卡，并回报 scope', () => {
  const tasks = [
    task({ id: 'a1', project: 'pj-a', status: 'done' }),
    task({ id: 'a2', project: 'pj-a', status: 'dev' }),
    task({ id: 'b1', project: 'pj-b', status: 'done' }),
  ]
  const state = { tasks, config: { experts: [{ id: 'dev', name: '开发工程师', role: 'dev' }] } }
  const all = buildQuality(state, { byExpert: [] })
  assert.equal(all.scope.project, '')
  assert.equal(all.scope.cards, 3, '不筛项目时是全部卡')

  const one = buildQuality(state, { byExpert: [] }, { project: 'pj-a' })
  assert.equal(one.scope.project, 'pj-a')
  assert.equal(one.scope.cards, 2, '筛了项目只剩 pj-a 的两张')
  assert.equal(one.totals.cards, 2)
  assert.equal(one.experts.reduce((sum, row) => sum + row.cards, 0), 2)
})

test('runSummary：按 taskIds 筛派单日志（效能页项目筛选要用）', () => {
  const key = 'ux-batch-' + Date.now().toString(36)
  recordRun({ sessionId: key + '-1', taskId: key + '-t1', expert: 'dev', model: 'm1', at: Date.now(), ms: 100 })
  recordRun({ sessionId: key + '-2', taskId: key + '-t2', expert: 'qa', model: 'm2', at: Date.now(), ms: 200 })
  const all = runSummary()
  assert.ok(all.total >= 2)
  const only = runSummary({ taskIds: new Set([key + '-t1']) })
  assert.equal(only.total, 1, '只算这个项目下的那一次派单')
  assert.equal(only.byExpert.length, 1)
  assert.equal(only.byExpert[0].key, 'dev')
})

test('workloadOf：按项目筛选，running 仍按专家统计', () => {
  const state = {
    tasks: [
      task({ id: 'a1', project: 'pj-a', status: 'dev', dispatch: { expert: 'dev' } }),
      task({ id: 'b1', project: 'pj-b', status: 'dev', dispatch: { expert: 'dev' } }),
      task({ id: 'b2', project: 'pj-b', status: 'dev', dispatch: { expert: 'qa' } }),
    ],
    config: { experts: [{ id: 'dev', name: '开发工程师' }, { id: 'qa', name: '测试工程师' }] },
  }
  const all = workloadOf(state, [], {}, {})
  assert.equal(all.experts.find(row => row.id === 'dev').open, 2)
  const scoped = workloadOf(state, [{ expert: 'dev' }], {}, { project: 'pj-a' })
  assert.equal(scoped.experts.find(row => row.id === 'dev').open, 1, '只算 pj-a 的')
  assert.equal(scoped.experts.find(row => row.id === 'qa').open, 0)
  assert.equal(scoped.scope.project, 'pj-a')
  assert.equal(scoped.busy, 1, 'running 是派单器的实时状态，项目筛选不影响它')
})

test('效能页：四个次接口分开收（一个挂了不拖空其它）、上下文错误与空态分开、项目筛选说明口径', () => {
  const page = source('web/src/studio/pages/analytics.js')
  assert.ok(!/Promise\.all\(\[api\('\/workload'\)/.test(page), '不再用 Promise.all 一把抓')
  assert.match(page, /const settle = \(path, apply\) => api\(path\)/, '每块各取各的')
  assert.match(page, /const withProject = path =>/, '四个次接口都要带项目参数')
  assert.match(page, /data-contexts-error/, '读不到会话日志要单独说，不能冒充「没有数据」')
  assert.match(page, /data-analytics-scope/, '筛了项目要说明对所有分区生效')
})

test('飞书面板：多维表格有 baseToken / tableId 与「演练 / 镜像」入口', () => {
  const panel = source('web/src/studio/panels/integrations.js')
  assert.match(panel, /data-section': 'bitable'/, '要有独立分节')
  assert.match(panel, /setBaseToken/, 'baseToken 要能填')
  assert.match(panel, /setTableId/, 'tableId 要能填')
  assert.match(panel, /api\('\/feishu\/mirror', \{ dryRun: dryRun === true \}\)/, '要能触发镜像（含演练）')
  assert.match(panel, /if \(dryRun !== true\) await onChanged\(\)/, '真写后刷新')
})

test('自动派单：重试三件套有输入并能落库（秒 → 毫秒）', () => {
  const pane = source('web/src/studio/panels/settings-panes.js')
  const client = source('client.src.js')
  assert.match(pane, /numberField\('agentsRetryMax'/, '要有重试次数')
  assert.match(pane, /numberField\('agentsRetryBase'/, '要有首次冷却')
  assert.match(pane, /numberField\('agentsRetryFactor'/, '要有倍率')
  assert.match(client, /agentsRetryBase: String\(Math\.round\(/, '表单从 config 回填（毫秒转秒）')
  assert.match(client, /baseMs: Math\.round\(Number\(form\.agentsRetryBase\) \* 1000\)/, '保存时秒转毫秒')
  assert.match(client, /retry: \{/, '随 agents 一起提交')
})

test('列的负责人：缺陷 SLA 与默认验收模板有入口', () => {
  const panel = source('web/src/studio/panels/governance.js')
  assert.match(panel, /data-section': 'sla-templates'/)
  assert.match(panel, /const saveSla = async/, '要能保存 SLA')
  assert.match(panel, /api\('\/config', \{ sla: patch \}\)/)
  assert.match(panel, /const saveTemplates = async/, '要能保存默认验收清单')
  assert.match(panel, /templates: \{ \.\.\.\(config\.templates \?\? \{\}\), dev: items \}/)
})

test('测试执行：shell 用例的默认工作目录有入口', () => {
  const panel = source('web/src/studio/panels/people.js')
  assert.match(panel, /const \[shellCwdDraft, setShellCwdDraft\]/)
  assert.match(panel, /shellCwd: shellCwdDraft/, '保存时带上 shellCwd')
})
