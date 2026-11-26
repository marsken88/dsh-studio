// 交付物的出口分发：按 config.docs 决定投递到哪儿。
//
// 放在单独模块里有两个原因：一是 executor.js 有「每个宿主模块 ≤2000 行」的契约，
// 二是分发逻辑要能被单测直接打（注入写飞书/渲染 Markdown 两件本地能力，不做反向 import）。

import { docSinksFor } from './doc-sink.js'
import { uploadToWeknora } from './weknora-sink.js'

/* 同一份交付物的同步要串行。
   store.mutate 的串行只保护「单次写」，而一次同步是「读快照 → 网络 → 写台账」多段流程：
   两路并发都读到同一个旧 knowledgeId，于是各删一次旧、各建一份新，台账只能记最后一个，
   另一份就成了知识库里永久没人认领的孤儿（架构师探针已复现）。
   换 key（不同交付物）互不影响，排队只发生在同一件身上。 */
const inflight = new Map()

/**
 * @param io.writeFeishu 已有的飞书写入（executor 注入，避免 executor ↔ doc-sync 成环）
 * @param io.buildMarkdown 渲染交付物正文（同上）
 */
export function syncArtifact(store, taskId, artifactId, io = {}) {
  const key = `${taskId}::${artifactId}`
  // 前一轮失败不能连坐下一轮：先吞掉它的结果，再执行自己这份（失败仍抛给自己的调用方）。
  const run = (inflight.get(key) ?? Promise.resolve()).catch(() => {}).then(() => runSync(store, taskId, artifactId, io))
  inflight.set(key, run)
  return run.finally(() => {
    // 只清自己这一棒：后面还有人排队时，那把 entry 已经换成它的 promise 了。
    if (inflight.get(key) === run) inflight.delete(key)
  })
}

async function runSync(store, taskId, artifactId, io = {}) {
  const { writeFeishu, buildMarkdown } = io
  const state = store.snapshot()
  const task = state.tasks.find(item => item.id === taskId)
  if (task === undefined) throw new Error(`no task ${taskId}`)
  const artifact = (task.artifacts ?? []).find(item => item.id === artifactId)
  if (artifact === undefined) throw new Error(`no artifact ${artifactId}`)
  const requirement = state.requirements.find(item => item.id === task.requirementId)
  const plan = docSinksFor(state.config, requirement)
  const sinks = {}

  if (plan.sinks.includes('weknora')) {
    if (typeof buildMarkdown !== 'function') throw new Error('WeKnora 出口需要 buildMarkdown')
    const markdown = await buildMarkdown(task, artifact, state.config, requirement)
    const title = `${task.code || task.id} ${artifact.title}`.trim()
    const previousKnowledgeId = String(artifact.docs?.weknora?.knowledgeId ?? '')
    const result = await uploadToWeknora({ sink: state.config?.docs?.weknora, title, markdown, previousKnowledgeId })
    const record = {
      knowledgeId: String(result.knowledgeId ?? ''),
      url: String(result.url ?? ''),
      at: Date.now(),
      replaced: result.replaced === true,
      // 入库成功但 reparse 失败：文档在库里，可检索不到——把 warning 留在 error 位，别让人以为已经好了。
      error: result.ok === true ? String(result.warning ?? '') : String(result.error ?? '入库失败'),
    }
    await store.mutate(draft => {
      const card = draft.tasks.find(item => item.id === taskId)
      const target = (card?.artifacts ?? []).find(item => item.id === artifactId)
      if (target !== undefined) target.docs = { ...(target.docs ?? {}), weknora: record }
    })
    sinks.weknora = { ok: result.ok === true, ...record }
    // 主从不许反转：只有 WeKnora 本身就是主出口时，失败才抛出去挡住登记。
    if (result.ok !== true && plan.primary === 'weknora') throw new Error(`WeKnora 入库失败：${record.error}`)
  }

  if (plan.sinks.includes('feishu')) {
    if (typeof writeFeishu !== 'function') throw new Error('飞书出口需要 writeFeishu')
    const doc = await writeFeishu(store, taskId, artifactId)
    // 保持老返回值：调用方（工具 / 路由）读的是 doc.token / doc.url。
    return { ...doc, provider: plan.provider, primary: plan.primary, sinks: { ...sinks, feishu: doc } }
  }

  // 只写知识库时也要给消费方一个能打印的链接（工具/路由都读 url）+ 与老形状兼容的空 token。
  const first = sinks.weknora ?? {}
  return {
    provider: plan.provider,
    primary: plan.primary,
    sinks,
    token: '',
    url: String(first.url ?? ''),
    name: `${task.code || task.id} ${artifact.title}`.trim(),
    error: String(first.error ?? ''),
  }
}
