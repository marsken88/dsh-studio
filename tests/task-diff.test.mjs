// 「研发改了哪些代码、架构怎么说」在看板上要看得见：
//   1. git diff 的解析（纯函数）：numstat / 统一 diff / status → 面板能画的形状；
//   2. 研发忘了登记执行记录时，平台从 worktree 补一条（不覆盖自报）；
//   3. 评审结论（工具这条路）必须补成评论进讨论区 —— 以前只有 HTTP 路由会补。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SecretStore, StudioStore } from '../src/host/store.js'
import { configureToolHost, registerTools } from '../src/host/tools.js'
import { publishNoteMentions } from '../src/host/mention-note.js'
import { parseMentions } from '../src/host/dispatcher.js'
import { configureCodingRoutes, handleCodingRoute } from '../src/host/routes/coding.js'
import {
  boundPatch, buildDiffView, collectCodingFromWorktree, diffSummaryLine, parseNameStatus, parseNumstat, parseStatusList, splitPatch,
} from '../src/host/task-diff.js'

const NUMSTAT = [
  '12\t3\tsrc/a.js',
  '0\t7\tsrc/gone.js',
  '5\t0\tsrc/new.js',
  '-\t-\tassets/logo.png',
  '',
].join('\n')

const PATCH = [
  'diff --git a/src/a.js b/src/a.js',
  'index 1111111..2222222 100644',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1,2 +1,3 @@',
  ' line',
  '-old',
  '+new',
  '+extra',
  'diff --git a/src/new.js b/src/new.js',
  '--- /dev/null',
  '+++ b/src/new.js',
  '@@ -0,0 +1,5 @@',
  '+a',
  '+b',
  '+c',
  '+d',
  '+e',
].join('\n')

test('parseNumstat：正常行 / 二进制 / 空行都认', () => {
  const rows = parseNumstat(NUMSTAT)
  assert.equal(rows.length, 4)
  assert.deepEqual(rows[0], { path: 'src/a.js', additions: 12, deletions: 3, binary: false })
  assert.deepEqual(rows[3], { path: 'assets/logo.png', additions: 0, deletions: 0, binary: true })
  assert.deepEqual(parseNumstat(''), [])
  assert.deepEqual(parseNumstat('garbage line'), [])
})

test('splitPatch：按文件切开，key 是 b/ 侧路径', () => {
  const chunks = splitPatch(PATCH)
  assert.equal(chunks.size, 2)
  assert.match(chunks.get('src/a.js'), /\+new/)
  assert.match(chunks.get('src/new.js'), /\+e/)
})

test('parseNameStatus：A/M/D/R 归一成面板的改动类型', () => {
  const rows = parseNameStatus('A\tnew.js\nM\tsrc/a.js\nD\tgone.js\nR100\told.js\trenamed.js\n')
  assert.deepEqual(rows, [
    { path: 'new.js', change: 'added' },
    { path: 'src/a.js', change: 'modified' },
    { path: 'gone.js', change: 'deleted' },
    { path: 'renamed.js', change: 'renamed' },
  ])
  assert.deepEqual(parseNameStatus(''), [])
})

test('buildDiffView：逐文件 patch + 总数 + 被省略的文件', () => {
  const view = buildDiffView({
    numstat: NUMSTAT,
    patch: PATCH,
    nameStatus: 'M\tsrc/a.js\nA\tsrc/new.js\nD\tsrc/gone.js\nM\tassets/logo.png\n',
    limits: { files: 2 },
  })
  assert.equal(view.files.length, 2, '只展开前两个文件')
  assert.equal(view.omitted, 2, '剩下的文件要如实计数')
  assert.deepEqual(view.totals, { files: 4, additions: 17, deletions: 10 })
  assert.equal(view.files[0].change, 'modified', '改动类型来自 git --name-status')
  assert.equal(view.files[0].patch.includes('+extra'), true)
  assert.equal(view.files[1].change, 'deleted')
  assert.equal(view.files[1].patch, '', 'numstat 里有、patch 里没有的文件不编造内容')
  assert.equal(view.truncated, true)
  assert.equal(diffSummaryLine(view), '4 个文件 +17 −10（已截断）')
  const full = buildDiffView({ numstat: NUMSTAT, patch: PATCH, nameStatus: 'M\tsrc/a.js\nA\tsrc/new.js\n', limits: { files: 4 } })
  assert.equal(full.omitted, 0)
  assert.equal(full.files.find(item => item.path === 'src/new.js').change, 'added')
  assert.equal(full.files.find(item => item.path === 'src/new.js').patch.includes('+e'), true)
})

test('buildDiffView：单文件 patch 太长会截断，但行数仍按 numstat 报', () => {
  const long = 'diff --git a/big.js b/big.js\n' + Array.from({ length: 500 }, (_, index) => `+line ${index}`).join('\n')
  const view = buildDiffView({ numstat: '500\t0\tbig.js', patch: long, limits: { perFileLines: 30 } })
  assert.equal(view.files[0].truncated, true)
  assert.equal(view.files[0].patch.split('\n').length <= 31, true, '行数要真的被截住')
  assert.equal(view.totals.additions, 500, '截断的是搬运量，不是统计数字')
})

test('boundPatch：空 patch 不炸', () => {
  assert.deepEqual(boundPatch(''), { patch: '', truncated: false })
})

test('parseStatusList：未提交 / 未跟踪 / 改名 / 删除', () => {
  const rows = parseStatusList(' M src/a.js\n?? docs/x.md\nR  old.js -> new.js\n D gone.js\n')
  assert.deepEqual(rows.map(row => row.state), ['modified', 'untracked', 'renamed', 'deleted'])
  assert.equal(rows[2].path, 'new.js')
})

test('collectCodingFromWorktree：研发没登记时从 git 补一条，并留评论', async () => {
  const writes = []
  const state = {
    tasks: [{ id: 't-1', status: 'review', coding: null, worktree: { path: '/repo/wt', base: 'main' }, history: [] }],
  }
  const store = {
    snapshot: () => state,
    mutate: fn => { fn(state); writes.push(1) },
  }
  const comments = []
  const git = async args => {
    if (args.includes('rev-parse') && args.includes('--abbrev-ref')) return { ok: true, stdout: 'task/DEV-001\n' }
    if (args.includes('rev-parse') && args.includes('--verify')) return { ok: true, stdout: '' }
    if (args.includes('log')) return { ok: true, stdout: 'abc123\tfeat: 做完了\ndef456\tfix: 修边界\n' }
    if (args.includes('--numstat')) return { ok: true, stdout: '5\t1\tsrc/a.js\n' }
    return { ok: false, stdout: '', stderr: 'unexpected' }
  }
  const out = await collectCodingFromWorktree(store, 't-1', { git, commentTask: async (s, id, body) => { comments.push(body) } })
  assert.deepEqual(out, { branch: 'task/DEV-001', base: 'main', commits: 2, files: 1 })
  const coding = state.tasks[0].coding
  assert.equal(coding.agent, 'git 自动采集（研发没登记执行记录）')
  assert.equal(coding.branch, 'task/DEV-001')
  assert.equal(coding.commits.length, 2)
  assert.equal(coding.files[0].path, 'src/a.js')
  assert.equal(coding.files[0].additions, 5)
  assert.match(comments[0], /平台从 git 自动采集/)
  assert.match(state.tasks[0].history.at(-1).note, /自动采集/)
})

test('collectCodingFromWorktree：研发自己登记过就不覆盖（只补空字段）', async () => {
  const state = {
    tasks: [{
      id: 't-1', status: 'review', history: [],
      coding: { agent: '开发工程师', branch: '', commits: [{ sha: 'beef', message: '自报提交', files: '' }], files: [] },
      worktree: { path: '/repo/wt', base: 'main' },
    }],
  }
  const store = { snapshot: () => state, mutate: fn => fn(state) }
  const out = await collectCodingFromWorktree(store, 't-1', {
    git: async args => {
      if (args.includes('--abbrev-ref')) return { ok: true, stdout: 'task/DEV-001' }
      if (args.includes('--verify')) return { ok: true }
      if (args.includes('log')) return { ok: true, stdout: 'abc123\t别人的提交\n' }
      if (args.includes('--numstat')) return { ok: true, stdout: '1\t1\tsrc/a.js\n' }
      return { ok: false }
    },
    commentTask: async () => {},
  })
  assert.equal(out.commits, 1)
  const coding = state.tasks[0].coding
  assert.equal(coding.agent, '开发工程师', 'agent 是研发自报的，不能被平台覆盖')
  assert.equal(coding.branch, 'task/DEV-001', '空字段要补')
  assert.equal(coding.commits[0].sha, 'beef', '自报提交保留')
  assert.equal(coding.files.length, 1, '空文件列表要补')
})

test('collectCodingFromWorktree：没有 worktree 或没有改动就不写记录', async () => {
  const noWorktree = { tasks: [{ id: 't-1', coding: null }], config: {} }
  assert.equal(await collectCodingFromWorktree({ snapshot: () => noWorktree, mutate: () => {} }, 't-1', { git: async () => ({ ok: true }) }), null)
  const noChange = { tasks: [{ id: 't-1', coding: null, worktree: { path: '/repo', base: 'main' } }] }
  const out = await collectCodingFromWorktree({ snapshot: () => noChange, mutate: () => {} }, 't-1', {
    git: async args => {
      if (args.includes('--abbrev-ref')) return { ok: true, stdout: 'task/x' }
      if (args.includes('--verify')) return { ok: true }
      return { ok: true, stdout: '' }
    },
  })
  assert.equal(out, null)
})

test('publishNoteMentions：forceComment 时通过结论（没有评审关键词）也进讨论区', async () => {
  const comments = []
  const out = await publishNoteMentions({
    store: { snapshot: () => ({ config: { experts: [], teams: [] } }) },
    commentTask: async (store, id, body, by) => { comments.push({ body, by }) },
    dispatcher: {},
    parseMentions,
  }, { taskId: 't-1', note: 'LGTM，可以进测试', by: '架构师', label: '代码评审', verdict: '通过', forceComment: true })
  assert.equal(out.commented, true)
  assert.equal(comments.length, 1)
  assert.match(comments[0].body, /代码评审 · 通过（架构师）/)
  assert.match(comments[0].body, /LGTM/)
})

test('publishNoteMentions：forceComment 且没写意见时，只留结论不留空评论', async () => {
  const comments = []
  await publishNoteMentions({
    store: { snapshot: () => ({ config: { experts: [], teams: [] } }) },
    commentTask: async (store, id, body) => { comments.push(body) },
    dispatcher: {},
    parseMentions,
  }, { taskId: 't-1', note: '   ', by: '架构师', label: '代码评审', verdict: '要求修改', forceComment: true })
  assert.equal(comments.length, 1)
  assert.match(comments[0], /要求修改/)
  assert.match(comments[0], /没有填写评审意见/)
})

test('studio_task_coding action=review：评审结论会自动补成卡上的评论（agent 走工具这条路）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-studio-review-comment-'))
  const store = new StudioStore(join(dir, 'state.json'), {
    dbFile: join(dir, 'state.db'),
    secrets: new SecretStore(join(dir, '.secrets.json')),
  })
  try {
    await store.ready
    const tools = []
    const ctx = { tools: { register: tool => { tools.push(tool); return () => {} } }, effect: () => () => {} }
    configureToolHost({
      toolOperator: () => '自检',
      toolLevel: () => 'write',
      checkToolAccess: () => ({ level: 'write', denial: null }),
      recordAudit: async () => {},
      getActiveDispatcher: () => undefined,
      getActiveSkills: () => undefined,
    })
    registerTools(ctx, store)
    await store.mutate(state => {
      state.tasks.push({
        id: 't-review-1', code: 'DEV-998', title: '（自检）评审结论进讨论', type: 'dev',
        status: 'review', role: 'architect', comments: [], history: [], checklist: [], cases: [], artifacts: [],
        coding: { agent: '开发工程师', branch: 'task/x', commits: [], files: [], review: { status: 'pending', by: '', at: 0, note: '' } },
        updatedAt: Date.now(),
      })
    })
    const tool = tools.find(item => item.name === 'studio_task_coding')
    assert.ok(tool !== undefined)
    const line = await tool.execute({
      id: 't-review-1', action: 'review', reviewStatus: 'approved',
      reviewNote: '实现没问题，可以进测试', by: '架构师',
    }, {})
    assert.match(String(line), /评审通过/)
    const card = store.snapshot().tasks.find(item => item.id === 't-review-1')
    assert.equal(card.coding.review.status, 'approved')
    const comment = card.comments.find(item => String(item.body).includes('代码评审'))
    assert.ok(comment !== undefined, '评审结论必须出现在讨论里（以前只在 coding.review.note）')
    assert.match(comment.body, /代码评审 · 通过（架构师）/)
    assert.match(comment.body, /实现没问题/)
  } finally {
    store.db?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

/* 路由级：/task/diff 真的去仓库读 git 事实（不是回显卡片上的自报）。
   这条用真 git 仓库跑 —— 纯函数测不出「目录/基线/分支」解析错。 */
const gitIn = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@local', ...args], { cwd, encoding: 'utf8' })

const makeRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-studio-diff-'))
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  assert.equal(gitIn(repo, 'init', '-b', 'main').status, 0)
  writeFileSync(join(repo, 'a.js'), 'line1\n')
  gitIn(repo, 'add', '.')
  assert.equal(gitIn(repo, 'commit', '-m', 'init').status, 0)
  assert.equal(gitIn(repo, 'checkout', '-b', 'feature').status, 0)
  writeFileSync(join(repo, 'a.js'), 'line1\nline2\n')
  writeFileSync(join(repo, 'b.js'), 'x\n')
  gitIn(repo, 'add', '.')
  assert.equal(gitIn(repo, 'commit', '-m', 'feat: 改两个文件').status, 0)
  return { dir, repo }
}

const makeDiffStore = async dir => {
  const store = new StudioStore(join(dir, 'state.json'), {
    dbFile: join(dir, 'state.db'),
    secrets: new SecretStore(join(dir, '.secrets.json')),
  })
  await store.ready
  await store.mutate(state => {
    state.tasks.push({
      id: 't-diff-1', code: 'DEV-997', title: '（自检）代码改动', type: 'dev', status: 'review', role: 'architect',
      comments: [], history: [], checklist: [], cases: [], artifacts: [], updatedAt: Date.now(),
    })
  })
  return store
}

test('POST /task/diff：从真实 git 仓库读分支相对基线的改动', async () => {
  const { dir, repo } = makeRepo()
  const store = await makeDiffStore(dir)
  try {
    let captured = null
    configureCodingRoutes({
      readJsonBody: async () => ({ id: 't-diff-1' }),
      sendJson: (res, status, payload) => { captured = { status, payload } },
      serviceOf: () => ({ repoPath: repo, baseBranch: 'main' }),
      workProjectOf: () => ({ repoPath: repo, baseBranch: 'main' }),
      publicState: () => ({}),
      getDispatcher: () => undefined,
    })
    const handled = await handleCodingRoute({
      method: 'POST', route: '/task/diff', req: {}, res: {}, store,
      url: new URL('http://local/studio-api/task/diff'),
    })
    assert.equal(handled, true)
    assert.equal(captured.status, 200)
    const payload = captured.payload
    assert.equal(payload.ok, true, payload.skipped ?? '')
    assert.equal(payload.base, 'main')
    assert.equal(payload.branch, 'feature')
    assert.deepEqual(payload.totals, { files: 2, additions: 2, deletions: 0 })
    const changed = payload.files.find(item => item.path === 'a.js')
    assert.ok(changed !== undefined)
    assert.equal(changed.change, 'modified', '改动类型要带上，面板用它标文件树')
    assert.match(changed.patch, /\+line2/)
    const added = payload.files.find(item => item.path === 'b.js')
    assert.equal(added.additions, 1)
    assert.equal(added.change, 'added')
    assert.equal(payload.uncommitted.total, 0, '提交干净时不该报未提交改动')
  } finally {
    store.db?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /task/diff：没配代码目录 / 不是 git 仓库时返回原因，不抛错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-studio-diff-empty-'))
  const store = new StudioStore(join(dir, 'state.json'), {
    dbFile: join(dir, 'state.db'),
    secrets: new SecretStore(join(dir, '.secrets.json')),
  })
  await store.ready
  await store.mutate(state => {
    state.tasks.push({ id: 't-diff-2', title: '（自检）没代码目录', type: 'dev', status: 'dev', comments: [], history: [], checklist: [], cases: [], artifacts: [], updatedAt: Date.now() })
  })
  try {
    let captured = null
    configureCodingRoutes({
      readJsonBody: async () => ({ id: 't-diff-2' }),
      sendJson: (res, status, payload) => { captured = { status, payload } },
      serviceOf: () => ({}),
      workProjectOf: () => ({}),
      publicState: () => ({}),
      getDispatcher: () => undefined,
    })
    await handleCodingRoute({ method: 'POST', route: '/task/diff', req: {}, res: {}, store, url: new URL('http://local/studio-api/task/diff') })
    assert.equal(captured.status, 200)
    assert.equal(captured.payload.ok, true, '读不到仓库是「已知的空」，不是请求失败（面板才能画成空态而不是报错）')
    assert.match(String(captured.payload.skipped), /代码目录/)
  } finally {
    store.db?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /task/file：读工作树里的文件全文；越界与缺失都如实拒绝', async () => {
  const { dir, repo } = makeRepo()
  const store = await makeDiffStore(dir)
  try {
    let captured = null
    const configure = body => configureCodingRoutes({
      readJsonBody: async () => body,
      sendJson: (res, status, payload) => { captured = { status, payload } },
      serviceOf: () => ({ repoPath: repo, baseBranch: 'main' }),
      workProjectOf: () => ({ repoPath: repo, baseBranch: 'main' }),
      publicState: () => ({}),
      getDispatcher: () => undefined,
    })
    const call = async body => {
      configure(body)
      await handleCodingRoute({ method: 'POST', route: '/task/file', req: {}, res: {}, store, url: new URL('http://local/studio-api/task/file') })
      return captured
    }
    const ok = await call({ id: 't-diff-1', path: 'a.js' })
    assert.equal(ok.payload.ok, true)
    assert.match(String(ok.payload.content), /line2/, '读到的是工作树里的文件本体')
    assert.equal(ok.payload.truncated, false)
    const escape = await call({ id: 't-diff-1', path: '../../outside.txt' })
    assert.equal(escape.payload.ok, true, '越界是「已知拒绝」，不是请求失败')
    assert.match(String(escape.payload.skipped), /仓库目录/)
    const missing = await call({ id: 't-diff-1', path: 'nope.js' })
    assert.match(String(missing.payload.skipped), /不在工作区/)
    const empty = await call({ id: 't-diff-1', path: '' })
    assert.match(String(empty.payload.skipped), /没给文件路径/)
  } finally {
    store.db?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /task/file：符号链接指到仓库外也拒绝（字面路径在仓库内）', async t => {
  const { dir, repo } = makeRepo()
  const store = await makeDiffStore(dir)
  const outside = join(dir, 'outside.txt')
  writeFileSync(outside, 'secret')
  let linked = true
  try { symlinkSync(outside, join(repo, 'link.txt')) } catch { linked = false }
  try {
    if (!linked) { t.skip('当前环境不能创建符号链接'); return }
    let captured = null
    configureCodingRoutes({
      readJsonBody: async () => ({ id: 't-diff-1', path: 'link.txt' }),
      sendJson: (res, status, payload) => { captured = { status, payload } },
      serviceOf: () => ({ repoPath: repo, baseBranch: 'main' }),
      workProjectOf: () => ({ repoPath: repo, baseBranch: 'main' }),
      publicState: () => ({}),
      getDispatcher: () => undefined,
    })
    await handleCodingRoute({ method: 'POST', route: '/task/file', req: {}, res: {}, store, url: new URL('http://local/studio-api/task/file') })
    assert.match(String(captured.payload.skipped), /仓库目录/)
    assert.equal(captured.payload.content, undefined, '软链指向的内容不能被读出')
  } finally {
    store.db?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /task/diff：commit 只看某一次提交；坏 sha 如实拒绝', async () => {
  const { dir, repo } = makeRepo()
  const store = await makeDiffStore(dir)
  try {
    const head = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    let captured = null
    const configure = body => configureCodingRoutes({
      readJsonBody: async () => body,
      sendJson: (res, status, payload) => { captured = { status, payload } },
      serviceOf: () => ({ repoPath: repo, baseBranch: 'main' }),
      workProjectOf: () => ({ repoPath: repo, baseBranch: 'main' }),
      publicState: () => ({}),
      getDispatcher: () => undefined,
    })
    const call = async body => {
      configure(body)
      await handleCodingRoute({ method: 'POST', route: '/task/diff', req: {}, res: {}, store, url: new URL('http://local/studio-api/task/diff') })
      return captured
    }
    const one = await call({ id: 't-diff-1', commit: head.slice(0, 7) })
    assert.equal(one.payload.ok, true, one.payload.skipped ?? '')
    assert.equal(String(one.payload.rangeLabel).startsWith('提交 '), true)
    assert.equal(one.payload.commit, head, '短 sha 要归一成长 sha')
    assert.equal(one.payload.files.length, 2, '这一次提交改了 a.js + b.js')
    assert.equal(Array.isArray(one.payload.commits), true)
    assert.equal(one.payload.commits.length, 1, 'base..HEAD 只有一次提交')
    const bad = await call({ id: 't-diff-1', commit: 'deadbeef' })
    assert.match(String(bad.payload.skipped), /找不到提交/)
    const weird = await call({ id: 't-diff-1', commit: 'not-a-sha' })
    assert.match(String(weird.payload.skipped), /提交号不合法/)
  } finally {
    store.db?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})
