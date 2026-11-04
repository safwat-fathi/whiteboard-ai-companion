import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import {
  BlobError,
  type BlobStore,
  hashBytes,
  sniffMime,
} from '@whiteboard/core'
import { z } from 'zod'
import { MAX_BLOB_BYTES } from './blobs'
import type { BoardService } from './board-service'
import type { Config } from './config'
import { ScopeSchema } from './db'
import { apiError } from './errors'
import { defaultRect, renderBoardPng } from './export'
import { createLibraryRoutes, type LibraryDeps } from './http-books'
import { createTutorRoutes, type TutorRoutesDeps } from './http-tutor'

import {
  MAX_JSON_BYTES,
  parse,
  readBody,
  readJson,
  send,
  sendError,
} from './http-util'

export { MAX_JSON_BYTES, readBody }

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
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
  /** The book library routes (/api/books, /api/search); without it they are unknown paths. */
  library?: LibraryDeps
  /** The tutor routes (/api/chat, messages, models); without it they are unknown paths. */
  tutor?: TutorRoutesDeps
  /** Export renders allowed at once (default 2). One is up to ~134 MB of pixels and runs on the thread that serves the sockets. */
  maxConcurrentExports?: number
}

/** Image bytes with every header that stops a browser from treating them as anything but an image. */
function sendBlob(
  res: ServerResponse,
  bytes: Uint8Array,
  mime: string,
  head: boolean,
) {
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': String(bytes.length),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
    'Cache-Control': 'public, max-age=31536000, immutable', // the id is the hash of the bytes
  })
  res.end(
    head
      ? undefined
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  )
}

/** A board id from a path segment; a malformed percent-escape is just an unknown board. */
function boardId(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    throw apiError('not_found', 'no such board')
  }
}

const Title = z.string().min(1).max(200)
const CreateBoard = z.object({ title: Title, scope: ScopeSchema.optional() })
const PatchBoard = z
  .object({ title: Title.optional(), scope: ScopeSchema.optional() })
  .refine(
    (b) => b.title !== undefined || b.scope !== undefined,
    'must set title or scope',
  )

/** The HTTP layer: Origin gate, CORS, JSON errors in the api.md envelope, health and the board REST routes. */
export function createHttpServer(deps: HttpDeps): http.Server {
  const { config, boards } = deps
  const library = deps.library && createLibraryRoutes(deps.library)
  const tutor = deps.tutor && createTutorRoutes(deps.tutor)
  const maxExports = deps.maxConcurrentExports ?? 2
  let exporting = 0

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Vary', 'Origin') // the answer depends on Origin, whatever it is
    if (!checkHost(req.headers.host, config))
      throw apiError('forbidden_origin', 'this Host is not allowed')
    const origin = req.headers.origin
    if (origin === config.publicOrigin)
      res.setHeader('Access-Control-Allow-Origin', origin)
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
      if (seg.length === 4 && seg[3] === 'export.png' && method === 'GET') {
        const id = boardId(seg[2] as string)
        const q = new URL(req.url ?? '/', 'http://localhost').searchParams
        const num = (k: string): number | undefined => {
          const v = q.get(k)
          if (v === null) return undefined
          const n = Number(v)
          if (v.trim() === '' || !Number.isFinite(n))
            throw apiError(
              'validation_failed',
              `${k} must be a finite number`,
              { field: k },
            )
          return n
        }
        const [x, y, w, h] = [num('x'), num('y'), num('w'), num('h')]
        const given = [x, y, w, h].filter((v) => v !== undefined).length
        if (given !== 0 && given !== 4)
          throw apiError('validation_failed', 'x, y, w and h go together', {
            field: 'rect',
          })
        const elements = boards.scene(id).elements
        const rect =
          x !== undefined &&
          y !== undefined &&
          w !== undefined &&
          h !== undefined
            ? { x, y, w, h }
            : defaultRect(elements)
        if (exporting >= maxExports)
          throw apiError(
            'overloaded',
            'Too many exports are running; try again in a moment.',
          )
        exporting++
        let png: Buffer
        try {
          png = await renderBoardPng(elements, rect, num('width') ?? 1024, {
            blobs: deps.blobs,
          })
        } finally {
          exporting--
        }
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': String(png.length),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        })
        return void res.end(png)
      }
      if (seg.length === 3) {
        const id = boardId(seg[2] as string)
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
    if (seg[1] === 'blobs') {
      if (seg.length === 2 && method === 'POST') {
        // R4: the raw bytes are the body; the claimed Content-Type is ignored and the real type is sniffed.
        const bytes = await readBody(req, MAX_BLOB_BYTES)
        try {
          const existed = await deps.blobs.has(await hashBytes(bytes))
          const id = await deps.blobs.put(
            bytes,
            req.headers['content-type'] ?? '',
          )
          return send(res, existed ? 200 : 201, {
            id,
            mime: sniffMime(bytes),
            bytes: bytes.length,
          })
        } catch (e) {
          if (e instanceof BlobError && e.code === 'unsupported')
            throw apiError('validation_failed', e.message, { field: 'body' })
          if (e instanceof BlobError && e.code === 'too-large')
            throw apiError('payload_too_large', e.message, {
              limit: MAX_BLOB_BYTES,
            })
          throw e
        }
      }
      if (seg.length === 3 && (method === 'GET' || method === 'HEAD')) {
        let id: string
        try {
          id = decodeURIComponent(seg[2] as string)
        } catch {
          throw apiError('not_found', 'no such blob')
        }
        const blob = await deps.blobs.get(id) // an id that is not a SHA-256 hex is simply absent
        if (!blob) throw apiError('not_found', 'no such blob')
        return sendBlob(res, blob.bytes, blob.mime, method === 'HEAD')
      }
    }
    if (tutor && (await tutor(req, res, seg, method))) return
    if (
      library &&
      (seg[1] === 'books' || seg[1] === 'search') &&
      (await library(req, res, seg, method))
    )
      return
    throw notFound()
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => sendError(res, err))
  })
}
