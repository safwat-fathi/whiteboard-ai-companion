import { gunzipSync, gzipSync } from 'node:zlib'
import type { Batch, Element, Op } from '@whiteboard/core'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { ApiError } from '../errors'

/** The stored shape of an op's bounds (database.md); core's Rect is {minX,minY,maxX,maxY}. */
export type Bounds = { x: number; y: number; w: number; h: number }

export const ScopeSchema = z.union([
  z.object({}).strict(),
  z
    .object({
      kind: z.enum(['topic', 'chapter', 'book']),
      bookId: z.string().optional(),
      sectionIds: z.array(z.number().int()).optional(),
      topic: z.string().optional(),
    })
    .strict(),
])
export type Scope = z.infer<typeof ScopeSchema>

export type BoardRow = {
  id: string
  title: string
  scope: Scope
  headSeq: number
  createdAt: number
  updatedAt: number
}

export type NewOp = {
  batchId: string
  authorKind: 'human' | 'agent'
  authorId: string
  turnId?: string
  label: string
  bounds: Bounds | null
  touchedIds: string[]
  ops: Op[]
  /** Agent batches only: the batch that undoes this one. */
  inverse?: Batch
}
export type OpRow = NewOp & { boardId: string; seq: number; createdAt: number }

type RawBoard = {
  id: string
  title: string
  scope: string
  head_seq: number
  created_at: number
  updated_at: number
}
type RawOp = {
  board_id: string
  seq: number
  batch_id: string
  author_kind: 'human' | 'agent'
  author_id: string
  turn_id: string | null
  label: string
  bounds: string | null
  touched_ids: string
  ops: string
  inverse: string | null
  created_at: number
}

const toBoard = (r: RawBoard): BoardRow => ({
  id: r.id,
  title: r.title,
  scope: JSON.parse(r.scope) as Scope,
  headSeq: r.head_seq,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const toOp = (r: RawOp): OpRow => ({
  boardId: r.board_id,
  seq: r.seq,
  batchId: r.batch_id,
  authorKind: r.author_kind,
  authorId: r.author_id,
  ...(r.turn_id === null ? {} : { turnId: r.turn_id }),
  label: r.label,
  bounds: r.bounds === null ? null : (JSON.parse(r.bounds) as Bounds),
  touchedIds: JSON.parse(r.touched_ids) as string[],
  ops: JSON.parse(r.ops) as Op[],
  ...(r.inverse === null ? {} : { inverse: JSON.parse(r.inverse) as Batch }),
  createdAt: r.created_at,
})

export type BoardsDb = ReturnType<typeof createBoardsDb>

/** Typed queries for boards, the op log and snapshots. Nothing else touches these tables. */
export function createBoardsDb(db: Database.Database) {
  const insertBoard = db.prepare(
    'INSERT INTO boards (id, title, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  )
  const selectBoard = db.prepare('SELECT * FROM boards WHERE id = ?')
  const selectBoards = db.prepare(
    'SELECT * FROM boards ORDER BY updated_at DESC, created_at DESC, id',
  )
  const bumpHead = db.prepare(
    'UPDATE boards SET head_seq = head_seq + 1, updated_at = ? WHERE id = ? RETURNING head_seq',
  )
  const insertOp = db.prepare(
    `INSERT INTO board_ops
       (board_id, seq, batch_id, author_kind, author_id, turn_id, label, bounds, touched_ids, ops, inverse, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectOps = db.prepare(
    'SELECT * FROM board_ops WHERE board_id = ? AND seq > ? ORDER BY seq LIMIT ?',
  )
  const selectTurn = db.prepare(
    'SELECT * FROM board_ops WHERE board_id = ? AND turn_id = ? ORDER BY seq',
  )
  const selectTurns = db.prepare(
    `SELECT turn_id AS turnId, MIN(seq) AS firstSeq FROM board_ops
     WHERE board_id = ? AND turn_id IS NOT NULL
     GROUP BY turn_id HAVING MIN(seq) < ? ORDER BY firstSeq DESC LIMIT ?`,
  )
  const selectBatch = db.prepare(
    'SELECT * FROM board_ops WHERE board_id = ? AND batch_id = ? ORDER BY seq',
  )
  const putSnapshot = db.prepare(
    'INSERT OR REPLACE INTO board_snapshots (board_id, seq, scene) VALUES (?, ?, ?)',
  )
  const selectSnapshot = db.prepare(
    'SELECT seq, scene FROM board_snapshots WHERE board_id = ? ORDER BY seq DESC LIMIT 1',
  )

  const getBoard = (id: string): BoardRow | undefined => {
    const r = selectBoard.get(id) as RawBoard | undefined
    return r && toBoard(r)
  }

  const append = db.transaction(
    (boardId: string, b: NewOp, now: number): number => {
      const head = bumpHead.get(now, boardId) as
        | { head_seq: number }
        | undefined
      if (!head) throw new ApiError('not_found', `unknown board ${boardId}`)
      insertOp.run(
        boardId,
        head.head_seq,
        b.batchId,
        b.authorKind,
        b.authorId,
        b.turnId ?? null,
        b.label,
        b.bounds === null ? null : JSON.stringify(b.bounds),
        JSON.stringify(b.touchedIds),
        JSON.stringify(b.ops),
        b.inverse ? JSON.stringify(b.inverse) : null,
        now,
      )
      return head.head_seq
    },
  )

  return {
    createBoard(
      b: { id: string; title: string; scope?: Scope },
      now: number,
    ): BoardRow {
      const scope = ScopeSchema.parse(b.scope ?? {})
      insertBoard.run(b.id, b.title, JSON.stringify(scope), now, now)
      return getBoard(b.id) as BoardRow
    },
    getBoard,
    listBoards: (): BoardRow[] =>
      (selectBoards.all() as RawBoard[]).map(toBoard),
    updateBoard(
      id: string,
      p: { title?: string; scope?: Scope },
      now: number,
    ): BoardRow | undefined {
      const cur = getBoard(id)
      if (!cur) return undefined
      const title = p.title ?? cur.title
      const scope =
        p.scope === undefined ? cur.scope : ScopeSchema.parse(p.scope)
      db.prepare(
        'UPDATE boards SET title = ?, scope = ?, updated_at = ? WHERE id = ?',
      ).run(title, JSON.stringify(scope), now, id)
      return getBoard(id)
    },
    deleteBoard: (id: string): boolean =>
      db.prepare('DELETE FROM boards WHERE id = ?').run(id).changes > 0,

    /** One transaction: bump head_seq, insert the op row. Returns the new seq. */
    appendBatch: (boardId: string, b: NewOp, now: number): number =>
      append(boardId, b, now),
    /** Every batch of one tutor turn, oldest first. */
    opsByTurn: (boardId: string, turnId: string): OpRow[] =>
      (selectTurn.all(boardId, turnId) as RawOp[]).map(toOp),
    /** Turns that changed the board, newest first: those whose first batch is before `beforeSeq`. */
    turnsBefore: (
      boardId: string,
      beforeSeq: number,
      limit: number,
    ): { turnId: string; firstSeq: number }[] =>
      selectTurns.all(boardId, beforeSeq, limit) as {
        turnId: string
        firstSeq: number
      }[],
    opsByBatch: (boardId: string, batchId: string): OpRow[] =>
      (selectBatch.all(boardId, batchId) as RawOp[]).map(toOp),
    opsAfter: (boardId: string, seq: number, limit = -1): OpRow[] =>
      (selectOps.all(boardId, seq, limit) as RawOp[]).map(toOp),

    saveSnapshot(boardId: string, seq: number, scene: Element[]): void {
      putSnapshot.run(boardId, seq, gzipSync(JSON.stringify(scene)))
    },
    latestSnapshot(
      boardId: string,
    ): { seq: number; scene: Element[] } | undefined {
      const r = selectSnapshot.get(boardId) as
        | { seq: number; scene: Buffer }
        | undefined
      return (
        r && {
          seq: r.seq,
          scene: JSON.parse(gunzipSync(r.scene).toString('utf8')) as Element[],
        }
      )
    },
  }
}
