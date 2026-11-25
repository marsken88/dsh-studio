/* Small date formatters shared by every list in the panel. */

export function fmtTime(value) {
  if (typeof value !== 'number' || value === 0) return '—'
  const date = new Date(value)
  const pad = n => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function fmtDate(value) {
  if (typeof value !== 'number' || value === 0) return '—'
  const date = new Date(value)
  const pad = n => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

