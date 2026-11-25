/* 评审备注里的 @ 提及：让「评审不通过 → @开发去改」这条路真的能把人叫起来。
 *
 * 真机踩到：在代码评审 / 设计评审的备注里写 `@开发工程师 这里要改`，界面显示评审结论
 * 落库了，但**没有人被派单**——因为只有 `/task/comment` 会解析 @，评审备注走的是
 * `/task/coding` 与 `/task/design`，那两条路以前只看结论，不看待办。
 *
 * 这里提供两件事：
 *   stripQuotedCode  把代码块与行内代码里的 @ 去掉（引用别人写的 @架构师 不该再派一轮）
 *   publishNoteMentions  把这条备注补成评论（评审意见要能在讨论区看到），再逐个派单
 */

/** 去掉 ``` 围栏代码块与 `行内代码`：里面的 @名字 只是引用，不是真的点名。 */
export function stripQuotedCode(body) {
  const text = String(body ?? '')
  // 先去掉围栏代码块（含未闭合的：写到一半就发出去也不该触发）
  const withoutFences = text.replace(/```[\s\S]*?(?:```|$)/g, ' ')
  // 再去掉行内代码
  return withoutFences.replace(/`[^`\n]*`/g, ' ')
}

/**
 * 评审备注 → 评论 + 派单。
 * deps 由调用方注入（store / commentTask / dispatcher / parseMentions），避免这里反向依赖 dispatcher。
 * 返回 { mentions, dispatched, commented }，方便路由把结果回给调用方。
 */
export async function publishNoteMentions(deps, options = {}) {
  const { store, commentTask, dispatcher, parseMentions } = deps
  const taskId = String(options.taskId ?? '')
  const note = String(options.note ?? '').trim()
  const by = String(options.by ?? '人').slice(0, 40)
  /* forceComment：评审结论必须留下痕迹——哪怕备注为空，或备注里没写「评审 / 打回 / 要改」
     这些词。以前只按关键词猜，于是「LGTM，可以进测试」这种通过结论永远不进讨论区，
     人翻卡片时只看到研发说了什么，看不到评审说了什么。 */
  const forceComment = options.forceComment === true
  const verdict = String(options.verdict ?? '').trim().slice(0, 20)
  if (taskId === '' || typeof parseMentions !== 'function') {
    return { mentions: [], dispatched: [], commented: false }
  }
  if (note === '' && forceComment === false) {
    return { mentions: [], dispatched: [], commented: false }
  }
  const config = store.snapshot().config
  const mentions = note === '' ? [] : parseMentions(note, config)
  const looksLikeReview = /评审|驳回|打回|要改|不通过/.test(note) || mentions.length > 0
  if (forceComment === false && looksLikeReview === false) return { mentions: [], dispatched: [], commented: false }
  /* 评审意见要能在讨论区看到：以前它只躺在 coding.review.note 里，对方读卡时看不到。
     commentMode='mentions' 时只在有人被 @ 的情况才补评论（验收签字 / 清单备注这类
     本来就会显示在卡上的文字，不必每条都复制成评论）。 */
  const commentMode = String(options.commentMode ?? 'always')
  const shouldComment = forceComment === true ? true : (commentMode === 'mentions' ? mentions.length > 0 : true)
  let commented = false
  if (shouldComment && typeof commentTask === 'function') {
    try {
      const label = String(options.label ?? '评审意见')
      const title = `${label}${verdict === '' ? '' : ` · ${verdict}`}（${by}）`
      await commentTask(store, taskId, `**${title}**\n\n${note === '' ? '（没有填写评审意见）' : note}`, by, 'human')
      commented = true
    } catch { /* 留言失败不影响评审结论本身 */ }
  }
  const dispatched = []
  if (dispatcher !== undefined && mentions.length > 0) {
    for (const mention of mentions) {
      try {
        await dispatcher.dispatchMention(taskId, mention, note)
        dispatched.push(`${mention.kind}:${mention.id}`)
      } catch (error) {
        dispatched.push(`${mention.kind}:${mention.id} failed: ${String(error?.message ?? error).slice(0, 120)}`)
      }
    }
  }
  return { mentions, dispatched, commented }
}
