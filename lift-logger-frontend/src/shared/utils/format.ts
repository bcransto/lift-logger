// Display formatters.

const MS_PER_MIN = 60_000
const MS_PER_HOUR = 60 * MS_PER_MIN
const MS_PER_DAY = 24 * MS_PER_HOUR

export function relativeDate(ts: number | null | undefined, now: number = Date.now()): string {
  if (!ts) return 'NEW'
  const diff = now - ts
  if (diff < MS_PER_HOUR) {
    const mins = Math.max(1, Math.round(diff / MS_PER_MIN))
    return `${mins}m ago`
  }
  if (diff < MS_PER_DAY) return `${Math.round(diff / MS_PER_HOUR)}h ago`
  if (diff < 7 * MS_PER_DAY) return `${Math.round(diff / MS_PER_DAY)}d ago`
  if (diff < 30 * MS_PER_DAY) return `${Math.round(diff / (7 * MS_PER_DAY))}w ago`
  if (diff < 365 * MS_PER_DAY) return `${Math.round(diff / (30 * MS_PER_DAY))}mo ago`
  return `${Math.round(diff / (365 * MS_PER_DAY))}y ago`
}

export function mmss(totalSec: number): string {
  if (totalSec < 0) totalSec = 0
  const m = Math.floor(totalSec / 60)
  const s = Math.floor(totalSec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function dowShort(ts: number = Date.now()): string {
  const d = new Date(ts)
  return ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][d.getDay()]
}

export function monShort(ts: number = Date.now()): string {
  const d = new Date(ts)
  return ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][d.getMonth()]
}

export function timeShort(ts: number = Date.now()): string {
  const d = new Date(ts)
  const h = d.getHours()
  const m = d.getMinutes()
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`
}

export function formatWeight(w: number | null | undefined, unit = 'lb'): string {
  if (w === null || w === undefined) return '—'
  // Drop trailing .0 if integer; keep up to 1 decimal otherwise.
  const s = Number.isInteger(w) ? w.toString() : w.toFixed(1).replace(/\.0$/, '')
  return `${s} ${unit}`
}

export function parseJsonArray<T = string>(s: string | null | undefined): T[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}
