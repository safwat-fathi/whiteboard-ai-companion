import type Database from 'better-sqlite3'

export type SettingsDb = ReturnType<typeof createSettingsDb>

/** Key/value rows: the student profile, budget override, per-board memory summaries. */
export function createSettingsDb(db: Database.Database) {
  const sel = db.prepare('SELECT value FROM settings WHERE key = ?')
  const put = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  )
  const del = db.prepare('DELETE FROM settings WHERE key = ?')
  return {
    get: (key: string): string | undefined =>
      (sel.get(key) as { value: string } | undefined)?.value,
    set: (key: string, value: string): void => void put.run(key, value),
    delete: (key: string): void => void del.run(key),
  }
}
