// 第三轮体检的守卫：治理面板的数据源、/state 不存在的字段、脚本专用路由要有文档。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')

test('治理面板的派单锁/日志从 GET /agents 拉，不再读不存在的 state.agents', () => {
  const panel = source('web/src/studio/panels/governance.js')
  assert.ok(!/state\.agents\s*\?\?/.test(panel), 'state 里没有 agents，读了永远是空')
  assert.match(panel, /api\('\/agents'\)/, '要真的去拉 /agents')
  assert.match(panel, /'data-agent-log-refresh': ''/, '要有手动刷新入口（日志是运行态，不是每次 /state 都带）')
})

test('/state 里没有 locked：不要留下永远不会触发的分支', () => {
  const client = source('client.src.js')
  assert.ok(!/state\.locked === true/.test(client), 'state.locked 恒为 undefined，这个分支永远不成立')
  assert.ok(!/state\.locked !== true/.test(client))
  assert.match(client, /\/state 从来没有 locked 字段/, '留一句说明，别让下一个人加回来')
})

test('脚本专用路由写进了手册 §8.1（含 /task/verify-coding、/suite/list、/workspace/*）', () => {
  const manual = source('docs/manual.md')
  for (const route of ['/task/verify-coding', '/suite/list', '/workspace/list', '/workspace/delete']) {
    assert.ok(manual.includes(route), route + ' 要在 §8.1 里')
  }
  assert.match(manual, /面板的套件区读的是 `\/cases`/, '数据源要写对（/cases 而不是 /state）')
})

test('前端调用的每个 /xxx 在后端都有对应路由（改名/删路由会在这里红）', () => {
  const routeFiles = ['src/host/routes/agents.js', 'src/host/routes/admin.js', 'src/host/routes/coding.js', 'src/host/routes/connect.js', 'src/host/routes/exports.js', 'src/host/routes/insights.js', 'src/host/routes/releases.js', 'src/host/routes/requirements.js', 'src/host/routes/skills.js', 'src/host/routes/state.js', 'src/host/routes/tasks.js', 'src/host/routes/auth.js', 'index.js']
  const backend = routeFiles.map(source).join('\n')
  const routes = new Set([...backend.matchAll(/route === '(\/[a-zA-Z0-9/_.-]+)'/g)].map(m => m[1]))
  const front = [
    source('client.src.js'),
    ...[
      'board.js', 'card.js', 'drawer.js', 'palette.js', 'run-tray.js', 'docs-readback.js',
    ].map(name => source('web/src/studio/' + name)),
  ].join('\n')
  const calls = new Set([...front.matchAll(/api\('(\/[a-zA-Z0-9/_.-]+)'/g)].map(m => m[1]))
  const dead = [...calls].filter(route => !routes.has(route))
  assert.deepEqual(dead, [], '这些调用后端没有路由：' + dead.join(', '))
})
