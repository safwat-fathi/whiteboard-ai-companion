import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from './index'

const realMigrations = fileURLToPath(
  new URL('../../migrations/', import.meta.url),
)
const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wb-server-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const version = (db: Database.Database) =>
  db.pragma('user_version', { simple: true })
const tables = (db: Database.Database) =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string
    }[]
  ).map((r) => r.name)

/** A migrations dir holding the real migrations up to `upTo` plus the given extra files. */
function migrationsWith(extra: Record<string, string>, upTo = 3) {
  const dir = join(tmp(), 'migrations')
  mkdirSync(dir)
  for (const name of readdirSync(realMigrations))
    if (Number(name.slice(0, 4)) <= upTo)
      cpSync(join(realMigrations, name), join(dir, name))
  for (const [name, sql] of Object.entries(extra))
    writeFileSync(join(dir, name), sql)
  return dir
}

describe('openDatabase and migrations', () => {
  it('creates every table at user_version 3 with the pragmas set', () => {
    const dataDir = join(tmp(), 'data')
    const db = openDatabase({ dataDir })
    expect(version(db)).toBe(3)
    expect(tables(db)).toEqual(
      expect.arrayContaining([
        'boards',
        'board_ops',
        'board_snapshots',
        'blobs',
        'books',
        'book_sections',
        'book_pages',
        'book_chunks',
        'book_chunks_fts',
        'messages',
        'settings',
        'spend',
      ]),
    )
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
    db.close()
  })

  it('is a no-op the second time and makes no backup', () => {
    const dataDir = join(tmp(), 'data')
    openDatabase({ dataDir }).close()
    const db = openDatabase({ dataDir })
    expect(version(db)).toBe(3)
    expect(existsSync(join(dataDir, 'backups'))).toBe(false)
    db.close()
  })

  it('keeps the FTS index in step with book_chunks (insert, update, delete)', () => {
    const db = openDatabase({ dataDir: join(tmp(), 'data') })
    db.prepare("INSERT INTO blobs VALUES ('b1','application/pdf',1,0)").run()
    db.prepare(
      "INSERT INTO books (id,title,file_blob,status,created_at) VALUES ('k1','T','b1','ready',0)",
    ).run()
    const id = db
      .prepare(
        "INSERT INTO book_chunks (book_id,ord,cite_label,heading_path,text,text_norm,tokens) VALUES ('k1',0,'p. 1','H','Photosynthesis','photosynthesis',1)",
      )
      .run().lastInsertRowid
    const hits = (q: string) =>
      db
        .prepare(
          'SELECT rowid FROM book_chunks_fts WHERE book_chunks_fts MATCH ?',
        )
        .all(q).length
    expect(hits('photosynthesis')).toBe(1)
    db.prepare(
      "UPDATE book_chunks SET text_norm = 'respiration' WHERE id = ?",
    ).run(id)
    expect(hits('photosynthesis')).toBe(0)
    expect(hits('respiration')).toBe(1)
    db.prepare('DELETE FROM book_chunks WHERE id = ?').run(id)
    expect(hits('respiration')).toBe(0)
    db.close()
  })

  it('migrates a copy of a populated v1 file through 0002, keeping the data and a pre-migrate backup', () => {
    const src = join(tmp(), 'data')
    const first = openDatabase({
      dataDir: src,
      migrationsDir: migrationsWith({}, 1),
    })
    first
      .prepare(
        "INSERT INTO boards (id,title,created_at,updated_at) VALUES ('b','Algebra',1,1)",
      )
      .run()
    first.close()

    const copy = join(tmp(), 'data')
    mkdirSync(copy)
    cpSync(join(src, 'whiteboard.db'), join(copy, 'whiteboard.db'))
    const migrationsDir = migrationsWith({
      '0004_note.sql':
        'CREATE TABLE extra (a INTEGER); ALTER TABLE boards ADD COLUMN note TEXT;',
    })
    const db = openDatabase({ dataDir: copy, migrationsDir })
    expect(version(db)).toBe(4)
    expect(tables(db)).toContain('extra')
    expect(
      (db.pragma('table_info(board_ops)') as { name: string }[]).map(
        (c) => c.name,
      ),
    ).toContain('inverse')
    expect(db.prepare("SELECT title FROM boards WHERE id = 'b'").get()).toEqual(
      {
        title: 'Algebra',
      },
    )
    db.close()

    const backup = new Database(join(copy, 'backups', 'pre-migrate-1.db'), {
      readonly: true,
    })
    expect(version(backup)).toBe(1)
    expect(tables(backup)).not.toContain('extra')
    expect(backup.prepare('SELECT count(*) AS n FROM boards').get()).toEqual({
      n: 1,
    })
    backup.close()
  })

  it('rolls a failing migration back completely', () => {
    const dataDir = join(tmp(), 'data')
    openDatabase({ dataDir }).close()
    const migrationsDir = migrationsWith({
      '0004_bad.sql':
        'CREATE TABLE ok (a INTEGER); INSERT INTO nope VALUES (1);',
    })
    expect(() => openDatabase({ dataDir, migrationsDir })).toThrow()
    const raw = new Database(join(dataDir, 'whiteboard.db'))
    expect(version(raw)).toBe(3)
    expect(tables(raw)).not.toContain('ok')
    raw.close()
  })

  it('refuses a database newer than the newest known migration, naming both numbers', () => {
    const dataDir = join(tmp(), 'data')
    mkdirSync(dataDir)
    const raw = new Database(join(dataDir, 'whiteboard.db'))
    raw.pragma('user_version = 5')
    raw.close()
    expect(() => openDatabase({ dataDir })).toThrow(/5.*3|3.*5/)
  })

  it('cascades a board delete to its ops and snapshots with no dangling rows', () => {
    const db = openDatabase({ dataDir: join(tmp(), 'data') })
    db.prepare(
      "INSERT INTO boards (id,title,created_at,updated_at) VALUES ('b','T',1,1)",
    ).run()
    db.prepare(
      "INSERT INTO board_ops VALUES ('b',1,'x','human','owner',NULL,'add',NULL,'[]','[]',1,NULL)",
    ).run()
    db.prepare("INSERT INTO board_snapshots VALUES ('b',1,x'00')").run()
    db.prepare("DELETE FROM boards WHERE id = 'b'").run()
    expect(db.prepare('SELECT count(*) AS n FROM board_ops').get()).toEqual({
      n: 0,
    })
    expect(
      db.prepare('SELECT count(*) AS n FROM board_snapshots').get(),
    ).toEqual({ n: 0 })
    expect(db.pragma('foreign_key_check')).toEqual([])
    db.close()
  })
})
