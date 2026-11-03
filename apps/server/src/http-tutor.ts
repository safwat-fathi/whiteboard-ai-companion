import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  ChatRequestSchema,
  ContextDescriptorSchema,
  SettingsSchema,
} from '@whiteboard/core'
import { pipeUIMessageStreamToResponse } from 'ai'
import { z } from 'zod'
import type { BoardService } from './board-service'
import type { Config } from './config'
import type { MessagesDb, SettingsDb, UsageDb } from './db'
import { apiError } from './errors'
import { parse, readJson, send } from './http-util'
import { createActivity } from './tutor/activity'
import {
  dailyCap,
  loadSettings,
  saveSettings,
  usageSummary,
} from './tutor/settings'
import type { Tutor } from './tutor/turn'
import type { TutorUndo } from './tutor/undo'

const PreviewRequest = z.object({
  context: ContextDescriptorSchema.default(ContextDescriptorSchema.parse({})),
  images: z.array(z.string()).max(4).optional(),
})

export type TutorRoutesDeps = {
  tutor: Tutor
  boards: BoardService
  messages: MessagesDb
  settings: SettingsDb
  usage: UsageDb
  config: Config
  undo: TutorUndo
  /** TUTOR_STUB: also serve the recorded model requests to the specs. */
  stub: boolean
}

const decode = (raw: string): string => {
  try {
    return decodeURIComponent(raw)
  } catch {
    throw apiError('not_found', 'no such board')
  }
}

/** Chat, history, models. Returns true when it answered; the caller has already checked Host and Origin. */
export function createTutorRoutes(d: TutorRoutesDeps) {
  const activity = createActivity({
    boards: d.boards,
    messages: d.messages,
    activeTurn: d.tutor.activeTurn,
  })
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    seg: string[],
    method: string,
  ): Promise<boolean> => {
    if (seg[1] === 'chat' && seg.length === 2 && method === 'POST') {
      const body = parse(ChatRequestSchema, await readJson(req))
      const ac = new AbortController()
      // Stop = the browser closes the fetch; that aborts the model call and releases the board's turn lock.
      res.on('close', () => {
        if (!res.writableEnded) ac.abort()
      })
      const { stream } = await d.tutor.start(body, ac.signal) // throws a plain error before any header is written
      await pipeUIMessageStreamToResponse({ response: res, stream })
      return true
    }
    if (seg[1] === 'settings' && seg.length === 2) {
      if (method === 'GET') {
        send(res, 200, loadSettings(d.settings))
        return true
      }
      if (method === 'PUT') {
        const next = parse(SettingsSchema, await readJson(req))
        saveSettings(d.settings, next)
        send(res, 200, loadSettings(d.settings))
        return true
      }
    }
    if (seg[1] === 'usage' && seg.length === 2 && method === 'GET') {
      const q = new URL(req.url ?? '/', 'http://localhost').searchParams
      const num = (k: string, dflt: number) => {
        const v = q.get(k)
        if (v === null) return dflt
        const n = Number(v)
        if (v.trim() === '' || !Number.isFinite(n))
          throw apiError(
            'validation_failed',
            `${k} must be a number (epoch milliseconds)`,
            { field: k },
          )
        return n
      }
      const now = Date.now()
      const dayStart = now - (now % 86_400_000)
      send(
        res,
        200,
        usageSummary(d.usage, {
          from: num('from', dayStart - 13 * 86_400_000),
          to: num('to', dayStart + 86_400_000),
          now,
          cap: dailyCap(d.settings, d.config),
        }),
      )
      return true
    }
    if (seg[1] === 'models' && seg.length === 2 && method === 'GET') {
      send(res, 200, d.tutor.models())
      return true
    }
    if (
      seg[1] === 'boards' &&
      seg[3] === 'messages' &&
      seg.length === 4 &&
      method === 'GET'
    ) {
      const id = decode(seg[2] as string)
      if (!d.boards.getBoard(id))
        throw apiError('not_found', `unknown board ${id}`)
      const q = new URL(req.url ?? '/', 'http://localhost').searchParams
      const limit = q.has('limit') ? Number(q.get('limit')) : undefined
      if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1))
        throw apiError(
          'validation_failed',
          'limit must be a positive integer',
          { field: 'limit' },
        )
      const page = d.messages.page(id, {
        after: d.tutor.chatStart(id),
        before: q.get('before') ?? undefined,
        limit,
      })
      send(res, 200, {
        messages: page.messages.map(d.tutor.toDto),
        ...(page.next ? { next: page.next } : {}),
      })
      return true
    }
    if (
      seg[1] === 'boards' &&
      seg[3] === 'chat' &&
      seg[4] === 'reset' &&
      seg.length === 5 &&
      method === 'POST'
    ) {
      const id = decode(seg[2] as string)
      if (!d.boards.getBoard(id))
        throw apiError('not_found', `unknown board ${id}`)
      d.tutor.newChat(id)
      send(res, 200, { ok: true })
      return true
    }
    if (
      seg[1] === 'boards' &&
      seg[3] === 'activity' &&
      seg.length === 4 &&
      method === 'GET'
    ) {
      const id = decode(seg[2] as string)
      if (!d.boards.getBoard(id))
        throw apiError('not_found', `unknown board ${id}`)
      const q = new URL(req.url ?? '/', 'http://localhost').searchParams
      const limit = q.has('limit') ? Number(q.get('limit')) : undefined
      if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1))
        throw apiError(
          'validation_failed',
          'limit must be a positive integer',
          { field: 'limit' },
        )
      send(
        res,
        200,
        activity.list(id, {
          before: q.get('before') ?? undefined,
          limit,
          turn: q.get('turn') ?? undefined,
          batch: q.get('batch') ?? undefined,
        }),
      )
      return true
    }
    if (
      seg[1] === 'boards' &&
      seg[3] === 'context-preview' &&
      seg.length === 4 &&
      method === 'POST'
    ) {
      const id = decode(seg[2] as string)
      const body = parse(PreviewRequest, await readJson(req))
      const ctx = await d.tutor.previewContext(id, body.context, body.images)
      send(res, 200, {
        text: ctx.text,
        pictures: ctx.pictures.map((p) => ({ blobId: p.blobId, of: p.of })),
        tokens: ctx.tokens,
      })
      return true
    }
    if (
      seg[1] === 'boards' &&
      (seg[3] === 'turns' || seg[3] === 'batches') &&
      seg[5] === 'undo' &&
      seg.length === 6 &&
      method === 'POST'
    ) {
      const id = decode(seg[2] as string)
      if (!d.boards.getBoard(id))
        throw apiError('not_found', `unknown board ${id}`)
      // undoing while the turn still draws would fight it: wait for it to finish (or press Stop)
      if (d.tutor.isBusy(id))
        throw apiError('turn_busy', 'The AI is still working on this board.')
      const target = decode(seg[4] as string)
      send(
        res,
        200,
        seg[3] === 'turns' ? d.undo.turn(id, target) : d.undo.batch(id, target),
      )
      return true
    }
    if (
      d.stub &&
      seg[1] === '_test' &&
      seg[2] === 'last-request' &&
      method === 'GET'
    ) {
      const id =
        new URL(req.url ?? '/', 'http://localhost').searchParams.get(
          'boardId',
        ) ?? ''
      send(res, 200, { calls: d.tutor.lastRequest(id) ?? [] })
      return true
    }
    return false
  }
}
