import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'

const FILE = /^(\d{4})_[\w-]+\.sql$/

/**
 * Applies every migration newer than `PRAGMA user_version`, each in its own transaction (a failing one changes nothing).
 * Forward-only. An existing database is copied to `backupDir/pre-migrate-<version>.db` before the first pending one runs.
 */
export function migrate(
  db: Database.Database,
  dir: string,
  o: { backupDir: string },
): { from: number; to: number } {
  const files = readdirSync(dir)
    .flatMap((name) => {
      const m = FILE.exec(name)
      return m ? [{ name, version: Number(m[1]) }] : []
    })
    .sort((a, b) => a.version - b.version)
  const latest = files.at(-1)?.version ?? 0
  const from = db.pragma('user_version', { simple: true }) as number
  if (from > latest)
    throw new Error(
      `database is at version ${from}, newer than the newest known migration ${latest}`,
    )
  const pending = files.filter((f) => f.version > from)
  if (pending.length === 0) return { from, to: from }

  if (from > 0) {
    mkdirSync(o.backupDir, { recursive: true })
    const backup = join(o.backupDir, `pre-migrate-${from}.db`)
    rmSync(backup, { force: true }) // VACUUM INTO refuses to overwrite
    db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`)
  }
  for (const f of pending) {
    const sql = readFileSync(join(dir, f.name), 'utf8')
    db.transaction(() => {
      db.exec(sql)
      db.pragma(`user_version = ${f.version}`)
    })()
  }
  return { from, to: latest }
}
