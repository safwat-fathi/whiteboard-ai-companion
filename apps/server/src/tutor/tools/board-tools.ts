import {
  type Batch,
  type BlobStore,
  coreTools,
  type Platform,
  type ToolCtx,
  type ToolDef,
  ToolError,
  type WireBounds,
} from '@whiteboard/core'
import {
  type PrepareStepFunction,
  type ToolSet,
  tool,
  type UIMessageChunk,
} from 'ai'
import { z } from 'zod'
import type { BoardService } from '../../board-service'
import { ApiError } from '../../errors'
import { defaultRect, renderBoardPng } from '../../export'
import type { TurnCtx } from '../turn'

export type BoardToolDeps = {
  boards: BoardService
  blobs: BlobStore
  platform: () => Promise<Platform>
}

const SNAPSHOT_LONG_SIDE = 1600
const PAD = 24

/** A picture of `rect` whose long side is at most 1600 px and which is never blown up more than 2x. */
async function snapshot(
  deps: BoardToolDeps,
  boardId: string,
  rect: WireBounds,
) {
  const scale = Math.min(2, SNAPSHOT_LONG_SIDE / Math.max(rect.w, rect.h))
  const width = Math.max(16, Math.round(rect.w * scale))
  return renderBoardPng(deps.boards.scene(boardId).elements, rect, width, {
    blobs: deps.blobs,
  })
}

const touchedIds = (b: Batch) => [
  ...new Set(b.ops.map((o) => (o.op === 'add' ? o.el.id : o.id))),
]

/** What the model sees when a tool fails: its own mistake, in words. Anything else is ours and stays in the log. */
function forModel(e: unknown): Error {
  if (e instanceof ToolError) return new Error(e.message)
  if (e instanceof ApiError && e.code === 'validation_failed')
    return new Error(e.message)
  console.error('tool failed:', e instanceof Error ? e.name : typeof e)
  return new Error('That tool failed. Try something simpler.')
}

const WRITES = new Set([
  'add_text',
  'add_math',
  'add_shape',
  'connect',
  'add_diagram',
  'add_chart',
  'update_elements',
  'delete_elements',
])

/**
 * The board tools of one turn as AI SDK tools. Each write is one labelled batch through the Board service, authored by
 * `tutor:<turnId>`; the student's selection when the turn began is the edit grant. A snapshot goes to the model as a
 * follow-up user message, because the Meta Model API rejects images inside tool results (SNAPSHOT_ADAPTER).
 */
export function boardToolSet(
  deps: BoardToolDeps,
  ctx: TurnCtx,
  /** Board-writing tools that live outside core because they need the server (book figures). */
  extra: ToolDef[] = [],
) {
  const author = { kind: 'agent' as const, id: `tutor:${ctx.turnId}` }
  const { selection, viewport } = ctx.request.context
  const granted = new Set(selection)
  const pending: Uint8Array[] = []
  let added = 0
  // The model may call several tools at once; each one reads the live board and writes a batch, so they take turns.
  let turn: Promise<unknown> = Promise.resolve()
  const inTurn = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = turn.then(fn, fn)
    turn = run.catch(() => {})
    return run
  }
  const status = (state: 'reading' | 'drawing') =>
    ctx.emit({ type: 'data-status', data: { state } } as UIMessageChunk)

  const toolCtx = async (): Promise<ToolCtx> => ({
    scene: {
      els: new Map(
        deps.boards.scene(ctx.boardId).elements.map((e) => [e.id, e]),
      ),
    },
    platform: await deps.platform(),
    turnId: ctx.turnId,
    author,
    grantedIds: granted,
    selection,
    added,
    ...(viewport
      ? {
          viewport: {
            x: viewport.x,
            y: viewport.y,
            w: viewport.w,
            h: viewport.h,
          },
        }
      : {}),
  })

  const adapt = (def: ToolDef) => {
    const writes = WRITES.has(def.name)
    const base = def.input as z.ZodObject
    return tool({
      description: def.description,
      inputSchema: writes
        ? base.extend({
            returnSnapshot: z
              .boolean()
              .optional()
              .describe(
                'Also get a picture of what you just changed, to check your work.',
              ),
          })
        : base,
      execute: (input: Record<string, unknown>) =>
        inTurn(async () => {
          const { returnSnapshot, ...rest } = input
          try {
            status(writes ? 'drawing' : 'reading')
            const out = await def.execute(rest, await toolCtx())
            if (out.kind === 'read') return out.data
            if (out.kind === 'focus') {
              ctx.emit({
                type: 'data-focus',
                data: { bounds: out.bounds, note: out.note },
              } as UIMessageChunk)
              return { ok: true, pointedAt: out.bounds }
            }
            const res = deps.boards.submit(
              ctx.boardId,
              out.batch,
              author,
              ctx.turnId,
              { grantedIds: granted },
            )
            if (res.noop || !res.broadcast)
              return { ok: false, error: 'Nothing changed.' }
            added += out.ids.length
            ctx.emit({
              type: 'data-batch',
              data: {
                batchId: out.batch.batchId,
                seq: res.seq,
                label: out.batch.label,
                bounds: res.broadcast.bounds,
                count: touchedIds(out.batch).length,
                touchedIds: touchedIds(out.batch).slice(0, 200),
              },
            } as UIMessageChunk)
            if (returnSnapshot && out.bounds)
              pending.push(
                await snapshot(deps, ctx.boardId, {
                  x: out.bounds.x - PAD,
                  y: out.bounds.y - PAD,
                  w: out.bounds.w + 2 * PAD,
                  h: out.bounds.h + 2 * PAD,
                }),
              )
            return {
              ok: true,
              batchId: out.batch.batchId,
              seq: res.seq,
              ids: out.ids,
              bounds: out.bounds,
              ...(out.info ?? {}),
              ...(out.warnings?.length ? { warnings: out.warnings } : {}),
              ...(returnSnapshot
                ? { snapshot: 'attached in the next message' }
                : {}),
            }
          } catch (e) {
            throw forModel(e)
          }
        }),
    })
  }

  const snapshotTool = tool({
    description:
      'Get a picture of the board (all of it, or a rectangle) to see how it looks. The picture arrives in the next message.',
    inputSchema: z.object({
      rect: z
        .object({
          x: z.number(),
          y: z.number(),
          w: z.number().min(16),
          h: z.number().min(16),
        })
        .optional(),
    }),
    execute: ({ rect }) =>
      inTurn(async () => {
        try {
          status('reading')
          const els = deps.boards.scene(ctx.boardId).elements
          pending.push(
            await snapshot(deps, ctx.boardId, rect ?? defaultRect(els)),
          )
          return { ok: true, snapshot: 'attached in the next message' }
        } catch (e) {
          throw forModel(e)
        }
      }),
  })

  const tools: ToolSet = {
    ...Object.fromEntries(
      [...coreTools, ...extra].map((d) => [d.name, adapt(d as ToolDef)]),
    ),
    get_snapshot: snapshotTool,
  }
  const prepareStep: PrepareStepFunction<ToolSet> = ({ messages }) =>
    pending.length === 0
      ? undefined
      : {
          messages: [
            ...messages,
            {
              role: 'user' as const,
              content: pending.splice(0).flatMap((png) => [
                {
                  type: 'text' as const,
                  text: 'Here is the picture of the board you asked for:',
                },
                { type: 'image' as const, image: png },
              ]),
            },
          ],
        }
  return { tools, prepareStep }
}
