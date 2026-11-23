/* 专家会话的「执行播报」：把派单会话里发生的事，边跑边写成卡上的评论。
 *
 * 为什么要这个：以前只有专家**主动**调 studio_task_comment 才看得到东西；
 * 它闷头跑十几分钟、或者在等审批，卡上一条都没有，人只能干等（真机踩过：
 * 架构师会话卡在 plugin_manager 提权审批上，界面显示「正在跑」，评论里一片空白）。
 *
 * 现在把宿主的 session/event 汇成一条条「执行中」评论：
 *   思考（reasoning 摘要）· 回复（text）· 工具（name）· 实际模型（provider/model）
 *
 * 两条硬要求：
 *   1. **节流**：按 step 攒、满 N 毫秒才发一条，避免一次派单刷出上百条评论。
 *   2. **实际模型要写出来**：设置里配的是 flash，实际请求用的哪个型号，
 *      只有 assistant/message 的 source 说得清——写进评论就不必再猜。
 */

/** 会话名是 `studio-<taskId>-<expertId>`：拆出卡与专家，拆不出就不是派单会话。 */
export function parseStudioSession(sessionId) {
  const text = String(sessionId ?? '')
  if (!text.startsWith('studio-')) return null
  const body = text.slice('studio-'.length)
  /* 任务 id 恒为 t-<8位hex>，专家 id 可能自带连字符（expert-2d22ad）。
     以前用 lastIndexOf('-') 切，会把 studio-t-x-expert-2d22ad 解析成
     taskId=t-x-expert / expertId=2d22ad —— 派单会话认错卡（issue #127）。 */
  const matched = /^(t-[0-9a-zA-Z]+)-(.+)$/.exec(body)
  if (matched !== null) return { taskId: matched[1], expertId: matched[2] }
  // 兜底：兼容不带 t- 前缀的老会话（studio-<taskId>-<expertId>）
  const dash = body.lastIndexOf('-')
  if (dash <= 0) return null
  const taskId = body.slice(0, dash)
  const expertId = body.slice(dash + 1)
  if (taskId === '' || expertId === '') return null
  return { taskId, expertId }
}

/** 从 assistant/message 的内容块里抽出这一轮的思考与回复。 */
export function readAssistantMessage(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const texts = []
  const reasonings = []
  const tools = []
  for (const block of blocks) {
    if (block?.type === 'text' && String(block.text ?? '').trim() !== '') texts.push(String(block.text).trim())
    else if (block?.type === 'reasoning' && String(block.text ?? '').trim() !== '') reasonings.push(String(block.text).trim())
    else if (block?.type === 'tool-call' && String(block.name ?? '') !== '') tools.push(String(block.name))
  }
  const source = message?.source ?? {}
  const model = String(source.model ?? '')
  const provider = String(source.provider ?? '')
  return { texts, reasonings, tools, model, provider }
}

const clip = (text, max) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/** 攒够的内容拼成一条评论正文；没有实质内容返回空串（调用方据此跳过）。 */
export function feedBody(buffer, options = {}) {
  const reasoningMax = Number(options.reasoningMax ?? 240)
  const textMax = Number(options.textMax ?? 600)
  const toolsMax = Number(options.toolsMax ?? 10)
  /* 只有模型名不算内容：否则「上一次播报留下的 model」会让 take() 每次都吐一条空播报。 */
  const hasSubstance = (buffer?.texts ?? []).filter(Boolean).length > 0
    || (buffer?.reasonings ?? []).filter(Boolean).length > 0
    || (buffer?.tools ?? []).filter(Boolean).length > 0
  if (hasSubstance === false) return ''
  const parts = []
  const reasoning = (buffer?.reasonings ?? []).filter(Boolean)
  if (reasoning.length > 0) parts.push(`> 思考：${clip(reasoning[reasoning.length - 1], reasoningMax)}`)
  const texts = (buffer?.texts ?? []).filter(Boolean)
  if (texts.length > 0) parts.push(clip(texts[texts.length - 1], textMax))
  const tools = [...new Set((buffer?.tools ?? []).filter(Boolean))]
  const meta = []
  if (tools.length > 0) meta.push(`工具：${tools.slice(0, toolsMax).join(' · ')}${tools.length > toolsMax ? ` 等 ${tools.length} 个` : ''}`)
  const model = String(buffer?.model ?? '').trim()
  if (model !== '') meta.push(`模型：${buffer?.provider ? `${buffer.provider}/` : ''}${model}`)
  if (meta.length > 0) parts.push(`<sub>${meta.join(' ｜ ')}</sub>`)
  if (parts.length === 0) return ''
  return `${parts.join('\n\n')}\n\n<sub>（派单会话自动播报${options.final === true ? ' · 本轮结束' : ''}）</sub>`
}

/** 节流：距离上次播报不足 minMs 就先攒着；除非是本轮结束（强制发）。 */
export function shouldFlush(buffer, now, options = {}) {
  const minMs = Number(options.minMs ?? 15000)
  const hasContent = (buffer?.texts ?? []).length > 0 || (buffer?.reasonings ?? []).length > 0
    || (buffer?.tools ?? []).length > 0 || String(buffer?.model ?? '') !== ''
  if (hasContent === false) return false
  if (options.final === true) return true
  const last = Number(buffer?.lastFlush ?? 0)
  return now - last >= minMs
}

/**
 * 提权审批写进评论的说明。mode 来自设置（见 src/host/escalation.js）：
 *   allow = 平台自动批准（等于始终允许完全访问）；deny = 平台自动拒绝。
 * 两种都写清「发生了什么、去哪儿改」，因为卡上的评论是唯一能让人事后追责的痕迹。
 */
export function approvalNote(req, mode = 'deny') {
  const tool = String(req?.toolName ?? '未知工具')
  const reason = String(req?.reason ?? '').trim()
  if (mode === 'allow') {
    return [
      `「${tool}」需要提权，派单会话已自动批准（设置 → 自动派单 → 提权审批 = 自动批准）。`,
      reason === '' ? '' : `请求理由：${clip(reason, 160)}`,
      '这一步是真的放行了：它可能写到了工作区之外。不想放行就把「提权审批」改成自动拒绝，或者把沙箱档位调窄。',
    ].filter(Boolean).join('\n\n')
  }
  return [
    `「${tool}」需要提权，派单会话里已自动拒绝——派单跑在沙箱里，提权审批没有人实时盯着，等下去只会把整轮挂死（真机踩过：架构师会话卡在 plugin_manager 审批上三小时）。`,
    reason === '' ? '' : `请求理由：${clip(reason, 160)}`,
    '要放行就把「设置 → 自动派单 → 提权审批」改成自动批准（等于始终允许完全访问），或者把沙箱档位调宽；也可以人在面板上手动跑这一次。',
  ].filter(Boolean).join('\n\n')
}

/**
 * 内存里的播报缓冲：一个会话一个桶。纯数据操作，不碰 IO，方便单测。
 *   push(sessionId, event) → 收事件
 *   take(sessionId, now, { final }) → 该发的正文（发不发由 shouldFlush 决定）
 */
export function createFeedBuffer(patch = () => {}) {
  const buckets = new Map()
  const bucketOf = (sessionId, meta) => {
    let bucket = buckets.get(sessionId)
    if (bucket === undefined) {
      // 新建桶就把 lastFlush 记成「现在」：否则第一条事件会立刻触发一次播报（节流形同虚设）
      bucket = { taskId: meta?.taskId ?? '', expertId: meta?.expertId ?? '', texts: [], reasonings: [], tools: [], model: '', provider: '', lastFlush: Date.now(), seen: 0 }
      buckets.set(sessionId, bucket)
    }
    return bucket
  }
  return {
    push(sessionId, event, meta) {
      const bucket = bucketOf(sessionId, meta)
      const type = String(event?.type ?? '')
      if (type === 'assistant/message') {
        const read = readAssistantMessage(event.data?.message)
        bucket.texts.push(...read.texts)
        bucket.reasonings.push(...read.reasonings)
        bucket.tools.push(...read.tools)
        if (read.model !== '') { bucket.model = read.model; bucket.provider = read.provider }
        bucket.seen += 1
      } else if (type === 'tool/call') {
        if (String(event.data?.name ?? '') !== '') bucket.tools.push(String(event.data.name))
        bucket.seen += 1
      } else if (type === 'turn/end') {
        // 本轮结束：不管节流，立刻把攒的内容发出去（带「本轮结束」标记）
        const final = this.take(sessionId, Date.now(), { final: true })
        if (final !== null) patch(sessionId, final)
      }
      // 太久没发的话，push 阶段就顺带发（由调用方的 patch 决定怎么落库）
      if (shouldFlush(bucket, Date.now())) patch(sessionId, this.take(sessionId, Date.now()))
    },
    take(sessionId, now, options = {}) {
      const bucket = buckets.get(sessionId)
      if (bucket === undefined) return null
      const body = feedBody(bucket, { final: options.final === true })
      if (body === '') return null
      const snapshot = { taskId: bucket.taskId, expertId: bucket.expertId, body }
      bucket.texts = []
      bucket.reasonings = []
      bucket.tools = []
      bucket.lastFlush = now
      bucket.seen = 0
      return snapshot
    },
    /** 定时器用：把所有攒够的会话都发掉。 */
    flushAll(now) {
      for (const sessionId of buckets.keys()) {
        const bucket = buckets.get(sessionId)
        if (shouldFlush(bucket, now) === false) continue
        const snapshot = this.take(sessionId, now)
        if (snapshot !== null) patch(sessionId, snapshot)
      }
    },
    sessions() { return [...buckets.keys()] },
    pending(sessionId) {
      const bucket = buckets.get(sessionId)
      if (bucket === undefined) return false
      return shouldFlush(bucket, Date.now()) || bucket.texts.length > 0 || bucket.reasonings.length > 0
    },
    modelOf(sessionId) {
      const bucket = buckets.get(sessionId)
      if (bucket === undefined) return ''
      return bucket.model === '' ? '' : `${bucket.provider === '' ? '' : `${bucket.provider}/`}${bucket.model}`
    },
    drop(sessionId) { buckets.delete(sessionId) },
    size() { return buckets.size },
  }
}
