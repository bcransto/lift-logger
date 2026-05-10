// Hard-delete a completed session.
//
// Flow:
//   1. POST /api/sessions/:id/delete — server hard-deletes the row + its
//      session_sets and recomputes exercise_prs for every touched exercise.
//   2. Locally drop the same rows from Dexie (sync is upsert-only LWW; it
//      doesn't carry deletes).
//   3. Trigger a sync pull so the recomputed exercise_prs rows land in Dexie.
//
// On non-2xx the helper throws with the response body as the error message —
// callers should catch and surface it. The 409 case ("cannot delete active
// session") is the most common, but the UI already gates on completed sessions
// so it shouldn't normally fire.

import { db } from '../../db/db'
import { syncService } from '../../sync/syncService'

export async function deleteSession(sessionId: string): Promise<void> {
  const r = await fetch(`/api/sessions/${sessionId}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(body || `delete failed: http ${r.status}`)
  }
  await db.sessions.delete(sessionId)
  await db.session_sets.where('session_id').equals(sessionId).delete()
  // Best-effort pull to refresh recomputed exercise_prs rows. Don't block on
  // it — the local-row cleanup above is enough for the UI to update.
  void syncService.sync()
}
