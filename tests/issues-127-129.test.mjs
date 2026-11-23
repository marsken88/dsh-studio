// issue #127 / #128 / #129 的回归测试。
import assert from 'node:assert/strict'
import test from 'node:test'

import { parseStudioSession } from '../src/host/agent-feed.js'
import { ARTIFACT_KINDS, sanitizeArtifact } from '../src/host/domain.js'
import { artifactFileName } from '../src/host/executor.js'
import { requirementGate, requirementMatrix } from '../src/host/requirement-gate.js'

test('#127 派单会话名：专家 id 带连字符也要解析对', () => {
  // 卡 t-1ade5b86 + 专家 expert-d3c58341：老解析器会切成 taskId=t-1ade5b86-expert
  assert.deepEqual(parseStudioSession('studio-t-1ade5b86-expert-d3c58341'), { taskId: 't-1ade5b86', expertId: 'expert-d3c58341' })
  assert.deepEqual(parseStudioSession('studio-t-1ade5b86-architect'), { taskId: 't-1ade5b86', expertId: 'architect' })
  assert.deepEqual(parseStudioSession('studio-t-9f9504f8-ab-base-nion'), { taskId: 't-9f9504f8', expertId: 'ab-base-nion' })
  assert.equal(parseStudioSession('other-session'), null)
  assert.equal(parseStudioSession('studio-'), null)
})

test('#128 原型是一等交付物：kind 认 prototype，归档文件名是「原型-标题.md」', () => {
  assert.ok(ARTIFACT_KINDS.includes('prototype'), 'ARTIFACT_KINDS 要有 prototype')
  const created = sanitizeArtifact({ kind: 'prototype', title: '登录页线框图', ref: 'docs/proto.fig' }, 0)
  assert.equal(created.kind, 'prototype', 'prototype 不能被降级成 other')
  assert.equal(artifactFileName({ code: 'DEV-1' }, created), 'DEV-1-原型-登录页线框图.md')
})

test('#129 交付物口径：需求文档也算，stage 只认合法列名', () => {
  // stage 校验
  assert.equal(sanitizeArtifact({ kind: 'doc', title: 'x', stage: 'dev' }, 0).stage, 'dev')
  assert.equal(sanitizeArtifact({ kind: 'doc', title: 'x', stage: '不存在的列' }, 0).stage, '')

  // 只有 docs 没有卡交付物时，需求级 artifacts 统计不能是 0
  const requirement = {
    id: 'req-1', code: 'REQ-2026-921', title: '（自检）口径', status: 'active',
    points: [], docs: [{ id: 'd1', kind: 'prd', title: 'PRD', content: '# 正文' }],
    questions: [], history: [], changes: [], links: {}, pool: {},
  }
  const state = { tasks: [], requirements: [requirement] }
  const matrix = requirementMatrix(state, requirement)
  assert.equal(matrix.summary.artifacts, 1, 'PRD 正文要算进交付物')
  const gate = requirementGate(state, requirement)
  assert.ok(!gate.blockers.some(line => /还没有产品输出/.test(line)), 'docs 里有 PRD 正文就不该再拦「没有产品输出」')
})
