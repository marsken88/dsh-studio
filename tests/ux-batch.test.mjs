// 第三批：乐观锁接线、删除确认、停摆判据、托盘跳转、设计评审意见、计划页签可改字段。
// 形态：能直接驱动宿主的地方驱动宿主（改类型要换编号），纯前端的接线用源码守卫。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { configureExecutor, updateTask } from '../src/host/executor.js'
import { SecretStore, StudioStore } from '../src/host/store.js'

configureExecutor(new Proxy({ serviceDependencies: () => [], serviceConflicts: () => undefined }, { get: (target, key) => (key in target ? target[key] : () => undefined) }))

const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')

const withStore = async fn => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ux-batch-'))
  const store = new StudioStore(join(dir, 'state.json'), { dbFile: join(dir, 'state.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  try {
    await store.ready
    return await fn(store)
  } finally {
    store.db?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('改类型要换编号：DEV-001 变成缺陷卡后叫 BUG-001（同一需求内递增）', async () => {
  await withStore(async store => {
    await store.mutate(state => {
      state.requirements.push({ id: 'req-1', code: 'REQ-2026-001', title: '库存', status: 'active', points: [], docs: [], history: [] })
      state.tasks.push({
        id: 't-dev', code: 'DEV-001', title: '实现预占', type: 'dev', status: 'dev', role: 'dev',
        requirementId: 'req-1', checklist: [], artifacts: [], comments: [], history: [], cases: [], blocked: null,
      })
      state.tasks.push({
        id: 't-bug', code: 'BUG-001', title: '已有缺陷', type: 'bug', status: 'dev', role: 'dev',
        requirementId: 'req-1', checklist: [], artifacts: [], comments: [], history: [], cases: [], blocked: null,
      })
    })
    const changed = await updateTask(store, 't-dev', { type: 'bug' })
    assert.equal(changed.type, 'bug')
    assert.equal(changed.code, 'BUG-002', '不能顶着 DEV-001 当缺陷卡；也不能撞已有的 BUG-001')

    // 只改优先级不该动编号
    const same = await updateTask(store, 't-dev', { priority: 'urgent' })
    assert.equal(same.code, 'BUG-002', '没换类型/没换需求时编号保持不变')
  })
})

test('乐观锁：带 ifVersion 的并发修改被拒，卡内容不丢', async () => {
  await withStore(async store => {
    await store.mutate(state => {
      state.tasks.push({
        id: 't-lock', code: 'DEV-003', title: '并发', type: 'dev', status: 'dev', role: 'dev',
        requirementId: '', checklist: [], artifacts: [], comments: [], history: [], cases: [], blocked: null,
      })
    })
    const first = await updateTask(store, 't-lock', { priority: 'urgent' })
    const version = Number(first.version)
    const second = await updateTask(store, 't-lock', { priority: 'normal', ifVersion: version })
    assert.equal(second.priority, 'normal')
    await assert.rejects(
      () => updateTask(store, 't-lock', { title: '基于旧版本改标题', ifVersion: version }),
      error => error?.code === 'version_conflict' && error?.current?.id === 't-lock',
      '基于旧版本的写入必须 409 并带回当前卡',
    )
    assert.notEqual(store.snapshot().tasks.find(item => item.id === 't-lock').title, '基于旧版本改标题', '被拒的写入不能落库')
  })
})

test('面板写路径都带 ifVersion（抽屉 / 拖拽 / 命令面板 / 整列推进），409 就地提示', () => {
  const client = source('client.src.js')
  const drawer = source('web/src/studio/drawer.js')
  const palette = source('web/src/studio/palette.js')
  assert.match(client, /failure\.status = response\.status/, 'api() 要把状态码带出来')
  assert.match(client, /failure\.code = payload\.code/, 'api() 要把业务 code 带出来')
  assert.match(drawer, /ifVersion: Number\(task\.version\)/, '抽屉的通用写入口要带 ifVersion')
  assert.match(drawer, /const guard = Number\.isInteger\(Number\(task\.version\)\)/, '推进也要带 ifVersion')
  assert.match(drawer, /version_conflict/, '409 要就地提示并刷新')
  assert.match(client, /ifVersion: version/, '看板拖拽要带 ifVersion')
  assert.match(palette, /ifVersion: Number\(card\.version\)/, '命令面板推进要带 ifVersion')
  assert.match(palette, /ifVersion: Number\(task\.version\)/, '整列推进要逐张带 ifVersion')
})

test('乐观锁：面板不再只手填 patch 就不带版本（回归守卫）', () => {
  const drawer = source('web/src/studio/drawer.js')
  assert.ok(!/api\('\/task\/update', \{ id: task\.id, patch \}\)/.test(drawer), '通用写入口不能还是不带 ifVersion')
})

test('删除交付物 / 验收清单条目要二次确认', () => {
  const drawer = source('web/src/studio/drawer.js')
  assert.match(drawer, /const removeArtifact = async \(item\) => \{[\s\S]{0,300}confirmDialog\(/, '删除交付物要先确认')
  assert.match(drawer, /const removeChecklist = async \(item\) => \{[\s\S]{0,300}confirmDialog\(/, '删除清单条目要先确认')
})

test('卡面停摆判据以服务端下发为准（task.stalled）', () => {
  const card = source('web/src/studio/card.js')
  assert.match(card, /if \(task\.stalled === true\) return 'stalled'/, '跑挂了的卡要按服务端判定显示停摆')
})

test('运行托盘的行可以打开对应卡片', () => {
  const tray = source('web/src/studio/run-tray.js')
  const client = source('client.src.js')
  assert.match(tray, /function RunTray\(\{ state, onOpenTask \}\)/)
  assert.match(tray, /typeof onOpenTask === 'function' && info\.taskId/)
  assert.match(tray, /role: 'button'/, '可点行要有键盘可达语义')
  assert.match(client, /h\(RunTray, \{ state, onOpenTask: id => setOpenId\(id\) \}\)/)
})

test('设计评审：意见可写，驳回必须给意见', () => {
  const drawer = source('web/src/studio/drawer.js')
  assert.match(drawer, /'data-design-note': ''/, '设计页要有意见输入框')
  assert.match(drawer, /action === 'changes'[\s\S]{0,600}promptDialog\(/, '驳回要弹意见输入')
  assert.match(drawer, /要求修改要写一句意见/, '空的驳回要被拦下')
  assert.match(drawer, /status: 'changes_requested', note: String\(written\)\.trim\(\)/, '意见要随评审一起提交')
})

test('计划页签可以改类型 / 优先级 / 父任务', () => {
  const drawer = source('web/src/studio/drawer.js')
  assert.match(drawer, /type: task\.type \?\? 'requirement'/, 'plan 草稿要带类型')
  assert.match(drawer, /priority: task\.priority \?\? 'normal'/, 'plan 草稿要带优先级')
  assert.match(drawer, /parent: task\.parent \?\? ''/, 'plan 草稿要带父任务')
  assert.match(drawer, /'aria-label': '父任务'/, '页面上要有父任务选择')
  assert.match(drawer, /type: plan\.type,[\s\S]{0,120}priority: plan\.priority,/, '保存计划要把三项一起提交')
})

test('设置页：BoardUI 下拉也算未保存（只在草稿块里）', () => {
  const client = source('client.src.js')
  assert.match(client, /const inDraftScope = event =>/, '要能判断是不是草稿块')
  assert.match(client, /if \(tag === undefined \|\| tag === null\) \{[\s\S]{0,200}setDirty\(true\)/, '无 tagName 的下拉事件要能标脏')
  assert.match(client, /'data-draft-form': \['board', 'agents'\]\.includes\(section\)/, '草稿块由容器声明')
})
