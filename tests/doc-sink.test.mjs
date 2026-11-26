// DocSink 纯逻辑：出口解析、项目覆盖、主从关系、非法值回落。
import assert from 'node:assert/strict'
import test from 'node:test'

import { docProviderFor, docSinksFor, publicDocsConfig, sanitizeDocsConfig } from '../src/host/doc-sink.js'

test('配置：默认 feishu；垃圾值回落；未知项目不写进表', () => {
  assert.equal(sanitizeDocsConfig({}).provider, 'feishu')
  assert.equal(sanitizeDocsConfig({ provider: 'nonsense' }).provider, 'feishu')
  const cfg = sanitizeDocsConfig({ provider: 'both', perProject: { p1: 'weknora', p2: 'oops', '': 'feishu' } })
  assert.equal(cfg.provider, 'both')
  assert.deepEqual(cfg.perProject, { p1: 'weknora' }, '未知值不该留下半配置')
})

test('WeKnora 连接形状：字段截断、空串保留', () => {
  const sink = sanitizeDocsConfig({ weknora: { baseUrl: ' http://h:8080 ', apiKey: 'k', tenantId: '10000', knowledgeBaseId: 'kb' } }).weknora
  assert.deepEqual(sink, { baseUrl: 'http://h:8080', apiKey: 'k', tenantId: '10000', knowledgeBaseId: 'kb' })
  assert.deepEqual(sanitizeDocsConfig({}).weknora, { baseUrl: '', apiKey: '', tenantId: '', knowledgeBaseId: '' })
})

test('对外配置不泄露 apiKey：只给 apiKeySet', () => {
  const raw = sanitizeDocsConfig({ weknora: { baseUrl: 'http://h', apiKey: 'sk-secret', tenantId: '1', knowledgeBaseId: 'kb' } })
  const pub = publicDocsConfig(raw)
  assert.equal(pub.weknora.apiKey, '')
  assert.equal(pub.weknora.apiKeySet, true)
  assert.equal(pub.weknora.baseUrl, 'http://h')
  assert.ok(!JSON.stringify(pub).includes('sk-secret'), 'apiKey 不能出现在对外配置里')
})

test('保存时 apiKey 留空 = 保持原值；输入新值才覆盖', () => {
  const base = sanitizeDocsConfig({ weknora: { baseUrl: 'http://h', apiKey: 'sk-old', tenantId: '1', knowledgeBaseId: 'kb' } })
  const kept = sanitizeDocsConfig({ weknora: { baseUrl: 'http://h2', apiKey: '', tenantId: '1', knowledgeBaseId: 'kb' } }, base)
  assert.equal(kept.weknora.apiKey, 'sk-old', '面板回显是空的，保存不能把 key 冲掉')
  assert.equal(kept.weknora.baseUrl, 'http://h2')
  const changed = sanitizeDocsConfig({ weknora: { baseUrl: 'http://h2', apiKey: 'sk-new', tenantId: '1', knowledgeBaseId: 'kb' } }, base)
  assert.equal(changed.weknora.apiKey, 'sk-new')
})

test('优先级：需求级 > 项目级 > 全局', () => {
  const config = { docs: sanitizeDocsConfig({ provider: 'feishu', perProject: { p1: 'weknora' } }) }
  assert.equal(docProviderFor(config, { project: 'p1' }), 'weknora', '项目覆盖全局')
  assert.equal(docProviderFor(config, { project: 'p2' }), 'feishu', '没配的项目用全局')
  assert.equal(docProviderFor(config, { project: 'p1', docsProvider: 'both' }), 'both', '需求级最高')
  assert.equal(docProviderFor({}, { docsProvider: 'weknora' }), 'weknora')
})

test('出口值归一：大小写/空白按小写识别，只有字符串能当出口', () => {
  assert.equal(sanitizeDocsConfig({ provider: 'BOTH' }).provider, 'both', '大小写不该回落')
  assert.equal(sanitizeDocsConfig({ provider: ' WEKNORA ' }).provider, 'weknora', '首尾空白要归一')
  assert.equal(sanitizeDocsConfig({ provider: 'Feishu' }).provider, 'feishu')
})

test('非法出口一律回落 feishu：数组 / boxed / 带 toString 的对象不许冒充', () => {
  // 这些在 String() 隐式字符串化下会变成合法出口，a3 要求它们回落 feishu。
  assert.equal(sanitizeDocsConfig({ provider: ['weknora'] }).provider, 'feishu', '单元素数组不是出口')
  assert.equal(sanitizeDocsConfig({ provider: ['both'] }).provider, 'feishu')
  assert.equal(sanitizeDocsConfig({ provider: new String('both') }).provider, 'feishu', 'boxed string 不是出口')
  assert.equal(sanitizeDocsConfig({ provider: { toString: () => 'weknora' } }).provider, 'feishu', 'toString 不算出口')
  assert.equal(sanitizeDocsConfig({ provider: {} }).provider, 'feishu')
  assert.equal(sanitizeDocsConfig({ provider: 0 }).provider, 'feishu')
  assert.equal(sanitizeDocsConfig({ provider: null }).provider, 'feishu')
  assert.equal(sanitizeDocsConfig({ provider: '' }).provider, 'feishu', '空串回落')
})

test('perProject：非法项不落库，合法项归一后保留', () => {
  const cfg = sanitizeDocsConfig({
    perProject: { p1: ['weknora'], p2: 'BOTH', '': 'feishu', p3: 'nope', '  p4  ': 'feishu', p5: {} },
  })
  assert.deepEqual(cfg.perProject, { p2: 'both', p4: 'feishu' }, '只留合法项，且键与值都归一——不留半配置')
  assert.deepEqual(sanitizeDocsConfig({ perProject: [] }).perProject, {}, '数组不是映射表')
})

test('优先级：需求级 > 项目级 > 全局 > 缺省；非法一级落下一级而不是直接落缺省', () => {
  const config = { docs: sanitizeDocsConfig({ provider: 'both', perProject: { pj: 'weknora' } }) }
  assert.equal(docProviderFor(config, { project: 'pj' }), 'weknora', '项目覆盖全局')
  assert.equal(docProviderFor(config, { project: 'pz' }), 'both', '没配的项目用全局')
  assert.equal(docProviderFor(config, { project: 'pj', docsProvider: 'feishu' }), 'feishu', '需求级最高')
  // 需求级非法时要落到项目级（而不是跳过它直接落全局）——这正是 pickProvider 收紧后才有保证的行为。
  assert.equal(docProviderFor(config, { project: 'pj', docsProvider: 'zzz' }), 'weknora', '需求级非法 → 项目级')
  assert.equal(docProviderFor(config, { project: 'pj', docsProvider: ['feishu'] }), 'weknora', '需求级数组非法 → 项目级')
  assert.equal(docProviderFor(config, { project: 'pz', docsProvider: 'zzz' }), 'both', '需求级非法 → 全局')
  assert.equal(docProviderFor({}, {}), 'feishu', '什么都没有时缺省 feishu')
  assert.equal(docProviderFor({ docs: sanitizeDocsConfig({ provider: ['both'] }) }, {}), 'feishu', '全局非法 → 缺省')
})

test('both：两个出口，飞书为主（主从不许反转）', () => {
  const plan = docSinksFor({ docs: sanitizeDocsConfig({ provider: 'both' }) }, {})
  assert.deepEqual(plan.sinks, ['feishu', 'weknora'])
  assert.equal(plan.primary, 'feishu')
  const only = docSinksFor({ docs: sanitizeDocsConfig({ provider: 'weknora' }) }, {})
  assert.deepEqual(only.sinks, ['weknora'])
  assert.equal(only.primary, 'weknora')
  const feishuOnly = docSinksFor({ docs: sanitizeDocsConfig({ provider: 'feishu' }) }, {})
  assert.deepEqual(feishuOnly.sinks, ['feishu'], '三种取值各解析出一条分发路径')
  assert.equal(feishuOnly.primary, 'feishu')
})

test('非法出口不许被当成分发目标：回落 feishu，只有一个出口', () => {
  const plan = docSinksFor({ docs: sanitizeDocsConfig({ provider: ['weknora'] }) }, {})
  assert.equal(plan.provider, 'feishu')
  assert.deepEqual(plan.sinks, ['feishu'], '非法值绝不能变成「往知识库写」')
  assert.equal(plan.primary, 'feishu')
})
