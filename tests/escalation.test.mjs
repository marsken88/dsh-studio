// 派单会话的提权审批：口径清洗 / 生效判定 / DSH 结论 / 卡上说明 / 配置四处齐活。
// 为什么值得单独测：这是「无人值守的会话被审批挂死」那一类事故的唯一阀门，
// 判反了就是要么整轮卡住、要么把只读沙箱悄悄放成全写。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { approvalNote } from '../src/host/agent-feed.js'
import { defaultConfig, mergeConfig } from '../src/host/domain.js'
import { ESCALATION_MODES, effectiveSandbox, escalationFor, escalationOutcome, sanitizeEscalation } from '../src/host/escalation.js'

const read = name => readFileSync(name, 'utf8')

test('sanitizeEscalation：只认 allow / deny，认不出的落回默认', () => {
  assert.deepEqual(ESCALATION_MODES, ['allow', 'deny'])
  assert.equal(sanitizeEscalation('allow'), 'allow')
  assert.equal(sanitizeEscalation(' DENY '), 'deny', '大小写与空格不该决定安全口径')
  assert.equal(sanitizeEscalation('ask'), 'allow', 'DSH 的 ask 不是这里的口径，落回默认')
  assert.equal(sanitizeEscalation(undefined), 'allow')
  assert.equal(sanitizeEscalation(undefined, 'deny'), 'deny', 'fallback 要生效')
  assert.equal(sanitizeEscalation('bogus', 'bogus'), 'allow', 'fallback 也不认得时仍然给一个合法值')
})

test('escalationFor：专家沙箱优先，只读一律拒绝', () => {
  const base = { agents: { sandbox: 'workspace-write', escalation: 'allow' }, experts: [] }
  assert.equal(escalationFor(base, 'dev').mode, 'allow')
  assert.equal(escalationFor(base, 'dev').sandbox, 'workspace-write')

  const denied = { agents: { sandbox: 'workspace-write', escalation: 'deny' }, experts: [] }
  assert.equal(escalationFor(denied, 'dev').mode, 'deny')

  const expertWide = {
    agents: { sandbox: 'read-only', escalation: 'allow' },
    experts: [{ id: 'dev', sandbox: 'workspace-write' }],
  }
  assert.equal(escalationFor(expertWide, 'dev').mode, 'allow', '专家自己的档位优先于全局')
  assert.equal(escalationFor(expertWide, 'qa').mode, 'deny', '没覆盖的专家跟随全局')

  const readOnly = {
    agents: { sandbox: 'read-only', escalation: 'allow' },
    experts: [{ id: 'dev', sandbox: 'read-only' }],
  }
  const back = escalationFor(readOnly, 'dev')
  assert.equal(back.mode, 'deny', '只读沙箱 + 自动批准 = 只读被悄悄变成可写，必须拒绝')
  assert.equal(back.configured, 'allow', '拒绝要说清是「配置允许但被只读挡住」，不是配置写错了')
  assert.match(back.reason, /只读/)

  // 没有配置、没有专家列表也不能崩（老库启动期）
  assert.equal(escalationFor(undefined, 'dev').mode, 'allow')
  assert.equal(escalationFor({}, 'dev').sandbox, 'workspace-write', '兜底档位要和 dispatcher 一致')
})

test('effectiveSandbox：自动批准 = 会话直接完全权限；只读永远优先；自动拒绝才用沙箱边界', () => {
  assert.equal(effectiveSandbox({ globalSandbox: 'workspace-write', escalation: 'allow' }), 'danger-full-access', '自动批准不再逐次审批，直接给完全访问')
  assert.equal(effectiveSandbox({ globalSandbox: 'workspace-write', escalation: 'deny' }), 'workspace-write', '自动拒绝时沙箱就是边界')
  assert.equal(effectiveSandbox({ expertSandbox: 'read-only', globalSandbox: 'workspace-write', escalation: 'allow' }), 'read-only', '专家显式只读不许被放大成可写')
  assert.equal(effectiveSandbox({ expertSandbox: 'danger-full-access', escalation: 'deny' }), 'danger-full-access', '专家显式完全权限保持')
  assert.equal(effectiveSandbox({ globalSandbox: 'bogus', escalation: 'deny' }), 'workspace-write', '认不出的档位落安全默认')
  assert.equal(effectiveSandbox({}), 'danger-full-access', '默认 escalation=allow + 没配沙箱 → 完全权限')
})

test('escalationOutcome：allow → allowed-once，其余 → rejected', () => {
  assert.equal(escalationOutcome('allow'), 'allowed-once', 'DSH 的放行结论就是 allowed-once')
  assert.equal(escalationOutcome('deny'), 'rejected')
  assert.equal(escalationOutcome(undefined), 'allowed-once', '认不出的按默认口径')
})

test('approvalNote：批准与拒绝都写清口径、理由和去哪儿改', () => {
  const allowed = approvalNote({ toolName: 'write', reason: 'outside workspace' }, 'allow')
  assert.match(allowed, /write/)
  assert.match(allowed, /自动批准/)
  assert.match(allowed, /outside workspace/)
  assert.match(allowed, /设置 → 自动派单/)

  const rejected = approvalNote({ toolName: 'plugin_manager', reason: 'escalate sandbox' }, 'deny')
  assert.match(rejected, /自动拒绝/)
  assert.match(rejected, /plugin_manager|escalate sandbox/)
  assert.match(rejected, /设置 → 自动派单/)

  // 老调用方不传 mode 时保持拒绝口径（安全默认）
  assert.match(approvalNote({ toolName: 'x' }), /自动拒绝/)
})

test('config: agents.escalation 四处齐活，默认 allow', () => {
  assert.equal(defaultConfig().agents.escalation, 'allow', '默认要能开箱即用地自动批准')

  const kept = mergeConfig({ agents: { escalation: 'deny' } })
  assert.equal(kept.agents.escalation, 'deny', '存过的值重启后要还在（mergeSection 只认默认里有的键）')
  const filled = mergeConfig({ agents: { sandbox: 'workspace-write' } })
  assert.equal(filled.agents.escalation, 'allow', '老库没有这个键时要补成默认值')

  const index = read('index.js')
  assert.match(index, /config\.agents\.escalation = String\(a\.escalation\)/, 'applyConfig 要认这个 patch（否则 /config 返回 200 但什么都没改)')
  assert.match(index, /agents: config\.agents,/, 'publicConfig 要把 agents 整块下发')
  assert.match(index, /escalationFor\(store\.snapshot\(\)\.config, parsed\.expertId\)/, 'approval/request 必须按设置代答')
  assert.match(index, /return escalationOutcome\(decision\.mode\)/, '结论要走 escalationOutcome，不能写死 rejected')

  const client = read('client.src.js')
  assert.match(client, /agentsEscalation:/, '设置表单要读这个值')
  assert.match(client, /escalation: form\.agentsEscalation/, '保存时要带上它（漏了就是「点了保存没反应」）')

  const pane = read('web/src/studio/panels/settings-panes.js')
  assert.match(pane, /'agentsEscalation'/, '自动派单面板要能改（用户找不到就等于没做）')

  const dispatcher = read('src/host/dispatcher.js')
  assert.match(dispatcher, /setPolicy\?\.\(agent, 'ask'\)/, '审批策略要显式设成 ask，否则 never 的部署里请求根本到不了平台')
})
