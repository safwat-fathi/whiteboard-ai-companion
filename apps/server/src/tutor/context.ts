import {
  type BlobStore,
  buildDigest,
  buildSelectionDetail,
  type ChatRequest,
  type ContextDescriptor,
} from '@whiteboard/core'
import type { BoardService } from '../board-service'
import { ApiError } from '../errors'
import { defang, estimateTokens } from './scope'

const IMAGE_TOKENS = 1500 // what a picture costs the prompt, roughly
const WHOLE_BOARD = { maxRows: 400, maxTokens: 6000 }

export type ContextPicture = {
  blobId: string
  of: 'selection' | 'viewport' | 'board' | 'attachment'
  bytes: Uint8Array
  mediaType: string
}
export type TurnContext = {
  /** The text block that goes before the student's message: the board digest and, if attached, the selection detail. */
  text: string
  pictures: ContextPicture[]
  /** An estimate of what this adds to the prompt. */
  tokens: number
  /** What is saved on the user message, so a past turn can be inspected. */
  stored: {
    descriptor: ContextDescriptor
    digest: string
    selectionDetail?: string
    pictures: { blobId: string; of: string }[]
  }
}

const allows = {
  selection: (m: string) => m === 'picture' || m === 'both',
  viewport: (m: string) => m === 'picture',
  board: (m: string) => m === 'picture' || m === 'both',
}

/**
 * Everything the student chose to send besides the question (board-context.md): the digest, the selection's full data,
 * the pictures the browser rendered, pasted images. The same function answers "What the AI sees" and builds the real
 * request, so the preview cannot drift from what is sent. Board text is untrusted: it is fenced in `<board_state>`
 * and cannot close the tag.
 */
export async function buildTurnContext(
  deps: { boards: BoardService; blobs: BlobStore },
  boardId: string,
  req: { context: ContextDescriptor; images?: string[] },
): Promise<TurnContext> {
  const board = deps.boards.getBoard(boardId)
  if (!board) throw new ApiError('not_found', `unknown board ${boardId}`)
  const { headSeq, elements } = deps.boards.scene(boardId)
  const c = req.context
  const selection = c.selection.filter((id) =>
    elements.some((e) => e.id === id),
  )
  const wholeBoard = c.attach.board === 'structure' || c.attach.board === 'both'
  const digest = buildDigest({
    title: board.title,
    seq: headSeq,
    elements,
    ...(c.viewport ? { viewport: c.viewport } : {}),
    selection,
    ...(wholeBoard ? WHOLE_BOARD : {}),
  })
  const detail =
    selection.length > 0 &&
    (c.attach.selection === 'structure' || c.attach.selection === 'both')
      ? buildSelectionDetail(elements, selection)
      : undefined
  const text = [
    `<board_state seq="${headSeq}">`,
    defang(digest),
    ...(detail ? ['SELECTED ELEMENTS (full data):', defang(detail)] : []),
    '</board_state>',
  ].join('\n')

  // pictures the browser rendered, kept only where the chips say "picture"; then pasted images
  const wanted = [
    ...c.pictures
      .filter((p) => allows[p.of](c.attach[p.of]))
      .map((p) => ({ blobId: p.blobId, of: p.of })),
    ...(req.images ?? []).map((blobId) => ({
      blobId,
      of: 'attachment' as const,
    })),
  ]
  const pictures: ContextPicture[] = []
  for (const w of wanted) {
    const blob = await deps.blobs.get(w.blobId)
    if (!blob)
      throw new ApiError(
        'validation_failed',
        `picture ${w.blobId} was not uploaded`,
        {
          field: 'context.pictures',
        },
      )
    pictures.push({ ...w, bytes: blob.bytes, mediaType: blob.mime })
  }
  return {
    text,
    pictures,
    tokens: estimateTokens(text) + pictures.length * IMAGE_TOKENS,
    stored: {
      descriptor: c,
      digest,
      ...(detail ? { selectionDetail: detail } : {}),
      pictures: pictures.map((p) => ({ blobId: p.blobId, of: p.of })),
    },
  }
}

export type { ChatRequest }
