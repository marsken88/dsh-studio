// 事件总线：平台内部发生的事，外面也应该能知道（CI 触发、IM 通知、工单同步）。
// 订阅者可以注册任意多个；一个订阅者抛错不影响其它订阅者，也不影响主流程。
const subscribers = []

/** 订阅：返回取消订阅的函数。 */
export function subscribe(handler) {
  if (typeof handler !== 'function') throw new Error('subscribe 需要函数')
  subscribers.push(handler)
  return () => {
    const at = subscribers.indexOf(handler)
    if (at >= 0) subscribers.splice(at, 1)
  }
}

/** 发事件：同步扇出，异常吞掉（订阅者的失败不该影响正在写库的请求）。 */
export function emitEvent(type, payload = {}) {
  const event = { type: String(type), at: Date.now(), payload }
  for (const handler of subscribers) {
    try { handler(event) } catch { /* 订阅者自己的事 */ }
  }
  return event
}

export function subscriberCount() {
  return subscribers.length
}
