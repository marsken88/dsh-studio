// 云盘目录树：根 → 项目 → 需求 → 按类型分的产物子文件夹。
// 纯函数与建目录流程都用桩 larkJson 验，不碰真云盘。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { artifactFolderName, findFolder, projectFolderName, requirementFolderNameOf, safeFolderName } from '../src/host/drive-folders.js'
import { deleteProjectFolder, deleteRequirementFolder, ensureKindFolder, ensureProjectFolder, ensureRequirementFolder } from '../src/host/drive-sync.js'
import { larkUploadArgs } from '../src/host/lark-upload.js'
import { commandArgs, quoteForCmd } from '../src/host/cmd-args.js'
import { SecretStore, StudioStore } from '../src/host/store.js'

test('项目文件夹名：KEY + 名称，没项目落「未归属项目」，非法字符替换', () => {
  assert.equal(projectFolderName({ id: 'ord', key: 'ORD', name: '订单中心' }), 'ORD 订单中心')
  assert.equal(projectFolderName({ id: 'ord', name: '订单中心' }), '订单中心')
  assert.equal(projectFolderName(undefined), '未归属项目')
  assert.equal(safeFolderName('需求/退款:纪要'), '需求_退款_纪要')
  assert.equal(safeFolderName('   '), '未命名')
})

test('需求文件夹名：编号在前，同项目内天然唯一', () => {
  assert.equal(requirementFolderNameOf({ id: 'req-1', code: 'REQ-2026-001', title: '积分抵扣' }), 'REQ-2026-001 积分抵扣')
  assert.equal(requirementFolderNameOf({ id: 'req-1', title: '积分抵扣' }), 'req-1 积分抵扣')
})

test('产物类型 → 子文件夹：带序号，未知类型归「其它」', () => {
  assert.equal(artifactFolderName('design'), '02 设计文档')
  assert.equal(artifactFolderName('requirement'), '01 需求文档')
  assert.equal(artifactFolderName('cases'), '03 用例')
  assert.equal(artifactFolderName('weird'), '07 其它')
  assert.equal(artifactFolderName(''), '07 其它')
})

test('findFolder：只认同层同名目录，忽略非目录条目', () => {
  const list = [
    { name: 'ORD 订单中心', token: 't1', type: 'folder' },
    { name: 'ORD 订单中心', token: 'doc1', type: 'docx' },
  ]
  assert.equal(findFolder(list, 'ORD 订单中心')?.token, 't1')
  assert.equal(findFolder(list, '不存在'), undefined)
  assert.equal(findFolder([{ name: 'X', token: 'x', file_type: 'folder' }], 'X')?.token, 'x', 'file_type 写法也认')
})

/** 桩 larkJson：按顺序返回预设结果，并记录调用参数。 */
const stubLark = results => {
  const calls = []
  const fn = async args => {
    calls.push(args.join(' '))
    return results.shift() ?? { ok: true, data: { items: [] } }
  }
  return { fn, calls }
}

const withStore = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-drive-tree-'))
  const store = new StudioStore(join(dir, 'state.json'), { dbFile: join(dir, 'state.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  try {
    await store.ready
    await store.mutate(state => {
      state.config.feishu.driveFolder = 'ROOT'
      state.config.projects = [{ id: 'ord', key: 'ORD', name: '订单中心', services: [], iterations: [] }]
      state.requirements.push({
        id: 'req-1', code: 'REQ-2026-001', title: '积分抵扣', status: 'active', project: 'ord',
        points: [], docs: [], questions: [], dependsOn: [], history: [], folder: {},
      })
    })
    return await fn(store)
  } finally {
    store.db?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('建需求文件夹：先建项目文件夹（根下面），再在项目下面建需求文件夹', async () => {
  await withStore(async store => {
    const { fn, calls } = stubLark([
      { ok: true, data: { items: [] } },                                   // 列根：没有同名项目目录
      { ok: true, data: { folder_token: 'PROJ', url: 'https://x/proj' } }, // 建项目目录
      { ok: true, data: { items: [] } },                                   // 列项目：没有同名需求目录
      { ok: true, data: { folder_token: 'REQ', url: 'https://x/req' } },   // 建需求目录
    ])
    const folder = await ensureRequirementFolder(store, 'req-1', fn)
    assert.equal(folder.token, 'REQ')
    assert.equal(folder.parentToken, 'PROJ')
    assert.equal(folder.parentName, 'ORD 订单中心')
    assert.ok(calls.some(call => call.includes('--folder-token ROOT') && call.includes('--name ORD 订单中心')), calls.join(' | '))
    assert.ok(calls.some(call => call.includes('--folder-token PROJ') && call.includes('--name REQ-2026-001 积分抵扣')), calls.join(' | '))
    assert.equal(store.snapshot().config.feishu.projectFolders.ord.token, 'PROJ', '项目目录要缓存进配置')
  })
})

test('同名目录复用：列出来已经有了就不重复建', async () => {
  await withStore(async store => {
    const { fn, calls } = stubLark([
      { ok: true, data: { items: [{ name: 'ORD 订单中心', token: 'PROJ', type: 'folder' }] } },
      { ok: true, data: { items: [{ name: 'REQ-2026-001 积分抵扣', token: 'REQ', type: 'folder' }] } },
    ])
    const folder = await ensureRequirementFolder(store, 'req-1', fn)
    assert.equal(folder.token, 'REQ')
    assert.ok(!calls.some(call => call.includes('+create-folder')), '不该再建目录：' + calls.join(' | '))
  })
})

test('换云盘根目录后项目文件夹缓存失效：不会把新需求建到旧根下', async () => {
  await withStore(async store => {
    /* 老缓存没有 root 字段（升级前的数据）：必须按未命中处理，否则永远指向旧根。 */
    await store.mutate(state => {
      state.config.feishu.projectFolders = { ord: { token: 'OLD_PROJ', url: '', name: 'ORD 订单中心', at: 1, error: '' } }
    })
    const { fn, calls } = stubLark([
      { ok: true, data: { items: [] } },                                      // 列新根：没有同名项目目录
      { ok: true, data: { folder_token: 'NEW_PROJ', url: 'https://x/new' } }, // 在新根下建项目目录
      { ok: true, data: { items: [] } },                                      // 列项目：没有同名需求目录
      { ok: true, data: { folder_token: 'REQ', url: 'https://x/req' } },
    ])
    const folder = await ensureRequirementFolder(store, 'req-1', fn)
    assert.equal(folder.parentToken, 'NEW_PROJ')
    assert.ok(calls.some(call => call.includes('--folder-token ROOT')), '新根下要重新找/建项目目录：' + calls.join(' | '))
    const cache = store.snapshot().config.feishu.projectFolders.ord
    assert.equal(cache.token, 'NEW_PROJ')
    assert.equal(cache.root, 'ROOT', '缓存要记住根目录，换根后自动失效')
  })
})

test('同一根目录下项目文件夹缓存直接复用（不重复列根目录）', async () => {
  await withStore(async store => {
    await store.mutate(state => {
      state.config.feishu.projectFolders = { ord: { token: 'PROJ', url: '', name: 'ORD 订单中心', root: 'ROOT', at: 1, error: '' } }
    })
    const { fn, calls } = stubLark([
      { ok: true, data: { items: [{ name: 'REQ-2026-001 积分抵扣', token: 'REQ', type: 'folder' }] } },
    ])
    const folder = await ensureRequirementFolder(store, 'req-1', fn)
    assert.equal(folder.parentToken, 'PROJ')
    assert.ok(!calls.some(call => call.includes('--folder-token ROOT')), '缓存命中时不该再列根目录：' + calls.join(' | '))
  })
})

test('产物子文件夹：按类型建在需求目录下，并缓存', async () => {
  await withStore(async store => {
    await store.mutate(state => {
      state.requirements[0].folder = { token: 'REQ', url: '', name: 'REQ-2026-001 积分抵扣', at: 1, error: '' }
    })
    const { fn } = stubLark([
      { ok: true, data: { items: [] } },
      { ok: true, data: { folder_token: 'KIND', url: 'https://x/kind' } },
    ])
    const kind = await ensureKindFolder(store, 'req-1', 'design', fn)
    assert.equal(kind.token, 'KIND')
    assert.equal(kind.name, '02 设计文档')
    assert.equal(store.snapshot().requirements[0].folder.kinds['02 设计文档'].token, 'KIND')
    // 第二次直接命中缓存，不再发请求
    const again = await ensureKindFolder(store, 'req-1', 'design', fn)
    assert.equal(again.token, 'KIND')
  })
})

test('没挂项目的需求落到「未归属项目」目录', async () => {
  await withStore(async store => {
    await store.mutate(state => { state.requirements[0].project = '' })
    const { fn, calls } = stubLark([
      { ok: true, data: { items: [] } },
      { ok: true, data: { folder_token: 'MISC' } },
      { ok: true, data: { items: [] } },
      { ok: true, data: { folder_token: 'REQ' } },
    ])
    const folder = await ensureRequirementFolder(store, 'req-1', fn)
    assert.equal(folder.parentName, '未归属项目')
    assert.ok(calls.some(call => call.includes('--name 未归属项目')), calls.join(' | '))
  })
})

test('删需求目录：调 +delete 并把 folder 清空；没有目录就跳过', async () => {
  await withStore(async store => {
    await store.mutate(state => {
      state.requirements[0].folder = { token: 'REQ', url: 'https://x/req', name: 'REQ-2026-001 积分抵扣', at: 1, error: '' }
    })
    const { fn, calls } = stubLark([{ ok: true, data: {} }])
    const out = await deleteRequirementFolder(store, 'req-1', fn)
    assert.equal(out.ok, true)
    assert.ok(calls[0].includes('+delete') && calls[0].includes('--file-token REQ') && calls[0].includes('--type folder'), calls[0])
    assert.equal(store.snapshot().requirements[0].folder.token, undefined, 'folder 要清空，别留指向回收站的 token')
  })
  await withStore(async store => {
    const { fn, calls } = stubLark([])
    const out = await deleteRequirementFolder(store, 'req-1', fn)
    assert.equal(out.ok, true)
    assert.equal(calls.length, 0, '没有目录时不该发请求')
  })
})

test('上传参数：--file 只给文件名（绝对路径会被 lark-cli 判 unsafe），cwd 指到临时目录', () => {
  const create = larkUploadArgs({ dir: 'C:/Users/x/.dsh/tmp/artifact-a1', name: 'REQ-001-需求-说明.md', folderToken: 'F1' })
  assert.equal(create.cwd, 'C:/Users/x/.dsh/tmp/artifact-a1')
  assert.equal(create.args[create.args.indexOf('--file') + 1], 'REQ-001-需求-说明.md', '不能带目录')
  assert.equal(create.args.includes('C:/Users/x/.dsh/tmp/artifact-a1/REQ-001-需求-说明.md'), false, '整条命令里都不该出现绝对路径')
  assert.equal(create.args[create.args.indexOf('--folder-token') + 1], 'F1')
  // 覆盖已有文档：不需要 folder-token，也不需要 --name
  const over = larkUploadArgs({ dir: 'C:/tmp/y', name: 'a.md', existing: 'TOK' })
  assert.deepEqual(over.args, ['markdown', '+overwrite', '--file-token', 'TOK', '--file', 'a.md'])
  // 传进来的名字带目录时也只取文件名
  assert.equal(larkUploadArgs({ dir: 'C:/tmp/y', name: 'C:/tmp/y/b.md', existing: 'T' }).args.at(-1), 'b.md')
  assert.throws(() => larkUploadArgs({ dir: '', name: 'a.md' }), /临时目录/)
})

test('cmd 参数引号：| & 空格 都要包起来（否则 cmd.exe 把 & | 当语法截断命令）', () => {
  // 真机两次踩到：page-token 带 |、交付物标题带 &，命令都在那里断掉
  assert.deepEqual(quoteForCmd(['--page-size', '200']), ['--page-size', '200'], '普通参数不加引号')
  assert.deepEqual(quoteForCmd(['--page-token', 'v3|McKxW']), ['--page-token', '"v3|McKxW"'])
  assert.deepEqual(quoteForCmd(['--file', '退款&对账.md']), ['--file', '"退款&对账.md"'])
  assert.deepEqual(quoteForCmd(['--name', 'REQ-001 积分抵扣']), ['--name', '"REQ-001 积分抵扣"'], '带空格也要加（verbatim 模式）')
  assert.deepEqual(quoteForCmd(['']), ['""'], '空参数要保住，别被 cmd 吞掉')
  // 非 Windows 不加 shell，也不加引号
  const posix = commandArgs('lark-cli', ['--name', 'a b'], 'darwin')
  assert.deepEqual(posix, { file: 'lark-cli', argv: ['--name', 'a b'] })
  const win = commandArgs('lark-cli', ['--name', 'a b'], 'win32', 'cmd.exe')
  assert.equal(win.file, 'cmd.exe')
  assert.deepEqual(win.argv, ['/c', 'lark-cli', '--name', '"a b"'])
})

test('漏传 larkJson 要在调用点报清楚，而不是变成 "larkJson is not a function" 被上层吞掉', async () => {
  // 2026-11-20 真机：syncArtifact 漏传第四个参数 → TypeError 被 catch 当成"云盘不可用"，
  // 交付物就一直落在需求根目录，查了两轮才定位。
  await withStore(async store => {
    await store.mutate(state => {
      state.requirements[0].folder = { token: 'REQ', url: '', name: 'x', at: 1, error: '', kinds: {} }
    })
    await assert.rejects(() => ensureKindFolder(store, 'req-1', 'design'), /ensureKindFolder 需要传入 larkJson/)
    await assert.rejects(() => ensureRequirementFolder(store, 'req-1'), /ensureRequirementFolder 需要传入 larkJson/)
    await assert.rejects(() => deleteRequirementFolder(store, 'req-1'), /deleteRequirementFolder 需要传入 larkJson/)
  })
})

test('删项目目录：按项目 id 找缓存里的 token，删完清缓存；没有目录就跳过', async () => {
  await withStore(async store => {
    await store.mutate(state => { state.config.feishu.projectFolders = { ord: { token: 'PROJ', url: '', name: 'ORD 订单中心', at: 1, error: '' } } })
    const { fn, calls } = stubLark([{ ok: true, data: {} }])
    const out = await deleteProjectFolder(store, 'ord', fn)
    assert.equal(out.ok, true)
    assert.ok(calls[0].includes('--file-token PROJ') && calls[0].includes('--type folder'), calls[0])
    assert.deepEqual(store.snapshot().config.feishu.projectFolders, {}, '删完要把缓存清掉')
    // 没缓存的项目：跳过、不发请求
    const { fn: fn2, calls: calls2 } = stubLark([])
    assert.equal((await deleteProjectFolder(store, 'nope', fn2)).skipped, '这个项目没有云盘目录')
    assert.equal(calls2.length, 0)
    await assert.rejects(() => deleteProjectFolder(store, 'ord'), /deleteProjectFolder 需要传入 larkJson/)
  })
})
