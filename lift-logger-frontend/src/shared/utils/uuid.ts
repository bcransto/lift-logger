// Generate a short, URL-safe unique ID. Not cryptographically strong;
// fine for a single-user local-first app where IDs need to survive sync.

export function uuid(prefix = ''): string {
  const rand = Math.random().toString(36).slice(2, 10)
  const ts = Date.now().toString(36)
  return prefix ? `${prefix}_${ts}${rand}` : `${ts}${rand}`
}
