// Generate a prefixed ID matching MCP's `<prefix>_<random>` shape.
//
// Mirrors `lift-logger-mcp/db.js` `genId(prefix)`. The MCP version uses
// `${Date.now()}_${crypto.randomBytes(4).toString('hex')}` for the random
// part; on the frontend `crypto.randomUUID()` is the simpler equivalent
// (browsers expose it natively, no Node-only `crypto.randomBytes`).

export function genId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}
