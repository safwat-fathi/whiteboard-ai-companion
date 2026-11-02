import type Database from 'better-sqlite3'

export type BlobRow = {
  id: string
  mime: string
  bytes: number
  createdAt: number
}
export type BlobsDb = ReturnType<typeof createBlobsDb>

/** The `blobs` table: one row per content hash. */
export function createBlobsDb(db: Database.Database) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO blobs (id, mime, bytes, created_at) VALUES (?, ?, ?, ?)',
  )
  const select = db.prepare(
    'SELECT id, mime, bytes, created_at FROM blobs WHERE id = ?',
  )
  return {
    /** Idempotent: a second insert of the same id changes nothing. */
    insert: (b: BlobRow): void =>
      void insert.run(b.id, b.mime, b.bytes, b.createdAt),
    get(id: string): BlobRow | undefined {
      const r = select.get(id) as
        | { id: string; mime: string; bytes: number; created_at: number }
        | undefined
      return (
        r && { id: r.id, mime: r.mime, bytes: r.bytes, createdAt: r.created_at }
      )
    },
  }
}
