import type { ActivityTurn } from '@whiteboard/core'
import type { BoardService } from '../board-service'
import type { MessagesDb } from '../db'

type Batch = ActivityTurn['batches'][number]

/** The Activity tab's data (jump-to-ai.md): the turns that changed the board and the batches of each, from the stored log. */
export function createActivity(deps: {
  boards: BoardService
  messages: MessagesDb
  activeTurn: (boardId: string) => string | undefined
}) {
  const { boards, messages } = deps

  function turn(boardId: string, turnId: string): ActivityTurn | undefined {
    const rows = boards.opsOfTurn(boardId, turnId)
    if (rows.length === 0) return undefined
    const batches: Batch[] = rows.map((r) => {
      const ids = [
        ...new Set(r.ops.map((o) => (o.op === 'add' ? o.el.id : o.id))),
      ]
      return {
        batchId: r.batchId,
        seq: r.seq,
        label: r.label,
        bounds: r.bounds,
        count: ids.length,
        touchedIds: ids.slice(0, 200),
      }
    })
    const boxes = batches.flatMap((b) => (b.bounds ? [b.bounds] : []))
    const x0 = Math.min(...boxes.map((b) => b.x))
    const y0 = Math.min(...boxes.map((b) => b.y))
    const x1 = Math.max(...boxes.map((b) => b.x + b.w))
    const y1 = Math.max(...boxes.map((b) => b.y + b.h))
    const msgs = messages.byTurn(boardId, turnId)
    const asked = msgs.find((m) => m.role === 'user')
    const answered = msgs.find((m) => m.role === 'assistant')
    const state = answered?.parts
      .flatMap((p) =>
        (p as { type?: string }).type === 'data-status'
          ? [(p as { data: { state: string } }).data.state]
          : [],
      )
      .at(-1)
    return {
      turnId,
      startedAt: rows[0]?.createdAt ?? 0,
      userText: (
        (asked?.parts[0] as { text?: string } | undefined)?.text ?? ''
      ).slice(0, 80),
      status:
        deps.activeTurn(boardId) === turnId
          ? 'running'
          : state === 'done'
            ? 'done'
            : 'stopped',
      bounds: boxes.length ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null,
      batches,
    }
  }

  return {
    /** One turn, the turn that holds a batch, or a page of turns newest first (`before` = the turn the previous page ended at). */
    list(
      boardId: string,
      q: { before?: string; limit?: number; turn?: string; batch?: string },
    ): { turns: ActivityTurn[]; next?: string } {
      const only =
        q.turn ??
        (q.batch ? boards.opsOfBatch(boardId, q.batch)[0]?.turnId : undefined)
      if (q.turn || q.batch) {
        const t = only ? turn(boardId, only) : undefined
        return { turns: t ? [t] : [] }
      }
      const limit = Math.min(Math.max(q.limit ?? 20, 1), 100)
      const beforeSeq = q.before
        ? (boards.opsOfTurn(boardId, q.before)[0]?.seq ??
          Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER
      const found = boards.turnsBefore(boardId, beforeSeq, limit + 1)
      const page = found.slice(0, limit)
      const turns = page.flatMap((t) => turn(boardId, t.turnId) ?? [])
      const last = page.at(-1)
      return {
        turns,
        ...(found.length > limit && last ? { next: last.turnId } : {}),
      }
    },
  }
}
