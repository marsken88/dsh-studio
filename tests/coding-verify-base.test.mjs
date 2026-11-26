// 代码事实核对：基线解析不到时**不许断言「一个文件都没改」**（真机误报，REQ-001 2026-11-26）。
// 用真 git 仓库跑：worktree.base 为空时按 merge-base 找 master/main，找不到就 skipped。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { verifyCodingRecord } from '../src/host/executor.js'

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
})()
const skip = hasGit ? false : '本机没有 git'

const makeRepo = (branch, files) => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-verify-'))
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  git('init', '-q', '-b', branch)
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  for (const [name, body] of files) writeFileSync(join(dir, name), body)
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  return { dir, git }
}

test('worktree.base 为空时按 merge-base 找到 master，不再误报「文件没改」', { skip }, async () => {
  const { dir, git } = makeRepo('master', [['a.txt', 'one\n']])
  try {
    git('checkout', '-q', '-b', 'task/x')
    writeFileSync(join(dir, 'b.txt'), 'two\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'feat')
    const sha = git('rev-parse', '--short', 'HEAD').trim()
    const task = {
      id: 't-v1',
      coding: { branch: 'task/x', commits: [{ sha }], files: [{ path: 'b.txt' }] },
      worktree: { path: dir, base: '' },
    }
    const out = await verifyCodingRecord({ config: {} }, task)
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.equal(out.baseUsed, 'master', '要退到实际存在的 master')
    assert.deepEqual(out.missingFiles, [], 'b.txt 确实改过，不能报缺失')
    assert.equal(out.fileCount.actual, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('基线彻底解析不到时返回 skipped，而不是「文件没改」', { skip }, async () => {
  const { dir } = makeRepo('lonely', [['a.txt', 'one\n']])
  try {
    const task = {
      id: 't-v2',
      coding: { branch: 'lonely', commits: [], files: [{ path: 'a.txt' }] },
      worktree: { path: dir, base: '' },
    }
    const out = await verifyCodingRecord({ config: {} }, task)
    assert.equal(out.ok, false)
    assert.match(String(out.skipped ?? ''), /基线分支解析不到/)
    assert.equal(out.missingFiles, undefined, 'skipped 时不该再声称文件缺失')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('提交已经并进基线（master==HEAD）时，改用「记录里的提交本身」当证据', { skip }, async () => {
  const { dir, git } = makeRepo('master', [['a.txt', 'one\n']])
  try {
    git('checkout', '-q', '-b', 'task/y')
    writeFileSync(join(dir, 'c.txt'), 'three\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'feat')
    const sha = git('rev-parse', '--short', 'HEAD').trim()
    // 研发把这条提交并进了 master：master 直接指向它（真实操作：merge --ff-only）
    git('checkout', '-q', 'master')
    git('merge', '-q', '--ff-only', 'task/y')
    git('checkout', '-q', 'task/y')
    const task = {
      id: 't-v3',
      coding: { branch: 'task/y', commits: [{ sha }], files: [{ path: 'c.txt' }] },
      worktree: { path: dir, base: '' },
    }
    const out = await verifyCodingRecord({ config: {} }, task)
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.match(String(out.baseUsed ?? ''), /^commit:/, '要标明是按提交本身算的')
    assert.deepEqual(out.missingFiles, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
