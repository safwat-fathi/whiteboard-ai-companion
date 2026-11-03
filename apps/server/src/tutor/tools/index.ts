import type { ToolSet } from 'ai'
import type { TurnCtx } from '../turn'
import { type BoardToolDeps, boardToolSet } from './board-tools'
import { type BookToolDeps, bookToolSet } from './book-tools'
import { type FigureDeps, figureTool } from './figure'

/** Every tool the tutor has in a turn: the board, the book, and the snapshot hook. */
export function tutorToolSet(
  deps: { board: BoardToolDeps; book: BookToolDeps; figure: FigureDeps },
  ctx: TurnCtx,
) {
  const board = boardToolSet(deps.board, ctx, [
    figureTool(deps.figure, () => {
      const scope = deps.book.boards.getBoard(ctx.boardId)?.scope
      return scope && 'kind' in scope ? scope.bookId : undefined
    }),
  ])
  const tools: ToolSet = { ...board.tools, ...bookToolSet(deps.book, ctx) }
  return { tools, prepareStep: board.prepareStep }
}
