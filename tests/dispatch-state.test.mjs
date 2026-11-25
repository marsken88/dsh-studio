import assert from 'node:assert/strict'
import { describe, it, test } from 'node:test'

import { abandonedRetry, countStalled, dispatchPhase, handoffRetry, isStalled, restartResume, RUNNING_TIMEOUT_MS } from '../src/host/dispatch-state.js'

/* 这两个 bug 都是「状态形状看着对、语义不对」，只能靠断言防住：
   ① 崩溃重启后 reconcile 只清 state 不清 status → 卡永久停摆
   ② 「重新派单」只清失败计数、不清 dispatch 印记 → 永不重派 */
describe('dispatch-state: 派单阶段判定', () => {
  it('没有派单印记 → queued（等着被派）', () => {
    assert.equal(dispatchPhase({ status: 'dev', dispatch: null }), 'queued')
    assert.equal(dispatchPhase({ status: 'dev' }), 'queued')
  })

  it('印记的列与当前列不同 → queued（换列了，该重新派）', () => {
    assert.equal(dispatchPhase({ status: 'test', dispatch: { status: 'dev', state: 'running' } }), 'queued')
  })

  it('印记匹配且正在跑 → running', () => {
    assert.equal(dispatchPhase({ status: 'dev', dispatch: { status: 'dev', state: 'running' } }), 'running')
  })

  it('主动停止（stopped + 列名匹配）→ idle，不该计入停摆', () => {
    const task = { status: 'dev', dispatch: { status: 'dev', state: 'stopped' } }
    assert.equal(dispatchPhase(task), 'idle')
    assert.equal(isStalled(task), false)
  })

  it('没人收的兜底：unknown 状态且列名匹配 → stalled（真异常还是要报警）', () => {
    const task = { status: 'dev', dispatch: { status: 'dev', state: 'abandoned' } }
    assert.equal(dispatchPhase(task), 'stalled')
    assert.equal(isStalled(task), true)
  })

  it('reconcile 修好后（status 清空）→ queued，能重新派单', () => {
    const task = { status: 'dev', dispatch: { status: '', state: 'stopped', attempts: 2 } }
    assert.equal(dispatchPhase(task), 'queued')
    assert.equal(isStalled(task), false)
  })

  it('「重新派单」修好后（dispatch 置空）→ queued', () => {
    const task = { status: 'dev', dispatch: null }
    assert.equal(dispatchPhase(task), 'queued')
  })

  it('countStalled 能一次数出所有停摆的卡', () => {
    const tasks = [
      { id: 'a', status: 'dev', dispatch: { status: 'dev', state: 'abandoned' } }, // 停摆（没人收）
      { id: 'b', status: 'dev', dispatch: { status: 'dev', state: 'running' } },   // 正常
      { id: 'c', status: 'test', dispatch: null },                                  // 排队
      { id: 'd', status: 'test', dispatch: { status: 'dev', state: 'stopped' } },  // 换列了
    ]
    assert.equal(countStalled(tasks), 1)
  })
})

test('dispatchPhase：running 挂死超过阈值算 stalled（以前永远算 running，既不提示也不重派）', () => {
  const at = 1_000_000
  const task = { status: 'review', dispatch: { status: 'review', state: 'running', sessionId: 's1', at } }
  assert.equal(dispatchPhase(task, { now: at + 60_000 }), 'running', '一分钟内仍算在跑')
  assert.equal(dispatchPhase(task, { now: at + RUNNING_TIMEOUT_MS + 1 }), 'stalled', '超过阈值算停摆')
  assert.equal(isStalled(task, { now: at + RUNNING_TIMEOUT_MS + 1 }), true)
  assert.equal(countStalled([task], { now: at + RUNNING_TIMEOUT_MS + 1 }), 1)
})

test('dispatchPhase：能问到会话是否活着时以它为准（真会话比时间戳可靠）', () => {
  const at = 1_000_000
  const task = { status: 'dev', dispatch: { status: 'dev', state: 'running', sessionId: 's1', at } }
  const live = new Set(['s1'])
  const dead = new Set()
  assert.equal(dispatchPhase(task, { now: at + 10 * RUNNING_TIMEOUT_MS, isLive: id => live.has(id) }), 'running', '会话活着再久也算在跑')
  assert.equal(dispatchPhase(task, { now: at + 1, isLive: id => dead.has(id) }), 'stalled', '会话没了立刻算停摆，不用等阈值')
})

test('dispatchPhase：不传 ctx 时默认就按 10 分钟兜底（否则挂死的卡永远看不出来）', () => {
  const fresh = { status: 'dev', dispatch: { status: 'dev', state: 'running', sessionId: 's1', at: Date.now() } }
  const stale = { status: 'dev', dispatch: { status: 'dev', state: 'running', sessionId: 's1', at: Date.now() - RUNNING_TIMEOUT_MS - 1000 } }
  assert.equal(dispatchPhase(fresh), 'running', '刚派出去的算在跑')
  assert.equal(dispatchPhase(stale), 'stalled', '没动静超过阈值算停摆')
  /* 2026-11-25 改口径：老版本 settle 写的是 state:'idle'，那是「这一轮正常跑完了」，
     不该报成停摆（否则看板会给一堆正常结束的卡挂黄条）。 */
  assert.equal(dispatchPhase({ status: 'dev', dispatch: { status: 'dev', state: 'idle', at: 1 } }), 'done', '老的 idle 印记按「已结束」算')
  assert.equal(isStalled({ status: 'dev', dispatch: { status: 'dev', state: 'idle', at: 1 } }), false, '正常结束不是停摆')
})

test('handoffRetry：跑完没推进时按冷却 + 次数上限催派', () => {
  const now = 1_000_000
  const done = { status: 'dev', state: 'done', advanced: false, attempts: 1, at: now - 10_000 }
  const waiting = handoffRetry(done, { now, maxAttempts: 3, cooldownMs: 60_000 })
  assert.equal(waiting.attempts, 1)
  assert.equal(waiting.exhausted, false)
  assert.equal(waiting.waitMs, 50_000, '冷却窗口内还要等')
  const ready = handoffRetry({ ...done, at: now - 90_000 }, { now, maxAttempts: 3, cooldownMs: 60_000 })
  assert.equal(ready.waitMs, 0, '过了冷却就能派')
  const used = handoffRetry({ ...done, attempts: 3 }, { now, maxAttempts: 3, cooldownMs: 60_000 })
  assert.equal(used.exhausted, true, '次数用完就不该再自动派')
  const blank = handoffRetry({}, {})
  assert.equal(blank.max, 3, '不传参数时用默认上限')
  assert.equal(blank.waitMs, 0, '没有时间戳就当冷却已过')
})

test('restartResume：重启要接住「被中断」和「跑完没推进」，人停的不接', () => {
  assert.equal(restartResume(null), false)
  assert.equal(restartResume({ status: 'dev', state: 'running' }), true, '进程结束时在跑')
  assert.equal(restartResume({ status: 'dev', state: 'done', advanced: false }), true, '正常结束但没换列')
  assert.equal(restartResume({ status: 'dev', state: 'idle' }), true, '老印记也按没推进算')
  assert.equal(restartResume({ status: 'dev', state: 'done', advanced: true }), false, '换过列的交给下一列')
  assert.equal(restartResume({ status: 'dev', state: 'stopped' }), false, '人主动停的不接')
})
