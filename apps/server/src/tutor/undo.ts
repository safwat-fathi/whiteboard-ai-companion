import {
  type Batch,
  newId,
  UndoManager,
  type UndoResult,
} from '@whiteboard/core'
import type { BoardService } from '../board-service'
import type { OpRow, SettingsDb } from '../db'
import { ApiError } from '../errors'

const OWNER = { kind: 'human' as const, id: 'owner' }

/**
 * "Undo this response" (R3): the stored inverse of each tutor batch, newest first, through core's UndoManager, whose
 * conflict rule drops any inverse step whose target the student changed since. What is applied goes in as new batches by
 * the student (so every open tab sees it), with each added element keeping its original author. A batch that was already
 * undone is remembered and not undone twice.
 */
export function createUndo(deps: {
  boards: BoardService
  settings: SettingsDb
}) {
  const { boards, settings } = deps
  const mark = (boardId: string, batchId: string) =>
    `undone:${boardId}:${batchId}`

  function undoRows(boardId: string, rows: OpRow[]): UndoResult {
    let undone = 0
    let skipped = 0
    for (const row of [...rows].reverse()) {
      if (settings.get(mark(boardId, row.batchId))) continue
      if (!row.inverse) {
        skipped++ // a human batch or one from before inverses were stored: nothing to undo it with
        continue
      }
      const original: Batch = {
        batchId: row.batchId,
        label: row.label,
        ops: row.ops,
      }
      const scene = {
        els: new Map(boards.scene(boardId).elements.map((e) => [e.id, e])),
      }
      const step = UndoManager.fromJSON(scene, {
        undo: [{ original, inverse: row.inverse }],
        redo: [],
        maxDepth: 1,
      }).undo()
      skipped += step?.skipped ?? 0
      if (step && step.batch.ops.length > 0) {
        boards.submit(
          boardId,
          { ...step.batch, batchId: newId(), label: `Undo: ${row.label}` },
          OWNER,
          undefined,
          { preserveAuthor: true },
        )
        undone++
      }
      settings.set(mark(boardId, row.batchId), '1')
    }
    return { undone, skipped }
  }

  return {
    turn(boardId: string, turnId: string): UndoResult {
      const rows = boards.opsOfTurn(boardId, turnId)
      if (rows.length === 0)
        throw new ApiError('not_found', `no changes by turn ${turnId}`)
      return undoRows(boardId, rows)
    },
    batch(boardId: string, batchId: string): UndoResult {
      const rows = boards
        .opsOfBatch(boardId, batchId)
        .filter((r) => r.authorKind === 'agent')
      if (rows.length === 0)
        throw new ApiError('not_found', `no tutor batch ${batchId}`)
      return undoRows(boardId, rows)
    },
  }
}
export type TutorUndo = ReturnType<typeof createUndo>
