// webhook 订阅者：把事件 POST 给配置里的地址。失败只记健康，不重试、不阻塞。
import { emitEvent, subscribe } from './events.js'

export const WEBHOOK_EVENTS = ['task/moved', 'case/failed', 'agent/failed']

export function sanitizeWebhooks(raw) {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 20).map((item, index) => {
    const source = item !== null && typeof item === 'object' ? item : {}
    const url = String(source.url ?? '').trim().slice(0, 500)
    const events = (Array.isArray(source.events) ? source.events : []).map(String).filter(name => WEBHOOK_EVENTS.includes(name))
    return {
      id: String(source.id ?? '').trim().slice(0, 40) || 'hook-' + (index + 1),
      url,
      events: events.length > 0 ? events : [...WEBHOOK_EVENTS],
      enabled: source.enabled !== false,
    }
  }).filter(hook => hook.url !== '')
}

/** 真正发出去：每个订阅地址一次 POST，5 秒超时。 */
export async function deliverWebhooks(config, event) {
  const hooks = (config?.webhooks ?? []).filter(hook => hook.enabled !== false && (hook.events ?? []).includes(event.type))
  for (const hook of hooks) {
    try {
      await fetch(hook.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(5000),
      })
    } catch {
      /* 外网/内网抖动是常态；事件本身已经进了台账，不在这里重试 */
    }
  }
}

/** 进程内接上：事件 → webhook。返回取消订阅函数。 */
export function attachWebhooks(store) {
  return subscribe(event => {
    void deliverWebhooks(store?.snapshot?.()?.config, event)
  })
}

export { emitEvent }
