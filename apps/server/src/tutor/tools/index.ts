import type { ToolSet } from 'ai'
import type { TurnCtx } from '../turn'
import { type BoardToolDeps, boardToolSet } from './board-tools'
import { type BookToolDeps, bookToolSet } from './book-tools'

/** Every tool the tutor has in a turn: the board, the book, and the snapshot hook. */
export function tutorToolSet(
  deps: { board: BoardToolDeps; book: BookToolDeps },
  ctx: TurnCtx,
) {
  const board = boardToolSet(deps.board, ctx)
  const tools: ToolSet = { ...board.tools, ...bookToolSet(deps.book, ctx) }
  return { tools, prepareStep: board.prepareStep }
}
