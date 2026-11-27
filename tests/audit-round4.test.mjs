// 第四轮体检：/state 体积（历史）、署名、公开页深色。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { INTAKE_HTML, MINE_HTML, STATUS_HTML } from '../src/host/intake-pages.js'

const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')

test('/state 只下发最近 12 条历史 + 总数；全文走 /task/parts', () => {
  const index = source('index.js')
  assert.match(index, /history: \(history \?\? \[\]\)\.slice\(-12\)/, '轮询只带最近 12 条')
  assert.match(index, /historyTotal:/, '总数单独给（否则抽屉显示 12 却写着 12）')
  const route = source('src/host/routes/tasks.js')
  assert.match(route, /history: task\.history \?\? \[\]/, '/task/parts 要给全文历史')
})

test('抽屉：历史按需加载全文，标题用总数', () => {
  const drawer = source('web/src/studio/drawer.js')
  assert.match(drawer, /const loadFullHistory = async/, '要有加载全部的动作')
  assert.match(drawer, /'data-history-load-all': ''/)
  assert.match(drawer, /`状态历史（\$\{total\}）`/)
})

test('「谁点的」一律署当前登录人，前端没有写死的 by: 人', () => {
  const files = [
    'client.src.js', 'web/src/studio/drawer.js', 'web/src/studio/pages/cases.js',
    'web/src/studio/pages/releases.js', 'web/src/studio/pages/insights.js',
    'web/src/studio/palette.js', 'web/src/studio/board.js',
  ]
  for (const file of files) {
    const text = source(file)
    const offenders = text.split(/\r?\n/)
      .map((line, index) => ({ line, no: index + 1 }))
      .filter(item => /by:\s*'人'/.test(item.line) && !item.line.includes('currentUser'))
    assert.deepEqual(offenders.map(item => file + ':' + item.no), [], '这些地方还在写死 by: 人')
  }
})

test('公开提单/查询页支持深色（prefers-color-scheme），不再硬编码白底', () => {
  for (const [name, html] of [['INTAKE_HTML', INTAKE_HTML], ['STATUS_HTML', STATUS_HTML], ['MINE_HTML', MINE_HTML]]) {
    assert.ok(html.includes('prefers-color-scheme:dark'), name + ' 要有深色媒体查询')
    assert.ok(!/background:#fff/.test(html), name + ' 不该再硬编码白底')
    assert.ok(html.includes('color-scheme:light dark'), name + ' 要声明 color-scheme（表单控件跟着系统走）')
    assert.ok(!html.includes('${PAGE_STYLE}'), name + ' 模板串要真的插值')
  }
})
