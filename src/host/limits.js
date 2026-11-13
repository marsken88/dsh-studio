// 数量上限：以前散在路由里硬编码（60 / 60 / 40），超了静默丢数据。
// 拆出来一是可配置，二是不把 domain.js 撑过 2000 行闸门。

export const LIMIT_DEFAULTS = { casesPerTask: 60, runKeys: 60, artifactsPerTask: 40 }

export function sanitizeLimits(raw) {
  const base = { casesPerTask: 60, runKeys: 60, artifactsPerTask: 40 }
  if (raw === null || typeof raw !== 'object') return base
  const pick = (value, fallback, max) => {
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0) return fallback
    return Math.min(max, Math.max(1, Math.round(number)))
  }
  return {
    casesPerTask: pick(raw.casesPerTask, base.casesPerTask, 500),
    runKeys: pick(raw.runKeys, base.runKeys, 500),
    artifactsPerTask: pick(raw.artifactsPerTask, base.artifactsPerTask, 500),
  }
}
