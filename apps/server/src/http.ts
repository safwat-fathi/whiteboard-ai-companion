import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { BlobStore } from '@whiteboard/core'
import { z } from 'zod'
import type { BoardService } from './board-service'
import type { Config } from './config'
import { ScopeSchema } from './db'
import { ApiError, apiError } from './errors'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
export const MAX_JSON_BYTES = 1024 * 1024 // 1 MB
const DRAIN_CAP = 16 * 1024 * 1024 // stop reading a refused upload after this much

/**
 * Plan R3: GET, HEAD and OPTIONS need no Origin; every other method must carry exactly `publicOrigin`. A missing, `null`,
 * trailing-slash or other-port Origin is refused (browsers always send Origin on these requests).
 */
export function checkOrigin(
  req: { method?: string; headers: IncomingHttpHeaders },
  publicOrigin: string,
): boolean {
  if (SAFE_METHODS.has(req.method ?? 'GET')) return true
  return req.headers.origin === publicOrigin
}

const HOST_SHAPE = /^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::\d{1,5})?$/i
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const WILDCARD = new Set(['0.0.0.0', '::', '[::]'])

/**
 * Defence against DNS rebinding: a page on an attacker's hostname that resolves to 127.0.0.1 makes same-origin requests
 * (no Origin header on a GET), so the Host must be one of ours: a loopback name, the public origin's host, or the
 * specific address the server binds to. The shape is checked before parsing because `evil.test@localhost` parses as the
 * hostname `localhost`. Ports are not compared: only the name can be forged by DNS.
 */
export function checkHost(
  host: string | undefined,
  o: { publicOrigin: string; host: string },
): boolean {
  if (!host || !HOST_SHAPE.test(host)) return false
  let name: string
  try {
    name = new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return false
  }
  if (LOOPBACK.has(name)) return true
  if (name === new URL(o.publicOrigin).hostname.toLowerCase()) return true
  const bind = o.host.toLowerCase()
  return !WILDCARD.has(bind) && name === bind
}

export type HttpDeps = {
  config: Config
  boards: BoardService
  blobs: BlobStore
  schemaVersion: () => number
}

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

function drain(req: IncomingMessage) {
  let n = 0
  req.on('data', (c: Buffer) => {
    n += c.length
    if (n > DRAIN_CAP) req.destroy()
  })
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? ''))
    throw apiError('validation_failed', 'Content-Type must be application/json')
  const raw = await readBody(req, MAX_JSON_BYTES)
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw apiError('validation_failed', 'the body is not valid JSON')
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
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

const Title = z.string().min(1).max(200)
const CreateBoard = z.object({ title: Title, scope: ScopeSchema.optional() })
const PatchBoard = z
  .object({ title: Title.optional(), scope: ScopeSchema.optional() })
  .refine(
    (b) => b.title !== undefined || b.scope !== undefined,
    'must set title or scope',
  )

function send(
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

function sendError(res: ServerResponse, err: unknown) {
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

/** The HTTP layer: Origin gate, CORS, JSON errors in the api.md envelope, health and the board REST routes. */
export function createHttpServer(deps: HttpDeps): http.Server {
  const { config, boards } = deps

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!checkHost(req.headers.host, config))
      throw apiError('forbidden_origin', 'this Host is not allowed')
    const origin = req.headers.origin
    if (origin === config.publicOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    if (req.method === 'OPTIONS') {
      const cors: Record<string, string> =
        origin === config.publicOrigin
          ? {
              'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE',
              'Access-Control-Allow-Headers': 'content-type',
              'Access-Control-Max-Age': '600',
            }
          : {}
      return send(res, 204, undefined, cors)
    }
    if (!checkOrigin(req, config.publicOrigin))
      throw apiError(
        'forbidden_origin',
        'this Origin may not make this request',
      )

    const seg = new URL(req.url ?? '/', 'http://localhost').pathname
      .split('/')
      .filter(Boolean)
    const method = req.method ?? 'GET'
    const notFound = () => apiError('not_found', 'no such route')
    if (seg[0] !== 'api') throw notFound()

    if (seg.length === 2 && seg[1] === 'health' && method === 'GET')
      return send(res, 200, {
        ok: true,
        migrations: deps.schemaVersion(),
        keys: config.keys,
      })

    if (seg[1] === 'boards') {
      if (seg.length === 2 && method === 'GET')
        return send(res, 200, { boards: boards.listBoards() })
      if (seg.length === 2 && method === 'POST') {
        const b = parse(CreateBoard, await readJson(req))
        return send(res, 201, boards.createBoard(b.title, b.scope))
      }
      if (seg.length === 3) {
        let id: string
        try {
          id = decodeURIComponent(seg[2] as string)
        } catch {
          throw apiError('not_found', 'no such board')
        }
        const missing = () => apiError('not_found', `unknown board ${id}`)
        if (method === 'GET') {
          const b = boards.getBoard(id)
          if (!b) throw missing()
          return send(res, 200, b)
        }
        if (method === 'PATCH') {
          const patch = parse(PatchBoard, await readJson(req))
          const b = boards.updateBoard(id, patch)
          if (!b) throw missing()
          return send(res, 200, b)
        }
        if (method === 'DELETE') {
          if (!boards.deleteBoard(id)) throw missing()
          return send(res, 204)
        }
      }
    }
    throw notFound()
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => sendError(res, err))
  })
}
