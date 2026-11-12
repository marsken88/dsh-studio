/* Page-level components lifted out of client.src.js; shared handles come from the studio context. */

import { client } from './context.js'

export function ProgressField({ value, tone }) {
  const { h, kit } = client()
  const Bar = kit('ProgressBar')
  const pctValue = Math.max(0, Math.min(100, Number(value) || 0))
  if (Bar !== null) return h(Bar, { value: pctValue, tone })
  const color = tone === 'over' ? '#e5484d' : tone === 'warn' ? '#d97706' : undefined
  return h('div', { className: 'ds-an-track' }, h('div', { className: 'ds-an-fill', style: { width: `${pctValue}%`, background: color } }))
}

export function BurnChart({ series }) {
  const { h, kit } = client()
  const points = Array.isArray(series) ? series : []
  if (points.length === 0) return h('div', { className: 'ds-empty' }, '还没有数据。')
  const values = points.map(item => Math.max(0, Number(item.remaining) || 0))
  const max = Math.max(1, ...values)
  const step = points.length === 1 ? 100 : 100 / (points.length - 1)
  const coords = points.map((item, index) => ({
    x: index * step,
    y: 38 - (values[index] / max) * 32,
    remaining: values[index],
    day: String(item.day ?? ''),
  }))
  const line = coords.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')
  const area = `${line} L100,40 L0,40 Z`
  return h('div', { className: 'ds-burn' },
    h('svg', { viewBox: '0 0 100 40', preserveAspectRatio: 'none', className: 'ds-burn-svg', role: 'img', 'aria-label': '燃尽趋势' },
      h('path', { d: area, className: 'ds-burn-area' }),
      h('path', { d: line, className: 'ds-burn-line', vectorEffect: 'non-scaling-stroke' }),
      coords.map(point => h('circle', { key: point.day, cx: point.x, cy: point.y, r: 1.1, className: 'ds-burn-dot' },
        h('title', {}, `${point.day}：还剩 ${point.remaining} 张`))),
    ),
    h('div', { className: 'ds-burn-axis' },
      h('span', {}, coords[0].day),
      h('span', {}, coords[coords.length - 1].day),
    ),
  )
}
