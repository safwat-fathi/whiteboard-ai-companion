import type { Usage } from '@whiteboard/core'
import type Database from 'better-sqlite3'

export type NewMessage = {
  id: string
  boardId: string
  turnId: string
  role: 'user' | 'assistant'
  /** AI SDK UI message parts (text, data-batch, data-source, data-usage). */
  parts: unknown[]
  /** User messages: what the student attached (descriptor, picture blob ids, digest text). */
  context?: unknown
  model?: string
  usage?: Usage
  createdAt: number
}
export type MessageRow = NewMessage

type Raw = {
  id: string
  board_id: string
  turn_id: string
  role: 'user' | 'assistant'
  parts: string
  context: string | null
  model: string | null
  usage: string | null
  created_at: number
}

const toRow = (r: Raw): MessageRow => ({
  id: r.id,
  boardId: r.board_id,
  turnId: r.turn_id,
  role: r.role,
  parts: JSON.parse(r.parts) as unknown[],
  ...(r.context === null ? {} : { context: JSON.parse(r.context) as unknown }),
  ...(r.model === null ? {} : { model: r.model }),
  ...(r.usage === null ? {} : { usage: JSON.parse(r.usage) as Usage }),
  createdAt: r.created_at,
})

export type MessagesDb = ReturnType<typeof createMessagesDb>

/** Chat history. Order is insertion order (rowid), because a user and its reply can share a millisecond. */
export function createMessagesDb(db: Database.Database) {
  const insert = db.prepare(
    `INSERT INTO messages (id, board_id, turn_id, role, parts, context, model, usage, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const window = db.prepare(
    'SELECT * FROM messages WHERE board_id = ? AND rowid < ? AND rowid > ? ORDER BY rowid DESC LIMIT ?',
  )
  const cursor = db.prepare(
    'SELECT rowid AS r FROM messages WHERE id = ? AND board_id = ?',
  )
  const ofTurn = db.prepare(
    'SELECT * FROM messages WHERE board_id = ? AND turn_id = ? ORDER BY rowid',
  )

  return {
    append(m: NewMessage): void {
      insert.run(
        m.id,
        m.boardId,
        m.turnId,
        m.role,
        JSON.stringify(m.parts),
        m.context === undefined ? null : JSON.stringify(m.context),
        m.model ?? null,
        m.usage ? JSON.stringify(m.usage) : null,
        m.createdAt,
      )
    },
    /** The `limit` messages before `before` (default: the newest), oldest first; `next` is the cursor for the page before this one. */
    page(
      boardId: string,
      o: { before?: string; after?: string; limit?: number },
    ): { messages: MessageRow[]; next?: string } {
      const limit = Math.min(Math.max(o.limit ?? 50, 1), 200)
      let beforeRow = Number.MAX_SAFE_INTEGER
      if (o.before !== undefined) {
        const c = cursor.get(o.before, boardId) as { r: number } | undefined
        if (!c) return { messages: [] }
        beforeRow = c.r
      }
      // `after`: a new chat starts here; messages up to and including it stay in the database but are not shown
      const afterRow =
        o.after === undefined
          ? 0
          : ((cursor.get(o.after, boardId) as { r: number } | undefined)?.r ??
            0)
      const rows = (
        window.all(boardId, beforeRow, afterRow, limit + 1) as Raw[]
      ).map(toRow)
      const more = rows.length > limit
      const page = rows.slice(0, limit).reverse()
      return {
        messages: page,
        ...(more && page[0] ? { next: page[0].id } : {}),
      }
    },
    byTurn: (boardId: string, turnId: string): MessageRow[] =>
      (ofTurn.all(boardId, turnId) as Raw[]).map(toRow),
  }
}
