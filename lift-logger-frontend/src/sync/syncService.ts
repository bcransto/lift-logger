// SyncService — push then pull against POST /api/sync in one request.
//
// Until the backend is live, USE_MOCK_SYNC dispatches through mockSyncCall
// and returns the same response shape. Flip the env var to go live.

import { db } from '../db/db'
import type { IronDb } from '../db/schema'
import type {
  SyncRequest,
  SyncResponse,
  SyncTable,
  SyncTablePayload,
} from '../types/schema'
import { mockSyncCall } from './mockServer'

const USE_MOCK_SYNC = (import.meta.env.VITE_USE_MOCK_SYNC ?? 'true') !== 'false'

// Tables pushed by the client. `exercise_prs` is read-only on the client.
const PUSH_TABLES: SyncTable[] = [
  'exercises',
  'workouts',
  'workout_blocks',
  'block_exercises',
  'block_exercise_sets',
  'sessions',
  'session_sets',
]

const ALL_TABLES: SyncTable[] = [...PUSH_TABLES, 'exercise_prs']

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline'

type Listener = (s: { status: SyncStatus; lastSync: number | null; error: string | undefined }) => void

export class SyncService {
  private status: SyncStatus = 'idle'
  private lastSync: number | null = null
  private error: string | undefined
  private listeners = new Set<Listener>()
  private busy = false
  private dbRef: IronDb = db

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    fn({ status: this.status, lastSync: this.lastSync, error: this.error })
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit() {
    for (const fn of this.listeners) {
      fn({ status: this.status, lastSync: this.lastSync, error: this.error })
    }
  }

  private setStatus(next: SyncStatus, error?: string) {
    this.status = next
    this.error = error
    this.emit()
  }

  getStatus() {
    return { status: this.status, lastSync: this.lastSync, error: this.error }
  }

  async sync(): Promise<void> {
    if (this.busy) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.setStatus('offline')
      return
    }
    this.busy = true
    this.setStatus('syncing')
    try {
      const req = await this.buildRequest()
      const res = await this.transport(req)
      await this.applyResponse(res)
      this.lastSync = Date.now()
      this.setStatus('idle')
    } catch (e) {
      this.setStatus('error', e instanceof Error ? e.message : String(e))
    } finally {
      this.busy = false
    }
  }

  // Build a payload containing per-table lastSync + locally changed rows.
  private async buildRequest(): Promise<SyncRequest> {
    const tables: SyncRequest['tables'] = {}
    for (const name of ALL_TABLES) {
      const meta = await this.dbRef.sync_meta.get(name)
      const lastSync = meta?.lastSync ?? 0
      const changes = PUSH_TABLES.includes(name)
        ? await (this.dbRef as unknown as Record<string, { where: (i: string) => { above: (n: number) => { toArray: () => Promise<unknown[]> } } }>)[name]!
            .where('updated_at')
            .above(lastSync)
            .toArray()
        : []
      ;(tables as Record<string, SyncTablePayload<unknown>>)[name] = { lastSync, changes }
    }
    return { tables }
  }

  private async transport(req: SyncRequest): Promise<SyncResponse> {
    if (USE_MOCK_SYNC) {
      return mockSyncCall(req)
    }
    const r = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    })
    if (!r.ok) throw new Error(`sync http ${r.status}`)
    return (await r.json()) as SyncResponse
  }

  // LWW-apply server rows, then persist syncTimestamp per table.
  private async applyResponse(res: SyncResponse): Promise<void> {
    const upserts: Promise<unknown>[] = []
    const metas: { table: SyncTable; lastSync: number }[] = []
    for (const name of ALL_TABLES) {
      const resp = (res.tables as Record<string, { syncTimestamp: number; changes: unknown[] } | undefined>)[name]
      if (!resp) continue
      metas.push({ table: name, lastSync: resp.syncTimestamp })
      if (resp.changes?.length) {
        const table = (this.dbRef as unknown as Record<string, {
          get: (k: string) => Promise<{ updated_at: number } | undefined>
          put: (v: unknown) => Promise<unknown>
        }>)[name]!
        for (const incoming of resp.changes as { id: string; updated_at: number }[]) {
          upserts.push(
            (async () => {
              const existing = await table.get(incoming.id)
              if (!existing || incoming.updated_at > existing.updated_at) {
                await table.put(incoming)
              }
            })(),
          )
        }
      }
    }
    await Promise.all(upserts)
    await this.dbRef.sync_meta.bulkPut(metas)
  }
}

export const syncService = new SyncService()
