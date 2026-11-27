// 一批小 bug：集成健康重试读错字段、发布准入失败显示成成功色、单服务配不了检查命令、
// 设置页「已保存」与「未保存」同时出现。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')

test('集成健康：飞书重试读 results 数组（以前读单数 result，永远显示「没配置机器人」）', () => {
  const panel = source('web/src/studio/panels/governance.js')
  assert.match(panel, /const rows = Array\.isArray\(out\.results\) \? out\.results : \[\]/, '要读 results')
  assert.ok(!/out\.result\?\.error \?\? '没配置机器人'/.test(panel), '不能再用单数 result 兜「没配置机器人」')
  assert.match(panel, /还没有配置飞书机器人/, '一台都没配时要说清')
  assert.match(panel, /channel === 'webhook'/, 'webhook 要有自己的分支，不能落到「代码隔离」文案')
})

test('发布准入：保存失败用错误色，不当成功显示', () => {
  const panel = source('web/src/studio/panels/people.js')
  assert.match(panel, /setRulesNote\(\{ ok: false, text:/, '失败要记 ok:false')
  assert.match(panel, /rulesNote\.ok === true \? OK : ERR/, '颜色按 ok 走')
  assert.match(panel, /'data-release-rules-note': rulesNote\.ok === true \? 'ok' : 'error'/)
})

test('项目：只有一个服务时也能配服务级检查命令（依赖才需要「别的服务」）', () => {
  const panel = source('web/src/studio/panels/platform.js')
  assert.match(panel, /只有一个服务时不用配依赖/, '单服务要给出说明而不是整行消失')
  assert.match(panel, /'aria-label': `第 \$\{index \+ 1\} 个服务的检查命令`/, '检查命令输入框必须一直在')
  // 依赖列表仍然只在 others 非空时出现
  assert.match(panel, /others\.length === 0[\s\S]{0,80}只有一个服务时不用配依赖[\s\S]{0,200}\.\.\.others\.map/, '依赖 chips 仍按 others 渲染')
})

test('设置页：一改就清掉「已保存」，不出现两行矛盾状态', () => {
  const client = source('client.src.js')
  assert.match(client, /const markDirty = event => \{[\s\S]{0,400}setStatus\(null\)/, 'markDirty 要先清 status')
})
