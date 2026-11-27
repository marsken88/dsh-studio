// 长任务不再占住请求线程：/task/quality 默认「提交即返回」，wait:true 保留同步语义。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')

test('/task/quality：默认异步（202），wait:true 才同步等结果', () => {
  const route = source('src/host/routes/coding.js')
  assert.match(route, /if \(body\.wait !== true\) \{/, '要有异步分支')
  assert.match(route, /host\.sendJson\(res, 202, \{ ok: true, queued: true/, '提交即返回 202 + queued')
  assert.match(route, /void runTaskQuality\(store, id, \{ by \}\)\.catch\(/, '后台跑，失败要留痕不能静默')
  assert.match(route, /const result = await runTaskQuality\(store, id, \{ by \}\)/, 'wait:true 仍能同步拿结果')
})

test('/task/quality：后台失败写审计（靠注入的 recordAudit，不是裸引用）', () => {
  const route = source('src/host/routes/coding.js')
  const index = source('index.js')
  assert.match(route, /host\.recordAudit\?\.\(store, \{ by, route: '\/task\/quality'/)
  assert.match(route, /"recordAudit"/, 'INJECTED 列表要登记')
  assert.match(index, /removeWorktree, recordAudit, sendJson/, 'index.js 要真的注入进去')
})

test('抽屉：点「跑一次」看到 queued 就说清已提交，不等结果', () => {
  const drawer = source('web/src/studio/drawer.js')
  assert.match(drawer, /if \(result\.queued === true\) \{/, '要识别 queued')
  assert.match(drawer, /已提交后台执行/, '要给出可读提示')
})

test('e2e 自检：项目检查那三步仍按同步语义断言（要等结果才能判门禁）', () => {
  const loop = source('tools/e2e-loop.mjs')
  const waits = (loop.match(/wait: true/g) ?? []).length
  assert.equal(waits, 3, '三处 /task/quality 调用都要 wait:true')
})
