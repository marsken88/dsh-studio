// 第五轮体检的结论固化：/state 与 /cases 不重复、公开页可手机打开、worktree GC 挂上 npm script。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { INTAKE_HTML, MINE_HTML, STATUS_HTML } from '../src/host/intake-pages.js'

const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')

test('/state 只发用例计数，用例正文只在 /cases（别再往轮询里塞正文）', () => {
  const index = source('index.js')
  assert.match(index, /const \{ comments, checklist, cases(, history)?, \.\.\.rest \} = task/, '用例数组必须先剥掉')
  assert.match(index, /\.\.\.publicCases\(task\)/, '只下发计数')
  const route = source('src/host/routes/tasks.js')
  assert.match(route, /cases: \(\s*|cases: decoratedCases/, '/cases 才给正文')
})

test('公开提单/查询页能直接在手机上打开：viewport + 不给 main 写死宽度', () => {
  for (const [name, html] of [['INTAKE_HTML', INTAKE_HTML], ['STATUS_HTML', STATUS_HTML], ['MINE_HTML', MINE_HTML]]) {
    const text = String(html)
    assert.ok(text.includes('name="viewport"'), name + ' 缺 viewport meta（手机上会按 980px 缩放）')
    const main = text.slice(text.indexOf('<main'))
    const style = (main.match(/<main([^>]*)>/) ?? [''])[1]
    assert.ok(!/(^|;|\s)width:\s*\d+px/.test(style), name + ' 的 main 写了固定宽度（应该在 max-width 里）')
  }
})

test('worktree GC 挂上了 npm script，且默认只体检', () => {
  const pkg = JSON.parse(source('package.json'))
  assert.equal(pkg.scripts['worktree:gc'], 'node tools/worktree-gc.mjs')
  const cli = source('tools/worktree-gc.mjs')
  assert.match(cli, /const apply = flag\('apply'\)/, '默认不删，--apply 才真删')
  assert.match(cli, /unlinkSync\(target\)/, 'Windows 上删前要先摘 node_modules 联接')
  assert.match(cli, /git', \['worktree', 'list', '--porcelain'\]/, '判据来自 git worktree list')
})
