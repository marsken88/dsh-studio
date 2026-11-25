// 进程重启时"崩溃的一轮"要计入 attempts，并留一条 task/abandoned 事件（CTO 评审）
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { abandonedRetry } from '../src/host/dispatch-state.js'

test('abandonedRetry：崩过的一轮要计入 attempts，到上限标记 exhausted', () => {
  assert.deepEqual(abandonedRetry(undefined), { attempts: 1, previous: 0, exhausted: false })
  assert.deepEqual(abandonedRetry({ attempts: 1 }), { attempts: 2, previous: 1, exhausted: false })
  assert.deepEqual(abandonedRetry({ attempts: 2 }, 3), { attempts: 3, previous: 2, exhausted: true })
  assert.equal(abandonedRetry({ attempts: 5 }, 3).exhausted, true, '已经超了也要判定为用尽')
  assert.equal(abandonedRetry({ attempts: 'x' }).attempts, 1, '脏数据不炸')
  assert.equal(abandonedRetry({ attempts: 0 }, 0).exhausted, false, '上限非法时退回默认 3')
})

test('dispatcher.reconcile 真的发 task/abandoned 并写进卡片历史', () => {
  const source = readFileSync(new URL('../src/host/dispatcher.js', import.meta.url), 'utf8')
  assert.match(source, /emitEvent\('task\/abandoned'/, '要发 task/abandoned 事件')
  assert.match(source, /abandonedRetry\((?:task\.)?dispatch\)/, 'attempts 要按 abandonedRetry 递增')
  assert.match(source, /abandoned：上次进程结束时这张卡还在跑/, '卡片历史里要留一条')
})
