// WeKnora 出口：把一份交付物的 Markdown 写进知识库。
//
// 只做两步：POST manual 建文档 → POST reparse 触发解析分块。
// 真源永远是 Studio 里的 artifact：这里失败只回一个 error，由调用方决定要不要抛
// （both 时 WeKnora 是「从」，失败不许阻塞交付物登记）。

const trim = (value, max) => String(value ?? '').trim().slice(0, max)

/** 配齐了没有。缺什么要说清楚，不要回一句「没配置」。 */
export function weknoraReady(sink) {
  const src = sink !== null && typeof sink === 'object' ? sink : {}
  const missing = []
  if (trim(src.baseUrl, 300) === '') missing.push('baseUrl')
  if (trim(src.apiKey, 200) === '') missing.push('apiKey')
  if (trim(src.knowledgeBaseId, 60) === '') missing.push('knowledgeBaseId')
  return { ok: missing.length === 0, missing }
}

async function callJson(doFetch, url, init, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 30000))
  try {
    const response = await doFetch(url, { ...init, signal: controller.signal })
    const text = await response.text()
    let body
    try { body = JSON.parse(text) } catch { body = undefined }
    if (!response.ok) {
      const message = body?.error?.message ?? body?.message ?? text.slice(0, 200) ?? ''
      return { ok: false, status: response.status, error: `HTTP ${response.status}${message === '' ? '' : `：${String(message).slice(0, 200)}`}` }
    }
    return { ok: true, status: response.status, body }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    return { ok: false, status: 0, error: aborted ? '请求超时' : String(error?.message ?? error).slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 写一份交付物进知识库。返回 `{ ok, knowledgeId, url, error, warning }` 这类可落库的结论，从不抛。
 * 解析（reparse）失败只记 warning：文档已经在库上了，分块可以由人补跑。
 */
export async function uploadToWeknora({ sink, title, markdown, previousKnowledgeId = '', fetchImpl, timeoutMs = 30000 } = {}) {
  const ready = weknoraReady(sink)
  if (!ready.ok) return { ok: false, error: `WeKnora 出口没配全：缺 ${ready.missing.join(' / ')}` }
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  if (typeof doFetch !== 'function') return { ok: false, error: '当前运行环境没有 fetch' }
  const base = trim(sink.baseUrl, 300).replace(/\/+$/, '')
  const kb = trim(sink.knowledgeBaseId, 60)
  const headers = { 'Content-Type': 'application/json', 'X-API-Key': trim(sink.apiKey, 200) }
  const tenantId = trim(sink.tenantId, 40)
  if (tenantId !== '') headers['X-Tenant-ID'] = tenantId

  /* 幂等：WeKnora 没有「覆盖同名文档」的语义，重复同步只会堆出多份切片污染检索。
     所以拿台账里的 knowledgeId 先删旧再建新；旧文档已经不在了（404）也算删成功。
     注意：WeKnora 的删除是**异步任务**（202 + `Delete task submitted`），刚删完立刻 GET 仍可能 200，别拿它判成败。 */
  const previous = trim(previousKnowledgeId, 80)
  let replaced = false
  let replaceWarning = ''
  if (previous !== '') {
    const removed = await callJson(doFetch, `${base}/knowledge/${encodeURIComponent(previous)}`, { method: 'DELETE', headers }, timeoutMs)
    replaced = removed.ok === true || removed.status === 404
    if (replaced !== true) replaceWarning = `旧文档没删掉（${removed.error}）`
  }

  const created = await callJson(doFetch, `${base}/knowledge-bases/${encodeURIComponent(kb)}/knowledge/manual`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: trim(title, 200), content: String(markdown ?? ''), knowledge_type: 'manual' }),
  }, timeoutMs)
  if (created.ok !== true) return { ok: false, replaced, error: `建文档失败（${created.error}）` }
  const knowledgeId = trim(created.body?.data?.id ?? created.body?.id, 80)
  if (knowledgeId === '') return { ok: false, replaced, error: '建文档成功但没拿到 knowledge id' }

  // manual 文档落库是 draft，不 reparse 就不会分块，检索永远查不到。
  const reparsed = await callJson(doFetch, `${base}/knowledge/${encodeURIComponent(knowledgeId)}/reparse`, {
    method: 'POST',
    headers,
    body: '{}',
  }, timeoutMs)
  return {
    ok: true,
    knowledgeId,
    replaced,
    url: `${base}/knowledge/${knowledgeId}`,
    warning: [replaceWarning, reparsed.ok === true ? '' : `已入库但触发解析失败（${reparsed.error}），需要人工 reparse`].filter(Boolean).join('；'),
  }
}
