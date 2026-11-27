// 这一批的守卫：重复路由「留而不删」并写进手册；脚本专用入口不能只剩接口没文档。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')

test('只读的重复入口保留（删掉对脚本是破坏性变更），两个都还在', () => {
  assert.match(source('src/host/routes/requirements.js'), /route === '\/requirements'/, '/requirements 保留')
  assert.match(source('src/host/routes/connect.js'), /route === '\/integrations\/health'/, '/integrations/health 保留')
})

test('手册把它们列成「脚本专用」，并说明为什么不删', () => {
  const manual = source('docs/manual.md')
  assert.match(manual, /## §8\.1 只对脚本 \/ 工具开放的能力/)
  assert.match(manual, /\/requirements/)
  assert.match(manual, /\/integrations\/health/)
  assert.match(manual, /保留\*\*而不是删掉/, '要写清取舍，不让人再去删一遍')
  assert.ok(!/本轮删掉了两个/.test(manual), '不能还留着「已删除」的旧说法')
})
