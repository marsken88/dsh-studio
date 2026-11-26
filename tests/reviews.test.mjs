// issue #9 第 2/4 条：需求引用归一化 + 评审工具（以前只有 HTTP 路由能做）。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { requirementRefHint, resolveRequirement, reviewRequirement, saveTaskDesign } from '../src/host/reviews.js'
import { SecretStore, StudioStore } from '../src/host/store.js'

const requirements = [
  { id: 'req-078f16', code: 'REQ-2026-001', title: '退款流水', status: 'draft', review: null },
  { id: 'req-aaaa11', code: 'REQ-2026-002', title: '对账', status: 'draft', review: null },
]

test('引用归一化：内部 id 与编号都能找到需求，大小写不敏感', () => {
  const state = { requirements }
  assert.equal(resolveRequirement(state, 'req-078f16')?.id, 'req-078f16')
  assert.equal(resolveRequirement(state, 'REQ-2026-002')?.id, 'req-aaaa11')
  assert.equal(resolveRequirement(state, 'req-2026-001')?.id, 'req-078f16', '编号大小写不敏感')
  assert.equal(resolveRequirement(state, 'REQ-9999') , undefined)
  assert.equal(resolveRequirement(state, '  '), undefined)
})

test('找不到时给出可用的引用，而不是只说 no requirement', () => {
  const hint = requirementRefHint({ requirements }, 'REQ-2026-999')
  assert.match(hint, /找不到需求「REQ-2026-999」/)
  assert.match(hint, /REQ-2026-001（req-078f16）/)
  assert.match(hint, /两个都能传/, '要告诉人正确格式')
})

test('需求评审：submit / approve / reject 都走同一条逻辑，编号也能传', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reviews-'))
  const store = new StudioStore(join(dir, 'state.json'), { dbFile: join(dir, 'state.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  try {
    await store.ready
    await store.mutate(state => { state.requirements.push({ ...requirements[0], points: [], docs: [], history: [], pool: null }) })

    const submitted = await reviewRequirement(store, { id: 'REQ-2026-001', decision: 'submit', by: '产品经理' })
    assert.equal(submitted.status, 'review')
    assert.equal(submitted.review.status, 'pending')

    const approved = await reviewRequirement(store, { id: 'req-078f16', decision: 'approve', by: '架构师', note: '范围清楚' })
    assert.equal(approved.status, 'active', '通过后进 active，拆卡才允许')
    assert.equal(approved.review.status, 'approved')
    assert.equal(approved.review.note, '范围清楚')

    await assert.rejects(() => reviewRequirement(store, { id: 'req-078f16', decision: 'reject', by: '架构师' }), /写一句评审意见/)
    const rejected = await reviewRequirement(store, { id: 'req-078f16', decision: 'reject', by: '架构师', note: '验收标准不可判定' })
    assert.equal(rejected.status, 'draft')
    assert.equal(rejected.review.status, 'changes_requested')

    await assert.rejects(() => reviewRequirement(store, { id: 'REQ-404', decision: 'approve' }), /找不到需求/)
    await assert.rejects(() => reviewRequirement(store, { id: 'req-078f16', decision: 'whatever' }), /未知的评审动作/)
  } finally {
    store.db?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('设计评审工具：部分更新不会抹掉已有多稿，定案留历史', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-design-tool-'))
  const store = new StudioStore(join(dir, 'state.json'), { dbFile: join(dir, 'state.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  try {
    await store.ready
    await store.mutate(state => {
      state.tasks.push({
        id: 't-d1', code: 'DEV-001', title: '多稿', status: 'design', role: 'architect',
        requirementId: '', checklist: [], artifacts: [], comments: [], history: [], cases: [], blocked: null,
      })
    })
    const first = await saveTaskDesign(store, 't-d1', {
      drafts: [{ id: 'a', name: '方案 A', link: 'https://x/a' }, { id: 'b', name: '方案 B', link: 'https://x/b' }],
    }, '产品经理')
    assert.equal(first.drafts.length, 2)
    assert.equal(first.chosenId, '', '两稿不定案')

    // 评审由另一个人下：自己放稿自己批是自审，评审环节等于没有
    const approved = await saveTaskDesign(store, 't-d1', { status: 'approved', chosenId: 'b' }, '人')
    assert.equal(approved.status, 'approved')
    assert.equal(approved.chosenId, 'b')

    // 只传 chosenId：多稿必须还在（合并而不是覆盖）
    const second = await saveTaskDesign(store, 't-d1', { chosenId: 'b' }, '产品经理')
    assert.equal(second.drafts.length, 2, '部分更新不能把稿子抹掉')
    assert.equal(second.chosenId, 'b')
    const card = store.snapshot().tasks.find(item => item.id === 't-d1')
    assert.ok(card.history.some(entry => String(entry.note ?? '') === '设计定案：方案 B'), '定案要留历史')

    // 过期的 chosenId：只剩一稿时回落成那一稿
    const third = await saveTaskDesign(store, 't-d1', { drafts: [{ id: 'a', name: '方案 A', link: 'https://x/a' }], chosenId: 'ghost' }, '产品经理')
    assert.equal(third.chosenId, 'a')
  } finally {
    store.db?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('设计评审不能自审：稿子和 approved 都是同一个人就拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-design-self-'))
  const store = new StudioStore(join(dir, 'state.json'), { dbFile: join(dir, 'state.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  try {
    await store.ready
    await store.mutate(state => {
      state.tasks.push({
        id: 't-d2', code: 'DEV-002', title: '自审', status: 'design', role: 'architect',
        requirementId: '', checklist: [], artifacts: [], comments: [], history: [], cases: [], blocked: null,
      })
    })
    await assert.rejects(
      () => saveTaskDesign(store, 't-d2', {
        drafts: [{ id: 'a', name: '方案 A', link: 'https://x/a' }],
        status: 'approved',
      }, '架构师'),
      /设计不能自审/,
    )
    const blocked = store.snapshot().tasks.find(item => item.id === 't-d2')
    assert.ok(blocked.design === null || blocked.design === undefined, '被拒的自审提交不能落库')

    // 同一个人只放稿（不下结论）可以；换一个人来批就通过
    const drafted = await saveTaskDesign(store, 't-d2', { drafts: [{ id: 'a', name: '方案 A', link: 'https://x/a' }] }, '架构师')
    assert.equal(drafted.status, 'pending')
    const approved = await saveTaskDesign(store, 't-d2', { status: 'approved' }, '人')
    assert.equal(approved.status, 'approved', '另一个评审人下 approved 要能通过')
  } finally {
    store.db?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('需求链接写坏了直接报错，不再静默存成空串（issue #9 第 1 条）', async () => {
  const { saveRequirement } = await import('../src/host/executor.js')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-links-'))
  const store = new StudioStore(join(dir, 'state.json'), { dbFile: join(dir, 'state.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  try {
    await store.ready
    await assert.rejects(() => saveRequirement(store, { title: '坏链接', links: { prd: 'docs/prd.md' } }), /不合法/)
    await assert.rejects(() => saveRequirement(store, { title: '坏链接', links: { proto: 'ftp://x/y' } }), /不合法/)
    const ok = await saveRequirement(store, { title: '好链接', links: { prd: 'https://example.com/p', proto: '/prototypes/a' } })
    assert.equal(ok.links.prd, 'https://example.com/p')
    assert.equal(ok.links.proto, '/prototypes/a')
    assert.equal(ok.links.acceptance, '', '没填的照旧是空串')
  } finally {
    store.db?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('名册里两位不同专家不算自审：架构师 可以评审 支付架构师 的稿', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-design-roster-'))
  const store = new StudioStore(join(dir, 'state.json'), { dbFile: join(dir, 'state.db'), secrets: new SecretStore(join(dir, '.secrets.json')) })
  try {
    await store.ready
    await store.mutate(state => {
      state.config.experts = [
        { id: 'arch', name: '架构师', role: 'architect', enabled: true },
        { id: 'pay-arch', name: '支付架构师', role: 'architect', enabled: true },
        { id: 'dev', name: '开发工程师', role: 'dev', enabled: true },
      ]
      state.tasks.push({
        id: 't-d3', code: 'DEV-003', title: '名册判自审', status: 'design', role: 'architect',
        requirementId: '', checklist: [], artifacts: [], comments: [], history: [], cases: [], blocked: null,
      })
    })
    await saveTaskDesign(store, 't-d3', { drafts: [{ id: 'a', name: '方案 A', link: 'https://x/a', by: '支付架构师' }] }, '支付架构师')
    await assert.rejects(
      () => saveTaskDesign(store, 't-d3', { status: 'approved', chosenId: 'a' }, '支付架构师'),
      /设计不能自审/,
      '同一个人（名字完全相同）仍然算自审',
    )
    const approved = await saveTaskDesign(store, 't-d3', { status: 'approved', chosenId: 'a' }, '架构师')
    assert.equal(approved.status, 'approved', '名册里另一位专家评审必须放行（「架构师」⊂「支付架构师」不算自审）')
  } finally {
    store.db?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

