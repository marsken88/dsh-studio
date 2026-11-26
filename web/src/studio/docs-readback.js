/**
 * 保存后回读核对（REQ-2026-003 p3 / R7）。
 *
 * 面板保存 `docs` 之后，用 /config 返回的 `state.config.docs`（或再 GET 一次 /state）跟提交值比对：
 * 一致才显示「已保存」，不一致必须报错——否则「回 200 但项目覆盖少了一项」这类半配置看不出来。
 *
 * 零依赖纯函数：tests/client-units.test.mjs 直接 import，不依赖 DOM / 组件。
 *
 * 比对口径：
 *   · provider 相等；
 *   · perProject 深等（键序无关）；
 *   · weknora.{baseUrl,tenantId,knowledgeBaseId} 相等；
 *   · apiKey 不参与比对（回读恒为 ''），只判 apiKeySet === (保存前已配置 || 本次输入了新 key)。
 */
const asText = value => (value === undefined || value === null ? '' : String(value))
const asTable = value => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})

/** 面板「项目级覆盖」区的初值：docs.perProject → overrides 数组。
    这里不做任何「项目还在不在列表里」的过滤 —— 不在 /state.projects 里的历史键默认保留（R9 禁止静默剔除）。 */
export function overridesFromDocs(perProject) {
  return Object.entries(asTable(perProject)).map(([id, provider]) => ({ id, provider }))
}

/** 返回空数组 = 回读一致；否则每项一行「字段：提交 X / 回读 Y」。 */
export function diffDocsReadback(sent, readback, { apiKeySetBefore = false } = {}) {
  const diffs = []
  const outbound = asTable(sent)
  const inbound = asTable(readback)

  const sentProvider = asText(outbound.provider)
  const readProvider = asText(inbound.provider)
  if (sentProvider !== readProvider) {
    diffs.push(`provider：提交 ${sentProvider === '' ? '（空）' : sentProvider} / 回读 ${readProvider === '' ? '（空）' : readProvider}`)
  }

  const sentTable = asTable(outbound.perProject)
  const readTable = asTable(inbound.perProject)
  const keys = [...new Set([...Object.keys(sentTable), ...Object.keys(readTable)])].sort()
  const changed = keys.filter(key => asText(sentTable[key]) !== asText(readTable[key]))
  if (changed.length > 0) {
    const detail = changed
      .map(key => `${key} 提交 ${asText(sentTable[key]) === '' ? '（无）' : asText(sentTable[key])} / 回读 ${asText(readTable[key]) === '' ? '（无）' : asText(readTable[key])}`)
      .join('；')
    diffs.push('perProject：' + detail)
  }

  const sentSink = asTable(outbound.weknora)
  const readSink = asTable(inbound.weknora)
  for (const field of ['baseUrl', 'tenantId', 'knowledgeBaseId']) {
    if (asText(sentSink[field]) !== asText(readSink[field])) {
      diffs.push(`weknora.${field}：提交 ${asText(sentSink[field]) === '' ? '（空）' : asText(sentSink[field])} / 回读 ${asText(readSink[field]) === '' ? '（空）' : asText(readSink[field])}`)
    }
  }
  if (asText(readSink.apiKey) !== '') diffs.push('weknora.apiKey：回读不应带明文')
  const expectSet = apiKeySetBefore === true || asText(sentSink.apiKey) !== ''
  if (inbound.weknora === undefined || readSink.apiKeySet !== expectSet) {
    diffs.push(`weknora.apiKeySet：期望 ${expectSet} / 回读 ${String(readSink.apiKeySet)}`)
  }
  return diffs
}
