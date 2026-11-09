// Pure: time formatting for the pane. No engine calls.

/**
 * "resets in 2h 14m" style text from an ISO reset time and `now` (ms).
 * Under an hour: minutes. Under a day: hours and minutes. Otherwise days and hours.
 */
export function resetIn(iso: string | null, now: number): string | null {
  if (!iso) return null
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return null
  const mins = Math.ceil((at - now) / 60_000)
  if (mins <= 0) return 'resetting now'
  if (mins < 60) return `resets in ${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 24) return `resets in ${h}h ${mins % 60}m`
  return `resets in ${Math.floor(h / 24)}d ${h % 24}h`
}
