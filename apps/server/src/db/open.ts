import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { migrate } from './migrate'

const MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url))

/** Opens (creating if needed) `dataDir/whiteboard.db` with the house pragmas and runs pending migrations. */
export function openDatabase(o: {
  dataDir: string
  migrationsDir?: string
}): Database.Database {
  mkdirSync(o.dataDir, { recursive: true })
  const db = new Database(join(o.dataDir, 'whiteboard.db'))
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')
    db.pragma('temp_store = MEMORY')
    migrate(db, o.migrationsDir ?? MIGRATIONS, {
      backupDir: join(o.dataDir, 'backups'),
    })
    return db
  } catch (e) {
    db.close()
    throw e
  }
}
