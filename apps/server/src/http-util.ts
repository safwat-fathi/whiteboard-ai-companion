import type { IncomingMessage, ServerResponse } from 'node:http'
import type { z } from 'zod'
import { ApiError, apiError } from './errors'

export const MAX_JSON_BYTES = 1024 * 1024 // 1 MB
const DRAIN_CAP = 16 * 1024 * 1024 // stop reading a refused upload after this much

/**
 * Reads a request body of at most `limit` bytes. Over the limit the promise rejects at once (so the caller can answer
 * 413 immediately) while the rest of the upload is read and discarded, up to a cap: destroying the socket under a
 * client that is still writing would reset the connection and the client would never see the 413.
 */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tooLarge = () =>
      apiError('payload_too_large', `the body may be at most ${limit} bytes`, {
        limit,
      })
    if (Number(req.headers['content-length']) > limit) {
      req.on('data', () => {})
      drain(req)
      return reject(tooLarge())
    }
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (over) return
      if (size > limit) {
        over = true
        chunks.length = 0
        reject(tooLarge())
        return
      }
      chunks.push(c)
    })
    drain(req)
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks))
    })
    req.on('error', (e) => reject(e))
  })
}

export function drain(req: IncomingMessage) {
  let n = 0
  req.on('data', (c: Buffer) => {
    n += c.length
    if (n > DRAIN_CAP) req.destroy()
  })
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? ''))
    throw apiError('validation_failed', 'Content-Type must be application/json')
  const raw = await readBody(req, MAX_JSON_BYTES)
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw apiError('validation_failed', 'the body is not valid JSON')
  }
}

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value)
  if (r.success) return r.data
  const issue = r.error.issues[0]
  const field = (issue?.path ?? []).join('.') || 'body'
  throw apiError(
    'validation_failed',
    `${field} ${issue?.message ?? 'is invalid'}`,
    { field },
  )
}

export function send(
  res: ServerResponse,
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  res.writeHead(status, {
    ...(payload === undefined
      ? {}
      : { 'Content-Type': 'application/json; charset=utf-8' }),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  res.end(payload)
}

export function sendError(res: ServerResponse, err: unknown) {
  if (res.headersSent) return void res.destroy()
  if (err instanceof ApiError)
    return send(
      res,
      err.status,
      err.toJSON(),
      err.code === 'payload_too_large' ? { Connection: 'close' } : {},
    )
  console.error(
    'unhandled error:',
    err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  )
  send(res, 500, new ApiError('internal_error', 'internal error').toJSON())
}
