/**
 * 交付物归档提示（REQ-2026-003 p3 / c-copy）。
 *
 * 以前的提示写死「飞书云盘」，出口切成 weknora 后就在骗人（PRD R8）。
 * 这里按实际出口说话：weknora 的提示**不含「飞书」**；both 成功时同时点名（飞书是主）；
 * both 且 WeKnora 失败时仍然是「飞书成功」，但要把知识库的失败原因说出来。
 *
 * 零依赖纯函数：tests/client-units.test.mjs 直接断言字符串，不依赖 DOM。
 */
const KNOWN = ['feishu', 'weknora', 'both']
const FEISHU_LABEL = '飞书云盘'
const WEKNORA_LABEL = 'WeKnora 知识库'
const clip = (value, max = 120) => {
  const text = String(value ?? '').trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** 出口未知/缺省一律按 feishu：老数据（只有 doc.token/url）本来就是飞书。 */
function providerOf(doc) {
  const value = doc !== null && typeof doc === 'object' ? doc.provider : ''
  return KNOWN.includes(value) ? value : 'feishu'
}

/** 登记后、还不知道生效出口时的临时提示：此时不许先喊飞书。 */
export function archivePendingNotice() {
  return '已登记，正在归档交付物…'
}

/** 成功/部分成功提示。doc 是 syncArtifact 的返回（provider/primary/sinks/url/error）。 */
export function archiveNotice(doc, { verb = '已归档' } = {}) {
  const provider = providerOf(doc)
  const url = typeof doc?.url === 'string' ? doc.url.trim() : ''
  const target = url === '' ? '' : `：${url}`
  if (provider === 'weknora') return `${verb}到 ${WEKNORA_LABEL}${target}`
  if (provider === 'feishu') return `${verb}到${FEISHU_LABEL}${target}`
  /* both：飞书是主出口，它成功了就算归档成功；WeKnora 那份单独说，别让人以为两边都有。 */
  const weknora = doc?.sinks?.weknora ?? {}
  if (weknora.ok === true) {
    const weknoraUrl = typeof weknora.url === 'string' ? weknora.url.trim() : ''
    const extra = weknoraUrl === '' || weknoraUrl === url ? '' : `；${WEKNORA_LABEL}：${weknoraUrl}`
    return `${verb}到${FEISHU_LABEL}（主）与 ${WEKNORA_LABEL}${target}${extra}`
  }
  const reason = clip(weknora.error === '' || weknora.error === undefined ? '未知原因' : weknora.error)
  return `${verb}到${FEISHU_LABEL}（主）${target}；${WEKNORA_LABEL}未写入：${reason}`
}

/** 失败提示：both 的主出口（飞书）失败时也要点名，并给出原因（≤120 字）。 */
export function archiveFailureNotice(provider, error) {
  const reason = clip(error === '' || error === undefined || error === null ? '未知原因' : error)
  if (provider === 'weknora') return `归档失败（${WEKNORA_LABEL}）：${reason}`
  if (provider === 'both') return `归档失败（${FEISHU_LABEL}为主出口）：${reason}`
  return `归档失败（${FEISHU_LABEL}）：${reason}`
}
