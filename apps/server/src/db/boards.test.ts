import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Element, Op } from '@whiteboard/core'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createBoardsDb, type NewOp } from './boards'
import { openDatabase } from './index'

const dirs: string[] = []
const dbs: Database.Database[] = []
const open = (dir?: string) => {
  const dataDir = dir ?? join(mkdtempSync(join(tmpdir(), 'wb-boards-')), 'data')
  if (!dir) dirs.push(dataDir)
  const db = openDatabase({ dataDir })
  dbs.push(db)
  return { db, dataDir, boards: createBoardsDb(db) }
}
afterEach(() => {
  for (const d of dbs.splice(0)) if (d.open) d.close()
  for (const d of dirs.splice(0))
    rmSync(join(d, '..'), { recursive: true, force: true })
})

const op = (i: number, patch: Partial<NewOp> = {}): NewOp => ({
  batchId: `batch-${i}`,
  authorKind: 'human',
  authorId: 'owner',
  label: `Edit ${i}`,
  bounds: { x: i, y: 0, w: 10, h: 10 },
  touchedIds: [`e${i}`],
  ops: [{ op: 'remove', id: `e${i}` } satisfies Op],
  ...patch,
})

describe('boards', () => {
  it('creates, reads, lists newest-updated first, updates and deletes', () => {
    const { boards } = open()
    const a = boards.createBoard({ id: 'a', title: 'A' }, 1)
    boards.createBoard(
      { id: 'b', title: 'B', scope: { kind: 'book', bookId: 'k' } },
      2,
    )
    boards.createBoard({ id: 'c', title: 'C' }, 3)
    expect(a).toEqual({
      id: 'a',
      title: 'A',
      scope: {},
      headSeq: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    expect(boards.listBoards().map((b) => b.id)).toEqual(['c', 'b', 'a'])
    const upd = boards.updateBoard('a', { title: 'A2' }, 10)
    expect(upd?.title).toBe('A2')
    expect(upd?.updatedAt).toBe(10)
    expect(boards.listBoards().map((b) => b.id)[0]).toBe('a')
    expect(boards.getBoard('b')?.scope).toEqual({ kind: 'book', bookId: 'k' })
    expect(boards.updateBoard('zzz', { title: 'x' }, 1)).toBeUndefined()
    expect(boards.deleteBoard('a')).toBe(true)
    expect(boards.deleteBoard('a')).toBe(false)
    expect(boards.getBoard('a')).toBeUndefined()
  })

  it('rejects a scope outside the schema', () => {
    const { boards } = open()
    expect(() =>
      boards.createBoard(
        { id: 'x', title: 'X', scope: { kind: 'planet' } as never },
        1,
      ),
    ).toThrow()
    expect(() =>
      boards.createBoard(
        { id: 'y', title: 'Y', scope: { extra: 1 } as never },
        1,
      ),
    ).toThrow()
  })
})

describe('appendBatch and opsAfter', () => {
  it('returns consecutive seqs and keeps head_seq in step', () => {
    const { boards } = open()
    boards.createBoard({ id: 'b', title: 'B' }, 1)
    const seqs = Array.from({ length: 100 }, (_, i) =>
      boards.appendBatch('b', op(i + 1), 5),
    )
    expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => i + 1))
    expect(boards.getBoard('b')?.headSeq).toBe(100)
    expect(boards.getBoard('b')?.updatedAt).toBe(5)
  })

  it('is atomic: a failing insert leaves head_seq unchanged', () => {
    const { boards } = open()
    boards.createBoard({ id: 'b', title: 'B' }, 1)
    boards.appendBatch('b', op(1), 2)
    expect(() =>
      boards.appendBatch('b', op(2, { authorKind: 'robot' as 'human' }), 3),
    ).toThrow()
    expect(boards.getBoard('b')?.headSeq).toBe(1)
    expect(boards.opsAfter('b', 0)).toHaveLength(1)
    expect(boards.appendBatch('b', op(3), 4)).toBe(2) // no gap
  })

  it('throws not_found for an unknown board', () => {
    const { boards } = open()
    expect(() => boards.appendBatch('nope', op(1), 1)).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    )
  })

  it('opsAfter returns the tail in order with the JSON columns parsed', () => {
    const { boards } = open()
    boards.createBoard({ id: 'b', title: 'B' }, 1)
    for (let i = 1; i <= 100; i++)
      boards.appendBatch(
        'b',
        op(
          i,
          i === 60
            ? { turnId: 't1', authorKind: 'agent', authorId: 'tutor:t1' }
            : {},
        ),
        i,
      )
    const tail = boards.opsAfter('b', 50)
    expect(tail.map((o) => o.seq)).toEqual(
      Array.from({ length: 50 }, (_, i) => 51 + i),
    )
    const sixty = tail.find((o) => o.seq === 60)
    expect(sixty).toMatchObject({
      boardId: 'b',
      batchId: 'batch-60',
      authorKind: 'agent',
      authorId: 'tutor:t1',
      turnId: 't1',
      label: 'Edit 60',
      bounds: { x: 60, y: 0, w: 10, h: 10 },
      touchedIds: ['e60'],
      ops: [{ op: 'remove', id: 'e60' }],
      createdAt: 60,
    })
    expect(tail[0]?.turnId).toBeUndefined()
    expect(boards.opsAfter('b', 50, 5)).toHaveLength(5)
    expect(boards.opsAfter('b', 100)).toEqual([])
  })

  it('stores a null bounds', () => {
    const { boards } = open()
    boards.createBoard({ id: 'b', title: 'B' }, 1)
    boards.appendBatch('b', op(1, { bounds: null }), 1)
    expect(boards.opsAfter('b', 0)[0]?.bounds).toBeNull()
  })

  it('a second connection sees rows the first appended (WAL)', () => {
    const w = open()
    const r = open(w.dataDir)
    w.boards.createBoard({ id: 'b', title: 'B' }, 1)
    for (let i = 1; i <= 5; i++) w.boards.appendBatch('b', op(i), i)
    expect(r.boards.opsAfter('b', 0)).toHaveLength(5)
    expect(r.boards.getBoard('b')?.headSeq).toBe(5)
  })
})

describe('snapshots', () => {
  const el = (id: string): Element =>
    ({
      id,
      type: 'shape',
      x: 1,
      y: 2,
      w: 3,
      h: 4,
      rotation: 0,
      z: 'a0',
      style: {
        stroke: '#000',
        fill: null,
        strokeWidth: 2,
        opacity: 1,
        dash: 'solid',
      },
      locked: false,
      author: { kind: 'human', id: 'owner' },
      v: 0,
      data: { kind: 'rect' },
    }) as Element

  it('round-trips a scene and returns the highest seq', () => {
    const { boards } = open()
    boards.createBoard({ id: 'b', title: 'B' }, 1)
    expect(boards.latestSnapshot('b')).toBeUndefined()
    boards.saveSnapshot('b', 10, [el('a')])
    boards.saveSnapshot('b', 500, [el('a'), el('b')])
    boards.saveSnapshot('b', 20, [])
    const s = boards.latestSnapshot('b')
    expect(s?.seq).toBe(500)
    expect(s?.scene).toEqual([el('a'), el('b')])
  })

  it('deleting a board cascades its ops and snapshots', () => {
    const { boards, db } = open()
    boards.createBoard({ id: 'b', title: 'B' }, 1)
    boards.appendBatch('b', op(1), 1)
    boards.saveSnapshot('b', 1, [])
    boards.deleteBoard('b')
    expect(db.prepare('SELECT count(*) AS n FROM board_ops').get()).toEqual({
      n: 0,
    })
    expect(
      db.prepare('SELECT count(*) AS n FROM board_snapshots').get(),
    ).toEqual({ n: 0 })
  })
})
