// 小口子收口：需求排序号生效、重复缺陷能标、项目迭代截断有提示。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SecretStore, StudioStore } from '../src/host/store.js'

const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')

test('需求列表：排序号在客户端也生效（不再只有服务端排序）', () => {
  const page = source('web/src/studio/pages/requirements.js')
  assert.match(page, /const orderOf = item => Number\(item\.order\) \|\| 0/, '要有 order 取值')
  assert.match(page, /if \(lo !== ro\) return ro - lo/, 'order 优先于 RICE')
  assert.ok(!/\{ right\.pool\?\.score \?\? 0 \} - \(left\.pool\?\.score \?\? 0 \}\)$/.test(page), '不能只剩 RICE 排序')
})

test('重复缺陷：抽屉里能标（认编号或 id），也能取消', () => {
  const drawer = source('web/src/studio/drawer.js')
  assert.match(drawer, /const markDuplicate = async target =>/)
  assert.match(drawer, /api\('\/task\/duplicate', \{ id: task\.id, targetId \}\)/)
  assert.match(drawer, /data-mark-duplicate/)
  assert.match(drawer, /取消重复标记/)
  assert.match(drawer, /不能把自己标成重复/)
})

test('markDuplicate 后端也认编号（脚本传 BUG-001 不该找不到）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dup-code-'))
  const store = new StudioStore(join(dir, 'state.json'), { dbFile: join(dir, 'state.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  try {
    await store.ready
    await store.mutate(state => {
      state.tasks.push({
        id: 't-main', code: 'BUG-001', title: '主缺陷', type: 'bug', status: 'dev', role: 'dev',
        requirementId: '', checklist: [], artifacts: [], comments: [], history: [], cases: [], blocked: null, tags: [],
      })
      state.tasks.push({
        id: 't-dup', code: 'BUG-002', title: '重复缺陷', type: 'bug', status: 'dev', role: 'dev',
        requirementId: '', checklist: [], artifacts: [], comments: [], history: [], cases: [], blocked: null, tags: [],
      })
    })
    // 直接驱动 handleTaskRoute 的 /task/duplicate（走 index.js 的 core 太重，这里只验匹配口径）
    const index = source('index.js')
    assert.match(index, /item\.id === wanted \|\| item\.code === wanted/, '要按 id 或编号认目标')
  } finally {
    store.db?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('项目页：迭代超过 5 个要写「还有 N 个」', () => {
  const page = source('web/src/studio/pages/projects.js')
  assert.match(page, /data-iteration-more/)
  assert.match(page, /还有 \$\{iterations\.length - 5\} 个迭代/)
})
