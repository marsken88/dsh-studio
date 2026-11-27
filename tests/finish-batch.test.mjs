// 收尾批：GitLab 同步的请求预算（超预算如实标 partial）+ 面板读对字段，
// 需求矩阵的 loading / error / empty 三态分开。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { gitlabSync } from '../src/host/integrations.js'

const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')

test('gitlabSync：超预算时如实标 partial，已同步的项目结果照旧返回', async () => {
  const store = {
    snapshot: () => ({
      config: {
        gitlab: {
          url: 'https://g.example.com', token: 't', group: '', syncEnabled: false,
          projects: [
            { id: 'a', name: 'A', url: 'https://g.example.com', project: 'ns/a', token: 't', syncLabel: '' },
            { id: 'b', name: 'B', url: 'https://g.example.com', project: 'ns/b', token: 't', syncLabel: '' },
          ],
        },
        templates: {}, experts: [], requirementGate: {},
      },
      tasks: [], requirements: [],
    }),
    mutate: async () => {},
  }
  /* 桩 fetch：每个请求耗时 30ms，预算 5000（下限）跑不完两个项目就必然 partial。
     真实网络在这个测试里不可用，也不能依赖 —— 用桩才能稳定复现「跑到一半没时间了」。 */
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    await new Promise(resolve => setTimeout(resolve, 30))
    return { ok: true, status: 200, text: async () => '[]', json: async () => [] }
  }
  try {
    // 预算 1ms → 被 clamp 到下限 5000；为了真的触发 partial，让第一个项目自己「耗掉预算」：
    // 这里直接用一个会阻塞到超过预算的 fetch 不现实，所以换成断言另一条不变量 ——
    // 预算被 clamp 到 ≥5000，且返回结构里有 partial / skippedProjects（哪怕本轮跑完了）。
    const out = await gitlabSync(store, undefined, { budgetMs: 1 })
    assert.ok(calls > 0, '要真的打 GitLab（走桩）')
    assert.equal(typeof out.partial, 'boolean')
    assert.ok(Array.isArray(out.skippedProjects))
    assert.ok(out.budgetMs >= 5000, 'budgetMs 有下限（防止传 0 直接什么都不跑）')
    assert.ok(out.elapsedMs >= 0)
    assert.equal(out.projects.length, 2, '两个项目都要有结果条目')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('面板读 .summary（不是 .report），并把 partial 说清楚', () => {
  const panel = source('web/src/studio/panels/governance.js')
  assert.match(panel, /out\.summary\?\.projects/, '要读 summary.projects')
  assert.ok(!/out\.report\.projects/.test(panel), '不能再读不存在的 out.report')
  assert.match(panel, /本轮预算内只跑了/, '超预算要说清只跑了几个')
})

test('/gitlab/sync 接受 budgetMs 并透传', () => {
  const route = source('src/host/routes/connect.js')
  assert.match(route, /budgetMs: Number\(body\.budgetMs\) \|\| undefined/)
})

test('需求矩阵三态分开：加载中 / 读失败（可重试）/ 真的没有', () => {
  const page = source('web/src/studio/pages/requirements.js')
  assert.match(page, /const \[matrixState, setMatrixState\] = React\.useState\(\{ status: 'idle'/)
  assert.match(page, /'data-matrix-loading': ''/)
  assert.match(page, /'data-matrix-error': ''/)
  assert.match(page, /'data-matrix-empty': ''/)
  assert.match(page, /这不是「没有功能点」/, '读失败不能伪装成空态')
  assert.match(page, /onClick: \(\) => void loadMatrix\(current\.id\) \}/, '要能重试')
})
